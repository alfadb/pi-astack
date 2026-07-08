---
doc_type: adr
status: accepted
---

# ADR 0031 — 完全自治的自我标定遗忘(可逆基座 + 复活率稳态)

> 本 ADR 深化 [ADR 0024 §5.6](./0024-second-brain-from-natural-conversation.md#56-自治归档--回滚窗口) / [ADR 0025 §4.6](./0025-sediment-meta-curator-subsystem.md#46-静默归档--回滚窗口)（已归档至 abrain）「自治归档 + 回滚窗口」与 roadmap 的 INV-R12 auto-demote 方向:把「遗忘」从被动滞留 + 人类可调策略,收敛为**人类设零可调策略、大脑全自治自标定、一条不可调结构下限(可逆基座)作为回退保障**。设计输入是 5×T0 跨厂商盲评(设计) + 3×T0 文本盲审(R2)两轮(模型清单与完整记录见 git history / `docs/audits/`),证据摘要见 §4。实施与 instrumentation 埋点见 [`docs/roadmap.md`](../roadmap.md),不在本 ADR 正文。

## 1. 背景:只做了新增,缺少删减

abrain 至今是**只进不出**的积累系统。多向量(ADR 0036 P4)、dedup 分离、search-time auto-reconcile 都在**提升召回质量(属于新增侧)**;但没有**遗忘(删减侧)**,corpus 必然单调膨胀 → 近重增多、陈旧堆积、噪声上升 → 召回质量回落,抵消新增侧的收益。遗忘是召回质量这一核心目标缺失的互补机制。

现状有三个已确认的事实(当前实现真相以 [`current-state.md`](../current-state.md) / 代码为准)使该方向成为必须处理的问题:

- `archived` 今天是被动滞留 + dense 不可见(向量索引只嵌 active,archived 只在 `status:[all]` 路径靠 sparse 词法可达);reactivation-reviewer 已是 LLM——「人审批 vs 自治」之争已不再成立。
- Lane G decay 当初是 YAGNI 暂缓实现,理由是「没真实用量数据无法标定衰减」——不是「不该 decay」,是「还没数据」。
- 「freshness 当**检索期**信号」已被 ADR 0035 定为 anti-pattern:currency 是 write-side 的事 → 支持「写侧主动衰减梯度」而非「读侧 decay 乘子」。

ADR 0024 强制隐形自治(INV-INVISIBILITY / INV-AUTONOMY)。在此基础上,人类进一步明确:**连遗忘策略的可调参数都不愿设,要求大脑完全自治管理。**

## 2. 决策

人类设**零可调策略**:忘什么、多快、保护谁、kind 权重、衰减强度——全部由大脑从自己的运行数据里自学、自调,人类不设、不调、不审。

人类只固定**一条不可调的结构下限**(非策略、非可调参数,build 时一次性,人类不维护):**大脑的每一个自治遗忘动作都必须有界可逆——被遗忘的内容必须留有一条运行时可达、不依赖人类、也不依赖「大脑恰好主动想起」的复活通道。** 它是让「完全自治」**安全**成立的边界条件,属于运行环境的固有约束,而非可调项。注意措辞:这是「零**可调**策略 + 一条**不可调**结构下限」,不是字面的「零约束 / 自动安全」。

三条落地:

- **2.1 可逆基座 = `archived` 终态下限(本 ADR 范围内无自治物理销毁)**:自治遗忘的终点是 `archived`,**不是 `deleted`**。archived 条目**全文留在工作树**,本身就是耐久的 runtime tombstone(dedup 可见、sparse 词法可达、复活只需变更 `status`)——不存在「降级后内容丢失」,也就没有 digest 保真度问题。**大脑不做自治物理删除(`git rm`)**;物理回收若将来确有必要,另起 supersession-gated 专门设计(需独立论证 tombstone 存储位置/持久性/灾备),不在本 ADR 授权范围。下限之上,唯一的自治动作是 demote,而 demote 的内容完整原位保留。**人类不手动编辑或恢复 abrain 条目(也不会 `git revert`)** → 大脑没有任何人类回退保障,复活 100% 自治;这正是 archived 终态下限**必须**存在(而非可选)的根本理由——不是「优于 git」,而是「人类不介入,除它之外没有其他可逆面」。
- **2.2 自我标定(无人类速率)+ 已知盲区(显式披露)**:大脑以 resurrection rate 做反馈——噪声 / 近重上升(可观测)→ 衰减过弱 → 自动调强。**但必须披露非对称盲区**:「衰减过强」方向对 §4 的**关联偏盲类无独立报警信号**——同一偏盲既驱动误降级、又压制复活,低复活率会被误读成「正常」。故**安全不依赖这条反馈回路收敛,只依赖 §2.1 的可逆下限**;反馈回路只标定可观测方向。偏盲类的回退保障是**非自治 secondary channel**:archived 仍 sparse 可达 + 用户自然纠错(INV-ACTIVE-CORRECTION)可随时触发复活——不依赖大脑「主动想起」。

**2026-07-08 修订注记**:反失控结构地板均为 build-time 焊死,不是 settings 可调策略;其中 per-batch 上限 `demoteMaxBatch` 属于不可回填 settings 的结构地板。`resurrectionBackoffRate` 当前只允许作为 interim const 存在,Phase 2 应迁入大脑自管 state 并由运行数据自标定,禁止回填 settings。settings 只保留 4 个 boolean kill-switch: `instrumentation` / `decayShadow` / `demoteShadow` / `autoDemote`。

- **2.3 最坏情况(有界,非消除)**:在下限之上,LLM 即便系统性误判一类长尾,后果也收敛为「该类**留在归档冷存储、全文在盘、sparse + 纠错可达**,而非进入 dense 在线召回」——**有界、可诊断、可恢复的可用性退化**(残余代价见 §5),不是静默不可恢复的销毁。

## 3. 为什么「完全自治」与「安全」不矛盾(核心论证 + 边界)

面板共识:**风险来自「不可逆」而非「自治」**。所有可逆动作(降级 / 合并 / supersede / 重排 / 衰减打分 / 复活)理应 100% 自治。把**不可逆物理销毁**移出自治授权(§2.1 下限)→ 任何 LLM 误判的最坏后果都被收敛成「可恢复」,于是完全自治在该边界内安全。

**但要如实标定这条论证的边界,不夸大成「灾难从根上不存在」**:可逆性能覆盖「会被再次检索」的常见类;对「故障发生时才需要、平时从不召回」的稀有长尾,叠加 §4 的关联偏盲,「物理可逆但大脑永不主动复活」在**事实上趋近不可达**。所以可逆基座的真实作用是:把最坏后果从「不可观测的灾难性销毁」**降级为有界、可诊断、可恢复的可用性退化(缓解,非消除)**;稀有类的残余风险靠 §2.2 的非自治 secondary channel 保障,并列入 §5 代价与走偏信号监控。

关键区别仍成立:**可调策略**(忘什么 / 多快 / 保护谁 / kind 权重)= 全部委托大脑,人类不介入;**不可调结构下限**(有界可逆)= build 时一次性固定,人类不维护。人类把全部治理规则委托给大脑,大脑唯一不能做的,是通过自治决策移除自身的可撤销能力——这是对动作空间的一条硬约束,不是一个待调的策略参数。

## 4. 设计输入:T0 盲评 / 盲审证据摘要(决策相关结论,完整记录见 git history / `docs/audits/`)

- **5/5 一致 repurpose `archived`**(非保留、非删除进 `git rm`):git history 是离线人类灾备层 ≠ 运行时认知控制层;`git rm` 后条目消失于工作树 → sediment 无法感知 → 重沉淀 → 振荡。故 `archived` 是 `git rm` 替代不了的 runtime tombstone。
- **5/5 推翻「遗忘成本 ≈ 重学成本」对长尾**:只对 `fact` / `smell` 成立;对 `anti-pattern` / `maxim` / `preference` / 跨上下文为假——重学 = 再付一次原始(常是事故)代价;负知识遗忘**主动诱发重犯**(棘轮失效)。
- **召回频率与长尾价值负相关**(类比论证:「灾备 runbook 平时从不访问,直到故障发生」):disuse ≠ irrelevant → 触发**重评估非删除**;安全的降级驱动是**真值变化**(supersession / contradiction)非访问稀疏。
- **不对称可逆性是治理原则**:积极 demote、零自治 destroy。
- **致命风险**:curator / reviewer / decay-scorer 共享**关联偏盲** → 长尾**静默、不可观测、不可纠正**地缓慢流失;**结构护栏不可被影子验证替代**(稀有触发条目按定义不在验证窗口里)。→ §2.1 下限 + §2.2 secondary channel 是对这条的直接回应。
- **3×T0 文本盲审(R2)收敛**:三家(opus-4-8 / gpt-5.5 / deepseek-v4-pro)一致 `GO-WITH-REVISIONS`,无 `NO-GO`。核心修订 = 如实降级「自动安全 / 一切可撤销」claim、披露复活率非对称盲区、令 archived 为不可降下限以消除自治物理删除的保真度问题、补全 §5 残余代价。本版已并入。

## 5. 明确接受的残余代价 + 走偏信号

- **关联偏盲可致整类长尾系统性滞留归档冷存储**(技术可逆、事实趋近不可达,因大脑同源偏盲既降级又不复活)。缓解:非自治 secondary channel(sparse + 用户纠错);**不**依赖大脑自治复活。
- **secondary channel 对中文长尾本身偏弱**:archived 仅 sparse 可达,而 BM25 / sparse 对中文语义召回弱(ADR 0035 / 0036 已记)——恰是高风险类。这是**已知的、被接受的保障不完美**,非被忽略。
- **resurrection rate 无法证明长尾无损**:只标定可观测方向,对偏盲类无法识别;安全靠下限不靠该指标收敛。
- **`archived` 在磁盘单调堆积**:§1 的「膨胀」只在**检索层**(dense 不嵌 archived)解决,**存储层**未解;本 ADR 有意不引入自治物理回收(见 §2.1),接受存储单调增长作为安全换取的代价。
- **不追求「大脑一定把 kind 权重学对」**:安全不依赖策略学对,只依赖下限可逆;策略暂时学偏 → 后果有界可恢复。
- **走偏信号(需监控,非自治闸)**:归档冷存储条目按 `kind` / 领域分布严重不均、resurrection rate 长期趋零同时 corpus 持续膨胀、用户纠错触发的复活率上升、`archived` 规模膨胀反噬 sparse 保障命中率(保障通道质量随规模退化)——任一出现即提示衰减策略偏盲,需回看本 ADR 基线。

## 6. 不变量(已随本 ADR accept 落 `direction.md`)

本 ADR 新增一条**结构**不变量(canonical 文本在 `direction.md`,此处为 rationale 摘要):

- **INV-REVERSIBLE-AUTONOMY(暂名)**:大脑对记忆生命周期**完全自治**(遗忘策略零人类可调参数);但其任何自治遗忘动作必须**有界可逆**。可测试条款:(a) **无自治物理删除**——自治遗忘终点是 `archived`(全文留盘),`git rm` 不在自治授权内;(b) 被降级条目必须存在**至少一条运行时可达的复活通道**,且该通道**不依赖任何人类手动介入(人类不手动编辑条目、也不 `git revert` abrain 条目)、也不依赖大脑恰好主动想起**(当前满足者:sparse 召回 + 用户纠错触发);(c) 若将来引入任何物理回收,必须先满足 (b) 的保真度——复活须恢复到与遗忘前**检索等价**的状态,`digest`-only 的有损复活必须作为具名代价显式接受。

与现有不变量的关系:深化 INV-INVISIBILITY / INV-AUTONOMY(连**可调策略**都不再要求人类设),把 roadmap 的 INV-R12 `auto-demote` 升格为「自治动作必须有界可逆」一般原则,并与 INV-ACTIVE-CORRECTION 衔接(用户纠错是复活通道之一)。

## 7. Relates-to / 影响

- 深化 [ADR 0024 §5.6](./0024-second-brain-from-natural-conversation.md#56-自治归档--回滚窗口) / [ADR 0025 §4.6](./0025-sediment-meta-curator-subsystem.md#46-静默归档--回滚窗口)（已归档至 abrain） + roadmap `INV-R12 auto-demote` / `last_cited_at`。
- 承接 [ADR 0035](./0035-memory-stage1-embedding-candidate-retrieval.md):Lane G decay 当年因「无标定数据」deferred → 本 ADR 用 resurrection 稳态自标定 + Phase 0 埋点补数据;且 0035「freshness 非检索期信号」支持写侧衰减。**注意**:0035 dense 索引只嵌 active → archived 仅 sparse 可达,复活通道宽度受 sparse 召回质量约束(中文偏弱)——见 §5。
- 互补 [ADR 0036](./0036-memory-search-two-stage-collapse-and-hybrid-retrieval.md):召回质量(新增侧)的**删减**侧。
- 实施阶段 + instrumentation 埋点 → [`docs/roadmap.md`](../roadmap.md)「ADR 0031 实施」。
