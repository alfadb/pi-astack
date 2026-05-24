import * as path from "node:path";
import type { MemorySettings, ThinkingLevel } from "./settings";
import type { MemoryEntry, SearchFilters, SearchParams } from "./types";
import { relationValues } from "./parser";
import { entryMatchesFilters } from "./search";
import { clamp, compareTimestamps, normalizeBareSlug, stableUnique } from "./utils";
import { ensureProjectGitignoredOnce, memorySearchMetricsPath } from "../_shared/runtime";
import { sanitizeForMemory } from "../sediment/sanitizer";

function logSearchMetrics(entry: Record<string, unknown>, projectRoot?: string): void {
  if (!projectRoot) return;
  try {
    // Round 9 P2 (sonnet R9-6 fix): the query string is stored verbatim
    // (truncated to 80 chars) in search-metrics.jsonl. A user pasting
    // a token shape into `/memory search` (e.g. "/memory search
    // ghp_abc123Token...") would land the token first 80 chars on
    // disk. Sanitize first: pattern-match → replace with placeholder.
    if (typeof entry.query === "string" && entry.query.length > 0) {
      const s = sanitizeForMemory(entry.query);
      entry = { ...entry, query: s.ok ? (s.text ?? entry.query) : `[redacted: ${s.error}]` };
    }
    const file = memorySearchMetricsPath(projectRoot);
    const dir = path.dirname(file);
    const fsSync = require("node:fs") as typeof import("node:fs");
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fsSync.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
    // Round 9 P0 (sonnet R9-5 fix): ensure .pi-astack/ is in project
    // .gitignore. logSearchMetrics is a path independent of appendAudit,
    // so the gate must also fire here. Best-effort.
    void ensureProjectGitignoredOnce(projectRoot).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

interface CandidatePick {
  slug: string;
  reason?: string;
}

interface FinalPick {
  slug: string;
  score?: number;
  why?: string;
}

interface ModelCallResult {
  rawText: string;
  stopReason?: string;
  usage?: {
    input: number;
    output: number;
    cacheHit?: number;
    cacheWrite?: number;
  };
}

interface ModelLike {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

const STAGE1_TIMEOUT_MS = 120_000;
const STAGE2_TIMEOUT_MS = 180_000;
const STAGE_MAX_RETRIES = 1;
const MAX_STAGE2_ENTRY_CHARS = 12_000;

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function assertModelRegistry(modelRegistry: unknown): asserts modelRegistry is ModelRegistryLike {
  const reg = modelRegistry as ModelRegistryLike | undefined;
  if (!reg || typeof reg.find !== "function" || typeof reg.getApiKeyAndHeaders !== "function") {
    throw new Error("memory_search requires ctx.modelRegistry for ADR 0015 LLM retrieval; no grep degradation path is available");
  }
}

function supportsThinkingLevel(model: unknown, level: ThinkingLevel): boolean {
  if (level === "off") return true;
  const m = model as ModelLike | undefined;
  if (!m?.reasoning) return false;
  const mapped = m.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  if (level === "xhigh" && mapped === undefined && m.thinkingLevelMap) return false;
  return true;
}

async function callSearchModel(
  modelRef: string,
  prompt: string,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
  timeoutMs = STAGE1_TIMEOUT_MS,
  thinking: ThinkingLevel = "off",
): Promise<ModelCallResult> {
  const parsed = parseModelRef(modelRef);
  if (!parsed) throw new Error(`invalid memory.search model ref: ${modelRef || "<empty>"}; expected provider/model`);

  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) throw new Error(`memory.search model not found in registry: ${modelRef}`);
  if (!supportsThinkingLevel(model, thinking)) {
    throw new Error(`memory.search ${modelRef} does not support requested thinking level '${thinking}'`);
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`memory.search model auth unavailable for ${modelRef}: ${auth.error || "missing api key"}`);
  }

  // pi-ai's SimpleStreamOptions.reasoning is typed as ThinkingLevel
  // ("minimal" | "low" | "medium" | "high" | "xhigh") — it does NOT
  // include "off". memory.settings.ThinkingLevel does include "off".
  //
  // 2026-05-24 fix: passing reasoning="off" through SimpleStreamOptions
  // is silently misinterpreted by some providers:
  //   - Google: clampThinkingLevel returns "off", then
  //     `effort = (clamped === "off" ? "high" : clamped)` — turns off
  //     into HIGH thinking. Spends real tokens on hidden reasoning when
  //     the caller explicitly asked for no thinking.
  //   - Anthropic: `!options?.reasoning` is false for "off" (truthy
  //     string), so it bypasses the `thinkingEnabled: false` gate and
  //     enters the adaptive-thinking path.
  //   - OpenAI (all three protocols): correctly maps "off" → undefined,
  //     no harm.
  //
  // The semantic intent of memory's "off" is "don't enable thinking".
  // pi-ai expresses that by NOT setting reasoning at all (the guard
  // `if (!options?.reasoning)` then takes the thinking-disabled path on
  // every provider). So translate "off" to omission here.
  type PiAiThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number; reasoning?: PiAiThinkingLevel },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai");

  const reasoningField: { reasoning?: PiAiThinkingLevel } =
    thinking === "off" ? {} : { reasoning: thinking };

  const stream = piAi.streamSimple(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      timeoutMs,
      maxRetries: STAGE_MAX_RETRIES,
      ...reasoningField,
    },
  );

  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(`memory.search ${modelRef} failed: ${finalMsg.errorMessage || finalMsg.stopReason}`);
  }

  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error(`memory.search ${modelRef} returned empty text`);

  // Capture cache + usage metrics from provider response.
  // pi-ai normalizes across providers:
  //   - Anthropic: cacheRead = cache_read_input_tokens, cacheWrite = cache_creation_input_tokens
  //   - OpenAI:    cacheRead = input_tokens_details.cached_tokens, cacheWrite = 0 (never reports writes)
  //   - input is non-cached prompt tokens (OpenAI subtracts cached from total)
  const usageRaw = (finalMsg as any).usage;
  const usage: ModelCallResult["usage"] = usageRaw ? {
    input: usageRaw.input ?? 0,
    output: usageRaw.output ?? 0,
    ...(typeof usageRaw.cacheRead === "number" ? { cacheHit: usageRaw.cacheRead } : {}),
    ...(typeof usageRaw.cacheWrite === "number" ? { cacheWrite: usageRaw.cacheWrite } : {}),
  } : undefined;

  return { rawText, stopReason: finalMsg.stopReason, usage };
}

