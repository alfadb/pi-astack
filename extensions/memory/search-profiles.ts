/**
 * memory/search-profiles.ts — ADR 0037: 检索策略 profile registry.
 *
 * 检索计算内核(executeSearch, llm-search.ts)早已被 5 个调用方共享, 但每个调用方
 * 历史上**手搓** status/limit/stage1Skip/sparseBM25/model 策略 —— 已两次漂移/泄漏
 * (curator status:[all] 绕过 stage0; 全局 stage1Skip flip 漏进 dedup)。本模块把每个
 * 角色的策略**在一处声明**, 由 llm-search.ts 的单入口 runMemorySearch 应用 + 调内核。
 *
 * profile 只声明**检索策略**(settings 覆写 + filters + 走哪个内核包装), 不吞角色专属
 * 前/后处理(path-A rewriter / decide 合成 / dedup 近重判定留在各调用方)—— 不拍平语义。
 * profile 声明**默认**, settings 仍可覆写(ADR 0037 §4); limit 用 resolver 读 settings,
 * 不冻结常量(path-A 的 limit 来自 PathASettings.searchLimit, 冻结会随 settings 改而漂移)。
 */
import type { MemorySettings, SearchSettings } from "./settings";
import type { SearchFilters } from "./types";

export type SearchProfileName =
  | "toolSearch"
  | "decideSearch"
  | "pathAInject"
  | "sedimentDedup"
  | "correctionSearch";

export interface SearchProfile {
  name: SearchProfileName;
  // caller-overridable: filters 来自调用方(toolSearch = LLM 给的 normalizeSearchFilters);
  // fixed: 角色钉死 status + limit(resolver)。
  filtersMode: "fixed" | "caller-overridable";
  status?: string[];                                   // fixed 模式: 钉死的 status filter
  limit?: (s: MemorySettings) => number;               // fixed 模式: limit resolver(读 settings, 不冻结)
  searchOverrides?: (s: MemorySettings) => Partial<SearchSettings>; // 角色对 search settings 的覆写
  returnVerdict: boolean;                              // true → withVerdict(path-A); false → plain hits
}

/** ADR 0037: 5 个角色 profile —— 各自声明 = 迁移前 5 个调用方手搓值的快照。
 *  toolSearch: filters 由 LLM 给(caller-overridable), 其余 fixed。 */
export const SEARCH_PROFILES: Record<SearchProfileName, SearchProfile> = {
  // memory_search 工具: filters 全由 LLM 给(normalizeSearchFilters), 无角色覆写。
  toolSearch: { name: "toolSearch", filtersMode: "caller-overridable", returnVerdict: false },
  // memory_decide: built decision query, status:[active], limit:8。search 用 stage1Model;
  // 合成走 decideModel(在 decide handler, 不在本 profile —— 二者保持解耦)。
  decideSearch: { name: "decideSearch", filtersMode: "fixed", status: ["active"], limit: () => 8, returnVerdict: false },
  // path-A before_agent_start 注入: status:[active], limit=PathASettings.searchLimit, 走 verdict。
  // rewriter 在调用方(memory-context-injector), 不在 profile。
  pathAInject: { name: "pathAInject", filtersMode: "fixed", status: ["active"], limit: (s) => s.pathA.searchLimit, returnVerdict: true },
  // sediment 去重: status:[all], limit:5。
  // ADR 0036 P5b(已验证, near-dup 金标 + 真实检索 oracle-dedup-p5b 10/10): stage1Skip/sparseBM25
  // 的临时 pin(=false)已解除 —— dense-only(两阶段+BM25)与三阶段在 dedup 候选上逐对等价
  // (merge-recall@5 100%=100%, distinct-intrusion@5 100%=100%; 合并判定由 curator-LLM 最终把关)。
  // 故 dedup 现**继承全局 stage1Skip/sparseBM25**(跟读路径同栈 + 随其 kill-switch 回滚)。
  // 仅留 dedupChunk0Aggregation=true 为 dedup 专用 pin(ADR 0036 P4 条件1): multiVector flip 后
  // dedup 只用 chunk0 head 聚合, 不让共享尾段 chunk 的 distinct entry 浮上为近重候选(实测 -74%
  // 新增邻居)—— 全局无此 flag 的对应物, 故钉死不随全局漂。near-dup 判定与
  // relevantEntriesForCurator/readonly-rule-neighbors 入参由调用方控(preloadedEntries)。
  sedimentDedup: { name: "sedimentDedup", filtersMode: "fixed", status: ["all"], limit: () => 5, searchOverrides: () => ({ dedupChunk0Aggregation: true }), returnVerdict: false },
  // sediment 纠错: status:[active], limit:10。
  correctionSearch: { name: "correctionSearch", filtersMode: "fixed", status: ["active"], limit: () => 10, returnVerdict: false },
};

export interface ResolvedProfileExecution {
  search: SearchSettings;       // 应用 searchOverrides 后的 search settings
  filters: SearchFilters;       // 角色 fixed filters, 或 caller-overridable 透传的 callerFilters
  returnVerdict: boolean;
}

/** 纯函数: profile + settings (+ caller filters) → 内核执行参数。可单测(免 LLM)。
 *  - fixed: filters = { status, limit(resolver) }; caller-overridable: filters = callerFilters(原样透传)。
 *  - search = settings.search 叠加 profile.searchOverrides。 */
export function resolveProfileExecution(
  profile: SearchProfile,
  settings: MemorySettings,
  callerFilters?: SearchFilters,
): ResolvedProfileExecution {
  const search: SearchSettings = { ...settings.search, ...(profile.searchOverrides ? profile.searchOverrides(settings) : {}) };
  const filters: SearchFilters = profile.filtersMode === "caller-overridable"
    ? (callerFilters ?? {})
    : { status: profile.status, limit: profile.limit ? profile.limit(settings) : undefined };
  return { search, filters, returnVerdict: profile.returnVerdict };
}
