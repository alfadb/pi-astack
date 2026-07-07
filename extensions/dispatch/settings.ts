import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type DispatchTaskGovernorProfile = "read_only" | "research" | "implementation" | "mutating_default";

export type DispatchTaskGovernorStage = "checkpoint" | "audit_pause" | "fresh_auth" | "hard";

export interface DispatchTaskGovernorLimits {
  checkpoint: number;
  auditPause: number;
  freshAuth?: number;
  hard: number;
}

export interface DispatchTaskGovernorSettings {
  enabled: boolean;
  profiles: Record<DispatchTaskGovernorProfile, DispatchTaskGovernorLimits>;
}

export interface DispatchSettings {
  maxProviderConcurrency: number;
  taskGovernor: DispatchTaskGovernorSettings;
}

export const DEFAULT_TASK_GOVERNOR_PROFILES: Record<DispatchTaskGovernorProfile, DispatchTaskGovernorLimits> = {
  read_only: { checkpoint: 60, auditPause: 90, freshAuth: 120, hard: 180 },
  research: { checkpoint: 80, auditPause: 120, freshAuth: 160, hard: 240 },
  implementation: { checkpoint: 120, auditPause: 180, freshAuth: 240, hard: 360 },
  mutating_default: { checkpoint: 60, auditPause: 100, hard: 120 },
};

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  maxProviderConcurrency: 4,
  taskGovernor: {
    enabled: true,
    profiles: DEFAULT_TASK_GOVERNOR_PROFILES,
  },
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

function asPositiveBudget(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return fallback;
  return n;
}

function resolveTaskGovernor(raw: unknown): DispatchTaskGovernorSettings {
  const rec = (raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  const def = DEFAULT_DISPATCH_SETTINGS.taskGovernor;
  const profilesRaw = (rec.profiles && typeof rec.profiles === "object" && !Array.isArray(rec.profiles)
    ? rec.profiles
    : {}) as Record<string, unknown>;
  const profiles = { ...def.profiles } as Record<DispatchTaskGovernorProfile, DispatchTaskGovernorLimits>;
  for (const profile of Object.keys(profiles) as DispatchTaskGovernorProfile[]) {
    const rawLimits = (profilesRaw[profile] && typeof profilesRaw[profile] === "object" && !Array.isArray(profilesRaw[profile])
      ? profilesRaw[profile]
      : {}) as Record<string, unknown>;
    const fallback = def.profiles[profile];
    profiles[profile] = {
      checkpoint: asPositiveBudget(rawLimits.checkpoint, fallback.checkpoint),
      auditPause: asPositiveBudget(rawLimits.auditPause, fallback.auditPause),
      ...(fallback.freshAuth !== undefined || rawLimits.freshAuth !== undefined
        ? { freshAuth: asPositiveBudget(rawLimits.freshAuth, fallback.freshAuth ?? fallback.hard) }
        : {}),
      hard: asPositiveBudget(rawLimits.hard, fallback.hard),
    };
  }
  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : def.enabled,
    profiles,
  };
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
    taskGovernor: resolveTaskGovernor(dispatch.taskGovernor),
  };
}

export function readDispatchSettings(): DispatchSettings {
  return resolveDispatchSettings(loadPiStackSettings());
}
