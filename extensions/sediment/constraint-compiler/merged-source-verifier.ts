import { sha256Hex, stableCanonicalize } from "./normalize";
import type {
  ConstraintDecisionConstraint,
  ConstraintEventSourceRecord,
  ConstraintMergedSourceVerifierGeneratorMetadata,
  ConstraintMergedSourceVerifierReport,
  ConstraintMergedSourceVerifierRow,
  ValidatedConstraint,
  ValidatedConstraintCompilerDecision,
} from "./types";

export type ConstraintMergedSourceVerifierReportStatus = "absent" | "valid" | "stale_binding";

export interface ConstraintMergedSourceVerifierLookup {
  reportStatus: ConstraintMergedSourceVerifierReportStatus;
  rowBySourceRecordId: Map<string, ConstraintMergedSourceVerifierRow>;
}

export interface ConstraintMergedSourceVerifierInputRow {
  eventId: string;
  sourceRecordId: string;
  eventBodyHash: string;
  eventText: string;
  targetConstraintId: string;
  targetContentHash: string;
  targetTitle: string;
  targetCompiledBody: string;
  targetTriggerPhrases: string[];
  mergeReason: string;
}

export interface ConstraintMergedSourceVerifierVerdictRow {
  eventId: string;
  sourceRecordId: string;
  targetConstraintId: string;
  verdict: ConstraintMergedSourceVerifierRow["verdict"];
  confidence: ConstraintMergedSourceVerifierRow["confidence"];
  reasoning: string;
}

