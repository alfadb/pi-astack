# ADR 0026 — 第二大脑参与任务执行

- **状态**：R0 草案 v2（2026-05-22 用户方向校正后重写）。v1 被用户指出方向偏了—— v1 写的是"推送系统"（什么时候推、推什么、推多少），但用户要的是"参与系统"（大脑在决策时跟 LLM 一起想、一起判断）。
- **基准**：[ADR 0024](0024-second-brain-from-natural-conversation.md) 的四条 invariant + AI-Native 原则。
- **对偶**：[ADR 0025](0025-sediment-meta-curator-subsystem.md) 负责"怎么写对"（六个写侧能力），本 ADR 负责"怎么在任务里用出来"。

**v1 → v2 改动原因**：用户看完 v1 后说 "我感觉有点偏差——任务执行时 LLM 应该能根据上下文自动让第二大脑参与决策、参与任务执行"。v1 把大脑当成了内容推送器；实际上大脑应该是 LLM 做决策时的**内置参谋**——不只是"我记得你用过 pnpm"，而是 "你当前在初始化一个新项目，过去 6 个月你在 12 个项目里用了 pnpm，而且那次你试 yarn 两周后改回来了。建议 pnpm"。

---

## 0. 起草说明

### 这份文档只写
- 当前 LLM 怎么跟大脑互动（§1）——现状就是调一下 `memory_search`，拿回几条摘要
- "参与决策"跟"推送记忆"到底差在哪（§2）
- 四个让大脑真正参与任务执行的机制（§3）
- 怎么落地——两条互补路径（§4）
- 跟 ADR 0025 的咬合——写进去的东西怎么在任务里用出来（§5）

### 这份文档不写
- ADR 0024 invariant / AI-Native——那是 0024 的事
- ADR 0025 六条写侧能力——那是 0025 的事
- prompt 级别的完整 text——R1 展开

---

## 1. 代码现实：当前只有一个"翻记忆"的动作

现有 LLM 跟大脑的互动方式就一种：

```
LLM 正在做任务
  → LLM 自己觉得"可能需要查一下大脑"
  → 调 memory_search("用户偏好包管理工具")
  → 拿回 3-5 条摘要（slug + 几行描述）
  → 如果某条看起来有用，再调 memory_get(slug) 拿全文
  → 把内容融进自己的推理中
  → 继续做任务
```

工具注册 @ `extensions/memory/index.ts:296`，描述是 "Use memory_search before planning, designing, reviewing code, or making project-specific decisions"。

**核心特征**：

| 维度 | 现状 |
|---|---|
| 谁决定查 | LLM 自己——它得**想起来**去搜 |
| 什么时候查 | 计划 / 设计 / review 阶段——指令里建议的时机 |
| 查回来什么 | 原始记忆条目的摘要——**不加解释、不加判断** |
| 大脑的角色 | 图书管理员——你问、我找、给你，别的不多嘴 |

**差在哪**：用户要的不是图书管理员，是要一个**知道用户偏好、了解用户过去决策的参谋**——在 LLM 做决定时不是"你问我再答"，而是"这个决定让我想起几件事，你应该考虑"。

---

## 2. "推送记忆"和"参与决策"的区别

我 v1 写的本质是**推送系统**：

```
大脑观察上下文 → 判断"该推了" → 选几条 → 控制剂量 → 塞给 LLM
```

问题：LLM 拿到的是**原始记忆**。它还得自己理解为啥这条现在相关、跟其他条目有没有冲突、过去的 outcome 是好是坏。大脑做完了第一步（"找出来"）就把所有推理负担扔给 LLM 了。

用户要的是**参与系统**：

```
LLM 到达决策点 → 大脑主动提供情境化建议 →
"你当前在 X 场景下做 Y 决定。基于你过去的选择：
 - A 条目说你偏好 Z 方案，过去 12 个项目用了 Z
 - B 条目说你试过 W 方案，两周后改回来了
 - C 条目是跟你当前项目同类型的，用了 Z + 这个配置
 综合来看，建议 Z。但如果你这次有特殊原因想用 W，注意上次的问题是..."
```

