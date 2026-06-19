---
doc_type: notes
status: active
---

# ADR 0039 P2 — Constraint Evidence Event v1 与并行写入设计

本设计是 ADR 0039 的第二阶段实施方案，范围只覆盖 Constraint 域的 Evidence Event v1 与并行写入。P2 不切换 `session_start` 注入，不让 shadow compiled view 成为 runtime truth，不写 canonical rules、project rules、knowledge 或其它 canonical memory；旧 rules writer 与 tier1 ruleset adjudicator 继续作为现有 runtime 路径。P2 只在现有路径旁并行追加 L1 Evidence Event，并让 P1 shadow compiler 在后续读取 event 证据以继续生成 shadow report。

2026-06-19 的 4×T0 设计评审结论为 GO。四路共同结论是：在 P2 边界内，没有比“parallel L1 Evidence Event append + old path unchanged + shadow compiler reads events later”更低风险且信息增益更高的方案。直接切 compiled view injection 属于 P3，会提前改变 runtime truth；双写 canonical rules 会违反 ADR 0039 的写入纪律；先实现稳定 L2/L3 会在 event 丢失率、compiler 活性、scope 保守性尚未观测前冻结过多结构。

## 1. 目标

P2 的目标是把新的 Constraint 信号确定性追加为 sanitized L1 Evidence Event，同时保持现有 rules 写入与注入行为不变。P2 要证明四件事：第一，用户或系统产生的 Constraint 信号能够形成内容寻址、不可变、可校验的 L1 event；第二，append 失败、sanitizer 阻断、hash mismatch、schema 不兼容和 compiler 未消费都能被观测；第三，settings/tool/not-memory、scope hint、legacy outcome 与 neighbor summary 都能作为 evidence 保留，而不是在写时直接变成 canonical rule；第四，P1 shadow compiler 可以后续读取 legacy rules 与 L1 events，继续生成只读 shadow view 与 diagnostics。

P2 的成功条件不是替换 legacy rules，也不是让 Evidence Event 进入运行时注入。成功条件是：event append 可审计、可重放、可校验、可统计，且不会改变 canonical rules tree、memory corpus、`session_start` 注入或旧写入路径。

## 2. 非目标

P2 不实现 compiled view injection，不修改 `extensions/abrain/rule-injector/index.ts` 的注入来源，不刷新 `cachedRules`，不注册新的 `session_start` 或 `before_agent_start` 注入路径。P2 不停用 `writeAbrainRule`、`resolveRuleWrite`、`applyTier1RuleAdjudication`、`archiveAbrainRule`、`mutateRuleStatusContested` 等旧路径函数。

P2 不实现 L2 stable Markdown View，不建立 L3 SQLite schema，不把 event reader 作为 runtime source of truth。P2 可以写最小 audit、diagnostics 与 reader/smoke，但这些都是 P2 观测面，不是稳定投影面。

P2 不把 settings、tool contract、model tier、provider、预算或 feature flag 写成 canonical memory。此类信号可以追加为 not-memory evidence event 或 diagnostic，用于后续配置、工具声明或人工调查流程。

P2 不修复 P1 报告中的 legacy rule body hash mismatch，也不修改 archived / superseded / deprecated legacy rules。相关问题只进入 P2 后续项和 diagnostics。

## 3. P1 真实报告输入

P1 PR4 的首份真实 shadow report 位于 `/home/worker/.abrain/.state/sediment/constraint-shadow/latest`，`runId=20260619T125703Z-6d4c9c8bad19`，`inputRootHash=6d4c9c8bad195fe4c523e5c1cb4e98f286b34ac20dbe391f44c7b5b5da806748`，`shadowOutputHash=7e44ae89d2d9fda9b445fb1fc49360a5a572531cfe49b5129fe05e4056642f48`。`diff.json` summary 为 `totalSources=33`、`mappedSources=33`、`unmappedSources=0`、`constraints=18`、`exclusions=15`、`unresolved=0`、`validationStatus=valid`。

