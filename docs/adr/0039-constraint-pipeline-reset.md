---
doc_type: adr
status: accepted
---

# ADR 0039 - Constraint Pipeline Reset：约束写入改为 append-only 草稿事件 + 后台语义编译 + 稳定视图注入

- **Status**: Accepted（2026-06-18，R2 复审 4×T0 全部 SIGN，无架构 blocker）。
- **Date**: 2026-06-18
- **Relates-to**: [ADR 0003](./0003-main-session-read-only.md), [ADR 0016](./0016-sediment-as-llm-curator.md), [ADR 0023](./0023-session-start-rule-injection.md), [ADR 0024](./0024-second-brain-from-natural-conversation.md), [ADR 0025](./0025-sediment-meta-curator-subsystem.md), [ADR 0028](./0028-sediment-ground-truth-tiered-rearchitecture.md), [ADR 0031](./0031-autonomous-self-calibrating-forgetting.md)。
- **Revises-direction**: 修订 ADR 0028 在规则路径上的“Tier-1 直接确定性提交”形态：用户显式约束仍是高优先级真实信号，但不再在 `agent_end` 实时 mutate active rules；它先成为 append-only Constraint Draft/Event，再由后台 compiler 生成稳定的 Compiled Constraint View。

## 1. 背景：规则治理进入持续修补状态

近期对 rules 区的实际维护暴露出同一类结构性问题：关于行业黑话的多条近重规则需要合并为一条 compact always 约束；关于 Unicode 转义的规则需要确认不存在重复；模型分层、`dispatch_hub` 工具使用方式、`sub2api` 同步策略、`pi-astack` 方法论、PR 中文要求等条目又暴露出配置策略、工具声明、项目约定被错误提升为全局 rule。每个具体问题都能通过 classifier prompt、ruleset adjudicator、writer lint、scope 修正等局部手段临时修复，但这些修复本身不断增加新的边界与特例，说明根因不在某个 prompt 或某个函数，而在规则写入形态本身。

现有规则路径把至少四类不同语义放进同一个 active rules 写入路径：用户或项目行为约束、事实或经验知识、运行配置策略、工具调用契约。随后系统在实时 `agent_end` 路径里尝试完成分类、去重、合并、压缩、作用域判断、归档、注入层选择，并直接修改 active rule 文件。这个设计把高不确定性的语义裁决放进高影响的写时 mutation 中，于是每次新的边界案例都会生成新的机械补丁：相似度阈值、固定 body 大小降级、归档数量上限、跨目录移动限制、scope 例外、工具与配置的特殊排除等。

本 ADR 记录一次基于 4×T0 多轮讨论达成的重新设计方向。讨论明确要求主会话不裁决，每轮都询问是否存在更好的方案；第三轮四个 T0 对同一候选方案全部 `SIGN`，无架构阻断项；ADR 草稿 R2 复审再次 4×T0 全部 `SIGN`。完整评审记录见 [`docs/audits/2026-06-18-adr-0039-constraint-pipeline-reset-t0-review.md`](../audits/2026-06-18-adr-0039-constraint-pipeline-reset-t0-review.md)，本 ADR 只保留影响决策有效性的摘要。

## 2. 决策

采用 **Constraint Pipeline Reset**：约束写入改为 `append-only Constraint Draft/Event → 后台语义编译 → session_start 读取稳定 Compiled Constraint View`。`agent_end` 不再直接 create/merge/archive/rescope active rules；它只把用户表达、上下文证据、scope 线索和 provenance 追加为低风险草稿事件。语义合并、去重、scope 校验、冲突检测、压缩与注入摘要生成全部转移到后台 compiler；`session_start` 只读取上一次稳定编译视图，若视图过期则注入旧稳定视图并提示 queued/stale，不在启动路径同步调用 LLM 重新裁决。

该决策将规则治理从“实时写时裁决 active 文件”改为“追加证据、异步编译稳定视图”。原始证据不被销毁；compiled view 是可重新生成的物化投影；active 注入面来自 compiled view，而不是直接来自写时 rule 文件状态。

## 3. 四域硬隔离

