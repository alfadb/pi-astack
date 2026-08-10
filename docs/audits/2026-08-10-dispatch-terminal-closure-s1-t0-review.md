# 2026-08-10 dispatch terminal closure S1 — T0+ / cross-vendor T0 review

## 结论

S1（生命周期闭环）的 T0+/跨厂商 T0 审查经四轮收敛，最终有效门通过：**T0+ Fable + cross-vendor Grok / Kimi / OpenAI 均 GREEN，无 P0/P1**。Opus 在最终收口轮因审查自身 timeout 无裁决，按「不当同意也不当反对」处理，不构成 blocker 也不构成通过票。S1 的 implementation / evidence / review 三项 gate 已通过；submodule commit/push 与父仓 gitlink 尚未执行（本阶段不 commit/push）。

## 审查对象

- 实现：唯一 termination claim（`FirstWriterTermination` + 泛化 `sealRunTerminal()`）、post-terminal 阻止、abort/dispose 覆盖 bash 派生子进程、有界 quiescence、诚实 cleanup/closure；SDK 最终 preflight provider-start 闸门、shutdown/dispose 有界与可升级 singleflight、run+closure 双证据 join、governor listener 重入规避、evidence-first partial/attribution/cleanup 投影。
- 证据：production canary dossier `docs/evidence/2026-08-10-dispatch-terminal-closure-s1-production-canary.json`（run_id `dtr_66bb99e28dff042b789992cc`，worker_run_id `20f7dce5-85a5-44d8-b9b4-64f34886f05f`，terminal cancelled / failure_type timeout / timeout_kind idle / cleanup_done true / tool_call_count 1 / active bash age 5001ms / marker PID 1572609 在 15s 观察窗后 absent / 终态后 event count=0 / task 行 canonical jq hash `2523f19a…84598a`；首个 canary `dtr_c4a1fc58389b761b47866e6c` 因 worker 后台化命令 completed 且留下 PID 1571580，明确 rejected_as_acceptance 并由本会话 kill 清理，不计入通过）。
- Smoke：`scripts/smoke-dispatch-terminal-closure.mjs` 22 checks 全部 PASS（含四条 RED-first 回归：tool_rejected + 挂起 session_shutdown + late parent abort / 短 idle timeout 仍 tool_rejected failed；prompt throw + 挂起 closure + late parent/timeout 仍原 provider failure；parent pre-run 先赢仍 parent）；另含 tool-allowlist（82 checks）、max-output-tokens、terminal-state、workflow executor/dsl/tools、worker governor（90 checks）等既有 smoke 全部通过。

## 四轮审查记录

### 首轮：4 RED

四模型 T0+/T0 审查均为 RED，暴露四类问题：

- **pre-run**：parent claim 在 prompt_start pre-run 窗口内未阻止 provider 启动（early dispose 为 no-op 时仍可能启动 provider）。
- **no-e2e**：缺少端到端验证路径，行为仅靠单元级佐证。
- **shutdown**：normal/abnormal `session_shutdown` 挂起/慢时无界等待风险。
- **singleflight**：normal→immediate disposal 状态升级与 dispose 去重/有界性不足。

修复后进入第二轮。

### 二轮：3 RED + 1 GREEN

三票 RED、一票 GREEN，RED 暴露两个 P1：

- **P1-A stale smokes**：`smoke-dispatch-max-output-tokens.mjs` 与 `smoke-dispatch-subagent-tool-allowlist.mjs` 因源码字面锚点 stale 变红（`await session.prompt(prompt)` 已带 options 对象、tool rejection 改走 `startSessionClosure()`）；已更新为鲁棒但不放宽语义的顺序/regex 锚点。
- **P1-B prompt-success 抢 claim**：`session.prompt()` 成功返回后到 run owner claim 前的 normal closure 窗口，parent/idle/max-runtime 可抢 claim 把成功标 cancelled；已实现 run-terminal seal（prompt 正常返回的同步下一步封住后续 external claim 并停止/禁止 watchdog 重 arm；prompt 返回前已取得的 abnormal claim 保留 first-writer）。

修复后进入第三轮。

### 三轮：Fable / Opus / Kimi GREEN，Grok RED

Fable、Opus、Kimi 三票 GREEN；Grok 一票 RED，暴露单票 P1：

- **tool_rejected / catch seal 覆盖**：run-terminal seal 此前只在 `session.prompt()` 正常返回后调用，run-owned 终态已确定但先 await closure 的 `tool_rejected` 与 runPromise catch/crash 路径仍可被 late parent/timeout 抢 claim 把 failed 改写为 cancelled（aborted/timeout）。
- 修复：seal 语义泛化为「任何 run-owned 终态一旦确定、进入任何 closure await 之前，同步 seal external claims 并停止 watchdog」——统一 helper `sealRunTerminal()` 在 tool_rejected 路径（closure await 前）、catch 路径与 trackedRunPromise 拒绝处理调用（后两者带 `termination.claim?.owner === undefined` 守卫，不 seal 已有 abnormal bail 路径）；prompt 返回前已取得的 abnormal claim 仍保留 first-writer。补四条真实 `runInProcess` RED-first 回归，修复前均失败、修复后通过。

修复后进入最终收口。

### 最终收口：Fable / Grok / Kimi GREEN，Opus timeout 无裁决，补充 OpenAI gpt-5.6-sol T0 GREEN

- Fable GREEN、Grok GREEN、Kimi GREEN。
- Opus 审查自身 timeout，无裁决——不当同意也不当反对，不构成 blocker。
- 补充 OpenAI gpt-5.6-sol T0 GREEN（cross-vendor 独立票）。

**最终有效门**：T0+ Fable + cross-vendor Grok / Kimi / OpenAI 均 GREEN，无 P0/P1；Opus timeout 不当同意也不当反对。审查确认唯一 termination claim 与诚实 cleanup 语义未被放宽。

## 隐私处理

本记录只固化审查轮次、票型、暴露问题与修复语义，不粘贴 production 审计行正文、prompt 内容或用户会话内容；canary 事实与 hash 见 evidence dossier，审计行仅按路径引用（`.pi-astack/` 为本地未跟踪目录，不纳入本文件）。
