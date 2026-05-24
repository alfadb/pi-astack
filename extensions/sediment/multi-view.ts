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
 *   - DEFER outcomes convert to op=skip with audit-flagged reason.
 *     Staging write-back for DEFER deferred to P3.5 full version.
 *   - No cost budget enforcement yet (settings field present;
 *     consumed in P3.5 along with rate-limit handling).
 *
 * NOT in P0.5 (deferred to P3.5):
 *
 *   - Dynamic provider selection / rate-limit handling
 *   - costBudgetPerOpUsd enforcement
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
import type { CorrectionSignal } from "./correction-pipeline";
import type { ProjectEntryDraft } from "./writer";
import type { SedimentSettings } from "./settings";
import type { ModelRegistryLike } from "./llm-extractor";
import { sanitizeForMemory } from "./sanitizer";

// ── Types ─────────────────────────────────────────────────────────────

export type MultiViewTriggerReason =
  | "create_high_confidence"
  | "create_world_scope"
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

export interface MultiViewResult {
  triggered: boolean;
  trigger_reason?: MultiViewTriggerReason;
  /** Final decision to use downstream. When pass2 verdict =
   *  confirm_proposer → equals input proposerDecision.
   *  confirm_pass1 → a CuratorDecision synthesized from Pass1Verdict
   *  (when synthesizable; otherwise op=skip with multiview audit).
   *  defer → op=skip with reason=multiview_deferred. */
  final_decision: CuratorDecision;
  pass1?: Pass1Verdict;
  pass2?: Pass2Verdict;
  /** When triggered but reviewer was unavailable / both passes failed. */
  error?: string;
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

async function callReviewerModel(
  ref: string,
  parsed: { provider: string; id: string },
  modelRegistry: ModelRegistryLike,
  prompt: string,
  settings: SedimentSettings,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) return { ok: false, error: `reviewer model not registered: ${ref}` };
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return { ok: false, error: `reviewer auth unavailable for ${ref}: ${auth.error ?? "no api key"}` };

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
    if (result.errorMessage || result.stopReason === "error" || result.stopReason === "aborted") {
      return { ok: false, error: result.errorMessage ?? result.stopReason ?? "reviewer call failed" };
    }
    const text = (result.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) return { ok: false, error: "reviewer returned empty text" };
    return { ok: true, text };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
      // (title/kind/compiledTruth) comes from the candidate the
      // writer already has. So we just emit a create with the
      // reviewer's scope choice.
      return {
        op: "create",
        ...(pass1.scope === "world" ? { scope: "world" as const } : {}),
        rationale: pass1.reasoning ?? "Pass 1 reviewer recommended create; Pass 2 confirmed.",
      };
    }
    case "archive": {
      if (!pass1.slug_target) return null;
      if (isWorkflowSlug(pass1.slug_target)) {
        return workflowLaneRefusal("archive", pass1.slug_target);
      }
      return {
        op: "archive",
        slug: pass1.slug_target,
        ...(pass1.scope === "world" ? { scope: "world" as const } : {}),
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

// ── Main entry ────────────────────────────────────────────────────────

/**
 * Run the multi-view pipeline. Caller MUST already have checked
 * shouldTriggerMultiView. We re-run that check here for safety but
 * primarily expect the check to be done upstream so curator can
 * audit `triggered: false` rows independently.
 *
 * Returns final_decision = proposerDecision when:
 *   - multi-view not triggered, OR
 *   - reviewer model unavailable (no audit advisory; falls back to proposer), OR
 *   - Pass 1 unparseable (audit-flagged), OR
 *   - Pass 2 unparseable (audit-flagged), OR
 *   - Pass 2 verdict = confirm_proposer
 *
 * Returns final_decision = synthesized from Pass 1 when:
 *   - Pass 2 verdict = confirm_pass1 AND Pass 1 is synthesizable
 *
 * Returns final_decision = op=skip(multiview_deferred) when:
 *   - Pass 2 verdict = defer
 *   - Pass 2 verdict = confirm_pass1 but Pass 1 not synthesizable
 *     (rich-payload op without writer-ready fields)
 */
export async function runMultiView(args: {
  proposerDecision: CuratorDecision;
  proposerRawText: string;
  candidate: ProjectEntryDraft;
  neighbors: MemoryEntry[];
  correctionSignal?: CorrectionSignal | null;
  settings: SedimentSettings;
  modelRegistry: ModelRegistryLike;
  signal?: AbortSignal;
}): Promise<MultiViewResult> {
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

  const reviewer = selectReviewerModel(args.settings, args.modelRegistry);
  if (!reviewer) {
    return {
      triggered: true,
      trigger_reason: trigger.reason,
      final_decision: args.proposerDecision,
      error: "no_reviewer_model_available",
      durationMs: Date.now() - overallStart,
    };
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
    args.modelRegistry, pass1Prompt, args.settings, args.signal,
  );
  const pass1DurationMs = Date.now() - pass1Start;

  if (!pass1Resp.ok) {
    return {
      triggered: true,
      trigger_reason: trigger.reason,
      final_decision: args.proposerDecision,
      error: `pass1_call_failed: ${pass1Resp.error}`,
      durationMs: Date.now() - overallStart,
    };
  }

  const pass1 = parsePass1(pass1Resp.text, reviewer.ref, pass1DurationMs);
  if (!pass1) {
    return {
      triggered: true,
      trigger_reason: trigger.reason,
      final_decision: args.proposerDecision,
      error: "pass1_unparseable",
      pass1: {
        op: "<unparseable>",
        raw: pass1Resp.text,
        model: reviewer.ref,
        durationMs: pass1DurationMs,
      },
      durationMs: Date.now() - overallStart,
    };
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
    args.modelRegistry, pass2Prompt, args.settings, args.signal,
  );
  const pass2DurationMs = Date.now() - pass2Start;

  if (!pass2Resp.ok) {
    return {
      triggered: true,
      trigger_reason: trigger.reason,
      final_decision: args.proposerDecision,
      pass1,
      error: `pass2_call_failed: ${pass2Resp.error}`,
      durationMs: Date.now() - overallStart,
    };
  }

  const pass2 = parsePass2(pass2Resp.text, reviewer.ref, pass2DurationMs);
  if (!pass2) {
    return {
      triggered: true,
      trigger_reason: trigger.reason,
      final_decision: args.proposerDecision,
      pass1,
      pass2: {
        verdict: "confirm_proposer",
        raw: pass2Resp.text,
        model: reviewer.ref,
        durationMs: pass2DurationMs,
      },
      error: "pass2_unparseable",
      durationMs: Date.now() - overallStart,
    };
  }

  // ── Resolve final decision ──
  let final_decision: CuratorDecision;
  switch (pass2.verdict) {
    case "confirm_proposer":
      final_decision = args.proposerDecision;
      break;
    case "confirm_pass1": {
      const synthesized = synthesizeFromPass1(pass1, args.neighbors);
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
      }
      break;
    }
    case "defer":
      final_decision = {
        op: "skip",
        reason: "multiview_deferred",
        rationale: pass2.rationale
          ? `Pass 2 deferred: ${pass2.rationale.slice(0, 500)}`
          : "Pass 2 deferred without rationale.",
      };
      break;
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
