---
doc_type: adr
status: accepted
---

# ADR 0039 - Unified Evidence Architecture：第二大脑记忆统一证据架构与域自适应投影器

- **Status**: Accepted（原 Constraint-only 版本于 2026-06-18 accepted；统一记忆架构修订于 2026-06-19 经 4×T0 R2 全部 SIGN 后 ratify）。
- **Date**: 2026-06-18；统一架构修订：2026-06-19。
- **Relates-to**: [ADR 0003](./0003-main-session-read-only.md), [ADR 0015](./0015-memory-search-llm-driven-retrieval.md), [ADR 0016](./0016-sediment-as-llm-curator.md), [ADR 0023](./0023-session-start-rule-injection.md), [ADR 0024](./0024-second-brain-from-natural-conversation.md), [ADR 0025](./0025-sediment-meta-curator-subsystem.md), [ADR 0028](./0028-sediment-ground-truth-tiered-rearchitecture.md), [ADR 0031](./0031-autonomous-self-calibrating-forgetting.md), [ADR 0035](./0035-memory-stage1-embedding-candidate-retrieval.md), [ADR 0036](./0036-memory-search-two-stage-collapse-and-hybrid-retrieval.md)。
- **Revises-direction**: 本 ADR 原先只覆盖 Constraint Pipeline Reset；统一架构修订将同一根因提升到整个第二大脑记忆系统。原 constraint-only 决策被本版吸收，不再作为独立实施路线。

## 1. 背景：Constraint 问题不是局部问题

ADR 0039 最初只针对 rules / constraints：规则写入在 `agent_end` 实时路径中完成分类、去重、合并、scope 判断、归档、注入层选择，并直接修改 active rule 文件。持续出现的近重合并、scope 误升、settings/tool 信号混入 global rules、固定 body 大小降级、归档数量上限等修补，说明问题不在某个 prompt 或某个函数，而在写入形态本身：高不确定性的语义裁决被放在高影响的实时写入路径中。

后续重新审视发现，同一结构风险不仅存在于 Constraint 域。Knowledge，以及 identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影面，也会遇到同类问题：`agent_end` 从原始对话上下文直接做 create / update / merge / archive / rescope / delete 等 canonical mutation。只要这种路径存在，新的边界案例就会推动系统继续增加局部特殊逻辑，而不是修正写入形态。

本 ADR 因此将原 Constraint Pipeline Reset 扩展为 **Unified Evidence Architecture with Domain-Adaptive Projectors**：统一证据架构 + 域自适应投影器。Constraint 仍是该架构中的一个重要域，但不再是独立特例。

## 2. 术语

**Evidence Event** 是长期记忆写入前的证据事件，记录自然对话或系统运行中被观察到的信号。它不是最终记忆条目。

**Evidence Ledger** 是 Evidence Event 的持久证据层。它可以按域逐步落地，不要求首期实现单一全域 ledger 或统一全域 schema。

**Canonical memory** 是系统运行时使用的稳定记忆投影，包括 rules、knowledge entries、identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影。它不是 raw `agent_end` 写时裁决的直接产物。

**Projector** 是从 Evidence Event 生成 canonical memory 的投影器，可以同步或异步运行。**Compiler** 是更偏后台、批量或复杂语义综合的 projector。本文用 projector 作为通称。

**Diagnostic** 是不应进入 memory 的信号记录，例如 Settings / Tool Contract 相关诊断。Diagnostic 必须有消费面，例如 audit、notify 或后续实现任务入口。

## 3. 决策

采用统一证据架构：所有长期记忆域先追加 Evidence Event；canonical memory 是 Evidence Event 的物化投影；`agent_end` 不再从 raw transcript / raw context 直接执行 canonical memory mutation。不同消费面按 freshness 和影响半径选择不同投影器：Constraint 使用后台 compiler 生成 Compiled Constraint View；Knowledge 可以先使用同步 projector 维持检索新鲜度，满足条件后再迁移到异步 compiler；identity / skills / habits / workflows / project memory / rationale 等低频 zone 或 view 投影面逐步迁移。

