#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  createDispatchReasoningTrace,
  DEFAULT_MAX_TRACE_BYTES,
  DEFAULT_MAX_RAW_REASONING_BYTES,
  DISPATCH_REASONING_TRACE_TERMINAL_RESERVE_BYTES,
} = await jiti.import(path.join(repoRoot, "extensions/dispatch/reasoning-trace.ts"));
const {
  dispatchReasoningTraceFields,
} = await jiti.import(path.join(repoRoot, "extensions/dispatch/index.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-reasoning-"));
let passed = 0;
let failed = 0;
const POSIX_PRIVATE_MODES_SUPPORTED = process.platform !== "win32";

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

function makeWriter(overrides = {}) {
  return createDispatchReasoningTrace({
    projectRoot: overrides.projectRoot ?? tmpRoot,
    anchor: overrides.anchor ?? {
      session_id: "parent-session",
      turn_id: 7,
      subturn: overrides.taskIndex === undefined ? 1 : overrides.taskIndex + 1,
      sub_agent_label: overrides.label ?? "dispatch_parallel[0]",
    },
    dispatchToolCallId: Object.hasOwn(overrides, "dispatchToolCallId")
      ? overrides.dispatchToolCallId
      : "tool-call-real-123",
    taskIndex: overrides.taskIndex ?? 0,
    taskCount: overrides.taskCount ?? 2,
    model: overrides.model ?? "deepseek/deepseek-v4-pro",
    thinking: overrides.thinking ?? "high",
    modelApi: overrides.modelApi ?? "openai-completions",
    ...(overrides.maxTraceBytes !== undefined ? { maxTraceBytes: overrides.maxTraceBytes } : {}),
    ...(overrides.maxRawReasoningBytes !== undefined ? { maxRawReasoningBytes: overrides.maxRawReasoningBytes } : {}),
    ...(overrides.workflowRunId ? { workflowRunId: overrides.workflowRunId } : {}),
    ...(overrides.workflowStageId ? { workflowStageId: overrides.workflowStageId } : {}),
    ...(overrides.io ? { io: overrides.io } : {}),
  });
}

function start(writer, responseId, api = "openai-completions") {
  writer.handleSessionEvent({
    type: "message_start",
    message: {
      role: "assistant",
      api,
      provider: "test-provider",
      model: "test-model",
      responseId,
      content: [],
    },
  });
}

function thinkingStart(writer, responseId, contentIndex = 0) {
  writer.handleSessionEvent({
    type: "message_update",
    message: { role: "assistant", responseId },
    assistantMessageEvent: {
      type: "thinking_start",
      contentIndex,
      partial: { role: "assistant", responseId },
    },
  });
}

function delta(writer, responseId, text, contentIndex = 0, partialMarker = "partial-must-not-persist") {
  const partial = {
    role: "assistant",
    responseId,
    content: [
      { type: "thinking", thinking: partialMarker },
      { type: "text", text: "visible-body-must-not-persist" },
    ],
    thinkingSignature: "opaque-signature-must-not-persist",
    headers: { Authorization: "Bearer trace-secret" },
    apiKey: "sk-trace-secret-value",
  };
  writer.handleSessionEvent({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex,
      delta: text,
      partial,
    },
  });
}

function thinkingEnd(writer, responseId, contentIndex = 0) {
  writer.handleSessionEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_end",
      contentIndex,
      content: "cumulative-thinking-must-not-persist",
      partial: { role: "assistant", responseId },
    },
  });
}

function terminalMessage(responseId, options = {}) {
  return {
    role: "assistant",
    responseId,
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    usage: options.usage ?? {
      input: 10,
      output: 20,
      totalTokens: 30,
      cost: { total: 0.01 },
    },
    content: [{ type: "text", text: "final-visible-body-must-not-persist" }],
    thinkingSignature: "final-opaque-signature-must-not-persist",
  };
}

function messageEnd(writer, responseId, options = {}) {
  writer.handleSessionEvent({
    type: "message_end",
    message: terminalMessage(responseId, options),
  });
}

function agentEnd(writer, willRetry, messages = []) {
  writer.handleSessionEvent({ type: "agent_end", willRetry, messages });
}

function agentSettled(writer) {
  writer.handleSessionEvent({ type: "agent_settled" });
}

