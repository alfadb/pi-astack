import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureProjectGitignoredOnce, formatLocalIsoTimestamp, piAstackModuleDir } from "./runtime";
import { getCurrentAnchor, spreadAnchor } from "./causal-anchor";
import {
  appendRotatingJsonlLine,
  resolveJsonlRotationSettings,
  type JsonlRotationSettings,
} from "./rotating-jsonl";

const REDACTED = "[pi-astack-redacted]";
const API_KEY_REDACTED = "[pi-astack-redacted-api-key]";

export interface LlmAuditMeta {
  module: string;
  operation: string;
  model_ref?: string;
  model_id?: string;
  session_scope?: string;
  [key: string]: unknown;
}

export interface StreamSimpleLike {
  streamSimple(model: unknown, opts: unknown, config: unknown): { result(): Promise<unknown> };
}

type StreamSimpleResult<TPiAi> = TPiAi extends {
  streamSimple(model: unknown, opts: unknown, config: unknown): { result(): Promise<infer TResult> };
} ? TResult : any;

interface LlmAuditBudgetSettings {
  enabled: boolean;
  maxPromptChars: number;
  maxPromptEstimatedTokens: number;
  perOperationMaxCallsPerTurn: number;
  perOperationMaxEstimatedTokensPerTurn: number;
}

interface LlmAuditBudgetCounter {
  calls: number;
  estimatedTokens: number;
}

interface LlmAuditBudgetState {
  counters: Map<string, LlmAuditBudgetCounter>;
}

const DEFAULT_LLM_AUDIT_BUDGET_SETTINGS: LlmAuditBudgetSettings = {
  enabled: true,
  maxPromptChars: 400_000,
  maxPromptEstimatedTokens: 120_000,
  perOperationMaxCallsPerTurn: 12,
  perOperationMaxEstimatedTokensPerTurn: 300_000,
};
export const DEFAULT_LLM_AUDIT_ROTATION_SETTINGS: JsonlRotationSettings = {
  enabled: true,
  maxBytes: 256 * 1024 * 1024,
  maxAgeMs: 24 * 60 * 60 * 1000,
  lockTimeoutMs: 1_000,
};
const PROCESS_FALLBACK_BUDGET_WINDOW_MS = 10 * 60 * 1000;

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);
const BUDGET_STATE_KEY = Symbol.for("pi-astack/llm-audit/background-budget/v1");

export class BackgroundLlmBudgetExceededError extends Error {
  readonly code = "PI_ASTACK_BACKGROUND_LLM_BUDGET_EXCEEDED";
  readonly budgetName: string;
  readonly count: number;
  readonly limit: number;

  constructor(budgetName: string, count: number, limit: number) {
    super(`background LLM budget exceeded: ${budgetName} ${count} > ${limit}`);
    this.name = "BackgroundLlmBudgetExceededError";
    this.budgetName = budgetName;
    this.count = count;
    this.limit = limit;
  }
}

function auditPath(projectRoot: string): string {
  return path.join(piAstackModuleDir(projectRoot, "llm-audit"), "audit.jsonl");
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean" && typeof (value as AbortSignal).addEventListener === "function";
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function isSensitiveHeaderName(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "cookie" ||
    lower === "set-cookie" ||
    lower === "x-api-key" ||
    lower.includes("api-key") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("secret") ||
    lower.includes("credential") ||
    lower.includes("token");
}

function redactHeaderValue(key: string, value: unknown): unknown {
  return isSensitiveHeaderName(key) ? REDACTED : value;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, parentKey = ""): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${(value as Function).name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  try {
    if (isAbortSignal(value)) {
      return { type: "AbortSignal", aborted: value.aborted, reason: sanitizeValue((value as any).reason, seen, "reason") };
    }
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      for (const key of Object.keys(value)) out[key] = sanitizeValue((value as any)[key], seen, key);
      return out;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return { type: "Buffer", encoding: "base64", data: value.toString("base64") };
    }
    if (value instanceof ArrayBuffer) {
      return { type: "ArrayBuffer", byteLength: value.byteLength, data: Buffer.from(value).toString("base64") };
    }
    if (isArrayBufferView(value)) {
      const view = value as ArrayBufferView;
      return {
        type: view.constructor?.name || "ArrayBufferView",
        byteLength: view.byteLength,
        byteOffset: view.byteOffset,
        data: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64"),
      };
    }
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));

    const out: Record<string, unknown> = {};
    const parentKeyLower = parentKey.toLowerCase();
    const headerContainer = parentKeyLower === "headers" || parentKeyLower.endsWith("_headers");
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const raw = (value as Record<string, unknown>)[key];
      const lower = key.toLowerCase();
      if (lower === "apikey" || lower === "api_key" || lower === "api-key") {
        out[key] = API_KEY_REDACTED;
        continue;
      }
      if (headerContainer) {
        out[key] = sanitizeValue(redactHeaderValue(key, raw), seen, key);
        continue;
      }
      out[key] = sanitizeValue(raw, seen, key);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeValue(value, new WeakSet<object>()));
  } catch (error) {
    return JSON.stringify({ serialization_error: error instanceof Error ? error.message : String(error) });
  }
}

