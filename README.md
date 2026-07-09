# pi-astack

> alfadb 的个人 pi workflow 仓：把常用的 pi 扩展、模型选择、多代理、视觉/生图、记忆与 vault 能力集中在一个 local package 中维护。

pi-astack 不是通用发行版，也不是可独立组合的插件市场。它的定位是：**作者自用、使用即开发、以 ADR0039 event-first 第二大脑为核心的完整 pi 工作流**。

## 当前状态

| 主题 | 当前事实 |
|---|---|
| 记忆基底 | **L1 Evidence Event** 是唯一语义 SOT；L2 Markdown 是确定性投影/审计视图；L3 SQLite/embedding/ledger 是可重建派生层。gbrain 已完全退场。 |
| 项目记忆 | Knowledge/Constraint 当前生产写入为 `event_first`；Knowledge 读取为 `projection_only`。`~/.abrain/projects/<id>/` 与旧 `<project>/.pensieve/` 只作为 legacy 回滚、调试、迁移输入。 |
| 世界/个人大脑 | `~/.abrain/` 是 alfadb 数字孪生 / Jarvis brain；七区是人类可读视图层：`identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`。 |
| 主会话 | 记忆只读：`memory_search/get/list/activity/decide`；不会暴露 LLM-facing 写记忆工具。 |
| 写入者 | sediment sidecar 是唯一 dedicated writer；Knowledge/Constraint 稳态写入先追加 L1 event，再生成 L2 projection，legacy markdown 仅保留为回滚、调试、迁移输入。 |
| 检索 | `memory_search` 走 ADR 0015 双阶段 LLM retrieval；模型不可用时 hard error，不降级 grep/BM25。 |
| vault | P0a-P0c 已实现：`/vault`、`/secret`、`vault_release`、`$VAULT_/$PVAULT_/$GVAULT_` bash 注入、输出默认 withheld。 |
| 项目身份 | ADR 0017 strict binding：先 `/abrain bind --project=<id>`，再允许 project-scoped memory/vault 写入。 |
| 扩展数量 | 以 `ls extensions/` 为准（不在文档镜像，REQ-006）。 |
| Vendor 参考 | 当前没有 active vendor methodology submodule；历史 `vendor/gstack/` / `vendor/pensieve/` 已退役为 reference-on-demand / historical upstream reference（上游 URL 与 pinned SHA 见 [UPSTREAM.md](./UPSTREAM.md)），不是 runtime surface。 |
| 测试 | `package.json#scripts` 是 smoke live truth（数量以 `npm pkg get scripts` 为准，不在文档镜像）。 |

## 文档入口

| 读者目标 | 文档 |
|---|---|
| 快速理解现状 | [docs/current-state.md](./docs/current-state.md) |
| 架构总览与演进 | [docs/architecture/overview.md](./docs/architecture/overview.md) |
| memory facade / 条目格式 / 检索 | [docs/architecture/memory.md](./docs/architecture/memory.md) |
| sediment writer / curator / audit | [docs/architecture/sediment.md](./docs/architecture/sediment.md) |
| abrain 七区 / strict binding / lanes | [docs/architecture/abrain.md](./docs/architecture/abrain.md) |
| vault 安全模型 | [docs/architecture/vault.md](./docs/architecture/vault.md) |
| 当前目录和运行时产物 | [docs/directory-layout.md](./docs/directory-layout.md) |
| LLM tools 与 slash commands | [docs/reference/commands.md](./docs/reference/commands.md) |
| smoke 脚本 | [docs/reference/smoke-tests.md](./docs/reference/smoke-tests.md) |
| `.pensieve/` 迁移 | [docs/migration/abrain-pensieve-migration.md](./docs/migration/abrain-pensieve-migration.md) |
| vault bootstrap 运行手册 | [docs/migration/vault-bootstrap.md](./docs/migration/vault-bootstrap.md) |
| ADR 读取顺序/状态 | [docs/adr/README.md](./docs/adr/README.md) |
| 上游/vendor 策略 | [UPSTREAM.md](./UPSTREAM.md) |
| 审计快照 | [docs/audits/](./docs/audits/) |
| 旧设计原文 | [docs/archive/](./docs/archive/) |

旧的 monolith 文档已拆分：`docs/memory-architecture.md` 是 current summary；`docs/brain-redesign-spec.md` 已改为指针页，当前 abrain/vault 契约见 `docs/architecture/`，原文保存在 `docs/archive/`。

## 安装 / 本地开发

### local package 挂载

```bash
cd ~/.pi
git submodule add git@github.com:alfadb/pi-astack.git agent/skills/pi-astack
git submodule update --init --recursive  # currently no active pi-astack vendor submodules
```

在 `~/.pi/agent/settings.json`（或 pi 支持的 package 配置位置）加载本地 package：

```json
{
  "packages": ["~/.pi/agent/skills/pi-astack"]
}
```

### pi-astack 运行时配置

pi-astack 的运行时配置不走 `piStack` namespace，也不依赖官方 settings chain 合并。各扩展直接读取：

```text
~/.pi/agent/pi-astack-settings.json
```

