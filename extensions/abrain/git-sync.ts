/**
 * Device Git synchronization boundary.
 *
 * Canonical truth ends at local commit/index convergence. This module is a
 * best-effort device delivery mechanism and never writes L1 or changes a
 * canonical runtime result. Repository remotes, upstreams, authentication,
 * SSH/helpers/proxies/TLS, URL rewrites, and inherited GIT_* are user-owned.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { gitSingleFlight, _gitSingleFlightStats } from "../_shared/git-singleflight";
import { redactCredentials } from "./redact";

const execFileAsync = promisify(execFile);
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
export const DEFAULT_PUSH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

export { redactCredentials };

export type GitSyncNotifyType = "info" | "warning" | "error";
export type GitSyncOp = "push" | "fetch" | "sync";
export type GitSyncResult = "ok" | "noop" | "skipped" | "conflict" | "diverged" | "push_rejected" | "push_blocked_reconcile" | "timeout" | "failed";

export interface GitSyncEvent {
  ts: string;
  op: GitSyncOp;
  result: GitSyncResult;
  ahead?: number;
  behind?: number;
  merged?: number;
  conflictResolvedDerivedL2?: number;
  durationMs?: number;
  error?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface GitSyncOptions {
  abrainHome: string;
  timeoutMs?: number;
}

export interface AbrainSyncStatus {
  isGitRepo: boolean;
  branch?: string;
  ahead: number;
  behind: number;
  lastPush?: GitSyncEvent;
  lastFetch?: GitSyncEvent;
  consecutivePushBlockedReconcile?: number;
}

function freshGitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
}

async function canonicalAbrainHome(input: string): Promise<string> {
  return fspRealpath(path.resolve(input));
}

async function fspRealpath(input: string): Promise<string> {
  return fs.realpath(input);
}

async function runGit(repo: string, args: readonly string[], timeout: number): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    env: freshGitEnvironment(),
    timeout,
    maxBuffer: MAX_BUFFER,
    encoding: "utf-8",
  });
  return stdout;
}

function classifyError(error: unknown, operation: "fetch" | "merge" | "push"): { result: GitSyncResult; message: string } {
  const value = error as { killed?: boolean; signal?: string; message?: string; stderr?: string };
  const combined = `${value?.message ?? error ?? "unknown"}\n${value?.stderr ?? ""}`;
  const message = redactCredentials(combined).trim().slice(0, 500) || "unknown";
  if (value?.killed && value.signal === "SIGTERM") return { result: "timeout", message };
  if (operation === "merge" && /not possible to fast-forward|non-fast-forward|diverg/i.test(combined)) return { result: "diverged", message };
  if (operation === "push" && /rejected|non-fast-forward|fetch first/i.test(combined)) return { result: "push_rejected", message };
  return { result: "failed", message };
}

async function audit(repo: string, event: GitSyncEvent): Promise<void> {
  try {
    const stateDir = path.join(repo, ".state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(path.join(stateDir, "git-sync.jsonl"), `${JSON.stringify({ ...spreadAnchor(getCurrentAnchor()), ...event })}\n`, "utf-8");
  } catch {
    // Delivery diagnostics are best-effort and never gate local publication.
  }
}

export function _queueDepth(): { hasInflight: boolean } {
  return { hasInflight: _gitSingleFlightStats().opsStarted > 0 };
}

export function shellQuotePath(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) return "'<path contains control characters>'";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function pushUnlocked(repo: string, timeoutMs: number): Promise<GitSyncEvent> {
  const started = Date.now();
  const event: GitSyncEvent = { ts: new Date().toISOString(), op: "push", result: "ok" };
  try {
    await runGit(repo, ["push"], timeoutMs);
  } catch (error) {
    const classified = classifyError(error, "push");
    event.result = classified.result;
    event.error = classified.message;
  }
  event.durationMs = Date.now() - started;
  await audit(repo, event);
  return event;
}

async function fetchAndFFUnlocked(repo: string, timeoutMs: number): Promise<GitSyncEvent> {
  const started = Date.now();
  const event: GitSyncEvent = { ts: new Date().toISOString(), op: "fetch", result: "ok" };
  let headBefore: string;
  try {
    headBefore = (await runGit(repo, ["rev-parse", "--verify", "HEAD"], timeoutMs)).trim();
    await runGit(repo, ["fetch"], timeoutMs);
  } catch (error) {
    const classified = classifyError(error, "fetch");
    event.result = classified.result;
    event.error = classified.message;
    event.durationMs = Date.now() - started;
    await audit(repo, event);
    return event;
  }
  try {
    await runGit(repo, ["merge", "--ff-only", "@{upstream}"], timeoutMs);
    const headAfter = (await runGit(repo, ["rev-parse", "--verify", "HEAD"], timeoutMs)).trim();
    if (headAfter === headBefore) {
      event.merged = 0;
    } else {
      const countText = (await runGit(repo, ["rev-list", "--count", `${headBefore}..${headAfter}`], timeoutMs)).trim();
      const count = Number.parseInt(countText, 10);
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error("local HEAD commit count was not a positive integer");
      event.merged = count;
    }
  } catch (error) {
    const classified = classifyError(error, "merge");
    event.result = classified.result;
    event.error = classified.message;
  }
  event.durationMs = Date.now() - started;
  await audit(repo, event);
  return event;
}

export async function pushAsync(options: GitSyncOptions): Promise<GitSyncEvent> {
  let repo: string;
  try { repo = await canonicalAbrainHome(options.abrainHome); }
  catch (error) {
    return { ts: new Date().toISOString(), op: "push", result: "failed", durationMs: 0, error: redactCredentials(String(error)).slice(0, 500) };
  }
  return gitSingleFlight(repo, () => pushUnlocked(repo, options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS));
}

export async function fetchAndFF(options: GitSyncOptions): Promise<GitSyncEvent> {
  let repo: string;
  try { repo = await canonicalAbrainHome(options.abrainHome); }
  catch (error) {
    return { ts: new Date().toISOString(), op: "fetch", result: "failed", durationMs: 0, error: redactCredentials(String(error)).slice(0, 500) };
  }
  return gitSingleFlight(repo, () => fetchAndFFUnlocked(repo, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS));
}

export async function sync(options: GitSyncOptions): Promise<{ events: GitSyncEvent[]; ok: boolean; summary: string }> {
  let repo: string;
  try { repo = await canonicalAbrainHome(options.abrainHome); }
  catch (error) {
    const event: GitSyncEvent = { ts: new Date().toISOString(), op: "sync", result: "failed", durationMs: 0, error: redactCredentials(String(error)).slice(0, 500) };
    return { events: [event], ok: false, summary: `sync failed: ${event.error}` };
  }
  return gitSingleFlight(repo, async () => {
    const fetchEvent = await fetchAndFFUnlocked(repo, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    if (fetchEvent.result !== "ok") {
      return { events: [fetchEvent], ok: false, summary: `fetch/ff failed (${fetchEvent.result}): ${fetchEvent.error ?? "unknown"}` };
    }
    const pushEvent = await pushUnlocked(repo, options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS);
    const ok = pushEvent.result === "ok";
    return { events: [fetchEvent, pushEvent], ok, summary: ok ? "synced: fetch=ok, ff=ok, push=ok" : `push failed (${pushEvent.result}): ${pushEvent.error ?? "unknown"}` };
  });
}

export async function getAheadBehind(abrainHome: string): Promise<{ ahead: number; behind: number }> {
  try {
    const repo = await canonicalAbrainHome(abrainHome);
    const output = await runGit(repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], 3_000);
    const [behindText = "0", aheadText = "0"] = output.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadText, 10);
    const behind = Number.parseInt(behindText, 10);
    return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

async function readAuditTail(repo: string): Promise<{ lastPush?: GitSyncEvent; lastFetch?: GitSyncEvent }> {
  try {
    const file = await fs.open(path.join(repo, ".state", "git-sync.jsonl"), "r");
    try {
      const stat = await file.stat();
      const size = Math.min(stat.size, 200 * 1024);
      const buffer = Buffer.alloc(size);
      await file.read(buffer, 0, size, stat.size - size);
      const result: { lastPush?: GitSyncEvent; lastFetch?: GitSyncEvent } = {};
      for (const line of buffer.toString("utf-8").trim().split("\n").reverse()) {
        try {
          const event = JSON.parse(line) as GitSyncEvent;
          if (event.op === "push" && !result.lastPush) result.lastPush = event;
          if (event.op === "fetch" && !result.lastFetch) result.lastFetch = event;
          if (result.lastPush && result.lastFetch) break;
        } catch { /* skip malformed local audit rows */ }
      }
      return result;
    } finally { await file.close(); }
  } catch { return {}; }
}