function kindLabel(kind: string): string {
  if (kind.endsWith("s")) return kind;
  if (kind === "maxim") return "maxims";
  if (kind === "decision") return "decisions";
  if (kind === "smell") return "staging";
  if (kind === "anti-pattern") return "anti-patterns";
  return `${kind}s`;
}

function entryDate(entry: MemoryEntry): string {
  return entry.updated || entry.created || "";
}

function sortForIndex(a: MemoryEntry, b: MemoryEntry): number {
  if (a.kind !== b.kind) return kindLabel(a.kind).localeCompare(kindLabel(b.kind));
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const ad = entryDate(a);
  const bd = entryDate(b);
  // Round 7 P1 (sonnet audit fix): use compareTimestamps for TZ-aware
  // ordering. Cross-TZ-offset and date-only-vs-full-ISO comparisons used
  // to silently reverse freshness signals to LLM stage-1 ranking.
  // Note `bd, ad` order: we want newer entries first (descending).
  if (ad !== bd) return compareTimestamps(bd, ad);
  return a.slug.localeCompare(b.slug);
}

function buildLlmIndexText(entries: MemoryEntry[]): string {
  const lines: string[] = [
    "# Memory Search Index",
    "",
    `> Generated in-memory for ADR 0015 LLM stage-1 candidate selection | ${entries.length} entries`,
    "",
    "## Entries",
    "",
  ];

  let currentKind = "";
  for (const entry of entries.slice().sort(sortForIndex)) {
    const label = kindLabel(entry.kind);
    if (label !== currentKind) {
      currentKind = label;
      lines.push(`### ${label}`, "");
    }

    const meta: string[] = [
      `kind: ${entry.kind}`,
      `status: ${entry.status}`,
      `confidence: ${entry.confidence}`,
    ];
    const date = entryDate(entry);
    if (date) meta.push(`updated: ${date}`);

    const triggers = relationValues(entry.frontmatter.trigger_phrases)
      .map((t) => t.trim())
      .filter(Boolean);
    const related = entry.relatedSlugs.slice(0, 8);
    const summary = (entry.summary || "").replace(/\s+/g, " ").trim();

    lines.push(`#### [[${entry.slug}]] — ${entry.title.replace(/\s+/g, " ").trim()}`);
    lines.push(`- ${meta.join(" | ")}`);
    if (triggers.length > 0) lines.push(`- trigger: ${JSON.stringify(triggers)}`);
    if (related.length > 0) lines.push(`- related: ${JSON.stringify(related)}`);
    if (summary) lines.push(`- summary: ${summary}`);
    lines.push("");
  }

  return lines.join("\n");
}

