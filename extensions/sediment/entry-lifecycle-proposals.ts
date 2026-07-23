/**
 * entry-lifecycle-proposals — Outcome/Truth-change -> Entry lifecycle proposal sidecar.
 *
 * Original M3 source is the AFFIRMATIVE LLM channel: `promoted_advisories[]`
 * carrying a `lifecycle_proposal`. D* Phase 1 adds a deterministic bridge from
 * current entry frontmatter: status=superseded + valid non-self superseded_by
 * becomes execution-ready archive proposal with expected_status=superseded; a
 * standing superseded entry without a valid successor autonomously defers until
 * a successor, status change, or independent attributed evidence arrives. D*
 * Phase 2 adds a bounded bridge from
 * decay-shadow's truth-change-gated would_demote=true assessments to ordinary
 * execution-ready archive proposals, leaving all mutation gates in the executor.
 *
 * HARD BOUNDARIES:
 *   - NEVER writes durable entry markdown. NEVER imports / calls the writer,
 *     curator, archive, or multi-view. NO LLM. NO user surface.
 *   - It ONLY writes ~/.abrain/.state/sediment/entry-lifecycle-proposals.jsonl.
 *     The gated executor is the sole consumer.
 *   - Usage-only signals are not accepted by this module.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  abrainProjectDir,
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  resolveActiveProject,
  resolveUserGlobalAbrainHome,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { withFileLock, atomicWriteText } from "../_shared/sync-file-lock";
import type { Jsonish, MemoryEntry, RelationEdge } from "../memory/types";
import type { LifecycleProposal, PromotedAdvisory } from "./aggregator-llm";
import { normalizeAssessment, type EntryDecayAssessment } from "./decay-shadow";
import { readOutcomeEvidenceIndex, resolveIndependentOutcomeEvidenceEventIds } from "./outcome-evidence";
import { ENTRY_KINDS, type EntryKind } from "./validation";

export type LifecycleProposalReason = LifecycleProposal["reason"] | "superseded_no_successor";
export type LifecycleProposalStatus = "pending" | "executed" | "failed" | "deferred_until_new_evidence";
export type LifecycleProposalDisposition = "execution_ready" | "defer_until_new_evidence";
export type LifecycleProposalExpectedStatus = "active" | "superseded";
export type LifecycleProposalEvidenceSource = "aggregator_promoted_advisory" | "frontmatter_superseded" | "decay";
export type DurableKindSource = "canonical_frontmatter" | "project_frontmatter" | "project_root_frontmatter";
export type DurableKindResolutionReason = "missing_durable_entry" | "missing_durable_kind" | "invalid_durable_kind" | "ambiguous_durable_kind";

export interface DurableKindResolution {
  kind?: EntryKind;
  /** Invalid raw frontmatter is diagnostic-only; never accepted by the writer. */
  raw_kind?: string;
  source?: DurableKindSource;
  reason?: DurableKindResolutionReason;
}

/** Persistent audit of the bounded repair for legacy decay rows. */
export interface LifecycleProposalKindResolution {
  schema_version: 1;
  action: "legacy_decay_kind_repaired" | "legacy_decay_kind_retired";
  resolved_at: string;
  source?: DurableKindSource;
  durable_kind?: EntryKind;
  reason?: DurableKindResolutionReason;
}

export interface EntryLifecycleProposalRow {
  schema_version: 1;
  ts: string;
  project_root: string;
  /** Durable entry the proposal concerns. */
  slug?: string;
  kind: string;
  op: LifecycleProposal["op"];
  reason: LifecycleProposalReason;
  independent_evidence: string;
  falsifier: string;
  message?: string;
  /** Executor CAS precondition. Legacy LLM proposals default to active. */
  expected_status?: LifecycleProposalExpectedStatus;
  /** Phase 1 safety gate: only execution_ready rows may be executed. */
  disposition?: LifecycleProposalDisposition;
  /** Stable source/key pair used for idempotent deterministic replays. */
  evidence_source?: LifecycleProposalEvidenceSource;
  evidence_key?: string;
  /** Stable join key derived from the proposal identity. */
  proposal_id?: string;
  /** Stable join key for the proposal this row supersedes, when known. */
  supersedes_proposal_id?: string;
  /** Coarse evidence class for audit/ledger aggregation. */
  evidence_type?: string;
  /** E1 successor target when known. */
  target_slug?: string;
  /** Independent L1 outcome evidence required for aggregator-origin execution. */
  independent_evidence_event_ids?: string[];
  /** Autonomous non-terminal schedule. `deadline` is a re-evaluation SLA,
   *  never an authorization to archive merely because time elapsed. */
  next_retry_not_before?: string;
  deadline?: string;
  new_evidence_trigger?: string;
  attempt?: number;
  failure_class?: "provider" | "transient" | "parse" | "conflict" | "writer" | "semantic_defer";
  /** Explicit terminal evidence for rebuildable convergence. */
  terminal_at?: string;
  terminal_reason?: string;
  /** Structured audit for the bounded legacy decay kind compatibility repair. */
  kind_resolution?: LifecycleProposalKindResolution;
  /** normalizeRow 保留磁盘状态: executor transitions pending -> executed/failed. */
  status: LifecycleProposalStatus;
}

export interface AppendLifecycleProposalsOptions {
  projectRoot: string;
  promoted: PromotedAdvisory[];
  now?: Date;
}

export interface AppendLifecycleProposalsResult {
  ok: boolean;
  written: boolean;
  proposals_appended: number;
  rows_total: number;
  error?: string;
}

export type SupersededFrontmatterEntry = Pick<MemoryEntry, "slug" | "kind" | "status" | "frontmatter" | "relations">;

export interface AppendSupersededFrontmatterProposalsOptions {
  projectRoot: string;
  entries: SupersededFrontmatterEntry[];
  now?: Date;
}

export interface AppendSupersededFrontmatterProposalsResult extends AppendLifecycleProposalsResult {
  e1_count: number;
  e2_count: number;
  e1_slugs: string[];
  e2_slugs: string[];
}

export interface AppendSupersededMarkdownFrontmatterProposalsOptions {
  projectRoot: string;
  abrainHome?: string;
  projectId?: string;
  now?: Date;
}

export interface AppendDecayDemoteProposalsOptions {
  projectRoot: string;
  assessments: unknown[];
  now?: Date;
  maxPerRun?: number;
}

export interface AppendDecayDemoteProposalsResult extends AppendLifecycleProposalsResult {
  source: "decay";
  considered: number;
  eligible: number;
  limited: number;
  skipped_duplicate_slug: number;
  skipped_missing_durable_kind: number;
  skipped_invalid_durable_kind: number;
  max_per_run: number;
  appended_slugs: string[];
  legacy_kind_compatibility: ReconcileLegacyDecayProposalKindsResult;
}

export interface ReconcileLegacyDecayProposalKindsOptions {
  projectRoot: string;
  now?: Date;
}

export interface ReconcileLifecycleProposalDeferralsResult {
  ok: boolean;
  written: boolean;
  rows_total: number;
  migrated_e2: number;
  scheduled_nonterminal: number;
  deadline_expired: number;
  deadline_terminal: number;
  deadline_reopened: number;
  bounded_retry_scheduled: number;
  retry_cap_terminal: number;
  invalid_json_lines: number;
  error?: string;
}

export interface ReconcileLegacyDecayProposalKindsResult {
  ok: boolean;
  written: boolean;
  rows_total: number;
  considered: number;
  repaired: number;
  retired: number;
  deferred: number;
  max_per_run: number;
  repaired_slugs: string[];
  retired_slugs: string[];
  /** Non-empty JSONL lines that prevented a fail-closed full rewrite. */
  invalid_json_lines: number;
  invalid_json_line_numbers: number[];
  error?: string;
}

interface AppendRowsOptions {
  dedupeArchiveBySlug?: boolean;
  maxAppend?: number;
  /** Current durable status observed by the same frontmatter scan. */
  currentStatusBySlug?: Map<string, string>;
  now?: Date;
}

interface AppendRowsResult extends AppendLifecycleProposalsResult {
  limited?: number;
  capacity_rejected?: number;
  skipped_duplicate_slug?: number;
  appended_slugs?: string[];
}

const PROPOSALS_MAX_ROWS = 1000;
const PROPOSALS_TAIL_READ_BYTES = 2 * 1024 * 1024;
const STRING_FIELD_MAX_CHARS = 1_000;
const DECAY_COMPAT_MAX_PER_RUN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const E1_RETRY_CAP = 3;
const E1_RETRY_BASE_MS = 5 * 60 * 1000;
const E1_NEW_EVIDENCE_TRIGGER = "executor_capacity|target_project_session|durable_state_change";
const E2_NEW_EVIDENCE_TRIGGER = "new_valid_successor_edge|status_no_longer_superseded|independent_attributed_evidence";
const ENTRY_KIND_SET: ReadonlySet<string> = new Set(ENTRY_KINDS);

export function entryLifecycleProposalsPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "entry-lifecycle-proposals.jsonl");
}

