/**
 * Pure per-run governance state machine for bounded dispatch/workflow workers.
 *
 * One instance owns one and only one governance termination promise. External
 * parent abort and wall-clock timeouts remain lifecycle owners outside this
 * module. Provider budgets, visible repetition, and bounded tool observations
 * enter here as signals; first terminal wins.
 */

import { createHmac, randomBytes } from "node:crypto";
import * as path from "node:path";

export const WORKER_RUN_GOVERNOR_RULE_VERSION = "dispatch-worker-run-governor/v2";
export const TOOL_OBSERVER_COVERAGE = "post_execution_only";

/** S4 single-rule enforce (living plan 2026-08-10 STORM-ENFORCE): the ONLY
 *  production-supported branch of the authorized rule
 *  storm/post-cap-schema-rejection-signature/v1 — the exact consecutive
 *  branch (consecutive_count===4 && cap_after===3 && would_abort_basis===
 *  "consecutive"). Rolling-window trips never enter control; there is no
 *  total tool cap. */
export const WORKER_RUN_STORM_ENFORCE_RULE_VERSION = "dispatch-storm-enforce/v1";
export const STORM_ENFORCE_RULE_ID = "storm/post-cap-schema-rejection-signature/v1";
export const STORM_ENFORCE_ROW_KIND = "worker_run_enforce_event";
export const STORM_ENFORCE_SIGNAL = "schema_rejection_storm_enforce";
export const STORM_ENFORCE_DEGRADED_SIGNAL = "schema_rejection_storm_enforce_degraded";
export const STORM_ENFORCE_UNSUPPORTED_CAP_SIGNAL = "schema_rejection_storm_enforce_unsupported_cap";

export type WorkerGovernorFailureType =
  | "repetitive_output"
  | "provider_retry_budget_exceeded"
  | "empty_visible_retry_budget_exceeded"
  | "full_output_cap_budget_exceeded"
  | "schema_rejection_storm_enforced";

export type WorkerGovernorSignal =
  | "requested_output_cap"
  | "provider_request"
  | "provider_retry"
  | "assistant_response"
  | "empty_visible_retry"
  | "full_output_cap_hit"
  | "repetitive_output"
  | "same_file_small_read_churn"
  | "schema_error_storm"
  | "schema_rejection_storm_enforce";

export interface WorkerRunGovernorCounters {
  provider_request_count: number;
  provider_retry_count: number;
  provider_retry_consecutive_count: number;
  provider_retry_window_observation_count: number;
  provider_retry_window_retry_count: number;
  provider_retry_window_progress_count: number;
  assistant_response_count: number;
  empty_visible_retry_count: number;
  full_output_cap_hit_count: number;
  tool_call_count: number;
  successful_tool_response_count: number;
  same_file_small_read_churn_count: number;
  schema_error_storm_count: number;
}

export interface WorkerRunGovernorThresholds {
  provider_retry_limit: number;
  provider_retry_window_size: number;
  provider_retry_window_limit: number;
  empty_visible_retry_limit: number;
  full_output_cap_limit: number;
  full_output_usage_ratio: number;
  same_file_small_read_churn_observe_after: number;
  schema_error_storm_observe_after: number;
}

export interface WorkerRunGovernorSettings {
  enabled: boolean;
  visibleText: {
    enabled: boolean;
    abortOnRepeat: boolean;
  };
  providerBudgets: {
    enabled: boolean;
    providerRetryLimit: number;
    providerRetryWindowSize: number;
    providerRetryWindowLimit: number;
    emptyVisibleRetryLimit: number;
    fullOutputCapLimit: number;
    fullOutputUsageRatio: number;
  };
  toolObservers: {
    enabled: boolean;
    sameFileSmallReadChurn: {
      enabled: boolean;
      observeAfter: number;
      maxWindowLines: number;
      overlapRatio: number;
      maxTrackedPaths: number;
    };
    schemaErrorStorm: {
      enabled: boolean;
      observeAfter: number;
      maxTrackedShapes: number;
      /** S4: enforce the production-supported exact consecutive branch of
       *  storm/post-cap-schema-rejection-signature/v1 (default true). */
      enforceConsecutiveExact: boolean;
    };
  };
}

export const DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS: WorkerRunGovernorSettings = {
  enabled: true,
  visibleText: { enabled: true, abortOnRepeat: true },
  providerBudgets: {
    enabled: true,
    providerRetryLimit: 7,
    providerRetryWindowSize: 14,
    providerRetryWindowLimit: 10,
    emptyVisibleRetryLimit: 2,
    fullOutputCapLimit: 2,
    fullOutputUsageRatio: 0.98,
  },
  toolObservers: {
    enabled: true,
    sameFileSmallReadChurn: {
      enabled: true,
      observeAfter: 3,
      maxWindowLines: 200,
      overlapRatio: 0.8,
      maxTrackedPaths: 32,
    },
    schemaErrorStorm: {
      enabled: true,
      observeAfter: 3,
      maxTrackedShapes: 64,
      enforceConsecutiveExact: true,
    },
  },
};

