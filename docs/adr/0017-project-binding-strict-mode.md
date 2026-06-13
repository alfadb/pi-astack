---
doc_type: adr
status: accepted
---

# ADR 0017 — Project Binding Strict Mode（项目身份绑定严格模式）

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **9 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`requirements.md`](../requirements.md)（`REQ-007`）。原机制 prose 见 `notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted。

## 方向（canonical → `requirements.md#REQ-007`）

- 项目身份**只认 project_id**（路径/git remote 不作身份信号）；bound 需三层同时满足：`.abrain-project.json`（可携身份声明）+ abrain 侧 `_project.json`（存在证明）+ machine-local `local-map.json`（本机路径授权，不入 git）。
- 任何 non-bound 态 fail-closed 拒绝项目级写（migrate/sediment/project vault）；只读 + global vault 始终允许。manifest 是声明、local-map 是授权——伪造 manifest 拿不到 vault/sediment。
- migration 不决定身份（不收 `--project=`，先 bind 再 migrate）。

## 机制（已分解入 abrain，逐条 slug）

`project-id-is-sole-identity` · `three-layer-binding-contract` · `migration-must-not-determine-identity` · `active-project-state-machine-fail-closed` · `local-map-machine-auth-not-git-tracked` · `sediment-write-guard-audit-row` · `vault-scope-requires-bound-manifest-not-auth` · `bind-idempotent-cross-project-path-rejected` · `no-local-only-mode-manifest-always-written`
