#!/usr/bin/env node
/**
 * Smoke: ADR0039 Constraint runtime gate dossier.
 *
 * Uses only temporary abrain/settings fixtures. Verifies hard-fail and warning
 * behavior without touching ~/.abrain or runtime settings.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const gateScript = path.join(repoRoot, "scripts", "dossier-constraint-runtime-gate.mjs");
const failures = [];
let total = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function check(name, fn) {
  total += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(file, rows) {
  writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function makeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-runtime-gate-"));
  const abrainHome = path.join(root, "abrain");
  const settingsPath = path.join(root, "pi-astack-settings.json");
  const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
  const latestDir = path.join(shadowRoot, "latest");
  const now = Date.now();
  const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
  const settings = {
    ruleInjector: {
      compiledViewInjection: {
        enabled: true,
        fallbackToLegacyOnError: false,
        requireFresh: true,
        minCoverageRatio: 1,
      },
    },
  };
  const decision = {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: "input-root-fixture",
    validationHash: "validation-fixture",
    constraints: [],
    exclusions: [],
    unresolved: [],
  };
  const coverageSummary = {
    totalEvents: 1,
    validEvents: 1,
    invalidEvents: 0,
    queuedEvents: 0,
    projectedEvents: 1,
    staleEvents: 0,
    appendFailedEvents: 0,
    deferredMergedSourceEvents: 0,
    deferredUnresolvedEvents: 0,
    coverageRatio: 1,
    injectableCoverageRatio: 1,
    provenance: { liveEvents: 1, replayBackfillEvents: 0, manualEvents: 0, unknownEvents: 0 },
    ...(overrides.coverageSummary ?? {}),
  };
  const verifier = {
    schemaVersion: "constraint-merged-source-verifier/v1",
    inputRootHash: overrides.verifierInputRootHash ?? decision.inputRootHash,
    decisionValidationHash: overrides.verifierDecisionValidationHash ?? decision.validationHash,
    decisionHash: "decision-hash-fixture",
    verifierInputHash: "verifier-input-hash-fixture",
    summary: { totalRows: 0, expressedRows: 0, notExpressedRows: 0, uncertainRows: 0 },
    rows: [],
    generator: { modelRef: "fixture/model" },
  };
  writeJson(settingsPath, settings);
  writeJson(path.join(latestDir, "decision.json"), decision);
  writeFile(path.join(latestDir, "compiled-view.md"), "# Fixture compiled view\n");
  writeJson(path.join(latestDir, "event-coverage.json"), {
    schemaVersion: "constraint-event-coverage/v1",
    summary: coverageSummary,
    rows: [{ eventId: "event-fixture", sourceRecordId: "source-fixture", status: "projected", diagnostics: [] }],
  });
  if (overrides.omitVerifier !== true) writeJson(path.join(latestDir, "merged-source-verifier.json"), verifier);
  appendJsonl(path.join(shadowRoot, "auto-refresh", "audit.jsonl"), [
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: iso(-11 * 60_000), ok: true, status: "started", sourceEventId: "event-fixture", modelRef: "fixture/model" },
    {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: iso(-10 * 60_000),
      ok: overrides.autoRefreshOk ?? true,
      status: "completed",
      sourceEventId: "event-fixture",
      modelRef: "fixture/model",
      durationMs: 1234,
      result: { ok: overrides.autoRefreshOk ?? true, eventCoverage: coverageSummary },
    },
  ]);
  const sessionStartRows = overrides.sessionStartRows ?? 3;
  const rows = [];
  for (let i = 0; i < sessionStartRows; i += 1) {
    rows.push({
      schemaVersion: "rule-injector-dualread-audit/v1",
      observedAtUtc: iso(-i * 60_000),
      status: overrides.sessionStatus ?? "match",
      stale: overrides.sessionStale ?? false,
      eventCoverage: coverageSummary,
      summary: { legacyRules: 0, shadowConstraints: 0, compiledOnly: 0, legacyOnly: overrides.legacyOnly ?? 0, bothMatch: 0, textDelta: overrides.textDelta ?? 0 },
      delta: { legacyOnly: [], textDelta: [] },
    });
  }
  appendJsonl(path.join(shadowRoot, "session-start-dualread", "audit.jsonl"), rows);
  if (overrides.omitLiveCanary !== true) {
    appendJsonl(path.join(shadowRoot, "session-live-canary", "audit.jsonl"), [{
      schemaVersion: "rule-injector-session-live-canary-audit/v1",
      observedAtUtc: iso(-500),
      sessionId: "fixture-session",
      decision: "compiled_injected",
      compiledStatus: "ok",
      coverageRatio: 1,
      injectableCoverageRatio: 1,
      stale: false,
    }]);
  }
  return { root, abrainHome, settingsPath };
}

function runGate(fixture, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    gateScript,
    "--abrain", fixture.abrainHome,
    "--settings", fixture.settingsPath,
    "--min-session-starts", "3",
    "--window-days", "7",
    "--json",
    ...extraArgs,
  ], { cwd: repoRoot, encoding: "utf8" });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`gate did not emit JSON. exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { result, json };
}

console.log("ADR0039 constraint runtime gate smoke");

check("PASS fixture exits 0 with no hard failures", () => {
  const fixture = makeFixture();
  const { result, json } = runGate(fixture);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr || result.stdout}`);
  assert(json.gate.pass === true, `expected pass: ${JSON.stringify(json.gate)}`);
  assert(json.gate.hardFailures.length === 0, `unexpected hard failures: ${JSON.stringify(json.gate.hardFailures)}`);
  assert(json.latest.coverage.coverageRatio === 1, "coverage summary missing");
  assert(json.latest.verifier.bindingMatchesDecision === true, "verifier binding did not match");
});

check("coverage below threshold exits 1", () => {
  const fixture = makeFixture({ coverageSummary: { coverageRatio: 0.5, injectableCoverageRatio: 0.5 } });
  const { result, json } = runGate(fixture);
  assert(result.status === 1, `expected exit 1, got ${result.status}`);
  assert(json.gate.hardFailures.some((item) => item.includes("coverageRatio below")), `missing coverage failure: ${JSON.stringify(json.gate.hardFailures)}`);
});

check("verifier binding mismatch exits 1", () => {
  const fixture = makeFixture({ verifierInputRootHash: "wrong-input-root" });
  const { result, json } = runGate(fixture);
  assert(result.status === 1, `expected exit 1, got ${result.status}`);
  assert(json.gate.hardFailures.some((item) => item.includes("binding does not match")), `missing verifier failure: ${JSON.stringify(json.gate.hardFailures)}`);
});

check("insufficient session-start rows warns but exits 0", () => {
  const fixture = makeFixture({ sessionStartRows: 1 });
  const { result, json } = runGate(fixture);
  assert(result.status === 0, `expected warning-only exit 0, got ${result.status}: ${JSON.stringify(json.gate)}`);
  assert(json.gate.warnings.some((item) => item.includes("rows below --min-session-starts")), `missing insufficient warning: ${JSON.stringify(json.gate.warnings)}`);
  assert(json.gate.hardFailures.length === 0, `unexpected hard failures: ${JSON.stringify(json.gate.hardFailures)}`);
});

check("decision mtime excludes earlier post-auto-refresh coverage-bad rows", () => {
  const fixture = makeFixture();
  const now = Date.now();
  const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
  const shadowRoot = path.join(fixture.abrainHome, ".state", "sediment", "constraint-shadow");
  const decisionPath = path.join(shadowRoot, "latest", "decision.json");
  const decisionMtime = new Date(now - 5 * 60_000);
  fs.utimesSync(decisionPath, decisionMtime, decisionMtime);
  const actualDecisionMtimeMs = fs.statSync(decisionPath).mtimeMs;
  const row = (offsetMs, coverageRatio) => ({
    schemaVersion: "rule-injector-dualread-audit/v1",
    observedAtUtc: iso(offsetMs),
    status: "match",
    stale: false,
    coverageRatio,
    injectableCoverageRatio: coverageRatio,
    summary: { legacyRules: 0, shadowConstraints: 0, compiledOnly: 0, legacyOnly: 0, bothMatch: 0, textDelta: 0 },
    delta: { legacyOnly: [], textDelta: [] },
  });
  appendJsonl(path.join(shadowRoot, "session-start-dualread", "audit.jsonl"), [
    row(-6 * 60_000, 0.5),
    row(-4 * 60_000, 1),
    row(-3 * 60_000, 1),
    row(-2 * 60_000, 1),
  ]);
  const { result, json } = runGate(fixture);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${JSON.stringify(json.gate)}`);
  assert(Date.parse(json.sessionStartDualReadPostRefresh.cutoffUtc) >= Math.floor(actualDecisionMtimeMs), `cutoff did not use decision mtime: ${json.sessionStartDualReadPostRefresh.cutoffUtc}`);
  assert(json.sessionStartDualReadPostRefresh.rows === 3, `expected 3 post-refresh rows after decision mtime: ${JSON.stringify(json.sessionStartDualReadPostRefresh)}`);
  assert(json.sessionStartDualReadPostRefresh.coverageBadRows === 0, `bad row leaked into post-refresh summary: ${JSON.stringify(json.sessionStartDualReadPostRefresh)}`);
  assert(json.gate.warnings.some((item) => item.includes("historical session-start dual-read coverage-bad")), `missing historical warning: ${JSON.stringify(json.gate.warnings)}`);
  assert(json.gate.hardFailures.length === 0, `unexpected hard failures: ${JSON.stringify(json.gate.hardFailures)}`);
});

if (failures.length) {
  console.log(`FAIL — ${failures.length}/${total} constraint runtime gate smoke checks failed.`);
  process.exit(1);
}
console.log(`PASS — ${total} constraint runtime gate smoke checks passed.`);
process.exit(0);
