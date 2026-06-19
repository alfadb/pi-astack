---
doc_type: notes
status: active
---

# ADR 0039 P1 — Constraint Shadow Compiler 详细设计

本设计是 ADR 0039 的第一份实施级方案，范围只覆盖 P1 Constraint shadow compiler。2026-06-19 的 4×T0 复审结论为 `CONDITIONAL-GO`：可以开始设计，但第一阶段必须限定为只读的 Constraint shadow compiler，不能提前实现 L1 Evidence Event，不能切换 `session_start` 注入，不能改写现有 canonical rules。

2026-06-19 对本设计稿的 4×T0 复审结论为 4/4 `SIGN-WITH-REVISIONS`，无 blocker。本文已并入复审提出的必须修订项：状态枚举闭合、逐 source coverage、scan baseline 无副作用防线、prompt/decision schema、validator 规则、diff category、hash 边界、artifact 隐私边界、audit 截断语义、PR 顺序调整。

## 1. 目标

P1 从现有 legacy rules 语料生成 shadow Compiled Constraint View、diff report 与 diagnostics，用来评估 ADR 0039 目标结构是否能安全替代当前 rules 写时裁决路径。P1 只产生可审计报告，不改变 runtime 读取面和写入面。

P1 必须回答五类问题：settings/tool not-memory、project/global rescope、near-duplicate merge、conflict、compact constraints。每条 legacy rule 都必须被表示为 compiled、merged source、excluded、unresolved 或 diagnostic 之一，不允许静默跳过。

P1 的成功条件不是替换现有系统，而是证明：现有 legacy rules 可以被完整读入、规范化、解释、渲染和对比；所有高影响语义裁决都有来源、模型、prompt、输入和输出 hash；每条 legacy rule 都有逐 source 归宿；shadow artifact 不会被 `memory_search`、`session_start` 或 rules writer 当成 canonical truth。

## 2. 非目标

P1 不追加 L1 Evidence Event，不实现 L2 stable view，不建立 L3 SQLite schema，不迁移 Knowledge，不拆分全域 corpus，不退休 `tier1-ruleset-adjudicator.ts`，不切换 `extensions/abrain/rule-injector/index.ts` 的注入来源。

P1 不调用 `writeAbrainRule`、`applyTier1RuleAdjudication`、`archiveAbrainRule`、`deleteAbrainRule`、`mutateRuleStatusContested`、`resolveRuleWrite`、`runTier1JaccardAdjudication`、`curateProjectDraft`、`executeCuratorDecisionToBrain`、`writeProjectEntry` 或 `updateProjectEntry`。这些函数属于 canonical mutation 或旧写时裁决路径。

P1 不把 settings、tool contract、model tier、provider、预算、feature flag、工具调用前置条件写成 memory constraint。此类输入只生成 not-memory diagnostic，并指向配置、工具声明、skill 文档或人工调查。

P1 不把 archived、superseded、deprecated 或 unknown-status rule 作为运行时复活路径，也不删除或复活任何 legacy rule。ADR 0031 的 archived 全文留盘与运行时复活边界保持不变。

## 3. 当前代码事实

### 3.1 规则写入路径

当前 Tier-1 rules 写入主要从 `extensions/sediment/index.ts` 的 `agent_end` 路径进入，经过 correction pipeline 后构造 `RuleDraft`。若 `tier1RuleSetAdjudication` 启用，调用 `extensions/sediment/writer.ts::listRulesInScope` 读取同 scope active rules，再调用 `extensions/sediment/tier1-ruleset-adjudicator.ts::resolveRuleWrite`。该路径会根据 LLM 裁决执行 create、update、merge 和 soft archive，最终落到 `writeAbrainRule`、`applyTier1RuleAdjudication` 和 `archiveAbrainRule`。

`extensions/sediment/rule-writer.ts` 仍承载 legacy rules 的写入格式、body hash、Jaccard 相似度函数和 always/listed body size 规则。`ALWAYS_BODY_MAX_CODE_UNITS` 与 `RULE_DEDUP_SIMILARITY_THRESHOLD` 只能在 P1 中作为诊断或候选缩小依据，不能继续作为语义决策门。

`extensions/sediment/writer.ts::mutateRuleStatusContested` 会把 contradicted rule 直接改成 `contested`。这也是 ADR 0039 要迁移出去的 canonical mutation，但 P1 不能改它，只能在 diff 中记录现状。

### 3.2 规则扫描与注入

`extensions/abrain/rule-injector/index.ts::scanRules` 只扫描 `rules/{always,listed}` 与 active project 的 `rules/{always,listed}`。`readRuleFile` 在 `status !== "active"` 时直接跳过，因此它适合构造当前注入 baseline，但不适合作为 P1 的完整 legacy source scanner。

