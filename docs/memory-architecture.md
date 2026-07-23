---
doc_type: architecture
status: active
---

# Memory Architecture（current summary）

> 本文件曾是 v7 monolith 设计规范。为避免旧 `.pensieve/`/gbrain/grep fallback/phase checklist 与现状混淆，原文已归档到 [archive/memory-architecture-v7-original.md](./archive/memory-architecture-v7-original.md)。
>
> 当前权威拆分如下：
>
> - [architecture/memory.md](./architecture/memory.md) — memory facade、entry schema、LLM retrieval、migration boundary
> - [architecture/sediment.md](./architecture/sediment.md) — writer/curator/audit/lock
> - [architecture/abrain.md](./architecture/abrain.md) — `~/.abrain` 七区、project binding、lanes
> - [architecture/vault.md](./architecture/vault.md) — vault 安全模型
> - [current-state.md](./current-state.md) — 当前实现事实

## 当前结论

1. **L1 Evidence Event 是唯一语义 source of truth**；L2 markdown 是确定性投影视图，L3 SQLite / embedding / sidecar 索引都是可重建派生物。gbrain/postgres/pgvector 不再是 runtime 依赖。
2. **Knowledge 当前生产写入为 `event_first`**：sediment 成功追加 L1 event 后不再稳态写 legacy markdown；`~/.abrain/projects/<id>/`、`~/.abrain/knowledge/` 与 `<project>/.pensieve/` 保留为回滚、调试、迁移输入。
3. **主会话只读**：LLM-facing 工具仅 `memory_search/abrain_get/memory_list/memory_decide`。
4. **sediment 是 dedicated writer**：curator 决定 create/update/merge/archive/supersede/delete/skip；writer 负责事件追加、投影、锁、lint、audit 与 best-effort git。
5. **`memory_search` 使用 stage0 hybrid + stage2 LLM 精排**；LLM 精排失败 hard error，不降级到 grep/BM25。stage0 embedding 不可用只会收窄候选面，仍必须经过 LLM 精排或显式 best-effort 边界。
6. **entry 投影视图格式**：frontmatter v1 + compiled truth + `## Timeline`；用户纠错应转成新的 L1 event 再重投影，L2 不是用户编辑面。
7. **运行健康检查**：`npm run health:memory` 只读汇总真实 L1/L2/L3 数量、水位、embedding index 与 search metrics；严格重建门禁仍使用 `npm run reconcile:adr0039`。

## 不再属于 current spec 的旧内容

- project SOT = `<project>/.pensieve/`
- gbrain world store
- `.gbrain-source`/`.gbrain-cache`/`.gbrain-scratch`
- grep/BM25 或 rank-score fusion 的 graceful fallback
- promotion gates / project→world promote lane
- Phase 1-6 roadmap checklist
- `.pensieve/config.yml` project identity

这些内容保留在 archive/ADR 中用于理解演进，不应作为实现依据。
