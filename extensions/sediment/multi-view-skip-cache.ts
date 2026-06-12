/**
 * multi-view-skip-cache — ADR 0027 PR-B+ R1 P1-9 — skip-cache for the
 * Pass 1 schema dead-loop.
 *
 * # Problem this addresses (R1 DeepSeek finding)
 *
 * When the classifier (proposer) produces a CuratorDecision with op ∈
 * {update, merge, supersede, delete} and Pass 2 reviewer sides with
 * Pass 1 (verdict=confirm_pass1), `synthesizeFromPass1()` returns null
 * because the Pass 1 schema only carries {op, slug_target, scope,
 * reasoning} — no rich payload (patch / compiled_truth / merge sources).
 * The final_decision becomes
 * `{ op: "skip", reason: "multiview_pass1_op_not_synthesizable" }`.
 *
 * If the same candidate shape (same user context, same classifier
 * inference) recurs across turns — which happens when the user keeps
 * making the same edit, or when the staging-replay loop pulls the
 * same pending entry — multi-view burns 2 reviewer LLM calls each
 * time and skip again. DeepSeek estimated $0.10-0.50/wk cost waste
 * in steady-state usage.
 *
 * # Solution: candidate-shape fingerprint cache
 *
 * After each unsynthesizable-skip outcome, write a fingerprint entry to
 * `~/.abrain/.state/sediment/multi-view-skip-cache.jsonl`. Before
 * invoking multi-view, compute the same fingerprint and check the
 * cache. If hit within TTL, short-circuit to the same skip outcome
 * WITHOUT making reviewer API calls.
 *
 * ## Fingerprint composition
 *
 * Fingerprint = SHA-256 of:
 *   proposer_decision.op + "|" +
 *   slug-or-target-from-proposer + "|" +
 *   candidate.compiledTruth-first-512-chars-normalized
 *
 * Rationale:
 *   - op + slug capture the proposer's intent (what is this candidate
 *     trying to do?)
 *   - compiledTruth prefix captures the user's intent (what content
 *     are we trying to write?)
 *   - Trimming compiledTruth to 512 chars normalizes minor whitespace
 *     variations while keeping enough signal to differentiate distinct
 *     intents
 *
 * ## TTL
 *
 * Default 7 days. After TTL expires, the candidate gets a fresh
 * multi-view run. Worst case: same unsynthesizable candidate → 1
 * multi-view call per 7 days (instead of every agent_end).
 *
 * Conservative: if user re-affirms strongly during the 7 days (which
 * MAY warrant fresh review), we won't re-run multi-view. Acceptable
 * trade-off: the cost of the dead-loop is real; the cost of a 7-day
 * stale skip is lost opportunity but not data corruption.
 *
 * ## Failure mode
 *
 * Cache read/write is best-effort. If the cache file is corrupt or
 * unreadable, multi-view falls through to the normal path (no
 * regression in correctness, just no cost savings).
 *
 * ## What does NOT trigger caching
 *
 *   - Successful multi-view (verdict=confirm_proposer or synthesizable
 *     confirm_pass1): we want this path to remain live, not cached
 *   - Reviewer call failures: those should retry (staging-replay path)
 *   - Pass 2 = defer: those go to multi-view-pending staging
 *
 * Only the SPECIFIC "Pass 2 confirm_pass1, Pass 1 unsynthesizable" path
 * caches. This is the singular known dead-loop signature.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ensureUserGlobalSidecarMigrated, userGlobalSedimentDir } from "../_shared/runtime";
import type { CuratorDecision } from "./curator";
import type { ProjectEntryDraft } from "./writer";

const CACHE_FILE = "multi-view-skip-cache.jsonl";
// ADR 0024 §7.6 过渡态机械门注记 (PR-B1 2026-06-12): 成本/死循环兜底的 TTL 状态机，
// 作用于 LLM 调度频率。移除条件：ADR 0025 §4.4.6 P1.5 Pass-1 schema 升级后
// not-synthesizable 死循环消失（watchdog pass1_op_not_synthesizable_count
// 持续为 0 一个季度）→ 可删本 cache。
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COMPILED_TRUTH_FINGERPRINT_LEN = 512;
const TAIL_READ_BYTES = 1 * 1024 * 1024; // 1MB; cache should never approach this
const MAX_ROWS_KEEP = 5_000;             // ring-buffer cap (lazy on write)

export interface SkipCacheEntry {
  /** SHA-256 hex digest of the fingerprint input. */
  fingerprint: string;
  /** Timestamp this entry was written. */
  ts: string;
  /** The unsynthesizable Pass 1 op that triggered caching (diagnostic). */
  pass1_op: string;
  /** Optional Pass 1 reasoning snippet (≤200 chars, diagnostic). */
  pass1_reasoning_snippet?: string;
  /** Diagnostic: proposer op + slug at cache time. */
  proposer_op: string;
  proposer_slug?: string;
}

export interface SkipCacheHit {
  hit: true;
  entry: SkipCacheEntry;
  /** ms since cached. */
  age_ms: number;
}

export interface SkipCacheMiss {
  hit: false;
}

export type SkipCacheLookup = SkipCacheHit | SkipCacheMiss;

function cacheFilePath(): string {
  return path.join(userGlobalSedimentDir(), CACHE_FILE);
}

/** Compute fingerprint for a candidate + proposer decision pair.
 *
 *  The fingerprint is stable across runs (same inputs → same hex digest)
 *  but doesn't leak content (hex digest only). Different candidates
 *  produce different fingerprints with extremely low collision rate
 *  (SHA-256 over ~600 bytes of structured input).
 */
