#!/usr/bin/env node
/** ADR0040 production stable-view reader + runtime full-flip smoke. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { preparePropositionPolicyStableViewFixture } from "./_proposition-policy-stable-view-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const ts = require("typescript");
const jiti = createJiti(repoRoot, { interopDefault: true });
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const reader = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-production-reader-"));
const fullSource = path.join(tmpRoot, "source-full");
const emptySource = path.join(tmpRoot, "source-empty");
const published = path.join(tmpRoot, "published");
const concurrentPublished = path.join(tmpRoot, "published-concurrent");
const sessionId = "persisted arbitrary/id with spaces?yes";
const nonexistentSessionFile = path.join(tmpRoot, "sessions", "fresh-first-turn-does-not-exist.jsonl");
const FIVE = ["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"];
const EVENT_IDS = [
  "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6",
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
];
let passed = 0;
const failures = [];
let fullBundle;
let emptyBundle;
let settings;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}

function eventPath(home, eventId) {
  return path.join(home, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}

async function copySources() {
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: fullSource });
  fs.cpSync(fullSource, emptySource, { recursive: true });
  fs.unlinkSync(eventPath(emptySource, EVENT_IDS[0]));
  fs.mkdirSync(published, { recursive: true });
  fs.mkdirSync(concurrentPublished, { recursive: true });
}

function manager({ id = sessionId, persisted = true, compatibility = false } = {}) {
  const base = {
    getSessionId: () => id,
    getSessionFile: () => persisted ? nonexistentSessionFile : undefined,
  };
  return compatibility ? base : { ...base, isPersisted: () => persisted };
}

function read(home = published, overrides = {}) {
  return reader.readPropositionPolicyStableViewForRuntime({
    abrainHome: home,
    settings: overrides.settings ?? settings,
    sessionManager: overrides.sessionManager ?? manager(),
    ...(overrides.activeProjectId ? { activeProjectId: overrides.activeProjectId } : {}),
    ...(overrides.nowMs === undefined ? {} : { nowMs: overrides.nowMs }),
    ...(overrides.hooks ? { hooks: overrides.hooks } : {}),
  });
}

function stableRoot(home) {
  return path.join(home, ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function latest(home) {
  return path.join(stableRoot(home), "latest");
}

function bundleDir(home, value = fs.readlinkSync(latest(home))) {
  return path.join(stableRoot(home), value);
}

function atomicLatest(home, value) {
  const temporary = path.join(stableRoot(home), `.switch-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.symlinkSync(value, temporary, "dir");
  fs.renameSync(temporary, latest(home));
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function canonicalJson(value) {
  return `${canonical(value)}\n`;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function clonePublished(label, source = published) {
  const target = path.join(tmpRoot, label);
  fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  return target;
}

function rewritePublicationManifest(home, mutate) {
  const oldValue = fs.readlinkSync(latest(home));
  const oldDir = bundleDir(home, oldValue);
  const manifestFile = path.join(oldDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  mutate(manifest);
  delete manifest.bundle_hash;
  delete manifest.manifest_hash;
  const identity = hash(canonical(manifest));
  manifest.bundle_hash = identity;
  manifest.manifest_hash = identity;
  fs.writeFileSync(manifestFile, canonicalJson(manifest));
  const newValue = `bundles/${identity}`;
  fs.renameSync(oldDir, bundleDir(home, newValue));
  atomicLatest(home, newValue);
  return identity;
}

function transpile(source) {
  return ts.transpileModule(fs.readFileSync(path.join(repoRoot, source), "utf8"), {
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

function stageRuleInjector(outRoot) {
  const files = [
    ["extensions/abrain/rule-injector/index.ts", "abrain/rule-injector/index.js"],
    ["extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts", "abrain/rule-injector/proposition-policy-stable-view-reader.js"],
    ["extensions/abrain/rule-injector/proposition-policy-stable-view-runtime-audit.ts", "abrain/rule-injector/proposition-policy-stable-view-runtime-audit.js"],
    ["extensions/_shared/footer-status.ts", "_shared/footer-status.js"],
    ["extensions/_shared/jcs.ts", "_shared/jcs.js"],
    ["extensions/_shared/proposition-policy-stable-view-contract.ts", "_shared/proposition-policy-stable-view-contract.js"],
  ];
  writeFile(path.join(outRoot, "memory", "parser.js"), `module.exports = {
  parseFrontmatter: () => ({ attributes: {}, body: "" }),
  relationValues: () => [], scalarNumber: () => undefined, scalarString: () => undefined,
  splitCompiledTruth: (body) => ({ compiled: body, evidence: "" }),
  splitFrontmatter: (raw) => ({ attributes: {}, body: raw }),
};\n`);
  writeFile(path.join(outRoot, "memory", "utils.js"), `module.exports = { slugify: (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-") };\n`);
  writeFile(path.join(outRoot, "_shared", "pi-internals.js"), `module.exports = { isSubAgentSession: (ctx) => !!ctx?.__subagent };\n`);
  writeFile(path.join(outRoot, "_shared", "runtime.js"), `module.exports = {
  abrainProjectDir: (root, id) => require("node:path").join(root, "projects", id),
  resolveActiveProject: () => ({ activeProject: null, reason: "fixture_unbound" }),
};\n`);
  writeFile(path.join(outRoot, "_shared", "causal-anchor.js"), `module.exports = {
  getCurrentAnchor: () => ({ session_id: ${JSON.stringify(sessionId)}, turn_id: 7 }),
  spreadAnchor: (anchor) => ({ ...anchor, device_id: "fixture-device" }),
};\n`);
  writeFile(path.join(outRoot, "abrain", "rule-injector", "dualread-audit.js"), `module.exports = {
  resolveRuleInjectorDualReadAuditSettings: () => ({ enabled: false, maxReadBytes: 1000000, staleAfterMs: 86400000 }),
  runRuleInjectorDualReadAudit: () => { throw new Error("production hook reached dual-read"); },
};\n`);
  for (const [source, target] of files) writeFile(path.join(outRoot, target), transpile(source));
}

function writeOldRuntimeSources(home) {
  writeFile(path.join(home, "rules", "always", "legacy.md"), "---\ntitle: Legacy\nstatus: active\n---\n# Legacy\n\nLEGACY_RUNTIME_MARKER\n");
  writeFile(path.join(home, ".state", "sediment", "constraint-shadow", "latest", "compiled-view.md"), "COMPILED_RUNTIME_MARKER\n");
  writeFile(path.join(home, ".state", "sediment", "proposition-lifecycle-freshness", "v2", "selections", "current.json"), "{\"D3_RUNTIME_MARKER\":true}\n");
}

console.log("ADR0040 production full-flip reader/runtime smoke");
await copySources();

try {
  await check("publisher prepares strict one-item and empty production bundles in disposable sandboxes", async () => {
    fullBundle = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: fullSource, repoRoot });
    emptyBundle = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: emptySource, repoRoot });
    publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: published, bundle: fullBundle });
    publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: concurrentPublished, bundle: fullBundle });
    publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: concurrentPublished, bundle: emptyBundle });
    settings = reader.resolvePropositionPolicyStableViewInjectionSettings({
      enabled: false,
      selector: { session_ids: ["nobody"] },
      expectedBundleHash: "0".repeat(64),
      maxSelectionAgeMs: 1,
      maxReadBytes: 262144,
    });
    assert(JSON.stringify(Object.keys(settings)) === JSON.stringify(["maxReadBytes"]), "legacy gates survived settings resolution");
    assert(JSON.parse(fullBundle.artifacts["view.json"]).items.length === 1, "full bundle item count differs");
    assert(JSON.parse(emptyBundle.artifacts["view.json"]).items.length === 0, "empty bundle item count differs");
  });

  await check("every persisted arbitrary ID is selected on the fresh first turn without a session file", () => {
    assert(!fs.existsSync(nonexistentSessionFile), "fresh-session fixture unexpectedly exists");
    const result = read();
    assert(result.ok && result.sessionId === sessionId && result.bundleHash === fullBundle.bundle_hash, `persisted read=${JSON.stringify(result)}`);
    assert(result.viewMd === fullBundle.artifacts["view.md"] && result.itemCount === 1, "persisted payload differs");
  });

  await check("real isPersisted API and compatibility API include persisted sessions; ephemeral excludes without reading", () => {
    const compatibility = read(published, { sessionManager: manager({ id: "compat/id", compatibility: true }) });
    const ephemeral = read(path.join(tmpRoot, "does-not-exist"), { sessionManager: manager({ persisted: false }) });
    assert(compatibility.ok && compatibility.sessionId === "compat/id", `compatibility=${JSON.stringify(compatibility)}`);
    assert(!ephemeral.ok && ephemeral.reason === "ephemeral_session", `ephemeral=${JSON.stringify(ephemeral)}`);
  });

  await check("selection age is diagnostic only and an expired latest still injects", () => {
    const stat = fs.lstatSync(latest(published));
    const publishedAt = Math.max(stat.mtimeMs, stat.ctimeMs);
    const result = read(published, { nowMs: publishedAt + reader.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_STALE_DIAGNOSTIC_AFTER_MS + 1 });
    assert(result.ok && result.selectionStale === true, `stale result=${JSON.stringify(result)}`);
    assert(result.itemCount === 1 && result.viewMd === fullBundle.artifacts["view.md"], "stale diagnostic blocked injection");
  });

  await check("reader captures latest once and keeps the immutable target during a concurrent switch", () => {
    const emptyValue = `bundles/${emptyBundle.bundle_hash}`;
    const fullValue = `bundles/${fullBundle.bundle_hash}`;
    atomicLatest(concurrentPublished, emptyValue);
    let captured;
    let hookCalls = 0;
    const result = read(concurrentPublished, {
      hooks: {
        afterLatestCapture(value) {
          captured = value;
          hookCalls += 1;
          atomicLatest(concurrentPublished, fullValue);
        },
      },
    });
    assert(result.ok && result.bundleHash === emptyBundle.bundle_hash && result.itemCount === 0, `captured result=${JSON.stringify(result)}`);
    assert(captured === emptyValue && hookCalls === 1, `captured=${captured}, hookCalls=${hookCalls}`);
    assert(fs.readlinkSync(latest(concurrentPublished)) === fullValue, "concurrent latest switch did not occur");
  });

  await check("invalid latest, partial set, manifest authority and sealed provenance faults reject", () => {
    const invalidLatest = clonePublished("attack-invalid-latest");
    fs.unlinkSync(latest(invalidLatest));
    fs.symlinkSync("../../escape", latest(invalidLatest), "dir");
    assert(read(invalidLatest).reason === "latest_invalid", "invalid latest did not reject");

    const partial = clonePublished("attack-partial");
    fs.unlinkSync(path.join(bundleDir(partial), "parity.json"));
    assert(read(partial).reason === "partial_or_foreign", "partial bundle did not reject");

    const authority = clonePublished("attack-authority");
    rewritePublicationManifest(authority, (manifest) => { manifest.authority = "canary_or_fallback"; });
    assert(read(authority).reason === "manifest_identity", "re-self-hashed foreign authority did not reject");

    const provenance = clonePublished("attack-provenance");
    rewritePublicationManifest(provenance, (manifest) => {
      manifest.canonical_source.physical_accounting.evidence_event_ids = [];
      manifest.canonical_source.physical_accounting.evidence_event_ids_hash = hash(canonical([]));
    });
    assert(read(provenance).reason === "source_provenance", "re-self-hashed unsealed L1 provenance did not reject");

    const closure = clonePublished("attack-source-closure");
    rewritePublicationManifest(closure, (manifest) => { manifest.compiler.source_closure.graph_hash = "0".repeat(64); });
    assert(read(closure).reason === "source_closure", "re-self-hashed forged source closure did not reject");

    const budget = read(published, { settings: { maxReadBytes: 1024 } });
    assert(!budget.ok && budget.reason === "oversize", `aggregate budget=${JSON.stringify(budget)}`);
  });

  await check("runtime injects exactly one policy fence and ignores all obsolete config gates/sources", async () => {
    writeOldRuntimeSources(published);
    const runtimeHome = path.join(tmpRoot, "runtime-home");
    writeFile(path.join(runtimeHome, ".pi", "agent", "pi-astack-settings.json"), `${JSON.stringify({
      ruleInjector: {
        enabled: false,
        compiledViewInjection: { enabled: true, fallbackToLegacyOnError: true },
        propositionLifecycleFreshnessD3V2SessionStartInjection: { enabled: true, selector: { session_ids: [sessionId] } },
        propositionPolicyStableViewInjection: {
          enabled: false,
          selector: { session_ids: ["not-this-session"] },
          expectedBundleHash: "0".repeat(64),
          maxSelectionAgeMs: 1,
          maxReadBytes: 262144,
        },
      },
    }, null, 2)}\n`);
    const outRoot = path.join(tmpRoot, "runtime-compiled");
    stageRuleInjector(outRoot);
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ABRAIN_ROOT: process.env.ABRAIN_ROOT };
    const originalDateNow = Date.now;
    try {
      process.env.HOME = runtimeHome;
      process.env.USERPROFILE = runtimeHome;
      process.env.ABRAIN_ROOT = published;
      const stagedRequire = createRequire(path.join(outRoot, "runner.cjs"));
      const injector = stagedRequire("./abrain/rule-injector/index.js");
      const events = new Map();
      const statuses = [];
      const notices = [];
      injector.default({
        on(name, handler) { events.set(name, handler); },
        registerCommand() {},
      });
      const ctx = {
        cwd: tmpRoot,
        sessionManager: manager(),
        ui: {
          setStatus(_key, text) { statuses.push(String(text)); },
          notify(message, type) { notices.push([String(message), type]); },
        },
      };
      await events.get("session_start")({ reason: "startup" }, ctx);
      assert(!fs.existsSync(nonexistentSessionFile), "session_start required a fresh session file");
      const runtimeNow = originalDateNow();
      Date.now = () => runtimeNow + reader.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_STALE_DIAGNOSTIC_AFTER_MS + 1_000;
      const oldFence = "<!-- BEGIN_ABRAIN_RULES session=old source=constraint-shadow-compiled-view -->\n## Rules Catalog\nCOMPILED_RUNTIME_MARKER\nsource=proposition-lifecycle-freshness-d3-v2\n<!-- END_ABRAIN_RULES -->";
      const success = await events.get("before_agent_start")({ id: "user-message-1", systemPrompt: `BASE\n\n${oldFence}`, prompt: "success user text" }, ctx);
      const prompt = success?.systemPrompt ?? "";
      assert((prompt.match(/BEGIN_ABRAIN_RULES/g) ?? []).length === 1 && (prompt.match(/END_ABRAIN_RULES/g) ?? []).length === 1, "success is not exact-one fence");
      assert(prompt.includes("source=proposition-policy-stable-view") && prompt.includes(fullBundle.artifacts["view.md"]), "stable payload missing");
      assert(statuses.at(-1).includes("stale"), `expired stable view did not emit a stale footer: ${statuses.at(-1)}`);
      assert(!/COMPILED_RUNTIME_MARKER|LEGACY_RUNTIME_MARKER|D3_RUNTIME_MARKER|source=constraint-shadow|source=proposition-lifecycle/.test(prompt), "old runtime marker survived success");

      const auditFile = path.join(runtimeHome, ".pi", ".pi-astack", "adr0040-policy-stable-view-runtime-audit.jsonl");
      const successRow = readJsonLines(auditFile).at(-1);
      assert(successRow.decision === "policy_stable_view_injected" && successRow.session_id === sessionId && successRow.turn_id === 7, "success audit decision/anchor differs");
      assert(successRow.selection_stale === true, "expired stable view was not recorded as stale");
      assert(successRow.latest_user_message_id === "user-message-1" && successRow.item_count === 1 && successRow.view_bytes > 0, "success audit identity/counts differ");
      assert(successRow.begin_fence_count === 1 && successRow.end_fence_count === 1 && successRow.contains_policy_stable_marker === true, "success audit marker counts differ");
      assert(successRow.contains_compiled_marker === false && successRow.contains_legacy_catalog_marker === false && successRow.contains_d3_marker === false, "success audit contains old markers");

      const originalView = fs.readFileSync(path.join(bundleDir(published), "view.md"), "utf8");
      fs.appendFileSync(path.join(bundleDir(published), "view.md"), "tamper\n");
      const rejected = await events.get("before_agent_start")({ systemPrompt: `BASE\n\n${oldFence}`, prompt: "rejected user text" }, ctx);
      fs.writeFileSync(path.join(bundleDir(published), "view.md"), originalView);
      assert(rejected?.systemPrompt === "BASE", `rejected prompt was not sanitized zero: ${rejected?.systemPrompt}`);
      assert(statuses.at(-1).includes("policy stable-view rejected") && statuses.at(-1).includes("zero injection"), "rejection footer is not loud");
      assert(notices.some(([message, type]) => type === "error" && message.includes("zero injection")), "rejection notice is not loud");
      const rejectedRow = readJsonLines(auditFile).at(-1);
      assert(rejectedRow.decision === "policy_stable_view_rejected" && rejectedRow.begin_fence_count === 0 && rejectedRow.end_fence_count === 0, "rejected audit decision/markers differ");
      assert(rejectedRow.contains_policy_stable_marker === false && rejectedRow.contains_compiled_marker === false
        && rejectedRow.contains_legacy_catalog_marker === false && rejectedRow.contains_d3_marker === false, "rejected audit retained an old marker");

      const beforeExcludeRows = readJsonLines(auditFile).length;
      const ephemeralCtx = { ...ctx, sessionManager: manager({ persisted: false }) };
      const ephemeral = await events.get("before_agent_start")({ systemPrompt: `BASE\n\n${oldFence}`, prompt: "ephemeral" }, ephemeralCtx);
      assert(ephemeral?.systemPrompt === "BASE", "ephemeral main did not return sanitized zero");
      const subagent = await events.get("before_agent_start")({ systemPrompt: `BASE\n\n${oldFence}`, prompt: "subagent" }, { ...ctx, __subagent: true });
      assert(subagent === undefined, "subagent prompt was mutated");
      assert(readJsonLines(auditFile).length === beforeExcludeRows, "ephemeral/subagent wrote policy audit rows");
    } finally {
      Date.now = originalDateNow;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  await check("schema has no selector/hash/age gate and no compiled or D3 runtime configuration", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
    const rule = schema.properties.ruleInjector.properties;
    assert(!Object.hasOwn(rule, "compiledViewInjection"), "compiled runtime config remains in schema");
    assert(!Object.hasOwn(rule, "propositionLifecycleFreshnessD3V2SessionStartInjection"), "D3 runtime config remains in schema");
    const stable = rule.propositionPolicyStableViewInjection.properties;
    assert(JSON.stringify(Object.keys(stable).sort()) === JSON.stringify(["_comment", "maxReadBytes"]), `stable settings keys=${Object.keys(stable)}`);
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; all-persisted sole-source selection, stale diagnostics, strict captured-latest validation, loud zero, exact-one fence, and exclusions verified`);
