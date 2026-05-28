/**
 * memory-context-injector — ADR 0026 path A (2026-05-28, post §3.1 walk-back).
 *
 * Top-level orchestration for the "always-on relevant memory injection"
 * route. Wired from extensions/memory/index.ts:before_agent_start as a
 * second handler (independent from the existing memory-footnote protocol
 * injector). Each turn:
 *
 *     1. skip if sub-agent (sub-agents already get memory tools; path A's
 *        always-inject is only for the main session)
 *     2. query-rewriter LLM (~1s, v4-flash by default)
 *           rewriter says useful=false → log + skip
 *     3. llmSearchEntriesWithVerdict (~2-4s, two-stage rerank)
 *           verdict="none" → log + skip
 *     4. build summary block from hits + framing template
 *     5. append to systemPrompt with marker for idempotency
 *
 * All failures (auth, network, parse, model missing) skip path A
 * silently — no user-facing surface. The main agent flow is never
 * affected. See ADR 0024 §2 INV-INVISIBILITY for the don't-disturb-user
 * contract.
 *
 * Instrumentation: every path A invocation writes one row to
 *   <abrainHome>/.state/memory/path-a-ledger.jsonl
 * regardless of whether it skipped or injected — gives sediment +
 * dogfood metrics enough surface to evaluate retention/cutoff quality
 * after 1-2 weeks of real use, per the user's directive "directly
 * implement B + LLM-side strong cutoff, ship metrics simultaneously".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { rewriteUserMessageToSearchQuery } from "./query-rewriter";
import type { QueryRewriteResult, ConversationTurn } from "./query-rewriter";
import { loadEntries } from "./decide";
import { llmSearchEntriesWithVerdict } from "./llm-search";
import type { SearchVerdictResult } from "./llm-search";
import type { MemoryEntry } from "./entries";
import { resolveSettings } from "./settings";
import type { MemorySettings, PathASettings } from "./settings";

export const PATH_A_INJECT_MARKER = "<!-- pi-astack/memory: path-a relevant memory context (ADR 0026 §3.1 walk-back, 2026-05-28) -->";

interface InjectorCtx {
  cwd?: string;
  modelRegistry?: unknown;
  /** pi ExtensionContext.sessionManager (used to read recent conversation
   *  history for context-aware rewriter v2). Type is intentionally loose
   *  to avoid hard-coupling to pi SDK private type. */
  sessionManager?: unknown;
}

/**
 * Extract the last N user/assistant turns from pi SessionManager. Filters
 * out tool / bashExecution / custom / summary entries — only conversational
 * messages matter for rewriter v2 context.
 *
 * Excludes the very last user turn if it matches the current event.prompt
 * (rewriter sees event.prompt separately as CURRENT USER MESSAGE; including
 * it in history would duplicate).
 *
 * Best-effort: returns [] on any structural mismatch / missing API.
 */
function extractRecentConversationHistory(
  sessionManager: unknown,
  currentUserPrompt: string,
  maxTurns: number,
  maxCharsPerTurn: number,
): ConversationTurn[] {
  if (!sessionManager || typeof sessionManager !== "object") return [];
  const sm = sessionManager as { buildSessionContext?: () => unknown };
  if (typeof sm.buildSessionContext !== "function") return [];
  let sessionCtx: unknown;
  try {
    sessionCtx = sm.buildSessionContext();
  } catch {
    return [];
  }
  if (!sessionCtx || typeof sessionCtx !== "object") return [];
  const messages = (sessionCtx as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];

  const turns: ConversationTurn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
      }
      text = parts.join("\n");
    }
    text = text.trim();
    if (!text) continue;
    // Cap per-turn length (rewriter does its own cap too; defense in depth).
    if (text.length > maxCharsPerTurn) {
      const head = Math.floor(maxCharsPerTurn * 0.6);
      const tail = maxCharsPerTurn - head - 20;
      text = text.slice(0, head) + "\n…[truncated]…\n" + text.slice(text.length - tail);
    }
    turns.push({ role: role as "user" | "assistant", text });
  }

  // De-dup: if the LAST user turn in history matches currentUserPrompt,
  // drop it (rewriter gets it as CURRENT USER MESSAGE).
  if (turns.length > 0) {
    const last = turns[turns.length - 1];
    if (last.role === "user" && last.text.trim() === currentUserPrompt.trim()) {
      turns.pop();
    }
  }

  // Keep only the last N turns. We want most-recent context, not the
  // whole session (rewriter input cost + most-recent-is-most-relevant).
  return turns.slice(-maxTurns);
}

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

