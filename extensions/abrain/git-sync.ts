/**
 * Best-effort transport plus deterministic multi-device convergence.
 *
 * Transport configuration and credentials remain device-owned. Canonical
 * divergence is joined without merge-tree/rebase/force/LLM merge: the shared
 * coordinator unions append-only L1, rebuilds registered L2, and applies a
 * fail-closed file-level three-way choice to every other tracked path.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import {
  prepareDeviceJoin,
  publishPreparedDeviceJoin,
  type PreparedDeviceJoin,
} from "../_shared/device-join-coordinator";
import { _gitSingleFlightStats } from "../_shared/git-singleflight";
import {
  canonicalGitRuntimeEnabled,
  getCanonicalGitRuntime,
} from "../_shared/canonical-git-runtime";
import { redactCredentials } from "./redact";

const execFileAsync = promisify(execFile);
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_PUSH_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_JOIN_PUSH_ATTEMPTS = 3;
const MAX_BUFFER = 4 * 1024 * 1024;

export { redactCredentials };

export type GitSyncNotifyType = "info" | "warning" | "error";
export type GitSyncOp = "push" | "fetch" | "sync";
export type GitSyncResult = "ok" | "noop" | "skipped" | "conflict" | "diverged" | "push_rejected" | "timeout" | "failed";

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
  maxAttempts?: number;
  jitterMs?: number;
}

type GitSyncOperationOverrides = Partial<{
  prepareDeviceJoin: typeof prepareDeviceJoin;
  publishPreparedDeviceJoin: typeof publishPreparedDeviceJoin;
}>;

let gitSyncOperationOverrides: Readonly<GitSyncOperationOverrides> | undefined;

/** Test-only fault boundary for proving that a path never enters device join. */
export function __setGitSyncOperationOverridesForTests(overrides?: GitSyncOperationOverrides): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error("__setGitSyncOperationOverridesForTests requires PI_ASTACK_ENABLE_TEST_HOOKS=1");
  }
  gitSyncOperationOverrides = overrides ? Object.freeze({ ...overrides }) : undefined;
}

function prepareDeviceJoinForSync(options: Parameters<typeof prepareDeviceJoin>[0]): ReturnType<typeof prepareDeviceJoin> {
  return (gitSyncOperationOverrides?.prepareDeviceJoin ?? prepareDeviceJoin)(options);
}

function publishPreparedDeviceJoinForSync(
  prepared: PreparedDeviceJoin,
  options: Parameters<typeof publishPreparedDeviceJoin>[1],
): ReturnType<typeof publishPreparedDeviceJoin> {
  return (gitSyncOperationOverrides?.publishPreparedDeviceJoin ?? publishPreparedDeviceJoin)(prepared, options);
}

export interface AbrainSyncStatus {
  isGitRepo: boolean;
  branch?: string;
  ahead: number;
  behind: number;
  lastPush?: GitSyncEvent;
  lastFetch?: GitSyncEvent;
}

function freshGitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
}

