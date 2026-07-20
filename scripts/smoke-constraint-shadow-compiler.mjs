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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(name, fn, timeoutMs = 10_000, intervalMs = 50) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${name}`);
}
let autoRefreshSmokeChain = Promise.resolve();
function checkAutoRefresh(name, fn) {
  check(name, () => {
    const next = autoRefreshSmokeChain.then(fn);
    autoRefreshSmokeChain = next.catch(() => undefined);
    return next;
  });
}
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function setHomeEnv(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}
function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
function readJsonlRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
  "extensions/_shared/durable-write.ts",
  "extensions/_shared/canonical-l2-contract.ts",
  "extensions/_shared/jcs.ts",
  "extensions/_shared/proposition.ts",
  "extensions/_shared/l1-schema-registry.ts",
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
  "extensions/sediment/constraint-compiler/merged-source-verifier.ts",
  "extensions/sediment/constraint-compiler/merged-source-verifier-prompt.ts",
  "extensions/sediment/constraint-compiler/merged-source-verifier-llm.ts",
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
  "extensions/sediment/constraint-compiler/auto-refresh.ts",
]) {
  stageTs(outRoot, file);
}
fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));
writeFile(path.join(outRoot, "_shared", "llm-audit.js"), `
exports.lastAuditMeta = null;
exports.auditStreamSimple = async function auditStreamSimple(_projectRoot, meta, piAi, model, opts, config) {
  exports.lastAuditMeta = meta;
  return piAi.streamSimple(model, opts, config).result();
};
`);

writeFile(path.join(outRoot, "node_modules", "@earendil-works", "pi-ai", "compat.js"), `
const defaultDecisionText = JSON.stringify({
  schemaVersion: "constraint-shadow-decision/v1",
  inputRootHash: "ignored-by-parser",
  constraints: [],
  exclusions: [],
  unresolved: [],
  merges: [],
  rescopeProposals: [],
  mappings: [],
  diagnostics: [],
});
exports.streamSimple = function streamSimple() {
  return {
    result: async function result() {
      globalThis.__constraintShadowSmokePiAiCallCount = (globalThis.__constraintShadowSmokePiAiCallCount || 0) + 1;
      const delays = globalThis.__constraintShadowSmokePiAiDelaysMs;
      const delayMs = Array.isArray(delays) ? (delays.shift() || 0) : (globalThis.__constraintShadowSmokePiAiDelayMs || 0);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: "text", text: globalThis.__constraintShadowSmokePiAiText || defaultDecisionText }] };
    },
  };
};
`);

// Stub writer module for auto-refresh (commitAbrainDerivedOutputs is best-effort, not needed in smoke)
writeFile(path.join(outRoot, "sediment", "writer.js"), `
exports.commitAbrainDerivedOutputs = async () => null;
`);
writeFile(path.join(outRoot, "_shared", "canonical-mutation-barrier.js"), `
exports.withCanonicalMutationBarrier = async (_repo, operation) => operation();
`);
writeFile(path.join(outRoot, "_shared", "canonical-git-runtime.js"), `
exports.canonicalGitRuntimeEnabled = () => false;
exports.getCanonicalStartupPromise = async () => ({ startup: "ready" });
`);

// Stub causal-anchor for auto-refresh (getDeviceId)
writeFile(path.join(outRoot, "_shared", "causal-anchor.js"), `
exports.getDeviceId = () => "smoke-device";
exports.getCurrentAnchor = () => null;
exports.runWithTriggerAnchor = (fn) => fn();
`);

const { makeDiagnostic, assertDiagnosticConsumers } = require(path.join(outRoot, "sediment", "constraint-compiler", "diagnostics.js"));
const { createConstraintEvidenceEnvelope, constraintEvidenceEventPath } = require(path.join(outRoot, "sediment", "constraint-evidence", "hash-envelope.js"));
const { normalizeConstraintSources, sha256Hex } = require(path.join(outRoot, "sediment", "constraint-compiler", "normalize.js"));
const { scanLegacyConstraintSources } = require(path.join(outRoot, "sediment", "constraint-compiler", "legacy-scan.js"));
const { validateConstraintCompilerDecision } = require(path.join(outRoot, "sediment", "constraint-compiler", "validate-decision.js"));
const { renderConstraintShadowView } = require(path.join(outRoot, "sediment", "constraint-compiler", "render.js"));
const { createConstraintDiffReport } = require(path.join(outRoot, "sediment", "constraint-compiler", "diff.js"));
const { scanConstraintEvidenceEvents } = require(path.join(outRoot, "sediment", "constraint-compiler", "event-scan.js"));
const { createConstraintEventCoverageReport, createConstraintLegacyParallelDeltaReport } = require(path.join(outRoot, "sediment", "constraint-compiler", "event-report.js"));
const { buildMergedSourceVerifierInputRows, buildMergedSourceVerifierLookup, createMergedSourceVerifierReport, mergedSourceVerifierDecisionHash, mergedSourceVerifierInputHash, targetContentHashForConstraint } = require(path.join(outRoot, "sediment", "constraint-compiler", "merged-source-verifier.js"));
const { buildMergedSourceVerifierPrompt } = require(path.join(outRoot, "sediment", "constraint-compiler", "merged-source-verifier-prompt.js"));
const { parseMergedSourceVerifierOutput, runMergedSourceVerifierWithInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "merged-source-verifier-llm.js"));
const { buildConstraintCompilerPrompt } = require(path.join(outRoot, "sediment", "constraint-compiler", "prompt.js"));
const { parseConstraintCompilerDecision, runConstraintCompilerWithInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "llm-compiler.js"));
const { createPiAiConstraintCompilerInvoker, createPiAiMergedSourceVerifierInvoker } = require(path.join(outRoot, "sediment", "constraint-compiler", "pi-ai-invoker.js"));
const { runConstraintShadowCompiler } = require(path.join(outRoot, "sediment", "constraint-compiler", "shadow-runner.js"));
const { scheduleConstraintShadowAutoRefresh, _runConstraintShadowAutoRefreshNowForTests, _resetConstraintShadowAutoRefreshForTests } = require(path.join(outRoot, "sediment", "constraint-compiler", "auto-refresh.js"));
const { acquireFileLock, abrainSedimentLocksDir } = require(path.join(outRoot, "_shared", "runtime.js"));
const { CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION, selectLatestConstraintProjectionEventId } = require(path.join(outRoot, "sediment", "constraint-compiler", "projection.js"));
const { renderConstraintL2View } = require(path.join(outRoot, "sediment", "constraint-compiler", "render.js"));
const { buildCorpusSplitReport, stratumForRow, CORPUS_SPLIT_STRATA } = require(path.join(outRoot, "sediment", "constraint-compiler", "corpus-split.js"));

function resolveSedimentSettingsWithConfig(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-settings-home-"));
  writeFile(path.join(home, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify(config));
  const settingsPath = path.join(outRoot, "sediment", "settings.js");
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  delete require.cache[require.resolve(settingsPath)];
  setHomeEnv(home);
  try {
    return require(settingsPath).resolveSedimentSettings();
  } finally {
    restoreEnv("HOME", oldHome);
    restoreEnv("USERPROFILE", oldUserProfile);
    delete require.cache[require.resolve(settingsPath)];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

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

function eventSource(overrides) {
  const eventId = overrides.eventId ?? overrides.sourceId?.replace(/^event:/, "") ?? sha256Hex(overrides.candidateText ?? "event");
  const sourceId = overrides.sourceId ?? `event:${eventId}`;
  const candidateText = overrides.candidateText ?? "全局规则：以后我说T0审查，那就是要求T0们进行盲审。";
  return {
    sourceKind: "constraint_event",
    sourceId,
    eventId,
    eventType: overrides.eventType ?? "constraint_signal_observed",
    createdAtUtc: overrides.createdAtUtc ?? "2026-06-19T00:00:00.000Z",
    sessionId: overrides.sessionId ?? "session",
    turnId: overrides.turnId ?? "turn",
    sourceChannel: overrides.sourceChannel ?? "agent_end",
    sourceRole: overrides.sourceRole ?? "user",
    operationHint: overrides.operationHint ?? "create",
    confidence: overrides.confidence ?? 0.8,
    sanitizedQuote: overrides.sanitizedQuote ?? candidateText,
    candidateText,
    candidateTitle: overrides.candidateTitle ?? candidateText,
    candidateTriggerPhrases: overrides.candidateTriggerPhrases ?? [candidateText],
    candidatePriorityHint: overrides.candidatePriorityHint ?? "always",
    scopeHint: overrides.scopeHint ?? { kind: "global", evidence: "fixture" },
    activeProjectId: overrides.activeProjectId ?? "pi-astack",
    scopeConfidence: overrides.scopeConfidence ?? 0.8,
    sanitizerStatus: overrides.sanitizerStatus ?? "passed",
    sanitizerReplacementsCount: overrides.sanitizerReplacementsCount ?? 0,
    legacyParallelWrite: overrides.legacyParallelWrite ?? { attempted: true, legacy_operation_hint: "create" },
    causalParents: overrides.causalParents ?? [],
    producerName: overrides.producerName ?? "sediment.constraint-event-writer",
    producerVersion: overrides.producerVersion ?? "fixture",
    bodyHash: overrides.bodyHash ?? eventId,
    rawFilePath: overrides.rawFilePath ?? `/tmp/${eventId}.json`,
    sourceRef: overrides.sourceRef ?? { ref: sourceId, path: overrides.rawFilePath ?? `/tmp/${eventId}.json` },
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
  sourceId: "rule:global:listed:tool-declaration",
  slug: "tool-declaration",
  injectMode: "listed",
  title: "Tool declaration",
  body: "dispatch_parallel must follow the tool declaration and worker limit.",
  triggerPhrases: ["dispatch_parallel", "tool declaration"],
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
const unicodeEncodingSource = source({
  sourceId: "rule:global:always:literal-utf8-output",
  slug: "literal-utf8-output",
  title: "Literal UTF-8 output",
  body: "写配置/config、code、bash 和 string literal 输出时，禁止输出 \\u 转义；必须直接书写 literal UTF-8 Unicode 字符。",
  triggerPhrases: ["no \\u", "literal UTF-8"],
});
const runtimeKillSwitchSource = source({
  sourceId: "rule:global:always:runtime-kill-switch-human-required",
  slug: "runtime-kill-switch-human-required",
  title: "Runtime kill-switch setting",
  body: "runtime-kill-switch 配置必须保持 human_required，不能自动改成行为规则。",
  triggerPhrases: ["runtime-kill-switch", "human_required"],
});
const plainUtf8SettingsSource = source({
  sourceId: "rule:global:always:provider-model-settings-json-utf8",
  slug: "provider-model-settings-json-utf8",
  title: "Provider model settings JSON",
  body: "Provider/model settings JSON must be UTF-8 and must live in configuration, not memory.",
  triggerPhrases: ["provider", "model", "settings JSON", "UTF-8"],
});
const dispatchHubModelSelectionSource = source({
  sourceId: "rule:global:always:dispatch-hub-model-selection-by-main-session",
  slug: "dispatch-hub-model-selection-by-main-session",
  title: "Dispatch hub model selection",
  body: "dispatch_hub model choice must be made by the main session per task; do not hard-code provider/model IDs in settings wiring.",
  triggerPhrases: ["dispatch_hub", "model choice", "per task"],
});
const businessModelIdsFailClosedSource = source({
  sourceId: "rule:global:always:business-model-ids-settings-not-code-fail-closed",
  slug: "business-model-ids-settings-not-code-fail-closed",
  title: "Business model IDs fail closed",
  body: "Business model IDs belong in settings, not code; when a required business model ID is missing, fail closed instead of falling back to an arbitrary provider/model.",
  triggerPhrases: ["business model IDs", "settings not code", "fail closed"],
});
const newestVendorRollbackSource = source({
  sourceId: "rule:global:always:prefer-newest-vendor-model-old-as-rollback",
  slug: "prefer-newest-vendor-model-old-as-rollback",
  title: "Prefer newest vendor model",
  body: "Prefer the newest vendor model for business routes and keep the old provider model only as rollback, including when updating model tier settings.",
  triggerPhrases: ["newest vendor model", "old as rollback"],
});
const restartDisclosureSettingsWiringSource = source({
  sourceId: "rule:global:listed:restart-disclosure-after-each-settings-step",
  slug: "restart-disclosure-after-each-settings-step",
  injectMode: "listed",
  title: "Restart disclosure after each settings step",
  body: "After each step that changes settings wiring or requires restart/refresh, disclose the restart requirement at completion.",
  triggerPhrases: ["restart disclosure", "settings wiring", "after each step"],
});
const l2HumanViewSource = source({
  sourceId: "rule:global:listed:l2-not-user-managed-popup-only-on-write",
  slug: "l2-not-user-managed-popup-only-on-write",
  injectMode: "listed",
  title: "L2 Markdown human views are read-only",
  body: "L2 Markdown human views are read-only derived views of memory/knowledge state. They are not user-managed; show a popup/write confirmation only when writing or updating the derived view.",
  triggerPhrases: ["L2 Markdown", "human views", "write confirmation"],
  appliesWhen: "rendering or updating L2 Markdown human views",
  mustDoSummary: "Treat L2 Markdown human views as read-only derived views; popup confirmation only on write.",
});
const sub2apiSemanticReviewSource = source({
  sourceId: "rule:project:sub2api:always:semantic-review-required",
  slug: "semantic-review-required",
  scope: { kind: "project", projectId: "sub2api" },
  title: "semantic_review_required gate",
  body: "semantic_review_required: only business logic changes should drive semantic review; non-business changes alone should not drive semantic review.",
  triggerPhrases: ["semantic_review_required", "business logic changes"],
  appliesWhen: "sub2api review decisions",
  mustDoSummary: "Set semantic_review_required only for business logic changes.",
});
const legacyNoRetroactiveRewriteSource = source({
  sourceId: "rule:global:always:legacy-no-retroactive-rewrite",
  slug: "legacy-no-retroactive-rewrite",
  title: "Legacy docs no retroactive rewrite",
  body: "旧文档不追溯重写。",
  triggerPhrases: ["旧文档", "不追溯重写"],
  mustDoSummary: "旧文档不追溯重写。",
});
const truncatedNativeGitSource = source({
  sourceId: "rule:global:always:all-github-repositories-gh-native-git-truncated",
  slug: "all-github-repositories-gh-native-git-truncated",
  title: "All GitHub repositories must use gh. Native git operatio",
  body: "所有 GitHub 仓库必须使用 gh 工具进行管理",
  triggerPhrases: ["GitHub", "gh"],
  mustDoSummary: "所有 GitHub 仓库必须使用 gh 工具进行管理",
});
const truncatedDataMigrationSource = source({
  sourceId: "rule:global:always:oauth-data-migrati-truncated",
  slug: "oauth-data-migrati-truncated",
  title: "Retirement review source / OAuth/data migrati",
  body: "Retirement review must preserve visible source snippets exactly.",
  triggerPhrases: ["retirement review", "OAuth", "data migrati"],
  mustDoSummary: "Preserve visible source snippets exactly.",
});
const docDriftSeveritySource = source({
  sourceId: "rule:project:pi-astack:always:doc-drift-severity-order",
  slug: "doc-drift-severity-order",
  scope: { kind: "project", projectId: "pi-astack" },
  title: "Doc drift severity order",
  body: "Charter document staleness is the highest-severity doc drift signal; README/charter read first has higher drift severity than subordinate documents; cross-check roadmap/changelog/git log/artifacts.",
  triggerPhrases: ["doc drift", "highest-severity", "higher drift severity"],
  appliesWhen: "document drift checks",
  mustDoSummary: "Treat charter staleness as the highest-severity doc drift signal and read README/charter first.",
});
const piGlobalPrivateRepoTrackingSource = source({
  sourceId: "rule:project:pi-global:always:track-private-config-files",
  slug: "track-private-config-files",
  scope: { kind: "project", projectId: "pi-global" },
  title: "Track private repo config files",
  body: "In the pi-global private repository, user wants secrets.json and agent/models.json to be tracked in git despite normal secret-gitignore norms.",
  triggerPhrases: ["pi-global", "secrets.json", "agent/models.json", "tracked in git"],
  appliesWhen: "pi-global private repository git tracking decisions",
  mustDoSummary: "Track secrets.json and agent/models.json in git for pi-global.",
});
const jargonAlwaysSource = source({
  sourceId: "rule:global:always:professional-vocabulary-hard-blocker",
  slug: "professional-vocabulary-hard-blocker",
  title: "Professional vocabulary hard blocker",
  body: "Never use jargon; use precise professional vocabulary instead.",
});
const jargonListedPredecessor = source({
  sourceId: "rule:global:listed:professional-vocabulary-predecessor",
  slug: "professional-vocabulary-predecessor",
  injectMode: "listed",
  status: "superseded",
  title: "Professional vocabulary predecessor",
  body: "Avoid jargon and prefer professional vocabulary.",
});
const restartDisclosureLegacySource = source({
  sourceId: "rule:global:listed:restart-disclosure-is-a-standing-completion-requirement",
  slug: "restart-disclosure-is-a-standing-completion-requirement",
  injectMode: "listed",
  title: "Restart disclosure standing completion requirement",
  body: "Always disclose required restarts at completion; this is a standing completion requirement.",
  provenance: "assistant-observed",
  confidence: 2,
  triggerPhrases: ["restart disclosure", "standing completion requirement"],
  appliesWhen: "completion responses after changes that require restart or refresh",
  mustDoSummary: "Disclose required restarts at completion.",
});
const restartDisclosureOverlapEvent = eventSource({
  sourceId: "event:pi-global-restart-disclosure-overlap",
  eventId: "pi-global-restart-disclosure-overlap",
  candidateText: "When changes require restart or refresh, disclose the requirement at completion.",
  candidateTitle: "Restart or refresh disclosure",
  candidateTriggerPhrases: ["restart", "refresh", "completion"],
  candidatePriorityHint: "always",
  confidence: 0.95,
  sourceChannel: "manual",
  sourceRole: "user",
  scopeHint: { kind: "global", evidence: "fixture pi-global event" },
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

check("normalize keeps no-u/literal UTF-8 output rules behavioral", () => {
  const result = normalizeConstraintSources([unicodeEncodingSource], { knownProjectIds: ["pi-astack"] });
  const record = result.records.find((item) => item.sourceId === unicodeEncodingSource.sourceId);
  assert(record && record.categoryHint !== "settings_not_memory", `unicode output rule misclassified: ${record && record.categoryHint}`);
  assert(record && record.categoryHint === "behavioral_constraint", `unicode output rule was not behavioral: ${record && record.categoryHint}`);
  assert(!result.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(unicodeEncodingSource.sourceId)), "unicode output rule emitted SC_NOT_MEMORY_SETTINGS");
});

check("normalize keeps runtime-kill-switch on settings-like path", () => {
  const result = normalizeConstraintSources([runtimeKillSwitchSource], { knownProjectIds: ["pi-astack"] });
  const record = result.records.find((item) => item.sourceId === runtimeKillSwitchSource.sourceId);
  assert(record && record.categoryHint === "settings_not_memory", `runtime kill-switch hint changed: ${record && record.categoryHint}`);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(runtimeKillSwitchSource.sourceId)), "runtime kill-switch settings diagnostic missing");
});

check("normalize leaves plain UTF-8 provider/model settings JSON as settings", () => {
  const result = normalizeConstraintSources([plainUtf8SettingsSource], { knownProjectIds: ["pi-astack"] });
  const record = result.records.find((item) => item.sourceId === plainUtf8SettingsSource.sourceId);
  assert(record && record.categoryHint === "settings_not_memory", `plain UTF-8 settings fact misclassified: ${record && record.categoryHint}`);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(plainUtf8SettingsSource.sourceId)), "plain UTF-8 settings diagnostic missing");
});

check("normalize keeps settings-word behavioral governance rules behavioral", () => {
  const sources = [
    dispatchHubModelSelectionSource,
    businessModelIdsFailClosedSource,
    newestVendorRollbackSource,
    restartDisclosureSettingsWiringSource,
  ];
  const result = normalizeConstraintSources(sources, { knownProjectIds: ["pi-astack"] });
  for (const sourceItem of sources) {
    const record = result.records.find((item) => item.sourceId === sourceItem.sourceId);
    assert(record && record.categoryHint === "behavioral_constraint", `${sourceItem.sourceId} misclassified: ${record && record.categoryHint}`);
    assert(!result.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(sourceItem.sourceId)), `${sourceItem.sourceId} emitted SC_NOT_MEMORY_SETTINGS`);
  }
});

check("normalize keeps L2 read-only human-view write-confirmation rule behavioral", () => {
  const result = normalizeConstraintSources([l2HumanViewSource], { knownProjectIds: ["pi-astack"] });
  const record = result.records.find((item) => item.sourceId === l2HumanViewSource.sourceId);
  assert(record && record.categoryHint === "behavioral_constraint", `L2 human-view rule misclassified: ${record && record.categoryHint}`);
  assert(record && record.categoryHint !== "knowledge_not_constraint", "L2 human-view rule normalized as knowledge_not_constraint");
  assert(!result.diagnostics.some((diagnostic) => JSON.stringify(diagnostic).includes("knowledge_not_constraint")), "L2 human-view rule emitted knowledge_not_constraint diagnostic");
});

check("validator accepts compiled L2 read-only human-view write-confirmation rule", () => {
  const sources = [l2HumanViewSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "listed",
      title: "L2 Markdown human views are read-only",
      compiledBody: "Treat L2 Markdown human views as read-only derived views; show popup/write confirmation only on write.",
      sourceRecordIds: [l2HumanViewSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: l2HumanViewSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(l2HumanViewSource.sourceId)), "compiled L2 human-view rule missing");
  assert(!validated.unresolved.length, "compiled L2 human-view rule produced unresolved items");
});

check("validator allows user-request exception wording without semantic regex hard-fail", () => {
  const sources = [legacyNoRetroactiveRewriteSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Legacy docs no retroactive rewrite",
      compiledBody: "旧文档不追溯重写，unless the user asks.",
      sourceRecordIds: [legacyNoRetroactiveRewriteSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: legacyNoRetroactiveRewriteSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(legacyNoRetroactiveRewriteSource.sourceId)), "user-request wording was not compiled");
});

check("validator allows alternate-trigger wording without semantic regex hard-fail", () => {
  const sources = [sub2apiSemanticReviewSource];
  const localNormalized = normalizeConstraintSources(sources, { knownProjectIds: ["sub2api"] });
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "project", projectId: "sub2api" },
      injectMode: "always",
      title: "semantic_review_required gate",
      compiledBody: "Set semantic_review_required only for business logic changes, unless the source explicitly provides another trigger.",
      sourceRecordIds: [sub2apiSemanticReviewSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: sub2apiSemanticReviewSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  }, { knownProjectIds: ["sub2api"] });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(sub2apiSemanticReviewSource.sourceId)), "alternate-trigger wording was not compiled");
});

check("validator allows complete native-git wording from truncated legacy source without hard-fail", () => {
  const sources = [truncatedNativeGitSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "GitHub repositories use gh",
      compiledBody: "Native git operations remain separate from GitHub management operations.",
      sourceRecordIds: [truncatedNativeGitSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: truncatedNativeGitSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(truncatedNativeGitSource.sourceId)), "native-git wording was not compiled");
});

check("validator allows complete data migration wording from truncated legacy source without hard-fail", () => {
  const sources = [truncatedDataMigrationSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Retirement review source preservation",
      compiledBody: "Retirement review must preserve visible source snippets exactly, including OAuth/data migration.",
      sourceRecordIds: [truncatedDataMigrationSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: truncatedDataMigrationSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(truncatedDataMigrationSource.sourceId)), "data migration wording was not compiled");
});

check("validator allows raw data migrati fragment without semantic regex hard-fail", () => {
  const sources = [truncatedDataMigrationSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Retirement review source preservation",
      compiledBody: "Retirement review must preserve visible source snippets exactly; OAuth/data migrati) may trigger follow-up review.",
      sourceRecordIds: [truncatedDataMigrationSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: truncatedDataMigrationSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(truncatedDataMigrationSource.sourceId)), "raw truncated wording was not compiled");
});

check("validator accepts no-retroactive-rewrite rule without invented exception", () => {
  const sources = [legacyNoRetroactiveRewriteSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Legacy docs no retroactive rewrite",
      compiledBody: "旧文档不追溯重写。",
      sourceRecordIds: [legacyNoRetroactiveRewriteSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: legacyNoRetroactiveRewriteSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(legacyNoRetroactiveRewriteSource.sourceId)), "legal no-retroactive-rewrite rule was not compiled");
  assert(!validated.unresolved.some((item) => item.sourceRecordIds.includes(legacyNoRetroactiveRewriteSource.sourceId)), "legal no-retroactive-rewrite rule was quarantined");
});

check("validator quarantines bad compiled+excluded L2 human-view multi-home decision", () => {
  const sources = [l2HumanViewSource];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "listed",
      title: "L2 Markdown human views are read-only",
      compiledBody: "Treat L2 Markdown human views as read-only derived views; show popup/write confirmation only on write.",
      sourceRecordIds: [l2HumanViewSource.sourceId],
    }],
    exclusions: [{ reason: "knowledge_candidate", sourceRecordIds: [l2HumanViewSource.sourceId], note: "bad classifier output" }],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: l2HumanViewSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  assert(!validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(l2HumanViewSource.sourceId)), "bad L2 multi-home decision remained compiled");
  assert(!validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(l2HumanViewSource.sourceId)), "bad L2 multi-home decision remained excluded");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(l2HumanViewSource.sourceId) && item.reason === "conflict"), "bad L2 multi-home decision was not quarantined to conflict");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_SOURCE_MULTI_HOME_QUARANTINED" && diagnostic.sourceRecordIds.includes(l2HumanViewSource.sourceId)), "bad L2 multi-home quarantine diagnostic missing");
});

check("validator accepts complete fixture decision", () => {
  const validated = validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"], expectedInputRootHash: normalized.inputRootHash });
  assert(validated.constraints.every((constraint) => constraint.constraintId.startsWith("shadow:")), "constraint ids not derived");
});

check("validator: requireEventCompleteness rejects an undispositioned event (graceful by default)", () => {
  // An in-corpus constraint_event the decision never dispositions.
  const orphanId = "event:" + "c".repeat(64);
  const orphan = { sourceKind: "constraint_event", sourceId: orphanId, eventId: "c".repeat(64) };
  const sourcesWithOrphan = [...allSources, orphan];
  // Default (queued/stale model): an in-corpus event the decision did not
  // disposition is tolerated -> no throw. This is the cached-decision/preflight
  // graceful path that must stay intact.
  let threwDefault = false;
  try { validateConstraintCompilerDecision(sourcesWithOrphan, decision, { knownProjectIds: ["pi-astack"] }); } catch { threwDefault = true; }
  assert(!threwDefault, "default validation must tolerate an undispositioned event (graceful queued/stale)");
  // Fresh compile: every in-scope event MUST be dispositioned -> throw naming the
  // uncovered event so the shadow-runner B loop can re-prompt the model with it.
  let msg = "";
  try { validateConstraintCompilerDecision(sourcesWithOrphan, decision, { knownProjectIds: ["pi-astack"], requireEventCompleteness: true }); } catch (err) { msg = String((err && err.message) || err); }
  assert(msg.includes("no primary disposition") && msg.includes(orphanId), "requireEventCompleteness must throw naming the uncovered event for retry re-prompt: " + msg);
});

check("validator: requireEventCompleteness rejects unresolved-only all-source batch", () => {
  const freshSources = [
    eventSource({ sourceId: "event:unresolved-batch-one", eventId: "unresolved-batch-one", candidateText: "First fresh event must be compiled or excluded." }),
    eventSource({ sourceId: "event:unresolved-batch-two", eventId: "unresolved-batch-two", candidateText: "Second fresh event must be compiled or excluded." }),
  ];
  const localNormalized = normalizeConstraintSources(freshSources);
  const sourceRecordIds = freshSources.map((item) => item.sourceId);
  let msg = "";
  try {
    validateConstraintCompilerDecision(freshSources, {
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash: localNormalized.inputRootHash,
      constraints: [],
      exclusions: [],
      unresolved: [{
        reason: "model_uncertain",
        sourceRecordIds,
        diagnosticIds: ["SC_UNRESOLVED_BATCH_TOO_LARGE:all-records"],
        note: "model marked every source unresolved",
      }],
      merges: [],
      rescopeProposals: [],
      mappings: [],
      diagnostics: [],
    }, { requireEventCompleteness: true });
  } catch (err) {
    msg = String((err && err.message) || err);
  }
  assert(msg.includes("unresolved batch too large") || msg.includes("unresolved-only decision"), "fresh unresolved-only all-source batch did not hard-fail: " + msg);
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

check("validator hard-fails when an archived legacy source is compiled", () => {
  const bad = {
    ...decision,
    constraints: [
      ...decision.constraints,
      {
        scope: { kind: "global" },
        injectMode: "always",
        title: "Archived rule incorrectly compiled",
        compiledBody: "This archived rule must not be compiled.",
        sourceRecordIds: [archivedSource.sourceId],
      },
    ],
  };
  let msg = "";
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch (err) { msg = String((err && err.message) || err); }
  assert(msg.includes("compiled archived or inactive legacy source"), "compiled archived source did not hard-fail with expected message: " + msg);
});

check("validator quarantines multi-home source before merge evaluation", () => {
  const multiHomeSource = source({
    sourceId: "rule:global:always:multi-home-merge-source",
    slug: "multi-home-merge-source",
    body: "An active source that the compiler incorrectly compiled and excluded.",
  });
  const archivedSibling = source({
    sourceId: "rule:global:always:multi-home-merge-sibling",
    slug: "multi-home-merge-sibling",
    status: "archived",
    body: "An archived sibling that stays excluded.",
  });
  const sources = [...allSources, multiHomeSource, archivedSibling];
  const withMultiHomeMerge = {
    ...decision,
    constraints: [
      ...decision.constraints,
      {
        scope: { kind: "global" },
        injectMode: "always",
        title: "Multi-home merge source",
        compiledBody: "An active source that the compiler incorrectly compiled and excluded.",
        sourceRecordIds: [multiHomeSource.sourceId],
      },
    ],
    exclusions: [
      ...decision.exclusions,
      { reason: "knowledge_candidate", sourceRecordIds: [multiHomeSource.sourceId] },
      { reason: "superseded_observed", sourceRecordIds: [archivedSibling.sourceId] },
    ],
    merges: [{ sourceRecordIds: [compactSource.sourceId, multiHomeSource.sourceId, archivedSibling.sourceId], reason: "family review pair with multi-home source" }],
    mappings: [
      ...decision.mappings,
      { sourceRecordId: multiHomeSource.sourceId, disposition: "excluded" },
      { sourceRecordId: archivedSibling.sourceId, disposition: "excluded" },
    ],
  };
  const validated = validateConstraintCompilerDecision(sources, withMultiHomeMerge, { knownProjectIds: ["pi-astack"] });
  assert(!validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(multiHomeSource.sourceId)), "pre-merge multi-home source remained compiled");
  assert(!validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(multiHomeSource.sourceId)), "pre-merge multi-home source remained excluded");
  assert(validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(archivedSibling.sourceId)), "non-conflicting archived sibling was dropped");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(multiHomeSource.sourceId) && item.reason === "conflict"), "pre-merge multi-home source was not quarantined");
  assert(!validated.merges.some((merge) => merge.sourceRecordIds.includes(multiHomeSource.sourceId)), "merge containing quarantined source entered accepted merges");
  assert(!validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED" && diagnostic.sourceRecordIds.includes(multiHomeSource.sourceId)), "multi-home source incorrectly used review-pair diagnostic");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_SOURCE_MULTI_HOME_QUARANTINED" && diagnostic.sourceRecordIds.includes(multiHomeSource.sourceId)), "pre-merge multi-home diagnostic missing");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === multiHomeSource.sourceId && mapping.disposition === "unresolved"), "pre-merge multi-home mapping not normalized");
});

check("validator drops empty-source ghost constraint only when trace source is excluded", () => {
  const ghost = {
    scope: { kind: "global" },
    injectMode: "always",
    title: "Empty-source ghost constraint",
    compiledBody: "This compiled shell should be dropped because the source is already excluded.",
    sourceRecordIds: [],
    decisionTrace: {
      reason: "archived source should be excluded, not compiled",
      sourceRecordIds: [archivedSource.sourceId],
    },
  };
  const withGhost = { ...decision, constraints: [...decision.constraints, ghost] };
  const validated = validateConstraintCompilerDecision(allSources, withGhost, { knownProjectIds: ["pi-astack"] });
  assert(!validated.constraints.some((constraint) => constraint.title === ghost.title), "empty-source ghost constraint entered compiled output");
  assert(validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(archivedSource.sourceId)), "excluded trace source was changed");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === archivedSource.sourceId && mapping.disposition === "excluded"), "excluded trace source mapping changed");
  const diagnostic = validated.diagnostics.find((item) => item.code === "SC_EMPTY_CONSTRAINT_DROPPED" && item.sourceRecordIds.includes(archivedSource.sourceId));
  assert(diagnostic, "empty-source ghost drop diagnostic missing");
  assert(diagnostic.data?.sourcePrimary?.[archivedSource.sourceId] === "excluded", "empty-source ghost diagnostic primary missing");
  assert(!validated.diagnostics.some((item) => item.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY" && item.sourceRecordIds.includes(archivedSource.sourceId)), "empty-source ghost drop produced diagnostic-vs-decision inconsistency");
});

check("validator drops exact single-source status-stale active exclusion", () => {
  const staleExclusion = { reason: "legacy_archived_observed", sourceRecordIds: [compactSource.sourceId], note: "stale archived side item" };
  const withStaleExclusion = { ...decision, exclusions: [...decision.exclusions, staleExclusion] };
  const withoutStaleExclusion = { ...decision };
  const validated = validateConstraintCompilerDecision(allSources, withStaleExclusion, { knownProjectIds: ["pi-astack"] });
  const canonical = validateConstraintCompilerDecision(allSources, withoutStaleExclusion, { knownProjectIds: ["pi-astack"] });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.length === 1 && constraint.sourceRecordIds[0] === compactSource.sourceId), "exact compiled primary was changed");
  assert(!validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(compactSource.sourceId)), "status-stale active exclusion was retained");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === compactSource.sourceId && mapping.disposition === "compiled"), "compiled mapping changed");
  const diagnostic = validated.diagnostics.find((item) => item.code === "SC_ACTIVE_EXCLUSION_DROPPED" && item.sourceRecordIds.includes(compactSource.sourceId));
  assert(diagnostic, "active status-stale exclusion drop diagnostic missing");
  assert(diagnostic.data?.exclusionReason === "legacy_archived_observed", "active status-stale diagnostic reason missing");
  assert(!validated.diagnostics.some((item) => item.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY" && item.sourceRecordIds.includes(compactSource.sourceId)), "active status-stale drop produced diagnostic-vs-decision inconsistency");
  assert(validated.validationHash === canonical.validationHash, "active status-stale exclusion drop changed validationHash");
});

check("validator rejects status-stale active exclusion without exact single-source compiled primary", () => {
  const staleExclusion = { reason: "legacy_archived_observed", sourceRecordIds: [globalSource.sourceId], note: "stale archived side item" };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, { ...decision, exclusions: [...decision.exclusions, staleExclusion] }, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "status-stale active exclusion with multi-source compiled primary accepted");
});

check("validator rejects status-stale active exclusion with unresolved overlap", () => {
  const staleExclusion = { reason: "legacy_archived_observed", sourceRecordIds: [compactSource.sourceId], note: "stale archived side item" };
  let threw = false;
  try {
    validateConstraintCompilerDecision(allSources, { ...decision, exclusions: [...decision.exclusions, staleExclusion], unresolved: [...decision.unresolved, { reason: "conflict", sourceRecordIds: [compactSource.sourceId], note: "conflicting status" }] }, { knownProjectIds: ["pi-astack"] });
  } catch { threw = true; }
  assert(threw, "status-stale active exclusion with unresolved overlap accepted");
});

check("validator rejects empty-source ghost constraint without non-compiled coverage", () => {
  const ghost = {
    scope: { kind: "global" },
    injectMode: "always",
    title: "Uncovered empty-source ghost constraint",
    compiledBody: "This shell has no safe non-compiled coverage.",
    sourceRecordIds: [],
    decisionTrace: {
      reason: "trace source is still compiled",
      sourceRecordIds: [compactSource.sourceId],
    },
  };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, { ...decision, constraints: [...decision.constraints, ghost] }, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "empty-source ghost with compiled trace source accepted");
});

check("validator rejects empty-source ghost constraint without trace sources", () => {
  const ghost = {
    scope: { kind: "global" },
    injectMode: "always",
    title: "Untraced empty-source ghost constraint",
    compiledBody: "This shell has no trace source.",
    sourceRecordIds: [],
    decisionTrace: { reason: "no sources", sourceRecordIds: [] },
  };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, { ...decision, constraints: [...decision.constraints, ghost] }, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "empty-source ghost without trace source accepted");
});

check("validator accepts active always jargon rule with listed superseded predecessor excluded", () => {
  const sources = [jargonAlwaysSource, jargonListedPredecessor];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Professional vocabulary hard blocker",
      compiledBody: "Never use jargon; use precise professional vocabulary instead.",
      sourceRecordIds: [jargonAlwaysSource.sourceId],
    }],
    exclusions: [{ reason: "superseded_observed", sourceRecordIds: [jargonListedPredecessor.sourceId] }],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [
      { sourceRecordId: jargonAlwaysSource.sourceId, disposition: "compiled" },
      { sourceRecordId: jargonListedPredecessor.sourceId, disposition: "excluded" },
    ],
    diagnostics: [],
  });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(jargonAlwaysSource.sourceId)), "active always jargon source not compiled");
  assert(validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(jargonListedPredecessor.sourceId) && exclusion.reason === "superseded_observed"), "listed predecessor not excluded as superseded");
  assert(!validated.unresolved.length, "correct active/listed predecessor decision produced unresolved items");
});

check("validator hard-fails bad merged always+listed jargon path with superseded source", () => {
  const sources = [jargonAlwaysSource, jargonListedPredecessor];
  const localNormalized = normalizeConstraintSources(sources);
  let msg = "";
  try {
    validateConstraintCompilerDecision(sources, {
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash: localNormalized.inputRootHash,
      constraints: [{
        scope: { kind: "global" },
        injectMode: "always",
        title: "Merged professional vocabulary rule",
        compiledBody: "Never use jargon; use precise professional vocabulary instead.",
        sourceRecordIds: [jargonAlwaysSource.sourceId, jargonListedPredecessor.sourceId],
      }],
      exclusions: [],
      unresolved: [],
      merges: [{ sourceRecordIds: [jargonAlwaysSource.sourceId, jargonListedPredecessor.sourceId], reason: "bad always/listed merge" }],
      rescopeProposals: [],
      mappings: [
        { sourceRecordId: jargonAlwaysSource.sourceId, disposition: "merged_source" },
        { sourceRecordId: jargonListedPredecessor.sourceId, disposition: "merged_source" },
      ],
      diagnostics: [],
    });
  } catch (err) {
    msg = String((err && err.message) || err);
  }
  assert(msg.includes("compiled archived or inactive legacy source") && msg.includes(jargonListedPredecessor.sourceId), "superseded merged source did not hard-fail with expected message: " + msg);
});

check("validator warns when diagnostic claims compiled source is unresolved", () => {
  const contradictory = {
    ...decision,
    diagnostics: [
      ...decision.diagnostics,
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "active source compiled into a professional vocabulary constraint", sourceRecordIds: [conflictSource.sourceId] }),
    ],
  };
  const validated = validateConstraintCompilerDecision(allSources, contradictory, { knownProjectIds: ["pi-astack"] });
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(conflictSource.sourceId)), "conflict source should remain unresolved");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY" && diagnostic.sourceRecordIds.includes(conflictSource.sourceId)), "diagnostic-vs-decision inconsistency warning missing");
});

check("validator does not warn when diagnostic says active compiled and predecessor excluded", () => {
  const sources = [jargonAlwaysSource, jargonListedPredecessor];
  const localNormalized = normalizeConstraintSources(sources);
  const validated = validateConstraintCompilerDecision(sources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Professional vocabulary hard blocker",
      compiledBody: "Never use jargon; use precise professional vocabulary instead.",
      sourceRecordIds: [jargonAlwaysSource.sourceId],
    }],
    exclusions: [{ reason: "superseded_observed", sourceRecordIds: [jargonListedPredecessor.sourceId] }],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [
      { sourceRecordId: jargonAlwaysSource.sourceId, disposition: "compiled" },
      { sourceRecordId: jargonListedPredecessor.sourceId, disposition: "excluded" },
    ],
    diagnostics: [
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "active always source was compiled and predecessors were excluded", sourceRecordIds: [jargonListedPredecessor.sourceId] }),
    ],
  });
  assert(validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(jargonListedPredecessor.sourceId) && exclusion.reason === "superseded_observed"), "listed predecessor not excluded as superseded");
  assert(!validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY" && diagnostic.sourceRecordIds.includes(jargonListedPredecessor.sourceId)), "predecessor exclusion diagnostic produced inconsistency warning");
});

check("validator ignores negated compiled/merged diagnostic wording", () => {
  const negated = {
    ...decision,
    diagnostics: [
      ...decision.diagnostics,
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "source is non-compiled after empty-source ghost drop", sourceRecordIds: [archivedSource.sourceId] }),
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "source not compiled because it belongs in settings", sourceRecordIds: [settingsSource.sourceId] }),
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "source not merged because predecessor was excluded", sourceRecordIds: [supersededSource.sourceId] }),
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "source could not be compiled due conflict", sourceRecordIds: [conflictSource.sourceId] }),
      makeDiagnostic({ code: "SC_UNCLASSIFIED", message: "source could not be merged due status mismatch", sourceRecordIds: [unknownSource.sourceId] }),
    ],
  };
  const validated = validateConstraintCompilerDecision(allSources, negated, { knownProjectIds: ["pi-astack"] });
  const negatedSourceIds = [archivedSource.sourceId, settingsSource.sourceId, supersededSource.sourceId, conflictSource.sourceId, unknownSource.sourceId];
  assert(!validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_DIAGNOSTIC_DECISION_INCONSISTENCY" && diagnostic.sourceRecordIds.some((sourceId) => negatedSourceIds.includes(sourceId))), "negated diagnostic wording produced diagnostic-vs-decision inconsistency");
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

check("validator rejects merge with source lacking settled primary", () => {
  const unsettledSource = source({
    sourceId: "rule:global:listed:unsettled-merge-source",
    slug: "unsettled-merge-source",
    injectMode: "listed",
    body: "A source that has no compiler bucket must not be accepted through a merge.",
  });
  const bad = { ...decision, merges: [{ sourceRecordIds: [compactSource.sourceId, unsettledSource.sourceId], reason: "bad merge" }] };
  let threw = false;
  try { validateConstraintCompilerDecision([...allSources, unsettledSource], bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "merge source without settled primary accepted");
});

check("validator quarantines unsupported merge review pair", () => {
  const listedCompiledSource = source({
    sourceId: "rule:global:listed:listed-review-pair-source",
    slug: "listed-review-pair-source",
    injectMode: "listed",
    body: "Listed source overlaps with an always source but must stay separately compiled.",
  });
  const sources = [...allSources, listedCompiledSource];
  const withReviewPair = {
    ...decision,
    constraints: [
      ...decision.constraints,
      {
        scope: { kind: "global" },
        injectMode: "listed",
        title: "Listed review pair source",
        compiledBody: "Listed source overlaps with an always source but must stay separately compiled.",
        sourceRecordIds: [listedCompiledSource.sourceId],
      },
    ],
    merges: [{ sourceRecordIds: [compactSource.sourceId, listedCompiledSource.sourceId], reason: "overlap but different injectMode; cannot be combined; review pair" }],
    mappings: [...decision.mappings, { sourceRecordId: listedCompiledSource.sourceId, disposition: "compiled" }],
  };
  const withoutReviewPair = { ...withReviewPair, merges: [] };
  const validated = validateConstraintCompilerDecision(sources, withReviewPair, { knownProjectIds: ["pi-astack"] });
  const canonical = validateConstraintCompilerDecision(sources, withoutReviewPair, { knownProjectIds: ["pi-astack"] });
  assert(!validated.merges.some((merge) => merge.sourceRecordIds.includes(listedCompiledSource.sourceId)), "unsupported review pair entered accepted merges");
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(compactSource.sourceId)), "always compiled source was dropped");
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(listedCompiledSource.sourceId)), "listed compiled source was dropped");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === compactSource.sourceId && mapping.disposition === "compiled"), "always source mapping changed");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === listedCompiledSource.sourceId && mapping.disposition === "compiled"), "listed source mapping changed");
  const diagnostic = validated.diagnostics.find((item) => item.code === "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED" && item.sourceRecordIds.includes(listedCompiledSource.sourceId));
  assert(diagnostic, "unsupported merge review-pair diagnostic missing");
  assert(diagnostic.severity === "info", "unsupported merge review-pair diagnostic severity drifted");
  assert(diagnostic.consumers.includes("compiler_prompt_iteration") && diagnostic.consumers.includes("manual_investigation"), "unsupported merge review-pair consumers missing");
  assert(diagnostic.data?.incompatibleDimension === "injectMode", "unsupported merge review-pair dimension missing");
  assert(diagnostic.data?.perSourcePrimary?.[compactSource.sourceId] === "compiled", "compiled source primary missing");
  assert(diagnostic.data?.perSourcePrimary?.[listedCompiledSource.sourceId] === "compiled", "listed source primary missing");
  assert(validated.validationHash === canonical.validationHash, "unsupported merge review-pair normalization changed validationHash");
});

check("validator quarantines unsupported merge review pair with unresolved source", () => {
  const unresolvedReviewSource = source({
    sourceId: "rule:global:listed:unresolved-review-pair-source",
    slug: "unresolved-review-pair-source",
    injectMode: "listed",
    body: "A source may be near-duplicate but still stay unresolved.",
  });
  const sources = [...allSources, unresolvedReviewSource];
  const withReviewPair = {
    ...decision,
    unresolved: [...decision.unresolved, { reason: "scope_ambiguous", sourceRecordIds: [unresolvedReviewSource.sourceId], note: "scope remains ambiguous" }],
    merges: [{ sourceRecordIds: [compactSource.sourceId, unresolvedReviewSource.sourceId], reason: "near duplicate but unresolved source must not be forced into compiled" }],
    mappings: [...decision.mappings, { sourceRecordId: unresolvedReviewSource.sourceId, disposition: "unresolved" }],
  };
  const withoutReviewPair = { ...withReviewPair, merges: [] };
  const validated = validateConstraintCompilerDecision(sources, withReviewPair, { knownProjectIds: ["pi-astack"] });
  const canonical = validateConstraintCompilerDecision(sources, withoutReviewPair, { knownProjectIds: ["pi-astack"] });
  const diagnostic = validated.diagnostics.find((item) => item.code === "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED" && item.sourceRecordIds.includes(unresolvedReviewSource.sourceId));
  assert(diagnostic, "unsupported merge review-pair diagnostic missing for unresolved source");
  assert(!validated.merges.some((merge) => merge.sourceRecordIds.includes(unresolvedReviewSource.sourceId)), "unresolved review pair entered accepted merges");
  assert(validated.unresolved.some((item) => item.sourceRecordIds.includes(unresolvedReviewSource.sourceId) && item.reason === "scope_ambiguous"), "unresolved source primary changed");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === unresolvedReviewSource.sourceId && mapping.disposition === "unresolved"), "unresolved source mapping changed");
  assert(diagnostic.data?.perSourcePrimary?.[compactSource.sourceId] === "compiled", "compiled source primary missing for unresolved pair");
  assert(diagnostic.data?.perSourcePrimary?.[unresolvedReviewSource.sourceId] === "unresolved", "unresolved source primary missing");
  assert(validated.validationHash === canonical.validationHash, "unresolved review-pair quarantine changed validationHash");
});

check("validator keeps constraint_event trigger fidelity semantic-neutral", () => {
  const discussionEvent = eventSource({
    sourceId: "event:1111111111111111111111111111111111111111111111111111111111111111",
    candidateText: "全局规则：以后我说T0讨论，那就是要求T0们进行多轮讨论并且直到将意见达成一致为止，主会话只做主持不做裁决",
    candidateTitle: "Whenever the user says 'T0讨论' in any future session",
    candidateTriggerPhrases: ["T0讨论"],
  });
  const reviewEvent = eventSource({
    sourceId: "event:2222222222222222222222222222222222222222222222222222222222222222",
    candidateText: "全局规则：以后我说T0审查，那就是要求T0们进行盲审，然后T0们做多轮交叉复核并且直到将结果达成一致为止，主会话同样只做主持不做裁决",
    candidateTitle: "Whenever the user invokes 'T0审查' in any future session",
    candidateTriggerPhrases: ["全局规则：以后我说T0审查，那就是要求T0们进行盲审，然后T0们做多轮交叉复核并且直到将结果达成一致为止"],
  });
  const sources = [discussionEvent, reviewEvent];
  const mergedLoss = {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(sources).inputRootHash,
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "T0讨论: multi-round T0 consensus",
      compiledBody: "Whenever the user says T0讨论, multiple T0 models conduct multi-round discussion until consensus; the main session only moderates.",
      triggerPhrases: ["T0讨论"],
      sourceRecordIds: [discussionEvent.sourceId, reviewEvent.sourceId],
    }],
    exclusions: [], unresolved: [], merges: [{ sourceRecordIds: [discussionEvent.sourceId, reviewEvent.sourceId], reason: "incorrectly merged distinct trigger events" }], rescopeProposals: [],
    mappings: [
      { sourceRecordId: discussionEvent.sourceId, disposition: "merged_source" },
      { sourceRecordId: reviewEvent.sourceId, disposition: "merged_source" },
    ],
    diagnostics: [],
  };
  const validated = validateConstraintCompilerDecision(sources, mergedLoss, { knownProjectIds: ["pi-astack"] });
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(discussionEvent.sourceId)), "discussion event was dropped by validator");
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(reviewEvent.sourceId)), "review event was semantically quarantined by validator");
  assert(validated.merges.some((merge) => merge.sourceRecordIds.includes(reviewEvent.sourceId)), "covered event merge was rejected by validator");
  assert(!validated.unresolved.some((item) => item.sourceRecordIds.includes(reviewEvent.sourceId)), "validator created semantic trigger unresolved item");
  const coverage = createConstraintEventCoverageReport({ events: sources, decision: validated, diagnostics: validated.diagnostics, staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z") });
  assert(coverage.report.summary.projectedEvents === 0, "merged_source event counted as projected without verifier");
  assert(coverage.report.rows.every((row) => row.status === "queued"), "merged_source events did not surface as queued without verifier");
});

check("validator quarantines uncovered constraint_event review pair structurally", () => {
  const discussionEvent = eventSource({
    sourceId: "event:3333333333333333333333333333333333333333333333333333333333333333",
    candidateText: "以后我说T0讨论，那就是要求T0们进行多轮讨论并且直到意见达成一致为止",
    candidateTitle: "Whenever the user says 'T0讨论' in any future session",
    candidateTriggerPhrases: ["T0讨论"],
  });
  const reviewEvent = eventSource({
    sourceId: "event:4444444444444444444444444444444444444444444444444444444444444444",
    candidateText: "以后我说T0审查，那就是要求T0们进行盲审并交叉复核直到一致",
    candidateTitle: "Whenever the user invokes 'T0审查' in any future session",
    candidateTriggerPhrases: ["T0审查"],
  });
  const sources = [discussionEvent, reviewEvent];
  const uncoveredReviewPair = {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(sources).inputRootHash,
    constraints: [
      { scope: { kind: "global" }, injectMode: "always", title: "T0讨论", compiledBody: "以后我说T0讨论时，T0们多轮讨论直到一致。", triggerPhrases: ["T0讨论"], sourceRecordIds: [discussionEvent.sourceId] },
      { scope: { kind: "global" }, injectMode: "always", title: "T0审查", compiledBody: "以后我说T0审查时，T0们盲审并交叉复核直到一致。", triggerPhrases: ["T0审查"], sourceRecordIds: [reviewEvent.sourceId] },
    ],
    exclusions: [], unresolved: [], merges: [{ sourceRecordIds: [discussionEvent.sourceId, reviewEvent.sourceId], reason: "distinct trigger review pair" }], rescopeProposals: [],
    mappings: [
      { sourceRecordId: discussionEvent.sourceId, disposition: "compiled" },
      { sourceRecordId: reviewEvent.sourceId, disposition: "compiled" },
    ],
    diagnostics: [],
  };
  const canonical = validateConstraintCompilerDecision(sources, { ...uncoveredReviewPair, merges: [] }, { knownProjectIds: ["pi-astack"] });
  const validated = validateConstraintCompilerDecision(sources, uncoveredReviewPair, { knownProjectIds: ["pi-astack"] });
  assert(!validated.merges.some((merge) => merge.sourceRecordIds.includes(reviewEvent.sourceId)), "uncovered review pair entered accepted merges");
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(discussionEvent.sourceId)), "discussion event constraint was dropped");
  assert(validated.constraints.some((constraint) => constraint.sourceRecordIds.includes(reviewEvent.sourceId)), "review event constraint was dropped");
  assert(validated.diagnostics.some((item) => item.code === "SC_UNSUPPORTED_MERGE_REVIEW_PAIR_QUARANTINED" && item.sourceRecordIds.includes(reviewEvent.sourceId)), "unsupported review-pair diagnostic missing");
  assert(validated.validationHash === canonical.validationHash, "uncovered event review-pair quarantine changed validationHash");
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
  // The real invariant still holds: a merge with an unsettled source is rejected regardless of hint.
  const unsettledSource = source({
    sourceId: "rule:global:listed:unsettled-merge-source-with-hint",
    slug: "unsettled-merge-source-with-hint",
    injectMode: "listed",
    body: "A source without a compiler bucket remains invalid even with a target hint.",
  });
  let threw = false;
  try {
    validateConstraintCompilerDecision([...allSources, unsettledSource], { ...decision, merges: [{ sourceRecordIds: [compactSource.sourceId, unsettledSource.sourceId], targetConstraintId: "shadow-constraint-bogus-not-a-hash", reason: "bad merge" }] }, { knownProjectIds: ["pi-astack"] });
  } catch { threw = true; }
  assert(threw, "unsettled merge with a dangling hint must still be rejected");
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

check("validator still rejects active legacy source with no primary disposition", () => {
  const unmappedSource = source({
    sourceId: "rule:global:listed:mapping-only-source",
    slug: "mapping-only-source",
    injectMode: "listed",
    body: "A source with no compiler bucket is invalid.",
  });
  const bad = { ...decision, mappings: [...decision.mappings, { sourceRecordId: unmappedSource.sourceId, disposition: "compiled" }] };
  let msg = "";
  try { validateConstraintCompilerDecision([...allSources, unmappedSource], bad, { knownProjectIds: ["pi-astack"] }); } catch (err) { msg = String((err && err.message) || err); }
  assert(msg.includes("has no primary disposition"), "active mapping-only source accepted without a primary disposition: " + msg);
});

check("validator deterministically excludes omitted inactive legacy source", () => {
  const omittedArchivedSource = source({
    sourceId: "rule:global:always:omitted-archived-knowledge-source",
    slug: "omitted-archived-knowledge-source",
    status: "archived",
    kind: "fact",
    body: "Archived knowledge source that the compiler omitted entirely.",
  });
  const localNormalized = normalizeConstraintSources([omittedArchivedSource]);
  const validated = validateConstraintCompilerDecision([omittedArchivedSource], {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: localNormalized.inputRootHash,
    constraints: [],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [],
    diagnostics: [],
  });
  assert(validated.exclusions.some((exclusion) => exclusion.reason === "legacy_archived_observed" && exclusion.sourceRecordIds.includes(omittedArchivedSource.sourceId)), "omitted archived source was not deterministically excluded");
  assert(validated.mappings.some((mapping) => mapping.sourceRecordId === omittedArchivedSource.sourceId && mapping.disposition === "excluded"), "omitted archived source mapping was not added");
});

check("validator normalizes not-memory subtype mismatch", () => {
  const mismatched = {
    ...decision,
    exclusions: decision.exclusions.map((exclusion) => exclusion.sourceRecordIds.includes(settingsSource.sourceId) ? { ...exclusion, reason: "tool_contract_not_memory" } : exclusion),
  };
  const canonical = validateConstraintCompilerDecision(allSources, decision, { knownProjectIds: ["pi-astack"] });
  const validated = validateConstraintCompilerDecision(allSources, mismatched, { knownProjectIds: ["pi-astack"] });
  assert(validated.exclusions.some((exclusion) => exclusion.sourceRecordIds.includes(settingsSource.sourceId) && exclusion.reason === "settings_not_memory"), "not-memory subtype was not canonicalized");
  assert(validated.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SUBTYPE_NORMALIZED" && diagnostic.sourceRecordIds.includes(settingsSource.sourceId)), "not-memory subtype diagnostic missing");
  assert(validated.validationHash === canonical.validationHash, "not-memory subtype normalization changed validationHash");
});

check("validator rejects not-memory exclusion without diagnostic", () => {
  const bad = { ...decision, diagnostics: decision.diagnostics.filter((diagnostic) => diagnostic.code !== "SC_NOT_MEMORY_TOOL_CONTRACT") };
  let threw = false;
  try { validateConstraintCompilerDecision(allSources, bad, { knownProjectIds: ["pi-astack"] }); } catch { threw = true; }
  assert(threw, "not-memory exclusion without diagnostic accepted");
});

check("validator rejects behavioral cleanup event as not-memory without diagnostic", () => {
  const cleanupEventId = `c1e623${"0".repeat(58)}`;
  const cleanupEventSource = eventSource({
    sourceId: `event:${cleanupEventId}`,
    eventId: cleanupEventId,
    candidateText: "Pi-Global Cleanup Checkpoint: when doing retired contract cleanup, preserve the active behavioral reminder/checkpoint and compile it as a durable constraint.",
    candidateTitle: "Pi-Global Cleanup Checkpoint",
    candidateTriggerPhrases: ["retired contract cleanup checkpoint"],
    candidatePriorityHint: "always",
    scopeHint: { kind: "project", projectId: "pi-global", evidence: "pi-global always reminder/checkpoint" },
    activeProjectId: "pi-global",
  });
  const eventNormalized = normalizeConstraintSources([cleanupEventSource], { activeProjectId: "pi-global", knownProjectIds: ["pi-global"] });
  assert(eventNormalized.records[0].categoryHint === "behavioral_constraint", `cleanup event category drifted: ${eventNormalized.records[0].categoryHint}`);
  assert(!eventNormalized.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_TOOL_CONTRACT"), "cleanup event unexpectedly emitted contract diagnostic");

  const bad = {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: eventNormalized.inputRootHash,
    constraints: [],
    exclusions: [{ reason: "tool_contract_not_memory", sourceRecordIds: [cleanupEventSource.sourceId] }],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: cleanupEventSource.sourceId, disposition: "excluded" }],
    diagnostics: [],
  };
  let threw = false;
  try { validateConstraintCompilerDecision([cleanupEventSource], bad, { knownProjectIds: ["pi-global"], expectedInputRootHash: eventNormalized.inputRootHash }); } catch { threw = true; }
  assert(threw, "behavioral cleanup event accepted as tool_contract_not_memory without diagnostic");

  const good = validateConstraintCompilerDecision([cleanupEventSource], {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: eventNormalized.inputRootHash,
    constraints: [{
      scope: { kind: "project", projectId: "pi-global" },
      injectMode: "always",
      title: "retired contract cleanup checkpoint",
      compiledBody: "When doing retired contract cleanup, preserve the active behavioral reminder/checkpoint and compile it as a durable constraint.",
      triggerPhrases: ["retired contract cleanup checkpoint"],
      sourceRecordIds: [cleanupEventSource.sourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: cleanupEventSource.sourceId, disposition: "compiled" }],
    diagnostics: [],
  }, { knownProjectIds: ["pi-global"], expectedInputRootHash: eventNormalized.inputRootHash });
  assert(good.constraints.some((constraint) => constraint.sourceRecordIds.includes(cleanupEventSource.sourceId)), "compiled cleanup event did not validate");
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
  const unicodeNotMemory = writeConstraintEvidenceEvent(abrainHome, {
    event_type: "constraint_not_memory_observed",
    created_at_utc: "2026-06-19T00:03:00.000Z",
    session_id: "session-d",
    turn_id: "turn-d",
    intent: { domain_hint: "constraint", operation_hint: "not_memory", confidence: 0.9 },
    payload: {
      sanitized_quote: "写配置/config、code、bash 和 string literal 输出时，禁止输出 \\u 转义；必须直接书写 literal UTF-8 Unicode 字符。",
      candidate_constraint_text: "写配置/config、code、bash 和 string literal 输出时，禁止输出 \\u 转义；必须直接书写 literal UTF-8 Unicode 字符。",
      candidate_title: "Literal UTF-8 output",
      candidate_trigger_phrases: ["no \\u", "literal UTF-8"],
      candidate_priority_hint: "always",
      not_memory_hint: "settings",
    },
    legacy_parallel_write: { attempted: true, legacy_path_kind: "tier1_ruleset_adjudicator", legacy_operation_hint: "none", legacy_audit_ref: "audit:d" },
  });
  const scan = await scanConstraintEvidenceEvents({ abrainHome });
  assert(scan.events.length === 4, `expected 4 events, got ${scan.events.length}`);
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
  const unicodeSource = scan.events.find((event) => event.eventId === unicodeNotMemory.event_id);
  assert(unicodeSource, "unicode not-memory event missing");
  const unicodeNormalized = normalizeConstraintSources([unicodeSource]);
  assert(unicodeNormalized.records[0].categoryHint === "behavioral_constraint", `unicode event category drifted: ${unicodeNormalized.records[0].categoryHint}`);
  assert(!unicodeNormalized.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS"), "unicode event normalized to SC_NOT_MEMORY_SETTINGS");
  assert(scan.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(`event:${notMemory.event_id}`)), "not-memory diagnostic missing");
  assert(!scan.diagnostics.some((diagnostic) => diagnostic.code === "SC_NOT_MEMORY_SETTINGS" && diagnostic.sourceRecordIds.includes(`event:${unicodeNotMemory.event_id}`)), "unicode not-memory event leaked SC_NOT_MEMORY_SETTINGS");
});

check("event scanner classifies registered foreign schemas via central registry; unknown/malformed fail closed (R3.4.2 P1-S3)", async () => {
  const { canonicalJson, canonicalJsonValue } = require(path.join(outRoot, "sediment", "constraint-evidence", "canonical-json.js"));
  const jcsBodyHash = (body) => sha256Hex(canonicalJson(canonicalJsonValue(body)));
  const writeRawEvent = (abrainHome, hex, content) =>
    writeFile(path.join(abrainHome, "l1", "events", "sha256", hex.slice(0, 2), hex.slice(2, 4), `${hex}.json`), content);

  // 1. Valid registered foreign envelopes are cleanly classified (not invalid,
  //    no constraint diagnostics) while the real constraint event is admitted.
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-foreign-"));
  const signal = writeConstraintEvidenceEvent(abrainHome, { session_id: "s", turn_id: "t" });
  const knowBody = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-06-19T00:00:00.000Z",
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    producer: { name: "sediment.knowledge-event-writer", version: "fixture" },
    scope: { kind: "world" },
    payload: { slug: "foreign-fixture" },
  };
  const knowHex = jcsBodyHash(knowBody);
  writeRawEvent(abrainHome, knowHex, `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: knowHex, body_hash: knowHex, body: knowBody }, null, 2)}\n`);
  const projBody = {
    event_schema_version: "constraint-projection-event/v1",
    event_type: "constraint_compiled_view_produced",
    created_at_utc: "2026-06-19T00:00:00.000Z",
    producer: { name: "sediment.constraint-compiler", version: "fixture" },
  };
  const projHex = jcsBodyHash(projBody);
  writeRawEvent(abrainHome, projHex, `${JSON.stringify({ schema: "constraint-projection-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: projHex, body_hash: projHex, body: projBody }, null, 2)}\n`);
  const scan = await scanConstraintEvidenceEvents({ abrainHome });
  assert(scan.events.length === 1 && scan.events[0].eventId === signal.event_id, `expected 1 admitted constraint event, got ${scan.events.length}`);
  assert(!scan.invalidEventIds.includes(knowHex) && !scan.invalidEventIds.includes(projHex), "foreign envelope wrongly marked invalid");
  const diagStr = JSON.stringify(scan.diagnostics);
  assert(!diagStr.includes(knowHex) && !diagStr.includes(projHex), "foreign envelope wrongly emitted a diagnostic (should be a clean skip)");

  // 2. Unknown envelope schema anywhere in L1 fails the whole scan closed.
  const unknownHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-unknown-"));
  writeConstraintEvidenceEvent(unknownHome, { session_id: "s", turn_id: "t" });
  const unkBody = { event_schema_version: "totally-unknown-event/v9" };
  const unkHex = jcsBodyHash(unkBody);
  writeRawEvent(unknownHome, unkHex, `${JSON.stringify({ schema: "totally-unknown-envelope/v9", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: unkHex, body_hash: unkHex, body: unkBody }, null, 2)}\n`);
  let unknownError;
  try {
    await scanConstraintEvidenceEvents({ abrainHome: unknownHome });
  } catch (err) {
    unknownError = err;
  }
  assert(unknownError && String(unknownError.code || unknownError.message).includes("L1_SCHEMA_UNKNOWN"), `unknown schema must fail the scan closed, got ${unknownError}`);

  // 3. Malformed JSON anywhere in L1 fails the whole scan closed.
  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-badjson-"));
  writeConstraintEvidenceEvent(badHome, { session_id: "s", turn_id: "t" });
  writeRawEvent(badHome, "d4".repeat(32), "{ this is not valid json ");
  let badError;
  try {
    await scanConstraintEvidenceEvents({ abrainHome: badHome });
  } catch (err) {
    badError = err;
  }
  assert(badError && String(badError.code || badError.message).includes("L1_ENVELOPE_INVALID"), `malformed json must fail the scan closed, got ${badError}`);
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
  const deferredMergeEvent = {
    ...projectedEvent,
    sourceId: "event:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    eventId: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    sourceChannel: "agent_end",
    bodyHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    createdAtUtc: "2026-06-19T00:00:00.000Z",
    legacyParallelWrite: { attempted: false, legacy_operation_hint: "none" },
    rawFilePath: "/tmp/event-d.json",
    sourceRef: { ref: "event:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", path: "/tmp/event-d.json" },
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
  const eventSources = [projectedEvent, queuedEvent, mismatchEvent, deferredMergeEvent];
  const eventDecision = validateConstraintCompilerDecision(eventSources, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(eventSources).inputRootHash,
    constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit/write", compiledBody: "修改文件必须用 edit/write。", triggerPhrases: ["edit/write"], sourceRecordIds: [projectedEvent.sourceId, deferredMergeEvent.sourceId] }],
    exclusions: [{ reason: "settings_not_memory", sourceRecordIds: [mismatchEvent.sourceId] }],
    unresolved: [],
    merges: [{ sourceRecordIds: [deferredMergeEvent.sourceId], reason: "deferred merged-source coverage fixture" }],
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
  assert(coverage.report.summary.totalEvents === 4, "wrong event coverage total");
  assert(coverage.report.summary.projectedEvents === 2, "projected event not counted");
  assert(coverage.report.summary.staleEvents === 1, "stale queued event not counted");
  assert(coverage.report.summary.deferredMergedSourceEvents === 1, "deferred merged-source event not counted");
  assert(coverage.report.summary.deferredUnresolvedEvents === 0, "unexpected deferred unresolved event count");
  const deferredMergeRow = coverage.report.rows.find((row) => row.sourceRecordId === deferredMergeEvent.sourceId);
  assert(deferredMergeRow?.coverageDisposition?.kind === "deferred_merged_source", "merged_source row disposition kind missing");
  assert(deferredMergeRow?.coverageDisposition?.action === "exclude_from_injectable_denominator", "merged_source row disposition action missing");
  assert(deferredMergeRow?.coverageDisposition?.verifierVerdict === "not_evaluated", "merged_source row verifier verdict missing");
  assert(deferredMergeRow?.coverageDisposition?.targetConstraintIds?.length === 1, "merged_source row target constraint id missing");
  assert(deferredMergeRow?.coverageDisposition?.mergeReasons?.includes("deferred merged-source coverage fixture"), "merged_source row merge reason missing");
  const staleRow = coverage.report.rows.find((row) => row.sourceRecordId === queuedEvent.sourceId);
  assert(staleRow?.coverageDisposition?.action === "emit_stale_threshold", "ordinary stale row disposition action missing");
  assert(staleRow?.coverageDisposition?.kind === "stale_threshold", "ordinary stale row disposition kind missing");
  assert(coverage.report.summary.coverageRatio === 0.5, "strict coverage ratio should keep deferred merged-source queued");
  assert(coverage.report.summary.injectableCoverageRatio === 2 / 3, "injectable coverage ratio should exclude deferred merged-source denominator");
  assert(coverage.report.summary.provenance.liveEvents === 2, "live provenance count missing");
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

check("merged_source verifier sidecar deterministically projects only valid expressed rows", () => {
  const mkEvent = (tag, createdAtUtc = "2026-06-18T00:00:00.000Z") => ({
    sourceKind: "constraint_event",
    sourceId: `event:${tag.repeat(64)}`,
    eventId: tag.repeat(64),
    eventType: "constraint_signal_observed",
    createdAtUtc,
    sessionId: `session-${tag}`, turnId: `turn-${tag}`,
    sourceChannel: "agent_end", sourceRole: "user",
    operationHint: "create", confidence: 0.8,
    sanitizedQuote: "Use edit/write.", candidateText: "Use edit/write.", candidateTitle: "Use edit/write",
    candidateTriggerPhrases: ["edit/write"], candidatePriorityHint: "always",
    scopeHint: { kind: "global", evidence: "fixture" }, activeProjectId: "pi-astack",
    scopeConfidence: 0.8, sanitizerStatus: "passed", sanitizerReplacementsCount: 0,
    legacyParallelWrite: { attempted: false }, causalParents: [],
    producerName: "smoke", producerVersion: "fixture",
    bodyHash: tag.repeat(64),
    rawFilePath: `/tmp/event-${tag}.json`,
    sourceRef: { ref: `event:${tag.repeat(64)}`, path: `/tmp/event-${tag}.json` },
  });
  const compiledEvent = mkEvent("a");
  const queuedEvent = mkEvent("b");
  const mergedEvent = mkEvent("c", "2026-06-19T00:00:00.000Z");
  const events = [compiledEvent, queuedEvent, mergedEvent];
  const decision = validateConstraintCompilerDecision(events, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(events).inputRootHash,
    constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit/write", compiledBody: "Use edit/write.", triggerPhrases: ["edit/write"], sourceRecordIds: [compiledEvent.sourceId, mergedEvent.sourceId] }],
    exclusions: [], unresolved: [],
    merges: [{ sourceRecordIds: [mergedEvent.sourceId], reason: "merged-source verifier fixture" }],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: compiledEvent.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  const validationHashBefore = decision.validationHash;
  const markdownBefore = renderConstraintShadowView(decision).markdown;
  const target = decision.constraints[0];
  const report = (rows, summaryOverrides = {}) => ({
    schemaVersion: "constraint-merged-source-verifier/v1",
    inputRootHash: decision.inputRootHash,
    decisionValidationHash: decision.validationHash,
    decisionHash: mergedSourceVerifierDecisionHash(decision),
    verifierInputHash: mergedSourceVerifierInputHash(events, decision),
    summary: {
      totalRows: rows.length,
      expressedRows: rows.filter((item) => item.verdict === "expressed").length,
      notExpressedRows: rows.filter((item) => item.verdict === "not_expressed").length,
      uncertainRows: rows.filter((item) => item.verdict === "uncertain").length,
      ...summaryOverrides,
    },
    rows,
  });
  const row = (verdict, confidence = "high", overrides = {}) => ({
    eventId: mergedEvent.eventId,
    sourceRecordId: mergedEvent.sourceId,
    eventBodyHash: mergedEvent.bodyHash,
    targetConstraintId: target.constraintId,
    targetContentHash: targetContentHashForConstraint(target),
    verdict,
    confidence,
    reasoning: `${verdict} fixture`,
    ...overrides,
  });
  const noSidecar = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
  });
  const expressed = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    mergedSourceVerifier: report([row("expressed", "medium")]),
  });
  const expressedRow = expressed.report.rows.find((item) => item.sourceRecordId === mergedEvent.sourceId);
  assert(noSidecar.report.summary.projectedEvents === 1, "baseline projected count changed");
  assert(noSidecar.report.summary.deferredMergedSourceEvents === 1, "baseline deferred merged count changed");
  assert(expressed.report.summary.projectedEvents === 2, "expressed verifier did not increase projected count");
  assert(expressed.report.summary.deferredMergedSourceEvents === 0, "expressed verifier did not reduce deferred merged count");
  assert(expressed.report.summary.coverageRatio === 2 / 3, "expressed verifier did not raise strict coverage ratio");
  assert(expressed.report.summary.injectableCoverageRatio === 2 / 3, "expressed verifier injectable ratio wrong");
  assert(expressedRow?.coverageDisposition?.kind === "projected_via_verifier", "expressed row disposition kind missing");
  assert(expressedRow?.coverageDisposition?.action === "count_projected", "expressed row action missing");
  assert(expressedRow?.coverageDisposition?.verifierVerdict === "expressed", "expressed verifier verdict missing");
  assert(expressedRow?.coverageDisposition?.verifierConfidence === "medium", "expressed verifier confidence missing");
  assert(expressedRow?.coverageDisposition?.verifierInputHash === report([]).verifierInputHash, "expressed verifier input hash missing");
  assert(decision.validationHash === validationHashBefore, "coverage verifier changed decision validationHash");
  assert(renderConstraintShadowView(decision).markdown === markdownBefore, "coverage verifier changed compiled-view markdown");

  const lowConfidenceExpressed = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    mergedSourceVerifier: report([row("expressed", "low")]),
  });
  const lowConfidenceExpressedRow = lowConfidenceExpressed.report.rows.find((item) => item.sourceRecordId === mergedEvent.sourceId);
  assert(lowConfidenceExpressedRow?.coverageDisposition?.kind === "deferred_merged_source", "low-confidence expressed row should remain deferred");
  assert(lowConfidenceExpressedRow?.coverageDisposition?.verifierVerdict === "expressed", "low-confidence expressed verdict missing");
  assert(lowConfidenceExpressedRow?.coverageDisposition?.verifierConfidence === "low", "low-confidence expressed confidence missing");

  const notExpressed = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    mergedSourceVerifier: report([row("not_expressed")]),
  });
  const notExpressedRow = notExpressed.report.rows.find((item) => item.sourceRecordId === mergedEvent.sourceId);
  assert(notExpressedRow?.coverageDisposition?.kind === "deferred_merged_source", "not_expressed row should remain deferred");
  assert(notExpressedRow?.coverageDisposition?.verifierVerdict === "not_expressed", "not_expressed verdict missing");
  assert(notExpressed.diagnostics.some((diagnostic) => diagnostic.code === "SC_MERGED_SOURCE_VERIFIER_NOT_EXPRESSED"), "not_expressed diagnostic missing");

  const uncertain = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    mergedSourceVerifier: report([row("uncertain")]),
  });
  const uncertainRow = uncertain.report.rows.find((item) => item.sourceRecordId === mergedEvent.sourceId);
  assert(uncertainRow?.coverageDisposition?.kind === "deferred_merged_source", "uncertain row should remain deferred");
  assert(uncertainRow?.coverageDisposition?.verifierVerdict === "uncertain", "uncertain verdict missing");

  const staleBinding = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    mergedSourceVerifier: report([row("expressed", "high", { eventBodyHash: "0".repeat(64) })]),
  });
  const staleBindingRow = staleBinding.report.rows.find((item) => item.sourceRecordId === mergedEvent.sourceId);
  assert(staleBindingRow?.coverageDisposition?.kind === "deferred_merged_source", "stale binding row should remain deferred");
  assert(staleBindingRow?.coverageDisposition?.verifierVerdict === "not_evaluated", "stale binding should fail closed to not_evaluated");
  assert(staleBindingRow?.coverageDisposition?.reason.includes("stale"), "stale binding reason missing");

  const summaryMismatch = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 60 * 1000, nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    mergedSourceVerifier: report([row("expressed")], { expressedRows: 0 }),
  });
  const summaryMismatchRow = summaryMismatch.report.rows.find((item) => item.sourceRecordId === mergedEvent.sourceId);
  assert(summaryMismatchRow?.coverageDisposition?.kind === "deferred_merged_source", "summary mismatch row should remain deferred");
  assert(summaryMismatchRow?.coverageDisposition?.verifierVerdict === "not_evaluated", "summary mismatch should fail closed to not_evaluated");
  assert(summaryMismatchRow?.coverageDisposition?.reason.includes("stale"), "summary mismatch stale reason missing");
});

