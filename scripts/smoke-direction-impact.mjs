#!/usr/bin/env node
/**
 * Smoke test for ADR 0034 §2.2 direction_impact schema (Phase 1).
 *
 * Exercises the leaf parser/validator (extensions/memory/direction-impact.ts),
 * its read-side integration in lint.ts (lintMarkdown → "D1 direction-impact"),
 * and its write-side integration in sediment/validation.ts
 * (validateProjectEntryDraft). TypeScript sources are transpiled to a temp
 * CommonJS tree; no pi runtime, no real ~/.abrain.
 *
 * Negative tests are bidirectional: each red-line case asserts an issue IS
 * produced, so if the escalation 红线 were removed the assertion fails fast.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  passed++;
}

function transpileDirs(outRoot, dirs) {
  const extRoot = path.join(repoRoot, "extensions");
  for (const dir of dirs) {
    const srcDir = path.join(extRoot, dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-di-"));
transpileDirs(tmp, ["_shared", "memory", "sediment"]);

const di = require(path.join(tmp, "memory", "direction-impact.js"));
const lintMod = require(path.join(tmp, "memory", "lint.js"));
const validation = require(path.join(tmp, "sediment", "validation.js"));

const { parseDirectionImpact, DIRECTION_IMPACT_RELATIONS, DIRECTION_IMPACT_ESCALATIONS, ESCALATION_REQUIRED_RELATIONS } = di;

// ---- enum surface ---------------------------------------------------------
assert(DIRECTION_IMPACT_RELATIONS.length === 6, "6 relations");
assert(DIRECTION_IMPACT_ESCALATIONS.length === 5, "5 escalations");
assert(["narrows", "weakens", "conflicts"].every((r) => ESCALATION_REQUIRED_RELATIONS.has(r)), "red-line relation set");
assert(!ESCALATION_REQUIRED_RELATIONS.has("supports"), "supports not red-line");

// ---- parse: valid cases ---------------------------------------------------
{
  const r = parseDirectionImpact("touches | direction.md#INV-INVISIBILITY | none");
  assert(r.issues.length === 0, "valid inline: no issues");
  assert(r.impacts.length === 1, "valid inline: 1 impact");
  assert(r.impacts[0].relation === "touches" && r.impacts[0].ref === "direction.md#INV-INVISIBILITY" && r.impacts[0].escalation === "none", "valid inline parsed fields");
}
{
  const r = parseDirectionImpact([
    "supports | requirements.md#REQ-003 | none",
    "weakens | direction.md#INV-AUTONOMY | required | docs/notes/foo.md",
  ]);
  assert(r.issues.length === 0, "valid list: no issues");
  assert(r.impacts.length === 2, "valid list: 2 impacts");
  assert(r.impacts[1].proposalRef === "docs/notes/foo.md", "proposal_ref tail preserved");
}
{
  // escalated past 'required' is valid (went through the process)
  const r = parseDirectionImpact("weakens | direction.md#INV-AUTONOMY | accepted");
  assert(r.issues.length === 0 && r.impacts.length === 1, "weakens+accepted is valid (escalated)");
}
{
  const r = parseDirectionImpact(undefined);
  assert(r.issues.length === 0 && r.impacts.length === 0, "absent: empty");
  const r2 = parseDirectionImpact("");
  assert(r2.issues.length === 0 && r2.impacts.length === 0, "empty string: empty");
}

// ---- parse: 红线 (escalation required) — bidirectional negative tests -----
for (const rel of ["narrows", "weakens", "conflicts"]) {
  const r = parseDirectionImpact(`${rel} | direction.md#INV-AUTONOMY | none`);
  assert(r.issues.length >= 1 && r.issues.some((i) => i.severity === "error" && /MUST be escalated/.test(i.message)), `红线: ${rel}+none → error`);
  assert(r.impacts.length === 0, `红线: ${rel}+none dropped from impacts`);
}
{
  // supports/touches/depends_on with none is fine (no escalation needed)
  const r = parseDirectionImpact("depends_on | direction.md#INV-MAIN-SESSION-READ-ONLY | none");
  assert(r.issues.length === 0 && r.impacts.length === 1, "depends_on+none OK (not red-line)");
}

// ---- parse: invalid enums / refs ------------------------------------------
{
  const r = parseDirectionImpact("bogus | direction.md#INV-X | none");
  assert(r.issues.some((i) => /invalid relation/.test(i.message)), "invalid relation → error");
}
{
  const r = parseDirectionImpact("touches | README.md#FOO | none");
  assert(r.issues.some((i) => /invalid ref/.test(i.message)), "invalid ref (not direction/requirements) → error");
}
{
  const r = parseDirectionImpact("touches | direction.md#INV-X | maybe");
  assert(r.issues.some((i) => /invalid escalation/.test(i.message)), "invalid escalation → error");
}
{
  const r = parseDirectionImpact("touches | direction.md#INV-X");
  assert(r.issues.some((i) => /<relation> \| <ref> \| <escalation>/.test(i.message)), "malformed (<3 parts) → error");
}
{
  // requirements ref accepted
  const r = parseDirectionImpact("narrows | requirements.md#REQ-006 | proposed");
  assert(r.issues.length === 0 && r.impacts.length === 1, "requirements ref + proposed valid");
}

// ---- read-side: lintMarkdown integration ----------------------------------
function buildEntry(diBlock) {
  return [
    "---",
    "scope: project",
    "kind: decision",
    "status: active",
    "confidence: 8",
    "created: 2026-06-13",
    "schema_version: 1",
    "title: Test Entry",
    diBlock,
    "---",
    "",
    "# Test Entry",
    "",
    "This is a body long enough to pass the summary heuristic and lint.",
    "",
    "## Timeline",
    "",
    "- 2026-06-13 | created",
    "",
  ].join("\n");
}
{
  const raw = buildEntry("direction_impact:\n  - weakens | direction.md#INV-AUTONOMY | none");
  const issues = lintMod.lintMarkdown(raw, "test.md");
  assert(issues.some((i) => i.rule === "D1 direction-impact" && i.severity === "error"), "lint: red-line violation → D1 error");
}
{
  const raw = buildEntry("direction_impact:\n  - weakens | direction.md#INV-AUTONOMY | required");
  const issues = lintMod.lintMarkdown(raw, "test.md");
  assert(!issues.some((i) => i.rule === "D1 direction-impact"), "lint: escalated weakens → no D1 issue");
}
{
  const raw = buildEntry("direction_impact:\n  - bogus | direction.md#INV-X | none");
  const issues = lintMod.lintMarkdown(raw, "test.md");
  assert(issues.some((i) => i.rule === "D1 direction-impact" && /invalid relation/.test(i.message)), "lint: invalid relation → D1 error");
}

// ---- write-side: validateProjectEntryDraft integration --------------------
function baseDraft(extra) {
  return { title: "T", kind: "decision", compiledTruth: "A compiled truth long enough.", status: "active", confidence: 8, ...extra };
}
{
  const issues = validation.validateProjectEntryDraft(baseDraft({ directionImpact: "weakens | direction.md#INV-AUTONOMY | none" }));
  assert(issues.some((i) => i.field === "direction_impact"), "draft: red-line violation → direction_impact issue");
}
{
  const issues = validation.validateProjectEntryDraft(baseDraft({ directionImpact: ["supports | requirements.md#REQ-003 | none"] }));
  assert(!issues.some((i) => i.field === "direction_impact"), "draft: valid direction_impact → no issue");
}
{
  const issues = validation.validateProjectEntryDraft(baseDraft({}));
  assert(!issues.some((i) => i.field === "direction_impact"), "draft: absent direction_impact → no issue");
}
{
  // schema-only base still validates other fields (sanity: not broken by our addition)
  const issues = validation.validateProjectEntryDraft({ kind: "decision", compiledTruth: "x", status: "active" });
  assert(issues.some((i) => i.field === "title"), "draft: missing title still caught");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`smoke:direction-impact OK (${passed} assertions)`);