export async function getStatus(abrainHome: string): Promise<AbrainSyncStatus> {
  let repo: string;
  try { repo = await canonicalAbrainHome(abrainHome); }
  catch { return { isGitRepo: false, ahead: 0, behind: 0 }; }
  let branch: string | undefined;
  try { branch = (await runGit(repo, ["branch", "--show-current"], 3_000)).trim() || undefined; } catch { /* detached or not a repo */ }
  const counts = await getAheadBehind(repo);
  return { isGitRepo: true, branch, ...counts, ...(await readAuditTail(repo)) };
}

export function formatSyncStatus(status: AbrainSyncStatus): string {
  if (!status.isGitRepo) return "abrain repo: unavailable";
  const lines = ["abrain device git sync:"];
  if (status.branch) lines.push(`  branch: ${status.branch}`);
  lines.push(`  ahead:  ${status.ahead}`);
  lines.push(`  behind: ${status.behind}`);
  const format = (label: string, event?: GitSyncEvent) => event
    ? `  last ${label}: ${event.ts} ${event.result}${event.error ? ` - ${event.error.split("\n")[0]!.slice(0, 80)}` : ""}`
    : `  last ${label}: (none recorded)`;
  lines.push(format("push", status.lastPush), format("fetch", status.lastFetch));
  return lines.join("\n");
}
