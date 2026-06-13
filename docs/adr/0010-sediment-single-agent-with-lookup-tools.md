---
doc_type: adr
status: accepted
---

# ADR 0010 — sediment 单 agent + lookup tools 写入策略（v6.6，v6.8 仍用）

> 🗄️ **ARCHIVE-CLASS · 机制存档 / PENDING-INGEST（Phase-2，3×T0 mark-in-place）**：单 agent 内核已演化为 0016 LLM curator；但正文的“3-model 投票失败 5 根因”是**不可代替经验证据**（待 ingest 分解入库）。机制正文原地保留可读、物理归档延后至 abrain ingest lane 落地，勿移勿删。

> ⚠️ EVOLVED / PARTIALLY HISTORICAL：单 agent + lookup kernel 被 ADR 0016/0015 继承；`SKIP_DUPLICATE`、`## GBRAIN`、`runGbrainAgent`、`gbrain put` 等 protocol 只作为历史快照。

- **状态**: Accepted (evolved 2026-05-10)。单-agent 内核保留并由 [ADR 0016](0016-sediment-as-llm-curator.md) 继承为 LLM curator；lookup-tools loop 内核由 [ADR 0015](0015-memory-search-llm-driven-retrieval.md) D7 落地为 curator dedup（create 前调 `memory_search` 识别语义近邻）；SKIP_DUPLICATE / ## GBRAIN 终结符已退役，SKIP 保留为 extractor→sediment runner 空结果信号（no candidate to write）；写入 substrate 从 `gbrain put` 转为 sediment 内部 writer（create/update/merge/archive/supersede/delete/skip），不暴露 LLM-facing 写工具。
- **日期**: 2026-05-06
- **决策者**: alfadb
- **替代**: ADR 0004（v6.5 三模型投票方案）
- **依赖**: ADR 0002（superseded by memory-architecture.md）/ ADR 0003（主会话只读）/ ADR 0009（multi-agent 自由化，但 sediment 不再借用）
- **互补**: ~~ADR 0012（v6.8 双 target，已 superseded by memory-architecture.md）~~ → ADR 0015（lookup-tools loop 落地） + ADR 0016（curator 决策模型：create/update/merge/archive/supersede/delete/skip）

> ⚠️ **本节为 v6.6 历史快照**。以下技术细节描述的 protocol（`SKIP` / `SKIP_DUPLICATE` / `## GBRAIN` 终结符 / `runGbrainAgent` / `gbrain put` / `gbrain_search` 等）当前**代码中不存在**——已由 ADR 0015 D7（curator dedupe + frontmatter + compiled truth + `## Timeline`）+ ADR 0016（LLM curator pipeline）取代。当前 sediment 实际模块组成见 `extensions/sediment/` 直接读源（curator.ts / dedupe.ts / extractor.ts / llm-extractor.ts / writer.ts 等）。

## 背景

ADR 0004 设计了 v6.5 的三模型投票 + JSON schema + quorum 聚合 + schema-enforcer 二次生成 流水线。在端到端调试中暴露了五个根本问题：

1. **独立性假设破产**。三个 voter 拿同一个 vote prompt，看到同一段对抗内容时**同向漂移**。实测 gpt-5.5 + claude-opus-4-7 同时报 `injectionSuspected=true`，因为 vote prompt 本身的 marker 示例（"ignore previous"）被它们当成注入。多模型只能抵御**模型偶发漂移**，无法抵御**共享 prompt 的系统性漂移**。
2. **JSON 输出 100% parse error**。三种失败叠加：（a）DeepSeek 用 ` ```typescript ` 代码块包裹 JSON；（b）DeepSeek 中文 prose 前言"让我分析上下文数据结..."；（c）Claude 上下文太大耗 token，最后 JSON 字符串截断。**只要让 LLM 输出强结构化格式，模型自由度被剥夺，鲁棒性即崩**。
3. **每轮成本失控**。一轮 agent_end ≈ 100K-365K tokens × 3 voter × thinking=high ≈ 1M tokens。绝大多数轮次 voter 判 SKIP，**主要成本花在反复看历史确认"还是没什么好沉淀的"**。
4. **无 checkpoint 机制**。每轮重新跑完整 1700+ entries branch，连续 reload 上下文叠加到 365K tokens 也不裁剪过去已处理过的部分。**v6.5 文档假设上下文是当前 turn 的局部对话，实际是全 session history**。
5. **quorum dedupe 是事后弥补**。三个 voter 各自判"这条值得写"才是有 dedupe 价值的——但它们看不到现有 gbrain 内容，所以经常**多 voter 同意写一条已经存在的页**。dedupe 应该在写入前由模型主动查重，而不是靠 quorum 投票。

老 pi-sediment（claude-code 时代）从未踩这些坑——它用的是**单 agent + lookup tools + markdown 终结符**。这套设计经历了几个月的生产，没出过 parse error 和重复写入。

## 决策

**v6.6 sediment 流水线**（替代 v6.5）：

```
agent_end (sync capture)
  ↓ setTimeout(0)              ← 不阻塞主会话
