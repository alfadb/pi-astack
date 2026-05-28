/**
 * terminal-state — ADR 0027 §C5 v1 terminal_state schema.
 *
 * Implements the C5 contract: every dispatch audit row carries an
 * explicit terminal_state of `completed | failed | degraded | cancelled`,
 * plus per-state side-effect fields. This is the infra-layer prerequisite
 * for any L2 mutating production path; the schema must land BEFORE any
 * PR opens `PI_MULTI_AGENT_ALLOW_MUTATING=1` as default.
 *
 * # What is in v1
 *
 *   - Deterministic mapping `inferTerminalState(result)` for single tasks.
 *   - Aggregate mapping `inferParallelTerminalState(results)` for
 *     dispatch_parallel fan-out, which is the only context where
 *     `degraded` (partial success) makes sense in v1.
 *   - Side-effect fields:
 *       cancel_source: "user" | "timeout"     — distinguishes who cancelled
 *       cleanup_done: boolean                  — file/lock cleanup status
 *       rollback_done: boolean                 — for `failed`, whether
 *                                                side effects were rolled back
 *       what_dropped: string[]                 — for `degraded`, what's missing
 *       alt_path: string                       — for `degraded`, the fallback used
 *       resumable: boolean                     — v1 always false (resume is v2+)
 *
 * # What is NOT in v1
 *
 *   - Heartbeat trace (separate Stage 1b)
 *   - `resume_from_checkpoint` / `idempotency_key` (defers to a resume
 *     impl; v1 marks `resumable: false` so consumers know not to try)
 *   - SLA policy that decides "this task type should degrade vs fail"
 *     (per ADR 0027 §C5 explicitly deferred to per-task-type policy
 *     of the L2 executor; current dispatch has one task type so the
 *     question is degenerate — aggregate dispatch_parallel is the only
 *     place `degraded` arises in v1)
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
 *  others are optional and depend on the state. */
