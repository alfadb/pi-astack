---
doc_type: adr
status: accepted
---

# ADR 0037: memory search Facade — 检索策略 profile registry

- Status: **Accepted**
- Date: 2026-06-14
- Relates-to: ADR 0015(LLM 检索)、ADR 0035(stage0 候选)、ADR 0036(两阶段塌缩 + 多向量); 本 ADR 不改检索算法, 只收口"调用方策略层"

## 1. 问题: 检索内核已统一, 但每个调用方"手搓 policy"会漂移

实际 call graph(代码核实, 非记忆): 所有 LLM 语义检索都汇聚到 `extensions/memory/llm-search.ts` 的 `executeSearch`(→ `selectStage0Pool` + `runTwoStageSearch`), 只有两个薄包装 `llmSearchEntries` / `llmSearchEntriesWithVerdict`。5 个调用方:

- `memory_search` 工具 — `index.ts:380` `llmSearchEntries`(LLM 给 filters)
- `memory_decide` 工具 — `index.ts:571` `llmSearchEntries`(built decision query, `status:[active]`, `limit:8`)+ 后续合成
- path-A `before_agent_start` 注入 — `memory-context-injector.ts:400` `llmSearchEntriesWithVerdict`(前置 rewriter, `status:[active]`, `limit:pathA.searchLimit`)
- sediment 去重 curator — `curator.ts` `runMemorySearch("sedimentDedup", ...)`(`status:["all"]`, `limit:5`, 继承全局 `stage1Skip`/`sparseBM25`, 固定 `dedupChunk0Aggregation=true`)
- sediment 纠错 correction — `index.ts:2532` `llmSearchEntries`(`status:[active]`, `limit:10`)

检索算法**已经统一**(不存在两套实现)。没统一的是**策略层**: 每个站点**手搓** `status`/`limit`/`stage1Skip`/`model` + 各自 `loadEntries(...)`(全仓 11 处重解析整库)。这一层漂移已经咬过两次:

- 事故: curator 去重手搓 `status:["all"]` 静默绕过 stage0 优化 → 每 candidate ~915K token 喂 flash(memory: `sediment-curator-dedupe-search-bypassed-adr-0035-stage0-optimization`)。
- ADR 0036 P6: 全局 `stage1Skip` flip 转产时, dedup 站点曾要求手动 pin `stage1Skip=false`(ADR 0036 §9.1 条件 2), 否则全局 flag 会悄悄漏进最脆弱的去重路径(false-merge → corpus corruption)。后续 ADR 0036 P5b 用 dedup-specific 金标与真实检索 oracle 验证后解除该临时 pin, 当前策略是继承全局读栈。

同一类失败: **per-caller 手搓 policy 会漂移 / 全局 flag 会泄漏到不该去的路径**。这是策略分散在 5 处、无单一可审计声明点的直接后果。

## 2. 决策: typed SearchProfile registry + 单入口; 明确**不做** God-Facade

把"已经共享的内核"之上的策略层收口成一组**命名 profile**, 每个角色在**一处**声明它相对 base settings 的差异, 再加单入口应用 profile + 调 kernel。**不做**一个带 role enum 吞下 search+dedup+decide+inject+get/list/neighbors 的巨型 Facade —— 那会拍平本就不同的用例语义、放大 blast radius, 且与 `decideModel` 解耦(memory: `memory-decide-decoupled-from-stage1-via-decidemodel`)、dedup 必须 LLM 语义检索(memory: `curator-memory-search-before-create`)冲突。

## 3. 设计

```ts
interface SearchProfile {
  name: "toolSearch" | "decideSearch" | "pathAInject" | "sedimentDedup" | "correctionSearch";
  filtersMode: "fixed" | "caller-overridable";     // toolSearch=caller-overridable(LLM 给 filters); 其余 fixed
  defaultFilters: { status: StatusFilter[]; limit: (s: MemorySettings) => number };  // limit 是 resolver: pathAInject → s.pathA.searchLimit, 不冻结常量(评审: 冻了则 settings 改后静默漂移)
  searchOverrides?: (s: SearchSettings) => Partial<SearchSettings>;  // 如 sedimentDedup → { dedupChunk0Aggregation: true }
  returnVerdict: boolean;                          // true → withVerdict(path-A); false → plain hits
}
// 单入口: runMemorySearch(profile, query, ctx: { cwd; modelRegistry; signal?; projectRoot?; preloadedEntries?; callerFilters? })
// embeddingOverrides 已删(3×T0: YAGNI + 改 flag 不改 topN 聚合, 无法实现 dedup whole-entry; 待 ADR 0036 P4 聚合工作落地再议)
// pre-corpus shaping(dedup 的 relevantEntriesForCurator + readonly-rule-neighbors)由调用方传 preloadedEntries, 不进 profile(§5)
```

### 3.1 强制(3×T0 评审: load-bearing, 不加则 ADR 失效)