`extensions/abrain/rule-injector/index.ts::composeRuleSection` 与 `composeRuleInjection` 生成当前 `BEGIN_ABRAIN_RULES` catalog。`session_start` 刷新 `cachedRules`、设置 footer、启动 watcher；`before_agent_start` 在主会话 system prompt 中追加 catalog。P1 只能读取这些输出作为 legacy baseline，不能改这两个事件处理器。

### 3.3 memory_search 排除 rules

当前 `extensions/memory/parser.ts` 在 world store walker 中用 `WORLD_EXTRA_IGNORE_DIRS = { projects, vault, rules }` 排除 rules，`listFilesWithRg` 也通过 `--glob !**/rules/**` 排除 rules；`.state` 目录同样被普通 memory corpus 排除。P1 不能只依赖这些代码事实长期不变，而要把“不进入 `memory_search` 候选文件集”写成 smoke：枚举 memory corpus 时，`~/.abrain/.state/sediment/constraint-shadow/**`、`rules/**` 与 `projects/<id>/rules/**` 都不得出现。

### 3.4 可复用的只读能力

P1 可以复用 `extensions/memory/parser.ts::splitFrontmatter`、`parseFrontmatter`、`splitCompiledTruth`、`scalarString`、`scalarNumber`、`relationValues` 解析 legacy markdown。可以复用 `_shared/runtime.ts::resolveActiveProject`、`abrainProjectDir`、`listAbrainProjects`、`abrainStateDir`、`validateAbrainProjectId` 定位 abrain 与 project。可以复用 `extensions/sediment/sanitizer.ts::sanitizeForMemory` 清洗进入 LLM prompt 和 artifact 的文本。可以复用 `extensions/sediment/rule-writer.ts::ruleBodyHash`、`ruleBodySimilarity`、`alwaysContentSizeUnits` 等纯函数作为 hash、候选缩小或诊断依据。

`extensions/sediment/tier1-ruleset-adjudicator.ts` 的 prompt-native full-candidate-set 思路和 `streamSimple` 调用方式可以参考，但不应复用其 `RuleSetDecision` 和 `resolveRuleWrite`，因为它们表达 mutation，而 P1 需要表达 projection。

## 4. 模块边界

推荐新增目录：

```text
extensions/sediment/constraint-compiler/
  types.ts
  legacy-scan.ts
  normalize.ts
  prompt.ts
  llm-compiler.ts
  validate-decision.ts
  render.ts
  diff.ts
  diagnostics.ts
  shadow-runner.ts
```

首期不接入 runtime hook。PR 1 只写本文档和 roadmap 指针；PR 2 实现无 LLM 的纯函数层与最小 validator；PR 3 接入 LLM compiler、完整 validator 与 smoke；PR 4 只允许手动或默认关闭的后台诊断触发，仍不切换注入。

### 4.1 `types.ts`

`types.ts` 定义 P1 稳定类型，不复用 `CuratorDecision`、`RuleSetDecision` 或 writer result。核心类型包括 `LegacyRuleSourceRecord`、`AuditConstraintSourceRecord`、`GovernanceCaseRecord`、`NormalizedConstraintRecord`、`ConstraintCompilerDecision`、`RenderedConstraintView`、`ConstraintDiffReport`、`ConstraintShadowDiagnostic`。

```ts
export type ConstraintScope = { kind: "global" } | { kind: "project"; projectId: string };
export type LegacyRuleStatus = "active" | "contested" | "archived" | "superseded" | "deprecated" | "unknown";
export type ConstraintCategoryHint = "behavioral_constraint" | "settings_not_memory" | "tool_contract_not_memory" | "knowledge_not_constraint" | "potential_conflict_signal" | "unknown";
export type ConstraintSourceRecord = LegacyRuleSourceRecord | AuditConstraintSourceRecord | GovernanceCaseRecord;
```

`potential_conflict_signal` 只是输入弱提示，不能决定 conflict；真正的 conflict 是 compiler 输出判断。`GovernanceCaseRecord` 默认只用于 fixture/oracle；若未来要进入 compiler prompt，必须标为 separate context，不计入 legacy rule coverage。

### 4.2 `legacy-scan.ts`