export interface TerminalStateFields {
  terminal_state: TerminalState;
  /** Set when terminal_state === "cancelled". */
  cancel_source?: CancelSource;
  /** Set when terminal_state ∈ {failed, cancelled, degraded}. v1: read-only
   *  dispatch has no side effects to clean up, so this is `true` vacuously.
   *  When PI_MULTI_AGENT_ALLOW_MUTATING=1 ships, this becomes meaningful. */
  cleanup_done?: boolean;
  /** Set when terminal_state === "failed". v1: read-only dispatch has no
   *  mutating side effects, so rollback is `true` vacuously. */
  rollback_done?: boolean;
  /** Set when terminal_state === "degraded". Human-readable identifiers of
   *  what was dropped (e.g., model names of failed tasks in a parallel run). */
  what_dropped?: string[];
  /** Set when terminal_state === "degraded". One-line description of the
   *  fallback path taken (e.g., "use 2/3 reviewer quorum"). */
  alt_path?: string;
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
  /** Human-readable model id, used for what_dropped in aggregate. */
  model?: string;
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
 * Side-effect field defaults (v1, read-only dispatch):
 *   - cleanup_done: true (no resources held)
 *   - rollback_done: true (no mutations to roll back)
 *   - resumable: false (no resume v1)
 *
 * When `PI_MULTI_AGENT_ALLOW_MUTATING=1` ships, the dispatch site will
 * need to override these from actual cleanup/rollback status.
 */
export function buildTerminalStateFields(
  result: ResultLike,
  ctx?: InferContext,
): TerminalStateFields {
  const state = inferTerminalState(result);
  const out: TerminalStateFields = { terminal_state: state };

  if (state === "cancelled") {
    // Default heuristic: failureType=="aborted" usually means parent
    // signal / user ESC; failureType=="timeout"/"timeout_partial" means
    // dispatch tool timeout. Caller may override via ctx.cancelSource
    // when it has stronger information (e.g., it knows ctx.signal.aborted
    // fired specifically).
    if (ctx?.cancelSource) {
      out.cancel_source = ctx.cancelSource;
    } else if (result.failureType === "timeout" || result.failureType === "timeout_partial") {
      out.cancel_source = "timeout";
    } else {
      out.cancel_source = "user";
    }
    out.cleanup_done = true;   // v1: no resources held
    out.resumable = false;
  } else if (state === "failed") {
    out.rollback_done = true;  // v1: read-only, nothing to roll back
    out.cleanup_done = true;
    out.resumable = false;
  } else if (state === "completed") {
    out.resumable = false;
  }
  // `degraded` is never produced for single task — see function doc.

  return out;
}

/** Per-task summary used for parallel aggregation. */
export interface TaskSummary {
  result: ResultLike;
  /** Human-readable identifier for the task (model name or task index).
   *  Used for what_dropped on degraded outcomes. */
  label: string;
}

/**
 * Aggregate terminal state for dispatch_parallel fan-out.
 *
 * Rules (v1):
 *   - All N tasks completed → "completed"
 *   - All N tasks cancelled → "cancelled" (preserves cancel_source from the
 *     first cancelled task; assumes parallel cancellation has shared cause)
 *   - 0 < ok < N → "degraded" (some tasks succeeded; consumer may still use
 *     the partial result, per the multi-model audit pattern where 2/3
 *     reviewers is often quorum-enough)
 *   - 0 ok, mixed cancel/fail → "failed" (default conservative; if any task
 *     genuinely failed, the aggregate is failed even if others were
 *     cancelled — protects against masking real failures)
 *   - All N failed → "failed"
 *
 * `what_dropped` is populated with the labels of non-completed tasks for
 * any non-completed aggregate state, so audit consumers can see exactly
 * which sub-tasks did not succeed.
 *
 * `alt_path` is set to a human-readable description of the fallback for
 * degraded outcomes ("use M/N task results"). For other states `alt_path`
 * is omitted (no fallback was taken).
 */
export function inferParallelTerminalState(
  tasks: TaskSummary[],
): TerminalStateFields {
  if (tasks.length === 0) {
    // Defensive: empty input shouldn't reach here, but if it does treat
    // it as a degenerate failed.
    return {
      terminal_state: "failed",
      rollback_done: true,
      cleanup_done: true,
      resumable: false,
    };
  }

  const states = tasks.map((t) => inferTerminalState(t.result));
  const okCount = states.filter((s) => s === "completed").length;
  const cancelledCount = states.filter((s) => s === "cancelled").length;
  const failedCount = states.filter((s) => s === "failed").length;
  const n = tasks.length;

  // Helper: build what_dropped (labels of non-ok tasks) used by failed +
  // degraded + cancelled aggregates.
  const droppedLabels = tasks
    .filter((t) => inferTerminalState(t.result) !== "completed")
    .map((t) => t.label);

  // All completed
  if (okCount === n) {
    return { terminal_state: "completed", resumable: false };
  }

  // All cancelled (and zero failed) — propagate cancellation cleanly
  if (cancelledCount === n) {
    // Use first cancelled task's source as aggregate source (heuristic; in
    // dispatch_parallel cancellation usually comes from the shared signal).
    const firstCancelled = tasks.find(
      (t) => inferTerminalState(t.result) === "cancelled",
    );
    const ft = firstCancelled?.result.failureType;
    return {
      terminal_state: "cancelled",
      cancel_source:
        ft === "timeout" || ft === "timeout_partial" ? "timeout" : "user",
      cleanup_done: true,
      what_dropped: droppedLabels,
      resumable: false,
    };
  }

  // All failed (including cancellations counted as "didn't succeed but
  // not user-cancellable aggregate"). Conservative: if zero ok AND any
  // failed, aggregate is failed even if some were cancelled.
  if (okCount === 0) {
    return {
      terminal_state: "failed",
      rollback_done: true,
      cleanup_done: true,
      what_dropped: droppedLabels,
      resumable: false,
    };
  }

  // Partial success: 0 < ok < n → degraded
  return {
    terminal_state: "degraded",
    what_dropped: droppedLabels,
    alt_path: `use ${okCount}/${n} task results`,
    cleanup_done: true,
    resumable: false,
  };
}
