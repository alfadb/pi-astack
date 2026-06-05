# P0 audit.jsonl 可用性报告(时间维度决策信号)

> 设计:`docs/notes/2026-06-05-timeline-audit-decision-signals-design.md` §6 P0。
> 工具:`scripts/audit-usability-report.mjs`(只读、有界尾读;默认不写任何文件)。
> 数据:本机真实 audit 流(非 /tmp smoke)。日期:2026-06-05。
>
> **结论:audit.jsonl 可以作为 churn/lifecycle 信号的地基,但有三条硬边界必须在设计里编码——
> turn 级归因是"近期才有"、abrain-lane 完全没有 turn_id、`target` 有 4 种形态(含 legacy 2-part)。
> 注意力/决策时序信号不能当精确事件时,churn 只能数次数。**

## 复现
```bash
node scripts/audit-usability-report.mjs \
  --project-root /home/worker/.pi --abrain-home /home/worker/.abrain \
  --max-bytes 40000000 --window-days 400
# JSON 工件: --json --out docs/audits/2026-06-05-audit-jsonl-usability-p0.json
```
> 备注:`--max-bytes` 默认 2MB(对齐 `aggregator.ts` 热路径尾读),本报告用 40MB 全量读以得到代表性分布——P0 是一次性诊断,不在 search 热路径上,可以全读。

## 实测数据(全量)

| 指标 | project(`~/.pi/.pi-astack/sediment/audit.jsonl`) | abrain(`~/.abrain/.state/sediment/audit.jsonl`) |
|---|---|---|
| 行数 / corrupt / 缺 timestamp | 4254 / **0** / **0** | 107 / **0** / **0** |
| mutation 行(create/update/merge/archive/supersede/delete) | 860 | 95 |
| churn 行(update/merge/supersede) | **208** | 11 |
| mutation 可 join slug(target\|slug) | **100%** | **100%** |
| anchor[all]:session / turn / corr | 82.9% / **30.3%** / 48.7% | 78.5% / **0%** / 77.6% |
| anchor[mutation]:session / turn / corr | 81.2% / **14.1%** / 81.2% | 87.4% / **0%** / 87.4% |
| anchor[churn]:session / turn / corr | 97.1% / **12%** / 97.1% | 100% / **0%** / 100% |
| `target` 形态 | `project:<id>:<slug>`504 / `project:<slug>`(legacy)397 / slug-field 222 | `world:<slug>`84 / path 12 |
| reject 原因 | near_duplicate14 / pensieve_disabled15 / validation4 / dup_slug3 / body_loss1 / git_fail1 | (尾内无) |

## 七条决定性发现 → 对设计的影响

1. **数据完整性好**:两路 corrupt=0、缺 timestamp=0。解析器无需复杂容错。
2. **churn 可算且对偏差鲁棒**:project 208 churn 行,counts 是 timing-invariant(write-time skew / 批量化 / survivorship 都不影响计数)。→ **churn→caution 信号可做,但只数次数,不依赖时间精度。**
3. **turn 级归因是"近期才有"**:turn_id 全量仅 14.1%(mutation),但第一条带 turn_id 的行是 **2026-05-27**(ADR 0027 C6 之后),而最早行是 2026-05-08。即 **turn_id 覆盖率是 recency 的函数**——近期 100%,历史 0。→ **决策-turn 级 join 只能限定在近期窗口;历史只能退到 session_id/timestamp。**
4. **abrain-lane 完全没有 turn_id(0%)**:证实 `appendAbrainAudit`(writer.ts:1625)不 spread 因果锚。但 session_id/correlation_id 在新行有(mutation 87%)。→ **world/workflow 注意力分析只能用 session_id,不能做 turn 级;且这是 caller 供给的,不是 anchor 保证。**
5. **`target` 有 4 种形态,含 legacy 2-part `project:<slug>`**(397 行,无 project-id 段,早于项目绑定):slug-parser 必须处理 `project:<id>:<slug>` / `project:<slug>`(legacy)/ `world:<slug>` / path(`*.md`)+ 独立 `slug` 字段。**少处理一种就静默丢 ~40% 历史 mutation 行。**(本工具初版正因漏了 legacy 2-part 把 joinable 误报成 58.5%,修正后 100%——已记为教训。)
6. **churn 在本语料偏稀疏**:project 208 / abrain 11 churn 行。→ **任何基于 churn 的统计要标注低样本,不追显著性(与设计 §5 一致)。**
7. **静默丢行 + hard-delete 不可测**:成功路径"先 commit 再 audit"、诊断行 fire-and-forget,均可能丢行;hard-delete 历史只在 abrain git repo(`git -C abrainHome`)。→ **完整 churn/震荡链仍需 git log 兜底;audit 单独不是全貌。**

## 裁决:audit 可作地基,带护栏

- ✅ **churn / lifecycle counts**:可用(project + abrain mutation 100% joinable,counts 鲁棒)。
- ✅ **slug 解析**:可用,前提是 parser 处理全部 4 种 target 形态 + slug 字段。
- ⚠️ **turn 级决策归因**:仅近期窗口(≥2026-05-27)可靠;历史退化。
- ⚠️ **注意力/session 分布**:project 可用 session_id;abrain 仅 session_id 且无 turn;均为 write-time,只配 "recently touched"。
- ❌ **精确事件时 / 全量震荡链 / hard-delete**:audit 单独做不到,需 git log。

## 对设计文档的回填(P2 实现约束)
1. slug-parser 必须覆盖 4 种 target 形态;附带单测用本报告的形态分布做 fixture。
2. churn 信号定义为 `count(update/merge/supersede)`,不依赖时间戳精度。
3. turn 级归因加 recency gate:窗口外的行不声称 turn 归因。
4. abrain/world 注意力只用 session_id,且标注"非 anchor 保证"。
5. 输出 `bias_notes` 必含:turn_id recency 截断、abrain-lane 无 turn、write-time、hard-delete 不可测、churn 低样本。
