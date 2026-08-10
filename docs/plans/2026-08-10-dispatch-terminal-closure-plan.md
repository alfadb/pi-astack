---
doc_type: plan
status: active
created: 2026-08-10
updated: 2026-08-10
---

# pi-astack dispatch 生命周期闭环 · 四阶段 Living Plan

**状态：Active；S1 implementation/evidence/review passed（3/20 criteria 勾选）；等待 S1 submodule commit/push 与父仓 gitlink；S2–S4 not started。**

本计划是 dispatch/agent 生命周期闭环任务的**唯一 living plan / 执行 SOT**。已确认目标与门禁（2026-08-10）冻结于下：分四阶段**严格串行**，阶段完成定义为「实现 + 真实生产数据或人批等价证据验收 + T0+/跨厂商 T0 审查无 blocker + 修复复审 + pi-astack 子模块 commit/push + 父仓仅 gitlink commit/push」；前一阶段全部 gate 通过后才进入下一阶段。本计划只承载执行目标、阶段边界与验收门，**不镜像技术细节到方向文档**（README §6 / REQ-006：实现机制属代码 + abrain 域）；实现现状以代码与 abrain 为准。

## Stable Goal

闭合 dispatch/agent 生命周期：以唯一 termination claim 终结运行，阻止 post-terminal 新 provider/tool 产生，abort/dispose 覆盖 bash 派生子进程，quiescence 有界、cleanup/closure 诚实；audit v5 以 additive 方式给出 termination/closure/provider retry error 分类与 join 字段（不猜 stream）；风暴规则以 shadow 形态（仅 would_abort 信号）在真实 production 数据上累积证据；单规则 enforce 仅基于 S3 真实 shadow 证据与逐条 T0+/T0 新授权启用，**不以通用 total tool cap 兜底**。

## In Scope

- S1：唯一 termination claim；阻止 post-terminal 新 provider/tool；abort/dispose 覆盖 bash 派生子进程；有界 quiescence；诚实 cleanup/closure。
- S2：additive audit v5——termination / closure / provider retry error classification / join 字段；纯 additive，不猜 stream。
- S3：风暴规则 shadow——post-cap exact schema signature 与有效进展语义候选评估；仅产出 would_abort 信号与对照记录，不改变控制流。
- S4：单规则 enforce——仅基于 S3 真实 production shadow 证据与逐条 T0+/T0 新授权启用；无通用 total tool cap。
- 每阶段固定的五类 gate：实现/行为、真实证据、T0+ 审查 + 修复复审、子模块 commit/push、父仓仅 gitlink commit/push。

## Out of Scope

- 任何非本任务范围的 pi-astack 改动（settings、方向/需求文档、无关扩展）。
- S3 阶段的任何控制流变更（真实 abort / 拦截 / 节流均不在 S3 内）。
- S4 的通用 total tool cap 或任何未经 S3 真实证据支持的批量规则启用。
- S2 对既有 audit 字段语义的改写、删除，或对缺失 stream 的臆造值。
- 修改/重写 `docs/direction.md`、`docs/vision.md`、`docs/requirements.md` 等方向文档（本计划是执行 SOT，不是方向变更）。
- 阶段外扩权：任一阶段完成不自动授权下一阶段之外的范围。

## Confirmed Facts

- 已确认目标与门禁（2026-08-10）：四阶段 S1→S2→S3→S4 严格串行；阶段完成 = 实现 + 真实生产数据或人批等价证据验收 + T0+/跨厂商 T0 审查无 blocker + 修复复审 + pi-astack 子模块 commit/push + 父仓仅 gitlink commit/push；完成后才进入下一阶段。
- S1 范围已确认：唯一 termination claim；阻止 post-terminal 新 provider/tool；abort/dispose 覆盖 bash；有界 quiescence；诚实 cleanup/closure。
- S2 范围已确认：additive audit v5（termination/closure/provider retry error classification/join 字段，不猜 stream）。
- S3 范围已确认：风暴规则 shadow（post-cap exact schema signature / 有效进展语义候选，仅 would_abort，不改变控制流）。
- S4 范围已确认：单规则 enforce（只能基于 S3 真实 production shadow 证据与 T0+/T0 新授权逐条启用；不得通用 total tool cap）。
- 本计划创建时：S1–S4 均未开始；无任何 criterion 勾选；无已确认的实现状态声明（实现/运行真相在代码 + abrain，本计划不镜像计数、文件清单或 commit 流水）。
- 本计划是执行 SOT；技术细节不镜像进方向文档。

