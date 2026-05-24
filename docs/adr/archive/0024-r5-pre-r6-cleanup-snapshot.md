# ADR 0024 — Invisible Autonomous Second Brain：自然交互驱动的自我演进

> ⚠️ **废弃快照 —— 勿引用本文定义 (2026-05-24)**
>
> 本快照包含的 INV-INVISIBILITY 措辞 "大脑内部所有生命周期事件默认完全静默" **已于 2026-05-24 被 ADR 0024 §2 重写取代**。原措辞被实现误读为 "大脑不能告诉用户做了什么"，导致 commit f3555e8 / 16cb6f0 误删 footer 状态机 + Lane C notify。
>
> **新定义**：INV-INVISIBILITY = "用户不参与大脑管理" + "运行状态应该正常显示让用户明确感知"。详 [当前 ADR 0024 §2](../0024-second-brain-from-natural-conversation.md#2-四条核心不变量-hard-invariant)。
>
> 本快照仅作为 R5 演进过程的 paper trail 保留，**不是当前设计**。下面原文内的 "默认完全静默" 等措辞已过时，不可再引用。

---

- **状态**：**Accepted (R5 终版, 2026-05-21)** — 用户产品哲学 redirect 后的总 framing ADR。本 ADR 给出第二大脑的产品哲学边界，是后续所有用户入口设计的总约束。详细机制设计推迟到 ADR 0025（meta-curator subsystem）。**R5 内部修订**：R4 经三家 T0 reviewer（opus-4-7 / gpt-5.5 / deepseek-v4-pro）三轮 cross-critique（平均可行性 33%）后用户再次 reframe："我始终会与第二大脑进行交互，发现偏移会提醒或要求变更，这个交互窗口本身就是隐性但直接的人工干预。" R4 文档（含三家 reviewer）把 "observed subject" 误读为"被动观察对象"——ADR 实际产品形态是用户在 task 中**持续 active**、不被叫去做元工作。R5 把 §3.1 白名单第 3 行升级为**第四条 hard invariant INV-ACTIVE-CORRECTION**，对应修订 §3.1 / §3.3 / §8 / §9 / §10，新增 §4.2.6 capability + §5.7 ADR 0023 追加 patch + §6.4 smoke。三家 T0 critique 中"闭环无外部 ground truth 注入"在 R5 下自动废除——active correction 通道就是核心外部 signal 通道。
- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md)（第二大脑七区基础；invariant #5 vault 明确同意是本 ADR 例外）、[ADR 0016](0016-sediment-as-llm-curator.md)（sediment-as-curator 哲学是本 ADR 的实施载体）、[ADR 0020](0020-abrain-auto-sync-to-remote.md)（跨设备一致传播是设计目标）、[ADR 0023 R4](0023-session-start-rule-injection.md)（rules zone + 第二大脑 mental model §1.4 是本 ADR 的直接前置）
- **Supersedes（部分）**：
  - [ADR 0021](0021-lane-g-identity-skills-habits-writer.md) §D4 `/about-me` slash + `MEMORY-ABOUT-ME:` fence 作为 first-class 入口
  - [ADR 0023 R4](0023-session-start-rule-injection.md) §D6.2 `/rule veto`、§4.8 INV-R8、§4.9 INV-R9、§D6.3 `MEMORY-RULE:` fence first-class 入口
  - [ADR 0016](0016-sediment-as-llm-curator.md) sediment self-improve monthly manual workflow（改为 cron 自动）
- **被引用**：ADR 0024 Accepted 后**R0 同 PR 必交付**反向 patch 上述 ADR（详 §5）；ADR 0025（meta-curator subsystem）将基于本 ADR 三条 invariant 起草
- **触发**：ADR 0023 R3→R4 修正了威胁模型（对抗性 → 第二大脑），R4 三家 reviewer 深度审计揭示 sediment 是 write-only loop。用户 R4 后再次根本性 redirect："第二大脑应该主动观察我，通过 LLM 自行演进自行进化，不能由我来纠正，不能由我去看第二大脑里有什么，那会极大加重我的工作量。" 同时澄清："不是说第二大脑对我完全透明，而是我在通过 pi 工作时，你能协助我，你观察我的每一次输入、每一次决定来进行自我进化自我演进，我们是存在交互的。" 本 ADR 据此定调。

---

## 1. 背景

### 1.1 ADR-0023 三家 reviewer 共有的盲点

三家（OPUS-4-7 + GPT-5.5 + DEEPSEEK-V4-pro）在 ADR 0023 R4 后的深度 review 中**都隐含了同一个假设**：用户需要某种 visibility 才能验证大脑学得对。具体体现：

- OPUS：F2 "sediment self-audit consumer" — 产出 health report 给谁看？默认是用户
- GPT-5.5：学习 digest + undo notification + 主动 confirmation prompt — 全是要用户**主动看**或至少瞄一眼的产品 UX
- DEEPSEEK：top #1 `/brain health` 命令 — 要用户去**读**
- 我（writer）的 P0 推荐：`/brain health` 测量层消费者 — 还是要用户去**看**
- ADR 0023 R4 自身：INV-R8/R9 `ui.notify on promotion/lifecycle` + `/rule veto` — **用户看 + 用户纠正**

