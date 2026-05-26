#!/usr/bin/env node
/**
 * Smoke: compaction-tuner backoff state machine (2026-05-21 fix).
 *
 * Pi-astack's compaction-tuner extension used to form an unbounded
 * retry storm when ctx.compact() failed (observed 2026-05-18: 7
 * triggers in 71s, identical percent=130.93%, identical OpenAI 500).
 * Root cause: onError unconditionally re-armed `armedBySession`,
 * collapsing the hysteresis state-machine into "fire on every
 * agent_end forever".
 *
 * The fix replaces re-arm-on-error with:
 *   - failureCountBySession (per-session error counter)
 *   - cooldownUntilBySession (exponential backoff 60s/120s/240s, cap 5min)
 *   - MAX_CONSECUTIVE_FAILURES=3 hard cap (permanent disarm after this)
 *   - Top-of-handler timed re-arm: grants ONE fresh attempt after
 *     cooldown IFF failures < MAX
 *   - Opportunistic backoff clear: if percent drops below the rearm
 *     floor regardless of armed state, wipe failure history (real
 *     progress was made, fresh slate)
 *   - onComplete clears ALL session state (DEEPSEEK P1-2: don't leak
 *     armedBySession entries)
 *   - `/compaction-tuner reset` subcommand: escape hatch from
 *     permanent disarm on overflowed contexts (where percent can't
 *     drop without compact succeeding)
 *
 * What this smoke covers:
 *   1. Pure unit tests for `classifyDecision` (the exported decision
 *      function) — all 5 branches.
 *   2. End-to-end state-machine simulation: feeds a sequence of
 *      agent_end events into a reference reproduction of the state
 *      machine and asserts (a) bounded retry count and (b) correct
 *      backoff escalation.
 *   3. Source-anchor assertions: greps index.ts to ensure the
 *      simulation stays in sync with the real implementation. If
 *      someone refactors index.ts without updating constants or
 *      control flow, these anchors fail and the engineer knows the
 *      simulation no longer represents reality.
 *
 * What this smoke deliberately does NOT cover:
 *   - The pi ExtensionAPI registration path (requires a full pi
 *     runtime mock; too brittle, covered by integration in real use).
 *   - The /compaction-tuner reset command's actual UI output (it's
 *     a thin wrapper around the three state maps).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
let totalChecks = 0;

function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("Smoke: compaction-tuner backoff state machine\n");

// ──────────────────────────────────────────────────────────────────
// Source-anchor assertions FIRST. If these fail, the simulation
// below is testing something that doesn't match reality, so don't
// bother continuing.
// ──────────────────────────────────────────────────────────────────

const indexSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/compaction-tuner/index.ts"),
  "utf8",
);

console.log("source anchors (sim ↔ implementation sync):");

check("constants match: ERROR_COOLDOWN_BASE_MS = 60_000", () => {
  if (!/const\s+ERROR_COOLDOWN_BASE_MS\s*=\s*60_000\b/.test(indexSrc)) {
    throw new Error("ERROR_COOLDOWN_BASE_MS not 60_000 in index.ts");
  }
});

check("constants match: ERROR_COOLDOWN_MAX_MS = 5 * 60_000", () => {
  if (!/const\s+ERROR_COOLDOWN_MAX_MS\s*=\s*5\s*\*\s*60_000\b/.test(indexSrc)) {
    throw new Error("ERROR_COOLDOWN_MAX_MS not 5 * 60_000 in index.ts");
  }
});

check("constants match: MAX_CONSECUTIVE_FAILURES = 3", () => {
  if (!/const\s+MAX_CONSECUTIVE_FAILURES\s*=\s*3\b/.test(indexSrc)) {
    throw new Error("MAX_CONSECUTIVE_FAILURES not 3 in index.ts");
  }
});

check("anchor: onError does NOT immediately re-arm armedBySession", () => {
  // The original storm bug was `armedBySession.set(stateKey, true)`
  // inside onError. Make sure that exact pattern is gone.
  const onErrorBlock = indexSrc.split("onError: (error) =>")[1];
  if (!onErrorBlock) throw new Error("onError handler block not found");
  // Stop scanning at the next top-level callback boundary.
  const onErrorBody = onErrorBlock.split(/\n {6}}\),?\s*\n/)[0];
  if (/armedBySession\.set\(stateKey,\s*true\)/.test(onErrorBody)) {
    throw new Error(
      "REGRESSION: onError still contains `armedBySession.set(stateKey, true)` " +
      "— this is the original storm bug. Replace with failure/cooldown bump.",
    );
  }
});

check("anchor: top-of-handler timed re-arm block present", () => {
  if (!/Timed re-arm after error cooldown/.test(indexSrc)) {
    throw new Error("Timed re-arm block comment missing in index.ts");
  }
  if (!/failuresSoFar\s*<\s*MAX_CONSECUTIVE_FAILURES/.test(indexSrc)) {
    throw new Error("Timed re-arm missing failures < MAX guard");
  }
  if (!/nowMs\s*>=\s*cooldownUntil/.test(indexSrc)) {
    throw new Error("Timed re-arm missing cooldown-elapsed guard");
  }
});

check("anchor: opportunistic clear (P1-1 fix) is present before agent_end classifyDecision", () => {
  const agentEndBlock = indexSrc.split('pi.on("agent_end"')[1];
  if (!agentEndBlock) throw new Error("agent_end handler block not found");
  const opportunisticIdx = agentEndBlock.indexOf("Opportunistic backoff clear");
  const classifyIdx = agentEndBlock.indexOf("const decision = classifyDecision(");
  if (opportunisticIdx < 0) {
    throw new Error("Opportunistic backoff clear block missing from agent_end handler");
  }
  if (classifyIdx < 0) {
    throw new Error("classifyDecision call site missing from agent_end handler");
  }
  if (opportunisticIdx > classifyIdx) {
    throw new Error(
      "Opportunistic clear must come BEFORE classifyDecision in agent_end — see P1-1 " +
      "in review summary",
    );
  }
});

check("anchor: onComplete deletes armedBySession (DEEPSEEK P1-2)", () => {
  const onCompleteBlock = indexSrc.split("onComplete: () =>")[1];
  if (!onCompleteBlock) throw new Error("onComplete handler block not found");
  const onCompleteBody = onCompleteBlock.split(/\n {8}},/)[0];
  if (!/recordSuccessfulTriggerState\(stateKey\)/.test(onCompleteBody)) {
    throw new Error(
      "onComplete should call recordSuccessfulTriggerState(stateKey) to delete armed/failure/cooldown state",
    );
  }
  if (!/function\s+recordSuccessfulTriggerState[\s\S]*armedBySession\.delete\(stateKey\)/.test(indexSrc)) {
    throw new Error("recordSuccessfulTriggerState should delete armedBySession to prevent map accumulation");
  }
});

check("anchor: MAX-reached notify warns user about /compaction-tuner reset", () => {
  if (!/auto-compaction disabled for this session/.test(indexSrc)) {
    throw new Error("MAX-reached user-facing notify missing");
  }
  if (!/\/compaction-tuner reset/.test(indexSrc)) {
    throw new Error(
      "MAX-reached notify should reference /compaction-tuner reset as escape hatch",
    );
  }
});

check("anchor: /compaction-tuner reset subcommand exists", () => {
  if (!/if \(sub === "reset"\)/.test(indexSrc)) {
    throw new Error("`if (sub === \"reset\")` branch missing in registerCommand");
  }
});

check("audit field name consistency: cooldown_remaining_ms not cooldown_ms", () => {
  // OPUS P2-4: rename cooldown_ms → cooldown_remaining_ms so audit
  // consumers can find all cooldown observations with one column name.
  if (/cooldown_ms:/.test(indexSrc)) {
    throw new Error(
      "Found `cooldown_ms:` in audit row — should be `cooldown_remaining_ms:` " +
      "(OPUS P2-4 normalization)",
    );
  }
});

check("anchor: summaryModels custom compaction hook exists and default stays empty", () => {
  const settingsSrc = fs.readFileSync(
    path.join(repoRoot, "extensions/compaction-tuner/settings.ts"),
    "utf8",
  );
  if (!/summaryModels:\s*\[\]/.test(settingsSrc)) {
    throw new Error("DEFAULT_COMPACTION_TUNER_SETTINGS.summaryModels must stay [] so default = main session model");
  }
  if (!/pi\.on\("session_before_compact"/.test(indexSrc)) {
    throw new Error("session_before_compact hook missing for custom summary model override");
  }
  if (!/runPiCompaction\(/.test(indexSrc)) {
    throw new Error("custom hook should delegate to pi core compact() implementation for summary fidelity");
  }
  if (!/fallback_to_default/.test(indexSrc)) {
    throw new Error("all custom summary model failures must fall back to pi core default compaction");
  }
  if (!/custom_summary_hook_threw/.test(indexSrc)) {
    throw new Error("unexpected hook throws must be caught and fall back to pi core default compaction");
  }
  if (!/hasSummaryModelsKey\s*\?\s*explicitSummaryModels\s*:\s*legacySummaryModel/.test(settingsSrc)) {
    throw new Error("explicit summaryModels: [] must override deprecated summaryModel and preserve default main-session model");
  }
});

check("anchor: turn-boundary compaction patch is installed via pi-internals", () => {
  const internalsSrc = fs.readFileSync(
    path.join(repoRoot, "extensions/_shared/pi-internals.ts"),
    "utf8",
  );
  if (!/installTurnBoundaryCompactionPatch/.test(indexSrc)) {
    throw new Error("compaction-tuner must install the turn-boundary patch");
  }
  if (!/AgentSession\._buildRuntime/.test(internalsSrc)) {
    throw new Error("pi-internals patch must anchor on AgentSession._buildRuntime");
  }
  if (!/agent\.prepareNextTurn\s*=\s*async/.test(internalsSrc)) {
    throw new Error("pi-internals must install an agent.prepareNextTurn wrapper");
  }
  if (!/_runAutoCompaction\("threshold",\s*true\)/.test(internalsSrc)) {
    throw new Error("turn-boundary compaction must call _runAutoCompaction('threshold', true)");
  }
  if (!/lastMessageRole\s*!==\s*"toolResult"/.test(indexSrc)) {
    throw new Error("turn-boundary trigger must only fire after toolResult is the last message");
  }
  if (!/operation:\s*"turn_boundary_trigger"/.test(indexSrc)) {
    throw new Error("turn-boundary trigger audit rows are missing");
  }
});

check("anchor: status displays default main-session model when summaryModels empty", () => {
  if (!/default — main session model/.test(indexSrc)) {
    throw new Error("/compaction-tuner status should show empty summaryModels as default main-session model");
  }
});

check("anchor: dynamic threshold defaults and audit fields are present", () => {
  const settingsSrc = fs.readFileSync(
    path.join(repoRoot, "extensions/compaction-tuner/settings.ts"),
    "utf8",
  );
  if (!/dynamicThreshold:\s*DEFAULT_DYNAMIC_THRESHOLD_SETTINGS/.test(settingsSrc)) {
    throw new Error("DEFAULT_COMPACTION_TUNER_SETTINGS must include dynamicThreshold defaults");
  }
  if (!/smallWindowThresholdPercent:\s*60/.test(settingsSrc)) {
    throw new Error("smallWindowThresholdPercent default should be 60 for 272k-class windows");
  }
  if (!/mediumWindowThresholdPercent:\s*65/.test(settingsSrc)) {
    throw new Error("mediumWindowThresholdPercent default should be 65 for 400k-class windows");
  }
  if (!/largeWindowThresholdPercent:\s*70/.test(settingsSrc)) {
    throw new Error("largeWindowThresholdPercent default should be 70 for 1M-class windows");
  }
  if (!/minHeadroomTokens:\s*64_000/.test(settingsSrc)) {
    throw new Error("minHeadroomTokens default should be 64_000");
  }
  if (!/"openai\/gpt-5\.5":\s*272_000/.test(settingsSrc)) {
    throw new Error("OpenAI API gpt-5.5 should default to the 272k economic budget");
  }
  if (!/isPlainObject\(raw\.modelEffectiveContextBudgets\) \? \{\} : def\.modelEffectiveContextBudgets/.test(settingsSrc)) {
    throw new Error("plain-object modelEffectiveContextBudgets should replace the default map, while invalid values preserve defaults");
  }
  if (!/Math\.min\(\s*90,[\s\S]*Math\.max\(0, asNumber\(block\.rearmMarginPercent/.test(settingsSrc)) {
    throw new Error("rearmMarginPercent should clamp to [0, 90]");
  }
  if (!/computeEffectiveRearmMargin/.test(indexSrc)) {
    throw new Error("effective rearm margin should be capped below the effective threshold");
  }
  const schemaSrc = fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8");
  if (!/"rearmMarginPercent"[\s\S]*"maximum": 90/.test(schemaSrc)) {
    throw new Error("schema should cap rearmMarginPercent at 90");
  }
  if (!/computeEffectiveThreshold/.test(indexSrc)) {
    throw new Error("computeEffectiveThreshold helper missing");
  }
  if (!/estimatedTokens/.test(indexSrc)) {
    throw new Error("metric helper should estimate tokens from rawPercent when usage.tokens is absent");
  }
  if (!/outcome:\s*result \? "completed" : "no_op"/.test(indexSrc)) {
    throw new Error("turn-boundary false return should be audited as no_op");
  }
  if (!/armedBySession\.set\(stateKey, \/\* armed \*\/ false\);/.test(indexSrc)) {
    throw new Error("turn-boundary no_op should stay disarmed without counting as failure");
  }
  if (!/error_message:\s*compactErrorMessage\(error\)/.test(indexSrc)) {
    throw new Error("agent_end onError should truncate audit error messages");
  }
  if (!/configured_threshold_percent/.test(indexSrc)) {
    throw new Error("audit rows should include configured_threshold_percent");
  }
  if (!/effective_context_budget/.test(indexSrc)) {
    throw new Error("audit rows should include effective_context_budget");
  }
});

// ──────────────────────────────────────────────────────────────────
// Pure-function tests for `classifyDecision` and threshold math.
// ──────────────────────────────────────────────────────────────────

console.log("\nclassifyDecision (pure function, 5 branches):");

// classifyDecision and computeEffectiveThreshold live in index.ts, but
// pulling the full module would drag in pi runtime + memory/settings +
// _shared/runtime. The smoke catches drift via source anchors above; we
// reimplement the small pure helpers here for isolation.
function classifyDecision(percent, threshold, armed, rearmMargin) {
  if (percent === null) return { decision: "skip", reason: "no_usage_yet" };
  if (percent < threshold - rearmMargin && !armed) {
    return { decision: "rearm", reason: "below_rearm_floor" };
  }
  if (percent < threshold) return { decision: "skip", reason: "below_threshold" };
  if (!armed) return { decision: "skip", reason: "already_triggered_awaiting_rearm" };
  return { decision: "trigger" };
}

check("classifyDecision: percent=null → skip no_usage_yet", () => {
  const r = classifyDecision(null, 75, true, 5);
  if (r.decision !== "skip" || r.reason !== "no_usage_yet") {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("classifyDecision: percent<floor && !armed → rearm", () => {
  const r = classifyDecision(50, 75, false, 5);
  if (r.decision !== "rearm") throw new Error(`got ${JSON.stringify(r)}`);
});

check("classifyDecision: percent<threshold && armed → skip below_threshold", () => {
  // (This is the gap P1-1 exposed: timed re-arm sets armed=true, so
  // even when percent dropped, classifyDecision returns this skip
  // instead of the rearm branch — meaning failure state never gets
  // cleared via this path. The opportunistic-clear block handles it.)
  const r = classifyDecision(50, 75, true, 5);
  if (r.decision !== "skip" || r.reason !== "below_threshold") {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("classifyDecision: percent>=threshold && armed → trigger", () => {
  const r = classifyDecision(80, 75, true, 5);
  if (r.decision !== "trigger") throw new Error(`got ${JSON.stringify(r)}`);
});

check("classifyDecision: percent>=threshold && !armed → skip awaiting_rearm", () => {
  // The post-trigger steady state: armed=false after a fire, and
  // percent stays high. We must NOT re-trigger until either timed
  // re-arm or percent-based rearm fires.
  const r = classifyDecision(80, 75, false, 5);
  if (r.decision !== "skip" || r.reason !== "already_triggered_awaiting_rearm") {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

// Boundary: percent exactly at threshold-margin (rearm floor).
check("classifyDecision: percent exactly at threshold-margin && !armed → skip below_threshold (NOT rearm)", () => {
  // < is strict, so equality (percent == floor) falls past the rearm
  // branch into below_threshold. Then since !armed it could match the
  // awaiting_rearm branch — but classifyDecision short-circuits on
  // percent<threshold FIRST. Verifying that ordering matters: this
  // is the boundary that determines whether "slightly below threshold"
  // sessions can ever rearm.
  const r = classifyDecision(70, 75, false, 5);
  if (r.decision !== "skip" || r.reason !== "below_threshold") {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("classifyDecision: percent strictly below floor && !armed → rearm (boundary check)", () => {
  const r = classifyDecision(69.99, 75, false, 5);
  if (r.decision !== "rearm") {
    throw new Error(`got ${JSON.stringify(r)} (boundary off-by-one in rearm branch?)`);
  }
});

console.log("\ndynamic threshold helper:");

function computeEffectiveThresholdForSmoke(settings, usage, modelInfo) {
  const configured = settings.thresholdPercent;
  const dynamic = settings.dynamicThreshold;
  if (!dynamic.enabled) return { thresholdPercent: configured, reason: "configured" };
  const ref = modelInfo.provider && modelInfo.id ? `${modelInfo.provider}/${modelInfo.id}` : undefined;
  const override = ref ? dynamic.modelEffectiveContextBudgets[ref] : undefined;
  const runtimeWindow = usage?.contextWindow ?? modelInfo.contextWindow;
  const budget = override && Number.isFinite(override) && override > 0
    ? runtimeWindow && runtimeWindow > 0 ? Math.min(override, runtimeWindow) : override
    : runtimeWindow && Number.isFinite(runtimeWindow) && runtimeWindow > 0 ? runtimeWindow : undefined;
  if (!budget) return { thresholdPercent: configured, reason: "configured" };
  const classCap = budget <= dynamic.smallWindowMaxTokens
    ? dynamic.smallWindowThresholdPercent
    : budget <= dynamic.mediumWindowMaxTokens
      ? dynamic.mediumWindowThresholdPercent
      : dynamic.largeWindowThresholdPercent;
  const headroomCap = dynamic.minHeadroomTokens > 0 && budget > dynamic.minHeadroomTokens
    ? Math.max(10, Math.min(95, Math.floor(((budget - dynamic.minHeadroomTokens) / budget) * 100)))
    : 95;
  return {
    thresholdPercent: Math.min(configured, classCap, headroomCap),
    effectiveContextBudget: budget,
    reason: "dynamic",
  };
}

const dynamicDefaults = {
  thresholdPercent: 75,
  rearmMarginPercent: 5,
  dynamicThreshold: {
    enabled: true,
    smallWindowMaxTokens: 300000,
    smallWindowThresholdPercent: 60,
    mediumWindowMaxTokens: 450000,
    mediumWindowThresholdPercent: 65,
    largeWindowMaxTokens: 1100000,
    largeWindowThresholdPercent: 70,
    minHeadroomTokens: 64000,
    modelEffectiveContextBudgets: { "openai/gpt-5.5": 272000 },
  },
};

check("dynamic threshold: 272k-class windows compact at 60%", () => {
  const r = computeEffectiveThresholdForSmoke(dynamicDefaults, { contextWindow: 272000 }, { provider: "openai-codex", id: "gpt-5.5" });
  if (r.thresholdPercent !== 60 || r.effectiveContextBudget !== 272000) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("dynamic threshold: OpenAI API gpt-5.5 uses 272k economic budget by default", () => {
  const r = computeEffectiveThresholdForSmoke(dynamicDefaults, { contextWindow: 1050000 }, { provider: "openai", id: "gpt-5.5" });
  if (r.thresholdPercent !== 60 || r.effectiveContextBudget !== 272000) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("dynamic threshold: 400k-class windows compact at 65%", () => {
  const r = computeEffectiveThresholdForSmoke(dynamicDefaults, { contextWindow: 400000 }, { provider: "github-copilot", id: "gpt-5.5" });
  if (r.thresholdPercent !== 65 || r.effectiveContextBudget !== 400000) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("dynamic threshold: 1M-class windows compact at 70%", () => {
  const r = computeEffectiveThresholdForSmoke(dynamicDefaults, { contextWindow: 1050000 }, { provider: "anthropic", id: "claude-opus-4-7" });
  if (r.thresholdPercent !== 70 || r.effectiveContextBudget !== 1050000) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("dynamic threshold: >large windows continue using the large-window cap", () => {
  const r = computeEffectiveThresholdForSmoke(dynamicDefaults, { contextWindow: 2000000 }, { provider: "example", id: "two-million" });
  if (r.thresholdPercent !== 70 || r.effectiveContextBudget !== 2000000) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("dynamic threshold: disabling dynamic restores configured threshold", () => {
  const settings = {
    ...dynamicDefaults,
    dynamicThreshold: { ...dynamicDefaults.dynamicThreshold, enabled: false },
  };
  const r = computeEffectiveThresholdForSmoke(settings, { contextWindow: 272000 }, { provider: "openai-codex", id: "gpt-5.5" });
  if (r.thresholdPercent !== 75 || r.reason !== "configured") {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

check("dynamic threshold: tiny budgets do not collapse to the 10% floor when minHeadroom exceeds budget", () => {
  const r = computeEffectiveThresholdForSmoke(dynamicDefaults, { contextWindow: 50000 }, { provider: "legacy", id: "tiny" });
  if (r.thresholdPercent !== 60 || r.effectiveContextBudget !== 50000) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

function computeCompactionDecisionMetricsForSmoke(settings, usage, modelInfo) {
  const threshold = computeEffectiveThresholdForSmoke(settings, usage, modelInfo);
  const rawPercent = usage?.percent ?? null;
  const runtimeWindow = usage?.contextWindow ?? modelInfo.contextWindow;
  const tokens = usage?.tokens;
  const estimatedTokens = typeof tokens === "number" && Number.isFinite(tokens)
    ? tokens
    : rawPercent !== null && runtimeWindow && runtimeWindow > 0
      ? (rawPercent / 100) * runtimeWindow
      : undefined;
  const percent = threshold.effectiveContextBudget && typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens)
    ? (estimatedTokens / threshold.effectiveContextBudget) * 100
    : rawPercent;
  return { ...threshold, percent, rawPercent };
}

check("dynamic threshold: effective percent falls back through raw percent when tokens are absent", () => {
  const r = computeCompactionDecisionMetricsForSmoke(
    dynamicDefaults,
    { contextWindow: 1050000, percent: 33.33333333333333 },
    { provider: "openai", id: "gpt-5.5" },
  );
  if (Math.abs(r.percent - 128.67647058823528) > 0.001) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

function computeEffectiveRearmMarginForSmoke(thresholdPercent, configuredRearmMarginPercent) {
  return Math.min(configuredRearmMarginPercent, Math.max(0, thresholdPercent - 1));
}

check("dynamic threshold: effective rearm margin stays below lowered threshold", () => {
  const margin = computeEffectiveRearmMarginForSmoke(10, 90);
  if (margin !== 9) throw new Error(`got ${margin}`);
});

// ──────────────────────────────────────────────────────────────────
// End-to-end state-machine simulation.
// Reproduces the 2026-05-18 storm scenario and asserts the fix.
// ──────────────────────────────────────────────────────────────────

console.log("\nstate-machine simulation (storm bounded by backoff):");

const ERROR_COOLDOWN_BASE_MS = 60_000;
const ERROR_COOLDOWN_MAX_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

function makeStateMachine(initialPercent) {
  const armed = new Map();
  const failureCount = new Map();
  const cooldownUntil = new Map();
  const stateKey = "sess-test";
  let currentPercent = initialPercent;
  const threshold = 75;
  const rearmMargin = 5;
  const audit = [];

  function setPercent(p) { currentPercent = p; }
  function getState() {
    return {
      armed: armed.get(stateKey),
      failures: failureCount.get(stateKey) ?? 0,
      cooldownRemaining: Math.max(0, (cooldownUntil.get(stateKey) ?? 0) - Date.now()),
    };
  }

  // Mimics the agent_end handler logic from index.ts. Returns the
  // outcome of one tick, plus updates state maps + audit list.
  function tick(now, compactWillFail) {
    const failuresSoFar = failureCount.get(stateKey) ?? 0;
    const cu = cooldownUntil.get(stateKey) ?? 0;

    // Timed re-arm
    if (
      armed.get(stateKey) === false &&
      failuresSoFar > 0 &&
      failuresSoFar < MAX_CONSECUTIVE_FAILURES &&
      now >= cu
    ) {
      armed.set(stateKey, true);
    }

    // Opportunistic clear (P1-1)
    if (
      failureCount.has(stateKey) &&
      currentPercent !== null &&
      currentPercent < threshold - rearmMargin
    ) {
      failureCount.delete(stateKey);
      cooldownUntil.delete(stateKey);
    }

    const wasArmed = armed.get(stateKey) ?? true;
    const d = classifyDecision(currentPercent, threshold, wasArmed, rearmMargin);

    if (d.decision === "rearm") {
      armed.set(stateKey, true);
      failureCount.delete(stateKey);
      cooldownUntil.delete(stateKey);
      audit.push({ t: now, outcome: "rearm" });
      return { outcome: "rearm" };
    }
    if (d.decision === "skip") {
      return { outcome: "skip", reason: d.reason };
    }

    // trigger
    armed.set(stateKey, false);
    if (compactWillFail) {
      const nextFailures = (failureCount.get(stateKey) ?? 0) + 1;
      failureCount.set(stateKey, nextFailures);
      const cooldownMs = Math.min(
        ERROR_COOLDOWN_MAX_MS,
        ERROR_COOLDOWN_BASE_MS * 2 ** (nextFailures - 1),
      );
      cooldownUntil.set(stateKey, now + cooldownMs);
      audit.push({
        t: now,
        outcome: "trigger-failed",
        failures: nextFailures,
        cooldownMs,
      });
      return { outcome: "trigger-failed", failures: nextFailures, cooldownMs };
    } else {
      armed.delete(stateKey);
      failureCount.delete(stateKey);
      cooldownUntil.delete(stateKey);
      audit.push({ t: now, outcome: "trigger-completed" });
      return { outcome: "trigger-completed" };
    }
  }

  return { tick, setPercent, getState, audit, _stateKey: stateKey, _armed: armed, _failureCount: failureCount, _cooldownUntil: cooldownUntil };
}

check("storm reproduction: 7 rapid agent_ends, percent stuck at 130% → bounded to 3 triggers", () => {
  const sm = makeStateMachine(130.93);
  const events = [];
  // 7 rapid agent_ends within 71s (the original incident timing).
  for (const t of [0, 2000, 4000, 6000, 9000, 18000, 33000]) {
    events.push({ t, ...sm.tick(t, true) });
  }
  // Continue at 65s (cooldown #1 of 60s elapsed).
  events.push({ t: 65_000, ...sm.tick(65_000, true) });
  // 200s (cooldown #2 of 120s elapsed at 185s).
  events.push({ t: 200_000, ...sm.tick(200_000, true) });
  // 450s (cooldown #3 of 240s elapsed at 440s).
  events.push({ t: 450_000, ...sm.tick(450_000, true) });
  // 1000s — way past everything.
  events.push({ t: 1_000_000, ...sm.tick(1_000_000, true) });

  const triggers = events.filter(e => e.outcome === "trigger-failed");
  if (triggers.length !== MAX_CONSECUTIVE_FAILURES) {
    throw new Error(
      `expected exactly ${MAX_CONSECUTIVE_FAILURES} triggers; got ${triggers.length}\n` +
      `events: ${JSON.stringify(events, null, 2)}`,
    );
  }
  // Cooldowns must be exponential.
  const cooldowns = triggers.map(t => t.cooldownMs);
  if (cooldowns[0] !== 60_000) throw new Error(`cooldown[0]=${cooldowns[0]}, want 60000`);
  if (cooldowns[1] !== 120_000) throw new Error(`cooldown[1]=${cooldowns[1]}, want 120000`);
  if (cooldowns[2] !== 240_000) throw new Error(`cooldown[2]=${cooldowns[2]}, want 240000`);
});

check("storm contained: ticks within cooldown all skip, never trigger", () => {
  const sm = makeStateMachine(130.93);
  sm.tick(0, true); // first failure, sets cooldown=60s
  // 10 rapid ticks within the first 50s.
  const results = [];
  for (let t = 1000; t <= 50_000; t += 5000) {
    results.push(sm.tick(t, true));
  }
  if (results.some(r => r.outcome !== "skip")) {
    throw new Error(`expected all skips within cooldown; got ${JSON.stringify(results)}`);
  }
});

check("MAX reached: even past long delays, no more triggers", () => {
  const sm = makeStateMachine(130.93);
  sm.tick(0, true);
  sm.tick(65_000, true);
  sm.tick(200_000, true); // 3rd failure → permanent disarm until percent drops
  const r = sm.tick(10_000_000, true); // 10000s later
  if (r.outcome === "trigger-failed") {
    throw new Error(`expected skip after MAX, got trigger-failed`);
  }
});

check("P1-1 fix: opportunistic clear when percent drops below floor", () => {
  // Scenario: trigger fails → cooldown set; user manually runs
  // /compact, percent drops to 50%; agent_end fires AFTER cooldown
  // elapsed (timed re-arm sets armed=true). Old bug: rearm branch
  // requires !armed, so failure state never cleared. Fix:
  // opportunistic-clear block (placed BEFORE classifyDecision) wipes
  // failure state regardless of armed.
  const sm = makeStateMachine(80);
  sm.tick(0, true); // fail; armed=false, failures=1, cooldown=T+60s
  // Time passes, user compacts manually.
  sm.setPercent(50);
  // agent_end at t=65000 — timed re-arm fires (failures<MAX, cooldown elapsed),
  // armed becomes true.
  sm.tick(65_000, true /*irrelevant — won't be reached*/);
  // The post-condition: failure state should be cleared because percent < floor.
  const s = sm.getState();
  if (s.failures !== 0) {
    throw new Error(
      `expected failures=0 after opportunistic clear; got ${s.failures}\n` +
      `audit: ${JSON.stringify(sm.audit)}`,
    );
  }
  if (s.cooldownRemaining !== 0) {
    throw new Error(`expected cooldownRemaining=0; got ${s.cooldownRemaining}`);
  }
});

