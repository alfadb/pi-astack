---
doc_type: consensus
status: active
---

# pi-astack 文档体系 — 人类 ↔ abrain 的共识基础

> **这份 README 是文档体系的总章程（charter）。agent 在任何涉及本项目方向/需求/设计的任务开始时先读它。**
> 它定义：docs 装什么、abrain 管什么、方向与细节怎么切、agent 怎么读/写/升级、以及方向漂移如何回到人类。

---

## 0. 一句话模型

- **docs/（本目录）= 人类与 abrain 的共识基础**：人类可读，记录**愿景 / 目标 / 需求 / 方向（不变量+取舍+走偏信号）/ 功能变更**。它是 abrain 必须对齐的契约。
- **abrain（`~/.abrain` 第二大脑记忆）+ 代码 = 技术实现域**：abrain 持有技术细节/实现 rationale（机器形态、`memory_search` 查询、sediment 自维护，**人类不直接读**）；代码是当前实现的最终真相。
- **治理切分**：**技术大方向由人类把控（→ docs）；技术细节与实现由 abrain 决定（→ abrain+代码）。**

为什么这样切：abrain 内部是为 agent 检索优化的、人类可读性极差的形态。所以凡是**需要人类共识/审计/否决**的东西，就不能只活在 abrain 里——它必须落在人类可读的 docs。其余技术细节交给 abrain，避免用 prose 镜像代码（镜像必漂移，见 §6）。

---

## 1. 方向 vs 细节：判别式

> **"abrain 能不能靠写更好的代码自己改掉这条，而你不会因此失去对项目走向的控制？"**
> **能 → 细节（abrain + 代码）；不能 → 方向（docs）。**

等价测试（重实现不变性）：一条陈述若在 abrain 把实现从头重写后**仍然成立且约束有效**，它是方向；若一个合法的重实现就能证伪/替换它（file:line、schema、prompt 文本、阈值、门列表、计数），它是细节。

**关键例外**：当"怎么做"本身编码了一个**价值观**时，方向会伸进"怎么做"里。例如 AI-Native 原则（防出错优先 prompt 而非机械门，见 `direction.md`）——它是技术的，但它是人类把控的价值，归方向/docs。

---

## 2. docs 装什么（内容地图）

| 文件 | 职责 | 谁写 |
|---|---|---|
| `vision.md` | 产品愿景、定位、非目标、当前大方向目标 | 人类（agent 可起草，人类签字）|
| `memory-system-vision.md` | 第二大脑记忆系统愿景与设计目标；作为记忆系统重设计的基线 | 人类（agent 可起草，人类签字）|
| `direction.md` | **承重墙**：不变量（hard invariant）+ 已接受取舍 + 走偏信号（drift-signals）。agent 必须读、不可违反 | 人类 |
| `requirements.md` | 行为需求（带 `REQ-ID` + 验收 + 禁止项），feature-changelog 引用它 | 人类（agent 起草）|
| `feature-changelog.md` | **功能/需求变更**记录（不是代码变更/commit 流水）| 人类拥有，agent 代起草，人类签字 |
| `roadmap.md` | 未完成/deferred 的工作 backlog（任务级，区别于 vision 的目标级）| 人类 + agent |
| `adr/` | **方向级**架构决策（被取代/walk-back 关系、为什么这么定）。详见 §4 迁移计划 | 人类签字 |

**不进 docs**（属于 abrain + 代码域）：技术机制设计、调用链/模块图、prompt 全文、schema、当前实现状态快照（扩展清单、计数）、commit 流水、审计转录。

---

## 3. 问责契约（单向约束）

- **docs 约束 abrain，不反向。** abrain 可以**提议**改 docs（升级给人类签字），但**绝不静默覆盖、重新解释、或"按实现纠正"方向**。
- **任务开始时**，agent 必须加载 `vision.md` / `direction.md` / `requirements.md`，声明本任务命中哪些 `REQ-ID` / 不变量，并在冲突时先停下来升级。
- **冲突默认裁定**：代码与 docs 不一致时，默认是"实现 drift（修代码）"，**除非人类先更新了 docs**——abrain 不得把自己的实现偏移当成新方向。

---

## 4. 承重墙：方向漂移的返回路径

abrain 不可读 ⇒ 它的上千个"细节"决定里，某些累积起来可能**悄悄反转人类设的方向**，而人类看不见，直到产品行为已错。本项目历史已发生过（机械门 vs AI-Native 那条弧线：人类只因审计是人类可读的才在 R6 抓住了 RLHF 偏置漂移）。因此本模型成立的**充要条件**是有一条返回路径：

