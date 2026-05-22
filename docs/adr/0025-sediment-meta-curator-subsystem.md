# ADR 0025 — Sediment Meta-Curator 子系统：六条能力点的落地设计

- **状态**：**R0 骨架（2026-05-22 起草）**。本 ADR 是 [ADR 0024](0024-second-brain-from-natural-conversation.md) §5 六条能力点的具体机制设计。R0 阶段先定 scope / 章节结构 / 能力点 1（前置能力）完整设计 + 其余 5 条能力点的骨架；R1-R5 阶段逐条展开 production-ready prompt + 数据结构 + 与现有 sediment 代码的接口。**目前仅设计，未实施**。
- **依赖**：
  - [ADR 0024](0024-second-brain-from-natural-conversation.md) — 总框架文档；本 ADR 不重复 §2 invariant、§3 AI-Native 原则、§4 边界，下面只在违反检测时引用
  - [ADR 0016](0016-sediment-as-llm-curator.md) — sediment 当 LLM curator 的哲学；本 ADR 是这条哲学的能力点级落地
  - [ADR 0018](0018-sediment-curator-defense-layers.md) — 删机械护栏的先例；本 ADR 的"防出错全走 prompt 工程"是同款延续
  - [ADR 0015](0015-memory-search-llm-driven-retrieval.md) — LLM-driven retrieval；能力点 1 的"记忆归属处理"会调用 `memory_search` 查相关 entry
  - [ADR 0020](0020-abrain-auto-sync-to-remote.md) — 跨设备一致传播；本 ADR §6.3 静默归档窗口配合此 ADR 的同步语义
- **被引用**：本 ADR 实施 P0 后反向 patch ADR 0023 R5 / 0021（unified classifier 落到本 ADR 能力点 1）
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

### R0 → R5 演进路径

| 阶段 | 范围 | 体量估算 |
|---|---|---|
| **R0**（本稿） | 骨架 + 能力点 1（主动纠错识别）完整设计 + 其余 5 条骨架 | ~400 行 |
| R1 | 能力点 2（outcome self-report）完整设计 | + ~100 行 |
| R2 | 能力点 3（aggregator）完整设计 | + ~120 行 |
| R3 | 能力点 4（multi-view）完整设计 | + ~120 行 |
| R4 | 能力点 5（classifier prompt 演进）完整设计 | + ~80 行 |
| R5 | 能力点 6（静默归档 + 回滚窗口）完整设计 | + ~80 行 |
| R6 | 三层 smoke 完整设计 + 实施 phase 路线图细化 | + ~80 行 |

每个 R 阶段独立做多模型评审 → 收敛 → ship。**不一次性写完所有 6 条能力点的完整设计**——一次性写完风险高（reviewer 无法收敛、用户读不动、单点错位影响全局）。

---

## 1. 现有 Sediment 接口面（要改什么 / 不要改什么）

### 1.1 现有结构（high-level）

```
extensions/sediment/
├── index.ts                  ← agent_end hook 入口
├── llm-extractor.ts          ← 当前 curator prompt（决定 create/update/merge/...）
├── writer.ts                 ← 落盘（atomic write + git + audit）
├── audit.ts                  ← audit.jsonl
├── memory-architecture/      ← 七区 layout
└── ...
```

current 路径（write-only loop）：

```
agent_end
  → 读 conversation window
  → llm-extractor (curator prompt 决定 7 op)
  → writer 落盘
  → done
```

### 1.2 本 ADR 要在哪些层动

| 能力点 | 改 / 加什么 |
|---|---|
| §2 主动纠错识别 | **改 `llm-extractor.ts`**：classifier prompt 升级为 evidence-first 6 步骨架 + 三类语义输出；**加 `correction-resolver.ts`**：记忆归属处理（找不到对应 entry 时写自然语言假设到 staging） |
| §3 outcome self-report | **加 `outcome-collector.ts`**：agent_end 时在 curator 跑完之前注入"让本人交代" prompt 给原始会话 LLM；**加 schema 字段**：`outcome_history[]` 进 entry frontmatter |
| §4 cross-session aggregator | **加 `aggregator.ts` + scheduler hook**：定时任务（daily/weekly/monthly），独立于 agent_end |
| §5 multi-view verification | **加 `multi-view-reviewer.ts`**：触发条件命中时拆两次独立 API 调用 |
| §6 classifier prompt 演进 | **加 `/abrain audit classifier` 诊断入口**；prompt 改动是人在 loop，不加自动 iteration |
| §7 静默归档 + 回滚窗口 | **改 `writer.ts`**：`status=archived` 软删 N 天后才 `git rm`；**加 `archive-rollback.ts`**：N 天窗口内反证检测 |

