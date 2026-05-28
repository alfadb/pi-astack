/**
 * sediment aggregator — ADR 0025 §4.3 skeptical-historian MVP.
 *
 * This module is deterministic + advisory in v0.2.  It closes the first
 * read-side feedback loop by summarizing already-accumulating signals
 * (audit.jsonl, outcome-ledger.jsonl, staging files, classifier health)
 * into a stable JSONL sidecar.  It does NOT write memory entries, gate the
 * writer, ask the user for decisions, or change confidence/status directly.
 * Later prompt-native aggregator passes can consume these rows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  memorySearchMetricsPath,
  sedimentAuditPath,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import type { SedimentSettings } from "./settings";
import { buildPromptVersionAudit } from "./settings";
import { summarizeClassifierHealth, type ClassifierHealthSummary } from "./health";
import type { LedgerOutcomeRow } from "./outcome-collector";
import { stagingDir, stagingFileCount } from "./staging-loader";
import { countMultiviewPending } from "./multiview-staging-io";
import { scanPerTurnCost, type PerTurnCostSummary } from "./per-turn-cost";

type AggregatorSeverity = "info" | "warning" | "critical";
type AdvisoryKind =
  | "classifier_health"
  | "outcome_entry"
  | "staging_backlog"
  | "multiview_pending"
  | "audit_error_rate"
  | "search_activity";

/**
 * Phase C.1.a (ADR 0025 §4.3 prompt-native v1 wiring):
 *
 * `STRUCTURAL_CONTEXT` is the hardcoded list of known-unimplemented
 * capabilities whose absence causes structural mechanical advisories
 * every run. The aggregator v1 LLM prompt (§2 item 4) consumes this
 * list so the skeptical historian can demote recurring noise instead
 * of re-discovering them. Maintenance contract per the v1 prompt
 * "Staleness notice" (D4): when staging-resolver / archive-reactivation
 * reviewer / P1.5 writer dispatch ship, the corresponding entry MUST
 * be removed in the same commit, and Phase D regression should verify
 * the related mechanical advisory shape has changed.
 */
export interface StructuralContextEntry {
  /** Stable id matching prompt expectations. */
  id: string;
  /** What is unimplemented + ADR section anchor. */
  description: string;
  /** Which mechanical AdvisoryKind it causes. */
  causes_advisory: AdvisoryKind;
}

export const STRUCTURAL_CONTEXT: ReadonlyArray<StructuralContextEntry> = [
  {
    id: "staging-resolver-unimplemented",
    description:
      "ADR 0025 §4.1.5.1 staging-resolver NOT implemented — provisional staging entries are only consumed lazily by classifier step 6. Expect staging_backlog mechanical hit every run until staging-resolver ships.",
    causes_advisory: "staging_backlog",
  },
  {
    id: "archive-reactivation-reviewer-unimplemented",
    description:
      "ADR 0025 §4.6 archive-reactivation-reviewer prompt NOT implemented — archived entries cannot reactivate via prompt-driven review. Affects long-term archive churn signals; no mechanical advisory kind yet.",
    causes_advisory: "outcome_entry",
  },
  {
    id: "p15-writer-dispatch-stub",
    description:
      "ADR 0025 §4.4.6 multi-view replay writer dispatch is a v1 stub — reviewer-approved replays may not actually write to brain. Expect multiview_pending count fluctuation until P1.5 writer dispatch fully ships.",
    causes_advisory: "multiview_pending",
  },
];

/**
 * Phase C.1.a: `RawDistributionSummary` provides the non-flagged
 * population context required by ADR 0025 §4.3 consensus C9. Without
 * it, the LLM only sees the 8 mechanical threshold hits and the
 * thresholds act as an invisible attention filter. This summary tells
 * the LLM "what does the FULL outcome distribution look like" so it
 * can apply Step 4 reverse-anchor sweep on the silent majority.
 */