function clip(s: unknown, max = STRING_FIELD_MAX_CHARS): string {
  const text = typeof s === "string" ? s : String(s ?? "");
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function normalizeProjectRoot(value: unknown): string {
  return typeof value === "string" && value.trim() ? path.resolve(value) : "";
}

function readJsonlTail<T = Record<string, unknown>>(filePath: string, maxBytes = PROPOSALS_TAIL_READ_BYTES): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = maxBytes > 0 && stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    let raw = "";
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const out: T[] = [];
    for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try { out.push(JSON.parse(line) as T); } catch { /* corrupt line ignored */ }
    }
    return out;
  } catch {
    return [];
  }
}

interface FullJsonlRewriteRead<T> {
  rows: T[];
  row_count: number;
  invalid_json_lines: number;
  invalid_json_line_numbers: number[];
  error?: string;
}

/** A rewrite must start from the complete bounded sidecar, never a tail view.
 * Refuse over-limit or malformed files instead of silently dropping any rows. */
function readJsonlForFullRewrite<T = Record<string, unknown>>(filePath: string): FullJsonlRewriteRead<T> {
  try {
    if (!fs.existsSync(filePath)) return { rows: [], row_count: 0, invalid_json_lines: 0, invalid_json_line_numbers: [] };
    const nonEmptyLines = fs.readFileSync(filePath, "utf-8").split("\n")
      .map((line, index) => ({ line: line.trim(), line_number: index + 1 }))
      .filter(({ line }) => Boolean(line));
    if (nonEmptyLines.length > PROPOSALS_MAX_ROWS) {
      return { rows: [], row_count: nonEmptyLines.length, invalid_json_lines: 0, invalid_json_line_numbers: [], error: "proposal_row_limit_exceeded" };
    }
    const rows: T[] = [];
    const invalidJsonLineNumbers: number[] = [];
    for (const { line, line_number } of nonEmptyLines) {
      try { rows.push(JSON.parse(line) as T); } catch { invalidJsonLineNumbers.push(line_number); }
    }
    return {
      rows,
      row_count: nonEmptyLines.length,
      invalid_json_lines: invalidJsonLineNumbers.length,
      invalid_json_line_numbers: invalidJsonLineNumbers,
      ...(invalidJsonLineNumbers.length > 0 ? { error: "proposal_jsonl_parse_failed" } : {}),
    };
  } catch (e) {
    return { rows: [], row_count: 0, invalid_json_lines: 0, invalid_json_line_numbers: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function validReason(value: unknown): LifecycleProposalReason | undefined {
  return value === "affirm_stale" || value === "affirm_superseded" || value === "affirm_echo_chamber" || value === "superseded_no_successor"
    ? value
    : undefined;
}

function validDurableKind(value: unknown): EntryKind | undefined {
  return typeof value === "string" && ENTRY_KIND_SET.has(value) ? value as EntryKind : undefined;
}

function normalizeKindResolution(value: unknown): LifecycleProposalKindResolution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const action = r.action === "legacy_decay_kind_repaired" || r.action === "legacy_decay_kind_retired" ? r.action : undefined;
  const source = r.source === "canonical_frontmatter" || r.source === "project_frontmatter" || r.source === "project_root_frontmatter" ? r.source : undefined;
  const reason = r.reason === "missing_durable_entry" || r.reason === "missing_durable_kind" || r.reason === "invalid_durable_kind" || r.reason === "ambiguous_durable_kind" ? r.reason : undefined;
  const durableKind = validDurableKind(r.durable_kind);
  if (r.schema_version !== 1 || !action || typeof r.resolved_at !== "string") return undefined;
  return {
    schema_version: 1,
    action,
    resolved_at: r.resolved_at,
    ...(source ? { source } : {}),
    ...(durableKind ? { durable_kind: durableKind } : {}),
    ...(reason ? { reason } : {}),
  };
}

function lifecycleEvidenceType(reason: LifecycleProposalReason, source?: LifecycleProposalEvidenceSource, targetSlug?: string): string {
  if (source === "frontmatter_superseded" && reason === "affirm_superseded" && targetSlug) return "superseded_by";
  if (reason === "superseded_no_successor") return "superseded_no_successor";
  if (reason === "affirm_superseded") return "superseded_by";
  if (reason === "affirm_stale") return "stale";
  if (reason === "affirm_echo_chamber") return "echo_chamber";
  return reason;
}

function stableProposalId(row: EntryLifecycleProposalRow): string {
  return `elp-${createHash("sha256").update(proposalIdentity(row)).digest("hex").slice(0, 16)}`;
}

export function normalizeLifecycleProposalRow(row: unknown): EntryLifecycleProposalRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const projectRoot = normalizeProjectRoot(r.project_root);
  const op = r.op === "contest" || r.op === "archive" || r.op === "supersede" ? r.op : undefined;
  const reason = validReason(r.reason);
  if (!projectRoot || !op || !reason) return null;
  const expected = r.expected_status === "superseded" ? "superseded" : r.expected_status === "active" ? "active" : undefined;
  const requestedDisposition = r.disposition === "execution_ready"
    ? "execution_ready"
    : r.disposition === "defer_until_new_evidence" || r.disposition === "review_required"
      ? "defer_until_new_evidence"
      : undefined;
  const source = r.evidence_source === "frontmatter_superseded"
    ? "frontmatter_superseded"
    : r.evidence_source === "aggregator_promoted_advisory"
      ? "aggregator_promoted_advisory"
      : r.evidence_source === "decay"
        ? "decay"
        : undefined;
  const kindResolution = normalizeKindResolution(r.kind_resolution);
  const slug = typeof r.slug === "string" && r.slug ? r.slug : undefined;
  // LLM/aggregator-derived sources (including legacy undefined + decay) require
  // independently verified attributed L1 outcome evidence. Durable frontmatter
  // E1 keeps its deterministic execution_ready semantics.
  const requiresIndependentEvidence = reason === "superseded_no_successor"
    || source === "aggregator_promoted_advisory"
    || source === "decay"
    || source === undefined;
  const verifiedEvidenceIds = requiresIndependentEvidence
    ? resolveIndependentOutcomeEvidenceEventIds(r.independent_evidence_event_ids, projectRoot, { targetSlug: slug, requireReliableAttribution: true })
    : Array.isArray(r.independent_evidence_event_ids)
      ? [...new Set(r.independent_evidence_event_ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/.test(id)))].sort()
      : [];
  const executionReady = requiresIndependentEvidence
    ? op === "archive" && !!slug && verifiedEvidenceIds.length > 0
    : requestedDisposition === "execution_ready";
  const disposition: LifecycleProposalDisposition = executionReady ? "execution_ready" : "defer_until_new_evidence";
  const terminalStatus = r.status === "executed" || r.status === "failed" ? r.status : undefined;
  const normalized: EntryLifecycleProposalRow = {
    schema_version: 1,
    ts: typeof r.ts === "string" ? r.ts : formatLocalIsoTimestamp(),
    project_root: projectRoot,
    ...(slug ? { slug } : {}),
    kind: typeof r.kind === "string" ? r.kind : "unknown",
    op,
    reason,
    independent_evidence: typeof r.independent_evidence === "string" ? r.independent_evidence : "",
    falsifier: typeof r.falsifier === "string" ? r.falsifier : "",
    ...(typeof r.message === "string" ? { message: r.message } : {}),
    ...(expected ? { expected_status: expected } : {}),
    ...(disposition ? { disposition } : {}),
    ...(source ? { evidence_source: source } : {}),
    ...(typeof r.evidence_key === "string" && r.evidence_key ? { evidence_key: r.evidence_key } : {}),
    ...(typeof r.target_slug === "string" && r.target_slug ? { target_slug: r.target_slug } : {}),
    ...(typeof r.supersedes_proposal_id === "string" && r.supersedes_proposal_id ? { supersedes_proposal_id: r.supersedes_proposal_id } : {}),
    ...(verifiedEvidenceIds.length ? { independent_evidence_event_ids: verifiedEvidenceIds } : {}),
    ...(typeof r.next_retry_not_before === "string" && Number.isFinite(Date.parse(r.next_retry_not_before)) ? { next_retry_not_before: new Date(Date.parse(r.next_retry_not_before)).toISOString() } : {}),
    ...(typeof r.deadline === "string" && Number.isFinite(Date.parse(r.deadline)) ? { deadline: new Date(Date.parse(r.deadline)).toISOString() } : {}),
    ...(typeof r.new_evidence_trigger === "string" && r.new_evidence_trigger ? { new_evidence_trigger: r.new_evidence_trigger } : {}),
    ...(typeof r.attempt === "number" && Number.isSafeInteger(r.attempt) && r.attempt >= 0 ? { attempt: r.attempt } : {}),
    ...(r.failure_class === "provider" || r.failure_class === "transient" || r.failure_class === "parse" || r.failure_class === "conflict" || r.failure_class === "writer" || r.failure_class === "semantic_defer" ? { failure_class: r.failure_class } : {}),
    ...(typeof r.terminal_at === "string" && Number.isFinite(Date.parse(r.terminal_at)) ? { terminal_at: new Date(Date.parse(r.terminal_at)).toISOString() } : {}),
    ...(typeof r.terminal_reason === "string" && r.terminal_reason ? { terminal_reason: r.terminal_reason } : {}),
    ...(kindResolution ? { kind_resolution: kindResolution } : {}),
    status: terminalStatus
      ?? (requiresIndependentEvidence && op !== "archive" && verifiedEvidenceIds.length > 0
        ? "failed"
        : executionReady
          ? "pending"
          : "deferred_until_new_evidence"),
  };
  normalized.evidence_type = typeof r.evidence_type === "string" && r.evidence_type ? r.evidence_type : lifecycleEvidenceType(normalized.reason, normalized.evidence_source, normalized.target_slug);
  normalized.proposal_id = typeof r.proposal_id === "string" && r.proposal_id ? r.proposal_id : stableProposalId(normalized);
  return normalized;
}

