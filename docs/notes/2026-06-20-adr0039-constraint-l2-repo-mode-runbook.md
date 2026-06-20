# ADR0039 Constraint L2 repo-mode enable — preflight + runbook（2026-06-20）

> Constraint L2 迁移的 **consensus + 机制** 已 ship（4×T0 一致 `0cf801a`；实现
> `22a868b` event-scan NS-2 → `9856dc2` 严格码点 → `2f14202` 固化+确定性 git L2 核心
> → `6b09369` reconcile L1↔L2 字节比对）。本文档是**剩余的唯一交付**：把
> `constraintShadowCompiler.l2OutputRoot` 从 `state` 翻到 `repo`（criterion 7，flip-class，
> 需用户重启 pi）。**不再开新一轮共识**——设计已定，重开 = relitigation。

## 这是什么级别的 flip（先定性，再定流程）

**additive / 低不可逆风险**，不是 P4-b 那种读路径行为 flip：

- repo-mode 让 `projection.ts` 把 validated decision 固化为不可变 L1
  `constraint-projection-envelope/v1` 事件 + 渲染确定性 L2 到 git 跟踪的
  `~/.abrain/l2/views/constraint/`。
- **runtime 注入不变**：`rule-injector/index.ts:505-521` 仍读 `.state` 的
  `compiled-view.md`。翻 repo-mode **不改变注入什么**，只是额外产出 git L2 shadow。
- 可逆：翻回 `state` 即停止写 L2。唯一 append-only 的是固化的 L1 projection 事件
  （content-addressed、幂等、被 event-scan 经 NS-2 foreign-skip 跳过），留着无害。

所以这个 flip 的 gate 只有「settings 在 boot 读 → 需重启」+「翻后 reconcile 字节比对」，
**不需要多周行为 soak**（区别于 P4-b 读兜底退役）。

## 翻前 preflight（全部只读，主会话可跑）

1. **确定性**：`npm run smoke:constraint-shadow-compiler`（40 assertions，含 render
   两次 byte-equal + 真实 ~/.abrain 重投影 Σ✓）。必须 PASS。
2. **reconcile 干净**：`npm run smoke:adr0039-reconcile`。当前 state-mode 下
   `constraint_l2_present:false` 是预期（L2 尚未生成）；关注 `l1` 计数 +
   `knowledge coverage=1.0` 无 regression。
3. **~/.abrain git 干净**：`git -C ~/.abrain status --porcelain` 应为空（翻后才能干净
   归因新增的 L2 view + L1 projection 事件）。
4. **latest decision 有效**：`~/.abrain/.state/sediment/constraint-shadow/latest/decision.json`
   存在且能被 `validateConstraintCompilerDecision` 接受（smoke 的真实数据检查已覆盖
   `createConstraintDiffReport(realNorm.records, realDecision)` 成功）。

任一 preflight 红 → 不翻。

## 翻 repo-mode（需用户操作）

1. 编辑 `/home/worker/.pi/agent/pi-astack-settings.json`：
   `constraintShadowCompiler.l2OutputRoot: "state"` → `"repo"`。
   （schema 已允许，见 `pi-astack-settings.schema.json:315`。）
2. **重启 pi**（settings 在 boot 读；不重启不生效）。
3. 触发一次 constraint compile（正常 `agent_end` 自动刷新，或显式 refresh 入口）。

## 翻后验收（真实数据，别自己说了算）

1. **新增物**：`~/.abrain/l2/views/constraint/` 出现确定性 L2 view；
   `~/.abrain/l1/events/sha256/` 出现新的 `constraint-projection-envelope/v1` 事件。
2. **字节 reconcile**：`npm run smoke:adr0039-reconcile` → `validateConstraintL2`
   PASS（L1 固化事件 re-render === L2 bytes；mismatch 无新固化事件 = 脏手改，必须红）。
3. **git diff 归因**：`git -C ~/.abrain status` 只应显示新 L2 view + 新 L1 projection
   事件，**无其它域污染**（NS-2 已保证 knowledge event-scan 不会把 projection 事件
   误吞——翻前已修的 live 隐患）。
4. **注入未变**：确认 `compiled-view.md` 注入内容与翻前一致（repo-mode 不改注入）。
5. 提交 `~/.abrain` git：L2 view + projection 事件入库。

## 回滚

- 设回 `l2OutputRoot: "state"` + 重启 → 停止写 L2。
- 已固化的 L1 projection 事件不删（immutable / content-addressed / 幂等 / 被 event-scan
  跳过），留着无副作用；若确需清理，单独评估（属 git 撤不掉的 ~/.abrain 物理状态）。
- 已入库的 L2 view 如不想要：`git -C ~/.abrain rm -r l2/views/constraint/` 并 commit。

## 为什么不在主会话强翻

settings 在 boot 读 → 必须用户重启 pi 才生效；主会话改了 settings 也不会在本进程生效，
且翻后验收依赖真实重启后的 compile 产物。故主会话只交付 preflight+runbook，flip 由用户执行。
