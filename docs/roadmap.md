---
doc_type: consensus
status: active
---

# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。**只装未完成/计划**——已 ship 的当前事实写入 [`docs/current-state.md`](./current-state.md)，功能/需求级变更写入 [`docs/feature-changelog.md`](./feature-changelog.md)，多轮审计与 commit 级实施流水写入 `docs/audits/` 或保留在 git history（REQ-006：roadmap 不是 changelog）。

## Externalized GIC 顺序路线图

本节记录 pi-astack 在 arXiv 2606.23991 的 GIC 框架下的后续顺序路线。定位：pi-astack 不追求短期训练出论文意义上的 Agent Model，也不在软件工程域优先建设 learned World Model；下一阶段目标是成为 **externalized GIC system with a closed learning loop**：把 goal / identity / belief / configurator / learning 以系统能力显式化，锚定真实 repo / test / LSP / git / browser / workflow / memory 信号，并通过 L1/L2 causal trace 闭合学习回路。

顺序项不是排期；只有前置验收信号在真实 dogfood 中成立，才进入下一项。低风险测量可以并行补齐，但不得绕过顺序把后项能力提前变成默认行为。

| 顺序 | Epic | 目标 | 验收信号 | 主要风险 / 禁止走法 |
|---|---|---|---|---|
| 1 | **GIC 状态边界 ADR** | 固化 `goal` / `identity` / `belief` / `configurator` / `learning` 在 pi-astack 中的系统对应物、写权限、读路径和治理层级；明确 L1 仍 prompt-native、L2 仍 infra-structured。 | 后续 design / PR 能明确说明改动属于哪一类状态、由哪个 loop 拥有、是否触碰 `direction.md` 不变量。 | 只写术语不进入评审习惯；为对齐论文术语重构已工作的系统。 |
| 2 | **Outcome Edge 完整化** | 闭合 `memory 注入 -> agent 行为 -> 用户/工具 outcome -> confidence / status / usage 反馈`，让 L1 从 write-only 记忆循环进入可校准学习循环。 | 活跃记忆条目出现由真实后续使用触发的 confidence 调整、降级或 contested 标记；self-echo 不被误判为确认。 | 把 LLM 自述升格为 ground truth；要求用户显式审查记忆。 |
| 3 | **PEG 基线与仪表** | 建立 Performance / Efficiency / Growth 的最小可用指标，先观测、不作高风险 gating。 | 连续真实任务产生 P/E/G 时序；至少一类重复任务能计算跨会话变化；成本只事后透明，不作执行闸。 | 指标变成机械硬门；用 synthetic case 代替真实 dogfood 验收。 |
| 4 | **显式 Belief State v1** | 把任务期状态从散落工具输出提升为一等结构，区分 `observed` / `inferred` / `stale`，并记录未验证假设与已证伪假设。 | sub-agent 能消费共享 belief 而减少重复探索；过期推断被显式标记；测试、LSP、git、browser 等真实观测优先于叙述性推断。 | 变成第二套手写 context 负担；用 learned simulation 替代可直接执行的真实 oracle。 |
| 5 | **PEG-informed Configurator** | 让 configurator 从规则 + 即时 LLM 判断，升级为规则 + LLM 判断 + 历史 PEG / outcome 归因加权；只先影响低风险路由。 | direct dispatch 的模型/任务选择能引用历史 P/E/G 证据；低风险路由质量优于无历史基线；失败可回退显式主会话选择。 | 把 PEG 当机械裁决阈值；让成本成为执行 gate；重新引入二级 planner 转述层。 |
| 6 | **L1 Identity Evolver** | 第二大脑沉淀并注入“这个用户 + 这个项目下 agent 应如何工作”的行为特征，包括验证严格度、风险偏好、协作方式和项目习惯。 | 盲测中 identity 注入提升任务质量；用户零管理操作；identity 变更有 outcome 证据链。 | 做出用户可见 memory / identity 管理界面；identity 漂移没有返回路径。 |
| 7 | **Drift Detection Return Path** | 落地“人类管方向 / abrain 管细节”的返回路径，定期对照 `vision.md` / `direction.md` / ADR 基线检测实现细节是否反向改变方向。 | 至少能报告一类真实 direction drift 或明确确认无 drift；报告进入现有 aggregator / audit 面，不新增用户管理流程。 | 形成定期人工审查负担；把实现状态流水写进 ADR。 |
| 8 | **Configurator 蒸馏候选** | 仅在前述 trace 足够后，评估是否从 causal trace + PEG 归因数据蒸馏小型 configurator，用于模型选择、dispatch 形态和工具选择。 | 外部化 configurator 已有可比较基线；蒸馏候选在真实任务上 P/E/G 优于外部化基线且可回滚。 | 过早训练 agentive model / world model；把模型权重自更新接入生产学习回路。 |

