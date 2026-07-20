export type ConstraintInjectMode = "always" | "listed";

export type ConstraintScope = { kind: "global" } | { kind: "project"; projectId: string };

export type LegacyRuleStatus = "active" | "contested" | "archived" | "superseded" | "deprecated" | "unknown";

export type ConstraintCategoryHint =
  | "behavioral_constraint"
  | "settings_not_memory"
  | "tool_contract_not_memory"
  | "knowledge_not_constraint"
  | "potential_conflict_signal"
  | "unknown";

export type ConstraintSourceKind = "legacy_rule" | "audit" | "governance_case" | "constraint_event";

export type ConstraintProvenanceClass = "user-expressed" | "assistant-observed" | "content-in-transcript" | string;

export type ConstraintRuleKind = "maxim" | "decision" | "anti-pattern" | "pattern" | "fact" | "preference" | "smell" | string;

export interface SourceRef {
  path?: string;
  line?: number;
  byteOffset?: number;
  ref: string;
}

export interface LegacyRuleSourceRecord {
  sourceKind: "legacy_rule";
  sourceId: string;
  slug: string;
  title: string;
  path: string;
  scope: ConstraintScope;
  injectMode: ConstraintInjectMode;
  status: LegacyRuleStatus;
  body: string;
  rawBodyHash: string;
  computedBodyHash: string;
  rawFileHash: string;
  frontmatterHash: string;
  provenance: ConstraintProvenanceClass;
  confidence: number;
  kind: ConstraintRuleKind;
  triggerPhrases: string[];
  appliesWhen: string;
  mustDoSummary: string;
  created?: string;
  updated?: string;
  frontmatter: Record<string, unknown>;
  timelineEvents: string[];
  sourceRef: SourceRef;
}

export interface AuditConstraintSourceRecord {
  sourceKind: "audit";
  sourceId: string;
  timestamp?: string;
  sessionId?: string;
  operation?: string;
  lane?: string;
  ruleSlug?: string;
  ruleScope?: "global" | "project" | string;
  projectId?: string;
  reason?: string;
  rawSanitizedRow: string;
  sourceRef: SourceRef;
}

export type GovernanceCaseCategory =
  | "settings_tool_not_memory"
  | "scope_misroute"
  | "near_duplicate"
  | "conflict"
  | "over_compaction"
  | "raw_agent_end_write_regression"
  | string;

export interface GovernanceCaseRecord {
  sourceKind: "governance_case";
  sourceId: string;
  category: GovernanceCaseCategory;
  title: string;
  expectation: string;
  sourceRef: SourceRef;
}

export interface ConstraintEventSourceRecord {
  sourceKind: "constraint_event";
  sourceId: string;
  eventId: string;
  eventType: string;
  createdAtUtc: string;
  sessionId: string;
  turnId: string;
  sourceChannel: "agent_end" | "manual" | "replay" | string;
  sourceRole: "user" | "assistant" | "system" | "tool" | string;
  operationHint: string;
  confidence?: number;
  sanitizedQuote: string;
  candidateText: string;
  candidateTitle?: string;
  candidateTriggerPhrases: string[];
  candidateAppliesWhen?: string;
  candidatePriorityHint: "always" | "listed" | "unknown" | string;
  notMemoryHint?: string;
  unclassifiedReason?: string;
  scopeHint:
    | { kind: "global"; evidence: string }
    | { kind: "project"; projectId: string; evidence: string }
    | { kind: "unknown"; reason: string };
  activeProjectId?: string;
  scopeConfidence?: number;
  sanitizerStatus: string;
  sanitizerReplacementsCount: number;
  legacyParallelWrite?: {
    attempted: boolean;
    legacy_path_kind?: string;
    legacy_operation_hint?: string;
    legacy_audit_ref?: string;
  };
  causalParents: string[];
  producerName: string;
  producerVersion: string;
  replayProvenance?: {
    source: "historical_audit_backfill";
    auditJsonlPath: string;
    auditJsonlSha256: string;
    auditRowIndex: number;
    auditRowTimestamp: string;
    auditRowOperation: string;
    auditRowSessionId?: string;
    auditRowCorrelationId?: string;
    auditRowCandidateId?: string;
    auditRowGitCommit?: string;
    replayRunId: string;
    replayHarnessVersion: string;
    mappingTableVersion: string;
    mappingTableSha256: string;
    approximation: string;
  };
  bodyHash: string;
  rawFilePath: string;
  sourceRef: SourceRef;
}

