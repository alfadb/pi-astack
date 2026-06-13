---
doc_type: adr
status: accepted
---

# ADR 0022 — `prompt_user` LLM-facing 同步问答工具（与 `vault_release` 共享 PromptDialog substrate，独立语义）

> 🗄️ **机制已 ingest 入 abrain（pi-global）@627de33**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **21 条 typed entry** 存入第二大脑（含 INV-A..N code-enforced 活契约的设计理据），逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`requirements.md`](../requirements.md)（`REQ-008`）。原机制 prose（1079 行，含 §10 R1-R4 设计轨 / §D6 redaction 边界 / §5 INV 活契约表）见 git `@627de33`。

- **状态**：Accepted（R7.2）。INV-A..N 由代码强制执行——契约语义在 smoke + 实现中持续守护，本残桩仅去机制 prose。

## 方向（canonical → `requirements.md#REQ-008`）

- “等用户决策”= yield point，须有专用 tool substrate（pending/cancel/timeout/redaction/结构化 UI），不走 transcript 文本。
- `prompt_user`（决策暂停）与 `vault_release`（凭证释放）**独立 LLM-facing 工具、独立 audit lane**，共享 PromptDialog UI；工具名本身承载 prompt 纪律语义。
- `type:secret` 只回 `[REDACTED_SECRET:<id>]` placeholder（raw 永不进 LLM/audit，仅 lengthBucket）；secret 在每个写端 redact（two-site 独立防御）；sub-pi 三层 guard 继承；并发硬门 1；inline 编辑区为主 UI；1-4 问 / timeout [30,1800]。

## 机制（已分解入 abrain，逐条 slug）

`prompt-user-current-pain-sediment-corruption` · `question-as-yield-point-requires-tool-substrate` · `prompt-user-vault-release-separate-tools` · `secret-type-placeholder-only-no-llm-ingestion` · `other-option-forced-server-normalized` · `max-four-questions-per-prompt-user-call` · `prompt-user-schema-answers-always-array-no-throw` · `r72-schema-simplification-remove-length-limits` · `vault-release-independent-tool-shared-ui-substrate` · `separate-audit-lanes-prompt-user-vs-vault` · `three-layer-sub-pi-guard-inherited` · `prompt-cancellation-four-trigger-sources` · `timeout-clamp-30-1800-no-infinite` · `secret-redaction-multi-write-end-boundary` · `redact-credentials-primitive-elevated-to-shared` · `inline-editor-replacement-primary-ui-path` · `prompt-first-abuse-governance-concurrent-hard-gate` · `compaction-tuner-defers-on-pending-overlays` · `internal-ask-prompt-user-service-separate-from-tool` · `secret-p0-scope-no-callback-api-no-vault-bypass` · `vault-release-ui-migration-fallback-retention`
