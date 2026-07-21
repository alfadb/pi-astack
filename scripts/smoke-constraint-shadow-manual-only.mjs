#!/usr/bin/env node
/**
 * Production gate for the retired automatic Constraint shadow compiler paths.
 *
 * Reads the real live settings, but writes only to temporary roots. The
 * compiler, audit implementation, and manual dossier stay available.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const agentDir = path.resolve(repoRoot, "../..");
const liveSettingsPath = path.join(agentDir, "pi-astack-settings.json");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });

const failures = [];
let passed = 0;

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

function source(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

function sourceSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `source slice missing: ${startMarker} -> ${endMarker}`);
  return text.slice(start, end);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

console.log("constraint shadow manual-only production gate");

const live = JSON.parse(fs.readFileSync(liveSettingsPath, "utf8"));
const schema = JSON.parse(source("pi-astack-settings.schema.json"));
const resolved = jiti(path.join(repoRoot, "extensions/sediment/settings.ts")).resolveSedimentSettings();
const autoRefresh = jiti(path.join(repoRoot, "extensions/sediment/constraint-compiler/auto-refresh.ts"));

await check("live dual-read audit and automatic shadow refresh are disabled", () => {
  assert(live.ruleInjector?.dualReadAudit?.enabled === false, "live ruleInjector.dualReadAudit.enabled must be false");
  assert(live.sediment?.constraintShadowCompiler?.autoRefresh?.enabled === false, "live constraint shadow autoRefresh must be false");
  assert(resolved.constraintShadowCompiler.enabled === true, "manual compiler capability was disabled");
  assert(resolved.constraintShadowCompiler.autoRefresh.enabled === false, "resolved live autoRefresh is not false");
});

await check("Policy stable-view, Constraint events, and Constraint L2 projection remain configured", () => {
  assert(Number(live.ruleInjector?.propositionPolicyStableViewInjection?.maxReadBytes) > 0, "Policy stable-view infrastructure changed");
  assert(live.sediment?.constraintEvidenceEventWriter?.enabled === true, "Constraint event writer was disabled");
  assert(live.sediment?.constraintEvidenceEventWriter?.mode === "event_first", "Constraint event writer mode changed");
  assert(live.sediment?.constraintShadowCompiler?.l2OutputRoot === "repo", "Constraint L2 output root changed");
});

await check("schema documents one automatic kill switch without removing manual capability", () => {
  const compiler = schema.properties.sediment.properties.constraintShadowCompiler;
  const auto = compiler.properties.autoRefresh;
  const dual = schema.properties.ruleInjector.properties.dualReadAudit;
  assert(compiler.properties._comment?.type === "string", "constraint compiler operator comment is not schema-valid");
  assert(compiler.properties.enabled.default === false, "compiler default must stay opt-in");
  assert(auto.properties.enabled.default === false, "autoRefresh schema default must stay false");
  assert(auto.properties.enabled.description.includes("every automatic shadow compile trigger"), "autoRefresh kill-switch scope is undocumented");
  assert(auto.description.includes("startup Git sync") && auto.description.includes("compiled-view repair"), "automatic trigger inventory is incomplete");
  assert(dual.properties.enabled.default === false && dual.description.includes("production session hook does not execute"), "dual-read offline-only schema contract drifted");
});

await check("production rule hook cannot reach dual-read or Constraint compiled-view helpers", () => {
  const injector = source("extensions/abrain/rule-injector/index.ts");
  const hooks = sourceSlice(injector, 'maybePi.on("session_start"', 'if (typeof maybePi.registerCommand');
  for (const forbidden of [
    "runRuleInjectorDualReadAudit(",
    "readCompiledRuleInjectionForRuntime(",
    "decideRuntimeRuleInjection(",
    "scheduleSelfHeal(",
  ]) assert(!hooks.includes(forbidden), `production rule hook reaches ${forbidden}`);
  assert(hooks.includes("readPropositionPolicyStableViewForRuntime("), "Policy stable-view is not the production rule source");
});

await check("every retained automatic scheduler path is gated before compiler work", () => {
  const scheduler = source("extensions/sediment/constraint-compiler/auto-refresh.ts");
  const scheduleFn = sourceSlice(scheduler, "export async function scheduleConstraintShadowAutoRefresh", "export async function resumeConstraintShadowAutoRefreshAtStartup");
  assert(scheduleFn.indexOf("resolveLiveAutoRefreshTrigger(trigger)") >= 0, "scheduler live autoRefresh gate missing");
  assert(scheduleFn.indexOf("resolveLiveAutoRefreshTrigger(trigger)") < scheduleFn.indexOf("appendNeedsRefreshMarker"), "scheduler writes before live autoRefresh gate");
  const resumeFn = sourceSlice(scheduler, "export async function resumeConstraintShadowAutoRefreshAtStartup", "export async function ensureConstraintShadowLiveness");
  assert(resumeFn.indexOf("resolveLiveAutoRefreshTrigger(trigger)") < resumeFn.indexOf("readLatestNeedsRefreshMarker"), "startup resume reads marker before live autoRefresh gate");

  const abrain = source("extensions/abrain/index.ts");
  const gitSync = sourceSlice(abrain, "export async function maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync", "const releaseSessionGrants");
  assert(gitSync.indexOf("if (!compiler?.autoRefresh?.enabled)") >= 0, "startup Git sync autoRefresh gate missing");
  assert(gitSync.indexOf("if (!compiler?.autoRefresh?.enabled)") < gitSync.indexOf("return await schedule({"), "startup Git sync schedules before gate");
  const selfHeal = sourceSlice(abrain, "const queueSelfHealFlush", "setRuleInjectorSelfHealScheduler");
  assert(selfHeal.indexOf("!settings.constraintShadowCompiler?.autoRefresh?.enabled") >= 0, "compiled-view repair autoRefresh gate missing");
  assert(selfHeal.indexOf("!settings.constraintShadowCompiler?.autoRefresh?.enabled") < selfHeal.indexOf("defaultScheduleConstraintShadowAutoRefresh({"), "compiled-view repair schedules before gate");

  const sediment = source("extensions/sediment/index.ts");
  assert(!sediment.includes("runConstraintShadowCompiler("), "sediment production extension directly invokes the compiler");
});

await check("live event-write scheduling returns disabled without creating state", async () => {
  autoRefresh._resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-manual-only-event-"));
  const result = await autoRefresh.scheduleConstraintShadowAutoRefresh({
    abrainHome,
    cwd: repoRoot,
    settings: resolved,
    modelRegistry: {},
    reason: "constraint_evidence_event_appended",
    sourceEventId: "a".repeat(64),
  });
  assert(result.scheduled === false && result.reason === "auto_refresh_disabled", `event-write schedule escaped gate: ${JSON.stringify(result)}`);
  assert(!fs.existsSync(path.join(abrainHome, ".state")), "disabled event-write scheduling created state");
  autoRefresh._resetConstraintShadowAutoRefreshForTests();
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

await check("live startup resume and liveness paths cannot schedule a compile", async () => {
  autoRefresh._resetConstraintShadowAutoRefreshForTests();
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-manual-only-startup-"));
  const eventId = "b".repeat(64);
  const marker = path.join(abrainHome, ".state/sediment/constraint-shadow/auto-refresh/needs-refresh.jsonl");
  writeFile(marker, `${JSON.stringify({
    schemaVersion: "constraint-shadow-auto-refresh-needs-refresh/v1",
    observedAtUtc: "2026-07-21T00:00:00.000Z",
    reason: "startup_fixture",
    sourceEventId: eventId,
    sourceEventIds: [eventId],
    modelRef: "manual/retained",
  })}\n`);
  const trigger = {
    abrainHome,
    cwd: repoRoot,
    settings: resolved,
    modelRegistry: {},
    reason: "liveness_recovery",
  };
  const resumed = await autoRefresh.resumeConstraintShadowAutoRefreshAtStartup(trigger);
  const liveness = await autoRefresh.ensureConstraintShadowLiveness(trigger);
  assert(resumed.scheduled === false && resumed.reason === "auto_refresh_disabled", `startup resume escaped gate: ${JSON.stringify(resumed)}`);
  assert(liveness.scheduled === false && liveness.reason === "auto_refresh_disabled", `liveness recovery escaped gate: ${JSON.stringify(liveness)}`);
  assert(!fs.existsSync(path.join(abrainHome, ".state/sediment/constraint-shadow/auto-refresh/audit.jsonl")), "disabled startup path emitted retry/skip audit noise");
  assert(!fs.existsSync(path.join(abrainHome, ".state/sediment/constraint-shadow/latest")), "disabled startup path produced compiler artifacts");
  assert(!fs.existsSync(path.join(abrainHome, ".state/locks/constraint-shadow-auto-refresh.lock")), "disabled startup path acquired compiler lock");
  autoRefresh._resetConstraintShadowAutoRefreshForTests();
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

await check("manual compiler, dossier, dual-read audit, and migration substrate remain available", () => {
  const pkg = JSON.parse(source("package.json"));
  const dossier = source("scripts/dossier-constraint-shadow-report.mjs");
  const runner = source("extensions/sediment/constraint-compiler/shadow-runner.ts");
  const audit = source("extensions/abrain/rule-injector/dualread-audit.ts");
  const scheduler = source("extensions/sediment/constraint-compiler/auto-refresh.ts");
  assert(pkg.scripts["dossier:constraint-shadow-report"] === "node scripts/dossier-constraint-shadow-report.mjs", "manual dossier command missing");
  assert(dossier.includes("runConstraintShadowCompiler({") && dossier.includes("if (!WRITE)"), "manual dossier compiler path missing");
  assert(runner.includes("export async function runConstraintShadowCompiler"), "manual compiler export missing");
  assert(audit.includes("export function runRuleInjectorDualReadAudit"), "dual-read audit implementation was removed");
  assert(scheduler.includes("export async function scheduleConstraintShadowAutoRefresh") && scheduler.includes("export async function resumeConstraintShadowAutoRefreshAtStartup"), "future migration substrate was removed");

  const dryRun = spawnSync(process.execPath, [path.join(repoRoot, "scripts/dossier-constraint-shadow-report.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert(dryRun.status === 0, `manual dossier dry-run failed: ${dryRun.stdout}\n${dryRun.stderr}`);
  assert(dryRun.stdout.includes("SKIP") && dryRun.stdout.includes("dry-run mode does not call the real LLM"), "manual dossier dry-run contract drifted");
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; live automatic paths are unreachable and manual capability remains available`);
