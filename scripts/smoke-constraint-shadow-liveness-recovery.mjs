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
writeFile(path.join(outRoot, "_shared", "runtime.js"), `
const path = require("node:path");
exports.abrainSedimentLocksDir = (abrainHome) => path.join(abrainHome, ".state", "locks");
exports.acquireFileLock = async () => ({ release: async () => undefined });
`);

const autoRefresh = require(path.join(outRoot, "sediment", "constraint-compiler", "auto-refresh.js"));
const {
  ensureConstraintShadowLiveness,
  _runConstraintShadowAutoRefreshNowForTests,
  _resetConstraintShadowAutoRefreshForTests,
} = autoRefresh;

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
