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
  stage1Skip: boolean;              // ADR 0036: 跳过 stage1 LLM, stage0 top-K 直出 stage2(两阶段塔缩)
  sparseBM25: boolean;             // ADR 0036: sparse 用 char n-gram BM25(补中文/符号)替朴素子串
  bestEffortOnNone: boolean;       // stage2 LLM 判 none + 扩召 retry 仍 none 时, 返回 stage0 排序 top-K(低置信)而非空。默认 false；依赖精准率的调用点保持空语义。
  queryRouting: boolean;           // ADR 0036 P5: toolSearch 精确直查路由(query 恰为 slug 或 ADR 编号 → 直接命中跳 LLM)
  dedupChunk0Aggregation: boolean; // ADR 0036 P4 条件1: dedup 路径 topN 只用 chunk0(head)向量, 避免 multiVector max-sim 的 false-merge 注入
  autoReconcile: boolean;          // ADR 0036 §10.6: search 时双向(stale-add ∪ orphan-prune)后台增量 reconcile(新设备/git-pull/archive/delete/纯读会话自收敛)
  autoReconcileCooldownMs: number; // 两次自动 reconcile 最小间隔(single-flight 之外的防抖)
  autoReconcileMinBacklog: number; // 非空索引时: stale+orphan 达此才触发(小变动走 search-time bounded fallback)
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
  // ADR 0036(dark-launch, 默认 off): 两阶段塔缩 —— stage0 dense 已排序,
  // 跳过 stage1 LLM 粗筛(5×T0 共识: stage1 与 dense 排序冲退), stage0 top-K
  // 直接喚 stage2 full-body 精排。省掉 stage1 的 ~324K token(~9× 降本)。
  stage1Skip: false,
  // ADR 0036(dark-launch, 默认 off): sparse 用 char n-gram BM25 替朴素子串。
  // 现 sparseMatchSlugs 的 term regex /[a-z0-9].../ 对中文零匹配 —— 中文 query
  // 的 sparse 通道完全失效。BM25(ASCII 标识符 + CJK bigram + IDF 加权 + 字段
  // 权重)补 dense 的中文/精确符号/短 query 盲区, 与 dense RRF 融合。
  sparseBM25: false,
  bestEffortOnNone: false,
  // ADR 0036 P5(dark-launch, 默认 off): toolSearch 精确查找路由。query 经规则 regex
  // (非 LLM)判定: 恰等于某 entry 的 slug, 或匹配 `ADR NNNN`/`adr-NNNN` 且唯一命中
  // adr-NNNN-* slug 时, 直接返回该 entry 跳过两次 LLM 调用(省成本+延迟)。仅 toolSearch
  // 适用(path-A/decide/dedup/correction 的 query 永不是裸 slug)。无匹配则 fall-through
  // 正常检索 —— 精确直查是“锦上添花快路径”, 永不抑制召回。语义/符号 query 路由偏置
  // (sparse-first/dense-first)留待 stage0 RRF 权重调参, 不在此 flag 内。
  queryRouting: false,
  // ADR 0036 P4 条件1(dedup 分离): 默认 false(maxsim)。sedimentDedup profile 钉 true
  // —— multiVector flip 后 dedup 用 chunk0(head)聚合, 不让共享尾段 chunk 的 distinct entry
  // 浮上为近重候选(实测 multiVector 下 235→62 新增邻居, -74%)。multiVector off 时
  // 仅 1 chunk, chunk0==maxsim(no-op)。
  dedupChunk0Aggregation: false,
  // ADR 0036 §10.6: 默认开 —— 补“git-pull/新设备/纯读会话不重建”的缺口(原只 sediment 写触发)。
  // 稳态(索引新)时谓词(stale+orphan<min)不触发, 零开销; 空索引/高 backlog 才 fire 后台重建。
  // 显式 kill-switch 也在 pi-astack-settings.json(应急可置 false)。
  autoReconcile: true,
  autoReconcileCooldownMs: 300_000, // 5min
  autoReconcileMinBacklog: 3,        // ≤2 条 stale/orphan 走 bounded fallback, 不为小变动炸 reconcile
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

// ADR 0035 P1: stage0 embedding 候选检索配置。baseUrl/apiKey 是专用
// endpoint 配置，不进入通用 chat modelRegistry，避免 embedding 模型出现在
// /model 等聊天模型选择面。空 baseUrl/apiKey/model = fail-closed。
export interface EmbeddingSettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
  batchSize: number;          // doubao hard cap = 10
  tpmLimit: number;           // 方舟 Coding Plan 600K tokens/min
  timeoutMs: number;
  maxRetries: number;
  entryEmbedMaxChars: number;  // 每 sub-vector 截断(单向量=全 entry; 多向量=每 chunk)
  multiVector: boolean;            // ADR 0036 P4: 多向量解 3500 截断(默认 off, dark-launch)
  multiVectorMaxChunks: number;    // 每 entry 最多 sub-vector 数(成本上限)
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  provider: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  dim: 2048,
  batchSize: 10,
  tpmLimit: 600_000,
  timeoutMs: 60_000,
  maxRetries: 3,
  entryEmbedMaxChars: 3500,
  multiVector: false,
  multiVectorMaxChunks: 4,
};

