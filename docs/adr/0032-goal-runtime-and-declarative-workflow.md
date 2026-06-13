---
doc_type: adr
status: accepted
---

# ADR 0032 — Goal 续行运行时 + 声明式 Workflow 编排（实验通道）

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **10 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md)（`INV-TELL-NOT-ASK` / `INV-COST-NOT-A-GATE` / `INV-AUTONOMY`，部分被 0033 修订）。原机制 prose 见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（实验通道：workflow.enabled 默认 off / readOnly 默认 true）。

## 方向（canonical → `direction.md`）

- **Goal 续行**：event-sourced on branch（json 仅注入缓存）；active goal 每轮注入 sanitized tail；auto-continue 先扣预算（event-first）再发续行；judge 输出闭集（achieved/blocked/continue），无结构权（不能改拓扑）。
- **provenance 隔离**：机器组装的 user-role 续行带 `[pi-goal-continuation]` 前缀 → sediment 判 assistant、directive recall 跳过（防 assistant 文本洗白进 Tier-1）。
- **Workflow v1**：声明式 JSON DAG（非 YAML/非代码）；静态拓扑 + 无 spawn 工具才避开 H5 hub gate；失败路由确定性（非 LLM 选）；mutating 需三重显式门；trace 不自动沉淀成规则（自污染围栏）。

## 机制（已分解入 abrain，逐条 slug）

`goal-event-source-branch-truth` · `goal-injection-is-active-only-sanitized-tail` · `goal-budget-predecrement-event-first` · `goal-judge-has-no-structural-authority` · `machine-user-role-needs-provenance-isolation` · `workflow-v1-mutating-requires-triple-explicitness` · `workflow-h5-boundary-static-dag-no-spawn` · `workflow-dsl-is-structured-json-not-program-code` · `workflow-failure-routing-is-deterministic` · `workflow-traces-are-not-self-learning-rules`
