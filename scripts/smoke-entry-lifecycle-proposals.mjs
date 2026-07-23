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
 *   - deterministic frontmatter bridge emits E1 execution_ready / E2 defer_until_new_evidence
 *   - same slug + evidence/source replays are idempotent
 *   - HARD BOUNDARY (prompt §8): never imports writer/curator/multi-view; never
 *     writes durable markdown; proposal generation status is always "pending"
 */

import { createHash } from "node:crypto";
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
const validationStub = { ENTRY_KINDS: ["maxim", "decision", "anti-pattern", "pattern", "fact", "preference", "smell"] };
let outcomeEvidenceRows = [];
const outcomeEvidenceStub = {
  readOutcomeEvidenceIndex: () => outcomeEvidenceRows,
  // Stub mirrors production requireReliableAttribution semantics: only hex IDs
  // that look like fixture attributed outcomes are accepted. Real forgetting
  // smokes seed actual L1 attributed events instead of relying on this stub.
  resolveIndependentOutcomeEvidenceEventIds: (ids, _projectRoot, options = {}) => {
    if (!Array.isArray(ids)) return [];
    const hex = [...new Set(ids.filter((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id)))].sort();
    if (options.requireReliableAttribution) return hex; // fixture IDs stand in for attributed events in this unit smoke
    return hex;
  },
};
const decayShadowStub = {
  normalizeAssessment: (raw) => {
    if (!raw || typeof raw !== "object" || !raw.slug) return null;
    const ev = ["superseded_by", "contradicted", "version_stale"].includes(raw.demote_evidence_type) ? raw.demote_evidence_type : null;
    return {
      slug: raw.slug,
      decay_score: typeof raw.decay_score === "number" ? Math.max(0, Math.min(1, raw.decay_score)) : 0,
      would_demote: raw.would_demote === true && ev !== null,
      demote_evidence_type: raw.would_demote === true ? ev : null,
      primary_driver: raw.primary_driver || "disuse",
      decay_inputs: raw.decay_inputs || {},
      falsifier: raw.falsifier || "",
    };
  },
};

const modulePath = path.join(repoRoot, "extensions/sediment/entry-lifecycle-proposals.ts");
const mod = loadCJS(transpile(modulePath), path.join(tmpDir, "entry-lifecycle-proposals.cjs"), new Map([
  ["../_shared/runtime", runtimeStub],
  ["../_shared/causal-anchor", causalAnchorStub],
  ["../_shared/sync-file-lock", syncFileLockStub],
  ["./decay-shadow", decayShadowStub],
  ["./outcome-evidence", outcomeEvidenceStub],
  ["./validation", validationStub],
]));
const { entryLifecycleProposalsPath, appendLifecycleProposals, appendSupersededFrontmatterProposals, appendSupersededMarkdownFrontmatterProposals, readLifecycleProposals, reconcileLifecycleProposalDeferrals, reconcileLegacyDecayProposalKinds, resolveDurableEntryKind, markProposalsExecuted } = mod;

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function promotedWithProposal(slug, op, reason, evidence_type, eventIds = [createHash("sha256").update(`outcome:${slug}`).digest("hex")]) {
  return {
    kind: "outcome_entry", severity: "warning", slug, message: `msg for ${slug}`,
    reasoning: "r", falsifier: "f", evidence_quotes: ["q"],
    lifecycle_proposal: {
      op,
      reason,
      ...(evidence_type ? { evidence_type } : {}),
      independent_evidence: `superseded evidence for ${slug}`,
      independent_evidence_event_ids: eventIds,
      falsifier: "would retract if X",
    },
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

check("aggregator proposal defers without independent L1 evidence and reopens on new joined evidence", () => {
  const slug = "deferred-then-reopened";
  const deferred = promotedWithProposal(slug, "archive", "affirm_superseded", "superseded_by", []);
  const first = appendLifecycleProposals({ projectRoot: projectA, promoted: [deferred], now: new Date("2026-06-04T11:01:30Z") });
  if (!first.ok || first.proposals_appended !== 1) throw new Error(`deferred append failed: ${JSON.stringify(first)}`);
  let row = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!row || row.status !== "deferred_until_new_evidence" || row.disposition !== "defer_until_new_evidence") throw new Error(`missing autonomous defer: ${JSON.stringify(row)}`);
  const eventId = createHash("sha256").update(`outcome:${slug}`).digest("hex");
  const second = appendLifecycleProposals({ projectRoot: projectA, promoted: [promotedWithProposal(slug, "archive", "affirm_superseded", "superseded_by", [eventId])], now: new Date("2026-06-04T11:01:31Z") });
  row = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!second.ok || second.proposals_appended !== 1 || !row || row.status !== "pending" || row.disposition !== "execution_ready" || !row.independent_evidence_event_ids?.includes(eventId)) throw new Error(`new evidence did not reopen: ${JSON.stringify({ second, row })}`);
});

