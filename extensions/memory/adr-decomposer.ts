import type { AdrSource, AdrIngestDraft, AdrDecomposition } from "./ingest-adr";

/**
 * ADR mechanism decomposer — the cognitive layer of the ingest lane
 * (ADR 0034 §2.1 / §4 AI-Native). The actual decomposition is an LLM task; this
 * module owns (a) the decomposition PROMPT and (b) the deterministic parser that
 * turns the LLM's JSON answer into a validated `AdrSource`. The live model call
 * is injected so the glue is testable without a runtime LLM.
 *
 * AI-Native: the prompt asks the model to SPLIT mechanism prose into multiple
 * short typed entries and to SELF-REPORT coverage (processed/skipped). There is
 * NO mechanical accuracy gate here — under/over-decomposition is surfaced as
 * advisory manifest stats downstream (planIngest), reviewed by a human in
 * dry-run, never auto-blocked (direction §4 走偏 #6).
 */

export const ADR_DECOMPOSER_PROMPT = `You are decomposing one Architecture Decision Record (ADR) mechanism body into
multiple SHORT, typed second-brain memory entries for ingest into ~/.abrain.

HARD RULES:
- One ADR is NOT one entry. Split the mechanism into several entries, each a
  single self-contained "compiled truth" (a decision / pattern / anti-pattern /
  fact / smell / maxim). Never dump a whole section as one giant entry.
- Only decompose MECHANISM / rationale content. Skip pure direction/invariant/
  requirement statements (those already live in direction.md / requirements.md);
  report them under "skipped" with a short reason.
- Each entry's "kind" MUST be one of: maxim, decision, anti-pattern, pattern,
  fact, preference, smell.
- "slug" MUST be bare kebab-case ([a-z0-9-]+), unique within this ADR.
- "compiledTruth" is the entry body (>= 20 chars), written as durable knowledge,
  not narration of the ADR. Keep each focused (prefer < 1500 chars).
- "sourceHeading" MUST be the exact ADR section heading the entry derives from.
- "directionImpact" (optional) is an array of flat strings
  "<relation> | <ref> | <escalation>[ | <proposal_ref>]" where relation ∈
  {supports, depends_on, touches, narrows, weakens, conflicts}, ref is
  direction.md#INV-* or requirements.md#REQ-*, escalation ∈ {none, required,
  proposed, accepted, rejected}. If an entry narrows/weakens/conflicts with a
  direction invariant you MUST set escalation to a non-"none" value and add a
  human-readable proposal_ref — never silently accept it.
- SELF-REPORT coverage: list every mechanism heading you turned into entries
  under "processed", and every heading you intentionally skipped (with reason)
  under "skipped". Do not silently drop sections.

Output STRICT JSON only (no prose, no markdown fence), shape:
{
  "processed": ["<heading>", ...],
  "skipped": [{"heading": "<heading>", "reason": "<why>"}, ...],
  "drafts": [
    {
      "slug": "<kebab>",
      "title": "<short title>",
      "kind": "<entry kind>",
      "status": "active",
      "confidence": 6,
      "compiledTruth": "<the entry body>",
      "sourceHeading": "<exact ADR heading>",
      "directionImpact": ["supports | direction.md#INV-AUTONOMY | none"]
    }
  ]
}`;

export function buildDecomposerPrompt(adrPath: string, adrContent: string): string {
  return `${ADR_DECOMPOSER_PROMPT}\n\n--- SOURCE ADR: ${adrPath} ---\n${adrContent}\n--- END SOURCE ---`;
}

export interface DecomposeResult {
  source?: AdrSource;
  error?: string;
}

/** Pull a JSON object out of an LLM answer that may be fenced or padded. */
function extractJson(text: string): string | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Parse a decomposer LLM answer into a validated AdrSource. Total / never throws.
 * Returns { error } on malformed input; downstream planIngest still re-validates
 * every draft (schema + direction_impact 红线) before any write.
 */
export function parseDecomposerResponse(text: string, adrPath: string, sha: string): DecomposeResult {
  const json = extractJson(text);
  if (!json) return { error: "decomposer response contained no JSON object" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { error: `decomposer JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "decomposer response is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  const rawDrafts = Array.isArray(obj.drafts) ? obj.drafts : null;
  if (!rawDrafts) return { error: "decomposer response missing 'drafts' array" };

  const drafts: AdrIngestDraft[] = [];
  for (const rd of rawDrafts) {
    if (!rd || typeof rd !== "object") continue;
    const d = rd as Record<string, unknown>;
    const slug = asString(d.slug);
    const title = asString(d.title);
    const kind = asString(d.kind);
    const compiledTruth = asString(d.compiledTruth);
    const sourceHeading = asString(d.sourceHeading);
    // Keep partial drafts too — planIngest surfaces their issues rather than
    // silently dropping (so a human sees what the model produced).
    const draft: AdrIngestDraft = {
      slug: slug ?? "",
      title: title ?? "",
      kind: kind ?? "",
      compiledTruth: compiledTruth ?? "",
      sourceHeading: sourceHeading ?? "",
    };
    const status = asString(d.status);
    if (status) draft.status = status;
    if (typeof d.confidence === "number") draft.confidence = d.confidence;
    if (Array.isArray(d.directionImpact)) {
      draft.directionImpact = d.directionImpact.filter((x): x is string => typeof x === "string");
    }
    drafts.push(draft);
  }
  if (drafts.length === 0) return { error: "decomposer produced 0 drafts" };

  const processed = Array.isArray(obj.processed)
    ? obj.processed.filter((x): x is string => typeof x === "string")
    : [];
  const skipped = Array.isArray(obj.skipped)
    ? obj.skipped
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ heading: asString(x.heading) ?? "", reason: asString(x.reason) ?? "" }))
        .filter((x) => x.heading)
    : [];

  const decomposition: AdrDecomposition = { drafts, processed, skipped };
  return { source: { adrPath, sha, decomposition } };
}

/**
 * Decompose an ADR via an injected LLM call. `llmCall(prompt)` returns the raw
 * model answer; production wires it to ctx.modelRegistry (mirrors llm-search.ts),
 * smoke injects a stub. The lane stays pure/testable.
 */
export async function decomposeAdr(
  adrPath: string,
  adrContent: string,
  sha: string,
  llmCall: (prompt: string) => Promise<string>,
): Promise<DecomposeResult> {
  let answer: string;
  try {
    answer = await llmCall(buildDecomposerPrompt(adrPath, adrContent));
  } catch (e) {
    return { error: `decomposer LLM call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return parseDecomposerResponse(answer, adrPath, sha);
}