export function fingerprintCandidate(
  proposerDecision: CuratorDecision,
  candidate: ProjectEntryDraft,
): string {
  const op = proposerDecision.op;
  // Different ops have different slug-shape fields. Extract the best-
  // available identity.
  let proposerSlug = "";
  switch (op) {
    case "update":
      proposerSlug = (proposerDecision as { slug: string }).slug ?? "";
      break;
    case "archive":
      proposerSlug = (proposerDecision as { slug: string }).slug ?? "";
      break;
    case "delete":
      proposerSlug = (proposerDecision as { slug: string }).slug ?? "";
      break;
    case "supersede": {
      const d = proposerDecision as { oldSlug?: string; newSlug?: string };
      proposerSlug = `${d.oldSlug ?? ""}>${d.newSlug ?? ""}`;
      break;
    }
    case "merge": {
      const d = proposerDecision as { target: string; sources: string[] };
      proposerSlug = `${d.target}<-${[...(d.sources ?? [])].sort().join(",")}`;
      break;
    }
    // create / skip do not produce unsynthesizable Pass 1 outcomes by
    // construction (Pass 1 schema CAN synthesize create + skip + archive).
    // Their fingerprint is still computed for completeness; if somehow
    // included as a cache key, they'll never hit (no entries written).
    default:
      proposerSlug = "";
  }

  // Normalize compiledTruth: strip leading/trailing whitespace, collapse
  // multiple whitespace runs to single space, slice to fixed prefix.
  const ct = (candidate.compiledTruth ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMPILED_TRUTH_FINGERPRINT_LEN);

  const material = `${op}|${proposerSlug}|${ct}`;
  return crypto.createHash("sha256").update(material).digest("hex");
}

/** Read tail of the cache file. Best-effort: corrupt lines silently
 *  skipped (caller doesn't care). */
function readCacheRows(): SkipCacheEntry[] {
  try {
    const file = cacheFilePath();
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    const start = stat.size > TAIL_READ_BYTES ? stat.size - TAIL_READ_BYTES : 0;
    const fd = fs.openSync(file, "r");
    let raw = "";
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    const rows: SkipCacheEntry[] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as SkipCacheEntry;
        if (row && typeof row.fingerprint === "string" && typeof row.ts === "string") {
          rows.push(row);
        }
      } catch {
        // skip corrupt
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** Check whether a fingerprint is in the cache within TTL.
 *
 *  Returns the MOST RECENT matching entry (by ts) so subsequent writes
 *  for the same fingerprint don't return stale data.
 */
export function lookupSkipCache(
  fingerprint: string,
  opts: { now?: number; ttlMs?: number } = {},
): SkipCacheLookup {
  const now = opts.now ?? Date.now();
  const ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_TTL_MS);
  const rows = readCacheRows();
  // Iterate in reverse to find the most recent matching entry first.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.fingerprint !== fingerprint) continue;
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts)) continue;
    const age = now - ts;
    if (age >= 0 && age < ttlMs) {
      return { hit: true, entry: row, age_ms: age };
    }
    // entry expired — keep looking? Since rows are in ts order on
    // disk, an expired hit means all earlier matches are also expired.
    return { hit: false };
  }
  return { hit: false };
}

/** Append a skip-cache entry. Lazy ring-buffer trimming: when file
 *  exceeds MAX_ROWS_KEEP, the tail-read window already truncates.
 *  Pruning of expired entries is done via a manual `pruneExpired()` call
 *  (not on every append — keep writes hot-path-cheap).
 */
export function writeSkipCacheEntry(entry: SkipCacheEntry): void {
  try {
    ensureUserGlobalSidecarMigrated();
    const dir = userGlobalSedimentDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(cacheFilePath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // best-effort; cache failure doesn't break multi-view
  }
}

/** Prune expired entries from the cache file. Best-effort; if rewrite
 *  fails (e.g., disk full), the cache continues to grow until next
 *  successful prune. Tail-read window naturally caps lookups.
 *
 *  Callers: invoke periodically (e.g., from aggregator daily run).
 */
export function pruneExpiredSkipCache(opts: { now?: number; ttlMs?: number } = {}): {
  removed: number;
  kept: number;
} {
  const now = opts.now ?? Date.now();
  const ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_TTL_MS);
  try {
    const rows = readCacheRows();
    const kept: SkipCacheEntry[] = [];
    for (const row of rows) {
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts)) continue;
      if (now - ts < ttlMs) kept.push(row);
    }
    // Cap kept set at MAX_ROWS_KEEP (newest wins).
    const finalKept = kept.length > MAX_ROWS_KEEP ? kept.slice(-MAX_ROWS_KEEP) : kept;
    fs.writeFileSync(
      cacheFilePath(),
      finalKept.map((r) => JSON.stringify(r)).join("\n") + (finalKept.length > 0 ? "\n" : ""),
      "utf-8",
    );
    return { removed: rows.length - finalKept.length, kept: finalKept.length };
  } catch {
    return { removed: 0, kept: 0 };
  }
}

/** Test-only: directly read all cache rows for inspection. */
export function _readSkipCacheForTests(): SkipCacheEntry[] {
  return readCacheRows();
}

/** Test-only: clear the cache file. */
export function _clearSkipCacheForTests(): void {
  try {
    const file = cacheFilePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

export const SKIP_CACHE_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
