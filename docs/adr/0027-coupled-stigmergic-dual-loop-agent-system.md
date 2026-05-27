# ADR 0027 — Coupled Stigmergic Dual-Loop Agent System (CSDLAS)

- **状态**：**v0.2 baseline（2026-05-27）**。三家跨 provider T0 reviewer（Claude Opus 4-7 / GPT-5.5 / DeepSeek v4-pro）三轮辩论后合议接受（详 §11）。两家 ACCEPT-with-reservations、一家 ACCEPT，三家保留意见已收录到 §11.4。
- **依赖**：[ADR 0009](0009-multi-agent-dispatch.md)（multi-agent dispatch 底座）、[ADR 0024](0024-second-brain-from-natural-conversation.md)（第二大脑哲学 + 四 invariant + AI-Native 原则）、[ADR 0025](0025-sediment-meta-curator-subsystem.md)（sediment 写侧落地）、[ADR 0026](0026-second-brain-decision-participation.md)（第二大脑参与任务执行）。
- **对偶**：ADR 0024 定**哲学不变量**（什么是合法的认知边界），本 ADR 定**拓扑不变量**（什么是合法的 multi-agent 协作边界）。ADR 0025/0026 是 L1 沉淀 + L2 决策的具体落地，本 ADR 是覆盖两者的横切架构总结。
- **范围**：CSDLAS 是 pi 内 multi-agent 系统的总框架。不直接定义任何具体能力点的实现；具体能力推到 ADR 0028（IDE/host 边界）/ ADR 0029（跨 provider 治理）/ ADR 0030（hub baseline + evaluation harness）。

---

## 0. 起草说明

### 这份文档**写什么**

- multi-agent 系统在 pi 内的拓扑形态总框架（§1-§4）
- 跟业界主流 multi-agent 框架（LangGraph / AutoGen / CrewAI / OpenAI Swarm SDK / Devin / Claude Code subagents / AgentNet）的对照（§5）
- 当前推到独立子 ADR 的能力点 + 明确未解谜题（§6-§7）
- 接受的代价 + 走偏信号（§8-§9）
- 防止误读的边界声明（§10）
- 三轮 T0 评审的演进史 + reviewer reservations（§11）

### 这份文档**不写什么**

- ADR 0024 已经定的四 invariant + AI-Native 原则的论证（本 ADR 引用，不重复）
- ADR 0025 已经定的 sediment 六能力点的细节（本 ADR 只引到 L1 形态对齐处）
- ADR 0026 已经定的决策点检测 / 决策简报 prompt 细节（同上）
- 任何 ADR 0028/0029/0030 的具体设计——子 ADR 启动后另写
- agent runtime 的具体 wire format / schema 设计——属 C3' 的 infra 层，本 ADR 只定边界不定细节

如果发现本 ADR 在重复 ADR 0024-0026 → **删掉**，引用即可。

---

## 1. 一句话总纲

> pi 作为认知体由两套**各自封闭、不可统一治理但互嵌共生**的循环组成：
>
> - **L1 — Sediment Evolution Loop**（用户 ↔ 主 agent 的认知执行环）
> - **L2 — Task Execution Loop**（主 agent ↔ sub-agent 的任务协作环）
>
> 两层通过共享 `session-id + turn-id` 的 stigmergic trace 互嵌共生，但**不共享治理 invariant**。L1 走 prompt-native 治理（ADR 0024 §3）；L2 走 infra-structured 治理（worker correctness / liveness / coordination）。

---

## 2. 六条核心论断

下面六条是 CSDLAS 的硬骨架。任何后续设计违反任一条都需要在自己的 ADR 里**显式 walkback**（参 ADR 0024 §7 走偏信号机制）。

### C1' — 双 invariant 治理 + 互嵌共生（**非正交**）

L1 与 L2 持有各自不可互相归约的 invariant 集合：

- **L1 invariant**：ADR 0024 §2 四条（INV-INVISIBILITY / INV-AUTONOMY / INV-IMPLICIT-GROUND-TRUTH / INV-ACTIVE-CORRECTION）。核心是认知一致性、用户不参与管理、隐式真实信号、主动纠错通道。
- **L2 invariant**：worker correctness（sub-agent 的输出与任务声明的契约一致）、liveness（sub-agent 不静默死亡）、coordination（多 sub-agent 间状态收敛）、任务成功（在 caller 的 timeout/budget 内闭环）。

**两套 invariant 不可统一为单一框架**：L1 的 INV-INVISIBILITY 不允许 L2 的"必须问用户 worker 该派谁"；L2 的 bounded-latency 不允许 L1 的 staging-pending 多周窗口。任何尝试用一套 curator policy 覆盖两层的设计都会破其中一边。

