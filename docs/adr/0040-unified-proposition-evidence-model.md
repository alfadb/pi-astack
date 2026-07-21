---
doc_type: adr
status: accepted
---

# ADR 0040 - Unified Proposition Evidence Model：统一命题证据模型与无迁移切换边界

- **Status**: Accepted（2026-07-12，OpenAI / Anthropic / DeepSeek / Moonshot / MiniMax / Z.ai 六厂商 T0 三轮独立讨论、交叉收敛一致同意，用户 ratify；随后用户修正 no-migration cutover 与阶段授权边界，本文已并入）。
- **Date**: 2026-07-12。
- **Relates-to**: [ADR 0023](./0023-session-start-rule-injection.md), [ADR 0024](./0024-second-brain-from-natural-conversation.md), [ADR 0028](./0028-sediment-ground-truth-tiered-rearchitecture.md), [ADR 0031](./0031-autonomous-self-calibrating-forgetting.md), [ADR 0039](./0039-constraint-pipeline-reset.md)。
- **Supersedes-direction**: 本 ADR 继承 ADR 0039 的统一 Evidence、L1/L2/L3 存储分层、append-only L1 SOT 与确定性 L2 renderer 原则；本 ADR 取代“Knowledge 与 Rule/Constraint 可继续保有域级 canonical 本体、独立 canonical store、重复生命周期并通过迁移层延续权威”的口径，选择统一 proposition/lifecycle SOT 与 no-migration cutover。
- **Implementation status**: 2026-07-20 production full flip 已完成；2026-07-21 用户进一步授权 deterministic derived publication 的完全自动恢复，包括 strict compile 成功后自动发布并切换 `latest`、无需每设备人工 grant。runtime reader 仍 fail-closed/no fallback。当前事实以 [Current State](../current-state.md) 为准。

## 1. 背景与事故根因

ADR 0039 已把长期记忆从 raw `agent_end` 写时裁决推进到 Evidence Event → projector / compiler → stable view，但该架构仍可能被实现为多个域级本体：Knowledge 有自己的 canonical entry，Rule/Constraint 有自己的 canonical rule store、compiled rule view 与生命周期。这会让同一用户命题在 pull 与 push 两个消费面拥有不同真相，并把 retract、rescope、supersede、archive、reactivate 重复实现成多套协议。

当前事故的直接根因是 task/session 指令被误判为 durable normative content，同时 provenance、空间 scope、temporal horizon 与 always 注入资格被耦合成单一“规则”事实；系统又缺少生产撤销闭环，导致错误一旦进入 compiled / always injection 面，就只能靠局部代码补丁、手工清理或新规则覆盖，而不是通过同一证据链追加撤销或重定界事件来收敛。

六厂商 T0 三轮一致认为，问题不应通过更复杂的规则本体、规则 graph 或旧规则迁移层解决。Knowledge 与 Policy/Constraint/session-start 的差异是读取契约差异，不是真相源差异；统一必须发生在 append-only L1 Evidence SOT、typed proposition 与共享生命周期协议，而不是发生在运行时消费面。

## 2. 决策

用户侧所有持久认知内容都可以统称为“知识”：偏好、约束、事实、项目习惯、纠错、撤销、生命周期说明都属于用户期望系统长期记住或长期参考的认知内容。内部唯一 canonical 真相源是 append-only、content-addressed L1 Evidence SOT；stable knowledge corpus、policy view、constraint compiled view、session-start injection view、rationale view 与其它读取面都是该 SOT 的投影。

取消独立规则本体、独立 canonical store 和重复生命周期。任何 projector、compiler、writer 或 runtime consumer 都不得把 Rule / Constraint 作为可独立承载真相的 ontology、store 或 lifecycle ledger 重新引入；Rule / Constraint 只能是 policy / injection projector 对统一 proposition evidence 的消费视图。

保留 Knowledge/Search pull 与 Policy/Constraint/session-start push 的独立 projector/read contract。`memory_search`、`memory_get`、`memory_decide` 等 pull 面可以使用适合召回、排序和解释的投影；session-start 或其它 push 面可以使用适合稳定注入、压缩、scope 过滤和失败可见性的投影。两类读取面可以有不同 freshness、预算、排序、失败语义和文本形态，但必须能用同一 L1 event lineage 解释差异。

## 3. Typed proposition 与正交 facets

