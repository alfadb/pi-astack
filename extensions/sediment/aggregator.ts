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
import { runAggregatorLlmPass, type PromptNativeOutput } from "./aggregator-llm";
import type { ModelRegistryLike } from "./llm-extractor";

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
  // NOTE 2026-05-28 Stage 2 (commit 9796bdd→...): archive-reactivation-
  // reviewer-unimplemented entry REMOVED. ADR 0025 §4.6 reviewer landed in
  // extensions/sediment/archive-reactivation.ts + prompts/archive-
  // reactivation-reviewer-v1.md + sediment/index.ts agent_end
  // integration. promptVersion.archiveReactivationReviewer = "v1".
  // NOTE 2026-05-28 round-3 cleanup: previously had a "p15-writer-dispatch-stub"
  // entry here, but the writer dispatch was actually shipped earlier (see
  // sediment/index.ts:3012-3041 — `writeApprovedToBrain` calls
  // `executeCuratorDecisionToBrain`). The remaining P1.5 limitation is
  // "Pass 1 schema cannot synthesize update/merge/supersede/delete rich
  // payloads" which is encoded structurally as
  // P15WatchdogSignals.pass1_op_type_breakdown_available=false, NOT as a
  // structural_context entry. The smoke-aggregator-structural-context.mjs
  // lint caught this drift on its first run — working as intended.
];

/**
 * Phase C.1.c (ADR 0025 §4.3 v1 prompt input C4 / Step 7 + ADR 0025 §6):
 * P1.5 watchdog signals — telemetry to evaluate whether the multi-view
 * Pass 1 schema upgrade should be re-prioritized. ADR 0025 §6
 * documents `>5/week` on `multiview_pass1_op_not_synthesizable` as the
 * trigger condition; the v1 prompt does NOT treat that threshold as a
 * hard rule, but uses these counts as evidence for the case-FOR side
 * of its Step 7 reasoning.
 *
 * What we can derive from current telemetry (v0.2 data sources):
 *   1. `multiview_pass1_op_not_synthesizable` skip-reason frequency
 *      from audit.jsonl rows
 *   2. `candidate_lost: true` occurrences in audit rows (signals where
 *      the replay writer dispatch lost a reviewer-approved entry)
 *   3. multi-view-metrics.jsonl pass1/pass2 ok-rate + cross-project
 *      breakdown via device_id + per-project audit roll-up
 *   4. multiview-pending staging files — oldest age + max retry count
 *
 * What we cannot derive (KNOWN GAP, deferred to ADR 0025 §4.4.6 P1.5
 * landing):
 *   5. Pass 1 op-type distribution (create / archive / update / merge /
 *      supersede). Pass 1 schema does not currently record op type in
 *      a structured field; rawText would need re-parsing.
 *
 * The KNOWN GAP is encoded in the returned summary as
 * `pass1_op_type_breakdown_available: false`, so the v1 prompt knows
 * not to use that dimension. Per the prompt's empty-feed edge case,
 * the LLM treats absent dimensions as 'no signal', not 'signal == 0'.
 */
export interface P15WatchdogSignals {
  /** From audit: count of skip rows with reason multiview_pass1_op_not_synthesizable. */
  pass1_op_not_synthesizable_count: number;
  /** From audit: count of rows with candidate_lost: true. */
  candidate_lost_count: number;
  /** From multi-view-metrics: total pass1 + pass2 calls, and ok-rate. */
  multi_view_metrics: {
    pass1_call_count: number;
    pass2_call_count: number;
    ok_rate: number;
    /** Distinct device_ids seen — proxy for cross-project distribution. */
    distinct_device_ids: number;
  };
  /** From multiview-pending staging files: oldest age + retry distribution. */
  multiview_pending_queue: {
    total: number;
    oldest_age_days: number;
    max_retry_attempts: number;
  };
  /** Known gap marker per ADR 0025 §4.4.6: Pass 1 op-type is not yet
   *  surfaced in audit — v1 prompt treats this dimension as missing. */
  pass1_op_type_breakdown_available: boolean;
}

