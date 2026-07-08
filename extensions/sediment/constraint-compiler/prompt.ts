import { sanitizeForMemory } from "../sanitizer";
import type {
  ConstraintCompilerPrompt,
  ConstraintCompilerPromptInput,
  NormalizedConstraintRecord,
} from "./types";
import { sha256Hex, stableCanonicalize } from "./normalize";

const PROMPT_SCHEMA_VERSION = "constraint-shadow-prompt/v1";
const TRUNCATED_NATIVE_GIT_PROMPT_MARKER = "[source text truncated mid-word; incomplete tail omitted]";
const TRUNCATED_DATA_CATEGORY_PROMPT_MARKER = "[source-truncated incomplete final category omitted]";

function sanitizePromptOnlyString(value: string): string {
  return value
    .replace(/\. Native git operatio(?![A-Za-z])/g, `. ${TRUNCATED_NATIVE_GIT_PROMPT_MARKER}`)
    .replace(/Native git operatio(?![A-Za-z])/g, TRUNCATED_NATIVE_GIT_PROMPT_MARKER)
    .replace(/data migrati(?![A-Za-z])/g, TRUNCATED_DATA_CATEGORY_PROMPT_MARKER);
}

function sanitizePromptOnlyValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizePromptOnlyString(value);
  if (Array.isArray(value)) return value.map(sanitizePromptOnlyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitizePromptOnlyValue(nested)]));
}

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
    title: sanitizePromptOnlyString(record.title ?? ""),
    categoryHint: record.categoryHint,
    sourceHash: record.sourceHash,
    normalized: sanitizePromptOnlyValue(record.normalized),
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
    "Validator-enforced structural failures: a legacy source with status archived, superseded, or deprecated must never appear in constraints[] or as a merged compiled source; place it only in exclusions[] or diagnostics.",
    "Every item that references records must use sourceRecordIds as an array of exact sourceId strings from the input payload. Never use sourceId, sources, refs, sourceIds, or a single string.",
    "For every compiled constraint, injectMode must exactly match every referenced source record (legacy rule or constraint event). Never combine always and listed records in one compiled constraint.",
    "When an active always source is a near-duplicate of a listed predecessor, do not merge them into one always/listed mixed-source constraint. Compile the active always source, and exclude the listed archived/superseded predecessor as superseded_observed or legacy_archived_observed.",
    "Active source compiled plus predecessor sources excluded is a consistent result; do not map excluded predecessors as compiled or merged_source.",
    "For every compiled constraint, scope must exactly match every referenced legacy rule record unless a matching rescopeProposals item is present for that source.",
    "Source scope is authoritative. Topic text is not scope evidence: a global rule that mentions a project name such as sub2api or merdata stays global unless a valid explicit rescopeProposals item is present.",
    "Never infer project scope from a title, body, repository name, product name, or the word project in the rule text.",
    "Every legacy rule source must receive exactly one mapping disposition: compiled, merged_source, excluded, unresolved, or diagnostic.",
    "Mapping disposition must match the source's primary bucket: compiled constraint sources use compiled or merged_source, exclusion sources use excluded, and unresolved sources use unresolved. Never map an unresolved-only source as compiled.",
    "Settings/config/tool-contract exclusions require an input categoryHint of settings_not_memory or tool_contract_not_memory for that exact source, or an existingDiagnostics entry for that source with SC_NOT_MEMORY_SETTINGS or SC_NOT_MEMORY_TOOL_CONTRACT. Do not invent not-memory exclusions from topical words alone.",
    "When a source has categoryHint=settings_not_memory or categoryHint=tool_contract_not_memory, or an existingDiagnostics entry for that source with SC_NOT_MEMORY_SETTINGS or SC_NOT_MEMORY_TOOL_CONTRACT, it must be placed only in exclusions[] and must not appear in constraints[], merges[], or unresolved[] unless the source is malformed or has unknown status. Do not merge settings_not_memory or tool_contract_not_memory sources with any active behavioral rule.",
    "For a constraint_event with categoryHint=behavioral_constraint, compile the behavioral directive or place it in unresolved[]. Do not exclude it as settings_not_memory or tool_contract_not_memory merely because it mentions config, code, bash, toolContract, ToolContract, settings schema, removal, or checkpoint.",
    "If a constraint_event explicitly describes a fact, identity, provenance, deployment/infrastructure fact, or diagnostic background and has no behavioral imperative or trigger obligation, exclude it as knowledge_candidate even if categoryHint says behavioral_constraint; do not put it in unresolved[] solely because it is not behavior.",
    "Checkpoint/reminder constraint_event records with triggers such as two-week checkpoint, record a checkpoint, or remind/review whether to remove X are compileable behavioral directives. Compile the reminder/review obligation without inventing the future outcome; do not place them in unresolved[] solely because the future decision is conditional.",
    "Do not exclude a behavioral rule merely because it mentions config, code, bash, or string literals. Output/text encoding rules such as no \\u escapes or literal UTF-8 output are behavioral constraints, not settings_not_memory.",
    "For an active legacy_rule with categoryHint=behavioral_constraint, low numeric confidence, assistant-observed provenance, or overlap with a stronger source that has a different scope, injectMode, or sourceKind is not by itself a basis for unresolved/model_uncertain. If the body contains a clear imperative, compile that source as a separate constraint using its original scope and injectMode; add a diagnostic for the overlap when useful.",
    "Place an active legacy behavioral_constraint rule in unresolved[] only when the rule text cannot be parsed into a behavioral directive, the actual source scope is ambiguous, the source status is unknown, or there is a true semantic conflict.",
    "Project-specific evidence must stay project-scoped unless rescopeProposals records an explicit scope change.",
    "Conflicts, unknown status, and insufficient provenance must stay unresolved; do not archive or delete anything.",
    "Every source record in the input must receive exactly one primary disposition: compiled constraint, exclusion, or unresolved item. Never return an empty decision when sources are present.",
    "Input diagnostics such as body-hash mismatch are audit signals, not permission to omit a source. If a source is still active constraint evidence, compile it or put it in unresolved[].",
    "Allowed exclusion reasons are settings_not_memory, tool_contract_not_memory, knowledge_candidate, obsolete_archived, superseded_observed, legacy_archived_observed, malformed_unusable.",
    "Allowed unresolved reasons are conflict, scope_ambiguous, insufficient_provenance, parse_error, model_uncertain, unknown_status, trigger_projection_loss.",
    "Exclusions and unresolved are mutually exclusive buckets: conflict, scope_ambiguous, insufficient_provenance, parse_error, model_uncertain, and unknown_status may appear only in unresolved[], never in exclusions[]. If a source cannot be confidently scoped or compiled, place it in unresolved[] with scope_ambiguous, not exclusions[].",
    "Never use archived, superseded, deprecated, obsolete, or deleted as unresolved reasons or bare exclusion reasons.",
    "Archived, superseded, and deprecated legacy records must be exclusions or diagnostics, not active compiled constraints.",
    "Near duplicates may be merged only when all sourceRecordIds remain traceable in one compiled constraint.",
    "For constraint_event records, compile the source's full semantic directive. candidateTriggerPhrases is an advisory source signal and may be noisy; do not require literal copying into triggerPhrases.",
    "For every compiled constraint that references constraint_event records, triggerPhrases must concisely express the event's real trigger condition. Equivalent rewrites and synthesized phrases are allowed when they preserve the event semantics.",
    "Do not merge constraint_event records whose trigger conditions or required behavior cannot be faithfully expressed by one compiled constraint. Keep them separate, or place the unsupported event in unresolved[] with trigger_projection_loss.",
    "If records overlap but cannot be combined because injectMode, scope, source kind, or semantic trigger condition differs, keep them as separate compiled constraints and add a diagnostic; do not put that review pair in merges[].",
    "Preserve mandatory and exclusive semantics from each source. Terms such as only, must, never, forbid, prohibited, 禁止, 必须, 仅, 只, 只能, and 不得, and phrases such as only business logic changes, are semantic thresholds rather than stylistic emphasis.",
    "Preserve explicit action verbs in body text as obligations, including examples such as analyze upstream update content / 分析上游更新内容 and judge whether sync/release is needed / 是否有必要同步和发版. Title gates and body actions are complementary evidence; combine them in compiledBody or mustDoSummary instead of letting one replace the other.",
    "Preserve explicit severity, priority, and ranking semantics as behavioral ordering thresholds, not stylistic emphasis. Terms such as highest-severity, higher severity than, first, priority, critical, blocking, highest, 最严重, 优先级, 最高, and 首先 must remain represented in compiledBody, mustDoSummary, or appliesWhen when they affect behavior order or priority.",
    "Preserve boundary, scope, fallback, rollback, and exception carve-outs exactly as written. Keep specific named examples, explicit must/record/disclose actions, placement and ordering rules such as previous model immediately after new model, and carve-outs such as timeless-direction docs excluded, individual entry lifecycle ops excluded, and does not change T0 architecture protocol in compiledBody; do not compress them into generic phrases or leave them only in mustDoSummary or appliesWhen.",
    "Preserve normative architecture and methodology directives even when they appear inside a scope note, heading, or numbered list item. Phrases such as treat X as precedent, extend the same evidence-based unified architecture, and named mechanisms/examples such as deposition-time dedup, classifier-driven routing, and materialized-view frontmatter are architectural requirements; keep them in compiledBody when present instead of reducing them to generic scope or background context.",
    "In behavioral constraint sources, clear affirmative goals such as user wants, wants to, wants X to be Y, should, need, 要, 想把, 纳入, and 跟踪 must be preserved as target states or execution requirements. Do not rewrite them as may, can, allowed, or permitted unless the source explicitly frames the directive as permission or an exception.",
    "Do not weaken mandatory or exclusive thresholds into softer forms such as prioritize, prefer, normally, generally, should, unless materially affect, or other exception-bearing or probabilistic language unless that exception or weakening is explicit in the same source text.",
    "Do not add exception, permission, or override paths that are not present in the same source text. Never add phrases such as unless explicitly requested or unless the source explicitly provides another trigger when the source did not say them. If the source is absolute, says no retroactive rewrite, or uses an only gate, compiledBody must keep that absolute/no-retroactive/only-gate semantics without adding an escape hatch.",
    "If source text appears truncated in the middle of a word or sentence, do not infer or complete the missing tail into behavior, exceptions, permission paths, or carve-outs. Preserve only visible complete obligations; leave missing/incomplete tail semantics out of compiledBody.",
    "If a visible truncated fragment must be retained to preserve the source meaning, copy only the visible fragment instead of completing it into a full word/category name. Do not leave compiledBody ending in a raw mid-word fragment; if retaining an incomplete visible fragment, label it explicitly as source-truncated or visible truncated fragment.",
    "When sanitized input marks a known mid-word native-git tail, compiledBody must not contain native git or Native git unless that same source text contains a complete visible native-git carve-out.",
    "If a source says only X may trigger Y, compiledBody must preserve that exclusive gate; it must not become a prioritization rule or a materiality exception unless the source explicitly states that exception.",
    "Return exactly one strict JSON object and no prose. Every string value must be valid JSON; escape literal double quotes inside text values as backslash-quote.",
    "Do not invent object properties. Each constraint object may contain only scope, injectMode, title, compiledBody, mustDoSummary, appliesWhen, triggerPhrases, priorityHint, sourceRecordIds, sourceAuditIds, and decisionTrace.",
    "decisionTrace is always one nested object with exactly these properties together: reason, sourceRecordIds, diagnosticIds. Do not put reason or sourceRecordIds as sibling fields after decisionTrace.",
    "Put diagnostic codes only in diagnostics[] objects or decisionTrace.diagnosticIds arrays, never as extra object properties.",
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
