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
import { isGoalContinuationText } from "../_shared/goal-continuation";
import { packClassifierWindow, packedWindowToText, type PackedWindow } from "./context-packer";
import { type ProvenanceClass } from "./validation";
import { loadStagingContext, writeStagingEntry, stagingActionableFileCount } from "./staging-loader";
import type { StagingEntry } from "./staging-types";
import type { SedimentSettings } from "./settings";
import type { ModelRegistryLike } from "./llm-extractor";

// ── Classifier rate-limit retry helpers (C, 2026-06-18) ───────────────
// The correction classifier runs once per agent_end. A single transient
// upstream 429 used to silently drop the whole turn's correction signal
// (observed: a durable user correction lost to one rate-limit hit). Retry
// rate-limit errors with bounded exponential backoff before failing. This is
// a background pipeline, so the added latency never blocks the user.
const CLASSIFIER_RATE_LIMIT_MAX_RETRIES = 3;
const CLASSIFIER_RATE_LIMIT_BASE_MS = 800;
function classifierSleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function classifierBackoffMs(attempt: number): number { return CLASSIFIER_RATE_LIMIT_BASE_MS * Math.pow(2, attempt); }
function isRateLimitError(msg: string): boolean {
  const m = (msg || "").toLowerCase();
  return m.includes("429") || m.includes("rate limit") || m.includes("rate_limit") || m.includes("too many requests");
}

// ── Types ─────────────────────────────────────────────────────────────

/** Tier-1 routing predicate (ADR 0028 v1.1 R2', O5-converged form per
 *  docs/audits/2026-06-10-goal-workflow-impl-plan.md PR-2 + PR-A3):
 *
 *    signal_found ∧ typing=durable ∧ provenance==='user-expressed'
 *    ∧ (is_directive ∨ (confidence ≥ 8 ∧ no update target))
 *
 *  provenance==='user-expressed' is the DETERMINISTIC structural gate
 *  (verbatim quote grounded in a user-role turn, computed from turn.role) —
 *  it replaces the old fragile `user_quote.length > 0` heuristic and
 *  structurally blocks the README/tool 'always use Yarn'
 *  content-in-transcript trap.
 *
 *  `is_directive` (recall-biased, classifier prompt v2) EXEMPTS the
 *  confidence gate: a user-role imperative commits deterministically.
 *  Over-promotion is bounded (R3' tell surface + cheap user veto + R4'
 *  outcome edge); under-detection is SILENT loss — asymmetric cost,
 *  asymmetric threshold (R2').
 *
 *  SUNSET NOTE (impl plan §O5, F2 audit 2026-06-12): the `confidence >= 8`
 *  fallback for NON-directive durable signals is a transitional deviation
 *  from R2''s "iff" definition, retained only for no-target migration safety.
 *  Its measurable removal condition is: over the audit review window,
 *  tier1_direct_write rows with is_directive!==true and confidence>=8 no
 *  longer produce accepted user corrections / recall misses. Then remove the
 *  fallback and return to the ADR-literal predicate. */
export function isTier1Directive(signal: CorrectionSignal | null | undefined): boolean {
  // PR-A3 (F6, 2026-06-12 计划附录A v1.1, 3×T0 APPROVE): `!target_entry_slug`
  // is no longer a global exclusion conjunct — a user-role imperative that the
  // classifier attributed to an existing KNOWLEDGE entry (rules are excluded
  // from the search corpus, so target can never be a rule) is still a Tier-1
  // directive: the directive itself commits deterministically as a rule
  // (near-dup with existing rules handled by the Jaccard gate/adjudicator),
  // while the targeted entry's lifecycle stays with the Tier-2 curator (it
  // receives the signal as context via the PR-A2 follow-up).
  // The conf≥8 transitional fallback KEEPS `!target`: a high-confidence
  // NON-directive durable signal with a target is typically a memory-
  // management correction ("你怎么记成 Y 了") whose correct destination is a
  // curator entry fix, not a new rule (附录A A.3.1).
  return !!signal?.signal_found
    && signal.typing === "durable"
    && signal.provenance === "user-expressed"
    && (signal.is_directive === true
      || ((signal.confidence ?? 0) >= 8 && !signal.target_entry_slug));
}

