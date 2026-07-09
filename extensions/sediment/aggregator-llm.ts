/**
 * sediment aggregator-llm — ADR 0025 §4.3 Phase C.2 wiring.
 *
 * Bridges the deterministic v0.2 aggregator (aggregator.ts) and the
 * v1 skeptical-historian LLM prompt
 * (prompts/aggregator-skeptical-historian-v1.md).
 *
 * Flow:
 *   v0.2 mechanical AggregatorSummary is computed first by
 *   runSedimentAggregator() → contains 9 input feeds the v1 prompt
 *   needs (raw_distribution, structural_context, counterfactual
 *   excerpts, prior runs, classifier health w/ trend, p15 watchdog,
 *   and evolution_hypotheses self-state).
 *   This module serializes those feeds into prompt context, invokes
 *   the LLM, parses strict JSON output, and on any failure emits a
 *   `degraded_to_mechanical: true` row per Phase A consensus C2.
 *
 * Architectural invariants (enforced here):
 *   - Schema is INFRA serialization (C6): parse failure → degraded
 *     fallback, NO retry-LLM-to-fix-JSON.
 *   - Output is audit-only (C8): caller writes ledger row, never
 *     surfaces to user push channels.
 *   - LLM is independent skeptical historian (C1): mechanical_advisories
 *     are RAW SIGNAL in the prompt, the LLM may discard the entire
 *     list. We pass them in but don't pre-judge.
 *   - Backward compat: this module is opt-in. aggregator.ts continues
 *     to run the v0.2 mechanical path; runAggregatorLlmPass() is a
 *     separate entry point called by the orchestration layer (Phase
 *     C.3 wiring in sediment/index.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AggregatorSummary } from "./aggregator";
import type { SedimentSettings } from "./settings";
import { auditStreamSimple } from "../_shared/llm-audit";
import type { ModelRegistryLike } from "./llm-extractor";
import { sanitizeForMemory } from "./sanitizer";

/**
 * v1 prompt output schema. Mirrors the JSON shape declared in
 * extensions/sediment/prompts/aggregator-skeptical-historian-v1.md §5.
 *
 * Schema field absence does NOT gate downstream behavior (Phase A C6).
 * All fields are tolerant: missing arrays default to []; missing
 * scalars default to safe values.
 */
/**
 * Outcome→Entry feedback edge (M3). An AFFIRMATIVE proposal to change a durable
 * entry's standing, attached to a PROMOTED entry advisory (the channel where the
 * LLM upholds a staleness/echo suspicion). NEVER derived from demoted_signals
 * (that channel EXONERATES). Observation only: the deferred, gated M4/M5 executor
 * is the sole consumer; M3 never writes durable memory (prompt §8).
 */
export interface LifecycleProposal {
  op: "contest" | "archive" | "supersede";
  reason: "affirm_stale" | "affirm_superseded" | "affirm_echo_chamber";
  evidence_type?: "superseded_by" | "contradicted" | "version_stale";
  /** §4.2 INDEPENDENT evidence (user correction / contradiction by a newer entry /
   *  version-domain staleness / reviewer content mismatch) — NEVER retrieved-unused alone. */
  independent_evidence: string;
  falsifier: string;
}

export interface PromotedAdvisory {
  kind: string;
  severity: "info" | "warning" | "critical";
  slug?: string;
  message: string;
  reasoning: string;
  falsifier: string;
  evidence_quotes: string[];
  /** Optional affirmative lifecycle proposal (M3). Present only when the LLM
   *  affirmatively concludes the entry should change standing WITH §4.2
   *  independent evidence. Consumed solely by the deferred gated executor. */
  lifecycle_proposal?: LifecycleProposal;
}

export interface DemotedSignal {
  kind: string;
  slug?: string;
  /** Evolution-ledger key; required by the prompt when demoting a slug-less evolution_hypothesis. */
  key?: string;
  reason: string;
}

export interface AcknowledgmentEntry {
  kind: string;
  slug?: string;
  /** Evolution-ledger key; required by the prompt when acknowledging a slug-less evolution_hypothesis. */
  key?: string;
  status: "still_acknowledged" | "withdraw_acknowledgment" | "no_change";
  reason: string;
}

export interface TrendObservation {
  dimension: string;
  current: number;
  baseline: number;
  delta: number;
  interpretation: string;
}

