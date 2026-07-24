import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureProjectGitignoredOnce, formatLocalIsoTimestamp, piAstackModuleDir } from "./runtime";
import { getCurrentAnchor, spreadAnchor, type CausalAnchor } from "./causal-anchor";
import { auditHmacHex, createAuditRollingHmac, type AuditRollingHmac } from "./audit-hmac";
import {
  appendRotatingJsonlLine,
  resolveJsonlRotationSettings,
  type JsonlRotationSettings,
} from "./rotating-jsonl";

const API_KEY_REDACTED = "[pi-astack-redacted-api-key]";
const FORBIDDEN_AUDIT_KEYS = new Set([
  "prompt", "text", "content", "reasoning", "tool_output", "request_body",
  "raw_response_text", "parsed_response", "request_payload", "event", "message",
  "delta", "base64", "url", "headers", "credential", "credentials", "signature",
  "encrypted_content",
]);

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

function normalizedAuditKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
}

const SAFE_AUDIT_SCHEMA_KEYS = new Set([
  "event_type", "event_type_counts", "type_counts", "content_kind", "content_blocks",
  "content_types", "content_block_lengths", "content_block_kind_counts", "content_index_distinct_count",
  "content_index_limit", "content_index_overflow", "content_index_overflow_count", "text_length",
  "thinking_length", "reasoning_length", "summary_length", "content_length", "output_length",
  "headers_shape", "response_headers_shape", "request_payload_shape", "header_count",
  "sensitive_header_count", "non_sensitive_header_names", "prompt_chars",
]);

function isForbiddenAuditKey(key: string): boolean {
  const normalized = normalizedAuditKey(key);
  if (SAFE_AUDIT_SCHEMA_KEYS.has(normalized)) return false;
  if (FORBIDDEN_AUDIT_KEYS.has(normalized)) return true;
  const tokens = normalized.split("_");
  if (tokens.includes("prompt") || tokens.includes("signature") || tokens.includes("credential") || tokens.includes("credentials") || tokens.includes("base64")) return true;
  if (normalized === "url" || normalized.endsWith("_url") || normalized === "headers" || normalized.endsWith("_headers")) return true;
  return tokens.includes("encrypted") && tokens.includes("content");
}

