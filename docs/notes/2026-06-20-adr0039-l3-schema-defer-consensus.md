# ADR0039 §4.5 L3 schema — chunks/embeddings + graph 表 evidence-defer 共识（2026-06-20）

> 单轮 4×T0 跨厂复审，**4/4 SIGN evidence-defer**（opus-4-8 / gpt-5.5 / deepseek-v4-pro /
> kimi-k2.7-code；主会话主持不投票）。这是 continuation 列出的「L3 §4.5 missing-schema」项；
> P4-a/P5/L2-机制+preflight/Knowledge-coverage 本会话已完成，不重做。

## 决定（4/4 一致）

ADR0039 §4.5 建议表边界里缺的 `chunks`/`embeddings`（向量）+ `graph_nodes`/`graph_edges`（图）：
**两组都 evidence-defer，不补齐。** 现已编码落地（非仅 note）。

### 为什么 defer（一致论据）

- **向量已在 L3 之外服务**：ADR0035 向量管线把 vector 存在
  `~/.abrain/.state/memory/embeddings.json`（content-hash keyed、model+dim 戳、model/dim
  不匹配即丢弃重建、gitignored .state）。在 L3 建 `chunks`/`embeddings` = 写第二份没人读的索引
  + 多一条 drift 面。deepseek 逐链核实其**可由 L1+L2 重建**（re-embed），无 hidden-SOT 风险。
- **图层零消费者**：grep `graph_nodes`/`graph_edges`/multi-hop → 无。`event_edges` 已覆盖
  event 级因果 DAG。建图表 = 100% dead schema。
- **ADR 自身原则**：§4.5 line 95（向量/图邻接首期留 SQLite，只有真实负载可复现瓶颈+证据才拆）
  + line 217（没有真实负载证据就拆 = 架构过早依赖化）。补空表是对 line 217 的教科书违反。

### §4.5 不变量澄清（4/4，opus/deepseek 主张）

§4.5 的约束力不变量是 **boundary**（L3 是派生索引、必须可由 L1+L2 重建、绝不成为 hidden SOT，
line 215），**不是 completeness**（不是「每个建议表都必须存在」）。`embeddings.json` 过此 boundary
检验（派生 / 可丢 / 可重建 / model-stamped / 同 .state 生命周期）→ **不是 §4.5 违规**，是可接受的
独立派生索引。真正要守的是 opus 点出的「**单一 reconcile 权威覆盖多个派生索引的 registry**」
（多索引 = 多 freshness 路径），而非「单文件」。

## 编码（综合 4 票，DEFER 一致 / encoding 3-1 梯度 → 取安全中庸）

落在 `extensions/sediment/adr0039-l3.ts`：
1. **DDL 注释**（openDatabase）：说明缺表是故意的 + 理由 + 向量在哪 + 指向本 note 的 evidence-gate。
2. **`meta('schema_deferred', …)` 行**（每次 sync 写）：可 `sqlite3 … select * from meta` 查询的
   durable receipt——缺表是「故意 deferred」非「忘了」。
3. **安全 tripwire**（deepseek form）：若未来 CREATE 了任一 deferred 表却留下 partial/stale 行
   （半截迁移漏数据），sync 记 `deferred_table_has_data:<table>` failure。**对缺表(预期态)永不报错**
   —— 直接回应 kimi 的反对（不写「断言缺席」这种只在别人做对时才失败的测试）。

> encoding 谱系：opus（registry+freshness reconcile，最重）/ gpt（meta marker+reconcile 断言）/
> deepseek（DDL 注释 + if-exists-must-be-empty 断言）/ kimi（注释+meta 行，无断言，最轻）。
> DEFER 本身 4/4 一致；encoding 取「注释 + meta 行 + 安全 tripwire」中庸，既满足 3/4 的
> machine-checkable，又不犯 kimi 指出的「断言缺席」反模式。

## Evidence-gate（何时翻 defer→补齐，4/4 收敛）

- **graph_nodes/graph_edges**：出现真实 ≥2-hop 实体级遍历消费者（如 memory_search graph-walk /
  memory_decide 实体解析），且用 `event_edges` 递归 CTE 模拟时**可测地慢或表达不了**（如 p95>50ms）。今 0 行 → gate 未武装。
- **chunks/embeddings**：JSON 存储出现可复现瓶颈（opus/gpt/kimi 量化：>1万 entries / parse p95>100–200ms /
  recall@k 缺口 / 索引 >50–100MB）**或**需要 sub-entry chunk 级检索（现为 entry 级）。
  注意 opus 的反讽：若向量真到 ANN 规模，出口是 **LanceDB（出 L3）**，故预建 L3 `chunks` 双重投机。
- 激活步骤：加表 + mirror 逻辑 + reconcile 断言 + L1+L2 可重建证明 + 删 deferral marker，同一改动内完成。

## 边界

纯 schema 决策 + 轻编码；不动 L1/L2/向量管线/真相源；L3 仍 not-git / droppable / rebuildable。
flag 无关（L3 是派生层）。`smoke:adr0039-reconcile` 守护（deferred tripwire 接入 sync→reconcile）。