export interface RawDistributionSummary {
  /** Total distinct slugs seen in the outcome window. */
  total_slugs: number;
  /** Slugs that did NOT trip any mechanical threshold. */
  non_flagged_slugs: number;
  /** Median / max / mean retrieved-unused counts across ALL slugs
   *  (including flagged), so the LLM can read "is 11 actually high?" */
  retrieved_unused_distribution: {
    min: number;
    median: number;
    p75: number;
    max: number;
    mean: number;
  };
  /** Same for decisive counts. */
  decisive_distribution: {
    min: number;
    median: number;
    p75: number;
    max: number;
    mean: number;
  };
  /** How many slugs have at least one footnote in the window. */
  slugs_with_any_footnote: number;
  /** How many slugs have zero footnotes (retrieved only via tool-result). */
  slugs_with_only_tool_result: number;
}

export interface AggregatorAdvisory {
  kind: AdvisoryKind;
  severity: AggregatorSeverity;
  message: string;
  slug?: string;
  evidence?: Record<string, unknown>;
}

export interface AggregatorSummary {
  ok: boolean;
  ts: string;
  session_id?: string;
  project_root: string;
  prompt_version?: Record<string, string>;
  window_days: number;
  audit: {
    rows_considered: number;
    recent_rows: number;
    rows_missing_timestamp: number;
    corrupt_rows: number;
    operations: Record<string, number>;
    skip_reasons: Record<string, number>;
    error_like_count: number;
  };
  outcome: {
    rows_considered: number;
    window_rows: number;
    slugs_seen: number;
    high_unused: Array<{ slug: string; retrieved_unused_count: number; total_retrievals: number; decisive_count: number; last_seen?: string }>;
    echo_chamber_candidates: Array<{ slug: string; decisive_streak: number; decisive_count: number; last_seen?: string }>;
  };
  staging: {
    total_files: number;
    provisional_pending: number;
    provisional_stale: number;
    multiview_pending: number;
  };
  search: {
    metrics_rows: number;
    recent_rows: number;
    total_results: number;
    zero_result_count: number;
  };
  classifier_health?: ClassifierHealthSummary;
  /** Phase C.1.a (ADR 0025 §4.3 v1 prompt input C9): raw distribution
   *  of all slug counts so the LLM sees the population, not just the
   *  threshold-tripped subset. Optional for backward compatibility:
   *  v0.2 aggregator-ledger.jsonl rows do not have this field. */
  raw_distribution?: RawDistributionSummary;
  /** Phase C.1.a (ADR 0025 §4.3 v1 prompt input D4): hardcoded list of
   *  known-unimplemented capabilities. Snapshot of STRUCTURAL_CONTEXT
   *  at run time — makes the run self-describing (a future replay can
   *  see what the LLM knew about structural noise sources). Optional
   *  for backward compatibility. */
  structural_context?: ReadonlyArray<StructuralContextEntry>;
  /** ADR 0027 PR-B+ R1 P1-12: per-turn token-spend rollup across all
   *  anchor-bearing sidecars. Lets the operator answer "this user's
   *  brain maintenance per turn burns how many tokens?" + "which turns
   *  / which operation kind dominates spend?". Cost ($) not computed in
   *  v1 — only token counts — because $/M-tokens varies by model and
   *  provider; users can apply current pricing externally. See
   *  per-turn-cost.ts for the data sources and op-kind taxonomy. */
  per_turn_cost: PerTurnCostSummary;
  advisories: AggregatorAdvisory[];
}

export interface RunAggregatorOptions {
  projectRoot: string;
  settings: SedimentSettings;
  sessionId?: string;
  windowDays?: number;
  auditRowLimit?: number;
  outcomeRowLimit?: number;
  searchMetricsRowLimit?: number;
  now?: Date;
}

interface ParsedJsonl<T = Record<string, unknown>> {
  rows: T[];
  corrupt: number;
}

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_AUDIT_ROW_LIMIT = 500;
const DEFAULT_SEARCH_METRICS_ROW_LIMIT = 500;
const DEFAULT_OUTCOME_ROW_LIMIT = 2_000;
const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEDGER_MAX_ROWS = 1_000;
const LEDGER_TAIL_READ_BYTES = 2 * 1024 * 1024;
const JSONL_TAIL_READ_BYTES = 2 * 1024 * 1024;
const HIGH_UNUSED_THRESHOLD = 3;
const HIGH_UNUSED_MIN_RATIO = 0.6;
const STAGING_WARNING_THRESHOLD = 20;
const STAGING_CRITICAL_THRESHOLD = 50;

