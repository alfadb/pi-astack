# 2026-08-10 dispatch audit v5 — T0+ / cross-vendor T0 review

## 结论

S2（additive audit v5）的 T0+/跨厂商 T0 审查经三轮收敛，最终复审全部 GREEN：**Fable / OpenAI gpt-5.6-sol / Grok / Kimi 均 GREEN，无 P0/P1**。S2 的 implementation / evidence / review 三项 gate 已通过（AUDITV5-IMPL / -EVIDENCE / -REVIEW 勾选，8/20）；submodule commit/push 与父仓 gitlink 尚未执行（本阶段不 commit/push），AUDITV5-SUBCOMMIT / -PARENT 与 S3–S4 全部 criteria 保持未勾选，不进入 S3。

审查全程确认：additive（不重写/删除既有字段语义）、不猜 stream（无显式 lifecycle evidence 时保持 unknown）、隐私（原文/prompt/tool args/output 不入 audit，仅 closed classification + 项目 audit HMAC 指纹）、join/closure 证据正确、end 事件不调用 governor observe（不增 counters）、enabled/disabled governor 语义（enabled=true 路径逐字不变；disabled 走 audit-only start builder，counters 保持 0、不触发 termination）、S1 回归全绿——这些约束均未被突破。

## 审查对象

- 实现：additive audit v5（`extensions/dispatch/audit-v5.ts` + `index.ts` 投影）、`buildWorkerRunRetryStartAuditEvent` / `buildWorkerRunRetryOutcomeAuditEvent`（governor-disabled 时 retry lifecycle 审计独立于 enable 开关）、`DISPATCH_AUDIT_VERSION = 5`、`smoke-dispatch-audit-v5.mjs` 与 `smoke-pr-c-hygiene.mjs` 锚点。
- 证据：dossier `docs/evidence/2026-08-10-dispatch-audit-v5-production.json`（`result=accepted_with_human_approved_retry_equivalent`、`mode=production_and_human_approved_equivalent_evidence`）——production A fresh-pi normal（`dtr_f59fb7e27aafc755356dcead` / worker `b34363ef-…` / 05:10:59.945Z / completed / closure normal·run·complete / hash `6d758050…`）、production B timeout（`dtr_5c96a18a72a76f651c1e6c76` / worker `141196f8-…` / 05:15:00.811Z / cancelled·idle timeout / marker PID 1635970 15s 观察窗后 absent / hash `a6e032ca…`）、production parallel（run0 `dtr_acd20cd…` hash `75e4c0bb…`、run1 `dtr_48316538…` hash `23eb90f9…`、aggregate hash `23b1b386…`）；历史 production retry 观察 220/67/192、2026-07-04..2026-08-09，`raw_sdk_end_or_error_persisted=false`。**该证据门是 production normal/timeout/parallel + 人批等价的 retry classification 分支组合，不是 live retry**——`human_approval.live_v5_provider_retry_observed=false` 原样保留，无 live provider v5 retry end/classification 观察，不冒充 live retry。
- 等价证据：`smoke-dispatch-audit-v5` 12/12（dossier `equivalent_test`：`kind=human_approved_equivalent`、`synthetic_equivalent_not_production=true`、`checks=12`、`result=PASS`），其中 3 条 sdk-equivalent `runInProcess` retry audit 集成回归 + 1 条 governor-disabled 真实 SDK `runInProcess` + faux provider 回归；明确 synthetic-equivalent 非 production acceptance。
- Smoke：`smoke-dispatch-audit-v5` 12/12、terminal closure 22/22、worker governor 90/90、workflow executor 28/28、workflow DSL/tools 15/15、dispatch output format 72/72、dispatch trace 25/25、reasoning trace 19/19、C5 schema、pr-c-hygiene、tool allowlist 82/82、parent context 29/29、runtime isolation 8/8 全部通过；`git diff --check` 干净；focused `tsc --noEmit` 通过（全入口 9 个既有基线错误未扩大）。

## 三轮审查记录

### 首轮（code review）：Fable / Opus / Kimi GREEN，Grok RED（stale smoke）

三票 code-GREEN；Grok 一票 RED，暴露 stale smoke：

- **stale pr-c v4 smoke**：`scripts/smoke-pr-c-hygiene.mjs` 的 `DISPATCH_AUDIT_VERSION = 4` 字面锚点未随源码 v5 更新，smoke 先于代码变红。
- 修复：锚点改为 `export const DISPATCH_AUDIT_VERSION = 5;`；retry end audit 事件 signal 明确为独立信号 `provider_retry_end`（仅 end builder，start/governor union 不动）；`smoke-dispatch-audit-v5` end-row 泄漏断言从「完整 secretError 不出现」强化为逐个检查敏感子串（原始错误特征 HTTP 503 / bearer token / prompt / tool args / output 代表片段，至少 4 个），audit 仍不进入原文；并在 `WorkerTerminationClosureEvidence` 旁注明 normal 路径 closure 可能先于同步 run claim、耗时以 `bounded_wait_ms` 为准。

修复后进入最终审查。

### 最终审查：Fable / Opus / Grok GREEN，OpenAI RED（单 P1）

三票 GREEN；OpenAI gpt-5.6-sol 一票 RED，暴露唯一 P1：