check("appendLifecycleProposals preserves explicit evidence_type", () => {
  const r = appendLifecycleProposals({
    projectRoot: projectA,
    promoted: [promotedWithProposal("contradicted-entry", "archive", "affirm_stale", "contradicted")],
    now: new Date("2026-06-04T11:02:00Z"),
  });
  if (!r.ok || r.proposals_appended !== 1) throw new Error(`expected explicit evidence_type append, got ${JSON.stringify(r)}`);
  const row = readLifecycleProposals(projectA).find((x) => x.slug === "contradicted-entry");
  if (!row || row.evidence_type !== "contradicted") throw new Error(`explicit evidence_type not preserved: ${JSON.stringify(row)}`);
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
  if (rows.length !== 4) throw new Error(`expected 4 accumulated rows, got ${rows.length}`);
  if (!rows.some((r) => r.slug === "stale-entry") || !rows.some((r) => r.slug === "contradicted-entry") || !rows.some((r) => r.slug === "contested-entry")) throw new Error("accumulation lost a prior row");
});

check("rows are project-scoped", () => {
  appendLifecycleProposals({ projectRoot: projectB, promoted: [promotedWithProposal("b-entry", "supersede", "affirm_superseded")], now: new Date("2026-06-04T12:10:00Z") });
  const a = readLifecycleProposals(projectA);
  const b = readLifecycleProposals(projectB);
  if (a.some((r) => r.slug === "b-entry")) throw new Error("project A leaked project B row");
  if (b.length !== 1 || b[0].slug !== "b-entry") throw new Error(`project B scope wrong: ${JSON.stringify(b)}`);
  if (readLifecycleProposals().length < 3) throw new Error("global read should see all projects");
});

check("E2 successor/status/evidence reconcile is isolated by project_root for the same slug", () => {
  const created = new Date("2026-06-04T12:11:00Z");
  const e2 = (slug) => [{ slug, kind: "fact", status: "superseded", frontmatter: { status: "superseded" }, relations: [] }];
  for (const slug of ["shared-successor", "shared-status", "shared-evidence"]) {
    appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: e2(slug), now: created });
    appendSupersededFrontmatterProposals({ projectRoot: projectB, entries: e2(slug), now: created });
  }

  appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T12:12:00Z"),
    entries: [{ slug: "shared-successor", kind: "fact", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["successor-a"] }, relations: [{ type: "superseded_by", to: "successor-a" }] }],
  });
  appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T12:13:00Z"),
    entries: [{ slug: "shared-status", kind: "fact", status: "active", frontmatter: { status: "active" }, relations: [] }],
  });
  const outcome = (root, marker) => ({
    event_id: createHash("sha256").update(marker).digest("hex"),
    project_root_hash: createHash("sha256").update(path.resolve(root)).digest("hex"),
    attribution_status: "attributed",
    evidence_independence: "independent_execution",
    event_type: "action_outcome_observed",
    created_at_utc: "2026-06-04T12:14:00.000Z",
    memory_entry_slugs: ["shared-evidence"],
  });
  outcomeEvidenceRows = [outcome(projectB, "project-b-evidence")];
  appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: e2("shared-evidence"), now: new Date("2026-06-04T12:15:00Z") });

  let a = readLifecycleProposals(projectA);
  let b = readLifecycleProposals(projectB);
  if (a.find((row) => row.slug === "shared-successor" && row.reason === "superseded_no_successor")?.terminal_reason !== "successor_edge_observed") throw new Error("project A successor did not terminal its own E2");
  if (b.find((row) => row.slug === "shared-successor")?.status !== "deferred_until_new_evidence") throw new Error("project A successor changed project B E2");
  if (a.find((row) => row.slug === "shared-status")?.terminal_reason !== "status_no_longer_superseded") throw new Error("project A status did not terminal its own E2");
  if (b.find((row) => row.slug === "shared-status")?.status !== "deferred_until_new_evidence") throw new Error("project A status changed project B E2");
  if (b.find((row) => row.slug === "shared-evidence")?.status !== "deferred_until_new_evidence") throw new Error("project B evidence was consumed during a project A scan");

  outcomeEvidenceRows.push(outcome(projectA, "project-a-evidence"));
  appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: e2("shared-evidence"), now: new Date("2026-06-04T12:16:00Z") });
  a = readLifecycleProposals(projectA);
  b = readLifecycleProposals(projectB);
  if (a.find((row) => row.slug === "shared-evidence")?.status !== "pending") throw new Error("project A evidence did not reopen project A E2");
  if (b.find((row) => row.slug === "shared-evidence")?.status !== "deferred_until_new_evidence") throw new Error("project A evidence reopened project B E2");
  outcomeEvidenceRows = [];
});

