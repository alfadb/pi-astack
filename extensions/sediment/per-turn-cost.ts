/**
 * per-turn-cost — ADR 0027 PR-B+ R1 P1-12 — per-turn brain-maintenance
 * cost / token attribution rollup.
 *
 * # What this does
 *
 * Scans all anchor-bearing JSONL sidecars (sediment audit, extractor
 * metrics, curator metrics, multi-view metrics, memory search metrics,
 * dispatch audit) and groups by `(session_id, turn_id)`. Returns per-turn
 * token + operation count rollups so the operator can answer:
 *
 *   - "this user's brain maintenance per turn burns how many tokens?"
 *   - "which turns were unusually expensive (top burners)?"
 *   - "which operation kind dominates cost (extractor vs curator vs multi-view)?"
 *
 * # Why no $/turn cost
 *
 * Cost varies by model and provider. A correct $ calculation needs a
 * model_id → $/1M-tokens table that:
 *   - covers every provider/model the user might use
 *   - stays current as providers reprice (Anthropic / OpenAI / DeepSeek
 *     all reprice on different schedules)
 *   - distinguishes input vs output vs cache-read vs cache-write
 *
 * For P1-12 v1, surface TOKEN COUNTS only — anyone wanting cost can
 * apply their own current pricing externally. Future P2 can add a
 * settings-configurable price table.
 *
 * # Data sources
 *
 * Sidecar              | tokens fields                       | op kind
 * ---------------------|-------------------------------------|------------
 * sediment audit       | tokens_in (some rows), stage_ms     | (various)
 * extractor-metrics    | estimatedTokens                     | extractor
 * curator-metrics      | estimatedTokens                     | curator
 * multi-view-metrics   | (no token field yet — counts only)  | multi_view
 * memory search-metrics| (no token field yet — counts only)  | memory_search
 * dispatch audit       | tokens_in, tokens_out               | dispatch
 *
 * Per-turn rollup is best-effort. Missing token fields show as 0; missing
 * anchor fields cause the row to be skipped (unattributable).
 *
 * # Used by
 *
 * aggregator.ts includes the rollup in AggregatorSummary; the existing
 * aggregator-ledger.jsonl carries it. No new sidecar; uses the same
 * publication path as the rest of the daily aggregator output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  memorySearchMetricsPath,
  sedimentAuditPath,
  userGlobalSedimentDir,
  dispatchAuditPath,
} from "../_shared/runtime";

const TAIL_BYTES = 5 * 1024 * 1024; // 5 MB tail read cap per file
const DEFAULT_ROW_LIMIT = 20_000;   // per file; sums across files = upper bound
const DEFAULT_TOP_BURNERS = 5;
const DEFAULT_HISTOGRAM_BUCKETS: number[] = [
  // token-spend buckets for distribution insight (10/100/1k/10k/100k/inf)
  10, 100, 1_000, 10_000, 100_000,
];

/** Per-(session_id, turn_id) aggregation. */
export interface PerTurnCostRow {
  session_id: string;
  turn_id: number;
  device_id?: string;
  /** Earliest timestamp seen across any row contributing to this turn. */
  first_seen: string;
  /** Latest timestamp seen across any row contributing to this turn. */
  last_seen: string;
  /** Per-operation row counts. Keys include: extractor, curator,
   *  multi_view, memory_search, dispatch, sediment_audit, etc. */
  operations: Record<string, number>;
  /** Sum of explicit tokens_in (where rows have it; mostly dispatch). */
  tokens_in: number;
  /** Sum of explicit tokens_out (where rows have it; mostly dispatch). */
  tokens_out: number;
  /** Sum of estimatedTokens (where rows have it; extractor + curator). */
  estimated_tokens: number;
  /** Subturn count for this turn (sub-agent dispatch fanout). */
  subturn_count: number;
  /** Total rows scanned across all sidecars that contributed to this turn. */
  row_count: number;
}

export interface PerTurnCostSummary {
  /** Rows that had a complete (session_id, turn_id) anchor. */
  rows_attributed: number;
  /** Rows missing anchor (couldn't bucket — diagnostic for C6 completeness). */
  rows_unattributed: number;
  /** Distinct (session_id, turn_id) keys observed. */
  turns_considered: number;
  /** Distribution of estimated_tokens across turns (count per bucket).
   *  Buckets: [0,10), [10,100), [100,1k), [1k,10k), [10k,100k), [100k,∞).
   *  Useful for "is brain maintenance ~10k tokens/turn or 100k+?" insight. */
  estimated_tokens_histogram: number[];
  /** Top N turns by total tokens (tokens_in + tokens_out + estimated_tokens). */
  top_burners: Array<{
    session_id: string;
    turn_id: number;
    total: number;
    operations: Record<string, number>;
  }>;
  /** Aggregate totals across all attributable rows. */
  totals: {
    tokens_in: number;
    tokens_out: number;
    estimated_tokens: number;
    operations: Record<string, number>;
  };
  /** Operation-kind contribution to estimated_tokens (cost-attribution view). */
  estimated_tokens_by_operation: Record<string, number>;
}

