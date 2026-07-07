#!/usr/bin/env node
/**
 * Smoke: ADR0039 constraint legacy retirement blocker dossier.
 *
 * Uses temporary abrain fixtures only. Verifies latest-only parsing,
 * post-refresh cutoff selection, and empty-delta ready=true behavior.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dossierScript = path.join(repoRoot, "scripts", "dossier-constraint-legacy-retirement.mjs");
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

function writeJsonl(file, rows) {
  writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-legacy-retirement-"));
  const abrainHome = path.join(root, "abrain");
  const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
  const latestDir = path.join(shadowRoot, "latest");
  writeJson(path.join(latestDir, "event-coverage.json"), {
    schemaVersion: "constraint-event-coverage/v1",
    summary: { totalEvents: 1, projectedEvents: 1, queuedEvents: 0, staleEvents: 0, coverageRatio: 1, injectableCoverageRatio: 1 },
  });
  writeJson(path.join(latestDir, "merged-source-verifier.json"), {
    schemaVersion: "constraint-merged-source-verifier/v1",
    inputRootHash: "input-fixture",
    decisionValidationHash: "validation-fixture",
    summary: { totalRows: 1, expressedRows: 1, notExpressedRows: 0, uncertainRows: 0 },
    generator: { modelRef: "fixture/model" },
  });
  return { root, abrainHome, shadowRoot };
}

function runDossier(fixture, args = []) {
  const result = spawnSync(process.execPath, [
    dossierScript,
    "--abrain", fixture.abrainHome,
    "--window-days", "30",
    "--json",
    ...args,
  ], { cwd: repoRoot, encoding: "utf8" });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`dossier did not emit JSON. exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { result, json };
}

function row(observedAtUtc, overrides = {}) {
  return {
    schemaVersion: "rule-injector-dualread-audit/v1",
    observedAtUtc,
    cwd: "/fixture/project",
    activeProjectId: "fixture-project",
    status: "match",
    inputRootHash: "input-fixture",
    validationHash: "validation-fixture",
    stale: false,
    summary: { legacyRules: 1, shadowConstraints: 1, compiledOnly: 0, legacyOnly: 0, bothMatch: 1, textDelta: 0 },
    delta: { compiledOnly: [], legacyOnly: [], bothMatch: ["rule:global:always:ok"], textDelta: [] },
    ...overrides,
  };
}

console.log("ADR0039 constraint legacy retirement smoke");

check("latest-only parses details and reports ready=false", () => {
  const fixture = makeFixture();
  writeJsonl(path.join(fixture.shadowRoot, "session-start-dualread", "audit.jsonl"), [
    row("2026-07-01T00:00:00.000Z"),
    row("2026-07-02T00:00:00.000Z", {
      status: "delta",
      summary: { legacyRules: 3, shadowConstraints: 3, compiledOnly: 1, legacyOnly: 1, bothMatch: 0, textDelta: 1 },
      delta: {
        compiledOnly: ["event:compiled-only"],
        legacyOnly: ["rule:global:always:settings-rule"],
        bothMatch: [],
        textDelta: [{ sourceRecordId: "rule:global:always:text-delta", legacyHash: "legacy-hash", shadowHash: "shadow-hash" }],
      },
      legacyOnlyDispositions: { settings_not_memory: 1 },
      legacyOnlyDetails: [{
        sourceRecordId: "rule:global:always:settings-rule",
        disposition: "settings_not_memory",
        machineDisposition: "settings_not_memory",
        humanReviewRequired: false,
        scopeCaveat: "authorization required before deletion",
        reason: "settings_not_memory",
        category: "exclude_not_memory_settings",
        diagnosticCode: "SC_NOT_MEMORY_SETTINGS",
        targetId: "shadow:excluded-settings",
      }],
      compiledOnlyDetails: [{
        sourceRecordId: "event:compiled-only",
        sourceKind: "constraint_event",
        scope: "global",
        category: "event_native",
        compiledOnlyBackfillAllowed: false,
        constraintId: "shadow:compiled-only",
        injectMode: "always",
      }],
      textDeltaDispositions: { semantic_review_required: 1 },
      textDeltaDetails: [{
        sourceRecordId: "rule:global:always:text-delta",
        legacyHash: "legacy-hash",
        shadowHash: "shadow-hash",
        disposition: "semantic_review_required",
        humanReviewRequired: true,
        targetId: "shadow:text-delta",
        legacyLine: 10,
        compiledLine: 22,
        legacyExcerpt: "legacy body",
        compiledExcerpt: "compiled body",
      }],
    }),
  ]);
  writeJsonl(path.join(fixture.shadowRoot, "auto-refresh", "audit.jsonl"), []);

  const { result, json } = runDossier(fixture, ["--latest"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.selection.rowsAnalyzed === 1, `expected one latest row, got ${json.selection.rowsAnalyzed}`);
  assert(json.retirementGate.ready === false, "expected ready=false");
  assert(json.deltas.legacyOnly.byDisposition.settings_not_memory.total === 1, "missing legacy settings disposition");
  assert(json.deltas.textDelta.byDisposition.semantic_review_required.total === 1, "missing text delta disposition");
  assert(json.deltas.textDelta.byDisposition.semantic_review_required.samples[0].compiledExcerpt === "compiled body", "missing text delta excerpt");
});

check("post-refresh cutoff selects only rows after latest successful auto-refresh", () => {
  const fixture = makeFixture();
  writeJsonl(path.join(fixture.shadowRoot, "auto-refresh", "audit.jsonl"), [
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-03T00:00:00.000Z", status: "completed", ok: true, result: { ok: true, inputRootHash: "old-input" } },
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-05T00:00:00.000Z", status: "completed", ok: true, result: { ok: true, inputRootHash: "new-input" } },
  ]);
  writeJsonl(path.join(fixture.shadowRoot, "session-start-dualread", "audit.jsonl"), [
    row("2026-07-04T23:00:00.000Z", { activeProjectId: "before-refresh" }),
    row("2026-07-05T00:00:00.000Z", { activeProjectId: "at-refresh" }),
    row("2026-07-05T00:01:00.000Z", { activeProjectId: "after-refresh" }),
  ]);

  const { json } = runDossier(fixture, ["--post-refresh"]);
  assert(json.selection.rowsAnalyzed === 1, `expected one row after cutoff, got ${json.selection.rowsAnalyzed}`);
  assert(json.selection.postRefreshCutoffUtc === "2026-07-05T00:00:00.000Z", `wrong cutoff: ${json.selection.postRefreshCutoffUtc}`);
  assert(json.selection.status.match === 1, `wrong status distribution: ${JSON.stringify(json.selection.status)}`);
  assert(json.selection.latest.activeProjectId === "after-refresh", `wrong latest row: ${JSON.stringify(json.selection.latest)}`);
});

check("empty delta is ready=true", () => {
  const fixture = makeFixture();
  writeJsonl(path.join(fixture.shadowRoot, "auto-refresh", "audit.jsonl"), [
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-01T00:00:00.000Z", status: "completed", ok: true, result: { ok: true } },
  ]);
  writeJsonl(path.join(fixture.shadowRoot, "session-start-dualread", "audit.jsonl"), [
    row("2026-07-06T00:00:00.000Z"),
  ]);

  const { result, json } = runDossier(fixture, ["--latest"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}`);
  assert(json.selection.rowsAnalyzed === 1, "expected one analyzed row");
  assert(json.deltas.compiledOnly.total === 0 && json.deltas.legacyOnly.total === 0 && json.deltas.textDelta.total === 0, "expected empty delta totals");
  assert(json.retirementGate.ready === true, `expected ready=true: ${JSON.stringify(json.retirementGate)}`);
});

check("event_native_accepted is archivable but stale and ordinary compiled-only still block", () => {
  const fixture = makeFixture();
  writeJsonl(path.join(fixture.shadowRoot, "auto-refresh", "audit.jsonl"), []);
  writeJsonl(path.join(fixture.shadowRoot, "session-start-dualread", "audit.jsonl"), [
    row("2026-07-06T00:00:00.000Z", {
      status: "delta",
      summary: { legacyRules: 0, shadowConstraints: 4, compiledOnly: 4, legacyOnly: 0, bothMatch: 0, textDelta: 0 },
      delta: {
        compiledOnly: ["event:accepted", "event:stale", "rule:global:always:ordinary", "event:human"],
        legacyOnly: [],
        bothMatch: [],
        textDelta: [],
      },
      compiledOnlyDetails: [{
        sourceRecordId: "event:accepted",
        sourceKind: "constraint_event",
        scope: "global",
        category: "event_native",
        compiledOnlyBackfillAllowed: false,
        constraintId: "constraint:accepted",
        bodyHash: "accepted-body-hash",
        inputRootHash: "input-fixture",
        validationHash: "validation-fixture",
        injectMode: "always",
        machineDisposition: "event_native_accepted",
        reviewSource: "compiled-only-dispositions",
        reviewRef: "review:accepted",
        reason: "accepted event-native source",
      }, {
        sourceRecordId: "event:stale",
        sourceKind: "constraint_event",
        scope: "global",
        category: "event_native",
        compiledOnlyBackfillAllowed: false,
        constraintId: "constraint:stale",
        bodyHash: "stale-body-hash",
        inputRootHash: "old-input",
        validationHash: "validation-fixture",
        injectMode: "always",
      }, {
        sourceRecordId: "rule:global:always:ordinary",
        sourceKind: "legacy_rule",
        scope: "global",
        category: "compiled_only",
        compiledOnlyBackfillAllowed: false,
        constraintId: "constraint:ordinary",
        bodyHash: "ordinary-body-hash",
        inputRootHash: "input-fixture",
        validationHash: "validation-fixture",
        injectMode: "always",
      }, {
        sourceRecordId: "event:human",
        sourceKind: "constraint_event",
        scope: "global",
        category: "event_native",
        compiledOnlyBackfillAllowed: false,
        constraintId: "constraint:human",
        bodyHash: "human-body-hash",
        inputRootHash: "input-fixture",
        validationHash: "validation-fixture",
        injectMode: "always",
        humanReviewRequired: true,
        machineDisposition: "event_native_accepted",
        reviewSource: "compiled-only-dispositions",
      }],
    }),
  ]);

  const { result, json } = runDossier(fixture, ["--latest"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}`);
  assert(json.retirementGate.ready === false, "expected remaining blockers");
  const accepted = json.deltas.compiledOnly.byDisposition.event_native_accepted;
  assert(accepted.total === 2, `expected accepted group total 2 including human-review sample: ${JSON.stringify(accepted)}`);
  assert(accepted.blockingUnique === 1 && accepted.humanReviewUnique === 1, `humanReviewRequired should still block accepted disposition: ${JSON.stringify(accepted)}`);
  const eventNative = json.deltas.compiledOnly.byDisposition.event_native;
  assert(eventNative.blockingUnique === 1, `stale/unaccepted event_native should block: ${JSON.stringify(eventNative)}`);
  const ordinary = json.deltas.compiledOnly.byDisposition.compiled_only;
  assert(ordinary.blockingUnique === 1, `ordinary compiled_only should block: ${JSON.stringify(ordinary)}`);
  assert(json.retirementGate.blockingCounts["compiledOnly:event_native_accepted"] === 1, `accepted human review blocker missing: ${JSON.stringify(json.retirementGate.blockingCounts)}`);
  assert(json.retirementGate.blockingCounts["compiledOnly:event_native"] === 1, `event_native blocker missing: ${JSON.stringify(json.retirementGate.blockingCounts)}`);
  assert(json.retirementGate.blockingCounts["compiledOnly:compiled_only"] === 1, `compiled_only blocker missing: ${JSON.stringify(json.retirementGate.blockingCounts)}`);
});

if (failures.length) {
  console.log(`FAIL - ${failures.length}/${total} constraint legacy retirement smoke checks failed.`);
  process.exit(1);
}
console.log(`PASS - ${total} constraint legacy retirement smoke checks passed.`);
process.exit(0);
