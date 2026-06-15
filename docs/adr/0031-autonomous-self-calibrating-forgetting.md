---
doc_type: adr
status: proposed
---

# ADR 0031 — 完全自治的自我标定遗忘(可逆基座 + 复活率稳态)

> 本 ADR 深化 [ADR 0024 §5.6](./0024-second-brain-from-natural-conversation.md#56-自治归档--回滚窗口) / [ADR 0025 §4.6](./0025-sediment-meta-curator-subsystem.md#46-静默归档--回滚窗口)「自治归档 + 回滚窗口」与 roadmap 的 INV-R12 auto-demote 方向:把「遗忘」从被动 limbo + 人类可调策略,收敛为**人类设零策略、大脑全自治自标定、基座保证一切可撤销**。设计输入是 5×T0 跨厂商盲议(anthropic/claude-opus-4-8 · openai/gpt-5.5 · deepseek/deepseek-v4-pro · moonshotai/kimi-k2.6 · minimax/MiniMax-M3),证据摘要见 §4,完整记录见 git history / `docs/audits/`。实施与 instrumentation 埋点不在本 ADR 正文,见 [`docs/roadmap.md`](../roadmap.md)。

## 1. 背景:加法做了,减法缺位

abrain 至今是**只进不出**的积累系统。多向量(ADR 0036 P4)、dedup 分离、search-time auto-reconcile 都在**提召回质量(加法)**;但没有**遗忘(减法)**,corpus 必然单调膨胀 → 近重增多、陈旧堆积、噪声上升 → 召回质量回落,抵消加法侧的功。遗忘是 retrieval-quality 这条北极星缺失的互补杠杆。

现状有三个已确认的事实把方向逼到台面上:

- `archived` 今天是**被动 limbo + dense-blind**(向量索引只嵌 active,archived 只在 `status:[all]` 路径靠 sparse 词法可达);而 reactivation-reviewer **已经是 LLM 不是人**——「人审批 vs 自治」之争其实早已过去式。
- Lane G decay 当初是 **YAGNI 缓做**,理由是「没真实用量数据无法标定衰减」——不是「不该 decay」,是「还没数据」。
- 「freshness 当**检索期**信号」已被 ADR 0035 定为 anti-pattern:currency 是 **write-side** 的事 → 这背书「写侧主动衰减梯度」而非「读侧 decay 乘子」。

ADR 0024 强制隐形自治(INV-INVISIBILITY / INV-AUTONOMY:用户不参与大脑管理)。在此基础上,人类进一步明确表态:**连遗忘策略的 invariant 都不愿意设,要求大脑完全自治管理。**

## 2. 决策

人类设**零**遗忘策略。大脑**完全自治 + 自我标定**:忘什么、多快、保护谁、kind 权重、激进度——全部由大脑从自己的运行数据里自学、自调,人类不设、不调、不审。

唯一固定的不是一条**策略** invariant,而是一条**结构属性 / 可逆基座**——build 时焊死、人类永不触碰:**大脑的每一个自治遗忘动作,都必须能被大脑自己撤销。** 这不是「忘什么」的价值判断,而是让「完全自治」得以**安全**成立的边界条件;它像重力,是大脑站立的地面,不是人类持续 tend 的旋钮。

三条落地:

- **2.1 可逆基座(结构属性,人类不调)**:`archived` 是终点冷阁;即便发生物理 `git rm`,也必须留一个**大脑自己可 grep、可复活的 tombstone / 影子记录**(`slug` / `kind` / `content_hash` / `successor` / `digest` / `reactivation_hint`)。任何遗忘动作 → 大脑自身可撤回,不依赖人类去 `git revert`。
- **2.2 自我标定(无人类速率)**:大脑以 **resurrection rate(复活率)做稳态反馈**——衰减太狠 → 复活频繁 → 自动调慢;太松 → 噪声 / 近重上升 → 自动调快。衰减激进度、kind 权重、窗口长度全部自学,没有一个人类旋钮。这正好补上 Lane G 当年缺的那块标定数据。
- **2.3 最坏情况收敛**:在可逆基座下,LLM 哪怕系统性看走眼一条长尾,后果也只是「该条**待在冷阁、sparse 可达、可复活**,而非进 dense 热召回」——**优雅有界的退化,不是静默不可恢复的销毁**。

## 3. 为什么「完全自治」与「安全」不矛盾(核心论证)

面板最致命的共识是:**危险全在「不可逆」,不在「自治」**。所有**可逆**动作(降级 / 合并 / supersede / 重排 / 衰减打分 / 复活)本来就该 100% 自治,sediment 现在就是这么干的。唯一和安全打架的,是「不可逆地物理销毁长尾知识」这**一个**动作。把不可逆从系统里拿掉 → 完全自治**自动**安全,因为任何 LLM 误判的最坏后果都被收敛成「可恢复」。

关键区别在两类东西不能混:**策略**(忘什么 / 多快 / 保护谁 / kind 权重)= 全交大脑,人类不碰、不调、不审;**基座属性**(一切可撤销)= build 时焊死一次,人类永不碰、它也永不来烦人类——因为它的全部作用就是「让人类能彻底走开」。换句话说:人类把**整部宪法**委托给大脑,大脑唯一不能做的,是把自己的 undo 键投票删掉。这与「人类设 INV」完全不是一回事:后者是人类要持续 tend 的策略旋钮,前者是一次性的、自我保护的地面。

## 4. 设计输入:5×T0 盲议证据摘要(决策相关证据,非流水)

- **5/5 一致 repurpose `archived`**(非 keep、非 kill 进 `git rm`):git history 是**离线人类灾备层 ≠ 运行时认知控制层**;跑着的系统从不查 git log。`git rm` 后条目消失于工作树 → sediment 看不见它 → 把同一情况当全新条目重沉淀 → 振荡。故 `archived` 是 **runtime tombstone**(dedup 锚点 + 衰减元数据载体 + 复活面),`git rm` 替代不了。
- **5/5 推翻「遗忘成本 ≈ 重学成本」对长尾**:只对 `fact` / `smell` 成立;对 `anti-pattern` / `maxim` / `preference` / 跨上下文洞察系统性为假——重学 = 再付一次原始(常是事故)代价;**负知识**遗忘不只丢信息,是**主动诱发重犯**(棘轮失效)。
- **召回频率与长尾价值负相关**("灾备 runbook 从不查直到出事"):disuse ≠ irrelevant → 只能触发**重评估,绝不触发删除**;安全的降级驱动是**真值变化**(supersession / contradiction),不是访问稀疏。
- **不对称可逆性是治理原则**(opus 结晶):激进 demote、近零 auto-destroy。
- **致命风险**:`curator` / `reviewer` / `decay-scorer` 共享**关联化偏盲** → 长尾被**静默、不可观测、不可纠正**地缓慢抽空;且**结构护栏不可被影子验证替代**(稀有触发条目按定义不在最近 N query 的验证窗口里,恰恰测不到)。→ 本 ADR 的「可逆基座」正是对这条的直接回应:把不可逆拿掉,使「不可观测的灾难」从根上不存在,剩下的最坏只是「可恢复的冷阁滞留」。

## 5. 明确接受的代价

- **残余:关联偏盲可能让一条有价值条目长期滞留冷阁**(被降级、可恢复、但大脑因持续偏盲从不主动复活它)。接受理由:在可逆基座下,这被收敛为「冷但在、sparse 可达」的优雅退化,而非灾难性丢失;且 resurrection 稳态 + sparse / dedup 路径仍给它被重新激活的通道。
- **不追求「大脑一定把 kind 权重 / 激进度学对」**:安全**不依赖**大脑把策略学对,只依赖可逆性 → 即便策略暂时学偏,后果有界可恢复。这是用「结构」换取「无需人类校准策略」的核心取舍。
- **tombstone / 影子带来的小额存储 + 维护**:单用户 markdown + git 仓,成本 ≈ 0(面板共识:没有任何运营成本值得用不可逆销毁去买回)。

## 6. 提议的不变量(Proposed;accept 后入 `direction.md`)

本 ADR 提议新增一条**结构**不变量(本 ADR 不追状态,accept 后落 `direction.md`):

- **INV-REVERSIBLE-AUTONOMY(暂名)**:大脑对记忆生命周期**完全自治**(遗忘策略零人类参与);但其任何自治动作必须**大脑自身可撤销**——不存在「大脑能执行、却只有人类能撤销」的不可逆操作。物理回收若发生,必须保留大脑可复活的 tombstone。

与现有不变量的关系:深化 INV-INVISIBILITY / INV-AUTONOMY(连**策略 invariant** 都不再要求人类设),并把 roadmap 的 INV-R12 `auto-demote` 升格为更一般的「自治动作必须全可逆」原则。

## 7. Relates-to / 影响

- 深化 [ADR 0024 §5.6](./0024-second-brain-from-natural-conversation.md#56-自治归档--回滚窗口) / [ADR 0025 §4.6](./0025-sediment-meta-curator-subsystem.md#46-静默归档--回滚窗口) + roadmap `INV-R12 auto-demote` / `last_cited_at`。
- 承接 [ADR 0035](./0035-memory-stage1-embedding-candidate-retrieval.md):Lane G decay 当年因「无标定数据」deferred → 本 ADR 用 resurrection 稳态**自标定**;且 0035「freshness 非检索期信号」背书写侧衰减梯度。
- 互补 [ADR 0036](./0036-memory-search-two-stage-collapse-and-hybrid-retrieval.md):召回质量(加法)的**减法**侧。
- 实施阶段 + instrumentation 埋点 → [`docs/roadmap.md`](../roadmap.md)「ADR 0031 实施」(不在本 ADR 正文,遵 ADR 写作纪律)。
