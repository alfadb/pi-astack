import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveUserGlobalAbrainHome } from "../_shared/runtime";
import { atomicWriteText, withFileLock } from "../_shared/sync-file-lock";
import { normalizeLifecycleProposalRow } from "./entry-lifecycle-proposals";
import { archiveMultiviewPending, loadMultiviewPending } from "./multiview-staging-io";
import { retryCapForState, STALE_DAYS_MULTIVIEW_PENDING, type MultiviewPendingEntry } from "./multiview-staging-types";
import type { StagingEntry } from "./staging-types";
import {
  LIFECYCLE_COHORT_CUTOVER_UTC,
  ensureMultiviewLifecycleMetadata,
  lifecycleCohortFor as cohortFor,
  lifecycleItemId,
  multiviewLifecycleFailureClass as failureClassForMultiview,
  scheduleLifecycleRetry as scheduleFor,
  validLifecycleIso as validIso,
  type LifecycleCohort,
  type LifecycleFailureClass,
  type LifecycleQueueKind,
} from "./lifecycle-source-metadata";

export { LIFECYCLE_COHORT_CUTOVER_UTC } from "./lifecycle-source-metadata";
export type { LifecycleCohort, LifecycleFailureClass, LifecycleQueueKind } from "./lifecycle-source-metadata";
export const LIFECYCLE_CONVERGENCE_SCHEMA_VERSION = "lifecycle-convergence/v1" as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WRITER_RETRY_ATTEMPTS = 24;
const LIFECYCLE_PROPOSAL_MAX_ROWS = 1000;

export interface LifecycleConvergenceRow {
  schema_version: typeof LIFECYCLE_CONVERGENCE_SCHEMA_VERSION;
  item_id: string;
  queue_kind: LifecycleQueueKind;
  arrival_at: string;
  cohort: LifecycleCohort;
  current_state: string;
  terminal_at?: string;
  terminal_reason?: string;
  next_retry_not_before?: string;
  deadline?: string;
  new_evidence_trigger?: string;
  attempt: number;
  failure_class: LifecycleFailureClass;
  source_fingerprint: string;
}

export interface LifecycleQueueMetrics {
  arrivals: number;
  terminal: number;
  pending: number;
  oldest_pending_age_days: number | null;
  oldest_fresh_pending_age_days: number | null;
}

export interface LifecycleConvergenceMetrics {
  as_of: string;
  arrivals: number;
  terminal: number;
  pending: number;
  oldest_pending_age_days: number | null;
  oldest_fresh_pending_age_days: number | null;
  unbounded_pending: number;
  retry_count: number;
  failure_classes: Record<LifecycleFailureClass, number>;
  cohorts: Record<LifecycleCohort, { arrivals: number; terminal: number; pending: number; conservation_holds: boolean }>;
  queues: Record<LifecycleQueueKind, LifecycleQueueMetrics>;
  continuity_holds: boolean;
  continuity_baseline: "bootstrap_no_previous_model" | "persisted_read_model";
  previous_item_count: number;
  missing_previous_item_ids: string[];
  conservation: { holds: boolean; arrivals: number; terminal_plus_pending: number; delta: number; previous_items: number; missing_previous_items: number };
  source: {
    valid_records: number;
    corrupt_records: number;
    duplicate_item_ids: number;
    proposal_rows: number;
    proposal_row_limit: number;
    proposal_row_limit_reached: boolean;
  };
}

export interface LifecycleConvergenceReadModel {
  schema_version: typeof LIFECYCLE_CONVERGENCE_SCHEMA_VERSION;
  generated_at: string;
  cohort_cutover_at: typeof LIFECYCLE_COHORT_CUTOVER_UTC;
  rows: LifecycleConvergenceRow[];
  metrics: LifecycleConvergenceMetrics;
}

export interface RebuildLifecycleConvergenceResult {
  ok: boolean;
  written: boolean;
  read_model?: LifecycleConvergenceReadModel;
  error?: string;
}

export interface LifecycleSourceReconcileResult {
  ok: boolean;
  updated: number;
  provisional_updated: number;
  multiview_updated: number;
  abandoned_migrated: number;
  deadline_terminal: number;
  provisional_deadline_terminal: number;
  corrupt_records: number;
  error?: string;
}