function isCredentialValueKey(key: string): boolean {
  const normalized = normalizedAuditKey(key);
  return ["authorization", "proxy_authorization", "cookie", "set_cookie", "apikey", "api_key", "access_token", "token", "secret", "api_secret"].includes(normalized) ||
    normalized.includes("api_key") || normalized.endsWith("_token") || normalized.endsWith("_secret");
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${(value as Function).name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  try {
    if (isAbortSignal(value)) {
      return { type: "AbortSignal", aborted: value.aborted };
    }
    if (value instanceof Error) {
      return {
        name: value.name.slice(0, 80),
        detail_length: stringLengthShape(value.message),
      };
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return { binary_bytes: value.byteLength };
    }
    if (value instanceof ArrayBuffer) {
      return { binary_bytes: value.byteLength };
    }
    if (isArrayBufferView(value)) {
      return { binary_bytes: (value as ArrayBufferView).byteLength };
    }
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (isForbiddenAuditKey(key)) continue;
      const raw = (value as Record<string, unknown>)[key];
      if (isCredentialValueKey(key)) {
        out[key] = API_KEY_REDACTED;
        continue;
      }
      out[key] = sanitizeValue(raw, seen);
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

export function resolveLlmAuditBudgetSettings(): LlmAuditBudgetSettings {
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
      usage: controlledLlmAuditUsage(finalRecord?.usage),
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

export function controlledLlmAuditUsage(value: unknown): Record<string, unknown> | undefined {
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
  const detail = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : typeof record?.message === "string" ? record.message : undefined;
  const code = typeof record?.code === "string" ? redactControlledErrorText(record.code).slice(0, 80) : undefined;
  const name = value instanceof Error ? value.name : typeof record?.name === "string" ? record.name.slice(0, 80) : undefined;
  if (!detail && !code && !name) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    ...(detail ? { detail_length: stringLengthShape(String(detail)) } : {}),
  };
}

function errorCategory(value: unknown): string {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const code = typeof record?.code === "string" ? record.code.toLowerCase() : "";
  const name = value instanceof Error ? value.name.toLowerCase() : typeof record?.name === "string" ? record.name.toLowerCase() : "";
  const detail = typeof value === "string" ? value.toLowerCase() : value instanceof Error ? value.message.toLowerCase() : "";
  if (name.includes("abort") || code.includes("abort")) return "aborted";
  if (name.includes("timeout") || code.includes("timeout") || detail.includes("timeout")) return "timeout";
  if (detail.includes("json") || name.includes("syntax")) return "invalid_response";
  if (detail.includes("http")) return "http_error";
  if (name.includes("type")) return "type_error";
  return "other";
}

export function controlledLlmAuditError(projectRoot: string, value: unknown): Record<string, unknown> | undefined {
  const shape = controlledErrorShape(value);
  if (!shape) return undefined;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const detail = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : typeof record?.message === "string" ? record.message : "";
  return {
    category: errorCategory(value),
    ...shape,
    ...(detail ? { fingerprint: auditHmacHex(projectRoot, "llm-audit/error/v1", detail) } : {}),
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
    usage: controlledLlmAuditUsage(message.usage),
    ...(error ? { error } : {}),
  };
}

function safeJsonByteLength(value: unknown): number | undefined {
  try { return Buffer.byteLength(safeJson(value), "utf8"); }
  catch { return undefined; }
}

function publicShapeKey(key: string): string {
  const lower = key.toLowerCase();
  return isForbiddenAuditKey(key) || isSensitiveHeaderName(key) || lower === "apikey" || lower === "api_key" || lower === "api-key"
    ? "[private-key]"
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

export const MAX_SESSION_STREAM_AGGREGATES = 256;
const MAX_SESSION_STREAM_CONTENT_INDICES = 64;
const MAX_SESSION_STREAM_TYPE_KEYS = 32;
const SESSION_STREAM_STATE_KEY = Symbol.for("pi-astack/llm-audit/session-stream-state/v2");
const SESSION_STREAM_ORDINAL_KEY = Symbol.for("pi-astack/llm-audit/session-stream-ordinals/v1");

type StreamDeltaKind = "thinking" | "text" | "tool" | "generic";
type StreamFlushReason = "message_end" | "message_end_ambiguous" | "agent_end" | "lru_eviction";

interface StreamDeltaStats {
  count: number;
  charsTotal: number;
  bytesTotal: number;
  charsMax: number;
  bytesMax: number;
  hmac: AuditRollingHmac;
}

interface SessionStreamAggregate {
  key: string;
  projectRoot: string;
  module: string;
  operation: string;
  anchor: CausalAnchor | undefined;
  ordinal: number;
  orphan: boolean;
  responseId: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  eventTypeCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  contentBlockKindCounts: Record<string, number>;
  contentIndices: Set<number>;
  contentIndexOverflowCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  total: StreamDeltaStats;
  byKind: Record<StreamDeltaKind, StreamDeltaStats>;
}

function sessionStreamState(): Map<string, SessionStreamAggregate> {
  const global = globalThis as Record<symbol, unknown>;
  let state = global[SESSION_STREAM_STATE_KEY] as Map<string, SessionStreamAggregate> | undefined;
  if (!state) {
    state = new Map<string, SessionStreamAggregate>();
    global[SESSION_STREAM_STATE_KEY] = state;
  }
  return state;
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 256) : undefined;
}

function messageIdentity(event: Record<string, unknown> | undefined): {
  responseId: string | undefined;
  provider: string | undefined;
  model: string | undefined;
} {
  const assistant = event?.assistantMessageEvent as Record<string, unknown> | undefined;
  const partial = assistant?.partial as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;
  return {
    responseId: boundedIdentity(partial?.responseId) ?? boundedIdentity(message?.responseId),
    provider: boundedIdentity(partial?.provider) ?? boundedIdentity(message?.provider),
    model: boundedIdentity(partial?.model) ?? boundedIdentity(partial?.responseModel) ??
      boundedIdentity(message?.model) ?? boundedIdentity(message?.responseModel),
  };
}

function streamAnchorKey(projectRoot: string, meta: LlmAuditMeta, anchor: CausalAnchor | undefined): string {
  return JSON.stringify([
    path.resolve(projectRoot),
    meta.module,
    meta.operation,
    anchor?.session_id ?? "process",
    anchor?.turn_id ?? -1,
    anchor?.subturn ?? -1,
  ]);
}

function streamAggregateKey(projectRoot: string, meta: LlmAuditMeta, anchor: CausalAnchor | undefined, ordinal: number): string {
  return JSON.stringify([streamAnchorKey(projectRoot, meta, anchor), ordinal]);
}

function nextStreamOrdinal(projectRoot: string, meta: LlmAuditMeta, anchor: CausalAnchor | undefined): number {
  const global = globalThis as Record<symbol, unknown>;
  let ordinals = global[SESSION_STREAM_ORDINAL_KEY] as Map<string, number> | undefined;
  if (!ordinals) {
    ordinals = new Map<string, number>();
    global[SESSION_STREAM_ORDINAL_KEY] = ordinals;
  }
  const key = streamAnchorKey(projectRoot, meta, anchor);
  const ordinal = (ordinals.get(key) ?? 0) + 1;
  ordinals.set(key, ordinal);
  return ordinal;
}

function streamDeltaKind(assistantType: string, blockType?: string): StreamDeltaKind {
  const value = `${assistantType}:${blockType ?? ""}`.toLowerCase();
  if (value.includes("thinking") || value.includes("reasoning")) return "thinking";
  if (value.includes("tool")) return "tool";
  if (value.includes("text")) return "text";
  return "generic";
}

function eventTimestamp(event: Record<string, unknown> | undefined): string {
  const candidate = event?.timestamp ?? event?.ts;
  const milliseconds = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Date.parse(candidate) : NaN;
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now()).toISOString();
}

function incrementBoundedCount(record: Record<string, number>, rawKey: string, maxKeys: number): void {
  const key = rawKey.slice(0, 80) || "unknown";
  if (Object.hasOwn(record, key)) {
    record[key] += 1;
    return;
  }
  const hasOther = Object.hasOwn(record, "other");
  const namedLimit = maxKeys - (hasOther ? 1 : 1);
  const namedCount = Object.keys(record).filter((item) => item !== "other").length;
  if (key !== "other" && namedCount < namedLimit) {
    record[key] = 1;
    return;
  }
  record.other = (record.other ?? 0) + 1;
}

function newDeltaStats(projectRoot: string, domain: string): StreamDeltaStats {
  return {
    count: 0,
    charsTotal: 0,
    bytesTotal: 0,
    charsMax: 0,
    bytesMax: 0,
    hmac: createAuditRollingHmac(projectRoot, domain),
  };
}

function updateDeltaStats(stats: StreamDeltaStats, assistantType: string, contentIndex: number | undefined, delta: string): void {
  const chars = delta.length;
  const bytes = Buffer.byteLength(delta, "utf8");
  stats.count += 1;
  stats.charsTotal += chars;
  stats.bytesTotal += bytes;
  stats.charsMax = Math.max(stats.charsMax, chars);
  stats.bytesMax = Math.max(stats.bytesMax, bytes);
  stats.hmac.update("assistant_type", assistantType);
  stats.hmac.update("content_index", contentIndex === undefined ? "absent" : String(contentIndex));
  stats.hmac.update("delta", delta);
}

function deltaStatsShape(stats: StreamDeltaStats): Record<string, unknown> {
  return {
    count: stats.count,
    chars_total: stats.charsTotal,
    bytes_total: stats.bytesTotal,
    chars_max: stats.charsMax,
    bytes_max: stats.bytesMax,
    rolling_hmac: {
      algorithm: stats.hmac.algorithm,
      key_id: stats.hmac.keyId,
      digest: stats.hmac.digestHex(),
    },
  };
}

function blockTypeAt(event: Record<string, unknown> | undefined, index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  const assistant = event?.assistantMessageEvent as Record<string, unknown> | undefined;
  const partial = assistant?.partial as Record<string, unknown> | undefined;
  const blocks = Array.isArray(partial?.content) ? partial.content : undefined;
  const block = blocks?.[index];
  return block && typeof block === "object" && typeof (block as Record<string, unknown>).type === "string"
    ? boundedIdentity((block as Record<string, unknown>).type)
    : undefined;
}

function createStreamAggregate(
  projectRoot: string,
  meta: LlmAuditMeta,
  anchor: CausalAnchor | undefined,
  identity: ReturnType<typeof messageIdentity>,
  timestamp: string,
  orphan = false,
): SessionStreamAggregate {
  const ordinal = nextStreamOrdinal(projectRoot, meta, anchor);
  const key = streamAggregateKey(projectRoot, meta, anchor, ordinal);
  return {
    key,
    projectRoot: path.resolve(projectRoot),
    module: meta.module,
    operation: meta.operation,
    anchor: anchor ? { ...anchor } : undefined,
    ordinal,
    orphan,
    responseId: identity.responseId,
    provider: identity.provider,
    model: identity.model,
    eventTypeCounts: {},
    typeCounts: {},
    contentBlockKindCounts: {},
    contentIndices: new Set<number>(),
    contentIndexOverflowCount: 0,
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    total: newDeltaStats(projectRoot, "llm-audit/session-stream/total/v1"),
    byKind: {
      thinking: newDeltaStats(projectRoot, "llm-audit/session-stream/thinking/v1"),
      text: newDeltaStats(projectRoot, "llm-audit/session-stream/text/v1"),
      tool: newDeltaStats(projectRoot, "llm-audit/session-stream/tool/v1"),
      generic: newDeltaStats(projectRoot, "llm-audit/session-stream/generic/v1"),
    },
  };
}

function countRecordAsRows(record: Record<string, number>): Array<{ kind: string; count: number }> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right)).map(([kind, count]) => ({ kind, count }));
}

