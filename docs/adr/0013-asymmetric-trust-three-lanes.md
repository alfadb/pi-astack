---
doc_type: adr
status: accepted
---

# ADR 0013 — Asymmetric Trust 三段式（LLM / explicit / promotion）

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **8 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md) §1（信任×影响半径）。原机制 prose 见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（Lane B 已 superseded by ADR 0014；Lane C 由 ADR 0016 curator 重写）。

## 方向（canonical → `direction.md` §1）

- Sediment 写入按 **trust × blast-radius** 拆为不对称 lane（Lane A 用户手输 / Lane B promote / Lane C LLM auto-write / Lane D auto-promote 永久禁用），gate 强度启发式 `(1−trust)×blast-radius`；不同 lane 失败模式不同，不平摊统一 gate。
- Lane A（用户手输 MEMORY:）不因 Lane C 的 LLM 失败教训收紧；安全/存储边界在所有 lane 由代码强制（sanitizer/schema/lint/path/lock/atomic/audit）。

## 机制（已分解入 abrain，逐条 slug）

`sediment-asymmetric-trust-three-lanes` · `lane-a-explicit-trust-immunity` · `lane-d-auto-promote-permanent-forbidden` · `lane-c-burn-in-7-of-12-retention` · `sediment-audit-lane-traceability` · `override-escape-hatch-audit-justification` · `safety-boundary-code-enforced-all-lanes` · `per-lane-specific-failure-modes-separate-gates`
