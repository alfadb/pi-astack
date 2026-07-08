#!/usr/bin/env node
/**
 * Smoke: R5 prompt revision proposal sidecar.
 *
 * Locks the deterministic dossier contract:
 *   - closed enum/status normalization
 *   - target_prompt must be a settings.promptVersion key
 *   - full prompt diff/patch fields are rejected
 *   - proposal_id upsert dedup preserves operator disposition
 *   - requires_human_review=true and applied_to_disk=false invariant
 *   - packager emits only from explicit reinforced classifier prompt signals
 *   - no durable writer/curator/multi-view import and no prompt file mutation
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-revision-proposals-smoke-"));
const ledgerDir = path.join(tmpDir, "abrain", ".state", "sediment");
const projectRoot = path.join(tmpDir, "project-a");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(ledgerDir, { recursive: true });

const settings = {
  promptVersion: {
    activeCorrectionClassifier: "v2",
    reasoningNormalizationPreamble: "v1",
    multiViewPass1: "v1",
    multiViewPass2: "v1",
    outcomeSelfReport: "v0",
    aggregator: "v1.3",
    archiveReactivationReviewer: "v1",
  },
};

const runtimeStub = {
  ensureUserGlobalSidecarMigrated: () => {},
  formatLocalIsoTimestamp: (d) => (d ?? new Date()).toISOString(),
  userGlobalSedimentDir: () => ledgerDir,
};
const causalAnchorStub = {
  getCurrentAnchor: () => ({ session_id: "smoke-session", turn_id: 0 }),
  spreadAnchor: (anchor) => anchor ? { session_id: anchor.session_id, turn_id: anchor.turn_id } : {},
};
const syncFileLockStub = {
  withFileLock: (_lockPath, fn) => ({ ok: true, value: fn() }),
  atomicWriteText: (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  },
};

const modulePath = path.join(repoRoot, "extensions/sediment/prompt-revision-proposals.ts");
const mod = loadCJS(transpile(modulePath), path.join(tmpDir, "prompt-revision-proposals.cjs"), new Map([
  ["../_shared/runtime", runtimeStub],
  ["../_shared/causal-anchor", causalAnchorStub],
  ["../_shared/sync-file-lock", syncFileLockStub],
]));

const {
  promptRevisionProposalsPath,
  appendPromptRevisionProposals,
  readPromptRevisionProposals,
  buildPromptRevisionProposalsFromAggregatorSummary,
} = mod;

function validRow(overrides = {}) {
  return {
    schema_version: 1,
    ts: "2026-07-08T10:00:00.000Z",
    project_root: projectRoot,
    target_prompt: "activeCorrectionClassifier",
    current_version: "v2",
    problem_pattern: "classifier over-accepts injected-without-self-report observations as retrieved-unused usage",
    evidence_quotes: [
      "path_a_signal=injected_no_self_report",
      "legacy_implicit_unused only; new implicit rows omit used",
    ],
    falsifier: "Next audit window shows classifier traces distinguish exposure from self_report without revised prompt wording.",
    proposed_change_summary: "Clarify that Path A injected/no-self-report observations are exposure-only and must not be treated as retrieved-unused usage.",
    status: "proposed",
    requires_human_review: true,
    applied_to_disk: false,
    recurrence_count: 1,
    first_seen: "2026-07-08T10:00:00.000Z",
    last_seen: "2026-07-08T10:00:00.000Z",
    audit_trace_anchors: ["audit:outcome_unknown_triage#path-a-implicit", "aggregator:activity_buckets"],
    source_signal: "classifier_health",
    ...overrides,
  };
}

console.log("Smoke: prompt-revision-proposals R5 sidecar\n");

check("no rows is a no-op and does not create the sidecar", () => {
  const r = appendPromptRevisionProposals([], settings);
  if (!r.ok || r.written !== false || r.proposals_upserted !== 0) throw new Error(`expected no-op, got ${JSON.stringify(r)}`);
  if (fs.existsSync(promptRevisionProposalsPath())) throw new Error("empty append must not create sidecar");
});

check("valid proposal writes one row with human-review invariants", () => {
  const r = appendPromptRevisionProposals([validRow({ requires_human_review: false, applied_to_disk: true })], settings);
  if (!r.ok || !r.written || r.proposals_upserted !== 1) throw new Error(`expected one upsert, got ${JSON.stringify(r)}`);
  const rows = readPromptRevisionProposals(settings, projectRoot);
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  const row = rows[0];
  if (!row.proposal_id || !row.proposal_id.startsWith("prp-")) throw new Error(`missing stable proposal_id: ${JSON.stringify(row)}`);
  if (row.requires_human_review !== true) throw new Error("requires_human_review must be forced true");
  if (row.applied_to_disk !== false) throw new Error("applied_to_disk must be forced false");
  if (row.target_prompt !== "activeCorrectionClassifier" || row.current_version !== "v2") throw new Error(`target/version wrong: ${JSON.stringify(row)}`);
});

check("closed status enum normalizes invalid values to proposed", () => {
  appendPromptRevisionProposals([validRow({ problem_pattern: "status enum fixture", status: "pending_review" })], settings);
  const row = readPromptRevisionProposals(settings, projectRoot).find((r) => r.problem_pattern === "status enum fixture");
  if (!row) throw new Error("status fixture row missing");
  if (row.status !== "proposed") throw new Error(`invalid status should normalize to proposed, got ${row.status}`);
});

check("target_prompt must be a settings.promptVersion key", () => {
  const before = readPromptRevisionProposals(settings, projectRoot).length;
  const r = appendPromptRevisionProposals([validRow({ target_prompt: "nonexistentPrompt" })], settings);
  if (!r.ok || r.invalid_count !== 1 || r.proposals_upserted !== 0) throw new Error(`invalid target should be skipped, got ${JSON.stringify(r)}`);
  if (readPromptRevisionProposals(settings, projectRoot).length !== before) throw new Error("invalid target changed row count");
});

check("full prompt diff/patch fields are rejected", () => {
  const before = readPromptRevisionProposals(settings, projectRoot).length;
  const r = appendPromptRevisionProposals([validRow({ prompt_patch_unified_diff: "@@ full diff must not be stored" })], settings);
  if (!r.ok || r.invalid_count !== 1 || r.proposals_upserted !== 0) throw new Error(`diff row should be rejected, got ${JSON.stringify(r)}`);
  if (readPromptRevisionProposals(settings, projectRoot).length !== before) throw new Error("diff row changed row count");
});

check("evidence quotes are short excerpts, bounded and deduplicated", () => {
  const long = "x".repeat(500);
  appendPromptRevisionProposals([validRow({ problem_pattern: "quote cap fixture", evidence_quotes: [long, long, "short", "a", "b", "c", "d"] })], settings);
  const row = readPromptRevisionProposals(settings, projectRoot).find((r) => r.problem_pattern === "quote cap fixture");
  if (!row) throw new Error("quote cap row missing");
  if (row.evidence_quotes.length > 5) throw new Error(`too many evidence quotes: ${row.evidence_quotes.length}`);
  if (row.evidence_quotes.some((q) => q.length > 260)) throw new Error(`quote not clipped: ${JSON.stringify(row.evidence_quotes)}`);
  if (new Set(row.evidence_quotes).size !== row.evidence_quotes.length) throw new Error("evidence quotes not deduplicated");
});

check("upsert dedup increments recurrence/last_seen and preserves disposition", () => {
  const rows = readPromptRevisionProposals(settings, projectRoot);
  const first = rows.find((r) => r.problem_pattern.startsWith("classifier over-accepts"));
  if (!first) throw new Error("setup row missing");
  const withDisposition = rows.map((r) => r.proposal_id === first.proposal_id
    ? { ...r, status: "under_review", disposition: { decision: "defer", reason: "waiting for real classifier trace recurrence", operator: "smoke", ts: "2026-07-08T10:30:00.000Z" } }
    : r);
  fs.writeFileSync(promptRevisionProposalsPath(), withDisposition.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const r = appendPromptRevisionProposals([validRow({ ts: "2026-07-08T11:00:00.000Z", last_seen: "2026-07-08T11:00:00.000Z" })], settings);
  if (!r.ok || !r.written || r.proposals_upserted !== 1) throw new Error(`duplicate upsert failed: ${JSON.stringify(r)}`);
  const row = readPromptRevisionProposals(settings, projectRoot).find((x) => x.proposal_id === first.proposal_id);
  if (!row) throw new Error("dedup row missing after upsert");
  if (row.recurrence_count < 2) throw new Error(`recurrence not incremented: ${row.recurrence_count}`);
  if (row.last_seen !== "2026-07-08T11:00:00.000Z") throw new Error(`last_seen not updated: ${row.last_seen}`);
  if (row.disposition?.decision !== "defer" || row.disposition?.reason !== "waiting for real classifier trace recurrence") {
    throw new Error(`operator disposition was not preserved: ${JSON.stringify(row.disposition)}`);
  }
});

check("packager emits proposal only for explicit reinforced classifier pattern signal", () => {
  const proposals = buildPromptRevisionProposalsFromAggregatorSummary({
    project_root: projectRoot,
    prompt_revision_signals: {
      reinforced_classifier_prompt_patterns: [{
        signal_type: "classifier_prompt_pattern",
        reinforced: true,
        source_signal: "evolution_hypothesis",
        target_prompt: "activeCorrectionClassifier",
        problem_pattern: "classifier prompt repeatedly conflates exposure-only with usage taxonomy",
        evidence_quotes: ["source=path-a-injected is injection-only", "used missing is allowed for retrieval-only"],
        falsifier: "A fresh reinforced run shows no such conflation after reading activity_buckets.",
        proposed_change_summary: "Add a short classifier prompt boundary distinguishing exposure rows from self-report usage rows.",
        audit_trace_anchors: ["evolution-ledger:classifier-health::slug:usage-taxonomy", "audit:derived_attribution"],
      }],
    },
  }, settings, new Date("2026-07-08T12:00:00.000Z"));
  if (proposals.length !== 1) throw new Error(`expected one packaged proposal, got ${proposals.length}`);
  const p = proposals[0];
  if (p.target_prompt !== "activeCorrectionClassifier" || p.current_version !== "v2") throw new Error(`packaged target/version wrong: ${JSON.stringify(p)}`);
  if (p.status !== "proposed" || p.requires_human_review !== true || p.applied_to_disk !== false) throw new Error(`packaged invariants wrong: ${JSON.stringify(p)}`);
});

check("packager returns zero for healthy or non-reinforced fixtures", () => {
  const healthy = buildPromptRevisionProposalsFromAggregatorSummary({ project_root: projectRoot }, settings);
  if (healthy.length !== 0) throw new Error(`healthy fixture should produce 0, got ${healthy.length}`);
  const notReinforced = buildPromptRevisionProposalsFromAggregatorSummary({
    project_root: projectRoot,
    prompt_revision_signals: {
      reinforced_classifier_prompt_patterns: [{
        signal_type: "classifier_prompt_pattern",
        reinforced: false,
        source_signal: "classifier_health",
        target_prompt: "activeCorrectionClassifier",
        problem_pattern: "not reinforced",
        evidence_quotes: ["one row only"],
        falsifier: "n/a",
        proposed_change_summary: "n/a",
        audit_trace_anchors: ["audit:single-row"],
      }],
    },
  }, settings);
  if (notReinforced.length !== 0) throw new Error(`non-reinforced fixture should produce 0, got ${notReinforced.length}`);
});

console.log("\nSource-level boundary guards");

check("prompt revision sidecar never imports durable writer / curator / multi-view", () => {
  const src = fs.readFileSync(modulePath, "utf8");
  for (const forbidden of ["./writer", "./curator", "./multi-view", "writeProjectEntry", "updateProjectEntry", "archiveProjectEntry", "runMultiView", "prompt_user"]) {
    if (src.includes(forbidden)) throw new Error(`sidecar must not reference ${forbidden}`);
  }
});

check("prompt revision sidecar writes only the jsonl sidecar, not prompt files", () => {
  const src = fs.readFileSync(modulePath, "utf8");
  if (!src.includes("prompt-revision-proposals.jsonl")) throw new Error("sidecar filename missing");
  if (/\.md["'`]/.test(src)) throw new Error("sidecar source must not reference markdown prompt writes");
  if (/promptVersion\s*=|promptVersion\.[A-Za-z]+\s*=/.test(src)) throw new Error("sidecar must not mutate promptVersion");
});

check("aggregator wires R5 only inside the prompt_native_v1 gate", () => {
  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf8");
  const gate = /if \(aggregatorEngine === "prompt_native_v1" && promptNative\) \{[\s\S]*?buildPromptRevisionProposalsFromAggregatorSummary\([\s\S]*?appendPromptRevisionProposals\(/m;
  if (!gate.test(agg)) throw new Error("R5 sidecar must stay gated on successful prompt_native_v1 output");
});

console.log(`\nTotal: ${total}  Passed: ${total - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — prompt-revision-proposals R5 contract drifted.");
  process.exit(1);
}
