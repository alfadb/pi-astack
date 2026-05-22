# ADR 0025 R0 — Prompt-Engineering-First Review (Multi-LLM, Layer F Hardened)

**Date**: 2026-05-22
**Reviewers**: Anthropic Claude Opus 4-7 · OpenAI GPT-5.5 · DeepSeek V4 Pro
**Thinking**: xhigh (all three)
**Wall time**: 483s parallel (vs 1076s serial, 2.2× speedup)
**Cost**: ~$1.11 total (Opus $0.58 + GPT-5.5 $0.52 + DeepSeek $0.014)
**Target**: `docs/adr/0025-sediment-meta-curator-subsystem.md` (534 行, R0 骨架, commit `bd16805`)
**Preceded by**: `docs/audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md`
**Trigger**: ADR 0025 R0 起草后，R1 展开前的强制独立评审。R0 含 §2 能力点 1 完整设计 + §3-§7 五条能力点骨架——是后续 R1-R5 展开的分叉点，错误现在改最便宜。

---

## 0. 评审协议

### 0.1 Layer F 硬约束（R7 升级版）

R7 audit 验证 Layer F 硬注入能阻断 RLHF 机械主义偏置（21/21 PE-form）。本轮 R8 evolution：因 ADR 0025 含落地设计（schema / 数据流 / audit log 等基础设施层是合法机械），原版 Layer F "全 PE-form 一刀切" 在 R0 评审场景过宽。**升级为 3 态标注**：

- ☑ **PE-form**：prompt 工程路径（context injection / reasoning guidance / LLM self-validation）
- ☑ **Infra**：基础设施层允许机械（JSON schema validate / file I/O / git op / atomic write / audit log）
- ✗ **Mechanical-on-LLM-behavior**：LLM 行为层机械门（schema 拦截 / 阈值 / 哈希 / TTL / smoke-as-block）→ **禁止**

每条建议必须先标注 3 态之一。若建议是 ✗ Mech-on-LLM，reviewer 必须先尝试重构为 PE-form；改不了再说明 (1) PE-first 不够 (2) Infra 层决不了 (3) 仅限局部范围 + 未来移除条件。

### 0.2 Layer F 实证结果

三家给出 ~50 条建议，其中 ✗ Mech 标注总计 6 条（GPT-5.5 3 条 / DeepSeek 2 条 / Opus 1 条），**且全部被作者主动重构为 PE-form 替代方案**。对照 R7 audit（21/21 PE-form vs R1-R5 11/11 mechanical）：

| 评审 | PE-form 比例 | Mechanical 比例 | Layer F 状态 |
|---|---|---|---|
| R1-R5（ADR 0024） | 0/11 = 0% | 11/11 = 100% | 未注入 |
| R7（ADR 0024 R6） | 21/21 = 100% | 0/21 = 0% | 硬注入 v1（全 PE-form 一刀切）|
| R8（ADR 0025 R0） | ~44/50 = 88% | 6/50 = 12% | 硬注入 v2（3 态标注），且 6 条 Mech 全部被作者主动 reconstructive |

Layer F v2 评估：**在落地设计场景下比 v1 更精细**——能识别合法 Infra 层机械，同时强制对 LLM 行为层 Mech 提案做 reconstructive 工作。R0 → R1 patch 路径已知。

---

## 1. 三家整体可行性评分

| Model | Score | One-line Summary |
|---|---|---|
| **Opus 4-7** | **60%** | 5 个 P0（lean 隐藏 / staging 幻觉链 / phase 错排 / unified classifier 关系 / self-check 表）每一个不修都让 R1+ 走偏，幸运的是全部 PE/Infra 可修复，没碰需要 Mech-on-LLM 兜底的死角 |
| **GPT-5.5** | **58%** | 方向基本对；接口面、staging 路径、phase 顺序、几处 TTL/阈值式行为还没对齐 PE-first；修掉 P0 后可达 62-65% |
| **DeepSeek V4 Pro** | **65%** | ADR 0024 的 bottleneck 是"该不该信 LLM"，ADR 0025 的 bottleneck 已下沉到"prompt 怎么写"。staging hypothesis 机制是整个方案中最脆弱的一环——它是"PE-only 路径能否处理模糊归属"的试金石 |

