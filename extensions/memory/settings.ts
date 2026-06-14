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
  // ADR 0035 P3: stage0 embedding 候选检索(dark-launch, 默认 off=full-body 全库)。
  stage0Enabled: boolean;
  stage0PoolLimit: number;          // dense topN 候选数(~100)
  stage0MaxCandidates: number;      // hybrid union 候选面硬上限(~300, 成本旋钮)
  stage0InsufficientPoolK: number;  // 候选池 < K 触发安全网有界扩召(~5)
  stage0EmbedTimeoutMs: number;     // query embed 短超时(~10s; 失败即熔断 sparse)
  stage0StaleFloorRatio: number;    // P6: stale/missing 保底预算占 maxCand 比例(freshness 不变量)
  stage1CompactSurface: boolean;    // P8: stage1 用紧凑 surface(meta+summary, 无 compiledTruth/timeline)做粗筛
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
  // ADR 0035 P5: stage0 默认开(full_body_v3 退役为 flag-off kill-switch +
  // oracle baseline)。P4 强 baseline(deepseek-v4-pro)21-query oracle coverage
  // 95.1% ≥ 95% 转产硬门。设 false 可紧急回退全库 full-body。
  stage0Enabled: true,
  // P5 离线 oracle tuning 收敛值: poolLimit 300 给 dense 充足语义召回配额
  // (P4 的 200 使部分中文/概念 query 的 baseline picks 落 dense top200 外,
  // coverage 94-95% 临界波动); maxCand 400 硬上限(dense 300+sparse 100, 仍
  // 远<全库 降本 2.8×); sparse 字段权重 3:1(高信号/body)防 body 命中挤占 dense。
  stage0PoolLimit: 300,
  stage0MaxCandidates: 400,
  stage0InsufficientPoolK: 5,
  stage0EmbedTimeoutMs: 10_000,
  // P6(4×T0 REVISE-B 共识): stale/missing(刚写/改写未索引) 保底预算 floor,
  // 不可被 dense/sparse 填满 maxCand 挤出 —— 兑现 ADR §4 freshness 不变量
  // (“新写 entry 下次 search 立即可召回”)。floor 是下限不是上限: 超 floor
  // 的 stale 仍可补到 maxCand(不独立砸一刀, deepseek 反对 20% 上限的点)。
  // 0.1 × 400 = 40 槽: 正常 stale ≤几条全进, 冷启动/provider 宕机时限其不挤爆 relevance。
  stage0StaleFloorRatio: 0.1,
  // P8(dark-launch, 默认 off): stage1 surface 紧凑化。stage0 已缩候选数(库→400),
  // 但 stage1 仍喚 full-body(compiledTruth+timeline ~810 token/entry ×400=324K, cache
  // 命中 0.2%)。dense 已语义召回→候选都相关, stage1 只需粗筛 top, 用
  // meta+title+trigger+summary(~150 token/entry)足够; 完整 body 留 stage2 精排。
  stage1CompactSurface: false,
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

// ADR 0035 P1: stage0 embedding 候选检索配置。provider 指向 models.json
// 里的 provider key(如 "embedding"),code 不硬编码 model;空 provider/model
// = fail-closed(buildCorpusEmbeddings 会报错)。
export interface EmbeddingSettings {
  provider: string;
  model: string;
  dim: number;
  batchSize: number;          // doubao hard cap = 10
  tpmLimit: number;           // 方舟 Coding Plan 600K tokens/min
  timeoutMs: number;
  maxRetries: number;
  entryEmbedMaxChars: number;  // single-vector 截断(多向量 deferred, ADR 0035 §7)
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  provider: "",
  model: "",
  dim: 2048,
  batchSize: 10,
  tpmLimit: 600_000,
  timeoutMs: 60_000,
  maxRetries: 3,
  entryEmbedMaxChars: 3500,
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
  embedding: EmbeddingSettings;
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
  embedding: DEFAULT_EMBEDDING_SETTINGS,
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
    stage0Enabled: asBoolean(search.stage0Enabled, DEFAULT_SEARCH_SETTINGS.stage0Enabled),
    stage0PoolLimit: Math.max(1, asNumber(search.stage0PoolLimit, DEFAULT_SEARCH_SETTINGS.stage0PoolLimit)),
    stage0MaxCandidates: Math.max(1, asNumber(search.stage0MaxCandidates, DEFAULT_SEARCH_SETTINGS.stage0MaxCandidates)),
    stage0InsufficientPoolK: Math.max(0, asNumber(search.stage0InsufficientPoolK, DEFAULT_SEARCH_SETTINGS.stage0InsufficientPoolK)),
    stage0EmbedTimeoutMs: Math.max(1000, asNumber(search.stage0EmbedTimeoutMs, DEFAULT_SEARCH_SETTINGS.stage0EmbedTimeoutMs)),
    stage0StaleFloorRatio: Math.min(1, Math.max(0, asNumber(search.stage0StaleFloorRatio, DEFAULT_SEARCH_SETTINGS.stage0StaleFloorRatio))),
    stage1CompactSurface: asBoolean(search.stage1CompactSurface, DEFAULT_SEARCH_SETTINGS.stage1CompactSurface),
  };
}

function resolveEmbeddingSettings(cfg: Record<string, unknown>): EmbeddingSettings {
  const e = (cfg.embedding as Record<string, unknown>) ?? {};
  return {
    provider: asString(e.provider, DEFAULT_EMBEDDING_SETTINGS.provider),
    model: asString(e.model, DEFAULT_EMBEDDING_SETTINGS.model),
    dim: Math.max(1, asNumber(e.dim, DEFAULT_EMBEDDING_SETTINGS.dim)),
    batchSize: Math.max(1, Math.min(10, asNumber(e.batchSize, DEFAULT_EMBEDDING_SETTINGS.batchSize))),
    tpmLimit: Math.max(1000, asNumber(e.tpmLimit, DEFAULT_EMBEDDING_SETTINGS.tpmLimit)),
    timeoutMs: Math.max(1000, asNumber(e.timeoutMs, DEFAULT_EMBEDDING_SETTINGS.timeoutMs)),
    maxRetries: Math.max(0, Math.min(10, asNumber(e.maxRetries, DEFAULT_EMBEDDING_SETTINGS.maxRetries))),
    entryEmbedMaxChars: Math.max(200, asNumber(e.entryEmbedMaxChars, DEFAULT_EMBEDDING_SETTINGS.entryEmbedMaxChars)),
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
    embedding: resolveEmbeddingSettings(cfg),
  };
}
