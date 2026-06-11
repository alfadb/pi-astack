# ADR 0032 - Goal 续行运行时 + 声明式 Workflow 编排（实验通道）

- **状态**: **合议接受（2026-06-11）**；**部分条款被 [ADR 0033](0033-natural-language-first-invocation-and-doc-driven-goal.md) 修订（2026-06-11 合议接受）**：W1→W1'、W7→W7'、§5 晋升机检四条、 §6 三闸（闸 c 废除，结构承重转 ADR 0003）、§5-M4 backlog 关闭。读本 ADR 时以 0033 为准。3×T0（Claude Opus 4-8 / GPT-5.5 / DeepSeek v4-pro）一致 ACCEPT-with-required-changes，全部 required changes 已并入本版（§12 评审史）。
- **触发**: ①deep-research 调研（2026-06-10：Claude Code dynamic workflows / Codex `/goal` / token-saver-loop）确认"目标持持 + 有界自治续行 + 声明式多步编排"是本仓库能力缺口；②impl-plan O3 裁决：workflow 引擎**必须先 ADR 后实现**；③goal extension（P1a/P1b）已按计划先行落地 （PR-6 `3e4f5c1` / PR-7 `9ff57ef`，各经 3×T0 盲审收敛）——本 ADR Part A 将其运行时语义 **ratify 为规范**，Part B 为 workflow 引擎（PR-9/10）定边界与不变式。
- **依赖**: [ADR 0003](0003-main-session-read-only.md)（主会话只读）、 [ADR 0009](0009-multi-agent-as-base-capability.md)（dispatch 基座）、 [ADR 0024](0024-second-brain-from-natural-conversation.md)（四 invariant + AI-Native 原则）、 [ADR 0027](0027-coupled-stigmergic-dual-loop-agent-system.md) （C1'-C6 + H5 hub 假说 gate）、 [ADR 0028](0028-sediment-ground-truth-tiered-rearchitecture.md) （GTIER / provenance 结构源门）。
- **编号说明**: 0029/0030/0031 为预留话题号（0030 = evaluation harness，0031 = IDE/host 边界，见 ADR 0027 §6 与 ADR 0028 编号说明）。起草时确认 0032 为下一空号。
- **关键立场（H5）**: 本 ADR 的 workflow 是**静态声明式 DAG 编排**，不是 ADR 0027 H5 意义上的"hub 动态派工"。判别准则见 §6——这是实验通道不触 ADR 0030 gate 的论证核心；**生产化晋升 blocked on ADR 0030 evaluation harness**（机检定义见 §5）。

---

## 0. 起草说明

### 写什么
- Part A（§2-§4）：goal 运行时语义的规范化——已实现、已盲审，本 ADR 把 "为什么这样设计"固化为不变式，防后续 PR 无意识回退。
- Part B（§5-§9）：workflow 引擎的边界、DSL、执行映射、失败语义、自污染围栏——**实现前规范**，PR-9/10 据此落地。
- 不变量清单 W1-W13 + 检验矩阵（§10）——规范性核心。

### 不写什么
- ADR 0024 四 invariant / ADR 0027 C1'-C6 的论证（引用，不重复）。
- goal/workflow 的 TypeScript 类型细节（实现层；本 ADR 只定边界）。
- "sediment 观察 workflow trace 自动沉淀 workflow"——显式推迟到独立后续 ADR（§9 自污染围栏只定禁止面）。
- hub 动态派工本体——属 ADR 0027 H5 悬置假说，由 ADR 0030 gate。

---

## 1. 一句话总纲

> **自治的形状必须是"用户授权的、有界的、可见的"。** goal 给单会话一个用户声明的目标与预算盒子（认知层只判"继续/完成/卡住"，结构层握所有否决权）；workflow 给多步任务一个执行前固定的声明式 DAG（引擎零拓扑自由度）。两者共同的反面是 hub 动态派工——LLM 在运行时自主决定"接下来 spawn 什么"——那条路被 ADR 0027 H5 悬置，唯一入口是 ADR 0030 的 evaluation harness。

---

## Part A — goal 续行运行时（ratify PR-6/7）

## 2. 授权与状态模型

