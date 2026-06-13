---
doc_type: adr
status: archived
---

# ADR 0010 — sediment 单 agent + lookup tools 写入策略（v6.6，v6.8 仍用）

> 🗄️ **机制已 ingest 入 abrain（pi-global）@627de33，本 ADR 归档**：机制 rationale 已由 ADR 0034 ingest lane 分解为 **12 条 typed entry** 存入第二大脑（含「3-model 投票失败的 5 根因」高价值经验）。逐条 rationale 经 `renderRationale` 可得。被 ADR 0016 取代为现役 curator 架构。原机制 prose（202 行）见 git `@627de33`。

## 方向沉淀（已入 abrain，逐条 slug）

`shared-vote-prompt-breaks-model-independence` · `forced-json-breaks-llm-output-robustness` · `skip-verdicts-dominate-sediment-cost` · `no-checkpoint-unbounded-context-reload` · `blind-quorum-dedup-writes-duplicates` · `single-agent-lookup-beats-multi-voter-sediment` · `markdown-terminators-not-json-for-llm-output` · `deepseek-v4-pro-faster-cheaper-sediment-eval` · `sediment-checkpoint-only-on-terminal-success` · `sediment-config-three-tier-fallback` · `no-schema-enforcer-removes-second-injection-surface` · `hybrid-voter-scheme-rejected`
