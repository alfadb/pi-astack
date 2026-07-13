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

pi-astack 是一个 **local pi package** + 基于 `~/.abrain/` 的 ADR0039 event-first 第二大脑/数字孪生系统：L1 Evidence Event 是语义 SOT，L2 Markdown 是确定性投影/审计视图，L3 SQLite/embedding/ledger 是可重建派生层；提供一组 runtime extensions、一组 pi-astack LLM-facing tools（`vault_release` / `prompt_user` / `memory_*` / `dispatch_*` / `vision` / `imagine` / `web_*`，不含 pi builtin tools）、若干 human slash commands。

> 扩展与工具的当下**计数**以 `ls extensions/` + 各扩展 `registerTool` 为准，不在此镜像。

## 2. 扩展与 vendor

### 2.1 Runtime extensions（一眼地图：名字 + surface 契约 + 是否 ship）

> 实现细节、commit、版本史、INV 覆盖、计数均不在此——以 `ls extensions/`、各扩展源码、`memory_search` 与 `docs/architecture/*` 为准。surface 名是 LLM/human 契约面。

| 扩展 | surface（LLM tool / slash / hook） | shipped |
|---|---|---|
| `abrain/` | `vault_release`、`prompt_user`；`/abrain`、`/vault`、`/secret` | ✓ |
| `compaction-tuner/` | `/compaction-tuner` | ✓ |
| `context7/` | `context7_resolve`、`context7_docs` | ✓ |
| `dispatch/` | `dispatch_agent`、`dispatch_parallel`、`dispatch_hub`（受 `dispatch.hub.enabled` 门控；状态见 [`transition-register.md`](./transition-register.md) 对应条目） | ✓ |
| `edit-strip-empty/` | `edit` wrapper | ✓ |
| `empty-visible-output-retry/` | `message_end` 空可见输出重试 hook | ✓ |
| `goal/` | `goal_status/set/pause/resume/stop/clear`、`goal_check`；`/goal` | ✓ |
| `imagine/` | `imagine` | ✓ |
| `llm-audit/` | hook（无 LLM tool/slash） | ✓ |
| `memory/` | `memory_search/get/list/decide`、`memory_activity`；`/memory` | ✓ |
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
| Canonical local convergence | production `canonicalGitRuntime` 当前已显式启用为 `local_convergence_v2`；首笔 exact local drain 已由 [existing-drain manifest](./evidence/2026-07-12-canonical-path-p1-a-production-existing-local-drain-manifest.json) 验收。滚动 drain 当前健康：read-only [NEXT/Curator isolation manifest](./evidence/2026-07-12-canonical-path-p1-local-drain-next-curator-isolation-manifest.json) 证明 `ea1b9be1… → 781b584d… → 916de321… → 0a595671…` 线性 generation 全部 exact/closed，当前 live tip 可继续前进且只要求包含 acceptance candidate；`0a595671…` 是首笔后首个由明确真实 `sediment:auto_write:*` source event `4250d277…` 触发的合格 drain。`781b584d…`、`916de321…` 的 Knowledge source_ref 均为 `sediment:replay:*`，明确不计 NEXT acceptance。production active v2 仍只有 drain lane，Curator 独立 pending/只读边界已取证，无 production v2 wiring；`.state/staging` 数量不是该 criterion。2026-07-12 startup backlog R2 规则仅约束 startup：startup preflight 保持 `allowWriterTransaction=false`，prior converged frontier 只有在 final validated/noop-pruned surviving cohort 含 Knowledge/Constraint L1/L2 content 时才可派生一代，old active-v2 metadata tail 可同 cohort 吸收；surviving owner 全为 `canonical_path_meta` 时明确 defer 且不 claim/commit。steady writer 的真实 `writer_transaction` 仍可授权 generation 并 exact commit/index-converge，后续 content drain 吸收其 metadata tail；但 content receipt 经 noop prune 后最终仅余 metadata 时，runtime 返回不携带 commit 的 benign `metadata_deferred`，sediment publication 与 abrain bind helper 均映射为 `clean`，不 queued/cleanup/audit/mutate，startup diagnostic 保留；pending recovery first 与 terminal absorbing 保持。production 只读 clone 对 11-path active backlog 的预演生成一个 exact content generation，包含 7-path Knowledge content + 4-path metadata tail，legacy residue 排除，source 未变且 startup remote operation 为 0；candidate/hash/path 明细记录在 Living Plan。随后 [runtime restart manifest](./evidence/2026-07-12-canonical-path-p1-production-runtime-restart-manifest.json) 从 strict-valid L1 重建同一 pending episode slot 1 的 claim→prepared→published→converged，逐项验证 candidate parent/tree/cohort/blob/mode/hash、真实 auto-write source、legacy 排除、无 abort/terminal/new slot、当前 HEAD containment、index 与 whole-L1，并以 durable timeline 证明 prepared 先于 fresh process、canonical recovery 无 remote command、device fetch/push 只在 ready 后发生且不作为 gate。旧 armed 进程当时未先确认退出，fresh process 由审查 dispatch 意外启动；该残余风险不被描述成有序 operator replacement。P1 completion record 已落盘，一次性 probe 已前向删除；P2/P3 仍未授权、未执行，device delivery 继续是 noncanonical best-effort infrastructure。 |
| 证据架构（ADR0039） | 三层 HYBRID_MD_GIT_PLUS_DB：L1 Evidence Event SOT（git）→ L2 Markdown View（git，人类可读审计视图，**非用户编辑面**；用户纠错须转成新 L1 event 再重投影）→ L3 SQLite / embedding 等派生索引（不入 git、可丢弃重建）。读路径现状：Knowledge 读 `projection_only`（以 `knowledgeProjector.canonicalReadMode` 运行配置为准，legacy markdown 保留作显式回滚输入，不进入稳态 winning pool）。Constraint `session_start` 已注入 compiled-view，但当前 runtime consumer 仍读取 `~/.abrain/.state/sediment/constraint-shadow/latest/compiled-view.md`；`~/.abrain/l2/views/constraint/latest/compiled-view.md` 是 repo L2 投影/审计面，不是当前 injector 的读取源。当前 `ruleInjector.compiledViewInjection.fallbackToLegacyOnError=false`，compiled-view 读/coverage/schema/size 失败会 fail-closed；`requireFresh=false` 后 stale 处置为注入上一版稳定 view 并显示 banner。2026-07-08 治理审计窗口显示 compiled-view 数据门总体达标，具体计数以 shadow compiler metrics 与 dual-read audit 为准；legacy rules 保留为 rollback/debug/migration surface，不是 read failure fallback；legacy retirement/archive/delete 仍需独立 gate，不能由 fallback=false 间接执行。各域迁移阶段/未完成项以 [`docs/roadmap.md`](./roadmap.md) + [ADR0039](./adr/0039-constraint-pipeline-reset.md) 为准。 |
| 七区拓扑 | `identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`（人类可读视图层）；底层证据/投影/索引见上「证据架构」行。 |
| 项目知识 legacy surface | `~/.abrain/projects/<projectId>/...` 保留为回滚、调试、迁移输入；Knowledge 稳态写入走 L1 event，稳态读取走 L2 projection。 |
| 世界知识 legacy surface | `~/.abrain/knowledge/<slug>.md` 保留为回滚、调试、迁移输入；world 知识稳态读取来自 L2 projection。 |
| Forgetting 运行实态 | decay→lifecycle_proposal 接线已落地（60b5d40，2026-07-08）；pending、demote 与 reactivation 计数以 `~/.abrain/.state/sediment/entry-lifecycle-proposals.jsonl`、forgetting-demote-ledger 与 archive-reactivation ledger 为准。剩余缺口是 executor 消费一个受控批次并让 demote ledger / reactivation window 可审计。 |
| 过渡态登记 | 当前 shadow/observe/dogfood/gated-defer 面以 [`docs/transition-register.machine.json`](./transition-register.machine.json) 为 machine source of truth；[`docs/transition-register.md`](./transition-register.md) 是确定性人类可读镜像。新增过渡态必须先登记稳定 ID、退出条件、授权与复审字段。 |
| workflows | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/`。 |
| `.pensieve/` | legacy 只读迁移源；sediment 不再写入。 |
| 跨设备同步与 hook 边界 | device delivery 只使用用户环境中的原生 `git fetch`、`git merge --ff-only '@{upstream}'`、`git push`，失败仅作 `.state` audit / warning，不进入 canonical truth 或 local startup gate。pi 不管理 remote、upstream、auth、transport config 或 hooks。`4c49584` 删除旧 ADR0039 hook installer 后，遗留 artifact 只通过一次性 startup migration 处理：`.state/` gitignore guard 成功后，以删除全部 inherited `GIT_*` 的 local structural env 验证 abrain top-level/absolute git-dir，只检查历史默认 `<git-dir>/hooks/pre-push`，忽略 `core.hooksPath`；仅 regular file 整体 bytes 精确等于唯一已发布 pi body 才 unlink，且 audit 记录 actual hash/size/mode/dev/ino 而不记录 path/content。custom、modified、hook/parent symlink、non-regular 与 unreadable artifact 一律保留。opened-fd `fstat`、read 后 `fstat` 与 unlink 前 path `lstat` 会检测已覆盖竞态，但 Node 没有 fd-relative unlink，不能宣称消除最终微窗口。这是 pi-owned artifact removal，不是 device transport management。 |

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

LLM 只用：`memory_search` / `memory_get` / `memory_list` / `memory_decide` / `memory_activity`（只读 facade）。

`memory_search` 语义契约：

- 当前 `projection_only` 下，winning pool 由 stable L2 Knowledge projection（active project + world）与 bounded hot overlay 组成；legacy `.pensieve/`、`knowledge/`、`projects/<id>/` 不进入稳态 winning pool。非 `projection_only` 迁移模式仍保留 legacy 只读接入。
- 当前生产形态是 `stage0 hybrid` 候选召回 + stage2 full-content LLM 精排：stage0 合并 dense embedding、sparse 候选与 stale/missing freshness floor；`stage1Skip=true` 时跳过 stage1 LLM 粗筛，仅在 verdict=none 或候选池过小时把 stage1 作为低频安全网。
- sparse 臂当前用 char n-gram BM25（`sparseBM25=true`）补中文、符号与标识符召回；这是 stage0 候选机制，不是 LLM 不可用时的 grep/BM25 降级。
- embedding 索引当前启用多向量（`multiVector=true`，每 entry 最多 `multiVectorMaxChunks` 个 sub-vector）；搜索时 `autoReconcile=true` 会按冷却与 backlog 门限修补 stale/add/orphan-prune，索引仍是 L3 可重建派生物。
- `bestEffortOnNone=true` 时，stage2 判 `none` 且扩召后仍无命中，可以返回 stage0 排序 top-K 低置信结果；调用方需要自行判断相关性。
- 默认排除 `status=archived` 与 `superseded`（`deprecated` 在解析期折叠为 `superseded`，一并排除）；要纳入被替代/历史条目须显式传 `filters.status`（传 `active` 则只看活跃）。
- 返回 normalized cards，**不暴露 backend/source_path/scope**（`memory_get` exact lookup 作 debug 才暴露）。
- **LLM 精排模型不可用时 hard error；没有 grep/BM25 fallback**（accuracy-is-contract，ADR 0015）。stage0 embedding 不可用只会熔断为 sparse-only 候选，召回面收窄但仍必须经过 LLM 精排或显式 best-effort 边界。

`memory_decide` 语义契约：面向高价值决策点，内部先检索再合成 ≤500 token decision brief；result 暴露 `decisionBriefId`/`entrySlugs` 供 memory-footnote / outcome-ledger 归因；失败不等于"无相关记忆"，应修检索/模型可用性或退回 `memory_search` + 手工综合。

## 6. Sediment write path（契约）

sediment 是**唯一 dedicated writer**（主会话不直接写记忆，REQ-005）。稳定契约：

- 写入前 sanitizer 把 credential/secret-like 串替换为 `[SECRET:<type>]`，不因 pattern 命中阻断整轮；LLM extractor 只收 redacted transcript，被要求保留 typed placeholder、**不得还原 raw secret**（redaction 不可逆）。
- curator 决定 `create/update/merge/archive/supersede/delete/skip`；writer 上锁、lint、atomic write、append audit、best-effort git commit；audit raw/error/candidate title 均存 redacted form。
- git commit 失败时不会回滚已写 markdown、event 或 projection；会尽力清理 git index，避免下次 commit 携带 ghost changes。

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
