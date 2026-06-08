export const ENTRY_KINDS = [
  "maxim", "decision", "anti-pattern", "pattern", "fact", "preference", "smell",
] as const;

export const ENTRY_STATUSES = [
  "provisional", "active", "contested", "deprecated", "superseded", "archived",
] as const;

export type EntryKind = typeof ENTRY_KINDS[number];
export type EntryStatus = typeof ENTRY_STATUSES[number];

// AX-PROVENANCE (ADR 0028 v1.1 §12): the stored ground-truth-strength axis.
// Set DETERMINISTICALLY from the originating transcript turn.role (no LLM enum):
//   user-expressed       = verbatim quote came from a USER-role message (attested)
//   assistant-observed   = the assistant/extractor inferred it
//   content-in-transcript = it appeared in tool-result/file content (e.g. a README)
// Tier-1 (deterministic rule commit) is the computed predicate
//   provenance==='user-expressed' ∧ is_directive ∧ durable. Provenance is the
// axis; Tier-1/Tier-2 is a write-path function of it, not a parallel taxonomy.
export const PROVENANCE_CLASSES = [
  "user-expressed", "assistant-observed", "content-in-transcript",
] as const;
export type ProvenanceClass = typeof PROVENANCE_CLASSES[number];

export interface DraftValidationIssue {
  field: string;
  message: string;
}

export interface DraftLike {
  title?: unknown;
  kind?: unknown;
  compiledTruth?: unknown;
  status?: unknown;
  confidence?: unknown;
}

/**
 * Schema-only draft validation. ADR 0016 removed mechanical semantic gates
 * (no kind bans, confidence caps, archive/status bans, or near-duplicate
 * policy). Semantic correctness belongs to the LLM curator; this function only
 * protects storage shape.
 */
export function validateProjectEntryDraft(draft: DraftLike): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];

  if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
    issues.push({ field: "title", message: "title is required" });
  }

  if (typeof draft.kind !== "string" || !(ENTRY_KINDS as readonly string[]).includes(draft.kind)) {
    issues.push({ field: "kind", message: `kind must be one of: ${ENTRY_KINDS.join(", ")}` });
  }

  if (typeof draft.compiledTruth !== "string" || draft.compiledTruth.trim().length < 20) {
    issues.push({ field: "compiledTruth", message: "compiledTruth must be at least 20 characters" });
  }

  if (draft.status !== undefined) {
    if (typeof draft.status !== "string" || !(ENTRY_STATUSES as readonly string[]).includes(draft.status)) {
      issues.push({ field: "status", message: `status must be one of: ${ENTRY_STATUSES.join(", ")}` });
    }
  }

  if (draft.confidence !== undefined) {
    const n = typeof draft.confidence === "number" ? draft.confidence : Number(draft.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      issues.push({ field: "confidence", message: "confidence must be a number between 0 and 10" });
    }
  }

  return issues;
}
