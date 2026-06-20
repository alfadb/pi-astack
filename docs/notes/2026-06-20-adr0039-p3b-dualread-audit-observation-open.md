---
doc_type: notes
status: active
---

# ADR 0039 P3b — Dual-Read Audit Observation Open

本记录覆盖 P3b dual-read runtime observation 的开关决策。范围限定为打开 `ruleInjector.dualReadAudit.enabled=true`，让 rule injector 在 `session_start` 对 legacy rules 与 shadow compiler latest artifacts 做只读对比，并把 delta 写入 `.state/sediment/constraint-shadow/session-start-dualread/audit.jsonl`。legacy `rules/{always,listed}` 仍是唯一 runtime injected truth；本阶段不切换 compiled view injection，不退休旧 adjudication，不进入 P4。

## 前置证据

Phase 1.5 已完成并推送：inner repo commit `d89c952`，outer repo commit `f044495`。证据记录见 `docs/notes/2026-06-20-adr0039-p3b-phase1.5-audit-replay-evidence.md`。

生产 audit replay 使用 `/home/worker/.abrain/.state/sediment/audit.jsonl`，隔离目录为 `/tmp/constraint-audit-replay-5xOUKI`。回放结果：`selectedRows=10`，`selectedSessions=5`，operation 分布为 `archive=1`、`create=5`、`merge=1`、`reject=2`、`update=1`，`appended=10`，`failed=0`，`validationFailures=0`，`canonicalChanged=false`。

Shadow compiler replay 证据：`coverageRatio=1`，`totalEvents=10`，`validEvents=10`，`projectedEvents=10`，`replayBackfillEvents=10`。Legacy delta summary 为 `totalEventsWithLegacyWrite=8`、`matchedOutcomes=5`、`mismatchedOutcomes=3`、`eventOnlySignals=0`。3 个 mismatch 已逐行记录，作为 runtime observation 的输入信号，不作为 compiled view injection 或 P4 的授权依据。

## 复审结论

已完成下一轮 multi-T0 只读复审，议题严格限定为是否允许打开 `ruleInjector.dualReadAudit.enabled=true` 进入 P3b dual-read runtime observation。四个独立复审者结论均为 `SIGN`，且均确认：可以打开 dual-read audit 观察开关；不授权切换 compiled view injection；不授权进入 P4。

共同理由：`dualread-audit.ts` 只读取 shadow latest artifacts 与 legacy rules，并追加写入 session-start audit JSONL；`index.ts` 的 runtime 注入仍由 legacy `composeRuleInjection(cachedRules)` 产生，dual-read audit 返回值不参与 prompt 注入。异常状态会被记录为 `shadow_unavailable`、`shadow_invalid` 或 `audit_write_failed`，不改变 legacy injection。

## 开关变更

在 `/home/worker/.pi/agent/pi-astack-settings.json` 中打开：

`ruleInjector.dualReadAudit.enabled=true`

同时显式写入运行参数，避免依赖代码默认值作为可回滚开关：

`ruleInjector.dualReadAudit.maxReadBytes=1000000`

`ruleInjector.dualReadAudit.staleAfterMs=86400000`

`sediment.constraintEvidenceEventWriter.enabled=true` 保持不变。

## 最小观察条件

观察窗口内至少收集真实 main-session 的 `session-start-dualread/audit.jsonl` 行；sub-agent session 不作为计数基础。每行应检查 `status`、`shadowAgeMs`、`stale`、`summary`、`eventCoverage` 与 delta 明细。若生产 shadow latest 暂不可用，预期状态为 `shadow_unavailable`，这表示观察信号不足，不表示 legacy injection 失败。

观察期间保持 legacy rules 为唯一注入来源。不得把 dual-read delta 作为自动迁移、自动删除、compiled-view injection 或 P4 的授权依据。

## 停止条件

任一条件触发时应将 `ruleInjector.dualReadAudit.enabled` 改回 `false`：连续出现 `audit_write_failed`；重复出现 `shadow_invalid`；`session_start` 出现可归因于 dual-read 同步读写的延迟或错误；观察到 dual-read result 被用于改变 prompt injection；`audit.jsonl` 写入路径越过 `.state/sediment/constraint-shadow/session-start-dualread/`；或生产 canonical `rules/`、`knowledge/`、`projects/` 被该路径修改。

本阶段到期或证据足够后，需要基于 live dual-read audit 数据再做独立复审，才能决定是否进入 P3b 后续步骤。P3 compiled-view injection 与 P4 继续保持关闭。