1. **`direction.md` 是人类的可读否决面**：所有不变量 + 走偏信号集中在这里，人类随时能比对、否决。
2. **abrain 的升级义务**：当一个细节决定**触碰/削弱/限定**了某条方向（触发器见 §5），agent 必须升级——产出一条 `feature-changelog.md` / `requirements.md` 提案请人类签字，而不是静默把方向改写进 abrain。
3. **按需渲染 rationale**：人类要审某个技术决定时，agent 必须能把"为什么这么设计 / 否决了什么"从 abrain 召回并讲成人话。abrain 内部不可读没关系，但这条渲染能力是承重墙，不能丢。

---

## 5. agent 读 / 写 / 升级流程

**读（任务开始）**：① 确认 project binding；② 读 docs（`vision`/`direction`/`requirements` = 不可违反的方向）；③ `memory_search` 查 abrain（技术知识/先例/rationale，注意 status，可能 stale）；④ 读代码（当前实现真相）。
权威：方向看 docs，当前实现看代码，rationale 看 abrain（但可能过时）。

**写（细节决定）**：耐用的技术细节决定 → 记入 abrain 项目记忆（经 sediment，不是主会话直接写）；代码改动 → git。**不写进 docs。**

**升级（细节触碰方向 → 必须升级给人类）**触发器：
- 用户可见行为/默认值/兼容性/错误语义变化
- 需求语义变化（收窄/放宽、把可选变强制、改验收标准）
- 信任/隐私/记忆边界变化（什么入 abrain、什么入 LLM context、秘密处理）
- 归属边界变化（把技术设计塞回 docs、或让 abrain 成为人类方向的来源）
- 架构大方向（换两库模型、换持久后端、改 binding 语义）
- 高反转成本（数据迁移、持久 schema 变更、跨项目约定）
- 与现有 docs 冲突

升级前可在 abrain 记一条 `provisional`/`contested` note 说明问题存在，但**不得把方向变更当作已接受**。

---

## 6. 真相源映射 + 为什么不镜像代码

| 想知道什么 | 去哪 |
|---|---|
| 当前行为 / 已 ship 什么 | **代码**（`extensions/**`、`package.json`）+ `memory_search` |
| 技术机制/设计 rationale | **abrain**（`memory_search`）+ 代码 |
| 项目方向/不变量/需求 | **docs/**（本目录）|
| 历史评审/证据 | `docs/audits/`、git history |

**反模式（禁止）**：用 prose 文档镜像代码事实（如"当前 N 个扩展"）。证据：曾出现 README 说 10、current-state 说 17、实际 `ls` 20 的三处漂移——计数是可被重实现证伪的细节，不该手抄进文档。能被 agent 本来就会跑的 `grep`/`ls` 替代的段落，删掉。

---

## 7. 文档体系迁移：状态

**Phase 1（已完成）**：建共识层 `README` + `vision` + `direction` + `requirements` + `feature-changelog`；修已验证缺陷（ADR 0027→0009 断链、current-state commit hash）。

**Phase 2（存量语料已完成，详 `roadmap.md` / `feature-changelog.md`）**：存量 ADR 的方向上提为共识层一等公民——hard invariant 全部集中在 `direction.md`、行为需求集中在 `requirements.md`（具体条目以两文件现状为准，不在此镜像计数）；`current-state.md` / `architecture/*` 去代码镜像、只留契约；frontmatter + `docs-doctor` 守卫落地。机制侧由 [ADR 0034](adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md) 的 source-aware ingest lane 收口：存量机制 ADR 已分解为 typed entry 入 `~/.abrain/projects/pi-global/`（计数由 `ls` 派生，不在此镜像），ADR 物理瘦身为方向残桩，机制 rationale 经 `renderRationale` 按需渲染（带 pinned `source_ref` SHA）——§4「按需渲染 rationale」承重墙兑现。

**稳态**：迁移收口后新增的机制 ADR（如 0035/0036/0037 的 memory 检索栈）按同一两库模型办——先成文为完整 ADR，再走 slim + ingest lane 沉入 abrain，属正常生命周期而非 Phase-2 缺陷。

**已知残留缺口**：① pinned `source_ref` SHA 的 **staleness re-sync**（ADR 0034 ratify 显式 defer，待 dogfood 出现首例 stale 后带证据起草新 ADR）；② 收口后新增机制 ADR（0035/0036/0037）的 slim + ingest 尚未执行（须经 sediment lane go/no-go，主会话不写 abrain，见 `roadmap.md`）。

---

## 8. 冲突解决优先级

1. **代码** — 实际行为的真相。
2. **docs/（vision/direction/requirements）** — 期望方向的真相；代码与之冲突默认是 drift。
3. **abrain** — rationale / 先例（可能 stale）。
4. `docs/audits/`、`docs/archive/`、git history — 仅证据/历史。
