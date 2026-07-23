---
doc_type: consensus
status: active
---

# Current State — pi-astack

> **薄指针页**（Phase-2 去代码镜像后）：本文只保留**跨实现稳定的契约/方向/导航**，不再镜像实现清单、计数、commit、file:line、shipped/pending 明细——那些以代码为准、用命令派生（REQ-006）。
> 与 `extensions/` 实现冲突时，以代码为准；旧路线图/历史 ADR 原文在 `docs/archive/`、`docs/adr/`。

派生事实的标准入口（不在本文镜像）：

- **有哪些扩展/工具**：`find extensions -maxdepth 1 -type d | sort`、各扩展 `registerTool` / `registerCommand`；`UPSTREAM.md`。
- **smoke 列表**：`npm pkg get scripts`（live truth），可读镜像见 `docs/reference/smoke-tests.md`。
- **设计理由/历史**：相关 ADR（见 `docs/adr/README.md`）或 `memory_search("...")`。
- **未实现/计划**：`docs/roadmap.md`。

## 1. 一句话状态

pi-astack 是一个 **local pi package** + 基于 `~/.abrain/` 的 ADR0039 event-first 第二大脑/数字孪生系统：L1 Evidence Event 是语义 SOT，L2 Markdown 是确定性投影/审计视图，L3 SQLite/embedding/ledger 是可重建派生层；提供一组 runtime extensions、一组 pi-astack LLM-facing tools（`vault_release` / `prompt_user` / `memory_*` / `dispatch_agent` / `dispatch_parallel` / `vision` / `imagine` / `web_*`，不含 pi builtin tools）、若干 human slash commands。

> 扩展与工具的当下**计数**以 `ls extensions/` + 各扩展 `registerTool` 为准，不在此镜像。

## 2. 扩展与 vendor

### 2.1 Runtime extensions（一眼地图：名字 + surface 契约 + 是否 ship）

> 实现细节、commit、版本史、INV 覆盖、计数均不在此——以 `ls extensions/`、各扩展源码、`memory_search` 与 `docs/architecture/*` 为准。surface 名是 LLM/human 契约面。

| 扩展 | surface（LLM tool / slash / hook） | shipped |
|---|---|---|
| `abrain/` | `vault_release`、`prompt_user`；`/abrain`、`/vault`、`/secret` | ✓ |
| `compaction-tuner/` | `/compaction-tuner` | ✓ |
| `context7/` | `context7_resolve`、`context7_docs` | ✓ |
| `dispatch/` | `dispatch_agent`、`dispatch_parallel` | ✓ |
| `edit-strip-empty/` | `edit` wrapper | ✓ |
| `empty-visible-output-retry/` | `message_end` 空可见输出重试 hook | ✓ |
| `goal/` | `goal_status/set/pause/resume/stop/clear`、`goal_check`；`/goal`；auto-continue（`goal.autoContinue`，default off）经 keyed detached queue + continuation ack，不阻塞 `agent_end` awaited 链 | ✓ |
| `imagine/` | `imagine` | ✓ |
| `llm-audit/` | hook（无 LLM tool/slash） | ✓ |
| `memory/` | `memory_search/abrain_get/memory_list/memory_decide`、`memory_activity`；`/memory` | ✓ |
| `model-curator/` | model snapshot 注入；`/curator-reload` | ✓ |
| `model-fallback/` | error hooks | ✓ |
| `openai-service-tier/` | hook（无 LLM tool/slash） | ✓ |
| `persistent-input-history/` | editor 子类；`/history-compact`、`/history-status` | ✓ |
| `sediment/` | `agent_end` hook；`/sediment`；background lanes | ✓ |
| `thinking-repeat-breaker/` | hook（无 LLM tool/slash） | ✓ |
| `thinking-preserve/` | hook（无 LLM tool/slash） | ✓ |
| `time-injector/` | system-prompt time block | ✓ |
| `tool-circuit-breaker/` | hook（无 LLM tool/slash） | ✓ |
| `tool-parallel-cap/` | Anthropic payload hook | ✓ |
| `turn-progress/` | footer / pre-working widget | ✓ |
| `verify-after-edit/` | `edit` tool_result verifier | ✓ |
| `vision/` | `vision` | ✓ |
| `web-search/` | `web_search`、`web_fetch` | ✓ |
| `workflow/` | `workflow_validate/list/run`；`/workflow` | ✓ |