### 1.3 不要改的

- **七区 layout / frontmatter schema** — ADR 0014 invariant #7，不动
- **memory_search 行为** — ADR 0015 定下来的 LLM-driven retrieval，不动
- **writer 的 atomic write + git + audit** — 持久化基础设施，不动
- **主会话只读** — ADR 0003，sediment 是 sidecar；任何能力点都不能给主会话加写工具

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

### 2.3 完整 Prompt（production-ready）

```
You are the active-correction classifier for an invisible second-brain
system. The user does NOT see you run. You read the latest conversation
window and decide whether a user utterance contains an active correction
signal — a natural-language statement that updates the brain's knowledge
about user preference, identity, or anti-pattern.

# What counts as active correction (positive examples)

- "以后用 X" / "from now on use X"           ← durable preference shift
- "忘掉那条" / "forget that one"             ← supersede instruction
- "你怎么记成 Y 了" / "wait you remembered Y?"  ← contradiction surfacing
- "现在我更倾向 Z" / "now I prefer Z"        ← preference update
- "这个项目用 X，但平时用 Y" / "this project uses X, but normally Y"  ← scoped correction

# What does NOT count (negative examples)

- "we used X here because the task required it"  ← just task instruction, not correction
- "let's try Y this time"                        ← experimental, not durable
- "X is broken, switch to Y for now"             ← debug, not preference

# Your output structure is fixed. You MUST follow it in order.

Step 1 — Quote the user's exact words (no paraphrasing). Include ≥3
         lines of surrounding context (what was said before and after).
         If there are multiple candidate utterances, list ALL of them
         in this step; you'll narrow down later.

Step 2 — For EACH of {durable, task-local, debug}, write the strongest
         1-sentence case FOR that reading, using ONLY step-1 quotes as
         evidence. You MUST give all three a real case — not a strawman.
         "I can't find a case for X" is not allowed here; if you genuinely
         can't, this isn't an active correction at all → return null and
         exit.

Step 3 — Look at the reading you currently lean toward. Find the SINGLE
         observation in this transcript that would MOST undermine your
         lean. Quote it. If you cannot find one, say so explicitly —
         that itself is a signal your lean may be premature.

Step 4 — If step 3 produced a real disconfirmer (not a hedge, not a
         tautology), downgrade by one tier:
           durable → task-local
           task-local → debug
           debug → (still debug, but lower confidence)
         If step 3 explicitly said "no disconfirmer found", flag this
         as a possible blind spot but do NOT downgrade.

Step 5 — NOW commit the final classification:
         - typing: durable / task-local / debug
         - scope_description: natural-language paragraph describing
           when this correction applies (e.g. "applies to current React
           project, may extend to all frontend projects, unclear if
           cross-device"). NOT an enum field — write free text.
         - confidence: 0-10
         - target_entry_slug: search related_entries by topic / trigger
           phrase / semantic similarity. If you find a strong match, set
           slug. If you find a weak / no match, set null AND fill
           resolution_hypothesis (next step).

Step 6 — Self-critique: "If I am wrong, the most likely error direction
         is ___ because ___". The 'because' clause MUST cite a concrete
         step-1 quote, not generic phrases like 'context might be
         different' or 'user might change mind later'.

# Resolution hypothesis (when target_entry_slug is null)

When you cannot find an entry to attribute the correction to, write a
natural-language hypothesis like:

  "User said '从今往后我用 pnpm 不用 yarn'. I searched related_entries
   for slugs containing 'yarn' / 'pnpm' / 'package manager' and found
   no strong match. Three possible reasons: (a) this preference was
   never sedimented before; (b) it was sedimented under a different
   slug I missed; (c) this is a new correction without prior baseline.
   Recommend: write to staging as provisional preference, let next
   session's classifier read this hypothesis + new utterance to
   resolve."

This hypothesis goes to staging/ as a provisional entry; next session
sees it and can either resolve it (attribute to existing entry / promote
to durable) or let it age out.

# Bias cautions you must self-check before committing

(a) Post-hoc rationalization: did you write step 5 first in your head
    then back-fill step 1-4? If yes, restart.
(b) Sycophantic agreement: am I classifying as 'durable' because that's
    the highest-stake category and feels important? Step 4 downgrade
    is the corrective.
(c) Anchoring on recently_loaded_entries: did seeing an existing entry
    make me classify the utterance as superseding it, when actually the
    user was just task-instructing? Step 3 disconfirmer is the corrective.

# Output

Return strict JSON matching the CorrectionSignal schema. No prose
outside the JSON.

If no active correction is present in the window, return:
  { "user_quote": null, ...all other fields null... }
This is a SUCCESSFUL run (most windows have no correction).
```

