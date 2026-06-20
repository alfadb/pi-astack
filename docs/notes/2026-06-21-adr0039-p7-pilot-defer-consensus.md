# ADR0039 P7 低频域 pilot — 2 轮 4×T0 共识：GATED-DEFER（2026-06-21）

> 2 轮 4×T0 跨厂复审（opus-4-8 / gpt-5.5 / deepseek-v4-pro / kimi-k2.7-code；主会话主持不投票）。
> **R1 分裂 3-1**（3 proceed-identity-writer-only vs 1 defer），**R2 收敛 4/4 SIGN DEFER-with-gate**
> ——3 家撤回 proceed，承认零用量空洞。这是 continuation 指向的 P7（真正未起步项），
> 与之前重复索要的 P4-a/P5/L2/Knowledge/L3 不同；结论是**有据地 defer**，非默认跳过。

## 决定（4/4）

**DEFER P7 实现**（不为空且无用量的域建 writer/projector/shadow-view）。**预选 pilot 域 = identity**
（identityKey 最干净：world-scoped、slug-based、与 knowledgeIdentityKey 同型）——**待 gate 触发时**执行。

### 为什么 defer（R2 收敛论据）

- **零用量空洞**（决定性，推翻 R1 的 proceed）：P7 五个域 canonical 目录全空，**不是缺 writer，是本
  实例没有任何低频域真实用量**——identity `/about-me` 通道存在但从未产出；全站唯一 P7 数据是
  project-memory 4 条静态 decision（1 个项目）。故 flag-off identity evidence-writer 会**累计 0 事件**
  ——「先建 writer 启动真实证据时钟」失效（没有可计的时钟）。
- **identity = 活的反模式**（kimi，opus 承认 under-weighted）：Lane G `writeAbrainAboutMe` 是 ADR0039
  §3/§4 要消除的 raw→canonical 写时直写。在它旁边并行 evidence-writer **不迁移它**（canonical 写路
  不动）= 重复非迁移；甚至会让反模式「看起来已处理」而固化。
- **迁移 pattern 已两次证明**（Constraint P1–P5 + Knowledge P6）——P7 不增架构知识，只增表面积。给空+
  无用量域建 writer+projector = 与 L3 §4.5（4/4 defer chunks/embeddings+graph）同形的「没人读的投机脚手架」。

### Gate（OR-of-arms，任一触发 → 以 identity 为 pilot 重开）

多臂设计，规避 anti-pattern「phase-gate 不得只等低频自然事件」（把验收变成随机等待）：

- **Arm A（substrate 真带低频载荷）**：`constraint-evidence/*`（或任何走现有写路的低频域）滚动 30 天内
  累计 **≥5 条** AND 其中 ≥1 条是 identity-shaped（about-me / skill / habit / 用户偏好）。
- **Arm B（用户摩擦，单实例即触发）**：≥1 条记录在案的、当前写路（`/about-me` slash、MEMORY-ABOUT-ME
  fence、constraint-evidence catch-all）对 identity-class 事实**塑形错误**的实例（须 turn-pointer
  session_id+turn_id 或 sediment 条目，非轶事）。
- **Arm C（replay 可行）**：磁盘上存在 ≥10 条历史 identity-shaped 事实，可经候选 writer 以
  provenance `historical_audit_backfill` 回放（满足 anti-pattern 偏好的 replay>等待）。

每臂均可由现有 artifact 机器核验（`l2/views/` 按 kind 计数、turn-pointer grep、文件 ls+条目数），
非「感觉对了」。

### 激活时的强制前置（记录，不现在做）

gate 触发、建 identity-evidence writer 时，**同一改动内**必须（deepseek R1，否则 NS-2 live-bug 类）：
- 把 `identity-evidence-envelope/v1` 加入 constraint event-scan 的 `FOREIGN_SKIP_ENVELOPE_SCHEMAS`
  （`event-scan.ts:57-59`）+ 确认 knowledge collector 的 `event_schema_version` 检查覆盖它——否则新
  envelope 被 mis-ingest → `coverageRatio` 塌缩 → compiled-view 注入静默关闭。
- 写入共享 `l1/events/sha256/`（同一 L1 SOT 轴，非 ADR0028 之外新轴）；reuse `constraint-evidence/*`
  substrate；projector 验证用真实事件 reconcile（byte-compare），**禁止 synthetic 验收**。
- writer 为 parallel-write，**不替换** Lane G、不翻读路（避免 §"禁止一次性重写全系统"）。

### 编码 = doc-only（4/4，无 code tripwire）

仅两件 artifact：(1) **roadmap P7 行改 GATED-DEFERRED**（gate arms + 预选域 + anti-reask 措辞——
doc-only 版的 L3 `meta('schema_deferred')` receipt）；(2) **本 git 共识记录**。
**不加 code tripwire**：与 L3 §4.5 不同（那有真实 sqlite db 可挂 `meta()` 行 + if-exists-empty 断言），
**P7 无任何 runtime artifact**可挂；「断言 P7 writer 不存在」正是 kimi 反对的 assert-absence 反模式
（别人正确建它时反而 fail）。substrate 决定编码形态——doc-only 是正确退化，非弱化。

## 边界

纯决策 + roadmap/note doc 改动，零代码、零 flag、Lane G 不动。pattern 已证明，P7 仅待真实信号 gate-arm。
