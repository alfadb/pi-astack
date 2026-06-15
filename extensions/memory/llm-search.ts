import * as path from "node:path";
import type { MemorySettings, ThinkingLevel } from "./settings";
import type { MemoryEntry, SearchFilters, SearchParams } from "./types";
import { relationValues } from "./parser";
import { entryMatchesFilters } from "./search";
import { clamp, compareTimestamps, normalizeBareSlug, stableUnique } from "./utils";
import { embedSchemeTag, embedTexts, resolveEmbeddingProviderConfig, scopeTagOf, staleOrMissingSlugs, VectorIndex, vectorIndexPath, type EmbeddingProviderConfig } from "./embedding";
import { maybeAutoReconcile, type ReconcileSignal } from "./auto-reconcile";
import { ensureProjectGitignoredOnce, memorySearchMetricsPath } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { sanitizeForMemory } from "../sediment/sanitizer";
import { SEARCH_PROFILES, resolveProfileExecution, type SearchProfileName } from "./search-profiles";
import { recordUsage, isUsageRecordingProfile } from "./usage-telemetry";

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
    // ADR 0027 PR-B+ R1 P1-3: attach causal anchor for cross-layer join.
    // memory_search is invoked during tool-call rounds in a user turn;
    // anchor reflects the calling turn. Entry fields override anchor on
    // collision (spread order: anchor first).
    const enriched = { ...spreadAnchor(getCurrentAnchor()), ...entry };
    fsSync.appendFileSync(file, JSON.stringify(enriched) + "\n", "utf-8");
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
const MAX_STAGE1_ENTRY_CHARS = 12_000;
const MAX_STAGE2_ENTRY_CHARS = 12_000;
// ADR 0035 P5: full_body_v3 退役为 flag-off kill-switch + oracle baseline surface;
// stage0(STAGE0_SURFACE)是默认生产面(DEFAULT_SEARCH_SETTINGS.stage0Enabled=true)。
const STAGE1_CANDIDATE_SURFACE = "full_body_v3";

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

