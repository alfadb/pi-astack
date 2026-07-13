/**
 * Pending `prompt_user` lifecycle manager (ADR 0022 P2).
 *
 * Maintains a single global `Map<promptId, PendingPrompt>` so that:
 *
 *   - INV-I (concurrent ≤ 1): handler asks `getPendingPromptCount()` and
 *     rejects schema-invalid with `detail:"another prompt is pending"`
 *     when the count is already 1.
 *
 *   - Explicit termination: every pending entry listens for
 *     `ctx.signal` abort and can be drained by `cancelAllPending(reason)`
 *     from the session_shutdown finalizer. User submit / Cancel / Esc
 *     resolves through the service. With no such event, the prompt stays
 *     pending indefinitely.
 *
 *     All terminal paths converge on the same `resolveOnce(result)` so
 *     the consumer never sees a double-resolve and signal listeners are
 *     torn down deterministically.
 *
 *   - INV-K (compaction defer): `compaction-tuner` queries
 *     `getPendingPromptCount()` at `agent_end` to decide whether to
 *     skip this round of compaction.
 *
 * Why module-global (not per-extension-activation singleton):
 * pi runs one extension activation per session; the manager lives in
 * the same process. A module-level Map matches lifetime exactly. If
 * pi ever migrates to multi-session-per-process, the manager API
 * gains a `session` key — but P0 keeps it flat.
 */

import type { PromptUserFailureReason, PromptUserResult } from "./types";

// ── Internal types ──────────────────────────────────────────────────

interface PendingPrompt {
  id: string;
  startedAt: number;
  /** AbortController used to propagate cancellation to the UI overlay
   * and any awaited primitive inside the service layer. */
  abortController: AbortController;
  /** Cleared once `resolveOnce` runs. Idempotent: subsequent calls
   * no-op. */
  resolveOnce: (result: PromptUserResult) => void;
  /** Disposers torn down by `resolveOnce`. They include the upstream
   * signal listener and (when wired) the overlay's `handle.close()`. */
  disposers: Array<() => void>;
}

// ── Module state (single-process) ───────────────────────────────────

const pending = new Map<string, PendingPrompt>();
let nextId = 1;

