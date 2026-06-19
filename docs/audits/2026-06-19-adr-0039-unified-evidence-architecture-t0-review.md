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

## 外部探索文章复审

2026-06-19，用户要求详细阅读一组外部探索文章及其中提到的工具，并将其与 ADR 0039 结合讨论。主会话通过并行 worker 汇总文章内容，并明确将这些材料降级为弱启发：其中不少是探索性或营销性文章，不能作为架构依据，也不能压过本项目已有内部原则和真实事故证据。

随后启动 4×T0 复审，要求模型从第一性原则重新攻击 ADR 0039，而不是复述外部文章。R1 中四个 T0 均没有提出严格更优的主架构，但指出 ADR 0039 仍需澄清 projector 再生成语义、Evidence Ledger 与 git history 的关系、安全门时机、hot overlay 边界、schema versioning、archive / reactivation evidence 化等问题。DeepSeek 一度提出 Hybrid Direct-Mutation with Evidence Audit Trail，即保留 direct canonical mutation、Evidence Event 作为审计轨迹、projector 只做一致性验证；其余 T0 认为该方案会保留本 ADR 要消除的实时直写根因。

R2 要求四个 T0 先读 ADR 0039 原文，再只讨论内部架构分歧。R2 结果为 4/4 收敛：没有比 ADR 0039 主轴更好的主架构；Hybrid Direct-Mutation with Evidence Audit Trail 不严格更优，因为它把高不确定语义裁决重新放回高影响实时写路径，Evidence Event 只能事后解释而不能防止 active canonical 被污染。R2 同意保留 ADR 0039 的 append Evidence Event → projector / compiler → stable view 主架构，并将分歧收敛为边界澄清。

R2 后对 ADR 0039 做最小文本修订：明确 projector / compiler 不承诺逐字节确定性重放，而是基于 evidence、prompt / model / input / output hash 和审计摘要做证据忠实再生成；明确 Evidence Ledger 是语义证据层，git history 是版本控制和同步机制，二者可以共用 markdown + git 基座但不能互相替代；明确安全门与语义门分层，secret / PII / path safety / prompt injection 等必须在 append 前处理，merge / scope / dedup / conflict 等语义裁决在 projection 时处理；明确 hot overlay 只服务 Knowledge freshness，必须 bounded、provisional、不反写 canonical、不参与 Constraint 注入；明确 Evidence Event 带 schema version、旧 schema 不重写、projector 声明兼容范围；明确 archive / reactivation 也应 evidence 化，但 ADR 0031 的 archived 全文运行时复活通道仍不可替代。

## 存储基座专项复审

2026-06-19，用户要求把“如何存储”作为另一个重要架构问题重新讨论，并明确要求将当前 markdown+git 版本控制只作为候选方案之一，允许放弃“0 依赖原则”。主会话先读取 ADR 0014、ADR 0020、ADR 0031、ADR 0035、ADR 0036 与 ADR 0039 的相关边界，再启动 4×T0 存储复审。

R1 要求四个 T0 比较 markdown+git、SQLite、Postgres/pgvector、图数据库、LanceDB/向量库与混合方案。R1 结果 4/4 收敛为 HYBRID_MD_GIT_PLUS_DB：纯 DB 替换会破坏本地优先、人类可读、确定性 git sync 和 archived runtime tombstone；纯 markdown+git 继续承担 ledger、query、index 全部职责也不再足够。主要分歧是 Evidence Ledger 是否本地 only、Markdown 是否仍是 SOT、SQLite 是 primary ledger 还是 derived index。

R2 专门收敛上述分歧。4×T0 最终排除了本地-only Evidence Ledger，因为它会让跨设备 evidence 丢失，并削弱 ADR 0039 的 Evidence Event 先行语义。收敛结论为：L1 Evidence Event 必须随 git 同步，但不是同步 SQLite；采用内容寻址、append-only、一事件一文件的不可变事件文件作为语义证据 SOT。L2 Markdown 是从 L1 派生的人类可读 stable view 与 archived runtime tombstone 表达。L3 SQLite 是本地 operational mirror / index，可丢弃、可重建、不入 git。

R3 对该三层方案进行最终签署。3/4 T0 SIGN，Opus 提出两个 blocker：一是“可无冲突分段日志”措辞会允许跨设备共享 append 文件，破坏 ADR 0020 的 disjoint-file deterministic merge 前提；二是 L2 手改在 reconcile 回灌 L1 之前被 push，会形成 L1/L2 双真相竞态。主会话据此收紧 proposal：首期只接受一事件一文件；手改 L2 必须先生成 L1 manual_edit / correction event 才允许 push，push 前必须阻止未 reconcile 的 L2 脏改。

R4 对收紧后的 proposal 复审，4×T0 全部 SIGN。补充实现契约为：L1 event hash 的被寻址内容必须包含 timestamp、device_id、causal parent 或等价信封字段，避免不同事件因语义相同而误去重；L2 projector 必须使用稳定排序、模板和格式，否则同一 L1 在不同设备生成不同 Markdown 字节会反噬禁止 LLM merge 的前提。

随后用户指出 L2 “可手改”可能违反人类不参与管理的基线，并明确唯一可接受的用户参与是需要执行写入时少量弹窗，选项为 `同意` / `拒绝` / `其它原因`。4×T0 补充复核一致认为：原措辞若将 L2 解释为 editable management surface，则违反 INV-INVISIBILITY / INV-AUTONOMY；唯一可接受定位是 readable/auditable view + diagnostic escape hatch。ADR 文本因此修订为：L2 不是用户管理记忆的界面，正常情况下用户不维护、不手改；任何用户纠错、拒绝、删除、遗忘或补充原因都生成新的 L1 event 后再重投影 L2。写入弹窗只在系统不能安全自决时出现，并且必须限频、合并、从拒绝原因学习，避免成为管理负担。

最后一轮 T0 专门收敛仍待细化部分：L1 event 文件格式与 hash 信封、projector 稳定排序与格式、reconcile / push 前检查、SQLite schema 与索引路线。4×T0 全部 SIGN。落盘结论为：L1 使用 UTF-8/LF/RFC8785 JCS canonical JSON，hash 信封校验 event_id、body_hash、文件路径与 body 一致，body 至少包含 event schema、event type、created_at_utc、device_id、device_event_seq 或 producer_nonce、actor、causal_parents、session_id、turn_id、source、intent/operation、payload、sanitizer、producer；LLM 产物必须先固化为 L1 event。L2 最终字节由确定性 renderer 生成，按 causal DAG 拓扑序和稳定 tie-break 排序，记录 projector/template/input/output hash，drift 必须 diagnostic，不得静默覆盖。reconcile / pre-push 必须阻断没有对应 L1 event 的 dirty L2，L2 merge conflict 一律合并 L1 后重投影。L3 首期统一 SQLite，FTS/BM25、向量、图邻接、水位线、jobs、diagnostics 都作为可重建派生索引；Kuzu、LanceDB、Postgres 等只有真实负载证据证明 SQLite 不足时才拆出，拆出后仍不能成为真相源。
