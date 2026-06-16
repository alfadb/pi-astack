---
doc_type: adr
status: accepted
---

# ADR 0030 — L2 Hub Baseline + Evaluation Harness

- **状态**：**Accepted (baseline，2026-06-16)**。经三轮跨 provider T0 设计盲议（Claude Opus 4-8 / GPT-5.5 / DeepSeek v4-pro / MiniMax-M3，逐轮记录于 git history）+ owner 签字收敛。本 ADR 为 baseline：caged-live hub 以默认关闭 flag 进入单用户 dogfood 已 owner-ratified；**翻默认开（默认 on）须由在线评估器数据 ratify**（见 §8）。ADR-text 形式审计折叠进 dogfood 阶段。
- **依赖**：[ADR 0027](0027-coupled-stigmergic-dual-loop-agent-system.md)（CSDLAS / C1'-C6 / H5 gate）、[ADR 0009](0009-multi-agent-as-base-capability.md)（dispatch 底座）、[ADR 0024](0024-second-brain-from-natural-conversation.md)（AI-Native 认知/infra 分层）、[ADR 0026](0026-second-brain-decision-participation.md)（§3.4 回声室断路器）、[ADR 0028](0028-sediment-ground-truth-tiered-rearchitecture.md)（provenance 来源边界门）、`docs/direction.md`（INV-COST-NOT-A-GATE / INV-IMPLICIT-GROUND-TRUTH / INV-USER-NOT-WORKER）。
- **清除的闸**：ADR 0027 §6 的 H5 gate —— "ADR 0030 evaluation harness 完成前，L2 swarm 不进生产"。本 ADR 即 0030：它**定义**那个 harness（在线形态），并在此基础上让 caged-live hub 进入单用户生产。

---

## 1. 决策（一句话）

把一个 **caged-live 动态 hub**（运行时由 LLM 按任务选 worker 数/模型/角色，然后**真派活**）以**默认关闭的 flag** 放进单用户生产；其评估器是**在线的**——从生产 audit + 主会话处置 + 周期性跨厂商双跑判定中长出来，**不是先建好的离线 benchmark**。这清除 H5 gate：gate 要的是"信任 hub 派活前先有正确性评估"，在线评估器满足这个意图，前提是单用户 owner-consent。

---

## 2. H5 gate 是被重解，不是被走回头路

H5 gate 的字面是"ADR 0030 完成前不进生产"，而 ADR 0030 的形态（定量 benchmark vs 定性 review）本就是 ADR 0027 §6 留下的开放题。本 ADR 给出答案：**单用户、owner 自担风险、配在线遥测 + 跨厂商判定的 harness**。这不是把 gate 删掉，是按 gate 自己写的前置条件把它清掉。

gate 原始论证里的"assignment 错 → 所有下游 sub-agent 在错误前提下 stigmergy → 错误被放大"是按 Devin 式自治长跑威胁模型校准的。pi 的 L2 不是那个形态（经四家 T0 读码核实）：单层（`validateTools` 硬拒嵌套 dispatch）、hub 默认只读（worker 默认 `WORKER_TOOLS` + hub prompt 守只读；dispatch 的 mutating env 闸已于 2026-06-16 去除，hub 只读现由其评估用途的 prompt 保证，非 env 闸）、当轮可问责（C4'）、共享 C6 anchor、成本全计量。在这个拓扑里一次坏 assignment 的最坏现实后果 = **烧掉一轮 ≤ 数美元、当轮可见、可重做**，不是不可逆的下游污染。gate 的字面"不进生产"对单用户 over-fit；它真正要保护的"correctness 不可凭 hub 自证"由 §5 的双跑判定守住。

**唯一真正半不可逆的残留**是 L1 沉淀污染（一个自信地错的 hub 聚合被主会话接受 → 沉进大脑 → 自我强化，ADR 0027 §8 代价 9）。其主路径已被现有代码堵死（§6），本 ADR 只补一处。

---

## 3. hub 是什么（MVP 形态）

`dispatch_hub({ task, ... })` —— 一个工具调用，不是常驻 runtime。主会话调它 → hub LLM（跨厂商、按任务选，见 §7）产出 assignment `{ n_workers, models[], roles[], rationale }` → 经既有 `runInProcess` **真派** → 返回聚合结果 + 写完整 audit（§4 schema）。它继承 dispatch 的全部结构约束：单层、嵌套禁止、只读默认。它**不**自治递归、**不**常驻、**不**绕过主会话问责（结果当轮回到主会话）。