统一的是写入纪律，不是首期工程形态，也不是新增一套全局 per-entry layering。系统仍以 markdown + git 为基座，不引入完整全域 event sourcing 数据库，也不要求首期建设单一全域 ledger / schema。Evidence Event 是证据层；stable views / entries 是读取面和运行时投影。持久信息模型继续遵守 ADR 0028 的 AX-SCOPE / AX-PROVENANCE / AX-MATURITY + f-CATEGORY；zone、inject-mode、staging、GTier 仍是子系统概念。共享 schema 或统一 ledger 只有在至少两个投影面完成验证后才考虑收敛。

## 4. 全域方向不变量

对所有长期记忆域，唯一低风险写原语是 append Evidence Event。`agent_end` 可以执行只读邻近语义检索、sanitize / redact、结构化提取、append event、audit / notify、调度 projector；不得从 raw transcript / raw context 直接执行 create、update、merge、archive、rescope、delete 等 canonical memory mutation。

Canonical memory 包括 rules、knowledge entries、identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影。它们是 append-only evidence 的物化投影，不再是实时写时语义裁决直接修改的本体；这些投影面不构成 ADR 0028 之外的新存储轴。

Evidence Event 至少包含：用户或系统信号 quote、source role provenance、session id、turn id、timestamp、active project binding、candidate domain / scope hint、sanitizer result、邻近语义只读检索摘要、event id / hash。纠错、撤回、遗忘、矛盾也追加新事件，不覆写旧证据。邻近语义只读检索摘要只记录当时已知上下文，不作为之后跳过或删除信号的理由。

显式用户信号不得因 extractor / classifier 不确定而静默丢失。若无法确定域或投影目标，系统必须追加 unclassified / queued Evidence Event 或 recall diagnostic，由后续 projector 消化。

Evidence Ledger 可作为审计和再生成输入，但不是自治遗忘的运行时复活通道。ADR 0031 的运行时复活通道仍必须由 `archived` 全文留在工作树、sparse 可达、用户自然纠错可触发复活来满足。

## 5. 域自适应投影器

### 5.1 Constraint

Constraint 域沿原 ADR 0039 的核心形态：append-only Constraint Draft/Event → background Constraint Compiler → Compiled Constraint View → `session_start` 稳定注入。`session_start` 只读取上一份稳定 view；存在 queued / stale 时提示状态，不同步调用 LLM 重新裁决。

Constraint compiler 执行语义合并、去重、scope 校验、冲突检测、配置 / 工具信号排除、文本压缩、优先级排序和注入摘要生成。compiler 记录足够的来源和幂等审计，使投影可以解释、重试和回看。

### 5.2 Knowledge

Knowledge 域采用 Knowledge Evidence → Knowledge Projector / Compiler → materialized Search Corpus View。Search Corpus View 可以表现为 markdown entries、metadata、indexable text 和检索索引输入。

Knowledge projector 可以按阶段同步或异步调度。无论同步还是异步，projector 都只能从 Evidence Event、Evidence Ledger 或 stable views 读取，不能从 raw transcript / raw context 直接裁决写 canonical。同步 projector 是 Evidence Event 后的投影步骤，不是旧写时裁决路径的改名。同步 projector 不得重新解析 raw transcript 来绕过 Evidence Event；它只能读取已追加的 Evidence Event 及其记录的邻近只读检索摘要。失败时至少保留 queued event，不得静默丢失显式信号。

Knowledge 默认可以先使用同步 projector 保持 `memory_search` freshness。只有 shadow projector / compile、diff、search A/B 证明 freshness、召回质量、延迟不退化，才将 Knowledge 从同步 projector 迁移到后台 compiler。若证据不足，保留同步 projector，但仍必须遵守 canonical = projection，不得回到 raw context 直写 canonical。

