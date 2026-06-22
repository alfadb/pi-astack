#!/usr/bin/env node
/**
 * Smoke test: ADR 0023-R5 read-only abrain rule injection.
 *
 * Covers:
 *   - scan rules/{always,listed} + project strict binding path
 *   - before_agent_start injection is append-only + idempotent
 *   - nonce stripping removes only current injected rules
 *   - no lifecycle-management commands (/rule veto/add) are exposed
 *   - brain-layout creates rules/always + rules/listed
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
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function asyncCheck(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function stageModuleTree(outRoot) {
  const files = [
    ["extensions/abrain/rule-injector/index.ts", "abrain/rule-injector/index.js"],
    ["extensions/abrain/rule-injector/dualread-audit.ts", "abrain/rule-injector/dualread-audit.js"],
    ["extensions/abrain/brain-layout.ts", "abrain/brain-layout.js"],
    ["extensions/_shared/footer-status.ts", "_shared/footer-status.js"],
    ["extensions/_shared/runtime.ts", "_shared/runtime.js"],
    ["extensions/memory/parser.ts", "memory/parser.js"],
    // ADR 0034 P1: parser.ts now imports ./direction-impact
    // (parseDirectionImpact). Stage it so the transpiled require resolves.
    ["extensions/memory/direction-impact.ts", "memory/direction-impact.js"],
    ["extensions/memory/utils.ts", "memory/utils.js"],
    ["extensions/memory/settings.ts", "memory/settings.js"],
    ["extensions/sediment/settings.ts", "sediment/settings.js"],
    ["extensions/sediment/knowledge-evidence.ts", "sediment/knowledge-evidence.js"],
  ];

  // Stub `_shared/pi-internals` — ADR 0027 PR-B added the
  // isSubAgentSession import in rule-injector. The stub returns false so
  // existing rule-injection tests still see the main-session code path.
  // (The actual sub-agent gating contract is verified by
  // smoke:vault-subpi-isolation, not this test.)
  writeFile(
    path.join(outRoot, "_shared", "pi-internals.js"),
    `module.exports = {
  markSessionAsSubAgent: () => {},
  isSubAgentSession: () => false,
};\n`,
  );

  for (const [src, dst] of files) {
    const out = transpile(path.join(repoRoot, src));
    // Strict parse catches template-literal regressions that transpileModule
    // itself may pass through.
    new (require("node:vm").Script)(out, { filename: src });
    writeFile(path.join(outRoot, dst), out);
  }
}

function writeRule(file, fm, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push("---", body.trim(), "");
  writeFile(file, lines.join("\n"));
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function legacySourceId(entry) {
  if (entry.scope === "project" && entry.projectId) return `rule:project:${entry.projectId}:${entry.injectMode}:${entry.slug}`;
  return `rule:global:${entry.injectMode}:${entry.slug}`;
}

function shadowConstraintFromRule(entry, overrides = {}) {
  return {
    constraintId: `shadow:${entry.slug}`,
    scope: entry.scope === "project" && entry.projectId ? { kind: "project", projectId: entry.projectId } : { kind: "global" },
    injectMode: entry.injectMode,
    title: entry.title,
    compiledBody: entry.body,
    mustDoSummary: entry.mustDoSummary,
    triggerPhrases: entry.triggerPhrases,
    sourceRecordIds: [legacySourceId(entry)],
    ...overrides,
  };
}

function writeShadowDecision(file, constraints) {
  writeFile(file, JSON.stringify({
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash: "input-root-hash-for-smoke",
    constraints,
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [],
    diagnostics: [],
    validationHash: "validation-hash-for-smoke",
  }, null, 2));
}

console.log("abrain rule injector — ADR 0023-R5 read path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rule-injector-"));
const outRoot = path.join(tmpRoot, "compiled");
stageModuleTree(outRoot);
const req = createRequire(path.join(outRoot, "runner.cjs"));
const ruleInjector = req("./abrain/rule-injector/index.js");
const { ensureBrainLayout } = req("./abrain/brain-layout.js");

const abrainHome = path.join(tmpRoot, "abrain");
const projectRoot = path.join(tmpRoot, "project");
fs.mkdirSync(projectRoot, { recursive: true });
const projectId = "ruleproj";
const projectDir = path.join(abrainHome, "projects", projectId);

writeRule(
  path.join(abrainHome, "rules", "always", "edit-write-only.md"),
  {
    title: "Edit Write Only",
    kind: "anti-pattern",
    status: "active",
    confidence: 10,
    provenance: "user-expressed",
    applies_when: "modifying files",
    trigger_phrases: '["edit", "write", "sed -i"]',
    must_do_summary: "Use edit/write for file modifications; never sed -i/tee/redirect-overwrite.",
  },
  "# Edit Write Only\n\n修改文件必须用 edit/write，禁止 sed -i / tee / 重定向覆写。",
);
writeRule(
  path.join(abrainHome, "rules", "listed", "multi-audit.md"),
  {
    title: "Multi Audit",
    kind: "pattern",
    status: "active",
    confidence: 8,
    hint: "三家 xhigh audit before ship",
    applies_when: "shipping large pi-astack designs",
    trigger_phrases: '["ship", "large design", "audit"]',
    must_do_summary: "Run multi-model xhigh audit before shipping large designs.",
  },
  "# Multi Audit\n\npi-astack 大设计 ship 前跑多模型审计。",
);
writeRule(
  path.join(projectDir, "rules", "always", "project-only.md"),
  {
    title: "Project Only",
    kind: "preference",
    status: "active",
    confidence: 9,
    applies_when: "working inside the bound ruleproj project",
    trigger_phrases: '["design", "code"]',
    must_do_summary: "In this project, update design docs before writing code.",
  },
  "# Project Only\n\n这个项目默认先补设计文档再写代码。",
);
writeRule(
  path.join(projectDir, "rules", "listed", "low-conf.md"),
  {
    title: "Low Conf",
    kind: "pattern",
    status: "active",
    confidence: 4,
    hint: "low-confidence rule, shows with provisional label",
    applies_when: "testing low-confidence catalog rows",
    trigger_phrases: '["low confidence"]',
    must_do_summary: "Show low-confidence active rules with confidence metadata.",
  },
  "# Low Conf\n\nlow-confidence rule body",
);

const fakeBound = () => ({
  activeProject: {
    projectId,
    matchedBy: "strict_local_map",
    cwd: projectRoot,
    lookupCwd: projectRoot,
    projectRoot,
    manifestPath: path.join(projectRoot, ".abrain-project.json"),
    registryPath: path.join(projectDir, "_project.json"),
    localMapPath: path.join(abrainHome, ".state/projects/local-map.json"),
    localPath: { path: projectRoot, first_seen: "t", last_seen: "t", confirmed_at: "t" },
    manifest: { schema_version: 1, project_id: projectId },
    registry: { schema_version: 1, project_id: projectId, created_at: "t", updated_at: "t" },
  },
});
const fakeUnbound = () => ({ activeProject: null, reason: "manifest_missing", cwd: projectRoot });

check("ensureBrainLayout creates global rules inject-mode directories", () => {
  const home = path.join(tmpRoot, "layout-home");
  const r = ensureBrainLayout(home);
  if (!fs.existsSync(path.join(home, "rules", "always"))) throw new Error("missing rules/always");
  if (!fs.existsSync(path.join(home, "rules", "listed"))) throw new Error("missing rules/listed");
  if (!r.created.includes("rules")) throw new Error(`created list missing rules: ${JSON.stringify(r)}`);
});

check("scanRules reads global + strictly-bound project rules; low-confidence rules now inject (no floor) with a confidence label", () => {
  const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "abc123", resolveProject: fakeBound });
  if (cache.globalAlways.length !== 1) throw new Error(`globalAlways=${cache.globalAlways.length}`);
  if (cache.globalListed.length !== 1) throw new Error(`globalListed=${cache.globalListed.length}`);
  if (cache.projectAlways.length !== 1) throw new Error(`projectAlways=${cache.projectAlways.length}`);
  // mechanical-guard cleanup R4/C1 (2026-06-06): the confidence floor was
  // removed; the conf-4 listed rule now injects (previously filtered to 0).
  if (cache.projectListed.length !== 1) throw new Error(`projectListed should now include low-conf (floor removed), got ${cache.projectListed.length}`);
  if (cache.projectListed[0].confidence !== 4) throw new Error(`projectListed[0] should be the conf-4 rule, got conf ${cache.projectListed[0].confidence}`);
  const section = ruleInjector.composeRuleSection(cache);
  if (!section.includes("confidence=4/10")) throw new Error(`composed listed rule should carry a confidence label, got:\n${section}`);
  if (!section.includes("catalog_tokens:") || !section.includes("hidden_catalog_count: 0")) throw new Error(`missing catalog health fields:\n${section}`);
  if (cache.activeProjectId !== projectId) throw new Error(`activeProjectId=${cache.activeProjectId}`);
});

check("scanRules does not cwd-guess project rules when strict binding is absent", () => {
  const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "abc123", resolveProject: fakeUnbound });
  if (cache.projectAlways.length !== 0 || cache.projectListed.length !== 0) {
    throw new Error("unbound scan leaked project rules");
  }
  if (cache.globalAlways.length !== 1 || cache.globalListed.length !== 1) throw new Error("global rules should still load");
  if (cache.bindingReason !== "manifest_missing") throw new Error(`bindingReason=${cache.bindingReason}`);
});

check("composeRuleInjection includes nonce and catalog rows, not full rule bodies", () => {
  const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "abc123", resolveProject: fakeBound });
  const text = ruleInjector.composeRuleInjection(cache);
  if (!text.includes("BEGIN_ABRAIN_RULES session=abc123")) throw new Error("missing nonce marker");
  if (!text.includes("## Rules Catalog")) throw new Error("missing catalog header");
  if (!text.includes("catalog_tokens:") || !text.includes("hidden_catalog_count: 0")) throw new Error("missing catalog health fields");
  if (!text.includes("global:edit-write-only | title=Edit Write Only | scope=global | inject=always")) throw new Error("missing global catalog row");
  if (!text.includes("provenance=user-expressed") || !text.includes("trigger_phrases=edit; write; sed -i")) throw new Error("missing row metadata");
  if (!text.includes("must_do_summary=Use edit/write for file modifications")) throw new Error("missing actionable summary");
  if (!text.includes(`project:${projectId}:project-only | title=Project Only | scope=project:${projectId} | inject=always`)) throw new Error("missing project catalog row");
  if (!text.includes("global:multi-audit | title=Multi Audit | scope=global | inject=listed")) throw new Error("missing listed scoped slug");
  if (text.includes("修改文件必须用 edit/write") || text.includes("这个项目默认先补设计文档")) throw new Error("full rule body leaked into catalog injection");
});

check("stripCurrentRuleInjection strips only current session nonce", () => {
  const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "abc123", resolveProject: fakeBound });
  const text = ruleInjector.composeRuleInjection(cache);
  const stripped = ruleInjector.stripCurrentRuleInjection(`before\n${text}\nafter`, "abc123");
  if (!stripped.includes("[ABRAIN_RULES_SECTION_REMOVED]")) throw new Error("missing removal marker");
  if (stripped.includes("global:edit-write-only")) throw new Error("current nonce content not stripped");
  const preserved = ruleInjector.stripCurrentRuleInjection(text, "deadbeef");
  if (!preserved.includes("global:edit-write-only")) throw new Error("wrong nonce should preserve content");
});

await asyncCheck("extension registers append-only idempotent injector and diagnostic-only /rule command", async () => {
  const prevAbrainRoot = process.env.ABRAIN_ROOT;
  const prevHome = process.env.HOME;
  try {
    process.env.ABRAIN_ROOT = abrainHome;
    process.env.HOME = path.join(tmpRoot, "home");
    const freshOut = path.join(tmpRoot, "fresh");
    stageModuleTree(freshOut);
    const freshReq = createRequire(path.join(freshOut, "runner.cjs"));
    const activate = freshReq("./abrain/rule-injector/index.js").default;
    const events = new Map();
    const commands = new Map();
    const statuses = [];
    const pi = {
      on(name, handler) {
        if (!events.has(name)) events.set(name, []);
        events.get(name).push(handler);
      },
      registerCommand(name, options) { commands.set(name, options); },
    };
    activate(pi);
    if (!commands.has("rule")) throw new Error("missing /rule command");
    const completions = commands.get("rule").getArgumentCompletions("").map((x) => x.value).join("\n");
    if (/veto|add|archive/.test(completions)) throw new Error(`management command leaked into completions:\n${completions}`);
    const sessionStart = events.get("session_start")?.[0];
    const beforeAgent = events.get("before_agent_start")?.[0];
    if (typeof sessionStart !== "function" || typeof beforeAgent !== "function") throw new Error("missing event handlers");
    await sessionStart({ reason: "startup" }, { cwd: projectRoot, ui: { setStatus(k, v) { statuses.push([k, v]); }, notify() {} } });
    const first = await beforeAgent({ systemPrompt: "BASE" }, { cwd: projectRoot });
    if (!first?.systemPrompt?.startsWith("BASE\n\n")) throw new Error("injector must append to existing prompt");
    if (!first.systemPrompt.includes("BEGIN_ABRAIN_RULES")) throw new Error("missing injected marker");
    const second = await beforeAgent({ systemPrompt: first.systemPrompt }, { cwd: projectRoot });
    if (second !== undefined) throw new Error("injector must be idempotent when marker exists");
    if (!statuses.some(([, v]) => String(v).includes("rules:"))) throw new Error(`footer status not set: ${JSON.stringify(statuses)}`);
    const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "session-start-dualread", "audit.jsonl");
    if (fs.existsSync(auditFile)) throw new Error("dual-read audit must stay off by default");
  } finally {
    if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = prevAbrainRoot;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});

check("compiled-view runtime reader is default-off, bounded, and coverage-gated", () => {
  const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "compiled123", resolveProject: fakeBound });
  const latestDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  writeShadowDecision(path.join(latestDir, "decision.json"), [shadowConstraintFromRule(cache.globalAlways[0])]);
  writeFile(path.join(latestDir, "compiled-view.md"), "# Compiled Constraint\n\nCompiled runtime body.\n");
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 1 },
    rows: [],
  }, null, 2));
  const disabled = ruleInjector.readCompiledRuleInjectionForRuntime({
    abrainHome,
    nonce: "compiled123",
    settings: {
      enabled: false,
      fallbackToLegacyOnError: true,
      requireFresh: true,
      staleAfterMs: 86400000,
      maxReadBytes: 1000000,
      minCoverageRatio: 1,
    },
  });
  if (disabled.ok || disabled.reason !== "disabled") throw new Error(`expected disabled compiled view, got ${JSON.stringify(disabled)}`);
  const ok = ruleInjector.readCompiledRuleInjectionForRuntime({
    abrainHome,
    nonce: "compiled123",
    settings: {
      enabled: true,
      fallbackToLegacyOnError: true,
      requireFresh: true,
      staleAfterMs: 86400000,
      maxReadBytes: 1000000,
      minCoverageRatio: 1,
    },
  });
  if (!ok.ok || !ok.injection.includes("source=constraint-shadow-compiled-view")) throw new Error(`compiled view did not inject: ${JSON.stringify(ok)}`);
  if (!ok.injection.includes("Compiled runtime body.")) throw new Error(`compiled view body missing: ${ok.injection}`);
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 0.5, injectableCoverageRatio: 1, deferredMergedSourceEvents: 1 },
    rows: [],
  }, null, 2));
  const deferredCoverage = ruleInjector.readCompiledRuleInjectionForRuntime({
    abrainHome,
    nonce: "compiled123",
    settings: {
      enabled: true,
      fallbackToLegacyOnError: true,
      requireFresh: true,
      staleAfterMs: 86400000,
      maxReadBytes: 1000000,
      minCoverageRatio: 1,
    },
  });
  if (!deferredCoverage.ok) throw new Error(`expected deferred merged-source coverage to inject, got ${JSON.stringify(deferredCoverage)}`);
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 0.5, injectableCoverageRatio: 0.5, deferredMergedSourceEvents: 0 },
    rows: [],
  }, null, 2));
  const lowCoverage = ruleInjector.readCompiledRuleInjectionForRuntime({
    abrainHome,
    nonce: "compiled123",
    settings: {
      enabled: true,
      fallbackToLegacyOnError: true,
      requireFresh: true,
      staleAfterMs: 86400000,
      maxReadBytes: 1000000,
      minCoverageRatio: 1,
    },
  });
  if (lowCoverage.ok || lowCoverage.reason !== "coverage_below_threshold") throw new Error(`expected coverage gate, got ${JSON.stringify(lowCoverage)}`);
});

check("dual-read audit helper is default-off and writes only constraint-shadow state when enabled", () => {
  const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "abc123", resolveProject: fakeBound });
  const dual = req("./abrain/rule-injector/dualread-audit.js");
  const disabled = dual.runRuleInjectorDualReadAudit({
    abrainHome,
    cwd: projectRoot,
    cache,
    settings: dual.resolveRuleInjectorDualReadAuditSettings(undefined),
  });
  if (disabled.status !== "disabled" || disabled.attempted !== false) throw new Error(`unexpected disabled result: ${JSON.stringify(disabled)}`);
  const disabledAudit = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "session-start-dualread", "audit.jsonl");
  if (fs.existsSync(disabledAudit)) throw new Error("disabled dual-read audit wrote an audit file");

  const latestDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  const constraints = [
    shadowConstraintFromRule(cache.globalAlways[0]),
    shadowConstraintFromRule(cache.globalListed[0], { mustDoSummary: "different summary" }),
    shadowConstraintFromRule(cache.projectAlways[0]),
    {
      constraintId: "shadow:compiled-only",
      scope: { kind: "global" },
      injectMode: "listed",
      title: "Compiled Only",
      compiledBody: "Compiled-only body",
      mustDoSummary: "Compiled-only summary",
      triggerPhrases: [],
      sourceRecordIds: ["event:compiled-only"],
    },
  ];
  writeShadowDecision(path.join(latestDir, "decision.json"), constraints);
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: {
      totalEvents: 2,
      validEvents: 2,
      invalidEvents: 0,
      queuedEvents: 1,
      projectedEvents: 1,
      staleEvents: 1,
      appendFailedEvents: 0,
      coverageRatio: 0.5,
    },
    rows: [],
  }, null, 2));
  const beforeRulesMtime = fs.statSync(path.join(abrainHome, "rules", "always", "edit-write-only.md")).mtimeMs;
  const enabled = dual.runRuleInjectorDualReadAudit({
    abrainHome,
    cwd: projectRoot,
    cache,
    settings: dual.resolveRuleInjectorDualReadAuditSettings({ enabled: true, staleAfterMs: 0 }),
    nowMs: Date.now() + 10_000,
  });
  if (enabled.status !== "delta") throw new Error(`expected delta audit, got ${JSON.stringify(enabled)}`);
  if (!enabled.auditFile?.includes(path.join(".state", "sediment", "constraint-shadow", "session-start-dualread", "audit.jsonl"))) {
    throw new Error(`audit file outside expected state path: ${enabled.auditFile}`);
  }
  const rows = readJsonLines(enabled.auditFile);
  const row = rows.at(-1);
  if (row.summary.legacyRules !== 4) throw new Error(`legacyRules=${row.summary.legacyRules}`);
  if (row.summary.compiledOnly !== 1) throw new Error(`compiledOnly=${row.summary.compiledOnly}`);
  if (row.summary.legacyOnly !== 1) throw new Error(`legacyOnly=${row.summary.legacyOnly}`);
  if (row.summary.textDelta !== 1) throw new Error(`textDelta=${row.summary.textDelta}`);
  if (row.eventCoverage.queuedEvents !== 1 || row.eventCoverage.staleEvents !== 1) throw new Error(`event coverage missing: ${JSON.stringify(row.eventCoverage)}`);
  const afterRulesMtime = fs.statSync(path.join(abrainHome, "rules", "always", "edit-write-only.md")).mtimeMs;
  if (afterRulesMtime !== beforeRulesMtime) throw new Error("dual-read audit changed a rule file");
});

await asyncCheck("dual-read audit flag on preserves injected system prompt bytes", async () => {
  const prevAbrainRoot = process.env.ABRAIN_ROOT;
  const prevHome = process.env.HOME;
  const crypto = require("node:crypto");
  const originalRandomBytes = crypto.randomBytes;
  const fixedNonce = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  async function runFresh(flagHome, compiledDir) {
    process.env.HOME = flagHome;
    stageModuleTree(compiledDir);
    const freshReq = createRequire(path.join(compiledDir, "runner.cjs"));
    const activate = freshReq("./abrain/rule-injector/index.js").default;
    const events = new Map();
    const pi = {
      on(name, handler) {
        if (!events.has(name)) events.set(name, []);
        events.get(name).push(handler);
      },
      registerCommand() {},
    };
    activate(pi);
    const sessionStart = events.get("session_start")?.[0];
    const beforeAgent = events.get("before_agent_start")?.[0];
    await sessionStart({ reason: "startup" }, { cwd: projectRoot, ui: { setStatus() {}, notify() {} } });
    return beforeAgent({ systemPrompt: "BASE" }, { cwd: projectRoot });
  }
  try {
    process.env.ABRAIN_ROOT = abrainHome;
    crypto.randomBytes = () => Buffer.from(fixedNonce);
    const cache = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: fixedNonce.toString("hex"), resolveProject: fakeBound });
    writeShadowDecision(
      path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "decision.json"),
      [
        shadowConstraintFromRule(cache.globalAlways[0]),
        shadowConstraintFromRule(cache.globalListed[0]),
        shadowConstraintFromRule(cache.projectAlways[0]),
        shadowConstraintFromRule(cache.projectListed[0]),
      ],
    );
    const offHome = path.join(tmpRoot, "home-dualread-off");
    const onHome = path.join(tmpRoot, "home-dualread-on");
    writeFile(path.join(offHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
      ruleInjector: { dualReadAudit: { enabled: false } },
    }, null, 2));
    writeFile(path.join(onHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
      ruleInjector: { dualReadAudit: { enabled: true, staleAfterMs: 0 } },
    }, null, 2));
    const withoutAudit = await runFresh(offHome, path.join(tmpRoot, "fresh-dualread-off"));
    const withAudit = await runFresh(onHome, path.join(tmpRoot, "fresh-dualread-on"));
    if (withAudit.systemPrompt !== withoutAudit.systemPrompt) throw new Error("dual-read audit changed injected prompt bytes");
    const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "session-start-dualread", "audit.jsonl");
    const row = readJsonLines(auditFile).at(-1);
    if (!row || row.schemaVersion !== "rule-injector-dualread-audit/v1") throw new Error(`missing dual-read audit row: ${JSON.stringify(row)}`);
  } finally {
    crypto.randomBytes = originalRandomBytes;
    if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = prevAbrainRoot;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});

check("source does not expose /rule veto/add or rule writer", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/abrain/rule-injector/index.ts"), "utf8");
  if (/registerCommand\("rule"[\s\S]*veto/.test(src)) throw new Error("/rule veto must not be registered in R5 read path");
  if (/registerCommand\("rule"[\s\S]*add/.test(src)) throw new Error("/rule add must not be registered in R5 read path");
  if (/writeAbrainRule/.test(src)) throw new Error("R5 read path must not implement writeAbrainRule");
});

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nall ok — abrain rule injector holds (${total} assertions).`);