- **C4' 授权**：goal 仅由用户 `/goal set` 创建。不存在任何自治路径创建或复活 goal；`set` 在任意状态下都是新的用户授权（可替换旧 goal）。
- **双层状态**：`pi-goal-event` 自定义条目为**事件源**（随 session 树 fork，是唯一真相）；`.pi-astack/goal/<sessionId>.json` 为**物化视图** （注入用快路径）。写序 **event-first**；session_start 用 `getBranch()`（root→leaf path，**绝不用全树 getEntries**）replay 调和：branch 有事件 → 无条件覆写视图；branch 无事件 → 删除视图（events-as-truth 收敛——/tree 切到 pre-goal 分支点必须停止注入旧 goal）。
- **状态机**：`active ⇄ paused → abandoned`；`achieved` 为 judge 专属终态。终态不可复活（只能 fresh set）。
- **每 turn 注入**（compaction drift 对治）：active goal 以 marker 包裹块追加在 system prompt **尾部**（prompt-cache 前缀安全）；非 active 主动 strip 残块；子代理跳过（不 shadow dispatch task brief）；注入文本经 sanitize（marker 碰撞中和 + control/bidi 滤除）+ 硬长度上限。

## 3. auto-continue 双层架构

**结构层（确定性代码，握全部否决权）**：
1. 预算检查（墙钟 + 续行次数）先于任何 LLM 花费；耗尽 → `paused` + outcome row + notify，不烧 judge。
2. continue 裁决 → 计数器**预减**走 event-first：续行事件**成功追加到事件源**且视图持久化**成功**才 send；任一持久化失败 → 不 send。理由（合议 RC）：事件源是唯一真相——若预减只进了视图而没进事件源，下次 reconcile 会回滚计数器，预算可跨重启重花，有界性破。续行 turn 重入 agent_end 是设计内循环，有界性由预减保证，不靠 in-flight guard。
3. judge 传输/解析失败 → fail-closed：不 send、不改状态、notify。
4. blocked → `paused` + notify（**tell-not-ask**：bg hook 永不弹 modal——impl-plan 原文"blocker→prompt_user"被此裁量修正，3×T0 UPHOLD）。

**认知层（快档 LLM judge，零否决权）**：
- 封闭裁决空间 `{achieved, blocked, continue}`；C6 严格 parse（失败→ null，禁 retry-fix-JSON）。judge 输出空间**不含任何 spawn/拓扑原语**；`next_step` 是无界自由文本但只能成为下一条续行消息的内容——主会话是独立的 C4' 权威，它读到 next_step 后的任何 dispatch 都是主会话自身的 L2 路径，不是 judge 的派工（见 §6 推论）。
- prompt 防操纵框架：transcript 为 DATA；assistant 声称"done"≠已验证证据；上轮续行消息在 judge 窗口标 `[goal-continuation (machine)]` （防自确认回声闭环）；`</transcript>` 转义。
- 误判代价不对称已编码为 bias：宁 continue 勿误 achieved（continue 烧预算可见，achieved 静默弃 goal）；同错重复 → blocked。

## 4. provenance 隔离（INV-IMPLICIT-GROUND-TRUTH 防线）续行消息以 user role 注入但内容是机器组装的——若被 sediment 判为 user-expressed，goal 循环就成了"assistant 文本洗白进 Tier-1 规则"的通道。双层防线：

- **transcript 层（主防线）**：消息带 `[pi-goal-continuation goal_id=...]` 机器前缀（`_shared/ goal-continuation.ts` 为生产者/消费者共享契约模块，防漂移）。sediment `deriveProvenance` 把带前缀的 user-role turn 确定性计入 assistant 桶；`userTextForDirectiveRecall` 同面跳过（防假 recall flag）。**load-bearing 事实**：窗口构建器对 user turn 是 head-preserving 截断，前缀必存活——已由 smoke 钉死截断方向 （smoke-goal-autocontinue "W5 load-bearing fact" check）；任何改变此截断方向的 PR 都会被该 smoke 拦截。伪造前缀的唯一效果是 demote 伪造者自己的指令（fail-closed 方向）。
- **事件层（辅助）**：send 前写专用 `pi-goal-continuation` intent ledger entry（goal_id/message_hash/counter）供交叉核对；`sendUserMessage` 必须带 `{deliverAs:"followUp"}`（运行时契约）。

