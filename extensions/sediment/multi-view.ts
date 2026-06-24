/**
 * multi-view — ADR 0024 §5.4 / ADR 0025 §4.4 P0.5 minimal viable version.
 *
 * Runs at the end of curateProjectDraft, after the proposer (curator)
 * emits a CuratorDecision. Triggers ONLY on high-value ops:
 *
 *   - op="create" with confidence ≥ 8 OR scope="world"
 *   - op="archive" / op="supersede" / op="merge" (always high value —
 *     restructures knowledge graph)
 *   - op="delete" mode="hard" (permanent loss)
 *   - any op when correctionSignal.typing="durable" && conf ≥ 8
 *     (covers the conf<8 blind spot from ADR 0025 §4.1.4 — high-conf
 *     durable corrections still get a second look)
 *
 * P0.5 scope (per ADR 0025 §4.4.4 "P0.5 minimal version"):
 *
 *   - Two SEPARATE API calls: Pass 1 Blind → Pass 2 Reveal.
 *   - Reviewer model is the first usable entry from
 *     settings.multiView.reviewerProviders, falling back to
 *     fallbackProviders. Different family from curator/proposer
 *     (default curator = deepseek; default reviewer = anthropic) —
 *     ADR 0024 §5.4 cross-provider requirement satisfied via
 *     proposer-vs-reviewer family diversity (NOT pass1-vs-pass2 —
 *     same reviewer model runs both passes since pass 2 must see its
 *     own pass 1 verdict).
 *   - Devil's advocate third layer baked into the Pass 2 prompt
 *     (virtual third reviewer, no extra API call).
 *   - DEFER outcomes route to staging-pending replay (batch 3b
 *     promoted DEFER from skip(multiview_deferred) into the
 *     unified multiview-pending staging queue). See §4.4.5 +
 *     §4.4.6 in ADR 0025 and multiview-staging-types.ts.
 *
 * NOT in P0.5 (deferred to P3.5):
 *
 *   - Dynamic provider selection / rate-limit handling
 *   - DEFER → staging provisional write (ADR §4.4.5)
 *   - Real dual-reviewer (two different reviewers, each running pass 1+2)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry } from "../memory/types";
import type { CuratorDecision } from "./curator";
// isWorkflowNeighborEntry sourced from ./workflow-utils, NOT ./curator —
// importing from ./curator would re-create the value-level circular
// dependency (curator.ts imports runMultiView from this file). See
// workflow-utils.ts header comment for full rationale.
import { isWorkflowNeighborEntry } from "./workflow-utils";
import { ensureUserGlobalSidecarMigrated, userGlobalSedimentDir } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { shouldEscalateToCurator, type CorrectionSignal } from "./correction-pipeline";
import type { ProjectEntryDraft } from "./writer";
import type { SedimentSettings } from "./settings";
import type {
  MultiviewPendingEntry,
  MultiviewPendingState,
  CandidateSnapshot,
} from "./multiview-staging-types";
import {
  generateMultiviewPendingSlug,
  writeMultiviewPending,
} from "./multiview-staging-io";
import {
  fingerprintCandidate,
  lookupSkipCache,
  writeSkipCacheEntry,
  SKIP_CACHE_DEFAULT_TTL_MS,
} from "./multi-view-skip-cache";
import * as os from "node:os";
import type { ModelRegistryLike } from "./llm-extractor";
import { sanitizeForMemory } from "./sanitizer";

// ── Types ─────────────────────────────────────────────────────────────

export type MultiViewTriggerReason =
  | "create_high_confidence"
  | "create_world_scope"
  | "create_rules_zone"
  | "archive_high_conf_neighbor"
  | "archive_target_not_in_neighbors"
  | "supersede_op"
  | "merge_op"
  | "delete_hard_mode"
  | "durable_correction_high_conf"
  | "update_high_confidence_candidate"
  | "update_high_confidence_neighbor"
  | "update_compiled_truth_rewrite";

export interface Pass1Verdict {
  op: string;
  scope?: string;
  slug_target?: string | null;
  confidence?: number;
  key_evidence_quote?: string;
  strongest_objection_to_your_own_op?: string;
  reasoning?: string;
  /** Raw model text (for audit). */
  raw: string;
  /** Model ref used (provider/id). */
  model: string;
  durationMs: number;
}

export interface Pass2Verdict {
  verdict: "confirm_proposer" | "confirm_pass1" | "defer";
  rationale?: string;
  anchor_bias_self_check?: string;
  devils_advocate_objection?: string;
  missed_evidence_quote?: string | null;
  raw: string;
  model: string;
  durationMs: number;
}

export interface MultiViewStagedRef {
  slug: string;
  state: MultiviewPendingState;
  /** Absolute on-disk path for audit traceability. */
  path: string;
}

export interface MultiViewResult {
  triggered: boolean;
  trigger_reason?: MultiViewTriggerReason;
  /** Final decision to use downstream. When pass2 verdict =
   *  confirm_proposer → equals input proposerDecision.
   *  confirm_pass1 → a CuratorDecision synthesized from Pass1Verdict
   *  (when synthesizable; otherwise op=skip with multiview audit).
   *  defer → op=skip with reason=multiview_staged_for_replay (batch 3b
   *  promoted DEFER from old skip(multiview_deferred) into staging).
   *
   *  When `staged` is non-undefined, this is op=skip(reason=
   *  multiview_staged_for_replay) regardless of the original failure
   *  mode — the curator must NOT execute the proposer's intent. */
  final_decision: CuratorDecision;
  pass1?: Pass1Verdict;
  pass2?: Pass2Verdict;
  /** When triggered but reviewer was unavailable / both passes failed. */
  error?: string;
  /** Set when this multi-view run produced a staged entry on disk
   *  (one of the 6 transient-failure fallback paths). The downstream
   *  curator should write `op: skip` to audit but NOT execute the
   *  candidate; replay will pick it up at the next agent_end. */
  staged?: MultiViewStagedRef;
  durationMs: number;
}

// ── Trigger logic ──────────────────────────────────────────────────────

