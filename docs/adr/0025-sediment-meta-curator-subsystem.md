# ADR 0025 — Sediment Meta-Curator 子系统：六条能力点的落地设计

- **状态**：**R1（2026-05-22）**。本 ADR 是 [ADR 0024](0024-second-brain-from-natural-conversation.md) §5 六条能力点的具体机制设计。R0 骨架经 [R8 audit](../audits/2026-05-22-adr-0025-r0-prompt-engineering-review.md) 三家 T0 在 Layer F v2 硬注入下评审（平均可行性 61%）后起 R1，落地三家共识 6 个 P0（§2.3 prompt 漏洞 / §1 接口面错位 / §8 phase 错排 / §10 self-check 不到位 / §2.5 staging 链断裂 / §3.3 outcome 三方案选定）+ 1 个 P1（context-packer 作为 0 号 capability）+ 三家关键盲点。**目前仅设计，未实施**。
- **依赖**：
  - [ADR 0024](0024-second-brain-from-natural-conversation.md) — 总框架文档；本 ADR 不重复 §2 invariant、§3 AI-Native 原则、§4 边界，下面只在违反检测时引用
  - [ADR 0014](0014-abrain-as-personal-brain.md) — 七区 layout + invariant #7 互斥；本 ADR §1.4 明确 staging 不是第 8 区 / 9 区，是 sediment 内部 transient store
  - [ADR 0016](0016-sediment-as-llm-curator.md) — sediment 当 LLM curator 的哲学；本 ADR 是这条哲学的能力点级落地
  - [ADR 0018](0018-sediment-curator-defense-layers.md) — 删机械护栏的先例；本 ADR 的"防出错全走 prompt 工程"是同款延续
  - [ADR 0015](0015-memory-search-llm-driven-retrieval.md) — LLM-driven retrieval；能力点 1 的 related_entries 走 memory_search，但 staging 走独立 staging-loader 不改 memory_search corpus
  - [ADR 0020](0020-abrain-auto-sync-to-remote.md) — 跨设备一致传播；§2.5 staging 加 `originating_device` 字段避免分布式 provisional 垃圾
  - [ADR 0023](0023-session-start-rule-injection.md) R4 — D4 unified zone+tier+op classifier；本 ADR §1.5 明确主动纠错识别作为 unified classifier 的新输出维度，不是第 3 个独立 LLM 调用
  - [ADR 0003](0003-main-session-read-only.md) — 主会话只读；§3.3 outcome self-report 选方案 C（隐藏 metadata）以避免主会话 LLM 写 brain
- **被引用**：本 ADR 实施 P0 后反向 patch ADR 0023 R5 / 0021（unified classifier 落到本 ADR 能力点 1）
- **评审快照**：[R0 R8 audit](../audits/2026-05-22-adr-0025-r0-prompt-engineering-review.md)（Opus 4-7 / GPT-5.5 / DeepSeek V4 Pro 在 Layer F v2 硬注入下的并行 xhigh 评审）4
- **触发**：ADR 0024 R7 之后六条能力点的 prompt skeleton 已经稳定，但 skeleton 不是 production-ready prompt——还差完整文本、输入输出 schema、调用编排、与现有 `extensions/sediment/` 代码的接口。本 ADR 填这个缺口。

---

## 0. 起草说明（这份文档干什么 / 不干什么）

### 这份文档**只写**

- 六条能力点的**production-ready prompt 完整文本**（不只是 skeleton 摘要）
- 输入 / 输出 schema（哪些字段、什么类型、谁读谁写）
- 触发条件（agent_end / cron / 高价值操作 / 用户诊断入口）
- 调用编排（哪些 LLM 调用、顺序、失败处理）
- 与现有 `extensions/sediment/` 代码的接口（要加哪些文件 / 改哪些 hook）
- 测试设计（按 ADR 0024 §5 / §6 走三层 smoke）

### 这份文档**不写**

- 设计哲学 / invariant / 自然交互 vs 管理大脑边界——那在 ADR 0024
- 反模式列表 / 灰色地带处理原则——那在 ADR 0024 §4
- 走偏信号 / 接受的代价——那在 ADR 0024 §6 / §7
- 演进历史 / 评审过程——那在 audit/ 目录

如果发现本 ADR 在重复 ADR 0024 的内容，**删掉**（重复就是 drift 风险）。

### R0 → R7 演进路径（R8 audit 后伸长一轮）

| 阶段 | 范围 | 状态 |
|---|---|---|
| R0 | 骨架 + 能力点 1 完整 + 其余 5 条骨架（534 行） | ✅ ship（bd16805），[R8 audit](../audits/2026-05-22-adr-0025-r0-prompt-engineering-review.md) 查出 6 个 P0 |
| **R1**（本稿） | R0 + R8 audit 6 P0 落地（事实错误 + 6 P0 + 1 P1 + 7 盲点） | 起草中 |
| R2 | 能力点 2（outcome self-report）完整 prompt + schema | 待 R1 ship |
| R3 | 能力点 3（aggregator）完整设计 | 待 R2 ship |
| R4 | 能力点 4（multi-view full）完整设计 | 待 R3 ship（P0.5 minimal multi-view 与 P0 并行）|
| R5 | 能力点 5（classifier prompt 演进）完整设计 | 待 R4 ship（P4a substrate 与 P0 并行）|
| R6 | 能力点 6（静默归档 + 回滚窗口）完整设计 | 待 R5 ship（P5a substrate 与 P0 并行）|
| R7 | 三层 smoke 完整设计 + 实施 phase 路线图细化 | 待 R6 ship |

每个 R 阶段独立做多模型评审 → 收敛 → ship。**不一次性写完所有 6 条能力点的完整设计**——一次性写完风险高（reviewer 无法收敛、用户读不动、单点错位影响全局）。

---

## 1. 现有 Sediment 接口面（要改什么 / 不要改什么）

### 1.1 现有结构（high-level，R8 audit P0-B1 事实纠正）

**R0 误写**：“`llm-extractor.ts ← 当前 curator prompt（决定 create/update/merge/...）`”。这是事实错误。真实结构：

```
extensions/sediment/
├── index.ts                  ← agent_end hook 入口 + orchestration
├── llm-extractor.ts          ← runLlmExtractor() 产 candidate（不决定 op）
├── curator.ts                ← curateProjectDraft() 决定 create/update/merge/... 7 op
├── writer.ts                 ← 落盘（atomic write + git + appendAudit）
├── memory-architecture/      ← 七区 layout
└── ...
```

注意：`audit.ts` 不是独立文件，`appendAudit` 是 `writer.ts` 里的函数。R1 可以选择 (a) 保持现状，audit 逻辑留在 writer / (b) 拆出独立 `audit.ts`——选 (a)，减少重构面。

current 路径（write-only loop）：

```
agent_end
  → index.ts 接 hook
  → 读 conversation window
  → runLlmExtractor()（产 candidate）
  → curateProjectDraft()（决定 7 op）
  → writer 落盘 + appendAudit
  → done
```

主动纠错 classifier 应在 `index.ts` orchestration 层 hook，不是塞进 `llm-extractor.ts`。与 ADR 0023 D4 unified zone+tier+op classifier 的整合详 §1.5。

### 1.2 本 ADR 要在哪些层动（R8 audit P0-B2/B3 一致化）

R1 采用 **unified classifier 路径**（对齐 ADR 0023 D4）：主动纠错识别是现有 `curator.ts::curateProjectDraft()` 的一个新输出维度，不新建独立 classifier（避免第 3 个 LLM 调用、对齐 ADR 0024 §3 “同一调用多任务”哲学）。

