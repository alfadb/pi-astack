#!/usr/bin/env node
/**
 * Smoke: ADR 0030 oracle-hub-quality pure logic (increment 4).
 *
 * Feeds a fixture audit.jsonl and pins the deterministic report + dual-exec
 * sampling: hub-run join by C6 anchor, per-run metrics (cost/ratio/success/
 * same-vendor), aggregate (over-dispatch + self-talk rates, by-model), and the
 * deterministic dual-exec candidate sampling.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oracle = await import(path.join(__dirname, "oracle-hub-quality.mjs"));
const { parseAuditLines, groupHubRuns, runMetrics, aggregate, isDualExecCandidate, selectDualExecCandidates } = oracle;

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else { console.log(`  FAIL  ${msg}`); failures++; }
}

console.log("oracle-hub-quality pure logic (ADR 0030 §5)");

const fixture = [
  // run 1: s1/t1 — 3 workers, all ok, deepseek hub, decorrelated, no self-talk
  JSON.stringify({ row_kind: "hub_decision", operation: "dispatch_hub.decision", session_id: "s1", turn_id: 1, hub_model: "deepseek/deepseek-v4-pro", hub_vendor: "deepseek", decorrelated: true, worker_count: 3, worker_models: ["a/x", "o/y", "m/z"], worker_roles: ["r1", "r2", "r3"], same_vendor_as_hub: 0, warnings: [], hub_cost: 0.01 }),
  JSON.stringify({ row_kind: "task", operation: "dispatch_hub.task", session_id: "s1", turn_id: 1, subturn: 1, result: "ok", cost: 0.1 }),
  JSON.stringify({ row_kind: "task", operation: "dispatch_hub.task", session_id: "s1", turn_id: 1, subturn: 2, result: "ok", cost: 0.1 }),
  JSON.stringify({ row_kind: "task", operation: "dispatch_hub.task", session_id: "s1", turn_id: 1, subturn: 3, result: "ok", cost: 0.1 }),
  JSON.stringify({ row_kind: "hub_summary", operation: "dispatch_hub.summary", session_id: "s1", turn_id: 1, subturn: 0, success_count: 3, failed_count: 0, terminal_state: "completed", hub_cost: 0.01, workers_cost: 0.3, total_cost: 0.31, hub_duration_ms: 1000, total_wall_ms: 5000 }),
  // run 2: s2/t2 — 6 workers (over-dispatch), 1 failed, anthropic hub, 2 same-vendor (self-talk)
  JSON.stringify({ row_kind: "hub_decision", operation: "dispatch_hub.decision", session_id: "s2", turn_id: 2, hub_model: "anthropic/claude-opus-4-8", hub_vendor: "anthropic", decorrelated: false, worker_count: 6, worker_models: ["a/x", "a/y", "o/z", "m/w", "d/v", "g/u"], same_vendor_as_hub: 2, warnings: ["2/6 workers share the hub vendor (self-talk risk)"], hub_cost: 0.05 }),
  JSON.stringify({ row_kind: "hub_summary", operation: "dispatch_hub.summary", session_id: "s2", turn_id: 2, subturn: 0, success_count: 5, failed_count: 1, terminal_state: "degraded", hub_cost: 0.05, workers_cost: 1.2, total_cost: 1.25, hub_duration_ms: 2000, total_wall_ms: 12000 }),
  // noise: a non-hub dispatch_parallel task row (must be ignored)
  JSON.stringify({ row_kind: "task", operation: "dispatch_parallel.task", session_id: "s9", turn_id: 9, subturn: 1, result: "ok", cost: 0.9 }),
  // noise: malformed line
  "{not json",
].join("\n");

// ── parse ──
const rows = parseAuditLines(fixture);
ok(rows.length === 8, `parseAuditLines skips the malformed line (got ${rows.length}, expect 8)`);

// ── group ──
const runs = groupHubRuns(rows);
ok(runs.length === 2, `groupHubRuns finds 2 hub runs (ignores the non-hub dispatch_parallel row)`);
const r1 = runs.find((r) => r.key === "s1|1");
ok(r1 && r1.tasks.length === 3, "run 1 joins its 3 hub task rows");
ok(r1 && r1.summary && r1.summary.terminal_state === "completed", "run 1 joins its summary");

// ── per-run metrics ──
const m1 = runMetrics(r1);
ok(m1.worker_count === 3 && m1.success === 3 && m1.failed === 0, "run 1 metrics: 3 workers all ok");
ok(Math.abs(m1.total_cost - 0.31) < 1e-9, "run 1 total_cost = hub+workers = 0.31");
ok(Math.abs(m1.hub_cost_ratio - (0.01 / 0.31)) < 1e-9, "run 1 hub_cost_ratio computed");
ok(m1.same_vendor_as_hub === 0 && m1.decorrelated === true, "run 1 is decorrelated, no self-talk");

const m2 = runMetrics(runs.find((r) => r.key === "s2|2"));
ok(m2.worker_count === 6 && m2.failed === 1 && m2.terminal_state === "degraded", "run 2 metrics: 6 workers, 1 failed, degraded");
ok(m2.same_vendor_as_hub === 2, "run 2 carries same-vendor self-talk count");

// ── aggregate ──
const rep = aggregate(runs);
ok(rep.hub_run_count === 2, "aggregate counts 2 runs");
ok(Math.abs(rep.total_cost - 1.56) < 1e-9, "aggregate total cost = 0.31 + 1.25");
ok(Math.abs(rep.avg_worker_count - 4.5) < 1e-9, "aggregate avg worker count = (3+6)/2");
ok(Math.abs(rep.over_dispatch_rate - 0.5) < 1e-9, "over-dispatch rate = 1/2 (run 2 has >=5 workers)");
ok(Math.abs(rep.same_vendor_rate - 0.5) < 1e-9, "same-vendor (self-talk) rate = 1/2");
ok(rep.by_hub_model["deepseek/deepseek-v4-pro"]?.count === 1 && rep.by_hub_model["anthropic/claude-opus-4-8"]?.count === 1, "aggregate buckets by hub model");

// ── dual-exec sampling (deterministic) ──
ok(isDualExecCandidate("anything", 0) === false, "rate 0 → never a candidate");
ok(isDualExecCandidate("anything", 1) === true, "rate 1 → always a candidate");
ok(isDualExecCandidate("k", 0.5) === isDualExecCandidate("k", 0.5), "sampling is deterministic for a key");
const all = selectDualExecCandidates(runs, 1);
ok(all.length === 2 && all[0].hub_model, "selectDualExecCandidates(rate=1) returns all runs with hub_model");
ok(selectDualExecCandidates(runs, 0).length === 0, "selectDualExecCandidates(rate=0) returns none");

console.log();
if (failures === 0) {
  console.log("✅ oracle-hub-quality pure logic: all checks passed");
  process.exit(0);
} else {
  console.log(`❌ oracle-hub-quality: ${failures} assertion(s) failed`);
  process.exit(1);
}
