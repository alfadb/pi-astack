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

export type ConstraintSourceKind = "legacy_rule" | "audit" | "governance_case";

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

export type ConstraintSourceRecord = LegacyRuleSourceRecord | AuditConstraintSourceRecord | GovernanceCaseRecord;

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
  | "unknown_status";

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

export type ConstraintShadowDiagnosticSeverity = "info" | "warning" | "error";

export type ConstraintShadowDiagnosticConsumer =
  | "diff_report"
  | "p2_event_schema_backlog"
  | "not_memory_audit"
  | "scope_review"
  | "compiler_prompt_iteration"
  | "manual_investigation";

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
  | "SC_NEAR_DUPLICATE_GROUP"
  | "SC_CONFLICT_DETECTED"
  | "SC_COMPACT_REQUIRED"
  | "SC_ARCHIVED_REACTIVATION_RISK"
  | "SC_LEGACY_INJECTION_DELTA"
  | "SC_RENDER_DRIFT"
  | "SC_COMPILER_MODEL_UNAVAILABLE"
  | "SC_COMPILER_PARSE_FAILED"
  | "SC_SHADOW_ONLY_VIOLATION_ATTEMPT"
  | "SC_UNCLASSIFIED";

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
