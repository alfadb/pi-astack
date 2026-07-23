---
doc_type: architecture
status: active
---

# Memory Architecture — current spec

## 1. 核心契约

pi-astack memory 的 current contract：

1. **L1 Evidence Event 是语义 source of truth**；L2 markdown 是确定性投影视图，L3 运行索引是可重建派生物。ADR 0039 的 SQLite 是目标边界；当前已有 partial production SQLite instance，但 `memory_search` 仍主要使用 JSON/sidecar 索引与 embedding cache 作为 L3 runtime。
2. **LLM-facing surface 只读**：`memory_search` / `abrain_get` / `memory_list` / `memory_activity` / `memory_decide`。
3. **Facade 隐藏物理拓扑**：普通 search/list 结果不暴露 backend/source_path；exact lookup/debug 可暴露 provenance。
4. **`.pensieve/` 是 legacy read-only source**：不再写入；Knowledge 稳态读由 `knowledgeProjector.canonicalReadMode` 控制，当前生产配置为 `projection_only`。
5. **`memory_search` 是 LLM retrieval**：生产形态是 `stage0 hybrid` 候选召回 + stage2 full-content LLM 精排；LLM 精排模型不可用时 hard error，不降级 grep/BM25。

## 2. Stores

| Store | 用途 | 状态 |
|---|---|---|
| `~/.abrain/l1/events/sha256/**` | content-addressed evidence events | semantic SOT |
| `~/.abrain/l2/views/**` | deterministic markdown projections | stable read/audit view |
| `~/.abrain/.state/sediment/proposition-policy-stable-view/v1/latest` | content-addressed Policy stable-view pointer | sole production session rule authority for persisted main sessions (ADR 0040) |
| `~/.abrain/l2/views/constraint/latest/compiled-view.md` | repo L2 Constraint compiled view | historical projection / offline cold-audit residual; no runtime authority |
| `~/.abrain/l2/views/activity/latest/project-time-allocation.md` | Activity / attention L2 view | deterministic human-readable projection over L1 evidence events; not an editable wiki store and not a `memory_search` canonical Knowledge store |
| `~/.abrain/.state/sediment/constraint-shadow/latest/compiled-view.md` | Constraint shadow compiled view | historical/offline audit residual; not a production injection source or fallback |
| `~/.abrain/projects/<id>/` | project memory legacy markdown area | retained rollback/debug surface; projection_only steady-state writes go through L1/L2 |
| `<project>/.pensieve/` | legacy project memory | read-only migration source |
| `~/.abrain/knowledge/` | world / cross-project legacy markdown area | retained rollback/debug surface; projection_only steady-state writes go through L1/L2 |
| `~/.abrain/workflows/` | cross-project workflows | current writer target |
| `~/.abrain/projects/<id>/workflows/` | project workflows | current writer target |
| `~/.abrain/.state/` | derived state/audit/locks/local maps, including current JSON/sidecar L3 artifacts | not semantic SOT |
| `~/.abrain/.state/sediment/adr0039-l3/adr0039.sqlite` | partial production ADR0039 SQLite instance | rebuildable L3 derived layer; not current `memory_search` sole runtime |

### 2.1 Policy stable-view runtime boundary

ADR 0040 Policy stable-view is the production authority for every persisted main session. `session_start` captures the immutable bundle selected by the current abrain root's `.state/sediment/proposition-policy-stable-view/v1/latest`, strictly validates it, and injects that view; ephemeral main sessions and subagents are excluded.

A strictly valid but stale bundle remains injectable and emits a visible stale diagnostic. Missing, partial, foreign, hash/schema/provenance/budget-invalid, or otherwise invalid state produces loud zero injection. There is no compiled-view, D3, or legacy fallback. Both Constraint compiled-view materializations are historical projection/offline cold-audit residuals only and have no production session rule authority.

> **World scope 范围注**：memory facade 的 "world store" 扶袱法是扫描整个 `~/.abrain/`，只排除 `projects/**` （项目私有）与 `vault/**` （密文）。因此有 frontmatter 的 `workflows/` md 文件也会以 `scope=world` 进入 `memory_search` 结果；这是有意为之（workflow 文档可被检索），但与「world = 仅 `knowledge/`」的口语理解不同，根据需要优化粒度可以后续收窄。

## 3. Entry schema

