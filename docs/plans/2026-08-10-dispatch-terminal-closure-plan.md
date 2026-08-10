---
doc_type: plan
status: active
created: 2026-08-10
updated: 2026-08-10
---

# pi-astack dispatch 生命周期闭环 · 四阶段 Living Plan

**状态：Active；S1 五门全部完成；S2 五门全部完成（10/20 criteria 勾选）；S3 not started 但已具备进入前置；S4 not started。**

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

- 当前阶段：**S2 additive audit v5 五门全部完成（10/20）**；S1 全部五项 gate 已完成（5/20）；AUDITV5-* 五项全部已勾选（10/20）；S3–S4 全部 criteria 保持未勾选；S3 not started 但已具备进入前置；S4 not started。
- TERM-CLOSURE-* 五项全部已勾选（5/20）；AUDITV5-* 五项全部已勾选（10/20）；S3–S4 全部 criteria 保持未勾选。
- S2 当前实现切片：dispatch audit version 5 仅 additive；task row 从 governance summary 投影顶层 `worker_run_id`，worker events 在真实可用时携带 dispatch run/tool-call join；共享 `runInProcess` 结果新增 termination/closure evidence 并投影到 task/details/workflow stage；`auto_retry_start/end` 新增真实 attempt/delay/outcome、closed error classification 与项目 audit HMAC 指纹，原文不进入 `worker_run_event`，end 事件不调用 governor observe，start 审计独立于 governor enable 开关（enabled=false 时经专用 audit-only builder 仍写完整 start row、不碰 counters/termination）；stream 仍只接受显式 lifecycle evidence。
- 当前 focused verification：`smoke-dispatch-audit-v5` 12/12（含新增 3 条 sdk-equivalent runInProcess retry audit 集成回归与 1 条 governor-disabled 真实 SDK runInProcess + faux provider 回归）、S1 terminal closure 22/22、worker governor 90/90、workflow executor 28/28、workflow DSL 15/15、workflow tools 15/15、dispatch output format 72/72、dispatch trace 25/25、reasoning trace 19/19、C5 terminal/audit schema、tool snapshot、max-output、tool allowlist 82/82、parent context 29/29、runtime isolation 8/8 全部通过；`git diff --check` 干净。新增 audit/governor 模块 focused `tsc --noEmit` 通过；全入口 `tsc` 仍有 9 个既有基线错误（`pi-internals` / `runtime` / `dispatch-trace` 与既有 tool schema / required parent snapshot 类型），本轮未扩大修复范围；改动文件 TypeScript LSP 均为 0 diagnostics。
- S2 首轮 T0+/跨厂商 T0 代码审查：3 位审查者 code-GREEN + Grok RED（stale smoke——`smoke-pr-c-hygiene` 的 `DISPATCH_AUDIT_VERSION = 4` 字面锚点未跟随源码 v5，先于代码变红）；已修复锚点、retry end 事件 signal 明确为 `provider_retry_end`，并补强 end-row 泄漏断言为逐敏感子串。production evidence 尚缺 live retry 或人批等价证据；AUDITV5-* 全部保持未勾选；不 commit/push。
- **S2 sdk-equivalent 等价证据（非 production acceptance，不勾 criterion）**：`smoke-dispatch-audit-v5` 新增真实 SDK `runInProcess` + faux provider retry audit 集成回归 3 条，确定性触发真实 AgentSession `auto_retry_start`/`auto_retry_end` 事件路径（SettingsManager 短退避 patch + model-fallback `connection lost — ` 前缀），写入 `<tempRoot>/.pi-astack/dispatch/audit.jsonl` 并断言：start row `signal=provider_retry`/`retry_phase=start` 携带真实 attempt=1/maxAttempts=3/delayMs=25/outcome=retrying/closed classification（与 run 实际观察到的错误文本复算一致）/`http_status=503`/HMAC 指纹（digest、key_id 与 `auditHmacHex` 对实际错误文本的密钥化摘要完全一致，原文不入 audit）；end row `signal=provider_retry_end`/`retry_phase=end`/outcome=recovered/classification=none、无伪造 HTTP/指纹；start/end 同 `worker_run_id`/`dispatch_run_id`/`dispatch_tool_call_id`/task_index 完整 join；governor `provider_retry_count` 仅 start 0→1、end 不增加；audit jsonl 全文不含 raw error/prompt/tool args/output 敏感片段（error 原文、`PROMPT-SECRET-123`、`tool_args={password:x}`、`output=private`、`OUTPUT-SECRET-999`、`connection lost — ` 前缀）；错误文本（含 `stream disconnected`）未把 stream attribution 推成 stream——run 正常 success、`termination_owner=run`/`lifecycle_path=normal`、无任何行带 stream 来源。RED 验证：禁用 retry 后三条新 check 全部失败（非空转断言）。这是等价测试证据、非 live-provider production acceptance；AUDITV5-* 全部保持未勾选。
- 四轮 T0+/跨厂商 T0 审查收敛：首轮 4 RED（pre-run / no-e2e / shutdown / singleflight）；二轮 3 RED+1 GREEN（P1-A stale smokes、P1-B prompt-success 抢 claim）；三轮 Fable/Opus/Kimi GREEN、Grok RED（tool_rejected/catch seal 覆盖）；最终收口 Fable/Grok/Kimi GREEN、Opus timeout 无裁决、补充 OpenAI gpt-5.6-sol T0 GREEN。最终有效门：T0+ Fable + cross-vendor Grok/Kimi/OpenAI 均 GREEN，无 P0/P1；Opus timeout 不当同意也不当反对。审查确认唯一 termination claim 与诚实 cleanup 语义未被放宽。
- S1 证据：production canary dossier `docs/evidence/2026-08-10-dispatch-terminal-closure-s1-production-canary.json`（run_id `dtr_66bb99e28dff042b789992cc`，terminal cancelled / failure_type timeout / timeout_kind idle / cleanup_done true / tool_call_count 1 / active bash age 5001ms / marker PID 1572609 在 15s 观察窗后 absent / 终态后 event count=0 / task 行 canonical jq hash `2523f19a…84598a`；首个 canary `dtr_c4a1fc58389b761b47866e6c` 因 worker 后台化命令 completed 且留下 PID 1571580，rejected_as_acceptance 并由本会话 kill 清理，不计入通过）；closure smoke 22 checks 全部 PASS（含四条 RED-first 回归），tool-allowlist（82 checks）、max-output-tokens、terminal-state、workflow executor/dsl/tools、worker governor（90 checks）等既有 smoke 全部通过；`git diff --check` 干净。
- 当前修复范围（S1 已收口）：SDK 最终 preflight provider-start 闸门、shutdown/dispose 有界与可升级 singleflight、run+closure 双证据 join、governor listener 重入规避、evidence-first partial/attribution/cleanup 投影、run-terminal seal（泛化：任何 run-owned 终态在 closure await 前同步 seal，abnormal bail 保留 first-writer），以及真实 `runInProcess` faux-provider 回归。
- 父仓 `/home/worker/.pi` 的既有 `M agent/settings.json` 在 S2 双仓提交中原样保留、未混入；后续 S3/S4 提交仍只精确暂存 gitlink，绝不动 settings。
- S1 子模块 commit `3b845aa928318ef28e10bdba72b16b509069aff7`（fix(dispatch): close worker lifecycle before terminal，含本阶段实现与证据）已 push；父仓仅 gitlink commit `48cd816eef1449f2ea76c1f2478815d0db66cd57`（chore: update pi-astack for dispatch closure，仅更新子模块指针，不含其他文件改动）已 push。
- S2 子模块 commit `d6ce596727daec298ce985ef12e20a53dc0c4882`（feat(dispatch): add additive audit v5 evidence，含本阶段实现与证据）已 push；父仓仅 gitlink commit `d45e413eda435f52d8794d23063cbbbb85f87a4e`（chore: update pi-astack for dispatch audit v5，仅更新子模块指针，1 file changed，不含其他文件改动）已 push，父仓既有 `M agent/settings.json` 原样保留未混入。
- **S2 证据 dossier（production + 人批等价证据，不勾 criterion、不 commit/push）**：`docs/evidence/2026-08-10-dispatch-audit-v5-production.json` 已固化（顶层 `result=accepted_with_human_approved_retry_equivalent`），audit 行以 gitignored mutable source 路径引用（`.pi-astack/dispatch/audit.jsonl`），不嵌入原文。固化事实：production A fresh-pi normal（`dtr_f59fb7e27aafc755356dcead` / worker `b34363ef-a8de-4916-ae19-9b5f615528bc` / task 05:10:59.945Z / audit_version 5 / completed / closure normal·run·complete·cleanup true·run/session settled true·wait 1/3000·postclaim 0/0 / 事件 join / postterminal 0 / canonical jq-cS hash `6d758050…`）；production B timeout（`dtr_5c96a18a72a76f651c1e6c76` / worker `141196f8-a255-4c17-9abd-a95519866c12` / task 05:15:00.811Z / cancelled·idle timeout / closure abnormal·timeout·complete·cleanup true·wait 9/3000·postclaim 0/0 / marker PID 1635970 15s 后 absent / postterminal 0 / hash `a6e032ca…`）；production parallel（session `019fea3e-560f-79d9-aa67-e9a65db87886`、tool call id 完整记录，run0 `dtr_acd20cd9e523e48031bd0176` / worker `099d68a7-6a7e-4fac-9beb-77b3c5db920c` / 05:56:32.664Z / hash `75e4c0bb…`，run1 `dtr_48316538a9f67a94f275b1a7` / worker `c0d4ad16-7cea-4b99-95f6-2e58aedb8356` / 05:56:31.931Z / hash `23eb90f9…`，aggregate 05:56:32.672Z / hash `23b1b386…`；2 completed、6 joined events、aggregate IDs/closures exact、outer exit0 ~14s）；历史 production retry 观察（220 task-level auto_retry_start / 67 session files / 192 calls / 2026-07-04..2026-08-09，raw SDK end/error 未持久化故 v5 classification 不可直接复算；代表承载行 A/B 以 path+line 固化）；等价测试 `smoke-dispatch-audit-v5` 12/12（真实 SDK runInProcess + faux provider 确定 start/end，验证 classification/HMAC/no raw/end 不增 governor/join/stream unknown；明确 synthetic-equivalent 非 production）。dossier 内诚实标注：外层 pi 在 A task 写完后 180s shell timeout 诚实记录、归因不确定。执行者复算确认：5 个 production task-row hash 与 67/220/192/date-range 全部复现；`same-call start + eventual success` 经精确 jq 复算为 23（dossier verification 记录 recomputed=true 与精确 jq 语义）；A/B 代表行 body hash 经无换行行本体算法（`awk 'NR==N {printf "%s",$0}' <path> | sha256sum`）精确复现。
- **S2 OpenAI 最终审查 RED（单 P1）与修复（AUDITV5-* 仍全部未勾选，不 commit/push）**：OpenAI gpt-5.6-sol 最终收口审查发现唯一 P1——`workerRunGovernor.enabled=false` 时 `observe()` 返回 undefined，`auto_retry_start` 经 `emitWorkerRunDecision(decision)` 使 start audit 行完全丢失，而 `auto_retry_end` 仍直接写行，形成孤立 end（无 start 配对）。修复：retry lifecycle audit 独立于 governor enable 开关——新增专用 audit-only start builder `buildWorkerRunRetryStartAuditEvent`（signal `provider_retry_start`、action `audit_provider_retry_start_no_governor_transition`、snapshot projection，不伪造 decision），当 `observe()` 返回 undefined（disabled 或已 terminal）时直接写完整 start row（真实 attempt/delay/outcome/classification/HMAC + join 字段），绝不更新 governor counters、绝不触发 termination；enabled=true 时现有 observe 与 budget 行为逐字不变。补真实 SDK `runInProcess` + faux provider disabled 配置回归（temp HOME 子进程经真实 settings 文件解析 enabled=false，`PI_CODING_AGENT_DIR` 固定真实 agent dir）：断言 start+end 成对、start/end 同 `worker_run_id`/dispatch run/call join、`provider_retry_count` 保持 0、terminal 不受影响（run 正常 success、`termination_owner=run`/`lifecycle_path=normal`）、audit 全文无 raw、stream 不猜（无行带 stream 来源）。RED 验证：临时恢复旧路径后 `provider_retry_start rows=0`（start 丢失、end 孤立），修复后 12/12 通过。现有 enabled sdk-equivalent 回归仍证明 `provider_retry_count` 只加一次（start 0→1、end 不增加）。
- **S2 人批等价证据已批准（复审已确认）**：当前会话用户明确选择「批准等价证据，按此完成 S2 审查与提交（推荐）」，仅批准 retry classification 分支的上述组合（production observations + sdk-equivalent runInProcess evidence）；`live_v5_provider_retry_observed=false` 不得改写（无 live provider v5 retry end/classification 观察）。AUDITV5-EVIDENCE 的文本要求「真实生产数据或人批等价证据验收」由本 dossier + 人批等价组合构成满足；AUDITV5-SUBCOMMIT / -PARENT 与 S3–S4 全部 criteria 保持未勾选；不 commit/push，不进入 S3。
- **S2 最终复审全部 GREEN（AUDITV5-IMPL / -EVIDENCE / -REVIEW 已勾选，8/20；SUBCOMMIT/PARENT 与 S3–S4 未勾选，不 commit/push、不进入 S3）**：最终复审 Fable / OpenAI gpt-5.6-sol / Grok / Kimi 全部 GREEN，无 P0/P1。逐项确认：additive（v4 字段与 legacy 语义保留）、不猜 stream（无显式 lifecycle evidence 保持 unknown）、隐私（原文/prompt/tool args/output 不入 audit，仅 closed classification + 项目 audit HMAC 指纹）、join/closure 证据、end 事件不调用 governor observe（不增 counters）、enabled/disabled governor 语义（enabled=true 路径逐字不变；disabled 走 audit-only start builder，counters 保持 0、不触发 termination）、S1 回归全绿（terminal closure 22/22、worker governor 90/90 等）。证据门表述：production A normal / B timeout / parallel 三 run + 人批等价的 retry classification 分支（sdk-equivalent `runInProcess`，`synthetic_equivalent_not_production=true`），**非 live retry**——`human_approval.live_v5_provider_retry_observed=false` 原样保留、不得改写。非阻塞 P2 如实记录：高系统 load 下 3s idle SDK smoke（terminal-closure idle 有界 join 时序断言，`TERMINAL_CLOSURE_WAIT_MS=3000`）曾时序失败一次、重跑绿，失败为 idle 按设计触发 + 负载时序、非产品逻辑。审查报告 `docs/audits/2026-08-10-dispatch-audit-v5-t0-review.md` 已固化。

