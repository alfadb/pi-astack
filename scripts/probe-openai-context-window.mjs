#!/usr/bin/env node
/**
 * Native OpenAI Responses context-window probe.
 *
 * This script is dry-run by default. Network activity requires --execute and
 * reads a bearer token only from the selected environment variable.
 * ChatGPT Codex OAuth passthrough rejects explicit truncation/max_output_tokens;
 * complete inputs are verified through observed usage alignment.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://sub2api.alfadb.cn/v1";
export const DEFAULT_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra"];
export const DEFAULT_TARGETS = [360000, 380000, 512000, 768000, 1000000, 1048000, 1060000];
export const FIXED_INSTRUCTIONS = "Return the single word acknowledged.";
const PROBE_UNIT = " contextprobe";
export const CALIBRATION_UNITS = [1024, 4096, 8192];
const DEFAULTS = {
  apiKeyEnv: "OPENAI_API_KEY",
  resolution: 1000,
  requestTimeoutMs: 180000,
  totalTimeoutMs: 1800000,
  maxRequests: 128,
  maxUncertain: 3,
  delayMs: 2000,
};

function usageOf(value) {
  const usage = value?.response?.usage ?? value?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  const result = {};
  if (Number.isFinite(inputTokens) && inputTokens >= 0) result.inputTokens = inputTokens;
  if (Number.isFinite(outputTokens) && outputTokens >= 0) result.outputTokens = outputTokens;
  return Object.keys(result).length ? result : undefined;
}

export function safeErrorCode(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,96}$/.test(normalized)) return "unclassified_error";
  if (/secret|api[_-]?key|authorization|bearer|sk-[a-z0-9_-]+/.test(normalized)) return "redacted_error";
  return normalized;
}

function errorDetails(value) {
  const error = value?.error ?? value ?? {};
  return {
    code: safeErrorCode(error.code ?? error.type),
    text: [error.code, error.type, error.message, value?.message]
      .filter((part) => typeof part === "string")
      .join(" ")
      .toLowerCase(),
  };
}

export function isContextOverflow(value) {
  const { text } = errorDetails(value);
  if (/max(?:imum)?[_\s-]*output[_\s-]*tokens?/.test(text)) return false;
  const contextLimit = /context_too_large|context_length_exceeded|maximum[_\s-]*context[_\s-]*length|(?:context[_\s-]*(?:window|length)|max(?:imum)?[_\s-]*context[_\s-]*length|token[_\s-]*limit)/.test(text);
  return contextLimit && /exceed\w*|too[_\s-]*(?:large|long)/.test(text);
}

function failureFromPayload(value, fallback = "protocol_error") {
  const details = errorDetails(value);
  return {
    status: isContextOverflow(value) ? "context_overflow" : fallback,
    errorCode: details.code,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function classifyHttpResponse(response) {
  if (response.status === 429) {
    const body = await safeJson(response);
    return { status: "rate_limit", errorCode: errorDetails(body).code };
  }
  if (response.status >= 500) {
    const body = await safeJson(response);
    return { status: "server_error", errorCode: errorDetails(body).code };
  }
  if (response.status === 401 || response.status === 403) {
    const body = await safeJson(response);
    return { status: "auth", errorCode: errorDetails(body).code };
  }
  const body = await safeJson(response);
  return failureFromPayload(body, "protocol_error");
}

function parseSseBlocks(text) {
  return text.split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const data = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    return { event, data: data.join("\n") };
  }).filter((item) => item.data || item.event !== "message");
}

function terminalFromEvent(event, payload) {
  const type = payload?.type ?? event;
  const response = payload?.response ?? payload;
  if (type === "response.completed" || (type === "response.done" && response?.status === "completed")) {
    return { status: "success", observedUsage: usageOf(response) };
  }
  if (type === "response.failed" || (type === "response.done" && response?.status === "failed")) {
    return failureFromPayload(response, "protocol_error");
  }
  if (type === "response.incomplete" || (type === "response.done" && response?.status === "incomplete")) {
    return { status: "output_incomplete", errorCode: safeErrorCode(response?.incomplete_details?.reason) };
  }
  return undefined;
}

export async function parseResponsesSse(response) {
  if (!response.ok) return classifyHttpResponse(response);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return failureFromPayload(await safeJson(response), "protocol_error");
  }
  if (!contentType.includes("text/event-stream")) {
    return { status: "protocol_error", errorCode: "unexpected_content_type" };
  }

  let body;
  try {
    body = await response.text();
  } catch {
    return { status: "transport", errorCode: "stream_read_failed" };
  }
  for (const { event, data } of parseSseBlocks(body)) {
    if (data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return { status: "protocol_error", errorCode: "invalid_sse_json" };
    }
    const terminal = terminalFromEvent(event, payload);
    if (terminal) return terminal;
  }
  return { status: "protocol_error", errorCode: "missing_terminal_event" };
}

export function buildResponsesPayload(model, userText) {
  return {
    model,
    instructions: FIXED_INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
    store: false,
    stream: true,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "low", summary: "auto" },
  };
}

export function makeProbeText(units) {
  return PROBE_UNIT.repeat(Math.max(0, Math.floor(units)));
}

function endpoint(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

function withTimeout(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let onParentAbort;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (parentSignal?.aborted) controller.abort();
  else if (parentSignal) {
    onParentAbort = () => controller.abort();
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    close: () => {
      clearTimeout(timer);
      if (parentSignal && onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function postResponse({ baseUrl, apiKey, payload, fetchImpl = fetch, timeoutMs, signal }) {
  const timeout = withTimeout(timeoutMs, signal);
  try {
    const response = await fetchImpl(endpoint(baseUrl, "/responses"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });
    return await parseResponsesSse(response);
  } catch {
    return { status: "transport", errorCode: timeout.timedOut() ? "timeout" : "fetch_failed" };
  } finally {
    timeout.close();
  }
}

export function createBudget({ maxRequests, totalTimeoutMs, maxUncertain, now = Date.now }) {
  const startedAt = now();
  let requests = 0;
  let consecutiveUncertain = 0;
  return {
    beforeRequest() {
      if (now() - startedAt >= totalTimeoutMs) throw new Error("total_timeout");
      if (requests >= maxRequests) throw new Error("request_limit");
      requests++;
    },
    timeoutMs(requestTimeoutMs) {
      const remainingMs = totalTimeoutMs - (now() - startedAt);
      if (remainingMs <= 0) throw new Error("total_timeout");
      return Math.min(requestTimeoutMs, remainingMs);
    },
    remainingMs() {
      return totalTimeoutMs - (now() - startedAt);
    },
    note(status) {
      if (["rate_limit", "transport", "server_error", "protocol_error", "output_incomplete"].includes(status)) {
        consecutiveUncertain++;
      } else {
        consecutiveUncertain = 0;
      }
    },
    snapshot() { return { requests, elapsedMs: now() - startedAt, consecutiveUncertain }; },
  };
}

export async function runResponsesCalibration({
  baseUrl,
  apiKey,
  model,
  fetchImpl,
  requestTimeoutMs,
  budget,
  signal,
  delayMs = DEFAULTS.delayMs,
  emit = () => {},
  postResponseImpl = postResponse,
  waitForDelay = waitForProbeDelay,
  sleep,
  beforeRequest,
  maxUncertainAttempts = 1,
}) {
  const samples = [];
  let hasPreviousRequest = false;
  for (let index = 0; index < CALIBRATION_UNITS.length; index++) {
    const units = CALIBRATION_UNITS[index];
    let result;
    for (let attemptIndex = 1; attemptIndex <= maxUncertainAttempts; attemptIndex++) {
      try {
        if (beforeRequest) await beforeRequest();
        else if (hasPreviousRequest) await waitForDelay({ delayMs, budget, signal, sleep });
        hasPreviousRequest = true;
        budget.beforeRequest();
        result = await postResponseImpl({
          baseUrl,
          apiKey,
          payload: buildResponsesPayload(model, makeProbeText(units)),
          fetchImpl,
          timeoutMs: budget.timeoutMs(requestTimeoutMs),
          signal,
        });
        budget.note(result.status);
      } catch (error) {
        result = { status: "stopped", errorCode: safeErrorCode(error?.message) ?? "calibration_failed" };
      }

      emit({
        model,
        targetEstimatedTokens: null,
        estimatedInputTokens: null,
        estimateSource: "responses_usage_calibration",
        observedUsage: result.observedUsage,
        status: result.status,
        errorCode: result.errorCode,
        stage: "calibration",
        units,
        attemptIndex,
        attemptLimit: maxUncertainAttempts,
      });

      if (result.status === "success" || result.status === "context_overflow") break;
      if (!["rate_limit", "transport", "server_error", "protocol_error", "output_incomplete"].includes(result.status)
        || attemptIndex === maxUncertainAttempts) return result;
    }
    if (result.status !== "success") return result;
    const inputTokens = Number(result.observedUsage?.inputTokens);
    if (!Number.isFinite(inputTokens) || inputTokens < 0) {
      return { status: "calibration_invalid", errorCode: "missing_input_usage" };
    }
    samples.push({ units, inputTokens });
  }

  const [first, second, third] = samples;
  const perUnit = (second.inputTokens - first.inputTokens) / (second.units - first.units);
  const base = first.inputTokens - perUnit * first.units;
  if (!Number.isFinite(perUnit) || perUnit <= 0 || !Number.isFinite(base) || base < 0) {
    return { status: "calibration_invalid", errorCode: "invalid_calibration_scale" };
  }

  const thirdResidualTokens = third.inputTokens - (base + perUnit * third.units);
  if (!Number.isFinite(thirdResidualTokens) || Math.abs(thirdResidualTokens) > 2) {
    return { status: "calibration_nonlinear", errorCode: "third_point_residual" };
  }

  const estimateErrorBoundTokens = Math.abs(perUnit) / 2 + Math.abs(thirdResidualTokens);
  if (!Number.isFinite(estimateErrorBoundTokens)) {
    return { status: "calibration_invalid", errorCode: "invalid_estimate_error_bound" };
  }

  return {
    status: "success",
    calibration: { base, perUnit, thirdResidualTokens, estimateErrorBoundTokens },
    calibrate(targetTokens) {
      const units = Math.max(1, Math.round((targetTokens - base) / perUnit));
      const estimatedInputTokens = base + perUnit * units;
      if (!Number.isFinite(units) || !Number.isFinite(estimatedInputTokens)) {
        throw new Error("invalid calibration target");
      }
      return {
        units,
        estimatedInputTokens,
        estimateErrorBoundTokens,
        estimateSource: "responses_usage_calibrated",
      };
    },
  };
}

function safeObservedUsage(value) {
  const inputTokens = Number(value?.inputTokens ?? value?.input_tokens);
  const outputTokens = Number(value?.outputTokens ?? value?.output_tokens);
  const usage = {};
  if (Number.isFinite(inputTokens) && inputTokens >= 0) usage.inputTokens = inputTokens;
  if (Number.isFinite(outputTokens) && outputTokens >= 0) usage.outputTokens = outputTokens;
  return Object.keys(usage).length ? usage : null;
}

export function ndjsonRecord(record) {
  const observedUsage = safeObservedUsage(record.observedUsage);
  const safe = {
    model: String(record.model),
    targetEstimatedTokens: Number.isFinite(record.targetEstimatedTokens) ? record.targetEstimatedTokens : null,
    estimatedInputTokens: Number.isFinite(record.estimatedInputTokens) ? record.estimatedInputTokens : null,
    estimateSource: typeof record.estimateSource === "string" ? record.estimateSource : null,
    observedUsage,
    status: record.status,
    errorCode: safeErrorCode(record.errorCode) ?? null,
    latencyMs: Number.isFinite(record.latencyMs) ? Math.round(record.latencyMs) : null,
    stage: record.stage,
  };
  for (const field of ["units", "estimateErrorBoundTokens", "inputUsageDeltaTokens", "attemptIndex", "attemptLimit"]) {
    if (Object.hasOwn(record, field)) safe[field] = Number.isFinite(record[field]) ? record[field] : null;
  }
  for (const field of ["lastSuccessTarget", "firstOverflowTarget"]) {
    if (Object.hasOwn(record, field)) safe[field] = Number.isFinite(record[field]) ? record[field] : null;
  }
  for (const field of ["boundaryComplete", "validationConsistent"]) {
    if (Object.hasOwn(record, field)) safe[field] = record[field] === true;
  }
  if (Object.hasOwn(record, "stopReason")) safe.stopReason = safeErrorCode(record.stopReason) ?? null;
  return JSON.stringify(safe);
}

function validateFormalSuccess(result) {
  if (result.status !== "success") return result;
  const observedInputTokens = result.observedUsage?.inputTokens;
  if (!Number.isFinite(observedInputTokens) || observedInputTokens < 0) {
    return { ...result, status: "protocol_error", errorCode: "missing_input_usage", inputUsageDeltaTokens: null };
  }

  const estimatedInputTokens = Number(result.estimatedInputTokens);
  const estimateErrorBoundTokens = Number(result.estimateErrorBoundTokens);
  const inputUsageDeltaTokens = observedInputTokens - estimatedInputTokens;
  const allowedDeltaTokens = estimateErrorBoundTokens + 2;
  if (!Number.isFinite(estimatedInputTokens) || !Number.isFinite(estimateErrorBoundTokens)
    || Math.abs(inputUsageDeltaTokens) > allowedDeltaTokens) {
    return { ...result, status: "protocol_error", errorCode: "input_usage_mismatch", inputUsageDeltaTokens };
  }
  return { ...result, inputUsageDeltaTokens };
}

export async function runModelPlan({
  model,
  targets = DEFAULT_TARGETS,
  resolution = DEFAULTS.resolution,
  maxUncertainAttempts = 1,
  attempt,
  emit,
}) {
  const outcome = ({ lastSuccess, firstOverflow, boundaryComplete, validationConsistent, stopReason }) => ({
    lastSuccess,
    firstOverflow,
    lastSuccessTarget: lastSuccess,
    firstOverflowTarget: firstOverflow,
    boundaryComplete,
    validationConsistent,
    stopReason,
  });
  const stopReasonFor = (result) => {
    if (result.status === "stopped") return safeErrorCode(result.errorCode) ?? "attempt_failed";
    if (["context_overflow", "rate_limit", "transport", "server_error", "protocol_error", "output_incomplete", "auth"].includes(result.status)) return result.status;
    return "unexpected_status";
  };
  const doAttempt = async (targetEstimatedTokens, stage) => {
    let result;
    for (let attemptIndex = 1; attemptIndex <= maxUncertainAttempts; attemptIndex++) {
      try {
        result = validateFormalSuccess(await attempt(targetEstimatedTokens, stage));
      } catch (error) {
        result = {
          model,
          targetEstimatedTokens,
          status: "stopped",
          errorCode: safeErrorCode(error?.message) ?? "attempt_failed",
          stage,
        };
      }
      result = { ...result, attemptIndex, attemptLimit: maxUncertainAttempts };
      emit(result);
      if (result.status === "success" || result.status === "context_overflow") return result;
      if (!["rate_limit", "transport", "server_error", "protocol_error", "output_incomplete"].includes(result.status)
        || attemptIndex === maxUncertainAttempts) return result;
    }
    return result;
  };
  let lastSuccess;
  let firstOverflow;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const stage = index === targets.length - 1 && target === 1060000
      ? "hard_ceiling_sentinel"
      : index < 2 ? "expansion" : "expanded_probe";
    const result = await doAttempt(target, stage);
    if (result.status === "success") {
      lastSuccess = target;
      continue;
    }
    if (result.status === "context_overflow") {
      firstOverflow = target;
      break;
    }
    return outcome({ lastSuccess, firstOverflow, boundaryComplete: false, validationConsistent: false, stopReason: stopReasonFor(result) });
  }
  if (firstOverflow === undefined) {
    return outcome({ lastSuccess, firstOverflow, boundaryComplete: false, validationConsistent: false, stopReason: "hard_ceiling_reached" });
  }
  if (lastSuccess === undefined) {
    return outcome({ lastSuccess, firstOverflow, boundaryComplete: false, validationConsistent: false, stopReason: "context_overflow" });
  }

  let low = lastSuccess;
  let high = firstOverflow;
  while (high - low > resolution) {
    const mid = Math.floor((low + high) / 2);
    const result = await doAttempt(mid, "boundary_search");
    if (result.status === "success") low = mid;
    else if (result.status === "context_overflow") high = mid;
    else return outcome({ lastSuccess: low, firstOverflow: high, boundaryComplete: false, validationConsistent: false, stopReason: stopReasonFor(result) });
  }

  let validationConsistent = true;
  for (const [target, expectedStatus] of [[low, "success"], [high, "context_overflow"]]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await doAttempt(target, "boundary_validation");
      if (result.status === expectedStatus) continue;
      if (["rate_limit", "transport", "server_error", "protocol_error", "output_incomplete", "auth", "stopped"].includes(result.status)) {
        return outcome({ lastSuccess: low, firstOverflow: high, boundaryComplete: false, validationConsistent: false, stopReason: stopReasonFor(result) });
      }
      validationConsistent = false;
    }
  }
  return outcome({
    lastSuccess: low,
    firstOverflow: high,
    boundaryComplete: validationConsistent,
    validationConsistent,
    stopReason: validationConsistent ? "boundary_complete" : "validation_inconsistent",
  });
}

function parsePositive(name, value, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`invalid ${name}`);
  return number;
}

function parseNonNegative(name, value) {
  return parsePositive(name, value, 0);
}

export function parseArgs(argv) {
  const config = { ...DEFAULTS, baseUrl: DEFAULT_BASE_URL, models: [...DEFAULT_MODELS], execute: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") config.execute = true;
    else if (arg === "--help" || arg === "-h") config.help = true;
    else if (arg === "--models" || arg === "--model") config.models = parseModels(argv[++i]);
    else if (arg === "--base-url") config.baseUrl = validateBaseUrl(argv[++i]);
    else if (arg === "--api-key-env") config.apiKeyEnv = validateEnvName(argv[++i]);
    else if (arg === "--resolution") config.resolution = parsePositive("resolution", argv[++i]);
    else if (arg === "--request-timeout-ms") config.requestTimeoutMs = parsePositive("request timeout", argv[++i]);
    else if (arg === "--total-timeout-ms") config.totalTimeoutMs = parsePositive("total timeout", argv[++i]);
    else if (arg === "--max-requests") config.maxRequests = parsePositive("max requests", argv[++i]);
    else if (arg === "--max-uncertain") config.maxUncertain = parsePositive("max uncertain", argv[++i]);
    else if (arg === "--delay-ms") config.delayMs = parseNonNegative("delay", argv[++i]);
    else if (arg === "--key" || arg.startsWith("--key=")) throw new Error("API keys must be supplied through an environment variable");
    else throw new Error("unknown argument");
  }
  return config;
}

function validateEnvName(value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value ?? "")) throw new Error("invalid api key environment variable name");
  return value;
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("base URL must be http(s)");
  if (url.username || url.password || url.search || url.hash) throw new Error("base URL must not contain credentials, query, or fragment");
  return url.toString().replace(/\/$/, "");
}

function parseModels(value) {
  const aliases = { sol: "gpt-5.6-sol", terra: "gpt-5.6-terra" };
  const models = String(value ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).map((part) => aliases[part] ?? part);
  if (!models.length || models.some((model) => !DEFAULT_MODELS.includes(model))) throw new Error("models must be sol and/or terra");
  return [...new Set(models)];
}

function help() {
  process.stderr.write(`Usage: node scripts/probe-openai-context-window.mjs [options]\n\n` +
    `Dry-run is the default. Add --execute to make serial HTTP requests.\n` +
    `  --execute\n  --models sol,terra\n  --model sol\n  --base-url URL\n  --api-key-env NAME\n` +
    `  --resolution TOKENS\n  --request-timeout-ms MS\n  --total-timeout-ms MS\n` +
    `  --max-requests N\n  --max-uncertain N\n  --delay-ms MS\n`);
}

export async function waitForProbeDelay({ delayMs, budget, signal, sleep = setTimeout }) {
  if (!delayMs) return;
  if (budget.remainingMs() < delayMs) throw new Error("total_timeout");
  if (signal?.aborted) throw new Error("aborted");
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      timer = sleep(() => {
        cleanup();
        resolve();
      }, delayMs);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function runProbeExecution({
  config,
  apiKey,
  emit,
  fetchImpl = fetch,
  postResponseImpl = postResponse,
  waitForDelay = waitForProbeDelay,
  sleep,
  budget = createBudget(config),
  signal = new AbortController().signal,
  now = Date.now,
}) {
  let hasPreviousRequest = false;
  const beforeRequest = async () => {
    if (hasPreviousRequest) {
      await waitForDelay({ delayMs: config.delayMs, budget, signal, sleep });
    }
    hasPreviousRequest = true;
  };
  const calibrationStopReason = (result) => result.status === "stopped"
    ? safeErrorCode(result.errorCode) ?? "calibration_failed"
    : result.status;

  for (const model of config.models) {
    const calibration = await runResponsesCalibration({
      baseUrl: config.baseUrl,
      apiKey,
      model,
      fetchImpl,
      requestTimeoutMs: config.requestTimeoutMs,
      budget,
      signal,
      delayMs: config.delayMs,
      emit,
      postResponseImpl,
      waitForDelay,
      sleep,
      beforeRequest,
      maxUncertainAttempts: config.maxUncertain,
    });
    if (calibration.status !== "success") {
      emit({
        model,
        status: "summary",
        stage: "summary",
        lastSuccessTarget: null,
        firstOverflowTarget: null,
        boundaryComplete: false,
        validationConsistent: false,
        stopReason: calibrationStopReason(calibration),
      });
      continue;
    }

    const attempt = async (targetEstimatedTokens, stage) => {
      const started = now();
      const estimate = calibration.calibrate(targetEstimatedTokens);
      await beforeRequest();
      budget.beforeRequest();
      const result = await postResponseImpl({
        baseUrl: config.baseUrl,
        apiKey,
        payload: buildResponsesPayload(model, makeProbeText(estimate.units)),
        fetchImpl,
        timeoutMs: budget.timeoutMs(config.requestTimeoutMs),
        signal,
      });
      budget.note(result.status);
      return {
        model,
        targetEstimatedTokens,
        estimatedInputTokens: estimate.estimatedInputTokens,
        estimateErrorBoundTokens: estimate.estimateErrorBoundTokens,
        estimateSource: estimate.estimateSource,
        ...result,
        latencyMs: now() - started,
        stage,
      };
    };
    const plan = await runModelPlan({
      model,
      targets: config.targets ?? DEFAULT_TARGETS,
      resolution: config.resolution,
      maxUncertainAttempts: config.maxUncertain,
      attempt,
      emit,
    });
    emit({ model, status: "summary", stage: "summary", ...plan });
  }
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`probe configuration error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (config.help) return help();

  const emit = (record) => process.stdout.write(`${ndjsonRecord(record)}\n`);
  if (!config.execute) {
    for (const model of config.models) {
      for (const units of CALIBRATION_UNITS) {
        emit({
          model,
          targetEstimatedTokens: null,
          estimatedInputTokens: null,
          estimateSource: "dry_run_calibration",
          observedUsage: null,
          status: "dry_run",
          stage: "calibration",
          units,
        });
      }
      for (let index = 0; index < DEFAULT_TARGETS.length; index++) {
        const targetEstimatedTokens = DEFAULT_TARGETS[index];
        const stage = index === DEFAULT_TARGETS.length - 1 && targetEstimatedTokens === 1060000
          ? "hard_ceiling_sentinel"
          : index < 2 ? "expansion" : "expanded_probe";
        emit({ model, targetEstimatedTokens, estimatedInputTokens: targetEstimatedTokens, estimateSource: "dry_run_target", observedUsage: null, status: "dry_run", stage });
      }
      emit({
        model,
        status: "summary",
        stage: "summary",
        lastSuccessTarget: null,
        firstOverflowTarget: null,
        boundaryComplete: false,
        validationConsistent: false,
        stopReason: "dry_run",
      });
    }
    process.stderr.write("dry-run complete; pass --execute to make requests.\n");
    return;
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    process.stderr.write(`probe configuration error: environment variable ${config.apiKeyEnv} is required for --execute\n`);
    process.exitCode = 2;
    return;
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once("SIGINT", abort);
  try {
    await runProbeExecution({ config, apiKey, emit, signal: abortController.signal });
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
