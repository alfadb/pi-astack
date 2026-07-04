import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DispatchSettings {
  maxProviderConcurrency: number;
}

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  maxProviderConcurrency: 4,
};

const MAX_PROVIDER_CONCURRENCY_LIMIT = 16;

function getPiStackSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
}

function loadPiStackSettings(): Record<string, unknown> {
  const settingsPath = getPiStackSettingsPath();
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (e: unknown) {
    try {
      if (fs.existsSync(settingsPath)) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `pi-astack: failed to parse ${settingsPath}: ${message}. Using defaults.`,
        );
      }
    } catch {
      // best-effort diagnostics only
    }
    return {};
  }
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PROVIDER_CONCURRENCY_LIMIT) return fallback;
  return n;
}

export function resolveDispatchSettings(rawSettings: unknown = {}): DispatchSettings {
  const root = (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
    ? rawSettings
    : {}) as Record<string, unknown>;
  const dispatch = (root.dispatch && typeof root.dispatch === "object" && !Array.isArray(root.dispatch)
    ? root.dispatch
    : {}) as Record<string, unknown>;
  const def = DEFAULT_DISPATCH_SETTINGS;
  return {
    maxProviderConcurrency: asPositiveInt(dispatch.maxProviderConcurrency, def.maxProviderConcurrency),
  };
}

export function readDispatchSettings(): DispatchSettings {
  return resolveDispatchSettings(loadPiStackSettings());
}
