---
doc_type: notes
status: active
---

# Second Brain P0B Constraint Disposition - 2026-07-05

## 范围

本文记录 P0B Constraint convergence 的只读处置口径。本补丁只增强 dual-read audit/report 的机器可读解释字段，不改变 runtime read source，不 flip fallback，不写生产 `~/.abrain`，不新增 constraint evidence event，也不删除或归档 legacy rules。

## 最新 audit 基准

基准行 observedAt：`2026-07-05T04:09:49.314Z`，`activeProjectId=pi-global`。

摘要：`status=delta`，`stale=false`，`legacyRules=25`，`shadowConstraints=36`，`compiledOnly=19`，`legacyOnly=8`，`bothMatch=0`，`textDelta=17`。

事件覆盖：`totalEvents=20`，`validEvents=20`，`invalidEvents=0`，`queuedEvents=0`，`projectedEvents=18`，`staleEvents=2`，`appendFailedEvents=0`，`deferredMergedSourceEvents=2`，`coverageRatio=0.9`，`injectableCoverageRatio=1`，`provenance.liveEvents=20`。

## legacyOnly 处置建议

8 个 legacyOnly 不是同一种问题，不能用 byte diff 或简单删除收敛。

| Source | P0B disposition |
|---|---|
| `rule:global:always:applied-to-the-model-tier-configuration-for-critical-agentic-dispatch-t0-flagship-k2-thinking-should` | `machine_disposed/settings_not_memory`：model-tier/settings 类。 |
| `rule:global:always:applies-to-all-future-dispatch-hub-invocations-and-configuration-the-hub-model-must-be-chosen-per-ta` | `machine_disposed/settings_not_memory`：dispatch hub config 类。 |
| `rule:global:always:在所有场景-git-commit-message-代码字符串-配置-文档-bash-字符串-输出-中-禁止使用-u-风格的-unicode-转义序列-必须直接书写字面-utf-8-字符-中文-emoj` | `human_required`：diagnostic 倾向 `settings_not_memory`，但 UTF-8 literal/output behavior 可能是 runtime behavior rule。 |
| `rule:global:always:禁止行业黑话-口语化隐喻-always-硬规则` | `human_required/model_uncertain`：flip-blocking；decision 里 unresolved，但 diagnostics 仍有“active sources were compiled”类表述，需要记录 diagnostics-vs-decision inconsistency。 |
| `rule:global:always:配置文件内联注释不构成权威证据` | `machine_disposed/settings_not_memory`，带 scope caveat：compiled 覆盖是 project `pi-global` event，global legacy exclusion 在删除前仍需 scope acceptance。 |
| `rule:global:listed:runtime-kill-switch-flags-must-be-explicit-in-settings-json-not-code-default` | `human_required`：diagnostic 倾向 `settings_not_memory`，但属于 operational constraint。 |
| `rule:project:pi-global:listed:business-model-ids-belong-in-settings-not-code` | `machine_disposed/settings_not_memory`：project model ID/settings 类。 |
| `rule:project:pi-global:listed:prefer-newest-vendor-model-with-old-as-rollback` | `machine_disposed/settings_not_memory`：project model curation/settings 类。 |

补丁后的 audit row 会输出 `legacyOnlyDispositions` 聚合计数，并为每个 source 输出 `legacyOnlyDetails[]`。每项追加 `machineDisposition` 和 `humanReviewRequired`。`humanReviewRequired=true` 覆盖 unresolved、`model_uncertain`、`unknown`、`compiled_missing`，以及 Unicode literal UTF-8、runtime-kill-switch、jargon/professional vocabulary 等特定 source。config-comments global rule 可机器处置，但会带 scope caveat。

## textDelta gate 类型

当前 `textDelta=17` 的 gate 不是字节一致性，而是逐条语义等价判断。默认机器处置为 `semantic_review_required` 且 `humanReviewRequired=true`。

允许降为 `normalization_possible` 且 `humanReviewRequired=false` 的条件必须来自已有 artifact，例如 `diff.rows[].category="compact"` 或 diagnostics 中明确的 normalization 诊断。没有这类来源时，不把 text delta 假装成等价。

| Gate type | 机器 disposition | Review gate |
|---|---|---|
| 语义等价人工/T0 审核 | `semantic_review_required` | `humanReviewRequired=true`；确认没有内容丢失、scope 改错、must-do 弱化或触发条件漂移。 |
| 渲染/压缩/归一化可解释差异 | `normalization_possible` | `humanReviewRequired=false`；仅当 diff/diagnostics 明确支持，例如 compact 或 subtype normalized。 |
| 内容丢失或行为弱化 | `semantic_review_required` | `humanReviewRequired=true`；先修 compiler/event/source，再重新观察。 |

补丁后的 `textDeltaDetails[]` 保留原 `sourceRecordId`、`legacyHash`、`shadowHash`，并追加 coarse disposition、`humanReviewRequired` 与可得的 diff category/reason/targetId。

## compiledOnly 解释口径

`compiledOnly=19` 是 event-native/source-scope explanation，不是 legacy backfill 待办。它们来自 `decision.json` 中的 compiled constraints，主要覆盖 OpenAI heavy work、LSP restart、T0 blind review、submodule 操作、merdata/pi-router/pi-global 项目规则、tool contract、vision、production-data、config-comments、root-cause review 等事件原生约束。

补丁后的 audit row 顶层输出 `compiledOnlyBackfillAllowed=false`，且每个 `compiledOnlyDetails[]` item 也输出 `compiledOnlyBackfillAllowed=false`。目的只是解释“为什么 shadow 多出这些约束”：事件原生、项目/全局 scope 明确、来源在 compiler decision 中可追溯。该字段明确禁止解释为自动创建 legacy rule 的授权。

## final consensus

`machine_disposed`：model-tier、dispatch-hub、config-comments with scope caveat、business-model-ids、prefer-newest。

`human_required`：Unicode literal UTF-8、jargon/professional vocabulary（flip-blocking，且存在 diagnostics-vs-decision inconsistency）、runtime-kill-switch。

`compiledOnly`：backfill not allowed；只做 provenance/scope 解释。

P0B next step 只允许 audit/note 加固。所有 runtime flip、archive/delete legacy rules、constraint evidence write、`dossier --write`、compiler 分类修复、shadow latest refresh 仍 blocked，需要独立授权。

## 非授权事项

本补丁不 flip `compiledViewInjection.fallbackToLegacyOnError`，不改 runtime injection source，不写生产 memory substrate，不运行 `dossier --write`，不新增 evidence event，不删除/归档 legacy rules。

后续要进入 runtime flip 或删除 legacy rules，仍需要独立 ADR 或等价授权，并基于 fresh shadow artifacts 与逐项 semantic gate 结果。
