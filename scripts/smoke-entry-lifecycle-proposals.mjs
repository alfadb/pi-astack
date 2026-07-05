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
 *   - deterministic frontmatter bridge emits E1 execution_ready / E2 review_required
 *   - same slug + evidence/source replays are idempotent
 *   - HARD BOUNDARY (prompt §8): never imports writer/curator/multi-view; never
 *     writes durable markdown; proposal generation status is always "pending"
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
  abrainProjectDir: (abrainHome, projectId) => path.join(abrainHome, "projects", projectId),
  ensureUserGlobalSidecarMigrated: () => {},
  formatLocalIsoTimestamp: (d) => (d ?? new Date()).toISOString(),
  resolveActiveProject: () => ({ activeProject: { projectId: "smoke-project" } }),
  resolveUserGlobalAbrainHome: () => path.join(tmpDir, "abrain"),
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
const { entryLifecycleProposalsPath, appendLifecycleProposals, appendSupersededFrontmatterProposals, appendSupersededMarkdownFrontmatterProposals, readLifecycleProposals } = mod;

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
  if (row.expected_status !== "active" || row.disposition !== "execution_ready") throw new Error(`active proposal gate fields wrong: ${JSON.stringify(row)}`);
  if (!row.proposal_id || row.evidence_type !== "superseded_by") throw new Error(`ordinary proposal must carry proposal_id/evidence_type: ${JSON.stringify(row)}`);
  if (!row.independent_evidence.includes("superseded evidence") || !row.falsifier) throw new Error("evidence/falsifier lost");
  if (row.message !== "msg for stale-entry") throw new Error("message context lost");
});

check("same promoted proposal replay is idempotent", () => {
  const before = readLifecycleProposals(projectA).length;
  const r = appendLifecycleProposals({
    projectRoot: projectA,
    promoted: [promotedWithProposal("stale-entry", "archive", "affirm_superseded")],
    now: new Date("2026-06-04T11:01:00Z"),
  });
  if (!r.ok || r.proposals_appended !== 0 || r.written !== false) throw new Error(`expected duplicate no-op, got ${JSON.stringify(r)}`);
  if (readLifecycleProposals(projectA).length !== before) throw new Error("duplicate replay changed row count");
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

check("frontmatter bridge emits E1 executable and E2 review-only proposals", () => {
  const r = appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T13:00:00Z"),
    entries: [
      { slug: "old-a", kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["new-a"] }, relations: [{ type: "superseded_by", to: "new-a" }] },
      { slug: "old-b", kind: "fact", status: "superseded", frontmatter: { status: "superseded" }, relations: [] },
      { slug: "old-c", kind: "fact", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["old-c"] }, relations: [{ type: "superseded_by", to: "old-c" }] },
      { slug: "old-d", kind: "fact", status: "archived", frontmatter: { status: "archived", superseded_by: ["new-d"] }, relations: [{ type: "superseded_by", to: "new-d" }] },
      { slug: "old-e", kind: "fact", status: "superseded", frontmatter: { status: "superseded-in-part", superseded_by: ["new-e"] }, relations: [{ type: "superseded_by", to: "new-e" }] },
    ],
  });
  if (!r.ok || r.e1_count !== 1 || r.e2_count !== 2 || r.proposals_appended !== 3) throw new Error(`bridge counts wrong: ${JSON.stringify(r)}`);
  const rows = readLifecycleProposals(projectA);
  const e1 = rows.find((x) => x.slug === "old-a");
  const e2 = rows.find((x) => x.slug === "old-b");
  const self = rows.find((x) => x.slug === "old-c");
  if (!e1 || e1.disposition !== "execution_ready" || e1.expected_status !== "superseded" || e1.target_slug !== "new-a") throw new Error(`E1 wrong: ${JSON.stringify(e1)}`);
  if (!e2 || e2.disposition !== "review_required" || e2.reason !== "superseded_no_successor" || e2.review_required !== true) throw new Error(`E2 wrong: ${JSON.stringify(e2)}`);
  if (!self || self.disposition !== "review_required") throw new Error(`self-edge must become E2 review: ${JSON.stringify(self)}`);
  if (!e1.proposal_id || e1.evidence_type !== "superseded_by") throw new Error(`E1 must carry proposal_id/evidence_type: ${JSON.stringify(e1)}`);
  if (!e2.proposal_id || e2.evidence_type !== "superseded_no_successor") throw new Error(`E2 must carry proposal_id/evidence_type: ${JSON.stringify(e2)}`);
  if (!self.proposal_id || self.evidence_type !== "superseded_no_successor") throw new Error(`self-edge E2 must carry proposal_id/evidence_type: ${JSON.stringify(self)}`);
  if (rows.some((x) => x.slug === "old-d" || x.slug === "old-e")) throw new Error("non-current-superseded entries must be skipped");
});

