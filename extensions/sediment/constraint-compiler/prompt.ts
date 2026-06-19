import { sanitizeForMemory } from "../sanitizer";
import type {
  ConstraintCompilerPrompt,
  ConstraintCompilerPromptInput,
  NormalizedConstraintRecord,
} from "./types";
import { sha256Hex, stableCanonicalize } from "./normalize";

const PROMPT_SCHEMA_VERSION = "constraint-shadow-prompt/v1";

function renderScope(record: NormalizedConstraintRecord): string {
  if (!record.scope) return "none";
  return record.scope.kind === "global" ? "global" : `project:${record.scope.projectId}`;
}

function renderRecord(record: NormalizedConstraintRecord): Record<string, unknown> {
  return {
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    scope: renderScope(record),
    injectMode: record.injectMode ?? "none",
    status: record.status ?? "none",
    title: record.title ?? "",
    categoryHint: record.categoryHint,
    sourceHash: record.sourceHash,
    normalized: record.normalized,
  };
}

export function buildConstraintCompilerPrompt(input: ConstraintCompilerPromptInput): ConstraintCompilerPrompt {
  const knownProjectIds = input.knownProjectIds?.slice().sort() ?? [];
  const payload = {
    inputRootHash: input.normalized.inputRootHash,
    activeProjectId: input.activeProjectId,
    knownProjectIds,
    baselineSummary: input.baselineSummary ?? "No runtime injection baseline is used in PR3.",
    normalizedRecords: input.normalized.records.map(renderRecord),
    existingDiagnostics: input.normalized.diagnostics,
  };
  const text = [
    "You are ADR 0039 Constraint Shadow Compiler PR3.",
    "This is a shadow-only analysis task. Do not propose or describe writes to canonical rules, memory entries, settings, runtime hooks, or session injection.",
    "Return JSON only. Do not wrap the response in markdown fences. Do not invent sourceRecordIds or projectIds.",
    "Every legacy rule source must receive exactly one mapping disposition: compiled, merged_source, excluded, unresolved, or diagnostic.",
    "Settings and tool-contract records must be exclusions with matching diagnostics, not compiled constraints.",
    "Project-specific evidence must stay project-scoped unless rescopeProposals records an explicit scope change.",
    "Conflicts, unknown status, and insufficient provenance must stay unresolved; do not archive or delete anything.",
    "Near duplicates may be merged only when all sourceRecordIds remain traceable in one compiled constraint.",
    "Schema to return:",
    stableCanonicalize({
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash: input.normalized.inputRootHash,
      constraints: ["ConstraintDecisionConstraint[]"],
      exclusions: ["ConstraintDecisionExclusion[]"],
      unresolved: ["ConstraintDecisionUnresolved[]"],
      merges: ["ConstraintDecisionMerge[]"],
      rescopeProposals: ["ConstraintDecisionRescopeProposal[]"],
      mappings: ["ConstraintDecisionMapping[]"],
      diagnostics: ["ConstraintShadowDiagnostic[]"],
    }),
    "Input payload:",
    stableCanonicalize(payload),
  ].join("\n\n");
  const sanitized = sanitizeForMemory(text);
  const sanitizedText = sanitized.text ?? text;
  if (input.maxPromptChars && sanitizedText.length > input.maxPromptChars) {
    throw new Error(`constraint prompt exceeds maxPromptChars ${input.maxPromptChars}`);
  }
  return {
    schemaVersion: PROMPT_SCHEMA_VERSION,
    inputRootHash: input.normalized.inputRootHash,
    promptHash: sha256Hex(sanitizedText),
    text: sanitizedText,
    recordCount: input.normalized.records.length,
  };
}
