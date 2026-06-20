# ADR0039 Constraint L2 迁移 多 T0 一致共识 + 实施规格（2026-06-20）

> `second-brain-memory-multi-t0-consensus-refactoring-protocol` 要求的 memory-domain
> 架构分片执行前共识记录。参与 T0（4 厂跨架构）：anthropic/claude-opus-4-8、
> openai/gpt-5.5、deepseek/deepseek-v4-pro、moonshotai/kimi-k2.7-code。主会话只主持，
> 不投决定票。**结论：2 轮后 4/4 收敛一致 —— Option A + NS-2 + FIX-1。**

## 分片范围

把 active constraint 编译视图产出到 git-tracked `l2/views/constraint`，用确定性 renderer
（§4.1/§4.3），与 L1 可 reconcile，作为 **SHADOW**：本片 **不翻注入读源**（runtime 注入仍读
`.state`，read-flip 是后续单独 gated 步，类 Knowledge Phase C）。不动 Knowledge、不删 `rules/**`。

## R1（4/4 PROCEED + Option A）

四家一致：PROCEED；选 **Option A**（把 LLM 编译 decision 固化为不可变内容寻址 L1 事件 →
确定性 renderer → git L2 shadow）。拒 B（先 legacy→L1 backfill：过大，且仍需 A 叠加）、
拒 C（直接把 decision.json 当 git 派生物：decision.json 非内容寻址不可变 L1，违 §4.1/§4.3）。
`render.ts` 已是确定性内容哈希 renderer；缺口是它写 gitignored `.state` 且 `decision.json`（LLM
产物）未固化为 L1。

## 关键新发现（R2 期间核码证实，重塑命名空间决策 + 揭一个 live 隐患）

constraint `event-scan.ts` 遍历 `l1/events/sha256/`，`constraint-evidence/read.ts:61` 把任何
envelope `schema != constraint-evidence-envelope/v1` 标为 INVALID（CE_SCHEMA_UNSUPPORTED,
severity=error → invalidEventIds + diagnostic）。**Knowledge L1 事件（knowledge-evidence-
envelope/v1）已与 constraint 共用 `l1/events/sha256/`（2788 个）**。部署的 event-coverage
`invalidEvents:0` 是 **stale**（10:26 生成，早于 knowledge backfill）。后果：
- **live 隐患（opus 揭，P0 级）**：constraint 编译器下次运行（下一个 constraint 信号经
  auto-refresh 触发）会把 ~2788 knowledge 事件误判 invalid → coverageRatio 跌破
  `compiledViewInjection.minCoverageRatio=1` → 注入门 `coverage_below_threshold` →
  **constraint compiled-view 注入静默回退 legacy**。本片的 event-scan 修复同时消除该隐患。

## R2 收敛（4/4 一致：NS-2 + FIX-1）

### Q-NS → **NS-2**（同 `l1/events/sha256/` + 独立 envelope schema + event-scan 清洁跳过外域）
- 固化事件用独立 envelope schema `constraint-projection-envelope/v1`（body schema
  `constraint-projection-event/v1`），**不**加入 `ConstraintEvidenceEventType` union（deepseek 撤回
  其 R1 同 union 方案），**不**复用 evidence envelope。
- 修 `event-scan.ts`：在 full-parse **之前** peek envelope `schema`；
  **已知外域 allowlist**（`knowledge-evidence-envelope/v1`、`constraint-projection-envelope/v1`）
  → 清洁跳过（不入 invalidEventIds、不发 diagnostic）；`constraint-evidence-envelope/v1` → 照旧
  full-parse；**其它未知/损坏 schema → 仍 invalid（surface，不静默吞）**（opus binding addendum：
  用 allowlist，非 blanket-skip，避免吞掉 schema 被损坏的真 constraint 事件 = 静默数据丢失）。
- 判别字段 = `input.schema`（envelope 级，read.ts:61），早于 body 级 event_schema_version/EVENT_TYPES。
- NS-1（独立 `l1/projections/` 目录）被否：共享目录冲突已存在，物理分目录不修 knowledge-pollution
  且白买两套目录维护；NS-2 一处修复同时解决固化-feedback-loop + knowledge-pollution + live 隐患。

### Q-FIX → **FIX-1**（固化 validated decision；reconcile = render(decision) 字节比对）
- 固化 **validated decision**（render.ts 实际消费的对象）+ provenance（复用
  `ConstraintEvidenceLlmExtraction`：model/prompt_hash/input_hash/output_hash/parsed_output_hash/
  acceptance）+ `template_version` + `input_event_ids`（sorted）。
