/**
 * correction-pipeline — ADR 0025 P1 active correction classifier.
 *
 * Runs at agent_end in Lane C, after extractor, before curator.
 * Detects natural-language correction signals in the conversation
 * and either:
 *   - Attaches the signal to curator context (for durable corrections)
 *   - Writes provisional staging entry (when no target entry found)
 *   - Records audit-only (task-local / debug / NOT-A-CORRECTION)
 *
 * P1 scope: classifier LLM call + staging write + curator injection.
 * P4 adds multi-view verification for conf≥8 signals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { sanitizeForMemory } from "./sanitizer";
import { packClassifierWindow, packedWindowToText, type PackedWindow } from "./context-packer";
import { type ProvenanceClass } from "./validation";
import { loadStagingContext, writeStagingEntry, stagingActiveFileCount } from "./staging-loader";
import type { StagingEntry } from "./staging-types";
import type { SedimentSettings } from "./settings";
import type { ModelRegistryLike } from "./llm-extractor";

// ── Types ─────────────────────────────────────────────────────────────

/** #1 routing predicate (T0 consensus 2026-06-07): a high-confidence
 *  USER-EXPRESSED durable CREATE signal — the user literally stated it (a
 *  verbatim quote), typed durable, with no existing entry to UPDATE, at
 *  confidence ≥ 8. This is MAXIMALLY attributable, so it escalates to the full
 *  curator + multi-view lane (full-fidelity promotion, incl. zone:rules) instead
 *  of being parked as an unattributable provisional-staging hypothesis. */
export function shouldEscalateToCurator(signal: CorrectionSignal | null | undefined): boolean {
  // Tier-1 predicate (ADR 0028 v1.1 R2'): a high-confidence USER-EXPRESSED
  // durable CREATE. provenance==='user-expressed' is the DETERMINISTIC structural
  // gate (verbatim quote grounded in a user-role turn, computed from turn.role) —
  // it replaces the old fragile `user_quote.length > 0` heuristic and structurally
  // blocks the README/tool 'always use Yarn' content-in-transcript trap.
  return !!signal?.signal_found
    && signal.typing === "durable"
    && !signal.target_entry_slug
    && (signal.confidence ?? 0) >= 8
    && signal.provenance === "user-expressed";
}

export interface CorrectionSignal {
  signal_found: boolean;
  typing?: "durable" | "task-local" | "debug";
  scope_description?: string;
  correction_intent?: string;
  confidence?: number;
  /** Verbatim quote from the user (step 1) */
  user_quote?: string;
  /** Surrounding context (≥3 lines) */
  surrounding_context?: string;
  /** Most likely error direction (step 6) */
  most_likely_error?: string;
  /** Slug of the entry this signal targets, if found */
  target_entry_slug?: string | null;
  /** When no target entry found: natural-language resolution hypothesis */
  resolution_hypothesis?: string | null;
  /** Raw reasoning from the LLM (1-2 sentence summary for signal_found=false) */
  reasoning?: string;
  /** Full 7-step reasoning trace from the classifier (ADR 0024 §5.1).
   *  Preserved for curator context injection and aggregator quality detection. */
  reasoning_trace?: Record<string, unknown>;
  /** AX-PROVENANCE (ADR 0028 v1.1): which transcript role the verbatim user_quote
   *  came from — derived DETERMINISTICALLY from packed turn.role, NOT from the LLM.
   *  user_message = attested user directive; transcript_content = tool/file content
   *  (e.g. a README "always use Yarn" — the content-in-transcript trap). */
  quote_source?: "user_message" | "transcript_content" | "assistant" | "absent";
  /** AX-PROVENANCE class (ground-truth strength). Tier-1 (deterministic rule
   *  commit) is the predicate provenance==='user-expressed' ∧ directive ∧ durable. */
  provenance?: ProvenanceClass;
}

/** Lightweight entry card for classifier target identification.
 *  Carries title + scope summary so the LLM can judge
 *  "is this correction updating an existing entry?" without
 *  seeing full entry bodies (token budget). */