`legacy-scan.ts` 负责只读扫描 legacy sources，不做语义判断。它必须直接枚举 `~/.abrain/rules/{always,listed}/*.md` 与 `~/.abrain/projects/<id>/rules/{always,listed}/*.md`，并读取 `status !== active` 的文件。当前 legacy layout 中 archived、contested、superseded、deprecated 规则仍以 frontmatter status 表达，物理上可能仍留在 `always/` 或 `listed/` 目录；若 audit 引用的 rule 文件已不存在，scanner 必须生成 `SC_INPUT_MISSING_LEGACY_REF` diagnostic，而不是补造 source record。`scanRules()` 只能用于 legacy injection baseline，不能作为完整 source scanner。

建议接口：

```ts
export interface LegacyConstraintScanOptions {
  abrainHome: string;
  cwd: string;
  includeProjects?: "active" | "all";
  includeStatuses?: "all" | "active_only";
  maxAuditRows?: number;
}

export interface LegacyConstraintScanResult {
  abrainHome: string;
  cwd: string;
  activeProjectId?: string;
  bindingReason?: string;
  rules: LegacyRuleSourceRecord[];
  audits: AuditConstraintSourceRecord[];
  warnings: Array<{ code: string; message: string; path?: string }>;
}
```

扫描 audit 时首期只读 `~/.abrain/.state/sediment/audit.jsonl`、`~/.abrain/.state/sediment/outcome-ledger.jsonl` 和 `<projectRoot>/.pi-astack/sediment/audit.jsonl`。audit record 只作为 provenance 和治理信号，不直接产生 compiled constraint；它可以附着到同 slug/source 的 rule 上，也可以作为 diff rationale 的 source audit ref。audit schema 解析 best-effort，未知版本或 malformed row 进入 diagnostic。`maxAuditRows` 必须有确定性语义：按固定文件顺序、文件内 byte offset 顺序读取，tail 截断或全局截断策略必须写入 input snapshot；发生截断时生成 `SC_AUDIT_TRUNCATED`，并让 `inputRootHash` 覆盖实际进入 compiler 的 audit row 集合与截断参数。

### 4.3 `normalize.ts`

`normalize.ts` 把 source records 转成 prompt 输入。它负责 timeline strip、frontmatter 标准化、hash 计算、scope hint、category hint、sanitizer、malformed diagnostic 与 stable `inputRootHash`。所有 record 必须有 `sourceRef`，所有解析失败必须进入 diagnostic。

`inputRootHash` 使用确定性 canonicalization：对进入 compiler 的 normalized rule records、audit records、governance cases、active project binding、compiler input options 和 truncation parameters 做稳定 key 排序后取 sha256。mtime、文件枚举原始顺序、run-id、duration、`generated_at` 等非确定性字段不得进入 `inputRootHash`。timeline 是否参与由 record kind 决定：rule body 的 compiled truth、frontmatter 与 source hash 必须参与；timeline 作为 provenance 参与 source record hash，但 renderer 的 output hash 不得因未进入 decision 的 timeline 字段漂移。

建议接口：

```ts
export function normalizeConstraintSources(
  sources: ConstraintSourceRecord[],
  opts: NormalizeConstraintOptions,
): NormalizeConstraintResult;
```

`settings_not_memory` 与 `tool_contract_not_memory` 在 normalize 阶段只能是 hint，不能作为 silent drop。最终 exclusion 必须由 compiler decision 或 deterministic validation 显式给出，并在 diff report 中呈现。

### 4.4 `prompt.ts` 与 `llm-compiler.ts`

`prompt.ts` 构造 compiler prompt，明确模型角色是 Constraint Shadow Compiler，不是 writer。prompt 必须包含以下固定段落：role 与禁止事项；normalized source record 列表；当前 active injection baseline 摘要；五类任务说明；status 处理规则；输出 JSON schema；coverage 要求；uncertainty 规则。prompt 要求只输出 JSON，不得发明 `sourceId`，不得输出 Markdown，不得把 settings/tool contract 编译成 constraints，不得把 project-specific 信号提升到 global，除非 source evidence 明确跨项目。

状态处理规则必须明确：`active` 可进入 compiled constraint；`contested` 默认进入 unresolved 或 conflict diagnostic，除非 evidence 明确可排除；`archived`、`superseded`、`deprecated` 默认进入 `legacy_archived_observed`、`obsolete_archived` 或 `superseded_observed` 类 exclusion 或 diagnostic，不进入 active compiled constraints；`unknown` 必须进入 diagnostic 或 unresolved。所有状态仍计入 source coverage。

