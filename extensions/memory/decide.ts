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
 * P1.B (this commit): adds prompt-level contradiction detection (§3.3)
 * using entry confidence/status metadata already passed into the brief.
 *
 * Echo-chamber breaker (§3.4 footer) is implemented as a minimal read-side
 * advisory: five consecutive decisive self-reports in the recent activity
 * window mark the entry as pending reconfirmation in the brief prompt.
 *
 * Provisional staging exclusion (§3.2) is enforced at retrieval time by
 * memory_decide's `status: ["active"]` search filter.
 */

import type { MemorySettings } from "./settings";
import type { MemoryEntry } from "./types";
import type { EntryActivityStats } from "../sediment/outcome-collector";
import { sanitizeForMemory } from "../sediment/sanitizer";
import { getCurrentAnchor } from "../_shared/causal-anchor";

// ── ADR 0026 §5.1 decision_brief_id schema (R2 NEW-P1-B fix) ───────────────────
//
// ADR 0026 §5.1 promises that decision_brief_id has the structured form:
//   `${session_id}|${turn_id}[.${subturn}]|${monotonic_seq}`
// so outcome-ledger / dispatch audit / cross-layer jq joins can pull all
// signals related to one brief without an extra lookup table.
//
// Prior to R2 fix, this was generated as `decision-brief-${timestamp}-
// ${random}` — opaque, no anchor, no join-by-id-shape capability. R2
// reviewers (Opus + GPT-5.5) both flagged this as an ADR-vs-code drift
// introduced by the same batch that defined the schema.
//
// # Seq counter semantics
//
// Multiple `memory_decide` calls in the SAME turn (same session_id, same
// turn_id, and same subturn-or-none) get monotonically increasing seq
// 1..N. Different turns (or different sub-agent subturns) start at 1
// again — the (session_id, turn_id[.subturn]) prefix already disambiguates,
// so re-using small seqs is fine and produces shorter ids.
//
// # Fallback when anchor is unavailable
//
// If `getCurrentAnchor()` returns undefined (e.g., memory_decide is called
// from a smoke test that hasn't bound the lifecycle), the legacy opaque
// format is used and `_meta.anchor_missing = true` is set so downstream
// readers can detect the join-key absence.

const _briefSeqCounters = new Map<string, number>();