L2 projection entry = markdown file：frontmatter（`id` / `scope`∈{project,world} / `kind`(§3.1) / `status`(§3.2) / `confidence` 0..10 / `schema_version` / `title` / `trigger_phrases` / `derives_from` / `created` / `updated`）+ body（`# Compiled Truth` + `## Timeline` 事件行）。L1 Evidence Event 仍是语义 source of truth；L2 markdown 是确定性投影/审计视图。

> 完整 frontmatter 类型定义以代码为准：`extensions/memory/types.ts`、`extensions/memory/parser.ts` 与 `extensions/memory/settings.ts`。

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

`memory_search(query, filters?)` 当前生产实现是 `stage0 hybrid` 候选召回 + stage2 full-content LLM 精排（ADR 0035/0036；机制以 `extensions/memory/llm-search.ts`、`extensions/memory/search-profiles.ts` 与运行配置为准）。返回 normalized cards，**不暴露 `backend/source_path/scope`**（仅 `abrain_get` exact lookup 可见）。

当前生产边界：

- stage0 是有序 hybrid：先让 dense 占候选窗口（扣除 freshness reserve），再按更新时间插入 stale/missing，随后追加剩余 dense、BM25 sparse、剩余 stale；每一步按 allow-set 去重并受 `stage0MaxCandidates` 约束。候选再交给 stage2 LLM 精排；`stage1Skip=true` 时不跑 stage1 LLM 粗筛，只有 verdict=none 或候选池过小时把 stage1 作为低频安全网。
- sparse 臂用 char n-gram BM25（`sparseBM25=true`），这是候选召回的一部分，不是 LLM 不可用时的 fallback。
- embedding 当前启用多向量（`multiVector=true`，每 entry 最多 `multiVectorMaxChunks` 个 sub-vector）；索引由 search-time `autoReconcile=true` 和 `scripts/embed-corpus-init.mjs` 维护，仍属于 L3 可重建派生物。
- `bestEffortOnNone=true` 时，stage2 判 `none` 且扩召仍无命中，可以返回 stage0 排序 top-K 低置信结果；调用方必须把它视为未被 LLM 确认的候选。

约束：

- Query 应写完整 retrieval intent，支持中英混合与语义改写。
- LLM 精排模型不可用时 hard error；调用方不应自行 grep/BM25 替代。stage0 embedding 不可用只会熔断为 sparse-only 候选，召回面收窄但仍必须经过 LLM 精排或显式 best-effort 边界。
- 默认排除 archived 与 superseded；`deprecated` 在解析期折叠为 superseded。
- Search/list 不把 scope/backend/source_path 交给 LLM 做选择。
- `abrain_get(slug)` 是 exact lookup/debug view，可返回 scope/source_path。

### Tool-name migration boundary

`memory_get` 于 2026-07-23 从模型可见工具面迁移为 `abrain_get`，用于避开 Anthropic/sub2api 对 `memory_search + memory_get` 的 `extra usage` 400。pi SDK 只注册并广告 `abrain_get`，没有隐藏 alias，也不改写 provider payload。dispatch tools CSV 和 persisted workflow JSON 在载入时集中把旧名 canonicalize 为新名；outcome/evidence/replay 历史解析同时识别两者。

限制：已保存历史会话中的旧 assistant tool call 记录仍可用于回放和归因，但如果该历史分支未来再次发出名为 `memory_get` 的新 tool call，运行时不会执行它，因为 SDK 中不存在旧名注册。应进入新 turn（或 fork 后重新发起）并调用 `abrain_get`。

## 5. Graph / index / derived artifacts

`_index.md`、`graph.json`、search metrics、`~/.abrain/.state/memory/embeddings.json` 与 `~/.abrain/.state/sediment/adr0039-l3/adr0039.sqlite` 都是可重建派生物；当前生产 L3 还不是全量 SQLite 统一运行时，`memory_search` 仍使用 JSON/sidecar embedding L3 runtime：

- `_index.md` 是 human/LLM browsable artifact，不是 curator realtime dependency。
- Graph 来自 frontmatter relations 与 body wikilinks。
- 派生物损坏时应 rebuild，而不是手写修复。
- 只读运行健康巡检使用 `npm run health:memory`：汇总真实 L1/L2/L3 数量、水位、embedding index 与 search metrics；严格重建门禁仍使用 `npm run reconcile:adr0039`。

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
- 旧的 rank-score fusion + grep/BM25 fallback search path。
- `.pensieve/config.yml` 作为 project identity source。
- project→world promotion gates。
- Phase 1-6 旧路线图。
- 主会话 LLM-facing write tools。

旧 monolith 原文见 [../archive/memory-architecture-v7-original.md](../archive/memory-architecture-v7-original.md)。
