# 2026-08-10 dispatch storm enforce S4 — T0+ / cross-vendor T0 review

## 结论

S4（单规则 enforce）的 T0+/跨厂商 T0 审查经多轮收敛，最终有效门通过：**T0+ Fable + cross-vendor OpenAI / Grok / Opus 均 GREEN，无 P0/P1**。S4 的 implementation / evidence / review 三项 gate 已通过（ENFORCE-IMPL / -EVIDENCE / -REVIEW 勾选，18/20）；submodule commit/push 与父仓 gitlink 尚未执行（本阶段不 commit/push），ENFORCE-SUBCOMMIT / -PARENT 保持未勾选，等待 subcommit。

审查全程确认：**仅 consecutive 分支被授权并 enforce**（同一 strict exact composite signature 在同 segment `consecutive_count===4 && cap_after===3 && would_abort_basis==='consecutive'` 才触发真实 abort，绝不看 would_abort / first_trip 单独成立）；**rolling-window trip 永远 shadow、绝不进 control**（production negative canary 实证 0 条 enforce 行）；**无通用 total tool cap**；真实 abort 走 WorkerRunGovernor 专用方法（`enforceSchemaRejectionStorm` → `emitWorkerRunDecision` → `requestGovernorTermination` → `FirstWriterTermination`，不重复 apply/increment counters）；shadow 行仍 mode observe/counterfactual、storm-shadow.ts 保持纯状态机；隐私（原文/field path/tool args/normalized 不落盘，仅 opaque HMAC key_id+digest）未被放宽。**rolling enforce 与 general cap 明确未授权**。

## 审查对象

- 实现：`extensions/dispatch/index.ts`（enforce wiring + seal gate）、`extensions/dispatch/worker-run-governor.ts`（`enforceSchemaRejectionStorm` 专用方法 + `schema_rejection_storm_enforced` failureType）、`extensions/dispatch/terminal-state.ts`（GOVERNOR_FAILURE_TYPES / PARTIAL_OUTPUT_FAILURES）、`extensions/dispatch/settings.ts` + `pi-astack-settings.schema.json`（`enforceConsecutiveExact`）、`extensions/workflow/executor.ts`（`NON_RETRYABLE_GOVERNANCE_FAILURES` 补入 `schema_rejection_storm_enforced`）。
- 证据：dossier `docs/evidence/2026-08-10-dispatch-storm-enforce-s4-production.json`（顶层 `result=accepted_impl_evidence_review_waiting_subcommit`、mode `production_acceptance_evidence`；positive enforce + negative rolling-only-shadow 双 run，31 条 row hash 全部复算、embedded replay + enforce predicate 通过）。
- 授权：`docs/audits/2026-08-10-dispatch-storm-enforce-s4-rule-authorization.md`（用户逐条授权 + Fable/OpenAI/Grok/Opus 四模型 AUTHORIZED，实施前授权）。
- Smoke：`smoke-dispatch-storm-enforce` 27/27、`smoke-workflow-executor` 30/30、`smoke-dispatch-terminal-closure` 22/22、`smoke-worker-run-governor` 90/90、`smoke-c5-terminal-state`、`smoke-c5-audit-row-schema`、`smoke-dispatch-output-format` 72/72、`smoke-dispatch-storm-shadow` 34/34 全部通过；`git diff --check` 干净；改动文件 LSP 0 diagnostics、focused tsc 通过（全入口 9 个既有基线错误未扩大）。

## 授权前置（用户逐条授权 + 四 T0 预授权）

S4 的逐条授权门在实施前已通过：用户明确逐条授权 + Fable / OpenAI / Grok / Opus 四模型 AUTHORIZED（`docs/audits/2026-08-10-dispatch-storm-enforce-s4-rule-authorization.md`）。授权范围严格限定为唯一候选规则 `storm/post-cap-schema-rejection-signature/v1` 的 **production-supported consecutive 分支**；rolling 永远 shadow；无 total cap；enforce 要求 governor.enabled && toolObservers.enabled && schemaErrorStorm.enabled && enforceConsecutiveExact && observeAfter===3；strict key unavailable → 安全 closed eligibility reason + 降级 audit；真实 abort 走 WorkerRunGovernor 专用方法；failureType `schema_rejection_storm_enforced` 补入各 failure type 集合。**明确拒绝 rolling enforce 与 general cap**。该授权是实施前授权，不替代完成复审——本记录即完成复审。

## 审查记录

### 首轮实现审查：Fable / Grok GREEN，OpenAI / Opus RED（共同 P1 + Opus 另 P2）

首轮实现审查：Fable、Grok 两票 GREEN；OpenAI、Opus 两票 RED。两票 RED 共同暴露一个 P1，Opus 另提出一个 P2，均已修复：