区别在哪：

| | 推送记忆 | 参与决策 |
|---|---|---|
| 大脑给的 | 原始记忆摘要 | **记忆 + 解释 + 判断 + 建议** |
| LLM 要做 | 自己融进推理 | 在大脑的建议基础上做最终判断 |
| 时机 | 预判"该推了" | **检测到决策点时**介入 |
| 多条目处理 | 一条条塞 | **融合多条**给出综合建议 |
| 矛盾处理 | LLM 自己发现矛盾 | 大脑**主动指出**"你上次做类似决定时选了相反的" |

---

## 3. 四个参与机制

### 3.1 决策点识别

**目标**：知道 LLM 什么时候在做决定，在那个时刻让大脑介入。

不是每个对话轮都需要大脑参与。用户说 "帮我写个 README" 和用户说 "我这个项目应该用 React Router v6 还是 v7"——后者是决策点，大脑该介入；前者是执行指令，大脑不用多嘴。

识别走一段轻量 prompt，在 `agent_turn` 时跑（每轮 LLM 收到用户消息后、调工具前）：

```
你是决策点观察者。下面是用户刚发的消息 + 最近几轮对话。

判断：用户当前是否处于一个**需要做选择的时刻**？
- 技术选型？"用 X 还是 Y" / "这个项目用什么框架"
- 架构决策？"怎么设计这个模块" / "数据库选哪个"
- 工作流选择？"CI 用什么" / "怎么部署"
- 工具/库选择？"用哪个库" / "哪个方案更好"

如果是决策点，输出：
{
  "is_decision_point": true,
  "decision_type": "tech-choice | architecture | workflow | tool-choice",
  "whats_being_decided": "1 句话描述",
  "options_on_table": ["显式提到的选项 + 隐式可能的选项"],
  "constraints": ["时间 / 兼容性 / 团队 / 其他约束"]
}

如果不是决策点，输出：
{
  "is_decision_point": false
}
```

**不是每个 agent_turn 都跑**——只在以下条件触发：
- 用户消息含选择类关键词（"选哪个 / 用 X 还是 Y / 怎么选 / 推荐 / 建议"）
- 或者 LLM 上轮回复中提出了选项让用户选
- 或者 LLM 即将调 `prompt_user` 问用户决策

**当检测到决策点** → 触发 §3.2 情境化回忆。

### 3.2 情境化回忆

**目标**：不只是"搜到这几条"，而是"这几条对你当前的决定意味着什么"。

在决策点触发后，跑一段 prompt（替代当前 LLM 手动调 memory_search 的场景）：

```
你是第二大脑的决策参谋。用户正在做一个决定：

【当前决策】
- 类型：{decision_type}
- 在决定什么：{whats_being_decided}
- 摆在台面上的选项：{options_on_table}
- 约束：{constraints}

【你找到的相关记忆】
{llmSearchEntries 召回的前 8 条，含全文}

基于这些记忆，写一份**决策简报**。不是简单列举条目——
每一条告诉我"这对当前的决定有什么含义"。

简报结构：
1. 相关偏好（用户过去明确说了什么）→ 对当前决定的影响
2. 相关经验（用户过去做了类似选择后发生了什么）→ 是顺利还是后悔了
3. 矛盾提醒（如果当前选项跟用户过去的某个明确偏好冲突）→ 指出来
4. 综合建议（不是替 LLM 做决定，是给出"基于你所知的用户历史，
   哪个选项最符合用户的长期偏好"——如果证据不足就说证据不足）

你的输出是给主 LLM 看的内部参考，不是给用户看的。保持简洁——
控制在 500 tokens 内。
```

