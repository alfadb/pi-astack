/**
 * entry-telemetry — Outcome→Entry feedback edge, Tier-A sidecar (INFRA only).
 *
 * Design: docs/notes/2026-06-04-outcome-entry-feedback-edge-design.md (v3).
 *
 * This is the FOUNDATION of meta-curator capability #1. It distills the
 * per-citation `outcome-ledger.jsonl` into a per-entry usage telemetry sidecar:
 *
 *   citation_count / total_retrievals (CUMULATIVE, lifetime within retained
 *   ledger) + a 30d ROLLING window (decisive / confirmatory / retrieved-unused /
 *   decisive_streak / possible_echo_chamber).
 *
 * HARD BOUNDARIES (verified by smoke + 3-T0 design review):
 *   - NEVER writes durable entry markdown / frontmatter. The 3-T0 review killed
 *     the v1 "telemetry in frontmatter" idea: the writer update path bumps
 *     `updated`, grows Timeline, git-commits + auto-pushes, and can silently
 *     reset status/confidence on malformed entries. Telemetry lives ONLY in this
 *     git-ignored sidecar (re-derivable from the ledger; loss → full re-scan).
 *   - NO LLM. Pure deterministic aggregation. Idempotent: recomputing from the
 *     same ledger yields the same telemetry (modulo `updated_at`).
 *   - NO durable mutation, NO multi-view, NO user surface. This module is read
 *     of ledger + write of sidecar, nothing else.
 *
 * It also CARRIES (does not author) the loop-breaker / hysteresis fields
 * (`last_proposed_at`, `proposal_cooldown_until`, `holdout_until`) so the gated
 * executor (a later module) can persist per-entry dwell-time without a second
 * store. Those fields are PRESERVED across merges, never derived from the ledger.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import {
  readProjectOutcomeRows,
  summarizeEntryActivity,
  type LedgerOutcomeRow,
} from "./outcome-collector";

export interface EntryTelemetryRow {
  schema_version: 1;
  project_root: string;
  slug: string;
  /** Cumulative memory-footnote citations for this slug within retained ledger. */
  citation_count: number;
  /** Cumulative tool-result retrievals (sum of retrieval_count) within retained ledger. */
  total_retrievals: number;
  first_cited_at?: string;
  last_cited_at?: string;
  /** Rolling-window basis (days). */
  window_days: number;
  window_decisive: number;
  window_confirmatory: number;
  window_retrieved_unused: number;
  window_decisive_streak: number;
  window_total_retrievals: number;
  /** decisive_streak >= ECHO_CHAMBER_STREAK in-window (advisory only). */
  possible_echo_chamber: boolean;
  /** Loop-breaker / hysteresis state — written by the executor, CARRIED here. */
  last_proposed_at?: string;
  proposal_cooldown_until?: string;
  holdout_until?: string;
  updated_at: string;
}

export interface MergeEntryTelemetryOptions {
  projectRoot: string;
  windowDays?: number;
  now?: Date;
}

export interface MergeEntryTelemetryResult {
  ok: boolean;
  written: boolean;
  project_root: string;
  slugs_considered: number;
  rows_written: number;
  error?: string;
}

const ENTRY_TELEMETRY_MAX_ROWS = 4000;
const ENTRY_TELEMETRY_TAIL_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_WINDOW_DAYS = 30;
const ECHO_CHAMBER_STREAK = 5;
const ENTRY_TELEMETRY_MIN_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;

export function entryTelemetryPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "entry-telemetry.jsonl");
}

function normalizeProjectRoot(value: unknown): string {
  return typeof value === "string" && value.trim() ? path.resolve(value) : "";
}

function compoundKey(projectRoot: string, slug: string): string {
  return `${projectRoot}\u0000${slug}`;
}

interface SyncLockClaim {
  pid: number;
  token: string;
  created_at: string;
}

function makeLockClaim(): SyncLockClaim {
  return {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
    created_at: formatLocalIsoTimestamp(),
  };
}

function parseLockClaim(raw: string): SyncLockClaim | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SyncLockClaim>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string" || typeof parsed.created_at !== "string") return null;
    return { pid: parsed.pid, token: parsed.token, created_at: parsed.created_at };
  } catch {
    return null;
  }
}

function pidAppearsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function tryAcquireSyncLock(file: string): SyncLockClaim | null {
  const claim = makeLockClaim();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { flag: "wx" });
    return claim;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
  }
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return null;
    const raw = fs.readFileSync(file, "utf-8");
    const existing = parseLockClaim(raw);
    if (existing && pidAppearsAlive(existing.pid)) return null;
    const currentRaw = fs.readFileSync(file, "utf-8");
    const current = parseLockClaim(currentRaw);
    if (existing?.token) {
      if (current?.token !== existing.token) return null;
    } else if (currentRaw !== raw) {
      return null;
    }
    const currentStat = fs.statSync(file);
    if (Date.now() - currentStat.mtimeMs <= LOCK_STALE_MS) return null;
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { flag: "wx" });
    return claim;
  } catch {
    return null;
  }
}

function releaseSyncLock(file: string, claim: SyncLockClaim | null): void {
  if (!claim) return;
  try {
    const current = parseLockClaim(fs.readFileSync(file, "utf-8"));
    if (current?.token !== claim.token) return;
    fs.unlinkSync(file);
  } catch {
    // best-effort
  }
}

function atomicWriteText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed or never written */ }
  }
}

function entryTelemetryGlobalLockPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "locks", "entry-telemetry.lock");
}

function entryTelemetryProjectLockPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "locks", "entry-telemetry.lock");
}

function readJsonlTail<T = Record<string, unknown>>(filePath: string, maxBytes = ENTRY_TELEMETRY_TAIL_READ_BYTES): T[] {
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

function normalizeRow(row: unknown): EntryTelemetryRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const projectRoot = normalizeProjectRoot(r.project_root);
  const slug = typeof r.slug === "string" && r.slug.trim() ? r.slug.trim() : "";
  if (!projectRoot || !slug) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return {
    schema_version: 1,
    project_root: projectRoot,
    slug,
    citation_count: num(r.citation_count),
    total_retrievals: num(r.total_retrievals),
    first_cited_at: str(r.first_cited_at),
    last_cited_at: str(r.last_cited_at),
    window_days: num(r.window_days) || DEFAULT_WINDOW_DAYS,
    window_decisive: num(r.window_decisive),
    window_confirmatory: num(r.window_confirmatory),
    window_retrieved_unused: num(r.window_retrieved_unused),
    window_decisive_streak: num(r.window_decisive_streak),
    window_total_retrievals: num(r.window_total_retrievals),
    possible_echo_chamber: r.possible_echo_chamber === true,
    last_proposed_at: str(r.last_proposed_at),
    proposal_cooldown_until: str(r.proposal_cooldown_until),
    holdout_until: str(r.holdout_until),
    updated_at: str(r.updated_at) ?? formatLocalIsoTimestamp(),
  };
}

function readAllRows(): EntryTelemetryRow[] {
  return readJsonlTail<unknown>(entryTelemetryPath())
    .map(normalizeRow)
    .filter((r): r is EntryTelemetryRow => r !== null);
}

/** Cumulative (lifetime within retained ledger) per-slug counters. */
interface CumulativeStat {
  citation_count: number;
  total_retrievals: number;
  first_cited_at?: string;
  last_cited_at?: string;
}

function cumulativeBySlug(rows: LedgerOutcomeRow[]): Map<string, CumulativeStat> {
  const out = new Map<string, CumulativeStat>();
  for (const row of rows) {
    const slug = typeof row.entry_slug === "string" ? row.entry_slug : "";
    if (!slug) continue;
    const stat = out.get(slug) ?? { citation_count: 0, total_retrievals: 0 };
    if (row.source === "tool-result") {
      stat.total_retrievals += typeof row.retrieval_count === "number" && Number.isFinite(row.retrieval_count) ? Math.max(0, Math.floor(row.retrieval_count)) : 1;
    } else if (row.source === "memory-footnote" && typeof row.used === "string") {
      stat.citation_count += 1;
    }
    const ts = typeof row.ts === "string" ? row.ts : "";
    if (ts) {
      if (!stat.first_cited_at || ts < stat.first_cited_at) stat.first_cited_at = ts;
      if (!stat.last_cited_at || ts > stat.last_cited_at) stat.last_cited_at = ts;
    }
    out.set(slug, stat);
  }
  return out;
}

/**
 * Recompute this project's entry telemetry from the outcome-ledger and merge it
 * into the sidecar. Idempotent w.r.t. the ledger; loop-breaker/hysteresis fields
 * on existing rows are PRESERVED (the executor owns those). Pure INFRA: never
 * touches durable memory.
 */