export interface MultiviewTerminalSweepResult {
  ok: boolean;
  scanned: number;
  terminal: number;
  stale: number;
  retry_cap: number;
  writer_cap: number;
  already_terminal: number;
  already_terminal_archived: number;
  deadline_expired: number;
  archive_failed: number;
}

interface LifecycleSourceFields {
  lifecycle_item_id?: string;
  lifecycle_cohort?: LifecycleCohort;
  lifecycle_attempt?: number;
  lifecycle_failure_class?: LifecycleFailureClass;
  lifecycle_next_retry_not_before?: string;
  lifecycle_deadline?: string;
  lifecycle_new_evidence_trigger?: string;
  lifecycle_terminal_at?: string;
  lifecycle_terminal_reason?: string;
}

type ProvisionalLifecycleEntry = StagingEntry & LifecycleSourceFields;
type MultiviewLifecycleEntry = MultiviewPendingEntry & LifecycleSourceFields;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sourceLockPath(abrainHome: string): string {
  // Share the multiview mutation lock so reconciliation cannot recreate a live
  // source after another process atomically moves it into abandoned/.
  return path.join(path.resolve(abrainHome), ".state", "sediment", "staging", ".locks", "multiview-pending.lock");
}

export function lifecycleConvergencePath(abrainHome = resolveUserGlobalAbrainHome()): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "lifecycle-convergence.json");
}

function lifecycleConvergenceLockPath(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "locks", "lifecycle-convergence.lock");
}

function provisionalTerminal(entry: ProvisionalLifecycleEntry): { at: string; reason: string; state: string } | undefined {
  const explicitAt = validIso(entry.lifecycle_terminal_at);
  if (explicitAt && entry.lifecycle_terminal_reason) {
    return { at: explicitAt, reason: entry.lifecycle_terminal_reason, state: `terminal_${entry.lifecycle_terminal_reason}` };
  }
  if (entry.lifecycle_state === "soft_archived") {
    return { at: validIso(entry.aged_out_at) ?? validIso(entry.aged_out_reviewed_at) ?? validIso(entry.created)!, reason: "soft_archived", state: "terminal_soft_archived" };
  }
  if (entry.promotion_outcome === "promoted") {
    return { at: validIso(entry.promoted_at) ?? validIso(entry.promotion_attempted_at) ?? validIso(entry.created)!, reason: "promoted", state: "terminal_promoted" };
  }
  if (entry.promotion_outcome === "duplicate" || entry.promotion_outcome === "cluster_sibling") {
    return { at: validIso(entry.promotion_attempted_at) ?? validIso(entry.created)!, reason: entry.promotion_outcome, state: `terminal_${entry.promotion_outcome}` };
  }
  if (entry.promotion_outcome === "rejected") {
    return { at: validIso(entry.promotion_attempted_at) ?? validIso(entry.created)!, reason: "reviewer_rejected", state: "terminal_reviewer_rejected" };
  }
  return undefined;
}

function provisionalFailureClass(entry: ProvisionalLifecycleEntry): LifecycleFailureClass {
  if (entry.lifecycle_failure_class) return entry.lifecycle_failure_class;
  if (entry.promotion_outcome === "error") return "transient";
  return "semantic_defer";
}

function provisionalState(entry: ProvisionalLifecycleEntry, now: Date): string {
  if (entry.promotion_outcome === "staged_for_replay") return "pending_multiview_replay";
  if (entry.promotion_outcome === "error") return "pending_promotion_retry";
  if (entry.aged_out_decision === "keep_aging") return "pending_ageout_review";
  if (entry.aged_out_decision === "promote_candidate" || entry.resolver_disposition === "promote_candidate") return "pending_promotion";
  if (Date.parse(entry.created) + 30 * DAY_MS <= now.getTime()) return "pending_ageout_review";
  return "pending_resolver";
}

interface LifecycleStagingFileOnDisk {
  schema_version: 1;
  entry: ProvisionalLifecycleEntry | MultiviewLifecycleEntry;
  [key: string]: unknown;
}

function writeStagingFileAtomic(file: string, document: LifecycleStagingFileOnDisk): void {
  atomicWriteText(file, `${JSON.stringify(document, null, 2)}\n`);
}

