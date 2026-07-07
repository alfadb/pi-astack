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

import crypto from "node:crypto";
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

function normalizedBodyHash(value) {
  return crypto.createHash("sha256").update(String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim()).digest("hex");
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

function writeShadowDecision(file, constraints, overrides = {}) {
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
    ...overrides,
  }, null, 2));
}

function writeShadowDiff(file, rows) {
  writeFile(file, JSON.stringify({
    schemaVersion: "constraint-shadow-diff/v1",
    summary: {},
    rows,
    markdown: "# fixture diff\n",
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

function writeBasicRuleSet(root) {
  writeRule(
    path.join(root, "rules", "always", "legacy-fallback.md"),
    {
      title: "Legacy Fallback",
      kind: "pattern",
      status: "active",
      confidence: 9,
      applies_when: "testing live canary fallback behavior",
      trigger_phrases: '["legacy fallback"]',
      must_do_summary: "Legacy fallback rule should inject outside matching live canary sessions.",
    },
    "# Legacy Fallback\n\nLegacy fallback body must not appear in compiled canary drops.",
  );
}

function writeValidCompiledView(root) {
  const latestDir = path.join(root, ".state", "sediment", "constraint-shadow", "latest");
  writeShadowDecision(path.join(latestDir, "decision.json"), [{
    constraintId: "shadow:live-canary-compiled",
    scope: { kind: "global" },
    injectMode: "always",
    title: "Live Canary Compiled",
    compiledBody: "Live canary compiled rule should inject.",
    mustDoSummary: "Live canary compiled rule should inject.",
    triggerPhrases: [],
    sourceRecordIds: ["event:live-canary-compiled"],
  }]);
  writeFile(path.join(latestDir, "compiled-view.md"), "## Global always\n\n### Live Canary Compiled\n- Live canary compiled rule should inject.\n");
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 1, injectableCoverageRatio: 1, queuedEvents: 0, appendFailedEvents: 0 },
    rows: [],
  }, null, 2));
}

