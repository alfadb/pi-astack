/**
 * Process-level, multi-key queue for awaited pi lifecycle hooks.
 *
 * `agent_end` handlers enqueue plain snapshots and return. Each session key
 * has at most one active worker (same-key serial). Distinct keys run
 * concurrently up to a global cap so one session's readiness wait cannot
 * stall another, while same-repo writers remain serialised by resource locks.
 *
 * While a job is waiting at its startup gate, newer snapshots for the same
 * key replace the pending snapshot. Once the gate opens ready=true, the
 * worker claims the latest snapshot. Updates arriving after that claim are
 * processed in a later pass.
 *
 * ready=false does NOT claim/complete/delete: the snapshot is parked and
 * retained under count/bytes/TTL bounds. A later enqueue (or explicit wake)
 * retries readiness. There is no permanent timer keepalive.
 *
 * `run()` may return `{ more: true }` to keep a ready-pending slot (budget
 * exhausted mid-backlog) instead of deleting; the worker re-queues the key.
 */

export interface DetachedAgentEndQueueJob {
  key: string;
  waitUntilReady(): Promise<boolean>;
  /**
   * Process one claimed pass. Return `{ more: true }` when the frozen
   * snapshot still has unprocessed backlog under a per-turn budget so the
   * slot is retained as ready-pending and re-queued (not deleted).
   */
  run(): Promise<void | { more: true }>;
  onError?(error: unknown): Promise<void> | void;
  /** Optional: fired when waitUntilReady settles false and the job is parked. */
  onNotReady?(info: { key: string; version: number }): Promise<void> | void;
  /** Optional: fired when a parked slot is evicted by bound/TTL policy. */
  onParkEvicted?(info: {
    key: string;
    version: number;
    reason: "ttl" | "count" | "bytes";
  }): Promise<void> | void;
  /** Approx retained snapshot bytes for parked-slot accounting (optional). */
  approxBytes?: number;
}

interface QueueSlot {
  latest: DetachedAgentEndQueueJob;
  version: number;
  active: boolean;
  parked: boolean;
  /** Version that was parked (for wake coalescing). */
  parkedVersion: number;
  /** ready-pending: claimed pass returned more=true under budget. */
  readyPending: boolean;
  parkedAtMs: number;
  approxBytes: number;
}

interface QueueState {
  /** Keys waiting for a worker kick (FIFO, de-duplicated by presence in set). */
  wakeOrder: string[];
  wakeSet: Set<string>;
  slots: Map<string, QueueSlot>;
  activeWorkers: number;
  idleWaiters: Array<() => void>;
  /** Global cross-key concurrency ceiling (same-key still serial via active). */
  maxGlobalConcurrent: number;
  parkTtlMs: number;
  maxParkedSlots: number;
  maxParkedBytes: number;
  stats: {
    enqueued: number;
    coalesced: number;
    claimed: number;
    completed: number;
    errors: number;
    parked: number;
    wokeFromPark: number;
    readyFalse: number;
    readyPending: number;
    parkEvicted: number;
    maxConcurrent: number;
    concurrent: number;
  };
}

const QUEUE_STATE = Symbol.for("pi-astack/sediment/agent-end-queue/v2");
const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>;

/** Default global concurrent workers across distinct keys. */
export const DEFAULT_MAX_GLOBAL_CONCURRENT = 4;
/** Default parked-slot TTL (ms). */
export const DEFAULT_PARK_TTL_MS = 15 * 60 * 1000;
/** Default max number of parked keys retained. */
export const DEFAULT_MAX_PARKED_SLOTS = 32;
/** Default max retained parked snapshot bytes (approx). */
export const DEFAULT_MAX_PARKED_BYTES = 64 * 1024 * 1024;

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
    parkTtlMs: DEFAULT_PARK_TTL_MS,
    maxParkedSlots: DEFAULT_MAX_PARKED_SLOTS,
    maxParkedBytes: DEFAULT_MAX_PARKED_BYTES,
    stats: {
      enqueued: 0,
      coalesced: 0,
      claimed: 0,
      completed: 0,
      errors: 0,
      parked: 0,
      wokeFromPark: 0,
      readyFalse: 0,
      readyPending: 0,
      parkEvicted: 0,
      maxConcurrent: 0,
      concurrent: 0,
    },
  };
  host[QUEUE_STATE] = created;
  return created;
}

