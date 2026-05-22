# ADR 0024 — 隐身自治的第二大脑：靠自然对话学习和纠错

- **状态**：**已接受（R7 修订版，2026-05-22）**。这是一份**定方向用的总框架文档**——用户拐弯定下来产品哲学之后留下的总边界，后面所有面向用户的设计都要受它约束。具体怎么实现推迟到 ADR 0025（meta-curator 子系统）。

  - **R6 内部修订（2026-05-21）**：用户在元层面突然换角度看问题，发现前面 R1-R5 五轮多模型评审在中立提问 + 5 层自检下，**评审本能地还是往加各种检查关卡 / 字段定义 / 阈值数字 / 测试拦截的方向走**——这跟 ADR 0016 / 0018 和 pi-astack 早就沉淀的 maxim `prefer-prompt-engineering-over-mechanical-guards`（"优先用 prompt 工程，不要靠机械护栏"）正面冲突。R6 据此把 §4 五条 capability（能力点）全部从"加 schema 加关卡加指标加测试"的形态重写为 prompt 工程形态；新增 §4.2 AI-Native 设计原则；把 §5.7 INV-R13 那条"准确率低于 80% 就阻断"的硬关卡删了，降为仅供参考的指标；§6 全部 smoke 测试从"靠准确率数字过关"改为"靠读 AI 推理过程能不能看懂错在哪"；新增 §10 第 6 条 walkback 信号 / §3.2 黑名单里"用机械门替代 prompt 工程"那一行 / §11 加 R6 评审快照引用。评审过程的快照详见 [docs/audits/2026-05-21-adr-0024-multi-llm-r1-r6.md](../audits/2026-05-21-adr-0024-multi-llm-r1-r6.md)。

  - **R7 修订（2026-05-22）**：R6 改完之后第一次独立评审（三家顶尖大模型在 Layer F 硬约束下并行）。结论是方向对了，但 §4.3 几条 capability 的 prompt 设计还停在"想法草稿"阶段——三家给了五条共识改动：(1) classifier 必须按"先引用原话 → 找反证 → 才下结论"的顺序写，不允许先决定再倒回来编理由；(2) 判断"这条记忆真有用"的工作改由当时正在干活那个 LLM 第一人称交代，不再让事后的 curator 旁观猜测；(3) 那个定期反思的 aggregator 角色翻转成"持怀疑态度的史官"，默认"没发现就是成功"，不再隐含"应该找东西"的产出激励；(4) 双 AI 互相审查必须**真的拆成两次独立 API 调用**，一次调用里假装互相不看见对方推理不可信；(5) §6 所有 smoke 测试从"作者读 AI 推理过程"重写为机器自动跑的三层结构。本次修订把这五条落到 §4.2 / §4.3 / §6 / §10。**重要的元层验证**：三家在硬注入 Layer F 之后产出的 21 条建议**无一**落入机械门形态，第一次实证 audit §9.2 提议的第 6 层自检能纠正"人类反馈强化学习训练带出来的、本能加机械门"的偏置。评审过程的快照详见 [docs/audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md](../audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md)。

- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md)（七区 abrain 基础架构；其中 invariant #5 vault 明确授权是本 ADR 唯一例外）、[ADR 0016](0016-sediment-as-llm-curator.md)（sediment 当 LLM curator 这条哲学是本 ADR 的落地载体）、[ADR 0018](0018-sediment-curator-defense-layers.md)（之前删机械护栏的先例）、[ADR 0020](0020-abrain-auto-sync-to-remote.md)（跨设备一致传播是设计目标不是 bug）、[ADR 0023 R5](0023-session-start-rule-injection.md)（rules 区 + 第二大脑的心智模型）

- **部分取代**：
  - [ADR 0021](0021-lane-g-identity-skills-habits-writer.md) §D4 `/about-me` 命令和 `MEMORY-ABOUT-ME:` 围栏当作主要入口
  - [ADR 0023 R4](0023-session-start-rule-injection.md) §D6.2 `/rule veto`、§4.8 INV-R8、§4.9 INV-R9、§D6.3 `MEMORY-RULE:` 围栏当作主要入口
  - [ADR 0016](0016-sediment-as-llm-curator.md) sediment 月度手动 self-improve 工作流（改为定时任务自动跑）

- **被引用**：ADR 0024 接受之后**下一个 PR 必须交付**反向 patch 上面这些 ADR（详见 §5）；ADR 0025（meta-curator 子系统）会基于本 ADR 四条 invariant + §4.2 AI-Native 设计原则起草

- **触发**：演进轨迹详见 §1.1。当前框架是用户两层调整方向叠加而成：(1) R4→R5 用户重新定义角色（用户从"被观察的被动主体"变成"任务里一直主动的主体"），加入 INV-ACTIVE-CORRECTION（"主动纠错通道"）；(2) R5→R6 用户元层重新定义（机械门 → prompt 工程），把所有 capability 从"靠护栏防错"的形态改成"靠 AI 推理防错"的形态。

---

## 1. 背景与演进轨迹

### 1.1 演进轨迹（一表说清）

| Redirect | 影响层级 | 产物 |
|---|---|---|
| ADR 0023 R1→R2 | 入口层 | 删 `/rule add` |
| ADR 0023 R2→R3 | 单 invariant 层 | trust provenance 重写 |
| ADR 0023 R3→R4 | 产品 framing 层 | 第二大脑威胁模型 |
| **本 ADR R0→R5** | 产品哲学层 | 用户角色：maintainer → observed subject（in-task active）。3 → 4 条 invariant，新增 INV-ACTIVE-CORRECTION |
| **本 ADR R5→R6**（同日内部修订） | derisk 范式层 | 机械门 → prompt engineering。删除 INV-R13 80% gate / 全部 fixture-accuracy smoke / 全部 schema-driven state machine derisk path，改为 reasoning trace + self-validation prompt 路径 |
| **本 ADR R6→R7**（次日，2026-05-22） | prompt 落地层 | R6 把战场移到推理层后首次独立 review。结论：方向对、§4.3 prompt 细节不够。落地：classifier 用 evidence-first 6 步骨架；outcome 改原始会话 LLM 第一人称自报；aggregator 改怀疑论史官；multi-view 真 blind 两次调用；§6 smoke 三层重写。同时实证 Layer F self-check 能校正 RLHF 机械主义偏置（21/21 PE-form vs R1-R5 11/11 mechanical-form）|

### 1.2 当前 framing：用户作为 task 内 active subject

**消除的**：用户做"管理大脑"的元工作（veto / review / digest / approve / 主动声明身份 / 主动跑 self-improve workflow / 主动 audit classifier accuracy 等）。

**保留的**：
- 用户与 pi 的自然 task-oriented 协作（主要观察 surface）
- 用户在 task 中主动 push back（"以后用 X" / "你怎么记成 Y 了"）—— **核心 ground truth 通道**，与 task instruction 同构

类比：ChatGPT memory feature 隐含的 vision，但 OpenAI 在 trust/safety/UX/cost 后选择保留 explicit review。pi-astack 选择 default invisible + opt-in audit——**不是因为 OpenAI 选错了**，是因为 target user（pi power-dev）不同，task surface 密度高，implicit + active correction 信号充沛足以 dampen noise floor。

### 1.3 R6 AI-Native 设计原则（核心方法论约束）

R6 元层 reframe 揭示了一个 multi-LLM review pipeline 的 RLHF 训练偏置：T0 model 在"软件工程审计"任务中浸泡过的 derisk vocabulary 偏向**机械工程**（加 hash / 加 schema / 加 metric / 加 smoke / 加 threshold），而 ADR 0016 / 0018 / pi-astack maxim 早已确立**信任 LLM curator + prompt engineering > mechanical guards** 的设计哲学。R1-R5 review 在 balanced framing + 5 层 self-check 下仍然 fall back 机械门方向（11/11 derisk path 都是机械门）。