/**
 * Phase C.1.b (ADR 0025 §4.3 v1 prompt input C5): outcome counterfactual
 * excerpts. The v1 prompt distinguishes 'actively-applied spec streak'
 * from 'echo chamber' by reading the `counterfactual` text on
 * DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED footnotes. Without these
 * quotes, slug + streak counts cannot reveal whether a decisive_streak
 * of 21 represents real spec application ('would have used X; instead
 * used Y') or self-reinforcing recommendation ('would have made the
 * same decision independently').
 */
export interface OutcomeCounterfactualExcerpt {
  slug: string;
  used: "decisive" | "confirmatory" | "retrieved-unused";
  counterfactual: string;
  ts: string;
  /** Truncated marker if counterfactual exceeded the per-excerpt char cap. */
  truncated?: boolean;
}

/**
 * Phase C.1.b (ADR 0025 §4.3 v1 prompt input C3): summary of prior
 * aggregator runs. The v1 prompt reads the most recent N runs as
 * compact context so the skeptical historian can detect 'I have been
 * flagging this same advisory every run with no acted-on changes —
 * time to demote or re-evaluate'. Explicit license in the prompt for
 * the current LLM to disagree with past runs (with cited new evidence).
 */
export interface PriorAggregatorRunSummary {
  ts: string;
  project_root: string;
  /** Count of advisories by kind, from v0.2 mechanical path. */
  advisory_kinds: Record<string, number>;
  /** Total advisory count (sum of advisory_kinds). */
  total_advisories: number;
  /** If this row was a v1 prompt-native output: kinds the LLM promoted. */
  promoted_kinds?: string[];
  /** If this row was a v1 prompt-native output: kinds the LLM demoted. */
  demoted_kinds?: string[];
  /** If this row was a v1 prompt-native output: acknowledgment kinds carried over. */
  acknowledgment_kinds?: string[];
  /** If this row was a degraded fallback (LLM call failed): true. */
  degraded_to_mechanical?: boolean;
  /** classifier_health snapshot for trend reference. */
  classifier_health?: { quote: number; alternative: number; self_critique: number; n: number };
}

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
  /** Phase C.1.b (ADR 0025 §4.3 v1 prompt input C5): outcome counterfactual
   *  quotes for flagged + high-streak slugs. Optional; absent on v0.2
   *  ledger rows. Cap on count and per-excerpt length keeps payload
   *  bounded. */
  outcome_counterfactual_excerpts?: OutcomeCounterfactualExcerpt[];
  /** Phase C.1.b (ADR 0025 §4.3 v1 prompt input C3): compact summary
   *  of the prior N aggregator runs (default N=8). Excludes the current
   *  run. Optional; first run on a fresh project will have []. */
  prior_aggregator_runs?: PriorAggregatorRunSummary[];
  /** Phase C.1.c (ADR 0025 §4.3 v1 prompt input C4 / Step 7): P1.5
   *  watchdog telemetry. Optional; absent on v0.2 ledger rows. */
  p15_watchdog_signals?: P15WatchdogSignals;
  /** Phase C.2 (ADR 0025 §4.3 v1 LLM pass): the prompt-native output
   *  emitted by the aggregator-skeptical-historian-v1 LLM call. Absent
   *  when no modelRegistry was supplied (v0.2-only run) or when the
   *  LLM call failed (see degraded_to_mechanical below). */
  prompt_native?: PromptNativeOutput;
  /** Phase C.2 fallback flag: true when the v1 LLM call was attempted
   *  but failed (model resolution, auth, transport error, parse
   *  failure). The mechanical advisories[] is still valid in this
   *  case; downstream consumers MUST NOT surface degraded runs to
   *  user-facing notifications (Phase A C2 + C8). */
  degraded_to_mechanical?: boolean;
  /** Phase C.2: when degraded_to_mechanical=true, the failure reason
   *  string from AggregatorLlmResult.degraded_reason. Used by next
   *  aggregator run's prior_aggregator_summaries scan. */
  degraded_reason?: string;
  /** Phase C round-3 P3 fix (DeepSeek-pro): three-state discriminator
   *  for the engine that actually produced this row. Was previously
   *  only emitted into audit.jsonl by the index.ts caller; promoting
   *  it into the AggregatorSummary itself lets downstream ledger
   *  consumers (next-run `summarizePriorAggregatorRuns`) read engine
   *  state directly instead of reverse-engineering from absence of
   *  `prompt_native` + `degraded_to_mechanical`. */
  aggregator_engine?: "prompt_native_v1" | "mechanical_v0_2_degraded" | "mechanical_v0_2_no_model_registry";
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

