/**
 * terminal-state — ADR 0027 §C5 v1 terminal_state schema.
 *
 * Implements the C5 contract: every dispatch audit row carries an
 * explicit terminal_state of `completed | failed | degraded | cancelled`,
 * plus per-state side-effect fields. This is the infra-layer prerequisite
 * for any L2 mutating production path; the schema must land BEFORE any
 * PR opens `PI_MULTI_AGENT_ALLOW_MUTATING=1` as default.
 *
 * # ADR §C5 field contract (normative)
 *
 * Per ADR 0027 §C5 row 1-4:
 *
 *   | state     | fields                                                    |
 *   |-----------|-----------------------------------------------------------|
 *   | failed    | terminal_state, reason, rollback_done                     |
 *   | degraded  | terminal_state, what_dropped, alt_path                    |
 *   | cancelled | terminal_state, cancel_source, cleanup_done               |
 *   | completed | terminal_state                                            |
 *
 * Beyond the ADR table we also write `resumable: false` on every row so
 * downstream consumers can distinguish v1 (no resume support) from v2+
 * rows that may carry `resume_from_checkpoint` / `idempotency_key`.
 *
 * For aggregate dispatch_parallel rows, the cancelled/failed branches
 * carry an additional `tasks_not_completed: string[]` field (NOT
 * `what_dropped` — that name is reserved for degraded per ADR strict
 * scope). `tasks_not_completed` lists the per-task labels that did not
 * reach `completed`. The degraded aggregate ALSO sets `tasks_not_completed`
 * in addition to `what_dropped` so consumers querying "which sub-tasks
 * fell through?" can use one field uniformly across non-completed states.
 *
 * # What is in v1
 *
 *   - Deterministic mapping `inferTerminalState(result)` for single tasks.
 *   - Aggregate mapping `inferParallelTerminalState(results, ctx?)` for
 *     dispatch_parallel fan-out, which is the only context where
 *     `degraded` (partial success) makes sense in v1.
 *   - Side-effect fields per ADR §C5 (above).
 *   - `cancelSource` override path so dispatch can thread parent-abort
 *     context (signal.aborted) into both single-task and aggregate rows.
 *
 * # What is NOT in v1
 *
 *   - Heartbeat trace (separate Stage 1b).
 *   - `resume_from_checkpoint` / `idempotency_key` (defers to a resume
 *     impl; v1 marks `resumable: false` so consumers know not to try).
 *   - SLA policy that decides "this task type should degrade vs fail"
 *     (per ADR 0027 §C5 explicitly deferred to per-task-type policy
 *     of the L2 executor; current dispatch has one task type so the
 *     question is degenerate — aggregate dispatch_parallel is the only
 *     place `degraded` arises in v1).
 *
 * # C3' boundary (no LLM)
 *
 * `inferTerminalState` and `inferParallelTerminalState` are pure
 * deterministic functions. ADR 0027 §C3' allows structured infra here;
 * no LLM classification is introduced. Per ADR 0024 §3, the cognitive
 * layer (classifier/extractor/curator/aggregator) remains prompt-native,
 * the infra layer (state machine / audit schema / cancellation token)
 * is structured. terminal_state belongs to the infra layer.
 */

/** Terminal state taxonomy from ADR 0027 §C5. */
export type TerminalState = "completed" | "failed" | "degraded" | "cancelled";

/** What cancelled the task. v1 distinguishes user abort vs timeout.
 *  Future v2 may add "L1" (L1 wrote cancel annotation) and "scheduler". */
export type CancelSource = "user" | "timeout";

/** All per-state extra fields. terminal_state is always present; the
 *  others depend on the state per ADR §C5.
 *
 *  Field scope (ADR §C5 strict):
 *    failed     → reason, rollback_done
 *    degraded   → what_dropped, alt_path (+ tasks_not_completed for aggregate)
 *    cancelled  → cancel_source, cleanup_done (+ tasks_not_completed for aggregate)
 *    completed  → (none beyond terminal_state)
 *
 *  v1 universally adds:
 *    resumable: false   (explicit v1 marker; v2+ may overwrite)
 */