check("ADR0039 (2026-06-24): AGED merged_source/unresolved are deferred — excluded from injectable coverage + no stale/gap diagnostics", () => {
  const mkEvent = (tag) => ({
    sourceKind: "constraint_event",
    sourceId: `event:${tag.repeat(64)}`,
    eventId: tag.repeat(64),
    eventType: "constraint_signal_observed",
    createdAtUtc: "2026-06-18T00:00:00.000Z",
    sessionId: "session-x", turnId: "turn-x",
    sourceChannel: "agent_end", sourceRole: "user",
    operationHint: "create", confidence: 0.8,
    sanitizedQuote: "x", candidateText: "x", candidateTitle: "X",
    candidateTriggerPhrases: ["x"], candidatePriorityHint: "always",
    scopeHint: { kind: "global", evidence: "fixture" }, activeProjectId: "pi-astack",
    scopeConfidence: 0.8, sanitizerStatus: "passed", sanitizerReplacementsCount: 0,
    legacyParallelWrite: { attempted: false }, causalParents: [],
    producerName: "smoke", producerVersion: "fixture",
    bodyHash: tag.repeat(64),
    rawFilePath: `/tmp/event-${tag}.json`,
    sourceRef: { ref: `event:${tag.repeat(64)}`, path: `/tmp/event-${tag}.json` },
  });
  const compiledEvent = mkEvent("a");
  const mergedEvent = mkEvent("b");
  const unresolvedEvent = mkEvent("c");
  const events = [compiledEvent, mergedEvent, unresolvedEvent];
  const decision = validateConstraintCompilerDecision(events, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(events).inputRootHash,
    constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "X", compiledBody: "x", triggerPhrases: ["x"], sourceRecordIds: [compiledEvent.sourceId, mergedEvent.sourceId] }],
    exclusions: [],
    unresolved: [{ sourceRecordIds: [unresolvedEvent.sourceId], reason: "conflict" }],
    merges: [{ sourceRecordIds: [mergedEvent.sourceId], reason: "aged merged-source fixture" }],
    rescopeProposals: [],
    mappings: [{ sourceRecordId: compiledEvent.sourceId, disposition: "compiled" }],
    diagnostics: [],
  });
  // nowMs is 6 days past createdAt with a 60s stale threshold, so the queued
  // merged_source + unresolved rows age into "stale" — the exact live shape that
  // falsely tripped coverage_below_min + §12 dead_projector before the fix.
  const coverage = createConstraintEventCoverageReport({
    events, decision, diagnostics: decision.diagnostics,
    staleAfterMs: 60 * 1000, nowMs: Date.parse("2026-06-24T00:00:00.000Z"),
  });
  const s = coverage.report.summary;
  assert(s.totalEvents === 3, `total ${s.totalEvents}`);
  assert(s.projectedEvents === 1, `projected ${s.projectedEvents}`);
  assert(s.staleEvents === 2, `stale ${s.staleEvents} (merged+unresolved aged)`);
  assert(s.deferredMergedSourceEvents === 1, `aged merged-source still counted as deferred, got ${s.deferredMergedSourceEvents}`);
  assert(s.deferredUnresolvedEvents === 1, `aged unresolved still counted as deferred, got ${s.deferredUnresolvedEvents}`);
  const mergedRow = coverage.report.rows.find((row) => row.sourceRecordId === mergedEvent.sourceId);
  assert(mergedRow?.coverageDisposition?.kind === "deferred_merged_source", "aged merged_source row disposition kind missing");
  assert(mergedRow?.coverageDisposition?.action === "exclude_from_injectable_denominator", "aged merged_source row action missing");
  assert(mergedRow?.coverageDisposition?.verifierVerdict === "not_evaluated", "aged merged_source verifier verdict missing");
  assert(mergedRow?.coverageDisposition?.targetConstraintIds?.length === 1, "aged merged_source target constraint id missing");
  assert(mergedRow?.coverageDisposition?.mergeReasons?.includes("aged merged-source fixture"), "aged merged_source merge reason missing");
  const unresolvedRow = coverage.report.rows.find((row) => row.sourceRecordId === unresolvedEvent.sourceId);
  assert(unresolvedRow?.coverageDisposition?.kind === "deferred_unresolved", "aged unresolved row disposition kind missing");
  assert(unresolvedRow?.coverageDisposition?.action === "exclude_from_injectable_denominator", "aged unresolved row action missing");
  assert(unresolvedRow?.coverageDisposition?.reason === "conflict", "aged unresolved row reason missing");
  assert(s.injectableCoverageRatio === 1, `injectable should exclude deferred from denom, got ${s.injectableCoverageRatio}`);
  assert(!coverage.diagnostics.some((d) => d.code === "SC_EVENT_STALE_THRESHOLD"), "aged deferred merged/unresolved must NOT emit stale diagnostics");
  assert(!coverage.diagnostics.some((d) => d.code === "SC_EVENT_COVERAGE_GAP"), "deferred must NOT emit coverage-gap diagnostics");
});

