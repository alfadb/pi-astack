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

1. **markdown+git 是唯一记忆 source of truth**；gbrain/postgres/pgvector 不再是 runtime 依赖。
2. **项目记忆写入 `~/.abrain/projects/<id>/`**；legacy `<project>/.pensieve/` 只读，用于迁移和未迁仓兼容。
3. **主会话只读**：LLM-facing 工具仅 `memory_search/get/list/neighbors`。
4. **sediment 单写**：create/update/merge/archive/supersede/delete/skip 由 sidecar writer 落盘。
5. **`memory_search` 使用 ADR 0015 LLM-driven retrieval**；失败 hard error，不降级到 grep/BM25。
6. **entry 格式**：frontmatter v1 + compiled truth + `## Timeline`。
7. **graph/index 是派生物**，可以通过 `/memory rebuild --graph` / `/memory rebuild --index` 重建。

## 不再属于 current spec 的旧内容

- project SOT = `<project>/.pensieve/`
- gbrain world store
- `.gbrain-source`/`.gbrain-cache`/`.gbrain-scratch`
- grep/BM25/RRF graceful fallback
- promotion gates / project→world promote lane
- Phase 1-6 roadmap checklist
- `.pensieve/config.yml` project identity

这些内容保留在 archive/ADR 中用于理解演进，不应作为实现依据。
