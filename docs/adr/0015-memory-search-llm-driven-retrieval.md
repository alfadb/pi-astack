# ADR 0015 — memory_search 升级为双阶段 LLM-driven retrieval

- **状态**：Accepted（2026-05-10；Phase 0/1 已实现；Phase 2 被 [ADR 0016](0016-sediment-as-llm-curator.md) 扩展；2026-05-11 修正 D3：Stage 2 默认从 v4-pro+thinking=high 降为 v4-flash+thinking=off，因精排是相关性判断非逻辑推理任务）
- **日期**：2026-05-10
- **决策者**：alfadb
- **依赖**：[ADR 0010](0010-sediment-single-agent-with-lookup-tools.md)（lookup-tools loop 设计，本 ADR 落地其内核）/ [memory-architecture.md](../memory-architecture.md) §6（read facade 契约）/ [brain-redesign-spec.md](../brain-redesign-spec.md) §4（cross-project 召回）
- **被引用**：[archive/migration/memory-search-llm-upgrade.md](../archive/migration/memory-search-llm-upgrade.md)（已完成实施记录）
- **触发**：2026-05-10 一次会话内三件事叠加：
  1. **质量复审**最近 50 条 sediment 沉淀，发现最系统问题是 **D6 自重复**（同义改述被 dedupe 漏过：dotfiles 双条 / memory-list 旧条 / round-3 三联 / dogfood 系列 ~40% 重叠）
  2. **memory_search 实现审查**揭示 5 大短板：CJK 不分词（长中文 query 召回 0 命中实测）/ 无词干化（extract ≠ extracting）/ trigger_phrases 不入索引（设计意图遗漏）/ timeline 不入索引 / substring boost 不可控
  3. **alfadb 明确诉求**："要准确，要能混合检索中英文知识，不考虑成本"——graceful degradation 不变量（"L0 grep 永远在最底"）为准确度让位

## 背景

### 当前实现（Phase 1.3，2026-05-08 落地）

```
rg --files → parseEntry → tokenize(title + slug + compiled_truth)
                       → tf-idf + 4 个 substring boost
                       → × confidence/10 × projectBoost(1.5)
                       → top-N（默认排除 archived）
```

设计目标是"项目级、几百条 entry、英文为主、能跑就行"——明确写在历史 [docs/archive/migration/steps-v7-roadmap.md](../archive/migration/steps-v7-roadmap.md) Phase 1.3。memory-architecture.md 附录 C 曾规划 Phase 3 走 qmd（BM25 + 向量）作为加速层。

### 当前实现的硬伤

实测（2026-05-10）：

| Query | 结果 | 原因 |
|---|---|---|
| `vault read path` | ✅ top-1 准确 | 三纯英文实词，tf-idf + boost 全生效 |
| `沉淀` | ✅ top-1 准确 | 短中文：靠 substring fallback 命中 |
| `知识沉淀提示词` | 🔴 **0 命中** | tokenize 把整段连续 CJK 当**一个 token**，df=0；substring 也匹配不到完整串 |
| `extracting` 找 `extractor` 标题 entry | 🔴 找不到 | 无词干化 |
| `auto-write` vs `auto write` | 🟡 排名不同 | `query.includes` 子串敏感 |

实测召回率在中英混合内容上不可接受，且 **sediment 自己用同一 search 做 dedupe**（lookup-tools loop，ADR 0010）—— search 不准 → dedupe 漏过同义改述 → 自重复 entry 累积，正是 D6 的根因。

### 已被审查否决的替代方案

| 方案 | 否决理由 |
|---|---|
| **修补 grep+tf-idf**（trigger_phrases 进索引 + CJK bigram + 词干化 + timeline 索引） | 局部修补，仍受限于"字面 token 匹配"——同义改述（"自动写入" ≡ "auto-write"）永远搜不到 |
| **qmd（BM25 + 本地 GGUF embedding）** | memory-architecture.md 附录 C 规划但 Phase 3，门槛在 entry > 1000 条；当前 250 条不够触发，且仍是字面/向量召回，不解决跨 entry 推理 |
| **LLM query rewrite**（prompt → keyword 集 → grep） | 部分解决中英混合，但仍受限于 grep 召回；同义改述仍漏 |
| **LLM 整库召回**（250 entry 摘要全塞 LLM 一次） | 准确但单次 token 失控；扩展到 1000+ entry 立即崩 |

## 决策

### D1. 接口不变，内部走 LLM

```
memory_search(query: string /* natural-language retrieval prompt */, filters?)
  → SearchResult[]  // schema 保持不变
```

