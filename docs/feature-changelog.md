---
doc_type: consensus
status: active
---

# Feature / Requirement Change Log

> **功能/需求级**变更记录——不是代码变更/commit 流水。人类拥有，agent 代起草，人类签字。
> 规则：每条至少回答"什么需求/功能方向/人类级约束/验收/非目标变了"。只回答"什么代码变了"的不进这里（那是 git / abrain 技术记忆）。
> 状态：`proposed` / `accepted` / `rejected` / `superseded`。

---

## 2026-06-14 — accepted — memory_search 检索栈重构：embedding 候选 + 两阶段塌缩 + profile registry（ADR 0035/0036/0037）

### 变更
`memory_search` 的检索行为分三步演进（均已 Accepted、相关 flag 已转产）：
- **ADR 0035**：stage1 候选面从「全库 full-body 海选」改为 embedding 向量召回 + 小候选集，检索成本从 O(库×频率) 降为 O(N)；supersede ADR 0015 的候选面决策，保留其双阶段框架 + result-cache 禁令 + freshness 契约。
- **ADR 0036**：删除 stage1 LLM 环节（两阶段塌缩 `stage0 hybrid → top-K → stage2 精排`），并复活 BM25 sparse + 多向量补 dense 盲区；`stage1Skip` / `sparseBM25` / `multiVector` 已转产。
- **ADR 0037**：把分散在 5 个调用方手搓的检索 policy 收口为 typed `SearchProfile` registry + 单入口，消除「per-caller policy 漂移 / 全局 flag 泄漏到去重路径」一类事故。

### 原因
原 stage1 用 full-body LLM 从候选里再选一遍，是在重做 dense 向量已经做得更好的排序，单次约 324K token 且 path-A / sediment 高频调用，是成本主体；策略分散又导致 false-merge corpus corruption 类事故。

### 需求影响
无新增 REQ；守住既有记忆 accuracy/recall 契约——stage0 转产硬门要求 21 query 强 baseline coverage ≥95%（final 实测 98.1%），未达标不转产。检索更快/更省属用户可感知行为变化，故按 `README.md` §5「用户可见行为变化」升级触发器记入本表。

### 非目标
不是代码变更日志；具体 phase 流水、参数收敛（poolLimit/maxCand/sparse 权重）、oracle 度量、向量索引格式等为实现细节，归 `roadmap.md`「ADR 0035」段 + abrain + git。

### 关联
[ADR 0035](adr/0035-memory-stage1-embedding-candidate-retrieval.md) / [ADR 0036](adr/0036-memory-search-two-stage-collapse-and-hybrid-retrieval.md) / [ADR 0037](adr/0037-memory-search-facade-profile-registry.md)；实施 phase 详 `roadmap.md`。这三份机制 ADR 的 slim + ingest 尚待执行（见 `roadmap.md` 残留缺口）。

---

## 2026-06-13 — accepted — ADR 0034 Phase-4 完成：全 19 机制 ADR 迁入 abrain，Phase-2 整体完成

### 变更
ADR 0034 mechanism-ingest lane 落地并跑完生产迁移：**全 19 份机制 ADR 处置完毕**——12 SLIM（0026/0001/0003/0009/0013/0016/0032/0017/0020/0028/0022/0023）+ 5 机制存档归档（0010/0015/0018/0021/0025）经 ingest lane 分解为 **256 条 typed entry** 写入 `~/.abrain/projects/pi-global/`（911→1167），ADR 物理瘦身为方向残桩；2 份 superseded（0006/0019）按变体只标 archived 不 ingest。每条机制的 rationale 现经 `renderRationale` 按需渲染（带 pinned `source_ref` SHA），README §4「按需渲染 rationale」承重墙兑现。

### 原因
ADR 机制正文越长越没人读，且与代码必然漂移；把不可代替的 rationale（如 0018 两次数据丢失先例链、0025 conf<8 盲区）沉到第二大脑，按需检索/渲染，而非埋在 700 行 ADR 里。这让「方向（docs，人类把控）/ 机制（abrain+代码，abrain 决定）」的两库模型在存量 ADR 上真正闭环。

### 需求影响
无新增 REQ；兑现既有 README §4 渲染契约。机制 entry 全部 `provenance=content-in-transcript`（Tier-2，永不冒充 Tier-1 用户指令）；触碰方向承重墙的两处 escalation 已浮现而非静默接受（0025 narrows INV-ACTIVE-CORRECTION / conflicts INV-MAIN-SESSION-READ-ONLY+REQ-005）。

### 非目标
不是代码变更日志。全程零主会话直编 abrain markdown——写入只经 ingest lane（守 G2 + ADR 0034 §4 四不变量）。staleness re-sync 归后续 ADR。

### 关联
迁移轨迹（可复现）：`scripts/run-adr-ingest.mjs` + `scripts/verify-rationale.mjs` + `notes/adr0034-ingest/*.json`（17 份分解记录）；分批 abrain commit 链可回滚；原机制 prose 基线统一记录在 `notes/adr0034-impl-plan.md`（含 git 恢复命令）；living plan 见 `notes/adr0034-impl-plan.md`。能力实现见 `extensions/memory/{direction-impact,ingest-adr,rationale,adr-decomposer}.ts`（123 smoke assertions）。

---

