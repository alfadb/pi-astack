---
doc_type: consensus
status: active
---

# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。**只装未完成/计划**：当前事实见 [`docs/current-state.md`](./current-state.md)，功能/需求级变更见 [`docs/feature-changelog.md`](./feature-changelog.md)，实施流水留在 audit 或 git history（REQ-006：roadmap 不是 changelog）。

## 分类、排序与共同边界

Roadmap 分为四类，按以下规则解释：

1. **第二大脑自治闭环主序列**：严格按依赖顺序推进；后项不得以并行实验绕过前项语义。仅表中明确标注为“只读观测”的项可在其前置语义通过后并行采样；观测结果不得提前驱动任何行为。
2. **并行可靠性轨**：可立即推进，但只加固已授权能力，不能改变主序列的认知语义或偷渡 blocked transition。
3. **健康 gated-defer**：只有真实触发信号出现才进入执行预算；无触发就是正确状态。
4. **独立产品轨**：不依赖第二大脑闭环，可单独排期，但仍遵守各自 ADR 和安全边界。

每个任务使用稳定 `RM-*` roadmap ID，或明确绑定 [`transition-register.machine.json`](./transition-register.machine.json) 中一个或多个 transition stable ID。**transition 的 phase、authorization 与 gate 一律以 machine register 为准**；roadmap 聚合多个 transition 只表达依赖和阅读顺序，不产生 blanket 授权。`blocked`、`not_authorized`、`separate_authorization_required` 与 `gated_deferred` 项不得被当作当前可执行任务。

所有轨道共同遵守：

- 人永不参与具体 memory governance：无条目审批、裁决、投票、归档、手动编辑/恢复、清队列或定期 review。用户在自然工作中的纠正是 outcome 信号，不是治理动作。
- 所有新能力必须用真实生产数据完成验收；synthetic / fixture 只用于回归和故障注入，不能作为唯一验收。
- 自治遗忘终点只到 `archived`，全文保持运行时可达并自动复活；不授权自治物理删除。
- footnote、沉默、单纯 exposure、LLM 自述或 LLM 共识都不是独立 ground truth。
- 新增长期 brain data 继续遵守 [ADR 0039](./adr/0039-constraint-pipeline-reset.md) 的 Evidence Event -> projector/compiler -> stable view 边界；不扩大 raw `agent_end` 写时裁决，也不新增平行可写 memory store。
- 对 LLM 语义错误优先改 prompt、上下文和自治反馈；机械门只用于 infra、不可逆风险或有明确移除条件的过渡面。

## 第二大脑自治闭环主序列

GIC 在这里是 externalized system 的坐标系，不是重构规范。真实 repo、test、lint、build、LSP、git、browser、workflow、tool 与 memory outcome 是高信任观测；不优先建设 learned World Model，也不重新引入 `task -> planner -> worker` 二级转述层。

