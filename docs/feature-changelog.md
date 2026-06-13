---
doc_type: consensus
status: active
---

# Feature / Requirement Change Log

> **功能/需求级**变更记录——不是代码变更/commit 流水。人类拥有，agent 代起草，人类签字。
> 规则：每条至少回答"什么需求/功能方向/人类级约束/验收/非目标变了"。只回答"什么代码变了"的不进这里（那是 git / abrain 技术记忆）。
> 状态：`proposed` / `accepted` / `rejected` / `superseded`。

---

## 2026-06-13 — proposed — spun-out keystone：ADR 0034 abrain mechanism-ingest + rationale 渲染

### 变更
新增 [ADR 0034](adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md)（Proposed）：定义 sediment 侧三能力——source-aware ingest lane（把 ADR 机制分解为 typed entry 入 abrain）、`direction_impact` 结构注解（触碰 INV/REQ → 升级，不静默）、rationale 渲染（缺失必报缺失不幻觉）。

### 原因
Phase-2 把 23 份 ADR 方向上提、机制 mark-in-place，但主会话不能写 abrain（ADR 0003）；机制物理迁入 abrain + `README.md` §4 按需渲染 rationale 承重墙都 block 在这个能力上。它是 Phase-2 的 keystone。

### 需求影响
Phase-2 “整体完成”不早于 0034 落地 + 渲染验证；在此前承重墙靠 ADR 机制 in-place 可读兜底。

### 非目标
未实现；不含 memory schema 字段/sediment pipeline/渲染 prompt 的具体实现（→ 代码 + abrain）。

### 关联
handoff 契约源于跨厂商 T0（Kimi 主笔），记于 `notes/phase2-adr-split-plan.md` §3。

---

## 2026-06-13 — accepted — Phase 2 抽取：方向不变量/需求上升为共识层一等公民

### 变更
从 ADR 机制正文中抽出方向承载条目，上升为 `direction.md`/`requirements.md` 一等公民（加法，未删任何 ADR）：
- `direction.md` 新增 5 条不变量：INV-DUAL-INVARIANT / INV-USER-NOT-WORKER（ADR 0027 C1'/C4'）、INV-TELL-NOT-ASK / INV-COST-NOT-A-GATE / INV-GIT-IS-RECOVERY（ADR 0033）；AI-Native 补认知/infra 分层边界（C3'）；走偏信号 +#8（能力面确认弹窗复活）。
- `requirements.md` 新增 REQ-007（项目身份绑定严格，ADR 0017）、REQ-008（prompt_user/vault_release 语义边界分离，ADR 0022）。
- 第二批：`direction.md` +INV-SYNC-DETERMINISTIC-MERGE（同步只走确定性合并，0020）、INV-GROUND-TRUTH-TIERED 增 provenance 门控（0028 R2'）；`requirements.md` +REQ-009（记忆 accuracy-contract，0015）、REQ-004 增召回审计/非对称阈值（0028 R3'）；0013 trust×blast 确认已在 direction §1（信任×影响半径）不重复。

### 原因
这些是跨实现不变的方向/契约（承重墙），之前埋在 ADR 机制正文里，人类不易随时比对/否决。Phase 2 把它们提到单一可读面。

### 历史方向事件（补记）
ADR 0026 §3.1 walk-back：第二大脑参与从"决策点/执行二分"改为"检索参与"（默认 Path A walk-back）——这是一次方向修正，机制归 abrain/代码。

### 非目标
不是代码变更日志；ABR 机制正文本轮未动（待后续 slim/archive）。

### 关联
决策点 #1（4×T0 收敛）见 `notes/phase2-adr-split-plan.md`；下一批抽取：0028/0020/0013/0015。

---

## 2026-06-13 — accepted — 文档体系重构为"人类↔abrain 共识基础"两库模型

### 变更
项目文档（docs/）重定义为**人类与 abrain 的共识基础**，只装：愿景 / 目标 / 需求 / 方向（不变量+取舍+走偏信号）/ 功能变更。**技术大方向由人类把控（→ docs）；技术细节与实现由 abrain 决定（→ abrain + 代码）。** 引入 `REQ-001..006`（见 `requirements.md`）。

### 原因
abrain 内部人类可读性极差；凡需人类共识/审计/否决的东西不能只活在 abrain。用 prose 文档镜像代码事实会必然漂移（已观测 README/current-state/实际 三处扩展计数不一致）。

### 需求影响
新增 `REQ-001..006`；agent 任务开始须读 `vision`/`direction`/`requirements` 为不可违反方向，再查 abrain 技术知识，再读代码为当前真相（见 `README.md` §5）。

### 非目标
本条不是代码变更日志；不列 commit、改了哪些文件、重构步骤。

### 关联
经 3 轮跨厂商 T0 讨论收敛（证据见 git history / 后续 `docs/audits/`）；落地骨架见 `README.md`、`direction.md`。Phase 2（ADR 劈分 / current-state 收敛 / abrain 能力）见 `roadmap.md`。
