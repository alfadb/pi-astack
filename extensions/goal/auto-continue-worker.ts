import {
  runAutoContinueOnce,
  type AutoContinueAction,
  type ContinuationPrechargeRestoreRequest,
  type ContinuationPrechargeRestoreResult,
} from "./continue";
import {
  deliverGoalContinuation,
  getGoalSessionRuntime,
  getGoalSessionRuntimeEpoch,
  hasActiveGoalContinuationDelivery,
} from "./delivery";
import { runGoalJudge, type GoalJudgeInput } from "./judge";
import {
  appendGoalAutoContinueAudit,
  appendGoalOutcome,
  GOAL_EVENT_TYPE,
  loadGoalFile,
  saveGoalFile,
  saveGoalFileIfCurrent,
  type GoalState,
} from "./state";

export interface GoalAutoContinueSnapshot {
  sessionId: string;
  cwd: string;
  runtimeEpoch: number;
  capturedAt: string;
  dedupeKey: string;
  triggerAborted: boolean;
  skipReason?: string;
  pendingContinuationAtTrigger: boolean;
  pendingContinuationStaleMs: number;
  state: GoalState;
  judgeInput: GoalJudgeInput;
  judgeModel: string;
  judgeTimeoutMs: number;
  goalDocError?: string;
  /** Test seam; production uses delivery.ts default. */
  continuationAckTimeoutMs?: number;
}

export interface GoalAutoContinueSnapshotResult {
  action: AutoContinueAction | "stopped_on_abort" | "stale_snapshot" | "pending_continuation" | "runtime_stale" | "doc_unreadable";
  detail?: string;
}

function audit(snapshot: GoalAutoContinueSnapshot, row: Record<string, unknown>): void {
  appendGoalAutoContinueAudit(snapshot.cwd, {
    type: "goal_auto_continue",
    operation: "detached_pass",
    ts: new Date().toISOString(),
    session_id: snapshot.sessionId,
    goal_id: snapshot.state.goal_id,
    snapshot_dedupe_key: snapshot.dedupeKey,
    captured_at: snapshot.capturedAt,
    ...row,
  });
}

function stateMatchesSnapshot(current: GoalState | null, snapshot: GoalAutoContinueSnapshot): current is GoalState {
  return !!current
    && current.goal_id === snapshot.state.goal_id
    && current.status === "active"
    && current.counters.continuations_used === snapshot.state.counters.continuations_used;
}

function currentRuntime(snapshot: GoalAutoContinueSnapshot, signal: AbortSignal) {
  if (signal.aborted) return undefined;
  return getGoalSessionRuntime(snapshot.sessionId, snapshot.runtimeEpoch);
}