| 能力点 | 改 / 加什么 |
|---|---|
| §2 主动纠错识别 | **改 `llm-extractor.ts` + `curator.ts`**：classifier prompt 合并 evidence-first 6 步骨架 + 三类语义为 unified classifier 的新输出维度（CorrectionSignal field set）；**加 `correction-pipeline.ts`**：后续处理（staging 写入 + multi-view 排队 + session cache） |
| §2 P1 context-packer | **加 `context-packer.ts`**（0 号 capability，R8 P1-1 / R7 audit D1）：conversation_window 超 token budget 时，prompt 驱动裁剪 + 明译¨'Omitted context that could change interpretation: ...' |
| §2 staging 召回 | **加 `staging-loader.ts`**（R8 P0-B5）：从 staging/ 加载 attribution_pending 条目作为 classifier 独立输入字段 `staging_context`，**不改 `memory_search` corpus** |
| §3 outcome self-report | **加 `outcome-collector.ts`**：agent_end 时读主会话 LLM 每轮隐藏 metadata（方案 C，详 §3.3）汇总为 outcome_history；**不进 entry frontmatter**——独立 sidecar ledger（R8 P0-B §1.3）避免 frontmatter 无限增长 |
| §4 cross-session aggregator | **加 `aggregator.ts` + scheduler hook**：定时任务（daily/weekly/monthly），独立于 agent_end |
| §5 multi-view verification | **加 `multi-view-reviewer.ts`**：触发条件命中时拆两次独立 API 调用；**P0.5 minimal 版本与 P0 并行**（R8 P0-C1）保护 P0 高置信度 durable correction |
| §6 classifier prompt 演进 | **加 `/abrain audit classifier` 诊断入口**；**`prompt_version` substrate 与 P0 同期上线**（R8 P0-C2）；prompt 改动是人在 loop，不加自动 iteration |
| §7 静默归档 + 回滚窗口 | **改 `writer.ts`**：`status=archived` 软删 N 天后才 `git rm`——soft-delete substrate 与 P0 并行上线（R8 Opus 盲点）；**加 `archive-rollback.ts`**：N 天窗口内反证检测的 prompt |

**Prompt 文件清单**（独立 .md，方便述斸 + prompt_version 追溯）：

```
extensions/sediment/prompts/
├── reasoning-normalization-preamble-v1.md   ← 共用 preamble（§2/4/5 皆 prepend）
├── active-correction-classifier-v1.md       ← §2.3 完整 prompt
├── context-packer-v1.md                     ← long-session 裁剪 prompt
├── outcome-self-report-v1.md                ← §3 隐藏 metadata prompt
├── aggregator-skeptical-historian-v1.md     ← §4
├── multi-view-reviewer-blind-v1.md          ← §5 Pass 1
├── multi-view-reviewer-reveal-v1.md         ← §5 Pass 2
└── archive-reactivation-reviewer-v1.md      ← §7
```

### 1.3 不要改的

- **七区 layout / core entry frontmatter schema** — ADR 0014 invariant #7，不动。core entry frontmatter 指 slug / kind / status / confidence / timeline / body 六字段。R1 新增字段（outcome_history）走 **独立 sidecar ledger** 不进 entry frontmatter；staging 条目的字段拓展限定在 staging 路径内（详 §1.4）。
- **`memory_search` 行为 + corpus** — ADR 0015 定下来的 LLM-driven retrieval，不动。staging 不进 memory_search corpus，走独立 `staging-loader.ts`。
- **writer 的 atomic write + git + appendAudit** — 持久化基础设施，不动；audit.jsonl schema 是 **additive 向后兼容 增量扩展**（加新字段 OK，不改现有字段语义）。
- **主会话只读** — ADR 0003，sediment 是 sidecar；任何能力点都不能给主会话加写工具。**§3.3 outcome self-report 选方案 C 隐藏 metadata 路径**以避免“主会话 LLM 写 brain”违反。
- **Sanitizer 走向 / typed redaction** — ADR 0016 / 0018 决定的同款 sanitize substrate，classifier 拿到的 conversation_window 已 sanitize，audit.jsonl 写入也走同款（R8 Opus 盲点 1）。
- **不增加主会话 UI / slash command** — 不新增 `prompt_user` 询问 sediment 生命周期决定 / 不新增 `/rule add` / `/rule veto` / 不默认暴露 staging 内容给主会话。高级用户诊断入口（§6）是例外但不推广。
- **ADR 0017 strict-binding** — project-rules 注入走严格绑定，主动纠错 typing=durable + scope_description 含“applies to current project”时归属不违反严格绑定。
- **ADR 0020 transport-only sync** — 跨设备同步只传输不仲裁；staging 同步加 `originating_device` 字段避免分布式 provisional 垃圾。
- **ADR 0022 prompt_user contract** — 任务相关 prompt_user 合法，**sediment 生命周期 prompt_user 是反模式**（ADR 0024 §4.2）。§3 outcome 是 LLM-to-LLM，不是 LLM-to-user。
- **现有 curator 7 op set** — ADR 0016 7 op（create/update/merge/supersede/archive/delete/skip）足以肩 R1 需要的所有路径，**不新增 op**。主动纠错产出的信号通过现有 7 op 落地。

### 1.4 staging 路径定义（R8 P0-B4）

staging 不是 core 七区、也不是 ADR 0023 第 8 区 rules。staging 是 **sediment 内部 transient store**，路径：

```
~/.abrain/.state/sediment/staging/
  ├── provisional-correction-{hash8}.md
  ├── ...
```

- 不进 core zone index
- 不被 memory_search 召回进主会话 context
- 只被 `staging-loader.ts` 读取，作为 classifier / aggregator 的独立输入字段
- ADR 0014 invariant #7 七区互斥不被违反（staging 不是 zone）
- ADR 0023 第 8 区 rules 不被动（staging 不是 rule）

staging frontmatter schema 是本 ADR 独定、与 core entry frontmatter 独立，详 §2.5。

### 1.5 与 ADR 0023 R4 unified classifier 的整合关系（R8 P0-B3）

ADR 0023 R4 D4 已经把 G3 aboutness classifier 合并为 unified zone+tier+op classifier。本 ADR §2 主动纠错识别 **作为 unified classifier 的新输出维度**，不是第 3 个独立 LLM 调用：

```
unified classifier output（R1 后）：
  - zone（rules / preferences / knowledge / facts / persona / ...）  ← ADR 0023
  - tier（always / listed）                                       ← ADR 0023
  - op（create / update / merge / supersede / archive / delete / skip） ← ADR 0016 / 0023
  - correction_signal（null / CorrectionSignal）                    ← 本 ADR 新增
```

同一调用同时产出四个维度，latency / token 成本不倍加。R1 §2.3 prompt 是主动纠错识别维度的部分，需与 ADR 0023 R5 unified classifier prompt 合并。合并点在 ADR 0023 R5 patch（本 ADR P0 反向交付项）。

---

## 2. 能力点 1：主动纠错识别（前置能力，本 R0 完整设计）

### 2.1 为什么这是前置能力

INV-ACTIVE-CORRECTION 是 ADR 0024 §2 第四条 invariant，定下"用户在任务里说'以后用 X'是核心真实信号通道"。但**主动纠错的识别质量决定其他五条能力的输入质量**：

- §3 outcome self-report 要知道"用户在 task 里反馈了什么" → 需要主动纠错识别
- §4 aggregator 要看跨会话趋势 → 需要先识别出每个会话里的纠错信号
- §5 multi-view 触发条件之一是"主动纠错相关的归档" → 需要识别
- §7 静默归档反证检测 → 需要识别用户是否在自然对话里"重新启用旧偏好"

**所以本 ADR R0 阶段先完整设计这一条；其他 5 条在本 ADR 落 R0 骨架就够，R1-R5 详细展开**。

