import OpenAI from "openai";
import { convertResponsesMessages } from "./openai-responses-shared-loader.mjs";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CompactedResponse, ResponseCompactParams, ResponseCompactionItemParam, ResponseInputItem } from "openai/resources/responses/responses.js";
import type { RemoteOpenAICompactionSettings } from "./settings";

export const REMOTE_OPENAI_COMPACTION_MARKER_PREFIX = "PI_ASTACK_OPENAI_REMOTE_COMPACTION_V1:";

const OPENAI_TOOL_CALL_PROVIDERS = new Set<string>(["openai", "openai-codex", "opencode"]);

export interface RemoteOpenAIModelLike extends Partial<Model<Api>> {
  id?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface RemoteOpenAIAuthLike {
  apiKey?: string;
  headers?: Record<string, string>;
}

type RemoteOpenAICompactResponse = CompactedResponse | string;

export type RemoteOpenAICompactFn = (
  body: ResponseCompactParams,
  options: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
) => Promise<RemoteOpenAICompactResponse>;

type RemoteOpenAICompactionItemType = "compaction" | "compaction_summary";

type RemoteOpenAICompactionItem = Omit<ResponseCompactionItemParam, "type"> & {
  type: RemoteOpenAICompactionItemType;
};

export interface RemoteOpenAICompactionDetails {
  kind: "openai_responses_compaction";
  version: 1;
  provider: string;
  model: string;
  api: string;
  item: RemoteOpenAICompactionItem;
}

interface RemoteOpenAICompactionMarkerPayload extends RemoteOpenAICompactionDetails {
  fallbackText?: string;
}

export interface RemoteOpenAICompactionAttemptOptions {
  event: SessionBeforeCompactEvent;
  model: RemoteOpenAIModelLike | undefined;
  auth: RemoteOpenAIAuthLike;
  settings: RemoteOpenAICompactionSettings;
  sessionId?: string;
  systemPrompt?: string;
  compactFn?: RemoteOpenAICompactFn;
}

export interface RemoteOpenAICompactionErrorShape {
  name?: string;
  message: string;
  keys?: string[];
  status?: unknown;
  code?: unknown;
  type?: unknown;
}

export type RemoteOpenAICompactionAttempt =
  | { outcome: "completed"; compaction: CompactionResult<RemoteOpenAICompactionDetails>; elapsedMs: number; inputItems: number; compactedItemId?: string | null; response: unknown }
  | { outcome: "skipped"; reason: "disabled" | "empty_allowlist" | "model_unavailable" | "unsupported_provider" | "unsupported_api" | "unsupported_model" | "missing_base_url" | "missing_api_key" }
  | { outcome: "failed"; reason: "invalid_response"; error: string; elapsedMs: number; response: unknown }
  | { outcome: "failed"; reason: "remote_error"; error: string; elapsedMs: number; errorShape: RemoteOpenAICompactionErrorShape };

export interface RemoteOpenAIInjectionResult {
  payload: unknown;
  injected: boolean;
  reason:
    | "injected"
    | "not_object"
    | "unsupported_provider"
    | "unsupported_api"
    | "unsupported_model"
    | "unsupported_payload"
    | "marker_not_found"
    | "marker_invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modelRef(model: RemoteOpenAIModelLike | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

function isSupportedProvider(provider: unknown): boolean {
  return provider === "openai" || provider === "openai-codex";
}

function isSupportedApi(api: unknown): boolean {
  return api === "openai-responses" || api === "openai-codex-responses";
}

function isAllowlisted(model: RemoteOpenAIModelLike | undefined, settings: RemoteOpenAICompactionSettings): boolean {
  const ref = modelRef(model);
  return !!ref && settings.modelAllowlist.includes(ref);
}

function compactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

function compactErrorShape(error: unknown): RemoteOpenAICompactionErrorShape {
  const message = compactErrorMessage(error);
  const shape: RemoteOpenAICompactionErrorShape = { message };
  if (error instanceof Error) shape.name = error.name;
  if (isRecord(error)) {
    shape.keys = Object.keys(error).sort();
    for (const key of ["status", "code", "type"] as const) {
      const value = error[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        shape[key] = value;
      }
    }
  }
  return shape;
}

function buildCompactContext(event: SessionBeforeCompactEvent, systemPrompt?: string): Context {
  const messages = [
    ...(event.preparation.previousSummary
      ? [{ role: "compactionSummary", summary: event.preparation.previousSummary, tokensBefore: event.preparation.tokensBefore, timestamp: Date.now() }]
      : []),
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ];
  return {
    systemPrompt: systemPrompt || undefined,
    messages: convertToLlm(messages as never) as Context["messages"],
  };
}

function usesInstructionsForSystemPrompt(model: RemoteOpenAIModelLike): boolean {
  return model.api === "openai-codex-responses";
}

export function compactInputMessages(event: SessionBeforeCompactEvent, model: RemoteOpenAIModelLike, systemPrompt?: string): ResponseInputItem[] {
  const context = buildCompactContext(event, systemPrompt);
  return convertResponsesMessages(
    model as Model<Api>,
    context,
    OPENAI_TOOL_CALL_PROVIDERS,
    usesInstructionsForSystemPrompt(model) ? { includeSystemPrompt: false } : undefined,
  ) as ResponseInputItem[];
}

function buildCompactBody(
  event: SessionBeforeCompactEvent,
  model: RemoteOpenAIModelLike & { id: string },
  systemPrompt: string | undefined,
  sessionId: string | undefined,
): { body: ResponseCompactParams; inputItems: number } {
  const input = compactInputMessages(event, model, systemPrompt);
  const body: ResponseCompactParams = {
    model: model.id,
    input,
    prompt_cache_key: sessionId || undefined,
  };
  if (usesInstructionsForSystemPrompt(model)) {
    body.instructions = systemPrompt || "You are a helpful assistant.";
  }
  return { body, inputItems: input.length };
}

function buildFallbackText(event: SessionBeforeCompactEvent, item: RemoteOpenAICompactionItem): string {
  const lines = [
    "OpenAI remote compaction is available for this history segment.",
    `Compaction item id: ${item.id ?? "(none)"}`,
    "This text is a fallback marker; compatible OpenAI Responses requests replace it with the encrypted compaction item before the provider call.",
  ];
  if (event.preparation.isSplitTurn && event.preparation.turnPrefixMessages.length > 0) {
    lines.push(
      "",
      "The compaction cut split the current turn. The encrypted item contains the discarded turn prefix; the retained suffix follows this summary in the session.",
    );
  }
  return lines.join("\n");
}

export function encodeRemoteOpenAICompactionMarker(payload: RemoteOpenAICompactionMarkerPayload): string {
  return `${REMOTE_OPENAI_COMPACTION_MARKER_PREFIX}${JSON.stringify(payload)}`;
}

function isRemoteOpenAICompactionItemType(type: unknown): type is RemoteOpenAICompactionItemType {
  return type === "compaction" || type === "compaction_summary";
}

function normalizeRemoteOpenAICompactResponse(response: unknown): unknown {
  if (typeof response !== "string") return response;
  const trimmed = response.trim();
  if (!trimmed) return response;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return response;
  }
}

function compactionItemFromResponse(response: unknown): RemoteOpenAICompactionItem | undefined {
  const parsed = normalizeRemoteOpenAICompactResponse(response);
  if (!isRecord(parsed)) return undefined;
  const output = parsed.output;
  if (!Array.isArray(output)) return undefined;
  const item = output.find((candidate) => isRecord(candidate) && isRemoteOpenAICompactionItemType(candidate.type));
  if (!isRecord(item) || !isRemoteOpenAICompactionItemType(item.type) || typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    return undefined;
  }
  return {
    type: item.type,
    encrypted_content: item.encrypted_content,
    id: typeof item.id === "string" ? item.id : null,
  };
}

export function parseRemoteOpenAICompactionMarker(summary: string): RemoteOpenAICompactionMarkerPayload | undefined {
  if (!summary.startsWith(REMOTE_OPENAI_COMPACTION_MARKER_PREFIX)) return undefined;
  const raw = summary.slice(REMOTE_OPENAI_COMPACTION_MARKER_PREFIX.length);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.kind !== "openai_responses_compaction" || parsed.version !== 1) return undefined;
    if (!isRecord(parsed.item) || !isRemoteOpenAICompactionItemType(parsed.item.type) || typeof parsed.item.encrypted_content !== "string" || parsed.item.encrypted_content.length === 0) return undefined;
    if (parsed.item.id !== undefined && parsed.item.id !== null && typeof parsed.item.id !== "string") return undefined;
    if (typeof parsed.provider !== "string" || typeof parsed.model !== "string" || typeof parsed.api !== "string") return undefined;
    return parsed as unknown as RemoteOpenAICompactionMarkerPayload;
  } catch {
    return undefined;
  }
}