### 2.2 Vendor methodology references

当前没有 active vendor methodology submodule；retired/reference-on-demand 清单见 `UPSTREAM.md`。

**契约（不变量）**：vendor/reference material 不属于 runtime surface；不从 vendor 直接加载 pi 扩展，也不在 vendor 内改端口层代码。已退役的上游参考（如 `vendor/gstack/`）需要时临时 clone 到 tracked repo 外读取 diff，再把想法 port 进自有 pi-astack 路径。

## 3. 记忆与 abrain（契约/拓扑）

| 主题 | 契约 |
|---|---|
| Source of truth | **L1 Evidence Event** 是唯一语义证据源（内容寻址、一事件一文件、immutable、随 git 同步，`~/.abrain/l1/events/sha256/`）；canonical memory = L1 的确定性投影（ADR0039）。Knowledge/Constraint 当前生产写入为 `event_first`，成功追加 event 后不再稳态写 legacy markdown；legacy markdown 保留为回滚、调试、迁移输入。 |
| ADR0040 Policy/session-start push | Production full flip is **completed/authorized** (transition `proposition.adr0040-policy-stable-view-runtime-flip`): every persisted main session reads only the strictly validated content-addressed Policy stable view under the current `ABRAIN_ROOT` or `HOME/.abrain`; ephemeral main sessions and subagents are excluded. Stale is diagnostic-only and still injects; invalid/missing is loud zero injection with no compiled/D3/legacy fallback. Per the user's 2026-07-21 full-auto derived-publication authorization, canonical startup/recovery ready schedules a detached deterministic rebuild from canonical whole-L1 -> P2a -> fixed profile -> production publisher; strict compile success may automatically switch `latest` without per-device grant, but recovered is reported only after the strict runtime reader returns `selected_valid`. TUI/RPC session start does not wait; same-root process singleflight and cross-process OFD lock coordinate retries. Reader remains read-only/no lazy repair, and unsafe symlink/foreign/collision residue remains untouched and fail-closed. Production acceptance on 2026-07-21 recorded recovery initial `read_failed` -> status `recovered` -> final `selected_valid` for bundle `028c8d0354f31eae97269d66991d7fedcbd57aad0badbd45e31ca287046f7a2d`; the next real-turn runtime audit recorded `policy_stable_view_injected` / `selected_valid`, item=1, view=341 bytes, fence=1/1, with compiled/D3/legacy markers false. **Boundary**: this Policy stable-view flip is not the D3-v2 session_start consumer path; D3-v2, residual non-Policy P3 consumers, and canonical_path subsequent read flips remain `blocked` / separately authorized (see [`transition-register.md`](./transition-register.md)). constraint-shadow compiled-view is historical/offline residual only — not current session rule authority. |
| Canonical local convergence | production `canonicalGitRuntime` 当前已显式启用为 `local_convergence_v2`；首笔 exact local drain 已由 [existing-drain manifest](./evidence/2026-07-12-canonical-path-p1-a-production-existing-local-drain-manifest.json) 验收。滚动 drain 当前健康：read-only [NEXT/Curator isolation manifest](./evidence/2026-07-12-canonical-path-p1-local-drain-next-curator-isolation-manifest.json) 证明 manifest-recorded 线性 generation 全部 exact/closed，当前 live tip 可继续前进且只要求包含 acceptance candidate；其中首笔后首个合格 drain 由明确真实 `sediment:auto_write:*` source event 触发。中间两代 Knowledge source_ref 均为 `sediment:replay:*`，明确不计 NEXT acceptance。production active v2 仍只有 drain lane，Curator 独立 pending/只读边界已取证，无 production v2 wiring；`.state/staging` 数量不是该 criterion。2026-07-12 startup backlog R2 规则仅约束 startup：startup preflight 保持 `allowWriterTransaction=false`，prior converged frontier 只有在 final validated/noop-pruned surviving cohort 含 Knowledge/Constraint L1/L2 content 时才可派生一代，old active-v2 metadata tail 可同 cohort 吸收；surviving owner 全为 `canonical_path_meta` 时明确 defer 且不 claim/commit。steady writer 的真实 `writer_transaction` 仍可授权 generation 并 exact commit/index-converge，后续 content drain 吸收其 metadata tail；但 content receipt 经 noop prune 后最终仅余 metadata 时，runtime 返回不携带 commit 的 benign `metadata_deferred`，sediment publication 与 abrain bind helper 均映射为 `clean`，不 queued/cleanup/audit/mutate，startup diagnostic 保留；pending recovery first 与 terminal absorbing 保持。production 只读 clone 对 11-path active backlog 的预演生成一个 exact content generation，包含 7-path Knowledge content + 4-path metadata tail，legacy residue 排除，source 未变且 startup remote operation 为 0；candidate/hash/path 明细记录在 Living Plan。随后 [runtime restart manifest](./evidence/2026-07-12-canonical-path-p1-production-runtime-restart-manifest.json) 从 strict-valid L1 重建同一 pending episode slot 1 的 claim→prepared→published→converged，逐项验证 candidate parent/tree/cohort/blob/mode/hash、真实 auto-write source、legacy 排除、无 abort/terminal/new slot、当前 HEAD containment、index 与 whole-L1，并以 durable timeline 证明 prepared 先于 fresh process、canonical recovery 无 remote command、device fetch/push 只在 ready 后发生且不作为 gate。旧 armed 进程当时未先确认退出，fresh process 由审查 dispatch 意外启动；该残余风险不被描述成有序 operator replacement。P1 completion record 已落盘，一次性 probe 已前向删除；P2/P3 仍未授权、未执行，device delivery 继续是 noncanonical best-effort infrastructure。 |
| 证据架构（ADR0039/0040） | 三层 HYBRID_MD_GIT_PLUS_DB：L1 Evidence Event SOT（git）→ L2 Markdown View（git，人类可读审计视图，**非用户编辑面**；用户纠错须转成新 L1 event 再重投影）→ L3 SQLite / embedding 等派生索引（不入 git、可丢弃重建）。Knowledge 读 `projection_only`。Policy/session-start push 的唯一 runtime authority 是 current abrain root 下 `.state/sediment/proposition-policy-stable-view/v1/latest` 指向的 exact all-five immutable bundle；reader 捕获 latest 一次后验证完整 bundle、hash/schema、whole-L1 provenance、scope、预算与 render 一致性。该派生 bundle 可在 canonical recovery ready 后由正式 deterministic compiler/publisher 自动重建，但 reader 不写、不 fallback。constraint-shadow compiled-view、D3 与 legacy rule 代码/证据可保留作离线诊断或冷审计，但 **不是** 当前 session rule authority，production hook 调用图对它们不可达。 |
| 七区拓扑 | `identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`（人类可读视图层）；底层证据/投影/索引见上「证据架构」行。 |
| 项目知识 legacy surface | `~/.abrain/projects/<projectId>/...` 保留为回滚、调试、迁移输入；Knowledge 稳态写入走 L1 event，稳态读取走 L2 projection。 |
| 世界知识 legacy surface | `~/.abrain/knowledge/<slug>.md` 保留为回滚、调试、迁移输入；world 知识稳态读取来自 L2 projection。 |
| Forgetting 运行实态 | 2026-07-23 用户 fresh explicit authorization 已直接授权无 canary 的 RM-FORGET 正式全量生产路径；`forgetting.upstream-wiring` 为 `in_progress / authorized`，production `memory.forgetting.enabled=true`、`instrumentation=true`、字面布尔 `executorRealApplyEnabled=true`，且 effective `sediment.autoLlmWriteEnabled=true`，dedicated/global/AND 三者均已 armed。decay→lifecycle proposal、durable-kind/legacy repair、RM-LIFECYCLE-002 bridge、E2 reconcile、convergence refresh 与 proposal planning 继续运行。所有当前代码允许的 E1 kind 均可执行；非 E1 继续既有 evidence/kind gates。5/batch、20/day、CAS、corpus floor、resurrection backoff 是 circuit breakers，不是 canary；30d、recall/none 与 reviewer 是运行中观察及后续放量质量指标，不是启用前门。当前 production eligible=0 的 armed dossier 只证明配置双门、source/durable/demote/reactivation hash 零变化与 action=0，不声称 nonzero executor 已验收，因此尚非 completed。memory/sediment settings resolver 每次调用都同步重读父 settings，forgetting slice 在每个 `agent_end` 重新 resolve 双门；formal authority 已 armed、无需重启，并在下一次 `agent_end` 生效。本次未执行 production demote。archive reactivation 保持独立；终态仅全文 `archived`，hard-delete、Lane G 与人工队列仍 blocked/不存在。 |
| Lifecycle convergence | RM-LIFECYCLE-002 已于 2026-07-23 通过跨供应商 T0 复核，无未解决 P0/P1，状态为 `completed / authorized`，本阶段 fully authorized（machine enum: `authorized`）。source JSON/JSONL 仍是唯一写权威；新 multiview source 在同次锁内原子创建时即写全稳定 lifecycle metadata，未知 state 显式 fail-closed；已有 terminal_at 的 live 残留在 reconcile 中优先清除 pending 调度，再由 sweep 全文可逆归档。deadline 到期执行 source-side 自治动作。E1 execution-ready 在 3 次 cap 内做 bounded exponential retry，到 cap 才 terminal；仅所属 project 再次扫描到 durable `superseded + valid successor` 时可按原 identity 重开，其他 project scan 严格隔离。E2 三迁移仍按 project_root 隔离。`lifecycle-convergence.json` 只读重建并以 persisted stable item inventory 检测 continuity loss，同时报告 cap、legacy/fresh 分类、oldest age、retry/failure class 与 unbounded pending；corrupt/cap/continuity failure 保留 last-good。production evidence v2 在 `historical_retained_evidence` 内保留完整 self-hash-valid 的 35-row、unbounded 1→0 历史迁移 preimage，并在 `current_run` 独立记录本次真实 wall-clock before/actions/after；当前无 initial unbounded 时不要求 `before>0`，新的 deadline/source action 也只归入本次，不冒充首次迁移。staging 物理删除仍 blocked；未新增 Lane G、人审队列或 forgetting 权限。见 [ADR 0043](./adr/0043-lifecycle-convergence-and-reversible-terminal-state.md) 与 [production dossier](./evidence/2026-07-23-rm-lifecycle-002-production.json)。 |
| 过渡态登记 | 当前 shadow/observe/dogfood/gated-defer 面以 [`docs/transition-register.machine.json`](./transition-register.machine.json) 为 machine source of truth；[`docs/transition-register.md`](./transition-register.md) 是确定性人类可读镜像。新增过渡态必须先登记稳定 ID、退出条件、授权与复审字段。 |
| workflows | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/`。 |
| `.pensieve/` | legacy 只读迁移源；sediment 不再写入。 |
| 跨设备同步与 hook 边界 | device delivery 使用用户环境中的 native `git fetch`、确定性 device join 与 exact-OID push。join 对唯一 merge-base 的完整 `B/H/U` trees 执行 L1 add-only union、注册 L2 从 union L1 版本化全量重建、普通 tracked path 文件级三方选择；真实双侧内容冲突 typed fail-closed。发布由 per-repo OFD mutation barrier、完整 `H -> M` journal、CAS、前/后像恢复和 whole-worktree/index/L1/L2 验证保护；push rejection 只作有界 fetch/join/push retry。网络/auth/timeout 仍仅作 `.state` audit / warning，不进入 canonical truth 或 local startup gate。pi 不管理 remote、upstream、auth、transport config 或 hooks；`merge-tree`、rebase、force 和 LLM merge 均禁用。`l2/views/knowledge/latest/manifest.json` 是 tracked canonical L2，不再是 device-local ignore。首次切换后所有旧 pi 实例必须重启以加载 OFD barrier。旧 ADR0039 hook installer 的遗留 artifact 仍只通过既有一次性 startup migration 处理。 |

> 各区 writer 覆盖状态、Lane G 进度等以代码 + `docs/roadmap.md` 为准。

## 4. Project binding strict mode（契约）

Project-scoped memory/vault 权限不从 cwd、git remote 或旧 `.gbrain-source` 推断（REQ-007）。必须三件套一致：

1. 项目仓内：`<project>/.abrain-project.json`
2. abrain 仓内：`~/.abrain/projects/<id>/_project.json`
3. host-local 映射：`~/.abrain/.state/projects/local-map.json`

```text
/abrain bind --project=<id>
/abrain status
```

active project 是 pi 启动/会话绑定时的快照；shell 中 `cd` 不会自动切换 project scope。

## 5. Memory read path（契约）

LLM 只用：`memory_search` / `abrain_get` / `memory_list` / `memory_decide` / `memory_activity`（只读 facade）。旧 dispatch tools CSV 与 persisted workflow JSON 中的 `memory_get` 在载入时转换为 `abrain_get`；模型注册面不保留旧名。

历史 outcome/evidence/replay 读取同时识别新旧名。已保存旧会话记录可继续解析，但历史分支若未来再次产生新的 `memory_get` tool call 将因 SDK 无 alias 而不可执行；需要进入新 turn 或 fork 后改用 `abrain_get`。

`memory_search` 语义契约：

- 当前 `projection_only` 下，winning pool 由 stable L2 Knowledge projection（active project + world）与 bounded hot overlay 组成；legacy `.pensieve/`、`knowledge/`、`projects/<id>/` 不进入稳态 winning pool。非 `projection_only` 迁移模式仍保留 legacy 只读接入。
- 当前生产形态是 `stage0 hybrid` 候选召回 + stage2 full-content LLM 精排：stage0 合并 dense embedding、sparse 候选与 stale/missing freshness floor；`stage1Skip=true` 时跳过 stage1 LLM 粗筛，仅在 verdict=none 或候选池过小时把 stage1 作为低频安全网。
- sparse 臂当前用 char n-gram BM25（`sparseBM25=true`）补中文、符号与标识符召回；这是 stage0 候选机制，不是 LLM 不可用时的 grep/BM25 降级。
- embedding 索引当前启用多向量（`multiVector=true`，每 entry 最多 `multiVectorMaxChunks` 个 sub-vector）；`archived` vector 只向 `sedimentDedup` 提供 dense candidate surface，默认 active/user-facing retrieval 保持排除 archived/superseded。搜索时 `autoReconcile=true` 会按冷却与 backlog 门限修补 stale/add/orphan-prune；archived-dense 调用必须传完整 lifecycle corpus，否则 fail-closed 不产生 reconcile 信号。索引仍是 L3 可重建派生物。
- `bestEffortOnNone=true` 时，stage2 判 `none` 且扩召后仍无命中，可以返回 stage0 排序 top-K 低置信结果；调用方需要自行判断相关性。
- 默认排除 `status=archived` 与 `superseded`（`deprecated` 在解析期折叠为 `superseded`，一并排除）；要纳入被替代/历史条目须显式传 `filters.status`（传 `active` 则只看活跃）。
- 返回 normalized cards，**不暴露 backend/source_path/scope**（`abrain_get` exact lookup 作 debug 才暴露）。
- **LLM 精排模型不可用时 hard error；没有 grep/BM25 fallback**（accuracy-is-contract，ADR 0015）。stage0 embedding 不可用只会熔断为 sparse-only 候选，召回面收窄但仍必须经过 LLM 精排或显式 best-effort 边界。

`memory_decide` 语义契约：面向高价值决策点，内部先检索再合成 ≤500 token decision brief；result 暴露 `decisionBriefId`/`entrySlugs` 供 memory-footnote / outcome-ledger 归因；失败不等于"无相关记忆"，应修检索/模型可用性或退回 `memory_search` + 手工综合。

## 6. Sediment write path（契约）

sediment 是**唯一 dedicated writer**（主会话不直接写记忆，REQ-005）。稳定契约：

- pi 会 await `agent_end`；sediment handler 只持久化轻量 create-only intake receipt，绝不等待 canonical startup、Git、classifier、curator 或 projector。Process queue 仅保留同 key latest coalesce/串行、跨 key cap、`more` continuation 与 error containment；旧 readiness/park/wake/TTL/bytes lifecycle 已删除，restart recovery 由 intake pending 负责。checkpoint v3 继续提供 lineage + per-candidate idempotency，partial failure 不推进 watermark。ABOUT-ME staging 路径仍 content-addressed；window-bound child work 按 session/resource key 跟踪，不跨 session 等待。
- 写入前 sanitizer 把 credential/secret-like 串替换为 `[SECRET:<type>]`，不因 pattern 命中阻断整轮；LLM extractor 只收 redacted transcript，被要求保留 typed placeholder、**不得还原 raw secret**（redaction 不可逆）。
- curator 决定 `create/update/merge/archive/supersede/delete/skip`。Knowledge 在生产 event-first 配置下读取并 guard stable view，create-only 写 L1 + eventId-only outbox 后返回 `durable_pending`，不持 writer/OFD 锁；并发同 slug 由 topo fold 决定。merge 用稳定 batch identity + 同一 intake `windowId` 阻止 partial outbox publication；publisher 仅在 receipt 对应 exact window 仍 pending 时 hold（legacy 无 windowId 才 session fallback），确保 checkpoint/ack 先于 L2/Git，并以 done receipt 去重重放。publisher 一次 OFD 普通目标冻结 <=64 ready items（merge 不拆；单原子组 >64 可单独完整 freeze）；closure 严格为 frozen HEAD validated Knowledge L1 + frozen batch L1；HEAD 用 `ls-tree`/`cat-file --batch` 读取，disk tail 不进入投影。affected L2/removal + manifest + batch L1 通过单一 exact commit/ref-CAS/index convergence 发布；dangling HEAD watermark/manifest 可由同一次或 repair-only one-shot 修复。detached/unborn/symbolic-ref 暂不可用与 CAS/busy 一样保持 pending retry，不进 failed。CAS 后崩溃由 HEAD bytes/noop + index convergence 后再 ack；publisher 不调用 startup/requestDrain，也不 push。生产 repair-only frozen-publisher 证据已 accepted（closure 3→0、L1 tail 827→827、exact 3-path cohort、无 push）；见 [production acceptance](./evidence/2026-07-23-sediment-production-acceptance.json)。Legacy markdown 域仍走 writer lock/lint/atomic write/audit/Git。ABOUT-ME 尚无 L1 schema，保留同步 legacy-domain 路径，列为 Phase 3 blocker。
- git commit 失败时不会回滚已写 markdown、event 或 projection；会尽力清理 git index，避免下次 commit 携带 ghost changes。
- canonical recovery history 的 whole-L1/L2 validation 对每个 commit 复用同一 Promise；historical snapshot 与大 prepared cohort 的 blob bytes 均由单个 `git cat-file --batch` 读取（单次拷贝 + ring buffer + cut-point property tests）；OID cache key 含 statusHash。**Cold-start 全部 historical classification（含 post-mutation final）都在 mutation barrier 外执行**：显式 `initial outside → bootstrap mutation → recovery outside → recovery/backlog mutation → final outside → stable publish-ready` phase machine 在每次入锁时复验冻结的 `HEAD + scanRoot + statusHash`，漂移释放后独立有界重算，稳定 final tuple 且无 open/quarantined recovery 才 ready。仅 `CANONICAL_MUTATION_BUSY` 由 startup runtime 以默认 10 分钟 monotonic 总预算、指数退避+jitter 重跑 fresh freeze；预算耗尽返回 typed deferred/retryable diagnostics、清 timer 并逐出 promise，等待外部 lifecycle 触发。底层单次 barrier timeout 仍为 30 秒且其 probe 采用 capped exponential backoff+jitter。禁止靠提高单次 timeout 掩盖长分类。

> pipeline 步骤、写入路径表、锁路径以代码（`extensions/sediment/index.ts`、`extensions/sediment/writer.ts`、`extensions/sediment/checkpoint.ts` 与 `extensions/_shared/sync-file-lock.ts`）为准。

## 7. Vault（契约）

Backend：abrain 自管 age keypair 为 Tier 1 默认；ssh-key / gpg-file / passphrase-only 降为 Tier 3 explicit-only（ADR 0019）。**取舍**：不复用系统 ssh key，换可移植、跨设备无系统级耦合的专属身份。

稳定契约面：

- `/vault status`、`/vault init [--backend=]`、`/secret set/list/forget`（global/project scope）。
- `vault_release(key, scope?, reason?)`：plaintext 进 LLM 前要求用户授权（prompt 翻译为用户语言）。
- bash 注入：`$VAULT_<key>`（project→global fallback）、`$PVAULT_<key>`（project-only）、`$GVAULT_<key>`（global-only）；bash 输出默认 withheld，授权后 release 并对 plaintext 做 literal redaction。
- sub-pi 默认无 vault 工具/权限（三层 guard）。

> backend 检测链、各 backend 文件布局、`.vault-identity/` 路径、deprecated backend UX、未实现项（P0d passphrase wrap 等）以代码（`extensions/abrain/backend-detect.ts`）+ `docs/roadmap.md` 为准。

## 8. 测试入口（契约）

`package.json#scripts` 是 smoke 列表 **live truth**；`docs/reference/smoke-tests.md` 是可读镜像；冲突以 `package.json` 为准。

