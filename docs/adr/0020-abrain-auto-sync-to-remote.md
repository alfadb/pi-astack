---
doc_type: adr
status: accepted
---

# ADR 0020 — Abrain auto-sync to remote (sediment-driven push + startup ff-pull)

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **12 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md)（`INV-SYNC-DETERMINISTIC-MERGE`）。原机制 prose（含 Alt A-F / why-not-LLM-merge / 4 轮审计）见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（2026-05-17 修订：divergence 走 git 3-way auto-merge）。

## 方向（canonical → `direction.md#INV-SYNC-DETERMINISTIC-MERGE`）

- 跨设备 sync **只用确定性 git**（ff + 3-way auto-merge on disjoint files）；**LLM merge 永拒**（一句幻觉污染知识基底）；真冲突 `merge --abort` + runbook 交人，绝不静默/幻觉解决。
- push fire-and-forget（不阻塞 sediment）；所有 git op 返回 typed event 不抛；无 remote 时全 silent no-op（守 INV-INVISIBILITY）。
- credential 不进 argv + 输出侧 redact；并发经 tail-chained promise queue 串行（防 index.lock）；git subprocess 用 LANG=C 保证 stderr 分类可靠。

## 机制（已分解入 abrain，逐条 slug）

`fire-and-forget-push` · `deterministic-merge-only` · `no-throw-git-ops` · `no-secrets-in-argv` · `single-flight-promise-queue` · `skipped-is-silent` · `output-credential-redaction` · `runbook-shell-quoting` · `auto-merge-disjoint-divergence` · `llm-merge-rejected-knowledge-substrate` · `rebase-rejected-sha-integrity` · `git-env-lang-c`
