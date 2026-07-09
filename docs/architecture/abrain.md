---
doc_type: architecture
status: active
---

# Abrain Architecture — current spec

## 1. Re-scope

`~/.abrain/` 不再只是“跨项目世界知识库”。当前定义：

> `~/.abrain/` 是 alfadb 的数字孪生 / Jarvis brain：关于这个人的长期身份、技能、习惯、工作流、项目知识、跨项目知识和秘密的统一基底。

## 2. Seven zones

```text
~/.abrain/
├── identity/    # who alfadb is; profile, stable preferences, self-model
├── skills/      # durable abilities / reusable procedures
├── habits/      # recurring behavior and preferences
├── workflows/   # cross-project workflows / task blueprints
├── projects/    # project-scoped memory and vaults
├── knowledge/   # cross-project facts/patterns/decisions/maxims
└── vault/       # encrypted global secrets
```

> 各区的 writer/read 落地状态以代码 + `docs/roadmap.md` 为准（identity/skills/habits 由 Lane G 推进，见 roadmap）。本文只定义七区**拓扑契约**，不镜像 shipped/pending 明细。

## 3. Project strict binding

Project identity is explicit, not inferred. A project is bound only when these artifacts agree:

```text
<project>/.abrain-project.json
~/.abrain/projects/<id>/_project.json
~/.abrain/.state/projects/local-map.json
```

Commands:

```text
/abrain bind --project=<id>
/abrain status
```

Important properties:

- cwd/git remote alone never grants project-scoped privileges.
- active project is a session/boot-time snapshot; shell `cd` does not silently switch scope.
- project vault scope and project memory writer share the same binding substrate.
- unbound/path-unconfirmed state fails closed for project writes.

## 4. Lane model

| Lane | Trigger | Target | Trust |
|---|---|---|---|
| A — explicit MEMORY | user writes `MEMORY: ... END_MEMORY` | project/world/workflow via sediment | high |
| C — auto-write | `agent_end` LLM extraction + curator | project/world/workflow via sediment | medium |
| G — about-me | `MEMORY-ABOUT-ME` fence or `agent_end` Lane G extraction | `identity/skills/habits/` | active natural path; `/about-me` slash retired |
| V — vault | `/secret` / vault commands | encrypted vault | highest |

Lane B/D “project→world promotion” is obsolete in seven-zone abrain: writer should route to the correct zone directly instead of promoting later.

## 5. Relationship to `.pensieve/`

Old project memory lived in `<project>/.pensieve/`. Current state:

- memory facade may still read `.pensieve/` as legacy source.
- `/memory migrate --go` moves entries to `~/.abrain/projects/<id>/`.
- sediment writer never writes `.pensieve/` post-B5.
- no symlink compatibility layer is used; split-brain avoidance wins over transparent legacy path.

## 6. Git and state boundaries

| Path | Git? | Meaning |
|---|---|---|
| `~/.abrain/l1/events/sha256/**` | yes | L1 Evidence Event semantic SOT |
| `~/.abrain/l2/views/**` | yes | L2 deterministic markdown projections / audit views |
| `~/.abrain/projects/<id>/*.md` | yes | project memory L2/legacy canonical area retained as write/rollback surface during migration |
| `~/.abrain/knowledge/*.md` | yes | world knowledge L2/legacy canonical area retained as write/rollback surface during migration |
| `~/.abrain/workflows/*.md` | yes | cross-project workflows |
| `~/.abrain/vault/*.age` | no | encrypted secrets; never commit plaintext/secret ciphertext metadata policy depends on vault docs |
| `~/.abrain/.state/` | no | local maps, audit, locks, metrics |
| `<project>/.pi-astack/` | no | project-local runtime artifacts |

## 7. Design invariants

1. Every durable memory entry has one home zone.
2. LLM does not choose backend/path; routing is code/prompt-mediated and validated.
3. Project identity must be explicit and reversible via git-visible artifacts.
4. Vault plaintext is not memory and does not enter LLM context by default.
5. Derived artifacts (`l2/views/**`, `_index.md`, `graph.json`, L3 indexes) can be rebuilt from L1 and stable retained surfaces.
6. Migration is forward-only per repo; rollback uses git/pre-migration SHA, not symlink split-brain.

## 8. Related

> Roadmap/未完成项（Lane G review/ranking refinements、跨设备同步 UX、schema 版本兼容等）见 `docs/roadmap.md`。

Related: [vault.md](./vault.md), [memory.md](./memory.md), [../migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md), [../adr/0014-abrain-as-personal-brain.md](../adr/0014-abrain-as-personal-brain.md), [../adr/0017-project-binding-strict-mode.md](../adr/0017-project-binding-strict-mode.md).
