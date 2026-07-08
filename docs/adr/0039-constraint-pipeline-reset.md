---
doc_type: adr
status: accepted
---

# ADR 0039 - Unified Evidence Architecture：第二大脑记忆统一证据架构与域自适应投影器

- **Status**: Accepted（原 Constraint-only 版本于 2026-06-18 accepted；统一记忆架构修订于 2026-06-19 经 4×T0 R2 全部 SIGN 后 ratify；2026-06-19 外部探索文章复审后经 4×T0 R2 收敛为边界澄清，不改变主架构；2026-06-19 存储基座经 4×T0 多轮收敛为 HYBRID_MD_GIT_PLUS_DB，并补充 L1/L2/L3 细节）。
- **Date**: 2026-06-18；统一架构修订：2026-06-19。
- **Relates-to**: [ADR 0003](./0003-main-session-read-only.md), [ADR 0014](./0014-abrain-as-personal-brain.md), [ADR 0015](./0015-memory-search-llm-driven-retrieval.md), [ADR 0016](./0016-sediment-as-llm-curator.md), [ADR 0020](./0020-abrain-auto-sync-to-remote.md), [ADR 0023](./0023-session-start-rule-injection.md), [ADR 0024](./0024-second-brain-from-natural-conversation.md), [ADR 0025](./0025-sediment-meta-curator-subsystem.md), [ADR 0028](./0028-sediment-ground-truth-tiered-rearchitecture.md), [ADR 0031](./0031-autonomous-self-calibrating-forgetting.md), [ADR 0035](./0035-memory-stage1-embedding-candidate-retrieval.md), [ADR 0036](./0036-memory-search-two-stage-collapse-and-hybrid-retrieval.md)。
- **Revises-direction**: 本 ADR 原先只覆盖 Constraint Pipeline Reset；统一架构修订将同一根因提升到整个第二大脑记忆系统。原 constraint-only 决策被本版吸收，不再作为独立实施路线。

## 1. 背景：Constraint 问题不是局部问题

ADR 0039 最初只针对 rules / constraints：规则写入在 `agent_end` 实时路径中完成分类、去重、合并、scope 判断、归档、注入层选择，并直接修改 active rule 文件。持续出现的近重合并、scope 误升、settings/tool 信号混入 global rules、固定 body 大小降级、归档数量上限等修补，说明问题不在某个 prompt 或某个函数，而在写入形态本身：高不确定性的语义裁决被放在高影响的实时写入路径中。

后续重新审视发现，同一结构风险不仅存在于 Constraint 域。Knowledge，以及 identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影面，也会遇到同类问题：`agent_end` 从原始对话上下文直接做 create / update / merge / archive / rescope / delete 等 canonical mutation。只要这种路径存在，新的边界案例就会推动系统继续增加局部特殊逻辑，而不是修正写入形态。

本 ADR 因此将原 Constraint Pipeline Reset 扩展为 **Unified Evidence Architecture with Domain-Adaptive Projectors**：统一证据架构 + 域自适应投影器。Constraint 仍是该架构中的一个重要域，但不再是独立特例。

## 2. 术语

**Evidence Event** 是长期记忆写入前的证据事件，记录自然对话或系统运行中被观察到的信号。它不是最终记忆条目。

**Evidence Ledger** 是 Evidence Event 的持久证据层。存储基座采用 L1/L2/L3 分层：L1 Evidence Event SOT 是 git 同步的内容寻址事件文件；L2 Markdown View 是由 L1 派生的人类可读审计视图；L3 Operational DB/Index 是本地 SQLite 派生层。Evidence Ledger 与 git history 不是同一概念：前者是 projector 可结构化读取的语义证据层，后者只是文本文件的版本控制、同步和审计机制；Evidence Ledger 可以由 git 管理，但不能被 git diff 或 commit history 替代。

**Canonical memory** 是系统运行时使用的稳定记忆投影，包括 rules、knowledge entries、identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影。它不是 raw `agent_end` 写时裁决的直接产物。

**Projector** 是从 Evidence Event 生成 canonical memory 的投影器，可以同步或异步运行。**Compiler** 是更偏后台、批量或复杂语义综合的 projector。本文用 projector 作为通称。Projector / compiler 可以使用 LLM 做语义综合，但 LLM 输出不得直接成为最终 L2 字节；需要进入 stable view 的 LLM 产物必须先固化为新的 L1 Evidence Event，记录 model、prompt hash、input hash、output hash、sanitizer 与 acceptance 信息，再由确定性 renderer 投影为 L2。语义综合不承诺逐字节复现 LLM 过程；L2 renderer 承诺同一 L1 输入集合在同一 projector/template 版本下生成同一 canonical bytes，并把再投影结果作为新的 stable view 版本呈现，而不是静默漂移当前 view。

