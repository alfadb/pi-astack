/**
 * multiview-staging-types — schema for `multiview-pending` staging entries.
 *
 * ADR 0025 P0.5 R-series review batch 3 (commit b575eab..da8ae31 lineage):
 * the 3-reviewer T0 audit identified that runMultiView has 7 fallback
 * paths that silently fall back to proposer direct-write — this violates
 * ADR 0025 §3.1 A' layer ("non-trivial create / destructive ops MUST be
 * double-reviewed"). Six of those paths are TRANSIENT failures and should
 * stage the candidate for replay when the reviewer recovers; one path
 * (`confirm_pass1_not_synthesizable`) is a KNOWN P0.5 schema limitation
 * and stays as a hard skip (staging would dead-loop because the schema
 * limitation does not resolve over time — see D5.5A in design review).
 *
 * Six transient paths captured here:
 *
 *   reviewer_unavailable        — no reviewer model registered/auth at
 *                                 multi-view trigger time
 *   pass1_call_failed           — reviewer API/network/timeout in Pass 1
 *   pass1_unparseable           — reviewer returned non-JSON or schema-
 *                                 violating output for Pass 1
 *   pass2_call_failed           — same as pass1 but in Pass 2 (reveal)
 *   pass2_unparseable           — same as pass1 but in Pass 2
 *   deferred                    — Pass 2 verdict = `defer` (reviewer
 *                                 explicitly chose to wait for more signal;
 *                                 ADR 0025 §4.4.5)
 *
 * Replay path (every agent_end):
 *   1. staging-loader returns retryable entries (originating_device match)
 *   2. multiview-staging-replay re-runs runMultiView with the stored args
 *   3. success → write brain, delete staging; failure → increment attempts
 *   4. terminal (attempts ≥ 5 OR age ≥ 14 days) → skip + delete + audit
 *
 * Schema is INTENTIONALLY independent from `staging-types.ts`
 * (provisional-correction). Two different semantic categories:
 *   - provisional-correction: classifier hypothesis (maybe right, maybe
 *     wrong; valuable as context). Lives in same staging/ dir but
 *     resolved by future classifier runs.
 *   - multiview-pending:      candidate that WAS approved-for-brain by
 *     proposer but the A' layer reviewer is unreachable/failed. Lives
 *     in same dir but resolved by reviewer-replay, not classifier.
 *
 * Both kinds coexist in `~/.abrain/.state/sediment/staging/` for git-sync
 * uniformity, but loaders + writers are separate (clear blast radius).
 *
 * See design review (deepseek-v4-pro 2026-05-24): D1 schema completeness,
 * D2 cross-device race (originating_device + optimistic lock in IO layer
 * = batch 3a-ii), D3 neighbor re-load semantics (re-load NOT snapshot),
 * D4 backlog caps (5 attempts × 14 days), D5 state-machine viability,
 * D6 slicing (3a-i / 3a-ii / 3b / 3c-i / 3c-ii), D7 terminal path
 * (simplified delete, NOT §4.6 reactivation-reviewer — that prompt
 * does not exist yet; batch 3 ships before §4.6).
 *
 * Co-tenancy with `staging-types.ts` (provisional-correction):
 *   Both staging kinds share the on-disk directory
 *   `~/.abrain/.state/sediment/staging/`. There is NO type-level
 *   isolation — the same readdir() will surface both file kinds.
 *   The current `loadStagingContext` accidentally filters out
 *   multiview-pending entries because it checks `attribution_pending`
 *   (a field that exists only on StagingEntry); this is fragile.
 *   Batch 3a-ii's `loadMultiviewPending` MUST do an explicit
 *   `kind === "multiview-pending"` discriminator check at the top of
 *   the parse loop, NOT rely on field-presence coincidence. Same for
 *   any future loader; document this in the loader header.
 */

import type { CuratorDecision } from "./curator";
import type {
  MultiViewTriggerReason,
  Pass1Verdict,
  Pass2Verdict,
} from "./multi-view";

// ── State machine ─────────────────────────────────────────────────────────

/**
 * Transient-failure states that produce a `multiview-pending` staging
 * entry. Each maps 1:1 to a specific runMultiView fallback path
 * (see multi-view.ts::runMultiView). NOTE that
 * `confirm_pass1_not_synthesizable` is INTENTIONALLY ABSENT — that
 * path stays as a hard skip (D5.5A design-review verdict).
 */
export type MultiviewPendingState =
  | "reviewer_unavailable"
  | "pass1_call_failed"
  | "pass1_unparseable"
  | "pass2_call_failed"
  | "pass2_unparseable"
  | "deferred";

