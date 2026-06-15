#!/usr/bin/env node
/**
 * Smoke: Outcome→Entry feedback edge, M3 read-only proposal sidecar.
 *
 * Locks the pure-INFRA / observation-only contract of
 * extensions/sediment/entry-lifecycle-proposals.ts:
 *   - no promoted advisory carries a lifecycle_proposal → no-op (no file)
 *   - a promoted advisory WITH lifecycle_proposal → one pending row, fields intact
 *   - promoted advisories WITHOUT a proposal are NOT written (carriers only)
 *   - demoted_signals are NOT a source (the function only takes `promoted`)
 *   - rows are project-scoped; appends accumulate across runs
 *   - corrupt sidecar lines tolerated
 *   - HARD BOUNDARY (prompt §8): never imports writer/curator/multi-view; never
 *     writes durable markdown; status is always "pending" (M3 never executes)
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
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, moduleResolution: ts.ModuleResolutionKind.NodeJs,
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
  Module._load = function patched(request, parent, ...rest) {
    if (stubMap.has(request)) return stubMap.get(request);
    return origLoad.call(this, request, parent, ...rest);
  };
  try { m._compile(code, fakePath); } finally { Module._load = origLoad; }
  return m.exports;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-proposals-smoke-"));
const ledgerDir = path.join(tmpDir, "abrain", ".state", "sediment");
fs.mkdirSync(ledgerDir, { recursive: true });
const projectA = path.join(tmpDir, "project-a");
const projectB = path.join(tmpDir, "project-b");

const runtimeStub = {
  ensureUserGlobalSidecarMigrated: () => {},
  formatLocalIsoTimestamp: (d) => (d ?? new Date()).toISOString(),
  userGlobalSedimentDir: () => ledgerDir,
};
const causalAnchorStub = {
  getCurrentAnchor: () => ({ session_id: "smoke", turn_id: 0 }),
  spreadAnchor: (a) => (a ? { session_id: a.session_id, turn_id: a.turn_id } : {}),
};
// entry-lifecycle-proposals.ts persists via ../_shared/sync-file-lock
// (withFileLock + atomicWriteText). Stub with real-equivalent behaviour:
// withFileLock runs fn inline and returns { ok, value }; atomicWriteText
// writes the file so readLifecycleProposals can read it back.
const syncFileLockStub = {
  withFileLock: (_lockPath, fn) => ({ ok: true, value: fn() }),
  atomicWriteText: (file, content) => fs.writeFileSync(file, content),
};

const modulePath = path.join(repoRoot, "extensions/sediment/entry-lifecycle-proposals.ts");
const mod = loadCJS(transpile(modulePath), path.join(tmpDir, "entry-lifecycle-proposals.cjs"), new Map([
  ["../_shared/runtime", runtimeStub],
  ["../_shared/causal-anchor", causalAnchorStub],
  ["../_shared/sync-file-lock", syncFileLockStub],
]));
const { entryLifecycleProposalsPath, appendLifecycleProposals, readLifecycleProposals } = mod;

function promotedWithProposal(slug, op, reason) {
  return {
    kind: "outcome_entry", severity: "warning", slug, message: `msg for ${slug}`,
    reasoning: "r", falsifier: "f", evidence_quotes: ["q"],
    lifecycle_proposal: { op, reason, independent_evidence: `superseded evidence for ${slug}`, falsifier: "would retract if X" },
  };
}
function promotedNoProposal(slug) {
  return { kind: "outcome_entry", severity: "info", slug, message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [] };
}

console.log("Smoke: entry-lifecycle-proposals M3 read-only sink\n");

check("no proposal-carrying advisory → no-op, no file created", () => {
  const r = appendLifecycleProposals({ projectRoot: projectA, promoted: [promotedNoProposal("plain-1"), promotedNoProposal("plain-2")], now: new Date("2026-06-04T10:00:00Z") });
  if (!r.ok || r.written !== false || r.proposals_appended !== 0) throw new Error(`expected no-op, got ${JSON.stringify(r)}`);
  if (fs.existsSync(entryLifecycleProposalsPath())) throw new Error("no-op must not create the sidecar file");
});

check("a promoted advisory WITH lifecycle_proposal yields one pending row, fields intact", () => {
  const r = appendLifecycleProposals({
    projectRoot: projectA,
    promoted: [promotedNoProposal("plain"), promotedWithProposal("stale-entry", "archive", "affirm_superseded")],
    now: new Date("2026-06-04T11:00:00Z"),
  });
  if (!r.ok || !r.written || r.proposals_appended !== 1) throw new Error(`expected 1 appended, got ${JSON.stringify(r)}`);
  const rows = readLifecycleProposals(projectA);
  if (rows.length !== 1) throw new Error(`expected 1 row (carriers only), got ${rows.length}`);
  const row = rows[0];
  if (row.slug !== "stale-entry" || row.op !== "archive" || row.reason !== "affirm_superseded") throw new Error(`fields wrong: ${JSON.stringify(row)}`);
  if (row.status !== "pending") throw new Error("M3 must emit status=pending (never executes)");
  if (!row.independent_evidence.includes("superseded evidence") || !row.falsifier) throw new Error("evidence/falsifier lost");
  if (row.message !== "msg for stale-entry") throw new Error("message context lost");
});

check("promoted advisories without a proposal are never written", () => {
  // Re-running with only plain advisories appends nothing new.
  const before = readLifecycleProposals(projectA).length;
  const r = appendLifecycleProposals({ projectRoot: projectA, promoted: [promotedNoProposal("x"), promotedNoProposal("y")], now: new Date("2026-06-04T11:05:00Z") });
  if (r.written !== false || r.proposals_appended !== 0) throw new Error(`plain advisories must not append, got ${JSON.stringify(r)}`);
  if (readLifecycleProposals(projectA).length !== before) throw new Error("row count changed for plain-only run");
});

check("appends accumulate across runs", () => {
  appendLifecycleProposals({ projectRoot: projectA, promoted: [promotedWithProposal("contested-entry", "contest", "affirm_echo_chamber")], now: new Date("2026-06-04T12:00:00Z") });
  const rows = readLifecycleProposals(projectA);
  if (rows.length !== 2) throw new Error(`expected 2 accumulated rows, got ${rows.length}`);
  if (!rows.some((r) => r.slug === "stale-entry") || !rows.some((r) => r.slug === "contested-entry")) throw new Error("accumulation lost a prior row");
});

check("rows are project-scoped", () => {
  appendLifecycleProposals({ projectRoot: projectB, promoted: [promotedWithProposal("b-entry", "supersede", "affirm_superseded")], now: new Date("2026-06-04T12:10:00Z") });
  const a = readLifecycleProposals(projectA);
  const b = readLifecycleProposals(projectB);
  if (a.some((r) => r.slug === "b-entry")) throw new Error("project A leaked project B row");
  if (b.length !== 1 || b[0].slug !== "b-entry") throw new Error(`project B scope wrong: ${JSON.stringify(b)}`);
  if (readLifecycleProposals().length < 3) throw new Error("global read should see all projects");
});

check("corrupt sidecar lines are tolerated and cleaned on next write", () => {
  fs.appendFileSync(entryLifecycleProposalsPath(), "{not valid json\n\n");
  const survived = readLifecycleProposals(projectA).length; // read ignores corrupt line
  if (survived < 2) throw new Error("read must ignore corrupt line, not crash");
  appendLifecycleProposals({ projectRoot: projectA, promoted: [promotedWithProposal("cleanup", "archive", "affirm_stale")], now: new Date("2026-06-04T12:20:00Z") });
  if (fs.readFileSync(entryLifecycleProposalsPath(), "utf8").includes("{not valid json")) throw new Error("next write should rewrite clean JSONL");
});

console.log("\nSource-level boundary guards (§8 Observation ≠ Authorization)");

check("entry-lifecycle-proposals never imports/calls writer / curator / multi-view", () => {
  const src = fs.readFileSync(modulePath, "utf8");
  for (const forbidden of ["./writer", "./curator", "./multi-view", "updateProjectEntry", "archiveProjectEntry", "supersedeProjectEntry", "runMultiView", "writeProjectEntry"]) {
    if (src.includes(forbidden)) throw new Error(`M3 sink must not reference ${forbidden} (observation only)`);
  }
  if (/writeFileSync\([^)]*\.md/.test(src)) throw new Error("M3 sink must not write any .md file");
});

check("aggregator.ts sources proposals from promoted_advisories, never demoted_signals", () => {
  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf8");
  const m = agg.match(/appendLifecycleProposals\(\{[\s\S]*?\}\);/);
  if (!m) throw new Error("aggregator.ts must call appendLifecycleProposals");
  if (!/promoted:\s*promptNative\.promoted_advisories/.test(m[0])) throw new Error("proposals must be sourced from promoted_advisories");
  if (/demoted_signals/.test(m[0])) throw new Error("proposals must NOT be sourced from demoted_signals (exoneration channel)");
});

check("aggregator wires M3 only inside the prompt_native_v1 gate", () => {
  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf8");
  const gate = /if \(aggregatorEngine === "prompt_native_v1" && promptNative\) \{[\s\S]*?appendLifecycleProposals\(/m;
  if (!gate.test(agg)) throw new Error("appendLifecycleProposals must stay gated on successful prompt_native_v1 output");
});

console.log(`\nTotal: ${total}  Passed: ${total - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — entry-lifecycle-proposals M3 contract drifted.");
  process.exit(1);
}
