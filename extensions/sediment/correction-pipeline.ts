/**
 * ADR 0025 P1 — correction-pipeline.ts
 *
 * Activates after runLlmExtractor completes in Lane C's tryAutoWriteLane.
 * Runs the active-correction-classifier prompt against the sanitized
 * conversation window and produces a CorrectionSignal | null.
 *
 * For now (P1 minimal): runs the classifier, writes audit, returns the
 * signal. The caller (index.ts) decides what to do with it. Staging
 * writes and curator context injection are P1 follow-ups.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeForMemory } from "./sanitizer";
import type { SedimentSettings } from "./settings";
import type { ModelRegistryLike } from "./llm-extractor";

// ── Types ─────────────────────────────────────────────────────────────

export interface CorrectionSignal {
  signal_found: boolean;
  typing?: "durable" | "task-local" | "debug";
  scope_description?: string;
  correction_intent?: string;
  confidence?: number;
  step_1_quote?: string;
  step_6_self_critique?: string;
  step_7_self_rating?: {
    quote_faithfulness: number;
    alternative_consideration: number;
    self_critique_concreteness: number;
  };
  reasoning?: string; // when signal_found=false
}

export interface CorrectionPipelineResult {
  ok: boolean;
  model: string;
  signal: CorrectionSignal | null;
  error?: string;
  durationMs: number;
  /** Raw LLM response text, sanitized for audit. */
  rawText?: string;
  rawTextTruncated?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

let _classifierPromptCache: string | null = null;

function loadClassifierPrompt(): string {
  if (_classifierPromptCache) return _classifierPromptCache;
  // Prompt lives alongside this module in prompts/
  const promptPath = path.join(__dirname, "prompts", "active-correction-classifier-v1.md");
  _classifierPromptCache = fs.readFileSync(promptPath, "utf-8");
  return _classifierPromptCache;
}

function buildClassifierPrompt(windowText: string): string {
  const prompt = loadClassifierPrompt();
  return [
    prompt,
    "",
    "Transcript window:",
    "<<<PI_SEDIMENT_WINDOW",
    windowText,
    "PI_SEDIMENT_WINDOW>>>",
  ].join("\n");
}

function parseCorrectionSignal(raw: string): CorrectionSignal | null {
  // Try JSON fence first
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      signal_found: parsed.signal_found ?? false,
      typing: parsed.typing,
      scope_description: parsed.scope_description,
      correction_intent: parsed.correction_intent,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      step_1_quote: parsed.step_1_quote,
      step_6_self_critique: parsed.step_6_self_critique,
      step_7_self_rating: parsed.step_7_self_rating,
      reasoning: parsed.reasoning,
    };
  } catch {
    return null;
  }
}

function sanitizeAuditText(text: string | undefined, maxLen: number): string {
  if (!text) return "";
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

// ── Main ──────────────────────────────────────────────────────────────

export async function runCorrectionClassifier(
  windowText: string,
  deps: {
    settings: SedimentSettings;
    modelRegistry: ModelRegistryLike;
    signal?: AbortSignal;
  },
): Promise<CorrectionPipelineResult> {
  const start = Date.now();

  // Pre-sanitize: same boundary as runLlmExtractor.
  const sanitizeResult = sanitizeForMemory(windowText);
  if (!sanitizeResult.ok) {
    return { ok: false, model: deps.settings.extractorModel, signal: null, error: "pre-sanitize failed", durationMs: Date.now() - start };
  }
  const sanitizedWindowText = sanitizeResult.text ?? windowText;

  const modelRef = deps.settings.extractorModel; // reuse extractor model for P1

  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    return { ok: false, model: modelRef, signal: null, error: "invalid model ref", durationMs: Date.now() - start };
  }

  const model = deps.modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return { ok: false, model: modelRef, signal: null, error: "model not found in registry", durationMs: Date.now() - start };
  }

  const auth = await deps.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { ok: false, model: modelRef, signal: null, error: auth.error ?? "auth unavailable", durationMs: Date.now() - start };
  }

  const prompt = buildClassifierPrompt(sanitizedWindowText);

  let rawText = "";
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
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }],
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: deps.signal,
        timeoutMs: Math.min(deps.settings.curatorTimeoutMs, 60_000),
        maxRetries: 0, // classifier is best-effort; don't retry
      },
    );

    const result = await stream.result();
    if (result.errorMessage) {
      return {
        ok: false, model: modelRef, signal: null,
        error: sanitizeAuditText(result.errorMessage, 500),
        durationMs: Date.now() - start,
      };
    }
    rawText = result.content?.map(c => c.type === "text" ? c.text : "").join("") ?? "";
  } catch (e: any) {
    return {
      ok: false, model: modelRef, signal: null,
      error: sanitizeAuditText(e?.message ?? "classifier threw", 500),
      durationMs: Date.now() - start,
    };
  }

  const signal = parseCorrectionSignal(rawText);
  const truncated = rawText.length > 4000;
  const auditRaw = truncated ? rawText.slice(0, 4000) : rawText;

  return {
    ok: true,
    model: modelRef,
    signal,
    durationMs: Date.now() - start,
    rawText: auditRaw,
    rawTextTruncated: truncated,
  };
}
