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

现有 LLM 跟大脑的互动只有一种：LLM 自己想起来调 `memory_search` → 拿回 3-5 条摘要 → 必要时 `memory_get` 取全文 → 融进推理。工具注册 @ `extensions/memory/index.ts`，描述建议在 planning / design / review 时搜。

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

我 v1 写的本质是**推送系统**（大脑观察上下文 → 判断"该推了" → 选几条 → 控制剂量 → 塞给 LLM）。

问题：LLM 拿到的是**原始记忆**。它还得自己理解为啥这条现在相关、跟其他条目有没有冲突、过去的 outcome 是好是坏。大脑做完了第一步（"找出来"）就把所有推理负担扔给 LLM 了。

用户要的是**参与系统**：LLM 到达决策点 → 大脑主动给情境化建议（基于过去选择列出相关条目 + outcome + 综合建议，并提示矛盾），而不是丢原始记忆让 LLM 自己消化。

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

> 本节在 §3.1 walked back 后补入，作为下文 §3.1-§3.4 / §5 / §7 部分论述的设计统辖。原 §3.x 中依赖 §3.1 schema 字段（`decision_type` / `whats_being_decided` / `options_on_table` / `constraints` / `is_decision_point`）或 brief-shape 形态的片段保留作设计意图记录；规范性判断以本节为准。

#### 3.0.1 设计数据流

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

- 每轮跑 search，不作"决策点 vs 执行指令"二元区分（§3.1 walked back）。
- Rewriter LLM 自己判断 `useful=true/false`，不依赖关键词预过滤 / regex，跨语言成立。
- Stage 2 LLM `relevance_verdict` 是 LLM-side strong cutoff，不是 score 阈值。
- 失败全路径 silent skip，符合 INV-INVISIBILITY。
- Sub-agent 不走路径 A，避免每个 dispatch 双倍成本；sub-agent 仍可以主动调 `memory_decide` / `memory_search`。
- Path A inject 使用独立 anchor `path_a_inject_id`，不是 `decisionBriefId`，详 §5.1。
- Brief synthesizer 与 outcome-ledger 消费是 v3 候选，不是路径 A v2 的硬前提。

#### 3.0.3 v3 候选路线

**P0（近期）**
- **候选 C**：Stage 1 LLM 看 full body，不只 frontmatter；候选面应包含 `compiled_truth` + `timeline`，并记录 `stage1_surface` 供前后对照。
- **Rewriter prompt 去旧成本偏置**：活跃 rewriter prompt 必须明确 retrieval cost is not a constraint，禁止为了节省 downstream stage-2 cost 而返回 `useful=false`。

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

| 原节 | 原设计意图 | 本节裁定 |
|------|---------|--------------|
| §3.1 决策点识别 | LLM 检测 is_decision_point + 输出结构化决策场景 | 二元决策点检测作废；改为 rewriter LLM 判 useful，不要求产出 decision_type / options_on_table 等字段 |
| §3.2 情境化回忆 | "决策参谋" brief 含综合建议 | Brief synthesizer 是 v3 候选；路径 A 可先走裸条目 + framing，让主 LLM 自读 |
| §3.3 矛盾感知 | brief prompt 加一段检查 | 没有 brief 时由主 LLM 读 inject raw entries 时判断；有 brief 时再由 brief prompt 显式处理 |
| §3.4 结果驱动推荐 | brief prompt 附 outcome 摘要 | Outcome-ledger 消费是 v3 候选，不是路径 A 最小形态前提 |

---

### 3.1 决策点识别

> 本节原立场“决策点 vs 执行指令”二元区分**作为 ADR 明示立场被 walked back**。用户层质疑这条立场隐含的 assumption “二元区分可靠检测”在实操上不成立：
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
> - §6 实施路径 / §6.1 新文件清单中的 `decision-detector.ts` / `decision-briefer.ts` 不再是路径 A 最小形态前提。
>
> **下文原 §3.1 保留** 作为被取代的设计意图。后续读者过 §3.1 原文时应以本注解为准。

（原文为被取代的设计意图：二元决策点检测 prompt + 触发条件。规范裁定见 §3.0；逐字原文见 git history。）

### 3.2 情境化回忆

