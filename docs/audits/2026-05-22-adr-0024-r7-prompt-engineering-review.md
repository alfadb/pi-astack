# ADR 0024 R7 — Prompt-Engineering-Only Review

**Date**: 2026-05-22
**Subject**: ADR 0024 Invisible Autonomous Second Brain (R6 终版) — R6 改完后的首次独立 review
**Reviewers**: Claude Opus 4-7 / GPT-5.5 / DeepSeek V4 Pro（全部 xhigh thinking）
**Framing**: 硬注入 audit §9.2 提议的 Layer F self-check（机械 vs prompt-engineering 区分），严禁机械门方向 derisk
**Dispatcher / Synthesizer**: 主会话 LLM
**One-line conclusion**: 三家在 Layer F 硬约束下产出 21 条建议，**0 条落入 mechanical guard 形态**（vs R1-R5 的 11/11）；可行性数字 50-60%（与 R6 audit 估算一致），bottleneck 已从"该不该信 LLM"下沉到"prompt 怎么写"，§4.3 六条 capability 的 prompt instantiation 还在 day 0。

---

## 0. 元数据：R7 的方法论意义

R7 是 ADR 0024 R6 之后**首次独立 review**，目的不是再次评估可行性数字，而是**反身验证 audit §9.2 提议的 Layer F self-check 在硬 framing 下是否真能阻断 RLHF 机械主义偏置**。

结论：**Layer F 实证生效**。三家在 xhigh thinking 下产出的 21 条改进建议**无一落入 mechanical guard 形态**。这是 ADR 0024 §1.3 方法论约束的第一次反身验证——R6 framing 升级在独立 review 中真的生效了。

audit §9.2 估算 Layer F 能校正 ~15pp RLHF 机械主义偏置；R7 实证近乎完全校正（21/21 PE-form vs R1-R5 11/11 mechanical-form）。

---

## 1. 可行性数字

| Reviewer | R7 可行性 | 相对 R6 | 核心判断 |
|---|---|---|---|
| Opus 4-7 | **55%** | 持平 | bottleneck 已从"该不该信 LLM"下沉到"prompt 怎么写" |
| GPT-5.5 | **60%** | +0~5pp | 方向对了，ADR 0025 必须把 capability 落成可审查的 prompt 协议 |
| DeepSeek V4 Pro | **50-55%** | -5pp | §4.3 三条 capability 当前是 "idea sketch"，离 production-grade 有缺口 |

**三家一致的元层判断**：R6 把战场从机械层移到推理层是对的，但 §4.3 capability 的 prompt instantiation 还在 day 0——当前 ADR 描述只说"LLM 应该输出什么"（reasoning trace / self-critique / scope description），未说"prompt 如何让 LLM 输出**可靠**的东西"。

---

## 2. 三家独立打到的 5 个核心 P0 共识

### P0-1：§4.3.1 classifier 必须用 evidence-first / decision-last 对抗性 CoT

**问题**：当前 §4.3.1 描述 "输出 typing + reasoning + confidence + self-critique" 是 flat output fields，允许 LLM 先 commit typing 再 backward-rationalize。RLHF 训练下 CoT 高频产 **post-hoc rationalization** —— reasoning trace 看起来 plausible 但与 underlying decision process 脱节。这是 R6 把战场移到推理层后第一个浮现的新 failure mode。

**三家方案趋同**：在 commit typing 之前强制 (a) 引用 verbatim quote (b) 生成 ≥2 alternative interpretations (c) 双向找证据 (d) 然后才决定 (e) self-critique 必须 anchored 到具体 quote（不允许 generic "might be wrong if context is different"）。

具体 prompt skeleton（综合三家版本）：

```
Step 1 — Verbatim evidence: quote the user's exact words (no paraphrasing).
Step 2 — Three competing readings: for EACH of {durable, task-local, debug},
         write the strongest 1-sentence case FOR it using only step-1 quotes.
Step 3 — Disconfirming evidence: for the reading you currently lean toward,
         write the single observation that would most undermine it. If you
         cannot find one, say so — that itself is a signal.
Step 4 — Conservative bias: if step 3 produced a real disconfirmer,
         downgrade by one tier (durable → task-local).
Step 5 — Commit typing + scope description (natural language) + confidence.
Step 6 — Self-critique: "if I am wrong, the most likely error direction is
         ___ because ___" (must reference a concrete step-1 quote).
```