明确不做，除非另有 ADR walk-back：

- 不为对齐 GIC 论文而重构已工作的子系统；GIC 是坐标系，不是迁移规范。
- 不在软件工程域优先建设 learned World Model；真实执行、测试、LSP、git、browser 观测是更高信任来源。
- 不把 L1 第二大脑质量问题外包给用户审批、投票、审查、手动编辑或记忆管理 UI。
- 不引入无问责的自组织 swarm；主会话通过 direct dispatch primitives 保留 completion / liveness / accountability 语义。
- 不重新引入 `task -> planner -> worker` 二级有损转述层；需要多 worker 时由主会话直接调用 `dispatch_parallel`。

## 第二大脑 research 吸收路线（activity / wiki-as-view）

本节把 2026-07-04 agent memory / LLM Wiki 调研吸收到 backlog。定位：research 是参考材料，不直接升级为 direction / requirements / ADR；只有命中方向边界、持久 schema、runtime 默认行为或高反转成本时才进入 T0 / ADR。

| Item | Intent | Notes |
|---|---|---|
| **Requirement / workline attribution gate** | 在 project 内回答“正在推进哪些需求 / 工作线”，但只在有真实 evidence 样本和 schema 论证后推进。 | 不与 project allocation 同批实现：project_id 是现有 L1 metadata，requirement/workline 是语义归因。若需要扩展 L1 event metadata 或新增 attribution event，先走 T0 / ADR；禁止从 slug/title 直接猜并冻结成字段。 |
| **wiki-as-view rendering boundary** | 吸收 LLM Wiki 的“预编译人类可读知识”优点，但不新增第三个可写 memory store。 | L2 Markdown view 可以作为 human-readable wiki-like surface；canonical home 仍只能是 docs 或 abrain L1/L2。若未来人类高频消费、要求持久链接或批注，再带真实使用证据讨论物化层。 |
| **canonical home 唯一规则成文化** | 降低 docs / research / abrain / wiki-like view split-brain 风险。 | 候选改动是 `docs/README.md` 或 `direction.md` 的小型边界补强：同一知识断言只有一个 canonical home；人类可读性通过 renderer 获得，不通过多写一份获得。需要人类签字后再改方向文档。 |
| **Lifecycle signals in ranking / forgetting review** | 重新评估 recency、usage、contradiction、activity timeline 作为当下判断输入的边界。 | 不做 trust_score / half-life 标量；不把时间信号塞回 stage0/stage1 硬召回门。若 P0a 数据证明 useful，可作为 ADR 0031 自治遗忘的证据输入候选。 |
| **AutoMem tracking, not training** | 保留“记忆操作作为可学习技能”的长期研究期权。 | 当前只检查 L1 是否足够记录“memory action -> outcome”闭环；不投入 LoRA / learned memory expert，除非真实 sediment prompt 迭代出现 plateau 且有可审计训练/评估语料。 |

## 文档体系 Phase 2（剩余项）