export async function callSearchModel(
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

function entryForStage1(entry: MemoryEntry, compact = false): string {
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
  const pieces = [
    `#### [[${entry.slug}]] — ${entry.title.replace(/\s+/g, " ").trim()}`,
    `- ${meta.join(" | ")}`,
    triggers.length > 0 ? `- trigger: ${JSON.stringify(triggers)}` : undefined,
    related.length > 0 ? `- related: ${JSON.stringify(related)}` : undefined,
    summary ? `- summary: ${summary}` : undefined,
    // P8: 紧凑模式只留 meta+title+trigger+related+summary 做粗筛; 完整
    // compiledTruth+timeline(大头)留给 stage2 精排。dense 已保证候选相关性。
    ...(compact ? [] : [
      "",
      "##### compiled_truth",
      entry.compiledTruth || "(empty)",
      "",
      "##### timeline",
      entry.timeline.length ? entry.timeline.join("\n") : "(none)",
    ]),
  ].filter((x): x is string => x !== undefined).join("\n");
  return truncateMiddle(pieces, MAX_STAGE1_ENTRY_CHARS);
}

function buildLlmIndexText(entries: MemoryEntry[], compact = false): string {
  const lines: string[] = [
    "# Memory Search Index",
    "",
    `> Generated in-memory for ADR 0015 LLM stage-1 candidate selection | ${entries.length} entries | surface:${compact ? "stage1_compact_v1" : STAGE1_CANDIDATE_SURFACE}`,
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
    lines.push(entryForStage1(entry, compact), "");
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

  // 截断/噪声容错: 提取所有顶层完整 {...} 对象(stage1/2 picks 无嵌套 {}),
  // LLM 输出超 maxTokens 被 cut 时不让一次截断丢掉整个候选集。比逐字符
  // depth 计数鲁棒(不受 reason 内引号干扰)。生产鲁棒性 + oracle 大 corpus baseline。
  const objMatches = raw.match(/\{[^{}]*\}/g);
  if (objMatches) {
    const picks: unknown[] = [];
    for (const o of objMatches) {
      try { picks.push(JSON.parse(o)); } catch { /* skip malformed */ }
    }
    if (picks.length > 0) return picks;
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

/**
 * Stage 2 LLM output: either the legacy bare array, or the new object
 * shape with explicit relevance_verdict (2026-05-28, ADR 0026 §3.1
 * walk-back). The object shape is required for path A's LLM-side strong
 * cutoff: it lets the LLM explicitly say "no relevant memories" via
 * verdict="none" rather than emitting a noisy top-N.
 *
 * Verdict semantics:
 *   - has_relevant: LLM judged at least one entry directly addresses the query
 *   - none: LLM judged no entry directly addresses the query
 *   - unknown: parse fell back to legacy array shape; caller treats as
 *     has_relevant when picks non-empty, none when empty (== legacy behavior)
 */
export interface FinalPicksWithVerdict {
  verdict: "has_relevant" | "none" | "unknown";
  picks: FinalPick[];
}

function collectPicksFromArray(payload: unknown[]): FinalPick[] {
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

function parseFinalPicksWithVerdict(rawText: string): FinalPicksWithVerdict {
  const parsed = unwrapJsonText(rawText);
  // New object shape: { relevance_verdict, picks }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const rawVerdict = obj.relevance_verdict ?? obj.verdict;
    const verdict: FinalPicksWithVerdict["verdict"] =
      rawVerdict === "has_relevant" || rawVerdict === "none" ? rawVerdict : "unknown";
    const picksPayload = obj.picks ?? obj.entries ?? obj.results;
    const picks = collectPicksFromArray(asArrayPayload(picksPayload));
    // Reconcile: trust verdict when it disagrees with picks emptiness.
    if (verdict === "none") return { verdict, picks: [] };
    if (verdict === "has_relevant" && picks.length === 0) return { verdict: "none", picks: [] };
    return { verdict, picks };
  }
  // Legacy bare-array shape: infer verdict from emptiness.
  const arrPicks = collectPicksFromArray(asArrayPayload(parsed));
  return {
    verdict: arrPicks.length === 0 ? "none" : "unknown",
    picks: arrPicks,
  };
}

function parseFinalPicks(rawText: string): FinalPick[] {
  return parseFinalPicksWithVerdict(rawText).picks;
}

function makeStage1Prompt(query: string, indexText: string, limit: number, compact = false): string {
  // Surface-first ordering for LLM prompt caching (2026-06-12):
  // the full-body v3 candidate surface changes only when memory entries
  // change, so putting it before the query still lets provider-side caching
  // reuse the KV prefix across calls. F18 intentionally widens the old
  // frontmatter-only index despite a larger prefix because recall accuracy
  // is now higher priority than prompt-cache compactness.
  return [
    "You are pi-astack memory search candidate selector.",
    "",
    compact
      ? "Task: given a user query and a COMPACT candidate surface (metadata + title + trigger_phrases + summary; full body deferred to the next ranking stage) of pre-filtered candidate entries, select entries that are most likely relevant."
      : "Task: given a user query and a full-body candidate surface of all knowledge entries, select entries that are most likely relevant.",
    "Output JSON only: an array of objects [{\"slug\": string, \"reason\": string}]. No markdown wrapper.",
    "",
    "Hard rules:",
    "- The query is a natural-language retrieval prompt. Prefer the user's full intent over literal token overlap.",
    "- The query may be Chinese, English, or mixed. Match across languages semantically, not just literally (e.g. 沉淀 ≡ sediment, 自动写入 ≡ auto-write).",
    compact
      ? "- Read each entry's title, summary, trigger_phrases, and related slugs. (compiled_truth/timeline are intentionally NOT in this compact surface — judge relevance from summary/title/trigger; the full body is re-read in the next ranking stage.)"
      : "- Read each entry's title, summary, trigger_phrases, related slugs, compiled_truth, and timeline before selecting candidates.",
    compact
      ? "- Candidates are already semantically pre-filtered; prefer entries whose summary/title/trigger match query intent, and be inclusive — borderline entries are refined (with full body) in the next stage, so when unsure include rather than drop."
      : "- Prefer entries whose body evidence (compiled_truth/timeline) matches query intent, even when frontmatter is sparse or generic.",
    "- Prefer recent and high-confidence entries over stale/low-confidence ones, all else equal.",
    "- Do not invent slugs. Return only slugs present in the candidate surface.",
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
    `Task: given a user query and ${candidates.length} candidate knowledge entries (full content), decide whether ANY entry is directly relevant to the query. If yes, rank the top ${limit}.`,
    "",
    "Output strict JSON with this shape (no markdown fence):",
    "{",
    "  \"relevance_verdict\": \"has_relevant\" | \"none\",",
    "  \"picks\": [{\"slug\": string, \"score\": number, \"why\": string}]",
    "}",
    "",
    "Score is 0-10 relevance. If verdict is \"none\", picks MUST be []. If verdict is \"has_relevant\", picks MUST contain at least one entry.",
    "",
    "Hard rules:",
    "- **Be conservative on relevance_verdict.** If entries are merely tangentially related, topically near-by, or share keywords but do NOT directly help with the query, output \"none\". Only output \"has_relevant\" when at least one entry would materially shift how a competent assistant answers this query.",
    "- Read each entry's compiled_truth AND timeline. Timeline may refine, supersede, or invalidate compiled_truth; reflect this in ranking.",
    "- Match Chinese/English/mixed intent semantically, not literally.",
    "- Prefer the most directly useful entry for the query over broad background entries.",
    "- Use freshness when it matters: for current-state / implementation / next-step queries, prefer recently updated and non-superseded entries.",
    "- Do NOT rank newer entries above older high-confidence maxims/principles solely because they are newer.",
    "- If an entry is obsolete/superseded by another candidate, rank the newer/superseding one higher.",
    "- In the why field, mention freshness/timeline evidence when it materially affects ranking.",
    "- Do not invent slugs. Return only slugs present in Candidates.",
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

// ─── ADR 0035 P3: stage0 embedding 候选检索 + 双阶段内核(folded) ───
// flag off → candidateEntries = 全 corpus(完全等同现状 full_body_v3);
// flag on → stage0 hybrid(dense+sparse+stale, 硬上限)喂 stage1。
const STAGE0_SURFACE = "stage0_hybrid_v1";

function byUpdatedDesc(a: MemoryEntry, b: MemoryEntry): number {
  return compareTimestamps(b.updated ?? b.created ?? "", a.updated ?? a.created ?? "");
}

/** Sparse 精确匹配: query terms 命中 slug/title/trigger_phrases/compiledTruth/
 *  timeline(含 body —— ADR 编号/函数名/错误码常在正文不在标题, 修订 3)。
 *  纯 in-memory 子串, 零 I/O。按命中 term 数降序。 */
// ADR 0036: char n-gram tokenizer — ASCII 标识符/符号 + CJK bigram, 解中文
// sparse 盲区(旧 regex /[a-z0-9].../ 对中文零匹配)。纯 JS 零依赖。
function sparseTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_./-]{1,}/g)) out.push(m[0]);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2)); // CJK bigram
  }
  return out;
}