export function recordProvisionalLifecycleFailure(
  files: string[],
  failureClass: Exclude<LifecycleFailureClass, "none" | "writer">,
  trigger: string,
  now: Date = new Date(),
): { updated: number; failed: number } {
  const abrainHome = path.resolve(process.env.ABRAIN_ROOT || resolveUserGlobalAbrainHome());
  const locked = withFileLock(sourceLockPath(abrainHome), () => {
    let updated = 0;
    let failed = 0;
    for (const file of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as LifecycleStagingFileOnDisk;
        if (parsed?.schema_version !== 1 || parsed.entry?.kind !== "provisional-correction") continue;
        const entry = parsed.entry as ProvisionalLifecycleEntry;
        const arrival = validIso(entry.created);
        if (!arrival) { failed++; continue; }
        const attempt = Math.max(0, entry.lifecycle_attempt ?? 0) + 1;
        const schedule = scheduleFor(now, failureClass, attempt, failureClass === "semantic_defer" ? 14 * DAY_MS : 7 * DAY_MS);
        entry.lifecycle_item_id = entry.lifecycle_item_id ?? lifecycleItemId("provisional_correction", [arrival, entry.slug, entry.originating_device]);
        entry.lifecycle_cohort = entry.lifecycle_cohort ?? cohortFor(arrival);
        entry.lifecycle_attempt = attempt;
        entry.lifecycle_failure_class = failureClass;
        entry.lifecycle_next_retry_not_before = schedule.next;
        entry.lifecycle_deadline = schedule.deadline;
        entry.lifecycle_new_evidence_trigger = trigger;
        writeStagingFileAtomic(file, parsed);
        updated++;
      } catch {
        failed++;
      }
    }
    return { updated, failed };
  });
  return locked.ok ? locked.value : { updated: 0, failed: files.length };
}