### 5.3 低频 zone / view 投影面

Identity、skills、habits、workflows、project memory、rationale 等是 zone 或 view 投影面，不是 ADR 0028 之外的新全局存储轴。这些投影面同样从 Evidence Event 由 projector 生成稳定视图。低频投影面可以先保留同步 projector，但必须记录审计和重新评估条件，避免长期回到旧写时裁决形态。

Rationale view 也应视为 evidence 的投影。它可以读取 ADR、audit、memory entry 和 source references，但不得把当前实现状态镜像回 ADR 正文；实现真相仍以代码和 `current-state.md` 为准。

### 5.4 Settings 与 Tool Contract

Settings 与 Tool Contract 不是 memory。模型分层、运行开关、预算、provider、功能 flag 等运行配置进入配置面；工具调用方式、前置条件、安全约束、选择规则进入 tool declaration、SKILL.md 或代码声明。自然对话中的相关信号只生成 not-memory diagnostic / audit，实际变更走配置、代码或工具声明流程。diagnostic 必须有消费面，例如 audit、notify 或后续实现任务入口，不能成为无人读取的记录。

## 6. 读取面与 freshness

Runtime consumer 默认只读 stable facade / view：`memory_search` 和 `memory_decide` 读 Search Corpus View；`session_start` 读 Compiled Constraint View；rationale / decision brief 读对应 materialized view。

Knowledge 若迁移到异步 compiler，或出现内容投影延迟，`memory_search` 必须支持 `stable view ∪ bounded hot evidence overlay`。近期未投影 Evidence Event 以 provisional tier 进入候选池，明确标注未编译、未投影、较低成熟度，不反写 canonical，不与 stable entry 同权。

Hot overlay 必须有确定性的基础设施预算，例如数量、时间、token 或候选上限，并优先使用结构化 evidence 摘要而非全量原始转录。不得用相似度阈值、准确率阈值等认知机械门替代 LLM 判断。

Hot overlay 和同步 projector 仍受 REQ-009 约束：`memory_search` 必须保持 LLM retrieval / rerank 的 accuracy-contract；模型不可用时 hard error；不得以 grep、BM25 或其它低准确度 fallback 当作正常结果继续写入长期记忆。

Constraint freshness 接受 queued / stale。系统注入上一份稳定 compiled view，并提示 queued / stale，不同步 LLM 裁决。

## 7. 语义综合、冲突与多视角审查

语义合并、去重、scope 判断、冲突解释、demote、supersede 等认知判断由 projector / compiler 完成，以 prompt-native 判断为主。基础设施可以做 sanitizer、path safety、schema lint、atomic write、lock / lease、audit、source provenance、idempotency、dedup prefilter 等来源边界和候选缩小，但不能替代 LLM 语义判断。

Multi-view verification 从 `agent_end` 写时门迁移到 projector / compiler 内部。高影响投影动作，例如跨 scope、merge / supersede、demote、高优先级约束提升，仍需要 prompt-native 交叉验证。该机制不是用户审批，也不是实时路径的机械阻断。

Projector 可以读取其它域 stable view 作为上下文，但不能形成循环写依赖。跨域引用必须记录输入 evidence / view hash、输出 view hash、模型、时间和审计摘要。若只是轻量上下文读取，可以记录摘要；若跨域信息影响输出决策，必须记录完整来源。

## 8. 保留与删除

保留以下方向和基础设施：INV-INVISIBILITY、INV-AUTONOMY、INV-ACTIVE-CORRECTION、INV-MAIN-SESSION-READ-ONLY、INV-GROUND-TRUTH-TIERED 的 provenance 实质、INV-REVERSIBLE-AUTONOMY、REQ-009 accuracy-contract、markdown + git、strict project binding、sanitizer、audit、atomic write、lock / lease、deterministic git sync、dedup prefilter、provenance / idempotency / sanitizer 等基础设施来源边界门。