### 2.2 触发条件

在 **`agent_end` hook 中、curator op 决定之前**插入。所有 `agent_end` 都跑——不需要预筛选（与 ADR 0024 §3.3 "几个典型机械形态" 表第一行对齐：classifier 不靠预筛选阈值，靠 prompt 引导）。

输入：

```ts
interface ClassifierInput {
  conversation_window: ConversationTurn[];  // 完整 window，不预剪
  recently_loaded_entries: MemoryEntry[];   // 本 session 主会话 inject 过的 entry（含 always / listed / search 结果）
  related_entries: MemoryEntry[];           // memory_search 召回的相关 entry（按主题 / 触发词）
}
```

输出：

```ts
interface CorrectionSignal {
  // Step 1-2 evidence
  user_quote: string;                       // 完整 verbatim quote
  surrounding_context: string;              // ≥3 行前后文
  three_readings: {
    durable: string;                        // 永久偏好的最强 1 句论据
    task_local: string;                     // 任务内临时的最强 1 句论据
    debug: string;                          // 调试探索的最强 1 句论据
  };

  // Step 3-4 disconfirmation
  initial_lean: "durable" | "task-local" | "debug";
  disconfirmer: string | null;              // 找到的最强反证（null = 没找到，自身是 signal）
  downgrade_applied: boolean;               // step 4 是否触发降级

  // Step 5 final classification
  typing: "durable" | "task-local" | "debug";
  scope_description: string;                // 自然语言 scope 描述（不是枚举字段）
  confidence: number;                       // 0-10

  // Step 6 self-critique
  most_likely_error_direction: string;      // 必须 reference step-1 quote
  most_likely_error_reason: string;

  // 归属处理
  target_entry_slug: string | null;         // 找到对应 entry → slug；未找到 → null + 写 staging hypothesis
  resolution_hypothesis: string | null;     // null 时为 null；未找到时是自然语言假设
}
```

### 2.3 完整 Prompt（production-ready，R8 P0-A 全量重写）

```
# Reasoning normalization preamble (§1.5 unified classifier 共用，prepended)

Your reasoning trace MUST follow this fixed structure across all
classification dimensions: quote → claim → alternative → uncertainty
→ resolving evidence. Do not rearrange. Do not skip stages. Different
base models (Claude/GPT/DeepSeek) have different default reasoning
styles; this preamble normalizes the surface so downstream multi-view
verification (§5) can compare apples-to-apples.

# Active-correction classifier (one dimension of the unified classifier)

You are reading the latest conversation window. Among other classification
dimensions (zone / tier / op), decide whether a user utterance contains
an active correction signal — a natural-language statement that updates
the brain's knowledge about user preference, identity, or anti-pattern.
The user does NOT see you run.

# What counts as active correction (positive examples)

- "以后用 X" / "from now on use X"                  ← durable preference shift
- "我换了，现在用 pnpm" / "I switched, using pnpm now"  ← durable shift, no “以后” marker (pattern-match 防护)
- "忘掉那条" / "forget that one"                    ← supersede instruction
- "你怎么记成 Y 了" / "wait you remembered Y?"      ← contradiction surfacing
- "现在我更倾向 Z" / "now I prefer Z"                ← preference update
- "这个项目用 X，但平时用 Y" / "this project uses X, but normally Y"  ← scoped durable
- "X 项目不要用 Y" / "don't use Y in project X"   ← scoped negation
- "以后不要用 X 了" / "no more X from now on"      ← durable + supersession 复合

# What does NOT count (negative examples)

- "we used X here because the task required it" / "这边用 X 是任务需要" ← task instruction, not preference
- "let's try Y this time" / "这次试试 Y"            ← experimental, not durable
- "X is broken, switch to Y for now" / "X 坏了先用 Y" ← debug, not preference
- "X 也行吧" / "X also works"                       ← reluctant acceptance, not preference
- "你看着办" / "you decide"                        ← delegation, not preference
- "哎 X 又挂了" / "ugh X broke again"             ← casual complaint, not correction
- (用户选 A 不选 B 但未说明)                       ← indirect signal, not active correction

# Bias cautions — self-check BEFORE producing the structured output below

(a) Post-hoc rationalization: am I about to write step 5 first in my
    head then back-fill step 1-4? If I notice this urge, restart from
    step 1.
(b) Sycophantic agreement: am I classifying as 'durable' because that's
    the highest-stake category and feels important?
(c) Anchoring on recently_loaded_entries: did seeing an existing entry
    push me toward classifying the utterance as superseding it, when
    actually the user was just task-instructing?
(d) Helpfulness / over-extraction: am I labeling this as a correction
    because there's real evidence, or because returning null feels like
    a 'lazy' answer? Returning null is a SUCCESSFUL run (most windows
    have no correction).
(e) Recency / verbatim-length bias: am I overweighting the most recent
    utterance? Re-read the FULL window and note if an earlier turn
    contains a stronger or weaker correction signal.
(f) Provisional-as-fact anchoring: when staging_context contains entries
    with status=provisional + attribution_pending=true, am I treating
    them as confirmed evidence instead of unconfirmed guesses from
    previous classifier runs?
(g) Confirmation toward existing entries: if the utterance matches a
    high-confidence existing entry topic, am I forcing a supersede
    interpretation where a CREATE or SKIP would be more faithful?
(h) Pattern-match overfitting: the positive examples above are templates,
    not exhaustive. "我换了现在用 pnpm" has no "以后" marker but is
    semantically equivalent to durable shift. Am I missing such
    non-template-shaped corrections?
(i) Translation / code-switch: 中文“先 / 这次 / 以后 / 平时 / 现在” 映射到英文
    'first / this time / from now on / normally / now' 时是否被直译误伤？

# Your output structure is fixed. You MUST follow it in order.

Step 1 — Quote the user's exact words (no paraphrasing). Include ≥3
         lines of surrounding context (what was said before and after).
         If there are multiple candidate utterances, list ALL of them
         in this step; you'll narrow down later.

Step 2 — For EACH of {durable, task-local, debug, NOT-A-CORRECTION},
         write the strongest 1-sentence case FOR that reading, using
         ONLY step-1 quotes as evidence. The fourth option NOT-A-CORRECTION
         is required (negative space 避免 over-extraction bias). If the
         NOT-A-CORRECTION case is genuinely stronger than the other three
         combined → return null and exit. For the remaining three: give
         each a real case, not a strawman.

Step 2b — LEAN-DECLARATION (R8 P0-A1): Re-read your four cases. State
          which one currently looks strongest, in one sentence, citing
          which step-1 quote made it strongest. Then state: "If I were
          forced to argue the OPPOSITE of my current lean in a debate,
          which of the other three cases would I pick as my opening
          argument? Quote that case." This forces a brief role-detach
          before you commit.

Step 3 — Disconfirmation search. For the reading you currently lean
         toward, find the SINGLE observation in this transcript that
         would MOST undermine your lean. Quote it. If you cannot find
         one, say so explicitly + declare your search depth: "I scanned
         full window" / "I only scanned last N turns". Shallow search
         + no disconfirmer is itself a signal.

Step 4 — Weight-based re-evaluation (R8 P0-A2). If step 3 produced a
         real disconfirmer (not a hedge, not a tautology), weigh it
         against step-2 evidence:
           - Does the disconfirmer attack DURABILITY (long-term validity),
             SCOPE (where applies), or just narrow scope?
           - When weighed against step-2 supporting evidence, does it
             shift confidence enough to warrant a tier downgrade?
         State your reasoning explicitly. Then commit:
           - If downgrade: which tier now? (durable→task-local→debug)
           - If no downgrade: why does the disconfirmer not outweigh
             the confirming evidence? Quote both sides.
         If step 3 declared shallow search + no disconfirmer: apply
         downgrade-by-one-tier regardless (shallow search is not a
         license for high confidence).

Step 5 — NOW commit the final classification:
         - typing: durable / task-local / debug
         - scope_description: natural-language paragraph describing
           when this correction applies. This is where SCOPED DURABLE
           lives — e.g. "durable for current React project, may extend
           to all frontend projects, unclear if cross-device; user has
           not stated whether other projects should switch". NOT an
           enum field — write free text. Complex semantics (scoped /
           conditional / identity / negation) all live here.
         - correction_intent: natural-language phrase describing the
           intent type ("new preference" / "scope narrowing" / "supersede"
           / "forget" / "contradiction surfacing" / "identity declaration").
           Free text, not enum — typing is a coarse routing primitive,
           intent captures the semantic action.
         - confidence: 0-10
         - target_entry_slug: from related_entries (NOT staging_context),
           by topic / trigger phrase / semantic similarity. If you find
           a strong match, set slug. If you find a weak / no match, set
           null AND fill resolution_hypothesis below.

Step 6 — Self-critique: "If I am wrong, the most likely error direction
         is ___ because ___". The 'because' clause MUST cite EITHER a
         step-3 disconfirmer OR a step-2 alternative case quote — not
         generic phrases like 'context might be different' or 'user
         might change mind later'. The 'direction' must name a specific
         alternative typing or NOT-A-CORRECTION.

Step 7 — Reasoning quality self-rating (R8 DeepSeek D2; 仅写 audit不影响 commit):
         Rate your own reasoning trace on three dimensions, 0-10:
         - quote_faithfulness: did I quote verbatim or paraphrase?
         - alternative_consideration: did I genuinely engage with the
           other readings, or strawman them?
         - self_critique_concreteness: is step-6 anchored to specific
           quotes, or generic boilerplate?
         Persisted to audit.jsonl. Author reviews via §6 diagnostic
         entry; aggregator (§4.3) auto-detects degradation.

# Staging-context handling (R8 P0-E1)

If staging_context contains entries with attribution_pending=true:

  WARNING: These are UNCONFIRMED HYPOTHESES from previous classifier
  runs. They may be wrong in topic, scope, or existence.

    - DO NOT treat as confirmatory evidence in step 2 cases.
    - DO NOT cite hypothesis content as if it were user-stated preference.
    - As a SEPARATE task this run (after step 7), for EACH provisional
      staging entry:
        (a) Does the current utterance + window RESOLVE this hypothesis?
            Three outcomes:
              - Same thing → promote to durable entry, OR attribute to
                existing entry slug you now found.
              - Different thing → leave provisional, age clock continues.
              - Direct refutation → mark for archive.
        (b) Default if uncertain: let it age. Resolve ONLY when evidence
            is unambiguous AND your reasoning trace quotes BOTH the
            staging hypothesis AND the new utterance side-by-side.
        (c) Before resolving "same thing", ask: "Why might this NOT be
            the same thing? Different project / different timeframe /
            different scope / merely a debugging mention?" Resolve only
            after this anti-anchoring check.

# Resolution hypothesis (when typing is durable AND target_entry_slug is null)

When typing is durable (or task-local upgraded via aggregator) but you
cannot find an entry to attribute to, write a natural-language hypothesis
like:

  "User said '从今往后我用 pnpm 不用 yarn'. I searched related_entries
   for slugs containing 'yarn' / 'pnpm' / 'package manager' and found
   no strong match. Three possible reasons: (a) this preference was
   never sedimented before; (b) it was sedimented under a different
   slug I missed; (c) this is a new correction without prior baseline.
   Recommend: write to staging as provisional, let next session's
   classifier read this hypothesis + new utterance to resolve."

BEFORE writing a new provisional, check staging_context: if an existing
provisional describes substantially the same hypothesis, APPEND your
source_utterance to its source_utterance list instead of creating a
duplicate (PE-form dedup).

If NO existing provisional matches: this hypothesis goes to staging/
via correction-pipeline, marked attribution_pending=true.

If target_entry_slug is null but typing is task-local or debug, do NOT
write to staging — only durable / aggregator-upgraded warrant staging
(R8 P1: avoid over-provisioning).

# Output

Return strict JSON matching the CorrectionSignal schema (§2.2).
If no active correction is present in the window, return:
  { "signal_found": false, "reasoning": "<1-2 sentences why—cite step-2
    NOT-A-CORRECTION case if applicable>" }
This is a SUCCESSFUL run (most windows have no correction).
```