/**
 * Schema versions. v1 ships with batch 3. Bumping requires a migration
 * in staging-loader's reader (skip-with-audit on unknown version).
 */
export const MULTIVIEW_PENDING_SCHEMA_VERSION = 1 as const;
export type MultiviewPendingSchemaVersion = typeof MULTIVIEW_PENDING_SCHEMA_VERSION;

// ── Snapshot types (the args runMultiView needs at replay time) ─────────

/**
 * Subset of `ProjectEntryDraft` that runMultiView's `renderCandidate`
 * actually reads. Storing only what's used avoids bloating staging
 * entries with fields that have no role in the reviewer prompt
 * (e.g. `sessionId`, `timelineNote`). If `renderCandidate` ever reads
 * additional fields, ADD them here AND bump
 * MULTIVIEW_PENDING_SCHEMA_VERSION.
 *
 * Design review D1.1C: original draft listed only 4 fields ("title,
 * kind, compiledTruth, confidence, ..."); reviewer caught that
 * `derivesFrom` and `summary` and `status` were dropped silently. This
 * type captures all 6 fields that `renderCandidate` references.
 */
export interface CandidateSnapshot {
  title: string;
  kind: string;       // EntryKind, see ../memory/types
  compiledTruth: string;
  status?: string;    // EntryStatus
  confidence?: number;
  summary?: string;
}

/**
 * Slug-only snapshot of the neighbors that were loaded at the original
 * multi-view trigger time. Replay RE-LOADS the current neighbor
 * contents from these slugs — design review D3.3B verdict: "re-load
 * is feature not bug" (reviewer should see neighbor state at replay
 * time, including any archive/supersede that happened since staging).
 */
export type NeighborSlugSnapshot = string[];

// ── Entry shape ───────────────────────────────────────────────────────────

export interface MultiviewPendingEntry {
  /** Bare slug: `multiview-pending-{hash8}` */
  slug: string;
  status: "provisional";
  kind: "multiview-pending";

  /** ISO timestamps. `updated` set on each replay attempt. */
  created: string;
  updated?: string;

  /**
   * Hostname of the device that captured this staging entry. Design
   * review D2.2A verdict: only THIS device's agent_end may attempt
   * replay. Other devices see the entry as context-only (read but
   * do not retry) to prevent cross-device duplicate brain writes.
   * Set from `process.env.HOSTNAME ?? os.hostname() ?? "unknown"`.
   */
  originating_device: string;

  /**
   * Which transient failure path produced this entry. The replay
   * routine uses this to decide whether to re-run Pass 1 + Pass 2
   * from scratch (pass1_* / reviewer_unavailable) or just re-run
   * Pass 2 (pass2_* / deferred) using stored pass1_verdict.
   *
   * NOTE: replay v1 ALWAYS re-runs both passes (simpler; reviewer
   * cost is acceptable per ADR 0024 §6 #7). The "just re-run Pass 2"
   * optimization is deferred to v2.
   */
  multiview_state: MultiviewPendingState;

  // ── runMultiView args needed at replay time ──

  /**
   * The proposer's CuratorDecision at trigger time. If reviewer
   * recovers and confirms it, this is what gets written to brain.
   * Stored as the full serialized decision (op + scope + slug? +
   * reason? + rationale + payload).
   */
  proposer_decision: CuratorDecision;

  /**
   * The proposer's raw LLM output (curator JSON + reasoning).
   * Design review D1.1A blocker: Pass 2 prompt injects this verbatim
   * (`sanitizeText(args.proposerRawText.slice(0, 4000))`); without it,
   * Pass 2 sees only the serialized decision and loses the
   * proposer's natural-language reasoning. Truncated at write time
   * to match the Pass 2 prompt's own cap.
   */
  proposer_raw_text: string;  // already truncated to <= 4000 chars

  /** The candidate the curator was deciding about. */
  candidate_snapshot: CandidateSnapshot;

  /**
   * The CorrectionSignal that the classifier produced for this turn
   * (may be null when the candidate came from non-correction path).
   * Design review D1.1B major: Pass 1/2 contextBlock includes
   * `renderCorrectionSignal(args.correctionSignal)`; replay needs
   * this signal to reproduce the same context. Stored as full
   * CorrectionSignal — `renderCorrectionSignal` does its own field
   * extraction at render time.
   *
   * `null` represents the non-correction-signal path (proposer was
   * triggered by some non-classifier route). The replay routine
   * checks for null and passes it straight through to runMultiView.
   *
   * Loose typing (`unknown`, which already includes null) because
   * importing CorrectionSignal type from `./correction-pipeline`
   * would risk a value-level cycle (correction-pipeline imports
   * staging-loader). The replay routine casts back to
   * CorrectionSignal when loading.
   */
  correction_signal: unknown;