async function endSettled(writer, terminal = {}) {
  agentSettled(writer);
  return writer.end({ ...terminal, runSettled: true });
}

function readTrace(tracePath) {
  const raw = fs.readFileSync(tracePath, "utf8");
  const rows = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { raw, rows, bytes: Buffer.byteLength(raw, "utf8") };
}

function replay(rows) {
  return rows
    .filter((row) => row.event_type === "thinking_delta")
    .map((row) => row.delta)
    .join("");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertPosixMode(file, expected) {
  if (POSIX_PRIVATE_MODES_SUPPORTED) assert.equal(fs.statSync(file).mode & 0o777, expected);
}

function assertNoWindowsEpermWarning(warnings, context) {
  if (process.platform !== "win32") return;
  for (const warning of warnings) {
    assert.ok(
      !warning.toLowerCase().includes("eperm"),
      `${context}: real trace or retention write emitted a Windows EPERM warning: ${warning}`,
    );
  }
}

function faultInjectingIo(fault) {
  let appendCalls = 0;
  let syncCalls = 0;
  let closeCalls = 0;
  return {
    mkdir: async (dir) => { await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 }); },
    chmod: async (target, mode) => { await fs.promises.chmod(target, mode); },
    open: async (file) => {
      const handle = await fs.promises.open(file, "ax", 0o600);
      return {
        chmod: (mode) => handle.chmod(mode),
        appendFile: async (data, options) => {
          appendCalls++;
          if (fault === "append" && appendCalls === 2) {
            const error = new Error("injected append failure");
            error.code = "EIO";
            throw error;
          }
          await handle.appendFile(data, options);
        },
        sync: async () => {
          syncCalls++;
          if (fault === "sync" && syncCalls === 2) {
            const error = new Error("injected sync failure");
            error.code = "EIO";
            throw error;
          }
          await handle.sync();
        },
        close: async () => {
          closeCalls++;
          if (fault === "close" && closeCalls === 1) {
            const error = new Error("injected close failure");
            error.code = "EIO";
            throw error;
          }
          await handle.close();
        },
      };
    },
  };
}

async function writeGrowingTrace(count) {
  const writer = makeWriter({ taskIndex: count, label: `growth-${count}` });
  start(writer, `growth-response-${count}`);
  let partial = "";
  for (let i = 0; i < count; i++) {
    partial += "x";
    delta(writer, `growth-response-${count}`, "x", 0, `partial-secret-${partial}`);
  }
  messageEnd(writer, `growth-response-${count}`);
  const summary = await endSettled(writer, { stopReason: "stop" });
  return { summary, ...readTrace(summary.reasoning_trace_path) };
}

console.log("dispatch reasoning trace smoke");

await check("trace cap constants are serialized JSONL bytes with compat alias only", async () => {
  assert.equal(DEFAULT_MAX_TRACE_BYTES, 64 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_RAW_REASONING_BYTES, DEFAULT_MAX_TRACE_BYTES);
  assert.ok(DISPATCH_REASONING_TRACE_TERMINAL_RESERVE_BYTES > 0 && DISPATCH_REASONING_TRACE_TERMINAL_RESERVE_BYTES < 16 * 1024);
  const src = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/reasoning-trace.ts"), "utf8");
  assert.ok(src.includes("max_trace_bytes"), "trace rows must name max_trace_bytes");
  assert.ok(!src.includes("max_raw_reasoning_bytes"), "new persisted fields must not say max_raw_reasoning_bytes");
  assert.ok(src.includes("private readonly queue"), "writer must use an explicit queue");
  assert.ok(src.includes("queueHead"), "writer queue must use a head cursor");
  assert.ok(src.includes("compactQueue"), "writer queue must compact periodically");
  assert.doesNotMatch(src, /queue\.shift\(\)/, "64MiB delta queue must not use O(n) Array.shift()");
  assert.ok(src.includes("drainLoop"), "writer must use a single drain loop");
  assert.ok(!src.includes("appendChain"), "per-delta Promise append chains must not return");
});

