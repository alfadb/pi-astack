# ADR 0026 — 第二大脑的感知与使用时序

- **状态**：R0 草案（2026-05-22）。本 ADR 是 [ADR 0025](0025-sediment-meta-curator-subsystem.md) 的"用"侧对偶——0025 专注"怎么写对"，0026 专注"怎么在合适时机用出来"。
- **基准**：[ADR 0024](0024-second-brain-from-natural-conversation.md) 的四条 invariant + AI-Native 原则。本 ADR 不重复论证。

**为什么需要这份 ADR**：写进去只是第一步。用户感觉不到 sediment 怎么写，但用户能感觉到——"大脑明明记着这条偏好，为什么没在合适时机提醒？" 这半边的设计空缺让整个 ADR 0024 设想只走了一半。

---

## 0. 起草说明

### 这份文档只写

- 当前"用"侧的真实形态（§1）
- "用"侧四个机制的设计：上下文感知注入 + 优先级排队 + 剂量控制 + 实时反馈（§3）
- 跟 ADR 0025 写侧的联动——写完的条目怎么影响注入行为（§4）
- 实施路径 + 挂载点（§5）

### 这份文档不写

- ADR 0024 invariant / AI-Native 的重述——那是 0024 的事
- ADR 0025 六条写侧能力的重复——那是 0025 的事
- prompt 级别的完整 text——R1 展开

---

## 1. 代码现实：现有的"用"侧就两样东西

### 1.1 LLM 自己想搜才搜

`memory_search` 工具 @ `extensions/memory/index.ts:296`。LLM 调用它时走两阶段语义召排（ADR 0015），返回摘要。LLM 可以接着调 `memory_get` 拿全文。

**核心特征**：**完全被动**。LLM 没想起来调 `memory_search` = 这条记忆白写了。LLM 在什么情况下会想起来调？靠工具描述里的一句话："Use memory_search before planning, designing, reviewing code"。这句话走的是 LLM 的 instruction-following，不是大脑的主动推送。

### 1.2 ADR 0023 死板注入

ADR 0023 R4 定了双 tier 注入 @ session_start：

| Tier | 注入方式 | Token 上限 |
|---|---|---|
| `always` | 全文注入 system prompt | ≤ 2.5K |
| `listed` | 只注 slug + title 列表 | ≤ 1.5K |

注入时机：`before_agent_start` hook @ `session_start`（reason ∈ startup/new/resume/fork/reload）。

**核心特征**：**不管上下文**。你开一个 React bugfix session，它照样塞"用 pnpm 不用 yarn"；你开一个 Python 数据分析 session，它还是塞那条。不是这条规则没用——是注入时机跟对话内容完全脱节。而且 `always` tier 的 token 预算是固定的 2.5K，不管塞了 2 条还是 15 条，占用的上下文窗口是固定的。

### 1.3 事后统计（outcome footnote）

ADR 0025 §4.2 设计的是事后收集"用没用"——entry 被用了之后在 response 末尾写个 `memory-footnote`。这是"写"侧的数据收集，不改变**当前会话**的注入行为。

### 1.4 缺什么——一句话总结

```
现状：大脑把记忆存好，等 LLM 自己来翻。
缺的：大脑观察你在干什么，在合适的时机主动把该用的记忆摆到 LLM 面前。
```

具体缺四样：

| 缺什么 | 具体表现 |
|---|---|
| **上下文感知** | 大脑不知道当前会话在干什么——React 项目还是 Python 项目？新功能开发还是修 bug？它一概不知，所以没法判断"现在该推哪条" |
| **优先级排队** | 所有 `always` 条目一律平等——三天前设的"用 pnpm"跟三个月前设的"用 yarn"（已被 supersede）在注入时没有优先级差别 |
| **剂量控制** | always 2.5K + listed 1.5K = 死板预算，不管当前对话上下文是否已经够丰富。低上下文会话（用户刚开终端）可能该多推，高上下文会话（长篇代码 review）该少推 |
| **实时反馈** | 主会话 LLM 用了某条 entry、用户否了某条 entry、用户沉默接受了某条 entry——这些信号没有被用来调整**当前会话**的注入行为 |