**作用域注记（合议 M3）**：当前系统**只有 goal-continuation 一条**机器 user-role 路径。任何新增"机器文本以 user role 进 transcript"的路径，必须自带 provenance 隔离方案（共享契约前缀或等价机制）并经 ADR 评审—— W5 不自动覆盖未来路径。

**R4'**：终态（achieved/blocked/budget 耗尽/abandoned）写 goal-owned `.pi-astack/goal/outcome-ledger.jsonl`。**不写 sediment 的 outcome-ledger.jsonl**（外来 row 破坏其 OutcomeRow schema/dedupe 契约）；未来 aggregator feed 只读此文件，永不反向。

---

## Part B — workflow 引擎（PR-9/10 规范）

## 5. 两级通道与晋升机检定义

- **v1 = 实验通道**：`workflow.enabled` default **off**；`workflow.readOnly` default **true**（全部 stage 限 read-only tool 集）。mutating stage 需要三重显式：用户在 DSL 里 per-stage 声明 `mutating: true` + settings 开 `workflow.readOnly=false` + `PI_MULTI_AGENT_ALLOW_MUTATING=1`，且 mutating 工作只能发生在 dispatch 出的 sub-agent 内（ADR 0003：主会话只读不破）。 **弱点注记（合议 M4）**：三重中 env var 是进程级全局、settings 是全 workflow 级，最细粒度的一重是 DSL 的 per-stage 声明——v2 加固方向是把授权粒度收到 per-workflow-run（启动时交互确认）。
- **晋升的机检定义（合议 RC）**——以下任一变更即构成"生产化晋升"， **前置条件 = ADR 0030 Accepted + harness 报告（成功率/成本/越界事件）
  + 评审 PR**：
  1. 翻 `workflow.enabled` 或 `workflow.readOnly` 默认值；
  2. 默认暴露 mutating workflow（弱化三重显式中的任一重）；
  3. 任何后台/主路径**自动**调用 workflow（无用户显式 invoke）；
  4. 移除实验标记或 dry-run 前置。 **实验通道用量增长本身不构成晋升，也不能单独翻任何 gate。**

## 6. H5 论证（本 ADR 不触 ADR 0030 gate 的判别准则）ADR 0027 H5 悬置的是"hub 动态派工"：LLM 在**运行时**自主决定 spawn 什么、多少、何时停。本 ADR 的 workflow 与之有三条判别线：

| 判别轴 | 声明式 DAG（本 ADR） | hub 动态派工（H5，被 gate） |
|---|---|---|
| 声明图确定时点 | **执行前固定**（dry-run 校验的持久化 JSON） | 运行时由 LLM 生成 |
| 拓扑权威 | 用户（机检闸门见下） | LLM 输出 |
| 引擎自由度 | **零**——只能执行/重试/降级/中止既有 stage，不能增删改 stage/边 | 增删 stage、改依赖、递归 spawn |

**精确化（合议 RC2）**：axis-1 固定的是**声明图**（含 on_fail 策略）。实际**执行子集**可被声明的确定性失败策略**裁剪**（degrade/abort 跳过下游），但引擎从不新增 stage/边。数据流 ≠ 拓扑：上游 stage 的 LLM 输出可影响下游 stage 的**内容**（path+摘要回传），永不改变 stage 集合与依赖——只有 stage/边的增删改才落 H5。

**"用户为权威"的机检闸门（合议 RC3）**——执行前置三条，缺一不可：(a) 拓扑为**持久化 artifact**（磁盘上的 JSON 文件，非内存即兴）；(b) `dry-run` 校验结果**呈现给用户**（stage 清单/DAG/并发预估可见）；(c) 用户**显式 invoke**（命令行/命令，无自动触发）。agent 起草 workflow JSON 合法，但未经 (a)(b)(c) 三闸不可执行。

**stage 内 dispatch 禁令（合议 M1，H5 软肋闭合）**：三判别线约束的是 **引擎**，不约束 stage 内的 LLM——若 stage 的 tools 含 dispatch 工具，该 stage 就成了事实上的 hub（单 stage DSL + dispatch_agent 工具 = 名义满足三线、实质动态派工）。因此：**stage `tools` 一律禁止 `dispatch_agent` / `dispatch_parallel` 及任何 spawn 类工具；dry-run 对此硬拒绝（非 warning）**。解禁此项 = 触 H5 = 走 ADR 0030。

