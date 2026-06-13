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

## 7. 现有文档迁移计划

**Phase 1（本次，已做）**：建共识层 `README` + `vision` + `direction` + `requirements` + `feature-changelog`；修已验证缺陷（ADR 0027→0009 断链、current-state commit hash）。

**Phase 2（待办，见 `roadmap.md`）**：按"方向头部留共识、机制正文归 abrain"劈分现有 23 份 ADR 与 `architecture/*`；把当前实现状态从 `current-state.md` 收敛为"代码派生"；给 abrain 补技术细节本体 + 升级标注能力。23 份 ADR 多为"双模"（不变量头部稳定、机制正文已部分过时），劈分线：

| 倾向留共识（方向/不变量）| 倾向归 abrain（机制/实现）|
|---|---|
| 0003 主会话只读、0013 信任分层原则、0014 第二大脑定位、0024 §2/§3/§6/§7、0028 ground-truth 主轴、0027 拓扑论断、0017 strict-binding、0022 prompt_user 契约、0020 sync 不幻觉合并 | 0010、0015、0016、0018、0021、0023、0025 全文、0026 机制、0028 tier 谓词机制、各 ADR 的 prompt/schema/file:line 正文 |

迁移按"方向"逐条抽进 `direction.md`/`requirements.md`，机制正文留给 abrain（sediment 写）或归档；**不在本次一次性物理删除**。

---

## 8. 冲突解决优先级

1. **代码** — 实际行为的真相。
2. **docs/（vision/direction/requirements）** — 期望方向的真相；代码与之冲突默认是 drift。
3. **abrain** — rationale / 先例（可能 stale）。
4. `docs/audits/`、`docs/archive/`、git history — 仅证据/历史。