R6 据此把以下原则升级为 ADR 0024 的**显式方法论约束**：

> **任何 capability 的 derisk path 主路径必须是 prompt engineering（context injection + reasoning guidance + LLM self-validation），不能是 mechanical guard（schema / gate / TTL / hash / threshold / smoke-as-block）。机械工程仍允许作为 fallback / 基础设施层（git / filesystem / sync），但不能作为 LLM 行为层的主 derisk 手段。**

这条原则适用于：
- §4 全部 capability 设计
- §6 全部 smoke 设计
- ADR 0025 后续详细设计
- ADR 0026+ 任何引用 ADR 0024 的下游 ADR

下游 reviewer / 实施者发现自己提出的 derisk path 是 "加 X gate / 加 X schema / 加 X smoke" 时，**必须先 self-check**："这条能不能改为给 LLM 注入 context + 引导 reasoning？" 不能改为 prompt engineering 路径才允许走机械路径，且需在该 capability 的设计文档中显式 justify。

---

## 2. 四条 Hard Invariant

本 ADR 是 framing ADR，四条 invariant 是后续所有 user-facing 设计的总约束。typing / 边界细节见对应 §4 capability。

### INV-INVISIBILITY（隐身性）

> 第二大脑借助 pi 主会话与用户协作时，**用户不应感受到"管理大脑"这件事**。所有大脑内部 lifecycle event（create / update / merge / archive / supersede / delete）**默认完全静默**。用户与 pi 的自然交互就是大脑的观察 surface，无需独立 UI 或元操作。