export function reconcileStagingLifecycleSources(options: { abrainHome?: string; now?: Date } = {}): LifecycleSourceReconcileResult {
  const abrainHome = path.resolve(options.abrainHome ?? resolveUserGlobalAbrainHome());
  const now = options.now ?? new Date();
  const dir = path.join(abrainHome, ".state", "sediment", "staging");
  const locked = withFileLock(sourceLockPath(abrainHome), () => {
    let updated = 0;
    let provisionalUpdated = 0;
    let multiviewUpdated = 0;
    let abandonedMigrated = 0;
    let deadlineTerminal = 0;
    let provisionalDeadlineTerminal = 0;
    let corruptRecords = 0;
    const reconcileFile = (file: string, abandoned: boolean): void => {
      let parsed: LifecycleStagingFileOnDisk;
      try { parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as LifecycleStagingFileOnDisk; }
      catch { corruptRecords++; return; }
      const rawEntry = parsed.entry;
      if (parsed.schema_version !== 1 || !rawEntry || typeof rawEntry !== "object") { corruptRecords++; return; }
      const before = JSON.stringify(parsed);
      if (rawEntry.kind === "provisional-correction") {
        const entry = rawEntry as unknown as ProvisionalLifecycleEntry;
        const arrival = validIso(entry.created);
        if (!arrival) { corruptRecords++; return; }
        entry.lifecycle_item_id = entry.lifecycle_item_id ?? lifecycleItemId("provisional_correction", [arrival, entry.slug, entry.originating_device]);
        entry.lifecycle_cohort = entry.lifecycle_cohort ?? cohortFor(arrival);
        let terminal = provisionalTerminal(entry);
        const deadline = validIso(entry.lifecycle_deadline);
        if (!terminal && deadline && Date.parse(deadline) <= now.getTime()) {
          entry.lifecycle_state = "soft_archived";
          entry.lifecycle_terminal_at = now.toISOString();
          entry.lifecycle_terminal_reason = "provisional_deadline_expired";
          terminal = provisionalTerminal(entry);
          deadlineTerminal++;
          provisionalDeadlineTerminal++;
        }
        if (terminal) {
          entry.lifecycle_terminal_at = terminal.at;
          entry.lifecycle_terminal_reason = terminal.reason;
          delete entry.lifecycle_next_retry_not_before;
          delete entry.lifecycle_deadline;
          delete entry.lifecycle_new_evidence_trigger;
          entry.lifecycle_failure_class = "none";
        } else {
          const attempt = Math.max(entry.lifecycle_attempt ?? 0, entry.promotion_outcome === "error" ? 1 : 0);
          const failureClass = provisionalFailureClass(entry);
          const schedule = scheduleFor(now, failureClass, Math.max(1, attempt), 14 * DAY_MS);
          entry.lifecycle_attempt = attempt;
          entry.lifecycle_failure_class = failureClass;
          entry.lifecycle_next_retry_not_before = validIso(entry.lifecycle_next_retry_not_before) ?? schedule.next;
          entry.lifecycle_deadline = validIso(entry.lifecycle_deadline) ?? schedule.deadline;
          entry.lifecycle_new_evidence_trigger = entry.lifecycle_new_evidence_trigger ?? "new_matching_correction_evidence|resolver_or_ageout_due|promotion_replay_resolution";
        }
        if (JSON.stringify(parsed) !== before) {
          writeStagingFileAtomic(file, parsed);
          updated++;
          provisionalUpdated++;
        }
        return;
      }
      if (rawEntry.kind === "multiview-pending") {
        const entry = rawEntry as unknown as MultiviewLifecycleEntry;
        const arrival = validIso(entry.created);
        if (!arrival) { corruptRecords++; return; }
        const terminalAt = validIso(entry.lifecycle_terminal_at);
        if (entry.lifecycle_terminal_at !== undefined && !terminalAt) { corruptRecords++; return; }
        if (terminalAt || abandoned) {
          entry.lifecycle_item_id = entry.lifecycle_item_id ?? lifecycleItemId("multiview_pending", [arrival, entry.slug, entry.originating_device]);
          entry.lifecycle_cohort = entry.lifecycle_cohort ?? cohortFor(arrival);
          entry.lifecycle_attempt = Math.max(0, entry.lifecycle_attempt ?? ((entry.retry_attempts ?? 0) + (entry.writer_retry_attempts ?? 0)));
          if (terminalAt) {
            entry.lifecycle_terminal_at = terminalAt;
            entry.lifecycle_terminal_reason = entry.lifecycle_terminal_reason ?? "terminal_recovery";
          } else {
            entry.lifecycle_terminal_at = now.toISOString();
            entry.lifecycle_terminal_reason = "legacy_abandoned_migration";
            abandonedMigrated++;
          }
          entry.lifecycle_failure_class = "none";
          delete entry.lifecycle_next_retry_not_before;
          delete entry.lifecycle_deadline;
          delete entry.lifecycle_new_evidence_trigger;
        } else {
          ensureMultiviewLifecycleMetadata(entry, now);
        }
        if (JSON.stringify(parsed) !== before) {
          writeStagingFileAtomic(file, parsed);
          updated++;
          multiviewUpdated++;
        }
      }
    };

    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) reconcileFile(path.join(dir, name), false);
      const abandonedDir = path.join(dir, "abandoned");
      if (fs.existsSync(abandonedDir)) {
        for (const name of fs.readdirSync(abandonedDir).filter((name) => name.endsWith(".json")).sort()) reconcileFile(path.join(abandonedDir, name), true);
      }
    }
    return {
      ok: true,
      updated,
      provisional_updated: provisionalUpdated,
      multiview_updated: multiviewUpdated,
      abandoned_migrated: abandonedMigrated,
      deadline_terminal: deadlineTerminal,
      provisional_deadline_terminal: provisionalDeadlineTerminal,
      corrupt_records: corruptRecords,
    };
  });
  if (!locked.ok) return { ok: false, updated: 0, provisional_updated: 0, multiview_updated: 0, abandoned_migrated: 0, deadline_terminal: 0, provisional_deadline_terminal: 0, corrupt_records: 0, error: "lifecycle_source_lock_contention" };
  return locked.value;
}