**但二者非正交**——L2 执行结果以 stigmergic trace 形式反馈 L1 认知状态（outcome → sediment）；L1 意图漂移与历史偏好以 annotation 形式约束 L2 调度决策（decision brief → worker context）。**这是互嵌共生闭环，不是平行系统**。

> **删除"正交"措辞**：正交意味可独立演进，但实际上 L2 失败会直接污染 L1 turn 语义（如 worker 返回错的代码 → L1 turn output 错），L1 错沉淀会直接误导 L2 调度（如错的 preference → 错的 role assignment）。"正交"是 v0.1 误用。

---

### C2' — L1 stigmergy-only / L2 双模 + singleFlight + 显式 completion + heartbeat

**通信介质分层规则**：

| 层 | 默认 | 例外 | 约束 |
|---|---|---|---|
| L1 | stigmergy only | （无） | 仅通过共享 trace 与 L2 通信，不走 message passing；L1 不感知 L2 内部 agent 拓扑 |
| L2 | stigmergy | rendezvous 时 message passing | 所有 stigmergy 写经 `singleFlight`；rendezvous 必须配 heartbeat + 显式 completion 终态 |

**`singleFlight` 约束**：同一 trace key 同一时刻一个 writer。这是修补 ADR 0025 §1.3 已经承认的 `gitCommit()` race（sediment writer 没接入 git-sync singleFlight 会跟 auto-merge 抢 `.git/index.lock`）。推广到 L2 后多 worker 并发写更严重，**`singleFlight` 必须在 L2 dispatch 上线前实现**。

**显式 completion 语义**：L2 task 必须以 `completed | failed | degraded | cancelled` 之一终结。**禁止"无回复即完成"的隐式假设**——这是 stigmergy 的结构性盲区（trace mutation 自身不编码 liveness：trace 缺失可能是生产者还没产出、生产者已死、或生产者卡在推理里，三种情况物理上无法区分）。

**Heartbeat 必需**：L2 task 预计执行 > caller timeout window 50% 时**必须**周期性写 heartbeat 到 trace（独立于业务 trace 通道，是 liveness 通道）。Heartbeat 缺席 × N 周期 → caller 可安全推断为 `cancelled (timeout)`。这条把 liveness 从 artifact 层剥离到独立通道，**不依赖** message passing 也能工作（heartbeat 写 trace 文件 + caller 轮询即可）。

> **R3 共识 H1**：三家最终 ACCEPT "stigmergy 有 completion semantics 结构盲区 + heartbeat 是必要补充"。

---

### C3' — 认知层 prompt-native / infra 层 structured

ADR 0024 §3 AI-Native 原则**仅约束认知层防出错主路径**。明确边界：

| 层 | 防出错主路径 | 何处出现 | §3 约束 |
|---|---|---|---|
| **认知层** | prompt-native | classifier / curator / writer / reviewer / 参谋决策 / 证据评估 / 主动纠错语义分类 / multi-view Pass 1 blind reviewer | **严格约束**（不准加 schema 关卡 / 不准加阈值机械门 / 不准用测试做拦截） |
| **Infra 层** | structured | tool schema / audit event format / state machine / retry counter / cost accounting / wire format / heartbeat protocol / cancellation token / done-marker schema / singleFlight lock | **不约束**（机械工程兜底，符合 ADR 0024 §3 末尾"机械工程仍可做兜底或基础设施"原意） |

**v0.1 → v0.2 关键修正**：v0.1 的 C3 写"swarm 编排应该是 prompt-native 的"被 R1 reviewer 一致指出会被误读为"全系统都 prompt-native"——这会破坏 audit / completion / cost attribution / wire marshalling 等不可缺的 infra。v0.2 把分层显式开：**判断走 prompt，基础设施走 structured，两层在关键决策边界 cross-write**（infra 层写 structured 摘要进 cognitive 的 stigmergic trace，让下游 LLM 可读）。

> 误读防御示例：未来某个 PR 写"我加了一个 done-marker JSON schema"被 reviewer 说"这违反 AI-Native"——错。done-marker schema 是 C3' infra 层，不在 §3 禁止范围。反之，如果某 PR 写"我加了一个 classifier 输出准确率阈值，低于 80% 阻断写入" → 这是 §3 禁止的认知层机械门。

---

### C4' — 用户不作 swarm worker；fire-and-forget 分层判定

**用户角色**：在 L1/L2 中**不**作为 worker / reviewer / curator / hub / 调度者节点。用户的合法角色仅有两个：

- **L1 隐式信号源**（ADR 0024 INV-IMPLICIT-GROUND-TRUTH）+ **L1 决策参谋接受方**（ADR 0026 §3）
- **L2 主任务对话发起方**（自然对话 + ADR 0022 `prompt_user` 任务相关具体决策 + ADR 0014 `vault_release` 高价值数据明确授权）