P2 必须吸收三类 P1 信号。第一，20 条 `SC_INPUT_BODY_HASH_MISMATCH` 表明 legacy rule frontmatter 中的旧 `body_hash` 与当前正文重新计算结果不一致；P2 event identity 不能继承 legacy body hash 语义，必须使用 event body 的 JCS hash。第二，5 条 `SC_NOT_MEMORY_SETTINGS` 表明 settings-like 信号需要区分“配置事实”与“配置相关行为约束”；append 阶段只能记录 hint，不能静默丢弃。第三，11 条 `SC_UNCLASSIFIED` archived observed exclusions 说明历史文档措辞与记忆治理重叠项仍需要人工或 T0 审阅；P2 不复活、不删除、不重写这些 legacy rules，只记录观察信号。

## 4. Event 文件形态

P2 L1 event 使用内容寻址的一事件一文件 JSON。文件写入 `~/.abrain/l1/events/sha256/<aa>/<bb>/<event_id>.json`，其中 `<aa>` 和 `<bb>` 分别取 `event_id` 的前两段 hex。首期不放在 `.state`，因为 L1 Evidence Event 是 git 同步的语义证据源；`.state` 只用于 audit、diagnostics、reader 状态和 P1 shadow artifacts。

文件是 UTF-8、LF、无 BOM、末尾换行。文件 JSON 结构为 envelope + body：envelope 不参与 hash，body 使用 RFC 8785 / JCS canonical JSON。`event_id` 与 `body_hash` 均等于 `sha256(JCS(body))`。reconcile、reader 与 smoke 必须校验 envelope、body hash 和文件路径三者一致；同路径同名不同内容是严重错误，不允许覆盖。

```json
{
  "schema": "constraint-evidence-envelope/v1",
  "canonicalization": "RFC8785-JCS",
  "hash_alg": "sha256",
  "event_id": "<sha256-hex>",
  "body_hash": "<sha256-hex>",
  "body": {}
}
```

`body` 是 event 的唯一语义内容。任何字段变化都生成新的 event；correction、rejection、forget、retract、supersede 或 reactivation 都必须追加新 event，并通过 `causal_parents` 引用旧 event，禁止二次编辑旧 event。

## 5. Constraint Evidence Event v1 schema

### 5.1 Required body fields

```ts
interface ConstraintEvidenceEventBodyV1 {
  event_schema_version: "constraint-evidence-event/v1";
  event_type: ConstraintEvidenceEventType;
  created_at_utc: string;
  device_id: string;
  device_event_seq?: number;
  producer_nonce?: string;
  actor: ConstraintEvidenceActor;
  causal_parents: string[];
  session_id: string;
  turn_id: string;
  source: ConstraintEvidenceSource;
  intent: ConstraintEvidenceIntent;
  payload: ConstraintEvidencePayload;
  scope: ConstraintEvidenceScopeContext;
  sanitizer: ConstraintEvidenceSanitizer;
  neighbor_summary: ConstraintEvidenceNeighborSummary;
  producer: ConstraintEvidenceProducer;
}
```

`device_event_seq` 与 `producer_nonce` 至少存在一个，用于避免同一设备在同一时刻产生语义相同事件时被内容寻址误合并。`created_at_utc` 进入 hash，但只用于审计、分组和同层排序，不作为唯一因果依据。

### 5.2 Event type

```ts
type ConstraintEvidenceEventType =
  | "constraint_signal_observed"
  | "constraint_correction_observed"
  | "constraint_rejection_observed"
  | "constraint_forget_observed"
  | "constraint_retract_observed"
  | "constraint_not_memory_observed"
  | "constraint_unclassified_observed";
```

`constraint_signal_observed` 表示普通 durable constraint 信号。`constraint_correction_observed`、`constraint_rejection_observed`、`constraint_forget_observed` 和 `constraint_retract_observed` 必须通过 `causal_parents` 指向被影响的 event 或 legacy ref。`constraint_not_memory_observed` 表示 settings、tool contract 或 provider/budget/flag 等配置相关信号；它不等于 compiled constraint。`constraint_unclassified_observed` 表示 extractor 或 classifier 无法安全归类，但信号不能静默丢失。

### 5.3 Source / intent / payload

