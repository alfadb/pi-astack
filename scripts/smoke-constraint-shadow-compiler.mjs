#!/usr/bin/env node
/**
 * Smoke test: ADR 0039 Constraint Shadow Compiler PR2/PR3/PR4/PR6.
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
  "extensions/sediment/settings.ts",
  "extensions/sediment/knowledge-evidence.ts",
  "extensions/sediment/sanitizer.ts",
  "extensions/sediment/constraint-compiler/types.ts",
  "extensions/sediment/constraint-evidence/types.ts",
  "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts",
  "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/read.ts",
  "extensions/sediment/constraint-evidence/status.ts",
  "extensions/sediment/constraint-compiler/diagnostics.ts",
  "extensions/sediment/constraint-compiler/normalize.ts",
  "extensions/sediment/constraint-compiler/legacy-scan.ts",
  "extensions/sediment/constraint-compiler/event-scan.ts",
  "extensions/sediment/constraint-compiler/event-report.ts",
  "extensions/sediment/constraint-compiler/validate-decision.ts",
  "extensions/sediment/constraint-compiler/render.ts",
  "extensions/sediment/constraint-compiler/diff.ts",
  "extensions/sediment/constraint-compiler/prompt.ts",
  "extensions/sediment/constraint-compiler/llm-compiler.ts",
  "extensions/sediment/constraint-compiler/pi-ai-invoker.ts",
  "extensions/sediment/constraint-evidence/append.ts",
  "extensions/sediment/constraint-compiler/projection.ts",
  "extensions/sediment/constraint-compiler/corpus-split.ts",
  "extensions/sediment/constraint-compiler/shadow-runner.ts",
]) {
  stageTs(outRoot, file);
}

const { makeDiagnostic, assertDiagnosticConsumers } = require(path.join(outRoot, "sediment", "constraint-compiler", "diagnostics.js"));
const { createConstraintEvidenceEnvelope, constraintEvidenceEventPath } = require(path.join(outRoot, "sediment", "constraint-evidence", "hash-envelope.js"));
const { normalizeConstraintSources, sha256Hex } = require(path.join(outRoot, "sediment", "constraint-compiler", "normalize.js"));
const { scanLegacyConstraintSources } = require(path.join(outRoot, "sediment", "constraint-compiler", "legacy-scan.js"));
const { validateConstraintCompilerDecision } = require(path.join(outRoot, "sediment", "constraint-compiler", "validate-decision.js"));
const { renderConstraintShadowView } = require(path.join(outRoot, "sediment", "constraint-compiler", "render.js"));
const { createConstraintDiffReport } = require(path.join(outRoot, "sediment", "constraint-compiler", "diff.js"));
const { scanConstraintEvidenceEvents } = require(path.join(outRoot, "sediment", "constraint-compiler", "event-scan.js"));
const { createConstraintEventCoverageReport, createConstraintLegacyParallelDeltaReport } = require(path.join(outRoot, "sediment", "constraint-compiler", "event-report.js"));
const { buildConstraintCompilerPrompt } = require(path.join(outRoot, "sediment", "constraint-compiler", "prompt.js"));
const { parseConstraintCompilerDecision, runConstraintCompilerWithInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "llm-compiler.js"));
const { createPiAiConstraintCompilerInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "pi-ai-invoker.js"));
const { runConstraintShadowCompiler } = require(path.join(outRoot, "sediment", "constraint-compiler", "shadow-runner.js"));
const { CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION, selectLatestConstraintProjectionEventId } = require(path.join(outRoot, "sediment", "constraint-compiler", "projection.js"));
const { renderConstraintL2View } = require(path.join(outRoot, "sediment", "constraint-compiler", "render.js"));
const { buildCorpusSplitReport, stratumForRow, CORPUS_SPLIT_STRATA } = require(path.join(outRoot, "sediment", "constraint-compiler", "corpus-split.js"));

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .map(([key, nested]) => [key, withoutUndefined(nested)]));
}

function writeConstraintEvidenceEvent(abrainHome, bodyOverrides = {}) {
  const createdAtUtc = bodyOverrides.created_at_utc ?? "2026-06-19T00:00:00.000Z";
  const body = withoutUndefined({
    event_schema_version: "constraint-evidence-event/v1",
    event_type: bodyOverrides.event_type ?? "constraint_signal_observed",
    created_at_utc: createdAtUtc,
    device_id: bodyOverrides.device_id ?? "test-device",
    producer_nonce: bodyOverrides.producer_nonce ?? `nonce:${createdAtUtc}:${bodyOverrides.session_id ?? "session"}:${bodyOverrides.turn_id ?? "turn"}`,
    actor: bodyOverrides.actor ?? { role: "user", id: "user" },
    causal_parents: bodyOverrides.causal_parents ?? [],
    session_id: bodyOverrides.session_id ?? "session",
    turn_id: bodyOverrides.turn_id ?? "turn",
    source: bodyOverrides.source ?? { channel: "agent_end", source_role: "user", source_ref: "turn:user", quote_hash: sha256Hex("quote") },
    intent: bodyOverrides.intent ?? { domain_hint: "constraint", operation_hint: "create", confidence: 0.8 },
    payload: bodyOverrides.payload ?? {
      sanitized_quote: "以后修改文件必须用 edit/write。",
      candidate_constraint_text: "修改文件必须用 edit/write。",
      candidate_title: "Use edit/write",
      candidate_trigger_phrases: ["edit/write"],
      candidate_priority_hint: "always",
    },
    scope: bodyOverrides.scope ?? {
      active_project_binding: { project_id: "pi-astack", binding_reason: "fixture" },
      scope_hint: { kind: "global", evidence: "fixture global signal" },
      scope_confidence: 0.8,
    },
    sanitizer: bodyOverrides.sanitizer ?? { sanitizer_name: "fixture", sanitizer_version: "1", status: "passed", replacements_count: 0 },
    neighbor_summary: bodyOverrides.neighbor_summary ?? { retrieval_mode: "readonly", input_hash: sha256Hex("input"), neighbor_refs: [], summary: "fixture" },
    producer: bodyOverrides.producer ?? { name: "sediment.constraint-event-writer", version: "fixture" },
    legacy_parallel_write: bodyOverrides.legacy_parallel_write,
    llm_extraction: bodyOverrides.llm_extraction,
    replay_provenance: bodyOverrides.replay_provenance,
    diagnostics: bodyOverrides.diagnostics,
    privacy: bodyOverrides.privacy,
  });
  const envelope = createConstraintEvidenceEnvelope(body);
  writeFile(constraintEvidenceEventPath(abrainHome, envelope.event_id), `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

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

console.log("constraint shadow compiler — ADR 0039 PR2/PR3/PR4/PR6 shadow runner");

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

check("validator canonicalizes compiled/merged_source mapping overlap", () => {
  const compiledVariant = { ...decision, mappings: decision.mappings.map((mapping) => (mapping.sourceRecordId === globalSource.sourceId || mapping.sourceRecordId === duplicateSource.sourceId) ? { ...mapping, disposition: "compiled" } : mapping) };
  const mergedVariant = { ...decision, mappings: decision.mappings.map((mapping) => (mapping.sourceRecordId === globalSource.sourceId || mapping.sourceRecordId === duplicateSource.sourceId) ? { ...mapping, disposition: "merged_source" } : mapping) };
  const compiledValidated = validateConstraintCompilerDecision(allSources, compiledVariant, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  const mergedValidated = validateConstraintCompilerDecision(allSources, mergedVariant, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  for (const sourceId of [globalSource.sourceId, duplicateSource.sourceId]) {
    assert(compiledValidated.mappings.some((mapping) => mapping.sourceRecordId === sourceId && mapping.disposition === "merged_source"), `compiled variant did not canonicalize ${sourceId}`);
    assert(mergedValidated.mappings.some((mapping) => mapping.sourceRecordId === sourceId && mapping.disposition === "merged_source"), `merged variant did not keep canonical ${sourceId}`);
  }
  assert(compiledValidated.diagnostics.some((diagnostic) => diagnostic.code === "SC_MAPPING_DISPOSITION_NORMALIZED" && diagnostic.sourceRecordIds.includes(globalSource.sourceId)), "compiled variant normalization diagnostic missing");
  assert(!mergedValidated.diagnostics.some((diagnostic) => diagnostic.code === "SC_MAPPING_DISPOSITION_NORMALIZED"), "canonical merged variant should not add normalization diagnostics");
  assert(compiledValidated.validationHash === mergedValidated.validationHash, "equivalent overlap mapping variants changed validationHash");
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

check("validator reclassifies unresolved-only exclusion reason to unresolved", () => {
  const ambiguousSource = source({
    sourceId: "rule:project:merdata:always:lsp-restart",
    slug: "lsp-restart",
    scope: { kind: "project", projectId: "merdata" },
    body: "lsp过期了就重启lsp",
  });
  const bad = {
    ...decision,
    exclusions: [...decision.exclusions, { reason: "scope_ambiguous", sourceRecordIds: [ambiguousSource.sourceId], note: "wrong bucket" }],
    mappings: [...decision.mappings, { sourceRecordId: ambiguousSource.sourceId, disposition: "unresolved" }],
  };
  const testSources = [...allSources, ambiguousSource];
  const validated = validateConstraintCompilerDecision(testSources, bad, { knownProjectIds: ["pi-astack", "merdata"] });
  assert(!validated.exclusions.some((item) => item.sourceRecordIds.includes(ambiguousSource.sourceId)), "reclassified exclusion remained excluded");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(ambiguousSource.sourceId) && item.reason === "scope_ambiguous"), "reclassified exclusion did not enter unresolved");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_EXCLUSION_REASON_RECLASSIFIED" && diagnostic.sourceRecordIds.includes(ambiguousSource.sourceId)), "reclassification diagnostic missing");
});

check("validator keeps destructive bare exclusion reasons hard-fail", () => {
  const bad = { ...decision, exclusions: [...decision.exclusions, { reason: "archived", sourceRecordIds: [conflictSource.sourceId] }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "bare destructive exclusion reason accepted");
});

check("validator keeps unknown exclusion reasons hard-fail", () => {
  const bad = { ...decision, exclusions: [...decision.exclusions, { reason: "totally_unknown", sourceRecordIds: [conflictSource.sourceId] }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "unknown exclusion reason accepted");
});

check("validator quarantines reclassified exclusion when source is compiled", () => {
  const bad = { ...decision, exclusions: [...decision.exclusions, { reason: "scope_ambiguous", sourceRecordIds: [compactSource.sourceId] }] };
  const validated = validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] });
  assert(!validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(compactSource.sourceId)), "multi-home source remained compiled");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(compactSource.sourceId) && item.reason === "conflict"), "multi-home source was not quarantined to unresolved conflict");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_SOURCE_MULTI_HOME_QUARANTINED" && diagnostic.sourceRecordIds.includes(compactSource.sourceId)), "multi-home quarantine diagnostic missing");
});

check("validator quarantines unknown project scope per item", () => {
  const bad = { ...decision, constraints: decision.constraints.map((constraint) => constraint.sourceRecordIds.includes(projectSource.sourceId) ? { ...constraint, scope: { kind: "project", projectId: "missing-project" } } : constraint) };
  const validated = validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] });
  assert(!validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(projectSource.sourceId)), "bad project-scoped constraint entered compiled view");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(projectSource.sourceId) && item.reason === "scope_ambiguous"), "unknown project constraint not quarantined to unresolved");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_COMPILER_ITEM_REJECTED" && diagnostic.sourceRecordIds.includes(projectSource.sourceId)), "unknown project quarantine diagnostic missing");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === projectSource.sourceId && mapping.disposition === "unresolved"), "mapping not rewritten to unresolved for quarantined source");
});

check("validator quarantines source scope mismatch without rescope", () => {
  const bad = { ...decision, constraints: decision.constraints.map((constraint) => constraint.sourceRecordIds.includes(projectSource.sourceId) ? { ...constraint, scope: { kind: "global" } } : constraint), rescopeProposals: [] };
  const validated = validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] });
  assert(!validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(projectSource.sourceId)), "scope-mismatched constraint entered compiled view");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(projectSource.sourceId) && item.reason === "scope_ambiguous"), "scope mismatch not quarantined to unresolved");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_COMPILER_ITEM_REJECTED" && diagnostic.sourceRecordIds.includes(projectSource.sourceId)), "scope mismatch quarantine diagnostic missing");
});

check("validator rejects merge not covered by compiled constraint", () => {
  const bad = { ...decision, merges: [{ sourceRecordIds: [settingsSource.sourceId, toolSource.sourceId], reason: "bad merge" }] };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "uncovered merge accepted");
});

check("validator tolerates dangling merge targetConstraintId hint (2026-06-21 projector-death regression)", () => {
  // The constraint projector died on 2026-06-21: the LLM correctly merged the
  // near-duplicate no-industry-jargon rules and named the merge target
  // descriptively (shadow-constraint-no-industry-jargon), which can never match a
  // derived shadow:<hash> id, and the validator hard-threw on the WHOLE decision.
  // targetConstraintId is an unfulfillable optional hint; a dangling hint must not
  // reject a decision whose merge sources ARE covered by a compiled constraint.
  const withDanglingTarget = {
    ...decision,
    merges: [{ sourceRecordIds: [globalSource.sourceId, duplicateSource.sourceId], targetConstraintId: "shadow-constraint-bogus-not-a-hash", reason: "near duplicate" }],
  };
  const validated = validateConstraintCompilerDecision(allSources, withDanglingTarget, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  assert(validated.validationHash, "dangling targetConstraintId hint must not reject a covered merge");
  // The real invariant still holds: an uncovered merge is rejected regardless of hint.
  let threw = false;
  try {
    validateConstraintCompilerDecision(allSources, { ...decision, merges: [{ sourceRecordIds: [settingsSource.sourceId, toolSource.sourceId], targetConstraintId: "shadow-constraint-bogus-not-a-hash", reason: "bad merge" }] }, { knownProjectIds: ["pi-astack"] });
  } catch { threw = true; }
  assert(threw, "uncovered merge with a dangling hint must still be rejected");
});

check("validator normalizes single-primary mapping disposition mismatch", () => {
  const excludedVariant = { ...decision, mappings: decision.mappings.map((mapping) => mapping.sourceRecordId === settingsSource.sourceId ? { ...mapping, disposition: "compiled" } : mapping) };
  const excludedCanonical = { ...decision, mappings: decision.mappings.map((mapping) => mapping.sourceRecordId === settingsSource.sourceId ? { ...mapping, disposition: "excluded" } : mapping) };
  const excludedValidated = validateConstraintCompilerDecision(allSources, excludedVariant, { knownProjectIds: ["pi-astack"] });
  const excludedCanonicalValidated = validateConstraintCompilerDecision(allSources, excludedCanonical, { knownProjectIds: ["pi-astack"] });
  assert(excludedValidated.mappings.some((mapping) => mapping.sourceRecordId === settingsSource.sourceId && mapping.disposition === "excluded"), "excluded single-primary mapping not canonicalized");
  assert(excludedValidated.diagnostics.some((diagnostic) => diagnostic.code === "SC_MAPPING_DISPOSITION_NORMALIZED" && diagnostic.sourceRecordIds.includes(settingsSource.sourceId)), "excluded mapping normalization diagnostic missing");
  assert(excludedValidated.validationHash === excludedCanonicalValidated.validationHash, "excluded mapping normalization changed validationHash");

  const compiledVariant = { ...decision, mappings: decision.mappings.map((mapping) => mapping.sourceRecordId === compactSource.sourceId ? { ...mapping, disposition: "merged_source" } : mapping) };
  const compiledCanonical = { ...decision, mappings: decision.mappings.map((mapping) => mapping.sourceRecordId === compactSource.sourceId ? { ...mapping, disposition: "compiled" } : mapping) };
  const compiledValidated = validateConstraintCompilerDecision(allSources, compiledVariant, { knownProjectIds: ["pi-astack"] });
  const compiledCanonicalValidated = validateConstraintCompilerDecision(allSources, compiledCanonical, { knownProjectIds: ["pi-astack"] });
  assert(compiledValidated.mappings.some((mapping) => mapping.sourceRecordId === compactSource.sourceId && mapping.disposition === "compiled"), "compiled single-primary mapping not canonicalized");
  assert(compiledValidated.diagnostics.some((diagnostic) => diagnostic.code === "SC_MAPPING_DISPOSITION_NORMALIZED" && diagnostic.sourceRecordIds.includes(compactSource.sourceId)), "compiled mapping normalization diagnostic missing");
  assert(compiledValidated.validationHash === compiledCanonicalValidated.validationHash, "compiled mapping normalization changed validationHash");
});

check("validator still rejects mapping with no primary disposition", () => {
  const unmappedSource = source({
    sourceId: "rule:global:listed:mapping-only-source",
    slug: "mapping-only-source",
    injectMode: "listed",
    body: "A source with no compiler bucket is invalid.",
  });
  const bad = { ...decision, mappings: [...decision.mappings, { sourceRecordId: unmappedSource.sourceId, disposition: "compiled" }] };
  let threw = false;
  try { validateConstraintCompilerDecision([...allSources, unmappedSource], bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "mapping-only source accepted without a primary disposition");
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
  assert(report.rows.every((row) => row.scope && typeof row.sourceStatus === "string"), "diff row missing scope/sourceStatus (P5)");
});

// ADR0039 Constraint P5 corpus-split shadow (4×T0 v4) — pure re-projection.
check("corpus-split: deterministic pure re-projection, full coverage, needs_attention=0", () => {
  const validated = validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  const diff = createConstraintDiffReport(allSources, validated);
  const a = buildCorpusSplitReport(diff, { inputRootHash: normalized.inputRootHash });
  const b = buildCorpusSplitReport(diff, { inputRootHash: normalized.inputRootHash });
  assert(a.markdown === b.markdown, "corpus-split markdown drifted");
  assert(a.manifest.outputHash === b.manifest.outputHash, "corpus-split outputHash drifted");
  const m = a.manifest;
  assert(m.schemaVersion === "constraint-corpus-split/v1", "wrong schema");
  assert(m.shadowOnly === true, "shadowOnly not true");
  assert(m.totalSources === allSources.length, "wrong totalSources");
  const sum = CORPUS_SPLIT_STRATA.reduce((s, st) => s + m.counts[st], 0);
  assert(sum === allSources.length && sum === m.rows.length, "Σ strata != totalSources");
  assert(m.coverageOk === true, "coverageOk false on green corpus");
  assert(m.needsAttention === 0, `needs_attention nonzero (${m.needsAttention}) on green corpus`);
  assert(m.counts.settings_not_memory === 1, "settings stratum count");
  assert(m.counts.tool_contract_not_memory === 1, "tool stratum count");
  assert(m.counts.compiled_global >= 1 && m.counts.compiled_project >= 1, "compiled strata empty");
  assert(m.counts.conflict_unresolved >= 1, "conflict stratum empty");
  assert(a.markdown.includes("PROPOSAL — not applied"), "proposal banner missing");
  assert(a.markdown.includes("shadow_only: true"), "shadow marker missing");
  assert(a.markdown.includes(`output_hash: ${m.outputHash}`), "output hash not embedded");
});

check("corpus-split: stratum fold is total over every category + never-default throws", () => {
  assert(CORPUS_SPLIT_STRATA.length === 8, "expected 8 strata");
  const allCategories = ["kept", "compact", "merge_near_duplicates", "rescope_global_to_project", "rescope_project_to_global", "exclude_not_memory_settings", "exclude_not_memory_tool_contract", "split_knowledge_candidate", "mark_conflict", "keep_unresolved", "legacy_archived_observed", "missing_mapping"];
  for (const cat of allCategories) {
    const s = stratumForRow(cat, { kind: "global" });
    assert(CORPUS_SPLIT_STRATA.includes(s), `category ${cat} -> invalid stratum ${s}`);
  }
  assert(stratumForRow("kept", { kind: "global" }) === "compiled_global", "kept global");
  assert(stratumForRow("kept", { kind: "project", projectId: "x" }) === "compiled_project", "kept project");
  assert(stratumForRow("rescope_global_to_project", { kind: "global" }) === "compiled_project", "rescope lands project");
  assert(stratumForRow("missing_mapping", { kind: "global" }) === "needs_attention", "missing->needs_attention");
  let threw = false;
  try { stratumForRow("__bogus_category__", { kind: "global" }); } catch { threw = true; }
  assert(threw, "never-default did not throw on unknown category");
});

check("corpus-split: split_knowledge_candidate is reachable as knowledge_candidate stratum", () => {
  const synthetic = {
    schemaVersion: "constraint-shadow-diff/v1",
    summary: { totalSources: 1, validationStatus: "valid" },
    rows: [{ sourceRecordId: "rule:global:listed:k", scope: { kind: "global" }, sourceStatus: "active", category: "split_knowledge_candidate", disposition: "excluded", reason: "belongs in knowledge" }],
  };
  const out = buildCorpusSplitReport(synthetic, { inputRootHash: "h" });
  assert(out.manifest.counts.knowledge_candidate === 1, "knowledge_candidate not reached");
  assert(out.manifest.rows[0].stratum === "knowledge_candidate", "row stratum wrong");
  assert(out.manifest.coverageOk === true, "coverage not ok");
});

check("corpus-split: coverage fails closed when totalSources disagrees with rows", () => {
  const broken = {
    schemaVersion: "constraint-shadow-diff/v1",
    summary: { totalSources: 2, validationStatus: "valid" },
    rows: [{ sourceRecordId: "a", scope: { kind: "global" }, sourceStatus: "active", category: "kept", disposition: "compiled" }],
  };
  const out = buildCorpusSplitReport(broken, { inputRootHash: "h" });
  assert(out.manifest.coverageOk === false, "coverageOk should be false when totalSources != rows.length");
});

check("corpus-split: real ~/.abrain decision re-projects with full coverage (skip if absent)", () => {
  const base = path.join(os.homedir(), ".abrain/.state/sediment/constraint-shadow/latest");
  const decisionPath = path.join(base, "decision.json");
  const normPath = path.join(base, "input.normalized.json");
  if (!fs.existsSync(decisionPath) || !fs.existsSync(normPath)) { console.log("        (skip: no real ~/.abrain .state present)"); return; }
  const realDecision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
  const realNorm = JSON.parse(fs.readFileSync(normPath, "utf8"));
  const diff = createConstraintDiffReport(realNorm.records, realDecision);
  const out = buildCorpusSplitReport(diff, { inputRootHash: realNorm.inputRootHash });
  const m = out.manifest;
  const sum = CORPUS_SPLIT_STRATA.reduce((s, st) => s + m.counts[st], 0);
  assert(sum === m.totalSources && sum === m.rows.length, `real Σ ${sum} != totalSources ${m.totalSources}`);
  assert(m.coverageOk === true, "real coverageOk false");
  assert(out.markdown.includes(`output_hash: ${m.outputHash}`) && m.outputHash.length === 64, "real output hash not embedded");
  console.log(`        real corpus-split: total=${m.totalSources} needs_attention=${m.needsAttention} | ` + CORPUS_SPLIT_STRATA.map((st) => `${st}=${m.counts[st]}`).join(" "));
});

check("corpus-split: §12 pure-fold + read-only-from-diff source contract", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/constraint-compiler/corpus-split.ts"), "utf8");
  // Sound read-only contract: imports ONLY ./normalize (hash) + ./types. With
  // this allowlist the module cannot reference any scanner / validator / fs at
  // runtime (they are not imported). Checked against full source (imports are
  // never inside comments).
  const fromTargets = [...src.matchAll(/from "([^"]+)"/g)].map((mm) => mm[1]);
  assert(fromTargets.length >= 1, "no imports found");
  for (const t of fromTargets) {
    assert(t === "./normalize" || t === "./types", `forbidden import target in corpus-split.ts: ${t}`);
  }
  // Content/name-matching guard (§12) runs on comment-stripped CODE so the
  // module's own descriptive prose does not trip the literal scan.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["scanLegacy", "validateConstraint", "readFileSync", "writeFileSync", "fixateConstraint", "pi-astack", ".body", ".title", "memory_search", "dispatch_"]) {
    assert(!code.includes(forbidden), `corpus-split.ts violates §12 / read-only contract (code references ${forbidden})`);
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

check("event scanner reads valid L1 events and maps event diagnostics", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-events-"));
  const signal = writeConstraintEvidenceEvent(abrainHome, {
    session_id: "session-a",
    turn_id: "turn-a",
    legacy_parallel_write: { attempted: true, legacy_path_kind: "tier1_ruleset_adjudicator", legacy_operation_hint: "create", legacy_audit_ref: "audit:a" },
  });
  const notMemory = writeConstraintEvidenceEvent(abrainHome, {
    event_type: "constraint_not_memory_observed",
    created_at_utc: "2026-06-19T00:01:00.000Z",
    session_id: "session-b",
    turn_id: "turn-b",
    intent: { domain_hint: "constraint", operation_hint: "not_memory", confidence: 0.9 },
    payload: { sanitized_quote: "model id belongs in settings", not_memory_hint: "settings", candidate_priority_hint: "unknown" },
    legacy_parallel_write: { attempted: true, legacy_path_kind: "tier1_ruleset_adjudicator", legacy_operation_hint: "none", legacy_audit_ref: "audit:b" },
  });
  const replay = writeConstraintEvidenceEvent(abrainHome, {
    created_at_utc: "2026-06-19T00:02:00.000Z",
    session_id: "session-c",
    turn_id: "turn-c",
    source: { channel: "replay", source_role: "system", source_ref: "audit:row-1", quote_hash: sha256Hex("replay quote") },
    replay_provenance: {
      source: "historical_audit_backfill",
      audit_jsonl_path: "/tmp/audit.jsonl",
      audit_jsonl_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      audit_row_index: 1,
      audit_row_timestamp: "2026-06-19T00:02:00.000Z",
      audit_row_operation: "create",
      replay_run_id: "replay-smoke",
      replay_harness_version: "smoke/v1",
      mapping_table_version: "constraint-audit-replay-mapping/v1",
      mapping_table_sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      approximation: "smoke replay provenance",
    },
    legacy_parallel_write: { attempted: true, legacy_path_kind: "tier1_ruleset_adjudicator", legacy_operation_hint: "create", legacy_audit_ref: "audit:c" },
  });
  const scan = await scanConstraintEvidenceEvents({ abrainHome });
  assert(scan.events.length === 3, `expected 3 events, got ${scan.events.length}`);
  assert(scan.invalidEventIds.length === 0, "valid events marked invalid");
  assert(scan.events.some((event) => event.eventId === signal.event_id && event.sourceId === `event:${signal.event_id}`), "signal event missing");
  const replaySource = scan.events.find((event) => event.eventId === replay.event_id);
  assert(replaySource?.replayProvenance?.source === "historical_audit_backfill", "replay provenance missing");
  assert(replaySource?.replayProvenance?.auditJsonlPath === "/tmp/audit.jsonl", "replay audit path missing");
  assert(replaySource?.replayProvenance?.auditJsonlSha256 === "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "replay audit hash missing");
  assert(replaySource?.replayProvenance?.auditRowIndex === 1, "replay audit row index missing");
  assert(replaySource?.replayProvenance?.auditRowTimestamp === "2026-06-19T00:02:00.000Z", "replay audit timestamp missing");
  assert(replaySource?.replayProvenance?.auditRowOperation === "create", "replay audit operation missing");
  assert(replaySource?.replayProvenance?.replayRunId === "replay-smoke", "replay run id missing");
  assert(replaySource?.replayProvenance?.replayHarnessVersion === "smoke/v1", "replay harness version missing");
  assert(replaySource?.replayProvenance?.mappingTableVersion === "constraint-audit-replay-mapping/v1", "replay mapping version missing");
  assert(replaySource?.replayProvenance?.mappingTableSha256 === "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "replay mapping hash missing");
  assert(replaySource?.replayProvenance?.approximation === "smoke replay provenance", "replay approximation missing");
  assert(scan.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(`event:${notMemory.event_id}`)), "not-memory diagnostic missing");
});

check("event scanner cleanly skips foreign envelope schemas, surfaces unknown/malformed (ADR0039 NS-2)", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-foreign-"));
  const signal = writeConstraintEvidenceEvent(abrainHome, { session_id: "s", turn_id: "t" });
  const writeRawEvent = (hex, content) =>
    writeFile(path.join(abrainHome, "l1", "events", "sha256", hex.slice(0, 2), hex.slice(2, 4), `${hex}.json`), content);
  const knowHex = "a1".repeat(32);
  writeRawEvent(knowHex, `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", event_id: knowHex, body_hash: knowHex, body: { event_schema_version: "knowledge-evidence-event/v1", event_type: "knowledge_entry_observed" } }, null, 2)}\n`);
  const projHex = "b2".repeat(32);
  writeRawEvent(projHex, `${JSON.stringify({ schema: "constraint-projection-envelope/v1", event_id: projHex, body_hash: projHex, body: { event_schema_version: "constraint-projection-event/v1", event_type: "constraint_compiled_view_produced" } }, null, 2)}\n`);
  const unkHex = "c3".repeat(32);
  writeRawEvent(unkHex, `${JSON.stringify({ schema: "totally-unknown-envelope/v9", event_id: unkHex, body_hash: unkHex, body: {} }, null, 2)}\n`);
  const badHex = "d4".repeat(32);
  writeRawEvent(badHex, "{ this is not valid json ");
  const scan = await scanConstraintEvidenceEvents({ abrainHome });
  // only the real constraint evidence event is admitted as input
  assert(scan.events.length === 1 && scan.events[0].eventId === signal.event_id, `expected 1 admitted constraint event, got ${scan.events.length}`);
  // known foreign envelopes (knowledge + 固化 projection) are NOT counted invalid (the live-bug fix)
  assert(!scan.invalidEventIds.includes(knowHex) && !scan.invalidEventIds.includes(projHex), "foreign envelope wrongly marked invalid");
  const diagStr = JSON.stringify(scan.diagnostics);
  assert(!diagStr.includes(knowHex) && !diagStr.includes(projHex), "foreign envelope wrongly emitted a diagnostic (should be a clean skip)");
  // unknown schema + malformed json MUST surface as invalid (never silently swallowed)
  assert(scan.invalidEventIds.includes(unkHex), "unknown envelope schema not surfaced as invalid");
  assert(scan.invalidEventIds.includes(badHex), "malformed json not surfaced as invalid");
});

check("event coverage reports queued stale projected and legacy delta", () => {
  const projectedEvent = {
    sourceKind: "constraint_event",
    sourceId: "event:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    eventType: "constraint_signal_observed",
    createdAtUtc: "2026-06-18T00:00:00.000Z",
    sessionId: "session-a",
    turnId: "turn-a",
    sourceChannel: "agent_end",
    sourceRole: "user",
    operationHint: "create",
    confidence: 0.8,
    sanitizedQuote: "修改文件必须用 edit/write。",
    candidateText: "修改文件必须用 edit/write。",
    candidateTitle: "Use edit/write",
    candidateTriggerPhrases: ["edit/write"],
    candidatePriorityHint: "always",
    scopeHint: { kind: "global", evidence: "fixture" },
    activeProjectId: "pi-astack",
    scopeConfidence: 0.8,
    sanitizerStatus: "passed",
    sanitizerReplacementsCount: 0,
    legacyParallelWrite: { attempted: true, legacy_operation_hint: "create" },
    causalParents: [],
    producerName: "sediment.constraint-event-writer",
    producerVersion: "fixture",
    bodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    rawFilePath: "/tmp/event-a.json",
    sourceRef: { ref: "event:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path: "/tmp/event-a.json" },
  };
  const queuedEvent = {
    ...projectedEvent,
    sourceId: "event:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    eventId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceChannel: "manual",
    bodyHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    createdAtUtc: "2026-06-18T00:00:00.000Z",
    legacyParallelWrite: { attempted: true, legacy_operation_hint: "none" },
    rawFilePath: "/tmp/event-b.json",
    sourceRef: { ref: "event:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", path: "/tmp/event-b.json" },
  };
  const mismatchEvent = {
    ...projectedEvent,
    sourceId: "event:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    eventId: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    sourceChannel: "replay",
    bodyHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    operationHint: "not_memory",
    notMemoryHint: "settings",
    createdAtUtc: "2026-06-19T00:00:00.000Z",
    replayProvenance: {
      source: "historical_audit_backfill",
      auditJsonlPath: "/tmp/audit.jsonl",
      auditJsonlSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      auditRowIndex: 2,
      auditRowTimestamp: "2026-06-19T00:00:00.000Z",
      auditRowOperation: "create",
      replayRunId: "replay-smoke",
      replayHarnessVersion: "smoke/v1",
      mappingTableVersion: "constraint-audit-replay-mapping/v1",
      mappingTableSha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      approximation: "smoke replay provenance",
    },
    legacyParallelWrite: { attempted: true, legacy_operation_hint: "create" },
    rawFilePath: "/tmp/event-c.json",
    sourceRef: { ref: "event:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", path: "/tmp/event-c.json" },
  };
  const eventSources = [projectedEvent, queuedEvent, mismatchEvent];
  const eventDecision = validateConstraintCompilerDecision(eventSources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(eventSources).inputRootHash,
    constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit/write", compiledBody: "修改文件必须用 edit/write。", sourceRecordIds: [projectedEvent.sourceId] }],
    exclusions: [{ reason: "settings_not_memory", sourceRecordIds: [mismatchEvent.sourceId] }],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [
      { sourceRecordId: projectedEvent.sourceId, disposition: "compiled" },
      { sourceRecordId: mismatchEvent.sourceId, disposition: "excluded" },
    ],
    diagnostics: [makeDiagnostic({ code: "SC_NOT_MEMORY_SETTINGS", message: "settings signal", sourceRecordIds: [mismatchEvent.sourceId] })],
  });
  const coverage = createConstraintEventCoverageReport({
    events: eventSources,
    decision: eventDecision,
    diagnostics: eventDecision.diagnostics,
    staleAfterMs: 60 * 60 * 1000,
    nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
  });
  assert(coverage.report.summary.totalEvents === 3, "wrong event coverage total");
  assert(coverage.report.summary.projectedEvents === 2, "projected event not counted");
  assert(coverage.report.summary.staleEvents === 1, "stale queued event not counted");
  assert(coverage.report.summary.provenance.liveEvents === 1, "live provenance count missing");
  assert(coverage.report.summary.provenance.manualEvents === 1, "manual provenance count missing");
  assert(coverage.report.summary.provenance.replayBackfillEvents === 1, "replay provenance count missing");
  assert(coverage.report.rows.some((row) => row.provenance?.source === "historical_audit_backfill" && row.sourceChannel === "replay"), "replay row provenance missing");
  assert(coverage.diagnostics.some((diagnostic) => diagnostic.code === "SC_EVENT_STALE_THRESHOLD"), "stale diagnostic missing");
  const delta = createConstraintLegacyParallelDeltaReport({ events: eventSources, decision: eventDecision });
  assert(delta.report.summary.totalEventsWithLegacyWrite === 3, "wrong legacy delta total");
  assert(delta.report.summary.mismatchedOutcomes === 1, "legacy mismatch not counted");
  assert(delta.report.summary.eventOnlySignals === 1, "event-only signal not counted");
  assert(delta.diagnostics.some((diagnostic) => diagnostic.code === "SC_LEGACY_PARALLEL_DELTA"), "legacy delta diagnostic missing");
});

check("prompt builder is deterministic and shadow-only", () => {
  const prompt = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  const again = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(prompt.promptHash === again.promptHash, "prompt hash drifted");
  assert(prompt.text.includes("shadow-only"), "shadow-only instruction missing");
  assert(prompt.text.includes("Return JSON only"), "JSON-only instruction missing");
  assert(prompt.text.includes("Never include mutation-key fields"), "mutation-key instruction missing");
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
  assert(!parsed.ok && parsed.rawOutput === "not-json", "raw output missing on parse failure");
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

check("shadow runner reads L1 events and writes event coverage artifacts", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-runner-events-"));
  const writeRule = (rel, frontmatter, body) => writeFile(path.join(abrainHome, rel), `---\n${frontmatter}\n---\n${body}\n`);
  writeRule("rules/always/use-edit-not-sed.md", "title: Use edit not sed\nstatus: active\nkind: preference", "# Use edit not sed\n\n修改文件必须用 edit/write，禁止 sed -i。");
  const event = writeConstraintEvidenceEvent(abrainHome, {
    session_id: "runner-session",
    turn_id: "runner-turn",
    legacy_parallel_write: { attempted: true, legacy_path_kind: "tier1_ruleset_adjudicator", legacy_operation_hint: "create", legacy_audit_ref: "audit:runner" },
  });
  const eventSourceId = `event:${event.event_id}`;
  const result = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    knownProjectIds: ["pi-astack"],
    writeArtifacts: true,
    runId: "fixture-event-run",
    nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    compilerInvoker: async ({ prompt }) => {
      assert(prompt.text.includes(eventSourceId), "event source missing from compiler prompt");
      return {
        ok: true,
        text: JSON.stringify({
          schemaVersion: "constraint-shadow-decision/v1",
          inputRootHash: "ignored-by-parser",
          constraints: [{
            scope: { kind: "global" },
            injectMode: "always",
            title: "Use edit/write",
            compiledBody: "修改文件必须用 edit/write，禁止 sed -i。",
            sourceRecordIds: ["rule:global:always:use-edit-not-sed", eventSourceId],
          }],
          exclusions: [],
          unresolved: [],
          merges: [],
          rescopeProposals: [],
          mappings: [
            { sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" },
            { sourceRecordId: eventSourceId, disposition: "compiled" },
          ],
          diagnostics: [],
        }),
      };
    },
  });
  assert(result.ok, "runner event success path failed");
  assert(result.ok && result.eventCoverage?.summary.projectedEvents === 1, "event coverage did not project event");
  assert(result.ok && result.legacyParallelDelta?.summary.matchedOutcomes === 1, "legacy delta did not match event");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "event-coverage.json")), "event coverage artifact missing");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "legacy-parallel-delta.json")), "legacy delta artifact missing");
});

check("repo-mode 固化s decision to immutable L1 + renders deterministic git L2 (round-trip + idempotent); state-mode is a no-op (ADR0039 NS-2/FIX-1)", async () => {
  const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "constraint-l2-"));
  const writeRule = (home, rel, fm, body) => writeFile(path.join(home, rel), `---\n${fm}\n---\n${body}\n`);
  const decisionText = JSON.stringify({
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: "ignored-by-parser",
    constraints: [{
      scope: { kind: "global" }, injectMode: "always",
      title: "Use edit/write", compiledBody: "修改文件必须用 edit/write，禁止 sed -i。",
      sourceRecordIds: ["rule:global:always:use-edit-not-sed"],
    }],
    exclusions: [], unresolved: [], merges: [], rescopeProposals: [],
    mappings: [{ sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" }],
    diagnostics: [],
  });
  const invoker = async () => ({ ok: true, text: decisionText });
  const runOpts = (home, l2OutputRoot) => ({
    abrainHome: home, cwd: repoRoot, includeProjects: [], includeStatuses: "all",
    knownProjectIds: ["pi-astack"], writeArtifacts: true, runId: "l2-run",
    nowMs: Date.parse("2026-06-19T00:00:00.000Z"), deviceId: "test-device",
    l2OutputRoot, compilerInvoker: invoker,
  });
  const rule = ["title: Use edit not sed\nstatus: active\nkind: preference", "# Use edit not sed\n\n修改文件必须用 edit/write，禁止 sed -i。"];

  // --- repo mode: 固化 + L2 ---
  const home = mkHome();
  writeRule(home, "rules/always/use-edit-not-sed.md", rule[0], rule[1]);
  const r1 = await runConstraintShadowCompiler(runOpts(home, "repo"));
  assert(r1.ok, "repo-mode run failed");
  assert(r1.l2Projection && r1.l2Projection.status === "written", `expected l2 written, got ${r1.l2Projection && r1.l2Projection.status}`);
  const eventId = r1.l2Projection.eventId;
  const l2Path = path.join(home, "l2", "views", "constraint", "latest", "compiled-view.md");
  assert(fs.existsSync(l2Path), "L2 compiled-view.md missing");
  const l2 = fs.readFileSync(l2Path, "utf8");
  assert(l2.includes(`sediment_projection_event_id: ${eventId}\n`), "L2 missing projection event id");
  assert(l2.includes("shadow_only: false\n"), "L2 not marked non-shadow");
  // 固化 L1 event exists with the DISTINCT projection envelope schema
  const l1Path = constraintEvidenceEventPath(home, eventId);
  assert(fs.existsSync(l1Path), "固化 L1 projection event missing");
  const envelope = JSON.parse(fs.readFileSync(l1Path, "utf8"));
  assert(envelope.schema === CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION, "固化 event has wrong envelope schema");
  assert(envelope.event_id === eventId && envelope.body_hash === eventId, "固化 event id/body_hash mismatch");
  // FIX-1 round-trip: re-render from 固化 validated_decision → byte-identical to committed L2
  const reRender = renderConstraintL2View(envelope.body.validated_decision, eventId);
  assert(reRender.markdown === l2, "reconcile re-render is NOT byte-identical to committed L2 (round-trip broken)");
  // NS-2: event-scan must NOT ingest the 固化 event as input, nor mark it invalid
  const scan = await scanConstraintEvidenceEvents({ abrainHome: home });
  assert(!scan.invalidEventIds.includes(eventId), "固化 projection event wrongly marked invalid by constraint scan");
  assert(!scan.events.some((e) => e.eventId === eventId), "固化 projection event wrongly admitted as constraint input (feedback loop)");
  // idempotency: re-run with same decision → unchanged, no churn
  const r2 = await runConstraintShadowCompiler(runOpts(home, "repo"));
  assert(r2.ok && r2.l2Projection && r2.l2Projection.status === "unchanged", `expected unchanged on re-run, got ${r2.ok && r2.l2Projection && r2.l2Projection.status}`);
  assert(fs.readFileSync(l2Path, "utf8") === l2, "L2 changed on idempotent re-run");

  // --- state mode (default): zero behavior change, no 固化, no l2/ ---
  const home2 = mkHome();
  writeRule(home2, "rules/always/use-edit-not-sed.md", rule[0], rule[1]);
  const s1 = await runConstraintShadowCompiler(runOpts(home2, "state"));
  assert(s1.ok, "state-mode run failed");
  assert(!s1.l2Projection, "state-mode must not 固化/produce l2Projection");
  assert(!fs.existsSync(path.join(home2, "l2")), "state-mode wrote an l2/ tree");
  assert(fs.existsSync(path.join(home2, ".state", "sediment", "constraint-shadow", "latest", "compiled-view.md")), "state-mode .state bundle missing");
});

check("selectLatestConstraintProjectionEventId: created_at desc, tiebreak event_id desc (4×T0 v3 bundle-a)", () => {
  assert(selectLatestConstraintProjectionEventId([]) === null, "empty -> null");
  assert(selectLatestConstraintProjectionEventId([
    { eventId: "aaa", createdAtUtc: "2026-01-01T00:00:00.000Z" },
    { eventId: "ccc", createdAtUtc: "2026-06-01T00:00:00.000Z" },
    { eventId: "bbb", createdAtUtc: "2026-03-01T00:00:00.000Z" },
  ]) === "ccc", "latest by created_at_utc desc");
  assert(selectLatestConstraintProjectionEventId([
    { eventId: "aaa", createdAtUtc: "2026-06-01T00:00:00.000Z" },
    { eventId: "zzz", createdAtUtc: "2026-06-01T00:00:00.000Z" },
  ]) === "zzz", "tiebreak event_id desc on created_at collision");
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

check("shadow runner quarantines semantic item validation failures", async () => {
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
  assert(result.ok, "semantic item failure should not fail the whole shadow run");
  assert(result.decision.constraints.length === 0, "empty-body constraint entered compiled view");
  assert(result.decision.unresolved.some((item) => item.sourceRecordIds.includes("rule:global:always:use-edit-not-sed") && item.reason === "model_uncertain"), "semantic item was not quarantined to unresolved");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "SC_COMPILER_ITEM_REJECTED"), "item rejection diagnostic missing");
});

check("shadow runner writes raw and parsed artifacts on compiler failures", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-fail-artifacts-"));
  writeFile(path.join(abrainHome, "rules/always/use-edit-not-sed.md"), "---\ntitle: Use edit not sed\nstatus: active\nkind: preference\n---\n# Use edit not sed\n\n修改文件必须用 edit/write。\n");
  const sourceId = "rule:global:always:use-edit-not-sed";
  const parsedFailure = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    writeArtifacts: true,
    runId: "validation-failure-run",
    compilerInvoker: async () => ({
      ok: true,
      text: JSON.stringify({
        schemaVersion: "constraint-shadow-decision/v1",
        inputRootHash: "ignored-by-parser",
        constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit", compiledBody: "修改文件必须用 edit/write。", sourceRecordIds: [sourceId] }],
        exclusions: [],
        unresolved: [],
        merges: [],
        rescopeProposals: [],
        mappings: [{ sourceRecordId: "missing-source", disposition: "compiled" }],
        diagnostics: [],
      }),
    }),
  });
  assert(!parsedFailure.ok, "validation failure accepted");
  assert(parsedFailure.diagnostics.some((diagnostic) => diagnostic.code === "SC_COMPILER_VALIDATION_FAILED"), "validation failure diagnostic missing");
  const validationRunDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "validation-failure-run");
  assert(fs.existsSync(path.join(validationRunDir, "raw-output.txt")), "validation failure raw-output.txt missing");
  assert(fs.existsSync(path.join(validationRunDir, "parsed-decision.json")), "validation failure parsed-decision.json missing");
  const parsedDecision = JSON.parse(fs.readFileSync(path.join(validationRunDir, "parsed-decision.json"), "utf8"));
  assert(parsedDecision.mappings[0].sourceRecordId === "missing-source", "parsed decision did not preserve failed mapping");

  const parseFailure = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    writeArtifacts: true,
    runId: "parse-failure-run",
    compilerInvoker: async () => ({ ok: true, text: "not-json" }),
  });
  assert(!parseFailure.ok, "parse failure accepted");
  const parseRunDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "parse-failure-run");
  assert(fs.readFileSync(path.join(parseRunDir, "raw-output.txt"), "utf8").includes("not-json"), "parse failure raw output missing content");
  assert(!fs.existsSync(path.join(parseRunDir, "parsed-decision.json")), "parse failure should not write parsed decision");
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
  console.log(`\nall ok — constraint shadow compiler PR2/PR3/PR4/PR6 holds (${total} assertions).`);
});
