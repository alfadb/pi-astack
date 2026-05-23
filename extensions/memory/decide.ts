/**
 * memory_decide — second-brain decision participation (ADR 0026 P0a).
 *
 * P0a is the self-contained MVP: wraps memory_search results with a
 * lightweight synthesis prompt so the LLM gets not just "here are the
 * relevant memories" but "here is what they mean for your current
 * decision".  No dependency on ADR 0025 outcome data / active correction /
 * aggregator.  Those enrich the brief in P1.
 */

import type { MemorySettings } from "./settings";
import type { MemoryEntry } from "./types";

// ── Prompt ────────────────────────────────────────────────────────────────

/**
 * ADR 0026 P0a decision-brief prompt.
 *
 * P1 upgrades this to include:
 *   - Outcome history (§3.4): how often this entry was DECISIVE vs RETRIEVED-UNUSED
 *   - Contradiction detection (§3.3): flag entries that conflict with the current choice
 *   - Provisional staging guard: exclude attribution_pending entries
 */
export function buildDecisionBriefPrompt(args: {
  context: string;
  options: string[];
  constraints: string;
  entries: Array<{ slug: string; title: string; kind: string; compiledTruth: string }>;
}): string {
  const optionsText = args.options.length > 0
    ? args.options.map((o) => `- ${o}`).join("\n")
    : "(none explicitly listed — infer from context)";
  const constraintsText = args.constraints || "(none stated)";

  const entryBlocks = args.entries.length > 0
    ? args.entries.map((e) =>
        [
          `## ${e.slug} (${e.kind})`,
          `### ${e.title}`,
          e.compiledTruth,
        ].join("\n"),
      ).join("\n\n---\n\n")
    : "(no relevant memories found)";

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
    "=== YOUR TASK ===",
    "Write a decision brief (≤500 tokens). Structure:",
    "",
    "1. RELEVANT PREFERENCES — what has the user explicitly stated about",
    "   this topic? Quote the specific memory entry when possible.",
    "",
    "2. RELEVANT EXPERIENCES — what happened when the user made similar",
    "   choices before? Were there regrets, pivots, or confirmations?",
    "",
    "3. RECOMMENDATION — based on the user's documented history, which",
    "   option (or approach) best aligns with their long-term patterns?",
    "   If evidence is too thin to recommend, say so explicitly.",
    "",
    "4. CAVEATS — what might you be missing? Are the memories stale?",
    "   Could the user's preferences have changed? Is this a different",
    "   context than the memories describe?",
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
  settings: MemorySettings;
  modelRegistry: unknown;
  signal?: AbortSignal;
}): Promise<MemoryDecideResult> {
  const { context, options, constraints, searchResults, settings, modelRegistry, signal } = args;

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

  const prompt = buildDecisionBriefPrompt({ context, options, constraints, entries: searchResults });

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
