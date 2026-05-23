import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export interface SedimentSettings {
  enabled: boolean;
  gitCommit: boolean;
  lockTimeoutMs: number;
  defaultConfidence: number;
  minWindowChars: number;
  maxWindowChars: number;
  maxWindowEntries: number;
  maxEntryChars: number;
  extractorModel: string;
  extractorTimeoutMs: number;
  extractorMaxRetries: number;
  extractorMaxCandidates: number;
  extractorAuditRawChars: number;
  curatorModel: string;
  curatorTimeoutMs: number;
  curatorMaxRetries: number;
  autoLlmWriteEnabled: boolean;
  autoWriteRawAuditChars: number;
  /** ADR 0025 P0: semantic version tags for each classifier prompt.
   *  Written into every audit row so downstream aggregator/health-check
   *  can track prompt changes without manual cross-reference. */
  promptVersion: {
    activeCorrectionClassifier: string;
    multiViewPass1: string;
    multiViewPass2: string;
    outcomeSelfReport: string;
    aggregator: string;
    archiveReactivationReviewer: string;
  };
  /** ADR 0025 P0: multi-view verification provider lists.
   *  If empty, multi-view is effectively disabled (single-provider
   *  degradation). The proposer and reviewer MUST be from DIFFERENT
   *  providers per ADR 0024 §5.4. */
  multiView: {
    proposerProviders: string[];
    reviewerProviders: string[];
    fallbackProviders: string[];
    /** Soft budget in USD per multi-view op. Exceeded → DEFER to staging. */
    costBudgetPerOpUsd: number;
  };
}

export const DEFAULT_SEDIMENT_SETTINGS: SedimentSettings = {
  enabled: false,
  gitCommit: true,
  lockTimeoutMs: 5_000,
  defaultConfidence: 3,
  minWindowChars: 200,
  // 2026-05-11: raised from 200K to 350K (with per-entry truncation at
  // 30K chars for toolResult/bashExecution). 350K ~87.5K tokens, well
  // within deepseek 128K context (71% utilization). See 3-model audit.
  maxWindowChars: 350_000,
  maxWindowEntries: 200,
  // Per-entry char cap for toolResult and bashExecution entries.
  // Prevents a single large tool output from dominating the window.
  // Head 25K + tail 5K preserved; middle truncated with marker.
  maxEntryChars: 30_000,
  extractorModel: "deepseek/deepseek-v4-pro",
  extractorTimeoutMs: 180_000,
  extractorMaxRetries: 0,
  extractorMaxCandidates: 5,
  extractorAuditRawChars: 1_000,
  // 2026-05-11: curator split from extractorModel (3-model audit).
  // Curator is a small-context entity-resolution task (candidate +
  // ≤5 neighbors). v4-flash is sufficient; timeout dropped to 60s;
  // 1 retry to recover from JSON parse errors.
  curatorModel: "deepseek/deepseek-v4-flash",
  curatorTimeoutMs: 60_000,
  curatorMaxRetries: 1,
  autoLlmWriteEnabled: false,
  autoWriteRawAuditChars: 8_000,
  promptVersion: {
    activeCorrectionClassifier: "v0",
    multiViewPass1: "v0",
    multiViewPass2: "v0",
    outcomeSelfReport: "v0",
    aggregator: "v0",
    archiveReactivationReviewer: "v0",
  },
  multiView: {
    proposerProviders: [],
    reviewerProviders: [],
    fallbackProviders: [],
    costBudgetPerOpUsd: 0.05,
  },
};

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