export async function tryRunRemoteOpenAICompaction(options: RemoteOpenAICompactionAttemptOptions): Promise<RemoteOpenAICompactionAttempt> {
  const { event, model, auth, settings, sessionId, systemPrompt, compactFn } = options;
  if (!settings.enabled) return { outcome: "skipped", reason: "disabled" };
  if (settings.modelAllowlist.length === 0) return { outcome: "skipped", reason: "empty_allowlist" };
  if (!model?.id || !model.provider || !model.api) return { outcome: "skipped", reason: "model_unavailable" };
  if (!isSupportedProvider(model.provider)) return { outcome: "skipped", reason: "unsupported_provider" };
  if (!isSupportedApi(model.api)) return { outcome: "skipped", reason: "unsupported_api" };
  if (!isAllowlisted(model, settings)) return { outcome: "skipped", reason: "unsupported_model" };
  if (!model.baseUrl) return { outcome: "skipped", reason: "missing_base_url" };
  if (!auth.apiKey) return { outcome: "skipped", reason: "missing_api_key" };
  const activeModel = model as RemoteOpenAIModelLike & { id: string; provider: string; api: string; baseUrl: string };

  const started = Date.now();
  try {
    const { body, inputItems } = buildCompactBody(event, activeModel, systemPrompt, sessionId);
    const headers = { ...(activeModel.headers ?? {}), ...(auth.headers ?? {}) };
    if (sessionId) {
      headers.session_id = sessionId;
      headers["x-client-request-id"] = sessionId;
    }
    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: activeModel.baseUrl,
      defaultHeaders: headers,
      dangerouslyAllowBrowser: true,
    });
    const compact = compactFn ?? client.responses.compact.bind(client.responses);
    const rawResponse = await compact(body, {
      signal: event.signal,
      timeout: settings.timeoutMs,
      maxRetries: 0,
    });
    const response = normalizeRemoteOpenAICompactResponse(rawResponse);
    const item = compactionItemFromResponse(response);
    if (!item) {
      return { outcome: "failed", reason: "invalid_response", error: "responses.compact did not return a valid compaction item", elapsedMs: Date.now() - started, response };
    }
    const details: RemoteOpenAICompactionDetails = {
      kind: "openai_responses_compaction",
      version: 1,
      provider: activeModel.provider,
      model: activeModel.id,
      api: activeModel.api,
      item,
    };
    const summary = encodeRemoteOpenAICompactionMarker({
      ...details,
      fallbackText: buildFallbackText(event, details.item),
    });
    return {
      outcome: "completed",
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      },
      elapsedMs: Date.now() - started,
      inputItems,
      compactedItemId: details.item.id,
      response,
    };
  } catch (error) {
    return { outcome: "failed", reason: "remote_error", error: compactErrorMessage(error), elapsedMs: Date.now() - started, errorShape: compactErrorShape(error) };
  }
}