function unwrapJsonText(rawText: string): unknown {
  const raw = rawText.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [raw, fence?.[1]?.trim()].filter((x): x is string => !!x);

  for (const text of candidates) {
    try {
      return JSON.parse(text);
    } catch {
      // keep trying below
    }
  }

  const arrayStart = raw.indexOf("[");
  const arrayEnd = raw.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(raw.slice(arrayStart, arrayEnd + 1));
    } catch {
      // fall through
    }
  }

  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(raw.slice(objectStart, objectEnd + 1));
    } catch {
      // fall through
    }
  }

  throw new Error(`LLM did not return parseable JSON: ${raw.slice(0, 300)}`);
}

function asArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["results", "candidates", "entries", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function parseCandidatePicks(rawText: string): CandidatePick[] {
  const payload = asArrayPayload(unwrapJsonText(rawText));
  const out: CandidatePick[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      const slug = normalizeBareSlug(item);
      if (slug) out.push({ slug });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = normalizeBareSlug(String(obj.slug ?? obj.id ?? obj.entry ?? ""));
    if (!slug) continue;
    const reason = obj.reason ?? obj.why;
    out.push({ slug, ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}) });
  }
  const seen = new Set<string>();
  return out.filter((pick) => {
    if (seen.has(pick.slug)) return false;
    seen.add(pick.slug);
    return true;
  });
}

function parseFinalPicks(rawText: string): FinalPick[] {
  const payload = asArrayPayload(unwrapJsonText(rawText));
  const out: FinalPick[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      const slug = normalizeBareSlug(item);
      if (slug) out.push({ slug });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = normalizeBareSlug(String(obj.slug ?? obj.id ?? obj.entry ?? ""));
    if (!slug) continue;
    const scoreRaw = obj.score ?? obj.relevance ?? obj.relevance_score;
    const score = typeof scoreRaw === "number" ? scoreRaw : typeof scoreRaw === "string" ? Number(scoreRaw) : undefined;
    const why = obj.why ?? obj.reason ?? obj.analysis;
    out.push({
      slug,
      ...(Number.isFinite(score) ? { score: score as number } : {}),
      ...(typeof why === "string" && why.trim() ? { why: why.trim() } : {}),
    });
  }
  const seen = new Set<string>();
  return out.filter((pick) => {
    if (seen.has(pick.slug)) return false;
    seen.add(pick.slug);
    return true;
  });
}

function makeStage1Prompt(query: string, indexText: string, limit: number): string {
  // Index-first ordering for LLM prompt caching (2026-05-11):
  // the index (~tens of KB) rarely changes, so putting it before the
  // query lets provider-side caching (DeepSeek context cache, Anthropic
  // prompt cache) reuse the KV prefix across calls. Only the query
  // suffix is processed fresh each time. Previously query was before
  // index → cache never hit.
  return [
    "You are pi-astack memory search candidate selector.",
    "",
    "Task: given a user query and a markdown index of all knowledge entries, select entries that are most likely relevant.",
    "Output JSON only: an array of objects [{\"slug\": string, \"reason\": string}]. No markdown wrapper.",
    "",
    "Hard rules:",
    "- The query is a natural-language retrieval prompt. Prefer the user's full intent over literal token overlap.",
    "- The query may be Chinese, English, or mixed. Match across languages semantically, not just literally (e.g. 沉淀 ≡ sediment, 自动写入 ≡ auto-write).",
    "- Prefer entries whose title, summary, trigger_phrases, or related slugs match query intent.",
    "- Prefer recent and high-confidence entries over stale/low-confidence ones, all else equal.",
    "- Do not invent slugs. Return only slugs present in the index.",
    "",
    "Index:",
    "<<<MEMORY_SEARCH_INDEX",
    indexText,
    "MEMORY_SEARCH_INDEX>>>",
    "",
    `Query: ${query}`,
    "",
    `Return at most ${limit} items. If nothing is relevant, return [].`,
  ].join("\n");
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 120);
  return [
    text.slice(0, head),
    `\n\n[... truncated ${text.length - head - tail} chars from middle for context budget ...]\n\n`,
    text.slice(text.length - tail),
  ].join("");
}

