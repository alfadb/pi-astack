---
doc_type: notes
status: active
---

# Second Brain P0L Fallback False Gate Proposal - 2026-07-06

## Scope

本 note 仅记录 ADR0039/P0L 关于 `fallbackToLegacyOnError=false` gate proposal 的 T0 共识。它是 repo 文档与提案记录，不是运行时授权。

当前讨论范围是：在未来另行授权的前提下，定义从 compiled-primary with legacy fallback 进入 fail-closed compiled-primary 的最低 A+ gate、回滚条件、后续授权要求，以及 legacy retirement 与 fallback=false 的边界。

## Status Update

本 proposal 的“当前运行时”段落是撰写时状态。后续已发生设置变更：`ruleInjector.compiledViewInjection.fallbackToLegacyOnError=false`，当前为 fail-closed compiled-view injection；legacy rules read failure fallback 不再是当前包络。

该后续变更不授权 legacy retirement/archive/delete。legacy retirement 仍是独立 gate，不能由 fallback=false 间接执行。

## Out of Scope

本 note 不授权：

- Settings edit。
- Fresh audit。
- Production `~/.abrain` write。
- Runtime flip。
- `fallbackToLegacyOnError` change。
- Legacy retirement, archive, or delete。
- Evidence write。

## Current Runtime Envelope

撰写当时的运行时包络是 compiled-primary with legacy fallback。compiled-view runtime injection 已启用，但 compiled read 失败时仍回退 legacy rule injection。

当时 `/home/worker/.pi/agent/pi-astack-settings.json` 字段值为：

- `ruleInjector.compiledViewInjection.enabled=true`
- `ruleInjector.compiledViewInjection.fallbackToLegacyOnError` value was `true`
- `ruleInjector.compiledViewInjection.requireFresh=true`
- `ruleInjector.compiledViewInjection.staleAfterMs=86400000`
- `ruleInjector.compiledViewInjection.maxReadBytes=1000000`
- `ruleInjector.compiledViewInjection.minCoverageRatio=1`

## T0 Rounds Summary

- Round1: 审查焦点集中在是否可以从当前 P0K acceptable continue operation 直接进入 fallback=false。结论是不可以；需要独立 gate、持续观测窗口、canary/fail-closed dry run、回滚定义和显式 settings 授权。
- Round2: 审查共识收敛到 proposal-only。`fallbackToLegacyOnError=false` 可以作为未来目标状态设计，但当前不得 flip，不得把 convergence acceptance 误读为 runtime flip authorization。
- Round3: 审查确认 A+ gate 必须比单次 fresh comparable row 更严格，至少覆盖连续日历窗口、相同 frozen `inputRootHash`、session_start comparable observations、drop count 和运行时不变量。
- Round4: 最终 T0 共识为 5/5 `ACCEPT A+`，仅接受 gate proposal 作为文档与未来授权依据，不接受立即 settings 修改、fresh audit、fallback flip 或 legacy retirement。

## Final Decision

最终决策：`proposal_only_no_flip`。

本 note 不授权 `fallbackToLegacyOnError` 从 `true` 到 `false` 的变更。任何未来执行都必须经过单独 T0 runtime pass 和显式用户 JSON settings 授权。

## A+ Gate

在任何 `fallbackToLegacyOnError=false` 之前，以下条件必须同时存在并通过：

- 必须存在并通过 `failClosedDryRun` 或 per-session canary mechanism。
- 必须覆盖连续 7 个日历日。
- 必须在同一个 frozen `inputRootHash` 上产生至少 7 条 fresh comparable shadow rows。
- 必须产生至少 20 条 `session_start` comparable observations。
- Drop count 必须为 0。
- Clean invariants 必须全部满足：`stale=false`、`injectableCoverageRatio=1`、`queued=0`、`appendFailed=0`、`inconsistentDiagnostics=0`、`mismatchedOutcomes=0`、无 `unmapped` / `conflicts` / `unresolved`，`staleEvents` 仅允许 `merged_source` / `deferred`，且没有新的 undispositioned `legacyOnly` / `textDelta` / `compiledOnly`。
- 任意 regression 都会重置整个观察窗口。

## Legacy Boundary

`legacyOnly=6` 只阻塞 legacy retirement、archive 或 delete。它们作为已 dispositioned 的 `settings_not_memory` 条目，不单独阻塞 `fallbackToLegacyOnError=false` gate。

该边界不改变 legacy retirement 的授权要求。legacy retirement 是独立 gate，不能由 fallback=false proposal 间接授权。

## Illustrative Future JSON

以下 JSON 仅为未来如另行授权时的说明性形态，不是当前授权，不得现在应用：

```json
{
  "ruleInjector": {
    "compiledViewInjection": {
      "enabled": true,
      "fallbackToLegacyOnError": false,
      "requireFresh": true,
      "staleAfterMs": 86400000,
      "maxReadBytes": 1000000,
      "minCoverageRatio": 1
    }
  }
}
```

该说明性 JSON 只表达 `fallbackToLegacyOnError` 从 `true` 变为 `false`。其他 guard 保持当前值：`enabled=true`、`requireFresh=true`、`staleAfterMs=86400000`、`maxReadBytes=1000000`、`minCoverageRatio=1`。

## Rollback Conditions

任一条件出现时必须回滚，并将 `fallbackToLegacyOnError` 恢复为 `true`：

- Compiled read failure。
- Coverage、freshness、schema 或 size error。
- Undefined injection 或 no-rule injection。
- Canary/drop 大于 0。
- `queued` 或 `appendFailed` 非 0。
- `inconsistentDiagnostics` 非 0。
- `mismatchedOutcomes` 非 0。
- 出现新的 undispositioned deltas。
- Session prompt 缺失 compiled injection。

## Required Future Authorization

未来若要执行 fallback=false，必须先完成单独 T0 runtime pass，并取得显式用户 JSON settings 授权。该授权必须明确允许修改 `/home/worker/.pi/agent/pi-astack-settings.json` 中的 `ruleInjector.compiledViewInjection.fallbackToLegacyOnError`。

Legacy retirement、archive 或 delete 仍是独立 gate，需要独立审查和独立授权。

## Verification / Non-Actions

本 note 创建过程中仅写入 repo 文档。

已明确未执行：

- No settings edit。
- No fresh audit。
- No production `~/.abrain` write。
- No fallback flip。
- No legacy retirement, archive, or delete。
- No evidence write。

## Next Step

除非用户后续明确授权单独 T0 runtime pass 与 JSON settings 修改，否则当时要求保持 compiled-primary with legacy fallback 运行时包络。