check("corrupt sidecar lines are readable but every rewrite fails closed", () => {
  fs.appendFileSync(entryLifecycleProposalsPath(), "{not valid json\n\n");
  const survived = readLifecycleProposals(projectA).length; // diagnostic reads ignore corrupt lines
  if (survived < 2) throw new Error("read must ignore corrupt line, not crash");
  const before = sha256File(entryLifecycleProposalsPath());
  const append = appendLifecycleProposals({ projectRoot: projectA, promoted: [promotedWithProposal("cleanup", "archive", "affirm_stale")], now: new Date("2026-06-04T12:20:00Z") });
  if (append.ok || append.written || append.error !== "proposal_jsonl_parse_failed") throw new Error(`corrupt append must fail closed: ${JSON.stringify(append)}`);
  if (sha256File(entryLifecycleProposalsPath()) !== before) throw new Error("corrupt append changed source bytes");
  const lines = fs.readFileSync(entryLifecycleProposalsPath(), "utf8").split("\n").filter((line) => line.trim() && line !== "{not valid json");
  fs.writeFileSync(entryLifecycleProposalsPath(), `${lines.join("\n")}\n`);
});

check("frontmatter bridge emits E1 executable and E2 evidence-deferred proposals", () => {
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
  if (!e2 || e2.disposition !== "defer_until_new_evidence" || e2.status !== "deferred_until_new_evidence" || e2.reason !== "superseded_no_successor" || e2.failure_class !== "semantic_defer" || e2.new_evidence_trigger !== "new_valid_successor_edge|status_no_longer_superseded|independent_attributed_evidence" || !e2.next_retry_not_before || !e2.deadline || "review_required" in e2) throw new Error(`E2 wrong: ${JSON.stringify(e2)}`);
  if (!self || self.disposition !== "defer_until_new_evidence" || self.status !== "deferred_until_new_evidence") throw new Error(`self-edge must become E2 evidence-defer: ${JSON.stringify(self)}`);
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
  const oldE2 = readLifecycleProposals(projectA).find((x) => x.slug === "old-replace" && x.disposition === "defer_until_new_evidence");
  if (!oldE2?.proposal_id || oldE2.evidence_type !== "superseded_no_successor") throw new Error(`setup E2 missing proposal_id/evidence_type: ${JSON.stringify(oldE2)}`);
  appendSupersededFrontmatterProposals({
    projectRoot: projectA,
    now: new Date("2026-06-04T13:11:00Z"),
    entries: [
      { slug: "old-replace", kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["new-replace"] }, relations: [{ type: "superseded_by", to: "new-replace" }] },
    ],
  });
  const rows = readLifecycleProposals(projectA).filter((x) => x.slug === "old-replace");
  const failedE2 = rows.find((x) => x.disposition === "defer_until_new_evidence");
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

check("durable kind resolution prefers canonical frontmatter", () => {
  const projectRoot = path.join(tmpDir, "kind-priority-project");
  const writeEntry = (dir, kind) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "priority-kind.md"), [
      "---",
      "id: project:smoke-project:priority-kind",
      `kind: ${kind}`,
      "status: active",
      "---",
      "# Priority kind",
    ].join("\n"));
  };
  writeEntry(projectRoot, "fact");
  writeEntry(path.join(tmpDir, "abrain", "projects", "smoke-project"), "smell");
  writeEntry(path.join(tmpDir, "abrain", "l2", "views", "knowledge", "latest", "projects", "smoke-project"), "decision");
  const resolved = resolveDurableEntryKind(projectRoot, "priority-kind");
  if (resolved.kind !== "decision" || resolved.source !== "canonical_frontmatter") throw new Error(`canonical kind must win: ${JSON.stringify(resolved)}`);
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