export interface SilenceAuditEntry {
  candidate: string;
  evidence_discounted: string;
  reason_dropped: string;
}

export interface PromotionAuditEntry {
  kind: string;
  slug?: string;
  strongest_reason_not_to_promote: string;
  why_still_promote: string;
  anchor_evidence: string;
}

export interface PromptNativeOutput {
  promoted_advisories: PromotedAdvisory[];
  demoted_signals: DemotedSignal[];
  previous_acknowledgments: AcknowledgmentEntry[];
  trend_observations: TrendObservation[];
  reasoning_quality_self_check: {
    silence_audit: SilenceAuditEntry[];
    promotion_audit: PromotionAuditEntry[];
    falsifiers_named_count: number;
    disagreements_with_prior_runs: number;
    would_propose_if_no_praise: boolean;
  };
  /** ADR 0031 Phase 1B(decay shadow, optional)。正交于 promoted/demoted 的独立
   *  decay 评估列表;**保留 raw**(不规范化/不强制 §4.2)供下游 audit 捕获 prompt
   *  违规, normalize 在 writeDecayShadow 写时做。prompt 未产出(forgetting.enabled off)时缺失。 */
  entry_decay_assessments?: Record<string, unknown>[];
}

/**
 * Returned by runAggregatorLlmPass. Either:
 *  - `prompt_native` populated + `degraded` false → LLM call succeeded
 *  - `prompt_native` undefined + `degraded` true → fall back to v0.2;
 *    `degraded_reason` describes why
 */
export interface AggregatorLlmResult {
  prompt_native?: PromptNativeOutput;
  degraded: boolean;
  degraded_reason?: string;
  llm_duration_ms?: number;
  llm_model?: string;
  prompt_char_count?: number;
  raw_text_preview?: string;
}

// ── Prompt loading ────────────────────────────────────────────────────

let _cachedPrompt: string | undefined;
function promptPath(): string {
  // Resolve relative to this compiled module — match the pattern used by
  // correction-pipeline.ts (also __dirname-based). pi loads extensions via
  // jiti that transpiles to CJS, so __dirname is the portable choice.
  // `import.meta.url` does NOT work under jiti CJS transpile (verified
  // via smoke-memory-sediment.mjs ts.transpileModule strict-parse).
  return path.join(__dirname, "prompts", "aggregator-skeptical-historian-v1.md");
}