## Frozen Constraints

- **严格串行**：S1 全部 gate 通过后进入 S2；S2 全部 gate 通过后进入 S3；S3 全部 gate 通过后进入 S4。前一阶段任一 gate 未通过，不得推进。
- **阶段完成定义固定**：五类 gate（实现/行为、真实证据、T0+ 审查无 blocker + 修复复审、子模块 commit/push、父仓仅 gitlink commit/push）全部通过；不得以部分 gate 或阶段性中间产物替代。
- **父仓仅 gitlink 暂存**：父仓每阶段提交只能精确暂存 `agent/skills/pi-astack` gitlink（`git add agent/skills/pi-astack`，即仅更新子模块指针）；不得暂存或修改 `agent/settings.json`（用户既有改动，必须原样保留，绝不混入任何阶段提交）。
- **唯一 termination claim**：termination 判定收敛到单一权威；不允许多个相互矛盾的终止判定源并存。
- **S3 仅 shadow**：只产出 would_abort 信号与候选对照记录；不改变任何控制流；S3 本身不启用任何规则。
- **S4 无 total tool cap**：单规则 enforce 只能基于 S3 真实 production shadow 证据，且每条规则逐条获得 T0+/T0 新授权后启用；禁止通用总量上限兜底。
- **S2 additive**：audit v5 只新增字段，不重写/删除既有字段语义；stream 缺失或未知时不猜值（additive 诚实标注，不臆造归属）。
- **criterion ID 稳定**：不得为让 goal 变绿而拆分、放宽、改名、删除或重新解释 acceptance gate；任何 criterion 文本语义修改都使匹配 evidence stale，须走与原阶段同等或更强的重新确认。
- **证据纪律**：acceptance 只认真实生产数据或人批等价证据；模型自述、synthetic-only 不算 production acceptance。

## Current State

> 本节是 living plan 的可重写热区。阶段切换、发现现场冲突或形成新阻塞时整节更新。

- 当前阶段：**S1 implementation/evidence/review passed**；等待 S1 submodule commit/push 与父仓 gitlink；S2/S3/S4 均 not started。
- TERM-CLOSURE-IMPL / TERM-CLOSURE-EVIDENCE / TERM-CLOSURE-REVIEW 已勾选（3/20）；TERM-CLOSURE-SUBCOMMIT / TERM-CLOSURE-PARENT 与 S2–S4 全部 criteria 保持未勾选。
- 四轮 T0+/跨厂商 T0 审查收敛：首轮 4 RED（pre-run / no-e2e / shutdown / singleflight）；二轮 3 RED+1 GREEN（P1-A stale smokes、P1-B prompt-success 抢 claim）；三轮 Fable/Opus/Kimi GREEN、Grok RED（tool_rejected/catch seal 覆盖）；最终收口 Fable/Grok/Kimi GREEN、Opus timeout 无裁决、补充 OpenAI gpt-5.6-sol T0 GREEN。最终有效门：T0+ Fable + cross-vendor Grok/Kimi/OpenAI 均 GREEN，无 P0/P1；Opus timeout 不当同意也不当反对。审查确认唯一 termination claim 与诚实 cleanup 语义未被放宽。
- S1 证据：production canary dossier `docs/evidence/2026-08-10-dispatch-terminal-closure-s1-production-canary.json`（run_id `dtr_66bb99e28dff042b789992cc`，terminal cancelled / failure_type timeout / timeout_kind idle / cleanup_done true / tool_call_count 1 / active bash age 5001ms / marker PID 1572609 在 15s 观察窗后 absent / 终态后 event count=0 / task 行 canonical jq hash `2523f19a…84598a`；首个 canary `dtr_c4a1fc58389b761b47866e6c` 因 worker 后台化命令 completed 且留下 PID 1571580，rejected_as_acceptance 并由本会话 kill 清理，不计入通过）；closure smoke 22 checks 全部 PASS（含四条 RED-first 回归），tool-allowlist（82 checks）、max-output-tokens、terminal-state、workflow executor/dsl/tools、worker governor（90 checks）等既有 smoke 全部通过；`git diff --check` 干净。
- 当前修复范围（S1 已收口）：SDK 最终 preflight provider-start 闸门、shutdown/dispose 有界与可升级 singleflight、run+closure 双证据 join、governor listener 重入规避、evidence-first partial/attribution/cleanup 投影、run-terminal seal（泛化：任何 run-owned 终态在 closure await 前同步 seal，abnormal bail 保留 first-writer），以及真实 `runInProcess` faux-provider 回归。
- 父仓 `/home/worker/.pi` 的既有 `M agent/settings.json` 必须原样保留；本阶段不 commit/push。