check("prompt builder is deterministic and shadow-only", () => {
  const prompt = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  const again = buildConstraintCompilerPrompt({ normalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(prompt.promptHash === again.promptHash, "prompt hash drifted");
  assert(prompt.text.includes("shadow-only"), "shadow-only instruction missing");
  assert(prompt.text.includes("Return JSON only"), "JSON-only instruction missing");
  assert(prompt.text.includes("Never include mutation-key fields"), "mutation-key instruction missing");
  assert(prompt.text.includes("Validator-enforced structural failures") && !prompt.text.includes("rejected by the validator"), "structural validation guidance missing or old validator-rejection banner present");
  assert(prompt.text.includes("status archived, superseded, or deprecated") && prompt.text.includes("must never appear in constraints[] or as a merged compiled source"), "closed-status structural validation guidance missing");
  assert(prompt.text.includes("known mid-word native-git tail") && prompt.text.includes("compiledBody must not contain native git or Native git"), "native-git prompt guidance missing");
  assert(prompt.text.includes("Do not leave compiledBody ending in a raw mid-word fragment") && prompt.text.includes("source-truncated or visible truncated fragment"), "data-migration prompt guidance missing");
  assert(prompt.text.includes("literal UTF-8 output"), "Unicode/output-encoding guidance missing");
  assert(prompt.text.includes("no \\u escapes"), "no-u escape guidance missing");
  assert(prompt.text.includes("active always source") && prompt.text.includes("listed predecessor"), "active-always/listed-predecessor guidance missing");
  assert(prompt.text.includes("Active source compiled plus predecessor sources excluded is a consistent result"), "active-compiled/predecessor-excluded consistency guidance missing");
  assert(prompt.text.includes("Settings/config exclusions require an input categoryHint of settings_not_memory"), "settings not-memory categoryHint gate guidance missing");
  assert(prompt.text.includes("SC_NOT_MEMORY_SETTINGS"), "settings not-memory diagnostic gate guidance missing");
  assert(prompt.text.includes("must be placed only in exclusions[]") && prompt.text.includes("must not appear in constraints[], merges[], or unresolved[]") && prompt.text.includes("Do not merge settings_not_memory or tool_contract_not_memory sources with any active behavioral rule"), "not-memory exclusive exclusion guidance missing");
  assert(prompt.text.includes("constraint_event with categoryHint=behavioral_constraint"), "behavioral event compile/unresolved guidance missing");
  assert(prompt.text.includes("fact, identity, provenance, deployment/infrastructure fact, or diagnostic background") && prompt.text.includes("exclude it as knowledge_candidate") && prompt.text.includes("do not put it in unresolved[] solely because it is not behavior"), "fact-like constraint_event knowledge_candidate boundary missing");
  assert(prompt.text.includes("config, code, bash, settings schema, removal, or checkpoint"), "behavioral cleanup topical-word guard missing");
  assert(prompt.text.includes("Checkpoint/reminder constraint_event records") && prompt.text.includes("two-week checkpoint") && prompt.text.includes("Compile the reminder/review obligation without inventing the future outcome"), "checkpoint/reminder event compile guidance missing");
  assert(prompt.text.includes("active legacy_rule with categoryHint=behavioral_constraint"), "active legacy behavioral rule guidance missing");
  assert(prompt.text.includes("low numeric confidence, assistant-observed provenance"), "low-confidence/assistant-observed boundary missing");
  assert(prompt.text.includes("different scope, injectMode, or sourceKind"), "overlap boundary missing");
  assert(prompt.text.includes("not by itself a basis for unresolved/model_uncertain"), "model_uncertain boundary missing");
  assert(prompt.text.includes("compile that source as a separate constraint using its original scope and injectMode"), "separate compile boundary missing");
  assert(prompt.text.includes("only when the rule text cannot be parsed into a behavioral directive"), "unresolved boundary missing");
  assert(prompt.text.includes("Mapping disposition must match the source's primary bucket"), "mapping disposition primary-bucket guidance missing");
  assert(prompt.text.includes("Preserve mandatory and exclusive semantics from each source"), "mandatory/exclusive preservation guidance missing");
  assert(prompt.text.includes("only, must, never, forbid, prohibited"), "exclusive keyword examples missing");
  assert(prompt.text.includes("禁止, 必须, 仅, 只, 只能, and 不得"), "Chinese exclusive keyword examples missing");
  assert(prompt.text.includes("Preserve explicit action verbs in body text as obligations"), "body action verb preservation guidance missing");
  assert(prompt.text.includes("analyze upstream update content / 分析上游更新内容") && prompt.text.includes("judge whether sync/release is needed / 是否有必要同步和发版"), "upstream sync/release body action examples missing");
  assert(prompt.text.includes("Title gates and body actions are complementary evidence") && prompt.text.includes("combine them in compiledBody or mustDoSummary"), "title/body action combination guidance missing");
  assert(prompt.text.includes("Preserve explicit severity, priority, and ranking semantics as behavioral ordering thresholds"), "severity/priority/ranking preservation guidance missing");
  assert(prompt.text.includes("highest-severity, higher severity than, first, priority, critical, blocking, highest"), "severity/priority/ranking keyword examples missing");
  assert(prompt.text.includes("最严重, 优先级, 最高, and 首先"), "Chinese severity/priority/ranking keyword examples missing");
  assert(prompt.text.includes("Preserve boundary, scope, fallback, rollback, and exception carve-outs exactly as written"), "boundary/scope/fallback/rollback carve-out guidance missing");
  assert(prompt.text.includes("specific named examples, explicit must/record/disclose actions"), "boundary example/action preservation guidance missing");
  assert(prompt.text.includes("previous model immediately after new model"), "rollback ordering guidance missing");
  assert(prompt.text.includes("timeless-direction docs excluded") && prompt.text.includes("individual entry lifecycle ops excluded"), "scope carve-out guidance missing");
  assert(prompt.text.includes("does not change T0 architecture protocol"), "exception carve-out guidance missing");
  assert(prompt.text.includes("Preserve normative architecture and methodology directives even when they appear inside a scope note, heading, or numbered list item"), "normative architecture/methodology preservation guidance missing");
  assert(prompt.text.includes("treat X as precedent") && prompt.text.includes("extend the same evidence-based unified architecture"), "architecture precedent/extension guidance missing");
  assert(prompt.text.includes("deposition-time dedup") && prompt.text.includes("classifier-driven routing") && prompt.text.includes("materialized-view frontmatter"), "named architecture mechanism preservation guidance missing");
  assert(prompt.text.includes("compiledBody, mustDoSummary, or appliesWhen"), "behavioral ordering output-field guidance missing");
  assert(prompt.text.includes("prioritize, prefer, normally, generally, should, unless materially affect"), "weakened wording examples missing");
  assert(prompt.text.includes("unless that exception or weakening is explicit in the same source text"), "source-explicit exception boundary missing");
  assert(prompt.text.includes("Do not add exception, permission, or override paths that are not present in the same source text"), "invented exception/permission/override guard missing");
  assert(prompt.text.includes("unless explicitly requested") && prompt.text.includes("unless the source explicitly provides another trigger"), "forbidden invented exception phrase examples missing");
  assert(prompt.text.includes("absolute/no-retroactive/only-gate semantics without adding an escape hatch"), "absolute/no-retroactive/only-gate preservation guidance missing");
  assert(prompt.text.includes("truncated in the middle of a word or sentence") && prompt.text.includes("Preserve only visible complete obligations"), "truncated-source no-completion guidance missing");
  assert(prompt.text.includes("copy only the visible fragment") && prompt.text.includes("instead of completing it into a full word/category name"), "truncated fragment no-completion guidance missing");
  assert(prompt.text.includes("Do not leave compiledBody ending in a raw mid-word fragment") && prompt.text.includes("source-truncated or visible truncated fragment"), "truncated fragment labeling guidance missing");
  assert(prompt.text.includes("If a source says only X may trigger Y"), "exclusive trigger gate guidance missing");
  assert(prompt.text.includes("clear affirmative goals such as user wants, wants to, wants X to be Y, should, need, 要, 想把, 纳入, and 跟踪"), "affirmative directive preservation guidance missing");
  assert(prompt.text.includes("Do not rewrite them as may, can, allowed, or permitted unless the source explicitly frames the directive as permission or an exception"), "affirmative directive permission-exception boundary missing");
  assert(prompt.text.includes(globalSource.sourceId), "source id missing from prompt");

  const piGlobalNormalized = normalizeConstraintSources([piGlobalPrivateRepoTrackingSource], {
    activeProjectId: "pi-global",
    knownProjectIds: ["pi-global"],
    compilerOptions: { mode: "fixture" },
  });
  const piGlobalPrompt = buildConstraintCompilerPrompt({ normalized: piGlobalNormalized, knownProjectIds: ["pi-global"], activeProjectId: "pi-global" });
  assert(piGlobalPrompt.text.includes(piGlobalPrivateRepoTrackingSource.sourceId), "pi-global private repo tracking source id missing from prompt");
  assert(piGlobalPrompt.text.includes("user wants secrets.json and agent/models.json to be tracked in git"), "pi-global affirmative tracking fixture missing from prompt");
  assert(piGlobalPrompt.text.includes("despite normal secret-gitignore norms"), "pi-global secret-gitignore exception fixture missing from prompt");
  assert(piGlobalPrompt.text.includes("Do not rewrite them as may, can, allowed, or permitted unless the source explicitly frames the directive as permission or an exception"), "pi-global prompt missing affirmative directive boundary");

  const sub2apiNormalized = normalizeConstraintSources([sub2apiSemanticReviewSource], {
    activeProjectId: "sub2api",
    knownProjectIds: ["sub2api"],
    compilerOptions: { mode: "fixture" },
  });
  const sub2apiPrompt = buildConstraintCompilerPrompt({ normalized: sub2apiNormalized, knownProjectIds: ["sub2api"], activeProjectId: "sub2api" });
  assert(sub2apiPrompt.text.includes(sub2apiSemanticReviewSource.sourceId), "sub2api semantic_review_required source id missing from prompt");
  assert(sub2apiPrompt.text.includes("semantic_review_required: only business logic changes should drive semantic review"), "sub2api semantic_review_required source text missing from prompt");
  assert(sub2apiPrompt.text.includes("Preserve mandatory and exclusive semantics from each source"), "sub2api prompt missing exclusivity preservation guidance");
  assert(sub2apiPrompt.text.includes("only business logic changes"), "sub2api prompt missing only-business-logic threshold guidance/source text");
  assert(sub2apiPrompt.text.includes("only gate") && sub2apiPrompt.text.includes("without adding an escape hatch"), "sub2api prompt missing only-gate no-escape guidance");
  assert(sub2apiPrompt.text.includes("unless the source explicitly provides another trigger"), "sub2api prompt missing forbidden alternate-trigger phrase guard");
  assert(sub2apiPrompt.text.includes("unless materially affect") && sub2apiPrompt.text.includes("unless that exception or weakening is explicit in the same source text"), "sub2api prompt missing materiality-exception guard");

  const legacyNoRetroactiveNormalized = normalizeConstraintSources([legacyNoRetroactiveRewriteSource], {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  const legacyNoRetroactivePrompt = buildConstraintCompilerPrompt({ normalized: legacyNoRetroactiveNormalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(legacyNoRetroactivePrompt.text.includes(legacyNoRetroactiveRewriteSource.sourceId), "legacy no-retroactive source id missing from prompt");
  assert(legacyNoRetroactivePrompt.text.includes("旧文档不追溯重写"), "legacy no-retroactive source text missing from prompt");
  assert(legacyNoRetroactivePrompt.text.includes("no retroactive rewrite") && legacyNoRetroactivePrompt.text.includes("without adding an escape hatch"), "legacy no-retroactive prompt missing no-escape guidance");
  assert(legacyNoRetroactivePrompt.text.includes("unless explicitly requested"), "legacy no-retroactive prompt missing forbidden explicit-request phrase guard");

  const truncatedNativeGitNormalized = normalizeConstraintSources([truncatedNativeGitSource], {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  const truncatedNativeGitPrompt = buildConstraintCompilerPrompt({ normalized: truncatedNativeGitNormalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(truncatedNativeGitPrompt.text.includes(truncatedNativeGitSource.sourceId), "truncated native-git source id missing from prompt");
  assert(truncatedNativeGitPrompt.text.includes("[source text truncated mid-word; incomplete tail omitted]"), "truncated native-git marker missing from prompt");
  assert(!truncatedNativeGitPrompt.text.includes("Native git operatio"), "raw truncated native-git fragment leaked into prompt");
  assert(truncatedNativeGitPrompt.text.includes("All GitHub repositories must use gh"), "truncated native-git complete title obligation missing from prompt");
  assert(truncatedNativeGitPrompt.text.includes("所有 GitHub 仓库必须使用 gh 工具进行管理"), "truncated native-git visible obligation missing from prompt");
  assert(truncatedNativeGitPrompt.text.includes("truncated in the middle of a word or sentence") && truncatedNativeGitPrompt.text.includes("permission paths"), "truncated native-git prompt missing no-completion guidance");
  assert(truncatedNativeGitPrompt.text.includes("sanitized input marks a known mid-word native-git tail") && truncatedNativeGitPrompt.text.includes("compiledBody must not contain native git or Native git"), "truncated native-git prompt missing explicit native-git ban");

  const truncatedDataMigrationNormalized = normalizeConstraintSources([truncatedDataMigrationSource], {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  const truncatedDataMigrationPrompt = buildConstraintCompilerPrompt({ normalized: truncatedDataMigrationNormalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(truncatedDataMigrationPrompt.text.includes(truncatedDataMigrationSource.sourceId), "truncated data-migration source id missing from prompt");
  assert(truncatedDataMigrationPrompt.text.includes("[source-truncated incomplete final category omitted]"), "truncated data-migration marker missing from prompt");
  assert(truncatedDataMigrationPrompt.text.includes("OAuth/[source-truncated incomplete final category omitted]"), "truncated data-migration complete prefix missing from prompt");
  assert(!truncatedDataMigrationPrompt.text.includes("data migrati"), "raw truncated data-migration fragment leaked into prompt");
  assert(!truncatedDataMigrationPrompt.text.includes("data migration"), "completed data-migration phrase leaked into prompt");
  assert(truncatedDataMigrationPrompt.text.includes("copy only the visible fragment") && truncatedDataMigrationPrompt.text.includes("instead of completing it into a full word/category name"), "truncated data-migration prompt missing no-completion guidance");
  assert(truncatedDataMigrationPrompt.text.includes("Do not leave compiledBody ending in a raw mid-word fragment") && truncatedDataMigrationPrompt.text.includes("source-truncated or visible truncated fragment"), "truncated data-migration prompt missing explicit labeling guidance");

  const bareTruncatedNativeGitSource = source({
    sourceId: "rule:global:always:bare-native-git-operatio-truncated",
    slug: "bare-native-git-operatio-truncated",
    title: "Native git operatio",
    body: "Bare truncated native git fixture.",
  });
  const fullPromptSanitizerSources = [
    bareTruncatedNativeGitSource,
    source({
      sourceId: "rule:global:always:complete-native-git-operations",
      slug: "complete-native-git-operations",
      title: "Native git operations complete fixture",
      body: "Native git operation and Native git operations are complete words.",
    }),
    source({
      sourceId: "rule:global:always:complete-data-migration",
      slug: "complete-data-migration",
      title: "Complete data migration fixture",
      body: "data migration and data migrations are complete words.",
    }),
  ];
  const fullPromptSanitizerNormalized = normalizeConstraintSources(fullPromptSanitizerSources, {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  const fullPromptSanitizerPrompt = buildConstraintCompilerPrompt({ normalized: fullPromptSanitizerNormalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(fullPromptSanitizerPrompt.text.includes("[source text truncated mid-word; incomplete tail omitted]"), "bare truncated native-git marker missing from prompt");
  assert(!fullPromptSanitizerPrompt.text.includes('"title":"Native git operatio"'), "bare truncated native-git fragment leaked into prompt title");
  assert(fullPromptSanitizerPrompt.text.includes("Native git operations"), "complete Native git operations phrase was altered by prompt sanitizer");
  assert(fullPromptSanitizerPrompt.text.includes("Native git operation"), "complete Native git operation phrase was altered by prompt sanitizer");
  assert(fullPromptSanitizerPrompt.text.includes("data migration"), "complete data migration phrase was altered by prompt sanitizer");
  assert(fullPromptSanitizerPrompt.text.includes("data migrations"), "complete data migrations phrase was altered by prompt sanitizer");
  assert(!fullPromptSanitizerPrompt.text.includes("[source-truncated incomplete final category omitted]"), "complete data migration phrases were replaced by prompt sanitizer");

  const docDriftNormalized = normalizeConstraintSources([docDriftSeveritySource], {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  const docDriftPrompt = buildConstraintCompilerPrompt({ normalized: docDriftNormalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(docDriftPrompt.text.includes(docDriftSeveritySource.sourceId), "doc drift severity source id missing from prompt");
  assert(docDriftPrompt.text.includes("Charter document staleness is the highest-severity doc drift signal"), "doc drift highest-severity fixture missing from prompt");
  assert(docDriftPrompt.text.includes("README/charter read first has higher drift severity than subordinate documents"), "doc drift ranking fixture missing from prompt");
  assert(docDriftPrompt.text.includes("cross-check roadmap/changelog/git log/artifacts"), "doc drift cross-check fixture missing from prompt");
  assert(docDriftPrompt.text.includes("Preserve explicit severity, priority, and ranking semantics as behavioral ordering thresholds"), "doc drift prompt missing severity/priority/ranking guidance");
  assert(docDriftPrompt.text.includes("compiledBody, mustDoSummary, or appliesWhen"), "doc drift prompt missing severity output-field guidance");

  const restartNormalized = normalizeConstraintSources([restartDisclosureLegacySource, restartDisclosureOverlapEvent], {
    activeProjectId: "pi-astack",
    knownProjectIds: ["pi-astack"],
    compilerOptions: { mode: "fixture" },
  });
  const restartRecord = restartNormalized.records.find((item) => item.sourceId === restartDisclosureLegacySource.sourceId);
  assert(restartRecord && restartRecord.categoryHint === "behavioral_constraint", `restart disclosure rule category drifted: ${restartRecord && restartRecord.categoryHint}`);
  const restartPrompt = buildConstraintCompilerPrompt({ normalized: restartNormalized, knownProjectIds: ["pi-astack"], activeProjectId: "pi-astack" });
  assert(restartPrompt.text.includes(restartDisclosureLegacySource.sourceId), "restart disclosure legacy rule missing from prompt");
  assert(restartPrompt.text.includes(restartDisclosureOverlapEvent.sourceId), "restart disclosure overlap event missing from prompt");
  assert(restartPrompt.text.includes('"categoryHint":"behavioral_constraint"'), "restart prompt missing behavioral category hint");
  assert(restartPrompt.text.includes('"provenance":"assistant-observed"'), "restart prompt missing assistant-observed provenance");
  assert(restartPrompt.text.includes('"confidence":2'), "restart prompt missing low confidence");
  assert(restartPrompt.text.includes('"injectMode":"listed"'), "restart prompt missing listed inject mode");
  assert(restartPrompt.text.includes("not by itself a basis for unresolved/model_uncertain"), "restart prompt missing model_uncertain boundary");
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

check("pi-ai verifier invoker uses audit operation and extracts text", async () => {
  const mergedEvent = eventSource({
    sourceId: "event:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    eventId: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    candidateText: "Use edit/write.",
    bodyHash: "f".repeat(64),
  });
  const events = [mergedEvent];
  const localDecision = validateConstraintCompilerDecision(events, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(events).inputRootHash,
    constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit/write", compiledBody: "Use edit/write.", triggerPhrases: ["edit/write"], sourceRecordIds: [mergedEvent.sourceId] }],
    exclusions: [], unresolved: [], merges: [{ sourceRecordIds: [mergedEvent.sourceId], reason: "fixture merge" }], rescopeProposals: [],
    mappings: [{ sourceRecordId: mergedEvent.sourceId, disposition: "merged_source" }],
    diagnostics: [],
  });
  const invoker = createPiAiMergedSourceVerifierInvoker({
    modelRegistry: {
      find(provider, modelId) {
        assert(provider === "test" && modelId === "verifier", "verifier model ref not parsed");
        return { provider, id: modelId };
      },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; },
    },
    defaultModelRef: "test/verifier",
    streamSimpleImpl: {
      streamSimple(_model, opts, config) {
        assert(config.apiKey === "secret", "verifier api key not forwarded");
        assert(opts.messages[0].content[0].text.includes("Constraint Merged Source Verifier"), "verifier prompt text missing");
        return { result: async () => ({ content: [{ type: "text", text: "{\"rows\":[]}" }] }) };
      },
    },
  });
  const prompt = buildMergedSourceVerifierPrompt({ events, decision: localDecision });
  const result = await invoker({ prompt });
  const audit = require(path.join(outRoot, "_shared", "llm-audit.js"));
  assert(result.ok && result.text === "{\"rows\":[]}", "verifier text result not extracted");
  assert(audit.lastAuditMeta?.operation === "constraint_merged_source_verifier", "verifier audit operation missing");
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
  assert(script.includes("extensions/sediment/constraint-compiler/merged-source-verifier.ts"), "manual stage list missing verifier core");
  assert(script.includes("extensions/sediment/constraint-compiler/merged-source-verifier-prompt.ts"), "manual stage list missing verifier prompt");
  assert(script.includes("extensions/sediment/constraint-compiler/merged-source-verifier-llm.ts"), "manual stage list missing verifier llm");
  assert(script.includes("hasFlag(\"merged-source-verifier\") || Boolean(verifierSettings.enabled)"), "manual verifier is not explicitly opt-in");
  const verifierCreation = "const verifierInvoker = mergedSourceVerifierEnabled ? createPiAiMergedSourceVerifierInvoker";
  assert(script.includes("createPiAiMergedSourceVerifierInvoker"), "manual verifier invoker wiring missing");
  assert(script.includes("generateMergedSourceVerifier: true"), "manual verifier generator flag missing");
  assert(script.includes("const verifierPromptCap = verifierMaxPromptChars || maxPromptChars || undefined"), "manual verifier prompt cap fallback missing");
  assert(script.indexOf("if (!WRITE)") < script.indexOf(verifierCreation), "dry-run can reach verifier invoker creation");
  assert(!script.includes("agent_end"), "manual script mentions agent_end hook");
  assert(!script.includes("session_start"), "manual script mentions session_start hook");
  assert(!script.includes("before_agent_start"), "manual script mentions before_agent_start hook");
});

check("shadow settings schema exposes disabled manual compiler and verifier", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
  const cfg = schema.properties.sediment.properties.constraintShadowCompiler;
  const verifier = cfg.properties.mergedSourceVerifier;
  assert(cfg.properties.enabled.default === false, "constraint shadow compiler default is not disabled");
  assert(cfg.properties.model.default === "", "constraint shadow compiler model should not be hardcoded");
  assert(verifier.additionalProperties === false, "mergedSourceVerifier should reject additional properties");
  assert(verifier.default.enabled === false && verifier.default.model === "" && verifier.default.maxPromptChars === 0, "mergedSourceVerifier object default incomplete");
  assert(verifier.properties.enabled.default === false, "mergedSourceVerifier default is not disabled");
  assert(verifier.properties.model.default === "", "mergedSourceVerifier model should not be hardcoded");
  assert(verifier.properties.maxPromptChars.default === 0, "mergedSourceVerifier maxPromptChars default should be 0");
  assert(verifier.description.includes("data-only") && verifier.description.includes("never read by runtime injection"), "mergedSourceVerifier data-only/runtime text missing");
});

check("shadow settings parser keeps merged-source verifier default-off and normalizes explicit config", () => {
  const defaults = resolveSedimentSettingsWithConfig({ sediment: { constraintShadowCompiler: {} } });
  assert(defaults.constraintShadowCompiler.mergedSourceVerifier.enabled === false, "settings default verifier enabled");
  assert(defaults.constraintShadowCompiler.mergedSourceVerifier.model === "", "settings default verifier model should be empty");
  assert(defaults.constraintShadowCompiler.mergedSourceVerifier.maxPromptChars === 0, "settings default verifier maxPromptChars should be 0");

  const explicit = resolveSedimentSettingsWithConfig({
    sediment: {
      constraintShadowCompiler: {
        model: " compiler/model ",
        maxPromptChars: 500.9,
        mergedSourceVerifier: { enabled: true, model: " verifier/model ", maxPromptChars: "123.9" },
      },
    },
  });
  assert(explicit.constraintShadowCompiler.model === "compiler/model", "compiler model not trimmed");
  assert(explicit.constraintShadowCompiler.mergedSourceVerifier.enabled === true, "explicit verifier not enabled");
  assert(explicit.constraintShadowCompiler.mergedSourceVerifier.model === "verifier/model", "verifier model not trimmed");
  assert(explicit.constraintShadowCompiler.mergedSourceVerifier.maxPromptChars === 123, "verifier maxPromptChars not floored");

  const clamped = resolveSedimentSettingsWithConfig({ sediment: { constraintShadowCompiler: { mergedSourceVerifier: { maxPromptChars: -10 } } } });
  assert(clamped.constraintShadowCompiler.mergedSourceVerifier.maxPromptChars === 0, "verifier maxPromptChars not clamped non-negative");
});

check("auto-refresh verifier generator is default-off and gated by mergedSourceVerifier.enabled", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "constraint-compiler", "auto-refresh.ts"), "utf8");
  assert(source.includes("createPiAiMergedSourceVerifierInvoker"), "auto-refresh verifier invoker import missing");
  assert(source.includes("const verifierSettings = trigger.settings.constraintShadowCompiler.mergedSourceVerifier"), "auto-refresh verifier settings read missing");
  assert(source.includes("...(verifierSettings.enabled ? {"), "auto-refresh verifier path is not gated by enabled flag");
  assert(source.includes("generateMergedSourceVerifier: true"), "auto-refresh generator flag missing");
  assert(source.includes("verifierSettings.model || modelRef"), "auto-refresh verifier model fallback missing");
  assert(source.includes("verifierSettings.maxPromptChars") && source.includes("auto.maxPromptChars") && source.includes("trigger.settings.constraintShadowCompiler.maxPromptChars"), "auto-refresh verifier max prompt fallback missing");
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
  const runDir = result.ok && result.artifacts ? result.artifacts.runDir.split(path.sep).join("/") : "";
  assert(runDir.includes(".state/sediment/constraint-shadow/runs/fixture-run"), "artifact run dir outside shadow state");
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
  const compilerInvoker = async ({ prompt }) => {
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
          triggerPhrases: ["edit/write"],
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
  };
  const baseRunOptions = {
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    knownProjectIds: ["pi-astack"],
    writeArtifacts: true,
    nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    compilerInvoker,
  };
  const result = await runConstraintShadowCompiler({
    ...baseRunOptions,
    runId: "fixture-event-run",
  });
  assert(result.ok, "runner event success path failed");
  assert(result.ok && result.eventCoverage?.summary.projectedEvents === 1, "event coverage did not project event");
  assert(result.ok && result.eventCoverage?.rows.some((row) => row.coverageDisposition?.action === "count_projected"), "event coverage row disposition missing");
  assert(result.ok && result.legacyParallelDelta?.summary.matchedOutcomes === 1, "legacy delta did not match event");
  const latestCoveragePath = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "event-coverage.json");
  assert(fs.existsSync(latestCoveragePath), "event coverage artifact missing");
  const latestCoverage = JSON.parse(fs.readFileSync(latestCoveragePath, "utf8"));
  assert(latestCoverage.rows.some((row) => row.coverageDisposition?.action === "count_projected"), "latest event coverage row disposition missing");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "legacy-parallel-delta.json")), "legacy delta artifact missing");
  const latestVerifierPath = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "merged-source-verifier.json");
  assert(!fs.existsSync(latestVerifierPath), "merged-source verifier artifact written without sidecar input");

  const scannedEvents = await scanConstraintEvidenceEvents({ abrainHome });
  assert(result.ok, "cannot build verifier sidecar from failed run");
  const mergedSourceVerifier = {
    schemaVersion: "constraint-merged-source-verifier/v1",
    inputRootHash: result.decision.inputRootHash,
    decisionValidationHash: result.decision.validationHash,
    decisionHash: mergedSourceVerifierDecisionHash(result.decision),
    verifierInputHash: mergedSourceVerifierInputHash(scannedEvents.events, result.decision),
    summary: { totalRows: 0, expressedRows: 0, notExpressedRows: 0, uncertainRows: 0 },
    rows: [],
  };
  const failedWithVerifier = await runConstraintShadowCompiler({
    ...baseRunOptions,
    runId: "fixture-event-run-with-verifier-failed",
    mergedSourceVerifier,
    compilerInvoker: async () => ({ ok: false, error: "offline fixture failure" }),
  });
  assert(!failedWithVerifier.ok, "runner failure fixture unexpectedly succeeded");
  assert(!fs.existsSync(latestVerifierPath), "failure run wrote latest merged-source verifier artifact");
  assert(!fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "fixture-event-run-with-verifier-failed", "merged-source-verifier.json")), "failure run wrote run merged-source verifier artifact");

  const invalidMergedSourceVerifier = {
    ...mergedSourceVerifier,
    summary: { ...mergedSourceVerifier.summary, totalRows: 1 },
  };
  const resultWithInvalidVerifier = await runConstraintShadowCompiler({
    ...baseRunOptions,
    runId: "fixture-event-run-with-invalid-verifier",
    mergedSourceVerifier: invalidMergedSourceVerifier,
  });
  assert(resultWithInvalidVerifier.ok, "runner invalid sidecar success path failed");
  assert(resultWithInvalidVerifier.ok && !resultWithInvalidVerifier.mergedSourceVerifier, "runner returned invalid verifier sidecar");
  assert(!fs.existsSync(latestVerifierPath), "invalid sidecar run wrote latest merged-source verifier artifact");
  assert(!fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "fixture-event-run-with-invalid-verifier", "merged-source-verifier.json")), "invalid sidecar run wrote run merged-source verifier artifact");

  const resultWithVerifier = await runConstraintShadowCompiler({
    ...baseRunOptions,
    runId: "fixture-event-run-with-verifier",
    mergedSourceVerifier,
  });
  assert(resultWithVerifier.ok, "runner sidecar artifact path failed");
  assert(resultWithVerifier.ok && resultWithVerifier.mergedSourceVerifier?.verifierInputHash === mergedSourceVerifier.verifierInputHash, "runner did not return verifier sidecar");
  assert(fs.existsSync(latestVerifierPath), "latest merged-source verifier artifact missing");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "fixture-event-run-with-verifier", "merged-source-verifier.json")), "run merged-source verifier artifact missing");
  const latestVerifier = JSON.parse(fs.readFileSync(latestVerifierPath, "utf8"));
  assert(latestVerifier.verifierInputHash === mergedSourceVerifier.verifierInputHash, "latest verifier artifact content mismatch");
  const failedAfterSuccess = await runConstraintShadowCompiler({
    ...baseRunOptions,
    runId: "fixture-event-run-without-verifier-failed-after-success",
    compilerInvoker: async () => ({ ok: false, error: "offline fixture failure" }),
  });
  assert(!failedAfterSuccess.ok, "runner post-success failure fixture unexpectedly succeeded");
  assert(!fs.existsSync(latestVerifierPath), "failure without valid sidecar did not clear latest merged-source verifier artifact");
  assert(!fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "fixture-event-run-without-verifier-failed-after-success", "merged-source-verifier.json")), "post-success failure run wrote run merged-source verifier artifact");
});

function extractVerifierPromptRow(promptText) {
  const last = (pattern) => {
    const matches = [...promptText.matchAll(pattern)];
    return matches[matches.length - 1]?.[1];
  };
  const eventId = last(/"eventId":"([^"]+)"/g);
  const sourceRecordId = last(/"sourceRecordId":"([^"]+)"/g);
  const targetConstraintId = last(/"targetConstraintId":"([^"]+)"/g);
  assert(eventId && sourceRecordId && targetConstraintId, "verifier prompt row binding missing");
  return { eventId, sourceRecordId, targetConstraintId };
}

function mergedSourceRunnerDecisionText(eventSourceId) {
  return JSON.stringify({
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: "ignored-by-parser",
    constraints: [{
      scope: { kind: "global" },
      injectMode: "always",
      title: "Use edit/write",
      compiledBody: "修改文件必须用 edit/write，禁止 sed -i。",
      triggerPhrases: ["edit/write"],
      sourceRecordIds: ["rule:global:always:use-edit-not-sed", eventSourceId],
    }],
    exclusions: [],
    unresolved: [],
    merges: [{ sourceRecordIds: [eventSourceId], reason: "runner generated verifier fixture" }],
    rescopeProposals: [],
    mappings: [
      { sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" },
      { sourceRecordId: eventSourceId, disposition: "merged_source" },
    ],
    diagnostics: [],
  });
}

async function runMergedSourceGeneratorFixture(input = {}) {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-verifier-gen-"));
  writeFile(path.join(abrainHome, "rules/always/use-edit-not-sed.md"), "---\ntitle: Use edit not sed\nstatus: active\nkind: preference\n---\n# Use edit not sed\n\n修改文件必须用 edit/write，禁止 sed -i。\n");
  const event = writeConstraintEvidenceEvent(abrainHome, {
    session_id: input.sessionId ?? `verifier-${input.runId ?? "run"}`,
    turn_id: "turn",
    created_at_utc: "2026-06-19T00:00:00.000Z",
    legacy_parallel_write: { attempted: false, legacy_operation_hint: "none" },
  });
  const eventSourceId = `event:${event.event_id}`;
  const base = {
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    knownProjectIds: ["pi-astack"],
    writeArtifacts: true,
    nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
    runId: input.runId ?? "generated-verifier-run",
    compilerInvoker: async () => ({ ok: true, text: mergedSourceRunnerDecisionText(eventSourceId) }),
  };
  const result = await runConstraintShadowCompiler({
    ...base,
    generateMergedSourceVerifier: input.generateMergedSourceVerifier ?? true,
    ...(input.verifierInvoker !== undefined ? { verifierInvoker: input.verifierInvoker } : {}),
    ...(input.verifierModelRef !== undefined ? { verifierModelRef: input.verifierModelRef } : {}),
  });
  return { abrainHome, eventSourceId, result, latestVerifierPath: path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "merged-source-verifier.json") };
}

check("merged-source verifier prompt/parse/run builds expressed report with local hashes", async () => {
  const mergedEvent = eventSource({
    sourceId: "event:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    eventId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    candidateText: "修改文件必须用 edit/write。",
    bodyHash: "e".repeat(64),
  });
  const events = [mergedEvent];
  const localDecision = validateConstraintCompilerDecision(events, {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: normalizeConstraintSources(events).inputRootHash,
    constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit/write", compiledBody: "修改文件必须用 edit/write。", triggerPhrases: ["edit/write"], sourceRecordIds: [mergedEvent.sourceId] }],
    exclusions: [], unresolved: [], merges: [{ sourceRecordIds: [mergedEvent.sourceId], reason: "fixture merge" }], rescopeProposals: [],
    mappings: [{ sourceRecordId: mergedEvent.sourceId, disposition: "merged_source" }],
    diagnostics: [],
  });
  const inputRows = buildMergedSourceVerifierInputRows(events, localDecision);
  assert(inputRows.length === 1, "verifier input row missing");
  const prompt = buildMergedSourceVerifierPrompt({ events, decision: localDecision });
  assert(prompt.schemaVersion === "constraint-merged-source-verifier-prompt/v1", "wrong verifier prompt schema");
  assert(prompt.verifierInputHash === mergedSourceVerifierInputHash(events, localDecision), "prompt verifier input hash mismatch");
  assert(prompt.promptHash === sha256Hex(prompt.text), "promptHash not sha256(text)");
  assert(prompt.rowCount === 1 && prompt.text.includes("Return JSON only") && prompt.text.includes("Do not output hashes"), "verifier prompt instructions missing");
  const modelRow = { eventId: inputRows[0].eventId, sourceRecordId: inputRows[0].sourceRecordId, targetConstraintId: inputRows[0].targetConstraintId, verdict: "expressed", confidence: "medium", reasoning: "event text is present" };
  const parsed = parseMergedSourceVerifierOutput(`\`\`\`json\n${JSON.stringify({ rows: [modelRow] })}\n\`\`\``, { prompt, events, decision: localDecision });
  assert(parsed.ok && parsed.rows[0].verdict === "expressed", "verifier parser rejected expressed row");
  const report = createMergedSourceVerifierReport({ events, decision: localDecision, verdictRows: parsed.rows });
  assert(report.rows[0].eventBodyHash === mergedEvent.bodyHash, "report did not use local event body hash");
  assert(report.rows[0].targetContentHash === targetContentHashForConstraint(localDecision.constraints[0]), "report did not use local target content hash");
  const run = await runMergedSourceVerifierWithInvoker({
    events,
    decision: localDecision,
    invoker: async ({ prompt }) => ({ ok: true, text: JSON.stringify({ rows: [{ ...extractVerifierPromptRow(prompt.text), verdict: "expressed", confidence: "medium", reasoning: "fixture" }] }) }),
  });
  assert(run.ok && run.report.summary.expressedRows === 1, "verifier invoker run did not produce expressed report");
});

check("shadow runner generator expressed writes sidecar and projects via verifier", async () => {
  const baseline = await runMergedSourceGeneratorFixture({ generateMergedSourceVerifier: false, runId: "generator-baseline", sessionId: "generator-same-input" });
  assert(baseline.result.ok && !baseline.result.mergedSourceVerifier, "baseline unexpectedly produced verifier");
  const generated = await runMergedSourceGeneratorFixture({
    runId: "generator-expressed",
    sessionId: "generator-same-input",
    verifierModelRef: "fixture-verifier-model",
    verifierInvoker: async ({ prompt, modelRef }) => ({ ok: true, modelRef, durationMs: 12, text: JSON.stringify({ rows: [{ ...extractVerifierPromptRow(prompt.text), verdict: "expressed", confidence: "medium", reasoning: "target expresses event" }] }) }),
  });
  assert(generated.result.ok, "generated verifier run failed");
  assert(generated.result.ok && generated.result.mergedSourceVerifier?.summary.expressedRows === 1, "generated verifier sidecar missing");
  assert(generated.result.ok && generated.result.eventCoverage?.rows.some((row) => row.coverageDisposition?.kind === "projected_via_verifier"), "coverage did not project via verifier");
  assert(fs.existsSync(generated.latestVerifierPath), "generated verifier artifact missing");
  assert(generated.result.ok && generated.result.mergedSourceVerifier.decisionValidationHash === generated.result.decision.validationHash, "verifier decisionValidationHash mismatch");
  const latestVerifier = JSON.parse(fs.readFileSync(generated.latestVerifierPath, "utf8"));
  assert(latestVerifier.generator?.modelRef === "fixture-verifier-model", "generated verifier metadata modelRef missing");
  assert(typeof latestVerifier.generator?.promptHash === "string" && latestVerifier.generator.promptHash.length === 64, "generated verifier metadata promptHash missing");
  assert(typeof latestVerifier.generator?.rawOutputHash === "string" && latestVerifier.generator.rawOutputHash.length === 64, "generated verifier metadata rawOutputHash missing");
  assert(typeof latestVerifier.generator?.parsedOutputHash === "string" && latestVerifier.generator.parsedOutputHash.length === 64, "generated verifier metadata parsedOutputHash missing");
  assert(latestVerifier.generator?.durationMs === 12, "generated verifier metadata durationMs missing");
});

check("shadow runner generator not_expressed writes sidecar but remains deferred", async () => {
  const generated = await runMergedSourceGeneratorFixture({
    runId: "generator-not-expressed",
    verifierInvoker: async ({ prompt }) => ({ ok: true, text: JSON.stringify({ rows: [{ ...extractVerifierPromptRow(prompt.text), verdict: "not_expressed", confidence: "high", reasoning: "target omits event" }] }) }),
  });
  assert(generated.result.ok && generated.result.mergedSourceVerifier?.summary.notExpressedRows === 1, "not_expressed verifier sidecar missing");
  const row = generated.result.ok && generated.result.eventCoverage?.rows.find((item) => item.sourceRecordId === generated.eventSourceId);
  assert(row && row.coverageDisposition?.kind === "deferred_merged_source", "not_expressed row should remain deferred");
  assert(generated.result.ok && generated.result.diagnostics.some((diagnostic) => diagnostic.code === "SC_MERGED_SOURCE_VERIFIER_NOT_EXPRESSED"), "not_expressed diagnostic missing");
});

check("shadow runner generator parse failure is ok:true and absent", async () => {
  const generated = await runMergedSourceGeneratorFixture({
    runId: "generator-parse-failure",
    verifierInvoker: async () => ({ ok: true, text: "not-json" }),
  });
  assert(generated.result.ok, "parse failure should not fail runner");
  assert(generated.result.ok && !generated.result.mergedSourceVerifier, "parse failure returned verifier sidecar");
  assert(generated.result.ok && generated.result.eventCoverage?.rows.some((row) => row.coverageDisposition?.kind === "deferred_merged_source"), "parse failure did not remain deferred");
  assert(generated.result.ok && generated.result.diagnostics.some((diagnostic) => diagnostic.code === "SC_MERGED_SOURCE_VERIFIER_PARSE_FAILED"), "parse failure diagnostic missing");
  assert(!fs.existsSync(generated.latestVerifierPath), "parse failure wrote verifier artifact");
});

check("shadow runner generator model unavailable and missing invoker are ok:true and absent", async () => {
  const unavailable = await runMergedSourceGeneratorFixture({
    runId: "generator-model-unavailable",
    verifierInvoker: async () => ({ ok: false, error: "offline verifier unavailable" }),
  });
  assert(unavailable.result.ok && !unavailable.result.mergedSourceVerifier, "model unavailable returned verifier sidecar");
  assert(unavailable.result.ok && unavailable.result.diagnostics.some((diagnostic) => diagnostic.code === "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE"), "model unavailable diagnostic missing");
  assert(!fs.existsSync(unavailable.latestVerifierPath), "model unavailable wrote verifier artifact");

  const missing = await runMergedSourceGeneratorFixture({ runId: "generator-missing-invoker" });
  assert(missing.result.ok && !missing.result.mergedSourceVerifier, "missing invoker returned verifier sidecar");
  assert(missing.result.ok && missing.result.diagnostics.some((diagnostic) => diagnostic.code === "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE" && diagnostic.data?.error === "verifier invoker missing"), "missing invoker diagnostic missing");
  assert(!fs.existsSync(missing.latestVerifierPath), "missing invoker wrote verifier artifact");
});

check("shadow runner generator with no merged rows writes an empty verifier report", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-verifier-empty-"));
  writeFile(path.join(abrainHome, "rules/always/use-edit-not-sed.md"), "---\ntitle: Use edit not sed\nstatus: active\nkind: preference\n---\n# Use edit not sed\n\n修改文件必须用 edit/write，禁止 sed -i。\n");
  let verifierInvoked = false;
  const result = await runConstraintShadowCompiler({
    abrainHome,
    cwd: repoRoot,
    includeProjects: [],
    includeStatuses: "all",
    knownProjectIds: ["pi-astack"],
    writeArtifacts: true,
    runId: "generator-no-merged-rows",
    generateMergedSourceVerifier: true,
    verifierInvoker: async () => {
      verifierInvoked = true;
      return { ok: false, error: "verifier should not run for zero rows" };
    },
    compilerInvoker: async () => ({ ok: true, text: JSON.stringify({
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash: "ignored-by-parser",
      constraints: [{
        scope: { kind: "global" },
        injectMode: "always",
        title: "Use edit/write",
        compiledBody: "修改文件必须用 edit/write，禁止 sed -i。",
        sourceRecordIds: ["rule:global:always:use-edit-not-sed"],
      }],
      exclusions: [],
      unresolved: [],
      merges: [],
      rescopeProposals: [],
      mappings: [{ sourceRecordId: "rule:global:always:use-edit-not-sed", disposition: "compiled" }],
      diagnostics: [],
    }) }),
  });
  assert(result.ok, "no merged rows generator run failed");
  assert(!verifierInvoked, "no merged rows invoked verifier model");
  assert(result.ok && !result.diagnostics.some((diagnostic) => diagnostic.code === "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE"), "no merged rows emitted verifier unavailable diagnostic");
  assert(result.ok && result.mergedSourceVerifier?.summary.totalRows === 0, "no merged rows empty verifier report missing");
  const lookup = result.ok ? buildMergedSourceVerifierLookup({ events: [], decision: result.decision, verifier: result.mergedSourceVerifier }) : undefined;
  assert(lookup?.reportStatus === "valid", "no merged rows verifier lookup was not valid");
  assert(result.ok && result.artifacts?.files.mergedSourceVerifier === "merged-source-verifier.json", "no merged rows artifact files missing verifier path");
  const latestVerifierPath = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "merged-source-verifier.json");
  const runVerifierPath = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "runs", "generator-no-merged-rows", "merged-source-verifier.json");
  assert(fs.existsSync(latestVerifierPath), "no merged rows latest verifier artifact missing");
  assert(fs.existsSync(runVerifierPath), "no merged rows run verifier artifact missing");
  const latestVerifier = JSON.parse(fs.readFileSync(latestVerifierPath, "utf8"));
  assert(latestVerifier.summary.totalRows === 0, "no merged rows latest verifier summary mismatch");
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
  assert(l2.includes(`decision_hash: ${r1.l2Projection.decisionHash}\n`), "L2 missing decision_hash");
  assert(!l2.includes("sediment_projection_event_id"), "L2 must be device-independent (no projection event_id in rendered bytes)");
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

