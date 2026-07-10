import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CALIBRATION_UNITS,
  buildResponsesPayload,
  createBudget,
  isContextOverflow,
  ndjsonRecord,
  parseArgs,
  parseResponsesSse,
  postResponse,
  runModelPlan,
  runProbeExecution,
  runResponsesCalibration,
  waitForProbeDelay,
} from "./probe-openai-context-window.mjs";

function sse(event, data) {
  return new Response(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function formalResult(model, targetEstimatedTokens, status, stage, observedInputTokens = targetEstimatedTokens) {
  const result = {
    model,
    targetEstimatedTokens,
    estimatedInputTokens: targetEstimatedTokens,
    estimateErrorBoundTokens: 0,
    status,
    stage,
  };
  if (status === "success") result.observedUsage = { inputTokens: observedInputTokens };
  return result;
}

test("builds the official Codex Responses payload without unsupported fields", () => {
  const payload = buildResponsesPayload("gpt-5.6-sol", "deterministic input");
  assert.deepEqual(payload, {
    model: "gpt-5.6-sol",
    instructions: "Return the single word acknowledged.",
    input: [{ role: "user", content: [{ type: "input_text", text: "deterministic input" }] }],
    store: false,
    stream: true,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "low", summary: "auto" },
  });
  assert.equal(Object.hasOwn(payload, "truncation"), false);
  assert.equal(Object.hasOwn(payload, "max_output_tokens"), false);
});

test("parses response.completed and observed usage", async () => {
  const result = await parseResponsesSse(sse("response.completed", {
    type: "response.completed",
    response: { usage: { input_tokens: 381234, output_tokens: 12 } },
  }));
  assert.deepEqual(result, { status: "success", observedUsage: { inputTokens: 381234, outputTokens: 12 } });
});

test("parses response.failed context overflow", async () => {
  const result = await parseResponsesSse(sse("response.failed", {
    type: "response.failed",
    response: { error: { code: "context_length_exceeded", message: "maximum context length exceeded" } },
  }));
  assert.equal(result.status, "context_overflow");
  assert.equal(result.errorCode, "context_length_exceeded");
});

test("accepts response.done and response.incomplete terminal variants", async () => {
  const done = await parseResponsesSse(sse("response.done", {
    type: "response.done",
    response: { status: "completed", usage: { input_tokens: 42 } },
  }));
  const incomplete = await parseResponsesSse(sse("response.incomplete", {
    type: "response.incomplete",
    response: { incomplete_details: { reason: "max_output_tokens" } },
  }));
  assert.deepEqual(done, { status: "success", observedUsage: { inputTokens: 42 } });
  assert.deepEqual(incomplete, { status: "output_incomplete", errorCode: "max_output_tokens" });
});

test("classifies HTTP 429 and 5xx without treating either as a boundary", async () => {
  const rate = await parseResponsesSse(new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
    status: 429,
    headers: { "content-type": "application/json" },
  }));
  const server = await parseResponsesSse(new Response(JSON.stringify({ error: { code: "upstream_failure" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  }));
  assert.deepEqual(rate, { status: "rate_limit", errorCode: "rate_limited" });
  assert.deepEqual(server, { status: "server_error", errorCode: "upstream_failure" });
});

test("rejects HTML on HTTP 200 as a protocol error", async () => {
  const result = await parseResponsesSse(new Response("<html>gateway</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  assert.deepEqual(result, { status: "protocol_error", errorCode: "unexpected_content_type" });
});

test("classifies an HTTP 200 JSON context overflow error safely", async () => {
  const result = await parseResponsesSse(new Response(JSON.stringify({
    error: { code: "input_too_long", message: "request exceeds the model context window" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  assert.deepEqual(result, { status: "context_overflow", errorCode: "input_too_long" });
});

test("recognizes current context-limit wording without mistaking output truncation for input overflow", () => {
  for (const message of [
    "input is too large for the max context length",
    "token limit exceeded for this context window",
    "context length is too long",
  ]) assert.equal(isContextOverflow({ error: { message } }), true);
  assert.equal(isContextOverflow({ error: { message: "max_output_tokens token limit exceeded" } }), false);
});

test("uses AbortController timeout for response requests", async () => {
  const result = await postResponse({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    payload: buildResponsesPayload("gpt-5.6-sol", "deterministic"),
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  assert.deepEqual(result, { status: "transport", errorCode: "timeout" });
});

test("removes the parent abort listener after postResponse completes", async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, "abort");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "abort");
      listeners.delete(listener);
    },
  };
  const result = await postResponse({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    payload: buildResponsesPayload("gpt-5.6-sol", "deterministic"),
    timeoutMs: 50,
    signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, false);
      return sse("response.completed", {
        type: "response.completed",
        response: { usage: { input_tokens: 7 } },
      });
    },
  });
  assert.deepEqual(result, { status: "success", observedUsage: { inputTokens: 7 } });
  assert.equal(listeners.size, 0);
});

test("budget records bounded uncertain outcomes without replacing their status", () => {
  const budget = createBudget({ maxRequests: 4, totalTimeoutMs: 100, maxUncertain: 3, now: () => 0 });
  budget.beforeRequest();
  budget.note("protocol_error");
  budget.beforeRequest();
  budget.note("server_error");
  budget.beforeRequest();
  budget.note("transport");
  assert.deepEqual(budget.snapshot(), { requests: 3, elapsedMs: 0, consecutiveUncertain: 3 });
  budget.note("success");
  assert.equal(budget.snapshot().consecutiveUncertain, 0);
  budget.note("output_incomplete");
  budget.note("context_overflow");
  assert.equal(budget.snapshot().consecutiveUncertain, 0);
});

test("calibrates three Responses usage samples with injected timeout, budget, and delay", async () => {
  const timeoutCalls = [];
  const delayCalls = [];
  const requests = [];
  let beforeRequests = 0;
  const usage = [612, 2148, 4196];
  const budget = {
    beforeRequest() { beforeRequests++; },
    timeoutMs(value) {
      timeoutCalls.push(value);
      return value;
    },
    remainingMs() { return 10_000; },
    note() {},
  };
  const result = await runResponsesCalibration({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    model: "gpt-5.6-sol",
    requestTimeoutMs: 123,
    delayMs: 7,
    budget,
    signal: new AbortController().signal,
    waitForDelay: async (options) => delayCalls.push(options),
    postResponseImpl: async (options) => {
      requests.push(options);
      return { status: "success", observedUsage: { inputTokens: usage[requests.length - 1], outputTokens: 1 } };
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(timeoutCalls, [123, 123, 123]);
  assert.equal(beforeRequests, 3);
  assert.equal(delayCalls.length, 2);
  assert.equal(delayCalls.every((call) => call.delayMs === 7 && call.budget === budget), true);
  assert.equal(requests.length, 3);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.timeoutMs, 123);
    assert.equal(Object.hasOwn(request.payload, "truncation"), false);
    assert.equal(Object.hasOwn(request.payload, "max_output_tokens"), false);
    assert.equal(request.payload.stream, true);
    assert.equal(request.payload.store, false);
    assert.equal(request.payload.input[0].content[0].text.length, " contextprobe".length * CALIBRATION_UNITS[index]);
  }

  const estimate = result.calibrate(1000);
  assert.deepEqual(estimate, {
    units: 1800,
    estimatedInputTokens: 1000,
    estimateErrorBoundTokens: 0.25,
    estimateSource: "responses_usage_calibrated",
  });
});

test("rejects a nonlinear third calibration point", async () => {
  const usage = [612, 2148, 5000];
  let requests = 0;
  const result = await runResponsesCalibration({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    model: "gpt-5.6-sol",
    requestTimeoutMs: 50,
    delayMs: 0,
    signal: new AbortController().signal,
    budget: { beforeRequest() {}, timeoutMs: (value) => value, note() {}, remainingMs: () => 10_000 },
    postResponseImpl: async () => ({ status: "success", observedUsage: { inputTokens: usage[requests++] } }),
  });
  assert.deepEqual(result, { status: "calibration_nonlinear", errorCode: "third_point_residual" });
  assert.equal(requests, 3);
});

test("rejects a completed calibration response without input usage", async () => {
  const records = [];
  let requests = 0;
  const result = await runResponsesCalibration({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    model: "gpt-5.6-sol",
    requestTimeoutMs: 50,
    delayMs: 0,
    emit: (record) => records.push(record),
    signal: new AbortController().signal,
    budget: { beforeRequest() {}, timeoutMs: (value) => value, note() {}, remainingMs: () => 10_000 },
    postResponseImpl: async () => {
      requests++;
      return requests === 1
        ? { status: "success", observedUsage: { inputTokens: 612 } }
        : { status: "success", observedUsage: { outputTokens: 1 } };
    },
  });
  assert.deepEqual(result, { status: "calibration_invalid", errorCode: "missing_input_usage" });
  assert.equal(requests, 2);
  assert.equal(records[1].stage, "calibration");
  assert.equal(records[1].status, "success");
  assert.deepEqual(records[1].observedUsage, { outputTokens: 1 });
});

test("stops calibration immediately on rate limits and transport timeouts", async () => {
  for (const response of [
    { status: "rate_limit", errorCode: "rate_limited" },
    { status: "transport", errorCode: "timeout" },
  ]) {
    let requests = 0;
    const result = await runResponsesCalibration({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret-not-to-log",
      model: "gpt-5.6-sol",
      requestTimeoutMs: 50,
      delayMs: 0,
      signal: new AbortController().signal,
      budget: { beforeRequest() {}, timeoutMs: (value) => value, note() {}, remainingMs: () => 10_000 },
      postResponseImpl: async () => {
        requests++;
        return response;
      },
    });
    assert.deepEqual(result, response);
    assert.equal(requests, 1);
  }
});

test("retries uncertain calibration responses at the same units before continuing", async () => {
  const records = [];
  const delayCalls = [];
  const notedStatuses = [];
  let requests = 0;
  let beforeRequests = 0;
  const budget = {
    beforeRequest() { beforeRequests++; },
    timeoutMs: (value) => value,
    note(status) { notedStatuses.push(status); },
    remainingMs: () => 10_000,
  };
  const result = await runResponsesCalibration({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    model: "gpt-5.6-sol",
    requestTimeoutMs: 50,
    delayMs: 7,
    maxUncertainAttempts: 3,
    budget,
    emit: (record) => records.push(record),
    signal: new AbortController().signal,
    waitForDelay: async (options) => delayCalls.push(options),
    postResponseImpl: async () => {
      requests++;
      if (requests === 1) return { status: "server_error", errorCode: "upstream_failure" };
      return { status: "success", observedUsage: { inputTokens: [612, 2148, 4196][requests - 2] } };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(requests, 4);
  assert.equal(beforeRequests, 4);
  assert.equal(delayCalls.length, 3);
  assert.deepEqual(notedStatuses, ["server_error", "success", "success", "success"]);
  assert.deepEqual(records.map((record) => record.units), [CALIBRATION_UNITS[0], CALIBRATION_UNITS[0], CALIBRATION_UNITS[1], CALIBRATION_UNITS[2]]);
  assert.deepEqual(records.map((record) => record.attemptIndex), [1, 2, 1, 1]);
  assert.equal(records.every((record) => record.attemptLimit === 3), true);
});

test("stops calibration after its bounded uncertain attempts", async () => {
  const records = [];
  const delayCalls = [];
  let requests = 0;
  let beforeRequests = 0;
  const budget = {
    beforeRequest() { beforeRequests++; },
    timeoutMs: (value) => value,
    note() {},
    remainingMs: () => 10_000,
  };
  const result = await runResponsesCalibration({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret-not-to-log",
    model: "gpt-5.6-sol",
    requestTimeoutMs: 50,
    delayMs: 7,
    maxUncertainAttempts: 3,
    budget,
    emit: (record) => records.push(record),
    signal: new AbortController().signal,
    waitForDelay: async (options) => delayCalls.push(options),
    postResponseImpl: async () => {
      requests++;
      return { status: "server_error", errorCode: "upstream_failure" };
    },
  });

  assert.deepEqual(result, { status: "server_error", errorCode: "upstream_failure" });
  assert.equal(requests, 3);
  assert.equal(beforeRequests, 3);
  assert.equal(delayCalls.length, 2);
  assert.deepEqual(records.map((record) => record.units), [CALIBRATION_UNITS[0], CALIBRATION_UNITS[0], CALIBRATION_UNITS[0]]);
  assert.deepEqual(records.map((record) => record.attemptIndex), [1, 2, 3]);
});

test("execution retries formal uncertain responses through delay and budget before forming a boundary", async () => {
  const records = [];
  const delayCalls = [];
  let requests = 0;
  let beforeRequests = 0;
  let formal360Attempts = 0;
  const budget = {
    beforeRequest() { beforeRequests++; },
    timeoutMs: (value) => value,
    note() {},
    remainingMs: () => 10_000,
  };
  await runProbeExecution({
    config: {
      baseUrl: "https://example.invalid/v1",
      models: ["gpt-5.6-sol"],
      requestTimeoutMs: 50,
      delayMs: 9,
      maxUncertain: 3,
      resolution: 100,
      targets: [360, 380],
    },
    apiKey: "secret-not-to-log",
    budget,
    emit: (record) => records.push(record),
    signal: new AbortController().signal,
    waitForDelay: async (options) => delayCalls.push(options),
    postResponseImpl: async (options) => {
      requests++;
      if (requests <= 3) return { status: "success", observedUsage: { inputTokens: [1024, 4096, 8192][requests - 1] } };
      const units = options.payload.input[0].content[0].text.length / " contextprobe".length;
      if (units === 360) {
        formal360Attempts++;
        if (formal360Attempts === 1) return { status: "protocol_error", errorCode: "invalid_sse_json" };
        if (formal360Attempts === 2) return { status: "server_error", errorCode: "upstream_failure" };
        return { status: "success", observedUsage: { inputTokens: 360 } };
      }
      return { status: "context_overflow", errorCode: "context_length_exceeded" };
    },
  });

  const formalRecords = records.filter((record) => record.stage !== "calibration" && record.stage !== "summary");
  assert.equal(requests, 11);
  assert.equal(beforeRequests, 11);
  assert.equal(delayCalls.length, 10);
  assert.deepEqual(formalRecords.slice(0, 3).map((record) => record.status), ["protocol_error", "server_error", "success"]);
  assert.deepEqual(formalRecords.slice(0, 3).map((record) => record.attemptIndex), [1, 2, 3]);
  assert.equal(records.at(-1).stopReason, "boundary_complete");
});

test("stops formal probing after its bounded uncertain attempts", async () => {
  const records = [];
  let requests = 0;
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [360, 380],
    maxUncertainAttempts: 3,
    attempt: async (targetEstimatedTokens, stage) => {
      requests++;
      return formalResult("gpt-5.6-sol", targetEstimatedTokens, "protocol_error", stage);
    },
    emit: (record) => records.push(record),
  });

  assert.equal(requests, 3);
  assert.deepEqual(records.map((record) => record.attemptIndex), [1, 2, 3]);
  assert.equal(records.every((record) => record.targetEstimatedTokens === 360 && record.stage === "expansion"), true);
  assert.equal(outcome.stopReason, "protocol_error");
  assert.equal(outcome.boundaryComplete, false);
});

test("execution delays after calibration before the first formal target and emits failed calibration summaries", async () => {
  const delayCalls = [];
  const records = [];
  const requests = [];
  const usage = [1024, 4096, 8192];
  const budget = {
    beforeRequest() {},
    timeoutMs: (value) => value,
    note() {},
    remainingMs: () => 10_000,
  };
  await runProbeExecution({
    config: {
      baseUrl: "https://example.invalid/v1",
      models: ["gpt-5.6-sol"],
      requestTimeoutMs: 50,
      delayMs: 9,
      resolution: 1,
      targets: [360, 380],
    },
    apiKey: "secret-not-to-log",
    budget,
    emit: (record) => records.push(record),
    signal: new AbortController().signal,
    waitForDelay: async (options) => delayCalls.push(options),
    postResponseImpl: async (options) => {
      requests.push(options);
      if (requests.length <= 3) return { status: "success", observedUsage: { inputTokens: usage[requests.length - 1] } };
      const units = options.payload.input[0].content[0].text.length / " contextprobe".length;
      if (units === 360) return { status: "success", observedUsage: { inputTokens: 360 } };
      return { status: "context_overflow", errorCode: "context_length_exceeded" };
    },
  });
  assert.equal(requests.length, 13);
  assert.equal(delayCalls.length, 12);
  assert.equal(delayCalls.every((call) => call.delayMs === 9 && call.budget === budget), true);
  assert.equal(records.filter((record) => record.stage === "calibration").length, 3);
  const expansion = records.find((record) => record.stage === "expansion");
  assert.equal(expansion.estimateSource, "responses_usage_calibrated");
  assert.equal(expansion.status, "success");
  assert.equal(expansion.inputUsageDeltaTokens, 0);
  assert.equal(records.at(-1).stopReason, "boundary_complete");

  const failedRecords = [];
  await runProbeExecution({
    config: { baseUrl: "https://example.invalid/v1", models: ["gpt-5.6-sol"], requestTimeoutMs: 50, delayMs: 0, resolution: 1, targets: [360] },
    apiKey: "secret-not-to-log",
    budget,
    emit: (record) => failedRecords.push(record),
    signal: new AbortController().signal,
    postResponseImpl: async () => ({ status: "success", observedUsage: undefined }),
  });
  assert.equal(failedRecords.length, 2);
  assert.equal(failedRecords.at(-1).stopReason, "calibration_invalid");
});

test("stops larger expansion points after the first context overflow", async () => {
  const calls = [];
  const records = [];
  const attempt = async (targetEstimatedTokens, stage) => {
    calls.push({ targetEstimatedTokens, stage });
    return formalResult("gpt-5.6-sol", targetEstimatedTokens, targetEstimatedTokens >= 380 ? "context_overflow" : "success", stage);
  };
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [360, 380, 512, 768],
    resolution: 10,
    attempt,
    emit: (record) => records.push(record),
  });
  assert.equal(calls.some((call) => call.stage === "expanded_probe"), false);
  assert.equal(calls.some((call) => call.targetEstimatedTokens > 380), false);
  assert.equal(records[0].inputUsageDeltaTokens, 0);
  assert.equal(records[1].status, "context_overflow");
  assert.equal(outcome.boundaryComplete, true);
  assert.equal(outcome.validationConsistent, true);
  assert.equal(outcome.stopReason, "boundary_complete");
});

test("binary search only proceeds across explicit context boundaries", async () => {
  const calls = [];
  const attempt = async (targetEstimatedTokens, stage) => {
    calls.push({ targetEstimatedTokens, stage });
    const status = targetEstimatedTokens === 370 ? "rate_limit" : targetEstimatedTokens >= 380 ? "context_overflow" : "success";
    return formalResult("gpt-5.6-sol", targetEstimatedTokens, status, stage);
  };
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [360, 380, 512],
    resolution: 1,
    attempt,
    emit: () => {},
  });
  assert.equal(outcome.boundaryComplete, false);
  assert.equal(outcome.validationConsistent, false);
  assert.equal(outcome.stopReason, "rate_limit");
  assert.deepEqual(calls.map((call) => call.targetEstimatedTokens), [360, 380, 370]);
  assert.equal(calls.some((call) => call.stage === "boundary_validation"), false);
});

test("formal success requires finite input usage before boundary search", async () => {
  const calls = [];
  const records = [];
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [360, 380],
    resolution: 1,
    attempt: async (targetEstimatedTokens, stage) => {
      calls.push({ targetEstimatedTokens, stage });
      const result = formalResult("gpt-5.6-sol", targetEstimatedTokens, "success", stage);
      delete result.observedUsage;
      return result;
    },
    emit: (record) => records.push(record),
  });
  assert.deepEqual(calls.map((call) => call.targetEstimatedTokens), [360]);
  assert.equal(calls.some((call) => ["boundary_search", "boundary_validation"].includes(call.stage)), false);
  assert.equal(records[0].status, "protocol_error");
  assert.equal(records[0].errorCode, "missing_input_usage");
  assert.equal(records[0].inputUsageDeltaTokens, null);
  assert.equal(outcome.stopReason, "protocol_error");
});

