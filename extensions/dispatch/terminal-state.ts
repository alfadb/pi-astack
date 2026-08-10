/**
 * terminal-state — ADR 0027 §C5 v1 terminal_state schema.
 *
 * Implements the C5 contract: every dispatch audit row carries an
 * explicit terminal_state of `completed | failed | degraded | cancelled`,
 * plus per-state side-effect fields. The schema is the infra-layer record
 * for L2 outcomes. NOTE (2026-06-16): the dispatch mutating env gate was
 * removed (swarm workers may edit/write/bash via explicit tools=). The
 * terminal_state SCHEMA landed, but there is no rollback ENGINE — partial
 * writes from a failed mutating worker are recovered via git
 * (INV-GIT-IS-RECOVERY), not an undo path. rollback_done retains the v1
 * optimistic value; cleanup_done is evidence-based from bounded closure.
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

/**
 * What cancelled the task (ADR 0027 §C5 cancelled rows).
 *
 * Attribution is evidence-first: only set a specific value when the trigger
 * source or a structured SDK event is known. Ambiguous paths use `unknown`
 * — never guess from fuzzy strings like "Request aborted".
 *
 *   user      — user ESC / AbortSignal.reason marks user
 *   parent    — parent tool AbortSignal (dispatch/workflow lifecycle)
 *   provider  — provider-side error / explicit provider failureType
 *   stream    — only when lifecycle owner stamps abortEvidence:"stream"
 *               (SDK stopReason "aborted" is ambiguous — local/user/parent/
 *               governor session.abort() also produces it; never auto-map)
 *   timeout   — idle / max-runtime watchdog
 *   guardrail — historical guardrail_stop (retained)
 *   unknown   — evidence insufficient (must be allowed and persisted)
 */
export type CancelSource =
  | "user"
  | "parent"
  | "provider"
  | "stream"
  | "timeout"
  | "guardrail"
  | "unknown";

/**
 * Origin of a non-success terminal outcome. Extends CancelSource with
 * `worker_run_governor` for local governor aborts (visible-repeat / provider
 * retry budget / empty-visible / full-output-cap). Additive observability
 * field — not in the ADR §C5 strict table.
 */
export type TerminationSource = CancelSource | "worker_run_governor";

/** Structured abort/termination evidence produced by runInProcess. */
export type AbortEvidenceKind =
  | "user"
  | "parent"
  | "timeout"
  | "guardrail"
  | "provider"
  | "stream"
  | "worker_run_governor"
  | "unknown";

const CANCEL_SOURCES: ReadonlySet<string> = new Set([
  "user", "parent", "provider", "stream", "timeout", "guardrail", "unknown",
]);

const GOVERNOR_FAILURE_TYPES: ReadonlySet<string> = new Set([
  "repetitive_output",
  "provider_retry_budget_exceeded",
  "empty_visible_retry_budget_exceeded",
  "full_output_cap_budget_exceeded",
  "schema_rejection_storm_enforced",
]);

const PROVIDER_FAILURE_TYPES: ReadonlySet<string> = new Set([
  "auth",
  "rate_limit",
  "server_error",
  "context_overflow",
  // model_not_found is local preflight (registry miss) — not a provider source.
]);

export function isCancelSource(value: unknown): value is CancelSource {
  return typeof value === "string" && CANCEL_SOURCES.has(value);
}

export function isTerminationSource(value: unknown): value is TerminationSource {
  return isCancelSource(value) || value === "worker_run_governor";
}

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
  /** Additive observability (not in ADR §C5 table). Set on non-completed
   *  rows so audit/tool-result consumers can attribute the terminal origin
   *  even when the row is `failed` rather than `cancelled`. */
  termination_source?: TerminationSource;
  /** ADR §C5 field for `cancelled` ONLY (per the normative table at the
   *  top of this file). True only when the worker run and session disposal
   *  actually closed within the bounded quiescence window; false means hard
   *  close was requested but could not be proven complete. NOT set on
   *  degraded or failed. */
  cleanup_done?: boolean;
  /** ADR §C5 field for `degraded` ONLY. Human-readable identifiers of the
   *  capability dimensions that were dropped. In v1 dispatch_parallel,
   *  this lists the per-task labels (model strings) of non-completed
   *  tasks (failed AND cancelled — R7 NIT-2 fix: doc previously said
   *  "failed tasks" but implementation includes cancelled too, which is
   *  the correct degraded semantics: every non-completed sub-task is
   *  a dropped capability dimension). */
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
  /** Which watchdog fired when failureType is timeout/timeout_partial. */
  timeoutKind?: "idle" | "max_runtime";
  stopReason?: string;
  /** Pre-resolved cancel attribution from runInProcess (structured evidence). */
  cancelSource?: CancelSource;
  /** Pre-resolved termination attribution from runInProcess. */
  terminationSource?: TerminationSource;
  /** Actual bounded worker/session closure verdict. */
  cleanupDone?: boolean;
}

