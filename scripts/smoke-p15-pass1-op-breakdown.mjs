#!/usr/bin/env node
/**
 * smoke-p15-pass1-op-breakdown — Stage 5 (autonomous evolution):
 * INSTRUMENT-ONLY P1.5 watchdog upgrade (ADR 0025 §6 / §4.4.6).
 *
 * 3-T0 design review (2026-05-29, unanimous) concluded the multi-view Pass1
 * rich-payload "dead-loop" must NOT be built into synthesis yet: the dogfood
 * baseline shows 0/week `multiview_pass1_op_not_synthesizable` over 30 days,
 * well under the ADR 0025 §6 `>5/week` trigger, and building synthesis would
 * add durable-memory CORRUPTION surface against zero real load (an ADR 0024
 * §10 "don't build for imagined load" violation). The correct first move is
 * to MEASURE the op-type mix so a future build decision is data-driven.
 *
 * This locks the instrument: scanP15WatchdogSignals (via runSedimentAggregator)
 * now attributes each not-synthesizable skip to its Pass 1 op from the
 * structured `multi_view.pass1.op` audit field, returns pass1_op_type_breakdown,
 * and flips pass1_op_type_breakdown_available to true.
 *
 *   - empty audit → empty breakdown, available=true
 *   - seeded curator rows with decision.reason=multiview_pass1_op_not_synthesizable
 *     + multi_view.pass1.op ∈ {update,merge,...} → correct per-op counts
 *   - rows WITHOUT that skip reason → not counted
 *   - missing pass1.op on a matching row → counted as "unknown"
 *   - window cutoff respected
 *
 * Real module via jiti; project audit.jsonl sandboxed under a tmp projectRoot.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const aggregator = jiti(path.join(repoRoot, "extensions/sediment/aggregator.ts"));

// audit.jsonl lives at <projectRoot>/.pi-astack/sediment/audit.jsonl
function auditPath(projectRoot) {
  return path.join(projectRoot, ".pi-astack", "sediment", "audit.jsonl");
}
function seedAudit(projectRoot, rows) {
  const p = auditPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}
// A curator-audit row in the shape index.ts writes (curator: CuratorAudit[]).
function curatorRow(ts, entries) {
  return {
    ts,
    operation: "auto_write",
    lane: "A",
    curator: entries.map((e) => ({
      decision: { op: "skip", reason: e.reason, rationale: "x" },
      neighbors: [],
      stage_ms: { search: 0, decide: 0, total: 0 },
      ...(e.pass1op !== undefined
        ? { multi_view: { triggered: true, pass1: { model: "m", op: e.pass1op, durationMs: 1 } } }
        : e.noPass1
          ? { multi_view: { triggered: true } } // matching skip but NO pass1.op
          : {}),
    })),
  };
}

const NS = "multiview_pass1_op_not_synthesizable";
const settings = { autoLlmWriteEnabled: true };
const now = new Date();
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

// ── [1] empty audit → empty breakdown, available=true ─────────────────
console.log("\n[1] empty audit");
{
  const pr = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-p15-empty-"));
  try {
    const s = aggregator.runSedimentAggregator({ projectRoot: pr, settings, now });
    const w = s.p15_watchdog_signals;
    check("available flipped to true", w.pass1_op_type_breakdown_available === true);
    check("breakdown present + empty", w.pass1_op_type_breakdown && Object.keys(w.pass1_op_type_breakdown).length === 0, JSON.stringify(w.pass1_op_type_breakdown));
  } finally { try { fs.rmSync(pr, { recursive: true, force: true }); } catch {} }
}

// ── [2] seeded curator rows → correct per-op breakdown ────────────────
console.log("\n[2] op-typed breakdown from structured curator audit");
{
  const pr = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-p15-seed-"));
  try {
    seedAudit(pr, [
      // 2× update not-synthesizable, 1× merge, 1× supersede
      curatorRow(iso(60 * 1000), [{ reason: NS, pass1op: "update" }, { reason: NS, pass1op: "merge" }]),
      curatorRow(iso(120 * 1000), [{ reason: NS, pass1op: "update" }]),
      curatorRow(iso(180 * 1000), [{ reason: NS, pass1op: "supersede" }]),
      // a NON-matching skip reason (must NOT count)
      curatorRow(iso(200 * 1000), [{ reason: "curator_low_confidence", pass1op: "update" }]),
      // matching skip but NO pass1.op → "unknown"
      curatorRow(iso(220 * 1000), [{ reason: NS, noPass1: true }]),
      // a non-curator row (aggregator advisory) must be ignored gracefully
      { ts: iso(240 * 1000), operation: "aggregator_advisory", advisories: [] },
    ]);
    const s = aggregator.runSedimentAggregator({ projectRoot: pr, settings, now });
    const b = s.p15_watchdog_signals.pass1_op_type_breakdown;
    check("update counted twice", b.update === 2, JSON.stringify(b));
    check("merge counted once", b.merge === 1, JSON.stringify(b));
    check("supersede counted once", b.supersede === 1, JSON.stringify(b));
    check("non-matching skip reason NOT counted", b.update === 2 /* not 3 */, JSON.stringify(b));
    check("matching skip without pass1.op → unknown", b.unknown === 1, JSON.stringify(b));
    check("no spurious op keys", Object.keys(b).sort().join(",") === "merge,supersede,unknown,update", Object.keys(b).sort().join(","));
    // R1 P1 (GPT-5.5): the legacy COUNT drives the §6 >5/week trigger, so it
    // MUST also see current-shape curator[] rows (it previously only read the
    // old outcome/results shapes → would read 0 on real auto-write rows).
    check("legacy pass1_op_not_synthesizable_count reflects curator[] rows (=5, the trigger signal)",
      s.p15_watchdog_signals.pass1_op_not_synthesizable_count === 5, `count=${s.p15_watchdog_signals.pass1_op_not_synthesizable_count}`);
  } finally { try { fs.rmSync(pr, { recursive: true, force: true }); } catch {} }
}

// ── [3] window cutoff respected ───────────────────────────────────────
console.log("\n[3] window cutoff");
{
  const pr = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-p15-window-"));
  try {
    const old = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90d ago > 30d window
    seedAudit(pr, [
      curatorRow(iso(60 * 1000), [{ reason: NS, pass1op: "update" }]),
      curatorRow(old, [{ reason: NS, pass1op: "merge" }]), // outside default 30d window
    ]);
    const s = aggregator.runSedimentAggregator({ projectRoot: pr, settings, now, windowDays: 30 });
    const b = s.p15_watchdog_signals.pass1_op_type_breakdown;
    check("in-window update counted", b.update === 1, JSON.stringify(b));
    check("out-of-window merge NOT counted", b.merge === undefined, JSON.stringify(b));
  } finally { try { fs.rmSync(pr, { recursive: true, force: true }); } catch {} }
}

// ── [4] source-level intent locks ─────────────────────────────────────
console.log("\n[4] source locks");
{
  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf-8");
  check("aggregator flips pass1_op_type_breakdown_available to true", /pass1_op_type_breakdown_available:\s*true/.test(agg));
  check("aggregator no longer hardcodes available:false", !/pass1_op_type_breakdown_available:\s*false/.test(agg));
  check("breakdown sourced from structured multi_view.pass1.op", /multi_view[\s\S]{0,80}pass1[\s\S]{0,40}\.op/.test(agg) || /p1\?\.op/.test(agg));
}

console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) { console.log("FAILURES — investigate before commit"); process.exit(1); }
process.exit(0);