LLM 输出的 `ConstraintCompilerDecision` 至少包含：`schemaVersion`、`inputRootHash`、`constraints[]`、`exclusions[]`、`unresolved[]`、`merges[]`、`rescopeProposals[]`、`mappings[]`、`diagnostics[]`。每个 source rule 必须出现在 `constraints[].sourceRecordIds`、`exclusions[].sourceRecordIds`、`unresolved[].sourceRecordIds`、`mappings[]` 或 parse/missing diagnostic 中之一。LLM 不拥有最终 id；它只能输出 source grouping、scope proposal、title、body、reason 和 references。`shadow_id` / `constraintId` 由 validator 或 renderer 基于 scope、inject mode、sorted source ids 与 normalized compiled body hash 确定性派生；LLM-proposed id 若保留，只能作为 advisory field，不参与 output hash。

首期 token budget 采用 fail-closed 策略：若 normalized source records 超过配置的 prompt 预算，不做分批语义合并，不产出伪 view，而是生成 `SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS` diagnostic。分批 compiler 与跨批 merge 是 P2+ 或后续 P1 修订项，不能在首期临时实现。

`llm-compiler.ts` 调用模型并返回 raw text、model、prompt hash、input hash、output hash、duration 与 parse status。首期建议增加专用设置项 `constraintShadowCompilerModel`；缺省可复用 `SedimentSettings.curatorModel`，不建议回退到低能力 classifier。模型不可用或 parse 失败时只能产生 diagnostic，不能回退为 create、merge 或 archive。

### 4.5 `validate-decision.ts`

`validate-decision.ts` 防止 renderer 接收不可信结构。PR 2 必须先落最小 validator，让 renderer 和 diff 只消费 already-validated fixture；PR 3 再补 LLM parse 与完整语义 validator。硬校验包括：所有 `sourceRecordIds` 必须存在；确定性派生后的 `constraintId` 唯一；project scope 必须引用已知 project；compiled body 不得为空；not-memory diagnostic 必须有 source；每个 `LegacyRuleSourceRecord.sourceId` 必须有且只有一个主归宿；同一 source 不得同时出现在 constraint 和 exclusion 中；merged constraint 必须覆盖所有被合并 source；`exclusion.reason` 与 `unresolved.reason` 必须是声明枚举；`rescopeProposal.from_scope` 必须与 source 当前 scope 一致；LLM 不得输出 canonical path mutation。校验失败默认整体 reject decision，生成 diagnostic；只有 malformed 单条 source 已在 scan/normalize 阶段转成 diagnostic 时，才允许 partial coverage 继续。

### 4.6 `render.ts`

`render.ts` 是确定性 renderer，不调用 LLM。它把 validated `ConstraintCompilerDecision` 渲染为 shadow markdown view 和 `shadow_output_hash`。该 hash 只是“本次 validated decision 快照的确定性渲染指纹”，不构成 ADR 0039 L2 stable view，也不承诺 LLM 过程可逐字节复现。确定性只覆盖 validate、render、diff 三层。渲染规则固定为 UTF-8、LF、末尾换行、固定标题层级、固定 key 顺序。排序规则为 global 先于 project，projectId 字典序，always 先于 listed，constraint 按 priority 降序、title 字典序、constraintId 字典序。

shadow markdown 结构建议：

```md
---
schema_version: constraint-shadow-view/v1
view: compiled_constraint_shadow
projector: constraint-shadow-compiler
projector_version: ...
template_version: ...
input_root_hash: ...
decision_hash: ...
shadow_output_hash: ...
shadow_only: true
---

# Compiled Constraint View (Shadow)

## Global always

## Global listed

## Project <id> always

## Project <id> listed

## Conflicts

## Not-memory diagnostics
```

`generated_at`、duration、run-id、本地绝对路径等非确定性字段若输出，只能放在 non-canonical metadata、audit 或单独 diagnostic，不能参与 `shadow_output_hash`。

### 4.7 `diff.ts`

`diff.ts` 对比 legacy injection snapshot 与 shadow compiled view。legacy baseline 可以复用 `scanRules()` 与 `composeRuleSection()` 的纯读结果来代表当前 active injection view，但必须证明不会触碰 `cachedRules`、watcher 或 footer；若无法证明，必须通过新建纯读 wrapper 枚举 active baseline。PR 2 的 diff 先使用 fixture baseline；真实 baseline 集成放到 PR 3 或之后。

Diff report 必须同时输出 `diff.md` 和机器可读 `diff.json`。`diff.json` 至少包含 total source count、mapped/unmapped count、constraints/exclusions/unresolved count、required category counts、rescope counts、not-memory count、conflict count、archived observed count、validation status 与逐 source rows。