check("E1 deadline uses bounded retry, project-scoped scan reopen, and stable identity", () => {
  const slug = "e1-bounded-retry";
  const target = "e1-bounded-retry-successor";
  const created = new Date("2026-07-01T00:00:00.000Z");
  const entry = { slug, kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: [target] }, relations: [{ type: "superseded_by", to: target }] };
  const first = appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: [entry], now: created });
  let row = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!first.ok || first.proposals_appended !== 1 || !row) throw new Error(`E1 setup failed: ${JSON.stringify({ first, row })}`);
  const proposalId = row.proposal_id;
  const initialDelay = Date.parse(row.next_retry_not_before) - created.getTime();
  const firstExpiry = reconcileLifecycleProposalDeferrals({ now: new Date(created.getTime() + 2 * 24 * 60 * 60 * 1000) });
  row = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!firstExpiry.ok || firstExpiry.bounded_retry_scheduled < 1 || firstExpiry.retry_cap_terminal !== 0) throw new Error(`first E1 expiry did not schedule a bounded retry: ${JSON.stringify(firstExpiry)}`);
  if (!row || row.status !== "pending" || row.attempt !== 1 || row.terminal_at || row.terminal_reason) throw new Error(`first E1 expiry became terminal: ${JSON.stringify(row)}`);
  if (Date.parse(row.next_retry_not_before) <= new Date(created.getTime() + 2 * 24 * 60 * 60 * 1000).getTime() || Date.parse(row.deadline) <= Date.parse(row.next_retry_not_before)) throw new Error(`retry schedule is not future-bounded: ${JSON.stringify(row)}`);
  if (Date.parse(row.next_retry_not_before) - new Date(created.getTime() + 2 * 24 * 60 * 60 * 1000).getTime() <= initialDelay) throw new Error(`retry schedule did not back off exponentially: ${JSON.stringify(row)}`);

  let terminalSweep;
  for (let expectedAttempt = 2; expectedAttempt <= 3; expectedAttempt++) {
    terminalSweep = reconcileLifecycleProposalDeferrals({ now: new Date(Date.parse(row.deadline) + 1) });
    row = readLifecycleProposals(projectA).find((item) => item.slug === slug);
    if (!terminalSweep.ok || terminalSweep.bounded_retry_scheduled < 1 || !row || row.status !== "pending" || row.attempt !== expectedAttempt) throw new Error(`E1 retry attempt ${expectedAttempt} failed: ${JSON.stringify({ terminalSweep, row })}`);
  }
  terminalSweep = reconcileLifecycleProposalDeferrals({ now: new Date(Date.parse(row.deadline) + 1) });
  row = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!terminalSweep.ok || terminalSweep.retry_cap_terminal < 1 || terminalSweep.deadline_terminal < 1 || !row || row.status !== "failed" || row.attempt !== 3 || row.terminal_reason !== "lifecycle_retry_cap_reached" || !row.terminal_at) throw new Error(`E1 did not terminal at retry cap: ${JSON.stringify({ terminalSweep, row })}`);
  if (!row.message?.includes("deterministic E1 archive proposal")) throw new Error("E1 terminal rewrite lost proposal text");
  const terminalAt = row.terminal_at;
  const rowsBeforeScans = readLifecycleProposals().length;

  const otherProject = appendSupersededFrontmatterProposals({ projectRoot: projectB, entries: [entry], now: new Date(Date.parse(row.deadline) + 2) });
  const aAfterOtherScan = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  const bAfterOtherScan = readLifecycleProposals(projectB).find((item) => item.slug === slug);
  if (!otherProject.ok || otherProject.proposals_appended !== 1 || aAfterOtherScan?.status !== "failed" || aAfterOtherScan.terminal_at !== terminalAt || bAfterOtherScan?.status !== "pending") throw new Error(`other project scan crossed project_root: ${JSON.stringify({ otherProject, aAfterOtherScan, bAfterOtherScan })}`);

  const targetScan = appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: [entry], now: new Date(Date.parse(row.deadline) + 3) });
  const reopened = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!targetScan.ok || targetScan.proposals_appended !== 1 || !reopened || reopened.status !== "pending" || reopened.disposition !== "execution_ready" || reopened.attempt !== 0 || reopened.terminal_at || reopened.terminal_reason) throw new Error(`target project scan did not reopen E1: ${JSON.stringify({ targetScan, reopened })}`);
  if (reopened.proposal_id !== proposalId || readLifecycleProposals().length !== rowsBeforeScans + 1) throw new Error(`E1 reopen duplicated or changed identity: ${JSON.stringify({ proposalId, reopened, rows: readLifecycleProposals().length })}`);
  const consumed = markProposalsExecuted(projectA, [slug]);
  const executed = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!consumed.ok || consumed.updated !== 1 || executed?.status !== "executed" || executed.terminal_reason !== "executor_completed") throw new Error(`reopened E1 was not consumable: ${JSON.stringify({ consumed, executed })}`);
});