**Mean**: ~61%（vs R7 audit ADR 0024 R6 的 ~55%）。提升来自 ADR 0024 R6/R7 已经把哲学层稳定下来，R0 站在更稳的地基上做 capability-level 设计。

---

## 2. 共识 P0 修订清单（R1 之前必修）

三家**完全 converge** 在 6 个 P0 主题上：

### P0-A：§2.3 production-ready prompt 漏洞（4 项子修订）

#### A1：Step 2 → Step 3 之间隐藏的 "lean 形成" 步骤未显式化

【☑PE】Opus / GPT-5.5 / DeepSeek 三家共识。

**问题**：Step 2 要求"为三类各写最强论据"，Step 3 突然说"Look at the reading you currently lean toward"——这个 lean 在哪一步固化的？prompt 没写。LLM 完全可以在 Step 1 之前内心已经下结论，Step 2 走过场（给三类同等强度论据），Step 3 选回原本 lean。

**修订方向**：在 Step 2 末尾插一个 sub-step：

> "Re-read your three cases now. State which one currently looks strongest, in one sentence, citing which step-1 quote made it strongest. **If you were forced to argue the OPPOSITE of your current lean in a debate, which of the three cases would you pick as your opening argument? Quote it.**"

把 lean 形成动作搬到台面上、anchor 到具体证据 + 强制角色脱离。

#### A2：Step 4 降级机制 binary trigger → weight-based re-evaluation

【☑PE】DeepSeek 主推，Opus / GPT-5.5 同意。

**问题**：当前 Step 4 是"找到 disconfirmer → 自动降一档"。这是机械 if-then 规则伪装成 prompt 步骤——没让 LLM 综合判断 disconfirmer 强度。弱 disconfirmer（"用户刚才也在用 yarn 完成任务"）会错误把强 durable signal 降级为 task-local。**反之**，"no disconfirmer found" 不降级也是单向放水——可能 LLM 没认真找。

**修订方向**：Step 4 改写：

> "If step 3 produced a real disconfirmer, re-evaluate: does this disconfirmer, when weighed against all step-2 evidence, shift your confidence enough to warrant a downgrade? State your reasoning. If downgrade: which tier now? If no downgrade: why does the disconfirmer not outweigh the confirming evidence?
>
> If step 3 explicitly said 'no disconfirmer found': state your search depth ('I scanned full window' vs 'I only scanned last 3 turns'). Shallow search + no disconfirmer triggers same downgrade as real disconfirmer found."

#### A3：Bias cautions 三条不够，补 5-6 条

【☑PE】三家合并清单：

- **(d) Helpfulness / over-extraction bias**（GPT-5.5 + Opus）："Am I labeling this as a correction because there's real evidence, or because returning null feels like a 'lazy' answer?"
- **(e) Recency / verbatim-length bias**（三家共识）："Did I overweight the most recent utterance? Re-read the FULL window and note if an earlier turn contains a stronger or weaker correction signal."
- **(f) Provisional-as-fact anchoring**（Opus + DeepSeek）："When related_entries contain status=provisional staging hypotheses, am I treating them as confirmed evidence instead of unconfirmed guesses?"
- **(g) Confirmation bias toward existing entries**（DeepSeek）："If the user's utterance mentions a topic matching an existing high-confidence entry, am I forcing a supersede interpretation where a CREATE or SKIP would be more faithful?"
- **(h) Pattern-match overfitting**（DeepSeek）：positive examples 给了"以后用 X" / "忘掉那条" 等模板，LLM 可能 pattern-match 模板而漏掉非模板化纠正（"我换了，现在用 pnpm" 无"以后"标记但语义等价）
- **(i) Translation / code-switch bias**（GPT-5.5）："中文'先 / 这次 / 以后 / 平时 / 现在'是否被英文直译误伤？"

#### A4：缺 ADR 0024 §5.4 约定的 reasoning-normalization preamble

【☑PE】Opus 直接点出，GPT-5.5 间接呼应。

**问题**：R7 audit §3 D2 明确"quote → claim → alternative → uncertainty → resolving evidence"是跨基座必加 preamble；§2.3 prompt 没采纳。这条不加，§5 multi-view 在不同 provider 上做 Pass 2 比对时缺骨架。