async function runLiveCanaryScenario({ name, liveCanary, sessionId, persisted, compiledValid, compiledEnabled = true }) {
  const prevAbrainRoot = process.env.ABRAIN_ROOT;
  const prevHome = process.env.HOME;
  const scenarioRoot = path.join(tmpRoot, `live-canary-${name}`);
  const scenarioHome = path.join(scenarioRoot, "home");
  const scenarioAbrain = path.join(scenarioRoot, "abrain");
  const scenarioProject = path.join(scenarioRoot, "project");
  const scenarioCompiled = path.join(scenarioRoot, "compiled");
  try {
    fs.mkdirSync(scenarioProject, { recursive: true });
    writeBasicRuleSet(scenarioAbrain);
    if (compiledValid) writeValidCompiledView(scenarioAbrain);
    process.env.ABRAIN_ROOT = scenarioAbrain;
    process.env.HOME = scenarioHome;
    writeFile(path.join(scenarioHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
      ruleInjector: {
        compiledViewInjection: {
          enabled: compiledEnabled,
          fallbackToLegacyOnError: true,
          requireFresh: true,
          staleAfterMs: 86400000,
          maxReadBytes: 1000000,
          minCoverageRatio: 1,
          liveCanary,
        },
      },
    }, null, 2));
    stageModuleTree(scenarioCompiled);
    const freshReq = createRequire(path.join(scenarioCompiled, "runner.cjs"));
    const activate = freshReq("./abrain/rule-injector/index.js").default;
    const events = new Map();
    const statuses = [];
    const notifications = [];
    const pi = {
      on(eventName, handler) {
        if (!events.has(eventName)) events.set(eventName, []);
        events.get(eventName).push(handler);
      },
      registerCommand() {},
    };
    activate(pi);
    const sessionStart = events.get("session_start")?.[0];
    const beforeAgent = events.get("before_agent_start")?.[0];
    if (typeof sessionStart !== "function" || typeof beforeAgent !== "function") throw new Error("missing live canary handlers");
    const sessionManager = {
      getSessionId: () => sessionId,
      getSessionFile: () => persisted ? path.join(scenarioRoot, "sessions", `${sessionId}.json`) : undefined,
    };
    const ctx = {
      cwd: scenarioProject,
      sessionManager,
      ui: {
        setStatus(key, value) { statuses.push([key, value]); },
        notify(message, type) { notifications.push([message, type]); },
      },
    };
    await sessionStart({ reason: "startup" }, ctx);
    const result = await beforeAgent({ systemPrompt: "BASE" }, ctx);
    const auditFile = path.join(scenarioAbrain, ".state", "sediment", "constraint-shadow", "session-live-canary", "audit.jsonl");
    return {
      result,
      statuses,
      notifications,
      auditFile,
      auditRows: fs.existsSync(auditFile) ? readJsonLines(auditFile) : [],
    };
  } finally {
    if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = prevAbrainRoot;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
}

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
    writeFile(path.join(process.env.HOME, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
      ruleInjector: {
        compiledViewInjection: {
          enabled: true,
          fallbackToLegacyOnError: true,
          requireFresh: true,
          staleAfterMs: 86400000,
          maxReadBytes: 1000000,
          minCoverageRatio: 1,
        },
      },
    }, null, 2));
    const latestDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
    writeShadowDecision(path.join(latestDir, "decision.json"), [{
      constraintId: "shadow:footer-compiled",
      scope: { kind: "global" },
      injectMode: "always",
      title: "Footer Compiled",
      compiledBody: "Footer should show compiled view.",
      mustDoSummary: "Footer should show compiled view.",
      triggerPhrases: [],
      sourceRecordIds: ["event:footer-compiled"],
    }]);
    writeFile(path.join(latestDir, "compiled-view.md"), "## Global always\n\n### Footer Compiled\n- Footer should show compiled view.\n");
    writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
      schemaVersion: "constraint-event-coverage/v1",
      summary: { coverageRatio: 1, injectableCoverageRatio: 1 },
      rows: [],
    }, null, 2));
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
    if (!statuses.some(([, v]) => String(v).includes("rules: compiled 1 always, 0 listed"))) throw new Error(`footer status should show compiled counts: ${JSON.stringify(statuses)}`);
    if (statuses.some(([, v]) => String(v).includes("legacy"))) throw new Error(`footer status leaked legacy source: ${JSON.stringify(statuses)}`);
    const auditFile = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "session-start-dualread", "audit.jsonl");
    if (fs.existsSync(auditFile)) throw new Error("dual-read audit must stay off by default");
  } finally {
    if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = prevAbrainRoot;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});

await asyncCheck("live canary disabled/nonmatching session with broken compiled view keeps legacy fallback and writes no canary audit", async () => {
  const disabled = await runLiveCanaryScenario({
    name: "disabled",
    liveCanary: { enabled: false, sessionIds: ["session-disabled"] },
    sessionId: "session-disabled",
    persisted: true,
    compiledValid: false,
  });
  if (!disabled.result?.systemPrompt?.includes("Legacy Fallback")) throw new Error(`disabled live canary should legacy fallback: ${disabled.result?.systemPrompt}`);
  if (disabled.auditRows.length !== 0 || fs.existsSync(disabled.auditFile)) throw new Error(`disabled live canary wrote audit: ${disabled.auditFile}`);

  const nonmatching = await runLiveCanaryScenario({
    name: "nonmatching",
    liveCanary: { enabled: true, sessionIds: ["some-other-session"] },
    sessionId: "session-nonmatching",
    persisted: true,
    compiledValid: false,
  });
  if (!nonmatching.result?.systemPrompt?.includes("Legacy Fallback")) throw new Error(`nonmatching session should legacy fallback: ${nonmatching.result?.systemPrompt}`);
  if (nonmatching.auditRows.length !== 0 || fs.existsSync(nonmatching.auditFile)) throw new Error(`nonmatching live canary wrote audit: ${nonmatching.auditFile}`);
});