export function sweepMultiviewTerminalEntries(options: { now?: Date } = {}): MultiviewTerminalSweepResult {
  const now = options.now ?? new Date();
  const loaded = loadMultiviewPending();
  const result: MultiviewTerminalSweepResult = { ok: true, scanned: loaded.entries.length, terminal: 0, stale: 0, retry_cap: 0, writer_cap: 0, already_terminal: 0, already_terminal_archived: 0, deadline_expired: 0, archive_failed: 0 };
  for (const entry of loaded.entries as MultiviewLifecycleEntry[]) {
    if (entry.lifecycle_terminal_at) {
      result.already_terminal++;
      if (archiveMultiviewPending(entry.slug, { terminalAt: entry.lifecycle_terminal_at, terminalReason: entry.lifecycle_terminal_reason ?? "terminal_recovery" })) result.already_terminal_archived++;
      else result.archive_failed++;
      continue;
    }
    const ageDays = (now.getTime() - Date.parse(entry.created)) / DAY_MS;
    const deadline = validIso(entry.lifecycle_deadline);
    let reason: string | undefined;
    if (deadline && Date.parse(deadline) <= now.getTime()) {
      reason = "multiview_deadline_expired";
      result.deadline_expired++;
    } else if (!Number.isFinite(ageDays) || ageDays >= STALE_DAYS_MULTIVIEW_PENDING) {
      reason = "multiview_stale";
      result.stale++;
    } else if ((entry.writer_retry_attempts ?? 0) >= MAX_WRITER_RETRY_ATTEMPTS) {
      reason = "multiview_writer_retry_cap";
      result.writer_cap++;
    } else if ((entry.retry_attempts ?? 0) >= retryCapForState(entry.multiview_state)) {
      reason = "multiview_reviewer_retry_cap";
      result.retry_cap++;
    }
    if (!reason) continue;
    if (archiveMultiviewPending(entry.slug, { terminalAt: now.toISOString(), terminalReason: reason })) result.terminal++;
    else result.archive_failed++;
  }
  result.ok = result.archive_failed === 0;
  return result;
}

function readStagingRows(abrainHome: string, now: Date): { rows: LifecycleConvergenceRow[]; corrupt: number } {
  const rows: LifecycleConvergenceRow[] = [];
  let corrupt = 0;
  const dir = path.join(abrainHome, ".state", "sediment", "staging");
  const readDir = (scanDir: string, abandoned = false): void => {
    if (!fs.existsSync(scanDir)) return;
    for (const name of fs.readdirSync(scanDir).filter((name) => name.endsWith(".json")).sort()) {
      const file = path.join(scanDir, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) { corrupt++; continue; }
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { entry?: Record<string, unknown> };
        const raw = parsed.entry;
        if (!raw || typeof raw !== "object") { corrupt++; continue; }
        if (raw.kind === "provisional-correction") {
          const entry = raw as unknown as ProvisionalLifecycleEntry;
          const arrival = validIso(entry.created);
          if (!arrival) { corrupt++; continue; }
          const terminal = provisionalTerminal(entry);
          const failureClass = terminal ? "none" : provisionalFailureClass(entry);
          const itemId = entry.lifecycle_item_id ?? lifecycleItemId("provisional_correction", [arrival, entry.slug, entry.originating_device]);
          rows.push({
            schema_version: LIFECYCLE_CONVERGENCE_SCHEMA_VERSION,
            item_id: itemId,
            queue_kind: "provisional_correction",
            arrival_at: arrival,
            cohort: entry.lifecycle_cohort ?? cohortFor(arrival),
            current_state: terminal?.state ?? provisionalState(entry, now),
            ...(terminal ? { terminal_at: terminal.at, terminal_reason: terminal.reason } : {
              next_retry_not_before: validIso(entry.lifecycle_next_retry_not_before),
              deadline: validIso(entry.lifecycle_deadline),
              new_evidence_trigger: entry.lifecycle_new_evidence_trigger,
            }),
            attempt: Math.max(0, entry.lifecycle_attempt ?? 0),
            failure_class: failureClass,
            source_fingerprint: sourceFingerprint(parsed),
          });
        } else if (raw.kind === "multiview-pending") {
          const entry = raw as unknown as MultiviewLifecycleEntry;
          const arrival = validIso(entry.created);
          if (!arrival) { corrupt++; continue; }
          const terminalAt = validIso(entry.lifecycle_terminal_at);
          if (abandoned && !terminalAt) { corrupt++; continue; }
          const failureClass = terminalAt ? "none" : failureClassForMultiview(entry);
          rows.push({
            schema_version: LIFECYCLE_CONVERGENCE_SCHEMA_VERSION,
            item_id: entry.lifecycle_item_id ?? lifecycleItemId("multiview_pending", [arrival, entry.slug, entry.originating_device]),
            queue_kind: "multiview_pending",
            arrival_at: arrival,
            cohort: entry.lifecycle_cohort ?? cohortFor(arrival),
            current_state: terminalAt ? "terminal_abandoned" : failureClass === "writer" ? "pending_writer" : "pending_replay",
            ...(terminalAt ? { terminal_at: terminalAt, terminal_reason: entry.lifecycle_terminal_reason ?? "abandoned" } : {
              next_retry_not_before: validIso(entry.lifecycle_next_retry_not_before ?? entry.next_retry_not_before_iso),
              deadline: validIso(entry.lifecycle_deadline),
              new_evidence_trigger: entry.lifecycle_new_evidence_trigger,
            }),
            attempt: Math.max(0, entry.lifecycle_attempt ?? ((entry.retry_attempts ?? 0) + (entry.writer_retry_attempts ?? 0))),
            failure_class: failureClass,
            source_fingerprint: sourceFingerprint(parsed),
          });
        }
      } catch {
        corrupt++;
      }
    }
  };
  readDir(dir);
  readDir(path.join(dir, "abandoned"), true);
  return { rows, corrupt };
}