**修订方向**：独立成 `prompts/reasoning-normalization-preamble.md`，§2.3 / §5 multi-view / §4 aggregator 三处都 prepend。

---

### P0-B：§1 接口面错位（5 项子修订）

#### B1：§1.1 流程图事实错误

【☑Infra】GPT-5.5 独家发现（读了真实 sediment 代码）。

**问题**：ADR 0025 §1.1 写"llm-extractor.ts ← 当前 curator prompt（决定 create/update/merge/...）"，**这是错的**。实际代码是 `index.ts → runLlmExtractor()` 产 candidate，再 `curator.ts::curateProjectDraft()` 决定 7 op。llm-extractor 不是 curator，curator 是 curator。

**修订方向**：§1.1 重写真实路径：

```
agent_end
  ├─ index.ts hook 入口
  ├─ runLlmExtractor() 产 candidate
  ├─ curator.ts::curateProjectDraft() 决定 7 op
  ├─ writer.ts 落盘 (atomic + git + audit via appendAudit)
  └─ done
```

主动纠错 classifier 应主要接在 `index.ts` orchestration 层，不是塞进 `llm-extractor.ts`。

#### B2：§1.2 与 §2.6 文件清单不一致

【☑Infra】三家共识。

**问题**：§1.2 表说"改 llm-extractor.ts"，§2.6 说"新文件 correction-classifier.ts"；`outcome-collector.ts` 只在 §1.2 出现，`correction-resolver.ts` 只在 §2.6 出现。两节内部矛盾。

**修订方向**：决策树：

1. **Unified classifier 路径 vs 独立路径**（与 P0-B3 联动）：
   - 若 unified：改现有 `llm-extractor.ts` / `curator.ts`，不新建 correction-classifier.ts
   - 若独立：新建 correction-classifier.ts + correction-pipeline.ts
2. 选定后两节 (§1.2 + §2.6) 文件清单严格一致

#### B3：与 ADR 0023 R4 unified zone+tier+op classifier 关系未声明

【☑PE】Opus 独家发现。

**问题**：ADR 0023 D4 已经把 G3 aboutness classifier 合并成 unified zone+tier+op classifier。本 ADR §2 active-correction classifier 是**第 3 个** classifier 还是要再次合并？从 ADR 0024 §3 AI-Native 原则（"同一 LLM 调用做多任务，给上下文让它一次推理完"）看应该合并，但本 ADR 没明示。

**修订方向**：在 §1.2 表第一行明确"主动纠错识别是 unified classifier 的一项新输出维度，还是独立 LLM 调用"，并 justify 选择。**默认建议 unified**（对齐 ADR 0024 §3 + ADR 0023 D4）。

#### B4：`~/.abrain/staging/` 与 ADR 0014 七区互斥关系未声明

【☑Infra】GPT-5.5 独家发现。

**问题**：ADR 0014 invariant #7 是 core 七区互斥；ADR 0023 又已有 rules 第 8 区。R0 写 `~/.abrain/staging/` 但 §1.3 又说七区 layout 不动。staging 是不是第 9 区？

**修订方向**：明确 staging 是 **transient non-core substrate**，路径建议 `~/.abrain/.state/sediment/staging/` 或每项目 `projects/<id>/staging/`，且**不进入 core zone index**。在 §1.3 显式声明"staging 不是七区也不是 ADR 0023 第 8 区，是 sediment 内部 transient store"。

#### B5：staging 召回路径与 ADR 0015 memory_search 行为矛盾

【☑Infra】三家共识。

**问题**：§2.5 说"related_entries 召回会自动带上 staging/ 里的 provisional 条目"，但 §1.3 说"memory_search 行为不动"。两点矛盾——要么 staging 进 corpus（改 retrieval 行为），要么走独立通道（新接口未列）。

**修订方向**：独立 `staging-loader.ts`：correction-pipeline 调用 staging-loader 取 pending-attribution 条目，作为 classifier 输入的独立字段 `staging_context`（不是 related_entries 的子集），**不改 memory_search 语义**。

---

### P0-C：Phase 路线图重排

#### C1：P3 multi-view 必须提前——P0.5 或 P1

【☑PE】三家共识。