interface ScanOptions {
  /** Project root for filesystem paths. */
  projectRoot: string;
  /** Cutoff timestamp (epoch ms) — rows older than this are skipped. */
  cutoffMs: number;
  /** Per-file row limit (defends against unbounded growth). */
  rowLimit?: number;
  /** Top-N burner limit. */
  topN?: number;
}

interface RawRow {
  session_id?: unknown;
  turn_id?: unknown;
  subturn?: unknown;
  device_id?: unknown;
  timestamp?: unknown;
  ts?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  estimatedTokens?: unknown;
  operation?: unknown;
}

/** Read tail of a JSONL file, returning parsed rows. Best-effort: corrupt
 *  lines silently skipped (caller doesn't care about parse health here —
 *  audit/health.ts handles that). */
function readJsonlTail(filePath: string, rowLimit: number): RawRow[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = stat.size > TAIL_BYTES ? stat.size - TAIL_BYTES : 0;
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
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    const tail = lines.length > rowLimit ? lines.slice(-rowLimit) : lines;
    const out: RawRow[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as RawRow);
      } catch {
        // skip corrupt
      }
    }
    return out;
  } catch {
    return [];
  }
}

function rowTs(row: RawRow): string | undefined {
  const v = typeof row.ts === "string" ? row.ts : (typeof row.timestamp === "string" ? row.timestamp : undefined);
  return v;
}

function inWindow(row: RawRow, cutoffMs: number): boolean {
  const v = rowTs(row);
  if (!v) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms >= cutoffMs;
}

function asInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function bucketIndex(total: number, buckets: number[]): number {
  for (let i = 0; i < buckets.length; i++) {
    if (total < buckets[i]) return i;
  }
  return buckets.length; // overflow bucket [last,∞)
}

/**
 * Scan all anchor-bearing sidecars and produce per-turn cost rollup.
 *
 * # Operation taxonomy
 *
 * Each row's "operation" is derived from its source file (since not all
 * rows have explicit operation fields):
 *
 *   - sediment audit row → operation field if present, else "sediment_other"
 *   - extractor-metrics → "extractor"
 *   - curator-metrics → "curator"
 *   - multi-view-metrics → "multi_view"
 *   - memory search-metrics → "memory_search"
 *   - dispatch audit row → operation field (dispatch_agent / dispatch_parallel.task)
 */
