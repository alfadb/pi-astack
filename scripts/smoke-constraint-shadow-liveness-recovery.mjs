#!/usr/bin/env node
/**
 * Smoke test: constraint shadow auto-refresh guard retry + liveness recovery.
 *
 * Offline only. Uses a transpiled auto-refresh module with stubbed compiler/runtime
 * dependencies and temporary abrain trees.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}

function readJsonlRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(name, predicate, timeoutMs = 2_000, intervalMs = 25) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${name}`);
}

function baseSettings(overrides = {}) {
  return {
    curatorModel: "",
    constraintShadowCompiler: {
      enabled: true,
      model: "test/model",
      maxPromptChars: 1000,
      maxCompileRetries: 0,
      timeoutMs: 1000,
      maxRetries: 0,
      l2OutputRoot: "state",
      mergedSourceVerifier: { enabled: false, model: "", maxPromptChars: 0 },
      autoRefresh: {
        enabled: true,
        debounceMs: 60_000,
        minIntervalMs: 0,
        eventStaleAfterMs: 0,
        maxPromptChars: 1000,
      },
      ...overrides,
    },
  };
}

function trigger(abrainHome, settings, extra = {}) {
  return {
    abrainHome,
    cwd: abrainHome,
    settings,
    modelRegistry: {
      find: () => ({}),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }),
    },
    reason: "smoke",
    ...extra,
  };
}

const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-liveness-smoke-"));
writeFile(
  path.join(outRoot, "sediment", "constraint-compiler", "auto-refresh.js"),
  transpile(path.join(repoRoot, "extensions", "sediment", "constraint-compiler", "auto-refresh.ts")),
);
writeFile(path.join(outRoot, "sediment", "constraint-compiler", "pi-ai-invoker.js"), `
exports.createPiAiConstraintCompilerInvoker = () => async () => ({ ok: false, error: "stub" });
exports.createPiAiMergedSourceVerifierInvoker = () => async () => ({ ok: false, error: "stub" });
`);
writeFile(path.join(outRoot, "sediment", "constraint-compiler", "shadow-runner.js"), `
exports.runConstraintShadowCompiler = async () => { throw new Error("compiler should not run in liveness smoke"); };
`);
writeFile(path.join(outRoot, "sediment", "writer.js"), `
exports.commitAbrainDerivedOutputs = async () => null;
`);
writeFile(path.join(outRoot, "_shared", "causal-anchor.js"), `
exports.getDeviceId = () => "smoke-device";
`);
writeFile(path.join(outRoot, "_shared", "durable-write.js"), `
const fs = require("node:fs/promises");
exports.fsyncDirectory = async (dir) => {
  const handle = await fs.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};
`);
writeFile(path.join(outRoot, "_shared", "runtime.js"), `
const path = require("node:path");
exports.abrainSedimentLocksDir = (abrainHome) => path.join(abrainHome, ".state", "locks");
exports.acquireFileLock = async () => ({ release: async () => undefined });
`);

const autoRefresh = require(path.join(outRoot, "sediment", "constraint-compiler", "auto-refresh.js"));
const {
  ensureConstraintShadowLiveness,
  readConstraintPublicationDurability,
  resumeConstraintShadowAutoRefreshAtStartup,
  _scheduleConstraintShadowAutoRefreshWithCompilerForTests,
  _runConstraintShadowAutoRefreshNowForTests,
  _setConstraintShadowMarkerDirectorySyncForTests,
  _resetConstraintShadowAutoRefreshForTests,
} = autoRefresh;

if (process.argv.includes("--resume-worker")) {
  const abrainHome = process.env.CONSTRAINT_RESUME_ABRAIN;
  if (!abrainHome) throw new Error("CONSTRAINT_RESUME_ABRAIN is required");
  const result = await resumeConstraintShadowAutoRefreshAtStartup(trigger(abrainHome, baseSettings(), { reason: "fresh-process-startup" }));
  _resetConstraintShadowAutoRefreshForTests();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

const pending = [];
let checkChain = Promise.resolve();
function asyncCheck(name, fn) {
  total += 1;
  checkChain = checkChain.then(fn).then(
    () => console.log(`  ok    ${name}`),
    (err) => {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
    },
  );
  pending.push(checkChain);
}

asyncCheck("guard early return audits model_registry_unavailable and schedules bounded retry", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-guard-registry-"));
  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  await _runConstraintShadowAutoRefreshNowForTests(trigger(abrainHome, baseSettings(), { modelRegistry: undefined }));
  const rows = readJsonlRows(auditFile);
  assert(rows.some((row) => row.status === "model_registry_unavailable" && row.ok === false), "missing model_registry_unavailable audit row");
  assert(rows.some((row) => row.status === "retry_scheduled" && row.previousStatus === "model_registry_unavailable" && row.retryAttempt === 1), "missing retry_scheduled audit row for registry guard");
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("guard early return audits model_not_configured and schedules bounded retry", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-guard-model-"));
  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  const settings = baseSettings({ model: "" });
  await _runConstraintShadowAutoRefreshNowForTests(trigger(abrainHome, settings));
  const rows = readJsonlRows(auditFile);
  assert(rows.some((row) => row.status === "model_not_configured" && row.ok === false), "missing model_not_configured audit row");
  assert(rows.some((row) => row.status === "retry_scheduled" && row.previousStatus === "model_not_configured" && row.retryAttempt === 1), "missing retry_scheduled audit row for model guard");
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("liveness recovery schedules once for stale compiled view with queued evidence", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-liveness-"));
  const latest = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  writeFile(path.join(latest, "compiled-view.md"), "# stale compiled view\n");
  writeFile(path.join(latest, "decision.json"), "{}\n");
  writeFile(path.join(latest, "event-coverage.json"), JSON.stringify({ rows: [] }, null, 2) + "\n");
  fs.utimesSync(path.join(latest, "compiled-view.md"), old, old);
  fs.utimesSync(path.join(latest, "decision.json"), old, old);

  writeFile(path.join(abrainHome, "l1", "events", "sha256", "aa", "event-one.json"), JSON.stringify({
    schema: "constraint-evidence-envelope/v1",
    event_id: "event-one",
    body: { created_at_utc: old.toISOString() },
  }, null, 2) + "\n");

  const result = await ensureConstraintShadowLiveness(trigger(abrainHome, baseSettings(), { reason: "initial" }));
  assert(result.scheduled === true, `expected liveness schedule, got ${JSON.stringify(result)}`);
  assert(result.queuedEvents === 1, `expected queuedEvents=1, got ${result.queuedEvents}`);

  const markerFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");
  await waitFor("liveness needs-refresh marker", () => readJsonlRows(markerFile).some((row) => row.reason === "liveness_recovery"));
  const markerRowsAfterFirstEnsure = readJsonlRows(markerFile).length;

  const second = await ensureConstraintShadowLiveness(trigger(abrainHome, baseSettings(), { reason: "second" }));
  assert(second.scheduled === false && second.reason === "liveness_recovery_already_attempted", `expected one-shot guard, got ${JSON.stringify(second)}`);
  await sleep(75);
  assert(readJsonlRows(markerFile).length === markerRowsAfterFirstEnsure, "second ensure must not append another needs-refresh marker");

  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  const rows = readJsonlRows(auditFile);
  assert(rows.filter((row) => row.status === "liveness_recovery_scheduled" && row.reason === "liveness_recovery").length === 1, "expected exactly one liveness recovery audit row");
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("timer is never armed before the needs-refresh marker is durable", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-marker-boundary-"));
  writeFile(path.join(abrainHome, ".state"), "blocks marker directory creation\n");
  let compilerRuns = 0;
  const settings = baseSettings({ autoRefresh: { enabled: true, debounceMs: 0, minIntervalMs: 0, eventStaleAfterMs: 0, maxPromptChars: 1000 } });
  const scheduled = await _scheduleConstraintShadowAutoRefreshWithCompilerForTests(
    trigger(abrainHome, settings, { sourceEventId: "c".repeat(64) }),
    async () => { compilerRuns += 1; throw new Error("timer crossed marker boundary"); },
  );
  assert(scheduled.scheduled === false && scheduled.reason === "needs_refresh_marker_write_failed", `marker failure did not fail scheduling: ${JSON.stringify(scheduled)}`);
  await sleep(75);
  assert(compilerRuns === 0, `compiler ran ${compilerRuns} time(s) before durable marker`);
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("directory fsync failure never arms and a fresh process recovers the file-fsynced marker", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-marker-dir-sync-"));
  const eventId = "d".repeat(64);
  let compilerRuns = 0;
  _setConstraintShadowMarkerDirectorySyncForTests(async () => { throw new Error("injected directory fsync failure"); });
  const settings = baseSettings({ autoRefresh: { enabled: true, debounceMs: 0, minIntervalMs: 0, eventStaleAfterMs: 0, maxPromptChars: 1000 } });
  const scheduled = await _scheduleConstraintShadowAutoRefreshWithCompilerForTests(
    trigger(abrainHome, settings, { sourceEventId: eventId }),
    async () => { compilerRuns += 1; throw new Error("timer crossed directory durability boundary"); },
  );
  assert(scheduled.scheduled === false && scheduled.reason === "needs_refresh_marker_write_failed", `directory sync failure did not block scheduling: ${JSON.stringify(scheduled)}`);
  await sleep(75);
  assert(compilerRuns === 0, `compiler ran ${compilerRuns} time(s) after directory sync failure`);
  const markerFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");
  assert(readJsonlRows(markerFile).some((row) => row.sourceEventId === eventId), "file-fsynced marker was not left recoverable after directory sync failure");
  _resetConstraintShadowAutoRefreshForTests();

  const freshProcess = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--resume-worker"], {
    env: { ...process.env, CONSTRAINT_RESUME_ABRAIN: abrainHome },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert(freshProcess.status === 0, `fresh marker recovery failed: ${freshProcess.stdout}\n${freshProcess.stderr}`);
  const resumed = JSON.parse(freshProcess.stdout.trim());
  assert(resumed.scheduled === true && resumed.sourceEventId === eventId, `fresh process did not recover marker after directory sync failure: ${JSON.stringify(resumed)}`);
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("legacy remote_durable audit fixture is read-only local durability evidence", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-legacy-remote-durable-"));
  const eventId = "e".repeat(64);
  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  const fixture = path.join(repoRoot, "scripts", "fixtures", "constraint-auto-refresh-legacy-remote-durable-audit.jsonl");
  writeFile(auditFile, fs.readFileSync(fixture, "utf8"));
  const durability = await readConstraintPublicationDurability(abrainHome, eventId);
  assert(durability.durable === true && durability.required === "local_durable", `legacy audit evidence not accepted locally: ${JSON.stringify(durability)}`);
  assert(durability.publication === undefined, `legacy remote status escaped through the production publication type: ${JSON.stringify(durability)}`);
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("startup resumes durable marker and pending publication cannot unlock it", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-startup-resume-"));
  const eventId = "a".repeat(64);
  const markerFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");
  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  writeFile(markerFile, `${JSON.stringify({ schemaVersion: "constraint-shadow-auto-refresh-needs-refresh/v1", observedAtUtc: "2026-07-11T00:00:00.000Z", reason: "restart_fixture", sourceEventId: eventId, modelRef: "test/model" })}\n`);
  writeFile(auditFile, `${JSON.stringify({ schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-11T00:00:01.000Z", ok: true, status: "completed", sourceEventId: eventId, publication: { status: "durable_pending", commit: "b".repeat(40), localCommit: "index_converged", drainStatus: "index_converged", canonical: true } })}\n`);
  const pendingDurability = await readConstraintPublicationDurability(abrainHome, eventId);
  assert(pendingDurability.durable === false && pendingDurability.required === "local_durable", `durable_pending incorrectly unlocked correlation: ${JSON.stringify(pendingDurability)}`);
  const freshProcess = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--resume-worker"], {
    env: { ...process.env, CONSTRAINT_RESUME_ABRAIN: abrainHome },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert(freshProcess.status === 0, `fresh startup process failed: ${freshProcess.stdout}\n${freshProcess.stderr}`);
  const resumed = JSON.parse(freshProcess.stdout.trim());
  assert(resumed.scheduled === true && resumed.sourceEventId === eventId, `fresh process did not resume marker: ${JSON.stringify(resumed)}`);
  assert(readJsonlRows(auditFile).some((row) => row.status === "startup_retry_scheduled" && row.sourceEventId === eventId), "startup retry audit missing");
  _resetConstraintShadowAutoRefreshForTests();

  fs.appendFileSync(auditFile, `${JSON.stringify({ schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-11T00:00:02.000Z", ok: true, status: "completed", sourceEventId: eventId, publication: { status: "local_durable", commit: "c".repeat(40), localCommit: "index_converged", drainStatus: "index_converged", canonical: true } })}\n`);
  const durable = await readConstraintPublicationDurability(abrainHome, eventId);
  assert(durable.durable === true, `local_durable correlation not recognized: ${JSON.stringify(durable)}`);
  const settled = await resumeConstraintShadowAutoRefreshAtStartup(trigger(abrainHome, baseSettings(), { reason: "startup" }));
  assert(settled.scheduled === false && settled.reason === "marker_already_durable", `durable marker was redundantly scheduled: ${JSON.stringify(settled)}`);
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("first startup without a compiled view recovers from readable durable L1 evidence", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-first-startup-"));
  writeFile(path.join(abrainHome, "l1", "events", "sha256", "cc", "event-first.json"), JSON.stringify({
    schema: "constraint-evidence-envelope/v1",
    event_id: "event-first",
    body: { created_at_utc: new Date().toISOString() },
  }, null, 2) + "\n");
  const result = await ensureConstraintShadowLiveness(trigger(abrainHome, baseSettings(), { reason: "first-startup" }));
  assert(result.scheduled === true && result.queuedEvents === 1, `first startup lost durable L1 evidence: ${JSON.stringify(result)}`);
  assert(result.queuedFallbackReason === "event_coverage_missing", `first startup fallback reason missing: ${JSON.stringify(result)}`);
  _resetConstraintShadowAutoRefreshForTests();
});

asyncCheck("liveness recovery falls back to readable L1 evidence when coverage is missing", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-liveness-fallback-"));
  const latest = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  writeFile(path.join(latest, "compiled-view.md"), "# stale compiled view\n");
  writeFile(path.join(latest, "decision.json"), "{}\n");
  fs.utimesSync(path.join(latest, "compiled-view.md"), old, old);
  fs.utimesSync(path.join(latest, "decision.json"), old, old);

  writeFile(path.join(abrainHome, "l1", "events", "sha256", "bb", "event-two.json"), JSON.stringify({
    schema: "constraint-evidence-envelope/v1",
    event_id: "event-two",
    body: { created_at_utc: old.toISOString() },
  }, null, 2) + "\n");

  const result = await ensureConstraintShadowLiveness(trigger(abrainHome, baseSettings(), { reason: "fallback" }));
  assert(result.scheduled === true, `expected fallback liveness schedule, got ${JSON.stringify(result)}`);
  assert(result.queuedEvents === 1, `expected fallback queuedEvents=1, got ${result.queuedEvents}`);
  assert(result.queuedFallbackReason === "event_coverage_missing", `expected event_coverage_missing fallback, got ${result.queuedFallbackReason}`);

  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  const rows = readJsonlRows(auditFile);
  assert(rows.some((row) => row.status === "liveness_recovery_scheduled" && row.queuedFallbackReason === "event_coverage_missing"), "missing liveness fallback audit reason");
  _resetConstraintShadowAutoRefreshForTests();
});

await Promise.all(pending);

if (failures.length) {
  console.error(`\n${failures.length}/${total} checks failed`);
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.err && failure.err.stack ? failure.err.stack : failure.err}`);
  process.exit(1);
}
console.log(`\nAll ${total} constraint shadow liveness recovery smoke checks passed.`);