与被否决的 advisory-shadow 的区别：shadow 只建议不真派，因而只能测"hub 跟人一不一致"，测不了"不一致时谁对"——四家 T0 一致判定 shadow 为假 MVP。dispatch_hub 真派，故能产出真实结果供 §5 评估。

---

## 4. 笼子（bounded + visible + reversible）

| 维度 | 约束 | 性质 |
|---|---|---|
| worker 数 | sanity 上限 **8**；超限 abort-with-visibility | infra liveness 兜底，**非成本闸**；常量焊死、**不可调**（可调即退化为事实成本闸 = 走偏信号 #8） |
| 工具面 | 只读默认（继承 `MUTATING_TOOLS` gate off）；嵌套 dispatch 禁止 | 继承既有结构约束 |
| 成本 | **纯事后报告**（footer + audit 出 hub assignment 与 cost）；**无 $-闸** | 守 INV-COST-NOT-A-GATE：成本永不拦截执行 |
| 开关 | `dispatch.hub.enabled` 默认 **false**（settings 单一真相，kill-switch） | 翻 flag 即回退主会话直选路径 |
| 去相关 | **强制跨厂商**：hub 厂商 ≠ 主会话厂商、≠ worker 多数厂商 | 防 self-talk（同厂商 hub = 套壳 think_harder，假一致零信息） |

成本不设闸是有意的（owner 指令 + INV-COST-NOT-A-GATE + T0-cost-blind）。过度派活的代价由 §5 的 cost-efficiency 趋势线**暴露**并迭代修正，不靠硬堵。

---

## 5. 在线评估器（清闸的真正仪器）

评估的是 **assignment 决策本身的好坏**（派几个、用哪些模型、什么角色、并行/串行），不是 worker 产出对不对。两根轴：

- **轴 1 效率（确定性，从 audit 直接算）**：cost / latency / 冗余度 / success 率 / hub 成本占比 / 并行利用率。机械可测，零新埋点之外的判断。
- **轴 2 正确性（去相关，不可凭 hub/主会话自证）**：
  - **(a) 主会话处置**（便宜的在环代理）：`accept_as_is / accepted_modified / rejected / partial`，从后续 tool 调用免费观测。强于 shadow 的"对计划的一致"，因为是对**已执行产出**的处置。
  - **(b) 周期性双跑判定**（约 **20%** 的 hub turn）：同一真任务同时跑 human-pick 与 hub-pick，跨厂商 T0 盲审判哪个更好（复用 `scripts/oracle-goldset.mjs` 的跨厂商投票范式）。**这是唯一真正的"不一致谁对"信号**。

**红线（四家 T0 + owner 共识）**：只靠 (a) 不够——主会话与 hub 同处一个 L1 闭环，"主会话接受了"恰恰可能是回声室而非独立真值。**(b) 双跑跨厂商判定必须与 hub day-1 一起上，不可后补**；否则评估器看不见唯一危险失败（cheap + `terminal_state:completed` + 自信地错），生产就退化为凭感觉 dogfood。

**audit schema（v4，按 C6 anchor `session_id/turn_id/subturn` 串接）**——三类行：
- `hub_decision`：hub_model + 厂商、hub 计划**原文**（出 turn 即不可复原，必须 decision-time 落盘）、worker 计划（models/roles/依赖图）、hub tokens/cost/latency。
- `hub_disposition`（每 worker）：模型、角色、hub 为它写的 prompt、依赖、与 worker 自身 audit 行的 subturn join。
- `hub_summary`：聚合 terminal_state、成本 rollup（hub vs workers）、效率派生量（output 密度、冗余 flag）、`main_session_disposition`、（采样时）`dual_execution` 判定与 judge 厂商。

不可复原必须 decision-time 捕获的：hub 计划原文、hub 给每个 worker 写的 prompt、hub_model。

---

## 6. L1 污染守卫

hub 的 toolResult（含 hub 计划与 worker 聚合）回流主会话后，**不得**被 sediment 当作用户隐式真值再提取。主路径已由 `extensions/sediment/checkpoint.ts` 的 `L2_FANOUT_TOOL_NAMES` withhold 掩码堵死（`dispatch_agent`/`dispatch_parallel` 整段扣除，`smoke:sediment-l2-withhold` 守护）。**本 ADR 把 `dispatch_hub` 登记进同一掩码**（forward-guard），smoke 同步扩断言。

