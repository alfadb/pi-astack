#!/usr/bin/env node
/**
 * Smoke: Outcome→Entry feedback edge, Tier-A telemetry sidecar.
 *
 * Locks the pure-INFRA contract of extensions/sediment/entry-telemetry.ts:
 *   - empty cited-slug set is a no-op (no file written)
 *   - cumulative citation_count counts explicit memory-footnote rows only;
 *     path-a-implicit is rolling unused baseline, not a citation; total_retrievals
 *     sums tool-result retrieval_count; first/last_cited_at track ts extremes
 *   - 30d rolling fields are delegated to summarizeEntryActivity and mapped
 *   - possible_echo_chamber fires on decisive_streak >= 5
 *   - executor-owned hysteresis fields are PRESERVED across merges
 *   - merge is idempotent w.r.t. the ledger (same numbers on re-run)
 *   - project scoping: merging project B never disturbs project A's rows
 *   - corrupt sidecar lines are tolerated, not fatal
 *   - HARD BOUNDARY: never imports writer/curator/multi-view; never writes
 *     durable frontmatter (source-level guard)
 *
 * outcome-collector is stubbed so this is a true unit test of entry-telemetry's
 * own logic (cumulative counting / rolling mapping / preservation / scoping).
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
  Module._load = function patched(request, parent, ...rest) {
    if (stubMap.has(request)) return stubMap.get(request);
    return origLoad.call(this, request, parent, ...rest);
  };
  try { m._compile(code, fakePath); } finally { Module._load = origLoad; }
  return m.exports;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-telemetry-smoke-"));
const ledgerDir = path.join(tmpDir, "abrain", ".state", "sediment");
fs.mkdirSync(ledgerDir, { recursive: true });
const projectA = path.join(tmpDir, "project-a");
const projectB = path.join(tmpDir, "project-b");

// ── outcome-collector stub (controlled inputs) ──────────────────────────────
const stub = {
  rowsByProject: new Map(),   // resolved projectRoot -> LedgerOutcomeRow[]
  activityBySlug: new Map(),  // slug -> EntryActivityStats override
};
const outcomeCollectorStub = {
  readProjectOutcomeRows: (projectRoot) => stub.rowsByProject.get(path.resolve(projectRoot)) ?? [],
  summarizeEntryActivity: (rows, slugs) =>
    slugs.map((slug) => stub.activityBySlug.get(slug) ?? {
      slug, decisive_count: 0, confirmatory_count: 0, retrieved_unused_count: 0,
      decisive_streak: 0, possible_echo_chamber: false, total_retrievals: 0,
    }),
};
const runtimeStub = {
  ensureUserGlobalSidecarMigrated: () => {},
  formatLocalIsoTimestamp: (d) => (d ?? new Date()).toISOString(),
  userGlobalSedimentDir: () => ledgerDir,
};
const causalAnchorStub = {
  getCurrentAnchor: () => ({ session_id: "smoke", turn_id: 0 }),
  spreadAnchor: (a) => (a ? { session_id: a.session_id, turn_id: a.turn_id } : {}),
};

const modulePath = path.join(repoRoot, "extensions/sediment/entry-telemetry.ts");
const moduleCjs = transpile(modulePath);
const telemetry = loadCJS(moduleCjs, path.join(tmpDir, "entry-telemetry.cjs"), new Map([
  ["../_shared/runtime", runtimeStub],
  ["../_shared/causal-anchor", causalAnchorStub],
  ["./outcome-collector", outcomeCollectorStub],
]));

const { entryTelemetryPath, mergeEntryTelemetry, readEntryTelemetry, getEntryTelemetry } = telemetry;

function fnRow(slug, used, tsIso, project_root) {
  return { source: "memory-footnote", entry_slug: slug, used, ts: tsIso, project_root };
}
function toolRow(slug, count, tsIso, project_root) {
  return { source: "tool-result", entry_slug: slug, retrieval_count: count, ts: tsIso, project_root };
}
function implicitRow(slug, tsIso, project_root) {
  return { source: "path-a-implicit", entry_slug: slug, retrieval_count: 1, ts: tsIso, project_root, path_a_inject_id: "path-a-smoke", path_a_signal: "injected_no_self_report" };
}
function rowsFor(project) { return readEntryTelemetry(project); }
function rowOf(project, slug) {
  const r = getEntryTelemetry(project, slug);
  if (!r) throw new Error(`missing telemetry row for ${slug}`);
  return r;
}

console.log("Smoke: entry-telemetry Tier-A sidecar\n");

check("empty cited-slug set is a no-op, no file created", () => {
  stub.rowsByProject.clear(); stub.activityBySlug.clear();
  stub.rowsByProject.set(path.resolve(projectA), []);
  const r = mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T10:00:00Z") });
  if (!r.ok || r.written !== false || r.slugs_considered !== 0) throw new Error(`expected no-op, got ${JSON.stringify(r)}`);
  if (fs.existsSync(entryTelemetryPath())) throw new Error("no-op must not create the sidecar file");
});

check("cumulative citation_count + total_retrievals + cited-at extremes", () => {
  stub.rowsByProject.set(path.resolve(projectA), [
    fnRow("alpha", "decisive", "2026-06-01T10:00:00Z", projectA),
    fnRow("alpha", "confirmatory", "2026-06-02T10:00:00Z", projectA),
    fnRow("alpha", "retrieved-unused", "2026-06-03T10:00:00Z", projectA),
    toolRow("alpha", 1, "2026-05-20T10:00:00Z", projectA),
    toolRow("alpha", 2, "2026-06-04T10:00:00Z", projectA),
    implicitRow("alpha", "2026-06-04T11:00:00Z", projectA),
  ]);
  const r = mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:00:00Z") });
  if (!r.ok || !r.written || r.slugs_considered !== 1) throw new Error(`merge failed: ${JSON.stringify(r)}`);
  const row = rowOf(projectA, "alpha");
  if (row.citation_count !== 3) throw new Error(`citation_count should count explicit footnotes only (3), got ${row.citation_count}`);
  if (row.total_retrievals !== 3) throw new Error(`total_retrievals should be 1+2=3, got ${row.total_retrievals}`);
  if (row.first_cited_at !== "2026-05-20T10:00:00Z") throw new Error(`first_cited_at wrong: ${row.first_cited_at}`);
  if (row.last_cited_at !== "2026-06-04T10:00:00Z") throw new Error(`last_cited_at wrong: ${row.last_cited_at}`);
});

check("path-a-implicit is not counted as citation", () => {
  const row = rowOf(projectA, "alpha");
  if (row.citation_count !== 3) throw new Error(`implicit observation must not inflate citation_count, got ${row.citation_count}`);
});

check("rolling-window fields delegate to summarizeEntryActivity", () => {
  stub.activityBySlug.set("alpha", {
    slug: "alpha", decisive_count: 2, confirmatory_count: 1, retrieved_unused_count: 4,
    decisive_streak: 0, possible_echo_chamber: false, total_retrievals: 9,
  });
  mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:01:00Z") });
  const row = rowOf(projectA, "alpha");
  if (row.window_decisive !== 2 || row.window_confirmatory !== 1 || row.window_retrieved_unused !== 4) {
    throw new Error(`rolling counts not mapped: ${JSON.stringify(row)}`);
  }
  if (row.window_total_retrievals !== 9 || row.window_days !== 30) throw new Error(`window meta wrong: ${JSON.stringify(row)}`);
});

check("possible_echo_chamber fires only at decisive_streak >= 5", () => {
  stub.activityBySlug.set("alpha", { slug: "alpha", decisive_count: 5, confirmatory_count: 0, retrieved_unused_count: 0, decisive_streak: 4, possible_echo_chamber: false, total_retrievals: 5 });
  mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:02:00Z") });
  if (rowOf(projectA, "alpha").possible_echo_chamber !== false) throw new Error("streak=4 must NOT flag echo chamber");
  stub.activityBySlug.set("alpha", { slug: "alpha", decisive_count: 5, confirmatory_count: 0, retrieved_unused_count: 0, decisive_streak: 5, possible_echo_chamber: true, total_retrievals: 5 });
  mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:03:00Z") });
  if (rowOf(projectA, "alpha").possible_echo_chamber !== true) throw new Error("streak=5 must flag echo chamber");
});

check("executor-owned hysteresis fields are preserved across merges", () => {
  // Simulate the executor stamping loop-breaker state onto the sidecar row.
  const file = entryTelemetryPath();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const idx = lines.findIndex((r) => r.slug === "alpha" && path.resolve(r.project_root) === path.resolve(projectA));
  if (idx < 0) throw new Error("alpha row missing before hysteresis injection");
  lines[idx].last_proposed_at = "2026-06-04T11:00:00Z";
  lines[idx].proposal_cooldown_until = "2026-06-11T11:00:00Z";
  lines[idx].holdout_until = "2026-06-18T11:00:00Z";
  fs.writeFileSync(file, lines.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Re-merge from the ledger: telemetry recomputed, hysteresis carried forward.
  mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:04:00Z") });
  const row = rowOf(projectA, "alpha");
  if (row.last_proposed_at !== "2026-06-04T11:00:00Z" || row.proposal_cooldown_until !== "2026-06-11T11:00:00Z" || row.holdout_until !== "2026-06-18T11:00:00Z") {
    throw new Error(`hysteresis fields must survive re-merge, got ${JSON.stringify(row)}`);
  }
});

check("merge is idempotent w.r.t. the ledger", () => {
  const a = rowOf(projectA, "alpha");
  mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:05:00Z") });
  const b = rowOf(projectA, "alpha");
  for (const k of ["citation_count", "total_retrievals", "window_decisive", "window_retrieved_unused", "possible_echo_chamber"]) {
    if (a[k] !== b[k]) throw new Error(`field ${k} not idempotent: ${a[k]} -> ${b[k]}`);
  }
});

check("project scoping: merging project B never disturbs project A rows", () => {
  const aBefore = rowOf(projectA, "alpha");
  stub.rowsByProject.set(path.resolve(projectB), [
    fnRow("beta", "decisive", "2026-06-03T10:00:00Z", projectB),
  ]);
  mergeEntryTelemetry({ projectRoot: projectB, now: new Date("2026-06-04T12:06:00Z") });
  const aAfter = rowOf(projectA, "alpha");
  if (aAfter.citation_count !== aBefore.citation_count || aAfter.last_proposed_at !== aBefore.last_proposed_at) {
    throw new Error("project A row mutated by project B merge");
  }
  if (rowsFor(projectB).length !== 1 || rowOf(projectB, "beta").citation_count !== 1) {
    throw new Error(`project B row wrong: ${JSON.stringify(rowsFor(projectB))}`);
  }
  // Both projects coexist in the sidecar.
  if (readEntryTelemetry().length < 2) throw new Error("both projects should coexist in the sidecar");
});

check("corrupt sidecar lines are tolerated and cleaned on next write", () => {
  fs.appendFileSync(entryTelemetryPath(), "{not valid json\n\n");
  const before = readEntryTelemetry(projectA).length; // read survives corrupt line
  if (before < 1) throw new Error("read should ignore corrupt line, not crash");
  mergeEntryTelemetry({ projectRoot: projectA, now: new Date("2026-06-04T12:07:00Z") });
  if (fs.readFileSync(entryTelemetryPath(), "utf8").includes("{not valid json")) {
    throw new Error("next write should rewrite clean JSONL");
  }
});

check("mergeEntryTelemetryIfDue debounces within the interval, reruns past it", () => {
  const projectC = path.join(tmpDir, "project-c");
  stub.rowsByProject.set(path.resolve(projectC), [fnRow("gamma", "decisive", "2026-06-03T10:00:00Z", projectC)]);
  const first = telemetry.mergeEntryTelemetryIfDue({ projectRoot: projectC, now: new Date("2026-06-04T13:00:00Z"), minIntervalMs: 3600000 });
  if (!first || !first.ok || !first.written) throw new Error(`first IfDue should run: ${JSON.stringify(first)}`);
  const second = telemetry.mergeEntryTelemetryIfDue({ projectRoot: projectC, now: new Date("2026-06-04T13:30:00Z"), minIntervalMs: 3600000 });
  if (second !== null) throw new Error(`second IfDue within interval must be null (debounced), got ${JSON.stringify(second)}`);
  const third = telemetry.mergeEntryTelemetryIfDue({ projectRoot: projectC, now: new Date("2026-06-04T14:30:00Z"), minIntervalMs: 3600000 });
  if (!third || !third.written) throw new Error(`third IfDue past interval should run again: ${JSON.stringify(third)}`);
});

console.log("\nSource-level boundary guards");

check("entry-telemetry never imports the durable writer / curator / multi-view", () => {
  const src = fs.readFileSync(modulePath, "utf8");
  for (const forbidden of ["./writer", "./curator", "./multi-view", "updateProjectEntry", "archiveProjectEntry", "supersedeProjectEntry", "frontmatterPatch", "runMultiView"]) {
    if (src.includes(forbidden)) throw new Error(`entry-telemetry.ts must not reference ${forbidden} (Tier A is sidecar-only)`);
  }
});

check("entry-telemetry stays internal: no markdown / durable-memory write surface", () => {
  const src = fs.readFileSync(modulePath, "utf8");
  // Precise durable-write tokens (the bare ".md" substring is avoided: it
  // appears only in the design-doc reference comment, not a write path).
  for (const forbidden of ["writeProjectEntry", "mergeProjectEntry", "deleteProjectEntry", "memory_search", "prompt_user", "gitCommit", "pushAsync"]) {
    if (src.includes(forbidden)) throw new Error(`entry-telemetry.ts must not reference ${forbidden}`);
  }
  // No fs write to a markdown file path (durable entries are *.md).
  if (/writeFileSync\([^)]*\.md/.test(src)) throw new Error("entry-telemetry.ts must not write any .md file");
});

check("index.ts wires the read-only telemetry lane and passes NO modelRegistry", () => {
  const idx = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf8");
  if (!/import\s*\{\s*mergeEntryTelemetryIfDue\s*\}\s*from\s*"\.\/entry-telemetry"/.test(idx)) {
    throw new Error("index.ts must import mergeEntryTelemetryIfDue");
  }
  if (!idx.includes("mergeEntryTelemetryIfDue({ projectRoot: cwd })")) {
    throw new Error("index.ts must schedule the read-only telemetry lane");
  }
  const block = idx.match(/scheduleTelemetry\(\(\) => \{[\s\S]*?\}\);/);
  if (!block) throw new Error("telemetry lane schedule block not found in index.ts");
  if (/modelRegistry/.test(block[0])) throw new Error("telemetry lane must NOT pass modelRegistry (read-only, no LLM)");
});

console.log(`\nTotal: ${total}  Passed: ${total - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — entry-telemetry Tier-A contract drifted.");
  process.exit(1);
}
