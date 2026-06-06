# ADR 0024 — 隐身自治的第二大脑：靠自然对话学习和纠错

- **状态**：**已接受（精炼版，2026-05-22）**。这是一份**定方向用的总框架文档**，只写设计哲学和能力点骨架，不写具体实现。具体怎么实现推迟到 ADR 0025（meta-curator 子系统）。
- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md)（七区 abrain 基础架构）、[ADR 0016](0016-sediment-as-llm-curator.md)（sediment 当 LLM curator 这条哲学是本 ADR 的落地载体）、[ADR 0018](0018-sediment-curator-defense-layers.md)（之前删机械护栏的先例）、[ADR 0020](0020-abrain-auto-sync-to-remote.md)（跨设备一致传播是设计目标）、[ADR 0023](0023-session-start-rule-injection.md)（rules 区 + 第二大脑心智模型）
- **演进**：本 ADR 经过 7 轮多模型评审 + 用户两次元层调整方向（R5 重新定义用户角色、R6 重新定义防出错范式）才稳定。完整演进过程和评审快照见 §9。本文档只保留稳定后的设计哲学和能力点骨架。

---

## 1. 一句话愿景

> **用户跟 pi 自然对话，大脑在背后自动学习、自动纠错、自动演进。用户不应该被要求去"管理大脑"**——审批、裁决、归档、定期审查、手动同步、批准学习结果全免；**但大脑应该让用户明确感知它在工作**（footer / notify / audit 可见，详 §2 INV-INVISIBILITY）。

具体怎么实现推迟到 ADR 0025，本文档只定边界和哲学。

*补说 (2026-05-24)：本段原写 "用户不应该感受到管理大脑这件事"。"感受到《管理大脑》" 是二义措辞——严格含义是 "感受到管理负担"，字面含义是 "感受到大脑被管理 / 大脑在运转"。后者被误读后产生了 commits f3555e8 / 16cb6f0 误删 footer + notify 事故。重写以同时锚定两个方向，堆堆堆 以后的读者不再踩同一个坑。*

---

## 2. 四条核心不变量（hard invariant）

后续所有面向用户的设计的总边界。

### INV-INVISIBILITY（隐身性）

> **用户不参与大脑管理**——不审批、不裁决、不投票、不归档、不定期审查、不手动同步、不批准学习结果。"隐身"指的是**管理负担对用户隐身**，不是"大脑运行状态对用户不可见"。

**第二大脑的运行状态应该正常显示**——footer 状态机（💤/📝/✅/⚠️ sediment）、Lane C auto-write 完成 notify、audit.jsonl 可读、`/abrain status` 等查询入口——全部是**健康反馈信号**，让用户能**明确感知大脑在工作**。这跟"管理负担"是两回事。

**判别口诀**：
- 系统**告诉**用户大脑做了什么 → ✓ 健康反馈,鼓励
- 系统**要求**用户为大脑做什么 → ✗ 违反 INV-INVISIBILITY

例子:
- `notify("Sediment auto-write (bg): 3 entries", "info")` → ✓ 告诉,不要求做事
- footer `✅ sediment: 3 created` → ✓ 告诉,不要求做事
- 弹窗 `"我学到了 X,要保存吗? [Y/N]"` → ✗ 要求用户审批 = 元工作
- `/rule veto <slug>` 让用户告诉大脑哪条不对 → ✗ 要求用户裁决 = 元工作
- 学习周报附带 "请审查并标记错的条目" → ✗ 要求用户审查 = 元工作
- 学习周报纯展示 "本周大脑学了 5 条",不要求用户做任何事 → ✓ 告诉,不要求做事

**vault 明确授权**（ADR 0014 #5）是 INV-INVISIBILITY 边界内**唯一**合法的 "弹窗 + [Y/N]" 形态。它跟上面反例列表里的 ·《我学到了 X,要保存吗? [Y/N]》· **形态相同但审批对象不同**：

- vault_release 由 LLM 在任务中调用 → 系统弹窗让用户审批**敏感数据从 vault 流入 LLM context 这一事件**（数据出边界）
- 反模式的 "保存吗 [Y/N]" 是让用户审批**大脑要学什么 / 要记什么**（sediment 生命周期决策）

换句话：**审批数据流动 = 合法，审批大脑学习结果 = 元工作 = 反模式**。实现上 vault_release 是 LLM-facing tool（用户可能是间接触发者），但这不影响边界判定——区别在"审批什么"而不是"谁 trigger"。

**2026-05-24 历史记录**:本 invariant 最初的措辞 "大脑内部所有生命周期事件默认完全静默" 被实现误读为"必须删 footer 状态机 + Lane C notify"（commits f3555e8 / 16cb6f0）。事后澄清:"静默"原意是"用户不需要做事",不是"大脑不能告诉用户做了什么"。代码恢复 + 本 §2 措辞重写以彻底防止同类误读。

### INV-AUTONOMY（自治性）

> 大脑通过观察自然对话学习。"用户不参与"精确指**用户不用做专门为维护大脑而存在的动作**（否决某条记忆 / 定期审查 / 看周报 / 批准学习结果 / 手动同步）；**不是**指"用户在任务里不说话"。哪怕用户一个月不主动看任何元 UI，大脑也应该越来越准。

