# Activity / Attention Timeline L2 Projector 实施方案（2026-07-04）

> 本文是 research 调研后的执行方案，不是 ADR。它把 `docs/research/2026-07-04-agent-memory-and-wiki-memory-*` 的启发压缩成一个可落地切片：第二大脑先能回答“最近注意力分配到了哪些项目”。需求级 / workline 识别、自动注入和自治遗忘联动均为后续 gated phase。

## 1. 背景

本次 agent memory / LLM Wiki / second-brain research 的共同收敛点是：长期记忆不应只做“聊天记录 + 向量检索”，而应区分 raw evidence、human-readable view、runtime index。pi-astack 现有 ADR 0039 拓扑已经与此一致：L1 Evidence Event 是语义 source of truth，L2 Markdown 是确定性投影视图，L3 runtime index/profile 可重建。

用户明确提出的真实需求不是“给 memory_search 加新鲜度排序补丁”，而是让第二大脑知道“最近都在干什么”：全局层看时间分配给哪些项目，项目层看正在推进哪些需求。旧的 `2026-06-05-timeline-audit-decision-signals-design.md` 已经关闭了检索期时间排序路线，并指出正确方向是活动 / 注意力时间线。

## 2. 目标

近期目标是增加一个确定性的 L2 view：从真实 L1 evidence events 聚合出项目级活动分布，作为人类可读的 activity / attention timeline 视图。

最小可行切片只回答全局问题：

- 最近 7 / 30 / 90 天有哪些 project 出现 L1 evidence activity。
- 每个 project 在窗口内有多少 evidence event，占窗口内总事件比例多少。
- 哪些事件没有 project binding，需要后续 schema / writer 修正。
- legacy import / backfill 不应被误判成最近注意力。

## 3. 非目标

- 不新增独立可写 wiki memory store。
- 不让用户手动维护 timeline、项目看板或需求列表。
- 不把 L2 Markdown 当用户可编辑记忆界面。
- 不修改 `memory_search` 排序，不把时间信号塞进 stage0 / stage1 / stage2。
- 不引入 `trust_score`、half-life、decay score 等冻结标量来决定意义。
- 不在首期识别 requirement / workline；该判断需要新的语义归因证据，不能从 project_id 直接推出。
- 不接入 `agent_end` 自动写入，不改变 runtime 注入行为。

## 4. 三面分工

| 面 | 职责 | 本方案处理 |
|---|---|---|
| `docs/research/` | 外部资料、调研、来源笔记；非规范 | 保持 research 参考身份，不升级为决策 |
| abrain L1/L2/L3 | agent-curated、query-addressed、描述性 / 涌现记忆 | L1 作为输入，L2 activity view 作为派生输出 |
| wiki / 人类可读视图 | 描述性知识的人类可读呈现 | 采用 wiki-as-view：由 canonical source 渲染，不新增第三个写入面 |

规则：同一知识断言只能有一个 canonical home；人类可读性通过渲染获得，不通过多写一份获得。

## 5. 数据来源与归因规则

首期输入只读 `~/.abrain/l1/events/**/*.json`。

事件纳入条件：

- envelope hash / path / body hash 校验通过。
- `body.event_schema_version` 以 `evidence-event/v1` 结尾。
- 不是 `constraint-projection-event/v1` 等派生 projection event。
- `body.created_at_utc` 可解析，且不晚于 `as_of_utc`。
- 默认排除 legacy import / backfill：`session_id === "legacy-import"`、`device_id === "legacy-import"`、`source_ref` 以 `legacy-import:` 开头，或 sanitizer 标为 legacy import。

project attribution 顺序：

1. `body.scope.kind === "project" && body.scope.project_id`
2. `body.scope.active_project_binding.project_id`
3. `body.scope.scope_hint.kind === "project" && body.scope.scope_hint.project_id`
4. `body.active_project_binding.project_id`
5. `body.scope.kind === "world"` 归为 `world`
6. 仍无 project 的归为 `unattributed`

这套规则优先使用 L1 事件里的 witnessed/projector metadata，不从路径、git remote 或 cwd 推断项目身份。

## 6. L1 / L2 / L3 落位

| 层 | 本方案落位 |
|---|---|
| L1 | 不新增事件；只读取既有 Evidence Events |
| L2 | 新增 `l2/views/activity/latest/project-time-allocation.md` 与 `manifest.json` |
| L3 | 暂不新增 SQLite 表、FTS、embedding 或 runtime index |

L2 view 是 deterministic renderer 输出。`as_of_utc`、窗口集合、includeLegacy flag 和每个 L1 event 文件的分类观测（included / legacy excluded / projection skipped / invalid 等）都进入 `input_event_set_hash`。同一 L1 输入、同一 `as_of_utc`、同一窗口参数应得到相同 markdown 与 manifest。

## 7. Phase 分解

### P0a：全局 project allocation L2 projector（本轮最小切片）

状态：已实施为显式命令，不接 runtime hook。

代码触点：

- `scripts/project-activity-l2.mjs`
- `scripts/smoke-project-activity-l2.mjs`
- `package.json` scripts：`project:activity-l2`、`smoke:activity-l2`