export function loadAggregatorPrompt(): string {
  if (_cachedPrompt !== undefined) return _cachedPrompt;
  try {
    _cachedPrompt = fs.readFileSync(promptPath(), "utf-8");
    return _cachedPrompt;
  } catch (e) {
    throw new Error(`aggregator v1 prompt not loadable at ${promptPath()}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let _cachedDecayFragment: string | undefined;
/** ADR 0031 Phase 1B: decay-shadow 指令片段(仅 forgetting.enabled on 时拼接到 prompt 尾)。 */
export function loadDecayShadowFragment(): string {
  if (_cachedDecayFragment !== undefined) return _cachedDecayFragment;
  _cachedDecayFragment = fs.readFileSync(path.join(__dirname, "prompts", "aggregator-decay-shadow-v1.md"), "utf-8");
  return _cachedDecayFragment;
}

/** 组装 fullPrompt 的两半(pre-sanitize, 纯函数可单测)。decay context 缺省 → prompt/input
 *  与基线**逐字节相同**(零行为变化);提供 → 拼接 decay 指令片段 + telemetry 上下文块。 */
export function buildAggregatorFullPromptParts(
  summary: AggregatorSummary,
  decayCtx?: unknown,
): { prompt: string; input: string } {
  let prompt = loadAggregatorPrompt();
  let input = buildAggregatorPromptInput(summary);
  if (decayCtx !== undefined && decayCtx !== null) {
    prompt = `${prompt}\n\n${loadDecayShadowFragment()}`;
    input = `${input}\n\n## ENTRY DECAY TELEMETRY (ADR 0031 Phase 1B shadow context)\n\n\`\`\`json\n${JSON.stringify(decayCtx, null, 2)}\n\`\`\`\n`;
  }
  return { prompt, input };
}

// ── Context assembly ──────────────────────────────────────────────────

/**
 * Pack the AggregatorSummary into a single LLM-readable INPUT block.
 * The prompt itself (loaded by loadAggregatorPrompt) provides Steps,
 * bias cautions, output schema, examples. This block provides the data.
 *
 * Sanitization: the summary already passed through internal helpers
 * that only quote user-typed strings (counterfactuals), not raw turn
 * content. We still pass the assembled prompt through sanitizeForMemory
 * as belt-and-suspenders before LLM call (matches correction-pipeline
 * and curator hygiene).
 */
export function buildAggregatorPromptInput(summary: AggregatorSummary): string {
  // Whitelist projection: pass only the 9 input feeds the v1 prompt
  // expects (plus minimal context fields). Avoid leaking unrelated
  // internal fields that may grow over time.
  const inputContext = {
    // Metadata for cross-run identification
    ts: summary.ts,
    project_root: summary.project_root,
    window_days: summary.window_days,
    // Feed 1: mechanical suspicion signals (renamed in prompt context)
    mechanical_suspicion_signals: summary.advisories,
    // Feed 2: raw distribution (C9)
    raw_distribution_summary: summary.raw_distribution ?? null,
    // Feed 3: outcome counterfactual excerpts (C5)
    outcome_counterfactual_excerpts: summary.outcome_counterfactual_excerpts ?? [],
    // Feed 4: structural context (D4)
    structural_context: summary.structural_context ?? [],
    // Feed 5: prior aggregator runs (C3)
    prior_aggregator_summaries: summary.prior_aggregator_runs ?? [],
    // Feed 6: classifier health window incl. trend
    classifier_health_window: summary.classifier_health ?? null,
    // Feed 7: per-turn cost rollup
    per_turn_cost_rollup: summary.per_turn_cost,
    // Feed 8: P1.5 watchdog signals (C4)
    p15_watchdog_signals: summary.p15_watchdog_signals ?? null,
    // Feed 9: L1 evolution self-state from previous prompt-native runs.
    evolution_hypotheses: summary.evolution_hypotheses ?? null,
    // Auxiliary observability (not strictly required by prompt, but
    // cheap to include for self-describing audit rows):
    aux_audit_rollup: summary.audit,
    aux_outcome_rollup: summary.outcome,
    aux_staging_rollup: summary.staging,
    aux_search_rollup: summary.search,
  };

  const json = JSON.stringify(inputContext, null, 2);
  return [
    "# INPUT FEED",
    "",
    "Below is the deterministic v0.2 aggregator summary for this run.",
    "All 9 input feeds defined in the prompt \u00a72 are present (any may be",
    "empty or null \u2014 see prompt edge-case section for handling).",
    "",
    "```json",
    json,
    "```",
  ].join("\n");
}

// ── LLM invocation ────────────────────────────────────────────────────

interface ParseModelRef {
  provider: string;
  id: string;
}

function parseModelRef(spec: string | undefined): ParseModelRef | null {
  if (!spec) return null;
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx >= spec.length - 1) return null;
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

async function invokeAggregatorLlm(
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
  fullPrompt: string,
  signal?: AbortSignal,
): Promise<{ rawText: string; model: string; durationMs: number }> {
  const t0 = Date.now();
  const modelSpec = settings.aggregatorModel || settings.curatorModel;
  const parsed = parseModelRef(modelSpec);
  if (!parsed) throw new Error(`invalid aggregator model spec: ${modelSpec || "<empty>"}; expected provider/model`);
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) throw new Error(`aggregator model not found in registry: ${modelSpec}`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`aggregator auth unavailable: ${auth.error || "missing api key"}`);

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai/compat");

  const finalMsg = await auditStreamSimple(
    process.cwd(),
    { module: "sediment", operation: "aggregator_llm", model_ref: modelSpec, prompt_chars: fullPrompt.length },
    piAi,
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: fullPrompt }] }] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      timeoutMs: settings.aggregatorTimeoutMs ?? settings.curatorTimeoutMs,
      // Phase C round-2 fix (GPT-5.5 P2-1): transport-level retries from
      // settings.aggregatorMaxRetries (default 1). MUST stay scoped to HTTP
      // transport blips — prompt-level JSON repair retries remain forbidden
      // per v1 prompt §5 C6.
      maxRetries: settings.aggregatorMaxRetries ?? 1,
    },
  );
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(finalMsg.errorMessage || finalMsg.stopReason);
  }
  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error("aggregator LLM returned empty text");
  return { rawText, model: modelSpec, durationMs: Date.now() - t0 };
}

// ── JSON parsing (tolerant) ───────────────────────────────────────────