await check("growing partial produces exact deltas with linear JSONL size", async () => {
  const small = await writeGrowingTrace(80);
  const large = await writeGrowingTrace(160);
  assert.equal(small.rows.filter((row) => row.event_type === "thinking_delta").length, 80);
  assert.equal(large.rows.filter((row) => row.event_type === "thinking_delta").length, 160);
  assert.equal(replay(small.rows), "x".repeat(80));
  assert.equal(replay(large.rows), "x".repeat(160));
  assert.ok(large.raw.length / small.raw.length < 2.25, `non-linear growth ratio: ${large.raw.length / small.raw.length}`);
  assert.ok(!small.raw.includes("partial-secret"));
  assert.ok(!large.raw.includes("partial-secret"));
});

await check("delta replay, counters, SHA-256, and complete status match exact delivered plaintext", async () => {
  const chunks = ["alpha\n", "深度", "emoji", "omega"];
  const expected = chunks.join("");
  const writer = makeWriter({ taskIndex: 3, taskCount: 4 });
  start(writer, "response-exact");
  chunks.forEach((chunk, index) => delta(writer, "response-exact", chunk, index % 2));
  messageEnd(writer, "response-exact");
  const summary = await endSettled(writer, { stopReason: "stop" });
  const { raw, rows } = readTrace(summary.reasoning_trace_path);
  assert.equal(replay(rows), expected);
  assert.equal(summary.reasoning_chars, expected.length);
  assert.equal(summary.reasoning_chunks, chunks.length);
  assert.equal(summary.reasoning_sha256, sha256(expected));
  assert.equal(summary.reasoning_trace_status, "complete");
  assert.equal(typeof summary.reasoning_trace_bytes, "number");
  const end = rows.at(-1);
  assert.equal(end.event_type, "trace_end");
  assert.equal(end.reasoning_trace_status, "complete");
  assert.equal(end.reasoning_sha256, sha256(expected));
  assert.equal(end.reasoning_chars, expected.length);
  assert.equal(end.reasoning_chunks, chunks.length);
  for (const secret of [
    "visible-body-must-not-persist",
    "final-visible-body-must-not-persist",
    "opaque-signature-must-not-persist",
    "trace-secret",
    "sk-trace-secret-value",
  ]) {
    assert.ok(!raw.includes(secret), `trace leaked forbidden value: ${secret}`);
  }
});

await check("trace rows carry required causal, call, chunk, task, and workflow fields", async () => {
  const writer = makeWriter({
    taskIndex: 1,
    taskCount: 5,
    dispatchToolCallId: "tool-call-required",
    workflowRunId: "workflow-run-1",
    workflowStageId: "stage-a",
  });
  start(writer, "response-required");
  delta(writer, "response-required", "required-delta", 4);
  messageEnd(writer, "response-required");
  const summary = await endSettled(writer, { stopReason: "stop" });
  const { rows } = readTrace(summary.reasoning_trace_path);
  const required = [
    "schema_version", "row_type", "event_type", "timestamp", "trace_id",
    "session_id", "turn_id", "subturn", "sub_agent_label",
    "dispatch_tool_call_id", "dispatch_tool_call_id_available",
    "task_index", "task_count", "workflow_run_id", "workflow_stage_id", "model", "thinking", "turn_seq",
    "agent_call_seq", "response_id", "content_index", "chunk_seq",
    "delta", "delta_chars", "delta_bytes",
  ];
  for (const row of rows) {
    for (const key of required) assert.ok(Object.hasOwn(row, key), `${row.event_type} missing ${key}`);
    assert.equal(row.dispatch_tool_call_id, "tool-call-required");
    assert.equal(row.dispatch_tool_call_id_available, true);
    assert.equal(row.task_index, 1);
    assert.equal(row.task_count, 5);
    assert.equal(row.workflow_run_id, "workflow-run-1");
    assert.equal(row.workflow_stage_id, "stage-a");
  }
  const row = rows.find((candidate) => candidate.event_type === "thinking_delta");
  assert.equal(row.response_id, "response-required");
  assert.equal(row.content_index, 4);
  assert.equal(row.chunk_seq, 1);
  assert.equal(row.delta, "required-delta");
  assert.equal(row.delta_bytes, Buffer.byteLength("required-delta"));
});