---

## 2. 设计原则（从 ADR 0024 搬，不重述）

- **INV-INVISIBILITY**：用户感觉 "LLM 刚好知道我的偏好"，不感觉 "大脑在推送"
- **INV-IMPLICIT-GROUND-TRUTH**：注入策略的调整靠隐式信号（用户用了/否了/沉默了），不靠用户显式管理
- **AI-Native**：时机判断走 LLM prompt，不走规则引擎

---

## 3. 四个"用"侧机制

### 3.1 上下文感知注入（context-aware injection）

**目标**：大脑在每次 agent_end（或 agent_start、或在用户发新消息后）观察当前对话窗口，判断"现在该推哪些记忆"。

**不取代 ADR 0023 always/listed**——always 规则在任何上下文都是安全的（"用 pnpm" 在什么项目都有用）。但这条信息**怎么告诉 LLM** 可以从 "强行塞进 system prompt" 改为 "在合适的时机自然提一句"。比如用户开了 React 项目、LLM 输出 `pnpm add` 建议——这时候在 LLM 的 context 里轻轻加一句 "（brain note: 用户偏好 pnpm 而非 yarn）"，比 session_start 就塞进去自然得多。

**现在说具体怎么做**：

`agent_end` hook（跟 ADR 0025 §4.1 classifier 跑完之后）追加一个步骤。这一步跑一个轻量 prompt：

```
你是第二大脑的上下文观察者。下面是当前会话的最近对话窗口。用户
正在做什么类型的任务（写代码 / 查文档 / 修 bug / 部署 / 决策技术
选型 / 学新东西 / 其他）？涉及的领域（React / Python / Rust / 
DevOps / 数据库 / 其他）？

现在有一些记忆条目跟这个会话相关。给出建议：
- 哪些条目当前会话**该主动推给 LLM**（因为任务类型 + 领域高度相关）
- 哪些条目**先不推**（因为跟当前任务无关，推了反而干扰）
- 对每条建议的条目，标注"为什么不早不晚现在推"——1-2 句理由

你的选择不是决定性的——只是建议。下游的优先级排队（§3.2）会做
最终排序。

输出的格式：
{
  "session_profile": "<2-3 句话描述当前会话的任务类型 + 领域>",
  "suggested_push": [
    {"slug": "...", "reason": "..."},
    ...
  ],
  "defer": [
    {"slug": "...", "reason": "..."},
    ...
  ]
}
```

**输入**：最近 N 条对话（对应 Lane C 的 `conversation_window`，已 sanitize）+ `always` tier 的条目列表 + `listed` tier 的条目列表。

**输出**：`suggested_push` 清单 + 每条的理由。这个清单不直接控制注入——交给下一个环节（§3.2 优先级排队）。

**时机**：agent_end 末尾、agent_start 开头——两个时机都可以跑。agent_start 时机更好（能覆盖新会话从头开始的情况），但 agent_end 时机能利用刚跑完的 classifier 的 staging_context 和 correction_signal 产物。**建议两处都跑**：agent_start 跑一次基础上下文感知，agent_end 跑一次增量（加本次会话的 outcome 和 correction 信息）。

**为什么不是 agent_end 后才处理、等到下个 agent_start 再注入**：因为当前会话自己也需要感知——用户在会话中说"以后用 pnpm"，classifier 识别为 durable correction。同会话后续的 LLM 回复还推荐 yarn 的话就尴尬了。所以：

- `agent_end` 产出 → 更新 injection manifest（§3.2 的优先级队列）
- 同会话的**下一次 agent_start / 下一轮 LLM 调 memory_search 时**生效
- 跨会话的下一次 agent_start 自然拿到更新后的 manifest