export function shouldTriggerMultiView(
  decision: CuratorDecision,
  candidate: ProjectEntryDraft,
  neighbors: MemoryEntry[],
  correctionSignal?: CorrectionSignal | null,
): { triggered: boolean; reason?: MultiViewTriggerReason } {
  // Active correction with high-confidence durable typing — always
  // covers the conf<8 blind spot for downstream durable writes (ADR
  // 0025 §4.1.4) by ensuring any curator decision touching a high-conf
  // durable correction is re-reviewed.
  if (
    correctionSignal?.signal_found &&
    correctionSignal.typing === "durable" &&
    (correctionSignal.confidence ?? 0) >= 8
  ) {
    return { triggered: true, reason: "durable_correction_high_conf" };
  }

  switch (decision.op) {
    case "create": {
      const confidence = candidate.confidence ?? 0;
      // Audit F3 (2026-06-07, ADR 0023): a rules-zone create lands in EVERY future
      // session's system prompt — higher blast radius than any knowledge create, so
      // it must always get the 2-pass review regardless of candidate confidence.
      if (decision.zone === "rules") return { triggered: true, reason: "create_rules_zone" };
      if (confidence >= 8) return { triggered: true, reason: "create_high_confidence" };
      if (decision.scope === "world") return { triggered: true, reason: "create_world_scope" };
      return { triggered: false };
    }
    case "archive": {
      // High-confidence neighbor being archived is destructive enough to
      // warrant review even when the curator is confident.
      const target = neighbors.find((n) => n.slug === decision.slug);
      if (target && (target.confidence ?? 0) >= 8) {
        return { triggered: true, reason: "archive_high_conf_neighbor" };
      }
      // Defensive fail-safe: if the archive slug is NOT in the neighbor
      // list, we cannot read its confidence. Trigger anyway.
      //
      // Reviewer note (batch-1.5 review): in the CURRENT curator route
      // this branch is dead code — parseDecision (curator.ts:320)
      // throws CuratorRejectError("invented_neighbor_slug") for any
      // archive op whose slug is not in `allowedSlugs`, so a
      // CuratorDecision with op=archive + unknown slug never reaches
      // shouldTriggerMultiView in production.
      //
      // The branch is retained as PUBLIC API DEFENSE: shouldTriggerMultiView
      // is exported, so any caller that constructs a CuratorDecision
      // directly (bypassing parseDecision) must not silently skip review
      // for an unknown-slug archive. This includes test harnesses and
      // any future caller that wants to dispatch to multi-view without
      // running the full curator pipeline.
      if (!target) {
        return { triggered: true, reason: "archive_target_not_in_neighbors" };
      }
      return { triggered: false };
    }
    case "supersede":
      return { triggered: true, reason: "supersede_op" };
    case "merge":
      return { triggered: true, reason: "merge_op" };
    case "delete":
      // Soft delete is reversible; hard delete is permanent.
      if (decision.mode === "hard") return { triggered: true, reason: "delete_hard_mode" };
      return { triggered: false };
    case "update": {
      // ADR 0025 P0.5 R-series review (Reviewer C3 P1 + Reviewer R4):
      // `update` is high risk — curator prompt itself warns at
      // curator.ts:671 that mis-update overwrites load-bearing
      // Evidence/Fix/Principle sections (data loss recoverable only via
      // git history). Original P0.5 skipped update entirely; this is a
      // dangerous gap when correctionSignal is absent / parse-failed and
      // candidate or target is high-confidence.
      //
      // Three orthogonal trigger paths:
      //   (1) high-confidence candidate — the new claim is asserted
      //       strongly; an update propagates that strength onto the
      //       neighbor, so review.
      //   (2) high-confidence neighbor — mutating a high-conf entry is
      //       inherently destructive; review.
      //   (3) compiledTruth rewrite — the update patch carries new body
      //       text, which is the path that overwrites load-bearing
      //       sections per the curator-prompt warning. ANY confidence
      //       level triggers review when compiledTruth is being rewritten.
      //
      // Schema note: ProjectEntryUpdateDraft (writer.ts) declares the
      // body field as camelCase `compiledTruth`. parseDecision
      // (curator.ts ~:349) normalizes the LLM's snake_case
      // `compiled_truth` to camelCase before constructing the
      // CuratorDecision, so by the time we land here only the camelCase
      // form is ever populated. We rely on the discriminated union
      // narrowing inside `case "update"` for type safety — no cast
      // needed.
      const candidateConf = candidate.confidence ?? 0;
      if (candidateConf >= 8) {
        return { triggered: true, reason: "update_high_confidence_candidate" };
      }
      const target = neighbors.find((n) => n.slug === decision.slug);
      if (target && (target.confidence ?? 0) >= 8) {
        return { triggered: true, reason: "update_high_confidence_neighbor" };
      }
      const ct = decision.patch.compiledTruth;
      if (typeof ct === "string" && ct.trim().length > 0) {
        return { triggered: true, reason: "update_compiled_truth_rewrite" };
      }
      return { triggered: false };
    }
    case "skip":
    default:
      return { triggered: false };
  }
}

// ── Prompt loading (cached) ────────────────────────────────────────────

let _pass1Cache: string | null = null;
let _pass2Cache: string | null = null;
let _preambleCache: string | null = null;

function loadPreamble(): string {
  if (_preambleCache) return _preambleCache;
  const p = path.join(__dirname, "prompts", "reasoning-normalization-preamble-v1.md");
  _preambleCache = fs.readFileSync(p, "utf-8");
  return _preambleCache;
}

function loadPass1Prompt(): string {
  if (_pass1Cache) return _pass1Cache;
  const p = path.join(__dirname, "prompts", "multi-view-pass1-blind-v1.md");
  _pass1Cache = `${loadPreamble()}\n\n---\n\n${fs.readFileSync(p, "utf-8")}`;
  return _pass1Cache;
}

function loadPass2Prompt(): string {
  if (_pass2Cache) return _pass2Cache;
  const p = path.join(__dirname, "prompts", "multi-view-pass2-reveal-v1.md");
  _pass2Cache = `${loadPreamble()}\n\n---\n\n${fs.readFileSync(p, "utf-8")}`;
  return _pass2Cache;
}

// ── Context rendering (shared between pass 1 and pass 2) ──────────────

function sanitizeText(text: string): string {
  const s = sanitizeForMemory(text);
  return s.ok ? (s.text ?? text) : `[redacted: ${s.error}]`;
}