export interface TerminalStateFields {
  terminal_state: TerminalState;
  /** ADR §C5 field for `failed`. Human-readable error reason. Populated
   *  from `result.error` (sanitized + bounded by dispatch audit writer
   *  callers, not by this module). */
  reason?: string;
  /** ADR §C5 field for `failed`. v1 read-only dispatch: always `true`
   *  vacuously (no mutations to roll back). When mutating sub-agents
   *  ship, this becomes meaningful. */
  rollback_done?: boolean;
  /** ADR §C5 field for `cancelled`. */
  cancel_source?: CancelSource;
  /** ADR §C5 field for `cancelled` and `degraded`. v1 read-only dispatch:
   *  always `true` vacuously. */
  cleanup_done?: boolean;
  /** ADR §C5 field for `degraded` ONLY. Human-readable identifiers of the
   *  capability dimensions that were dropped. In v1 dispatch_parallel,
   *  this lists the per-task labels (model strings) of failed tasks. */
  what_dropped?: string[];
  /** ADR §C5 field for `degraded` ONLY. One-line description of the
   *  fallback path taken (e.g., "use 2/3 reviewer quorum"). */
  alt_path?: string;
  /** Aggregate extension (NOT in ADR §C5 table). Set on aggregate
   *  cancelled/failed/degraded rows so consumers querying "which
   *  sub-tasks did not complete?" can read one field uniformly. */
  tasks_not_completed?: string[];
  /** v1: always `false`. v2+ may set true when a `resume_from_checkpoint`
   *  is recorded. Explicitly recording false (not omitting) so consumers
   *  can distinguish "v1 schema" from "missing field". */
  resumable?: boolean;
}

/** Minimal shape of an AgentResult that this module needs. Avoids importing
 *  the full AgentResult interface from index.ts (no circular dep). */
export interface ResultLike {
  error?: string;
  failureType?: string;
  output?: string;
}

/** Optional context the caller can pass when building terminal-state fields. */
export interface InferContext {
  /** When set, overrides the cancel_source heuristic. Used by dispatch when
   *  it knows externally that the cancel was a parent signal vs timeout. */
  cancelSource?: CancelSource;
  /** Human-readable model id, used for what_dropped/tasks_not_completed
   *  labels in aggregate. */
  model?: string;
}

/** Bound on `reason` field length — keeps audit rows from being polluted
 *  by provider error spew that may echo request body. Mirrors the cap
 *  applied by sediment audit sanitizer. */
const REASON_CAP = 500;

function clipReason(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.length <= REASON_CAP ? raw : raw.slice(0, REASON_CAP) + "...";
}

/**
 * Deterministic single-task mapping (FailureType → TerminalState).
 *
 * Rules (v1):
 *   - no error → completed
 *   - failureType === "aborted" → cancelled (user signal or parent signal)
 *   - failureType === "timeout" / "timeout_partial" → cancelled (timeout source)
 *       Rationale per ADR 0027 §C5: "task 被外部信号终止" applies to timeout
 *       too — the dispatch tool's timeout is an externally-imposed boundary,
 *       not the task itself failing. timeout_partial is still cancelled (not
 *       degraded) in v1 because there is no per-task SLA policy that says
 *       "partial output is an acceptable degraded outcome"; that policy
 *       belongs to the L2 executor (ADR 0027 §C5 explicitly defers).
 *   - everything else with error → failed
 *
 * NOTE: `degraded` is NEVER produced for a single task in v1. It only
 * arises from aggregate logic in `inferParallelTerminalState`.
 */
export function inferTerminalState(result: ResultLike): TerminalState {
  if (!result.error) return "completed";
  const ft = result.failureType;
  if (ft === "aborted") return "cancelled";
  if (ft === "timeout" || ft === "timeout_partial") return "cancelled";
  return "failed";
}

/**
 * Build the full terminal-state fields object for a single-task result.
 *
 * Per ADR §C5 strict scope:
 *   completed → terminal_state only
 *   failed    → terminal_state + reason + rollback_done
 *   cancelled → terminal_state + cancel_source + cleanup_done
 *   degraded  → (never produced single-task; see inferParallelTerminalState)
 *
 * All rows also set `resumable: false` (v1 marker; not in ADR table but
 * additive — see module docstring).
 */
export function buildTerminalStateFields(
  result: ResultLike,
  ctx?: InferContext,
): TerminalStateFields {
  const state = inferTerminalState(result);
  const out: TerminalStateFields = { terminal_state: state, resumable: false };

  if (state === "cancelled") {
    // Default heuristic: failureType=="aborted" usually means parent
    // signal / user ESC; failureType=="timeout"/"timeout_partial" means
    // dispatch tool timeout. Caller may override via ctx.cancelSource
    // when it has stronger information (e.g., it knows ctx.signal.aborted
    // fired specifically — parent abort can race with timeout).
    if (ctx?.cancelSource) {
      out.cancel_source = ctx.cancelSource;
    } else if (result.failureType === "timeout" || result.failureType === "timeout_partial") {
      out.cancel_source = "timeout";
    } else {
      out.cancel_source = "user";
    }
    out.cleanup_done = true;   // v1: no resources held
  } else if (state === "failed") {
    out.reason = clipReason(result.error);
    out.rollback_done = true;  // v1: read-only, nothing to roll back
    // NOTE: cleanup_done is NOT set on failed per ADR §C5 strict scope.
  }
  // `completed` and `degraded` (never reached single-task) need no extras.

  return out;
}

