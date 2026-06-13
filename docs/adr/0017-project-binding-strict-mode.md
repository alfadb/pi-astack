# ADR 0017 — Project Binding Strict Mode（项目身份绑定严格模式）

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的绑定契约已上提 `REQ-007`，以那里为 canonical。以下机制正文（含 `#sediment-strict-write-guard` 锦点，0014 引，标题勿改）**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

- **状态**：Accepted（2026-05-12），**B4.5 已实施**（runtime strict resolver + `/abrain bind/status` + `/memory migrate` strict + sediment/vault guards）。**B5 sediment writer cutover 2026-05-13 已实施**（writer 全切 abrain，删 `MIGRATED_TO_ABRAIN` guard 与所有 `.pensieve/` 写路径）。**B5 后 curator P0 data-loss 三层防御已实施**（详 [ADR 0018](0018-sediment-curator-defense-layers.md)）。
- **取代**：ADR 0014 / brain-redesign-spec 中早期 `~/.abrain/projects/_bindings.md` + git remote / cwd prefix 推断方案。
- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md)、[migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)、[migration/vault-bootstrap.md](../migration/vault-bootstrap.md)
- **触发**：`~/.config/opencode` 首仓 dry-run 时用户手动传 `--project=opencode-gloabl`（typo）仍被 planner 接受，证明 migration 命令不应同时承担“决定项目身份”的职责。

## 决策摘要

项目身份绑定进入 strict mode：

1. **project id 是唯一身份**；path / git remote 都不是身份。
2. 项目仓通过 `.abrain-project.json` 声明 portable identity。
3. `~/.abrain/projects/<project_id>/_project.json` 是 abrain 侧 tracked project registry。
4. `~/.abrain/.state/projects/local-map.json` 是本机 local-only path authorization map，支持同一 project 的多个本机路径。
5. 未 bound / registry 缺失 / 当前 path 未确认 / manifest 冲突时，**拒绝 project-scoped 写操作**：`/memory migrate --go`、sediment project writes、project vault release/write。
6. `/memory migrate` 不再接受 `--project=<id>`；正确流程是先 `/abrain bind --project=<id>`，再 `/memory migrate --dry-run` / `--go`。
7. 不提供 `--local-only` 模式。`/abrain bind` 总是写项目仓 `.abrain-project.json`；是否 commit / 传输该文件由用户自己决定。
8. 不存 git remote。remote 可能 rename / fork / mirror / SSH↔HTTPS 切换，只能作为临时提示，不能进入 binding identity 或 resolver。

一句话：**`.abrain-project.json` 是 identity claim；local-map 是本机授权确认；registry 是 abrain 侧项目存在证明。三者全部满足才是 bound。**

## 背景与问题

B4 `/memory migrate --go` 已实现 per-repo 一次性迁移，但 project id 由 `--project`、git remote 推断或 cwd 推断得到。这个模型有两个问题：

1. **typo 可固化为目录**：用户传 `--project=opencode-gloabl` 时 dry-run 会正常渲染目标路径 `~/.abrain/projects/opencode-gloabl/...`。如果继续 `--go`，typo 会被写成真实 project directory。
2. **身份信号不稳定**：cwd 会移动，remote 会重命名 / fork / mirror；二者都不应作为长期身份。

因此 B4.5 将“决定项目身份”从 migration 命令中抽出，变成显式 binding 步骤。

## 数据模型

### 1. 项目仓 portable manifest

路径：

```text
<project>/.abrain-project.json
```

内容：

```json
{
  "schema_version": 1,
  "project_id": "opencode-global"
}
```

约束：

- 只包含 `schema_version` 与 `project_id`。
- 不存 path、git remote、machine id、created_at。
- 用户可选择 commit；若不 commit，则新 clone / 新机器需要用户自己复制或重新 bind。
- 该文件只是 identity claim，**不能单独授权访问 project vault / sediment write**。

### 2. abrain tracked project registry

路径：

```text
~/.abrain/projects/<project_id>/_project.json
```

内容：

```json
{
  "schema_version": 1,
  "project_id": "opencode-global",
  "created_at": "2026-05-12T19:59:00.000+08:00",
  "updated_at": "2026-05-12T19:59:00.000+08:00"
}
```

约束：

- 被 `~/.abrain` git 跟踪。
- 表示 abrain 侧存在该 project。
- 不存本机绝对路径，不存 git remote。

### 3. abrain local-only multi-path map

路径：

```text
~/.abrain/.state/projects/local-map.json
```

内容：