function renderCandidate(draft: ProjectEntryDraft): string {
  return [
    "Candidate:",
    "<<<SEDIMENT_CANDIDATE",
    `title: ${sanitizeText(draft.title)}`,
    `kind: ${draft.kind}`,
    draft.status ? `status: ${draft.status}` : undefined,
    draft.confidence !== undefined ? `confidence: ${draft.confidence}` : undefined,
    "",
    sanitizeText(draft.compiledTruth),
    "SEDIMENT_CANDIDATE>>>",
  ].filter((x): x is string => x !== undefined).join("\n");
}

function renderNeighbors(neighbors: MemoryEntry[]): string {
  if (neighbors.length === 0) return "Neighbors:\n<<<SEDIMENT_NEIGHBORS\n(none)\nSEDIMENT_NEIGHBORS>>>";
  const blocks = neighbors.map((entry) => {
    const timelineTail = entry.timeline.slice(-3).join("\n") || "(none)";
    // ADR 0025 P0.5 R-series review (Reviewer C5):
    // curator.ts:558-565 marks workflow-lane neighbors as READ-ONLY so the
    // curator LLM does not pick op=update/supersede/merge/archive/delete
    // on them. Multi-view reviewer was missing this marker, so a
    // reviewer could recommend `update workflow_slug` (or worse,
    // `archive workflow_slug`) and Pass 2 confirm_pass1, then
    // synthesizeFromPass1 would emit an archive decision the writer
    // refuses. The candidate's create would also not execute (because
    // final_decision is the synthesized archive), so the entire turn
    // silently drops. Mirroring the curator's marker fixes this.
    const isWorkflow = isWorkflowNeighborEntry(entry);
    const scopeLine = isWorkflow
      ? `scope: workflow (READ-ONLY reference — multi-view reviewer CANNOT recommend update/merge/archive/supersede/delete on this slug; treat as a context anchor only)`
      : `scope: ${entry.scope ?? "project"}`;
    return [
      `## ${entry.slug}`,
      scopeLine,
      `title: ${sanitizeText(entry.title)}`,
      `kind: ${entry.kind}`,
      `status: ${entry.status}`,
      `confidence: ${entry.confidence}`,
      entry.created ? `created: ${entry.created}` : undefined,
      entry.updated ? `updated: ${entry.updated}` : undefined,
      "",
      "### compiled_truth",
      sanitizeText(entry.compiledTruth),
      "",
      "### timeline_tail",
      sanitizeText(timelineTail),
    ].filter((x): x is string => x !== undefined).join("\n");
  }).join("\n\n---\n\n");
  return `Neighbors:\n<<<SEDIMENT_NEIGHBORS\n${blocks}\nSEDIMENT_NEIGHBORS>>>`;
}

function renderCorrectionSignal(signal?: CorrectionSignal | null): string {
  if (!signal?.signal_found) return "";
  return [
    "",
    "=== ACTIVE CORRECTION SIGNAL (HYPOTHESIS — NOT GROUND TRUTH) ===",
    `Typing: ${signal.typing ?? "unknown"}`,
    `Confidence: ${signal.confidence ?? "?"}/10`,
    `Intent: ${signal.correction_intent ?? "unknown"}`,
    `Scope: ${signal.scope_description ?? "unknown"}`,
    signal.user_quote ? `User quote: "${signal.user_quote}"` : "",
    signal.target_entry_slug ? `Suggested target: ${signal.target_entry_slug}` : "",
    signal.most_likely_error ? `Classifier uncertainty: "${signal.most_likely_error}"` : "",
    signal.surrounding_context ? `Surrounding context: "${signal.surrounding_context.slice(0, 300)}"` : "",
    "=== END CORRECTION SIGNAL ===",
  ].filter(Boolean).join("\n");
}

// ── Parsing ────────────────────────────────────────────────────────────

function unwrapJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [trimmed, fence?.[1]?.trim()].filter((x): x is string => !!x);
  for (const text of candidates) {
    try { return JSON.parse(text); } catch { /* try next */ }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  throw new Error(`pass output did not parse as JSON: ${trimmed.slice(0, 200)}`);
}

function parsePass1(raw: string, model: string, durationMs: number): Pass1Verdict | null {
  try {
    const p = unwrapJson(raw) as Record<string, unknown>;
    if (typeof p.op !== "string") return null;
    return {
      op: p.op as string,
      scope: typeof p.scope === "string" ? p.scope : undefined,
      slug_target: typeof p.slug_target === "string" ? p.slug_target : null,
      confidence: typeof p.confidence === "number" ? p.confidence : undefined,
      key_evidence_quote: typeof p.key_evidence_quote === "string" ? p.key_evidence_quote : undefined,
      strongest_objection_to_your_own_op: typeof p.strongest_objection_to_your_own_op === "string"
        ? p.strongest_objection_to_your_own_op : undefined,
      reasoning: typeof p.reasoning === "string" ? p.reasoning : undefined,
      raw, model, durationMs,
    };
  } catch {
    return null;
  }
}

function parsePass2(raw: string, model: string, durationMs: number): Pass2Verdict | null {
  try {
    const p = unwrapJson(raw) as Record<string, unknown>;
    const verdict = p.verdict;
    if (verdict !== "confirm_proposer" && verdict !== "confirm_pass1" && verdict !== "defer") return null;
    return {
      verdict,
      rationale: typeof p.rationale === "string" ? p.rationale : undefined,
      anchor_bias_self_check: typeof p.anchor_bias_self_check === "string"
        ? p.anchor_bias_self_check : undefined,
      devils_advocate_objection: typeof p.devils_advocate_objection === "string"
        ? p.devils_advocate_objection : undefined,
      missed_evidence_quote: typeof p.missed_evidence_quote === "string"
        ? p.missed_evidence_quote : null,
      raw, model, durationMs,
    };
  } catch {
    return null;
  }
}

// ── Model invocation ──────────────────────────────────────────────────

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/**
 * Find the first usable reviewer model from the configured lists.
 * Tries reviewerProviders first, then fallbackProviders.
 *
 * Returns null when the lists are empty OR no entry is registered in
 * the model registry (auth not checked here — caller handles auth).
 *
 * Per ADR 0024 §5.4: the reviewer model SHOULD be from a different
 * provider than the proposer (curator). We do not enforce this in
 * code yet (P3.5 will when dynamic selection lands); we rely on the
 * default reviewerProviders list pointing at non-deepseek families.
 */