删除或降级以下形态：写时 Jaccard / 阈值 / 固定 body-size demote / archive cap / scope 黑名单等用于替代 LLM 语义判断的认知机械门；`always` / `listed` / `inject_mode` 作为写时事实；settings / tool contract 被复制为 memory rule；从 raw `agent_end` 上下文实时 mutate active memory 的旧写入模型。

Dedup / near-merge 仍然存在，但迁移到 projector / compiler 内部。基础设施预过滤只作候选缩小或安全边界，最终语义判断由 prompt-native projector / compiler 完成。

## 9. 对既有 ADR 的修订

ADR 0028 的 Tier-1 原则保留其核心：用户显式 durable directive 与 LLM 推断假设不是同一信号类，USER-role provenance 和 source gate 仍是硬边界，用户显式约束不得静默丢失。本 ADR 修订写入形态：Tier-1 不再等于实时确定性提交 active rule，而是确定性 append witnessed Evidence Event；后续由对应域 projector / compiler 生成稳定投影。Provenance tier 与 compilation maturity 是正交轴：未投影不等于降级为可丢弃信号。

REQ-004 的“确定性提交、对用户可见、永不被 skip / stage 丢弃”在本架构下对应为：USER-role ∧ directive ∧ durable 的显式指令必须确定性追加 witnessed Evidence Event；event 必须可审计、可追溯、可见于 queued / stale / projected 状态反馈；不得被 skip、stage 或 drop；必须保留 keyed by raw transcript 的负信号召回审计。强制执行可能延迟到 projector / compiler 生成 stable view，这是本 ADR 接受的具名代价，但不是静默丢失。

ADR 0023 的 rules 注入模型修订为 Compiled Constraint View 注入。Rules 区不再是写时 source-of-truth active 文件集合，而是 compiled view 的呈现或兼容投影。

ADR 0024 的 INV-ACTIVE-CORRECTION 保留。用户自然提出“以后用 X”“忘掉那条”“这不是全局规则”等仍是核心信号通道。区别在于系统不要求用户审批，也不在实时路径做高影响 canonical mutation，而是把纠错追加为 evidence 并由 projector / compiler 消化。

ADR 0031 的可逆自治边界保留。Evidence Ledger 不能替代 `archived` 全文留盘的运行时复活通道；任何 demote 投影都必须保持 `archived` 可达。

ADR 0035 / 0036 的 search-time freshness 与 bounded-union 经验成为 Knowledge 异步化的前置证据基础，但不能用低准确度 fallback 继续写入长期记忆。`memory_search` 的 accuracy-contract 保留。

## 10. 迁移边界

迁移策略写入 `docs/roadmap.md`，本 ADR 只固定决策边界：canonical memory 是 append-only evidence 的投影；`agent_end` 不直接从 raw context 写 canonical；各消费面逐步迁移；过渡期旧 curator 只能作为 projector 消费 Evidence Event；逐投影面迁移必须有真实使用证据；禁止一次性重写全系统。

过渡态同步 projector 必须有审计和重新评估条件，避免长期退回旧写时裁决形态。README 和 roadmap 等指针文件在本 ADR ratify 后同步更新，不在 ADR 正文中承载实施流水。

## 11. 接受的代价与风险

后台 compiler 可能延迟，导致某些信号不能立即进入 stable view。Constraint 域接受 queued / stale；Knowledge 域通过同步 projector 或 bounded hot evidence overlay 保持 freshness。该代价换来写路径低风险、投影可重试和证据可审计。

Projector / compiler 仍可能错误合并、错误 scope、错误 demote 或错误解释冲突。接受该代价，因为错误发生在可重新生成或可修订的投影层，原始 evidence 和 `archived` 运行时复活通道保留，恢复成本低于直接修改 active memory。

