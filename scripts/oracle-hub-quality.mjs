#!/usr/bin/env node
/**
 * Oracle: ADR 0030 hub assignment-quality reader (increment 4).
 *
 * Reads the dispatch audit.jsonl, joins hub_decision / hub_summary / hub task
 * rows by the C6 anchor (session_id, turn_id, subturn), and reports the
 * DETERMINISTIC efficiency axis (ADR 0030 §5 axis 1): worker count, cost,
 * hub-cost ratio, success rate, same-vendor self-talk rate, over-dispatch
 * signal, latency. This needs NO live model — it is pure log analysis, exactly
 * the substrate ADR 0030 says the harness grows from.
 *
 * The correctness axis (§5 axis 2b — "which of human-pick vs hub-pick was
 * better") is NOT judged here. Following the project's oracle-goldset pattern
 * (the script never calls models; cross-vendor T0 judging is done by the main
 * session via dispatch_parallel), MODE=material emits the dual-execution
 * candidates (sampled deterministically per dualExecSampleRate) for the owner
 * to dual-run and judge.
 *
 * Modes:
 *   report   (default) — deterministic efficiency report over all hub runs.
 *   material           — emit dual-exec candidate hub runs (task + assignment)
 *                        for cross-vendor judging.
 *
 * Usage:
 *   node scripts/oracle-hub-quality.mjs                 # report (cwd audit)
 *   node scripts/oracle-hub-quality.mjs --root=<dir>    # explicit project root
 *   node scripts/oracle-hub-quality.mjs --mode=material --rate=0.2
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Pure functions (exported for smoke) ─────────────────────────

export function parseAuditLines(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return rows;
}

function anchorKey(r) {
  return `${r.session_id ?? "?"}|${r.turn_id ?? "?"}`;
}

/** Per-run grouping key. Prefer the explicit hub_run_id (dispatch_hub stamps it
 *  on EVERY row): (session_id, turn_id) is NOT unique per run — multiple hub
 *  calls share one turn, and a run's rows span subturns 0..N — so keying on the
 *  anchor alone silently merges sibling runs (later hub_decision overwrites the
 *  earlier). Fall back to the anchor key for legacy rows predating hub_run_id. */
function runKey(r) {
  return r.hub_run_id != null && r.hub_run_id !== "" ? `run:${r.hub_run_id}` : anchorKey(r);
}

/** Group audit rows into hub runs. A run is anchored by a hub_decision row;
 *  its hub_summary (subturn 0) and per-worker task rows (subturn 1..N) join on
 *  hub_run_id (preferred) or the (session_id, turn_id) anchor (legacy fallback).
 *  Rows from non-hub dispatch are ignored. */
export function groupHubRuns(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.row_kind === "hub_decision") {
      const k = runKey(r);
      if (!byKey.has(k)) byKey.set(k, { key: k, decision: null, summary: null, tasks: [], dispositions: [] });
      byKey.get(k).decision = r;
    }
  }
  for (const r of rows) {
    const k = runKey(r);
    const run = byKey.get(k);
    if (!run) continue; // only attach to keys that have a hub_decision
    if (r.row_kind === "hub_summary") run.summary = r;
    else if (r.row_kind === "hub_disposition") run.dispositions.push(r);
    else if (r.row_kind === "task" && r.operation === "dispatch_hub.task") run.tasks.push(r);
  }
  return Array.from(byKey.values()).filter((run) => run.decision);
}

/** Deterministic per-run metrics. */
export function runMetrics(run) {
  const d = run.decision ?? {};
  const s = run.summary ?? {};
  const workerCount = typeof d.worker_count === "number" ? d.worker_count : (Array.isArray(d.worker_models) ? d.worker_models.length : 0);
  const hubCost = typeof s.hub_cost === "number" ? s.hub_cost : (typeof d.hub_cost === "number" ? d.hub_cost : 0);
  const workersCost = typeof s.workers_cost === "number" ? s.workers_cost : run.tasks.reduce((a, t) => a + (typeof t.cost === "number" ? t.cost : 0), 0);
  const totalCost = hubCost + workersCost;
  const success = typeof s.success_count === "number" ? s.success_count : run.tasks.filter((t) => t.result === "ok").length;
  const failed = typeof s.failed_count === "number" ? s.failed_count : run.tasks.filter((t) => t.result === "fail").length;
  return {
    key: run.key,
    hub_model: d.hub_model ?? "unknown",
    hub_vendor: d.hub_vendor ?? "unknown",
    decorrelated: d.decorrelated,
    worker_count: workerCount,
    success,
    failed,
    terminal_state: s.terminal_state ?? (failed === 0 ? "completed" : success === 0 ? "failed" : "degraded"),
    same_vendor_as_hub: typeof d.same_vendor_as_hub === "number" ? d.same_vendor_as_hub : 0,
    hub_cost: hubCost,
    workers_cost: workersCost,
    total_cost: totalCost,
    hub_cost_ratio: totalCost > 0 ? hubCost / totalCost : 0,
    hub_duration_ms: typeof s.hub_duration_ms === "number" ? s.hub_duration_ms : (typeof d.hub_duration_ms === "number" ? d.hub_duration_ms : 0),
    total_wall_ms: typeof s.total_wall_ms === "number" ? s.total_wall_ms : 0,
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
  };
}

