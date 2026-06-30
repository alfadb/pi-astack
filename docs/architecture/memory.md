---
doc_type: architecture
status: active
---

# Memory Architecture — current spec

## 1. 核心契约

pi-astack memory 的 current contract：

1. **L1 Evidence Event 是语义 source of truth**；L2 markdown 是确定性投影视图，L3 索引/SQLite 是可重建派生物。
2. **LLM-facing surface 只读**：`memory_search` / `memory_get` / `memory_list` / `memory_decide`。
3. **Facade 隐藏物理拓扑**：普通 search/list 结果不暴露 backend/source_path；exact lookup/debug 可暴露 provenance。
4. **`.pensieve/` 是 legacy read-only source**：不再写入；Knowledge 稳态读由 `knowledgeProjector.canonicalReadMode` 控制，当前生产配置为 `projection_only`。
5. **`memory_search` 是 LLM retrieval**：生产形态是 `stage0 hybrid` 候选召回 + stage2 full-content LLM 精排；LLM 精排模型不可用时 hard error，不降级 grep/BM25。

## 2. Stores

| Store | 用途 | 状态 |
|---|---|---|
| `~/.abrain/l1/events/sha256/**` | content-addressed evidence events | semantic SOT |
| `~/.abrain/l2/views/**` | deterministic markdown projections | stable read/audit view |
| `~/.abrain/projects/<id>/` | project memory legacy/canonical markdown area | retained as write/rollback surface during migration |
| `<project>/.pensieve/` | legacy project memory | read-only migration source |
| `~/.abrain/knowledge/` | world / cross-project knowledge markdown area | retained as write/rollback surface during migration |
| `~/.abrain/workflows/` | cross-project workflows | current writer target |
| `~/.abrain/projects/<id>/workflows/` | project workflows | current writer target |
| `~/.abrain/.state/` | derived state/audit/locks/local maps | not semantic SOT |

> **World scope 范围注**：memory facade 的 "world store" 扶袱法是扫描整个 `~/.abrain/`，只排除 `projects/**` （项目私有）与 `vault/**` （密文）。因此有 frontmatter 的 `workflows/` md 文件也会以 `scope=world` 进入 `memory_search` 结果；这是有意为之（workflow 文档可被检索），但与「world = 仅 `knowledge/`」的口语理解不同，根据需要优化粒度可以后续收窄。

## 3. Entry schema

Canonical entry = markdown file：frontmatter（`id` / `scope`∈{project,world} / `kind`(§3.1) / `status`(§3.2) / `confidence` 0..10 / `schema_version` / `title` / `trigger_phrases` / `derives_from` / `created` / `updated`）+ body（`# Compiled Truth` + `## Timeline` 事件行）。

> 完整 frontmatter 类型定义以代码为准：`extensions/memory/schema.ts`。

### 3.1 Canonical kinds

Writer contract 只接受 7 种 kind：

- `maxim`
- `decision`
- `anti-pattern`
- `pattern`
- `fact`
- `preference`
- `smell`

Read-side parser 仍保留 `pipeline` / `knowledge` 等 legacy path aliases，用于读取缺失 frontmatter 的旧 `.pensieve` 文件。现代 writer 写出的条目始终带显式 `kind`，不会依赖这些 aliases。

### 3.2 Status

- `active`：当前有效。
- `provisional`：低置信/待验证。
- `contested`：存在冲突，读者需看 timeline/evidence。
- `archived`：默认不进入 `memory_search` 结果，除非 filters 显式要求。
- `superseded` / `deprecated`：`deprecated` 在解析期折叠为 `superseded`；默认不进入 `memory_search` 结果，除非 filters 显式要求。调用方如果只想看 active，可显式 `filters.status=active`。

## 4. LLM retrieval

`memory_search(query, filters?)` 当前生产实现是 `stage0 hybrid` 候选召回 + stage2 full-content LLM 精排（ADR 0035/0036；机制以 `extensions/memory/llm-search.ts`、`extensions/memory/search-profiles.ts` 与运行配置为准）。返回 normalized cards，**不暴露 `backend/source_path/scope`**（仅 `memory_get` exact lookup 可见）。

当前生产边界：

- stage0 合并 dense embedding、sparse 候选与 stale/missing freshness floor，再把候选交给 stage2 LLM 精排；`stage1Skip=true` 时不跑 stage1 LLM 粗筛，只有 verdict=none 或候选池过小时把 stage1 作为低频安全网。
- sparse 臂用 char n-gram BM25（`sparseBM25=true`），这是候选召回的一部分，不是 LLM 不可用时的 fallback。
- embedding 当前启用多向量（`multiVector=true`，每 entry 最多 `multiVectorMaxChunks` 个 sub-vector）；索引由 search-time `autoReconcile=true` 和 `scripts/embed-corpus-init.mjs` 维护，仍属于 L3 可重建派生物。
- `bestEffortOnNone=true` 时，stage2 判 `none` 且扩召仍无命中，可以返回 stage0 排序 top-K 低置信结果；调用方必须把它视为未被 LLM 确认的候选。

约束：

- Query 应写完整 retrieval intent，支持中英混合与语义改写。
- LLM 精排模型不可用时 hard error；调用方不应自行 grep/BM25 替代。stage0 embedding 不可用只会熔断为 sparse-only 候选，召回面收窄但仍必须经过 LLM 精排或显式 best-effort 边界。
- 默认排除 archived 与 superseded；`deprecated` 在解析期折叠为 superseded。
- Search/list 不把 scope/backend/source_path 交给 LLM 做选择。
- `memory_get(slug)` 是 exact lookup/debug view，可返回 scope/source_path。

## 5. Graph / index / derived artifacts

`_index.md`、`graph.json`、search metrics 都是可重建派生物：

- `_index.md` 是 human/LLM browsable artifact，不是 curator realtime dependency。
- Graph 来自 frontmatter relations 与 body wikilinks。
- 派生物损坏时应 rebuild，而不是手写修复。

当前命令：

```text
/memory check-backlinks
/memory doctor-lite [target]
/memory lint [target]
/memory migrate --dry-run
/memory migrate --go
```

`/memory rebuild --index` 与 `/memory rebuild --graph` 已退役；生产 embedding 索引由搜索时 auto-reconcile 和维护脚本 `scripts/embed-corpus-init.mjs` 重建，graph/backlink 诊断由 `check-backlinks` 覆盖。

## 6. Migration

迁移从 legacy `<project>/.pensieve/` 到 `~/.abrain/projects/<id>/`：

```text
/abrain bind --project=<id>
/memory migrate --dry-run
/memory migrate --go
```

详见 [../migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)。

迁移命令现在从 strict active binding 读取 project id；`--project` 参数已废弃并拒绝。

## 7. 明确不再实现/不再描述为 current 的内容

- gbrain/postgres/pgvector backend。
- RRF + grep/BM25 fallback search path。
- `.pensieve/config.yml` 作为 project identity source。
- project→world promotion gates。
- Phase 1-6 旧路线图。
- 主会话 LLM-facing write tools。

旧 monolith 原文见 [../archive/memory-architecture-v7-original.md](../archive/memory-architecture-v7-original.md)。