### 3.2 优先级排队（confidence-tiered injection priority）

**目标**：不只是 "相关"，而是 "**现在最该说的那条先说**"。

每个条目维护一个 `injection_priority` 分数（0-100）。来源有五个维度：

| 维度 | 权重 | 来源 |
|---|---|---|
| **confidence** | 0-10 → 加权 × 5 | ADR 0016 entry confidence |
| **outcome 历史** | DECISIVE +10, CONFIRMATORY +3, RETRIEVED-UNUSED −5 | ADR 0025 §4.2 outcome-ledger |
| **最后使用时间** | 刚用过（< 1h）+15, 今天用过 +5, 本周 +0, 上月 −5, 更早 −10 | 同上，aggregated from outcome-ledger |
| **上下文匹配度** | 0-10 | §3.1 上下文感知 agent 的建议 push 清单 |
| **纠错状态** | 被主动纠错否过 −20, 被 aggregator 质疑过 −8 | ADR 0025 §4.1 + §4.3 |

**不搞机械加权公式**——上面的权重只是给优先级排队的参考方向，不是硬算。优先级排队的实际排序走一段轻量 LLM prompt（跟 §3.1 上下文感知 agent 一起跑）：

```
基于上面的 session_profile 和条目列表，给出最终的注入优先级排名。
对于排名前 5 的条目，每条写 1 句话解释为什么该排在这个位置。

优先级规则（参考，不是硬算）：
- 高置信 + 多次被 DECISIVE 用过 + 跟当前任务类型/领域高度相关 → 排前面
- 低置信 + 很久没用过 → 排后面
- 刚被用户主动纠错否过的 → 不注入（等下次主动纠错确认后再恢复）
- 同一条目的不同属性（偏好 pnpm）vs（习惯 VSCode）在不同上下文
  里优先级可以不同——"偏好 pnpm" 在 React 项目里排前，"习惯
  VSCode" 在 DevOps 脚本里排后
```

这个 prompt 跟 §3.1 的是同一个 LLM 调用（session-profiling + priority-ranking 合并），不额外开销。

**优先级排队的结果存在哪**：一个轻量的 session manifest 文件（或内存结构），`~/.abrain/.state/sediment/injection-manifest.jsonl`。每次 agent_end 增量更新。

### 3.3 剂量控制（token-budgeted injection dosage）

**目标**：不撑爆 LLM 上下文窗口。

当前是固定预算：always ≤ 2.5K + listed ≤ 1.5K。但上下文窗口大小因会话而异——用户刚开始一个短 chat vs 已经塞满 50 轮对话 + 大文件 code diff 的 session。固定预算在前一种情况浪费空间，在后一种情况可能挤掉更有用的上下文。

**改成自适应**：

| 会话上下文空闲度 | 注入预算 |
|---|---|
| 刚开新 session（< 5K tokens context） | 宽松（≤ 4K tokens）——趁 LLM 还不忙多塞点 |
| 中等 session（5-20K tokens） | 正常（≤ 2K tokens） |
| 重度 session（> 20K tokens） | 紧缩（≤ 800 tokens）——只注最关键的 2-3 条 |
| request 中间注（单轮 agent_turn 的 system prompt 注入） | 微剂量（≤ 300 tokens）——**在 LLM 正在回复时轻轻补一句提示** |

**request 中间注**是新概念：ADR 0023 只在 session_start 注一次。但 LLM 可能在 session 中段才遇到需要某条偏好的场景——比如用户在第 15 轮才从 React 切到部署，这时候才该注 "偏好 pnpm 而非 yarn"。实现方式：在每轮 LLM 调之前、pi runtime 的 system prompt 末尾动态 append 一段 "brain notes"：

```
BRAIN NOTES (current session context):
- 你当前的任务看起来是部署。用户偏好 pnpm 而非 yarn（置信度 8）。
- 当前项目的 CI 用 GitHub Actions（从项目 rules 提取）。
```

