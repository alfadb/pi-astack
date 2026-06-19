# ADR 0039 Unified Evidence Architecture — 4×T0 修订审查记录

## 结论

ADR 0039 于 2026-06-19 经 4×T0 多轮审查后，从原 Constraint Pipeline Reset 修订为 Unified Evidence Architecture。主会话只负责组织审查、整合文本修订和记录结果，不裁决架构方案。

R2 结果为 4/4 SIGN，无架构 blocker。因此 ADR 0039 统一架构修订状态改为 accepted。

## 修订背景

原 ADR 0039 的 Constraint-only 版本已经在 2026-06-18 经 4×T0 多轮审查 accepted，但尚未实施。用户指出，Constraint 域暴露的问题不是局部规则路径问题，而是整个第二大脑记忆系统中“raw `agent_end` context 直接执行 canonical memory mutation”的结构风险。用户要求抛开现有 sediment 具体设计，由多个 T0 独立思考、交叉讨论，并在每轮回答“是否还有更好的方案”，最终由 T0 全体一致后定稿。

## R0 草稿

主会话将 ADR 0039 原地改写为统一架构草稿，保留原文件编号和路径，避免新增一个尚未实施即被吸收的 Constraint 特例。R0 草稿核心为：所有长期记忆先 append Evidence Event；canonical memory 是 Evidence Event 的物化投影；`agent_end` 不再从 raw transcript / raw context 直接执行 create、update、merge、archive、rescope、delete 等 canonical mutation；各域使用 domain-adaptive projector / compiler 生成 stable view。

R0 明确拒绝完整全域 event sourcing 数据库作为首期范围，保留 markdown + git 基座，并要求 Evidence Ledger 不替代 ADR 0031 的 `archived` 运行时复活通道。

## R1 审查

R1 对 `docs/adr/0039-constraint-pipeline-reset.md` R0 草稿进行逐文审查。

- Opus: REVISE。必须修改项：frontmatter 与正文状态不一致；§13 过早声明未发生的 R4 全部 SIGN；Tier-1 / REQ-004 的写入形态变更需要更明确地保留“对用户可见”和“不得静默丢失”；文件名、ADR README、roadmap 指针需要在 ratify 后同步；§9 迁移边界仍含过多实施顺序。
- GPT-5.5: REVISE。必须修改项：`status` 应为 proposed；评审摘要不得声明未发生的共识；补强 USER-role ∧ directive ∧ durable 的确定性 append witnessed Evidence Event；补充 extractor / classifier 不确定时的 unclassified / queued evidence；补充 REQ-009 hot overlay 边界；收紧术语。
- DeepSeek: SIGN。确认架构方向正确，无 hard invariant / REQ / ADR 冲突；建议定稿后同步 ADR README 与 roadmap。
- Kimi-k2.6: SIGN。确认统一证据架构与域自适应投影器是正确方向；建议补充 Tier-1 可见性、同步 projector 与 raw transcript 的边界、not-memory diagnostic 消费面。

R1 后主会话只执行文本修订：将状态改为 proposed；删除未发生的 R4 签署声明；新增术语表；补强显式用户信号不得静默丢失、unclassified / queued Evidence Event、REQ-004 可见性、REQ-009 hot overlay、同步 projector 不得重新解析 raw transcript、跨设备 merge 代价；将迁移流水移回 roadmap。

## R2 复审

R2 对修订后的 ADR 与指针同步要求进行复审。

- Opus: SIGN。确认 R1 阻断项全部消除；唯一张力是 REQ-004 从“实时 active rule”演进为“witnessed Evidence Event + stable view 投影”，但该张力已被明确为具名代价且保留 provenance 门、不可丢弃性和状态可见性。要求 ratify 后同步 `requirements.md`、`direction.md`、ADR README 与 roadmap。
- GPT-5.5: SIGN。确认 R1 blockers 已解决，无 hard invariant / REQ / ADR 冲突；要求 ratify 后更新 ADR README、roadmap，并添加审计记录。
- DeepSeek: SIGN。确认状态、评审摘要、Tier-1/REQ-004、REQ-009、迁移边界、术语全部修正；无 hard invariant / REQ / ADR 冲突；建议实施时明确 unclassified event resolver、evidence 摘要充分性与 Knowledge 异步化验证条件。
- Kimi-k2.6: SIGN。确认 R1 阻断项全部消除；确认 REQ-004 / ADR 0028 是语义演进而非冲突；要求 ratify 后同步 ADR README、roadmap，并关注 queued/stale/projected 状态反馈、Knowledge 同步 projector 审计、hot overlay 边界与 unclassified evidence drain-loop。

R2 结果为 4/4 SIGN，无架构 blocker。

## 是否还有更好的方案

R1 中 Opus 提出过“新建 ADR0040 并 supersede ADR0039”的替代方案，用于保留原 Constraint-only 决策记录。后续讨论确认，本项目允许在设计立场改变时修订 ADR；原 Constraint-only 版本尚未实施，直接原地修订 ADR0039 可以减少一个未实施特例和额外阅读负担。R2 四个 T0 均未继续要求新建 ADR0040。

R2 四个 T0 均回答没有更好的主方案。共同理由是：

- 继续保持 Constraint-only 会让 Knowledge，以及 identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影面保留同类写入风险。
- 完整全域 event sourcing 数据库和统一全域 schema 超出当前真实使用证据，且会增加跨设备合并和长期维护成本。
- 只增强同步写时 prompt 或增加审计不能消除 raw context 直接写 canonical memory 的结构风险。
- 统一写入纪律 + 域自适应 projector / compiler 能同时满足 Constraint 的 queued / stale 接受边界、Knowledge 的 freshness 需求、REQ-009 accuracy-contract 和 ADR 0031 可逆边界。

## Ratify 后同步

R2 SIGN 后已执行以下文档同步：

- `docs/adr/0039-constraint-pipeline-reset.md`: 状态改为 accepted，并链接本审计记录。
- `docs/direction.md`: INV-GROUND-TRUTH-TIERED 增加 ADR 0039 后的 witnessed Evidence Event 与 queued / stale / projected 状态可见性说明。
- `docs/requirements.md`: REQ-004 增加 ADR 0039 后“确定性提交路径”的新定义。
- `docs/adr/README.md`: ADR 0039 导览与决策时序改为 Unified Evidence Architecture。
- `docs/roadmap.md`: 原 Constraint Pipeline Reset Migration 扩展为 Unified Evidence Architecture Migration，Constraint 作为第一优先迁移域，Knowledge 与低频 zone 或 view 投影面后续逐投影面迁移。

## 保留的非阻断实现事项

- Evidence Event 必须在 projector 读取前持久化；projector 失败不得回滚已见证 event。
- Projector / compiler 应在 sediment dedicated writer lane 内运行，保持主会话只读。
- Unclassified / queued Evidence Event 需要明确 drain 机制，避免长期不可见。
- Knowledge 同步 projector 过渡态需要审计和重新评估条件；异步化必须先通过 shadow projector / compile、diff、search A/B 与真实使用证据。
- Hot overlay 必须保持 REQ-009 accuracy-contract，不得把低准确度 fallback 当作正常结果继续写入长期记忆。
- Settings / Tool Contract diagnostic 必须有消费者，例如 audit、notify 或后续实现任务入口。
- Projector 生成 stable view 会增加跨设备 merge 面；同步仍只允许确定性 git 合并，真冲突 abort 并给出 runbook。
