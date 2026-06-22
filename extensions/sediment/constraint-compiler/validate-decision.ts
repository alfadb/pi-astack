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
import { inferCategoryHint, sha256Hex, stableCanonicalize } from "./normalize";
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

export interface ValidateConstraintDecisionOptions {
  knownProjectIds?: string[];
  deriveConstraintIds?: boolean;
  expectedInputRootHash?: string;
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

function normalizeNotMemoryExclusion(exclusion: ConstraintDecisionExclusion, diagnostics: ConstraintShadowDiagnostic[], sources: ConstraintSourceRecord[]): ConstraintDecisionExclusion | null {
  const expectedCode = notMemoryDiagnosticCodeFor(exclusion.reason);
  if (!expectedCode) return exclusion;
  const matches = matchingNotMemoryDiagnostics(diagnostics, exclusion.sourceRecordIds);
  if (!matches.length) return null;
  if (matches.some((diagnostic) => diagnostic.code === expectedCode)) return exclusion;
  const canonicalReasons = Array.from(new Set(matches.map((diagnostic) => notMemoryReasonForDiagnostic(diagnostic.code)).filter((reason): reason is ConstraintExclusionReason => Boolean(reason))));
  if (canonicalReasons.length !== 1) return null;
  const sourceHints = exclusion.sourceRecordIds.map((sourceId) => sources.find((source) => source.sourceId === sourceId)).map((source) => source ? inferCategoryHint(source) : "unknown");
  if (!sourceHints.every((hint) => hint === canonicalReasons[0])) return null;
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

function isValidationHashDiagnostic(diagnostic: ConstraintShadowDiagnostic): boolean {
  return diagnostic.code !== "SC_MAPPING_DISPOSITION_NORMALIZED"
    && diagnostic.code !== "SC_EXCLUSION_REASON_RECLASSIFIED"
    && diagnostic.code !== "SC_EXCLUSION_DEDUPED"
    && diagnostic.code !== "SC_NOT_MEMORY_SUBTYPE_NORMALIZED";
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
  const acceptedMerges = decision.merges.slice();
  const quarantinedSourceIds = new Set<string>();

  diagnostics.forEach((diagnostic, index) => {
    assertSourceIdsKnown(diagnostic.sourceRecordIds, sourceIds, `diagnostic[${index}]`);
  });

  const validatedConstraints: ValidatedConstraint[] = [];
  decision.constraints.forEach((constraint, index) => {
    const context = `constraint[${index}]`;
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

    for (const sourceId of constraint.sourceRecordIds) addDisposition(dispositions, sourceId, "compiled");
    validatedConstraints.push({
      ...constraint,
      constraintId: options.deriveConstraintIds === false && constraint.constraintId ? constraint.constraintId : constraintIdFor(constraint),
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
    const normalizedExclusion = normalizeNotMemoryExclusion(exclusion, diagnostics, sources);
    if (!normalizedExclusion) {
      throw new Error(`exclusion[${index}] not-memory reason lacks matching diagnostic consumer`);
    }
    if (normalizedExclusion.reason !== exclusion.reason) diagnostics.push(notMemorySubtypeDiagnostic(exclusion, normalizedExclusion.reason));
    if (normalizedExclusion.reason !== "settings_not_memory" && normalizedExclusion.reason !== "tool_contract_not_memory" && normalizedExclusion.reason !== "knowledge_candidate") {
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

  acceptedMerges.length = 0;
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
    if (!coveringConstraint) throw new Error(`merge[${index}] source records are not covered by one compiled constraint`);
    acceptedMerges.push(merge);
    for (const sourceId of merge.sourceRecordIds) addDisposition(dispositions, sourceId, "merged_source");
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

  let rebuiltDispositions = rebuildDispositions(validatedConstraints, acceptedExclusions, unresolved, acceptedMerges);
  const multiHomeSourceIds = new Set<string>();
  for (const [sourceId, sourceDispositions] of rebuiltDispositions) {
    const primary = new Set(sourceDispositions.map((disposition) => disposition === "merged_source" ? "compiled" : disposition));
    if (primary.size > 1) multiHomeSourceIds.add(sourceId);
  }
  for (const sourceId of multiHomeSourceIds) {
    const primary = Array.from(new Set((rebuiltDispositions.get(sourceId) ?? []).map((disposition) => disposition === "merged_source" ? "compiled" : disposition))).sort();
    const diagnostic = sourceMultiHomeDiagnostic(sourceId, primary);
    diagnostics.push(diagnostic);
    for (let index = validatedConstraints.length - 1; index >= 0; index -= 1) {
      if (validatedConstraints[index].sourceRecordIds.includes(sourceId)) validatedConstraints.splice(index, 1);
    }
    for (let index = acceptedExclusions.length - 1; index >= 0; index -= 1) {
      acceptedExclusions[index].sourceRecordIds = acceptedExclusions[index].sourceRecordIds.filter((candidate) => candidate !== sourceId);
      if (!acceptedExclusions[index].sourceRecordIds.length) acceptedExclusions.splice(index, 1);
    }
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      unresolved[index].sourceRecordIds = unresolved[index].sourceRecordIds.filter((candidate) => candidate !== sourceId);
      if (!unresolved[index].sourceRecordIds.length) unresolved.splice(index, 1);
    }
    for (let index = acceptedMerges.length - 1; index >= 0; index -= 1) {
      if (acceptedMerges[index].sourceRecordIds.includes(sourceId)) acceptedMerges.splice(index, 1);
    }
    unresolved.push({
      reason: "conflict",
      sourceRecordIds: [sourceId],
      diagnosticIds: [diagnostic.id],
      note: `Compiler source quarantined from multiple primary dispositions: ${primary.join(",")}`,
    });
    quarantinedSourceIds.add(sourceId);
  }
  rebuiltDispositions = rebuildDispositions(validatedConstraints, acceptedExclusions, unresolved, acceptedMerges);
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

  const validationHashDiagnostics = diagnostics.filter(isValidationHashDiagnostic);
  const validationHash = sha256Hex(stableCanonicalize({ ...decision, constraints: validatedConstraints, exclusions: acceptedExclusions, unresolved, merges: acceptedMerges, mappings, diagnostics: validationHashDiagnostics }));
  return { ...decision, constraints: validatedConstraints, exclusions: acceptedExclusions, unresolved, merges: acceptedMerges, mappings, diagnostics, validationHash };
}
