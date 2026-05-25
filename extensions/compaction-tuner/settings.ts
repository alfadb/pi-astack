import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

/**
 * Compaction-tuner runs on every `agent_end`. When enabled, it reads
 * `ctx.getContextUsage()` and triggers `ctx.compact()` once the percent
 * of contextWindow consumed crosses `thresholdPercent`. We use pi's own
 * runtime API rather than mutating pi's `compaction.reserveTokens`
 * setting, because that setting is a runtime snapshot — pi reads it once
 * at startup and never reloads except on explicit `/reload`.
 *
 * Pi's built-in threshold (default reserveTokens=16384) still acts as a
 * last-resort safety net: at 1M-context our 75% trigger fires at 750k
 * while pi's safety net only fires at ~983k.
 */
export interface CompactionTunerSettings {
  enabled: boolean;
  /** Target context-usage percentage to trigger compaction (0-100). */
  thresholdPercent: number;
  /** Optional custom instructions passed to the compaction LLM. */
  customInstructions: string;
  /**
   * Optional ordered model refs (provider/model) for custom compaction
   * summarization. Empty default intentionally preserves pi core behavior:
   * summary generation uses the current main-session model.
   */
  summaryModels: string[];
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
}

export const DEFAULT_COMPACTION_TUNER_SETTINGS: CompactionTunerSettings = {
  enabled: false,
  thresholdPercent: 75,
  customInstructions: "",
  summaryModels: [],
  rearmMarginPercent: 5,
  notifyOnTrigger: true,
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
    customInstructions,
    summaryModels,
    rearmMarginPercent: Math.max(0, asNumber(block.rearmMarginPercent, def.rearmMarginPercent)),
    notifyOnTrigger: asBoolean(block.notifyOnTrigger, def.notifyOnTrigger),
  };
}

/** Snapshot for inclusion in audit rows. */
export function snapshotCompactionTunerSettings(s: CompactionTunerSettings): Record<string, unknown> {
  return {
    enabled: s.enabled,
    thresholdPercent: s.thresholdPercent,
    rearmMarginPercent: s.rearmMarginPercent,
    notifyOnTrigger: s.notifyOnTrigger,
    hasCustomInstructions: s.customInstructions.length > 0,
    summaryModels: s.summaryModels,
  };
}