**输出是一段自然语言简报**，不是 JSON schema。主 LLM 拿到后像读一段"专家意见"一样融进自己的推理。

**⚠️ 什么不该出现在简报里**：provisional staging 条目（attribution_pending=true）**不准**进决策简报。provisional 是分类器的未确认猜测——不是用户事实。如果一条 provisional 说"用户可能偏好 X"而决策简报把它当 confirmed preference 推荐给 LLM，LLM 采纳后用户说"我没说过这个"——这就是大脑自己编了条偏好然后自己信了。provisional 的唯一用途是等 0025 的 staging resolution 流程确认或废弃——**在确认前不参与任何"用"侧的决策**。

**为什么直接给自然语言而不是 JSON**：JSON 迫使 LLM 把判断拆成字段，容易丢失跨条目的综合判断。"用户偏好 pnpm"和"用户试 yarn 后改回来"这两条放一起才能看出"用户不是一般偏好 pnpm，是试过 yarn 不好用之后确认的偏好"。JSON schema 很难表达这种跨条目的综合判断。

**跟当前 memory_search 的关系**：不是取代。当前 LLM 自己调 memory_search 的场景仍然保留——很多场景不需要决策简报（比如"这个函数的 API 是什么"），LLM 自己搜就够。决策简报只在**检测到决策点时**触发，作为附加的参谋输入。

### 3.3 矛盾感知

**目标**：大脑注意到 LLM 正在做的选择跟用户过去的明确偏好冲突时，主动提醒。

这是 INV-ACTIVE-CORRECTION 在"用"侧的兑现——用户说了"以后用 pnpm"，大脑记住了。三个月后 LLM 在某个项目里建议用 yarn，大脑应该能感知到这个矛盾。

**实现**：矛盾感知跟 §3.2 情境化回忆是**同一次 LLM 调用**——在生成决策简报时，prompt 里加一段：

```
特别检查：即将选择的方案是否跟用户过去的某个【明确偏好】（高置信
durable entry，conf ≥ 7）直接冲突？

如果冲突：
- 指出冲突的具体条目（quote 原文）
- 判断可能的场景：用户可能改主意了 / 这个项目有特殊原因 /
  这个偏好不适用当前场景 / LLM 忘了
- 建议：提醒 LLM 这条偏好的存在，但不要强推——LLM 可以根据
  当前对话上下文判断用户是否真的改了主意

如果没冲突：跳过。
```

**为什么不是硬拦截**：大脑不知道用户是不是改主意了——用户可能三个月前说"用 pnpm"，但当前项目跟团队统一用 yarn，这个决策是合理的。大脑应该**提醒**，不是**阻止**。提醒了之后 LLM 可以：
- 按大脑的建议改用 pnpm
- 或者跟用户确认："我记得你之前偏好 pnpm，但这个项目用 yarn——是改偏好了还是项目特殊？"（INV-INVISIBILITY 不禁止 —— 这是任务决策确认，不是大脑管理）
- 或者直接按项目需求用 yarn，把大脑的提醒当参考

### 3.4 结果驱动的推荐

**目标**：用户过去的决策结果影响现在的建议。

ADR 0025 §4.2 outcome self-report 收集了"某条记忆被用了、用得好不好"。这个数据不应该只存着，应该在决策时发挥作用。

**具体怎么用**：

在 §3.2 决策简报的 prompt 里，附加一个 outcome 摘要：

```
【相关条目的使用记录】
- "用户偏好 pnpm"：过去 30 天被 DECISIVE 使用 23 次，从未被 RETRIEVED-UNUSED
  → 高度活跃，用户的偏好没有动摇
- "项目 X 用 React Router v6"：3 个月前被 DECISIVE 使用 2 次，最近 2 个月没被引用
  → 可能项目完成或不再相关，建议作为参考而非硬约束
- "CI 用 GitHub Actions"：被 RETRIEVED-UNUSED 3 次（LLM 搜到了但觉得不相关没采用）
  → 用户可能迁移了 CI 工具，降权
```