/** Optional context the caller can pass when building terminal-state fields. */
export interface InferContext {
  /** When set, overrides the cancel_source heuristic. Used by dispatch when
   *  it knows externally that the cancel was a parent signal vs timeout. */
  cancelSource?: CancelSource;
  /** When set, overrides termination_source resolution. */
  terminationSource?: TerminationSource;
  /** Structured abort evidence from the worker lifecycle (preferred over
   *  string heuristics). */
  abortEvidence?: AbortEvidenceKind;
  /** Human-readable model id, used for what_dropped/tasks_not_completed
   *  labels in aggregate. */
  model?: string;
}

/**
 * Inspect AbortSignal.reason for an explicit user marker. Only structured
 * reason values count — fuzzy error strings like "Request aborted" do NOT.
 */
export function abortEvidenceFromSignal(signal: AbortSignal | undefined): AbortEvidenceKind | undefined {
  if (!signal?.aborted) return undefined;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason === undefined || reason === null) return "parent";
  if (typeof reason === "string") {
    const r = reason.toLowerCase();
    if (r === "user" || r === "user_abort" || r === "esc" || r === "user-cancel" || r === "user_cancel") {
      return "user";
    }
    if (r === "timeout" || r === "idle_timeout" || r === "max_runtime") return "timeout";
    if (r === "parent" || r === "parent_abort") return "parent";
    // Unknown string reason → parent owns the tool signal; do not guess.
    return "parent";
  }
  if (typeof reason === "object" && reason !== null) {
    const rec = reason as Record<string, unknown>;
    const kind = rec.kind ?? rec.source ?? rec.type;
    if (kind === "user" || kind === "user_abort") return "user";
    if (kind === "timeout" || kind === "idle" || kind === "max_runtime") return "timeout";
    if (kind === "parent" || kind === "parent_abort") return "parent";
  }
  return "parent";
}

/**
 * Resolve cancel_source from structured evidence + failureType.
 * Never classifies from fuzzy error message text alone.
 */
export function resolveCancelSource(
  result: ResultLike,
  ctx?: InferContext,
): CancelSource {
  // Prefer specific structured evidence over a pre-stamped "unknown".
  // Pre-stamped unknown must NOT suppress later timeout/guardrail/abortEvidence.
  const prefer = (cs: CancelSource | undefined): CancelSource | undefined =>
    cs && isCancelSource(cs) && cs !== "unknown" ? cs : undefined;
  const specific =
    prefer(ctx?.cancelSource) ??
    prefer(result.cancelSource);
  if (specific) return specific;
  if (ctx?.abortEvidence) {
    if (ctx.abortEvidence === "worker_run_governor") return "unknown";
    // Specific abortEvidence upgrades unknown; keep unknown only as last resort.
    if (ctx.abortEvidence !== "unknown" && isCancelSource(ctx.abortEvidence)) {
      return ctx.abortEvidence;
    }
  }
  const ft = result.failureType;
  if (ft === "timeout" || ft === "timeout_partial" || result.timeoutKind) return "timeout";
  if (ft === "guardrail_stop") return "guardrail";
  if (ft === "aborted") return "unknown";
  // Fall back to pre-stamped unknown only after failureType heuristics.
  if (ctx?.cancelSource && isCancelSource(ctx.cancelSource)) return ctx.cancelSource;
  if (result.cancelSource && isCancelSource(result.cancelSource)) return result.cancelSource;
  if (ctx?.abortEvidence === "unknown") return "unknown";
  return "unknown";
}

/**
 * Resolve termination_source for any non-success outcome.
 * Evidence-first; ambiguous → unknown. Does not parse fuzzy strings.
 */