- **共同 P1（workflow nonretry taxonomy）**：`extensions/workflow/executor.ts` 的 `NON_RETRYABLE_GOVERNANCE_FAILURES` 未含 `schema_rejection_storm_enforced`——storm enforce 是治理终态（单 worker run 内已有界），workflow retry policy 不得重放。修复：补入该 failureType，保持所有 governance terminal 不重放。
- **Opus 另 P2（seal 窗口）**：`extensions/dispatch/index.ts` 的 enforce wiring 在调用 `enforceSchemaRejectionStorm` 前未检查 run terminal 状态——run terminal 已 seal（run-owned 终态已定：normal prompt return / tool_rejected / crash）或任何 owner 已 claim（parent/timeout/governor）时，构造并落盘 abort decision 是虚假 abort（run 已因其他原因终态）。修复：enforce 调用前显式要求 `!runTerminalSealed && termination.claim === undefined`（seal gate）；`FirstWriterTermination` 逐字未改（seal 仍只经 `sealExternalClaims` 阻止外部 claim，gate 是 wiring 侧防御，防止虚假 decision 被构造与审计）。该 P2 与共同 P1 一并修复。

### RED-first 验证：serial/parallel + 真实 SDK late event

两个修复均以 RED-first 方式验证：

- **P1（workflow nonretry）RED-first**：`smoke-workflow-executor` 补两条锁定断言并真实覆盖 serial retry 与 parallel child retry——serial `on_fail:retry/max_retries:3` 下该 failureType 只调用 1 次/attempt1（非 4 次）；parallel `on_fail:retry/max_retries:2` 下 storm-enforce child 只调用 1 次（非 3 次）而普通 agent-error child 仍重放 3 次（证明 retry 机制本身未坏）。RED 验证：临时移除该 failureType 后两条新 check 均失败（serial calls=4、parallel c2 calls=3），恢复后 30/30 绿。
- **P2（seal gate）RED-first**：源码锚点断言 enforce wiring region 含 seal gate 且 gate 紧邻 enforce 调用、FirstWriterTermination seal/claim 语义不变；**真实 SDK late event 行为断言**——3 次同签名 schema rejection + 4 次 provider error 耗尽 SDK retry（fast retry patch）→ prompt throw → catch path 同步 seal（无任何 owner claim，terminationRequested 保持 false）→ hanging session_shutdown 打开有界 closure 窗口 → 注入第 4 次同签名 rejection（subscribe 捕获真实 callback 直接调用）→ shadow 仍计数（consecutive 4/would_abort=true）但 seal gate 阻止任何 enforce decision 落盘（0 条 `schema_rejection_storm_enforce` 行），run 以原 provider error 终态。RED 验证：临时移除 seal gate 后该行为 check 失败（虚假 enforce decision 被落盘、run 被改写为 schema_rejection_storm_enforced），恢复后 27/27 绿。

### 定向复审：3 GREEN

修复后定向复审 3 票 GREEN，确认两个修复语义正确：workflow retry 不再重放治理终态（retry 机制本身未坏）、seal gate 阻止 run 已 terminal 时的虚假 enforce decision（shadow 仍计数、enforce 不落盘、run 以原终态结束）。

### production 正负 canary（最终有效证据）

`docs/evidence/2026-08-10-dispatch-storm-enforce-s4-production.json` 固化 S4 enforce 行为是 **production evidence、非 synthetic-only**（真实 deepseek-v4-flash provider + 真实 read tool + 真实 schema rejection；audit 源 gitignored mutable `.pi-astack/dispatch/audit.jsonl` path 引用不嵌入）。主 positive：session `019febab-a616-782f-8a89-6f9c25b4e74b`、run `dtr_71aba33d80debea947241f60`、worker `440ff156-8c14-41f0-93b9-1528e3156f22`、rule_version `dispatch-storm-enforce/v1`、duration 2968ms、tools 4、4 次同 exact identity（A=d4072bcf…/key_id `7a2e3c8c55f261fb329ab4b3`）schema rejection——shadow counts1..4（第三 post_cap/noabort、第四 would_abort/first_trip/basis consecutive），同一第 4 事件满足 enforce predicate 触发真实 abort decision（signal `schema_rejection_storm_enforce`、mode abort、action `abort_session_return_bounded_partial`、failure_type `schema_rejection_storm_enforced`、budget_kind consecutive、segment 0、termination_source worker_run_governor、elapsed 2948ms）；task failed/terminal failed/closure abnormal/owner worker_run_governor/closure complete/cleanup true/postclaim 0/0/postterminal 0。主 negative：session `019febae-ccb2-7794-9f67-47cb272dc7c4`、run `dtr_378273769527b2fcbf90b25e`、worker `7a8abc7f-e3a6-4363-8d5b-e462651fa9c0`、duration 19852ms、tools 6、digest 序列 A,A,B,A,A（A=d4072bcf…/B=f39283b5… 同 tool/class/path 不同 bounded normalized descriptor 不合并）——第 5 事件 consecutive_count=2（B 重启 streak）但 window_count=4（A 窗口密度）→ would_abort=true/first_trip/basis **rolling_window**，**rolling trip 绝不进 control：0 条 enforce 行**；success reset seg1、visible seg2、task completed/owner run/normal closure/cleanup true/postclaim 0/0/postterminal 0。全部 31 条 row hash（positive 12 + negative 19）经 `jq -cS . | tr -d '\n' | sha256sum` 从 audit 实际复算一致（hash 口径无尾换行；positive task `19543ebe…`、negative task `e65e94ee…`、enforce row `7b18eafd…`、rejected attempt1 task `aab1d895…`）。dossier 嵌入 `replay_projection`（schema_version `storm-enforce-replay-projection/v1`、status `production_data`）：positive 5 条 + negative 9 条安全预投影输入 + 每条 expected observation，不含 raw；已用项目 jiti 导入 `replayStormShadow` 实际重放两套 inputs 断言全部 expected match（positive 5/5、negative 9/9、0 mismatch、exit 0、final snapshot positive segment=0/post_cap=true/consecutive=4/window=4/tripped=true、negative segment=2/post_cap=false/consecutive=0/window=0/tripped=false）；**enforce predicate 复算：positive 恰好 1 个 eligible（唯一第 4 事件 seq5）、negative 0 eligible**，与 audit 实际 enforce 行数（positive 1、negative 0）一致。rejected history 如实记录：positive attempt1 外层 300s timeout（不计）；negative attempt1 run `dtr_f6e8a874895284f0ebf97411`/worker `7bd03523-ce8e-4c15-a439-fda454d61ce7` 模型偏离成 consecutive enforce，标 `rejected_as_negative_acceptance`（保留事实/hash 摘要但不称 rolling、不混入主证据）。