这段 token 预算严格 ≤ 300 tokens——简短、精准、不过度。LLM 感觉像是 "此刻突然想起" 而不是 "系统在推送"。

**自适应预算的实现**：`agent_end` 时已知当前会话 usage（token count），写进 injection-manifest。下一次 agent_start / agent_turn 时读 manifesto 里的上次 usage 估算当前窗口空闲度。

### 3.4 实时反馈闭环

**目标**：用了没、被否了没、用户沉默了没——这些信号立刻调整后续注入。

这一节跟 ADR 0025 §4.2 outcome self-report 是**一套系统的两个面**：

- ADR 0025 §4.2 负责**收集** outcome 数据（事后统计、写 ledger）
- 本 §3.4 负责**消费** outcome 数据（实时调整注入行为）

#### 3.4.1 即时撤回

用户说 "不是这个" / "不对" / "我说的不是 X" → classifier（ADR 0025 §4.1 主动纠错识别）产出 `correction_signal`。如果 signal 指向的条目当前正在注入队列里，也就是本 session 的 always/listed/动态注入中含这条 → **立刻从当前 session 的注入中撤回**，不等 agent_end。下次 agent_start 时这条条目的 `injection_priority` 自动 -20（§3.2 纠错状态维度）。

**实现**：pi runtime 的 before_agent_turn hook 在读 injection-manifest 时检查是否有 pending correction signal 标记某个 slug，有的话就跳过不注。这一步是 Infra 行为（读 manifest、check slug 列表），不涉及 LLM 推理。

#### 3.4.2 沉默接受 = 确认

AD南R 0024 §4.1 把 "用户接受/修改/拒绝 LLM 输出" 列为隐式信号。但这里有个细微差别：用户**沉默接受了** LLM 按 entry 的偏好做出的建议 → 这是一个隐式的确认信号。怎么收集这个信号？

**不能靠** LLM 在 response 里主动说 "用户接受了我的建议"——LLM 不一定知道用户到底接受了没（用户可能在终端里跑了命令、可能没跑）。但可以靠**下一轮对话**推断：

- 如果 LLM 上轮推荐了 pnpm，用户下轮没反对（没说 "不要" / "换 yarn"），默认当**弱确认**
- 如果 LLM 上轮推荐了 pnpm，用户下轮直接跑了 `pnpm add` 命令 → **强确认**

这个推断放在 agent_end 的 outcome-collector（ADR 0025 §4.2）里一起做——追加一段 prompt 让 outcome LLM 在解读 `memory-footnote` 时顺带判断上轮的 suggestion 是否被用户 action 确认。

确认结果写进 outcome-ledger → 影响后续 injection priority（§3.2）。

#### 3.4.3 用频衰减

一条 entry 被连续高强度使用 → injection priority 自动微升（同一会话内第 3 次被 DECISIVE 使用 → +2）。反过来，一条 entry 放在 injection queue 里但连续 N 次没被 LLM 引用 → injection priority 微降（-1 per unused session, 最低降到 baseline confidence 对应的分数）。不是删除、不是 archive——只是**优先级按自然衰减慢慢滑到该待的位置**。

**为什么不用固定衰减函数**：不同 entry 的自然使用频率不同。"偏好 pnpm" 可能每次加包都用，"CI 配置偏好" 可能几个月才用一次。固定衰减函数会让低频但重要的条目被误降。所以衰减幅度走 aggregator（ADR 0025 §4.3）的趋势观察来判断——"这条是不是本来就应该低频""最近确实没场景用到它"——而不是简单计时间。

---

## 4. 跟 ADR 0025 写侧的联动

两条 ADR 是相互咬合的：