// ADR 0036: BM25 char-ngram sparse — IDF 加权 + 高信号字段(slug/title/trigger)
// ×3, 替朴素子串(无 IDF + 中文零匹配)。与 dense 交由 selectStage0Pool union。
export function sparseMatchSlugsBM25(query: string, corpus: MemoryEntry[]): string[] {
  const qTokens = [...new Set(sparseTokens(query))];
  if (qTokens.length === 0) return [];
  const df = new Map<string, number>();
  const docs = corpus.map((e) => {
    const high = sparseTokens([e.slug, e.title, relationValues(e.frontmatter.trigger_phrases).join(" ")].join(" "));
    const body = sparseTokens([e.compiledTruth, e.timeline.join(" ")].join(" "));
    const highTf = new Map<string, number>(); for (const t of high) highTf.set(t, (highTf.get(t) ?? 0) + 1);
    const bodyTf = new Map<string, number>(); for (const t of body) bodyTf.set(t, (bodyTf.get(t) ?? 0) + 1);
    for (const t of new Set([...highTf.keys(), ...bodyTf.keys()])) df.set(t, (df.get(t) ?? 0) + 1);
    return { highTf, bodyTf, dl: high.length + body.length };
  });
  const N = Math.max(1, corpus.length);
  const avgdl = docs.reduce((s, d) => s + d.dl, 0) / N;
  const k1 = 1.2, b = 0.75;
  const scored: Array<{ slug: string; score: number }> = [];
  for (let i = 0; i < corpus.length; i++) {
    const { highTf, bodyTf, dl } = docs[i];
    let score = 0;
    for (const t of qTokens) {
      const tf = (highTf.get(t) ?? 0) * 3 + (bodyTf.get(t) ?? 0); // 高信号字段 ×3
      if (tf === 0) continue;
      const dft = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / Math.max(1, avgdl)));
    }
    if (score > 0) scored.push({ slug: corpus[i].slug, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.slug);
}

export function sparseMatchSlugs(query: string, corpus: MemoryEntry[]): string[] {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9_./-]{2,}/g) ?? []))]
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];
  const scored: Array<{ slug: string; score: number }> = [];
  for (const e of corpus) {
    // 字段权重(P4 修复 coverage gap): sparse 扫 body 会命中爆炸(body 含很多词),
    // body-only 低信号命中会挤占 maxCandidates 把 dense 振出池。高信号字段
    // (slug/title/trigger)命中 ×3, body(compiledTruth/timeline)命中 ×1。
    const high = [e.slug, e.title, relationValues(e.frontmatter.trigger_phrases).join(" ")].join(" \n ").toLowerCase();
    const body = [e.compiledTruth, e.timeline.join(" ")].join(" \n ").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (high.includes(t)) score += 3;
      else if (body.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ slug: e.slug, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.slug);
}

// ADR 0036 §9.1 条件 3: stage0 候选 union 排序(纯函数, 可单测)。window-aware:
// dense 领跑窗口(windowSize - floorReserveInWindow), 再把最近变更 stale 填进窗口尾
// 预留(仍在 top-windowSize → 新写 entry 必进窗口, freshness 不变量), 之后
// dense/sparse/剩余 stale 填到 maxCand 供 three-stage(stage1 看全池, 顺序无关)。
// stage1Skip 直取 slice(0, candidateLimit) 时窗口由 dense 主导, stale-heavy 不再挤出 dense top-K。
export function orderStage0Candidates(
  denseSlugs: string[],
  sparseSlugs: string[],
  staleByRecency: string[],
  staleSlugs: string[],
  opts: { allow: (s: string) => boolean; windowSize: number; floorReserveInWindow: number; maxCand: number },
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const take = (slugs: string[], cap: number) => {
    for (const s of slugs) {
      if (ordered.length >= cap) break;
      if (seen.has(s) || !opts.allow(s)) continue;
      seen.add(s); ordered.push(s);
    }
  };
  take(denseSlugs, Math.max(0, opts.windowSize - opts.floorReserveInWindow)); // (1) dense 领跑窗口
  take(staleByRecency, opts.windowSize);  // (2) 最近变更 stale 填窗口尾预留(freshness 进窗口)
  take(denseSlugs, opts.maxCand);         // (3) dense 大头(窗口外)
  take(sparseSlugs, opts.maxCand);        // (4) sparse 精确补
  take(staleSlugs, opts.maxCand);         // (5) 剩余 stale 补到 maxCand(three-stage freshness)
  return ordered;
}

