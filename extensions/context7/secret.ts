/**
 * Secret value resolver for the context7 extension, mirroring pi's own
 * resolve-config-value semantics so a single convention works for both
 * LLM provider keys (models.json / auth.json) and the Context7 API key
 * (pi-astack-settings.json → context7.apiKey).
 *
 * Kept self-contained (a sibling copy of web-search/utils/secret.ts)
 * rather than importing across extensions, so removing or moving the
 * web-search extension can never break context7.
 *
 * Supported forms (same as pi core):
 *   - "!command"        → run as a shell command, use trimmed stdout
 *                         (cached for process lifetime)
 *   - "$VAR" / "${VAR}" → interpolate environment variables; "$$" is a
 *                         literal "$" and "$!" a literal "!"
 *   - anything else     → literal value
 *
 * Returns undefined when a referenced env var is missing or a command
 * produced no output, so callers can fail closed.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const commandCache = new Map<string, string | undefined>();

interface CommandShell {
  command: string;
  argsPrefix: string[];
  stdin?: boolean;
}

let shellCache: CommandShell | null | undefined;

function isLegacyWslBashPath(file: string): boolean {
  const normalized = file.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

function findWindowsBash(): string | undefined {
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const gitBash = firstExisting([
    programFiles ? `${programFiles}\\Git\\bin\\bash.exe` : undefined,
    programFiles ? `${programFiles}\\Git\\usr\\bin\\bash.exe` : undefined,
    programFilesX86 ? `${programFilesX86}\\Git\\bin\\bash.exe` : undefined,
    programFilesX86 ? `${programFilesX86}\\Git\\usr\\bin\\bash.exe` : undefined,
  ]);
  if (gitBash) return gitBash;

  try {
    const out = execFileSync("where", ["bash.exe"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || undefined;
  } catch {
    return undefined;
  }
}

function resolveCommandShell(): CommandShell | undefined {
  if (shellCache !== undefined) return shellCache ?? undefined;
  const bash = process.platform === "win32"
    ? findWindowsBash()
    : firstExisting(["/bin/bash", "/usr/bin/bash"]) ?? "bash";
  if (!bash) {
    shellCache = null;
    return undefined;
  }
  shellCache = isLegacyWslBashPath(bash)
    ? { command: bash, argsPrefix: ["-s"], stdin: true }
    : { command: bash, argsPrefix: ["-c"] };
  return shellCache;
}

function runCommand(command: string): string | undefined {
  if (commandCache.has(command)) return commandCache.get(command);
  let value: string | undefined;
  try {
    const shell = resolveCommandShell();
    if (!shell) return undefined;
    const out = execFileSync(
      shell.command,
      shell.stdin ? shell.argsPrefix : [...shell.argsPrefix, command],
      {
        input: shell.stdin ? command : undefined,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    value = out.trim() || undefined;
  } catch {
    value = undefined;
  }
  commandCache.set(command, value);
  return value;
}

function interpolateEnv(raw: string): string | undefined {
  let result = "";
  let i = 0;
  let missing = false;
  while (i < raw.length) {
    const dollar = raw.indexOf("$", i);
    if (dollar < 0) {
      result += raw.slice(i);
      break;
    }
    result += raw.slice(i, dollar);
    const next = raw[dollar + 1];
    if (next === "$" || next === "!") {
      result += next;
      i = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = raw.indexOf("}", dollar + 2);
      if (end < 0) {
        result += "$";
        i = dollar + 1;
        continue;
      }
      const name = raw.slice(dollar + 2, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        const v = process.env[name];
        if (v === undefined) missing = true;
        else result += v;
      } else {
        result += raw.slice(dollar, end + 1);
      }
      i = end + 1;
      continue;
    }
    const m = raw.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      const v = process.env[m[0]];
      if (v === undefined) missing = true;
      else result += v;
      i = dollar + 1 + m[0].length;
      continue;
    }
    result += "$";
    i = dollar + 1;
  }
  if (missing) return undefined;
  return result || undefined;
}

/** Resolve a configured secret value to its plaintext, or undefined. */
export function resolveSecret(raw: string): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("!")) return runCommand(raw.slice(1));
  return interpolateEnv(raw);
}

/** Clear the command result cache. Exported for tests / hot-reload. */
export function clearSecretCache(): void {
  commandCache.clear();
}