await asyncCheck("matching persisted live canary with broken compiled view fail-closes without legacy fallback and audits drop", async () => {
  const out = await runLiveCanaryScenario({
    name: "matching-broken",
    liveCanary: { enabled: true, sessionIds: ["session-canary-broken"] },
    sessionId: "session-canary-broken",
    persisted: true,
    compiledValid: false,
  });
  if (out.result !== undefined) throw new Error(`matching broken canary should not inject: ${JSON.stringify(out.result)}`);
  const statusText = out.statuses.map(([, value]) => String(value)).join("\n");
  const notifyText = out.notifications.map(([message]) => String(message)).join("\n");
  if (!statusText.includes("compiled view read_failed") || !statusText.includes("live canary fail-closed")) throw new Error(`footer missing drop/read_failed: ${statusText}`);
  if (!notifyText.includes("live canary fail-closed: read_failed")) throw new Error(`notify missing drop/read_failed: ${notifyText}`);
  if (/legacy fallback/i.test(`${statusText}\n${notifyText}`)) throw new Error(`drop surfaces should not mention legacy fallback: ${statusText}\n${notifyText}`);
  const row = out.auditRows.at(-1);
  if (!row || row.decision !== "fail_closed_drop" || row.reason !== "read_failed") throw new Error(`missing fail_closed_drop audit row: ${JSON.stringify(out.auditRows)}`);
  if (row.sessionId !== "session-canary-broken" || row.globalFallbackToLegacyOnError !== true || row.effectiveFallbackToLegacyOnError !== false) {
    throw new Error(`audit row did not capture fallback override: ${JSON.stringify(row)}`);
  }
});

await asyncCheck("matching persisted live canary with valid compiled view injects compiled and audits compiled_injected", async () => {
  const out = await runLiveCanaryScenario({
    name: "matching-valid",
    liveCanary: { enabled: true, sessionIds: [" session-canary-valid "] },
    sessionId: " session-canary-valid ",
    persisted: true,
    compiledValid: true,
  });
  const prompt = out.result?.systemPrompt ?? "";
  if (!prompt.includes("source=constraint-shadow-compiled-view") || !prompt.includes("Live canary compiled rule should inject.")) throw new Error(`matching valid canary did not inject compiled view: ${prompt}`);
  if (prompt.includes("Legacy Fallback")) throw new Error(`matching valid canary injected legacy fallback: ${prompt}`);
  const statusText = out.statuses.map(([, value]) => String(value)).join("\n");
  const warningText = out.notifications.filter(([, type]) => type === "warning").map(([message]) => String(message)).join("\n");
  if (!statusText.includes("live canary active")) throw new Error(`footer missing active canary detail: ${statusText}`);
  if (statusText.includes("fail-closed")) throw new Error(`valid canary footer should not say fail-closed: ${statusText}`);
  if (warningText) throw new Error(`valid canary should not emit warning notification: ${warningText}`);
  const row = out.auditRows.at(-1);
  if (!row || row.decision !== "compiled_injected" || row.compiledStatus !== "ok") throw new Error(`missing compiled_injected audit row: ${JSON.stringify(out.auditRows)}`);
  if (row.sessionId !== "session-canary-valid") throw new Error(`audit row should store trimmed session id: ${JSON.stringify(row)}`);
  if (row.compiledCounts.always !== 1 || row.coverageRatio !== 1 || row.injectableCoverageRatio !== 1) throw new Error(`audit row missing compiled metadata: ${JSON.stringify(row)}`);
});

await asyncCheck("matching persisted live canary forces compiled injection when global compiled view injection is disabled", async () => {
  const out = await runLiveCanaryScenario({
    name: "matching-valid-global-disabled",
    liveCanary: { enabled: true, sessionIds: ["session-canary-global-disabled"] },
    sessionId: "session-canary-global-disabled",
    persisted: true,
    compiledValid: true,
    compiledEnabled: false,
  });
  const prompt = out.result?.systemPrompt ?? "";
  if (!prompt.includes("source=constraint-shadow-compiled-view") || !prompt.includes("Live canary compiled rule should inject.")) throw new Error(`canary did not force compiled view when globally disabled: ${prompt}`);
  if (prompt.includes("Legacy Fallback")) throw new Error(`forced canary injected legacy fallback: ${prompt}`);
  const row = out.auditRows.at(-1);
  if (!row || row.decision !== "compiled_injected" || row.compiledStatus !== "ok") throw new Error(`missing forced compiled_injected audit row: ${JSON.stringify(out.auditRows)}`);
  if (row.globalFallbackToLegacyOnError !== true || row.effectiveFallbackToLegacyOnError !== false) throw new Error(`forced canary audit row did not capture fallback override: ${JSON.stringify(row)}`);
});

