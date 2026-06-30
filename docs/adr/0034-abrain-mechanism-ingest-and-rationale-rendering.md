---
doc_type: adr
status: accepted
---

# ADR 0034 - abrain mechanism-ingest + direction-impact 注解 + rationale 渲染(spun-out keystone)

- **状态**：Accepted（2026-06-13；3×T0 跨厂商盲审（opus-4-8 / gpt-5.5 / deepseek-v4-pro）一致 RATIFY WITH REVISIONS，下述修订集已并入）。
- **依赖**：[ADR 0003](0003-main-session-read-only.md)（主会话只读 / sediment 单写）、[ADR 0024](0024-second-brain-from-natural-conversation.md)（四 invariant + AI-Native）、[ADR 0025](0025-sediment-meta-curator-subsystem.md)（status: accepted；**本 ADR 仅复用其 sanitizer + writer 基建，不依赖其稳态 curator 管线**）、[ADR 0028](0028-sediment-ground-truth-tiered-rearchitecture.md)（ground-truth 分层 + AX-PROVENANCE 门控）；[`docs/README.md`](../README.md)(两库章程 §4 承重墙 / §5 升级 / §7 迁移)、[`docs/direction.md`](../direction.md)、[`docs/requirements.md`](../requirements.md)。
- **触发**:文档体系 Phase-2 把 23 份 ADR 的方向上提到共识层(direction.md / requirements.md),机制正文按 3×T0 裁决 **mark-in-place(pending sediment→abrain)**,物理瘦身/归档**未做**。两件事因此 block 在一个尚不存在的能力上:(a) 把 ADR 机制变成 abrain 可检索记忆(才能物理移走 prose 而不丢 rationale);(b) `README.md` §4 的"按需渲染 rationale"承重墙(人类问"为何这样设计",abrain 渲成人话供审计)。主会话**不能写 abrain**(ADR 0003),故必须独立立项给 sediment 侧。
- **对偶**:本 ADR 是 Phase-2 的 keystone--doc 侧 split 已完成并产出稳定源集,本 ADR 定义消费它的 abrain 侧能力。
- **实现状态**:核心能力已落地：source-aware ADR mechanism ingest lane 见 `extensions/memory/ingest-adr.ts`; `direction_impact` flat frontmatter 解析与红线校验见 `extensions/memory/direction-impact.ts`; rationale rendering path 见 `extensions/memory/rationale.ts`。源 ADR@SHA 漂移后的 re-ingest / delta-update 仍按 §7 留作后续。

---

## 1. 问题:三块缺口

Phase-2 后,ADR 机制正文带 `🗄️ pending sediment→abrain` 标记原地保留可读。要把它们真正迁入 abrain 并支撑承重墙,缺三样能力(主会话均不可执行):

1. **source-aware ingest lane**--现有 `/memory migrate` 只迁 legacy `.pensieve/`;Lane A 显式 `MEMORY:` 是对话转录驱动、非源文件批量;都不适合"按清单把 ADR 机制分解入库"。
2. **`direction_impact` 注解**--`README.md` §4/§5 要求 abrain 细节决定触碰方向时**升级**,但 memory entry schema 当前**没有**记录"触碰了哪条 INV/REQ + 关系 + 升级状态"的结构字段,升级义务停留在散文规范、不可查询。
3. **rationale 渲染路径**--承重墙要求人类能问"为何这样设计 / 被拒方案 / 证据 / 置信缺口",abrain 渲成人话。当前只能 `memory_search`+`memory_get` 手工拼,**不可靠到能被 docs 依赖**,且没有"渲染缺失 → 显式报缺失而非幻觉"的约束。

## 2. 决策:定义三能力(sediment 侧,非主会话工具)

### 2.1 source-aware ingest lane

一条 sediment 维护 lane(**不是**主会话写工具)。给定源 ADR 清单 + 章节级 split 标记,把机制**分解为多条短 typed entry**--一份 ADR ≠ 一条 entry,而是按语义拆成 `decision` / `pattern` / `anti-pattern` / `fact` / `smell` / `maxim`,每条带：一句 compiled truth、scope、status、confidence、`derives_from = 源路径#标题@SHA`、timeline 注“自机制 docs 迁入”。先 `--dry-run` 出 manifest，确认后 `--go`；走 strict active binding（不靠 `--project` 透传）。