**唯一例外**：[ADR 0014 invariant #5](0014-abrain-as-personal-brain.md) vault 明确同意——这是对**数据流动**的同意，不是对**大脑学习**的同意，性质不同。

### INV-AUTONOMY（自治性）

> 第二大脑通过观察**用户与 pi 的自然交互**完成学习/纠错/演进。"用户不参与"精确指**不需要用户做专门为维护大脑而存在的动作**（veto / review / digest / approve / manual sync）；不指"用户在 task 中不说话"——task 内 active correction 是合法 ground truth 路径（详 INV-ACTIVE-CORRECTION）。即使用户一个月不主动 review 元 UI，大脑也应越来越准。

### INV-IMPLICIT-GROUND-TRUTH（隐式 Ground Truth）

> 所有 ground truth 来自用户与 pi 的自然交互——**每一次输入、决定、接受/修改/拒绝 LLM 输出、沉默、跟进、主动 correction**。"隐式"指**信号采集方式**（不靠元 UI），**不指用户被动**。active correction 是优先级最高的 implicit signal 子类。

### INV-ACTIVE-CORRECTION（主动纠错通道）

> 用户在 task 中自然发生的主动 correction —— 例如 "以后用 X" / "忘掉那条" / "你怎么记成 Y 了" / "现在我更倾向 Z" —— 是第二大脑的**核心 ground truth 通道**，不是元工作。系统必须能识别此类发言并作为高 SNR semi-explicit signal 注入 sediment。

**与 INV-INVISIBILITY 关系**：发起方是系统 → 违反 INV-INVISIBILITY；发起方是用户在 task 自然语流中 → 是 INV-ACTIVE-CORRECTION 合法路径。
**与 INV-AUTONOMY 关系**：active correction 与 "用 React 不用 Vue" 这种 task instruction 同构，不增加认知负担。INV-AUTONOMY 的"用户不参与"边界精确指元工作，不指"用户在 task 中不说话"。

详细 typing / 误判方向 / ping-pong 处理见 §4.3.1。

---

## 3. 自然交互 vs 管理大脑：明确边界

### 3.1 ✅ 自然交互（OK — 是大脑的观察 surface）

| 场景 | 性质 |
|---|---|
| 用户与 LLM 普通 task-oriented 对话 | 主要观察源 |
| 用户接受 / 修改 / 拒绝 LLM 输出 | 隐式 outcome signal |
| 用户在 task 中说 "以后用 X" / "忘掉那条" / "你怎么记成 Y 了" / "现在我更倾向 Z" | **★ active-correction signal**（INV-ACTIVE-CORRECTION 主通道） |
| LLM 调 `prompt_user` 问 task-related 具体决策（"React Router v6 还是 v7?"） | LLM 服务于当前 task |
| `vault_release` 高 stake 数据明确授权 | INV-INVISIBILITY 唯一例外（ADR 0014 #5） |
| 用户的代码 commit / 工作 pattern / 选择 / 沉默 / 抱怨 | 全部隐式 signal |
| `dispatch_agent` / `dispatch_parallel` 分派子任务 | task 协作 |
| 用户 query 大脑（"你怎么知道我喜欢 X?"）→ LLM 回答 | 用户主动 query OK，LLM 应答即可，**不引导用户去"管理"** |

### 3.2 ❌ 反模式（必须删除/避免）

两类反模式：(a) 把"管理大脑"的元工作 push 给用户，(b) 用机械工程替代 prompt engineering。

| 反模式 | 类别 | 违反 |
|---|---|---|
| `ui.notify` "我学到了 X" | 元工作 push | INV-INVISIBILITY |
| `/rule veto <slug>` 让用户告诉大脑刚才那条 rule 不对 | 元工作 push | INV-INVISIBILITY + INV-IMPLICIT-GROUND-TRUTH |
| 学习 digest "本周大脑学了 5 条" | 元工作 push | INV-INVISIBILITY |
| LLM 用 `prompt_user` 问"我要把这个沉淀为 rule 吗？" | 元工作 push | INV-INVISIBILITY（伪装成 task 决策） |
| `MEMORY-RULE:` / `MEMORY-ABOUT-ME:` fence 让用户手动注入 | 元工作 push | INV-AUTONOMY |
| `/rule add` / `/about-me` slash 让用户主动声明 | 元工作 push | INV-AUTONOMY |
| 月度 sediment self-improve workflow 要用户主动跑 | 元工作 push | INV-AUTONOMY |
| `/brain health` 自动 dashboard 让用户检视 | 元工作 push | INV-INVISIBILITY |
| **用机械 gate 替代 prompt engineering 作为 LLM 行为层主 derisk**（如 classifier 准确率 < N% 阻断写入、schema-driven state machine 处理 attribution、cluster similarity threshold 触发 ping-pong） | **机械主义 derisk** | **§1.3 AI-Native 原则** |
| **fixture-accuracy smoke 作为 ship-block gate**（如"30 case ≥ 80% 才放行"）| **机械主义 derisk** | **§1.3 AI-Native 原则** |
| **预定义 enum schema** 替代 LLM free-text reasoning（如 scope vector enum / TTL state machine） | **机械主义 derisk** | **§1.3 AI-Native 原则** |

### 3.3 灰色地带处理原则

| 场景 | 处理 |
|---|---|
| classifier 不确定 | **不能**问用户。**应该** defer + 写入 staging（status=provisional），等下次自然对话产生证据后自动 resolve |
| 高 stake op（confidence ≥ 8 create / always tier promote / archive） | **不能**问用户。**应该** multi-view verification（独立 reviewer LLM 二次确认）；分歧 → defer 不 commit |
| 错误传播跨设备 | INV-AUTONOMY 显式接受此代价（详 §8） |
| 用户主动 query 大脑 | LLM 应答；可自然说"我记得之前你提到过 X，我可能学错了" 但不暴露 entry slug / sediment internal |
| sediment 检测到矛盾 | **不能**让用户裁决。**应该**默认 prefer newer evidence，旧 entry 自动 supersede |
| Power-user 主动看大脑状态 | `/rule list` `/abrain status` 等保留作为**纯诊断入口**，**不**在 quickstart / `/help` 推广 |
| 用户在 task 中说 "以后用 X" / "忘掉那条" / "你怎么记错了" | classifier **必须**识别为 active-correction signal。三种语义需区分：durable / task-local / debug。不确定时偏向 task-local 避免污染；同一 correction 在 N session 内重复 ≥ 2 次时自动升级为 durable。详 §4.3.1 |

---

## 4. Sediment Meta-Curator Subsystem 设计（capability 层）

本 ADR 只列 capability 清单。详细机制设计推迟到 ADR 0025。

### 4.1 从 write-only loop 到 active reflection agent

**当前 sediment（write-only）**：
```
agent_end → 看 window → curator op 决定 → writer 落盘 → 完
```

**本 ADR 要求的 active reflection agent**：
```
agent_end → 看 window → curator op (含 multi-view verification) → writer 落盘
       ↘ outcome signal collection（接受/修改/拒绝/沉默 + active correction）
                ↓
        cross-session pattern aggregator (cron-based, LLM-reasoning driven)
                ↓
        hypothesis 写入 staging
                ↓
        next session 自然 resolve 或自动 archive
                ↓
        classifier prompt evolution (基于 LLM 对 reasoning trace 的 self-review)
                ↓
        silent archive + rollback window
```

### 4.2 AI-Native 设计原则（§1.3 在 capability 层的具体形态）

R6 把 §1.3 方法论约束落到 capability 设计层面的具体表现：

| 维度 | 机械主义形态（禁止作为主路径） | AI-Native 形态（要求） |
|---|---|---|
| classifier 准确性保证 | fixture-accuracy gate / holdout threshold | classifier 输出 (a) 分类结果 (b) reasoning chain (c) 自评 confidence (d) "如果错了最可能错在哪个方向" self-critique，下游 LLM 在 reasoning trace 上自然 reason about correctness |
| attribution 模糊处理 | cluster similarity threshold + TTL state machine | 写入 staging 时用**自然语言假设描述**，下次 sediment 看到类似 utterance 时让 LLM 直接读 staging + 当前 utterance 推断"是不是同一件事" |
| scope 边界 | project/persona/device enum schema | classifier 输出**自然语言 scope description**（"适用于当前 React 项目，可能扩展到所有 frontend project；不确定是否跨设备"），下游 LLM 召回时读 free-text 自己判断 |
| outcome attribution | citation_count metric + Goodhart 风险 | LLM 读完整 session 上下文判断 entry 是否真的影响了 LLM 行为（而非仅看 slug 是否出现在 tool_result） |
| classifier 迭代 | 月度 prompt diff job + multi-LLM audit gate | dogfood 中作者读 classifier reasoning trace（power-user diagnostic）发现 systematic blind spot → 改 prompt（不是加 gate） |
| writer fidelity | 外部 writer fidelity smoke | writer prompt 内化 self-validation："写入 entry 前重读用户原话，自问 fidelity，不确定即 staging" |
| source contamination 防护 | message provenance gate / role pre-filter | classifier prompt 显式注入 role 标记（user / assistant / tool output / 用户粘贴的引用文本），给 LLM 充分上下文相信它能区分 |
| 内生反馈环检测 | aggregator metric monitoring | cross-session aggregator prompt 加一句："你审视的 correction 链条本身可能由 sediment 之前 entry 触发——判断 trend 时考虑是用户独立偏好还是 sediment 回声" |
| audit data 可信度 | SHA256 hash chain | 基础设施层（git + filesystem）已经处理持久化；LLM 在异常情况（entry 数量突变、citation pattern 反常）下 reason about it 即可 |
| 用户追问"为什么一直用 X"（R7 新增）| 暴露 entry slug / 拒答 policy gate | 主会话 prompt 允许 LLM 自然说"我记得你之前提到过相关偏好，可能学错了，让我调整"——诚实承认有过这样的输入是 invariant 内的，不是泄漏。但不暴露具体 slug / sediment 内部细节 |
| reasoning_trace 跨 prompt 版本兼容（R7 新增）| schema migration script + version validation gate | 写入时附 prompt 版本号 + 当前语义的 1-3 句自然语言说明。新 prompt 读旧 trace 时被显式告知："这段 trace 是旧版 prompt 写的，术语含义可能不同，提取里面的 quote 和 uncertainty 即可，别套现在的 label" |
| 跨基座 reasoning 风格对齐（R7 新增，详 §4.3.4）| 强制 JSON schema / word count cap | 所有 LLM-facing prompt 头部固定一段 reasoning normalization preamble："你的推理必须按 quote → claim → alternative → uncertainty → resolving evidence 顺序展开"。约定形式但不 schema 校验——不同基座写出来风格仍有差异，但回到约定结构 |

### 4.3 六条核心 capability

#### 4.3.1 Active-correction Signal Recognition（前置依赖，R2 必交付）

**目标**：让 unified classifier（ADR 0023 D4）能稳定识别 task-内 active correction，作为 INV-ACTIVE-CORRECTION 的工程载体。是 vision 落地的前置 capability——其它五条 capability 在 INV-ACTIVE-CORRECTION 工程载体未 ship 前都是空声明。

**Prompt-engineering 路径**（详细 prompt 设计在 ADR 0025）：

- **完整 session 转录 + role 标记**注入 classifier prompt（含 user / assistant / tool output / 用户粘贴引用文本的明确标识），让 classifier 自己区分用户原话 vs assistant echo vs 第三方引用。
- **三类语义 typing**（自由 description 而非 enum）：
  - **durable preference correction**（"以后用 X" / "我现在更喜欢 Y" / "忘掉那条"）→ 写入 sediment，writer 操作（create/update/supersede entry）
  - **task-local override**（"这个项目兼容性原因这次用 Z"）→ 不写入 sediment，仅作为当前 task instruction
  - **debug / exploration**（"先试试 W 看能不能复现"）→ 不写入 sediment
- **classifier 输出 reasoning trace**：每次 typing 同时输出分类结果 + reasoning chain + 自评 confidence + scope 自然语言描述 + "如果错了最可能错在哪个方向" self-critique。下游 LLM 在 reasoning trace 上自然 reason about correctness。
- **attribution 处理**：classifier 尝试定位被 correction 的 entry（基于 slug / trigger_phrase / 语义相似度）。失败时写入 staging 的不是 stub，是**自然语言假设描述**（"用户在 session N 说了 'X'，我没找到对应 entry——可能是 (a) 还没沉淀过 (b) 召回失败 (c) 补充新信息"）。下次 sediment 看到类似 utterance 时让 LLM 直接读 staging + 当前 utterance 推断"是不是同一件事"。
- **ping-pong detection**：同一 correction 在 N session 内重复 ≥ 2 次 → 升级为 durable（LLM 跨 session 语义联想判断，不是 mechanical cluster threshold）。
- **误判方向**：不确定时偏向 task-local（保守，避免污染 durable preference）。

**R7 修订（2026-05-22）：classifier 必须按 evidence → 反证 → 结论顺序输出，不是先决定再编理由**

R7 review 三家共识：上面写的 "输出 typing + reasoning + confidence + self-critique" 是把字段并列摆放，允许 LLM 先猜出答案再倒回来编一段合理推理。看起来 reasoning trace 很完整，但其实是事后找补——这是 R6 把战场移到推理层后第一个浮现的新坑（reasoning trace 看起来 plausible 但与真实决策过程脱节）。

强制按下面 6 步顺序写，prompt 才能真的逼 LLM 思考（而不是表演思考）：

```
Step 1 — Quote the user's exact words (no paraphrasing). Include ≥3 lines
         of surrounding context (what was said before and after).

Step 2 — For EACH of {durable, task-local, debug}, write the strongest
         1-sentence case FOR it, using only step-1 quotes.
         You MUST give all three a real case — not a strawman.

Step 3 — For the reading you currently lean toward, find the single
         observation in this transcript that would most undermine it.
         If you cannot find one, say so — that itself is a signal your
         lean may be premature.

Step 4 — If step 3 produced a real disconfirmer, downgrade by one tier
         (durable → task-local; task-local → debug).

Step 5 — NOW commit: typing + natural-language scope description + confidence.

Step 6 — Self-critique: "If I am wrong, the most likely error direction is
         ___ because ___" (must reference a concrete step-1 quote, not a
         generic phrase like 'context might be different').
```

关键设计：Step 2 强制对三类都给真理由（不能把不选的那两类写成稻草人）；Step 3 强制找反证（找不到本身是信号）；Step 6 的自我批评必须 anchor 到具体引用——不允许说"如果情况不同的话可能错"这种万能套话。

详细 prompt 设计仍在 ADR 0025，但这 6 步骨架本身是 R7 后的硬要求，不是建议。

**与现有 ADR 0023 R5 patch §5.1 unified classifier 的关系**：在同一 classifier prompt 中扩展三类 typing + reasoning trace + scope description 输出，不新增独立 classifier。

#### 4.3.2 Outcome → Entry Feedback Edge

**目标**：让 entry 知道自己是否"真的被用上了 / 用了之后用户是否满意"。

**Prompt-engineering 路径**：

- entry frontmatter 新字段：`last_cited_at` / `outcome_history[]`（最近 N 次 outcome 自然语言摘要 + reasoning trace，**不是**单一 citation_count metric）。
- `tool_result` / `message_end` hook 把"用户接受/修改/拒绝" + "LLM 当时引用了哪些 entry"作为 session 上下文片段交给 sediment curator，curator LLM 在 agent_end 判断 entry 是否真的影响了 LLM 行为（避免 citation_count proxy 的 confounder）。
- sediment 综合 outcome history 判断是否调整 entry confidence / status——**调整理由作为自然语言 reasoning 记入 entry timeline**，而非单一 metric。

**R7 修订（2026-05-22）：影响判断改由原始会话 LLM 第一人称自报，curator 只汇总不归因**

R7 review 三家共识 + DeepSeek 独家洞见：让事后的 curator LLM 判断 "这条 entry 是不是真的影响了行为" 必然 over-claim——它看到 entry 出现在 context 里就会倾向报告 "用上了"，因为没有反事实 baseline 可对照。真正知道自己用没用上的是**当时正在干活那个 LLM 本人**。

修订设计：在 agent_end 触发时，先注入一段 outcome self-report prompt 给原始 session LLM，让它自己交代：

```
At the end of this session, for EACH entry that was in your injected
context (always/listed rules, or memory_search results you retrieved):

For entries you consciously used:
  Q1: Did this entry influence a SPECIFIC decision or action you took?
      If YES: which decision? Quote the action/output where it mattered.
      If NO: why was it in context but not used?

  Q2 (counterfactual): If this entry had NOT been in your context, would
      you have made a DIFFERENT decision?
      If YES: what would you have done differently?
      If NO: "this entry was consistent with my independent reasoning
             but did not change my behavior" → mark as CONFIRMATORY,
             not DECISIVE.

For entries listed but not cited:
  Q3: Why did you not use this entry? Irrelevant to session, forgotten,
      or overridden by other context?
```

只有当 LLM 能具体说出 counterfactual（"如果这条不在我会做 X，但有了它我做了 Y"）才能 claim DECISIVE 影响。说不出 counterfactual 默认是 CONFIRMATORY（顺路一致但没真起作用）或 RETRIEVED-UNUSED（被召回但没用）。

存进 `outcome_history[]` 的是这段第一人称自报，不是 curator 的事后归因。curator 仍然存在，但只做汇总（看 N 次 outcome 后是否调整 entry confidence），不做 attribution 判断本身。这样把信号采集点从"事后旁观猜测"前移到"当事 LLM 自报"，信噪比提升一个量级。

#### 4.3.3 Cross-session Pattern Aggregator

**目标**：识别慢漂移偏好（如 Yarn → pnpm 6 周渐变），sediment 当前 per-session 看不到。

**Prompt-engineering 路径**：

- 独立于 agent_end 的 cron-based background job（daily / weekly / monthly）。
- 给 aggregator LLM 注入**自然语言 timeline summary**（不是 raw audit.jsonl）：最近 30/90 天 entry 引用频率变化 + 用户在 task 中的 push back 事件摘要 + 长尾未被任何 session 触发的 entry 清单。
- aggregator prompt 显式引导：
  - "你审视的 correction 链条本身可能由 sediment 之前 entry 触发——判断 trend 时考虑是用户独立偏好还是 sediment 回声？"
  - "以下 entry 最近 30 天未被任何 session 触发，基于你对用户日常 task pattern 的了解，判断每条现在还成立的概率，是否需要主动 surface 给用户验证。"
- 输出：跨 session candidate hypothesis 写入 staging，等待 next session 自然 resolve（不通知用户）。
- 30 天无确认证据 → 自动 archive（详 §4.3.6）。

**R7 修订（2026-05-22）：aggregator 角色从"找规律的顾问"翻转为"持怀疑态度的史官"**

R7 review 三家共识：上面的 prompt 隐含"你的任务是找出值得 surface 的东西"的产出激励——LLM 被训练成 helpful，看到 30 天数据就会**为了显得认真而硬找规律**，哪怕没有也要编一个出来（典型的 sycophancy）。

修订设计：在 aggregator prompt 里把角色和成功定义都翻转：

```
You are a skeptical historian of the user's work patterns.
You are NOT rewarded for finding a hypothesis.
Most weekly runs of this job should produce NO candidate hypothesis.
Output "no candidate, no action — timeline within normal variance" is
a SUCCESSFUL run, not a lazy one.

Before proposing ANY hypothesis H, you must:

  (1) Write a paragraph "Reasons NOT to change the brain":
      - Could this be normal task distribution noise?
      - Could this be caused by an existing sediment entry shaping
        the assistant's behavior (回声室)?
      - Did the user merely accept a workable default without expressing
        preference?
      - Could the evidence be domain-local rather than durable?

  (2) Falsifiability check: write down ONE specific future observation
      that would falsify H within ~2 weeks. If you cannot name a concrete
      falsifier ("user runs `npm install` while X is set" / "user
      explicitly chooses Y over Z"), H is not concrete enough — discard.

  (3) Sycophancy self-check: "Would I still propose this if nobody
      praised me for finding a pattern?" If no → discard.
```

把"提建议"从默认行为变成需要付出额外论证成本的非默认行为——这样多数 cycle 输出空也算成功。

**R7 同时新增 "Classifier Health Meta-Check" 段**（DeepSeek 独家发现的 silent degradation 防御）：aggregator 每次跑完正常 trend detection 后，再追加一段：

```
# Classifier Health Meta-Check (advisory, no blocking)

Review the last 50 classifier reasoning traces from recent sessions.
For each, evaluate:

Q1. Does the trace quote a specific user utterance? [YES / NO]
Q2. Does the trace explicitly consider at least one alternative
    interpretation before deciding? [YES / NO]
Q3. Is the self-critique concrete (names a specific scenario that
    would change the decision) rather than generic boilerplate?
    [CONCRETE / GENERIC]

Aggregate: quote rate __/50, alternative rate __/50, concrete
self-critique rate __/50.

If ANY rate < 40%: append "⚠️ Classifier reasoning quality has
   declined in dimension {weakest}. Representative weak traces
   appended below. Recommend author review classifier prompt."
If any rate declined ≥15pp vs previous cycle: append
   "⚠️ Significant regression in {dimension} since last cycle."
If all rates ≥ 70%: "Classifier health: NORMAL."

This is ADVISORY. It does not block any operation. It leaves a
warning the author will see when they next read aggregator output.
```

目的：作者三个月不管系统的场景下，系统能自我感知"我的推理质量在退化"并留下 flag。修复仍是作者的工作，但发现不再依赖作者主动 diagnostic。

#### 4.3.4 Multi-view Verification

**目标**：避免单 curator LLM 的盲区导致 high-stake op 出错。

**Prompt-engineering 路径**：

- 触发条件：`confidence ≥ 8` 的 create / always tier promote / archive `confidence ≥ 8` entry / supersede / 跨 zone migration。
- 流程：proposer LLM 产 op proposal（含完整 reasoning trace）→ 独立 reviewer LLM **跨模型族**（如 GPT-5 ↔ Claude / DeepSeek，不是同 family 不同 prompt）二次确认。
- 分歧处理：reviewer 否决 → 该 op `defer`（进 staging）；reviewer 确认 → 走 writer 正常路径。
- 双方都输出**自然语言 reasoning**，分歧时 reasoning 本身作为后续 cross-session aggregator 的 input。
- **绝不**引入用户介入。

**已知局限**：跨模型族仍有 RLHF 训练相关性，multi-view 不能验证"用户真实意图"，只能拦截 schema/scope/zone 类工程错误。R6 接受此局限。

**R7 修订（2026-05-22）：reviewer 必须真 blind，必须两次独立 API 调用**

R7 review 三家共识：上面写的 "proposer 输出 reasoning → reviewer 二次确认" 没设计防 anchor 机制——reviewer 看到 proposer 的 reasoning 后会**不自觉跟着 proposer 的思路想**，跨模型族也救不了（RLHF 在 "审查同事提案" 任务上训练偏置就是 charitable interpretation，往同意方向漂）。

修订设计：reviewer 必须**两次独立 API 调用**：

```
Pass 1 (Blind — reviewer 完全不看 proposer reasoning):
  Context: 原始 session evidence (candidate entry, neighbor entries,
           session transcript excerpt). 完全不含 proposer 的判断和理由。
  Output:
    a) 你独立推荐的 op (create/update/merge/...)
    b) 你的 confidence (0-10)
    c) 单条最关键的证据（quote 出来）
    d) 你自己推荐的最强反对论据

Pass 2 (After Pass 1 committed, separate API call):
  Context: + proposer's recommendation + proposer's reasoning trace
           + 你刚才 Pass 1 的输出
  Output:
    e) 同意 / 不同意 / 部分同意
    f) 如果不同意：找出你和 proposer 推理的具体分歧点，两边各引一句
    g) "你是否被 proposer 的 framing 拉动了？这种拉力本身是 anchor bias
       信号——只有当 proposer 真的指出了你 Pass 1 漏掉的具体证据时
       才修正你的判断，不要因为 proposer 听起来有道理就跟着改"
    h) 最终：CONFIRM proposer op / CONFIRM your Pass 1 op / DEFER
```

关键工程约束：**必须真的拆成两次 API 调用**。一次调用里假装 "先 blind 再 reveal" 不可信——LLM 会先 peek 到 Pass 2 内容再写 Pass 1。§8 已经接受 multi-view 成本翻倍，所以两次调用工程上没问题。

Phase 2 第 g 问是 Opus 的元认知补丁：让 LLM **承认 anchor 拉力存在**，比单纯说"独立思考"有效得多。

**附加规范（详 §4.2 R7 新增第三行）**：proposer / reviewer prompt 头部必须固定一段 reasoning normalization preamble，要求双方按 quote → claim → alternative → uncertainty → resolving evidence 顺序展开推理——这样 reviewer 在 Pass 2 比对 reasoning 时有可对比的结构，不会被跨基座的风格差异（Claude 偏哲学绕弯 / GPT 偏列条目 / DeepSeek 偏直接简短）误读为 reasoning quality 差异。

#### 4.3.5 Classifier Prompt Evolution（替代旧 "Auto-iteration Loop"）

**目标**：classifier prompt 随 dogfood 数据持续 refine——不是 LLM 自动改自己的 prompt（R6 删除月度 auto-iter cron），是基于真实 reasoning trace 的 prompt iteration。

**Prompt-engineering 路径**：

- classifier 每次 typing 输出 reasoning trace 保存在 audit.jsonl。
- 作者作为 power-user diagnostic（§3.3 允许）定期读 reasoning trace，发现 "LLM 在哪类 utterance 上 reasoning 不够清晰" / "systematic blind spot reproducible across N sessions"。
- 改 prompt（context + reasoning guidance），不加 gate。
- prompt 改动作为 ADR 0025 后续 iteration 的一部分，不是 ADR 0024 invariant 范围。

**与 R5 删除内容的对比**：R5 原 §4.2.4 "Classifier Auto-iteration Loop"（月度 cron 跑 self-improve 自动生成 v_{N+1} candidate + multi-LLM audit gate）在 R6 下被删除——这是典型的 closed-loop self-modification 机械路径，与 §1.3 AI-Native 原则冲突。作者人在 loop 中的 prompt iteration 不违反 INV-AUTONOMY（作者作为 power-user 主动 query 是 §3.3 灰色地带处理允许的）。

#### 4.3.6 Silent Archive + Rollback Window

**目标**：sediment 自动 archive 错了不要造成永久损失。

**Prompt-engineering 路径**：

- `status=archived` 是软删除，文件保留 N 天（建议 30）。
- N 天 silent window 内若 sediment 看到反证（用户在自然对话中提到该 entry 的内容 / cross-session aggregator 发现 trend 反转）→ 让 curator LLM **直接判断**该 entry 是否仍然有效（不是 mechanical reverse trigger）→ revert 为 active（不询问用户）。
- N 天后才走 `git rm`（hard archive）。
- Hard archive 仍可通过 git history 恢复，但不在 active 大脑中。

### 4.4 与现有 sediment 的关系

- 当前 sediment（reactive curator + writer）作为 meta-curator 的 sub-component。
- 新增 meta-curator subsystem 在 cron job / 独立 hook 中运行。
- 不破坏 sediment 单一 writer 原则（ADR 0014 invariant #1）：meta-curator 通过 sediment writer 完成所有写入。

---

## 5. 反向 Patch 历史 ADR 列表（R0 同 PR 必交付）

本 ADR Accepted 后的下一个 PR 必须完成以下 patch（patch 不在 PR 内 → ADR 0024 不算落地，doc-vs-code drift 是 pi-astack 标准 audit 必 P0 项）。

### 5.1 ADR 0023 R5/R6 patch

| 改动 | 类型 |
|---|---|
| 删 INV-R8 (Notify on promotion) | 删除 |
| 删 INV-R9 (Notify on lifecycle) | 删除 |
| 删 §D6.2 `/rule veto`（→ classifier 自动识别自然对话 correction，prompt 引导） | 删除 |
| 删 §D6.3 `MEMORY-RULE:` fence escape hatch | 删除 |
| 保留 §D6.2 `/rule list` `/rule explain` `/rule reload` 作为 power-user diagnostic | 保留 |
| §D5 RuleDraft 新字段：`last_cited_at` / `outcome_history[]`（自然语言摘要，不是 citation_count metric） | 新增 |
| §D5 RuleDraft 新字段：`active_correction_source: { speech_act, attribution_summary, ping_pong_count, reasoning_trace }`（reasoning_trace 自然语言，不是 mechanical fields） | 新增 |
| §D4 unified classifier **必须**能识别 active-correction speech act 三类语义 + 输出 reasoning trace（详 §4.3.1） | 新增硬要求 |
| §4 INV-R12 `auto-demote based on last_triggered_at` — **R6 修订**：不是 mechanical decay schedule，是 cross-session aggregator LLM 判断"该 entry 长期未被触发是因为过时还是因为用户没碰相关 domain" | 新增（R6 重写） |
| **R6 删除原 R5 INV-R13**（active-correction 准确率 < 80% gate）—— 不是 mechanical gate，改为 "classifier reasoning trace 中出现 systematic blind spot 时触发 §10 walkback" | 删除（R6） |
| §1.4 `ADR 0024 是 ADR 0023 的产品哲学总约束 + R6 AI-Native 设计原则；本 ADR 任何 user-facing 入口必须先通过 §3 边界检查` | 新增 |

ADR 0023 升级 R6 终版，R6 改动表新增：`R4 → R5: ADR 0024 reframe`，`R5 → R6: ADR 0024 R6 AI-Native reframe`。

### 5.2 ADR 0021 patch

| 改动 | 类型 |
|---|---|
| §D4 删 `/about-me` slash 作为 first-class 入口（保留代码作为 power-user diagnostic 隐性入口） | 降级 |
| §D4 删 `MEMORY-ABOUT-ME:` fence 作为 first-class 入口（保留 parser 作为 escape hatch） | 降级 |
| 改为：sediment 从自然对话识别 about-me 信号（与 ADR 0023 unified classifier 合并，扩 zone enum 含 identity/skills/habits） | 重定向 |
| Lane G G3 (aboutness classifier) 在 ADR 0023 R1 unified classifier 中自然涵盖 | 保持 |
| G4 (`/review-staging` slash + 30-day TTL) 重定位：staging review **不**由用户跑，meta-curator §4.3.3 + §4.3.6 自动处理 | 重定向 |
| G5 (region-aware ranking hint) 重定位为 meta-curator §4.3.2 outcome feedback 的下游能力 | 重定向 |

### 5.3 ADR 0017 patch

| 改动 | 类型 |
|---|---|
| `/abrain bind` 保留为 power-user 入口 | 保留 |
| 添加：sediment 在 active project 不明确时 `defer`（**不**prompt 用户），下次自然对话中识别 project context（用户提到的文件路径 / 项目名 / git remote）后自动 bind | 新增 |
| 仍保留 strict 三件套（manifest + registry + local-map）作为 identity 稳定性约束 | 保持 |

### 5.4 ADR 0016 patch

| 改动 | 类型 |
|---|---|
| `sediment self-improve` workflow 月度手动 → 不再是月度 cron 自动跑（R6 删除 §4.2.4 auto-iter），改为作者作为 power-user 不定期主动 trigger | 重定向（R6） |
| 输出不再是"给用户看的报告"，是"作者读 classifier reasoning trace 后改 prompt"的 power-user diagnostic 入口 | 重定向 |
| 保留 `/sediment self-improve` slash 作为 power-user 入口 | 保留 |

### 5.5 ADR 0020 patch

| 改动 | 类型 |
|---|---|
| `/abrain status` `/abrain sync` 保留 power-user 但**默认 silent** | 调整 |
| 跨设备冲突在 INV-AUTONOMY 下接受 eventual consistency（**不打扰用户**）。auto-merge 失败时记录 audit，**不**主动 prompt 用户 | 调整 |
| 用户主动 `/abrain sync` 时仍允许手动冲突 resolve | 保持 |

### 5.6 ADR 0014 / 0022 不需要 patch

- **ADR 0014 vault invariant #5**（vault 明确同意）是 INV-INVISIBILITY 唯一例外，本 ADR 已显式承认。
- **ADR 0022 `prompt_user`** 用于 task-related 具体决策，不用于"管理大脑"。本 ADR §3.2 加约束："**不得用 prompt_user 询问 sediment lifecycle 决策**"——该约束通过 sediment classifier prompt 引导实现（不是 schema validation 机械 gate），符合 §1.3 AI-Native 原则。

---

## 6. 不变量覆盖路径与 Smoke（AI-Native 形态）

R6 把 smoke 从 mechanical-accuracy gate 改为 reasoning-trace inspect-ability 验证——smoke 不再是 ship-block，是 diagnostic harness，作者读 smoke 输出判断 prompt 是否需要 iterate。

### 6.1 INV-INVISIBILITY 覆盖

**静态 grep anchor**：
- sediment writer 的 lifecycle path 不调用 `ui.notify`（vault 例外）
- meta-curator background job 不调用 `prompt_user` / `ui.notify` / `ui.confirm`
- 全 codebase grep 无 `archive_rule` / `update_rule` / `veto_rule` / `confirm_promotion` 等 LLM-facing 函数

**Smoke**：`smoke:invisibility-no-management-prompt` — 跑 30 个 sediment lifecycle scenario，验证 0 次 ui.notify（vault scenario 例外）+ 0 次 prompt_user 调用（task-related prompt_user 例外）。

### 6.2 INV-AUTONOMY 覆盖

**Smoke**：`smoke:autonomy-self-correction` — fixture 含 "sediment 写错 → 后续观察产生反证 → 自动 supersede" 序列。验证作者读 sediment reasoning trace 能 inspect 纠错路径（不验证"准确率 ≥ N%"——这是机械 gate）。

**Smoke**：`smoke:autonomy-cron-aggregator` — 模拟 30 天跨 session evidence，验证 cross-session pattern aggregator 输出 candidate hypothesis 自然语言描述清晰、reasoning 有迹可循。

### 6.3 INV-IMPLICIT-GROUND-TRUTH 覆盖

**Classifier prompt 约束**（绑定 ADR 0023 R6 patch §D4.3）：
- 不允许使用"user explicitly told us to remember"作为 promote **唯一**依据
- 隐式 signal（接受 / 修改 / pattern / 跨 session repetition）**必须**被识别为合法 ground truth
- 与 ADR 0023 R4 §D4.3 trust source 引导段不冲突

**Smoke**：`smoke:implicit-signal-recognition` — fixture 含 "用户多次接受 LLM 输出后自然形成 preference"，验证 sediment reasoning trace 中 explicit 提到 "这是 implicit pattern signal, not explicit instruction"——验证 classifier 心智模型对，而非 mechanical accuracy。

### 6.4 INV-ACTIVE-CORRECTION 覆盖

**Smoke**：`smoke:active-correction-reasoning-trace` — fixture 含 30 个 active-correction 三类语义场景（durable / task-local / debug）。验证 classifier 输出**完整 reasoning trace + self-critique + scope 自然语言描述**——作者读 trace 判断 classifier 心智模型是否对。**不是**"≥ N% 准确率" 机械 gate。

**Smoke**：`smoke:active-correction-attribution-staging` — fixture 含 "用户 correction 时未提 entry slug" 场景。验证 attribution 失败时写入 staging 的是**自然语言假设描述**（不是 stub），且下次 sediment 看到类似 utterance 时能基于 staging 描述做语义联想。

**Smoke**：`smoke:active-correction-ping-pong-natural` — fixture 含 "用户对同一类 correction 跨 session 重复" 场景。验证 ping-pong 升级是 LLM 跨 session 语义联想判断（reasoning trace 显式说明），不是 mechanical cluster threshold。

**Smoke**：`smoke:active-correction-conservative-bias` — fixture 含 classifier 不确定 case，验证默认偏向 task-local（reasoning trace 显式说明"不确定，保守偏 task-local 避免污染"）——显式接受 false negative 的代价换避免污染。

**Smoke**：`smoke:active-correction-source-provenance` — fixture 含 assistant echo / tool output / 用户粘贴第三方文本中的"以后用 X" / "forget that" 模式。验证 classifier reasoning trace 显式区分 role=user 原话 vs 其它来源，**只**把 role=user 的话作为 active correction 候选（U3 derisk）。

### 6.5 §1.3 AI-Native 原则覆盖（R6 新增）

**Smoke**：`smoke:ai-native-no-mechanical-gate` — 静态 grep + AST inspection，验证 §4.3 全部 capability 实施代码中：
- 无 fixture-accuracy ≥ N% 作为 ship-block / write-block 的硬 gate
- 无 schema-driven state machine（TTL / cluster threshold / similarity score）作为 attribution / typing / scope 主路径
- 无 SHA256 hash chain / cryptographic integrity 作为 audit.jsonl 主 derisk（git + filesystem 基础设施层例外）

存在的"机械 fallback"必须有 ADR-level justify 段落，否则 smoke fail。

### 6.6 R7 修订（2026-05-22）：smoke 从"作者读"重写为三层结构

R7 review 指出最锋利的问题：§6.2-§6.4 多数 smoke 的验证标准是"作者读 reasoning trace 判断 classifier 心智模型对不对"——**这不是 smoke，是手动审稿**。smoke 的定义是自动化回归测试。如果判断标准是"作者读后判断"，最终会重演 R1-R5 reviewer "看起来 plausible 就 pass" 同款疲劳。

修订设计：§6.2 / §6.4 全部 smoke 改为三层结构。以 `smoke:active-correction-reasoning-trace` 为例：

**Tier 1 — 自动化确定性 assertion（必过 100%，是结构完整性保证不是 ship-block）**

```
对 30 个 fixture 跑 classifier，机器自动检查（无需人眼）：

1. STRUCTURE: 输出包含所有必需字段（typing / reasoning_chain /
   confidence / scope_description / self_critique）。缺一即 fail。

2. QUOTE_DENSITY: reasoning_chain 含 ≥1 处来自 session 转录的
   一字不差的引用（exact text match，不是语义相似）。无引用 fail。

3. ALTERNATIVE_MENTION: reasoning_chain 明确提到 ≥1 个被考虑后
   被否决的 alternative interpretation。关键词检查
   ("alternative" / "could be" / "might be" / "if instead")。
   缺即 warning（不 fail，但记入 dashboard）。

4. SCOPE_DIMENSIONS: scope_description 覆盖 ≥2 个维度
   (project / persona / device / repo / org / all)。
   只覆盖 1 个或 0 个 fail。

5. SELF_CRITIQUE_CONCRETE: self_critique 不在 generic 黑名单里。
   fail 如果匹配：
   - "might be wrong if context is different"
   - "if I misinterpreted the user's intent"
   - "depends on more information"
   - 空或 < 20 字符

6. CONFIDENCE_SPREAD: 跨 30 fixture 的 confidence 至少跨 3 个不同档位
   （不是全部都 7-9）。否则说明 classifier 没在区分难易 case。
```

注：这些自动检查是结构属性，不是准确率 gate——它们验证的是"reasoning trace 是否符合 prompt 要求的形式"，不是"分类对不对"。结构对了不代表语义对，所以才有 Tier 2。

**Tier 2 — LLM-as-judge advisory（独立第二 LLM 评，结果作参考不阻断）**

```
从 30 fixture 中随机选 5 个，让另一个独立 LLM（跨 provider，避免同型偏置）
读 reasoning_chain，回答：

7. REASONING_COHERENCE: "推理过程逻辑上支持最终的 typing 结论吗？"
   汇总 agreement rate。
8. SELF_CRITIQUE_QUALITY: "self_critique 指出的错误方向是 genuinely
   plausible 的吗？还是空话？" 汇总 concrete rate。

输出是百分比 + 几个有代表性的 dissent case。作者据此判断是否需要改 prompt。
不是 ship-block，不阻断任何流程。
```

**Tier 3 — Informational（仅信息，由作者决定怎么用）**

```
对带有 expected label 的 fixture（如果有），列出 classifier 实际 typing
和 expected 的差异，side-by-side 给作者看。带一句话提示：
"5/30 fixture 上 classifier 和 expected 不一致——你判断：是 classifier
prompt 需要改，还是这些 fixture 的 expected label 本身定错了？"

不阻断任何流程。这条 tier 替代了被删除的 fixture-accuracy gate——
保留 expected label 作为对照信息，但判断权交给作者，不是机械比对。
```

**补充：counterfactual-pair smoke（Opus / GPT 共同提出）**

```
对每个 fixture 跑两遍：
  Run 1: 正常 classify
  Run 2: 加 "argue the strongest case that this should be typed as
         the OPPOSITE of what you would naturally pick" 的 devil's
         advocate prompt

作者读 pair 的 asymmetry：
  - 如果 Run 1 和 Run 2 同等 plausible → prompt 在此类没有 distinguishing
    power，需要 sharper distinguisher
  - 如果 Run 2 明显牵强 → Run 1 typing 站得住脚
```

**适用范围**：§6.2 `smoke:autonomy-self-correction` / `smoke:autonomy-cron-aggregator`、§6.4 全部 active-correction smoke 都按这套 Tier 1/2/3 + counterfactual-pair 结构重写。具体每个 smoke 的 assertion 清单在 ADR 0025。这条修订把 smoke 从 "作者逐条审稿（O(n) 工作量）" 改为 "机器跑、机器给报告，作者看 dashboard（O(1) 工作量）"，把 smoke 本身从 inspection fatigue 风险中解放出来。

---

## 7. 实施 Phase

### R0 — 反向 patch 历史 ADR（同 PR 必交付，无新代码）

§5 全部 patch + docs sync（current-state / roadmap / brain-redesign-spec / architecture）。约 2-3 天工作量，纯文档。**R0 完成前 ADR 0024 不算 Accepted**，所有引用 ADR 0024 的下游设计 hold。

### R1 — ADR 0025 起草（meta-curator subsystem 详细设计）

本 ADR 只列 capability。R1 独立 ADR 详细设计各 §4.3.x 的 prompt + context 设计。**ADR 0025 必须显式承诺 §1.3 AI-Native 原则**——不允许在 ADR 0025 中加 schema / TTL / threshold / smoke-as-block 作为主 derisk 手段。

R1 起草后走 multi-LLM xhigh audit ≥ 2 轮 P0 收敛。

### R2 — Phase 1 ship（含前置依赖）

**前置依赖（R2 同 PR 必交付）**：
- §4.3.1 active-correction signal recognition minimum viable
- §6.4 全部 INV-ACTIVE-CORRECTION smoke
- §6.5 AI-Native 原则 smoke

**Phase 1 主功能**：
- §4.3.2 outcome feedback edge（entry frontmatter `last_cited_at` / `outcome_history[]`）
- `tool_result` / `message_end` hook 接入 session context 交给 curator LLM
- INV-R12 (auto-demote) 在 ADR 0023 R6 patch 中以 LLM 判断形态写入（不是 mechanical decay schedule）

工程量：~400-700 LOC（writer + injector 字段维护 + hook 接入 + classifier prompt 扩展）+ 8 个新 smoke

### R3 — Phase 2: Cross-session aggregator

§4.3.3 cron-based proactive observation，staging → next-session resolve loop。工程量 ~500-800 LOC。

### R4 — Phase 3: Multi-view verification

§4.3.4 proposer + reviewer 跨模型族双 LLM gate。工程量 ~300-500 LOC。

### R5 — Phase 4: Classifier prompt evolution

§4.3.5 power-user prompt iteration tooling（不是月度自动 cron）。工程量 ~200-400 LOC（reasoning trace viewer + prompt diff tooling）。

### R6 — Phase 5: Silent archive + rollback window

§4.3.6 rollback window 状态管理 + reverse trigger 检测（LLM 判断形态，不是 mechanical trigger）。工程量 ~200-300 LOC。

**合计**：R2-R6 工程量 ≈ Lane G G1+G2+G3+G4 之和 + ADR 0023 R1 工程量 = pi-astack 当前体量翻倍。这是一个**多季度的实施**，不是单次 ship。

---

## 8. Known Trade-offs（明确接受）

按 INV-AUTONOMY + §1.3 AI-Native 原则，以下是被显式 accept 的代价：

| Trade-off | 后果 | 接受理由 |
|---|---|---|
| 错误传播跨设备 | 错的 rule 会在所有设备生效，直到下次自然对话产生反证 | 第二大脑设计目标是跨设备一致传播，错误是这个特性的副作用 |
| 偶发 false confidence | sediment 在错的 evidence 上沉淀，下次自动纠正前可能误导 LLM 一段时间——具体时间长度**取决于用户 task 分布偶然性，可能数周到数月** | 用户不参与是核心 invariant，宁可偶发 false 也不要持续管理负担 |
| Silent archive 误删 | rollback window 内若没遇到反证，可能永久 archive 实际仍有效的 entry | git history 保留是 ultimate fallback |
| 跨设备 eventual consistency 延迟 | 用户在设备 A 工作的观察可能要小时甚至天级才同步到设备 B 影响 LLM 行为 | ADR 0020 transport-only，不引入实时一致性 |
| Detection-blind false positive 累积 | 用户检测不到的 false positive（"pnpm 恰好能用"类、不刺激 push back 的场景）会沉积一层 low-grade false confidence | INV-ACTIVE-CORRECTION 只覆盖用户能察觉到的偏移；不能察觉的部分依赖 §4.3.3 cross-session aggregator 部分检测，残留 noise floor 显式接受 |
| Active-correction 疲劳与失效 | 用户对同一 entry 错了 3 次 correction 3 次后第 4 次可能不再 correction → 系统误读为"已经对了" | §4.3.1 ping-pong detection 在 N=2 时已升级 durable；若 N=2 后仍出错说明 classifier 上游有 bug 不是 correction 通道问题 |
| Multi-view verification 翻倍 LLM 调用成本 | 每个高 stake op 双倍 token | INV-AUTONOMY 的必要代价，且只在高 stake op 触发 |
| **AI-Native 原则下 dogfood 早期 reasoning trace 质量参差**（R6 新增） | classifier / curator 在 prompt v0 阶段 reasoning trace 可能不够清晰，作者需要 iterate prompt 数轮才能稳定 | prompt engineering 是 iterative + 低成本的工作面；比 mechanical schema 一旦定型修改成本低得多 |
| **LLM 推理失败的 base rate**（R6 新增） | 即使 prompt 完美设计，LLM 仍有非零概率推理失败——所有 AI-Native 系统共担 | 这是 background risk，不是 ADR 0024 特有；基座模型迭代会持续降低 |

这些都是 **vision 的必要代价**。不接受这些代价 = 不接受 INV-AUTONOMY 或 §1.3 AI-Native 原则 = 回到"用户 maintain 大脑"或"机械门兜底"的产品形态。

---

## 9. 边界澄清：本 ADR 不是什么

避免后续 reviewer / 实施者套错框架。

- **不是** "大脑对用户完全透明" — 用户主动 query 大脑 OK；power-user diagnostic slash 保留
- **不是** "禁止所有 ui.notify" — vault 例外（ADR 0014 #5）；task-related error 仍可 notify
- **不是** "禁止 prompt_user" — task-related 具体决策仍是 prompt_user 的合法用途（ADR 0022）；本 ADR 只禁止 "用 prompt_user 询问 sediment lifecycle 决策"
- **不是** "禁止用户与大脑交互" — 用户与 pi 的所有自然交互**就是**大脑的观察 surface
- **不是** "用户完全被动 observed subject" — 用户在 task 中**主动 correction** 是 vision 的**核心 ground truth 通道**（INV-ACTIVE-CORRECTION）。"observed subject" 的准确含义是"用户在 task 中持续 active、不被叫去做专门为大脑设计的元工作"
- **不是** "禁止所有机械工程"（R6 澄清） — 基础设施层（git / filesystem / sync transport）的机械保证仍允许且必要；§1.3 AI-Native 原则只禁止把机械门作为**LLM 行为层的主 derisk 手段**。机械 fallback 在 ADR-level 显式 justify 后允许存在
- **不是** "强制立即实施" — R2-R6 phase 工程量大，按真实 dogfood 反馈逐步 ship；R0 patch + ADR 0025 草拟是 immediate next step。**例外**：§4.3.1 active-correction recognition + §5.1 ADR 0023 R6 patch + §6.4 / §6.5 smoke 必须 R2 同 PR 交付

---

## 10. Walkback 信号

本 ADR 是 R5→R6 两层 reframe 的产物。**未来可能的 R6→R7 walkback 信号**（让后续 reviewer 警觉）：

1. dogfood 中 sediment 持续误判且无法自动纠正 → INV-AUTONOMY 可能需要 walk back（引入轻量 user-in-loop）
2. 跨 device 错误传播代价过大 → 可能需要 per-device override 机制
3. multi-view verification 跨模型族成本不可承受 → 可能需要更轻量的 self-check 替代
4. 跨设备 active-correction 疲劳信号显著 → ping-pong detection 阈值需下调，或引入 explicit "已经说过了" speech act 识别
5. **（R7 修订 2026-05-22）** classifier reasoning trace 质量出现持续退化。具体判据由 §4.3.3 新增的 "Classifier Health Meta-Check" prompt 段输出 advisory flag：quote rate / alternative mention rate / concrete self-critique rate 中任一持续低于 40%，或相比上次评估下降 ≥15pp。这是 advisory，不是 hard gate；作者收到 flag 后改 prompt 仍未解 → 该 capability 需要降级为 staging-only 或拆分到独立 ADR。原 R6 写法 "systematic blind spot reproducible across N sessions" 抽象，R7 升级为可被 aggregator LLM 用自然语言判断的具体维度。注意维度阈值（40% / 15pp）本身不是 mechanical gate——它们由 aggregator prompt 在自然语言推理中决定是否输出 warning，不触发任何自动行为，作者看到 warning 后人在 loop 改 prompt
6. **（R6 新增）** §1.3 AI-Native 原则在某个 capability 上**反复证伪**（多轮 prompt iteration 仍无法达到 baseline reasoning quality） → 该 capability 单独允许 mechanical fallback（需 ADR-level justify），不全盘 walkback AI-Native 原则
7. **（R6 新增）** R6 删除的 R5 INV-R13 80% gate / monthly auto-iter cron 在 dogfood 中被证明是 derisk 必需（不是可有可无） → 重新引入但需重新 framing 为 advisory metric / iteration helper 而非 hard gate

R6 reframe 的 dogfood 数据驱动决策原则：**不试试无法判断 vision 是否可行**。R7 walkback 必须基于真实 dogfood 数据，不是基于"想象中可能会"。

---

## 11. 相关记忆条目

- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim) — 本 ADR 是此 maxim 的彻底实施；R6 reframe 进一步把它升格为 ADR 显式方法论约束（§1.3）
- `prefer-prompt-engineering-over-mechanical-guards` (maxim) — §1.3 AI-Native 原则的直接依据；R6 reframe 证明此 maxim 即使在 5 层 self-check 下仍易被 RLHF 训练偏置侵蚀，需 ADR-level 显式锚定
- `mechanical-floor-rejection-guards-removed-from-sediment-writer` (decision) — ADR 0018 同款删机械 gate 路径的延续；R6 在 capability 设计层全面应用此 pattern
- `agents-md-progressive-disclosure-minimal` (maxim) — 本 ADR 把"渐进披露"从 AGENTS.md 推广到整个大脑：默认不披露，用户主动 query 才披露
- `abrain-auto-sync-to-remote-design-adr-0020` — 跨设备一致传播是设计目标
- `lane-g-g1-closure-state-as-of-2026-05-16` — Lane G G1 ship baseline；本 ADR §5.2 patch G4/G5
- ADR 0023 R4 §1.4 第二大脑威胁模型 — 本 ADR §1.2 / §2 的直接前置
- **[docs/audits/2026-05-21-adr-0024-multi-llm-r1-r6.md](../audits/2026-05-21-adr-0024-multi-llm-r1-r6.md)** — R1-R6 multi-LLM review 全程审计快照；含两层 reviewer 偏置量化（leading-prompt ~24.5pp / RLHF mechanical-guard ~15pp）、R5→R6 元层 reframe 触发记录、§1.3 AI-Native 原则的 substantive 案例证据、给 future multi-LLM review pipeline 的第 6 层 self-check 提议
- **[docs/audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md](../audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md)** — R7 prompt-engineering-only review（R6 之后首次独立 review）。三家 T0 在 audit §9.2 第 6 层 self-check F 硬约束下并行，21/21 建议落入 prompt engineering 形态（vs R1-R5 11/11 mechanical-form），首次实证 Layer F 能阻断 RLHF 机械主义偏置。本次 ADR 修订（§4.2 三行新增 / §4.3.1-§4.3.4 R7 修订段 / §6.6 三层 smoke / §10 walkback #5 升级）是 R7 五条 P0 共识的落地
