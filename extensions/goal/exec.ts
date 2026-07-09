/**
 * goal extension — evidence executor (v1 spike, G3).
 *
 * The ONLY impure part of the evidence path: goal_check(cmd:…) really runs
 * the command in a child process so the exit code + output hash are recorded
 * by the OS/process boundary, not asserted by the answering LLM ("verification
 * not by the same AI"). Re-running (vs trusting a past pasted stdout) is the
 * cmd analogue of stat-ing a file: it reads CURRENT truth and naturally
 * catches code drift (works with G6 staleness).
 *
 * Safety (decision G3 ①, 3:1): cwd-scoped, hard timeout, no tty (piped stdio),
 * output capped + hashed. No hard allowlist — the command is one the AI/user
 * wrote into plan.md and could already run via its bash tool; an allowlist is
 * "friendly friction, no security gain". A soft dangerous-command guard is
 * provided and on by default.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceResult } from "./evidence";

export const DEFAULT_CMD_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export interface RunCmdOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** reject obviously destructive commands before running (default true). */
  guardDangerous?: boolean;
  /** override env; defaults to process.env with CI=1, NO_COLOR=1. */
  env?: NodeJS.ProcessEnv;
}

export interface RunCmdOutcome extends EvidenceResult {
  exit: number;
  status: "verified" | "failed";
  /** human-facing one-line reason on failure. */
  reason?: string;
}

// Guard for the `cmd:<shell>` evidence path. Still NOT a hard security boundary
// (the AI has a bash tool anyway), but it now refuses the most common ways a
// shell can overreach: chaining/piping/redirection, command substitution, env
// expansion, network exfil, sensitive dot-dir reads, and obvious destructive
// shapes. The override (`guardDangerous: false`) stays available for rare,
// audited exceptions.
//
// Simple, common evidence commands (e.g. `npm run smoke:*`, `rg pattern file`,
// `node scripts/foo.mjs`, `git rev-parse HEAD`) stay allowed.

const DENY_FIRST_TOKEN = /^(?:sh|bash|dash|zsh|fish|ksh|csh|tcsh|env|curl|wget|nc|netcat|nmap|ssh|scp|rsync|sftp|ftp|telnet)$/i;

const DESTRUCTIVE_RE = [
  /\brm\s+-[a-z]*r[a-z]*f?\b[^\n]*\s(\/|~|\$HOME)(\s|$)/i, // rm -rf / | ~ | $HOME
  /\bmkfs\b/i,
  /\b(dd)\b[^\n]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(shutdown|reboot|halt)\b/i,
];

// Match sensitive dot-dirs/files when they look like path tokens (home,
// absolute, ./, ../, or bare relative such as `.env`). This guard is
// intentionally conservative for goal evidence commands.
const SENSITIVE_PATH_RE = /(?:^|[\s"'=]|\/)(?:~\/|\$HOME\/|\.\/|\.\.\/)?(?:\.ssh|\.abrain|\.gnupg|\.aws|\.kube|\.docker|\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.env(?:\.[A-Za-z0-9_-]+)?)(?:\/|$|[\s"'])/i;

/** Split simple shell words, honoring quotes/backslash enough for guard checks. */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = ""; inWord = true; continue; }
      if (ch === "\\") { if (i + 1 < cmd.length) word += cmd[++i]; continue; }
      word += ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) { words.push(word); word = ""; inWord = false; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (ch === "\\") { if (i + 1 < cmd.length) word += cmd[++i]; inWord = true; continue; }
    word += ch;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

function isShellEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}

function commandWords(cmd: string): string[] {
  const words = shellWords(cmd);
  let i = 0;
  while (i < words.length && isShellEnvAssignment(words[i])) i++;
  return words.slice(i);
}

function isInlineCodeExecution(cmd: string): boolean {
  const words = commandWords(cmd);
  if (words.length < 2) return false;
  const exe = path.basename(words[0]).toLowerCase();
  const args = words.slice(1);
  if (exe === "node") {
    return args.some((a) =>
      a === "-e" || a === "--eval" || a.startsWith("--eval=") ||
      a === "-p" || a === "--print" || a.startsWith("--print=") ||
      /^-[^-]*[ep]/.test(a)
    );
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(exe)) return args.some((a) => a === "-c" || a.startsWith("-c"));
  if (exe === "perl" || exe === "ruby") return args.some((a) => a === "-e" || a.startsWith("-e"));
  if (exe === "php") return args.some((a) => a === "-r" || a.startsWith("-r"));
  return false;
}