function settleIdleWaiters(state: QueueState): void {
  // Parked / ready-pending slots are idle from a worker perspective when no
  // wake is scheduled and no active worker is running.
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
    // The queue is the final rejection boundary. Audit/report failures cannot
    // become unhandled rejections or stop later session snapshots.
  }
}

async function reportNotReady(job: DetachedAgentEndQueueJob, version: number): Promise<void> {
  try {
    await job.onNotReady?.({ key: job.key, version });
  } catch {
    // Same final boundary as onError.
  }
}

async function reportParkEvicted(
  job: DetachedAgentEndQueueJob,
  version: number,
  reason: "ttl" | "count" | "bytes",
): Promise<void> {
  try {
    await job.onParkEvicted?.({ key: job.key, version, reason });
  } catch {
    // Same final boundary as onError.
  }
}

function parkedBytes(state: QueueState): number {
  let total = 0;
  for (const slot of state.slots.values()) {
    if (slot.parked) total += slot.approxBytes;
  }
  return total;
}

function parkedCount(state: QueueState): number {
  let n = 0;
  for (const slot of state.slots.values()) if (slot.parked) n += 1;
  return n;
}

/**
 * Evict parked slots that exceed TTL / count / bytes bounds.
 * Oldest parked first. Never touches active or ready-pending slots.
 */
function evictParkedIfNeeded(state: QueueState, nowMs: number = Date.now()): void {
  const parked: Array<{ key: string; slot: QueueSlot }> = [];
  for (const [key, slot] of state.slots) {
    if (!slot.parked || slot.active) continue;
    if (nowMs - slot.parkedAtMs > state.parkTtlMs) {
      state.slots.delete(key);
      state.stats.parkEvicted += 1;
      void reportParkEvicted(slot.latest, slot.parkedVersion || slot.version, "ttl");
      continue;
    }
    parked.push({ key, slot });
  }
  parked.sort((a, b) => a.slot.parkedAtMs - b.slot.parkedAtMs);

  while (parked.length > state.maxParkedSlots) {
    const victim = parked.shift()!;
    if (!state.slots.has(victim.key)) continue;
    state.slots.delete(victim.key);
    state.stats.parkEvicted += 1;
    void reportParkEvicted(victim.slot.latest, victim.slot.parkedVersion || victim.slot.version, "count");
  }

  let bytes = 0;
  for (const row of parked) bytes += row.slot.approxBytes;
  while (bytes > state.maxParkedBytes && parked.length > 0) {
    const victim = parked.shift()!;
    if (!state.slots.has(victim.key)) continue;
    bytes -= victim.slot.approxBytes;
    state.slots.delete(victim.key);
    state.stats.parkEvicted += 1;
    void reportParkEvicted(victim.slot.latest, victim.slot.parkedVersion || victim.slot.version, "bytes");
  }
}

function pump(state: QueueState): void {
  evictParkedIfNeeded(state);
  while (state.wakeOrder.length > 0 && state.activeWorkers < state.maxGlobalConcurrent) {
    const key = state.wakeOrder.shift()!;
    state.wakeSet.delete(key);
    const slot = state.slots.get(key);
    if (!slot || slot.active) continue;
    // Fire concurrent per-key workers; same key never overlaps (active guard).
    // Global cap bounds cross-key fan-out; resource locks still serialise writers.
    void runKey(state, key).catch(() => {
      // runKey contains per-job rejection boundaries and a finally that
      // restores queue state. This catch is process-level defense in depth.
    });
  }
  settleIdleWaiters(state);
}