主会话 LLM 调用方式 zero change。`query` 语义从"关键词"扩展到"自然语言 prompt"——对 caller 透明。

### D2. 双阶段 LLM rerank

```
Stage 0 (本地)：
  build/read enhanced candidate surface。2026-06-12 v3 walk-back 后，运行时 Stage 1 不再只看 frontmatter/enhanced `_index.md`；`extensions/memory/llm-search.ts` 从已解析 entries 内存生成 `surface:full_body_v3` 候选面，每 entry 包含 slug/title/kind/status/confidence/updated/summary/trigger_phrases/related_slugs/compiled_truth/timeline，并对单 entry 做中间截断上限保护。`/memory rebuild --index` 仍生成 frontmatter 型 `_index.md` 作为人类/LLM 可浏览 artifact，不再代表运行时 Stage 1 的完整输入面。

Stage 1 (粗排，可配模型，默认 deepseek-v4-flash，thinking=off)：
  输入: query + 全库 full-body candidate surface（`surface:full_body_v3`）
  输出: top-K 候选 slug + 简短理由（K 默认 50）
  目标: 高召回率。只要有候选，必须进入 Stage 2；不因候选数少而跳过精排。Stage 1 是 broad recall/classification，不开推理；DeepSeek v4 的 minimal/low/medium unsupported，会被 pi-ai clamp 到 high，因此默认必须是 off。

Stage 1.5 (本地)：
  memory_get(slug) × K 拿 candidate 完整 entry（compiled_truth + timeline）

Stage 2 (精排，可配模型，默认 deepseek-v4-flash，thinking=off)：
  输入: query + K 个完整 entry（~60-150k tokens）
  输出: top-N 排序 + 每条相关性分析（rank_reason）
  目标: 高精度排序。**2026-05-11 修正**：原默认 v4-pro+thinking=high。经分析，精排是阅读理解+相关性判断任务，非逻辑推理任务——timeline 证据（"X supersedes Y"）是阅读事实不是推理链。thinking 模式对排序质量零增益，改回 v4-flash+thinking=off。
```

### D3. 默认全 deepseek 家族（2026-05-11 修正：Stage 2 reasoning 降为 off）

| Stage | 默认模型 | 理由 |
|---|---|---|
| Stage 1 | `deepseek/deepseek-v4-flash` + `thinking=off` | 国内访问无跨国延迟（alfadb 首要诉求）；粗排是 high-volume eval 任务，flash 甜区；不开推理避免过度筛选和 DeepSeek minimal→high clamp |
| Stage 2 | `deepseek/deepseek-v4-flash` + `thinking=off` | **2026-05-11 修正**：原为 v4-pro + thinking=high。经实测，精排是阅读理解+相关性判断任务，非逻辑推理任务——thinking 模式对排序质量零增益，纯增延迟。改用 v4-flash + thinking=off：更快、更便宜、质量等价 |

**单 family 风险**：sediment extractor 也是 v4-pro，deepseek 服务一挂两个子系统同时失能。可接受理由：
- sediment 是 fire-and-forget；ADR 0016 已删除 rolling pass-rate fuse，失败通过 audit/git 诊断，auto-write 不把低准确度 fallback 结果写入知识库
- search 用 hard error（不 fallback grep），用户能立即感知模型/网络问题并修复，不拿低准确度结果继续工作
- 单 family 风险换国内速度 + reasoning + 中文质量，对 alfadb 主用场景是合理 trade-off
- **任何用户/任何环境随时可通过 settings 切异构**（D4）

### D4. 全部模型可配（settings schema）

```jsonc
{
  "memory": {
    "search": {
      "stage1Model": "deepseek/deepseek-v4-flash",
      "stage1Limit": 50,
      "stage1Thinking": "off",
      // Stage 2 默认 v4-flash + thinking=off（2026-05-11 修正）。
      // 需要更强中文语义匹配时可切 v4-pro:
      // "stage2Model": "deepseek/deepseek-v4-pro",
      "stage2Model": "deepseek/deepseek-v4-flash",
      "stage2Limit": 10,
      "stage2Thinking": "off"
    }
  }
}
```

切异构 example：`stage2Model: "anthropic/claude-opus-4-7"` 或 `"openai/gpt-5.5"`。

### D5. 失败模式：hard error，且没有 grep 降级路径

理由：用户明确诉求是"准确"。grep fallback 会让"准确"约束变成时灵时不灵——LLM 不可用时主会话拿到的结果突然变弱，用户无感知。hard error + 工具描述里说明"依赖 LLM"，让用户在网络/服务异常时立即看到错误信号并修复模型/网络/配置。**不提供 `MEMORY_SEARCH_GREP_ONLY`、`fallbackToGrep` 或空模型退回 grep 的开关。**

