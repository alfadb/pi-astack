#!/usr/bin/env node
/**
 * Deterministic smoke for dispatch task-governor budgets.
 * No LLM, no AgentSession, no provider calls.
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const dispatch = await jiti.import(path.join(__dirname, "..", "extensions/dispatch/index.ts"));
const settingsMod = await jiti.import(path.join(__dirname, "..", "extensions/dispatch/settings.ts"));

const {
  evaluateTaskGovernor,
  inferTaskGovernorProfile,
} = dispatch;
const {
  DEFAULT_DISPATCH_SETTINGS,
  resolveDispatchSettings,
} = settingsMod;

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) fails++;
};

function verdictsThrough(profile, count) {
  const emitted = new Set();
  const verdicts = [];
  for (let i = 1; i <= count; i++) {
    const verdict = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, profile, i, emitted);
    if (verdict.stage) {
      verdicts.push(verdict);
      emitted.add(verdict.stage);
    }
    if (verdict.terminal) break;
  }
  return verdicts;
}

function verdictAt(profile, count) {
  return verdictsThrough(profile, count).at(-1);
}

ok(inferTaskGovernorProfile(undefined, undefined) === "read_only", "default worker profile is read_only");
ok(inferTaskGovernorProfile("read,grep,bash", undefined) === "mutating_default", "mutating tools infer mutating_default without an explicit profile");
ok(inferTaskGovernorProfile("read,bash", "read_only") === "read_only", "explicit read_only overrides mutating-tool inference");
ok(inferTaskGovernorProfile("read,bash", "reviewer") === "read_only", "explicit reviewer alias overrides mutating-tool inference");
ok(inferTaskGovernorProfile("read,edit", "implementation") === "implementation", "explicit implementation overrides mutating-default inference");
ok(inferTaskGovernorProfile("read,bash", "heavy") === "implementation", "explicit heavy alias overrides mutating-default inference");
ok(inferTaskGovernorProfile("read,grep", "research") === "research", "explicit research profile is honored");

{
  const checkpoint = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, "read_only", 60, new Set());
  ok(checkpoint.stage === "checkpoint" && !checkpoint.terminal && checkpoint.limit === 60, "read_only checkpoint at 60 is non-terminal");

  const audit = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, "read_only", 90, new Set(["checkpoint"]));
  ok(audit.stage === "audit_pause" && !audit.terminal && audit.limit === 90, "read_only audit_pause at 90 is non-terminal");

  const through121 = verdictsThrough("read_only", 121);
  const freshAuth = through121.filter((verdict) => verdict.stage === "fresh_auth");
  ok(freshAuth.length === 1 && !freshAuth[0].terminal && freshAuth[0].failureType === undefined && freshAuth[0].limit === 120, "read_only emits fresh_auth once as a non-terminal checkpoint");

  const hard180 = verdictAt("read_only", 180);
  ok(hard180.stage === "hard" && hard180.terminal && hard180.failureType === "tool_budget_exceeded" && hard180.limit === 180, "read_only hard-stops at 180 after continuing past fresh_auth");

  ok(DEFAULT_DISPATCH_SETTINGS.taskGovernor.profiles.read_only.hard === 180, "read_only hard cap remains configured at 180");
}

{
  const checkpoint = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, "mutating_default", 60, new Set());
  ok(checkpoint.stage === "checkpoint" && !checkpoint.terminal && checkpoint.limit === 60, "mutating_default checkpoint at 60 is non-terminal");

  const audit = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, "mutating_default", 100, new Set(["checkpoint"]));
  ok(audit.stage === "audit_pause" && !audit.terminal && audit.limit === 100, "mutating_default audit_pause at 100 is non-terminal");

  const hard120 = verdictAt("mutating_default", 120);
  ok(hard120.stage === "hard" && hard120.terminal && hard120.failureType === "tool_budget_exceeded" && hard120.limit === 120, "mutating_default hard-stops at 120");

  const hard121 = verdictAt("mutating_default", 121);
  ok(hard121.stage === "hard" && hard121.terminal && hard121.failureType === "tool_budget_exceeded", "mutating_default at 121 is tool_budget_exceeded");
}

{
  const resolved = resolveDispatchSettings({ dispatch: { taskGovernor: { enabled: false } } });
  const verdict = evaluateTaskGovernor(resolved.taskGovernor, "read_only", 999, new Set());
  ok(!verdict.stage && !verdict.terminal, "taskGovernor.enabled=false disables all budget gates");
}

if (fails) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
console.log("\ndispatch task governor smoke passed");
