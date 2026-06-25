import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean } from "../memory/settings";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export type OpenAIServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

export interface OpenAIServiceTierSettings {
  enabled: boolean;
  disableForSubAgent: boolean;
  serviceTier: OpenAIServiceTier;
  modelAllowlist: string[];
}

export const DEFAULT_OPENAI_SERVICE_TIER_SETTINGS: OpenAIServiceTierSettings = {
  enabled: false,
  disableForSubAgent: true,
  serviceTier: "priority",
  modelAllowlist: [],
};

export const FORCE_DISABLED: boolean = (() => {
  const raw = process.env.PI_ASTACK_DISABLE_OPENAI_SERVICE_TIER;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    try {
      if (fsSync.existsSync(PI_STACK_SETTINGS_PATH)) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`,
        );
      }
    } catch {
      // ignore
    }
    return {};
  }
}

function asStringList(value: unknown, fallback: string[]): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : fallback;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function normalizeServiceTier(value: unknown, fallback: OpenAIServiceTier): OpenAIServiceTier {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "fast":
    case "priority":
      return "priority";
    case "auto":
    case "default":
    case "flex":
    case "scale":
      return raw;
    default:
      return fallback;
  }
}

export function resolveOpenAIServiceTierSettings(): OpenAIServiceTierSettings {
  const raw = loadPiStackSettings();
  const block = (raw.openaiServiceTier ?? {}) as Record<string, unknown>;
  const def = DEFAULT_OPENAI_SERVICE_TIER_SETTINGS;
  return {
    enabled: asBoolean(block.enabled, def.enabled),
    disableForSubAgent: asBoolean(block.disableForSubAgent, def.disableForSubAgent),
    serviceTier: normalizeServiceTier(block.serviceTier, def.serviceTier),
    modelAllowlist: asStringList(block.modelAllowlist, def.modelAllowlist),
  };
}
