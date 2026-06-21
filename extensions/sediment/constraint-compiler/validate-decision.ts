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

function hasNotMemoryDiagnostic(diagnostics: ConstraintShadowDiagnostic[], sourceIds: string[], reason: ConstraintExclusionReason): boolean {
  const requiredCode = reason === "settings_not_memory"
    ? "SC_NOT_MEMORY_SETTINGS"
    : reason === "tool_contract_not_memory"
      ? "SC_NOT_MEMORY_TOOL_CONTRACT"
      : null;
  if (!requiredCode) return true;
  return diagnostics.some((diagnostic) => (
    diagnostic.code === requiredCode
    && Array.isArray(diagnostic.consumers)
    && diagnostic.consumers.length > 0
    && Array.isArray(diagnostic.sourceRecordIds)
    && sourceIds.every((sourceId) => diagnostic.sourceRecordIds.includes(sourceId))
  ));
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

function mappingNormalizationDiagnostic(sourceRecordId: string, llmStated: ConstraintSourceDisposition, canonical: ConstraintSourceDisposition): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_MAPPING_DISPOSITION_NORMALIZED",
    severity: "info",
    message: "compiler mapping disposition normalized to canonical derived disposition",
    sourceRecordIds: [sourceRecordId],
    data: {
      sourceKey: sourceRecordId,
      llmStated,
      canonical,
      action: "accepted-as-equivalent",
    },
  });
}

function isValidationHashDiagnostic(diagnostic: ConstraintShadowDiagnostic): boolean {
  return diagnostic.code !== "SC_MAPPING_DISPOSITION_NORMALIZED";
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
    validateExclusionReason(exclusion);
    assertSourceIdsExist(exclusion.sourceRecordIds, sourceIds, `exclusion[${index}]`);
    if ((exclusion.reason === "settings_not_memory" || exclusion.reason === "tool_contract_not_memory") && !hasNotMemoryDiagnostic(diagnostics, exclusion.sourceRecordIds, exclusion.reason)) {
      throw new Error(`exclusion[${index}] not-memory reason lacks matching diagnostic consumer`);
    }
    if (exclusion.reason !== "settings_not_memory" && exclusion.reason !== "tool_contract_not_memory" && exclusion.reason !== "knowledge_candidate") {
      for (const sourceId of exclusion.sourceRecordIds) {
        const source = findLegacySource(sources, sourceId);
        if (source?.status === "active") throw new Error(`exclusion[${index}] uses ${exclusion.reason} for active source ${sourceId}`);
      }
    }
    for (const sourceId of exclusion.sourceRecordIds) addDisposition(dispositions, sourceId, "excluded");
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
    const derivedDecision = { ...decision, constraints: validatedConstraints, unresolved, merges: acceptedMerges, diagnostics };
    const actualDisposition = dispositionForSource(derivedDecision, mapping.sourceRecordId);
    if (actualDisposition && mapping.disposition !== actualDisposition) {
      const compiledMergeEquivalent = hasConstraintMergeOverlap(derivedDecision, mapping.sourceRecordId)
        && isCompiledMergeDisposition(mapping.disposition)
        && isCompiledMergeDisposition(actualDisposition);
      if (compiledMergeEquivalent) {
        diagnostics.push(mappingNormalizationDiagnostic(mapping.sourceRecordId, mapping.disposition, actualDisposition));
        mappings.push({ ...mapping, disposition: actualDisposition });
      } else if (quarantinedSourceIds.has(mapping.sourceRecordId)) {
        mappings.push({ ...mapping, disposition: actualDisposition });
      } else {
        throw new Error(`mapping[${index}] disposition ${mapping.disposition} does not match actual ${actualDisposition}`);
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
  const validationHash = sha256Hex(stableCanonicalize({ ...decision, constraints: validatedConstraints, unresolved, merges: acceptedMerges, mappings, diagnostics: validationHashDiagnostics }));
  return { ...decision, constraints: validatedConstraints, unresolved, merges: acceptedMerges, mappings, diagnostics, validationHash };
}