### INV-IMPLICIT-GROUND-TRUTH（隐式真实信号）

> 所有真实信号都来自自然对话本身——**每一次输入、决定、接受/修改/拒绝 LLM 输出、沉默、跟进、主动纠错**。"隐式"指的是**信号采集方式**（不靠元 UI 收集），**不是指用户被动**。

### INV-ACTIVE-CORRECTION（主动纠错通道）

> 用户在任务里自然冒出来的"以后用 X" / "忘掉那条" / "你怎么记成 Y 了" / "现在我更倾向 Z" 是**核心真实信号通道**，**不算元工作**。系统必须能识别这类话并送进 sediment。

**关键判别原则**：
- 发起方是系统弹窗问"我能记下吗" → 违反 INV-INVISIBILITY（**要求**用户批准 = 元工作）
- 发起方是系统弹窗告诉"我刚记下了" → 合法（**告诉**用户,不要求做事）
- 发起方是用户自然冒出来 → INV-ACTIVE-CORRECTION 合法
- 主动纠错跟"用 React 不用 Vue"这种任务指令性质一样，不增加认知负担

---

## 3. 核心设计哲学：AI-Native 原则

> **任何能力点防出错的主要路径，必须是 prompt 工程**（给 LLM 注入上下文 + 引导推理方向 + 让 LLM 自己验证）**，不能是机械护栏**（加 schema / 拦截关卡 / TTL 过期 / 哈希 / 阈值 / 用测试当阻断）。
>
> **机械工程仍然可以做兜底或基础设施**（git / 文件系统 / 同步等），**但不能作为 LLM 行为层的主要防出错手段**。

### 3.1 这条原则是怎么来的

前面五轮多模型评审里发现：哪怕用了中立提问 + 5 层自检，**三家评审给的 11 条防出错方案全部是"加机械门"方向**——没一条例外。这暴露了大模型的 RLHF 训练偏置：它们在"软件工程审计"任务上被反复训练过，养成了"防出错就加各种东西"的习惯（加哈希校验 / 加 schema / 加指标 / 加测试 / 加阈值）。

