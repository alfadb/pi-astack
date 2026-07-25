---
name: planning-interview
description: 模糊需求的决策访谈与可改计划落地。合并决策盘问、仓库文档对齐、长周期探索为一套无状态 SOP；事实自查，真正决策才问用户，共识后实施或挂 goal。适用于模糊新功能、架构/领域模型、高返工风险、相互依赖决策、跨会话大型任务。不适用于单点事实查询、已明确的小改动、已有完整 spec/验收标准的执行、普通局部 bugfix、用户明确要求立即执行且无关键未决策的任务。
metadata:
  version: "1.0"
  phase: "prompt-orchestration"
---

# Planning Interview（规划访谈）

无状态 SOP：先分流，再（按需）访谈/写文档/挂 living plan，最后 handoff 到实施。
**不创建**第二套 tracker、goal 状态机、checklist DB 或 issue ticket map。
复用现有工具：`read`/`grep`/`bash`、`memory_search`/`abrain_get`/`memory_decide`、
`prompt_user`、`goal_set(doc=...)`、`workflow_list`/`workflow_run`。

核心原则：
1. **小任务别盘问**——能直接做就做。
2. **事实不问用户**——先查代码、环境、记忆、公网；只问真正的决策。
3. **一次一个决策**——给推荐答案 + 简短理由；必要时 `prompt_user`。
4. **共识前不执行**——用户可随时明确结束访谈并授权动手。
5. **单一 living plan**——长任务只维护一份可改 markdown + `goal_set(doc=...)`。
6. **遵循仓库既有约定**——发现 glossary/domain docs/ADR/RFC/spec 习惯再写入；不强制某路径。

---

## Step 0 — 最小分流

读用户意图与现有上下文，选一条路径（可在证据出现后降级/升级）：

| 路径 | 条件 | 动作 |
|------|------|------|
| **跳过** | 单点事实、已明确小改动、完整 spec 可执行、普通局部 bugfix、用户明确立即执行且无关键未决策 | **不加载本流程**；直接查/做 |
| **单会话访谈** | 模糊但可在本会话收敛；决策少、返工面可控 | Step 1–3 → 共识后实施或出短 spec |
| **持久化共识** | 决策需留下文档（领域词表、ADR、RFC、验收 spec），供后续会话复用 | 访谈 + Step 4 写确认内容 |
| **长周期探索** | 跨会话、多探针、边界未定、验收靠证据滚动 | 访谈关键决策 + Step 5 living plan + `goal_set` |

不确定时偏向更轻路径。用户说"先别做/只要讨论/只要计划" → 允许停在计划，并在 handoff 标明。

---

## Step 1 — 事实自查（不问用户）

在提问前尽量自己弄清：

1. **代码/仓库**：相关模块、现有模式、测试与脚本、已有 plan/spec/ADR/glossary。
2. **记忆**：`memory_search`（必要时 `abrain_get` / `memory_decide`）查偏好、已知坑、既有决策。
3. **公网**：仅当仓库内无法回答且影响决策时再查（API 约束、上游行为等）。

把结果记为**工作假设**（可改），不是已确认共识。能自行消解的"问题"不要拿去问用户。

发现仓库文档约定时**遵循它**（路径、命名、是否写 ADR、glossary 粒度）。没有约定就不要发明重型文档体系。

---

## Step 2 — 决策队列

只把**真正阻塞推进**且**用户必须拍板**的点排入队列：

- 目标与非目标（destination / out of scope）
- 难逆转的结构选择（数据模型、边界、兼容承诺、对外接口）
- 相互依赖的取舍（选 A 会锁死 B）
- 验收标准与证据形态（怎样算完成）

排除：可从代码读出的事实、低成本可改的实现细节、你可合理默认并在实施中调整的事项。

排序：先定 destination 与 scope，再定高返工决策，最后是可延后细节。

---

## Step 3 — 访谈（一次一个）

对队列中的每个决策：

1. 用 1–3 句说明**为何现在必须定**（返工/依赖/范围）。
2. 给出 **2–4 个具体选项**（避免开放式空问）。
3. 标明 **推荐选项 + 简短理由**（依据 Step 1 证据）。
4. 等用户选定或改写后再问下一个。
5. 关键决策、需要明确落档时用 `prompt_user`；日常对话里用户已清楚表态则不必再弹窗。

规则：
- **一次一个决策**；不要问卷式连发。
- 用户跳过某题 → 记为 unresolved，给临时假设，不假装已定。
- 用户说"按你推荐/你定/继续做" → 采用推荐，记入确认，推进。
- 用户说"结束访谈/别问了/直接做" → 停止盘问，用已有共识 + 显式假设 handoff。

