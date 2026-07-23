/**
 * staging-types — provisional correction staging entry schema (ADR 0025 §4.1.5).
 *
 * Staging entries are unconfirmed classifier hypotheses. They live in
 * `~/.abrain/.state/sediment/staging/` and are NOT in the memory_search
 * corpus. The staging-loader reads them to provide context for future
 * classifier runs. The staging-resolver TRIAGES them non-destructively
 * (annotates a disposition; never flips attribution_pending); they age out
 * after 30 days. Resolution to a durable entry (promote / attribute) is a
 * future multi-view path, not done in v1.
 */

export interface StagingEntry {
  /** Bare slug: provisional-{hash8} */
  slug: string;
  status: "provisional";
  kind: "provisional-correction";
  created: string;           // ISO timestamp
  updated?: string;

  /** True until a future classifier resolves this hypothesis */
  attribution_pending: boolean;

  /** Device that captured this signal (for cross-device staging sync) */
  originating_device: string;

  /** Natural-language description of what the classifier guessed */
  hypothesis: string;

  /** Verbatim quotes from the user that triggered this hypothesis */
  source_utterance: Array<{
    quote: string;
    context: string;         // surrounding text
    captured_at: string;     // ISO
  }>;

  /** How the classifier suggested this be resolved */
  suggested_resolution_paths: string[];

  /** Raw CorrectionSignal output (for audit trace). */
  correction_signal?: {
    /** Mirrors CorrectionSignal.signal_found; required so downstream
     *  renderCorrectionSignal can render the "HYPOTHESIS — NOT GROUND
     *  TRUTH" block instead of treating the staged signal as absent. */
    signal_found: true;
    typing: "durable" | "task-local" | "debug";
    confidence: number;
    /** R2' is_directive (PR-2 2026-06-10): carried for shadow/recall
     *  forensics — a staged signal that WAS a directive but missed Tier-1
     *  is what the O5 sunset audit needs to see. null = classifier did
     *  not emit the field (pre-v2 prompt or non-boolean shape). */
    is_directive?: boolean | null;
    /** PR-3/P0.2: deterministic quote-match diagnostics from
     *  deriveProvenance — staged-file forensics for cross-role demotes
     *  (echo-subclass attribution without consulting audit.jsonl). */
    quote_multi_match?: boolean | null;
    quote_matched_roles?: Array<"user" | "transcript" | "assistant"> | null;
    /** PR-A3 (2026-06-12 盲审 NIT-1, opus+deepseek 同报): targeted Tier-1
     *  指令首次可进 staging（非 owning 窗口捕获网）——classifier 已完成的
     *  归属必须随文件保真，resolver/后续重分类不应被迫重新 search 归因。 */
    target_entry_slug?: string | null;
    /** Classifier-owned rules blast radius. Legacy/missing values are treated
     *  as project downstream to avoid accidental global prompt pollution. */
    rule_scope?: "project" | "global" | null;
    scope_description: string;
    correction_intent: string;
    most_likely_error_direction: string;
  };

  /** ADR 0025 §4.1.5 Stage 5 FIX-2: project binding captured at staging time.
   *  The staging directory is user-global, so promotion must only write an
   *  entry into the project that owns it. New entries always set these;
   *  legacy entries without them are matched heuristically via
   *  target_entry_slug. */
  origin_project_id?: string;
  origin_project_root?: string;

  /** Frontmatter: warning for downstream consumers */
  _provenance_warning: string;

  // ── Unified lifecycle convergence fields (RM-LIFECYCLE-002) ──
  // These fields are a rebuildable .state audit/read-model projection. They do
  // not become memory truth and never authorize a durable writer operation.
  lifecycle_item_id?: string;
  lifecycle_cohort?: "legacy" | "fresh";
  lifecycle_attempt?: number;
  lifecycle_failure_class?: "none" | "provider" | "transient" | "parse" | "conflict" | "writer" | "semantic_defer";
  lifecycle_next_retry_not_before?: string;
  lifecycle_deadline?: string;
  lifecycle_new_evidence_trigger?: string;
  lifecycle_terminal_at?: string;
  lifecycle_terminal_reason?: string;

