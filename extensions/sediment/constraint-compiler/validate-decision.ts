import type {
  ConstraintCompilerDecision,
  ConstraintDecisionConstraint,
  ConstraintDecisionExclusion,
  ConstraintDecisionMapping,
  ConstraintDecisionUnresolved,
  ConstraintExclusionReason,
  ConstraintScope,
  ConstraintShadowDiagnostic,
  ConstraintSourceRecord,
  ConstraintSourceDisposition,
  ConstraintUnresolvedReason,
  LegacyRuleSourceRecord,
  ValidatedConstraint,
  ValidatedConstraintCompilerDecision,
} from "./types";
import { sha256Hex, stableCanonicalize } from "./normalize";
import { assertDiagnosticConsumers, makeDiagnostic } from "./diagnostics";

const EXCLUSION_REASONS = new Set<ConstraintExclusionReason>([
  "settings_not_memory",
  "tool_contract_not_memory",
  "knowledge_candidate",
  "obsolete_archived",
  "superseded_observed",
  "legacy_archived_observed",
  "malformed_unusable",
]);

const UNRESOLVED_REASONS = new Set<ConstraintUnresolvedReason>([
  "conflict",
  "scope_ambiguous",
  "insufficient_provenance",
  "parse_error",
  "model_uncertain",
  "unknown_status",
  "trigger_projection_loss",
]);

const FORBIDDEN_MUTATION_KEYS = new Set([
  "canonicalPath",
  "canonical_path",
  "targetPath",
  "target_path",
  "writePath",
  "write_path",
  "archiveSlugs",
  "archive_slugs",
  "deleteSlug",
  "delete_slug",
  "mutation",
  "operation",
]);

const EXCLUSION_REASON_PRIORITY: Record<ConstraintExclusionReason, number> = {
  malformed_unusable: 70,
  obsolete_archived: 60,
  superseded_observed: 50,
  legacy_archived_observed: 40,
  settings_not_memory: 30,
  tool_contract_not_memory: 20,
  knowledge_candidate: 10,
};

const STATUS_STALE_ACTIVE_EXCLUSION_REASONS = new Set<ConstraintExclusionReason>([
  "obsolete_archived",
  "superseded_observed",
  "legacy_archived_observed",
]);

export interface ValidateConstraintDecisionOptions {
  knownProjectIds?: string[];
  deriveConstraintIds?: boolean;
  expectedInputRootHash?: string;
  /** pi-astack: when true, EVERY constraint_event source must receive a primary
   *  disposition (compiled/merged_source/excluded/unresolved) or validation throws.
   *  Enabled only on a FRESH compile (shadow-runner) so the B retry loop re-prompts
   *  the model to disposition any dropped event. Left off for cached-decision
   *  re-validation (preflight) and coverage-report paths, where aged events are
   *  legitimately tolerated as stale/queued. */
  requireEventCompleteness?: boolean;
}

export function constraintIdFor(input: ConstraintDecisionConstraint): string {
  const tuple = {
    scope: input.scope,
    injectMode: input.injectMode,
    sourceRecordIds: input.sourceRecordIds.slice().sort(),
    bodyHash: sha256Hex(input.compiledBody.trim()),
  };
  return `shadow:${sha256Hex(stableCanonicalize(tuple)).slice(0, 24)}`;
}

function scopeKey(scope: ConstraintScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

function assertScopeKnown(scope: ConstraintScope, knownProjectIds: Set<string>, context: string): void {
  if (scope.kind === "project" && !knownProjectIds.has(scope.projectId)) {
    throw new Error(`${context} references unknown project ${scope.projectId}`);
  }
}

function assertSourceIdsKnown(ids: unknown, sourceIds: Set<string>, context: string): asserts ids is string[] {
  if (!Array.isArray(ids)) throw new Error(`${context} sourceRecordIds must be an array`);
  for (const sourceId of ids) {
    if (typeof sourceId !== "string") throw new Error(`${context} sourceRecordIds must contain only strings`);
    if (!sourceIds.has(sourceId)) throw new Error(`${context} references unknown source ${sourceId}`);
  }
}

function assertSourceIdsExist(ids: unknown, sourceIds: Set<string>, context: string): asserts ids is string[] {
  assertSourceIdsKnown(ids, sourceIds, context);
  if (!ids.length) throw new Error(`${context} has no sourceRecordIds`);
}

function addDisposition(dispositions: Map<string, string[]>, sourceId: string, disposition: string): void {
  const current = dispositions.get(sourceId) ?? [];
  current.push(disposition);
  dispositions.set(sourceId, current);
}

function assertNoForbiddenMutationKeys(value: unknown, path = "decision"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenMutationKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_MUTATION_KEYS.has(key)) throw new Error(`${path}.${key} is a forbidden mutation field`);
    assertNoForbiddenMutationKeys(nested, `${path}.${key}`);
  }
}

function legacySourcesOnly(sources: ConstraintSourceRecord[]): LegacyRuleSourceRecord[] {
  return sources.filter((source): source is LegacyRuleSourceRecord => source.sourceKind === "legacy_rule");
}

function validateExclusionReason(exclusion: ConstraintDecisionExclusion): void {
  if (!EXCLUSION_REASONS.has(exclusion.reason)) {
    throw new Error(`unknown exclusion reason ${exclusion.reason}`);
  }
}

function validateUnresolvedReason(unresolved: ConstraintDecisionUnresolved): void {
  if (!UNRESOLVED_REASONS.has(unresolved.reason)) {
    throw new Error(`unknown unresolved reason ${unresolved.reason}`);
  }
}