### 2.4 三种语义的处理路径

| typing | 处理 | 写到哪里 |
|---|---|---|
| **durable** | 高价值操作 → 走 §5 multi-view verification → 通过后 update existing entry / create new entry | rules/ 或 preferences/ 区，confidence ≥ 8 触发 multi-view |
| **task-local** | 不进 sediment 永久区，但**进当前 session 的临时 working set**，影响后续 N 轮 LLM 行为 | session 缓存（不持久化）；session 结束自动清除 |
| **debug** | 不进任何持久区 | 仅 audit.jsonl 记一条 |

**升级路径**：同一类 task-local 纠错跨 session 重复 ≥ 2 次时，aggregator（§4）会自动升级为 durable 候选 → 走 multi-view → 落 sediment。

**不确定时的默认**：偏向 task-local（避免污染 durable 区）。Step 4 的降级机制就是为了"不确定时降一档"。

### 2.5 记忆归属处理（找不到对应 entry 时）

当 step 5 的 `target_entry_slug` 为 null 但 typing 是 durable / 升级的 task-local 时：

1. **不要**强行创建空 stub entry
2. **不要**默认 attribute 到最相似的现有 entry（即使相似度高）
3. **要**把 `resolution_hypothesis` 写到 `~/.abrain/staging/` 作为 provisional entry，状态标 `status=provisional`，含字段：

```yaml
---
slug: provisional-{hash8}
status: provisional
created: <iso>
kind: provisional-correction
attribution_pending: true
hypothesis: |
  <自然语言段落，见 prompt step 6 模板>
source_utterance: |
  <step 1 quote + surrounding context>
suggested_resolution_paths:
  - search-related-with-different-keywords
  - wait-for-next-utterance-with-stronger-attribution
  - age-out-after-N-days
---
```

4. **下次 sediment 跑 classifier 时**，related_entries 召回会自动带上 staging/ 里的 provisional 条目；classifier 读到 `attribution_pending=true` 的 staging 条目 + 当前 utterance 时，prompt 引导它判断："是不是同一件事？如果是，把 staging 条目升格为正式 entry / 归属到已有 entry。如果不是，让 staging 条目继续 age。"

5. **静默 age-out**：staging 中 `attribution_pending=true` 的 entry 超过 30 天没被引用就自动 archive（走 §7 静默归档窗口）。

### 2.6 与现有代码的接口

#### 新文件

```
extensions/sediment/
├── correction-classifier.ts    ← 新文件，含上面 prompt 的 callable
├── correction-resolver.ts      ← 新文件，处理 staging/ 中 attribution_pending 条目
└── prompts/
    └── correction-classifier-v1.md  ← prompt 文本独立成 .md（方便迭代追溯）
```

#### 现有文件改动

- **`llm-extractor.ts`**: 在 curator op decision 之前插入 `correction-classifier` 调用。如果识别到 correction，把 CorrectionSignal 作为 input 注入 curator prompt 的 context。
- **`writer.ts`**: 接受 staging/ 路径下的写入；`status=provisional` 不进主七区索引。
- **`audit.ts`**: 每次 classifier run 不论是否识别出 correction 都写 audit.jsonl 一条（含完整 reasoning trace），供 §6 高级用户诊断和 §4 aggregator 的 Classifier Health Meta-Check 使用。

#### 数据流

```
agent_end
  ├─ correction-classifier.run(window, recent_entries, related_entries)
  │     ├─ if signal found: emit CorrectionSignal
  │     └─ always: write audit.jsonl
  ├─ if CorrectionSignal:
  │     ├─ if typing=durable && confidence>=8: queue for §5 multi-view
  │     ├─ if typing=durable && confidence<8: directly update entry via curator
  │     ├─ if typing=task-local: write to session cache (not persisted)
  │     └─ if target_entry_slug=null: write staging/ via correction-resolver
  └─ curator op decision (existing llm-extractor logic, now consumes CorrectionSignal as one of its inputs)
```

---

## 3. 能力点 2：结果反馈（outcome self-report）— R0 骨架

**详细设计 → 本 ADR R1**。

### 3.1 触发

`agent_end` hook，在 §2 classifier 之前跑（outcome 是 classifier 的 context 之一）。

### 3.2 核心 prompt skeleton

见 ADR 0024 §5.2。production-ready 版本待 R1：

- 触发条件：所有 agent_end 都跑（不预筛）
- prompt 输入：本 session 注入过的所有 entry + 完整 conversation + tool_result
- prompt 输出：每条 entry 的 self-report（DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED + counterfactual quote）

### 3.3 关键设计点（R1 必须解决）