function readProposalRows(abrainHome: string): { rows: LifecycleConvergenceRow[]; corrupt: number; sourceRecords: number; limitExceeded: boolean } {
  const rows: LifecycleConvergenceRow[] = [];
  let corrupt = 0;
  let sourceRecords = 0;
  const file = path.join(abrainHome, ".state", "sediment", "entry-lifecycle-proposals.jsonl");
  if (!fs.existsSync(file)) return { rows, corrupt, sourceRecords, limitExceeded: false };
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    sourceRecords++;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { corrupt++; continue; }
    const proposal = normalizeLifecycleProposalRow(raw);
    if (!proposal) { corrupt++; continue; }
    const arrival = validIso(proposal.ts);
    if (!arrival) { corrupt++; continue; }
    const terminal = proposal.status === "executed" || proposal.status === "failed";
    const terminalAt = validIso(proposal.terminal_at);
    if (terminal && !terminalAt) { corrupt++; continue; }
    const failureClass: LifecycleFailureClass = terminal ? "none" : proposal.failure_class ?? (proposal.reason === "superseded_no_successor" ? "semantic_defer" : "transient");
    rows.push({
      schema_version: LIFECYCLE_CONVERGENCE_SCHEMA_VERSION,
      item_id: lifecycleItemId("entry_lifecycle_proposal", [proposal.proposal_id ?? sourceFingerprint(proposal)]),
      queue_kind: "entry_lifecycle_proposal",
      arrival_at: arrival,
      cohort: cohortFor(arrival),
      current_state: terminal ? `terminal_${proposal.status}` : proposal.status === "deferred_until_new_evidence" ? "deferred_until_new_evidence" : "pending_executor",
      ...(terminal ? { terminal_at: terminalAt, terminal_reason: proposal.terminal_reason ?? proposal.status } : {
        next_retry_not_before: validIso(proposal.next_retry_not_before),
        deadline: validIso(proposal.deadline),
        new_evidence_trigger: proposal.new_evidence_trigger,
      }),
      attempt: Math.max(0, proposal.attempt ?? 0),
      failure_class: failureClass,
      source_fingerprint: sourceFingerprint(raw),
    });
  }
  return { rows, corrupt, sourceRecords, limitExceeded: sourceRecords > LIFECYCLE_PROPOSAL_MAX_ROWS };
}

function emptyQueueMetrics(): LifecycleQueueMetrics {
  return { arrivals: 0, terminal: 0, pending: 0, oldest_pending_age_days: null, oldest_fresh_pending_age_days: null };
}