function isUnresolvedReason(reason: unknown): reason is ConstraintUnresolvedReason {
  return typeof reason === "string" && UNRESOLVED_REASONS.has(reason as ConstraintUnresolvedReason);
}

function assertDecisionArrays(decision: ConstraintCompilerDecision): void {
  const requiredArrays: Array<keyof ConstraintCompilerDecision> = [
    "constraints",
    "exclusions",
    "unresolved",
    "merges",
    "rescopeProposals",
    "mappings",
    "diagnostics",
  ];
  for (const key of requiredArrays) {
    if (!Array.isArray(decision[key])) throw new Error(`decision.${key} must be an array`);
  }
}

function hasDiagnosticForSource(decision: ConstraintCompilerDecision, sourceId: string): boolean {
  return decision.diagnostics.some((diagnostic) => Array.isArray(diagnostic.sourceRecordIds) && diagnostic.sourceRecordIds.includes(sourceId));
}

function notMemoryDiagnosticCodeFor(reason: ConstraintExclusionReason): "SC_NOT_MEMORY_SETTINGS" | "SC_NOT_MEMORY_TOOL_CONTRACT" | null {
  if (reason === "settings_not_memory") return "SC_NOT_MEMORY_SETTINGS";
  if (reason === "tool_contract_not_memory") return "SC_NOT_MEMORY_TOOL_CONTRACT";
  return null;
}

function notMemoryReasonForDiagnostic(code: ConstraintShadowDiagnostic["code"]): ConstraintExclusionReason | null {
  if (code === "SC_NOT_MEMORY_SETTINGS") return "settings_not_memory";
  if (code === "SC_NOT_MEMORY_TOOL_CONTRACT") return "tool_contract_not_memory";
  return null;
}

function matchingNotMemoryDiagnostics(diagnostics: ConstraintShadowDiagnostic[], sourceIds: string[]): ConstraintShadowDiagnostic[] {
  return diagnostics.filter((diagnostic) => (
    notMemoryReasonForDiagnostic(diagnostic.code)
    && Array.isArray(diagnostic.consumers)
    && diagnostic.consumers.length > 0
    && Array.isArray(diagnostic.sourceRecordIds)
    && sourceIds.every((sourceId) => diagnostic.sourceRecordIds.includes(sourceId))
  ));
}

function notMemorySubtypeDiagnostic(exclusion: ConstraintDecisionExclusion, canonicalReason: ConstraintExclusionReason): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_NOT_MEMORY_SUBTYPE_NORMALIZED",
    severity: "info",
    message: "compiler not-memory exclusion subtype normalized to deterministic input diagnostic",
    sourceRecordIds: exclusion.sourceRecordIds,
    data: {
      originalReason: exclusion.reason,
      canonicalReason,
      action: "normalized-to-not-memory-diagnostic",
    },
  });
}

function normalizeNotMemoryExclusion(exclusion: ConstraintDecisionExclusion, diagnostics: ConstraintShadowDiagnostic[]): ConstraintDecisionExclusion | null {
  const expectedCode = notMemoryDiagnosticCodeFor(exclusion.reason);
  if (!expectedCode) return exclusion;
  const matches = matchingNotMemoryDiagnostics(diagnostics, exclusion.sourceRecordIds);
  if (!matches.length) return null;
  if (matches.some((diagnostic) => diagnostic.code === expectedCode)) return exclusion;
  const canonicalReasons = Array.from(new Set(matches.map((diagnostic) => notMemoryReasonForDiagnostic(diagnostic.code)).filter((reason): reason is ConstraintExclusionReason => Boolean(reason))));
  if (canonicalReasons.length !== 1) return null;
  return { ...exclusion, reason: canonicalReasons[0] };
}

function findLegacySource(sources: ConstraintSourceRecord[], sourceId: string): LegacyRuleSourceRecord | undefined {
  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  return source?.sourceKind === "legacy_rule" ? source : undefined;
}

function hasMatchingRescope(decision: ConstraintCompilerDecision, source: LegacyRuleSourceRecord, targetScope: ConstraintScope): boolean {
  return decision.rescopeProposals.some((proposal) => (
    proposal.sourceRecordIds.includes(source.sourceId)
    && scopeKey(proposal.fromScope) === scopeKey(source.scope)
    && scopeKey(proposal.toScope) === scopeKey(targetScope)
  ));
}

function dispositionForSource(decision: ConstraintCompilerDecision, sourceId: string): ConstraintSourceDisposition | null {
  if (decision.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(sourceId))) return "excluded";
  if (decision.unresolved.some((unresolved) => unresolved.sourceRecordIds.includes(sourceId))) return "unresolved";
  if (decision.merges.some((merge) => merge.sourceRecordIds.includes(sourceId))) return "merged_source";
  if (decision.constraints.some((constraint) => constraint.sourceRecordIds.includes(sourceId))) return "compiled";
  if (decision.diagnostics.some((diagnostic) => diagnostic.sourceRecordIds.includes(sourceId))) return "diagnostic";
  return null;
}

function hasConstraintMergeOverlap(decision: ConstraintCompilerDecision, sourceId: string): boolean {
  return decision.constraints.some((constraint) => constraint.sourceRecordIds.includes(sourceId))
    && decision.merges.some((merge) => merge.sourceRecordIds.includes(sourceId));
}

function isCompiledMergeDisposition(disposition: ConstraintSourceDisposition): boolean {
  return disposition === "compiled" || disposition === "merged_source";
}