// --- ADR0039 §B: validation/parse-feedback retry loop (T0 consensus 2026-06-23) ---
const RETRY_RULE_REL = "rules/always/use-edit-not-sed.md";
const RETRY_SOURCE_ID = "rule:global:always:use-edit-not-sed";
const writeRetryRule = (home) => writeFile(path.join(home, RETRY_RULE_REL), "---\ntitle: Use edit not sed\nstatus: active\nkind: preference\n---\n# Use edit not sed\n\n修改文件必须用 edit/write，禁止 sed -i。\n");
const retryDecision = (sourceForMapping) => JSON.stringify({
  schemaVersion: "constraint-shadow-decision/v1",
  inputRootHash: "ignored-by-parser",
  constraints: [{ scope: { kind: "global" }, injectMode: "always", title: "Use edit/write", compiledBody: "修改文件必须用 edit/write，禁止 sed -i。", sourceRecordIds: [RETRY_SOURCE_ID] }],
  exclusions: [], unresolved: [], merges: [], rescopeProposals: [],
  mappings: [{ sourceRecordId: sourceForMapping, disposition: "compiled" }],
  diagnostics: [],
});
const retryValidText = retryDecision(RETRY_SOURCE_ID);
const retryInvalidText = retryDecision("missing-source");

check("ADR0039 §B: retry loop recovers after a validation failure (re-prompt carries the exact error)", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-retry-recover-"));
  writeRetryRule(abrainHome);
  const calls = [];
  const result = await runConstraintShadowCompiler({
    abrainHome, cwd: repoRoot, includeProjects: [], includeStatuses: "all",
    writeArtifacts: false, runId: "retry-recover", maxCompileRetries: 2,
    modelRef: "primary/model", knownProjectIds: [],
    compilerInvoker: async ({ prompt, modelRef }) => {
      calls.push({ modelRef, text: prompt.text });
      return { ok: true, text: calls.length === 1 ? retryInvalidText : retryValidText };
    },
  });
  assert(result.ok, `retry should recover to ok; diagnostics=${JSON.stringify(result.diagnostics?.map((d) => d.code))}`);
  assert(calls.length === 2, `expected 2 invoker calls, got ${calls.length}`);
  assert(calls[1].text.includes("## RETRY 1"), "retry prompt missing feedback header");
  assert(/sourceRecordIds|disposition|missing-source/.test(calls[1].text), "retry prompt did not carry the validation error text");
  assert(result.diagnostics.some((d) => d.code === "SC_COMPILER_RETRY_ATTEMPT"), "retry diagnostic missing on recovered run");
});