export interface RelatedEntryCard {
  slug: string;
  title?: string;
  scope?: string;
  kind?: string;
  status?: string;
  /** ≤150 chars of compiled_truth for context */
  summary?: string;
  /** P2.A (ADR 0025 §4.2.5): per-entry, PROJECT-SCOPED outcome track record.
   *  Attached by the caller ONLY when the entry has real ledger data
   *  (last_seen or any count > 0). Absent ⇒ classifier treats as no signal.
   *  Used to DISCOUNT the entry's apparent authority, never to raise
   *  correction confidence by itself (see classifier prompt guidance). */
  outcome_activity?: {
    decisive: number;
    confirmatory: number;
    retrieved_unused: number;
    possible_echo_chamber: boolean;
    last_seen?: string;
  };
}

export interface CorrectionPipelineResult {
  ok: boolean;
  model: string;
  signal: CorrectionSignal | null;
  error?: string;
  durationMs: number;
  /** Whether a staging provisional was written */
  stagingWritten: boolean;
  /** Staging inflation advisory */
  stagingAdvisory?: string;
  /** #1 (T0 consensus 2026-06-07): a high-confidence USER-EXPRESSED durable
   *  CREATE signal (no target entry to update) that should ESCALATE to the full
   *  curator + multi-view lane for full-fidelity promotion (incl. zone:rules),
   *  instead of being parked as a lossy provisional-staging hypothesis. The
   *  short-window classifier-only lane reads this to upgrade the window. */
  escalateToCurator?: boolean;
}

// ── Prompt ─────────────────────────────────────────────────────────────

let _classifierPromptCache: string | null = null;

function loadClassifierPrompt(): string {
  if (_classifierPromptCache) return _classifierPromptCache;
  // ADR 0025 §4.1.3 + §4.4.2: prepend reasoning-normalization-preamble so the
  // classifier's reasoning surface is comparable to multi-view pass-1/2 output
  // when the latter ships. Loading order is preamble → separator → task prompt.
  // Both files are cached on first call; bumping either's version requires
  // a process restart for the cache to refresh.
  const preamblePath = path.join(__dirname, "prompts", "reasoning-normalization-preamble-v1.md");
  const taskPath = path.join(__dirname, "prompts", "active-correction-classifier-v1.md");
  const preamble = fs.readFileSync(preamblePath, "utf-8");
  const taskPrompt = fs.readFileSync(taskPath, "utf-8");
  _classifierPromptCache = `${preamble}\n\n---\n\n${taskPrompt}`;
  return _classifierPromptCache;
}

function buildClassifierPrompt(args: {
  windowText: string;
  stagingContext: StagingEntry[];
  relatedEntries: RelatedEntryCard[];
}): string {
  const prompt = loadClassifierPrompt();
  const stagingBlock = args.stagingContext.length > 0
    ? [
        "=== PENDING STAGING HYPOTHESES — NOT EVIDENCE ===",
        "These are UNCONFIRMED guesses from previous classifier runs.",
        "They are NOT user-confirmed facts.",
        "Do NOT use them as supporting evidence for durable/task-local/debug.",
        "Use them ONLY to answer this question:",
        '"Does the current utterance RESOLVE, REFUTE, or leave UNRESOLVED this guess?"',
        "",
        ...args.stagingContext.map((s) =>
          [
            `staging_slug: ${s.slug}`,
            `hypothesis: ${s.hypothesis}`,
            `created: ${s.created}`,
            s.correction_signal?.most_likely_error_direction
              ? `why_uncertain: ${s.correction_signal.most_likely_error_direction}` : "",
            `valid_use: detect if current utterance resolves/refutes/leaves this guess.`,
            "",
          ].filter(Boolean).join("\n")
        ),
      ].join("\n")
    : "=== PENDING STAGING HYPOTHESES ===\n(none)";

  const relatedBlock = args.relatedEntries.length > 0
    ? [
        "=== RELATED MEMORY ENTRIES ===",
        "For target_entry_slug identification: prefer an entry whose",
        "title/scope/summary overlaps the user's quoted words.",
        "A bare slug without content match is a weak hint — prefer null.",
        "",
        "track-record (when present) = this entry's recent outcome history in THIS",
        "project. Use it to DISCOUNT the entry's apparent authority, NOT to raise",
        "correction confidence by itself:",
        "  - high retrieved-unused, or ⚠️possible-echo-chamber → don't treat this",
        "    entry as a clear current preference (it may be stale, or recent decisive",
        "    marks may be assistant self-reinforcement, not user reconfirmation).",
        "  - BUT a durable correction still requires the user's current words to",
        "    conflict with the entry's content — track-record never replaces content match.",
        "  - (none recorded) = no signal; judge normally.",
        "",
        ...args.relatedEntries.map((e) =>
          [
            `- slug: ${e.slug}`,
            e.title ? `  title: ${e.title}` : "",
            e.kind || e.status ? `  kind/status: ${[e.kind, e.status].filter(Boolean).join(" / ")}` : "",
            e.scope ? `  scope: ${e.scope}` : "",
            e.summary ? `  summary: ${e.summary}` : "",
            e.outcome_activity
              ? `  track-record: decisive×${e.outcome_activity.decisive} confirmatory×${e.outcome_activity.confirmatory} retrieved-unused×${e.outcome_activity.retrieved_unused}${e.outcome_activity.possible_echo_chamber ? " ⚠️possible-echo-chamber" : ""}${e.outcome_activity.last_seen ? ` last_seen=${e.outcome_activity.last_seen.slice(0, 10)}` : ""}`
              : "  track-record: (none recorded)",
          ].filter(Boolean).join("\n")
        ),
      ].join("\n")
    : "=== RELATED MEMORY ENTRIES ===\n(none)";

  return [
    prompt,
    "",
    stagingBlock,
    "",
    relatedBlock,
    "",
    "Transcript window:",
    "<<<PI_SEDIMENT_WINDOW",
    args.windowText,
    "PI_SEDIMENT_WINDOW>>>",
    "",
    "Follow the OUTPUT section in the prompt above for the exact JSON schema.",
    "Do NOT add or remove fields from the schema shown in the prompt.",
  ].join("\n");
}

