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

pi-astack 是一个 **local pi package** + 基于 `~/.abrain/` 的 markdown+git 记忆/数字孪生系统：提供一组 runtime extensions、一组 pi-astack LLM-facing tools（`vault_release` / `prompt_user` / `memory_*` / `dispatch_*` / `vision` / `imagine` / `web_*` / `final_answer`，不含 pi builtin tools）、若干 human slash commands。

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
| `goal/` | `goal_status/set/pause/resume/stop/clear`；`/goal` | ✓ |
| `imagine/` | `imagine` | ✓ |
| `memory/` | `memory_search/get/list/decide`；`/memory` | ✓ |
| `model-curator/` | model snapshot 注入；`/curator-reload` | ✓ |
| `model-fallback/` | error hooks | ✓ |
| `persistent-input-history/` | editor 子类；`/history-compact`、`/history-status` | ✓ |
| `sediment/` | `agent_end` hook；`/sediment`；background lanes | ✓ |
| `time-injector/` | system-prompt time block | ✓ |
| `tool-contract/` | `final_answer`；provider payload hook | ✓ |
| `tool-parallel-cap/` | Anthropic payload hook | ✓ |
| `turn-progress/` | footer / pre-working widget | ✓ |
| `verify-after-edit/` | `edit` tool_result verifier | ✓ |
| `vision/` | `vision` | ✓ |
| `web-search/` | `web_search`、`web_fetch` | ✓ |
| `workflow/` | `workflow_validate/list/run`；`/workflow` | ✓ |

### 2.2 Vendor methodology references

vendor 清单见 `.gitmodules` / `UPSTREAM.md`（read-only submodules：方法论参考）。

**契约（不变量）**：vendor 不属于 runtime surface；不从 vendor 直接加载 pi 扩展，也不在 vendor 内改端口层代码（vendor read-only + 单向依赖，ADR 0001/0006）。

## 3. 记忆与 abrain（契约/拓扑）

| 主题 | 契约 |
|---|---|
| Source of truth | **L1 Evidence Event** 是唯一语义证据源（内容寻址、一事件一文件、immutable、随 git 同步，`~/.abrain/l1/events/sha256/`）；canonical memory = L1 的确定性投影（ADR0039）。过渡期 legacy markdown 仍随 git 同步并 dual-write，作回滚兜底。 |
| 证据架构（ADR0039） | 三层 HYBRID_MD_GIT_PLUS_DB：L1 Evidence Event SOT（git）→ L2 Markdown View（git，人类可读审计视图，**非用户编辑面**；用户纠错须转成新 L1 event 再重投影）→ L3 SQLite / embedding 等派生索引（不入 git、可丢弃重建）。读路径现状：Constraint 注入 compiled-view（live）；Knowledge 读 `projection_only`（以 `knowledgeProjector.canonicalReadMode` 运行配置为准，legacy markdown 保留作显式回滚输入，不进入稳态 winning pool）。各域迁移阶段/未完成项以 [`docs/roadmap.md`](./roadmap.md) + [ADR0039](./adr/0039-constraint-pipeline-reset.md) 为准。 |
| 七区拓扑 | `identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`（人类可读视图层）；底层证据/投影/索引见上「证据架构」行。 |
| 项目写入 | `~/.abrain/projects/<projectId>/...`。 |
| 世界知识 | `~/.abrain/knowledge/<slug>.md`。 |
| workflows | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/`。 |
| `.pensieve/` | legacy 只读迁移源；sediment 不再写入。 |
| 跨设备同步 | sediment commit 后后台 push、启动 `fetch` 后先试 `merge --ff-only`，分叉时退到确定性 `merge --no-ff`（git 自带 3-way）；**LLM 解冲突被明确拒绝（知识库幻觉风险），真冲突 abort 并向用户出 runbook**（ADR 0020）。 |

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

LLM 只用：`memory_search` / `memory_get` / `memory_list` / `memory_decide`（只读 facade）。

`memory_search` 语义契约：

- 查 active project store、legacy `.pensieve/`（仅存在时只读接入）、world store；world 扫描整个 `~/.abrain/`，只排除 `projects/**` 与 `vault/**`（故 `knowledge/`、`workflows/` 下带 frontmatter 的 md 可检索）。
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
- git commit 失败时回滚刚写入文件，避免孤儿 staged changes。

> pipeline 步骤、写入路径表、锁路径以代码（`extensions/sediment/{pipeline,writer,kind-router,lock}.ts`）为准。

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
sed -n '1,140p' docs/reference/smoke-tests.md   # 完整列表与推荐子集
```

## 9. 历史文档处理原则（治理契约）

- ADR 保留架构决策、上下文、取舍、后果、supersede/walk-back 关系；先读 [adr/README.md](./adr/README.md)。
- ADR **不**记录实施流水、完成状态快照、commit timeline；这些属于本文、[roadmap.md](./roadmap.md)、`docs/audits/` 或 git history。
- 本文只描述**契约/方向/导航**，不镜像实现清单/计数/状态（REQ-006）。
- 旧 monolith 原文移入 [archive/](./archive/)；不要把 archive 当 current spec。
- 迁移目录只保留仍可执行的操作手册；已完成的 phase plan/checklist 移入 archive。

## 10. `prompt_user`

已 ship；LLM 契约 + 信任/隐私边界见 [ADR 0022](./adr/0022-prompt-user-tool.md) / `requirements.md` REQ-008；INV 覆盖与 smoke 以 `package.json` + ADR 0022 为准。