check("target project scan reopens legacy lifecycle_deadline_expired E1 in place", () => {
  const slug = "e1-legacy-deadline-terminal";
  const target = "e1-legacy-deadline-successor";
  const created = new Date("2026-07-10T00:00:00.000Z");
  const entry = { slug, kind: "fact", status: "superseded", frontmatter: { status: "superseded", superseded_by: [target] }, relations: [{ type: "superseded_by", to: target }] };
  const appended = appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: [entry], now: created });
  const initial = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!appended.ok || appended.proposals_appended !== 1 || !initial?.proposal_id) throw new Error(`legacy E1 setup failed: ${JSON.stringify({ appended, initial })}`);
  const file = entryLifecycleProposalsPath();
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const terminalAt = new Date(created.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
  for (const row of rows) {
    if (row.project_root === path.resolve(projectA) && row.slug === slug) {
      row.status = "failed";
      row.terminal_at = terminalAt;
      row.terminal_reason = "lifecycle_deadline_expired";
    }
  }
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const beforeCount = readLifecycleProposals().length;
  const reopenedResult = appendSupersededFrontmatterProposals({ projectRoot: projectA, entries: [entry], now: new Date(Date.parse(terminalAt) + 1) });
  const reopened = readLifecycleProposals(projectA).find((item) => item.slug === slug);
  if (!reopenedResult.ok || reopenedResult.proposals_appended !== 1 || !reopened || reopened.status !== "pending" || reopened.terminal_at || reopened.terminal_reason) throw new Error(`legacy deadline terminal did not reopen: ${JSON.stringify({ reopenedResult, reopened })}`);
  if (reopened.proposal_id !== initial.proposal_id || readLifecycleProposals().length !== beforeCount) throw new Error(`legacy deadline reopen duplicated identity: ${JSON.stringify({ initial, reopened })}`);
});