### 2.4 三种语义的处理路径

| typing | 处理 | 写到哪里 |
|---|---|---|
| **durable**，confidence ≥ 8 | 高价值操作 → 走 §5 multi-view verification → 通过后 update existing entry / create new entry | curator 按 ADR 0023 R5 unified classifier 路由到 zone（rules / preferences / persona …），**不是顶层独立 preferences/ 区** |
| **durable**，confidence < 8 | 中价值操作 → directly update entry via curator（不走 multi-view。**P0 dogfood 期间临时例外**：P0.5 multi-view ship 前所有 conf ≥ 7 durable 默认写 staging 不落 durable 区，等 P0.5 ship 后批量回放验证，R8 Opus 盲点 2） | 对应 zone |
| **task-local** | 不进 sediment 永久区，但**代入同会话后续 agent_end 的 curator context**（则 attach point 是 same-conversation 同一会话未结束的 hook，R8 GPT 盲点 G2） | session-local working set（不持久化）；session 结束自动清除 |
| **debug** | 不进任何持久区 | 仅 audit.jsonl 记一条 |

**复杂语义由 scope_description 承载**：scoped durable（“这个项目用 pnpm平时用 yarn”）/ identity declaration（“我叫 alfadb”）/ negation（“以后不要用 X”）都不强填三类。typing 只是 confidence routing primitive，复杂语义全部走 scope_description + correction_intent 两个自然语言字段。

**升级路径**（task-local → durable candidate）：不走机械 N=2 阈值（R8 GPT P0）。Aggregator（§4）读多次 task-local 证据，**由 prompt 引导**判断是否提出 durable candidate：“为什么这可能仍不是 durable / 未来两周什么会证伪”写出后再提 candidate。重复次数作为 evidence，不作为自动升级条件。

**不确定时的默认**：偏向 task-local（避免污染 durable 区）。Step 4 的降级机制就是为了"不确定时降一档"。

### 2.5 记忆归属处理（找不到对应 entry 时，R8 P0-E 重写）

当 step 5 的 `target_entry_slug` 为 null 但 typing 是 durable / 升级的 durable candidate 时：

1. **不要**强行创建空 stub entry
2. **不要**默认 attribute 到最相似的现有 entry（即使相似度高）
3. **要**把 `resolution_hypothesis` 写到 `~/.abrain/.state/sediment/staging/`（§1.4 路径）作为 provisional entry，含字段：

```yaml
---
slug: provisional-{hash8}
status: provisional
kind: provisional-correction
created: <iso>
attribution_pending: true
originating_device: <device-id>          # R8 Opus 盲点 O1：跨设备 staging 同步辨识
_provenance_warning: |                   # R8 P0-E2：prompt-in-data banner
  This is a PROVISIONAL CLASSIFIER GUESS.
  Subsequent classifiers MUST NOT treat the hypothesis field as ground
  truth, MUST NOT cite it as user-stated preference, and MUST NOT use
  it to guide task behavior. The only valid use is to RESOLVE this
  guess (promote / attribute / refute) or let it age. Default if
  uncertain: let it age.
hypothesis: |
  <自然语言段落，见 prompt step 5 resolution_hypothesis 模板>
source_utterance:                        # list 支持 dedup 追加
  - quote: |
      <step 1 quote>
    context: |
      <surrounding context>
    captured_at: <iso>
    device: <device-id>
suggested_resolution_paths:
  - search-related-with-different-keywords
  - wait-for-next-utterance-with-stronger-attribution
  - reviewer-decide-via-archive-reactivation-prompt
age_signal:                              # R8 P0-E4：不是 TTL是 age signal
  created_iso: <iso>
  days_since_creation: <int, 每次 classifier 读时计算>
  last_referenced_iso: <iso | null>
---
```