export interface WorkerRunGovernorDecision {
  worker_run_id: string;
  rule_version: typeof WORKER_RUN_GOVERNOR_RULE_VERSION;
  signal: WorkerGovernorSignal;
  mode: "observe" | "abort";
  counters: WorkerRunGovernorCounters;
  thresholds: WorkerRunGovernorThresholds;
  elapsed_ms: number;
  termination_source: "none" | "worker_run_governor";
  failureType?: WorkerGovernorFailureType;
  count?: number;
  limit?: number;
  budget_kind?: "consecutive" | "rolling_window";
  window_size?: number;
  action: string;
  hash?: string;
  shape?: string;
  coverage?: typeof TOOL_OBSERVER_COVERAGE;
  toolCallId?: string;
  /** S4 enforce additive fields (only on schema_rejection_storm_enforce). */
  rule_id?: string;
  enforce_rule_version?: string;
  signature_hmac?: { algorithm: "hmac-sha256"; key_id: string; digest: string };
  segment?: number;
}

export interface WorkerRunAuditCorrelation {
  dispatchToolCallId?: string;
  dispatchRunId?: string;
  taskIndex?: number;
  taskCount?: number;
  task?: string;
  workflowRunId?: string;
  workflowStageId?: string;
  workflow?: string;
}

export interface WorkerProviderRetryAuditFields {
  retry_phase: "start" | "end";
  retry_attempt?: number;
  retry_max_attempts?: number;
  retry_delay_ms?: number;
  retry_outcome: "retrying" | "recovered" | "exhausted" | "unknown";
  error_classification: "none" | "auth" | "rate_limit" | "network" | "server_error" | "context_overflow" | "unknown";
  error_fingerprint?: {
    algorithm: "hmac-sha256";
    key_id: string;
    digest: string;
  };
  http_status?: number;
}

// Note: on the normal path closure may complete before the synchronous run
// claim; measure the elapsed wait by bounded_wait_ms, not by the delta of
// termination_claimed_at_ms / closure_completed_at_ms timestamps.
export interface WorkerTerminationClosureEvidence {
  lifecycle_path: "normal" | "preflight" | "abnormal" | "unknown";
  termination_owner: "run" | "parent" | "timeout" | "worker_run_governor" | "preflight" | "unknown";
  termination_claimed_at_ms: number | null;
  closure_status: "complete" | "incomplete" | "not_applicable" | "unknown";
  closure_completed_at_ms: number | null;
  bounded_wait_ms: number;
  bounded_wait_limit_ms: number;
  run_settled: boolean;
  session_closure_done: boolean | null;
  cleanup_done: boolean;
  post_claim_provider_start_count: number;
  post_claim_tool_start_count: number;
}

export function buildWorkerRunAuditEvent(
  decision: WorkerRunGovernorDecision,
  correlation: WorkerRunAuditCorrelation = {},
  retry?: WorkerProviderRetryAuditFields,
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: "worker_run_event",
    worker_run_id: decision.worker_run_id,
    rule_version: decision.rule_version,
    signal: decision.signal,
    mode: decision.mode,
    counters: decision.counters,
    thresholds: decision.thresholds,
    elapsed_ms: decision.elapsed_ms,
    termination_source: decision.termination_source,
    action: decision.action,
    ...(decision.failureType ? { failure_type: decision.failureType } : {}),
    ...(decision.count !== undefined ? { count: decision.count } : {}),
    ...(decision.limit !== undefined ? { limit: decision.limit } : {}),
    ...(decision.budget_kind ? { budget_kind: decision.budget_kind } : {}),
    ...(decision.window_size !== undefined ? { window_size: decision.window_size } : {}),
    ...(decision.hash ? { hash: decision.hash } : {}),
    ...(decision.shape ? { shape: decision.shape } : {}),
    ...(decision.coverage ? { coverage: decision.coverage } : {}),
    ...(decision.toolCallId ? { tool_call_id: decision.toolCallId } : {}),
    ...(decision.rule_id ? { rule_id: decision.rule_id } : {}),
    ...(decision.enforce_rule_version ? { enforce_rule_version: decision.enforce_rule_version } : {}),
    ...(decision.signature_hmac ? { signature_hmac: decision.signature_hmac } : {}),
    ...(decision.segment !== undefined ? { segment: decision.segment } : {}),
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
    ...(correlation.dispatchRunId ? { dispatch_run_id: correlation.dispatchRunId } : {}),
    ...(correlation.taskIndex !== undefined ? { task_index: correlation.taskIndex } : {}),
    ...(correlation.taskCount !== undefined ? { task_count: correlation.taskCount } : {}),
    ...(correlation.task ? { task: correlation.task } : {}),
    ...(correlation.workflowRunId ? { workflow_run_id: correlation.workflowRunId } : {}),
    ...(correlation.workflowStageId ? { workflow_stage_id: correlation.workflowStageId } : {}),
    ...(correlation.workflow ? { workflow: correlation.workflow } : {}),
    ...(retry ?? {}),
  };
}