outcome 数据影响的是**推荐的力度**——活跃条目 → 强推荐；冷条目 → 弱参考；被否过的条目 → 提醒但不推荐。

**具体机制**：outcome-ledger（ADR 0025 §4.2.4）里存了每条 outcome 的 timestamp + used 字段。§3.2 调之前扫一次 ledger，算出每条相关条目的近 30 天活跃度和 outcome 倾向，写进决策简报 prompt 的 context 里。这个计算是 Infra 行为（读文件、统计数字），不需要 LLM 推理。

**⚠️ 防止回声室**：大脑推荐 A → LLM 采纳 → outcome 记 DECISIVE → 下次大脑更强推 A → LLM 更倾向采纳 A → 循环。这个正反馈会让大脑把自己的推荐当成"用户确认过的偏好"，而实际上用户只是没反对。断路器：同一条目连续 5 次被 DECISIVE 使用且期间用户没有产生任何主动纠错信号（说明用户没反对但也没主动确认）→ aggregator（0025 §4.3）自动把这条标记为"pending reconfirmation"——下次决策简报里不再推荐为"明确偏好"，降级为"之前你经常用，但最近没有明确确认过"。这个降级不是归档、不是删除——只是让大脑的推荐语气从"你应该"变成"你之前好像"。

---

## 4. 怎么落地——两条互补路径

### 4.1 路径 A：决策简报（主路径，agent_turn 触发）

上面对应 §3.1-§3.3。流程：

```
agent_turn hook @ before_agent_turn
  ├─ [决策点检测] 用户消息含选择关键词？→ 跑 §3.1 prompt
  ├─ is_decision_point == true？
  │   ├─ [召回] llmSearchEntries(决策上下文) → 前 8 条
  │   ├─ [outcome 摘要] 读 outcome-ledger → 近 30 天活跃度统计
  │   ├─ [决策简报] 跑 §3.2 prompt（含 §3.3 矛盾检测 + §3.4 outcome 数据）
  │   └─ 输出 decision_brief（≤500 token 自然语言段落）
  │       注入到 system prompt 或作为额外的 context 项给主 LLM
  └─ is_decision_point == false → 跳过
```

**注入方式**：决策简报放在本轮 system prompt 末尾。

**⚠️ 延迟不是"可接受"——得说清楚代价**：R10 审计指出，在 `agent_turn` 里加决策点检测 + 简报生成会让 LLM 首 token 时间（TTFT）从 1-2s 涨到 3-5s。对用户来说，"LLM 开始回复"慢了一倍多。这不是小代价——在 20% 的轮次上三倍延迟，用户会感觉"这个 AI 怎么卡了一下"。

**怎么缓解**：
1. P0 阶段只用路径 B（LLM 主动拉 `memory_decide`）——延迟完全由 LLM 自己控制，不额外增加每轮开销
2. P1 自动简报先只在低频高价值场景触发——不是每个疑似决策点都跑，而是只在"用户显式问选 A 还是 B"或"LLM 上轮给了选项等用户选"这两种明确场景才触发
3. 如果用户反馈"卡"——退回到纯路径 B，不跑自动注入

这不是"延迟可接受"——这是"延迟有代价，我们有限范围内承担"。

### 4.2 路径 B：即时深潜（辅助路径，LLM 主动调）

有些决策是 LLM 在推理过程中才意识到的——不是用户直接问"用 X 还是 Y"，而是 LLM 发现"等等，这里有三个可能的实现方式，我得选一个"。这种决策点在 §3.1 的检测 prompt 里不一定能预先抓到。

**给 LLM 一个新工具 `memory_decide`**：

```
memory_decide(context: "我在决定一件事", options?: ["A", "B"], constraints?: "约束")

返回：一份决策简报（≤500 token），格式跟路径 A 相同。
不同点：这个简报是 LLM 主动要的，不是大脑推到它面前的。
```

