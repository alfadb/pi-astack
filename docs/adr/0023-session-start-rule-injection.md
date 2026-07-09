---
doc_type: adr
status: accepted
---

# ADR 0023 — Session-start rule injection：abrain 第 8 区 `rules/` + 双 tier 注入 + sediment 全自动 lifecycle

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **17 条 typed entry** 存入第二大脑（含 INV-R1..R10 活契约理据），逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`requirements.md`](../requirements.md)（`REQ-004`）+ [`direction.md`](../direction.md)（`INV-GROUND-TRUTH-TIERED`）。原机制 prose（825 行，含 §1.4 威胁模型 / §11 演化史 / INV-R1..R10）见 `docs/notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（R5；部分被 ADR 0024/0028 修订；ADR 0039 后 rules 区不再是写时 active source-of-truth 文件集合，而是 Compiled Constraint View 的呈现或兼容投影；自然对话学规则仍成立，但稳定注入读取 compiled view）。

## 方向（canonical → `requirements.md#REQ-004` / `direction.md#INV-GROUND-TRUTH-TIERED`）

- pull-only memory 不够：行为规则须**每会话可见**（push），故 rules 是 abrain 第 8 区（`always` 全文注入 / `listed` catalog 行）。
- **sediment 全自动 lifecycle**（curator 单一 classifier 路由 zone/inject-mode/scope/op，复用 7 操作），无 `/rule add`——规则从自然对话学；任何 lifecycle 变更须 notify（可见不强管）。
- 第二大脑威胁模型（单用户多设备非拜占庭）；project 规则须 strict binding；注入幂等（nonce fence）；rule hint 专用 sanitize；writeAbrainRule 私有单写；sub-pi 经 PI_ABRAIN_DISABLED 隔离。

## 机制（已分解入 abrain，逐条 slug）

`pull-only-memory-needs-push-visible-rules` · `sediment-must-not-write-agents-md` · `rules-zone-is-second-brain-not-adversarial-system` · `rules-are-eighth-abrain-zone` · `always-inject-mode-is-compact-high-confidence-behavior` · `listed-inject-mode-is-a-visible-rule-catalog` · `project-rules-require-strict-project-binding` · `rule-injector-uses-session-start-scan-and-before-agent-start-append` · `rule-injection-fence-uses-nonce-for-idempotence` · `sediment-classifier-routes-zone-inject-mode-and-lifecycle-op` · `rule-source-guidance-distinguishes-user-intent-from-transcript-content` · `rules-classification-belongs-in-curator-stage` · `write-abrain-rule-is-private-single-writer-path` · `rule-hints-need-system-prompt-sanitization` · `rule-management-is-natural-language-not-rule-add` · `rule-lifecycle-mutations-must-not-be-silent` · `sub-pi-processes-must-not-inherit-abrain-rules`