const normalizeRow = normalizeLifecycleProposalRow;

function proposalIdentity(row: EntryLifecycleProposalRow): string {
  // Rows written before evidence_source/evidence_key existed came only from the
  // promoted-advisory path, so normalize them to the modern identity to avoid a
  // one-time duplicate after upgrade.
  const source = row.evidence_source ?? "aggregator_promoted_advisory";
  const key = row.evidence_key ?? (source === "aggregator_promoted_advisory"
    ? `${row.slug ?? ""}:${row.kind}:${row.op}:${row.reason}:${row.independent_evidence}`
    : `${row.kind}:${row.op}:${row.reason}:${row.independent_evidence}`);
  return [row.project_root, row.slug ?? "", row.op, source, key].join("\0");
}

function e2Schedule(now: Date, attempt: number): { next_retry_not_before: string; deadline: string } {
  const delayDays = Math.min(14, 2 ** Math.max(0, Math.min(4, attempt)));
  const nextMs = now.getTime() + delayDays * DAY_MS;
  return {
    next_retry_not_before: new Date(nextMs).toISOString(),
    deadline: new Date(nextMs + 14 * DAY_MS).toISOString(),
  };
}

function executableSchedule(now: Date, attempt = 0): { next_retry_not_before: string; deadline: string } {
  const delayMs = Math.min(DAY_MS, E1_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(E1_RETRY_CAP, attempt)));
  return {
    next_retry_not_before: new Date(now.getTime() + delayMs).toISOString(),
    deadline: new Date(now.getTime() + DAY_MS).toISOString(),
  };
}

function isDurableE1(row: EntryLifecycleProposalRow): boolean {
  return row.evidence_source === "frontmatter_superseded"
    && row.reason === "affirm_superseded"
    && row.op === "archive"
    && row.expected_status === "superseded"
    && row.disposition === "execution_ready"
    && !!row.slug
    && !!row.target_slug;
}

function isReopenableE1Terminal(row: EntryLifecycleProposalRow): boolean {
  return isDurableE1(row)
    && row.status === "failed"
    && (row.terminal_reason === "lifecycle_deadline_expired" || row.terminal_reason === "lifecycle_retry_cap_reached");
}

function hasValidLifecycleSchedule(row: EntryLifecycleProposalRow): boolean {
  const next = typeof row.next_retry_not_before === "string" ? Date.parse(row.next_retry_not_before) : NaN;
  const deadline = typeof row.deadline === "string" ? Date.parse(row.deadline) : NaN;
  return Number.isFinite(next) && Number.isFinite(deadline) && deadline >= next;
}

function attributedIndependentEvidenceFor(row: EntryLifecycleProposalRow): string[] {
  if (!row.slug) return [];
  const projectHash = createHash("sha256").update(path.resolve(row.project_root)).digest("hex");
  const since = Date.parse(row.ts);
  return readOutcomeEvidenceIndex()
    .filter((item) => item.project_root_hash === projectHash)
    .filter((item) => item.attribution_status === "attributed")
    .filter((item) => item.evidence_independence === "independent_execution" || item.evidence_independence === "user_authored")
    .filter((item) => item.event_type === "action_outcome_observed" || item.event_type === "natural_correction_observed")
    .filter((item) => item.memory_entry_slugs.includes(row.slug as string))
    .filter((item) => !Number.isFinite(since) || Date.parse(item.created_at_utc) > since)
    .map((item) => item.event_id)
    .sort();
}

function lifecycleAppendResult(r: AppendRowsResult): AppendLifecycleProposalsResult {
  return {
    ok: r.ok,
    written: r.written,
    proposals_appended: r.proposals_appended,
    rows_total: r.rows_total,
    ...(r.error ? { error: r.error } : {}),
  };
}

