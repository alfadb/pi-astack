/**
 * Optional AsyncLocalStorage budget context for daemon-owned sediment worker.
 *
 * When set, model/embedding/git singleflight paths may clamp timeouts to the
 * remaining absolute deadline. Ordinary foreground paths never enter this ALS,
 * so defaults (e.g. 1200s settings) stay unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkerBudgetContext {
  /** Absolute wall-clock deadline (same domain as `now`). */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

const workerBudgetALS = new AsyncLocalStorage<WorkerBudgetContext>();

export function runWithWorkerBudget<T>(ctx: WorkerBudgetContext, fn: () => T): T {
  return workerBudgetALS.run(ctx, fn);
}

/**
 * Run fn outside any worker budget ALS store.
 * Detached timers / free-floating promises must use this so a settled worker
 * task cannot leave a permanently-expired budget context on later work.
 */
export function runOutsideWorkerBudget<T>(fn: () => T): T {
  return workerBudgetALS.exit(fn);
}

export function getWorkerBudgetContext(): WorkerBudgetContext | undefined {
  return workerBudgetALS.getStore();
}

/**
 * Clamp a configured startup/busy budget to remaining worker soft deadline.
 * Outside worker budget ALS: returns configured value unchanged.
 * When remaining is 0, returns 0 so callers can cooperative-defer immediately.
 */
export function clampStartupBudgetToWorker(configuredMs: number, now: number = Date.now()): number {
  const remaining = remainingWorkerBudgetMs(now);
  if (remaining === undefined) return configuredMs;
  return Math.max(0, Math.min(configuredMs, remaining));
}

/** Remaining ms under worker budget, or undefined when not in worker budget scope. */
export function remainingWorkerBudgetMs(now: number = Date.now()): number | undefined {
  const ctx = workerBudgetALS.getStore();
  if (!ctx) return undefined;
  const clock = ctx.now ?? (() => now);
  return Math.max(0, ctx.deadlineMs - clock());
}

/**
 * Clamp a configured timeout to remaining worker budget when present.
 * Outside worker budget ALS: returns configured value unchanged.
 */
export function clampToWorkerBudget(timeoutMs: number, now: number = Date.now()): number {
  const remaining = remainingWorkerBudgetMs(now);
  if (remaining === undefined) return timeoutMs;
  return Math.max(1, Math.min(timeoutMs, remaining));
}

export function workerBudgetDeadlineMs(): number | undefined {
  return workerBudgetALS.getStore()?.deadlineMs;
}

export function workerBudgetSignal(): AbortSignal | undefined {
  return workerBudgetALS.getStore()?.signal;
}

export function workerBudgetNow(): () => number {
  return workerBudgetALS.getStore()?.now ?? Date.now;
}

/**
 * Throw a closed `stage_deadline` error when worker budget ALS is expired or
 * aborted. No-op outside worker budget scope (foreground unchanged).
 */
export function assertWorkerBudgetNotExpired(label?: string): void {
  const ctx = workerBudgetALS.getStore();
  if (!ctx) return;
  const now = ctx.now ?? Date.now;
  if (ctx.signal?.aborted || now() >= ctx.deadlineMs) {
    const err = new Error(label ? `stage_deadline:${label}` : "stage_deadline");
    (err as { code?: string }).code = "stage_deadline";
    throw err;
  }
}