await asyncCheck("ephemeral session id listed in live canary does not opt in and still legacy-fallbacks", async () => {
  const out = await runLiveCanaryScenario({
    name: "ephemeral",
    liveCanary: { enabled: true, sessionIds: ["session-ephemeral"] },
    sessionId: "session-ephemeral",
    persisted: false,
    compiledValid: false,
  });
  if (!out.result?.systemPrompt?.includes("Legacy Fallback")) throw new Error(`ephemeral listed session should legacy fallback: ${out.result?.systemPrompt}`);
  if (out.auditRows.length !== 0 || fs.existsSync(out.auditFile)) throw new Error(`ephemeral live canary wrote audit: ${out.auditFile}`);
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
  const oldButSettled = ruleInjector.readCompiledRuleInjectionForRuntime({
    abrainHome,
    nonce: "compiled123",
    nowMs: Date.now() + 2 * 86400000,
    settings: {
      enabled: true,
      fallbackToLegacyOnError: true,
      requireFresh: true,
      staleAfterMs: 86400000,
      maxReadBytes: 1000000,
      minCoverageRatio: 1,
    },
  });
  if (!oldButSettled.ok || oldButSettled.stale) throw new Error(`settled compiled view should not stale by wall-clock age alone: ${JSON.stringify(oldButSettled)}`);
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 1, injectableCoverageRatio: 1, queuedEvents: 1, appendFailedEvents: 0, oldestQueuedAgeMs: 86400001 },
    rows: [],
  }, null, 2));
  const stalePending = ruleInjector.readCompiledRuleInjectionForRuntime({
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
  if (stalePending.ok || stalePending.reason !== "compiled_view_stale") throw new Error(`pending stale evidence should block compiled view: ${JSON.stringify(stalePending)}`);
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

check("ADR0039 L3: compiled-view runtime injection filters project sections by active project (no cross-project leak)", () => {
  const latestDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  const cacheL3 = ruleInjector.scanRules({ abrainHome, cwd: projectRoot, nonce: "l3proj", resolveProject: fakeBound });
  writeShadowDecision(path.join(latestDir, "decision.json"), [shadowConstraintFromRule(cacheL3.globalAlways[0])]);
  writeFile(path.join(latestDir, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 1, injectableCoverageRatio: 1 },
    rows: [],
  }, null, 2));
  const multiProjectView = [
    "## Global always", "### gh CLI rule", "- global body", "",
    "## Project pi-global always", "### pi-global rule", "- pi-global body", "",
    "## Project merdata always", "### merdata rule", "- merdata body", "",
    "## Project sub2api listed", "### sub2api rule", "- sub2api body", "",
    "## Conflicts", "- none", "",
    "## Not-memory diagnostics", "- none", "",
  ].join("\n");
  writeFile(path.join(latestDir, "compiled-view.md"), multiProjectView);
  const settings = {
    enabled: true, fallbackToLegacyOnError: true, requireFresh: true,
    staleAfterMs: 86400000, maxReadBytes: 1000000, minCoverageRatio: 1,
  };
  const piGlobal = ruleInjector.readCompiledRuleInjectionForRuntime({ abrainHome, nonce: "l3proj", settings, activeProjectId: "pi-global" });
  if (!piGlobal.ok) throw new Error(`pi-global inject failed: ${JSON.stringify(piGlobal)}`);
  if (!piGlobal.injection.includes("## Global always") || !piGlobal.injection.includes("pi-global body")) throw new Error("pi-global session lost Global or its own project section");
  if (piGlobal.injection.includes("merdata body") || piGlobal.injection.includes("sub2api body")) throw new Error("LEAK: pi-global session received other projects' rules");
  if (!piGlobal.injection.includes("## Conflicts") || !piGlobal.injection.includes("## Not-memory diagnostics")) throw new Error("pi-global session lost non-project sections");
  const merdata = ruleInjector.readCompiledRuleInjectionForRuntime({ abrainHome, nonce: "l3proj", settings, activeProjectId: "merdata" });
  if (!merdata.injection.includes("merdata body") || merdata.injection.includes("pi-global body") || merdata.injection.includes("sub2api body")) throw new Error(`merdata session filter wrong: ${merdata.injection}`);
  const unbound = ruleInjector.readCompiledRuleInjectionForRuntime({ abrainHome, nonce: "l3proj", settings });
  if (!unbound.injection.includes("## Global always")) throw new Error("unbound session lost Global");
  if (unbound.injection.includes("pi-global body") || unbound.injection.includes("merdata body") || unbound.injection.includes("sub2api body")) throw new Error("unbound session received project rules");
  const filtered = ruleInjector.filterCompiledViewByActiveProject(multiProjectView, "sub2api");
  if (!filtered.includes("sub2api body") || filtered.includes("merdata body") || filtered.includes("pi-global body")) throw new Error(`filterCompiledViewByActiveProject wrong: ${filtered}`);
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
    shadowConstraintFromRule(cache.globalAlways[0], { compiledBody: `${cache.globalAlways[0].body}\n\nCompiler changed meaning.` }),
    shadowConstraintFromRule(cache.globalListed[0], { mustDoSummary: "different summary" }),
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
  const settingsLegacyOnlySource = legacySourceId(cache.projectListed[0]);
  const unresolvedLegacyOnlySource = legacySourceId(cache.projectAlways[0]);
  const semanticEquivalentTextDeltaSource = legacySourceId(cache.globalListed[0]);
  const hashMismatchTextDeltaSource = legacySourceId(cache.globalAlways[0]);
  writeShadowDecision(path.join(latestDir, "decision.json"), constraints, {
    exclusions: [{
      reason: "settings_not_memory",
      sourceRecordIds: [settingsLegacyOnlySource],
      diagnosticIds: ["diag-settings-not-memory"],
    }],
    unresolved: [{
      reason: "model_uncertain",
      sourceRecordIds: [unresolvedLegacyOnlySource],
      diagnosticIds: ["diag-unresolved-compiled"],
    }],
    mappings: [{
      sourceRecordId: settingsLegacyOnlySource,
      disposition: "excluded",
      reason: "settings_not_memory",
    }],
    diagnostics: [{
      id: "diag-settings-not-memory",
      code: "SC_NOT_MEMORY_SETTINGS",
      sourceRecordIds: [settingsLegacyOnlySource],
    }, {
      id: "diag-unresolved-compiled",
      code: "SC_SMOKE_COMPILED_UNRESOLVED",
      message: "Active sources were compiled into the smoke fixture despite one unresolved source.",
      sourceRecordIds: [unresolvedLegacyOnlySource],
    }],
  });
  writeShadowDiff(path.join(latestDir, "diff.json"), [
    {
      sourceRecordId: settingsLegacyOnlySource,
      category: "exclude_not_memory_settings",
      disposition: "excluded",
      reason: "settings_not_memory",
    },
    {
      sourceRecordId: legacySourceId(cache.globalListed[0]),
      category: "compact",
      disposition: "compiled",
      targetId: "shadow:multi-audit",
      reason: "summary normalized by compiler",
    },
  ]);
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
  writeFile(path.join(latestDir, "text-delta-dispositions.json"), JSON.stringify({
    schemaVersion: "constraint-text-delta-dispositions/v1",
    items: [{
      sourceRecordId: semanticEquivalentTextDeltaSource,
      legacyHash: normalizedBodyHash(cache.globalListed[0].body),
      shadowHash: normalizedBodyHash(cache.globalListed[0].body),
      disposition: "semantic_equivalent",
      reviewedAtUtc: "2026-07-06T00:00:00.000Z",
      reviewRef: "smoke-review:semantic-equivalent",
      reason: "manual review accepted summary-only normalization",
    }, {
      sourceRecordId: hashMismatchTextDeltaSource,
      legacyHash: "wrong-legacy-hash",
      shadowHash: normalizedBodyHash(`${cache.globalAlways[0].body}\n\nCompiler changed meaning.`),
      disposition: "semantic_equivalent",
      reviewRef: "smoke-review:hash-mismatch",
      reason: "must be ignored because hashes do not match",
    }],
  }, null, 2));
  writeFile(path.join(latestDir, "compiled-only-dispositions.json"), JSON.stringify({
    schemaVersion: "constraint-compiled-only-dispositions/v1",
    items: [{
      sourceRecordId: "event:compiled-only",
      sourceKind: "constraint_event",
      category: "event_native",
      constraintId: "shadow:compiled-only",
      bodyHash: normalizedBodyHash("Compiled-only body"),
      inputRootHash: "input-root-hash-for-smoke",
      validationHash: "validation-hash-for-smoke",
      scope: "global",
      injectMode: "listed",
      disposition: "event_native_accepted",
      reviewedAtUtc: "2026-07-06T00:00:00.000Z",
      reviewRef: "smoke-review:event-native-accepted",
      reason: "T0 accepted event-native compiled-only source",
    }],
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
  if (row.summary.legacyOnly !== 2) throw new Error(`legacyOnly=${row.summary.legacyOnly}`);
  if (row.summary.textDelta !== 2) throw new Error(`textDelta=${row.summary.textDelta}`);
  if (row.legacyOnlyDispositions.settings_not_memory !== 1) throw new Error(`legacyOnlyDispositions missing settings_not_memory: ${JSON.stringify(row.legacyOnlyDispositions)}`);
  if (row.legacyOnlyDispositions.model_uncertain !== 1) throw new Error(`legacyOnlyDispositions missing model_uncertain: ${JSON.stringify(row.legacyOnlyDispositions)}`);
  const legacyDetail = row.legacyOnlyDetails.find((item) => item.sourceRecordId === settingsLegacyOnlySource);
  if (!legacyDetail || legacyDetail.disposition !== "settings_not_memory" || legacyDetail.category !== "exclude_not_memory_settings") {
    throw new Error(`legacyOnlyDetails did not explain settings exclusion: ${JSON.stringify(row.legacyOnlyDetails)}`);
  }
  if (legacyDetail.machineDisposition !== "settings_not_memory" || legacyDetail.humanReviewRequired !== false) {
    throw new Error(`settings legacy detail missing machine disposition/review gate: ${JSON.stringify(legacyDetail)}`);
  }
  const unresolvedDetail = row.legacyOnlyDetails.find((item) => item.sourceRecordId === unresolvedLegacyOnlySource);
  if (!unresolvedDetail || unresolvedDetail.machineDisposition !== "model_uncertain" || unresolvedDetail.humanReviewRequired !== true) {
    throw new Error(`unresolved legacy detail missing human review gate: ${JSON.stringify(row.legacyOnlyDetails)}`);
  }
  if (row.compiledOnlyBackfillAllowed !== false) throw new Error(`compiledOnlyBackfillAllowed should be false: ${JSON.stringify(row.compiledOnlyBackfillAllowed)}`);
  const compiledDetail = row.compiledOnlyDetails.find((item) => item.sourceRecordId === "event:compiled-only");
  if (!compiledDetail || compiledDetail.sourceKind !== "constraint_event" || compiledDetail.category !== "event_native" || compiledDetail.scope !== "global") {
    throw new Error(`compiledOnlyDetails did not explain event-native source: ${JSON.stringify(row.compiledOnlyDetails)}`);
  }
  if (compiledDetail.machineDisposition !== "event_native_accepted" || compiledDetail.reviewSource !== "compiled-only-dispositions") {
    throw new Error(`compiledOnlyDetails did not apply event-native sidecar disposition: ${JSON.stringify(compiledDetail)}`);
  }
  if (compiledDetail.reviewRef !== "smoke-review:event-native-accepted" || compiledDetail.reason !== "T0 accepted event-native compiled-only source") {
    throw new Error(`compiledOnlyDetails missing event-native review metadata: ${JSON.stringify(compiledDetail)}`);
  }
  if (compiledDetail.disposition || compiledDetail.category !== "event_native") {
    throw new Error(`compiledOnly sidecar should not overwrite disposition/category: ${JSON.stringify(compiledDetail)}`);
  }
  if (row.compiledOnlyDetails.some((item) => item.compiledOnlyBackfillAllowed !== false)) {
    throw new Error(`compiledOnlyDetails should deny backfill: ${JSON.stringify(row.compiledOnlyDetails)}`);
  }
  const textDetail = row.textDeltaDetails.find((item) => item.sourceRecordId === semanticEquivalentTextDeltaSource);
  if (!textDetail || textDetail.legacyHash !== normalizedBodyHash(cache.globalListed[0].body) || textDetail.disposition !== "semantic_equivalent") {
    throw new Error(`textDeltaDetails did not preserve hashes with sidecar disposition: ${JSON.stringify(row.textDeltaDetails)}`);
  }
  if (textDetail.machineDisposition !== "semantic_equivalent" || textDetail.humanReviewRequired !== false) {
    throw new Error(`semantic equivalent text delta should be machine-disposed without human review: ${JSON.stringify(textDetail)}`);
  }
  if (textDetail.reviewSource !== "text-delta-dispositions" || textDetail.reviewRef !== "smoke-review:semantic-equivalent" || textDetail.reason !== "manual review accepted summary-only normalization") {
    throw new Error(`semantic equivalent text delta missing sidecar review metadata: ${JSON.stringify(textDetail)}`);
  }
  if (row.textDeltaDispositions.semantic_equivalent !== 1) {
    throw new Error(`textDeltaDispositions missing semantic_equivalent count: ${JSON.stringify(row.textDeltaDispositions)}`);
  }
  const hashMismatchDetail = row.textDeltaDetails.find((item) => item.sourceRecordId === hashMismatchTextDeltaSource);
  if (!hashMismatchDetail || hashMismatchDetail.disposition !== "semantic_review_required" || hashMismatchDetail.humanReviewRequired !== true) {
    throw new Error(`hash-mismatched sidecar item should be ignored: ${JSON.stringify(row.textDeltaDetails)}`);
  }
  if (hashMismatchDetail.reviewSource || hashMismatchDetail.machineDisposition) {
    throw new Error(`hash-mismatched sidecar metadata leaked into detail: ${JSON.stringify(hashMismatchDetail)}`);
  }
  const inconsistent = row.inconsistentDiagnostics.find((item) => item.code === "SC_SMOKE_COMPILED_UNRESOLVED");
  if (!inconsistent || inconsistent.reason !== "diagnostic_claims_compiled_for_unresolved_source") {
    throw new Error(`inconsistentDiagnostics did not flag compiled/unresolved diagnostic: ${JSON.stringify(row.inconsistentDiagnostics)}`);
  }
  if (row.eventCoverage.queuedEvents !== 1 || row.eventCoverage.staleEvents !== 1) throw new Error(`event coverage missing: ${JSON.stringify(row.eventCoverage)}`);
  writeFile(path.join(latestDir, "text-delta-dispositions.json"), "{ bad json");
  const badSidecar = dual.runRuleInjectorDualReadAudit({
    abrainHome,
    cwd: projectRoot,
    cache,
    settings: dual.resolveRuleInjectorDualReadAuditSettings({ enabled: true, staleAfterMs: 0 }),
    nowMs: Date.now() + 20_000,
  });
  if (badSidecar.status !== "delta" && badSidecar.status !== "match") throw new Error(`bad sidecar should not make shadow invalid: ${JSON.stringify(badSidecar)}`);
  const badSidecarRow = readJsonLines(badSidecar.auditFile).at(-1);
  if (!badSidecarRow.textDeltaDispositionReadError) throw new Error(`bad sidecar row missing read error: ${JSON.stringify(badSidecarRow)}`);
  writeFile(path.join(latestDir, "text-delta-dispositions.json"), JSON.stringify({
    schemaVersion: "constraint-text-delta-dispositions/v1",
    items: [{ sourceRecordId: semanticEquivalentTextDeltaSource, legacyHash: normalizedBodyHash(cache.globalListed[0].body) }],
  }, null, 2));
  const schemaBadSidecar = dual.runRuleInjectorDualReadAudit({
    abrainHome,
    cwd: projectRoot,
    cache,
    settings: dual.resolveRuleInjectorDualReadAuditSettings({ enabled: true, staleAfterMs: 0 }),
    nowMs: Date.now() + 30_000,
  });
  if (schemaBadSidecar.status !== "delta" && schemaBadSidecar.status !== "match") throw new Error(`schema-bad sidecar should not make shadow invalid: ${JSON.stringify(schemaBadSidecar)}`);
  const schemaBadSidecarRow = readJsonLines(schemaBadSidecar.auditFile).at(-1);
  if (!schemaBadSidecarRow.textDeltaDispositionReadError) throw new Error(`schema-bad sidecar row missing read error: ${JSON.stringify(schemaBadSidecarRow)}`);
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