Evidence Event 会增加存储增长。首期不引入自治物理删除；压缩、归档或共享 schema 工程化必须另行基于真实使用证据设计，且不得破坏 ADR 0031 的运行时复活通道。

Projector 重写可能增加跨设备 merge 面。接受该代价，但跨设备同步仍只使用确定性 git 合并；LLM 不自动解决 git 冲突，真冲突仍 abort 并给出 runbook。

Settings / Tool Contract 被判为 not-memory 后，相关配置或工具声明不会自动改变。接受该代价，因为它们的实际变更属于配置或代码流程，不能通过 memory rule 间接表达。系统必须提供可消费的 diagnostic。

## 12. 走偏信号

如果 queued event 长期不被投影，说明 projector 活性不成立，需要先修 drain-loop、调度或 stale-trigger，而不是恢复 raw context 写时裁决。

如果 settings / tool 信号继续出现在 global constraints 或 knowledge entries 中，说明域隔离失败，应修 router / projector prompt 与 not-memory diagnostic，而不是为每个工具或配置新增排除规则。

如果 project-specific 信号继续进入 global view，说明 scope 保守策略失败，应修 scope rubric 与 project binding 证据呈现，而不是新增项目名黑名单。

如果 projector 频繁生成大规模无解释重写，说明投影过度自信，应要求输出 conflict / uncertainty 区和来源 hash，而不是新增固定归档数量上限。

如果 Knowledge 异步化后 `memory_search` freshness、召回质量或延迟退化，说明异步迁移条件不成立，应保留同步 projector 或强化 bounded hot evidence overlay，而不是降低 `memory_search` accuracy-contract。

如果 `archived` 条目被投影重建过程丢弃，说明违反 ADR 0031，应立即回退该 projector 设计。

如果 Tier-1 指令进入 Evidence Event 后长期不可见或无 queued / stale / projected 状态反馈，说明 REQ-004 的“对用户可见”没有兑现，应修状态反馈和召回审计，而不是恢复 active rule 直写。

## 13. Deferred exploration

完整 Typed Belief Graph、Unified Evidence Graph lazy materialization、CCR（从近期原始转录即时重构情境认知模型）、统一全域 ledger / schema 工程化都保留为 deferred exploration。进入主线必须有成本、质量、真实使用证据，不作为当前 ADR 的首期交付。

## 14. 评审摘要

原 ADR 0039 的 Constraint-only 版本已经 4×T0 多轮审查并 accepted，但尚未实施。用户指出同类问题可能存在于整个第二大脑记忆系统，要求抛开现有 sediment 具体设计，由多个 T0 独立提出方案、交叉辩论，每轮都回答是否还有更好方案，并由 T0 全体一致后再定稿。

统一架构修订的评审记录见 [`2026-06-19-adr-0039-unified-evidence-architecture-t0-review.md`](../audits/2026-06-19-adr-0039-unified-evidence-architecture-t0-review.md)。本 ADR 仅保留影响决策有效性的摘要：讨论收敛到“统一写入纪律 + 域自适应投影器”，拒绝完整全域 event sourcing 数据库作为首期范围，保留 Knowledge 同步 projector 作为 freshness-preserving 迁移路径，并要求 Evidence Ledger 不替代 ADR 0031 的 `archived` 运行时复活通道。

## 15. 这份 ADR 不是什么

不是要求用户审批记忆写入；用户仍然不参与大脑管理。

不是让主会话写 memory；主会话仍然只读，sediment sidecar 是 dedicated writer。

不是把所有 memory 改成完整 event sourcing 数据库；首期只固定方向不变量和逐投影面迁移边界。

不是禁止 notify / audit；告诉用户 queued / stale / projected 状态是健康反馈，不是管理负担。

不是删除 AI 语义判断；语义判断从 raw `agent_end` 写时 mutation 移动到 projector / compiler。

不是把配置或工具声明藏进 memory；settings / tool 有自己的归宿，memory 只可记录 not-memory diagnostic / audit。