**声明式路由的合法性（合议 M2）**：DSL 的 `prompt` 字段是 LLM 可读指令，上游 prompt 可按运行时条件路由下游 stage 的**行为**（"if X then path A else path B"）。此模式为**声明式路由**——拓扑硬顶、无递归 spawn、路由逻辑写在用户可审计的 prompt 里而非 LLM 自主发明——属实验通道合法表达力，不是 H5 派工。

**goal 推论**：goal auto-continue 不触 H5——线性、预算有界、无 spawn；judge 输出空间封闭且无拓扑原语；主会话是独立 C4' 权威（§3）。任何给 workflow 引擎或 goal judge 增加运行时拓扑操作的提案自动落入 H5 → 走 ADR 0030。

## 7. DSL（O4 裁决：JSON）

- 格式 = **JSON Schema 约束的 JSON**。否决 YAML（agent 生成缩进易错）与沙箱 JS（任意代码执行面，破 C3' infra-structured：编排骨架必须是结构化数据，不是图灵完备程序）。
- 形状（规范层，字段名实现 PR 可微调但语义不可）：`{schema_version, name, timeout_minutes, stages: [{id, kind: "agent"|"parallel", model?, thinking?, prompt, tools?, mutating?, needs?: [id], on_fail: "retry"|"degrade"|"abort", max_retries?, children?: [stage]}]}`。
- **v1 边界钉死（合议 RC）**：
  - `schema_version` v1 取值恒为 `1`；未知版本 → dry-run 拒绝。
  - stage `id` 全局唯一（含 parallel children）；`needs` 只能引用顶层 stage id。
  - `parallel.children` 仅允许 kind=agent；children 无 `needs`、不可嵌套 parallel、不可被外部 `needs` 引用——parallel stage 对 DAG 是一个聚合节点。
  - `tools`：白名单校验。`workflow.readOnly=true` 时 DSL 含 mutating 工具 → dry-run **失败**（绝不静默剥离）；未知工具名 → 拒绝；dispatch 类工具 → 无条件拒绝（§6）。
  - `on_fail:"degrade"` 下游语义：degraded **满足** `needs`（下游照常启动），但下游收到结构化标记 `{upstream_status:"degraded"}` 且 degraded stage 仍必须产出其 output path（可为部分结果 + 失败说明）；产不出 path → 按 failed 处理，不算 degraded。degraded 永不静默——最终 workflow 结果必须汇总 degraded 清单。
- `workflow dry-run <file>`：schema 校验 + DAG 无环 + needs 引用存在 + 上述全部边界 + 预估并发 ≤ cap，全过才可执行；结果呈现给用户（§6 闸门 (b)）。校验是确定性代码，不是 LLM。

## 8. 执行映射与失败语义