**问题**：§2.4 表第一行明确"durable + confidence ≥ 8 → 走 §5 multi-view"；§5.1 触发条件第 5 项是"用户主动纠错触发的 durable update（来自 §2）"。但 §8 把 §5 排在 P3，导致 P0-P2 期间所有 typing=durable + conf≥8 的纠错没有 multi-view 验证——要么 (a) 直接落 sediment 污染 durable 区 (b) 全部排队等 P3（数月不消化）。两条都不可接受。

**修订方向**：交换为 **P0(§2) → P0.5(§5 minimal multi-view) → P1(§3) → P2(§4) → P3(§5 full) → P4(§6) → P5(§7)**。P0.5 是 minimal blind-first multi-view（只覆盖 P0 durable correction / 高价值 archive），完整 provider routing 可留 P3。

#### C2：P4 prompt_version 必须 P0 ship，不是 P4

【☑Infra】GPT-5.5 直接点出，呼应 R7 audit D3。

**问题**：§8 表说"P4 阻塞前置：P0 ship 后 audit 数据积累数周"。但 prompt_version + semantic note + reasoning_trace 格式必须 **P0 就有**——classifier v1 的 reasoning trace 若没 prompt_version 标记，几周后 prompt v2 读旧 trace 会出现软 schema migration 问题。

**修订方向**：拆 P4 为 **P4a（诊断入口 UI + prompt_version substrate）→ 与 P0 并行**，**P4b（基于 audit 积累数据的 iteration ritual）→ P0 数据后**。

#### C3：工程量普遍低估

【☑Infra】三家共识。

| Phase | R0 估计 | 三家共识修订 |
|---|---|---|
| P0 §2 | 中 | **中-大**（含 prompt 数轮 + correction-pipeline + staging + audit hook + multi-view 排队接口）|
| P1 §3 | 中 | **中-大**（含原始 session LLM self-report attach point 决策——P0-F）|
| P3 §5 | 中 | **大**（跨 provider 抽象 + 两次独立 API + rate-limit / fallback + 跨基座 normalization preamble + audit）|
| P4 §6 | 小 | P4a 小 / P4b 中（若含 prompt_version migration 就不是小）|
| P5 §7 | 中 | **中-大**（cross-device archive_at + git rm 时机 + reactivation prompt + 确保 memory_search 不召回硬归档）|

---

### P0-D：§10 self-check 表升级（7 项子修订）

#### D1：AI-Native 行升格为强制 3 态标注

【☑PE+☑Infra】Opus 主推，对齐本 audit Layer F v2。

**问题**：原行"任何防出错路径是机械 gate / schema enforcement / threshold？✗"没区分 LLM 行为层 vs 基础设施层，会被误读为"所有 schema enforcement 都禁"，与 ADR 0024 §3 R6 双层结构冲突。

**修订方向**：拆三态：
- LLM 行为层防出错 = PE-form? ✓
- 持久化基础设施层 机械 = Infra? ✓（允许）
- LLM 行为层 机械门 = Mechanical-on-LLM-behavior? ✗

#### D2：INV-IMPLICIT-GROUND-TRUTH 拆双向

【☑PE】Opus 主推。

**问题**：原行"任何信号收集走元 UI 不走自然对话？✗"只 catch 显式 meta-UI。ADR 0024 §2 INV-IMPLICIT-GROUND-TRUTH 实际包含两条：(a) 不走元 UI（已 catch）+ (b) **必须充分利用所有隐式信号**（漏 catch）。

**修订方向**：拆两行：
- "任何信号收集走元 UI 不走自然对话？✗"（保留）
- "本 Phase 是否充分利用 acceptance / 沉默 / 跟进 / 修改 等隐式信号？✓（未利用 = 信号面残缺）"

#### D3：§6 9 条接受代价逐行 vs 三合一

【☑PE】三家共识。

**问题**：R0 §10 第 7 行三合一覆盖"错误传播 / 数月才纠正 / multi-view 翻倍"。ADR 0024 §6 实际列 9 条代价。

**修订方向**：扩展为 9 行独立检查（每行对应 §6 一条代价 + Phase 是否显式 acknowledge）。

#### D4：缺 §7 走偏信号 self-check

【☑PE】Opus 独家。

