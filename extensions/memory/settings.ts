import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SearchSettings {
  // ADR 0015 (memory_search LLM-driven retrieval, Accepted 2026-05-10).
  // Two-stage rerank: stage 1 selects candidates from full-body v3 candidate
  // surface, stage 2 reranks selected full content. Defaults to deepseek
  // family for in-China latency + reasoning + bilingual quality. Accuracy is a hard contract:
  // LLM failures hard-error; there is no grep degradation path.
  // DeepSeek v4 only supports off/high/xhigh; stage 1 must default to off
  // rather than minimal because pi-ai would otherwise clamp minimal to high.
  stage1Model: string;
  stage1Limit: number;
  stage1Thinking: ThinkingLevel;
  stage2Model: string;
  stage2Limit: number;
  stage2Thinking: ThinkingLevel;
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  // No model hardcoded in code: pi-astack-settings.json is the single source
  // of truth. Empty default + fail-closed at the modelRegistry call site.
  stage1Model: "",
  stage1Limit: 50,
  stage1Thinking: "off",
  stage2Model: "",
  stage2Limit: 10,
  stage2Thinking: "off",
};

// ADR 0026 §3.1 walk-back (2026-05-28). Path A is the "always inject
// relevant memories" route: every turn runs a rewriter LLM + a search
// with LLM-side strong cutoff, injects when stage 2 says has_relevant.
//
// queryRewriterModel is intentionally empty: configure in
// pi-astack-settings.json → memory.pathA.queryRewriterModel. Code never
// names a model.
export interface PathASettings {
  enabled: boolean;
  queryRewriterModel: string;
  queryRewriterTimeoutMs: number;
  /** v2 (2026-05-28): how many prior user/assistant turns the rewriter
   *  sees. 4 covers most context-resolution needs (“刚才那个” / “继续” /
   *  “好就用 X”) without bloating prompt cost. */
  historyMaxTurns: number;
  /** Per-turn cap in chars before middle-truncation; defends against
   *  one giant assistant reply or code paste blowing the prompt budget. */
  historyMaxCharsPerTurn: number;
  searchLimit: number;
  injectMaxEntries: number;
  entryExcerptChars: number;
}

export const DEFAULT_PATH_A_SETTINGS: PathASettings = {
  enabled: true,
  queryRewriterModel: "",
  queryRewriterTimeoutMs: 15_000,
  historyMaxTurns: 4,
  historyMaxCharsPerTurn: 2000,
  searchLimit: 5,
  injectMaxEntries: 5,
  entryExcerptChars: 800,
};

export interface MemorySettings {
  includeWorld: boolean;
  defaultLimit: number;
  maxLimit: number;
  maxEntries: number;
  projectBoost: number;
  shortTermTtlDays: number;
  /** memory_decide synthesis model. Empty string = reuse search.stage1Model.
   *  Configure in pi-astack-settings.json → memory.decideModel; code never
   *  names a model. */
  decideModel: string;
  search: SearchSettings;
  pathA: PathASettings;
}

export const DEFAULT_SETTINGS: MemorySettings = {
  includeWorld: true,
  defaultLimit: 20,
  maxLimit: 50,
  maxEntries: 2_000,
  projectBoost: 1.5,
  shortTermTtlDays: 30,
  decideModel: "",
  search: DEFAULT_SEARCH_SETTINGS,
  pathA: DEFAULT_PATH_A_SETTINGS,
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

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  return fallback;
}

function asThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(s)) return s as ThinkingLevel;
  return fallback;
}

function resolveSearchSettings(cfg: Record<string, unknown>): SearchSettings {
  const search = (cfg.search as Record<string, unknown>) ?? {};
  return {
    stage1Model: asString(search.stage1Model, DEFAULT_SEARCH_SETTINGS.stage1Model),
    stage1Limit: Math.max(1, asNumber(search.stage1Limit, DEFAULT_SEARCH_SETTINGS.stage1Limit)),
    stage1Thinking: asThinkingLevel(search.stage1Thinking, DEFAULT_SEARCH_SETTINGS.stage1Thinking),
    stage2Model: asString(search.stage2Model, DEFAULT_SEARCH_SETTINGS.stage2Model),
    stage2Limit: Math.max(1, asNumber(search.stage2Limit, DEFAULT_SEARCH_SETTINGS.stage2Limit)),
    stage2Thinking: asThinkingLevel(search.stage2Thinking, DEFAULT_SEARCH_SETTINGS.stage2Thinking),
  };
}

function resolvePathASettings(cfg: Record<string, unknown>): PathASettings {
  const p = (cfg.pathA as Record<string, unknown>) ?? {};
  return {
    enabled: asBoolean(p.enabled, DEFAULT_PATH_A_SETTINGS.enabled),
    queryRewriterModel: asString(p.queryRewriterModel, DEFAULT_PATH_A_SETTINGS.queryRewriterModel),
    queryRewriterTimeoutMs: Math.max(1000, asNumber(p.queryRewriterTimeoutMs, DEFAULT_PATH_A_SETTINGS.queryRewriterTimeoutMs)),
    historyMaxTurns: Math.max(0, Math.min(20, asNumber(p.historyMaxTurns, DEFAULT_PATH_A_SETTINGS.historyMaxTurns))),
    historyMaxCharsPerTurn: Math.max(100, Math.min(8000, asNumber(p.historyMaxCharsPerTurn, DEFAULT_PATH_A_SETTINGS.historyMaxCharsPerTurn))),
    searchLimit: Math.max(1, Math.min(20, asNumber(p.searchLimit, DEFAULT_PATH_A_SETTINGS.searchLimit))),
    injectMaxEntries: Math.max(1, Math.min(20, asNumber(p.injectMaxEntries, DEFAULT_PATH_A_SETTINGS.injectMaxEntries))),
    entryExcerptChars: Math.max(100, Math.min(4000, asNumber(p.entryExcerptChars, DEFAULT_PATH_A_SETTINGS.entryExcerptChars))),
  };
}

export function resolveSettings(): MemorySettings {
  const root = loadPiStackSettings();
  const cfg = (root.memory as Record<string, unknown>) ?? {};
  return {
    includeWorld: asBoolean(cfg.includeWorld, DEFAULT_SETTINGS.includeWorld),
    defaultLimit: Math.max(1, asNumber(cfg.defaultLimit, DEFAULT_SETTINGS.defaultLimit)),
    maxLimit: Math.max(1, asNumber(cfg.maxLimit, DEFAULT_SETTINGS.maxLimit)),
    maxEntries: Math.max(10, asNumber(cfg.maxEntries, DEFAULT_SETTINGS.maxEntries)),
    projectBoost: Math.max(0.1, asNumber(cfg.projectBoost, DEFAULT_SETTINGS.projectBoost)),
    shortTermTtlDays: Math.max(1, asNumber(cfg.shortTermTtlDays, DEFAULT_SETTINGS.shortTermTtlDays)),
    decideModel: asString(cfg.decideModel, DEFAULT_SETTINGS.decideModel),
    search: resolveSearchSettings(cfg),
    pathA: resolvePathASettings(cfg),
  };
}