**manifest 可观测（infra 层，非机械阈值门）**：dry-run 报告需含每-ADR 统计（entry 数 / body 长分布）+ **coverage**（决策 LLM self-report 哪些机制段 processed / 哪些 skipped + 原因），同时暴露过分解（走偏 #1 整篇 dump）与欠分解（partial-drop）。允许人看统计拍板，**不加“每 ADR ≥N 条才允写”类机械门**（AI-Native，direction §4 走偏 #6）。

**回滚（镜像 migrate-go）**：`--go` 写单个 atomic git commit，记录 `abrainPreSha`；坏分解的恢复路径是 abrain repo 上 `git reset --hard <abrainPreSha>`。

**边界**：ingest **永不写 rules zone / `inject_mode`**（否则 doc-dump entry 可能进入 injection→outcome ground-truth 环，ADR 0028 §7）；只写 project/world 知识 kind。

### 2.2 `direction_impact` 注解

**首落点 = flat frontmatter 编码（可查，满足 acceptance ⑥）**，非 body-only（body 不可查会违反 ⑥）、非嵌套 map（`parser.ts:254` 跳过缩进行，嵌套不可解析）。结构：触碰的 `ref`（`direction.md#INV-*` / `requirements.md#REQ-*`）+ `relation ∈ {supports, depends_on, touches, narrows, weakens, conflicts}` + `escalation ∈ {none, required, proposed, accepted, rejected}` + `proposal_ref`，以 flat 标量/列表编码（骑现有 list parser，`direction_impact` 非 `writer.ts` PROTECTED_FRONTMATTER_KEYS 故透传）。任何 `narrows`/`weakens`/`conflicts` **必须** `escalation=required` 并产出人类可读提案，**不得静默接受**（`doctor.ts` lint 红线；proposal 正文可入 body）——承重墙返回路径的结构化落点。

### 2.3 rationale 渲染路径

按 query 或 slug 渲染审计用 rationale：短答 / 为何如此设计 / 被拒方案 / direction_impact / 证据（memory slug + 源 ADR#标题@SHA + 代码符号）/ 置信与缺口。渲染**必须显式带出 `derives_from` 的 pinned SHA**，使源 ADR 后续漂移（prose 改到新 SHA）对人类可检。**硬约束**：记忆缺失时输出“abrain 无此 rationale；仅 git/docs/代码证据”，**绝不幻觉**。它**不替人类决定方向**,只分类影响 + 在需要时提示升级。

## 3. handoff 契约

- **inputs**:strict active binding(pi-astack);Phase-2 产出的源 ADR 清单 + 方向/机制 split 标记 + 源 git SHA;current direction.md / requirements.md / README 章程。
- **outputs**:`~/.abrain/projects/<id>/` 下分解后的 typed entry(带 provenance + timeline);`direction_impact` 注解;sediment 审计;ingest 报告(created/updated/skipped/coverage);rationale 渲染路径;direction-audit 模式。
- **acceptance**:1无主会话直写;2有 dry-run;3每条 entry 有 `derives_from` provenance;4ADR 被分解(无整篇 dump);5kind/status 合法(ADR 0028 / memory schema);6direction_impact 可查;7escalation 被浮现而非静默接受;⑧渲染缺失显式报缺失；⑨archive-safe（物理移走 in-place 机制 prose **前必须验证**：(a) 源处于已提交 git 态且 `git show <SHA>:<path>` 可取回 prose、(b) abrain 渲染该 rationale 成功、(c) 移走是 working-tree 删除不改写 git history）；⑩secret 边界保留(走 sediment sanitizer,raw secret 不进 entry/audit/prompt)。
- **依赖**:doc 侧 split 已完成(稳定源集 + 标记 + SHA),但**不要求 docs 继续承载机制 prose**。
- **时序**：**收方向残桩 + 保留源 SHA** 可先于 ingest（源路径/SHA 记录进 archive manifest，且源处于已提交 git 态）；但**物理删除 in-place 可读机制 prose 必须在 ingest + 渲染验证之后**（acceptance ⑨）——迁移期 §5 的 in-place 兜底依赖 prose 仍在 working tree，prose 仅存于 git history SHA 不满足 ⑨。Phase-2 **“整体完成”不可早于** ingest + 渲染验证。