function streamSummaryRow(aggregate: SessionStreamAggregate, reason: StreamFlushReason): Record<string, unknown> {
  const complete = reason === "message_end";
  return {
    row_type: "session_stream_summary",
    module: aggregate.module,
    operation: aggregate.operation,
    api_kind: "pi.session_event",
    event_type_counts: aggregate.eventTypeCounts,
    type_counts: aggregate.typeCounts,
    delta_stats: {
      total: deltaStatsShape(aggregate.total),
      by_kind: {
        thinking_delta: deltaStatsShape(aggregate.byKind.thinking),
        text_delta: deltaStatsShape(aggregate.byKind.text),
        tool_delta: deltaStatsShape(aggregate.byKind.tool),
        generic_delta: deltaStatsShape(aggregate.byKind.generic),
      },
    },
    content_block_kind_counts: countRecordAsRows(aggregate.contentBlockKindCounts),
    content_index_distinct_count: aggregate.contentIndices.size,
    content_index_limit: MAX_SESSION_STREAM_CONTENT_INDICES,
    content_index_overflow: aggregate.contentIndexOverflowCount > 0,
    content_index_overflow_count: aggregate.contentIndexOverflowCount,
    first_timestamp: aggregate.firstTimestamp,
    last_timestamp: aggregate.lastTimestamp,
    stream_ordinal: aggregate.ordinal,
    orphan: aggregate.orphan,
    response_id: aggregate.responseId,
    provider: aggregate.provider,
    model: aggregate.model,
    ...spreadAnchor(aggregate.anchor),
    complete,
    incomplete: !complete,
    flush_reason: reason,
  };
}

