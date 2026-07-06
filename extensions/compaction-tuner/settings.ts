import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

/**
 * Compaction-tuner checks both turn-boundary and `agent_end`. When
 * enabled, it reads runtime usage and triggers compaction once consumed
 * context crosses the effective threshold. The user-facing
 * `thresholdPercent` remains a configurable upper bound; by default a
 * dynamic layer lowers it for small/economic context budgets so a single
 * tool-result batch still has headroom before the next provider request.
 *
 * Pi's built-in threshold (default reserveTokens=16384) still acts as a
 * last-resort safety net: at 1M-context our dynamic trigger fires around
 * 70% while pi's safety net only fires at ~983k.
 */
export interface DynamicThresholdSettings {
  enabled: boolean;
  /** Context windows <= this are treated as small/easy-to-overflow. */
  smallWindowMaxTokens: number;
  /** Max threshold for small/economic windows (e.g. 272k GPT-5.5 routes). */
  smallWindowThresholdPercent: number;
  /** Context windows <= this are treated as medium (e.g. 400k Copilot routes). */
  mediumWindowMaxTokens: number;
  /** Max threshold for medium windows. */
  mediumWindowThresholdPercent: number;
  /** Context windows <= this are treated as large 1M-class windows. */
  largeWindowMaxTokens: number;
  /** Max threshold for 1M-class windows. */
  largeWindowThresholdPercent: number;
  /** Absolute headroom floor; threshold is also capped by budget - this value. */
  minHeadroomTokens: number;
  /** Optional provider/model → effective budget overrides. */
  modelEffectiveContextBudgets: Record<string, number>;
}

export interface ModelCompactionPolicySettings {
  /** Optional provider/model-specific effective budget override. */
  effectiveContextBudget?: number;
  /** Optional provider/model-specific trigger percentage. */
  thresholdPercent?: number;
  /** Optional provider/model-specific absolute headroom floor. */
  minHeadroomTokens?: number;
  /** Optional provider/model-specific hysteresis margin. */
  rearmMarginPercent?: number;
}

export type RemoteOpenAICompactionPayloadAuditMode = "off" | "shape" | "full";

export interface RemoteOpenAICompactionSettings {
  enabled: boolean;
  /** Empty allowlist disables remote compaction; entries are provider/model refs. */
  modelAllowlist: string[];
  /** HTTP timeout for /responses/compact. */
  timeoutMs: number;
  /** Local sidecar audit mode for parsed /responses/compact payloads. */
  auditPayload: RemoteOpenAICompactionPayloadAuditMode;
}

export interface CompactionTunerSettings {
  enabled: boolean;
  /** User-configured maximum context-usage percentage to trigger compaction (0-100). */
  thresholdPercent: number;
  /** Optional provider/model → compaction policy overrides. */
  modelPolicies: Record<string, ModelCompactionPolicySettings>;
  /** Optional custom instructions passed to the compaction LLM. */
  customInstructions: string;
  /**
   * Optional ordered model refs (provider/model) for custom compaction
   * summarization. Empty default intentionally preserves pi core behavior:
   * summary generation uses the current main-session model.
   */
  summaryModels: string[];
  /** Optional OpenAI Responses remote compaction path. */
  remoteOpenAICompaction: RemoteOpenAICompactionSettings;
  /**
   * Hysteresis margin (percentage points) below threshold that we must
   * dip to before re-arming. After triggering at e.g. 75%, we won't
   * re-trigger until usage drops below 75 - rearmMarginPercent and rises
   * back above 75. Keeps the trigger from firing repeatedly while a long
   * agent loop hovers near the boundary.
   */
  rearmMarginPercent: number;
  /**
   * Notify the user via `ctx.ui.notify` when triggering. Audit row is
   * always written regardless of this flag.
   */
  notifyOnTrigger: boolean;
  /** Dynamic threshold policy layered under thresholdPercent. */
  dynamicThreshold: DynamicThresholdSettings;
}

export const DEFAULT_DYNAMIC_THRESHOLD_SETTINGS: DynamicThresholdSettings = {
  enabled: true,
  smallWindowMaxTokens: 300_000,
  smallWindowThresholdPercent: 60,
  mediumWindowMaxTokens: 450_000,
  mediumWindowThresholdPercent: 65,
  largeWindowMaxTokens: 1_100_000,
  largeWindowThresholdPercent: 70,
  minHeadroomTokens: 64_000,
  // No model hardcoded in code. Configure per-model budgets in
  // pi-astack-settings.json → compactionTuner.dynamicThreshold.modelEffectiveContextBudgets.
  modelEffectiveContextBudgets: {},
};