function appendRows(projectRoot: string, rows: EntryLifecycleProposalRow[], options: AppendRowsOptions = {}): AppendRowsResult {
  const pr = normalizeProjectRoot(projectRoot);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    if (!pr || (rows.length === 0 && !options.currentStatusBySlug)) {
      const existing = readJsonlTail<unknown>(entryLifecycleProposalsPath())
        .map(normalizeRow)
        .filter((r): r is EntryLifecycleProposalRow => r !== null);
      return { ok: true, written: false, proposals_appended: 0, rows_total: existing.length, limited: 0, skipped_duplicate_slug: 0, appended_slugs: [] };
    }
    const maxAppend = typeof options.maxAppend === "number" ? Math.max(0, Math.floor(options.maxAppend)) : Number.POSITIVE_INFINITY;
    const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
      const loaded = readJsonlForFullRewrite<unknown>(entryLifecycleProposalsPath());
      if (loaded.error) {
        return {
          error: loaded.error,
          proposals_appended: 0,
          rows_total: loaded.row_count,
          limited: 0,
          skipped_duplicate_slug: 0,
          appended_slugs: [] as string[],
        };
      }
      const normalizedExisting = loaded.rows.map(normalizeRow);
      if (normalizedExisting.some((row) => row === null)) {
        return {
          error: "proposal_row_normalization_failed",
          proposals_appended: 0,
          rows_total: loaded.row_count,
          limited: 0,
          skipped_duplicate_slug: 0,
          appended_slugs: [] as string[],
        };
      }
      const existing = normalizedExisting as EntryLifecycleProposalRow[];
      const e1Slugs = new Set(rows
        .map((row) => normalizeRow({ ...row, project_root: pr }))
        .filter((row): row is EntryLifecycleProposalRow => !!row && row.evidence_source === "frontmatter_superseded" && row.disposition === "execution_ready" && row.expected_status === "superseded" && !!row.slug)
        .map((row) => row.slug as string));
      const supersededBySlug = new Map(existing
        .filter((row) => row.project_root === pr && row.reason === "superseded_no_successor" && row.evidence_source === "frontmatter_superseded" && !!row.slug)
        .map((row) => [row.slug as string, row.proposal_id as string]));
      let reconciledExisting = existing.map((row) => {
        if (row.project_root !== pr) return row;
        if (row.reason === "superseded_no_successor" && row.status !== "executed" && row.status !== "failed" && row.evidence_source === "frontmatter_superseded" && row.slug && e1Slugs.has(row.slug)) {
          return {
            ...row,
            status: "failed" as const,
            terminal_at: nowIso,
            terminal_reason: "successor_edge_observed",
            message: `${row.message ?? ""} superseded_by_edge_observed; replaced_by_E1`,
          };
        }
        if (row.reason !== "superseded_no_successor" || !row.slug) return row;
        const evidenceIds = attributedIndependentEvidenceFor(row);
        if (row.status === "executed" || row.status === "failed") {
          if (row.status === "failed" && row.terminal_reason === "lifecycle_deadline_expired" && evidenceIds.length > 0) {
            const attempt = Math.max(0, row.attempt ?? 0) + 1;
            return {
              ...row,
              ...executableSchedule(now),
              status: "pending" as const,
              disposition: "execution_ready" as const,
              attempt,
              failure_class: "transient" as const,
              new_evidence_trigger: "executor_capacity|durable_state_change|independent_attributed_evidence",
              independent_evidence_event_ids: [...new Set([...(row.independent_evidence_event_ids ?? []), ...evidenceIds])].sort(),
              message: `${row.message ?? ""} reopened_after_deadline_by_independent_attributed_evidence`.trim(),
              terminal_at: undefined,
              terminal_reason: undefined,
            };
          }
          return row;
        }
        const observedStatus = options.currentStatusBySlug?.get(row.slug);
        if (observedStatus && observedStatus !== "superseded") {
          return {
            ...row,
            status: "failed" as const,
            terminal_at: nowIso,
            terminal_reason: "status_no_longer_superseded",
            message: `${row.message ?? ""} status_restored=${observedStatus}`.trim(),
          };
        }
        if (row.status === "pending" && row.disposition === "execution_ready" && (row.independent_evidence_event_ids?.length ?? 0) > 0) return row;
        const due = !row.next_retry_not_before || Date.parse(row.next_retry_not_before) <= now.getTime();
        const deadlineMs = row.deadline ? Date.parse(row.deadline) : NaN;
        const deadlineExpired = Number.isFinite(deadlineMs) && deadlineMs <= now.getTime();
        if (!due && !deadlineExpired && evidenceIds.length === 0 && row.new_evidence_trigger === E2_NEW_EVIDENCE_TRIGGER && row.failure_class === "semantic_defer") return row;
        const attempt = Math.max(0, row.attempt ?? 0) + 1;
        if (evidenceIds.length > 0) {
          return {
            ...row,
            ...executableSchedule(now),
            status: "pending" as const,
            disposition: "execution_ready" as const,
            attempt,
            failure_class: "transient" as const,
            new_evidence_trigger: "executor_capacity|durable_state_change|independent_attributed_evidence",
            independent_evidence_event_ids: [...new Set([...(row.independent_evidence_event_ids ?? []), ...evidenceIds])].sort(),
            message: `${row.message ?? ""} reopened_by_independent_attributed_evidence`.trim(),
          };
        }
        if (deadlineExpired) {
          return {
            ...row,
            status: "failed" as const,
            terminal_at: nowIso,
            terminal_reason: "lifecycle_deadline_expired",
            message: `${row.message ?? ""} terminal_after_deadline_without_new_evidence`.trim(),
          };
        }
        return {
          ...row,
          ...e2Schedule(now, attempt),
          attempt,
          failure_class: "semantic_defer" as const,
          new_evidence_trigger: E2_NEW_EVIDENCE_TRIGGER,
        };
      });
      // Deferred rows are intentionally excluded so a later pass with verified
      // independent evidence can reopen the same identity instead of being
      // swallowed by slug de-duplication.
      const archiveSlugs = options.dedupeArchiveBySlug
        ? new Set(reconciledExisting.filter((row) => row.project_root === pr && row.op === "archive" && row.status !== "failed" && row.status !== "deferred_until_new_evidence" && !!row.slug).map((row) => row.slug as string))
        : undefined;
      // A terminal legacy decay row must not suppress a later assessment after
      // the entry finally gains a verifiable durable kind.
      const seen = new Set(reconciledExisting
        .filter((row) => !(options.dedupeArchiveBySlug && row.evidence_source === "decay" && row.status === "failed"))
        .map(proposalIdentity));
      const existingByIdentity = new Map(reconciledExisting.map((row, index) => [proposalIdentity(row), index]));
      const newRows: EntryLifecycleProposalRow[] = [];
      const reopenedSlugs: string[] = [];
      let reopened = 0;
      let limited = 0;
      let capacityRejected = 0;
      let skippedDuplicateSlug = 0;
      for (const row of rows) {
        const normalized = normalizeRow({ ...row, project_root: pr });
        if (!normalized) continue;
        if (normalized.status === "pending" && !normalized.next_retry_not_before) {
          Object.assign(normalized, executableSchedule(now), {
            attempt: normalized.attempt ?? 0,
            failure_class: normalized.failure_class ?? "transient",
            new_evidence_trigger: normalized.new_evidence_trigger ?? "executor_capacity|durable_state_change|independent_attributed_evidence",
          });
        } else if (normalized.status === "deferred_until_new_evidence" && !normalized.next_retry_not_before) {
          Object.assign(normalized, e2Schedule(now, normalized.attempt ?? 0), {
            attempt: normalized.attempt ?? 0,
            failure_class: "semantic_defer",
            new_evidence_trigger: normalized.reason === "superseded_no_successor"
              ? E2_NEW_EVIDENCE_TRIGGER
              : normalized.new_evidence_trigger ?? "independent_attributed_evidence|durable_state_change",
          });
        }
        if (archiveSlugs && normalized.op === "archive" && normalized.slug) {
          if (archiveSlugs.has(normalized.slug)) {
            skippedDuplicateSlug++;
            continue;
          }
        }
        const id = proposalIdentity(normalized);
        if (seen.has(id)) {
          const existingIndex = existingByIdentity.get(id);
          const previous = existingIndex === undefined ? undefined : reconciledExisting[existingIndex];
          if (previous?.status === "failed" && previous.reason === "superseded_no_successor" && previous.terminal_reason === "status_no_longer_superseded" && normalized.status === "deferred_until_new_evidence") {
            const attempt = Math.max(0, previous.attempt ?? 0) + 1;
            reconciledExisting = reconciledExisting.map((item, index) => index === existingIndex
              ? {
                  ...normalized,
                  ...e2Schedule(now, attempt),
                  proposal_id: previous.proposal_id,
                  attempt,
                  failure_class: "semantic_defer" as const,
                  new_evidence_trigger: E2_NEW_EVIDENCE_TRIGGER,
                  message: `${normalized.message ?? ""} reopened_after_status_returned_to_superseded`.trim(),
                }
              : item);
            reopened++;
            if (normalized.slug) reopenedSlugs.push(normalized.slug);
          } else if (previous?.status === "deferred_until_new_evidence" && normalized.status === "pending" && normalized.disposition === "execution_ready") {
            reconciledExisting = reconciledExisting.map((item, index) => index === existingIndex
              ? {
                  ...normalized,
                  proposal_id: previous.proposal_id,
                  independent_evidence_event_ids: [...new Set([...(previous.independent_evidence_event_ids ?? []), ...(normalized.independent_evidence_event_ids ?? [])])].sort(),
                  message: `${normalized.message ?? previous.message ?? ""} reopened_by_new_independent_outcome_evidence`.trim(),
                }
              : item);
            reopened++;
            if (normalized.slug) reopenedSlugs.push(normalized.slug);
          } else if (previous && isReopenableE1Terminal(previous) && isDurableE1(normalized) && normalized.status === "pending") {
            reconciledExisting = reconciledExisting.map((item, index) => index === existingIndex
              ? {
                  ...previous,
                  ...executableSchedule(now, 0),
                  kind: normalized.kind,
                  independent_evidence: normalized.independent_evidence,
                  falsifier: normalized.falsifier,
                  status: "pending" as const,
                  attempt: 0,
                  failure_class: "transient" as const,
                  new_evidence_trigger: E1_NEW_EVIDENCE_TRIGGER,
                  message: `${previous.message ?? normalized.message ?? ""} reopened_by_target_project_frontmatter_scan_after=${previous.terminal_reason}; prior_attempt=${previous.attempt ?? 0}`.trim(),
                  terminal_at: undefined,
                  terminal_reason: undefined,
                }
              : item);
            reopened++;
            if (normalized.slug) reopenedSlugs.push(normalized.slug);
          }
          continue;
        }
        if (newRows.length >= maxAppend) {
          limited++;
          continue;
        }
        if (reconciledExisting.length + newRows.length >= PROPOSALS_MAX_ROWS) {
          capacityRejected++;
          continue;
        }
        if (normalized.evidence_source === "frontmatter_superseded" && normalized.disposition === "execution_ready" && normalized.slug) {
          const supersededId = supersededBySlug.get(normalized.slug);
          if (supersededId) normalized.supersedes_proposal_id = supersededId;
        }
        seen.add(id);
        if (archiveSlugs && normalized.op === "archive" && normalized.slug) archiveSlugs.add(normalized.slug);
        newRows.push(normalized);
      }
      const changedExisting = reconciledExisting.some((row, idx) => row !== existing[idx]);
      const appendedSlugs = [...reopenedSlugs, ...newRows.map((row) => row.slug).filter((slug): slug is string => typeof slug === "string" && slug.length > 0)];
      if (capacityRejected > 0) {
        return {
          error: "proposal_row_limit_reached",
          proposals_appended: 0,
          rows_total: existing.length,
          limited,
          capacity_rejected: capacityRejected,
          skipped_duplicate_slug: skippedDuplicateSlug,
          appended_slugs: [] as string[],
        };
      }
      if (newRows.length === 0 && !changedExisting) {
        return { proposals_appended: 0, rows_total: existing.length, limited, capacity_rejected: 0, skipped_duplicate_slug: skippedDuplicateSlug, appended_slugs: appendedSlugs };
      }
      const allRows = [...reconciledExisting, ...newRows];
      const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return { proposals_appended: newRows.length + reopened, rows_total: allRows.length, written: true, limited, capacity_rejected: 0, skipped_duplicate_slug: skippedDuplicateSlug, appended_slugs: appendedSlugs };
    });
    if (!locked.ok) return { ok: false, written: false, proposals_appended: 0, rows_total: 0, error: "proposal_lock_contention", limited: 0, skipped_duplicate_slug: 0, appended_slugs: [] };
    if ("error" in locked.value) {
      return {
        ok: false,
        written: false,
        proposals_appended: 0,
        rows_total: locked.value.rows_total,
        error: locked.value.error,
        limited: locked.value.limited ?? 0,
        capacity_rejected: locked.value.capacity_rejected ?? 0,
        skipped_duplicate_slug: locked.value.skipped_duplicate_slug ?? 0,
        appended_slugs: [],
      };
    }
    return {
      ok: true,
      written: locked.value.written === true,
      proposals_appended: locked.value.proposals_appended,
      rows_total: locked.value.rows_total,
      limited: locked.value.limited ?? 0,
      capacity_rejected: locked.value.capacity_rejected ?? 0,
      skipped_duplicate_slug: locked.value.skipped_duplicate_slug ?? 0,
      appended_slugs: locked.value.appended_slugs ?? [],
    };
  } catch (e) {
    return {
      ok: false,
      written: false,
      proposals_appended: 0,
      rows_total: 0,
      error: e instanceof Error ? e.message : String(e),
      limited: 0,
      skipped_duplicate_slug: 0,
      appended_slugs: [],
    };
  }
}