Diff category 判定：`kept` 表示 active source 被一对一编译且 scope/inject hint 未变；`compact` 表示 source 被保留但 compiled body 明显压缩或 always/listed 注入摘要变化；`merge_near_duplicates` 表示多个 source 映射到同一 deterministic constraintId；`rescope_global_to_project` / `rescope_project_to_global` 来自 validated rescope proposal；`exclude_not_memory_settings` / `exclude_not_memory_tool_contract` 来自 exclusion reason；`split_knowledge_candidate` 来自 knowledge candidate exclusion；`mark_conflict` 来自 unresolved conflict；`keep_unresolved` 来自非 conflict unresolved；`legacy_archived_observed` 覆盖 archived、superseded、deprecated 和 unknown-status legacy rule 的观察归宿；`missing_mapping` 只允许作为 validation failure 或 diagnostic-backed row，不允许作为普通成功状态。

### 4.8 `diagnostics.ts`

Diagnostics 必须有 consumer，不能成为无人读取的记录。首期 consumer 枚举为 `diff_report`、`p2_event_schema_backlog`、`not_memory_audit`、`scope_review`、`compiler_prompt_iteration`、`manual_investigation`。

建议 codes：

```text
SC_INPUT_MALFORMED_RULE
SC_INPUT_MISSING_LEGACY_REF
SC_INPUT_BODY_HASH_MISMATCH
SC_AUDIT_TRUNCATED
SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS
SC_SCOPE_AMBIGUOUS
SC_SCOPE_RESCOPE_PROPOSED
SC_NOT_MEMORY_SETTINGS
SC_NOT_MEMORY_TOOL_CONTRACT
SC_NEAR_DUPLICATE_GROUP
SC_CONFLICT_DETECTED
SC_COMPACT_REQUIRED
SC_ARCHIVED_REACTIVATION_RISK
SC_LEGACY_INJECTION_DELTA
SC_RENDER_DRIFT
SC_COMPILER_MODEL_UNAVAILABLE
SC_COMPILER_PARSE_FAILED
SC_COMPILER_VALIDATION_FAILED
SC_SHADOW_ONLY_VIOLATION_ATTEMPT
SC_UNCLASSIFIED
```

默认 consumer：`SC_INPUT_*`、`SC_AUDIT_TRUNCATED`、`SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS` → `diff_report` 与 `manual_investigation`；`SC_NOT_MEMORY_*` → `not_memory_audit`；`SC_SCOPE_*` → `scope_review`；`SC_NEAR_DUPLICATE_GROUP`、`SC_CONFLICT_DETECTED`、`SC_COMPACT_REQUIRED` → `diff_report`；`SC_RENDER_DRIFT`、`SC_COMPILER_MODEL_UNAVAILABLE`、`SC_COMPILER_PARSE_FAILED`、`SC_UNCLASSIFIED` → `compiler_prompt_iteration`；`SC_COMPILER_VALIDATION_FAILED` → `compiler_prompt_iteration` 与 `manual_investigation`；`SC_SHADOW_ONLY_VIOLATION_ATTEMPT` → `manual_investigation` 并 fail closed。

### 4.9 `shadow-runner.ts`

`shadow-runner.ts` 编排 scan、normalize、LLM compile、validate、render、diff、diagnostics。默认只返回结果，不写文件。若 `writeArtifacts` 启用，只能写入 `~/.abrain/.state/sediment/constraint-shadow/`，不能写入 `rules/**`、`projects/<id>/rules/**`、普通 memory corpus 或 project source tree。

建议 artifact 结构：

```text
~/.abrain/.state/sediment/constraint-shadow/
  audit.jsonl
  latest/
    input.normalized.json
    prompt.txt
    decision.json
    compiled-view.md
    diff.md
    diff.json
    diagnostics.json
  runs/
    <run-id>/
      input.normalized.json
      prompt.txt
      decision.json
      compiled-view.md
      diff.md
      diff.json
      diagnostics.json
```

`run-id` 建议使用 `timestamp + inputRootHash prefix`。`audit.jsonl` 只记录 shadow run 元信息、paths、hash、counts 与 error，不记录未清洗原文。所有写入 artifact 的文本必须先经过 sanitizer。PR3 默认不保存模型原文，只记录 `rawOutputHash`；若后续需要 `compiler.raw.txt`，只能保存模型对 sanitized prompt 的输出，不能保存未净化转录、secret、vault 内容或未脱敏 tool output。

## 5. 输入模型

`LegacyRuleSourceRecord` 是 P1 的主输入。字段至少包含：`sourceKind`、`sourceId`、`slug`、`title`、`path`、`scope`、`injectMode`、`status`、`body`、`rawBodyHash`、`computedBodyHash`、`rawFileHash`、`frontmatterHash`、`provenance`、`confidence`、`kind`、`triggerPhrases`、`appliesWhen`、`mustDoSummary`、`created`、`updated`、`frontmatter`、`timelineEvents`、`sourceRef`。