await check("real AgentSession message event sequence is replay-safe", async () => {
  const writer = makeWriter({ taskIndex: 8, taskCount: 9 });
  writer.handleSessionEvent({ type: "agent_start" });
  writer.handleSessionEvent({ type: "turn_start" });
  start(writer, "response-lifecycle");
  thinkingStart(writer, "response-lifecycle");
  delta(writer, "response-lifecycle", "lifecycle-delta");
  thinkingEnd(writer, "response-lifecycle");
  const final = terminalMessage("response-lifecycle");
  writer.handleSessionEvent({ type: "message_end", message: final });
  writer.handleSessionEvent({
    type: "turn_end",
    message: final,
    toolResults: [{ role: "toolResult", content: "tool-output-must-not-persist" }],
  });
  writer.handleSessionEvent({
    type: "agent_end",
    messages: [{ role: "user", content: "prompt-must-not-persist" }, final],
  });
  const summary = await writer.end({ stopReason: "stop", usage: final.usage, runSettled: true });
  const { raw, rows } = readTrace(summary.reasoning_trace_path);
  const eventTypes = rows.map((row) => row.event_type);
  for (const expected of [
    "trace_start", "agent_start", "turn_start", "response_start",
    "thinking_start", "thinking_delta", "thinking_end", "response_end", "message_end",
    "turn_end", "agent_end", "trace_end",
  ]) {
    assert.ok(eventTypes.includes(expected), `missing lifecycle event ${expected}: ${eventTypes.join(",")}`);
  }
  assert.equal(replay(rows), "lifecycle-delta");
  assert.equal(rows.find((row) => row.event_type === "response_end")?.usage?.totalTokens, 30);
  assert.equal(rows.at(-1)?.termination_kind, "completed");
  assert.equal(rows.at(-1)?.reasoning_trace_status, "complete");
  for (const forbidden of [
    "cumulative-thinking-must-not-persist",
    "tool-output-must-not-persist",
    "prompt-must-not-persist",
  ]) {
    assert.ok(!raw.includes(forbidden), `lifecycle trace leaked forbidden value: ${forbidden}`);
  }
  const traceSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/reasoning-trace.ts"), "utf8");
  assert.doesNotMatch(traceSrc, /assistantEventType === "start"|assistantEventType === "done"|assistantEventType === "error"/);
});

await check("retry rows link the failed and recovered response sequences", async () => {
  const writer = makeWriter({ taskIndex: 2, taskCount: 3 });
  start(writer, "response-before-retry");
  delta(writer, "response-before-retry", "before");
  messageEnd(writer, "response-before-retry", { stopReason: "error", errorMessage: "HTTP 503" });
  writer.handleSessionEvent({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 10,
    errorMessage: "HTTP 503",
  });
  start(writer, "response-after-retry");
  delta(writer, "response-after-retry", "after");
  messageEnd(writer, "response-after-retry");
  writer.handleSessionEvent({ type: "auto_retry_end", success: true, attempt: 1 });
  const summary = await endSettled(writer, { stopReason: "stop" });
  const { rows } = readTrace(summary.reasoning_trace_path);
  const deltas = rows.filter((row) => row.event_type === "thinking_delta");
  assert.deepEqual(deltas.map((row) => [row.agent_call_seq, row.response_id]), [
    [1, "response-before-retry"],
    [2, "response-after-retry"],
  ]);
  const retryStart = rows.find((row) => row.event_type === "auto_retry_start");
  const retryEnd = rows.find((row) => row.event_type === "auto_retry_end");
  assert.equal(retryStart.retry_origin_agent_call_seq, 1);
  assert.equal(retryStart.retry_origin_response_id, "response-before-retry");
  assert.equal(retryEnd.retry_origin_agent_call_seq, 1);
  assert.equal(retryEnd.retry_terminal_agent_call_seq, 2);
  assert.equal(retryEnd.retry_terminal_response_id, "response-after-retry");
  assert.equal(replay(rows), "beforeafter");
  assert.equal(rows.at(-1).termination_kind, "completed");
  assert.equal(rows.at(-1).error, null);
});