/** One-time plus replay-safe migration of historical E2 `review_required`
 * rows into autonomous evidence deferral. It also schedules every other live
 * proposal so the sidecar cannot contain an unbounded non-terminal row. */
export function reconcileLifecycleProposalDeferrals(options: { now?: Date } = {}): ReconcileLifecycleProposalDeferralsResult {
  const now = options.now ?? new Date();
  try {
    const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
      const loaded = readJsonlForFullRewrite<unknown>(entryLifecycleProposalsPath());
      if (loaded.error) {
        return {
          error: loaded.error,
          rows_total: loaded.row_count,
          migrated_e2: 0,
          scheduled_nonterminal: 0,
          deadline_expired: 0,
          deadline_terminal: 0,
          deadline_reopened: 0,
          bounded_retry_scheduled: 0,
          retry_cap_terminal: 0,
          invalid_json_lines: loaded.invalid_json_lines,
        };
      }
      const normalizedRows = loaded.rows.map(normalizeRow);
      if (normalizedRows.some((row) => row === null)) {
        return {
          error: "proposal_row_normalization_failed",
          rows_total: loaded.row_count,
          migrated_e2: 0,
          scheduled_nonterminal: 0,
          deadline_expired: 0,
          deadline_terminal: 0,
          deadline_reopened: 0,
          bounded_retry_scheduled: 0,
          retry_cap_terminal: 0,
          invalid_json_lines: 0,
        };
      }
      let migratedE2 = 0;
      let scheduled = 0;
      let deadlineExpired = 0;
      let deadlineTerminal = 0;
      let deadlineReopened = 0;
      let boundedRetryScheduled = 0;
      let retryCapTerminal = 0;
      const rows = normalizedRows.map((normalized, index) => {
        const raw = loaded.rows[index];
        const row = normalized as EntryLifecycleProposalRow;
        const discoveredEvidenceIds = row.reason === "superseded_no_successor" ? attributedIndependentEvidenceFor(row) : [];
        const joinedEvidenceIds = [...new Set([...(row.independent_evidence_event_ids ?? []), ...discoveredEvidenceIds])].sort();
        if (row.status === "executed" || row.status === "failed") {
          if (row.status === "failed" && row.reason === "superseded_no_successor" && row.terminal_reason === "lifecycle_deadline_expired" && joinedEvidenceIds.length > 0) {
            deadlineReopened++;
            return {
              ...row,
              ...executableSchedule(now),
              status: "pending" as const,
              disposition: "execution_ready" as const,
              attempt: Math.max(0, row.attempt ?? 0) + 1,
              failure_class: "transient" as const,
              new_evidence_trigger: "executor_capacity|durable_state_change|independent_attributed_evidence",
              independent_evidence_event_ids: joinedEvidenceIds,
              terminal_at: undefined,
              terminal_reason: undefined,
              message: `${row.message ?? ""} reopened_after_deadline_by_independent_attributed_evidence`.trim(),
            };
          }
          return {
            ...row,
            terminal_at: row.terminal_at ?? row.ts,
            terminal_reason: row.terminal_reason ?? `legacy_${row.status}_migration`,
          };
        }
        const hasSchedule = hasValidLifecycleSchedule(row);
        const deadlineMs = row.deadline ? Date.parse(row.deadline) : NaN;
        const isDeadlineExpired = Number.isFinite(deadlineMs) && deadlineMs <= now.getTime();
        if (row.reason === "superseded_no_successor") {
          const attempt = Math.max(0, row.attempt ?? 0);
          const independentEvidenceReady = (row.status === "pending"
            && row.disposition === "execution_ready"
            && (row.independent_evidence_event_ids?.length ?? 0) > 0)
            || joinedEvidenceIds.length > 0;
          if (independentEvidenceReady) {
            if (!hasSchedule || isDeadlineExpired) scheduled++;
            if (isDeadlineExpired) deadlineReopened++;
            return {
              ...row,
              ...(!hasSchedule || isDeadlineExpired ? executableSchedule(now) : {}),
              status: "pending" as const,
              disposition: "execution_ready" as const,
              attempt,
              failure_class: row.failure_class === "semantic_defer" ? "transient" as const : row.failure_class ?? "transient" as const,
              new_evidence_trigger: "executor_capacity|durable_state_change|independent_attributed_evidence",
              ...(joinedEvidenceIds.length ? { independent_evidence_event_ids: joinedEvidenceIds } : {}),
            };
          }
          if (isDeadlineExpired) {
            deadlineExpired++;
            deadlineTerminal++;
            return {
              ...row,
              status: "failed" as const,
              terminal_at: now.toISOString(),
              terminal_reason: "lifecycle_deadline_expired",
              message: `${row.message ?? ""} terminal_after_deadline_without_new_evidence`.trim(),
            };
          }
          const rawRecord = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const needsMigration = rawRecord.review_required === true
            || row.status !== "deferred_until_new_evidence"
            || row.disposition !== "defer_until_new_evidence"
            || row.failure_class !== "semantic_defer"
            || row.new_evidence_trigger !== E2_NEW_EVIDENCE_TRIGGER
            || !hasSchedule;
          if (needsMigration) migratedE2++;
          if (!hasSchedule) scheduled++;
          return {
            ...row,
            ...(!hasSchedule ? e2Schedule(now, attempt) : {}),
            status: "deferred_until_new_evidence" as const,
            disposition: "defer_until_new_evidence" as const,
            attempt,
            failure_class: "semantic_defer" as const,
            new_evidence_trigger: E2_NEW_EVIDENCE_TRIGGER,
          };
        }
        if (isDeadlineExpired && isDurableE1(row)) {
          deadlineExpired++;
          const attempt = Math.max(0, row.attempt ?? 0);
          if (attempt < E1_RETRY_CAP) {
            const nextAttempt = attempt + 1;
            scheduled++;
            boundedRetryScheduled++;
            return {
              ...row,
              ...executableSchedule(now, nextAttempt),
              status: "pending" as const,
              attempt: nextAttempt,
              failure_class: "transient" as const,
              new_evidence_trigger: E1_NEW_EVIDENCE_TRIGGER,
              message: `${row.message ?? ""} bounded_retry_after_deadline; attempt=${nextAttempt}/${E1_RETRY_CAP}`.trim(),
              terminal_at: undefined,
              terminal_reason: undefined,
            };
          }
          deadlineTerminal++;
          retryCapTerminal++;
          return {
            ...row,
            status: "failed" as const,
            terminal_at: now.toISOString(),
            terminal_reason: "lifecycle_retry_cap_reached",
            message: `${row.message ?? ""} terminal_after_bounded_retry_cap; attempt=${attempt}/${E1_RETRY_CAP}`.trim(),
          };
        }
        if (isDeadlineExpired) {
          deadlineExpired++;
          deadlineTerminal++;
          return {
            ...row,
            status: "failed" as const,
            terminal_at: now.toISOString(),
            terminal_reason: "lifecycle_deadline_expired",
            message: `${row.message ?? ""} terminal_after_lifecycle_deadline`.trim(),
          };
        }
        if (!hasSchedule) scheduled++;
        if (row.status === "pending") {
          const attempt = Math.max(0, row.attempt ?? 0);
          return {
            ...row,
            ...(!hasSchedule ? executableSchedule(now, attempt) : {}),
            attempt,
            failure_class: row.failure_class ?? "transient" as const,
            new_evidence_trigger: isDurableE1(row)
              ? row.new_evidence_trigger ?? E1_NEW_EVIDENCE_TRIGGER
              : row.new_evidence_trigger ?? "executor_capacity|durable_state_change|independent_attributed_evidence",
          };
        }
        return {
          ...row,
          ...(!hasSchedule ? e2Schedule(now, Math.max(0, row.attempt ?? 0)) : {}),
          attempt: Math.max(0, row.attempt ?? 0),
          failure_class: "semantic_defer" as const,
          new_evidence_trigger: row.new_evidence_trigger ?? "independent_attributed_evidence|durable_state_change",
        };
      });
      const enriched = rows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      const content = enriched.map((row) => JSON.stringify(row)).join("\n") + (enriched.length ? "\n" : "");
      const previous = fs.existsSync(entryLifecycleProposalsPath()) ? fs.readFileSync(entryLifecycleProposalsPath(), "utf-8") : "";
      const written = content !== previous;
      if (written) atomicWriteText(entryLifecycleProposalsPath(), content);
      return {
        written,
        rows_total: rows.length,
        migrated_e2: migratedE2,
        scheduled_nonterminal: scheduled,
        deadline_expired: deadlineExpired,
        deadline_terminal: deadlineTerminal,
        deadline_reopened: deadlineReopened,
        bounded_retry_scheduled: boundedRetryScheduled,
        retry_cap_terminal: retryCapTerminal,
        invalid_json_lines: 0,
      };
    });
    if (!locked.ok) return { ok: false, written: false, rows_total: 0, migrated_e2: 0, scheduled_nonterminal: 0, deadline_expired: 0, deadline_terminal: 0, deadline_reopened: 0, bounded_retry_scheduled: 0, retry_cap_terminal: 0, invalid_json_lines: 0, error: "proposal_lock_contention" };
    if ("error" in locked.value) return { ok: false, written: false, ...locked.value };
    return { ok: true, ...locked.value };
  } catch (error) {
    return { ok: false, written: false, rows_total: 0, migrated_e2: 0, scheduled_nonterminal: 0, deadline_expired: 0, deadline_terminal: 0, deadline_reopened: 0, bounded_retry_scheduled: 0, retry_cap_terminal: 0, invalid_json_lines: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Repair the historical `decay + pending + outcome_entry` schema defect in a
 * bounded, idempotent pass. Rewrites read the complete sidecar only when its
 * non-empty JSONL line count is within PROPOSALS_MAX_ROWS; an over-limit file
 * is left untouched. A durable kind is required; unresolved rows become
 * terminal so the executor never audits the same impossible mismatch forever. */
export function reconcileLegacyDecayProposalKinds(options: ReconcileLegacyDecayProposalKindsOptions): ReconcileLegacyDecayProposalKindsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? new Date();
  const resolvedAt = formatLocalIsoTimestamp(now);
  const empty = (error?: string, invalidJsonLines = 0, invalidJsonLineNumbers: number[] = []): ReconcileLegacyDecayProposalKindsResult => ({
    ok: !error,
    written: false,
    rows_total: 0,
    considered: 0,
    repaired: 0,
    retired: 0,
    deferred: 0,
    max_per_run: DECAY_COMPAT_MAX_PER_RUN,
    repaired_slugs: [],
    retired_slugs: [],
    invalid_json_lines: invalidJsonLines,
    invalid_json_line_numbers: invalidJsonLineNumbers,
    ...(error ? { error } : {}),
  });
  if (!projectRoot) return empty();

  try {
    const durableKinds = durableKindResolutions(projectRoot);
    const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
      const loaded = readJsonlForFullRewrite<unknown>(entryLifecycleProposalsPath());
      if (loaded.error) {
        return {
          error: loaded.error,
          rows_total: loaded.row_count,
          invalid_json_lines: loaded.invalid_json_lines,
          invalid_json_line_numbers: loaded.invalid_json_line_numbers,
        };
      }
      const normalizedExisting = loaded.rows.map(normalizeRow);
      if (normalizedExisting.some((row) => row === null)) {
        return {
          error: "proposal_row_normalization_failed",
          rows_total: loaded.row_count,
          invalid_json_lines: 0,
          invalid_json_line_numbers: [],
        };
      }
      const existing = normalizedExisting as EntryLifecycleProposalRow[];
      // Kind repair is orthogonal to the independent-evidence gate: deferred
      // decay rows with the historical outcome_entry defect are still eligible
      // so a later evidence reopen inherits a verified durable kind.
      const candidates = existing.filter((row) =>
        row.project_root === projectRoot &&
        (row.status === "pending" || row.status === "deferred_until_new_evidence") &&
        row.op === "archive" &&
        row.evidence_source === "decay" &&
        row.kind === "outcome_entry" &&
        !!row.slug,
      );
      const selected = new Set(candidates.slice(0, DECAY_COMPAT_MAX_PER_RUN));
      const repairedSlugs: string[] = [];
      const retiredSlugs: string[] = [];
      const next = existing.map((row) => {
        if (!selected.has(row)) return row;
        const resolution = durableKinds.get(normalizeRelationTarget(row.slug ?? "")) ?? { reason: "missing_durable_entry" as const };
        if (resolution.kind) {
          repairedSlugs.push(row.slug as string);
          return {
            ...row,
            kind: resolution.kind,
            kind_resolution: {
              schema_version: 1,
              action: "legacy_decay_kind_repaired" as const,
              resolved_at: resolvedAt,
              ...(resolution.source ? { source: resolution.source } : {}),
              durable_kind: resolution.kind,
            },
          };
        }
        retiredSlugs.push(row.slug as string);
        return {
          ...row,
          status: "failed" as const,
          terminal_at: resolvedAt,
          terminal_reason: "legacy_decay_kind_unresolved",
          message: clip(`${row.message ?? ""} legacy_decay_kind_unresolved=${resolution.reason ?? "missing_durable_entry"}`),
          kind_resolution: {
            schema_version: 1,
            action: "legacy_decay_kind_retired" as const,
            resolved_at: resolvedAt,
            ...(resolution.source ? { source: resolution.source } : {}),
            reason: resolution.reason ?? "missing_durable_entry",
          },
        };
      });
      const written = repairedSlugs.length > 0 || retiredSlugs.length > 0;
      if (written) {
        const enriched = next.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
        atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
      }
      return {
        written,
        rows_total: next.length,
        considered: candidates.length,
        repaired: repairedSlugs.length,
        retired: retiredSlugs.length,
        deferred: Math.max(0, candidates.length - DECAY_COMPAT_MAX_PER_RUN),
        repaired_slugs: repairedSlugs,
        retired_slugs: retiredSlugs,
        invalid_json_lines: 0,
        invalid_json_line_numbers: [],
      };
    });
    if (!locked.ok) return empty("proposal_lock_contention");
    if ("error" in locked.value) {
      return {
        ...empty(locked.value.error, locked.value.invalid_json_lines, locked.value.invalid_json_line_numbers),
        rows_total: locked.value.rows_total,
      };
    }
    return { ok: true, max_per_run: DECAY_COMPAT_MAX_PER_RUN, ...locked.value };
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Append affirmative lifecycle proposals carried by PROMOTED advisories. This is
 * still observation-only; demoted_signals are not accepted by contract.
 */
export function appendLifecycleProposals(options: AppendLifecycleProposalsOptions): AppendLifecycleProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const ts = formatLocalIsoTimestamp(options.now ?? new Date());
  const promoted = Array.isArray(options.promoted) ? options.promoted : [];
  const carrying = promoted.filter((a) => a && a.lifecycle_proposal);
  const rows: EntryLifecycleProposalRow[] = carrying.map((a) => {
    const p = a.lifecycle_proposal as LifecycleProposal;
    const evidence = clip(p.independent_evidence);
    const evidenceEventIds = resolveIndependentOutcomeEvidenceEventIds(p.independent_evidence_event_ids, projectRoot, {
      targetSlug: a.slug,
      requireReliableAttribution: true,
    });
    const executionReady = p.op === "archive" && evidenceEventIds.length > 0 && typeof a.slug === "string" && !!a.slug;
    return {
      schema_version: 1,
      ts,
      project_root: projectRoot,
      ...(typeof a.slug === "string" && a.slug ? { slug: a.slug } : {}),
      kind: a.kind,
      op: p.op,
      reason: p.reason,
      independent_evidence: evidence,
      falsifier: clip(p.falsifier),
      ...(a.message ? { message: clip(a.message) } : {}),
      expected_status: "active",
      disposition: executionReady ? "execution_ready" : "defer_until_new_evidence",
      evidence_source: "aggregator_promoted_advisory",
      evidence_key: `${a.slug ?? ""}:${a.kind}:${p.op}:${p.reason}:${evidence}`,
      ...(p.evidence_type ? { evidence_type: p.evidence_type } : {}),
      ...(evidenceEventIds.length > 0 ? { independent_evidence_event_ids: evidenceEventIds } : {}),
      status: executionReady
        ? "pending"
        : evidenceEventIds.length > 0 && p.op !== "archive"
          ? "failed"
          : "deferred_until_new_evidence",
    };
  });
  return lifecycleAppendResult(appendRows(projectRoot, rows));
}