export type ConstraintSourceRecord = LegacyRuleSourceRecord | AuditConstraintSourceRecord | GovernanceCaseRecord | ConstraintEventSourceRecord;

export interface NormalizedConstraintRecord {
  sourceKind: ConstraintSourceKind;
  sourceId: string;
  scope?: ConstraintScope;
  injectMode?: ConstraintInjectMode;
  status?: LegacyRuleStatus;
  title?: string;
  body?: string;
  categoryHint: ConstraintCategoryHint;
  sourceHash: string;
  normalized: Record<string, unknown>;
  sanitizerReplacements: string[];
}

export interface NormalizeConstraintOptions {
  activeProjectId?: string;
  knownProjectIds?: string[];
  compilerOptions?: Record<string, unknown>;
  auditTruncation?: Record<string, unknown>;
}

export interface NormalizeConstraintResult {
  records: NormalizedConstraintRecord[];
  inputRootHash: string;
  diagnostics: ConstraintShadowDiagnostic[];
}

export type ConstraintExclusionReason =
  | "settings_not_memory"
  | "tool_contract_not_memory"
  | "knowledge_candidate"
  | "obsolete_archived"
  | "superseded_observed"
  | "legacy_archived_observed"
  | "malformed_unusable";

export type ConstraintUnresolvedReason =
  | "conflict"
  | "scope_ambiguous"
  | "insufficient_provenance"
  | "parse_error"
  | "model_uncertain"
  | "unknown_status"
  | "trigger_projection_loss";

export interface ConstraintDecisionTrace {
  reason: string;
  sourceRecordIds: string[];
  diagnosticIds?: string[];
}

export interface ConstraintDecisionConstraint {
  constraintId?: string;
  scope: ConstraintScope;
  injectMode: ConstraintInjectMode;
  title: string;
  compiledBody: string;
  mustDoSummary?: string;
  appliesWhen?: string;
  triggerPhrases?: string[];
  priorityHint?: number;
  sourceRecordIds: string[];
  sourceAuditIds?: string[];
  decisionTrace?: ConstraintDecisionTrace;
}

export interface ConstraintDecisionExclusion {
  reason: ConstraintExclusionReason;
  sourceRecordIds: string[];
  diagnosticIds?: string[];
  note?: string;
}

export interface ConstraintDecisionUnresolved {
  reason: ConstraintUnresolvedReason;
  sourceRecordIds: string[];
  diagnosticIds?: string[];
  note?: string;
}

export interface ConstraintDecisionMerge {
  sourceRecordIds: string[];
  targetConstraintId?: string;
  reason: string;
}

export interface ConstraintDecisionRescopeProposal {
  sourceRecordIds: string[];
  fromScope: ConstraintScope;
  toScope: ConstraintScope;
  reason: string;
}

export type ConstraintSourceDisposition = "compiled" | "merged_source" | "excluded" | "unresolved" | "diagnostic";

export interface ConstraintDecisionMapping {
  sourceRecordId: string;
  disposition: ConstraintSourceDisposition;
  targetId?: string;
  reason?: string;
}

export interface ConstraintCompilerDecision {
  schemaVersion: "constraint-shadow-decision/v1";
  inputRootHash: string;
  constraints: ConstraintDecisionConstraint[];
  exclusions: ConstraintDecisionExclusion[];
  unresolved: ConstraintDecisionUnresolved[];
  merges: ConstraintDecisionMerge[];
  rescopeProposals: ConstraintDecisionRescopeProposal[];
  mappings: ConstraintDecisionMapping[];
  diagnostics: ConstraintShadowDiagnostic[];
}

export interface ValidatedConstraint extends ConstraintDecisionConstraint {
  constraintId: string;
}

export interface ValidatedConstraintCompilerDecision extends ConstraintCompilerDecision {
  constraints: ValidatedConstraint[];
  validationHash: string;
}

export interface ConstraintCompilerPromptInput {
  normalized: NormalizeConstraintResult;
  knownProjectIds?: string[];
  activeProjectId?: string;
  maxPromptChars?: number;
  baselineSummary?: string;
}

export interface ConstraintCompilerPrompt {
  schemaVersion: "constraint-shadow-prompt/v1";
  inputRootHash: string;
  promptHash: string;
  text: string;
  recordCount: number;
}

