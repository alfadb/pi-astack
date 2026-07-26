/**
 * AsyncLocalStorage-scoped checkpoint session id override for daemon worker.
 *
 * Worker passes pin `daemon-worker:<sha256(source session)>` without a process
 * global save/restore. Detached promises inherit the ALS store; nested/concurrent
 * contexts do not clobber each other. Foreground paths never enter the store →
 * load/save use the provenance sessionId unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const checkpointSessionALS = new AsyncLocalStorage<string>();

/** Run `fn` with an effective checkpoint session id for the async tree. */
export function runWithCheckpointSessionIdOverride<T>(sessionId: string, fn: () => T): T {
  return checkpointSessionALS.run(sessionId, fn);
}

/** Current ALS override, if any. */
export function getCheckpointSessionIdOverride(): string | undefined {
  return checkpointSessionALS.getStore();
}

/** Effective checkpoint session id: ALS override, else the provenance sessionId. */
export function effectiveCheckpointSessionId(sessionId: string | undefined): string | undefined {
  return checkpointSessionALS.getStore() ?? sessionId;
}
