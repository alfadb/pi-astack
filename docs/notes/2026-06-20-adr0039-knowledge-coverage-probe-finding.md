# ADR0039 Knowledge coverage probe — 实测结论（2026-06-20）

> 用 `scripts/knowledge-coverage-probe.mjs`（只读）对真实 `~/.abrain` 量 legacy→L1 覆盖。
> **结论：覆盖率 = 1.0000，legacy-only/unresolved = 0。** continuation 里说的「281 legacy-only
> project items」是陈旧描述——该 gap 已被 legacy_import backfill 闭合。

## 实测（双路径交叉验证，非单一来源）

| 指标 | 值 |
|---|---|
| L1 knowledge identities（real + legacy_import） | 2793 |
| legacy canonical entries（global `knowledge/` + project `knowledge\|decisions\|maxims`） | 2792 |
| covered（legacy 条目有对应 L1 event） | 2792 |
| **legacy-only / unresolved** | **0** |
| **coverage ratio** | **1.0000** |
| marked-for-defer-with-evidence | 0（**无 defer-marker 机制**，仅有 delete-tombstone；因 unresolved=0 也无需要 defer 的项） |

- 独立交叉验证：`runBackfill({dryRun:true})` → `scanned=2792, appended=0, skipped=2792, failed=0`
  （没有任何待 backfill 项）。
- L1 中 legacy_import 事件 2729 条 + ~71 条真实 agent_end → 2800 events / 2793 unique identities。
- identity 口径一致：probe 与 backfill 都用 `world::<slug>` / `project:<pid>:<slug>`
  （= `knowledgeIdentityKey`，knowledge-evidence.ts:379），比对有效。

## 这对「下一架构片」的含义

1. **Knowledge backfill 已完成**——下一片**不是** backfill，也不需要 defer-with-evidence
   分流（0 unresolved）。「281」已是历史。
2. 真正的下一步是 **Knowledge canonical=projection_only flip**（Phase D）：
   `knowledgeProjector.canonicalReadMode` 从 `projection_with_legacy_fallback` → `projection_only`。
   属 flip-class（soak + 用户重启），preflight 的核心 gate 就是「coverage=1.0 + reconcile 绿」，
   本 probe 即该 gate 的精确度量（比 reconcile smoke 的 pass/fail 多了 per-item/per-zone 明细）。
3. 与 reconcile smoke 不重叠：reconcile 验 L1↔L2 投影完整性（L1→L2=1.0），本 probe 验 legacy→L1
   捕获完整性（legacy→L1=1.0）。两者都 1.0 才是 projection_only 的安全前提。

## 工具

`scripts/knowledge-coverage-probe.mjs`（只读，不写不 backfill）：
`node scripts/knowledge-coverage-probe.mjs [--home ~/.abrain] [--json]`，输出 ratio +
unresolved 列表（按 project/zone 分组）。projection_only flip 前重跑确认 1.0。
