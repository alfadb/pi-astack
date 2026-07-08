# 2026-07-08 outcome unknown triage

## 结论

本次只读溯因确认：生产 `outcome-ledger.jsonl` 中大约 68.6% 的 `used` 缺失不是 parser/classifier 大面积失败，而是 observation-only 行被混进同一个 ledger 后被粗暴归为 `!used/unknown`。

聚合统计口径：总行约 13,220；`used` 缺失约 9,073。主要结构来源为：

- `tool-result`：约 7,045，retrieval-only，按设计不携带 self-report `used`。
- `path-a-injected`：约 1,716，injection-only，按设计记录注入库存，不携带 usage 判定。
- legacy / `source_tool`：约 312，历史 retrieval-only 形态，应单独分桶或作为 legacy 观测，不等同于使用结果未知。

因此后续不把该 68.6% 当作 classifier unknown 或 footnote parser failure。正确监控口径是 per-source/activity ratio：self-report、implicit-unused、retrieval-only、injection-only、unexpected missing-used、legacy/unknown source。

## 代码证据

- `extensions/sediment/outcome-collector.ts`：`OutcomeRow.source` 当前包含 `memory-footnote`、`tool-result`、`path-a-injected`、`path-a-implicit`。其中 `used` 字段注释为 footnotes only；`recordPathAInjectedOutcomes()` 写 `path-a-injected` 且只标 `path_a_signal: "injection-only"`。
- `extensions/sediment/outcome-collector.ts`：`collectPathAImplicitRows()` 将 Path A 注入但无显式 footnote 的当前回合行写成 `path-a-implicit` + `used: "retrieved-unused"`，这是 implicit-unused，不是 parser unknown。
- `extensions/sediment/aggregator.ts`：历史 summary 只消费 `tool-result` 以及合法 `memory-footnote/path-a-implicit`，但缺少对 observation-only 行的可见分桶，导致外部排查容易把所有 `!used` 合并成 unknown。
- `extensions/sediment/settings.ts`：`outcomeSelfReport` 是协议版本 tag，不是独立 sediment prompt；当前仍为 `v0`。

## 为什么不是 parser/classifier 大面积失败

`memory-footnote` self-report 的 parser 对非法 slug / 非法 `used` 是 drop-to-audit 策略，原则是 prefer loss over guessing；不会把 parse error 默默写成 `used` 缺失的 ledger 行。生产缺失 `used` 的主体来自 retrieval-only 与 injection-only source，而这些 source 的结构语义本来就不要求 `used`。

Classifier 也不是主因：`tool-result` 行来自 memory tool retrieval 结果，`path-a-injected` 行来自 Path A 注入 ledger，二者都不是 active-correction classifier 输出，也不是 outcome self-report classifier 输出。

## 已实施小修

- `pi-astack-settings.schema.json`：`sediment.promptVersion.activeCorrectionClassifier.default` 从 `v1` 同步为 `v2`，只修 schema drift，不改 live settings。
- `extensions/sediment/settings.ts`：扩写 `PROMPT_VERSION_NOTES.outcomeSelfReport`，保持版本号 `v0`，说明 memory-footnote fence、counterfactual、sub-agent 不写 footnote、Path A injected/implicit 分流。
- `extensions/sediment/aggregator.ts`：新增 outcome `activity_buckets`、`source_counts`、`missing_used` rollup；保留旧 `window_rows/high_unused/echo_chamber_candidates` 行为，demotion/advisory 阈值不变。
- `scripts/smoke-aggregator-outcome-buckets.mjs`：锁住 `tool-result/source_tool/path-a-injected` 缺 `used` 只计 allowed missing used，`memory-footnote` 缺 `used` 计 unexpected。

## 延期项

- Path A usage 信号：是否、何时把 injection-only 进一步转成可判定 usage，需要 T0 设计；本批不改。
- tool-result usage 信号：retrieval-only 只能说明被返回，不能说明被使用；是否引入后续引用/行为 join 需另行设计。
- `path-a-implicit` silent 状态：当前可表达 implicit-unused，但仍需观察是否过度代表 silent usage。
- R5 prompt revision proposal：仍为 advisory-only；若要形成 sidecar 或协议变更，需要 T0 审查，不在本机械修复批内。

## 隐私处理

本记录只保留聚合计数、source 类型和代码路径，不粘贴生产 ledger 正文、counterfactual 文本或用户会话内容。
