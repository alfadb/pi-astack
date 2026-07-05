---
doc_type: notes
status: active
---

# Second Brain P0B Constraint Disposition - 2026-07-05

## 范围

本文记录 P0B Constraint convergence 的只读处置口径。本补丁只增强 dual-read audit/report 的机器可读解释字段，不改变 runtime read source，不 flip fallback，不写生产 `~/.abrain`，不新增 constraint evidence event，也不删除或归档 legacy rules。

## 最新 audit 基准

基准行 observedAt：`2026-07-05T03:20:58.167Z`。

摘要：`status=delta`，`stale=false`，`legacyRules=23`，`shadowConstraints=36`，`compiledOnly=19`，`legacyOnly=6`，`bothMatch=0`，`textDelta=17`。

事件覆盖：`totalEvents=20`，`validEvents=20`，`invalidEvents=0`，`queuedEvents=0`，`projectedEvents=18`，`staleEvents=2`，`appendFailedEvents=0`，`deferredMergedSourceEvents=2`，`coverageRatio=0.9`，`injectableCoverageRatio=1`。

## legacyOnly 处置建议

6 个 legacyOnly 不是同一种问题，不能用 byte diff 或简单删除收敛。

| Source | 建议 disposition |
|---|---|
| `rule:global:always:applied-to-the-model-tier-configuration-for-critical-agentic-dispatch-t0-flagship-k2-thinking-should` | `settings_not_memory`：model-tier/settings 类，建议 exclude 或迁到 settings/knowledge evidence。 |
| `rule:global:always:applies-to-all-future-dispatch-hub-invocations-and-configuration-the-hub-model-must-be-chosen-per-ta` | `settings_not_memory`：dispatch hub config 类，建议 exclude/knowledge。 |
| `rule:global:always:在所有场景-git-commit-message-代码字符串-配置-文档-bash-字符串-输出-中-禁止使用-u-风格的-unicode-转义序列-必须直接书写字面-utf-8-字符-中文-emoj` | 当前诊断倾向 `settings_not_memory`，但可能是实际 runtime behavior rule；需要 human/T0 语义裁决。 |
| `rule:global:always:禁止行业黑话-口语化隐喻-always-硬规则` | `model_uncertain` / unresolved：可能是实际 behavior constraint；需要 human/T0 语义裁决。 |
| `rule:global:always:配置文件内联注释不构成权威证据` | `settings_not_memory`；compiled 已有 project `pi-global` config-comments coverage，若接受 scope 则 legacy global 可 exclude。 |
| `rule:global:listed:runtime-kill-switch-flags-must-be-explicit-in-settings-json-not-code-default` | `settings_not_memory` 倾向，但属于 operational constraint；需要 human/T0 决策 exclude、knowledge 化或 eventize。 |

补丁后的 audit row 会输出 `legacyOnlyDispositions` 聚合计数，并为每个 source 输出 `legacyOnlyDetails[]`。可从 `decision.exclusions`、`decision.unresolved`、`decision.mappings`、`decision.diagnostics` 和 `diff.rows` 取得的 reason/category 会直接落入 detail；取不到时显式为 `unknown`。

## textDelta gate 类型

当前 `textDelta=17` 的 gate 不是字节一致性，而是逐条语义等价判断。默认机器处置为 `semantic_review_required`。

允许降为 `normalization_possible` 的条件必须来自已有 artifact，例如 `diff.rows[].category="compact"` 或 diagnostics 中明确的 normalization 诊断。没有这类来源时，不把 text delta 假装成等价。

建议 gate 类型：

| Gate type | 机器 disposition | 说明 |
|---|---|---|
| 语义等价人工/T0 审核 | `semantic_review_required` | 默认用于 17 个 textDelta；确认没有内容丢失、scope 改错、must-do 弱化或触发条件漂移。 |
| 渲染/压缩/归一化可解释差异 | `normalization_possible` | 仅当 diff/diagnostics 明确支持，例如 compact 或 subtype normalized。 |
| 内容丢失或行为弱化 | `semantic_review_required` | 不能自动收敛；先修 compiler/event/source，再重新观察。 |

补丁后的 `textDeltaDetails[]` 保留原 `sourceRecordId`、`legacyHash`、`shadowHash`，并追加 coarse disposition 与可得的 diff category/reason/targetId。

## compiledOnly 解释口径

`compiledOnly=19` 是 event-native/source-scope explanation，不是 legacy backfill 待办。它们来自 `decision.json` 中的 compiled constraints，主要覆盖 OpenAI heavy work、LSP restart、T0 blind review、submodule 操作、merdata/pi-router/pi-global 项目规则、tool contract、vision、production-data、config-comments、root-cause review 等事件原生约束。

补丁后的 `compiledOnlyDetails[]` 输出每个 compiled-only source 的 `sourceRecordId`、推断 `sourceKind`、compiled scope、category 和 constraintId。目的只是让报告解释“为什么 shadow 多出这些约束”：事件原生、项目/全局 scope 明确、来源在 compiler decision 中可追溯。不得把该字段解释为自动创建 legacy rule 的授权。

## 非授权事项

本补丁不 flip `compiledViewInjection.fallbackToLegacyOnError`，不改 runtime injection source，不写生产 memory substrate，不运行 `dossier --write`，不新增 evidence event，不删除/归档 legacy rules。

后续要进入 runtime flip 或删除 legacy rules，仍需要独立 ADR 或等价授权，并基于 fresh shadow artifacts 与逐项 semantic gate 结果。
