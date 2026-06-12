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

### 3.0 路径 A v2 → v3 设计（post §3.1 walk-back 的统辖）

> **⚠️ 2026-05-28 新增**。本节在 §3.1 walked back 后补入，作为下文 §3.1-§3.4 / §5 / §7 部分论述的**当前实施统辖**。原 §3.x 中依赖 §3.1 schema 字段（`decision_type` / `whats_being_decided` / `options_on_table` / `constraints` / `is_decision_point`）或 brief-shape 形态的片段保留作历史 / 设计意图记录，**当前实施请以本节为准**。

#### 3.0.1 实际数据流（v2 落地，8bce502）

```
user turn + recent history
  ├─ query-rewriter LLM (deepseek-v4-flash)
  │     in: history (≤4 turns) + current msg
  │     out: { useful, query (200-800 char, multi-sentence) }
  ├─ if useful=false → skip silent
  ├─ llmSearchEntriesWithVerdict (stage1 + stage2 LLM rerank)
  │     stage 2 prompt 输出 { relevance_verdict, picks }
  ├─ if verdict=none → skip silent
  └─ if has_relevant → inject 含 compiledTruth 的 raw entries 到 system prompt
```

#### 3.0.2 关键设计选择

- ✅ 每轮跑 search，不作"决策点 vs 执行指令"二元区分（§3.1 walked back）
- ✅ rewriter LLM 自己判断 useful=true/false（不依赖关键词预过滤 / regex，跨语言成立）
- ✅ stage 2 LLM `relevance_verdict` 是 LLM-side strong cutoff（不是 score 阈值）
- ✅ 失败全路径 silent skip（INV-INVISIBILITY）
- ✅ sub-agent 不走路径 A（避免每个 dispatch 双倍成本；sub-agent 仍可以主动调 memory_decide / memory_search）
- ✅ path A inject 使用独立 anchor `path_a_inject_id`（不是 `decisionBriefId`，详 §5.1）
- ❌ 当前不走 brief synthesizer（§3.2 设计意图是 brief，实际 v2 是 raw entries + framing。GPT-5.5 P0 evaluation 推回 brief 形态，待 v3 决断）
- ❌ 当前不消费 outcome-ledger（§3.4 设计意图包含 outcome 摘要 注入，实际 v2 未实施；待 v3 决断）

#### 3.0.3 v3 路线图（3-T0 evaluation 2026-05-28 共识）

**P0（近期）**
- ~~**候选 C**: stage 1 LLM 看 full body (不只 frontmatter)——直接消除"stage 1 frontmatter-only"受制因素。需要 ADR 0015 二阶段 rerank prompt cache 妄协 walkback (cost 不再是约束)。~~ → **✅ DONE (2026-06-12, PR-E)**：`extensions/memory/llm-search.ts` 运行时 Stage 1 已改为 `surface:full_body_v3`，候选面包含 `compiled_truth` + `timeline`，并在 `search-metrics.jsonl` / `path-a-ledger.jsonl` 记录 `stage1_surface` 供前后对照。
- ~~**rewriter prompt 去旧成本偏置**: query-rewriter-v2.md 仍包含 "over-extraction is success" / "wasting stage-2 cost worse" 这类 v1 时代的 cost-saving framing，跟用户 directive "不计成本" 直接冒冲。~~ → **✅ DONE (verified 2026-05-30)**：活跃加载的 query-rewriter-v2.md（`extensions/memory/query-rewriter.ts:68`）现写 "cost is NOT a criterion" / "Do NOT return useful=false to 'save' downstream stage-2 cost" / "retrieval cost is not a constraint"（`prompts/query-rewriter-v2.md:134-140`），与用户 directive 一致；旧 framing 仅残留在**未加载**的 v1（`query-rewriter-v1.md:65`）。本 P0 项可移出待办。