function decayReason(a: EntryDecayAssessment): LifecycleProposalReason {
  return a.demote_evidence_type === "superseded_by" ? "affirm_superseded" : "affirm_stale";
}

function decayEvidenceText(a: EntryDecayAssessment): string {
  const parts = [
    `decay would_demote=true`,
    `demote_evidence_type=${a.demote_evidence_type}`,
    `primary_driver=${a.primary_driver}`,
    `decay_score=${a.decay_score.toFixed(3)}`,
  ];
  const inputs = a.decay_inputs ?? {};
  if (typeof inputs.window_retrieved_unused === "number") parts.push(`window_retrieved_unused=${inputs.window_retrieved_unused}`);
  if (typeof inputs.decisive_streak === "number") parts.push(`decisive_streak=${inputs.decisive_streak}`);
  if (inputs.last_cited_at) parts.push(`last_cited_at=${inputs.last_cited_at}`);
  return parts.join("; ");
}

/**
 * Bridge decay-shadow's truth-change-gated would_demote=true signal into the
 * existing proposal sidecar. This is deliberately small: no markdown mutation,
 * no executor bypass, no historical decay-shadow replay, and no usage-only path.
 */
export function appendDecayDemoteProposals(options: AppendDecayDemoteProposalsOptions): AppendDecayDemoteProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? new Date();
  const ts = formatLocalIsoTimestamp(now);
  const maxPerRun = Math.max(0, Math.min(DECAY_COMPAT_MAX_PER_RUN, Math.floor(options.maxPerRun ?? DECAY_COMPAT_MAX_PER_RUN)));
  const legacyKindCompatibility = reconcileLegacyDecayProposalKinds({ projectRoot, now });
  const durableKinds = durableKindResolutions(projectRoot);
  const eligible: Array<{ assessment: EntryDecayAssessment; kind: EntryKind; evidenceEventIds: string[] }> = [];
  let skippedMissingDurableKind = 0;
  let skippedInvalidDurableKind = 0;
  for (const raw of Array.isArray(options.assessments) ? options.assessments : []) {
    const assessment = normalizeAssessment(raw);
    if (!assessment || assessment.would_demote !== true || assessment.demote_evidence_type === null) continue;
    const resolution = durableKinds.get(normalizeRelationTarget(assessment.slug)) ?? { reason: "missing_durable_entry" as const };
    if (resolution.kind) {
      const rawIds = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).independent_evidence_event_ids)
        ? (raw as Record<string, unknown>).independent_evidence_event_ids
        : [];
      const evidenceEventIds = resolveIndependentOutcomeEvidenceEventIds(rawIds, projectRoot, {
        targetSlug: assessment.slug,
        requireReliableAttribution: true,
      });
      eligible.push({ assessment, kind: resolution.kind, evidenceEventIds });
    } else if (resolution.reason === "missing_durable_entry" || resolution.reason === "missing_durable_kind") {
      skippedMissingDurableKind++;
    } else {
      skippedInvalidDurableKind++;
    }
  }

  const rows: EntryLifecycleProposalRow[] = eligible.map(({ assessment: a, kind, evidenceEventIds }) => {
    const executionReady = evidenceEventIds.length > 0;
    return {
      schema_version: 1,
      ts,
      project_root: projectRoot,
      slug: a.slug,
      kind,
      op: "archive" as const,
      reason: decayReason(a),
      independent_evidence: clip(decayEvidenceText(a)),
      falsifier: clip(a.falsifier || "newer evidence retracts the decay assessment or the entry is revalidated as current"),
      message: clip(`decay-shadow would_demote=true for ${a.slug}`),
      expected_status: "active" as const,
      disposition: executionReady ? "execution_ready" as const : "defer_until_new_evidence" as const,
      evidence_source: "decay" as const,
      evidence_key: `decay:${a.slug}:${a.demote_evidence_type}:${a.primary_driver}`,
      evidence_type: a.demote_evidence_type ?? undefined,
      ...(evidenceEventIds.length ? { independent_evidence_event_ids: evidenceEventIds } : {}),
      status: executionReady ? "pending" as const : "deferred_until_new_evidence" as const,
    };
  });
  const appended = appendRows(projectRoot, rows, { dedupeArchiveBySlug: true, maxAppend: maxPerRun });
  return {
    ...appended,
    source: "decay",
    considered: Array.isArray(options.assessments) ? options.assessments.length : 0,
    eligible: eligible.length,
    limited: appended.limited ?? 0,
    skipped_duplicate_slug: appended.skipped_duplicate_slug ?? 0,
    skipped_missing_durable_kind: skippedMissingDurableKind,
    skipped_invalid_durable_kind: skippedInvalidDurableKind,
    max_per_run: maxPerRun,
    appended_slugs: appended.appended_slugs ?? [],
    legacy_kind_compatibility: legacyKindCompatibility,
  };
}