function readJsonl<T = Record<string, unknown>>(filePath: string, maxRows?: number, maxBytes: number = JSONL_TAIL_READ_BYTES): ParsedJsonl<T> {
  try {
    if (!fs.existsSync(filePath)) return { rows: [], corrupt: 0 };
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
    // If we started mid-file, discard the first partial line so corrupt
    // accounting reflects real JSONL corruption, not our tail read window.
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const selected = maxRows && lines.length > maxRows ? lines.slice(-maxRows) : lines;
    const parsed: T[] = [];
    let corrupt = 0;
    for (const line of selected) {
      try {
        parsed.push(JSON.parse(line) as T);
      } catch {
        corrupt++;
      }
    }
    return { rows: parsed, corrupt };
  } catch {
    return { rows: [], corrupt: 0 };
  }
}

function countBy(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = typeof row[key] === "string" && row[key] ? row[key] as string : "(missing)";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function isErrorLikeAuditRow(row: Record<string, unknown>): boolean {
  const operation = typeof row.operation === "string" ? row.operation : "";
  const reason = typeof row.reason === "string" ? row.reason : "";
  const ok = row.ok;
  if (ok === false) return true;
  if (operation.includes("error") || operation.includes("failure")) return true;
  if (reason.includes("error") || reason.includes("failed") || reason.includes("threw")) return true;
  if ("error" in row || "validationErrors" in row || "lintErrors" in row) return true;
  return false;
}

function inWindow(ts: unknown, cutoffMs: number): boolean {
  if (typeof ts !== "string") return false;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms >= cutoffMs;
}

function rowTimestamp(row: Record<string, unknown>): unknown {
  return row.timestamp ?? row.ts;
}

function summarizeAudit(projectRoot: string, cutoffMs: number, rowLimit: number): AggregatorSummary["audit"] {
  const { rows, corrupt } = readJsonl<Record<string, unknown>>(sedimentAuditPath(projectRoot), rowLimit);
  const rowsMissingTimestamp = rows.filter((row) => typeof rowTimestamp(row) !== "string").length;
  const recentRows = rows.filter((row) => inWindow(rowTimestamp(row), cutoffMs));
  const operations = countBy(recentRows, "operation");
  const skipRows = recentRows.filter((row) => row.operation === "skip");
  const skipReasons = countBy(skipRows, "reason");
  const errorLike = recentRows.filter(isErrorLikeAuditRow).length + corrupt;
  return {
    rows_considered: rows.length,
    recent_rows: recentRows.length,
    rows_missing_timestamp: rowsMissingTimestamp,
    corrupt_rows: corrupt,
    operations,
    skip_reasons: skipReasons,
    error_like_count: errorLike,
  };
}

function normalizeProjectRoot(value: unknown): string {
  return typeof value === "string" && value.trim() ? path.resolve(value) : "";
}

function readProjectOutcomeRows(projectRoot: string, rowLimit: number): LedgerOutcomeRow[] {
  const file = path.join(userGlobalSedimentDir(), "outcome-ledger.jsonl");
  const { rows } = readJsonl<LedgerOutcomeRow>(file, rowLimit);
  const normalizedProjectRoot = path.resolve(projectRoot);
  return rows.filter((row) => normalizeProjectRoot(row.project_root) === normalizedProjectRoot);
}

function summarizeOutcomes(rows: LedgerOutcomeRow[], cutoffMs: number): AggregatorSummary["outcome"] {
  const windowRows = rows.filter((row) => inWindow(row.ts, cutoffMs));
  const bySlug = new Map<string, {
    slug: string;
    decisive_count: number;
    confirmatory_count: number;
    retrieved_unused_count: number;
    total_retrievals: number;
    last_seen?: string;
    footnotes: LedgerOutcomeRow[];
  }>();

  for (const row of windowRows) {
    const slug = row.entry_slug;
    if (!slug) continue;
    const stats = bySlug.get(slug) ?? {
      slug,
      decisive_count: 0,
      confirmatory_count: 0,
      retrieved_unused_count: 0,
      total_retrievals: 0,
      footnotes: [],
    };
    if (row.source === "tool-result") stats.total_retrievals += row.retrieval_count ?? 1;
    if (row.source === "memory-footnote" && row.used) {
      stats.footnotes.push(row);
      if (row.used === "decisive") stats.decisive_count++;
      else if (row.used === "confirmatory") stats.confirmatory_count++;
      else if (row.used === "retrieved-unused") stats.retrieved_unused_count++;
    }
    if (!stats.last_seen || row.ts > stats.last_seen) stats.last_seen = row.ts;
    bySlug.set(slug, stats);
  }

  const highUnused: AggregatorSummary["outcome"]["high_unused"] = [];
  const echo: AggregatorSummary["outcome"]["echo_chamber_candidates"] = [];
  for (const stats of bySlug.values()) {
    const footnoteTotal = stats.decisive_count + stats.confirmatory_count + stats.retrieved_unused_count;
    const unusedRatio = footnoteTotal > 0 ? stats.retrieved_unused_count / footnoteTotal : 0;
    if (stats.retrieved_unused_count >= HIGH_UNUSED_THRESHOLD && unusedRatio >= HIGH_UNUSED_MIN_RATIO) {
      highUnused.push({
        slug: stats.slug,
        retrieved_unused_count: stats.retrieved_unused_count,
        total_retrievals: stats.total_retrievals,
        decisive_count: stats.decisive_count,
        ...(stats.last_seen ? { last_seen: stats.last_seen } : {}),
      });
    }

    const orderedFootnotes = stats.footnotes.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let streak = 0;
    for (let i = orderedFootnotes.length - 1; i >= 0; i--) {
      if (orderedFootnotes[i].used !== "decisive") break;
      streak++;
    }
    if (streak >= 5) {
      echo.push({
        slug: stats.slug,
        decisive_streak: streak,
        decisive_count: stats.decisive_count,
        ...(stats.last_seen ? { last_seen: stats.last_seen } : {}),
      });
    }
  }

  highUnused.sort((a, b) => b.retrieved_unused_count - a.retrieved_unused_count || a.slug.localeCompare(b.slug));
  echo.sort((a, b) => b.decisive_streak - a.decisive_streak || a.slug.localeCompare(b.slug));

  return {
    rows_considered: rows.length,
    window_rows: windowRows.length,
    slugs_seen: bySlug.size,
    high_unused: highUnused.slice(0, 10),
    echo_chamber_candidates: echo.slice(0, 10),
  };
}

/**
 * Phase C.1.a (ADR 0025 §4.3 v1 prompt input C9): compute the full
 * non-flagged distribution shape across all outcome window slugs.
 *
 * Re-walks the outcome rows (instead of sharing state with
 * `summarizeOutcomes`) to keep this function safe to add as an opt-in
 * v1 enhancement without touching the v0.2 mechanical path. The extra
 * pass is O(n) over outcome rows, identical complexity to
 * `summarizeOutcomes` — cost is negligible at current scales
 * (374 rows in Phase A baseline).
 *
 * `flaggedSlugs` is the set of slugs already surfaced via
 * `summarizeOutcomes.high_unused` + `echo_chamber_candidates`; we
 * compute non_flagged_slugs by subtracting that set from the universe.
 */
function buildRawDistributionSummary(
  rows: LedgerOutcomeRow[],
  cutoffMs: number,
  flaggedSlugs: ReadonlySet<string>,
): RawDistributionSummary {
  const bySlug = new Map<string, { retrieved_unused: number; decisive: number; footnoteCount: number; toolResultCount: number }>();
  for (const row of rows) {
    if (!inWindow(row.ts, cutoffMs)) continue;
    const slug = row.entry_slug;
    if (!slug) continue;
    const stats = bySlug.get(slug) ?? { retrieved_unused: 0, decisive: 0, footnoteCount: 0, toolResultCount: 0 };
    if (row.source === "memory-footnote" && row.used) {
      stats.footnoteCount++;
      if (row.used === "retrieved-unused") stats.retrieved_unused++;
      else if (row.used === "decisive") stats.decisive++;
    } else if (row.source === "tool-result") {
      stats.toolResultCount++;
    }
    bySlug.set(slug, stats);
  }

  const totalSlugs = bySlug.size;
  let nonFlagged = 0;
  let withFootnote = 0;
  let toolResultOnly = 0;
  const retrievedUnusedVals: number[] = [];
  const decisiveVals: number[] = [];

  for (const [slug, stats] of bySlug) {
    if (!flaggedSlugs.has(slug)) nonFlagged++;
    if (stats.footnoteCount > 0) withFootnote++;
    else if (stats.toolResultCount > 0) toolResultOnly++;
    retrievedUnusedVals.push(stats.retrieved_unused);
    decisiveVals.push(stats.decisive);
  }

  return {
    total_slugs: totalSlugs,
    non_flagged_slugs: nonFlagged,
    slugs_with_any_footnote: withFootnote,
    slugs_with_only_tool_result: toolResultOnly,
    retrieved_unused_distribution: computeDistribution(retrievedUnusedVals),
    decisive_distribution: computeDistribution(decisiveVals),
  };
}

function computeDistribution(values: number[]): RawDistributionSummary["retrieved_unused_distribution"] {
  if (values.length === 0) return { min: 0, median: 0, p75: 0, max: 0, mean: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pick = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
    return sorted[idx];
  };
  return {
    min: sorted[0],
    median: pick(0.5),
    p75: pick(0.75),
    max: sorted[sorted.length - 1],
    mean: Math.round((sum / sorted.length) * 100) / 100,
  };
}

function summarizeStaging(now: Date): AggregatorSummary["staging"] {
  let provisionalPending = 0;
  let provisionalStale = 0;
  const staleCutoffMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  try {
    const dir = stagingDir();
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
          const entry = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).entry : undefined;
          if (!entry || typeof entry !== "object") continue;
          const e = entry as Record<string, unknown>;
          if (e.kind !== "provisional-correction" || e.attribution_pending !== true) continue;
          provisionalPending++;
          const createdMs = typeof e.created === "string" ? Date.parse(e.created) : NaN;
          if (Number.isFinite(createdMs) && createdMs < staleCutoffMs) provisionalStale++;
        } catch {
          // Corrupt staging files are ignored here; the detailed staging
          // loaders/replay routines own per-file diagnostics.
        }
      }
    }
  } catch {
    // best-effort advisory
  }
  return {
    total_files: stagingFileCount(),
    provisional_pending: provisionalPending,
    provisional_stale: provisionalStale,
    multiview_pending: countMultiviewPending(),
  };
}

