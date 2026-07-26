#!/usr/bin/env node
/**
 * Production acceptance for outcome-evidence index rebuild isolation.
 *
 * Uses the real ~/.abrain L1 corpus (read-only canonical events). The only
 * write target is the derived outcome-evidence-index under .state/sediment
 * (rebuildable L3/read-model). Canonical L1 is never modified.
 *
 * Records: child wall time, parent event-loop tick count during await,
 * candidates processed, rows written. Fails if the parent event loop freezes
 * or candidate count is below the known production floor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const outcome = jiti(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));

const abrainHome = path.resolve(process.env.ABRAIN_HOME || path.join(process.env.HOME || os.homedir(), ".abrain"));
const eventsRoot = path.join(abrainHome, "l1", "events", "sha256");
const indexPath = outcome.outcomeEvidenceIndexPath(abrainHome);

if (!fs.existsSync(eventsRoot)) {
  console.error(`FAIL production L1 events root missing: ${eventsRoot}`);
  process.exit(2);
}

// Production floor from the live corpus that motivated this isolation work.
const EXPECTED_MIN_CANDIDATES = Number(process.env.OUTCOME_INDEX_MIN_CANDIDATES || 10005);
const TICK_MS = 20;

function countEventFiles(root) {
  let count = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) count += 1;
    }
  };
  walk(root);
  return count;
}

const onDiskFiles = countEventFiles(eventsRoot);
console.log(JSON.stringify({
  phase: "preflight",
  abrainHome,
  eventsRoot,
  indexPath,
  on_disk_event_files: onDiskFiles,
  expected_min_candidates: EXPECTED_MIN_CANDIDATES,
  note: "derived index only; canonical L1 is read-only for this bench",
}, null, 2));

if (onDiskFiles < EXPECTED_MIN_CANDIDATES) {
  console.error(`FAIL on-disk event files ${onDiskFiles} < expected floor ${EXPECTED_MIN_CANDIDATES}`);
  process.exit(2);
}

// Snapshot index mtime/size for post-condition (derived only).
const indexBefore = fs.existsSync(indexPath)
  ? { exists: true, bytes: fs.statSync(indexPath).size, sha_prefix: fs.readFileSync(indexPath, "utf8").slice(0, 64) }
  : { exists: false, bytes: 0, sha_prefix: "" };

let ticks = 0;
const ticker = setInterval(() => { ticks += 1; }, TICK_MS);
let gates = 0;
let gating = true;
const gate = () => {
  if (!gating) return;
  gates += 1;
  setImmediate(gate);
};
setImmediate(gate);

const parentStarted = Date.now();
const rebuilt = await outcome.rebuildOutcomeEvidenceIndexIsolated(abrainHome);
const parentElapsed = Date.now() - parentStarted;
gating = false;
clearInterval(ticker);

const indexAfter = fs.existsSync(indexPath)
  ? { exists: true, bytes: fs.statSync(indexPath).size, lines: fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean).length }
  : { exists: false, bytes: 0, lines: 0 };

// Canonical L1 must remain untouched: recount files and ensure path still is a directory tree only of events.
const onDiskAfter = countEventFiles(eventsRoot);

const report = {
  phase: "result",
  ok: rebuilt.ok === true,
  mode: rebuilt.mode,
  child_pid: rebuilt.child_pid,
  parent_pid: process.pid,
  child_wall_time_ms: rebuilt.wall_time_ms,
  parent_await_wall_time_ms: parentElapsed,
  event_loop_ticks: ticks,
  event_loop_gates: gates,
  tick_interval_ms: TICK_MS,
  candidates: rebuilt.candidates,
  rows: rebuilt.rows,
  diagnostics_total: rebuilt.diagnostics_total,
  diagnostics_truncated: rebuilt.diagnostics_truncated,
  error: rebuilt.error ?? null,
  exit_code: rebuilt.exit_code ?? null,
  stderr_bytes: Buffer.byteLength(rebuilt.stderr || ""),
  index_before: indexBefore,
  index_after: indexAfter,
  l1_event_files_before: onDiskFiles,
  l1_event_files_after: onDiskAfter,
  l1_unchanged_file_count: onDiskFiles === onDiskAfter,
};

console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!rebuilt.ok) failures.push(`rebuild not ok: ${rebuilt.error}`);
if (rebuilt.mode !== "child") failures.push("mode must be child");
if (!(typeof rebuilt.child_pid === "number" && rebuilt.child_pid > 0 && rebuilt.child_pid !== process.pid)) {
  failures.push(`child_pid invalid: ${rebuilt.child_pid}`);
}
if (!(rebuilt.candidates >= EXPECTED_MIN_CANDIDATES)) {
  failures.push(`candidates ${rebuilt.candidates} < floor ${EXPECTED_MIN_CANDIDATES}`);
}
if (onDiskFiles !== onDiskAfter) {
  failures.push(`canonical L1 event file count changed: ${onDiskFiles} -> ${onDiskAfter}`);
}
// Parent event loop must keep advancing for multi-second production rebuilds.
// Expect at least ~25% of theoretical ticks (rebuild ~seconds; 20ms ticker).
const minTicks = Math.max(10, Math.floor((parentElapsed / TICK_MS) * 0.25));
if (ticks < minTicks) {
  failures.push(`event loop appears frozen: ticks=${ticks}, minTicks=${minTicks}, parentElapsed=${parentElapsed}`);
}
if (gates < minTicks) {
  failures.push(`setImmediate gate appears frozen: gates=${gates}, minTicks=${minTicks}`);
}
if (!indexAfter.exists || indexAfter.lines !== rebuilt.rows) {
  failures.push(`derived index lines ${indexAfter.lines} != rows ${rebuilt.rows}`);
}

if (failures.length) {
  console.error("FAIL production isolation acceptance:");
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log("PASS production outcome-evidence index isolation acceptance");