```ts
interface ConstraintEvidenceSource {
  channel: "agent_end" | "manual" | "replay";
  source_role: "user" | "assistant" | "system" | "tool";
  source_ref: string;
  quote_hash: string;
}

interface ConstraintEvidenceIntent {
  domain_hint: "constraint";
  operation_hint: "create" | "update" | "correction" | "forget" | "rejection" | "retract" | "not_memory" | "unclassified";
  confidence?: number;
}

interface ConstraintEvidencePayload {
  sanitized_quote: string;
  candidate_constraint_text?: string;
  candidate_title?: string;
  candidate_trigger_phrases?: string[];
  candidate_applies_when?: string;
  candidate_priority_hint?: "always" | "listed" | "unknown";
  not_memory_hint?: "settings" | "tool_contract" | "provider_budget_flag" | "unknown";
  unclassified_reason?: string;
}
```

`source_ref` 必须是稳定本地引用，不得泄漏敏感路径或 secret。`quote_hash` 是 sanitized quote 的 hash，用于 append failure audit 和排查。`candidate_priority_hint` 是 hint，不是写时 inject mode 事实；P3 前不得用它决定注入。

### 5.4 Scope context

```ts
interface ConstraintEvidenceScopeContext {
  active_project_binding: {
    project_id?: string;
    binding_reason: string;
    cwd_hash?: string;
  };
  scope_hint:
    | { kind: "global"; evidence: string }
    | { kind: "project"; project_id: string; evidence: string }
    | { kind: "unknown"; reason: string };
  scope_confidence?: number;
}
```

`scope_hint` 是 append 时的观察，不是最终 scope。P2 默认保守：项目绑定信号不得在 append 阶段升为 global；缺少明确 global evidence 时使用 project 或 unknown hint。project 到 global 的提升只能由后续 compiler 在 shadow view 中提出，并接受 P2/P3 的 scope review。

### 5.5 Sanitizer / neighbor / producer

```ts
interface ConstraintEvidenceSanitizer {
  sanitizer_name: string;
  sanitizer_version: string;
  status: "passed" | "redacted" | "blocked";
  replacements_count: number;
  blocked_reason?: string;
}

interface ConstraintEvidenceNeighborSummary {
  retrieval_mode: "readonly";
  input_hash: string;
  neighbor_refs: Array<{
    ref: string;
    scope: "global" | "project" | "unknown";
    title?: string;
    reason?: string;
  }>;
  summary: string;
}

interface ConstraintEvidenceProducer {
  name: "sediment.constraint-event-writer";
  version: string;
  code_version?: string;
  settings_hash?: string;
}
```

Sanitizer `blocked` 时不写 L1 event；只写最小 failure audit，且 audit 不包含未净化原文。`neighbor_summary` 是当时已知上下文摘要，只能用于后续 compiler 参考，不能作为跳过、删除或自动 globalize 的理由。

### 5.6 Optional body fields

```ts
interface ConstraintEvidenceOptionalFields {
  legacy_parallel_write?: {
    attempted: boolean;
    legacy_path_kind?: "tier1_ruleset_adjudicator" | "rule_writer" | "correction_pipeline" | "unknown";
    legacy_operation_hint?: "create" | "update" | "merge" | "archive" | "contested" | "none";
    legacy_audit_ref?: string;
  };
  llm_extraction?: {
    model: string;
    prompt_version: string;
    prompt_hash: string;
    input_hash: string;
    output_hash: string;
    parsed_output_hash?: string;
    acceptance: "accepted_for_event_append" | "diagnostic_only";
  };
  diagnostics?: ConstraintEvidenceDiagnostic[];
  privacy?: {
    contains_user_quote: boolean;
    redaction_level: "none" | "partial" | "heavy";
  };
}
```

`legacy_parallel_write` 只记录旧路径的 audit ref 与 operation hint，不记录 canonical mutation 指令，不记录可被执行的 canonical path。`llm_extraction` 仅在 classifier 或 extractor LLM 输出影响 event body 时必填。

## 6. Append 路径与失败策略

P2 新增独立模块，建议目录为 `extensions/sediment/constraint-evidence/`：

```text
extensions/sediment/constraint-evidence/
  types.ts
  canonical-json.ts
  hash-envelope.ts
  append.ts
  read.ts
  diagnostics.ts
  status.ts
```

`append.ts` 只允许写 `~/.abrain/l1/events/**` 和 P2 audit/diagnostics 的 `.state` 路径。任何目标路径落入 `~/.abrain/rules/**`、`~/.abrain/projects/*/rules/**`、`knowledge/**`、`projects/*/{maxims,decisions,patterns,facts,preferences,smells}/**` 时必须拒绝写入。