/**
 * Phase C.1.b (ADR 0025 §4.3 v1 prompt input C5): extract counterfactual
 * excerpts for `flaggedSlugs` (high-unused + echo-chamber candidates).
 * Returns at most `maxPerSlug` excerpts per slug, with counterfactual
 * text truncated to `maxExcerptChars` to keep prompt payload bounded.
 *
 * Excerpt selection: prefer most recent rows, but include at least one
 * of each `used` category (decisive / confirmatory / retrieved-unused)
 * if available, so the LLM sees the mix of how this slug has been used.
 */
function extractOutcomeCounterfactualExcerpts(
  rows: LedgerOutcomeRow[],
  cutoffMs: number,
  flaggedSlugs: ReadonlySet<string>,
  maxPerSlug: number = 3,
  maxExcerptChars: number = 600,
): OutcomeCounterfactualExcerpt[] {
  if (flaggedSlugs.size === 0) return [];
  const bySlug = new Map<string, LedgerOutcomeRow[]>();
  for (const row of rows) {
    if (!inWindow(row.ts, cutoffMs)) continue;
    if (!row.entry_slug || !flaggedSlugs.has(row.entry_slug)) continue;
    if (row.source !== "memory-footnote") continue;
    if (!row.used || !row.counterfactual) continue;
    const arr = bySlug.get(row.entry_slug) ?? [];
    arr.push(row);
    bySlug.set(row.entry_slug, arr);
  }

  const out: OutcomeCounterfactualExcerpt[] = [];
  for (const [slug, slugRows] of bySlug) {
    // Sort newest-first for recency preference.
    slugRows.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
    // Try to include at least one of each `used` category, then fill
    // with most recent regardless of category.
    const picked: LedgerOutcomeRow[] = [];
    const seenCategories = new Set<string>();
    for (const row of slugRows) {
      if (picked.length >= maxPerSlug) break;
      if (row.used && !seenCategories.has(row.used)) {
        picked.push(row);
        seenCategories.add(row.used);
      }
    }
    for (const row of slugRows) {
      if (picked.length >= maxPerSlug) break;
      if (!picked.includes(row)) picked.push(row);
    }
    for (const row of picked) {
      const text = row.counterfactual ?? "";
      const truncated = text.length > maxExcerptChars;
      out.push({
        slug,
        used: row.used as OutcomeCounterfactualExcerpt["used"],
        counterfactual: truncated ? text.slice(0, maxExcerptChars) + "...[truncated]" : text,
        ts: row.ts,
        ...(truncated ? { truncated: true } : {}),
      });
    }
  }
  // Stable order: slug asc, then ts desc (recency-first within slug).
  out.sort((a, b) =>
    a.slug !== b.slug
      ? a.slug.localeCompare(b.slug)
      : (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0),
  );
  return out;
}

/**
 * Phase C.1.b (ADR 0025 §4.3 v1 prompt input C3): read the most recent
 * N aggregator-ledger rows EXCLUDING the current run, condense each
 * into a `PriorAggregatorRunSummary`. Each summary is small (~10
 * fields) so 8 rows fits comfortably in prompt context.
 *
 * Failure mode: on any I/O or parse error, returns []. The current
 * v1 prompt explicitly handles empty prior_aggregator_runs as a
 * legitimate 'first run' edge case (see prompt §2 Edge case section).
 */