const SCHEMA_VERSION: ConstraintMergedSourceVerifierReport["schemaVersion"] = "constraint-merged-source-verifier/v1";
const VERDICTS = new Set(["expressed", "not_expressed", "uncertain"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

export function targetContentHashForConstraint(constraint: ConstraintDecisionConstraint): string {
  return sha256Hex(stableCanonicalize({
    scope: constraint.scope,
    injectMode: constraint.injectMode,
    title: constraint.title.trim(),
    compiledBody: constraint.compiledBody.trim(),
    mustDoSummary: constraint.mustDoSummary?.trim(),
    appliesWhen: constraint.appliesWhen?.trim(),
    triggerPhrases: constraint.triggerPhrases?.slice().sort(),
  }));
}

export function mergedSourceVerifierDecisionHash(decision: ValidatedConstraintCompilerDecision): string {
  return sha256Hex(stableCanonicalize(decision));
}

function eventTextForVerifier(event: ConstraintEventSourceRecord): string {
  return [
    event.sanitizedQuote,
    event.candidateTitle ?? "",
    event.candidateText,
    event.candidateAppliesWhen ?? "",
    ...event.candidateTriggerPhrases,
  ].filter((part) => part.trim()).join("\n");
}

export function buildMergedSourceVerifierInputRows(
  events: ConstraintEventSourceRecord[],
  decision: ValidatedConstraintCompilerDecision,
): ConstraintMergedSourceVerifierInputRow[] {
  const eventBySourceId = new Map(events.map((event) => [event.sourceId, event]));
  const constraintById = new Map(decision.constraints.map((constraint) => [constraint.constraintId, constraint]));
  return decision.merges
    .flatMap((merge) => {
      const targets = targetConstraintsForMerge(merge.targetConstraintId, merge.sourceRecordIds, decision, constraintById);
      return merge.sourceRecordIds.flatMap((sourceRecordId) => {
        const event = eventBySourceId.get(sourceRecordId);
        if (!event) return [];
        return targets.map((target) => ({
          eventId: event.eventId,
          sourceRecordId,
          eventBodyHash: event.bodyHash,
          eventText: eventTextForVerifier(event),
          targetConstraintId: target.constraintId,
          targetContentHash: targetContentHashForConstraint(target),
          targetTitle: target.title,
          targetCompiledBody: target.compiledBody,
          targetTriggerPhrases: target.triggerPhrases?.slice().sort() ?? [],
          mergeReason: merge.reason,
        }));
      });
    })
    .sort((left, right) => stableCanonicalize(left).localeCompare(stableCanonicalize(right)));
}

export function mergedSourceVerifierInputHash(events: ConstraintEventSourceRecord[], decision: ValidatedConstraintCompilerDecision): string {
  return sha256Hex(stableCanonicalize({
    schemaVersion: SCHEMA_VERSION,
    inputRootHash: decision.inputRootHash,
    decisionValidationHash: decision.validationHash,
    decisionHash: mergedSourceVerifierDecisionHash(decision),
    rows: buildMergedSourceVerifierInputRows(events, decision),
  }));
}

function targetConstraintsForMerge(
  targetConstraintId: string | undefined,
  sourceRecordIds: string[],
  decision: ValidatedConstraintCompilerDecision,
  constraintById: Map<string, ValidatedConstraint>,
): ValidatedConstraint[] {
  if (targetConstraintId) {
    const pinned = constraintById.get(targetConstraintId);
    return pinned ? [pinned] : [];
  }
  return decision.constraints
    .filter((constraint) => sourceRecordIds.some((sourceRecordId) => constraint.sourceRecordIds.includes(sourceRecordId)))
    .sort((left, right) => left.constraintId.localeCompare(right.constraintId));
}

function targetConstraintIdsForMergedSource(decision: ValidatedConstraintCompilerDecision, sourceRecordId: string): Set<string> {
  const constraintById = new Map(decision.constraints.map((constraint) => [constraint.constraintId, constraint]));
  const targets = decision.merges
    .filter((merge) => merge.sourceRecordIds.includes(sourceRecordId))
    .flatMap((merge) => targetConstraintsForMerge(merge.targetConstraintId, merge.sourceRecordIds, decision, constraintById))
    .map((constraint) => constraint.constraintId);
  return new Set(targets);
}

function rowBindingIsValid(input: {
  row: ConstraintMergedSourceVerifierRow;
  eventBySourceId: Map<string, ConstraintEventSourceRecord>;
  constraintById: Map<string, ValidatedConstraint>;
  decision: ValidatedConstraintCompilerDecision;
}): boolean {
  const row = input.row;
  if (!VERDICTS.has(row.verdict)) return false;
  if (!CONFIDENCES.has(row.confidence)) return false;
  if (typeof row.reasoning !== "string") return false;
  const event = input.eventBySourceId.get(row.sourceRecordId);
  if (!event) return false;
  if (row.eventId !== event.eventId) return false;
  if (row.eventBodyHash !== event.bodyHash) return false;
  const allowedTargetIds = targetConstraintIdsForMergedSource(input.decision, row.sourceRecordId);
  if (!allowedTargetIds.has(row.targetConstraintId)) return false;
  const target = input.constraintById.get(row.targetConstraintId);
  if (!target) return false;
  return row.targetContentHash === targetContentHashForConstraint(target);
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function createMergedSourceVerifierReport(input: {
  events: ConstraintEventSourceRecord[];
  decision: ValidatedConstraintCompilerDecision;
  verdictRows: ConstraintMergedSourceVerifierVerdictRow[];
  invalidRows?: number;
  generator?: ConstraintMergedSourceVerifierGeneratorMetadata;
}): ConstraintMergedSourceVerifierReport {
  const inputRowsByKey = new Map(buildMergedSourceVerifierInputRows(input.events, input.decision)
    .map((row) => [`${row.sourceRecordId}\0${row.targetConstraintId}`, row]));
  const rows: ConstraintMergedSourceVerifierRow[] = [];
  for (const verdictRow of input.verdictRows) {
    const inputRow = inputRowsByKey.get(`${verdictRow.sourceRecordId}\0${verdictRow.targetConstraintId}`);
    if (!inputRow || inputRow.eventId !== verdictRow.eventId) continue;
    rows.push({
      eventId: inputRow.eventId,
      sourceRecordId: inputRow.sourceRecordId,
      eventBodyHash: inputRow.eventBodyHash,
      targetConstraintId: inputRow.targetConstraintId,
      targetContentHash: inputRow.targetContentHash,
      verdict: verdictRow.verdict,
      confidence: verdictRow.confidence,
      reasoning: verdictRow.reasoning,
    });
  }
  rows.sort((left, right) => stableCanonicalize(left).localeCompare(stableCanonicalize(right)));
  return {
    schemaVersion: SCHEMA_VERSION,
    inputRootHash: input.decision.inputRootHash,
    decisionValidationHash: input.decision.validationHash,
    decisionHash: mergedSourceVerifierDecisionHash(input.decision),
    verifierInputHash: mergedSourceVerifierInputHash(input.events, input.decision),
    summary: {
      totalRows: rows.length,
      expressedRows: rows.filter((row) => row.verdict === "expressed").length,
      notExpressedRows: rows.filter((row) => row.verdict === "not_expressed").length,
      uncertainRows: rows.filter((row) => row.verdict === "uncertain").length,
      ...(input.invalidRows ? { invalidRows: input.invalidRows } : {}),
    },
    rows,
    ...(input.generator ? { generator: input.generator } : {}),
  };
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function reportGeneratorIsValid(generator: unknown): boolean {
  if (generator === undefined) return true;
  if (!generator || typeof generator !== "object" || Array.isArray(generator)) return false;
  const value = generator as ConstraintMergedSourceVerifierGeneratorMetadata;
  return optionalString(value.modelRef)
    && optionalString(value.promptHash)
    && optionalString(value.rawOutputHash)
    && optionalString(value.parsedOutputHash)
    && optionalNonNegativeNumber(value.durationMs);
}

function reportSummaryIsValid(verifier: ConstraintMergedSourceVerifierReport): boolean {
  if (!Array.isArray(verifier.rows)) return false;
  const summary = verifier.summary;
  if (!summary || typeof summary !== "object") return false;
  const expressedRows = verifier.rows.filter((row) => row.verdict === "expressed").length;
  const notExpressedRows = verifier.rows.filter((row) => row.verdict === "not_expressed").length;
  const uncertainRows = verifier.rows.filter((row) => row.verdict === "uncertain").length;
  return summary.totalRows === verifier.rows.length
    && summary.expressedRows === expressedRows
    && summary.notExpressedRows === notExpressedRows
    && summary.uncertainRows === uncertainRows
    && optionalNonNegativeNumber(summary.invalidRows)
    && optionalNonNegativeNumber(summary.staleBindingRows)
    && reportGeneratorIsValid(verifier.generator);
}

function reportBindingIsValid(input: {
  events: ConstraintEventSourceRecord[];
  decision: ValidatedConstraintCompilerDecision;
  verifier: ConstraintMergedSourceVerifierReport;
}): boolean {
  return input.verifier.schemaVersion === SCHEMA_VERSION
    && input.verifier.inputRootHash === input.decision.inputRootHash
    && input.verifier.decisionValidationHash === input.decision.validationHash
    && input.verifier.decisionHash === mergedSourceVerifierDecisionHash(input.decision)
    && input.verifier.verifierInputHash === mergedSourceVerifierInputHash(input.events, input.decision)
    && reportSummaryIsValid(input.verifier);
}

export function buildMergedSourceVerifierLookup(input: {
  events: ConstraintEventSourceRecord[];
  decision: ValidatedConstraintCompilerDecision;
  verifier?: ConstraintMergedSourceVerifierReport;
}): ConstraintMergedSourceVerifierLookup {
  if (!input.verifier) return { reportStatus: "absent", rowBySourceRecordId: new Map() };
  const rowBySourceRecordId = new Map<string, ConstraintMergedSourceVerifierRow>();
  if (!reportBindingIsValid({ events: input.events, decision: input.decision, verifier: input.verifier })) {
    return { reportStatus: "stale_binding", rowBySourceRecordId };
  }

  const eventBySourceId = new Map(input.events.map((event) => [event.sourceId, event]));
  const constraintById = new Map(input.decision.constraints.map((constraint) => [constraint.constraintId, constraint]));
  const duplicateSourceIds = new Set<string>();
  let staleBinding = false;
  for (const row of input.verifier.rows) {
    if (rowBySourceRecordId.has(row.sourceRecordId)) {
      duplicateSourceIds.add(row.sourceRecordId);
      staleBinding = true;
      continue;
    }
    if (!rowBindingIsValid({ row, eventBySourceId, constraintById, decision: input.decision })) {
      staleBinding = true;
      continue;
    }
    rowBySourceRecordId.set(row.sourceRecordId, row);
  }
  for (const sourceRecordId of duplicateSourceIds) rowBySourceRecordId.delete(sourceRecordId);
  return { reportStatus: staleBinding ? "stale_binding" : "valid", rowBySourceRecordId };
}