**P1（中期）**
- **候选 H (HyDE)**: rewriter 同时输出 `hypothetical_memory_summary`——用"如果这个 turn 有完美记忆，应该是什么形状"补偿 stage 1 语义 gap。
- **候选 I (multi-query fan-out)**: rewriter 输出 1-3 个 angle 不同的 queries，并行 search，union + final stage 2 rerank。
- **候选 brief synthesizer**: 多一次 LLM 把 picks 合成 brief（回到 §3.2 设计意图）。
- **候选 outcome-ledger 读**: path A 注入时附 outcome 数据（兑现 §3.4 设计意图）。

**P2（dogfood 起点）**
- embedding pre-filter / stage 2 self-doubt / cross-provider stage 2 等待 ledger 数据决定。

#### 3.0.4 不做（3-T0 一致否决）

- regex prefilter / 5% LLM gate（§4.1.1 三选一全废）
- 24h cached topic profile（TTL 违反 INV-IMPLICIT-GROUND-TRUTH 实时性；实际上是跨 ADR 0024 §6 #5 二阶 distill cache，加速偏差累积）
- 单字段 trigger_phrases 不分 observed/predicted（writer LLM 预测被当 ground truth）
- 召回 < N 触发 second pass（机械门，§3 红线）

#### 3.0.5 与 §3.1-§3.4 原文的对应关系

| 原节 | 原设计意图 | v2 实施状态 |
|------|---------|--------------|
| §3.1 决策点识别 | LLM 检测 is_decision_point + 输出结构化决策场景 | **废**。改为 rewriter LLM 判 useful，不产出 decision_type / options_on_table 等字段 |
| §3.2 情境化回忆 | "决策参谋" brief 含综合建议 | **部分未实施**。v2 走 B1 (裸条目 + framing)，主 LLM 自己读裸条目。brief synthesizer 形态 v3 待定 |
| §3.3 矛盾感知 | brief prompt 加一段检查 | **隐式承担**。v2 不走 brief 后，矛盾感知是主 LLM 读 inject raw entries 时自己判 |
| §3.4 结果驱动推荐 | brief prompt 附 outcome 摘要 | **未实施**。v2 不消费 outcome-ledger。design gap，v3 候选 |

---

### 3.1 决策点识别

> **⚠️ 2026-05-28 walk back（路径 A 实现时用户层修订）**
>
> 本节原立场“决策点 vs 执行指令”二元区分**作为 ADR 明示立场被 walked back**。实施时用户层质疑这条立场隐含的 assumption “二元区分可靠检测”在实操上不成立：
>
> 1. **regex prefilter 跨语言不可行**——18 条中英 regex 永远 cover 不到日/西/法/俄等语言 surface；pi 是用户日常工具，中英专用隐含约束不成立。
> 2. **regex cover 不到表达开放性**——真实用户表达包括“这两个哪个香” / “听说 Bun 很猛” / “我看 Vue 现在好像也行” / 长背景 + “怎么办” 等隐式、模糊、多轮才浮现形态。
> 3. **§4.1.1 选择 3 全 LLM 检测被§4.1 自己拒绝**（每轮 +1-3s TTFT "不可接受"）。三选中三个都不成立。
>
> **修订后的走法**：放弃“决策点 vs 执行指令”二元区分，改为 **每轮都跑 memory_search**，由 search Stage 2 LLM **prompt-native** 决定“有没有相关记忆”：LLM 输出 `relevance_verdict: none` 时不注入，输出 `has_relevant` 时注入。cutoff 本身是 LLM 认知判断，不是 score 阈值。Query 由轻量 LLM 重写最近几轮 + 本轮凝练而成。
>
> **价值制约其他几节怎么读**：
>
> - §3.2 "情境化回忆" 仍然成立：注入的 summary 仍由 LLM 生成，不是裸条目拼接。但“决策简报”这个 framing 转为更中性的“相关记忆 summary”，不预设用户是在决策。
> - §3.3 "矛盾感知" / §3.4 "结果驱动推荐" 未受影响：Stage 2 LLM 在 has_relevant 时仍可以指出矛盾 / 读 outcome ledger。
> - §4.1.1 三选一设计全部作废（regex prefilter / 预热 / 全 LLM 检测）。
> - §4.2 路径 B (`memory_decide` tool) **不受影响**，这是独立的 LLM-拉式通道，仍然保留。
> - §6 实施路径 / §6.1 新文件清单重废（代以下面的“2026-05-28 实施状态"补牙）。
>
> **下文原 §3.1 保留** 作为历史记录（ADR walk-back 不采取“删临期内容”的做法）。后续读者过§3.1 原文时应以本注解为准。

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

