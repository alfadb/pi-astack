# ADR 0016 — Sediment 从 gate-heavy extractor 转向 LLM curator

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的方向（重门→LLM curator = AI-Native 价值）已上提 `REQ-003` + `direction.md` §2 AI-Native，以那里为 canonical。以下机制正文（含 gate-by-gate 删除理据）**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

- **状态**: Accepted（2026-05-10）。**2026-05-13 [ADR 0018](0018-sediment-curator-defense-layers.md) 补充并随后修订**：curator "update over create" 原则在 LLM 实践中需要防御；当前保留 curator prompt update-vs-create discipline + writer trigger_phrases UNION；body_shrink/body_section_loss 机械门控及对应 smoke fixtures 已于 ADR 0018 revert (`ee1c809`) 移除。**2026-05-15 修订**：credential/secret sanitizer 从“pattern 命中整轮 fail-closed”调整为“typed redaction + continue”；raw secret 仍不得进入 LLM/audit/memory。详见 ADR 0018 头部决策摘要。
- **日期**: 2026-05-10
- **决策者**: alfadb
- **依赖**: [ADR 0015](0015-memory-search-llm-driven-retrieval.md) / [ADR 0013](0013-asymmetric-trust-three-lanes.md) / [memory-architecture.md](../memory-architecture.md) §8
- **被引用**: [ADR 0018](0018-sediment-curator-defense-layers.md)（curator P0 data-loss 三层防御）。
- **取代/修正**: 修正 ADR 0013 Lane C：G2-G13 / readiness / rolling / rate / sampling 是 burn-in scaffolding，已从 live path 删除；git + audit 是回滚面。

## 背景

Phase 1.4 Lane C 初始实现假设：LLM auto-write 是低信任来源，且旧 `memory_search` 只是 grep/tf-idf。因此系统用 G2-G13 机械 gate 防止污染：`forceProvisional`、`disallowMaxim`、`maxConfidence`、trigram / rare-token near-duplicate、rolling pass-rate、readiness dry-run 等。

这个假设在 ADR 0015 后变化：`memory_search` 已升级为 prompt-first、双阶段 LLM retrieval，能准确召回语义近邻、阅读 timeline、处理中英混合和 supersession。继续让 char-trigram / confidence cap / kind ban 等机械规则决定“是否写入”会把知识库推向 append-only，而不是自我进化。

同时，近期 live 行为证明了 create-only pipeline 的结构性缺陷：

- 旧 design decision 与新 implementation fact 并列存在；
- G13 可以挡住重复改述，但不能把旧条目更新为当前最佳事实；
- 知识的真实生命周期是补充、修正、合并、推翻、归档，而不是无限新增。

## 决策

Sediment 的角色从 **extractor + mechanical gates** 调整为 **LLM curator + minimal hard safety/storage substrate**。

默认原则：

1. **语义判断交给 LLM**：是否值得记、记成什么 kind/status/confidence、是否 maxim、是否 active，由 LLM 根据上下文和检索结果判断。
2. **硬 safety/storage boundary 只保留两类**：
   - 敏感信息：secret/token/private key/JWT/credential URL 等先被 deterministic sanitizer 替换为 `[SECRET:<type>]`，然后继续 extraction/curation/write；raw secret 不进入 LLM/audit/memory。只有 sanitizer 自身出现不可恢复错误时才 fail closed。
   - 存储完整性：path sandbox、schema parse、lint error、lock、atomic write、audit、git。
3. **知识库是 self-evolving**：历史知识可以被 update、merge、supersede、archive、delete；默认维护当前最佳 compiled truth，而不是追加平行条目。
4. **主会话仍只读**：`memory_update/delete` 是 sediment sidecar 内部能力，不把写工具直接暴露给主会话 LLM。
5. **`memory_search` 是 curator 必经 lookup**：在 create 前先找相关旧知识，优先 update/merge，而不是新增。

## 新的操作模型

目标 operation set：

```ts
type MemoryOperation =
  | { op: "skip"; reason: string }
  | { op: "create"; entry: MemoryEntryDraft; rationale: string }
  | { op: "update"; slug: string; patch: MemoryEntryPatch; timeline_note: string; rationale: string }
  | { op: "merge"; sources: string[]; target: string; compiled_truth: string; timeline_note: string; rationale: string }
  | { op: "supersede"; old_slug: string; new_slug?: string; reason: string }
  | { op: "archive"; slug: string; reason: string }
  | { op: "delete"; slug: string; mode: "soft" | "hard"; reason: string };
```

优先级：

```text
UPDATE / MERGE existing memory
  > SUPERSEDE / ARCHIVE stale memory
  > CREATE new memory
  > DELETE only for secrets, junk, or explicit user request
```

## Gate 重新分类