function mappingNormalizationDiagnostic(sourceRecordId: string, llmStated: ConstraintSourceDisposition, canonical: ConstraintSourceDisposition, action = "normalized-to-single-primary"): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_MAPPING_DISPOSITION_NORMALIZED",
    severity: "info",
    message: "compiler mapping disposition normalized to canonical derived disposition",
    sourceRecordIds: [sourceRecordId],
    data: {
      sourceKey: sourceRecordId,
      llmStated,
      canonical,
      action,
    },
  });
}

function exclusionReclassifiedDiagnostic(exclusion: ConstraintDecisionExclusion, index: number, reason: ConstraintUnresolvedReason): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_EXCLUSION_REASON_RECLASSIFIED",
    severity: "warning",
    message: "compiler exclusion reason reclassified to unresolved bucket",
    sourceRecordIds: exclusion.sourceRecordIds,
    data: {
      exclusionIndex: index,
      originalReason: reason,
      canonicalDisposition: "unresolved",
      action: "reclassified-to-unresolved",
    },
  });
}

function exclusionDedupedDiagnostic(sourceId: string, keptReason: ConstraintExclusionReason, droppedReasons: ConstraintExclusionReason[]): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_EXCLUSION_DEDUPED",
    severity: "info",
    message: "compiler duplicate exclusions canonicalized to one exclusion",
    sourceRecordIds: [sourceId],
    data: {
      keptReason,
      droppedReasons,
      action: "deduped-same-disposition",
    },
  });
}

function sourceMultiHomeDiagnostic(sourceId: string, primaryDispositions: string[]): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_SOURCE_MULTI_HOME_QUARANTINED",
    severity: "warning",
    message: "compiler source had multiple primary dispositions and was quarantined to unresolved",
    sourceRecordIds: [sourceId],
    data: {
      primaryDispositions: primaryDispositions.slice().sort(),
      canonicalDisposition: "unresolved",
      canonicalReason: "conflict",
      action: "quarantined-to-unresolved",
    },
  });
}

const VALIDATOR_INTERNAL_CODES_IGNORED_FOR_COMPILED_CLAIMS = new Set<ConstraintShadowDiagnostic["code"]>([
  "SC_MAPPING_DISPOSITION_NORMALIZED",
  "SC_EXCLUSION_REASON_RECLASSIFIED",
  "SC_EXCLUSION_DEDUPED",
  "SC_NOT_MEMORY_SUBTYPE_NORMALIZED",
  "SC_SOURCE_MULTI_HOME_QUARANTINED",
  "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED",
  "SC_EMPTY_CONSTRAINT_DROPPED",
  "SC_ACTIVE_EXCLUSION_DROPPED",
  "SC_COMPILER_ITEM_REJECTED",
]);

function diagnosticClaimsCompiledDisposition(diagnostic: ConstraintShadowDiagnostic): boolean {
  if (VALIDATOR_INTERNAL_CODES_IGNORED_FOR_COMPILED_CLAIMS.has(diagnostic.code)) {
    return false;
  }

  const message = diagnostic.message.toLowerCase();
  if (/\b(?:non[-\s]?compiled|not\s+compiled|not\s+merged|could\s+not\s+be\s+compiled|could\s+not\s+be\s+merged)\b/i.test(message)) {
    return false;
  }

  return /\bmerged_source\b|\bmerged\b|\bcompiled\b|active\s+sources?\s+compiled/i.test(message);
}

function diagnosticAffirmsExcludedDisposition(diagnostic: ConstraintShadowDiagnostic): boolean {
  const message = diagnostic.message.toLowerCase();
  if (/\bnot\s+(?:be\s+)?excluded\b/i.test(message)) return false;
  return /\b(?:excluded|exclusion|exclude|superseded|archived|obsolete|predecessors?)\b/i.test(message);
}

function diagnosticDecisionInconsistencyDiagnostic(
  diagnostic: ConstraintShadowDiagnostic,
  sourceId: string,
  actualDisposition: ConstraintSourceDisposition,
): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_DIAGNOSTIC_DECISION_INCONSISTENCY",
    severity: "warning",
    message: "compiler diagnostic claimed a compiled or merged source but the final decision settled it as excluded or unresolved",
    sourceRecordIds: [sourceId],
    data: {
      diagnosticId: diagnostic.id,
      diagnosticCode: diagnostic.code,
      diagnosticMessage: diagnostic.message,
      claimedDisposition: "compiled_or_merged",
      actualDisposition,
      action: "warn-diagnostic-decision-inconsistency",
    },
  });
}

function emptyConstraintDroppedDiagnostic(constraint: ConstraintDecisionConstraint, index: number, traceSourceRecordIds: string[], sourcePrimary: Map<string, ConstraintSourceDisposition>): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_EMPTY_CONSTRAINT_DROPPED",
    severity: "warning",
    message: "compiler emitted an empty-source ghost constraint already covered by non-compiled primary dispositions",
    sourceRecordIds: traceSourceRecordIds,
    data: {
      constraintIndex: index,
      title: constraint.title,
      sourcePrimary: Object.fromEntries(Array.from(sourcePrimary.entries()).sort(([left], [right]) => left.localeCompare(right))),
      decisionTraceReason: constraint.decisionTrace?.reason,
      action: "dropped-empty-source-ghost-constraint",
    },
  });
}

function activeExclusionDroppedDiagnostic(exclusion: ConstraintDecisionExclusion, index: number, compiledConstraint: ValidatedConstraint): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_ACTIVE_EXCLUSION_DROPPED",
    severity: "warning",
    message: "compiler emitted a status-stale exclusion for an exact active compiled source and it was dropped",
    sourceRecordIds: exclusion.sourceRecordIds,
    data: {
      exclusionIndex: index,
      exclusionReason: exclusion.reason,
      compiledConstraintId: compiledConstraint.constraintId,
      compiledTitle: compiledConstraint.title,
      action: "dropped-status-stale-active-exclusion",
    },
  });
}