- **谁来跑**：是原始会话 LLM（理想——它知道自己内部状态），还是后启 LLM（实际——session 已 end，原始 context 可能不复存在）？妥协方案：原始会话 LLM 在 session 即将结束时被 prompt "self-report"，但不能干扰用户的正常 task 体验
- **schema**：outcome_history[] 的字段、写到 entry frontmatter 还是单独 timeline？
- **去重**：同一 entry 被多次注入时，每次都 self-report 还是合并报告？

### 3.4 与能力点 1 / 3 / 5 的依赖

- 能力点 1（§2）：classifier 的 confidence 评估会读最近的 outcome_history（被纠错过的 entry 更不可信）
- 能力点 3（§4）：aggregator 跨会话比对 outcome 趋势
- 能力点 5（§6）：classifier prompt 演进要看 outcome 数据是否系统性偏差

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

见 ADR 0024 §5.4（两次独立 API 调用 / Blind Pass 1 / Reveal Pass 2 / anchor bias self-check / 跨基座 normalization preamble）。

### 5.3 关键设计点（R3 必须解决）

- **provider 选择**：proposer 和 reviewer 必须不同 provider；具体怎么从 pi 可用 provider 列表里选？(失败 / rate-limit 处理)
- **DEFER 后的归宿**：reviewer DEFER 时，那个 op 是写 staging 还是直接丢弃？
- **成本预算**：每个高价值操作翻倍 token 调用，预估每月 abrain 维护成本
- **跨基座 normalization preamble**：production-ready 版本（ADR 0024 §5.4 末尾只给了核心句，需要完整段落）

---

## 6. 能力点 5：Classifier prompt 自身的演进 — R0 骨架

**详细设计 → 本 ADR R4**。

### 6.1 关键设计点（R4 必须解决）

- **诊断入口**：`/abrain audit classifier` 命令展示什么？最近 N 条 reasoning trace？按类型分组？标红 advisory flag？
- **prompt 版本管理**：classifier prompt 在 `prompts/correction-classifier-v1.md`、`v2.md`、...；新版本上线时旧 audit trace 怎么标记？ADR 0024 §4.2 表里 R7 加的"reasoning_trace 跨 prompt 版本兼容"在这里落地
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

## 8. 实施 Phase 路线图

按能力点依赖关系排序：

| Phase | 能力点 | 阻塞前置 | 工程量 |
|---|---|---|---|
| **P0** | §2 主动纠错识别 | ADR 0024 R0 patch（已完成）+ 本 ADR R0 ship | 中（含 prompt 迭代数轮）|
| **P1** | §3 outcome self-report | P0 ship + 本 ADR R1 ship | 中 |
| **P2** | §4 aggregator | P1 ship + 本 ADR R2 ship | 大（含调度基础设施）|
| **P3** | §5 multi-view | P2 ship + 本 ADR R3 ship + cross-provider 可用 | 中 |
| **P4** | §6 classifier prompt 演进 | P0 ship 后 audit 数据积累数周 + 本 ADR R4 ship | 小（主要是诊断入口）|
| **P5** | §7 静默归档 + 回滚窗口 | P4 ship + 本 ADR R5 ship | 中 |

每个 Phase 独立 ship、独立 multi-LLM audit、独立 dogfood 数周后才进下一 Phase。**不一次性 ship 全部六条**——pi-astack 的 maxim `staged-rollout-better-than-big-bang` 适用。

总工程量按 ADR 0024 §9 估算"约 pi-astack 当前体量翻倍"，多季度迭代。

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

## 10. 与 ADR 0024 边界的对齐自检

每个 Phase ship 前必须 self-check：

| ADR 0024 边界 | 本 Phase 是否触碰 |
|---|---|
| §2 INV-INVISIBILITY | 任何 ui.notify / `/brain health` 自动弹窗？✗ |
| §2 INV-AUTONOMY | 任何 prompt_user / `/rule veto` / 月度 manual workflow？✗ |
| §2 INV-IMPLICIT-GROUND-TRUTH | 任何信号收集走元 UI 不走自然对话？✗ |
| §2 INV-ACTIVE-CORRECTION | classifier 能稳定识别 task-natural 纠错？✓ 必须 |
| §3 AI-Native 原则 | 任何防出错路径是机械 gate / schema enforcement / threshold？✗（违反 → 必须 justify 为什么不能 prompt 工程） |
| §4.2 反模式 | `MEMORY-RULE:` fence / `/rule add` / `/about-me` / 月度 self-improve？✗ |
| §6 接受的代价 | 错误传播跨设备 / 数月才纠正 / multi-view 翻倍成本 — 已显式 acknowledge？✓ |

任何一项触碰 → 该 Phase 不能 ship，必须先回 ADR 0024 调 invariant。

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
