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
import { execSync } from "node:child_process";

const commandCache = new Map<string, string | undefined>();

function runCommand(command: string): string | undefined {
  if (commandCache.has(command)) return commandCache.get(command);
  let value: string | undefined;
  try {
    const out = execSync(command, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
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