/**
 * Audit-only provider_retry start row for paths where the governor never
 * observed the retry (settings.enabled=false, or already terminal). It is a
 * dedicated builder, NOT a fabricated WorkerRunGovernorDecision: it projects
 * the honest summary snapshot (counters stay untouched — all-zero when the
 * governor is disabled), never mutates counters, never triggers termination,
 * and pairs with the end row via worker_run_id + correlation joins. The
 * `no_governor_transition` action keeps the semantics explicit.
 */
export function buildWorkerRunRetryStartAuditEvent(
  summary: WorkerRunGovernanceSummary,
  elapsedMs: number,
  retry: WorkerProviderRetryAuditFields,
  correlation: WorkerRunAuditCorrelation = {},
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: "worker_run_event",
    worker_run_id: summary.worker_run_id,
    rule_version: summary.rule_version,
    signal: "provider_retry_start",
    mode: "observe",
    counters: summary.counters,
    thresholds: summary.thresholds,
    elapsed_ms: Math.max(0, Math.floor(elapsedMs)),
    termination_source: "none",
    action: "audit_provider_retry_start_no_governor_transition",
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
    ...(correlation.dispatchRunId ? { dispatch_run_id: correlation.dispatchRunId } : {}),
    ...(correlation.taskIndex !== undefined ? { task_index: correlation.taskIndex } : {}),
    ...(correlation.taskCount !== undefined ? { task_count: correlation.taskCount } : {}),
    ...(correlation.task ? { task: correlation.task } : {}),
    ...(correlation.workflowRunId ? { workflow_run_id: correlation.workflowRunId } : {}),
    ...(correlation.workflowStageId ? { workflow_stage_id: correlation.workflowStageId } : {}),
    ...(correlation.workflow ? { workflow: correlation.workflow } : {}),
    ...retry,
  };
}

export function buildWorkerRunRetryOutcomeAuditEvent(
  summary: WorkerRunGovernanceSummary,
  elapsedMs: number,
  retry: WorkerProviderRetryAuditFields,
  correlation: WorkerRunAuditCorrelation = {},
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: "worker_run_event",
    worker_run_id: summary.worker_run_id,
    rule_version: summary.rule_version,
    signal: "provider_retry_end",
    mode: summary.terminal ? "abort" : "observe",
    counters: summary.counters,
    thresholds: summary.thresholds,
    elapsed_ms: Math.max(0, Math.floor(elapsedMs)),
    termination_source: summary.terminal?.termination_source ?? "none",
    action: "audit_provider_retry_end_no_governor_transition",
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
    ...(correlation.dispatchRunId ? { dispatch_run_id: correlation.dispatchRunId } : {}),
    ...(correlation.taskIndex !== undefined ? { task_index: correlation.taskIndex } : {}),
    ...(correlation.taskCount !== undefined ? { task_count: correlation.taskCount } : {}),
    ...(correlation.task ? { task: correlation.task } : {}),
    ...(correlation.workflowRunId ? { workflow_run_id: correlation.workflowRunId } : {}),
    ...(correlation.workflowStageId ? { workflow_stage_id: correlation.workflowStageId } : {}),
    ...(correlation.workflow ? { workflow: correlation.workflow } : {}),
    ...retry,
  };
}

/** S4 audit-only projection: the strict persistent project key was unavailable
 *  (unsafe directory / wrong mode / owner / symlink), so the schema classifier
 *  failed open to not-a-rejection with a closed eligibility reason — the
 *  shadow candidate was not eligible and enforce never triggered. Written at
 *  most once per run (wiring singleflight). Never mutates counters, never
 *  triggers termination. */
