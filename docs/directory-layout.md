---
doc_type: reference
status: active
---

# Directory Layout — derivation pointers + 布局边界

> **薄指针页**（Phase-2 去代码镜像后）：不再镜像文件树/扩展清单/smoke 列表/计数——那些用命令派生。本文只留**布局方向边界与依赖契约**。
> pre-B5 长版已归档：[archive/directory-layout-pre-2026-05-15.md](./archive/directory-layout-pre-2026-05-15.md)。

## 1. 派生入口（不在此镜像）

| 想知道 | 派生命令 / 来源 |
|---|---|
| 仓库目录结构 | `find . -maxdepth 2 -type d \| sort`；retired upstream references 见 `UPSTREAM.md` |
| 有哪些扩展 | `find extensions -maxdepth 1 -type d \| sort` |
| 有哪些 smoke | `npm pkg get scripts`；可读镜像 [reference/smoke-tests.md](./reference/smoke-tests.md) |
| abrain 实际布局 | `find ~/.abrain -maxdepth 3 -type d \| sort`、`/abrain status` |
| settings key | `pi-astack-settings.schema.json` |

## 2. Vendor（契约）

当前没有 active vendor methodology submodule；retired/reference-on-demand 清单见 `UPSTREAM.md`。**契约**：vendor/reference material 是 read-only source material，不属于 runtime package surface；需要时临时 clone 到 tracked repo 外读取，再把想法 port 进自有 pi-astack 路径。

## 3. `_shared/`（依赖边界契约）

`extensions/_shared/` **不是 pi 加载的扩展**，而是被其它扩展 import 的库。严格三件套绑定 resolver（`resolveActiveProject`）等跨扩展基础设施住在这里，被 abrain/memory/sediment/dispatch 共用。具体导出以 `extensions/_shared/runtime.ts` 为准。

## 4. Runtime 路径方向边界（契约，非镜像）

- `<projectRoot>/.pi-astack/`：runtime state/log/output，**应 gitignored，不是 memory SOT**。project-scope audit + checkpoint/session locks 留 project 侧（记录本项目 session/window 事件）；跨项目 entry write lock 在 abrain 侧。
- `~/.pi/agent/input-history/`：`persistent-input-history` 刻意住**用户级**而非 `<projectRoot>/.pi-astack/`，因为缓冲按 **cwd 而非 project** 键控——同一项目不同子 cwd 应得独立缓冲（monorepo / scratch），项目外启动 pi 也要有历史。应在用户 dotfiles 层 gitignore。
- `~/.abrain/`：七区拓扑见 [architecture/abrain.md](./architecture/abrain.md)；`.state/` 是本地 runtime state **不是 memory truth**；vault 加密文件**不是普通 memory entry**。
- `~/.abrain/rules/{always,listed}/` 与 `~/.abrain/projects/<id>/rules/{always,listed}/`：ADR 0023-R5 **只读**注入源，push 进主会话 system prompt；**自动 rule lifecycle 写入有意 defer**。
- `~/.abrain/.vault-identity/master.age`：abrain-age-key Tier 1 默认（ADR 0019），0600 + gitignored，不随 git 离开主机（跨设备手动 `scp` + `chmod 0600`）；`.vault-master.age` 仅 Tier 3 backend 用。identity/skills/habits/workflows 在对应低频域 writer 落地前是 mkdir-only stub。

## 5. Settings

`~/.pi/agent/pi-astack-settings.json`，schema 见 [../pi-astack-settings.schema.json](../pi-astack-settings.schema.json)。**契约**：用顶层 module key（`sediment`/`memory`/`modelFallback`/`modelCurator`/`vision`...），不包在 `piStack` 下。

## 6. Dependency boundary（契约）

- `extensions/_shared/` 可被扩展 import。
- 功能扩展之间不应互相 import（除非显式设计）；共享 helper 进 `_shared`。
- 存储拓扑应藏在 runtime/path helper 与 memory facade 之后；LLM prompt 不应依赖具体路径（面向用户的 docs 除外）。
- archive docs 是历史记录，不得当实现指导。
