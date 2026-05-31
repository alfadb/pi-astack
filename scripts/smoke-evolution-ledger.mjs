#!/usr/bin/env node
/**
 * Smoke: L1 Sediment Evolution Loop v1 internal evolution ledger.
 *
 * Locks the pure INFRA contract of extensions/sediment/evolution-ledger.ts:
 *
 *   - empty prompt-native output is a no-op
 *   - promoted_advisory creates a proposed hypothesis
 *   - repeated promotion reinforces the hypothesis
 *   - demoted_signal contests the hypothesis
 *   - withdraw_acknowledgment withdraws the hypothesis
 *   - keyed demotion/ack reconciles slug-less hypotheses without orphan rows
 *   - corrupt JSONL rows are ignored, not fatal
 *   - summaries are project-scoped and bucketed active / contested / withdrawn
 *   - history tails stay bounded
 *   - aggregator integration only merges successful prompt_native_v1 outputs
 *
 * This script intentionally stubs only runtime path helpers so the ledger is
 * sandboxed under a tmp directory. No LLM, git, markdown memory writer, or
 * user-facing surface is involved.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-ledger-smoke-"));
const ledgerDir = path.join(tmpDir, "abrain", ".state", "sediment");
const projectRoot = path.join(tmpDir, "project-a");
const otherProjectRoot = path.join(tmpDir, "project-b");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(otherProjectRoot, { recursive: true });

const runtimeStub = {
  ensureUserGlobalSidecarMigrated: () => {},
  formatLocalIsoTimestamp: (d) => (d ?? new Date()).toISOString(),
  userGlobalSedimentDir: () => ledgerDir,
};
const causalAnchorStub = {
  getCurrentAnchor: () => ({ session_id: "smoke-session", turn_id: 0 }),
  spreadAnchor: (anchor) => anchor ? { session_id: anchor.session_id, turn_id: anchor.turn_id } : {},
};

const modulePath = path.join(repoRoot, "extensions/sediment/evolution-ledger.ts");
const moduleCjs = transpile(modulePath);
const fakeModulePath = path.join(tmpDir, "evolution-ledger.cjs");
fs.writeFileSync(fakeModulePath, moduleCjs);
const evolution = loadCJS(
  moduleCjs,
  fakeModulePath,
  new Map([
    ["../_shared/runtime", runtimeStub],
    ["../_shared/causal-anchor", causalAnchorStub],
  ]),
);

const {
  evolutionLedgerPath,
  mergeEvolutionLedger,
  summarizeEvolutionLedger,
} = evolution;

function basePromptNative(overrides = {}) {
  return {
    promoted_advisories: [],
    demoted_signals: [],
    previous_acknowledgments: [],
    trend_observations: [],
    reasoning_quality_self_check: {
      silence_audit: [],
      promotion_audit: [],
      falsifiers_named_count: 0,
      disagreements_with_prior_runs: 0,
      would_propose_if_no_praise: false,
    },
    ...overrides,
  };
}

function readLedgerRows() {
  const file = evolutionLedgerPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function rowBySlug(slug) {
  const row = readLedgerRows().find((r) => r.slug === slug);
  if (!row) throw new Error(`missing ledger row for slug=${slug}`);
  return row;
}

function mergeAt(iso, promptNative, root = projectRoot) {
  return mergeEvolutionLedger({ projectRoot: root, promptNative, now: new Date(iso) });
}

console.log("Smoke: evolution-ledger L1 self-state\n");

check("empty ledger summary returns empty buckets", () => {
  const s = summarizeEvolutionLedger({ projectRoot });
  if (s.rows_considered !== 0 || s.matching_rows !== 0) {
    throw new Error(`expected empty summary, got ${JSON.stringify(s)}`);
  }
  for (const key of ["active_hypotheses", "contested_hypotheses", "withdrawn_hypotheses"]) {
    if (!Array.isArray(s[key]) || s[key].length !== 0) throw new Error(`${key} should be []`);
  }
});

check("empty prompt-native output is a no-op", () => {
  const r = mergeAt("2026-05-31T10:00:00.000Z", basePromptNative());
  if (!r.ok || r.written !== false) throw new Error(`expected no-op success, got ${JSON.stringify(r)}`);
  if (fs.existsSync(evolutionLedgerPath())) throw new Error("no-op merge should not create ledger file");
});

check("first promoted_advisory creates proposed hypothesis", () => {
  const r = mergeAt("2026-05-31T10:01:00.000Z", basePromptNative({
    promoted_advisories: [{
      kind: "classifier health",
      severity: "warning",
      slug: "classifier-health-drop",
      message: "Quote rate fell",
      reasoning: "Current classifier traces lack quotes.",
      falsifier: "A healthy trace sample would include quotes.",
      evidence_quotes: ["summary only", 42, "no quote"] ,
    }],
  }));
  if (!r.ok || !r.written || r.promoted_count !== 1) throw new Error(`merge failed: ${JSON.stringify(r)}`);
  const row = rowBySlug("classifier-health-drop");
  if (row.status !== "proposed" || row.seen_count !== 1) throw new Error(`expected proposed seen=1, got ${JSON.stringify(row)}`);
  if (row.kind !== "classifier_health") throw new Error(`kind should be normalized, got ${row.kind}`);
  if (!Array.isArray(row.last_evidence_quotes) || row.last_evidence_quotes.length !== 2) {
    throw new Error(`non-string evidence quotes should be filtered, got ${JSON.stringify(row.last_evidence_quotes)}`);
  }
});

check("second promotion reinforces the same hypothesis", () => {
  mergeAt("2026-05-31T10:02:00.000Z", basePromptNative({
    promoted_advisories: [{
      kind: "classifier health",
      severity: "critical",
      slug: "classifier-health-drop",
      message: "Quote rate still low",
      reasoning: "Second run repeats the signal with fresh samples.",
      falsifier: "A later healthy window would withdraw it.",
      evidence_quotes: ["fresh sample missing quote"],
    }],
  }));
  const row = rowBySlug("classifier-health-drop");
  if (row.status !== "reinforced" || row.seen_count !== 2) {
    throw new Error(`expected reinforced seen=2, got ${JSON.stringify(row)}`);
  }
  if (row.history_tail.length !== 2) throw new Error(`expected 2 history items, got ${row.history_tail.length}`);
});

check("demoted_signal marks a hypothesis contested", () => {
  mergeAt("2026-05-31T10:03:00.000Z", basePromptNative({
    demoted_signals: [{ kind: "classifier health", slug: "classifier-health-drop", reason: "Fresh traces recovered." }],
  }));
  const row = rowBySlug("classifier-health-drop");
  if (row.status !== "contested" || row.demoted_count !== 1) {
    throw new Error(`expected contested demoted=1, got ${JSON.stringify(row)}`);
  }
  if (!row.history_tail.some((h) => h.source === "demoted_signal" && h.status_after === "contested")) {
    throw new Error(`demotion history missing: ${JSON.stringify(row.history_tail)}`);
  }
});

check("withdraw_acknowledgment marks a hypothesis withdrawn", () => {
  mergeAt("2026-05-31T10:04:00.000Z", basePromptNative({
    previous_acknowledgments: [{
      kind: "classifier health",
      slug: "classifier-health-drop",
      status: "withdraw_acknowledgment",
      reason: "The prior advisory was stale after recovery.",
    }],
  }));
  const row = rowBySlug("classifier-health-drop");
  if (row.status !== "withdrawn" || row.withdrawn_count !== 1 || row.acknowledgment_count !== 1) {
    throw new Error(`expected withdrawn ack=1 withdrawn=1, got ${JSON.stringify(row)}`);
  }
});

check("unslugged promoted advisories get stable message-hash keys", () => {
  mergeAt("2026-05-31T10:05:00.000Z", basePromptNative({
    promoted_advisories: [{
      kind: "cost rollup",
      severity: "info",
      message: "Same unslugged hypothesis",
      reasoning: "First unslugged observation.",
      falsifier: "No recurrence.",
      evidence_quotes: [],
    }],
  }));
  mergeAt("2026-05-31T10:06:00.000Z", basePromptNative({
    promoted_advisories: [{
      kind: "cost rollup",
      severity: "info",
      message: "Same unslugged hypothesis",
      reasoning: "Second unslugged observation.",
      falsifier: "No recurrence.",
      evidence_quotes: [],
    }],
  }));
  const rows = readLedgerRows().filter((r) => r.kind === "cost_rollup");
  if (rows.length !== 1) throw new Error(`expected one unslugged row, got ${rows.length}`);
  if (!/^cost_rollup::message:[0-9a-f]{12}$/.test(rows[0].key)) throw new Error(`bad message key: ${rows[0].key}`);
  if (rows[0].status !== "reinforced" || rows[0].seen_count !== 2) throw new Error(`expected reinforced unslugged row, got ${JSON.stringify(rows[0])}`);
});

check("keyed demotion reconciles slug-less promoted hypothesis", () => {
  const before = readLedgerRows().filter((r) => r.kind === "cost_rollup");
  if (before.length !== 1) throw new Error(`expected one cost_rollup row before demotion, got ${before.length}`);
  mergeAt("2026-05-31T10:06:30.000Z", basePromptNative({
    demoted_signals: [{ kind: "cost rollup", key: before[0].key, reason: "Fresh cost shape was normal." }],
  }));
  const rows = readLedgerRows().filter((r) => r.kind === "cost_rollup");
  if (rows.length !== 1) throw new Error(`demotion should not create orphan row, got ${rows.length}`);
  if (rows[0].key !== before[0].key || rows[0].status !== "contested" || rows[0].demoted_count !== 1) {
    throw new Error(`expected same slug-less row contested, got ${JSON.stringify(rows[0])}`);
  }
});

check("keyed withdraw acknowledgment reconciles slug-less promoted hypothesis", () => {
  const before = readLedgerRows().filter((r) => r.kind === "cost_rollup");
  if (before.length !== 1) throw new Error(`expected one cost_rollup row before ack, got ${before.length}`);
  mergeAt("2026-05-31T10:06:45.000Z", basePromptNative({
    previous_acknowledgments: [{
      kind: "cost rollup",
      key: before[0].key,
      status: "withdraw_acknowledgment",
      reason: "The cost-shape concern no longer repeats.",
    }],
  }));
  const rows = readLedgerRows().filter((r) => r.kind === "cost_rollup");
  if (rows.length !== 1) throw new Error(`withdraw should not create orphan row, got ${rows.length}`);
  if (rows[0].key !== before[0].key || rows[0].status !== "withdrawn" || rows[0].withdrawn_count !== 1) {
    throw new Error(`expected same slug-less row withdrawn, got ${JSON.stringify(rows[0])}`);
  }
});

check("summaries are project-scoped and bucket active/contested/withdrawn separately", () => {
  mergeAt("2026-05-31T10:07:00.000Z", basePromptNative({
    demoted_signals: [{ kind: "watchdog", slug: "watchdog-noise", reason: "No real trigger volume." }],
  }));
  mergeAt("2026-05-31T10:08:00.000Z", basePromptNative({
    promoted_advisories: [{ kind: "staging", severity: "warning", slug: "staging-backlog", message: "Backlog rising", reasoning: "Fresh backlog evidence.", falsifier: "Resolver drains it.", evidence_quotes: ["pending=12"] }],
  }));
  mergeAt("2026-05-31T10:09:00.000Z", basePromptNative({
    promoted_advisories: [{ kind: "foreign", severity: "warning", slug: "other-project-only", message: "Other", reasoning: "Other project", falsifier: "None", evidence_quotes: [] }],
  }), otherProjectRoot);

  const s = summarizeEvolutionLedger({ projectRoot });
  const other = summarizeEvolutionLedger({ projectRoot: otherProjectRoot });
  if (s.active_hypotheses.some((h) => h.slug === "other-project-only") || s.contested_hypotheses.some((h) => h.slug === "other-project-only")) {
    throw new Error(`project summary leaked other project: ${JSON.stringify(s)}`);
  }
  if (!s.active_hypotheses.some((h) => h.slug === "staging-backlog")) throw new Error(`active bucket missing staging-backlog: ${JSON.stringify(s)}`);
  if (!s.contested_hypotheses.some((h) => h.slug === "watchdog-noise")) throw new Error(`contested bucket missing watchdog-noise: ${JSON.stringify(s)}`);
  if (!s.withdrawn_hypotheses.some((h) => h.slug === "classifier-health-drop")) throw new Error(`withdrawn bucket missing classifier-health-drop: ${JSON.stringify(s)}`);
  if (other.matching_rows !== 1 || other.active_hypotheses[0]?.slug !== "other-project-only") {
    throw new Error(`other project summary mismatch: ${JSON.stringify(other)}`);
  }
});

check("corrupt ledger lines are ignored and cleaned on next write", () => {
  const before = readLedgerRows().length;
  fs.appendFileSync(evolutionLedgerPath(), "{not valid json\n\n", "utf8");
  const s = summarizeEvolutionLedger({ projectRoot });
  if (s.rows_considered !== before) throw new Error(`corrupt row should be ignored; before=${before}, got rows_considered=${s.rows_considered}`);
  mergeAt("2026-05-31T10:10:00.000Z", basePromptNative({
    promoted_advisories: [{ kind: "cleanup", severity: "info", slug: "cleanup-after-corrupt", message: "cleanup", reasoning: "rewrite ledger", falsifier: "n/a", evidence_quotes: [] }],
  }));
  const raw = fs.readFileSync(evolutionLedgerPath(), "utf8");
  if (raw.includes("{not valid json")) throw new Error("next write should rewrite clean bounded JSONL");
});

check("history tail is bounded to the latest 8 events", () => {
  for (let i = 0; i < 10; i++) {
    mergeAt(`2026-05-31T10:${String(11 + i).padStart(2, "0")}:00.000Z`, basePromptNative({
      promoted_advisories: [{ kind: "tail", severity: "info", slug: "history-tail", message: `event ${i}`, reasoning: `event ${i}`, falsifier: "n/a", evidence_quotes: [] }],
    }));
  }
  const row = rowBySlug("history-tail");
  if (row.history_tail.length !== 8) throw new Error(`history_tail should keep 8, got ${row.history_tail.length}`);
  if (!row.history_tail[0].message.includes("event 2") || !row.history_tail[7].message.includes("event 9")) {
    throw new Error(`history tail should keep newest events 2..9, got ${JSON.stringify(row.history_tail)}`);
  }
});

console.log("\nSource-level integration guards");

check("aggregator imports summarize + merge evolution-ledger helpers", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf8");
  if (!src.includes("summarizeEvolutionLedger") || !src.includes("mergeEvolutionLedger")) {
    throw new Error("aggregator.ts should wire both summarize and merge helpers");
  }
});

check("degraded/no-registry aggregator runs do not merge evolution state", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf8");
  const guard = /if \(aggregatorEngine === "prompt_native_v1" && promptNative\) \{\s*mergeEvolutionLedger\(/m;
  if (!guard.test(src)) {
    throw new Error("mergeEvolutionLedger must stay gated on successful prompt_native_v1 output");
  }
});

check("evolution ledger stays internal: no durable memory writer imports", () => {
  const src = fs.readFileSync(modulePath, "utf8");
  const forbidden = ["./writer", "./curator", "writeProjectEntry", "writeAbrain", "memory_search", "prompt_user"];
  for (const needle of forbidden) {
    if (src.includes(needle)) throw new Error(`evolution-ledger.ts must not contain ${needle}`);
  }
});

console.log(`\nTotal: ${total}  Passed: ${total - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — evolution-ledger L1 self-state contract drifted.");
  process.exit(1);
}
