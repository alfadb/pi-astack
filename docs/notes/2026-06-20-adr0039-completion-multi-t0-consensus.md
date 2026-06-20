# ADR0039 完成路线：多 T0 一致共识记录（2026-06-20）

> 本文是 `second-brain-memory-multi-t0-consensus-refactoring-protocol` 要求的共识审计记录。
> 主会话只主持，不投决定票。参与 T0：anthropic/claude-opus-4-8、openai/gpt-5.5、
> deepseek/deepseek-v4-pro、moonshotai/kimi-k2.7-code（4 厂商跨架构）。
> 结论：4/4 AGREE。

## 背景

ADR0039 已 4×T0 ratify（设计是定的）。当前实现是可运行过渡态。四家独立实读代码后
确认根因：Knowledge/Constraint 的「L2」写在 `~/.abrain/.state/sediment/*/latest`，
被 `.abrain/.gitignore` 的 `.state/` 忽略，导致：

- L2 不进 git（违反 §4.1「L2 随 git 同步」）。
- canonical 仍是旧 markdown 直写（违反 §3「canonical = Evidence Event 的物化投影」）。
- dirty-view 阻断在生产对真实 L2 是空操作（违反 §4.4）。
- 投影是单事件→单文件，无 causal DAG 拓扑（违反 §4.3）。
- L3 无 `event_edges` 表（违反 §4.5）。

## 一致的批次 DAG（unanimous）

```
B0 覆盖率硬门(报告态)：证明每条 legacy canonical 都有对应 L1 event；
   现状几乎全 0（旧条目早于 event writer）→ 需 legacy_import backfill 才能反转
 │
 ├─ B1 L2 迁出 .state → 新顶层 l2/ 命名空间（不复用旧 markdown 目录），仍 shadow
 │   └─ B2 确定性拓扑投影（事件集合→单 entry，Kahn 拓扑 + tie-break
 │      created_at_utc/device_id/device_event_seq/event_id；input_event_set_hash
 │      = Merkle/JCS(sorted event_ids)）+ L3 event_edges。【必须在反转前】
 │      单事件退化必须与现投影逐字节一致（acceptance gate）
 │      └─ B3 L2 入 git（gitignore 白名单），reconcile=warn
 │         ├─ B4 pre-push dirty-L2 硬阻断 + 逃生舱（--no-verify / PI_SKIP + diagnostic）
 │         └─ 【真相面反转：先 Constraint 还是先 Knowledge —— 非一致，推迟二轮共识】
 └─（贯穿）legacy 直写 dual-write 全程保活，直到对应反转 soak 通过
```

## 三条硬边界（unanimous，任一违反立即停批回滚）

1. **L1 不可变、永不反向写**。纠错/撤回/遗忘只能 append 新 L1 event；禁止从 L2 手改、
   L3 索引、git history 反推或回写 L1。
2. **legacy markdown 树（`knowledge/`、`projects/<id>/`、`.pensieve/`）在反转验证前
   不删、不移、不停读**，仅 `legacy_import` backfill 可触碰；物删 deferred 到反转 soak
   ≥2 周无 missing-entry 报障后另议。
3. **任何索引永不成真相源**：L1 唯一 SOT，L2 唯一 git 同步派生视图，二者皆可重建；
   event_edges/拓扑必须能从 L1 的 causal_parents 重建。配套：本纪元内不物删 legacy/archived。

## 各家锐化（采纳）

- opus：解耦「建确定性 git 同步投影机制（Knowledge shadow 上做）」与「首次 canonical
  反转（放 Constraint，爆炸面最小、已有 fallback 脚手架、§6 接受 stale）」。覆盖率硬门
  必须实测到 1.0 才反转；确定性渲染器 + reproject 等价校验必须早于 L2 入 git。
- gpt-5.5：canonical flip 用三态开关 `legacy | projection_with_legacy_fallback |
  projection_only`；L2 用独立 `l2/views/` 不与旧 canonical markdown 同目录替换；L3 不做
  真相协调器。
- deepseek：单事件退化等价性是 B2 的硬性 acceptance gate（snapshot 锁定）；reconcile
  阻断必须区分「合法新投影未及时更新」与「非法脏视图」；逃生舱 + runbook 必备。
- kimi：Constraint 与 Knowledge 必须分独立 flag、独立批、独立 schemaVersion，禁止一把
  切两域（§10）；先做 `legacy_import` backfill 再切读路径，否则未投影的历史 markdown
  会在切换后消失。

## 非一致点（推迟）

首次 canonical 反转先 Constraint（opus、kimi 强主张）还是先 Knowledge（gpt-5.5 主张，
deepseek 中性）。主会话不破票。**推迟到 B0–B4 机制建好、Constraint shadow 有真实
dogfood 数据后，再开二轮多 T0 共识定序。**

## 执行落点（主会话据此分批，每批 flag-guarded + 真实数据验证 + 内外层提交推送）

- 本批（第一砖）：L3 `event_edges` 表（纯追加、从 causal_parents 重建、不作真相源）。
- 后续：B1 路径迁移 → B2 拓扑投影 + 退化等价 gate → B3 入 git → B4 阻断 → 二轮共识定序 → 反转。
