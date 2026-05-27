#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R1 P1-12 — per-turn token-spend attribution.
 *
 * Verifies `scanPerTurnCost()` correctly:
 *   - aggregates rows from multiple sidecar files by (session_id, turn_id)
 *   - sums tokens_in / tokens_out / estimated_tokens
 *   - counts operations per turn
 *   - filters rows older than cutoff
 *   - skips rows missing anchor (counts as unattributed)
 *   - produces top-N burner list correctly
 *   - histogram buckets work
 *   - tracks subturn count from sub-agent rows
 *
 * Why this smoke matters: P1-12 is the metric prerequisite for any
 * future cost-attribution work (P1-9 multi-view dead-loop cost
 * verification needs baseline tokens-per-turn). The aggregator runs at
 * agent_end (daily-gated); this rollup must be accurate or downstream
 * cost-optimization decisions will be wrong.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

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

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  }).outputText;
}

function loadCJS(code, fakePath, stubMap) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const origLoad = Module._load;
  if (stubMap) {
    Module._load = function patched(request, parent, ...rest) {
      if (stubMap.has(request)) return stubMap.get(request);
      return origLoad.call(this, request, parent, ...rest);
    };
  }
  try {
    m._compile(code, fakePath);
  } finally {
    if (stubMap) Module._load = origLoad;
  }
  return m.exports;
}

// ── Setup ──────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "per-turn-cost-"));
const projectRoot = path.join(tmpDir, "project");
const userGlobalDir = path.join(tmpDir, "global-sediment");
fs.mkdirSync(path.join(projectRoot, ".pi-astack/sediment"), { recursive: true });
fs.mkdirSync(path.join(projectRoot, ".pi-astack/dispatch"), { recursive: true });
fs.mkdirSync(path.join(projectRoot, ".pi-astack/memory"), { recursive: true });
fs.mkdirSync(userGlobalDir, { recursive: true });

// Stub runtime paths to point inside tmpDir
const runtimeStub = {
  sedimentAuditPath: (root) => path.join(root, ".pi-astack/sediment/audit.jsonl"),
  dispatchAuditPath: (root) => path.join(root, ".pi-astack/dispatch/audit.jsonl"),
  memorySearchMetricsPath: (root) => path.join(root, ".pi-astack/memory/search-metrics.jsonl"),
  userGlobalSedimentDir: () => userGlobalDir,
  ensureUserGlobalSidecarMigrated: async () => {},
};

const ptcSrc = path.join(repoRoot, "extensions/sediment/per-turn-cost.ts");
const ptcCjs = transpile(ptcSrc);
const ptcPath = path.join(tmpDir, "per-turn-cost.cjs");
fs.writeFileSync(ptcPath, ptcCjs);
const ptc = loadCJS(
  ptcCjs,
  ptcPath,
  new Map([["../_shared/runtime", runtimeStub]]),
);
const { scanPerTurnCost, PER_TURN_HISTOGRAM_BUCKETS } = ptc;

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const NOW = Date.parse("2026-05-27T12:00:00Z");
const YESTERDAY = "2026-05-26T10:00:00Z";
const TODAY = "2026-05-27T11:30:00Z";
const TOO_OLD = "2026-05-20T08:00:00Z"; // 7 days old

const CUTOFF_24H = NOW - 24 * 60 * 60 * 1000;

console.log("per-turn cost attribution (ADR 0027 PR-B+ R1 P1-12)");

// ── Tests ──────────────────────────────────────────────────────

check("empty inputs → 0 turns considered, no failures", () => {
  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 0) throw new Error(`expected 0 turns, got ${result.turns_considered}`);
  if (result.rows_attributed !== 0) throw new Error(`expected 0 attributed`);
  if (result.top_burners.length !== 0) throw new Error(`expected 0 top burners`);
});

check("single extractor row → 1 turn, 1 op, estimated_tokens summed", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    {
      timestamp: TODAY,
      session_id: "s1",
      turn_id: 5,
      estimatedTokens: 1500,
      ok: true,
    },
  ]);
  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 1) throw new Error(`expected 1 turn, got ${result.turns_considered}`);
  if (result.totals.estimated_tokens !== 1500) {
    throw new Error(`expected 1500 tokens, got ${result.totals.estimated_tokens}`);
  }
  if (result.totals.operations.extractor !== 1) {
    throw new Error(`expected 1 extractor op, got ${JSON.stringify(result.totals.operations)}`);
  }
});

