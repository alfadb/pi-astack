# ADR0039 Constraint P5 corpus-split shadow 多 T0 一致共识 + 实施规格（2026-06-20）

> `second-brain-memory-multi-t0-consensus-refactoring-protocol` 要求的 memory-domain
> 架构分片执行前共识。参与 T0（4 厂跨架构）：anthropic/claude-opus-4-8、openai/gpt-5.5、
> deepseek/deepseek-v4-pro、moonshotai/kimi-k2.7-code。主会话只主持，不投决定票。
> **结论：4 轮收敛，最终 4/4 SIGN v4。** 本片仅记录共识 + 规格，shadow 生成在下一片。

## 收敛过程（每轮一个真实纠正）

- **R1**：核码发现 P5 的分流**早已存在**——constraint shadow **diff report**（`ConstraintDiffReport`，
  diff.json/diff.md，每次编译产出）已把每条 active rule 映射到 per-rule `category`，且 category 已
  覆盖 4 strata：`kept`/`compact`/`merge`（compiled）、`rescope_global_to_project`（project）、
  `exclude_not_memory_settings`/`tool_contract`（settings-tool）、`split_knowledge_candidate`
  （knowledge），外加 conflict/archived，并有覆盖不变量 `missing_mapping`/`unmappedSources`。
  roadmap 也字面定义 P5 为「经 shadow diff 分流」。4/4：P5 = **additive-thin，不重建 classifier**。
- **R2**：4/4 SIGN additive-thin、report/shadow-only、纯 re-projection、actions 分流为后续 gated shard。
  发现 diff.ts:102 soft-gate 偏软（只数 reason==='no mapping'）；diff row 缺 scope 判别。
- **R3**：opus 揭关键事实——`validate-decision.ts:240-245` 对 active source 用
  非{settings/tool/knowledge} exclusion reason **直接 throw**；故 active-malformed 永不到达 diff，
  `diff.ts:26` 不可达。deepseek 的「改 validator 放行 active-malformed + 加 exclude_malformed」
  （Lane B）= **改 decision 契约**，违反 R2 锁定的 additive-thin。
- **R4**：4/4 SIGN **v4（Lane A，纯 re-projection，零契约改动）**。deepseek 撤回 Lane B
  （承认其违反自己 R2 签署的 additive-thin）。kimi 的「active-contradiction 必须 fail」由
  validator 上游 throw 已满足，view 层不再加第二道 gate（避免双真相源）。

## v4 最终规格（4/4 SIGN，下一片据此生成 shadow）

**P5 = 纯 re-projection over 现有 diff，零 decision/diff/validator 契约改动。**

实施（additive-thin）：
1. `ConstraintDiffRow` 加 `scope: ConstraintScope` + `sourceStatus`（纯 source 字段拷贝，供
   per-row 查询；让 view 只读 row、不回查 decision/sources）。
2. 新 `corpus-split.{md,json}`：把现有 diff rows 按 **derived stratum** 分组——`stratum = f(category)`
   是对现有 `ConstraintDiffCategory` 的 **many-to-one fold**（NOT 重命名 enum；ConstraintDiffCategory
   仍是单一真相源）：compiled（kept/compact/merge/rescope）、settings_not_memory、tool_contract_not_memory、
   knowledge_candidate（split_knowledge_candidate）、conflict（mark_conflict/keep_unresolved）、
   archived（legacy_archived_observed）、needs_attention（missing_mapping，post-validation = diagnostic-only）。
3. **view 层** `Σ(strata) === totalSources === rows.length` 断言，**fail-closed 仅在 view**，
   绝不 throw 进 compiler。这是冗余 defense-in-depth：validator（validate-decision.ts:288-296）已
   保证每条 source 有 primary disposition 或 throw，覆盖率上游已保证。
4. `stratum()` 用 TS `never`-default 的 **编译期穷尽 switch**（无 silent default bucket）：将来加
   category 必须显式映射或**编译失败**，而不是悄悄消失。
5. `needs_attention`（diagnostic-only）= **surfaced-non-failing**（validator 接受 diagnostic 为合法
   disposition，P5 fail 它=越权改契约）；但必须 (a) 在 PROPOSAL banner header 显示 `needs_attention: N`，
   (b) canonical green corpus fixture 断言 `needs_attention === 0`（drift 即测试红），(c) 负向 fixture
   证明 Σ 断言 fail-closed。
6. 输出 `.state/sediment/constraint-shadow/latest/corpus-split.{md,json}`，`shadow_only:true`，**NOT l2/**
   （corpus-split 是 shadow **分析报告**，与 diff.json 同类；l2/ 只放 canonical compiled-view.md。
   deepseek R4 曾提 l2/，但它 SIGN 的 v4 明确 .state；3 家显式 .state，故 .state 定案）。
   route-elsewhere strata 标 'PROPOSAL — not applied'。
7. §12 grep-guard smoke：corpus-split 模块源码无 tool-name / project-id / title-keyword 字面量
   （stratum 必须纯按 category enum，不得回到机械 blacklist）。
8. 确定性 smoke：同 (sources,decision) → 两次 byte-equal md+json，且 inputRootHash+decisionHash
   确定性导出 shadowOutputHash（hash-of-hash）。
9. split_knowledge_candidate **reachability fixture**（今 0 live rows = 测试缺口非 classifier bug）：
   合成一条 knowledge_candidate exclusion → 断言 row.category=split_knowledge_candidate + Σ 成立。
10. read-only 契约：corpus-split 模块只 import `./types` + `ConstraintDiffReport`，禁 import
    legacy-scan / validate-decision / invoker / node:fs（除单一 sanctioned writer helper）。

## Alternative-design poll（显式，4/4）

R1 各家列了 A–E：重建 classifier（B）、直接 materialize settings 补丁（C）、P5 内迁移 knowledge（D）、
跳过 P5（E）全部被否。一致收敛到 **A = additive-thin 纯 re-projection**。无更优替代。

## 明确 OUT-OF-P5（各自独立 shard / 后续，非本片）

- diff.ts:102 missing_mapping soft-gate 硬化（diff-internal 修，改 validationStatus 语义）。
- `exclude_malformed` category / 任何 ConstraintDiffCategory 扩展。
- validate-decision.ts 对 active-malformed 放行（Lane B，decision 契约松绑，需独立 4×T0）。
- 真正的 actions：knowledge 迁移（cross-domain/P6）、settings/tool 变更落地（§5.4 config/tool-decl 流程）、
  rescope apply、archive flips —— 各是后续 gated shard。

## 边界

纯 re-projection；零契约改动；shadow-only `.state`；不动 Knowledge/`rules`/validator/diff 分类。
shadow 生成（实现 corpus-split view + fixtures）在下一片，flag 无关（纯报告）+ 内外层提交推送。