  /** Neighbor slugs at trigger time; replay re-loads current content. */
  neighbor_slugs: NeighborSlugSnapshot;

  /** What triggered runMultiView for this candidate originally. */
  trigger_reason: MultiViewTriggerReason;

  // ── Verdicts produced before failure (optional based on state) ──

  /**
   * Pass 1 verdict if reviewer reached Pass 1 successfully. Must be
   * present when multiview_state ∈ {pass2_call_failed,
   * pass2_unparseable, deferred}; must be ABSENT when multiview_state
   * ∈ {reviewer_unavailable, pass1_call_failed, pass1_unparseable}.
   * Runtime-checked at write (see validateMultiviewPendingConsistency
   * below); not encoded in the type to keep the type non-discriminated
   * for easier JSON serialization.
   *
   * `Pass1Verdict.raw` contains the full reviewer model output; the
   * batch 3a-ii writer (writeMultiviewPending) MUST clip this field
   * to PROPOSER_RAW_TEXT_CAP (4000 chars) at write time to avoid
   * staging files bloating to 25KB+ when reviewer models emit long
   * chain-of-thought. Type-level enforcement is impractical without
   * a wrapper type; runtime clipping is the contract.
   */
  pass1_verdict?: Pass1Verdict;

  /**
   * Pass 2 verdict if reviewer reached Pass 2 successfully. Must be
   * present when multiview_state === "deferred"; must be ABSENT
   * otherwise. Runtime-checked at write.
   *
   * Same `raw` clipping contract applies: batch 3a-ii writer clips
   * `Pass2Verdict.raw` to PROPOSER_RAW_TEXT_CAP before persistence.
   */
  pass2_verdict?: Pass2Verdict;

  // ── Backlog control ──

  /**
   * Number of replay attempts completed (not including the original
   * trigger). Starts at 0 when staged. Design review D4.4A: terminal
   * threshold = 5 attempts. Each agent_end increments at most once
   * per entry.
   */
  retry_attempts: number;

  /**
   * ISO timestamp of the most recent replay attempt (or original
   * staging time when retry_attempts === 0).
   */
  last_attempt_iso: string;
}

/**
 * Wire shape written to disk. Mirrors `StagingFileOnDisk`
 * (staging-types.ts) but with its own schema version so the two
 * staging kinds evolve independently.
 */
export interface MultiviewPendingFileOnDisk {
  schema_version: MultiviewPendingSchemaVersion;
  entry: MultiviewPendingEntry;
}

// ── Limits / thresholds (centralized so 3b/3c can import without dup) ───

/**
 * Maximum number of replay attempts before terminal skip. Design
 * review D4.4A: 5 attempts spans ~5 agent_end sessions, roughly
 * half a day to a day. NOTE: deferred entries cap at
 * MAX_RETRY_ATTEMPTS_DEFERRED (lower) per D5.5B verdict.
 */
export const MAX_RETRY_ATTEMPTS = 5 as const;

/**
 * Lower cap for `deferred` entries — DEFER is reviewer's "wait for
 * more signal", not a transient failure; success rate per retry is
 * lower. After 3 attempts, the entry is dropped (D5.5B suggested
 * converting to provisional-correction staging, but batch 3 v1 takes
 * the simpler approach: drop + audit, future enhancement can convert).
 */
export const MAX_RETRY_ATTEMPTS_DEFERRED = 3 as const;

/**
 * Maximum age in days before terminal skip even if retry_attempts
 * has not hit cap (e.g. agent_end ran rarely). Design review D4.4B:
 * 14 days, shorter than provisional-correction's 30-day STALE_DAYS
 * (multiview-pending is more urgent — it's a confirmed-by-proposer
 * candidate stuck waiting for A' layer review).
 */
export const STALE_DAYS_MULTIVIEW_PENDING = 14 as const;

/**
 * Maximum entries to attempt replay per agent_end. Design review
 * D4.4D: 3 oldest entries per session = ~6 reviewer API calls
 * (Pass 1 + Pass 2 each), cost-bounded per ADR 0024 §6 #7.
 */
export const MAX_REPLAY_PER_AGENT_END = 3 as const;

/**
 * Max characters of `proposer_raw_text` stored per entry. Matches the
 * existing Pass 2 prompt cap (`proposerRawText.slice(0, 4000)`) so
 * replay reproduces the same context the original Pass 2 saw.
 */