**跟路径 A 的关系**：
- 路径 A：大脑**推**（检测到决策点 → 主动给简报）
- 路径 B：LLM **拉**（自己意识到在决策 → 调 memory_decide）

两路径互补——路径 A 覆盖显式决策点，路径 B 覆盖隐式决策点。底层用的是同一套 prompt（§3.2），只是触发方式不同。

### 4.3 INV-INVISIBILITY 怎么保证

**误读重点（2026-05-24）**：本节原领发版本措辞暗示 "大脑运作必须对用户不可见" 才是 INV-INVISIBILITY。该措辞被误读为"运行状态都要藏起来"（commits f3555e8 / 16cb6f0）。事后澄清：INV-INVISIBILITY 原意 = 用户不参与大脑管理，**不是**"大脑运行状态藏起来"。

本节讨论的是决策简报这一个具体产品表面的可见性，不是全局运行状态。

**决策简报本身不暴露给用户详细内容** （这是决策简报这个具体产品的设计选择不是 INV本身要求）。理由:

1. 用户看到的不是"简报内容"而是"LLM 为了这个决策参考了哪些记忆"——后者是**告诉用户为什么 LLM 有这个判断**，有价值；
2. 简报原始文本是 LLM 的内部推理辅助，跟用户看到的 LLM 输出是不同产品层 —— 推荐错了用户看到产品层的不一致会困惑；
3. **但 LLM 可以主动提及**：“根据你之前的 X / Y 偏好，推荐 Z” ——这是 LLM 将简报消化后的表达，是告诉用户“大脑参与了这个决策”的合法反馈。

实现：
- 决策简报原文 注入 system prompt 末尾（不双重渲染到用户界面）
- 但 sediment / abrain 的所有其他运行状态指示 （footer / notify / audit）按 ADR 0024 §2 重写后的说明正常运行。
- LLM 被 prompt 鼓励在选择与之前记忆不完全一致时主动释明原因 （表达决策参与），让用户明确感知大脑参与了决策。

---

## 5. 跟 ADR 0025 的咬合

| ADR 0025 产物 | 本 ADR 怎么消费 |
|---|---|
| §4.1 主动纠错识别 | 矛盾感知（§3.3）靠主动纠错的 durable entry 判断"用户明确说过什么" |
| §4.2 outcome self-report | 结果驱动的推荐（§3.4）靠 outcome-ledger 判断"过去用了效果如何" |
| §4.3 aggregator 趋势观察 | 低频但重要的偏好靠 aggregator 发现——不被 outcome 30 天窗口误降权 |
| §4.4 multi-view verification | 高置信 durable entry 在决策简报里被标记为"明确偏好"（vs "可能偏好"）。**⚠️ P0.5 现状 (2026-05-24 batch 7 补记)**: multi-view R-series 当前仅以 audit/staging 形式存在。`memory_decide` v1 **不**消费 `CuratorAudit.multi_view` 或 `multi-view-metrics.jsonl`；MemoryEntry frontmatter 也未附加 `multi_view_verified: true` 字段。另外 v1 `writeApprovedToBrain` 是 stub (ADR 0025 §4.4.6 D)，意味着 staging replay 后 reviewer-approved entry 不保证进脑。本行描述的"明确偏好 vs 可能偏好"区分是 P1+ 目标，仅在 (a) writer dispatch v2 接入 + (b) decision brief prompt 加 verified 字段 + (c) MemoryEntry frontmatter 加 `multi_view_verified` 后生效。 |
| §4.6 静默归档 | 归档 entry 不出现在记忆召回中，自然不进决策简报 |

**反过来，本 ADR 也喂 0025**：
- 决策简报中 LLM 采纳了某条建议 → outcome 写 DECISIVE + 简报批注
- 决策简报中 LLM 看了但没采纳 → outcome 写 RETRIEVED-UNUSED + 不采纳原因
- 用户否了简报里的建议 → 触发 ADR 0025 §4.1 主动纠错识别（"不是这个" = correction signal）