function modelIdFrom(model: unknown, modelRef?: string): string | undefined {
  const m = model as { id?: unknown; model?: unknown; name?: unknown } | undefined;
  if (typeof m?.id === "string") return m.id;
  if (typeof m?.model === "string") return m.model;
  if (typeof m?.name === "string") return m.name;
  if (modelRef && modelRef.includes("/")) return modelRef.slice(modelRef.indexOf("/") + 1);
  return modelRef;
}

function modelInfoFromContext(ctx: unknown): Record<string, unknown> | undefined {
  const model = (ctx as { model?: Record<string, unknown> } | undefined)?.model;
  if (!model || typeof model !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["provider", "id", "modelId", "api", "contextWindow", "maxTokens"]) {
    if (model[key] !== undefined) out[key] = model[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    try {
      if (fsSync.existsSync(PI_STACK_SETTINGS_PATH)) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
      }
    } catch {
      // ignore
    }
    return {};
  }
}

export function resolveLlmAuditRotationSettings(rawSettings?: Record<string, unknown>): JsonlRotationSettings {
  const raw = rawSettings ?? loadPiStackSettings();
  const llmAudit = (raw.llmAudit ?? {}) as Record<string, unknown>;
  return resolveJsonlRotationSettings(llmAudit.rotation, DEFAULT_LLM_AUDIT_ROTATION_SETTINGS);
}

function resolveLlmAuditBudgetSettings(): LlmAuditBudgetSettings {
  const raw = loadPiStackSettings();
  const llmAudit = (raw.llmAudit ?? {}) as Record<string, unknown>;
  const block = (llmAudit.backgroundBudget ?? {}) as Record<string, unknown>;
  const def = DEFAULT_LLM_AUDIT_BUDGET_SETTINGS;
  return {
    enabled: asBoolean(block.enabled, def.enabled),
    maxPromptChars: Math.max(0, Math.floor(asNumber(block.maxPromptChars, def.maxPromptChars))),
    maxPromptEstimatedTokens: Math.max(0, Math.floor(asNumber(block.maxPromptEstimatedTokens, def.maxPromptEstimatedTokens))),
    perOperationMaxCallsPerTurn: Math.max(0, Math.floor(asNumber(block.perOperationMaxCallsPerTurn, def.perOperationMaxCallsPerTurn))),
    perOperationMaxEstimatedTokensPerTurn: Math.max(0, Math.floor(asNumber(block.perOperationMaxEstimatedTokensPerTurn, def.perOperationMaxEstimatedTokensPerTurn))),
  };
}

function budgetState(): LlmAuditBudgetState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[BUDGET_STATE_KEY] as LlmAuditBudgetState | undefined;
  if (!state) {
    state = { counters: new Map<string, LlmAuditBudgetCounter>() };
    g[BUDGET_STATE_KEY] = state;
  }
  return state;
}

function promptCharsFrom(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (value === null || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  try {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (isArrayBufferView(value)) return value.byteLength;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + promptCharsFrom(item, seen), 0);
    let sum = 0;
    for (const item of Object.values(value as Record<string, unknown>)) {
      sum += promptCharsFrom(item, seen);
    }
    return sum;
  } finally {
    seen.delete(value);
  }
}

