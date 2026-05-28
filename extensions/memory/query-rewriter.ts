/**
 * query-rewriter — ADR 0026 §3.1 walk-back (2026-05-28) path-A stage 1.
 *
 * Replaces the original "decision-detector" stage. Instead of deciding
 * whether the user is at a decision point (binary classification that
 * the walk-back retired), this stage decides whether the message carries
 * usable intent for a memory search, and if so condenses it into a
 * focused search query.
 *
 * Failure semantics: any error (auth missing, network, parse failure,
 * timeout, unknown model) returns useful=false silently. Caller skips
 * path A this turn — no exception escapes, no user-facing surface.
 *
 * Cost shape (one LLM call per turn):
 *   - prompt template ~4KB + user message (typically <2KB) = ~6KB input
 *   - output JSON 50-200 chars
 *   - target model: v4-flash $0.14/1M → <$0.001 per call
 *   - target latency: <1.5s p50 on v4-flash (matches search Stage 1 budget)
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
    path.join(__dirname, "prompts", "query-rewriter-v1.md"),
    "utf-8",
  );
  return _cachedPrompt;
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

  // Cap query length to keep search prompt size bounded; the rewriter is
  // instructed to produce 40-200 chars, but defend against runaway output.
  const cappedQuery = query.length > 600 ? query.slice(0, 600) + "…" : query;

  return {
    useful: true,
    query: cappedQuery,
  };
}

/**
 * Top-level entry: classify + rewrite. Returns QueryRewriteResult always;
 * caller skips path A when useful=false.
 *
 * No exception escapes — all errors surface via llm_error.
 */
export async function rewriteUserMessageToSearchQuery(
  userMessage: string,
  modelRegistry: ModelRegistryLike,
  settings: RewriterSettings,
  signal?: AbortSignal,
): Promise<QueryRewriteResult> {
  const t0 = Date.now();

  // Trivial-input fast paths (no LLM call cost).
  const trimmed = (userMessage || "").trim();
  if (trimmed.length === 0) {
    return { useful: false, reason: "empty_input", llm_duration_ms: 0 };
  }
  if (trimmed.length < 4) {
    return { useful: false, reason: "input_too_short", llm_duration_ms: 0 };
  }

  const parsed = parseModelRef(settings.queryRewriterModel);
  if (!parsed) {
    return {
      useful: false,
      llm_error: `invalid queryRewriterModel: ${settings.queryRewriterModel || "<empty>"}`,
      llm_duration_ms: 0,
    };
  }
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return {
      useful: false,
      llm_error: `model not found: ${settings.queryRewriterModel}`,
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: 0,
    };
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      useful: false,
      llm_error: `auth unavailable: ${auth.error || "no api key"}`,
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: 0,
    };
  }

  // Cap input to keep prompt size bounded; for long messages the last
  // ~4KB usually carries the latest intent (any earlier prose was
  // backgrounder that the assistant LLM also has in conversation).
  const cappedInput = trimmed.length > 4000 ? "…" + trimmed.slice(-4000) : trimmed;
  const template = loadRewriterPrompt();
  const fullPrompt = `${template}\n\n---\n\n# USER MESSAGE\n\n${cappedInput}`;

  try {
    const piAi: {
      streamSimple(
        model: unknown,
        opts: { messages: unknown[] },
        config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
      ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
    } = await import("@earendil-works/pi-ai");

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
    };
  } catch (e) {
    return {
      useful: false,
      llm_error: e instanceof Error ? e.message : String(e),
      llm_model: settings.queryRewriterModel,
      llm_duration_ms: Date.now() - t0,
    };
  }
}
