import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanWholeL1Validated } from "../../_shared/l1-schema-registry";
import { parseConstraintEvidenceEnvelopeJson } from "../constraint-evidence/read";
import type { ConstraintEvidenceDiagnostic, ConstraintEvidenceEnvelopeV1, ConstraintEvidenceEventBodyV1 } from "../constraint-evidence/types";
import { makeDiagnostic } from "./diagnostics";
import { inferCategoryHint } from "./normalize";
import type { ConstraintEventSourceRecord, ConstraintShadowDiagnostic } from "./types";

export interface ConstraintEventScanResult {
  events: ConstraintEventSourceRecord[];
  invalidEventIds: string[];
  diagnostics: ConstraintShadowDiagnostic[];
}

// ADR0039 NS-2 (4×T0 unanimous 2026-06-20) + canonical-path R3.4.2 P1-S3:
// l1/events/sha256/ is a MULTI-DOMAIN content-addressed store — knowledge,
// constraint-evidence and constraint-projection envelopes all share it. The
// foreign-vs-selected classification now comes from the central machine
// schema-role registry via scanWholeL1Validated: EVERY event in L1 (any
// domain) is envelope/hash/path/role/producer validated before the constraint
// parse sees a single record, and an unknown or corrupt envelope anywhere
// fails the whole scan closed (§4: 显式信号不静默丢失). Constraint
// body-level semantic problems keep flowing through the existing diagnostic /
// invalidEventIds / coverageRatio machinery below.

function mapEvidenceDiagnostic(diagnostic: ConstraintEvidenceDiagnostic, fallbackEventId?: string): ConstraintShadowDiagnostic {
  const eventIds = diagnostic.eventIds.length ? diagnostic.eventIds : (fallbackEventId ? [fallbackEventId] : []);
  const sourceRecordIds = eventIds.map((eventId) => `event:${eventId}`);
  if (diagnostic.code === "CE_NOT_MEMORY_SETTINGS") {
    return makeDiagnostic({
      code: "SC_NOT_MEMORY_SETTINGS",
      message: diagnostic.message,
      sourceRecordIds,
      data: { eventIds, evidenceCode: diagnostic.code, ...(diagnostic.data ?? {}) },
    });
  }
  if (diagnostic.code === "CE_NOT_MEMORY_TOOL_CONTRACT") {
    return makeDiagnostic({
      code: "SC_NOT_MEMORY_TOOL_CONTRACT",
      message: diagnostic.message,
      sourceRecordIds,
      data: { eventIds, evidenceCode: diagnostic.code, ...(diagnostic.data ?? {}) },
    });
  }
  if (diagnostic.code === "CE_SCOPE_AMBIGUOUS") {
    return makeDiagnostic({
      code: "SC_SCOPE_AMBIGUOUS",
      message: diagnostic.message,
      sourceRecordIds,
      data: { eventIds, evidenceCode: diagnostic.code, ...(diagnostic.data ?? {}) },
    });
  }
  if (diagnostic.code === "CE_UNCLASSIFIED") {
    return makeDiagnostic({
      code: "SC_UNCLASSIFIED",
      message: diagnostic.message,
      sourceRecordIds,
      data: { eventIds, evidenceCode: diagnostic.code, ...(diagnostic.data ?? {}) },
    });
  }
  return makeDiagnostic({
    code: "SC_EVENT_READ_ERROR",
    message: diagnostic.message,
    sourceRecordIds,
    data: { eventIds, evidenceCode: diagnostic.code, severity: diagnostic.severity, ...(diagnostic.data ?? {}) },
  });
}

function eventScope(body: ConstraintEvidenceEventBodyV1): ConstraintEventSourceRecord["scopeHint"] {
  const hint = body.scope.scope_hint;
  if (hint.kind === "global") return { kind: "global", evidence: hint.evidence };
  if (hint.kind === "project") return { kind: "project", projectId: hint.project_id, evidence: hint.evidence };
  return { kind: "unknown", reason: hint.reason };
}

