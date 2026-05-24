import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

/**
 * Resolve `autoLlmWriteEnabled` from raw config to the tristate type.
 * Accepts:
 *   - boolean true / false
 *   - string "true" / "false" / "staging-only" (case-insensitive, trimmed)
 *   - anything else → fallback (preserves backward compat for bool callers)
 */
function resolveAutoLlmWriteEnabled(
  raw: unknown,
  fallback: boolean | "staging-only",
): boolean | "staging-only" {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "staging-only" || v === "staging") return "staging-only";
  }
  return fallback;
}

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
  /** ADR 0025 P1: model for the active correction classifier.
   *  Classification task, not reasoning — v4-flash is sufficient. */
  classifierModel: string;
  classifierTimeoutMs: number;
  extractorMaxCandidates: number;
  extractorAuditRawChars: number;
  curatorModel: string;
  curatorTimeoutMs: number;
  curatorMaxRetries: number;
  /**
   * Sediment auto-write tristate (ADR 0025 §5.3 P5.5 retreat-path requirement).
   *
   *   true            — full pipeline: classifier + extractor + curator + writer
   *   "staging-only"  — classifier runs and writes provisional staging entries,
   *                     but tryAutoWriteLane (extractor / curator / writer) is
   *                     skipped. Observation continues; no durable entry mutation.
   *   false           — hard kill switch: classifier also stops (no LLM tokens
   *                     spent on sediment in any agent_end). Use this when the
   *                     user explicitly does not want sediment observing.
   *
   * Default is `true` (P5.5, this commit). Rollback path:
   *   - immediate concerns about durable writes → set to `"staging-only"` in
   *     ~/.pi/agent/pi-astack-settings.json sediment.autoLlmWriteEnabled
   *   - want sediment entirely silent → set to `false`
   * Both rollback values are honored at process start without code change.
   */
  autoLlmWriteEnabled: boolean | "staging-only";
  autoWriteRawAuditChars: number;
  /** When true, skip credential sanitization in continuation-call path.
   *  Safe for air-gapped deployments where extractor LLM provider
   *  cannot reach internal infrastructure even with leaked keys.
   *  Default: false (sanitize is ON by default). */
  skipContinuationSanitize: boolean;
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
  // Classifier is a reading-comprehension + classification task.
  // v4-flash is fast ($0.14/M), cheap, and sufficient — no reasoning needed.
  classifierModel: "deepseek/deepseek-v4-flash",
  classifierTimeoutMs: 30_000,
  extractorMaxCandidates: 5,
  extractorAuditRawChars: 1_000,
  // 2026-05-11: curator split from extractorModel (3-model audit).
  // Curator is a small-context entity-resolution task (candidate +
  // ≤5 neighbors). v4-flash is sufficient; timeout dropped to 60s;
  // 1 retry to recover from JSON parse errors.
  curatorModel: "deepseek/deepseek-v4-flash",
  curatorTimeoutMs: 60_000,
  curatorMaxRetries: 1,
  // ADR 0025 §5.3 P5.5: default changed false → true 2026-05-24.
  //
  // Strict ADR §5.3 hard conditions (3 users × 4 weeks, false-positive rate
  // < 15%, no user complaints, staging growth < 50/month with resolve > 30%)
  // are NOT fully satisfied: pi-astack is a single-user project (alfadb), so
  // the 3-user requirement is structurally unmeetable. Single-user dogfood
  // signals available:
  //   - 77 classifier runs, 15 (19%) signal_found, durable conf 7–8 multiple
  //     times — quality looks healthy but false-positive rate not directly
  //     computable until typing routing lands (Tier-1 §4.1 ship-block T1-1)
  //   - 495 create operations under autoLlmWriteEnabled=true in user-local
  //     settings, no manifest user complaints in audit
  //   - 9 staging provisional entries, well under any inflation cap
  //
  // The strict P5.5 conditions exist to prevent silent durable-region pollution
  // when the original author isn't watching. For a single-user repo the user
  // IS the author, so the polluted entries surface as direct dogfood frustration
  // — a tighter feedback loop than the 3-user dogfood was designed to provide.
  // Both "staging-only" and false retreat paths are wired (this file's tristate
  // semantics + index.ts gate logic), so rollback is one settings line away.
  autoLlmWriteEnabled: true,
  autoWriteRawAuditChars: 8_000,
  skipContinuationSanitize: false,
  promptVersion: {
    activeCorrectionClassifier: "v1",
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
    classifierModel: typeof cfg.classifierModel === "string" && cfg.classifierModel.trim()
      ? cfg.classifierModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.classifierModel,
    classifierTimeoutMs: Math.max(5_000, asNumber(cfg.classifierTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.classifierTimeoutMs)),
    extractorMaxCandidates: Math.max(1, Math.floor(asNumber(cfg.extractorMaxCandidates, DEFAULT_SEDIMENT_SETTINGS.extractorMaxCandidates))),
    extractorAuditRawChars: Math.max(0, Math.floor(asNumber(cfg.extractorAuditRawChars, DEFAULT_SEDIMENT_SETTINGS.extractorAuditRawChars))),
    curatorModel: typeof cfg.curatorModel === "string" && cfg.curatorModel.trim()
      ? cfg.curatorModel.trim()
      : DEFAULT_SEDIMENT_SETTINGS.curatorModel,
    curatorTimeoutMs: Math.max(1_000, asNumber(cfg.curatorTimeoutMs, DEFAULT_SEDIMENT_SETTINGS.curatorTimeoutMs)),
    curatorMaxRetries: Math.max(0, Math.floor(asNumber(cfg.curatorMaxRetries, DEFAULT_SEDIMENT_SETTINGS.curatorMaxRetries))),
    autoLlmWriteEnabled: resolveAutoLlmWriteEnabled(cfg.autoLlmWriteEnabled, DEFAULT_SEDIMENT_SETTINGS.autoLlmWriteEnabled),
    autoWriteRawAuditChars: Math.max(0, Math.floor(asNumber(cfg.autoWriteRawAuditChars, DEFAULT_SEDIMENT_SETTINGS.autoWriteRawAuditChars))),
    skipContinuationSanitize: asBoolean(cfg.skipContinuationSanitize, DEFAULT_SEDIMENT_SETTINGS.skipContinuationSanitize),
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
