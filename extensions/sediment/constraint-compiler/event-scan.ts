import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseConstraintEvidenceEnvelopeJson } from "../constraint-evidence/read";
import { isSha256Hex } from "../constraint-evidence/hash-envelope";
import type { ConstraintEvidenceDiagnostic, ConstraintEvidenceEnvelopeV1, ConstraintEvidenceEventBodyV1 } from "../constraint-evidence/types";
import { makeDiagnostic } from "./diagnostics";
import type { ConstraintEventSourceRecord, ConstraintShadowDiagnostic } from "./types";

export interface ConstraintEventScanResult {
  events: ConstraintEventSourceRecord[];
  invalidEventIds: string[];
  diagnostics: ConstraintShadowDiagnostic[];
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listEventFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

function eventRoot(abrainHome: string): string {
  return path.resolve(abrainHome, "l1", "events", "sha256");
}

function maybeEventIdFromPath(file: string): string | undefined {
  const base = path.basename(file, ".json");
  return isSha256Hex(base) ? base : undefined;
}

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
    bodyHash: envelope.body_hash,
    rawFilePath: file,
    sourceRef: { path: file, ref: `event:${eventId}` },
  };
}

export async function scanConstraintEvidenceEvents(options: { abrainHome: string }): Promise<ConstraintEventScanResult> {
  const abrainHome = path.resolve(options.abrainHome);
  const root = eventRoot(abrainHome);
  const events: ConstraintEventSourceRecord[] = [];
  const invalidEventIds: string[] = [];
  const diagnostics: ConstraintShadowDiagnostic[] = [];

  for (const file of await listEventFiles(root)) {
    const fallbackEventId = maybeEventIdFromPath(file);
    const relativePath = path.relative(abrainHome, file).split(path.sep).join("/");
    try {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = parseConstraintEvidenceEnvelopeJson(raw, { abrainHome, filePath: file, relativePath });
      diagnostics.push(...parsed.diagnostics.map((diagnostic) => mapEvidenceDiagnostic(diagnostic, fallbackEventId)));
      if (!parsed.ok) {
        const ids = parsed.diagnostics.flatMap((diagnostic) => diagnostic.eventIds);
        for (const eventId of ids.length ? ids : (fallbackEventId ? [fallbackEventId] : [])) invalidEventIds.push(eventId);
        continue;
      }
      events.push(sourceFromEnvelope(parsed.value, file));
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
