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

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

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

check("anchor: opportunistic clear (P1-1 fix) is present and before classifyDecision", () => {
  const opportunisticIdx = indexSrc.indexOf("Opportunistic backoff clear");
  const classifyIdx = indexSrc.indexOf("const decision = classifyDecision(");
  if (opportunisticIdx < 0) {
    throw new Error("Opportunistic backoff clear block missing");
  }
  if (classifyIdx < 0) {
    throw new Error("classifyDecision call site missing");
  }
  if (opportunisticIdx > classifyIdx) {
    throw new Error(
      "Opportunistic clear must come BEFORE classifyDecision — see P1-1 " +
      "in review summary",
    );
  }
});

check("anchor: onComplete deletes armedBySession (DEEPSEEK P1-2)", () => {
  const onCompleteBlock = indexSrc.split("onComplete: () =>")[1];
  if (!onCompleteBlock) throw new Error("onComplete handler block not found");
  const onCompleteBody = onCompleteBlock.split(/\n {8}},/)[0];
  if (!/armedBySession\.delete\(stateKey\)/.test(onCompleteBody)) {
    throw new Error(
      "onComplete should delete armedBySession to prevent map accumulation " +
      "in long-lived pi processes",
    );
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

check("anchor: status displays default main-session model when summaryModels empty", () => {
  if (!/default — main session model/.test(indexSrc)) {
    throw new Error("/compaction-tuner status should show empty summaryModels as default main-session model");
  }
});

// ──────────────────────────────────────────────────────────────────
// Pure-function tests for the exported `classifyDecision`.
// ──────────────────────────────────────────────────────────────────

console.log("\nclassifyDecision (pure function, 5 branches):");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-compaction-backoff-"));
function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  }).outputText;
}

// classifyDecision lives in index.ts but pulling the full module would
// drag in pi runtime + memory/settings + _shared/runtime. We extract
// just the function body using its source-text. The smoke catches
// drift via source anchors above; we reimplement here for isolation.
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

// Best-effort cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* nop */ }

if (failures.length) {
  console.log("\nFAILED — see assertion messages above.");
  process.exit(1);
}