async function canonicalAbrainHome(input: string): Promise<string> {
  return fs.realpath(path.resolve(input));
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

function exactCommitOid(value: string, label: string): string {
  const oid = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error(`${label} did not resolve to an exact commit oid`);
  return oid;
}

async function resolveFetchedTips(repo: string, timeoutMs: number): Promise<{ localHead: string; upstreamHead: string }> {
  const [localHead, upstreamHead] = await Promise.all([
    runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"], timeoutMs),
    runGit(repo, ["rev-parse", "--verify", "@{upstream}^{commit}"], timeoutMs),
  ]);
  return {
    localHead: exactCommitOid(localHead, "HEAD"),
    upstreamHead: exactCommitOid(upstreamHead, "upstream"),
  };
}

function errorText(error: unknown): string {
  const value = error as { message?: string; stderr?: string | Buffer };
  return `${value?.message ?? error ?? "unknown"}\n${value?.stderr?.toString?.() ?? ""}`;
}

function classifyError(error: unknown, operation: "fetch" | "push" | "join"): { result: GitSyncResult; message: string; code?: string } {
  const value = error as { killed?: boolean; signal?: string; code?: string };
  const combined = errorText(error);
  const message = redactCredentials(combined).trim().slice(0, 500) || "unknown";
  if ((value?.killed && value.signal === "SIGTERM") || value?.code === "ETIMEDOUT") return { result: "timeout", message, code: value.code };
  if (operation === "push" && /rejected|non-fast-forward|fetch first|stale info/i.test(combined)) return { result: "push_rejected", message, code: value.code };
  if (operation === "join" && (/^DEVICE_JOIN_/m.test(value?.code ?? "") || /DeviceJoinError|DEVICE_JOIN_/m.test(combined))) {
    return { result: "conflict", message, code: value?.code };
  }
  return { result: "failed", message, code: value?.code };
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

async function configuredPushTarget(repo: string, timeoutMs: number): Promise<{ remote: string; mergeRef: string }> {
  const branch = (await runGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs)).trim();
  if (!branch || branch.includes("\n") || branch.includes("\0")) throw new Error("current branch is detached or unsafe");
  const [remote, mergeRef] = await Promise.all([
    runGit(repo, ["config", "--get", `branch.${branch}.remote`], timeoutMs).then((value) => value.trim()),
    runGit(repo, ["config", "--get", `branch.${branch}.merge`], timeoutMs).then((value) => value.trim()),
  ]);
  if (!/^[A-Za-z0-9._\/-]+$/.test(remote) || remote.startsWith("-")
    || !/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(mergeRef) || mergeRef.includes("..")) {
    throw new Error("configured upstream remote/ref is missing or unsafe");
  }
  return { remote, mergeRef };
}

async function settleCanonicalForJoin(repo: string): Promise<void> {
  // The disposition helper throws for missing/invalid settings. Only an
  // explicit valid enabled=false may bypass canonical pre-join settlement.
  if (!canonicalGitRuntimeEnabled()) return;
  const runtime = await getCanonicalGitRuntime({ abrainHome: repo });
  await runtime.settleForDeviceJoin();
}

async function publishWithStaleRecompute(repo: string, prepared: PreparedDeviceJoin, maxAttempts: number): Promise<{ head: string; prepared: PreparedDeviceJoin }> {
  let current = prepared;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const published = await publishPreparedDeviceJoinForSync(current, { settleCanonical: () => settleCanonicalForJoin(repo) });
    if (published.status !== "stale") return { head: published.head, prepared: current };
    current = await prepareDeviceJoinForSync({ repo });
  }
  const error = new Error("DEVICE_JOIN_STALE_RETRY_EXHAUSTED: HEAD changed during every bounded publication attempt") as Error & { code?: string };
  error.code = "DEVICE_JOIN_STALE_RETRY_EXHAUSTED";
  throw error;
}

async function fetchAndJoinUnlocked(repo: string, timeoutMs: number, maxAttempts: number): Promise<GitSyncEvent> {
  const started = Date.now();
  const event: GitSyncEvent = { ts: new Date().toISOString(), op: "fetch", result: "ok" };
  let headBefore: string;
  let fetchedTips: { localHead: string; upstreamHead: string };
  try {
    headBefore = exactCommitOid(await runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"], timeoutMs), "pre-fetch HEAD");
    await runGit(repo, ["fetch"], timeoutMs);
    fetchedTips = await resolveFetchedTips(repo, timeoutMs);
    if (fetchedTips.localHead === fetchedTips.upstreamHead) {
      event.result = "noop";
      event.merged = 0;
      event.details = {
        convergence: "fetched_oid_noop",
        localHead: fetchedTips.localHead,
        upstreamHead: fetchedTips.upstreamHead,
        candidate: fetchedTips.localHead,
      };
      event.durationMs = Date.now() - started;
      await audit(repo, event);
      return event;
    }
  } catch (error) {
    const classified = classifyError(error, "fetch");
    event.result = classified.result;
    event.error = classified.message;
    event.durationMs = Date.now() - started;
    await audit(repo, event);
    return event;
  }
  try {
    const prepared = await prepareDeviceJoinForSync({ repo });
    const published = await publishWithStaleRecompute(repo, prepared, maxAttempts);
    const headAfter = published.head;
    event.details = {
      convergence: published.prepared.status,
      base: published.prepared.base,
      localHead: published.prepared.localHead,
      upstreamHead: published.prepared.upstreamHead,
      fetchedLocalHead: fetchedTips.localHead,
      fetchedUpstreamHead: fetchedTips.upstreamHead,
      candidate: headAfter,
    };
    if (headAfter === headBefore) event.merged = 0;
    else {
      const countText = (await runGit(repo, ["rev-list", "--count", `${headBefore}..${headAfter}`], timeoutMs)).trim();
      const count = Number.parseInt(countText, 10);
      event.merged = Number.isSafeInteger(count) && count > 0 ? count : 1;
    }
  } catch (error) {
    const classified = classifyError(error, "join");
    event.result = classified.result;
    event.error = classified.message;
    event.reason = classified.code;
  }
  event.durationMs = Date.now() - started;
  await audit(repo, event);
  return event;
}

async function exactPushOnce(repo: string, timeoutMs: number): Promise<GitSyncEvent> {
  const started = Date.now();
  const event: GitSyncEvent = { ts: new Date().toISOString(), op: "push", result: "ok" };
  try {
    const oid = exactCommitOid(await runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"], timeoutMs), "HEAD");
    const target = await configuredPushTarget(repo, timeoutMs);
    await runGit(repo, ["push", target.remote, `${oid}:${target.mergeRef}`], timeoutMs);
    event.details = { exactOid: oid, remote: target.remote, destination: target.mergeRef };
  } catch (error) {
    const classified = classifyError(error, "push");
    event.result = classified.result;
    event.error = classified.message;
  }
  event.durationMs = Date.now() - started;
  await audit(repo, event);
  return event;
}

async function jitter(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  const bounded = Math.max(1, Math.min(delayMs, 2_000));
  await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * bounded)));
}