运行方式：

```bash
npm run project:activity-l2 -- --abrain ~/.abrain --write
npm run project:activity-l2 -- --abrain ~/.abrain --as-of 2026-07-04T16:00:00.000Z --output-root /tmp/activity-l2 --write
```

验收：

- smoke 用临时 abrain 构造知识事件、constraint 事件、legacy import、projection event，验证窗口聚合、legacy 排除、projection 排除和重跑稳定性。
- 真实 `~/.abrain` 数据跑一次，至少能读取 3000+ L1 事件并输出非空 project allocation。
- 输出文件不包含新增 memory entry，不修改 legacy markdown；`--output-root` 位于 `~/.abrain` 内时必须保持在 `l2/views/activity` 命名空间，避免误写到 `knowledge/` 或 `projects/<id>/`。

### P0b：人工可读入口与健康巡检

候选后续工作：把 activity view 纳入 `health:memory` 的只读摘要，或新增只读 `health:activity` 脚本。它只报告 L2 view 是否存在、输入 hash、事件数量、unattributed 比例和最近 as_of，不自动修复。

进入条件：P0a 在真实数据上至少使用一次，且 view 对人工判断有价值。

### P1：runtime 消费实验（不默认注入）

候选后续工作：在 `memory_decide` 或 session briefing 的可选路径里按需加载 activity view，让 agent 在“最近在忙什么”类问题上直接读 L2 view，而不是发起 semantic memory_search。

进入条件：真实会话中出现至少 3 次用户或 agent 需要 activity briefing 的场景，且手动读 P0a 输出比 git log / 人脑回忆有明显收益。

禁止走法：默认每轮注入完整 activity table；这会增加打扰成本，违反“召回不是越多越好”。

### P2：项目内 requirement / workline 归因

这是单独的 gated phase，不与 P0a 同做。

原因：project_id 是结构化 metadata，已存在于 L1；requirement / workline 是语义归因，需要判断“这条事件推进了哪个需求”。如果直接从标题或 slug 猜，会把认知判断冻结成低质量字段。

进入条件：

- P0a 已显示 project-level view 有用。
- 至少收集 20 条真实事件样本，人工或 T0 审查能稳定标注 workline。
- 明确是否需要扩展 L1 event metadata，若需要则进入 T0 / ADR 讨论。

候选实现：sediment 在生成新 L1 event 时附带低置信 `workline_hint` 或另追加 `activity_attribution_observed` event；最终 L2 renderer 只消费已固化 evidence，不直接调用 LLM。

### P3：timeline 作为自治遗忘证据输入

长期方向。activity timeline 可以为 ADR 0031 自治遗忘提供“哪些领域活跃 / 哪些长期休眠”的证据，但不能直接变成机械 demote 分数。

进入条件：P0/P1 证明 activity view 稳定，且已有 forgetting proposal / resurrection 数据可交叉验证。

## 8. 真实生产数据验收

新能力验收必须使用真实生产数据。P0a 的生产数据验收方式：

```bash
npm run project:activity-l2 -- --abrain ~/.abrain --as-of <固定时间> --output-root /tmp/pi-activity-l2-real --write
```

验收看四类证据：

- `included_events` 大于 0，且与 `health:memory` 的 L1 事件量级一致。
- top projects 与近期实际工作直觉大体一致；明显不一致时优先查 legacy 排除和 project attribution。
- `unattributed` 不应无限增长；若比例高，说明 L1 writer 缺 project binding，不是用户需要维护。
- 重跑同一 `as_of_utc`、同一输入时 markdown / manifest byte-stable。

## 9. 风险与走偏信号

| 风险 | 处理 |
|---|---|
| evidence event count 被误读为真实工时 | 文档和 L2 view 明确写“event counts, not wall-clock minutes” |
| legacy import 批量事件污染近期 activity | 默认排除 legacy import；需要历史分析时显式 `--include-legacy` |
| world / unattributed 过多 | 作为 schema / writer diagnostic，不要求用户修条目 |
| L2 view 被当作可编辑 wiki | README / roadmap 继续强调 wiki-as-view；L2 非用户管理面 |
| 自动注入造成打扰 | P1 前必须有真实 usage signal，默认不注入 |
| requirement 识别过早 | P2 必须单独 gated；需要 T0 / ADR 时不在 P0a 偷做 |

## 10. 值得进入 T0 / ADR 的内容

- P2 requirement / workline 归因是否需要扩展 L1 event schema。
- Activity view 是否进入 session briefing 或 memory_decide prompt surface。
- Activity timeline 是否作为 ADR 0031 forgetting 的证据输入。
- canonical home 唯一 + render view 防 split-brain 是否需要升格到 `docs/README.md` 或 `direction.md`。

## 11. 不应升级为 ADR 的内容

- 这批 research 的统一综述本身。
- “要不要新增 LLM Wiki store”这个抽象问题；当前结论是 wiki-as-view，除非真实使用反转。
- Holographic trust_score / half-life decay 标量。
- AutoMem 训练式 memory expert；当前仅追踪，等待真实“记忆动作 -> outcome”语料和 prompt plateau 证据。