export function scanPerTurnCost(opts: ScanOptions): PerTurnCostSummary {
  const rowLimit = Math.max(100, Math.floor(opts.rowLimit ?? DEFAULT_ROW_LIMIT));
  const topN = Math.max(1, Math.floor(opts.topN ?? DEFAULT_TOP_BURNERS));

  // Source files. Each tagged with default op kind (when row has no operation field).
  const sidecarRoot = userGlobalSedimentDir();
  const sources: Array<{ file: string; defaultOp: string }> = [
    { file: sedimentAuditPath(opts.projectRoot), defaultOp: "sediment_other" },
    { file: path.join(sidecarRoot, "extractor-metrics.jsonl"), defaultOp: "extractor" },
    { file: path.join(sidecarRoot, "curator-metrics.jsonl"), defaultOp: "curator" },
    { file: path.join(sidecarRoot, "multi-view-metrics.jsonl"), defaultOp: "multi_view" },
    { file: memorySearchMetricsPath(opts.projectRoot), defaultOp: "memory_search" },
    { file: dispatchAuditPath(opts.projectRoot), defaultOp: "dispatch_other" },
  ];

  // Bucket map: key = `${session_id}|${turn_id}` (subturn folds into parent turn for cost view)
  const turns = new Map<string, PerTurnCostRow>();
  let attributedTotal = 0;
  let unattributedTotal = 0;

  for (const { file, defaultOp } of sources) {
    const rows = readJsonlTail(file, rowLimit);
    for (const row of rows) {
      if (!inWindow(row, opts.cutoffMs)) continue;
      const sid = asString(row.session_id);
      const tid = asInt(row.turn_id);
      // turn_id=0 is legitimate (first turn) — check by membership not truthiness
      if (!sid || typeof row.turn_id !== "number") {
        unattributedTotal++;
        continue;
      }
      attributedTotal++;
      const key = `${sid}|${tid}`;
      let bucket = turns.get(key);
      if (!bucket) {
        bucket = {
          session_id: sid,
          turn_id: tid,
          device_id: asString(row.device_id),
          first_seen: rowTs(row) ?? "",
          last_seen: rowTs(row) ?? "",
          operations: {},
          tokens_in: 0,
          tokens_out: 0,
          estimated_tokens: 0,
          subturn_count: 0,
          row_count: 0,
        };
        turns.set(key, bucket);
      }
      const ts = rowTs(row);
      if (ts) {
        if (!bucket.first_seen || ts < bucket.first_seen) bucket.first_seen = ts;
        if (!bucket.last_seen || ts > bucket.last_seen) bucket.last_seen = ts;
      }
      const op = asString(row.operation) ?? defaultOp;
      bucket.operations[op] = (bucket.operations[op] ?? 0) + 1;
      bucket.tokens_in += asInt(row.tokens_in);
      bucket.tokens_out += asInt(row.tokens_out);
      bucket.estimated_tokens += asInt(row.estimatedTokens);
      if (typeof row.subturn === "number") {
        // Track distinct subturn ids; rough count via max-seen (not a Set
        // because subturn is dense 1..N per ADR 0027 C6 derivation).
        if (row.subturn > bucket.subturn_count) bucket.subturn_count = row.subturn;
      }
      bucket.row_count++;
    }
  }

  // Build distribution + top burners.
  const histogram = Array.from({ length: DEFAULT_HISTOGRAM_BUCKETS.length + 1 }, () => 0);
  const allTurns = Array.from(turns.values());
  for (const t of allTurns) {
    histogram[bucketIndex(t.estimated_tokens, DEFAULT_HISTOGRAM_BUCKETS)]++;
  }
  const sortedByTotal = allTurns
    .map((t) => ({
      session_id: t.session_id,
      turn_id: t.turn_id,
      total: t.tokens_in + t.tokens_out + t.estimated_tokens,
      operations: t.operations,
    }))
    .sort((a, b) => b.total - a.total);
  const topBurners = sortedByTotal.slice(0, topN);

  // Aggregate totals + per-operation breakdown.
  let totalIn = 0;
  let totalOut = 0;
  let totalEst = 0;
  const totalOps: Record<string, number> = {};
  const estByOp: Record<string, number> = {};
  for (const t of allTurns) {
    totalIn += t.tokens_in;
    totalOut += t.tokens_out;
    totalEst += t.estimated_tokens;
    for (const [op, count] of Object.entries(t.operations)) {
      totalOps[op] = (totalOps[op] ?? 0) + count;
    }
    // Distribute t.estimated_tokens proportionally across its operation
    // count? Not really meaningful for mixed-op turns. Better: only count
    // estimated_tokens for the op that emitted them (extractor/curator).
    // Since we lost source attribution by the time we aggregate, we
    // approximate: if turn has extractor ops, attribute proportionally;
    // else if curator; else "other". This is a soft attribution.
    const hasExt = (t.operations.extractor ?? 0) > 0;
    const hasCur = (t.operations.curator ?? 0) > 0;
    if (hasExt && hasCur) {
      // Split 50/50 — both contributed
      estByOp.extractor = (estByOp.extractor ?? 0) + Math.floor(t.estimated_tokens / 2);
      estByOp.curator = (estByOp.curator ?? 0) + Math.ceil(t.estimated_tokens / 2);
    } else if (hasExt) {
      estByOp.extractor = (estByOp.extractor ?? 0) + t.estimated_tokens;
    } else if (hasCur) {
      estByOp.curator = (estByOp.curator ?? 0) + t.estimated_tokens;
    } else if (t.estimated_tokens > 0) {
      estByOp.other = (estByOp.other ?? 0) + t.estimated_tokens;
    }
  }

  return {
    rows_attributed: attributedTotal,
    rows_unattributed: unattributedTotal,
    turns_considered: turns.size,
    estimated_tokens_histogram: histogram,
    top_burners: topBurners,
    totals: {
      tokens_in: totalIn,
      tokens_out: totalOut,
      estimated_tokens: totalEst,
      operations: totalOps,
    },
    estimated_tokens_by_operation: estByOp,
  };
}

/** Histogram bucket boundaries for human display. Exported for callers
 *  that want to label the histogram array. */
export const PER_TURN_HISTOGRAM_BUCKETS: ReadonlyArray<number> = DEFAULT_HISTOGRAM_BUCKETS;