**用户 redirect 把这一整套都否定了**。

### 1.2 用户 redirect 的真实意图（精确 reframe）

**不是**："大脑后台单向运转、用户与之无关"
**是**："用户与 pi LLM 协作完成实际工作 + 大脑借这个共同 surface 同步观察学习"

**消除的是**：用户做"管理大脑"的元工作（veto / review / digest / approve / bind / 主动声明身份等）
**保留的是**：用户与 pi 的自然 task-oriented 协作（这本身就是大脑的全部观察 surface）

类比：ChatGPT memory feature 隐含的 vision——但 ChatGPT 没做到（用户错了仍要 manual review/delete）。**本 ADR 要做到 ChatGPT 没做到的那一步**。

### 1.3 演进轨迹

| Redirect 层级 | 影响范围 |
|---|---|
| ADR 0023 R1→R2 | 入口层面（删 `/rule add`） |
| ADR 0023 R2→R3 | 单 invariant 层面（trust provenance） |
| ADR 0023 R3→R4 | 产品 framing 层面（第二大脑威胁模型） |
| **本 ADR 0024 (R4→R5)** | **整个 product philosophy 层面**（用户角色：从 maintainer 到 observed-subject） |
| **本 ADR 0024 (R5 内部修订)** | **用户角色精确化**（observed-subject 不是"被动观察"——用户在 task 中持续 active、主动 correction 是核心 ground truth 通道；新增 INV-ACTIVE-CORRECTION） |

---

## 2. 三条 Hard Invariant

本 ADR 是 framing ADR，三条 invariant 是后续所有 user-facing 设计的总约束。

### INV-INVISIBILITY（隐身性）

> 第二大脑借助 pi 主会话与用户协作时，**用户不应感受到"管理大脑"这件事**。所有大脑内部 lifecycle event（create / update / merge / archive / supersede / delete）**默认完全静默**。用户与 pi 的自然交互就是大脑的观察 surface，无需独立 UI 或元操作。

