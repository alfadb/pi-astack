import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { gitSingleFlight } from "./git-singleflight";
import {
  acquireRetainedDirectoryOfdLock,
  type RetainedDirectoryOfdLock,
} from "./retained-directory-ofd-lock";

interface BarrierLease {
  active: boolean;
}

interface CanonicalMutationBarrierState {
  version: 1;
  heldRepositories: AsyncLocalStorage<ReadonlyMap<string, BarrierLease>>;
}

const STATE_KEY = Symbol.for("pi-astack/canonical-mutation-barrier/state/v1");

function barrierState(): CanonicalMutationBarrierState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[STATE_KEY] as Partial<CanonicalMutationBarrierState> | undefined;
  if (existing?.version === 1 && existing.heldRepositories instanceof AsyncLocalStorage) {
    return existing as CanonicalMutationBarrierState;
  }
  const created: CanonicalMutationBarrierState = {
    version: 1,
    heldRepositories: new AsyncLocalStorage<ReadonlyMap<string, BarrierLease>>(),
  };
  global[STATE_KEY] = created;
  return created;
}

const heldRepositories = barrierState().heldRepositories;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INITIAL_MS = 25;
const DEFAULT_RETRY_MAX_MS = 1_000;

export interface CanonicalMutationBarrierOptions {
  timeoutMs?: number;
  /** Optional absolute deadline in the same monotonic clock domain as `now`. */
  deadlineMs?: number;
  /** Backward-compatible name for the first retry delay. */
  retryMs?: number;
  maxRetryMs?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  onProbe?: (probe: number) => void;
}

export class CanonicalMutationBarrierError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CanonicalMutationBarrierError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

function canonicalKey(repo: string): string {
  return fs.realpathSync.native(path.resolve(repo));
}

export function canonicalMutationBarrierHeld(repo: string): boolean {
  return heldRepositories.getStore()?.get(canonicalKey(repo))?.active === true;
}

function boundedJitter(baseMs: number, random: () => number): number {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.max(1, Math.floor(baseMs * (0.5 + sample * 0.5)));
}

async function acquireWithRetry(
  repo: string,
  options: CanonicalMutationBarrierOptions,
): Promise<RetainedDirectoryOfdLock & { status: "ACQUIRED" }> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryInitialMs = Math.max(1, options.retryMs ?? DEFAULT_RETRY_INITIAL_MS);
  const retryMaxMs = Math.max(retryInitialMs, options.maxRetryMs ?? DEFAULT_RETRY_MAX_MS);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const timeoutDeadlineMs = startedAtMs + timeoutMs;
  const deadlineMs = options.deadlineMs === undefined
    ? timeoutDeadlineMs
    : Math.min(timeoutDeadlineMs, options.deadlineMs);
  let probe = 0;
  for (;;) {
    const remainingBeforeProbeMs = deadlineMs - now();
    if (remainingBeforeProbeMs <= 0) {
      throw new CanonicalMutationBarrierError("CANONICAL_MUTATION_BUSY", "timed out waiting for the per-repository OFD mutation barrier", {
        repo,
        timeoutMs,
        deadlineMs,
        probes: probe,
      });
    }
    probe += 1;
    options.onProbe?.(probe);
    const lock = acquireRetainedDirectoryOfdLock(repo);
    if (lock.status === "ACQUIRED") return lock as RetainedDirectoryOfdLock & { status: "ACQUIRED" };
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      throw new CanonicalMutationBarrierError("CANONICAL_MUTATION_BUSY", "timed out waiting for the per-repository OFD mutation barrier", {
        repo,
        timeoutMs,
        deadlineMs,
        probes: probe,
      });
    }
    const exponent = Math.min(30, probe - 1);
    const cappedBaseMs = Math.min(retryMaxMs, retryInitialMs * (2 ** exponent));
    await sleep(Math.min(remainingMs, boundedJitter(cappedBaseMs, random)));
  }
}

/**
 * Enter the OFD barrier from a callback that already owns this repository's
 * gitSingleFlight turn. Calling the outer helper from that callback would
 * enqueue behind itself and deadlock.
 */
export async function withCanonicalMutationBarrierInSingleFlight<T>(
  repoInput: string,
  operation: () => Promise<T>,
  options: CanonicalMutationBarrierOptions = {},
): Promise<T> {
  const repo = canonicalKey(repoInput);
  if (canonicalMutationBarrierHeld(repo)) return operation();
  const lock = await acquireWithRetry(repo, options);
  const parent = heldRepositories.getStore();
  const held = new Map(parent ?? []);
  const lease: BarrierLease = { active: true };
  held.set(repo, lease);
  try {
    return await heldRepositories.run(held, operation);
  } finally {
    // AsyncLocalStorage context propagates into detached promises. Invalidate
    // the shared lease before closing the fd so those continuations cannot
    // mistake inherited context for ownership after this callback returns.
    lease.active = false;
    lock.close();
  }
}

/** Process-local ordering is always acquired before the cross-process OFD lock. */
export function withCanonicalMutationBarrier<T>(
  repoInput: string,
  operation: () => Promise<T>,
  options: CanonicalMutationBarrierOptions = {},
): Promise<T> {
  const repo = canonicalKey(repoInput);
  if (canonicalMutationBarrierHeld(repo)) return operation();
  return gitSingleFlight(repo, () => withCanonicalMutationBarrierInSingleFlight(repo, operation, options));
}

export function withoutCanonicalMutationBarrierContext<T>(operation: () => T): T {
  return heldRepositories.exit(operation);
}

export function assertCanonicalMutationBarrierHeld(repo: string): void {
  if (!canonicalMutationBarrierHeld(repo)) {
    throw new CanonicalMutationBarrierError("CANONICAL_MUTATION_LOCK_REQUIRED", "canonical repository mutation requires the OFD barrier", {
      repo: canonicalKey(repo),
    });
  }
}
