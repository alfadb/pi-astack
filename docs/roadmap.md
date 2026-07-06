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
| 5 | **Live Caged Dynamic Hub** | 按 ADR 0030 推进受限动态 hub：预算上限、降级回静态 dispatch、全程 causal anchor 审计，避免坏 planner 污染下游。 | hub 决策可完整复盘；至少一次自动降级正确触发；真实任务表现不低于静态 dispatch 基线。 | 先建大规模 attribution corpus 再上线；无笼子直接默认启用。 |
| 6 | **PEG-informed Configurator** | 让 configurator 从规则 + 即时 LLM 判断，升级为规则 + LLM 判断 + 历史 PEG / outcome 归因加权；只先影响低风险路由。 | hub / dispatch 选择能引用历史 P/E/G 证据；低风险路由质量优于无历史基线；失败可回退静态策略。 | 把 PEG 当机械裁决阈值；让成本成为执行 gate。 |
| 7 | **L1 Identity Evolver** | 第二大脑沉淀并注入“这个用户 + 这个项目下 agent 应如何工作”的行为特征，包括验证严格度、风险偏好、协作方式和项目习惯。 | 盲测中 identity 注入提升任务质量；用户零管理操作；identity 变更有 outcome 证据链。 | 做出用户可见 memory / identity 管理界面；identity 漂移没有返回路径。 |
| 8 | **Drift Detection Return Path** | 落地“人类管方向 / abrain 管细节”的返回路径，定期对照 `vision.md` / `direction.md` / ADR 基线检测实现细节是否反向改变方向。 | 至少能报告一类真实 direction drift 或明确确认无 drift；报告进入现有 aggregator / audit 面，不新增用户管理流程。 | 形成定期人工审查负担；把实现状态流水写进 ADR。 |
| 9 | **Configurator 蒸馏候选** | 仅在前述 trace 足够后，评估是否从 causal trace + PEG 归因数据蒸馏小型 configurator，用于模型选择、dispatch 形态和工具选择。 | 外部化 configurator 已有可比较基线；蒸馏候选在真实任务上 P/E/G 优于外部化基线且可回滚。 | 过早训练 agentive model / world model；把模型权重自更新接入生产学习回路。 |

明确不做，除非另有 ADR walk-back：

- 不为对齐 GIC 论文而重构已工作的子系统；GIC 是坐标系，不是迁移规范。
- 不在软件工程域优先建设 learned World Model；真实执行、测试、LSP、git、browser 观测是更高信任来源。
- 不把 L1 第二大脑质量问题外包给用户审批、投票、审查、手动编辑或记忆管理 UI。
- 不追求去 hub 化的自组织 swarm；L2 必须保留 completion / liveness / accountability 语义。
- 不把 attribution corpus 作为 dynamic hub 的前置阻塞；trace 应是 caged live dogfood 的副产品。

## 第二大脑 research 吸收路线（activity / wiki-as-view）

本节把 2026-07-04 agent memory / LLM Wiki 调研吸收到 backlog。定位：research 是参考材料，不直接升级为 direction / requirements / ADR；只有命中方向边界、持久 schema、runtime 默认行为或高反转成本时才进入 T0 / ADR。

| Item | Intent | Notes |
|---|---|---|
| **Activity/attention L2 projector productization** | 让第二大脑从 L1 Evidence Events 派生“最近注意力分配到哪些项目”的人类可读 L2 view，并保持 deterministic / rebuildable。 | P0a 已以显式命令验证全局 project allocation；P0b 已新增显式只读 health script；P1 已新增显式只读 `memory_activity` pull 工具，按需读取已有 activity L2 view，返回 bounded summary 并校验 manifest/markdown/hash。仍不进入默认注入、不接 `memory_search` 排序、不接 `memory_decide` 默认 prompt surface、不新增 writable wiki store。禁止把 event count 说成真实工时；默认排除 legacy import。详细方案见 [`2026-07-04-activity-attention-timeline-l2-projector-plan.md`](./notes/2026-07-04-activity-attention-timeline-l2-projector-plan.md)。 |
| **Requirement / workline attribution gate** | 在 project 内回答“正在推进哪些需求 / 工作线”，但只在有真实 evidence 样本和 schema 论证后推进。 | 不与 project allocation 同批实现：project_id 是现有 L1 metadata，requirement/workline 是语义归因。若需要扩展 L1 event metadata 或新增 attribution event，先走 T0 / ADR；禁止从 slug/title 直接猜并冻结成字段。 |
| **wiki-as-view rendering boundary** | 吸收 LLM Wiki 的“预编译人类可读知识”优点，但不新增第三个可写 memory store。 | L2 Markdown view 可以作为 human-readable wiki-like surface；canonical home 仍只能是 docs 或 abrain L1/L2。若未来人类高频消费、要求持久链接或批注，再带真实使用证据讨论物化层。 |
| **canonical home 唯一规则成文化** | 降低 docs / research / abrain / wiki-like view split-brain 风险。 | 候选改动是 `docs/README.md` 或 `direction.md` 的小型边界补强：同一知识断言只有一个 canonical home；人类可读性通过 renderer 获得，不通过多写一份获得。需要人类签字后再改方向文档。 |
| **Lifecycle signals in ranking / forgetting review** | 重新评估 recency、usage、contradiction、activity timeline 作为当下判断输入的边界。 | 不做 trust_score / half-life 标量；不把时间信号塞回 stage0/stage1 硬召回门。若 P0a 数据证明 useful，可作为 ADR 0031 自治遗忘的证据输入候选。 |
| **AutoMem tracking, not training** | 保留“记忆操作作为可学习技能”的长期研究期权。 | 当前只检查 L1 是否足够记录“memory action -> outcome”闭环；不投入 LoRA / learned memory expert，除非真实 sediment prompt 迭代出现 plateau 且有可审计训练/评估语料。 |

