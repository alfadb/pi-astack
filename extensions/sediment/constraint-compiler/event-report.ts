import { markStaleQueuedConstraintEvents, summarizeConstraintEventProjectionStatus } from "../constraint-evidence/status";
import type { ConstraintEventProjectionRecord } from "../constraint-evidence/types";
import { makeDiagnostic } from "./diagnostics";
import type {
  ConstraintEventCoverageReport,
  ConstraintEventSourceRecord,
  ConstraintLegacyParallelDeltaReport,
  ConstraintShadowDiagnostic,
  ConstraintSourceDisposition,
  ValidatedConstraintCompilerDecision,
} from "./types";

function dispositionForSource(decision: ValidatedConstraintCompilerDecision, sourceId: string): ConstraintSourceDisposition | undefined {
  if (decision.exclusions.some((item) => item.sourceRecordIds.includes(sourceId))) return "excluded";
  if (decision.unresolved.some((item) => item.sourceRecordIds.includes(sourceId))) return "unresolved";
  if (decision.constraints.some((item) => item.sourceRecordIds.includes(sourceId))) return "compiled";
  if (decision.merges.some((item) => item.sourceRecordIds.includes(sourceId))) return "merged_source";
  if (decision.diagnostics.some((item) => item.sourceRecordIds.includes(sourceId))) return "diagnostic";
  return undefined;
}

function diagnosticCodesForSource(diagnostics: ConstraintShadowDiagnostic[], sourceId: string): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.sourceRecordIds.includes(sourceId))
    .map((diagnostic) => diagnostic.code)
    .sort();
}

function projectionRecordForEvent(
  event: ConstraintEventSourceRecord,
  decision: ValidatedConstraintCompilerDecision,
  diagnostics: ConstraintShadowDiagnostic[],
  projectedAtUtc?: string,
): ConstraintEventProjectionRecord {
  const disposition = dispositionForSource(decision, event.sourceId);
  if (disposition && disposition !== "diagnostic") {
    return { eventId: event.eventId, status: "projected", observedAtUtc: event.createdAtUtc, ...(projectedAtUtc ? { projectedAtUtc } : {}) };
  }
  const codes = diagnosticCodesForSource(diagnostics, event.sourceId);
  if (codes.some((code) => code === "SC_EVENT_READ_ERROR" || code === "SC_EVENT_NOT_MEMORY_LEAK" || code === "SC_EVENT_SCOPE_BREACH")) {
    return { eventId: event.eventId, status: "invalid", observedAtUtc: event.createdAtUtc };
  }
  return { eventId: event.eventId, status: "queued", observedAtUtc: event.createdAtUtc };
}

export function createConstraintEventCoverageReport(input: {
  events: ConstraintEventSourceRecord[];
  invalidEventIds?: string[];
  decision: ValidatedConstraintCompilerDecision;
  diagnostics: ConstraintShadowDiagnostic[];
  staleAfterMs: number;
  nowMs?: number;
}): { report: ConstraintEventCoverageReport; diagnostics: ConstraintShadowDiagnostic[] } {
  const invalidEventIds = new Set(input.invalidEventIds ?? []);
  const projectedAtUtc = input.nowMs === undefined ? undefined : new Date(input.nowMs).toISOString();
  const validRecords = input.events.map((event) => projectionRecordForEvent(event, input.decision, input.diagnostics, projectedAtUtc));
  const invalidRecords: ConstraintEventProjectionRecord[] = Array.from(invalidEventIds)
    .sort()
    .map((eventId) => ({ eventId, status: "invalid" }));
  const records = markStaleQueuedConstraintEvents([...validRecords, ...invalidRecords], {
    staleAfterMs: input.staleAfterMs,
    nowMs: input.nowMs,
  }).sort((left, right) => left.eventId.localeCompare(right.eventId));
  const summary = summarizeConstraintEventProjectionStatus(records, { nowMs: input.nowMs });
  const eventById = new Map(input.events.map((event) => [event.eventId, event]));
  const provenanceSummary = input.events.reduce((acc, event) => {
    if (event.replayProvenance?.source === "historical_audit_backfill") acc.replayBackfillEvents += 1;
    else if (event.sourceChannel === "agent_end") acc.liveEvents += 1;
    else if (event.sourceChannel === "manual") acc.manualEvents += 1;
    else acc.unknownEvents += 1;
    return acc;
  }, { liveEvents: 0, replayBackfillEvents: 0, manualEvents: 0, unknownEvents: invalidEventIds.size });
  const rows = records.map((record) => {
    const sourceRecordId = `event:${record.eventId}`;
    const event = eventById.get(record.eventId);
    return {
      eventId: record.eventId,
      sourceRecordId,
      status: record.status,
      disposition: dispositionForSource(input.decision, sourceRecordId),
      observedAtUtc: record.observedAtUtc,
      projectedAtUtc: record.projectedAtUtc,
      diagnostics: diagnosticCodesForSource(input.diagnostics, sourceRecordId),
      ...(event?.replayProvenance ? { provenance: event.replayProvenance } : {}),
      ...(event?.sourceChannel ? { sourceChannel: event.sourceChannel } : {}),
    };
  });
  const diagnostics: ConstraintShadowDiagnostic[] = [];
  for (const row of rows) {
    if (row.status === "queued") {
      diagnostics.push(makeDiagnostic({
        code: "SC_EVENT_COVERAGE_GAP",
        message: "constraint evidence event is queued for shadow projection",
        sourceRecordIds: [row.sourceRecordId],
        data: { eventId: row.eventId },
      }));
    }
    if (row.status === "stale") {
      diagnostics.push(makeDiagnostic({
        code: "SC_EVENT_STALE_THRESHOLD",
        message: "constraint evidence event exceeded shadow projection stale threshold",
        sourceRecordIds: [row.sourceRecordId],
        data: { eventId: row.eventId, staleAfterMs: input.staleAfterMs },
      }));
    }
  }
  return {
    report: {
      schemaVersion: "constraint-event-coverage/v1",
      summary: {
        totalEvents: summary.total,
        validEvents: input.events.length,
        invalidEvents: invalidEventIds.size,
        queuedEvents: summary.queued,
        projectedEvents: summary.projected,
        staleEvents: summary.stale,
        appendFailedEvents: summary.appendFailed,
        ...(summary.oldestQueuedAgeMs === undefined ? {} : { oldestQueuedAgeMs: summary.oldestQueuedAgeMs }),
        coverageRatio: summary.total === 0 ? 1 : summary.projected / summary.total,
        provenance: provenanceSummary,
      },
      rows,
    },
    diagnostics,
  };
}