await check("worker completion requires run settlement plus agent_settled or non-retrying agent_end", async () => {
  const toolUse = makeWriter({ taskIndex: 4, taskCount: 7 });
  start(toolUse, "response-tool-use");
  delta(toolUse, "response-tool-use", "kept-before-tool");
  messageEnd(toolUse, "response-tool-use", { stopReason: "tool_use" });
  const toolUseSummary = await toolUse.end({
    stopReason: "aborted",
    error: "timeout while tool was still running",
    forceIncomplete: true,
    runSettled: false,
  });
  const toolUseRows = readTrace(toolUseSummary.reasoning_trace_path).rows;
  assert.equal(replay(toolUseRows), "kept-before-tool");
  assert.equal(toolUseSummary.reasoning_trace_status, "forced_incomplete");
  assert.ok(toolUseRows.some((row) => row.event_type === "message_end"), "intermediate message_end should remain observable");
  assert.equal(toolUseRows.at(-1).termination_kind, "forced_incomplete");

  const retrying = makeWriter({ taskIndex: 5, taskCount: 7 });
  start(retrying, "response-retrying");
  messageEnd(retrying, "response-retrying", { stopReason: "error", errorMessage: "retry me" });
  agentEnd(retrying, true, [terminalMessage("response-retrying", { stopReason: "error", errorMessage: "retry me" })]);
  const retryingSummary = await retrying.end({ stopReason: "error", forceIncomplete: true, runSettled: true });
  const retryingRows = readTrace(retryingSummary.reasoning_trace_path).rows;
  assert.equal(retryingSummary.reasoning_trace_status, "forced_incomplete");
  assert.equal(retryingRows.find((row) => row.event_type === "agent_end")?.will_retry, true);

  const settled = makeWriter({ taskIndex: 6, taskCount: 7 });
  start(settled, "response-settled");
  delta(settled, "response-settled", "terminal-arrived");
  messageEnd(settled, "response-settled", { stopReason: "aborted" });
  agentSettled(settled);
  const settledSummary = await settled.end({
    stopReason: "aborted",
    error: "abort race",
    forceIncomplete: true,
    runSettled: true,
  });
  const settledRows = readTrace(settledSummary.reasoning_trace_path).rows;
  assert.equal(settledSummary.reasoning_trace_status, "complete");
  assert.ok(settledRows.some((row) => row.event_type === "agent_settled"));

  const secondary = makeWriter({ taskIndex: 7, taskCount: 8 });
  agentEnd(secondary, false);
  const secondarySummary = await secondary.end({ stopReason: "stop", runSettled: true });
  assert.equal(secondarySummary.reasoning_trace_status, "complete");
});

await check("terminal error retains prior deltas and response_error metadata", async () => {
  const writer = makeWriter({ taskIndex: 10, taskCount: 11 });
  start(writer, "response-error");
  delta(writer, "response-error", "kept-before-error");
  messageEnd(writer, "response-error", {
    stopReason: "error",
    errorMessage: "HTTP 503 terminal error",
  });
  const summary = await endSettled(writer, { stopReason: "error", error: "HTTP 503 terminal error" });
  const { rows } = readTrace(summary.reasoning_trace_path);
  assert.equal(replay(rows), "kept-before-error");
  assert.ok(rows.some((row) => row.event_type === "response_error"));
  assert.equal(rows.at(-1).termination_kind, "error");
  assert.equal(rows.at(-1).error, "HTTP 503 terminal error");
});

await check("serialized JSONL cap prevents 1000 one-byte deltas from blowing up the file", async () => {
  const maxTraceBytes = 64 * 1024;
  const writer = makeWriter({ maxTraceBytes, taskIndex: 11, taskCount: 12 });
  start(writer, "response-cap");
  for (let i = 0; i < 1000; i++) delta(writer, "response-cap", "x");
  messageEnd(writer, "response-cap");
  const summary = await endSettled(writer, { stopReason: "stop" });
  const trace = readTrace(summary.reasoning_trace_path);
  const statBytes = fs.statSync(summary.reasoning_trace_path).size;
  assert.ok(statBytes <= maxTraceBytes, `trace exceeded cap: ${statBytes} > ${maxTraceBytes}`);
  assert.ok(trace.bytes <= maxTraceBytes, `raw bytes exceeded cap: ${trace.bytes} > ${maxTraceBytes}`);
  assert.ok(trace.rows.filter((row) => row.event_type === "trace_truncated").length <= 1, "optional truncation control row duplicated");
  assert.ok(trace.rows.filter((row) => row.event_type === "thinking_delta").length < 1000);
  assert.equal(summary.reasoning_chars, 1000);
  assert.equal(summary.reasoning_chunks, 1000);
  assert.equal(summary.reasoning_truncated, true);
  assert.equal(summary.reasoning_sha256, sha256("x".repeat(1000)));
  assert.equal(trace.rows.at(-1).reasoning_sha256, sha256("x".repeat(1000)));
});

