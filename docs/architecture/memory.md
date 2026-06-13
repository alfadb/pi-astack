# Memory Architecture — current spec

## 1. 核心契约

pi-astack memory 的 current contract：

1. **markdown+git 是唯一 source of truth**。
2. **LLM-facing surface 只读**：`memory_search` / `memory_get` / `memory_list` / `memory_neighbors`。
3. **Facade 隐藏物理拓扑**：普通 search/list 结果不暴露 backend/source_path；exact lookup/debug 可暴露 provenance。
4. **`.pensieve/` 是 legacy read-only source**：迁移前仍可读，迁移后不再写。
5. **`memory_search` 是 LLM retrieval**：不可用时 hard error，不降级 grep/BM25。

## 2. Stores

| Store | 用途 | 状态 |
|---|---|---|
| `~/.abrain/projects/<id>/` | active project memory SOT | current write target |
| `<project>/.pensieve/` | legacy project memory | read-only migration source |
| `~/.abrain/knowledge/` | world / cross-project knowledge | current write target for `scope=world` |
| `~/.abrain/workflows/` | cross-project workflows | current writer target |
| `~/.abrain/projects/<id>/workflows/` | project workflows | current writer target |
| `~/.abrain/.state/` | derived state/audit/locks/local maps | not knowledge SOT |

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
- `archived`：默认不进入 `memory_search` 结果，除非 filters 显式要求（默认只排 `archived`）。
- `superseded` / `deprecated`：**仍会进入**默认 `memory_search` 结果。调用方如果只想看 active，需显式 `filters.status=active`。（这一点 doc 上一版描述与实现不符已修正；是否进一步在 facade 默认过滤 superseded/deprecated 是独立设计选项，未决。）

## 4. LLM retrieval

`memory_search(query, filters?)` 实现 ADR 0015（两阶段 LLM rerank：候选选择 + full-content rerank；机制以 ADR 0015 + `extensions/memory/search.ts` 为准）。返回 normalized cards，**不暴露 `backend/source_path/scope`**（仅 `memory_get` exact lookup 可见）。

约束：

- Query 应写完整 retrieval intent，支持中英混合与语义改写。
- 搜索失败时 hard error；调用方不应自行 grep 替代。
- 默认排除 archived。
- Search/list 不把 scope/backend/source_path 交给 LLM 做选择。
- `memory_get(slug)` 是 exact lookup/debug view，可返回 scope/source_path。

## 5. Graph / index / derived artifacts

`_index.md`、`graph.json`、search metrics 都是可重建派生物：

- `_index.md` 是 human/LLM browsable artifact，不是 curator realtime dependency。
- Graph 来自 frontmatter relations 与 body wikilinks。
- 派生物损坏时应 rebuild，而不是手写修复。

当前命令：

```text
/memory rebuild --index
/memory rebuild --graph
/memory check-backlinks
/memory doctor-lite [target]
```

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