**fire-and-forget 分层判定**（v0.1 "拒绝 fire-and-forget" 措辞过粗，v0.2 精化）：

| 关系 | 是否允许 fire-and-forget | 依据 |
|---|---|---|
| 用户 → L1 | **不允许** | L1 必须以同步/异步方式回传用户确认点；用户对系统响应有期望 |
| L1 → L2 | **允许** | L1 写入 task 后立即返回，不阻塞主会话 LLM 推理（ADR 0025 §1.1 Lane C 已实证可行） |
| 用户 → L2 整体 | **不允许** | L2 整体对用户**必须可问责**——任何 L2 失败必须在 L1 当前 turn 内可见 / 可归因 / 可被用户主动追问 |
| L2 内部 sub-agent 之间 | **允许** | 但必须配 C5 fail/degrade 语义兜底（任何 sub-agent 静默死亡必须被上层 heartbeat 兜底） |

**关键区分**：拒绝的是"把用户踢出任务 loop 的自治长跑"（Devin / SWE-agent 模式），**不是**拒绝任何后台并行。

---

### C5（新） — L2 显式 fail / degrade / cancel / resume 语义

L2 每个 task（及其每个 subtask span）**必须**支持四种显式生命周期转换：

| 转换 | 语义 | 触发方 | 写 trace 字段 |
|---|---|---|---|
| `fail` | task 不可恢复终止，副作用已回滚或显式标记 | L2 executor 自主判定 | `terminal_state: fail, reason, rollback_done` |
| `degrade` | task 以降级模式完成（部分功能 / 降低 SLA / 替代路径） | L2 executor 自主判定 | `terminal_state: degraded, what_dropped, alt_path` |
| `cancel` | task 被外部信号终止（用户、L1、scheduler） | L1（via trace annotation）或 L2 scheduler | `terminal_state: cancelled, cancel_source, cleanup_done` |
| `resume` | task 从中断点幂等恢复，或显式声明 not-resumable | L2 scheduler（基于 trace checkpoint） | `resume_from_checkpoint, idempotency_key` |

**核心规则**：

- 所有转换写 trace 形成完整因果链（C6 锚点）
- `degrade` 与 `fail` 边界由 L2 的 per-task-type SLA policy 定义，不在本 ADR 全局规定
- **未实现 C5 之前**，L2 只能在 read-only / 实验通道存在，**不进入用户主路径**（这是 Opus reservation #1）

---

### C6（新） — 跨 L1/L2 causal trace 共享 `session-id + turn-id` 锚点

**强制 schema**：每条 trace entry 必须携带 `(session_id, turn_id)` 二元组。

- `session_id`：用户会话级，贯穿整个交互生命周期（ADR 0026 §6.4 已暗指但未强制）
- `turn_id`：用户单次 prompt/response 往返级，单调递增

**派生规则**：

- L1 发起的 task 继承当前 `turn_id`
- L2 内部派生的 subtask 追加 `subturn` 字段（`turn_id.subtask_seq`）**但不改变 anchor**
- 任何 dispatch_agent / dispatch_parallel / sub-agent 调用强制注入 `(session_id, turn_id)`
- 跨层回溯时，`(session_id, turn_id)` 是唯一必需 join key——不需要全局时钟或分布式事务

**为什么 blocking**：这是 C4' "L2 整体对用户可问责" 的**物理基础**。没有共享锚点，L1 错沉淀回到 L2 的因果链就只能靠 LLM 推理——而 LLM 推理因果链跨上下文是极不可靠的（multi-view audit 多次证实），违反 §3 在 infra 层的边界（"causal trace 是 infra 层，不该靠 LLM 兜底"）。

---

## 3. L1 / L2 表达边界表

| 维度 | L1（认知执行环） | L2（任务协作环） |
|---|---|---|
| **Trigger** | 用户输入 / 自然对话 / `agent_end` hook / scheduler | 主 agent 在 turn 内 dispatch_agent / dispatch_parallel |
| **时间尺度** | 分钟 — 周（aggregator 跨会话） | 秒 — 分钟（单 dispatch） |
| **治理 invariant** | ADR 0024 §2 四条 | worker correctness / liveness / coordination / 任务成功 |
| **通信范式** | stigmergy only | stigmergy 默认 + rendezvous message passing |
| **调用协议** | prompt-native（自然语言意图 + structured context block） | structured（typed task descriptor + heartbeat + done-marker） |
| **介质** | sediment entries + audit.jsonl + git refs + abrain 七区 | task trace + shared workspace + audit.jsonl + git refs（共享 stigmergic substrate） |
| **并发模型** | 单会话串行 | multi-agent 并发 + singleFlight |
| **Completion 语义** | turn 结束 = LLM 输出完成 | 显式四态 + heartbeat（C2'/C5） |
| **失败语义** | LLM 自己向用户解释 + sediment staging-pending | 显式 fail/degrade/cancel/resume（C5） |
| **Fire-and-forget** | 对用户允许（L1 footer/notify/audit 告诉而不要求） | L1→L2 允许；L2→用户**不允许**；L2 内部允许 |
| **用户可见性** | 全可见（INV-INVISIBILITY 边界内告诉而不要求） | terminal state 可见 / 内部拓扑不可见 |
| **状态 footprint** | abrain / sediment / rules / footer / notify | git refs / lockfile / audit.jsonl / done-marker / heartbeat |
| **防出错主路径** | prompt-native（§3 强约束） | infra structured（§3 不约束） |
| **Trace 角色** | 消费者 + 注解者 | 生产者 + 消费者 |
| **闭环耦合** | 产出 entry 喂给 L2 作决策上下文（ADR 0026 §3） | 产出 outcome + correction signal 喂给 L1（ADR 0025 §4.1-§4.2） |