check("ADR0039 §B: retry loop exhausts gracefully (ok:false, no throw, bounded 1+maxCompileRetries attempts)", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-retry-exhaust-"));
  writeRetryRule(abrainHome);
  let calls = 0;
  const result = await runConstraintShadowCompiler({
    abrainHome, cwd: repoRoot, includeProjects: [], includeStatuses: "all",
    writeArtifacts: false, runId: "retry-exhaust", maxCompileRetries: 2,
    modelRef: "primary/model", knownProjectIds: [],
    compilerInvoker: async () => { calls += 1; return { ok: true, text: retryInvalidText }; },
  });
  assert(!result.ok, "exhausted retries should be ok:false");
  assert(calls === 3, `expected 3 attempts (1+2), got ${calls}`);
  assert(result.diagnostics.some((d) => d.code === "SC_COMPILER_VALIDATION_FAILED"), "final validation diagnostic missing");
  assert(result.diagnostics.some((d) => d.code === "SC_COMPILER_RETRY_ATTEMPT"), "retry attempt diagnostic missing");
});

check("ADR0039 §B: the FINAL retry attempt escalates to escalationModelRef", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-retry-escalate-"));
  writeRetryRule(abrainHome);
  const seenModels = [];
  const result = await runConstraintShadowCompiler({
    abrainHome, cwd: repoRoot, includeProjects: [], includeStatuses: "all",
    writeArtifacts: false, runId: "retry-escalate", maxCompileRetries: 1,
    modelRef: "primary/model", escalationModelRef: "escalation/model", knownProjectIds: [],
    compilerInvoker: async ({ modelRef }) => {
      seenModels.push(modelRef);
      return { ok: true, text: seenModels.length < 2 ? retryInvalidText : retryValidText };
    },
  });
  assert(result.ok, `escalated retry should recover; diagnostics=${JSON.stringify(result.diagnostics?.map((d) => d.code))}`);
  assert(seenModels[0] === "primary/model", `first attempt should use primary, got ${seenModels[0]}`);
  assert(seenModels[1] === "escalation/model", `final attempt should escalate, got ${seenModels[1]}`);
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

// ── Auto-refresh cross-process lock (runOnce) ──

checkAutoRefresh("auto-refresh runOnce acquires and releases cross-process lock", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-lock-"));
  const abrainHome = path.join(home, "abrain");
  const locksDir = abrainSedimentLocksDir(abrainHome);
  const lockPath = path.join(locksDir, "constraint-shadow-auto-refresh.lock");

  // Acquire a lock manually to simulate another pi instance holding it
  const holder = await acquireFileLock(lockPath, {
    timeoutMs: 1_000,
    staleMs: 30 * 60 * 1_000,
    label: "test-holder",
  });

  try {
    // Now try to run auto-refresh — it should fail to acquire the lock and audit lock_contended
    const settings = resolveSedimentSettingsWithConfig({
      sediment: {
        constraintShadowCompiler: {
          enabled: true,
          model: "test/model",
          autoRefresh: { enabled: true, debounceMs: 0, minIntervalMs: 0, eventStaleAfterMs: 86400000, maxPromptChars: 0 },
        },
      },
    });

    // We need a modelRegistry-like object for the runOnce to pass the gate
    const fakeRegistry = {
      find: () => ({ id: "test/model" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }),
    };

    // runOnce will try to acquire the lock, fail, and audit lock_contended
    // It will NOT run the actual compiler because the lock is held
    await _runConstraintShadowAutoRefreshNowForTests({
      abrainHome,
      cwd: home,
      settings,
      modelRegistry: fakeRegistry,
      reason: "smoke_test",
    });

    // Check the audit file for lock_contended
    const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
    assert(fs.existsSync(auditFile), "auto-refresh audit file should exist");
    const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean);
    const lastRow = JSON.parse(lines[lines.length - 1]);
    assert(lastRow.status === "lock_contended", `expected lock_contended, got ${lastRow.status}`);
    assert(lastRow.ok === false, "lock_contended row should be ok=false");

    const markerFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");
    assert(fs.existsSync(markerFile), "needs-refresh marker should exist after lock contention");
    const markerRows = readJsonlRows(markerFile);
    const marker = markerRows[markerRows.length - 1];
    assert(marker.schemaVersion === "constraint-shadow-auto-refresh-needs-refresh/v1", "needs-refresh marker schema mismatch");
    assert(typeof marker.observedAtUtc === "string" && Number.isFinite(Date.parse(marker.observedAtUtc)), "needs-refresh marker observedAtUtc missing");
    assert(marker.reason === "smoke_test", "needs-refresh marker reason mismatch");
    assert(marker.sourceEventId === null, "needs-refresh marker sourceEventId should be null");
    assert(marker.modelRef === "test/model", "needs-refresh marker modelRef mismatch");
  } finally {
    await holder.release();
    _resetConstraintShadowAutoRefreshForTests();
  }
});

