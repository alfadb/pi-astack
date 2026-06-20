export const CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION = "constraint-evidence-envelope/v1";
export const CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION = "constraint-evidence-event/v1";
export const CONSTRAINT_EVIDENCE_CANONICALIZATION = "RFC8785-JCS";
export const CONSTRAINT_EVIDENCE_HASH_ALG = "sha256";

export type ConstraintEvidenceJsonValue =
  | null
  | boolean
  | number
  | string
  | ConstraintEvidenceJsonValue[]
  | { [key: string]: ConstraintEvidenceJsonValue };

export type ConstraintEvidenceEventType =
  | "constraint_signal_observed"
  | "constraint_correction_observed"
  | "constraint_rejection_observed"
  | "constraint_forget_observed"
  | "constraint_retract_observed"
  | "constraint_not_memory_observed"
  | "constraint_unclassified_observed";

export type ConstraintEvidenceActor = {
  role: "user" | "assistant" | "system" | "tool";
  id?: string;
};

export interface ConstraintEvidenceSource {
  channel: "agent_end" | "manual" | "replay";
  source_role: "user" | "assistant" | "system" | "tool";
  source_ref: string;
  quote_hash: string;
}

export interface ConstraintEvidenceIntent {
  domain_hint: "constraint";
  operation_hint: "create" | "update" | "correction" | "forget" | "rejection" | "retract" | "not_memory" | "unclassified";
  confidence?: number;
}

export interface ConstraintEvidencePayload {
  sanitized_quote: string;
  candidate_constraint_text?: string;
  candidate_title?: string;
  candidate_trigger_phrases?: string[];
  candidate_applies_when?: string;
  candidate_priority_hint?: "always" | "listed" | "unknown";
  not_memory_hint?: "settings" | "tool_contract" | "provider_budget_flag" | "unknown";
  unclassified_reason?: string;
}

export interface ConstraintEvidenceScopeContext {
  active_project_binding: {
    project_id?: string;
    binding_reason: string;
    cwd_hash?: string;
  };
  scope_hint:
    | { kind: "global"; evidence: string }
    | { kind: "project"; project_id: string; evidence: string }
    | { kind: "unknown"; reason: string };
  scope_confidence?: number;
}

export interface ConstraintEvidenceSanitizer {
  sanitizer_name: string;
  sanitizer_version: string;
  status: "passed" | "redacted" | "blocked";
  replacements_count: number;
  blocked_reason?: string;
}

export interface ConstraintEvidenceNeighborSummary {
  retrieval_mode: "readonly";
  input_hash: string;
  neighbor_refs: Array<{
    ref: string;
    scope: "global" | "project" | "unknown";
    title?: string;
    reason?: string;
  }>;
  summary: string;
}

export interface ConstraintEvidenceProducer {
  name: "sediment.constraint-event-writer";
  version: string;
  code_version?: string;
  settings_hash?: string;
}

export interface ConstraintEvidenceLegacyParallelWrite {
  attempted: boolean;
  legacy_path_kind?: "tier1_ruleset_adjudicator" | "rule_writer" | "correction_pipeline" | "unknown";
  legacy_operation_hint?: "create" | "update" | "merge" | "archive" | "contested" | "none";
  legacy_audit_ref?: string;
}

export interface ConstraintEvidenceLlmExtraction {
  model: string;
  prompt_version: string;
  prompt_hash: string;
  input_hash: string;
  output_hash: string;
  parsed_output_hash?: string;
  acceptance: "accepted_for_event_append" | "diagnostic_only";
}

export interface ConstraintEvidenceReplayProvenance {
  source: "historical_audit_backfill";
  audit_jsonl_path: string;
  audit_jsonl_sha256: string;
  audit_row_index: number;
  audit_row_timestamp: string;
  audit_row_operation: string;
  audit_row_session_id?: string;
  audit_row_correlation_id?: string;
  audit_row_candidate_id?: string;
  audit_row_git_commit?: string;
  replay_run_id: string;
  replay_harness_version: string;
  mapping_table_version: string;
  mapping_table_sha256: string;
  approximation: string;
}

export interface ConstraintEvidencePrivacy {
  contains_user_quote: boolean;
  redaction_level: "none" | "partial" | "heavy";
}