---

## 4. 设计哲学：CSDLAS 是 AI-Native 在 multi-agent 拓扑层的延伸

CSDLAS 不是新哲学，是 ADR 0024 §3 AI-Native 原则**在 multi-agent 系统这个新维度上的精确化**。

### 4.1 同源点

ADR 0024 §3 写"任何能力点防出错的主要路径必须是 prompt 工程；机械工程仍可做兜底或基础设施，但不能作为 LLM 行为层的主要防出错手段。"

CSDLAS C3' 在 multi-agent 拓扑层做同样切分：**认知层（LLM 行为）走 prompt-native；infra 层（multi-agent 协调）走 structured**。这是同一原则的精确化，不是新原则。

### 4.2 关键澄清

R1 多模型评审一致发现 v0.1 的 C3"swarm 编排应该是 prompt-native 的"会被误读为"全系统都 prompt-native"——这恰好是 ADR 0024 §3 末尾警告的反方向误读（把"AI-Native"读成"禁止所有机械工程"，而 §3 原意是"机械工程不能做 LLM 行为层主路径"）。

v0.2 C3' 把分层显式开。这条澄清反过来也帮助 ADR 0024 §3 自身：**未来再有人误读 §3 为"禁止所有 schema"，可以指 ADR 0027 §4.2 + C3' 表反驳**。

### 4.3 反向 patch

- ADR 0024 §3.3 "几个典型的机械 vs AI-Native 对照"表可加一行："**multi-agent 协调** → 机械路径：完全用 LangGraph state machine 编排所有 agent 行为；AI-Native 路径：hub 用自然语言决定 worker 派遣 + done-marker 用 structured schema 承载 completion 信号"

---

## 5. 跟业界主流 multi-agent 框架的对照

### 5.1 真独特性

| 维度 | pi-astack（CSDLAS） | 业界主流 |
|---|---|---|
| **L1/L2 不变量分层治理** | 显式两套不可统一 invariant（C1'） | LangGraph / AutoGen / CrewAI 默认单一 invariant 集合（用户 = leader）；它们的 memory 是 RAG store，不是"独立 invariant 治理、用户不参与管理"的子系统 |
| **跨 provider 防 RLHF 共谋作 first-class 设计** | ADR 0025 §4.4 + ADR 0024 §3.1 R7 audit 21/21 PE-form 阻断证据 | LangGraph 不讨论 model bias diversity；OpenAI Swarm 不可能讨论；AutoGen GroupChat 跨 model 不当 bias mitigation |
| **AI-Native 原则升格为 ADR 显式可校验约束 + 认知/infra 分层（C3'）** | 含 PE / Infra / Mech-on-LLM 三态标注 + 每个新 PR 的 review checklist 显式判别 | 业界 framework README 会说"we are LLM-first"但不会有 ADR 0024 §3.3 那种"机械 vs AI-Native 对照表"+"必须显式 justify 为什么不能用 prompt" |
| **Stigmergic substrate 作 L1/L2 共生介质 + completion semantics 盲区显式补丁** | abrain 文件系统作 long-term substrate；heartbeat 独立 liveness 通道 | Claude Code / OpenHands 用工作目录文件协调但没有 "stigmergy 有 completion 盲区" 的显式认知 |
| **C6 跨层 causal trace（session-id + turn-id）作 multi-agent 可问责物理基础** | 所有 dispatch 强制注入 anchor；C4' "L2 对用户可问责" 的物理基础 | LangGraph 有 graph-level trace；AutoGen 有 message log；都没把"跨认知/执行两层的 anchor"作 ADR 级强制约束 |

### 5.2 业界也在做（不能 claim 独有）