export function resolveTerminationSource(
  result: ResultLike,
  ctx?: InferContext,
): TerminationSource | undefined {
  if (!result.error) return undefined;
  // Prefer specific (non-unknown) pre-stamped sources. Pre-stamped "unknown"
  // must not suppress later timeout / provider / governor / abortEvidence.
  const preferTerm = (ts: TerminationSource | undefined): TerminationSource | undefined =>
    ts && isTerminationSource(ts) && ts !== "unknown" ? ts : undefined;
  const specific =
    preferTerm(ctx?.terminationSource) ??
    preferTerm(result.terminationSource);
  if (specific) return specific;
  // abortEvidence: only non-unknown counts as an upgrade here.
  if (
    ctx?.abortEvidence &&
    ctx.abortEvidence !== "unknown" &&
    isTerminationSource(ctx.abortEvidence)
  ) {
    return ctx.abortEvidence;
  }
  const ft = result.failureType;
  if (ft === "timeout" || ft === "timeout_partial" || result.timeoutKind) return "timeout";
  if (ft === "guardrail_stop") return "guardrail";
  if (ft && GOVERNOR_FAILURE_TYPES.has(ft)) return "worker_run_governor";
  if (ft === "aborted") {
    const cs = resolveCancelSource(result, ctx);
    return cs;
  }
  // Stream is NEVER inferred from stopReason. SDK StopReason is
  // "stop"|"length"|"toolUse"|"error"|"aborted"; "aborted" is also emitted by
  // local/user/parent/governor session.abort(). Only explicit
  // abortEvidence:"stream" (handled above) may label stream.
  if (ft === "truncated") return "provider";
  if (ft && PROVIDER_FAILURE_TYPES.has(ft)) return "provider";
  // model_not_found / network / agent_error / retry_exhausted / crash /
  // tool_rejected / etc. without structured evidence → unknown.
  // Fall back to pre-stamped unknown only after heuristics.
  if (ctx?.terminationSource && isTerminationSource(ctx.terminationSource)) {
    return ctx.terminationSource;
  }
  if (result.terminationSource && isTerminationSource(result.terminationSource)) {
    return result.terminationSource;
  }
  if (ctx?.abortEvidence === "unknown") return "unknown";
  return "unknown";
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
 *   - failureType === "timeout" / "timeout_partial" / "guardrail_stop" → cancelled
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
  if (ft === "timeout" || ft === "timeout_partial" || ft === "guardrail_stop") return "cancelled";
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
    // Evidence-first cancel_source. Prefer ctx / pre-resolved result fields
    // / structured abortEvidence over failureType alone. Ambiguous aborted
    // paths resolve to "unknown" — never guess from fuzzy error strings.
    out.cancel_source = resolveCancelSource(result, ctx);
    out.termination_source = resolveTerminationSource(result, ctx) ?? out.cancel_source;
    out.cleanup_done = result.cleanupDone === true;
  } else if (state === "failed") {
    out.reason = clipReason(result.error);
    out.rollback_done = true;  // v1: read-only, nothing to roll back
    const term = resolveTerminationSource(result, ctx);
    if (term) out.termination_source = term;
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
 * `cancel_source` aggregate heuristic (evidence-first priority):
 *   - If `ctx.cancelSource` / `ctx.abortEvidence` is set → use it.
 *   - Else prefer specific sources across tasks in order:
 *     user > parent > timeout > guardrail > provider > stream > unknown.
 *   - Never invent user from bare failureType="aborted".
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
      termination_source: "unknown",
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

  // Helper: aggregate cancel_source resolution (evidence-first priority).
  const CANCEL_PRIORITY: CancelSource[] = [
    "user", "parent", "timeout", "guardrail", "provider", "stream", "unknown",
  ];
  function resolveAggregateCancelSource(): CancelSource {
    if (ctx?.cancelSource && isCancelSource(ctx.cancelSource)) return ctx.cancelSource;
    if (ctx?.abortEvidence && isCancelSource(ctx.abortEvidence)) return ctx.abortEvidence;
    const sources = tasks
      .filter((t) => inferTerminalState(t.result) === "cancelled")
      .map((t) => resolveCancelSource(t.result));
    for (const preferred of CANCEL_PRIORITY) {
      if (sources.includes(preferred)) return preferred;
    }
    return "unknown";
  }

  function resolveAggregateTerminationSource(): TerminationSource | undefined {
    if (ctx?.terminationSource && isTerminationSource(ctx.terminationSource)) {
      return ctx.terminationSource;
    }
    if (ctx?.abortEvidence && isTerminationSource(ctx.abortEvidence)) {
      return ctx.abortEvidence;
    }
    const sources = tasks
      .filter((t) => !!t.result.error)
      .map((t) => resolveTerminationSource(t.result))
      .filter((s): s is TerminationSource => !!s);
    const TERM_PRIORITY: TerminationSource[] = [
      "user", "parent", "timeout", "guardrail", "worker_run_governor",
      "provider", "stream", "unknown",
    ];
    for (const preferred of TERM_PRIORITY) {
      if (sources.includes(preferred)) return preferred;
    }
    return sources[0];
  }

  // All cancelled (and zero completed, zero failed)
  if (cancelledCount === n) {
    const cancel_source = resolveAggregateCancelSource();
    return {
      terminal_state: "cancelled",
      cancel_source,
      termination_source: resolveAggregateTerminationSource() ?? cancel_source,
      cleanup_done: tasks.every((task) => task.result.cleanupDone === true),
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
    const term = resolveAggregateTerminationSource();
    return {
      terminal_state: "failed",
      reason,
      rollback_done: true,
      ...(term ? { termination_source: term } : {}),
      tasks_not_completed: notCompleted,
      resumable: false,
    };
  }

  // Partial success: 0 < ok < n → degraded
  //
  // R7 P1 fix (Opus P1-B): degraded no longer carries `cleanup_done` per
  // ADR §C5 strict scope (cleanup_done is on cancelled only). Closure truth
  // remains on each cancelled task rather than the degraded aggregate row.
  // For degraded, `what_dropped` + `alt_path` are the ADR-mandated
  // side-effect fields. When task-level evidence can be aggregated,
  // also stamp termination_source (additive observability).
  const droppedLabels = notCompleted;
  const degradedTerm = resolveAggregateTerminationSource();
  return {
    terminal_state: "degraded",
    what_dropped: droppedLabels,
    alt_path: `use ${okCount}/${n} task results`,
    tasks_not_completed: notCompleted,
    ...(degradedTerm ? { termination_source: degradedTerm } : {}),
    resumable: false,
  };
}