## 文档体系 Phase 2（共识层重构）

Phase 1 已建共识层（`README`/`vision`/`direction`/`requirements`/`feature-changelog`，见 [`docs/README.md`](./README.md)）。Phase 2 **存量语料整体完成**：存量 ADR 方向上提 `direction.md`（hard invariant）/`requirements.md`（`REQ-*` 行为需求）；`current-state.md`/`architecture/*` 去代码镜像只留契约；frontmatter + `docs-doctor` 守卫落地（具体条目以各文件现状为准，不在此镜像计数）。

**abrain 侧物理 ingest/瘦身已收官**（[ADR 0034](./adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md) 实现）：存量机制 ADR 处置完毕（SLIM + 机制存档 ingest 入 pi-global，superseded 变体只标 archived；计数由 `ls ~/.abrain/projects/pi-global` 派生），机制分解入 abrain + `direction_impact` 注解 + 承重墙按需渲染 rationale（带 pinned `source_ref` SHA，见 `README.md` §4）；原机制 prose 由各 ADR slim banner 标注的 git 基线保留。已知残留缺口：① pinned SHA 的 **staleness re-sync**（0034 ratify 显式 defer，待 dogfood 出现首例 stale 后带证据起草）；② 收口后新增的机制 ADR（0035/0036/0037）的 slim + ingest 尚未执行（须经 sediment lane go/no-go）。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| **ADR 0024 R0 patch 同 PR 交付**（阶段 0，纯文档） | ADR 0023→R5（删 INV-R8/R9、删 `/rule veto`、删 `MEMORY-RULE:` first-class、加 INV-R12 auto-demote + `last_cited_at` 字段）+ ADR 0021 patch（删 `/about-me` first-class）+ ADR 0017 patch（sediment defer + auto-bind）+ ADR 0016 patch（self-improve cron化）+ ADR 0020 patch（silent power-user only）+ docs/current-state.md / brain-redesign-spec.md / architecture/ 同步。 | **R0 不同 PR 交付→ ADR 0024 不算 Accepted**，后续所有设计 hold。纯文档 2-3 天工作量。 |
| **ADR 0025 起草 (meta-curator subsystem)** | 基于 ADR 0024 三条 invariant + §4.2 五条 capability 清单详细设计：outcome feedback edge + cross-session aggregator + multi-view verification + classifier auto-iteration + silent archive rollback window。 | R0 完成后立刻起草 → multi-LLM xhigh audit ≥ 2 轮 P0 收敛 → R2-R6 实施阶段 phase。 |
| **ADR 0024 R2-R6 实施**（写侧 meta-curator） | R2 outcome edge + auto-demote、R3 cross-session aggregator、R4 multi-view verification、R6 archive 回滚/复活通道 **均已实现并接入 `agent_end`**（见 `extensions/sediment/{outcome-collector,aggregator,multi-view,archive-reactivation}.ts`）。**剩余缺口**：R5 classifier prompt 自迭代仍为 advisory-only（health/evolution ledger 仅观测，无真实 prompt 改写回路）；outcome-feedback 以 memory-footnote 注入实现（与 ADR 原设计的 agent_end 自报告不同，记为 partial）。 | 按真实 dogfood 反馈继续收口 R5/outcome。 |
| Lane G G4–G5 | G1 writer + G2 `/about-me` slash + agent_end 双-lane 已 ship（详 [ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）；G3 aboutness classifier 由 ADR 0023 R1 合并 unified classifier 关闭。剩余：G4 `review-staging` slash + 30-day TTL、G5 region-aware ranking hint。 | G4–G5 无阻塞；自然在 ADR 0024 R2-R6 路径里关闭。 |
| Vault P0d | masked input、`.env` import、`/vault migrate-backend` wizard | 保持 fail-closed，不引入 plaintext fallback。Vault P1（active project resolver + `/secret` scope 路由 + `$PVAULT_/$GVAULT_`）已 ship。 |
| `abrain-age-key` identity passphrase wrap | 让 `~/.abrain/.vault-identity/master.age` 能用 passphrase 加密后进 git，实现跨设备仅 `git clone abrain` + 输一次 passphrase。详见 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md) §"P0d 增强"。 | 技术依赖未定：(Y2) `age-encryption` JS lib in-process unwrap · (Y1) `node-pty` 模拟 pseudo-tty 。合并 P0d ADR 决策。 |
| Tier 3 legacy backends reader UX | `ssh-key` / `gpg-file` / `passphrase-only` 在 ADR 0019 后是 explicit-only。`passphrase-only` reader 仍不能解锁（同一 tty pass-through 问题）。 | 上项 abrain-age-key passphrase wrap 落地后该 gap 自动关闭（同一 unwrap 路径）；在那之前 `/vault status` 仍会在旧 backend init 后显示 deprecation 提示。 |
| Abrain auto-sync UX P0e | [ADR 0020](./adr/0020-abrain-auto-sync-to-remote.md) 已 ship 的 baseline（后台 push + 启动 ff-fetch + `/abrain sync` / `/abrain status`）上还差几个 UX 增强点。 | TUI footer 提示 `ahead > 0` 超 5 分钟；周期性 fetch（e.g. 每 15 min）；conflict suggestion logging（量化 LLM auto-merge 不做的代价）。全部是 deferred YAGNI，等真实 usage signal 再推进。 |