interface Stage0Pool {
  candidateEntries: MemoryEntry[];
  mode: "hybrid" | "sparse_fallback";
  denseSlugs: string[];   // 有序(cosine 降序), 供 metrics best-dense-rank 探针
  denseCount: number;
  sparseCount: number;
  staleCount: number;
  reconcileSignal: ReconcileSignal;   // ADR 0036 §10.6: 双向 auto-reconcile 触发信号(add∪prune)
  embedMs: number;
}

/** stage0 hybrid 候选选择 + provider 熔断。返回 null = 不适用 stage0(provider
 *  未配置 或 非-active-status 查询的 dense 盲区), 调用方回退全 corpus 喂 stage1
 *  (罕见+条目少, 可接受 — 修订 7)。query embed 失败 → 熔断 sparse-only(禁全库
 *  full-body — 修订 5), 短超时 + 不重试。 */
export async function selectStage0Pool(
  query: string,
  corpus: MemoryEntry[],
  settings: MemorySettings,
  modelRegistry: ModelRegistryLike,
  filters: SearchFilters,
): Promise<Stage0Pool | null> {
  const emb = settings.embedding;
  if (!emb.provider || !emb.model) return null; // 未配置 → 全 corpus
  // P7(4×T0 设计 review): 非-active-status 查询(如 sediment curator 去重
  // status:["all"])不再回退全库 full_body —— 走 hybrid 缩候选: dense 在 active
  // 索引(非 active 不在索引、自然不返回, 无害) + sparse 扫全 corpus(含非 active,
  // 非 active 唯一召回通道) + stale(仅可索引集, 见下)。原 wantsNonActive→null 是
  // ADR §7 修订 7 “非 active 查询罕见可接受”的错误假设——sediment 去重是每轮高频+大库。

  const entriesBySlug = new Map(corpus.map((e) => [e.slug, e]));
  const allowSlugs = new Set(corpus.map((e) => e.slug));
  const poolLimit = settings.search.stage0PoolLimit;
  const maxCand = settings.search.stage0MaxCandidates;

  const idx = new VectorIndex(vectorIndexPath(), emb.model, emb.dim).load();
  let denseSlugs: string[] = [];
  let mode: Stage0Pool["mode"] = "hybrid";
  let embedMs = 0;
  try {
    const cfg = await resolveEmbeddingProviderConfig(modelRegistry, emb);
    // 短超时 + 不重试: query embed 失败即开闸熔断, 别叠 60s entry 超时×maxRetries(修订 5)
    const qcfg: EmbeddingProviderConfig = { ...cfg, timeoutMs: settings.search.stage0EmbedTimeoutMs, maxRetries: 0 };
    const t = Date.now();
    const [qv] = await embedTexts([query], qcfg);
    embedMs = Date.now() - t;
    // ADR 0036 P4 条件1: dedup 路径(profile 钉 dedupChunk0Aggregation)只用 chunk0 聚合,
    // 避免 multiVector max-sim 让共享尾段 chunk 的 distinct entry 浮上为 false-merge 候选。
    const agg = settings.search.dedupChunk0Aggregation ? "chunk0" : undefined;
    denseSlugs = idx.topN(qv, poolLimit, { allowSlugs, agg }).map((h) => h.slug);
  } catch {
    mode = "sparse_fallback"; // 熔断: dense 不可用 → sparse-only(禁全库)
  }

  const sparseSlugs = settings.search.sparseBM25
    ? sparseMatchSlugsBM25(query, corpus)
    : sparseMatchSlugs(query, corpus);
  // P7(4×T0 共识, load-bearing fix): stale 只算“reconcile 会 embed 的集合”。
  // staleOrMissingSlugs 原对全 corpus 算 → status:["all"] 查询时所有非 active +
  // readonly rule neighbors(zone:rules, 不经 loadEntries 永不被 reconcile embed)
  // 都因 !isFresh 被标 stale → 塞爆候选池且永久 stale。只对可索引集算:
  // status==="active" 且 非 zone:rules(与 buildCorpusEmbeddings 的 embed 集一致)。
  // 非 active 是“故意不索引”非“陈旧”, freshness 不变量不适用于它们。
  const indexableForStale = corpus.filter(
    (e) => e.status === "active" && (e.frontmatter as Record<string, unknown> | undefined)?.zone !== "rules",
  );
  // ADR 0036 P4: 传 scheme → multiVector toggle 后旧 scheme 的 entry 被认为 stale,
  // 进 freshness floor 重嵌(与全库 rebuild 互补)。flag-off 时 scheme="s", 迁移后
  // 的 v1 记录默认 "s" → 不误报 stale。
  const staleSlugs = staleOrMissingSlugs(idx, indexableForStale, embedSchemeTag(emb.multiVector)); // search-time freshness(仅可索引集)

  // union + 硬上限 —— window-aware 排序(见 orderStage0Candidates, §9.1 条件 3)。
  // windowSize = two-stage 候选窗口(candidateLimit = max(stage2Limit, stage1Limit))。
  // fresh 索引(stale≈0)下窗口自然全 dense(与 P6 eval 现状一致)。
  const windowSize = Math.max(settings.search.stage2Limit, settings.search.stage1Limit);
  const staleByRecency = staleSlugs
    .map((s) => entriesBySlug.get(s))
    .filter((e): e is MemoryEntry => !!e)
    .sort(byUpdatedDesc)
    .map((e) => e.slug);
  const ordered = orderStage0Candidates(denseSlugs, sparseSlugs, staleByRecency, staleSlugs, {
    allow: (s) => entriesBySlug.has(s),
    windowSize,
    floorReserveInWindow: Math.ceil(windowSize * settings.search.stage0StaleFloorRatio),
    maxCand,
  });

  // 熔断且 sparse 空 → 有界 recency 采样(禁全库 full-body, 修订 5)
  if (mode === "sparse_fallback" && ordered.length === 0) {
    for (const e of corpus.slice().sort(byUpdatedDesc).slice(0, poolLimit)) ordered.push(e.slug);
  }

  // ADR 0036 §10.6: 双向 auto-reconcile 信号(数据均已加载, 纯 set 运算)。
  // ADD = staleSlugs(content-hash 缺失/陈旧); PRUNE = 索引内 in-scope 但已非 active 的孤儿。
  const activeSlugsSet = new Set(indexableForStale.map((e) => e.slug));
  const loadedScopes = new Set(indexableForStale.map((e) => scopeTagOf(e)));
  const reconcileSignal: ReconcileSignal = {
    indexEmpty: idx.size() === 0,
    staleCount: staleSlugs.length,
    orphanCount: idx.countOrphans(activeSlugsSet, loadedScopes),
    activeCount: activeSlugsSet.size,
  };

  return {
    candidateEntries: ordered.map((s) => entriesBySlug.get(s)).filter((e): e is MemoryEntry => !!e),
    mode, denseSlugs, denseCount: denseSlugs.length, sparseCount: sparseSlugs.length, staleCount: staleSlugs.length, embedMs,
    reconcileSignal,
  };
}