export const PROPOSER_RAW_TEXT_CAP = 4000 as const;

// ── Slug generation ───────────────────────────────────────────────────────

/**
 * Generate `multiview-pending-{hash8}` slug from a candidate snapshot
 * + trigger timestamp. Collision probability is sha256-derived (2^32
 * for the first 8 hex chars) — adequate for a single device's
 * staging dir lifetime (we expect O(100) entries lifetime).
 *
 * Algorithm: sha256(compiledTruth + "\n" + isoTs).slice(0, 8). The
 * isoTs differentiator means two replays of the same candidate at
 * different moments yield different slugs (replay deletes the old
 * staging file before writing a new one, but this also handles the
 * pathological case where a writer crashed mid-replay).
 *
 * Crypto import is deferred to runtime (3a-ii IO layer) — this
 * file is types-only to avoid pulling node:crypto into type-check
 * surface area.
 */
export interface SlugInputs {
  compiledTruth: string;
  isoTs: string;
}

/**
 * Validate that a MultiviewPendingEntry's optional verdict fields
 * are consistent with its multiview_state. Returns null when
 * consistent, or a description of the inconsistency.
 *
 * Renamed from `assertMultiviewPendingConsistent` (batch 3a-i review
 * S3): the original name implied throw-on-fail per JS/TS convention
 * (Node `assert.*`, jest `expect`); this function returns the error
 * message instead so callers can decide whether to throw / log /
 * audit. The batch 3a-ii writer throws on non-null; the replay
 * routine logs to audit and skips.
 *
 * NOT a type-level guard (the type intentionally allows the
 * cross-product to keep JSON serialization trivial).
 *
 * Rules:
 *   state=reviewer_unavailable    → pass1_verdict ABSENT, pass2_verdict ABSENT
 *   state=pass1_call_failed       → pass1_verdict ABSENT, pass2_verdict ABSENT
 *   state=pass1_unparseable       → pass1_verdict ABSENT, pass2_verdict ABSENT
 *   state=pass2_call_failed       → pass1_verdict PRESENT, pass2_verdict ABSENT
 *   state=pass2_unparseable       → pass1_verdict PRESENT, pass2_verdict ABSENT
 *   state=deferred                → pass1_verdict PRESENT, pass2_verdict PRESENT
 */
export function validateMultiviewPendingConsistency(
  entry: MultiviewPendingEntry,
): string | null {
  const has1 = entry.pass1_verdict !== undefined;
  const has2 = entry.pass2_verdict !== undefined;
  const state = entry.multiview_state;

  const expect = (want1: boolean, want2: boolean): string | null => {
    if (has1 !== want1) {
      return `multiview_state=${state} requires pass1_verdict ${want1 ? "present" : "absent"} (got ${has1 ? "present" : "absent"})`;
    }
    if (has2 !== want2) {
      return `multiview_state=${state} requires pass2_verdict ${want2 ? "present" : "absent"} (got ${has2 ? "present" : "absent"})`;
    }
    return null;
  };

  switch (state) {
    case "reviewer_unavailable":
    case "pass1_call_failed":
    case "pass1_unparseable":
      return expect(false, false);
    case "pass2_call_failed":
    case "pass2_unparseable":
      return expect(true, false);
    case "deferred":
      return expect(true, true);
    default: {
      // Exhaustiveness check at compile time.
      const _exhaustive: never = state;
      return `unknown multiview_state: ${String(_exhaustive)}`;
    }
  }
}

/**
 * Return the retry cap for a given state. `deferred` uses the lower
 * MAX_RETRY_ATTEMPTS_DEFERRED (3) per D5.5B; transient failures use
 * MAX_RETRY_ATTEMPTS (5).
 *
 * Implemented as a switch + never-guard rather than a ternary (batch
 * 3a-i review S3) so adding a new MultiviewPendingState in the future
 * fails to compile here — forcing a deliberate decision on whether
 * the new state is a transient failure (5 attempts) or a
 * waiting-for-signal pattern (3 attempts). Silent default was the
 * original risk.
 */
export function retryCapForState(state: MultiviewPendingState): number {
  switch (state) {
    case "deferred":
      return MAX_RETRY_ATTEMPTS_DEFERRED;
    case "reviewer_unavailable":
    case "pass1_call_failed":
    case "pass1_unparseable":
    case "pass2_call_failed":
    case "pass2_unparseable":
      return MAX_RETRY_ATTEMPTS;
    default: {
      const _exhaustive: never = state;
      // Unreachable at type-check; defensive return for forced-cast callers.
      return MAX_RETRY_ATTEMPTS;
      void _exhaustive;
    }
  }
}