ctx.sessionManager.getBranch() → 完整 1700+ entries 历史
  ↓
buildRunWindow(branch, since=lastProcessedEntryId)
  ↓                            ← checkpoint 机制：仅新增 entries
  ├─ window 为空 → SKIP（无新增）
  └─ window 太小 → SKIP + advance checkpoint
  ↓
buildWindowText: ≤200K chars，倒序拼接保证最新 entry 不丢
  ↓
secret scan (pre-LLM redact)   ← 防止 secret 发往外部 provider
  ↓
runGbrainAgent (单 agent loop):
  - model: deepseek/deepseek-v4-pro (默认) / claude-opus-4-7 (可选)
  - reasoning: high
  - tools: gbrain_search, gbrain_get  ← lookup tools，非 voting
  - 输出: markdown，4 个终结符之一：
    A. SKIP                      → 无沉淀价值
    B. SKIP_DUPLICATE: <slug>   → 现有页已覆盖
    C. ## GBRAIN mode=update    → 在已有页上追加 timeline
    D. ## GBRAIN mode=new       → 写新页
  ↓
parse markdown (非 JSON.parse) → 正则提取 header 字段 + body
  ↓
post-LLM secret rescan        ← 防 voter 输出反向引入 secret
  ↓
gbrain put → markdown export → advanceCheckpoint
```

### 为什么单 agent 比多 voter 强

| 维度 | v6.5 多 voter | v6.6 单 agent |
|---|---|---|
| **独立性** | 假独立——共享 prompt → 同向漂移 | 不假装独立，靠 lookup tools 真实查重 |
| **输出鲁棒性** | 强制 JSON → 0% parse 成功率 | markdown 终结符 → 100% 解析成功 |
| **dedup 机制** | 事后 quorum 聚合（盲投票） | 模型主动 `gbrain_search` + `gbrain_get` 查重 |
| **成本** | 3× 模型调用 × 大上下文 | 1× 模型调用 × 增量 window |
| **可观测性** | quorum 内部黑盒 | 每个 tool call 都进 audit log |

### 为什么 markdown 不 JSON

观察：要求 LLM 输出严格 JSON，会逼模型在三个层面做权衡：
- 内容流畅性（自然 prose） vs 结构正确性（合法 JSON）
- 思考链（中文/英文 prose） vs 终态输出
- 使用代码块包裹（```json） vs 裸输出

任何一个权衡偏向"自由"，JSON.parse 就会炸。

老 pi-sediment 的方案：**header 用键值对（regex 提取）+ body 用任意 markdown（regex 切到 `__CONTENT__` 之后）**。LLM 不需要做 JSON 转义，body 里能放代码块、引号、emoji、外语，全都正常。

```
## GBRAIN
mode: update
update_slug: existing-slug
title: Present-Tense Imperative Headline
tags: engineering, topic
__CONTENT__
# Title
## Principle
...任意 markdown 内容...
## Timeline
- **2026-05-06** | pi-astack-sediment — 一句话
```

### 为什么默认 deepseek-v4-pro 不 claude

实测对比（同一段 1900 entries / 200K chars context）：

| Model | Turns | Tool Calls | Duration | Verdict |
|---|---|---|---|---|
| claude-opus-4-7 | 6 | 12 | 85s | write new |
| deepseek-v4-pro | 4 | 8 | 69s | SKIP（确认已存在） |

deepseek-v4-pro 在这个评估任务上**判断更利落**（4 vs 6 turns），**dedup 更准确**（直接 SKIP 因为前一轮的 page 已经覆盖），**成本低 5×**（$0.43/M vs $5/M）。reasoning=high 即可，不需要 xhigh。

### Checkpoint 机制

`~/.pi/.gbrain-cache/sediment-checkpoint.json`：

```json
{
  "lastProcessedEntryId": "50db8092",
  "updatedAt": "2026-05-06T11:00:06.957Z"
}
```

**只有终态成功才推进**：
- SKIP / SKIP_DUPLICATE / write success → advance
- parse_failure / network error / write error → 保留，下轮重试同窗口