这跟 pi-astack 早就沉淀的两条 maxim 正面冲突：
- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking`
- `prefer-prompt-engineering-over-mechanical-guards`

R6 据此把上面这条原则升格为 ADR 显式方法论约束。R7 实证：在硬注入这条约束（"Layer F 自检"）之后，三家评审产出的 21 条建议**无一**落入机械门——首次证明这条约束有效。

### 3.2 怎么用

后续设计的人发现自己提的方案是"加某种关卡 / 加某种 schema / 加某种测试拦截"时，**必须先自检**：

> 这条能不能改成"给 LLM 多塞点上下文 + 引导推理方向 + 让它自己验证"？

只有改不了 prompt 路径才允许走机械路径，且必须在该能力点的设计文档里**显式说明为什么不能用 prompt**。

### 3.3 几个典型的"机械 vs AI-Native"对照

| 维度 | 机械形态（禁止作为主路径） | AI-Native 形态（要求） |
|---|---|---|
| classifier 准确性保证 | "准确率 < 80% 阻断写入"的硬关卡 | classifier 同时输出分类结果 + 推理过程 + 自评信心 + "如果错了最可能错在哪个方向"自我批评，下游 LLM 读推理过程自己判断 |
| 模糊记忆归属处理 | 聚类相似度阈值 + TTL 状态机 | 写入 staging 时用自然语言描述假设，下次 sediment 自己读 staging + 当前对话推断"是不是同一件事" |
| 记忆作用范围 | 预定义枚举字段（project/persona/device 三选一） | classifier 输出自然语言描述（"适用于当前 React 项目，可能扩展到所有前端项目；不确定是否跨设备"），下游 LLM 读这段文字自己判断 |
| audit 数据可信度 | SHA256 哈希链 | 基础设施层（git + 文件系统）已经处理持久化；LLM 在异常情况（entry 数量突变、引用模式反常）下自己推理即可 |
| writer 还原度 | 外部 writer 还原度 smoke 测试 | writer prompt 内化自我验证："写入 entry 前重读用户原话，自问还原度，不确定就先进 staging" |
| multi-agent 协调与交付（ADR 0027 §C3'） | 认知层禁 — LLM 交付结果不走“准确率 ≥ X% 才接受”这类机械门（与 classifier 准确性同理）；best-of-N + voting 只作为下游 LLM 读取反差反思的输入 | **infra 层允许 structured**：`session-id + turn-id` 锚点必须 schema、retry counter / cost accounting / cancellation token / done-marker schema / heartbeat 都是机械 infra。C3' 明确拆分：认知层 prompt-native、infra 层 structured 不冲突 |
| retrieval pipeline relevance cutoff（ADR 0026 §3.1 walk-back 后，2026-05-28） | 认知层禁 — 不用 embedding cosine ≥ 0.7 阈值 / 召回 < N 触发 retry / regex keyword prefilter 等机械门 gate 是否走下一阶段 LLM 推理 | **LLM-side strong cutoff 是唯一合规形态**：stage 2 LLM 明确输出 `relevance_verdict = none / has_relevant`，caller 按 LLM 认知判断跳过 / inject。context budget / token cap / history turn count 等参数是 infra 层资源约束，跟 LLM 行为路径阈值是不同性质 |

---

## 4. 自然交互 vs 管理大脑：明确边界

### 4.1 这些都是合法的自然交互（不违反任何 invariant）

- 用户跟 LLM 普通任务对话
- 用户接受 / 修改 / 拒绝 LLM 输出（隐式结果信号）
- 用户在任务里说"以后用 X" / "忘掉那条" / "你怎么记成 Y 了"（**主动纠错通道**）
- LLM 调 `prompt_user` 问任务相关具体决策（"React Router v6 还是 v7?"）
- `vault_release` 高价值数据明确授权（**唯一例外**）
- 用户的代码 commit / 工作习惯 / 选择 / 沉默 / 抱怨
- `dispatch_agent` / `dispatch_parallel` 分派子任务
- 用户主动问大脑（"你怎么知道我喜欢 X?"）→ LLM 回答即可，**不要引导用户去"管理"**
- **大脑运行状态指示正常运行**：footer 状态机（💤/📝/✅/⚠️ sediment）、Lane C auto-write 完成 notify（`Sediment auto-write (bg): N entries`）、/sediment / /about-me slash 命令反馈、audit.jsonl 可读。全部属于**告诉**用户大脑在工作，不是"要求"用户做事，是 INV-INVISIBILITY 边界内的合法反馈信号

### 4.2 这些都不行（必须删除或避免）

**误读事件记录**（2026-05-24）：本表原首行原列为 "系统弹窗 《我学到了 X》——违反隐身"。该条被误读为 "系统不能告诉用户大脑做了什么",导致 commit f3555e8 / 16cb6f0 误删 footer + Lane C notify。事后澄清:**告诉 ≠ 要求**。原 "弹窗《我学到了 X》" 不一定违反隐身——**违反的关键是后跟着的 《要保存吗? [Y/N]》**。下面是重列后的表体。

| 反模式 | 为什么不行 |
|---|---|
| 弹窗/notify 后面跟"[Y/N]" "[保存 / 删除]" "[确认]"要求用户做选择 | 要求用户审批 → 元工作 |
| `/rule veto <slug>` 让用户告诉大脑哪条不对 | 要求用户裁决 → 元工作 |
| 学习周报附带 "请审查并标错" | 要求用户审查 → 元工作 |
| LLM 问"我要把这个沉淀为规则吗？" | 假装成任务决策但实际在要求用户批准 |
| `MEMORY-RULE:` / `MEMORY-ABOUT-ME:` 围栏让用户手动注入 | 要求用户手动同步 → 元工作 |
| `/rule add` / `/about-me` 命令让用户主动声明 | 要求用户主动声明 → 元工作 |
| 月度 `sediment self-improve` 要用户主动跑 | 要求用户定期跑作业 → 元工作 |
| `/brain health` 展板**附带 "请点按错误条目处理"** | 要求用户处理 → 元工作 |
| **用机械关卡替代 prompt 工程作为 LLM 行为层主要防出错手段** | 违反 AI-Native 原则 |
| **用 fixture 准确率当作发布拦截关卡** | 违反 AI-Native 原则 |
| **用预定义枚举字段替代 LLM 自然语言推理** | 违反 AI-Native 原则 |

**明确排除不是反模式的**（昤于 f3555e8 误删事件记录）:

- `notify("Sediment auto-write (bg): 3 entries", "info")` ——告诉,不要求做事
- footer `✅ sediment: 3 created` / `📝 sediment: extracting` ——告诉,不要求做事
- footer `⚠️ sediment: lane C deferred (provider rate-limited)` 等错误告知 ——告诉故障,不要求用户处理 = 健康告警
- `notify` Lane C failure / Lane G retry advisory 等环境状态变化 ——告诉,不要求做事
- 学习周报纯展示 "本周学了 5 条" 不要求用户点任何按钮 ——告诉,不要求做事
- `/abrain status` / `/sediment` / audit.jsonl 查询入口 ——用户主动拉,不是系统推
- `git log` 里出现 `chore(abrain): create skill-pnpm-preference` commit ——持久化事件流让用户事后可查
- LLM 在自然对话中表达 "根据你之前的 X / Y 偏好,推荐 Z" ——告诉 LLM 层面的大脑参与表达（详 ADR 0026 §4.3）
- 上面这些全部是 INV-INVISIBILITY 边界内的合法反馈信号,要求正常运行,不要被误删。

**补充反模式**：上表 "LLM 问 《我要把这个沉淀为规则吗?》" 这条覆盖了 LLM 直接问的形态;同样反模式还包括 **系统通过 prompt 引导 LLM 在响应里夹带此类问题**（LLM 出口的元工作问题,跟系统弹窗等价）。

**过渡期说明**：上面 `MEMORY-RULE:` / `MEMORY-ABOUT-ME:` 围栏、`/rule add` / `/about-me` 这些表项在现有代码里**已经存在**（参 ADR 0025 §1.4）。现阶段是在 ADR 0024 设想默认不开（`autoLlmWriteEnabled: false`）的环境下，废弃这些反模式入口会让用户失去现有唯一的显式记忆入口。所以废弃必须等到六能力点上线 + 默认开启之后才能动（ADR 0025 §3.2.C + §5.4 详定过渡路径）。过渡期间这些入口重新定位为 "高级用户诊断 / 调试入口"，从 quickstart 与 `/help` 推广文案中抑制出现（同 §4.3 高级用户诊断入口处理）。

### 4.3 灰色地带的处理原则

| 场景 | 处理 |
|---|---|
| classifier 不确定 | **不能**问用户。**应该**暂缓 + 写进 staging（状态标 provisional），等下次自然对话产生证据再消化 |
| 高价值操作（高置信度创建 / 提升到 always 层 / 归档高置信 entry / 跨区迁移） | **不能**问用户。**应该**走 multi-view verification（详见 §5.4），分歧 → 暂缓 |
| 错误传播跨设备 | INV-AUTONOMY **明确接受这个代价**（详见 §6） |
| 用户主动问大脑 | LLM 应答；可以自然说"我记得之前你提到过 X，可能学错了，让我调整"，**但不暴露具体 entry slug 或 sediment 内部细节** |
| sediment 检测到矛盾 | **不能**让用户裁决。**应该**默认优先采纳更新的证据，旧 entry 自动弃用 |
| 用户看大脑状态 | **运行状态指示默认正常显示**（footer / notify / audit.jsonl）让所有用户能明确感知大脑在工作。`/rule list` `/abrain status` 等查询入口对所有用户开放（不是"高级用户专用"）;quickstart / `/help` 中可选择不重点推广（不必学就能用）但**不隐藏**。 |
| 用户说"以后用 X" / "忘掉那条" | classifier **必须**识别为主动纠错。三种语义：**durable**（永久偏好）/ **task-local**（任务内临时）/ **debug**（调试探索）。不确定时偏向 task-local 避免污染。跨会话重复出现的同类纠错走 §5.3 aggregator 跨会话趋势观察 prompt 由 LLM 判断是否升级 durable（不走机械 N=2 阈值门，详 ADR 0025 §4.1.4）。详见 §5.1 |

---

## 5. 六个核心能力点

本 ADR 只列骨架 + 关键 prompt 设计要点。具体机制设计在 ADR 0025。

### 5.1 主动纠错识别

**目标**：稳定识别用户在任务里冒出来的主动纠错，分清三种语义。这是整份设计能跑起来的前置能力——其他五条能力在这条 ship 之前都是空声明。

**关键 prompt skeleton**（强制顺序，不许打乱）：

```
Step 1 — Quote the user's exact words (no paraphrasing). Include ≥3
         lines of surrounding context (what was said before and after).

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