export function mergeEntryTelemetry(options: MergeEntryTelemetryOptions): MergeEntryTelemetryResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const windowDays = Math.max(1, Math.floor(options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const ts = formatLocalIsoTimestamp(options.now ?? new Date());
  if (!projectRoot) {
    return { ok: true, written: false, project_root: "", slugs_considered: 0, rows_written: readAllRows().length };
  }
  const lockPath = entryTelemetryGlobalLockPath();
  const lock = tryAcquireSyncLock(lockPath);
  if (!lock) {
    return { ok: false, written: false, project_root: projectRoot, slugs_considered: 0, rows_written: 0, error: "entry_telemetry_lock_contention" };
  }
  try {
    // rowLimit=0 → readProjectOutcomeRows returns ALL retained rows for the
    // project (cumulative basis). The ledger's own retention is the bound.
    const rows = readProjectOutcomeRows(projectRoot, 0);
    const slugs = [...new Set(rows.map((r) => (typeof r.entry_slug === "string" ? r.entry_slug : "")).filter(Boolean))];

    // Preserve executor-owned hysteresis fields + other projects' rows.
    const existing = new Map<string, EntryTelemetryRow>();
    for (const row of readAllRows()) existing.set(compoundKey(row.project_root, row.slug), row);

    if (slugs.length === 0) {
      // Nothing cited yet for this project: no-op (do not rewrite the file).
      return { ok: true, written: false, project_root: projectRoot, slugs_considered: 0, rows_written: existing.size };
    }

    const cumulative = cumulativeBySlug(rows);
    const rolling = summarizeEntryActivity(rows, slugs, windowDays);
    const rollingBySlug = new Map(rolling.map((s) => [s.slug, s]));

    for (const slug of slugs) {
      const ck = compoundKey(projectRoot, slug);
      const prev = existing.get(ck);
      const cum = cumulative.get(slug) ?? { citation_count: 0, total_retrievals: 0 };
      const win = rollingBySlug.get(slug);
      const next: EntryTelemetryRow = {
        schema_version: 1,
        project_root: projectRoot,
        slug,
        citation_count: cum.citation_count,
        total_retrievals: cum.total_retrievals,
        first_cited_at: cum.first_cited_at ?? prev?.first_cited_at,
        last_cited_at: cum.last_cited_at ?? prev?.last_cited_at,
        window_days: windowDays,
        window_decisive: win?.decisive_count ?? 0,
        window_confirmatory: win?.confirmatory_count ?? 0,
        window_retrieved_unused: win?.retrieved_unused_count ?? 0,
        window_decisive_streak: win?.decisive_streak ?? 0,
        window_total_retrievals: win?.total_retrievals ?? 0,
        possible_echo_chamber: (win?.decisive_streak ?? 0) >= ECHO_CHAMBER_STREAK,
        // CARRY executor-owned loop-breaker state forward; never derived here.
        last_proposed_at: prev?.last_proposed_at,
        proposal_cooldown_until: prev?.proposal_cooldown_until,
        holdout_until: prev?.holdout_until,
        updated_at: ts,
      };
      existing.set(ck, next);
    }

    // Bound: keep the most-recently-updated rows across all projects.
    const allRows = [...existing.values()]
      .sort((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : compoundKey(a.project_root, a.slug).localeCompare(compoundKey(b.project_root, b.slug))))
      .slice(0, ENTRY_TELEMETRY_MAX_ROWS);

    const file = entryTelemetryPath();
    const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
    atomicWriteText(file, enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return { ok: true, written: true, project_root: projectRoot, slugs_considered: slugs.length, rows_written: allRows.length };
  } catch (e) {
    return {
      ok: false,
      written: false,
      project_root: projectRoot,
      slugs_considered: 0,
      rows_written: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    releaseSyncLock(lockPath, lock);
  }
}

/**
 * Project-local debounce marker (mirrors aggregator's last-run pattern). Lives
 * under the project's `.pi-astack/sediment/`, NOT the user-global sidecar.
 */
export function entryTelemetryLastRunPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "entry-telemetry-last-run.json");
}

function readTelemetryLastRun(projectRoot: string): number | null {
  try {
    const file = entryTelemetryLastRunPath(projectRoot);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown> | null;
    const value = parsed && typeof parsed === "object" ? parsed.last_run_ts : undefined;
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function writeTelemetryLastRun(projectRoot: string, now: Date, status: "ok" | "error"): void {
  try {
    const file = entryTelemetryLastRunPath(projectRoot);
    atomicWriteText(file, JSON.stringify({ last_run_ts: formatLocalIsoTimestamp(now), status }, null, 2) + "\n");
  } catch {
    // best-effort; failure only means a future turn may retry sooner
  }
}

/**
 * Debounced wrapper for the agent_end read-only telemetry lane. Returns null
 * when called again within `minIntervalMs` of the last run (default 1h — shorter
 * than the aggregator's 24h because telemetry should track usage more freshly,
 * but debounced so a burst of turns does not re-scan the full ledger every turn).
 * Fire-and-forget safe: all failures are swallowed into the result, never thrown.
 */
export function mergeEntryTelemetryIfDue(
  options: MergeEntryTelemetryOptions & { minIntervalMs?: number },
): MergeEntryTelemetryResult | null {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  if (!projectRoot) return null;
  const now = options.now ?? new Date();
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? ENTRY_TELEMETRY_MIN_INTERVAL_MS));
  const lastRunMs = readTelemetryLastRun(projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) return null;
  const lockPath = entryTelemetryProjectLockPath(projectRoot);
  const lock = tryAcquireSyncLock(lockPath);
  if (!lock) return null;
  try {
    const lockedLastRunMs = readTelemetryLastRun(projectRoot);
    if (lockedLastRunMs !== null && now.getTime() - lockedLastRunMs < minIntervalMs) return null;
    const result = mergeEntryTelemetry({ ...options, now });
    if (result.error === "entry_telemetry_lock_contention") return null;
    writeTelemetryLastRun(projectRoot, now, result.ok ? "ok" : "error");
    return result;
  } finally {
    releaseSyncLock(lockPath, lock);
  }
}

/** Read telemetry rows, optionally scoped to one project. Read-only consumer API. */
export function readEntryTelemetry(projectRoot?: string): EntryTelemetryRow[] {
  const rows = readAllRows();
  if (!projectRoot) return rows;
  const normalized = normalizeProjectRoot(projectRoot);
  return rows.filter((r) => r.project_root === normalized);
}

/** Look up one entry's telemetry row (executor / aggregator-feed read path). */
export function getEntryTelemetry(projectRoot: string, slug: string): EntryTelemetryRow | undefined {
  const normalized = normalizeProjectRoot(projectRoot);
  if (!normalized || !slug) return undefined;
  return readAllRows().find((r) => r.project_root === normalized && r.slug === slug);
}

/** ADR 0031 Phase 3(M4/M5 executor 专用): 写 per-entry hysteresis(cooldown/holdout/
 *  last_proposed_at)防振荡。**复用本文件全局锁 + RMW**(opus M4/M5 P0-2: 与
 *  mergeEntryTelemetry 共一把锁, 否则 cooldown 被 carry 旧值覆盖 = lost-update → 振荡)。
 *  只改 executor-owned 三字段, preserve 其余 derived。row 不存 → 建 minimal。 */
export function setEntryHysteresis(
  projectRoot: string,
  slug: string,
  fields: { proposal_cooldown_until?: string; holdout_until?: string; last_proposed_at?: string },
  now: Date = new Date(),
): { ok: boolean; error?: string } {
  const pr = normalizeProjectRoot(projectRoot);
  if (!pr || !slug) return { ok: true };
  const lockPath = entryTelemetryGlobalLockPath();
  const lock = tryAcquireSyncLock(lockPath);
  if (!lock) return { ok: false, error: "entry_telemetry_lock_contention" };
  try {
    const existing = new Map<string, EntryTelemetryRow>();
    for (const row of readAllRows()) existing.set(compoundKey(row.project_root, row.slug), row);
    const ck = compoundKey(pr, slug);
    const prev = existing.get(ck);
    const ts = formatLocalIsoTimestamp(now);
    const next: EntryTelemetryRow = prev ? { ...prev } : {
      schema_version: 1, project_root: pr, slug,
      citation_count: 0, total_retrievals: 0, window_days: DEFAULT_WINDOW_DAYS,
      window_decisive: 0, window_confirmatory: 0, window_retrieved_unused: 0,
      window_decisive_streak: 0, window_total_retrievals: 0, possible_echo_chamber: false,
      updated_at: ts,
    };
    if (fields.proposal_cooldown_until !== undefined) next.proposal_cooldown_until = fields.proposal_cooldown_until;
    if (fields.holdout_until !== undefined) next.holdout_until = fields.holdout_until;
    if (fields.last_proposed_at !== undefined) next.last_proposed_at = fields.last_proposed_at;
    next.updated_at = ts;
    existing.set(ck, next);
    const allRows = [...existing.values()]
      .sort((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : compoundKey(a.project_root, a.slug).localeCompare(compoundKey(b.project_root, b.slug))))
      .slice(0, ENTRY_TELEMETRY_MAX_ROWS);
    const file = entryTelemetryPath();
    const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
    atomicWriteText(file, enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    releaseSyncLock(lockPath, lock);
  }
}