function flushAggregate(aggregate: SessionStreamAggregate, reason: StreamFlushReason): Promise<void> {
  return appendLlmAudit(aggregate.projectRoot, streamSummaryRow(aggregate, reason));
}

function sameAnchor(left: CausalAnchor | undefined, right: CausalAnchor | undefined): boolean {
  return (left?.session_id ?? undefined) === (right?.session_id ?? undefined) &&
    (left?.turn_id ?? undefined) === (right?.turn_id ?? undefined) &&
    (left?.subturn ?? undefined) === (right?.subturn ?? undefined);
}

function matchingOpenStreams(projectRoot: string, meta: LlmAuditMeta, anchor: CausalAnchor | undefined): SessionStreamAggregate[] {
  const resolvedRoot = path.resolve(projectRoot);
  return [...sessionStreamState().values()].filter((candidate) =>
    candidate.projectRoot === resolvedRoot && candidate.module === meta.module && candidate.operation === meta.operation &&
    sameAnchor(candidate.anchor, anchor));
}

function evictIfNeeded(): Promise<void> {
  const state = sessionStreamState();
  if (state.size < MAX_SESSION_STREAM_AGGREGATES) return Promise.resolve();
  const oldest = state.entries().next().value as [string, SessionStreamAggregate] | undefined;
  if (!oldest) return Promise.resolve();
  state.delete(oldest[0]);
  return flushAggregate(oldest[1], "lru_eviction");
}

