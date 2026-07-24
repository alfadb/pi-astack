---
doc_type: architecture
status: active
---

# Sediment Architecture — current spec

## 1. Role

sediment 是 pi-astack 的唯一 dedicated memory writer。主会话不会获得 `memory_write` 之类的 LLM-facing 工具；长期记忆写入由以下路径完成：

- 明确 `MEMORY: ... END_MEMORY` block（Lane A compatibility/diagnostic 通道；非正常产品路径）。
- 明确 `MEMORY-ABOUT-ME: ... END_MEMORY` block（Lane G compatibility/diagnostic 通道；`/about-me` slash 已退役；非正常产品路径）。
- 自然对话经 `agent_end` 背景抽取是唯一正常产品路径，和 ADR 0024 / REQ-001 的隐形自治要求一致。
- `agent_end` 背景 LLM auto-write（Lane C，需配置启用）。
- human slash commands 触发的 maintenance/migration（当前用户面保留 `/sediment` 等维护入口，不保留 `/about-me` 主动声明入口）。
- vault Lane V（由 abrain/vault 子系统同步处理，不是 ordinary memory）。

## 2. Pipeline

**阶段契约**（顺序语义）：`agent_end` → checkpoint/run-window → explicit `MEMORY:` / `MEMORY-ABOUT-ME:` extractor（fence-aware）→ **sanitizer（任何 LLM/audit/write 边界前的 typed redaction）** → （无显式 block 且 `autoLlmWriteEnabled` 时）LLM extractor → `memory_search` lookup（query 先 redaction）→ curator / event writer / projector → writer validate/lint/lock/atomic write（仅仍使用 markdown writer 的域）→ audit → best-effort git commit。

> 机制实现以代码为准：`extensions/sediment/index.ts`（入口/注册）、`extensions/sediment/writer.ts`（落盘路由）与 `extensions/sediment/checkpoint.ts`（run-window/checkpoint）。

Forgetting 是同一 `agent_end` 内的独立后台 slice：`memory.forgetting.enabled` 保持 frontmatter bridge、E2 reconcile、lifecycle convergence 与 proposal planning；real demote 必须同时满足字面布尔 `memory.forgetting.executorRealApplyEnabled===true` 与 effective `sediment.autoLlmWriteEnabled=true`。前者是独立授权且字符串永远无效；后者复用既有 auto-write 语义，布尔 true 与 legacy `"true"` 有效，`staging-only`、false/`"false"`、缺失和 malformed 均关闭。任一门不能单独授权，agent_end 与 executor 双层复核。

2026-07-23 用户 fresh explicit authorization 已授权无 canary 的正式全量生产路径，production dedicated/global/AND 三者均配置为 true。memory/sediment 的 `loadPiStackSettings` 每次 resolve 都同步读取父 settings，forgetting slice 在每个 `agent_end` 重新 resolve 两道 authority，因此 formal authority 已 armed、无需重启，并在下一次 `agent_end` 生效。5/batch、20/day、CAS、corpus floor 与 resurrection backoff 继续作为 circuit breakers；30d、recall/none 与 reviewer 后移为运行中观察/后续放量质量指标。所有当前代码允许的 E1 kind 可执行，非 E1 继续 evidence/kind gates。archive reactivation 仍按自身既有 `autoLlmWriteEnabled` 逻辑独立运行；自治终态仅全文 `archived`，hard-delete、Lane G 与人工队列不在该路径。当前 eligible=0，故 transition 为 `in_progress / authorized` 而非 completed。

## 2.1 Phase-2 durable acceptance + eventual publication (2026-07-23)

Status: **`accepted` with regression fix** (temp-repo smokes green including dual-root owner isolation; production repair-only frozen-publisher evidence accepted 2026-07-23; owner-root recovery fence fixed 2026-07-24; see `docs/evidence/2026-07-23-sediment-production-acceptance.json`).

Implemented path (code is source of truth):

1. **`agent_end` capture → durable intake** (`extensions/sediment/intake.ts`): create-only fsync under `~/.abrain/.state/sediment/intake/pending/<windowId>.json`. The small record contains immutable Pi session-file/tip coordinates, **canonical `sourceProjectRoot` (bind/git root, never a launch subdirectory)**, capture diagnostics, and digests, not a copied transcript. Recovery rebuilds the exact frozen branch with Pi's JSONL parser. `windowId` is sha256 over stable source coordinates including `sourceProjectRoot` when present (no wall clock). Legacy v2 receipts without `sourceProjectRoot` remain valid: owner root may be derived from receipt cwd / session header; if ownership cannot be confirmed reliably, any instance must leave the receipt pending and only write status/audit (no claim / no LLM evaluation). Capture write failure audits + notifies and does **not** enqueue. The lifecycle hook may await this local write only.
2. **Queue driven by intake** (`agent-end-queue.ts` + `index.ts`): the memory queue is only a scheduling optimization; every `session_start` recovers pending records **owned by the current boot physical project root only** (strict root-path equality; never a global `projectId` scan). Same `project_id` with different checkouts (e.g. `pi-router` vs `pi-router2`) stay isolated. The current instance must not LLM-evaluate foreign roots. Queue retains only per-key latest coalescing, same-key serialization, cross-key max concurrency, `more` continuation, and error containment. Readiness wait/park/wake/TTL/bytes/ready-pending lifecycle is deleted; durable intake owns restart recovery. Sediment index no longer imports or calls the canonical startup consumer.

