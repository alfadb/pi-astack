---
doc_type: review-evidence
status: pending-review
created: 2026-06-16
gate: cross-vendor-T0-review (mandated by goal g-eaaa09e1 verification rules; A NOT marked complete until passed)
---

# A1 评审证据包:规则路径全集裁决(去 Jaccard 门 + 归档相悖)

供跨厂商 T0 盲评。A 任务在本评审通过前**不标完成**。

## 1. 改了什么 / 为什么

**问题**:Tier-1 规则写入用"字面重合度 Jaccard ≥ 0.85"作门——重合度不到线就直接新建、根本不让 LLM 看。中文改写下它漏判,导致 5 条"行业黑话"规则并存(只加不减)。Jaccard 门本身就是一道"机械分数替 LLM 做去留决定"的门,与本项目"分数只挑候选、LLM 永远拍板"和"宁可重做、不堆机械护栏"两条原则冲突。

**改法(A1)**:规则路径改为**沉淀当下,先取同范围全部 active 规则(集合小、不进嵌入索引)→ LLM 一次裁决**;决策空间 `{create, update, merge}` **新增 `archive_slugs`**(软归档被取代/相悖的旧规则)。无分数门;分数不参与决定。

## 2. 保留的安全契约(请重点审这些)

- **不丢指令(R2')**:任何失败(裁决器不可用/超时/解析失败、目标 slug 非法、主操作被拒且非 git 瞬时失败)→ **确定性 create**,绝不静默丢弃。归档只在主操作成功后执行,且 best-effort(失败记录不致命)。
- **信任分层不变(Option B)**:本改动只动规则路径;大库与通道分层不变。
- **误合并防护**:`archive_slugs` 仅允许候选集内、且排除胜出条目;LLM 幻觉的 slug 被过滤;裁决器提示明确"拿不准就不归档"(保守)。归档是软删(status→archived)、可 git 撤、有审计。merge 带 `expectedBodyHash` TOCTOU 见证(并发改动→拒绝而非覆盖,回落 create)。
- **显式 kill-switch**:`sediment.tier1RuleSetAdjudication`(默认 true)。设 false 回落旧 Jaccard 单候选路径(`tier1JaccardCuratorLane`)。符合"运行时开关必须显式在 settings"的 maxim。

## 3. 文件清单

| 文件 | 改动 |
|---|---|
| `extensions/sediment/tier1-ruleset-adjudicator.ts`(新) | 全集裁决:prompt 构建、严格解析(闭决策空间、archive 默认 [])、LLM 调用、`resolveRuleWrite` 编排(应用 create/update/merge + 归档 + 失败回落 create) |
| `extensions/sediment/writer.ts` | 新增 `listRulesInScope`(scope-exact 列全部 active 规则,timeline 去除,复用 readRuleForAdjudication) |
| `extensions/sediment/index.ts` | Tier-1 编排:`tier1RuleSetAdjudication` 开 → 走 `resolveRuleWrite`;关 → 旧 Jaccard 路径(原样保留为 else 分支,最小 diff) |
| `extensions/sediment/settings.ts` + `pi-astack-settings.schema.json` | 新增 `tier1RuleSetAdjudication: boolean = true` |
| `scripts/smoke-tier1-ruleset-adjudication.mjs`(新) + `package.json` | 8 项 smoke |

diff stat(不含新文件):5 files, +76/-2。

## 4. 证据(smoke,注入 fake 裁决器,无需 live LLM)

`npm run smoke:tier1-ruleset` → **8/8 通过**,含:
- **JARGON REPLAY**:新"扩展到口头交流"指令 + 旧窄规则 + 2 条同主题规则 → `merge` 进目标 + **归档 2 条 siblings**,且**未新建条目** ✓(正是要复现的行为)
- create + 归档被取代规则 ✓
- 裁决器失败 → 确定性 create、不归档 ✓
- 非法目标 slug → 安全 create 回落 ✓
- archive_slugs 过滤(剔除非候选 + 胜出者自身)✓
- 无候选 → 确定性 create ✓
- 解析单元(拒 skip / update 缺 target / merge 缺 body)✓

回归:`smoke:tier1-jaccard-adjudication`(16)、`smoke:abrain-rule-writer-fs`(18)、`smoke:tier1-directive-defer`(10)仍全绿。

## 5. 给 T0 评审的具体问题

1. **归档授权范围**:LLM 现可在写入当下归档"它判定为被取代/相悖"的同范围规则(软删可撤)。这个授权是否过宽?是否该再设上限(如单次归档数上限、或仅允许归档 confidence 更低者)?
2. **失败回落的完备性**:`resolveRuleWrite` 的回落矩阵(裁决失败/非法目标/主操作拒)是否覆盖所有"指令可能丢"的路径?merge 的 `git_commit_failed` 不回落(交由 checkpoint 重试)是否正确?
3. **prompt 质量**:全集裁决 prompt 是否会诱发过度归档(false-merge 风险)?"保守、拿不准不归档"的措辞是否足够?
4. **大库外溢**:此路径仅用于规则(小集合全量喂 LLM)。是否有把它误用到大库的风险?(A2 才处理大库,用嵌入召回。)
5. live LLM 行为未测(smoke 用 fake);真实裁决质量需 T0 判断 prompt 是否稳。

## 6. 待办(本评审通过后)

- 评审意见落地 → 再标 A1 完成。
- A2(大库写入时去重修稳)单独推进。