async function startSessionStream(projectRoot: string, meta: LlmAuditMeta, event: Record<string, unknown> | undefined): Promise<void> {
  await evictIfNeeded();
  const anchor = getCurrentAnchor();
  const aggregate = createStreamAggregate(projectRoot, meta, anchor, messageIdentity(event), eventTimestamp(event));
  sessionStreamState().set(aggregate.key, aggregate);
}

async function flushTerminalStreams(
  projectRoot: string,
  meta: LlmAuditMeta,
  anchor: CausalAnchor | undefined,
  identity: ReturnType<typeof messageIdentity>,
  terminal: "message_end" | "agent_end",
): Promise<void> {
  const state = sessionStreamState();
  const open = matchingOpenStreams(projectRoot, meta, anchor);
  if (terminal === "agent_end") {
    for (const aggregate of open) state.delete(aggregate.key);
    await Promise.all(open.map((aggregate) => flushAggregate(aggregate, "agent_end")));
    return;
  }

  const exact = identity.responseId
    ? open.filter((aggregate) => aggregate.responseId === identity.responseId && !aggregate.orphan)
    : [];
  if (exact.length === 1) {
    state.delete(exact[0].key);
    await flushAggregate(exact[0], "message_end");
    return;
  }
  if (exact.length === 0 && open.length === 1) {
    state.delete(open[0].key);
    await flushAggregate(open[0], "message_end");
    return;
  }

  const ambiguous = exact.length > 1
    ? open.filter((aggregate) => exact.includes(aggregate) || (aggregate.orphan && aggregate.responseId === identity.responseId))
    : open;
  for (const aggregate of ambiguous) state.delete(aggregate.key);
  await Promise.all(ambiguous.map((aggregate) => flushAggregate(aggregate, "message_end_ambiguous")));
}