| 维度 | pi-astack 形态 | 业界 |
|---|---|---|
| Hub-driven dynamic role assignment | hub 即兴决定派谁，不预定义 crew | OpenAI Swarm SDK `Agent.functions` + handoff；Claude Code subagents 也是 hub 即兴 dispatch；CrewAI 0.30+ `Process.hierarchical` + manager_llm；AutoGen GroupChatManager |
| 自然语言 plan / hub LLM 自主编排 | 在 cognitive 层 | CrewAI manager_llm；AutoGen next-speaker；OpenHands；Claude Code |
| 文件系统作子任务隐式协调介质 | abrain / git refs | Claude Code subagents；OpenHands；Devin |
| 跨 model 调用 | 多 provider | OpenRouter；LangChain provider abstraction（但都不当 bias mitigation） |

**真独特的不是"自然语言 plan"或"hub 即兴 dispatch"本身——而是把"拒绝 schema fallback"+"双 invariant 治理"+"completion semantics 显式补丁"组合成 ADR 级可校验约束**。

### 5.3 跟 AgentNet (arxiv 2504.00587) 的区别

AgentNet 触及了 self-evolving decentralized agent，但仍在任务执行情境（L2）。CSDLAS 把 L1（跨会话自演化、用户不参与管理）和 L2（任务执行、用户在 loop）显式分层 + 给出双向共生接口（outcome → sediment / decision brief → worker context）——这个分层在公开文献中我们没找到先例。

---

## 6. 推到独立子 ADR 的能力点

### ADR 0028（待启动） — IDE / host 边界

**问题**：L1 的 footer / notify / vault 弹窗如何在不同 host（terminal / VSCode / web）上一致映射；agent runtime 与 host API 的责任分割；L2 worker 输出怎么跟 IDE 的 LSP/diagnostics 接。

**为什么独立 ADR**：runtime / host boundary 不是理论问题，是工程边界，不应塞进本 ADR 主文。

**触发条件**：pi 引入除 CLI/TUI 外的第二个 host（如 VSCode extension）。

---

### ADR 0029（待启动） — 跨 provider 治理

**问题**：L2 swarm 内不同 LLM provider（Claude / GPT / DeepSeek / local）的角色路由、能力声明、失败降级；vault / redaction / provider policy 边界；token 计费归属；不同 provider worker 是否有不同数据访问等级。

**为什么独立 ADR**：涉及 ADR 0014 vault 体系 + ADR 0003 sandbox 边界 + ADR 0013 asymmetric-trust 三 lane（GPT-5.5 R2 建议作为 ADR 0013 patch 而非新 ADR——R3 未最终决，留 ADR 0029 启动时再定）。

**触发条件**：单设备 dogfood 推到团队/企业场景，或 multi-view P0.5 真正接入跨 provider reviewer。

---

### ADR 0030（**blocking gate**） — Hub baseline + evaluation harness

**问题**：L2 hub 的 dynamic role assignment 是零样本 learning 问题——hub 怎么知道应该派 3 个 worker 还是 8 个？怎么知道 worker 应该专注代码探索还是方案设计？没有 baseline 就上线 hub assignment = 没有 evaluation 就上线 LLM 行为层（违反 ADR 0024 §3 "AI-Native 不等于不验证"）。

**为什么 blocking**：

- L2 hub 的 single point of failure：assignment 错 → 所有下游 sub-agent 在错误前提下 stigmergy → 错误被放大而不是被纠正
- stigmergy + heartbeat 兜底解的是 **liveness**；hub 错配解的是 **correctness**
- 三家 R3 共识：**ADR 0030 evaluation harness 完成前，L2 swarm 不进生产**（H5 gate）

**evaluation harness 形态待 ADR 0030 决断**：定量 task-allocation benchmark vs 定性"21 条建议人工 review"（DeepSeek R3 给 Opus 的开放问题），这决定 ADR 0030 是工程任务还是研究任务。

---

## 7. v0.2 未解谜题

下面两个问题在 R3 评审中三家明确承认是结构性问题但**无法在 v0.2 内闭合**。留作 v0.3 必决（Opus reservation #3）。

### P1 — Identity drift

**问题**：L1 认知意图在跨 turn 的 stigmergic trace 积累下发生渐进漂移时，系统缺乏检测和校正机制。

具体场景：

- 用户在不同上下文有不同角色（OSS contributor 偏好宽松 vs team lead 偏好严格 review）—— DeepSeek R1 提出的 multi-role identity drift
- L2 sub-agent 何时维持 main agent identity（带 abrain 上下文）、何时独立（fresh context）—— Opus R3 提出
- L1 自我演化几个月后偏好已漂移但用户没主动纠错 —— aggregator 能感知趋势但谁判断"已越过阈值"？

**为什么 v0.2 不闭合**：需要多轮 dogfood 实证数据。强行设计机制（如"角色枚举字段"）会破 ADR 0024 §3 AI-Native 原则（用枚举替代自然语言 scope description）。