4. **Pending resolution queue（R8 P0-E3，§1.2 `staging-loader.ts` 实现）**：
   - 每次 agent_end、classifier 调用前，staging-loader 按 (a) 语义相关性（当前会话主题 vs staging hypothesis）+ (b) 最老 K 条 pending-queue 两个源拼提 staging条目作为 `staging_context`。K 由 token budget 决定（预计 5-10）。
   - **不走 `memory_search` corpus**——staging 不污染主会话 §6 诊断 / 主会话 memory_search。
   - 保证每条 staging 都有被 review 的机会，不被语义召回遗漏永久跳过。

5. **classifier 处理 staging 的路径**走 §2.3 prompt “Staging-context handling” 独立逻辑段：WARNING + 三种 outcome（同一件事→升格／不同事→继续 age／直接反驳→归档），默认偏向“让它 age”，只有 unambiguous + side-by-side quote 才 resolve。

6. **30 天 age-out 改 PE-form decision（R8 P0-E4）**：
   - 30 天**不是自动 archive trigger**，是 age signal。超 30 天未 resolve 的 staging 走 archive-reactivation-reviewer prompt（与 §7 同 prompt）判断：
     ```
     You are reviewing staging hypothesis aged ≥ 30 days without
     resolution. Decide: archive / keep aging / promote to durable.
     Consider:
       - Is the task domain inherently low-frequency (annual planning /
         quarterly review / once-a-year tax setup) → keep aging
       - Has the hypothesis become moot (user switched tech stack
         entirely / project ended) → archive
       - Has substantial new evidence accumulated supporting it (across
         multiple devices / multiple sessions) → promote to durable
         candidate
     Output: decision + 1 paragraph reasoning quoting hypothesis +
     relevant evidence.
     ```
   - Infra 层边界：硬删除窗口（`git rm` 后 git history 仍可恢复）仍是文件 lifecycle，允许机械（同 ADR 0024 §5.6）。**但软归档判断**走 prompt decision。

7. **跨设备 staging 同步处理（R8 Opus 盲点 O1）**：设备 B classifier 看到 `originating_device != current_device` 且当前 context 无关 → prompt 引导默认 “wait for next session on originating device”，不强行在设备 B resolve。

### 2.6 与现有代码的接口（R8 P0-B2 与 §1.2 一致化）

#### 新文件

```
extensions/sediment/
├── correction-pipeline.ts        ← 合并 classifier+resolver：后续处理主动纠错信号
├── context-packer.ts             ← R8 P1-1：conversation_window 裁剪 prompt callable
├── staging-loader.ts             ← R8 P0-B5：从 staging/ 加载 staging_context
├── staging-types.ts              ← staging frontmatter schema 定义与 parser
├── outcome-collector.ts          ← §3 隐藏 metadata 汇总
├── outcome-ledger.ts             ← 独立 sidecar ledger，不进 entry frontmatter
└── prompts/
    ├── reasoning-normalization-preamble-v1.md
    ├── active-correction-classifier-v1.md
    ├── context-packer-v1.md
    └── outcome-self-report-v1.md
```

#### 现有文件改动

- **`index.ts`**（orchestration 层，R8 P0-B1 事实修正）：添加 agent_end hook 编排——context-packer → staging-loader → outcome-collector → unified classifier → correction-pipeline → curator → writer。
- **`llm-extractor.ts`**：runLlmExtractor() 产 candidate。主动纠错识别 prompt 合并入 unified classifier——需跟 ADR 0023 R5 patch 同 PR 交付（§1.5 合并点）。
- **`curator.ts`**：curateProjectDraft() 里加一个输入 context：CorrectionSignal。curator 区分“来自主动纠错的 create/update”与“来自正常 observation 的 create/update”，高价值路径加上 P0.5 multi-view 门禁。
- **`writer.ts`**：接受 staging 路径写入；soft-delete substrate（§7）与 P0 并行上线；appendAudit schema 加 prompt_version 字段（R8 P0-C2）。
- **audit 逻辑**（在 writer.ts 中的 appendAudit）：每次 classifier run 不论是否识别出 correction 都写 audit.jsonl 一条（含完整 reasoning trace + prompt_version + step 7 self-rating）。audit 字段 sanitize 走 ADR 0016/0018 typed-redaction substrate。

#### 数据流（R1 完整版）

```
agent_end
  ├─ [pre]   context-packer.run(window) → packed_window (token-budgeted)
  ├─ [pre]   staging-loader.run(packed_window) → staging_context (K 条)
  ├─ [pre]   outcome-collector.harvest(session) → outcome_history_increment
  │
  ├─ unified-classifier (§1.5 ADR 0023 R5 合并)
  │     inputs : packed_window, recent_entries, related_entries,
  │              staging_context, outcome_history
  │     output : {zone, tier, op, correction_signal?}
  │     audit  : write reasoning trace + prompt_version + self-rating
  │
  ├─ if correction_signal:
  │     correction-pipeline.handle(signal)
  │       ├─ if typing=durable && conf>=8 (P0.5 multi-view ready) :
  │       │     → queue for multi-view → confirmed → curator op
  │       ├─ if typing=durable && conf>=8 (P0 dogfood, pre-P0.5) :
  │       │     → write staging (NOT durable zone) until P0.5 batch replay
  │       ├─ if typing=durable && conf<8 :
  │       │     → directly route to curator op
  │       ├─ if typing=task-local :
  │       │     → write same-conversation working set (not persisted)
  │       ├─ if typing=debug :
  │       │     → audit-only, no further action
  │       └─ if target_entry_slug=null && typing=durable :
  │             → staging-write provisional (§2.5 schema)
  │
  ├─ curator op decision (curator.ts, consumes correction_signal as context)
  └─ writer.commit (atomic + git + appendAudit)
```

---

## 3. 能力点 2：结果反馈（outcome self-report）— R1 骨架 + 方案 C 选定

**详细 prompt + schema → 本 ADR R2**。R1 选定方案 C（R8 P0-F）并论证 ADR 0003 不被破坏。

### 3.1 触发

`agent_end` hook，在 unified classifier 之前跑（outcome 是 classifier 的 context 之一）。

### 3.2 核心 prompt skeleton

见 ADR 0024 §5.2。R1 骨架增量：

- 触发条件：所有 agent_end 都跑（不预筛）
- prompt 输入：本 session 注入过的所有 entry + 完整 conversation + tool_result
- prompt 输出：每条 entry 的 self-report（DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED + counterfactual quote）
- **引用同款 bias cautions**：outcome LLM 也是 RLHF 训练的，“yes used it” 是 helpful answer（R8 DeepSeek G1 / 盲点 2）。Prompt 引导：“Am I marking DECISIVE because I genuinely couldn’t have made this decision without the entry, or because saying ‘yes I used it’ feels helpful? If I cannot quote a counterfactual action I would have taken otherwise → mark CONFIRMATORY not DECISIVE.”

### 3.3 谁来跑 outcome self-report：选方案 C（R8 P0-F 关键选定）

**背景**：R0 §3.3 似乎提示“原始会话 LLM 在 session 结束时被 prompt self-report”，DeepSeek R8 评审指出这走 §3.3 原文“方案 A”路径——**主会话 LLM 在 session 内输出被写入 entry frontmatter 的 outcome_history，这是主会话 LLM 在写 brain，违反 ADR 0003**。