checkAutoRefresh("auto-refresh lock contention marker schedules follow-up after holder releases", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const oldDelays = globalThis.__constraintShadowSmokePiAiDelaysMs;
  const oldDelay = globalThis.__constraintShadowSmokePiAiDelayMs;
  const oldText = globalThis.__constraintShadowSmokePiAiText;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-needs-refresh-"));
  const abrainHome = path.join(home, "abrain");
  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  const markerFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");

  try {
    globalThis.__constraintShadowSmokePiAiDelaysMs = [7_000, 0];
    globalThis.__constraintShadowSmokePiAiDelayMs = 0;
    globalThis.__constraintShadowSmokePiAiText = undefined;
    globalThis.__constraintShadowSmokePiAiCallCount = 0;

    const settings = resolveSedimentSettingsWithConfig({
      sediment: {
        constraintShadowCompiler: {
          enabled: true,
          model: "test/model",
          autoRefresh: { enabled: true, debounceMs: 10, minIntervalMs: 0, eventStaleAfterMs: 86400000, maxPromptChars: 0 },
        },
      },
    });
    const fakeRegistry = {
      find: () => ({ id: "test/model" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }),
    };
    const trigger = {
      abrainHome,
      cwd: home,
      settings,
      modelRegistry: fakeRegistry,
      reason: "holder_smoke",
    };

    const holderRun = _runConstraintShadowAutoRefreshNowForTests(trigger);
    await waitFor("holder auto-refresh start audit", () => readJsonlRows(auditFile).some((row) => row.status === "started"), 2_000);

    await _runConstraintShadowAutoRefreshNowForTests({
      ...trigger,
      reason: "contended_smoke",
      sourceEventId: "d".repeat(64),
    });
    const markerRows = readJsonlRows(markerFile);
    assert(markerRows.some((row) => row.reason === "contended_smoke" && row.sourceEventId === "d".repeat(64)), "contended run did not persist needs-refresh marker");

    await holderRun;
    await waitFor("needs-refresh follow-up auto-refresh completion", () => readJsonlRows(auditFile).filter((row) => row.status === "completed").length >= 2, 5_000);

    const rows = readJsonlRows(auditFile);
    const completedAfterFollowUp = rows.filter((row) => row.status === "completed").length;
    assert(rows.some((row) => row.status === "lock_contended" && row.reason === "contended_smoke"), "lock_contended audit missing for contended run");
    assert(rows.filter((row) => row.status === "started").length >= 2, "follow-up auto-refresh did not start after marker ledger check");
    assert(readJsonlRows(markerFile).some((row) => row.reason === "contended_smoke" && row.sourceEventId === "d".repeat(64)), "needs-refresh marker ledger should retain the contention marker");
    await sleep(100);
    assert(readJsonlRows(auditFile).filter((row) => row.status === "completed").length === completedAfterFollowUp, "old needs-refresh marker should not keep scheduling after a covering follow-up compile");
    assert(globalThis.__constraintShadowSmokePiAiCallCount >= 2, "expected holder and follow-up compiler invocations");
  } finally {
    globalThis.__constraintShadowSmokePiAiDelaysMs = oldDelays;
    globalThis.__constraintShadowSmokePiAiDelayMs = oldDelay;
    globalThis.__constraintShadowSmokePiAiText = oldText;
    _resetConstraintShadowAutoRefreshForTests();
  }
});