function computeMetrics(
  rows: LifecycleConvergenceRow[],
  now: Date,
  corrupt: number,
  duplicates: number,
  proposalRows: number,
  previousRows?: LifecycleConvergenceRow[],
): LifecycleConvergenceMetrics {
  const queues: Record<LifecycleQueueKind, LifecycleQueueMetrics> = {
    provisional_correction: emptyQueueMetrics(),
    multiview_pending: emptyQueueMetrics(),
    entry_lifecycle_proposal: emptyQueueMetrics(),
  };
  const failureClasses: Record<LifecycleFailureClass, number> = { none: 0, provider: 0, transient: 0, parse: 0, conflict: 0, writer: 0, semantic_defer: 0 };
  const cohorts: Record<LifecycleCohort, { arrivals: number; terminal: number; pending: number; conservation_holds: boolean }> = {
    legacy: { arrivals: 0, terminal: 0, pending: 0, conservation_holds: true },
    fresh: { arrivals: 0, terminal: 0, pending: 0, conservation_holds: true },
  };
  let terminal = 0;
  let pending = 0;
  let unbounded = 0;
  let retryCount = 0;
  let oldest = 0;
  let oldestFresh = 0;
  for (const row of rows) {
    const isTerminal = !!row.terminal_at;
    const age = Math.max(0, (now.getTime() - Date.parse(row.arrival_at)) / DAY_MS);
    const q = queues[row.queue_kind];
    q.arrivals++;
    retryCount += row.attempt;
    cohorts[row.cohort].arrivals++;
    failureClasses[row.failure_class]++;
    if (isTerminal) {
      terminal++;
      q.terminal++;
      cohorts[row.cohort].terminal++;
    } else {
      pending++;
      q.pending++;
      cohorts[row.cohort].pending++;
      oldest = Math.max(oldest, age);
      q.oldest_pending_age_days = Math.max(q.oldest_pending_age_days ?? 0, age);
      if (row.cohort === "fresh") {
        oldestFresh = Math.max(oldestFresh, age);
        q.oldest_fresh_pending_age_days = Math.max(q.oldest_fresh_pending_age_days ?? 0, age);
      }
      if (!row.next_retry_not_before || !row.deadline || !row.new_evidence_trigger || Date.parse(row.deadline) <= now.getTime()) unbounded++;
    }
  }
  const arrivals = rows.length;
  const currentIds = new Set(rows.map((row) => row.item_id));
  const missingPreviousItemIds = (previousRows ?? [])
    .map((row) => row.item_id)
    .filter((itemId) => !currentIds.has(itemId))
    .sort();
  const missingPreviousSet = new Set(missingPreviousItemIds);
  const missingCohorts = new Set((previousRows ?? []).filter((row) => missingPreviousSet.has(row.item_id)).map((row) => row.cohort));
  const continuityHolds = missingPreviousItemIds.length === 0;
  const classificationDelta = arrivals - terminal - pending;
  cohorts.legacy.conservation_holds = cohorts.legacy.arrivals === cohorts.legacy.terminal + cohorts.legacy.pending && !missingCohorts.has("legacy");
  cohorts.fresh.conservation_holds = cohorts.fresh.arrivals === cohorts.fresh.terminal + cohorts.fresh.pending && !missingCohorts.has("fresh");
  return {
    as_of: now.toISOString(),
    arrivals,
    terminal,
    pending,
    oldest_pending_age_days: pending ? Number(oldest.toFixed(6)) : null,
    oldest_fresh_pending_age_days: cohorts.fresh.pending ? Number(oldestFresh.toFixed(6)) : null,
    unbounded_pending: unbounded,
    retry_count: retryCount,
    failure_classes: failureClasses,
    cohorts,
    queues,
    continuity_holds: continuityHolds,
    continuity_baseline: previousRows ? "persisted_read_model" : "bootstrap_no_previous_model",
    previous_item_count: previousRows?.length ?? 0,
    missing_previous_item_ids: missingPreviousItemIds,
    conservation: {
      holds: classificationDelta === 0 && continuityHolds,
      arrivals,
      terminal_plus_pending: terminal + pending,
      delta: classificationDelta,
      previous_items: previousRows?.length ?? 0,
      missing_previous_items: missingPreviousItemIds.length,
    },
    source: {
      valid_records: arrivals,
      corrupt_records: corrupt,
      duplicate_item_ids: duplicates,
      proposal_rows: proposalRows,
      proposal_row_limit: LIFECYCLE_PROPOSAL_MAX_ROWS,
      proposal_row_limit_reached: proposalRows >= LIFECYCLE_PROPOSAL_MAX_ROWS,
    },
  };
}