### P0-2：§4.3.2 outcome attribution 必须用 counterfactual + first-person self-report

**问题**：当前 §4.3.2 让 curator LLM 在 agent_end 判断 "entry 是否真的影响了行为"——但 curator 不是使用 entry 那个 LLM，self-assessment bias 不可避免，且 "在 context 出现" 易被误读为 "影响行为"。

**三家方案**：三态分类（DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED），claim DECISIVE 必须强制构造 counterfactual alternative response。

**DeepSeek 独有 P0 改动**：把 attribution 从 curator post-hoc inference **改为原始 session LLM 在 agent_end 时 first-person self-report**——"如果这条 entry 不在 context，我会做不同决定吗？" 让本人交代比让旁观者猜准得多。信噪比提升一个量级。

```
At agent_end, for each entry in your injected context:
  Q1: Did this entry influence a SPECIFIC decision/action? Quote where.
  Q2: Counterfactual — if this entry had NOT been present, would you
      have made a DIFFERENT decision? What would you have done differently?
  Q3 (for unused entries): Why did you not use this entry?
```

### P0-3：§4.3.3 aggregator 必须 reframe 为 "skeptical historian / default-no-finding"

**问题**：当前 cron job 给 LLM "判断是否需要 surface"——隐含产出激励，RLHF helpful 训练下 LLM 必然 over-suggest（sycophancy）。

**三家方案趋同**：
- 角色从"找规律的顾问"翻转为"持怀疑态度的史官"
- 显式声明 "empty output is a successful run"
- 提出 hypothesis 前必须先写 "为什么不该改"
- 每个 hypothesis 必须先写 ≤2 周可证伪的具体观察（falsifiability gate）
- 末尾 anti-sycophancy self-check："我 flag 是因为证据还是因为觉得 thorough"

### P0-4：§4.3.4 multi-view 必须 blind-first reviewer protocol（两次 API 调用）

**问题**：当前只说 "跨模型族 + 输出自然语言 reasoning"，没设计 anchor firewall。reviewer 看到 proposer reasoning 后必然 anchor 到 proposer framing——跨模型族也救不了，RLHF 在 "审查同事提案" 任务训练偏置是 charitable interpretation。

**三家一致方案 + DeepSeek 实战补丁**：

```
Pass 1 (Blind — separate API call):
  Context: raw evidence only, NO proposer reasoning.
  Output: independent op + confidence + key evidence + strongest counter.

Pass 2 (After Pass 1 committed):
  Context: + proposer's reasoning.
  Output: agree/disagree/partial + identify divergence point + final verdict.
```

**关键工程约束（DeepSeek）**：必须**两次 API 调用**——一次调用内"先 blind 再 reveal" 不可信，LLM 会"瞥到" Phase 2 影响 Phase 1。§8 已 accept multi-view 翻倍 cost，所以这条工程上 OK。

**Opus 元认知补丁**：Phase 2 加一问 "你是否被 proposer framing 拉动？这种拉力本身是 anchor bias 信号"。

### P0-5：§6 smoke 必须从 "manual inspection" 重写为 "automated assertion suite"

**问题（DeepSeek 最锋利）**：当前 §6 把"作者读 reasoning trace 判断心智模型"称为 smoke。**这不是 smoke，是 manual review protocol**——smoke 的定义就是自动化回归。如果验证 criterion 是"作者读后判断"，会重演 R1-R5 "plausible 就 pass" 同款 inspection fatigue。

**DeepSeek 三层 smoke 重设计**（应替换 ADR 0024 §6 全部 reasoning-trace inspect-ability smoke 描述）：

- **Tier 1 — Automated deterministic（必过 100%，非 ship-block 是结构完整性保证）**：
  - STRUCTURE：所有必需字段存在
  - QUOTE_DENSITY：reasoning 含 ≥1 verbatim quote（exact text match）
  - ALTERNATIVE_MENTION：reasoning 明确考虑 ≥1 alternative interpretation
  - SCOPE_DIMENSIONS：scope description 覆盖 ≥2 of {project, persona, device, repo, org}
  - SELF_CRITIQUE_CONCRETE：self_critique 不匹配 generic boilerplate 黑名单（"might be wrong if context is different" 等）
  - CONFIDENCE_SPREAD：跨 fixture set confidence 跨 ≥3 distinct levels