Typed proposition 至少包含三类：`descriptive`、`normative`、`meta-lifecycle`。`descriptive` 表达关于用户、项目、系统状态或世界的描述性主张；`normative` 表达偏好、约束、方法、行为义务或应避免的做法；`meta-lifecycle` 表达对既有 proposition evidence 的 retract、rescope、supersede、archive、reactivate 等生命周期动作。

命题类型不是 provenance、authority、scope、maturity、trigger、temporal horizon、contestability 或读取模式的替代品。至少以下 facets 必须保持正交：provenance / authority、spatial scope、temporal horizon、trigger、maturity、contestability、confidence、sensitivity、consumer hints 与 causal lineage。实现可以分阶段选择字段名和编码，但不得把这些 facets 压成单一 rule kind、单一 tier、单一 inject mode 或单一生命周期状态。

`normative` 只表示“这是一个可能影响行为的命题”，不自动表示“必须 session_start 注入”。`descriptive` 也可能被 policy projector 用作上下文约束。`meta-lifecycle` 本身不得被编译成新的行为义务；它只改变 projector 对目标 proposition 集合的有效性解释。

## 4. Projector、读取契约与 session_start

`session_start` 不调用 LLM，不扫描原始 L1 event 集合，也不在启动路径实时裁决命题是否应注入。production rule authority 对所有 persisted main session 只读取 current `ABRAIN_ROOT`（未设置时 `HOME/.abrain`）下 `.state/sediment/proposition-policy-stable-view/v1/latest` 捕获的 immutable content-addressed bundle；ephemeral main session 与 subagent 不注入。runtime 不再具有 session selector、expected bundle hash、selection age authorization gate，也不回退 compiled-view、D3 或 legacy rules。stale 只产生可见诊断并继续注入已严格验证的稳定 view；missing、partial、hash/schema/provenance 不一致、越界路径或预算超限均 loud fail-closed 为 zero injection，且不得恢复旧 runtime source。

2026-07-21 的新增授权不改变上述 reader 契约。只有 canonical startup/recovery 已证明 ready 后，独立 detached recovery 才可从 current canonical whole-L1 strict scan，经正式 P2a projection、固定 compile profile 与 production publisher 重建 derived stable view；TUI/RPC `session_start` 不等待。strict deterministic compile 通过后可自动发布并原子切换 `latest`，无需每设备人工 grant；完成后必须由同一 strict runtime reader 验证 `selected_valid` 才可报告 recovered。reader 不获得写权限、不做 lazy repair，恢复期间继续 loud zero。constraint-shadow、D3、legacy rules 与任何 LLM 语义推断都不是恢复输入；symlink、foreign root entry、content collision 或无法证明归属的残留不得自动删除。

需要 LLM 参与的语义裁决必须发生在 projector / compiler 阶段。LLM 输出若影响 stable L2 或 runtime policy view，必须先冻结为新的 L1 projection event 或等价的 L1 evidence，记录模型、prompt / input / output hash、sanitizer、acceptance 与 causal parents；随后由确定性 renderer 渲染 L2 或 runtime-readable stable view。最终 L2 字节生成不得直接调用 LLM。

`injectMode`、session-start eligibility、always/listed/omitted、priority 和注入摘要都不是写时事实。它们是 Policy/Constraint/session-start projector 根据 proposition type、facets、consumer、scope、temporal horizon、maturity、contestability、budget 与当前稳定策略派生出的读取决策。旧 schema 中的 priority 或 inject hint 最多是 evidence hint，不能覆盖 projector 的派生责任。

## 5. 共享生命周期协议

所有长期记忆域共享 `retract`、`rescope`、`supersede`、`archive`、`reactivate` 的追加事件协议。生命周期动作必须写成新的 immutable L1 `meta-lifecycle` evidence，并通过 `causal_parents` 精确引用被作用的 proposition event、projection event 或 lifecycle event；不得原地修改、删除或重写目标 L1 event，不得把 derived view 手工编辑当作生命周期动作。

`retract` 表示目标命题不再进入 active projection，但目标证据与撤销证据均保留在 L1 审计链。`rescope` 表示为目标命题追加新的空间或适用范围解释，而不篡改原始证据。`supersede` 表示新命题替代旧命题，并保留新旧 causal lineage。`archive` 表示降低运行时可见性，同时保留 ADR 0031 要求的复活面。`reactivate` 表示追加恢复事件并引用被恢复关系。

Projector 必须先解析生命周期关系，再形成有效 proposition 集合。未知 parent、非法 parent 类型、无法证明的 scope 关系、不兼容 schema 或跨域引用不明时必须 fail-closed 并保留诊断；重复 lifecycle event 必须幂等，或在固定排序下产生同一有效集合与同一审计关系。所有证据保留；普通物理删除不属于本协议授权。