function aggregateSessionUpdate(projectRoot: string, meta: LlmAuditMeta, event: Record<string, unknown> | undefined): Promise<void> {
  const state = sessionStreamState();
  const anchor = getCurrentAnchor();
  const identity = messageIdentity(event);
  const timestamp = eventTimestamp(event);
  const open = matchingOpenStreams(projectRoot, meta, anchor).filter((candidate) => !candidate.orphan);
  const exact = identity.responseId ? open.filter((candidate) => candidate.responseId === identity.responseId) : [];
  let aggregate: SessionStreamAggregate | undefined;
  let orphan = false;
  if (exact.length === 1) aggregate = exact[0];
  else if (exact.length === 0 && open.length === 1) aggregate = open[0];
  else if (!identity.responseId && open.length > 1) orphan = true;
  else if (exact.length > 1) orphan = true;

  const eviction = aggregate ? Promise.resolve() : evictIfNeeded();
  if (!aggregate) aggregate = createStreamAggregate(projectRoot, meta, anchor, identity, timestamp, orphan);

  const assistant = event?.assistantMessageEvent as Record<string, unknown> | undefined;
  const assistantType = boundedIdentity(assistant?.type) ?? "unknown";
  const contentIndex = typeof assistant?.contentIndex === "number" && Number.isSafeInteger(assistant.contentIndex)
    ? assistant.contentIndex
    : undefined;
  const blockType = blockTypeAt(event, contentIndex);
  const kind = streamDeltaKind(assistantType, blockType);
  const delta = typeof assistant?.delta === "string" ? assistant.delta : "";
  incrementBoundedCount(aggregate.eventTypeCounts, "message_update", MAX_SESSION_STREAM_TYPE_KEYS);
  incrementBoundedCount(aggregate.typeCounts, assistantType, MAX_SESSION_STREAM_TYPE_KEYS);
  incrementBoundedCount(aggregate.contentBlockKindCounts, blockType ?? kind, MAX_SESSION_STREAM_TYPE_KEYS);
  if (contentIndex !== undefined && !aggregate.contentIndices.has(contentIndex)) {
    if (aggregate.contentIndices.size < MAX_SESSION_STREAM_CONTENT_INDICES) aggregate.contentIndices.add(contentIndex);
    else aggregate.contentIndexOverflowCount += 1;
  }
  updateDeltaStats(aggregate.total, assistantType, contentIndex, delta);
  updateDeltaStats(aggregate.byKind[kind], assistantType, contentIndex, delta);
  aggregate.lastTimestamp = timestamp;
  aggregate.responseId ??= identity.responseId;
  aggregate.provider ??= identity.provider;
  aggregate.model ??= identity.model;
  state.set(aggregate.key, aggregate);
  return eviction;
}

export function _resetLlmAuditStreamStateForTests(): void {
  sessionStreamState().clear();
  const global = globalThis as Record<symbol, unknown>;
  (global[SESSION_STREAM_ORDINAL_KEY] as Map<string, number> | undefined)?.clear();
}

export function _llmAuditStreamStateSizeForTests(): number {
  return sessionStreamState().size;
}

async function auditSessionEventInternal(projectRoot: string, meta: LlmAuditMeta, event: unknown): Promise<void> {
  const e = event as Record<string, unknown> | undefined;
  const eventType = typeof e?.type === "string" ? e.type : "unknown";
  if (eventType === "message_start") await startSessionStream(projectRoot, meta, e);
  else if (eventType === "message_update") {
    await aggregateSessionUpdate(projectRoot, meta, e);
    return;
  }

  const anchor = getCurrentAnchor();
  if (eventType === "message_end") await flushTerminalStreams(projectRoot, meta, anchor, messageIdentity(e), "message_end");
  else if (eventType === "agent_end") await flushTerminalStreams(projectRoot, meta, anchor, messageIdentity(e), "agent_end");

  const message = e?.message as Record<string, unknown> | undefined;
  await appendLlmAudit(projectRoot, {
    row_type: "session_event",
    module: meta.module,
    operation: meta.operation,
    api_kind: "pi.session_event",
    event_type: eventType,
    meta: controlledMetaShape(meta),
    message_shape: sessionMessageShape(e?.message),
    message_count: Array.isArray(e?.messages) ? e.messages.length : undefined,
    assistant_message_count: Array.isArray(e?.messages)
      ? e.messages.filter((item) => !!item && typeof item === "object" && (item as Record<string, unknown>).role === "assistant").length
      : undefined,
    usage: eventType === "message_end" ? controlledLlmAuditUsage(message?.usage ?? e?.usage) : undefined,
    will_retry: typeof e?.willRetry === "boolean" ? e.willRetry : undefined,
    error: controlledErrorShape(message?.errorMessage ?? e?.error ?? e?.errorMessage ?? e?.finalError),
  });
}

export async function auditSessionEvent(projectRoot: string, meta: LlmAuditMeta, event: unknown): Promise<void> {
  try {
    await auditSessionEventInternal(projectRoot, meta, event);
  } catch {
    // Audit aggregation, shaping, HMAC, and append must never affect the event caller.
  }
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
    usage: controlledLlmAuditUsage(e?.usage),
    error: controlledErrorShape(e?.error ?? e?.errorMessage ?? e?.finalError),
  });
}
