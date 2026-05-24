/**
 * multiview-staging-replay — agent_end-driven retry loop for the
 * multiview-pending staging entries written by runMultiView's 6
 * transient-failure paths (ADR 0025 P0.5 R-series review batch 3c-i).
 *
 * High-level flow:
 *
 *   1. Load all multiview-pending entries (oldest first).
 *   2. Take the oldest MAX_REPLAY_PER_AGENT_END (3) entries.
 *   3. For each entry:
 *      a. Terminal checks (retry_attempts ≥ retryCapForState OR age
 *         ≥ STALE_DAYS_MULTIVIEW_PENDING) → delete + audit + skip.
 *      b. Reconstruct ProjectEntryDraft from candidate_snapshot.
 *      c. Re-load neighbors from neighbor_slugs (slugs that vanished
 *         since original staging are audited but do not abort replay).
 *      d. Call runMultiView with reconstructed args.
 *      e. mvResult.staged set → replay failed:
 *           - Delete the new auto-staging file (runMultiView created
 *             one with a fresh slug). We keep the ORIGINAL slug for
 *             audit-trail continuity.
 *           - Bump retry_attempts on the original entry in place.
 *      f. mvResult.staged absent → replay succeeded:
 *           - Delete original staging entry.
 *           - When final_decision.op !== "skip", invoke caller's
 *             writeApprovedToBrain (the actual brain write).
 *
 * Audit row format: one ReplayAuditRow per entry processed, returned
 * as the `auditRows` field on ReplayBatchResult so the caller
 * (sediment index.ts agent_end hook in 3c-ii) decides where to log
 * them (currently planned: append to the same audit.jsonl as curator
 * decisions, with `source: multi-view-replay` discriminator).
 *
 * Error policy: any throw from runMultiView / loadNeighborsBySlug /
 * writeApprovedToBrain inside the per-entry loop is CAUGHT and turned
 * into an `outcome: "error"` audit row. We never let one bad entry
 * abort the entire replay batch — the loop must process all attempted
 * entries even if some fail catastrophically. (Contrast with
 * runMultiView's own throw policy: there, A' layer must hold, so
 * propagation is correct. Here, we're already on the staging retry
 * path; an additional failure just means "try again next agent_end".)
 *
 * Cross-device: not applicable. `.state/` is gitignored, replay only
 * processes entries originating on this device (see file header in
 * multiview-staging-types.ts for the D2 discovery).
 */

import type { MemoryEntry } from "../memory/types";
import type { CuratorDecision } from "./curator";
import type { ProjectEntryDraft } from "./writer";
import type { SedimentSettings } from "./settings";
import { runMultiView, type MultiViewResult } from "./multi-view";
import type { ModelRegistryLike } from "./llm-extractor";
import type {
  MultiviewPendingEntry,
  MultiviewPendingState,
} from "./multiview-staging-types";
import {
  MAX_REPLAY_PER_AGENT_END,
  STALE_DAYS_MULTIVIEW_PENDING,
  retryCapForState,
} from "./multiview-staging-types";
import {
  deleteMultiviewPending,
  loadMultiviewPending,
  updateMultiviewPendingAttempts,
} from "./multiview-staging-io";

// ── Types ────────────────────────────────────────────────────────────────

export type ReplayOutcome =
  | "succeeded"             // mvResult clean → brain write executed (or skip honored)
  | "re_staged"             // mvResult still staged → original entry retry++ on disk
  | "terminal_max_retries"  // retry_attempts ≥ retryCapForState → deleted
  | "terminal_stale"        // age ≥ STALE_DAYS_MULTIVIEW_PENDING → deleted
  | "error";                // unexpected exception in replay framework

export interface ReplayAuditRow {
  ts: string;
  slug: string;
  prior_state: MultiviewPendingState;
  prior_attempts: number;
  age_days: number;
  outcome: ReplayOutcome;
  /** Free-form context (error message, neighbor_vanished count, etc.). */
  detail?: string;
  /** When outcome=succeeded, the decision that was written to brain
   *  (or honored as skip). Sanitization is replay's caller's job. */
  new_decision?: CuratorDecision;
  /** When outcome=re_staged, the new state the entry is now in. */
  new_state?: MultiviewPendingState;
  /** When outcome=re_staged, the new retry_attempts count. */
  new_attempts?: number;
  durationMs: number;
}

