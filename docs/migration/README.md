---
doc_type: migration
status: active
---

# Migration docs

当前只保留仍可执行/仍需参考的迁移操作手册。

| 文件 | 状态 | 用途 |
|---|---|---|
| [abrain-pensieve-migration.md](./abrain-pensieve-migration.md) | active | legacy `.pensieve/` → `~/.abrain/projects/<id>/` per-repo migration。 |
| [vault-bootstrap.md](./vault-bootstrap.md) | active | `/vault init`、portable identity backend、vault bootstrap runbook。 |

已完成或被 ADR 0014-0018/B5 cutover 取代的计划/checklist 已移至 [../archive/migration/](../archive/migration/)。

## Current migration path

```text
/vault init                         # if vault not initialized
/abrain bind --project=<id>          # strict project identity
/memory migrate --dry-run            # preview
/memory migrate --go                 # execute
/memory doctor-lite ~/.abrain/projects/<id>
```

Do not use archived raw bash migration snippets as the normal path. They are history or emergency forensics only.