check("rows older than cutoff are skipped", () => {
  // Reset
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TOO_OLD, session_id: "s-old", turn_id: 1, estimatedTokens: 9999 },
    { timestamp: TODAY, session_id: "s-new", turn_id: 1, estimatedTokens: 100 },
  ]);
  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 1) {
    throw new Error(`expected 1 turn (old filtered), got ${result.turns_considered}`);
  }
  if (result.totals.estimated_tokens !== 100) {
    throw new Error(`old turn tokens leaked: ${result.totals.estimated_tokens}`);
  }
});

check("rows missing anchor → counted as unattributed, not in turns", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "s1", turn_id: 1, estimatedTokens: 50 },
    { timestamp: TODAY, estimatedTokens: 200 }, // no anchor
    { timestamp: TODAY, session_id: "s1", estimatedTokens: 100 }, // half-anchor
    { timestamp: TODAY, turn_id: 5, estimatedTokens: 300 }, // half-anchor
  ]);
  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.rows_attributed !== 1) {
    throw new Error(`expected 1 attributed, got ${result.rows_attributed}`);
  }
  if (result.rows_unattributed !== 3) {
    throw new Error(`expected 3 unattributed, got ${result.rows_unattributed}`);
  }
  if (result.totals.estimated_tokens !== 50) {
    throw new Error(`unattributed tokens leaked into total: ${result.totals.estimated_tokens}`);
  }
});

check("turn_id=0 is valid (first turn), not filtered as falsy", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "s1", turn_id: 0, estimatedTokens: 42 },
  ]);
  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 1) {
    throw new Error(`turn_id=0 should count, got ${result.turns_considered}`);
  }
  if (result.totals.estimated_tokens !== 42) {
    throw new Error(`turn_id=0 tokens lost`);
  }
});

check("dispatch audit rows: tokens_in + tokens_out summed", () => {
  // clear extractor metrics
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), [
    {
      timestamp: TODAY,
      session_id: "s1",
      turn_id: 3,
      operation: "dispatch_agent",
      tokens_in: 5000,
      tokens_out: 1200,
      result: "ok",
    },
    {
      timestamp: TODAY,
      session_id: "s1",
      turn_id: 3,
      subturn: 1,
      operation: "dispatch_parallel.task",
      tokens_in: 3000,
      tokens_out: 800,
    },
  ]);
  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.totals.tokens_in !== 8000) {
    throw new Error(`expected 8000 in, got ${result.totals.tokens_in}`);
  }
  if (result.totals.tokens_out !== 2000) {
    throw new Error(`expected 2000 out, got ${result.totals.tokens_out}`);
  }
});

check("multiple sources combine into same (session, turn) bucket", () => {
  // Reset all sources for clean state
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "S", turn_id: 7, estimatedTokens: 1000 },
  ]);
  writeJsonl(path.join(userGlobalDir, "curator-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "S", turn_id: 7, estimatedTokens: 500 },
  ]);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), [
    {
      timestamp: TODAY,
      session_id: "S",
      turn_id: 7,
      operation: "dispatch_agent",
      tokens_in: 200,
      tokens_out: 100,
    },
  ]);
  writeJsonl(path.join(projectRoot, ".pi-astack/memory/search-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "S", turn_id: 7 }, // no tokens, just a search
  ]);

  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 1) {
    throw new Error(`expected 1 turn (S, 7), got ${result.turns_considered}`);
  }
  if (result.totals.estimated_tokens !== 1500) {
    throw new Error(`expected 1500 est, got ${result.totals.estimated_tokens}`);
  }
  if (result.totals.tokens_in !== 200 || result.totals.tokens_out !== 100) {
    throw new Error(`dispatch tokens not aggregated`);
  }
  // Operations: extractor=1 + curator=1 + dispatch_agent=1 + memory_search=1 = 4
  const total = Object.values(result.totals.operations).reduce((a, b) => a + b, 0);
  if (total !== 4) {
    throw new Error(`expected 4 ops total, got ${total}: ${JSON.stringify(result.totals.operations)}`);
  }
});

check("different (session, turn) keys → separate buckets", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "A", turn_id: 1, estimatedTokens: 100 },
    { timestamp: TODAY, session_id: "A", turn_id: 2, estimatedTokens: 200 },
    { timestamp: TODAY, session_id: "B", turn_id: 1, estimatedTokens: 300 },
  ]);
  writeJsonl(path.join(userGlobalDir, "curator-metrics.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/memory/search-metrics.jsonl"), []);

  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 3) {
    throw new Error(`expected 3 turns, got ${result.turns_considered}`);
  }
  if (result.totals.estimated_tokens !== 600) {
    throw new Error(`expected 600 total, got ${result.totals.estimated_tokens}`);
  }
});