export interface ReplayBatchResult {
  /** How many staging entries the batch actually processed (could
   *  be < MAX_REPLAY_PER_AGENT_END when fewer were available). */
  attempted: number;
  succeeded: number;
  re_staged: number;
  terminal_max_retries: number;
  terminal_stale: number;
  errors: number;
  /** Total entries on disk before this batch ran (for monitoring). */
  totalPending: number;
  auditRows: ReplayAuditRow[];
  durationMs: number;
}

export interface ReplayDeps {
  settings: SedimentSettings;
  modelRegistry: ModelRegistryLike;
  /** Resolve neighbor slugs to current MemoryEntry contents. Slugs
   *  that no longer exist (archived/deleted/never-existed) should be
   *  omitted from the return value; replay will audit the diff.
   *
   *  Contract (3c-i.5 R6 review):
   *    - MUST use the same load semantics as the original multi-view
   *      trigger (curator.ts::loadEntries → relevantEntriesForCurator)
   *      so the reviewer prompt at replay time matches a reproducible
   *      version of the original context. Using a different source
   *      (e.g. memory_search BM25 only) would drift the prompt and
   *      change reviewer decision for non-staging-state reasons.
   *    - MUST resolve `bare slug` with project > world priority when
   *      a slug collides across scopes (currently single-scope-per-slug
   *      is the convention, but the resolver must commit to one).
   *    - MUST preserve `sourcePath` / `frontmatter` so the
   *      `isWorkflowNeighborEntry` check still works on the replay
   *      path (workflow-lane neighbors are read-only at writer layer;
   *      losing the marker would let reviewer recommend forbidden ops).
   *    - If `loadNeighborsBySlug` throws, the whole entry's replay is
   *      logged as `error` and retry_attempts is NOT incremented
   *      (framework error, not reviewer instability). The next
   *      agent_end will try again. */
  loadNeighborsBySlug: (slugs: string[]) => Promise<MemoryEntry[]>;
  /** Execute the actual brain write when replay decides
   *  final_decision is writer-actionable. Replay does NOT call this
   *  when decision.op === "skip" — the staging entry is just deleted
   *  (the candidate is effectively dropped after reviewer agreed to
   *  drop it). Should be the same writer the original sediment flow
   *  would have used; caller passes the binding. */
  writeApprovedToBrain: (
    decision: CuratorDecision,
    candidate: ProjectEntryDraft,
  ) => Promise<void>;
  signal?: AbortSignal;
}

// ── Reconstruction helpers ───────────────────────────────────────────────

/**
 * Rebuild a `ProjectEntryDraft` from the candidate_snapshot stored at
 * staging time, optionally enriched with derives_from from the final
 * decision (when replay decides op=create with a derives_from
 * relation, we want to preserve the brain graph edge that the
 * original curator would have produced).
 *
 * Batch 3c-i.5 (R3 fix): trigger phrases / sessionId / timelineNote
 * are NOT captured in CandidateSnapshot (schema decided to keep the
 * snapshot small for staging-disk-size budget; see
 * multiview-staging-types.ts::CandidateSnapshot). For replay-driven
 * brain writes those fields will be undefined. The downstream writer
 * (buildMarkdown) silently skips undefined; impact is:
 *   - trigger_phrases lost → the entry has no classifier hooks for
 *     future correction-signal matching. Audit detail flags this.
 *   - sessionId lost → timeline notes the replay session, not the
 *     original turn. Acceptable.
 *   - timelineNote lost → timeline notes default "sediment" text
 *     rather than the original capture rationale. Acceptable.
 * derivesFrom is preserved when finalDecision carries one (it
 * usually does for create-with-relation).
 *
 * If a future phase decides metadata loss is unacceptable, the
 * CandidateSnapshot schema is bumpable; see
 * MULTIVIEW_PENDING_SCHEMA_VERSION migration plan.
 */
function draftFromSnapshot(
  entry: MultiviewPendingEntry,
  finalDecision?: CuratorDecision,
): ProjectEntryDraft {
  const snap = entry.candidate_snapshot;
  // Try to recover derivesFrom from a few possible homes:
  //   - decision.derives_from (CuratorDecision.create / .merge carry it)
  //   - decision.payload?.derives_from (legacy nested shape)
  // Both are runtime-loose checks because CuratorDecision is a
  // discriminated union and not every variant has the field.
  let derivesFrom: string[] | undefined;
  if (finalDecision && typeof finalDecision === "object") {
    const decision = finalDecision as { derives_from?: unknown; payload?: { derives_from?: unknown } };
    const candidate = Array.isArray(decision.derives_from)
      ? decision.derives_from
      : Array.isArray(decision.payload?.derives_from)
        ? decision.payload?.derives_from
        : undefined;
    if (candidate && candidate.every((s) => typeof s === "string")) {
      derivesFrom = candidate as string[];
    }
  }
  return {
    title: snap.title,
    kind: snap.kind as ProjectEntryDraft["kind"],
    compiledTruth: snap.compiledTruth,
    ...(snap.status !== undefined && { status: snap.status as ProjectEntryDraft["status"] }),
    ...(snap.confidence !== undefined && { confidence: snap.confidence }),
    ...(snap.summary !== undefined && { summary: snap.summary }),
    ...(derivesFrom !== undefined && { derivesFrom }),
  };
}