- reconcile = `render(固化.validated_decision)` 与工作区 L2 字节比对；**不重放 LLM、不重放 validate**
  （最小确定性面 = 只依赖 render.ts 纯性）。gpt-5.5 撤回 FIX-2（重放 parse→validate→render）：
  validate-decision.ts 虽确权纯，但重放扩大确定性依赖面，版本漂移会误报 drift。
- LLM→accepted 取证链由固化 body 内 provenance hashes + `replay_provenance.audit_jsonl_sha256`
  离线保留，不在 reconcile 热路径。

## v3 实施规格（4/4 SIGN，下一片据此执行）

1. **新类型**（`constraint-evidence/types.ts` 或新 `constraint-projection/types.ts`）：
   `CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION="constraint-projection-envelope/v1"`、
   `CONSTRAINT_PROJECTION_EVENT_SCHEMA_VERSION="constraint-projection-event/v1"`、
   `ConstraintProjectionEventBodyV1`（event_type `constraint_compiled_view_produced`、
   validated_decision、provenance、template_version、input_event_ids/causal_parents）、
   `ConstraintProjectionEnvelopeV1`（event_id=body_hash=sha256(JCS(body))）。
2. **固化 writer**（新 `constraint-projection/write.ts` 或并入）：append-before-render；写
   `l1/events/sha256/...`（复用 hash-envelope/canonical-json/原子写 + l1-only path guard）。
3. **event-scan 外域清洁跳过**（`event-scan.ts`，allowlist，opus addendum；导入
   `CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION`）。**不**改共享 `validateConstraintEvidenceEnvelope`
   （append/audit 仍靠它拒外域）。**本修复必须在本片内**（NS-2 前置 + 修 live 隐患）。
4. **settings 新命名空间**（opus addendum：`settings.constraintCompiler` 当前不存在）：
   `constraintCompiler.l2OutputRoot: "state"|"repo"`（默认 `state`），type+default+resolver+schema，
   镜像 `knowledgeProjector.l2OutputRoot`。**flag 同时 gate 固化 append 与 l2 写**（默认 state = 现状
   零变化；§8 真回滚）。
5. **render L2 变体**：`shadow_only:false` + frontmatter 加 `sediment_projection_event_id`
   （指向固化事件，reconcile 据此回映）；修 `render.ts` localeCompare（行 50/61/73）→ 严格码点
   `(a<b?-1:a>b?1:0)`（§4.3）。
6. **窄 l2 guard**：保留 shadow-runner `artifactViolation()` 原样守 debug bundle（input.normalized/
   prompt.txt/decision.json/diff.*/audit.jsonl 仍 `.state`）；**仅 compiled-view.md** 经独立窄 guard
   镜像到 `l2/views/constraint/latest/`。
7. **dual-write 非 move**：`.state` bundle 继续写（注入源 rule-injector/index.ts:505-521 不变）；额外
   固化 L1 + 写 l2/。**本片不翻注入读源**。
8. **reconcile + pre-push**（smoke-adr0039-reconcile.mjs / pre-push-adr0039-reconcile.mjs）：加
   constraint-L2 分支（读固化事件 → render → 字节比对 → projection_byte_mismatch）；把
   `l2/views/constraint/` 纳入 dirty-derived；**落地顺序**：先 land event-scan skip → 重跑编译器 →
   重生成 coverage（消 stale invalidEvents:0）→ 再固化/字节比对（opus：避免把 stale 锁进比对）。
9. **smoke**：(a) mixed-dir（constraint-evidence + knowledge-evidence + constraint-projection +
   损坏 json）→ 断言 constraint 编译器只见 constraint-evidence、invalidEvents 不含外域、损坏 json 仍
   surface；(b) round-trip 字节恒等（固化 validated_decision 含 validationHash → JSON 序列化→解析→
   render 字节一致；含 Project scope + exclusions + unresolved + 非零 priorityHint 覆盖全部 sort 点；
   断言无 undefined 字段在序列化前丢失）；(c) repo-mode 产出 git-tracked l2/views/constraint。
10. **gitignore**：`l2/views/constraint/` 在 abrain home git-tracked（仅 `.state/` ignored；无需改
    pi-astack/.gitignore）。

## 三条硬边界（任一违反停批）

1. 注入读源本片不翻（仍 `.state`）；read-flip 是后续 multi-T0 + 用户重启 gated 步。
2. 外域跳过用 allowlist 非 blanket-skip：未知/损坏 schema 仍 surface（不静默丢 = §4 显式信号不静默丢失）。
3. reconcile 在真实 `~/.abrain`（含 2788 knowledge）上跑出 invalidEvents:0 且 L2 字节比对通过，方算闭环。

## 边界

write+render 路径；不动 P4-b/Knowledge/`rules/**`。每片 flag-guarded + 真实数据 + 内外层提交推送。