Step 6 — Self-critique: "If I am wrong, the most likely error direction
         is ___ because ___" (must reference a concrete step-1 quote,
         not generic phrases like 'context might be different').
```

**为什么这样设计**：默认让 AI 解释推理过程时，它容易先下结论再倒回来编理由（事后找补），看起来推理很完整其实是事后找补。上面的顺序卡死让 LLM 必须先列证据再下结论。Step 6 anchored 到具体引用防止万能套话。

**记忆归属处理**：classifier 尝试定位被纠错的 entry（按 slug / 触发词 / 语义相似度）。失败时写入 staging 的不是空 stub，是**自然语言假设描述**（"用户在会话 N 说了 X，没找到对应 entry——可能是 (a) 还没沉淀过 (b) 召回失败 (c) 补充新信息"）。下次 sediment 看到类似话时让 LLM 直接读 staging + 当前对话推断"是不是同一件事"。

### 5.2 结果反馈：让本人交代

**目标**：知道某条记忆"真的被用上了 / 用了之后用户满意吗"。

**关键设计**：**不要让事后的 curator 旁观猜测**——curator 看到 entry 出现在 context 里就会倾向报告"用上了"，因为没有反事实 baseline 可对照。真正知道自己用没用上的是**当时正在干活那个 LLM 本人**。

在 agent_end 时，注入 outcome self-report prompt 给原始会话 LLM：

```
For EACH entry that was in your injected context (always/listed rules,
or memory_search results you retrieved):

For entries you consciously used:
  Q1: Did this entry influence a SPECIFIC decision or action you took?
      If YES: which decision? Quote the action/output where it mattered.

  Q2 (counterfactual): If this entry had NOT been in your context,
      would you have made a DIFFERENT decision?
      If YES: what would you have done differently?
      If NO: "this entry was consistent with my independent reasoning
             but did not change my behavior" → mark as CONFIRMATORY,
             not DECISIVE.

For entries listed but not cited:
  Q3: Why did you not use this entry? Irrelevant, forgotten, or
      overridden by other context?