> 本节 prompt schema 依赖 §3.1 字段 (`decision_type` / `whats_being_decided` / `options_on_table` / `constraints`)；§3.1 walked back 后，这些字段不再是路径 A 最小形态前提。本节保留作 brief synthesizer v3 候选参考；规范性裁定以 §3.0 为准。

brief synthesizer 是 v3 候选；路径 A v2 走裸 entry + framing，让主 LLM 自读（规范裁定见 §3.0）。保留两条仍然有效的约束：

- **provisional staging 条目（`attribution_pending=true`）不准进任何"用"侧决策**：它是分类器未确认猜测，不是用户事实；当 confirmed preference 推给 LLM 会让大脑"自己编偏好再自己信"。仅等 0025 staging resolution 确认/废弃。
- **brief 形态用自然语言而非 JSON**：JSON 迫使拆字段，丢失跨条目综合判断（"偏好 pnpm" + "试 yarn 后改回" 放一起才看出是"试错后确认的偏好"）。

（原 brief synthesizer prompt 见 git history。）

### 3.3 矛盾感知

> 本节原设计是“跟 §3.2 是同一次 LLM 调用”。当路径 A 不走 brief synthesizer 时，矛盾感知由主 LLM 在读 inject raw entries 时隐式承担；如果后续升级 brief synthesizer，本节 prompt 文本可直接复用。

**决策（不受 §3.1 walk-back 影响）**：矛盾感知是 INV-ACTIVE-CORRECTION 在"用"侧的兑现——记住的明确偏好（高置信 durable）与当前选择冲突时，大脑**提醒而不阻止**。路径 A v2 由主 LLM 读 inject 的 raw entries 时隐式承担；升级 brief synthesizer 后可由 prompt 显式处理（原 prompt 见 git history）。不硬拦截的理由：大脑无法判断用户是否改主意，提醒后 LLM 可改用、可跟用户确认、也可按项目需求覆盖。

### 3.4 结果驱动的推荐

> 本节设计依赖“在 §3.2 决策简报 prompt 里附 outcome 摘要”。当路径 A 不走 brief synthesizer 时，raw entries 不携 outcome 活跃度信息；因此 outcome-ledger 消费是 brief synthesizer / `memory_decide` 形态的设计要求。

**决策**：用户过去的决策结果影响现在建议的**力度**——活跃条目强推荐、冷条目弱参考、被否过的提醒但不推荐。数据源是 outcome-ledger（ADR 0025 §4.2.4）的 timestamp + used 字段；近 30 天活跃度/倾向统计是 Infra 行为（读文件统计，不需 LLM）。outcome-ledger 消费是 brief synthesizer / `memory_decide` 形态的设计要求，不是路径 A v2 最小前提（原 outcome 摘要 prompt 见 git history）。

**⚠️ 防止回声室**：大脑推荐 A → LLM 采纳 → outcome 记 DECISIVE → 下次大脑更强推 A → LLM 更倾向采纳 A → 循环。这个正反馈会让大脑把自己的推荐当成"用户确认过的偏好"，而实际上用户只是没反对。断路器：同一条目连续 5 次被 DECISIVE 使用且期间用户没有产生任何主动纠错信号（说明用户没反对但也没主动确认）→ aggregator（0025 §4.3）自动把这条标记为"pending reconfirmation"——下次决策简报里不再推荐为"明确偏好"，降级为"之前你经常用，但最近没有明确确认过"。这个降级不是归档、不是删除——只是让大脑的推荐语气从"你应该"变成"你之前好像"。

---

## 4. 怎么落地——两条互补路径

### 4.1 路径 A：决策简报（主路径，agent_turn 触发）

> 路径 A 的统辖流程见 §3.0.1（before_agent_start → rewriter 判 useful → memory_search + Stage 2 verdict cutoff → silent skip 或 inject）。原依赖 §3.1 决策点检测的 agent_turn 流程已 walked back。

**注入方式**：决策简报放在本轮 system prompt 末尾（统辖流程见 §3.0.1）。

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

**设计裁定**：原三个 TTFT 缓解选择（regex 预过滤 / agent_end 预热 / 全 LLM 检测）都依赖被 walked back 的二元决策点区分，已作废（理由见 §3.0.4 / §3.1）。路径 A 的 TTFT 缓解改由 §3.0 silent-skip 搜索链路承担：rewriter 判 `useful=false` 直接跳过、Stage 2 判 `relevance_verdict=none` 不注入。