## Phase Table

| Phase | 名称 | 状态 | 前置 | 退出证据 | 下一动作 |
|---|---|---|---|---|---|
| S1 | 生命周期闭环 | implementation/evidence/review passed；等待 submodule commit/push 与父仓 gitlink | 本计划生效；无前置阶段 | TERM-CLOSURE-* 五项全部通过 | 进入 S2（依赖 S1 全部 gate） |
| S2 | additive audit v5 | not started | S1 全部五项 gate 通过 | AUDITV5-* 五项全部通过 | 进入 S3（依赖 S1+S2 全部 gate） |
| S3 | 风暴规则 shadow | not started | S2 全部五项 gate 通过 | STORM-SHADOW-* 五项全部通过 | 进入 S4（依赖 S1+S2+S3 全部 gate） |
| S4 | 单规则 enforce | not started | S3 全部五项 gate 通过 | ENFORCE-* 五项全部通过 | 计划完成 |

任一阶段完成**不**自动放宽 Frozen Constraints，也**不**自动勾选未获证据的 criteria。

## Acceptance Criteria

### Evidence Discipline

下面每一行都使用 goal parser 的真实格式 `- [ ] (criterion-id) text`。ID 是稳定证据主键；不得复用或改名。只有外部证据已经存在并且与当前 criterion 文本匹配时，才允许用普通 edit 把 `[ ]` 改成 `[x]`，随后用 `goal_check` 记录验证；裸 `[x]`、模型自述或旧 goal 的 evidence 都不算 verified。`goal_check` 的 evidence 必须是 `cmd:<shell>`、`file:<path>` 或 `git:<sha>`。复合 production 条件优先固化为不可变 dossier / manifest / 含证据的 Git commit，再由 `file:` / `git:` 指向。criterion 文本或声明输入发生语义漂移会使既有 evidence stale，必须重新检查。**所有项目初始未完成；本切片不得勾选任何项。模型自述 / synthetic-only 不计 production acceptance。**

### S1 — 生命周期闭环

前置依赖：无（本阶段为起始阶段）。退出即进入 S2。

- [x] (TERM-CLOSURE-IMPL) S1 实现完成且行为符合契约：存在唯一 termination claim（终止判定收敛到单一权威，无相互矛盾的终止判定源并存）；post-terminal 状态下新 provider/tool 的创建与派发被阻止；abort/dispose 覆盖经 bash 派生的子进程（不止直接 tool 调用）；quiescence 有界（不无限等待）；cleanup/closure 诚实（不虚构已完成/已清理状态）。行为由代码审查 + 针对性 smoke/测试佐证。
- [x] (TERM-CLOSURE-EVIDENCE) 真实生产数据或人批等价证据验收：在真实运行或人批等价证据上证明 S1 五条行为成立（termination claim 唯一、post-terminal 阻止、bash 子进程被 abort/dispose 覆盖、quiescence 有界、cleanup 诚实）；模型自述 / synthetic-only 不计。
- [x] (TERM-CLOSURE-REVIEW) T0+/跨厂商 T0 审查无 blocker，且修复后复审通过；审查确认唯一 termination claim 与诚实 cleanup 语义未被放宽。
- [ ] (TERM-CLOSURE-SUBCOMMIT) pi-astack 子模块 commit/push 完成，包含本阶段实现与证据。
- [ ] (TERM-CLOSURE-PARENT) 父仓仅 gitlink commit/push 完成（只更新子模块指针，不含其他文件改动）。

### S2 — additive audit v5

前置依赖：S1 全部五项 gate（TERM-CLOSURE-IMPL / -EVIDENCE / -REVIEW / -SUBCOMMIT / -PARENT）已通过且证据非 stale。退出即进入 S3。

