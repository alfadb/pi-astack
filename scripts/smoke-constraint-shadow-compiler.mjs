#!/usr/bin/env node
/**
 * Smoke test: ADR 0039 P1 Constraint Shadow Compiler PR2/PR3/PR4.
 *
 * Offline only: fixture sources + mock decisions, mock LLM invokers, no runtime hook,
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
function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}
function treeHash(root) {
  return sha256Hex(listFiles(root).map((rel) => `${rel}:${sha256Hex(fs.readFileSync(path.join(root, rel), "utf8"))}`).join("\n"));
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
  "extensions/sediment/constraint-compiler/prompt.ts",
  "extensions/sediment/constraint-compiler/llm-compiler.ts",
  "extensions/sediment/constraint-compiler/pi-ai-invoker.ts",
  "extensions/sediment/constraint-compiler/shadow-runner.ts",
]) {
  stageTs(outRoot, file);
}

const { makeDiagnostic, assertDiagnosticConsumers } = require(path.join(outRoot, "sediment", "constraint-compiler", "diagnostics.js"));
const { normalizeConstraintSources, sha256Hex } = require(path.join(outRoot, "sediment", "constraint-compiler", "normalize.js"));
const { scanLegacyConstraintSources } = require(path.join(outRoot, "sediment", "constraint-compiler", "legacy-scan.js"));
const { validateConstraintCompilerDecision } = require(path.join(outRoot, "sediment", "constraint-compiler", "validate-decision.js"));
const { renderConstraintShadowView } = require(path.join(outRoot, "sediment", "constraint-compiler", "render.js"));
const { createConstraintDiffReport } = require(path.join(outRoot, "sediment", "constraint-compiler", "diff.js"));
const { buildConstraintCompilerPrompt } = require(path.join(outRoot, "sediment", "constraint-compiler", "prompt.js"));
const { parseConstraintCompilerDecision, runConstraintCompilerWithInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "llm-compiler.js"));
const { createPiAiConstraintCompilerInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "pi-ai-invoker.js"));
const { runConstraintShadowCompiler } = require(path.join(outRoot, "sediment", "constraint-compiler", "shadow-runner.js"));

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

console.log("constraint shadow compiler — ADR 0039 P1 PR2/PR3/PR4 shadow runner");

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

check("prompt builder is deterministic and shadow-only", () => {
  const prompt = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  const again = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(prompt.promptHash === again.promptHash, "prompt hash drifted");
  assert(prompt.text.includes("shadow-only"), "shadow-only instruction missing");
  assert(prompt.text.includes("Return JSON only"), "JSON-only instruction missing");
  assert(prompt.text.includes(globalSource.sourceId), "source id missing from prompt");
});

check("prompt builder fails closed when input exceeds budget", () => {
  let threw = false;
  try { buildConstraintCompilerPrompt({ normalized, maxPromptChars: 32 }); } catch { threw = true; }
  assert(threw, "oversized prompt accepted");
});

check("LLM adapter parses fenced JSON and stamps input hash", async () => {
  const prompt = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  const result = await runConstraintCompilerWithInvoker({
    prompt,
    invoker: async () => ({ ok: true, text: `\`\`\`json\n${JSON.stringify({ ...decision, inputRootHash: "model-supplied-wrong-hash" })}\n\`\`\`` }),
  });
  assert(result.ok, "valid fenced JSON rejected");
  assert(result.ok && result.decision.inputRootHash === normalized.inputRootHash, "adapter did not stamp expected input hash");
});

check("LLM adapter fails closed on malformed JSON", () => {
  const parsed = parseConstraintCompilerDecision("not-json", normalized.inputRootHash);
  assert(!parsed.ok, "malformed JSON accepted");
  assert(!parsed.ok && parsed.diagnostic.code === "SC_COMPILER_PARSE_FAILED", "wrong parse failure diagnostic");
});

check("LLM adapter reports model unavailable", async () => {
  const prompt = buildConstraintCompilerPrompt({ normalized });
  const result = await runConstraintCompilerWithInvoker({
    prompt,
    invoker: async () => ({ ok: false, error: "offline model unavailable" }),
  });
  assert(!result.ok, "model failure accepted");
  assert(!result.ok && result.diagnostic.code === "SC_COMPILER_MODEL_UNAVAILABLE", "wrong model failure diagnostic");
});

check("pi-ai invoker uses registry auth and extracts text", async () => {
  const invoker = createPiAiConstraintCompilerInvoker({
    modelRegistry: {
      find(provider, modelId) {
        assert(provider === "test", "provider not parsed");
        assert(modelId === "model", "model id not parsed");
        return { provider, id: modelId };
      },
      async getApiKeyAndHeaders(model) {
        assert(model.id === "model", "wrong model passed to auth");
        return { ok: true, apiKey: "secret", headers: { "x-test": "1" } };
      },
    },
    defaultModelRef: "test/model",
    streamSimpleImpl: {
      streamSimple(model, opts, config) {
        assert(model.id === "model", "wrong model passed to stream");
        assert(config.apiKey === "secret", "api key not forwarded");
        assert(opts.messages[0].content[0].text.includes("shadow-only"), "prompt text missing");
        return { result: async () => ({ content: [{ type: "text", text: "{\"ok\":true}" }] }) };
      },
    },
  });
  const prompt = buildConstraintCompilerPrompt({ normalized });
  const result = await invoker({ prompt });
  assert(result.ok && result.text === "{\"ok\":true}", "text result not extracted");
});

check("pi-ai invoker fails closed on missing model", async () => {
  const invoker = createPiAiConstraintCompilerInvoker({
    modelRegistry: {
      find() { return null; },
      async getApiKeyAndHeaders() { return { ok: false, error: "should not auth" }; },
    },
    defaultModelRef: "test/missing",
    streamSimpleImpl: { streamSimple() { throw new Error("should not call stream"); } },
  });
  const prompt = buildConstraintCompilerPrompt({ normalized });
  const result = await invoker({ prompt });
  assert(!result.ok && result.error.includes("model not found"), "missing model was not fail-closed");
});

check("manual dossier entry is default-off and not a smoke script", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert(pkg.scripts["dossier:constraint-shadow-report"] === "node scripts/dossier-constraint-shadow-report.mjs", "dossier script missing");
  assert(!Object.keys(pkg.scripts).some((name) => name.startsWith("smoke:") && String(pkg.scripts[name]).includes("dossier-constraint-shadow-report")), "manual dossier registered as smoke");
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "dossier-constraint-shadow-report.mjs"), "utf8");
  assert(script.includes("SKIP — sediment.constraintShadowCompiler.enabled is false"), "default-off skip missing");
  assert(script.includes("SKIP — dry-run mode does not call the real LLM"), "dry-run skip missing");
  assert(!script.includes("agent_end"), "manual script mentions agent_end hook");
  assert(!script.includes("session_start"), "manual script mentions session_start hook");
  assert(!script.includes("before_agent_start"), "manual script mentions before_agent_start hook");
});

check("shadow settings schema exposes disabled manual compiler", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
  const cfg = schema.properties.sediment.properties.constraintShadowCompiler;
  assert(cfg.properties.enabled.default === false, "constraint shadow compiler default is not disabled");
  assert(cfg.properties.model.default === "", "constraint shadow compiler model should not be hardcoded");
});

check("shadow runner writes artifacts only under shadow state and keeps rules unchanged", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-runner-"));
  const writeRule = (rel, frontmatter, body) => writeFile(path.join(abrainHome, rel), `---\n${frontmatter}\n---\n${body}\n`);
  writeRule("rules/always/use-edit-not-sed.md", "title: Use edit not sed\nstatus: active\nkind: preference", "# Use edit not sed\n\n修改文件必须用 edit/write，禁止 sed -i。");
  writeRule("rules/always/model-tier-setting.md", "title: Model tier setting\nstatus: active\nkind: preference", "# Model tier setting\n\nAll model calls must use a configured model tier setting.");
  const rulesRoot = path.join(abrainHome, "rules");
  const beforeHash = treeHash(rulesRoot);
  const beforeFiles = listFiles(rulesRoot).join("\n");
  const result = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    knownProjectIds: ["pi-astack"],
    writeArtifacts: true,
    runId: "fixture-run",
    compilerInvoker: async () => ({
      ok: true,
      text: JSON.stringify({
        schemaVersion: "constraint-shadow-decision/v1",
        inputRootHash: "ignored-by-parser",
        constraints: [{
          scope: { kind: "global" },
          injectMode: "always",
          title: "Use edit/write",
          compiledBody: "修改文件必须用 edit/write，禁止 sed -i。",
          sourceRecordIds: ["rule:global:always:use-edit-not-sed"],
        }],
        exclusions: [{ reason: "settings_not_memory", sourceRecordIds: ["rule:global:always:model-tier-setting"] }],
        unresolved: [],
        merges: [],
        rescopeProposals: [],
        mappings: [
          { sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" },
          { sourceRecordId: "rule:global:always:model-tier-setting", disposition: "excluded" },
        ],
        diagnostics: [makeDiagnostic({ code: "SC_NOT_MEMORY_SETTINGS", message: "settings belong in settings", sourceRecordIds: ["rule:global:always:model-tier-setting"] })],
      }),
    }),
  });
  assert(result.ok, "runner success path failed");
  assert(result.ok && result.diff.summary.unmappedSources === 0, "runner produced unmapped sources");
  assert(result.ok && result.artifacts && result.artifacts.runDir.includes(".state/sediment/constraint-shadow/runs/fixture-run"), "artifact run dir outside shadow state");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "compiled-view.md")), "latest compiled view missing");
  assert(beforeHash === treeHash(rulesRoot), "rules content changed");
  assert(beforeFiles === listFiles(rulesRoot).join("\n"), "rules file list changed");
});

check("shadow runner fails closed on artifact path violation", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-violation-"));
  writeFile(path.join(abrainHome, "rules/always/use-edit-not-sed.md"), "---\ntitle: Use edit not sed\nstatus: active\nkind: preference\n---\n# Use edit not sed\n\n修改文件必须用 edit/write。\n");
  const result = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    artifactRoot: path.join(abrainHome, "rules", "always"),
    writeArtifacts: true,
    runId: "bad-run",
    compilerInvoker: async () => ({
      ok: true,
      text: JSON.stringify({
        schemaVersion: "constraint-shadow-decision/v1",
        inputRootHash: "ignored-by-parser",
        constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit", compiledBody: "修改文件必须用 edit/write。", sourceRecordIds: ["rule:global:always:use-edit-not-sed"] }],
        exclusions: [],
        unresolved: [],
        merges: [],
        rescopeProposals: [],
        mappings: [{ sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" }],
        diagnostics: [],
      }),
    }),
  });
  assert(!result.ok, "artifact path violation accepted");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "SC_SHADOW_ONLY_VIOLATION_ATTEMPT"), "path violation diagnostic missing");
});

check("shadow runner fails closed on validation failure", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-invalid-"));
  writeFile(path.join(abrainHome, "rules/always/use-edit-not-sed.md"), "---\ntitle: Use edit not sed\nstatus: active\nkind: preference\n---\n# Use edit not sed\n\n修改文件必须用 edit/write。\n");
  const result = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    writeArtifacts: false,
    compilerInvoker: async () => ({
      ok: true,
      text: JSON.stringify({
        schemaVersion: "constraint-shadow-decision/v1",
        inputRootHash: "ignored-by-parser",
        constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Bad", compiledBody: "", sourceRecordIds: ["rule:global:always:use-edit-not-sed"] }],
        exclusions: [],
        unresolved: [],
        merges: [],
        rescopeProposals: [],
        mappings: [{ sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" }],
        diagnostics: [],
      }),
    }),
  });
  assert(!result.ok, "invalid compiler decision accepted");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "SC_COMPILER_VALIDATION_FAILED"), "validation failure diagnostic missing");
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
  console.log(`\nall ok — constraint shadow compiler PR2/PR3/PR4 holds (${total} assertions).`);
});