### 4.2 路径 B：即时深潜（辅助路径，LLM 主动调）

有些决策是 LLM 在推理过程中才意识到的——不是用户直接问"用 X 还是 Y"，而是 LLM 发现"等等，这里有三个可能的实现方式，我得选一个"。这种决策点在 §3.1 的检测 prompt 里不一定能预先抓到。

**给 LLM 一个新工具 `memory_decide(context, options?, constraints?)`**：返回一份 ≤500 token 决策简报，格式同路径 A；区别是 LLM 主动要的，不是大脑推的。

**跟路径 A 的关系**：
- 路径 A：大脑**推**（检测到决策点 → 主动给简报）
- 路径 B：LLM **拉**（自己意识到在决策 → 调 memory_decide）

两路径互补——路径 A 覆盖显式决策点，路径 B 覆盖隐式决策点。底层用的是同一套 prompt（§3.2），只是触发方式不同。

### 4.3 INV-INVISIBILITY 怎么保证

**误读重点**：本节原领发版本措辞暗示 "大脑运作必须对用户不可见" 才是 INV-INVISIBILITY。该措辞容易被误读为"运行状态都要藏起来"。本 ADR 澄清：INV-INVISIBILITY 原意 = 用户不参与大脑管理，**不是**"大脑运行状态藏起来"。

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
| §4.4 multi-view verification | 高置信 durable entry 在决策简报里可以被标记为“明确偏好”（vs “可能偏好”）。这一区分只有在写侧 reviewer-approved entry 保证进入 brain、decision brief prompt 消费 multi-view 信号、且 MemoryEntry frontmatter 提供 `multi_view_verified: true` 这三个条件都满足后才生效；否则只能作为设计意图，不得在简报里伪装成已验证事实。 |
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

> Path A ledger 应优先 stamp 当前 causal anchor（`session_id + turn_id [+ subturn/device_id]`）；缺锚时显式标 `anchor_missing:true`，行仍写入，以便 C5 fail/degrade 语义可观测。`path_a_inject_id` 保留为 inject 级别细粒度 id，但不替代 `(session_id, turn_id)` join。

#### outcome-ledger 行 anchor 字段布局

ADR 0025 §4.2.4 定义了 outcome-ledger 的基本字段。本 ADR R1 P1-7 补上与 C6 锚点的 join 字段安排：

基础字段 ts / session_id / entry_slug / source / project_root 上，本 ADR 补 C6 join 字段：`turn_id`（anchor.turn_id）、`subturn`（仅 sub-agent 调时）、`decision_brief_id`、`used`、`counterfactual`（决策简报产生信号时才出现）。

#### Join 路径

`outcome-ledger.jsonl` 按 `(session_id, turn_id)` 合并一个 turn 的 L1/L2 信号、按 `decision_brief_id` 取某份简报被使用的全部信号、按 `(session_id, turn_id, entry_slug)` 查同 turn 同 entry 多份简报引用。

#### 与 ADR 0027 §C6 的关系

- `(session_id, turn_id)` 是 C6 必需的 join 键，outcome-ledger 必须通过 causal anchor 自动携带。
- `decision_brief_id` 是 §3.4 "结果驱动推荐" 与 §4.1 路径 A 的归因链接头，aggregator 读此字段可以反查 “这次决策丰里包括哪些 entry、哪些被采纳、哪些被忽略”
- 后续如果加入 ADR 0025 §4.4 multi-view 验证状态作为决策丰输入，`decision_brief_id` 纲领 outcome 行能反向追踪“哪些 verified entry 被引用了、采纳率多高”这种跨能力点的联合分析

---

## 6. 实施路径

### 6.1 新文件

> 下面原计划的 `decision-detector.ts` / `decision-briefer.ts` 不再是路径 A 最小形态前提（§3.1 二元区分被 walked back）。路径 A 的最小文件边界是：
>
> - `extensions/memory/query-rewriter.ts` (+`prompts/query-rewriter-v1.md`) — 轻量 LLM 重写最近几轮 + 本轮为 search query
> - `extensions/memory/memory-context-injector.ts` (+`prompts/memory-summary-v1.md`) — 路径 A 主流程 注入 before_agent_start
> - `extensions/memory/llm-search.ts` §stage2 prompt 修订加 `relevance_verdict` 字段（修现有文件，不是新文件）
> - `.abrain/.state/memory/path-a-ledger.jsonl` — instrumentation ledger
>
> 下文原表保留作为历史记录。

