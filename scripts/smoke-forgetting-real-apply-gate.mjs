#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-forgetting-real-apply-gate-"));
const projectRoot = path.join(tmp, "project");
process.env.ABRAIN_ROOT = tmp;
fs.mkdirSync(projectRoot, { recursive: true });

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const settingsModule = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));
const sedimentSettings = await jiti.import(path.join(repoRoot, "extensions/sediment/settings.ts"));
const orchestrator = await jiti.import(path.join(repoRoot, "extensions/sediment/forgetting-agent-end.ts"));
const executor = await jiti.import(path.join(repoRoot, "extensions/sediment/forgetting-executor.ts"));
const proposals = await jiti.import(path.join(repoRoot, "extensions/sediment/entry-lifecycle-proposals.ts"));
const reactivation = await jiti.import(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"));
const outcomeEvidence = await jiti.import(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`PASS: ${message}`);
}

const nowMs = Date.now();
const dayMs = 86_400_000;
const proposalPath = proposals.entryLifecycleProposalsPath();
fs.mkdirSync(path.dirname(proposalPath), { recursive: true });

const reactRows = [
  ["keep_archived", 2], ["keep_archived", 4], ["keep_archived", 6], ["reactivate", 8],
  ["keep_archived", 35], ["keep_archived", 37], ["keep_archived", 39], ["reactivate", 41],
].map(([decision, daysAgo], index) => JSON.stringify({
  operation: "archive_reactivation_decision",
  project_root: path.resolve(projectRoot),
  slug: `history-${index}`,
  decision,
  ts: new Date(nowMs - Number(daysAgo) * dayMs).toISOString(),
}));
fs.writeFileSync(reactivation.archiveReactivationLedgerPath(), `${reactRows.join("\n")}\n`, "utf8");