每个 `LegacyRuleSourceRecord.sourceId` 必须稳定：建议由 `scope + projectId + injectMode + slug + rawFileHash` 或等价 canonical tuple 生成。status 为 `archived`、`superseded`、`deprecated`、`contested` 或 `unknown` 的 source 仍然计入 coverage，但默认不会进入 active compiled constraints。

`AuditConstraintSourceRecord` 至少包含：`sourceKind`、`sourceId`、`timestamp`、`sessionId`、`operation`、`lane`、`ruleSlug`、`ruleScope`、`projectId`、`reason`、`rawSanitizedRow`、`sourceRef`。audit 中可能含旧路径字段，P1 只能尽力解析并保留 raw sanitized row。

`GovernanceCaseRecord` 可用于 fixture 与 oracle，表达已知错误类别和期望 shadow 行为。类别包括 `settings_tool_not_memory`、`scope_misroute`、`near_duplicate`、`conflict`、`over_compaction`、`raw_agent_end_write_regression`。Governance case 默认不进入生产 compiler coverage，只用于 smoke/oracle；若未来用于 prompt 示例，必须不让它影响 legacy source coverage 统计。

## 6. 输出模型

`ShadowCompiledConstraintView` 必须带 `schema_version: "constraint-shadow-view/v1"`、`shadow_only: true`、`view_id`、`compiler`、`input_snapshot`、`legacy_injection_snapshot`、`constraints`、`exclusions`、`unresolved`、`diagnostics_ref`、`diff_report_ref`、`shadow_output_hash`。

`ShadowConstraint` 必须带 `shadow_id`、`status`、`scope`、`project_id`、`priority_hint`、`title`、`compiled_body`、`must_do_summary`、`applies_when`、`trigger_phrases`、`source_rule_refs`、`source_audit_refs`、`decision_trace`、`provenance`。

`ShadowExclusion` 必须带 `reason`，取值至少包括 `settings_not_memory`、`tool_contract_not_memory`、`knowledge_candidate`、`obsolete_archived`、`superseded_observed`、`legacy_archived_observed`、`malformed_unusable`。每个 exclusion 必须绑定 diagnostic 或 diff row。

`ShadowUnresolved` 必须带 `reason`，取值至少包括 `conflict`、`scope_ambiguous`、`insufficient_provenance`、`parse_error`、`model_uncertain`、`unknown_status`。conflict 不得自动 archive，scope ambiguous 不得自动 globalize。

`ConstraintShadowDiffReport` 必须有逐 source mapping。每个 legacy source 的主归宿只能是 compiled、merged_source、excluded、unresolved 或 diagnostic。`missing_mapping` 是 validation failure，不是可接受结果。

## 7. Provenance 与 hash

Compiler provenance 至少包含：`compiler_name`、`compiler_version`、`prompt_version`、`model`、`prompt_hash`、`input_hash`、`output_hash`、`sanitizer_version`、`started_at_utc`、`finished_at_utc`、`duration_ms`、`git_head`。其中 `started_at_utc`、`finished_at_utc`、`duration_ms`、本地绝对路径和 `run-id` 只进 audit 或 non-canonical metadata，不进 `inputRootHash` 或 `shadow_output_hash`。

Input snapshot provenance 至少包含：`abrain_home`、`cwd`、`active_project_id`、`scanned_at_utc`、`input_set_hash`、`rule_file_count`、`audit_row_count`、`governance_case_count`、`roots`、`audit_truncation`。`scanned_at_utc` 只用于 audit，不进入 `input_set_hash`。

Output provenance 至少包含：`derived_from_rule_refs`、`derived_from_audit_refs`、`derived_from_governance_refs`、`semantic_decision_hash`、`llm.model`、`llm.prompt_version`、`llm.prompt_hash`、`llm.input_hash`、`llm.raw_output_hash`、`llm.parsed_output_hash`、`sanitizer.replacements`、`acceptance.mode = "shadow_only"`、`canonical_mutation = false`、`injection_mutation = false`。

P1 可以记录 LLM output hash，但不能把 LLM output 当作 ADR 0039 L2 stable view。未来若要进入 stable view，P2+ 必须先把语义事实固化为 L1 Evidence Event，再由确定性 renderer 投影。P1 的 `shadow_output_hash` 只说明同一 validated decision 与同一 renderer/template 能得到同一 shadow bytes。

## 8. Shadow-only 防线

静态防线：`constraint-compiler/**` 不得 import writer mutation symbols。smoke 必须扫描源码并拒绝出现 `writeAbrainRule`、`applyTier1RuleAdjudication`、`archiveAbrainRule`、`deleteAbrainRule`、`mutateRuleStatusContested`、`resolveRuleWrite`、`updateProjectEntry` 等 direct import、dynamic import、require 字符串和 barrel re-export。

