/**
 * goal auto-continue orchestrator (PR-7 / P1b) — the STRUCTURED layer.
 * Everything with teeth is deterministic code here; the LLM judge only
 * supplies the {achieved, blocked, continue} verdict (judge.ts).
 *
 * Hard constraints (impl-plan §P1, in order of execution):
 *   1. Budgets are checked BEFORE the judge runs (no LLM spend once
 *      exhausted) and the counter is PRE-DECREMENTED — event + view
 *      persisted — BEFORE the continuation message is sent. The
 *      continuation turn re-enters agent_end by design; pre-decrement is
 *      what makes the loop bounded instead of self-amplifying.
 *   2. Budget exhaustion / blocked → the goal is PAUSED (not abandoned):
 *      stops both continuation AND further judge spend, user resumes via
 *      /goal resume after raising budget / unblocking. Tell-not-ask:
 *      notify, never a modal prompt from a background hook.
 *   3. Judge failure (transport/parse) → fail-closed: NO continuation,
 *      no state change, notify. Next agent_end may retry.
 *   4. R4' anti-write-only-loop: terminal outcomes (achieved / blocked /
 *      budget_exhausted — and abandoned via /goal clear in index.ts) are
 *      appended to .pi-astack/goal/outcome-ledger.jsonl so the goal
 *      loop's results are observable, not write-only. (Feeding this
 *      ledger into sediment's aggregator is a deliberate NON-goal here:
 *      cross-module writes into outcome-ledger.jsonl would violate its
 *      OutcomeRow schema/dedupe contract — a future aggregator feed can
 *      READ this file instead.)
 *
 * All side effects are injected so the smoke can drive the full decision
 * table without an extension host or LLM.
 */

import { formatGoalContinuationMessage } from "../_shared/goal-continuation";
import type { GoalContinuationDeliveryPhase } from "./delivery";
import type { GoalJudgeResult } from "./judge";
import type { GoalState } from "./state";

export type AutoContinueAction =
  | "skipped_inactive"
  | "budget_exhausted"
  | "wall_clock_exhausted"
  | "judge_failed"
  | "achieved"
  | "blocked_paused"
  | "stopped_before_send"
  | "delivery_unconfirmed"
  | "continued";

export interface GoalOutcomeRow {
  type: "goal_outcome";
  goal_id: string;
  session_id: string;
  outcome: "achieved" | "blocked" | "abandoned" | "budget_exhausted" | "wall_clock_exhausted";
  objective: string;
  continuations_used: number;
  reason?: string;
  ts: string;
}

export type AutoContinuePreSendPhase = GoalContinuationDeliveryPhase | "budget_persist" | "pre_send_gate";

export interface ContinuationPrechargeRestoreRequest {
  expectedState: GoalState;
  restoredState: GoalState;
  detail: string;
  phase: AutoContinuePreSendPhase;
  deliveryId?: string;
}

export interface ContinuationPrechargeRestoreResult {
  restored: boolean;
  detail: string;
}

export interface AutoContinueResult {
  action: AutoContinueAction;
  detail?: string;
  send_attempted?: boolean;
  phase?: AutoContinuePreSendPhase;
  budget_restored?: boolean;
  restore_detail?: string;
  delivery_id?: string;
}

export interface AutoContinueDeps {
  state: GoalState;
  now?: Date;
  /** Cognitive layer (wraps runGoalJudge; injectable for smoke). */
  judge: () => Promise<GoalJudgeResult>;
  /** Attempts one continuation delivery and resolves only after an observable
   *  message acknowledgement or an audited terminal failure/timeout. */
  sendContinuation: (message: string) => Promise<{
    acknowledged: boolean;
    detail: string;
    sendAttempted?: boolean;
    phase?: GoalContinuationDeliveryPhase;
    deliveryId?: string;
  }>;
  /** Last-chance gate after budget pre-decrement: lets /goal stop win before send. */
  isStillActive?: (state: GoalState) => boolean | Promise<boolean>;
  /** Appends a compensating CAS event and restores the view only if it still
   * exactly equals this pass's precharge. Omission fails closed (no rollback). */
  restorePrecharge?: (request: ContinuationPrechargeRestoreRequest) => Promise<ContinuationPrechargeRestoreResult>;
  notify: (msg: string, type?: string) => void;
  /** Event-first persistence pair (same contract as the /goal commands). */
  appendEvent: (action: string, state: GoalState, metadata?: Record<string, unknown>) => boolean;
  saveState: (state: GoalState) => Promise<boolean>;
  appendOutcome: (row: GoalOutcomeRow) => void;
}

