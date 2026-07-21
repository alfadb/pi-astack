/**
 * Process-level keyed serial queue for lifecycle work that must outlive an
 * extension instance. Enqueue is synchronous and workers start on a later
 * macrotask, so an awaited pi handler can return before any job code runs.
 *
 * Same-key jobs are serial. A newer pending job replaces an older pending job;
 * the active job is never overlapped. Exact duplicate keys are suppressed
 * while active, pending, or recently completed.
 */

export interface KeyedDetachedJob {
  key: string;
  dedupeKey: string;
  run(signal: AbortSignal): Promise<void>;
  onError?(error: unknown): Promise<void> | void;
}

interface QueueSlot {
  active?: { job: KeyedDetachedJob; controller: AbortController };
  pending?: KeyedDetachedJob;
  scheduled: boolean;
  dropWhenIdle: boolean;
  completed: Map<string, number>;
  idleWaiters: Array<() => void>;
}

interface QueueState {
  slots: Map<string, QueueSlot>;
  stats: {
    enqueued: number;
    duplicate: number;
    coalesced: number;
    started: number;
    completed: number;
    cancelled: number;
    errors: number;
    concurrent: number;
    maxConcurrent: number;
  };
}

const STATE = Symbol.for("pi-astack/shared/keyed-detached-queue/v1");
const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
const COMPLETED_TTL_MS = 15 * 60_000;
const MAX_COMPLETED_PER_KEY = 64;

function state(): QueueState {
  const current = host[STATE] as QueueState | undefined;
  if (current) return current;
  const created: QueueState = {
    slots: new Map(),
    stats: {
      enqueued: 0,
      duplicate: 0,
      coalesced: 0,
      started: 0,
      completed: 0,
      cancelled: 0,
      errors: 0,
      concurrent: 0,
      maxConcurrent: 0,
    },
  };
  host[STATE] = created;
  return created;
}

function slotFor(queue: QueueState, key: string): QueueSlot {
  const current = queue.slots.get(key);
  if (current) return current;
  const created: QueueSlot = { scheduled: false, dropWhenIdle: false, completed: new Map(), idleWaiters: [] };
  queue.slots.set(key, created);
  return created;
}

function pruneCompleted(slot: QueueSlot, now = Date.now()): void {
  for (const [key, completedAt] of slot.completed) {
    if (now - completedAt > COMPLETED_TTL_MS) slot.completed.delete(key);
  }
  while (slot.completed.size > MAX_COMPLETED_PER_KEY) {
    const oldest = slot.completed.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    slot.completed.delete(oldest);
  }
}

function settleSlot(queue: QueueState, key: string, slot: QueueSlot): void {
  if (slot.active || slot.pending || slot.scheduled) return;
  const waiters = slot.idleWaiters.splice(0);
  for (const resolve of waiters) resolve();
  if (slot.dropWhenIdle) slot.completed.clear();
  pruneCompleted(slot);
  if (slot.completed.size === 0) queue.slots.delete(key);
}

async function reportError(job: KeyedDetachedJob, error: unknown): Promise<void> {
  try {
    await job.onError?.(error);
  } catch {
    // This is the process-level rejection boundary. Reporting cannot leak.
  }
}

function schedule(queue: QueueState, key: string, slot: QueueSlot): void {
  if (slot.active || slot.scheduled || !slot.pending) return;
  slot.scheduled = true;
  setImmediate(() => {
    slot.scheduled = false;
    void runNext(queue, key, slot).catch(() => {
      // runNext contains the job rejection boundary and state-restoring finally.
    });
  });
}

async function runNext(queue: QueueState, key: string, slot: QueueSlot): Promise<void> {
  if (slot.active || !slot.pending) {
    settleSlot(queue, key, slot);
    return;
  }
  const job = slot.pending;
  slot.pending = undefined;
  const controller = new AbortController();
  slot.active = { job, controller };
  queue.stats.started += 1;
  queue.stats.concurrent += 1;
  queue.stats.maxConcurrent = Math.max(queue.stats.maxConcurrent, queue.stats.concurrent);

  try {
    await job.run(controller.signal);
    queue.stats.completed += 1;
  } catch (error) {
    queue.stats.errors += 1;
    await reportError(job, error);
  } finally {
    queue.stats.concurrent = Math.max(0, queue.stats.concurrent - 1);
    slot.completed.set(job.dedupeKey, Date.now());
    slot.active = undefined;
    pruneCompleted(slot);
    if (slot.pending) schedule(queue, key, slot);
    settleSlot(queue, key, slot);
  }
}

/** Synchronous enqueue. Returns false when the exact job is already known. */
export function enqueueKeyedDetached(job: KeyedDetachedJob): boolean {
  const queue = state();
  const slot = slotFor(queue, job.key);
  slot.dropWhenIdle = false;
  pruneCompleted(slot);
  queue.stats.enqueued += 1;

  if (
    slot.active?.job.dedupeKey === job.dedupeKey
    || slot.pending?.dedupeKey === job.dedupeKey
    || slot.completed.has(job.dedupeKey)
  ) {
    queue.stats.duplicate += 1;
    return false;
  }
  if (slot.pending) queue.stats.coalesced += 1;
  slot.pending = job;
  schedule(queue, job.key, slot);
  return true;
}

/** Abort active work and discard pending work for one key. */
export function cancelKeyedDetached(key: string, reason = "cancelled"): boolean {
  const queue = state();
  const slot = queue.slots.get(key);
  if (!slot) return false;
  let changed = false;
  slot.dropWhenIdle = true;
  slot.completed.clear();
  if (slot.pending) {
    slot.pending = undefined;
    changed = true;
  }
  if (slot.active && !slot.active.controller.signal.aborted) {
    slot.active.controller.abort(new Error(reason));
    changed = true;
  }
  if (changed) queue.stats.cancelled += 1;
  settleSlot(queue, key, slot);
  return changed;
}

export function waitForKeyedDetachedIdle(key?: string): Promise<void> {
  const queue = state();
  if (key !== undefined) {
    const slot = queue.slots.get(key);
    if (!slot || (!slot.active && !slot.pending && !slot.scheduled)) return Promise.resolve();
    return new Promise((resolve) => slot.idleWaiters.push(resolve));
  }
  const waits = [...queue.slots.keys()].map((slotKey) => waitForKeyedDetachedIdle(slotKey));
  return Promise.all(waits).then(() => undefined);
}

export function keyedDetachedQueueStats(): Readonly<QueueState["stats"]> & { keys: number } {
  const queue = state();
  return Object.freeze({ ...queue.stats, keys: queue.slots.size });
}

/** Test-only reset. Active work must be cancelled and drained first. */
export function resetKeyedDetachedQueueForTests(): void {
  const queue = state();
  for (const slot of queue.slots.values()) {
    if (slot.active || slot.scheduled) throw new Error("cannot reset active keyed detached queue");
    slot.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
  queue.slots.clear();
  queue.stats = {
    enqueued: 0,
    duplicate: 0,
    coalesced: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
    errors: 0,
    concurrent: 0,
    maxConcurrent: 0,
  };
}