async function runKey(state: QueueState, key: string): Promise<void> {
  const slot = state.slots.get(key);
  if (!slot || slot.active) return;

  slot.active = true;
  slot.parked = false;
  slot.readyPending = false;
  state.activeWorkers += 1;
  state.stats.concurrent += 1;
  state.stats.maxConcurrent = Math.max(state.stats.maxConcurrent, state.stats.concurrent);

  const gateJob = slot.latest;
  const gateVersion = slot.version;
  let claimedVersion = 0;
  let errorJob = gateJob;
  let parkedThisPass = false;
  let readyPendingThisPass = false;

  try {
    // Deliberately do not claim before this await. Any agent_end arriving
    // while canonical startup is pending replaces slot.latest and is
    // included once the gate opens (ready=true claim of latest).
    const ready = await gateJob.waitUntilReady();

    if (!ready) {
      state.stats.readyFalse += 1;
      if (slot.version > gateVersion) {
        // Newer snapshot arrived during the false-settling wait; retry it.
        // Do not park the superseded version.
      } else {
        parkedThisPass = true;
        slot.parked = true;
        slot.parkedVersion = gateVersion;
        slot.parkedAtMs = Date.now();
        slot.approxBytes = Math.max(0, gateJob.approxBytes ?? slot.approxBytes ?? 0);
        state.stats.parked += 1;
        await reportNotReady(gateJob, gateVersion);
        evictParkedIfNeeded(state);
      }
    } else {
      const claimed = slot.latest;
      claimedVersion = slot.version;
      errorJob = claimed;
      state.stats.claimed += 1;
      const result = await claimed.run();
      if (result && typeof result === "object" && result.more === true) {
        // Per-turn budget exhausted with frozen backlog remaining: keep the
        // slot as ready-pending and re-queue instead of deleting.
        readyPendingThisPass = true;
        slot.readyPending = true;
        state.stats.readyPending += 1;
      } else {
        state.stats.completed += 1;
      }
    }
  } catch (error) {
    // If the gate itself failed, consume only the snapshot whose gate was
    // attempted. A newer version that arrived during the await is requeued.
    if (claimedVersion === 0) claimedVersion = gateVersion;
    state.stats.errors += 1;
    await reportJobError(errorJob, error);
  } finally {
    slot.active = false;
    state.stats.concurrent = Math.max(0, state.stats.concurrent - 1);
    state.activeWorkers = Math.max(0, state.activeWorkers - 1);

    if (parkedThisPass && slot.version === gateVersion) {
      // Retain parked snapshot; no wake unless enqueue/wakeParked arrives.
      settleIdleWaiters(state);
      pump(state);
      return;
    }

    if (readyPendingThisPass && slot.version === claimedVersion) {
      // Budget exhausted with frozen backlog remaining: keep ready-pending
      // and yield to the next macro tick (never tight-spin in this finally).
      enqueueWake(state, key);
      setImmediate(() => pump(state));
      settleIdleWaiters(state);
      return;
    }

    if (slot.version > (claimedVersion || (parkedThisPass ? gateVersion : 0))) {
      // Newer work exists (including wake-from-park via version bump).
      if (slot.parked) {
        slot.parked = false;
        state.stats.wokeFromPark += 1;
      }
      slot.readyPending = false;
      enqueueWake(state, key);
      pump(state);
      return;
    }

    if (!slot.parked && !slot.readyPending) {
      state.slots.delete(key);
    }
    settleIdleWaiters(state);
    pump(state);
  }
}

/** Synchronous enqueue: safe to call directly from pi's awaited handler. */
export function enqueueDetachedAgentEnd(job: DetachedAgentEndQueueJob): void {
  const state = queueState();
  state.stats.enqueued += 1;
  const approxBytes = Math.max(0, job.approxBytes ?? 0);
  const existing = state.slots.get(job.key);
  if (existing) {
    existing.latest = job;
    existing.version += 1;
    existing.approxBytes = approxBytes;
    existing.readyPending = false;
    state.stats.coalesced += 1;
    if (existing.parked) {
      existing.parked = false;
      state.stats.wokeFromPark += 1;
      enqueueWake(state, job.key);
    } else if (!existing.active) {
      enqueueWake(state, job.key);
    }
    // If active, the worker's finally observes version > claimed and requeues.
  } else {
    state.slots.set(job.key, {
      latest: job,
      version: 1,
      active: false,
      parked: false,
      parkedVersion: 0,
      readyPending: false,
      parkedAtMs: 0,
      approxBytes,
    });
    enqueueWake(state, job.key);
  }
  pump(state);
}

