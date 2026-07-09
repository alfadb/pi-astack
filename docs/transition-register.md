# 第二大脑过渡态登记表

本表登记当前仍有 shadow、observe、dogfood、gated-defer 语义的过渡面。已完成且无后续决策面的历史阶段不重复登记。

## 已就绪待决策

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| Knowledge legacy 物删 | 2026-07-05 soak 届满 | Knowledge legacy 物删 soak 已满 ≥14 日历日（2026-06-21 起算）；A6 tripwire 干净，无 legacy-cold-access.jsonl。 | R 轮批准 legacy archive/delete，且定义恢复路径与失败回滚。 | Knowledge projection_only 运行数据、A6 tripwire、2026-07-08 审计。 | 启动 Knowledge legacy retirement R 轮。 |

## 滞留需推进

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| Constraint 双读 flip | 2026-07-08 审计登记 | 数据门在 2026-07-08 治理审计窗口总体达标；但 2026-07-08 06:53Z shadow run 出现一次 compile 失败（SC_COMPILER_VALIDATION_FAILED），同 source 在 06:37Z 成功，定性为 LLM 输出抖动；失败后第 29 条 constraint-evidence 待投影。 | 重跑 compile 成功并确认第 29 条 evidence 已投影后，再完成明确 flip/retirement 决策，记录授权、回滚条件与 R 轮边界。 | constraint dual-read audit、shadow compiler metrics、2026-07-08 三源交叉审计。 | 先重跑 compile 确认，再评估 flip；不得把既有 fallback=false 直接等同于 legacy retirement。 |
| hub dogfood | 2026-07-08 审计登记 | ADR 0030 已 walk-back 至 material 模式离线判定；本批落地判定回填格式 `hub-judgments.jsonl`，并执行首次真实跨厂商 material 盲判。 | 累计 ≥20 次 material 判定且质量 ≥ human-pick；计数以 `hub-judgments.jsonl` 为准。30 天无新 material 判定则告警并重评；若 2026-07-15 前未产生 ≥1 次真实判定则关闭 `dispatch.hub.enabled`。 | ADR 0030 walkback、hub audit、`hub-judgments.jsonl`、2026-07-08 治理批 audit。 | 继续回填 material 判定；触发 stale-guard 或 fail-closed 条件时执行开关处理。 |
| forgetting 上游接线 | 2026-07-08 审计登记 | decay→lifecycle_proposal 接线已落地（60b5d40，2026-07-08）；pending 与计数以 `~/.abrain/.state/sediment/entry-lifecycle-proposals.jsonl` 为准。 | executor 消费一个受控批次，且 demote ledger 与 reactivation window 可审计。 | entry-lifecycle-proposals ledger、forgetting-demote-ledger、aggregator run ledger、decay-shadow audit、2026-07-08 审计。 | 用小批量验证 executor 消费链路。 |
| dedup-archived 无 dense 通道 | 2026-07-09 T0 R2/R3 登记 | embedding 仅 embed active（embedding.ts:655），sedimentDedup status:[all] 只能靠 BM25 词面命中 archived。 | embed/prune 合法集扩展至 archived（检索 profile 的 active 过滤不变，仅 sedimentDedup 消费 archived dense 候选）+ smoke 覆盖。 | search-profiles.ts:55、embedding.ts:655 | 修复应先于或同批于 C2 受控批次放量。 |
| KIND_EVIDENCE_STRENGTH 映射表（v1 过渡面） | 2026-07-09 | kind→证据强度确定性 infra 白名单，长尾 kind 排除自动 demote。 | 大脑内部 reviewer lane 上线后退化为 prompt 引导。 | ADR 0031 修订记录 | reviewer lane 设计。 |
| auto-refresh failed-run 重试 | 2026-07-08 审计登记 | 取证确认 failed/threw 后无重试并静默悬挂约 13 小时；本批已加有界重试（retryAttempt≤1）。若代码批次遇到架构限制未完全落地，以治理批 audit 的实际结果为准。 | 重试机制经真实失败触发验证，并能在失败后留下可审计记录。 | auto-refresh run ledger、2026-07-08 治理批 audit。 | 临时缓解为 owner 手动 re-trigger；等待真实失败验证重试链路。 |
| tier2RulesLegacyWriteGate observe→block | 2026-07-08 审计登记 | 仍停在 observe；缺少足够前置保证。 | tier2 evidence 路径存在，或 constraint legacy retirement gate 通过。 | settings gate、constraint retirement 计划。 | 等待前置条件；触发后把 observe 切到 block。 |
| read-flip .state→git L2 | 2026-07-08 审计登记 | Constraint runtime consumer 仍读 .state compiled view；git L2 是审计/投影面。 | 门控元数据进入 git L2，preflight smoke 通过，并完成一次 multi-T0 复审。 | current-state §3、L2 projection output、preflight smoke。 | 设计并执行 .state→git L2 read-flip 复审。 |
| dual-read audit 关闭 | 2026-07-08 审计登记 | dual-read audit 仍作为过渡监控面存在。 | constraint legacy retirement 完成，且无新的 undispositioned delta。 | dual-read audit、constraint retirement gate。 | 绑定到 constraint legacy retirement 完成后关闭。 |
| staging 硬删 | 2026-07-08 审计登记 | staging backlog 仍需按 inventory/metrics 指针评估；不在本文冻结数量。 | 存在 recovery primitive，并完成硬删 runbook 与回滚验证。 | staging inventory、promotion/ageout metrics。 | 先设计 recovery primitive，再讨论硬删。 |
| O5 conf≥8 fallback 巡检 | 2026-07-08 审计登记 | 仍需持续确认 conf≥8 非指令 durable fallback 没有引入用户纠正或召回漏失。 | 审计窗口内无被用户纠正的 accepted corrections / recall misses，可移除 fallback 回 ADR 原文谓词。 | tier1_direct_write audit、O5 sunset 指标。 | 做一次窗口巡检并记录结论。 |
| ADR 0035/0036/0037 slim+ingest | 2026-07-08 审计登记 | slim 与 ingest 相关工作仍未形成可退出的闭环状态。 | slim/ingest 验收口径、数据样本与回滚边界齐备。 | ADR 0035/0036/0037 实施记录、ingest 指标。 | 汇总三项当前实态，拆出最小验收批次。 |
| outcome unknown 占比溯因 | 2026-07-08 审计登记；T0 R2 usage 语义修复落地 | 当前结论：68.6% 是 missing-used observation bucket，主要由 retrieval-only/tool-result 与 injection-only/path-a-injected 组成；不再当作 classifier/parser unknown。usage 语义已拆成 per-source ratio + self_report + derived attribution：新 `path-a-implicit` 为 observation-only `injected_no_self_report`，旧 implicit-unused 仅 legacy 分桶。R5 prompt revision deterministic dossier sidecar scaffolding 已落地；真实 generation 由 reinforced evidence gate 控制。 | per-source ratio 与 derived attribution 稳定可解释；R5 退出条件为真实 reinforced classifier prompt pattern 产出一条 `prompt-revision-proposals.jsonl` proposal，并经 operator disposition（accept/reject/defer + reason）处理。 | outcome-ledger、2026-07-08 outcome unknown triage、aggregator per-source buckets/derived_attribution、prompt-revision-proposals sidecar。 | 继续跟踪 per-source ratio；等待真实 reinforced pattern 进入 sidecar 并完成 operator disposition；禁止把 `path-a-injected` 与新 `path-a-implicit` 双计为 exposure denominator。 |

