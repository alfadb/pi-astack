import { sanitizeForMemory } from "../sanitizer";
import { buildMergedSourceVerifierInputRows, mergedSourceVerifierDecisionHash, mergedSourceVerifierInputHash } from "./merged-source-verifier";
import { sha256Hex, stableCanonicalize } from "./normalize";
import type {
  ConstraintEventSourceRecord,
  ConstraintMergedSourceVerifierPrompt,
  ValidatedConstraintCompilerDecision,
} from "./types";

const PROMPT_SCHEMA_VERSION = "constraint-merged-source-verifier-prompt/v1";

export function buildMergedSourceVerifierPrompt(input: {
  events: ConstraintEventSourceRecord[];
  decision: ValidatedConstraintCompilerDecision;
  maxPromptChars?: number;
}): ConstraintMergedSourceVerifierPrompt {
  const rows = buildMergedSourceVerifierInputRows(input.events, input.decision).map((row) => ({
    eventId: row.eventId,
    sourceRecordId: row.sourceRecordId,
    targetConstraintId: row.targetConstraintId,
    mergeReason: row.mergeReason,
    eventText: row.eventText,
    target: {
      title: row.targetTitle,
      compiledBody: row.targetCompiledBody,
      triggerPhrases: row.targetTriggerPhrases,
    },
  }));
  const verifierInputHash = mergedSourceVerifierInputHash(input.events, input.decision);
  const payload = {
    inputRootHash: input.decision.inputRootHash,
    decisionValidationHash: input.decision.validationHash,
    decisionHash: mergedSourceVerifierDecisionHash(input.decision),
    verifierInputHash,
    rows,
  };
  const text = [
    "You are ADR 0039 Constraint Merged Source Verifier.",
    "This is a shadow-only verification task. Do not propose or describe writes to files, canonical rules, settings, runtime hooks, or session injection.",
    "Return JSON only. Do not wrap the response in markdown fences. Do not output hashes.",
    "For each input row, decide whether the target compiled constraint faithfully expresses the event text as a merged source.",
    "Use verdict=expressed only when the event directive is semantically present in the target constraint. Use not_expressed when it is missing or contradicted. Use uncertain when evidence is insufficient.",
    "Return exactly one row per input row. Do not invent eventId, sourceRecordId, or targetConstraintId.",
    "Required JSON shape:",
    stableCanonicalize({
      rows: [{
        eventId: "exact input eventId",
        sourceRecordId: "exact input sourceRecordId",
        targetConstraintId: "exact input targetConstraintId",
        verdict: "expressed|not_expressed|uncertain",
        confidence: "high|medium|low",
        reasoning: "brief reason based only on input text",
      }],
    }),
    "Input payload:",
    stableCanonicalize(payload),
  ].join("\n\n");
  const sanitized = sanitizeForMemory(text);
  const sanitizedText = sanitized.text ?? text;
  if (input.maxPromptChars && sanitizedText.length > input.maxPromptChars) {
    throw new Error(`constraint merged-source verifier prompt exceeds maxPromptChars ${input.maxPromptChars}`);
  }
  return {
    schemaVersion: PROMPT_SCHEMA_VERSION,
    inputRootHash: input.decision.inputRootHash,
    decisionValidationHash: input.decision.validationHash,
    decisionHash: mergedSourceVerifierDecisionHash(input.decision),
    verifierInputHash,
    promptHash: sha256Hex(sanitizedText),
    text: sanitizedText,
    rowCount: rows.length,
  };
}