function budgetTurnKey(): string {
  const anchor = getCurrentAnchor();
  if (anchor) return `${anchor.session_id}:${anchor.turn_id}`;
  const windowId = Math.floor(Date.now() / PROCESS_FALLBACK_BUDGET_WINDOW_MS);
  return `process:${windowId}`;
}

function budgetCounterKey(meta: LlmAuditMeta, modelId: string | undefined): string {
  return `${budgetTurnKey()}:${meta.module}:${meta.operation}:${modelId ?? "unknown-model"}`;
}

async function appendBudgetRow(projectRoot: string, row: {
  module: string;
  operation: string;
  model_id: string | undefined;
  promptChars: number;
  estimatedTokens: number;
  budgetName: string;
  count: number;
  limit: number;
  result: "allow" | "blocked";
}): Promise<void> {
  await appendLlmAudit(projectRoot, {
    row_type: "budget",
    api_kind: "pi-ai.streamSimple",
    module: row.module,
    operation: row.operation,
    model_id: row.model_id,
    prompt_chars: row.promptChars,
    estimated_tokens: row.estimatedTokens,
    budget_name: row.budgetName,
    count: row.count,
    limit: row.limit,
    result: row.result,
  });
}

async function enforceBackgroundBudget(projectRoot: string, meta: LlmAuditMeta, modelId: string | undefined, opts: unknown): Promise<void> {
  const settings = resolveLlmAuditBudgetSettings();
  if (!settings.enabled) return;

  const promptChars = promptCharsFrom(opts);
  const estimatedTokens = Math.ceil(promptChars / 4);
  const key = budgetCounterKey(meta, modelId);
  const state = budgetState();
  const current = state.counters.get(key) ?? { calls: 0, estimatedTokens: 0 };

  const checks = [
    { name: "maxPromptChars", count: promptChars, limit: settings.maxPromptChars },
    { name: "maxPromptEstimatedTokens", count: estimatedTokens, limit: settings.maxPromptEstimatedTokens },
    { name: "perOperationMaxCallsPerTurn", count: current.calls + 1, limit: settings.perOperationMaxCallsPerTurn },
    { name: "perOperationMaxEstimatedTokensPerTurn", count: current.estimatedTokens + estimatedTokens, limit: settings.perOperationMaxEstimatedTokensPerTurn },
  ];

  for (const check of checks) {
    if (check.limit > 0 && check.count > check.limit) {
      await appendBudgetRow(projectRoot, {
        module: meta.module,
        operation: meta.operation,
        model_id: modelId,
        promptChars,
        estimatedTokens,
        budgetName: check.name,
        count: check.count,
        limit: check.limit,
        result: "blocked",
      });
      throw new BackgroundLlmBudgetExceededError(check.name, check.count, check.limit);
    }
  }

  current.calls += 1;
  current.estimatedTokens += estimatedTokens;
  state.counters.set(key, current);

  const allowBudget = settings.perOperationMaxEstimatedTokensPerTurn > 0
    ? { name: "perOperationMaxEstimatedTokensPerTurn", count: current.estimatedTokens, limit: settings.perOperationMaxEstimatedTokensPerTurn }
    : settings.perOperationMaxCallsPerTurn > 0
      ? { name: "perOperationMaxCallsPerTurn", count: current.calls, limit: settings.perOperationMaxCallsPerTurn }
      : { name: "backgroundBudget", count: current.calls, limit: 0 };
  await appendBudgetRow(projectRoot, {
    module: meta.module,
    operation: meta.operation,
    model_id: modelId,
    promptChars,
    estimatedTokens,
    budgetName: allowBudget.name,
    count: allowBudget.count,
    limit: allowBudget.limit,
    result: "allow",
  });
}

function withAuditBase(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: formatLocalIsoTimestamp(),
    ...spreadAnchor(getCurrentAnchor()),
    ...row,
  };
}

export function _resetLlmAuditBudgetForTests(): void {
  budgetState().counters.clear();
}

