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
| `memory/` | `memory_search/get/list/neighbors/decide`；`/memory` | ✓ |
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
| Source of truth | markdown 文件 + git history。 |
| 七区拓扑 | `identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`。 |
| 项目写入 | `~/.abrain/projects/<projectId>/...`。 |
| 世界知识 | `~/.abrain/knowledge/<slug>.md`。 |
| workflows | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/`。 |
| `.pensieve/` | legacy 只读迁移源；sediment 不再写入。 |
| 跨设备同步 | sediment commit 后后台 push、启动 `fetch + merge --ff-only`；**冲突时 LLM 自动解冲突被明确拒绝（知识库幻觉风险）**，确定性 ff/审计后 auto-merge 允许（ADR 0020）。 |

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

LLM 只用：`memory_search` / `memory_get` / `memory_list` / `memory_neighbors` / `memory_decide`（只读 facade）。

`memory_search` 语义契约：

- 查 active project store、legacy `.pensieve/`（仅存在时只读接入）、world store；world 扫描整个 `~/.abrain/`，只排除 `projects/**` 与 `vault/**`（故 `knowledge/`、`workflows/` 下带 frontmatter 的 md 可检索）。
- 两阶段 LLM rerank（候选选择 + full-content rerank）。
- 默认排除 `status=archived`；**`superseded`/`deprecated` 仍进默认结果**（active-only 需显式 `filters.status=active`）。
- 返回 normalized cards，**不暴露 backend/source_path/scope**（`memory_get` exact lookup 作 debug 才暴露）。
- **LLM search model 不可用时 hard error；没有 grep/BM25 fallback**（accuracy-is-contract，ADR 0015）。

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