| 0025 的产物 | 0026 怎么消费 |
|---|---|
| §4.2 outcome 数据（DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED） | §3.2 优先级排队的 outcome 历史维度 |
| §4.1 active correction signal | §3.4.1 即时撤回 + injection priority -20 |
| §4.3 aggregator 跨会话趋势 | §3.4.3 用频衰减的长期判断 |
| §4.4 multi-view verification | 高置信 entry 的注入也享受 multi-view 保障——不直接相关但共用信心数据 |
| §4.6 静默归档 | 归档 entry 不出现在注入队列（已在，memory_search exclude archived） |

**反过来，0026 也服务 0024 的 outcome 闭环**——0024 说 "大脑要自动演进"，0025 负责写、0026 负责用。0026 的实时反馈（撤回/确认/衰减）是 0024 **在用户体感层面**的闭环——用户不需要知道 0025 背后的 classifier / multi-view / aggregator，用户只需要感觉到 "大脑在合适时机给了该给的偏好，在我否了之后立刻不推了"。

---

## 5. 实施路径

### 5.1 挂载点

| 机制 | 挂载在哪 | 时机 |
|---|---|---|
| §3.1 上下文感知 agent | `agent_end` hook 末尾（在 ADR 0025 classifier 之后）+ `agent_start` hook 开头 | 每会话开头 + 每次 agent_end 增量 |
| §3.2 优先级排队 | 跟 §3.1 同一个 LLM 调用（合并 prompt） | 同上 |
| §3.3 剂量控制-自适应预算 | `before_agent_turn` 读 injection-manifest + 当前 token usage | 每轮 LLM 调用前 |
| §3.3 剂量控制-request 中间注 | `before_agent_turn` 动态 append brain notes 到 system prompt | 每轮 LLM 调用前 |
| §3.4.1 即时撤回 | `before_agent_turn` 读 injection-manifest 检查 pending correction | 每轮 LLM 调用前 |
| §3.4.2 沉默接受推断 | `agent_end` outcome-collector 同一步 | agent_end |
| §3.4.3 用频衰减 | aggregator（ADR 0025 §4.3）同一步 | daily/weekly |

### 5.2 新文件

```
extensions/sediment/
├── injection-context-agent.ts    ← §3.1 + §3.2 合并的 LLM call（session-profiling + priority-ranking）
├── injection-manifest.ts         ← injection-manifest.jsonl 读写 + priority queue 维护
├── injection-scheduler.ts        ← §3.3 剂量控制逻辑 + before_agent_turn hook
└── prompts/
    └── context-aware-injection-v1.md
```

### 5.3 Phase 安排

| Phase | 范围 | 依赖 | 工程量 |
|---|---|---|---|
| **P0** | injection-manifest 数据结构 + 读写 + 自适应预算逻辑（§3.3 不含 request 中间注） | ADR 0025 P0（promptVersion / audit）| 小-中 |
| **P1** | §3.1 + §3.2 上下文感知 + 优先级排队 prompt（单 LLM 调用） | P0 + ADR 0025 P1（主动纠错 classifier 产出 correction_signal 才能做 §3.4.1 撤回）| 中 |
| **P2** | §3.3 request 中间注 + §3.4.1 即时撤回 | P1 + ADR 0025 P2（outcome 数据有了才能做 §3.4.2 接受推断）| 小-中 |
| **P3** | §3.4.2 沉默接受推断 + §3.4.3 用频衰减 | P2 + ADR 0025 P3（aggregator 有了才能做长期衰减判断）| 中 |

**P1 是核心**——上下文感知 + 优先级排队是"用"侧从被动变主动的关键一步。没有 P1，P2/P3 的反馈和衰减都是空转。所以 P1 不能跟 ADR 0025 的 P2/P3 平行拖——必须在 0025 P1（主动纠错 classifier）ship 之后立刻跟上。

### 5.4 跟 ADR 0023 的关系

**不取代 ADR 0023**——always/listed 双 tier 基础注入保持不变。ADR 0026 是加了一层**动态感知**在固定的 always/listed 之上：