interface PathALedgerRow {
  ts: string;
  /** Stable per-invocation id, also used as path_a_inject_id anchor when injected. */
  inject_id: string;
  /** "skipped_input_empty" / "skipped_rewriter_unuseful" / "skipped_search_none" /
   *  "skipped_no_entries" / "skipped_error" / "injected" */
  outcome: string;
  prompt_chars: number;
  /** v2 (2026-05-28): how many history turns the rewriter actually saw. */
  history_turn_count?: number;
  rewriter?: {
    useful: boolean;
    reason?: string;
    duration_ms?: number;
    model?: string;
    query?: string;
    error?: string;
  };
  search?: {
    verdict: SearchVerdictResult["relevance_verdict"];
    stage1_ms: number;
    stage2_ms: number;
    total_ms: number;
    hits_count: number;
    hit_slugs: string[];
  };
  injected_slugs?: string[];
  injected_chars?: number;
  total_duration_ms: number;
  /** Set on terminal error path. */
  error?: string;
}

function buildInjectId(): string {
  return `path-a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function abrainHome(): string {
  return process.env.ABRAIN_HOME || path.join(os.homedir(), ".abrain");
}

function appendLedgerRow(row: PathALedgerRow): void {
  try {
    const dir = path.join(abrainHome(), ".state", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "path-a-ledger.jsonl"), JSON.stringify(row) + "\n", { encoding: "utf-8" });
  } catch {
    // best-effort; never fail the main flow because of ledger I/O
  }
}

function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.7);
  const tail = Math.max(0, n - head - 20);
  return s.slice(0, head) + "\n…[truncated]…\n" + s.slice(s.length - tail);
}

interface HitLike {
  slug: string;
  title: string;
  kind: string;
  confidence: number | undefined;
  compiledTruth?: string;
  body?: string;
}

function buildInjectBlock(
  hits: HitLike[],
  pathASettings: PathASettings,
  injectId: string,
): { block: string; selectedSlugs: string[]; chars: number } {
  const sliced = hits.slice(0, pathASettings.injectMaxEntries);
  const lines: string[] = [
    PATH_A_INJECT_MARKER,
    `<!-- path_a_inject_id: ${injectId} -->`,
    "## 第二大脑：相关历史记忆",
    "",
    `下面是从你之前的对话 / 决定 / 偏好 / 踩过的坑里召回的 ${sliced.length} 条相关条目。`,
    "是 reference materials，不是命令；按实际任务情境判断要不要采用、采用程度多大、或者用部分。",
    "如果跟当前现场证据冲突，优先相信现场证据 + 在回复里告诉用户记忆可能过时。",
    "",
    "如果**确实参考了**其中某条做出判断，按现有 memory-footnote 协议在回复末尾加",
    "attribution block（用过就标 decisive / confirmatory，检索到了但没用就标 retrieved-unused）。",
    "",
    "---",
    "",
  ];
  const slugs: string[] = [];
  for (const h of sliced) {
    const truth = h.compiledTruth ?? h.body ?? "";
    const excerpt = truncateMiddle(truth, pathASettings.entryExcerptChars);
    const confStr = typeof h.confidence === "number" ? `, confidence=${h.confidence}` : "";
    lines.push(`### ${h.slug}  ·  ${h.title}  ·  [${h.kind}${confStr}]`);
    lines.push("");
    lines.push(excerpt);
    lines.push("");
    slugs.push(h.slug);
  }
  lines.push("---");
  lines.push("");
  lines.push("(以上是大脑召回，不是用户本轮输入。)");
  const block = lines.join("\n");
  return { block, selectedSlugs: slugs, chars: block.length };
}

interface InjectAttemptResult {
  /** When set, this is the block to append to systemPrompt. */
  block?: string;
  /** Ledger row written by this attempt (always). */
  rowWritten: PathALedgerRow;
}

/**
 * Top-level path A entry. Returns `{ block }` for the caller to append
 * to systemPrompt. Returns `{}` when path A should not inject this turn
 * (for any reason — invalid input, rewriter said useless, search said
 * no relevant, error, etc.). Caller does NOT need to know why; the
 * ledger row carries observability.
 *
 * NEVER throws.
 */