**Compaction 兼容**：如果 lastProcessedEntryId 在新 branch 中找不到（被 compact 删了），降级为只看 head（窗口大小=1），避免重放整个 pre-compaction 历史。

### 配置加载

`extensions/sediment/config.ts` 三级 fallback：

1. **环境变量**（最高优先级，临时调试）：`PI_STACK_SEDIMENT_MODEL` / `_REASONING` / `_TIMEOUT_MS`
2. **`~/.pi/agent/settings.json` → `piStack.sediment.singleAgent.{model,reasoning,timeoutMs,minWindowChars,maxTokens}`**
3. **defaults**：`deepseek/deepseek-v4-pro` + `reasoning=high` + `timeoutMs=180000` + `minWindowChars=200` + `maxTokens=16384`

每次 session_start 把当前 config 写入 audit log 的 `session:start` 条目。

## 安全性继承

v6.5 的多层注入防御**绝大部分保留**——只是不再依赖 quorum：

| 层 | v6.5 实现 | v6.6 实现 |
|---|---|---|
| **pre-LLM secret scan** | 同样保留 | 同样保留（pre-prompt redact） |
| **marker scanner** | pre-voter 拦截 | 继续保留（当前 dogfooding 暂 bypass，待恢复） |
| **lookup tools 只读** | N/A | gbrain_search/get 只读，无 mutation tool 暴露 |
| **content sanitizer** | schema-enforcer 二次过滤 | post-LLM secret rescan + injection 模式扫描 |
| **pending queue** | 失败兜底 | 同样保留——parse_failure / write 失败入 queue |
| **scratch repo skip** | 同样保留 | 同样保留 |

**关键改进**：v6.6 不再有"schema-enforcer 把 voter 输出再喂给 LLM"这个二次注入面。markdown 直接由正则解析，不再走第二次 LLM。

## 影响

### 模块变更（pi-astack/extensions/sediment/）

新增：
- `entry-text.ts` (129 lines) — entryToText / contentToText / buildWindowText
- `checkpoint.ts` (134 lines) — lastProcessedEntryId 持久化 + buildRunWindow
- `lookup-tools.ts` (124 lines) — gbrain_search / gbrain_get（去 pensieve）
- `agent-loop.ts` (229 lines) — multi-turn LLM with tool use
- `gbrain-agent.ts` (342 lines) — markdown 协议 + parser
- `config.ts` (~100 lines) — 三级配置加载

废弃归档（`.v6.5-archive/`）：
- `voter.ts` — 多 voter 派发 + JSON parse + quorum
- `classifier.ts` — dry-run 路径 light classifier
- `marker-scanner.ts` — （暂时停用，不在归档）
- `context-budget.ts` — 自适应上下文裁剪（被 entry-text + checkpoint 取代）

修改：
- `index.ts` 重写——从 voter → gbrain-agent，加 checkpoint，加 config，修底栏 state icon

### 文档变更

- ADR 0004 标记为 superseded
- 本 ADR (0010) 为新决策
- `docs/memory-architecture.md` 需更新 voter/quorum 段
- `defaults/pi-astack.defaults.json` 加 `singleAgent` block

### 不变量保留

- gbrain 是唯一记忆存储（ADR 0002）
- 主会话只读（ADR 0003）
- gbrain CLI 写入仍由 sediment 独占（ADR 0008 写入侧 trust guard）
- multi-agent 仍是基础能力（ADR 0009）但 sediment 不再使用——单 agent loop 不需要 dispatch_agents

## 替代方案（被否决）

- **保留 v6.5 框架，仅修 JSON parse**：治标不治本——本质问题是"强制 JSON"和"假独立性"。
- **混合方案：单 voter + 仅 maxim 时 2nd voter**：增加复杂度，maxim 的判断本身也不需要二次校核（lookup tools 已经够了）。被 v6.6 完整方案碾压。
- **完全照搬老 pi-sediment**：可行但需要重新接 v6 的 ctx + ModelRegistry + ExtensionAPI。本 ADR 是这个方案的 v6 适配版本——保留架构精髓，按 pi 0.73+ 接口重写。

## 后续

- [ ] 恢复 marker scanner（当前 dogfooding bypass）
- [ ] 加 gbrain doctor cold-start 检测（当 page < 10 时倾向 NEW）
- [ ] 监测 deepseek-v4-pro 长期表现（reasoning=high 是否稳定）
- [ ] 考虑 prefix cache 优化（system prompt 静态 + branch 增量）