export interface ConstraintMergedSourceVerifierPrompt {
  schemaVersion: "constraint-merged-source-verifier-prompt/v1";
  inputRootHash: string;
  decisionValidationHash: string;
  decisionHash: string;
  verifierInputHash: string;
  promptHash: string;
  text: string;
  rowCount: number;
}

export interface ConstraintCompilerInvokeRequest {
  prompt: ConstraintCompilerPrompt;
  modelRef?: string;
  signal?: AbortSignal;
}

export type ConstraintCompilerInvokeResult = {
  ok: true;
  text: string;
  modelRef?: string;
  durationMs?: number;
} | {
  ok: false;
  error: string;
  modelRef?: string;
  durationMs?: number;
};

export type ConstraintCompilerInvoker = (request: ConstraintCompilerInvokeRequest) => Promise<ConstraintCompilerInvokeResult>;

export interface ConstraintMergedSourceVerifierInvokeRequest {
  prompt: ConstraintMergedSourceVerifierPrompt;
  modelRef?: string;
  signal?: AbortSignal;
}

export type ConstraintMergedSourceVerifierInvokeResult = {
  ok: true;
  text: string;
  modelRef?: string;
  durationMs?: number;
} | {
  ok: false;
  error: string;
  modelRef?: string;
  durationMs?: number;
};

export type ConstraintMergedSourceVerifierInvoker = (request: ConstraintMergedSourceVerifierInvokeRequest) => Promise<ConstraintMergedSourceVerifierInvokeResult>;

export type ParsedConstraintCompilerDecision = {
  ok: true;
  decision: ConstraintCompilerDecision;
  rawOutput: string;
  rawOutputHash: string;
  parsedOutputHash: string;
} | {
  ok: false;
  diagnostic: ConstraintShadowDiagnostic;
  rawOutput: string;
  rawOutputHash: string;
};

export type ConstraintCompilerRunResult = {
  ok: true;
  decision: ConstraintCompilerDecision;
  prompt: ConstraintCompilerPrompt;
  rawOutput: string;
  rawOutputHash: string;
  parsedOutputHash: string;
  modelRef?: string;
  durationMs?: number;
} | {
  ok: false;
  prompt: ConstraintCompilerPrompt;
  diagnostic: ConstraintShadowDiagnostic;
  rawOutput?: string;
  rawOutputHash?: string;
  modelRef?: string;
  durationMs?: number;
};

export type ParsedConstraintMergedSourceVerifierOutput = {
  ok: true;
  rows: Array<{
    eventId: string;
    sourceRecordId: string;
    targetConstraintId: string;
    verdict: "expressed" | "not_expressed" | "uncertain";
    confidence: ConstraintMergedSourceVerifierConfidence;
    reasoning: string;
  }>;
  rawOutput: string;
  rawOutputHash: string;
  parsedOutputHash: string;
} | {
  ok: false;
  diagnostic: ConstraintShadowDiagnostic;
  rawOutput: string;
  rawOutputHash: string;
};

export type ConstraintMergedSourceVerifierRunResult = {
  ok: true;
  prompt: ConstraintMergedSourceVerifierPrompt;
  report: ConstraintMergedSourceVerifierReport;
  rawOutput: string;
  rawOutputHash: string;
  parsedOutputHash: string;
  modelRef?: string;
  durationMs?: number;
} | {
  ok: false;
  prompt?: ConstraintMergedSourceVerifierPrompt;
  diagnostic: ConstraintShadowDiagnostic;
  rawOutput?: string;
  rawOutputHash?: string;
  modelRef?: string;
  durationMs?: number;
};

export type ConstraintEventCoverageDispositionKind =
  | "projected"
  | "projected_via_verifier"
  | "deferred_merged_source"
  | "deferred_unresolved"
  | "coverage_gap"
  | "stale_threshold"
  | "invalid"
  | "append_failed";

export type ConstraintEventCoverageDispositionAction =
  | "count_projected"
  | "exclude_from_injectable_denominator"
  | "emit_coverage_gap"
  | "emit_stale_threshold"
  | "count_invalid"
  | "count_append_failed";

export type ConstraintEventCoverageVerifierVerdict = "not_evaluated" | "expressed" | "not_expressed" | "uncertain";
export type ConstraintMergedSourceVerifierConfidence = "high" | "medium" | "low";

