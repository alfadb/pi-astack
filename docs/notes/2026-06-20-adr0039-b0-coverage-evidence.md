# ADR0039 B0 覆盖率硬门：真实生产证据（2026-06-20）

> 多 T0 共识把 B0「覆盖率硬门」列为 canonical=projection 反转的强制前置：
> 反转前必须证明每条 legacy canonical 都有对应 L1 event，否则反转会静默丢失
> 早于 event writer 的历史条目。本文记录首次真实生产测量。

## 测量口径

- legacy 知识条目 = world `knowledge/*.md` ∪ project `projects/<id>/{knowledge,decisions,maxims}/**/*.md`。
- 身份键 = `world::<slug>` 或 `project:<id>:<slug>`，slug = 文件名去 `.md`。
- L1 覆盖 = 存在 `knowledge-evidence-event/v1` 事件且 (scope, project_id, slug) 匹配。
- 实现：`scripts/smoke-adr0039-reconcile.mjs` 的 `computeLegacyKnowledgeCoverage`，
  `--abrain` 模式报告（report-only，不阻断绿色构建）。

## 真实生产结果（`~/.abrain`，2026-06-20）

| 指标 | 值 |
|---|---|
| legacy 知识条目总数 | 2759 |
| 已被 L1 event 覆盖 | 30 |
| **覆盖率** | **0.0109（1.09%）** |
| 缺 L1 event | 2729 |
| `legacy_import` backfill 是否必须 | **true** |

缺失样本：`world::3-way-audit-roi-inflection-point`、
`world::abrain-cross-project-scope-awareness-invariant`、
`world::adr-0023-r3-rule-trust-provenance-hard-contract` 等。

被覆盖的 30 条都是 event_first 模式开启后由 writer 新写/改写的条目。

## 结论

**`legacy_import` backfill 是 canonical=projection 反转（B5/C3）的强制前置，不可跳过。**
现在直接反转会丢失约 98.9% 的知识记忆（2729/2759）。

backfill 设计要点（后续批次实现，遵守三条硬边界）：

- 为每条 legacy canonical 条目生成一个 `legacy_import` L1 event（operation_hint 标注
  `legacy_import`，payload 取条目当前 frontmatter + body，sanitizer 通过），append-only，
  不修改 legacy 文件（HB1/HB2）。
- backfill 后重新测量覆盖率，必须达 1.0 才允许进入反转批次。
- backfill 事件须可与「真实新信号」区分（producer/operation 标注），projector 投影出的
  L2 与 legacy canonical 应可 diff 核对，差异须可解释。

## 门的演进

当前 report-only。到反转批次时，引入显式 flag（如 `requireLegacyCoverage`）让覆盖率
< 1.0 时 reconcile/pre-push 硬阻断反转，与「先 backfill 再反转」纪律绑定。