/** Test-only: expose prompt assembly so smoke can assert the RELATED block
 *  renders the P2.A track-record line + discount guidance. */
export const _buildClassifierPromptForTests = buildClassifierPrompt;

// ── Parsing ────────────────────────────────────────────────────────────

/**
 * Normalize text for register-insensitive provenance containment. CRITICAL
 * (audit P1 2026-06-07): the classifier's user_quote is a quote of the
 * SANITIZED window (IPs->[HOST], emails->[EMAIL], creds redacted), so the raw
 * turn text must be sanitized the SAME way before the substring test — otherwise
 * a user directive mentioning an IP/email never matches its own user turn and is
 * silently demoted out of Tier-1. Also lowercase + strip whitespace to absorb
 * casing/spacing drift in the LLM's "verbatim" quote.
 */
function normWsForProvenance(s: string): string {
  const sanitized = sanitizeForMemory(s).text ?? s;
  return sanitized.toLowerCase().replace(/\s+/g, "");
}

/**
 * AX-PROVENANCE (ADR 0028 v1.1 R2'): deterministically classify where the
 * classifier's verbatim user_quote actually occurs in the packed window, by
 * scanning turn.role — NO LLM judgment. This is the structural source gate that
 * lets the Tier-1 deterministic rule path distinguish a user directive from
 * README/tool content masquerading as one. user-role match wins over
 * tool/assistant (the user saying it is the strongest signal).
 */
export function deriveProvenance(
  packed: PackedWindow,
  userQuote: string | undefined,
): { quote_source: NonNullable<CorrectionSignal["quote_source"]>; provenance: ProvenanceClass } {
  const q = normWsForProvenance((userQuote ?? "").trim());
  if (!q) return { quote_source: "absent", provenance: "assistant-observed" };
  let inUser = false, inTranscript = false, inAssistant = false;
  for (const t of packed.turns) {
    if (!normWsForProvenance(t.text).includes(q)) continue;
    const r = t.role.toLowerCase();
    if (r === "user") inUser = true;
    else if (r === "toolresult" || r === "bashexecution" || r === "tool" || r === "system") inTranscript = true;
    else if (r === "assistant") inAssistant = true;
  }
  if (inUser) return { quote_source: "user_message", provenance: "user-expressed" };
  if (inTranscript) return { quote_source: "transcript_content", provenance: "content-in-transcript" };
  if (inAssistant) return { quote_source: "assistant", provenance: "assistant-observed" };
  return { quote_source: "absent", provenance: "assistant-observed" };
}

