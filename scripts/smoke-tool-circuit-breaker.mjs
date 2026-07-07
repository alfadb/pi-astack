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

const settings = { ...TOOL_CIRCUIT_BREAKER_DEFAULTS, totalThreshold: 1, consecutiveThreshold: 4, abortOnTrip: true };

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
  ok(verdicts.slice(0, 4).every((v) => !v.block), "consecutive threshold allows the first 4 identical calls");
  ok(verdicts[4].block && verdicts[4].reason === "consecutive", "5th identical consecutive call trips the breaker");
  ok(verdicts[4].total === 5 && verdicts[4].consecutive === 5, "trip records total and consecutive counts");
}

// Total count can accumulate for diagnostics, but it must not block when repeats are interleaved.
{
  const st = newToolCircuitBreakerState();
  let last;
  for (let i = 0; i < 9; i++) {
    last = evaluateToolCircuitBreaker(st, "grep", { pattern: "A", path: "." }, settings);
    ok(!last.block, `interleaved repeat ${i + 1}/9 stays below block because it is not consecutive`);
    const other = evaluateToolCircuitBreaker(st, "grep", { pattern: `B-${i}`, path: "." }, settings);
    ok(!other.block, `different interleaved arg B-${i} does not misfire`);
  }
  ok(last.total === 9 && last.consecutive === 1, "same fingerprint can accumulate total count without tripping");
}

// Different parameters do not accidentally trip.
{
  const st = newToolCircuitBreakerState();
  const verdicts = [];
  for (let i = 0; i < 20; i++) verdicts.push(evaluateToolCircuitBreaker(st, "read", { path: `file-${i}.ts` }, settings));
  ok(verdicts.every((v) => !v.block), "20 distinct argument sets do not trip the breaker");
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

// Extension lifecycle: agent_start resets only the current agent-run state.
{
  const priorEnv = {
    enabled: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED,
    total: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD,
    consecutive: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD,
    abort: process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP,
  };
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED = "1";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD = "8";
  process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = "4";
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

  let trip;
  for (let i = 0; i < 5; i++) trip = call("read", { path: "A" });
  ok(trip?.block && trip.reason.includes("Trigger: consecutive repeats 5 > 4"), "extension trips within the current agent run");
  ok(!trip?.reason.includes("total repeats"), "extension message no longer reports total-repeat blocking");

  const failedClosed = call("find", { pattern: "*.ts" });
  ok(failedClosed?.block && failedClosed.reason.includes("Trigger: current agent run already tripped"), "extension returns already_tripped while the same state remains tripped");

  handlers.get("agent_start")({}, ctx);
  const afterReset = [];
  for (let i = 0; i < 5; i++) afterReset.push(call("read", { path: "A" }));
  ok(afterReset.slice(0, 4).every((v) => v === undefined), "agent_start reset lets the same call run again from a clean state");
  ok(
    afterReset[4]?.block &&
      afterReset[4].reason.includes("Counts: total=5, consecutive=5") &&
      afterReset[4].reason.includes("Trigger: consecutive repeats 5 > 4") &&
      !afterReset[4].reason.includes("total repeats"),
    "after agent_start reset, the same call trips from fresh counts instead of prior pollution",
  );

  if (priorEnv.enabled === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED = priorEnv.enabled;
  if (priorEnv.total === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD = priorEnv.total;
  if (priorEnv.consecutive === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = priorEnv.consecutive;
  if (priorEnv.abort === undefined) delete process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP;
  else process.env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP = priorEnv.abort;
}

// Message/audit surface.
{
  const st = newToolCircuitBreakerState();
  let trip;
  for (let i = 0; i < 5; i++) trip = evaluateToolCircuitBreaker(st, "read", { path: "A" }, settings);
  const msg = buildToolCircuitBreakerMessage(trip, settings);
  ok(msg.includes("Tool: read"), "message includes tool name");
  ok(/Fingerprint: hash:[0-9a-f]{8} len:\d+/.test(msg), "message includes fingerprint summary");
  ok(msg.includes("total=5") && msg.includes("consecutive=5"), "message includes repeat counts");
}

// Settings and env overrides.
{
  const resolved = resolveToolCircuitBreakerSettings(
    { toolCircuitBreaker: { enabled: true, totalThreshold: 12, consecutiveThreshold: 6, abortOnTrip: false } },
    {},
  );
  ok(resolved.totalThreshold === 12 && resolved.consecutiveThreshold === 6, "settings preserve deprecated totalThreshold for compatibility and active consecutiveThreshold");
  ok(resolved.abortOnTrip === false, "settings override abortOnTrip");

  const envResolved = resolveToolCircuitBreakerSettings(undefined, {
    PI_ASTACK_DISABLE_TOOL_CIRCUIT_BREAKER: "1",
    PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD: "9",
  });
  ok(envResolved.enabled === false && envResolved.totalThreshold === 9, "env disables breaker and can still carry deprecated totalThreshold");

  const legacyOff = resolveToolCircuitBreakerSettings({ dispatch: { idleLoopGuard: { enabled: false } } }, {});
  ok(legacyOff.enabled === false, "legacy dispatch.idleLoopGuard enabled=false disables breaker when no new config is present");
}

console.log(fails === 0 ? "\nALL PASS - tool circuit breaker" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