/**
 * Extract the first ```json ... ``` fence from rawText, or fall back to
 * the entire text if no fence present (some models return bare JSON).
 */
function extractJsonBlock(rawText: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(rawText);
  if (fence && fence[1]) return fence[1].trim();
  // Try to find the first balanced { ... } block at top level.
  const first = rawText.indexOf("{");
  const last = rawText.lastIndexOf("}");
  if (first >= 0 && last > first) return rawText.slice(first, last + 1);
  return rawText.trim();
}

/**
 * Parse LLM rawText into PromptNativeOutput. Tolerant of missing fields
 * (defaults arrays to []; defaults reasoning_quality_self_check to a
 * minimal shape). Throws only on completely unparseable JSON, which
 * triggers the degraded fallback in the caller.
 */
export function parseAggregatorOutput(rawText: string): PromptNativeOutput {
  const block = extractJsonBlock(rawText);
  const parsed = JSON.parse(block) as Record<string, unknown>;

  const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  // M3: validate the optional affirmative lifecycle proposal. Drop (return
  // undefined) when malformed or when §4.2 evidence/falsifier are missing — a
  // proposal without independent evidence must NOT survive (no usage-only demotion).
  const parseLifecycleProposal = (v: unknown): LifecycleProposal | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const p = v as Record<string, unknown>;
    const op = p.op === "contest" || p.op === "archive" || p.op === "supersede" ? p.op : undefined;
    const reason = p.reason === "affirm_stale" || p.reason === "affirm_superseded" || p.reason === "affirm_echo_chamber" ? p.reason : undefined;
    const evidenceType = p.evidence_type === "superseded_by" || p.evidence_type === "contradicted" || p.evidence_type === "version_stale" ? p.evidence_type : undefined;
    if (p.evidence_type !== undefined && !evidenceType) return undefined;
    const ev = typeof p.independent_evidence === "string" ? p.independent_evidence.trim() : "";
    const fal = typeof p.falsifier === "string" ? p.falsifier.trim() : "";
    if (!op || !reason || !ev || !fal) return undefined;
    if (op === "archive" && reason === "affirm_stale" && !evidenceType) return undefined;
    return { op, reason, ...(evidenceType ? { evidence_type: evidenceType } : {}), independent_evidence: ev, falsifier: fal };
  };
  const promoted = asArray<Record<string, unknown>>(parsed.promoted_advisories).map((a): PromotedAdvisory => {
    const proposal = parseLifecycleProposal(a.lifecycle_proposal);
    return {
      kind: String(a.kind ?? "unknown"),
      severity: (a.severity === "critical" || a.severity === "info") ? a.severity : "warning",
      ...(typeof a.slug === "string" ? { slug: a.slug } : {}),
      message: String(a.message ?? ""),
      reasoning: String(a.reasoning ?? ""),
      falsifier: String(a.falsifier ?? ""),
      evidence_quotes: asArray<string>(a.evidence_quotes).filter((s): s is string => typeof s === "string"),
      ...(proposal ? { lifecycle_proposal: proposal } : {}),
    };
  });
  const demoted = asArray<Record<string, unknown>>(parsed.demoted_signals).map((a): DemotedSignal => ({
    kind: String(a.kind ?? "unknown"),
    ...(typeof a.slug === "string" ? { slug: a.slug } : {}),
    ...(typeof a.key === "string" ? { key: a.key } : {}),
    reason: String(a.reason ?? ""),
  }));
  const acks = asArray<Record<string, unknown>>(parsed.previous_acknowledgments).map((a): AcknowledgmentEntry => ({
    kind: String(a.kind ?? "unknown"),
    ...(typeof a.slug === "string" ? { slug: a.slug } : {}),
    ...(typeof a.key === "string" ? { key: a.key } : {}),
    status: (a.status === "still_acknowledged" || a.status === "withdraw_acknowledgment" || a.status === "no_change") ? a.status : "no_change",
    reason: String(a.reason ?? ""),
  }));
  const trends = asArray<Record<string, unknown>>(parsed.trend_observations).map((a): TrendObservation => ({
    dimension: String(a.dimension ?? ""),
    current: typeof a.current === "number" ? a.current : Number(a.current) || 0,
    baseline: typeof a.baseline === "number" ? a.baseline : Number(a.baseline) || 0,
    delta: typeof a.delta === "number" ? a.delta : Number(a.delta) || 0,
    interpretation: String(a.interpretation ?? ""),
  }));
  const rqsc = (parsed.reasoning_quality_self_check ?? {}) as Record<string, unknown>;
  const reasoning_quality_self_check = {
    silence_audit: asArray<Record<string, unknown>>(rqsc.silence_audit).map((a): SilenceAuditEntry => ({
      candidate: String(a.candidate ?? ""),
      evidence_discounted: String(a.evidence_discounted ?? ""),
      reason_dropped: String(a.reason_dropped ?? ""),
    })),
    promotion_audit: asArray<Record<string, unknown>>(rqsc.promotion_audit).map((a): PromotionAuditEntry => ({
      kind: String(a.kind ?? "unknown"),
      ...(typeof a.slug === "string" ? { slug: a.slug } : {}),
      strongest_reason_not_to_promote: String(a.strongest_reason_not_to_promote ?? ""),
      why_still_promote: String(a.why_still_promote ?? ""),
      anchor_evidence: String(a.anchor_evidence ?? ""),
    })),
    falsifiers_named_count: typeof rqsc.falsifiers_named_count === "number" ? rqsc.falsifiers_named_count : 0,
    disagreements_with_prior_runs: typeof rqsc.disagreements_with_prior_runs === "number" ? rqsc.disagreements_with_prior_runs : 0,
    would_propose_if_no_praise: rqsc.would_propose_if_no_praise === true,
  };

  // ADR 0031 Phase 1B: 容忍解析正交 decay 评估(保留 raw 供 audit;缺失 → 字段省略)。
  const entry_decay_assessments = asArray<Record<string, unknown>>(parsed.entry_decay_assessments);

  return {
    promoted_advisories: promoted,
    demoted_signals: demoted,
    previous_acknowledgments: acks,
    trend_observations: trends,
    reasoning_quality_self_check,
    ...(entry_decay_assessments.length ? { entry_decay_assessments } : {}),
  };
}