**Shared substrate vs evaluation ownership**: intake pending + publication outbox live under the shared `~/.abrain` substrate, but **evaluation ownership is per physical project root** and **footer/notify ownership is per foreground session generation**. Global publication one-shot may still converge accepted L1 for the shared outbox; its status must not paint the current session footer unless the receipt belongs to the current foreground session/root. `applySedimentStatus` / notify are fenced by foreground `sessionId` + session epoch/generation so `/new`, `/resume`, and `/reload` cannot let stale async callbacks overwrite the new UI. Non-foreground recovery may write source audit and internal state only.
3. **All Knowledge operations accept before publication**: in production `event_first` + legacy-markdown-disabled mode, create/update/delete/archive/supersede/merge/reactivation-as-update read and validate the stable view where applicable, append create-only L1 event(s), then persist one create-only publication work item per event. Publication work contains `eventId` and routing metadata only; it does not copy the event body or projection payload. Only after both L1 and every required outbox item are durable does the result return `durable_pending`. No accepted path waits for canonical startup, OFD, L2, or Git. Legacy configurations retain the old synchronous markdown/lock/Git path.
4. **Stable-view ancestor concurrency invariant**: output hash, watermark shape, and watermark event identity remain guarded. A stable view whose watermark is an ancestor of newer same-identity L1 is not rejected merely because L2 publication lags. Each mutation causally parents the projected watermark; concurrent same-slug events may share that parent, and the deterministic topo fold (`created_at_utc`, device identity/sequence, `eventId`) is the sole winner rule. There is no lagging-L2 lock-held duplicate/freshness recheck. Merge returns accepted only after target plus every source event/outbox is durable; partial crash residue leaves the checkpoint pinned and replay is byte/event-id identical.
5. **Stable source chronology**: Knowledge evidence `created_at_utc` requires a real immutable source timestamp (window tip, entry frontmatter/timeline/event head, staging created/updated, multiview capture, or forgetting authorization chronology). Missing chronology hard-fails as terminal `source_timestamp_unavailable`; there is no wall-clock fallback and no repeated LLM loop. The existing v1 operation schema is unchanged, so archive reactivation is represented as `operation_hint=update`, not a newly invented event type.
6. **Frozen-batch publisher under one held OFD**: after one nonblocking OFD acquisition, the publisher lists pending once and freezes an ordinary target of at most 64 ready items; a merge batch is never split. A single atomic group larger than 64 freezes completely alone (no silent starvation). It freezes HEAD, validates batch L1 bytes, then builds exactly `validated Knowledge L1 from frozen HEAD + validated L1 in this batch`. HEAD is read through `ls-tree` + `cat-file --batch`; unpublished worktree L1/L2 and outbox tail created after freeze cannot enter the fold. One pure deterministic plan renders affected L2 entries/removals and the manifest from that same closure. The exact cohort is batch L1 + affected L2 + manifest and uses one temp-index / ref-CAS / shared-index convergence transaction. A dangling HEAD L2 watermark or manifest is repaired from the same closure; an explicit one-shot may publish repair-only with no pending receipt. Busy/CAS/index failure and temporary detached/unborn/symbolic-ref-unavailable HEAD states leave the whole batch pending (retry), never `failed/`. Only content/schema/identity/path deterministic terminals move to `failed/`. A crash after CAS is replayed by HEAD-byte no-op detection, index convergence, then ack. L2 planning is pure and never writes outside OFD. The publisher does not call startup/requestDrain, does not loop, and does not push.
7. **Terminal and ack taxonomy**: deterministic writer rejects keep their existing reasons (`entry_not_found`, duplicate/validation/lint/status-precondition/credential, and `source_timestamp_unavailable`) so checkpoint keys/watermarks can advance. Only L1 append write/collision, outbox write, and incomplete merge receipts retain nonterminal HOLD behavior. Publication items move to `done/` only after the complete exact commit/no-op + index convergence succeeds; merge receipt ack may be partially interrupted, but remaining receipts stay pending and replay against HEAD. Knowledge outbox items carry the durable intake `windowId` from agent_end; readiness holds only while that exact window path is still pending (legacy no-`windowId` receipts keep session fallback). Intake order remains semantic L1/outbox durable → checkpoint → intake ack → publication. RM-FORGET authorization and its gates are unchanged.

**ABOUT-ME Phase-3 blocker**: no append-only identity/about-me L1 domain or authorized schema exists in this repository. A durable intent outbox would have to duplicate the complete sanitized identity draft, which is privacy-sensitive and would still not be semantic truth. Phase 2 therefore keeps `writeAbrainAboutMeUnlocked` on its synchronous legacy-domain path and does not claim `durable_pending`/L1 acceptance for Lane G. Its scheduling remains keyed per session, so one Lane G session does not serialize unrelated session keys. Phase 3 requires an explicitly authorized identity L1 schema or a privacy-preserving intent contract; this change does not invent one.

