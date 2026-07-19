/**
 * Pure per-run governance state machine for bounded dispatch/workflow workers.
 *
 * One instance owns one and only one governance termination promise. External
 * parent abort and wall-clock timeouts remain lifecycle owners outside this
 * module. Task-governor audit stages, provider budgets, visible repetition,
 * and bounded tool observations enter here as signals; first terminal wins.
 */

import { createHmac, randomBytes } from "node:crypto";
import * as path from "node:path";

export const WORKER_RUN_GOVERNOR_RULE_VERSION = "dispatch-worker-run-governor/v2";
export const TOOL_OBSERVER_COVERAGE = "post_execution_only";

export type WorkerGovernorFailureType =
  | "repetitive_output"
  | "provider_retry_budget_exceeded"
  | "empty_visible_retry_budget_exceeded"
  | "full_output_cap_budget_exceeded";

export type WorkerGovernorSignal =
  | "requested_output_cap"
  | "provider_request"
  | "provider_retry"
  | "assistant_response"
  | "empty_visible_retry"
  | "full_output_cap_hit"
  | "repetitive_output"
  | "task_governor_checkpoint"
  | "task_governor_audit_pause"
  | "task_governor_fresh_auth"
  | "same_file_small_read_churn"
  | "schema_error_storm";

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
  task_governor_checkpoint_count: number;
  task_governor_audit_pause_count: number;
  task_governor_fresh_auth_count: number;
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
    },
  },
};

export interface WorkerRunGovernorDecision {
  worker_run_id: string;
  rule_version: typeof WORKER_RUN_GOVERNOR_RULE_VERSION;
  profile: string;
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
}

export interface WorkerRunAuditCorrelation {
  dispatchToolCallId?: string;
  taskIndex?: number;
  taskCount?: number;
  task?: string;
  workflowRunId?: string;
  workflowStageId?: string;
  workflow?: string;
}

export function buildWorkerRunAuditEvent(
  decision: WorkerRunGovernorDecision,
  correlation: WorkerRunAuditCorrelation = {},
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: "worker_run_event",
    worker_run_id: decision.worker_run_id,
    rule_version: decision.rule_version,
    profile: decision.profile,
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
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
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
  profile: string;
  counters: WorkerRunGovernorCounters;
  thresholds: WorkerRunGovernorThresholds;
  requested_output_cap?: number;
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
    task_governor_checkpoint_count: 0,
    task_governor_audit_pause_count: 0,
    task_governor_fresh_auth_count: 0,
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

function schemaErrorDescriptor(text: string): { errorClass: string; fieldPath: string; hash: string } {
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
    hash: privateCorrelationHash(`${errorClass}\0${fieldPath}\0${normalized}`),
  };
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
    readonly profile: string,
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
    if (!this.settings.enabled && !input.signal.startsWith("task_governor_")) return undefined;
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
      profile: this.profile,
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

  snapshot(): WorkerRunGovernanceSummary {
    const terminal = this.terminal;
    return {
      worker_run_id: this.workerRunId,
      rule_version: WORKER_RUN_GOVERNOR_RULE_VERSION,
      profile: this.profile,
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
      case "task_governor_checkpoint": this.counters.task_governor_checkpoint_count++; break;
      case "task_governor_audit_pause": this.counters.task_governor_audit_pause_count++; break;
      case "task_governor_fresh_auth": this.counters.task_governor_fresh_auth_count++; break;
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
      case "task_governor_checkpoint": return this.counters.task_governor_checkpoint_count;
      case "task_governor_audit_pause": return this.counters.task_governor_audit_pause_count;
      case "task_governor_fresh_auth": return this.counters.task_governor_fresh_auth_count;
      default: return undefined;
    }
  }
}