**L1 Evidence Event SOT** 是跨设备同步的语义证据源。它由内容寻址、一事件一文件、immutable 的 canonical JSON 文件组成，文件随 git 同步，不能二次编辑，不能用跨设备共享 append 日志或 SQLite 文件替代。

**L2 Markdown View** 是从 L1 派生、随 git 同步的人类可读审计视图，用于阅读、diff、审计、诊断和 `archived` runtime tombstone。L2 不是用户管理记忆的界面，正常情况下用户不维护、不手改；任何用户纠错、拒绝、删除或补充原因都必须生成新的 L1 event，再由 projector 重新派生 L2。

**L3 Operational DB/Index** 是本地 SQLite 派生层，承载 ledger mirror、FTS/BM25、向量、图邻接、projector 水位线、jobs 与 diagnostics。L3 不入 git、可丢弃、可从 L1+L2 重建核心语义；派生缓存可以有损。

**Diagnostic** 是不应进入 memory 的信号记录，例如 Settings / Tool Contract 相关诊断。Diagnostic 必须有消费面，例如 audit、notify 或后续实现任务入口。

## 3. 决策

采用统一证据架构：所有长期记忆域先追加 Evidence Event；canonical memory 是 Evidence Event 的物化投影；`agent_end` 不再从 raw transcript / raw context 直接执行 canonical memory mutation。不同消费面按 freshness 和影响半径选择不同投影器：Constraint 使用后台 compiler 生成 Compiled Constraint View；Knowledge 可以先使用同步 projector 维持检索新鲜度，满足条件后再迁移到异步 compiler；identity / skills / habits / workflows / project memory / rationale 等低频 zone 或 view 投影面逐步迁移。

统一的是写入纪律和存储分层，不是新增一套全局 per-entry layering，也不是引入完整全域 event sourcing 数据库。系统采用 HYBRID_MD_GIT_PLUS_DB：L1 Evidence Event SOT 与 L2 Markdown View 以文本文件随 git 同步，L3 Operational DB/Index 使用本地 SQLite 派生层，不入 git、不作为真相源。Evidence Event 是证据层；stable views / entries 是读取面和运行时投影。持久信息模型继续遵守 ADR 0028 的 AX-SCOPE / AX-PROVENANCE / AX-MATURITY + f-CATEGORY；zone、inject-mode、staging、GTier 仍是子系统概念。共享 schema 或统一 ledger 只有在至少两个投影面完成验证后才考虑收敛。

## 4. 全域方向不变量

对所有长期记忆域，唯一低风险写原语是 append Evidence Event。`agent_end` 可以执行只读邻近语义检索、sanitize / redact、结构化提取、append event、audit / notify、调度 projector；不得从 raw transcript / raw context 直接执行 create、update、merge、archive、rescope、delete 等 canonical memory mutation。

Canonical memory 包括 rules、knowledge entries、identity / skills / habits / workflows / project memory / rationale 等 zone 或 view 投影。它们是 append-only evidence 的物化投影，不再是实时写时语义裁决直接修改的本体；这些投影面不构成 ADR 0028 之外的新存储轴。

Evidence Event 至少包含：schema version、用户或系统信号 quote、source role provenance、session id、turn id、timestamp、active project binding、candidate domain / scope hint、sanitizer result、邻近语义只读检索摘要、event id / hash。纠错、撤回、遗忘、归档、复活、矛盾也追加新事件，不覆写旧证据。邻近语义只读检索摘要只记录当时已知上下文，不作为之后跳过或删除信号的理由。旧 schema 的 Evidence Event 不重写；projector 声明可解释的 schema version 范围，不兼容时以 queued / diagnostic 暴露，不静默丢弃。

显式用户信号不得因 extractor / classifier 不确定而静默丢失。若无法确定域或投影目标，系统必须追加 unclassified / queued Evidence Event 或 recall diagnostic，由后续 projector 消化。安全门与语义门分层：secret / PII / path safety / prompt injection 等安全准入必须在 append 前完成，禁止未净化的高风险内容进入 Evidence Ledger；merge、scope、dedup、conflict、priority 等语义裁决在 projection 时完成。

Evidence Ledger 可作为审计和再生成输入，但不是自治遗忘的运行时复活通道。ADR 0031 的运行时复活通道仍必须由 `archived` 全文留在工作树、sparse 可达、用户自然纠错可触发复活来满足。

### 4.1 存储基座：HYBRID_MD_GIT_PLUS_DB