export function createConstraintLegacyParallelDeltaReport(input: {
  events: ConstraintEventSourceRecord[];
  decision: ValidatedConstraintCompilerDecision;
}): { report: ConstraintLegacyParallelDeltaReport; diagnostics: ConstraintShadowDiagnostic[] } {
  const rows = input.events
    .filter((event) => event.legacyParallelWrite?.attempted)
    .sort((left, right) => left.eventId.localeCompare(right.eventId))
    .map((event) => {
      const compilerDisposition = dispositionForSource(input.decision, event.sourceId);
      const legacyOperationHint = event.legacyParallelWrite?.legacy_operation_hint;
      if (!compilerDisposition) {
        return {
          eventId: event.eventId,
          sourceRecordId: event.sourceId,
          legacyOperationHint,
          compilerDisposition,
          status: "event_only" as const,
          reason: "event has legacy write marker but no compiler disposition yet",
        };
      }
      const legacyCreateLike = legacyOperationHint === "create" || legacyOperationHint === "update" || legacyOperationHint === "merge";
      const compilerCreateLike = compilerDisposition === "compiled" || compilerDisposition === "merged_source";
      const legacyNone = legacyOperationHint === "none";
      const compilerNotMemory = compilerDisposition === "excluded" || compilerDisposition === "unresolved" || compilerDisposition === "diagnostic";
      const matched = (legacyCreateLike && compilerCreateLike) || (legacyNone && compilerNotMemory);
      return {
        eventId: event.eventId,
        sourceRecordId: event.sourceId,
        legacyOperationHint,
        compilerDisposition,
        status: matched ? "matched" as const : "mismatched" as const,
        reason: matched ? "legacy write hint matches compiler disposition" : "legacy write hint differs from compiler disposition",
      };
    });
  const diagnostics = rows
    .filter((row) => row.status === "mismatched")
    .map((row) => makeDiagnostic({
      code: "SC_LEGACY_PARALLEL_DELTA",
      message: "constraint evidence event legacy write hint differs from shadow compiler disposition",
      sourceRecordIds: [row.sourceRecordId],
      data: { eventId: row.eventId, legacyOperationHint: row.legacyOperationHint, compilerDisposition: row.compilerDisposition },
    }));
  return {
    report: {
      schemaVersion: "constraint-legacy-parallel-delta/v1",
      summary: {
        totalEventsWithLegacyWrite: rows.length,
        matchedOutcomes: rows.filter((row) => row.status === "matched").length,
        mismatchedOutcomes: rows.filter((row) => row.status === "mismatched").length,
        eventOnlySignals: rows.filter((row) => row.status === "event_only").length,
      },
      rows,
    },
    diagnostics,
  };
}
