#!/usr/bin/env node
/** Offline smoke for non-terminal dispatch task-governor audit stages. */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const dispatch = await jiti.import(path.join(__dirname, "..", "extensions/dispatch/index.ts"));
const settingsMod = await jiti.import(path.join(__dirname, "..", "extensions/dispatch/settings.ts"));
const profileMod = await jiti.import(path.join(__dirname, "..", "extensions/dispatch/task-profile.ts"));

const { dispatchTaskProfileSchema, evaluateTaskGovernor, inferTaskGovernorProfile } = dispatch;
const { DEFAULT_DISPATCH_SETTINGS, resolveDispatchSettings } = settingsMod;
const { DISPATCH_TASK_PROFILES, resolveDispatchTaskProfileAliases } = profileMod;

let fails = 0;
const ok = (cond, msg, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}${!cond && detail ? `: ${detail}` : ""}`);
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
    if (verdict.terminal) throw new Error(`${profile} terminated at ${i}`);
  }
  return verdicts;
}

const expectedMapping = {
  reviewer: "read_only",
  read_only: "read_only",
  research: "research",
  implementation: "implementation",
  heavy: "implementation",
};
for (const [input, expected] of Object.entries(expectedMapping)) {
  ok(inferTaskGovernorProfile("read,bash", input) === expected, `${input} maps to ${expected}`);
}
ok(inferTaskGovernorProfile(undefined, undefined) === "read_only", "default worker profile is read_only");
ok(inferTaskGovernorProfile("read,grep,bash", undefined) === "mutating_default", "mutating tools infer mutating_default without an explicit profile");

const schema = dispatchTaskProfileSchema("smoke");
const schemaValues = new Set((schema.anyOf ?? []).map((node) => node.const));
ok(
  DISPATCH_TASK_PROFILES.every((value) => schemaValues.has(value)) && schemaValues.size === DISPATCH_TASK_PROFILES.length,
  "TypeBox entry schema contains exactly the five legal profile literals",
  JSON.stringify(schema),
);
for (const invalid of ["reviewer/read_only", "implementation/heavy", "review", "readonly", "RESEARCH", " research "]) {
  ok(!schemaValues.has(invalid), `TypeBox entry schema rejects ${JSON.stringify(invalid)}`);
  let rejected = false;
  try { resolveDispatchTaskProfileAliases(invalid, undefined); } catch { rejected = true; }
  ok(rejected, `normalization rejects ${JSON.stringify(invalid)}`);
}
let invalidPrimaryRejected = false;
try { resolveDispatchTaskProfileAliases("reviewer/read_only", "research"); } catch { invalidPrimaryRejected = true; }
ok(invalidPrimaryRejected, "illegal taskProfile cannot silently override a legal profile alias");
let conflictRejected = false;
try { resolveDispatchTaskProfileAliases("research", "heavy"); } catch { conflictRejected = true; }
ok(conflictRejected, "conflicting legal taskProfile/profile aliases are rejected");
ok(resolveDispatchTaskProfileAliases("research", "research") === "research", "matching taskProfile/profile aliases are accepted");

const expectedStages = {
  read_only: [["checkpoint", 60], ["audit_pause", 90], ["fresh_auth", 120]],
  research: [["checkpoint", 80], ["audit_pause", 120], ["fresh_auth", 160]],
  implementation: [["checkpoint", 120], ["audit_pause", 180], ["fresh_auth", 240]],
  mutating_default: [["checkpoint", 60], ["audit_pause", 100], ["fresh_auth", 120]],
};
for (const [profile, expected] of Object.entries(expectedStages)) {
  const verdicts = verdictsThrough(profile, 1000);
  ok(
    JSON.stringify(verdicts.map(({ stage, limit, terminal }) => [stage, limit, terminal])) ===
      JSON.stringify(expected.map(([stage, limit]) => [stage, limit, false])),
    `${profile} emits checkpoint/audit_pause/fresh_auth once and only once`,
    JSON.stringify(verdicts),
  );
}

for (const count of [120, 180, 240, 360, 720, 1000]) {
  for (const profile of Object.keys(expectedStages)) {
    const emitted = new Set(["checkpoint", "audit_pause", "fresh_auth"]);
    const verdict = evaluateTaskGovernor(DEFAULT_DISPATCH_SETTINGS.taskGovernor, profile, count, emitted);
    ok(!verdict.terminal && verdict.stage === undefined, `${profile} remains non-terminal at ${count} cumulative tool calls`);
  }
}

{
  const resolved = resolveDispatchSettings({ dispatch: { taskGovernor: { enabled: false } } });
  const verdict = evaluateTaskGovernor(resolved.taskGovernor, "read_only", 999, new Set());
  ok(!verdict.stage && !verdict.terminal, "taskGovernor.enabled=false disables all audit stages");
}

if (fails) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
console.log("\ndispatch task governor smoke passed");
