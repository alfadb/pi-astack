# pi-astack ADR 设计基线导览

> **指路牌不是镜子**。本文件**不复述** ADR 内容，**零原创**——只列锚点 +
> 一句话定位，告诉你"找什么去哪查"。设计基线以 ADR 文本本身为准；改动设计
> 时仍以 ADR 为准，本文件随 ADR 演进同步指针不重写哲学。

---

## 1. 一句话总愿景

> 用户跟 pi 自然对话，大脑在背后自动学习、自动纠错、自动演进。用户不应
> 该被要求去"管理大脑"——但大脑应该让用户明确感知它在工作。

→ [ADR 0024 §1](./0024-second-brain-from-natural-conversation.md#1-一句话愿景)

---

## 2. 四条核心不变量（hard invariant，不可破）

| Invariant | 一句话 | 锚 |
|-----------|--------|-----|
| INV-INVISIBILITY | 用户不参与大脑管理（不审批 / 不裁决 / 不投票 / 不归档 / 不定期审查）。运行状态指示正常显示 — "告诉用户做了什么" ≠ "要求用户做事" | [ADR 0024 §2](./0024-second-brain-from-natural-conversation.md#inv-invisibility隐身性) |
| INV-AUTONOMY | 大脑通过观察自然对话学习；用户不参与不等于用户不说话 | [ADR 0024 §2](./0024-second-brain-from-natural-conversation.md#inv-autonomy自治性) |
| INV-IMPLICIT-GROUND-TRUTH | 真实信号来自自然对话本身（每次输入 / 决定 / 接受修改拒绝 / 沉默 / 主动纠错） | [ADR 0024 §2](./0024-second-brain-from-natural-conversation.md#inv-implicit-ground-truth隐式真实信号) |
| INV-ACTIVE-CORRECTION | 用户任务里冒出的"以后用 X / 忘掉那条 / 你怎么记成 Y" 是核心信号通道，不算元工作 | [ADR 0024 §2](./0024-second-brain-from-natural-conversation.md#inv-active-correction主动纠错通道) |

---

## 3. 核心设计原则

| 原则 | 一句话 | 锚 |
|------|--------|-----|
| **AI-Native** | 防出错主路径必须是 prompt 工程，不能是机械护栏。机械工程做兜底 / infra，不做 LLM 行为层主路径 | [ADR 0024 §3](./0024-second-brain-from-natural-conversation.md#3-核心设计哲学ai-native-原则) |
| **机械 vs AI-Native 对照表** | 6 个典型对照（classifier 准确性 / 模糊归属 / 作用范围 / audit 可信度 / writer 还原度 / multi-agent 协调 / retrieval cutoff） | [ADR 0024 §3.3](./0024-second-brain-from-natural-conversation.md#33-几个典型的机械-vs-ai-native对照) |
| **L1 / L2 双 invariant 分层治理** | 认知执行环 (L1) ↔ 任务协作环 (L2) 各自 invariant 不可统一，stigmergic trace 互嵌共生 | [ADR 0027 §C1'](./0027-coupled-stigmergic-dual-loop-agent-system.md#c1-双-invariant-治理-互嵌共生非正交) |
| **认知层 prompt-native / infra 层 structured** | §3 AI-Native 只约束认知层，infra 层 (audit / state machine / heartbeat / anchor) 允许 structured | [ADR 0027 §C3'](./0027-coupled-stigmergic-dual-loop-agent-system.md#c3-认知层-prompt-native--infra-层-structured) |
| **session-id + turn-id causal anchor** | 跨 L1/L2 因果链的物理基础；所有 dispatch / audit 强制注入 | [ADR 0027 §C6](./0027-coupled-stigmergic-dual-loop-agent-system.md#c6新--跨-l1l2-causal-trace-共享-session-id--turn-id-锚点) |

---

## 4. 自然交互 vs 管理大脑：边界

- **合法** → [ADR 0024 §4.1](./0024-second-brain-from-natural-conversation.md#41-这些都是合法的自然交互不违反任何-invariant)
- **反模式必须删除/避免** → [ADR 0024 §4.2](./0024-second-brain-from-natural-conversation.md#42-这些都不行必须删除或避免)
- **灰色地带处理** → [ADR 0024 §4.3](./0024-second-brain-from-natural-conversation.md#43-灰色地带的处理原则)
- **"这份文档不是什么"防误读** → [ADR 0024 §8](./0024-second-brain-from-natural-conversation.md#8-这份文档不是什么防止后续套错框架)

---

## 5. 六个核心能力点（写侧 = 学习 / 读侧 = 参与）

| 能力点 | 骨架在 | 详细设计在 |
|--------|--------|-----------|
| 主动纠错识别 | [ADR 0024 §5.1](./0024-second-brain-from-natural-conversation.md#51-主动纠错识别) | [ADR 0025 §4.1](./0025-sediment-meta-curator-subsystem.md#41-主动纠错识别前置能力) |
| 结果反馈 (outcome self-report) | [ADR 0024 §5.2](./0024-second-brain-from-natural-conversation.md#52-结果反馈让本人交代) | [ADR 0025 §4.2](./0025-sediment-meta-curator-subsystem.md#42-outcome-self-report) |
| 跨会话趋势观察 (aggregator) | [ADR 0024 §5.3](./0024-second-brain-from-natural-conversation.md#53-跨会话趋势观察) | [ADR 0025 §4.3](./0025-sediment-meta-curator-subsystem.md#43-跨会话趋势观察aggregator) |
| 双 AI 互审 (multi-view) | [ADR 0024 §5.4](./0024-second-brain-from-natural-conversation.md#54-双-ai-互相审查multi-view-verification) | [ADR 0025 §4.4](./0025-sediment-meta-curator-subsystem.md#44-multi-view-verification) |
| Classifier prompt 自身演进 | [ADR 0024 §5.5](./0024-second-brain-from-natural-conversation.md#55-classifier-prompt-自身的演进) | [ADR 0025 §4.5](./0025-sediment-meta-curator-subsystem.md#45-classifier-prompt-自身演进) |
| 自治归档 + 回滚窗口 | [ADR 0024 §5.6](./0024-second-brain-from-natural-conversation.md#56-自治归档--回滚窗口) | [ADR 0025 §4.6](./0025-sediment-meta-curator-subsystem.md#46-静默归档--回滚窗口) |

---

## 6. 第二大脑参与决策（读侧）

| 路径 | 触发方式 | 详细设计 |
|------|---------|---------|
| **路径 A — always-on inject** | 大脑推（每轮 before_agent_start 自动跑） | [ADR 0026 §3.0](./0026-second-brain-decision-participation.md#30-路径-a-v2--v3-设计post-31-walk-back-的统辖) **(v2/v3 统辖节)** |
| **路径 B — memory_decide tool** | LLM 拉（自己意识到决策时调用） | [ADR 0026 §4.2](./0026-second-brain-decision-participation.md#42-路径-b即时深潜辅助路径llm-主动调) |
| 决策点 → outcome ledger anchor join | [ADR 0026 §5.1](./0026-second-brain-decision-participation.md#51-decision_brief_id-schema--outcome-ledger-anchor-field-layoutr1-p1-7-补补) |

---

## 7. 接受的代价 + 走偏信号

**显式接受的代价**（不接受 = 不接受设计）：
→ [ADR 0024 §6](./0024-second-brain-from-natural-conversation.md#6-明确接受的代价)
→ [ADR 0026 §7.4](./0026-second-brain-decision-participation.md#74-接受代价新增)
→ [ADR 0027 §8](./0027-coupled-stigmergic-dual-loop-agent-system.md#8-明确接受的代价)

**走偏信号**（什么时候需要回头审视基线）：
→ [ADR 0024 §7](./0024-second-brain-from-natural-conversation.md#7-走偏信号什么时候需要回头看这份文档)
→ [ADR 0027 §9](./0027-coupled-stigmergic-dual-loop-agent-system.md#9-走偏信号)

---

## 8. 子 ADR (待启动)

| ADR | 主题 | 触发条件 |
|-----|------|---------|
| 0028 | IDE / host 边界 | pi 引入除 CLI/TUI 外的第二个 host |
| 0029 | 跨 provider 治理 | 单设备 dogfood → 团队/企业场景，或 multi-view 真正接入跨 provider |
| 0030 | **L2 hub baseline + evaluation harness（blocking gate）** | L2 swarm 上生产之前必须完成 |

→ [ADR 0027 §6](./0027-coupled-stigmergic-dual-loop-agent-system.md#6-推到独立子-adr-的能力点)

---

## 9. 基础 / 历史 ADR（pre-0024，仍 active）

> 这些 ADR 早于第二大脑框架；核心仍有效但部分实现细节过时。**current 真相以代码 / [current-state.md](../current-state.md) 为准**，下表只给"读什么去哪查 + 怎么读"。

| ADR | 定位 / 读法 |
|-----|------|
| [0001](./0001-pi-astack-as-personal-pi-workflow.md) | 项目定位 / 使用即开发 / vendor+端口层 / 硬纪律仍有效；记忆基础设施段以 current-state 为准 |
| [0003](./0003-main-session-read-only.md) | 主会话只读 / sediment 单写仍核心；旧 bash regex / pg role / gbrain guard 实现已过时 |
| [0006](./0006-component-consolidation.md) | 组件三分类（自有 / vendor / 迁入）仍有效；具体路径以 `UPSTREAM.md` 为准 |
| [0009](./0009-multi-agent-as-base-capability.md) | dispatch 作为基础能力仍真；旧 `multi_dispatch` / templates 是历史设计 |
| [0010](./0010-sediment-single-agent-with-lookup-tools.md) | 单 agent curator kernel 被 0016 继承；含三模型投票失败五根因（实证）；gbrain 技术细节过时 |
| [0013](./0013-asymmetric-trust-three-lanes.md) | trust × blast radius 思想仍有效；Lane B/D 已废、Lane C 机械 gate 被 0016 删 |
| [0014](./0014-abrain-as-personal-brain.md) | 七区 abrain 基础架构 + vault 授权机制 |
| [0015](./0015-memory-search-llm-driven-retrieval.md) | memory_search LLM 两阶段 rerank |
| [0016](./0016-sediment-as-llm-curator.md) | sediment LLM curator 哲学（0024 落地载体） |
| [0017](./0017-project-binding-strict-mode.md) | 项目绑定 strict mode |
| [0018](./0018-sediment-curator-defense-layers.md) | sediment curator 删机械护栏先例 |
| [0019](./0019-abrain-self-managed-vault-identity.md) | abrain 自管 age keypair vault identity |
| [0020](./0020-abrain-auto-sync-to-remote.md) | abrain 跨设备同步（冲突不自动 merge） |
| [0021](./0021-lane-g-identity-skills-habits-writer.md) | Lane G identity/skills/habits writer（G1 shipped） |
| [0022](./0022-prompt-user-tool.md) | prompt_user 工具（任务相关决策） |
| [0023](./0023-session-start-rule-injection.md) | rules 区 + 第二大脑心智模型 |

> **已删除的 gbrain 时代 ADR**（0002 / 0004 / 0005 / 0007 / 0008 / 0011 / 0012 + 0024-r5 快照）：架构已迁至 markdown+git，叙事见 [../memory-architecture.md](../memory-architecture.md)，逐字原文见 git history。编号刻意不连续、不留 stub（降噪）。

---

## 10. 演进时序

- **2026-05-22** ADR 0024 第二大脑总框架 v1 accepted（R7 完成，AI-Native 升格为显式约束）
- **2026-05-24** ADR 0025 sediment meta-curator v2.1 accepted（R3 完成，六能力点设计完整）
- **2026-05-24** ADR 0027 Coupled Stigmergic Dual-Loop v0.2 accepted（R3 完成，L1/L2 双 invariant + C6 anchor）
- **2026-05-27** ADR 0026 决策参与 v1 accepted（R1 完成，路径 A/B 互补）
- **2026-05-28** ADR 0026 §3.1 walk-back（决策点二元区分被实施层质疑废止；路径 A v2 / v3 设计统辖在 §3.0）
- **2026-05-28** ADR 0024-0026 cross-ADR drift sweep（aggregator v1 / `/abrain audit classifier` ship 状态同步 + path A 接受代价 + retrieval cutoff 新行）

最近 commits ：

```
git log --oneline docs/adr/
```

---

## 11. 如何使用这个导览

**新协作者上手**：按 §1 → §2 → §3 → §5 → §6 → §7 顺序读 anchor。约 30 min 拿到全 design space map。

**做设计选择前**：
- 想清楚是认知层还是 infra 层 ([§C3'](./0027-coupled-stigmergic-dual-loop-agent-system.md#c3-认知层-prompt-native--infra-层-structured))
- 检查是否违反 4 invariants ([§2](#2-四条核心不变量hard-invariant不可破))
- 检查是否在 ADR 0024 §3.3 对照表的禁止机械路径 ([§3](#3-核心设计原则))
- 看走偏信号是否被触发 ([§7](#7-接受的代价--走偏信号))

**实施 vs ADR 文本不一致**：以 ADR 为准，不一致 = drift，需修订 ADR 或更正实施。如果是有意 walk-back，添加 ADR walk-back 注解（参 ADR 0026 §3.1 walk-back 示例）。

**本文件维护规则**：ADR 编号 / 章节结构 / 新增能力点 / walk-back 发生时同步本文件 anchor。**不复述 ADR 内容**——发现本文件出现原创设计声明 = bug。

---

> ADR 体系**承认设计会演进**——单一汇总文档容易被读作"已定稿"反向限制 walk-back 自由度。本导览选择 link-only 形态，让 ADR 文本本身始终是唯一 truth。