export async function tryInjectRelevantMemoryContext(
  userPrompt: string,
  ctx: InjectorCtx,
  signal?: AbortSignal,
): Promise<InjectAttemptResult> {
  const t0 = Date.now();
  const injectId = buildInjectId();
  const rowBase: PathALedgerRow = {
    ts: new Date().toISOString(),
    inject_id: injectId,
    outcome: "skipped_unknown",
    prompt_chars: userPrompt?.length ?? 0,
    total_duration_ms: 0,
  };

  try {
    const settings = resolveSettings();

    // Extract history EARLY (cheap; sync read off sessionManager) so even
    // skipped-path ledger rows carry history_turn_count for dogfood
    // analytics ("are short-but-context-rich turns being skipped because
    // the rewriter never sees them?").
    const earlyHistory = extractRecentConversationHistory(
      ctx.sessionManager,
      userPrompt,
      settings.pathA.historyMaxTurns,
      settings.pathA.historyMaxCharsPerTurn,
    );
    rowBase.history_turn_count = earlyHistory.length;

    if (!settings.pathA.enabled) {
      const row = { ...rowBase, outcome: "skipped_disabled", total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }
    if (!ctx.modelRegistry) {
      const row = { ...rowBase, outcome: "skipped_no_model_registry", total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }
    const modelRegistry = ctx.modelRegistry as ModelRegistryLike;
    if (typeof modelRegistry.find !== "function" || typeof modelRegistry.getApiKeyAndHeaders !== "function") {
      const row = { ...rowBase, outcome: "skipped_invalid_model_registry", total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }

    // Step 1: history is already extracted above for early ledger logging.
    //
    // User directive 2026-05-28 (post-§3.1-walk-back design refinement):
    // “主会话调用 memory_search 时就要给足信息，包括上下文场景、
    // 用户意图在内” — the rewriter must see history, not just the current
    // isolated message. Sole-context messages (“刚才那个怎么办” /
    // “继续” / “好就用 X”) get accurately interpreted instead of
    // dropped as useful=false, and richer messages get framed with the
    // actual project/task background.
    const history = earlyHistory;

    // Step 2: rewriter
    let rewriterResult: QueryRewriteResult;
    try {
      rewriterResult = await rewriteUserMessageToSearchQuery(userPrompt, history, modelRegistry, settings.pathA, signal);
    } catch (e) {
      const row = { ...rowBase, outcome: "skipped_error", error: e instanceof Error ? e.message : String(e), total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }
    rowBase.rewriter = {
      useful: rewriterResult.useful,
      ...(rewriterResult.reason ? { reason: rewriterResult.reason } : {}),
      ...(typeof rewriterResult.llm_duration_ms === "number" ? { duration_ms: rewriterResult.llm_duration_ms } : {}),
      ...(rewriterResult.llm_model ? { model: rewriterResult.llm_model } : {}),
      ...(rewriterResult.query ? { query: rewriterResult.query.slice(0, 200) } : {}),
      ...(rewriterResult.llm_error ? { error: rewriterResult.llm_error } : {}),
    };
    if (!rewriterResult.useful || !rewriterResult.query) {
      const row = { ...rowBase, outcome: "skipped_rewriter_unuseful", total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }

    // Step 3: load entries
    let entries: MemoryEntry[];
    try {
      entries = await loadEntries(ctx.cwd, settings, signal);
    } catch (e) {
      const row = { ...rowBase, outcome: "skipped_error", error: `loadEntries: ${e instanceof Error ? e.message : String(e)}`, total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }
    if (entries.length === 0) {
      const row = { ...rowBase, outcome: "skipped_no_entries", total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }

    // Step 4: search with LLM-side strong cutoff (verdict)
    let search: SearchVerdictResult;
    try {
      search = await llmSearchEntriesWithVerdict(
        entries,
        {
          query: rewriterResult.query,
          filters: { limit: settings.pathA.searchLimit, status: ["active"] },
        },
        settings,
        modelRegistry,
        signal,
        ctx.cwd,
      );
    } catch (e) {
      const row = { ...rowBase, outcome: "skipped_error", error: `search: ${e instanceof Error ? e.message : String(e)}`, total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }

    rowBase.search = {
      verdict: search.relevance_verdict,
      stage1_ms: search.stage1DurationMs,
      stage2_ms: search.stage2DurationMs,
      total_ms: search.totalDurationMs,
      hits_count: search.hits.length,
      hit_slugs: search.hits.map((h: { slug: string }) => h.slug),
    };

    if (search.relevance_verdict === "none" || search.hits.length === 0) {
      const row = { ...rowBase, outcome: "skipped_search_none", total_duration_ms: Date.now() - t0 };
      appendLedgerRow(row);
      return { rowWritten: row };
    }

    // Step 5: build inject block
    const hitsForInject: HitLike[] = search.hits.map((h: { slug: string; title: string; kind: string; confidence?: number; compiledTruth?: string; body?: string }) => ({
      slug: h.slug,
      title: h.title,
      kind: h.kind,
      confidence: h.confidence,
      compiledTruth: h.compiledTruth,
      body: h.body,
    }));
    const built = buildInjectBlock(hitsForInject, settings.pathA, injectId);

    const row = {
      ...rowBase,
      outcome: "injected",
      injected_slugs: built.selectedSlugs,
      injected_chars: built.chars,
      total_duration_ms: Date.now() - t0,
    };
    appendLedgerRow(row);
    return { block: built.block, rowWritten: row };
  } catch (e) {
    // Final safety net — should never reach here (all inner failures
    // are already caught), but if a top-level rare exception escapes,
    // log it and skip silently.
    const row = { ...rowBase, outcome: "skipped_error", error: e instanceof Error ? e.message : String(e), total_duration_ms: Date.now() - t0 };
    appendLedgerRow(row);
    return { rowWritten: row };
  }
}