function parseCorrectionSignal(raw: string): CorrectionSignal | null {
  // Try JSON fence (non-greedy, stops at first closing ```)
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  const body = jsonMatch?.[1]?.trim() ?? raw.match(/(\{[\s\S]*\})/)?.[1]?.trim();
  if (!body) return null;

  try {
    const p = JSON.parse(body);
    return {
      signal_found: p.signal_found ?? false,
      typing: p.typing,
      scope_description: p.scope_description,
      correction_intent: p.correction_intent,
      confidence: typeof p.confidence === "number" ? p.confidence : undefined,
      user_quote: p.user_quote,
      surrounding_context: p.surrounding_context,
      most_likely_error: p.most_likely_error,
      target_entry_slug: p.target_entry_slug ?? null,
      resolution_hypothesis: p.resolution_hypothesis ?? null,
      reasoning: p.reasoning,
      // Preserve full reasoning trace for curator/aggregator (ADR 0024 §3.3).
      // No schema validation — whole trace is passed through for downstream LLMs to read.
      reasoning_trace: p.reasoning_trace && typeof p.reasoning_trace === "object" ? p.reasoning_trace as Record<string, unknown> : undefined,
    };
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function hash8(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function sanitizeAuditText(text: string | undefined, maxLen: number): string {
  if (!text) return "";
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "...";
}

// ── Main ───────────────────────────────────────────────────────────────

/**
 * Run the correction classifier pipeline.
 *
 * @param branchEntries — full branch for window packing
 * @param relatedEntries — entry cards (slug+title+scope+summary) from memory_search
 * @param deps
 */
export async function runCorrectionPipeline(
  branchEntries: unknown[],
  relatedEntries: RelatedEntryCard[],
  deps: {
    settings: SedimentSettings;
    modelRegistry: ModelRegistryLike;
    signal?: AbortSignal;
  },
): Promise<CorrectionPipelineResult> {
  const start = Date.now();

  if (!deps.modelRegistry || typeof deps.modelRegistry.find !== "function" || typeof deps.modelRegistry.getApiKeyAndHeaders !== "function") {
    const modelRef = deps.settings.classifierModel || deps.settings.extractorModel;
    return {
      ok: false,
      model: modelRef,
      signal: null,
      error: "model_registry_unavailable",
      durationMs: Date.now() - start,
      stagingWritten: false,
    };
  }

  // 1. Pack conversation window
  const packed = packClassifierWindow(branchEntries);
  const windowText = packedWindowToText(packed);

  // 2. Load staging context
  const stagingCtx = loadStagingContext();

  // 3. Pre-sanitize
  const sanitizeResult = sanitizeForMemory(windowText);
  // Resolve model ref early for consistent error model references.
  const modelRef = deps.settings.classifierModel || deps.settings.extractorModel;
  if (!sanitizeResult.ok) {
    return {
      ok: false, model: modelRef, signal: null,
      error: "pre-sanitize failed", durationMs: Date.now() - start, stagingWritten: false,
    };
  }

  // P1 uses dedicated classifierModel (v4-flash by default — classification
  // is a reading-comprehension task, not reasoning).
  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    return {
      ok: false, model: modelRef, signal: null,
      error: `invalid classifierModel: ${modelRef}`, durationMs: Date.now() - start, stagingWritten: false,
    };
  }

  const model = deps.modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return {
      ok: false, model: modelRef, signal: null,
      error: "model not found", durationMs: Date.now() - start, stagingWritten: false,
    };
  }

  const auth = await deps.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      ok: false, model: modelRef, signal: null,
      error: auth.error ?? "auth unavailable", durationMs: Date.now() - start, stagingWritten: false,
    };
  }

  // 4. Build prompt + call LLM
  const prompt = buildClassifierPrompt({
    windowText: sanitizeResult.text ?? windowText,
    stagingContext: stagingCtx.entries,
    relatedEntries,
  });
  const promptSanitize = sanitizeForMemory(prompt);
  if (!promptSanitize.ok) {
    return {
      ok: false, model: modelRef, signal: null,
      error: promptSanitize.error || "classifier prompt sanitize failed", durationMs: Date.now() - start, stagingWritten: false,
    };
  }

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
      { messages: [{ role: "user", content: [{ type: "text", text: promptSanitize.text ?? prompt }] }] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: deps.signal, timeoutMs: deps.settings.classifierTimeoutMs, maxRetries: 0 },
    );

    const result = await stream.result();
    if (result.errorMessage) {
      return {
        ok: false, model: modelRef, signal: null,
        error: sanitizeAuditText(result.errorMessage, 500), durationMs: Date.now() - start, stagingWritten: false,
      };
    }
    rawText = result.content?.map((c) => c.type === "text" ? c.text : "").join("") ?? "";
  } catch (e: unknown) {
    return {
      ok: false, model: modelRef, signal: null,
      error: sanitizeAuditText(e instanceof Error ? e.message : String(e), 500),
      durationMs: Date.now() - start, stagingWritten: false,
    };
  }

  // 5. Parse signal + stamp AX-PROVENANCE deterministically from the packed
  // window's turn.role (R2' structural source gate; no LLM judgment).
  const signal = parseCorrectionSignal(rawText);
  if (signal) {
    const pv = deriveProvenance(packed, signal.user_quote);
    signal.quote_source = pv.quote_source;
    signal.provenance = pv.provenance;
  }

  const result: CorrectionPipelineResult = {
    ok: true,
    model: modelRef,
    signal,
    durationMs: Date.now() - start,
    stagingWritten: false,
  };

  // 6. Resolve durable + no-target signals.
  // #1 (T0 consensus 2026-06-07): a high-confidence USER-EXPRESSED durable create
  // ESCALATES to the full curator + multi-view lane so the short-window path can
  // promote it at FULL fidelity (incl. zone:rules) instead of relying on a lossy
  // flattened hypothesis. AUDIT P0 FOLLOW-UP (2026-06-07): the consensus also
  // wanted to SUPPRESS the staging write for this class, but the curator path is
  // NOT guaranteed to promote (extractor miss / curator skip / llm_error), so
  // suppressing the only fallback risked SILENT LOSS — fatal in a second brain.
  // We KEEP the staging write as a no-loss SAFETY NET; escalation is the
  // high-fidelity primary path, staging is the fallback, and #2 write-time dedup
  // stops the staged entry from later producing a duplicate rule.
  if (shouldEscalateToCurator(signal)) result.escalateToCurator = true;
  if (signal?.signal_found && signal.typing === "durable" && !signal.target_entry_slug) {
    const stagingEntry: StagingEntry = {
      slug: `provisional-${hash8(signal.user_quote ?? rawText)}`,
      status: "provisional",
      kind: "provisional-correction",
      created: new Date().toISOString(),
      attribution_pending: true,
      originating_device: process.env.HOSTNAME ?? "unknown",
      hypothesis: signal.resolution_hypothesis ?? signal.scope_description ?? signal.correction_intent ?? "unknown correction signal",
      source_utterance: [{
        quote: signal.user_quote ?? "",
        context: signal.surrounding_context ?? "",
        captured_at: new Date().toISOString(),
      }],
      suggested_resolution_paths: [
        "search-related-with-different-keywords",
        "wait-for-next-utterance-with-stronger-attribution",
        "reviewer-decide-via-archive-reactivation-prompt",
      ],
      correction_signal: {
        typing: signal.typing ?? "durable",
        confidence: signal.confidence ?? 5,
        scope_description: signal.scope_description ?? "",
        correction_intent: signal.correction_intent ?? "",
        most_likely_error_direction: signal.most_likely_error ?? "",
      },
      _provenance_warning:
        "PROVISIONAL CLASSIFIER GUESS. Do NOT treat as ground truth. " +
        "The only valid use is to RESOLVE this guess (promote / attribute / refute) or let it age.",
    };
    // stagingWritten reflects ACTUAL IO success (audit P0 2026-06-07): the
    // short-window escalation holds its checkpoint when the safety net did not
    // persist, so this must not optimistically report true on a failed write.
    result.stagingWritten = writeStagingEntry(stagingEntry);
  }

  // 7. Staging inflation advisory — counts ACTIVE files only (Stage 4: exclude
  // age-out soft-archived, which are already retired and only await the
  // deferred Stage-5 hard-delete; counting them would fire this advisory
  // perpetually as retired files accumulate, falsely implying over-production).
  const fileCount = stagingActiveFileCount();
  if (fileCount > 50) {
    result.stagingAdvisory = `staging dir has ${fileCount} active files (>50). Classifier may be over-producing provisional hypotheses.`;
  }

  return result;
}

/** Re-export for backward compat with existing fire-and-forget call sites. */
export { runCorrectionPipeline as runCorrectionClassifier };
