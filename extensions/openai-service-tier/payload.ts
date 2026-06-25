import type { OpenAIServiceTier } from "./settings";

export type OpenAIServiceTierProviderKind =
  | "openai-responses"
  | "openai-completions"
  | "openai-codex-responses"
  | "unknown";

export interface OpenAIServiceTierInjectionOptions {
  modelProvider?: unknown;
  modelApi?: unknown;
  modelId?: unknown;
  serviceTier: OpenAIServiceTier;
  modelAllowlist: readonly string[];
}

export interface OpenAIServiceTierInjectionResult {
  payload: unknown;
  provider: OpenAIServiceTierProviderKind;
  injected: boolean;
  reason:
    | "injected"
    | "not_object"
    | "unsupported_provider"
    | "unsupported_model"
    | "empty_allowlist";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function providerFromModelApi(api: unknown): OpenAIServiceTierProviderKind {
  if (typeof api !== "string") return "unknown";
  switch (api) {
    case "openai-responses":
    case "openai-completions":
    case "openai-codex-responses":
      return api;
    default:
      return "unknown";
  }
}

function providerFromPayload(payload: Record<string, unknown>): OpenAIServiceTierProviderKind {
  if (Array.isArray(payload.input)) return "openai-responses";
  if (Array.isArray(payload.messages)) return "openai-completions";
  return "unknown";
}

function modelRefFromOptions(options: OpenAIServiceTierInjectionOptions, payload: Record<string, unknown>): string | undefined {
  const provider = typeof options.modelProvider === "string" ? options.modelProvider : "";
  const id = typeof options.modelId === "string" ? options.modelId : "";
  if (provider && id) return `${provider}/${id}`;
  if (typeof payload.model === "string" && payload.model.trim()) {
    return provider ? `${provider}/${payload.model}` : payload.model;
  }
  return undefined;
}

function allowlistMatches(modelRef: string | undefined, modelAllowlist: readonly string[]): boolean {
  if (modelAllowlist.length === 0) return false;
  if (!modelRef) return false;
  return modelAllowlist.includes(modelRef);
}

export function inferOpenAIServiceTierProvider(
  payload: unknown,
  modelApi?: unknown,
): OpenAIServiceTierProviderKind {
  const fromApi = providerFromModelApi(modelApi);
  if (fromApi !== "unknown") return fromApi;
  if (!isRecord(payload)) return "unknown";
  return providerFromPayload(payload);
}

export function injectOpenAIServiceTierIntoPayload(
  payload: unknown,
  options: OpenAIServiceTierInjectionOptions,
): OpenAIServiceTierInjectionResult {
  if (!isRecord(payload)) {
    return { payload, provider: "unknown", injected: false, reason: "not_object" };
  }

  if (typeof options.modelProvider === "string" && options.modelProvider !== "openai") {
    return { payload, provider: "unknown", injected: false, reason: "unsupported_provider" };
  }

  const provider = inferOpenAIServiceTierProvider(payload, options.modelApi);
  if (provider === "unknown") {
    return { payload, provider, injected: false, reason: "unsupported_provider" };
  }

  if (options.modelAllowlist.length === 0) {
    return { payload, provider, injected: false, reason: "empty_allowlist" };
  }

  const modelRef = modelRefFromOptions(options, payload);
  if (!allowlistMatches(modelRef, options.modelAllowlist)) {
    return { payload, provider, injected: false, reason: "unsupported_model" };
  }

  return {
    payload: { ...payload, service_tier: options.serviceTier },
    provider,
    injected: true,
    reason: "injected",
  };
}

export const __TEST = {
  isRecord,
  inferOpenAIServiceTierProvider,
  injectOpenAIServiceTierIntoPayload,
};