**唯一例外**：[ADR 0014 invariant #5](0014-abrain-as-personal-brain.md) vault 明确同意——这是对**数据流动**的明确同意，不是对**大脑学习**的明确同意，性质不同。

### INV-AUTONOMY（自治性）

> 第二大脑通过观察**用户与 pi 的自然交互**完成学习/纠错/演进。"用户不参与"指**不需要用户做专门为维护大脑而存在的动作**（veto / review / digest / approve / manual sync），但用户与 pi 的所有 task-oriented 交互**都**是大脑的学习信号——**含用户在 task 中主动发起的 correction**（详 INV-ACTIVE-CORRECTION）。即使用户一个月不主动 review 元 UI，大脑也应该越来越准。

### INV-IMPLICIT-GROUND-TRUTH（隐式 Ground Truth）

> 所有 ground truth 来自用户与 pi 的自然交互——**每一次输入、每一次决定、每一次接受/修改/拒绝 LLM 输出、每一次沉默、每一次跟进、每一次主动 correction**。不需要也不应该通过专门为大脑设计的 UI（veto / approve / digest）来获取 ground truth。"隐式"指**信号采集方式**（不靠元 UI），**不指用户被动**——active correction 是优先级最高的 implicit signal 子类（详 INV-ACTIVE-CORRECTION）。

### INV-ACTIVE-CORRECTION（主动纠错通道）（R5 新增）

> 用户在 task 中自然发生的主动 correction —— 例如 "以后用 X" / "忘掉那条" / "你怎么记成 Y 了" / "现在我更倾向 Z" —— 是第二大脑的**核心 ground truth 通道**，不是元工作，不违反 INV-INVISIBILITY 也不违反 INV-AUTONOMY。系统**必须**能识别此类发言并作为高置信度 explicit signal 注入 sediment（与被动 implicit signal 不同，无需 attribution 推断）。**classifier 准确识别 active-correction signal 是 vision 落地的前置条件**——失败时 vision 必然退化为 R4 三家 T0 reviewer critique 描述的"闭环无外部 ground truth"形态。

**与 INV-INVISIBILITY 的关系**：INV-INVISIBILITY 禁止**系统主动叫用户去做元工作**（review/digest/veto UI），不禁止用户在 task 中主动发起 correction。**区分原则**：发起方是系统 → 违反 INV-INVISIBILITY；发起方是用户在 task 自然语流中 → 是 INV-ACTIVE-CORRECTION 的合法 ground truth 路径。

**与 INV-AUTONOMY 的关系**：active correction 不是"用户为维护大脑而做的元工作"——它是 task 自然语流的一部分（与 "用 React 不用 Vue" 这种 task instruction 同构），不增加用户的认知负担。INV-AUTONOMY 的"用户不参与"边界精确指元工作（review/digest/veto），不指"用户在 task 中不说话"。

**typing of correction signal**（classifier 必须能区分的三种语义）：
- **durable preference correction**（"以后用 X" / "我现在更喜欢 Y" / "忘掉那条"）→ 写入 sediment，writer 操作（create/update/supersede entry）
- **task-local override**（"这个项目兼容性原因这次用 Z"）→ 不写入 sediment，仅作为当前 task instruction
- **debug / exploration**（"先试试 W 看能不能复现"）→ 不写入 sediment

**误判方向**：classifier 不确定时**偏向 task-local**（避免污染 durable preference）；用户 ping-pong（同一 correction 在 N session 内重复 ≥ 2 次）时自动升级为 durable。详 §4.2.6 capability + §5.7 ADR 0023 追加 patch + §6.4 smoke。

---

## 3. 自然交互 vs 管理大脑：明确边界

### 3.1 ✅ 自然交互（OK — 是大脑的观察 surface）

| 场景 | 性质 |
|---|---|
| 用户与 LLM 普通对话（task-oriented） | 主要观察源 |
| 用户接受 / 修改 / 拒绝 LLM 输出 | 隐式 outcome signal |
| 用户在 task 中说 "以后用 X" / "不要用 Y" / "忘掉那条" / "你怎么记成 Y 了" | **★ active-correction signal（INV-ACTIVE-CORRECTION 主通道）**——高优先级 semi-explicit ground truth，**不是**专门管理大脑 |
| LLM 调 `prompt_user` 问 task-related 具体决策（"用 React Router v6 还是 v7?"） | LLM 服务于当前 task |
| `vault_release` 高 stake 数据明确授权 | INV-INVISIBILITY 唯一例外（ADR 0014 #5） |
| 用户的代码 commit / 工作 pattern / 选择 / 沉默 / 抱怨 | 全部隐式 signal |
| `dispatch_agent` / `dispatch_parallel` 分派子任务 | task 协作 |
| 用户 query 大脑（"你怎么知道我喜欢 X?"）→ LLM 回答 | 用户主动 query 是 OK 的，LLM 应答即可，**不引导用户去"管理"** |

### 3.2 ❌ 管理大脑（违反 invariant，必须删除/避免）

| 反例 | 违反哪条 |
|---|---|
| `ui.notify` "我学到了 X" | INV-INVISIBILITY |
| `/rule veto <slug>` 让用户告诉大脑"刚才那条 rule 不对" | INV-INVISIBILITY + INV-IMPLICIT-GROUND-TRUTH |
| 学习 digest "本周大脑学了 5 条" | INV-INVISIBILITY |
| LLM 用 `prompt_user` 问 "我要把这个沉淀为 rule 吗？" | INV-INVISIBILITY（把"管理大脑"伪装成 task 决策推给用户） |
| "你最近 5 个项目都用 pnpm，是否升级为 always rule？" 这种 confirmation prompt | 同上 |
| `MEMORY-RULE:` fence 让用户手动注入 | INV-AUTONOMY |
| `MEMORY-ABOUT-ME:` fence 让用户手动声明身份 | INV-AUTONOMY |
| `/rule add` `/about-me` slash 让用户主动声明 | INV-AUTONOMY |
| 月度 sediment self-improve workflow 要用户主动跑 | INV-AUTONOMY |
| `/brain health` 自动 dashboard 让用户检视 | INV-INVISIBILITY |

### 3.3 灰色地带处理原则

| 场景 | 处理 |
|---|---|
| classifier 不确定 | **不能**问用户。**应该** defer + 写入 staging（status=provisional），等下次自然对话产生证据后自动 resolve |
| 高 stake op（confidence ≥ 8 create / always tier promote / archive confidence ≥ 8 entry） | **不能**问用户。**应该** multi-view verification（独立 reviewer LLM 二次确认）；二人组分歧 → defer 不 commit |
| 错误传播跨设备 | INV-AUTONOMY 显式接受此代价（详 §8） |
| 用户主动 query 大脑（"你怎么知道我喜欢 X?"） | LLM 应答，**不**触发"让用户来管理"的副作用（不让用户看 entry list / 不让用户 veto） |
| sediment 检测到矛盾 | **不能**让用户裁决。**应该**默认 prefer newer evidence，旧 entry 自动 supersede |
| Power-user 主动看大脑状态 | `/rule list` `/abrain status` 等保留作为**纯诊断入口**，**不**在 quickstart / `/help` 推广，**不**有任何 lifecycle event 主动引导用户去看 |
| 用户在 task 中说 "以后用 X" / "忘掉那条" / "你怎么记错了" | classifier **必须**识别为 active-correction signal（INV-ACTIVE-CORRECTION）。三种语义需区分：durable preference / task-local override / debug exploration。不确定时**偏向 task-local** 避免污染；同一 correction 在 N session 内重复 ≥ 2 次时自动升级为 durable。详 §2 INV-ACTIVE-CORRECTION typing 段 + §4.2.6 capability |

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
       ↘ outcome signal collection（接受/修改/拒绝/沉默）
                ↓
        cross-session pattern aggregator (cron-based)
                ↓
        hypothesis 写入 staging
                ↓
        next session 自然 resolve 或自动 archive
                ↓
        classifier auto-iteration loop (基于 outcome signal)
                ↓
        prompt 自我修订（不要求用户参与）
                ↓
        silent archive + rollback window
```

### 4.2 五条核心能力（ADR 0025 详细设计）

#### 4.2.1 Outcome → Entry Feedback Edge

**目标**：让 entry 知道自己是否"真的被用上了 / 用了之后用户是否满意"。

**机制清单**（详细设计在 ADR 0025）：
- entry frontmatter 新字段：`last_cited_at` / `citation_count` / `outcome_signals[]`（最近 N 次 outcome 摘要）
- `tool_result` / `message_end` hook 检测 LLM 是否引用了 entry 的 slug 或 trigger_phrase
- 用户后续的接受 / 修改 / 拒绝 → 关联回被引用的 entry，更新 outcome signal
- sediment 在 agent_end 综合 outcome signal 决定是否调整 entry confidence / status

#### 4.2.2 Cross-session Pattern Aggregator

**目标**：识别慢漂移偏好（如 Yarn → pnpm 6 周渐变），sediment 当前 per-session 看不到。

**机制清单**：
- 独立于 agent_end 的 cron-based background job
- Daily / weekly / monthly trigger（具体频率 ADR 0025 定）
- 输出：跨 session 的 candidate hypothesis（"用户偏好可能从 X 漂向 Y"）
- 写入 staging 等待 next session 自然 resolve（不主动通知用户）
- 若 staging 30 天无确认证据 → 自动 archive，**不打扰用户**

#### 4.2.3 Multi-view Verification

**目标**：避免单 curator LLM 的盲区导致 high-stake op 出错。

**机制清单**：
- 触发条件：`confidence ≥ 8` 的 create / always tier promote / archive `confidence ≥ 8` entry / supersede / 跨 zone migration
- 流程：proposer LLM（默认 sediment curator model）产 op proposal → 独立 reviewer LLM（不同 model 或不同 prompt 视角）二次确认
- 分歧处理：reviewer 否决 → 该 op `defer`（不写入 active，进 staging）；reviewer 确认 → 走 writer 正常路径
- **绝不**引入用户介入。这是 sediment 内部双 LLM gate

#### 4.2.4 Classifier Auto-iteration Loop

**目标**：classifier prompt 不依赖用户手动迭代，基于 outcome 自动校准。

**机制清单**：
- 每次 classifier decision 在 audit.jsonl 记录 `classifier_prompt_version` + `decision_hash`
- 后续 outcome（被 archive / 被 supersede / outcome signal 负面）自动按 prompt version 聚合统计
- 月度 cron 跑 self-improve：找出 v_N prompt 下错误率最高的 fixture pattern，自动生成 v_{N+1} prompt candidate
- v_{N+1} 走 multi-LLM audit（三路 xhigh）→ 通过则替换 v_N
- **绝不**要求用户 review 新 prompt（INV-AUTONOMY）

#### 4.2.5 Silent Archive + Rollback Window

**目标**：sediment 自动 archive 错了不要造成永久损失。

**机制清单**：
- `status=archived` 是软删除，文件保留 N 天（建议 30）
- N 天 silent window 内若 sediment 看到反证（用户在自然对话中提到该 entry 的内容 / cross-session aggregator 发现 trend 反转）→ **自动 revert 为 active**（不询问用户）
- N 天后才走 `git rm`（hard archive）
- Hard archive 仍可通过 git history 恢复，但不在 active 大脑中

#### 4.2.6 Active-correction Signal Recognition（R5 新增 capability，前置依赖）

**目标**：让 unified classifier（ADR 0023 D4）能稳定识别 task-内 active correction 三种语义，作为 INV-ACTIVE-CORRECTION 的工程载体，是 vision 落地的前置 capability。

**机制清单**（详细设计在 ADR 0025）：
- classifier prompt 扩展：识别 "以后用 X" / "忘掉那条" / "你记错了" / "现在我更倾向 Y" 等 correction speech act
- 三类语义 typing：durable preference correction / task-local override / debug exploration（详 §2 INV-ACTIVE-CORRECTION）
- correction → entry attribution：自动定位用户在 correction 哪条 entry（基于 slug / trigger_phrase / 语义相似度），若 attribution 不明仍可写入但 confidence 降级
- ping-pong detection：同一 correction 在 N session 内重复 ≥ 2 次 → 升级为 durable（避免 false negative 把 ping-pong 当 task-local）
- 误判方向：不确定时偏向 task-local（保守，避免污染 durable preference）
- classifier 在 active-correction 三类语义上的识别准确率**必须**纳入 §4.2.4 auto-iteration 的 metric（不只是 outcome signal）；R5→R6 walkback 触发信号见 §10

**前置依赖**：本 capability 是 R2 阶段必须 ship 的（不能推迟到 R3-R6）——否则 INV-ACTIVE-CORRECTION 是空声明，vision 退化为闭环无外部 signal 形态。R2 同 PR 必须含 §4.2.6 minimum viable 实现 + §6.4 smoke。

### 4.3 与现有 sediment 的关系

- 当前 sediment（reactive curator + writer）作为 meta-curator 的 sub-component
- 新增 meta-curator subsystem 在 cron job / 独立 hook 中运行
- 不破坏 sediment 单一 writer 原则（ADR 0014 invariant #1）：meta-curator 通过 sediment writer 完成所有写入

---

## 5. 反向 Patch 历史 ADR 列表（R0 同 PR 必交付）

本 ADR Accepted 后的下一个 PR 必须完成以下 patch（patch 不在 PR 内 → ADR 0024 不算落地，doc-vs-code drift 是 pi-astack 标准 audit 必 P0 项）：

### 5.1 ADR 0023 R5 patch

| 改动 | 类型 |
|---|---|
| 删 INV-R8 (Notify on promotion) | 删除 |
| 删 INV-R9 (Notify on lifecycle) | 删除 |
| 删 §D6.2 `/rule veto`（变成"自然对话中说'这条不对'"由 classifier 自动识别，evidenceSource 已删，纯靠 prompt 引导） | 删除 |
| 删 §D6.3 `MEMORY-RULE:` fence escape hatch | 删除 |
| 保留 §D6.2 `/rule list` `/rule explain` `/rule reload` 作为 power-user diagnostic（不引导用户用） | 保留 |
| 添加 §D5 RuleDraft 新字段：`last_cited_at` `citation_count` `outcome_signals[]` | 新增 |
| 添加 §4 INV-R12 `auto-demote based on last_triggered_at`（INV-AUTONOMY 配套） | 新增 |
| 添加 §1.4 `ADR 0024 是 ADR 0023 的产品哲学总约束，本 ADR 任何 user-facing 入口必须先通过 §3 边界检查` | 新增 |

ADR 0023 升级 R5 终版，R5 改动表新增一行 `R4 → R5: ADR 0024 reframe`。

### 5.2 ADR 0021 patch

| 改动 | 类型 |
|---|---|
| §D4 删 `/about-me` slash 作为 first-class 入口（保留代码作为 power-user diagnostic 隐性入口） | 降级 |
| §D4 删 `MEMORY-ABOUT-ME:` fence 作为 first-class 入口（保留 parser 作为 escape hatch，不在 quickstart 推广） | 降级 |
| 改为：sediment 从自然对话识别 about-me 信号（与 ADR 0023 unified classifier 合并，扩 zone enum 含 identity/skills/habits — 已在 ADR 0023 D4 涵盖） | 重定向 |
| Lane G G3 (aboutness classifier) 在 ADR 0023 R1 unified classifier 中自然涵盖（不变） | 保持 |
| G4 (`/review-staging` slash + 30-day TTL) 重定位：staging review **不**由用户跑，meta-curator §4.2.2 + §4.2.5 自动处理 | 重定向 |
| G5 (region-aware ranking hint) 重定位为 meta-curator §4.2.1 outcome feedback 的下游能力 | 重定向 |

### 5.3 ADR 0017 patch

| 改动 | 类型 |
|---|---|
| `/abrain bind` 保留为 power-user 入口（不删） | 保留 |
| 添加：sediment 在 active project 不明确时 `defer`（**不**prompt 用户），下次自然对话中识别 project context（用户提到的文件路径 / 项目名 / git remote）后自动 bind | 新增 |
| 仍保留 strict 三件套（manifest + registry + local-map）作为 identity 稳定性约束（DEEPSEEK Round 1 反驳 OPUS：identity 不稳定 → 学习信号污染） | 保持 |

### 5.4 ADR 0016 patch

| 改动 | 类型 |
|---|---|
| `sediment self-improve` workflow 月度手动 → cron 自动跑 | 重定向 |
| 输出不再是"给用户看的报告"，是"sediment 自己消费的 health signal"（输入到 §4.2.4 classifier auto-iteration） | 重定向 |
| 保留 `/sediment self-improve` slash 作为 power-user 入口（手动 trigger 一次 + 强制刷新） | 保留 |

### 5.5 ADR 0020 patch

| 改动 | 类型 |
|---|---|
| `/abrain status` `/abrain sync` 保留 power-user 但**默认 silent** | 调整 |
| 跨设备冲突在 INV-AUTONOMY 下接受 eventual consistency（**不打扰用户**）。auto-merge 失败时记录 audit，**不**主动 prompt 用户 | 调整 |
| 用户主动 `/abrain sync` 时仍允许手动冲突 resolve（power-user 主动 query 是 OK 的） | 保持 |

### 5.6 ADR 0014 / 0022 不需要 patch

- **ADR 0014 vault invariant #5**（vault 明确同意）是 INV-INVISIBILITY 唯一例外，本 ADR 已显式承认
- **ADR 0022 `prompt_user`** 用于 task-related 具体决策，不用于"管理大脑"。但 ADR 0024 §3.2 加一条 prompt_user 使用约束："**不得用 prompt_user 询问 sediment lifecycle 决策**"（如"我要把这个沉淀为 rule 吗"），这条约束写入 prompt_user schema validation 或 sediment classifier prompt（详 ADR 0025）

### 5.7 ADR 0023 R5 patch 追加（R5 内部修订新增）

R5 reframe 引入 INV-ACTIVE-CORRECTION 后，ADR 0023 R5 patch（§5.1）需追加以下硬要求（R2 阶段同 PR 必交付，否则 INV-ACTIVE-CORRECTION 是空声明）：

| 改动 | 类型 |
|---|---|
| §D4 unified classifier **必须**能识别 active-correction speech act 三类语义（durable / task-local / debug） | 新增硬要求 |
| §D4.3 classifier prompt fixture 集**必须**含 active-correction fixture（≥ 30 case，覆盖三类语义 + ping-pong + 边缘 case） | 新增 |
| 新增 INV-R13：active-correction 识别准确率 < 80% 时 sediment writer **不**写入 durable preference（仅写 task-local override 或 staging） | 新增 |
| §D5 RuleDraft 新字段：`active_correction_source: { speech_act: string, attribution_slug?: string, ping_pong_count: number }` | 新增 schema |

---

## 6. 不变量覆盖路径与 Smoke

### 6.1 INV-INVISIBILITY 覆盖

**静态 grep anchor**：
- sediment writer 的 lifecycle path（create / update / merge / archive / supersede / delete）**不**调用 `ui.notify` —— vault writer 例外（INV-INVISIBILITY 例外）
- meta-curator background job **不**调用 `prompt_user` `ui.notify` `ui.confirm`
- 全 codebase grep "管理大脑"语义动词作为 LLM-facing tool：无 `archive_rule` / `update_rule` / `veto_rule` / `confirm_promotion` 等 LLM-facing 函数

**Smoke**：`smoke:autonomy-no-management-prompt` — 跑 30 个 sediment lifecycle scenario，验证 0 次 ui.notify（vault scenario 例外）+ 0 次 prompt_user 调用（task-related prompt_user 例外）

### 6.2 INV-AUTONOMY 覆盖

**Smoke**：`smoke:autonomy-self-correction` — fixture 含 "sediment 写错 → 后续观察产生反证 → 自动 supersede" 序列，验证 N=10 case 全部在不需要用户介入的情况下完成纠错

**Smoke**：`smoke:autonomy-cron-aggregator` — 模拟 30 天跨 session evidence，验证 cross-session pattern aggregator 识别 trend 并写入 staging（不 ui.notify）

### 6.3 INV-IMPLICIT-GROUND-TRUTH 覆盖

**Classifier prompt 约束**（绑定 ADR 0023 R5 patch §D4.3）：
- 不允许使用"user explicitly told us to remember"作为 promote **唯一**依据
- 隐式 signal（接受 / 修改 / pattern / 跨 session repetition）**必须**被识别为合法 ground truth
- 与 ADR 0023 R4 §D4.3 trust source 引导段 **不冲突**：那段是"区分 user-attested vs untrusted source"，本 ADR 是"在 user-attested 内不区分 explicit vs implicit"

**Smoke**：`smoke:autonomy-implicit-signal` — fixture 含 "用户多次接受 LLM 输出后自然形成 preference" → 验证 sediment 沉淀为 preference / habit / rule（视情况）

### 6.4 INV-ACTIVE-CORRECTION 覆盖（R5 新增）

**Smoke**：`smoke:active-correction-typing` — fixture 含 30 个 active-correction 三类语义场景（durable / task-local / debug），验证 classifier 准确率 ≥ 80%（INV-R13 阈值）。

**Smoke**：`smoke:active-correction-ping-pong` — fixture 含 "用户对同一 entry 重复 correction ≥ 2 次" 场景，验证 classifier 自动升级为 durable。

**Smoke**：`smoke:active-correction-attribution` — fixture 含 "用户 correction 时未提 entry slug" 场景，验证 classifier 能基于语义相似度定位被 correction 的 entry。

**Smoke**：`smoke:active-correction-no-uppromotion-on-uncertainty` — fixture 含 classifier 不确定 case，验证默认偏向 task-local（不写入 durable preference）——R5 显式接受 false negative 的代价换取避免污染。

**Smoke**：`smoke:active-correction-no-management-prompt` — 验证 §4.2.6 capability 不引入 ui.notify / prompt_user 询问 "我是否该把这条 correction 沉淀"——active correction 是 explicit signal，classifier 直接 typing 决策，不二次询问用户。

---

## 7. 实施 Phase

### R0 — 反向 patch 历史 ADR（同 PR 必交付，无新代码）

§5 全部 patch + docs sync (current-state / roadmap / brain-redesign-spec / architecture)。约 2-3 天工作量，纯文档。

**R0 完成前 ADR 0024 不算 Accepted**，所有引用 ADR 0024 的下游设计 hold。

### R1 — ADR 0025 起草（meta-curator subsystem 详细设计）

本 ADR 只列 capability。R1 独立 ADR 详细设计：
- §4.2.1 outcome feedback edge 详细 schema + hook 接入点
- §4.2.2 cron aggregator 调度策略 + hypothesis schema
- §4.2.3 multi-view verification proposer/reviewer prompt 设计 + 分歧处理
- §4.2.4 classifier auto-iteration prompt diff 算法
- §4.2.5 silent archive rollback window N 数 + reverse trigger 条件

R1 起草后走 multi-LLM xhigh audit ≥ 2 轮 P0 收敛。

### R2 — meta-curator Phase 1 ship: Outcome feedback edge + auto-demote

最 actionable 部分（已有数据基础）：
- `last_cited_at` / `citation_count` / `outcome_signals[]` 字段
- `tool_result` / `message_end` hook 检测 citation
- 自动 demote based on `last_triggered_at`
- INV-R12 (auto-demote) 写入 ADR 0023 R5

工程量：~300-500 LOC（writer + injector 字段维护 + hook 接入）+ 2 个新 smoke

### R3 — Phase 2: Cross-session aggregator

Cron-based proactive observation，staging → next-session resolve loop。工程量 ~500-800 LOC（新 background job + staging lifecycle）

### R4 — Phase 3: Multi-view verification

Proposer + reviewer LLM 双 LLM gate。工程量 ~300-500 LOC（curator 改造 + 分歧处理）

### R5 — Phase 4: Classifier auto-iteration

月度 prompt diff job + multi-LLM audit pipeline。工程量 ~500-800 LOC

### R6 — Phase 5: Silent archive + rollback window

Rollback window 状态管理 + reverse trigger 检测。工程量 ~200-300 LOC

**合计**：R2-R6 工程量 ≈ Lane G G1+G2+G3+G4 之和 + ADR 0023 R1 工程量 = pi-astack 当前体量翻倍。这是一个**多季度的实施**，不是单次 ship。

---

## 8. Known Trade-offs（明确接受）

按 INV-AUTONOMY，以下是被显式 accept 的代价：

| Trade-off | 后果 | 接受理由 |
|---|---|---|
| 错误传播跨设备 | 错的 rule 会在所有设备生效，直到下次自然对话产生反证 | 第二大脑设计目标是跨设备一致传播，错误是这个特性的副作用。错的 rule 通过下一轮观察自然修订（INV-AUTONOMY） |
| 偶发 false confidence | sediment 在错的 evidence 上沉淀，下次自动纠正前可能误导 LLM 一段时间 | 用户不参与是核心 invariant，宁可偶发 false 也不要持续管理负担 |
| Silent archive 误删 | rollback window 内若没遇到反证，可能永久 archive 实际仍有效的 entry | git history 保留是 ultimate fallback，hard archive 不是永久数据丢失 |
| 跨设备 eventual consistency 延迟 | 用户在设备 A 工作的观察可能要小时甚至天级才同步到设备 B 影响 LLM 行为 | ADR 0020 transport-only，不引入实时一致性（成本高且不必要） |
| Classifier 漂移无明显信号 | Auto-iteration loop 错了用户感受不到（只感受 "LLM 突然变笨"） | **R5 修订**：INV-ACTIVE-CORRECTION 是主要 dampening——用户在 task 中察觉到偏移会 push back 产生 explicit negative signal，比纯被动 outcome feedback 强。Auto-iteration 错了下次 outcome signal + active correction 共同反馈纠正。残留风险见下一行 |
| Detection-blind false positive 累积（**R5 新增**） | 用户检测不到的 false positive（"pnpm 恰好能用"类、不刺激 push back 的场景）会沉积一层 low-grade false confidence | INV-ACTIVE-CORRECTION 只覆盖用户能察觉到的偏移；不能察觉的部分依赖 §4.2.2 cross-session aggregator 部分检测，残留 noise floor 显式接受。诚实承认 trade-off 等于不接受"vision 必然百分百对"的乌托邦 |
| Active-correction 疲劳与失效（**R5 新增**） | 用户对同一 entry 错了 3 次 correction 3 次后第 4 次可能不再 correction（认为说了没用）→ 系统误读为"已经对了" | §4.2.6 ping-pong detection 在 N=2 时已升级 durable；若 N=2 后仍出错说明 classifier 上游有 bug 不是 correction 通道问题。如果 dogfood 中 ping-pong 升级仍频繁失败 → R5→R6 walkback 信号（详 §10） |
| Multi-view verification 翻倍 LLM 调用成本 | 每个高 stake op 双倍 token | INV-AUTONOMY 的必要代价，且只在高 stake op 触发（不是全部 op） |

这些都是 **vision 的必要代价**。不接受这些代价 = 不接受 INV-AUTONOMY = 回到"用户 maintain 大脑"的产品形态。

---

## 9. 边界澄清：本 ADR 不是什么

避免后续 reviewer / 实施者套错框架：

- **不是** "大脑对用户完全透明" — 用户主动 query 大脑（"你怎么知道我喜欢 X？"）是 OK 的；power-user diagnostic slash 保留
- **不是** "禁止所有 ui.notify" — vault 例外（ADR 0014 #5）；task-related error 仍可 notify（比如 LLM 调 tool 失败）
- **不是** "禁止 prompt_user" — task-related 具体决策仍是 prompt_user 的合法用途（ADR 0022）；本 ADR 只禁止 "用 prompt_user 询问 sediment lifecycle 决策"
- **不是** "禁止用户与大脑交互" — 用户与 pi 的所有自然交互**就是**大脑的观察 surface
- **不是** "用户完全被动 observed subject"（R5 新增）— 用户在 task 中**主动 correction** 是 vision 的**核心 ground truth 通道**，不是元工作（详 INV-ACTIVE-CORRECTION）。"observed subject" 的准确含义是"用户在 task 中持续 active、不被叫去做专门为大脑设计的元工作"——R4 三家 T0 reviewer 共同的"被动观察"误读是 R5 reframe 的直接触发点。task-内 active correction（半显式、有意向、可 attribution）与被动 implicit signal（接受/沉默/pattern）共同构成 ground truth 信号源，前者优先级更高
- **不是** "强制立即实施" — R2-R6 phase 工程量大，按真实 dogfood 反馈逐步 ship；R0 patch + ADR 0025 草拟是 immediate next step。**R5 例外**：§4.2.6 active-correction recognition + §5.7 ADR 0023 追加 patch 必须 R2 同 PR 交付（INV-ACTIVE-CORRECTION 前置依赖）

---

## 10. R5 / 后续 redirect 预警

本 ADR 是 R4→R5 redirect 的产物。**未来可能的 R5→R6 redirect 信号**（让后续 reviewer 警觉）：

- 如果 dogfood 中 sediment 持续误判且无法自动纠正 → INV-AUTONOMY 可能需要 walk back（引入轻量 user-in-loop）
- 如果 cross-device 错误传播代价过大 → 可能需要 per-device override 机制
- 如果 multi-view verification 成本不可承受 → 可能需要更轻量的 self-check 替代
- **（R5 新增）** 如果 classifier 在 active-correction 三类语义（durable / task-local / debug）识别准确率持续 < 80%（INV-R13 阈值）→ INV-ACTIVE-CORRECTION 前置条件失败，vision 退化为 R4 三家 T0 reviewer critique 描述的"闭环无外部 ground truth"形态，必须 R6 reframe（引入低频盲测 oracle 等外部 anchor，参考 R4 三家 T0 研讨产出的 Opus dogfood 证伪实验设计）
- **（R5 新增）** 如果 dogfood 中 active-correction 疲劳信号显著（用户 push back 频率随 entry 错误次数下降）→ ping-pong detection 阈值需下调，或引入 explicit "已经说过了" speech act 识别

但 R5 (本 ADR) 至少给系统**机会**实现 vision。**不试试无法判断 vision 是否可行**。R6 redirect 必须基于真实 dogfood 数据，不是基于"想象中可能会"。

---

## 11. 相关记忆条目

- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim) — 本 ADR 是此 maxim 的彻底实施
- `prefer-prompt-engineering-over-mechanical-guards` (maxim) — INV-AUTONOMY 的设计依据
- `agents-md-progressive-disclosure-minimal` (maxim) — 本 ADR 把"渐进披露"从 AGENTS.md 推广到整个大脑：默认不披露，用户主动 query 才披露
- **（R5 新增）** R4 三家 T0 reviewer 三轮 cross-critique 输出（opus-4-7 / gpt-5.5 / deepseek-v4-pro，平均可行性 33%，共识 #2 "闭环自检" critique 在 R5 INV-ACTIVE-CORRECTION 下自动废除）
- `mechanical-floor-rejection-guards-removed-from-sediment-writer` (decision) — ADR 0018 同款删机械 gate 路径的延续
- `abrain-auto-sync-to-remote-design-adr-0020` — 跨设备一致传播是设计目标
- `lane-g-g1-closure-state-as-of-2026-05-16` — Lane G G1 ship baseline；本 ADR §5.2 patch G4/G5
- ADR 0023 R4 §1.4 第二大脑威胁模型 — 本 ADR §1.2 / §2 的直接前置
- 三家 reviewer Round 1 输出（OPUS / GPT-5.5 / DEEPSEEK） — 本 ADR §1.1 盲点分析的数据源