## Phase Table

| Phase | 名称 | 状态 | 前置 | 退出证据 | 下一动作 |
|---|---|---|---|---|---|
| S1 | 生命周期闭环 | 完成（TERM-CLOSURE-* 五项全部通过） | 本计划生效；无前置阶段 | TERM-CLOSURE-* 五项全部通过 | 已满足，可进入 S2 |
| S2 | additive audit v5 | 完成（AUDITV5-* 五项全部通过） | S1 全部五项 gate 通过（已满足） | AUDITV5-* 五项全部通过（已满足） | 已满足，可进入 S3 |
| S3 | 风暴规则 shadow | not started（已具备进入前置） | S1+S2 全部十项 gate 通过（已满足） | STORM-SHADOW-* 五项全部通过 | 进入 S4（依赖 S1+S2+S3 全部 gate） |
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
- [x] (TERM-CLOSURE-SUBCOMMIT) pi-astack 子模块 commit/push 完成，包含本阶段实现与证据。
- [x] (TERM-CLOSURE-PARENT) 父仓仅 gitlink commit/push 完成（只更新子模块指针，不含其他文件改动）。

### S2 — additive audit v5

前置依赖：S1 全部五项 gate（TERM-CLOSURE-IMPL / -EVIDENCE / -REVIEW / -SUBCOMMIT / -PARENT）已通过且证据非 stale。退出即进入 S3。

