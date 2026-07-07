#!/usr/bin/env node
/**
 * Deterministic smoke for the global repeated tool-call circuit breaker.
 * No LLM, no secrets, no provider calls.
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(path.join(__dirname, "..", "extensions/_shared/tool-circuit-breaker.ts"));
const extensionMod = await jiti.import(path.join(__dirname, "..", "extensions/tool-circuit-breaker/index.ts"));
const registerToolCircuitBreaker = extensionMod.default ?? extensionMod;

const {
  TOOL_CIRCUIT_BREAKER_DEFAULTS,
  buildToolCircuitBreakerMessage,
  evaluateToolCircuitBreaker,
  newToolCircuitBreakerState,
  normalizeToolArgs,
  resolveToolCircuitBreakerSettings,
  toolCallFingerprint,
} = mod;

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) fails++;
};

const settings = {
  ...TOOL_CIRCUIT_BREAKER_DEFAULTS,
  totalThreshold: 1,
  consecutiveThreshold: 4,
  cycleDetectionEnabled: true,
  maxCycleLength: 10,
  cycleRepeatThreshold: 5,
  abortOnTrip: true,
};

function runSeq(calls, opts = settings) {
  const st = newToolCircuitBreakerState();
  return calls.map(([t, a]) => evaluateToolCircuitBreaker(st, t, a, opts));
}

function repeatPattern(pattern, rounds) {
  const out = [];
  for (let i = 0; i < rounds; i++) out.push(...pattern);
  return out;
}

// Fingerprint stability.
ok(
  normalizeToolArgs({ path: "A", offset: 1, limit: 5 }) === normalizeToolArgs({ limit: 5, path: "A", offset: 1 }),
  "normalizeToolArgs is stable across object key order",
);
ok(
  toolCallFingerprint("grep", { pattern: "x", path: ".", glob: "*.ts" }) ===
    toolCallFingerprint("grep", { glob: "*.ts", path: ".", pattern: "x" }),
  "toolCallFingerprint includes stable normalized args",
);
ok(
  toolCallFingerprint("read", { path: "A" }) !== toolCallFingerprint("read", { path: "B" }),
  "different args produce different fingerprints",
);
ok(
  toolCallFingerprint("read", { path: "A" }) !== toolCallFingerprint("grep", { path: "A" }),
  "tool name is part of the fingerprint",
);

// Consecutive threshold: allow 4 identical calls, block the 5th.
{
  const st = newToolCircuitBreakerState();
  const verdicts = [];
  for (let i = 0; i < 5; i++) verdicts.push(evaluateToolCircuitBreaker(st, "read", { path: "A" }, settings));
  const blocks = verdicts.map((v) => v.block);
  ok(JSON.stringify(blocks) === JSON.stringify([false, false, false, false, true]), "consecutive threshold allows the first 4 identical calls");
  ok(verdicts[4].reason === "consecutive", "5th identical consecutive call trips the breaker");
  ok(verdicts[4].total === 5 && verdicts[4].consecutive === 5, "trip records total and consecutive counts");
}

// Cycle threshold: ABC repeated 4 rounds is fine; 5th round trips at the tail.
{
  const abc = [["read", { path: "A" }], ["grep", { pattern: "B" }], ["edit", { path: "C" }]];
  const verdicts4 = runSeq(repeatPattern(abc, 4));
  ok(verdicts4.every((v) => !v.block), `ABC ×4 rounds stays below cycle threshold got ${JSON.stringify(verdicts4.map((v) => v.block))}`);

  const verdicts5 = runSeq(repeatPattern(abc, 5));
  const trip = verdicts5.at(-1);
  ok(trip?.block && trip.reason === "cycle", "ABC ×5 rounds trips on the 5th round");
  ok(trip?.cycleLength === 3 && trip?.cycleRepeats === 5, "cycle trip records cycleLength=3 and cycleRepeats=5");
}

// Cycle threshold: AB repeated 5 rounds trips.
{
  const verdicts = runSeq(repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 5));
  const trip = verdicts.at(-1);
  ok(trip?.block && trip.reason === "cycle", "AB ×5 rounds trips on the 5th round");
  ok(trip?.cycleLength === 2 && trip?.cycleRepeats === 5, "AB cycle records period 2 with 5 repeats");
}

// Cycle detection can be disabled entirely.
{
  const verdicts = runSeq(repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 5), {
    ...settings,
    cycleDetectionEnabled: false,
  });
  ok(verdicts.every((v) => !v.block), `cycleDetectionEnabled=false keeps AB ×5 below trip got ${JSON.stringify(verdicts.map((v) => v.block))}`);
}

// Cycle detection respects the maxCycleLength boundary.
{
  const abVerdicts = runSeq(repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 5), {
    ...settings,
    maxCycleLength: 2,
  });
  const abTrip = abVerdicts.at(-1);
  ok(abTrip?.block && abTrip.reason === "cycle", "maxCycleLength=2 still catches AB ×5");

  const abcVerdicts = runSeq(repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }], ["edit", { path: "C" }]], 5), {
    ...settings,
    maxCycleLength: 2,
  });
  ok(abcVerdicts.every((v) => !v.block), `maxCycleLength=2 leaves ABC ×5 below trip got ${JSON.stringify(abcVerdicts.map((v) => v.block))}`);
}

// Cycle detection honors the repeat threshold.
{
  const abVerdicts = runSeq(repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 1), {
    ...settings,
    cycleRepeatThreshold: 2,
  });
  ok(abVerdicts.every((v) => !v.block), "cycleRepeatThreshold=2 keeps AB ×1 below trip");

  const abTripVerdicts = runSeq(repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 2), {
    ...settings,
    cycleRepeatThreshold: 2,
  });
  const abTrip = abTripVerdicts.at(-1);
  ok(abTrip?.block && abTrip.reason === "cycle", "cycleRepeatThreshold=2 trips on AB ×2");
}

// Cycle is tail-only: breaking the tail with different args prevents a trip.
{
  const seq = [
    ...repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 4),
    ["read", { path: "A-variant" }],
    ...repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 4),
  ];
  const verdicts = runSeq(seq);
  ok(verdicts.every((v) => !v.block), `interleaved arg change breaks the tail cycle got ${JSON.stringify(verdicts.map((v) => v.block))}`);
}

// Long task: git diff --check can repeat many times cumulatively and still not trip when tail is not a cycle.
{
  const seq = [];
  for (let i = 0; i < 9; i++) {
    seq.push(["bash", { command: "git diff --check", timeout: 120 }]);
    seq.push(["read", { path: `file-${i}.ts` }]);
  }
  const verdicts = runSeq(seq);
  ok(verdicts.every((v) => !v.block), `interleaved git diff --check total accumulation does not trip got ${JSON.stringify(verdicts.filter((v) => v.block))}`);
}

// Different parameters do not accidentally trip.
{
  const st = newToolCircuitBreakerState();
  const verdicts = [];
  for (let i = 0; i < 20; i++) verdicts.push(evaluateToolCircuitBreaker(st, "read", { path: `file-${i}.ts` }, settings));
  ok(verdicts.every((v) => !v.block), "20 distinct argument sets do not trip the breaker");
}

// Interleaved read/edit on the same file is still allowed.
{
  const rA = ["read", { path: "A" }], eA = ["edit", { path: "A" }];
  const verdicts = runSeq([rA, eA, rA, eA, rA]);
  ok(verdicts.every((v) => v.block === false), `交错 read/edit 同文件 → 从不抑制(假阳性护栏) got ${JSON.stringify(verdicts.map((v) => v.block))}`);
}

// Threshold=2 remains a diagnostic guardrail.
{
  const verdicts = runSeq([["read", { path: "A" }], ["read", { path: "A" }], ["read", { path: "A" }]], { ...settings, consecutiveThreshold: 2 });
  ok(JSON.stringify(verdicts.map((v) => v.block)) === JSON.stringify([false, false, true]), "threshold=2 → 第 3 次起抑制");
}

// Once tripped, the current state is failed closed for subsequent tool calls.
{
  const st = newToolCircuitBreakerState();
  for (let i = 0; i < 5; i++) evaluateToolCircuitBreaker(st, "read", { path: "A" }, settings);
  const next = evaluateToolCircuitBreaker(st, "find", { pattern: "*.ts" }, settings);
  ok(next.block && next.reason === "already_tripped", "after a trip, subsequent tool calls are blocked for the current state");

  const nextRun = newToolCircuitBreakerState();
  const fresh = evaluateToolCircuitBreaker(nextRun, "read", { path: "A" }, settings);
  ok(!fresh.block && fresh.total === 1 && fresh.consecutive === 1, "a new agent-run state starts the same call from count 1");
}

// Extension lifecycle: agent_start resets the current agent-run state, including cycle detection.
{
  const priorEnv = {
    enabled: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED,
    total: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD,
    consecutive: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD,
    abort: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP,
    cycleDetectionEnabled: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED,
    maxCycleLength: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH,
    cycleRepeatThreshold: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD,
  };
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED = "1";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD = "8";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = "4";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED = "1";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH = "10";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD = "5";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP = "0";

  const handlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry() {},
  };
  registerToolCircuitBreaker(pi);

  const ctx = {
    sessionManager: { getSessionId: () => "main-session" },
    hasUI: false,
    abort() {
      throw new Error("abort should be disabled in this smoke");
    },
  };
  const call = (toolName, input) => handlers.get("tool_call")({ toolName, input }, ctx);

  const cycleCalls = repeatPattern([["read", { path: "A" }], ["grep", { pattern: "B" }]], 5);
  const firstRun = cycleCalls.map(([toolName, input]) => call(toolName, input));
  ok(firstRun.slice(0, 9).every((v) => v === undefined), "extension keeps AB ×5 open until the final round");
  ok(firstRun[9]?.block && firstRun[9].reason.includes("Trigger: cycle repeats 5 rounds with period 2"), "extension trips on AB ×5 cycle");

  const failedClosed = call("find", { pattern: "*.ts" });
  ok(failedClosed?.block && failedClosed.reason.includes("Trigger: current agent run already tripped"), "extension returns already_tripped while the same state remains tripped");

  handlers.get("agent_start")({}, ctx);
  const secondRun = cycleCalls.map(([toolName, input]) => call(toolName, input));
  ok(secondRun.slice(0, 9).every((v) => v === undefined), "agent_start reset lets AB ×5 run again from a clean state");
  ok(
    secondRun[9]?.block &&
      secondRun[9].reason.includes("Counts: total=5, consecutive=1") &&
      secondRun[9].reason.includes("Cycle: length=2, repeats=5") &&
      secondRun[9].reason.includes("Trigger: cycle repeats 5 rounds with period 2"),
    "after agent_start reset, the same AB cycle trips again from fresh state",
  );

  if (priorEnv.enabled === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED = priorEnv.enabled;
  if (priorEnv.total === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD = priorEnv.total;
  if (priorEnv.consecutive === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = priorEnv.consecutive;
  if (priorEnv.abort === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP = priorEnv.abort;
  if (priorEnv.cycleDetectionEnabled === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED = priorEnv.cycleDetectionEnabled;
  if (priorEnv.maxCycleLength === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH = priorEnv.maxCycleLength;
  if (priorEnv.cycleRepeatThreshold === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD = priorEnv.cycleRepeatThreshold;
}

// Extension anonymous fallback sessions are isolated by sessionManager identity.
{
  const priorEnv = {
    enabled: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED,
    consecutive: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD,
    abort: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP,
    cycleDetectionEnabled: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED,
  };
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED = "1";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = "2";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED = "0";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP = "0";

  const handlers = new Map();
  const entries = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(type, payload) {
      entries.push({ type, payload });
    },
  };
  registerToolCircuitBreaker(pi);

  const makeCtx = (sessionManager) => ({
    sessionManager,
    hasUI: false,
    abort() {
      throw new Error("abort should be disabled in this smoke");
    },
  });
  const call = (ctx, toolName, input) => handlers.get("tool_call")({ toolName, input }, ctx);
  const drop = (ctx, eventName = "agent_end") => handlers.get(eventName)({}, ctx);

  const a = makeCtx({ getSessionId: () => "" });
  const b = makeCtx({ getSessionId: () => "" });
  call(a, "read", { path: "anonymous-A" });
  call(a, "read", { path: "anonymous-A" });
  call(b, "read", { path: "anonymous-B" });
  const aTrip = call(a, "read", { path: "anonymous-A" });
  const bStillOpen = call(b, "read", { path: "anonymous-B" });
  ok(aTrip?.block && aTrip.reason.includes("Trigger: consecutive repeats 3 > 2"), "empty-id anonymous session A trips on its own repeated calls");
  ok(bStillOpen === undefined, "empty-id anonymous session B does not inherit session A's tripped state");

  drop(a);
  const aAfterDrop = call(a, "read", { path: "anonymous-A" });
  const bTrip = call(b, "read", { path: "anonymous-B" });
  ok(aAfterDrop === undefined, "agent_end clears only anonymous session A state");
  ok(bTrip?.block && entries.length === 2, "dropping anonymous session A leaves anonymous session B state intact");
  ok(
    entries[0].payload.sessionId !== entries[1].payload.sessionId &&
      entries.every((entry) => entry.payload.sessionId.startsWith("anonymous:")),
    "empty-id anonymous sessions receive distinct anonymous keys",
  );

  drop(b);
  const bAfterDrop = call(b, "read", { path: "anonymous-B" });
  ok(bAfterDrop === undefined, "agent_end clears the targeted anonymous session B state");

  const throwing = makeCtx({
    getSessionId() {
      throw new Error("session id unavailable");
    },
    getSessionFile: () => "",
  });
  call(throwing, "grep", { pattern: "stable-throw" });
  call(throwing, "grep", { pattern: "stable-throw" });
  const throwingTrip = call(throwing, "grep", { pattern: "stable-throw" });
  ok(throwingTrip?.block && entries.at(-1).payload.sessionId.startsWith("anonymous:"), "throwing getSessionId still uses a stable anonymous key for the same sessionManager object");

  if (priorEnv.enabled === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED = priorEnv.enabled;
  if (priorEnv.consecutive === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = priorEnv.consecutive;
  if (priorEnv.abort === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP = priorEnv.abort;
  if (priorEnv.cycleDetectionEnabled === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED = priorEnv.cycleDetectionEnabled;
}

// Message/audit surface.
{
  const st = newToolCircuitBreakerState();
  let trip;
  for (let i = 0; i < 10; i++) trip = evaluateToolCircuitBreaker(st, i % 2 === 0 ? "read" : "grep", i % 2 === 0 ? { path: "A" } : { pattern: "B" }, settings);
  const msg = buildToolCircuitBreakerMessage(trip, settings);
  ok(trip?.reason === "cycle", "message/audit smoke trips through the cycle guard");
  ok(msg.includes("Trigger: cycle repeats 5 rounds with period 2"), "message includes cycle trigger text");
  ok(msg.includes("Cycle: length=2, repeats=5"), "message includes cycle length and repeat counts");
}

// Settings and env overrides.
{
  const resolved = resolveToolCircuitBreakerSettings(
    {
      toolCircuitBreaker: {
        enabled: true,
        totalThreshold: 12,
        consecutiveThreshold: 6,
        cycleDetectionEnabled: false,
        maxCycleLength: 7,
        cycleRepeatThreshold: 6,
        abortOnTrip: false,
      },
    },
    {},
  );
  ok(
    resolved.totalThreshold === 12 &&
      resolved.consecutiveThreshold === 6 &&
      resolved.cycleDetectionEnabled === false &&
      resolved.maxCycleLength === 7 &&
      resolved.cycleRepeatThreshold === 6,
    "settings preserve deprecated totalThreshold for compatibility and active consecutiveThreshold",
  );
  ok(resolved.abortOnTrip === false, "settings override abortOnTrip");

  const clampedResolved = resolveToolCircuitBreakerSettings(
    {
      toolCircuitBreaker: {
        maxCycleLength: 99,
        cycleRepeatThreshold: 99,
      },
    },
    {},
  );
  ok(clampedResolved.maxCycleLength === 32 && clampedResolved.cycleRepeatThreshold === 20, "settings clamp cycle bounds to the supported maximums");

  const envResolved = resolveToolCircuitBreakerSettings(undefined, {
    PI_ASTACK_DISABLE_TOOL_CIRCUIT_BREAKER: "1",
    PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD: "9",
    PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED: "0",
    PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH: "99",
    PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD: "99",
  });
  ok(
    envResolved.enabled === false &&
      envResolved.totalThreshold === 9 &&
      envResolved.cycleDetectionEnabled === false &&
      envResolved.maxCycleLength === 32 &&
      envResolved.cycleRepeatThreshold === 20,
    "env overrides are clamped after resolution and cannot exceed the supported cycle bounds",
  );

  const legacyOff = resolveToolCircuitBreakerSettings({ dispatch: { idleLoopGuard: { enabled: false } } }, {});
  ok(legacyOff.enabled === false, "legacy dispatch.idleLoopGuard enabled=false disables breaker when no new config is present");
}

console.log(fails === 0 ? "\nALL PASS - tool circuit breaker" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