check("top_burners ordered by total descending", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "L", turn_id: 1, estimatedTokens: 100 },    // low
    { timestamp: TODAY, session_id: "M", turn_id: 1, estimatedTokens: 5000 },   // medium
    { timestamp: TODAY, session_id: "H", turn_id: 1, estimatedTokens: 50000 },  // high
    { timestamp: TODAY, session_id: "X", turn_id: 1, estimatedTokens: 10 },     // tiny
  ]);
  writeJsonl(path.join(userGlobalDir, "curator-metrics.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/memory/search-metrics.jsonl"), []);

  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H, topN: 3 });
  if (result.top_burners.length !== 3) {
    throw new Error(`expected 3 burners, got ${result.top_burners.length}`);
  }
  if (result.top_burners[0].session_id !== "H") {
    throw new Error(`expected H at top, got ${result.top_burners[0].session_id}`);
  }
  if (result.top_burners[1].session_id !== "M") {
    throw new Error(`expected M second, got ${result.top_burners[1].session_id}`);
  }
  if (result.top_burners[2].session_id !== "L") {
    throw new Error(`expected L third (excluding X), got ${result.top_burners[2].session_id}`);
  }
});

check("histogram bucket distribution", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "s1", turn_id: 1, estimatedTokens: 5 },     // [0,10)
    { timestamp: TODAY, session_id: "s1", turn_id: 2, estimatedTokens: 50 },    // [10,100)
    { timestamp: TODAY, session_id: "s1", turn_id: 3, estimatedTokens: 500 },   // [100,1k)
    { timestamp: TODAY, session_id: "s1", turn_id: 4, estimatedTokens: 5000 },  // [1k,10k)
    { timestamp: TODAY, session_id: "s1", turn_id: 5, estimatedTokens: 50000 }, // [10k,100k)
    { timestamp: TODAY, session_id: "s1", turn_id: 6, estimatedTokens: 500000 },// [100k,∞)
  ]);
  writeJsonl(path.join(userGlobalDir, "curator-metrics.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/memory/search-metrics.jsonl"), []);

  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  // Expected: each bucket has exactly 1 entry (6 buckets including overflow)
  if (result.estimated_tokens_histogram.length !== PER_TURN_HISTOGRAM_BUCKETS.length + 1) {
    throw new Error(`unexpected histogram length ${result.estimated_tokens_histogram.length}`);
  }
  for (let i = 0; i < result.estimated_tokens_histogram.length; i++) {
    if (result.estimated_tokens_histogram[i] !== 1) {
      throw new Error(`bucket ${i}: expected 1, got ${result.estimated_tokens_histogram[i]} (full: ${JSON.stringify(result.estimated_tokens_histogram)})`);
    }
  }
});

check("subturn count tracked from sub-agent rows", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), []);
  writeJsonl(path.join(userGlobalDir, "curator-metrics.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), [
    { timestamp: TODAY, session_id: "s1", turn_id: 9, subturn: 1, operation: "dispatch_parallel.task" },
    { timestamp: TODAY, session_id: "s1", turn_id: 9, subturn: 2, operation: "dispatch_parallel.task" },
    { timestamp: TODAY, session_id: "s1", turn_id: 9, subturn: 3, operation: "dispatch_parallel.task" },
  ]);
  writeJsonl(path.join(projectRoot, ".pi-astack/memory/search-metrics.jsonl"), []);

  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.turns_considered !== 1) {
    throw new Error(`expected 1 turn (subturns fold into parent), got ${result.turns_considered}`);
  }
  if (result.top_burners[0].operations["dispatch_parallel.task"] !== 3) {
    throw new Error(`expected 3 task ops`);
  }
});

check("estimated_tokens_by_operation: extractor-only", () => {
  writeJsonl(path.join(userGlobalDir, "extractor-metrics.jsonl"), [
    { timestamp: TODAY, session_id: "s1", turn_id: 1, estimatedTokens: 1000 },
  ]);
  writeJsonl(path.join(userGlobalDir, "curator-metrics.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/dispatch/audit.jsonl"), []);
  writeJsonl(path.join(projectRoot, ".pi-astack/memory/search-metrics.jsonl"), []);

  const result = scanPerTurnCost({ projectRoot, cutoffMs: CUTOFF_24H });
  if (result.estimated_tokens_by_operation.extractor !== 1000) {
    throw new Error(`expected extractor=1000, got ${JSON.stringify(result.estimated_tokens_by_operation)}`);
  }
});

// ── Cleanup ────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ per-turn cost attribution: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ per-turn cost attribution: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