新文件：`decision-briefer.ts`（§3.2 情境化回忆 + §3.3 矛盾检测）、`memory-decide-tool.ts`（§4.2 工具注册）+ `prompts/decision-brief-v1.md`。注：§3.1 二元决策点检测已被 §3.0 取代，`decision-detector.ts` 不再是路径 A v2 前提。

### 6.2 改动现有文件

| 文件 | 改动 |
|---|---|
| `extensions/memory/index.ts` | 注册 `memory_decide` 工具 |
| `extensions/sediment/index.ts` | `before_agent_turn` hook 加决策点检测 + 决策简报注入 |
| `extensions/sediment/writer.ts` | outcome-ledger 读接口（供 §3.4 统计活跃度） |

### 6.3 Phase 安排

**⚠️ R10 审计发现的 bootstrap 死锁**：0026 的价值依赖 0025 产出的语料（durable entry + outcome 数据），但 0025 的语料依赖 `autoLlmWriteEnabled: true`，而 `autoLlmWriteEnabled` 改 true 又要等 0025 P1-P5 具备并验证完。这是"先有鸡还是先有蛋"。

**怎么解**：0026 分两层建设。

**第 1 层（P0a，独立最小层）**：`memory_decide` 工具的骨架——注册工具、写好 50 行精简版简报 prompt（只包装 `memory_search` 结果，不含 outcome 数据、不含矛盾检测、不含 provisional staging）。这层对 0025 零依赖。用户在开 `autoLlmWriteEnabled: true` 之前，`memory_decide` 搜到的是已有的手动 fence 记忆 + legacy `.pensieve/` 数据——不是空的，但质量参差。这已经比"LLM 自己调 memory_search 然后自己理解"强了。

**第 2 层（P1，等 0025 有数据后）**：完整版决策简报（含 outcome 摘要 + 矛盾检测）。在 0025 P1 能力具备且积累 1-2 个月的 outcome 数据后启动。

Phase：P0 = `memory_decide` 工具最小版（路径 B，依赖 ADR 0025 P0）；P1 = 决策点检测 + 路径 A 自动注入完整版（依赖 ADR 0025 P1 主动纠错 + P2 outcome）；P2 = 简报采纳/拒绝反馈回 outcome-ledger（§5 反向喂 0025）。工程量/依赖详见 [`../roadmap.md`](../roadmap.md)。

**关键**：P0 不需要等 ADR 0025 的上游能力——`memory_decide` 是自包含的（当前决策上下文 + 召回条目 → 决策简报），LLM 可直接用。

P1 需要等 ADR 0025 P1（主动纠错）和 P2（outcome），因为矛盾检测靠 active correction 的 durable entry，outcome 摘要靠 outcome-ledger。但这两个阻塞不严重——P0 已经提供了最小可用的"大脑参与决策"体验。

### 6.4 反向 patch

| 下游 | patch |
|---|---|
| ADR 0025 §4.2 | outcome-ledger schema 加 `decision_brief_id` 字段——如果 outcome 是来自决策简报的采纳/拒绝，记录对应的简报 ID |
| ADR 0025 §4.1 | 主动纠错触发条件加一条：决策简报中的建议被用户明确否了 |
| ADR 0024 §6 | 接受代价表加第 10 条：决策简报的误导（大脑基于过时信息给了错误建议） |
| **ADR 0026 §5 本身** | §5 表中 §4.4 multi-view 行必须说明其生效条件：writer dispatch 保证 reviewer-approved entry 进入 brain；decision brief prompt 消费 multi-view 信号；MemoryEntry frontmatter 提供 `multi_view_verified: true`。三者都满足前，§5 表只是设计意图，不是当前事实。 |

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
| ☑ PE-form (路径 A 最小形态) | rewriter LLM 判 useful + 写 query / Stage 1 LLM candidate select / Stage 2 LLM rerank + verdict cutoff → 全部走 LLM prompt。§3.1 二元决策点检测被取代，§3.2 brief synthesizer、§3.4 outcome 摘要是 v3 候选；详 §3.0。 |
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