评审三家一致指出: registry 若不强制, `llmSearchEntries`/`llmSearchEntriesWithVerdict` 仍是 public export → 第 6 个调用方仍可直接 import 手搭 policy, “再也漏不进去”为假。必须二选一(偏好 A):

- **(A) 内核私有 + 单导出(首选)**: `executeSearch` / `llmSearchEntries` / `llmSearchEntriesWithVerdict` 都取消 export(模块私有), 仅 export `runMemorySearch` + `SEARCH_PROFILES`。oracle/smoke 脚本(5 个, 非生产)改调 `runMemorySearch(profile, ...)` —— 机械迁移。运行期结构保证, 非 lint-time。
- **(B) lint guard**: `no-restricted-imports` 禁止 facade 模块外直接 import 两个 wrapper, allowlist eval/smoke 脚本。较弱(lint-time)。

没有强制, registry 等于“加了第二种做法而 footgun 仍在” —— 与“lint + 例外”同级, 不值得做。强制后 registry > lint: lint 表达不了 profile 级策略约束, 例如 `sedimentDedup` 必须同处声明 `status:[all]`、`limit:5` 与 dedup 专用覆写。P6 时该覆写是 `stage1Skip:false`; P5b 后更新为只固定 `dedupChunk0Aggregation:true`。

- **registry**: `SEARCH_PROFILES`(const, 单文件)。每个 profile 声明上面 5 个调用方今天手搓的那套 policy —— 迁移是机械替换。
- **单入口**: `runMemorySearch(profile, query, ctx, { filters?, preloadedEntries? })` → `resolveSettings()` → 应用 `profile.searchOverrides`/`embeddingOverrides` → `loadEntries`(或用 `preloadedEntries` 复用)→ 按 `returnVerdict` 选 kernel 包装 → 返回。
- **profile 钉死策略**: `sedimentDedup` 的固定策略在 profile 一处声明。P6 时它取代 curator.ts 的手动 `stage1Skip:false` pin; P5b 验证后解除 `stage1Skip`/`sparseBM25` 临时 pin, 当前仅保留 `dedupChunk0Aggregation:true`。
- **rewriter / synthesis 留在调用方**: profile 只声明**检索策略**, 不吞整条管道。path-A 的 rewriter、decide 的合成仍在各自 handler —— 用例语义不被拍平(见 §5)。
- **loadEntries 共享(可选优化, 非必需)**: 单入口可接 `preloadedEntries`, 让同一 turn 内多次检索复用一次解析; 但这是第二序优化, 不阻塞本 ADR 主目标(策略收口)。

## 4. 不变量 / 约束

- 不改检索算法: stage0/两阶段/多向量/freshness 全部不动; 本 ADR 是纯重构 + 策略显式化。
- 保留 settings 可配置(memory: `search-models-must-be-settings-configurable`): profile 声明**默认**, settings 仍可覆写; profile 不硬编码 model id。
- 保留语义分离: dedup 近重 ≠ search 召回 ≠ decide 合成 ≠ path-A 注入(ADR 0036 §2)。
- 零 npm 运行时依赖。
- 行为等价(3×T0 强化): **deterministic 单测**(非 LLM smoke)断言每 profile 迁移后等价于迁移前, 不止 resolved SearchSettings, 还须覆盖: (a) **entries-arg identity** —— dedup 喂的是 `relevantEntriesForCurator` + readonly-rule-neighbors 后的不同 corpus, 单测须确认 preloadedEntries 一致(否则 entry-set 漂移过 settings 门也静默); (b) toolSearch 的 LLM filter-merge(`normalizeSearchFilters({})` 行为); (c) decide 的 search model == `stage1Model`(合成走 `decideModel`, 二者保持解耦); (d) path-A `limit` resolver == `s.pathA.searchLimit`。

## 5. 明确不收口的(故意保留)

- `memory_get`(findEntry 精确)/`memory_list`(listEntries 浏览)/`memory_neighbors`(graph 遍历)走 `search.ts`/`graph.ts`, **不是排序检索**, 不进 SearchProfile。可并入同一 Facade 模块当独立方法以便发现, 但保留各自非排序实现。
- rewriter(path-A)、decision synthesis(decide)、near-dup merge 判定(dedup)等**角色专属前/后处理**留在各自调用方。

## 6. 实施计划(分阶段, 提案通过 + 评审后)

| Phase | 内容 | 门 |
|---|---|---|
| P1 | `SearchProfile` 类型 + `SEARCH_PROFILES` + `runMemorySearch` 单入口 + **§3.1 强制(私有内核/单导出)** + deterministic 等价单测 | 单测: 5 profile 等价(含 entries-arg/filter-merge/model/limit-resolver) |
| P2 | 迁移 1 个**可逆读路径**(`correctionSearch` 或 `toolSearch`)先验证 facade+gate(输出错可见、不毁数据) | 该路径行为等价 + 单入口为唯一通路 |
| P3 | 迁移其余读路径 + **最后**迁 `sedimentDedup`(把当时已存在的 `stage1Skip=false` pin 平移进 profile; 后续 P5b 已解除该临时 pin) | dedup 行为等价; P5b 后 dedup 继承全局 stage1Skip/sparseBM25, 仅保留 chunk0 聚合 pin |
| P4 | (可选)单 turn loadEntries 复用 | 解析次数下降, recall 不变 |