---

## 6. 实施路径

### 6.1 新文件

```
extensions/sediment/
├── decision-detector.ts          ← §3.1 决策点检测 prompt + logic
├── decision-briefer.ts           ← §3.2 情境化回忆 prompt（含 §3.3 矛盾检测）
├── memory-decide-tool.ts         ← §4.2 memory_decide 工具注册
└── prompts/
    └── decision-brief-v1.md
```

### 6.2 改动现有文件

| 文件 | 改动 |
|---|---|
| `extensions/memory/index.ts` | 注册 `memory_decide` 工具 |
| `extensions/sediment/index.ts` | `before_agent_turn` hook 加决策点检测 + 决策简报注入 |
| `extensions/sediment/writer.ts` | outcome-ledger 读接口（供 §3.4 统计活跃度） |

### 6.3 Phase 安排

**⚠️ R10 审计发现的 bootstrap 死锁**：0026 的价值依赖 0025 产出的语料（durable entry + outcome 数据），但 0025 的语料依赖 `autoLlmWriteEnabled: true`，而 `autoLlmWriteEnabled` 改 true 又要等 0025 P1-P5 ship 并验证完。这是"先有鸡还是先有蛋"。

**怎么解**：0026 分两层 ship。

**第 1 层（P0a，立即可 ship）**：`memory_decide` 工具的骨架——注册工具、写好 50 行精简版简报 prompt（只包装 `memory_search` 结果，不含 outcome 数据、不含矛盾检测、不含 provisional staging）。这层对 0025 零依赖。用户在开 `autoLlmWriteEnabled: true` 之前，`memory_decide` 搜到的是已有的手动 fence 记忆 + legacy `.pensieve/` 数据——不是空的，但质量参差。这已经比"LLM 自己调 memory_search 然后自己理解"强了。

**第 2 层（P1，等 0025 有数据后）**：完整版决策简报（含 outcome 摘要 + 矛盾检测）。在 0025 P1 ship 且积累 1-2 个月的 outcome 数据后启动。

| Phase | 范围 | 依赖 | 工程量 |
|---|---|---|---|
| **P0** | `memory_decide` 工具（路径 B，LLM 主动调）——最小可用版本。prompt 是 §3.2 的精简版（不含 outcome 数据、不含矛盾检测） | ADR 0025 P0（promptVersion / audit） | 小 |
| **P1** | 决策点检测（§3.1）+ 决策简报自动注入（路径 A）——完整版 prompt（含 §3.3 矛盾检测 + §3.4 outcome 摘要） | P0 + ADR 0025 P1（主动纠错 classifier 产出 correction_signal）+ ADR 0025 P2（outcome 数据可用） | 中 |
| **P2** | 简报采纳/拒绝 → 反馈到 outcome-ledger（本 ADR §5 反向喂 0025） | P1 + ADR 0025 P2 outcome-ledger 写接口稳定 | 小 |

**关键**：P0 可以立刻 ship——不需要等 ADR 0025 的上游能力。`memory_decide` 工具是自包含的：拿当前决策上下文 + 召回的条目 → 产决策简报。LLM 现在就能用。

P1 需要等 ADR 0025 P1（主动纠错）和 P2（outcome），因为矛盾检测靠 active correction 的 durable entry，outcome 摘要靠 outcome-ledger。但这两个阻塞不严重——P0 已经提供了最小可用的"大脑参与决策"体验。

### 6.4 反向 patch