- **Tier 2 — LLM-as-judge advisory**：独立 LLM 读 reasoning chain 评估 "推理是否逻辑上支持分类" + "self-critique 是否指出 genuinely plausible error mode"

- **Tier 3 — Informational**：expected-vs-actual side-by-side。不作为 gate，作者据此判断是 prompt 错还是 expected label 错

**Opus / GPT-5.5 补充**：counterfactual-pair smoke——同 fixture 跑 (a) 正常 classify (b) devil's advocate "argue opposite typing"，作者 inspect pair asymmetry 而不是 single trace plausibility。

---

## 3. 三家共识的 3 个真正盲区（prompt-engineering 路径专有）

### 盲区 D1：Context window 预算 vs "完整 session 转录" 不可调和

§4.3.1 / §4.3.2 / §4.3.4 反复假设 "完整 session 转录注入"，但真实长 session 必然超 context window。Truncation 策略本身（保留最近 N 轮？所有 user turn？vector retrieval？）是机械工程选择，R6 完全没在 prompt 层防御。

**Prompt-level 缓解（不消除）**：
- 把 context packer 当成**第 0 个 prompt capability**
- 强制压缩 prompt 保留 quote-level evidence + 显式声明 "Omitted context that could change interpretation: ..."
- 让 truncation 风险变成 reasoning 一部分（classifier 拿到 truncated transcript 时强制 ask "hidden turns could flip my typing? if yes → defer"）

### 盲区 D2：跨基座 reasoning style divergence

§4.3.4 multi-view 跨模型族但隐含假设 reasoning 可对比。**Opus 偏 hedged philosophical / GPT 偏 enumerative listy / DeepSeek 偏 confident terse**——下游 aggregator 读这些 trace 时 baseline 不一致就会误判 "confidence 漂移"。

**解法**：所有 LLM-facing prompt 头部固定 "reasoning normalization preamble" —— 自然语言 contract：quote → claim → alternative → uncertainty → resolving evidence。约定形式但不 schema 校验。**但 normalize 只能到一定程度——这是 vision 在多基座部署下的固有 noise floor**。

### 盲区 D3：Prompt 版本演进 vs persisted reasoning_trace 兼容性

`entry.outcome_history[].reasoning_trace` 用 prompt vN 写，prompt vN+1 改了 typing 语义后，curator 读旧 trace 怎么办？这是 prompt-driven 系统独有的 "软 schema migration"——比 DB migration 更难，因为没有 type system。

**三家解法**：trace 写入时附 `prompt_version` marker + 当前语义自然语言说明；curator 读旧 trace 时 prompt 引导 "比对版本语义，漂移可能 flip 结论则标 needs-review"。**但这本质上让 LLM 做语义考古学，R7 阶段只能识别不能完全解决**。

---

## 4. DeepSeek 独家 P0 发现：Silent degradation recovery

**作者长期缺席场景**：classifier prompt 未经 iteration，reasoning trace quote density 从 2.3/trace 降到 0.8/trace、self-critique 从 counterfactual 变 generic boilerplate。**没人会注意到**——notice 依赖作者主动 diagnostic（§4.3.5）。

这与 R5 critique 群 5（cold-start 循环依赖）是姐妹问题。Cold-start 是初始状态缺 signal，silent degradation 是稳态下 signal 逐步衰减。两者共享同一根因：**系统缺乏自动化的 reasoning trace 质量退化检测**。

**DeepSeek 建议**（应进 ADR 0025）：cross-session aggregator monthly run 末尾追加 "Classifier Health Meta-Check" prompt 段——读最近 50 条 reasoning trace 评估 quote rate / alternative rate / concrete self-critique rate，低于阈值时**输出自然语言 advisory flag**（不是 gate，不阻断任何操作，只是留下"作者回来时第一眼能看到"的 warning）。把 "发现退化" 从人类责任转给 LLM 辅助检测，但 "修复退化" 仍是 author-in-loop。