- [x] (AUDITV5-IMPL) S2 实现完成：audit v5 仅新增 termination / closure / provider retry error classification / join 字段，不重写、不删除既有字段语义；对 stream 缺失或未知的事件不猜值（additive 诚实标注，不臆造 stream 归属）。
- [x] (AUDITV5-EVIDENCE) 真实生产数据或人批等价证据验收：audit v5 字段在真实生产数据上产生正确分类与 join 结果；缺 stream 的事件不被臆造 stream 归属；模型自述 / synthetic-only 不计。
- [x] (AUDITV5-REVIEW) T0+/跨厂商 T0 审查无 blocker，且修复后复审通过；审查明确确认 additive 与不猜 stream 约束未被突破。
- [x] (AUDITV5-SUBCOMMIT) pi-astack 子模块 commit/push 完成，包含本阶段实现与证据。
- [x] (AUDITV5-PARENT) 父仓仅 gitlink commit/push 完成（只更新子模块指针，不含其他文件改动）。

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

- 无已确认 blocker。S1 五门全部完成（5/20）；S2 五门全部完成（10/20）；S3 not started 但已具备进入前置；S4 not started；后续阶段受 Frozen Constraints 严格串行约束。

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
- 2026-08-10：S1 收尾双仓提交完成并已 push。pi-astack 子模块实现与证据 commit `3b845aa928318ef28e10bdba72b16b509069aff7`（fix(dispatch): close worker lifecycle before terminal）已 push；父仓仅 gitlink commit `48cd816eef1449f2ea76c1f2478815d0db66cd57`（chore: update pi-astack for dispatch closure，仅更新子模块指针，不含其他文件改动）已 push，父仓既有 `M agent/settings.json` 原样保留未混入。据此勾选 TERM-CLOSURE-SUBCOMMIT / TERM-CLOSURE-PARENT，S1 五门全部完成（5/20）；S2 not started 但已具备进入前置；不进入 S2 实现。
- 2026-08-10：S2 additive audit v5 implementation in progress（不勾 criterion、不 commit/push、不进入 S3/S4）。设计裁决：复用 S1 `FirstWriterTermination`、session closure promise 与 `WorkerRunGovernanceSummary`，只做 AgentResult/task/details/workflow stage 投影，不复制状态机；task row 顶层 `worker_run_id` 只来自真实 governance summary，worker event 的 dispatch run/call join 仅在现有 context 可用时写入；termination/closure evidence 区分 normal/preflight/abnormal，并记录实际 owner/claim time、closure time/status、bounded wait、run/session/cleanup verdict 与分开的 post-claim provider/tool start count；retry start/end 使用 SDK 结构化字段，end 只写 additive snapshot event、不调用 governor observe，错误仅保留 closed classification + 项目 audit HMAC 指纹，HTTP code 要求显式 HTTP/status/code evidence，原文/prompt/tool args/output 不进入 worker event；stream 无显式 lifecycle evidence 时继续 unknown。新增 `smoke-dispatch-audit-v5` 并注册，现有 S1 22 项与 governor/workflow/trace 相关回归通过；production evidence 与独立审查尚未执行。
- 2026-08-10：S2 首轮 T0+/跨厂商 T0 审查：3 code-GREEN + Grok RED（stale smoke——`scripts/smoke-pr-c-hygiene.mjs` 的 `DISPATCH_AUDIT_VERSION = 4` 字面锚点未随源码 v5 更新，smoke 先于代码变红）。修复：锚点改为 `export const DISPATCH_AUDIT_VERSION = 5;`；retry end audit 事件 signal 明确为 `provider_retry_end`（仅 end builder，start/governor union 不动），并在 `WorkerTerminationClosureEvidence` 旁注明 normal 路径 closure 可能先于同步 run claim、耗时以 `bounded_wait_ms` 为准；`smoke-dispatch-audit-v5` end-row 泄漏断言从「完整 secretError 不出现」强化为逐个检查至少 4 个敏感子串（原始错误特征 HTTP 503 / bearer token / prompt / tool args / output 代表片段），audit 仍不进入原文。production evidence 尚缺 live retry 或人批等价证据；AUDITV5-* criteria 不勾选；不 commit/push，不进入 S3/S4。
- 2026-08-10：S2 证据固化 + 人批等价证据批准（AUDITV5-* 仍全部未勾选，不 commit/push）。固化 `docs/evidence/2026-08-10-dispatch-audit-v5-production.json`（顶层 `result=accepted_with_human_approved_retry_equivalent`）：production A/B/parallel 三 run 的事实与 canonical jq-cS hash 经执行者复算全部复现（`6d758050…` / `a6e032ca…` / `75e4c0bb…` / `23eb90f9…` / `23b1b386…`）；历史 production retry 观察 220/67/192/2026-07-04..2026-08-09 经精确 JSON 解析复现，raw SDK end/error 未持久化故 v5 classification 不可直接复算（与 criterion 文本中「真实生产数据或人批等价证据」的等价分支对应）；代表承载行 A/B 以 path+line 固化（body hash 经无换行行本体算法 `awk 'NR==N {printf "%s",$0}' <path> | sha256sum` 精确复现；`same-call start + eventual success` 经精确 jq 复算为 23，dossier verification 记录 recomputed=true）；A 外层 pi 180s shell timeout 诚实记录、归因不确定、不影响 audit row。`smoke-dispatch-audit-v5` 11/11 PASS（真实 SDK runInProcess + faux provider，明确 synthetic-equivalent 非 production）。当前会话用户选择「批准等价证据，按此完成 S2 审查与提交（推荐）」，仅批准 retry classification 分支的 production observations + sdk-equivalent 组合；`live_v5_provider_retry_observed=false` 不得改写。据此本 dossier 供 AUDITV5-EVIDENCE 等复审，但 AUDITV5-* 五项仍全部保持未勾选，不 commit/push，不进入 S3/S4。
- 2026-08-10：S2 OpenAI 最终收口审查 RED（单 P1），已修复（AUDITV5-* 仍全部未勾选，不 commit/push、不进入 S3）。P1：`workerRunGovernor.enabled=false` 时 `observe()` 返回 undefined，`auto_retry_start` 经 `emitWorkerRunDecision(decision)` 使 start audit 行完全丢失，而 `auto_retry_end` 仍写 end 行，形成孤立 end。裁决：retry lifecycle audit 独立于 governor enable 开关——新增专用 audit-only start builder `buildWorkerRunRetryStartAuditEvent`（signal `provider_retry_start`、action `audit_provider_retry_start_no_governor_transition`，从 summary snapshot 投影，不伪造 decision，不更新 counters、不触发 termination），`observe()` 返回 undefined（disabled 或已 terminal）时直接写完整 start row（attempt/delay/outcome/classification/HMAC/join），enabled=true 路径逐字不变。补真实 SDK `runInProcess` + faux provider disabled 配置回归（temp HOME 子进程经真实 settings 文件解析 enabled=false + `PI_CODING_AGENT_DIR` 固定真实 agent dir）：start+end 成对、同 join、`provider_retry_count` 保持 0、terminal 不受影响、无 raw、stream 不猜；现有 enabled sdk-equivalent 回归仍证明 count 只加一次。RED 验证：临时恢复旧路径后 `provider_retry_start rows=0`（start 丢失、end 孤立）失败，恢复后通过。已运行：`smoke-dispatch-audit-v5` 12/12、terminal-closure 22/22、worker governor 90/90、pr-c-hygiene、workflow executor 28/28、workflow DSL/tools、C5 schema/terminal-state、dispatch output-format/trace/reasoning-trace、c5，全部通过；`git diff --check` 干净；改动文件 LSP 0 diagnostics、focused tsc 通过（全入口 9 个既有基线错误未扩大）。
- 2026-08-10：S2 最终复审全部 GREEN（AUDITV5-IMPL/-EVIDENCE/-REVIEW 勾选，8/20；不 commit/push、不进入 S3/S4）。最终复审 Fable / OpenAI gpt-5.6-sol / Grok / Kimi 全部 GREEN，无 P0/P1。逐项确认：additive（不重写/删除既有字段语义、v4 legacy 保留）、不猜 stream（无显式 lifecycle evidence 保持 unknown）、隐私（原文/prompt/tool args/output 不入 audit、仅 closed classification + 项目 audit HMAC 指纹）、join/closure、end 不调用 governor observe、enabled/disabled governor 语义（enabled=true 逐字不变；disabled 走 audit-only start builder、counters 保持 0、不触发 termination）、S1 回归全绿。证据门（AUDITV5-EVIDENCE）表述为 production A normal / B timeout / parallel 三 run + 人批等价的 retry classification 分支（sdk-equivalent `runInProcess`，`synthetic_equivalent_not_production=true`），**非 live retry**——`human_approval.live_v5_provider_retry_observed=false` 原样保留、不得改写（无 live provider v5 retry end/classification 观察）。非阻塞 P2 如实记录：高系统 load 下 3s idle SDK smoke（terminal-closure idle 有界 join 时序断言，`TERMINAL_CLOSURE_WAIT_MS=3000`）曾时序失败一次、重跑绿，失败为 idle 按设计触发 + 负载时序、非产品逻辑、无代码改动。审查报告 `docs/audits/2026-08-10-dispatch-audit-v5-t0-review.md` 固化；`smoke-dispatch-audit-v5` 12/12、terminal-closure 22/22 复审复跑通过；`git diff --check` 干净。据此勾选 AUDITV5-IMPL / -EVIDENCE / -REVIEW（8/20）；AUDITV5-SUBCOMMIT / -PARENT 与 S3–S4 全部保持未勾选；不 commit/push，不进入 S3/S4。
- 2026-08-10：S2 收尾双仓提交完成并已 push。pi-astack 子模块实现与证据 commit `d6ce596727daec298ce985ef12e20a53dc0c4882`（feat(dispatch): add additive audit v5 evidence）已 push；父仓仅 gitlink commit `d45e413eda435f52d8794d23063cbbbb85f87a4e`（chore: update pi-astack for dispatch audit v5，仅更新子模块指针，1 file changed）已 push，父仓既有 `M agent/settings.json` 原样保留未混入。据此勾选 AUDITV5-SUBCOMMIT / AUDITV5-PARENT，S2 五门全部完成（10/20）；S3 not started 但已具备进入前置（受严格串行约束，S3 未开始、不进入实现）；S4 not started。
