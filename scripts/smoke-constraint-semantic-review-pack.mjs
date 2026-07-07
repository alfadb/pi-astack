#!/usr/bin/env node
/**
 * Smoke: ADR0039 constraint semantic review pack dossier.
 *
 * Uses temporary abrain fixtures only. Verifies semantic text pairs,
 * optional normalization rows, legacy-only unknown rows, and selection logic.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dossierScript = path.join(repoRoot, "scripts", "dossier-constraint-semantic-review-pack.mjs");
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

function ruleMarkdown({ id, title, status = "active", kind = "preference", confidence = 8, injectMode = "always", body }) {
  return [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `status: ${status}`,
    `kind: ${kind}`,
    `confidence: ${confidence}`,
    `inject_mode: ${injectMode}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-semantic-review-pack-"));
  const abrainHome = path.join(root, "abrain");
  const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
  const latestDir = path.join(shadowRoot, "latest");

  writeFile(path.join(abrainHome, "rules", "always", "use-edit-.md"), ruleMarkdown({
    id: "rule:global:always:use-edit-",
    title: "Use edit/write",
    body: "# Use edit/write\n\nWhen changing files, use edit or write. Do not use shell redirection for writes.",
  }));
  writeFile(path.join(abrainHome, "rules", "always", "normalizable.md"), ruleMarkdown({
    id: "rule:global:always:normalizable",
    title: "Normalizable wording",
    body: "Keep compact wording when the rule meaning is identical.",
  }));
  writeFile(path.join(abrainHome, "rules", "listed", "unknown-rule.md"), ruleMarkdown({
    id: "rule:global:listed:unknown-rule",
    title: "Unknown residual",
    injectMode: "listed",
    body: "This residual needs classification before legacy retirement.",
  }));
  writeFile(path.join(abrainHome, "rules", "always", "before-refresh.md"), ruleMarkdown({
    id: "rule:global:always:before-refresh",
    title: "Before refresh",
    body: "This rule should be ignored by --post-refresh.",
  }));

  writeJson(path.join(latestDir, "decision.json"), {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: "decision-input-fixture",
    validationHash: "decision-validation-fixture",
    constraints: [
      {
        id: "constraint-use-edit",
        title: "Use edit/write",
        mustDoSummary: "Use edit/write for file edits.",
        appliesWhen: "When changing files in the workspace.",
        compiledBody: "When changing files, use edit or write and avoid shell redirection for writes.",
        scope: { kind: "global" },
        injectMode: "always",
        sourceRecordIds: ["rule:global:always:use-edit"],
      },
      {
        id: "constraint-normalizable",
        title: "Normalizable wording",
        mustDoSummary: "Keep equivalent compact wording.",
        appliesWhen: "When wording is equivalent.",
        compiledBody: "Use compact wording when the behavioral requirement is unchanged.",
        scope: { kind: "global" },
        injectMode: "always",
        sourceRecordIds: ["rule:global:always:normalizable"],
      },
    ],
    exclusions: [{ reason: "settings_not_memory", sourceRecordIds: ["rule:global:listed:unknown-rule"], note: "fixture exclusion context" }],
    unresolved: [{ reason: "model_uncertain", sourceRecordIds: ["rule:global:listed:unknown-rule"], note: "needs classification" }],
    mappings: [{ sourceRecordId: "rule:global:listed:unknown-rule", disposition: "unresolved" }],
    diagnostics: [{ id: "diag-unknown", code: "SC_UNCLASSIFIED", category: "keep_unresolved", message: "classification required", sourceRecordIds: ["rule:global:listed:unknown-rule"] }],
  });

  writeJsonl(path.join(shadowRoot, "auto-refresh", "audit.jsonl"), [
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-03T00:00:00.000Z", status: "completed", ok: true, result: { ok: true, inputRootHash: "old-input" } },
    { schemaVersion: "constraint-shadow-auto-refresh/v1", observedAtUtc: "2026-07-05T00:00:00.000Z", status: "completed", ok: true, result: { ok: true, inputRootHash: "new-input" } },
  ]);

  writeJsonl(path.join(shadowRoot, "session-start-dualread", "audit.jsonl"), [
    {
      schemaVersion: "rule-injector-dualread-audit/v1",
      observedAtUtc: "2026-07-04T23:00:00.000Z",
      cwd: "/fixture/project",
      activeProjectId: "before-refresh",
      status: "delta",
      inputRootHash: "before-input",
      validationHash: "before-validation",
      textDeltaDetails: [{
        sourceRecordId: "rule:global:always:before-refresh",
        targetId: "constraint-before-refresh",
        legacyHash: "before-legacy",
        shadowHash: "before-shadow",
        disposition: "semantic_review_required",
        humanReviewRequired: true,
      }],
      legacyOnlyDetails: [],
    },
    {
      schemaVersion: "rule-injector-dualread-audit/v1",
      observedAtUtc: "2026-07-05T00:02:00.000Z",
      cwd: "/fixture/project",
      activeProjectId: "after-refresh",
      status: "delta",
      inputRootHash: "audit-input-fixture",
      validationHash: "audit-validation-fixture",
      textDeltaDetails: [
        {
          sourceRecordId: "rule:global:always:use-edit",
          targetId: "constraint-use-edit",
          legacyHash: "legacy-use-edit",
          shadowHash: "shadow-use-edit",
          disposition: "semantic_review_required",
          category: "semantic_delta",
          humanReviewRequired: true,
          diagnosticIds: ["diag-semantic"],
        },
        {
          sourceRecordId: "rule:global:always:normalizable",
          targetId: "constraint-normalizable",
          legacyHash: "legacy-normalizable",
          shadowHash: "shadow-normalizable",
          disposition: "normalization_possible",
          category: "normalization",
          humanReviewRequired: true,
        },
      ],
      legacyOnlyDetails: [{
        sourceRecordId: "rule:global:listed:unknown-rule",
        disposition: "unknown",
        machineDisposition: "unknown",
        category: "needs_attention",
        humanReviewRequired: true,
        diagnosticIds: ["diag-unknown"],
      }],
    },
  ]);

  return { root, abrainHome };
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
  } catch {
    throw new Error(`dossier did not emit JSON. exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { result, json };
}

console.log("ADR0039 constraint semantic review pack smoke");

check("textDelta semantic pair matches legacy file and compiled body", () => {
  const fixture = makeFixture();
  const { result, json } = runDossier(fixture, ["--post-refresh", "--latest"]);
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert(json.selection.rowsAnalyzed === 1, `expected latest one row, got ${json.selection.rowsAnalyzed}`);
  assert(json.selection.latest.activeProjectId === "after-refresh", `wrong latest row: ${JSON.stringify(json.selection.latest)}`);
  const item = json.reviewItems.find((candidate) => candidate.sourceRecordId === "rule:global:always:use-edit");
  assert(item, `missing use-edit review item: ${JSON.stringify(json.reviewItems, null, 2)}`);
  assert(item.kind === "text_delta_pair", `wrong item kind: ${item.kind}`);
  assert(item.legacy.file.endsWith("use-edit-.md"), `legacy file mismatch: ${item.legacy.file}`);
  assert(item.legacy.matchMethod === "path_slug_trailing_hyphen_tolerant", `expected tolerant match, got ${item.legacy.matchMethod}`);
  assert(/When changing files, use edit or write/.test(item.legacy.body), "legacy body missing full text");
  assert(item.compiled.id === "constraint-use-edit", `compiled id mismatch: ${JSON.stringify(item.compiled)}`);
  assert(/avoid shell redirection/.test(item.compiled.compiledBody), "compiled body missing full text");
  assert(json.binding.inputRootHash === "audit-input-fixture", `binding input hash mismatch: ${JSON.stringify(json.binding)}`);
  assert(json.binding.validationHash === "audit-validation-fixture", `binding validation hash mismatch: ${JSON.stringify(json.binding)}`);
});

check("include-normalization flag controls normalization_possible items", () => {
  const fixture = makeFixture();
  const without = runDossier(fixture, ["--post-refresh", "--latest"]).json;
  assert(!without.reviewItems.some((item) => item.disposition === "normalization_possible"), "normalization item included by default");
  const withNormalization = runDossier(fixture, ["--post-refresh", "--latest", "--include-normalization"]).json;
  const item = withNormalization.reviewItems.find((candidate) => candidate.disposition === "normalization_possible");
  assert(item, `normalization item missing: ${JSON.stringify(withNormalization.reviewItems, null, 2)}`);
  assert(item.compiled.id === "constraint-normalizable", "normalization compiled constraint mismatch");
});

check("legacyOnly unknown emits review item without compiled constraint", () => {
  const fixture = makeFixture();
  const { json } = runDossier(fixture, ["--post-refresh", "--latest"]);
  const item = json.reviewItems.find((candidate) => candidate.kind === "legacy_only_unknown");
  assert(item, `missing legacy_only_unknown item: ${JSON.stringify(json.reviewItems, null, 2)}`);
  assert(item.compiled === null, `legacy_only_unknown compiled must be null: ${JSON.stringify(item.compiled)}`);
  assert(/needs classification/.test(item.legacy.body), "unknown legacy body missing");
  assert(item.decisionContext.unresolved.length === 1, `unresolved context missing: ${JSON.stringify(item.decisionContext)}`);
  assert(item.decisionContext.exclusions.length === 1, `exclusion context missing: ${JSON.stringify(item.decisionContext)}`);
  assert(item.decisionContext.mappings.length === 1, `mapping context missing: ${JSON.stringify(item.decisionContext)}`);
  assert(item.decisionContext.diagnostics.length === 1, `diagnostics context missing: ${JSON.stringify(item.decisionContext)}`);
});

check("post-refresh/latest selection excludes rows at or before refresh", () => {
  const fixture = makeFixture();
  const { json } = runDossier(fixture, ["--post-refresh", "--latest", "--include-normalization"]);
  assert(json.selection.postRefreshCutoffUtc === "2026-07-05T00:00:00.000Z", `wrong cutoff: ${json.selection.postRefreshCutoffUtc}`);
  assert(json.selection.rowsAnalyzed === 1, `expected one latest row, got ${json.selection.rowsAnalyzed}`);
  assert(!json.reviewItems.some((item) => item.sourceRecordId === "rule:global:always:before-refresh"), "before-refresh row leaked into review items");
  assert(json.reviewItems.length === 3, `expected semantic + normalization + unknown items, got ${json.reviewItems.length}`);
});

if (failures.length) {
  console.log(`FAIL - ${failures.length}/${total} constraint semantic review pack smoke checks failed.`);
  process.exit(1);
}
console.log(`PASS - ${total} constraint semantic review pack smoke checks passed.`);
process.exit(0);