顶层 key 就是扩展名/模块名（例如 `sediment`、`memory`、`modelFallback`、`vision`、`modelCurator`）。schema 见 [pi-astack-settings.schema.json](./pi-astack-settings.schema.json)。

> **`modelCurator` 单一数据源**：模型白名单（`providers`）与能力提示（`hints`）完全以本配置文件为准——扩展代码内不保留默认清单。未提供本文件时，model-curator 优雅降级（不做白名单、不注入能力表），而非塞入一份可能过时的硬编码清单。

示例：

```json
{
  "$schema": "./agent/skills/pi-astack/pi-astack-settings.schema.json",
  "sediment": { "enabled": true, "autoLlmWriteEnabled": true },
  "memory": { "search": { "stage1Model": "deepseek/deepseek-v4-flash" } },
  "vision": { "modelPreferences": ["openai/gpt-5.5", "anthropic/claude-opus-4-7"] }
}
```

### Windows 支持边界

Windows 上仅支持把 Git Bash/MSYS2 作为 pi-astack vault bash 注入的命令运行时；PowerShell/cmd 只适合作为启动器，不能作为 `bash` tool 的 shell。默认使用 Git for Windows：

```text
C:\Program Files\Git\bin\bash.exe
```

只有 Git Bash/MSYS2 安装在其他位置时，才需要在 `~/.pi/agent/pi-astack-settings.json` 显式覆盖：

```json
{
  "abrain": {
    "windowsVaultBashPath": "C:\\Program Files\\Git\\bin\\bash.exe"
  }
}
```

说明：

- `vault` 的 `$VAULT_/$PVAULT_/$GVAULT_` bash 注入会拒绝 WSL `bash.exe` 和 Cygwin，避免 win32 Node 写入的 `C:\...` 临时 env 文件在另一套路径空间里不可读。
- WSL 视作 Linux 环境：如需使用 WSL，请从 WSL 内安装并启动 pi，不要让 Windows 版 pi 调 Windows 的 WSL `bash.exe`。
- Windows 不做 POSIX `0600/0700` mode bit 强校验；权限约束交给 Windows ACL，vault 文件仍由 age 加密保护。

### 初始化 abrain / vault / 项目绑定

推荐从 pi 会话内完成：

```text
/vault init
/abrain bind --project=<id>
/memory migrate --dry-run
/memory migrate --go
```

说明：

- `~/.abrain/` 与七区目录会由 abrain 扩展确保存在；也可以手工 `git init ~/.abrain`。
- `/abrain bind --project=<id>` 写入三件套：项目内 `.abrain-project.json`、`~/.abrain/projects/<id>/_project.json`、`~/.abrain/.state/projects/local-map.json`。
- `/memory migrate --go` 从 legacy `.pensieve/` 迁入 `~/.abrain/projects/<id>/`；`--project` 参数已废弃并拒绝。
- sediment 新写入不再创建或写入 `.pensieve/`。

### 日常开发

```bash
cd ~/.pi/agent/skills/pi-astack
$EDITOR extensions/memory/index.ts
npm run smoke:memory
npm run smoke:dispatch
git add . && git commit -m "fix: ..."

cd ~/.pi
git add agent/skills/pi-astack
git commit -m "chore: bump pi-astack"
```

## 扩展简表

> 扩展/工具/slash 的完整清单不在 README 镜像（REQ-006：文档不复述可被 `ls`/`grep` 派生的代码事实）。canonical surface 表见 [docs/current-state.md](./docs/current-state.md) §2.1；当前事实以 `ls extensions/` + 各扩展 `registerTool`/`registerCommand` 为准。

## 设计原则

1. **作者自用优先**：不为外部发行、通用配置矩阵或多 harness 抽象牺牲速度。
2. **event-first 是记忆 SOT**：L1 Evidence Event 承载语义事实；L2 Markdown 提供纯文件、离线、可审计、可回滚的确定性视图；用户纠错生成新 event 再重投影。
3. **Facade 隐藏拓扑**：LLM 读 `memory_*`，不直接选择 backend/scope/source path。
4. **主会话只读，sediment 单写**：把长期记忆写入集中到 sidecar 和 human slash commands。
5. **Abrain 是数字孪生，不只是 knowledge repo**：identity/skills/habits/workflows/projects/knowledge/vault 各有边界。
6. **Vault 默认不进 LLM**：plaintext 进入模型上下文必须经 `vault_release` + 用户授权；bash 走更安全的 env 注入路径。
7. **历史保留但不混入 current path**：ADR 与 archive 记录演进；current docs 只描述现状与近期愿景。

## 历史演进一句话

v6.5 gbrain 唯一存储 + 三模型投票 → v6.6 单 agent + lookup tools → v6.8 `.pensieve+gbrain` 双 target → v7 纯 markdown+git → v7.1 `~/.abrain` 数字孪生 + strict binding + LLM retrieval + LLM curator + vault → ADR0039 event-first：L1 Evidence Event 作为语义 SOT，L2 Markdown 作为确定性投影/审计视图，L3 SQLite/embedding/ledger 作为可重建派生层。

详细演进见 [docs/architecture/overview.md](./docs/architecture/overview.md) 与 [docs/adr/README.md](./docs/adr/README.md)。

## License

MIT