function outcomeRow(state: GoalState, outcome: GoalOutcomeRow["outcome"], reason: string | undefined, now: Date): GoalOutcomeRow {
  return {
    type: "goal_outcome",
    goal_id: state.goal_id,
    session_id: state.session_id,
    outcome,
    objective: state.objective.slice(0, 200),
    continuations_used: state.counters.continuations_used,
    ...(reason ? { reason: reason.slice(0, 300) } : {}),
    ts: now.toISOString(),
  };
}

/** One agent_end pass of the auto-continue loop. Caller guarantees:
 *  autoContinue enabled, persisted session, not a sub-agent, state loaded. */
export async function runAutoContinueOnce(deps: AutoContinueDeps): Promise<AutoContinueResult> {
  const now = deps.now ?? new Date();
  const state = deps.state;
  if (state.status !== "active") return { action: "skipped_inactive" };

  const pauseWith = async (
    action: "budget_exhausted" | "wall_clock_exhausted" | "blocked_paused",
    outcome: GoalOutcomeRow["outcome"],
    note: string,
  ): Promise<{ action: AutoContinueAction; detail: string }> => {
    const paused: GoalState = { ...state, status: "paused", status_note: note, updated: now.toISOString() };
    deps.appendEvent("auto-pause", paused);
    const ok = await deps.saveState(paused);
    // opus R1 N2: a failed persist leaves the view active → the next turn
    // re-runs this pass (re-judging / duplicate outcome rows). Not unbounded
    // (pause never sends), but must be visible, not silent.
    if (!ok) deps.notify("goal auto-pause persist FAILED — may repeat next turn", "warning");
    deps.appendOutcome(outcomeRow(paused, outcome, note, now));
    return { action, detail: note };
  };

  // ── structured boundaries BEFORE any LLM spend ──
  const elapsedMin = (now.getTime() - Date.parse(state.created)) / 60_000;
  if (Number.isFinite(elapsedMin) && elapsedMin > state.budget.max_wall_minutes) {
    const r = await pauseWith("wall_clock_exhausted", "wall_clock_exhausted", `wall clock budget exhausted (${Math.floor(elapsedMin)}min > ${state.budget.max_wall_minutes}min)`);
    deps.notify(`⏱️ goal paused: ${r.detail} — raise the cap with a fresh /goal set --max-minutes=N (resume alone keeps the exhausted clock)`, "warning");
    return r;
  }
  if (state.counters.continuations_used >= state.budget.max_continuations) {
    const r = await pauseWith("budget_exhausted", "budget_exhausted", `continuation budget exhausted (${state.counters.continuations_used}/${state.budget.max_continuations})`);
    deps.notify(`🧯 goal paused: ${r.detail} — /goal resume after review, or a fresh /goal set with a higher --max-continuations`, "warning");
    return r;
  }

  // ── cognitive layer ──
  const judged = await deps.judge();
  if (!judged.ok || !judged.decision) {
    // Fail-closed: NO continuation on a missing/malformed verdict; state
    // untouched so the next agent_end retries with fresh context.
    deps.notify(`goal judge unavailable (${judged.error ?? "unknown"}) — no auto-continue this turn`, "warning");
    return { action: "judge_failed", detail: judged.error };
  }
  const d = judged.decision;

  // The judge is the longest await in this pass. Re-check before ANY verdict
  // side effect so a user pause/stop, goal replacement, reload, or tree switch
  // that happened while judging cannot be overwritten by this stale snapshot.
  if (deps.isStillActive && !(await deps.isStillActive(state))) {
    deps.notify("goal auto-continue stopped after judge: goal state changed", "info");
    return { action: "stopped_before_send", detail: "stale_after_judge" };
  }

  if (d.verdict === "achieved") {
    const achieved: GoalState = { ...state, status: "achieved", status_note: d.reason.slice(0, 300), updated: now.toISOString() };
    deps.appendEvent("achieved", achieved);
    const ok = await deps.saveState(achieved);
    if (!ok) deps.notify("goal achieved-state persist FAILED — may re-judge next turn", "warning"); // opus R1 N2
    deps.appendOutcome(outcomeRow(achieved, "achieved", d.reason, now));
    deps.notify(`🎉 goal achieved: ${state.objective.slice(0, 80)} — ${d.reason.slice(0, 120)}`, "info");
    return { action: "achieved", detail: d.reason };
  }

  if (d.verdict === "blocked") {
    const r = await pauseWith("blocked_paused", "blocked", `blocked: ${d.reason.slice(0, 280)}`);
    deps.notify(`🚧 goal paused (blocked): ${d.reason.slice(0, 160)} — resolve, then /goal resume`, "warning");
    return r;
  }

  // continue — PRE-DECREMENT before sending (hard constraint 1).
  const next: GoalState = {
    ...state,
    counters: { ...state.counters, continuations_used: state.counters.continuations_used + 1 },
    updated: now.toISOString(),
  };
  const prechargeId = `${state.session_id}:${state.goal_id}:${next.counters.continuations_used}`;
  const restore = async (
    detail: string,
    phase: AutoContinuePreSendPhase,
    deliveryId?: string,
  ): Promise<ContinuationPrechargeRestoreResult> => {
    if (!deps.restorePrecharge) return { restored: false, detail: "restore_unavailable" };
    try {
      return await deps.restorePrecharge({
        expectedState: next,
        restoredState: state,
        detail,
        phase,
        ...(deliveryId ? { deliveryId } : {}),
      });
    } catch (error) {
      return { restored: false, detail: `restore_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
    }
  };

  const evOk = deps.appendEvent("continuation", next, { precharge_id: prechargeId });
  if (!evOk) {
    // ADR 0032 W3 (gpt 合议 RC): the EVENT is the source of truth — if the
    // pre-decrement could not reach the event log, the next session-start
    // reconcile would REVERT the counter (branch replay lacks this
    // continuation) and the budget could be re-spent across restarts,
    // breaking bounded-loop. Fail-closed: no send.
    deps.notify("goal auto-continue aborted: continuation event append failed (budget pre-decrement would not survive reconcile)", "warning");
    return { action: "judge_failed", detail: "event_persist_failed" };
  }
  const saved = await deps.saveState(next);
  if (!saved) {
    // The event debit exists but the view write failed. Append a compensating
    // CAS event so replay cannot permanently charge a continuation that was
    // never attempted; the live view CAS may legitimately report mismatch.
    const restored = await restore("budget_persist_failed", "budget_persist");
    deps.notify("goal auto-continue aborted: budget persist failed (would risk unbounded loop)", "warning");
    return {
      action: "judge_failed",
      detail: "budget_persist_failed",
      send_attempted: false,
      phase: "budget_persist",
      budget_restored: restored.restored,
      restore_detail: restored.detail,
    };
  }
  const instruction = d.next_step ?? "Continue working toward the goal; state ACHIEVED or BLOCKED explicitly when true.";
  if (deps.isStillActive && !(await deps.isStillActive(next))) {
    const restored = await restore("stopped_before_send", "pre_send_gate");
    deps.notify("goal auto-continue stopped before queuing follow-up", "info");
    return {
      action: "stopped_before_send",
      detail: "stopped_before_send",
      send_attempted: false,
      phase: "pre_send_gate",
      budget_restored: restored.restored,
      restore_detail: restored.detail,
    };
  }
  const delivery = await deps.sendContinuation(formatGoalContinuationMessage(state.goal_id, instruction));
  if (!delivery.acknowledged) {
    // Missing metadata is treated as attempted for compatibility and safety.
    // Only explicit, known pre-send phases may compensate the precharge.
    const sendAttempted = delivery.sendAttempted !== false;
    const phase = delivery.phase;
    const recoverable = !sendAttempted && phase !== undefined
      && phase !== "claim"
      && phase !== "send_call"
      && phase !== "ack_wait"
      && phase !== "acknowledged";
    const restored = recoverable
      ? await restore(delivery.detail, phase, delivery.deliveryId)
      : { restored: false, detail: sendAttempted ? "send_attempted_no_rollback" : "phase_not_recoverable" };
    deps.notify(
      sendAttempted
        ? `goal continuation delivery unconfirmed (${delivery.detail}); retry suppressed`
        : `goal continuation was not sent (${delivery.detail}); budget restore ${restored.restored ? "applied" : `skipped (${restored.detail})`}`,
      "warning",
    );
    return {
      action: "delivery_unconfirmed",
      detail: delivery.detail,
      send_attempted: sendAttempted,
      ...(phase ? { phase } : {}),
      budget_restored: restored.restored,
      restore_detail: restored.detail,
      ...(delivery.deliveryId ? { delivery_id: delivery.deliveryId } : {}),
    };
  }
  deps.notify(`goal auto-continue acknowledged ${next.counters.continuations_used}/${state.budget.max_continuations}: ${instruction.slice(0, 120)}`, "info");
  return {
    action: "continued",
    detail: instruction,
    send_attempted: delivery.sendAttempted ?? true,
    ...(delivery.phase ? { phase: delivery.phase } : {}),
    ...(delivery.deliveryId ? { delivery_id: delivery.deliveryId } : {}),
  };
}
