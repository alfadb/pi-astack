# Second Brain P0A Diagnostics - 2026-07-05

## Status / Scope

本文是 T0 共识 v4 后的 P0A 只读诊断推进记录，用于沉淀已复核数据、当前判断和进入 P0B / P1 前的门槛。本文不是 ADR，不授权任何 runtime flip，不授权 archive 执行。

明确范围：未改 runtime 行为，未 flip，未执行 archive，未改 stage2 / Path A / Activity / L3。本文只记录诊断事实、风险边界和后续 gates。

## Executive Summary

P0A 当前证据支持继续推进只读诊断与观测增强，但不支持把诊断结论直接转成 runtime 行为变更。

Constraint 最新审计仍为 delta 状态，但 stale=false；legacy 与 shadow/compiled 的差异主要来自事件原生约束、作用域差异、渲染/来源/时间线/frontmatter 归一化，以及少量需要人工或 T0 语义裁决的 legacy-only 条目。P0A 未发现明确语义冲突，但 byte equality 不能作为 gate，后续仍应按 entry 级语义等价判断。

Stage2 已有足够证据支持增加 observability、retry、limit、backoff 方向的诊断，但不足以授权 cross-vendor / cross-model fallback 或更小生产模型切换。近期 rate_limit burst 更像并发症状。

Path A skip 结构主要反映 intent gating、无 anchor/background 场景和 stage2 none verdict，不应把总体 skip rate 解读为 memory_search 失败，也不应据此放松 rewriter。

Forgetting replay 证据显示当前 archive/demote 只出现 1 个真实执行案例，其余 pending 大多为 real no-successor。存在一次先 failed 后 executed 的自修正轨迹，但当前 ledger 缺少 proposal_id / supersedes_proposal_id 等字段来证明幂等性。

## 1. Constraint Delta Inventory

最新审计时间：2026-07-05T03:20:58.167Z。

状态：status=delta，stale=false。

摘要计数：legacyRules=23，shadowConstraints=36，compiledOnly=19，legacyOnly=6，bothMatch=0，textDelta=17。

事件覆盖：totalEvents=20，validEvents=20，invalidEvents=0，queuedEvents=0，projectedEvents=18，staleEvents=2，appendFailedEvents=0，deferredMergedSourceEvents=2，coverageRatio=0.9，injectableCoverageRatio=1，liveEvents=20。

legacyOnly 6 项及当前判断：

- `rule:global:always:applied-to-the-model-tier-configuration-for-critical-agentic-dispatch-t0-flagship-k2-thinking-should`：SC_NOT_MEMORY_SETTINGS，属于 settings/model-tier；建议 exclude 或移动到 settings/knowledge evidence。
- `rule:global:always:applies-to-all-future-dispatch-hub-invocations-and-configuration-the-hub-model-must-be-chosen-per-ta`：SC_NOT_MEMORY_SETTINGS，属于 dispatch hub config；建议 exclude/knowledge。
- `rule:global:always:在所有场景-git-commit-message-代码字符串-配置-文档-bash-字符串-输出-中-禁止使用-u-风格的-unicode-转义序列-必须直接书写字面-utf-8-字符-中文-emoj`：SC_NOT_MEMORY_SETTINGS，但可能是实际 runtime behavior rule；需要 human/T0 语义决策。
- `rule:global:always:禁止行业黑话-口语化隐喻-always-硬规则`：diagnostics keep_unresolved/model_uncertain/SC_COMPILER_ITEM_REJECTED；可能是实际 behavior constraint；需要 human/T0 决策。
- `rule:global:always:配置文件内联注释不构成权威证据`：SC_NOT_MEMORY_SETTINGS；compiled 已有 project pi-global config-comments rule coverage；若接受 scope，则 legacy global 可能可 exclude。
- `rule:global:listed:runtime-kill-switch-flags-must-be-explicit-in-settings-json-not-code-default`：SC_NOT_MEMORY_SETTINGS，但属于 operational constraint；需要 human/T0 决策是否 exclude 或 eventize。

