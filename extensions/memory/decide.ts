/**
 * memory_decide — second-brain decision participation (ADR 0026 P0a + P1.A).
 *
 * P0a (self-contained MVP): wrap memory_search results with a synthesis
 * prompt so the LLM gets "here is what these memories mean for your
 * decision" instead of raw cards.
 *
 * P1.A (this commit): outcome activity summary from outcome-ledger.jsonl
 * is fed into the brief so the brain can weight recommendations by
 * "how was this entry treated last 30 days?" — ADR 0026 §3.4. Counts are
 * surfaced raw; the LLM (not a threshold) judges weight.
 *
 * Still deferred to P1.B+:
 *   - Contradiction detection (§3.3)
 *   - Provisional staging exclusion (§3.2 ⚠️ warning)
 *   - Echo-chamber circuit breaker (§3.4 footer)
 */

import type { MemorySettings } from "./settings";
import type { MemoryEntry } from "./types";
import type { EntryActivityStats } from "../sediment/outcome-collector";

// ── Prompt ────────────────────────────────────────────────────────────────

/**
 * Render the optional usage-history section.
 *
 * If activity[] is empty or every entry shows zero outcomes, we emit a
 * single line acknowledging that — better than silently dropping the
 * section, because the LLM otherwise can't tell "no data" from "section
 * forgotten".
 */
function renderActivitySection(activity: EntryActivityStats[] | undefined, windowDays: number): string {
  if (!activity || activity.length === 0) {
    return "(no entries to summarize)";
  }
  const anyNonZero = activity.some(
    (a) => a.decisive_count + a.confirmatory_count + a.retrieved_unused_count + a.total_retrievals > 0,
  );
  if (!anyNonZero) {
    return `(no outcome history recorded for any of these entries in the last ${windowDays} days — either new or the user's LLM has not yet emitted memory-footnote self-reports for them)`;
  }
  const lines = activity.map((a) => {
    const parts: string[] = [];
    if (a.decisive_count > 0) parts.push(`decisive=${a.decisive_count}`);
    if (a.confirmatory_count > 0) parts.push(`confirmatory=${a.confirmatory_count}`);
    if (a.retrieved_unused_count > 0) parts.push(`retrieved_unused=${a.retrieved_unused_count}`);
    if (a.total_retrievals > 0) parts.push(`total_retrievals=${a.total_retrievals}`);
    const summary = parts.length > 0 ? parts.join(", ") : "no signals";
    const lastSeen = a.last_seen ? `, last_seen=${a.last_seen}` : "";
    return `- ${a.slug}: ${summary}${lastSeen}`;
  });
  return lines.join("\n");
}

/**
 * ADR 0026 P0a + P1.A decision-brief prompt.
 *
 * P1.A change vs P0a: appends a RECENT USAGE OF THESE ENTRIES section
 * with raw counts from outcome-ledger. The prompt instructs the LLM
 * to read counts as a SOFT WEIGHTING SIGNAL, not a hard rule (§3.4).
 *
 * Still deferred:
 *   - Contradiction detection (§3.3)
 *   - Provisional staging guard (§3.2): only `status: active` pre-filter
 *     applies at the search layer; we don't yet inspect
 *     attribution_pending=true at this layer.
 */
