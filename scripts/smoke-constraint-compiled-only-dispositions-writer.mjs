#!/usr/bin/env node
/**
 * Smoke: ADR0039 compiled-only event-native disposition sidecar writer.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const writerScript = path.join(repoRoot, "scripts", "write-constraint-compiled-only-dispositions.mjs");
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

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function bodyHash(value) {
  return crypto.createHash("sha256").update(normalizeText(value)).digest("hex");
}

function sidecarPath(abrainHome) {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "compiled-only-dispositions.json");
}

function eventConstraint(source, id, body, overrides = {}) {
  return {
    constraintId: id,
    scope: { kind: "global" },
    injectMode: "always",
    title: id,
    compiledBody: body,
    sourceRecordIds: [source],
    ...overrides,
  };
}

function detailFor(constraint, source, overrides = {}) {
  return {
    sourceRecordId: source,
    sourceKind: source.startsWith("event:") ? "constraint_event" : "legacy_rule",
    scope: constraint.scope?.kind === "project" ? `project:${constraint.scope.projectId}` : "global",
    category: source.startsWith("event:") ? "event_native" : "compiled_only",
    compiledOnlyBackfillAllowed: false,
    constraintId: constraint.constraintId,
    bodyHash: bodyHash(constraint.compiledBody),
    inputRootHash: "input-fixture",
    validationHash: "validation-fixture",
    injectMode: constraint.injectMode,
    ...overrides,
  };
}

function makeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-compiled-only-dispositions-writer-"));
  const abrainHome = path.join(root, "abrain");
  const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
  const latestDir = path.join(shadowRoot, "latest");
  const accepted = eventConstraint("event:accepted", "constraint:accepted", "Accepted event-native body.");
  const nonEvent = eventConstraint("rule:global:always:not-event", "constraint:not-event", "Non event body.");
  const nonNative = eventConstraint("event:not-native", "constraint:not-native", "Not native body.");
  const ordinary = eventConstraint("rule:global:always:ordinary", "constraint:ordinary", "Ordinary compiled-only body.");
  const human = eventConstraint("event:human-review", "constraint:human-review", "Human review body.");
  const bodyMismatch = eventConstraint("event:body-mismatch", "constraint:body-mismatch", "Current body.");
  const constraintMismatch = eventConstraint("event:constraint-mismatch", "constraint:current", "Constraint mismatch body.");
  const scopeMismatch = eventConstraint("event:scope-mismatch", "constraint:scope-mismatch", "Scope mismatch body.", { scope: { kind: "project", projectId: "current" } });
  const injectMismatch = eventConstraint("event:inject-mismatch", "constraint:inject-mismatch", "Inject mismatch body.", { injectMode: "listed" });
  const inputMismatch = eventConstraint("event:input-mismatch", "constraint:input-mismatch", "Input mismatch body.");
  const validationMismatch = eventConstraint("event:validation-mismatch", "constraint:validation-mismatch", "Validation mismatch body.");
  const constraints = [accepted, nonEvent, nonNative, ordinary, human, bodyMismatch, constraintMismatch, scopeMismatch, injectMismatch, inputMismatch, validationMismatch];
  writeJson(path.join(latestDir, "decision.json"), {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: overrides.decisionInputRootHash ?? "input-fixture",
    validationHash: overrides.decisionValidationHash ?? "validation-fixture",
    constraints,
    exclusions: [],
    unresolved: [],
    mappings: [],
    diagnostics: [],
  });
  writeJsonl(path.join(shadowRoot, "auto-refresh", "audit.jsonl"), [
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-06T00:00:00.000Z", status: "completed", ok: true, result: { ok: true, inputRootHash: "input-fixture" } },
  ]);
  writeJsonl(path.join(shadowRoot, "session-start-dualread", "audit.jsonl"), [
    {
      schemaVersion: "rule-injector-dualread-audit/v1",
      observedAtUtc: "2026-07-06T00:01:00.000Z",
      status: "delta",
      inputRootHash: overrides.auditInputRootHash ?? "input-fixture",
      validationHash: overrides.auditValidationHash ?? "validation-fixture",
      summary: { compiledOnly: 11, legacyOnly: 0, textDelta: 0 },
      delta: { compiledOnly: constraints.map((item) => item.sourceRecordIds[0]), legacyOnly: [], textDelta: [] },
      compiledOnlyDetails: [
        detailFor(accepted, "event:accepted"),
        detailFor(nonEvent, "rule:global:always:not-event"),
        detailFor(nonNative, "event:not-native", { category: "compiled_only" }),
        detailFor(ordinary, "rule:global:always:ordinary", { sourceKind: "legacy_rule", category: "compiled_only" }),
        detailFor(human, "event:human-review", { humanReviewRequired: true }),
        detailFor(bodyMismatch, "event:body-mismatch", { bodyHash: "stale-body-hash" }),
        detailFor(constraintMismatch, "event:constraint-mismatch", { constraintId: "constraint:stale" }),
        detailFor(scopeMismatch, "event:scope-mismatch", { scope: "project:stale" }),
        detailFor(injectMismatch, "event:inject-mismatch", { injectMode: "always" }),
        detailFor(inputMismatch, "event:input-mismatch", { inputRootHash: "stale-input" }),
        detailFor(validationMismatch, "event:validation-mismatch", { validationHash: "stale-validation" }),
      ],
    },
  ]);
  return { root, abrainHome, sidecar: sidecarPath(abrainHome), accepted };
}

function runWriter(fixture, args = []) {
  const result = spawnSync(process.execPath, [
    writerScript,
    "--abrain", fixture.abrainHome,
    "--latest",
    "--json",
    ...args,
  ], { cwd: repoRoot, encoding: "utf8" });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error(`writer did not emit JSON. exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { result, json };
}

function readSidecar(fixture) {
  return JSON.parse(fs.readFileSync(fixture.sidecar, "utf8"));
}

function assertGuardFailure(name, args, expected) {
  check(name, () => {
    const fixture = makeFixture();
    const { result, json } = runWriter(fixture, args);
    assert(result.status === 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    assert(json.ok === false, `expected ok=false: ${JSON.stringify(json)}`);
    assert(json.error.includes(expected), `expected ${expected} in ${JSON.stringify(json)}`);
    assert(!fs.existsSync(fixture.sidecar), "guard failure wrote sidecar");
  });
}

console.log("ADR0039 compiled-only dispositions writer smoke");

check("dry-run does not write and reports strict-gate skips", () => {
  const fixture = makeFixture();
  const { result, json } = runWriter(fixture, ["--dry-run"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.dryRun === true, `dryRun mismatch: ${JSON.stringify(json)}`);
  assert(json.stats.created === 1 && json.stats.candidates === 1, `candidate stats mismatch: ${JSON.stringify(json.stats)}`);
  assert(json.stats.skipped === 10, `expected strict-gate skips: ${JSON.stringify(json.stats)}`);
  assert(json.warnings.some((line) => line.includes("source is not event:*")), `missing non-event skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("category is not event_native")), `missing category skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("humanReviewRequired=true")), `missing human review skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("bodyHash mismatch")), `missing bodyHash skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("constraintId mismatch")), `missing constraint skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("scope mismatch")), `missing scope skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("injectMode mismatch")), `missing inject skip: ${JSON.stringify(json.warnings)}`);
  assert(json.warnings.some((line) => line.includes("detail hash root mismatch")), `missing root hash skip: ${JSON.stringify(json.warnings)}`);
  assert(!fs.existsSync(fixture.sidecar), "dry-run wrote sidecar");
});

assertGuardFailure("write fails closed without source", ["--review-ref", "review:x", "--reason", "accepted"], "--source");
assertGuardFailure("write fails closed without review-ref", ["--source", "event:accepted", "--reason", "accepted"], "--review-ref");
assertGuardFailure("write fails closed without reason", ["--source", "event:accepted", "--review-ref", "review:x"], "--reason");

check("real write creates source-scoped event_native accepted item", () => {
  const fixture = makeFixture();
  const { result, json } = runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:accepted", "--reason", "T0 accepted event-native source"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 1 && json.stats.filtered === 10 && json.stats.candidates === 1, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const sidecar = readSidecar(fixture);
  assert(sidecar.schemaVersion === "constraint-compiled-only-dispositions/v1", `schema mismatch: ${JSON.stringify(sidecar)}`);
  assert(sidecar.items.length === 1, `expected one item: ${JSON.stringify(sidecar.items)}`);
  const item = sidecar.items[0];
  assert(item.sourceRecordId === "event:accepted", `source mismatch: ${JSON.stringify(item)}`);
  assert(item.sourceKind === "constraint_event" && item.category === "event_native", `gate metadata mismatch: ${JSON.stringify(item)}`);
  assert(item.constraintId === "constraint:accepted", `constraintId mismatch: ${JSON.stringify(item)}`);
  assert(item.bodyHash === bodyHash(fixture.accepted.compiledBody), `bodyHash mismatch: ${JSON.stringify(item)}`);
  assert(item.inputRootHash === "input-fixture" && item.validationHash === "validation-fixture", `root hashes mismatch: ${JSON.stringify(item)}`);
  assert(item.scope === "global" && item.injectMode === "always", `scope/inject mismatch: ${JSON.stringify(item)}`);
  assert(item.disposition === "event_native_accepted", `disposition mismatch: ${JSON.stringify(item)}`);
  assert(item.reviewRef === "review:accepted" && item.reason === "T0 accepted event-native source", `metadata mismatch: ${JSON.stringify(item)}`);
});

check("repeat write is idempotent for identical metadata", () => {
  const fixture = makeFixture();
  runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:accepted", "--reason", "accepted"]);
  const before = fs.readFileSync(fixture.sidecar, "utf8");
  const { result, json } = runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:accepted", "--reason", "accepted"]);
  const after = fs.readFileSync(fixture.sidecar, "utf8");
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 0 && json.stats.updated === 0 && json.stats.unchanged === 1, `stats mismatch: ${JSON.stringify(json.stats)}`);
  assert(after === before, "idempotent write changed sidecar content");
});

check("same key updates review metadata", () => {
  const fixture = makeFixture();
  runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:old", "--reason", "old"]);
  const { result, json } = runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:new", "--reason", "new"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 0 && json.stats.updated === 1 && json.stats.unchanged === 0, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const item = readSidecar(fixture).items[0];
  assert(item.reviewRef === "review:new" && item.reason === "new", `metadata not updated: ${JSON.stringify(item)}`);
});

check("merge preserves historical non-matching keys", () => {
  const fixture = makeFixture();
  writeJson(fixture.sidecar, {
    schemaVersion: "constraint-compiled-only-dispositions/v1",
    items: [{
      sourceRecordId: "event:historical",
      sourceKind: "constraint_event",
      category: "event_native",
      constraintId: "constraint:historical",
      bodyHash: "historical-body-hash",
      inputRootHash: "historical-input",
      validationHash: "historical-validation",
      scope: "global",
      injectMode: "always",
      disposition: "event_native_accepted",
      reviewedAtUtc: "2026-07-01T00:00:00.000Z",
      reviewRef: "review:historical",
      reason: "historical key",
    }],
  });
  const { result, json } = runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:accepted", "--reason", "accepted"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 1 && json.stats.total === 2, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const items = readSidecar(fixture).items;
  assert(items.some((item) => item.sourceRecordId === "event:historical"), `historical key missing: ${JSON.stringify(items)}`);
  assert(items.some((item) => item.sourceRecordId === "event:accepted"), `accepted key missing: ${JSON.stringify(items)}`);
});

check("stale selected audit row hash mismatch writes no candidate", () => {
  const fixture = makeFixture({ auditInputRootHash: "stale-input" });
  const { result, json } = runWriter(fixture, ["--source", "event:accepted", "--review-ref", "review:accepted", "--reason", "accepted"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.candidates === 0 && json.stats.created === 0 && json.stats.skipped === 1, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const sidecar = readSidecar(fixture);
  assert(Array.isArray(sidecar.items) && sidecar.items.length === 0, `expected empty sidecar: ${JSON.stringify(sidecar)}`);
});

if (failures.length) {
  console.log(`FAIL - ${failures.length}/${total} compiled-only dispositions writer smoke checks failed.`);
  process.exit(1);
}
console.log(`PASS - ${total} compiled-only dispositions writer smoke checks passed.`);
process.exit(0);
