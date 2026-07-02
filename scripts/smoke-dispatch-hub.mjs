#!/usr/bin/env node
/**
 * Smoke: ADR 0030 dispatch_hub pure logic (increment 2 + 3).
 *
 * Pins the OFFLINE-testable core of the caged-live hub: settings clamp,
 * roster flatten, cross-vendor hub-model selection, plan parse (tolerant),
 * plan validate (drop unknown models + cap to HARD_MAX_WORKERS + same-vendor
 * flag), and the additive audit row builders. The live LLM orchestration
 * (registerHubTool execute) is exercised by the owner flipping
 * dispatch.hub.enabled and dogfooding — it cannot be offline-smoked.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const hubSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/hub.ts"), "utf-8");
const dispatchSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf-8");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const hub = await jiti.import(`${repoRoot}/extensions/dispatch/hub.ts`);

const {
  HARD_MAX_WORKERS,
  resolveHubSettings,
  flattenRoster,
  selectHubModel,
  buildHubPlanPrompt,
  extractFirstJsonObject,
  parseHubPlan,
  validateHubPlan,
  buildHubDecisionRow,
  buildHubDispositionRow,
  buildHubSummaryRow,
} = hub;

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else { console.log(`  FAIL  ${msg}`); failures++; }
}

console.log("dispatch_hub pure logic (ADR 0030)");

// ── HARD ceiling ──
ok(HARD_MAX_WORKERS === 8, "HARD_MAX_WORKERS is 8 (non-tunable ceiling)");

// ── resolveHubSettings: defaults + clamps ──
const dflt = resolveHubSettings(undefined);
ok(dflt.enabled === false, "default enabled=false (kill-switch off)");
ok(dflt.maxWorkers === 8, "default maxWorkers=8");
ok(dflt.dualExecSampleRate === 0.2, "default dualExecSampleRate=0.2");
ok(resolveHubSettings({ maxWorkers: 99 }).maxWorkers === 8, "maxWorkers clamped down to 8");
ok(resolveHubSettings({ maxWorkers: 0 }).maxWorkers === 1, "maxWorkers clamped up to 1");
ok(resolveHubSettings({ maxWorkers: 3 }).maxWorkers === 3, "maxWorkers 3 preserved");
ok(resolveHubSettings({ dualExecSampleRate: 5 }).dualExecSampleRate === 1, "rate clamped to 1");
ok(resolveHubSettings({ dualExecSampleRate: -1 }).dualExecSampleRate === 0, "rate clamped to 0");
ok(resolveHubSettings({ enabled: true }).enabled === true, "enabled=true honored");
ok(resolveHubSettings({ enabled: "yes" }).enabled === false, "non-boolean enabled → false (strict)");
ok(resolveHubSettings({ model: "x/y" }).model === "x/y", "explicit model preserved");

// ── flattenRoster ──
// Real settings shape: { provider: [bareModelName, ...] } — full id = provider/bareName.
const roster = flattenRoster({
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6"],
  deepseek: ["deepseek-v4-pro"],
  weird: ["already/full-model"],
});
ok(roster.includes("anthropic/claude-opus-4-8") && roster.includes("deepseek/deepseek-v4-pro"), "flattenRoster builds provider/model from bare names");
ok(roster.includes("already/full-model"), "flattenRoster keeps already-full provider/model strings");
ok(flattenRoster(undefined).length === 0, "flattenRoster handles undefined");

// ── selectHubModel ──
const flagship = ["anthropic/claude-opus-4-8", "openai/gpt-5.5", "deepseek/deepseek-v4-pro"];
ok(selectHubModel({ explicit: "x/y", flagshipModels: flagship }) === "x/y", "explicit hub model wins");
ok(selectHubModel({ flagshipModels: flagship, avoidVendors: ["anthropic"] }) === "openai/gpt-5.5", "avoids the main-session vendor (decorrelation)");
ok(selectHubModel({ flagshipModels: flagship }) === "anthropic/claude-opus-4-8", "falls back to first flagship when no avoid");
ok(selectHubModel({ flagshipModels: [] }) === undefined, "no flagship → undefined");

// ── buildHubPlanPrompt ──
const prompt = buildHubPlanPrompt({ task: "audit X", roster: flagship, maxWorkers: 4, hubModel: "deepseek/deepseek-v4-pro" });
ok(prompt.includes("audit X"), "plan prompt includes the task");
ok(prompt.includes("anthropic/claude-opus-4-8"), "plan prompt lists roster models");
ok(prompt.includes("1..4 workers"), "plan prompt states the worker cap");
ok(prompt.includes('vendor "deepseek"'), "plan prompt tells hub its own vendor (for cross-vendor preference)");

// ── extractFirstJsonObject ──
ok(extractFirstJsonObject('prefix {"a":1} suffix') === '{"a":1}', "extracts first balanced object");
ok(extractFirstJsonObject('{"a":{"b":2},"c":3}') === '{"a":{"b":2},"c":3}', "handles nesting");
ok(extractFirstJsonObject('{"s":"has } brace"}') === '{"s":"has } brace"}', "ignores braces inside strings");
ok(extractFirstJsonObject("no json here") === undefined, "returns undefined when no object");

// ── parseHubPlan ──
const good = parseHubPlan('Here is the plan:\n{"workers":[{"model":"openai/gpt-5.5","role":"r1","prompt":"p1","thinking":"high"}],"rationale":"because"}');
ok(good.ok && good.plan.workers.length === 1 && good.plan.workers[0].model === "openai/gpt-5.5", "parses a valid plan from prose-wrapped JSON");
ok(good.ok && good.plan.rationale === "because", "captures rationale");
ok(parseHubPlan("no json").ok === false, "no JSON → not ok");
ok(parseHubPlan('{"rationale":"x"}').ok === false, "missing workers → not ok");
ok(parseHubPlan('{"workers":[{"role":"r"}]}').ok === false, "worker without model+prompt dropped → no usable workers → not ok");
const partial = parseHubPlan('{"workers":[{"model":"a/b","prompt":"p"},{"model":"","prompt":"p2"}]}');
ok(partial.ok && partial.plan.workers.length === 1, "drops workers missing model, keeps valid (role defaults)");
ok(partial.ok && partial.plan.workers[0].role === "worker", "missing role defaults to 'worker'");

// ── validateHubPlan: drop unknown models, cap, same-vendor flag ──
const vRoster = ["anthropic/claude-opus-4-8", "openai/gpt-5.5", "deepseek/deepseek-v4-pro"];
const planUnknown = { workers: [
  { model: "openai/gpt-5.5", role: "r", prompt: "p" },
  { model: "ghost/model", role: "r", prompt: "p" },
], rationale: "" };
const vu = validateHubPlan(planUnknown, { roster: vRoster, hubModel: "deepseek/deepseek-v4-pro", maxWorkers: 8 });
ok(vu.workers.length === 1 && vu.workers[0].model === "openai/gpt-5.5", "drops worker with model not in roster");
ok(vu.warnings.some((w) => w.includes("ghost/model")), "warns about dropped unknown model");

const planCap = { workers: Array.from({ length: 12 }, () => ({ model: "openai/gpt-5.5", role: "r", prompt: "p" })), rationale: "" };
const vc = validateHubPlan(planCap, { roster: vRoster, hubModel: "deepseek/deepseek-v4-pro", maxWorkers: 8 });
ok(vc.workers.length === 8, "caps to HARD_MAX_WORKERS=8 even if maxWorkers says 8 and plan has 12");
const vc3 = validateHubPlan(planCap, { roster: vRoster, hubModel: "deepseek/deepseek-v4-pro", maxWorkers: 3 });
ok(vc3.workers.length === 3, "caps to settings maxWorkers=3");

const planSame = { workers: [
  { model: "deepseek/deepseek-v4-pro", role: "r", prompt: "p" },
  { model: "openai/gpt-5.5", role: "r", prompt: "p" },
], rationale: "" };
const vs = validateHubPlan(planSame, { roster: vRoster, hubModel: "deepseek/deepseek-v4-pro", maxWorkers: 8 });
ok(vs.sameVendorAsHub === 1, "counts workers sharing the hub vendor (self-talk signal)");
ok(vs.warnings.some((w) => w.includes("self-talk")), "warns about same-vendor self-talk (flag, not reject)");
ok(vs.workers.length === 2, "same-vendor workers are FLAGGED not dropped (ADR 0030 §7)");

// ── audit row builders (additive row_kinds) ──
const dec = buildHubDecisionRow({
  hubModel: "deepseek/deepseek-v4-pro", hubThinking: "high", taskChars: 100, planText: "x".repeat(20000),
  workers: [{ model: "openai/gpt-5.5", role: "r", prompt: "p" }], rationale: "r", warnings: ["w"], sameVendorAsHub: 0,
  mainVendor: "anthropic", hubDurationMs: 1234, hubResult: "ok", usage: { input: 10, output: 20, cost: 0.01 },
});
ok(dec.row_kind === "hub_decision" && dec.operation === "dispatch_hub.decision", "decision row_kind/operation");
ok(dec.hub_vendor === "deepseek" && dec.decorrelated === true, "decision flags decorrelation (hub≠main vendor)");
ok(dec.hub_plan_text.length === 8000, "decision caps hub_plan_text to 8000 chars");
ok(Array.isArray(dec.worker_models) && dec.worker_models[0] === "openai/gpt-5.5", "decision lists worker_models");
ok(dec.hub_cost === 0.01, "decision carries hub cost (report-only)");

const disp = buildHubDispositionRow({ workerIndex: 2, workerCount: 3, model: "openai/gpt-5.5", role: "auditor", promptChars: 50 });
ok(disp.row_kind === "hub_disposition" && disp.worker_index === 2 && disp.vendor === "openai", "disposition row shape");

const sum = buildHubSummaryRow({ workerCount: 3, successCount: 2, failedCount: 1, terminalState: "degraded", hubCost: 0.01, workersCost: 0.5, hubDurationMs: 1000, totalWallMs: 5000, dualExecSampled: true });
ok(sum.row_kind === "hub_summary" && sum.terminal_state === "degraded", "summary row shape");
ok(sum.total_cost === 0.51, "summary totals hub+workers cost");
ok(sum.main_session_disposition === "unobserved", "summary disposition placeholder (filled post-hoc by oracle)");
ok(sum.dual_exec_sampled === true, "summary carries dual-exec sampling flag");

// ── live shell source wiring: hub must use dispatch tool-block progress ──
ok(/progress:\s*\{[\s\S]{0,900}?startTicker/.test(hubSrc), "HubDeps accepts dispatch progress helpers");
ok(/renderShell:\s*"self"[\s\S]{0,160}?renderCall[\s\S]{0,160}?renderResult/.test(hubSrc), "dispatch_hub uses self-rendered tool blocks");
ok(/progress\.startTicker\(onUpdate,\s*progressSnapshot\)/.test(hubSrc), "dispatch_hub starts the onUpdate progress ticker");
ok(/name:\s*"hub planner"[\s\S]{0,120}?model:\s*hubModel[\s\S]{0,120}?thinking:\s*hubCfg\.thinking/.test(hubSrc), "dispatch_hub creates a visible hub planner progress row");
ok(/workerProgressTasks\s*=\s*tasks\.map[\s\S]{0,400}?progress\.taskFromSpec/.test(hubSrc), "dispatch_hub creates worker progress rows after planning");
ok(/onProgress:\s*\(p:\s*\{\s*reason:\s*string;\s*at:\s*number\s*\}\)\s*=>\s*progress\.markProgress/.test(hubSrc), "dispatch_hub forwards heartbeat progress to progress rows");
ok(/progress:\s*\{[\s\S]{0,500}?taskFromSpec:\s*progressTaskFromSpec[\s\S]{0,500}?startTicker:\s*startDispatchProgressTicker[\s\S]{0,500}?details:\s*dispatchProgressDetails/.test(dispatchSrc), "dispatch index injects progress helpers into dispatch_hub");
ok(/renderCall:\s*renderDispatchHubCall[\s\S]{0,120}?renderResult:\s*renderDispatchToolResult/.test(dispatchSrc), "dispatch index injects hub tool-block renderers");

console.log();
if (failures === 0) {
  console.log("✅ dispatch_hub pure logic: all checks passed");
  process.exit(0);
} else {
  console.log(`❌ dispatch_hub: ${failures} assertion(s) failed`);
  process.exit(1);
}