export interface ConstraintEventCoverageDisposition {
  kind: ConstraintEventCoverageDispositionKind;
  action: ConstraintEventCoverageDispositionAction;
  reason: string;
  targetConstraintIds?: string[];
  mergeReasons?: string[];
  verifierVerdict?: ConstraintEventCoverageVerifierVerdict;
  verifierConfidence?: ConstraintMergedSourceVerifierConfidence;
  verifierInputHash?: string;
  verifierReasoning?: string;
}

export interface ConstraintMergedSourceVerifierRow {
  eventId: string;
  sourceRecordId: string;
  eventBodyHash: string;
  targetConstraintId: string;
  targetContentHash: string;
  verdict: "expressed" | "not_expressed" | "uncertain";
  confidence: ConstraintMergedSourceVerifierConfidence;
  reasoning: string;
}

export interface ConstraintMergedSourceVerifierSummary {
  totalRows: number;
  expressedRows: number;
  notExpressedRows: number;
  uncertainRows: number;
  invalidRows?: number;
  staleBindingRows?: number;
}

export interface ConstraintMergedSourceVerifierGeneratorMetadata {
  modelRef?: string;
  promptHash?: string;
  rawOutputHash?: string;
  parsedOutputHash?: string;
  durationMs?: number;
}

export interface ConstraintMergedSourceVerifierReport {
  schemaVersion: "constraint-merged-source-verifier/v1";
  inputRootHash: string;
  decisionValidationHash: string;
  decisionHash: string;
  verifierInputHash: string;
  summary: ConstraintMergedSourceVerifierSummary;
  rows: ConstraintMergedSourceVerifierRow[];
  generator?: ConstraintMergedSourceVerifierGeneratorMetadata;
}

export interface ConstraintEventCoverageReport {
  schemaVersion: "constraint-event-coverage/v1";
  summary: {
    totalEvents: number;
    validEvents: number;
    invalidEvents: number;
    queuedEvents: number;
    projectedEvents: number;
    staleEvents: number;
    appendFailedEvents: number;
    deferredMergedSourceEvents: number;
    deferredUnresolvedEvents: number;
    oldestQueuedAgeMs?: number;
    coverageRatio: number;
    injectableCoverageRatio: number;
    provenance: {
      liveEvents: number;
      replayBackfillEvents: number;
      manualEvents: number;
      unknownEvents: number;
    };
  };
  rows: Array<{
    eventId: string;
    sourceRecordId: string;
    status: "queued" | "projected" | "stale" | "invalid" | "append_failed";
    disposition?: ConstraintSourceDisposition;
    coverageDisposition?: ConstraintEventCoverageDisposition;
    observedAtUtc?: string;
    projectedAtUtc?: string;
    diagnostics: string[];
    provenance?: ConstraintEventSourceRecord["replayProvenance"];
    sourceChannel?: string;
  }>;
}

export interface ConstraintLegacyParallelDeltaReport {
  schemaVersion: "constraint-legacy-parallel-delta/v1";
  summary: {
    totalEventsWithLegacyWrite: number;
    matchedOutcomes: number;
    mismatchedOutcomes: number;
    eventOnlySignals: number;
  };
  rows: Array<{
    eventId: string;
    sourceRecordId: string;
    legacyOperationHint?: string;
    compilerDisposition?: ConstraintSourceDisposition;
    status: "matched" | "mismatched" | "event_only";
    reason: string;
  }>;
}

