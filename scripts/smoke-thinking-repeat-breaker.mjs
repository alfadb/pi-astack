#!/usr/bin/env node
/**
 * Deterministic smoke for the visible-thinking repeat breaker.
 * No LLM, no secrets, no provider calls.
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(path.join(__dirname, "..", "extensions/_shared/thinking-repeat-detector.ts"));
const extensionMod = await jiti.import(path.join(__dirname, "..", "extensions/thinking-repeat-breaker/index.ts"));
const registerThinkingRepeatBreaker = extensionMod.default ?? extensionMod;

const {
  THINKING_REPEAT_BREAKER_DEFAULTS,
  evaluateThinkingDelta,
  newThinkingRepeatBreakerState,
  resolveThinkingRepeatBreakerSettings,
} = mod;

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) fails++;
};

function repeatPattern(pattern, rounds) {
  const out = [];
  for (let i = 0; i < rounds; i++) out.push(...pattern);
  return out;
}

function makeFixedSegment(label, fill = "x", width = 80) {
  const prefix = `${label}|`;
  return prefix.padEnd(width, fill).slice(0, width);
}

function makeUniqueSegment(i) {
  return `${String(i).padStart(3, "0")}|${"x".repeat(80)}`.slice(0, 80);
}

function withEnv(envPatch, fn) {
  const prior = new Map();
  for (const [key, value] of Object.entries(envPatch)) {
    prior.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of prior.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createExtensionHarness() {
  const handlers = new Map();
  const entries = [];
  const notifications = [];

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(type, payload) {
      entries.push({ type, payload });
    },
  };
  registerThinkingRepeatBreaker(pi);

  const emitMessageUpdate = (ctx, assistantMessageEvent) => {
    handlers.get("message_update")?.({ type: "message_update", assistantMessageEvent }, ctx);
  };
  const emitLifecycle = (ctx, eventName) => {
    handlers.get(eventName)?.({ type: eventName }, ctx);
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { handlers, entries, notifications, emitMessageUpdate, emitLifecycle, flush };
}

function makeCtx(sessionManager, notifications, model = { provider: "openai", id: "gpt-5.5" }) {
  let abortCount = 0;
  return {
    ctx: {
      sessionManager,
      hasUI: true,
      ui: {
        notify(message, type) {
          notifications.push({ message, type, sessionManager });
        },
      },
      model,
      abort() {
        abortCount += 1;
      },
    },
    get abortCount() {
      return abortCount;
    },
  };
}

async function main() {
  // Short deltas accumulate until the minimum segment size is reached.
  {
    const st = newThinkingRepeatBreakerState();
    const small = "a".repeat(20);
    const verdicts = [
      evaluateThinkingDelta(st, small),
      evaluateThinkingDelta(st, small),
      evaluateThinkingDelta(st, small),
    ];
    ok(verdicts.every((v) => v.block === false), "short thinking deltas below minSegmentChars do not trigger");
    ok(verdicts.every((v) => v.segmentStats === undefined), "short thinking deltas stay buffered until a segment is emitted");
  }

  // A single large no-newline delta stays bounded in detector state.
  {
    const st = newThinkingRepeatBreakerState();
    const maxBufferChars = 256;
    const verdict = evaluateThinkingDelta(st, "x".repeat(256 * 1024), {
      ...THINKING_REPEAT_BREAKER_DEFAULTS,
      consecutiveThreshold: 10000,
      cycleDetectionEnabled: false,
      maxBufferChars,
    });
    ok(!verdict.block, "single large no-newline thinking_delta returns without tripping when threshold is high");
    ok(st.buffer.length <= maxBufferChars, "single large no-newline thinking_delta leaves state.buffer within maxBufferChars");
  }

  // A large no-newline delta also stays bounded when it trips mid-stream.
  {
    const st = newThinkingRepeatBreakerState();
    const maxBufferChars = 256;
    const verdict = evaluateThinkingDelta(st, "x".repeat(256 * 1024), {
      ...THINKING_REPEAT_BREAKER_DEFAULTS,
      consecutiveThreshold: 2,
      cycleDetectionEnabled: false,
      maxBufferChars,
    });
    ok(verdict.block && verdict.reason === "consecutive", "single large repeating no-newline thinking_delta can trip");
    ok(st.buffer.length <= maxBufferChars, "tripping large no-newline thinking_delta leaves state.buffer within maxBufferChars");
  }

  // Small deltas can assemble into repeated paragraph-delimited segments.
  {
    const st = newThinkingRepeatBreakerState();
    const paragraph = `${makeFixedSegment("paragraph", "p")}\n\n`;
    const stream = paragraph.repeat(3);
    let verdict;
    for (let i = 0; i < stream.length; i += 13) {
      verdict = evaluateThinkingDelta(st, stream.slice(i, i + 13), {
        ...THINKING_REPEAT_BREAKER_DEFAULTS,
        consecutiveThreshold: 2,
        cycleDetectionEnabled: false,
      });
    }
    ok(verdict?.block && verdict.reason === "consecutive", "multiple small deltas assembled into repeated \\n\\n paragraphs can trip");
  }

  // Consecutive identical visible thinking segments trip on the 5th repeat.
  {
    const st = newThinkingRepeatBreakerState();
    const segment = makeFixedSegment("consecutive");
    const verdicts = [];
    for (let i = 0; i < 5; i++) verdicts.push(evaluateThinkingDelta(st, segment, THINKING_REPEAT_BREAKER_DEFAULTS));
    ok(JSON.stringify(verdicts.map((v) => v.block)) === JSON.stringify([false, false, false, false, true]), "consecutive threshold allows the first 4 identical thinking segments");
    ok(verdicts[4].block && verdicts[4].reason === "consecutive", "5th identical thinking segment trips consecutive mode");
    ok(verdicts[4].segmentStats?.normalizedChars === 80 && verdicts[4].segmentStats?.segmentsSeen === 5, "consecutive trip records segment stats");
  }

  // ABC repeated 4 rounds stays open; 5 rounds trips on the tail cycle.
  {
    const abc = [makeFixedSegment("A"), makeFixedSegment("B"), makeFixedSegment("C")];
    const st4 = newThinkingRepeatBreakerState();
    const verdicts4 = repeatPattern(abc, 4).map((segment) => evaluateThinkingDelta(st4, segment));
    ok(verdicts4.every((v) => !v.block), "ABC x4 rounds does not trip");

    const st5 = newThinkingRepeatBreakerState();
    const verdicts5 = repeatPattern(abc, 5).map((segment) => evaluateThinkingDelta(st5, segment));
    const trip = verdicts5.at(-1);
    ok(trip?.block && trip.reason === "cycle", "ABC x5 rounds trips on the tail cycle");
    ok(trip?.cycleLength === 3 && trip?.cycleRepeats === 5, "cycle trip records cycleLength=3 and cycleRepeats=5");
  }

  // Interleaved distinct thinking segments do not trip.
  {
    const st = newThinkingRepeatBreakerState();
    const verdicts = [];
    for (let i = 0; i < 18; i++) {
      verdicts.push(evaluateThinkingDelta(st, makeUniqueSegment(i)));
    }
    ok(verdicts.every((v) => !v.block), "interleaved distinct thinking segments do not trip");
  }

  // Cycle detection can be disabled.
  {
    const st = newThinkingRepeatBreakerState();
    const abc = [makeFixedSegment("A"), makeFixedSegment("B"), makeFixedSegment("C")];
    const verdicts = repeatPattern(abc, 5).map((segment) => evaluateThinkingDelta(st, segment, {
      ...THINKING_REPEAT_BREAKER_DEFAULTS,
      cycleDetectionEnabled: false,
    }));
    ok(verdicts.every((v) => !v.block), "cycleDetectionEnabled=false keeps ABC x5 open");
  }

  // Settings/env clamps keep oversized values inside supported bounds.
  {
    const clamped = resolveThinkingRepeatBreakerSettings(
      {
        thinkingRepeatBreaker: {
          maxCycleLength: 999,
          cycleRepeatThreshold: 999,
          minSegmentChars: 999,
          maxBufferChars: 999999,
        },
      },
      {
        PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_CYCLE_LENGTH: "999",
        PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_REPEAT_THRESHOLD: "999",
        PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS: "999",
        PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_BUFFER_CHARS: "999999",
      },
    );
    ok(
      clamped.maxCycleLength === 32 &&
        clamped.cycleRepeatThreshold === 20 &&
        clamped.minSegmentChars === 512 &&
        clamped.maxBufferChars === 16384,
      "settings/env clamps oversized values to supported bounds",
    );
  }

  // Extension wiring only listens to visible thinking deltas.
  await withEnv(
    {
      PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED: "1",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD: "4",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED: "1",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_CYCLE_LENGTH: "10",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_REPEAT_THRESHOLD: "5",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS: "80",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_BUFFER_CHARS: "8192",
      PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP: "1",
      PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER: undefined,
    },
    async () => {
      const handlers = new Map();
      const entries = [];
      const notifications = [];
      let abortCount = 0;

      const pi = {
        on(name, handler) {
          handlers.set(name, handler);
        },
        appendEntry(type, payload) {
          entries.push({ type, payload });
        },
      };
      registerThinkingRepeatBreaker(pi);
      ok(
        handlers.has("message_update") &&
          handlers.has("session_start") &&
          handlers.has("agent_start") &&
          handlers.has("agent_end") &&
          handlers.has("session_shutdown"),
        "extension registers message_update and lifecycle hooks",
      );

      const ctx = {
        sessionManager: { getSessionId: () => "main-session" },
        hasUI: true,
        ui: {
          notify(message, type) {
            notifications.push({ message, type });
          },
        },
        model: { provider: "openai", id: "gpt-5.5" },
        abort() {
          abortCount += 1;
        },
      };

      const emitMessageUpdate = (assistantMessageEvent) => {
        handlers.get("message_update")?.({ type: "message_update", assistantMessageEvent }, ctx);
      };
      const emitLifecycle = (eventName) => {
        handlers.get(eventName)?.({ type: eventName }, ctx);
      };
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

      for (let i = 0; i < 6; i++) {
        emitMessageUpdate({ type: "text_delta", delta: makeFixedSegment(`text-${i}`) });
      }
      ok(entries.length === 0 && notifications.length === 0 && abortCount === 0, "text_delta does not participate in repeat detection");

      const ab = [makeFixedSegment("A"), makeFixedSegment("B")];
      for (const segment of repeatPattern(ab, 5)) {
        emitMessageUpdate({ type: "thinking_delta", delta: segment });
      }
      emitMessageUpdate({ type: "thinking_delta", delta: makeFixedSegment("post-trip") });
      await flush();
      ok(entries.length === 1, "thinking cycle trip writes one audit entry");
      ok(notifications.length === 1 && abortCount === 1, "post-trip deltas do not duplicate audit, notify, or abort actions");
      ok(entries[0].type === "thinking-repeat-breaker" && entries[0].payload.sessionId === "main-session", "audit entry records the session id");
      ok(entries[0].payload.trigger.includes("cycle repeats 5 rounds with period 2"), "audit entry records the cycle trigger");

      emitLifecycle("agent_start");
      for (const segment of repeatPattern(ab, 5)) {
        emitMessageUpdate({ type: "thinking_delta", delta: segment });
      }
      await flush();
      ok(entries.length === 2 && abortCount === 2, "agent_start reset allows the same cycle to trip again from a clean run state");
    },
  );

  // Extension can be disabled completely.
  await withEnv(
    {
      PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED: "0",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD: "2",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED: "0",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS: "80",
      PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP: "1",
      PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER: undefined,
    },
    async () => {
      const harness = createExtensionHarness();
      const actor = makeCtx({ getSessionId: () => "disabled-session" }, harness.notifications);
      for (let i = 0; i < 4; i++) {
        harness.emitMessageUpdate(actor.ctx, { type: "thinking_delta", delta: makeFixedSegment("disabled") });
      }
      await harness.flush();
      ok(harness.entries.length === 0 && harness.notifications.length === 0 && actor.abortCount === 0, "enabled=false does not audit, notify, or abort");
    },
  );

  // abortOnTrip=false still audits and notifies.
  await withEnv(
    {
      PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED: "1",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD: "2",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED: "0",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS: "80",
      PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP: "0",
      PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER: undefined,
    },
    async () => {
      const harness = createExtensionHarness();
      const actor = makeCtx({ getSessionId: () => "audit-only-session" }, harness.notifications);
      for (let i = 0; i < 3; i++) {
        harness.emitMessageUpdate(actor.ctx, { type: "thinking_delta", delta: makeFixedSegment("audit-only") });
      }
      await harness.flush();
      ok(harness.entries.length === 1 && harness.notifications.length === 1, "abortOnTrip=false still audits and notifies on trip");
      ok(actor.abortCount === 0, "abortOnTrip=false does not abort");
    },
  );

  // Interleaved real session ids keep independent state and lifecycle resets.
  await withEnv(
    {
      PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED: "1",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD: "2",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED: "0",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS: "80",
      PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP: "1",
      PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER: undefined,
    },
    async () => {
      const harness = createExtensionHarness();
      const a = makeCtx({ getSessionId: () => "session-A" }, harness.notifications);
      const b = makeCtx({ getSessionId: () => "session-B" }, harness.notifications);

      for (let i = 0; i < 2; i++) {
        harness.emitMessageUpdate(a.ctx, { type: "thinking_delta", delta: makeFixedSegment("A-only") });
        harness.emitMessageUpdate(b.ctx, { type: "thinking_delta", delta: makeFixedSegment("B-only") });
      }
      harness.emitMessageUpdate(a.ctx, { type: "thinking_delta", delta: makeFixedSegment("A-only") });
      await harness.flush();
      ok(harness.entries.length === 1 && harness.entries[0].payload.sessionId === "session-A", "interleaved sessions audit only the session that trips");
      ok(a.abortCount === 1 && b.abortCount === 0, "interleaved sessions abort only the session that trips");

      harness.emitLifecycle(a.ctx, "agent_start");
      harness.emitMessageUpdate(b.ctx, { type: "thinking_delta", delta: makeFixedSegment("B-only") });
      await harness.flush();
      ok(harness.entries.length === 2 && harness.entries[1].payload.sessionId === "session-B", "resetting one session does not clear another session's buffered state");
      ok(a.abortCount === 1 && b.abortCount === 1, "resetting one session does not move aborts across sessions");

      for (let i = 0; i < 3; i++) {
        harness.emitMessageUpdate(a.ctx, { type: "thinking_delta", delta: makeFixedSegment("A-after-reset") });
      }
      await harness.flush();
      ok(harness.entries.length === 3 && harness.entries[2].payload.sessionId === "session-A", "lifecycle reset clears only the targeted session state");
    },
  );

  // Fallback anonymous sessions use sessionManager object identity.
  await withEnv(
    {
      PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED: "1",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD: "2",
      PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED: "0",
      PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS: "80",
      PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP: "1",
      PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER: undefined,
    },
    async () => {
      const harness = createExtensionHarness();
      const a = makeCtx({}, harness.notifications);
      const b = makeCtx({}, harness.notifications);

      for (let i = 0; i < 2; i++) {
        harness.emitMessageUpdate(a.ctx, { type: "thinking_delta", delta: makeFixedSegment("anon-A") });
        harness.emitMessageUpdate(b.ctx, { type: "thinking_delta", delta: makeFixedSegment("anon-B") });
      }
      harness.emitMessageUpdate(a.ctx, { type: "thinking_delta", delta: makeFixedSegment("anon-A") });
      await harness.flush();
      ok(harness.entries.length === 1 && a.abortCount === 1 && b.abortCount === 0, "anonymous fallback sessions do not share repeat state");

      harness.emitMessageUpdate(b.ctx, { type: "thinking_delta", delta: makeFixedSegment("anon-B") });
      await harness.flush();
      ok(harness.entries.length === 2 && b.abortCount === 1, "anonymous fallback sessions can trip independently");
      ok(
        harness.entries[0].payload.sessionId !== harness.entries[1].payload.sessionId &&
          harness.entries.every((entry) => entry.payload.sessionId.startsWith("anonymous:")),
        "anonymous fallback session ids are distinct per sessionManager object",
      );
    },
  );
}

await main();
console.log(fails === 0 ? "\nALL PASS - thinking repeat breaker" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