export interface ConstraintEvidenceEventBodyV1 {
  event_schema_version: typeof CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION;
  event_type: ConstraintEvidenceEventType;
  created_at_utc: string;
  device_id: string;
  device_event_seq?: number;
  producer_nonce?: string;
  actor: ConstraintEvidenceActor;
  causal_parents: string[];
  session_id: string;
  turn_id: string;
  source: ConstraintEvidenceSource;
  intent: ConstraintEvidenceIntent;
  payload: ConstraintEvidencePayload;
  scope: ConstraintEvidenceScopeContext;
  sanitizer: ConstraintEvidenceSanitizer;
  neighbor_summary: ConstraintEvidenceNeighborSummary;
  producer: ConstraintEvidenceProducer;
  legacy_parallel_write?: ConstraintEvidenceLegacyParallelWrite;
  llm_extraction?: ConstraintEvidenceLlmExtraction;
  replay_provenance?: ConstraintEvidenceReplayProvenance;
  diagnostics?: ConstraintEvidenceDiagnostic[];
  privacy?: ConstraintEvidencePrivacy;
}

export interface ConstraintEvidenceEnvelopeV1<TBody extends ConstraintEvidenceEventBodyV1 = ConstraintEvidenceEventBodyV1> {
  schema: typeof CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION;
  canonicalization: typeof CONSTRAINT_EVIDENCE_CANONICALIZATION;
  hash_alg: typeof CONSTRAINT_EVIDENCE_HASH_ALG;
  event_id: string;
  body_hash: string;
  body: TBody;
}

export type ConstraintEvidenceDiagnosticCode =
  | "CE_APPEND_OK"
  | "CE_APPEND_FAILED"
  | "CE_APPEND_RETRY_PENDING"
  | "CE_APPEND_IDEMPOTENT_DUPLICATE"
  | "CE_HASH_ENVELOPE_MISMATCH"
  | "CE_HASH_PATH_MISMATCH"
  | "CE_HASH_PATH_COLLISION"
  | "CE_SCHEMA_UNSUPPORTED"
  | "CE_SANITIZER_BLOCKED"
  | "CE_NOT_MEMORY_SETTINGS"
  | "CE_NOT_MEMORY_TOOL_CONTRACT"
  | "CE_SCOPE_AMBIGUOUS"
  | "CE_UNCLASSIFIED"
  | "CE_LEGACY_PARALLEL_DELTA"
  | "CE_COMPILER_STALE"
  | "CE_COMPILER_DRAIN_OK"
  | "CE_EVENT_READER_INVALID"
  | "CE_EVENT_LOSS_DETECTED"
  | "CE_EVENT_NOT_MEMORY_LEAK"
  | "CE_EVENT_SCOPE_CONSERVATISM_BREACH";

export type ConstraintEvidenceDiagnosticSeverity = "info" | "warning" | "error";

export type ConstraintEvidenceDiagnosticConsumer =
  | "event_audit"
  | "not_memory_audit"
  | "scope_review"
  | "compiler_liveness_report"
  | "manual_investigation"
  | "p3_injection_readiness";

export interface ConstraintEvidenceDiagnostic {
  id: string;
  code: ConstraintEvidenceDiagnosticCode;
  severity: ConstraintEvidenceDiagnosticSeverity;
  message: string;
  eventIds: string[];
  consumers: ConstraintEvidenceDiagnosticConsumer[];
  data?: Record<string, unknown>;
}

export type ConstraintEvidenceValidationResult<T = unknown> =
  | { ok: true; value: T; diagnostics: ConstraintEvidenceDiagnostic[] }
  | { ok: false; diagnostics: ConstraintEvidenceDiagnostic[] };

export type ConstraintEventProjectionStatus = "queued" | "projected" | "stale" | "invalid" | "append_failed";

export interface ConstraintEventProjectionRecord {
  eventId: string;
  status: ConstraintEventProjectionStatus;
  observedAtUtc?: string;
  projectedAtUtc?: string;
}

export interface ConstraintEventProjectionSummary {
  total: number;
  queued: number;
  projected: number;
  stale: number;
  invalid: number;
  appendFailed: number;
  oldestQueuedAgeMs?: number;
}