- [ ] (AUDITV5-IMPL) S2 实现完成：audit v5 仅新增 termination / closure / provider retry error classification / join 字段，不重写、不删除既有字段语义；对 stream 缺失或未知的事件不猜值（additive 诚实标注，不臆造 stream 归属）。
- [ ] (AUDITV5-EVIDENCE) 真实生产数据或人批等价证据验收：audit v5 字段在真实生产数据上产生正确分类与 join 结果；缺 stream 的事件不被臆造 stream 归属；模型自述 / synthetic-only 不计。
- [ ] (AUDITV5-REVIEW) T0+/跨厂商 T0 审查无 blocker，且修复后复审通过；审查明确确认 additive 与不猜 stream 约束未被突破。
- [ ] (AUDITV5-SUBCOMMIT) pi-astack 子模块 commit/push 完成，包含本阶段实现与证据。
- [ ] (AUDITV5-PARENT) 父仓仅 gitlink commit/push 完成（只更新子模块指针，不含其他文件改动）。

### S3 — 风暴规则 shadow

前置依赖：S1 + S2 全部十项 gate 已通过且证据非 stale。退出即进入 S4。

- [ ] (STORM-SHADOW-IMPL) S3 实现完成：post-cap exact schema signature 与有效进展语义候选均已实现为候选评估；只产出 would_abort 信号与对照记录，不改变任何控制流（不实际 abort、不拦截、不节流）。
- [ ] (STORM-SHADOW-EVIDENCE) 真实生产数据或人批等价证据验收：shadow 信号在真实生产数据上可复算（exact schema signature 匹配、有效进展语义候选判定），且证明控制流零影响（would_abort 从未改变真实执行）；模型自述 / synthetic-only 不计。
- [ ] (STORM-SHADOW-REVIEW) T0+/跨厂商 T0 审查无 blocker，且修复后复审通过；审查确认 shadow 未改变控制流、未隐藏真实 abort 路径。
- [ ] (STORM-SHADOW-SUBCOMMIT) pi-astack 子模块 commit/push 完成，包含本阶段实现与证据。
- [ ] (STORM-SHADOW-PARENT) 父仓仅 gitlink commit/push 完成（只更新子模块指针，不含其他文件改动）。

### S4 — 单规则 enforce

前置依赖：S1 + S2 + S3 全部十五项 gate 已通过且证据非 stale。全部通过后本计划完成。

- [ ] (ENFORCE-IMPL) S4 实现完成：仅对 S3 真实 production shadow 证据支持的规则逐条启用 enforce；不存在通用 total tool cap（无总量上限兜底）；每条启用规则的触发条件与影响范围有明确记录。
- [ ] (ENFORCE-EVIDENCE) 真实生产数据或人批等价证据验收：每条被启用的 enforce 规则均对应 S3 shadow 的真实证据；enforce 启用后确认无通用 total tool cap 生效；模型自述 / synthetic-only 不计。
- [ ] (ENFORCE-REVIEW) 每条规则的启用均获得 T0+/T0 新授权（逐条授权，非打包授权）；T0+/跨厂商 T0 审查无 blocker，且修复后复审通过。
- [ ] (ENFORCE-SUBCOMMIT) pi-astack 子模块 commit/push 完成，包含本阶段实现与证据。
- [ ] (ENFORCE-PARENT) 父仓仅 gitlink commit/push 完成（只更新子模块指针，不含其他文件改动）。

## Current Blockers

- 无已确认 blocker。S1 implementation/evidence/review 已通过，等待 submodule commit/push 与父仓 gitlink；S2–S4 未开始，受 Frozen Constraints 严格串行约束。

## Execution Order (Planned)

1. **S1 生命周期闭环**：实现唯一 termination claim、post-terminal 阻止、abort/dispose 覆盖 bash、有界 quiescence、诚实 cleanup/closure；真实证据验收 → T0+ 审查 + 修复复审 → 子模块 commit/push → 父仓仅 gitlink commit/push。
2. **S2 additive audit v5**：在 S1 全部 gate 通过后，additive 新增 termination/closure/provider retry error classification/join 字段；证据 + 审查 + 双仓提交推送。
3. **S3 风暴规则 shadow**：在 S2 全部 gate 通过后，实现 post-cap exact schema signature 与有效进展语义候选为仅 would_abort 的 shadow；证据证明控制流零影响；审查 + 双仓提交推送。
4. **S4 单规则 enforce**：在 S3 全部 gate 通过后，仅基于 S3 真实证据与逐条 T0+/T0 新授权启用单规则；无 total tool cap；全部 gate 通过后本计划完成。