check("legacy decay reconciliation preserves the head beyond the tail-read window", () => {
  fs.mkdirSync(projectA, { recursive: true });
  fs.writeFileSync(path.join(projectA, "tail-window-legacy.md"), [
    "---",
    "id: project:smoke-project:tail-window-legacy",
    "kind: fact",
    "status: active",
    "---",
    "# Tail window legacy",
  ].join("\n"));
  const padding = "x".repeat(2_200);
  const common = {
    schema_version: 1,
    ts: "2026-06-04T14:00:00.000Z",
    project_root: path.resolve(projectA),
    op: "archive",
    reason: "affirm_superseded",
    independent_evidence: "fixture",
    falsifier: "fixture",
    disposition: "execution_ready",
    expected_status: "active",
    evidence_source: "decay",
    message: padding,
  };
  const rows = Array.from({ length: 999 }, (_, i) => ({ ...common, slug: i === 0 ? "head-before-tail" : `filler-${i}`, kind: "fact", status: "executed" }));
  rows.push({ ...common, slug: "tail-window-legacy", kind: "outcome_entry", status: "pending" });
  const file = entryLifecycleProposalsPath();
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (fs.statSync(file).size <= 2 * 1024 * 1024) throw new Error("fixture must exceed the historical 2 MiB tail window");

  const reconciled = reconcileLegacyDecayProposalKinds({ projectRoot: projectA, now: new Date("2026-06-04T14:00:00Z") });
  const persisted = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  if (!reconciled.ok || reconciled.repaired !== 1 || persisted.length !== 1000) throw new Error(`full bounded reconciliation failed: ${JSON.stringify(reconciled)}`);
  if (persisted[0]?.slug !== "head-before-tail") throw new Error("tail-window reconciliation dropped the sidecar head");
  if (persisted.at(-1)?.slug !== "tail-window-legacy" || persisted.at(-1)?.kind !== "fact") throw new Error(`legacy tail row was not repaired: ${JSON.stringify(persisted.at(-1))}`);
});

check("1000-row proposal cap rejects a new arrival loudly without changing bytes", () => {
  const file = entryLifecycleProposalsPath();
  const before = sha256File(file);
  const result = appendLifecycleProposals({
    projectRoot: projectA,
    promoted: [promotedWithProposal("capacity-new-arrival", "archive", "affirm_stale")],
    now: new Date("2026-06-04T14:01:00Z"),
  });
  if (result.ok || result.written || result.error !== "proposal_row_limit_reached" || result.rows_total !== 1000) throw new Error(`cap must fail loud: ${JSON.stringify(result)}`);
  if (sha256File(file) !== before) throw new Error("cap rejection changed proposal source bytes");
});

for (const [position, lineNumber] of [["head", 1], ["middle", 2], ["tail", 3]]) {
  check(`legacy decay reconciliation fails closed for a corrupt ${position} JSONL row`, () => {
    const file = entryLifecycleProposalsPath();
    const legacy = {
      schema_version: 1,
      ts: "2026-06-04T15:00:00.000Z",
      project_root: path.resolve(projectA),
      slug: "tail-window-legacy",
      kind: "outcome_entry",
      op: "archive",
      reason: "affirm_superseded",
      independent_evidence: "fixture",
      falsifier: "fixture",
      disposition: "execution_ready",
      expected_status: "active",
      evidence_source: "decay",
      status: "pending",
    };
    const corrupt = "{not valid json";
    const lines = position === "head"
      ? [corrupt, JSON.stringify(legacy), JSON.stringify({ ...legacy, slug: "valid-tail", status: "executed", kind: "fact" })]
      : position === "middle"
        ? [JSON.stringify(legacy), corrupt, JSON.stringify({ ...legacy, slug: "valid-tail", status: "executed", kind: "fact" })]
        : [JSON.stringify(legacy), JSON.stringify({ ...legacy, slug: "valid-middle", status: "executed", kind: "fact" }), corrupt];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const before = sha256File(file);
    const reconciled = reconcileLegacyDecayProposalKinds({ projectRoot: projectA, now: new Date("2026-06-04T15:00:00Z") });
    const after = sha256File(file);
    if (reconciled.ok || reconciled.written || reconciled.error !== "proposal_jsonl_parse_failed") throw new Error(`corrupt JSONL must fail closed: ${JSON.stringify(reconciled)}`);
    if (reconciled.rows_total !== 3 || reconciled.invalid_json_lines !== 1 || JSON.stringify(reconciled.invalid_json_line_numbers) !== JSON.stringify([lineNumber])) throw new Error(`corrupt JSONL diagnostics wrong: ${JSON.stringify(reconciled)}`);
    if (before !== after) throw new Error(`corrupt ${position} JSONL changed despite fail-closed reconciliation`);
  });
}

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