**共识前不执行**代码或不可逆操作（只读调查除外）。

---

## Step 4 — 文档（只写已确认）

仅当路径是持久化共识/长周期，或用户要求留下规范时：

1. **先发现**仓库已有位置与体例（如 `docs/`、`adr/`、`spec/`、glossary、RFC）；有则跟随。
2. **不要强制** `CONTEXT.md`、`docs/adr` 或任何本 skill 自创固定路径。
3. **只记录已确认内容**；假设标为假设，未决标为未决。
4. **ADR** 仅用于：难逆转 + 存在真实 tradeoff + 离开上下文会令人意外。常规实现选择不写 ADR。
5. **Glossary / 领域词** 只定含义与边界，**不要**写成 spec 或任务清单。
6. 需要可执行规范时写/更新 **spec**（目标、范围、接口/行为、验收），保持短而可检验。

文档是沟通与审计，不是第二套完成状态。

---

## Step 5 — 长周期 living plan + goal

跨会话或需滚动探索时：

1. 在仓库**合适位置**维护**唯一** living plan markdown（若已有相关 plan 则更新它，不另起平行计划）。常见名如 `plan.md` 或 `docs/plans/<topic>-plan.md`——跟随仓库习惯。
2. 计划保持**可改**，至少表达：
   - **Destination**：做成什么样
   - **In / out of scope**
   - **Confirmed facts**（已核实，附证据指向）
   - **Unresolved decisions / current hypothesis**
   - **Next probe**：下一步最小验证
   - **Acceptance criteria / evidence**：怎样算完成、要什么外部证据
3. 用 `goal_set({ doc: "<plan-path>" })` 挂上该文档（doc 与 objective 互斥；doc 必须已可读）。
4. 真实事实或计划变化时**就地改 plan**，并用证据更新；不要另建 todo DB / DAG / issue map 当完成 SOT。
5. 若仓库已有 issue tracker，可以**链接** ticket；**plan.md 仍是当前 goal 的 SOT**。
6. 勾选完成必须有外部证据（测试输出、文件、git sha 等），不能靠自勾交差。

---

## Step 6 — 固定 workflow（可选）

仅当存在**固定可复用**的引擎 workflow（项目 `workflows/*.json` 或 abrain 可跑资产）且任务匹配时：

1. `workflow_list` 查看
2. `workflow_run({ file })` 执行

**不要**把适应性访谈、探索或一次性计划编成 workflow。没有命中固定流程就跳过本步。

---

## Step 7 — 停止条件与 handoff

满足任一即停访谈并 handoff：

- 关键决策已确认，剩余仅为执行细节
- 用户明确结束访谈或要求实施/只要计划
- 继续提问的预期信息增益很低

| 场景 | Handoff |
|------|---------|
| 小任务，共识已够 | **直接实施**（主会话派确定性子代理执行，审查结果） |
| 需要可复用规范 | 产出/更新 **spec**（+ 必要 glossary/ADR），再实施或交还用户 |
| 长任务 / 跨会话 | 更新 living plan + `goal_set(doc=...)`，写清 next probe 与验收 |
| 命中固定流程 | `workflow_run` |
| 用户只要计划/讨论 | 交付计划/共识摘要，**标明未实施**，停 |

**不得**在用户期望交付结果时只停在计划上。

Handoff 摘要（几行即可）：destination、已确认决策、显式假设、未决、下一步、产出路径（plan/spec/ADR）。

---

## 反模式（禁止）

- 对可直接做的小改动启动盘问
- 把能查到的事实当成问题问用户
- 一次抛出长问卷
- 共识前大范围改代码
- 强制 `CONTEXT.md` / 固定 ADR 目录 / 复制外来 slash 流程
- 新建 issue ticket map、DAG、todo DB、第二套 goal/checklist 状态
- 把 glossary 写成 spec，或把一切选择都写成 ADR
- 无固定可复用 workflow 却去 `workflow_run`
- 只写计划却不 handoff 实施（除非用户只要计划）

---

## 一次最小执行清单

1. Step 0 分流（可跳过则立刻退出本 skill）
2. Step 1 事实自查（代码/记忆/公网）
3. Step 2 列决策队列（仅真决策）
4. Step 3 一次一问，推荐 + 理由；关键用 `prompt_user`
5. 需要时 Step 4 写已确认文档 / Step 5 living plan + `goal_set`
6. 命中时 Step 6 `workflow_list`/`workflow_run`
7. Step 7 handoff：实施 / spec / goal / workflow / 仅计划
