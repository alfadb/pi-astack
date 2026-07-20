#!/usr/bin/env node
/** ADR0040 rule-injector full-flip boundary smoke. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const injector = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/index.ts"));
const reader = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts"));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rule-injector-full-flip-"));
const failures = [];
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

console.log("abrain rule injector - ADR0040 production full flip");

try {
  check("production lifecycle hooks have no D3, compiled, dual-read, scan, or legacy injection call edge", () => {
    const source = fs.readFileSync(path.join(repoRoot, "extensions/abrain/rule-injector/index.ts"), "utf8");
    assert(!source.includes("proposition-lifecycle-freshness-d3-v2-session-start-control"), "D3 runtime control import remains");
    assert(!source.includes("selectD3V2SessionStartSession") && !source.includes("decideD3V2SessionStartControl"), "D3 runtime symbol remains");
    const start = source.indexOf('maybePi.on("session_start"');
    const end = source.indexOf('if (typeof maybePi.registerCommand', start);
    assert(start >= 0 && end > start, "production lifecycle hook block missing");
    const hooks = source.slice(start, end);
    for (const forbidden of [
      "scanRules(",
      "readCompiledRuleInjectionForRuntime(",
      "decideRuntimeRuleInjection(",
      "composeRuleInjection(",
      "runRuleInjectorDualReadAudit(",
      "propositionLifecycleFreshness",
      "normal_path_fallback",
      "legacy_fallback",
    ]) assert(!hooks.includes(forbidden), `production hook reaches ${forbidden}`);
    assert(hooks.includes("readPropositionPolicyStableViewForRuntime("), "stable-view reader is absent from production hook");
    assert(hooks.includes("policy_stable_view_rejected"), "loud zero terminal decision is absent");
  });

  check("all managed historical fences are sanitized and malformed tails cannot survive", () => {
    const stable = "<!-- BEGIN_ABRAIN_RULES session=stable source=proposition-policy-stable-view -->\nPOLICY\n<!-- END_ABRAIN_RULES -->";
    const compiled = "<!-- BEGIN_ABRAIN_RULES session=compiled source=constraint-shadow-compiled-view -->\n## Rules Catalog\nCOMPILED\n<!-- END_ABRAIN_RULES -->";
    const d3 = "<!-- BEGIN_ABRAIN_RULES session=d3 source=proposition-lifecycle-freshness-d3-v2 -->\nD3\n<!-- END_ABRAIN_RULES -->";
    const cleaned = injector.stripAllManagedRuleInjections(`BASE\n\n${stable}\n\n${compiled}\n\n${d3}`);
    assert(cleaned === "BASE", `managed fences survived: ${cleaned}`);
    const malformed = injector.stripAllManagedRuleInjections("BASE\n\n<!-- BEGIN_ABRAIN_RULES source=legacy -->\nFOREIGN");
    assert(malformed === "BASE", `unterminated fence survived: ${malformed}`);
  });

  check("stable success composer emits exactly one fence with exact payload bytes", () => {
    const result = {
      ok: true,
      reason: "selected_valid",
      sessionId: "any/id",
      bundleHash: "a".repeat(64),
      manifestHash: "a".repeat(64),
      sourcePath: "/tmp/view.md",
      selectionPublishedAtMs: 1,
      selectionAgeMs: 2,
      selectionStale: false,
      viewMd: "Policy bytes.\n",
      viewBytes: 14,
      itemCount: 1,
    };
    const text = injector.composePropositionPolicyStableViewInjection("nonce", result);
    assert((text.match(/BEGIN_ABRAIN_RULES/g) ?? []).length === 1, "begin fence count differs");
    assert((text.match(/END_ABRAIN_RULES/g) ?? []).length === 1, "end fence count differs");
    assert(text.includes("source=proposition-policy-stable-view") && text.includes("Policy bytes.\n<!-- END"), "payload bytes differ");
    assert(!text.includes("constraint-shadow") && !text.includes("lifecycle-freshness"), "old source marker leaked");
  });

  check("persisted selection is universal and fresh-file independent while ephemeral is excluded", () => {
    const settings = reader.resolvePropositionPolicyStableViewInjectionSettings({ enabled: false, selector: { session_ids: [] } });
    const fresh = reader.selectPropositionPolicyStableViewSession({
      settings,
      sessionManager: {
        isPersisted: () => true,
        getSessionId: () => "id/with spaces and punctuation?!",
        getSessionFile: () => path.join(tmpRoot, "missing-first-turn.jsonl"),
      },
    });
    const ephemeral = reader.selectPropositionPolicyStableViewSession({
      settings,
      sessionManager: { isPersisted: () => false, getSessionId: () => "ephemeral", getSessionFile: () => undefined },
    });
    assert(fresh.selected && fresh.sessionId === "id/with spaces and punctuation?!", `fresh selection=${JSON.stringify(fresh)}`);
    assert(!ephemeral.selected && ephemeral.reason === "ephemeral_session", `ephemeral=${JSON.stringify(ephemeral)}`);
  });

  check("legacy rule scanner remains diagnostic-only historical code", () => {
    const abrain = path.join(tmpRoot, "diagnostic-abrain");
    writeFile(path.join(abrain, "rules", "always", "historical.md"), [
      "---",
      "title: Historical Diagnostic",
      "status: active",
      "confidence: 9",
      "must_do_summary: Historical only.",
      "---",
      "# Historical Diagnostic",
      "",
      "Historical body.",
      "",
    ].join("\n"));
    const cache = injector.scanRules({
      abrainHome: abrain,
      cwd: tmpRoot,
      resolveProject: () => ({ activeProject: null, reason: "fixture_unbound", cwd: tmpRoot }),
    });
    assert(cache.globalAlways.length === 1, "historical diagnostic scanner no longer reads its retained code");
    assert(injector.composeRuleInjection(cache).includes("Historical Diagnostic"), "historical diagnostic renderer drifted");
  });

  check("schema exposes only stable-view infrastructure limits for production rule authority", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
    const properties = schema.properties.ruleInjector.properties;
    assert(!properties.enabled, "rule authority enabled switch remains reachable");
    assert(!properties.compiledViewInjection, "compiled runtime config remains reachable");
    assert(!properties.propositionLifecycleFreshnessD3V2SessionStartInjection, "D3 runtime config remains reachable");
    assert(JSON.stringify(Object.keys(properties.propositionPolicyStableViewInjection.properties).sort())
      === JSON.stringify(["_comment", "maxReadBytes"]), "stable-view selector/auth gate remains");
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; production hook sole-source reachability, sanitation, universal persistence, and historical-code isolation verified`);