残留的"主会话把一个自信地错的 hub 结论复述进自己的 answer，进而沉淀"与任何主会话输出同型，由既有 sediment provenance / staging / 多视角管线承接，非 hub 独有，不在本 ADR 新增机械门。

---

## 7. hub 模型选择

**per-task 选，不写死。** "hub 是否必须 T0" 在设计盲议里四家**故意没统一**：opus/gpt-5.5 主张必须 T0（hub 调用 ≈ 几分钱，是它授权的 worker 扇出的 <10%，是 SPOF，弱 planner 毒下游，T0-cost-blind 正适用）；deepseek/MiniMax 主张按任务类路由（"cost-blind 是别 block 成本，不是别 route 成本"，无 baseline 时 always-T0 无据）。

**这恰好是生产数据要回答的题**：把 `hub_model` 记进 audit，让评估器显示 T0 hub 是否真比 T1 强。**唯一硬规则**：跨厂商去相关（§4）。在数据给出结论前，初始策略 = 主会话按任务 per-task 选 hub 模型 + 强制跨厂商；T0/T1 不预设。

---

## 8. 翻默认开的硬门（owner 指令：用真数据 ratify）

默认 off dogfood → 在线评估器攒数据 → **仅当**双跑判定显示 hub 在 cost-adjusted 质量上**≥ human-pick**（跨足量 hub turn）时，才把 `dispatch.hub.enabled` 翻默认 on。翻默认是一次单独的、由数据驱动的 ratify，不在本 baseline 内自动发生。复用项目 stage0/forgetting 的 dark-launch → oracle → flip 纪律。

---

## 9. 明确接受的代价

- 过度派活的浪费（可见、迭代修正，不硬堵）。
- hub 规划调用本身的成本（几分钱级，相对 worker 扇出可忽略）。
- 双跑判定在约 20% turn 上翻倍 worker 成本（噪声级，INV-COST-NOT-A-GATE 下不拦截）。
- 早期反复修改（owner 明确接受）。
- 单用户 gate 重解：错误不会跨用户传播，但单用户仍承担 zero-shot assignment 的 correctness 风险——由 §5 双跑判定 + §6 污染守卫兜底。

---

## 10. 走偏信号

1. 双跑判定持续显示 hub 劣于 human-pick → 翻 kill-switch，不翻默认。
2. cost-efficiency 趋势线显示系统性过度派活且迭代数轮无改善 → 修 hub 激励或 kill。
3. `smoke:sediment-l2-withhold` 对 `dispatch_hub` 的断言转红（污染守卫退化）→ block，先修守卫。
4. 出现一个自信地错的 hub 聚合**绕过守卫**沉进 L1（事后由 supersession/纠错发现）→ 升级，回看 §6 是否需加来源边界门。
5. 任何 PR 给 hub 能力面加确认弹窗 / per-run 人肉点头 / $-闸 → INV-TELL-NOT-ASK / INV-COST-NOT-A-GATE 被侵蚀，立即按 `README.md` §5 升级。
6. hub 与主会话/worker 出现同厂商（去相关规则被绕过）→ 评估信号失真，修去相关或 kill。

---

## 11. 评审来源（provenance）

本 ADR 由本仓三轮跨 provider T0 设计盲议 + owner 逐轮签字收敛而来，关键转折（均为 owner 产品直觉纠 AI 共识的过度保守）：
- 第一轮：assistant 主张"先建 attribution 种语料"被 opus/gpt-5.5/deepseek 用 `oracle-goldset.mjs` 跨厂商投票先例否决（无需 live attribution；自报告路线项目已证伪）。
- 第二轮：owner 指出 advisory-shadow 是假 MVP（测不了不一致谁对）；四家 T0 一致改判 ship caged-live；gate 被认定按 Devin 威胁模型 over-fit。
- 第三轮：owner 定 4 条（进生产 / 不怕成本 / hub 模型 per-task 且考虑必须 T0 / 完整 audit）；四家落地为本 ADR；MiniMax 抛"L1 污染今天即在且断路器失明"被 assistant 读 `checkpoint.ts` 当前代码证伪（主路径早已 withhold + smoke 守护，MiniMax 引的是过期审计文档）——残留仅 §6 一处 forward-guard。

逐轮转录见 git history；本节只记会影响决策有效性的转折，不并入全文。