路径防线：artifact writer 只允许写 `~/.abrain/.state/sediment/constraint-shadow/**`。任何目标路径匹配 `rules/always/**`、`rules/listed/**`、`projects/*/rules/**`、`knowledge/**`、`projects/*/{maxims,decisions,patterns,facts,preferences,smells}/**` 时必须 fail closed，并生成 `SC_SHADOW_ONLY_VIOLATION_ATTEMPT`。

运行时防线：P1 不注册 `agent_end`、`session_start` 或 `before_agent_start` handler。若后续 PR 需要后台触发，必须默认 off，有显式 feature flag 名称与默认值，并再次复审证明它不会阻塞 `agent_end`，不会刷新 `cachedRules`，不会让 shadow output 被注入。

验证防线：运行 shadow compiler 前后读取 rules tree 文件列表、mtime 与 content hash，断言 zero mutation。运行后执行 memory corpus 枚举 smoke，断言 shadow artifact 不在候选文件集中。调用 legacy injection baseline 的 diff 路径前后，必须断言 `cachedRules` 与 watcher 状态不变；否则改用纯读 wrapper。

## 9. Smoke 与 oracle

新增 `scripts/smoke-constraint-shadow-compiler.mjs`。首期使用 fixture 与 mock compiler decision，不依赖真实模型。真实模型 smoke 可作为 optional，不作为基础 CI 条件。

必测 fixture：not-memory settings/tool、project/global scope、near-duplicate、conflict、compact、archived/runtime tombstone、superseded/deprecated/unknown status、audit 引用缺失 rule、empty corpus、LLM failure、invalid decision、source coverage、inputRootHash stability、shadow-only zero mutation。

关键断言：settings/tool 规则进入 exclusions 与 diagnostics，不进入 constraints；project-specific 规则不得出现在 global compiled view；near-duplicate group 保留所有 source refs；conflict 进入 unresolved，不触发 archive；archived/superseded/deprecated/unknown rule 不进入 active compiled constraints，但出现在 observed/exclusion/unresolved/diagnostic；LLM failure 返回 error diagnostic，不生成伪 view；invalid source id、unknown projectId、duplicate deterministic constraintId 被 reject；运行前后 rules 文件内容不变；`missing_mapping=0` 是成功条件。

source coverage oracle 必须覆盖 active、listed、contested、archived、superseded、deprecated、unknown status、malformed frontmatter 和 audit-missing-ref。每条 source 都必须有逐 source mapping，缺失即失败。

input hash oracle 必须验证：打乱文件枚举顺序不改变 `inputRootHash`；改 mtime 不改变 `inputRootHash`；改变参与输入的 body/frontmatter/audit row 会改变 `inputRootHash`；改变 run-id、duration、`generated_at` 不改变 `inputRootHash` 或 `shadow_output_hash`。

建议新增 `scripts/oracle-constraint-shadow-compiler.mjs`，用固定 fixture 生成 golden compiled view hash 与 diff report hash。oracle 用于检测 renderer、diff 与 validator 的确定性漂移，不用来固定 LLM 语义分数。

## 10. P1 到 P2 的晋级门

Coverage gate：所有 legacy rule files 都有输出归宿；0 silent skip；active、listed、contested、archived、superseded、deprecated、unknown status 都进入输入快照或 diagnostic；每个 `LegacyRuleSourceRecord.sourceId` 必须映射到 compiled、merged source、excluded、unresolved 或 diagnostic。

Required diff categories gate：五类必需差异都有真实样本或 governance fixture 覆盖：settings/tool not-memory、project/global rescope、near-duplicate merge、conflict、compact constraints。

Shadow-only gate：多次运行后 canonical rules tree zero mutation；`session_start` 与 `before_agent_start` 不读取 shadow artifact；静态检查确认未 import writer mutation symbols；artifact writer 不能写 canonical path；baseline diff 不改变 `cachedRules` 或 watcher 状态。

No-loss gate：每条 `provenance=user-expressed` 或明确 durable directive 的 legacy rule 必须在 shadow output 中可追踪；merge 后完整保留 source refs；conflict 和 uncertainty 不得被 compact 掩盖。

Not-memory gate：settings/tool contract 不得出现在 `constraints[]`；每个 not-memory exclusion 必须有 diagnostic consumer。

Scope conservatism gate：global 输出必须有明确 global evidence；ambiguous rescope 只能是 `rescope_proposed` 或 unresolved；project-specific 信号进入 global view 是 blocker。