## 已收口记录

- P5.6 verifier 已从待决策面移除：roadmap 已标 DONE，后续仅按回归监控处理。
- legacy rule `body_hash` 漂移已从过渡面移除：写侧 hash 已改为 post-transform 计算（`writer.ts:3604-3612`，`rule-writer.ts:300` 注释），2026-06-24 已 re-stamp，最近运行报告 0 mismatch；证据收口见 `docs/audits/2026-07-08-governance-fix-batch.md`。
- tool-contract 相关文档面按本批退役完成；后续若代码或 smoke 仍残留，以治理批 audit 与代码批结果为准。

## 健康 gated-defer

这些面不占过渡预算，触发即行动。

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| P7 低频域三臂 gate | 2026-06-21 gated-deferred | identity / skills / habits / workflows / project-memory / rationale 等低频域仍无触发证据。 | 任一 gate arm 触发：30 天内足量 constraint-evidence、真实 identity-class 塑形错误、或可 replay 的历史事实样本。 | roadmap P7、ADR0039 P7 consensus。 | 无触发则继续 deferred；触发时按 P7 runbook 执行。 |
| L3 chunks/embeddings/graph 表 | 2026-07-08 审计登记 | 派生索引/表保持可重建，不作为 git SOT；当前无必须物化的新证据。 | 真实规模、查询延迟或恢复成本证明需要物化。 | ADR0039 L3 schema defer、runtime search metrics。 | 保持 deferred，触发时先做 schema 与 rebuild 评审。 |
| ADR 0034 staleness re-sync | 2026-07-08 审计登记 | staleness re-sync 暂无当前故障触发。 | 出现 staleness 复发、跨源不一致或 re-sync 失败证据。 | ADR0034 impl plan、staleness audit。 | 无触发则不推进；触发即进入修复批次。 |

## 巡检机制

本表为唯一登记面；每次新增 shadow、observe、dogfood 状态必须同步登记退出条件。建议巡检周期为双周。