**v0.3 决断方向**：要么作为 sediment classifier 的扩展能力（让 classifier 在 staging hypothesis 里识别角色信号），要么作为独立子 ADR。

---

### P2 — Hub assignment 本体

**问题**：hub 是 fixed-role coordinator（设计时锁定）还是 elected role（runtime 选举）？是集中式（单一调度器）还是分布式（agent 自主竞价）？

**为什么 v0.2 不闭合**：决断前置依赖 ADR 0030 evaluation harness——没有 baseline 数据无法判断哪种形态更优。

**约束**：无论哪种形态，必须满足 C1'（不破 L1/L2 invariant 边界）+ C5（fail/degrade 语义）+ C6（causal trace 锚点）。

---

## 8. 明确接受的代价

按 CSDLAS 设计原则，下面这些代价是**显式接受**的。不接受任一代价 = 不接受本 ADR = 回到 v0.1 误读或单 loop 抽象。

| # | 代价 | 后果 | 承担方 |
|---|---|---|---|
| 1 | L2 completion 语义必须显式编码（done-marker + heartbeat schema） | 每个 L2 task 必须包装为状态机；无法以"脚本式 fire-and-forget"快速原型 | L2 agent 开发者 |
| 2 | C5 未实现前 L2 只能 read-only / 实验通道，不能进入用户主路径 | L2 落地 PR 必须先于"L2 用户主路径"出现 C5 实现 | roadmap（含 Opus reservation #1） |
| 3 | ADR 0030 hub baseline + evaluation harness 完成前 L2 swarm 不进生产 | 短期实用性折损；hub dynamic role assignment 只能作 gated capability | ADR 0030 timeline |
| 4 | 所有 dispatch 强制注入 `(session_id, turn_id)` | 老 dispatch_agent 调用需迁移；trace 体积增长 | codebase |
| 5 | `singleFlight` 约束限制同 trace key 的真正并行写 | 高吞吐场景可能成瓶颈；但 v0.2 阶段无高吞吐需求 | 系统整体 |
| 6 | C4' 排除人机协同 stigmergy（人在回路直接参与 trace 竞争） | v0.2 有意取舍——高级用户想直接编辑 trace 的场景不被支持；未来可能修订 | 高级用户场景 |
| 7 | 接受 framing 名"Coupled Stigmergic Dual-Loop Agent System"较长 | 精确性优先于 brevity；缩写 CSDLAS 略生硬 | 命名美学 |
| 8 | C3' 在认知层 / infra 层划线必须在每个新 PR 的 review checklist 里显式判别 | review process 增加一项；防止误读 ADR 0024 §3 | review process（含 Opus reservation 隐含项） |
| 9 | L1↔L2 闭环正反馈放大早期错误 | 假高置信 entry 通过 L2 采纳被强化几轮；ADR 0026 §3.4 断路器是缓解但不是消除 | dogfood 阶段（接 ADR 0026 §3.4 patch） |
| 10 | Heartbeat 机制增加 L2 agent 开发复杂度 | 每个 agent 必须实现周期性 trace write；增加 audit 体积 | L2 agent 开发者 |
| 11 | 跨 L1/L2 anchor schema 锁死后向后兼容代价大 | session-id / turn-id 字段一旦定义，未来扩展（如 inter-host id）需要 migrate；预留扩展字段 | schema 演进 |

---

## 9. 走偏信号

实际跑起来如果出现下面任何一条，需要回头审视本 ADR 是否需要调整：

1. **L2 worker 静默死亡频繁出现**（heartbeat 超时检测频繁触发，但 heartbeat 本身 schema 漏洞导致 false positive）→ C2' heartbeat 规范需细化；可能要加 ADR 0030 evaluation 阶段的 heartbeat 协议子规范
2. **L1↔L2 闭环正反馈放大造成用户察觉不到的偏差累积**（接 §8 代价 9）→ ADR 0026 §3.4 断路器需升级；可能需要 aggregator 跨层关联分析
3. **C3' 认知/infra 边界在实际 PR review 中频繁出现争议**（"这个 done-marker schema 算认知还是 infra？"）→ §4.2 三态标注需更细化；或在 ADR 0028/0029/0030 各自补充本子领域的判别例子
4. **跨 provider RLHF 共谋仍发生**（multi-view 跨 provider reviewer 给出方向一致的错误判断）→ ADR 0025 §4.4 multi-view 设计需修订；可能要引入更激进的对抗性 prompt（参 R7 audit Layer F 自检机制）
5. **session-id / turn-id 锚点在跨设备 sync 后失效**（ADR 0020 git-sync 跨设备后 anchor 重号 / 冲突）→ C6 schema 需加跨设备扩展字段；可能需要 device-id 进 anchor
6. **CSDLAS 这套理论被实际用户反馈"复杂度过高，不如直接 fire-and-forget"**（用户体验上 L2 整体可问责的代价让用户烦）→ C4' 可能需要 walkback；但 walkback 必须基于真实实战数据，不是"我感觉太复杂"
7. **ADR 0030 evaluation harness 跑下来发现 hub dynamic role assignment 在多数 L2 task 上比 fixed crew 更差** → P2 决断方向应锁定 fixed-role coordinator；C1' / C4' 不变但 hub 形态收紧