export const DEFAULT_COMPACTION_TUNER_SETTINGS: CompactionTunerSettings = {
  enabled: false,
  thresholdPercent: 75,
  // No model hardcoded in code. Configure per-model compaction policy in
  // pi-astack-settings.json → compactionTuner.modelPolicies.
  modelPolicies: {},
  customInstructions: "",
  summaryModels: [],
  remoteOpenAICompaction: {
    enabled: false,
    modelAllowlist: [],
    timeoutMs: 120_000,
    auditPayload: "off",
  },
  rearmMarginPercent: 5,
  notifyOnTrigger: true,
  dynamicThreshold: DEFAULT_DYNAMIC_THRESHOLD_SETTINGS,
};

const MIN_THRESHOLD = 10;
const MAX_THRESHOLD = 95;

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_COMPACTION_TUNER_SETTINGS.thresholdPercent;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, n));
}

function clampThresholdWithFallback(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, n));
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const n = asNumber(value, fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asNonNegativeNumber(value: unknown, fallback: number): number {
  const n = asNumber(value, fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asTokenBudgetMap(value: unknown, fallback: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...fallback };
  if (!isPlainObject(value)) return out;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) continue;
    const n = asNumber(rawValue, Number.NaN);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

function resolveModelPolicies(value: unknown, fallback: Record<string, ModelCompactionPolicySettings>): Record<string, ModelCompactionPolicySettings> {
  const out: Record<string, ModelCompactionPolicySettings> = isPlainObject(value) ? {} : { ...fallback };
  if (!isPlainObject(value)) return out;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || !isPlainObject(rawValue)) continue;
    const policy: ModelCompactionPolicySettings = {};
    const effectiveContextBudget = asNumber(rawValue.effectiveContextBudget, Number.NaN);
    if (Number.isFinite(effectiveContextBudget) && effectiveContextBudget > 0) {
      policy.effectiveContextBudget = effectiveContextBudget;
    }
    if (Object.prototype.hasOwnProperty.call(rawValue, "thresholdPercent")) {
      policy.thresholdPercent = clampThresholdWithFallback(
        asNumber(rawValue.thresholdPercent, Number.NaN),
        DEFAULT_COMPACTION_TUNER_SETTINGS.thresholdPercent,
      );
    }
    const minHeadroomTokens = asNumber(rawValue.minHeadroomTokens, Number.NaN);
    if (Number.isFinite(minHeadroomTokens) && minHeadroomTokens >= 0) {
      policy.minHeadroomTokens = minHeadroomTokens;
    }
    const rearmMarginPercent = asNumber(rawValue.rearmMarginPercent, Number.NaN);
    if (Number.isFinite(rearmMarginPercent) && rearmMarginPercent >= 0) {
      policy.rearmMarginPercent = Math.min(90, rearmMarginPercent);
    }
    out[key] = policy;
  }
  return out;
}

function resolveDynamicThresholdSettings(value: unknown): DynamicThresholdSettings {
  const raw = isPlainObject(value) ? value : {};
  const def = DEFAULT_DYNAMIC_THRESHOLD_SETTINGS;
  const smallWindowMaxTokens = asPositiveNumber(raw.smallWindowMaxTokens, def.smallWindowMaxTokens);
  const mediumWindowMaxTokens = Math.max(
    smallWindowMaxTokens,
    asPositiveNumber(raw.mediumWindowMaxTokens, def.mediumWindowMaxTokens),
  );
  const largeWindowMaxTokens = Math.max(
    mediumWindowMaxTokens,
    asPositiveNumber(raw.largeWindowMaxTokens, def.largeWindowMaxTokens),
  );
  return {
    enabled: asBoolean(raw.enabled, def.enabled),
    smallWindowMaxTokens,
    smallWindowThresholdPercent: clampThresholdWithFallback(
      asNumber(raw.smallWindowThresholdPercent, def.smallWindowThresholdPercent),
      def.smallWindowThresholdPercent,
    ),
    mediumWindowMaxTokens,
    mediumWindowThresholdPercent: clampThresholdWithFallback(
      asNumber(raw.mediumWindowThresholdPercent, def.mediumWindowThresholdPercent),
      def.mediumWindowThresholdPercent,
    ),
    largeWindowMaxTokens,
    largeWindowThresholdPercent: clampThresholdWithFallback(
      asNumber(raw.largeWindowThresholdPercent, def.largeWindowThresholdPercent),
      def.largeWindowThresholdPercent,
    ),
    minHeadroomTokens: asNonNegativeNumber(raw.minHeadroomTokens, def.minHeadroomTokens),
    modelEffectiveContextBudgets: asTokenBudgetMap(
      raw.modelEffectiveContextBudgets,
      isPlainObject(raw.modelEffectiveContextBudgets) ? {} : def.modelEffectiveContextBudgets,
    ),
  };
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => typeof v === "string" ? v.trim() : "")
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function asRemoteOpenAICompactionPayloadAuditMode(value: unknown, fallback: RemoteOpenAICompactionPayloadAuditMode): RemoteOpenAICompactionPayloadAuditMode {
  return value === "off" || value === "shape" || value === "full" ? value : fallback;
}

