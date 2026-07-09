---
doc_type: architecture
status: active
---

# Architecture Overview — 演进与当前设计愿景

## 1. 设计愿景

pi-astack 的长期目标不是“一个记忆插件”，而是 **alfadb 在 pi 里的第二大脑 / Jarvis substrate**：

- 当前会话专注执行，不直接维护长期记忆。
- 长期记忆由 sidecar/命令/用户授权路径沉淀为 ADR0039 L1 Evidence Event；L2 Markdown/git 是确定性投影与审计视图。
- `~/.abrain/` 不是 world knowledge dump，而是围绕“这个人”的数字孪生：身份、技能、习惯、工作流、项目知识、跨项目知识、秘密。
- LLM 面向的是稳定 facade：读记忆用 `memory_*`，多代理用 `dispatch_*`，秘密用授权后的 `vault_release` 或 bash env 注入；物理拓扑可以继续演进。

## 2. 设计演进主线

| 阶段 | 时间 | 核心想法 | 结果 |
|---|---|---|---|
| v6.5 | 2026-05-05 | gbrain(postgres+pgvector) 作为唯一记忆存储；sediment 三模型投票 | 成本高、JSON/投票独立性失败、multi-source 不成立。 |
| v6.6 | 2026-05-06 | sediment 回到单 agent + lookup tools | 单 agent 内核保留，后续演化为 LLM curator。 |
| v6.7/v6.8 | 2026-05-06 | 尝试 gbrain project/world dual source；再回退 `.pensieve+gbrain` | 证明 gbrain multi-source 是 scaffolding；为 markdown+git 转向铺路。 |
| v7 | 2026-05-07 | 纯 markdown+git；project `.pensieve/` + world `~/.abrain/` | gbrain 退场；compiled truth + timeline 保留。 |
| v7.1 | 2026-05-09 起 | `~/.abrain` 重定义为数字孪生七区；项目记忆进入 `~/.abrain/projects/<id>/` | ADR 0014/0017/B5 cutover 后成为后续架构基底；legacy markdown 路径后来退为回滚/调试/迁移面。 |
| v7.1+ | 2026-05-11 起 | ADR 0015 LLM retrieval、ADR 0016 LLM curator、vault P0a-c；ADR0039 event-first memory | 当前实现线：L1 Evidence Event 语义 SOT，L2 Markdown/git 投影/审计，L3 SQLite/embedding/ledger 可重建派生。 |

## 3. 当前架构分层

```text
LLM surface
  ├── dispatch_agent / dispatch_parallel
  ├── memory_search / memory_get / memory_list / memory_activity / memory_decide
  ├── vault_release
  ├── vision / imagine
  └── slash commands (human-only maintenance)

Extensions  — 清单见 `extensions/`（`find extensions -maxdepth 1 -type d`）
  ├── memory   — read-only retrieval facade
  └── sediment — only dedicated writer
  （其余扩展与角色以代码为准，不在此镜像）

Storage
  ├── ~/.abrain/          — personal brain git repo
  │   ├── l1/events/      — Evidence Event semantic SOT
  │   ├── l2/views/       — deterministic Markdown/git projection and audit view
  │   ├── identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/
  │   └── .state/         — local state/audit/locks/L3 derived artifacts, not semantic SOT
  ├── <project>/.pi-astack/ — project-local runtime artifacts
  └── <project>/.pensieve/  — legacy read-only migration source
```

## 4. Current source of truth

| 主题 | Canonical doc |
|---|---|
| 当前状态 | `docs/current-state.md` |
| memory | `docs/architecture/memory.md` |
| sediment | `docs/architecture/sediment.md` |
| abrain | `docs/architecture/abrain.md` |
| vault | `docs/architecture/vault.md` |
| directory/runtime paths | `docs/directory-layout.md` |
| commands/tools | `docs/reference/commands.md` |
| ADR status | `docs/adr/README.md` |
| historical originals | `docs/archive/` |

## 5. 不再作为 current path 的旧概念

- **gbrain / postgres / pgvector / gbrain CLI**：历史设计，已退场。
- **`.gbrain-source` / `.gbrain-cache` / `.gbrain-scratch`**：被 strict binding 取代。
- **project `.pensieve/` 作为写入目标**：B5 后不存在；只读迁移源。
- **promotion gates / project→world promote lane**：ADR 0014 后失去意义；writer 直接路由到正确 zone。
- **grep/BM25 graceful fallback**：ADR 0015 后 `memory_search` 是 LLM retrieval，失败 hard error。
- **mechanical readiness/rate/sampling gates**：ADR 0016 删除；只保留 sanitizer/存储完整性等 safety boundary。sanitizer 当前语义是 typed redaction + continue，而不是 secret pattern 命中即整轮拒绝。
- **主会话直接写长期记忆**：违背 ADR 0003 的核心不变量。

## 6. Roadmap 与设计取舍

未完成项（Lane G / vault P0d / 跨设备同步 UX / graph 增量重建 / schema 兼容等）见 `docs/roadmap.md`（backlog 单一来源）。

设计取舍：除 credential/secret 泄漏这类不可逆风险外，优先优化 prompt/curator 行为，而不是增加 silent mechanical reject gate。credential/secret 边界也优先 redact plaintext 并保留可沉淀上下文；只有不可恢复的 sanitizer/storage 错误才 fail closed。silent reject 会制造“死条目”，违背 sediment 自进化前提。