function selectReviewerModel(
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
): { ref: string; provider: string; id: string } | null {
  const candidates = [
    ...settings.multiView.reviewerProviders,
    ...settings.multiView.fallbackProviders,
  ];
  for (const ref of candidates) {
    const parsed = parseModelRef(ref);
    if (!parsed) continue;
    if (modelRegistry.find(parsed.provider, parsed.id)) {
      return { ref, ...parsed };
    }
  }
  return null;
}

// ── Multi-view reviewer metrics (sidecar) ─────────────────────────────
//
// ADR 0025 P0.5 R-series review batch-2 (commit b575eab pre-batch-2 the
// `buildMultiViewAudit` comment claimed reviewer raw text is "preserved
// in curator-metrics sidecar", but `callReviewerModel` never actually
// wrote anywhere; main audit also dropped `raw`, so reviewer outputs
// were unrecoverable for debugging Pass 1/2 parse failures, prompt
// quality regressions, or reviewer-cost analysis).
//
// This sidecar mirrors curator.ts::logCuratorMetrics + extractor-metrics.
// User-global cross-project file (ADR 0025 §4.2.4):
//   <abrainHome>/.state/sediment/multi-view-metrics.jsonl
//
// Each reviewer call (pass1 OR pass2 — separately) appends one line.
// `rawText` is clipped to RAW_TEXT_AUDIT_CAP to avoid unbounded growth
// under reviewer prompt regressions; the cap matches the same
// in-file convention as proposer raw clip (4000 chars). Full raw text
// is NOT stored — if you need it, dogfood with provider-side logging
// or capture in a smoke run.
const REVIEWER_METRICS_RAW_TEXT_CAP = 4000;

interface ReviewerMetricsEntry {
  ts: string;
  pass: "pass1" | "pass2";
  model: string;
  promptChars: number;
  estimatedTokens: number;
  ok: boolean;
  durationMs: number;
  rawText?: string;
  rawTextTruncated?: boolean;
  error?: string;
}

function logReviewerMetrics(entry: ReviewerMetricsEntry): void {
  try {
    ensureUserGlobalSidecarMigrated();
    const dir = userGlobalSedimentDir();
    fs.mkdirSync(dir, { recursive: true });
    // ADR 0027 PR-B+ R1 P1-3: attach causal anchor for cross-layer join.
    // multi-view runs inside sediment.agent_end (or replay path called
    // from agent_end), inheriting the trigger turn snapshot via
    // AsyncLocalStorage. Entry fields override anchor on collision.
    const enriched = { ...spreadAnchor(getCurrentAnchor()), ...entry };
    const line = JSON.stringify(enriched) + "\n";
    fs.appendFileSync(path.join(dir, "multi-view-metrics.jsonl"), line, "utf-8");
  } catch {
    // metrics are best-effort; never throw
  }
}

/** Apply the raw-text cap and return both clipped text and a truncation
 *  flag for the audit row. Null/empty inputs return undefined so the
 *  metrics row omits the field rather than emitting an empty string. */
function clipRawForAudit(text: string | undefined): { clipped?: string; truncated?: boolean } {
  if (!text) return {};
  if (text.length <= REVIEWER_METRICS_RAW_TEXT_CAP) return { clipped: text, truncated: false };
  return { clipped: text.slice(0, REVIEWER_METRICS_RAW_TEXT_CAP) + "…[truncated]", truncated: true };
}

async function callReviewerModel(
  ref: string,
  parsed: { provider: string; id: string },
  modelRegistry: ModelRegistryLike,
  prompt: string,
  settings: SedimentSettings,
  pass: "pass1" | "pass2",
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const t0 = Date.now();
  const promptChars = prompt.length;
  const estimatedTokens = Math.ceil(promptChars / 3);
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    const error = `reviewer model not registered: ${ref}`;
    logReviewerMetrics({
      ts: new Date().toISOString(), pass, model: ref,
      promptChars, estimatedTokens, ok: false,
      durationMs: Date.now() - t0, error,
    });
    return { ok: false, error };
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    const error = `reviewer auth unavailable for ${ref}: ${auth.error ?? "no api key"}`;
    logReviewerMetrics({
      ts: new Date().toISOString(), pass, model: ref,
      promptChars, estimatedTokens, ok: false,
      durationMs: Date.now() - t0, error,
    });
    return { ok: false, error };
  }

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
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
        // Reviewer uses curator timeout budget — same order of magnitude task.
        timeoutMs: settings.curatorTimeoutMs,
        maxRetries: 0,
      },
    );
    const result = await stream.result();
    const durationMs = Date.now() - t0;
    if (result.errorMessage || result.stopReason === "error" || result.stopReason === "aborted") {
      const error = result.errorMessage ?? result.stopReason ?? "reviewer call failed";
      logReviewerMetrics({
        ts: new Date().toISOString(), pass, model: ref,
        promptChars, estimatedTokens, ok: false, durationMs, error,
      });
      return { ok: false, error };
    }
    const text = (result.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      logReviewerMetrics({
        ts: new Date().toISOString(), pass, model: ref,
        promptChars, estimatedTokens, ok: false, durationMs,
        error: "reviewer returned empty text",
      });
      return { ok: false, error: "reviewer returned empty text" };
    }
    const { clipped, truncated } = clipRawForAudit(text);
    logReviewerMetrics({
      ts: new Date().toISOString(), pass, model: ref,
      promptChars, estimatedTokens, ok: true, durationMs,
      rawText: clipped, rawTextTruncated: truncated,
    });
    return { ok: true, text };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    logReviewerMetrics({
      ts: new Date().toISOString(), pass, model: ref,
      promptChars, estimatedTokens, ok: false,
      durationMs: Date.now() - t0, error,
    });
    return { ok: false, error };
  }
}

// ── Decision synthesis (when Pass 2 verdict = confirm_pass1) ───────────