await check("many response rounds under a small cap still end with trace_end inside the hard cap", async () => {
  const maxTraceBytes = 16 * 1024;
  const writer = makeWriter({ maxTraceBytes, taskIndex: 13, taskCount: 14 });
  let expected = "";
  for (let round = 0; round < 80; round++) {
    const responseId = `small-cap-round-${round}`;
    const chunk = `round-${round};`;
    expected += chunk;
    start(writer, responseId);
    delta(writer, responseId, chunk);
    messageEnd(writer, responseId, { stopReason: round === 79 ? "stop" : "tool_use" });
  }
  const summary = await endSettled(writer, { stopReason: "stop" });
  const trace = readTrace(summary.reasoning_trace_path);
  assert.ok(trace.bytes <= maxTraceBytes, `${trace.bytes} > ${maxTraceBytes}`);
  assert.ok(fs.statSync(summary.reasoning_trace_path).size <= maxTraceBytes, "stat size exceeded cap");
  assert.equal(trace.rows.at(-1)?.event_type, "trace_end");
  assert.equal(trace.rows.at(-1)?.reasoning_trace_status, "complete");
  assert.equal(summary.reasoning_trace_status, "complete");
  assert.equal(summary.reasoning_truncated, true, "omitted control/data rows must mark summary truncated");
  assert.equal(summary.reasoning_sha256, sha256(expected));
});

await check("write failure reports write_failed status while preserving counters and hash", async () => {
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-trace-write-fail-"));
  fs.writeFileSync(path.join(badRoot, ".pi-astack"), "not a directory");
  const writer = makeWriter({ projectRoot: badRoot, taskIndex: 12, taskCount: 13 });
  start(writer, "response-write-fail");
  delta(writer, "response-write-fail", "hash-even-when-write-fails");
  const summary = await endSettled(writer, { stopReason: "stop" });
  assert.equal(summary.reasoning_trace_status, "write_failed");
  assert.ok(summary.reasoning_trace_error_code, "write failure code missing");
  assert.equal(summary.reasoning_chars, "hash-even-when-write-fails".length);
  assert.equal(summary.reasoning_chunks, 1);
  assert.equal(summary.reasoning_sha256, sha256("hash-even-when-write-fails"));
});