// ── Top-level entry ───────────────────────────────────────────────────

/**
 * Run the v1 LLM pass over an already-computed AggregatorSummary.
 *
 * Returns `degraded: true` on any failure (model resolution, auth,
 * LLM error, parse failure). Callers MUST write the `degraded_to_mechanical`
 * marker on the corresponding ledger row and MUST NOT surface degraded
 * runs as user-facing notifications (Phase A C2 + C8).
 *
 * No retry of any kind in this function. Provider-level transport
 * retries happen inside pi-ai (configured by pi settings.json#retry).
 * Prompt-level retry / "ask LLM to fix JSON" is forbidden per Phase A
 * C6 and the v1 prompt \u00a75 contract.
 */
export async function runAggregatorLlmPass(
  summary: AggregatorSummary,
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
  decayCtx?: unknown,
): Promise<AggregatorLlmResult> {
  let prompt = "";
  let fullPrompt = "";
  try {
    // ADR 0031 Phase 1B: decay context 缺省(forgetting.enabled off)→ 与基线逐字节相同。
    const parts = buildAggregatorFullPromptParts(summary, decayCtx);
    prompt = parts.prompt;
    // Belt-and-suspenders: sanitize the assembled INPUT before LLM call.
    // The prompt template is author-controlled and need not be sanitized,
    // but counterfactual quotes inside the input may carry raw user text.
    const sanitizedInput = sanitizeForMemory(parts.input);
    fullPrompt = `${prompt}\n\n---\n\n${sanitizedInput.text}`;
    const { rawText, model, durationMs } = await invokeAggregatorLlm(settings, modelRegistry, fullPrompt, signal);
    try {
      const promptNative = parseAggregatorOutput(rawText);
      return {
        prompt_native: promptNative,
        degraded: false,
        llm_duration_ms: durationMs,
        llm_model: model,
        prompt_char_count: fullPrompt.length,
        raw_text_preview: rawText.slice(0, 500),
      };
    } catch (parseErr) {
      return {
        degraded: true,
        degraded_reason: `parse_failure: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        llm_duration_ms: durationMs,
        llm_model: model,
        prompt_char_count: fullPrompt.length,
        raw_text_preview: rawText.slice(0, 500),
      };
    }
  } catch (e) {
    return {
      degraded: true,
      degraded_reason: `llm_call_failure: ${e instanceof Error ? e.message : String(e)}`,
      prompt_char_count: fullPrompt.length || prompt.length,
    };
  }
}