系统必须区分四个语义域，路由结果只决定信号去哪里，不作为永久存储本体轴继续膨胀。

| 域 | 含义 | 归宿 | 是否生成 memory rule 镜像 |
|---|---|---|---|
| Constraint | 用户偏好、跨项目硬约束、当前项目行为约定 | Constraint Draft/Event + Compiled Constraint View | 是，作为约束视图的一部分 |
| Knowledge | 事实、模式、经验、决策、反模式、观察 | 现有 knowledge/project memory 路径 | 否 |
| Settings | 模型分层、运行开关、预算、provider、功能 flag 等运行配置 | `pi-astack-settings.json` 或等价配置面 | 否 |
| Tool Contract | 工具调用方式、工具前置条件、工具安全约束、工具选择规则 | tool declaration、SKILL.md、代码声明 | 否 |

配置策略和工具契约不得通过“创建一条 global rule”来表达。如果用户自然语言中提出配置或工具契约相关要求，sediment 可以记录 notify/audit 诊断，说明该信号不属于 memory rule；真正变更必须走正常代码或配置修改流程。

## 4. Scope 保守策略

约束默认进入最窄可证明 scope。存在 active project binding 且用户未显式声明跨项目时，项目行为约定进入 project scope；global 仅允许显式跨项目信号（例如“所有项目”“以后每次”“全局”）或跨多个项目重复出现并由 compiler 解释为稳定跨项目偏好。项目名称、路径、仓库、技术栈、客户、业务流程等项目特定证据一旦出现在候选约束中，compiler 必须优先保持 project scope 或降级为 project scope。

这个策略反转了旧路径中“没看到项目标记就可能 global”的风险。错写 global 会污染所有项目；漏写 global 可以通过后续重复证据被 compiler 升级。因此 scope 的安全默认值是保守，而不是积极。

## 5. 写路径：只追加 Draft/Event

`agent_end` 对 Constraint 域只执行一个低风险写原语：append sanitized draft/event。draft/event 至少包含用户原话 quote、role provenance、session-id、turn-id、时间、active project binding、候选 scope、自然语言上下文摘要、相关已有条目或草稿的只读检索结果摘要、信号类型说明、以及 sanitizer 结果。该事件是原始证据，不是最终规则。

`agent_end` 不执行以下操作：直接创建 active rule、直接更新 active rule、直接归档旧 rule、直接跨 scope 迁移、直接决定 always/listed、直接物理删除、直接将 settings/tool 信号复制为 rule。失败时宁可只留下 queued/audit 状态，也不能静默丢失用户显式约束。

写前必须读取相关已有条目或草稿，作为 draft/event 的上下文证据。这里的“写前查已有”不再表示写时必须完成 merge/update 决策，而是表示 draft/event 不得盲写；compiler 后续综合时必须能看到“当时已知的邻近语义环境”。

## 6. 编译阶段：唯一语义综合点

后台 compiler 读取 Constraint Draft/Event、当前 Compiled Constraint View、相关既有 memory、scope 证据和 audit 线索，产出新的 Compiled Constraint View。compiler 执行语义合并、去重、冲突检测、scope 校验、配置/工具信号排除、文本压缩、优先级排序和注入摘要生成。compiler 是可重试、可观察、可审计的后台阶段，不阻塞主对话。

compiler 必须记录来源 draft/event hash 集合、输入 compiled view hash、输出 compiled view hash、模型、时间、审计摘要和失败原因。运行时恢复路径是由系统恢复上一份稳定 compiled view，且保留的 append-only draft/event 使 compiler 可重新生成约束视图；该路径不依赖人类手动编辑 abrain，也不依赖人类执行 git revert。重新编译是可审计的再生成，不应被描述为确定性恢复。git 仍是离线灾备和审计基座，不是自治运行时恢复面。

compiler 对冲突不应自动销毁证据。默认策略是把冲突显式呈现在 compiled view 的 conflict 区或候选解释中：更新证据足够强时可在投影层 supersede 旧约束，但原始 draft/event 保留；证据不足时保留两者并降低注入优先级或标注 contested。