function summarizePriorAggregatorRuns(count: number = 8): PriorAggregatorRunSummary[] {
  try {
    const file = aggregatorLedgerPath();
    if (!fs.existsSync(file)) return [];
    // Re-use the bounded JSONL tail read used by writeAggregatorLedger.
    const { rows } = readJsonl<AggregatorSummary>(file, count, LEDGER_TAIL_READ_BYTES);
    if (rows.length === 0) return [];
    const out: PriorAggregatorRunSummary[] = [];
    for (const row of rows) {
      try {
        const advisoryKinds: Record<string, number> = {};
        if (Array.isArray(row.advisories)) {
          for (const adv of row.advisories) {
            const k = (adv as { kind?: string }).kind;
            if (typeof k === "string") {
              advisoryKinds[k] = (advisoryKinds[k] ?? 0) + 1;
            }
          }
        }
        const summary: PriorAggregatorRunSummary = {
          ts: typeof row.ts === "string" ? row.ts : "",
          project_root: typeof row.project_root === "string" ? row.project_root : "",
          advisory_kinds: advisoryKinds,
          total_advisories: Array.isArray(row.advisories) ? row.advisories.length : 0,
        };
        // v1 prompt-native output fields (forward-compat — not present
        // in v0.2 rows but may be present in v1 rows once Phase C.2
        // wiring lands).
        const rowAny = row as unknown as Record<string, unknown>;
        const pn = rowAny.prompt_native as Record<string, unknown> | undefined;
        if (pn && typeof pn === "object") {
          if (Array.isArray(pn.promoted_advisories)) {
            summary.promoted_kinds = pn.promoted_advisories
              .map((a) => (a as { kind?: string }).kind)
              .filter((k): k is string => typeof k === "string");
          }
          if (Array.isArray(pn.demoted_signals)) {
            summary.demoted_kinds = pn.demoted_signals
              .map((a) => (a as { kind?: string }).kind)
              .filter((k): k is string => typeof k === "string");
          }
          if (Array.isArray(pn.previous_acknowledgments)) {
            summary.acknowledgment_kinds = pn.previous_acknowledgments
              .map((a) => (a as { kind?: string }).kind)
              .filter((k): k is string => typeof k === "string");
          }
        }
        if (rowAny.degraded_to_mechanical === true) {
          summary.degraded_to_mechanical = true;
        }
        if (row.classifier_health && row.classifier_health.ok) {
          summary.classifier_health = {
            quote: row.classifier_health.quoteRate,
            alternative: row.classifier_health.alternativeRate,
            self_critique: row.classifier_health.concreteSelfCritiqueRate,
            n: row.classifier_health.sampleSize,
          };
        }
        out.push(summary);
      } catch {
        // Skip corrupt rows; the bounded tail read may yield a partial
        // first line on a fresh truncation.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Phase C.1.c (ADR 0025 §4.3 v1 prompt input C4 / Step 7): compute
 * the P1.5 watchdog signals. Reads audit.jsonl + multi-view-metrics
 * + multiview-pending staging files.
 *
 * All file I/O is best-effort — any failure yields zero counts so the
 * returned summary stays well-formed for the v1 prompt's empty-feed
 * handler.
 */
function scanP15WatchdogSignals(
  projectRoot: string,
  cutoffMs: number,
  rowLimit: number,
  now: Date,
): P15WatchdogSignals {
  // (1) + (2) from audit.jsonl
  let pass1OpNotSynth = 0;
  let candidateLost = 0;
  try {
    const { rows } = readJsonl<Record<string, unknown>>(
      sedimentAuditPath(projectRoot),
      rowLimit,
      JSONL_TAIL_READ_BYTES,
    );
    for (const row of rows) {
      if (!inWindow(rowTimestamp(row), cutoffMs)) continue;
      // Skip-reason can live either at top-level outcome.skip_reason
      // or in results[].detail.skip_reason. Inspect both shapes.
      const outcome = row.outcome as Record<string, unknown> | undefined;
      const topSkip = typeof outcome?.skip_reason === "string" ? (outcome.skip_reason as string) : "";
      if (topSkip === "multiview_pass1_op_not_synthesizable") pass1OpNotSynth++;
      else if (Array.isArray(row.results)) {
        for (const r of row.results as Array<Record<string, unknown>>) {
          const det = r.detail as Record<string, unknown> | undefined;
          if (typeof det?.skip_reason === "string" && det.skip_reason === "multiview_pass1_op_not_synthesizable") {
            pass1OpNotSynth++;
            break;
          }
        }
      }
      // candidate_lost may appear at top-level or inside outcome.
      const topLost = row.candidate_lost;
      const outcomeLost = outcome?.candidate_lost;
      if (topLost === true || outcomeLost === true) candidateLost++;
    }
  } catch {
    // best-effort
  }

  // (3) from multi-view-metrics.jsonl (user-global sidecar).
  let pass1Calls = 0;
  let pass2Calls = 0;
  let okCount = 0;
  let totalCount = 0;
  const deviceIds = new Set<string>();
  try {
    const metricsPath = path.join(userGlobalSedimentDir(), "multi-view-metrics.jsonl");
    const { rows } = readJsonl<Record<string, unknown>>(metricsPath, rowLimit, JSONL_TAIL_READ_BYTES);
    for (const row of rows) {
      if (!inWindow(row.ts, cutoffMs)) continue;
      totalCount++;
      if (row.ok === true) okCount++;
      const pass = typeof row.pass === "string" ? row.pass : "";
      if (pass === "pass1") pass1Calls++;
      else if (pass === "pass2") pass2Calls++;
      const dev = typeof row.device_id === "string" ? row.device_id : "";
      if (dev) deviceIds.add(dev);
    }
  } catch {
    // best-effort
  }
  const okRate = totalCount > 0 ? okCount / totalCount : 0;

  // (4) from multiview-pending staging files.
  let pendingTotal = 0;
  let oldestAgeDays = 0;
  let maxRetry = 0;
  try {
    const dir = stagingDir();
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes("multiview-pending"))) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
          if (!parsed || typeof parsed !== "object") continue;
          pendingTotal++;
          const entry = (parsed as Record<string, unknown>).entry as Record<string, unknown> | undefined;
          const createdMs = typeof entry?.created === "string" ? Date.parse(entry.created as string) : NaN;
          if (Number.isFinite(createdMs)) {
            const ageDays = (now.getTime() - createdMs) / (24 * 60 * 60 * 1000);
            if (ageDays > oldestAgeDays) oldestAgeDays = ageDays;
          }
          const attempts = (entry?.retry_attempts as Record<string, number> | undefined) ?? {};
          for (const v of Object.values(attempts)) {
            if (typeof v === "number" && v > maxRetry) maxRetry = v;
          }
        } catch {
          // skip corrupt staging file
        }
      }
    }
  } catch {
    // best-effort
  }

  return {
    pass1_op_not_synthesizable_count: pass1OpNotSynth,
    candidate_lost_count: candidateLost,
    multi_view_metrics: {
      pass1_call_count: pass1Calls,
      pass2_call_count: pass2Calls,
      ok_rate: Math.round(okRate * 1000) / 1000,
      distinct_device_ids: deviceIds.size,
    },
    multiview_pending_queue: {
      total: pendingTotal,
      oldest_age_days: Math.round(oldestAgeDays * 10) / 10,
      max_retry_attempts: maxRetry,
    },
    pass1_op_type_breakdown_available: false,
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
  // Phase C.1.b: counterfactual excerpts for flagged slugs (C5).
  const counterfactualExcerpts = extractOutcomeCounterfactualExcerpts(
    outcomeRows,
    cutoffMs,
    flaggedSlugs,
  );
  // Phase C.1.b: prior aggregator runs (C3) — reads ledger; empty on
  // first run, returns [] silently on any I/O failure.
  const priorRuns = summarizePriorAggregatorRuns(8);
  // Phase C.1.c: P1.5 watchdog telemetry (C4 / Step 7) — audit +
  // multi-view-metrics + multiview-pending staging.
  const p15Watchdog = scanP15WatchdogSignals(
    options.projectRoot,
    cutoffMs,
    Math.max(1, Math.floor(options.auditRowLimit ?? DEFAULT_AUDIT_ROW_LIMIT)),
    now,
  );

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
    outcome_counterfactual_excerpts: counterfactualExcerpts,
    prior_aggregator_runs: priorRuns,
    p15_watchdog_signals: p15Watchdog,
    per_turn_cost: perTurnCost,
  };
  const advisories = buildAdvisories(base);
  return {
    ok: !advisories.some((a) => a.severity === "critical"),
    ...base,
    advisories,
  };
}