function modelRefFromCtx(ctx: unknown, payload: Record<string, unknown>): string | undefined {
  const model = (ctx as { model?: { provider?: unknown; id?: unknown; modelId?: unknown; api?: unknown } } | undefined)?.model;
  const provider = typeof model?.provider === "string" ? model.provider : "";
  const id = typeof model?.id === "string" ? model.id : typeof model?.modelId === "string" ? model.modelId : typeof payload.model === "string" ? payload.model : "";
  return provider && id ? `${provider}/${id}` : undefined;
}

function modelProviderFromCtx(ctx: unknown): string | undefined {
  const provider = (ctx as { model?: { provider?: unknown } } | undefined)?.model?.provider;
  return typeof provider === "string" ? provider : undefined;
}

function modelApiFromCtx(ctx: unknown): string | undefined {
  const api = (ctx as { model?: { api?: unknown } } | undefined)?.model?.api;
  return typeof api === "string" ? api : undefined;
}

function textFromInputItem(item: unknown): string | undefined {
  if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content)) return undefined;
  const first = item.content[0];
  if (!isRecord(first) || first.type !== "input_text" || typeof first.text !== "string") return undefined;
  return first.text;
}

function replaceMarkerInputItems(input: unknown[]): { input: unknown[]; injected: boolean; invalid: boolean } {
  let injected = false;
  let invalid = false;
  const next = input.map((item) => {
    const text = textFromInputItem(item);
    if (!text) return item;
    const start = text.indexOf(REMOTE_OPENAI_COMPACTION_MARKER_PREFIX);
    if (start < 0) return item;
    const end = text.indexOf("\n</summary>", start);
    const markerText = end >= 0 ? text.slice(start, end) : text.slice(start).trim();
    const marker = parseRemoteOpenAICompactionMarker(markerText);
    if (!marker) {
      invalid = true;
      return item;
    }
    injected = true;
    return marker.item;
  });
  return { input: next, injected, invalid };
}

export function injectRemoteOpenAICompactionIntoPayload(
  payload: unknown,
  ctx: unknown,
  settings: RemoteOpenAICompactionSettings,
): RemoteOpenAIInjectionResult {
  if (!isRecord(payload)) return { payload, injected: false, reason: "not_object" };
  const provider = modelProviderFromCtx(ctx);
  if (provider !== undefined && !isSupportedProvider(provider)) return { payload, injected: false, reason: "unsupported_provider" };
  const api = modelApiFromCtx(ctx);
  if (api !== undefined && !isSupportedApi(api)) return { payload, injected: false, reason: "unsupported_api" };
  const ref = modelRefFromCtx(ctx, payload);
  if (!ref || !settings.modelAllowlist.includes(ref)) return { payload, injected: false, reason: "unsupported_model" };
  if (!Array.isArray(payload.input)) return { payload, injected: false, reason: "unsupported_payload" };
  const result = replaceMarkerInputItems(payload.input);
  if (result.invalid) return { payload, injected: false, reason: "marker_invalid" };
  if (!result.injected) return { payload, injected: false, reason: "marker_not_found" };
  return {
    payload: { ...payload, input: result.input },
    injected: true,
    reason: "injected",
  };
}

export const __TEST = {
  isSupportedProvider,
  isSupportedApi,
  compactInputMessages,
  buildCompactBody,
  compactionItemFromResponse,
  normalizeRemoteOpenAICompactResponse,
  compactErrorShape,
  encodeRemoteOpenAICompactionMarker,
  parseRemoteOpenAICompactionMarker,
  injectRemoteOpenAICompactionIntoPayload,
};
