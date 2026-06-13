---
doc_type: adr
status: accepted
---

# ADR 0026 — 第二大脑参与任务执行

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **12 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md) / [`requirements.md`](../requirements.md)。原机制 prose（402 行全文）见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（R0 草案 v2，2026-05-22 用户方向校正后重写：从"推送系统"改为"参与系统"——大脑是 LLM 决策时的内置参谋，不是内容推送器）。
- **基准**：[ADR 0024](0024-second-brain-from-natural-conversation.md) 四 invariant + AI-Native。**对偶**：[ADR 0025](0025-sediment-meta-curator-subsystem.md)（写侧"怎么写对"），本 ADR 是用侧"怎么用出来"。

## 方向（canonical → `direction.md`）

- 第二大脑在任务执行时**参与决策**（情境化建议 + 综合判断），而非只返回原始记忆摘要。
- 参与是 **push（路径 A，每轮 search + Stage-2 LLM verdict cutoff）+ pull（路径 B，`memory_decide`）** 双通道；§3.1 "决策点二元检测" 已 walked back（见 `feature-changelog.md` 的 §3.1 walk-back 记录）。
- 守 INV-INVISIBILITY（用户不做管理）/ INV-AUTONOMY（不替用户决定）/ INV-ACTIVE-CORRECTION（提醒不阻止）/ INV-IMPLICIT-GROUND-TRUTH（不吃未确认猜测）。

## 机制（已分解入 abrain，逐条 slug）

`walked-back-binary-decision-detection` · `path-a-silent-skip-pipeline` · `subagent-exempt-from-path-a` · `path-a-inject-id-independent-anchor` · `decision-brief-natural-language-not-json` · `provisional-staging-excluded-from-use-side` · `contradiction-awareness-reminds-not-blocks` · `echo-chamber-5x-decisive-circuit-breaker` · `push-path-a-vs-pull-path-b-duality` · `brief-system-prompt-inject-not-user-render` · `bootstrap-deadlock-p0a-independent-layer` · `anti-pattern-three-rejected-mechanical-approaches`