/**
 * Try to convert a Pass 1 verdict into a CuratorDecision the writer
 * can execute. The returned value is ALWAYS a valid CuratorDecision
 * when non-null — either a writer-actionable op, OR an `op=skip`
 * carrying the SPECIFIC failure reason. Returns null only when the
 * verdict is truly unrecognized.
 *
 * Three categories of refusal are distinguished so audit readers
 * can tell them apart (batch-1.5 review N1: the original generic
 * `multiview_pass1_op_not_synthesizable` message was misleading
 * for the workflow-lane case, where the actual cause is "write
 * forbidden" not "payload missing"):
 *
 *   reason=multiview_pass1_recommends_skip
 *     Pass 1 recommended skip; proposer disagreed; Pass 2 sided
 *     with Pass 1. Honored as-is.
 *
 *   reason=multiview_workflow_lane_protected
 *     Pass 1 recommended a destructive op on a workflow-lane
 *     neighbor (slug detected via isWorkflowNeighborEntry). The
 *     writer would refuse it; the candidate's claim is dropped
 *     rather than executed against the wrong lane. NOT a rich-
 *     payload issue — it's a writer-side hard constraint.
 *
 *   reason=multiview_pass1_op_not_synthesizable
 *     Pass 1 recommended update/merge/supersede/delete, but the
 *     Pass 1 schema (op + scope + slug_target only) does not carry
 *     the rich payload (update.patch / merge.compiledTruth /
 *     supersede slug pair / delete.mode) the writer needs to safely
 *     execute the op. P0.5 conservative choice: skip rather than
 *     fabricate payload from reviewer's free-text reasoning. P1.5
 *     plan is to expand Pass 1 schema so reviewer can produce rich
 *     payload; until then this remains a known signal-loss path.
 *
 * `neighbors` is consulted to enforce workflow-lane read-only
 * (ADR 0025 P0.5 R-series review Reviewer C5).
 */
function synthesizeFromPass1(
  pass1: Pass1Verdict,
  neighbors: MemoryEntry[],
  proposerDecision: CuratorDecision,
): CuratorDecision | null {
  // Helper: is this slug a workflow-lane neighbor? Destructive ops
  // on workflow lanes are writer-rejected.
  const isWorkflowSlug = (slug: string | null | undefined): boolean => {
    if (!slug) return false;
    const target = neighbors.find((n) => n.slug === slug);
    return !!target && isWorkflowNeighborEntry(target);
  };

  // Helper: workflow-lane refusal short-circuit. Returns a skip
  // decision with the specific reason so audit readers can
  // distinguish workflow-lane refusal from payload-shape refusal.
  //
  // Length cap on pass1.reasoning matches the in-file convention:
  // proposer raw reasoning is clipped to 4000 (multi-view.ts:709),
  // defer rationale to 500 (multi-view.ts:775). Uncapped reasoning
  // can be 5-10KB; an unbounded splice into every workflow-lane
  // refusal would bloat audit rows under reviewer regressions where
  // many candidates touch the same workflow slug. 500 chars matches
  // the defer-rationale tier (same audit-prominence).
  const REASONING_CAP = 500;
  const cappedReasoning = pass1.reasoning
    ? (pass1.reasoning.length > REASONING_CAP
        ? pass1.reasoning.slice(0, REASONING_CAP) + "…[truncated]"
        : pass1.reasoning)
    : "(none)";
  const workflowLaneRefusal = (op: string, slug: string): CuratorDecision => ({
    op: "skip",
    reason: "multiview_workflow_lane_protected",
    rationale: `Pass 1 reviewer recommended op=${op} on slug=${slug}, but that neighbor is workflow-lane (READ-ONLY: writer cannot mutate it). Dropping the candidate is safer than emitting a write the writer would refuse. Pass 1 reasoning: ${cappedReasoning}.`,
  });

  switch (pass1.op) {
    case "skip":
      return {
        op: "skip",
        reason: "multiview_pass1_recommends_skip",
        rationale: pass1.reasoning ?? "Pass 1 reviewer recommended skip; proposer disagreed and Pass 2 sided with Pass 1.",
      };
    case "create": {
      // Reviewer can only override scope on create; everything else
      // (title/kind/compiledTruth) comes from the candidate the writer
      // already has. We ALSO carry forward the proposer's (already
      // cross-scope-qualified) derives_from so R1 provenance survives the
      // confirm_pass1 override path, not just confirm_proposer
      // (mechanical-guard cleanup R1 follow-up, 2026-06-06).
      const proposerDerivesFrom =
        proposerDecision.op === "create" && proposerDecision.derives_from && proposerDecision.derives_from.length > 0
          ? proposerDecision.derives_from
          : undefined;
      // W0.1 (ADR 0023 write-path): carry the rules discriminant through
      // confirm_pass1 so a rules create is NOT silently downgraded to a
      // knowledge create. Rules use ruleScope, not the entries scope:world.
      if (proposerDecision.op === "create" && proposerDecision.zone === "rules") {
        return {
          op: "create",
          zone: "rules" as const,
          // §12.3 rename dual-read: a replayed pass-1 decision persisted
          // before the rename still carries the legacy `tier` key.
          injectMode: proposerDecision.injectMode ?? (proposerDecision as { tier?: "always" | "listed" }).tier,
          ruleScope: proposerDecision.ruleScope,
          ...(proposerDerivesFrom ? { derives_from: proposerDerivesFrom } : {}),
          rationale: pass1.reasoning ?? "Pass 1 reviewer recommended create; Pass 2 confirmed.",
        };
      }
      return {
        op: "create",
        ...(pass1.scope === "world" ? { scope: "world" as const } : {}),
        ...(proposerDerivesFrom ? { derives_from: proposerDerivesFrom } : {}),
        rationale: pass1.reasoning ?? "Pass 1 reviewer recommended create; Pass 2 confirmed.",
      };
    }
    case "archive": {
      if (!pass1.slug_target) return null;
      if (isWorkflowSlug(pass1.slug_target)) {
        return workflowLaneRefusal("archive", pass1.slug_target);
      }
      // R2 follow-up (2026-06-06): the existing neighbor's physical scope is
      // ground truth — auto-correct to it rather than trusting the reviewer's
      // pass1.scope (which could route the writer to the wrong store →
      // entry_not_found). Mirrors parseDecision's effectiveScopeFor.
      const archiveTarget = neighbors.find((n) => n.slug === pass1.slug_target);
      const archiveScope = archiveTarget?.scope === "world" ? ("world" as const) : undefined;
      return {
        op: "archive",
        slug: pass1.slug_target,
        ...(archiveScope ? { scope: archiveScope } : {}),
        reason: "multiview_pass1_recommends_archive",
        rationale: pass1.reasoning ?? "Pass 1 reviewer recommended archive; Pass 2 confirmed.",
      };
    }
    // update/merge/supersede/delete require rich payload the reviewer
    // didn't produce in Pass 1 (the schema only collects op + scope +
    // slug_target).
    //
    // Even though these branches don't have synthesizable payload,
    // we still check the workflow-lane case first so the audit row
    // carries the SPECIFIC reason (workflow_lane_protected) rather
    // than the generic payload-missing reason. The user-visible effect
    // is the same (op=skip), but downstream aggregator analytics need
    // to tell these two failure modes apart.
    case "update":
    case "merge":
    case "supersede":
    case "delete":
      if (isWorkflowSlug(pass1.slug_target)) {
        return workflowLaneRefusal(pass1.op, pass1.slug_target!);
      }
      return null;
    default:
      return null;
  }
}

