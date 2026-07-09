---
doc_type: adr
status: accepted
---

# ADR 0016 — Sediment 从 gate-heavy extractor 转向 LLM curator

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **8 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`requirements.md`](../requirements.md)（`REQ-003`）+ [`direction.md`](../direction.md) §2 AI-Native。原机制 prose 见 `docs/notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（2026-05-15 sanitizer 改 typed-redaction+continue）。

## 方向（canonical → `requirements.md#REQ-003` / `direction.md` §2）

- Sediment = **LLM curator + 最小硬 gate**，不是机械 extractor：语义判断（写不写/kind/status/confidence/是否 maxim）全归 LLM；Phase 1.4 机械 gate 全部永久删除。
- 仅保留两类硬 gate：(1) 确定性 secret sanitizer（typed redaction）、(2) 存储完整性（path/schema/lint/lock/atomic/audit/git）。
- 知识库自演进（update/merge/supersede/archive，非 append-only）；create 前必 memory_search 找邻居；`memory_update/delete` 不暴露给主会话。

## 机制（已分解入 abrain，逐条 slug）

`sediment-role-llm-curator` · `curator-op-priority-order` · `curator-memory-search-before-create` · `secret-sanitizer-typed-redaction-continue` · `hard-safety-gates-two-categories` · `knowledge-base-self-evolving` · `main-session-memory-write-tools-banned` · `soft-delete-default-hard-delete-exceptions`