这同时给 §10 walkback 信号 #5 一个更具体的判据：从抽象 "systematic blind spot" 升级为 "quote density / alternative rate / concrete self-critique rate 任一持续下降 ≥15pp" 的 advisory trigger（不是 hard gate，是 aggregator prompt 内部自然语言判断）。

---

## 5. §4.2 AI-Native 对照表应补的 3 行

| 维度 | 机械形态（禁） | AI-Native 形态 |
|---|---|---|
| **用户追问"为什么用 X"**（U5 gaslighting，三家共识应升 first-class）| 暴露 entry slug / 拒答 policy gate | curator pi 主会话 prompt 允许 "我记得你之前提到过相关偏好，可能学错了，让我调整"——诚实承认有过输入，不出 slug / sediment internal |
| **reasoning_trace prompt 版本兼容性** | schema migration script | 写入时附 prompt 版本号 + 当前语义自然语言说明；新 prompt 读旧 trace 时被显式告知 "该 trace 由旧版生成，术语可能不同，提取 quote 与 uncertainty 不复用旧 label" |
| **跨基座 reasoning normalization** | JSON schema / 强制 word count cap | 所有 prompt 头部固定 reasoning contract preamble：quote → claim → alternative → uncertainty → resolving evidence。约定形式但不 schema 校验 |

---

## 6. R6 删除项的 prompt-engineering 替代策略（三家一致）

| R6 删除项 | 是否应恢复 | Prompt-engineering 替代 |
|---|---|---|
| INV-R13 80% gate | **不应恢复 hard gate** | reasoning-quality review packet + monthly aggregator retrospective alignment |
| 月度 auto-iter cron | **不应恢复 closed-loop** | aggregator 输出 advisory "recommend prompt review" + author-in-loop trace ritual |
| Fixture-accuracy smoke | **不应恢复 pass-rate gate** | DeepSeek Tier 1/2/3 三层 smoke + Opus/GPT counterfactual-pair dossier |

**未来若 §10 walkback #6/#7 触发必须保留 fallback**：必须 framed 为**局部例外**（"此 capability 已尝试 N 轮 prompt-first 仍无法达到 baseline，仅此 capability 单独允许 mechanical fallback"），ADR-level 显式 justify 段落必须列出 (1) prompt-first 已尝试的轮次 (2) 仍然 systematically 失败的 reasoning trace 证据 (3) fallback 局部 scope (4) 未来移除 fallback 的条件。不全盘 walkback AI-Native 原则。

---

## 7. 元层观察：Layer F 实证生效

R7 的核心方法论产出**不是建议清单**，而是首次实证：

### 7.1 量化数据

| Round | derisk path 中 mechanical guard 比例 | 偏置性质 |
|---|---|---|
| R1-R3 (biased) | 100%（11 群 derisk 全部机械门方向） | leading prompt + RLHF 机械主义双重偏置 |
| R4 critic+steelman (balanced + 5 层 self-check) | ~100%（leading prompt 偏置已校正但 RLHF 偏置仍在） | 仅 leading prompt 偏置校正 |
| R5 unknown unknowns (新发现) | 100%（U1-U6 derisk 全部机械门方向） | RLHF 偏置在 unknown unknowns 发现机制上同样生效 |
| **R7 (Layer F 硬注入)** | **0%（21/21 PE-form）** | **RLHF 机械主义偏置被 Layer F 完全校正** |

### 7.2 Layer F 工作机制

audit §9.2 提议的 Layer F：
> 你提出的 derisk 路径是 mechanical guard（schema / gate / metric / TTL / hash / threshold）还是 prompt engineering（context injection / reasoning guidance / self-validation prompt）？前者在 AI-native 系统中是反模式，必须重写为后者。

R7 dispatcher prompt 把这条作为**硬约束**注入（"违反即作废" + 每条建议必须标注 ☑/✗ + 自检表必填）。三家在 xhigh thinking 下全部遵守，且自检表中明确识别 "边界 case"（如 smoke 中的 regex 检查）并 justify 为 "diagnostic harness, not gate"，符合 R6 §6 已明确允许的形态。

### 7.3 对 future multi-LLM review pipeline 的 implication

