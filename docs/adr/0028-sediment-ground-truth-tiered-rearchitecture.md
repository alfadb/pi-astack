---
doc_type: adr
status: accepted
---

# ADR 0028 — Sediment Ground-Truth-Tiered Rearchitecture

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **10 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md)（`INV-GROUND-TRUTH-TIERED`）+ [`requirements.md`](../requirements.md)（`REQ-004`）。原机制 prose（含 §2 根因 bug-chain / §10 debate / §12 统一分层模型）见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（v1.1，三家 T0 全票签署的共识不变式）。

## 方向（canonical → `direction.md#INV-GROUND-TRUTH-TIERED` / `requirements.md#REQ-004`）

- **根因**：把"用户显式指令"与"LLM 推断假设"当同一信号类是 silent-loss 的根。两者分流：classifier 管 directive→Tier-1，extractor 管 inferred→Tier-2，权限不相交。
- **Tier-1 = provenance-gated 确定性提交**：仅当 verbatim quote 结构性源自 USER-role + is_directive + durable；router/curator 输出空间排除 skip/stage；源门挡 transcript-content 注入（README 里的 "always use Yarn" 不是 Tier-1）。
- Outcome edge 闭合写-only 环（矛盾降权、自回声先减）；Jaccard 仅 dedup prefilter 非自动 merge；staging 不是 Tier-1 路径；分层收敛为 AX-SCOPE/AX-PROVENANCE/AX-MATURITY + f-CATEGORY，GTier 是写时谓词非存储层。

## 机制（已分解入 abrain，逐条 slug）

`explicit-directives-and-inferred-hypotheses-are-different-signal-classes` · `classifier-and-extractor-have-disjoint-authority` · `tier1-is-provenance-gated-deterministic-commit` · `tier1-source-gate-blocks-transcript-content-injection` · `tier1-requires-tell-surface-and-transcript-keyed-recall-audit` · `outcome-edge-closes-the-write-only-memory-loop` · `jaccard-is-only-a-dedup-prefilter` · `staging-is-not-a-tier1-path` · `second-brain-layering-is-three-storage-axes-plus-category-facet` · `gtier-is-a-write-time-predicate-not-stored-layer`