await check("append, sync, and close faults return write_failed and correct the on-disk terminal when writable", async () => {
  for (const fault of ["append", "sync", "close"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-trace-${fault}-fail-`));
    const maxTraceBytes = 32 * 1024;
    const writer = makeWriter({
      projectRoot: root,
      maxTraceBytes,
      taskIndex: 20,
      taskCount: 21,
      io: faultInjectingIo(fault),
    });
    start(writer, `response-${fault}`);
    delta(writer, `response-${fault}`, `delta-${fault}`);
    messageEnd(writer, `response-${fault}`);
    const summary = await endSettled(writer, { stopReason: "stop" });
    assert.equal(summary.reasoning_trace_status, "write_failed", `${fault}: ${JSON.stringify(summary)}`);
    assert.ok(summary.reasoning_trace_error_code?.includes(fault === "sync" ? "sync" : fault), `${fault}: missing operation code`);
    const trace = readTrace(summary.reasoning_trace_path);
    assert.ok(trace.bytes <= maxTraceBytes, `${fault}: ${trace.bytes} > ${maxTraceBytes}`);
    assert.equal(trace.rows.at(-1)?.event_type, "trace_end", `${fault}: last row is not trace_end`);
    assert.equal(trace.rows.at(-1)?.reasoning_trace_status, "write_failed", `${fault}: terminal was not corrected`);
    assert.notEqual(trace.rows.at(-1)?.reasoning_trace_status, "complete", `${fault}: stale complete terminal remained last`);
  }
});

await check("concurrent worker queues use separate files without cross-line contamination", async () => {
  const a = makeWriter({ taskIndex: 0, taskCount: 2, dispatchToolCallId: "parallel-tool", label: "A" });
  const b = makeWriter({ taskIndex: 1, taskCount: 2, dispatchToolCallId: "parallel-tool", label: "B" });
  start(a, "response-a");
  start(b, "response-b");
  for (let i = 0; i < 200; i++) {
    delta(a, "response-a", `A${i};`);
    delta(b, "response-b", `B${i};`);
  }
  messageEnd(a, "response-a");
  messageEnd(b, "response-b");
  const [aSummary, bSummary] = await Promise.all([
    endSettled(a, { stopReason: "stop" }),
    endSettled(b, { stopReason: "stop" }),
  ]);
  assert.notEqual(aSummary.reasoning_trace_path, bSummary.reasoning_trace_path);
  const aTrace = readTrace(aSummary.reasoning_trace_path);
  const bTrace = readTrace(bSummary.reasoning_trace_path);
  assert.ok(!replay(aTrace.rows).includes("B"));
  assert.ok(!replay(bTrace.rows).includes("A"));
  assert.ok(aTrace.rows.every((row) => row.task_index === 0 && row.trace_id === a.traceId));
  assert.ok(bTrace.rows.every((row) => row.task_index === 1 && row.trace_id === b.traceId));
});

await check("trace and retention stay complete with POSIX private modes where supported", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  let summary;
  try {
    const writer = makeWriter({ taskIndex: 6, taskCount: 7 });
    start(writer, "response-mode");
    delta(writer, "response-mode", "mode");
    messageEnd(writer, "response-mode");
    summary = await endSettled(writer, { stopReason: "stop" });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(summary.reasoning_trace_status, "complete");
  const { rows } = readTrace(summary.reasoning_trace_path);
  assert.ok(rows.length >= 5);
  assert.equal(rows.at(-1)?.event_type, "trace_end");
  const traceDir = path.dirname(summary.reasoning_trace_path);
  const retentionPath = path.join(traceDir, ".retention.json");
  const retention = JSON.parse(fs.readFileSync(retentionPath, "utf8"));
  assert.deepEqual(retention, {
    schema_version: "reasoning-retention/v1",
    hot_retention_days: 7,
    archive_retention_days: 30,
    pinned_exempt: true,
    automatic_gc: false,
  });
  assertPosixMode(traceDir, 0o700);
  assertPosixMode(summary.reasoning_trace_path, 0o600);
  assertPosixMode(retentionPath, 0o600);
  assertNoWindowsEpermWarning(warnings, "real trace write");
});

await check("retention symlink or invalid existing JSON warns fail-open without chmod outside targets", async () => {
  for (const variant of ["symlink", "invalid-json"]) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-retention-${variant}-`));
    const traceDir = path.join(projectRoot, ".pi-astack", "llm-audit", "dispatch-reasoning");
    fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    const retentionPath = path.join(traceDir, ".retention.json");
    let protectedPath = retentionPath;
    if (variant === "symlink") {
      protectedPath = path.join(projectRoot, "external-retention.json");
      fs.writeFileSync(protectedPath, "external-must-not-change\n", { mode: 0o644 });
      fs.symlinkSync(protectedPath, retentionPath);
    } else {
      fs.writeFileSync(retentionPath, "{\"schema_version\":\"wrong\"}\n", { mode: 0o644 });
    }
    const beforeMode = fs.statSync(protectedPath).mode & 0o777;
    const beforeContent = fs.readFileSync(protectedPath, "utf8");
    const writer = makeWriter({ projectRoot, taskIndex: variant === "symlink" ? 30 : 31, taskCount: 32 });
    start(writer, `response-${variant}`);
    delta(writer, `response-${variant}`, variant);
    messageEnd(writer, `response-${variant}`);
    const summary = await endSettled(writer, { stopReason: "stop" });
    assert.equal(summary.reasoning_trace_status, "complete");
    assert(fs.existsSync(summary.reasoning_trace_path));
    if (POSIX_PRIVATE_MODES_SUPPORTED) assert.equal(fs.statSync(protectedPath).mode & 0o777, beforeMode);
    assert.equal(fs.readFileSync(protectedPath, "utf8"), beforeContent);
  }
});