/**
 * Explicit readiness wake for parked / ready-pending / active keys.
 * Used when an external readiness source flips without a fresh agent_end.
 * If `key` is omitted, wakes every currently retained key that needs it.
 *
 * Active (in-flight) windows ALWAYS version-bump on wake — independent of
 * parked/readyPending flags — so a gate that was false mid-claim is re-run
 * after finally, exactly once, without depending on those flags.
 */
export function wakeParkedDetachedAgentEnd(key?: string): number {
  const state = queueState();
  let woke = 0;
  const keys = key === undefined ? [...state.slots.keys()] : [key];
  for (const k of keys) {
    const slot = state.slots.get(k);
    if (!slot) continue;
    if (slot.active) {
      // Always bump active keys (do not gate on parked/readyPending). The
      // worker finally sees version > claimed and requeues once.
      slot.version += 1;
      slot.parked = false;
      slot.readyPending = false;
      state.stats.wokeFromPark += 1;
      woke += 1;
      continue;
    }
    if (!slot.parked && !slot.readyPending) continue;
    slot.parked = false;
    slot.readyPending = false;
    // Bump version so the worker treats this as fresh work against the
    // retained snapshot (same job object, re-checked readiness).
    slot.version += 1;
    state.stats.wokeFromPark += 1;
    enqueueWake(state, k);
    woke += 1;
  }
  if (woke > 0) pump(state);
  return woke;
}

export function waitForDetachedAgentEndQueueIdle(): Promise<void> {
  const state = queueState();
  if (state.activeWorkers === 0 && state.wakeOrder.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => state.idleWaiters.push(resolve));
}

export function detachedAgentEndQueueStats(): Readonly<QueueState["stats"]> & {
  pendingKeys: number;
  parkedKeys: number;
  readyPendingKeys: number;
  maxGlobalConcurrent: number;
  parkedBytes: number;
} {
  const state = queueState();
  let parkedKeys = 0;
  let readyPendingKeys = 0;
  for (const slot of state.slots.values()) {
    if (slot.parked) parkedKeys += 1;
    if (slot.readyPending) readyPendingKeys += 1;
  }
  return Object.freeze({
    ...state.stats,
    pendingKeys: state.slots.size,
    parkedKeys,
    readyPendingKeys,
    maxGlobalConcurrent: state.maxGlobalConcurrent,
    parkedBytes: parkedBytes(state),
  });
}

/** Test-only: override global concurrency / park bounds. */
export function configureDetachedAgentEndQueueForTests(options: {
  maxGlobalConcurrent?: number;
  parkTtlMs?: number;
  maxParkedSlots?: number;
  maxParkedBytes?: number;
}): void {
  const state = queueState();
  if (options.maxGlobalConcurrent !== undefined) {
    state.maxGlobalConcurrent = Math.max(1, Math.floor(options.maxGlobalConcurrent));
  }
  if (options.parkTtlMs !== undefined) {
    state.parkTtlMs = Math.max(1, Math.floor(options.parkTtlMs));
  }
  if (options.maxParkedSlots !== undefined) {
    state.maxParkedSlots = Math.max(1, Math.floor(options.maxParkedSlots));
  }
  if (options.maxParkedBytes !== undefined) {
    state.maxParkedBytes = Math.max(1, Math.floor(options.maxParkedBytes));
  }
}

/** Test-only: force park-eviction sweep with a synthetic clock. */
export function sweepParkedDetachedAgentEndForTests(nowMs?: number): void {
  const state = queueState();
  evictParkedIfNeeded(state, nowMs ?? Date.now());
  settleIdleWaiters(state);
}

/** Test-only reset. Safe when no active workers / pending wakes. Clears parked. */
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
  state.parkTtlMs = DEFAULT_PARK_TTL_MS;
  state.maxParkedSlots = DEFAULT_MAX_PARKED_SLOTS;
  state.maxParkedBytes = DEFAULT_MAX_PARKED_BYTES;
  state.stats = {
    enqueued: 0,
    coalesced: 0,
    claimed: 0,
    completed: 0,
    errors: 0,
    parked: 0,
    wokeFromPark: 0,
    readyFalse: 0,
    readyPending: 0,
    parkEvicted: 0,
    maxConcurrent: 0,
    concurrent: 0,
  };
}