> **⚠️ 2026-05-28 v2 状态**：本节 prompt schema 依赖 §3.1 字段 (`decision_type` / `whats_being_decided` / `options_on_table` / `constraints`)，§3.1 walked back 后这些字段在 v2 实施中不存在。本节 brief synthesizer 形态也**未在 v2 落地**（v2 直接注入 raw entries，主 LLM 自读）。**实际实施以 §3.0 为准**。下文保留作设计意图 / brief synthesizer v3 候选参考。

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

> **⚠️ 2026-05-28 v2 状态**：本节原设计是“跟 §3.2 是同一次 LLM 调用”。v2 不走 brief synthesizer 后，**矛盾感知是主 LLM 在读 inject raw entries 时隐式承担**（没有专门 prompt）。如果 v3 升 brief synthesizer，本节 prompt 文本可直接复用。

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

> **⚠️ 2026-05-28 v2 状态 (design gap)**：本节设计依赖"在 §3.2 决策简报 prompt 里附 outcome 摘要"。v2 不走 brief synthesizer 后，**outcome-ledger 未被 path A 消费**——当前 v2 inject 的 raw entries 不携 outcome 活跃度信息。以下设计意图 v3 待兑现（路径 B `memory_decide` tool 已兑现本节，实现于 ADR 0026 §4.2 + extensions/memory/decide.ts）。

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

> **⚠️ 2026-05-28 walk back**：下面的流程图依赖于 §3.1 "决策点检测"这个阶段，而 §3.1 本身已被 walked back（见该节顶部注解）。实际实现流程是：
>
> ```
> before_agent_start hook
>   ├─ query-rewriter LLM（轻量模型）：近 N 轮 + 本轮 → 收敛 query / 输出 no_useful_query
>   ├─ if no_useful_query → 跳过（静默）
>   ├─ memory_search（复用 llmSearchEntries）。Stage 2 prompt 加强 cutoff：
>   │   输出 relevance_verdict = none | has_relevant
>   ├─ if none → 跳过 inject（静默）
>   └─ if has_relevant → 生成 summary 注入 system prompt 末尾
> ```
>
> 下文原 §4.1 流程图 **作为历史记录保留**。

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

### 4.1.1 P1 路径 A 实现前的设计选择（R1 P1-10 补补）

> **⚠️ 2026-05-28 walk back**：下面三选一设计选择都依赖 §3.1 “决策点 vs 执行指令二元区分”这个前提。该前提被 walked back 后，三个选择都作废：
>
> - 选择 1 regex 预过滤 → 跨语言不可行 + cover 不住表达开放性
> - 选择 2 agent_end 预热 → 还是需要“预判下轮是不是决策点”，同样需要不可行的二元区分
> - 选择 3 全 LLM 检测 → §4.1 自己拒绝了，且即使接受也仅是二元判断的量换
>
> 修订后的设计（§3.1 walk-back 注解中详述）不再需要决策点检测阶段。下文原 §4.1.1 保留为历史记录。

R1 review DeepSeek 指出路径 A 未实现前需提前绑定 TTFT 缓解路径，避免实现后用户看到「创造倍变延迟」严重回退。这里记录三个公设计选择 + 默认推荐：

