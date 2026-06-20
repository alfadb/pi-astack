import { createHash } from "node:crypto";
import { sanitizeForMemory } from "../sanitizer";
import type {
  AuditConstraintSourceRecord,
  ConstraintCategoryHint,
  ConstraintEventSourceRecord,
  ConstraintShadowDiagnostic,
  ConstraintSourceRecord,
  GovernanceCaseRecord,
  LegacyRuleSourceRecord,
  NormalizeConstraintOptions,
  NormalizeConstraintResult,
  NormalizedConstraintRecord,
} from "./types";
import { makeDiagnostic } from "./diagnostics";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

export function stableCanonicalize(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!value || typeof value !== "object") return value;
  const objectValue = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue).sort()) {
    if (objectValue[key] === undefined) continue;
    output[key] = stableValue(objectValue[key]);
  }
  return output;
}

function textIncludesAny(text: string, needles: string[]): boolean {
  const lowerText = text.toLowerCase();
  return needles.some((needle) => lowerText.includes(needle));
}

export function inferCategoryHint(record: ConstraintSourceRecord): ConstraintCategoryHint {
  if (record.sourceKind === "constraint_event") {
    if (record.operationHint === "not_memory") {
      return record.notMemoryHint === "tool_contract" ? "tool_contract_not_memory" : "settings_not_memory";
    }
    if (record.operationHint === "unclassified" || record.eventType === "constraint_unclassified_observed") return "unknown";
    return "behavioral_constraint";
  }
  if (record.sourceKind !== "legacy_rule") return "unknown";
  const combined = [
    record.title,
    record.body,
    record.appliesWhen,
    record.mustDoSummary,
    ...record.triggerPhrases,
  ].join("\n");

  if (textIncludesAny(combined, ["settings", "setting", "model tier", "provider", "feature flag", "配置", "模型档位", "供应商"])) {
    return "settings_not_memory";
  }
  if (textIncludesAny(combined, ["tool contract", "dispatch_parallel", "prompt_user", "vault_release", "工具契约", "工具调用", "tool allowlist"])) {
    return "tool_contract_not_memory";
  }
  if (textIncludesAny(combined, ["knowledge", "fact", "知识", "事实"])) {
    return "knowledge_not_constraint";
  }
  if (record.status === "contested" || textIncludesAny(combined, ["conflict", "contradict", "冲突", "矛盾"])) {
    return "potential_conflict_signal";
  }
  return "behavioral_constraint";
}

function sanitizeText(input: string): { text: string; replacements: string[] } {
  const result = sanitizeForMemory(input);
  return { text: result.text ?? input, replacements: result.replacements };
}

function normalizeLegacyRule(record: LegacyRuleSourceRecord): NormalizedConstraintRecord {
  const sanitizedBody = sanitizeText(record.body);
  const normalized = {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    slug: record.slug,
    title: record.title,
    scope: record.scope,
    injectMode: record.injectMode,
    status: record.status,
    body: sanitizedBody.text,
    rawBodyHash: record.rawBodyHash,
    computedBodyHash: record.computedBodyHash,
    rawFileHash: record.rawFileHash,
    frontmatterHash: record.frontmatterHash,
    provenance: record.provenance,
    confidence: record.confidence,
    kind: record.kind,
    triggerPhrases: record.triggerPhrases.slice().sort(),
    appliesWhen: record.appliesWhen,
    mustDoSummary: record.mustDoSummary,
    sourceRef: record.sourceRef,
  };
  return {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    scope: record.scope,
    injectMode: record.injectMode,
    status: record.status,
    title: record.title,
    body: sanitizedBody.text,
    categoryHint: inferCategoryHint(record),
    sourceHash: sha256Hex(stableCanonicalize(normalized)),
    normalized,
    sanitizerReplacements: sanitizedBody.replacements,
  };
}

function normalizeAudit(record: AuditConstraintSourceRecord): NormalizedConstraintRecord {
  const sanitizedRow = sanitizeText(record.rawSanitizedRow);
  const normalized = {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    timestamp: record.timestamp,
    sessionId: record.sessionId,
    operation: record.operation,
    lane: record.lane,
    ruleSlug: record.ruleSlug,
    ruleScope: record.ruleScope,
    projectId: record.projectId,
    reason: record.reason,
    rawSanitizedRow: sanitizedRow.text,
    sourceRef: record.sourceRef,
  };
  return {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    categoryHint: "unknown",
    sourceHash: sha256Hex(stableCanonicalize(normalized)),
    normalized,
    sanitizerReplacements: sanitizedRow.replacements,
  };
}

function normalizeGovernanceCase(record: GovernanceCaseRecord): NormalizedConstraintRecord {
  const sanitizedExpectation = sanitizeText(record.expectation);
  const normalized = {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    category: record.category,
    title: record.title,
    expectation: sanitizedExpectation.text,
    sourceRef: record.sourceRef,
  };
  return {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    title: record.title,
    categoryHint: "unknown",
    sourceHash: sha256Hex(stableCanonicalize(normalized)),
    normalized,
    sanitizerReplacements: sanitizedExpectation.replacements,
  };
}