const kinds = ["maxim", "decision", "anti-pattern", "pattern", "fact", "preference", "smell"];
function durable(slug, kind, status) {
  fs.writeFileSync(path.join(projectRoot, `${slug}.md`), `---\nid: project:gate:${slug}\nkind: ${kind}\nstatus: ${status}\n---\n# gate fixture\n`, "utf8");
}
function row({ slug, kind, e1, evidenceIds = [] }) {
  return {
    schema_version: 1,
    ts: new Date(nowMs).toISOString(),
    project_root: path.resolve(projectRoot),
    slug,
    kind,
    op: "archive",
    reason: "affirm_superseded",
    independent_evidence: "fixture",
    falsifier: "fixture",
    expected_status: e1 ? "superseded" : "active",
    disposition: "execution_ready",
    evidence_source: e1 ? "frontmatter_superseded" : "aggregator_promoted_advisory",
    evidence_key: `gate:${slug}`,
    proposal_id: `elp-gate-${slug}`,
    evidence_type: "superseded_by",
    independent_evidence_event_ids: evidenceIds,
    status: "pending",
  };
}
function seedRows(rows) {
  fs.writeFileSync(proposalPath, `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}
function statuses() {
  return proposals.readLifecycleProposals(projectRoot).map((value) => value.status);
}
function auditRows() {
  const file = executor.forgettingDryRunAuditPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

const allKindE1 = kinds.map((kind) => {
  const slug = `e1-${kind}`;
  durable(slug, kind, "superseded");
  return row({ slug, kind, e1: true });
});
const nonE1Evidence = await outcomeEvidence.appendAttributedIndependentOutcomeFixture({
  projectRoot,
  targetSlug: "non-e1-fact",
  producerNonce: "real-apply-gate:non-e1-fact",
});
check(nonE1Evidence.ok && !!nonE1Evidence.eventId, "non-E1 fixture has attributed independent evidence");
const nonE1 = row({ slug: "non-e1-fact", kind: "fact", e1: false, evidenceIds: [nonE1Evidence.eventId] });
durable(nonE1.slug, nonE1.kind, "active");
seedRows([...allKindE1, nonE1]);

const hookCalls = { bridge: 0, reconcile: 0, refresh: 0 };
const dependencies = {
  appendFrontmatterBridge() { hookCalls.bridge++; return { ok: true }; },
  reconcileDeferrals() { hookCalls.reconcile++; return { ok: true }; },
  refreshConvergence() { hookCalls.refresh++; },
  runExecutor: executor.runForgettingExecutor,
};
const loadedEntries = [
  ...[...allKindE1, nonE1].map((value) => ({
    slug: value.slug,
    kind: value.kind,
    status: value.expected_status,
    scope: "project",
  })),
  ...Array.from({ length: 100 }, (_, index) => ({
    slug: `active-corpus-${index}`,
    kind: "fact",
    status: "active",
    scope: "project",
  })),
];
let factoryCalls = 0;
let archiveCalls = 0;
const makeInput = (forgetting, globalWriteAuthority) => ({
  projectRoot,
  memorySettings: { forgetting },
  globalWriteAuthority,
  loadEntries: async () => loadedEntries,
  createArchiveEntry: () => {
    factoryCalls++;
    return async () => { archiveCalls++; return { ok: true, status: "archived" }; };
  },
});

const closedQuadrants = [
  ["dedicated=false/global=false", false, false, "executor_real_apply_gate_closed"],
  ["dedicated=false/global=true", false, true, "executor_real_apply_gate_closed"],
  ["dedicated=true/global=false", true, false, "global_write_authority_gate_closed"],
];
for (const [label, dedicated, globalWriteAuthority, reason] of closedQuadrants) {
  const result = await orchestrator.runForgettingAgentEndPass(
    makeInput({ enabled: true, executorRealApplyEnabled: dedicated, instrumentation: false }, globalWriteAuthority),
    dependencies,
  );
  check(result.executor.reason === reason, `${label} reports ${reason}`);
  check(result.real_apply_gate_enabled === false && result.archive_entry_injected === false, `${label} does not inject archiveEntry`);
  check(statuses().every((status) => status === "pending"), `${label} leaves every E1/non-E1 proposal pending`);
}

for (const [label, dedicated, globalWriteAuthority, reason] of [
  ["dedicated missing", undefined, true, "executor_real_apply_gate_closed"],
  ["dedicated null", null, true, "executor_real_apply_gate_closed"],
  ["dedicated string", "true", true, "executor_real_apply_gate_closed"],
  ["dedicated number", 1, true, "executor_real_apply_gate_closed"],
  ["global missing", true, undefined, "global_write_authority_gate_closed"],
  ["global null", true, null, "global_write_authority_gate_closed"],
  ["unprojected global string", true, "true", "global_write_authority_gate_closed"],
  ["global number", true, 1, "global_write_authority_gate_closed"],
]) {
  const forgetting = { enabled: true, instrumentation: false };
  if (dedicated !== undefined) forgetting.executorRealApplyEnabled = dedicated;
  const result = await orchestrator.runForgettingAgentEndPass(makeInput(forgetting, globalWriteAuthority), dependencies);
  check(result.executor.reason === reason, `${label} fails closed with ${reason}`);
  check(result.archive_entry_injected === false, `${label} does not inject archiveEntry`);
}
check(factoryCalls === 0 && archiveCalls === 0, "closed/malformed gates never construct or call the archive writer");
check(hookCalls.bridge === 11 && hookCalls.reconcile === 11 && hookCalls.refresh === 11, "frontmatter bridge, E2 reconcile, and convergence refresh still run under every hold");

let directSecondGateCalls = 0;
const directSecondGate = await executor.runForgettingExecutor(
  projectRoot,
  { forgetting: { enabled: true, executorRealApplyEnabled: true, instrumentation: false } },
  {
    globalWriteAuthority: false,
    activeCorpusSize: 100,
    archiveEntry: async () => { directSecondGateCalls++; return { ok: true, status: "archived" }; },
  },
);
check(directSecondGate.reason === "global_write_authority_gate_closed" && directSecondGateCalls === 0, "executor second gate rejects an injected callback without global write authority");

const heldAudits = auditRows();
check(heldAudits.some((value) => value.row_kind === "real_apply_hold" && value.hold_reason === "executor_real_apply_gate_closed"), "hold audit exposes executor_real_apply_gate_closed");
check(heldAudits.some((value) => value.row_kind === "real_apply_hold" && value.hold_reason === "global_write_authority_gate_closed"), "hold audit exposes global_write_authority_gate_closed");
check(!heldAudits.some((value) => value.row_kind === "real_apply"), "closed gates never emit real_apply audit");

const trueNonE1Evidence = await outcomeEvidence.appendAttributedIndependentOutcomeFixture({
  projectRoot,
  targetSlug: "true-non-e1-fact",
  producerNonce: "real-apply-gate:true-non-e1-fact",
});
check(trueNonE1Evidence.ok && !!trueNonE1Evidence.eventId, "explicit-true non-E1 fixture has attributed independent evidence");
const trueRows = [
  row({ slug: "true-e1-decision", kind: "decision", e1: true }),
  row({ slug: "true-non-e1-fact", kind: "fact", e1: false, evidenceIds: [trueNonE1Evidence.eventId] }),
];
for (const value of trueRows) durable(value.slug, value.kind, value.expected_status);
seedRows(trueRows);
const trueResult = await orchestrator.runForgettingAgentEndPass(
  makeInput({ enabled: true, executorRealApplyEnabled: true, instrumentation: false }, true),
  dependencies,
);
check(trueResult.archive_entry_injected === true && factoryCalls === 1, "literal true constructs and injects archiveEntry");
check(trueResult.executor.dry_run === false && archiveCalls === 2, "literal true permits E1 long-tail and non-E1 archive calls");
check(statuses().every((status) => status === "executed"), "successful explicit-true callbacks mark proposals executed");
check(trueResult.real_apply_gate_enabled === true && trueResult.global_write_authority_enabled === true, "true/true is the only effective real-apply quadrant");
check(hookCalls.bridge === 12 && hookCalls.reconcile === 12 && hookCalls.refresh === 12, "lifecycle hooks also run with both real gates open");

const normalize = (value) => settingsModule.resolveForgettingSettings({ forgetting: value }).executorRealApplyEnabled;
check(normalize({}) === false && normalize({ executorRealApplyEnabled: null }) === false, "missing/null settings normalize false");
check(normalize({ executorRealApplyEnabled: "true" }) === false && normalize({ executorRealApplyEnabled: 1 }) === false, "wrong setting types normalize false");
check(normalize({ executorRealApplyEnabled: true }) === true, "only literal true normalizes true");
check(settingsModule.resolveForgettingSettings({ forgetting: { autoDemote: true } }).executorRealApplyEnabled === false, "legacy settings cannot arm real apply");
const globalAuthorityCases = [
  ["boolean true", true, true],
  ["legacy string true", "true", true],
  ["normalized legacy string true", " TRUE ", true],
  ["boolean false", false, false],
  ["legacy string false", "false", false],
  ["staging-only", "staging-only", false],
  ["legacy staging", "staging", false],
  ["missing", undefined, false],
  ["null", null, false],
  ["number", 1, false],
  ["unknown string", "enabled", false],
  ["object", {}, false],
];
for (const [label, raw, expected] of globalAuthorityCases) {
  const projected = sedimentSettings.isSedimentGlobalWriteAuthorityEnabled(raw);
  check(projected === expected, `global write authority maps ${label} to ${expected}`);
  for (const dedicated of [false, true]) {
    check((dedicated && projected) === (dedicated && expected), `dual-gate semantic matrix holds for dedicated=${dedicated}/${label}`);
  }
}

const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
const schemaGate = schema.properties.memory.properties.forgetting.properties.executorRealApplyEnabled;
const schemaGlobalGate = schema.properties.sediment.properties.autoLlmWriteEnabled;
check(schemaGate.type === "boolean" && schemaGate.default === false, "settings schema declares dedicated boolean default false");
check(schemaGlobalGate.enum.includes(true) && schemaGlobalGate.enum.includes("true"), "settings schema accepts boolean true and legacy string true global authority values");

const reactivationResult = await reactivation.runArchiveReactivationIfDue({
  projectRoot: path.join(tmp, "reactivation-project"),
  archivedEntries: [],
  windowText: "",
  settings: { autoLlmWriteEnabled: true, aggregatorModel: "test/model", aggregatorTimeoutMs: 1000, aggregatorMaxRetries: 0 },
  modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
  sessionId: "gate-smoke",
  minIntervalMs: 0,
});
check(reactivationResult.skipped === "no_candidates", "archive reactivation remains independently runnable while forgetting real apply is held");

const indexSource = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf8");
check(indexSource.includes("runForgettingAgentEndPass({"), "real agent_end path calls the tested forgetting orchestration entry");
check(indexSource.includes("globalWriteAuthority: resolveSedimentGlobalWriteAuthority()"), "real agent_end passes effective fail-closed global write authority into orchestration");
const reactivationSlice = indexSource.slice(indexSource.indexOf("ADR 0025 §4.6 archive-reactivation"), indexSource.indexOf("ADR 0025 §4.6 archive-reactivation") + 6500);
check(!reactivationSlice.includes("executorRealApplyEnabled"), "archive-reactivation block is not gated by executorRealApplyEnabled");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nALL PASS - RM-FORGET-001 real-apply gate: ${passed} checks`);