**选择 1：超轻量 regex 预过滤（默认推荐）**
- LLM 检测决策点在 5% 轮次运行，剩下 95% 走 regex 预检（“选择”「怎么选」「A 还是 B」等关键词）
- regex 命中才启 LLM 检测。未命中 → 不走路径 A，TTFT 不受影响
- 代价：regex 可能漏检某些隐式决策点，但那些交由路径 B 补付

**选择 2：上一轮 `agent_end` 预热**
- 上一轮结束后预计本轮输入可能是决策点（上轮 LLM 输出中含选项），在 `agent_end` 后后台生成决策简报，本轮用户输入时 cache 已热
- 代价：预热中率需改善；未命中的轮次预热成本浪费
- 依赖点：预热 cache TTL 与轮间间隔匹配

**选择 3：全 LLM 检测（原始设计）**
- 每轮输入都跑决策点 LLM 检测，检到则跑简报，未检到则不跑
- 代价：TTFT 增 3-5s 在 100% 轮次（不可接受）

**默认选择 1**（regex 预过滤）：P1 实现路径 A 的首价设计。选择 2 可以为 P2 补加。选择 3 被明确拒绝。

**实现状态 (2026-05-27)**：路径 A 未实现。需要实现时按默认选择 1 设计。R1 P1-10 被重新分类为 P2-with-design-binding：TTFT 缓解路径已预先绑定，P1 不再是 silent risk，只在路径 A 建设时起作用。

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
| §4.4 multi-view verification | 高置信 durable entry 在决策简报里被标记为"明确偏好"（vs "可能偏好"）。**⚠️ P0.5 现状 (2026-05-24 batch 7 补记)**: multi-view R-series 当前仅以 audit/staging 形式存在。`memory_decide` v1 **不**消费 `CuratorAudit.multi_view` 或 `multi-view-metrics.jsonl`；MemoryEntry frontmatter 也未附加 `multi_view_verified: true` 字段。另外 v1 `writeApprovedToBrain` 是 stub (ADR 0025 §4.4.6 D)，意味着 staging replay 后 reviewer-approved entry 不保证进脑。 **⚠️ update (2026-05-27, commit 2b11184)：此 stub 已关闭——`writeApprovedToBrain` 接入真实 dispatcher `executeCuratorDecisionToBrain({dryRun:false})`（`extensions/sediment/index.ts:3439`），staging replay reviewer-approved entry 现在保证进脑；下文生效条件 (a) 已满足，(b) decision brief 消费 multi_view + (c) frontmatter `multi_view_verified` 仍未实施。**本行描述的"明确偏好 vs 可能偏好"区分是 P1+ 目标，仅在 (a) writer dispatch v2 接入 + (b) decision brief prompt 加 verified 字段 + (c) MemoryEntry frontmatter 加 `multi_view_verified` 后生效。 |
| §4.6 静默归档 | 归档 entry 不出现在记忆召回中，自然不进决策简报 |

**反过来，本 ADR 也喂 0025**：
- 决策简报中 LLM 采纳了某条建议 → outcome 写 DECISIVE + 简报批注
- 决策简报中 LLM 看了但没采纳 → outcome 写 RETRIEVED-UNUSED + 不采纳原因
- 用户否了简报里的建议 → 触发 ADR 0025 §4.1 主动纠错识别（"不是这个" = correction signal）

### 5.1 decision_brief_id schema + outcome ledger anchor field layout（R1 P1-7 补补）

上面的反向嗂合不能只在纲领层描述。“采纳了”、“看了不采纳”这类信号要能跨 turn 跨 layer join，需要 explicit schema。本小节定义。

#### decision_brief_id 形状

每份 `memory_decide` 调用产出的决策简报在父层是一个事件，id 形状：

```
decision_brief_id = `${session_id}|${turn_id}${subturn ? `.${subturn}` : ""}|${monotonic_brief_seq_in_turn}`
```