function summarizeSearch(projectRoot: string, cutoffMs: number, rowLimit: number): AggregatorSummary["search"] {
  const { rows } = readJsonl<Record<string, unknown>>(memorySearchMetricsPath(projectRoot), rowLimit);
  const recentRows = rows.filter((row) => inWindow(row.ts, cutoffMs));
  let totalResults = 0;
  let zeroResultCount = 0;
  for (const row of recentRows) {
    const results = typeof row.results === "number" && Number.isFinite(row.results) ? row.results : 0;
    totalResults += results;
    if (results === 0) zeroResultCount++;
  }
  return {
    metrics_rows: rows.length,
    recent_rows: recentRows.length,
    total_results: totalResults,
    zero_result_count: zeroResultCount,
  };
}

function buildAdvisories(summary: Omit<AggregatorSummary, "ok" | "advisories">): AggregatorAdvisory[] {
  const advisories: AggregatorAdvisory[] = [];

  if (summary.classifier_health && !summary.classifier_health.ok) {
    advisories.push({
      kind: "classifier_health",
      severity: "warning",
      message: `Classifier reasoning surface looks weak: ${summary.classifier_health.advisories.join(" ")}`,
      evidence: {
        sample_size: summary.classifier_health.sampleSize,
        quote_rate: Number(summary.classifier_health.quoteRate.toFixed(3)),
        alternative_rate: Number(summary.classifier_health.alternativeRate.toFixed(3)),
        concrete_self_critique_rate: Number(summary.classifier_health.concreteSelfCritiqueRate.toFixed(3)),
      },
    });
  }

  for (const entry of summary.outcome.high_unused) {
    advisories.push({
      kind: "outcome_entry",
      severity: "warning",
      slug: entry.slug,
      message: `Memory entry repeatedly retrieved but reported unused (${entry.retrieved_unused_count} retrieved-unused footnotes).`,
      evidence: entry,
    });
  }
  for (const entry of summary.outcome.echo_chamber_candidates) {
    advisories.push({
      kind: "outcome_entry",
      severity: "warning",
      slug: entry.slug,
      message: `Memory entry has a decisive self-report streak of ${entry.decisive_streak}; future prompt-native aggregator should seek user-grounded disconfirmation before strengthening it further.`,
      evidence: entry,
    });
  }

  const totalStaging = summary.staging.total_files;
  if (totalStaging >= STAGING_CRITICAL_THRESHOLD || summary.staging.provisional_stale > 0) {
    advisories.push({
      kind: "staging_backlog",
      severity: totalStaging >= STAGING_CRITICAL_THRESHOLD ? "critical" : "warning",
      message: `Sediment staging backlog needs attention: ${totalStaging} files, ${summary.staging.provisional_stale} stale provisional corrections.`,
      evidence: summary.staging,
    });
  } else if (totalStaging >= STAGING_WARNING_THRESHOLD) {
    advisories.push({
      kind: "staging_backlog",
      severity: "warning",
      message: `Sediment staging backlog is growing (${totalStaging} files).`,
      evidence: summary.staging,
    });
  }

  if (summary.staging.multiview_pending > 0) {
    advisories.push({
      kind: "multiview_pending",
      severity: "warning",
      message: `${summary.staging.multiview_pending} multi-view reviewer-approved/retryable candidates are pending replay; if this persists, check replay writer errors, reviewer availability, or terminal retry/stale cleanup.`,
      evidence: { multiview_pending: summary.staging.multiview_pending },
    });
  }

  if (summary.audit.recent_rows >= 10) {
    const errorRate = summary.audit.error_like_count / summary.audit.recent_rows;
    if (errorRate >= 0.2) {
      advisories.push({
        kind: "audit_error_rate",
        severity: errorRate >= 0.5 ? "critical" : "warning",
        message: `Recent sediment audit error-like rate is ${(errorRate * 100).toFixed(0)}%.`,
        evidence: { error_like_count: summary.audit.error_like_count, recent_rows: summary.audit.recent_rows },
      });
    }
  }

  if (summary.search.recent_rows >= 10 && summary.search.zero_result_count / summary.search.recent_rows >= 0.5) {
    advisories.push({
      kind: "search_activity",
      severity: "warning",
      message: `memory_search returned zero results for ${summary.search.zero_result_count}/${summary.search.recent_rows} recent searches; retrieval prompts or index coverage may be drifting.`,
      evidence: summary.search,
    });
  }

  return advisories;
}