存储基座采用 HYBRID_MD_GIT_PLUS_DB。L1 Evidence Event SOT 与 L2 Markdown View 是随 git 同步的文本文件；L3 Operational DB/Index 是本地 SQLite 派生层。跨设备同步只使用确定性 git；禁止 LLM merge，禁止同步 SQLite 或其它二进制数据库文件，禁止把 Postgres、Neo4j、Kuzu、LanceDB 或其它运行时索引库作为记忆真相源。

L1 是唯一语义证据源。首期 L1 采用内容寻址、一事件一文件、immutable 的 canonical JSON 文件，文件随 git 同步且永不二次编辑。首期禁止跨设备共享 append 的 NDJSON 或分段日志；若未来要引入分段日志，必须另起设计，至少满足 per-device 分片、不破坏确定性 git merge、不引入人工 merge。L1 文件路径按 hash 分片，例如 `l1/events/sha256/ab/cd/<hex>.json`，具体路径可实现时调整，但必须保持内容寻址和一事件一文件。

L2 是从 L1 派生的人类可读审计视图，随 git 同步，用于阅读、diff、审计、诊断和 `archived` runtime tombstone。L2 不是用户管理记忆的界面，正常情况下用户不维护、不手改。任何用户纠错、拒绝、删除、遗忘或补充原因都必须生成新的 L1 event，再由 projector 重新派生 L2；不能把 L2 手工修改当成 canonical mutation。

L3 是本地 SQLite 派生层，不入 git、可丢弃、可从 L1+L2 重建核心语义。首期 L3 统一放在 SQLite，承载 ledger mirror、FTS/BM25、向量、图邻接、projector 水位线、jobs 与 diagnostics。FTS、向量、图邻接应分表并通过统一 repository 接口访问，不能让外部索引内部结构泄漏到 memory 真相层。

### 4.2 L1 event 格式与 hash 信封

L1 event 使用 UTF-8、LF、RFC8785/JCS canonical JSON。event 文件必须包含可校验的 hash 信封与 body；信封记录 `schema`、`canonicalization`、`hash_alg`、`event_id`、`body_hash`，body 承载事件事实。`event_id` 与 `body_hash` 均由 `sha256(JCS(body))` 得出；信封不参与 hash，但 reconcile / push 前必须校验信封、文件名、body hash 三者一致。任何字段变化都生成新 event，不修改旧文件。

L1 body 必须至少包含：`event_schema_version`、`event_type`、`created_at_utc`、`device_id`、`device_event_seq` 或 `producer_nonce`、`actor`、`causal_parents`、`session_id`、`turn_id`、`source`、`intent` 或 `operation`、`payload`、`sanitizer`、`producer`。`created_at_utc` 进入 hash，但只用于审计、分组和同层排序，不作为唯一因果依据。`device_id` 是安装级稳定伪匿名 id。`device_event_seq` 或 `producer_nonce` 用于避免同一设备在同一时刻产生的语义相同事件被内容寻址误合并。`causal_parents` 是 event id 数组，可为空；纠错、拒绝、删除、复活、merge、supersede 等事件必须引用被影响的父事件。

当 payload 含 LLM 产物时，body 必须记录 `model`、`prompt_hash`、`input_hash`、`output_hash`、`sanitizer` 与 acceptance 信息。projector 结果、水位线、索引状态不得写回既有 L1 event；若 projector 或用户动作产生新的事实，只能追加新的 L1 event。

**2026-07-08 现状注记（walkback 理由：实现补齐发生在 ADR ratify 之后）**：Knowledge 侧 `llm_extraction` 溯源字段于 2026-07-08 补齐（另一任务在实施）。存量无溯源 event 是已知历史盲区；projector / 审计读取时不得把缺失字段解释为新架构允许的省略。

### 4.3 L2 projector 确定性与漂移处理

L1 到 L2 的最终字节生成必须由确定性 renderer 完成。projector 可以使用 LLM 做语义综合，但 LLM 输出必须先固化为新的 L1 event；renderer 只消费已固化的 L1 event 和稳定模板，禁止在生成最终 L2 字节时直接调用 LLM。

同一 L1 输入集合在同一 projector/template 版本下必须生成同一 L2 canonical bytes。输入集合先按 causal parent DAG 做拓扑排序；同层事件按 `created_at_utc`、`device_id`、`device_event_seq`、`event_id` 稳定排序，最后以 `event_id` 打破平局。Markdown 输出必须使用固定模板、固定标题层级、固定 key 顺序、固定列表顺序、UTC 时间、UTF-8、LF、无 BOM、末尾换行，禁止依赖本地 locale 或运行时随机顺序。

L2 文件必须记录 machine-readable provenance，例如 projector 名称与版本、template 版本、input event set hash 或 Merkle root、canonical output hash 与水位线。`generated_at` 若存在，只能作为非确定性元数据，不参与 canonical bytes 校验。projector/template 版本变化导致输出变化时，必须显式 reproject，记录版本变化和输出 hash；版本不匹配或重投影字节不一致时必须报 drift diagnostic，禁止静默覆盖。