- `session_id` / `turn_id` 来自 ADR 0027 §C6 anchor
- `subturn` 只在 sub-agent 调 `memory_decide` 时出现（L2 worker 如果获得 `memory_decide` 能力且调用了，用 sub-agent 的 anchor）
- `brief_seq_in_turn` 从 1 开始；同一 turn 多次调 `memory_decide` 递增。这个计数器跟踪“同 turn 里某条 entry 是第几份简报里被引用的”问题

这个 id 在 `memory_decide` 返回值里作为 `decisionBriefId` 字段（现代码 §3.2 prompt template 已提及）。LLM 在 memory-footnote 里可以反向引用以关联 attribution。

#### path_a_inject_id schema (v2, 2026-05-28)

路径 A 注入事件使用**独立 anchor**不是 `decisionBriefId`（那是 memory_decide tool / 路径 B 专用）。形态：

```
path_a_inject_id = `path-a-${ts.toString(36)}-${random8chars}`
```

**为何独立 id space**：路径 A 在 `before_agent_start` hook 跑，此时 turn_id **还未分配** (turn_id 由 turn_start 事件分配，hook 在 turn_start 之前)。生成独立 id 避免锚点错位。

**outcome-ledger join 时**：
- 主 LLM 在 turn 内调 memory_decide → outcome row 含 `decision_brief_id`
- 路径 A 在同 turn inject → path-a-ledger row 含 `path_a_inject_id`
- 两 ledger 通过 (session_id, turn_id) join，但 anchor 字段不同

**与 ADR 0027 §C6 关系**：path_a_inject_id 是 path A 独立间接 anchor。

> **Walk-back（2026-05-29，自治演进 Stage 1）**：上文"path-a-ledger 默认
> 走 spreadAnchor(undefined)、turn_id 当前不需要"已被实施层 walk back。
> path-a-ledger 现在每行都 stamp `spreadAnchor(getCurrentAnchor())`
> （session_id + turn_id [+ subturn/device_id]），缺锚时显式标
> `anchor_missing:true`（C5 fail-degrade，行仍写）。这样 ADR 0026 §5.1
> 的 (session_id, turn_id) join 在 **path-a 侧也真正可实现**，不再只靠
> path_a_inject_id 这条独立 id。
>
> 原 deferral 的顾虑是"path A 在 before_agent_start 跑、turn_id 尚未分配"。
> 实现层用的是 causal-anchor 自己的 before_agent_start turn-bump（不是 pi 的
> turn_start），且通过 canonical-owner 加固消除了 cross-extension handler
> 顺序依赖：memory 扩展在 activate 顶部调用 **幂等的** `bindLifecycle(pi)`，
> 保证 turn-bump handler 一定先于 Path A 的 reader 注册 —— 因此 Path A 读到
> 的 turn_id 与同 turn 的 outcome-ledger 行一致，且 dispatch 缺席时锚点仍可用。
> path_a_inject_id 继续保留为 inject 级别的细粒度 id。

#### outcome-ledger 行 anchor 字段布局

ADR 0025 §4.2.4 定义了 outcome-ledger 的基本字段。本 ADR R1 P1-7 补上与 C6 锚点的 join 字段安排：

```jsonc
{
  // 原有字段（ADR 0025）
  ts: "2026-05-27T16:23:04.123Z",
  session_id: "019e…",
  entry_slug: "prefer-pnpm",
  source: "memory-footnote" | "tool-result",
  // R1 P1-3 加（spread anchor 产生的字段）
  turn_id: 47,                  // anchor.turn_id
  subturn: 2,                   // 仅 sub-agent 调时出现
  // R1 P1-7 加（决策丰产生信号时才出现）
  decision_brief_id: "019e…|47|1",
  used: "decisive" | "confirmatory" | "retrieved-unused",
  counterfactual: "…",
  // 原有字段 cont.
  project_root: "…",
}
```

#### Join 路径