compiledOnly 19 项均为 event-native compiled constraints，均位于 `decision.json`。类别包括：OpenAI heavy work；LSP restart global/merdata；T0 discussion/blind review global/pi-global；submodule push/update；merdata image/db/sub2api rules；pi-router CLI/k8s rules；pi-global toolcontract/vision/production-data/config-comments；root-cause T0 review。

这些 compiledOnly 项中存在合法的 project/global scope overlap。后续处理重点应是解释来源、作用域和投影路径，而不是为了追平 legacy 而回填。

textDelta=17。P0A 未发现明确语义冲突，差异多为 renderer、provenance、timeline、frontmatter normalization 或更紧凑措辞。后续 gate 应是 per-entry semantic equivalence，而不是字节级一致；任何内容丢失或语义不匹配必须先解决。

## 2. Stage2 Search Diagnostics

数据规模：search-metrics rows total=5501；stage2_ms rows=2752。

全量 verdict/outcome：no_verdict=1117，has_relevant=2860，none=1491，unknown=17，llm_error=16。

错误：16 total，包括 13 rate_limit、2 stream_read、1 other API；可用行中全部出现在 stage2 primary/openai gpt-5.5。

近期 500：has_relevant=479，none=6，llm_error=15；p50=20718ms，p95=39348ms，p99=59806ms，max=81331ms。

近期 200：has_relevant=183，none=2，llm_error=15；p50=22176ms，p95=53248ms，p99=68585ms，max=81331ms。

全量 latency：p50=11602ms，p95=31577ms，p99=50047ms，max=148281ms。

Profile 结论：toolSearch 是近期最高 latency 来源；subagent analysis 显示 output tokens 与 latency 的相关性强于 input tokens。

诊断结论：现有证据足以支持增加 observability、retry、limit、backoff 诊断；不足以授权 cross-vendor / cross-model fallback，也不足以授权切换到更小生产模型。rate-limit burst 更可能是并发症状，应优先通过并发/限流/退避观测解释。

## 3. Path A Skip Classification

数据规模：rows total=2698。

全量 outcomes：skipped_no_model_registry=308，skipped_rewriter_unuseful=803，skipped_error=174，injected=983，skipped_search_none=430。

近期 500：injected=227，skipped_rewriter_unuseful=219，skipped_search_none=13，skipped_error=1，skipped_no_model_registry=40。

近期 200：skipped_no_model_registry=14，skipped_rewriter_unuseful=151，injected=32，skipped_search_none=3，skipped_error=0。

no_model_registry 最新样本：2026-07-05T01:12:42.586Z，prompt_chars=23，total_duration_ms=2，anchor_missing=true，history_turn_count=0；subagent analysis 未见 session fields。该样本强烈指向 no-anchor/background/heartbeat，而不是主会话 memory_search 失败。

skipped_error：历史 174，主要来自 2026-05-28/29 的 loadEntries import bug；recent200 为 0，recent500 仅 1。仍有部分 JSON parse/model errors 属于历史残留。

skipped_rewriter_unuseful：多数是健康 intent gating；一个抽样 json_parse_failure 可能被误分类。

skipped_search_none：通常是 stage0 candidates 之后 stage2 verdict=none，不是工具失败。

诊断结论：Path A 需要新增 source/context fields 和 skip sampling。当前证据不支持放松 rewriter，也不支持把 skip rate 直接解释为 memory_search failure。

## 4. Forgetting Replay / Idempotency Diagnostics

Proposals 总数 13：status pending=11，failed=1，executed=1；disposition review_required=12，execution_ready=1；reason superseded_no_successor=12，affirm_superseded=1；op archive=13。

E1：唯一 executed slug 为 `semi-auto-mode-blocks-map-hole-clicks-to-prevent-accidental-hole-selection`，存在有效非 self successor：`map-hole-click-gate-uses-currentworkmode-not-issemiautomode`。

E2：当前 11 个 pending 均为真实 no-successor，包括一个 self-referential `superseded_by`，已按 invalid 处理。

failed -> executed 轨迹：同一个 semi-auto slug 先在 14:44:54 得到 failed review_required/superseded_no_successor，随后在 14:50:41 得到 executed execution_ready/affirm_superseded。frontmatter 显示 successor 自 2026-06-04 已存在；较可能是 edge resolver/projection/index first-pass miss 后批次自修正。需要显式 proposal_id / supersedes_proposal_id 才能证明幂等性。