## Replanning Protocol

现场证据、代码、settings、Git 或 production 状态与本计划冲突时，先停止受影响执行，整节更新 Current State，并在 Decision Log 追加日期、冲突证据、影响范围、采用的新路径，再继续工作。Decision Log 只追加、不删除、不重写历史；错误决定通过后续条目 supersede。任何 criterion 文本的语义修改都会使匹配 evidence stale；修改前必须说明原因，修改后必须重新验证。不得为让 goal 变绿而拆小、放宽、改名、删除或重新解释 acceptance gate；若门确需改变，必须保留旧文本与裁决记录，并获得不低于原决策强度的重新确认（S4 的逐条授权门不得以打包授权替代）。

## Decision Log

- 2026-08-10：创建本 living plan 为 dispatch 生命周期闭环任务的唯一执行计划。已确认：四阶段 S1（生命周期闭环）→ S2（additive audit v5）→ S3（风暴规则 shadow）→ S4（单规则 enforce）严格串行；阶段完成定义固定为「实现 + 真实生产数据或人批等价证据验收 + T0+/跨厂商 T0 审查无 blocker + 修复复审 + pi-astack 子模块 commit/push + 父仓仅 gitlink commit/push」，前一阶段全部 gate 通过后才进入下一阶段。S1 范围 = 唯一 termination claim / 阻止 post-terminal 新 provider/tool / abort-dispose 覆盖 bash / 有界 quiescence / 诚实 cleanup-closure；S2 范围 = additive audit v5（termination/closure/provider retry error classification/join 字段，不猜 stream）；S3 范围 = 风暴规则 shadow（post-cap exact schema signature / 有效进展语义候选，仅 would_abort，不改变控制流）；S4 范围 = 单规则 enforce（仅基于 S3 真实 production shadow 证据与 T0+/T0 新授权逐条启用，不得通用 total tool cap）。本计划为执行 SOT，不镜像技术细节到方向文档；S1–S4 均未开始，全部 20 个 acceptance criteria 保持未勾选。
- 2026-08-10：首轮四模型 T0+/T0 审查为 RED，S1 转入 implementation/review remediation in progress。修复范围限定为：dispose-before-activeRun 的 SDK 最终 `preflightResult(true)` 同步闸门与 late hard-close；normal/abnormal `session_shutdown` 有界并确保 timeout 后 dispose；normal→immediate disposal 状态升级；tracked run + closure promise 双证据有界 join、无 session 与 late rejection 语义；governor listener 内同步 seal 后延迟 dispose；evidence-first attribution/partial 与 dispatch/workflow cleanup 投影；真实 production `runInProcess` faux-provider/SDK 测试。未授权且未进入 S2/S3/S4；未勾任何 criterion；不 commit/push。
- 2026-08-10：第二轮复审为 RED，两个 P1 已修复（仍不勾任何 criterion、不 commit/push）。P1-A：`scripts/smoke-dispatch-max-output-tokens.mjs` 与 `scripts/smoke-dispatch-subagent-tool-allowlist.mjs` 因源码字面锚点 stale 变红（`await session.prompt(prompt)` 已带 options 对象、tool rejection 改走 `startSessionClosure()`），已更新为鲁棒但不放宽语义的顺序/regex 锚点：仍证明 registry validation 与 maxTokens 安装发生在 prompt 前、tool rejection 走 bounded closure/dispose。P1-B：`session.prompt()` 成功返回后到 run owner claim 前的 normal closure 窗口，parent/idle/max-runtime 可抢 claim 把成功标 cancelled；已实现 run-terminal seal——prompt 正常返回的同步下一步（`sealRunTerminal()`）立即封住后续 external parent/timeout/governor claim（`FirstWriterTermination.sealExternalClaims()`，seal 后仅 run owner 可 claim）并停止/禁止 watchdog 重 arm（清 idle/max-runtime timer，`recordProgress` 在 seal 后不再 re-arm）；prompt 返回前已取得的 abnormal claim 保留 first-writer；不提前伪造最终 AgentResult，正常结果仍走 stopReason/error/truncated 分类与 closure。新增两条真实 `runInProcess` 回归：1) onProgress 在 `prompt_end` 触发 parent abort，结果仍为原成功（非 aborted）；2) session_shutdown 挂/慢 + 短 idle/maxRuntime，prompt 已成功时不得变 timeout，normal cleanup 仍有界（SESSION_SHUTDOWN_WAIT_MS）且 cleanup 诚实（挂起 shutdown → cleanupDone=false）。已运行：新增 closure smoke（17 checks 含两条新回归）、两处旧 smoke（max-output-tokens all ok；tool-allowlist 82 checks）、worker governor（90 checks）、terminal-state、workflow executor/dsl/tools、其余首轮修改 smoke，全部通过；`git diff --check` 干净。RED 验证：临时禁用 seal 后两条新回归均失败（成功被改写为 aborted / timeout_partial），恢复后通过。
- 2026-08-10：第三轮复审为 RED，单票 P1 已修复（仍不勾任何 criterion、不 commit/push）。P1：run-terminal seal 此前只在 `session.prompt()` 正常返回后调用，run-owned 终态已确定但先 await closure 的 `tool_rejected` 与 runPromise catch/crash 路径仍可被 late parent/timeout 抢 claim 把 failed 改写为 cancelled。修复：seal 语义泛化为「任何 run-owned 终态一旦确定、进入任何 closure await 之前，同步 seal external claims 并停止 watchdog」——统一 helper `sealRunTerminal()` 在 tool_rejected 路径（closure await 前）、catch 路径与 trackedRunPromise 拒绝处理调用（后两者带 `termination.claim?.owner === undefined` 守卫，不 seal 已有 abnormal bail 路径，如 pre-aborted signal / timeout / governor / TERMINATION_PREFLIGHT_ERROR）；prompt 返回前已取得的 abnormal claim 保留 first-writer。补四条真实 `runInProcess` RED-first 回归：1) tool_rejected + 挂起 session_shutdown + late parent abort 或短 idle timeout，最终仍 tool_rejected failed；2) prompt throw（rate_limit）+ 挂起 closure + late parent/timeout，最终仍原 provider failure；3) 既有 parent pre-run 先赢仍 parent。RED 验证：修复前四条新回归均失败（tool_rejected/rate_limit 被改写为 aborted/timeout），修复后通过。已运行：closure smoke（22 checks 含四条新回归）、tool-allowlist（82 checks）、max-output-tokens、terminal-state、workflow executor/dsl/tools、worker governor（90 checks），全部通过；`git diff --check` 干净。
- 2026-08-10：S1 四轮 T0+/跨厂商 T0 审查收敛，最终有效门通过（T0+ Fable + cross-vendor Grok/Kimi/OpenAI 均 GREEN，无 P0/P1；Opus 最终收口轮审查自身 timeout 无裁决，不当同意也不当反对）。首轮 4 RED 暴露 pre-run / no-e2e / shutdown / singleflight；二轮 3 RED+1 GREEN 暴露 stale smokes（P1-A 两处既有 smoke 源码字面锚点 stale，已更新为鲁棒但不放宽语义的顺序/regex 锚点）与 prompt-success 抢 claim（P1-B run-terminal seal）；三轮 Fable/Opus/Kimi GREEN、Grok RED 暴露 tool_rejected/catch seal 覆盖（seal 泛化为任何 run-owned 终态在 closure await 前同步 seal，abnormal bail 保留 first-writer，补四条 RED-first 回归）；最终收口 Fable/Grok/Kimi GREEN、Opus timeout 无裁决、补充 OpenAI gpt-5.6-sol T0 GREEN。S1 production canary 证据已固化（`docs/evidence/2026-08-10-dispatch-terminal-closure-s1-production-canary.json`；首个 canary `dtr_c4a1fc58389b761b47866e6c` 因 worker 后台化命令 completed 且留下 PID 1571580，rejected_as_acceptance 并由本会话 kill 清理，不计入通过），closure smoke 22 checks 全部 PASS。据此勾选 TERM-CLOSURE-IMPL / TERM-CLOSURE-EVIDENCE / TERM-CLOSURE-REVIEW（3/20）；TERM-CLOSURE-SUBCOMMIT / TERM-CLOSURE-PARENT 与 S2–S4 全部 criteria 保持未勾选；不 commit/push，不进入 S2。
