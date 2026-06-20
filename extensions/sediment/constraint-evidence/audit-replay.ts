import { sha256Hex } from "./hash-envelope";
import type {
  ConstraintEvidenceEventBodyV1,
  ConstraintEvidenceEventType,
  ConstraintEvidenceIntent,
  ConstraintEvidenceLegacyParallelWrite,
  ConstraintEvidencePayload,
  ConstraintEvidenceReplayProvenance,
  ConstraintEvidenceScopeContext,
} from "./types";
import { CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION } from "./types";

export const CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION = "constraint-audit-replay-mapping/v1";

export type ConstraintAuditReplayOperation = "create" | "update" | "merge" | "archive" | "reject";

export type ConstraintAuditReplayMappingDisposition = "event" | "drop";

export interface ConstraintAuditReplayMappingRule {
  operation: ConstraintAuditReplayOperation;
  disposition: ConstraintAuditReplayMappingDisposition;
  eventType?: ConstraintEvidenceEventType;
  operationHint?: ConstraintEvidenceIntent["operation_hint"];
  legacyOperationHint?: ConstraintEvidenceLegacyParallelWrite["legacy_operation_hint"];
  note: string;
}

export const CONSTRAINT_AUDIT_REPLAY_MAPPING_RULES: readonly ConstraintAuditReplayMappingRule[] = [
  {
    operation: "create",
    disposition: "event",
    eventType: "constraint_signal_observed",
    operationHint: "create",
    legacyOperationHint: "create",
    note: "legacy rule create is replayed as an approximated observed constraint signal",
  },
  {
    operation: "update",
    disposition: "event",
    eventType: "constraint_correction_observed",
    operationHint: "correction",
    legacyOperationHint: "update",
    note: "legacy rule update is replayed as an approximated correction signal",
  },
  {
    operation: "merge",
    disposition: "event",
    eventType: "constraint_correction_observed",
    operationHint: "correction",
    legacyOperationHint: "merge",
    note: "legacy rule merge is replayed as an approximated correction signal with merge lineage only in provenance",
  },
  {
    operation: "archive",
    disposition: "event",
    eventType: "constraint_retract_observed",
    operationHint: "retract",
    legacyOperationHint: "archive",
    note: "legacy rule archive is replayed as an approximated retraction signal",
  },
  {
    operation: "reject",
    disposition: "event",
    eventType: "constraint_rejection_observed",
    operationHint: "rejection",
    legacyOperationHint: "none",
    note: "legacy rule reject is replayed as an approximated rejection signal, not as a successful canonical write",
  },
];

export interface ConstraintAuditReplaySourceRow {
  rowIndex: number;
  timestamp?: string;
  lane?: string;
  operation?: string;
  scope?: string;
  project_id?: string;
  inject_mode?: string;
  slug?: string;
  target?: string;
  title?: string;
  reason?: string;
  sessionId?: string;
  turnId?: string;
  correlationId?: string;
  candidateId?: string;
  git_commit?: string;
  [key: string]: unknown;
}

export interface BuildConstraintEvidenceEventFromAuditRowOptions {
  row: ConstraintAuditReplaySourceRow;
  auditJsonlPath: string;
  auditJsonlSha256: string;
  replayRunId: string;
  replayHarnessVersion: string;
  mappingTableSha256?: string;
  activeProjectId: string;
  deviceId: string;
  sourceText?: string;
}

export type ConstraintAuditReplayMappingResult = {
  ok: true;
  body: ConstraintEvidenceEventBodyV1;
  mappingRule: ConstraintAuditReplayMappingRule;
} | {
  ok: false;
  reason: string;
  operation?: string;
};

export function constraintAuditReplayMappingRulesHash(): string {
  return sha256Hex(JSON.stringify(CONSTRAINT_AUDIT_REPLAY_MAPPING_RULES));
}

export function auditReplayMappingRuleForOperation(operation: unknown): ConstraintAuditReplayMappingRule | undefined {
  if (typeof operation !== "string") return undefined;
  return CONSTRAINT_AUDIT_REPLAY_MAPPING_RULES.find((rule) => rule.operation === operation);
}