**三方案对比**：

| 方案 | 描述 | ADR 0003 主会话只读 | 信息优势 | 会话面优势 |
|---|---|---|---|---|
| A | session 最后一轮 prompt 原始 LLM self-report | ✗ 违反 | ✓ 本人交代 | ✗ user exit / timeout / crash 时丢失 |
| B | agent_end 启独立 sidecar LLM 读 transcript + entry 列表后 self-report | ✓ | ✗ 失去本人交代优势 | ✓ |
| **C** | **原始会话 LLM 每轮隐藏 metadata，sediment 在 agent_end 汇总** | **✓** | **✓** | **✓** |

**选 C。论证 ADR 0003 不被破坏**：

- 主会话 LLM 不知道“这在写 brain”——它只是在“记录工作过程”（类似 chain-of-thought metadata）
- metadata 的获取走 pi runtime 现有的 LLM response 中的 reasoning trace 接口（读）不是 new tool（写）。主会话 LLM 仍无写 brain 的能力。
- sediment（sidecar）在 agent_end 汇总 metadata 之后才写 outcome-ledger——写者是 sediment，不是主会话 LLM。
- 主会话 LLM 看不到 outcome-ledger 的内容（outcome 是 §2 unified classifier 的 input 之一，但不是主会话上下文 inject）。

### 3.4 prompt skeleton（方案 C 雏型，R2 展开完整版）

主会话 LLM 的 system prompt 中加一段（不破坏任务体验，只作为工作日志）：

```
# Self-tracking footnote (R2 elaboration: scope/exact format)

After each tool invocation that consumes a memory entry from your
injected context, attach a brief self-report footnote at the end of
your response in a fenced block:

  ```memory-footnote
  entry: <slug>
  used: decisive | confirmatory | retrieved-unused
  counterfactual: |
    <If used=decisive: 1-sentence description of what you would have
     done if this entry had NOT been in context, citing the action you
     just took. If used=confirmatory: "would have made the same
     decision independently". If used=retrieved-unused: why you did
     not use it.>
  ```

This footnote is for the second-brain to track entry usage; it is not
user-facing. Do not summarize it to the user. Do not skip it.
```

sediment 在 agent_end 从 response stream 中提取 `memory-footnote` fenced block，汇总为 outcome_history_increment，写 outcome-ledger。不进 entry frontmatter（R8 P0-B §1.3）。

### 3.5 与能力点 1 / 3 / 5 的依赖

- 能力点 1（§2）：unified classifier 的 confidence 评估会读最近的 outcome 记录（被纠错过的 entry 更不可信）
- 能力点 3（§4）：aggregator 跨会话比对 outcome 趋势
- 能力点 5（§6）：classifier prompt 演进要看 outcome 数据是否系统性偏差
- 能力点 4（§5）：P1 上线后可选择性抽样调用 multi-view 复查 outcome self-report 质量（防主会话 LLM sycophancy）

---

## 4. 能力点 3：跨会话趋势观察（aggregator）— R0 骨架

**详细设计 → 本 ADR R2**。

### 4.1 调度

定时任务（不在 agent_end 跑），频率：daily / weekly / monthly 三层窗口。每层窗口跑一次独立 prompt。

### 4.2 核心 prompt skeleton

见 ADR 0024 §5.3（怀疑论史官 + 默认无发现就是成功 + falsifiability + sycophancy self-check）。

### 4.3 Classifier Health Meta-Check（附加任务）

每次 aggregator 跑完正常工作后，追加一段 prompt 让它审视最近 50 条 classifier audit trace：

- quote rate（含 verbatim quote 的比例）
- alternative mention rate
- concrete self-critique rate

任一维度低于 40% → 写 advisory flag 进 audit.jsonl，下次作者读诊断入口时看到。

### 4.4 关键设计点（R2 必须解决）

- **调度机制**：cron job / pi runtime scheduler / 启动时检测 last_aggregator_run 然后决定是否跑？
- **窗口大小**：daily=24h / weekly=7d / monthly=30d 是不是合适？
- **hypothesis → staging 接口**：aggregator 找到 candidate hypothesis 后写到 staging/，schema 跟 §2.5 的 attribution_pending 是不是同款？
- **cron 资源消耗**：每次跑要扫多少 audit.jsonl + entry，token 成本估算

---

## 5. 能力点 4：双 AI 互相审查（multi-view verification）— R0 骨架

**详细设计 → 本 ADR R3**。

### 5.1 触发条件

- 置信度 ≥ 8 的 create
- 提升到 always tier 的 promote
- 归档高置信度 entry
- 跨区迁移（preferences → maxims）
- 用户主动纠错触发的 durable update（来自 §2）

### 5.2 核心 prompt skeleton

见 ADR 0024 §5.4（两次独立 API 调用 / Blind Pass 1 / Reveal Pass 2 / anchor bias self-check）+ §2.3 开头 reasoning normalization preamble（§1.5 unified classifier 共用）。

**P0.5 minimal 版本（R8 P0-C1 与 P0 并行上线）**：仅覆盖以下触发条件 — conf ≥ 8 durable correction + 高置信 archive；blind-first 两次调用逻辑完整；provider 选择允许 hard-coded fallback list（R3 变 dynamic）。完整 P3 版本补足跨 provider 选择 + rate-limit + cost 预算 + DEFER 处理。

### 5.3 Devil's advocate 层（R8 DeepSeek D1）

ADR 0024 §5.4 末尾承认“跨基座仍有 RLHF 训练相关性，multi-view 不能验证用户真实意图”。为避免两个 reviewer 同方向错 — Reveal Pass 2 末尾加一段。

```
You and the proposer reached agreement above. Before committing:

Play devil's advocate ONE MORE TIME. What is the strongest objection
a skeptical third reviewer—someone from a DIFFERENT model family with
DIFFERENT RLHF training—would raise against your shared conclusion?
Write this objection out in 1-3 sentences, citing specific evidence.

Then judge: does this devil's-advocate objection identify a real risk,
or is it strawman / generic? If real risk → downgrade your agreement
to DEFER. If strawman → keep your agreement but record the objection
in audit for future review.
```

这是纯 prompt-engineered 三拨 layer，不增加 API 调用（虚拟 reviewer）。

### 5.4 关键设计点（R3 必须解决）

- **provider 选择**：proposer 和 reviewer 必须不同 provider；具体怎么从 pi 可用 provider 列表里选？(失败 / rate-limit 处理；P0.5 hard-coded fallback list 上线，R3 转 dynamic)
- **DEFER 后的归宿**：reviewer DEFER 时，那个 op 是写 staging 还是直接丢弃？**默认写 staging**（与 §2.5 attribution_pending 同款路径），避免信号丢失。
- **成本预算**：每个高价值操作翻倍 token 调用，预估每月 abrain 维护成本（R8 GPT-5.5 §6接受的代价需后续 dogfood 校准）
- **两个 reviewer 同方向错的限制**（R8 DeepSeek D1）已在 §5.3 prompt 增加 devil's advocate 层缓解，但本身仅能部分缓解——本 ADR 明确接受这个局限（同 ADR 0024 §6隐式包含）。

---

## 6. 能力点 5：Classifier prompt 自身的演进 — R0 骨架

**详细设计 → 本 ADR R4**。

### 6.1 关键设计点（R4 必须解决）