export interface ConstraintShadowRunOptions {
  abrainHome: string;
  cwd: string;
  activeProjectId?: string;
  knownProjectIds?: string[];
  includeProjects?: LegacyConstraintScanOptions["includeProjects"];
  includeStatuses?: LegacyConstraintScanOptions["includeStatuses"];
  normalizeOptions?: NormalizeConstraintOptions;
  maxPromptChars?: number;
  modelRef?: string;
  // ADR0039 §B (T0 consensus 2026-06-23): validation/parse-feedback retry.
  // Attempt invoke+parse+validate up to 1+maxCompileRetries times; on failure
  // re-prompt the model with the exact error so it self-corrects. 0 = single-shot.
  maxCompileRetries?: number;
  // Model used for the FINAL retry attempt only (stronger / alternate route).
  // Empty/undefined = keep modelRef for every attempt.
  escalationModelRef?: string;
  compilerInvoker: ConstraintCompilerInvoker;
  writeArtifacts?: boolean;
  artifactRoot?: string;
  runId?: string;
  eventStaleAfterMs?: number;
  nowMs?: number;
  mergedSourceVerifier?: ConstraintMergedSourceVerifierReport;
  generateMergedSourceVerifier?: boolean;
  verifierInvoker?: ConstraintMergedSourceVerifierInvoker;
  verifierModelRef?: string;
  verifierMaxPromptChars?: number;
  // ADR0039 Constraint L2 (NS-2/FIX-1): when "repo", 固化 the validated decision
  // as an immutable L1 projection event and render the deterministic L2 view to
  // git-tracked l2/views/constraint/ (SHADOW; injection still reads .state).
  l2OutputRoot?: "state" | "repo";
  /** Return a frozen deterministic projection plan instead of mutating repo L1/L2. */
  deferRepoProjection?: boolean;
  deviceId?: string;
}

export interface ConstraintRepoProjectionPlan {
  schemaVersion: "constraint-repo-projection-plan/v1";
  inputRootHash: string;
  inputEventIds: readonly string[];
  decision: ValidatedConstraintCompilerDecision;
  provenance: {
    model: string;
    prompt_hash: string;
    input_hash: string;
    raw_output_hash: string;
    parsed_output_hash?: string;
    acceptance: "accepted_for_event_append";
  };
  createdAtUtc: string;
  deviceId: string;
  producerVersion: string;
}

export interface ConstraintShadowInputSnapshot {
  inputRootHash: string;
  inputEventIds: readonly string[];
}

export interface ConstraintShadowRunArtifacts {
  root: string;
  runDir: string;
  latestDir: string;
  files: Record<string, string>;
}

export type ConstraintShadowRunResult = {
  ok: true;
  inputRootHash: string;
  sourceCount: number;
  prompt: ConstraintCompilerPrompt;
  decision: ValidatedConstraintCompilerDecision;
  view: RenderedConstraintView;
  diff: ConstraintDiffReport;
  eventCoverage?: ConstraintEventCoverageReport;
  legacyParallelDelta?: ConstraintLegacyParallelDeltaReport;
  mergedSourceVerifier?: ConstraintMergedSourceVerifierReport;
  diagnostics: ConstraintShadowDiagnostic[];
  artifacts?: ConstraintShadowRunArtifacts;
  repoProjectionPlan?: ConstraintRepoProjectionPlan;
  l2Projection?: {
    status: string;
    eventId?: string;
    l2RelativePath: string;
    decisionHash: string;
  };
} | {
  ok: false;
  inputRootHash: string;
  sourceCount: number;
  prompt?: ConstraintCompilerPrompt;
  diagnostics: ConstraintShadowDiagnostic[];
  artifacts?: ConstraintShadowRunArtifacts;
};

export type ConstraintShadowDiagnosticSeverity = "info" | "warning" | "error";

export type ConstraintShadowDiagnosticConsumer =
  | "diff_report"
  | "p2_event_schema_backlog"
  | "not_memory_audit"
  | "scope_review"
  | "compiler_prompt_iteration"
  | "manual_investigation"
  | "compiler_liveness_report"
  | "p3_injection_readiness";