Reproducibility gate：输出包含 input snapshot hash、compiler version、prompt hash、model、raw output hash、parsed output hash；同 input snapshot 下的 LLM 非确定性差异必须进入 drift diagnostic，不能静默覆盖；同 validated decision 下的 renderer/diff/validator 输出必须稳定。

P2 readiness gate：冻结 Constraint Evidence Event v1 最小 schema，至少包含 sanitized quote、source role、session/turn、scope hint、active project binding、sanitizer result、neighbor summary、event id/hash；定义 event append 失败策略和 queued/stale/projected 状态反馈。

Review gate：P1 report schema、shadow-only guard、P2 event schema readiness 需再次经过多 T0 复审，无 blocker 后才能进入 P2。

## 11. 走偏信号与停止条件

若 shadow compiler 修改任何 rules 文件，立即停止并回退该实现。若 shadow output 被 `session_start` 注入或进入 `memory_search`，立即停止。若 settings/tool 信号继续被编译进 constraints，说明 domain routing 失败，修 prompt 和 diagnostic，不加工具名黑名单。若 project-specific 信号进入 global view，修 scope rubric 和 project binding evidence，不加项目名黑名单。

若 compiler 频繁输出大规模无解释重写，必须增加 conflict、uncertainty、来源 hash 和差异说明，不能用固定 archive 数量上限替代语义判断。若 LLM 模型不可用，P1 必须 hard error 到 diagnostic，不能用 grep、BM25 或字符串相似度生成语义 view。

P1 不进入 P2 的条件：新增 smoke 未通过；现有 `smoke-abrain-rule-injector.mjs`、`smoke-tier1-ruleset-adjudication.mjs`、`smoke-abrain-rule-writer.mjs`、`smoke-abrain-rule-writer-fs.mjs`、`smoke-memory-sediment.mjs` 出现 regression；shadow diff 报告无法解释 source coverage；compiled view 连续多次为空或每次全量无解释变化。

## 12. 实施顺序

PR 1：本文档与 roadmap 指针。无 runtime 行为变化。

PR 2：纯函数层与最小 validator。实现 `types.ts`、`legacy-scan.ts`、`normalize.ts`、`render.ts`、`diff.ts`、`diagnostics.ts`、`validate-decision.ts` 的结构性子集，只跑 fixture 与 deterministic smoke，不调 LLM。PR 2 的 renderer/diff 只消费 already-validated fixture，不导出 runner 级 LLM 接口。

PR 3：LLM compiler 与完整 validator。实现 `prompt.ts`、`llm-compiler.ts`、`validate-decision.ts` 完整校验、`shadow-runner.ts` 和 `smoke-constraint-shadow-compiler.mjs`。smoke 默认使用 mock decision；真实 LLM 失败只产 diagnostic。

PR 4：手动诊断入口或默认关闭的后台触发。必须有独立复审、显式 feature flag 名称和默认值。只写 `.state/sediment/constraint-shadow/**`，不接入注入，不写 canonical，不阻塞 `agent_end`。

PR 5：P2 设计。基于 P1 report 与复审结果，冻结 Constraint Evidence Event v1 和并行 event append 边界。

## 13. T0 复审摘要

四路 T0 均支持 P1 从只读 shadow compiler 开始，没有要求回到 ADR 0039 架构层重新讨论。共同结论是：当前最小有效阶段是 legacy rules corpus → normalized source records → structure-validated LLM compiler decision → deterministic shadow render → diff report → diagnostics。第一阶段的核心交付是完整 diff 与 shadow-only 证明，而不是 runtime 切换。

Opus 强调当前 active-only scanner 不足，P1 必须新增 archived/contested/superseded/deprecated/unknown-status 只读枚举器，闭合 coverage gate，并避免触碰 writer mutation 与 injection cache。GPT-5.5 强调 schema、provenance、diagnostic consumer、source coverage、hash 边界和 P2 晋级门。DeepSeek 强调 prompt/decision schema、validator、diff category、smoke/oracle、zero mutation、LLM failure hard error 与停止条件。Kimi-k2.6 强调模块拆分、deterministic renderer、validated decision、artifact 路径、audit 截断语义和最小 PR 分解。

4×T0 对“是否存在更好的第一阶段方案”的回答均为无。理由一致：直接做 P2 event parallel write 会在缺少 corpus diff 证据前冻结 event schema；直接切 P3 注入会影响主会话行为；纯 deterministic scanner 无法回答 near-duplicate、scope、conflict、compact 与 not-memory 这些 ADR 0039 的核心语义问题。P1 shadow compiler 是当前最低风险且信息增益最高的阶段。