function sourceFromEnvelope(envelope: ConstraintEvidenceEnvelopeV1, file: string): ConstraintEventSourceRecord {
  const body = envelope.body;
  const eventId = envelope.event_id;
  const candidateText = body.payload.candidate_constraint_text ?? body.payload.sanitized_quote;
  return {
    sourceKind: "constraint_event",
    sourceId: `event:${eventId}`,
    eventId,
    eventType: body.event_type,
    createdAtUtc: body.created_at_utc,
    sessionId: body.session_id,
    turnId: body.turn_id,
    sourceChannel: body.source.channel,
    sourceRole: body.source.source_role,
    operationHint: body.intent.operation_hint,
    confidence: body.intent.confidence,
    sanitizedQuote: body.payload.sanitized_quote,
    candidateText,
    candidateTitle: body.payload.candidate_title,
    candidateTriggerPhrases: body.payload.candidate_trigger_phrases?.slice().sort() ?? [],
    candidateAppliesWhen: body.payload.candidate_applies_when,
    candidatePriorityHint: body.payload.candidate_priority_hint ?? "unknown",
    notMemoryHint: body.payload.not_memory_hint,
    unclassifiedReason: body.payload.unclassified_reason,
    scopeHint: eventScope(body),
    activeProjectId: body.scope.active_project_binding.project_id,
    scopeConfidence: body.scope.scope_confidence,
    sanitizerStatus: body.sanitizer.status,
    sanitizerReplacementsCount: body.sanitizer.replacements_count,
    legacyParallelWrite: body.legacy_parallel_write,
    causalParents: body.causal_parents.slice().sort(),
    producerName: body.producer.name,
    producerVersion: body.producer.version,
    ...(body.replay_provenance ? {
      replayProvenance: {
        source: body.replay_provenance.source,
        auditJsonlPath: body.replay_provenance.audit_jsonl_path,
        auditJsonlSha256: body.replay_provenance.audit_jsonl_sha256,
        auditRowIndex: body.replay_provenance.audit_row_index,
        auditRowTimestamp: body.replay_provenance.audit_row_timestamp,
        auditRowOperation: body.replay_provenance.audit_row_operation,
        ...(body.replay_provenance.audit_row_session_id ? { auditRowSessionId: body.replay_provenance.audit_row_session_id } : {}),
        ...(body.replay_provenance.audit_row_correlation_id ? { auditRowCorrelationId: body.replay_provenance.audit_row_correlation_id } : {}),
        ...(body.replay_provenance.audit_row_candidate_id ? { auditRowCandidateId: body.replay_provenance.audit_row_candidate_id } : {}),
        ...(body.replay_provenance.audit_row_git_commit ? { auditRowGitCommit: body.replay_provenance.audit_row_git_commit } : {}),
        replayRunId: body.replay_provenance.replay_run_id,
        replayHarnessVersion: body.replay_provenance.replay_harness_version,
        mappingTableVersion: body.replay_provenance.mapping_table_version,
        mappingTableSha256: body.replay_provenance.mapping_table_sha256,
        approximation: body.replay_provenance.approximation,
      },
    } : {}),
    bodyHash: envelope.body_hash,
    rawFilePath: file,
    sourceRef: { path: file, ref: `event:${eventId}` },
  };
}

export async function scanConstraintEvidenceEvents(options: { abrainHome: string }): Promise<ConstraintEventScanResult> {
  const abrainHome = path.resolve(options.abrainHome);
  const scan = await scanWholeL1Validated({ abrainHome, domains: ["constraint"], roles: ["evidence"] });
  const events: ConstraintEventSourceRecord[] = [];
  const invalidEventIds: string[] = [];
  const diagnostics: ConstraintShadowDiagnostic[] = [];

  for (const residue of scan.tempResidue) {
    diagnostics.push(makeDiagnostic({
      code: "SC_EVENT_READ_ERROR",
      message: `durable-write temp residue in L1 event tree: ${residue}`,
      sourceRecordIds: [],
      data: { file: residue, kind: "temp_residue" },
    }));
  }

  for (const record of scan.selected) {
    const file = record.filePath ?? path.resolve(abrainHome, ...(record.relativePath ?? "").split("/"));
    const fallbackEventId = record.eventId;
    const relativePath = record.relativePath ?? path.relative(abrainHome, file).split(path.sep).join("/");
    try {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = parseConstraintEvidenceEnvelopeJson(raw, { abrainHome, filePath: file, relativePath });
      if (!parsed.ok) {
        diagnostics.push(...parsed.diagnostics.map((diagnostic) => mapEvidenceDiagnostic(diagnostic, fallbackEventId)));
        const ids = parsed.diagnostics.flatMap((diagnostic) => diagnostic.eventIds);
        for (const eventId of ids.length ? ids : (fallbackEventId ? [fallbackEventId] : [])) invalidEventIds.push(eventId);
        continue;
      }
      const event = sourceFromEnvelope(parsed.value, file);
      const categoryHint = inferCategoryHint(event);
      diagnostics.push(...parsed.diagnostics
        .map((diagnostic) => mapEvidenceDiagnostic(diagnostic, fallbackEventId))
        .filter((diagnostic) => !(diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && categoryHint === "behavioral_constraint")));
      events.push(event);
    } catch (err) {
      if (fallbackEventId) invalidEventIds.push(fallbackEventId);
      diagnostics.push(makeDiagnostic({
        code: "SC_EVENT_READ_ERROR",
        message: `failed to read constraint evidence event ${file}`,
        sourceRecordIds: fallbackEventId ? [`event:${fallbackEventId}`] : [],
        data: { file, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  events.sort((left, right) => left.eventId.localeCompare(right.eventId));
  return { events, invalidEventIds: Array.from(new Set(invalidEventIds)).sort(), diagnostics };
}