## 6. 平台硬边界

平台安全、密钥、权限、路径、工具参数、provider contract、tool allowlist、path traversal、secret / PII 泄漏防线、L1 hash 校验与授权边界由 code、tool declaration、配置和基础设施 policy 执行。它们不是可学习 proposition，不能通过 `normative` evidence 放宽、撤销或重定义。

记忆可以记录这些边界的 rationale、diagnostic 或用户关于工具体验的偏好，但 projector 不得把这类记录编译成绕过代码或工具策略的行为授权。该边界不否定 prompt-native 语义判断：命题识别、scope 解释、冲突综合和投影表达仍由 projector / compiler 处理，代码负责不可变性、授权、schema、路径和 fail-closed 等基础设施不变量。

## 7. No-migration cutover

用户明确作出的 no-migration 决策是：现有所有 rules、constraint evidence、compiled rules、legacy always/listed/injectMode 信息、旧 compiled view 与旧规则目录，不迁移、不转换、不自动激活进新的 normative projection。它们可以作为冷审计历史保留，用于人类或 agent 事后理解旧系统行为，但不在新 policy view 中拥有 runtime authority。

新的 policy view 必须从明确 genesis / cutover 边界开始。cutover 之后需要继续生效的规范，由用户后续自然语言、显式纠错或新的生产 evidence 自然形成；系统不得为兼容旧规则设计迁移层，不得把旧规则批量重解释为新 normative proposition，不得通过“保守迁移”“只迁移高置信规则”或“先全部激活再撤销”绕过该决定。

2026-07-20 用户进一步直接授权 production runtime full flip：旧 compiled-view、D3 session-start 与 legacy rule injection 从 production 调用图退休，只保留离线诊断与历史证据用途；它们不再是 fallback、canary、rollback 或并行 authority。新的 normative runtime authority 只来自 genesis/cutover 后 L1 evidence 所生成并严格验证的 Policy stable view。

## 8. 阶段授权边界

实施阶段不得合并成一次性全域迁移；上一阶段完成不授权下一阶段。

ADR acceptance 不授权代码切换、schema 写入、production mutation、runtime read flip 或 legacy authority retirement。

每个读取面必须独立提供证据、失败语义与 fresh authorization；一个读取面的 cutover 不授权其它读取面。2026-07-20 用户对 Policy/session-start push 读取面给出直接 full-flip 授权，并明确无回退，因此该读取面的终态失败策略是 loud zero injection，而不是恢复任何旧 authority。2026-07-21 用户又对同一读取面的 deterministic derived publication 给出 full-auto recovery 授权：canonical-ready 后 strict compile 成功即可自动发布/切换，无每设备人工 grant；该授权不扩展到其它读取面，也不把任何旧 authority 重新纳入输入或 fallback。

## 9. 与 ADR 0039 的关系

本 ADR supersede 的不是 ADR 0039 的统一 Evidence 架构，而是对 ADR 0039 的一种过窄实现解释：把 Knowledge、Rule、Constraint 等域视为各自拥有 canonical 本体、store 和生命周期，只通过 Evidence Event 做输入同步或迁移。该解释会重新制造 split-brain，本 ADR 明确取消。

ADR 0039 仍是 L1/L2/L3、content-addressed append-only L1 SOT、确定性 L2 renderer、L3 可重建索引、session_start 读 stable view、LLM 输出先固化为 L1 projection event、derived view 不可手工反写等原则的基础。ADR 0040 在这些原则上增加统一 typed proposition、正交 facets、共享 lifecycle、no-migration cutover 与逐读取面授权。

本 ADR 不声称这些原则已经全部实现。当前实现真相仍以代码与 `docs/current-state.md` 为准；未完成工作登记在 `docs/roadmap.md`，不写入本 ADR 正文作为已完成状态。

## 10. 被拒绝方案

拒绝独立 Rule ontology、Rule graph、Rule lifecycle ledger 或专用 canonical rule store，因为它们会重新制造 Knowledge 与 Policy 之间的真相分裂。拒绝把所有消费面合成单一 projector，因为 pull 与 push 的 freshness、风险、预算和失败语义不同。拒绝把 `injectMode` 或 always eligibility 固化为 L1 写时事实，因为同一命题在不同 consumer、scope、时点和 maturity 下可能有不同注入决策。