function entryForStage2(entry: MemoryEntry): string {
  const triggers = relationValues(entry.frontmatter.trigger_phrases);
  const pieces = [
    `## ${entry.slug}`,
    `title: ${entry.title}`,
    `kind: ${entry.kind}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    entry.created ? `created: ${entry.created}` : undefined,
    entry.updated ? `updated: ${entry.updated}` : undefined,
    triggers.length ? `trigger_phrases: ${JSON.stringify(triggers)}` : undefined,
    entry.relatedSlugs.length ? `related_slugs: ${JSON.stringify(entry.relatedSlugs.slice(0, 20))}` : undefined,
    "",
    "### summary",
    entry.summary,
    "",
    "### compiled_truth",
    entry.compiledTruth,
    "",
    "### timeline",
    entry.timeline.length ? entry.timeline.join("\n") : "(none)",
  ].filter((x): x is string => x !== undefined).join("\n");
  return truncateMiddle(pieces, MAX_STAGE2_ENTRY_CHARS);
}

function makeStage2Prompt(query: string, candidates: MemoryEntry[], limit: number): string {
  // Instructions-first ordering for provider prompt caching (2026-05-11).
  // The instructions block is fixed across all Stage 2 calls (~1K tokens).
  // Candidates and query are variable, but the instruction prefix can still
  // be cached by providers that support prefix-level caching.
  return [
    "You are pi-astack memory search final ranker.",
    "",
    `Task: given a user query and ${candidates.length} candidate knowledge entries (full content), rank them by relevance and output the top ${limit}.`,
    "Output JSON only: an array of objects [{\"slug\": string, \"score\": number, \"why\": string}]. Score is 0-10 relevance.",
    "",
    "Hard rules:",
    "- Read each entry's compiled_truth AND timeline. Timeline may refine, supersede, or invalidate compiled_truth; reflect this in ranking.",
    "- Match Chinese/English/mixed intent semantically, not literally.",
    "- Prefer the most directly useful entry for the query over broad background entries.",
    "- Use freshness when it matters: for current-state / implementation / next-step queries, prefer recently updated and non-superseded entries.",
    "- Do NOT rank newer entries above older high-confidence maxims/principles solely because they are newer.",
    "- If an entry is obsolete/superseded by another candidate, rank the newer/superseding one higher.",
    "- In the why field, mention freshness/timeline evidence when it materially affects ranking.",
    "- Do not invent slugs. Return only slugs present in Candidates.",
    "- If nothing is relevant, return [].",
    "",
    "Candidates:",
    "<<<MEMORY_SEARCH_CANDIDATES",
    candidates.map(entryForStage2).join("\n\n---\n\n"),
    "MEMORY_SEARCH_CANDIDATES>>>",
    "",
    `Query: ${query}`,
  ].join("\n");
}

function resultCard(entry: MemoryEntry, score: number, rankReason?: string) {
  return {
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    score: Number(clamp(score, 0, 1).toFixed(4)),
    kind: entry.kind,
    status: entry.status,
    confidence: entry.confidence,
    created: entry.created,
    updated: entry.updated,
    ...(rankReason ? { rank_reason: rankReason } : {}),
    timeline_tail: entry.timeline.slice(-2),
    related_slugs: entry.relatedSlugs.slice(0, 5),
  };
}

function rankFromStage2(entriesBySlug: Map<string, MemoryEntry>, picks: FinalPick[], limit: number) {
  const hits = picks
    .map((pick, i) => {
      const entry = entriesBySlug.get(pick.slug);
      if (!entry) return undefined;
      const rawScore = typeof pick.score === "number" && Number.isFinite(pick.score)
        ? pick.score
        : Math.max(0, 10 - i);
      const normalized = rawScore > 1 ? rawScore / 10 : rawScore;
      return resultCard(entry, normalized, pick.why);
    })
    .filter((x): x is ReturnType<typeof resultCard> => !!x)
    .sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function filteredEntries(entries: MemoryEntry[], filters: SearchFilters | undefined): MemoryEntry[] {
  return entries.filter((entry) => entryMatchesFilters(entry, filters));
}

export async function llmSearchEntries(
  entries: MemoryEntry[],
  params: SearchParams,
  settings: MemorySettings,
  modelRegistryRaw: unknown,
  signal?: AbortSignal,
  projectRoot?: string,
) {
  const rawQuery = String(params.query ?? "").trim();
  if (!rawQuery) return [];
  // memory_search sends the query to an LLM reranker and persists a metrics
  // row. Sanitize before both the prompt and the 80-char metrics truncation;
  // truncating first can leave a partial credential that no longer matches.
  const querySanitize = sanitizeForMemory(rawQuery);
  const query = querySanitize.ok ? (querySanitize.text ?? rawQuery) : `[redacted: ${querySanitize.error}]`;

  assertModelRegistry(modelRegistryRaw);
  const modelRegistry = modelRegistryRaw;

  const filters = params.filters ?? {};
  const finalLimit = clamp(
    Math.floor(filters.limit ?? settings.search.stage2Limit ?? settings.defaultLimit),
    1,
    settings.maxLimit,
  );
  const candidateLimit = Math.max(finalLimit, Math.floor(settings.search.stage1Limit));

  const corpus = filteredEntries(entries, filters);
  if (corpus.length === 0) return [];

  const indexText = buildLlmIndexText(corpus);
  const stage1 = await callSearchModel(
    settings.search.stage1Model,
    makeStage1Prompt(query, indexText, candidateLimit),
    modelRegistry,
    signal,
    STAGE1_TIMEOUT_MS,
    settings.search.stage1Thinking,
  );
  const stage1Picks = parseCandidatePicks(stage1.rawText).slice(0, candidateLimit);
  if (stage1Picks.length === 0) return [];

  const entriesBySlug = new Map(corpus.map((entry) => [entry.slug, entry]));
  const candidateEntries = stableUnique(stage1Picks.map((pick) => pick.slug))
    .map((slug) => entriesBySlug.get(slug))
    .filter((entry): entry is MemoryEntry => !!entry);

  if (candidateEntries.length === 0) return [];

  const stage2 = await callSearchModel(
    settings.search.stage2Model,
    makeStage2Prompt(query, candidateEntries, finalLimit),
    modelRegistry,
    signal,
    STAGE2_TIMEOUT_MS,
    settings.search.stage2Thinking,
  );
  const stage2Picks = parseFinalPicks(stage2.rawText);

  // ── Cache metrics log ─────────────────────────────────────────
  // Write to project-scoped metrics file for analysis.
  const s1 = stage1.usage;
  const s2 = stage2.usage;
  const entry = {
    ts: new Date().toISOString(),
    query: query.slice(0, 80),
    s1: s1 ? { in: s1.input, out: s1.output, ...(s1.cacheHit != null ? { hit: s1.cacheHit } : {}), ...(s1.cacheWrite != null ? { write: s1.cacheWrite } : {}) } : null,
    s2: s2 ? { in: s2.input, out: s2.output, ...(s2.cacheHit != null ? { hit: s2.cacheHit } : {}), ...(s2.cacheWrite != null ? { write: s2.cacheWrite } : {}) } : null,
    results: stage2Picks.length,
  };
  logSearchMetrics(entry, projectRoot);

  if (stage2Picks.length === 0) return [];
  return rankFromStage2(entriesBySlug, stage2Picks, finalLimit);
}