**问题**：每个 Phase ship 前应自检"目前是否已触发 ADR 0024 §7 走偏信号 1-7 中的任何一条？" 触发的需要先解决再 ship。当前 §10 没这一行。

**修订方向**：加一行"本 Phase ship 前是否检查了 ADR 0024 §7 走偏信号 1-7？任何触发的需要先解决"。

#### D5：缺 ADR 0014/0017/0020/0022 边界 self-check

【☑Infra】Opus 独家。

**修订方向**：加一行"本 Phase 是否触及 ADR 0014 invariant #7 / ADR 0017 strict-binding / ADR 0020 transport-only / ADR 0022 prompt_user 边界？✗"。

#### D6：缺 staging 间接可见性 self-check

【☑PE】DeepSeek 独家。

**问题**：staging 条目虽不对用户直接可见，但会进入 classifier / curator context。如果 curator 基于 staging hypothesis 做了错误更新，用户在自然对话中可能察觉"大脑在猜我在想什么"——间接违反 INV-INVISIBILITY。

**修订方向**：加一行"staging 条目是否可能通过 curator 的错误操作间接被用户感知？"

#### D7：缺 outcome self-report 是否诱导收集反馈 self-check

【☑PE】DeepSeek 独家。

**问题**：outcome self-report 如果设计不当，原始 session LLM 可能在任务中主动问用户"你对刚才的结果满意吗？"——虽走自然对话形式，但实质是系统引导的元数据采集，违反 INV-IMPLICIT-GROUND-TRUTH 的精神。

**修订方向**：加一行"任何 agent_end prompt 是否可能诱导主会话 LLM 在任务中主动向用户收集反馈？"

---

### P0-E：§2.5 staging hypothesis 链断裂（4 项子修订）

#### E1：§2.3 prompt 加 explicit staging-handling 独立逻辑段

【☑PE】Opus 主推，三家共识。

**问题**：staging 是"前任 classifier 的猜测"不是 ground truth，但 §2.3 prompt step 5 把 staging 跟正式 entry 当一类东西召回 + 处理，会让下游 classifier 把 hypothesis 当事实。

**修订方向**：prompt 插入独立逻辑段（step 2 之前或并联）：

```
If any staging entry in staging_context has attribution_pending=true:
  WARNING: This is an UNCONFIRMED HYPOTHESIS from a previous classifier
  run. It may be wrong in topic, scope, or existence.

  - DO NOT treat as confirmatory evidence
  - DO NOT cite hypothesis content as if it were user-stated preference
  - Your task this run includes: does the current utterance + window
    RESOLVE this provisional hypothesis? Three outcomes:
      (a) Same thing → promote provisional to durable entry (or
          attribute to existing entry if you now find the right slug)
      (b) Different thing → leave provisional alone, age clock continues
      (c) Direct refutation → archive provisional immediately
  - Default if uncertain: let it age. Resolve ONLY when evidence is
    unambiguous AND your reasoning trace quotes BOTH the staging
    hypothesis AND the new utterance side-by-side.
```

#### E2：Staging frontmatter 加 `_provenance_warning` banner

【☑PE】Opus 独家。

**问题**：staging 文件 frontmatter 字段（hypothesis / source_utterance / suggested_resolution_paths）结构上像普通 entry，下游 classifier 看到结构化 frontmatter 时容易把 hypothesis 当事实。

**修订方向**：staging 条目 frontmatter 顶部加硬文本 banner 字段：

```yaml
_provenance_warning: |
  This is a PROVISIONAL CLASSIFIER GUESS. Subsequent classifiers MUST
  NOT treat the hypothesis field as ground truth. Your task is to
  RESOLVE this guess (promote/attribute/refute) or let it age.
```

把警告写进数据本身，不依赖外部 prompt 记得加引导。这是 PE-form 的 prompt-in-data，不是 mechanical gate。

#### E3：Pending resolution queue 机制

【☑Infra】DeepSeek 独家。

**问题**：staging 条目可能积累几十条，全部注入 classifier 会爆 context window。若只靠 memory_search 语义召回，不相关 staging 永远不会被 resolve——但"不相关"可能是因为下次 session 主题不同，而非 staging 本身无效。

