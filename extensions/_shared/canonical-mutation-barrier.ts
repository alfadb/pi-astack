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
const DEFAULT_RETRY_MS = 25;

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

async function acquireWithRetry(repo: string, timeoutMs: number, retryMs: number): Promise<RetainedDirectoryOfdLock & { status: "ACQUIRED" }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = acquireRetainedDirectoryOfdLock(repo);
    if (lock.status === "ACQUIRED") return lock as RetainedDirectoryOfdLock & { status: "ACQUIRED" };
    if (Date.now() >= deadline) {
      throw new CanonicalMutationBarrierError("CANONICAL_MUTATION_BUSY", "timed out waiting for the per-repository OFD mutation barrier", {
        repo,
        timeoutMs,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
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
  options: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const repo = canonicalKey(repoInput);
  if (canonicalMutationBarrierHeld(repo)) return operation();
  const lock = await acquireWithRetry(repo, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.retryMs ?? DEFAULT_RETRY_MS);
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
  options: { timeoutMs?: number; retryMs?: number } = {},
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