export function buildStormEnforceDegradedAuditEvent(
  summary: WorkerRunGovernanceSummary,
  elapsedMs: number,
  correlation: WorkerRunAuditCorrelation = {},
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: STORM_ENFORCE_ROW_KIND,
    worker_run_id: summary.worker_run_id,
    rule_version: summary.rule_version,
    signal: STORM_ENFORCE_DEGRADED_SIGNAL,
    mode: "observe",
    counters: summary.counters,
    thresholds: summary.thresholds,
    elapsed_ms: Math.max(0, Math.floor(elapsedMs)),
    termination_source: "none",
    action: "audit_storm_enforce_degraded_strict_key_unavailable",
    rule_id: STORM_ENFORCE_RULE_ID,
    enforce_rule_version: WORKER_RUN_STORM_ENFORCE_RULE_VERSION,
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
    ...(correlation.dispatchRunId ? { dispatch_run_id: correlation.dispatchRunId } : {}),
    ...(correlation.taskIndex !== undefined ? { task_index: correlation.taskIndex } : {}),
    ...(correlation.taskCount !== undefined ? { task_count: correlation.taskCount } : {}),
    ...(correlation.task ? { task: correlation.task } : {}),
    ...(correlation.workflowRunId ? { workflow_run_id: correlation.workflowRunId } : {}),
    ...(correlation.workflowStageId ? { workflow_stage_id: correlation.workflowStageId } : {}),
    ...(correlation.workflow ? { workflow: correlation.workflow } : {}),
  };
}

/** S4 audit-only marker: enforce is enabled but observeAfter !== 3, so the
 *  production-supported consecutive branch is unsupported and never aborts.
 *  Written exactly once per run (at run start). Never mutates counters, never
 *  triggers termination. */
export function buildStormEnforceUnsupportedCapAuditEvent(
  summary: WorkerRunGovernanceSummary,
  elapsedMs: number,
  correlation: WorkerRunAuditCorrelation = {},
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: STORM_ENFORCE_ROW_KIND,
    worker_run_id: summary.worker_run_id,
    rule_version: summary.rule_version,
    signal: STORM_ENFORCE_UNSUPPORTED_CAP_SIGNAL,
    mode: "observe",
    counters: summary.counters,
    thresholds: summary.thresholds,
    elapsed_ms: Math.max(0, Math.floor(elapsedMs)),
    termination_source: "none",
    action: "audit_storm_enforce_unsupported_cap_no_abort",
    rule_id: STORM_ENFORCE_RULE_ID,
    enforce_rule_version: WORKER_RUN_STORM_ENFORCE_RULE_VERSION,
    observe_after: summary.thresholds.schema_error_storm_observe_after,
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
    ...(correlation.dispatchRunId ? { dispatch_run_id: correlation.dispatchRunId } : {}),
    ...(correlation.taskIndex !== undefined ? { task_index: correlation.taskIndex } : {}),
    ...(correlation.taskCount !== undefined ? { task_count: correlation.taskCount } : {}),
    ...(correlation.task ? { task: correlation.task } : {}),
    ...(correlation.workflowRunId ? { workflow_run_id: correlation.workflowRunId } : {}),
    ...(correlation.workflowStageId ? { workflow_stage_id: correlation.workflowStageId } : {}),
    ...(correlation.workflow ? { workflow: correlation.workflow } : {}),
  };
}

export interface WorkerRunGovernanceSummary {
  worker_run_id: string;
  rule_version: typeof WORKER_RUN_GOVERNOR_RULE_VERSION;
  counters: WorkerRunGovernorCounters;
  thresholds: WorkerRunGovernorThresholds;
  requested_output_cap?: number;
  termination_closure?: WorkerTerminationClosureEvidence;
  terminal?: {
    signal: WorkerGovernorSignal;
    termination_source: "worker_run_governor";
    failureType: WorkerGovernorFailureType;
    count?: number;
    limit?: number;
    budget_kind?: "consecutive" | "rolling_window";
    window_size?: number;
    action: string;
    hash?: string;
    shape?: string;
    /** S4 enforce additive fields (only on schema_rejection_storm_enforce). */
    rule_id?: string;
    enforce_rule_version?: string;
    signature_hmac?: { algorithm: "hmac-sha256"; key_id: string; digest: string };
    segment?: number;
  };
}

export interface WorkerGovernorSignalInput {
  signal: WorkerGovernorSignal;
  count?: number;
  limit?: number;
  failureType?: WorkerGovernorFailureType;
  action?: string;
  hash?: string;
  shape?: string;
  coverage?: typeof TOOL_OBSERVER_COVERAGE;
  toolCallId?: string;
  requestedOutputCap?: number;
  providerProgress?: boolean;
}

interface ReadCoverage {
  intervals: Array<[number, number]>;
}

function freshCounters(): WorkerRunGovernorCounters {
  return {
    provider_request_count: 0,
    provider_retry_count: 0,
    provider_retry_consecutive_count: 0,
    provider_retry_window_observation_count: 0,
    provider_retry_window_retry_count: 0,
    provider_retry_window_progress_count: 0,
    assistant_response_count: 0,
    empty_visible_retry_count: 0,
    full_output_cap_hit_count: 0,
    tool_call_count: 0,
    successful_tool_response_count: 0,
    same_file_small_read_churn_count: 0,
    schema_error_storm_count: 0,
  };
}

