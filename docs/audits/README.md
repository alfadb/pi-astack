# Audit snapshots

本目录保存历史审计快照。审计文档里的 smoke 列表、路径、命令名可能反映当时状态，不是 live truth。

当前 live references：

- 状态：[../current-state.md](../current-state.md)
- 路径：[../directory-layout.md](../directory-layout.md)
- smoke：[../reference/smoke-tests.md](../reference/smoke-tests.md)
- scripts：`package.json#scripts`

## Snapshots

- [2026-05-21-adr-0024-multi-llm-r1-r6.md](./2026-05-21-adr-0024-multi-llm-r1-r6.md) — six-round multi-LLM review of ADR 0024 R5 (Opus 4-7 / GPT-5.5 / DeepSeek V4 Pro); calibrates two reviewer biases (leading-prompt ~24.5pp, RLHF mechanical-guard ~15pp); user's R6 meta-reframe surfaces that R1-R5 derisk paths all fell into mechanical-guard anti-pattern conflicting with pi-astack maxim `prefer-prompt-engineering-over-mechanical-guards`; final calibrated feasibility ~55-60% under AI-native framing; AI-native rewrite of 11 derisk paths + author action plan + proposed 6th self-check layer for future multi-LLM review pipelines
- [2026-05-15-doc-vs-code.md](./2026-05-15-doc-vs-code.md) — multi-LLM doc-vs-code audit + same-day fixes (memory store priority, world walker exclusions, roadmap line-number policy, vault deprecation wording, ADR 0019 inv6 assert)
- [2026-05-14-rounds-1-5.md](./2026-05-14-rounds-1-5.md)