function resolveRemoteOpenAICompactionSettings(value: unknown): RemoteOpenAICompactionSettings {
  const raw = isPlainObject(value) ? value : {};
  const def = DEFAULT_COMPACTION_TUNER_SETTINGS.remoteOpenAICompaction;
  return {
    enabled: asBoolean(raw.enabled, def.enabled),
    modelAllowlist: dedupeStrings(asStringList(raw.modelAllowlist)),
    timeoutMs: asPositiveNumber(raw.timeoutMs, def.timeoutMs),
    auditPayload: asRemoteOpenAICompactionPayloadAuditMode(raw.auditPayload, def.auditPayload),
  };
}

export function resolveCompactionTunerSettings(): CompactionTunerSettings {
  const raw = loadPiStackSettings();
  const block = (raw.compactionTuner ?? {}) as Record<string, unknown>;
  const def = DEFAULT_COMPACTION_TUNER_SETTINGS;
  const customInstructions = typeof block.customInstructions === "string"
    ? block.customInstructions
    : def.customInstructions;
  const hasSummaryModelsKey = Object.prototype.hasOwnProperty.call(block, "summaryModels");
  const explicitSummaryModels = asStringList(block.summaryModels);
  const legacySummaryModel = asStringList(block.summaryModel);
  const summaryModels = dedupeStrings(
    hasSummaryModelsKey ? explicitSummaryModels : legacySummaryModel,
  );
  return {
    enabled: asBoolean(block.enabled, def.enabled),
    thresholdPercent: clampThreshold(asNumber(block.thresholdPercent, def.thresholdPercent)),
    modelPolicies: resolveModelPolicies(block.modelPolicies, def.modelPolicies),
    customInstructions,
    summaryModels,
    remoteOpenAICompaction: resolveRemoteOpenAICompactionSettings(block.remoteOpenAICompaction),
    rearmMarginPercent: Math.min(
      90,
      Math.max(0, asNumber(block.rearmMarginPercent, def.rearmMarginPercent)),
    ),
    notifyOnTrigger: asBoolean(block.notifyOnTrigger, def.notifyOnTrigger),
    dynamicThreshold: resolveDynamicThresholdSettings(block.dynamicThreshold),
  };
}

/** Snapshot for inclusion in audit rows. */
export function snapshotCompactionTunerSettings(s: CompactionTunerSettings): Record<string, unknown> {
  return {
    enabled: s.enabled,
    thresholdPercent: s.thresholdPercent,
    modelPolicies: s.modelPolicies,
    rearmMarginPercent: s.rearmMarginPercent,
    notifyOnTrigger: s.notifyOnTrigger,
    hasCustomInstructions: s.customInstructions.length > 0,
    summaryModels: s.summaryModels,
    remoteOpenAICompaction: {
      enabled: s.remoteOpenAICompaction.enabled,
      modelAllowlist: s.remoteOpenAICompaction.modelAllowlist,
      timeoutMs: s.remoteOpenAICompaction.timeoutMs,
      auditPayload: s.remoteOpenAICompaction.auditPayload,
    },
    dynamicThreshold: {
      enabled: s.dynamicThreshold.enabled,
      smallWindowMaxTokens: s.dynamicThreshold.smallWindowMaxTokens,
      smallWindowThresholdPercent: s.dynamicThreshold.smallWindowThresholdPercent,
      mediumWindowMaxTokens: s.dynamicThreshold.mediumWindowMaxTokens,
      mediumWindowThresholdPercent: s.dynamicThreshold.mediumWindowThresholdPercent,
      largeWindowMaxTokens: s.dynamicThreshold.largeWindowMaxTokens,
      largeWindowThresholdPercent: s.dynamicThreshold.largeWindowThresholdPercent,
      minHeadroomTokens: s.dynamicThreshold.minHeadroomTokens,
      modelEffectiveContextBudgets: s.dynamicThreshold.modelEffectiveContextBudgets,
    },
  };
}