| 顺序 | ID / transition 绑定 | 任务与依赖 | 真实验收与禁止走法 |
|---|---|---|---|
| 前置（非阻塞） | `RM-GIC-001` | **GIC 状态边界 ADR**：只定义 `goal` / `identity` / `belief` / `configurator` / `learning` 的状态所有权、写权限、读路径和治理层级；明确 L1 prompt-native、L2 infra-structured。它可与生产修复并行，绝不阻塞下列 P0 闭环修复。 | 后续 design 能指出状态 owner 与读写边界；不因论文术语重构已工作的系统，不把本 ADR 变成页首伪主执行序列。 |
| 1 | `RM-OUTCOME-001` + `outcome.unknown-attribution` | **自动 outcome evidence spine**：合并原 Outcome Edge、Meta-curator outcome closure 与 unknown-attribution。自动采集 test/lint/build、workflow/tool result、git revert-or-rewrite、自然纠正等真实结果，并连接 `memory exposure -> action -> outcome -> evidence -> re-judge`；prompt revision 也只消费这条独立 outcome 链。 | 真实生产任务可从 exposure 追到独立 outcome 并触发自治 re-judge；不得人工标注。footnote、沉默、exposure 或 LLM 共识不能单独 confirm、demote 或 archive。现有 `operator disposition` 退出条件是陈旧治理残留：后续 register 修复须改为 agent 自治 terminal disposition（例如 `defer_until_new_evidence`）：保留审计轨迹，仅在出现新的独立 evidence 时才重开，不阻塞主线、不形成待人队列；仍禁止永久 operator/human 节点，也不得以静默丢弃证据的“自动退役”替代可审计 disposition。 |
| 2（completed / authorized） | `RM-LIFECYCLE-002` + `lifecycle.convergence-rm-002` | **staging / pending / E2 自治收敛**：provisional、multiview-pending 与 lifecycle proposal 共享有界调度和只读可重建模型；新 multiview source 在同次原子创建时即具备完整稳定 lifecycle metadata，未知 state fail-closed，terminal live 残留先清 pending schedule 再全文归档，deadline 到期执行 source-side 自治动作。E1 execution-ready 在 3 次 cap 内 bounded exponential retry，到 cap terminal，并仅由所属 project 的 valid durable frontmatter scan 按原 identity 重开；E2 successor/status/evidence 三迁移仍按 project_root 隔离。未观察到 Lane G/P7 触发，因此没有创建 Lane G pipeline；`forgetting.kind-evidence-strength-v1` 保持独立 observe。 | 2026-07-23 跨供应商 T0 复核通过且无未解决 P0/P1，本阶段 fully authorized（machine enum: `authorized`）。persisted inventory continuity、classification delta、creation-immediate bounded smoke 与 `unbounded_pending` 均通过；production evidence v2 保留 self-hash-valid 的历史 35-row/1→0 proof，并按每次 current_run 独立验收真实 actions/hash 边界。`staging.hard-delete` 继续 `blocked / separate_authorization_required`；不新增 Lane G、人审或 forgetting 权限。 |
| 3（in progress / authorized） | `RM-FORGET-001` + `forgetting.upstream-wiring` + `forgetting.kind-evidence-strength-v1` | **自治遗忘真实 round-trip**：2026-07-23 用户 fresh explicit authorization 已决定不加 canary、不等待 30d/baseline/reviewer，直接正式全量启用。production `memory.forgetting.enabled=true`、`instrumentation=true`、字面布尔 `executorRealApplyEnabled=true`，并与 effective `sediment.autoLlmWriteEnabled=true` 组成已 armed 的 AND authority。所有当前代码允许的 E1 kind 均可执行；非 E1 继续既有 evidence/kind gates；archive reactivation 不受 dedicated gate 影响。 | 5/batch、20/day、CAS、corpus floor、resurrection backoff 保持 circuit breakers，而非 canary。30d、真实 query corpus recall/none 与 reviewer 是运行中观察/后续放量质量指标，不是启用前门。当前 eligible=0 的 armed dossier 只证明 dedicated/global/AND=true、source/durable/demote/reactivation hash 不变与 action=0；settings 在每个 `agent_end` 热重读，formal authority 已 armed、无需重启，并在下一次 `agent_end` 生效。自然出现的 nonzero production demote + reactivation audit 尚待完成，因此不是 completed。不得手工制造 candidate；终点仅全文 `archived`，hard-delete、Lane G 与人工队列仍 blocked/不存在。 |
| 4 | `RM-GIC-002` | **PEG baseline**：依赖 outcome spine 与 lifecycle outcome 可归因（步骤1-2）；只读观测臂可在步骤1-2通过后与步骤3-4并行采样。建立 Performance / Efficiency / Growth 时序，只观测、不作高风险 gate。 | 连续真实任务能计算 P/E/G 与至少一类重复任务的跨会话变化；PEG baseline 成为下游行为依据（如 Configurator）仍需完成步骤1-4真实验收，不得借 outcome 或 lifecycle 结果提前驱动行为。成本只做事后透明度，不成为执行闸。 |
| 5 | `RM-GIC-003` | **Belief State v1**：依赖 `RM-OUTCOME-001` 与 PEG baseline；把任务期 `observed` / `inferred` / `stale`、未验证与已证伪假设变成共享状态。 | 真实任务中 sub-agent 复用 belief 并减少重复探索；test/LSP/git/browser/tool 观测压过叙述性推断；不制造第二套手写 context。 |
| 6 | `RM-GIC-004` | **PEG-informed Configurator**：依赖 `RM-GIC-002`、`RM-GIC-003` 与稳定 outcome attribution；先影响低风险 direct dispatch 路由。 | 真实路由能引用历史 P/E/G 与 outcome 证据，质量优于无历史 baseline 且可回退；PEG 不是机械裁决阈值，成本不是执行 gate。 |
| 7（gated） | `RM-GIC-005` + `memory.p7-low-frequency-three-arm-gate` | **L1 Identity Evolver**：同时等待 outcome spine 成熟和 P7 出现真实触发；任一未满足都保持 gated，不占执行预算。 | 真实 identity-class evidence 在真实生产任务上的系统内 blind A/B 提升任务质量（不是人工记忆评审，也不能只用 synthetic）；identity 变更有 outcome 链且可回退；无 memory/identity 管理 UI。 |
| 8 | `RM-GIC-006` | **Drift Detection Return Path**：依赖 GIC 状态边界与 outcome spine；自动比较 `vision.md` / `direction.md` / ADR 基线。 | 只自动 report 到现有 audit / aggregator；不生成周期性人工任务，不把实现流水写进 ADR，也不要求用户裁决 drift。 |
| 9（最后） | `RM-GIC-007` | **Configurator distillation 候选**：仅在外部化 configurator、causal trace 与 PEG attribution 都有稳定真实 baseline 后评估。 | 真实生产任务上 P/E/G 优于外部化 baseline 且可回滚；不接入生产模型权重自更新，不提前训练 agentive/world model。 |