- stage kind=agent → dispatch 的 in-process 执行路径；kind=parallel → dispatch_parallel 语义。**API 边界注记（合议 RC）**：dispatch 的 `runInProcess` 当前是模块私有函数——PR-10 必须先把它抽成共享导出 API（或经注册的 tool contract 调用），不得复制实现；嵌套 dispatch 拒绝与 heartbeat 语义随该 API 继承。
- **全局并发 cap（合议 RC4，新 W12）**：dispatch_parallel 的 4 并发 cap 是**单次调用内**的；workflow 引擎可能并发推进多个无依赖 stage——引擎必须对**整个 workflow run** 维持全局信号量 ≤ 同一 MAX_CONCURRENCY，dry-run 预估只是前置检查，runtime 也必须 enforce。 "嵌套拒绝 + 全局 cap 不击穿"为 smoke-locked 不变量。
- 每 stage：C6 锚点（经 `deriveSubAgentAnchor`，subtask_seq 由引擎分配）+ C5 四态（completed/failed/degraded/cancelled）+ heartbeat （`_shared/heartbeat`，静默死亡必须被上层兜底）——继承 ADR 0027 L2 blocking 不变量（新 W13）。
- stage 间数据契约：下游 stage 启动前校验上游 output path 存在性（确定性检查）；整体 timeout guard。
- 中间结果写 `.pi-astack/workflow/<anchor>/stage-<id>.md`（经 P0.6b per-key 写锁，与 abrain git 锁域正交），stage 间只回传 **path + 摘要**（context 节流）。trace 文件带人类可读 markdown 头（dogfood 人工审计用，合议意见）。
- **失败策略 = 确定性路由（合议 RC1，新 W11）**：驱动 `on_fail` 分支的 stage 终态分类**只能来自确定性信号**——dispatch terminal state/abort 码、output path 存在性、schema 校验结果——**不得由 LLM 裁决**（stage agent 自报或 judge 式 LLM 选择 on_fail 分支 = 运行时选择执行子图 = 软拓扑，破 W7/W8）。四向映射：通过=completed；同级重试=retry（≤max_retries，structured 计数）；降级=degraded（§7 语义）；人工=cancelled + **prompt_user**（workflow 是用户在场会话中 LLM 启动的前台流程（ADR 0033 修订措辞），与 goal 的 bg hook 不同 ——这里弹结构化提问合法）。
- **resume 前向兼容**：v1 不实现 resume，但 per-stage completion **必须落盘**（state layout 预留 resume 不破 schema）——stage 失败后修复再续是核心场景，不能锁死。

## 9. 保存与自污染围栏

- workflow 定义保存**仅用户显式触发**（`writeAbrainWorkflow` 入 abrain workflows zone）。引擎/judge/sediment 都不自动保存 workflow。
- **自污染围栏**（opus A8）：workflow 执行 trace 一律 assistant-observed，默认不进 Tier-1 注入面；"sediment 观察 trace 自动沉淀 workflow"推迟独立 ADR——理由与 goal 的 provenance 隔离同构：自治系统的输出不得未经人手回流成自治系统的规则。
- **P3 成本分层**：stage model 缺省策略可接 model-curator 注解（检索/ 执行=便宜档，裁决/综合=T0），**advisory-only**：不改 T0 盲审 cost-blind 原则，低价模型永不用于最终 correctness 裁决。

---

## 10. 不变量清单 + 检验矩阵（规范性核心）

| # | 不变量 | 来源 | 检验机制（机制 / smoke / owner） |
|---|---|---|---|
| W1 | goal 仅由用户创建；终态不可自治复活 | C4' | code：唯一构造点在 /goal set handler；smoke-goal-state 状态机 checks |
| W2 | 事件源唯一真相；视图可重建可删除；replay 只看当前 branch | PR-6 盲审 ×2 BLOCKING | smoke-goal-state replay/removeGoalFile checks；getBranch 用法靠 review（薄弱点已知） |
| W3 | 预算检查先于 LLM 花费；预减须**进事件源+视图**成功才 send | 有界自治 | smoke-goal-autocontinue：bounded-chain / event-append-fail / persist-fail 三 check |
| W4 | 认知层（judge）零结构否决权；解析失败=不行动 | C6 / ADR 0024 §3 | smoke-goal-autocontinue judge-fail check + parse 闭合空间 check |
| W5 | 机器 user-role 消息带共享契约前缀且 sediment 确定性 demote；新机器 user-role 路径需自带隔离方案过 ADR | INV-IMPLICIT-GROUND-TRUTH | smoke-derive-provenance 5f/5g + smoke-goal-autocontinue head-preserving 截断锁 |
| W6 | bg hook 只 tell 不 ask；前台 workflow 失败可 prompt_user | tell-not-ask | code review（行为型）|
| W7 | 声明图执行前固定（持久化 artifact + dry-run 呈现 + 显式 invoke）；引擎零拓扑自由度；执行子集仅被声明策略裁剪 | H5 判别 | PR-9 dry-run smoke：拓扑校验 + 三闸；引擎无 stage-mutation API（review）|
| W8 | 运行时拓扑操作（动态 spawn/增删 stage/解禁 stage 内 dispatch）一律走 ADR 0030 | H5 gate | PR-9 dry-run smoke：dispatch 工具硬拒绝 |
| W9 | mutating stage 三重显式（DSL per-stage + settings + env）+ 仅 sub-agent 内 | ADR 0003 | PR-9/10 smoke：readOnly 下 mutating 工具 dry-run 失败；三门逐一缺省拒绝 |
| W10 | 自治产物（trace/续行文本/judge 输出）不得未经人手回流 Tier-1 | 自污染围栏 | smoke-derive-provenance 前缀 demote；trace assistant-observed（PR-10 smoke）|
| W11 | on_fail 路由的 stage 终态分类确定性，无 LLM 否决权 | 合议 RC1 | PR-10 smoke：终态来源枚举（terminal state/path/schema）|
| W12 | workflow run 全局并发 ≤ MAX_CONCURRENCY；嵌套 dispatch 拒绝 | 合议 RC4 | PR-10 smoke：双 parallel stage 并发计数 |
| W13 | 每 stage C5 四态 + C6 锚点（deriveSubAgentAnchor）+ heartbeat | ADR 0027 L2 | PR-10 smoke：stage 元数据断言 |

