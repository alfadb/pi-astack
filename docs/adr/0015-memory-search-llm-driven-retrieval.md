---
doc_type: adr
status: archived
---

# ADR 0015 — memory_search 升级为双阶段 LLM-driven retrieval

> 🗄️ **机制已 ingest 入 abrain（pi-global），本 ADR 归档**：双阶段 rerank 机制 rationale 已由 ADR 0034 ingest lane 分解为 **23 条 typed entry** 存入第二大脑。「accuracy-is-contract / 无 grep 降级」方向立场见 [`requirements.md`](../requirements.md)（`REQ-009`）。逐条 rationale 经 `renderRationale` 可得。原机制 prose（224 行）见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

## 方向沉淀（已入 abrain，逐条 slug）

`legacy-search-was-token-tfidf-plus-boosts` · `literal-token-search-fails-mixed-language-memory` · `search-quality-controls-sediment-dedup-quality` · `patching-grep-cannot-solve-semantic-equivalence` · `whole-vault-llm-recall-does-not-scale` · `memory-search-query-is-natural-language-prompt` · `two-stage-search-separates-recall-from-precision` · `stage1-uses-full-body-candidate-surface` · `stage2-runs-whenever-stage1-has-candidates` · `rerank-is-relevance-judgment-not-deep-reasoning` · `default-search-models-are-deepseek-flash-off` · `search-models-must-be-settings-configurable` · `result-cache-breaks-memory-freshness` · `fresh-search-surface-preserves-new-entry-recall` · `search-results-show-freshness-not-full-timeline` · `memory-timestamps-need-local-datetime-precision` · `memory-search-is-sediment-lookup-kernel` · `sediment-dedupe-should-evolve-knowledge-not-only-reject` · `instructions-first-prompts-enable-prefix-kv-cache` · `kv-cache-is-not-result-cache` · `full-body-stage1-prioritizes-recall-over-cache-compactness` · `search-metrics-jsonl-records-call-observability` · `search-metrics-schema-is-experimental`