## 并行可靠性轨

这些任务可以立即做，但不得改变主序列的 confirmation、lifecycle、forgetting 或 P7 语义。

| ID / transition 绑定 | 任务 | 真实验收与授权边界 |
|---|---|---|
| `RM-REL-001` | **Memory search budget isolation**：隔离 foreground、background、subagent 与各 search profile 的并发/时间预算；后台 defer 不能挤占前台。它是 liveness isolation，不是成本闸。 | 真实 500 次 foreground query 的 budget error = 0；后台拥塞时前台仍满足既定 accuracy contract，不能靠减少检索、静默 fallback 或放宽结果质量达标。 |
| `RM-REL-002` + `canonical_path.p1` | **Canonical fresh-event E2E 复验**：fresh process 上让真实 auto-write 依次经过 L1 -> L2 -> canonical commit -> remote push；旧代码进程只 fail-closed，不暗示原地恢复；下一次正常 fresh startup 后由 runtime 自动恢复并 drain，无人工 retrigger。 | 仅复验已完成/已授权的 P1 runtime 能力；不得写入或暗示 `canonical_path.p2` / `canonical_path.p3`、ADR0040 residual P3 或 P4 授权。fixture 只做 crash/race 回归，最终证据必须来自 fresh production event。 |
| `RM-REL-003` + `constraint.auto-refresh-failed-run-retry` | **Freshness health 与自治恢复**：明确区分 `no-new-input`、`projector-stalled`、L1->L2 lag、L2->L3 lag；异常自动告警并自动重建/重试，移除依赖 owner 手动 retrigger 的残余。 | Activity L2 与 hot-overlay delta 用真实数据验收；valid-but-stale 是合法可服务状态，不直接当故障。真实 stall/retry 留下可归因 outcome。 |
| `RM-REL-004` | **Path A latency**：先完成 `RM-REL-001`，再重建真实 baseline，优化 decision brief Path A 的 foreground latency。 | 真实 turn SLO 改善且 recall / none 与 baseline 等价；不得通过少检索、缩候选、放宽 accuracy 或把错误变成 empty 达标。 |
| `RM-GOV-001` + `knowledge.legacy-physical-retirement` + `constraint.dual-read-flip` + `constraint.read-flip-state-to-git-l2` + `constraint.dual-read-audit-retirement` + `constraint.tier2-legacy-write-gate` + `proposition.adr0040-p3-d3-v2-session-start` + `proposition.adr0040-p3-runtime-read-flips` + `proposition.adr0040-p4-legacy-authority-retirement` + `canonical_path.p2` + `canonical_path.p3` + `canonical_path.p4a` + `canonical_path.p4b` | **Transition-register consistency repair**：先修 register 语义，再讨论任何 retirement 或 flip。记录 Knowledge legacy physical retirement 的 `ready_for_decision` 与 ADR0040/canonical P4 `blocked` 冲突；该 `ready_for_decision` 不得启动人的 memory retirement 裁决。Constraint residual exit/consumer 仍引用 pre-Policy authority 的陈旧；将 D3-v2、residual non-Policy consumers、canonical P2 与 canonical P3 拆成独立授权面。 | 这是 docs/governance 一致性修复，不是 memory 条目治理，也不授权任何 mutation。`proposition.adr0040-policy-stable-view-runtime-flip` 已完成且不重开；0040 residual 聚合项不能合成 blanket P3 授权。当前 register 本身尚未在本 roadmap 批次修改，所有冲突项继续按 machine state blocked/gated。 |
| `RM-REL-005` + `knowledge.o5-confidence-fallback-review` | **O5 pending flip 自动评估**：在真实窗口自动判断 `conf>=8` 非指令 durable fallback 是否仍产生 accepted correction / recall miss；满足退出条件即移除 fallback 回 ADR 原谓词。 | 只消费真实 audit/outcome，自动报告和 disposition；不建立人工巡检或记忆条目 review。 |

