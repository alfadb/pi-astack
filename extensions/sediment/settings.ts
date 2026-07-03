import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

/**
 * Resolve `autoLlmWriteEnabled` from raw config to the tristate type.
 * Accepts:
 *   - boolean true / false
 *   - string "true" / "false" / "staging-only" (case-insensitive, trimmed)
 *   - anything else → fallback (preserves backward compat for bool callers)
 */
function resolveAutoLlmWriteEnabled(
  raw: unknown,
  fallback: boolean | "staging-only",
): boolean | "staging-only" {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "staging-only" || v === "staging") return "staging-only";
  }
  return fallback;
}

function resolveMode(raw: unknown, fallback: "parallel_legacy" | "event_first"): "parallel_legacy" | "event_first" {
  if (raw === "parallel_legacy" || raw === "event_first") return raw;
  return fallback;
}

function resolveTier2RulesLegacyWriteGateMode(raw: unknown, fallback: "off" | "observe" | "block"): "off" | "observe" | "block" {
  if (raw === "off" || raw === "observe" || raw === "block") return raw;
  return fallback;
}

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export interface SedimentSettings {
  enabled: boolean;
  gitCommit: boolean;
  lockTimeoutMs: number;
  defaultConfidence: number;
  minWindowChars: number;
  maxWindowChars: number;
  maxWindowEntries: number;
  maxEntryChars: number;
  extractorModel: string;
  extractorTimeoutMs: number;
  extractorMaxRetries: number;
  /** ADR 0025 P1: model for the active correction classifier.
   *  Classification task, not reasoning — v4-flash is sufficient. */
  classifierModel: string;
  /** Model for confirming rule CONTRADICT candidates before contested demotion.
   *  Empty means fall back to classifierModel. */
  ruleContradictionConfirmModel: string;
  classifierTimeoutMs: number;
  extractorMaxCandidates: number;
  extractorAuditRawChars: number;
  curatorModel: string;
  curatorTimeoutMs: number;
  curatorMaxRetries: number;
  /** ADR 0039 P1/P4: constraint shadow compiler and runtime auto-refresh. */
  constraintShadowCompiler: {
    enabled: boolean;
    model: string;
    timeoutMs: number;
    maxRetries: number;
    /** ADR0039 §B (T0 consensus 2026-06-23): validation/parse-feedback retry
     *  attempts — re-prompt the model with the EXACT compile/validate error so it
     *  self-corrects. 0 = single-shot (legacy). Distinct from maxRetries, which is
     *  the transient LLM-call retry inside the invoker. */
    maxCompileRetries: number;
    /** ADR0039 §B: model used for the FINAL retry attempt only (a stronger /
     *  alternate-route model — also the cure for SC_COMPILER_MODEL_UNAVAILABLE on a
     *  flaky primary route). Empty = keep the primary model for every attempt. */
    escalationModelRef: string;
    maxPromptChars: number;
    /** ADR0039 Constraint L2 (4×T0 NS-2/FIX-1): when "repo", the compiler also
     *  固化s the validated decision as an immutable L1 constraint-projection
     *  event and writes the deterministic L2 view to git-tracked
     *  l2/views/constraint/latest/compiled-view.md (SHADOW — runtime injection
     *  still reads .state, no read-flip). "state" (default) = current behavior,
     *  no 固化, no l2 write. Mirrors knowledgeProjector.l2OutputRoot. */
    l2OutputRoot: "state" | "repo";
    autoRefresh: {
      enabled: boolean;
      debounceMs: number;
      minIntervalMs: number;
      eventStaleAfterMs: number;
      maxPromptChars: number;
    };
  };
  /** ADR 0039 P2/P4: runtime append of Constraint Evidence Events. */
  constraintEvidenceEventWriter: {
    enabled: boolean;
    mode: "parallel_legacy" | "event_first";
    legacyFallbackOnEventFailure: boolean;
    legacyRuleWriteOnSuccessfulEvent: boolean;
  };
  /** Tier-2 rules-zone legacy writer gate. Default observe keeps current behavior while auditing caller/scope/slug. */
  tier2RulesLegacyWriteGate: {
    mode: "off" | "observe" | "block";
  };
  /** ADR 0039: runtime append/project/read overlay for Knowledge Evidence Events. */
  knowledgeEvidenceEventWriter: {
    enabled: boolean;
    mode: "parallel_legacy" | "event_first";
    legacyFallbackOnEventFailure: boolean;
    legacyMarkdownWriteOnSuccessfulEvent: boolean;
  };
  knowledgeProjector: {
    enabled: boolean;
    hotOverlayEnabled: boolean;
    projectOnWrite: boolean;
    maxReadBytes: number;
    /** ADR 0039 B1: where the Knowledge L2 projection is written.
     *  "state" = ~/.abrain/.state/sediment/knowledge-projection (runtime cache,
     *  gitignored — current default). "repo" = ~/.abrain/l2/views/knowledge
     *  (git-trackable namespace; B1 keeps it shadow/gitignored until B2 proves
     *  deterministic projection, B3 removes the ignore). Explicit rollback flag. */
    l2OutputRoot: "state" | "repo";
    /** ADR 0039 B2: how the Knowledge L2 entry is projected from L1 events.
     *  "single" (default) = one triggering event overwrites one markdown file.
     *  "topo" = aggregate all events for a (scope, slug) identity, causal-parent
     *  DAG topological sort, deterministic fold to one entry; single-event
     *  degenerates byte-identically to "single". Explicit rollback flag. */
    projectionMode: "single" | "topo";
    /** ADR 0039 Phase C: which source is canonical for Knowledge reads (loadEntries).
     *  "legacy" (default/rollback) = legacy markdown wins; projection appended last as
     *  a bounded overlay (loses dedup). "projection_with_legacy_fallback" = UNBOUNDED
     *  stable-view projection (l2/views/knowledge) inserted at FRONT, wins via
     *  first-store-wins; legacy stays in the pool to fill slugs projection lacks.
     *  "projection_only" = stable view only; legacy leaves the winning pool. Read flag
     *  is hot (resolveSedimentSettings re-read each loadEntries). Multi-T0 consensus +
     *  preflight (pi restart onto repo root) gate any value other than "legacy". */
    canonicalReadMode: "legacy" | "projection_with_legacy_fallback" | "projection_only";
    /** ADR 0039 B-prep blocker③ (§6 bounded hot overlay): defensive caps on the
     *  knowledge projection OVERLAY reader (readKnowledgeProjectionStores). The
     *  overlay role must never grow unbounded (async projector backlog, runaway
     *  projection dir). When the projection dir exceeds a cap, the reader keeps
     *  only the freshest entries within budget and records an overflow
     *  diagnostic. This bounds the OVERLAY role only; the post-flip stable-view
     *  (full corpus as a primary canonical store) is a separate unbounded path. */
    hotOverlay: {
      /** Max overlay entries (count cap). Freshest-by-mtime kept on overflow. */
      maxEntries: number;
      /** Max overlay tokens (estimated bytes/4 from stat size; no file read). */
      maxTokens: number;
      /** Wall-clock budget for the overlay enumeration (ms). */
      deadlineMs: number;
    };
  };
  /** ADR 0025 §4.3 Phase C.2: model for the aggregator v1 skeptical-historian
   *  LLM pass. Skeptical historian is a reasoning-heavy task; v4-pro is the
   *  reasonable default. Empty/invalid → fall back to curatorModel. */
  aggregatorModel: string;
  aggregatorTimeoutMs: number;
  /** ADR 0025 §4.3 Phase C.2 round-2 fix: transport-level retry count for
   *  pi-ai HTTP transport retries (network blips). MUST NOT be used as
   *  prompt-level retry to repair malformed JSON — that path is forbidden
   *  by ADR 0024 §3 + v1 prompt §5 C6 (parse failure → degraded fallback,
   *  never re-ask LLM to fix JSON). Default 1 = one transport retry for
   *  HTTP blips. */
  aggregatorMaxRetries: number;
  /**
   * Sediment auto-write tristate (ADR 0025 §5.3 P5.5 retreat-path requirement).
   *
   *   true            — full pipeline: classifier + extractor + curator + writer
   *   "staging-only"  — classifier runs and writes provisional staging entries,
   *                     but tryAutoWriteLane (extractor / curator / writer) is
   *                     skipped. Observation continues; no durable entry mutation.
   *   false           — hard kill switch: classifier also stops (no LLM tokens
   *                     spent on sediment in any agent_end). Use this when the
   *                     user explicitly does not want sediment observing.
   *
   * Default is `true` (P5.5, this commit). Rollback path:
   *   - immediate concerns about durable writes → set to `"staging-only"` in
   *     ~/.pi/agent/pi-astack-settings.json sediment.autoLlmWriteEnabled
   *   - want sediment entirely silent → set to `false`
   * Both rollback values are honored at process start without code change.
   */
  autoLlmWriteEnabled: boolean | "staging-only";
  autoWriteRawAuditChars: number;
  /** When true, skip credential sanitization in continuation-call path.
   *  Safe for air-gapped deployments where extractor LLM provider
   *  cannot reach internal infrastructure even with leaked keys.
   *  Default: false (sanitize is ON by default). */
  skipContinuationSanitize: boolean;

  /** ADR 0028 PR1: expose existing rules as read-only curator neighbors.
   *  Default true so curator semantic dedup has the rule context needed by
   *  ADR 0028 R5'; false is an explicit rollback path. */
  rulesAsReadonlyNeighborsEnabled: boolean;

  /** PR-4/P0.3 (ADR 0028 R5'/R2' 调和，O2 裁决 2026-06-10): Tier-1 直写
   *  路径上 Jaccard 近重复命中时的处置。
   *  - true（default）: Jaccard 命中 → curator LLM 裁决 {update, merge, create}
   *    （禁 skip/stage）；adjudicator 不可用/解析失败 → 确定性 create。
   *    同时 Tier-2 curator lane 的 rules-create 跳过自主 gate（邻居预
   *    过滤已在 curator prompt 内，curator.ts:1056）。
   *  - false（rollback only）: 回到旧路径自主 dedup gate（storage-only create）。
   *    （旧 tier1JaccardShadowAudit / tier1RuleSetAdjudication 写时裁决器随
   *    ADR0039 P4-a 退休；rollback 写已收缩为 storage-only writeAbrainRule）。 */
  tier1JaccardCuratorLane: boolean;

  /** ADR 0025 §4.1.5 Stage 5 follow-up: enable multi-view gated promotion of
   *  staging `promote_candidate` entries to durable memory. Default false so
   *  the new executor is opt-in; when false, promote_candidate flags remain
   *  advisory and accumulate in staging. */
  stagingPromotionEnabled: boolean;
  /** Model for staging promotion identity resolution (slug/title/statement).
   *  Empty means fall back to classifierModel, then curatorModel. */
  stagingPromotionModel: string;

  /** ADR 0025 P0: semantic version tags for each classifier prompt.
   *  Written into every audit row so downstream aggregator/health-check
   *  can track prompt changes without manual cross-reference.
   *
   *  Each version is paired with a `_semantic_note` in PROMPT_VERSION_NOTES
   *  below; the audit helper combines them per ADR 0025 §4.5.2 schema. */
  promptVersion: {
    activeCorrectionClassifier: string;
    reasoningNormalizationPreamble: string;
    multiViewPass1: string;
    multiViewPass2: string;
    outcomeSelfReport: string;
    aggregator: string;
    archiveReactivationReviewer: string;
  };
  /** ADR 0025 P0: multi-view verification provider lists.
   *  If empty, multi-view is effectively disabled (single-provider
   *  degradation). The proposer and reviewer MUST be from DIFFERENT
   *  providers per ADR 0024 §5.4. */
  multiView: {
    proposerProviders: string[];
    reviewerProviders: string[];
    fallbackProviders: string[];
    /** When true, every mutating curator op enters multi-view. op=skip remains unreviewed. */
    reviewAllMutations: boolean;
    /** Model for rich-payload synthesis after confirm_pass1 on update/merge/supersede/delete.
     *  Empty means fall back to curatorModel. */
    synthesisModel: string;
  };
}