test("formal usage mismatch stops before binary search or boundary validation", async () => {
  const calls = [];
  const records = [];
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [360, 380],
    resolution: 1,
    attempt: async (targetEstimatedTokens, stage) => {
      calls.push({ targetEstimatedTokens, stage });
      return formalResult("gpt-5.6-sol", targetEstimatedTokens, "success", stage, targetEstimatedTokens + 3);
    },
    emit: (record) => records.push(record),
  });
  assert.deepEqual(calls.map((call) => call.targetEstimatedTokens), [360]);
  assert.equal(calls.some((call) => ["boundary_search", "boundary_validation"].includes(call.stage)), false);
  assert.equal(records[0].status, "protocol_error");
  assert.equal(records[0].errorCode, "input_usage_mismatch");
  assert.equal(records[0].inputUsageDeltaTokens, 3);
  assert.equal(outcome.stopReason, "protocol_error");
});

test("returns explicit stop reasons for non-boundary failures", async () => {
  for (const status of ["rate_limit", "transport", "server_error", "protocol_error", "output_incomplete"]) {
    const outcome = await runModelPlan({
      model: "gpt-5.6-sol",
      targets: [360],
      attempt: async (targetEstimatedTokens, stage) => ({ model: "gpt-5.6-sol", targetEstimatedTokens, status, stage }),
      emit: () => {},
    });
    assert.equal(outcome.boundaryComplete, false);
    assert.equal(outcome.validationConsistent, false);
    assert.equal(outcome.stopReason, status);
  }
});