拒绝把 hard safety 写成可撤回记忆规则，因为记忆生命周期不能授权绕过代码、工具、密钥、路径或权限边界。拒绝为旧 rules / compiled rules 设计迁移层，因为用户已选择 no-migration cutover；兼容迁移层会把旧事故根因带入新架构。拒绝一次性全域 read flip，因为各读取面需要独立生产证据、回退机制和 fresh multi-T0 授权。

## 11. 接受的代价

统一 proposition/lifecycle 语义会增加 projector 对 causal graph、facets、maturity、contestability 与 consumer contract 的解释责任。接受该复杂度，因为它集中在可重建投影层，避免长期维护多个本体、多个 store 与多个生命周期协议。

No-migration cutover 会让旧 rules / compiled rules 在新 policy view 中失去自动 runtime authority。接受该代价，因为旧 corpus 已混有错误 provenance、scope、temporal horizon 和 always 注入资格；迁移兼容会把这些错误伪装成新架构事实。必要规范通过 cutover 后自然语言重新形成，保留 cold audit 作为可解释历史。

分阶段实施延长了过渡期，并曾要求同一系统同时存在旧 runtime、shadow projection 和新 schema 设计。接受这段历史代价，因为它防止 ADR acceptance 被误用为生产切换授权；Policy/session-start 读取面在 2026-07-20 获得直接 full-flip 授权后不再维持该并行 runtime 过渡态。

## 12. 走偏信号

如果新增 rule 表、rule graph、rule lifecycle ledger 或专用 canonical store 承载不可从统一 L1 proposition evidence 重建的语义，说明独立规则本体正在复活。如果 Knowledge 与 Policy 对 retract/rescope/supersede/archive/reactivate 使用不同事件语义、不同 parent 规则或不同保留策略，说明共享生命周期协议失效。如果 writer 继续把 `injectMode`、always 或 session-start eligibility 当用户事实直接固化，说明派生决策边界失效。

如果 `session_start` 调用 LLM、同步扫描原始 L1、即时裁决注入资格或等待 stable-view 编译，说明 push read contract 被破坏。canonical-ready 后 detached deterministic recovery 不属于 reader/session-start 同步编译，但若它读取 constraint-shadow、D3、legacy rules，绕过正式 whole-L1/P2a/fixed-profile compiler，或 post-publication 未 strict read 就报告 recovered，同样说明边界失效。如果 LLM 综合结果未先固化为 L1 projection event 就直接生成 stable L2 或 runtime view，说明确定性 renderer 边界失效。如果 lifecycle event 进入 compiled behavior，或目标 L1 被修改、删除、重写，说明 immutable SOT 边界失效。

如果旧 rules、constraint evidence、compiled rules 或 legacy inject hints 被迁移、转换、批量重解释或自动激活进新 normative projection，说明 no-migration cutover 被破坏。如果一个阶段的通过导致另一个读取面自动 flip，说明逐阶段授权失效。如果记忆事件能够放宽 tool/path/secret/authorization/tool-parameter 边界，说明平台硬边界被错误下沉到记忆。

## 13. 评审摘要

六厂商 T0 三轮一致共识为：内部唯一 canonical 真相源是 append-only content-addressed L1 Evidence SOT；用户侧持久认知内容可统称知识；长期内容表达为 typed proposition，至少包括 descriptive、normative、meta-lifecycle；provenance / authority、spatial scope、temporal horizon、trigger、maturity、contestability 等是正交 facets；取消独立规则本体、独立 canonical store 和重复生命周期；保留 Knowledge/Search pull 与 Policy/Constraint/session-start push 的独立 projector/read contract；`session_start` 只读 stable view，不调用 LLM、不扫描原始 L1；`injectMode` 与 session-start eligibility 是派生决策；平台安全和工具硬边界归 code/tool policy；生命周期通过共享追加事件与 causal parent 协议表达；实施 shadow-first、逐读取面授权。

用户随后修正并 ratify 的关键边界为：现有所有 rules、constraint evidence、compiled rules 不迁移、不转换、不自动激活进新的 normative projection；旧材料只可作为 cold audit history 保留，不再拥有新 policy view 的 runtime authority；新 policy view 从明确 genesis/cutover 边界开始；不得为兼容旧规则设计迁移层。2026-07-20 用户又直接授权 Policy/session-start production full flip：所有 persisted main session 统一读取 Policy stable view，stale 仍注入，invalid/missing loud zero，compiled/D3/legacy runtime 无 fallback，ephemeral/subagent 排除。