/**
 * Phase C.2 RunAggregatorOptions extension: optional modelRegistry +
 * abort signal enable the v1 LLM pass. When modelRegistry is absent,
 * runAndWriteSedimentAggregator falls back to v0.2-only behavior
 * (unchanged from pre-Phase-C). This keeps the function callable from
 * code paths that don't have a registry handy.
 */
export interface RunAggregatorOptionsWithLlm extends RunAggregatorOptions {
  modelRegistry?: ModelRegistryLike;
  signal?: AbortSignal;
}

export async function runAndWriteSedimentAggregator(options: RunAggregatorOptionsWithLlm): Promise<AggregatorSummary> {
  const summary = runSedimentAggregator(options);

  // Phase C.2: invoke the v1 LLM pass when modelRegistry is supplied.
  // No retry, no recovery — any failure flips degraded_to_mechanical
  // and the run still writes a useful ledger row (mechanical advisories
  // are still valid signal even when the LLM pass fails).
  let promptNative: PromptNativeOutput | undefined;
  let degraded = false;
  let degradedReason: string | undefined;
  if (options.modelRegistry) {
    try {
      const llmResult = await runAggregatorLlmPass(
        summary,
        options.settings,
        options.modelRegistry,
        options.signal,
      );
      if (llmResult.degraded) {
        degraded = true;
        degradedReason = llmResult.degraded_reason;
      } else if (llmResult.prompt_native) {
        promptNative = llmResult.prompt_native;
      }
    } catch (e) {
      // Defensive: runAggregatorLlmPass already wraps errors, but if
      // something escapes (e.g. import failure under jiti), keep the
      // degraded marker and continue — do NOT throw, do NOT block
      // the mechanical ledger write.
      degraded = true;
      degradedReason = `llm_pass_unexpected_exception: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Phase C round-3 P3: compute the engine discriminator at the SOURCE
  // (where modelRegistry presence is authoritatively known) and attach
  // to summary so downstream consumers don't have to reverse-engineer it.
  const aggregatorEngine: AggregatorSummary["aggregator_engine"] = !options.modelRegistry
    ? "mechanical_v0_2_no_model_registry"
    : degraded
      ? "mechanical_v0_2_degraded"
      : "prompt_native_v1";
  const enrichedSummary: AggregatorSummary = {
    ...summary,
    aggregator_engine: aggregatorEngine,
    ...(promptNative ? { prompt_native: promptNative } : {}),
    ...(degraded ? { degraded_to_mechanical: true, ...(degradedReason ? { degraded_reason: degradedReason } : {}) } : {}),
  };

  writeAggregatorLedger({
    ...enrichedSummary,
    prompt_version: buildPromptVersionAudit("aggregator", options.settings),
  });
  return enrichedSummary;
}

export async function runAndWriteSedimentAggregatorIfDue(
  options: RunAggregatorOptionsWithLlm & { minIntervalMs?: number },
): Promise<AggregatorSummary | null> {
  const now = options.now ?? new Date();
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
  const lastRunMs = readLastRun(options.projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) return null;
  try {
    const summary = await runAndWriteSedimentAggregator({ ...options, now });
    writeLastRun(options.projectRoot, now, "ok");
    return summary;
  } catch (error) {
    writeLastRun(options.projectRoot, now, "error");
    throw error;
  }
}