// ── Staging fallback (batch 3b) ───────────────────────────────────────
//
// ADR 0025 P0.5 R-series review batch 3b: six transient-failure
// fallback paths in runMultiView used to silently fall back to the
// proposer's CuratorDecision being written directly to brain, which
// violates ADR 0025 §3.1 A' layer hard constraint ("non-trivial
// create / destructive ops MUST be double-reviewed"). Each of those
// six paths is now routed through stageAndSkipDecision — the
// candidate is staged for replay (batch 3c-i) and the curator is
// instructed to op=skip(multiview_staged_for_replay).
//
// The seventh path, confirm_pass1_not_synthesizable, is NOT staged —
// it represents the known P0.5 schema limitation that Pass 1 schema
// does not carry rich payload for update/merge/supersede/delete.
// Staging it would dead-loop (replay hits the same limitation). That
// path keeps op=skip(multiview_pass1_op_not_synthesizable) per
// design review D5.5A.
//
// Error policy: writeMultiviewPending propagates IO + validation
// errors. runMultiView does NOT catch them — we deliberately prefer
// "this round's sediment auto-write fails loudly" over "silently fall
// back to proposer direct-write". P0.3 (A' layer must hold) outranks
// candidate-loss cost (this turn's candidate is discarded). The
// classifier may re-detect the same signal on a future turn; A'
// violations are unrecoverable.

export type RunMultiViewArgs = {
  proposerDecision: CuratorDecision;
  proposerRawText: string;
  candidate: ProjectEntryDraft;
  neighbors: MemoryEntry[];
  correctionSignal?: CorrectionSignal | null;
  settings: SedimentSettings;
  modelRegistry: ModelRegistryLike;
  signal?: AbortSignal;
  originProjectId?: string;
  originProjectRoot?: string;
};

/** Project the candidate draft onto the staging-entry's snapshot
 *  subset. Only the fields renderCandidate consumes are kept (see
 *  multiview-staging-types.ts::CandidateSnapshot JSDoc); summary is
 *  included as a defensive context field for the reviewer at replay
 *  time even though current renderCandidate does not surface it,
 *  because the schema is forward-compatible with prompt evolution. */
function snapshotCandidate(draft: ProjectEntryDraft): CandidateSnapshot {
  return {
    title: draft.title,
    kind: draft.kind,
    compiledTruth: draft.compiledTruth,
    ...(draft.status !== undefined && { status: draft.status }),
    ...(draft.confidence !== undefined && { confidence: draft.confidence }),
    ...(draft.summary !== undefined && { summary: draft.summary }),
    // AX-PROVENANCE: preserve across a deferred multi-view replay (audit P1).
    ...(draft.provenance !== undefined && { provenance: draft.provenance }),
  };
}

/** Build a MultiviewPendingEntry from runMultiView's local state. The
 *  caller passes the partial verdicts that were produced before the
 *  failure (none for reviewer_unavailable / pass1_*; pass1 for
 *  pass2_*; both for deferred). validateMultiviewPendingConsistency
 *  runs inside writeMultiviewPending and will throw if the verdict
 *  presence doesn't match the state (programmer-bug fail-fast). */
function buildPendingEntry(
  args: RunMultiViewArgs,
  state: MultiviewPendingState,
  triggerReason: MultiViewTriggerReason,
  pass1Verdict: Pass1Verdict | undefined,
  pass2Verdict: Pass2Verdict | undefined,
  origin?: { originProjectId?: string; originProjectRoot?: string },
): MultiviewPendingEntry {
  const nowIso = new Date().toISOString();
  const slug = generateMultiviewPendingSlug({
    compiledTruth: args.candidate.compiledTruth,
    isoTs: nowIso,
  });
  return {
    slug,
    status: "provisional",
    kind: "multiview-pending",
    created: nowIso,
    ...(origin?.originProjectId ? { origin_project_id: origin.originProjectId } : {}),
    ...(origin?.originProjectRoot ? { origin_project_root: origin.originProjectRoot } : {}),
    originating_device: process.env.HOSTNAME ?? os.hostname() ?? "unknown",
    multiview_state: state,
    proposer_decision: args.proposerDecision,
    proposer_raw_text: args.proposerRawText,
    candidate_snapshot: snapshotCandidate(args.candidate),
    correction_signal: args.correctionSignal ?? null,
    neighbor_slugs: args.neighbors.map((n) => n.slug),
    trigger_reason: triggerReason,
    ...(pass1Verdict !== undefined && { pass1_verdict: pass1Verdict }),
    ...(pass2Verdict !== undefined && { pass2_verdict: pass2Verdict }),
    retry_attempts: 0,
    last_attempt_iso: nowIso,
  };
}

/** Build a staging entry, persist it, and return a MultiViewResult
 *  with final_decision = op=skip(multiview_staged_for_replay) plus
 *  the staged ref. The rationale is auto-built so audit readers can
 *  see why the candidate was deferred (state code + error string).
 *
 *  Throws if writeMultiviewPending throws (IO or validation error).
 *  Caller (runMultiView) does NOT catch — see file-level error
 *  policy comment. */