export async function appendLlmAudit(projectRoot: string, row: Record<string, unknown>): Promise<void> {
  let line: string;
  try {
    line = safeJson(withAuditBase(row)) + "\n";
  } catch {
    return;
  }

  try {
    await appendRotatingJsonlLine(auditPath(projectRoot), line, {
      sink: "llm-audit",
      rotation: resolveLlmAuditRotationSettings(),
    });
    void ensureProjectGitignoredOnce(projectRoot).catch(() => { /* best-effort */ });
  } catch {
    /* audit must never affect the caller */
  }
}

function controlledMetaShape(meta: LlmAuditMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "module", "operation", "model_ref", "model_id", "session_scope",
    "sub_agent_label", "subturn", "task_index", "task_count",
    "workflow_run_id", "workflow_stage_id", "thinking",
  ]) {
    const value = meta[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function topLevelShape(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      bytes: safeJsonByteLength(value),
    };
  }
  const record = value as Record<string, unknown>;
  return {
    kind: "object",
    bytes: safeJsonByteLength(value),
    key_count: Object.keys(record).length,
    keys: [...new Set(Object.keys(record).map(publicShapeKey))].sort(),
    messages_count: Array.isArray(record.messages) ? record.messages.length : undefined,
    tools_count: Array.isArray(record.tools) ? record.tools.length : undefined,
    headers_shape: headersShape(record.headers),
  };
}

function streamModelShape(model: unknown, modelId: string | undefined): Record<string, unknown> {
  const record = model && typeof model === "object" ? model as Record<string, unknown> : undefined;
  return {
    provider: typeof record?.provider === "string" ? record.provider : undefined,
    id: typeof record?.id === "string" ? record.id : modelId,
    api: typeof record?.api === "string" ? record.api : undefined,
  };
}

