---
doc_type: architecture
status: active
---

# Brain Redesign Spec（current summary）

> 原 `brain-redesign-spec.md` v1.5 已归档到 [archive/brain-redesign-spec-v1.5-original.md](./archive/brain-redesign-spec-v1.5-original.md)。本文只保留当前设计愿景与已实现状态；详细 current spec 见 [architecture/abrain.md](./architecture/abrain.md) 与 [architecture/vault.md](./architecture/vault.md)。

## 1. 定位

`~/.abrain/` 的当前定位是 **alfadb 的数字孪生 / Jarvis brain**，不是普通 world knowledge 仓。

七区：

```text
identity/  skills/  habits/  workflows/  projects/  knowledge/  vault/
```

## 2. 已实现

| 能力 | 状态 |
|---|---|
| 七区目录创建 | shipped |
| `projects/<id>/` project memory writer | shipped（B5 cutover） |
| `knowledge/` world knowledge writer | shipped |
| `workflows/` writer | shipped |
| ADR 0017 strict project binding | shipped |
| `/abrain bind/status` | shipped |
| `/memory migrate --go` per-repo migration | shipped |
| vault P0a-P0c (`/vault`、`/secret`、`vault_release`、bash injection) | shipped |
| sub-pi abrain isolation | shipped |

## 3. Pending / roadmap

| 能力 | 目标 |
|---|---|
| Lane G / about-me（G1 writer shipped）| G1 writer + `MEMORY-ABOUT-ME` fence extractor + router + `agent_end` Lane G natural path 已落（[ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）；`/about-me` slash 已退役；G4 review-staging + G5 region ranking hint backlog |
| vault P0d/P1 | masked wizard、`.env` import、backend migration UX |
| cross-device sync UX | 多机同步冲突可见性与操作流程 |
| schema evolution | binding/frontmatter/audit 的前向兼容 |

## 4. 当前操作路径

```text
/vault init
/abrain bind --project=<id>
/abrain status
/memory migrate --dry-run
/memory migrate --go
```

不要使用旧文档中的 raw bash migration 作为推荐路径；它只适合灾备/手工修复。标准迁移入口是 `/memory migrate`。

## 5. 关键不变量

1. 主会话 memory read-only，sediment 是 dedicated writer。
2. Project identity 必须通过 strict binding 三件套确认。
3. `.pensieve/` 是 legacy source，不是 current write target。
4. Vault plaintext 默认不进入 LLM；`vault_release` 必须解释 reason 并等待用户授权。
5. `identity/skills/habits` G1 writer (`writeAbrainAboutMe`) 已 ship（2026-05-16 [ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）；当前入口是 `MEMORY-ABOUT-ME` fence 与 `agent_end` Lane G natural path，`/about-me` slash 已退役，任何文档声称现在能 `/about-me` 交互都过时。

详见：

- [architecture/overview.md](./architecture/overview.md)
- [architecture/abrain.md](./architecture/abrain.md)
- [architecture/vault.md](./architecture/vault.md)
- [migration/abrain-pensieve-migration.md](./migration/abrain-pensieve-migration.md)
- [migration/vault-bootstrap.md](./migration/vault-bootstrap.md)
- [adr/0014-abrain-as-personal-brain.md](./adr/0014-abrain-as-personal-brain.md)
- [adr/0017-project-binding-strict-mode.md](./adr/0017-project-binding-strict-mode.md)
