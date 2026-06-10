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

  /** Raw CorrectionSignal output (for audit trace) */
  correction_signal?: {
    typing: string;
    confidence: number;
    /** R2' is_directive (PR-2 2026-06-10): carried for shadow/recall
     *  forensics — a staged signal that WAS a directive but missed Tier-1
     *  is what the O5 sunset audit needs to see. null = classifier did
     *  not emit the field (pre-v2 prompt or non-boolean shape). */
    is_directive?: boolean | null;
    scope_description: string;
    correction_intent: string;
    most_likely_error_direction: string;
  };

  /** Frontmatter: warning for downstream consumers */
  _provenance_warning: string;

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
  // disposition. Stage 4 is REVERSIBLE soft-archive ONLY — it NEVER unlinks a
  // file, because staging lives in git-ignored `.state/` so unlink is
  // irreversible (no `git rm` recovery, unlike durable §4.6 entries). The
  // mechanical N-day-window → hard-delete (unlink) is a deferred follow-up
  // (Stage 5). `attribution_pending` is left UNTOUCHED on purpose: it remains
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
  /** Set ONLY on soft_archive — the retire timestamp. A future mechanical
   *  hard-delete sweep (Stage 5) reads this to enforce its N-day window. */
  aged_out_at?: string;
  aged_out_prompt_version?: string;
}

export interface StagingFileOnDisk {
  schema_version: 1;
  entry: StagingEntry;
}
