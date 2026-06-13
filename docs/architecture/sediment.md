---
doc_type: architecture
status: active
---

# Sediment Architecture — current spec

## 1. Role

sediment 是 pi-astack 的唯一 dedicated memory writer。主会话不会获得 `memory_write` 之类的 LLM-facing 工具；长期记忆写入由以下路径完成：

- 明确 `MEMORY: ... END_MEMORY` block（Lane A）。
- `agent_end` 背景 LLM auto-write（Lane C，需配置启用）。
- human slash commands 触发的 maintenance/migration。
- vault Lane V（由 abrain/vault 子系统同步处理，不是 ordinary memory）。

## 2. Pipeline

**阶段契约**（顺序语义）：`agent_end` → checkpoint/run-window → explicit `MEMORY:` extractor（fence-aware）→ **sanitizer（任何 LLM/audit/write 边界前的 typed redaction）** → （无显式 block 且 `autoLlmWriteEnabled` 时）LLM extractor → `memory_search` lookup（query 先 redaction）→ curator → writer validate/lint/lock/atomic write → audit → best-effort git commit。

> 机制实现以代码为准：`extensions/sediment/pipeline.ts`（入口）、`writer.ts`（落盘路由）。

## 3. Curator operation set

- `create`
- `update`
- `merge`
- `archive`
- `supersede`
- `delete`
- `skip`

ADR 0016 后，curator 是主要语义判断者。旧的 readiness/rate/sampling/rolling/G2-G13 机械 gate 已删除；它们会制造 silent reject 和死条目。

仍然 hard safety/storage boundary 主要是：

- credential/secret sanitizer：不再因命中 pattern 阻断整轮；pre-LLM / memory_search query / curator prompt / writer / audit 均将 raw secret 替换为 `[SECRET:<type>]` 后继续。若未来 sanitizer 出现不可恢复错误，才 fail closed。
- schema/kind/status validation。
- slug/path traversal/collision。
- file lock / atomic write / audit consistency。
- git index cleanup best-effort。

## 4. Write targets

B5 cutover 后，sediment 不再写 `<project>/.pensieve/`。

**拓扑契约**：project entry → `projects/<id>/`，world entry → `knowledge/`（flat），workflow → `workflows/`或 `projects/<id>/workflows/`。**audit 分两处**：project 侧 `<projectRoot>/.pi-astack/sediment/audit.jsonl`，abrain/world/workflow 侧 `~/.abrain/.state/sediment/audit.jsonl`。

> 具体落盘路径与 kind→目录映射（maxims/decisions/staging/knowledge/archive 等）以代码为准：`extensions/sediment/{writer,kind-router}.ts`。

## 5. Locks and runtime state

**契约**：entry 写锁在 abrain 侧（多项目并发写同一 `~/.abrain` git repo）；checkpoint 锁留在 project 侧（只保护本项目 session 状态）。

> 具体 lock/checkpoint/audit 文件路径以代码为准：`extensions/sediment/lock.ts`。

## 6. Git behavior

sediment 的 markdown write 是 source-of-truth；git commit 是 best-effort audit trail：

- 成功：提交到 `~/.abrain`，commit message 标注 slug + scope。
- 失败：不会回滚已写 markdown；会尽力清理 git index，避免下次 commit 携带 ghost changes。
- 读者应以文件内容 + audit 为准，git 作为回滚/审计网。

## 7. Sub-pi / ephemeral behavior

通过 dispatch 产生的 sub-pi 默认设置 `PI_ABRAIN_DISABLED=1`。沉淀、memory、vault 等扩展在 sub-pi 中不注册或 early return，避免子进程获得长期记忆/secret 写能力。ephemeral session 不推进 checkpoint，也不写长期记忆。

## 8. Secret boundary and prompt-first policy

历史上曾尝试 body shrink / section loss 等 mechanical gates。它们会 silent reject curator 的修复，让条目永久 stale。当前原则：

- 对 LLM 语义错误，优先修 curator/extractor prompt 与 examples。
- 对 credential/secret 泄漏，保留 deterministic sanitizer，但边界语义是 **redact plaintext, continue extraction**：raw secret 不进入第三方 LLM、audit JSONL 或 memory markdown；保留语义价值的上下文与 `[SECRET:<type>]` 占位符。
- extractor / curator prompt 明确要求不要复制 raw secrets；看到 secret-like string 时输出 typed placeholder，且不得还原或编造 `[SECRET:<type>]` 的原值。
- 对存储完整性，保留 schema/path/lock/atomic write hard gates。

## 9. 相关文档

- [memory.md](./memory.md)
- [abrain.md](./abrain.md)
- [../migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)
- [../adr/0016-sediment-as-llm-curator.md](../adr/0016-sediment-as-llm-curator.md)
- [../adr/0018-sediment-curator-defense-layers.md](../adr/0018-sediment-curator-defense-layers.md)