| Item | Gate / Notes |
|---|---|
| pinned `source_ref` SHA staleness re-sync | ADR 0034 ratify 显式 defer；待 dogfood 出现首例 stale 后，带真实证据起草新 ADR。 |
| ADR 0035/0036/0037 slim + ingest | 须经 sediment lane go/no-go；主会话不直接写 abrain。 |

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| Meta-curator remaining closure | R5 classifier prompt 自迭代仍为 advisory-only；outcome feedback 仍需按真实 dogfood 判断是否收口；遗忘 executor 尚需消费一个受控批次。 | 以真实 dogfood 与可审计 executor 批次验收，不补实施流水。 |
| E2 curator 修边 lane | 处理 superseded 但无有效 successor 的存量。 | 目标是 confirm successor / restore status，避免 E2 长期停留在 `review_required`。 |
| 大脑内部 reviewer lane | 长尾 kind 强信号自动 demote 的前置。 | 上线后 `KIND_EVIDENCE_STRENGTH` 退化为 prompt 引导。 |
| Lane G G4–G5 | 完成 G4 staging review/age-out 边界与 G5 region-aware ranking hint。 | 只推进仍有独立使用价值的部分；不得把维护性 slash 变成正常产品入口。 |
| Vault P0d | masked input、`.env` import、`/vault migrate-backend` wizard | 保持 fail-closed，不引入 plaintext fallback。 |
| `abrain-age-key` identity passphrase wrap | 让 `~/.abrain/.vault-identity/master.age` 能用 passphrase 加密后进 git，实现跨设备仅 `git clone abrain` + 输一次 passphrase。详见 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md) §"P0d 增强"。 | 技术依赖未定：(Y2) `age-encryption` JS lib in-process unwrap · (Y1) `node-pty` 模拟 pseudo-tty 。合并 P0d ADR 决策。 |
| Tier 3 legacy backends reader UX | `ssh-key` / `gpg-file` / `passphrase-only` 在 ADR 0019 后是 explicit-only。`passphrase-only` reader 仍不能解锁（同一 tty pass-through 问题）。 | 上项 abrain-age-key passphrase wrap 落地后该 gap 自动关闭（同一 unwrap 路径）；在那之前 `/vault status` 仍会在旧 backend init 后显示 deprecation 提示。 |

## Unified Evidence Architecture Migration

设计见 [ADR 0039](./adr/0039-constraint-pipeline-reset.md)。迁移原则：所有长期记忆域先追加 Evidence Event，再由域自适应 projector / compiler 生成 stable view；Constraint 是第一优先迁移域，不再是独立特例。迁移期不得继续扩大旧 raw `agent_end` 写时裁决特殊逻辑。

Canonical-path P2/P3 仍为 `blocked/not_authorized`，只可准备只读证据；任何 production mutation 或 consumer flip 均需独立授权。当前状态与证据入口见 [transition register](./transition-register.md)。

### ADR 0040 — Unified Proposition Evidence Model（remaining gates）

决策见 [ADR 0040](./adr/0040-unified-proposition-evidence-model.md)，当前实现与机器证据见 [current state](./current-state.md) 和 [transition register](./transition-register.md)，长期执行契约见 [proposition contracts](./notes/adr0040-proposition-contracts.md) 与 [D3 lifecycle freshness design](./notes/adr0040-d3-lifecycle-freshness-design.md)。本节只登记未完成工作。

| Phase | Intent | Gate / Notes |
|---|---|---|
| 0040-P3 residual runtime read flips **[BLOCKED]** | 仅覆盖 D3-v2 session-start adapter、Knowledge pull consumer、canonical L2 authority 与其它非-Policy consumer。 | `separate_authorization_required`；Policy stable-view session-start 已完成，不属于 blocked scope，也不得被回读成 blanket P3 授权。每个残余 consumer 独立授权并定义 rollback/fail-closed。 |
| 0040-P4 non-Policy legacy authority / cold-audit disposition **[BLOCKED]** | 处置其它 consumer 的旧 authority 与 legacy physical retirement，同时保留 cold audit history。 | `separate_authorization_required`；Policy runtime 已无 compiled/D3/legacy fallback；本项不得恢复旧 session authority，也不得把 retirement 伪装成 migration。 |