/** Aggregate report across runs. */
export function aggregate(runs) {
  const metrics = runs.map(runMetrics);
  const n = metrics.length;
  const byModel = {};
  let sameVendorRuns = 0;
  let overDispatchRuns = 0; // worker_count >= 5 is the over-dispatch watch signal
  let totalCost = 0;
  const workerCounts = [];
  for (const m of metrics) {
    totalCost += m.total_cost;
    workerCounts.push(m.worker_count);
    if (m.same_vendor_as_hub > 0) sameVendorRuns++;
    if (m.worker_count >= 5) overDispatchRuns++;
    const bm = (byModel[m.hub_model] ??= { count: 0, total_cost: 0, success: 0, workers: 0 });
    bm.count++;
    bm.total_cost += m.total_cost;
    bm.success += m.success;
    bm.workers += m.worker_count;
  }
  return {
    hub_run_count: n,
    total_cost: totalCost,
    avg_worker_count: n ? workerCounts.reduce((a, b) => a + b, 0) / n : 0,
    same_vendor_rate: n ? sameVendorRuns / n : 0,
    over_dispatch_rate: n ? overDispatchRuns / n : 0,
    by_hub_model: byModel,
    metrics,
  };
}

/** Deterministic dual-exec sampling: a run is a candidate iff a stable hash of
 *  its anchor key maps below `rate`. Deterministic (not random) so the same
 *  run is consistently sampled across re-runs and is unit-testable. */
export function isDualExecCandidate(key, rate) {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  let h = 2166136261 >>> 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000 < rate;
}

export function selectDualExecCandidates(runs, rate) {
  return runs.filter((run) => isDualExecCandidate(run.key, rate)).map((run) => ({
    key: run.key,
    hub_model: run.decision?.hub_model,
    worker_models: run.decision?.worker_models ?? [],
    worker_roles: run.decision?.worker_roles ?? [],
  }));
}

// ── CLI ─────────────────────────────────────────────────────────

function auditPathFor(root) {
  return path.join(root, ".pi-astack", "dispatch", "audit.jsonl");
}

function hubJudgmentsPath() {
  return "/home/worker/.pi/.pi-astack/dispatch/hub-judgments.jsonl";
}

function countJudgmentRows() {
  try {
    return fs.readFileSync(hubJudgmentsPath(), "utf-8").split("\n").filter((line) => line.trim()).length;
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--count-judgments")) {
    console.log(JSON.stringify({ judgments_path: hubJudgmentsPath(), judgment_count: countJudgmentRows() }, null, 2));
    return;
  }

  const rootArg = args.find((a) => a.startsWith("--root="));
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const rateArg = args.find((a) => a.startsWith("--rate="));
  const root = rootArg ? rootArg.split("=")[1] : process.cwd();
  const mode = modeArg ? modeArg.split("=")[1] : "report";
  const rate = rateArg ? Number(rateArg.split("=")[1]) : 0.2;

  const auditPath = auditPathFor(root);
  let text = "";
  try { text = fs.readFileSync(auditPath, "utf-8"); }
  catch { console.error(`oracle-hub-quality: no audit at ${auditPath} (run with dispatch.hub.enabled and use dispatch_hub first).`); process.exit(0); }

  const runs = groupHubRuns(parseAuditLines(text));
  if (runs.length === 0) { console.log("oracle-hub-quality: no hub runs in audit yet."); process.exit(0); }

  if (mode === "material") {
    const cands = selectDualExecCandidates(runs, rate);
    console.log(JSON.stringify({ mode: "material", rate, candidate_count: cands.length, candidates: cands }, null, 2));
    return;
  }

  const rep = aggregate(runs);
  console.log(`oracle-hub-quality — ${rep.hub_run_count} hub run(s)`);
  console.log(`  total cost (report-only): $${rep.total_cost.toFixed(4)}`);
  console.log(`  avg worker count: ${rep.avg_worker_count.toFixed(2)}`);
  console.log(`  over-dispatch rate (>=5 workers): ${(rep.over_dispatch_rate * 100).toFixed(1)}%`);
  console.log(`  same-vendor-as-hub rate (self-talk signal): ${(rep.same_vendor_rate * 100).toFixed(1)}%`);
  console.log(`  by hub model:`);
  for (const [model, b] of Object.entries(rep.by_hub_model)) {
    console.log(`    ${model}: ${b.count} run(s), avg workers ${(b.workers / b.count).toFixed(1)}, total $${b.total_cost.toFixed(4)}`);
  }
  console.log(`\n  NOTE: correctness (which assignment was better) needs dual-execution + cross-vendor judging — run --mode=material then dispatch_parallel T0 judges (ADR 0030 §5b).`);
}

const isDirect = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; }
  catch { return false; }
})();
if (isDirect) main();

// silence unused import in pure-import (smoke) context
void fileURLToPath;