/**
 * Compute age in fractional days from `created` to now. Returns
 * `Infinity` when `created` is unparseable (so the terminal-stale
 * check triggers; treating broken timestamps as "stale" forces
 * cleanup rather than letting them live forever).
 */
function ageInDays(createdIso: string): number {
  const created = Date.parse(createdIso);
  if (!Number.isFinite(created)) return Infinity;
  return (Date.now() - created) / (24 * 60 * 60 * 1000);
}

/**
 * Build a default audit row given current state. Filled in by the
 * per-outcome branches below.
 */
function startAuditRow(entry: MultiviewPendingEntry, t0: number): ReplayAuditRow {
  return {
    ts: new Date().toISOString(),
    slug: entry.slug,
    prior_state: entry.multiview_state,
    prior_attempts: entry.retry_attempts,
    age_days: ageInDays(entry.created),
    // outcome is filled by caller
    outcome: "error",
    durationMs: Date.now() - t0,
  };
}

// ── Main entry ──────────────────────────────────────────────────────────

/**
 * Process up to MAX_REPLAY_PER_AGENT_END oldest multiview-pending
 * entries. Returns a summary plus per-entry audit rows for the caller
 * to persist.
 *
 * This function is safe to invoke even when no entries are pending —
 * loadMultiviewPending returns empty, the batch returns zeros, no
 * reviewer API calls are made.
 */
export async function replayMultiviewPending(deps: ReplayDeps): Promise<ReplayBatchResult> {
  const batchStart = Date.now();
  const loaded = loadMultiviewPending();
  const result: ReplayBatchResult = {
    attempted: 0,
    succeeded: 0,
    re_staged: 0,
    terminal_max_retries: 0,
    terminal_stale: 0,
    errors: 0,
    totalPending: loaded.totalFound,
    auditRows: [],
    durationMs: 0,
  };

  if (loaded.entries.length === 0) {
    result.durationMs = Date.now() - batchStart;
    return result;
  }

  const toReplay = loaded.entries.slice(0, MAX_REPLAY_PER_AGENT_END);

  for (const entry of toReplay) {
    if (deps.signal?.aborted) break;  // foreground turn cancellation
    result.attempted++;
    await processOneEntry(entry, deps, result);
  }

  result.durationMs = Date.now() - batchStart;
  return result;
}

/**
 * Process exactly one staging entry. Mutates `result` in place
 * (counters + auditRows). Caught any throw from runMultiView /
 * loadNeighborsBySlug / writeApprovedToBrain — see file-level error
 * policy.
 */