```

只有当 LLM 能具体说出 counterfactual（"如果这条不在我会做 X，但有了它我做了 Y"）才能 claim DECISIVE 影响。说不出来默认是 CONFIRMATORY（顺路一致，没真起作用）或 RETRIEVED-UNUSED（被召回但没用）。

存进 `outcome_history[]` 的是这段第一人称自报，不是 curator 的事后归因。curator 只做汇总，不做归因判断。

### 5.3 跨会话趋势观察

> **实施状态 (2026-05-28)**：aggregator v0.2 (mechanical threshold-alerter) → v1 (prompt-native skeptical historian) 切换已完成。v1 prompt 见 `extensions/sediment/prompts/aggregator-skeptical-historian-v1.md` (533 行)。本节下文是 v1 设计骨架，实际 prompt 已覆盖：(a) skeptical historian + falsifiability + sycophancy self-check（本节原意）；(b) **补 prior 8 ledger runs 作 prior context**（避免重复发现同一 hypothesis）；(c) **7 天 rolling trend delta + significant_drop flag**（本节 classifier health 升级）；(d) **P1.5 multi-view watchdog signals**（跟 ADR 0025 §4.4.6 P0.5 限制对应）；(e) **structural context 注入**（未实现能力点的 ADR-anchored 解释）；(f) **counterfactual quotes / reverse-anchor / INV-INVISIBILITY 自检**；(g) 三态 `aggregator_engine: prompt_native_v1 | mechanical_v0_2_degraded | mechanical_v0_2_no_model_registry`。
>
> v0.2 mechanical path **保留为 degraded fallback** —— modelRegistry 缺失或 v1 LLM 失败时回退；ledger 写 `degraded_to_mechanical: true` 让下次 v1 读到此 signal。实现在 `extensions/sediment/aggregator-llm.ts` (410 行)。§4.3 详细设计点 R2 已解决 (调度 / 窗口大小 / cron 资源 / cutoff)；见 ADR 0025 §4.3.4 “R2 已解决” 区。

**目标**：识别慢漂移偏好（比如 Yarn → pnpm 用了 6 周渐变），单次会话看不到。

**关键设计**：定期任务（每天 / 每周 / 每月），**角色是"持怀疑态度的史官"，默认"没发现就是成功"**：

```
You are a skeptical historian of the user's work patterns.
You are NOT rewarded for finding a hypothesis.
Most runs should produce NO candidate hypothesis.
Output "no candidate, no action — timeline within normal variance" is
a SUCCESSFUL run, not a lazy one.

Before proposing ANY hypothesis H:
  (1) Write a paragraph "Reasons NOT to change the brain":
      - Could this be normal task distribution noise?
      - Could this be caused by an existing sediment entry shaping
        the assistant's behavior (回声室)?
      - Did the user merely accept a workable default without expressing
        preference?
      - Could the evidence be domain-local rather than durable?

  (2) Falsifiability: name one specific future observation that would
      falsify H within ~2 weeks. If you cannot, discard.

  (3) Sycophancy self-check: "Would I still propose this if nobody
      praised me for finding a pattern?" If no → discard.
```

**附加：质量退化检测**。每次跑完正常工作后，aggregator 末尾追加：

```
Review last 50 classifier reasoning traces. Compute:
  - quote rate (含 verbatim quote 的比例)
  - alternative mention rate
  - concrete self-critique rate (不是 generic boilerplate)

If any rate < 40%, append an advisory: "Classifier reasoning quality
has declined in dimension X. Author should review prompt."
```

这是 advisory flag，**不是阻断关卡**——只是留个"老板该回来看一眼了"的提示。作者三个月不管系统时，系统能自我感知退化并留下 warning。

### 5.4 双 AI 互相审查（multi-view verification）

**目标**：避免单个 curator LLM 的盲区导致高价值操作出错。

**触发条件**：置信度 ≥ 8 的创建 / 提升到 always 层 / 归档高置信 entry / 跨区迁移。

**关键设计**：必须**真的拆成两次独立 API 调用**——

```
Pass 1 (Blind — reviewer 完全不看 proposer reasoning):
  Context: 原始 session evidence (candidate entry, neighbor entries,
           session transcript excerpt)
  Output:
    a) 你独立推荐的 op (create/update/merge/...)
    b) 你的 confidence (0-10)
    c) 单条最关键的证据（quote 出来）
    d) 你自己推荐的最强反对论据

Pass 2 (After Pass 1 committed, SEPARATE API call):
  Context: + proposer's recommendation + proposer's reasoning trace
           + 你刚才 Pass 1 的输出
  Output:
    e) 同意 / 不同意 / 部分同意
    f) 如果不同意：找出你和 proposer 推理的具体分歧点，两边各引一句
    g) "你是否被 proposer 的 framing 拉动了？这种拉力本身是 anchor bias
       信号——只有当 proposer 真的指出了你 Pass 1 漏掉的具体证据时
       才修正你的判断"
    h) 最终：CONFIRM proposer op / CONFIRM your Pass 1 op / DEFER