## Unified Evidence Architecture Migration

设计见 [ADR 0039](./adr/0039-constraint-pipeline-reset.md)。迁移原则：所有长期记忆域先追加 Evidence Event，再由域自适应 projector / compiler 生成 stable view；Constraint 是第一优先迁移域，不再是独立特例。迁移期不得继续扩大旧 raw `agent_end` 写时裁决特殊逻辑。

| Phase | Intent | Notes |
|---|---|---|
| P0 freeze old write-time adjudication | 停止为旧 rules 写时路径新增语义特例，并停止为其它长期记忆域新增 raw context → canonical mutation 特例。 | 只允许安全/数据完整性修复；新语义边界进入 ADR 0039 projector / compiler 设计。 |
| P1 Constraint shadow compiler | 读取现有 active/listed/archived rules、相关 audit 与治理案例，生成 shadow Compiled Constraint View + diff 报告。 | 详细设计见 [`2026-06-19-adr0039-p1-constraint-shadow-compiler-design.md`](./notes/2026-06-19-adr0039-p1-constraint-shadow-compiler-design.md)；报告必须标出 settings/tool not-memory、project/global rescope、near-duplicate merge、conflict、compact constraints。 |
| P2 Constraint event parallel write | `agent_end` 对新的 Constraint 信号追加 sanitized Evidence Event，同时 compiler 持续生成 shadow view。 | 详细设计见 [`2026-06-19-adr0039-p2-constraint-evidence-event-design.md`](./notes/2026-06-19-adr0039-p2-constraint-evidence-event-design.md)；验收关注 event 丢失率、compiler 活性、错误路由、not-memory 诊断、scope 保守性、旧路径差异。 |
| P3 Constraint compiled view injection | `session_start` 从 compiled view 注入约束，旧 always/listed rules 目录降为 legacy fallback 或兼容投影。 | stale 时注入上一版稳定 view 并提示 queued，不同步触发 LLM 裁决。 |
| P4-a retire adjudicator ✅ | tier1-ruleset/jaccard adjudicator 已退休（4×T0 一致，见 [`2026-06-20-adr0039-p4a-consensus.md`](./notes/2026-06-20-adr0039-p4a-consensus.md)）：删 `tier1-{ruleset-,}adjudicator.ts` + import；event-append 失败终结分类修复（default-terminal except `:write_failed`，修无限 HOLD）；rollback 收缩为 storage-only `writeAbrainRule`；硬删 `tier1RuleSetAdjudication`/`tier1JaccardShadowAudit` flag。`smoke:adr0039-p4a` 守护。 | 已 ship。 |
| P4-b retire legacy read fallback | `compiledViewInjection.fallbackToLegacyOnError=false` 已执行，当前处于 fail-closed compiled-view injection soak；legacy rules 不再是 read-failure fallback。 | **仍 gated**：legacy rules retirement/archive/delete 与剩余读兜底清理仍需独立 gate，不能由 fallback=false 间接执行。最新 pi-global dual-read audit 仍 `status=delta`，但 `legacyOnlyDispositions=settings_not_memory:6`；机器 audit 中 `textDelta=19` 仍为 semantic review surface，本轮人工审查判断为语义等价压缩；`queuedEvents=2` merged_source freshness surface 不阻塞 `injectableCoverageRatio=1`；Knowledge L1/L2 coverage gate 与 reconcile 已通过，health 仍有 warnings。 |
| P5 Constraint corpus split (shadow) ✅ | 现有 active rules 经 shadow diff 分流为 8 strata（compiled_global / compiled_project / settings_not_memory / tool_contract_not_memory / knowledge_candidate / conflict_unresolved / archived / needs_attention），产出确定性 `corpus-split.{md,json}`（.state shadow，PROPOSAL — not applied）。 | 4×T0 一致（4 轮，见 [`2026-06-20-adr0039-p5-corpus-split-consensus.md`](./notes/2026-06-20-adr0039-p5-corpus-split-consensus.md)）：**additive-thin 纯 re-projection**——stratum=f(category) 对现有 `ConstraintDiffCategory` 的 many-to-one fold（TS never-default 穷尽），零 validator/diff/decision 契约改动；coverage 由 validator 上游保证，view 层 Σ 断言冗余 fail-closed。真正 actions（knowledge 迁移 / settings 落地 / rescope apply）各为后续 gated shard。`smoke:constraint-shadow-compiler` 守护（含真实 ~/.abrain 重投影）。 |
| P5.5 Constraint L2 shadow materialized ✅ (FIX-1 backfill) | 把现有 `.state` validated `decision.json`（2 真实 constraint 事件）固化为 1 个 content-addressed `constraint-projection-envelope/v1` L1 事件 → 确定性 renderer → git-tracked `l2/views/constraint/latest/`（SHADOW，注入仍读 `.state`，无 read-flip）。`scripts/backfill-adr0039-constraint-l2.mjs`，event `dee4b6e8`。 | 执行 [`2026-06-20-adr0039-constraint-l2-consensus.md`](./notes/2026-06-20-adr0039-constraint-l2-consensus.md) 的 FIX-1 + 2026-06-21 R3 4×T0 一致：Revision B（causal_parents=2 实际事件，3rd 留下次自然 compile）；可逆=git revert+flag，L1 orphan 永不 rm。**已知缺口**：`reconcile:adr0039` 的 `stale_against_l1_events` 预先即 red（scan 含 knowledge 事件 + `.state` shadow 对 3rd 信号 genuinely stale；ADR §6 stale 本应 accepted）——独立 guard 修复待 multi-T0 定。 |
| P5.6 Constraint event trigger-fidelity verifier **[IN PROGRESS]** | 2 轮 4×T0 `T0审查` 一致签名：`validator` 回归结构性不变量，语义触发保真由 compiler prompt + prompt-native verifier 承担。Phase 1 已移除 `candidateTriggerPhrases` 字符串投影 hard gate 与 divergent trigger-set gate；无 verifier verdict 时，`merged_source` constraint_event 在 coverage 中保守保持 queued，不再自动 counted as projected。 | Phase 1 真实 replay 预期：坏 run `20260622T054726Z-a870e2c2df1d` 中 `T0审查` 变 queued；好 run `20260622T034235Z-2aff879c1302` 中历史 `T0讨论` merged_source 也临时 queued，这是有意的安全降级。Phase 2 待实现 prompt-native verifier（DATA not ENFORCEMENT，never throw/write，不进 validationHash；输出 per-event expressed/not_expressed/uncertain + reasoning），再让 faithful merged_source 恢复 projected。 |
| P6 Knowledge projector shadow ✅ (已超越——见 P1-flip projection_only) | 为 Knowledge 建立 Evidence Event → Search Corpus View 的 shadow projector，并用 diff、search A/B 与真实使用证据验证 freshness、召回质量和延迟。 | 实态已远超 shadow：Knowledge 已 B0–B4 + Phase C + P1-flip 到 `canonicalReadMode=projection_only`（见 [`2026-06-21-adr0039-p1-flip-executed.md`](./notes/2026-06-21-adr0039-p1-flip-executed.md)）。本行保留为历史阶段名。 |
| P7 low-frequency zone/view migration **[GATED-DEFERRED — 2026-06-21, 2 轮 4×T0 4/4]** | 把 identity / skills / habits / workflows / project-memory / rationale 等低频投影面迁移到 evidence → projector → stable view。**状态 = gated-deferred，不是 backlog**：实测全部域 canonical 目录为空且本实例零真实用量（不是缺 writer），迁移 pattern 已由 Constraint P1–P5 + Knowledge P6 证明，给空+无用量域建 writer/projector 是与 L3 §4.5 同形的投机脚手架。预选 pilot 域 = **identity**（identityKey 最干净），待 gate 触发时执行。共识见 [`2026-06-21-adr0039-p7-pilot-defer-consensus.md`](./notes/2026-06-21-adr0039-p7-pilot-defer-consensus.md)。 | **Gate（OR，任一臂触发才重开）**：A) constraint-evidence/* 30 天 ≥5 条且 ≥1 identity-shaped；B) ≥1 条带 turn-pointer 的「当前写路对 identity-class 事实塑形错误」实例；C) ≥10 条可 replay 回放的历史 identity-shaped 事实。**无触发 = 继续 deferred 的信号，不是「拖太久该做了」的提示**——auto-continuation 不得把本行当「next unstarted phase / genuinely-new」重新索取（已知 relitigation 回路）。激活时同一改动必须把 `identity-evidence-envelope/v1` 加入 event-scan `FOREIGN_SKIP_ENVELOPE_SCHEMAS`（防 coverageRatio 塌缩），parallel-write 不替换 Lane G，projector 用真实事件验收不得 synthetic。约束续旧：每面单独通过真实使用证据；不新增 ADR 0028 之外全局存储轴；禁止一次性重写全系统。 |
| P8 unified ledger/schema review | 至少两个域完成迁移后，再评估是否需要共享 Evidence Ledger / schema。 | 默认保持 markdown + git 与分域落地；完整全域 event sourcing 数据库仍是 deferred exploration。 |

## ADR 0035 — memory stage1 embedding 候选检索实施

[ADR 0035](./adr/0035-memory-stage1-embedding-candidate-retrieval.md)(Accepted;3×T0 跨厂商盲审 opus-4-8/gpt-5.5/deepseek-v4-pro 一致 RATIFY WITH REVISIONS,修订集已并入)的分阶段实施。stage1 候选面从 full-body 全库海选改为 embedding 向量检索 + LLM 精选小候选集,成本从 O(库×频率) 降为 O(N);supersede ADR 0015 的 stage1 候选面决策,保留其双阶段框架 + result-cache 禁令 + freshness 契约。

**Phase 0 前置确认(已完成)**:embedding provider `doubao-embedding-vision` @ sub2api 网关(`/v1/embeddings`,dim 2048,batch≤10)配通实测;走方舟 Coding Plan 订阅额度(cost=0,非 metered);ToS 核实——embedding 为 Coding Plan 官方功能(2026-03-31 上线,RAG/agent-memory/OpenViking 用途),无违约风险;约束 TPM 600K/min(全库 embed 限流分批 ~4min)+ 按调用次数消耗套餐额度。召回实测 related-recall top-100=98%(ground truth 用 derives_from/related,有正偏,见 ADR §3)。

| Phase | Intent | 盲审硬约束 |
|---|---|---|
| P1 embedding 基建 ✅ | 向量索引模块(abrain `.state`,content-hash keyed 失效 + embedding-model 版本戳);embed 封装(batch≤10 + TPM 限流 + 重试);纯 JS 余弦 top-N + scope-filter-before-topN;全库初始 embed(实测 2350 向量,12 project + world)。已 ship(`embedding.ts` + smoke) | content-hash 失效(metadata-only 不 re-embed);版本戳跨模型禁混用;索引不入 git;scope 按物理位置 |
| P2 写入路径增量 embed(sediment 侧,ADR 0003)✅ | **方向 B(P2 盲审改,ADR §46)**:freshness 改 search-time content-hash diff(`staleOrMissingSlugs`:内存 entries vs 索引,未索引+陈旧 bounded-union),**无 dirty-manifest**(deferred 到物理分区);reconcile = agent_end `tryAutoWriteLane` 写后 best-effort `reconcileEmbeddings`(content-hash gated + scope-safe prune + 文件锁串行 RMW);修 4 高危 bug(全局 prune 删他 project / 无锁 / coverage 只看 slug / hard-delete 残留)。已 ship(`embedding.ts` + `sediment/index.ts` + smoke 16/16) | freshness:search-time diff 天然覆盖手工编辑/git pull/crash;reconcile 失败不阻塞 sediment,search bounded-union 兜底,禁回退全库 |
| P3 stage1 改造(3×T0 盲审修订已并入,ADR §7) | 抽 `runTwoStageSearch` 内核(两函数折叠,stage0 集成一次);stage0 = query embed → hybrid(dense topN[**corpus allow-set** 非 scopeTagOf] ∪ sparse[trigger/title/slug/**body**] ∪ staleOrMissing bounded),候选面**硬上限 ~300**;feature flag `stage0Enabled` 默认 off(dark-launch) | insufficient_pool 用**结构信号 pool<K** 非绝对 cosine 在线门;熔断**禁静默**(metrics+持久状态+短超时)+ sparse-only 兜底禁全库;扩召一次有界(topN×3 上限 ~400);非-active-status 查询回退全 corpus;verdict=none 改 **pool-relative** 语义;stage1Limit≥池;oracle **离线 replay** 非 inline 双跑 |
| P4 A/B 灰度 + 转产硬门 ✅ | `oracle:stage0` 离线 replay(full-body vs stage0 coverage/parity)+ `search-metrics.jsonl` stage0 字段(pool_hit/fallback/best_dense_rank/stale/embed_ms, `smoke:stage0-metrics` 验证)。**stage0Enabled flag 已开(dark-launch)** | **转产硬门达标**:21 query 强 baseline(v4-pro)coverage **95.1% ≥95%**(中文 11=92.4% + 英文/config 10=98%);baseline 必须强 model(flash 噪声拉低, 见 ADR §7);parity 低是 stage1/2 选择差异非召回问题 |
| P5 切换 + 旧 surface 下线 ✅ | stage0 成默认(`DEFAULT_SEARCH_SETTINGS.stage0Enabled=true`, settings.json 移除显式 flag 单源);`full_body_v3` 退役为 flag-off kill-switch + oracle baseline;收敛权重 poolLimit 300/maxCand 400/sparse 3:1(oracle tuning 从 200/300 提升) | **oracle final 21 query 强 baseline coverage 98.1% ≥95%**(19/21 query 100%; 200/300=94.1% → 300/400=98.1%);走偏信号监控(top-100<95% / verdict=none 率升 / best-rank 劣化)回看;kill-switch + 安全网双触发 + search-time freshness 兜底 |
| P6 方向 B 事后 review + freshness 饥饿修复 ✅ | 4×T0(opus/gpt-5.5/deepseek-v4-pro/kimi-k2.6)读代码独立 review 方向 B → 4/4 REVISE-B(不返工 A);揭出 stale 饱和饥饿 bug → `selectStage0Pool` 加 stale floor(`stage0StaleFloorRatio` 0.1, updated desc 优先, 下限非上限);`smoke-stage0-freshness` 对照守护 | **freshness 不变量兑现**:floor=0.1 probe 必进/floor=0 被挤出;oracle 21 query 强 baseline coverage 97.3% 无回归;应改(reconcile 解耦写/冷启动 rebuild 异步/截断一致性)记 ADR §7 backlog |
| P8 stage1 紧凑 surface 降本(探索, dark-launch off) | flag `stage1CompactSurface`(off); stage1 去 compiledTruth/timeline 粗筛, body 留 stage2; `oracle:compact-surface` 对比 + prompt-surface 对齐修复 | token 304K→52K(降 83%) 但生产模型 flash recall coverage 54.4% vs 基线 67.5%(差 13 点, 弱模型损失放大); 4×T0 DARK-LAUNCH 不转正; 待 stage1-50 度量+21×3 重复+compact-v2 薄证据+sediment 路径验证 |
| P7 非-active 查询 stage0 化(sediment 去重漏洞) ✅ | 4×T0 设计 review: sediment curator 去重 search(status:["all"])触发 wantsNonActive→null→每轮全库 full_body 915K。修:(1) 删 wantsNonActive→null 走 hybrid; (2) load-bearing: staleOrMissingSlugs 只算可索引集(active 且非 zone:rules), 防非 active+rule neighbors 塞爆 stale | `smoke-stage0-nonactive`(不回退全库+55 不可索引 probe staleCount=0+相关非 active sparse 召回) + oracle active coverage 100% 无回归; backlog: 中文 sparse 弱/防复发 guard/dedup oracle |

**待定参数**(灰度收敛):候选集 N(初始 100);hybrid 权重 + sparse 字段集;向量存储格式(JSON 单文件 vs JSONL 增量 vs abrain-state sqlite,含 >5000 迁移);单向量 vs 多向量(解决实验 `[:3500]` 截断盲区);embedding provider 长期选型(doubao 现成首选,备选恢复 Bailian text-embedding-v4 / 启用 Gemini)。

## Architecture debt

| Item | Intent |
|---|---|
| Schema evolution | frontmatter/audit/binding schema 的 version upgrade path（当前 `schema_version: 1` 字段已写入，缺多版本兼容/迁移策略）。 |
| Runtime path docs/tests | 避免 `.pensieve`/`.pi-astack`/`.abrain .state` 路径漂移。 |
| Model fallback vs curator whitelist | 当前 model-curator session_start 只 WARN，不阻止 curator 删掉 fallback 候选；需要 curator 在 whitelist 时尊重 fallbackModels 列表，或 fallback 路径自带 whitelist bypass。 |
| Audit 新字段默认 sanitize | 新加 audit 字段须默认走 `sanitizeAuditText`（曾有 explicit/auto-write lane 的 `candidates[].title` 漏 sanitize 的先例，已修；保留此项作纪律提醒）。 |
| constraint manual-compile 工具加固（dossier） | `scripts/dossier-constraint-shadow-report.mjs --write` 当前两个坑：① `makeOracleRegistry`（`scripts/_oracle-registry.mjs`）只解析 pi 内置 catalog，model-curator 运行时注册的模型（如 `minimax/MiniMax-M3`）解析不到 → 手动重编译只能退到 `--model deepseek/deepseek-v4-pro`（curator 官方 rollback）；② `--write` 直接覆写 `~/.abrain/.state/.../latest/compiled-view.md`，而 `rule-injector` 正注入它 → 手动跑会改写 live 注入。应：让 registry 复用 pi 运行时模型源（或 curator catalog），且 `--write` 默认指向 temp 树、覆写 live `.state` 需显式 `--force-live` + 响亮告警。另：dossier 的 TS stage 清单随 shadow-runner/parser 加依赖而 bitrot（已补 knowledge-evidence/append/projection/corpus-split，`23aa0c4`）——根因是手维护 stage 清单，可考虑共享 stage helper。 |
| legacy rule `body_hash` 漂移（21 条 global:always） | `legacy-scan.ts:69` 对 21 条 global:always 规则报 `SC_INPUT_BODY_HASH_MISMATCH`（frontmatter `body_hash` ≠ `sha256(当前正文)`）= legacy 规则正文被改/重渲染但 `body_hash` 没同步。非致命（仅 diff_report），但属输入数据漂移。应：批量重算并回写这些规则的 `body_hash`，或确认它们应被新证据投影取代后归档。 |

> ADR 0022 `prompt_user` 的 housekeeping batch（P3b post-audit / T0 xhigh / polish sweep 等 P2 项）已全部 ship 或 won't-fix；实施流水与 audit 轨迹见 git history 与 `docs/audits/`，不再镜像于此。

## Architecture invariants（已守护，禁止退化）

以下几条曾是 roadmap debt，2026-05-14 R5/R6 audit 已落地为不变量：未来 PR 退化这些行为应视为 regression。

> **行号策略**：每次大幅插入后行号会过期；改用 `file::symbol` 锚点（函数 / 常量名），仅在需要时附"~行号"提示多次插入后请重新 grep，不要依赖冻结的绝对行号。

| Invariant | 当前防线 |
|---|---|
| Dispatch sub-agent prompt 隔离 | `extensions/dispatch/index.ts` v3 in-process（`createAgentSession`）：每个 sub-agent 持独立 in-memory `SessionManager`，prompt 直接传入 `session.prompt()`，无共享临时文件（旧 v2 `runSubprocess`+`mkdtempSync("pi-dispatch-")` 已废）。`smoke:dispatch-subagent-tool-allowlist` 守护。 |
| Vault read/bash fail-closed | `extensions/abrain/index.ts` 中 `eventRegistry.on("tool_call", …)`（~L660） 与 `eventRegistry.on("tool_result", …)`（~L697）：`prepared.kind === "block"` 或 inject try/catch → `auditBashInjectBlock` + `return { block: true }`；tool_result authorization/redaction throw 全 withhold + `auditBashOutput("bash_output_withhold", …)`。 |
| Writer git rollback | `extensions/sediment/writer.ts` 中 `deleteProjectEntry`、`updateProjectEntry`、`writeProjectEntry`、`writeAbrainWorkflow` 在 `gitCommit()===null` 时 `git reset HEAD -- <rel>` + `fs.unlink(target)`；四条写路径均覆盖。 |
| Vault P1 active project resolver | 核心引擎在 `extensions/_shared/runtime.ts::resolveActiveProject`；`extensions/abrain/index.ts` 中 `parseSecretScopeFlags`/`resolveSecretScope`、`bootActiveProject` 快照（session_start）、`/secret` 命令处理；`extensions/abrain/vault-bash.ts::buildBootVaultBashDeps`（`$PVAULT_/$GVAULT_/$VAULT_` 路由 + `pvaultBlockReason` 拒绝）。`--project=<id>` 必须等于 boot-time 绑定；默认走 active project。 |
| Curator scope binding（非 create ops） | `extensions/sediment/curator.ts::effectiveScopeFor`（调用点在 update / merge / archive / supersede / delete）：以 neighbor 物理 scope 为准做 store routing（不信 LLM 声明），mixed-scope merge 仍硬拒（`scope_mismatch`）。旧 `validateScope` 硬拒码于 2026-06-06 mechanical-guard cleanup R2 改为 auto-correct（见 curator.ts:150-153 注释）；create 仍 prompt-only（下方 create-branch 行已加约束）。 |
| Migrate-go unknown frontmatter preservation | `extensions/memory/migrate-go.ts::preservedFrontmatterLines` + `buildNormalizedFrontmatter`：迁移路径保留未知 frontmatter raw lines。 |
| Memory store priority post-B5 cutover | `extensions/memory/parser.ts::resolveStores` 固定为 `abrain-project > world > legacy-pensieve`；`loadEntries` dedup 跨 store first-wins **不可被 confidence/updated 推翻**；`scanStore` 对 world 传 `WORLD_EXTRA_IGNORE_DIRS={projects,vault}`。 |
| Memory read-path kind/status 枚举归一 | `extensions/memory/parser.ts::normalizeKind`/`normalizeStatus` 在 parseEntry 里被调用：`entry.kind`/`entry.status` 总是 sediment/validation.ts ENTRY_KINDS/ENTRY_STATUSES 枚举之一；legacy `pipeline`/`knowledge` + 任意未知值被 fold 到最近的 canonical kind，原值保留在可选 `legacyKind`/`legacyStatus` 供 doctor。LLM-facing card 不再看到未声明的 kind。 |
| Curator create-branch scope binding | `extensions/sediment/curator.ts::parseDecision` create 分支加两条硬约束：(a) 每个 `derives_from` slug 必须在 allowedSlugs 中（防幻觉 slug）；(b) 若 `scope:"world"`，每个 `derives_from` neighbor 必须也是 world-scope（防漏 project context 进 world store）。project create 仍可从 world 派生（合法 specialization）。 |
| Sediment update/merge unknown frontmatter preservation 覆盖 | `scripts/smoke-memory-sediment.mjs` "fm-preserve" fixture：注入 unknown scalar/array、update body 无 patch / 有 patch 两路，验证 unknown 存活 + 保护 key 唯一 + parseEntry roundtrip。 |

## Pending flips（过渡态机械门，ADR 0024 §7.6 条款）

| 门 | flip/移除条件 | 证据源 |
|---|---|---|
| `tier1JaccardCuratorLane: false`（显式 rollback 时 Jaccard 自治 dedup 回到 Tier-1 kill path） | 已翻默认 true；保留此项作为 rollback 再评估条件：观察窗口（aggregator 30 天 / tail 行数限）内被裁决行（create/update/merge，error 不计）≥ 50 条 且 false-merge 份额（would_decision=create）≤ 5% | aggregator P1.5 watchdog `tier1_jaccard_shadow.flip_ready`（仅用于 rollback evidence/advisory，不机械自翻） |
| `conf≥8` 非指令 durable 过渡 fallback（correction-pipeline isTier1Directive，仅 no-target） | 审计窗口内 `tier1_direct_write` 中 `is_directive!==true && confidence>=8` 不再产生被用户纠正的 accepted corrections / recall misses → 移除 fallback 回 ADR 原文谓词 | `tier1_direct_write` audit 的 `is_directive` / `confidence` / correction outcome 维度（O5 sunset） |

## ADR 0031 — 自治自标定遗忘实施(复用既有 meta-curator infra,dark-launch)

设计见 [ADR 0031](./adr/0031-autonomous-self-calibrating-forgetting.md)(accepted)。原则:**先补标定数据(Lane G 当年缺的那块),再上可逆 demote;自治遗忘终点是 `archived`(全文留盘 = 复活面),本 ADR 范围内无自治物理删除;disuse 永不触发降级,真值变化(supersession/contradiction)才是安全驱动**。flag 守卫(代码 DEFAULT off);**运行时 flag 状态以 settings.json 为单一真相**(kill-switch-explicit-in-settings),当前 `memory.forgetting` 已启用 instrumentation/decayShadow/demoteShadow/autoDemote。

**架构基线(2×T0 gap 分析 2026-06-15):ADR 0031 不是新管线,是 ADR 0024/0025 meta-curator 生命周期的安全硬化层。强制复用,不重建**:
- 复活通道 = `archive-reactivation.ts`(已 LLM:keep_archived/reactivate/hard_archive_recommended + ledger)。
- 防振荡 hysteresis = `entry-telemetry.ts` 已 carry 的 `last_proposed_at`/`proposal_cooldown_until`/`holdout_until`(注释明言留给 “the gated executor (a later module)”)。
- 提议管线 = `entry-lifecycle-proposals.ts`(pending 观察,非授权队列)。
- 写路径 = `curator-decision-writer.ts` 的 archive op(已有 git lock + rollback)。
- 用量信号 = `usage-metrics.json`(读侧,本会话已建)+ `entry-telemetry.jsonl`(footnote/outcome 侧)——bridge 两者,不建第三套。
- **decay 判断按 AI-Native 扩展 `aggregator` 的 prompt-native historian**(已是「读运行状态→判断→pending lifecycle proposal」,且已含「retrieved-unused 单独不足以产生 proposal」= ADR 0031 §4 真值驱动),**不另建并行 deterministic scorer**(deepseek 方案否决:机械衰减公式判断「是否遗忘」违反 direction.md §2 AI-Native + ADR 0031 §2.2 prompt-native)。

**Phase 0 — instrumentation(零行为变化)**:
- ✅ 读侧 `retrieval_hit` / `cited`(`extensions/memory/usage-telemetry.ts` + 3 埋点;flag `memory.forgetting.instrumentation`,本会话已 ship)。
- resurrection 事件流已由 `archive-reactivation-ledger.jsonl` 覆盖(不新建)。
- 待补:supersede/contradict 信号喂进 aggregator 视图(真值变化驱动);demote 事件流 Phase 3 才需要。

**Phase 1 — would_demote 影子标记(只标不动)**:扩展 aggregator/lifecycle-proposal 消费 `usage-metrics.json` + `entry-telemetry` + supersede 信号,让 proposal 携带 `decay_score` / `would_demote` 影子字段(prompt-native);+ 影子回归(最近 N 真实 query 跑 corpus vs corpus−would_demote,量 decide brief 质量是否退)。**无 `would_delete`、无 tombstone-extra-fields、无 `git rm`**——`archived` 全文留盘即 tombstone(ADR 0031 §2.1 archived 地板)。

**Phase 2 — resurrection 稳态自标定(观测闭环)**:`resurrection-rate-monitor`(从 `archive-reactivation-ledger.jsonl` 算 rate + 趋势)→ 喂 aggregator 的 prompt-native 自调(更保守/更积极),噪声/近重信号复用 `entry-telemetry` echo_chamber + aggregator high_unused;自审闸 = resurrection rate 超阈值自动回退衰减强度。**低 resurrection rate 不当「安全」证明**(§2.2 非对称盲区)。

**Phase 3 — gated demote executor(可逆)✅ 已实现并接线**:`extensions/sediment/forgetting-executor.ts` + `sediment/index.ts` agent_end debounced 调度,消费 pending `op=archive` proposal + decay 上下文 + `entry-telemetry` hysteresis(cooldown/holdout/CAS)→ `active→archived`(注入式 `updateProjectEntry` + `expected_status:"active"` CAS);构建期焊死的反失控地板(`DEMOTE_MAX_PER_DAY=20`/`MIN_ACTIVE_CORPUS_FLOOR=50`/`DEMOTE_COOLDOWN_MS=30d`)+ demote 后监控 resurrection rate 自动回退;独立 audit lane。**运行模式以 settings flag 为准**:`demoteShadow`(代码 DEFAULT off)开 → 跑 executor;`autoDemote` 且 `autoLlmWriteEnabled===true` → 真实 demote,否则 dry-run(零 mutation,写 shadow audit)。当前两 flag 在 settings 已开(armed),但受数据门/限速地板约束,截至目前 on-disk 仅见 `forgetting-dry-run-audit.jsonl`(无 eligible proposal 触发真实 demote)。**物理删除(`git rm`)不在本 ADR 授权**——若将来需要,另起 supersession-gated 专门设计(独立论证持久性/灾备)。

**最小新写件**(gap 分析裁定,复用优先):`resurrection-rate-monitor`(纯确定性)+ `forgetting-executor`(gated)+ `demote-audit`(ledger)+ aggregator/proposal 的 `decay_score`/`would_demote` 字段扩展 + 影子回归 harness。**不新建**:reactivation 通道、tombstone 存储、hysteresis 存储、writer 路径、噪声检测、第三套 telemetry、`git rm`。

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd / BM25 optional acceleration | 旧 BM25/tf-idf 仅作为 deprecated dead code 留在 `extensions/memory/search.ts`，不是 `memory_search` fallback；可做离线诊断/加速实验。 |
| Cross-device abrain sync | 等真实多机冲突反馈；不要提前 over-engineer。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Skills/prompts/vendor port | `skills/`、`prompts/`、`vendor/gstack/` 仍是计划，不在 current repo tree。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