### 最终复审：Fable / OpenAI / Grok / Opus 全部 GREEN，无 P0/P1

四票全部 GREEN，无 P0/P1。复审逐项确认：

- **仅 consecutive 分支 enforce**：触发条件是完整 composite predicate（同一 strict exact composite signature 在同 segment `consecutive_count===4 && cap_after===3 && would_abort_basis==='consecutive'`），绝不得只看 would_abort / first_trip 单独成立；enforce 要求 governor.enabled && toolObservers.enabled && schemaErrorStorm.enabled && enforceConsecutiveExact && observeAfter===3。
- **rolling 永远 shadow**：rolling-window trip 绝不进 control（production negative canary 实证 0 条 enforce 行、run 正常完成）；即使 rolling 先 trip，后续 exact consecutive count 4 仍 enforce。
- **无 total cap**：无通用总量上限兜底；1000 次 rotating/success 不得触发任何 cap。
- **终止路径唯一**：真实 abort 走 WorkerRunGovernor 专用方法（`enforceSchemaRejectionStorm`，不重复 apply/increment counters）→ `emitWorkerRunDecision` → `requestGovernorTermination` → `FirstWriterTermination`；无直接 abort / tryClaim / 新 promise。
- **seal gate**：run 已 terminal（seal 或任何 owner 已 claim）时 enforce 不构造/不落盘虚假 decision；shadow 仍计数但 enforce 不触发，run 以原终态结束。
- **workflow nonretry taxonomy**：`schema_rejection_storm_enforced` 属治理终态，workflow retry policy 不重放（serial/parallel 均只调用 1 次，普通 agent-error 仍重放证明 retry 机制未坏）。
- **shadow 不变式**：shadow 行仍 mode observe/counterfactual（即使 consecutive 触发也原样保留）；storm-shadow.ts 保持纯状态机；shadowFeed 可返回 observation 供 wiring predicate 但 audit fail-open。
- **降级语义**：strict key unavailable → 安全 closed eligibility reason + shadow 不 eligible + enforce 不触发 + 每 run 最多 1 条 worker_run_enforce_event 降级 audit；unsupported cap / enforce disabled 无噪声；enabled 但 observeAfter!=3 每 run 1 条 unsupported_cap marker。
- **隐私**：原文/field path/tool args/normalized 不落盘，仅 opaque HMAC key_id+digest；audit 无 raw（privacy grep 验证）。
- **S1/S2/S3 回归**：terminal closure 22/22、dispatch-audit-v5 12/12、worker governor 90/90、storm shadow 34/34 等全绿，唯一 termination claim、诚实 cleanup、additive audit v5、shadow 控制流零影响语义未被放宽。

## 最终有效门

T0+ Fable + cross-vendor OpenAI / Grok / Opus 均 GREEN，无 P0/P1。审查确认：仅 consecutive 分支被授权并 enforce、rolling 永远 shadow、无 total cap、终止路径唯一、seal gate 与 workflow nonretry taxonomy 修复正确、shadow 不变式与隐私约束未被放宽。S4 的 implementation / evidence / review 三项 gate 通过（ENFORCE-IMPL / -EVIDENCE / -REVIEW 勾选，18/20）；submodule commit/push 与父仓 gitlink 尚未执行（本阶段不 commit/push），ENFORCE-SUBCOMMIT / -PARENT 保持未勾选，等待 subcommit。**rolling enforce 与 general cap 明确未授权**。

## 隐私处理

本记录只固化审查轮次、票型、暴露问题与修复语义，不粘贴 production 审计行正文、prompt 内容或用户会话内容；canary 事实与 hash 见 evidence dossier，审计行仅按路径引用（`.pi-astack/` 为本地未跟踪目录，不纳入本文件）。