### 4.4 reconcile 与 push 前检查

reconcile / pre-commit / pre-push 必须校验 L1 hash、路径、信封一致性，并从 L1 重投影 L2 后与工作区 L2 canonical bytes 比对。若 L2 有差异且没有对应新增 L1 event，判定为 dirty derived view，必须阻止 push。

本地手改或外部编辑器修改 L2 时，系统不能直接接受该修改。允许的处理只有：丢弃修改并从 L1 重投影；把用户意图通过显式纠错入口（自然对话或纠错命令）转成新的 L1 correction / rejection / deletion / reason event 后再重投影；或者放弃本次 push。L2 冲突不得人工解决；git merge 后若 L2 出现冲突标记，必须先合并 L1，再丢弃冲突 L2 并重投影。L1 是 content-addressed immutable 文件集合，正常跨设备新增会成为不相交文件；若同一路径出现同名不同内容，视为硬错误而不是语义冲突。

高置信、低风险、可回滚写入默认自动完成；低置信、高影响或存在冲突信号的内容进入 staging / queued，由后续自然对话中的主动纠错信号（INV-ACTIVE-CORRECTION）或新证据解决。该路径不是审批队列，不要求用户同意、拒绝或给出原因；系统应继续合并同类信号、限频暴露状态，并从自然纠错中学习，避免让记忆管理负担回到用户身上。

### 4.5 L3 SQLite schema 与拆分边界

首期 L3 统一使用本地 SQLite。建议表边界包括：`events` 或 `ledger_mirror` 镜像 L1 event；`event_edges` 存因果、引用、supersede、correction 等边；`projector_state` 存 projector 版本、水位线、input root、last output hash；`l2_views` 存 view path、input root、canonical hash、projector/template 版本；FTS5 表承载 BM25 文本索引；`chunks` / `embeddings` 存 chunk、model、dimension、vector blob、hash；`graph_nodes` / `graph_edges` 存轻量实体、因果、引用与语义邻接；`jobs` / `diagnostics` 存重建、漂移、校验状态。表名可实现时调整，但边界必须保持：L3 是派生索引，不承载不可由 L1+L2 重建的核心语义。

FTS/BM25、向量和图邻接首期都留在 SQLite。只有真实负载出现可复现瓶颈，且有延迟、召回、规模或并发证据时，才允许拆出专门存储：复杂多跳图查询超出 SQLite 递归查询能力时考虑 Kuzu；大规模 ANN 延迟或召回不达标时考虑 LanceDB；多用户、服务端并发写、远程 ACL 成为真实需求时才考虑 Postgres。拆分后外部库仍是可重建派生索引，不能成为 L1 或 L2 的替代真相源。

## 5. 域自适应投影器

### 5.1 Constraint

Constraint 域沿原 ADR 0039 的核心形态：append-only Constraint Draft/Event → background Constraint Compiler → Compiled Constraint View → `session_start` 稳定注入。`session_start` 只读取上一份稳定 view；存在 queued / stale 时提示状态，不同步调用 LLM 重新裁决。

Constraint compiler 执行语义合并、去重、scope 校验、冲突检测、配置 / 工具信号排除、文本压缩、优先级排序和注入摘要生成。compiler 记录足够的来源和幂等审计，使投影可以解释、重试和回看。

**2026-07-08 现状注记（walkback 理由：运行时注入读源仍未 read-flip 到 git L2）**：运行时注入读取源现阶段为 `~/.abrain/.state/sediment/constraint-shadow/latest/`，其中 `decision.json` 与 `event-coverage.json` 是注入门控必需元数据；git 同步的 `l2/views/constraint/` 是 shadow 审计投影，不是 runtime source-of-truth。证据见 `extensions/sediment/settings.ts:84-85` 对 `l2OutputRoot: "repo"` 的注释：repo 模式会写 `l2/views/constraint/latest/compiled-view.md`，但 runtime injection still reads `.state`, no read-flip。read-flip 是未来独立 gate，须等门控元数据进入 git L2 后方可评审。

### 5.2 Knowledge

Knowledge 域采用 Knowledge Evidence → Knowledge Projector / Compiler → materialized Search Corpus View。Search Corpus View 可以表现为 markdown entries、metadata、indexable text 和检索索引输入。