Dry-run audit：rows=1140；planned sum=1，demoted sum=1，would_demote sum=1。

Demote ledger：rows=1；同一 semi-auto slug，reason=affirm_superseded，expected_status=superseded，op=demote，reactivation_monitor_window_days=30，reactivation_expected=false。

Decay-shadow：rows=1485；would_demote true=1，evidence superseded_by=1。未见 usage-only would_demote sample。

当前 ledger 未直接暴露 would_demote_usage_only_count / usage_only_archive 字段。P1 前需要显式 evidence_type、proposal_id、idempotency 字段，或等价 replay command。

## 5. Gates Before P0B / P1

进入 P0B 前，Constraint delta 需要逐项完成语义 gate：legacyOnly 中 settings/config 类条目应明确 exclude、knowledge 化或 eventize；疑似 behavior constraint 的中文/风格类规则必须由 human/T0 裁决；compiledOnly 应按 event-native 约束解释来源和作用域，不做机械 legacy backfill；textDelta 应按语义等价判断并处理内容丢失风险。

Stage2 进入下一步前，应先补充 observability：错误类型、并发上下文、重试次数、backoff 状态、token output、工具来源与模型来源。任何 fallback 或模型切换都需要额外证据，而不是仅依据近期 rate_limit 与 latency。

Path A 进入下一步前，应补充 source/context fields 与 skip sampling，特别是区分 main-session、background、heartbeat、anchor_missing、model registry 状态和 stage2 none。不能把 skip 总量作为失败率直接使用。

Forgetting 进入 P1 前，应补充 proposal_id / supersedes_proposal_id / evidence_type / idempotency 字段，或提供等价可复放命令，证明同一 archive/demote proposal 不会因 first-pass miss、projection delay 或重复 replay 产生重复执行。

任何 P0B/P1 runtime flip 必须另行走 ADR 或等价授权流程。本文不构成授权。

## 6. Commands / Evidence Pointers

本记录引用的是已复核诊断数据，而非本文件生成过程中的新查询。

证据指针应继续围绕以下数据面维护：

- Constraint latest audit：legacyRules/shadowConstraints/compiledOnly/legacyOnly/textDelta/eventCoverage。
- Stage2 metrics：search-metrics、stage2_ms、recent500/recent200 latency、llm_error 类型与模型来源。
- Path A diagnostics：outcome 分类、recent windows、no_model_registry 样本、skip source/context。
- Forgetting replay：proposals、dry-run audit、demote ledger、decay-shadow、proposal idempotency 字段。

后续若生成命令或 replay 输出，应记录命令、时间、输入范围、输出路径和是否只读。

## 7. Follow-up Observability Patch

P0A 诊断后已补一组观测字段，仍不改变 runtime 语义：不改 `memory_search` ranking，不放松 Path A rewriter，不改变 archive/demote gate，不 flip Constraint fallback。

已补字段：

- Stage2 search metrics：成功行增加 `retry_count`、`retry_phase`、`backoff_applied`、`stage2_usage_in/out/cache_*`；失败行增加 `error_type`、`error_model_ref`、`retry_count`、`retry_phase`、`backoff_applied`。
- Path A ledger：增加 `source` 与 coarse `context`，用于区分 anchored/no-anchor 与 history/no-history；不写 raw prompt。
- Entry lifecycle proposals：增加 `proposal_id`、`evidence_type`、`supersedes_proposal_id`。
- Forgetting audit / demote ledger：增加 `schema_version`、`row_kind`、`idempotency_key`、proposal id join 字段与 evidence join 字段。

验证：`npm run smoke:entry-lifecycle-proposals`、`npm run smoke:forgetting-executor-real`、`npm run smoke:forgetting-demote-e2e`、`node scripts/smoke-memory-sediment.mjs` 均通过；另用临时 `ABRAIN_ROOT` 调用 Path A，确认 ledger 写入 `source="memory.before_agent_start"`、`context="no_causal_anchor:no_history"` 且不包含原始 prompt。