- `always` 条目仍然在 session_start 注入（保质底——确保"用 pnpm"这类基础偏好不漏）
- `listed` 条目仍然在 session_start 列出（给 LLM 菜单）
- **新增**：上下文中段（agent_turn）根据当前对话动态补充 brain notes（§3.3 request 中间注）
- **新增**：优先级排队决定 brain notes 里放哪几条（§3.2）

也就是说 ADR 0023 是"地基"，ADR 0026 是"感知层"。两个不冲突——地基保证不漏，感知层保证不笨。

### 5.5 反向 patch 下游 ADR

| 下游 | patch 内容 |
|---|---|
| ADR 0023 R4 | §D2 tier 制加一段：ADR 0026 引入动态感知注入作为 always/listed 之上的感知层，不取代 |
| ADR 0025 §4.2 | outcome-ledger schema 加 `injection_priority_delta` 字段（记录每次 outcome 导致的 priority 变化） |
| ADR 0025 §4.3 | aggregator 任务加一条：读 injection-manifest 的 priority 变化趋势，作为长期写入策略的参考 |
| ADR 0025 §7.4 | §6 接受代价表加第 10 条：上下文感知误推 + 误撤回 |
| ADR 0024 §6 | 接受代价表加一条：大脑主动推送的时机判断有误（该推时没推 / 不该推时推了） |

---

## 6. 与 ADR 0024 边界的对齐自检

### 6.1 Invariant 边界

| # | ADR 0024 边界 | 本 ADR 检查 |
|---|---|---|
| 1 | INV-INVISIBILITY | brain notes 注入时用户看到的是 "LLM 刚好记起偏好" 还是 "大脑在推内容"？✓ 前者——300 token 短注混在 system prompt 末尾，不注明来源 |
| 2 | INV-AUTONOMY | 任何 prompt_user 询问 "该推这条吗" / 用户手动调注入策略？✗ 绝不 |
| 3 | INV-IMPLICIT-GROUND-TRUTH | 撤回/确认/衰减的触发是隐式信号（用户否了/接受了/沉默了），不靠用户显式管理注入 |
| 4 | INV-ACTIVE-CORRECTION | 用户说 "不是这个" → 即时撤回。这条是 INV-ACTIVE-CORRECTION 在"用"侧的自然兑现 |

### 6.2 AI-Native 原则

| 状态 | 检查 |
|---|---|
| ☑ PE-form | 上下文感知 + 优先级排队 + 接受推断走 LLM prompt（默认） |
| ☑ Infra | injection-manifest 读写 + token 预算计算 + slug 匹配撤回走机械 |
| ✗ Mech-on-LLM | 无机械优先级公式 / 无固定衰减函数 / 无注入数量 hard cap |

### 6.3 §6 接受代价（新增）

本 ADR 引入的代价（加进 ADR 0024 §6）：

| # | 代价 | 后果 |
|---|---|---|
| 10 | 上下文感知误推 | 大脑在不对的时机推了无关条目，LLM 被干扰（但 ADR 0023 的 always 基数也是同等干扰——always 推的内容也常常跟当前任务无关）。感知层的错推频率低于 always 的死板推送 |
| 11 | 误撤回 | 用户说 "不是这个"，classifier 判成撤回，但用户可能只是暂时不要、下次又要。priority -20 后需要在 aggregator 的趋势观察中恢复 |

---

## 7. 相关项目记忆

- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim, conf 8) — 优先级排队走 prompt 不是走公式，同哲学
- `prefer-prompt-engineering-over-mechanical-guards` (maxim, conf 9) — 同上
- `staged-rollout-better-than-big-bang` (maxim, conf 8) — P0-P3 四 phase 分步 ship
- ADR 0025 v2.1 — "写"侧对偶，两个 ADR 相互咬合
- ADR 0023 R4 — 地基注入，本 ADR 不取代只加感知层