function fnv1a32(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const SCHEMA_AUDIT_HMAC_KEY = randomBytes(32);
const READ_OVERLAP_EPSILON = 1e-12;

function privateCorrelationHash(value: string): string {
  return createHmac("sha256", SCHEMA_AUDIT_HMAC_KEY).update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pruneOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const key = map.keys().next();
    if (key.done) return;
    map.delete(key.value);
  }
}

function mergeInterval(intervals: Array<[number, number]>, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lo = start;
  let hi = end;
  let inserted = false;
  for (const [a, b] of intervals) {
    if (b < lo) out.push([a, b]);
    else if (hi < a) {
      if (!inserted) out.push([lo, hi]);
      inserted = true;
      out.push([a, b]);
    } else {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  if (!inserted) out.push([lo, hi]);
  return out.slice(-64);
}

function coveredLength(intervals: Array<[number, number]>, start: number, end: number): number {
  let covered = 0;
  for (const [a, b] of intervals) {
    covered += Math.max(0, Math.min(end, b) - Math.max(start, a));
  }
  return Math.min(end - start, covered);
}

function toolErrorText(result: unknown): string {
  const rec = asRecord(result);
  const content = Array.isArray(rec.content) ? rec.content : [];
  for (const part of content) {
    const p = asRecord(part);
    if (typeof p.text === "string" && p.text) return p.text.slice(0, 4096);
  }
  if (typeof rec.error === "string") return rec.error.slice(0, 4096);
  if (typeof rec.message === "string") return rec.message.slice(0, 4096);
  return "unknown tool error";
}

function schemaErrorDescriptor(text: string): { errorClass: string; fieldPath: string; normalized: string; hash: string } {
  const lower = text.toLowerCase();
  const errorClass = /required|missing/.test(lower) ? "missing_required"
    : /unknown|additional propert|unexpected field/.test(lower) ? "unknown_field"
    : /type|expected|must be/.test(lower) ? "invalid_type"
    : /schema|argument|parameter|validation/.test(lower) ? "schema_validation"
    : "tool_error";
  const fieldPath = /(?:field|property|path|parameter|argument)\s*[=:]?\s*["'`]?([^\s"'`,;:]{1,160})/i.exec(text)?.[1]
    ?? /["']([^"'\n]{1,160})["']\s+(?:is|required|must|expected)/i.exec(text)?.[1]
    ?? "unknown";
  const normalized = text.slice(0, 4096).replace(/\s+/g, " ").trim();
  return {
    errorClass,
    fieldPath,
    normalized,
    hash: privateCorrelationHash(`${errorClass}\0${fieldPath}\0${normalized}`),
  };
}

/** Additive S3 export: the governor's schema-error classifier result for a
 *  failed tool result, SAME-SOURCE as the governor's own exact identity
 *  (schemaErrorDescriptor). Returns the CLOSED error class, the field path,
 *  and the bounded whitespace-normalized descriptor (<=4096 chars) that the
 *  governor's exact identity already keys on — the raw error text is
 *  classified inside and never returned, so a shadow evaluator can build an
 *  unambiguous exact identity (tool name + error class + field path +
 *  normalized descriptor) without ever persisting raw text. Returns null when
 *  the error is not schema-rejection shaped (the same decision the governor
 *  makes in observeToolEnd). */
export function classifySchemaErrorToolResult(result: unknown): { errorClass: string; fieldPath: string; normalized: string } | null {
  const descriptor = schemaErrorDescriptor(toolErrorText(result));
  return descriptor.errorClass === "tool_error"
    ? null
    : { errorClass: descriptor.errorClass, fieldPath: descriptor.fieldPath, normalized: descriptor.normalized };
}

export class WorkerRunGovernor {
  readonly termination: Promise<WorkerRunGovernorDecision>;

  private readonly startedAt: number;
  private readonly counters = freshCounters();
  private readonly thresholds: WorkerRunGovernorThresholds;
  private readonly readCoverage = new Map<string, ReadCoverage>();
  private readonly schemaFailures = new Map<string, number>();
  private readonly providerRetryWindow: Array<"retry" | "progress"> = [];
  private resolveTermination!: (decision: WorkerRunGovernorDecision) => void;
  private terminal: WorkerRunGovernorDecision | undefined;
  private requestedOutputCap: number | undefined;

  constructor(
    readonly workerRunId: string,
    readonly settings: WorkerRunGovernorSettings = DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS,
    private readonly cwd = process.cwd(),
    now = Date.now(),
  ) {
    this.startedAt = now;
    this.thresholds = {
      provider_retry_limit: settings.providerBudgets.providerRetryLimit,
      provider_retry_window_size: settings.providerBudgets.providerRetryWindowSize,
      provider_retry_window_limit: settings.providerBudgets.providerRetryWindowLimit,
      empty_visible_retry_limit: settings.providerBudgets.emptyVisibleRetryLimit,
      full_output_cap_limit: settings.providerBudgets.fullOutputCapLimit,
      full_output_usage_ratio: settings.providerBudgets.fullOutputUsageRatio,
      same_file_small_read_churn_observe_after: settings.toolObservers.sameFileSmallReadChurn.observeAfter,
      schema_error_storm_observe_after: settings.toolObservers.schemaErrorStorm.observeAfter,
    };
    this.termination = new Promise<WorkerRunGovernorDecision>((resolve) => {
      this.resolveTermination = resolve;
    });
  }

  get terminalDecision(): WorkerRunGovernorDecision | undefined {
    return this.terminal;
  }

  observe(input: WorkerGovernorSignalInput, now = Date.now()): WorkerRunGovernorDecision | undefined {
    if (this.terminal) return undefined;
    if (!this.settings.enabled) return undefined;
    this.applyCounter(input.signal);
    if (input.signal === "provider_retry") this.recordProviderRetryObservation("retry");
    if (input.signal === "assistant_response" && input.providerProgress === true) {
      this.recordProviderRetryObservation("progress");
    }
    if (input.requestedOutputCap !== undefined) this.requestedOutputCap = input.requestedOutputCap;

    let count = input.count ?? this.countForSignal(input.signal);
    let limit = input.limit;
    let terminal = false;
    let failureType = input.failureType;
    let budgetKind: WorkerRunGovernorDecision["budget_kind"];
    let windowSize: number | undefined;

    if (this.settings.enabled && this.settings.providerBudgets.enabled) {
      if (input.signal === "provider_retry") {
        const consecutiveLimit = this.settings.providerBudgets.providerRetryLimit;
        const windowLimit = this.settings.providerBudgets.providerRetryWindowLimit;
        count = this.counters.provider_retry_consecutive_count;
        limit = consecutiveLimit;
        if (this.counters.provider_retry_consecutive_count > consecutiveLimit) {
          count = this.counters.provider_retry_consecutive_count;
          limit = consecutiveLimit;
          terminal = true;
          failureType = "provider_retry_budget_exceeded";
          budgetKind = "consecutive";
        } else if (this.counters.provider_retry_window_retry_count > windowLimit) {
          count = this.counters.provider_retry_window_retry_count;
          limit = windowLimit;
          terminal = true;
          failureType = "provider_retry_budget_exceeded";
          budgetKind = "rolling_window";
          windowSize = this.settings.providerBudgets.providerRetryWindowSize;
        }
      } else if (input.signal === "empty_visible_retry") {
        limit = this.settings.providerBudgets.emptyVisibleRetryLimit;
        terminal = (count ?? 0) > limit;
        if (terminal) failureType = "empty_visible_retry_budget_exceeded";
      } else if (input.signal === "full_output_cap_hit") {
        limit = this.settings.providerBudgets.fullOutputCapLimit;
        terminal = (count ?? 0) > limit;
        if (terminal) failureType = "full_output_cap_budget_exceeded";
      }
    }
    if (input.signal === "repetitive_output") {
      terminal = this.settings.enabled && this.settings.visibleText.enabled && this.settings.visibleText.abortOnRepeat;
      if (terminal) failureType = "repetitive_output";
    }
    const decision: WorkerRunGovernorDecision = {
      worker_run_id: this.workerRunId,
      rule_version: WORKER_RUN_GOVERNOR_RULE_VERSION,
      signal: input.signal,
      mode: terminal ? "abort" : "observe",
      counters: { ...this.counters },
      thresholds: { ...this.thresholds },
      elapsed_ms: Math.max(0, now - this.startedAt),
      termination_source: terminal ? "worker_run_governor" : "none",
      ...(failureType ? { failureType } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(budgetKind ? { budget_kind: budgetKind } : {}),
      ...(windowSize !== undefined ? { window_size: windowSize } : {}),
      action: input.action ?? (terminal ? "abort_session_return_bounded_partial" : "audit_only"),
      ...(input.hash ? { hash: input.hash } : {}),
      ...(input.shape ? { shape: input.shape } : {}),
      ...(input.coverage ? { coverage: input.coverage } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    };
    if (terminal && failureType) {
      this.terminal = decision;
      this.resolveTermination(decision);
    }
    return decision;
  }

  observeToolStart(toolName: string, args: unknown, toolCallId?: string): WorkerRunGovernorDecision | undefined {
    if (this.terminal) return undefined;
    this.counters.tool_call_count++;
    const cfg = this.settings.toolObservers.sameFileSmallReadChurn;
    if (!this.settings.enabled || !this.settings.toolObservers.enabled || !cfg.enabled || toolName !== "read") return undefined;
    const rec = asRecord(args);
    const rawPath = typeof rec.path === "string" ? rec.path : typeof rec.file_path === "string" ? rec.file_path : "";
    const limit = typeof rec.limit === "number" && Number.isFinite(rec.limit) ? Math.floor(rec.limit) : 0;
    const offset = typeof rec.offset === "number" && Number.isFinite(rec.offset) ? Math.max(1, Math.floor(rec.offset)) : 1;
    if (!rawPath || limit < 1 || limit > cfg.maxWindowLines) return undefined;

    const canonical = path.resolve(this.cwd, rawPath);
    const start = offset;
    const end = offset + limit;
    const coverage = this.readCoverage.get(canonical) ?? { intervals: [] };
    const overlap = coveredLength(coverage.intervals, start, end);
    const overlapRatio = overlap / limit;
    coverage.intervals = mergeInterval(coverage.intervals, start, end);
    this.readCoverage.delete(canonical);
    this.readCoverage.set(canonical, coverage);
    pruneOldest(this.readCoverage, cfg.maxTrackedPaths);

    if (overlapRatio + READ_OVERLAP_EPSILON < cfg.overlapRatio) return undefined;
    this.counters.same_file_small_read_churn_count++;
    const count = this.counters.same_file_small_read_churn_count;
    if (count < cfg.observeAfter) return undefined;
    return this.observe({
      signal: "same_file_small_read_churn",
      count,
      limit: cfg.observeAfter,
      hash: fnv1a32(canonical),
      shape: `read_window:limit<=${cfg.maxWindowLines}:overlap>=${cfg.overlapRatio}`,
      coverage: TOOL_OBSERVER_COVERAGE,
      ...(toolCallId ? { toolCallId } : {}),
      action: "audit_observation_no_abort",
    });
  }

  observeToolEnd(toolName: string, result: unknown, isError: boolean, toolCallId?: string): WorkerRunGovernorDecision | undefined {
    if (this.terminal) return undefined;
    if (!isError) {
      this.counters.successful_tool_response_count++;
      for (const key of [...this.schemaFailures.keys()]) {
        if (key.startsWith(`${toolName}:`)) this.schemaFailures.delete(key);
      }
      return undefined;
    }
    const cfg = this.settings.toolObservers.schemaErrorStorm;
    if (!this.settings.enabled || !this.settings.toolObservers.enabled || !cfg.enabled) return undefined;
    const descriptor = schemaErrorDescriptor(toolErrorText(result));
    if (descriptor.errorClass === "tool_error") return undefined;
    const key = `${toolName}:${descriptor.errorClass}:${descriptor.fieldPath}:${descriptor.hash}`;
    const count = (this.schemaFailures.get(key) ?? 0) + 1;
    this.schemaFailures.delete(key);
    this.schemaFailures.set(key, count);
    pruneOldest(this.schemaFailures, cfg.maxTrackedShapes);
    if (count < cfg.observeAfter) return undefined;
    this.counters.schema_error_storm_count++;
    return this.observe({
      signal: "schema_error_storm",
      count,
      limit: cfg.observeAfter,
      hash: descriptor.hash,
      shape: descriptor.errorClass,
      coverage: TOOL_OBSERVER_COVERAGE,
      ...(toolCallId ? { toolCallId } : {}),
      action: "audit_observation_no_abort",
    });
  }

  /**
   * S4 single-rule enforce (living plan 2026-08-10 STORM-ENFORCE): the ONLY
   * production-supported branch of the authorized rule
   * storm/post-cap-schema-rejection-signature/v1 — the exact consecutive
   * branch. The wiring feeds the pure storm-shadow observation (same strict
   * exact composite signature in the same segment) here; this method builds
   * the REAL abort decision WITHOUT re-applying or incrementing any governor
   * counter (the shadow state machine already counted; the governor's own
   * schema observer stays observe-only and untouched). The decision flows
   * through the existing emitWorkerRunDecision → requestGovernorTermination →
   * FirstWriterTermination chain — never a direct abort / tryClaim / new
   * promise. Rolling-window trips never enter control (basis must be
   * "consecutive"). Post-terminal / already-governor-terminal runs emit
   * nothing.
   */
  enforceSchemaRejectionStorm(
    input: {
      signature: { algorithm: "hmac-sha256"; key_id: string; digest: string };
      segment: number;
      consecutiveCount: number;
      capAfter: number;
      wouldAbortBasis: "consecutive" | "rolling_window" | null;
    },
    now = Date.now(),
  ): WorkerRunGovernorDecision | undefined {
    if (this.terminal) return undefined;
    const cfg = this.settings.toolObservers.schemaErrorStorm;
    if (!this.settings.enabled || !this.settings.toolObservers.enabled || !cfg.enabled || !cfg.enforceConsecutiveExact) return undefined;
    // Only the production-supported cap (observeAfter === 3) is enforced; any
    // other cap is unsupported and never aborts (the wiring writes one
    // unsupported_cap marker per run).
    if (cfg.observeAfter !== 3) return undefined;
    // Trigger: the same strict exact composite signature in the same segment
    // with consecutive_count === 4 && cap_after === 3 && would_abort_basis ===
    // "consecutive". Never would_abort / first_trip alone; rolling-window
    // trips never enter control.
    if (input.consecutiveCount !== 4 || input.capAfter !== 3 || input.wouldAbortBasis !== "consecutive") return undefined;
    const decision: WorkerRunGovernorDecision = {
      worker_run_id: this.workerRunId,
      rule_version: WORKER_RUN_GOVERNOR_RULE_VERSION,
      signal: "schema_rejection_storm_enforce",
      mode: "abort",
      counters: { ...this.counters },
      thresholds: { ...this.thresholds },
      elapsed_ms: Math.max(0, now - this.startedAt),
      termination_source: "worker_run_governor",
      failureType: "schema_rejection_storm_enforced",
      count: input.consecutiveCount,
      limit: input.capAfter,
      budget_kind: "consecutive",
      action: "abort_session_return_bounded_partial",
      rule_id: STORM_ENFORCE_RULE_ID,
      enforce_rule_version: WORKER_RUN_STORM_ENFORCE_RULE_VERSION,
      signature_hmac: input.signature,
      segment: input.segment,
    };
    this.terminal = decision;
    this.resolveTermination(decision);
    return decision;
  }

  snapshot(): WorkerRunGovernanceSummary {
    const terminal = this.terminal;
    return {
      worker_run_id: this.workerRunId,
      rule_version: WORKER_RUN_GOVERNOR_RULE_VERSION,
      counters: { ...this.counters },
      thresholds: { ...this.thresholds },
      ...(this.requestedOutputCap !== undefined ? { requested_output_cap: this.requestedOutputCap } : {}),
      ...(terminal?.failureType ? {
        terminal: {
          signal: terminal.signal,
          termination_source: "worker_run_governor",
          failureType: terminal.failureType,
          ...(terminal.count !== undefined ? { count: terminal.count } : {}),
          ...(terminal.limit !== undefined ? { limit: terminal.limit } : {}),
          ...(terminal.budget_kind ? { budget_kind: terminal.budget_kind } : {}),
          ...(terminal.window_size !== undefined ? { window_size: terminal.window_size } : {}),
          action: terminal.action,
          ...(terminal.hash ? { hash: terminal.hash } : {}),
          ...(terminal.shape ? { shape: terminal.shape } : {}),
          ...(terminal.rule_id ? { rule_id: terminal.rule_id } : {}),
          ...(terminal.enforce_rule_version ? { enforce_rule_version: terminal.enforce_rule_version } : {}),
          ...(terminal.signature_hmac ? { signature_hmac: terminal.signature_hmac } : {}),
          ...(terminal.segment !== undefined ? { segment: terminal.segment } : {}),
        },
      } : {}),
    };
  }

  private recordProviderRetryObservation(observation: "retry" | "progress"): void {
    if (observation === "retry") this.counters.provider_retry_consecutive_count++;
    else this.counters.provider_retry_consecutive_count = 0;

    this.providerRetryWindow.push(observation);
    const maxSize = this.settings.providerBudgets.providerRetryWindowSize;
    if (this.providerRetryWindow.length > maxSize) this.providerRetryWindow.shift();
    this.counters.provider_retry_window_observation_count = this.providerRetryWindow.length;
    this.counters.provider_retry_window_retry_count = this.providerRetryWindow.filter((item) => item === "retry").length;
    this.counters.provider_retry_window_progress_count = this.providerRetryWindow.length - this.counters.provider_retry_window_retry_count;
  }

  private applyCounter(signal: WorkerGovernorSignal): void {
    switch (signal) {
      case "provider_request": this.counters.provider_request_count++; break;
      case "provider_retry": this.counters.provider_retry_count++; break;
      case "assistant_response": this.counters.assistant_response_count++; break;
      case "empty_visible_retry": this.counters.empty_visible_retry_count++; break;
      case "full_output_cap_hit": this.counters.full_output_cap_hit_count++; break;
    }
  }

  private countForSignal(signal: WorkerGovernorSignal): number | undefined {
    switch (signal) {
      case "provider_request": return this.counters.provider_request_count;
      case "provider_retry": return this.counters.provider_retry_count;
      case "assistant_response": return this.counters.assistant_response_count;
      case "empty_visible_retry": return this.counters.empty_visible_retry_count;
      case "full_output_cap_hit": return this.counters.full_output_cap_hit_count;
      case "same_file_small_read_churn": return this.counters.same_file_small_read_churn_count;
      case "schema_error_storm": return this.counters.schema_error_storm_count;
      default: return undefined;
    }
  }
}
