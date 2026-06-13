---
doc_type: adr
status: accepted
---

# ADR 0003 — 主会话只读，sediment 单写

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **9 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md)（`INV-MAIN-SESSION-READ-ONLY`）/ [`requirements.md`](../requirements.md)（`REQ-005`）。原机制 prose 见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（旧 gbrain CLI / postgres role / bash regex guard 实现已过时，只作历史参考；核心原则不变）。

## 方向（canonical → `direction.md#INV-MAIN-SESSION-READ-ONLY` / `requirements.md#REQ-005`）

- 主会话 LLM **只读** memory，所有 durable 写经 **sediment 单写**（agent_end 异步 vote/dedupe/refine + 单 provenance 审计）。
- 两层防线：**层 1 mechanic** = LLM tool surface 无 brain mutation tool（写能力架构性缺席）；**层 2 best-effort** = 经通用工具（bash/edit/write/dispatch）间接触达是显式接受的有界 residual，靠 stdout 不返回 / 输出脱敏 / sediment 事后审计补偿，**不当作层 1 缺口去机械封堵**。
- `prompt_user` 答案是 user-attested 信号（Lane-A 等价），但不软化层 1；sub-agent 不得 capability escalation 绕过只读。

## 机制（已分解入 abrain，逐条 slug）

`main-session-write-prohibition-four-failure-modes` · `two-layer-read-only-enforcement` · `prompt-user-answers-user-attested-not-llm-inferred` · `sediment-triggers-on-agent-end-autonomous` · `intent-tools-for-write-signaling-anti-pattern` · `sediment-async-main-session-must-not-promise-persistence` · `brain-db-credential-split-read-write-roles` · `brain-cache-paths-blocked-from-main-session-writes` · `dispatch-agents-cannot-escalate-to-brain-writes`