Knowledge projector 可以按阶段同步或异步调度。无论同步还是异步，projector 都只能从 Evidence Event、Evidence Ledger 或 stable views 读取，不能从 raw transcript / raw context 直接裁决写 canonical。同步 projector 是 Evidence Event 后的投影步骤，不是旧写时裁决路径的改名。同步 projector 不得重新解析 raw transcript 来绕过 Evidence Event；它只能读取已追加的 Evidence Event 及其记录的邻近只读检索摘要。失败时至少保留 queued event，不得静默丢失显式信号。

Knowledge 默认可以先使用同步 projector 保持 `memory_search` freshness。只有 shadow projector / compile、diff、search A/B 证明 freshness、召回质量、延迟不退化，才将 Knowledge 从同步 projector 迁移到后台 compiler。若证据不足，保留同步 projector，但仍必须遵守 canonical = projection，不得回到 raw context 直写 canonical。

### 5.3 低频 zone / view 投影面

Identity、skills、habits、workflows、project memory、rationale 等是 zone 或 view 投影面，不是 ADR 0028 之外的新全局存储轴。这些投影面同样从 Evidence Event 由 projector 生成稳定视图。低频投影面可以先保留同步 projector，但必须记录审计和重新评估条件，避免长期回到旧写时裁决形态。

Rationale view 也应视为 evidence 的投影。它可以读取 ADR、audit、memory entry 和 source references，但不得把当前实现状态镜像回 ADR 正文；实现真相仍以代码和 `current-state.md` 为准。

### 5.4 Settings 与 Tool Contract

Settings 与 Tool Contract 不是 memory。模型分层、运行开关、预算、provider、功能 flag 等运行配置进入配置面；工具调用方式、前置条件、安全约束、选择规则进入 tool declaration、SKILL.md 或代码声明。自然对话中的相关信号只生成 not-memory diagnostic / audit，实际变更走配置、代码或工具声明流程。diagnostic 必须有消费面，例如 audit、notify 或后续实现任务入口，不能成为无人读取的记录。

## 6. 读取面与 freshness

Runtime consumer 默认只读 stable facade / view：`memory_search` 和 `memory_decide` 读 Search Corpus View；`session_start` 读 Compiled Constraint View；rationale / decision brief 读对应 materialized view。

Knowledge 若迁移到异步 compiler，或出现内容投影延迟，`memory_search` 必须支持 `stable view ∪ bounded hot evidence overlay`。近期未投影 Evidence Event 以 provisional tier 进入候选池，明确标注未编译、未投影、较低成熟度，不反写 canonical，不与 stable entry 同权。Hot overlay 只服务 Knowledge freshness，不参与 Constraint 注入，不成为 canonical source。

Hot overlay 必须有确定性的基础设施预算，例如数量、时间、token 或候选上限，并优先使用结构化 evidence 摘要而非全量原始转录。预算耗尽时，超限 event 仍保留 queued / stale 状态反馈，但不进入 hot overlay。stable view 与 hot overlay 冲突时，stable view 默认优先；若 hot overlay 承载 USER-role durable directive，必须显式标注 provisional 与 queued 状态，不能静默覆盖 stable view。不得用相似度阈值、准确率阈值等认知机械门替代 LLM 判断。

Hot overlay 和同步 projector 仍受 REQ-009 约束：`memory_search` 必须保持 LLM retrieval / rerank 的 accuracy-contract；模型不可用时 hard error；不得以 grep、BM25 或其它低准确度 fallback 当作正常结果继续写入长期记忆。

Constraint freshness 接受 queued / stale。系统注入上一份稳定 compiled view，并提示 queued / stale，不同步 LLM 裁决。

## 7. 语义综合、冲突与多视角审查

语义合并、去重、scope 判断、冲突解释、demote、supersede 等认知判断由 projector / compiler 完成，以 prompt-native 判断为主。基础设施可以做 sanitizer、path safety、schema lint、atomic write、lock / lease、audit、source provenance、idempotency、dedup prefilter 等来源边界和候选缩小，但不能替代 LLM 语义判断。

Multi-view verification 从 `agent_end` 写时门迁移到 projector / compiler 内部。高影响投影动作，例如跨 scope、merge / supersede、demote、高优先级约束提升，仍需要 prompt-native 交叉验证。该机制不是用户审批，也不是实时路径的机械阻断。

Projector 可以读取其它域 stable view 作为上下文，但不能形成循环写依赖。跨域引用必须记录输入 evidence / view hash、输出 view hash、模型、prompt version、时间和审计摘要。若只是轻量上下文读取，可以记录摘要；若跨域信息影响输出决策，必须记录完整来源。Projector 增量投影与全量再投影的语义应等价；若无法保证等价，必须输出差异、冲突或不确定性说明，而不是直接替换 stable view。

## 8. 保留与删除