/** Per-task summary used for parallel aggregation. */
export interface TaskSummary {
  result: ResultLike;
  /** Human-readable identifier for the task (model name or task index).
   *  Used for what_dropped / tasks_not_completed on non-completed outcomes. */
  label: string;
}

/**
 * Aggregate terminal state for dispatch_parallel fan-out.
 *
 * Rules (v1):
 *   - All N tasks completed → "completed"
 *   - All N tasks cancelled → "cancelled" (cancel_source per heuristic
 *     below; parent-signal override takes precedence)
 *   - 0 < ok < N → "degraded" (some tasks succeeded; consumer may still
 *     use the partial result, per the multi-model audit pattern where
 *     2/3 reviewers is often quorum-enough)
 *   - 0 ok with any failed → "failed" (default conservative; if any task
 *     genuinely failed, the aggregate is failed even if others were
 *     cancelled — protects against masking real failures)
 *   - All N failed → "failed"
 *
 * `tasks_not_completed` is populated for any non-completed aggregate
 * state, listing the per-task labels that did not reach completed. This
 * is in addition to the ADR §C5 strict-scope fields (e.g., `what_dropped`
 * on degraded, `cancel_source` on cancelled).
 *
 * `cancel_source` aggregate heuristic:
 *   - If `ctx.cancelSource` is set (parent passed it because the dispatch
 *     signal.aborted fired) → use it. This dominates because the parent
 *     signal is the strongest cancellation source.
 *   - Else if ANY task carries cancelSource="user" (e.g., the per-task
 *     buildTerminalStateFields applied the override) → "user" wins.
 *   - Else if any task has failureType="timeout"/"timeout_partial" → "timeout".
 *   - Else → "user" (fallback).
 *
 * `alt_path` is set to a human-readable description of the fallback for
 * degraded outcomes ("use M/N task results"). For other states `alt_path`
 * is omitted (no fallback was taken).
 */
export function inferParallelTerminalState(
  tasks: TaskSummary[],
  ctx?: InferContext,
): TerminalStateFields {
  if (tasks.length === 0) {
    // Defensive: empty input shouldn't reach here, but if it does treat
    // it as a degenerate failed.
    return {
      terminal_state: "failed",
      reason: "no tasks in dispatch fan-out (degenerate)",
      rollback_done: true,
      resumable: false,
    };
  }

  const states = tasks.map((t) => inferTerminalState(t.result));
  const okCount = states.filter((s) => s === "completed").length;
  const cancelledCount = states.filter((s) => s === "cancelled").length;
  const n = tasks.length;

  // Helper: labels of tasks that did not reach completed.
  const notCompleted = tasks
    .filter((t) => inferTerminalState(t.result) !== "completed")
    .map((t) => t.label);

  // All completed
  if (okCount === n) {
    return { terminal_state: "completed", resumable: false };
  }

  // Helper: aggregate cancel_source resolution.
  function resolveCancelSource(): CancelSource {
    if (ctx?.cancelSource) return ctx.cancelSource;
    // If ANY task's failureType is "aborted" (user abort), treat as user.
    if (tasks.some((t) => t.result.failureType === "aborted")) return "user";
    // Else if any was timeout, mark as timeout.
    if (
      tasks.some((t) =>
        t.result.failureType === "timeout" || t.result.failureType === "timeout_partial",
      )
    ) return "timeout";
    return "user";
  }

  // All cancelled (and zero completed, zero failed)
  if (cancelledCount === n) {
    return {
      terminal_state: "cancelled",
      cancel_source: resolveCancelSource(),
      cleanup_done: true,
      tasks_not_completed: notCompleted,
      resumable: false,
    };
  }

  // All failed-or-cancelled but with 0 completed: aggregate is "failed"
  // (conservative — any real failure dominates a cancellation when there
  // is also no success to fall back on).
  if (okCount === 0) {
    // Pick a representative reason from the first failed task.
    const firstFailed = tasks.find((t) => inferTerminalState(t.result) === "failed");
    const reason = firstFailed
      ? clipReason(`aggregate failed: ${tasks.length} task(s) did not complete; first error: ${firstFailed.result.error ?? "(unknown)"}`)
      : `aggregate failed: ${tasks.length} task(s) did not complete`;
    return {
      terminal_state: "failed",
      reason,
      rollback_done: true,
      tasks_not_completed: notCompleted,
      resumable: false,
    };
  }

  // Partial success: 0 < ok < n → degraded
  const droppedLabels = notCompleted;
  return {
    terminal_state: "degraded",
    what_dropped: droppedLabels,
    alt_path: `use ${okCount}/${n} task results`,
    cleanup_done: true,
    tasks_not_completed: notCompleted,
    resumable: false,
  };
}