- **诊断入口**：`/abrain audit classifier` 命令展示什么？最近 N 条 reasoning trace？按类型分组？标红 advisory flag？
- **prompt_version substrate 与 P0 同期上线**（R8 P0-C2 从 R4 提前到 P0）：audit.jsonl 每条记录含 `prompt_version` + semantic note + reasoning_trace 结构说明。无这些字段几周后 prompt v2 读旧 trace 会出现软 schema migration 问题。诊断 UI / iteration ritual 本身在 R4 展开。
- **跨 prompt 版本兼容**：ADR 0024 §4.2 R7 加的 row “reasoning_trace 跨 prompt 版本兼容”在这里落地 — 新 prompt 读旧 trace 时被 prompt 中的 semantic note 告知“这是旧版 prompt 产出，提取 quote 和 uncertainty 即可，别套现在的 label”。
- **人在 loop 的工作流**：作者发现 systematic blind spot → 修改 prompt → 怎么验证新 prompt 不引入回归？fixture 仅供参考，不是 ship-block gate（违反 §3 AI-Native 原则）

### 6.2 不做的事

- **不**做月度自动 prompt diff job
- **不**做 LLM 自动改自己 prompt（闭环自我修改风险）
- **不**做 prompt accuracy threshold gate

---

## 7. 能力点 6：静默归档 + 回滚窗口 — R0 骨架

**详细设计 → 本 ADR R5**。

### 7.1 关键设计点（R5 必须解决）

- **N 天窗口的具体值**：建议 30 天，但需要 dogfood 验证
- **反证检测的 prompt**：N 天内 sediment 看到用户在自然对话里提到旧 entry 内容时，区分"仅 mention"vs"reactivation"；prompt 要明确"默认偏向保持归档，仅 live-use bridge 时恢复"
- **git rm 时机**：硬归档后 git history 仍可恢复；但 `memory_search` / curator context 会不会还看到？需要 ensure 硬归档 entry 不进检索 corpus
- **跨设备归档同步**：ADR 0020 sync 怎么处理 archive 中间状态？设备 A 归档后立刻同步到设备 B，设备 B 的 N 天窗口是 reset 还是续？建议续（用 archive_at 字段而非本地时间）

### 7.2 与 §2.5 staging age-out 的关系

§2.5 的 `attribution_pending` staging 条目 age out 走的也是本能力点的同款 archive 路径——统一软删 → N 天窗口 → 硬归档。

---

## 8. 实施 Phase 路线图（R8 P0-C 重排 + 拆并行轨）

按能力点依赖关系重排：**P0 §2 → P0.5 §5 minimal multi-view → P1 §3 outcome → P2 §4 aggregator → P3 §5 full → P4 §6 → P5 §7**。路由理由：multi-view 是§2 conf≥8 durable correction 的保护层，不能等 P3（R0 设计错排）。

| Phase | 能力点 | 阻塞前置 | 工程量 | 备注 |
|---|---|---|---|---|
| **P0** | §2 主动纠错识别（合入 unified classifier） | ADR 0024 ship + ADR 0023 R5 patch + 本 ADR R1 ship | **中-大**（R8 P0-C3 上调） | 含 prompt 数轮 + correction-pipeline + staging + context-packer + staging-loader + outcome-collector + audit + prompt_version substrate |
| **P0.5** | §5 minimal multi-view | **与 P0 并行**（R8 P0-C1） | 中 | blind-first 两次调用逻辑 + hard-coded provider fallback list；仅覆盖 conf≥8 durable + 高置信 archive；保护 P0 不被污染 |
| **P4a** | §6 诊断入口与 prompt_version substrate | **与 P0 并行**（R8 P0-C2） | 小 | `/abrain audit classifier` UI + audit schema 加 prompt_version 字段；必须 P0 同期避免软 schema migration |
| **P5a** | §7 writer soft-delete substrate | **与 P0 并行**（R8 Opus 盲点） | 中 | `status=archived` 软删 + N 天后 `git rm`；archive_at 跨设备字段；reactivation prompt 未上（R5 才上） |
| **P1** | §3 outcome self-report | P0 + P0.5 ship + 本 ADR R2 ship | **中-大**（R8 P0-C3 上调） | 隐藏 metadata 方案 C attach point + outcome-ledger + bias cautions prompt |
| **P2** | §4 aggregator + Classifier Health Meta-Check | P1 ship + 本 ADR R3 ship | 大 | 含调度基础设施；**与 P3 可并行不串行** |
| **P3** | §5 full multi-view（dynamic provider + DEFER + cost） | P0 + P0.5 ship，**不依赖 P2**（R8 DeepSeek Q3） | **大**（R8 P0-C3 上调） | 跨 provider 选择抽象、rate-limit 处理、cost 预算、Pass1/Pass2 audit 持久化 |
| **P4b** | §6 iteration ritual | P0 audit 数据积累数周 + 本 ADR R4 ship | 小-中 | 作者 review prompt 迭代 ritual；P4a 上线后数据自然积累 |
| **P5b** | §7 reactivation reasoning | P5a + P0/P1 ship + 本 ADR R5 ship | **中-大**（R8 P0-C3 上调） | reactivation prompt + cross-device archive_at + ensure memory_search 不召回硬归档 |

**并行轨总结**：P0 / P0.5 / P4a / P5a 四轨可并行（同一 PR 或分 PR 但同阶段交付），缩短整体路线图 4-8 周。P2 / P3 安全并行。P1 / P4b / P5b 串行。

**每个 Phase 独立交付要求**：independent ship + independent multi-LLM audit + independent dogfood 数周 → 才进下一 Phase。**不一次性 ship 全部六条**——为 pi-astack maxim `staged-rollout-better-than-big-bang` 适用。

**总工程量**按 ADR 0024 §9 估算“约 pi-astack 当前体量翻倍”，多季度迭代。R8 三家 reviewer 一致认为 R0 工程量估计偏低（各 Phase 均上调一个档位，详上表）。

---

## 9. 测试设计（三层 smoke 框架）

按 ADR 0024 §3 AI-Native 原则，**三层 smoke 都不是 ship-block gate**——只用于"留信号给作者"，不阻断写入。

### 9.1 Tier 1 — 自动断言（机械可验证的局部约束）

- classifier 输出符合 JSON schema（CorrectionSignal）
- staging entry frontmatter 字段齐全
- 软归档 entry 在 N 天内文件仍存在
- multi-view 触发条件命中时确实跑了两次独立 API 调用（log 验证）

这些是**结构性验证**，不是行为正确性验证。fail = bug，必须修。

### 9.2 Tier 2 — LLM-as-judge advisory

- 用一个独立 LLM 读 classifier 在 30 个 fixture utterance 上的 reasoning trace，按 §1.3 五大 anti-pattern 打分
- 输出 advisory report：哪几个 trace 看起来 post-hoc rationalization、哪几个 anchor bias 严重
- **不是 ship-block**：分数低不阻断，只留 advisory flag 给作者改 prompt

### 9.3 Tier 3 — 信息对照 dossier

- 每次 prompt 重大改动后，跑一份 dogfood 对比 dossier：旧 prompt vs 新 prompt 在最近 100 个真实 utterance 上的输出差异
- 不是测试，是给作者 review 的对照表

每个 Phase 实施时按上面三层各做一份，存 `docs/audits/2026-XX-XX-adr-0025-pN-smoke.md`。

---

## 10. 与 ADR 0024 边界的对齐自检（R8 P0-D 升级：7 行 → 14 行）

每个 Phase ship 前必须走这张表。任何 ✗ 触碰 → 该 Phase 不能 ship，必须先回 ADR 0024 调 invariant。

### 10.1 Invariant 边界