Append 使用 temp file + fsync + atomic rename + parent directory fsync。目标文件已存在且字节完全一致时返回 idempotent success；目标文件已存在但内容不同，返回 `CE_HASH_PATH_COLLISION` 并拒绝覆盖。

Append failure 不得静默通过。P2 旧路径仍是 runtime truth，因此 event append failure 不回退为 canonical mutation，也不阻断旧路径；但必须写最小 failure audit，包含 `session_id`、`turn_id`、`sanitized_quote_hash`、`intended_body_hash`、error code、timestamp 和 retry eligibility。若 sanitizer blocked，只写 `CE_SANITIZER_BLOCKED` audit，不写 L1 event。

P2 可以实现 retry，但 retry 源不能成为第二套 truth。若保存完整 sanitized event body，则必须使用同一 envelope/body/hash 结构，并最终 atomic rename 到 L1；若只保存 quote hash 与 failure metadata，则只能作为丢失候选与人工调查信号。

## 7. Parallel write 接入点

P2 的推荐接入点是 `extensions/sediment/index.ts` 中现有 Constraint / Tier-1 规则写入路径旁边，位置在信号已经完成 sanitize、active project binding 与 RuleDraft 或 correction signal 构造之后，旧 `writeAbrainRule`、`resolveRuleWrite` 或 `applyTier1RuleAdjudication` 调用之前或之后均可，但不能改变旧路径输入、输出或错误处理。

更稳妥的首期顺序是：尽可能早追加 witnessed event，然后继续旧路径；这样即使旧 adjudicator 后续 merge、archive、rescope 或失败，P2 仍保留原始 witnessed signal。若早 append 缺少 legacy outcome，则后续 audit 可以通过 `legacy_audit_ref` 关联旧路径结果，而不是回写 event。

P2 event writer 模块不得 import、require、dynamic import 或 re-export mutation symbols：`writeAbrainRule`、`applyTier1RuleAdjudication`、`archiveAbrainRule`、`deleteAbrainRule`、`mutateRuleStatusContested`、`resolveRuleWrite`、`runTier1JaccardAdjudication`、`curateProjectDraft`、`executeCuratorDecisionToBrain`、`writeProjectEntry`、`updateProjectEntry`。

P2 不注册新的 `agent_end` handler。它只在现有 sediment `agent_end` pipeline 内作为附加函数调用。P2 不注册 `session_start`、`before_agent_start` 或 injection path。

## 8. 状态反馈与观测指标

P2 必须定义 event 状态，但不能让 shadow compiled view 成为 runtime truth。状态存放在 `.state/sediment/constraint-events/**` 或 shadow compiler artifact 中，不写回 L1。

```ts
type ConstraintEventProjectionStatus =
  | "queued"
  | "projected"
  | "stale"
  | "invalid"
  | "append_failed";
```

`queued` 表示 L1 event 存在但尚未被 shadow compiler 消费。`projected` 表示 event 已进入最新 shadow compiler 输入。`stale` 表示存在 pending events 且 compiler 超过阈值未成功运行。`invalid` 表示 event 文件存在但 envelope、hash、schema 或 sanitizer contract 校验失败。`append_failed` 表示信号已观察到但 L1 event 未写成。

P2 观测指标至少包括：append attempts、append success count、append failure count、append loss candidate count、valid event count、invalid event count、queued event count、projected event count、oldest queued age、compiler last success time、compiler input event watermark、compiler event coverage ratio、not-memory hints count、not-memory exclusions count、settings-like-but-compiled count、scope hint to compiler scope delta count。

## 9. Diagnostics

P2 新增 diagnostic code：

```text
CE_APPEND_OK
CE_APPEND_FAILED
CE_APPEND_RETRY_PENDING
CE_APPEND_IDEMPOTENT_DUPLICATE
CE_HASH_ENVELOPE_MISMATCH
CE_HASH_PATH_MISMATCH
CE_HASH_PATH_COLLISION
CE_SCHEMA_UNSUPPORTED
CE_SANITIZER_BLOCKED
CE_NOT_MEMORY_SETTINGS
CE_NOT_MEMORY_TOOL_CONTRACT
CE_SCOPE_AMBIGUOUS
CE_UNCLASSIFIED
CE_LEGACY_PARALLEL_DELTA
CE_COMPILER_STALE
CE_COMPILER_DRAIN_OK
CE_EVENT_READER_INVALID
CE_EVENT_LOSS_DETECTED
CE_EVENT_NOT_MEMORY_LEAK
CE_EVENT_SCOPE_CONSERVATISM_BREACH
```

