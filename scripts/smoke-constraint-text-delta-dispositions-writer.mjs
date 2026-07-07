#!/usr/bin/env node
/**
 * Smoke: ADR0039 constraint text-delta disposition sidecar writer.
 *
 * Uses temporary abrain fixtures only. Verifies dry-run, merge/idempotency,
 * same-key metadata updates, historical key preservation, optional
 * normalization_possible handling, and source include/exclude filtering.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const writerScript = path.join(repoRoot, "scripts", "write-constraint-text-delta-dispositions.mjs");
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

function sidecarPath(abrainHome) {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "text-delta-dispositions.json");
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-text-delta-dispositions-writer-"));
  const abrainHome = path.join(root, "abrain");
  const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
  const latestDir = path.join(shadowRoot, "latest");

  writeJson(path.join(latestDir, "decision.json"), {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: "decision-input-fixture",
    validationHash: "decision-validation-fixture",
    constraints: [
      {
        id: "constraint-semantic",
        title: "Semantic fixture",
        compiledBody: "Compiled semantic fixture body.",
        sourceRecordIds: ["rule:global:always:semantic-fixture"],
      },
      {
        id: "constraint-semantic-alt",
        title: "Alternate semantic fixture",
        compiledBody: "Compiled alternate semantic fixture body.",
        sourceRecordIds: ["rule:global:always:semantic-fixture-alt"],
      },
      {
        id: "constraint-normalization",
        title: "Normalization fixture",
        compiledBody: "Compiled normalization fixture body.",
        sourceRecordIds: ["rule:global:always:normalization-fixture"],
      },
    ],
    exclusions: [],
    unresolved: [],
    mappings: [],
    diagnostics: [],
  });

  writeJsonl(path.join(shadowRoot, "auto-refresh", "audit.jsonl"), [
    {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: "2026-07-06T00:00:00.000Z",
      status: "completed",
      ok: true,
      result: { ok: true, inputRootHash: "refresh-input-fixture" },
    },
  ]);

  writeJsonl(path.join(shadowRoot, "session-start-dualread", "audit.jsonl"), [
    {
      schemaVersion: "rule-injector-dualread-audit/v1",
      observedAtUtc: "2026-07-06T00:01:00.000Z",
      cwd: "/fixture/project",
      activeProjectId: "fixture-project",
      status: "delta",
      inputRootHash: "audit-input-fixture",
      validationHash: "audit-validation-fixture",
      textDeltaDetails: [
        {
          sourceRecordId: "rule:global:always:semantic-fixture",
          targetId: "constraint-semantic",
          legacyHash: "legacy-semantic-hash",
          shadowHash: "shadow-semantic-hash",
          disposition: "semantic_review_required",
          category: "semantic_delta",
          humanReviewRequired: true,
        },
        {
          sourceRecordId: "rule:global:always:semantic-fixture-alt",
          targetId: "constraint-semantic-alt",
          legacyHash: "legacy-semantic-alt-hash",
          shadowHash: "shadow-semantic-alt-hash",
          disposition: "semantic_review_required",
          category: "semantic_delta",
          humanReviewRequired: true,
        },
        {
          sourceRecordId: "rule:global:always:normalization-fixture",
          targetId: "constraint-normalization",
          legacyHash: "legacy-normalization-hash",
          shadowHash: "shadow-normalization-hash",
          disposition: "normalization_possible",
          category: "normalization",
          humanReviewRequired: true,
        },
      ],
      legacyOnlyDetails: [],
    },
  ]);

  return { root, abrainHome, sidecar: sidecarPath(abrainHome) };
}

function runWriter(fixture, args = []) {
  const result = spawnSync(process.execPath, [
    writerScript,
    "--abrain", fixture.abrainHome,
    "--post-refresh",
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

console.log("ADR0039 constraint text-delta dispositions writer smoke");

check("dry-run does not write sidecar", () => {
  const fixture = makeFixture();
  const { result, json } = runWriter(fixture, ["--dry-run"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.dryRun === true, `dryRun mismatch: ${JSON.stringify(json)}`);
  assert(json.path === fixture.sidecar, `target path mismatch: ${json.path}`);
  assert(json.stats.created === 2, `expected two planned creates: ${JSON.stringify(json.stats)}`);
  assert(json.stats.total === 2, `expected planned total 2: ${JSON.stringify(json.stats)}`);
  assert(json.stats.considered === 2 && json.stats.filtered === 0 && json.stats.candidates === 2, `filter stats mismatch: ${JSON.stringify(json.stats)}`);
  assert(!fs.existsSync(fixture.sidecar), "dry-run wrote sidecar");
});

check("first write creates semantic_equivalent sidecar item", () => {
  const fixture = makeFixture();
  const { result, json } = runWriter(fixture);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 2 && json.stats.updated === 0 && json.stats.unchanged === 0, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const sidecar = readSidecar(fixture);
  assert(sidecar.schemaVersion === "constraint-text-delta-dispositions/v1", `schema mismatch: ${JSON.stringify(sidecar)}`);
  assert(sidecar.items.length === 2, `expected two items: ${JSON.stringify(sidecar.items)}`);
  const item = sidecar.items.find((entry) => entry.sourceRecordId === "rule:global:always:semantic-fixture");
  assert(item, `primary semantic item missing: ${JSON.stringify(sidecar.items)}`);
  assert(item.sourceRecordId === "rule:global:always:semantic-fixture", `source mismatch: ${JSON.stringify(item)}`);
  assert(item.legacyHash === "legacy-semantic-hash" && item.shadowHash === "shadow-semantic-hash", `hash mismatch: ${JSON.stringify(item)}`);
  assert(item.disposition === "semantic_equivalent", `disposition mismatch: ${JSON.stringify(item)}`);
  assert(/^semantic-review-pack:2026-07-06T00:01:00\.000Z$/.test(item.reviewRef), `reviewRef mismatch: ${JSON.stringify(item)}`);
  assert(item.reason === "multi-model semantic review accepted equivalent", `reason mismatch: ${JSON.stringify(item)}`);
  assert(typeof item.reviewedAtUtc === "string" && !Number.isNaN(Date.parse(item.reviewedAtUtc)), `reviewedAtUtc invalid: ${JSON.stringify(item)}`);
});

check("repeat write is idempotent for identical metadata", () => {
  const fixture = makeFixture();
  runWriter(fixture);
  const before = fs.readFileSync(fixture.sidecar, "utf8");
  const { result, json } = runWriter(fixture);
  const after = fs.readFileSync(fixture.sidecar, "utf8");
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 0 && json.stats.updated === 0 && json.stats.unchanged === 2, `stats mismatch: ${JSON.stringify(json.stats)}`);
  assert(after === before, "idempotent write changed sidecar content");
});

check("same key updates review metadata", () => {
  const fixture = makeFixture();
  runWriter(fixture, ["--review-ref", "review:old", "--reason", "old reason"]);
  const { result, json } = runWriter(fixture, ["--review-ref", "review:new", "--reason", "new reason"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 0 && json.stats.updated === 2 && json.stats.unchanged === 0, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const item = readSidecar(fixture).items.find((entry) => entry.sourceRecordId === "rule:global:always:semantic-fixture");
  assert(item, "primary semantic item missing");
  assert(item.reviewRef === "review:new" && item.reason === "new reason", `metadata not updated: ${JSON.stringify(item)}`);
  assert(item.disposition === "semantic_equivalent", `disposition changed unexpectedly: ${JSON.stringify(item)}`);
});

check("merge preserves historical non-matching keys", () => {
  const fixture = makeFixture();
  writeJson(fixture.sidecar, {
    schemaVersion: "constraint-text-delta-dispositions/v1",
    items: [{
      sourceRecordId: "rule:global:always:old-fixture",
      legacyHash: "legacy-old-hash",
      shadowHash: "shadow-old-hash",
      disposition: "semantic_equivalent",
      reviewedAtUtc: "2026-07-01T00:00:00.000Z",
      reviewRef: "review:old-key",
      reason: "historical fixture",
    }],
  });
  const { result, json } = runWriter(fixture);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 2 && json.stats.total === 3, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const items = readSidecar(fixture).items;
  assert(items.some((item) => item.sourceRecordId === "rule:global:always:old-fixture"), `old key missing: ${JSON.stringify(items)}`);
  assert(items.some((item) => item.sourceRecordId === "rule:global:always:semantic-fixture"), `new key missing: ${JSON.stringify(items)}`);
});

check("include-normalization writes normalization_possible without semantic_equivalent spoofing", () => {
  const fixture = makeFixture();
  runWriter(fixture);
  let items = readSidecar(fixture).items;
  assert(items.length === 2 && !items.some((item) => item.sourceRecordId === "rule:global:always:normalization-fixture"), `normalization included by default: ${JSON.stringify(items)}`);
  const { result, json } = runWriter(fixture, ["--include-normalization"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.stats.created === 1 && json.stats.unchanged === 2, `stats mismatch: ${JSON.stringify(json.stats)}`);
  items = readSidecar(fixture).items;
  const normalization = items.find((item) => item.sourceRecordId === "rule:global:always:normalization-fixture");
  assert(normalization, `normalization item missing: ${JSON.stringify(items)}`);
  assert(normalization.disposition === "normalization_possible", `normalization was spoofed: ${JSON.stringify(normalization)}`);
  assert(normalization.reason === "multi-model semantic review retained normalization_possible", `normalization reason mismatch: ${JSON.stringify(normalization)}`);
});

check("exclude-source writes only the remaining semantic item", () => {
  const fixture = makeFixture();
  const { result, json } = runWriter(fixture, ["--exclude-source", "rule:global:always:semantic-fixture"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.inputs.excludeSources.length === 1 && json.inputs.excludeSources[0] === "rule:global:always:semantic-fixture", `excludeSources missing: ${JSON.stringify(json.inputs)}`);
  assert(json.stats.created === 1 && json.stats.filtered === 1 && json.stats.considered === 1 && json.stats.candidates === 1, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const items = readSidecar(fixture).items;
  assert(items.length === 1, `expected one item: ${JSON.stringify(items)}`);
  assert(items[0].sourceRecordId === "rule:global:always:semantic-fixture-alt", `wrong remaining source: ${JSON.stringify(items)}`);
});

check("source include writes only the specified semantic item", () => {
  const fixture = makeFixture();
  const { result, json } = runWriter(fixture, ["--source", "rule:global:always:semantic-fixture-alt"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.inputs.sources.length === 1 && json.inputs.sources[0] === "rule:global:always:semantic-fixture-alt", `sources missing: ${JSON.stringify(json.inputs)}`);
  assert(json.stats.created === 1 && json.stats.filtered === 1 && json.stats.considered === 1 && json.stats.candidates === 1, `stats mismatch: ${JSON.stringify(json.stats)}`);
  const items = readSidecar(fixture).items;
  assert(items.length === 1, `expected one item: ${JSON.stringify(items)}`);
  assert(items[0].sourceRecordId === "rule:global:always:semantic-fixture-alt", `wrong included source: ${JSON.stringify(items)}`);
});

check("include plus exclude can produce empty candidates", () => {
  const dryFixture = makeFixture();
  const dry = runWriter(dryFixture, [
    "--source", "rule:global:always:semantic-fixture-alt",
    "--exclude-source", "rule:global:always:semantic-fixture-alt",
    "--dry-run",
  ]);
  assert(dry.result.status === 0, `expected dry-run exit 0, got ${dry.result.status}: ${dry.result.stderr}`);
  assert(dry.json.stats.created === 0 && dry.json.stats.total === 0 && dry.json.stats.filtered === 2 && dry.json.stats.considered === 0 && dry.json.stats.candidates === 0, `dry stats mismatch: ${JSON.stringify(dry.json.stats)}`);
  assert(!fs.existsSync(dryFixture.sidecar), "empty dry-run wrote sidecar");

  const writeFixture = makeFixture();
  const written = runWriter(writeFixture, [
    "--source", "rule:global:always:semantic-fixture-alt",
    "--exclude-source", "rule:global:always:semantic-fixture-alt",
  ]);
  assert(written.result.status === 0, `expected write exit 0, got ${written.result.status}: ${written.result.stderr}`);
  assert(written.json.stats.created === 0 && written.json.stats.total === 0 && written.json.stats.filtered === 2 && written.json.stats.considered === 0 && written.json.stats.candidates === 0, `write stats mismatch: ${JSON.stringify(written.json.stats)}`);
  const sidecar = readSidecar(writeFixture);
  assert(sidecar.schemaVersion === "constraint-text-delta-dispositions/v1", `schema mismatch: ${JSON.stringify(sidecar)}`);
  assert(Array.isArray(sidecar.items) && sidecar.items.length === 0, `expected empty sidecar items: ${JSON.stringify(sidecar)}`);
});

if (failures.length) {
  console.log(`FAIL - ${failures.length}/${total} constraint text-delta dispositions writer smoke checks failed.`);
  process.exit(1);
}
console.log(`PASS - ${total} constraint text-delta dispositions writer smoke checks passed.`);
process.exit(0);