checkAutoRefresh("auto-refresh scheduler retries after lock contention marker", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  const oldDelays = globalThis.__constraintShadowSmokePiAiDelaysMs;
  const oldDelay = globalThis.__constraintShadowSmokePiAiDelayMs;
  const oldText = globalThis.__constraintShadowSmokePiAiText;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-scheduler-retry-"));
  const abrainHome = path.join(home, "abrain");
  const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "audit.jsonl");
  const markerFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");
  const lockPath = path.join(abrainSedimentLocksDir(abrainHome), "constraint-shadow-auto-refresh.lock");
  const holder = await acquireFileLock(lockPath, {
    timeoutMs: 1_000,
    staleMs: 30 * 60 * 1_000,
    label: "scheduler-retry-holder",
  });

  try {
    globalThis.__constraintShadowSmokePiAiDelaysMs = [0];
    globalThis.__constraintShadowSmokePiAiDelayMs = 0;
    globalThis.__constraintShadowSmokePiAiText = undefined;
    globalThis.__constraintShadowSmokePiAiCallCount = 0;

    const settings = resolveSedimentSettingsWithConfig({
      sediment: {
        constraintShadowCompiler: {
          enabled: true,
          model: "test/model",
          autoRefresh: { enabled: true, debounceMs: 10, minIntervalMs: 0, eventStaleAfterMs: 86400000, maxPromptChars: 0 },
        },
      },
    });
    const fakeRegistry = {
      find: () => ({ id: "test/model" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }),
    };

    await scheduleConstraintShadowAutoRefresh({
      abrainHome,
      cwd: home,
      settings,
      modelRegistry: fakeRegistry,
      reason: "scheduler_retry_smoke",
      sourceEventId: "e".repeat(64),
    });

    await waitFor("scheduler lock contention marker", () => readJsonlRows(markerFile).some((row) => row.reason === "scheduler_retry_smoke"), 6_500);
    await waitFor("scheduler lock contention audit", () => readJsonlRows(auditFile).some((row) => row.status === "lock_contended" && row.reason === "scheduler_retry_smoke"), 6_500);

    await holder.release();
    await waitFor("scheduler retry completion", () => readJsonlRows(auditFile).some((row) => row.status === "completed"), 6_500);
    assert(globalThis.__constraintShadowSmokePiAiCallCount >= 1, "scheduler retry did not invoke compiler after lock released");
  } finally {
    await holder.release().catch(() => undefined);
    globalThis.__constraintShadowSmokePiAiDelaysMs = oldDelays;
    globalThis.__constraintShadowSmokePiAiDelayMs = oldDelay;
    globalThis.__constraintShadowSmokePiAiText = oldText;
    _resetConstraintShadowAutoRefreshForTests();
  }
});