## 健康 Gated-Defer

以下项目无真实触发时不占执行预算；触发后仍须遵守真实生产数据验收，不能以 synthetic/fixture 单独转正。

| ID / transition 绑定 | 触发与边界 |
|---|---|
| `memory.p7-low-frequency-three-arm-gate` | identity / skills / habits / workflows / project-memory / rationale 任一 P7 arm 出现真实触发后，才选择单一低频域 pilot；不一次性迁移全系统。 |
| `memory.l3-chunks-embeddings-graph` | 只有真实规模、query latency 或 rebuild cost 证明需要时才物化 L3 表；L3 仍是可重建派生层，不成为 Git SOT。 |
| `constraint.adr0034-staleness-resync` | pinned `source_ref` 出现真实 stale、跨源不一致或 re-sync 失败后重开；此前不做预防性实现。 |
| `memory.adr0035-0037-slim-ingest` | 仅跟踪 ADR 0035/0036/0037 文档 slim + mechanism ingest，不代表 retrieval runtime 未实现。这里的 sediment lane go/no-go 只是一条**一次性架构 migration 授权**，不是 memory 条目审批、投票或人工逐条治理；主会话仍不直接写 abrain。 |
| `RM-DEFER-001` | **Stage1 compact surface v2**：dark-launch 保持 off；只有真实 stage1-50、重复样本与弱模型 recall 证明无回归才重开。 |
| `RM-DEFER-002` | **Requirement / workline attribution**：只有真实 evidence 样本与 schema 论证后推进；不得从 slug/title 猜测并冻结 attribution。若扩展 L1 metadata/event，先走对应 ADR。 |
| `RM-DEFER-003` | **wiki-as-view**：只有真实高频人类消费、持久链接或批注需求出现才讨论物化；不新增第三个可写 memory store，human-readable surface 由 renderer 产生。 |
| `RM-DEFER-004` | **AutoMem tracking, not training**：先由 `RM-OUTCOME-001` 记录 memory action -> outcome；只有真实 prompt 迭代 plateau 与可审计训练/评估语料出现才讨论 learned memory expert。 |
| `RM-DEFER-005` | **Canonical home 成文化**：出现 docs/research/abrain/wiki-like view 的真实 split-brain 后，再以一次性架构决策明确“一项断言一个 canonical home”；不复制内容。 |
| `RM-DEFER-006` | **qmd optional acceleration**：只作未来离线诊断/加速候选，不得成为 LLM retrieval 不可用时的 fallback。 |
| `RM-DEFER-007` | **Incremental graph rebuild**：只有真实 rebuild cost 成为瓶颈才推进；graph/index 继续可丢弃重建。 |
| `RM-DEFER-008` | **Prompts/gstack reference port**：仅在具体方法缺口出现时临时 clone/read diff 后按需 port，不恢复 active vendor submodule。 |