export async function auditStreamSimple<TPiAi extends StreamSimpleLike>(
  projectRoot: string,
  meta: LlmAuditMeta,
  piAi: TPiAi,
  model: unknown,
  opts: unknown,
  config: unknown,
): Promise<StreamSimpleResult<TPiAi>> {
  const started = Date.now();
  const callId = `${started.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const modelRef = typeof meta.model_ref === "string" ? meta.model_ref : undefined;
  const modelId = typeof meta.model_id === "string" ? meta.model_id : modelIdFrom(model, modelRef);
  const base = {
    call_id: callId,
    module: meta.module,
    operation: meta.operation,
    api_kind: "pi-ai.streamSimple",
    model_ref: modelRef,
    model_id: modelId,
    model: streamModelShape(model, modelId),
    meta: controlledMetaShape(meta),
  };

  await enforceBackgroundBudget(projectRoot, meta, modelId, opts);

  await appendLlmAudit(projectRoot, {
    ...base,
    row_type: "start",
    request_shape: topLevelShape(opts),
    config_shape: topLevelShape(config),
  });

  try {
    const stream = piAi.streamSimple(model, opts, config);
    const finalMessage = await stream.result() as StreamSimpleResult<TPiAi>;
    const finalRecord = finalMessage && typeof finalMessage === "object"
      ? finalMessage as Record<string, unknown>
      : undefined;
    await appendLlmAudit(projectRoot, {
      ...base,
      row_type: "end",
      duration_ms: Date.now() - started,
      final_message_shape: sessionMessageShape(finalMessage),
      usage: controlledUsageShape(finalRecord?.usage),
      stopReason: typeof finalRecord?.stopReason === "string" ? finalRecord.stopReason : undefined,
    });
    return finalMessage;
  } catch (error) {
    await appendLlmAudit(projectRoot, {
      ...base,
      row_type: "error",
      duration_ms: Date.now() - started,
      error: controlledErrorShape(error),
    });
    throw error;
  }
}

function controlledUsageShape(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "totalTokens"]) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) output[key] = input[key];
  }
  if (typeof input.cost === "number" && Number.isFinite(input.cost)) output.cost = input.cost;
  if (input.cost && typeof input.cost === "object") {
    const cost: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      const amount = (input.cost as Record<string, unknown>)[key];
      if (typeof amount === "number" && Number.isFinite(amount)) cost[key] = amount;
    }
    if (Object.keys(cost).length > 0) output.cost = cost;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function redactControlledErrorText(value: string): string {
  return value
    .slice(0, 500)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [pi-astack-redacted]")
    .replace(/\b(?:api[\s_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential=[pi-astack-redacted]")
    .replace(/\b(?:sk|rk|pk|xai)-[A-Za-z0-9_-]{8,}\b/g, "[pi-astack-redacted-api-key]")
    .replace(/\b(?:AIza|AKIA)[A-Za-z0-9_-]{12,}\b/g, "[pi-astack-redacted-api-key]")
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}\b/g, "[pi-astack-redacted-api-key]");
}

function controlledErrorShape(value: unknown): Record<string, unknown> | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const message = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : typeof record?.message === "string" ? record.message : undefined;
  const code = typeof record?.code === "string" ? redactControlledErrorText(record.code).slice(0, 80) : undefined;
  const name = value instanceof Error ? value.name : typeof record?.name === "string" ? record.name.slice(0, 80) : undefined;
  if (!message && !code && !name) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message_length: stringLengthShape(String(message)) } : {}),
  };
}

function stringLengthShape(value: string): Record<string, number> {
  return { chars: value.length, bytes: Buffer.byteLength(value, "utf8") };
}

function contentBlockShape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { type: "text", text: stringLengthShape(value) };
  if (!value || typeof value !== "object") return { type: "unknown" };
  const block = value as Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: typeof block.type === "string" ? block.type : "unknown",
  };
  for (const key of ["text", "thinking", "reasoning", "summary", "content", "output"]) {
    const item = block[key];
    if (typeof item === "string") out[`${key}_length`] = stringLengthShape(item);
    else if (Array.isArray(item)) out[`${key}_items`] = item.length;
  }
  return out;
}

function contentShape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return {
      content_kind: "string",
      content_blocks: 1,
      content_types: ["text"],
      content_block_lengths: [contentBlockShape(value)],
    };
  }
  if (Array.isArray(value)) {
    const blocks = value.map(contentBlockShape);
    return {
      content_kind: "array",
      content_blocks: value.length,
      content_types: blocks.map((block) => typeof block.type === "string" ? block.type : "unknown"),
      content_block_lengths: blocks,
    };
  }
  if (value === undefined) return { content_kind: "absent", content_blocks: 0, content_types: [], content_block_lengths: [] };
  return { content_kind: typeof value, content_blocks: 0, content_types: [], content_block_lengths: [] };
}

function sessionMessageShape(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  const error = controlledErrorShape(message.errorMessage ?? message.error);
  return {
    role: typeof message.role === "string" ? message.role : undefined,
    api: typeof message.api === "string" ? message.api : undefined,
    provider: typeof message.provider === "string" ? message.provider : undefined,
    model: typeof message.model === "string"
      ? message.model
      : typeof message.responseModel === "string" ? message.responseModel : undefined,
    responseId: typeof message.responseId === "string" ? message.responseId : undefined,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    ...contentShape(message.content),
    usage: controlledUsageShape(message.usage),
    ...(error ? { error } : {}),
  };
}

function safeJsonByteLength(value: unknown): number | undefined {
  try { return Buffer.byteLength(safeJson(value), "utf8"); }
  catch { return undefined; }
}

function publicShapeKey(key: string): string {
  const lower = key.toLowerCase();
  return isSensitiveHeaderName(key) || lower === "apikey" || lower === "api_key" || lower === "api-key"
    ? "[sensitive-key]"
    : key;
}

function headersShape(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  const nonSensitive = keys.filter((key) => !isSensitiveHeaderName(key)).map((key) => key.toLowerCase()).sort();
  return {
    header_count: keys.length,
    sensitive_header_count: keys.length - nonSensitive.length,
    non_sensitive_header_names: nonSensitive,
  };
}

function providerPayloadShape(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload === undefined ? undefined : { payload_kind: typeof payload, payload_bytes: safeJsonByteLength(payload) };
  }
  const record = payload as Record<string, unknown>;
  return {
    payload_kind: "object",
    payload_bytes: safeJsonByteLength(payload),
    payload_keys: [...new Set(Object.keys(record).map(publicShapeKey))].sort(),
    model: typeof record.model === "string" ? record.model : undefined,
    api: typeof record.api === "string" ? record.api : undefined,
    messages_count: Array.isArray(record.messages) ? record.messages.length : undefined,
    input_kind: record.input === undefined ? undefined : Array.isArray(record.input) ? "array" : typeof record.input,
    input_count: Array.isArray(record.input) ? record.input.length : undefined,
    tools_count: Array.isArray(record.tools) ? record.tools.length : undefined,
    stream: typeof record.stream === "boolean" ? record.stream : undefined,
    max_tokens: typeof record.max_tokens === "number" ? record.max_tokens : undefined,
    max_completion_tokens: typeof record.max_completion_tokens === "number" ? record.max_completion_tokens : undefined,
    temperature: typeof record.temperature === "number" ? record.temperature : undefined,
    headers_shape: headersShape(record.headers),
  };
}

export function auditSessionEvent(projectRoot: string, meta: LlmAuditMeta, event: unknown): void {
  const e = event as Record<string, unknown> | undefined;
  const eventType = typeof e?.type === "string" ? e.type : "unknown";
  const base = {
    row_type: "session_event",
    module: meta.module,
    operation: meta.operation,
    api_kind: "pi.session_event",
    event_type: eventType,
    meta: controlledMetaShape(meta),
  };

  if (eventType === "message_update") {
    const assistantEvent = e?.assistantMessageEvent as Record<string, unknown> | undefined;
    const delta = typeof assistantEvent?.delta === "string" ? assistantEvent.delta : undefined;
    const partial = assistantEvent?.partial as Record<string, unknown> | undefined;
    const message = e?.message as Record<string, unknown> | undefined;
    void appendLlmAudit(projectRoot, {
      ...base,
      assistant_event_type: typeof assistantEvent?.type === "string" ? assistantEvent.type : "unknown",
      content_index: typeof assistantEvent?.contentIndex === "number" ? assistantEvent.contentIndex : undefined,
      delta_chars: delta?.length ?? 0,
      delta_bytes: delta === undefined ? 0 : Buffer.byteLength(delta, "utf8"),
      response_id:
        (typeof partial?.responseId === "string" ? partial.responseId : undefined) ??
        (typeof message?.responseId === "string" ? message.responseId : undefined),
      message_shape: sessionMessageShape(e?.message),
    });
    return;
  }

  if (eventType === "message_end") {
    const message = e?.message as Record<string, unknown> | undefined;
    void appendLlmAudit(projectRoot, {
      ...base,
      message_shape: sessionMessageShape(e?.message),
      usage: controlledUsageShape(message?.usage ?? e?.usage),
      error: controlledErrorShape(message?.errorMessage ?? e?.error ?? e?.errorMessage ?? e?.finalError),
    });
    return;
  }

  void appendLlmAudit(projectRoot, {
    ...base,
    message_shape: sessionMessageShape(e?.message),
    message_count: Array.isArray(e?.messages) ? e.messages.length : undefined,
    assistant_message_count: Array.isArray(e?.messages)
      ? e.messages.filter((message) => !!message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant").length
      : undefined,
    will_retry: typeof e?.willRetry === "boolean" ? e.willRetry : undefined,
    error: controlledErrorShape(e?.error ?? e?.errorMessage ?? e?.finalError),
  });
}

export async function auditProviderBoundaryEvent(
  projectRoot: string,
  meta: LlmAuditMeta,
  event: unknown,
  ctx?: unknown,
): Promise<void> {
  const e = event as Record<string, unknown> | undefined;
  const eventType = typeof e?.type === "string" ? e.type : "unknown";
  await appendLlmAudit(projectRoot, {
    row_type: "provider_event",
    module: meta.module,
    operation: meta.operation,
    api_kind: "pi.provider_boundary",
    event_type: eventType,
    meta: controlledMetaShape(meta),
    model: modelInfoFromContext(ctx),
    request_payload_shape: providerPayloadShape(e?.payload),
    response_status: typeof e?.status === "number" ? e.status : undefined,
    response_headers_shape: headersShape(e?.headers),
    usage: controlledUsageShape(e?.usage),
    error: controlledErrorShape(e?.error ?? e?.errorMessage ?? e?.finalError),
  });
}