/** #1 routing predicate — retained name for the dispatch call sites and
 *  smokes; semantics now live in isTier1Directive() (PR-2 kept this as a
 *  pure alias so the predicate has ONE definition; deepseek R1 A1 asked
 *  for a separate canonical function instead of widening this one). */
export function shouldEscalateToCurator(signal: CorrectionSignal | null | undefined): boolean {
  return isTier1Directive(signal);
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
  /** R2' (ADR 0028, classifier prompt v2): imperative/prescriptive mood
   *  aimed at assistant behavior (祈使语气), RECALL-BIASED in the prompt.
   *  Orthogonal to `typing` (mood vs time-scope). Exempts the confidence
   *  gate in isTier1Directive(); see the sunset note there. */
  is_directive?: boolean;
  /** PR-3/P0.2 (ADR 0028 §6): deterministic quote-match diagnostics set by
   *  deriveProvenance — NOT from the LLM. multi_match=true when the quote
   *  matched >1 turn. matched_roles is ALWAYS set when the quote was found
   *  (single-role included); multi-role → provenance was already
   *  fail-closed out of user-expressed upstream (deepseek R1 N3). */
  quote_multi_match?: boolean;
  quote_matched_roles?: Array<"user" | "transcript" | "assistant">;
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
  /** Related-entry retrieval quality from correctionSearch. Low confidence means
   *  stage2 found no confident match and the card came from stage0 ordering. */
  retrieval_low_confidence?: boolean;
  retrieval_degraded?: boolean;
  retrieval_verdict?: "has_relevant" | "none" | "unknown";
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
  /** F1 (2026-06-12 audit fix plan PR-A1): classifier returned text that did
   *  not parse as a CorrectionSignal JSON — a TRANSIENT failure class distinct
   *  from "no signal". Carried into the correction_classifier audit row as
   *  `parse_error: true` so a prompt/parse regression is observable instead of
   *  silently zeroing recall (ADR 0028 B3-class silent loss). */
  parseError?: boolean;
  durationMs: number;
  /** Whether a staging provisional was written */
  stagingWritten: boolean;
  /** Staging inflation advisory */
  stagingAdvisory?: string;
  /** ADR 0028 R6': set when the durable signal skipped the staging net because
   *  the deterministic Tier-1 direct lane owns it (§8 drift-signal observability:
   *  "staging 又开始堆积 durable 条目" needs its inverse visible too). */
  stagingSuppressedReason?: "tier1_direct_lane";
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
  const taskPath = path.join(__dirname, "prompts", "active-correction-classifier-v2.md");
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
        "retrieval-quality (when present) describes how the related entry was found:",
        "  - low_confidence=true means stage2 found no confident match; treat the entry as a weak hint and prefer target_entry_slug=null unless the quoted words strongly match the entry content.",
        "  - degraded=true means embedding retrieval fell back to sparse-only; recall may be incomplete.",
        "  - (none recorded) = no signal; judge normally.",
        "",
        ...args.relatedEntries.map((e) =>
          [
            `- slug: ${e.slug}`,
            e.title ? `  title: ${e.title}` : "",
            e.kind || e.status ? `  kind/status: ${[e.kind, e.status].filter(Boolean).join(" / ")}` : "",
            e.scope ? `  scope: ${e.scope}` : "",
            e.summary ? `  summary: ${e.summary}` : "",
            e.retrieval_low_confidence || e.retrieval_degraded || e.retrieval_verdict
              ? `  retrieval-quality: verdict=${e.retrieval_verdict ?? "unknown"}${e.retrieval_low_confidence ? " low_confidence=true" : ""}${e.retrieval_degraded ? " degraded=true" : ""}`
              : "  retrieval-quality: (none recorded)",
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
 * AX-PROVENANCE (ADR 0028 v1.1 R2' + §6 unique-turn mapping; PR-3/P0.2
 * 2026-06-10): deterministically classify where the classifier's verbatim
 * user_quote actually occurs in the packed window, by scanning turn.role —
 * NO LLM judgment. This is the structural source gate that lets the Tier-1
 * deterministic rule path distinguish a user directive from README/tool
 * content masquerading as one.
 *
 * UNIQUE-TURN MAPPING (supersedes the pre-PR-3 "user-role match wins"
 * priority): a quote matching turns of DIFFERENT role classes is
 * role-AMBIGUOUS → fail-closed OUT of user_message (ADR 0028 §6 "跨多
 * turn 的 quote → fail-closed → Tier-2"). The demote target is
 * deterministic: transcript beats assistant — content-in-transcript is
 * the conservative sink for the README-trap class. A quote matching
 * MULTIPLE turns of the SAME user role stays user_message: role
 * derivation is unambiguous, and a repeated statement is a stronger
 * signal, not a weaker one (impl-plan v2.1 收敛解释; multi_match=true
 * surfaces it for audit).
 *
 * ACCEPTED RECALL COST (visible, not silent): an assistant ECHO of a
 * user directive ("好的，以后用 pnpm") makes the quote match both roles
 * → demoted to Tier-2 here; the R3' transcript-keyed recall audit still
 * flags the uncovered user-role imperative in the same turn, so the
 * loss surfaces as a recall flag rather than disappearing. Walk-back
 * hook (impl-plan v2.1 P0.2): if recall flags cluster on this echo
 * pattern in dogfood, revisit the cross-role rule.
 *
 * MATCHING SEMANTICS NOTE (deepseek R1 N1): containment is normalized
 * SUBSTRING inclusion — a short quote can hit a longer turn with the
 * opposite stance ("use pnpm" ⊂ "don't use pnpm"). Classifier quotes are
 * usually long enough to make this rare, and the failure direction is
 * fail-closed (extra demote), never a spurious Tier-1 promote.
 */
export function deriveProvenance(
  packed: PackedWindow,
  userQuote: string | undefined,
): {
  quote_source: NonNullable<CorrectionSignal["quote_source"]>;
  provenance: ProvenanceClass;
  /** True when the quote matched MORE THAN ONE turn (any roles). */
  multi_match?: boolean;
  /** Role classes the quote matched, for audit forensics. */
  matched_roles?: Array<"user" | "transcript" | "assistant">;
} {
  const q = normWsForProvenance((userQuote ?? "").trim());
  if (!q) return { quote_source: "absent", provenance: "assistant-observed" };
  let userHits = 0, transcriptHits = 0, assistantHits = 0;
  for (const t of packed.turns) {
    if (!normWsForProvenance(t.text).includes(q)) continue;
    const r = t.role.toLowerCase();
    // PR-7 provenance isolation (impl-plan §P1 hard-constraint 2a,
    // INV-IMPLICIT-GROUND-TRUTH): a goal auto-continue message rides the
    // USER role but its content is machine-composed (goal judge
    // next_step). The `[pi-goal-continuation ...]` prefix is the only
    // signal that survives into the packed transcript (event.source does
    // not), so demote such turns to the assistant-origin bucket
    // deterministically. Fail-closed: a user FORGING the prefix only
    // demotes their own directive (R3' recall flag surfaces it).
    if (r === "user" && isGoalContinuationText(t.text)) assistantHits++;
    else if (r === "user") userHits++;
    else if (r === "toolresult" || r === "bashexecution" || r === "tool" || r === "system") transcriptHits++;
    else if (r === "assistant") assistantHits++;
  }
  const matchedRoles: Array<"user" | "transcript" | "assistant"> = [];
  if (userHits > 0) matchedRoles.push("user");
  if (transcriptHits > 0) matchedRoles.push("transcript");
  if (assistantHits > 0) matchedRoles.push("assistant");
  const totalHits = userHits + transcriptHits + assistantHits;
  if (matchedRoles.length > 1) {
    // Cross-role ambiguity → fail-closed out of user_message (§6).
    return transcriptHits > 0
      ? { quote_source: "transcript_content", provenance: "content-in-transcript", multi_match: true, matched_roles: matchedRoles }
      : { quote_source: "assistant", provenance: "assistant-observed", multi_match: true, matched_roles: matchedRoles };
  }
  if (userHits > 0) {
    return {
      quote_source: "user_message", provenance: "user-expressed",
      ...(totalHits > 1 ? { multi_match: true } : {}), matched_roles: matchedRoles,
    };
  }
  if (transcriptHits > 0) return { quote_source: "transcript_content", provenance: "content-in-transcript", ...(totalHits > 1 ? { multi_match: true } : {}), matched_roles: matchedRoles };
  if (assistantHits > 0) return { quote_source: "assistant", provenance: "assistant-observed", ...(totalHits > 1 ? { multi_match: true } : {}), matched_roles: matchedRoles };
  return { quote_source: "absent", provenance: "assistant-observed" };
}

function parseCorrectionSignal(raw: string): CorrectionSignal | null {
  // Try JSON fence (non-greedy, stops at first closing ```)
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  const body = jsonMatch?.[1]?.trim() ?? raw.match(/(\{[\s\S]*\})/)?.[1]?.trim();
  if (!body) return null;

  try {
    const p = JSON.parse(body);
    if (!p || typeof p !== "object" || typeof p.signal_found !== "boolean") return null;
    return {
      signal_found: p.signal_found,
      typing: p.typing,
      scope_description: p.scope_description,
      correction_intent: p.correction_intent,
      confidence: typeof p.confidence === "number" ? p.confidence : undefined,
      user_quote: p.user_quote,
      surrounding_context: p.surrounding_context,
      most_likely_error: p.most_likely_error,
      target_entry_slug: p.target_entry_slug ?? null,
      resolution_hypothesis: p.resolution_hypothesis ?? null,
      // R2' (prompt v2): boolean passthrough only — any non-boolean shape
      // (string "true", number) stays undefined so the predicate's
      // `is_directive === true` check fails closed to the conf≥8 fallback.
      is_directive: typeof p.is_directive === "boolean" ? p.is_directive : undefined,
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

/** F11 (PR-C): deterministic slug shared by staging write and post-Tier-1
 * cleanup. Keyed on the same quote/seed material as buildProvisionalStagingEntry
 * so a later direct write can remove the older staging twin. */
export function buildProvisionalStagingSlug(signal: Pick<CorrectionSignal, "user_quote">, seedText: string): string {
  return `provisional-${hash8(signal.user_quote ?? seedText)}`;
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
/** Provisional staging capture for a durable correction signal. R6': only
 *  for signals the Tier-1 direct lane does NOT own this turn — genuinely
 *  uncertain Tier-2 hypotheses, unattributable signals, explicit/about_me/
 *  in-flight windows, and degraded-mode (staging-only) capture. Exported so
 *  tryAutoWriteLane can reuse it when a consumed working-set signal hits the
 *  tristate gate after a cross-turn mode flip. */
export function buildProvisionalStagingEntry(signal: CorrectionSignal, seedText: string): StagingEntry {
  return {
    slug: buildProvisionalStagingSlug(signal, seedText),
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
      // PR-2 (gpt R1 N2): carried for shadow/recall forensics — a staged
      // signal that WAS a directive but missed Tier-1 is exactly what the
      // sunset audit needs to see.
      is_directive: signal.is_directive ?? null,
      // PR-3 (gpt R1 N1): quote-match diagnostics survive into the staged
      // file so Tier-2 demotion forensics don't depend on audit.jsonl alone.
      quote_multi_match: signal.quote_multi_match ?? null,
      quote_matched_roles: signal.quote_matched_roles ?? null,
      // PR-A3 (NIT-1): 归属保真——targeted Tier-1 指令进 staging 时不丢
      // classifier 已完成的 target 归属。
      target_entry_slug: signal.target_entry_slug ?? null,
      scope_description: signal.scope_description ?? "",
      correction_intent: signal.correction_intent ?? "",
      most_likely_error_direction: signal.most_likely_error ?? "",
    },
    _provenance_warning:
      "PROVISIONAL CLASSIFIER GUESS. Do NOT treat as ground truth. " +
      "The only valid use is to RESOLVE this guess (promote / attribute / refute) or let it age.",
  };
}

export async function runCorrectionPipeline(
  branchEntries: unknown[],
  relatedEntries: RelatedEntryCard[],
  deps: {
    settings: SedimentSettings;
    modelRegistry: ModelRegistryLike;
    signal?: AbortSignal;
    /** R6' window-ownership attestation from the caller: true ONLY when THIS
     *  window's processing lane will actually invoke the Tier-1 direct writer
     *  this turn (auto_write short/long lane, not blocked by an in-flight bg
     *  run). explicit/about_me windows and in-flight turns never run
     *  tryAutoWriteLane — for them the staging net stays the deterministic
     *  capture. Fail-open default: absent/false → staging keeps firing. */
    directLaneOwnsWindow?: boolean;
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
  {
    const piAi: {
      streamSimple(
        model: unknown,
        opts: { messages: unknown[] },
        config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
      ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
    } = await import("@earendil-works/pi-ai/compat");

    // C (2026-06-18): retry transient upstream rate-limit (429) with bounded
    // exponential backoff so one throttle hit no longer silently drops the
    // turn's correction signal. Non-rate-limit errors still fail immediately.
    let lastErr = "";
    let succeeded = false;
    for (let attempt = 0; attempt <= CLASSIFIER_RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        const stream = piAi.streamSimple(
          model,
          { messages: [{ role: "user", content: [{ type: "text", text: promptSanitize.text ?? prompt }] }] },
          { apiKey: auth.apiKey, headers: auth.headers, signal: deps.signal, timeoutMs: deps.settings.classifierTimeoutMs, maxRetries: 0 },
        );

        const result = await stream.result();
        if (result.errorMessage) {
          lastErr = result.errorMessage;
          if (isRateLimitError(result.errorMessage) && attempt < CLASSIFIER_RATE_LIMIT_MAX_RETRIES) {
            await classifierSleep(classifierBackoffMs(attempt));
            continue;
          }
          return {
            ok: false, model: modelRef, signal: null,
            error: sanitizeAuditText(result.errorMessage, 500), durationMs: Date.now() - start, stagingWritten: false,
          };
        }
        rawText = result.content?.map((c) => c.type === "text" ? c.text : "").join("") ?? "";
        succeeded = true;
        break;
      } catch (e: unknown) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (isRateLimitError(lastErr) && attempt < CLASSIFIER_RATE_LIMIT_MAX_RETRIES) {
          await classifierSleep(classifierBackoffMs(attempt));
          continue;
        }
        return {
          ok: false, model: modelRef, signal: null,
          error: sanitizeAuditText(lastErr, 500),
          durationMs: Date.now() - start, stagingWritten: false,
        };
      }
    }
    if (!succeeded) {
      return {
        ok: false, model: modelRef, signal: null,
        error: sanitizeAuditText(lastErr || "classifier rate-limit retries exhausted", 500),
        durationMs: Date.now() - start, stagingWritten: false,
      };
    }
  }

  // 5. Parse signal + stamp AX-PROVENANCE deterministically from the packed
  // window's turn.role (R2' structural source gate; no LLM judgment).
  const signal = parseCorrectionSignal(rawText);
  if (!signal) {
    // F1 (PR-A1): unparseable output is ok:false, NOT a no-signal success.
    // The classifier prompt mandates strict JSON even for no-correction
    // windows ({"signal_found": false, ...}), so a null parse is a genuine
    // failure. ok:false routes every lane to its existing transient-failure
    // handling (short lane: checkpoint HOLD + *_classifier_failed_or_
    // unparseable reason; main lane: extractor still runs and the R3' recall
    // audit keys on the raw transcript).
    return {
      ok: false, model: modelRef, signal: null, parseError: true,
      error: `classifier_output_unparseable (raw_chars=${rawText.length})`,
      durationMs: Date.now() - start, stagingWritten: false,
    };
  }
  {
    const pv = deriveProvenance(packed, signal.user_quote);
    signal.quote_source = pv.quote_source;
    signal.provenance = pv.provenance;
    // PR-3/P0.2: deterministic match diagnostics for audit (multi_match
    // per impl-plan; matched_roles for cross-role fail-closed forensics).
    signal.quote_multi_match = pv.multi_match;
    signal.quote_matched_roles = pv.matched_roles;
  }

  const result: CorrectionPipelineResult = {
    ok: true,
    model: modelRef,
    signal,
    durationMs: Date.now() - start,
    stagingWritten: false,
  };

  // 6. Resolve durable + no-target signals.
  // ADR 0028 R6' staging narrowing (supersedes the 2026-06-07 "keep staging as
  // Tier-1 safety net" deferral — its precondition is now met): staging is ONLY
  // for genuinely uncertain Tier-2 hypotheses / unattributable signals. A
  // Tier-1-eligible signal (user-expressed ∧ durable ∧ conf≥8, i.e.
  // shouldEscalateToCurator) is owned by the DETERMINISTIC direct writer
  // (dc5de52): it commits with 0 additional LLM after classifier detection, so
  // the staging net it once needed is dead weight that re-opens B1 (durable
  // entries accumulating in staging — an explicit §8 drift signal). No-loss
  // still holds without it:
  //   - direct write captured (created/deduped/dry_run) → checkpoint advances;
  //   - terminal deterministic reject (validation_error_*) → checkpoint
  //     advances + the R3' recall audit flags the uncovered directive (§11:
  //     deterministic safety gates may stop a Tier-1 write);
  //   - transient failure → checkpoint HOLDS and the signal re-classifies
  //     next turn (bounded by window scroll).
  // Suppression preconditions (3-T0 blind-review convergence, 2026-06-10):
  //   1. autoLlmWriteEnabled === true — in "staging-only" mode the direct lane
  //      never runs and staging IS the capture path; in false mode the
  //      classifier itself is off upstream (hard kill switch — capturing
  //      nothing is the user's stated intent).
  //   2. deps.directLaneOwnsWindow — settings-level liveness is NOT window
  //      ownership: explicit/about_me windows and in-flight turns never run
  //      tryAutoWriteLane, so suppressing their staging would leave the
  //      directive only in the volatile working set (the exact silent-loss
  //      class ADR 0028 exists to kill).
  if (shouldEscalateToCurator(signal)) result.escalateToCurator = true;
  const tier1DirectLaneLive = result.escalateToCurator === true
    && deps.settings.autoLlmWriteEnabled === true
    && deps.directLaneOwnsWindow === true;
  if (tier1DirectLaneLive) result.stagingSuppressedReason = "tier1_direct_lane";
  // PR-A3 (gpt design-review must-fix): targeted Tier-1 directives share the
  // staging capture net with no-target ones — in non-owning windows (explicit/
  // about_me/in-flight) they previously survived only in the volatile working
  // set. Non-Tier-1 targeted durable signals stay un-staged (attributed →
  // curator advisory path, unchanged). (NIT-3: reuse the escalate flag instead
  // of recomputing the predicate.)
  if (signal?.signal_found && signal.typing === "durable"
    && (!signal.target_entry_slug || result.escalateToCurator === true)
    && !tier1DirectLaneLive) {
    // stagingWritten reflects ACTUAL IO success (audit P0 2026-06-07): the
    // short-window escalation holds its checkpoint when the safety net did not
    // persist, so this must not optimistically report true on a failed write.
    result.stagingWritten = writeStagingEntry(buildProvisionalStagingEntry(signal, rawText));
  }

  // 7. Staging inflation advisory — counts actionable files only. Stage 4
  // excludes soft-archived entries and stale entries already reviewed inside
  // the age-out debounce window; counting them would falsely imply current
  // classifier over-production.
  const fileCount = stagingActionableFileCount();
  if (fileCount > 50) {
    result.stagingAdvisory = `staging dir has ${fileCount} actionable files (>50). Classifier may be over-producing provisional hypotheses.`;
  }

  return result;
}

/** Re-export for backward compat with existing fire-and-forget call sites. */
export { runCorrectionPipeline as runCorrectionClassifier };