interface TwoStageResult {
  hits: ReturnType<typeof resultCard>[];
  verdict: "has_relevant" | "none" | "unknown";
  stage1Ms: number;
  stage2Ms: number;
  stage1Usage?: ModelCallResult["usage"];
  stage2Usage?: ModelCallResult["usage"];
  picksCount: number;
}

/** 双阶段内核(folded): candidateEntries 喂 buildLlmIndexText(stage0 已缩 or 全
 *  corpus), stage1 LLM 选候选 → stage2 LLM 精排 + verdict。两个 export 函数共享。 */
async function runTwoStageSearch(
  query: string,
  candidateEntries: MemoryEntry[],
  settings: MemorySettings,
  modelRegistry: ModelRegistryLike,
  signal: AbortSignal | undefined,
  finalLimit: number,
  candidateLimit: number,
): Promise<TwoStageResult> {
  if (candidateEntries.length === 0) {
    return { hits: [], verdict: "none", stage1Ms: 0, stage2Ms: 0, picksCount: 0 };
  }
  const entriesBySlug = new Map(candidateEntries.map((e) => [e.slug, e]));
  let candidates: MemoryEntry[];
  let stage1Ms = 0;
  let stage1Usage: ModelCallResult["usage"] | undefined;
  if (settings.search.stage1Skip) {
    // ADR 0036 两阶段塔缩(5×T0 共识): stage0 已按 dense 排序, stage1 LLM 从
    // 候选选 top-K 与 dense 排序高度冲退。跳过 stage1, 直取 stage0 top-K 喚 stage2
    // 精排(省 ~324K token)。candidates 顺序 = stage0 ordered(floor→dense→sparse→stale)。
    candidates = candidateEntries.slice(0, candidateLimit);
  } else {
    const indexText = buildLlmIndexText(candidateEntries, settings.search.stage1CompactSurface);
    const t1 = Date.now();
    const stage1 = await callSearchModel(
      settings.search.stage1Model, makeStage1Prompt(query, indexText, candidateLimit, settings.search.stage1CompactSurface),
      modelRegistry, signal, STAGE1_TIMEOUT_MS, settings.search.stage1Thinking,
    );
    stage1Ms = Date.now() - t1;
    stage1Usage = stage1.usage;
    const stage1Picks = parseCandidatePicks(stage1.rawText).slice(0, candidateLimit);
    candidates = stableUnique(stage1Picks.map((p) => p.slug))
      .map((slug) => entriesBySlug.get(slug))
      .filter((e): e is MemoryEntry => !!e);
  }
  if (candidates.length === 0) {
    return { hits: [], verdict: "none", stage1Ms, stage2Ms: 0, stage1Usage, picksCount: 0 };
  }
  const t2 = Date.now();
  const stage2 = await callSearchModel(
    settings.search.stage2Model, makeStage2Prompt(query, candidates, finalLimit),
    modelRegistry, signal, STAGE2_TIMEOUT_MS, settings.search.stage2Thinking,
  );
  const stage2Ms = Date.now() - t2;
  const parsed = parseFinalPicksWithVerdict(stage2.rawText);
  const hits = parsed.picks.length === 0 ? [] : rankFromStage2(entriesBySlug, parsed.picks, finalLimit);
  return {
    hits, verdict: parsed.verdict, stage1Ms, stage2Ms,
    stage1Usage, stage2Usage: stage2.usage, picksCount: parsed.picks.length,
  };
}