check("frontmatter E1 replacing previous E2 records supersedes_proposal_id", () => {
  appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T13:10:00Z"),
    entries: [
      { slug: "old-replace", kind: "decision", status: "superseded", frontmatter: { status: "superseded" }, relations: [] },
    ],
  });
  const oldE2 = readLifecycleProposals(projectA).find((x) => x.slug === "old-replace" && x.disposition === "review_required");
  if (!oldE2?.proposal_id || oldE2.evidence_type !== "superseded_no_successor") throw new Error(`setup E2 missing proposal_id/evidence_type: ${JSON.stringify(oldE2)}`);
  appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T13:11:00Z"),
    entries: [
      { slug: "old-replace", kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["new-replace"] }, relations: [{ type: "superseded_by", to: "new-replace" }] },
    ],
  });
  const rows = readLifecycleProposals(projectA).filter((x) => x.slug === "old-replace");
  const failedE2 = rows.find((x) => x.disposition === "review_required");
  const newE1 = rows.find((x) => x.disposition === "execution_ready");
  if (failedE2?.status !== "failed") throw new Error(`previous E2 must be marked failed when E1 arrives: ${JSON.stringify(rows)}`);
  if (!newE1?.proposal_id || newE1.evidence_type !== "superseded_by") throw new Error(`replacement E1 missing proposal_id/evidence_type: ${JSON.stringify(newE1)}`);
  if (newE1.supersedes_proposal_id !== oldE2.proposal_id) throw new Error(`replacement E1 must point to old E2 proposal_id: ${JSON.stringify({ oldE2, newE1 })}`);
});

check("canonical markdown bridge reads block-list superseded_by", () => {
  const projectRoot = path.join(tmpDir, "canonical-project");
  const projectId = "smoke-project";
  const projectDir = path.join(tmpDir, "abrain", "projects", projectId, "decisions");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "block-list-old.md"), [
    "---",
    "id: project:smoke-project:block-list-old",
    "scope: project",
    "kind: decision",
    "status: superseded",
    "superseded_by:",
    "  - block-list-new",
    "---",
    "",
    "# Block list old",
    "",
    "Enough body text for a memory entry.",
  ].join("\n"));
  const r = appendSupersededMarkdownFrontmatterProposals({ projectRoot, abrainHome: path.join(tmpDir, "abrain"), projectId });
  if (!r.ok || r.e1_count !== 1 || r.proposals_appended !== 1) throw new Error(`markdown bridge failed: ${JSON.stringify(r)}`);
  const row = readLifecycleProposals(projectRoot).find((x) => x.slug === "block-list-old");
  if (!row || row.target_slug !== "block-list-new" || row.disposition !== "execution_ready" || row.expected_status !== "superseded") throw new Error(`markdown E1 wrong: ${JSON.stringify(row)}`);
  const r2 = appendSupersededMarkdownFrontmatterProposals({ projectRoot, abrainHome: path.join(tmpDir, "abrain"), projectId });
  if (r2.proposals_appended !== 0) throw new Error(`markdown bridge replay not idempotent: ${JSON.stringify(r2)}`);

  const l2Dir = path.join(tmpDir, "abrain", "l2", "views", "knowledge", "latest", "projects", projectId);
  fs.mkdirSync(l2Dir, { recursive: true });
  fs.writeFileSync(path.join(l2Dir, "block-list-old.md"), [
    "---",
    "id: project:smoke-project:block-list-old",
    "scope: project",
    "kind: decision",
    "status: archived",
    "---",
    "",
    "# Block list old",
    "",
    "Canonical projection says this entry is already archived.",
  ].join("\n"));
  const r3 = appendSupersededMarkdownFrontmatterProposals({ projectRoot: path.join(tmpDir, "canonical-project-2"), abrainHome: path.join(tmpDir, "abrain"), projectId });
  if (r3.e1_count !== 0 || r3.e2_count !== 0 || r3.proposals_appended !== 0) throw new Error(`canonical archived overlay must skip legacy superseded edge: ${JSON.stringify(r3)}`);
});

check("frontmatter bridge second replay appends zero rows", () => {
  const before = readLifecycleProposals(projectA).length;
  const r = appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T13:05:00Z"),
    entries: [
      { slug: "old-a", kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["new-a"] }, relations: [{ type: "superseded_by", to: "new-a" }] },
      { slug: "old-b", kind: "fact", status: "superseded", frontmatter: { status: "superseded" }, relations: [] },
      { slug: "old-c", kind: "fact", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["old-c"] }, relations: [{ type: "superseded_by", to: "old-c" }] },
    ],
  });
  if (!r.ok || r.proposals_appended !== 0 || r.written !== false) throw new Error(`expected idempotent no-op, got ${JSON.stringify(r)}`);
  if (readLifecycleProposals(projectA).length !== before) throw new Error("idempotent bridge replay changed row count");
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