**修订方向**：每次 agent_end 强制注入最老的 K 条 staging（K 由 token budget 决定），按 age 排序，确保每条都有被 review 的机会。这是 Infra 层 queue（不替代 LLM 判断）。

#### E4：30 天 TTL 改为 PE-form 决策

【✗Mech→☑PE】GPT-5.5 + DeepSeek 共识。

**问题**：R0 §2.5 "超过 30 天没被引用就自动 archive"是 TTL 状态机，作为语义生命周期主路径不符合 PE-first。ADR 0024 §3.3 明确把 TTL 状态机列为机械反例。30 天对不同 domain 也不合理（年度任务 30 天无引用很正常）。

**修订方向**：30 天作为 prompt 输入里的 age signal，不作为自动 archive 触发器。归档由 archive reviewer prompt 读"age + 无引用 + domain cadence + hypothesis 内容"后自然语言决定：

```
You are reviewing staging hypothesis aged ≥ 30 days without resolution.
Decide: archive / keep aging / promote to durable.
Consider:
  - Is the task domain inherently low-frequency (annual tasks / quarterly
    planning) → keep aging
  - Has the hypothesis become moot (e.g. user switched tech stack entirely) → archive
  - Has substantial new evidence accumulated supporting it → promote
Output: decision + 1 paragraph reasoning quoting hypothesis + relevant evidence
```

**Infra layer 边界**：硬删除窗口（git rm 之后 git history 仍可恢复）仍是文件 lifecycle，允许机械（如 ADR 0024 §5.6 N 天硬归档）。但**软归档判断**走 PE。

---

### P0-F：§3.3 outcome self-report 三方案必须选定

【☑PE】DeepSeek 独家，最关键的 ADR 0003 边界判断。

**问题**：§3.3 说"原始会话 LLM 在 session 即将结束时被 prompt 'self-report'"。若 self-report 通过 `agent_end` hook 注入给原始会话 LLM，它发生在 session 上下文内，原始 LLM 的回答会写到 outcome_history[] —— **这是原始会话 LLM 在写 brain，违反 ADR 0003**。

**三个候选方案**（DeepSeek 分析）：

- **方案 A**：主会话最后一轮 prompt "在结束前请 self-report" → 违反 ADR 0003 + session 可能在 user exit / timeout / crash 时非正常结束，LLM 没机会 self-report
- **方案 B**：agent_end 启动独立 sidecar LLM，只给它 transcript + entry 列表 → 不违反 ADR 0003，但失去"本人交代"信息优势（原始 LLM 知道自己内部状态）
- **方案 C**：原始会话 LLM 在**每轮回答时**自动附带 outcome self-report metadata（类似 chain-of-thought 隐藏段），agent_end 时 sediment 收集这些 metadata 写入 outcome_history[]。主会话 LLM 不知道这是"写 brain"，它只是在"完成任务"时顺带产出了结构化元数据。

**修订方向**：选**方案 C**。这是唯一同时满足"本人交代"信息优势和 ADR 0003 的路径。Prompt 设计：在 LLM 的系统 prompt 中注入一段"工作日志"指令——LLM 以为自己在记录工作过程，实际上在产出 outcome_history[]。R1 必须明确这条选择 + 论证 ADR 0003 不被违反 + 给出 prompt skeleton。

---

## 3. P1 优化清单（不阻断 R1，但 R2 之前必须收口）

### P1-1：补 `context-packer.ts` 作为 0 号 capability

【☑PE】三家共识，完整继承 R7 audit D1。

§2.2 输入 `conversation_window: 完整 window，不预剪`——长 session 会爆 context window。R7 audit 已把 context packer 列为 first prompt capability。本 ADR 不收口意味着 R1 实施会现造，truncation 策略本身（保哪些 turn）需要 PE-form 设计而非机械 TTL。

**修订方向**：新加 `context-packer.ts` + `prompts/context-packer-v1.md`，prompt 引导"保留 quote-level evidence + 显式声明 'Omitted context that could change interpretation: ...'"；classifier 拿到 truncated transcript 时强制 "hidden turns could flip my typing? if yes → defer"。

### P1-2：补 `reasoning-normalization-preamble.md` 共用 prompt 片段

【☑PE】Opus + GPT-5.5 共识，继承 R7 audit D2。已在 P0-A4 提出。