async function stopAbortedTrigger(snapshot: GoalAutoContinueSnapshot, signal: AbortSignal): Promise<GoalAutoContinueSnapshotResult> {
  const current = loadGoalFile(snapshot.cwd, snapshot.sessionId);
  if (!stateMatchesSnapshot(current, snapshot)) {
    audit(snapshot, { outcome: "stale_snapshot", phase: "trigger_abort" });
    return { action: "stale_snapshot" };
  }
  const runtime = currentRuntime(snapshot, signal);
  if (!runtime) {
    audit(snapshot, { outcome: "runtime_stale", phase: "trigger_abort" });
    return { action: "runtime_stale" };
  }
  const stopped: GoalState = {
    ...current,
    status: "paused",
    status_note: "stopped: user abort/ESC",
    updated: new Date().toISOString(),
  };
  try {
    runtime.appendEntry(GOAL_EVENT_TYPE, { action: "stop", state: stopped });
  } catch (error) {
    audit(snapshot, {
      outcome: "stop_event_append_failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    return { action: "runtime_stale", detail: "stop_event_append_failed" };
  }
  const saved = await saveGoalFile(snapshot.cwd, stopped);
  audit(snapshot, { outcome: saved ? "stopped_on_abort" : "stop_view_write_failed" });
  return { action: "stopped_on_abort", ...(saved ? {} : { detail: "stop_view_write_failed" }) };
}

async function pauseUnreadableDoc(snapshot: GoalAutoContinueSnapshot, signal: AbortSignal): Promise<GoalAutoContinueSnapshotResult> {
  const current = loadGoalFile(snapshot.cwd, snapshot.sessionId);
  if (!stateMatchesSnapshot(current, snapshot)) return { action: "stale_snapshot" };
  const runtime = currentRuntime(snapshot, signal);
  if (!runtime) return { action: "runtime_stale" };
  const paused: GoalState = {
    ...current,
    status: "paused",
    status_note: `goal doc unreadable: ${snapshot.goalDocError}`,
    updated: new Date().toISOString(),
  };
  try {
    runtime.appendEntry(GOAL_EVENT_TYPE, { action: "pause", state: paused });
  } catch (error) {
    audit(snapshot, {
      outcome: "doc_pause_event_append_failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    return { action: "runtime_stale", detail: "doc_pause_event_append_failed" };
  }
  const saved = await saveGoalFile(snapshot.cwd, paused);
  audit(snapshot, { outcome: saved ? "doc_unreadable" : "doc_pause_view_write_failed", error: snapshot.goalDocError });
  return { action: "doc_unreadable", detail: snapshot.goalDocError };
}

export interface GoalContinuationPrechargeRestoreArgs extends ContinuationPrechargeRestoreRequest {
  cwd: string;
  sessionId: string;
  goalId: string;
}

/** Append an immutable compensating event, then CAS the materialized view.
 * The event itself also carries the expected state so replay performs the
 * same compare-and-swap after reload. A newer runtime epoch is acceptable:
 * recovery is state-CAS guarded and must survive extension reload cancellation. */
export async function restoreGoalContinuationPrecharge(
  args: GoalContinuationPrechargeRestoreArgs,
): Promise<ContinuationPrechargeRestoreResult> {
  const prechargeId = `${args.sessionId}:${args.goalId}:${args.expectedState.counters.continuations_used}`;
  const base = {
    type: "goal_auto_continue",
    operation: "continuation_budget_restore",
    session_id: args.sessionId,
    goal_id: args.goalId,
    precharge_id: prechargeId,
    delivery_id: args.deliveryId,
    phase: args.phase,
    reason: args.detail.slice(0, 500),
    send_attempted: false,
  };
  const epoch = getGoalSessionRuntimeEpoch(args.sessionId);
  const runtime = epoch === undefined ? undefined : getGoalSessionRuntime(args.sessionId, epoch);
  if (!runtime) {
    appendGoalAutoContinueAudit(args.cwd, {
      ...base,
      outcome: "restore_runtime_unavailable",
      ts: new Date().toISOString(),
    });
    return { restored: false, detail: "restore_runtime_unavailable" };
  }

  try {
    runtime.appendEntry(GOAL_EVENT_TYPE, {
      action: "continuation_restore",
      state: args.restoredState,
      cas_expected: args.expectedState,
      precharge_id: prechargeId,
      ...(args.deliveryId ? { delivery_id: args.deliveryId } : {}),
      reason: args.detail.slice(0, 500),
      phase: args.phase,
      send_attempted: false,
      ts: new Date().toISOString(),
    });
  } catch (error) {
    appendGoalAutoContinueAudit(args.cwd, {
      ...base,
      outcome: "restore_event_append_failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      ts: new Date().toISOString(),
    });
    return { restored: false, detail: "restore_event_append_failed" };
  }

  const cas = await saveGoalFileIfCurrent(args.cwd, args.expectedState, args.restoredState);
  const outcome = cas === "saved" ? "restore_applied" : cas === "mismatch" ? "restore_cas_mismatch" : "restore_view_write_failed";
  appendGoalAutoContinueAudit(args.cwd, {
    ...base,
    outcome,
    cas_result: cas,
    restored_continuations_used: args.restoredState.counters.continuations_used,
    ts: new Date().toISOString(),
  });
  return { restored: cas === "saved", detail: outcome };
}

/** Run one immutable trigger snapshot outside pi's awaited lifecycle chain. */
export async function runGoalAutoContinueSnapshot(
  snapshot: GoalAutoContinueSnapshot,
  signal: AbortSignal,
): Promise<GoalAutoContinueSnapshotResult> {
  if (snapshot.triggerAborted) return stopAbortedTrigger(snapshot, signal);
  if (snapshot.skipReason) {
    audit(snapshot, { outcome: "skipped", reason: snapshot.skipReason });
    return { action: "stale_snapshot", detail: snapshot.skipReason };
  }
  if (signal.aborted) {
    audit(snapshot, { outcome: "cancelled_before_start" });
    return { action: "runtime_stale", detail: "cancelled" };
  }
  if (!getGoalSessionRuntime(snapshot.sessionId, snapshot.runtimeEpoch)) {
    audit(snapshot, { outcome: "runtime_stale", phase: "entry" });
    return { action: "runtime_stale" };
  }

  const latest = loadGoalFile(snapshot.cwd, snapshot.sessionId);
  if (!stateMatchesSnapshot(latest, snapshot)) {
    audit(snapshot, { outcome: "stale_snapshot", phase: "entry" });
    return { action: "stale_snapshot" };
  }
  if (snapshot.pendingContinuationAtTrigger || hasActiveGoalContinuationDelivery(snapshot.sessionId, snapshot.state.goal_id)) {
    audit(snapshot, { outcome: "pending_continuation", pending_stale_ms: snapshot.pendingContinuationStaleMs });
    return { action: "pending_continuation" };
  }
  if (snapshot.goalDocError) return pauseUnreadableDoc(snapshot, signal);

  const result = await runAutoContinueOnce({
    state: snapshot.state,
    judge: () => {
      const runtime = currentRuntime(snapshot, signal);
      if (!runtime) {
        return Promise.resolve({
          ok: false,
          model: snapshot.judgeModel,
          error: signal.aborted ? "judge_cancelled" : "runtime_stale",
          durationMs: 0,
        });
      }
      return runGoalJudge(snapshot.judgeInput, {
        judgeModel: snapshot.judgeModel,
        judgeTimeoutMs: snapshot.judgeTimeoutMs,
        modelRegistry: runtime.modelRegistry,
        signal,
      });
    },
    sendContinuation: async (message) => {
      const delivery = await deliverGoalContinuation({
        cwd: snapshot.cwd,
        sessionId: snapshot.sessionId,
        runtimeEpoch: snapshot.runtimeEpoch,
        goalId: snapshot.state.goal_id,
        expectedContinuationsUsed: snapshot.state.counters.continuations_used + 1,
        message,
        signal,
        ...(snapshot.continuationAckTimeoutMs !== undefined
          ? { ackTimeoutMs: snapshot.continuationAckTimeoutMs }
          : {}),
      });
      return delivery.status === "acknowledged"
        ? {
          acknowledged: true,
          detail: delivery.deliveryId,
          sendAttempted: delivery.sendAttempted,
          phase: delivery.phase,
          deliveryId: delivery.deliveryId,
        }
        : {
          acknowledged: false,
          detail: delivery.reason,
          sendAttempted: delivery.sendAttempted,
          phase: delivery.phase,
          deliveryId: delivery.deliveryId,
        };
    },
    isStillActive: async (expected) => {
      if (!currentRuntime(snapshot, signal)) return false;
      const current = loadGoalFile(snapshot.cwd, snapshot.sessionId);
      return !!current
        && current.goal_id === expected.goal_id
        && current.status === "active"
        && current.counters.continuations_used === expected.counters.continuations_used;
    },
    restorePrecharge: (request) => restoreGoalContinuationPrecharge({
      cwd: snapshot.cwd,
      sessionId: snapshot.sessionId,
      goalId: snapshot.state.goal_id,
      ...request,
    }),
    notify: () => {
      // Detached jobs intentionally do not retain or call a live UI surface.
    },
    appendEvent: (action, state, metadata) => {
      const runtime = currentRuntime(snapshot, signal);
      if (!runtime) return false;
      try {
        runtime.appendEntry(GOAL_EVENT_TYPE, { action, state, ...metadata });
        return true;
      } catch {
        return false;
      }
    },
    saveState: async (state) => {
      if (!currentRuntime(snapshot, signal)) return false;
      return saveGoalFile(snapshot.cwd, state);
    },
    appendOutcome: (row) => {
      appendGoalOutcome(snapshot.cwd, row as unknown as Record<string, unknown>);
    },
  });

  audit(snapshot, {
    outcome: result.action,
    ...(result.detail ? { detail: result.detail.slice(0, 500) } : {}),
    ...(result.send_attempted !== undefined ? { send_attempted: result.send_attempted } : {}),
    ...(result.phase ? { phase: result.phase } : {}),
    ...(result.budget_restored !== undefined ? { budget_restored: result.budget_restored } : {}),
    ...(result.restore_detail ? { restore_detail: result.restore_detail } : {}),
    ...(result.delivery_id ? { delivery_id: result.delivery_id } : {}),
  });
  return result;
}
