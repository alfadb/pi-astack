---
doc_type: notes
status: active
---

# Second Brain P0M Session Live Canary - 2026-07-06

## Scope

本 note 记录 ADR0039/P0M 实现 session-scoped live canary 接线的 repo 文档状态。

当前范围是：为 `ruleInjector.compiledViewInjection.liveCanary` 增加默认关闭的 per-session canary 机制，使未来在用户显式授权具体 persisted session id 后，可以对匹配 session 执行真实 compiled view 注入与 fail-closed 行为。

## Current Runtime Remains

当前生产运行时仍保持全局 compiled-primary + legacy fallback。

真实 `/home/worker/.pi/agent/pi-astack-settings.json` 仍为：

- `ruleInjector.compiledViewInjection.fallbackToLegacyOnError=true`
- `ruleInjector.compiledViewInjection.liveCanary.enabled` 未启用

因此当前没有生产 live canary activation。非 canary 路径仍按既有 compiled-primary + legacy fallback envelope 运行。

## What Changed

- `compiledViewInjection.liveCanary` 默认关闭。
- 当 `liveCanary.enabled=true`，且 persisted session id 精确匹配 `liveCanary.sessionIds` 时，当前 session 的 effective settings 会强制为 `enabled=true` 且 `fallbackToLegacyOnError=false`。
- 对 matching session，compiled view 成功时真实注入 compiled view。
- 对 matching session，compiled read、coverage、freshness、schema 或 size failure 时真实 fail-closed，不回退 legacy。
- 非匹配 session、disabled canary session、ephemeral session 保持 legacy fallback。
- Canary active 时，会写入 `session-live-canary` audit row 到 `${abrainHome}/.state/sediment/constraint-shadow/session-live-canary/audit.jsonl`。
- 该 audit row 只记录 metadata，不写 rule body。

## Verification

已完成以下验证：

- `npm run smoke:abrain-rule-injector` 通过，16 assertions all ok。
- `git diff --check` 通过。
- 真实 settings 检查确认 `fallbackToLegacyOnError` 仍为 `true`。

## Non-Actions

本阶段明确未执行：

- No production fresh audit。
- No production `~/.abrain` write。
- No global fallback flip。
- No legacy retirement, archive, or delete。
- No evidence write。

## Next Step

P0N 如需进入真实生产 canary，需要用户显式授权一个具体 persisted sessionId 加到 `liveCanary.sessionIds`，并启用 `liveCanary`。

该步骤将导致真实生产 canary 写入，必须单独授权。全局 `fallbackToLegacyOnError=false` 仍需后续 gate。