  // ── Resolver triage fields (set by staging-resolver, ADR 0025 §4.1.5.1) ──
  // IMPORTANT (R1 opus P1): the resolver is NON-DESTRUCTIVE. It does NOT
  // flip attribution_pending or remove a hypothesis from the learning loop —
  // these are already-classified-durable signals, and terminal removal on a
  // single LLM's judgement (while promotion is multi-view-gated) would be a
  // backwards data-conservation asymmetry. Retirement stays the job of the
  // time-bounded age-out (ADR 0025 §4.1.5 / §4.6 reviewer). The resolver only
  // ANNOTATES a triage disposition + reviewed-at timestamp; selection then
  // deprioritizes recently-reviewed entries so the resolver doesn't re-burn
  // tokens on the same hypotheses every run.
  /** When the resolver last reviewed this hypothesis (bounds re-review). */
  resolver_reviewed_at?: string;
  /** Resolver's triage call: "likely_noise" (deprioritized but still in the
   *  loop and ageing normally), "plausible" (a real-looking durable signal
   *  worth keeping), or "promote_candidate" (clearly durable + strong
   *  attribution — kept pending for the future multi-view promotion path). */
  resolver_disposition?: "likely_noise" | "plausible" | "promote_candidate";
  resolver_rationale?: string;

  // ── Age-out lifecycle fields (set by staging-ageout, ADR 0025 §4.1.5 / §4.6.6) ──
  // Stage 4 (2026-05-29): when a provisional hypothesis ages past STALE_DAYS
  // (30d) unresolved, the staging-ageout reviewer gives it a TERMINAL-ish
  // disposition. It is REVERSIBLE soft-archive ONLY and NEVER unlinks a file,
  // because staging lives in git-ignored `.state/`. The retained full record is
  // the terminal state; physical deletion remains blocked outside this lifecycle.
  // `attribution_pending` is left UNTOUCHED on purpose: it remains
  // the honest record that the hypothesis aged out WITHOUT ever being
  // attributed, and the resolver's non-destructive contract depends on that
  // field meaning exactly that. Backlog drainage is driven by
  // `lifecycle_state`, an orthogonal axis (absent ⇒ "active", backcompat).
  /** Backlog axis. "soft_archived" = retired by the age-out reviewer; the
   *  file stays on disk (reversible) but loader/resolver stop selecting it. */
  lifecycle_state?: "active" | "soft_archived";
  /** When the age-out reviewer last looked at this entry (bounds re-review so
   *  daily runs don't re-burn tokens on the same keep_aging hypotheses). */
  aged_out_reviewed_at?: string;
  /** The reviewer's call: keep_aging (still viable — re-review later),
   *  soft_archive (retire — sets lifecycle_state + aged_out_at), or
   *  promote_candidate (clearly durable — ADVISORY only; promotion to a
   *  durable entry MUST still pass multi-view §4.4; the entry stays active +
   *  attribution_pending so the future multi-view path can pick it up). */
  aged_out_decision?: "keep_aging" | "soft_archive" | "promote_candidate";
  aged_out_rationale?: string;
  /** Set ONLY on soft_archive — the reversible terminal timestamp. The file
   *  remains in place; RM-LIFECYCLE-002 does not authorize a delete window. */
  aged_out_at?: string;
  aged_out_prompt_version?: string;

  // ── Promotion executor fields (set by staging-promotion.ts, ADR 0025 §4.1.5
  // promotion follow-up). Promotion to durable memory MUST pass the multi-view
  // gate; these fields record the outcome without ever unlinking the file.
  /** When the promotion executor last attempted to promote this entry. Used
   *  to debounce retries (e.g. after a multi-view rejection or writer
   *  failure) so the same candidate is not re-budgeted every agent_end. */
  promotion_attempted_at?: string;
  /** Outcome of the most recent promotion attempt:
   *    - "promoted": multi-view approved and durable write succeeded
   *    - "duplicate": an existing durable entry already covers this signal
   *    - "rejected": multi-view rejected or writer rejected
   *    - "error": unexpected framework error during promotion
   *    - "staged_for_replay": transient reviewer failure; the candidate is
   *      parked in multiview-pending and will be replayed by the A' lane.
   *    - "cluster_sibling": another staging file with the same provisional
   *      slug represented this same cluster in the current promotion run.
   *    - "sibling_deferred": another staging file with the same provisional
   *      slug was reviewed and did not produce a terminal successful target;
   *      keep this file pending for a later run. */
  promotion_outcome?: "promoted" | "duplicate" | "rejected" | "error" | "staged_for_replay" | "cluster_sibling" | "sibling_deferred";
  /** When promotion succeeded. */
  promoted_at?: string;
  /** Slug of the durable entry written on success. */
  promoted_to_slug?: string;
  /** Free-form rationale when promotion was rejected or errored. */
  promotion_rationale?: string;
}

export interface StagingFileOnDisk {
  schema_version: 1;
  entry: StagingEntry;
}
