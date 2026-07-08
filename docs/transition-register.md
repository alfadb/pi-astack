# 第二大脑过渡态登记表

本表登记当前仍有 shadow、observe、dogfood、gated-defer 语义的过渡面。已完成且无后续决策面的历史阶段不重复登记。

## 已就绪待决策

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| Constraint 双读 flip | 2026-07-08 审计登记 | 数据门全绿：coverage=1.0、queued=0、appendFailed=0、legacyOnly=0；textDelta 已经多轮 T0 复核至 2026-07-07 且全部 semantic_equivalent。 | 完成一次明确 flip/retirement 决策，记录授权、回滚条件与 R 轮边界。 | constraint dual-read audit、shadow compiler metrics、2026-07-08 三源交叉审计。 | 发起一次 flip 决策；不得把既有 fallback=false 直接等同于 legacy retirement。 |
| Knowledge legacy 物删 | 2026-07-05 soak 届满 | Knowledge legacy 物删 soak 已满 ≥14 日历日（2026-06-21 起算）；A6 tripwire 干净，无 legacy-cold-access.jsonl。 | R 轮批准 legacy archive/delete，且定义恢复路径与失败回滚。 | Knowledge projection_only 运行数据、A6 tripwire、2026-07-08 审计。 | 启动 Knowledge legacy retirement R 轮。 |
| P5.6 verifier | 2026-07-08 验收达成 | merged-source verifier 生产已见 projected_via_verifier；deferredMergedSourceEvents=0；Phase 2 验收数据已达成。 | roadmap 标记 DONE，并保留后续回归监控。 | constraint compiler/verifier 生产指标、roadmap P5.6。 | 本次同步 roadmap 收尾；后续仅按 regression 处理。 |

## 滞留需推进

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| hub dogfood | 2026-07-08 审计登记 | 双跑仪器缺失；ADR 0030 已另行 walkback 至 material 模式，并要求 ≥20 次判定前置。 | material 模式跑满 ≥20 次判定，且有可复核的双跑或等价证据。 | ADR 0030 walkback、dogfood 运行记录。 | 补齐判定记录与仪器口径，再评估是否退出 dogfood。 |
| forgetting 上游接线 | 2026-07-08 审计登记 | 生产 instrumentation、decayShadow、demoteShadow、autoDemote 四 flag 全开，autoLlmWriteEnabled=true；2026-07-04 已有首条真实 demote，但 aggregator 61 次运行产出 0 条 lifecycle_proposal，executor 缺输入；decay-shadow 已识别 5 条 would_demote=true 但未喂 executor。 | aggregator 能生成 lifecycle_proposal，executor 能消费一个受控批次，demote ledger 与 reactivation window 可审计。 | forgetting-demote-ledger、aggregator run ledger、decay-shadow audit、2026-07-08 审计。 | 实现 aggregator→lifecycle_proposal 接线批次，并用小批量验证。 |
| tier2RulesLegacyWriteGate observe→block | 2026-07-08 审计登记 | 仍停在 observe；缺少足够前置保证。 | tier2 evidence 路径存在，或 constraint legacy retirement gate 通过。 | settings gate、constraint retirement 计划。 | 等待前置条件；触发后把 observe 切到 block。 |
| read-flip .state→git L2 | 2026-07-08 审计登记 | Constraint runtime consumer 仍读 .state compiled view；git L2 是审计/投影面。 | 门控元数据进入 git L2，preflight smoke 通过，并完成一次 multi-T0 复审。 | current-state §3、L2 projection output、preflight smoke。 | 设计并执行 .state→git L2 read-flip 复审。 |
| dual-read audit 关闭 | 2026-07-08 审计登记 | dual-read audit 仍作为过渡监控面存在。 | constraint legacy retirement 完成，且无新的 undispositioned delta。 | dual-read audit、constraint retirement gate。 | 绑定到 constraint legacy retirement 完成后关闭。 |
| staging 硬删 | 2026-07-08 审计登记 | staging 现存 138 条（71 provisional + 67 multiview-pending），最老 46 天；promotion 0.27/天、ageout 0.4/天。 | 存在 recovery primitive，并完成硬删 runbook 与回滚验证。 | staging inventory、promotion/ageout metrics。 | 先设计 recovery primitive，再讨论硬删。 |
| O5 conf≥8 fallback 巡检 | 2026-07-08 审计登记 | 仍需持续确认 conf≥8 非指令 durable fallback 没有引入用户纠正或召回漏失。 | 审计窗口内无被用户纠正的 accepted corrections / recall misses，可移除 fallback 回 ADR 原文谓词。 | tier1_direct_write audit、O5 sunset 指标。 | 做一次窗口巡检并记录结论。 |
| ADR 0035/0036/0037 slim+ingest | 2026-07-08 审计登记 | slim 与 ingest 相关工作仍未形成可退出的闭环状态。 | slim/ingest 验收口径、数据样本与回滚边界齐备。 | ADR 0035/0036/0037 实施记录、ingest 指标。 | 汇总三项当前实态，拆出最小验收批次。 |
| legacy rule body_hash 漂移 | 2026-07-08 审计登记 | legacy-scan 对 21 条 global:always 规则报 SC_INPUT_BODY_HASH_MISMATCH。 | 重算并回写 body_hash，或确认由新证据投影取代后归档。 | roadmap Architecture debt、legacy-scan。 | 先产出 mismatch 清单，再选择回写或归档路径。 |
| outcome unknown 占比溯因 | 2026-07-08 审计登记 | outcome-ledger 12626 行，近 7 天 5485 行；decisive 5.5%、confirmatory 11.7%、retrieved-unused 13.5%、unknown 69.3%。 | unknown 来源被分解到可行动类别，并有降低或保留的明确决策。 | outcome-ledger、2026-07-08 审计。 | 抽样 unknown 行，区分缺埋点、分类器保守、真实不可判定。 |

## 健康 gated-defer

这些面不占过渡预算，触发即行动。

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| P7 低频域三臂 gate | 2026-06-21 gated-deferred | identity / skills / habits / workflows / project-memory / rationale 等低频域仍无触发证据。 | 任一 gate arm 触发：30 天内足量 constraint-evidence、真实 identity-class 塑形错误、或可 replay 的历史事实样本。 | roadmap P7、ADR0039 P7 consensus。 | 无触发则继续 deferred；触发时按 P7 runbook 执行。 |
| L3 chunks/embeddings/graph 表 | 2026-07-08 审计登记 | 派生索引/表保持可重建，不作为 git SOT；当前无必须物化的新证据。 | 真实规模、查询延迟或恢复成本证明需要物化。 | ADR0039 L3 schema defer、runtime search metrics。 | 保持 deferred，触发时先做 schema 与 rebuild 评审。 |
| ADR 0034 staleness re-sync | 2026-07-08 审计登记 | staleness re-sync 暂无当前故障触发。 | 出现 staleness 复发、跨源不一致或 re-sync 失败证据。 | ADR0034 impl plan、staleness audit。 | 无触发则不推进；触发即进入修复批次。 |

## 巡检机制

本表为唯一登记面；每次新增 shadow、observe、dogfood 状态必须同步登记退出条件。建议巡检周期为双周。