function boundedAttempts(options: GitSyncOptions): number {
  const value = options.maxAttempts ?? DEFAULT_MAX_JOIN_PUSH_ATTEMPTS;
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), 8)) : DEFAULT_MAX_JOIN_PUSH_ATTEMPTS;
}

async function convergeAndPush(repo: string, options: GitSyncOptions): Promise<{ events: GitSyncEvent[]; ok: boolean }> {
  const maxAttempts = boundedAttempts(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  const events: GitSyncEvent[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pushed = await exactPushOnce(repo, timeoutMs);
    pushed.details = { ...(pushed.details ?? {}), attempt, maxAttempts };
    events.push(pushed);
    if (pushed.result === "ok") return { events, ok: true };
    if (pushed.result !== "push_rejected" || attempt === maxAttempts) return { events, ok: false };
    const fetched = await fetchAndJoinUnlocked(repo, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS, maxAttempts);
    fetched.details = { ...(fetched.details ?? {}), retryAfterPushRejection: attempt };
    events.push(fetched);
    if (fetched.result === "noop") return { events, ok: true };
    if (fetched.result !== "ok") return { events, ok: false };
    await jitter(options.jitterMs ?? 100);
  }
  return { events, ok: false };
}

export async function pushAsync(options: GitSyncOptions): Promise<GitSyncEvent> {
  let repo: string;
  try { repo = await canonicalAbrainHome(options.abrainHome); }
  catch (error) {
    return { ts: new Date().toISOString(), op: "push", result: "failed", durationMs: 0, error: redactCredentials(String(error)).slice(0, 500) };
  }
  const fetched = await fetchAndJoinUnlocked(repo, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS, boundedAttempts(options));
  if (fetched.result !== "ok") return fetched;
  const result = await convergeAndPush(repo, options);
  return result.events[result.events.length - 1] ?? { ts: new Date().toISOString(), op: "push", result: "failed", error: "no push attempt executed" };
}

/** Compatibility name retained; behavior is fetch plus deterministic join. */
export async function fetchAndFF(options: GitSyncOptions): Promise<GitSyncEvent> {
  let repo: string;
  try { repo = await canonicalAbrainHome(options.abrainHome); }
  catch (error) {
    return { ts: new Date().toISOString(), op: "fetch", result: "failed", durationMs: 0, error: redactCredentials(String(error)).slice(0, 500) };
  }
  return fetchAndJoinUnlocked(repo, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS, boundedAttempts(options));
}

export async function sync(options: GitSyncOptions): Promise<{ events: GitSyncEvent[]; ok: boolean; summary: string }> {
  let repo: string;
  try { repo = await canonicalAbrainHome(options.abrainHome); }
  catch (error) {
    const event: GitSyncEvent = { ts: new Date().toISOString(), op: "sync", result: "failed", durationMs: 0, error: redactCredentials(String(error)).slice(0, 500) };
    return { events: [event], ok: false, summary: `sync failed: ${event.error}` };
  }
  const fetchEvent = await fetchAndJoinUnlocked(repo, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS, boundedAttempts(options));
  if (fetchEvent.result === "noop") {
    return { events: [fetchEvent], ok: true, summary: "synced: fetched tips are identical; device join and push skipped" };
  }
  if (fetchEvent.result !== "ok") {
    return { events: [fetchEvent], ok: false, summary: `fetch/join failed (${fetchEvent.result}): ${fetchEvent.error ?? "unknown"}` };
  }
  const pushed = await convergeAndPush(repo, options);
  const events = [fetchEvent, ...pushed.events];
  return {
    events,
    ok: pushed.ok,
    summary: pushed.ok ? "synced: fetch=ok, deterministic-join=ok, exact-oid-push=ok" : `push/convergence failed (${events[events.length - 1]?.result ?? "failed"})`,
  };
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