compiler 必须有活性保证。至少需要一个 drain-loop 或 session_start stale 检测后的异步触发机制，确保 draft/event 最终进入编译，而不是永久停留在 queued 状态。

## 7. 读取阶段：只读稳定 Compiled Constraint View

`session_start` 只读取已物化的 Compiled Constraint View 作为约束注入来源，不做高延迟 LLM 裁决。若存在未编译草稿或 compiled view stale，则注入上一版稳定视图，并在 catalog 或状态反馈中提示存在 queued/stale 约束，等待后台 compiler 处理。这样读路径延迟稳定，且不会因每次启动的 LLM 重新裁决导致注入内容抖动。

`always/listed/inject_mode` 不再是写入层事实。compiled constraints 是稳定语义视图；injector 按预算、provenance、scope、硬约束程度、compactness 和当前 session 需要决定注入形态。用户明确的短硬约束可以被编译为 always-worthy compact 文本，但 writer 不再以固定 body 字数在写时自动降级或改变事实。

## 8. 可逆性与存储关系

Constraint Draft/Event 是 append-only 原始证据；Compiled Constraint View 是从证据和当前语义状态生成的物化视图。archive/delete/rescope 不直接销毁原始证据，只改变 compiled 投影或追加新的 retraction/supersession draft/event。该设计在 Constraint 域类比并继承 ADR 0031 的可逆自治边界：自治生命周期动作必须有运行时可达的恢复路径，不能依赖人类手动编辑 abrain，也不能依赖人类执行 git revert；append-only draft/event 是运行时 tombstone，上一份稳定 compiled view 是可恢复投影。

本 ADR 不要求为全 memory 建立完整事件存储系统。append-only 约束事件只作用于 Constraint 域，且可用 markdown/git 现有基座实现；它不是独立数据库，也不是把所有知识写入都历史化。git 仍是持久化与恢复基础，compiler 的 materialized view 只是读取面优化。

## 9. 删除的认知层机械门与保留的基础设施

本 ADR 要删除或停用规则路径中的认知层机械门：Jaccard 或 token overlap 作为 merge/skip gate、固定 body size 写时 demote、`MAX_ARCHIVE_PER_OP` 这类语义风险的数量补丁、工具/配置/project scope 的硬编码特殊规则、写时直接 archive-after-create 顺序补丁、以及 active rules 上的多阶段写时裁决接力。

以下基础设施安全仍然保留：secret sanitizer、strict project binding、path safety、schema lint、atomic write、lock/lease、audit、session-id + turn-id causal anchor、source role provenance、git history。它们是基础设施正确性与来源边界，不替代 LLM 做语义裁决。

## 10. 对既有 ADR 的修订

ADR 0028 的 Tier-1 原则仍保留其核心：用户显式 durable directive 与 LLM 推断假设不是同一信号类，USER-role provenance 和 source gate 仍是硬边界，用户显式约束不得静默丢失。但本 ADR 修订 Tier-1 的写入形态：Tier-1 不再等于实时确定性提交 active rule，而是确定性 append Constraint Draft/Event；后续由 compiler 生成稳定 compiled constraint。

ADR 0023 的 rules 注入心智模型修订为 Compiled Constraint View 注入。rules 区不再是写时 source-of-truth active 文件集合，而是 compiled view 的呈现和兼容投影。实现迁移期间可以保留旧目录作为 legacy view，但新设计的权威语义来自 draft/event + compiler。

ADR 0024 的 INV-ACTIVE-CORRECTION 得到保留：用户自然提出“以后用 X”“忘掉那条”“这不是全局规则”等仍是核心信号通道。区别在于系统不要求用户审批，也不在实时路径做高影响 mutation，而是把纠错追加为证据并由 compiler 汇总。

## 11. 迁移边界