test("reports the fixed 1,060K sentinel as a lower-bound-only hard ceiling", async () => {
  const calls = [];
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [1048000, 1060000],
    attempt: async (targetEstimatedTokens, stage) => {
      calls.push({ targetEstimatedTokens, stage });
      return formalResult("gpt-5.6-sol", targetEstimatedTokens, "success", stage);
    },
    emit: () => {},
  });
  assert.deepEqual(calls.map((call) => call.targetEstimatedTokens), [1048000, 1060000]);
  assert.equal(calls[1].stage, "hard_ceiling_sentinel");
  assert.deepEqual(outcome, {
    lastSuccess: 1060000,
    firstOverflow: undefined,
    lastSuccessTarget: 1060000,
    firstOverflowTarget: undefined,
    boundaryComplete: false,
    validationConsistent: false,
    stopReason: "hard_ceiling_reached",
  });
});

test("marks contradictory boundary validation as incomplete", async () => {
  let lowValidationAttempts = 0;
  const outcome = await runModelPlan({
    model: "gpt-5.6-sol",
    targets: [360, 380],
    resolution: 100,
    attempt: async (targetEstimatedTokens, stage) => {
      if (stage === "boundary_validation" && targetEstimatedTokens === 360) {
        lowValidationAttempts++;
        return formalResult("gpt-5.6-sol", targetEstimatedTokens, lowValidationAttempts === 2 ? "context_overflow" : "success", stage);
      }
      return formalResult("gpt-5.6-sol", targetEstimatedTokens, targetEstimatedTokens >= 380 ? "context_overflow" : "success", stage);
    },
    emit: () => {},
  });
  assert.equal(outcome.boundaryComplete, false);
  assert.equal(outcome.validationConsistent, false);
  assert.equal(outcome.stopReason, "validation_inconsistent");
  assert.equal(lowValidationAttempts, 2);
});

