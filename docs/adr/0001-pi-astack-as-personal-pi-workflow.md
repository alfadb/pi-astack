---
doc_type: adr
status: accepted
---

# ADR 0001 — pi-astack 作为 alfadb 为 pi 打造的个人工作流仓

> 🗄️ **机制已 ingest 入 abrain（pi-global）**：本 ADR 的机制 rationale 已由 ADR 0034 ingest lane 分解为 **12 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。方向契约见 [`direction.md`](../direction.md) / [`requirements.md`](../requirements.md)。原机制 prose 见 `docs/notes/adr0034-impl-plan.md` 记录的 prose 基线。

- **状态**：Accepted（2026-05-05，alfadb）。记忆基础设施部分已过时（gbrain → markdown+git，见 [`memory-architecture.md`](../memory-architecture.md)）；项目定位 / vendor+端口层 / 使用即开发 / 硬纪律均不变。

## 方向（canonical → `direction.md`）

- pi-astack 是单作者、单 harness（pi）的个人工作流 monorepo（仿 gstack↔claude-code），不为外部分发优化。
- **vendor+端口层**：`vendor/` 只读上游（移植参考 + 升级 diff 源），`extensions/skills/prompts` 是 owned 端口层；端口层永不 import vendor。
- 治理纪律：vendor 严格只读、单向依赖、UPSTREAM.md 实时维护、vendor bump 独立 commit、rule-of-three 棘轮（容忍重复一次再系统化）、pi-astack 不建 `.pensieve/`（写经 sediment）。

## 机制（已分解入 abrain，逐条 slug）

`pi-astack-is-personal-workflow-repo` · `vendor-plus-owned-port-layer` · `use-as-you-develop-submodule-workflow` · `vendor-directory-strictly-read-only` · `unidirectional-dependency-ext-to-skills` · `upstream-md-must-be-real-time` · `vendor-bump-is-independent-commit` · `rule-of-three-defers-shared-extraction` · `ratchet-rule-concretization` · `no-pensieve-dir-in-pi-astack` · `no-mechanical-vendor-bump-scripts` · `yagni-explicit-deferrals`
