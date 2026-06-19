#!/usr/bin/env node
/**
 * Smoke test: ADR 0039 P1 Constraint Shadow Compiler PR2 pure functions.
 *
 * Offline only: fixture sources + mock decisions, no LLM, no runtime hook,
 * no canonical rule mutation, and no writes outside temporary fixture trees.
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
const pending = [];
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(
        () => console.log(`  ok    ${name}`),
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
        },
      ));
      return;
    }
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
  new (require("node:vm").Script)(out, { filename: srcPath });
  return out;
}
function stageTs(outRoot, src, dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js")) {
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}

const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-constraint-shadow-"));
for (const file of [
  "extensions/_shared/runtime.ts",
  "extensions/memory/settings.ts",
  "extensions/memory/utils.ts",
  "extensions/memory/direction-impact.ts",
  "extensions/memory/parser.ts",
  "extensions/sediment/sanitizer.ts",
  "extensions/sediment/constraint-compiler/types.ts",
  "extensions/sediment/constraint-compiler/diagnostics.ts",
  "extensions/sediment/constraint-compiler/normalize.ts",
  "extensions/sediment/constraint-compiler/legacy-scan.ts",
  "extensions/sediment/constraint-compiler/validate-decision.ts",
  "extensions/sediment/constraint-compiler/render.ts",
  "extensions/sediment/constraint-compiler/diff.ts",
]) {
  stageTs(outRoot, file);
}

const { makeDiagnostic, assertDiagnosticConsumers } = require(path.join(outRoot, "sediment", "constraint-compiler", "diagnostics.js"));
const { normalizeConstraintSources, sha256Hex } = require(path.join(outRoot, "sediment", "constraint-compiler", "normalize.js"));
const { scanLegacyConstraintSources } = require(path.join(outRoot, "sediment", "constraint-compiler", "legacy-scan.js"));
const { validateConstraintCompilerDecision } = require(path.join(outRoot, "sediment", "constraint-compiler", "validate-decision.js"));
const { renderConstraintShadowView } = require(path.join(outRoot, "sediment", "constraint-compiler", "render.js"));
const { createConstraintDiffReport } = require(path.join(outRoot, "sediment", "constraint-compiler", "diff.js"));

function source(overrides) {
  const body = overrides.body ?? "Use edit/write for file changes.";
  const scope = overrides.scope ?? { kind: "global" };
  const injectMode = overrides.injectMode ?? "always";
  const slug = overrides.slug ?? overrides.sourceId?.split(":").pop() ?? "rule";
  const sourceId = overrides.sourceId ?? (scope.kind === "global"
    ? `rule:global:${injectMode}:${slug}`
    : `rule:project:${scope.projectId}:${injectMode}:${slug}`);
  return {
    sourceKind: "legacy_rule",
    sourceId,
    slug,
    title: overrides.title ?? slug,
    path: overrides.path ?? `/tmp/abrain/${slug}.md`,
    scope,
    injectMode,
    status: overrides.status ?? "active",
    body,
    rawBodyHash: overrides.rawBodyHash ?? sha256Hex(body),
    computedBodyHash: overrides.computedBodyHash ?? sha256Hex(body),
    rawFileHash: overrides.rawFileHash ?? sha256Hex(`${sourceId}:${body}`),
    frontmatterHash: overrides.frontmatterHash ?? sha256Hex(sourceId),
    provenance: overrides.provenance ?? "user-expressed",
    confidence: overrides.confidence ?? 8,
    kind: overrides.kind ?? "preference",
    triggerPhrases: overrides.triggerPhrases ?? [],
    appliesWhen: overrides.appliesWhen ?? "all coding tasks",
    mustDoSummary: overrides.mustDoSummary ?? body,
    frontmatter: overrides.frontmatter ?? { status: overrides.status ?? "active" },
    timelineEvents: overrides.timelineEvents ?? [],
    sourceRef: overrides.sourceRef ?? { ref: sourceId, path: overrides.path ?? `/tmp/abrain/${slug}.md` },
  };
}

const settingsSource = source({
  sourceId: "rule:global:always:model-tier-setting",
  slug: "model-tier-setting",
  title: "Model tier setting",
  body: "All model calls must use a configured model tier setting.",
  triggerPhrases: ["model tier", "setting"],
});
const toolSource = source({
  sourceId: "rule:global:listed:tool-contract",
  slug: "tool-contract",
  injectMode: "listed",
  title: "Tool contract",
  body: "dispatch_parallel must follow the tool contract and worker limit.",
  triggerPhrases: ["dispatch_parallel", "tool contract"],
});
const globalSource = source({
  sourceId: "rule:global:always:use-edit-not-sed",
  slug: "use-edit-not-sed",
  body: "修改文件必须用 edit/write 工具，禁止 sed -i。",
});
const duplicateSource = source({
  sourceId: "rule:global:always:no-sed-overwrite",
  slug: "no-sed-overwrite",
  body: "不要用 sed -i 或重定向覆写文件，用 edit 工具。",
});
const projectSource = source({
  sourceId: "rule:project:pi-astack:always:project-yarn",
  slug: "project-yarn",
  scope: { kind: "project", projectId: "pi-astack" },
  body: "pi-astack 项目使用 yarn。",
});
const globalToProjectSource = source({
  sourceId: "rule:global:always:pi-astack-only-yarn",
  slug: "pi-astack-only-yarn",
  body: "pi-astack 项目专用：使用 yarn。",
});
const conflictSource = source({
  sourceId: "rule:global:always:conflict-gh",
  slug: "conflict-gh",
  body: "All GitHub repositories must use gh CLI.",
});
const compactSource = source({
  sourceId: "rule:global:always:verbose-typescript-rule",
  slug: "verbose-typescript-rule",
  body: "在编写 TypeScript 代码时，必须使用 const 而非 let 当变量不会重新赋值时；使用 async/await 而非 then 链；使用模板字符串；导出函数写返回类型。",
});
const archivedSource = source({
  sourceId: "rule:global:always:archived-rule",
  slug: "archived-rule",
  status: "archived",
  body: "这是一条已归档规则。",
});
const supersededSource = source({
  sourceId: "rule:global:listed:superseded-rule",
  slug: "superseded-rule",
  injectMode: "listed",
  status: "superseded",
  body: "这是一条已被取代规则。",
});
const deprecatedSource = source({
  sourceId: "rule:global:always:deprecated-rule",
  slug: "deprecated-rule",
  status: "deprecated",
  body: "这是一条已弃用规则。",
});
const unknownSource = source({
  sourceId: "rule:global:listed:unknown-rule",
  slug: "unknown-rule",
  injectMode: "listed",
  status: "unknown",
  body: "这是一条状态未知规则。",
});

const allSources = [
  settingsSource,
  toolSource,
  globalSource,
  duplicateSource,
  projectSource,
  globalToProjectSource,
  conflictSource,
  compactSource,
  archivedSource,
  supersededSource,
  deprecatedSource,
  unknownSource,
];

const normalized = normalizeConstraintSources(allSources, {
  activeProjectId: "pi-astack",
  knownProjectIds: ["pi-astack"],
  compilerOptions: { mode: "fixture" },
});

const baseDiagnostics = [
  makeDiagnostic({ code: "SC_NOT_MEMORY_SETTINGS", message: "settings belong in settings", sourceRecordIds: [settingsSource.sourceId] }),
  makeDiagnostic({ code: "SC_NOT_MEMORY_TOOL_CONTRACT", message: "tool contract belongs in tool declaration", sourceRecordIds: [toolSource.sourceId] }),
  makeDiagnostic({ code: "SC_NEAR_DUPLICATE_GROUP", message: "near duplicate group", sourceRecordIds: [globalSource.sourceId, duplicateSource.sourceId] }),
  makeDiagnostic({ code: "SC_CONFLICT_DETECTED", message: "conflict kept unresolved", sourceRecordIds: [conflictSource.sourceId] }),
  makeDiagnostic({ code: "SC_COMPACT_REQUIRED", message: "compact verbose source", sourceRecordIds: [compactSource.sourceId] }),
  makeDiagnostic({ code: "SC_ARCHIVED_REACTIVATION_RISK", message: "legacy closed status observed", sourceRecordIds: [archivedSource.sourceId, supersededSource.sourceId, deprecatedSource.sourceId, unknownSource.sourceId] }),
];

const decision = {
  schemaVersion: "constraint-shadow-decision/v1",
  inputRootHash: normalized.inputRootHash,
  constraints: [
    {
      scope: { kind: "global" },
      injectMode: "always",
      title: "Use edit/write for file changes",
      compiledBody: "修改文件必须用 edit/write，禁止 sed -i 或重定向覆写。",
      sourceRecordIds: [globalSource.sourceId, duplicateSource.sourceId],
      priorityHint: 9,
      mustDoSummary: "Use edit/write for file changes.",
    },
    {
      scope: { kind: "project", projectId: "pi-astack" },
      injectMode: "always",
      title: "Project package manager",
      compiledBody: "pi-astack 项目使用 yarn。",
      sourceRecordIds: [projectSource.sourceId],
      priorityHint: 5,
    },
    {
      scope: { kind: "global" },
      injectMode: "always",
      title: "TypeScript concise rule",
      compiledBody: "TypeScript 代码优先使用 const、async/await、模板字符串，并为导出函数标注返回类型。",
      sourceRecordIds: [compactSource.sourceId],
      priorityHint: 4,
    },
    {
      scope: { kind: "project", projectId: "pi-astack" },
      injectMode: "always",
      title: "Rescoped project-only yarn rule",
      compiledBody: "pi-astack 项目使用 yarn。",
      sourceRecordIds: [globalToProjectSource.sourceId],
      priorityHint: 3,
    },
  ],
  exclusions: [
    { reason: "settings_not_memory", sourceRecordIds: [settingsSource.sourceId] },
    { reason: "tool_contract_not_memory", sourceRecordIds: [toolSource.sourceId] },
    { reason: "legacy_archived_observed", sourceRecordIds: [archivedSource.sourceId] },
    { reason: "superseded_observed", sourceRecordIds: [supersededSource.sourceId] },
    { reason: "obsolete_archived", sourceRecordIds: [deprecatedSource.sourceId] },
  ],
  unresolved: [
    { reason: "conflict", sourceRecordIds: [conflictSource.sourceId], note: "conflicting CLI guidance" },
    { reason: "unknown_status", sourceRecordIds: [unknownSource.sourceId], note: "unknown legacy status" },
  ],
  merges: [
    { sourceRecordIds: [globalSource.sourceId, duplicateSource.sourceId], reason: "near duplicate" },
  ],
  rescopeProposals: [
    { sourceRecordIds: [globalToProjectSource.sourceId], fromScope: { kind: "global" }, toScope: { kind: "project", projectId: "pi-astack" }, reason: "source text is project-only" },
  ],
  mappings: [
    { sourceRecordId: settingsSource.sourceId, disposition: "excluded" },
    { sourceRecordId: toolSource.sourceId, disposition: "excluded" },
    { sourceRecordId: globalSource.sourceId, disposition: "compiled" },
    { sourceRecordId: duplicateSource.sourceId, disposition: "compiled" },
    { sourceRecordId: projectSource.sourceId, disposition: "compiled" },
    { sourceRecordId: globalToProjectSource.sourceId, disposition: "compiled" },
    { sourceRecordId: conflictSource.sourceId, disposition: "unresolved" },
    { sourceRecordId: compactSource.sourceId, disposition: "compiled" },
    { sourceRecordId: archivedSource.sourceId, disposition: "excluded" },
    { sourceRecordId: supersededSource.sourceId, disposition: "excluded" },
    { sourceRecordId: deprecatedSource.sourceId, disposition: "excluded" },
    { sourceRecordId: unknownSource.sourceId, disposition: "unresolved" },
  ],
  diagnostics: baseDiagnostics,
};

console.log("constraint shadow compiler — ADR 0039 P1 PR2 pure functions");

check("diagnostics have consumers", () => {
  assertDiagnosticConsumers(baseDiagnostics);
});

check("normalize inputRootHash is stable under source order", () => {
  const shuffled = normalizeConstraintSources([...allSources].reverse(), {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  assert(normalized.inputRootHash === shuffled.inputRootHash, "source order changed inputRootHash");
});

check("normalize inputRootHash changes when source body changes", () => {
  const changed = normalizeConstraintSources(allSources.map((item) => item.sourceId === globalSource.sourceId ? { ...item, body: `${item.body} changed`, computedBodyHash: sha256Hex(`${item.body} changed`) } : item), {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  assert(normalized.inputRootHash !== changed.inputRootHash, "body change did not change inputRootHash");
});

check("validator accepts complete fixture decision", () => {
  const validated = validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  assert(validated.constraints.every((constraint) => constraint.constraintId.startsWith("shadow:")), "constraint ids not derived");
});

check("validator rejects inputRootHash mismatch", () => {
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"], expectedInputRootHash: "wrong" }); } catch { threw = true; }
  assert(threw, "inputRootHash mismatch accepted");
});

check("validator rejects unknown source id", () => {
  const bad = { ...decision, constraints: [{ ...decision.constraints[0], sourceRecordIds: ["missing"] }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "unknown source id accepted");
});

check("validator rejects source compiled and excluded", () => {
  const bad = { ...decision, exclusions: [...decision.exclusions, { reason: "settings_not_memory", sourceRecordIds: [globalSource.sourceId] }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "compiled+excluded source accepted");
});

check("validator rejects unknown project scope", () => {
  const bad = { ...decision, constraints: [{ ...decision.constraints[1], scope: { kind: "project", projectId: "missing-project" } }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "unknown project accepted");
});

check("validator rejects project source compiled into global without rescope", () => {
  const bad = { ...decision, constraints: decision.constraints.map((constraint) => constraint.sourceRecordIds.includes(projectSource.sourceId) ? { ...constraint, scope: { kind: "global" } } : constraint), rescopeProposals: [] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "project source globalized without rescope accepted");
});

check("validator rejects merge not covered by compiled constraint", () => {
  const bad = { ...decision, merges: [{ sourceRecordIds: [settingsSource.sourceId, toolSource.sourceId], reason: "bad merge" }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "uncovered merge accepted");
});

check("validator rejects mapping disposition mismatch", () => {
  const bad = { ...decision, mappings: decision.mappings.map((mapping) => mapping.sourceRecordId === settingsSource.sourceId ? { ...mapping, disposition: "compiled" } : mapping) };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "mapping disposition mismatch accepted");
});

check("validator rejects not-memory reason with wrong diagnostic code", () => {
  const bad = { ...decision, diagnostics: decision.diagnostics.filter((diagnostic) => diagnostic.code !== "SC_NOT_MEMORY_TOOL_CONTRACT") };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "wrong not-memory diagnostic accepted");
});

check("validator rejects diagnostics without consumers", () => {
  const bad = { ...decision, diagnostics: [{ ...decision.diagnostics[0], consumers: [] }, ...decision.diagnostics.slice(1)] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "empty diagnostic consumers accepted");
});

check("renderer is deterministic for same validated decision", () => {
  const validated = validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  const first = renderConstraintShadowView(validated);
  const second = renderConstraintShadowView(validated);
  assert(first.markdown === second.markdown, "markdown drifted");
  assert(first.shadowOutputHash === second.shadowOutputHash, "hash drifted");
  assert(first.markdown.includes("shadow_only: true"), "shadow marker missing");
});

check("diff maps every source and covers required categories", () => {
  const validated = validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  const report = createConstraintDiffReport(allSources, validated);
  assert(report.summary.totalSources === allSources.length, "wrong source count");
  assert(report.summary.unmappedSources === 0, "unexpected unmapped source");
  const categories = new Set(report.rows.map((row) => row.category));
  for (const category of ["exclude_not_memory_settings", "exclude_not_memory_tool_contract", "merge_near_duplicates", "compact", "mark_conflict", "legacy_archived_observed", "rescope_global_to_project"]) {
    assert(categories.has(category), `missing category ${category}`);
  }
});

check("legacy scanner reads active and non-active fixture rules", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-abrain-"));
  const writeRule = (rel, frontmatter, body) => writeFile(path.join(abrainHome, rel), `---\n${frontmatter}\n---\n${body}\n`);
  writeRule("rules/always/active.md", "title: Active\nstatus: active\nkind: preference", "# Active\n\nActive body");
  writeRule("rules/listed/archived.md", "title: Archived\nstatus: archived\nkind: pattern", "# Archived\n\nArchived body");
  writeRule("projects/pi-astack/rules/always/unknown.md", "title: Unknown\nstatus: mystery\nkind: preference", "# Unknown\n\nUnknown body");
  return scanLegacyConstraintSources({
    abrainHome,
    cwd: repoRoot,
    includeProjects: ["pi-astack"],
    includeStatuses: "all",
    activeProjectId: "pi-astack",
  }).then((result) => {
    assert(result.rules.length === 3, `expected 3 rules, got ${result.rules.length}`);
    assert(result.rules.some((record) => record.status === "archived"), "archived rule missing");
    assert(result.rules.some((record) => record.status === "unknown"), "unknown status rule missing");
  });
});

check("constraint compiler source does not import writer mutation symbols", () => {
  const dir = path.join(repoRoot, "extensions", "sediment", "constraint-compiler");
  const offenders = [];
  const forbidden = [
    "writeAbrainRule",
    "applyTier1RuleAdjudication",
    "archiveAbrainRule",
    "deleteAbrainRule",
    "mutateRuleStatusContested",
    "resolveRuleWrite",
    "runTier1JaccardAdjudication",
    "curateProjectDraft",
    "executeCuratorDecisionToBrain",
    "writeProjectEntry",
    "updateProjectEntry",
  ];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    for (const token of forbidden) {
      if (raw.includes(token)) offenders.push(`${file}:${token}`);
    }
  }
  assert(offenders.length === 0, `forbidden mutation symbols found: ${offenders.join(", ")}`);
});

Promise.all(pending).finally(() => {
  if (failures.length) {
    console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
    process.exit(1);
  }
  console.log(`\nall ok — constraint shadow compiler PR2 holds (${total} assertions).`);
});
