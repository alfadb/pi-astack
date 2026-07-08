---
doc_type: notes
status: active
---

# P4-b Fail-Closed Flip Record - 2026-07-08

## Scope

本 note 补记 P4-b fail-closed flip 的执行记录，使后续 gate、审计与回滚讨论有可引用的 repo 文档锚点。本 note 是事后记录，不追加新的 runtime 授权。

## Flip Content

已发生的 flip 内容为：`ruleInjector.compiledViewInjection.fallbackToLegacyOnError=false`。执行后 compiled-view read failure 不再回退 legacy rules。

同一轮设置曾包含 `requireFresh=true`。2026-07-08 按裁决已改回 `requireFresh=false`，stale compiled view 的处置改为注入上一版稳定 view 并显示 banner，而不是因 freshness 单项 fail-closed。

## Authorization Shape

该 flip 由 owner 直接 settings 授权完成，未走 P0L 自定的 A+ 7 日观察窗。该授权属于文档外授权；本 note 补记其发生事实、边界与当前实测，以维护 gate 体系后续可引用性。

P0L 的 A+ gate 仍保留为未来同类 flip 的建议门槛。该历史 flip 不授权 constraint legacy retirement、archive 或 delete。

## Current Measurements

2026-07-08 审计实测数据门为全绿：coverage=1.0、queued=0、legacyOnly=0。相关 append failure 数据为 0，textDelta 已经多轮 T0 复核至 2026-07-07 且全部为 semantic_equivalent。

这些数据支持当前 fail-closed compiled-view injection 继续运行，但不等同于 legacy retirement 完成。

## liveCanary Disposition

`liveCanary` 在 P0M 建成后未启用即被全局 flip 越过。本次不启用 liveCanary；settings 默认保持关闭。

`liveCanary` 保留为未来 flip 类工具，用于需要 session-scoped canary、精确 persisted session 授权与 per-session fail-closed 验证的场景。

## Boundary

本 note 不执行 settings 修改，不写生产 `~/.abrain`，不授权 legacy rules 物删，不关闭 dual-read audit。后续 constraint legacy retirement 仍需独立 gate 与独立授权。