function persistedInventoryBaseline(abrainHome: string): { rows?: LifecycleConvergenceRow[]; error?: string } {
  const file = lifecycleConvergencePath(abrainHome);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<LifecycleConvergenceReadModel>;
    if (parsed.schema_version !== LIFECYCLE_CONVERGENCE_SCHEMA_VERSION || !Array.isArray(parsed.rows)) {
      return { error: "invalid_previous_lifecycle_read_model" };
    }
    const ids = new Set<string>();
    for (const row of parsed.rows) {
      if (!row || typeof row.item_id !== "string" || !row.item_id || (row.cohort !== "legacy" && row.cohort !== "fresh") || ids.has(row.item_id)) {
        return { error: "invalid_previous_lifecycle_read_model" };
      }
      ids.add(row.item_id);
    }
    return { rows: parsed.rows };
  } catch {
    return { error: "invalid_previous_lifecycle_read_model" };
  }
}

export function rebuildLifecycleConvergence(options: { abrainHome?: string; now?: Date; persist?: boolean } = {}): RebuildLifecycleConvergenceResult {
  const abrainHome = path.resolve(options.abrainHome ?? resolveUserGlobalAbrainHome());
  const now = options.now ?? new Date();
  try {
    const baseline = persistedInventoryBaseline(abrainHome);
    if (baseline.error) return { ok: false, written: false, error: baseline.error };
    const staging = readStagingRows(abrainHome, now);
    const proposals = readProposalRows(abrainHome);
    const byId = new Map<string, LifecycleConvergenceRow>();
    let duplicateItemIds = 0;
    for (const row of [...staging.rows, ...proposals.rows]) {
      if (byId.has(row.item_id)) duplicateItemIds++;
      byId.set(row.item_id, row);
    }
    const rows = [...byId.values()].sort((a, b) => a.arrival_at.localeCompare(b.arrival_at) || a.item_id.localeCompare(b.item_id));
    const corrupt = staging.corrupt + proposals.corrupt;
    const readModel: LifecycleConvergenceReadModel = {
      schema_version: LIFECYCLE_CONVERGENCE_SCHEMA_VERSION,
      generated_at: now.toISOString(),
      cohort_cutover_at: LIFECYCLE_COHORT_CUTOVER_UTC,
      rows,
      metrics: computeMetrics(rows, now, corrupt, duplicateItemIds, proposals.sourceRecords, baseline.rows),
    };
    if (corrupt > 0 || duplicateItemIds > 0 || proposals.limitExceeded || !readModel.metrics.continuity_holds) {
      const error = corrupt > 0
        ? "corrupt_lifecycle_source"
        : duplicateItemIds > 0
          ? "duplicate_lifecycle_item_id"
          : proposals.limitExceeded
            ? "lifecycle_proposal_row_limit_exceeded"
            : "lifecycle_item_continuity_broken";
      return { ok: false, written: false, read_model: readModel, error };
    }
    if (options.persist === false) return { ok: true, written: false, read_model: readModel };
    const locked = withFileLock(lifecycleConvergenceLockPath(abrainHome), () => {
      const file = lifecycleConvergencePath(abrainHome);
      const content = `${JSON.stringify(readModel)}\n`;
      const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      if (previous === content) return false;
      atomicWriteText(file, content);
      return true;
    });
    if (!locked.ok) return { ok: false, written: false, read_model: readModel, error: "lifecycle_convergence_lock_contention" };
    return { ok: true, written: locked.value, read_model: readModel };
  } catch (error) {
    return { ok: false, written: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readLifecycleConvergence(abrainHome = resolveUserGlobalAbrainHome()): LifecycleConvergenceReadModel | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lifecycleConvergencePath(abrainHome), "utf-8")) as LifecycleConvergenceReadModel;
    return parsed?.schema_version === LIFECYCLE_CONVERGENCE_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort runtime refresh. Source files remain authoritative for rebuild. */
export function refreshLifecycleConvergenceReadModel(now: Date = new Date()): void {
  try { rebuildLifecycleConvergence({ now }); } catch { /* derived observability must not fail agent_end */ }
}