保留以下方向和基础设施：INV-INVISIBILITY、INV-AUTONOMY、INV-ACTIVE-CORRECTION、INV-MAIN-SESSION-READ-ONLY、INV-GROUND-TRUTH-TIERED 的 provenance 实质、INV-REVERSIBLE-AUTONOMY、REQ-009 accuracy-contract、markdown + git、strict project binding、sanitizer、audit、atomic write、lock / lease、deterministic git sync、dedup prefilter、provenance / idempotency / sanitizer 等基础设施来源边界门。

删除或降级以下形态：写时 Jaccard / 阈值 / 固定 body-size demote / archive cap / scope 黑名单等用于替代 LLM 语义判断的认知机械门；`always` / `listed` / `inject_mode` 作为写时事实；settings / tool contract 被复制为 memory rule；从 raw `agent_end` 上下文实时 mutate active memory 的旧写入模型。

Dedup / near-merge 仍然存在，但迁移到 projector / compiler 内部。基础设施预过滤只作候选缩小或安全边界，最终语义判断由 prompt-native projector / compiler 完成。

## 9. 对既有 ADR 的修订

ADR 0028 的 Tier-1 原则保留其核心：用户显式 durable directive 与 LLM 推断假设不是同一信号类，USER-role provenance 和 source gate 仍是硬边界，用户显式约束不得静默丢失。本 ADR 修订写入形态：Tier-1 不再等于实时确定性提交 active rule，而是确定性 append witnessed Evidence Event；后续由对应域 projector / compiler 生成稳定投影。Provenance tier 与 compilation maturity 是正交轴：未投影不等于降级为可丢弃信号。

REQ-004 的“确定性提交、对用户可见、永不被 skip / stage 丢弃”在本架构下对应为：USER-role ∧ directive ∧ durable 的显式指令必须确定性追加 witnessed Evidence Event；event 必须可审计、可追溯、可见于 queued / stale / projected 状态反馈；不得被 skip、stage 或 drop；必须保留 keyed by raw transcript 的负信号召回审计。强制执行可能延迟到 projector / compiler 生成 stable view，这是本 ADR 接受的具名代价，但不是静默丢失。

ADR 0023 的 rules 注入模型修订为 Compiled Constraint View 注入。Rules 区不再是写时 source-of-truth active 文件集合，而是 compiled view 的呈现或兼容投影。

ADR 0024 的 INV-ACTIVE-CORRECTION 保留。用户自然提出“以后用 X”“忘掉那条”“这不是全局规则”等仍是核心信号通道。区别在于系统不要求用户审批，也不在实时路径做高影响 canonical mutation，而是把纠错追加为 evidence 并由 projector / compiler 消化。

ADR 0031 的可逆自治边界保留。Evidence Ledger 不能替代 `archived` 全文留盘的运行时复活通道；任何 demote / archive 投影都必须保持 `archived` 可达。归档、复活、撤回和纠错应追加对应 Evidence Event 或在 projector 输出中记录 evidence 引用，但运行时复活不得依赖重新投影或 git 考古。

ADR 0035 / 0036 的 search-time freshness 与 bounded-union 经验成为 Knowledge 异步化的前置证据基础，但不能用低准确度 fallback 继续写入长期记忆。`memory_search` 的 accuracy-contract 保留。

## 10. 迁移边界

迁移策略写入 `docs/roadmap.md`，本 ADR 只固定决策边界：canonical memory 是 append-only evidence 的投影；`agent_end` 不直接从 raw context 写 canonical；各消费面逐步迁移；过渡期旧 curator 只能作为 projector 消费 Evidence Event；逐投影面迁移必须有真实使用证据；禁止一次性重写全系统。

过渡态同步 projector 必须有审计和重新评估条件，避免长期退回旧写时裁决形态。README 和 roadmap 等指针文件在本 ADR ratify 后同步更新，不在 ADR 正文中承载实施流水。

## 11. 接受的代价与风险

后台 compiler 可能延迟，导致某些信号不能立即进入 stable view。Constraint 域接受 queued / stale；Knowledge 域通过同步 projector 或 bounded hot evidence overlay 保持 freshness。该代价换来写路径低风险、投影可重试和证据可审计。

Projector / compiler 仍可能错误合并、错误 scope、错误 demote 或错误解释冲突。接受该代价，因为错误发生在可重新生成或可修订的投影层，原始 evidence 和 `archived` 运行时复活通道保留，恢复成本低于直接修改 active memory。再生成不是逐字节重放承诺；系统必须保留 projector 版本、模型、prompt、输入 hash、输出 hash 和审计摘要，使同一 evidence 生成的新 stable view 可解释、可比对、可回退。

Evidence Event 会增加存储增长。首期不引入自治物理删除；压缩、归档或共享 schema 工程化必须另行基于真实使用证据设计，且不得破坏 ADR 0031 的运行时复活通道。