export function buildDecisionBriefPrompt(args: {
  context: string;
  options: string[];
  constraints: string;
  entries: Array<{ slug: string; title: string; kind: string; compiledTruth: string }>;
  activity?: EntryActivityStats[];
  activityWindowDays?: number;
}): string {
  const optionsText = args.options.length > 0
    ? args.options.map((o) => `- ${o}`).join("\n")
    : "(none explicitly listed — infer from context)";
  const constraintsText = args.constraints || "(none stated)";
  const windowDays = args.activityWindowDays ?? 30;

  const entryBlocks = args.entries.length > 0
    ? args.entries.map((e) =>
        [
          `## ${e.slug} (${e.kind})`,
          `### ${e.title}`,
          e.compiledTruth,
        ].join("\n"),
      ).join("\n\n---\n\n")
    : "(no relevant memories found)";

  const activityText = renderActivitySection(args.activity, windowDays);

  return [
    "You are the second brain's decision advisor. You are speaking to the",
    "user's LLM — NOT to the user. Your output is internal reference only.",
    "",
    "The LLM is about to make a decision. Below is everything you know",
    "about the user's relevant history, preferences, and past choices.",
    "Your job: synthesize these memories into a concise decision brief",
    "that helps the LLM make a better-informed choice.",
    "",
    "=== DECISION CONTEXT ===",
    args.context,
    "",
    "=== OPTIONS ON THE TABLE ===",
    optionsText,
    "",
    "=== CONSTRAINTS ===",
    constraintsText,
    "",
    "=== RELEVANT MEMORIES ===",
    entryBlocks,
    "",
    `=== RECENT USAGE OF THESE ENTRIES (last ${windowDays} days, from outcome self-reports) ===`,
    activityText,
    "",
    "How to read RECENT USAGE counts (ADR 0026 §3.4):",
    "  - decisive   = LLM said \"without this entry I would have made a different decision\"",
    "  - confirmatory = LLM said \"I would have made the same decision anyway; this entry only confirmed it\"",
    "  - retrieved_unused = LLM retrieved the entry but did not act on it",
    "  - total_retrievals = times the entry surfaced via search/get/decide tools",
    "  Use these as a SOFT signal:",
    "    - many decisive recently → entry actively shapes behavior; treat as live preference",
    "    - many confirmatory but no decisive → entry agrees with user's independent reasoning; OK to cite",
    "    - many retrieved_unused → entry surfaces in search but LLM keeps rejecting it; suspect stale/wrong",
    "    - zero activity → entry is new OR cold; do NOT downweight to zero just because counts are zero",
    "  Do NOT apply hard thresholds (e.g. \"decisive_count<3 → ignore\"). Weighting is judgment, not arithmetic.",
    "",
    "=== YOUR TASK ===",
    "Write a decision brief (≤500 tokens). Structure:",
    "",
    "1. RELEVANT PREFERENCES — what has the user explicitly stated about",
    "   this topic? Quote the specific memory entry when possible. If a",
    "   memory looks high-decisive in RECENT USAGE, mark it as a strong",
    "   live preference; if mostly retrieved_unused, flag it as suspect.",
    "",
    "2. RELEVANT EXPERIENCES — what happened when the user made similar",
    "   choices before? Were there regrets, pivots, or confirmations?",
    "",
    "3. RECOMMENDATION — based on the user's documented history (weighted",
    "   by activity), which option (or approach) best aligns with their",
    "   long-term patterns? If evidence is too thin to recommend, say so",
    "   explicitly.",
    "",
    "4. CAVEATS — what might you be missing? Are the memories stale",
    "   (last_seen is far back, or zero activity)? Could the user's",
    "   preferences have changed? Is this a different context than the",
    "   memories describe?",
    "",
    "Rules:",
    "- Do NOT fabricate preferences. If the user never stated a preference,",
    "  say 'no explicit preference recorded'.",
    "- If a memory's confidence is low or status is provisional, mention",
    "  that uncertainty in the brief.",
    "- Be concise. 500 tokens max. The LLM is mid-task and needs a quick",
    "  read, not an essay.",
    "- If no relevant memories were found, your brief should be a single",
    "  sentence: 'No relevant memories found for this decision context.'",
    "  — then STOP. Do not invent advice from thin air.",
    "",
    "Output the decision brief as plain text (no JSON wrapper, no markdown",
    "code fence).",
  ].join("\n");
}

// ── Model helpers ─────────────────────────────────────────────────────────

interface ModelRef {
  provider: string;
  id: string;
}

function parseModelRef(ref: string): ModelRef | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

// ── Main ──────────────────────────────────────────────────────────────────

export interface MemoryDecideResult {
  ok: boolean;
  brief?: string;
  error?: string;
  entryCount: number;
}

/**
 * P0a: wrap memory_search results with a synthesis prompt so the LLM
 * gets a decision brief instead of raw memory cards.
 *
 * Uses the same model as memory_search stage 1 (fast + cheap) since
 * synthesis is a lightweight reading-comprehension task.
 */
export async function runMemoryDecide(args: {
  context: string;
  options: string[];
  constraints: string;
  searchResults: Array<{ slug: string; title: string; kind: string; compiledTruth: string }>;
  /** ADR 0026 §3.4 outcome activity per slug, ordered to match searchResults. */
  activity?: EntryActivityStats[];
  /** Window for the activity stats label in the prompt. Default 30. */
  activityWindowDays?: number;
  settings: MemorySettings;
  modelRegistry: unknown;
  signal?: AbortSignal;
}): Promise<MemoryDecideResult> {
  const { context, options, constraints, searchResults, activity, activityWindowDays, settings, modelRegistry, signal } = args;

  if (!searchResults || searchResults.length === 0) {
    return {
      ok: true,
      brief: "No relevant memories found for this decision context.",
      entryCount: 0,
    };
  }

  // P0a uses the stage-1 model for synthesis (same as memory_search).
  // P1 can switch to a dedicated decideModel.
  const modelRef = parseModelRef(settings.search.stage1Model);
  if (!modelRef) {
    return { ok: false, error: `invalid memory.search.stage1Model: ${settings.search.stage1Model}`, entryCount: searchResults.length };
  }

  const registry = modelRegistry as {
    find(provider: string, modelId: string): unknown;
    getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
  };

  const model = registry.find(modelRef.provider, modelRef.id);
  if (!model) {
    return { ok: false, error: `memory_decide model not found: ${settings.search.stage1Model}`, entryCount: searchResults.length };
  }

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, error: `memory_decide auth unavailable: ${auth.error || "missing api key"}`, entryCount: searchResults.length };
  }

  const prompt = buildDecisionBriefPrompt({
    context,
    options,
    constraints,
    entries: searchResults,
    activity,
    activityWindowDays,
  });

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai");

  const stream = piAi.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
    { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: 60_000, maxRetries: 1 },
  );

  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    return { ok: false, error: finalMsg.errorMessage || finalMsg.stopReason || "memory_decide failed", entryCount: searchResults.length };
  }

  const brief = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  if (!brief) {
    return { ok: false, error: "memory_decide returned empty text", entryCount: searchResults.length };
  }

  return { ok: true, brief, entryCount: searchResults.length };
}