function genId(): string {
  // ts-prefixed monotonic id; collisions impossible in single process.
  return `pu_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Snapshot count of currently-pending prompts.
 *
 * Used by:
 *   - INV-I gate in handler.ts (rejects when >= 1 before starting)
 *   - INV-K guard in compaction-tuner (skips when > 0)
 *   - smoke fixtures to assert post-cancel cleanup
 *
 * Cheap: O(1) Map size.
 */
export function getPendingPromptCount(): number {
  return pending.size;
}

/**
 * Lightweight read-only snapshot for diagnostics (smoke, /abrain status).
 * Never expose `abortController` or `resolveOnce` to outsiders.
 */
export function snapshotPending(): Array<{
  id: string;
  ageMs: number;
}> {
  const now = Date.now();
  return Array.from(pending.values()).map((p) => ({
    id: p.id,
    ageMs: now - p.startedAt,
  }));
}

/**
 * Register a new pending prompt and return the controlled handle.
 *
 * Caller (service.ts) is responsible for:
 *   - kicking off the UI overlay and pumping its `done(answer)` into
 *     `resolve({ ok: true, ... })`
 *   - registering the overlay's `handle.close` via
 *     `registerDisposer` so abort / shutdown also tears down the UI
 *
 * Returns:
 *   - `promise`: resolved exactly once (multiple resolve attempts after
 *     the first are no-ops).
 *   - `resolve(result)`: success path the caller uses.
 *   - `signal`: AbortSignal that fires when any of the cancel sources
 *     trip. Pass this to the overlay so it tears down on shutdown.
 *   - `id`: unique identifier (also used as the audit event id).
 *   - `registerDisposer(fn)`: register a teardown step (for example,
 *     overlay close) that runs after any terminal resolution.
 *
 * The function wires the upstream signal (`opts.upstreamSignal`) to a
 * `cancelled` result. Its listener tears down via `disposers` so the
 * global state stays clean.
 */
export interface AcquireOptions {
  upstreamSignal?: AbortSignal;
}

export interface AcquireHandle {
  id: string;
  signal: AbortSignal;
  promise: Promise<PromptUserResult>;
  resolve: (result: PromptUserResult) => void;
  registerDisposer: (fn: () => void) => void;
}

export function acquirePending(opts: AcquireOptions = {}): AcquireHandle {
  const id = genId();
  const startedAt = Date.now();
  const abortController = new AbortController();
  let settled = false;

  let resolvePromise!: (r: PromptUserResult) => void;
  const promise = new Promise<PromptUserResult>((res) => {
    resolvePromise = res;
  });

  const resolveOnce = (result: PromptUserResult): void => {
    if (settled) return;
    settled = true;
    // 1. Pop from the global map FIRST. Even if a disposer throws, the
    //    INV-I invariant ("count goes back to 0") still holds.
    pending.delete(id);
    // 2. Best-effort fire abortController so the overlay tears down.
    //    `abortController.abort()` is idempotent.
    try { abortController.abort(); } catch {}
    // 3. Run all disposers, swallowing throws individually so one bad
    //    disposer can't strand the others.
    for (const d of entry.disposers) {
      try { d(); } catch {}
    }
    entry.disposers.length = 0;
    // 4. Resolve the awaiter LAST. By the time the caller observes a
    //    result, `getPendingPromptCount()` already reflects the new
    //    state — important for smoke tests asserting count drains.
    resolvePromise(result);
  };

  const entry: PendingPrompt = {
    id,
    startedAt,
    abortController,
    resolveOnce,
    disposers: [],
  };
  pending.set(id, entry);

  // Wire upstream signal (ctx.signal). If it fires we resolve with
  // `cancelled`. If the upstream is already aborted we resolve on the
  // next microtask — never synchronously, so the caller always observes
  // an awaitable promise first.
  if (opts.upstreamSignal) {
    const onAbort = () => {
      resolveOnce({
        ok: false,
        reason: "cancelled",
        durationMs: Date.now() - startedAt,
      });
    };
    if (opts.upstreamSignal.aborted) {
      queueMicrotask(onAbort);
    } else {
      opts.upstreamSignal.addEventListener("abort", onAbort, { once: true });
      entry.disposers.push(() =>
        opts.upstreamSignal?.removeEventListener("abort", onAbort),
      );
    }
  }

  return {
    id,
    signal: abortController.signal,
    promise,
    resolve: resolveOnce,
    registerDisposer: (fn) => {
      // If already settled, just run it inline — caller may register late.
      if (settled) {
        try { fn(); } catch {}
        return;
      }
      entry.disposers.push(fn);
    },
  };
}

/**
 * Resolve every pending prompt with `{ ok:false, reason }`.
 *
 * Invoked by:
 *   - `session_shutdown` event (reason="cancelled")
 *   - `/abrain` teardown paths
 *   - smoke fixtures asserting INV-B (no pending-forever)
 *
 * Idempotent: calling on an empty pending map is a no-op. The returned
 * count is the number of prompts that were actually cancelled (useful
 * for audit logging at the call site).
 */
export function cancelAllPending(
  reason: PromptUserFailureReason = "cancelled",
): number {
  if (pending.size === 0) return 0;
  // Snapshot first — iterating while mutating is fine for Map but
  // confusing to read. Snapshot is O(n) but n ≤ 1 in practice (INV-I).
  const snapshot = Array.from(pending.values());
  for (const entry of snapshot) {
    entry.resolveOnce({
      ok: false,
      reason,
      durationMs: Date.now() - entry.startedAt,
    });
  }
  return snapshot.length;
}

/**
 * TEST-ONLY: drop all pending state without resolving. Smoke uses this
 * to reset between fixtures. NEVER call from production code — leaks
 * promises and skips audit.
 */
export function __resetForTests(): void {
  for (const entry of pending.values()) {
    try { entry.abortController.abort(); } catch {}
    entry.disposers.length = 0;
  }
  pending.clear();
  nextId = 1;
}