`staging.hard-delete`、`canonical_path.p2/p3/p4a/p4b`、ADR0040 residual P3/P4 不是健康 defer，而是 machine register 中的 blocked/未授权面；不得因出现在 roadmap 而进入执行。

## Architecture Debt

这些项是独立、可回滚的工程债；按真实故障与使用压力排序，不抢占主序列 P0。

| Roadmap ID | Item | Intent |
|---|---|---|
| `RM-ARCH-001` | Stage0 follow-up | 解耦 reconcile 写入、异步 cold-start rebuild、统一截断语义，并保留中文 sparse 防复发 guard / dedup oracle；只按真实 query 回归与瓶颈推进，不恢复全库 fallback。 |
| `RM-ARCH-002` | Schema evolution | 为 frontmatter/audit/binding schema 建立多版本兼容与 migration path，不在 docs 镜像当前字段清单。 |
| `RM-ARCH-003` | Runtime path docs/tests | 防止 `.pensieve` / `.pi-astack` / `.abrain/.state` 路径语义漂移。 |
| `RM-ARCH-004` | Model fallback vs curator whitelist | 让 whitelist 与 fallbackModels 契约一致，避免 fallback 候选被无声移除；不得以降低模型质量作为可用性修复。 |
| `RM-ARCH-005` | Constraint offline compile/dossier tooling | 继续限定为历史 Constraint 的离线/冷审计工具，不参与 Policy stable-view live injection；registry 复用 runtime/model-curator 模型源，写模式默认 temp，覆盖 residual audit artifact 必须显式且响亮。先完成 `RM-GOV-001` 的 authority 语义修复。 |

## 独立产品轨

| Roadmap ID | Item | Acceptance boundary |
|---|---|---|
| `RM-PRODUCT-001` | Vault P0d：masked input、`.env` import、`/vault migrate-backend` wizard | 保持 fail-closed，不引入 plaintext fallback；使用真实可用 backend 做端到端验收，mock 只做回归。 |
| `RM-PRODUCT-002` | `abrain-age-key` identity passphrase wrap | 让加密后的 identity 支持跨设备恢复；与 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md) P0d 增强合并决策，真实 passphrase round-trip 验收。 |
| `RM-PRODUCT-003` | Tier 3 legacy backend reader UX | `ssh-key` / `gpg-file` / `passphrase-only` 保持 explicit-only；复用 `RM-PRODUCT-002` 的 unwrap 路径关闭 tty gap，未完成前继续显式 deprecation/fail-closed。 |

Lane G 不在产品轨重复登记；RM-LIFECYCLE-002 未观察到 P7 trigger，因此未创建 Lane G pipeline。未来仍只在 P7 gate 真实触发且不引入人工 review 时另行推进。
