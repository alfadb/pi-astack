# ADR0039 Constraint L2 repo-mode preflight — 4×T0 一致共识 + 实施规格（2026-06-20）

> 3 轮 4×T0 跨厂复审，最终 **4/4 SIGN v3**（opus-4-8 / gpt-5.5 / deepseek-v4-pro /
> kimi-k2.7-code；主会话主持不投票）。本片只记录共识 + 规格；**实现在下一片**
> （遵 continuation：document unanimous decision before implementation）。
>
> 触发原因：上一片的 `2026-06-20-adr0039-constraint-l2-repo-mode-runbook.md` 是
> **主会话独写、未经任何 panel 复审**的产物，其 gate-scope 判断（"additive/低风险、
> 无需 soak"）是单一 AI 的结论。按「verification 别自己说了算」+ flip-class 纪律，必须
> 跨厂复审。**本共识 supersede 那份独写 runbook。**

## 收敛过程（每轮一个真实纠正）

- **R1**：4/4 CONFIRM 核心 gate 判断（无行为 soak——注入 `rule-injector/index.ts:505-506`
  无条件读 `.state`；repo block `shadow-runner.ts:351` additive best-effort）。但 4/4
  CHALLENGE 独写 preflight **材料性不完整**，找出独写时漏掉的真洞：
  - **churn**：固化幂等键是 LLM 输出 `decision_hash` 而非 `inputRootHash`（`projection.ts`），
    模型非确定时每次 refresh 产新 immutable L1 事件 + 重写 L2 → git/disk 增长，restart+reconcile
    与行为 soak 都看不见 → 需 preflight double-compile 闸。
  - **stale-L2 reconcile false-negative**（deepseek）：`validateConstraintL2` 只验 L2 vs 其
    **引用的** event，不检测是否存在更新的固化 event（swallow 掉 `l2_write_failed` 后 L2 陈旧）
    → post-flip 字节 reconcile 可**假绿**。
  - **构造性未测**（4/4）：主会话物理上无法执行 flip（settings boot 读、需用户重启）→ 程序
    至今 end-to-end 未验 → 须用「快照真实 ~/.abrain + 回放缓存 decision（无 LLM）」的可执行
    preflight smoke 在用户翻转前证全绿。
  - silent best-effort swallow、可逆性夸大（固化事件进 git 历史，`git rm` 只清工作树）、
    runbook step-1 路径错（settings 无 `l2OutputRoot` 键）。
- **R2**：opus/deepseek/kimi SIGN v2；gpt 窄 REVISE（要显式 bounded-delta 断言，additive 不冲突）。
  bundle 一致：INCLUDE (a) stale-L2 扫描 + (b) `SC_L2_WRITE_FAILED` 诊断；DEFER (c) auto-refresh
  churn-skip + (d) render-before-append 重排。deepseek 给出 stale-L2 精确比较器；kimi 给出最小
  快照集 + write-only-no-commit piggyback 洞察；opus 给出 NS-2 双向耦合精确化。
- **R3**：**4/4 SIGN v3**（gpt 的 delta 断言已折入；所有 refinement 非冲突 superset）。

## R2/R3 间核实的事实（非信 prose，逐条核码）

- `validateConstraintL2` **存在**（`smoke-adr0039-reconcile.mjs:465`，:566 调用）——opus R2「不存在」
  是误报（误 grep extensions/）。bundle-a = 在其上扩展，可达。
- `FOREIGN_SKIP_ENVELOPE_SCHEMAS` **含** `constraint-projection-envelope/v1`（`event-scan.ts:57-59`，
  :192 skip）——opus 双向耦合确认。
- `writer.ts:1058` **blanket-stage** `["l1","l2"]`（`git add -A`）——kimi 的 write-only-no-commit
  piggyback 确认：constraint compiler 自己不 commit，搭下一次 knowledge sediment commit 的车。
- settings `constraintShadowCompiler`（`pi-astack-settings.json:203-216`）**无** `l2OutputRoot` 键
  → 默认 state；:233 的 `repo` 是 `knowledgeProjector` 的。flip = **插入键**，非改值。

## v3 实施规格（4/4 SIGN，下一片据此实现）

**交付 = 可执行 preflight smoke + verify 脚本 + reconcile 硬化 + 诊断 + runbook 修订（非 runbook-only）。**

