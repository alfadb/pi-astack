import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS,
  type WorkerRunGovernorSettings,
} from "./worker-run-governor";
import {
  resolveJsonlRotationSettings,
  type JsonlRotationSettings,
} from "../_shared/rotating-jsonl";

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
  auditRotation: JsonlRotationSettings;
  taskGovernor: DispatchTaskGovernorSettings;
  workerRunGovernor: WorkerRunGovernorSettings;
}

export const DEFAULT_TASK_GOVERNOR_PROFILES: Record<DispatchTaskGovernorProfile, DispatchTaskGovernorLimits> = {
  read_only: { checkpoint: 60, auditPause: 90, freshAuth: 120, hard: 180 },
  research: { checkpoint: 80, auditPause: 120, freshAuth: 160, hard: 240 },
  implementation: { checkpoint: 120, auditPause: 180, freshAuth: 240, hard: 360 },
  mutating_default: { checkpoint: 60, auditPause: 100, hard: 120 },
};

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  maxProviderConcurrency: 4,
  auditRotation: {
    enabled: true,
    maxBytes: 64 * 1024 * 1024,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    lockTimeoutMs: 1_000,
  },
  taskGovernor: {
    enabled: true,
    profiles: DEFAULT_TASK_GOVERNOR_PROFILES,
  },
  workerRunGovernor: DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS,
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

function isPositiveBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000;
}

function isProviderRetryWindowSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 10_000;
}

function isProviderRetryWindowLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9_999;
}

function asPositiveBudget(value: unknown, fallback: number): number {
  return isPositiveBudget(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function resolveWorkerRunGovernor(raw: unknown): WorkerRunGovernorSettings {
  const rec = asRecord(raw);
  const visible = asRecord(rec.visibleText);
  const provider = asRecord(rec.providerBudgets);
  const tools = asRecord(rec.toolObservers);
  const readChurn = asRecord(tools.sameFileSmallReadChurn);
  const schemaStorm = asRecord(tools.schemaErrorStorm);
  const def = DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS;

  const rawWindowSize = provider.providerRetryWindowSize;
  const rawWindowLimit = provider.providerRetryWindowLimit;
  const rawWindowSizeValid = isProviderRetryWindowSize(rawWindowSize);
  const rawWindowLimitValid = isProviderRetryWindowLimit(rawWindowLimit);
  let providerRetryWindowSize = def.providerBudgets.providerRetryWindowSize;
  let providerRetryWindowLimit = def.providerBudgets.providerRetryWindowLimit;
  if (rawWindowSizeValid && rawWindowLimitValid) {
    if (rawWindowLimit < rawWindowSize) {
      providerRetryWindowSize = rawWindowSize;
      providerRetryWindowLimit = rawWindowLimit;
    }
  } else if (rawWindowSizeValid) {
    providerRetryWindowSize = rawWindowSize;
    providerRetryWindowLimit = Math.min(def.providerBudgets.providerRetryWindowLimit, rawWindowSize - 1);
  } else if (rawWindowLimitValid && rawWindowLimit < providerRetryWindowSize) {
    providerRetryWindowLimit = rawWindowLimit;
  }

  return {
    enabled: boolOr(rec.enabled, def.enabled),
    visibleText: {
      enabled: boolOr(visible.enabled, def.visibleText.enabled),
      abortOnRepeat: boolOr(visible.abortOnRepeat, def.visibleText.abortOnRepeat),
    },
    providerBudgets: {
      enabled: boolOr(provider.enabled, def.providerBudgets.enabled),
      providerRetryLimit: asPositiveBudget(provider.providerRetryLimit, def.providerBudgets.providerRetryLimit),
      providerRetryWindowSize,
      providerRetryWindowLimit,
      emptyVisibleRetryLimit: asPositiveBudget(provider.emptyVisibleRetryLimit, def.providerBudgets.emptyVisibleRetryLimit),
      fullOutputCapLimit: asPositiveBudget(provider.fullOutputCapLimit, def.providerBudgets.fullOutputCapLimit),
      fullOutputUsageRatio: boundedNumber(provider.fullOutputUsageRatio, def.providerBudgets.fullOutputUsageRatio, 0.5, 1),
    },
    toolObservers: {
      enabled: boolOr(tools.enabled, def.toolObservers.enabled),
      sameFileSmallReadChurn: {
        enabled: boolOr(readChurn.enabled, def.toolObservers.sameFileSmallReadChurn.enabled),
        observeAfter: asPositiveBudget(readChurn.observeAfter, def.toolObservers.sameFileSmallReadChurn.observeAfter),
        maxWindowLines: asPositiveBudget(readChurn.maxWindowLines, def.toolObservers.sameFileSmallReadChurn.maxWindowLines),
        overlapRatio: boundedNumber(readChurn.overlapRatio, def.toolObservers.sameFileSmallReadChurn.overlapRatio, 0.5, 1),
        maxTrackedPaths: asPositiveBudget(readChurn.maxTrackedPaths, def.toolObservers.sameFileSmallReadChurn.maxTrackedPaths),
      },
      schemaErrorStorm: {
        enabled: boolOr(schemaStorm.enabled, def.toolObservers.schemaErrorStorm.enabled),
        observeAfter: asPositiveBudget(schemaStorm.observeAfter, def.toolObservers.schemaErrorStorm.observeAfter),
        maxTrackedShapes: asPositiveBudget(schemaStorm.maxTrackedShapes, def.toolObservers.schemaErrorStorm.maxTrackedShapes),
      },
    },
  };
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
    auditRotation: resolveJsonlRotationSettings(dispatch.auditRotation, def.auditRotation),
    taskGovernor: resolveTaskGovernor(dispatch.taskGovernor),
    workerRunGovernor: resolveWorkerRunGovernor(dispatch.workerRunGovernor),
  };
}

export function readDispatchSettings(): DispatchSettings {
  return resolveDispatchSettings(loadPiStackSettings());
}