- **governor disabled 时 start 丢失 / end 孤立**：`workerRunGovernor.enabled=false` 时 `observe()` 返回 undefined，`auto_retry_start` 经 `emitWorkerRunDecision(decision)` 使 start audit 行完全丢失，而 `auto_retry_end` 仍直接写 end 行，形成孤立 end（无 start 配对）。
- 修复：retry lifecycle audit 独立于 governor enable 开关——新增专用 audit-only start builder `buildWorkerRunRetryStartAuditEvent`（signal `provider_retry_start`、action `audit_provider_retry_start_no_governor_transition`、从 summary snapshot 诚实投影、不伪造 decision、不更新 counters、不触发 termination）；`observe()` 返回 undefined（disabled 或已 terminal）时直接写完整 start row（真实 attempt/delay/outcome/classification/HMAC + join 字段）；enabled=true 现有 observe 与 budget 行为逐字不变。
- 补真实 SDK 回归：`runInProcess` + faux provider disabled 配置（temp HOME 子进程经真实 settings 文件解析 `enabled=false`，`PI_CODING_AGENT_DIR` 固定真实 agent dir）——断言 start+end 成对、start/end 同 `worker_run_id`/dispatch run/call join、`provider_retry_count` 保持 0、terminal 不受影响（run 正常 success、`termination_owner=run` / `lifecycle_path=normal`）、audit 全文无 raw、stream 不猜（无行带 stream 来源）。RED 验证：临时恢复旧路径后 `provider_retry_start rows=0`（start 丢失、end 孤立）失败，修复后 12/12 通过。现有 enabled sdk-equivalent 回归仍证明 `provider_retry_count` 只加一次（start 0→1、end 不增加）。

修复后进入最终复审。

### 最终复审：Fable / OpenAI / Grok / Kimi 全部 GREEN，无 P0/P1

四票全部 GREEN，无 P0/P1。复审逐项确认：

- **additive**：audit v5 只新增 termination / closure / provider retry error classification / join 字段，未重写/删除既有字段语义（v4 字段与 legacy row 语义保留，`smoke-dispatch-audit-v5` 有专项断言）。
- **不猜 stream**：无显式 lifecycle evidence 的事件保持 stream unknown，`stream disconnected` 等错误文本未把 stream attribution 推成 stream（run 正常 success、无行带 stream 来源）。
- **隐私**：audit jsonl 全文不含 raw error / prompt / tool args / output 敏感片段（error 原文、`PROMPT-SECRET-123`、`tool_args={password:x}`、`output=private`、`OUTPUT-SECRET-999`、`connection lost — ` 前缀）；错误仅保留 closed classification + 项目 audit HMAC 指纹（`auditHmacHex` 对实际错误文本的密钥化摘要，原文不入 audit）。
- **join/closure**：start/end 同 `worker_run_id` / `dispatch_run_id` / `dispatch_tool_call_id` / `task_index` 完整 join；task row 顶层 `worker_run_id` 从 governance summary 投影；closure evidence 区分 normal/preflight/abnormal，记录实际 owner/claim time、bounded wait、run/session/cleanup verdict 与 post-claim provider/tool start count。
- **end 不 observe**：`auto_retry_end` 只写 additive snapshot event（`buildWorkerRunRetryOutcomeAuditEvent`），不调用 governor observe、不增 counters、不触发 termination。
- **enabled/disabled governor 语义**：enabled=true 路径逐字不变（observe/budget 行为原样）；enabled=false 走 audit-only start builder——完整 start row 仍写入、counters 保持 0、不触发 termination；start/end 始终成对。
- **S1 回归**：terminal closure 22/22、worker governor 90/90 等 S1 相关 smoke 全绿，唯一 termination claim 与诚实 cleanup 语义未被放宽。

## 非阻塞 P2（如实记录，不隐瞒）

- 高系统负载（load average 明显偏高）下，3s idle SDK smoke 曾出现一次时序失败，重跑即绿：`smoke-dispatch-terminal-closure` 的 idle timeout 有界 join 检查（`TERMINAL_CLOSURE_WAIT_MS=3000`，断言 `elapsed < TERMINAL_CLOSURE_WAIT_MS + 1500` 上界）在负载拖慢下超上界失败；idle 超时本身按设计触发（`timeoutKind=idle`、归因 timeout、`cleanup_done=false`），失败来自负载导致的时序而非产品逻辑。修复后多次重跑与最终复审运行均 22/22 通过。此 P2 不构成 blocker，无代码改动。

## 证据门表述

AUDITV5-EVIDENCE 的满足依据是：**production normal / timeout / parallel 三个真实 audit v5 run**（A/B/parallel 的事实与 canonical jq-cS hash 全部复现）+ **人批等价的 retry classification 分支**（真实 SDK `runInProcess` + faux provider 的 sdk-equivalent 证据，`synthetic_equivalent_not_production=true`）。**不是 live retry**：`human_approval.live_v5_provider_retry_observed=false` 必须原样保留——无 live provider v5 retry end/classification 观察存在（raw SDK end/error 未持久化，v5 classification 不可直接复算），本审查不把等价证据表述为 live production retry 观察。

## 隐私处理

本记录只固化审查轮次、票型、暴露问题与修复语义，不粘贴 production 审计行正文、prompt 内容或用户会话内容；dossier 事实与 hash 见 `docs/evidence/2026-08-10-dispatch-audit-v5-production.json`，审计行仅按路径引用（`.pi-astack/` 为本地未跟踪目录，不纳入本文件）。