**执行结果(本次)**: P1(search-profiles.ts + runMemorySearch + smoke-search-profiles 19/19)、P2/P3(5 调用方迁 runMemorySearch; curator 手搓 dedupSettings 删除; llmSearchEntries/WithVerdict un-export 为私有, 仅 `__oracleKernel` test-export 给 4 个 oracle/smoke; smoke-search-profiles grep-guard 断言 extensions/ 无裸 wrapper 调用)均完成。executeSearch 本就私有。后续 ADR 0036 P5b 进一步验证 dedup dense-only 后解除 `stage1Skip`/`sparseBM25` 临时 pin; 当前 smoke 保证 sedimentDedup 继承全局二者, 并强制 `dedupChunk0Aggregation=true`。P4 loadEntries 复用列为可选未做。

**排序修订(3×T0 分歧裁决)**: opus 指 dedup-first 是**最危险**(false-merge 不可逆 + all-status 路径无金标验证), deepseek 指 dedup policy **最简单可无损迁**。裁决: 当时 dedup 的 `stage1Skip=false` pin 已存在(curator.ts dedupSettings), 故无紧迫性先迁; 先在可逆路径证 facade+gate, 最后平移 dedup pin 进 profile。后续 P5b 验证解除的是这个临时 pin, 不改变本 ADR 的核心: 调用方策略必须集中在 profile registry。

## 7. 盲区 / 风险

- **过度抽象风险**: 若 profile 字段不够表达某调用方真实需求, 会逼出"逃逸 hatch"(直接传 settings), 退回手搓。缓解: profile 字段从 5 个**现存**站点反推, 不预设未来。
- **行为漂移**: 迁移本身可能引入与现状不等价的 policy。缓解: P1 的"resolved settings == 快照"smoke 是硬门。
- **embeddingOverrides 与共享索引**: dedup 想要"whole-entry 相似"但全局向量索引是多向量(若 ADR 0036 P4 转产), `embeddingOverrides` 改 flag 不改 topN 聚合(ADR 0036 §10.4 条件 2 已记)。本 ADR 只预留字段, 真正的 dedup 聚合分离留给 P4 flip 的独立工作。
- **收益是"防未来 bug + 可审计", 非当下 recall/成本**: 不要用 recall 数字证明本 ADR; 它的价值是结构性消灭 bypass 那一类事故。

## 8. 备择(已评估)

- **现状(手搓 policy)**: 最不对齐 —— 保留了已发生两次的 bypass/leak 失败模式(第二大脑 contradiction check 明确指出)。
- **God-Facade(单函数 + role enum 吞所有读路径)**: 拒绝 —— 拍平语义、与 decideModel 解耦冲突、blast radius 过大。
- **typed profile registry(本 ADR)**: 第二大脑推荐项; 收口策略层而不动内核与语义。

## 9. 3×T0 设计评审(本次)

3×跨厂商 T0(`claude-opus-4-8` / `gpt-5.5` / `deepseek-v4-pro`, 各自读 ADR + 5 调用方 + kernel)—— **三家一致 GO-WITH-REVISIONS, 无 reject**。共识: call-graph 准确(5 调用方全走 `executeSearch`, 无遗漏; 另 5 个 oracle/smoke 脚本调用方非生产); kernel 已统一、仅 policy 漂移诊断成立; profile registry(非 God-Facade)方向对。已并入的修订:

1. **强制(critical, 三家)**: §3.1 —— 私有内核 + 单导出(或 lint guard), 否则 registry 仅 advisory, 同类 bug 会复发。
2. **profile 字段(三家)**: 删 `embeddingOverrides`(YAGNI + 无法实现其目的); 加 `filtersMode`(toolSearch caller-overridable vs 其余 fixed); `limit` 改 **resolver**(path-A 的 `pathA.searchLimit` 跨 settings 子树, 冻结常量会静默漂移 —— opus 尖锐); ctx 透传 signal/projectRoot/modelRegistry/preloadedEntries(gpt)。
3. **等价门强化(opus+deepseek)**: deterministic 单测 + entries-arg identity + decide-model==stage1Model + toolSearch filter-merge(见 §4)。
4. **排序裁决(opus vs deepseek 分歧)**: 不 dedup-first; 可逆路径先证机制, 当时 dedup pin 已存在故最后平移(见 §6)。
5. **vs 纯 lint**: 三家认同 lint 表达不了 profile 级不变量, 且会误报唯一合法的 dedup all-status 站点; **强制后的 registry > lint**, 但开放导出的 registry ≈ lint+例外, 不值得。