function scalarString(value: Jsonish | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function rawRelationValues(value: Jsonish | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  return [];
}

function normalizeRelationTarget(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0]!.split("#")[0]!.trim();
  const url = /^abrain:\/\/([^/]+)\/(.+)$/.exec(s);
  if (url) s = url[2] ?? "";
  const parts = s.split(":").filter(Boolean);
  if (parts.length >= 2) s = parts[parts.length - 1]!;
  s = s.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? s;
  s = s.replace(/\.md$/i, "");
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function validSupersededBy(entry: SupersededFrontmatterEntry): string | undefined {
  const candidates: string[] = [];
  for (const edge of (entry.relations ?? []) as RelationEdge[]) {
    if (edge?.type === "superseded_by" && edge.to) candidates.push(edge.to);
  }
  for (const raw of rawRelationValues(entry.frontmatter?.superseded_by)) candidates.push(normalizeRelationTarget(raw));
  const self = normalizeRelationTarget(entry.slug);
  return candidates.map(normalizeRelationTarget).find((slug) => slug && slug !== self);
}

/**
 * D* Phase 1 deterministic bridge. Reads current parsed frontmatter state and
 * emits:
 *   E1: status=superseded + non-self superseded_by -> execution_ready archive
 *       proposal with expected_status=superseded.
 *   E2: status=superseded without a valid successor -> autonomous
 *       deferred_until_new_evidence. It is rechecked on successor/status/
 *       attributed-evidence triggers and never becomes a human queue.
 *
 * The same scan terminally resolves an E2 when status is no longer superseded;
 * a newly observed valid successor replaces it with E1 automatically.
 */
export function appendSupersededFrontmatterProposals(options: AppendSupersededFrontmatterProposalsOptions): AppendSupersededFrontmatterProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const ts = formatLocalIsoTimestamp(options.now ?? new Date());
  const rows: EntryLifecycleProposalRow[] = [];
  const e1: string[] = [];
  const e2: string[] = [];

  for (const entry of Array.isArray(options.entries) ? options.entries : []) {
    if (!entry || typeof entry.slug !== "string" || !entry.slug) continue;
    const currentStatus = scalarString(entry.frontmatter?.status);
    if (currentStatus !== "superseded") continue;
    const target = validSupersededBy(entry);
    if (target) {
      e1.push(entry.slug);
      rows.push({
        schema_version: 1,
        ts,
        project_root: projectRoot,
        slug: entry.slug,
        kind: entry.kind || "unknown",
        op: "archive",
        reason: "affirm_superseded",
        independent_evidence: `frontmatter status=superseded; superseded_by=${target}`,
        falsifier: "current frontmatter status is no longer superseded or superseded_by is invalid/self-referential",
        message: `deterministic E1 archive proposal for superseded entry ${entry.slug}`,
        expected_status: "superseded",
        disposition: "execution_ready",
        evidence_source: "frontmatter_superseded",
        evidence_key: `E1:${entry.slug}:${target}`,
        target_slug: target,
        ...executableSchedule(options.now ?? new Date(), 0),
        attempt: 0,
        failure_class: "transient",
        new_evidence_trigger: E1_NEW_EVIDENCE_TRIGGER,
        status: "pending",
      });
    } else {
      e2.push(entry.slug);
      rows.push({
        schema_version: 1,
        ts,
        project_root: projectRoot,
        slug: entry.slug,
        kind: entry.kind || "unknown",
        op: "archive",
        reason: "superseded_no_successor",
        independent_evidence: "frontmatter status=superseded but no valid non-self superseded_by edge exists",
        falsifier: "curator confirms a valid successor edge or restores the entry to an active standing",
        message: `curator_task=confirm_superseded_successor_or_restore_status; slug=${entry.slug}`,
        expected_status: "superseded",
        disposition: "defer_until_new_evidence",
        evidence_source: "frontmatter_superseded",
        evidence_key: `E2:${entry.slug}:no_successor`,
        ...e2Schedule(options.now ?? new Date(), 0),
        attempt: 0,
        failure_class: "semantic_defer",
        new_evidence_trigger: E2_NEW_EVIDENCE_TRIGGER,
        status: "deferred_until_new_evidence",
      });
    }
  }

  const currentStatusBySlug = new Map((Array.isArray(options.entries) ? options.entries : [])
    .filter((entry): entry is SupersededFrontmatterEntry => !!entry && typeof entry.slug === "string" && !!entry.slug)
    .map((entry) => [entry.slug, scalarString(entry.frontmatter?.status) ?? String(entry.status ?? "")]));
  const r = lifecycleAppendResult(appendRows(projectRoot, rows, { currentStatusBySlug, now: options.now }));
  return { ...r, e1_count: e1.length, e2_count: e2.length, e1_slugs: e1, e2_slugs: e2 };
}

function splitMarkdownFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  return m?.[1] ?? "";
}

function parseFrontmatterScalar(raw: string): Jsonish {
  const s = raw.trim();
  if (!s) return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseFrontmatterScalar(part)).filter((part) => part !== "") as Jsonish[];
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  return s;
}

function parseMarkdownFrontmatter(raw: string): Record<string, Jsonish> {
  const out: Record<string, Jsonish> = {};
  const lines = splitMarkdownFrontmatter(raw).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!;
    if (rest.trim()) {
      out[key] = parseFrontmatterScalar(rest);
      continue;
    }
    const items: Jsonish[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const item = /^\s+-\s*(.*)$/.exec(lines[j]!);
      if (!item) break;
      items.push(parseFrontmatterScalar(item[1] ?? ""));
      j++;
    }
    if (items.length > 0) {
      out[key] = items;
      i = j - 1;
    } else {
      out[key] = "";
    }
  }
  return out;
}