export const DEFAULT_SEDIMENT_SETTINGS: SedimentSettings = {
  enabled: false,
  gitCommit: true,
  lockTimeoutMs: 5_000,
  defaultConfidence: 3,
  minWindowChars: 200,
  // 2026-05-11: raised from 200K to 350K (with per-entry truncation at
  // 30K chars for toolResult/bashExecution). 350K ~87.5K tokens, well
  // within deepseek 128K context (71% utilization). See 3-model audit.
  maxWindowChars: 350_000,
  maxWindowEntries: 200,
  // Per-entry char cap for toolResult and bashExecution entries.
  // Prevents a single large tool output from dominating the window.
  // Head 25K + tail 5K preserved; middle truncated with marker.
  maxEntryChars: 30_000,
  // No model hardcoded in code: pi-astack-settings.json is the single source
  // of truth. Empty default + fail-closed at the modelRegistry call site.
  extractorModel: "",
  // 2026-05-24: raised 180_000 → 1_200_000 (20 min) per user directive.
  // Rationale: sediment is fire-and-forget background; pi-ai underlying SDK
  // default is 10 min anyway (see pi-ai types.ts:121). Tight timeouts caused
  // noisy "Request timed out" footer/audit entries during provider blips
  // (deepseek routing flake / brief rate-limit) that would have resolved if
  // given more time. 20 min tolerates extreme provider latency while still
  // bounded so a truly hung socket eventually fails. Trade-off: a stuck
  // request now shows `📝 sediment: extracting` for up to 20 min before
  // flipping to `⚠️ LLM err: ...` — acceptable per Lane C fire-and-forget.
  extractorTimeoutMs: 1_200_000,
  extractorMaxRetries: 0,
  // Classifier: empty default. Configure in pi-astack-settings.json.
  classifierModel: "",
  ruleContradictionConfirmModel: "",
  // 2026-05-24: raised 30_000 → 1_200_000 (20 min) per user directive.
  // See extractorTimeoutMs rationale above. classifier was the most frequent
  // false-fail offender (e.g. audit.jsonl 15:14 + 15:17 deepseek blip).
  classifierTimeoutMs: 1_200_000,
  extractorMaxCandidates: 5,
  extractorAuditRawChars: 1_000,
  // Curator: empty default. Configure in pi-astack-settings.json.
  curatorModel: "",
  // 2026-05-24: raised 60_000 → 1_200_000 (20 min) per user directive.
  // See extractorTimeoutMs rationale above.
  curatorTimeoutMs: 1_200_000,
  curatorMaxRetries: 1,
  constraintShadowCompiler: {
    enabled: false,
    model: "",
    timeoutMs: 1_200_000,
    maxRetries: 0,
    maxCompileRetries: 2,
    escalationModelRef: "",
    maxPromptChars: 0,
    l2OutputRoot: "state",
    autoRefresh: {
      enabled: false,
      debounceMs: 2_000,
      minIntervalMs: 60_000,
      eventStaleAfterMs: 24 * 60 * 60 * 1_000,
      maxPromptChars: 0,
    },
  },
  constraintEvidenceEventWriter: {
    enabled: false,
    mode: "parallel_legacy",
    legacyFallbackOnEventFailure: true,
    legacyRuleWriteOnSuccessfulEvent: true,
  },
  tier2RulesLegacyWriteGate: {
    mode: "observe",
  },
  knowledgeEvidenceEventWriter: {
    enabled: false,
    mode: "parallel_legacy",
    legacyFallbackOnEventFailure: true,
    legacyMarkdownWriteOnSuccessfulEvent: true,
  },
  knowledgeProjector: {
    enabled: false,
    hotOverlayEnabled: false,
    projectOnWrite: false,
    maxReadBytes: 1_000_000,
    l2OutputRoot: "state",
    projectionMode: "single",
    canonicalReadMode: "legacy",
    hotOverlay: {
      maxEntries: 500,
      maxTokens: 2_000_000,
      deadlineMs: 30_000,
    },
  },
  // Aggregator: empty default. Configure in pi-astack-settings.json.
  aggregatorModel: "",
  aggregatorTimeoutMs: 600_000,
  aggregatorMaxRetries: 1,
  // ADR 0025 §5.3 P5.5: default changed false → true 2026-05-24.
  //
  // Strict ADR §5.3 hard conditions (3 users × 4 weeks, false-positive rate
  // < 15%, no user complaints, staging growth < 50/month with resolve > 30%)
  // are NOT fully satisfied: pi-astack is a single-user project (alfadb), so
  // the 3-user requirement is structurally unmeetable. Single-user dogfood
  // signals available:
  //   - 77 classifier runs, 15 (19%) signal_found, durable conf 7–8 multiple
  //     times — quality looks healthy but false-positive rate not directly
  //     computable until typing routing lands (Tier-1 §4.1 ship-block T1-1)
  //   - 495 create operations under autoLlmWriteEnabled=true in user-local
  //     settings, no manifest user complaints in audit
  //   - 9 staging provisional entries, well under any inflation cap
  //
  // The strict P5.5 conditions exist to prevent silent durable-region pollution
  // when the original author isn't watching. For a single-user repo the user
  // IS the author, so the polluted entries surface as direct dogfood frustration
  // — a tighter feedback loop than the 3-user dogfood was designed to provide.
  // Both "staging-only" and false retreat paths are wired (this file's tristate
  // semantics + index.ts gate logic), so rollback is one settings line away.
  autoLlmWriteEnabled: true,
  autoWriteRawAuditChars: 8_000,
  skipContinuationSanitize: false,
  rulesAsReadonlyNeighborsEnabled: true,
  // ADR 0028 R5' cutover (2026-06-12): Jaccard is no longer an autonomous
  // write-path gate by default. It only reports a near-duplicate candidate
  // to the closed curator adjudicator ({update, merge, create}); exact slug /
  // body-hash remain deterministic no-op infrastructure. Operators can set
  // tier1JaccardCuratorLane:false as a rollback path to the legacy autonomous
  // dedup gate (storage-only create after ADR0039 P4-a retired the adjudicator).
  tier1JaccardCuratorLane: true,
  /** ADR 0025 §4.1.5 Stage 5 follow-up: default false. Enable only after
   *  reviewing the backlog policy and confirming multi-view reviewer providers
   *  are configured. */
  stagingPromotionEnabled: false,
  stagingPromotionModel: "",
  promptVersion: {
    activeCorrectionClassifier: "v2",
    reasoningNormalizationPreamble: "v1",
    multiViewPass1: "v1",
    multiViewPass2: "v1",
    outcomeSelfReport: "v0",
    aggregator: "v1.3",
    archiveReactivationReviewer: "v1",
  },
  multiView: {
    // No reviewers hardcoded in code. Configure in
    // pi-astack-settings.json → sediment.multiView.reviewerProviders.
    // proposerProviders / fallbackProviders stay empty: this code is
    // single-user and only the primary reviewer pair is used.
    proposerProviders: [],
    reviewerProviders: [],
    fallbackProviders: [],
    reviewAllMutations: false,
    synthesisModel: "",
  },
};