export type ConstraintShadowDiagnosticCode =
  | "SC_INPUT_MALFORMED_RULE"
  | "SC_INPUT_MISSING_LEGACY_REF"
  | "SC_INPUT_BODY_HASH_MISMATCH"
  | "SC_AUDIT_TRUNCATED"
  | "SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS"
  | "SC_SCOPE_AMBIGUOUS"
  | "SC_SCOPE_RESCOPE_PROPOSED"
  | "SC_NOT_MEMORY_SETTINGS"
  | "SC_NOT_MEMORY_TOOL_CONTRACT"
  | "SC_NOT_MEMORY_SUBTYPE_NORMALIZED"
  | "SC_DIAGNOSTIC_DECISION_INCONSISTENCY"
  | "SC_NEAR_DUPLICATE_GROUP"
  | "SC_CONFLICT_DETECTED"
  | "SC_COMPACT_REQUIRED"
  | "SC_ARCHIVED_REACTIVATION_RISK"
  | "SC_LEGACY_INJECTION_DELTA"
  | "SC_RENDER_DRIFT"
  | "SC_COMPILER_MODEL_UNAVAILABLE"
  | "SC_COMPILER_PARSE_FAILED"
  | "SC_COMPILER_VALIDATION_FAILED"
  | "SC_MERGED_SOURCE_VERIFIER_PARSE_FAILED"
  | "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE"
  | "SC_COMPILER_RETRY_ATTEMPT"
  | "SC_COMPILER_ITEM_REJECTED"
  | "SC_EXCLUSION_REASON_RECLASSIFIED"
  | "SC_SOURCE_MULTI_HOME_QUARANTINED"
  | "SC_EXCLUSION_DEDUPED"
  | "SC_MAPPING_DISPOSITION_NORMALIZED"
  | "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED"
  | "SC_EMPTY_CONSTRAINT_DROPPED"
  | "SC_ACTIVE_EXCLUSION_DROPPED"
  | "SC_SHADOW_ONLY_VIOLATION_ATTEMPT"
  | "SC_UNCLASSIFIED"
  | "SC_EVENT_READ_ERROR"
  | "SC_EVENT_COVERAGE_GAP"
  | "SC_EVENT_STALE_THRESHOLD"
  | "SC_MERGED_SOURCE_VERIFIER_NOT_EXPRESSED"
  | "SC_LEGACY_PARALLEL_DELTA"
  | "SC_EVENT_NOT_MEMORY_LEAK"
  | "SC_EVENT_SCOPE_BREACH"
  // ADR0039 Constraint L2 (4×T0 v3 bundle-b): repo-mode 固化/L2 write failed.
  // The repo block is best-effort (never breaks the run); this surfaces the
  // otherwise-swallowed failure into the diagnostics stream for observability.
  | "SC_L2_WRITE_FAILED";

export interface ConstraintShadowDiagnostic {
  id: string;
  code: ConstraintShadowDiagnosticCode;
  severity: ConstraintShadowDiagnosticSeverity;
  message: string;
  sourceRecordIds: string[];
  consumers: ConstraintShadowDiagnosticConsumer[];
  data?: Record<string, unknown>;
}

export interface RenderedConstraintView {
  schemaVersion: "constraint-shadow-view/v1";
  shadowOnly: true;
  inputRootHash: string;
  decisionHash: string;
  shadowOutputHash: string;
  markdown: string;
}

export type ConstraintDiffCategory =
  | "kept"
  | "compact"
  | "merge_near_duplicates"
  | "rescope_global_to_project"
  | "rescope_project_to_global"
  | "exclude_not_memory_settings"
  | "exclude_not_memory_tool_contract"
  | "split_knowledge_candidate"
  | "mark_conflict"
  | "keep_unresolved"
  | "legacy_archived_observed"
  | "missing_mapping";

export interface ConstraintDiffRow {
  sourceRecordId: string;
  // ADR0039 P5 (4×T0 v4): pure copy of the source's scope+status so the
  // corpus-split view can stratify per-row without reaching back into the
  // decision/sources (read-only-from-ConstraintDiffReport contract).
  scope: ConstraintScope;
  sourceStatus: LegacyRuleStatus;
  category: ConstraintDiffCategory;
  disposition: ConstraintSourceDisposition;
  targetId?: string;
  reason?: string;
}

export interface ConstraintDiffReport {
  schemaVersion: "constraint-shadow-diff/v1";
  summary: {
    totalSources: number;
    mappedSources: number;
    unmappedSources: number;
    constraints: number;
    exclusions: number;
    unresolved: number;
    rescopeProposals: number;
    notMemory: number;
    conflicts: number;
    archivedObserved: number;
    validationStatus: "valid" | "invalid";
  };
  rows: ConstraintDiffRow[];
  markdown: string;
}

export interface LegacyConstraintScanOptions {
  abrainHome: string;
  cwd: string;
  includeProjects?: "active" | "all" | string[];
  includeStatuses?: "all" | "active_only";
  activeProjectId?: string;
  maxAuditRows?: number;
}

export interface LegacyConstraintScanResult {
  abrainHome: string;
  cwd: string;
  activeProjectId?: string;
  bindingReason?: string;
  rules: LegacyRuleSourceRecord[];
  audits: AuditConstraintSourceRecord[];
  warnings: ConstraintShadowDiagnostic[];
}