```json
{
  "schema_version": 1,
  "projects": {
    "opencode-global": {
      "paths": [
        {
          "path": "/home/worker/.config/opencode",
          "first_seen": "2026-05-12T19:59:00.000+08:00",
          "last_seen": "2026-05-12T19:59:00.000+08:00",
          "confirmed_at": "2026-05-12T19:59:00.000+08:00"
        },
        {
          "path": "/home/worker/work/opencode",
          "first_seen": "2026-05-13T10:00:00.000+08:00",
          "last_seen": "2026-05-13T10:00:00.000+08:00",
          "confirmed_at": "2026-05-13T10:00:00.000+08:00"
        }
      ]
    }
  }
}
```

约束：

- 不进 git（`~/.abrain/.state/` 应被 gitignore）。
- 以 `project_id` 为 key。
- 支持多路径：多个 clone、git worktree、临时 checkout、新旧路径并存。
- 当前 path 在 `paths[].path` 内才算本机授权确认。
- 若 path 已存在则更新 `last_seen`，不得 duplicate。

## active project 状态机

pi 启动时根据启动 cwd 的 git root / cwd root 读取绑定状态。active project 仍是 **boot-time snapshot**；bash `cd` 不改变 active project。

| 状态 | 条件 | project-scoped 写操作 |
|---|---|---|
| `bound` | manifest 存在合法 + registry 存在匹配 + 当前 path 在 local-map | 允许 |
| `manifest_missing` | 无 `.abrain-project.json` | 拒绝 |
| `manifest_invalid` | JSON 损坏、schema 不支持、project_id 不合法 | 拒绝 |
| `registry_missing` | manifest 有 project_id，但 `projects/<id>/_project.json` 缺失 | 拒绝 |
| `registry_mismatch` | registry project_id 与 manifest 不一致 | 拒绝 |
| `path_unconfirmed` | manifest + registry 存在，但当前 path 不在 local-map | 拒绝 |
| `path_conflict` | 当前 path 已在 local-map 中登记给另一个 project id | 拒绝 |

拒绝范围：

- `/memory migrate --go` 与迁移 dry-run 的 target planning（避免展示错误 target）
- sediment project-scoped writes：explicit MEMORY / auto-write create/update/merge/archive/supersede/delete
- project vault：`vault_release(scope='project')`、`/secret` default project scope、`$VAULT_*` project lookup、`$PVAULT_*`

允许范围：

- 只读 memory 工具（search/get/list/neighbors）
- `/memory lint`、`doctor-lite` 等只读检查
- global vault（`--global`、`$GVAULT_*`）

## `/abrain bind` 命令

### 新项目 / 无 manifest

```text
/abrain bind --project=opencode-global
```

写三处：

```text
<project>/.abrain-project.json
~/.abrain/projects/opencode-global/_project.json
~/.abrain/.state/projects/local-map.json
```

自动在两端提交 bind artifacts（只提交精确 pathspec，不扫入其他 staged/working-tree 改动）：

```text
project repo: .abrain-project.json
~/.abrain repo: .gitignore (if changed) + projects/opencode-global/_project.json
```

若任一仓不是 git worktree 或 git commit 失败，`/abrain bind` 仍会写入三层 binding 并在输出里标 warning；但 `/memory migrate --go` 的 git-clean preflight 会继续拒绝，直到用户修复提交状态。

### 已有 manifest，确认当前路径

```text
/abrain bind
```

读取 `.abrain-project.json` 的 `project_id`，确保 registry 存在，然后把当前 path 加入 local-map 或更新 `last_seen`。

### 幂等规则

- manifest 已存在且 `--project` 相同：允许，更新 registry / local-map。
- manifest 已存在且 `--project` 不同：拒绝；project rename / repair 是独立流程。
- registry 已存在且 project_id 匹配：允许，更新 `updated_at`。
- 当前 path 已绑定到另一个 project id：拒绝，要求显式 repair / unbind-path（B4.5 可不实现 repair，只需 fail-loud）。

## `/memory migrate` 语义变化

B4.5 后迁移流程：

```text
/abrain bind --project=opencode-global
/memory migrate --dry-run
/memory migrate --go
```

`/memory migrate` 从 active project binding 读取 `project_id`。

废弃 / 拒绝：

```text
/memory migrate --project=<id>
```

错误文案：

```text
/memory migrate: --project is no longer supported. Run /abrain bind --project=<id> first.
```

未 bound 时：

```text
Migration refused: project binding status = path_unconfirmed.
Run: /abrain bind
```

**原则**：migration 是数据搬迁，不负责决定身份。

## sediment strict write guard

所有 project-scoped mutation API 在写入前检查 binding 状态：

- `writeProjectEntry`
- `updateProjectEntry`
- `deleteProjectEntry`
- 以及基于它们的 merge/archive/supersede

拒绝时写 audit row：

