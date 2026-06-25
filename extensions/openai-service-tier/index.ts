import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { isSubAgentSession } from "../_shared/pi-internals";
import { injectOpenAIServiceTierIntoPayload, type OpenAIServiceTierInjectionResult } from "./payload";
import { FORCE_DISABLED, normalizeServiceTier, resolveOpenAIServiceTierSettings } from "./settings";

const STATUS_KEY = FOOTER_STATUS_KEYS.openaiServiceTier;

function modelProviderFromCtx(ctx: unknown): string | undefined {
  const provider = (ctx as { model?: { provider?: unknown } } | undefined)?.model?.provider;
  return typeof provider === "string" ? provider : undefined;
}

function modelApiFromCtx(ctx: unknown): string | undefined {
  const api = (ctx as { model?: { api?: unknown } } | undefined)?.model?.api;
  return typeof api === "string" ? api : undefined;
}

function modelIdFromCtx(ctx: unknown): string | undefined {
  const model = (ctx as { model?: { id?: unknown; modelId?: unknown } } | undefined)?.model;
  if (typeof model?.id === "string") return model.id;
  if (typeof model?.modelId === "string") return model.modelId;
  return undefined;
}

function setStatus(ctx: unknown, message: string | undefined): void {
  try {
    const ui = (ctx as { ui?: { setStatus?(key: string, text: string | undefined): void } } | undefined)?.ui;
    ui?.setStatus?.(STATUS_KEY, message);
  } catch {
    // Footer status is diagnostic only.
  }
}

function summarizeInjection(result: OpenAIServiceTierInjectionResult, serviceTier: string): string | undefined {
  if (result.injected) return `openai-tier:${serviceTier}`;
  switch (result.reason) {
    case "unsupported_model":
      return "openai-tier:skipped";
    case "empty_allowlist":
      return "openai-tier:inactive";
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  if (FORCE_DISABLED) return;

  pi.on("before_provider_request", (event, ctx) => {
    const settings = resolveOpenAIServiceTierSettings();
    if (!settings.enabled || FORCE_DISABLED) return event.payload;
    if (settings.disableForSubAgent && isSubAgentSession(ctx)) return event.payload;
    if (modelProviderFromCtx(ctx) !== "openai") return event.payload;

    const result = injectOpenAIServiceTierIntoPayload(event.payload, {
      modelProvider: modelProviderFromCtx(ctx),
      modelApi: modelApiFromCtx(ctx),
      modelId: modelIdFromCtx(ctx),
      serviceTier: settings.serviceTier,
      modelAllowlist: settings.modelAllowlist,
    });
    const status = summarizeInjection(result, settings.serviceTier);
    if (status) setStatus(ctx, status);
    return result.payload;
  });
}

export {
  injectOpenAIServiceTierIntoPayload,
  inferOpenAIServiceTierProvider,
} from "./payload";
export {
  normalizeServiceTier,
  resolveOpenAIServiceTierSettings,
};