function markdownEntrySlug(file: string, fm: Record<string, Jsonish>): string {
  const id = scalarString(fm.id) ?? "";
  const tail = id.includes(":") ? id.split(":").filter(Boolean).pop() ?? id : id;
  return normalizeRelationTarget(tail || path.basename(file, ".md"));
}

function readMarkdownEntries(root: string): SupersededFrontmatterEntry[] {
  const out: SupersededFrontmatterEntry[] = [];
  const skip = new Set([".git", ".state", ".pi-astack", "node_modules", "staging", "workflows", "rules", "vault"]);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.isFile() || !p.endsWith(".md") || ent.name === "_index.md") continue;
      try {
        const fm = parseMarkdownFrontmatter(fs.readFileSync(p, "utf-8"));
        const kind = scalarString(fm.kind) ?? "unknown";
        const status = scalarString(fm.status) ?? "";
        const slug = markdownEntrySlug(p, fm);
        if (!slug || !status) continue;
        const relations = rawRelationValues(fm.superseded_by).map((raw) => ({ type: "superseded_by", to: normalizeRelationTarget(raw), source: "frontmatter" as const }));
        out.push({ slug, kind, status, frontmatter: fm, relations });
      } catch { /* ignore unreadable/non-entry markdown */ }
    }
  };
  walk(root);
  return out;
}

function scanMarkdownEntries(legacyRoot: string, canonicalRoot?: string): SupersededFrontmatterEntry[] {
  const bySlug = new Map<string, SupersededFrontmatterEntry>();
  for (const entry of readMarkdownEntries(legacyRoot)) bySlug.set(entry.slug, entry);
  if (canonicalRoot && fs.existsSync(canonicalRoot)) {
    for (const canonical of readMarkdownEntries(canonicalRoot)) {
      const legacy = bySlug.get(canonical.slug);
      const fm = { ...canonical.frontmatter };
      if (fm.superseded_by === undefined && legacy?.frontmatter?.superseded_by !== undefined) fm.superseded_by = legacy.frontmatter.superseded_by;
      const relations = rawRelationValues(fm.superseded_by).map((raw) => ({ type: "superseded_by", to: normalizeRelationTarget(raw), source: "frontmatter" as const }));
      bySlug.set(canonical.slug, { ...canonical, frontmatter: fm, relations });
    }
  }
  return Array.from(bySlug.values());
}

function durableKindsFromFrontmatter(entries: SupersededFrontmatterEntry[], source: DurableKindSource): Map<string, DurableKindResolution> {
  const observed = new Map<string, Array<{ raw: string | undefined; kind: EntryKind | undefined }>>();
  for (const entry of entries) {
    const slug = normalizeRelationTarget(entry.slug);
    if (!slug) continue;
    const raw = scalarString(entry.frontmatter?.kind);
    const values = observed.get(slug) ?? [];
    values.push({ raw, kind: validDurableKind(raw) });
    observed.set(slug, values);
  }
  const resolved = new Map<string, DurableKindResolution>();
  for (const [slug, values] of observed) {
    const kinds = [...new Set(values.map((value) => value.kind).filter((kind): kind is EntryKind => !!kind))];
    if (values.some((value) => value.raw === undefined)) {
      resolved.set(slug, { source, reason: "missing_durable_kind" });
    } else if (values.some((value) => !value.kind)) {
      const rawKinds = [...new Set(values.map((value) => value.raw).filter((raw): raw is string => !!raw))];
      resolved.set(slug, { source, reason: "invalid_durable_kind", ...(rawKinds.length === 1 ? { raw_kind: rawKinds[0] } : {}) });
    } else if (kinds.length === 1) {
      resolved.set(slug, { source, kind: kinds[0] });
    } else {
      resolved.set(slug, { source, reason: "ambiguous_durable_kind" });
    }
  }
  return resolved;
}

function durableKindResolutions(projectRoot: string): Map<string, DurableKindResolution> {
  const project = normalizeProjectRoot(projectRoot);
  const resolved = durableKindsFromFrontmatter(readMarkdownEntries(project), "project_root_frontmatter");
  try {
    const abrainHome = path.resolve(resolveUserGlobalAbrainHome());
    const projectId = resolveActiveProject(project, { abrainHome }).activeProject?.projectId;
    if (!projectId) return resolved;
    for (const [slug, resolution] of durableKindsFromFrontmatter(readMarkdownEntries(abrainProjectDir(abrainHome, projectId)), "project_frontmatter")) {
      resolved.set(slug, resolution);
    }
    for (const [slug, resolution] of durableKindsFromFrontmatter(readMarkdownEntries(path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects", projectId)), "canonical_frontmatter")) {
      resolved.set(slug, resolution);
    }
  } catch { /* unresolved durable kind is fail-closed for new decay rows */ }
  return resolved;
}

/** Read only an explicit, valid `kind:` from the current durable frontmatter.
 * Canonical L2 wins over project storage, which wins over a local project-root
 * fixture/store. This deliberately never infers kind from a directory. */
export function resolveDurableEntryKind(projectRoot: string, slug: string): DurableKindResolution {
  const normalizedSlug = normalizeRelationTarget(slug);
  if (!normalizedSlug) return { reason: "missing_durable_entry" };
  return durableKindResolutions(projectRoot).get(normalizedSlug) ?? { reason: "missing_durable_entry" };
}

/** Scan canonical project markdown frontmatter directly. This deliberately does
 * not use loadEntries because projection views can omit legacy relation fields. */
export function appendSupersededMarkdownFrontmatterProposals(options: AppendSupersededMarkdownFrontmatterProposalsOptions): AppendSupersededFrontmatterProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  if (!projectRoot) return { ok: true, written: false, proposals_appended: 0, rows_total: readLifecycleProposals().length, e1_count: 0, e2_count: 0, e1_slugs: [], e2_slugs: [] };
  try {
    const abrainHome = path.resolve(options.abrainHome ?? resolveUserGlobalAbrainHome());
    const projectId = options.projectId ?? resolveActiveProject(projectRoot, { abrainHome }).activeProject?.projectId;
    if (!projectId) return { ok: true, written: false, proposals_appended: 0, rows_total: readLifecycleProposals(projectRoot).length, e1_count: 0, e2_count: 0, e1_slugs: [], e2_slugs: [] };
    const entries = scanMarkdownEntries(
      abrainProjectDir(abrainHome, projectId),
      path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects", projectId),
    );
    return appendSupersededFrontmatterProposals({ projectRoot, entries, now: options.now });
  } catch (e) {
    return { ok: false, written: false, proposals_appended: 0, rows_total: 0, e1_count: 0, e2_count: 0, e1_slugs: [], e2_slugs: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read proposals, optionally scoped to one project. Read-only consumer API. */
export function readLifecycleProposals(projectRoot?: string): EntryLifecycleProposalRow[] {
  const rows = readJsonlTail<unknown>(entryLifecycleProposalsPath())
    .map(normalizeRow)
    .filter((r): r is EntryLifecycleProposalRow => r !== null);
  if (!projectRoot) return rows;
  const normalized = normalizeProjectRoot(projectRoot);
  return rows.filter((r) => r.project_root === normalized);
}

function entryLifecycleProposalsLockPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "locks", "entry-lifecycle-proposals.lock");
}

/** Executor bookkeeping: mark execution-ready pending archive proposals as executed/failed. */
export function markProposalsExecuted(
  projectRoot: string,
  slugs: string[],
  status: "executed" | "failed" = "executed",
): { ok: boolean; updated: number; error?: string } {
  const pr = normalizeProjectRoot(projectRoot);
  const slugSet = new Set((Array.isArray(slugs) ? slugs : []).filter((s): s is string => typeof s === "string" && s.length > 0));
  if (!pr || slugSet.size === 0) return { ok: true, updated: 0 };
  const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
    const loaded = readJsonlForFullRewrite<unknown>(entryLifecycleProposalsPath());
    if (loaded.error) return { error: loaded.error, updated: 0 };
    const normalizedRows = loaded.rows.map(normalizeRow);
    if (normalizedRows.some((row) => row === null)) return { error: "proposal_row_normalization_failed", updated: 0 };
    const rows = normalizedRows as EntryLifecycleProposalRow[];
    let updated = 0;
    const next = rows.map((r) => {
      const executable = (r.disposition ?? "execution_ready") === "execution_ready";
      if (executable && r.project_root === pr && r.op === "archive" && r.status === "pending" && r.slug && slugSet.has(r.slug)) {
        updated++;
        return {
          ...r,
          status,
          terminal_at: new Date().toISOString(),
          terminal_reason: status === "executed" ? "executor_completed" : "executor_failed",
        };
      }
      return r;
    });
    if (updated > 0) {
      const enriched = next.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
    return { updated };
  });
  if (!locked.ok) return { ok: false, updated: 0, error: "proposal_lock_contention" };
  if ("error" in locked.value) return { ok: false, updated: 0, error: locked.value.error };
  return { ok: true, updated: locked.value.updated };
}
