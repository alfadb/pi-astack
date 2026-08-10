# 2026-08-10 dispatch storm enforce S4 — 单规则授权记录（实施前授权，非完成复审）

## 结论

S4（单规则 enforce）的唯一候选规则 `storm/post-cap-schema-rejection-signature/v1` 已获得**用户明确逐条授权**，且经 **Fable / OpenAI / Grok / Opus 四模型 AUTHORIZED** 确认。授权范围严格限定为：

- **只 enforce production-supported consecutive 分支**：同一 strict exact composite signature 在同 segment 内 `consecutive_count===4 && cap_after===3 && would_abort_basis==='consecutive'` 才触发真实 abort；不得只看 would_abort / first_trip。
- **rolling 永远 shadow**：rolling-window trip 绝不进入 control（仅产生 shadow 行）。
- **无 total cap**：无通用总量上限兜底。

**明确拒绝**：rolling enforce、general tool cap、任何未经 S3 真实 production shadow 证据支持的批量规则启用。

> ⚠️ 本记录是**实施前授权**（pre-implementation authorization），不是完成复审（completion review）。ENFORCE-* 五项 acceptance criteria 仍全部未勾选；实现、证据、T0+/跨厂商 T0 完成复审、双仓提交均未执行。本记录只固化「用户逐条授权 + 四模型 AUTHORIZED」这一前置门。

## 授权对象（逐条）

| # | 授权项 | 授权内容 | 状态 |
|---|--------|----------|------|
| 1 | 规则范围 | 仅 `storm/post-cap-schema-rejection-signature/v1` 的 production-supported consecutive 分支可 enforce | AUTHORIZED |
| 2 | 触发条件 | 同一 strict exact composite signature 在同 segment：`consecutive_count===4 && cap_after===3 && would_abort_basis==='consecutive'`；不得只看 would_abort / first_trip | AUTHORIZED |
| 3 | rolling 边界 | rolling-window trip 永远 shadow，绝不进入 control；即使 rolling 先 trip，后续 exact consecutive count 4 仍应 enforce | AUTHORIZED |
| 4 | 无 total cap | 无通用总量上限兜底；1000 次 rotating/success 不得触发任何 cap | AUTHORIZED |
| 5 | 开关矩阵 | enforce 要求 governor.enabled && toolObservers.enabled && schemaErrorStorm.enabled && enforceConsecutiveExact && observeAfter===3 全部满足 | AUTHORIZED |
| 6 | 降级语义 | strict key unavailable → 安全 closed eligibility reason、shadow 不 eligible、enforce 不触发、每 run 最多 1 条 worker_run_enforce_event 降级 audit；unsupported cap / enforce disabled 无噪声；enabled 但 observeAfter!=3 每 run 1 条 unsupported_cap marker | AUTHORIZED |
| 7 | 终止路径 | 真实 abort decision 必须走 WorkerRunGovernor 专用方法（不重复 apply/increment counters）→ 现有 emitWorkerRunDecision → requestGovernorTermination → FirstWriterTermination；不得直接 abort / tryClaim / 新 promise | AUTHORIZED |
| 8 | 审计字段 | decision/audit additive 字段：rule_id、enforce_rule_version（`dispatch-storm-enforce/v1`）、signature_hmac、segment、count4/limit3、budget_kind consecutive、signal `schema_rejection_storm_enforce`、action 明确；failureType `schema_rejection_storm_enforced` 补入 WorkerGovernorFailureType / index FailureType / terminal-state GOVERNOR_FAILURE_TYPES / PARTIAL_OUTPUT_FAILURES / 输出与测试 schema | AUTHORIZED |
| 9 | shadow 不变式 | shadow 行仍 mode observe/counterfactual（即使 consecutive 触发也原样保留）；storm-shadow.ts 保持纯状态机；shadowFeed 可返回 observation 供 wiring predicate，但 audit fail-open | AUTHORIZED |
| 10 | 拒绝项 | rolling enforce、general cap、批量规则启用 | REJECTED |

## 四模型 AUTHORIZED 记录

| 模型 | 裁决 | 备注 |
|------|------|------|
| Fable（T0+） | AUTHORIZED | 确认仅 consecutive 分支、rolling 永远 shadow、无 total cap |
| OpenAI gpt-5.6-sol（T0） | AUTHORIZED | 确认触发条件为完整 composite predicate、不得只看 would_abort/first_trip |
| Grok（T0） | AUTHORIZED | 确认终止路径唯一（专用方法 → emitWorkerRunDecision → requestGovernorTermination → FirstWriterTermination） |
| Opus（T0） | AUTHORIZED | 确认降级语义与审计 additive 字段、strict key 契约不放宽 |

四模型一致确认：授权范围 = S3 真实 production shadow 证据支持的唯一规则唯一分支；rolling 与 general cap 明确拒绝；本授权为实施前授权，不替代完成复审。

## 实施边界（本授权对应的实现约束）

- 新设置 `workerRunGovernor.toolObservers.schemaErrorStorm.enforceConsecutiveExact: boolean`，default true；resolver / settings tests 同步更新。
- 新 enforce version `dispatch-storm-enforce/v1`；governor 原 schema observe 路径逐字不变；post-terminal / 已有 governor terminal 不发。
- 不同 identity 不合并；success tool / visible completed reset 沿用 shadow 语义。
- 不得 raw：原文 / field path / tool args / normalized 不落盘，仅 opaque HMAC key_id+digest。

## 隐私处理

本记录只固化授权项、模型裁决与实施边界，不粘贴 production 审计行正文、prompt 内容或用户会话内容；实现细节以代码与 living plan 为准。