## 2026-06-13 — accepted — ADR 0034 Phase 1-3 实现：direction_impact + ingest lane + rationale 渲染（能力全绿）

### 变更
ADR 0034 三块能力的代码实现落地（均为主会话可执行的代码，未写真实 ~/.abrain）：
- **Phase 1 direction_impact schema**：`extensions/memory/direction-impact.ts`（flat frontmatter pipe 编码）+ parser 填 `MemoryEntry.directionImpact`（可查）+ 读侧 lint `D1` + 写侧 validation；narrows/weakens/conflicts→escalation≠none 红线。
- **Phase 2 source-aware ingest lane**：`extensions/memory/ingest-adr.ts`（planIngest 纯函数 + dry-run/go + provenance=content-in-transcript + source_ref 存 path#heading@SHA + git reset --hard 回滚 + sanitizer 边界 + 审计；decomposer 注入可测）。
- **Phase 3 rationale 渲染**：`extensions/memory/rationale.ts`（只格式化存储数据，missing-not-hallucinated 硬约束，带 pinned SHA）。

### 原因
Phase 0 ratify 后按 impl-plan 分阶段推进；三能力是 Phase-2 物理瘦身 + 承重墙渲染的前置。

### 需求影响
acceptance ①-⑧ + ⑩ 由代码 + smoke 覆盖：smoke:direction-impact 32 + smoke:adr-ingest 40 + smoke:rationale 29 = 101 assertions（均双向 negative），smoke:memory 回归绿。全程守 ADR 0034 §4 四不变量 + G2（主会话只写代码，sandbox/dry-run，不动真实 abrain）。

### 非目标 / 剩余
Phase 4（需用户 go/no-go，G2）：CLI `/memory ingest-adr` 命令 + 生产 LLM decomposer prompt 接线 + 对真实 12 SLIM/7 ARCHIVE ADR 的 production ingest + 验证 rationale 可得后物理瘦身（acceptance ⑨）。

> **收口**：上述 Phase 4 已完成 production ingest（全 19 机制 ADR / 256 条 entry，已记为 accepted）——见本文件「ADR 0034 Phase-4 完成」条目；本条「未写真实 ~/.abrain」仅描述 Phase 1-3 阶段（纯代码 / sandbox），不再是当前状态。

---

## 2026-06-13 — accepted — ADR 0034 ratify：abrain mechanism-ingest keystone 进入实现阶段

### 变更
ADR 0034（Phase-2 keystone：abrain mechanism-ingest lane + direction_impact 注解 + rationale 渲染）经 3×T0 跨厂商盲审（opus-4-8 / gpt-5.5 / deepseek-v4-pro）**一致 RATIFY WITH REVISIONS**，Proposed → **Accepted**，9 处修订已并入。同时立实现 goal（`docs/notes/adr0034-impl-plan.md`）分 4 阶段推进。

### 原因
ADR 0034 是 Phase-2 “物理瘦身/归档 + 承重墙渲染”的唯一阻塞能力。本项目协议：未 ratify 的 ADR 不进实现；故先 T0 评审收敛再编码。

### 需求影响（收敛的修订集）
(1) §3 时序拆“保 SHA + 收方向残桩可先于 ingest” vs“物理删 in-place prose 必须在 ingest + 渲染验证之后”，acceptance ⑨ 加三步验证；(2) direction_impact 首落 = **flat frontmatter**（非嵌套/非 body-only，因 parser 跳缩进行 + 违反可查）；(3) provenance 用 AX-PROVENANCE 枚举 assistant-observed/content-in-transcript（机械确保非 Tier-1），migrated-from-mechanism-docs 降为 timeline marker；(4) 依赖收窄：ADR 0025=accepted，仅复用 sanitizer+writer 基建不依赖稳态 curator 管线；(5) dry-run manifest 加 coverage/stats；(6) git reset --hard pre-SHA 回滚；(7) ingest 禁写 rules zone / inject_mode；(8) 渲染带出 pinned SHA 使源漂移可检；(9) staleness re-sync 归后续 ADR。

### 非目标
schema 字段最终形态 / lane pipeline / 渲染 prompt 措辞为实现细节（代码 + abrain），不写进 ADR。主会话只写代码，真实写入 ~/.abrain 是 Phase 4 经 sediment lane 单独 go/no-go。

---

## 2026-06-13 — accepted — roadmap.md strip：roadmap 回归 backlog 本职（STRICT-green 收尾）

### 变更
`roadmap.md` 删掉所有 ship-status（“同步” 变更块 + 整个 ADR 0022 housekeeping batch 章 + 3 行 ADR-0022 ship-status debt，203→92 行），只留真 backlog（P0/P1 / 架构 debt / 不变量守护 / pending flips / deferred / maxim）。

### 原因
REQ-006 + 文档治理：roadmap 只装未完成/计划；ship-status 属 current-state/feature-changelog/audits/git。原 roadmap 80% 是带 commit hash 的 ship-status，违反 REQ-006。

### 需求影响
`STRICT=1 npm run docs:doctor` 达成 **GREEN（零 ERROR）**——Phase-2 doc 侧收尾。残余 advisory 均为 ADR pending-ingest 机制正文的 commit 证据（待 ADR 0034 ingest 后清）。

### 非目标
ADR 0022 的实施流水/audit 轨迹不是删除，是移出 roadmap；原文保留在 git history / `docs/audits/`。

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