checkAutoRefresh("auto-refresh schedule API still returns scheduled status", async () => {
  _resetConstraintShadowAutoRefreshForTests();
  try {
    const settings = resolveSedimentSettingsWithConfig({
      sediment: {
        constraintShadowCompiler: {
          enabled: true,
          model: "test/model",
          autoRefresh: { enabled: true, debounceMs: 60_000, minIntervalMs: 0, eventStaleAfterMs: 86400000, maxPromptChars: 0 },
        },
      },
    });
    const result = await scheduleConstraintShadowAutoRefresh({
      abrainHome: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-schedule-")), "abrain"),
      cwd: os.tmpdir(),
      settings,
      modelRegistry: { find: () => ({ id: "test/model" }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }) },
      reason: "schedule_smoke",
    });
    assert(result.scheduled === true, "schedule API did not report scheduled=true");
  } finally {
    _resetConstraintShadowAutoRefreshForTests();
  }
});

check("auto-refresh failed/threw run has one bounded retry", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "constraint-compiler", "auto-refresh.ts"), "utf8");
  assert(source.includes("retryAttempt?: number"), "trigger must carry optional retryAttempt");
  assert(source.includes('terminalStatus === "failed" || terminalStatus === "threw"'), "retry must be limited to failed/threw runs");
  assert(source.includes("scheduleRecoverableRetry"), "retry helper must be used for recoverable retry paths");
  assert(source.includes("(trigger.retryAttempt ?? 0) >= 1"), "retry helper must be bounded to one attempt");
  assert(source.includes('reason: "previous_run_failed"'), "retry reason must be previous_run_failed");
  assert(source.includes('status: "retry_scheduled"'), "retry scheduling must be audited");
});

check("auto-refresh lock path is under abrainSedimentLocksDir", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "constraint-compiler", "auto-refresh.ts"), "utf8");
  assert(source.includes("abrainSedimentLocksDir"), "auto-refresh must import abrainSedimentLocksDir");
  assert(source.includes("constraint-shadow-auto-refresh.lock"), "lock file name must be constraint-shadow-auto-refresh.lock");
  assert(source.includes("acquireFileLock"), "auto-refresh must import acquireFileLock");
  assert(source.includes("timeoutMs: 5_000"), "lock timeout must be 5s");
  assert(source.includes("staleMs: 30 * 60 * 1_000"), "lock stale must be 30min");
  assert(source.includes('status: "lock_contended"'), "lock contention must audit lock_contended");
  assert(source.includes("lockHandle.release"), "lock must be released in finally");
});

check("auto-refresh lock does not cover debounce wait — only runOnce compilation", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "constraint-compiler", "auto-refresh.ts"), "utf8");
  // The lock acquisition must be inside runOnce, not in scheduleConstraintShadowAutoRefresh
  const scheduleFn = source.slice(source.indexOf("export async function scheduleConstraintShadowAutoRefresh"));
  assert(!scheduleFn.includes("acquireFileLock"), "scheduleConstraintShadowAutoRefresh must not acquire lock (debounce period)");
  // runOnce must have the lock
  const runOnceFn = source.slice(source.indexOf("async function runOnce"));
  assert(runOnceFn.includes("acquireFileLock"), "runOnce must acquire lock");
});

Promise.all(pending).finally(() => {
  if (failures.length) {
    console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
    process.exit(1);
  }
  console.log(`\nall ok — constraint shadow compiler PR2/PR3/PR4/PR6 holds (${total} assertions).`);
});