interface ExecSearchResult {
  hits: ReturnType<typeof resultCard>[];
  verdict: "has_relevant" | "none" | "unknown";
  stage1Ms: number;
  stage2Ms: number;
  surface: string;
}

/** 统一内核: stage0 候选 → 双阶段 → 安全网双触发 → metrics。两个 export 函数薄包装。 */
async function executeSearch(
  entries: MemoryEntry[],
  params: SearchParams,
  settings: MemorySettings,
  modelRegistryRaw: unknown,
  signal: AbortSignal | undefined,
  projectRoot: string | undefined,
): Promise<ExecSearchResult> {
  const rawQuery = String(params.query ?? "").trim();
  if (!rawQuery) return { hits: [], verdict: "none", stage1Ms: 0, stage2Ms: 0, surface: "none" };
  // Sanitize before both prompt and 80-char metrics truncation.
  const querySanitize = sanitizeForMemory(rawQuery);
  const query = querySanitize.ok ? (querySanitize.text ?? rawQuery) : `[redacted: ${querySanitize.error}]`;
  assertModelRegistry(modelRegistryRaw);
  const modelRegistry = modelRegistryRaw;
  const filters = params.filters ?? {};
  const finalLimit = clamp(
    Math.floor(filters.limit ?? settings.search.stage2Limit ?? settings.defaultLimit),
    1, settings.maxLimit,
  );
  const candidateLimit = Math.max(finalLimit, Math.floor(settings.search.stage1Limit));
  const corpus = filteredEntries(entries, filters);
  if (corpus.length === 0) return { hits: [], verdict: "none", stage1Ms: 0, stage2Ms: 0, surface: "empty" };

  // stage0 候选选择(P3) or 全 corpus(flag off / 未配置 / 非active)
  let candidateEntries = corpus;
  let surface = STAGE1_CANDIDATE_SURFACE; // full_body_v3 (flag off / fallback)
  let pool: Stage0Pool | null = null;
  if (settings.search.stage0Enabled) {
    pool = await selectStage0Pool(query, corpus, settings, modelRegistry, filters);
    if (pool) {
      candidateEntries = pool.candidateEntries;
      surface = STAGE0_SURFACE;
      // ADR 0036 §10.6: fire-and-forget 双向后台 reconcile(single-flight + cooldown +
      // 仅空索引/超 backlog 才触)。非阻塞: 本轮仍走 bounded fallback, 下轮受益。
      // projectRoot 未传(oracle/scratch)时在决策函数内被 gated 掉, 不动生产索引。
      maybeAutoReconcile(projectRoot, settings, modelRegistry, pool.reconcileSignal);
    }
  }

  let result = await runTwoStageSearch(query, candidateEntries, settings, modelRegistry, signal, finalLimit, candidateLimit);

  // 安全网双触发(修订 6): verdict=none OR pool<K → 一次有界扩召(topN×3 上限 400),
  // 仍 none 返回 none(不全库)。insufficient_pool 用结构信号 pool<K, 非绝对 cosine 门。
  // ADR 0036 §4(P6 3×T0 评审条件 1, 兑现安全网契约): 扩召 retry **强制 stage1Skip=false**,
  // 让 stage1 LLM 在扩召池上救场。stage1Skip=true(两阶段塌缩)转产后, 这是 stage1 降级为
  // 低频 fallback(非删除)的落点 —— 仅 verdict=none/pool<K 触发, blast radius 小。
  // stage1Skip=false(现默认)时此覆写无行为变化(primary 已走 stage1)。
  let expanded = false;
  const poolTooSmall = !!pool && pool.mode === "hybrid" && candidateEntries.length < settings.search.stage0InsufficientPoolK;
  if (pool && pool.mode === "hybrid" && (result.verdict === "none" || poolTooSmall)) {
    const expandedPoolLimit = Math.min(settings.search.stage0PoolLimit * 3, 400);
    const expSettings: MemorySettings = { ...settings, search: { ...settings.search, stage0PoolLimit: expandedPoolLimit } };
    const exp = await selectStage0Pool(query, corpus, expSettings, modelRegistry, filters);
    if (exp && exp.candidateEntries.length > candidateEntries.length) {
      const retrySettings: MemorySettings = { ...settings, search: { ...settings.search, stage1Skip: false } };
      const retry = await runTwoStageSearch(query, exp.candidateEntries, retrySettings, modelRegistry, signal, finalLimit, candidateLimit);
      if (retry.verdict === "has_relevant" || retry.hits.length > result.hits.length) {
        result = retry; pool = exp; candidateEntries = exp.candidateEntries; expanded = true;
      }
    }
  }

  const s1 = result.stage1Usage;
  const s2 = result.stage2Usage;
  // stage0 观测探针(ADR §7 success criteria): best-dense-rank(最终 hits 在 dense
  // 排名最小值, 反映 dense 召回质量; -1=hits 均不在 dense)、pool-hit-rate(hits
  // 命中 dense 占比)、fallback(熔断)、dirty-size(stale)、embed-latency。
  let bestDenseRank = -1, picksInDense = 0;
  if (pool) {
    const denseRank = new Map(pool.denseSlugs.map((s, i) => [s, i] as const));
    for (const h of result.hits) {
      const r = denseRank.get(h.slug);
      if (r !== undefined) { picksInDense++; if (bestDenseRank < 0 || r < bestDenseRank) bestDenseRank = r; }
    }
  }
  logSearchMetrics({
    ts: new Date().toISOString(),
    query: query.slice(0, 80),
    s1: s1 ? { in: s1.input, out: s1.output, ...(s1.cacheHit != null ? { hit: s1.cacheHit } : {}), ...(s1.cacheWrite != null ? { write: s1.cacheWrite } : {}) } : null,
    s2: s2 ? { in: s2.input, out: s2.output, ...(s2.cacheHit != null ? { hit: s2.cacheHit } : {}), ...(s2.cacheWrite != null ? { write: s2.cacheWrite } : {}) } : null,
    results: result.hits.length,
    verdict: result.verdict,
    stage1_surface: surface,
    stage1_ms: result.stage1Ms,
    stage2_ms: result.stage2Ms,
    ...(pool ? {
      stage0_mode: pool.mode,
      stage0_fallback: pool.mode === "sparse_fallback",
      stage0_pool: candidateEntries.length,
      stage0_dense: pool.denseCount,
      stage0_sparse: pool.sparseCount,
      stage0_stale: pool.staleCount,
      stage0_pool_hit: result.hits.length ? picksInDense / result.hits.length : null,
      stage0_picks_in_dense: picksInDense,
      stage0_best_dense_rank: bestDenseRank,
      stage0_embed_ms: pool.embedMs,
      stage0_expanded: expanded,
      corpus_size: corpus.length,
    } : {}),
  }, projectRoot);

  return { hits: result.hits, verdict: result.verdict, stage1Ms: result.stage1Ms, stage2Ms: result.stage2Ms, surface };
}