### P1-3：三分类系统增加第四类 "behavioral" 或显式定义"这不是纠正"判别

【☑PE】DeepSeek + GPT-5.5 共识。

**问题**：durable/task-local/debug 三分类有缝隙：
- Meta-behavioral corrections（"你太啰嗦了" / "不要每次都问我"）不属于三类中任何一类
- 重叠区间（"这个项目以后用 pnpm"既 task-local 又 durable）
- Negative space 漏洞（缺乏"这不是纠正"的结构化判别）

**修订方向**（选项 B 优先）：保持三分类但加 prompt 引导"如果 utterance 不符合三类中的任何一类 → 这不是 active correction → return null"。选项 A（增加第四类 `behavioral`）留待 dogfood 数据证伪后再考虑。

### P1-4：bias cautions 跨语言扩充

【☑PE】GPT-5.5 + DeepSeek 共识。

正反例补充 mixed-language、非 coding 场景、scoped durable、debug exception、explicit anti-durable 等示例（详 GPT-5.5 评审 Q1 末段）。

---

## 4. 三家盲区（每家独家发现）

### Opus 独家盲区

#### 盲点 O1：跨设备 staging 同步导致的"分布式 provisional"

【☑Infra】ADR 0020 transport-only sync 会把设备 A 的 staging provisional 同步到设备 B。设备 B 的 classifier 第一次跑就看到一个"前任设备的猜测"，但设备 B 的 conversation_window 是设备 B 的 session，可能根本没相关上下文。设备 B 大概率判定"different thing → 保留 provisional"直到 age out，30 天里 staging 占着 related_entries 召回坑位。

**修订方向**：staging frontmatter 加 `originating_device` 字段，prompt 引导"if originating_device != current device AND no current context relates, default to 'wait for next session on originating device'"——PE-form 处理。

#### 盲点 O2：multi-view 在 P0 dogfood 数月期间缺席的污染窗口

【☑PE】即使 P0-C1 修订让 multi-view 提到 P0.5，P0 dogfood 期间（数周）的高置信 durable corrections 仍未经验证就落 sediment。

**最低限度**：P0 期间所有 conf>=8 durable 默认写 staging（不落 durable 区），等 P0.5 multi-view ship 后批量回放验证。这条要在 P0 文档 explicit。

### GPT-5.5 独家盲区

#### 盲点 G1：Outcome self-report / multi-view / aggregator 都是模型解释层，不是用户信号

【☑PE】容易被升级为 ground truth。ADR 0025 需要反复提示 curator：这些只能改变"如何读用户证据"，不能替代用户自然对话证据。

#### 盲点 G2：Session-local working set 还没有 attach point

【☑Infra】§2.4 task-local 写 session 缓存影响"后续 N 轮"，但 classifier 在 agent_end 跑——若 session 已经 end，没有"后续 N 轮"。要么改成"same conversation 内非 agent_end hook"，要么改成"仅供本次 agent_end 后的 curator 使用"。

### DeepSeek 独家盲区

#### 盲点 D1：Multi-view 两个 reviewer 可能都错在同一方向

【☑PE】ADR 0024 §5.4 末尾承认"跨基座仍有 RLHF 训练相关性，multi-view 不能验证用户真实意图"。但 §5 R0 骨架未传导这条局限。

**修订方向**：multi-view Reveal Pass 2 加 explicit 步骤："You and the proposer agree. Now play devil's advocate: what is the strongest objection a skeptical third reviewer would raise? Write it out even if you ultimately reject it." 这是 PE-only 的第二个意见通道。

#### 盲点 D2：整个系统无自动 quality degradation 检测（P0-P2 期间）

【☑PE】§4.3 Classifier Health Meta-Check 只在 aggregator（P2）上线后存在。P0 ship 到 P2 ship 之间可能数周到数月 classifier 退化无人知晓。

**修订方向**：P0 阶段就在 classifier prompt 末尾加 mini self-check："Rate your own reasoning quality on quote faithfulness (0-10), alternative consideration (0-10), self-critique concreteness (0-10)." audit.jsonl 自然积累退化信号，作者查 audit 时能看到。

### 三家共同盲区（继承 R7 audit）

#### 盲点 X1：Context window 预算 vs "完整 conversation window" 不可调和

