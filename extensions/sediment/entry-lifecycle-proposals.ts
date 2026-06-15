/**
 * entry-lifecycle-proposals — Outcome→Entry feedback edge, M3 read-only sink.
 *
 * Design: docs/notes/2026-06-04-outcome-entry-feedback-edge-design.md (§3b, v3
 * + 2026-06-04 semantic correction ratified by the 3-T0 panel).
 *
 * M3 distills the AFFIRMATIVE channel — `promoted_advisories[]` carrying a
 * `lifecycle_proposal` (the LLM upheld a staleness/echo suspicion WITH §4.2
 * independent evidence) — into a git-ignored proposal sidecar.
 *
 * It is the dry-run instrument the §0b resume trigger watches: it measures the
 * arrival rate of genuine lifecycle proposals so the DEFERRED, gated M4/M5
 * executor's eventual code 3-T0 reviews real proposals, not synthetic fixtures.
 *
 * HARD BOUNDARIES (prompt §8 "Observation ≠ Authorization", ratified by panel):
 *   - NEVER writes durable entry markdown. NEVER imports / calls the writer,
 *     curator, archive, or multi-view. NO LLM. NO user surface.
 *   - It ONLY appends rows to ~/.abrain/.state/sediment/entry-lifecycle-proposals.jsonl
 *     with status="pending". The sole consumer is the deferred M4/M5 executor
 *     (behind its own 3-T0 + the §0b resume trigger + the explicit multi-view
 *     gate). M3 observes → proposes; it never authorizes.
 *   - Proposals are sourced ONLY from promoted_advisories. demoted_signals are
 *     the EXONERATION channel and must never produce a proposal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { withFileLock, atomicWriteText } from "../_shared/sync-file-lock";
import type { LifecycleProposal, PromotedAdvisory } from "./aggregator-llm";

export interface EntryLifecycleProposalRow {
  schema_version: 1;
  ts: string;
  project_root: string;
  /** Durable entry the proposal concerns (from the promoted advisory slug). */
  slug?: string;
  kind: string;
  op: LifecycleProposal["op"];
  reason: LifecycleProposal["reason"];
  independent_evidence: string;
  falsifier: string;
  message?: string;
  /** M3 always emits "pending"; the gated executor(ADR 0031 Phase 3)transitions it to
   *  "executed"(active→archived 完成)或 "failed"。normalizeRow 保留磁盘状态(不再硬编码
   *  pending)—— 否则 executed 标记读不回 → 同 proposal 每轮重复执行(opus M4/M5 P0-1)。 */
  status: "pending" | "executed" | "failed";
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

const PROPOSALS_MAX_ROWS = 1000;
const PROPOSALS_TAIL_READ_BYTES = 2 * 1024 * 1024;
const STRING_FIELD_MAX_CHARS = 1_000;

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

function normalizeRow(row: unknown): EntryLifecycleProposalRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const projectRoot = normalizeProjectRoot(r.project_root);
  const op = r.op === "contest" || r.op === "archive" || r.op === "supersede" ? r.op : undefined;
  const reason = r.reason === "affirm_stale" || r.reason === "affirm_superseded" || r.reason === "affirm_echo_chamber" ? r.reason : undefined;
  if (!projectRoot || !op || !reason) return null;
  return {
    schema_version: 1,
    ts: typeof r.ts === "string" ? r.ts : formatLocalIsoTimestamp(),
    project_root: projectRoot,
    ...(typeof r.slug === "string" && r.slug ? { slug: r.slug } : {}),
    kind: typeof r.kind === "string" ? r.kind : "unknown",
    op,
    reason,
    independent_evidence: typeof r.independent_evidence === "string" ? r.independent_evidence : "",
    falsifier: typeof r.falsifier === "string" ? r.falsifier : "",
    ...(typeof r.message === "string" ? { message: r.message } : {}),
    // P0-1: 保留磁盘状态;未知值才 fallback pending。
    status: (r.status === "executed" || r.status === "failed") ? r.status : "pending",
  };
}