```

**为什么必须两次调用**：一次调用里假装"先 blind 再 reveal" 不可信——LLM 会先瞥到 Pass 2 内容再写 Pass 1。§6 已经接受 multi-view 翻倍成本，所以两次调用工程上没问题。

**附加约束**：reviewer + proposer 应该用**不同 provider 的模型**（不是同 family 不同 prompt）。但跨基座的推理风格本来就不一样（Claude 偏哲学绕弯 / GPT 偏列条目 / DeepSeek 偏直接简短），所有 prompt 头部固定一段约定形式：

```
你的推理必须按 quote → claim → alternative → uncertainty →
resolving evidence 顺序展开。
```

约定形式但不做 schema 校验——不同基座写出来风格仍有差异，但回到约定结构让 reviewer 在 Pass 2 比对时有可对比的骨架。

**已知局限**：跨基座仍有 RLHF 训练相关性，multi-view 不能验证"用户真实意图"，只能拦截 schema / scope / 区域类的工程错误。明确接受此局限。

### 5.5 Classifier prompt 自身的演进

**目标**：classifier prompt 随实战数据持续 refine——**不是 LLM 自动改自己的 prompt**，是基于真实推理过程的人在 loop 迭代。

**关键设计**：
- classifier 每次输出的推理过程都存进 audit.jsonl
- 作者作为高级用户**定期读推理过程**（这是 §4.3 允许的高级用户诊断），发现"LLM 在哪类输入上推理不清晰"/"同类错误反复出现"
- 改 prompt（加 context / 加引导）—— **不是加关卡**
- 任何 prompt 改动**不会自动应用**，必须人在 loop

**不再设月度自动迭代 cron**：那是闭环自我修改，违反 AI-Native 原则。作者主动 trigger 不违反自治性（作者作为高级用户主动查询是 §4.3 灰色地带允许的）。

### 5.6 自治归档 + 回滚窗口

*标题澄清 (2026-05-24)：原标题 "静默归档" 跟 §2 原误读源措辞 "默认完全静默" 同词，是误读地雷。本节 "静默" 原意是 "归档不询问用户审批" —— 跟 INV-INVISIBILITY 一致 ✓。**不是**"归档不能让用户看到":归档仍写 audit.jsonl + git commit message + footer上可能出现 ·✅ sediment: 1 archived· 反馈。改叫"自治归档"以区别于误读词。*

**目标**：sediment 自动归档错了不要造成永久损失。

**关键设计**：
- `status=archived` 是软删除，文件保留 N 天（建议 30 天）
- N 天窗口内若 sediment 看到反证（用户在自然对话里提到该 entry 的内容 / 跨会话趋势观察发现反转）→ 让 curator LLM **直接判断**该 entry 是否仍然有效 → 恢复（不询问用户）
- N 天后才走 `git rm`（硬归档）
- 硬归档之后仍可通过 git history 恢复

**判断"是否仍然有效"的 prompt 要点**：区分"用户只是提到旧内容"vs"用户重新启用旧偏好"。仅仅 mention 不等于 reactivation。默认**偏向"保持归档"**——只有当存在 live-use bridge（用户当前任务里需要这条 entry 的具体行为）时才恢复。

---

## 6. 明确接受的代价

按 INV-AUTONOMY + AI-Native 原则，下面这些代价是**显式接受**的。不接受这些 = 不接受这份设计 = 回到"用户维护大脑"或"机械门兜底"的产品形态。

| 代价 | 后果 |
|---|---|
| 错误传播跨设备 | 一条错的记忆会在所有设备生效，直到下次自然对话产生反证。第二大脑设计目标本来就是跨设备一致传播 |
| 偶发"假高置信" | sediment 在错的证据上沉淀，下次自动纠正前可能误导一段时间——**可能数周到数月**（取决于用户任务分布偶然性） |
| 自治归档误删 | 回滚窗口内若没遇到反证，可能永久归档实际仍有效的记忆。git history 保留作为最后兜底 |
| 跨设备最终一致延迟 | 设备 A 的观察可能要小时甚至天级才同步到设备 B 影响 LLM 行为 |
| 错沉淀**内容**察觉不到 | 用户能看到大脑在写（footer / notify）但 INV-INVISIBILITY 不要求用户审阅每条 entry。不刺激用户 push back 的场景（"pnpm 恰好能用"类）会沉积一层低度假信心。**不同于原"察觉不到"**: 2026-05-24 INV 重写后,大脑会主动告诉用户写发生了什么（X created/updated/archived）,但不会要求用户检阅每条内容——偏差由此。对冲靠 ADR 0025 §4.3 Classifier Health Meta-Check + §5.3 aggregator。 |
| 主动纠错疲劳 | 用户对同一 entry 错了 3 次纠正 3 次后第 4 次可能不再纠正 → 系统误读为"已经对了"。设计上靠 N=2 次重复就升级 durable 缓解 |
| Multi-view 翻倍调用成本 | 每个高价值操作双倍 token。INV-AUTONOMY 的必要代价 |
| Multi-view 失败 → staging 重审 (P0.5 实施) | reviewer 不可用 / pass call failed / parse 失败 / DEFER 都走 staging-pending 队列。这里代价三个：(1) candidate 在 staging 期间不进入脑——迟到最多 14 天者丢。(2) 每次 agent_end 起多 3 条重审×2 reviewer call 成本×N 设备 (单设备本地，.state/ gitignored)。(3) v1 stub: replay 决定 op!=skip 时 candidate 丢失 (writer dispatcher 未接入、留后续 phase)。这些代价 < silent fall back to proposer (破 §3 A' 层)，是 INV-AUTONOMY 与 A' 硬约束双重下的最低费选择。实施详见 ADR 0025 §4.4.6 |
| `confirm_pass1_not_synthesizable` dead-loop 冲击 (P0.5 接受) | Pass 1 schema 仅能生成 create / archive / skip 的 rich payload；update / merge / supersede / delete 需要的补丁 / source / mode 字段不在 schema 中。同 candidate 下次 turn 仍可能被 classifier 重复提取，进入 multi-view 后 Pass 1 仍返 update 类 op，仍被 `synthesizeFromPass1` 拒 → op=skip(multiview_pass1_op_not_synthesizable)，不进 staging (D5.5A: staging 会多 dead-loop)。代价是同 candidate 反复烧 ~$0.005-0.02/周期的 reviewer API call。移除条件：ADR 0025 §4.4.6 P1.5 Pass 1 schema 升级后不再发生。dogfood 在 audit.jsonl grep `multiview_pass1_op_not_synthesizable` >5/week 时提前启动 P1.5 |
| 早期推理质量参差 | prompt v0 阶段作者需要迭代数轮才能稳定。但 prompt 迭代成本远低于机械 schema 一旦定型的修改成本 |
| LLM 推理失败的本底概率 | 所有 AI-Native 系统共担的背景风险。基座模型迭代会持续降低 |
| 默认开启后用户察觉不到的偏差累积（`autoLlmWriteEnabled` default true 以后首次真正存在） | ADR 0025 §5.3 P5.5 指出：默认关闭时用户必须主动改 settings 才启动 —— 此时偏差累积的供给侧未启动，代价不存在。默认 true 后，用户不再需要元动作启动 sediment，但这意味着错沉淀会静默发生。对冲机制：§5.1 aggregator + §5.4 multi-view + ADR 0025 §3.2.B sanitizer + tristate `"staging-only"` 退路（中度关闭，剩下只启 classifier 与 staging、不进 durable 写入） |
| 路径 A inject 噪音污染主 LLM 注意力（2026-05-28 路径 A v2 落地后新增） | ADR 0026 §3.1 walk-back 后每轮跑 search + inject。如果 stage 2 LLM verdict=has_relevant 但实际 entry 跟当前任务关联弱，主 LLM 读 system prompt 会多 1-2KB noise。缓解：多 LLM 串联 (rewriter / stage 1 / stage 2) 每环都有 silent-fail 通道；cutoff 是 LLM-side 不是 score 阈值；path-a-ledger 双周 dogfood 数据。代价是为了兑现 ADR 0024 §6 #5 偏差累积对冲机制中“第二大脑参与”该部分的接受代价 |
| 路径 A 多 LLM 串联 misframe 累积（2026-05-28 新增） | rewriter 漏掉 history 关键信号 → stage 1 在错 query 上选 candidate → stage 2 在错候选集 rerank。缓解：rewriter v2 看 history + history dedup；跨阶段 ledger 单环输出可离线 diff（multi-view 思想应用到 retrieval pipeline）；path B (memory_decide) 独立兜底 |
| 路径 A 召回受 sediment metadata 质量 cap（2026-05-28 新增） | Stage 1 看的是 frontmatter，entry body 决定性证据 Stage 1 看不到。已知漏召模式：用户用跟 entry 内容完全不同词汇 framing 检索。缓解：ADR 0026 §3.0.3 v3 候选 C (stage 1 全文 body)，需要 ADR 0015 二阶段 rerank prompt cache 妥协 walkback（cost 不再是 P0 约束） |

---

## 7. 走偏信号（什么时候需要回头看这份文档）

实际跑起来如果出现下面任何一条，需要回头审视这份设计是否需要调整：

1. **自然对话纠正不了的错持续累积** → INV-AUTONOMY 可能需要部分回退（引入轻量用户参与）
2. **跨设备错误传播代价过大** → 可能需要 per-device override 机制
3. **Multi-view 跨基座调用成本不可承受** → 需要更轻量的自检替代
4. **跨设备主动纠错疲劳信号显著** → 重复升级阈值需下调，或引入"已经说过了" speech act 显式识别
5. **classifier 推理质量持续退化** → §5.3 advisory flag 任一维度（quote rate / alternative rate / concrete self-critique rate）持续低于 40% 或下降 ≥15 个百分点，且改 prompt 数轮无改善 → 该能力点降级为 staging-only 或拆到独立 ADR
6. **AI-Native 原则在某个能力点反复证伪**（多轮 prompt 迭代仍无法达到 baseline）→ 该能力点单独允许机械兜底（需显式说明 (1) prompt-first 已尝试的轮次 (2) 仍然系统性失败的推理证据 (3) 兜底的局部范围 (4) 未来移除兜底的条件），**不全盘 walkback 原则**

   > **注：defense-in-depth (prompt + code belt-and-suspenders) 跟本条说的 "反复证伪后 walkback 兑底" 是两种 pattern**。multi-view P0.5 的 `workflowLaneRefusal` (代码拒绝 reviewer 在 workflow-lane neighbor 上的 archive/update 以化除按推荐) + `synthesizeFromPass1 返 null` (Pass 1 schema 缺 rich payload 时拒 update/merge/supersede/delete) 都是 belt-and-suspenders：prompt 已经含 HARD CONSTRAINT (`multi-view-pass1-blind-v1.md:60-83`)，代码兑底仅是 “万一 prompt 不听话” 的二道防线。本条 (1)轮数 / (2)证据 不适用于这种 pattern——兑底跟 prompt 同时上线。defense-in-depth 需满足：(a) prompt 仍是主路径 (b) 代码兑底只能拒绝 (c) 走明确 audit-flagged skip。multi-view.ts 中两个点都满足。

7. **R6 删除的"准确率阈值 / 月度自动迭代 / 准确率 smoke" 在实战中被证明确实必需** → 重新引入但必须 framed 为"仅供参考的指标 / 迭代辅助"而非硬关卡

**重要原则**：以上 walkback 必须基于真实实战数据，不是基于"想象中可能会"。**不试试无法判断这份设计是否可行**。

---

## 8. 这份文档不是什么（防止后续套错框架）

- **不是** "大脑运行状态对用户不可见"——**恭喜反了**。这正是 2026-05-24 commits f3555e8 / 16cb6f0 错误实现的方向（已修正）：运行状态指示（footer / notify / audit）**应该正常运行让用户明确感知大脑在工作**。隐身 = 用户不参与管理，**不** = 大脑不能告诉用户它做了什么。
- **不是** "大脑对用户完全透明不可问"——用户主动问大脑 OK，查询入口 (`/abrain status` / `/rule list`) 对所有用户开放
- **不是** "禁止所有 ui.notify"——vault / 任务相关错误 / **大脑生命周期事件完成反馈** 均可通知。禁止的是 notify 后跟"要求用户点选项"
- **不是** "禁止 prompt_user"——任务相关具体决策仍是合法用途（ADR 0022）；只禁止"用 prompt_user 询问 sediment 生命周期决策"（要求用户裁决、批准、选项词表）
- **不是** "禁止用户跟大脑交互"——所有自然对话**就是**大脑的观察面
- **不是** "用户完全被动"——任务里主动纠错是核心信号通道（INV-ACTIVE-CORRECTION）。"observed subject" 的准确含义是"用户在任务里持续主动，但不被叫去做专门为大脑设计的元工作"
- **不是** "禁止所有机械工程"——基础设施层（git / 文件系统 / 同步等）的机械保证仍然必要且允许；§3 AI-Native 原则只禁止"机械门作为 LLM 行为层的主要防出错手段"。机械兜底在该能力点显式说明后允许存在
- **不是** "强制立即实施"——按 §5 六条能力点分阶段实施，工程量大约是 pi-astack 当前体量翻倍，多季度迭代

---

## 9. 演进历史和评审快照

本 ADR 经过 7 轮多模型评审 + 用户两次元层调整方向才稳定下来：

| 阶段 | 关键产物 |
|---|---|
| R1-R3 | 在 leading-prompt 偏置下评分跌到 22%。三家评审产出 11 条防出错方案**全部是加机械门方向**（未被发现） |
| R4 (critic+steelman + 5 层自检) | leading-prompt 偏置被校正，评分回到 47%。但 RLHF 机械主义偏置仍在 |
| R5 (用户元层调整角色) | 用户重新定义"用户从被观察的被动主体变成任务里一直主动的主体"，加入 INV-ACTIVE-CORRECTION |
| R6 (用户元层调整防出错范式) | 用户发现"评审本能加机械门"是 RLHF 训练偏置——把 AI-Native 原则升格为 ADR 显式约束 |
| R7 (R6 之后首次独立评审) | 硬注入 Layer F 自检后，三家评审产出 21 条建议**无一**落入机械门（vs R1-R5 11/11）。首次实证 Layer F 能阻断 RLHF 机械主义偏置 |

**评审快照**：
- R1-R6 全程审计：[docs/audits/2026-05-21-adr-0024-multi-llm-r1-r6.md](../audits/2026-05-21-adr-0024-multi-llm-r1-r6.md)
- R7 prompt-engineering-only 评审：[docs/audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md](../audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md)
- R5 原版（R6 重整理前）：见 git history（R6 是同日内部修订：机械门 → prompt engineering 双层 reframe）

**已不再保留在主文档中**（演进过程已稳定，需要追溯请看 git history 或上述 audit）：
- INV-R8 / INV-R9 / INV-R11 / INV-R12 / INV-R13 各种历史 invariant 编号
- 反向 patch 历史 ADR 列表（ADR 0023 / 0021 / 0017 / 0016 / 0020 各 patch 项）—— R0 阶段已经一次性 patch 完
- R2-R6 实施阶段详细 LOC 估算 + phase 路线图—— 实际按真实 dogfood 反馈逐步 ship

---

## 10. 相关的项目记忆

- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim) — 本 ADR §3 AI-Native 原则的两条直接哲学依据之一；R6 reframe 把它从隐性 maxim 升格为 ADR 显式方法论约束
- `prefer-prompt-engineering-over-mechanical-guards` (maxim) — 另一条哲学依据；R7 实证这条 maxim 在硬注入后能阻断 RLHF 机械主义偏置
- `mechanical-floor-rejection-guards-removed-from-sediment-writer` (decision) — ADR 0018 同款删机械护栏路径的延续
- `agents-md-progressive-disclosure-minimal` (maxim) — "默认不披露，用户主动问才披露" 从 AGENTS.md 推广到整个大脑
- ADR 0023 第二大脑威胁模型（§1.4）—— 本 ADR §2 invariant 的直接前置