// ADR 0037: 私有内核 wrapper —— 生产唯一入口是 runMemorySearch(profile, ...)。
// 不再 export(防第 6 个调用方手搓 policy); oracle/smoke 脚本经文底 __oracleKernel 用。
async function llmSearchEntries(
  entries: MemoryEntry[],
  params: SearchParams,
  settings: MemorySettings,
  modelRegistryRaw: unknown,
  signal?: AbortSignal,
  projectRoot?: string,
) {
  return (await executeSearch(entries, params, settings, modelRegistryRaw, signal, projectRoot)).hits;
}

/**
 * Path-A variant: returns LLM relevance verdict + timing breakdown for
 * instrumentation. Callers that need LLM-side strong cutoff (inject only
 * when verdict=="has_relevant") should use this instead of llmSearchEntries.
 * See ADR 0026 §3.1 walk-back (2026-05-28) for design rationale.
 */
export interface SearchVerdictResult {
  hits: ReturnType<typeof resultCard>[];
  relevance_verdict: "has_relevant" | "none" | "unknown";
  query: string;
  stage1DurationMs: number;
  stage2DurationMs: number;
  totalDurationMs: number;
  stage1CandidateSurface: string;
  stage2DebugSlice?: string;
}

async function llmSearchEntriesWithVerdict(
  entries: MemoryEntry[],
  params: SearchParams,
  settings: MemorySettings,
  modelRegistryRaw: unknown,
  signal?: AbortSignal,
  projectRoot?: string,
): Promise<SearchVerdictResult> {
  const t0 = Date.now();
  const rawQuery = String(params.query ?? "").trim();
  const qs = sanitizeForMemory(rawQuery);
  const query = rawQuery ? (qs.ok ? (qs.text ?? rawQuery) : `[redacted: ${qs.error}]`) : "";
  const r = await executeSearch(entries, params, settings, modelRegistryRaw, signal, projectRoot);
  return {
    hits: r.hits,
    relevance_verdict: r.verdict,
    query,
    stage1DurationMs: r.stage1Ms,
    stage2DurationMs: r.stage2Ms,
    totalDurationMs: Date.now() - t0,
    stage1CandidateSurface: r.surface,
  };
}