export function isDangerousCommand(cmd: string): boolean {
  // Refuse shell binaries and network tools as the command name.
  const firstWord = commandWords(cmd)[0] ?? "";
  if (DENY_FIRST_TOKEN.test(path.basename(firstWord))) return true;

  // Refuse interpreter inline-code forms that bypass the shell/path guard.
  if (isInlineCodeExecution(cmd)) return true;

  // Refuse destructive shapes and sensitive paths anywhere in the string.
  if (DESTRUCTIVE_RE.some((re) => re.test(cmd))) return true;
  if (SENSITIVE_PATH_RE.test(cmd)) return true;

  // Quote-aware scan: only flag shell metacharacters / expansions when they
  // are not protected by single quotes. Double quotes still allow $, `, and
  // command substitution, so those remain dangerous inside double quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\") i++; // skip escaped char
      else if (ch === "$") return true; // $var / $(cmd) inside "..."
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "\\") { i++; continue; } // skip escaped char
    if (ch === "$" || ch === "`") return true;
    if (ch === ";" || ch === "\n" || ch === "<" || ch === ">") return true;
    if (ch === "|") {
      if (cmd[i + 1] === "|") i++; // ||
      return true;
    }
    if (ch === "&") {
      if (cmd[i + 1] === "&") { i++; return true; } // &&
      // standalone background operator (e.g. "cmd &" / "cmd&")
      if (i === 0 || /\s/.test(cmd[i - 1]) || i === cmd.length - 1 || /\s/.test(cmd[i + 1])) return true;
    }
  }
  return false;
}

function hash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** Run a shell command and capture a reproducible attestation. exit 0 =>
 *  verified, else failed. Never throws — failures are returned as outcomes. */
export function runEvidenceCmd(cmd: string, opts: RunCmdOptions): Promise<RunCmdOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const guard = opts.guardDangerous !== false;

  if (guard && isDangerousCommand(cmd)) {
    return Promise.resolve({
      exit: -1, status: "failed", timed_out: false,
      reason: "command rejected by dangerous-command guard (set guardDangerous=false to override)",
    });
  }

  return new Promise<RunCmdOutcome>((resolve) => {
    const started = Date.now();
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let outLen = 0, errLen = 0, truncated = false, settled = false;

    let child: ChildProcess;
    try {
      child = spawn(cmd, {
        cwd: opts.cwd,
        shell: true,           // allow ordinary CLI command strings such as "npm run smoke:..."
        stdio: ["ignore", "pipe", "pipe"], // no tty; stdin closed
        env: opts.env ?? { ...process.env, CI: "1", NO_COLOR: "1" },
      });
    } catch (e) {
      resolve({ exit: -1, status: "failed", reason: `spawn failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
      return;
    }

    const finish = (exit: number, extra?: Partial<RunCmdOutcome>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(chunks.out);
      const err = Buffer.concat(chunks.err);
      resolve({
        exit,
        status: exit === 0 ? "verified" : "failed",
        stdout_sha: hash(out),
        stderr_sha: hash(err),
        truncated,
        timed_out: false,
        duration_ms: Date.now() - started,
        ...extra,
      });
    };

    const cap = (which: "out" | "err", buf: Buffer) => {
      const lenRef = which === "out" ? outLen : errLen;
      if (lenRef >= maxBytes) { truncated = true; return; }
      const room = maxBytes - lenRef;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      chunks[which].push(slice);
      if (which === "out") outLen += slice.length; else errLen += slice.length;
      if (buf.length > room) truncated = true;
    };

    child.stdout?.on("data", (b: Buffer) => cap("out", b));
    child.stderr?.on("data", (b: Buffer) => cap("err", b));

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      settled = true;
      const out = Buffer.concat(chunks.out);
      const err = Buffer.concat(chunks.err);
      resolve({
        exit: -1, status: "failed", stdout_sha: hash(out), stderr_sha: hash(err),
        truncated, timed_out: true, duration_ms: Date.now() - started,
        reason: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (e: Error) => finish(-1, { reason: `exec error: ${e.message.slice(0, 200)}` }));
    child.on("close", (code: number | null) => finish(typeof code === "number" ? code : -1));
  });
}

// ── file / input-fingerprint helpers ───────────────────────────────────

export interface FileFacts {
  exists: boolean;
  size?: number;
  mtime_ms?: number;
  content_sha?: string;
}

/** Resolve a path (cwd-relative or absolute) to content facts. Used both for
 *  `file:` evidence and for input-file fingerprints feeding G6 staleness. */
export function resolveFileFacts(p: string, cwd: string): FileFacts {
  const fp = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  try {
    const st = fs.statSync(fp);
    if (!st.isFile()) return { exists: false };
    const buf = fs.readFileSync(fp);
    return { exists: true, size: st.size, mtime_ms: st.mtimeMs, content_sha: hash(buf) };
  } catch {
    return { exists: false };
  }
}

/** Current content sha of a file, or undefined if unreadable — the resolver
 *  shape crossCheck() wants for staleness. */
export function fileContentSha(p: string, cwd: string): string | undefined {
  return resolveFileFacts(p, cwd).content_sha;
}