---

## 10. 这份文档不是什么（防止后续套错框架）

- **不是** "swarm" 系统——CSDLAS 不预设 large-N homogeneous worker + emergent behavior（这是 Bonabeau / Dorigo swarm 文献的预设）。我们是 small-N heterogeneous + 显式分工。"swarm" 词在 R2/R3 让步去掉了 top-level 位置；剩余术语 "stigmergic substrate" 保留是机制描述，跟 N 规模无关。
- **不是** "sympoietic" 系统——v0.1 用 sympoiesis（Beth Dempster 1998 / Donna Haraway 2016）描述 L1+L2 共生在 R1-R3 一致认为是术语误用：sympoiesis 学术定义是 *non-self-producing, no spatial/temporal boundary, collectively-producing systems*；我们 L1 是显式自维持的（sediment writer 闭环）+ 有明确边界（七区 + git repo）。**v0.2 完全去除 sympoietic 词及其衍生表达**。
- **不是** "正交双系统"——v0.1 C1 用"正交"被 R1 一致打回。L1 和 L2 通过 stigmergic substrate 双向耦合，是**互嵌共生闭环**，不是数学正交。
- **不是** "全 prompt-native"——C3' 显式分认知 / infra 两层。infra 层走 structured 不违反 AI-Native 原则。误读 §3 为"禁止所有 schema"是 v0.1 C3 的原始问题。
- **不是** "全 stigmergy"——C2' 显式允许 L2 rendezvous 时 message passing。stigmergy 是默认介质不是唯一介质。
- **不是** "拒绝所有 fire-and-forget"——C4' 分层判定。拒绝的是"L2 整体对用户 fire-and-forget"（Devin 模式），不是 L2 内部 worker 之间 fire-and-forget。
- **不是** "新范式"——CSDLAS 是 ADR 0024 AI-Native 原则在 multi-agent 拓扑层的精确化 + 业界已有机制（stigmergy / hub-driven dispatch）的诚实组合 + 明确标出业界共有盲区（completion semantics、L1/L2 不变量混淆）的边界声明。R3 评分降低正是因为"contribution 从《新范式》降为《诚实标边界》"，但这反而更符合 ADR 0024 自身的方法论气质。
- **不是** "完整可上线设计"——ADR 0030 evaluation harness 未完成前 L2 swarm 不进生产（§6 / §8 代价 3）。本 ADR 是 baseline framework，不是 ship-ready spec。

---

## 11. 演进历史和评审快照

### 11.1 起源

2026-05-27 用户跟主会话讨论"agent 蜂群概念在我们这套系统应该什么形态"。主会话先给出 v0.0（单层 Hub-and-Stigmergic-Swarm）；用户指出蜂群应有两层（L1 自演化 + L2 任务执行）且明确表示 "我们不能自然认为业界趋势就是我们的正确方向，我们有自己的演化方向，或者说我们也可以是领先行业的头部理论"。主会话据此给出 v0.1（Sympoietic Two-Tier Swarm + 四论断 C1-C4）。

### 11.2 三轮跨 provider T0 评审

| 轮次 | 评审形态 | 关键产出 | 成本 |
|---|---|---|---|
| **R1** | 三家跨 provider T0 reviewer（Claude Opus 4-7 / GPT-5.5 / DeepSeek v4-pro）独立产出，互不可见 | 立场矩阵建立、8 个共同盲区识别、framing 三分歧 | ~$1.00 / 332s |
| **R2** | 每家看其他两家 R1 全文 + 互相反驳/让步/趋同 | C1/C2/C3 三家全部 MODIFY；C4 收敛到 HOLD-with-clarification；新增 C5（failure semantics）+ C6（causal trace）；framing 收敛到 2 个候选 | ~$0.78 / 254s |
| **R3** | 终局收敛 + framing 投票 + v0.2 完整文本锁定 + 共识签字 | framing = **Coupled Stigmergic Dual-Loop Agent System** (2/3 多数，Opus 投 CDLAS 但接受 CSDLAS 作 baseline)；三家签字 | ~$0.34 / 149s |

**累计**：~$2.07 / ~12 分钟（并行）。

### 11.3 关键演进节点

