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

// Coarse guard for irreversible/destructive shapes. NOT a security boundary
// (the AI has bash anyway) — it stops a fat-fingered `rm -rf /` from riding
// the evidence path. Conservative: only blocks unmistakable patterns.
const DANGEROUS_RE = [
  /\brm\s+-[a-z]*r[a-z]*f?\b[^\n]*\s(\/|~|\$HOME)(\s|$)/i, // rm -rf / | ~ | $HOME
  /\bmkfs\b/i,
  /\b(dd)\b[^\n]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(shutdown|reboot|halt)\b/i,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_RE.some((re) => re.test(cmd));
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
        shell: true,           // allow "npm run x && grep y" style
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