export function aggregatorLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "aggregator-ledger.jsonl");
}

export function aggregatorLastRunPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "aggregator-last-run.json");
}

function readLastRun(projectRoot: string): number | null {
  try {
    const file = aggregatorLastRunPath(projectRoot);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).last_run_ts : undefined;
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function writeLastRun(projectRoot: string, now: Date, status: "ok" | "error"): void {
  try {
    const file = aggregatorLastRunPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ last_run_ts: formatLocalIsoTimestamp(now), status }, null, 2) + "\n", "utf-8");
  } catch {
    // best-effort; failure only means a future turn may retry sooner
  }
}

export function writeAggregatorLedger(summary: AggregatorSummary): void {
  try {
    const file = aggregatorLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(file)
      ? readJsonl<AggregatorSummary>(file, LEDGER_MAX_ROWS - 1, LEDGER_TAIL_READ_BYTES).rows
      : [];
    // ADR 0027 PR-B+ R1 P1-3: aggregator runs inside sediment agent_end
    // (scheduled via setImmediate from inside the ALS scope), so
    // getCurrentAnchor() returns the trigger turn anchor. summary's own
    // fields take precedence over anchor (spread order: anchor first).
    const enrichedSummary = { ...spreadAnchor(getCurrentAnchor()), ...summary };
    const rows = [...existing, enrichedSummary].slice(-LEDGER_MAX_ROWS);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
  } catch {
    // advisory only — never throw into agent_end
  }
}