/**
 * Semantic notes paired with `promptVersion.*` for ADR 0025 §4.5.2 audit
 * schema. When a prompt is bumped (e.g. activeCorrectionClassifier "v1"
 * → "v2"), bump the note here in the SAME commit so audit rows written
 * after the bump carry the new semantic context. Aggregator readers
 * (ADR §4.3) compare these notes when grouping trace data across versions.
 *
 * Keys must match `PromptVersionSubstrate` field names; missing entries
 * resolve to a default "(no semantic note registered)" string.
 */
export const PROMPT_VERSION_NOTES: Record<keyof SedimentSettings["promptVersion"], string> = {
  activeCorrectionClassifier:
    "v2 (2026-06-10, PR-2/P0.1 of goal-workflow impl plan): adds is_directive output field per ADR 0028 R2' — imperative/prescriptive mood orthogonal to typing, RECALL-BIASED for user-role imperatives (asymmetric cost: missed directive = silent loss; over-flag = bounded by R3' tell + R4' outcome), with explicit abstain list (questions / memory-management corrections / restating known rules / quoted third-party imperatives / delegation). Pairs with isTier1Directive(): is_directive exempts the conf≥8 gate (transitional fallback retained for non-directive durable signals — sunset note in correction-pipeline.ts). v1 base unchanged: 7-step evidence-first reasoning (quote → cases → lean → disconfirmer → commit → self-critique → self-rating) + 10 bias cautions + staging_context anti-anchoring protocol. Prepended with reasoning-normalization-preamble v1.",
  reasoningNormalizationPreamble:
    "v1: fixed 5-stage reasoning surface (quote → claim → alternative → uncertainty → resolving evidence) shared across classifier + multi-view pass-1/2 so cross-prompt comparison works.",
  multiViewPass1:
    "v1: Blind reviewer pass. Independent op recommendation from a DIFFERENT-family model than the proposer (model refs come from settings.multiView.reviewerProviders; proposer comes from the active curator model). Outputs op + scope + slug_target + confidence + key_evidence_quote + strongest_objection_to_your_own_op + reasoning (≤200 words). Prepended with reasoning-normalization-preamble v1 so Pass 2 can compare surfaces apples-to-apples. Triggered for high-value ops only: create(conf≥8 or scope=world) / archive(high-conf neighbor) / supersede / merge / hard-delete / durable-correction(conf≥8).",
  multiViewPass2:
    "v1: Reveal reviewer pass. SAME reviewer model as Pass 1 (different API call). Sees its own Pass 1 + proposer decision + proposer raw reasoning. Emits verdict={confirm_proposer, confirm_pass1, defer} + anchor_bias_self_check + devils_advocate_objection (virtual third-reviewer layer, no extra API call). Defer → batch 3b stages candidate for replay at next agent_end (op=skip(multiview_staged_for_replay)), NOT the old skip(multiview_deferred) audit-only path.",
  outcomeSelfReport:
    "v0: memory-footnote protocol injected via memory extension's before_agent_start hook (extensions/memory/index.ts). Not a sediment-owned prompt file; this version tag tracks the protocol-level contract (entry/used/counterfactual fields, 3-option taxonomy).",
  aggregator:
    "v1.3: prompt-native skeptical-historian (ADR 0025 §4.3 + Phase A/B/C cutover 2026-05-28; L1 evolution self-state wired 2026-05-31; identity convergence 2026-06-03; Outcome→Entry feedback M3 2026-06-04). v1.3 adds an OPTIONAL lifecycle_proposal on PROMOTED entry advisories (affirmative channel only — never demoted_signals, which EXONERATE; §4.2 independent evidence + falsifier required, retrieved-unused-alone rejected). It is distilled to a read-only entry-lifecycle-proposals.jsonl sidecar (prompt §8 observation-only): NEVER a durable write, NEVER writer/curator/archive/multi-view; the deferred gated executor is the sole consumer. 9 input feeds threaded from deterministic v0.2 base: mechanical_suspicion_signals (renamed advisories), raw_distribution_summary, outcome_counterfactual_excerpts, structural_context, prior_aggregator_summaries (last 8 runs), classifier_health_window with 7-day rolling trend delta, per_turn_cost_rollup, p15_watchdog_signals, evolution_hypotheses. LLM = settings.aggregatorModel (no model default in code). Prompt forces case-FOR + case-AGAINST + falsifiability + sycophancy double-check + reverse-anchor against skeptical-bias swap + self-state reification check. v1.2 adds Step-7 stable-identity discipline: recurring structural signals (staging_backlog, classifier_health, p15_re_prioritize_needed, multiview_pending) MUST carry a SHORT stable canonical slug reused verbatim across runs (or the slug/key from a matching evolution_hypotheses entry), so the sidecar does not fork one belief into many message-hash identities; the evolution-ledger sidecar quietly re-keys a single slug-less message-hash row onto a stable slug when one appears (dogfood-driven, see evolution-ledger.ts adoptUnsluggedAlias). Output schema = INFRA serialization (parse failure → degraded_to_mechanical: true audit, never retry-LLM-to-fix-JSON, never user-facing surface per INV-INVISIBILITY). Successful prompt-native outputs are distilled to evolution-ledger.jsonl as internal self-state only; this is not durable-memory authorization and must not trigger writer/archive/curator actions. v0.2 mechanical path retained as fallback when modelRegistry absent or LLM call fails. See docs/audits/2026-05-28-aggregator-prompt-native-phase-a-baseline.md + extensions/sediment/prompts/aggregator-skeptical-historian-v1.md.",
  archiveReactivationReviewer:
    "v1: prompt-native reactivation reviewer (ADR 0025 §4.6, Stage 2 2026-05-28). Batched daily-debounced review of archived entries via runArchiveReactivationIfDue() in extensions/sediment/archive-reactivation.ts. Three decisions: keep_archived | reactivate | hard_archive_recommended. Default-conservative bias (most runs produce zero reactivations). reactivate decisions flip status=archived→active via writer.updateProjectEntry; hard_archive_recommended logs only (actual git rm deferred to a future PR). Reuses aggregator's setImmediate scheduling + 24h debounce. Audit row: archive_reactivation operation in audit.jsonl + ledger row in archive-reactivation-ledger.jsonl. Prompt: extensions/sediment/prompts/archive-reactivation-reviewer-v1.md.",

};