- **R1 → R2**：DeepSeek 让步 C1 从 HOLD 到 MODIFY（接受 Opus 的"两套不可统一 invariant 治理"insight）；Opus 让步 C3 从 HOLD 到 MODIFY（Step 6 自承认严格应是 MODIFY）；GPT-5.5 让步 C4 从 MODIFY 到 HOLD-with-clarification（接受 Opus + DeepSeek 的 fire-and-forget 分层判定）
- **R2 → R3**：三家在 framing 上交叉让步——Opus 让步去 swarm 顶名；DeepSeek 让步 swarm 词；GPT-5.5 让步加 stigmergic 进主名。最终 framing 是 GPT-5.5 的"Coupled Dual-Loop Agent System" + DeepSeek 坚持的 stigmergic 介质词 = **Coupled Stigmergic Dual-Loop Agent System**
- **R3 三项分歧**：H1（completion semantics 盲区）三家 ACCEPT；H2（swarm 词去留）2/3 同意去顶名；H5（hub baseline blocking）三家 ACCEPT 作为 production gate

### 11.4 Reviewer reservations（接受为 baseline，但保留意见）

#### Claude Opus 4-7（ACCEPT-with-reservations）

1. **C5 必须先于 L2 用户主路径落地**——任何"先上 L2 再补 fail 语义"的 PR 应 block
2. **ADR 0030 evaluation harness 必须在 v0.3 前完成草稿**——否则 P2 会回流污染 C1'
3. **P1 identity drift 在 v0.3 必须决断**——不能再拖一轮，否则会影响 abrain 调用边界

#### GPT-5.5（ACCEPT）

1. Hub dynamic role assignment 不作未评测 baseline 上线
2. 若进入 baseline 必须先完成 ADR 0030 + evaluation gate

#### DeepSeek v4-pro（ACCEPT-with-reservations）

1. **Stigmergic 进主名是 H2 让步对价**——若 Opus 强反对可再议（已在 R3 由 Opus 接受 CSDLAS 作 baseline 化解）
2. Hub assignment 本体应同时列入未解谜题 + 子 ADR 能力点（已在 §6/§7 双重列出）

### 11.5 最终评分（v0.2 vs R1 起点）

| 维度 | R1 起点 | v0.2 终点 | Δ |
|---|---|---|---|
| 理论原创性 | 7.3 | 7.0 | -0.3（swarm/stigmergic 退出 top-level 后 contribution 框架降级，但内容深度提升） |
| ADR 0024 一致性 | 8.0 | 9.0 | +1.0（C3' 把认知/infra 分层显式开） |
| 工程可落地 | 5.0 | 8.0 | +3.0（C5+C6 + 三条子 ADR 拆分 + H5 blocking gate） |
| 值得发表 | 6.3 | 8.0 | +1.7（completion semantics 盲区 + dual-loop coupled 而非 orthogonal 是可单独成文的小贡献） |

### 11.6 完整 transcript

R1-R3 三轮 raw transcript（含三家完整推理过程）建议归档到 `docs/audits/2026-05-27-adr-0027-csdlas-r1-r3.md`（本 ADR ship 时配套生成）。

---

## 12. 相关的项目记忆

- ADR 0024（second-brain-from-natural-conversation）—— CSDLAS L1 的哲学不变量来源；§3 AI-Native 原则是 CSDLAS C3' 在 multi-agent 拓扑层延伸的同源
- ADR 0025（sediment-meta-curator-subsystem）—— CSDLAS L1 的具体落地；§1.1 两条 lane 模型 + §1.3 git-lock race 是 CSDLAS C2' singleFlight 约束的现实依据
- ADR 0026（second-brain-decision-participation）—— CSDLAS L1→L2 共生接口的具体落地；§3.4 回声室断路器是 CSDLAS §8 代价 9 的现有缓解
- ADR 0009（multi-agent-dispatch）—— CSDLAS L2 的基础设施依赖；dispatch_agent / dispatch_parallel API 是 L2 当前的雏形
- ADR 0014（abrain-as-personal-brain）—— CSDLAS stigmergic substrate 的物理实现（abrain 七区 + git）
- ADR 0020（abrain-auto-sync-to-remote）—— CSDLAS C6 causal trace 跨设备同步的依赖
- `r10-cross-model-audit-definitions-and-liveness-blind-spots-for-adrs-0025-0026` (pattern) —— CSDLAS R1-R3 评审方法论的同源；都是跨 provider 多模型审计
- `adr-pipeline-liveness-checks-before-implementation` (maxim) —— CSDLAS §8 代价表 + §9 走偏信号是该 maxim 的延伸
- `prefer-prompt-engineering-over-mechanical-guards` (maxim) —— CSDLAS C3' 认知层 prompt-native 的同源
- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim) —— 同上