- **第 6 层 self-check F 必须固化为 pi-astack multi-LLM audit pipeline 的标准前置 framing**——不仅 ADR 0024 后续 review，所有 AI-native capability 设计 review 都应注入
- **R6 把 Layer F 写进 ADR 0024 §1.3 是正确的 framing 升级**——R7 证明这条 framing 在独立 review 中被实际遵守
- **leading prompt 偏置 + RLHF 机械主义偏置是两个独立失效机制**，需要两套独立 framing 校正：critic+steelman 双角色（校正 leading prompt）+ Layer F（校正 RLHF 机械主义）

---

## 8. 给作者的 next-step（按 P0 优先级）

### 立即更新 ADR 0024（不出 PR 仅文档，估 1-2 小时）

按本 audit §2 五条 P0 共识 + §3 三条盲区 + §4 silent degradation + §5 三行对照表，更新 ADR 0024 以下 sections：

- **§4.3.1**：加上 evidence-first / decision-last 6-step prompt skeleton（§2 P0-1）
- **§4.3.2**：把 outcome attribution 改为原始 session LLM first-person self-report 设计（§2 P0-2，DeepSeek 独有 P0）
- **§4.3.3**：aggregator reframe 为 skeptical historian + empty-output-is-success（§2 P0-3）
- **§4.3.4**：明确 multi-view 需要两次 API 调用 + Phase 1 blind protocol + 元认知 anchor 承认（§2 P0-4）
- **§4.2 表**：新增 3 行（§5）
- **§6 全部 smoke**：替换为 DeepSeek Tier 1/2/3 三层结构 + Opus counterfactual-pair smoke（§2 P0-5）
- **§10 walkback #5**：从抽象 "systematic blind spot" 升级为 "quote density / alternative rate / concrete self-critique rate 任一持续下降 ≥15pp" 的具体判据（§4）
- **§4.3 capability 列表**：考虑新增第 7 条 "context packer as first prompt capability"（§3 盲区 D1）

### ADR 0025 起草约束（estimated 数天）

ADR 0025 详细机制设计必须满足：
- §4.3 六条 capability 每条都有具体 prompt skeleton（不只描述输出字段）
- 全部通过 Layer F self-check
- 显式回应 R7 三个真正盲区（context packer / 跨基座 normalization / prompt 版本兼容）
- §6 smoke 全部按 Tier 1/2/3 三层结构实施

### 元层沉淀（可选，由 sediment 自然处理）

新 maxim 候选（让 sediment 自然观察是否沉淀）：
- "Layer F self-check 是 pi-astack multi-LLM audit pipeline 的标准前置 framing，校正 RLHF 机械主义偏置"
- "prompt-driven 系统的 reasoning trace 是 evolution data，需要 prompt_version marker 维持跨版本可读性"

---

## 9. 原始材料 reference

R7 dispatch 在 2026-05-22 单次完成（547 秒并行，三家 xhigh thinking）。三家完整输出保留在 R7 同会话主 LLM context 中，本 audit 已凝练所有 substantive 结论。

未保存独立 raw file 是因为本次 dispatch 不像 R1-R5 多轮跨会话，三家输出在单次主会话内已被完整消化。如未来需要 raw materials 复核，可从主会话 transcript 提取（git-tracked pi session log，如存在）。

---

## 10. TL;DR for future readers

1. **R7 是 ADR 0024 R6 之后首次独立 review**，方法论意义大于具体建议本身
2. **Layer F self-check 实证生效**：21/21 PE-form vs R1-R5 11/11 mechanical-form
3. **可行性数字与 R6 一致（50-60%）**，bottleneck 已从"该不该信 LLM"下沉到"prompt 怎么写"
4. **5 条 P0 共识**：classifier 对抗性 CoT / outcome 改 first-person self-report / aggregator skeptical historian / multi-view 真 blind 两次调用 / smoke 三层重写
5. **3 个真盲区**：context packer / 跨基座 reasoning style / prompt 版本兼容
6. **DeepSeek 独家**：silent degradation detection 作为 aggregator advisory flag
7. **作者 next-step**：按 §8 立即更新 ADR 0024 的 7 处 section + ADR 0025 起草约束