check("P1-1 regression: if opportunistic clear is missing, failures persist across timed re-arm", () => {
  // This negative test would have caught the original P1-1 bug.
  // We replicate the broken version of tick (without opportunistic clear)
  // and assert it leaves stale failure state.
  const armed = new Map();
  const failureCount = new Map();
  const cooldownUntil = new Map();
  const k = "x";
  let percent = 80;

  // First trigger fails.
  // (skip opportunistic clear deliberately to model the bug)
  const t0 = 0;
  armed.set(k, true);  // freshly armed
  // classifyDecision says trigger, simulate fire:
  armed.set(k, false);
  failureCount.set(k, 1);
  cooldownUntil.set(k, t0 + 60_000);

  // Percent drops.
  percent = 50;

  // Timed re-arm at t=65000.
  const t1 = 65_000;
  if (armed.get(k) === false && failureCount.get(k) > 0 && failureCount.get(k) < 3 && t1 >= cooldownUntil.get(k)) {
    armed.set(k, true);
  }

  // Now armed=true. classifyDecision(50, 75, true, 5) → skip below_threshold.
  // !! WITHOUT opportunistic clear, failures stays at 1 !!
  if (failureCount.get(k) !== 1) {
    throw new Error(
      `regression-control sanity check broken: this test models the buggy version` +
      ` and should leave failures=1; got ${failureCount.get(k)}`,
    );
  }
  // If we now bump percent back up and trigger again, the next failure becomes
  // failures=2 (cooldown 120s) instead of failures=1 (cooldown 60s) — the
  // stale state biased the backoff. This was P1-1 in the OPUS review.
});

check("onComplete wipes ALL session state (incl. armedBySession to prevent leak)", () => {
  const sm = makeStateMachine(80);
  sm.tick(0, true); // 1 failure
  // Successful compact at t=65s.
  sm.tick(65_000, false);
  // The onComplete path inside tick clears everything.
  const s = sm.getState();
  if (s.armed !== undefined) {
    throw new Error(`armed should be deleted (undefined), got ${s.armed}`);
  }
  if (s.failures !== 0 || s.cooldownRemaining !== 0) {
    throw new Error(`backoff state should be cleared; got ${JSON.stringify(s)}`);
  }
});

// ──────────────────────────────────────────────────────────────────
// Wrap-up
// ──────────────────────────────────────────────────────────────────

console.log(`\nTotal: ${totalChecks}  Passed: ${totalChecks - failures.length}  Failed: ${failures.length}`);

if (failures.length) {
  console.log("\nFAILED — see assertion messages above.");
  process.exit(1);
}