function unsupportedMergeReviewPairDiagnostic(merge: ConstraintCompilerDecision["merges"][number], index: number, sources: ConstraintSourceRecord[], perSourcePrimary: Map<string, ConstraintSourceDisposition>): ConstraintShadowDiagnostic {
  const mergeSources = merge.sourceRecordIds
    .map((sourceId) => sources.find((source) => source.sourceId === sourceId))
    .filter((source): source is ConstraintSourceRecord => Boolean(source));
  const legacySources = mergeSources.filter((source): source is LegacyRuleSourceRecord => source.sourceKind === "legacy_rule");
  const injectModes = new Set(legacySources.map((source) => source.injectMode));
  const scopes = new Set(legacySources.map((source) => scopeKey(source.scope)));
  const sourceKinds = Array.from(new Set(mergeSources.map((source) => source.sourceKind))).sort();
  const incompatibleDimension = sourceKinds.length > 1
    ? "heterogeneous"
    : injectModes.size > 1
      ? "injectMode"
      : scopes.size > 1
        ? "scope"
        : "multiplePrimaryDispositions";
  return makeDiagnostic({
    code: "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED",
    severity: "info",
    message: "compiler merge item was an unsupported review pair and was quarantined",
    sourceRecordIds: merge.sourceRecordIds,
    data: {
      mergeIndex: index,
      incompatibleDimension,
      llmStatedReason: merge.reason,
      perSourcePrimary: Object.fromEntries(Array.from(perSourcePrimary.entries()).sort(([left], [right]) => left.localeCompare(right))),
      sourceKindsInMerge: sourceKinds,
      action: "quarantined-unsupported-merge-review-pair",
    },
  });
}

function settledPrimaryDisposition(
  sourceId: string,
  constraints: ConstraintDecisionConstraint[],
  exclusions: ConstraintDecisionExclusion[],
  items: ConstraintDecisionUnresolved[],
): ConstraintSourceDisposition | null {
  const hasCompiled = constraints.some((constraint) => constraint.sourceRecordIds.includes(sourceId));
  const hasExcluded = exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(sourceId));
  const hasUnresolved = items.some((item) => item.sourceRecordIds.includes(sourceId));
  const count = (hasCompiled ? 1 : 0) + (hasExcluded ? 1 : 0) + (hasUnresolved ? 1 : 0);
  if (count !== 1) return null;
  if (hasCompiled) return "compiled";
  if (hasExcluded) return "excluded";
  return "unresolved";
}

function isValidationHashDiagnostic(diagnostic: ConstraintShadowDiagnostic): boolean {
  return diagnostic.code !== "SC_MAPPING_DISPOSITION_NORMALIZED"
    && diagnostic.code !== "SC_EXCLUSION_REASON_RECLASSIFIED"
    && diagnostic.code !== "SC_EXCLUSION_DEDUPED"
    && diagnostic.code !== "SC_NOT_MEMORY_SUBTYPE_NORMALIZED"
    && diagnostic.code !== "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED"
    && diagnostic.code !== "SC_EMPTY_CONSTRAINT_DROPPED"
    && diagnostic.code !== "SC_ACTIVE_EXCLUSION_DROPPED"
    && diagnostic.code !== "SC_DIAGNOSTIC_DECISION_INCONSISTENCY";
}

function quarantineDiagnostic(context: string, constraint: ConstraintDecisionConstraint, reason: string): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_COMPILER_ITEM_REJECTED",
    severity: "warning",
    message: `${context} rejected: ${reason}`,
    sourceRecordIds: constraint.sourceRecordIds,
    data: {
      itemKind: "constraint",
      reason,
      scope: constraint.scope,
      injectMode: constraint.injectMode,
    },
  });
}

function quarantineUnresolved(sourceRecordIds: string[], diagnosticId: string, reason: string): ConstraintDecisionUnresolved {
  return {
    reason: reason.includes("scope") || reason.includes("project") ? "scope_ambiguous" : "model_uncertain",
    sourceRecordIds: sourceRecordIds.slice().sort(),
    diagnosticIds: [diagnosticId],
    note: `Compiler item quarantined: ${reason}`,
  };
}

function rebuildDispositions(
  constraints: ConstraintDecisionConstraint[],
  exclusions: ConstraintDecisionExclusion[],
  unresolved: ConstraintDecisionUnresolved[],
  merges: ConstraintCompilerDecision["merges"],
): Map<string, string[]> {
  const rebuilt = new Map<string, string[]>();
  for (const constraint of constraints) for (const sourceId of constraint.sourceRecordIds) addDisposition(rebuilt, sourceId, "compiled");
  for (const exclusion of exclusions) for (const sourceId of exclusion.sourceRecordIds) addDisposition(rebuilt, sourceId, "excluded");
  for (const item of unresolved) for (const sourceId of item.sourceRecordIds) addDisposition(rebuilt, sourceId, "unresolved");
  for (const merge of merges) for (const sourceId of merge.sourceRecordIds) addDisposition(rebuilt, sourceId, "merged_source");
  return rebuilt;
}