```
# 合并一个 turn 的 L1/L2 outcome 信号
jq 'select(.session_id == X and .turn_id == Y)' outcome-ledger.jsonl

# 某条简报被使用的所有信号
jq 'select(.decision_brief_id == "X|Y|N")' outcome-ledger.jsonl

# 同 turn 同 entry 被多份简报引用的情况
jq 'select(.session_id == X and .turn_id == Y and .entry_slug == "prefer-pnpm")' outcome-ledger.jsonl
```

#### 与 ADR 0027 §C6 的关系

- `(session_id, turn_id)` 是 C6 必需的 join 键，outcome-ledger 现在透过 spreadAnchor 自动携带（实现于 R1 P1-3 commit `7dd224b`）
- `decision_brief_id` 是 §3.4 "结果驱动推荐" 与 §4.1 路径 A 的归因链接头，aggregator 读此字段可以反查 “这次决策丰里包括哪些 entry、哪些被采纳、哪些被忽略”
- 后续如果加入 ADR 0025 §4.4 multi-view 验证状态作为决策丰输入，`decision_brief_id` 纲领 outcome 行能反向追踪“哪些 verified entry 被引用了、采纳率多高”这种跨能力点的联合分析

---

## 6. 实施路径

### 6.1 新文件

> **⚠️ 2026-05-28 walk back**：下面原计划的 `decision-detector.ts` / `decision-briefer.ts` 作废（§3.1 二元区分被 walked back）。实际新文件是：
>
> - `extensions/memory/query-rewriter.ts` (+`prompts/query-rewriter-v1.md`) — 轻量 LLM 重写最近几轮 + 本轮为 search query
> - `extensions/memory/memory-context-injector.ts` (+`prompts/memory-summary-v1.md`) — 路径 A 主流程 注入 before_agent_start
> - `extensions/memory/llm-search.ts` §stage2 prompt 修订加 `relevance_verdict` 字段（修现有文件，不是新文件）
> - `.abrain/.state/memory/path-a-ledger.jsonl` — instrumentation ledger
>
> 下文原表保留作为历史记录。

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
| **ADR 0026 §5 本身 (2026-05-24 batch 7 T0 review 补记)** | §5 表中 §4.4 multi-view 行加“P0.5 现状”脚注，明确说明当前是写侧 audit/staging infra，decision brief v1 不消费 multi-view 产出。其 P1+ 生效条件：(a) writer dispatch 从 v1 stub 升级 v2；(b) decision brief prompt 增加 `multi_view_verified` 警示字段；(c) MemoryEntry frontmatter 增加 `multi_view_verified: true` 作为 sediment 写侧 emit 的信号。三者都耓完之前§5 表是设计意图而非现实。 **⚠️ update (2026-05-27, commit 2b11184)：(a) writer dispatch 已从 v1 stub 升级为真实写脑（replay reviewer-approved entry 保证进脑）；(b)(c) 仍未满足。** |

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
| ☑ PE-form (v1 设计意图) | 决策点检测 + 决策简报生成 + 矛盾检测 + 推荐判断 → 全部走 LLM prompt |
| ☑ PE-form (v2 实施, 2026-05-28) | rewriter LLM 判 useful + 写 query / Stage 1 LLM candidate select / Stage 2 LLM rerank + verdict cutoff → 全部走 LLM prompt。§3.1 二元决策点检测 walked back，§3.2 brief synthesizer 未落地 (v3 候选)，§3.3 矛盾感知隐式由主 LLM 读 inject 时承担，§3.4 outcome 摘要未落地 (v3 候选)。详 §3.0。 |
| ☑ Infra | outcome 活跃度统计 + 简报注入隔离 + `memory_decide` 工具注册 + path-a-ledger / `path_a_inject_id` anchor → 机械路径 |
| ✗ Mech-on-LLM | 不搞决策类型枚举、不设简报格式 JSON schema、不搞推荐强度阈值、不用 score 阈值 cutoff (请看 ADR 0024 §3.3 “retrieval pipeline relevance cutoff” 行) |

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