export function buildConstraintEvidenceEventBodyFromAuditRow(
  options: BuildConstraintEvidenceEventFromAuditRowOptions,
): ConstraintAuditReplayMappingResult {
  const row = options.row;
  if (row.lane !== "rules") {
    return { ok: false, reason: "audit row lane is not rules", operation: stringValue(row.operation) };
  }
  const mappingRule = auditReplayMappingRuleForOperation(row.operation);
  if (!mappingRule || mappingRule.disposition !== "event" || !mappingRule.eventType || !mappingRule.operationHint) {
    return { ok: false, reason: "audit row operation is not replayable", operation: stringValue(row.operation) };
  }

  const timestamp = stringValue(row.timestamp) || new Date(0).toISOString();
  const sessionId = stringValue(row.sessionId) || `audit-row-${row.rowIndex}`;
  const turnId = stringValue(row.turnId) || `audit-row-${row.rowIndex}`;
  const target = stringValue(row.target);
  const sourceText = normalizedSourceText(options.sourceText, row, mappingRule);
  const quoteHash = sha256Hex(sourceText);
  const replayProvenance: ConstraintEvidenceReplayProvenance = {
    source: "historical_audit_backfill",
    audit_jsonl_path: options.auditJsonlPath,
    audit_jsonl_sha256: options.auditJsonlSha256,
    audit_row_index: row.rowIndex,
    audit_row_timestamp: timestamp,
    audit_row_operation: mappingRule.operation,
    replay_run_id: options.replayRunId,
    replay_harness_version: options.replayHarnessVersion,
    mapping_table_version: CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION,
    mapping_table_sha256: options.mappingTableSha256 || constraintAuditReplayMappingRulesHash(),
    approximation: "legacy audit rows record post-hoc rule outcomes, so replay events approximate the witnessed evidence cause and must not be treated as raw transcript truth",
  };
  const auditRowSessionId = stringValue(row.sessionId);
  const auditRowCorrelationId = stringValue(row.correlationId);
  const auditRowCandidateId = stringValue(row.candidateId);
  const auditRowGitCommit = stringValue(row.git_commit);
  if (auditRowSessionId) replayProvenance.audit_row_session_id = auditRowSessionId;
  if (auditRowCorrelationId) replayProvenance.audit_row_correlation_id = auditRowCorrelationId;
  if (auditRowCandidateId) replayProvenance.audit_row_candidate_id = auditRowCandidateId;
  if (auditRowGitCommit) replayProvenance.audit_row_git_commit = auditRowGitCommit;

  const payload: ConstraintEvidencePayload = mappingRule.operation === "reject"
    ? {
      sanitized_quote: sourceText,
      candidate_constraint_text: sourceText,
      candidate_title: titleForRow(row, mappingRule),
      candidate_trigger_phrases: triggerPhrasesForRow(row),
      candidate_applies_when: appliesWhenForRow(row, mappingRule),
      candidate_priority_hint: priorityHintFromInjectMode(row.inject_mode),
      unclassified_reason: stringValue(row.reason) || "legacy rules audit rejected this candidate; replay preserves the outcome as approximated evidence",
    }
    : {
      sanitized_quote: sourceText,
      candidate_constraint_text: sourceText,
      candidate_title: titleForRow(row, mappingRule),
      candidate_trigger_phrases: triggerPhrasesForRow(row),
      candidate_applies_when: appliesWhenForRow(row, mappingRule),
      candidate_priority_hint: priorityHintFromInjectMode(row.inject_mode),
    };

  const body: ConstraintEvidenceEventBodyV1 = {
    event_schema_version: CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION,
    event_type: mappingRule.eventType,
    created_at_utc: timestamp,
    device_id: options.deviceId,
    producer_nonce: `audit-replay:${options.replayRunId}:${row.rowIndex}:${sha256Hex(JSON.stringify(row))}`,
    actor: { role: "system", id: "sediment-audit-replay" },
    causal_parents: [],
    session_id: sessionId,
    turn_id: turnId,
    source: {
      channel: "replay",
      source_role: "system",
      source_ref: `audit:${options.auditJsonlSha256}:${row.rowIndex}`,
      quote_hash: quoteHash,
    },
    intent: {
      domain_hint: "constraint",
      operation_hint: mappingRule.operationHint,
      confidence: confidenceForOperation(mappingRule.operation),
    },
    payload,
    scope: scopeContextForRow(row, options.activeProjectId),
    sanitizer: {
      sanitizer_name: "constraint-audit-replay-sanitizer",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    neighbor_summary: {
      retrieval_mode: "readonly",
      input_hash: sha256Hex(`${options.auditJsonlSha256}\n${row.rowIndex}\n${quoteHash}`),
      neighbor_refs: target ? [{ ref: target, scope: scopeRefForRow(row), title: titleForRow(row, mappingRule) }] : [],
      summary: "historical audit replay uses existing production sediment audit rows; no live memory neighbor query is performed",
    },
    producer: {
      name: "sediment.constraint-event-writer",
      version: "adr0039-p3b-phase1.5-audit-replay",
      code_version: CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION,
    },
    legacy_parallel_write: {
      attempted: mappingRule.operation !== "reject",
      legacy_path_kind: "tier1_ruleset_adjudicator",
      legacy_operation_hint: mappingRule.legacyOperationHint,
      legacy_audit_ref: `audit:${options.auditJsonlSha256}:${row.rowIndex}`,
    },
    replay_provenance: replayProvenance,
    privacy: { contains_user_quote: false, redaction_level: "none" },
  };

  return { ok: true, body, mappingRule };
}

function normalizedSourceText(sourceText: string | undefined, row: ConstraintAuditReplaySourceRow, mappingRule: ConstraintAuditReplayMappingRule): string {
  const explicit = sourceText?.trim();
  if (explicit) return explicit;
  const parts = [
    `historical audit ${mappingRule.operation} for ${stringValue(row.slug) || `row ${row.rowIndex}`}`,
    stringValue(row.title),
    stringValue(row.target),
    stringValue(row.reason),
  ].filter(Boolean);
  return parts.join("\n");
}

function titleForRow(row: ConstraintAuditReplaySourceRow, mappingRule: ConstraintAuditReplayMappingRule): string {
  return stringValue(row.title) || stringValue(row.slug) || `${mappingRule.operation} audit row ${row.rowIndex}`;
}

function appliesWhenForRow(row: ConstraintAuditReplaySourceRow, mappingRule: ConstraintAuditReplayMappingRule): string {
  const reason = stringValue(row.reason);
  if (reason) return reason.slice(0, 500);
  return `historical production rules audit row replayed from ${mappingRule.operation} outcome`;
}

function triggerPhrasesForRow(row: ConstraintAuditReplaySourceRow): string[] {
  const slug = stringValue(row.slug);
  if (!slug) return [];
  return [slug].slice(0, 1);
}

function priorityHintFromInjectMode(value: unknown): ConstraintEvidencePayload["candidate_priority_hint"] {
  if (value === "always") return "always";
  if (value === "listed") return "listed";
  return "unknown";
}

function confidenceForOperation(operation: ConstraintAuditReplayOperation): number {
  if (operation === "reject") return 0.6;
  if (operation === "archive") return 0.7;
  return 0.75;
}

function scopeContextForRow(row: ConstraintAuditReplaySourceRow, activeProjectId: string): ConstraintEvidenceScopeContext {
  const projectId = stringValue(row.project_id) || activeProjectId;
  if (row.scope === "project") {
    return {
      active_project_binding: { project_id: projectId, binding_reason: "historical audit replay active project" },
      scope_hint: { kind: "project", project_id: projectId, evidence: "audit row scope=project" },
      scope_confidence: 0.7,
    };
  }
  if (row.scope === "global") {
    return {
      active_project_binding: { project_id: projectId, binding_reason: "historical audit replay active project" },
      scope_hint: { kind: "global", evidence: "audit row scope=global" },
      scope_confidence: 0.7,
    };
  }
  return {
    active_project_binding: { project_id: projectId, binding_reason: "historical audit replay active project" },
    scope_hint: { kind: "unknown", reason: "audit row did not contain a recognized scope" },
    scope_confidence: 0.2,
  };
}

function scopeRefForRow(row: ConstraintAuditReplaySourceRow): "global" | "project" | "unknown" {
  if (row.scope === "global") return "global";
  if (row.scope === "project") return "project";
  return "unknown";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