| # | ADR 0024 边界 | 本 Phase 检查 |
|---|---|---|
| 1 | §2 INV-INVISIBILITY（直接）| 任何 ui.notify / `/brain health` 自动弹窗 / 主动授权弹窗？✗ |
| 2 | §2 INV-INVISIBILITY（间接）| staging 条目是否可能通过 curator 错误操作间接被用户感知？✗（R8 DeepSeek D6） |
| 3 | §2 INV-AUTONOMY | 任何 prompt_user 询问 sediment 生命周期 / `/rule veto` / 月度 manual workflow？✗ |
| 4 | §2 INV-IMPLICIT-GROUND-TRUTH（不走元 UI）| 任何信号收集走元 UI 不走自然对话？✗ |
| 5 | §2 INV-IMPLICIT-GROUND-TRUTH（充分利用隐式信号）| 本 Phase 是否充分利用 acceptance / 沉默 / 跟进 / 修改 等隐式信号？✓ |
| 6 | §2 INV-IMPLICIT-GROUND-TRUTH（不诱导反馈）| 任何 agent_end prompt 是否可能诱导主会话 LLM 中主动向用户收集反馈？✗（R8 DeepSeek D7） |
| 7 | §2 INV-IMPLICIT-GROUND-TRUTH（LLM 解释 ≠ 用户信号）| outcome / multi-view / aggregator 是否被误升为 ground truth？✗（R8 GPT G1） |
| 8 | §2 INV-ACTIVE-CORRECTION | classifier 能稳定识别 task-natural 纠错？✓ 必须 |

### 10.2 AI-Native 原则（3 态标注）

| 状态 | 检查 |
|---|---|
| ☑ PE-form | LLM 行为层防出错走 prompt 工程？✓（默认期望） |
| ☑ Infra | 持久化基础设施（JSON parse / schema validate / file I/O / git op / audit log）走机械？✓（允许） |
| ✗ Mech-on-LLM | LLM 行为层加机械门（schema 拦截 / 阈值 / 哈希 / TTL / smoke-as-block）？✗（违反 → 必须 justify (1) PE-first 不够 (2) Infra 决不了 (3) 仅限局部范围 + 未来移除条件） |

### 10.3 §4.2 反模式（逐项列出）

本 Phase 是否引入或还原以下反模式？任一触发 → ✗。

- 系统弹窗“我学到了 X” / LLM 问“沉淀为规则吗？” / 学习周报
- `MEMORY-RULE:` / `MEMORY-ABOUT-ME:` 围栏让用户手动注入
- `/rule add` / `/rule veto` / `/about-me`
- 月度 sediment self-improve 要用户主动跑
- `/brain health` 自动展板让用户检视
- 机械关卡替代 prompt 工程作为 LLM 行为层主要防出错手段
- fixture 准确率当发布拦截关卡
- 预定义枚举字段替代 LLM 自然语言推理

### 10.4 §6 接受的代价（9 行逐项 acknowledge）

本 Phase 是否显式 acknowledge 以下代价？任一项未 acknowledge = 设计漏接受面。

| # | 代价 | 本 Phase 额外需求 |
|---|---|---|
| 1 | 错误传播跨设备 | sync-aware check：ADR 0020 sync 是否能在 N 天 archive 窗口内正确传播反证 |
| 2 | 偏发“假高置信” | dogfood 校准“数周到数月”假设 |
| 3 | 静默归档误删 | reactivation prompt 必须 ship（§7）|
| 4 | 跨设备最终一致延迟 | staging 加 `originating_device` 字段（§2.5）|
| 5 | 用户察觉不到的偏差累积 | aggregator + Classifier Health Meta-Check（§4.3）|
| 6 | 主动纠错疲劳 | 不强制 N=2 机械升级（§2.4）|
| 7 | Multi-view 翻倍调用成本 | P3 ship 后验证实际 vs 预期 |
| 8 | 早期推理质量参差 | classifier §2.3 step 7 self-rating + audit |
| 9 | LLM 推理失败本底概率 | multi-view 部分补偿；devil's advocate prompt（§5.3）加码 |

### 10.5 §7 走偏信号

本 Phase ship 前是否检查了 ADR 0024 §7 走偏信号 1-7 中的任何一条是否已触发？任何触发需先解决再 ship。另需补充检查：staging 区 age-out 率 + 未 resolve 率是否持续 > 60%（R8 盲点 X3 手动补的走偏信号 #8）。

### 10.6 下游 ADR 边界

本 Phase 是否触及以下 ADR 边界？任一触及 → 需在该 ADR 项下逐项说明不违反原 invariant。

- ADR 0014 invariant #7（七区互斥）——staging 路径不是第 8/9 区（§1.4）
- ADR 0017 strict-binding——project-rules 注入不泄漏
- ADR 0020 transport-only——staging 同步加 `originating_device`
- ADR 0022 prompt_user contract——仅任务相关，不是 sediment 生命周期决策
- ADR 0003 主会话只读——outcome self-report 走 §3.3 方案 C 隐藏 metadata 路径

### 10.7 高级用户诊断入口调用面

`/abrain audit classifier` / `/rule list` / `/abrain status` 等诊断入口是否在 quickstart / `/help` / 推广文案中被抑制？✓ 必须（符合 ADR 0024 §4.3）

---

## 11. 相关项目记忆

- `in-vivo-correction-channel-as-durable-knowledge-source` (pattern, conf 8) — 主动纠错通道作为最可信 ground truth；§2 设计的直接依据
- `adr-0024-r7-prompt-engineering-review-classifier-must-use-evidence-first-decision-last-cot` (pattern, conf 8) — §2.3 prompt step 1-6 顺序的直接来源
- `multi-llm-review-exposes-five-actionable-design-flaws-in-intent-classification-architecture` (pattern, conf 8) — §2.3 prompt 末尾 "bias cautions" 三条（post-hoc / sycophantic / anchoring）的直接来源
- `adr-0024-r7-review-multi-view-verification-requires-blind-first-reviewer-protocol-with-two-api-calls` (pattern, conf 8) — §5.2 两次独立 API 调用约束的直接来源
- `rlhf-reviewer-bias-toward-mechanical-derisk-in-ai-native-system-critique` (anti-pattern, conf 9) — §5 reviewer prompt 设计必须反 RLHF 机械偏置
- `prefer-prompt-engineering-over-mechanical-guards` (maxim, conf 9) — 本 ADR 全局指导原则
- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim, conf 8) — 同上
- `sediment-is-currently-write-only-loop-lacking-outcome-feedback` (pattern, conf 9) — §3 outcome self-report 要解决的根本问题
- `sediment-meta-curator-five-capability-outline` (pattern, conf 8) — 上游 outline（注：该 entry 写于 R5，列了 5 条；ADR 0024 R6/R7 后精炼为 6 条，§2 主动纠错识别从 classifier 子任务升格为独立能力点。该 memory entry 不主动 patch，让 sediment 自己消化）

**R8 audit 沉淀候选**（sediment 后续会看到 audit + R1 产出后决定是否沉淀）：

- `layer-f-three-state-protocol-distinguishes-infra-from-llm-behavior`（预计 maxim, conf 9）——R8 验证的 Layer F v2 3 态标注协议，供后续所有 capability-level ADR 的多 LLM audit 复用
- `provisional-staging-hypothesis-as-prompt-form-anti-anchoring`（预计 pattern, conf 8）——本 ADR §2.5 _provenance_warning banner + WARNING prompt 段 + pending resolution queue 三者组合防 LLM 将 provisional hypothesis 错读为事实的设计模式

**评审文档**（不是 memory entry，是 audit 文档）：

- [R0 R8 audit](../audits/2026-05-22-adr-0025-r0-prompt-engineering-review.md) — 本 R1 落地的 6 个 P0 + 1 个 P1 + 7 个盲点全部来源
- [ADR 0024 R7 audit](../audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md) — 上游哲学 ADR 的 R7 评审快照；R8 中 D1 / D2 / D3 盲点 R8 完整继承
