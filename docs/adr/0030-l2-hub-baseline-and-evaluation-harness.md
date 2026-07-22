---
doc_type: adr
status: superseded
---

# ADR 0030 — L2 Hub Baseline + Evaluation Harness

> **Retired / superseded（owner 决策，2026-07-22）**：立即退役 `dispatch_hub`，不再继续 20 条 dogfood。实态证据是采用极低、唯一 material verdict 为 `human_better`，且 `task -> hub -> worker` 的二级路径产生两级有损转述；主会话直接使用 `dispatch_agent` / `dispatch_parallel` 已足够表达所需编排。专属 runtime、settings schema/config 与继续推动 dogfood 的评测入口已删除；历史 ADR、audit 与 ledger 作为事实证据保留且不再增长。

- **状态**：**Accepted (baseline，2026-06-16)**。经三轮跨 provider T0 设计盲议（Claude Opus 4-8 / GPT-5.5 / DeepSeek v4-pro / MiniMax-M3，逐轮记录于 git history）+ owner 签字收敛。本 ADR 为 baseline：caged-live hub 以默认关闭 flag 进入单用户 dogfood 已 owner-ratified；**翻默认开（默认 on）须由 material 模式离线判定数据 ratify**（见 §8；2026-07-08 walkback：在线 hub 缺 human-pick counterfactual）。ADR-text 形式审计折叠进 dogfood 阶段。
- **依赖**：[ADR 0027](0027-coupled-stigmergic-dual-loop-agent-system.md)（CSDLAS / C1'-C6 / H5 gate）、[ADR 0009](0009-multi-agent-as-base-capability.md)（dispatch 底座）、[ADR 0024](0024-second-brain-from-natural-conversation.md)（AI-Native 认知/infra 分层）、[ADR 0026](0026-second-brain-decision-participation.md)（§3.4 回声室断路器）、[ADR 0028](0028-sediment-ground-truth-tiered-rearchitecture.md)（provenance 来源边界门）、`docs/direction.md`（INV-COST-NOT-A-GATE / INV-IMPLICIT-GROUND-TRUTH / INV-USER-NOT-WORKER）。
- **清除的闸**：ADR 0027 §6 的 H5 gate —— "ADR 0030 evaluation harness 完成前，L2 swarm 不进生产"。本 ADR 即 0030：它**定义**那个 harness（生产 audit + 主会话处置 + material 模式离线判定），并在此基础上让 caged-live hub 进入单用户生产（2026-07-08 walkback：在线双跑口径不可满足 human-pick counterfactual）。

---

## 1. 决策（一句话）

把一个 **caged-live 动态 hub**（运行时由 LLM 按任务选 worker 数/模型/角色，然后**真派活**）以**默认关闭的 flag** 放进单用户生产；其评估器由生产 audit + 主会话处置 + material 模式离线跨厂商判定共同组成，**不是先建好的静态 benchmark**（2026-07-08 walkback：在线 hub 调用缺 human-pick counterfactual，正确性判定需离线生成候选材料后盲审）。这清除 H5 gate：gate 要的是"信任 hub 派活前先有正确性评估"，上述评估器满足这个意图，前提是单用户 owner-consent。

---

## 2. H5 gate 是被重解，不是被走回头路

H5 gate 的字面是"ADR 0030 完成前不进生产"，而 ADR 0030 的形态（定量 benchmark vs 定性 review）本就是 ADR 0027 §6 留下的开放题。本 ADR 给出答案：**单用户、owner 自担风险、配在线遥测 + 跨厂商判定的 harness**。这不是把 gate 删掉，是按 gate 自己写的前置条件把它清掉。

gate 原始论证里的"assignment 错 → 所有下游 sub-agent 在错误前提下 stigmergy → 错误被放大"是按 Devin 式自治长跑威胁模型校准的。pi 的 L2 不是那个形态（经四家 T0 读码核实）：单层（`validateTools` 硬拒嵌套 dispatch）、hub **结构只读**（planner/workers 固定 `HUB_TOOLS`/`WORKER_TOOLS` allowlist；planner 输出的 `tools` 不得授予额外能力，validate 层 ignore+audit + execute 层 `assertHubToolsAllowlist` 二次防线 fail-closed；与 direct `dispatch_agent`/`dispatch_parallel` 的显式 implementation tools 路径隔离）、当轮可问责（C4'）、共享 C6 anchor、成本全计量。在这个拓扑里一次坏 assignment 的最坏现实后果 = **烧掉一轮 ≤ 数美元、当轮可见、可重做**，不是不可逆的下游污染。gate 的字面"不进生产"对单用户 over-fit；它真正要保护的"correctness 不可凭 hub 自证"由 §5 的双跑判定守住。

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
| 工具面 | hub planner/workers **结构固定**只读 allowlist（`HUB_TOOLS`/`WORKER_TOOLS`）；planner `tools` 不得扩权（fail-closed）；嵌套 dispatch 禁止 | hub 局部结构约束；不改 direct dispatch 显式 implementation tools |
| 成本 | **纯事后报告**（footer + audit 出 hub assignment 与 cost）；**无 $-闸** | 守 INV-COST-NOT-A-GATE：成本永不拦截执行 |
| 开关 | `dispatch.hub.enabled` 默认 **false**（settings 单一真相，kill-switch） | 翻 flag 即回退主会话直选路径 |
| 去相关 | **prompt 优先 + 可用性降级必须落 audit**：hub prompt 优先要求跨厂商；不可用时允许同厂商 plan，但必须在 audit 记录 `mainVendor` / `decorrelated` 与降级理由；同厂商 plan 是 warning + audit 可见，不硬拒（2026-07-08 walkback：运行可用性与 dogfood 实态优先，硬拒会把评估器退化成可用性故障） | 防 self-talk，同时保留 provider 不可用时的执行路径 |