/**
 * ADR 0037: 检索 Facade 单入口。按 profile 应用策略(settings 覆写 + filters + 内核包装)
 * 再调内核。entries 由调用方传入(保留 entries-arg identity: dedup 的 rule-neighbor 增强集、
 * correction 的动态加载集都由调用方控)。callerFilters 仅 toolSearch(caller-overridable)用。
 * 迁移完成后 llmSearchEntries/llmSearchEntriesWithVerdict/executeSearch 将私有化, 本函数单导出。
 */
/**
 * ADR 0036 P5 query routing (dark-launch, settings.search.queryRouting).
 * 纯规则(无 LLM)精确直查: query 整体恰为某 entry 的 slug, 或匹配 ADR 编号且唯一
 * 命中 adr-NNNN-* slug → 返回该 entry。无匹配返回 null → 调用方走正常检索。
 * **永不抑制召回**: 仅在 100% 确定(精确 slug / 唯一 ADR 命中)时短路, 否则 fall-through。
 * 导出供 deterministic smoke 验证路由决策(无需 LLM)。
 */
export function routeExactLookup(query: string, entries: MemoryEntry[]): MemoryEntry | null {
  const q = (query ?? "").trim();
  if (!q) return null;
  // 1) 整体恰为某 slug(大小写不敏感)
  const ql = q.toLowerCase();
  const bySlug = entries.find((e) => String(e.slug).toLowerCase() === ql);
  if (bySlug) return bySlug;
  // 2) ADR 编号: "ADR 0035" / "adr-0035" / "adr 35" → adr-NNNN-* 唯一命中
  const m = /^adr[-\s]?(\d{1,4})$/i.exec(q);
  if (m) {
    const prefix = `adr-${m[1].padStart(4, "0")}`;
    const matches = entries.filter((e) => {
      const s = String(e.slug).toLowerCase();
      return s === prefix || s.startsWith(`${prefix}-`);
    });
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export async function runMemorySearch(
  profileName: SearchProfileName,
  query: string,
  entries: MemoryEntry[],
  settings: MemorySettings,
  modelRegistry: unknown,
  opts?: { signal?: AbortSignal; projectRoot?: string; callerFilters?: SearchFilters },
): Promise<SearchVerdictResult | ReturnType<typeof resultCard>[]> {
  const profile = SEARCH_PROFILES[profileName];
  const { search, filters, returnVerdict } = resolveProfileExecution(profile, settings, opts?.callerFilters);
  const effSettings: MemorySettings = { ...settings, search };
  const params: SearchParams = { query, filters };
  // ADR 0036 P5: toolSearch 精确直查路由(dark-launch)。命中即短路跳两次 LLM; 否则 fall-through。
  // 仅 toolSearch 适用: path-A/decide/dedup/correction 的 query 永不是裸 slug/ADR 编号。
  if (profileName === "toolSearch" && search.queryRouting) {
    const routed = routeExactLookup(query, entries);
    if (routed) {
      const cards = [resultCard(routed, 1, "exact-route (ADR 0036 P5: slug/ADR 精确直查跳 LLM)")];
      // ADR 0031 Phase 0: 精确直查也是 toolSearch 的 retrieval-hit。
      if (isUsageRecordingProfile(profileName)) recordUsage(cards.map((c) => c.slug), "retrieval_hit", effSettings, opts?.projectRoot);
      return cards;
    }
  }
  const result = returnVerdict
    ? await llmSearchEntriesWithVerdict(entries, params, effSettings, modelRegistry, opts?.signal, opts?.projectRoot)
    : await llmSearchEntries(entries, params, effSettings, modelRegistry, opts?.signal, opts?.projectRoot);
  // ADR 0031 Phase 0: 读侧 retrieval-hit 埋点 —— 仅 user-facing profile, flag+projectRoot 守卫。
  // sedimentDedup/correctionSearch(写侧 curator 操作)不计。零行为变化。
  if (isUsageRecordingProfile(profileName)) {
    const hits = Array.isArray(result) ? result : result.hits;
    recordUsage(hits.map((h) => h.slug), "retrieval_hit", effSettings, opts?.projectRoot);
  }
  return result;
}

/**
 * TEST/ORACLE ONLY — 直接暴露内核 wrapper 给 scripts/ 下的 oracle/smoke。它们需要用
 * 自定义 settings 做 stage1Skip ablation 等**内核级实验**(非“角色”语义, 不适用 profile)。
 * **生产代码(extensions/)禁止引用本导出** —— 生产唯一入口是 runMemorySearch(profile, ...)。
 * grep-guard(scripts/smoke-search-profiles.mjs)断言 extensions/ 不引用 __oracleKernel/裸 wrapper。
 */
export const __oracleKernel = { llmSearchEntries, llmSearchEntriesWithVerdict };
