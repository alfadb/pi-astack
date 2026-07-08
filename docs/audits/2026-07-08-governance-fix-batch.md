# 2026-07-08 Governance Fix Batch

## 1. 背景

2026-07-08 治理审计采用 6 路跨厂商审计，发现三类 P0/P1 问题：P0-1 `feature-changelog.md` 自 2026-06-14 后停摆，多个已 accepted 的方向变更没有进入用户可否决的功能级变更记录；P0-2 ADR 0039 中的写入弹窗条款与 INV-INVISIBILITY、REQ-001 forbidden、ADR 0024 §4.2 首条反模式冲突；另有 12 项文档漂移，包括易变计数写死、过渡态登记滞后、hub 判定闭环缺口、forgetting 上游接线描述过期、tool-contract/idleLoopGuard 退役面未收口等。

## 2. 三轮 6×T0 讨论票型与收敛过程

R1：Q1 / Q2 / Q6 全体一致。Q1 裁决为精确删除 ADR0039 写入弹窗审批语义，不扩大为重写 ADR；Q2 裁决为易变数字指针化，不改 REQ-006；Q6 裁决为 idleLoopGuard 文档面全删/退役，不保留为 active 机制。

R2：Q5 / OPEN-4 全体一致。Q5 裁决为 tool-contract 文档面全删/退役；OPEN-4 裁决为 `demoteMaxBatch` 等反失控地板 build-time 焊死，`resurrectionBackoffRate` 只可作为 interim const，Phase 2 迁入大脑自管 state 自标定，禁止回填 settings。hub、forgetting、F7 仍有残余分歧：hub 是否保持 enabled、forgetting 是否只登记还是同步修接线、auto-refresh 失败是否只记事故还是加小重试。

R3：全收敛。最终 Q3 = B' + fail-closed + stale-guard：hub 保持开，但本批必须闭合判定回路，若 2026-07-15 前没有至少一次真实 material 判定则关 `dispatch.hub.enabled`，30 天无新 material 判定则告警并重评。Q4 = c-拆分：build-time 地板与 Phase 2 自标定状态拆开。F7 = 登记 + 栅栏内小重试：记录 auto-refresh failed/threw 后静默悬挂的问题，同时在不改大架构的前提下加有界重试（retryAttempt≤1）。

## 3. 逐项裁决与证据

Q1 ADR0039：删除写入弹窗审批语义。新口径为高置信、低风险、可回滚写入默认自动完成；低置信、高影响或冲突信号进入 staging / queued，由后续自然对话中的主动纠错信号（INV-ACTIVE-CORRECTION）或新证据解决。L2 手改仍可通过显式纠错入口（自然对话或纠错命令）转成 L1 correction / rejection / deletion / reason event，但不是同意/拒绝式审批。

Q2 易变数字：运行计数不写成长期事实，改为 ledger、audit、metrics 指针。REQ-006 不改，问题在执行纪律。

Q3 hub：实态证据显示 audit.jsonl 内已有 `hub_decision`、`hub_summary`、`hub_disposition` 多类行；`oracle-hub-quality.mjs --mode=material` 可产跨厂商候选；离线判定历史累计为 0。本批新增 `hub-judgments.jsonl` 判定落盘格式与首次真实跨厂商 material 盲判，保留 owner dogfood，但加 fail-closed 与 stale-guard。

Q4 forgetting 参数：`demoteMaxBatch` 等 per-batch/日上限属于 build-time 反失控结构地板，不是 settings 可调策略。`resurrectionBackoffRate` 为 interim const，Phase 2 应迁入大脑自管 state 自标定，禁止回填 settings。settings 只保留 4 个 boolean kill-switch。

Q5 tool-contract：文档面退役完成，不再列为 active extension/smoke/过渡面。若代码批仍有残余，以代码批结果和本 audit 为准继续清理。

Q6 idleLoopGuard：文档面退役完成，不保留为 active 运行机制；历史 notes 仅作为审计快照，不作为 current spec。

F7 auto-refresh：constraint auto-refresh 在 2026-07-08 06:53Z 出现一次失败，错误为 `SC_COMPILER_VALIDATION_FAILED`；同 source 在 06:37Z 成功，定性为 LLM 输出抖动。失败后无重试并静默悬挂约 13 小时，第 29 条 constraint-evidence 未投影。本批代码 worker 同步加有界重试（retryAttempt≤1）；若触发架构限制则至少登记并保持 owner 手动 re-trigger 作为临时缓解。

body_hash 收口：legacy rule `body_hash` 21 条 mismatch 已由写侧修复。证据为 `writer.ts:3604-3612` 的 post-transform hash 修复注释、`rule-writer.ts:300` 注释、2026-06-24 re-stamp，以及最近运行报告 0 mismatch。该项从 roadmap/transition 过渡面移除，不再作为待推进 debt。

## 4. 本批改动清单

Docs 批：补签 `feature-changelog.md`；ADR0039 walk-back 写入弹窗条款；ADR0031 增参数纪律注记并标注 ADR0025 已归档；ADR0034 依赖行改为已归档；ADR README 增 archived 引用纪律；ADR0036/0037 头部去流水；ADR0033 更新 goal 工具口径；ADR0030 增 hub 判定回路/fail-closed 注记；roadmap/current-state/transition-register/smoke-tests 同步治理口径；新增本 audit。

Code 批：并行 worker 新增 `scripts/hub-judgment-backfill.mjs`，将 material 判定落盘到 `hub-judgments.jsonl`；auto-refresh 加有界重试（retryAttempt≤1）；sanitizer homoglyph smoke 作为 secret-boundary 回归提示行进入参考文档。代码实现真相以同批代码 worker 的实际 diff 和 smoke 结果为准。

## 5. Defer 清单

- outcome unknown 溯因 + R5 闭环。
- read-flip 执行 R 轮：Constraint runtime consumer 从 `.state` 到 git L2 前，需门控元数据进入 git L2、preflight smoke 通过并复审。
- sediment 拆包。
- writer 回滚重构。
- 仪式预算 / WIP 上限。
- auto-refresh 完整重试架构；本批只允许 retryAttempt≤1 的小重试。

## 6. 方向文档变更清单（供用户否决）

- ADR0039 walk-back 写入弹窗条款，置顶为本批最高优先级。
- ADR0031 增 build-time 地板、interim const、自标定 state 与 settings kill-switch 边界。
- ADR0030 增 hub 判定回路、fail-closed、stale-guard 与 owner dogfood 边界。
- ADR0033 增 `goal_stop` / `goal_check` accepted 后新增说明，工具口径 8 更新为 10。
- ADR0034 标注 ADR0025 已归档至 abrain，本 ADR 仅复用 sanitizer + writer 基建。
- ADR0036/0037 头部收敛，转产事实下沉到 feature changelog。
- feature-changelog 追溯补签 ADR0031、ADR0030、ADR0039、Knowledge projection_only、memory 检索栈 phase、vision/direction 2026-07-08 补注与本治理批。

## 7. abrain 已沉淀规则冲突

abrain 已沉淀规则 `l2-not-user-managed-popup-only-on-write` 与本裁决存在冲突：它保留了写入弹窗作为少量场景的可接受形态，而本批已裁决该审批语义与 INV-INVISIBILITY / REQ-001 / ADR0024 §4.2 冲突。处理路径不是由主会话直接写 abrain；应等待用户自然对话纠错信号，经 sediment lane 产生修订或 supersession。本文只登记冲突与处理路径。