## 11. 接受的代价与走偏信号

**接受的代价**：
- send fire-and-forget 不可同步观测（intent ledger + 预算先烧 = 保守方向）；resume 不 rebase 墙钟（预警已加，fresh set 重置）；judge 回声可能加速预算耗尽（budget 硬停兜底）；goal outcome ledger 暂无读侧 （未来 aggregator feed）。
- workflow v1 无 resume、无动态拓扑、readOnly 默认——表达力换安全边界。

**走偏信号（任一出现 → 回看本 ADR；标注当前检测方式，合议 M5）**：
1. 窗口构建器改成非 head-preserving 截断（W5 主防线失效）——**已有 smoke 自动拦截**（smoke-goal-autocontinue）。
2. 出现绕过 `/goal set` 的 goal 创建路径，或 judge 输出空间扩张—— code review + grep（半自动）。
3. workflow 引擎出现任何运行时拓扑修改入口（W7/W8 破）——PR-9 dry-run smoke 覆盖工具面；API 面靠 review。
4. dogfood 中 goal 反复在 budget 硬停才结束（judge 回声未被 framing 压住）——**当前无自动化检测**：需待 aggregator feed 读取 outcome-ledger.jsonl（§4 显式推迟项），在此之前靠人工查 ledger。
5. tier1_jaccard_shadow / recall flag 显示续行文本泄入 Tier-1 路径—— audit.jsonl 数据存在，分析靠人工 grep（半自动）。

## 12. 落地映射与评审史

- Part A：已落地（PR-6 `3e4f5c1`、PR-7 `9ff57ef`），本 ADR ratify。合议要求的 W3 实现加固（事件源 append 失败 → 不 send）随本 ADR 同 commit 落地。
- Part B：PR-9（DSL + parser + dry-run + smoke）→ PR-10（执行器 + C5/C6/heartbeat 集成 + P0.6b per-key 锁 + P3 成本策略 + dispatch 共享 runner API 抽取）。PR-9 开工前置条件 = 本 ADR 合议接受（已满足）。
- **评审史（2026-06-11，3×T0 各 1 轮）**：
  - Claude Opus 4-8：ACCEPT-with-required-changes（RC1 on_fail 确定性→W11；RC2 声明图/执行子集精确化+数据流≠拓扑；RC3 用户权威三闸 →W7 机检化；RC4 全局并发 cap→W12；RC5 L2 不变量入清单→W13；RC6 评审史回填）。核验 Part A 与代码零偏离、head-preserving 截断为真、嵌套 dispatch 实际被拒。
  - GPT-5.5：ACCEPT-with-required-changes（晋升机检定义→§5；DSL v1 边界钉死→§7；degrade 下游语义→§7；tools×readOnly 交互→§7；runInProcess 私有 API 注记→§8；全局并发闸→§8/W12；W3 实现不一致 →代码修复+smoke；W 检验矩阵→§10）。
  - DeepSeek v4-pro：ACCEPT-with-required-changes（M1 stage 内 dispatch 工具硬拒绝——H5 软肋构造性击穿后闭合；M2 声明式路由合法性显式化；M3 W5 作用域注记；M4 三重显式弱点标注；M5 走偏信号检测方式诚实标注）。W1-W10 逐条绕过路径枚举：除上述外无绕过。
  - 全部 required changes 已并入本版；无保留意见悬置。