function buildDecisionBriefId(): { id: string; anchorMissing: boolean } {
  const anchor = getCurrentAnchor();
  if (!anchor) {
    return {
      id: `decision-brief-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      anchorMissing: true,
    };
  }
  const subturnSuffix = anchor.subturn !== undefined ? `.${anchor.subturn}` : "";
  const key = `${anchor.session_id}|${anchor.turn_id}${subturnSuffix}`;
  const next = (_briefSeqCounters.get(key) ?? 0) + 1;
  _briefSeqCounters.set(key, next);
  return { id: `${key}|${next}`, anchorMissing: false };
}

export function pruneDecisionBriefSeqCountersForSession(sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const key of _briefSeqCounters.keys()) {
    if (!key.startsWith(prefix)) _briefSeqCounters.delete(key);
  }
}

/** Test-only: reset the per-turn seq counter map. Production must not call. */
export function _resetDecisionBriefSeqForTests(): void {
  _briefSeqCounters.clear();
}

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
    if (a.decisive_streak > 0) parts.push(`decisive_streak=${a.decisive_streak}`);
    if (a.possible_echo_chamber) parts.push("possible_echo_chamber=true");
    if (a.total_retrievals > 0) parts.push(`total_retrievals=${a.total_retrievals}`);
    const summary = parts.length > 0 ? parts.join(", ") : "no signals";
    const lastSeen = a.last_seen ? `, last_seen=${a.last_seen}` : "";
    return `- ${a.slug}: ${summary}${lastSeen}`;
  });
  return lines.join("\n");
}

/**
 * Build the retrieval query used by memory_decide before synthesis.
 *
 * Important: the decision context alone often omits the words that matter
 * for recall (e.g. context says "deployment target" while options contain
 * "Vercel" / "Fly.io", or constraints mention "cron" / "monorepo").
 * Include options and constraints in the natural-language query so the LLM
 * retrieval stage can match memories across all decision inputs.
 */
export function buildDecisionSearchQuery(args: {
  context: string;
  options: string[];
  constraints: string;
}): string {
  const context = (args.context || "").trim();
  const options = (args.options || []).map((item) => item.trim()).filter(Boolean);
  const constraints = (args.constraints || "").trim();

  return [
    "Decision support retrieval request.",
    "Find memories about the user's documented preferences, prior decisions, tradeoffs, regrets, and constraints that could inform this choice.",
    "Retrieve semantically related memories even when wording differs across Chinese/English or across product/library names.",
    "",
    "Decision context:",
    context || "(not specified)",
    "",
    "Options under consideration:",
    options.length > 0 ? options.map((option) => `- ${option}`).join("\n") : "(none explicitly listed)",
    "",
    "Constraints / requirements:",
    constraints || "(none stated)",
  ].join("\n").trim();
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
 */
export function buildDecisionBriefPrompt(args: {
  context: string;
  options: string[];
  constraints: string;
  entries: Array<{
    slug: string;
    title: string;
    kind: string;
    compiledTruth: string;
    status?: string;
    confidence?: number;
    created?: string;
    updated?: string;
    timeline?: string[];
    frontmatter?: Record<string, unknown>;
    retrievalLowConfidence?: boolean;
    retrievalDegraded?: boolean;
    retrievalVerdict?: "has_relevant" | "none" | "unknown";
  }>;
  activity?: EntryActivityStats[];
  activityWindowDays?: number;
}): string {
  const optionsText = args.options.length > 0
    ? args.options.map((o) => `- ${o}`).join("\n")
    : "(none explicitly listed — infer from context)";
  const constraintsText = args.constraints || "(none stated)";
  const windowDays = args.activityWindowDays ?? 30;

  const entryBlocks = args.entries.length > 0
    ? args.entries.map((e) => {
        const retrievalQuality = e.retrievalLowConfidence || e.retrievalDegraded || e.retrievalVerdict
          ? `retrieval: verdict=${e.retrievalVerdict ?? "unknown"}${e.retrievalLowConfidence ? " | low_confidence=true" : ""}${e.retrievalDegraded ? " | degraded=true" : ""}`
          : "";
        return [
          `## ${e.slug} (${e.kind})`,
          `### ${e.title}`,
          `metadata: status=${e.status ?? "unknown"} | confidence=${e.confidence ?? "unknown"}${e.updated ? ` | updated=${e.updated}` : ""}${e.created ? ` | created=${e.created}` : ""}`,
          retrievalQuality,
          e.compiledTruth,
          e.timeline && e.timeline.length > 0 ? `\nRecent timeline:\n${e.timeline.slice(-3).join("\n")}` : "",
        ].filter((line) => line.length > 0).join("\n");
      }).join("\n\n---\n\n")
    : "(no relevant memories found)";

  const activityText = renderActivitySection(args.activity, windowDays);
  const retrievalCaveat = args.activity?.some((a) => a.total_retrievals > 1)
    ? "Note: total_retrievals counts tool invocations, not unique sessions; a long session with repeated searches can inflate it."
    : "";
  const activeEntries = args.entries.filter((e) => (e.status ?? "active") === "active");
  const highConfidenceContradictionCandidates = activeEntries
    .filter((e) => (e.confidence ?? 0) >= 7)
    .map((e) => `- ${e.slug}: kind=${e.kind}, confidence=${e.confidence ?? "unknown"}, title=${e.title}`)
    .join("\n") || "(none — no high-confidence active memories in this brief)";
  const lowerConfidenceContradictionCandidates = activeEntries
    .filter((e) => (e.confidence ?? 0) < 7)
    .map((e) => `- ${e.slug}: kind=${e.kind}, confidence=${e.confidence ?? "unknown"}, title=${e.title}`)
    .join("\n") || "(none)";

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
    retrievalCaveat,
    "",
    "How to read RECENT USAGE counts (ADR 0026 §3.4):",
    "  - decisive   = LLM said \"without this entry I would have made a different decision\"",
    "  - confirmatory = LLM said \"I would have made the same decision anyway; this entry only confirmed it\"",
    "  - retrieved_unused = LLM retrieved the entry but did not act on it",
    "  - total_retrievals = times the entry surfaced via search/get/decide tools",
    "  Use these as a SOFT signal:",
    "    - many decisive recently → assistant behavior has been shaped by this entry; this is NOT user reconfirmation",
    "    - possible_echo_chamber=true → downgrade language to pending reconfirmation; do NOT call it a clear/current user preference unless the entry text itself explicitly says so",
    "    - many confirmatory but no decisive → entry agrees with user's independent reasoning; OK to cite",
    "    - many retrieved_unused → entry surfaces in search but LLM keeps rejecting it; suspect stale/wrong",
    "    - zero activity → entry is new OR cold; do NOT downweight to zero just because counts are zero",
    "  Do NOT apply hard thresholds (e.g. \"decisive_count<3 → ignore\"). Weighting is judgment, not arithmetic.",
    "",
    "=== CONTRADICTION CHECK INPUTS (ADR 0026 §3.3) ===",
    "High-confidence active memories that may represent explicit preferences / constraints:",
    highConfidenceContradictionCandidates,
    "",
    "Lower-confidence active memories (do not ignore, but cite uncertainty if used as a contradiction signal):",
    lowerConfidenceContradictionCandidates,
    "",
    "Before recommending, compare OPTIONS + CONSTRAINTS against these memories.",
    "A contradiction is a direct conflict with an explicit user preference, maxim, anti-pattern, or prior decision (confidence >= 7, status=active).",
    "If an option conflicts, cite the memory slug and state the conflict. If the memory is merely related or weak, do not invent a contradiction.",
    "",
    "=== YOUR TASK ===",
    "Write a decision brief (≤500 tokens). Structure:",
    "",
    "1. RELEVANT PREFERENCES — what has the user explicitly stated about",
    "   this topic? Quote the specific memory entry when possible. If a",
    "   memory looks high-decisive in RECENT USAGE, say it has shaped recent",
    "   assistant decisions, but do not upgrade it to a user-confirmed live",
    "   preference unless the memory itself records an explicit preference.",
    "   If possible_echo_chamber=true, explicitly say: 'previously used often,",
    "   not recently reaffirmed by the user' and avoid strong recommendation",
    "   language. If mostly retrieved_unused, flag it as suspect.",
    "",
    "2. RELEVANT EXPERIENCES — what happened when the user made similar",
    "   choices before? Were there regrets, pivots, or confirmations?",
    "",
    "3. RECOMMENDATION — based on the user's documented history (weighted",
    "   by activity), which option (or approach) best aligns with their",
    "   long-term patterns? If evidence is too thin to recommend, say so",
    "   explicitly.",
    "",
    "4. CONTRADICTION CHECK — do any options directly conflict with a",
    "   high-confidence active memory above? If yes, cite the slug and state",
    "   the conflict plainly. If no direct conflict, say 'No direct",
    "   contradiction detected'.",
    "",
    "5. CAVEATS — what might you be missing? Are the memories stale",
    "   (last_seen is far back, or zero activity)? Could the user's",
    "   preferences have changed? Is this a different context than the",
    "   memories describe?",
    "",
    "Rules:",
    "- Do NOT fabricate preferences. If the user never stated a preference,",
    "  say 'no explicit preference recorded'.",
    "- If a memory's confidence is low or status is provisional, mention",
    "  that uncertainty in the brief.",
    "- If retrieval marks low_confidence=true, treat that memory as a weak",
    "  hint rather than a confident match. If degraded=true, mention recall",
    "  may be incomplete when it affects the recommendation.",
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
  /** Slugs of entries included in the decision brief prompt. Returned to
   *  memory_decide's tool result so outcome-collector can record retrieval
   *  counts mechanically, without asking the LLM to reconstruct which entries
   *  were consulted. */
  entrySlugs?: string[];
  /** Stable per-call id for future decision_brief_id outcome linkage. */
  decisionBriefId?: string;
  /** True when getCurrentAnchor() returned undefined and a legacy opaque
   *  id was used (ADR 0026 §5.1 schema not satisfied for this brief).
   *  Downstream readers can detect attribution-join breakage. Propagated
   *  by R3 fix (GPT-5.5 finding): previously computed but discarded. */
  anchorMissing?: boolean;
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
  searchResults: Array<{
    slug: string;
    title: string;
    kind: string;
    compiledTruth: string;
    status?: string;
    confidence?: number;
    created?: string;
    updated?: string;
    timeline?: string[];
    frontmatter?: Record<string, unknown>;
    retrievalLowConfidence?: boolean;
    retrievalDegraded?: boolean;
    retrievalVerdict?: "has_relevant" | "none" | "unknown";
  }>;
  /** ADR 0026 §3.4 outcome activity per slug, ordered to match searchResults. */
  activity?: EntryActivityStats[];
  /** Window for the activity stats label in the prompt. Default 30. */
  activityWindowDays?: number;
  settings: MemorySettings;
  modelRegistry: unknown;
  signal?: AbortSignal;
}): Promise<MemoryDecideResult> {
  const { context, options, constraints, searchResults, activity, activityWindowDays, settings, modelRegistry, signal } = args;

  const entrySlugs = searchResults.map((entry) => entry.slug);
  // ADR 0026 §5.1 schema (R2 NEW-P1-B + R3 propagation fix): build
  // deterministic anchored id. See buildDecisionBriefId() at module top
  // for shape + fallback semantics. R3 (GPT-5.5): also propagate
  // anchorMissing to every return shape so downstream can detect breakage.
  const briefIdResult = buildDecisionBriefId();
  const decisionBriefId = briefIdResult.id;
  const anchorMissing = briefIdResult.anchorMissing;

  if (!searchResults || searchResults.length === 0) {
    return {
      ok: true,
      brief: "No relevant memories found for this decision context.",
      entryCount: 0,
      entrySlugs: [],
      decisionBriefId,
      ...(anchorMissing ? { anchorMissing: true } : {}),
    };
  }

  // memory_decide synthesis model: dedicated decideModel if set, else
  // falls back to the stage-1 model (backward-compatible).
  const decideModelRef = settings.decideModel || settings.search.stage1Model;
  const modelRef = parseModelRef(decideModelRef);
  if (!modelRef) {
    return { ok: false, error: `invalid memory.decideModel/stage1Model: ${decideModelRef}`, entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
  }

  const registry = modelRegistry as {
    find(provider: string, modelId: string): unknown;
    getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
  };

  const model = registry.find(modelRef.provider, modelRef.id);
  if (!model) {
    return { ok: false, error: `memory_decide model not found: ${decideModelRef}`, entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
  }

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, error: `memory_decide auth unavailable: ${auth.error || "missing api key"}`, entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
  }

  const prompt = buildDecisionBriefPrompt({
    context,
    options,
    constraints,
    entries: searchResults,
    activity,
    activityWindowDays,
  });
  const sanitizedPrompt = sanitizeForMemory(prompt);
  if (!sanitizedPrompt.ok) {
    return { ok: false, error: sanitizedPrompt.error || "memory_decide prompt sanitize failed", entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
  }

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai/compat");

  const stream = piAi.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: sanitizedPrompt.text ?? prompt }] }] },
    { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: 60_000, maxRetries: 1 },
  );

  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    return { ok: false, error: finalMsg.errorMessage || finalMsg.stopReason || "memory_decide failed", entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
  }

  const brief = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  if (!brief) {
    return { ok: false, error: "memory_decide returned empty text", entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
  }

  return { ok: true, brief, entryCount: searchResults.length, entrySlugs, decisionBriefId, ...(anchorMissing ? { anchorMissing: true } : {}) };
}
