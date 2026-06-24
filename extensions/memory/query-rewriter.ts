/**
 * query-rewriter — ADR 0026 §3.1 walk-back (2026-05-28) path-A stage 1.
 *
 * v2 (2026-05-28, user directive "主会话调用 memory_search 时就要给
 * 足信息，包括上下文场景、用户意图在内，不能单凭用户输入来判断"):
 * the rewriter now reads the recent conversation history as well as the
 * current user message, and emits a **context-rich query** (200-800
 * chars, multi-sentence) instead of a 40-200 char condensation. This
 * lets the downstream stage-2 ranker judge relevance with the actual
 * project / task framing in hand, not just a stripped intent fragment.
 *
 * Cost shape per call:
 *   - prompt template (v2) ~6KB + recent history (capped) ~3KB + user
 *     message ~2KB = ~11KB input
 *   - output JSON 300-1000 chars typical
 *   - target model: v4-flash $0.14/1M → ~$0.0015 per call
 *   - target latency: <2s p50 on v4-flash
 *
 * Failure semantics: any error (auth missing, network, parse failure,
 * timeout, unknown model) returns useful=false silently. Caller skips
 * path A this turn — no exception escapes, no user-facing surface.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface QueryRewriteResult {
  useful: boolean;
  query?: string;
  reason?: string;
  /** Set when the LLM call failed (network, auth, parse). Caller treats
   *  as useful=false; this is for instrumentation only. */
  llm_error?: string;
  llm_duration_ms?: number;
  llm_model?: string;
  llm_prompt_chars?: number;
  /** How many history turns the rewriter actually saw (post-cap). */
  history_turn_count?: number;
}

/** v2: rewriter accepts conversation history alongside the current message. */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

interface RewriterSettings {
  queryRewriterModel: string;
  queryRewriterTimeoutMs: number;
}

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

function parseModelRef(spec: string | undefined): { provider: string; id: string } | null {
  if (!spec) return null;
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx >= spec.length - 1) return null;
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

let _cachedPrompt: string | undefined;
function loadRewriterPrompt(): string {
  if (_cachedPrompt !== undefined) return _cachedPrompt;
  _cachedPrompt = fs.readFileSync(
    path.join(__dirname, "prompts", "query-rewriter-v2.md"),
    "utf-8",
  );
  return _cachedPrompt;
}

/**
 * Format conversation history for embedding in the rewriter prompt.
 * Each turn gets a role tag + text body, separated by blank line. Long
 * turn texts are truncated middle to preserve both start (intent) and
 * end (latest framing).
 */
function formatHistoryForPrompt(history: ConversationTurn[]): string {
  if (history.length === 0) return "(no prior conversation in this session)";
  const lines: string[] = [];
  for (const turn of history) {
    const roleTag = turn.role === "user" ? "[user]" : "[assistant]";
    let body = turn.text;
    // Cap each turn to keep total prompt size predictable.
    const MAX_TURN_CHARS = 1500;
    if (body.length > MAX_TURN_CHARS) {
      const head = Math.floor(MAX_TURN_CHARS * 0.6);
      const tail = MAX_TURN_CHARS - head - 30;
      body = body.slice(0, head) + "\n\n…[truncated]…\n\n" + body.slice(body.length - tail);
    }
    lines.push(`${roleTag}\n${body}`);
  }
  return lines.join("\n\n");
}

/**
 * Parse rewriter LLM JSON output. Tolerant of fenced / unfenced / prose-
 * wrapped JSON (same pattern as aggregator-llm.parseAggregatorOutput).
 *
 * Returns useful=false with reason="json_parse_failure" on completely
 * unparseable JSON — caller treats as skip.
 */