/**
 * Build the prompt_version object embedded in sediment audit rows per
 * ADR 0025 §4.5.2 schema:
 *
 *   {
 *     "prompt_version": {
 *       "<prompt_key_in_snake_case>": "<version>",
 *       "_semantic_note": "<human note>"
 *     }
 *   }
 *
 * `key` is the camelCase field name in PromptVersionSubstrate; we convert
 * to snake_case for audit readability (matches ADR examples).
 */
export function buildPromptVersionAudit(
  key: keyof SedimentSettings["promptVersion"],
  settings: SedimentSettings,
): Record<string, string> {
  const snakeKey = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()).replace(/^_/, "");
  return {
    [snakeKey]: settings.promptVersion[key],
    _semantic_note: PROMPT_VERSION_NOTES[key] ?? "(no semantic note registered)",
  };
}

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

export function resolveSedimentSettings(): SedimentSettings {
  const root = loadPiStackSettings();
  const cfg = (root.sediment as Record<string, unknown>) ?? {};
  return {
    enabled: asBoolean(cfg.enabled, DEFAULT_SEDIMENT_SETTINGS.enabled),
    gitCommit: asBoolean(cfg.gitCommit, DEFAULT_SEDIMENT_SETTINGS.gitCommit),
    lockTimeoutMs: Math.max(100, asNumber(cfg.lockTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.lockTimeoutMs)),
    defaultConfidence: Math.min(10, Math.max(0, asNumber(cfg.defaultConfidence, DEFAULT_SEDIMENT_SETTINGS.defaultConfidence))),
    minWindowChars: Math.max(0, asNumber(cfg.minWindowChars, DEFAULT_SEDIMENT_SETTINGS.minWindowChars)),
    maxWindowChars: Math.max(1_000, asNumber(cfg.maxWindowChars, DEFAULT_SEDIMENT_SETTINGS.maxWindowChars)),
    maxWindowEntries: Math.max(1, Math.floor(asNumber(cfg.maxWindowEntries, DEFAULT_SEDIMENT_SETTINGS.maxWindowEntries))),
    maxEntryChars: Math.max(1_000, asNumber(cfg.maxEntryChars, DEFAULT_SEDIMENT_SETTINGS.maxEntryChars)),
    extractorModel: typeof cfg.extractorModel === "string" && cfg.extractorModel.trim()
      ? cfg.extractorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.extractorModel,
    extractorTimeoutMs: Math.max(1_000, asNumber(cfg.extractorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.extractorTimeoutMs)),
    extractorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.extractorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.extractorMaxRetries))),
    classifierModel: typeof cfg.classifierModel === "string" && cfg.classifierModel.trim()
      ? cfg.classifierModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.classifierModel,
    ruleContradictionConfirmModel: typeof cfg.ruleContradictionConfirmModel === "string" && cfg.ruleContradictionConfirmModel.trim()
      ? cfg.ruleContradictionConfirmModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.ruleContradictionConfirmModel,
    classifierTimeoutMs: Math.max(5_000, asNumber(cfg.classifierTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.classifierTimeoutMs)),
    extractorMaxCandidates: Math.max(1, Math.floor(asNumber(cfg.extractorMaxCandidates, DEFAULT_SEDIMENT_SETTINGS.extractorMaxCandidates))),
    extractorAuditRawChars: Math.max(0, Math.floor(asNumber(cfg.extractorAuditRawChars, DEFAULT_SEDIMENT_SETTINGS.extractorAuditRawChars))),
    curatorModel: typeof cfg.curatorModel === "string" && cfg.curatorModel.trim()
      ? cfg.curatorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.curatorModel,
    curatorTimeoutMs: Math.max(1_000, asNumber(cfg.curatorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.curatorTimeoutMs)),
    curatorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.curatorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.curatorMaxRetries))),
    constraintShadowCompiler: {
      enabled: asBoolean((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.enabled, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.enabled),
      model: typeof (cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.model === "string" && ((cfg.constraintShadowCompiler as Record<string, unknown>).model as string).trim()
        ? ((cfg.constraintShadowCompiler as Record<string, unknown>).model as string).trim()
        : DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.model,
      timeoutMs: Math.max(1_000, asNumber((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.timeoutMs, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.timeoutMs)),
      maxRetries: Math.max(0, Math.floor(asNumber((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.maxRetries, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.maxRetries))),
      maxCompileRetries: Math.max(0, Math.floor(asNumber((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.maxCompileRetries, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.maxCompileRetries))),
      escalationModelRef: typeof (cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.escalationModelRef === "string"
        ? ((cfg.constraintShadowCompiler as Record<string, unknown>).escalationModelRef as string).trim()
        : DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.escalationModelRef,
      maxPromptChars: Math.max(0, Math.floor(asNumber((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.maxPromptChars, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.maxPromptChars))),
      l2OutputRoot: ((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.l2OutputRoot === "repo" ? "repo" : "state"),
      autoRefresh: {
        enabled: asBoolean(((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.autoRefresh as Record<string, unknown> | undefined)?.enabled, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.autoRefresh.enabled),
        debounceMs: Math.max(0, Math.floor(asNumber(((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.autoRefresh as Record<string, unknown> | undefined)?.debounceMs, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.autoRefresh.debounceMs))),
        minIntervalMs: Math.max(0, Math.floor(asNumber(((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.autoRefresh as Record<string, unknown> | undefined)?.minIntervalMs, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.autoRefresh.minIntervalMs))),
        eventStaleAfterMs: Math.max(1_000, Math.floor(asNumber(((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.autoRefresh as Record<string, unknown> | undefined)?.eventStaleAfterMs, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.autoRefresh.eventStaleAfterMs))),
        maxPromptChars: Math.max(0, Math.floor(asNumber(((cfg.constraintShadowCompiler as Record<string, unknown> | undefined)?.autoRefresh as Record<string, unknown> | undefined)?.maxPromptChars, DEFAULT_SEDIMENT_SETTINGS.constraintShadowCompiler.autoRefresh.maxPromptChars))),
      },
    },
    constraintEvidenceEventWriter: {
      enabled: asBoolean((cfg.constraintEvidenceEventWriter as Record<string, unknown> | undefined)?.enabled, DEFAULT_SEDIMENT_SETTINGS.constraintEvidenceEventWriter.enabled),
      mode: resolveMode((cfg.constraintEvidenceEventWriter as Record<string, unknown> | undefined)?.mode, DEFAULT_SEDIMENT_SETTINGS.constraintEvidenceEventWriter.mode),
      legacyFallbackOnEventFailure: asBoolean((cfg.constraintEvidenceEventWriter as Record<string, unknown> | undefined)?.legacyFallbackOnEventFailure, DEFAULT_SEDIMENT_SETTINGS.constraintEvidenceEventWriter.legacyFallbackOnEventFailure),
      legacyRuleWriteOnSuccessfulEvent: asBoolean((cfg.constraintEvidenceEventWriter as Record<string, unknown> | undefined)?.legacyRuleWriteOnSuccessfulEvent, DEFAULT_SEDIMENT_SETTINGS.constraintEvidenceEventWriter.legacyRuleWriteOnSuccessfulEvent),
    },
    tier2RulesLegacyWriteGate: {
      mode: resolveTier2RulesLegacyWriteGateMode((cfg.tier2RulesLegacyWriteGate as Record<string, unknown> | undefined)?.mode, DEFAULT_SEDIMENT_SETTINGS.tier2RulesLegacyWriteGate.mode),
    },
    knowledgeEvidenceEventWriter: {
      enabled: asBoolean((cfg.knowledgeEvidenceEventWriter as Record<string, unknown> | undefined)?.enabled, DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter.enabled),
      mode: resolveMode((cfg.knowledgeEvidenceEventWriter as Record<string, unknown> | undefined)?.mode, DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter.mode),
      legacyFallbackOnEventFailure: asBoolean((cfg.knowledgeEvidenceEventWriter as Record<string, unknown> | undefined)?.legacyFallbackOnEventFailure, DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter.legacyFallbackOnEventFailure),
      legacyMarkdownWriteOnSuccessfulEvent: asBoolean((cfg.knowledgeEvidenceEventWriter as Record<string, unknown> | undefined)?.legacyMarkdownWriteOnSuccessfulEvent, DEFAULT_SEDIMENT_SETTINGS.knowledgeEvidenceEventWriter.legacyMarkdownWriteOnSuccessfulEvent),
    },
    knowledgeProjector: {
      enabled: asBoolean((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.enabled, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.enabled),
      hotOverlayEnabled: asBoolean((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.hotOverlayEnabled, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.hotOverlayEnabled),
      projectOnWrite: asBoolean((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.projectOnWrite, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.projectOnWrite),
      maxReadBytes: Math.max(1_000, Math.floor(asNumber((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.maxReadBytes, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.maxReadBytes))),
      l2OutputRoot: ((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.l2OutputRoot === "repo" ? "repo" : "state"),
      projectionMode: ((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.projectionMode === "topo" ? "topo" : "single"),
      canonicalReadMode: (((m) => (m === "projection_with_legacy_fallback" || m === "projection_only") ? m : "legacy")((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.canonicalReadMode)),
      hotOverlay: {
        maxEntries: Math.max(1, Math.floor(asNumber(((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.hotOverlay as Record<string, unknown> | undefined)?.maxEntries, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.hotOverlay.maxEntries))),
        maxTokens: Math.max(1_000, Math.floor(asNumber(((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.hotOverlay as Record<string, unknown> | undefined)?.maxTokens, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.hotOverlay.maxTokens))),
        deadlineMs: Math.max(1_000, Math.floor(asNumber(((cfg.knowledgeProjector as Record<string, unknown> | undefined)?.hotOverlay as Record<string, unknown> | undefined)?.deadlineMs, DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector.hotOverlay.deadlineMs))),
      },
    },
    aggregatorModel: typeof cfg.aggregatorModel === "string" && cfg.aggregatorModel.trim()
      ? cfg.aggregatorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.aggregatorModel,
    aggregatorTimeoutMs: Math.max(5_000, asNumber(cfg.aggregatorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.aggregatorTimeoutMs)),
    aggregatorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.aggregatorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.aggregatorMaxRetries))),
    autoLlmWriteEnabled: resolveAutoLlmWriteEnabled(cfg.autoLlmWriteEnabled, DEFAULT_SEDIMENT_SETTINGS.autoLlmWriteEnabled),
    autoWriteRawAuditChars: Math.max(0, Math.floor(asNumber(cfg.autoWriteRawAuditChars, DEFAULT_SEDIMENT_SETTINGS.autoWriteRawAuditChars))),
    skipContinuationSanitize: asBoolean(cfg.skipContinuationSanitize, DEFAULT_SEDIMENT_SETTINGS.skipContinuationSanitize),
    rulesAsReadonlyNeighborsEnabled: asBoolean(cfg.rulesAsReadonlyNeighborsEnabled, DEFAULT_SEDIMENT_SETTINGS.rulesAsReadonlyNeighborsEnabled),
    tier1JaccardCuratorLane: asBoolean(cfg.tier1JaccardCuratorLane, DEFAULT_SEDIMENT_SETTINGS.tier1JaccardCuratorLane),
    stagingPromotionEnabled: asBoolean(cfg.stagingPromotionEnabled, DEFAULT_SEDIMENT_SETTINGS.stagingPromotionEnabled),
    stagingPromotionModel: typeof cfg.stagingPromotionModel === "string" && cfg.stagingPromotionModel.trim()
      ? cfg.stagingPromotionModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.stagingPromotionModel,
    promptVersion: {
      activeCorrectionClassifier: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.activeCorrectionClassifier === "string"
        ? (cfg.promptVersion as Record<string,unknown>).activeCorrectionClassifier as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.activeCorrectionClassifier,
      reasoningNormalizationPreamble: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.reasoningNormalizationPreamble === "string"
        ? (cfg.promptVersion as Record<string,unknown>).reasoningNormalizationPreamble as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.reasoningNormalizationPreamble,
      multiViewPass1: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.multiViewPass1 === "string"
        ? (cfg.promptVersion as Record<string,unknown>).multiViewPass1 as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.multiViewPass1,
      multiViewPass2: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.multiViewPass2 === "string"
        ? (cfg.promptVersion as Record<string,unknown>).multiViewPass2 as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.multiViewPass2,
      outcomeSelfReport: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.outcomeSelfReport === "string"
        ? (cfg.promptVersion as Record<string,unknown>).outcomeSelfReport as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.outcomeSelfReport,
      aggregator: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.aggregator === "string"
        ? (cfg.promptVersion as Record<string,unknown>).aggregator as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.aggregator,
      archiveReactivationReviewer: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.archiveReactivationReviewer === "string"
        ? (cfg.promptVersion as Record<string,unknown>).archiveReactivationReviewer as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.archiveReactivationReviewer,
    },
    multiView: {
      proposerProviders: Array.isArray((cfg.multiView as Record<string,unknown>|undefined)?.proposerProviders)
        ? (cfg.multiView as Record<string,unknown>).proposerProviders as string[] : DEFAULT_SEDIMENT_SETTINGS.multiView.proposerProviders,
      reviewerProviders: Array.isArray((cfg.multiView as Record<string,unknown>|undefined)?.reviewerProviders)
        ? (cfg.multiView as Record<string,unknown>).reviewerProviders as string[] : DEFAULT_SEDIMENT_SETTINGS.multiView.reviewerProviders,
      fallbackProviders: Array.isArray((cfg.multiView as Record<string,unknown>|undefined)?.fallbackProviders)
        ? (cfg.multiView as Record<string,unknown>).fallbackProviders as string[] : DEFAULT_SEDIMENT_SETTINGS.multiView.fallbackProviders,
      reviewAllMutations: asBoolean((cfg.multiView as Record<string,unknown>|undefined)?.reviewAllMutations, DEFAULT_SEDIMENT_SETTINGS.multiView.reviewAllMutations),
      synthesisModel: typeof (cfg.multiView as Record<string,unknown>|undefined)?.synthesisModel === "string" && ((cfg.multiView as Record<string,unknown>).synthesisModel as string).trim()
        ? ((cfg.multiView as Record<string,unknown>).synthesisModel as string).trim()
        : DEFAULT_SEDIMENT_SETTINGS.multiView.synthesisModel,
    },
  };
}
