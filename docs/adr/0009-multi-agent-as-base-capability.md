---
doc_type: adr
status: accepted
---

# ADR 0009 — multi-agent 作为基础能力，调用模式作为模板参考

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **14 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md)。原机制 prose 见 `docs/notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（revised 2026-05-11，alfadb）。旧 `dispatch_agents` / `multi_dispatch` / `extensions/multi-agent/` / templates cookbook 细节只作历史设计动机。

## 方向（canonical → `direction.md`）

- **dispatch 是基座能力，暴露 primitive（dispatch_agent / dispatch_parallel）而非固定策略工厂**；parallel/debate/chain/ensemble 是 cookbook pattern（进 prompt/skill），不是 API enum——反约束 LLM 自行编排。
- 输入兼容在 argument-prep 层（strict schema 不退化为 Any），最多双层 unwrap，逐字段 opt-in，错误带修复上下文。
- 子代理工具安全：默认只读、mutating 需 env gate、嵌套 dispatch 永拒、vision/imagine 需显式 list；并发是真 IO 并发（非进程隔离），跨 provider 散开降 rate-limit 耦合。

## 机制（已分解入 abrain，逐条 slug）

`dispatch-primitives-over-fixed-strategies` · `strategy-patterns-are-cookbook-guidance` · `dispatch-compat-lives-in-argument-prep` · `strict-schema-not-type-any` · `dispatch-compat-only-for-known-fields` · `stringified-input-unwrap-depth-two` · `compat-errors-need-repair-context` · `nested-dispatch-is-never-delegated` · `mutating-subagent-tools-require-env-gate` · `vision-imagine-are-separate-delegable-capabilities` · `dispatch-parallelism-is-network-concurrency` · `dispatch-concurrency-has-shared-runtime-limits` · `cross-provider-parallelism-reduces-rate-limit-coupling` · `concurrency-regression-test-uses-start-skew`