export function resolveSedimentSettings(): SedimentSettings {
  const root = loadPiStackSettings();
  const cfg = (root.sediment as Record<string, unknown>) ?? {};
  return {
    enabled: asBoolean(cfg.enabled, DEFAULT_SEDIMENT_SETTINGS.enabled),
    gitCommit: asBoolean(cfg.gitCommit, DEFAULT_SEDIMENT_SETTINGS.gitCommit),
    lockTimeoutMs: Math.max(100, asNumber(cfg.lockTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.lockTimeoutMs)),
    defaultConfidence: Math.min(10, Math.max(0, asNumber(cfg.defaultConfidence, DEFAULT_SEDIMENT_SETTINGS.defaultConfidence))),
    minWindowChars: Math.max(0, asNumber(cfg.minWindowChars, DEFAULT_SEDIMENT_SETTINGS.minWindowChars)),
    maxWindowChars: Math.max(1_000, asNumber(cfg.maxWindowChars, DEFAULT_SEDIMENT_SETTINGS.maxWindowChars)),
    maxWindowEntries: Math.max(1, Math.floor(asNumber(cfg.maxWindowEntries, DEFAULT_SEDIMENT_SETTINGS.maxWindowEntries))),
    maxEntryChars: Math.max(1_000, asNumber(cfg.maxEntryChars, DEFAULT_SEDIMENT_SETTINGS.maxEntryChars)),
    extractorModel: typeof cfg.extractorModel === "string" && cfg.extractorModel.trim()
      ? cfg.extractorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.extractorModel,
    extractorTimeoutMs: Math.max(1_000, asNumber(cfg.extractorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.extractorTimeoutMs)),
    extractorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.extractorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.extractorMaxRetries))),
    extractorMaxCandidates: Math.max(1, Math.floor(asNumber(cfg.extractorMaxCandidates, DEFAULT_SEDIMENT_SETTINGS.extractorMaxCandidates))),
    extractorAuditRawChars: Math.max(0, Math.floor(asNumber(cfg.extractorAuditRawChars, DEFAULT_SEDIMENT_SETTINGS.extractorAuditRawChars))),
    curatorModel: typeof cfg.curatorModel === "string" && cfg.curatorModel.trim()
      ? cfg.curatorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.curatorModel,
    curatorTimeoutMs: Math.max(1_000, asNumber(cfg.curatorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.curatorTimeoutMs)),
    curatorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.curatorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.curatorMaxRetries))),
    autoLlmWriteEnabled: asBoolean(cfg.autoLlmWriteEnabled, DEFAULT_SEDIMENT_SETTINGS.autoLlmWriteEnabled),
    autoWriteRawAuditChars: Math.max(0, Math.floor(asNumber(cfg.autoWriteRawAuditChars, DEFAULT_SEDIMENT_SETTINGS.autoWriteRawAuditChars))),
    promptVersion: {
      activeCorrectionClassifier: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.activeCorrectionClassifier === "string"
        ? (cfg.promptVersion as Record<string,unknown>).activeCorrectionClassifier as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.activeCorrectionClassifier,
      multiViewPass1: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.multiViewPass1 === "string"
        ? (cfg.promptVersion as Record<string,unknown>).multiViewPass1 as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.multiViewPass1,
      multiViewPass2: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.multiViewPass2 === "string"
        ? (cfg.promptVersion as Record<string,unknown>).multiViewPass2 as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.multiViewPass2,
      outcomeSelfReport: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.outcomeSelfReport === "string"
        ? (cfg.promptVersion as Record<string,unknown>).outcomeSelfReport as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.outcomeSelfReport,
      aggregator: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.aggregator === "string"
        ? (cfg.promptVersion as Record<string,unknown>).aggregator as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.aggregator,
      archiveReactivationReviewer: typeof (cfg.promptVersion as Record<string,unknown>|undefined)?.archiveReactivationReviewer === "string"
        ? (cfg.promptVersion as Record<string,unknown>).archiveReactivationReviewer as string : DEFAULT_SEDIMENT_SETTINGS.promptVersion.archiveReactivationReviewer,
    },
    multiView: {
      proposerProviders: Array.isArray((cfg.multiView as Record<string,unknown>|undefined)?.proposerProviders)
        ? (cfg.multiView as Record<string,unknown>).proposerProviders as string[] : DEFAULT_SEDIMENT_SETTINGS.multiView.proposerProviders,
      reviewerProviders: Array.isArray((cfg.multiView as Record<string,unknown>|undefined)?.reviewerProviders)
        ? (cfg.multiView as Record<string,unknown>).reviewerProviders as string[] : DEFAULT_SEDIMENT_SETTINGS.multiView.reviewerProviders,
      fallbackProviders: Array.isArray((cfg.multiView as Record<string,unknown>|undefined)?.fallbackProviders)
        ? (cfg.multiView as Record<string,unknown>).fallbackProviders as string[] : DEFAULT_SEDIMENT_SETTINGS.multiView.fallbackProviders,
      costBudgetPerOpUsd: asNumber((cfg.multiView as Record<string,unknown>|undefined)?.costBudgetPerOpUsd, DEFAULT_SEDIMENT_SETTINGS.multiView.costBudgetPerOpUsd),
    },
  };
}
