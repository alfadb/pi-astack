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

function verdictAt(profile, count) {
  const emitted = new Set();
  let last;
  for (let i = 1; i <= count; i++) {
    last = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, profile, i, emitted);
    if (last.stage && !last.terminal) emitted.add(last.stage);
    if (last.terminal) return last;
  }
  return last;
}

ok(inferTaskGovernorProfile(undefined, undefined) === "read_only", "default worker profile is read_only");
ok(inferTaskGovernorProfile("read,grep,bash", undefined) === "mutating_default", "mutating tools infer mutating_default");
ok(inferTaskGovernorProfile("read,edit", "implementation") === "implementation", "explicit implementation overrides mutating-default inference");
ok(inferTaskGovernorProfile("read,grep", "research") === "research", "explicit research profile is honored");

{
  const checkpoint = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, "read_only", 60, new Set());
  ok(checkpoint.stage === "checkpoint" && !checkpoint.terminal && checkpoint.limit === 60, "read_only checkpoint at 60 is non-terminal");

  const audit = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, "read_only", 90, new Set(["checkpoint"]));
  ok(audit.stage === "audit_pause" && !audit.terminal && audit.limit === 90, "read_only audit_pause at 90 is non-terminal");

  const stop120 = verdictAt("read_only", 120);
  ok(stop120.stage === "fresh_auth" && stop120.terminal && stop120.failureType === "guardrail_stop" && stop120.limit === 120, "read_only reaches fresh-auth guardrail at 120");

  const stop121 = verdictAt("read_only", 121);
  ok(stop121.stage === "fresh_auth" && stop121.terminal && stop121.failureType === "guardrail_stop", "read_only at 121 remains guardrail_stop partial-return path");

  ok(DEFAULT_DISPATCH_SETTINGS.taskGovernor.profiles.read_only.hard === 180, "read_only hard cap remains configured at 180 for future grant flow");
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