function canDropStatusStaleActiveExclusion(
  exclusion: ConstraintDecisionExclusion,
  exclusionIndex: number,
  sources: ConstraintSourceRecord[],
  decision: ConstraintCompilerDecision,
  constraints: ValidatedConstraint[],
  acceptedExclusions: ConstraintDecisionExclusion[],
  unresolved: ConstraintDecisionUnresolved[],
): ValidatedConstraint | null {
  if (!STATUS_STALE_ACTIVE_EXCLUSION_REASONS.has(exclusion.reason)) return null;
  if (exclusion.sourceRecordIds.length !== 1) return null;
  const sourceId = exclusion.sourceRecordIds[0];
  const source = findLegacySource(sources, sourceId);
  if (source?.status !== "active") return null;
  if (unresolved.some((item) => item.sourceRecordIds.includes(sourceId))) return null;
  if (acceptedExclusions.some((item) => item.sourceRecordIds.includes(sourceId))) return null;
  if (decision.exclusions.some((item, index) => index !== exclusionIndex && item.sourceRecordIds.includes(sourceId))) return null;
  const compiledConstraints = constraints.filter((constraint) => constraint.sourceRecordIds.length === 1 && constraint.sourceRecordIds[0] === sourceId);
  if (compiledConstraints.length !== 1) return null;
  if (constraints.some((constraint) => constraint !== compiledConstraints[0] && constraint.sourceRecordIds.includes(sourceId))) return null;
  const mappings = decision.mappings.filter((mapping) => mapping.sourceRecordId === sourceId);
  if (mappings.length !== 1) return null;
  if (!isCompiledMergeDisposition(mappings[0].disposition)) return null;
  return compiledConstraints[0];
}

function quarantineMultiHomeSources(
  constraints: ConstraintDecisionConstraint[],
  exclusions: ConstraintDecisionExclusion[],
  unresolved: ConstraintDecisionUnresolved[],
  merges: ConstraintCompilerDecision["merges"],
  diagnostics: ConstraintShadowDiagnostic[],
  quarantinedSourceIds: Set<string>,
): void {
  const rebuiltDispositions = rebuildDispositions(constraints, exclusions, unresolved, merges);
  const multiHomeSourceIds = new Set<string>();
  for (const [sourceId, sourceDispositions] of rebuiltDispositions) {
    const primary = new Set(sourceDispositions.map((disposition) => disposition === "merged_source" ? "compiled" : disposition));
    if (primary.size > 1) multiHomeSourceIds.add(sourceId);
  }
  for (const sourceId of multiHomeSourceIds) {
    const primary = Array.from(new Set((rebuiltDispositions.get(sourceId) ?? []).map((disposition) => disposition === "merged_source" ? "compiled" : disposition))).sort();
    const diagnostic = sourceMultiHomeDiagnostic(sourceId, primary);
    diagnostics.push(diagnostic);
    for (let index = constraints.length - 1; index >= 0; index -= 1) {
      if (constraints[index].sourceRecordIds.includes(sourceId)) constraints.splice(index, 1);
    }
    for (let index = exclusions.length - 1; index >= 0; index -= 1) {
      exclusions[index].sourceRecordIds = exclusions[index].sourceRecordIds.filter((candidate) => candidate !== sourceId);
      if (!exclusions[index].sourceRecordIds.length) exclusions.splice(index, 1);
    }
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      unresolved[index].sourceRecordIds = unresolved[index].sourceRecordIds.filter((candidate) => candidate !== sourceId);
      if (!unresolved[index].sourceRecordIds.length) unresolved.splice(index, 1);
    }
    for (let index = merges.length - 1; index >= 0; index -= 1) {
      if (merges[index].sourceRecordIds.includes(sourceId)) merges.splice(index, 1);
    }
    unresolved.push({
      reason: "conflict",
      sourceRecordIds: [sourceId],
      diagnosticIds: [diagnostic.id],
      note: `Compiler source quarantined from multiple primary dispositions: ${primary.join(",")}`,
    });
    quarantinedSourceIds.add(sourceId);
  }
}