function normalizeConstraintEvent(record: ConstraintEventSourceRecord): NormalizedConstraintRecord {
  const sanitizedQuote = sanitizeText(record.sanitizedQuote);
  const sanitizedText = sanitizeText(record.candidateText);
  const scope = record.scopeHint.kind === "global"
    ? { kind: "global" as const }
    : record.scopeHint.kind === "project"
      ? { kind: "project" as const, projectId: record.scopeHint.projectId }
      : undefined;
  const normalized = {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    eventId: record.eventId,
    eventType: record.eventType,
    createdAtUtc: record.createdAtUtc,
    sessionId: record.sessionId,
    turnId: record.turnId,
    sourceChannel: record.sourceChannel,
    sourceRole: record.sourceRole,
    operationHint: record.operationHint,
    confidence: record.confidence,
    sanitizedQuote: sanitizedQuote.text,
    candidateText: sanitizedText.text,
    candidateTitle: record.candidateTitle,
    candidateTriggerPhrases: record.candidateTriggerPhrases.slice().sort(),
    candidateAppliesWhen: record.candidateAppliesWhen,
    candidatePriorityHint: record.candidatePriorityHint,
    notMemoryHint: record.notMemoryHint,
    unclassifiedReason: record.unclassifiedReason,
    scopeHint: record.scopeHint,
    activeProjectId: record.activeProjectId,
    scopeConfidence: record.scopeConfidence,
    sanitizerStatus: record.sanitizerStatus,
    sanitizerReplacementsCount: record.sanitizerReplacementsCount,
    legacyParallelWrite: record.legacyParallelWrite,
    causalParents: record.causalParents.slice().sort(),
    producerName: record.producerName,
    producerVersion: record.producerVersion,
    replayProvenance: record.replayProvenance,
    bodyHash: record.bodyHash,
    sourceRef: record.sourceRef,
  };
  return {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    scope,
    title: record.candidateTitle,
    body: sanitizedText.text,
    categoryHint: inferCategoryHint(record),
    sourceHash: sha256Hex(stableCanonicalize(normalized)),
    normalized,
    sanitizerReplacements: [...sanitizedQuote.replacements, ...sanitizedText.replacements].sort(),
  };
}

export function normalizeConstraintSources(
  sources: ConstraintSourceRecord[],
  options: NormalizeConstraintOptions = {},
): NormalizeConstraintResult {
  const diagnostics: ConstraintShadowDiagnostic[] = [];
  const records = sources.map((source) => {
    if (source.sourceKind === "legacy_rule") return normalizeLegacyRule(source);
    if (source.sourceKind === "audit") return normalizeAudit(source);
    if (source.sourceKind === "constraint_event") return normalizeConstraintEvent(source);
    return normalizeGovernanceCase(source);
  }).sort((leftRecord, rightRecord) => leftRecord.sourceId.localeCompare(rightRecord.sourceId));

  for (const record of records) {
    if (record.categoryHint === "settings_not_memory") {
      diagnostics.push(makeDiagnostic({
        code: "SC_NOT_MEMORY_SETTINGS",
        message: `settings-like constraint should be excluded from canonical rule memory: ${record.sourceId}`,
        sourceRecordIds: [record.sourceId],
      }));
    }
    if (record.categoryHint === "tool_contract_not_memory") {
      diagnostics.push(makeDiagnostic({
        code: "SC_NOT_MEMORY_TOOL_CONTRACT",
        message: `tool-contract-like constraint should be excluded from canonical rule memory: ${record.sourceId}`,
        sourceRecordIds: [record.sourceId],
      }));
    }
  }

  for (const source of sources) {
    if (source.sourceKind !== "legacy_rule") continue;
    if (source.rawBodyHash && source.computedBodyHash && source.rawBodyHash !== source.computedBodyHash) {
      diagnostics.push(makeDiagnostic({
        code: "SC_INPUT_BODY_HASH_MISMATCH",
        message: `body hash mismatch for ${source.sourceId}`,
        sourceRecordIds: [source.sourceId],
        data: { rawBodyHash: source.rawBodyHash, computedBodyHash: source.computedBodyHash },
      }));
    }
  }

  const inputSnapshot = {
    records: records.map((record) => record.normalized),
    activeProjectId: options.activeProjectId,
    knownProjectIds: options.knownProjectIds?.slice().sort() ?? [],
    compilerOptions: options.compilerOptions ?? {},
    auditTruncation: options.auditTruncation ?? {},
  };
  const inputRootHash = sha256Hex(stableCanonicalize(inputSnapshot));
  return { records, inputRootHash, diagnostics };
}