Projector 重写可能增加跨设备 merge 面。接受该代价，但跨设备同步仍只使用确定性 git 合并；LLM 不自动解决 git 冲突，真冲突仍 abort 并给出 runbook。L1 通过内容寻址一事件一文件把跨设备新增收敛为不相交文件集合；L2 作为派生视图，冲突处理方式是丢弃并从合并后的 L1 重投影，而不是人工 merge。

L1 event 文件数量会增长，并可能带来目录规模、hash 校验和 git status 成本。接受该代价，因为它换来证据不丢失、跨设备确定性合并和可审计重放。首期通过 hash 分片、SQLite mirror 和 projector 水位线控制运行时成本；压缩、pack、分段日志或物理回收必须另行设计，且不得破坏一事件一文件的首期同步不变量。

L2 Markdown View 可能被用户或外部编辑器手改。接受存在手改窗口，但不接受它跨 push 或成为管理面。reconcile / pre-push 必须阻断未回灌 L1 的 dirty derived view；需要保留的用户意图必须转为 L1 correction / rejection / deletion / reason event 后再重投影。

L3 SQLite 引入运行时依赖和 schema 演进成本。接受该代价，因为 FTS/BM25、向量、图邻接和 projector 水位线不适合继续用纯 markdown 文件承担；同时 L3 不入 git、不作为真相源、可丢弃重建，避免把数据库同步和数据库 merge 引入第二大脑真相层。

Settings / Tool Contract 被判为 not-memory 后，相关配置或工具声明不会自动改变。接受该代价，因为它们的实际变更属于配置或代码流程，不能通过 memory rule 间接表达。系统必须提供可消费的 diagnostic。

## 12. 走偏信号

如果 queued event 长期不被投影，说明 projector 活性不成立，需要先修 drain-loop、调度或 stale-trigger，而不是恢复 raw context 写时裁决。

如果 settings / tool 信号继续出现在 global constraints 或 knowledge entries 中，说明域隔离失败，应修 router / projector prompt 与 not-memory diagnostic，而不是为每个工具或配置新增排除规则。

如果 project-specific 信号继续进入 global view，说明 scope 保守策略失败，应修 scope rubric 与 project binding 证据呈现，而不是新增项目名黑名单。

如果 projector 频繁生成大规模无解释重写，说明投影过度自信，应要求输出 conflict / uncertainty 区、来源 hash、prompt / model 信息和差异说明，而不是新增固定归档数量上限。

如果 Knowledge 异步化后 `memory_search` freshness、召回质量或延迟退化，说明异步迁移条件不成立，应保留同步 projector 或强化 bounded hot evidence overlay，而不是降低 `memory_search` accuracy-contract。

如果 `archived` 条目被投影重建过程丢弃，或 archive / reactivation 绕过 Evidence Event 与审计引用直接修改 canonical status，说明违反 ADR 0031，应立即回退该 projector 设计。

如果 Tier-1 指令进入 Evidence Event 后长期不可见或无 queued / stale / projected 状态反馈，说明 REQ-004 的“对用户可见”没有兑现，应修状态反馈和召回审计，而不是恢复 active rule 直写。

如果 L1 采用跨设备共享 append 日志、同步 SQLite、或让同一个文件被多个设备并发追加，说明违反确定性 git sync，应回到内容寻址一事件一文件，或另起 per-device 分片设计并重新评审。

如果 L1 hash 不覆盖 sanitizer、source、device、session、turn 或 payload 等语义关键字段，或把 wall-clock timestamp 当作唯一因果序，说明 evidence 信封不可审计，应修 event schema。

如果 L2 被当作用户管理界面，或系统接受 L2 手改并反向解析为事实，说明违反 INV-INVISIBILITY / INV-AUTONOMY 和 L1 SOT，应移除该路径，改为显式 L1 correction event。

如果 projector 在生成最终 L2 字节时直接调用 LLM、依赖本地 locale、输出顺序不稳定、或重投影同一 L1 得到不同 canonical bytes 却静默覆盖，说明 L2 确定性契约失败，应将 LLM 输出固化进 L1 并修 renderer。

如果 pre-push 只提示不阻断 dirty L2，或允许人工解决 L2 merge conflict，说明 L2 派生视图边界失效，应改为合并 L1 后重投影 L2。

如果 L3 SQLite、Kuzu、LanceDB、Postgres 或任何外部索引库承载不可由 L1+L2 重建的核心语义，说明索引层变成了隐性真相源，应立即回退。

如果没有真实负载证据就拆出 Kuzu、LanceDB、Postgres，说明架构过早依赖化，应保留 SQLite 首期路径，直到图遍历、ANN 或并发需求用数据证明 SQLite 不足。