graceful degradation 原则（memory-architecture.md §3 第 8 条）**显式让位于准确度**——这是设计选择，不是 bug。

### D6. 不做 result-level 缓存

同 5 分钟内重复 query **不复用前次的最终 stage 2 返回结果**（slug 列表 + score）。理由：sediment 高频写入，result cache 反而误导（刚写入的 entry 不在 cache 里，但它应该被召回）。运行时每次从已解析 entries 生成新的 `surface:full_body_v3` 候选面，因此刚写入的 entry 会立即进入 Stage 1 输入面。

本决策仅关 result-level cache。provider-side prompt KV cache 是另一层，在 [D9](#d9-provider-side-prefix-kv-cache-主动优化) 中主动优化（不矛盾：同一份候选面 token prefix 可被 provider KV 复用，不影响“刚写入的 entry 被召回”语义；候选面变化时 cache 自然失效）。

### D8. 新鲜度与时间精度

Stage 2 内部读取完整 timeline，结果 card 只暴露 `created` / `updated` / `rank_reason` / 最近 1-2 条 `timeline_tail`。完整 timeline 仍通过 `memory_get(slug)` 获取，避免 search surface 污染主上下文。

sediment 新写入的 `created` / `updated` / timeline 时间戳改为本地 ISO datetime（如 `2026-05-10T22:41:36+08:00`），不再只写日期。理由：每天可能产生几十条 entry，date-only 无法区分同日 supersession / rapid correction。旧 entry date-only 保持兼容，不批量迁移。

## 后果

### 正面

- ✅ **中英混合检索**：LLM 双语原生理解，"沉淀" ≡ "sediment"
- ✅ **同义改述召回**：跨 entry 推理识别"实质同一洞察"（彻底解决 D6 自重复——见 D7）
- ✅ **trigger_phrases / timeline 自动入参**：Stage 1 `surface:full_body_v3` 与 Stage 2 完整 entry 都包含；结果 card 返回 `rank_reason` + `timeline_tail` + `created/updated` 新鲜度信号
- ✅ **接口不变**：所有 memory_search caller 零改动
- ✅ **可配置 + 默认合理**：默认 ds 家族符合 alfadb 主用场景；任何环境可切异构

### 负面（已接受）

- 🟡 **延迟 +15-20s/call**：alfadb 明示"不考虑"；Stage 2 不跳过
- 🟡 **成本 ~$0.045/call**：alfadb 明示"不考虑"；1000 次 ≈ $45
- 🟡 **Stage 1 prompt 体积显著增加**：F18 后每 entry 最多带 12k chars 正文/timeline，召回准确性优先于旧 prompt-cache 紧凑性；若 `stage1_surface` token 体积导致模型 context/timeout hard-error，再以 search-metrics/path-a-ledger 数据决定是否加总量预算或分片。
- 🟡 **graceful degradation 不变量打破**：LLM 不可用时 hard error，不提供 grep 降级
- 🟡 **单 family 失败**：deepseek 挂同时影响 sediment extractor + search；可通过 settings 异构化规避

### D7. 副作用：为 sediment curator 解决 D6 自重复提供 lookup 内核

ADR 0010 设计的 lookup-tools loop 由此真正落地：sediment curator 在 create 前调 `memory_search("找与这个候选知识语义相关、可能应被更新/合并/跳过的旧条目：...")`，LLM 返回相关旧 entry 及 timeline/freshness 证据。ADR 0016 进一步修正：目标不是把语义近邻简化成 `duplicate => reject`，而是让 curator 输出 update/merge/skip/create 等 operation，从 append-only 转向知识自我演化。

### D9. provider-side prefix KV cache 主动优化

**决策**：Stage 1 / Stage 2 prompt 采用 **instructions-first / index-first ordering**，主动让支持 prefix-level KV cache 的 provider（Anthropic / OpenAI / DeepSeek 都支持不同程度）复用上一次 call 的前缀 tokens。**2026-06-12 walk-back**：F18/ADR 0026 §3.0.3 候选 C 已落地，Stage 1 从 frontmatter 型 index 升级为 `surface:full_body_v3`，prefix 体积显著增大且 cache 命中收益可能下降；这是对旧“Stage 1 只看 `_index.md` 以优化 prompt cache”的显式撤回。当前优先级是召回准确性，cost/cache 不再是 P0 约束。

**实现位置**：
- Stage 1：`extensions/memory/llm-search.ts` `makeStage1Prompt`——instructions 块及 `surface:full_body_v3` candidate surface 放在 query 之前。
- Stage 2：`extensions/memory/llm-search.ts` `makeStage2Prompt`——instructions 块固定列首，candidates 和 query 可变但 prefix 仍可被缓存。

**与 D6 的关系**：
- D6 关的是 **result cache**（“5 分钟内同 query 复用上次返回的 slug 列表”）——锁闭，避免 sediment 刚写入的条目不被召回。
- D9 开的是 **prompt KV cache**（“provider 看到相同 prefix tokens 复用 attention KV”）——主动优化，减少 input token 计费与延迟。
- 两者不矛盾：provider KV cache 复用的是 “token 序列的计算结果”而不是 “LLM 输出的 slug”；sediment 刚写入的 entry 会出现在新的 `surface:full_body_v3` 候选面里，LLM 还是会看到它并被召回。

**可观测性**：cache hit/write tokens 被记到 D10 描述的 `search-metrics.jsonl`（`s1.hit / s1.write / s2.hit / s2.write`），供 alfadb 调优 stage1/2 model 选型时作依据。

### D10. search-metrics.jsonl 可观测性

**决策**：每次 `memory_search` 调用追加一行 JSON 到 `<project>/.pi-astack/memory/search-metrics.jsonl`（`extensions/memory/llm-search.ts` `logSearchMetrics` + `extensions/_shared/runtime.ts` `memorySearchMetricsPath`）。

**状态**：experimental。schema 未冻结，以 `llm-search.ts` `logSearchMetrics` 实际写入字段为准。当前实现：

```jsonl
{
  "ts":      "2026-05-12T03:14:15.926Z",   // ISO timestamp
  "query":   "找关于 XXX 的 durable rule",     // 前 80 字符
  "s1":      { "in": <n>, "out": <n>, "hit"?: <n>, "write"?: <n> } | null,
  "s2":      { "in": <n>, "out": <n>, "hit"?: <n>, "write"?: <n> } | null,
  "results": <n>,                             // 最终返回 slug 数
  "verdict": "has_relevant" | "none" | "unknown",
  "stage1_surface": "full_body_v3",
  "via"?:    "path-a"
}
```

- `hit` / `write` 字段仅在 provider 返回 cache 元数据时出现：
  - Anthropic：`cacheRead = cache_read_input_tokens` / `cacheWrite = cache_creation_input_tokens`
  - OpenAI：`cacheRead = input_tokens_details.cached_tokens` / `cacheWrite = 0`（不报 write）
  - DeepSeek：pi-ai 包装读不到则两个字段省略
- 写入是 best-effort（写入失败静默 swallow），不影响 search 主路径
- 读存放目录权限 0o700，文件 ignored by git（`.pi-astack/` 顶层）

**用途**：
- 诊断：cache hit 率过低 → prompt 顺序 / stage1 model 变动过频
- 成本：加总 input/output token 估算某项目的 search 月成本
- 实验：调 stage1Model / stage2Model 后对比指标变化

**未决**：schema 是否 冻结、是否应该提供 `pi memory metrics-summary` 之类的 CLI 聚合工具 —— 保留为开放问题，等 alfadb 使用一段时间后决定。

## 实施路线

详见已归档完成记录 [archive/migration/memory-search-llm-upgrade.md](../archive/migration/memory-search-llm-upgrade.md)：

- **Phase 0**：增强 `_index.md` 格式（已实现）
- **Phase 1**：实现 `extensions/memory/llm-search.ts` + tool 路由 + settings schema（已实现）
- **Phase 2**：sediment curator 在 create 前调新 search，优先 update/merge/skip，create 次之（ADR 0016）
- **Phase 3**：memory-architecture / brain-redesign-spec 全量文档对齐 + ADR 0010 状态从 deferred 升 implemented

## 与现有 ADR 的关系

- **ADR 0003**（主会话只读）：保留，新 search 仍是只读
- **ADR 0010**（sediment 单 agent + lookup tools）：本 ADR 落地其 lookup tools 内核（D7）；状态从"核心思想保留 / tools 过时"升级为"核心思想保留 / tools 实现"
- **memory-architecture.md §6.1**（read facade 契约）：搜索接口语义扩展（query 从 keyword 升级为 prompt），但 schema 不变；§3 第 8 条 graceful degradation 不变量打破，新增 D5 注释
- **brain-redesign-spec.md §4.1**（默认查询面 RRF 融合）：本 ADR 把"text score × confidence × projectBoost"的字面 ranking 替换为"LLM rerank"，但 §4.1 的 ranking surface boost 系数仍可作为 stage 1 prompt 的输入提示