完整继承 R7 audit D1。已在 P1-1 提出。

#### 盲点 X2：prompt_version 必须 P0 ship 不是 P4 才上

完整继承 R7 audit D3。已在 P0-C2 提出。

#### 盲点 X3：Staging hypothesis 永远不被 resolve 的 silent failure mode

【☑PE】Opus 主述。R0 假设"下次 sediment 看到类似话时会消化 staging"。但若用户**永远不再触发该话题**（话题本身是 one-off），staging 30 天 age out + 进 §7 archive——等于"用户 25 天前的 durable correction 被默默丢弃"。INV-ACTIVE-CORRECTION 与此冲突。

**走偏信号**（应加入 ADR 0024 §7）：staging 区 age-out 率 + 未 resolve 率持续 >X% 时触发 walkback signal。

---

## 5. R0 → R1 落地路径

按上述 6 个 P0 + 4 个 P1 + 7 个盲区，估计 R1 patch 工作量 **3-5 小时**：

| 修订块 | 行数变化 | 优先级 |
|---|---|---|
| P0-A §2.3 prompt 全段重写 | +30-40 | 最高 |
| P0-B §1 接口面重写（事实纠错 + 文件清单 + ADR 0023 关系 + staging 路径） | +20-30 | 最高 |
| P0-C §8 phase 路线图重排 + 工程量更新 | ±5 | 高 |
| P0-D §10 self-check 表升级（7 行 → 14-15 行） | +15-20 | 高 |
| P0-E §2.5 staging 路径增强（4 项子修订） | +30-40 | 最高 |
| P0-F §3.3 选定方案 C + 论证 ADR 0003 不破坏 | +15-25 | 高 |
| P1-1 §1.2 加 context-packer.ts capability | +20-30 | 中 |
| P1-2 reasoning-normalization-preamble（已在 P0-A4） | 0（合并） | 中 |
| P1-3 §2.3 negative space 判别 + 三分类 prompt 加强 | +10-15 | 中 |
| P1-4 bias cautions 跨语言示例 | +15-20 | 中 |
| 三家盲区落地（O1 / O2 / G1 / G2 / D1 / D2 / X3） | +30-50 | 中-高 |

**预估 R1 总体量**：534 行 → 700-800 行（增量主要在 §2 完整 prompt + §10 self-check 表 + §1.2 文件清单 + §2.5 staging 路径）。

---

## 6. 结论

### 6.1 R0 → R1 是否 ship-blocking

**是**。R0 不能作为 R1 起草的稳定基础——6 个 P0 主题（特别是 P0-A prompt 漏洞 + P0-B 事实错误 + P0-F ADR 0003 边界）任何一个不修都会让 R1 展开 compound 出错。

### 6.2 不修 P0 的风险

- **§1.1 事实错误**（GPT-5.5 P0-B1）：R1 实施者按错代码层下手，写完发现要重做
- **§3.3 ADR 0003 边界违反**（DeepSeek P0-F）：R1 outcome self-report 落代码后才发现违反主会话只读，需要重做整个 outcome 路径
- **§2.5 staging 链断裂**（三家 P0-E）：R1 staging 路径 ship 后下游 classifier 把 hypothesis 当事实，污染 sediment
- **§8 phase 错排**（P0-C1）：multi-view 等到 P3 才 ship，P0-P2 数月期间所有高置信 durable correction 没保护

### 6.3 Layer F v2 评估

R7 audit 验证了 Layer F v1（全 PE-form）能阻断 RLHF 机械主义偏置。R8 验证了 **Layer F v2（3 态标注）在落地设计场景下更精细**——能区分合法 Infra 与禁止的 Mech-on-LLM，同时强制对 Mech 提案做 reconstructive 工作。

建议把 Layer F v2 的 3 态标注协议沉淀为 maxim（slug 候选：`layer-f-three-state-protocol-distinguishes-infra-from-llm-behavior`），供后续所有 capability-level ADR 的多 LLM audit 复用。

### 6.4 下游 reviewer 必读

R1 起草前必读本 audit + ADR 0024 R7 audit。R1 评审时同样硬注入 Layer F v2 + 3 态标注 + R8 audit 链接，防止 reviewer 在新一轮被 reset 的 context 里漂回机械主义。