## 13. Deferred exploration

完整 Typed Belief Graph、Unified Evidence Graph lazy materialization、CCR（从近期原始转录即时重构情境认知模型）、统一全域 ledger / schema 工程化都保留为 deferred exploration。进入主线必须有成本、质量、真实使用证据，不作为当前 ADR 的首期交付。

L1 pack / compaction、per-device 分段日志、CRDT、SQLite sync、remote Postgres、Kuzu、LanceDB、object store 或多后端索引拆分也都保留为 deferred exploration。进入主线前必须证明不破坏 L1 内容寻址一事件一文件、L2 派生视图、L3 可重建索引、确定性 git sync 和用户不管理记忆这五条边界。

## 14. 评审摘要

原 ADR 0039 的 Constraint-only 版本已经 4×T0 多轮审查并 accepted，但尚未实施。用户指出同类问题可能存在于整个第二大脑记忆系统，要求抛开现有 sediment 具体设计，由多个 T0 独立提出方案、交叉辩论，每轮都回答是否还有更好方案，并由 T0 全体一致后再定稿。

统一架构修订的评审记录见 [`2026-06-19-adr-0039-unified-evidence-architecture-t0-review.md`](../audits/2026-06-19-adr-0039-unified-evidence-architecture-t0-review.md)。本 ADR 仅保留影响决策有效性的摘要：讨论收敛到“统一写入纪律 + 域自适应投影器”，拒绝完整全域 event sourcing 数据库作为首期范围，保留 Knowledge 同步 projector 作为 freshness-preserving 迁移路径，并要求 Evidence Ledger 不替代 ADR 0031 的 `archived` 运行时复活通道。2026-06-19 对外部探索文章和工具进行复审后，4×T0 再次确认这些材料只能作为弱启发，不构成替代架构依据；R2 收敛结论为保留 ADR 0039 主架构，补充 projector 再生成语义、Evidence Ledger 与 git history 分层、安全门与语义门分层、hot overlay 边界、schema versioning、archive / reactivation evidence 化等边界澄清。

2026-06-19 存储基座专项复审将 markdown+git、SQLite、Postgres/pgvector、图数据库、LanceDB/向量库、多后端混合方案作为候选重新比较，并明确允许放弃“0 依赖原则”。4×T0 首轮一致拒绝纯 DB 替换和纯 markdown+git 继续承担所有层，收敛到 HYBRID_MD_GIT_PLUS_DB。后续多轮围绕 Evidence Ledger 是否随 git 同步、Markdown 是否是管理面、SQLite 是否是真相源、跨设备 merge、L2 dirty view、event hash 信封、projector 确定性和索引拆分边界继续收敛，最终 4×T0 SIGN：L1 为 git 同步的内容寻址一事件一文件 Evidence Event SOT；L2 为 git 同步的人类可读审计视图而非用户管理界面；L3 为本地 SQLite 派生索引。原尾句中的记忆写入审批式弹窗条款已于 2026-07-08 walk-back：高置信低风险写入自动完成，低置信/高影响/冲突信号进入 staging / queued，并由自然纠错或新证据解决。

## 15. 这份 ADR 不是什么

不是要求用户审批记忆写入；用户仍然不参与大脑日常管理。2026-07-08 walk-back 后，本 ADR 不再授权任何为记忆写入设置的同意/拒绝式审批路径：高置信低风险写入自动完成，低置信/高影响/冲突信号进入 staging / queued，由自然对话中的主动纠错或新证据解决。

不是让用户维护 Markdown；L2 Markdown View 是可读审计视图和 runtime tombstone，不是用户编辑界面。用户纠错、拒绝、删除或补充原因必须转成 L1 event，而不是直接手改 L2 成为事实。

不是让主会话写 memory；主会话仍然只读，sediment sidecar 是 dedicated writer。

不是把所有 memory 改成完整 event sourcing 数据库；首期固定 L1/L2/L3 存储边界和逐投影面迁移路径，不建设全域数据库 SOT。

不是禁止 notify / audit；告诉用户 queued / stale / projected 状态是健康反馈，不是管理负担。

不是删除 AI 语义判断；语义判断从 raw `agent_end` 写时 mutation 移动到 projector / compiler。

不是把配置或工具声明藏进 memory；settings / tool 有自己的归宿，memory 只可记录 not-memory diagnostic / audit。

## 修订记录

- 2026-07-08：walk-back 写入弹窗条款。理由：与 INV-INVISIBILITY（唯一合法弹窗 = vault_release）、REQ-001 forbidden、ADR 0024 §4.2 首条反模式正面冲突；既有 staging / queued + 主动纠错通道已覆盖其动机。6×T0 三轮一致，用户 2026-07-08 会话授权。