每个 diagnostic 必须有 consumer。首期 consumer 为 `event_audit`、`not_memory_audit`、`scope_review`、`compiler_liveness_report`、`manual_investigation`、`p3_injection_readiness`。`CE_EVENT_NOT_MEMORY_LEAK` 表示 not-memory hinted event 被 compiler 错误编译进 active constraint；`CE_EVENT_SCOPE_CONSERVATISM_BREACH` 表示 project hint 被 compiler 提升为 global 且缺少明确 global evidence；二者都是 P3 前必须处理的信号。

## 10. Smoke 与 oracle

新增 `scripts/smoke-constraint-evidence-event.mjs`。基础 smoke 不依赖真实模型，不触发真实 `agent_end`，使用 fixture 与临时 abrain home。

必测项：JCS canonicalization 稳定性；body 字段变化改变 event id；envelope 字段变化不改变 body hash 但 reader 能发现 envelope mismatch；路径 hash 与 body hash 不一致时拒绝读取；重复写同 event id 是 idempotent success；同路径不同内容是严重错误；temp file 不进入 reader；UTF-8/LF/末尾换行校验；sanitizer blocked 不写 L1；event writer 前后 canonical rules tree zero mutation；event writer 源码不出现 mutation symbols；event 路径不进入 `memory_search` corpus；shadow artifact 仍不被 `session_start` 注入。

Oracle fixture 至少覆盖：用户 durable directive 生成 `constraint_signal_observed`；纠错、拒绝、忘记、撤回生成对应 event type 并带 causal parent；settings/tool 信号生成 `constraint_not_memory_observed` 与 not-memory diagnostic；scope ambiguous 使用 unknown 或 project hint，不提升 global；project-bound signal 记录 active project binding，但不成为最终 scope truth；event append success + legacy write success、event append success + legacy write failure、event append failure + legacy write success、两者都失败这四种组合都有 audit 状态。

P2 还需扩展 `smoke-constraint-shadow-compiler.mjs`，使 shadow compiler 可以读取 L1 event fixture，但仍只输出 shadow report，不切换 runtime injection。

## 11. P2 到 P3 的晋级门

P2 到 P3 必须满足以下条件：append loss-rate 可观测且处于可接受区间；oldest queued age 不持续超阈值；shadow compiler 能稳定消费 L1 events 并生成包含 event coverage 的 shadow report；not-memory hinted event 不进入 active constraints；project-specific events 不被无证据提升到 global；event reader 对 corrupted envelope、hash mismatch、unsupported schema 均拒绝读取；canonical rules tree 在 P2 event append 模块运行前后 zero mutation；`session_start` 和 `before_agent_start` 不读取 L1 event 或 shadow compiled view。

P3 设计前必须重新进行多 T0 复审。P2 收集到的真实 append failure、not-memory leak、scope conservatism breach、compiler stale 或 legacy parallel delta 都应作为 P3 评审输入。

## 12. P1 报告进入 P2 的后续项

第一，调查 20 条 `SC_INPUT_BODY_HASH_MISMATCH`。P2 不依赖 legacy body hash 生成 event id，但 shadow compiler 的 legacy neighbor refs 和 diff report 仍需要解释旧 hash 差异来源，例如旧 writer hash 是否包含标题、frontmatter、timeline、newline normalization 或历史格式差异。

第二，细分 5 条 `SC_NOT_MEMORY_SETTINGS`。P2 schema 要区分配置事实、provider/budget/feature flag 与配置相关行为约束。append 阶段保留 `not_memory_hint`，compiler 后续决定排除或编译，不能用 append 阶段 hint 直接丢弃。

第三，审阅 11 条 `SC_UNCLASSIFIED` archived observed exclusions。P2 不改变这些 legacy rules，但应把 archived observed 的原因枚举细化为 behavioral archived、knowledge candidate archived、superseded observed、deprecated observed 或 unknown status observed，减少长期 `CE_UNCLASSIFIED`。