| 旧 gate | 新状态 |
|---|---|
| secret / credential sanitizer | 保留安全边界；2026-05-15 起为 typed redaction + continue，不再因 credential pattern 整轮拒绝 |
| path sandbox / lock / atomic write / audit / git | 保留 storage gate |
| schema parse / lint error | 保留 storage gate |
| forceProvisional | 删除 |
| disallowMaxim | 删除；LLM 可写 maxim，但必须有 durable evidence |
| maxConfidence | 删除；confidence 是知识状态的一部分 |
| disallowArchived | 删除；archive/supersede 是 curator operation |
| G13 near-duplicate | 删除；由 `memory_search` + curator 决定 update/merge/skip |
| readiness dry-run | 删除 |
| rolling pass-rate | 删除 |
| rate limit / sampling stride | 删除 |

## Phase plan

### Phase 0 — 直接信任 LLM curator（已落地）

- 删除 `sediment.autoWriteSemanticPolicy` 以及旧 G2-G13/readiness/rolling/rate/sampling 设置。
- Lane C 不再应用 `forceProvisional` / `disallowMaxim` / `disallowArchived` / `maxConfidence` / `disallowNearDuplicate`。
- LLM extractor prompt 改为允许 `kind=maxim`、status、confidence `[0,10]`，让模型表达真实知识状态。
- 新增 writer update substrate：`updateProjectEntry(slug, patch, ...)`，支持修改 compiled truth/frontmatter 并追加 timeline。

### Phase 1 — Curator lookup loop（已落地 create/update/merge/archive/supersede/delete/skip）

- Auto-write lane 对每个 candidate 调用 ADR 0015 `memory_search` 找语义近邻。
- 读取 top candidates full entry。
- Curator LLM 输出 `create/update/merge/archive/supersede/delete/skip` operation。
- 默认优先 update/merge/archive/supersede/skip，不平行新增重复 entry；delete 默认 soft（归档 + timeline），hard 只用于 secret/明显垃圾/用户明确移除，git history 是回滚面。
- 实现文件：`extensions/sediment/curator.ts` + `tryAutoWriteLane()`；当前 operation set 为 create/update/merge/archive/supersede/delete/skip。

### Phase 2 — Full memory ops

- `merge` 已有 first-class substrate：更新 target compiled truth + `derives_from`，并 archive 非 target sources；supersede 当前支持 old_slug + optional existing new_slug，不负责自动创建 replacement。
- 不暴露 auto-write / curator / explicit-extract 的 human dry-run 命令：slash command 不是 LLM-facing tool，主会话 LLM 不会自动调用，用户也不需要手动预览。curator 只作为 live sidecar，诊断/回滚依赖 audit + git。
- 自动 apply 仍只在 safety/storage gates 通过后执行。
- `.pensieve/` 不再是运行前置条件；sediment 启用后可以在没有现成 `.pensieve/` 的项目中运行，writer 在首次写入时按需创建项目 `.pensieve/`。
- 同 session 已有 background auto-write 在飞时，新 agent_end 静默返回，不写 audit、不推进 checkpoint。bg 完成后若主会话 LLM 空闲则立即检查 backlog，有则递归 drain（主动排空，不再被动等待新 agent_end 触发）。drain 通过 sessionAgentCycle 计数器门控：仅当 `ended >= started`（主会话不在 running）时启动。

## Consequences

### 好处

- 与 ADR 0015 的准确检索能力对齐；
- 避免 append-only knowledge drift；
- 允许知识自我修正、补充、推翻；
- 减少机械 gate 导致的误拒绝；
- 更符合“相信 LLM 智商”的系统设计原则。

### 风险

- LLM 可能更大胆地写 `active/maxim/high confidence`；
- create/update 需要更强 audit；
- update/delete 误操作风险高于 create-only。

缓解：

- secret boundary 仍禁止 plaintext 跨越 LLM/audit/memory，但默认通过 typed placeholder redaction 保留上下文并继续；storage gate 仍 fail-closed；
- 所有 operation 写 audit + git commit，可回滚；audit 是给 LLM 诊断的主界面，记录 lane、session_id、correlation_id、candidate_id、window/checkpoint summary、settings snapshot、entry breakdown、candidate/result、curator neighbors/decision、LLM summary、stage timings，以及 raw_text redaction metadata；writer-level create/update/merge/archive/supersede/delete/reject rows 与 agent_end summary row 共享 correlation/candidate id，便于端到端追踪；
- delete 默认 soft；hard delete 默认不用，只在 secret/junk/用户明确要求时启用；
- Phase 1/2 已支持 create/update/merge/archive/supersede/delete/skip；manual sediment dry-run commands deliberately not exposed.

## Implementation notes

- `writeProjectEntry` 继续负责 create；`updateProjectEntry` 作为 curator update substrate；`archiveProjectEntry` / `supersedeProjectEntry` / `deleteProjectEntry` 承接生命周期操作。
- 主会话 `memory_*` 工具仍保持只读；不要新增 LLM-facing `memory_update/delete` 工具。