function stageAndSkipDecision(
  args: RunMultiViewArgs,
  state: MultiviewPendingState,
  triggerReason: MultiViewTriggerReason,
  pass1Verdict: Pass1Verdict | undefined,
  pass2Verdict: Pass2Verdict | undefined,
  errorContext: string,
  overallStart: number,
  origin?: { originProjectId?: string; originProjectRoot?: string },
): MultiViewResult {
  const entry = buildPendingEntry(args, state, triggerReason, pass1Verdict, pass2Verdict, origin);
  const writtenPath = writeMultiviewPending(entry);
  return {
    triggered: true,
    trigger_reason: triggerReason,
    final_decision: {
      op: "skip",
      reason: "multiview_staged_for_replay",
      rationale: `runMultiView state=${state} (${errorContext}); candidate staged at slug=${entry.slug} for replay at next agent_end. Replay will retry the reviewer; final disposition decided by replay loop (multiview-staging-replay).`,
    },
    error: `${state}: ${errorContext}`,
    ...(pass1Verdict !== undefined && { pass1: pass1Verdict }),
    ...(pass2Verdict !== undefined && { pass2: pass2Verdict }),
    staged: { slug: entry.slug, state, path: writtenPath },
    durationMs: Date.now() - overallStart,
  };
}

// ── Main entry ────────────────────────────────────────────────────────

/**
 * Run the multi-view pipeline. Caller MUST already have checked
 * shouldTriggerMultiView. We re-run that check here for safety but
 * primarily expect the check to be done upstream so curator can
 * audit `triggered: false` rows independently.
 *
 * After batch 3b, 6 of the 7 transient fallback paths route through
 * stageAndSkipDecision (final_decision = op=skip(multiview_staged_for_replay)
 * + `staged` ref). Returns final_decision = proposerDecision ONLY when:
 *   - multi-view not triggered, OR
 *   - Pass 2 verdict = confirm_proposer (reviewer agrees)
 *
 * Returns final_decision = synthesized from Pass 1 when:
 *   - Pass 2 verdict = confirm_pass1 AND Pass 1 is synthesizable
 *
 * Returns final_decision = op=skip(multiview_pass1_op_not_synthesizable)
 * when Pass 2 verdict = confirm_pass1 but Pass 1 not synthesizable
 * (rich-payload op without writer-ready fields — known P0.5 schema
 * limitation, NOT staged per D5.5A).
 *
 * Returns final_decision = op=skip(multiview_staged_for_replay) +
 * `staged` ref when reviewer unavailable / Pass 1 call failed / Pass
 * 1 unparseable / Pass 2 call failed / Pass 2 unparseable / Pass 2
 * verdict = defer.
 */