// ADR 0031 Phase 0 — 遗忘自治子系统设置。
export interface ForgettingSettings {
  /** Runtime kill-switch for all forgetting-side evaluation and mutation.
   *  enabled=false: no decay assessment scheduling, no forgetting side writes,
   *  and no mutation. Read-side instrumentation remains governed only by its
   *  orthogonal switch below; archive reactivation is governed by sediment. */
  enabled: boolean;
  /** ADR 0031 Phase 0: read-side usage instrumentation switch.
   *  Pure observation; off = instrumentation short-circuits and writes nothing. */
  instrumentation: boolean;
}

export const DEFAULT_FORGETTING_SETTINGS: ForgettingSettings = {
  enabled: false,
  instrumentation: false,
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
  forgetting: ForgettingSettings;
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
  forgetting: DEFAULT_FORGETTING_SETTINGS,
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
    stage1Skip: asBoolean(search.stage1Skip, DEFAULT_SEARCH_SETTINGS.stage1Skip),
    sparseBM25: asBoolean(search.sparseBM25, DEFAULT_SEARCH_SETTINGS.sparseBM25),
    bestEffortOnNone: asBoolean(search.bestEffortOnNone, DEFAULT_SEARCH_SETTINGS.bestEffortOnNone),
    queryRouting: asBoolean(search.queryRouting, DEFAULT_SEARCH_SETTINGS.queryRouting),
    dedupChunk0Aggregation: asBoolean(search.dedupChunk0Aggregation, DEFAULT_SEARCH_SETTINGS.dedupChunk0Aggregation),
    autoReconcile: asBoolean(search.autoReconcile, DEFAULT_SEARCH_SETTINGS.autoReconcile),
    autoReconcileCooldownMs: Math.max(0, asNumber(search.autoReconcileCooldownMs, DEFAULT_SEARCH_SETTINGS.autoReconcileCooldownMs)),
    autoReconcileMinBacklog: Math.max(1, asNumber(search.autoReconcileMinBacklog, DEFAULT_SEARCH_SETTINGS.autoReconcileMinBacklog)),
  };
}

function resolveEmbeddingSettings(cfg: Record<string, unknown>): EmbeddingSettings {
  const e = (cfg.embedding as Record<string, unknown>) ?? {};
  return {
    provider: asString(e.provider, DEFAULT_EMBEDDING_SETTINGS.provider),
    baseUrl: asString(e.baseUrl, DEFAULT_EMBEDDING_SETTINGS.baseUrl),
    apiKey: asString(e.apiKey, DEFAULT_EMBEDDING_SETTINGS.apiKey),
    model: asString(e.model, DEFAULT_EMBEDDING_SETTINGS.model),
    dim: Math.max(1, asNumber(e.dim, DEFAULT_EMBEDDING_SETTINGS.dim)),
    batchSize: Math.max(1, Math.min(10, asNumber(e.batchSize, DEFAULT_EMBEDDING_SETTINGS.batchSize))),
    tpmLimit: Math.max(1000, asNumber(e.tpmLimit, DEFAULT_EMBEDDING_SETTINGS.tpmLimit)),
    timeoutMs: Math.max(1000, asNumber(e.timeoutMs, DEFAULT_EMBEDDING_SETTINGS.timeoutMs)),
    maxRetries: Math.max(0, Math.min(10, asNumber(e.maxRetries, DEFAULT_EMBEDDING_SETTINGS.maxRetries))),
    entryEmbedMaxChars: Math.max(200, asNumber(e.entryEmbedMaxChars, DEFAULT_EMBEDDING_SETTINGS.entryEmbedMaxChars)),
    multiVector: asBoolean(e.multiVector, DEFAULT_EMBEDDING_SETTINGS.multiVector),
    multiVectorMaxChunks: Math.max(1, Math.min(16, asNumber(e.multiVectorMaxChunks, DEFAULT_EMBEDDING_SETTINGS.multiVectorMaxChunks))),
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

let warnedForgettingLegacyKeys = false;

function resolveForgettingSettings(cfg: Record<string, unknown>): ForgettingSettings {
  const f = (cfg.forgetting as Record<string, unknown>) ?? {};
  const legacyKeys = ["decayShadow", "demoteShadow", "autoDemote"] as const;
  const hasEnabled = Object.prototype.hasOwnProperty.call(f, "enabled");
  const hasLegacy = legacyKeys.some((key) => Object.prototype.hasOwnProperty.call(f, key));
  if (!hasEnabled && hasLegacy && !warnedForgettingLegacyKeys) {
    warnedForgettingLegacyKeys = true;
    console.warn("pi-astack: memory.forgetting decayShadow/demoteShadow/autoDemote are deprecated; use memory.forgetting.enabled. Migration fallback maps enabled = decayShadow || demoteShadow || autoDemote.");
  }
  const migratedEnabled = legacyKeys.some((key) => asBoolean(f[key], false));
  return {
    enabled: hasEnabled ? asBoolean(f.enabled, DEFAULT_FORGETTING_SETTINGS.enabled) : migratedEnabled,
    instrumentation: asBoolean(f.instrumentation, DEFAULT_FORGETTING_SETTINGS.instrumentation),
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
    forgetting: resolveForgettingSettings(cfg),
  };
}