成本不设闸是有意的（owner 指令 + INV-COST-NOT-A-GATE + T0-cost-blind）。过度派活的代价由 §5 的 cost-efficiency 趋势线**暴露**并迭代修正，不靠硬堵。

---

## 5. 评估器（清闸的真正仪器）

评估的是 **assignment 决策本身的好坏**（派几个、用哪些模型、什么角色、并行/串行），不是 worker 产出对不对。两根轴：

- **轴 1 效率（确定性，从 audit 直接算）**：cost / latency / 冗余度 / success 率 / hub 成本占比 / 并行利用率。机械可测，零新埋点之外的判断。
- **轴 2 正确性（去相关，不可凭 hub/主会话自证）**：
  - **(a) 主会话处置**（便宜的在环代理）：`accept_as_is / accepted_modified / rejected / partial`，从后续 tool 调用免费观测。强于 shadow 的"对计划的一致"，因为是对**已执行产出**的处置。
  - **(b) material 模式离线双跑判定**：`scripts/oracle-hub-quality.mjs` 产出 human-pick / hub-pick 候选材料，主会话再用 `dispatch_parallel` 组织跨厂商 T0 盲判哪个 assignment 更好。**这是唯一真正的"不一致谁对"信号**。

**2026-07-08 walkback（理由：在线 `dispatch_hub` 形态缺乏 human-pick counterfactual）**：只靠 (a) 不够——主会话与 hub 同处一个 L1 闭环，"主会话接受了"恰恰可能是回声室而非独立真值。但原文要求 "day-1 在线双跑"也不成立：主会话调用 hub 时不存在平行的人工指派可对照，在线路径天然缺少 human-pick counterfactual。正确形态改为 material 模式离线双跑：先用脚本生成可复审候选，再由主会话发起跨厂商盲判；否则评估器看不见唯一危险失败（cheap + `terminal_state:completed` + 自信地错），生产就退化为凭感觉 dogfood。

**audit schema（v4，按 C6 anchor `session_id/turn_id/subturn` 串接）**——三类行：
- `hub_decision`：hub_model + 厂商、`mainVendor`、`decorrelated`、必要时的去相关降级理由、hub 计划**原文**（出 turn 即不可复原，必须 decision-time 落盘）、worker 计划（models/roles/依赖图）、hub tokens/cost/latency。
- `hub_disposition`（每 worker）：模型、角色、hub 为它写的 prompt、依赖、与 worker 自身 audit 行的 subturn join。
- `hub_summary`：聚合 terminal_state、成本 rollup（hub vs workers）、效率派生量（output 密度、冗余 flag）、`main_session_disposition`、（离线样本回填时）`offline_dual_judgment` 判定与 judge 厂商（2026-07-08 walkback：不再承诺在线 `dual_execution`）。

不可复原必须 decision-time 捕获的：hub 计划原文、hub 给每个 worker 写的 prompt、hub_model。

---

## 6. L1 污染守卫

hub 的 toolResult（含 hub 计划与 worker 聚合）回流主会话后，**不得**被 sediment 当作用户隐式真值再提取。主路径已由 `extensions/sediment/checkpoint.ts` 的 `L2_FANOUT_TOOL_NAMES` withhold 掩码堵死（`dispatch_agent`/`dispatch_parallel` 整段扣除，`smoke:sediment-l2-withhold` 守护）。**本 ADR 把 `dispatch_hub` 登记进同一掩码**（forward-guard），smoke 同步扩断言。

残留的"主会话把一个自信地错的 hub 结论复述进自己的 answer，进而沉淀"与任何主会话输出同型，由既有 sediment provenance / staging / 多视角管线承接，非 hub 独有，不在本 ADR 新增机械门。

---

## 7. hub 模型选择

**per-task 选，不写死。** "hub 是否必须 T0" 在设计盲议里四家**故意没统一**：opus/gpt-5.5 主张必须 T0（hub 调用 ≈ 几分钱，是它授权的 worker 扇出的 <10%，是 SPOF，弱 planner 毒下游，T0-cost-blind 正适用）；deepseek/MiniMax 主张按任务类路由（"cost-blind 是别 block 成本，不是别 route 成本"，无 baseline 时 always-T0 无据）。