```json
{
  "operation": "reject",
  "reason": "project_not_bound",
  "binding_status": "path_unconfirmed",
  "hint": "/abrain bind"
}
```

B5 sediment writer cutover（2026-05-13）：

- writer 6 函数（write / update / archive / delete / merge / supersede）的 entry markdown / git commit / lock 全部切到 `<abrainHome>/projects/<projectId>/` 与 `<abrainHome>/.state/sediment/locks/`。
- audit / checkpoint 仍 project-local（`<projectRoot>/.pi-astack/sediment/`），保留 forensic trace。
- R7 `MIGRATED_TO_ABRAIN` guard 与所有相关 reject 路径在 cutover 中**完全删除**：guard 唯一职责（拒绝 post-migration `.pensieve/` 写入）在新世界已无意义 — writer 不再触及 `.pensieve/`。
- strict binding guard 仍是 B4.5 全局前置：未绑定时所有 project-scoped writer 调用 reject（`project_not_bound` audit）；绑定后 writer 自动 route 到 `<abrainHome>/projects/<projectId>/`。
- migration（`/memory migrate --go`）继续从 `.pensieve/` **读**入口，向 abrain 写出口；cutover 后**新的** sediment 写入不再触碰 `.pensieve/`，所以旧 `.pensieve/` 是只读迁移源。
- partial migration 仍可重试：失败条目保留在 `.pensieve/`，再次 `/memory migrate --go` 继续搬。

## vault strict project scope

project vault 与 memory 使用同一 active project 状态。若状态不是 `bound`：

- `vault_release(scope='project')` 拒绝
- `/secret set/list/forget` 默认 project scope 拒绝（`--global` 仍可用）
- `$PVAULT_*` 拒绝
- `$VAULT_*` 不查 project vault，只能 fallback global 或拒绝（实现可选；文案必须说明 project scope unavailable）

防御目标：恶意 repo 不能仅凭伪造 `.abrain-project.json` 获得某 project vault 权限；必须在本机 local-map 中被用户确认。

## 不做

- 不存 git remote，不用 remote 自动 resolve。
- 不用 cwd prefix 自动 resolve。
- 不提供 `--local-only` 分支；用户不想提交 manifest 时自行不 commit。
- 不在 pi 启动时弹阻塞式交互；进入 unbound/path_unconfirmed degraded 状态，由用户显式运行 `/abrain bind`。
- B4.5 不实现 project rename / repair / unbind-path 的完整 UX；遇到 conflict fail-loud 即可。后续可加：
  - `/abrain unbind-path <path>`
  - `/abrain project rename <old> <new>`
  - `/abrain repair`

## 实施记录

1. Runtime data model：manifest / registry / local-map parser/writer + resolver 状态机已落在 `extensions/_shared/runtime.ts`。
2. `/abrain bind` + `/abrain status` 已落在 `extensions/abrain/index.ts`，写三处并展示 strict binding 状态。
3. `/memory migrate` strict 已落在 `extensions/memory/index.ts` / `migrate-go.ts`：拒绝 `--project`，要求 active project `bound`。
4. sediment/vault strict guards 已落地：未 bound 时 sediment hook 记录 `project_not_bound` audit 并拒绝；project vault scope 通过 strict active project gate。
5. Smoke 覆盖：`smoke-abrain-active-project` 覆盖 strict resolver / bind happy / duplicate path / manifest conflict / path conflict / no-partial-on-path-conflict / concurrent local-map update / owner-token lock release、live-pid stale lock、lock record write failure cleanup；`smoke-memory-sediment` 覆盖 agent_end strict-binding hook glue、unbound target repo refused、cwd/target 错配拒绝、symlink `.pensieve` 拒绝、partial migration 不写 guard 与 migrate 主路径；`smoke-abrain-secret-scope` 覆盖 `/secret` project-scope 拒绝与 `/abrain status` read-only；`smoke-abrain-backend-detect` 覆盖 `vault_release(scope='project')` 注册/拒绝路径。

## 后果

### 好处

- 消除迁移 typo 固化 project id 的风险。
- 项目身份随 repo 传播（当用户 commit `.abrain-project.json` 时）。
- 不依赖 path，不依赖 git remote。
- 支持多 clone / worktree。
- 对恶意 manifest fail-closed：manifest claim + registry + local-map 三者同时满足才授权。
- 为 B5 sediment writer cutover 提供明确 active project 前置条件。

### 代价

- 每个项目第一次使用前必须 `/abrain bind`。
- 用户需要理解 `.abrain-project.json` 是否 commit 的含义。
- 新 clone / 新路径首次使用需要 `/abrain bind` 确认 path。
- 旧 B4 的 `--project` override 已废弃并被拒绝，迁移流程多一步但更安全。