export function validateConstraintCompilerDecision(
  sources: ConstraintSourceRecord[],
  decision: ConstraintCompilerDecision,
  options: ValidateConstraintDecisionOptions = {},
): ValidatedConstraintCompilerDecision {
  if (decision.schemaVersion !== "constraint-shadow-decision/v1") {
    throw new Error(`unsupported decision schema ${decision.schemaVersion}`);
  }
  if (options.expectedInputRootHash && decision.inputRootHash !== options.expectedInputRootHash) {
    throw new Error(`decision inputRootHash ${decision.inputRootHash} does not match expected ${options.expectedInputRootHash}`);
  }
  assertNoForbiddenMutationKeys(decision);
  assertDecisionArrays(decision);
  assertDiagnosticConsumers(decision.diagnostics);

  const knownProjectIds = new Set(options.knownProjectIds ?? []);
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const legacySources = legacySourcesOnly(sources);
  const dispositions = new Map<string, string[]>();
  const diagnostics: ConstraintShadowDiagnostic[] = decision.diagnostics.slice();
  const unresolved: ConstraintDecisionUnresolved[] = decision.unresolved.slice();
  const acceptedExclusions: ConstraintDecisionExclusion[] = [];
  const acceptedMerges: ConstraintCompilerDecision["merges"] = [];
  const quarantinedSourceIds = new Set<string>();
  const emptyConstraintGhosts: Array<{ constraint: ConstraintDecisionConstraint; index: number; traceSourceRecordIds: string[] }> = [];

  diagnostics.forEach((diagnostic, index) => {
    assertSourceIdsKnown(diagnostic.sourceRecordIds, sourceIds, `diagnostic[${index}]`);
  });

  const validatedConstraints: ValidatedConstraint[] = [];
  decision.constraints.forEach((constraint, index) => {
    const context = `constraint[${index}]`;
    if (Array.isArray(constraint.sourceRecordIds) && constraint.sourceRecordIds.length === 0) {
      const traceSourceRecordIds = constraint.decisionTrace?.sourceRecordIds;
      if (!Array.isArray(traceSourceRecordIds) || traceSourceRecordIds.length === 0) throw new Error(`${context} has no sourceRecordIds`);
      assertSourceIdsExist(traceSourceRecordIds, sourceIds, `${context}.decisionTrace`);
      emptyConstraintGhosts.push({ constraint, index, traceSourceRecordIds: traceSourceRecordIds.slice().sort() });
      return;
    }
    assertSourceIdsExist(constraint.sourceRecordIds, sourceIds, context);
    let quarantineReason = "";
    try {
      assertScopeKnown(constraint.scope, knownProjectIds, context);
      if (!constraint.compiledBody.trim()) quarantineReason = `${context} compiledBody is empty`;
      for (const sourceId of constraint.sourceRecordIds) {
        const source = findLegacySource(sources, sourceId);
        if (source) {
          if (source.injectMode !== constraint.injectMode) {
            quarantineReason = `${context} injectMode does not match ${sourceId}`;
            break;
          }
          if (scopeKey(source.scope) !== scopeKey(constraint.scope) && !hasMatchingRescope(decision, source, constraint.scope)) {
            quarantineReason = `${context} scope does not match ${sourceId} and has no matching rescope proposal`;
            break;
          }
        }
      }
    } catch (error) {
      quarantineReason = error instanceof Error ? error.message : String(error);
    }

    if (quarantineReason) {
      const diagnostic = quarantineDiagnostic(context, constraint, quarantineReason);
      diagnostics.push(diagnostic);
      unresolved.push(quarantineUnresolved(constraint.sourceRecordIds, diagnostic.id, quarantineReason));
      for (const sourceId of constraint.sourceRecordIds) {
        quarantinedSourceIds.add(sourceId);
        addDisposition(dispositions, sourceId, "unresolved");
      }
      return;
    }

    const projectedSourceRecordIds = constraint.sourceRecordIds.filter((sourceId) => !quarantinedSourceIds.has(sourceId));
    if (projectedSourceRecordIds.length === 0) return;
    const projectedConstraint = { ...constraint, sourceRecordIds: projectedSourceRecordIds };
    for (const sourceId of projectedSourceRecordIds) addDisposition(dispositions, sourceId, "compiled");
    validatedConstraints.push({
      ...projectedConstraint,
      constraintId: options.deriveConstraintIds === false && constraint.constraintId ? constraint.constraintId : constraintIdFor(projectedConstraint),
    });
  });

  const constraintIds = new Set<string>();
  for (const constraint of validatedConstraints) {
    if (constraintIds.has(constraint.constraintId)) throw new Error(`duplicate constraintId ${constraint.constraintId}`);
    constraintIds.add(constraint.constraintId);
  }

  decision.exclusions.forEach((exclusion, index) => {
    assertSourceIdsExist(exclusion.sourceRecordIds, sourceIds, `exclusion[${index}]`);
    if (isUnresolvedReason(exclusion.reason)) {
      const diagnostic = exclusionReclassifiedDiagnostic(exclusion, index, exclusion.reason);
      diagnostics.push(diagnostic);
      const alreadyUnresolved = exclusion.sourceRecordIds.every((sourceId) => unresolved.some((item) => item.sourceRecordIds.includes(sourceId)));
      if (!alreadyUnresolved) {
        unresolved.push({
          reason: exclusion.reason,
          sourceRecordIds: exclusion.sourceRecordIds.slice().sort(),
          diagnosticIds: [...(exclusion.diagnosticIds ?? []), diagnostic.id],
          note: exclusion.note ?? `Compiler exclusion reclassified to unresolved: ${exclusion.reason}`,
        });
      }
      for (const sourceId of exclusion.sourceRecordIds) addDisposition(dispositions, sourceId, "unresolved");
      return;
    }
    validateExclusionReason(exclusion);
    const normalizedExclusion = normalizeNotMemoryExclusion(exclusion, diagnostics);
    if (!normalizedExclusion) {
      throw new Error(`exclusion[${index}] not-memory reason lacks matching diagnostic consumer`);
    }
    if (normalizedExclusion.reason !== exclusion.reason) diagnostics.push(notMemorySubtypeDiagnostic(exclusion, normalizedExclusion.reason));
    if (normalizedExclusion.reason !== "settings_not_memory" && normalizedExclusion.reason !== "tool_contract_not_memory" && normalizedExclusion.reason !== "knowledge_candidate") {
      const droppedConstraint = canDropStatusStaleActiveExclusion(normalizedExclusion, index, sources, decision, validatedConstraints, acceptedExclusions, unresolved);
      if (droppedConstraint) {
        diagnostics.push(activeExclusionDroppedDiagnostic(normalizedExclusion, index, droppedConstraint));
        return;
      }
      for (const sourceId of normalizedExclusion.sourceRecordIds) {
        const source = findLegacySource(sources, sourceId);
        if (source?.status === "active") throw new Error(`exclusion[${index}] uses ${normalizedExclusion.reason} for active source ${sourceId}`);
      }
    }
    acceptedExclusions.push(normalizedExclusion);
    for (const sourceId of normalizedExclusion.sourceRecordIds) addDisposition(dispositions, sourceId, "excluded");
  });
  unresolved.forEach((item, index) => {
    validateUnresolvedReason(item);
    assertSourceIdsExist(item.sourceRecordIds, sourceIds, `unresolved[${index}]`);
    for (const sourceId of item.sourceRecordIds) addDisposition(dispositions, sourceId, "unresolved");
  });

  const exclusionsBySource = new Map<string, ConstraintDecisionExclusion[]>();
  for (const exclusion of acceptedExclusions) {
    for (const sourceId of exclusion.sourceRecordIds) {
      const current = exclusionsBySource.get(sourceId) ?? [];
      current.push(exclusion);
      exclusionsBySource.set(sourceId, current);
    }
  }
  for (const [sourceId, exclusionsForSource] of exclusionsBySource) {
    if (exclusionsForSource.length <= 1) continue;
    const sorted = exclusionsForSource.slice().sort((a, b) => EXCLUSION_REASON_PRIORITY[b.reason] - EXCLUSION_REASON_PRIORITY[a.reason]);
    const kept = sorted[0];
    const dropped = sorted.slice(1);
    diagnostics.push(exclusionDedupedDiagnostic(sourceId, kept.reason, dropped.map((item) => item.reason)));
    for (const exclusion of dropped) {
      exclusion.sourceRecordIds = exclusion.sourceRecordIds.filter((candidate) => candidate !== sourceId);
    }
  }
  for (let index = acceptedExclusions.length - 1; index >= 0; index -= 1) {
    if (!acceptedExclusions[index].sourceRecordIds.length) acceptedExclusions.splice(index, 1);
  }

  quarantineMultiHomeSources(validatedConstraints, acceptedExclusions, unresolved, acceptedMerges, diagnostics, quarantinedSourceIds);
  for (const ghost of emptyConstraintGhosts) {
    const sourcePrimary = new Map<string, ConstraintSourceDisposition>();
    for (const sourceId of ghost.traceSourceRecordIds) {
      const primary = settledPrimaryDisposition(sourceId, validatedConstraints, acceptedExclusions, unresolved);
      if (primary !== "excluded" && primary !== "unresolved") throw new Error(`constraint[${ghost.index}] has no sourceRecordIds`);
      sourcePrimary.set(sourceId, primary);
    }
    diagnostics.push(emptyConstraintDroppedDiagnostic(ghost.constraint, ghost.index, ghost.traceSourceRecordIds, sourcePrimary));
  }

  decision.merges.forEach((merge, index) => {
    assertSourceIdsExist(merge.sourceRecordIds, sourceIds, `merge[${index}]`);
    if (merge.sourceRecordIds.some((sourceId) => quarantinedSourceIds.has(sourceId))) return;
    // ADR0039 design-maxim + §12 resilience: targetConstraintId is an OPTIONAL hint
    // the LLM cannot compute (real ids are post-hoc content hashes, constraintIdFor).
    // A dangling hint must NOT reject the whole decision — that froze the constraint
    // projector on 2026-06-21 (LLM merged the near-duplicate no-industry-jargon rules
    // and named the target descriptively). Ignore an unknown hint and bind the merge
    // by sourceRecordIds coverage, which is the real invariant; only an uncovered
    // merge (no compiled constraint contains all its sources) is a hard error.
    const pinnedTargetId = merge.targetConstraintId && constraintIds.has(merge.targetConstraintId)
      ? merge.targetConstraintId
      : undefined;
    const coveringConstraint = validatedConstraints.find((constraint) => (
      (!pinnedTargetId || constraint.constraintId === pinnedTargetId)
      && merge.sourceRecordIds.every((sourceId) => constraint.sourceRecordIds.includes(sourceId))
    ));
    if (!coveringConstraint) {
      const perSourcePrimary = new Map<string, ConstraintSourceDisposition>();
      for (const sourceId of merge.sourceRecordIds) {
        const primary = settledPrimaryDisposition(sourceId, validatedConstraints, acceptedExclusions, unresolved);
        if (!primary) throw new Error(`merge[${index}] source records are not all covered by exactly one settled primary disposition`);
        perSourcePrimary.set(sourceId, primary);
      }
      diagnostics.push(unsupportedMergeReviewPairDiagnostic(merge, index, sources, perSourcePrimary));
      return;
    }
    acceptedMerges.push(merge);
    for (const sourceId of merge.sourceRecordIds) addDisposition(dispositions, sourceId, "merged_source");
  });

  quarantineMultiHomeSources(validatedConstraints, acceptedExclusions, unresolved, acceptedMerges, diagnostics, quarantinedSourceIds);
  const rebuiltDispositions = rebuildDispositions(validatedConstraints, acceptedExclusions, unresolved, acceptedMerges);
  dispositions.clear();
  for (const [sourceId, sourceDispositions] of rebuiltDispositions) dispositions.set(sourceId, sourceDispositions.slice());

  decision.rescopeProposals.forEach((proposal, index) => {
    assertSourceIdsExist(proposal.sourceRecordIds, sourceIds, `rescopeProposal[${index}]`);
    assertScopeKnown(proposal.toScope, knownProjectIds, `rescopeProposal[${index}].toScope`);
    for (const sourceId of proposal.sourceRecordIds) {
      const source = sources.find((candidate) => candidate.sourceId === sourceId);
      if (source?.sourceKind === "legacy_rule" && scopeKey(source.scope) !== scopeKey(proposal.fromScope)) {
        throw new Error(`rescopeProposal[${index}] fromScope does not match ${sourceId}`);
      }
    }
  });

  const mappings: ConstraintDecisionMapping[] = [];
  decision.mappings.forEach((mapping: ConstraintDecisionMapping, index) => {
    if (!sourceIds.has(mapping.sourceRecordId)) throw new Error(`mapping[${index}] references unknown source ${mapping.sourceRecordId}`);
    const derivedDecision = { ...decision, constraints: validatedConstraints, exclusions: acceptedExclusions, unresolved, merges: acceptedMerges, diagnostics };
    const actualDisposition = dispositionForSource(derivedDecision, mapping.sourceRecordId);
    if (actualDisposition && mapping.disposition !== actualDisposition) {
      const compiledMergeEquivalent = hasConstraintMergeOverlap(derivedDecision, mapping.sourceRecordId)
        && isCompiledMergeDisposition(mapping.disposition)
        && isCompiledMergeDisposition(actualDisposition);
      if (compiledMergeEquivalent) {
        diagnostics.push(mappingNormalizationDiagnostic(mapping.sourceRecordId, mapping.disposition, actualDisposition, "accepted-as-equivalent"));
        mappings.push({ ...mapping, disposition: actualDisposition });
      } else if (quarantinedSourceIds.has(mapping.sourceRecordId)) {
        diagnostics.push(mappingNormalizationDiagnostic(mapping.sourceRecordId, mapping.disposition, actualDisposition, "normalized-to-quarantined-primary"));
        mappings.push({ ...mapping, disposition: actualDisposition });
      } else {
        diagnostics.push(mappingNormalizationDiagnostic(mapping.sourceRecordId, mapping.disposition, actualDisposition));
        mappings.push({ ...mapping, disposition: actualDisposition });
      }
    } else {
      mappings.push(mapping);
    }
    addDisposition(dispositions, mapping.sourceRecordId, "mapping");
  });

  for (const source of legacySources) {
    const existingPrimary = (dispositions.get(source.sourceId) ?? []).filter((disposition) => disposition !== "mapping");
    if (existingPrimary.length === 0 && hasDiagnosticForSource({ ...decision, diagnostics }, source.sourceId)) {
      addDisposition(dispositions, source.sourceId, "diagnostic");
    }
    const primary = (dispositions.get(source.sourceId) ?? []).filter((disposition) => disposition !== "mapping");
    const uniquePrimary = new Set(primary);
    if (uniquePrimary.size === 0) throw new Error(`legacy source ${source.sourceId} has no primary disposition`);
    if (primary.filter((disposition) => disposition === "compiled").length > 1) {
      throw new Error(`legacy source ${source.sourceId} is compiled more than once`);
    }
    if (uniquePrimary.has("compiled") && uniquePrimary.has("excluded")) {
      throw new Error(`legacy source ${source.sourceId} is both compiled and excluded`);
    }
    if (uniquePrimary.size > 1 && !(uniquePrimary.has("merged_source") && uniquePrimary.has("compiled"))) {
      throw new Error(`legacy source ${source.sourceId} has multiple primary dispositions: ${Array.from(uniquePrimary).join(",")}`);
    }
  }

  // pi-astack: enforce the prompt contract "every source record must receive
  // exactly one primary disposition" for EVENT sources too. The legacy loop
  // above only covers legacy_rule sources, so the compiler could silently DROP a
  // constraint_event (no compiled/merged/excluded/unresolved). That passed
  // validation (ok:true) yet left the projection incomplete: the event stayed
  // un-projected, event coverage fell below 1.0, the runtime injection gate fell
  // back to legacy, and that event's rule never injected. Throwing here is
  // RETRYABLE — the shadow-runner B loop re-prompts the model with this exact
  // list so the model dispositions the missing events itself. Cognition stays
  // with the LLM; this only makes the already-stated completeness contract
  // enforceable instead of silently violable.
  const uncoveredEventSources = options.requireEventCompleteness
    ? sources
      .filter((source) => source.sourceKind === "constraint_event")
      .map((source) => source.sourceId)
      .filter((sourceId) => !(dispositions.get(sourceId) ?? []).some((disposition) =>
        disposition === "compiled" || disposition === "merged_source" || disposition === "excluded" || disposition === "unresolved"))
      .sort()
    : [];
  if (uncoveredEventSources.length > 0) {
    throw new Error(
      `${uncoveredEventSources.length} constraint_event source(s) received no primary disposition: `
      + `${uncoveredEventSources.join(", ")}. Every source record must receive exactly one primary `
      + `disposition (compiled, merged_source, excluded, or unresolved); place each missing event in the correct bucket.`,
    );
  }

  const finalDecisionForDisposition = { ...decision, constraints: validatedConstraints, exclusions: acceptedExclusions, unresolved, merges: acceptedMerges, diagnostics };
  const existingInconsistencyKeys = new Set(diagnostics
    .filter((diagnostic) => diagnostic.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY")
    .map((diagnostic) => `${diagnostic.data?.diagnosticId ?? ""}:${diagnostic.sourceRecordIds.join("+")}`));
  for (const diagnostic of diagnostics.slice()) {
    if (diagnostic.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY") continue;
    if (!diagnosticClaimsCompiledDisposition(diagnostic)) continue;
    for (const sourceId of diagnostic.sourceRecordIds) {
      const actualDisposition = dispositionForSource(finalDecisionForDisposition, sourceId);
      if (actualDisposition !== "excluded" && actualDisposition !== "unresolved") continue;
      if (actualDisposition === "excluded" && diagnosticAffirmsExcludedDisposition(diagnostic)) continue;
      const key = `${diagnostic.id}:${sourceId}`;
      if (existingInconsistencyKeys.has(key)) continue;
      diagnostics.push(diagnosticDecisionInconsistencyDiagnostic(diagnostic, sourceId, actualDisposition));
      existingInconsistencyKeys.add(key);
    }
  }

  const validationHashDiagnostics = diagnostics.filter(isValidationHashDiagnostic);
  const validationHash = sha256Hex(stableCanonicalize({ ...decision, constraints: validatedConstraints, exclusions: acceptedExclusions, unresolved, merges: acceptedMerges, mappings, diagnostics: validationHashDiagnostics }));
  return { ...decision, constraints: validatedConstraints, exclusions: acceptedExclusions, unresolved, merges: acceptedMerges, mappings, diagnostics, validationHash };
}