test("waitForProbeDelay removes its abort listener after a normal completion", async () => {
  const listeners = new Set();
  let cleared = 0;
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, "abort");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "abort");
      if (listeners.delete(listener)) cleared++;
    },
  };
  const budget = { remainingMs: () => 10_000 };
  await waitForProbeDelay({
    delayMs: 1,
    budget,
    signal,
    sleep: (resolve) => {
      resolve();
      return 123;
    },
  });
  assert.equal(listeners.size, 0);
  assert.equal(cleared, 1);
});

test("accepts zero delay while retaining the safe default", () => {
  assert.equal(parseArgs([]).delayMs, 2000);
  assert.equal(parseArgs(["--delay-ms", "0"]).delayMs, 0);
});

test("NDJSON serialization never includes request content or secrets", () => {
  const secret = "sk-secret-value";
  const payload = "sensitive payload material";
  const line = ndjsonRecord({
    model: "gpt-5.6-sol",
    targetEstimatedTokens: 380000,
    estimatedInputTokens: 379998,
    estimateSource: "responses_usage_calibrated",
    observedUsage: { inputTokens: 379999, outputTokens: 3 },
    status: "success",
    errorCode: "context_length_exceeded",
    latencyMs: 123,
    stage: "boundary_search",
    lastSuccessTarget: 379000,
    firstOverflowTarget: 380000,
    boundaryComplete: true,
    validationConsistent: true,
    stopReason: "boundary_complete",
    inputUsageDeltaTokens: 1,
    attemptIndex: 2,
    attemptLimit: 3,
    remoteErrorCode: secret,
    secret,
    payload,
    instructions: payload,
  });
  assert.equal(line.includes(secret), false);
  assert.equal(line.includes(payload), false);
  assert.equal(ndjsonRecord({ ...JSON.parse(line), errorCode: secret }).includes(secret), false);
  assert.deepEqual(JSON.parse(line), {
    model: "gpt-5.6-sol",
    targetEstimatedTokens: 380000,
    estimatedInputTokens: 379998,
    estimateSource: "responses_usage_calibrated",
    observedUsage: { inputTokens: 379999, outputTokens: 3 },
    status: "success",
    errorCode: "context_length_exceeded",
    latencyMs: 123,
    stage: "boundary_search",
    lastSuccessTarget: 379000,
    firstOverflowTarget: 380000,
    boundaryComplete: true,
    validationConsistent: true,
    stopReason: "boundary_complete",
    inputUsageDeltaTokens: 1,
    attemptIndex: 2,
    attemptLimit: 3,
  });
});

test("source contains no Messages token-count endpoint or unsupported payload fields", async () => {
  const source = await readFile(new URL("./probe-openai-context-window.mjs", import.meta.url), "utf8");
  assert.equal(source.includes(["/messages", ["count", "tokens"].join("_")].join("/")), false);
  assert.equal(source.includes(["count", "tokens", "bridge"].join("_")), false);
  assert.equal(/^\s*(?:truncation|max_output_tokens)\s*:/m.test(source), false);
});