## 4. 关键不变量(本能力必须守)

- **INV-MAIN-SESSION-READ-ONLY**:所有 durable 写经 sediment lane,不给主会话开 ingest 写工具。
- **AI-Native(ADR 0024 §3 / ADR 0027 C3')**:分解、direction_impact 分类、rationale 渲染都是**认知层**,主路径走 prompt(不加"准确率阈值阻断写入"类机械门);manifest/provenance/审计/schema 是 infra 层,走 structured 正当。
- **provenance 门控（ADR 0028 §12 AX-PROVENANCE）**：ADR 机制取 `PROVENANCE_CLASSES` 的 `assistant-observed` / `content-in-transcript`（**不是** `user-expressed`）。Tier-1 计算式 `user-expressed ∧ is_directive ∧ durable` 因此**机械排除** ingest entry → 一律 **Tier-2**（curator 可 skip/contest），永不冒充 Tier-1 用户指令。`migrated-from-mechanism-docs` 仅作 timeline/source marker，**非** provenance 枚举值。
- **secret 边界**:ingest 复用 sediment sanitizer;sub-pi 不作 writer(`PI_ABRAIN_DISABLED=1`)。

## 5. 设计张力与取舍

- **一次性迁移 ingest vs INV-IMPLICIT-GROUND-TRUTH**:第二大脑哲学是"从自然信号学,不吃 bulk doc-dump"。本 ADR 是**显式人类发起的一次性迁移**，非稳态学习路径：provenance 取 AX-PROVENANCE 的 `assistant-observed`/`content-in-transcript`（机械确保非 Tier-1）、timeline 标 `migrated-from-mechanism-docs`、入 Tier-2、可 dry-run/可 contest，因此**不污染**隐式学习管线，也不把“机械回填”升格为 ground truth。这是被显式接受的、有界的例外。
- **承重墙依赖一个尚不存在的能力**:在本 ADR 落地前,`README.md` §4 的"按需渲染 rationale"只能降级为"读 in-place ADR 机制 + git/代码"。这是 Phase-2 接受的过渡代价(§3 时序),不是设计缺陷。
- **schema 扩展 vs body 段过渡**:`direction_impact` 进 frontmatter 利于查询,但属 schema 改动;可先以保留 body 段过渡,再固化为 frontmatter--由实现按 AI-Native"能 prompt 不机械"权衡,但**升级义务本身不可降级为纯散文**。

## 6. 接受的代价 + 走偏信号

**代价**:迁移期 rationale 可得性二等(in-place 兜底);direction_impact 注解增加 sediment 单条成本;分解粒度由 curator 判断,可能与人类预期不完全一致(可 contest 纠正)。

**走偏信号**:1ingest 把 ADR 整篇 dump 成一条 entry(违反分解)→ 回退;2出现"渲染不出就编一个 rationale"(违反 missing-not-hallucinated)→ 立即按 README §5 升级;3direction_impact 的 `weakens/conflicts` 被静默 `escalation=none` 接受(承重墙失效)→ 红线;4为提升 ingest 准确率加"阈值阻断写入"类认知层机械门 → 违反 AI-Native,走 direction §4 走偏信号 #6。

## 7. 依赖与后续

- **解锁**:本 ADR 落地后,Phase-2 的"物理瘦身/归档"(把 mark-in-place 的机制正文真正移走、ADR 收成方向残桩)才安全执行--届时 rationale 经 abrain 可得,satisfies acceptance 9。
- **不在本 ADR 范围**：abrain memory schema 的具体字段实现、sediment lane 的具体 pipeline、渲染 prompt 的具体措辞（实现细节 → 代码 + abrain，不写进本 ADR）；源 ADR@SHA 漂移后的 re-ingest/delta-update（staleness reconciliation）——本 ADR 只 pin SHA 使漂移人类可检，自动 re-sync 是后续 ADR。
