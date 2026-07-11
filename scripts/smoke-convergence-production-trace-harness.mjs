#!/usr/bin/env node
/**
 * Synthetic-only smoke for P1-B harness isolation, immutable trace manifest,
 * fresh-process boundary plumbing, and validator assertions. This does NOT
 * count as P1-B production acceptance.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const replay = jiti(path.join(repoRoot, "extensions/_shared/production-trace-replay.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p1b-synthetic-smoke-"));
const source = path.join(tmp, "synthetic-source");
const remote = path.join(tmp, "synthetic-origin.git");
const replayRoot = path.join(tmp, "synthetic-replay");
const readConfig = path.join(source, "read-config.json");
const P1B_NEW_IMPLEMENTATION_FILES = new Set([
  "extensions/_shared/production-trace-replay.ts",
  "scripts/_convergence-production-trace-worker.mjs",
  "scripts/dossier-convergence-production-trace.mjs",
  "scripts/smoke-convergence-production-trace-harness.mjs",
]);
let passed = 0;
const failures = [];

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(tmp, "git-home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}
function assert(value, message) { if (!value) throw new Error(message); }
function resign(report) {
  delete report.dossier_self_hash;
  report.dossier_self_hash = jcs.jcsSha256Hex(report);
  return report;
}
function tamper(report, mutate) {
  const copy = structuredClone(report);
  mutate(copy);
  return resign(copy);
}
function walkFiles(root, predicate, output = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(file, predicate, output);
    else if (entry.isFile() && predicate(file)) output.push(file);
  }
  return output;
}
function deterministicContract(report) {
  return {
    schema_version: report.schema_version,
    trace_identity: {
      source_commit: report.trace_manifest.source_commit,
      source_parent: report.trace_manifest.source_parent,
      cohort_root: report.trace_manifest.cohort_root,
    },
    scenario_count: report.scenario_count,
    scenarios: report.scenarios.map((scenario) => ({
      id: scenario.id,
      pass: scenario.pass,
      consumed_trace_anchors: scenario.consumed_trace_anchors,
      injections: scenario.injections.map(({ id, path, type, source_anchor }) => ({ id, path, type, source_anchor })),
      fresh_process_count: scenario.fresh_process_count,
      fault_boundary: scenario.fault_boundary,
      expected: scenario.expected,
      error_code: scenario.error?.code ?? null,
      assertions: scenario.assertions,
      source_path_exposed: scenario.source_path_exposed,
      outside_write_count: scenario.outside_write_count,
    })),
    impact_flags: report.impact_flags,
    isolation_assertions: report.isolation_assertions,
    acceptance: report.acceptance,
  };
}
function contractDifferences(left, right, label = "$", output = []) {
  if (output.length >= 20) return output;
  if (jcs.canonicalizeJcs(left) === jcs.canonicalizeJcs(right)) return output;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) {
    output.push(`${label}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
    return output;
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) contractDifferences(left[key], right[key], `${label}.${key}`, output);
  return output;
}
function assertScenarioIsolation(runRoot) {
  const scenariosRoot = path.join(runRoot, "scenarios");
  const roots = fs.readdirSync(scenariosRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const expected = [...replay.PRODUCTION_TRACE_REPLAY_CONSTANTS.SCENARIO_IDS].sort();
  assert(JSON.stringify(roots) === JSON.stringify(expected), `scenario roots differ: ${JSON.stringify(roots)}`);
  for (const id of expected) {
    const root = path.join(scenariosRoot, id);
    for (const file of walkFiles(root, (candidate) => /(?:config-\d+\.json|result-\d+\.json|git-wrapper-slot-\d+\/)/.test(candidate))) {
      assert(file.startsWith(`${root}${path.sep}`), `cross-scenario artifact path: ${file}`);
      if (/config-\d+\.json$/.test(file)) {
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const field of ["scenario_root", "repo", "abrain_home", "os_home", "remote", "result_path", "git_wrapper_dir", "git_wrapper_trace_dir"].filter((field) => config[field])) {
          assert(config[field] === root || config[field].startsWith(`${root}${path.sep}`), `${id} config ${field} escapes its scenario root`);
        }
      }
    }
  }
}
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack || error}`); }
}
function envelope(body) {
  const hash = l1.canonicalL1BodyHash(body);
  return { schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: hash, body_hash: hash, body };
}
function knowledge(slug, nonce, parents = []) {
  return envelope({
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-07-11T00:00:00.000Z",
    device_id: "p1b-synthetic-smoke",
    producer_nonce: nonce,
    causal_parents: parents,
    session_id: "p1b-synthetic-session",
    turn_id: nonce,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "synthetic-smoke", source_ref: nonce },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    scope: { kind: "world" },
    payload: { slug, title: slug, kind: "fact", status: "active", provenance: "synthetic-only", confidence: 1, compiled_truth: `synthetic ${slug}`, trigger_phrases: [], derives_from: [] },
    sanitizer: { sanitizer_name: "synthetic", sanitizer_version: "1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "not_attempted" },
    producer: { name: "sediment.knowledge-event-writer", version: "synthetic-smoke" },
  });
}
function writeEnvelope(value) {
  const relative = l1.expectedL1EventRelativePath(value.event_id);
  const file = path.join(source, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${jcs.canonicalizeJcs(value)}\n`);
  return relative;
}

console.log("smoke: P1-B production trace replay harness (SYNTHETIC ONLY; not acceptance)");
await check("implementation closure contains only tracked files or explicit non-ignored P1-B additions", async () => {
  const implementationFiles = [...replay.PRODUCTION_TRACE_REPLAY_CONSTANTS.IMPLEMENTATION_FILES];
  for (const relative of implementationFiles) {
    const tracked = git(repoRoot, "ls-files", "--", relative) === relative;
    if (tracked) continue;
    assert(P1B_NEW_IMPLEMENTATION_FILES.has(relative), `untracked implementation path is not in the P1-B commit allowlist: ${relative}`);
    assert(fs.existsSync(path.join(repoRoot, relative)), `allowlisted P1-B implementation path is missing: ${relative}`);
    const untracked = git(repoRoot, "ls-files", "--others", "--exclude-standard", "--", relative);
    assert(untracked === relative, `allowlisted P1-B implementation path is ignored or not untracked: ${relative}`);
  }
  for (const relative of P1B_NEW_IMPLEMENTATION_FILES) {
    assert(implementationFiles.includes(relative), `P1-B commit allowlist path is absent from implementation closure: ${relative}`);
  }
});
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(path.join(tmp, "git-home"), { recursive: true });
git(source, "init", "-q", "-b", "main");
execFileSync("git", ["init", "--bare", "-q", remote]);
git(source, "config", "user.name", "P1B Synthetic Smoke");
git(source, "config", "user.email", "p1b-smoke@example.invalid");
git(source, "remote", "add", "origin", remote);
const parentEvent = knowledge("p1b-parent", "parent");
writeEnvelope(parentEvent);
for (const [relative, bytes] of [
  [".gitignore", ".state/\n"],
  ["rules/base.md", "# synthetic rule\n"],
  ["knowledge/base.md", "# synthetic knowledge\n"],
  ["projects/pi-global/base.md", "# synthetic project\n"],
  ["l2/views/knowledge/latest/world/base.md", "# synthetic L2\n"],
  [".state/sediment/constraint-shadow/latest/compiled-view.md", "synthetic compiled view\n"],
  ["read-config.json", `${JSON.stringify({ ruleInjector: { compiledViewInjection: { enabled: true } }, sediment: { knowledgeProjector: { canonicalReadMode: "projection_only", l2OutputRoot: "repo" } } }, null, 2)}\n`],
]) {
  const file = path.join(source, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
git(source, "add", ".");
git(source, "commit", "-qm", "synthetic parent");
const parent = git(source, "rev-parse", "HEAD");
git(source, "push", "-q", "origin", "HEAD:refs/heads/main");
const targetEvent = knowledge("p1b-target", "target", [parentEvent.event_id]);
writeEnvelope(targetEvent);
fs.writeFileSync(path.join(source, "l2/views/knowledge/latest/world/target.md"), "# synthetic target L2\n");
git(source, "add", ".");
git(source, "commit", "-qm", "synthetic target trace");
const target = git(source, "rev-parse", "HEAD");
fs.mkdirSync(replayRoot, { recursive: true });

let result;
await check("concurrency 1 and 4 produce the same deterministic scenario contract without cross-scenario pollution", async () => {
  process.env.GIT_CONFIG_COUNT = "0";
  process.env.GIT_CONFIG_KEY_0 = "user.name";
  process.env.GIT_CONFIG_VALUE_0 = "must-not-reach-worker";
  const run = async (scenarioConcurrency) => replay.runProductionTraceReplay({
    sourceAbrainHome: source,
    replayRoot,
    runId: "synthetic-harness-smoke",
    implementationRoot: repoRoot,
    workerScript: path.join(repoRoot, "scripts/_convergence-production-trace-worker.mjs"),
    readConfigPath: readConfig,
    sourceCommit: target,
    sourceParent: parent,
    scenarioConcurrency,
  });
  try {
    const serial = await run(1);
    assert(serial.ok, `serial synthetic harness failed: ${JSON.stringify(serial.report?.scenarios?.filter((item) => !item.pass))}`);
    assertScenarioIsolation(path.dirname(serial.reportPath));
    const serialContract = deterministicContract(serial.report);
    const serialContractHash = jcs.jcsSha256Hex(serialContract);
    fs.rmSync(replayRoot, { recursive: true, force: true });
    fs.mkdirSync(replayRoot, { recursive: true });
    result = await run(4);
    assert(result.ok, `parallel synthetic harness failed: ${JSON.stringify(result.report?.scenarios?.filter((item) => !item.pass))}`);
    assertScenarioIsolation(path.dirname(result.reportPath));
    const parallelContract = deterministicContract(result.report);
    const parallelContractHash = jcs.jcsSha256Hex(parallelContract);
    assert(serialContractHash === parallelContractHash, `deterministic contract hash differs: ${serialContractHash} != ${parallelContractHash}; ${contractDifferences(serialContract, parallelContract).join("; ")}`);
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  }
  assert(result.report.trace_manifest.source_commit === target && result.report.trace_manifest.source_parent === parent, "trace provenance mismatch");
  assert(result.report.trace_manifest.entries.length === 2, `expected Git-derived two-path trace, got ${result.report.trace_manifest.entries.length}`);
  assert(result.report.trace_manifest.full_committed_l1_set_count === 2, "committed L1 count was not extracted from target Git tree");
  assert(result.report.scenario_count === 13 && result.report.scenarios.every((item) => item.pass), "scenario matrix is incomplete");
  assert(result.report.execution_timing.scenario_concurrency === 4, "parallel concurrency was not recorded");
  assert(Object.keys(result.report.execution_timing.scenario_durations_ms).length === 13, "scenario durations are incomplete");
  const persisted = JSON.parse(fs.readFileSync(result.reportPath, "utf8"));
  const persistedValidation = replay.validateProductionTraceDossier(persisted);
  assert(persistedValidation.ok, `persisted canonical dossier rejected after reload: ${persistedValidation.errors}`);
});

await check("state cache drift is diagnostic-only while canonical read drift still blocks", async () => {
  const cacheFile = path.join(source, ".state", "synthetic-cache", "cache.bin");
  const readFile = path.join(source, ".state", "sediment", "constraint-shadow", "latest", "compiled-view.md");
  const driftRun = async (name, mutate, cleanup) => {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    try {
      return await replay.runProductionTraceReplay({
        sourceAbrainHome: source,
        replayRoot: root,
        runId: name,
        implementationRoot: repoRoot,
        workerScript: path.join(repoRoot, "scripts/_convergence-production-trace-worker.mjs"),
        readConfigPath: readConfig,
        sourceCommit: target,
        sourceParent: parent,
        scenarioConcurrency: 4,
        afterScenarioMatrix: mutate,
      });
    } finally { cleanup(); }
  };
  const stateOnly = await driftRun("state-cache-drift", () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, "cache drift\n");
  }, () => fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true }));
  assert(stateOnly.ok, `state-only drift blocked acceptance: ${JSON.stringify(stateOnly.report.impact_flags)}`);
  assert(stateOnly.report.impact_flags.sourceChanged === false && stateOnly.report.impact_flags.stateChanged === true && stateOnly.report.impact_flags.extendedSnapshotChanged === true, "state-only drift flags are wrong");
  assert(stateOnly.report.state_diagnostic.blocks_acceptance === false, "state-only diagnostic blocks acceptance");
  assert(replay.validateProductionTraceDossier(stateOnly.report).ok, "validator rejected state-only drift dossier");

  const originalRead = fs.readFileSync(readFile);
  const readDrift = await driftRun("constraint-read-drift", () => fs.writeFileSync(readFile, "changed canonical read bundle\n"), () => fs.writeFileSync(readFile, originalRead));
  assert(!readDrift.ok && readDrift.report.impact_flags.readChanged === true && readDrift.report.impact_flags.sourceChanged === true, "canonical read drift did not block");
  assert(readDrift.report.state_diagnostic.blocks_acceptance === true, "read drift state diagnostic did not block");
});

await check("unsafe state symlink fails closed", async () => {
  const unsafeRoot = path.join(tmp, "state-symlink-drift");
  const link = path.join(source, ".state", "unsafe-link");
  fs.mkdirSync(unsafeRoot, { recursive: true });
  let code = "";
  try {
    await replay.runProductionTraceReplay({
      sourceAbrainHome: source,
      replayRoot: unsafeRoot,
      runId: "state-symlink-drift",
      implementationRoot: repoRoot,
      workerScript: path.join(repoRoot, "scripts/_convergence-production-trace-worker.mjs"),
      readConfigPath: readConfig,
      sourceCommit: target,
      sourceParent: parent,
      scenarioConcurrency: 4,
      afterScenarioMatrix: () => fs.symlinkSync(tmp, link),
    });
  } catch (error) { code = String(error?.code || ""); }
  finally { fs.rmSync(link, { force: true }); }
  assert(code === "P1B_SOURCE_UNSAFE", `unsafe state symlink was not rejected exactly: ${code}`);
});

await check("semantic dossier validator rejects independently re-signed contract tampering", () => {
  const valid = replay.validateProductionTraceDossier(result.report);
  assert(valid.ok, `valid dossier rejected: ${valid.errors}`);
  const cases = [
    ["scenario id", tamper(result.report, (copy) => { copy.scenarios[0].id = "claim-race-tampered"; }), "scenario_ids"],
    ["fresh count", tamper(result.report, (copy) => { copy.scenarios.find((item) => item.id === "claim-race").fresh_process_count = 7; }), "fresh_process_count"],
    ["trace anchor", tamper(result.report, (copy) => { copy.scenarios[0].consumed_trace_anchors[0] = "not/a/registered-anchor"; }), ":anchors"],
    ["push classification", tamper(result.report, (copy) => { copy.scenarios.find((item) => item.id === "push-retry").observed.transient_transport_evidence.slot1.classification = "nonretryable"; }), ":observed"],
    ["injection shape", tamper(result.report, (copy) => { copy.scenarios[0].injections[0].type = "arbitrary-resigned-type"; }), ":injections"],
    ["cohort root", tamper(result.report, (copy) => { copy.trace_manifest.cohort_root = "0".repeat(64); }), "trace_cohort_root"],
    ["state flag without extended flag", tamper(result.report, (copy) => { copy.impact_flags.stateChanged = true; }), "impact_stateChanged"],
    ["blocking source flag", tamper(result.report, (copy) => { copy.impact_flags.readChanged = true; copy.impact_flags.sourceChanged = true; copy.state_diagnostic.blocks_acceptance = true; copy.acceptance.source_stable = false; }), "state_diagnostic_blocks_acceptance"],
    ["state diagnostic delta", tamper(result.report, (copy) => { copy.state_diagnostic.delta.bytes += 1; }), "state_diagnostic"],
  ];
  for (const [name, dossier, expectedError] of cases) {
    const checked = replay.validateProductionTraceDossier(dossier);
    assert(!checked.ok && checked.errors.some((item) => item.includes(expectedError)), `${name} tamper accepted or rejected for wrong reason: ${checked.errors}`);
  }
  assert(!replay.validateProductionTraceDossier(tamper(result.report, (copy) => { copy.scope.claim = "P1-B and P1-A"; })).ok, "scope overclaim accepted");
  assert(!replay.validateProductionTraceDossier(tamper(result.report, (copy) => { copy.scenarios[0].source_path_exposed = true; })).ok, "source exposure accepted");
  const badHash = structuredClone(result.report);
  badHash.dossier_self_hash = "0".repeat(64);
  assert(!replay.validateProductionTraceDossier(badHash).ok, "bad logical self hash accepted");
});

await check("artifact verifier rejects a re-signed, internally consistent trace forgery", async () => {
  const valid = await replay.verifyProductionTraceDossierArtifacts(result.report, {
    bundlePath: path.join(path.dirname(result.reportPath), "source-objects.bundle"),
    implementationRoot: repoRoot,
    reportFilePath: result.reportPath,
    expectedReportSha256: result.reportSha256,
    expectedReportBytes: result.reportBytes,
  });
  assert(valid.bundle && valid.trace_entries && valid.full_l1 && valid.implementation && valid.report_file, "valid artifacts were not fully verified");

  const forged = structuredClone(result.report);
  forged.trace_manifest.entries[0].bytes_sha256 = "0".repeat(64);
  const rows = forged.trace_manifest.entries.map((entry) => ({ path: entry.path, op: entry.op, mode: entry.new_mode, bytes_sha256: entry.bytes_sha256 }));
  forged.trace_manifest.cohort_root = crypto.createHash("sha256").update(`pi-astack/p1b/production-trace-cohort/v1\n${jcs.canonicalizeJcs(rows)}`).digest("hex");
  resign(forged);
  const internal = replay.validateProductionTraceDossier(forged);
  assert(internal.ok, `internally consistent forgery should reach artifact layer: ${internal.errors}`);
  let rejected = false;
  try {
    await replay.verifyProductionTraceDossierArtifacts(forged, {
      bundlePath: path.join(path.dirname(result.reportPath), "source-objects.bundle"),
      implementationRoot: repoRoot,
    });
  } catch (error) {
    rejected = String(error?.code || "").startsWith("P1B_ARTIFACT_");
  }
  assert(rejected, "artifact verifier accepted re-signed trace entry/cohort forgery");
});

await check("scenario execution is source-blind and worker Git environment is fail-closed", () => {
  const implementation = fs.readFileSync(path.join(repoRoot, "extensions/_shared/production-trace-replay.ts"), "utf8");
  const scenarioCode = implementation.slice(implementation.indexOf("async function setupScenario"), implementation.indexOf("async function auditScenarioArtifacts"));
  assert(!scenarioCode.includes("context.source") && !scenarioCode.includes("sourceReal") && !scenarioCode.includes("sourceOriginUrls") && !scenarioCode.includes("/home/worker/.abrain"), "scenario execution code can access production source context");
  assert(scenarioCode.includes("loadTraceEnvelopeFromScenarioRepo") && !scenarioCode.includes("loadRealTraceEnvelope"), "validator scenarios do not read transferred repo objects");
  assert(implementation.includes('if (!key.startsWith("GIT_")') && implementation.includes("unexpectedGitEnvironment"), "Git environment fail-closed scrub/self-check missing");
  const runRoot = path.dirname(result.reportPath);
  const workerResults = walkFiles(runRoot, (file) => /worker-output\/result-\d+\.json$/.test(file));
  assert(workerResults.length >= 22, `expected fresh worker results, got ${workerResults.length}`);
  for (const file of workerResults) {
    const worker = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(worker.assertions?.git_env_scrubbed === true, `worker Git env assertion missing: ${file}`);
  }
});

await check("synthetic smoke is explicitly non-counting and file hash is externally reproducible", () => {
  assert(String(result.report.scope.synthetic_counting_rule).includes("does not count"), "synthetic non-counting rule missing");
  const bytes = fs.readFileSync(result.reportPath);
  assert(crypto.createHash("sha256").update(bytes).digest("hex") === result.reportSha256, "external file hash mismatch");
  assert(bytes.length === result.reportBytes, "external byte count mismatch");
});

console.log(`\n${passed}/${passed + failures.length} checks passed (synthetic only)`);
if (process.env.P1B_KEEP_SYNTHETIC !== "1") fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`syntheticRoot=${tmp}`);
if (failures.length) process.exit(1);
