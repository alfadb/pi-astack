import { sha256Hex, stableCanonicalize } from "./normalize";
import type {
  ConstraintDecisionConstraint,
  ConstraintEventSourceRecord,
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

function verifierInputRows(events: ConstraintEventSourceRecord[], decision: ValidatedConstraintCompilerDecision): unknown[] {
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
          targetConstraintId: target.constraintId,
          targetContentHash: targetContentHashForConstraint(target),
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
    rows: verifierInputRows(events, decision),
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
    && optionalNonNegativeNumber(summary.staleBindingRows);
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