| 下游 | patch |
|---|---|
| ADR 0025 §4.2 | outcome-ledger schema 加 `decision_brief_id` 字段——如果 outcome 是来自决策简报的采纳/拒绝，记录对应的简报 ID |
| ADR 0025 §4.1 | 主动纠错触发条件加一条：决策简报中的建议被用户明确否了 |
| ADR 0024 §6 | 接受代价表加第 10 条：决策简报的误导（大脑基于过时信息给了错误建议） |
| **ADR 0026 §5 本身 (2026-05-24 batch 7 T0 review 补记)** | §5 表中 §4.4 multi-view 行加“P0.5 现状”脚注，明确说明当前是写侧 audit/staging infra，decision brief v1 不消费 multi-view 产出。其 P1+ 生效条件：(a) writer dispatch 从 v1 stub 升级 v2；(b) decision brief prompt 增加 `multi_view_verified` 警示字段；(c) MemoryEntry frontmatter 增加 `multi_view_verified: true` 作为 sediment 写侧 emit 的信号。三者都耓完之前§5 表是设计意图而非现实。 |

---

## 7. 边界自检

### 7.1 Invariant 边界

| # | ADR 0024 invariant | 本 ADR 检查 |
|---|---|---|
| 1 | INV-INVISIBILITY | 决策简报原文注在 system prompt 末尾不双重渲染到用户，但 LLM 可以表达"根据你偏好推荐 X" 让用户感知大脑参与决策。不要求用户审批/裁决。 ✓ 注: INV-INVISIBILITY = 用户不做管理工作，**不**= 运行状态隐藏（参 ADR 0024 §2 重写说明）。 |
| 2 | INV-AUTONOMY | `memory_decide` 是 LLM 自己的工具调用（它觉得需要才调）。大脑不会主动打断 LLM 或要求用户确认 ✓ |
| 3 | INV-IMPLICIT-GROUND-TRUTH | 矛盾检测（§3.3）靠的是用户主动纠错沉淀的 durable entry，不是大脑自己猜的 |
| 4 | INV-ACTIVE-CORRECTION | 用户否了简报里的建议 → 触发 ADR 0025 §4.1 主动纠错识别，形成闭环 ✓ |

### 7.2 AI-Native 原则

| 状态 | 检查 |
|---|---|
| ☑ PE-form | 决策点检测 + 决策简报生成 + 矛盾检测 + 推荐判断 → 全部走 LLM prompt |
| ☑ Infra | outcome 活跃度统计 + 简报注入隔离 + `memory_decide` 工具注册 → 机械路径 |
| ✗ Mech-on-LLM | 不搞决策类型枚举、不设简报格式 JSON schema、不搞推荐强度阈值 |

### 7.3 §4.2 反模式

- 不会出现 "大脑说你该选 X" → 大脑只给参考，不做替 LLM 决定
- 不会出现 "大脑想给你一个建议，确认吗？" → 不需要用户确认
- 不会出现 "本周大脑参与了 15 个决策——请审阅/确认每一条" → 不要求用户审批/裁决决策参与的结果。注：纯展示 "本周参与了 15 个决策" 不要求用户做事是合法的（INV-INVISIBILITY 不禁止，详 ADR 0024 §4.1 / §4.2 排除段），只是本 ADR 暂不打算做此类主动 push 报告

### 7.4 接受代价（新增）

| # | 代价 | 后果 |
|---|---|---|
| 10 | 决策简报的误导 | 大脑基于过时或错误的记忆给出建议，LLM 采纳后导致用户不满。缓解：矛盾检测（§3.3）部分覆盖；采纳/拒绝反馈（§5）持续校准；重要决策 LLM 可以调 `memory_decide` 而非被动接收简报 |

---

## 8. 相关记忆

- ADR 0025 v2.1 — "写"侧对偶，0025 六条写侧能力为本 ADR 提供原料
- ADR 0024 §4.1 — 隐式信号源（"用户接受/修改/拒绝 LLM 输出"）在决策简报采纳/拒绝中的兑现
- `prefer-prompt-engineering-over-mechanical-guards` (maxim) — 决策简报走自然语言不搞 JSON schema，同哲学
- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim) — 矛盾检测走 prompt 不走硬拦截