**A. `scripts/smoke-constraint-l2-repo-preflight.mjs`**（+ `smoke:constraint-l2-repo-preflight`，
registry-drift 映射）。主会话可跑。**最小快照**（kimi）：temp home = 真 `.gitignore` + 真
`.state/sediment/constraint-shadow/latest/{decision.json,input.normalized.json}` + 空 `l1/events`
+ 空 `l2/views/constraint` + `git init`/baseline；**seed** 2 条 `knowledge-evidence-envelope/v1`
+ 1 条 unknown-schema L1 事件（NS-2 realism）。回放缓存 decision 当 compilerInvoker（**无 LLM**）。断言：
- RUN-A repo-mode：`result.ok && l2Projection.status==='written'`；L1 `constraint-projection-envelope/v1`
  envelope 存在；L2 文件存在；**L1 event count +1**。
- ROUND-TRIP：`renderConstraintL2View(envelope.body.validated_decision, eventId) === L2 bytes`。
- RUN-B 幂等：再跑 → `status==='unchanged'`；L2 字节不变；**L1 event count +0**。
- RUN-C：`validateConstraintL2(snapshot)` present:true failures:[]（含新 stale-L2 扫描通过）。
- RUN-D rollback-sim：`l2OutputRoot='state'` → 无 l2Projection；**L2 mtime 稳定 + 无新 projection 事件**。
- NS-2：`scanConstraintEvidenceEvents` → projection envelope 不在 events[] 也不在 invalidEventIds[]。
- **git delta 报告 + 任何脏路径在 `l1/events/sha256/` + `l2/views/constraint/` 外则 FAIL**（gpt）。
- **缓存 decision 过 `validateConstraintCompilerDecision` 则 HARD-FAIL；age>eventStaleAfterMs(86400000) 则 WARN**（deepseek）。

**B. `verify:constraint-l2-flip`**（+ package.json）用户重启后跑：(1) **先强制 canonical commit
sweep**（kimi：`git -C ~/.abrain add l1 l2 && commit`，或触发一次 knowledge 写 drain piggyback）；
(2) porcelain 严格白名单——每脏行须匹配 `^(\?\?| M| A| D)\s+(l2/views/constraint/|l1/events/sha256/)`，
否则 FAIL；(3) 断言最新 run-artifact `l2Projection.status∈{written,unchanged}`（gpt）；
(4) `smoke:adr0039-reconcile`。单 exit code。

**C. bundle-a：`validateConstraintL2` stale-L2 扫描**（`smoke-adr0039-reconcile.mjs:465`）：在既有
L2↔引用-event 字节校验后，扫所有 `constraint-projection-envelope/v1` 事件，按 **`created_at_utc`
降序、tiebreak `event_id` 降序**排序（deepseek 比较器；单写者 device 时钟自洽；event_id 内容哈希
保证 tie 确定性），若 L2 引用的 event ≠ 最新则 flag `stale_l2_newer_projection_exists`。

**D. bundle-b：`SC_L2_WRITE_FAILED` 诊断**——当 `l2Projection.status∉{written,unchanged}` 时
surface 进 diagnostics[]（让 silent best-effort swallow 可观测）。

**E. Runbook 修订**：step-1 **插入** `"l2OutputRoot":"repo"` 到 constraintShadowCompiler 块
（当前**缺键**→默认 state）含具体 diff；可逆性改 **'behaviorally inert, NOT history-erasable'**
（固化事件进 ~/.abrain git 历史，`git rm` 只清工作树）；NS-2 **双向耦合**注记（projection schema
须**同时**留在 constraint-evidence ingest 之外**且**留在 `FOREIGN_SKIP_ENVELOPE_SCHEMAS` 白名单内
——从 skip 集移除会 fall-through 全解析→invalid→`coverageRatio` 塌缩→注入在 minCoverageRatio 静默
关闭）；硬 git-clean 前置；post-flip **force-commit-sweep step 2.5**；眼看 git status 换成 verify 脚本。

## DEFER（各独立 shard，本片不做）

- (c) auto-refresh `inputRootHash` churn-skip：更大的 auto-refresh 改动；double-compile preflight
  已**检测** churn；deepseek 证 constraint 事件占 L1 极小比（knowledge 主导）。
- (d) `projection.ts` render-before-append 重排：bundle-a 的 stale-L2 扫描已捕获 append-before-render
  的不一致（deepseek 失效模式表），故安全 DEFER。

## Alternative poll（显式，4/4）

替代 gate 方案均评估：full-rsync 快照（否，重；改最小切片）、staged/影子 N 轮（否，无行为面可 soak）、
runbook-only（否，主会话无法执行→纸面断言）、多周行为 soak（否，注入不变无可 soak）。一致收敛
**最小快照 + 回放 + 可执行 preflight smoke**——无更优。
