#!/usr/bin/env node
/**
 * Smoke: ADR 0027 §C5 v1 R7 hole-materialization surface consistency
 *
 * R6 fixed the AGGREGATE terminal_state when `results[]` has holes (slots
 * the worker never claimed because parent signal fired before it could
 * `nextIdx++` to that index). But R6 only materialized holes inside the
 * `taskSummaries` array (input to inferParallelTerminalState). Every
 * OTHER downstream surface still saw the sparse `results[]` and emitted
 * caller-visible contradictions:
 *
 *   - details.tasks[hole].ok was TRUE  (because !undefined === true)
 *   - details.tasks[hole].terminalState was "failed"
 *     (yet aggregate said cancelled — inconsistent)
 *   - audit row `result: "ok"` with terminal_state: "cancelled" when all
 *     N slots were holes
 *   - markdown table SILENTLY SKIPPED holes — LLM saw header "3 tasks"
 *     but only 2 rows
 *   - serial_estimate_ms only counted ran tasks (underestimated)
 *
 * R7 fix: build ONE dense `materializedResults` array and use it
 * everywhere downstream. This smoke locks the dense-array invariants
 * against future regression.
 *
 * Strategy: same source-grep approach as smoke-c5-audit-row-schema.mjs.
 * Verifies the structural invariants in dispatch/index.ts source.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const dispatchSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/dispatch/index.ts"),
  "utf-8",
);

console.log("Section: dense materializedResults exists and is used everywhere");

check("materializedResults array is constructed via tasks.map (dense, no holes)", () => {
  // R7 invariant: dense array constructed via tasks.map iterating
  // tasks.length, providing a fallback when results[i] is undefined.
  if (!/const materializedResults:\s*AgentResult\[\]\s*=\s*tasks\.map/.test(dispatchSrc)) {
    throw new Error(
      "missing dense materializedResults array (R7 P1-A fix). " +
      "Without it, downstream surfaces see sparse results[] and produce " +
      "contradictory state for hole slots.",
    );
  }
});

check("hole fallback shape matches aborted task: failureType:'aborted' + error", () => {
  // The hole synthesis must produce a result that inferTerminalState()
  // classifies as cancelled (otherwise aggregate and per-task disagree).
  const block = dispatchSrc.match(
    /materializedResults:\s*AgentResult\[\][\s\S]{0,500}?return\s*{[^}]*failureType:\s*"aborted"[\s\S]*?\}/,
  );
  if (!block) {
    throw new Error("hole synthesis must set failureType:'aborted'");
  }
  if (!/error:\s*"task did not start/.test(block[0])) {
    throw new Error("hole synthesis must include explanatory error string");
  }
});

console.log("\nSection: aggregate audit row uses materializedResults consistently");

check("audit success_count derived from materializedResults", () => {
  // success_count must reflect dense array, not the in-flight `success`
  // counter (which never increments for un-claimed holes).
  const block = dispatchSrc.match(
    /operation:\s*"dispatch_parallel\.summary"[\s\S]{0,2000}?\}\s*\)\s*;/,
  );
  if (!block) throw new Error("could not locate aggregate audit block");
  // The counters in the row must be the materialized-derived ones.
  if (!/success_count:\s*successCount/.test(block[0])) {
    throw new Error("aggregate audit row must use successCount (derived from materializedResults), not the in-flight `success` counter");
  }
  if (!/failed_count:\s*failedCount/.test(block[0])) {
    throw new Error("aggregate audit row must use failedCount (derived from materializedResults)");
  }
});

check("legacy `result` derives from aggregate terminal_state (not raw failed counter)", () => {
  // R7 P1 fix: the legacy result field must be consistent with
  // terminal_state. Previously result:"ok" + terminal_state:"cancelled"
  // could co-occur on all-holes aggregate.
  if (!/aggregateLegacyResult\s*=\s*\n?\s*aggregateTsFields\.terminal_state\s*===\s*"completed"\s*\?\s*"ok"\s*:\s*"fail"/.test(dispatchSrc)) {
    throw new Error(
      "legacy `result` field must be derived from aggregate terminal_state, " +
      "not from `failed > 0` (which misses all-holes scenarios where failed===0 " +
      "yet terminal_state==='cancelled')",
    );
  }
});

check("serial_estimate_ms / max_single_ms use materializedResults", () => {
  // R7: holes contribute durationMs:0 to dense array; old code filtered
  // out holes entirely, underestimating the serial sum.
  const block = dispatchSrc.match(
    /operation:\s*"dispatch_parallel\.summary"[\s\S]{0,2000}?\}\s*\)\s*;/,
  );
  if (!block) throw new Error("could not locate aggregate audit block");
  if (!/serial_estimate_ms:\s*materializedResults\.reduce/.test(block[0])) {
    throw new Error("serial_estimate_ms must reduce over materializedResults (not filter sparse)");
  }
  if (!/max_single_ms:\s*Math\.max\(0,\s*\.\.\.materializedResults\.map/.test(block[0])) {
    throw new Error("max_single_ms must map over materializedResults");
  }
});

console.log("\nSection: details.tasks (caller-LLM-visible structured result)");

check("details.tasks builds from materializedResults (not raw results[])", () => {
  // Most caller-visible surface; gave the worst-case contradiction in R6.
  // Anchor to the dispatch_parallel_summary details block so we do not
  // accidentally inspect the progress snapshot initialization's tasks.map.
  const summaryStart = dispatchSrc.indexOf('kind: "dispatch_parallel_summary"');
  if (summaryStart < 0) throw new Error("could not locate dispatch_parallel_summary details block");
  const tasksStart = dispatchSrc.indexOf("tasks: tasks.map", summaryStart);
  if (tasksStart < 0) throw new Error("could not locate caller-visible details.tasks construction");
  const window = dispatchSrc.slice(tasksStart, tasksStart + 2500);
  if (!/const r = materializedResults\[i\]/.test(window)) {
    throw new Error(
      "details.tasks must dereference materializedResults[i], not results[i]?... " +
      "(R7 Opus P1-A + GPT-5.5 P1-1 + DeepSeek P2-1 fix)",
    );
  }
  if (!/ok:\s*!r\.error\b/.test(window)) {
    throw new Error("details.tasks ok flag must read !r.error from materialized result");
  }
  if (!/terminalState:\s*inferTerminalState\(r\)/.test(window)) {
    throw new Error("details.tasks terminalState must call inferTerminalState(r) where r is materialized");
  }
});

check("hasErrors derives from aggregate terminal_state", () => {
  // R7 fix: hasErrors must match the aggregate state, so isError tool
  // result flag fires for all non-completed outcomes (including all-holes).
  if (!/hasErrors\s*=\s*aggregateTsFields\.terminal_state\s*!==\s*"completed"/.test(dispatchSrc)) {
    throw new Error(
      "hasErrors must derive from aggregateTsFields.terminal_state, " +
      "not from results.some(r => r?.error) which misses all-holes scenarios",
    );
  }
});

check("details.success / details.failed match audit counters", () => {
  // Same counters everywhere — caller-visible and audit-visible must agree.
  // R7: the dispatch_parallel_summary details block grew (tasks: tasks.map
  // construction adds ~25 lines). Widen the regex window.
  const block = dispatchSrc.match(
    /kind:\s*"dispatch_parallel_summary"[\s\S]{0,3000}?\}\s*,/,
  );
  if (!block) throw new Error("could not locate dispatch_parallel_summary details");
  if (!/success:\s*successCount/.test(block[0])) {
    throw new Error("details.success must use successCount (consistent with audit)");
  }
  if (!/failed:\s*failedCount/.test(block[0])) {
    throw new Error("details.failed must use failedCount (consistent with audit)");
  }
});

console.log("\nSection: markdown output shows hole tasks (does not silently skip)");

check("table loop iterates materializedResults, not raw results", () => {
  // R7 DeepSeek P2-3 fix: previously `for (let i = 0; i < results.length; i++) { if (!r) continue; }`
  // silently skipped holes, so the LLM saw "3 tasks" header but only 2
  // rows in the table. Now must iterate the dense array. Window widened
  // to accommodate the R7 explanatory comment.
  const tableLoop = dispatchSrc.match(
    /\| # \| Model \| Duration \| Status \|[\s\S]{0,1500}?for \(let i = 0;[\s\S]{0,200}?materializedResults\.length/,
  );
  if (!tableLoop) {
    throw new Error(
      "could not locate markdown table loop iterating materializedResults.length " +
      "(R7 DeepSeek P2-3 fix). table must show hole tasks, not silently skip them.",
    );
  }
});

check("table assigns 🚫 prefix for cancelled tasks (distinct from ❌ failed)", () => {
  // R7 R6-DeepSeek-P2-3 visual cue: cancelled (holes / abort / timeout)
  // should render differently from failed so the caller LLM can
  // distinguish "you cancelled this" from "this broke".
  if (!/status\s*=\s*`🚫/.test(dispatchSrc)) {
    throw new Error("table must assign 🚫 prefix when inferTerminalState(r) === 'cancelled'");
  }
});

check("per-task detail section iterates materializedResults", () => {
  // Same fix as table: don't skip holes.
  // The second loop after the table. Find the `### N. modelName` rendering.
  const detailLoop = dispatchSrc.match(
    /for \(let i = 0;\s*i\s*<\s*materializedResults\.length[\s\S]{0,300}?lines\.push\(`###/,
  );
  if (!detailLoop) {
    throw new Error("per-task detail loop must iterate materializedResults.length");
  }
});

check("per-task detail uses 🚫 for cancelled (matches table)", () => {
  // Detail section must be consistent with the table prefix; previously
  // R7 left it as ❌ for all errors, including cancelled.
  if (!/detailTs === "cancelled" \? "🚫"/.test(dispatchSrc)) {
    throw new Error("per-task detail must use 🚫 prefix when terminal_state is cancelled (matches table)");
  }
});

console.log("\nSection: dispatch_agent row_kind symmetry (DeepSeek NIT-1)");

check("dispatch_agent normal-path audit carries row_kind:'task'", () => {
  // dispatch_parallel.task and .summary both carry row_kind. dispatch_agent
  // is logically a single task and should match (R7 DeepSeek NIT-1 fix).
  // Count occurrences of operation:"dispatch_agent" followed within 1500
  // chars by row_kind:"task". The lazy regex captures both write sites.
  let count = 0;
  const re = /operation:\s*"dispatch_agent"[\s\S]{0,1500}?row_kind:\s*"task"/g;
  while (re.exec(dispatchSrc) !== null) count++;
  if (count < 2) {
    throw new Error(
      `expected ≥2 dispatch_agent audit sites each with row_kind:"task" " +
      "(normal + tool_rejected); found ${count}. " +
      "DeepSeek NIT-1 fix: dispatch_agent symmetry with dispatch_parallel.task."`,
    );
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all C5 hole-materialization invariants hold`);