await check("OpenAI model trace states visible-summary-only scope and never claims complete CoT", async () => {
  const writer = makeWriter({
    model: "openai/gpt-5.6-sol",
    modelApi: "openai-completions",
    taskIndex: 7,
    taskCount: 8,
  });
  start(writer, "response-openai", "openai-completions");
  delta(writer, "response-openai", "visible summary");
  messageEnd(writer, "response-openai");
  const summary = await endSettled(writer, { stopReason: "stop" });
  const { rows } = readTrace(summary.reasoning_trace_path);
  const traceStart = rows[0];
  assert.equal(traceStart.reasoning_capture_scope, "provider_visible_summary_thinking_delta_only");
  assert.equal(traceStart.openai_visible_summary_only, true);
  assert.equal(traceStart.complete_cot_claim, false);
});

await check("DeepSeek and Kimi traces retain normalized plaintext replay scope", async () => {
  for (const model of ["deepseek/deepseek-v4-pro", "moonshotai/kimi-k2.7-code"]) {
    const writer = makeWriter({ model, modelApi: "openai-completions" });
    const summary = await endSettled(writer);
    const { rows } = readTrace(summary.reasoning_trace_path);
    assert.equal(rows[0].reasoning_capture_scope, "normalized_plaintext_thinking_delta");
    assert.equal(rows[0].openai_visible_summary_only, false);
  }
});

await check("missing dispatch toolCallId is explicit and never fabricated", async () => {
  const writer = makeWriter({ dispatchToolCallId: null, taskIndex: 9, taskCount: 10 });
  start(writer, "response-no-tool-id");
  delta(writer, "response-no-tool-id", "no-id-delta");
  messageEnd(writer, "response-no-tool-id");
  const summary = await endSettled(writer, { stopReason: "stop" });
  const { rows } = readTrace(summary.reasoning_trace_path);
  assert.ok(rows.every((row) => row.dispatch_tool_call_id === null));
  assert.ok(rows.every((row) => row.dispatch_tool_call_id_available === false));
  assert.equal(rows[0].dispatch_association, "causal_anchor_only_no_tool_call_id");
});

await check("dispatch terminal audit/details helper emits trace completeness fields", async () => {
  const fields = dispatchReasoningTraceFields({
    output: "",
    durationMs: 1,
    reasoning_trace_path: "/project/.pi-astack/llm-audit/dispatch-reasoning/trace.jsonl",
    reasoning_chars: 123,
    reasoning_chunks: 4,
    reasoning_truncated: false,
    reasoning_sha256: sha256("abc"),
    reasoning_trace_status: "complete",
    reasoning_trace_bytes: 4096,
  });
  assert.deepEqual(fields, {
    reasoning_trace_path: "/project/.pi-astack/llm-audit/dispatch-reasoning/trace.jsonl",
    reasoning_chars: 123,
    reasoning_chunks: 4,
    reasoning_truncated: false,
    reasoning_sha256: sha256("abc"),
    reasoning_trace_status: "complete",
    reasoning_trace_bytes: 4096,
  });
  const source = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf8");
  const workflowSource = fs.readFileSync(path.join(repoRoot, "extensions/workflow/index.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(source, /operation: "dispatch_agent"[\s\S]{0,2200}?\.\.\.dispatchReasoningTraceFields\(result\)/);
  assert.match(source, /operation: "dispatch_parallel\.task"[\s\S]{0,2200}?\.\.\.dispatchReasoningTraceFields\(res\)/);
  assert.match(source, /const ABORT_TRACE_DRAIN_MS = 3_000;/);
  assert.match(source, /timer = setTimeout\(finish, ABORT_TRACE_DRAIN_MS\)/);
  assert.match(source, /trackedRunPromise\.then\(finish, finish\)/);
  assert.match(source, /forceIncomplete: abortRace/);
  assert.match(source, /if \(heartbeatCtx\?\.reasoningTrace\) \{[\s\S]{0,700}?createDispatchReasoningTrace/);
  assert.doesNotMatch(source, /auditSessionEvent/);
  assert.match(workflowSource, /reasoningTrace:\s*\{[\s\S]{0,160}?workflowRunId: req\.workflowRunId,[\s\S]{0,80}?workflowStageId: req\.stageId/);
  assert.match(workflowSource, /\.\.\.dispatchReasoningTraceFields\(result\)/);
  assert.equal(pkg.scripts?.["smoke:dispatch-reasoning-trace"], "node scripts/smoke-dispatch-reasoning-trace.mjs");
});

if (failed > 0) {
  console.error(`dispatch reasoning trace smoke failed: ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`dispatch reasoning trace smoke passed: ${passed}/${passed + failed}`);
