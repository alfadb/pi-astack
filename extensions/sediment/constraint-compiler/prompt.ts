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
    "Never include mutation-key fields anywhere in the output object, including diagnostics.data: canonicalPath, canonical_path, targetPath, target_path, writePath, write_path, archiveSlugs, archive_slugs, deleteSlug, delete_slug, mutation, operation.",
    "Every item that references records must use sourceRecordIds as an array of exact sourceId strings from the input payload. Never use sourceId, sources, refs, sourceIds, or a single string.",
    "For every compiled constraint, injectMode must exactly match every referenced legacy rule record. Never combine always and listed records in one compiled constraint.",
    "For every compiled constraint, scope must exactly match every referenced legacy rule record unless a matching rescopeProposals item is present for that source.",
    "Source scope is authoritative. Topic text is not scope evidence: a global rule that mentions a project name such as sub2api or merdata stays global unless a valid explicit rescopeProposals item is present.",
    "Never infer project scope from a title, body, repository name, product name, or the word project in the rule text.",
    "Every legacy rule source must receive exactly one mapping disposition: compiled, merged_source, excluded, unresolved, or diagnostic.",
    "Settings and tool-contract records must be exclusions with matching diagnostics, not compiled constraints.",
    "Project-specific evidence must stay project-scoped unless rescopeProposals records an explicit scope change.",
    "Conflicts, unknown status, and insufficient provenance must stay unresolved; do not archive or delete anything.",
    "Allowed exclusion reasons are settings_not_memory, tool_contract_not_memory, knowledge_candidate, obsolete_archived, superseded_observed, legacy_archived_observed, malformed_unusable.",
    "Allowed unresolved reasons are conflict, scope_ambiguous, insufficient_provenance, parse_error, model_uncertain, unknown_status. Never use archived, superseded, deprecated, or obsolete as unresolved reasons.",
    "Archived, superseded, and deprecated legacy records must be exclusions or diagnostics, not active compiled constraints.",
    "Near duplicates may be merged only when all sourceRecordIds remain traceable in one compiled constraint.",
    "Required JSON shape:",
    stableCanonicalize({
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash: input.normalized.inputRootHash,
      constraints: [{
        scope: { kind: "global" },
        injectMode: "always",
        title: "short compiled rule title",
        compiledBody: "complete compiled constraint text",
        mustDoSummary: "optional short imperative summary",
        appliesWhen: "optional applicability text",
        triggerPhrases: ["optional trigger phrase"],
        priorityHint: 5,
        sourceRecordIds: ["exact sourceId string"],
        sourceAuditIds: [],
        decisionTrace: { reason: "why this was compiled", sourceRecordIds: ["exact sourceId string"], diagnosticIds: [] },
      }],
      exclusions: [{ reason: "settings_not_memory", sourceRecordIds: ["exact sourceId string"], diagnosticIds: [], note: "optional note" }],
      unresolved: [{ reason: "conflict", sourceRecordIds: ["exact sourceId string"], diagnosticIds: [], note: "optional note" }],
      merges: [{ sourceRecordIds: ["exact sourceId string", "exact sourceId string"], reason: "why these sources merge" }],
      rescopeProposals: [{ sourceRecordIds: ["exact sourceId string"], fromScope: { kind: "global" }, toScope: { kind: "project", projectId: "known-project-id" }, reason: "why scope changes" }],
      mappings: [{ sourceRecordId: "exact sourceId string", disposition: "compiled", targetId: "optional shadow id", reason: "why this disposition was chosen" }],
      diagnostics: [{ id: "stable diagnostic id", code: "SC_UNCLASSIFIED", severity: "warning", message: "diagnostic text", sourceRecordIds: ["exact sourceId string"], consumers: ["manual_investigation"], data: {} }],
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