### ADR 0039 gated-deferred residual

| Item | Intent | Gate / Notes |
|---|---|---|
| Low-frequency zone/view migration **[GATED-DEFERRED]** | 当 identity / skills / habits / workflows / project-memory / rationale 出现真实用量后，再选择单一 pilot 迁移到 evidence → projector → stable view。 | 仅在以下任一真实信号出现时重开：identity-shaped evidence 达到可验收样本；出现带 turn-pointer 的塑形错误；或存在足量可 replay 的历史事实。无触发即继续 deferred；不得用 synthetic event 验收或一次性重写全系统。 |

## Memory retrieval remaining work

| Item | Intent | Gate / Notes |
|---|---|---|
| Stage1 compact surface v2 **[DEFERRED / DARK-LAUNCH OFF]** | 在不损失弱模型 recall 的前提下降低粗筛 surface 成本。 | 现有 compact 试验有明显 recall 回归，不转正；重开需 stage1-50 度量、重复样本、compact-v2 薄证据与 sediment 路径验证。 |
| Stage0 follow-up | 解耦 reconcile 写入、异步 cold-start rebuild、统一截断语义，并补中文 sparse 防复发 guard / dedup oracle。 | 只按真实查询回归与运行瓶颈推进，不重新引入全库 fallback。 |

## Architecture debt

| Item | Intent |
|---|---|
| Schema evolution | frontmatter/audit/binding schema 的 version upgrade path（当前 `schema_version: 1` 字段已写入，缺多版本兼容/迁移策略）。 |
| Runtime path docs/tests | 避免 `.pensieve`/`.pi-astack`/`.abrain .state` 路径漂移。 |
| Model fallback vs curator whitelist | 当前 model-curator session_start 只 WARN，不阻止 curator 删掉 fallback 候选；需要 curator 在 whitelist 时尊重 fallbackModels 列表，或 fallback 路径自带 whitelist bypass。 |
| constraint offline compile/dossier 工具加固 | `scripts/dossier-constraint-shadow-report.mjs` 仅是历史 Constraint 的离线/冷审计工具，不参与也不改写 Policy stable-view live injection。让 registry 复用 pi runtime/model-curator 模型源；写模式默认输出 temp 树，覆盖 residual `.state` audit artifact 必须显式选择并响亮告警；用共享 stage helper 消除手维护 TS stage 清单的 bitrot。 |

## Pending flips（过渡态机械门，ADR 0024 §7.6 条款）

| 门 | flip/移除条件 | 证据源 |
|---|---|---|
| `conf≥8` 非指令 durable 过渡 fallback（correction-pipeline isTier1Directive，仅 no-target） | 审计窗口内 `tier1_direct_write` 中 `is_directive!==true && confidence>=8` 不再产生被用户纠正的 accepted corrections / recall misses → 移除 fallback 回 ADR 原文谓词 | `tier1_direct_write` audit 的 `is_directive` / `confidence` / correction outcome 维度（O5 sunset） |

## ADR 0031 — 自治自标定遗忘剩余验收

设计见 [ADR 0031](./adr/0031-autonomous-self-calibrating-forgetting.md)。仍需完成：

- 把 supersede/contradict 真值变化信号送入 aggregator 视图；disuse 单独不得触发降级。
- 让 executor 消费一个受控批次，并证明 demote ledger 与 reactivation window 可审计。
- 用真实 query 做 corpus vs corpus-minus-would-demote 回归；低 resurrection rate 不得被当作安全证明。

自治遗忘终点保持 `archived` 全文可达；物理删除不在 ADR 0031 授权内，未来若需要必须另起专门决策。

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd optional acceleration | 仅作未来离线诊断/加速实验候选；不得成为 LLM retrieval 不可用时的 fallback。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Prompts/gstack reference port | 未来如需吸收 gstack 方法论，按 `UPSTREAM.md` 临时 clone/read diff 后按需 port；不恢复 active vendor submodule。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