async function processOneEntry(
  entry: MultiviewPendingEntry,
  deps: ReplayDeps,
  result: ReplayBatchResult,
): Promise<void> {
  const entryStart = Date.now();
  const audit = startAuditRow(entry, entryStart);

  // ── Terminal checks (cheap, no LLM cost) ──

  const cap = retryCapForState(entry.multiview_state);
  if (entry.retry_attempts >= cap) {
    deleteMultiviewPending(entry.slug);
    audit.outcome = "terminal_max_retries";
    audit.detail = `retry_attempts=${entry.retry_attempts} >= cap=${cap} for state=${entry.multiview_state}; entry deleted (candidate effectively dropped)`;
    audit.durationMs = Date.now() - entryStart;
    result.terminal_max_retries++;
    result.auditRows.push(audit);
    return;
  }

  const ageDays = audit.age_days;
  if (ageDays >= STALE_DAYS_MULTIVIEW_PENDING) {
    deleteMultiviewPending(entry.slug);
    audit.outcome = "terminal_stale";
    audit.detail = `age=${ageDays.toFixed(1)}days >= cap=${STALE_DAYS_MULTIVIEW_PENDING}days; entry deleted (candidate effectively dropped)`;
    audit.durationMs = Date.now() - entryStart;
    result.terminal_stale++;
    result.auditRows.push(audit);
    return;
  }

  // ── Re-execute multi-view ──

  let mvResult: MultiViewResult;
  let vanishedSlugs: string[] = [];
  try {
    const neighbors = await deps.loadNeighborsBySlug(entry.neighbor_slugs);
    const foundSet = new Set(neighbors.map((n) => n.slug));
    vanishedSlugs = entry.neighbor_slugs.filter((s) => !foundSet.has(s));

    const draft = draftFromSnapshot(entry);
    mvResult = await runMultiView({
      proposerDecision: entry.proposer_decision,
      proposerRawText: entry.proposer_raw_text,
      candidate: draft,
      neighbors,
      // The schema stores correction_signal as `unknown` to avoid a
      // value-level cycle with correction-pipeline. The shape is
      // CorrectionSignal | null at this point; runMultiView's
      // renderCorrectionSignal handles either.
      correctionSignal: entry.correction_signal as Parameters<typeof runMultiView>[0]["correctionSignal"],
      settings: deps.settings,
      modelRegistry: deps.modelRegistry,
      signal: deps.signal,
    });
  } catch (e: unknown) {
    audit.outcome = "error";
    audit.detail = `replay framework error: ${e instanceof Error ? e.message : String(e)}`;
    audit.durationMs = Date.now() - entryStart;
    result.errors++;
    result.auditRows.push(audit);
    // Note: we do NOT increment retry_attempts on framework errors
    // (e.g. neighbor-loader threw, brain-writer threw). The next
    // agent_end will see the same entry and try again. If the same
    // framework error persists, terminal_stale will eventually
    // collect the entry after STALE_DAYS_MULTIVIEW_PENDING days.
    return;
  }

  // ── P0 fix (3c-i.5 R4): signal aborted during runMultiView ──
  //
  // If the foreground turn was cancelled while reviewer call was in
  // flight, runMultiView's stageAndSkipDecision path would have
  // written a fresh staging entry (pass1/2_call_failed). Treating that
  // as a "failed retry" would consume the retry budget for a non-
  // reviewer-instability reason (just user impatience). Detect abort
  // AFTER runMultiView and bail without incrementing.
  if (deps.signal?.aborted) {
    if (mvResult.staged) {
      // runMultiView wrote a new staging file we don't want — it duplicates
      // the candidate. Remove it so the next agent_end sees only the
      // ORIGINAL entry (still at retry_attempts=N, ready for a fresh try).
      deleteMultiviewPending(mvResult.staged.slug);
    }
    audit.outcome = "error";
    audit.detail = `replay aborted by signal mid-flight; retry_attempts NOT incremented (cancellation is not reviewer instability)${mvResult.staged ? `; new staging ${mvResult.staged.slug} removed` : ""}`;
    audit.durationMs = Date.now() - entryStart;
    result.errors++;
    result.auditRows.push(audit);
    return;
  }

  // ── P1 fix (3c-i.5 R1): triggered=false guards against A' bypass ──
  //
  // If runMultiView decided not to trigger multi-view at replay time
  // (e.g. neighbor vanished so the candidate's confidence no longer
  // meets A' threshold), it returns final_decision = proposerDecision.
  // Writing that directly to brain would bypass reviewer verdict and
  // re-introduce the A' violation that batch 3b/3c exists to close.
  //
  // The original staging entry was created EXACTLY because
  // shouldTriggerMultiView said "this needs review". If the trigger
  // disappeared, the candidate's basis for needing brain-write also
  // disappeared (the same trigger criteria that demanded review).
  // Safer to drop the candidate and audit than to silently write.
  if (!mvResult.triggered) {
    deleteMultiviewPending(entry.slug);
    audit.outcome = "succeeded";
    audit.new_decision = { op: "skip", reason: "replay_no_longer_triggers_multiview", rationale: `Replay's shouldTriggerMultiView returned false (likely neighbor/candidate state changed since original staging). Candidate dropped without brain write to preserve A' constraint.` };
    audit.detail = `replay no longer triggers multi-view (A' guard); original trigger_reason=${entry.trigger_reason}; staging removed, no brain write.${vanishedDetail()}`;
    audit.durationMs = Date.now() - entryStart;
    result.succeeded++;
    result.auditRows.push(audit);
    return;
  }

  // Record neighbor vanish context so audit reader knows context
  // shrank between original staging and replay.
  // (vanishedDetail moved earlier into a function so the triggered=false
  //  fast-path can reference it; same return value.)
  function vanishedDetail(): string {
    return vanishedSlugs.length > 0
      ? ` neighbor_vanished_count=${vanishedSlugs.length} (slugs: ${vanishedSlugs.slice(0, 5).join(",")}${vanishedSlugs.length > 5 ? ",..." : ""})`
      : "";
  }

  // ── Outcome branch ──

  if (mvResult.staged) {
    // Replay failed again. runMultiView already wrote a NEW staging
    // file with a fresh slug (different from entry.slug because the
    // isoTs differentiator changed). Delete that new file and
    // increment retry_attempts on the ORIGINAL slug — we keep the
    // original slug as the persistent identity for audit trail.
    deleteMultiviewPending(mvResult.staged.slug);

    const newAttempts = entry.retry_attempts + 1;
    const updated = updateMultiviewPendingAttempts(
      entry.slug, newAttempts, new Date().toISOString(),
    );

    if (!updated) {
      // 3c-i.5 R2.c fix: update failure means retry_attempts on disk
      // stayed at prior value. If we audit as re_staged, the next
      // agent_end will see same retry_attempts and hit the same cap
      // check, retrying again forever (until terminal_stale at day
      // 14). That's expensive (each retry costs reviewer API calls).
      // Instead, audit as error so monitoring can spot the gap.
      audit.outcome = "error";
      audit.detail = `replay still staged but updateMultiviewPendingAttempts FAILED on slug=${entry.slug}; retry_attempts on disk did NOT advance from ${entry.retry_attempts}. Next agent_end will see the same entry and try again; if this persists, terminal_stale will eventually clean it. Investigate fs write permission / disk space.${vanishedDetail()}`;
      audit.durationMs = Date.now() - entryStart;
      result.errors++;
      result.auditRows.push(audit);
      return;
    }

    audit.outcome = "re_staged";
    audit.new_state = mvResult.staged.state;
    audit.new_attempts = newAttempts;
    audit.detail = `replay still staged (new state=${mvResult.staged.state}); attempts ${entry.retry_attempts}→${newAttempts}.${vanishedDetail()}`;
    audit.durationMs = Date.now() - entryStart;
    result.re_staged++;
    result.auditRows.push(audit);
    return;
  }

  // ── Success path: replay produced a non-staged decision ──

  const finalDecision = mvResult.final_decision;

  // Delete original staging FIRST — if brain write throws later, we
  // don't want a duplicate staging entry to retry. The candidate is
  // already past the A' gate (reviewer agreed), so dropping it now
  // is acceptable.
  deleteMultiviewPending(entry.slug);

  if (finalDecision.op === "skip") {
    // Reviewer ultimately decided skip on replay (e.g. confirm_pass1
    // not synthesizable, multi-view-rejected, deferred-without-staging
    // — all paths that would have been skip the first time). No brain
    // write needed; staging file already removed.
    audit.outcome = "succeeded";
    audit.new_decision = finalDecision;
    audit.detail = `replay decided op=skip(${finalDecision.reason ?? "no reason"}); staging removed, no brain write.${vanishedDetail()}`;
    audit.durationMs = Date.now() - entryStart;
    result.succeeded++;
    result.auditRows.push(audit);
    return;
  }

  // Real brain write. Pass finalDecision into draftFromSnapshot so
  // derivesFrom (if decision carries one) is preserved on the draft.
  // Other metadata fields (triggerPhrases / sessionId / timelineNote)
  // are NOT in CandidateSnapshot — schema decision per R3 fix-up,
  // see draftFromSnapshot JSDoc above.
  try {
    const draft = draftFromSnapshot(entry, finalDecision);
    await deps.writeApprovedToBrain(finalDecision, draft);
    audit.outcome = "succeeded";
    audit.new_decision = finalDecision;
    audit.detail = `replay decided op=${finalDecision.op}; brain write executed; staging removed. metadata_lost: triggerPhrases${draft.derivesFrom ? "" : ", derivesFrom"}, sessionId, timelineNote${vanishedDetail()}`;
    audit.durationMs = Date.now() - entryStart;
    result.succeeded++;
    result.auditRows.push(audit);
  } catch (e: unknown) {
    // Brain write failed AFTER we already removed staging. This is
    // unrecoverable for THIS candidate (the staging entry is gone,
    // the brain write didn't land). Audit loudly so the dogfooder
    // can spot it; the candidate is lost, but A' was respected
    // (reviewer agreed) — the loss is in the persistence layer.
    audit.outcome = "error";
    audit.new_decision = finalDecision;
    audit.detail = `replay decided op=${finalDecision.op} but writeApprovedToBrain threw: ${e instanceof Error ? e.message : String(e)}. Staging already removed; candidate is LOST. Investigate writer logs.${vanishedDetail()}`;
    audit.durationMs = Date.now() - entryStart;
    result.errors++;
    result.auditRows.push(audit);
  }
}
