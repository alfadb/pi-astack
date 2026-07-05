import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureProjectGitignoredOnce, formatLocalIsoTimestamp, piAstackModuleDir } from "./runtime";
import { getCurrentAnchor, spreadAnchor } from "./causal-anchor";

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

function withAuditBase(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: formatLocalIsoTimestamp(),
    ...spreadAnchor(getCurrentAnchor()),
    ...row,
  };
}

export async function appendLlmAudit(projectRoot: string, row: Record<string, unknown>): Promise<void> {
  let line: string;
  try {
    line = safeJson(withAuditBase(row)) + "\n";
  } catch {
    return;
  }

  try {
    const file = auditPath(projectRoot);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try { await fs.chmod(dir, 0o700); } catch { /* best-effort */ }
    await fs.appendFile(file, line, { encoding: "utf-8", mode: 0o600 });
    try { await fs.chmod(file, 0o600); } catch { /* best-effort */ }
    void ensureProjectGitignoredOnce(projectRoot).catch(() => { /* best-effort */ });
  } catch {
    /* audit must never affect the caller */
  }
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
  const base = {
    call_id: callId,
    module: meta.module,
    operation: meta.operation,
    api_kind: "pi-ai.streamSimple",
    model_ref: modelRef,
    model_id: typeof meta.model_id === "string" ? meta.model_id : modelIdFrom(model, modelRef),
    meta,
  };

  await appendLlmAudit(projectRoot, {
    ...base,
    row_type: "start",
    request: { opts, config },
  });

  try {
    const stream = piAi.streamSimple(model, opts, config);
    const finalMessage = await stream.result() as StreamSimpleResult<TPiAi>;
    await appendLlmAudit(projectRoot, {
      ...base,
      row_type: "end",
      duration_ms: Date.now() - started,
      final_message: finalMessage,
      usage: (finalMessage as any)?.usage,
      stopReason: (finalMessage as any)?.stopReason,
    });
    return finalMessage;
  } catch (error) {
    await appendLlmAudit(projectRoot, {
      ...base,
      row_type: "error",
      duration_ms: Date.now() - started,
      error,
    });
    throw error;
  }
}

export function auditSessionEvent(projectRoot: string, meta: LlmAuditMeta, event: unknown): void {
  const e = event as Record<string, unknown> | undefined;
  void appendLlmAudit(projectRoot, {
    row_type: "session_event",
    module: meta.module,
    operation: meta.operation,
    api_kind: "pi.session_event",
    event_type: typeof e?.type === "string" ? e.type : "unknown",
    meta,
    event,
    message: e?.message,
    assistantMessageEvent: e?.assistantMessageEvent,
    usage: (e?.message as any)?.usage ?? e?.usage,
    error: e?.error ?? e?.errorMessage ?? e?.finalError,
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
    meta,
    model: modelInfoFromContext(ctx),
    request_payload: e?.payload,
    response_status: e?.status,
    response_headers: e?.headers,
    event,
  });
}