Remaining non-goals: constraint/outcome full mutation outbox and ABOUT-ME semantic migration. Shared canonical runtime remains for other owners, but sediment index is no longer a startup consumer.

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

**当前生产拓扑**：project entry 仍可落到 `projects/<id>/`，workflow → `workflows/` 或 `projects/<id>/workflows/`；Knowledge 与 Constraint 在当前生产配置中走 `event_first`，成功追加 event 后跳过 legacy markdown/rule 直写，Knowledge 读侧为 `knowledgeProjector.canonicalReadMode="projection_only"`。旧 `knowledge/` 与 `projects/<id>/` markdown 区保留为 rollback/debug surface，不是 projection_only 稳态 source。

**audit 分两处**：project 侧 `<projectRoot>/.pi-astack/sediment/audit.jsonl`，abrain/world/workflow 侧 `~/.abrain/.state/sediment/audit.jsonl`。

> 具体落盘路径、kind→目录映射以及 event-first fallback 开关以代码和 `agent/pi-astack-settings.json` 为准：`extensions/sediment/writer.ts`、`extensions/sediment/knowledge-evidence.ts`、`extensions/sediment/constraint-evidence/*.ts` 与 `extensions/sediment/settings.ts`。

## 5. Locks and runtime state

**契约**：legacy markdown 域的 entry 写锁仍在 abrain 侧；Knowledge event-first accepted path 不持有该锁或 canonical OFD，只执行 create-only L1/outbox CAS。Mutable L2/Git 由 frozen-batch one-shot publisher 在 OFD 内串行；OFD 只排斥同时修改 canonical ref/index 的 owner，不阻止合法的 create-only L1/outbox producer。publisher 的 closure 来自 frozen HEAD objects + frozen batch bytes，因此锁内外的 worktree drift 都不能扩张 exact cohort。busy 立即返回且不自旋。merge 的每个 event 都带同一稳定 publication batch identity 与同一 intake `windowId`，全部 batch receipt durable 前 publisher 不消费 partial work；仅当 receipt 对应 exact window 仍 pending 时 hold（legacy 无 windowId 才 session fallback），保持 `L1/outbox → checkpoint → intake ack → L2/Git` 的 crash-replay 顺序。checkpoint 锁留在 project 侧（只保护本项目 session 状态）。

> 具体 lock/checkpoint/audit 文件路径以代码为准：`extensions/sediment/checkpoint.ts`、`extensions/sediment/writer.ts` 与 `extensions/_shared/sync-file-lock.ts`。

## 6. Git behavior

对仍使用 markdown writer 的域，markdown entry 是 durable entry；对当前已切到 event-first/projection-only 的 Knowledge 与 Constraint，L1 Evidence Event 是 source-of-truth，L2 projection 是稳定读取面。git commit 是 best-effort audit / sync trail：

- 成功：提交到 `~/.abrain`；event-first outbox publisher 使用 deterministic exact-cohort commit，不调用 device push。Push 与 outbox ack 解耦，且本次重构不新增隐式 push。
- 失败：不会回滚已写 markdown、event 或 projection；会尽力清理 git index，避免下次 commit 携带 ghost changes。
- 读者应以当前域的 canonical source（L1 event 或 durable markdown entry）+ audit 为准，git 作为回滚/审计网。

## 7. Sub-pi / ephemeral behavior

通过 dispatch 产生的 sub-pi 默认设置 `PI_ABRAIN_DISABLED=1`。沉淀、memory、vault 等扩展在 sub-pi 中不注册或 early return，避免子进程获得长期记忆/secret 写能力。ephemeral session 不推进 checkpoint，也不写长期记忆。

## 8. Secret boundary and prompt-first policy

历史上曾尝试 body shrink / section loss 等 mechanical gates。它们会 silent reject curator 的修复，让条目永久 stale。当前原则：

- 对 LLM 语义错误，优先修 curator/extractor prompt 与 examples。
- 对 credential/secret 泄漏，保留 deterministic sanitizer，但边界语义是 **redact plaintext, continue extraction**：raw secret 不进入第三方 LLM、audit JSONL 或 memory markdown；保留语义价值的上下文与 `[SECRET:<type>]` 占位符。
- curator delete 是 soft-only；即使显式维护入口使用 hard delete，也只会移除当前工作树文件，不能清除 git history 中的 secret。泄漏处理走 [secret leak incident runbook](../reference/secret-leak-incident-runbook.md)。
- extractor / curator prompt 明确要求不要复制 raw secrets；看到 secret-like string 时输出 typed placeholder，且不得还原或编造 `[SECRET:<type>]` 的原值。
- 对存储完整性，保留 schema/path/lock/atomic write hard gates。

## 9. 相关文档

- [memory.md](./memory.md)
- [abrain.md](./abrain.md)
- [../migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)
- [../adr/0016-sediment-as-llm-curator.md](../adr/0016-sediment-as-llm-curator.md)
- [../adr/0018-sediment-curator-defense-layers.md](../adr/0018-sediment-curator-defense-layers.md)