/**
 * Append the affirmative lifecycle proposals carried by this run's PROMOTED
 * advisories. No-op when none carry a `lifecycle_proposal`. Pure observation:
 * writes only the proposal sidecar, never durable memory. Failures are folded
 * into the result, never thrown (fire-and-forget caller).
 */
export function appendLifecycleProposals(options: AppendLifecycleProposalsOptions): AppendLifecycleProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const ts = formatLocalIsoTimestamp(options.now ?? new Date());
  const promoted = Array.isArray(options.promoted) ? options.promoted : [];
  // SOURCE = promoted advisories ONLY (the affirmative channel). demoted_signals
  // are not passed in here by contract; proposals never come from exoneration.
  const carrying = promoted.filter((a) => a && a.lifecycle_proposal);
  try {
    if (!projectRoot || carrying.length === 0) {
      const existing = readJsonlTail<unknown>(entryLifecycleProposalsPath())
        .map(normalizeRow)
        .filter((r): r is EntryLifecycleProposalRow => r !== null);
      return { ok: true, written: false, proposals_appended: 0, rows_total: existing.length };
    }
    // P0-3: 整文件 RMW 上锁(与 markProposalsExecuted 共一把锁),防与 executor 翻 status 竞写。
    const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
      const existing = readJsonlTail<unknown>(entryLifecycleProposalsPath())
        .map(normalizeRow)
        .filter((r): r is EntryLifecycleProposalRow => r !== null);
      const newRows: EntryLifecycleProposalRow[] = carrying.map((a) => {
        const p = a.lifecycle_proposal as LifecycleProposal;
        return {
          schema_version: 1,
          ts,
          project_root: projectRoot,
          ...(typeof a.slug === "string" && a.slug ? { slug: a.slug } : {}),
          kind: a.kind,
          op: p.op,
          reason: p.reason,
          independent_evidence: clip(p.independent_evidence),
          falsifier: clip(p.falsifier),
          ...(a.message ? { message: clip(a.message) } : {}),
          status: "pending" as const,
        };
      });
      const allRows = [...existing, ...newRows].slice(-PROPOSALS_MAX_ROWS);
      const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return { proposals_appended: newRows.length, rows_total: allRows.length };
    });
    if (!locked.ok) return { ok: false, written: false, proposals_appended: 0, rows_total: 0, error: "proposal_lock_contention" };
    return { ok: true, written: true, proposals_appended: locked.value.proposals_appended, rows_total: locked.value.rows_total };
  } catch (e) {
    return {
      ok: false,
      written: false,
      proposals_appended: 0,
      rows_total: 0,
      error: e instanceof Error ? e.message : String(e),
    };
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

/** ADR 0031 Phase 3(M4/M5 executor 专用): 把指定 slug 的 pending op=archive proposal
 *  翻成 executed/failed(幂等: 已非 pending 的不动)。与 appendLifecycleProposals 共锁串行
 *  (opus M4/M5 P0-1+P0-3)。拿不到锁 → ok:false(调用方下轮重试)。 */
export function markProposalsExecuted(
  projectRoot: string,
  slugs: string[],
  status: "executed" | "failed" = "executed",
): { ok: boolean; updated: number; error?: string } {
  const pr = normalizeProjectRoot(projectRoot);
  const slugSet = new Set((Array.isArray(slugs) ? slugs : []).filter((s): s is string => typeof s === "string" && s.length > 0));
  if (!pr || slugSet.size === 0) return { ok: true, updated: 0 };
  const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
    const rows = readJsonlTail<unknown>(entryLifecycleProposalsPath())
      .map(normalizeRow)
      .filter((r): r is EntryLifecycleProposalRow => r !== null);
    let updated = 0;
    const next = rows.map((r) => {
      if (r.project_root === pr && r.op === "archive" && r.status === "pending" && r.slug && slugSet.has(r.slug)) {
        updated++;
        return { ...r, status };
      }
      return r;
    });
    if (updated > 0) {
      const enriched = next.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
    return updated;
  });
  if (!locked.ok) return { ok: false, updated: 0, error: "proposal_lock_contention" };
  return { ok: true, updated: locked.value };
}