export async function runMultiView(args: RunMultiViewArgs): Promise<MultiViewResult> {
  const overallStart = Date.now();
  const trigger = shouldTriggerMultiView(
    args.proposerDecision,
    args.candidate,
    args.neighbors,
    args.correctionSignal,
  );
  if (!trigger.triggered) {
    return {
      triggered: false,
      final_decision: args.proposerDecision,
      durationMs: Date.now() - overallStart,
    };
  }

  // ADR 0027 PR-B+ R1 P1-9: skip-cache short-circuit. If this exact
  // candidate shape (op + slug + compiledTruth prefix) was previously
  // deemed unsynthesizable by multi-view within the TTL window, skip
  // straight to the same outcome without burning reviewer API calls.
  // See multi-view-skip-cache.ts for the dead-loop rationale.
  //
  // Only candidates that COULD be unsynthesizable get cache lookups;
  // create/skip never produce unsynthesizable outcomes by construction
  // (Pass 1 schema CAN synthesize them). For those, the cache will
  // never hit (no entries written) but the lookup cost is one fs read
  // (~negligible).
  const fp = fingerprintCandidate(args.proposerDecision, args.candidate);
  const cacheHit = lookupSkipCache(fp);
  if (cacheHit.hit) {
    return {
      triggered: true,
      trigger_reason: trigger.reason,
      final_decision: {
        op: "skip",
        reason: "multiview_skip_cache_hit",
        rationale:
          `Same candidate shape (op=${cacheHit.entry.proposer_op}, fp=${fp.slice(0, 12)}…) was previously deemed unsynthesizable by multi-view ` +
          `at ${cacheHit.entry.ts} (Pass 1 op=${cacheHit.entry.pass1_op}). ` +
          `Skipping to avoid dead-loop cost; cache TTL=${Math.floor(SKIP_CACHE_DEFAULT_TTL_MS / 86400000)}d.`,
      },
      durationMs: Date.now() - overallStart,
    };
  }

  const reviewer = selectReviewerModel(args.settings, args.modelRegistry);
  if (!reviewer) {
    // batch 3b: stage instead of falling back to proposer direct-write.
    return stageAndSkipDecision(
      args, "reviewer_unavailable", trigger.reason!,
      undefined, undefined,
      "no reviewer model registered or auth unavailable",
      overallStart,
      args,
    );
  }

  const contextBlock = [
    renderCandidate(args.candidate),
    "",
    renderNeighbors(args.neighbors),
    renderCorrectionSignal(args.correctionSignal),
  ].join("\n");

  // ── Pass 1 (Blind) ──
  const pass1Prompt = [
    loadPass1Prompt(),
    "",
    contextBlock,
  ].join("\n");

  const pass1Start = Date.now();
  const pass1Resp = await callReviewerModel(
    reviewer.ref, { provider: reviewer.provider, id: reviewer.id },
    args.modelRegistry, pass1Prompt, args.settings, "pass1", args.signal,
  );
  const pass1DurationMs = Date.now() - pass1Start;

  if (!pass1Resp.ok) {
    // batch 3b: stage instead of falling back to proposer direct-write.
    return stageAndSkipDecision(
      args, "pass1_call_failed", trigger.reason!,
      undefined, undefined,
      pass1Resp.error,
      overallStart,
      args,
    );
  }

  const pass1 = parsePass1(pass1Resp.text, reviewer.ref, pass1DurationMs);
  if (!pass1) {
    // batch 3b: stage instead of falling back to proposer direct-write.
    // We do NOT pass pass1_verdict (state=pass1_unparseable implies
    // the verdict structure could not be reconstructed); the raw
    // text is preserved in the multi-view-metrics.jsonl sidecar from
    // batch 2 for downstream prompt-quality debugging.
    return stageAndSkipDecision(
      args, "pass1_unparseable", trigger.reason!,
      undefined, undefined,
      `parsePass1 returned null; raw text length=${pass1Resp.text.length} (full text in multi-view-metrics.jsonl)`,
      overallStart,
      args,
    );
  }

  // ── Pass 2 (Reveal) — same reviewer model, separate API call ──
  const pass2Prompt = [
    loadPass2Prompt(),
    "",
    contextBlock,
    "",
    "=== YOUR PASS 1 VERDICT (the blind pass you just produced) ===",
    pass1Resp.text,
    "=== END PASS 1 ===",
    "",
    "=== PROPOSER (sediment curator) DECISION ===",
    JSON.stringify(args.proposerDecision, null, 2),
    "=== END PROPOSER DECISION ===",
    "",
    "=== PROPOSER REASONING (curator raw output) ===",
    sanitizeText(args.proposerRawText.slice(0, 4000)),
    "=== END PROPOSER REASONING ===",
  ].join("\n");

  const pass2Start = Date.now();
  const pass2Resp = await callReviewerModel(
    reviewer.ref, { provider: reviewer.provider, id: reviewer.id },
    args.modelRegistry, pass2Prompt, args.settings, "pass2", args.signal,
  );
  const pass2DurationMs = Date.now() - pass2Start;

  if (!pass2Resp.ok) {
    // batch 3b: stage instead of falling back to proposer direct-write.
    // Pass 1 succeeded so we preserve pass1 in the staging entry; replay
    // may choose to skip Pass 1 re-execution if the entry has a fresh
    // pass1_verdict (3c-i policy).
    return stageAndSkipDecision(
      args, "pass2_call_failed", trigger.reason!,
      pass1, undefined,
      pass2Resp.error,
      overallStart,
      args,
    );
  }

  const pass2 = parsePass2(pass2Resp.text, reviewer.ref, pass2DurationMs);
  if (!pass2) {
    // batch 3b: stage instead of falling back to proposer direct-write.
    return stageAndSkipDecision(
      args, "pass2_unparseable", trigger.reason!,
      pass1, undefined,
      `parsePass2 returned null; raw text length=${pass2Resp.text.length} (full text in multi-view-metrics.jsonl)`,
      overallStart,
      args,
    );
  }

  // ── Resolve final decision ──
  let final_decision: CuratorDecision;
  switch (pass2.verdict) {
    case "confirm_proposer":
      final_decision = args.proposerDecision;
      break;
    case "confirm_pass1": {
      const synthesized = synthesizeFromPass1(pass1, args.neighbors, args.proposerDecision);
      if (synthesized) {
        final_decision = synthesized;
      } else {
        // Pass 1 wants an op we can't safely synthesize without the
        // proposer's payload — convert to skip with audit context.
        final_decision = {
          op: "skip",
          reason: "multiview_pass1_op_not_synthesizable",
          rationale: `Pass 1 recommended op=${pass1.op} but reviewer schema did not include the rich payload (patch / compiled_truth / merge sources) required to safely execute that op. Defaulting to skip per P0.5 conservative path.`,
        };
        // ADR 0027 PR-B+ R1 P1-9: cache this fingerprint so the next
        // multi-view call with the SAME candidate shape short-circuits
        // to skip without burning reviewer calls. See P1-9 doc on
        // multi-view-skip-cache.ts for dead-loop rationale + TTL choice.
        try {
          const cacheFp = fingerprintCandidate(args.proposerDecision, args.candidate);
          // Best-effort: capture proposer slug shape for diagnostics.
          const proposerOp = args.proposerDecision.op;
          let proposerSlug = "";
          if ("slug" in args.proposerDecision && typeof args.proposerDecision.slug === "string") {
            proposerSlug = args.proposerDecision.slug;
          } else if ("target" in args.proposerDecision && typeof (args.proposerDecision as { target?: unknown }).target === "string") {
            proposerSlug = (args.proposerDecision as { target: string }).target;
          }
          writeSkipCacheEntry({
            fingerprint: cacheFp,
            ts: new Date().toISOString(),
            pass1_op: pass1.op,
            pass1_reasoning_snippet: pass1.reasoning
              ? pass1.reasoning.slice(0, 200)
              : undefined,
            proposer_op: proposerOp,
            ...(proposerSlug ? { proposer_slug: proposerSlug } : {}),
          });
        } catch {
          // best-effort; cache failure must not break multi-view
        }
      }
      break;
    }
    case "defer":
      // ADR 0028 Tier-1 (3×T0 unanimous 2026-06-08): a high-confidence
      // user-expressed durable CREATE directive must NEVER sit in the
      // probabilistic replay loop. defer→stage→replay can terminate in
      // terminal_max_retries → abandoned/, SILENTLY dropping the user's own
      // ground-truth directive (the exact silent-loss this subsystem exists
      // to kill — observed live with the gh-rule on 2026-06-08, where Pass 1
      // said scope=project, the curator said global, and Pass 2 deferred on
      // the split). shouldEscalateToCurator is the SAME deterministic
      // structural gate (provenance='user-expressed', read off a user-role
      // turn) that admitted this candidate to multi-view, so reusing it here
      // cannot widen the directive set. Committing the proposer decision is
      // byte-identical to the confirm_proposer arm; the proposer's
      // ruleScope/injectMode IS the scope encoded in the user's wording. A clash
      // with an existing rule = the user changed their mind → a later curator
      // supersede, never grounds to silently drop the latest ground truth.
      // FOLLOW-UP (tracked, separate arm): a KNOWLEDGE-zone directive can
      // still downscope world→project via confirm_pass1 (the pass1.scope line
      // in synthesizeFromPass1); rules creates are already scope-safe (W0.1),
      // so the live defer bug is fully closed here. Left for a focused
      // confirm_pass1 pass to avoid scope-creep into an unrelated verdict arm.
      if (shouldEscalateToCurator(args.correctionSignal)) {
        final_decision = args.proposerDecision;
        break;
      }
      // batch 3b: DEFER no longer maps to op=skip(multiview_deferred).
      // It now stages for replay (§4.4.5 staging-pending tier finally
      // implemented). Pass 1 and Pass 2 verdicts are both preserved so
      // replay can decide whether to re-run Pass 2 only (cheap) or
      // both passes (full refresh). 3c-i decides; 3b just records.
      return stageAndSkipDecision(
        args, "deferred", trigger.reason!,
        pass1, pass2,
        pass2.rationale ? `pass 2 deferred: ${pass2.rationale.slice(0, 200)}` : "pass 2 deferred without rationale",
        overallStart,
        args,
      );
  }

  return {
    triggered: true,
    trigger_reason: trigger.reason,
    final_decision,
    pass1,
    pass2,
    durationMs: Date.now() - overallStart,
  };
}
