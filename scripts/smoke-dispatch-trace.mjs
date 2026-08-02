#!/usr/bin/env node
/**
 * smoke-dispatch-trace — unit coverage for dispatch-trace production protocol.
 *
 * Covers: stable runId, parallel isolation, event normalize, raw payload
 * retention (no redaction), clone isolation, UTF-8 fragments, 8MiB truncate,
 * append failure isolation, liveTail cap, terminal statuses.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const {
  DISPATCH_TRACE_CUSTOM_TYPE,
  DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES,
  DISPATCH_TRACE_MAX_FRAGMENT_BYTES,
  DISPATCH_TRACE_MAX_RUN_BYTES,
  ParentAppendQueue,
  computeDispatchRunId,
  createDispatchTraceSink,
  measureJsonBytes,
  normalizeSessionEvent,
  resolveParentSessionNamespace,
  shrinkJsonValue,
  splitUtf8ByMaxBytes,
  truncateUtf8Tail,
  utf8ByteLength,
  _resetSharedParentAppendQueueForTests,
} = await jiti.import(path.join(repoRoot, "extensions/dispatch/dispatch-trace.ts"));

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}

function makeSink(overrides = {}) {
  const entries = overrides.entries ?? [];
  const appendEntry = overrides.appendEntry ?? ((type, data) => {
    entries.push({ type, data });
  });
  const sink = createDispatchTraceSink({
    runId: overrides.runId ?? "dtr_test",
    parentSessionId: overrides.parentSessionId ?? "sess-1",
    parentToolCallId: overrides.parentToolCallId ?? "tool-1",
    taskIndex: overrides.taskIndex ?? 0,
    appendEntry: overrides.persist === false ? undefined : appendEntry,
    writer: overrides.writer ?? new ParentAppendQueue(),
    maxFragmentBytes: overrides.maxFragmentBytes,
    maxRunBytes: overrides.maxRunBytes,
    terminalReserveBytes: overrides.terminalReserveBytes,
    liveTailMaxBytes: overrides.liveTailMaxBytes,
    onLiveTail: overrides.onLiveTail,
    now: overrides.now,
  });
  return { sink, entries };
}

console.log("smoke-dispatch-trace");

await check("stable runId is deterministic hash of namespace+toolCallId+taskIndex", () => {
  const a = computeDispatchRunId("session-A", "call-1", 0);
  const b = computeDispatchRunId("session-A", "call-1", 0);
  const c = computeDispatchRunId("session-A", "call-1", 1);
  const d = computeDispatchRunId("session-B", "call-1", 0);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^dtr_[0-9a-f]{24}$/);
});

await check("parallel same-name tasks get isolated runIds by taskIndex", () => {
  const ns = "parent-session";
  const tool = "parallel-call";
  const ids = [0, 1, 2].map((i) => computeDispatchRunId(ns, tool, i));
  assert.equal(new Set(ids).size, 3);
});

await check("resolveParentSessionNamespace prefers anchor then sessionManager", () => {
  assert.equal(
    resolveParentSessionNamespace({ anchorSessionId: "from-anchor" }),
    "from-anchor",
  );
  assert.equal(
    resolveParentSessionNamespace({
      sessionManager: { getSessionId: () => "from-sm" },
    }),
    "from-sm",
  );
  assert.equal(resolveParentSessionNamespace({}), "unknown-session");
});

await check("normalizeSessionEvent closed set (assistant/thinking/tool/retry/lifecycle)", () => {
  const at = 1_700_000_000_000;
  assert.deepEqual(
    normalizeSessionEvent({ type: "agent_start" }, at).map((e) => e.kind),
    ["lifecycle"],
  );
  const msgEnd = normalizeSessionEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "hello" },
      ],
    },
  }, at);
  assert.deepEqual(msgEnd.map((e) => e.kind), ["thinking", "assistant_message"]);
  assert.equal(msgEnd[0].payload.text, "plan");
  assert.equal(msgEnd[1].payload.text, "hello");

  const toolCall = normalizeSessionEvent({
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "tc1",
    args: { path: "/tmp/x" },
  }, at);
  assert.equal(toolCall[0].kind, "tool_call");
  assert.equal(toolCall[0].payload.name, "read");
  assert.equal(toolCall[0].payload.id, "tc1");

  const toolResult = normalizeSessionEvent({
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "tc1",
    result: { content: "ok" },
    isError: false,
  }, at);
  assert.equal(toolResult[0].kind, "tool_result");
  assert.equal(toolResult[0].payload.isError, false);

  const retry = normalizeSessionEvent({
    type: "auto_retry_start",
    attempt: 1,
    delayMs: 100,
    errorMessage: "429",
  }, at);
  assert.equal(retry[0].kind, "retry");

  // Exclusions: token deltas and raw streams produce nothing durable.
  assert.deepEqual(
    normalizeSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    }, at),
    [],
  );
});

await check("raw payload retains credentials/image/base64 (no redaction)", async () => {
  const b64 = Buffer.from(Array.from({ length: 600 }, (_, i) => i % 256)).toString("base64");
  const { sink, entries } = makeSink();
  sink.handleSessionEvent({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "t-raw",
    args: {
      authorization: "Bearer super-secret-token",
      nested: {
        api_key: "sk-abcdefghijklmnop",
        note: "use Bearer abcdefghijklmnop-token here",
        image: { type: "image", data: "AAAA" },
        blob: b64,
        prose: "x".repeat(600),
      },
    },
  });
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "complete");
  const event = entries.find((e) => e.data.recordType === "event" && e.data.eventKind === "tool_call");
  assert.ok(event, "expected durable tool_call event");
  const args = event.data.payload.args;
  assert.equal(args.authorization, "Bearer super-secret-token");
  assert.equal(args.nested.api_key, "sk-abcdefghijklmnop");
  assert.equal(args.nested.note, "use Bearer abcdefghijklmnop-token here");
  assert.deepEqual(args.nested.image, { type: "image", data: "AAAA" });
  assert.equal(args.nested.blob, b64);
  assert.equal(args.nested.prose, "x".repeat(600));
  const live = sink.getLiveTail();
  const liveArgs = live.events.find((e) => e.kind === "tool_call")?.payload?.args;
  assert.equal(liveArgs?.authorization, "Bearer super-secret-token");
  assert.equal(liveArgs?.nested?.api_key, "sk-abcdefghijklmnop");
});

await check("UTF-8 split respects codepoint boundaries", () => {
  const text = "你好世界😊".repeat(20);
  const parts = splitUtf8ByMaxBytes(text, 16);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), text);
  for (const part of parts) {
    assert.ok(utf8ByteLength(part) <= 16);
  }
});

await check("large payload is fragmented under 240KiB target (strict, no +64)", async () => {
  const maxFragmentBytes = 4 * 1024;
  const { sink, entries } = makeSink({ maxFragmentBytes });
  const big = "x".repeat(20_000);
  sink.handleSessionEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: big }] },
  });
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "complete");
  const eventEntries = entries.filter((e) => e.data.recordType === "event");
  assert.ok(eventEntries.length >= 2, `expected fragments, got ${eventEntries.length}`);
  for (const e of eventEntries) {
    const bytes = measureJsonBytes(e.data);
    assert.ok(
      bytes <= maxFragmentBytes,
      `fragment ${bytes}B exceeds strict maxFragmentBytes=${maxFragmentBytes}`,
    );
    assert.equal(e.type, DISPATCH_TRACE_CUSTOM_TYPE);
    assert.ok(typeof e.data.fragmentIndex === "number");
    assert.ok(typeof e.data.fragmentCount === "number");
  }
  const terminal = entries.find((e) => e.data.recordType === "terminal");
  assert.ok(terminal);
  assert.equal(terminal.data.status, "complete");
  assert.ok(terminal.data.lastPersistedEventSeq >= 1);
});

await check("escape-dense payload fragments stay ≤ maxFragmentBytes after JSON re-escape", async () => {
  const maxFragmentBytes = 2 * 1024;
  const { sink, entries } = makeSink({ maxFragmentBytes });
  // Dense quotes/backslashes/newlines inflate when payloadFragment is JSON-stringified again.
  const dense = Array.from({ length: 800 }, (_, i) =>
    `line${i}:"quoted\\path\nwith\ttabs" and more \\ "escapes"`,
  ).join("\n");
  sink.handleSessionEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: dense }] },
  });
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "complete");
  const eventEntries = entries.filter((e) => e.data.recordType === "event");
  assert.ok(eventEntries.length >= 2, `expected multi-fragment for escape-dense payload, got ${eventEntries.length}`);
  for (const e of eventEntries) {
    const bytes = measureJsonBytes(e.data);
    assert.ok(
      bytes <= maxFragmentBytes,
      `escape-dense fragment ${bytes}B exceeds strict maxFragmentBytes=${maxFragmentBytes}`,
    );
  }
});

await check("8MiB cap truncates with explicit terminal truncated", async () => {
  const { sink, entries } = makeSink({
    maxRunBytes: 8 * 1024,
    terminalReserveBytes: 1024,
    maxFragmentBytes: 2 * 1024,
  });
  for (let i = 0; i < 40; i++) {
    sink.handleSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `chunk-${i}-` + "y".repeat(800) }],
      },
    });
  }
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "truncated");
  assert.ok(summary.droppedEventCount > 0);
  assert.ok(summary.persistedBytes <= 8 * 1024);
  const terminal = entries.find((e) => e.data.recordType === "terminal");
  assert.equal(terminal.data.status, "truncated");
  assert.ok(terminal.data.droppedEventCount > 0);
});

await check("append failure does not throw and marks persist_failed", async () => {
  let childThrew = false;
  const { sink } = makeSink({
    appendEntry: () => {
      throw new Error("disk full");
    },
  });
  try {
    sink.emitLifecycle("queued");
    sink.handleSessionEvent({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "t1",
      args: { command: "echo hi" },
    });
  } catch {
    childThrew = true;
  }
  assert.equal(childThrew, false);
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "persist_failed");
  assert.equal(summary.persistEnabled, true);
});

await check("persist=false (no appendEntry) exposes persist_failed", async () => {
  const { sink } = makeSink({ persist: false });
  sink.emitLifecycle("queued");
  sink.emitLifecycle("running");
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "persist_failed");
  assert.equal(summary.persistEnabled, false);
  assert.ok(summary.droppedEventCount >= 1);
});

await check("liveTail stays ≤16KiB strictly (no +tolerance) and is not cumulative", async () => {
  let lastTail;
  let maxOnLiveBytes = 0;
  const { sink } = makeSink({
    liveTailMaxBytes: DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES,
    onLiveTail: (tail) => {
      lastTail = tail;
      maxOnLiveBytes = Math.max(maxOnLiveBytes, measureJsonBytes(tail));
    },
  });
  for (let i = 0; i < 200; i++) {
    sink.handleSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `line-${i}-` + "z".repeat(200) }],
      },
    });
  }
  // Streaming current block
  sink.handleSessionEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "partial-" + "p".repeat(500) },
  });
  const tail = sink.getLiveTail();
  assert.equal(tail.live, true);
  assert.ok(tail.revision > 0);
  assert.ok(
    measureJsonBytes(tail) <= DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES,
    `getLiveTail ${measureJsonBytes(tail)}B exceeds cap`,
  );
  assert.ok(
    maxOnLiveBytes <= DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES,
    `onLiveTail max ${maxOnLiveBytes}B exceeds cap`,
  );
  assert.ok(tail.events.length < 200, "liveTail must drop old events");
  assert.ok(tail.currentBlock?.kind === "assistant_message");
  assert.ok(lastTail);
  assert.ok(measureJsonBytes(lastTail) <= DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES);

  const summary = await sink.end({ interrupted: false });
  assert.equal(summary.traceStatus, "complete");
  const after = sink.getLiveTail();
  assert.equal(after.live, false);
  assert.ok(after.events.length > 0, "terminal retains last bounded events");
  assert.ok(measureJsonBytes(after) <= DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES);
});

await check("nested tool result liveTail shrinks recursively under strict budget", async () => {
  const liveTailMaxBytes = 4 * 1024;
  let maxOnLive = 0;
  const { sink } = makeSink({
    liveTailMaxBytes,
    onLiveTail: (tail) => {
      maxOnLive = Math.max(maxOnLive, measureJsonBytes(tail));
    },
  });
  // Deep nested tool result that would blow a shallow top-level-only shrink.
  const nested = {
    content: [
      {
        type: "text",
        text: "outer-" + "N".repeat(3000),
        meta: {
          layers: Array.from({ length: 20 }, (_, i) => ({
            i,
            blob: "B".repeat(800),
            args: { path: "/tmp/x", query: "q".repeat(400), flags: ["a", "b", "c".repeat(200)] },
          })),
        },
      },
    ],
    details: {
      tree: { a: { b: { c: { d: "D".repeat(2000) } } } },
    },
  };
  sink.handleSessionEvent({
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "nested-1",
    result: nested,
    isError: false,
  });
  // Also emit a large tool_call args event so recent window has multiple heavy payloads.
  sink.handleSessionEvent({
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "nested-2",
    args: { path: "/huge", content: "A".repeat(5000), nested: { x: { y: "Z".repeat(3000) } } },
  });
  const tail = sink.getLiveTail();
  const bytes = measureJsonBytes(tail);
  assert.ok(bytes <= liveTailMaxBytes, `nested liveTail ${bytes}B exceeds ${liveTailMaxBytes}`);
  assert.ok(maxOnLive <= liveTailMaxBytes, `nested onLiveTail ${maxOnLive}B exceeds cap`);
  // Must have applied omitted/truncated markers rather than keep full nested blobs.
  const raw = JSON.stringify(tail);
  assert.ok(
    raw.includes("omitted") || raw.includes("[truncated]") || raw.includes("..."),
    "expected omitted/truncated markers after nested shrink",
  );
  await sink.end();
});

await check("currentBlock keeps newest tail under instance liveTailMaxBytes", async () => {
  const liveTailMaxBytes = 2 * 1024;
  const { sink } = makeSink({ liveTailMaxBytes });
  const prefix = "OLD-".repeat(200);
  const suffix = "NEW-TAIL-MARKER-" + "n".repeat(100);
  sink.handleSessionEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_start" },
  });
  sink.handleSessionEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: prefix + suffix },
  });
  const tail = sink.getLiveTail();
  assert.ok(measureJsonBytes(tail) <= liveTailMaxBytes);
  assert.ok(tail.currentBlock?.text.includes("NEW-TAIL-MARKER"), "must keep newest tail");
  assert.ok(!tail.currentBlock?.text.startsWith("OLD-OLD-OLD-"), "must not keep full head");
  await sink.end();
});

await check("clone isolation: mutating source payload does not pollute durable/liveTail", async () => {
  const { sink, entries } = makeSink();
  const args = {
    authorization: "Bearer keep-me",
    nested: { api_key: "sk-original-value", note: "original" },
  };
  sink.handleSessionEvent({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "t-iso",
    args,
  });
  // Mutate the original object after the sink accepted the event.
  args.authorization = "Bearer mutated";
  args.nested.api_key = "sk-mutated";
  args.nested.note = "mutated";

  const liveBeforeEnd = sink.getLiveTail();
  const liveArgs = liveBeforeEnd.events.find((e) => e.kind === "tool_call")?.payload?.args;
  assert.equal(liveArgs?.authorization, "Bearer keep-me");
  assert.equal(liveArgs?.nested?.api_key, "sk-original-value");
  assert.equal(liveArgs?.nested?.note, "original");

  const summary = await sink.end();
  assert.equal(summary.traceStatus, "complete");
  const event = entries.find((e) => e.data.recordType === "event" && e.data.eventKind === "tool_call");
  assert.ok(event);
  assert.equal(event.data.payload.args.authorization, "Bearer keep-me");
  assert.equal(event.data.payload.args.nested.api_key, "sk-original-value");
  assert.equal(event.data.payload.args.nested.note, "original");
});

await check("persistFailed path counts every subsequent discarded event", async () => {
  let calls = 0;
  const { sink } = makeSink({
    appendEntry: () => {
      calls++;
      if (calls === 1) throw new Error("disk full");
    },
  });
  sink.emitLifecycle("queued");
  // Allow first write to fail asynchronously.
  await new Promise((r) => setTimeout(r, 30));
  sink.emitLifecycle("running");
  sink.emitLifecycle("terminal", { note: "after-fail" });
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "persist_failed");
  assert.ok(
    summary.droppedEventCount >= 2,
    `expected ≥2 dropped after persistFailed, got ${summary.droppedEventCount}`,
  );
});

await check("agent_end phase is in lifecycle schema", () => {
  const at = Date.now();
  const events = normalizeSessionEvent({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant" }],
  }, at);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "lifecycle");
  assert.equal(events[0].payload.phase, "agent_end");
  assert.equal(events[0].payload.source, "agent_end");
});

await check("shrinkJsonValue enforces JSON byte budget on nested structures", () => {
  const nested = {
    args: { cmd: "echo " + 'q"'.repeat(2000), files: Array.from({ length: 50 }, (_, i) => `f${i}.txt`) },
    result: { stdout: "X".repeat(8000), nested: { deep: "Y".repeat(4000) } },
  };
  const budget = 1024;
  const shrunk = shrinkJsonValue(nested, budget);
  assert.ok(measureJsonBytes(shrunk) <= budget);
});

await check("truncateUtf8Tail keeps the newest suffix", () => {
  const s = "AAAAAAAA" + "TAIL";
  const t = truncateUtf8Tail(s, 8);
  assert.ok(t.endsWith("TAIL") || t.includes("TAIL"));
  assert.ok(utf8ByteLength(t) <= 8);
});

await check("end() is idempotent — first caller wins (interrupted not overwrite complete)", async () => {
  const { sink, entries } = makeSink();
  sink.emitLifecycle("queued");
  const p1 = sink.end({ interrupted: false });
  const p2 = sink.end({ interrupted: true, reason: "late" });
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.traceStatus, "complete");
  assert.equal(s2.traceStatus, "complete");
  assert.equal(sink.isEnded(), true);
  const terminals = entries.filter((e) => e.data.recordType === "terminal");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.status, "complete");
});

await check("P1-3 source invariant: dispatchTraceEnded claimed before any await", () => {
  const src = fs.readFileSync(
    path.join(repoRoot, "extensions/dispatch/index.ts"),
    "utf8",
  );
  // Extract finalizeReasoningTrace body roughly.
  const m = src.match(
    /const finalizeReasoningTrace = async \([\s\S]*?\}\s*;\s*\n\s*const enrichHeartbeat/,
  );
  assert.ok(m, "finalizeReasoningTrace block not found");
  const body = m[0];
  const claimIdx = body.indexOf("dispatchTraceEnded = true");
  // Match real await expression, not the word "await" inside comments.
  const awaitIdx = body.search(/\n\s*const summary = await /);
  assert.ok(claimIdx >= 0, "must claim dispatchTraceEnded");
  assert.ok(awaitIdx >= 0, "must still await reasoning/trace end");
  assert.ok(
    claimIdx < awaitIdx,
    "dispatchTraceEnded must be set before first await in finalizeReasoningTrace",
  );
  assert.ok(
    body.includes("shouldFinalizeDispatch"),
    "must use shouldFinalizeDispatch claim flag",
  );
  // Catch path claim-before-await invariant.
  const catchClaim = src.indexOf("shouldFinalizeDispatchOnThrow");
  assert.ok(catchClaim >= 0, "catch path must use shouldFinalizeDispatchOnThrow claim");
});

await check("parent append queue serializes concurrent writers", async () => {
  _resetSharedParentAppendQueueForTests();
  const order = [];
  const writer = new ParentAppendQueue();
  let active = 0;
  let maxActive = 0;
  const mk = (label) => writer.enqueue(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`end:${label}`);
    active--;
  });
  await Promise.all([mk("a"), mk("b"), mk("c")]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    "start:a", "end:a",
    "start:b", "end:b",
    "start:c", "end:c",
  ]);
});

await check("interrupted terminal status", async () => {
  const { sink, entries } = makeSink();
  sink.emitLifecycle("queued");
  sink.emitLifecycle("running");
  const summary = await sink.end({ interrupted: true, reason: "parent abort" });
  assert.equal(summary.traceStatus, "interrupted");
  const terminal = entries.find((e) => e.data.recordType === "terminal");
  assert.equal(terminal.data.status, "interrupted");
});

await check("governor + lifecycle events are persisted", async () => {
  const { sink, entries } = makeSink();
  sink.emitLifecycle("queued");
  sink.emitGovernor({ signal: "provider_retry", action: "audit", mode: "observe" });
  sink.handleSessionEvent({ type: "agent_start" });
  const summary = await sink.end();
  assert.equal(summary.traceStatus, "complete");
  const kinds = entries
    .filter((e) => e.data.recordType === "event")
    .map((e) => e.data.eventKind);
  assert.ok(kinds.includes("lifecycle"));
  assert.ok(kinds.includes("governor"));
});

await check("constants match contract", () => {
  assert.equal(DISPATCH_TRACE_CUSTOM_TYPE, "pi-astack/dispatch-trace/v1");
  assert.equal(DISPATCH_TRACE_MAX_FRAGMENT_BYTES, 240 * 1024);
  assert.equal(DISPATCH_TRACE_MAX_RUN_BYTES, 8 * 1024 * 1024);
  assert.equal(DISPATCH_TRACE_LIVE_TAIL_MAX_BYTES, 16 * 1024);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