export function parseRewriterOutput(rawText: string): QueryRewriteResult {
  if (!rawText || rawText.trim().length === 0) {
    return { useful: false, reason: "empty_llm_output" };
  }
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(rawText);
  let jsonText: string;
  if (fenceMatch && fenceMatch[1]) {
    jsonText = fenceMatch[1].trim();
  } else {
    const first = rawText.indexOf("{");
    const last = rawText.lastIndexOf("}");
    jsonText = first >= 0 && last > first ? rawText.slice(first, last + 1) : rawText.trim();
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return {
      useful: false,
      reason: `json_parse_failure: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // The LLM is expected to output useful: true/false. Anything other
  // than true is treated as false (conservative — prefer skip path A
  // over inject noise).
  if (parsed.useful !== true) {
    return {
      useful: false,
      reason: typeof parsed.reason === "string" ? parsed.reason : "llm_marked_not_useful",
    };
  }

  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
  if (!query || query.length < 3) {
    return {
      useful: false,
      reason: "llm_marked_useful_but_query_too_short",
    };
  }

  // Cap query length to keep search prompt size bounded; the v2 rewriter
  // is instructed to produce 200-800 chars, but defend against runaway
  // output (some models pad with unnecessary explanation).
  const cappedQuery = query.length > 2000 ? query.slice(0, 2000) + "…" : query;

  return {
    useful: true,
    query: cappedQuery,
  };
}

/**
 * Top-level entry: classify + rewrite. Returns QueryRewriteResult always;
 * caller skips path A when useful=false.
 *
 * v2 (2026-05-28): accepts conversation history. The rewriter LLM sees
 * BOTH recent turns AND the current message, and produces a context-rich
 * query reflecting the actual task/project framing — not just the
 * stripped intent of one isolated message. This addresses the
 * "context-dependent message" failure mode (“刚才那个怎么办” /
 * “好就用 X” / “继续第二个”) where the user's intent is only
 * meaningful given prior turns.
 *
 * No exception escapes — all errors surface via llm_error.
 */
export async function rewriteUserMessageToSearchQuery(
  userMessage: string,
  history: ConversationTurn[],
  modelRegistry: ModelRegistryLike,
  settings: RewriterSettings,
  signal?: AbortSignal,
): Promise<QueryRewriteResult> {
  const t0 = Date.now();

  // Trivial-input fast paths (no LLM call cost). Only short the actual
  // current message; history alone (even if rich) doesn't form a turn.
  const trimmed = (userMessage || "").trim();
  if (trimmed.length === 0) {
    return { useful: false, reason: "empty_input", llm_duration_ms: 0, history_turn_count: history.length };
  }
  if (trimmed.length < 4 && history.length === 0) {
    // Very short message + no history to disambiguate.
    return { useful: false, reason: "input_too_short_no_history", llm_duration_ms: 0, history_turn_count: 0 };
  }

  const parsed = parseModelRef(settings.queryRewriterModel);
  if (!parsed) {
    return {
      useful: false,
      llm_error: `invalid queryRewriterModel: ${settings.queryRewriterModel || "<empty>"}`,
      llm_duration_ms: 0,
      history_turn_count: history.length,
    };
  }
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return {
      useful: false,
      llm_error: `model not found: ${settings.queryRewriterModel}`,
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: 0,
      history_turn_count: history.length,
    };
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      useful: false,
      llm_error: `auth unavailable: ${auth.error || "no api key"}`,
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: 0,
      history_turn_count: history.length,
    };
  }

  // Cap current message: long pastes get tail-only so the actual latest
  // intent is preserved.
  const cappedInput = trimmed.length > 4000 ? "…" + trimmed.slice(-4000) : trimmed;
  const historyText = formatHistoryForPrompt(history);
  const template = loadRewriterPrompt();
  const fullPrompt = `${template}\n\n---\n\n# RECENT CONVERSATION HISTORY (oldest → newest)\n\n${historyText}\n\n---\n\n# CURRENT USER MESSAGE\n\n${cappedInput}`;

  try {
    const piAi: {
      streamSimple(
        model: unknown,
        opts: { messages: unknown[] },
        config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
      ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
    } = await import("@earendil-works/pi-ai/compat");

    const stream = piAi.streamSimple(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: fullPrompt }] }] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
        timeoutMs: settings.queryRewriterTimeoutMs,
        maxRetries: 1,
      },
    );
    const finalMsg = await stream.result();
    if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
      return {
        useful: false,
        llm_error: finalMsg.errorMessage || finalMsg.stopReason,
        llm_model: settings.queryRewriterModel,
        llm_duration_ms: Date.now() - t0,
        llm_prompt_chars: fullPrompt.length,
      };
    }
    const rawText = (finalMsg.content ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    const parsedOut = parseRewriterOutput(rawText);
    return {
      ...parsedOut,
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: Date.now() - t0,
      llm_prompt_chars: fullPrompt.length,
      history_turn_count: history.length,
    };
  } catch (e) {
    return {
      useful: false,
      llm_error: e instanceof Error ? e.message : String(e),
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: Date.now() - t0,
      history_turn_count: history.length,
    };
  }
}