架构迁移策略写入 [`docs/roadmap.md#constraint-pipeline-reset-migration`](../roadmap.md#constraint-pipeline-reset-migration)；本 ADR 只固定决策边界。迁移必须先 shadow 编译现有 rules 并生成 diff 报告，再启用 Draft/Event 写入与 Compiled View 注入，最后停用旧 tier1-ruleset-adjudicator/rule-writer 的认知裁决职责；具体 phase、验收指标和实施顺序不写入 ADR 正文，随 dogfood 证据在 roadmap/audit 中演进。

## 12. 接受的代价与风险

后台 compiler 可能延迟，导致用户刚说出的约束不能在下一次会话立即进入 compiled view。接受该代价，因为它换来主对话低延迟、写路径低风险和可重试编译。状态反馈必须告诉用户存在 queued/stale，但不能要求用户审批。

compiler 是新的复杂组件，可能产生错误合并或 scope 判断错误。接受该代价，因为错误发生在可重新生成的 compiled view 中，原始 draft/event 保留，恢复成本低于直接修改 active rules。compiler prompt 和评估应基于真实 draft/event 与 shadow diff，而不是只用合成 fixture。

配置或工具信号被判为 not-memory 后，相关配置或工具声明不会自动改变。接受该代价，因为配置和工具契约的实际变更属于代码或配置修改流程，不能通过 memory rule 镜像间接表达。系统应提供清晰 notify/audit，使后续实现任务能处理这些诊断。

compiled view 可能随 compiler 改进而变化。接受该代价，但 compiled view 必须记录来源 hash 和生成审计，避免无解释漂移。读取路径使用上一次稳定视图，避免每次 session_start 重新裁决导致抖动。

## 13. 走偏信号

如果 queued draft 长期不被编译，说明 compiler 活性不成立，需要先修 drain-loop 或 stale-trigger，而不是恢复实时写时裁决。

如果 settings/tool 信号继续出现在 global constraints，说明四域隔离失败，应修 router/compiler prompt 与 not-memory 诊断，而不是为每个工具或配置再新增 global 排除规则。

如果 project-specific constraint 继续进入 global，说明 scope 保守策略失败，应修 scope rubric 与 project binding 证据呈现，而不是新增项目名黑名单。

如果 compiler 频繁生成大规模无解释重写，说明编译过度自信，应要求输出 conflict/uncertainty 区和来源 hash，而不是新增固定归档数量上限。

如果 compiled view 过长导致注入噪音，说明 compiler compression 和 injector budget policy 失败，应改编译摘要和注入策略，而不是恢复 writer 的固定 body size demote。

## 14. 评审摘要

第一轮四个 T0 独立提出方案：全上下文 Reconciler、语义对象模型与可逆 diff、constraint taxonomy、C/K/S 三层分离。所有方案都承认现有规则路径存在结构性问题，并且必须将 settings/tool/project/global 的边界从全局 rules 中拆出。

第二轮交叉辩论形成关键收敛：纯写时 Reconciler 仍会保留 active mutation 的竞态和顺序问题；纯 session_start 动态裁决会引入启动延迟与抖动；完整全域 event sourcing 过重；更优折中是 append-only 草稿事件 + 后台 compiler + 稳定 compiled view。

第三轮对本 ADR 的候选骨架进行签署检查。Opus、GPT-5.5、DeepSeek、Kimi-k2.6 全部 `SIGN`，无架构 blocker。ADR 草稿 R1 出现两个文本 blocker：`git revert` 恢复路径与 ADR 0031 冲突、迁移 phase 流水侵入 ADR 正文；R2 修订后四个 T0 全部 `SIGN`。非阻断实现注意事项包括 compiler 活性保证、compiled view 的来源 hash、上一份稳定 compiled view 作为运行时恢复投影、冲突策略显式化，以及 Knowledge 域边界在实施前单独明确。

## 15. 这份 ADR 不是什么

不是要求用户审批规则写入；用户仍然不参与大脑管理。

不是让主会话写 memory；主会话仍然只读，sediment 是唯一写入者。

不是把所有 memory 都改成完整 event sourcing；append-only draft/event 只用于 Constraint 域。

不是禁止 notify/audit；告诉用户 queued/stale/compiled 状态是健康反馈，不是管理负担。

不是删除 AI 语义判断；语义判断从实时破坏性写时路径移动到后台可重试 compiler。

不是把配置或工具声明藏进 memory；settings/tool 有自己的归宿，memory 只可记录 not-memory 诊断与审计。