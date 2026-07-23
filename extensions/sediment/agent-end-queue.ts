/**
 * Process-level scheduler for durable sediment intake records.
 *
 * Durable intake owns restart recovery. This queue is only a bounded runtime
 * optimization: latest work coalesces per key, one key never overlaps itself,
 * distinct keys run concurrently up to a process cap, and `more` continues a
 * frozen backlog on a later macrotask. There is no readiness lifecycle,
 * parking, TTL, wake API, or retained external state.
 */

export interface DetachedAgentEndQueueJob {
  key: string;
  run(): Promise<void | { more: true }>;
  onError?(error: unknown): Promise<void> | void;
}

interface QueueSlot {
  latest: DetachedAgentEndQueueJob;
  version: number;
  active: boolean;
}

interface QueueStats {
  enqueued: number;
  coalesced: number;
  claimed: number;
  completed: number;
  continuations: number;
  errors: number;
  maxConcurrent: number;
  concurrent: number;
}

interface QueueState {
  wakeOrder: string[];
  wakeSet: Set<string>;
  slots: Map<string, QueueSlot>;
  activeWorkers: number;
  idleWaiters: Array<() => void>;
  maxGlobalConcurrent: number;
  stats: QueueStats;
}

const QUEUE_STATE = Symbol.for("pi-astack/sediment/agent-end-queue/v3");
const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>;

export const DEFAULT_MAX_GLOBAL_CONCURRENT = 4;

function emptyStats(): QueueStats {
  return {
    enqueued: 0,
    coalesced: 0,
    claimed: 0,
    completed: 0,
    continuations: 0,
    errors: 0,
    maxConcurrent: 0,
    concurrent: 0,
  };
}

function queueState(): QueueState {
  const existing = host[QUEUE_STATE] as QueueState | undefined;
  if (existing) return existing;
  const created: QueueState = {
    wakeOrder: [],
    wakeSet: new Set(),
    slots: new Map(),
    activeWorkers: 0,
    idleWaiters: [],
    maxGlobalConcurrent: DEFAULT_MAX_GLOBAL_CONCURRENT,
    stats: emptyStats(),
  };
  host[QUEUE_STATE] = created;
  return created;
}

function settleIdleWaiters(state: QueueState): void {
  if (state.activeWorkers > 0 || state.wakeOrder.length > 0) return;
  const waiters = state.idleWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function enqueueWake(state: QueueState, key: string): void {
  if (state.wakeSet.has(key)) return;
  state.wakeSet.add(key);
  state.wakeOrder.push(key);
}

async function reportJobError(job: DetachedAgentEndQueueJob, error: unknown): Promise<void> {
  try {
    await job.onError?.(error);
  } catch {
    // Final rejection boundary: reporting failure cannot stop later work.
  }
}

function pump(state: QueueState): void {
  while (state.wakeOrder.length > 0 && state.activeWorkers < state.maxGlobalConcurrent) {
    const key = state.wakeOrder.shift()!;
    state.wakeSet.delete(key);
    const slot = state.slots.get(key);
    if (!slot || slot.active) continue;
    void runKey(state, key).catch(() => {
      // runKey contains the job boundary and restores state in finally.
    });
  }
  settleIdleWaiters(state);
}

async function runKey(state: QueueState, key: string): Promise<void> {
  const slot = state.slots.get(key);
  if (!slot || slot.active) return;

  slot.active = true;
  state.activeWorkers += 1;
  state.stats.concurrent += 1;
  state.stats.maxConcurrent = Math.max(state.stats.maxConcurrent, state.stats.concurrent);

  const claimed = slot.latest;
  const claimedVersion = slot.version;
  let continuation = false;
  state.stats.claimed += 1;

  try {
    const result = await claimed.run();
    continuation = !!(result && typeof result === "object" && result.more === true);
    if (continuation) state.stats.continuations += 1;
    else state.stats.completed += 1;
  } catch (error) {
    state.stats.errors += 1;
    await reportJobError(claimed, error);
  } finally {
    slot.active = false;
    state.activeWorkers = Math.max(0, state.activeWorkers - 1);
    state.stats.concurrent = Math.max(0, state.stats.concurrent - 1);

    if (slot.version > claimedVersion) {
      enqueueWake(state, key);
      pump(state);
      return;
    }
    if (continuation) {
      enqueueWake(state, key);
      setImmediate(() => pump(state));
      settleIdleWaiters(state);
      return;
    }

    state.slots.delete(key);
    settleIdleWaiters(state);
    pump(state);
  }
}

/** Synchronous enqueue; the awaited pi handler only performs durable intake IO. */
export function enqueueDetachedAgentEnd(job: DetachedAgentEndQueueJob): void {
  const state = queueState();
  state.stats.enqueued += 1;
  const existing = state.slots.get(job.key);
  if (existing) {
    existing.latest = job;
    existing.version += 1;
    state.stats.coalesced += 1;
    if (!existing.active) enqueueWake(state, job.key);
  } else {
    state.slots.set(job.key, { latest: job, version: 1, active: false });
    enqueueWake(state, job.key);
  }
  pump(state);
}

export function waitForDetachedAgentEndQueueIdle(): Promise<void> {
  const state = queueState();
  if (state.activeWorkers === 0 && state.wakeOrder.length === 0) return Promise.resolve();
  return new Promise((resolve) => state.idleWaiters.push(resolve));
}

export function detachedAgentEndQueueStats(): Readonly<QueueStats> & {
  pendingKeys: number;
  maxGlobalConcurrent: number;
} {
  const state = queueState();
  return Object.freeze({
    ...state.stats,
    pendingKeys: state.slots.size,
    maxGlobalConcurrent: state.maxGlobalConcurrent,
  });
}

export function configureDetachedAgentEndQueueForTests(options: {
  maxGlobalConcurrent?: number;
}): void {
  const state = queueState();
  if (options.maxGlobalConcurrent !== undefined) {
    state.maxGlobalConcurrent = Math.max(1, Math.floor(options.maxGlobalConcurrent));
    pump(state);
  }
}

export function resetDetachedAgentEndQueueForTests(): void {
  const state = queueState();
  if (state.activeWorkers > 0 || state.wakeOrder.length > 0) {
    throw new Error("cannot reset active detached agent_end queue");
  }
  state.slots.clear();
  state.wakeOrder.length = 0;
  state.wakeSet.clear();
  state.idleWaiters.splice(0).forEach((resolve) => resolve());
  state.maxGlobalConcurrent = DEFAULT_MAX_GLOBAL_CONCURRENT;
  state.stats = emptyStats();
}