```bash
npm run smoke:paths                       # 最小路径 sanity
npm run health:memory                     # 只读巡检真实 ~/.abrain 与 search metrics
sed -n '1,140p' docs/reference/smoke-tests.md   # 完整列表与推荐子集
```

## 9. 历史文档处理原则（治理契约）

- ADR 保留架构决策、上下文、取舍、后果、supersede/walk-back 关系；先读 [adr/README.md](./adr/README.md)。
- ADR **不**记录实施流水、完成状态快照、commit timeline；这些属于本文、[roadmap.md](./roadmap.md)、`docs/audits/` 或 git history。
- 本文只描述**契约/方向/导航**，不镜像实现清单/计数/状态（REQ-006）。
- 旧 monolith 原文移入 [archive/](./archive/)；不要把 archive 当 current spec。
- 迁移目录只保留仍可执行的操作手册；已完成的 phase plan/checklist 移入 archive。

## 10. `prompt_user`

已 ship；LLM 契约 + 信任/隐私边界见 [ADR 0022](./adr/0022-prompt-user-tool.md) / `requirements.md` REQ-008。当前等待语义由 [ADR 0041](./adr/0041-prompt-user-indefinite-wait.md) 修订：不暴露 timeout/deadline，用户不回答就持续 pending；用户取消/Esc、turn `ctx.signal` abort、`session_shutdown` 仍终止。INV 覆盖与 smoke 以 `package.json` 为准。