export function runSedimentAggregator(options: RunAggregatorOptions): AggregatorSummary {
  const now = options.now ?? new Date();
  const windowDays = Math.max(1, Math.floor(options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const cutoffMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const audit = summarizeAudit(options.projectRoot, cutoffMs, Math.max(1, Math.floor(options.auditRowLimit ?? DEFAULT_AUDIT_ROW_LIMIT)));
  const outcomeRows = readProjectOutcomeRows(options.projectRoot, Math.max(1, Math.floor(options.outcomeRowLimit ?? DEFAULT_OUTCOME_ROW_LIMIT)));
  const outcome = summarizeOutcomes(outcomeRows, cutoffMs);
  const staging = summarizeStaging(now);
  const search = summarizeSearch(options.projectRoot, cutoffMs, Math.max(1, Math.floor(options.searchMetricsRowLimit ?? DEFAULT_SEARCH_METRICS_ROW_LIMIT)));
  const classifierHealth = summarizeClassifierHealth(options.projectRoot);
  // ADR 0027 PR-B+ R1 P1-12: per-turn token-spend rollup (additive;
  // independent of other summaries; failure here is silent best-effort).
  const perTurnCost = scanPerTurnCost({ projectRoot: options.projectRoot, cutoffMs });

  // Phase C.1.a (ADR 0025 §4.3 v1 prompt input C9 + D4): compute the
  // raw distribution shape across all outcome window slugs (not just
  // the threshold-tripped subset), and snapshot the structural
  // context list. Both fields are optional and additive — v0.2
  // mechanical consumers ignore them, v1 LLM consumes them.
  const flaggedSlugs = new Set<string>([
    ...outcome.high_unused.map((e) => e.slug),
    ...outcome.echo_chamber_candidates.map((e) => e.slug),
  ]);
  const rawDistribution = buildRawDistributionSummary(outcomeRows, cutoffMs, flaggedSlugs);

  const base = {
    ts: formatLocalIsoTimestamp(now),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    project_root: path.resolve(options.projectRoot),
    window_days: windowDays,
    audit,
    outcome,
    staging,
    search,
    classifier_health: classifierHealth,
    raw_distribution: rawDistribution,
    structural_context: STRUCTURAL_CONTEXT,
    per_turn_cost: perTurnCost,
  };
  const advisories = buildAdvisories(base);
  return {
    ok: !advisories.some((a) => a.severity === "critical"),
    ...base,
    advisories,
  };
}

export function runAndWriteSedimentAggregator(options: RunAggregatorOptions): AggregatorSummary {
  const summary = runSedimentAggregator(options);
  writeAggregatorLedger({
    ...summary,
    prompt_version: buildPromptVersionAudit("aggregator", options.settings),
  });
  return summary;
}

export function runAndWriteSedimentAggregatorIfDue(
  options: RunAggregatorOptions & { minIntervalMs?: number },
): AggregatorSummary | null {
  const now = options.now ?? new Date();
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
  const lastRunMs = readLastRun(options.projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) return null;
  try {
    const summary = runAndWriteSedimentAggregator({ ...options, now });
    writeLastRun(options.projectRoot, now, "ok");
    return summary;
  } catch (error) {
    writeLastRun(options.projectRoot, now, "error");
    throw error;
  }
}