**这恰好是生产数据要回答的题**：把 `hub_model` 记进 audit，让评估器显示 T0 hub 是否真比 T1 强。去相关策略按 §4 执行：prompt 优先跨厂商，遇到可用性降级时 warning + audit 可见，不硬拒（2026-07-08 walkback：与 §4 的运行实态对齐）。在数据给出结论前，初始策略 = 主会话按任务 per-task 选 hub 模型 + prompt 优先跨厂商；T0/T1 不预设。

---

## 8. 翻默认开的硬门（owner 指令：用真数据 ratify）

默认 off dogfood → material 模式离线判定攒数据 → **仅当**累计 ≥20 次离线判定且 hub 在 cost-adjusted 质量上**≥ human-pick**时，才把 `dispatch.hub.enabled` 翻默认 on。翻默认是一次单独的、由数据驱动的 ratify，不在本 baseline 内自动发生。当前 `dispatch.hub.enabled=true` 仅定性为 owner 显式 dogfood，不等于默认开 ratify（2026-07-08 walkback：原在线评估硬门缺少 human-pick counterfactual，需重新锚定到可复审离线判定）。复用项目 stage0/forgetting 的 dark-launch → oracle → flip 纪律。

**2026-07-08 治理批注记**：本批闭合 hub 判定回路，判定结果回填到 `hub-judgments.jsonl`，并执行首次真实跨厂商 material 盲判。fail-closed：若本批到 2026-07-15 前未产生至少 1 次真实判定，则关闭 `dispatch.hub.enabled`。即使 `enabled=true`，它仍只是 owner dogfood；翻默认开仍需累计 ≥20 次 material 判定且质量 ≥ human-pick。

**2026-07-21 实态注记**：`hub-judgments.jsonl` 现为 **1/20** material 判定，且该条 `final_verdict=human_better`（2026-07-08）。因此 2026-07-15 “至少 1 次真实判定” 条件**已满足**——不得误称违反该 fail-closed 条件，也不得把过期 `review_by=2026-07-15` 直接等同于零判定关闸证据。默认开质量门仍**未**满足（样本 <20 且唯一 verdict 为 human_better）。同步：hub 工具面已升级为 **structural read-only cage**（固定 `HUB_TOOLS`/`WORKER_TOOLS`；planner `tools` 不得扩权；与 direct dispatch 显式 implementation tools 隔离），见 §4 与 `extensions/dispatch/hub.ts`。

---

## 9. 明确接受的代价

- 过度派活的浪费（可见、迭代修正，不硬堵）。
- hub 规划调用本身的成本（几分钱级，相对 worker 扇出可忽略）。
- material 模式离线双跑判定消耗额外候选生成与跨厂商 judge 成本（不再绑定约 20% live turn；INV-COST-NOT-A-GATE 下不拦截，2026-07-08 walkback：在线抽样口径已撤回）。
- 早期反复修改（owner 明确接受）。
- 单用户 gate 重解：错误不会跨用户传播，但单用户仍承担 zero-shot assignment 的 correctness 风险——由 §5 双跑判定 + §6 污染守卫兜底。

---

## 10. 走偏信号

1. 双跑判定持续显示 hub 劣于 human-pick → 翻 kill-switch，不翻默认。
2. cost-efficiency 趋势线显示系统性过度派活且迭代数轮无改善 → 修 hub 激励或 kill。
3. `smoke:sediment-l2-withhold` 对 `dispatch_hub` 的断言转红（污染守卫退化）→ block，先修守卫。
4. 出现一个自信地错的 hub 聚合**绕过守卫**沉进 L1（事后由 supersession/纠错发现）→ 升级，回看 §6 是否需加来源边界门。
5. 任何 PR 给 hub 能力面加确认弹窗 / per-run 人肉点头 / $-闸 → INV-TELL-NOT-ASK / INV-COST-NOT-A-GATE 被侵蚀，立即按 `README.md` §5 升级。
6. audit 中 same-vendor 率持续升高且无降级理由（2026-07-08 walkback：同厂商 plan 是 warning + audit 可见，不再硬拒；危险信号是无理由降级常态化）→ 评估信号失真，修去相关提示、provider 可用性或 kill。

---

## 11. 评审来源（provenance）

本 ADR 由本仓三轮跨 provider T0 设计盲议 + owner 逐轮签字收敛而来，关键转折（均为 owner 产品直觉纠 AI 共识的过度保守）：
- 第一轮：assistant 主张"先建 attribution 种语料"被 opus/gpt-5.5/deepseek 用 `oracle-goldset.mjs` 跨厂商投票先例否决（无需 live attribution；自报告路线项目已证伪）。
- 第二轮：owner 指出 advisory-shadow 是假 MVP（测不了不一致谁对）；四家 T0 一致改判 ship caged-live；gate 被认定按 Devin 威胁模型 over-fit。
- 第三轮：owner 定 4 条（进生产 / 不怕成本 / hub 模型 per-task 且考虑必须 T0 / 完整 audit）；四家落地为本 ADR；MiniMax 抛"L1 污染今天即在且断路器失明"被 assistant 读 `checkpoint.ts` 当前代码证伪（主路径早已 withhold + smoke 守护，MiniMax 引的是过期审计文档）——残留仅 §6 一处 forward-guard。

逐轮转录见 git history；本节只记会影响决策有效性的转折，不并入全文。