第四，P1 真实报告中没有 rescope、merge、conflict 样本。P2 不能把这些能力视为已被真实数据验证；必须继续用 fixture/oracle 覆盖，并在真实 event 中观察 scope delta、near duplicate candidate 和 conflict signal。

第五，区分 not-memory hints 与 not-memory exclusions。P1 summary 中 `notMemory=4`，diagnostics 中 `SC_NOT_MEMORY_SETTINGS=5`，说明 hint 与最终 exclusion 不是同一计数。P2 指标必须分别记录 `not_memory_hints`、`not_memory_exclusions`、`settings_like_but_compiled_constraints` 与 `diagnostic_only_not_memory_signals`。

## 13. 边界偏离信号与停止条件

如果 P2 event writer 修改 `rules/**`、`projects/*/rules/**`、knowledge 或其它 canonical memory，立即停止并回退。若 P2 注册新的 `session_start`、`before_agent_start` 或独立 `agent_end` handler，立即停止并重新评审。若 event append failure 被旧路径成功掩盖而没有 audit 与 loss metric，说明 evidence path 不可信，不能进入 P3。

如果 settings/tool event 被 compiler 编译进 active constraint，修 compiler prompt、domain routing 与 diagnostics，不新增工具名黑名单。若 project-bound event 被提升为 global 且没有明确 global evidence，修 scope rubric 与 active project binding evidence。若 queued event 长期不被 compiler 消费，修 compiler drain、status feedback 或 scheduling，不恢复 raw context 到 canonical mutation 的旧路径。

若 L1 event 放入 `.state`、SQLite、共享 append 日志或会被多设备并发追加的单文件，说明违反 ADR 0039 L1 SOT 边界，应回到内容寻址一事件一文件。若 L2/L3 被提前作为 truth source，停止 P2 并回到设计评审。

## 14. 实施顺序

PR1：本文档与 roadmap 指针。无 runtime 行为变化。

PR2：纯函数层。实现 canonical JSON、hash envelope、path derivation、event type、reader validation、diagnostics 类型和 smoke fixture；不接 `agent_end`，不写真实 abrain。

PR3：append writer 与 path guard。实现 temp + fsync + atomic rename、idempotent duplicate、collision 拒绝写入、sanitizer blocked、zero canonical mutation smoke。仍不接 runtime。

PR4：manual/replay harness。用 fixture 或手动输入生成 L1 event 到临时 abrain home，输出 append audit 与 status report。可选读取真实 P1 report 作为 diagnostic seed，但不触发真实 `agent_end`。

PR5：default-off parallel write 接入。通过显式 settings flag 在现有 sediment `agent_end` 内并行追加 event；默认 off，开启后旧路径行为不变。必须通过多 T0 复审和完整回归后才能合并。

PR6：shadow compiler 读取 L1 events。P1 compiler 继续输出 shadow view，增加 event coverage、queued/stale/projected 状态与 legacy parallel delta report；仍不切换 runtime injection。

## 15. T0 评审摘要

Opus 给出 GO，强调 P2 只能并行追加 immutable 内容寻址 L1 event，不能让 shadow compiled view 成为 runtime truth，也不能触碰 `session_start` 注入与 canonical memory。GPT-5.5 给出 GO，强调 append failure 与 event-loss observability 必须从第一阶段纳入状态记录，而不是后补。DeepSeek 给出 CONDITIONAL-GO，要求在设计中显式处理 P1 的 body hash mismatch、SC_UNCLASSIFIED 与 settings-like 分流。Kimi-k2.6 给出 GO for design doc but not implementation，强调 event schema、hash/path/JCS、failure 策略、queued/stale/projected 状态和 P1 20/5/11 后续项必须先冻结。

四路均回答“没有更好的 P2 主方案”。理由一致：direct P3 injection 会提前改变 runtime truth；canonical dual write 违反 ADR 0039；只写 audit 不能替代 L1 Evidence Event；先做 L2/L3 会过早冻结结构；batch/deferred append 增加丢失和排序复杂性。当前方案在保持旧路径不变的同时建立可审计 evidence，是 P2 的最低风险路径。
