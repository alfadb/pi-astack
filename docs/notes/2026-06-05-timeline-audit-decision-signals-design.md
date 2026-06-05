# 时间维度决策信号:frontmatter-first 检索增益 + audit 可用性审计 + retrieval-shadow 验证

> 状态:**design note(pre-ADR)**,**已过 3×T0 盲审(2026-06-05),裁决 REVISE→已修订**。
> 升格 ADR 0028 前需先交付 P0 audit 可用性报告。
> 缘起:主会话讨论"用时间线梳理近期任务 / 关注度 / 决策新鲜度,辅助 LLM 决策"。
>
> **一句话结论**:时间信号值得做,但
> ① **第一刀用 frontmatter 派生字段进 Stage2**(不碰 audit、不碰 Stage1 召回门);
> ② **audit.jsonl 先当"被审计对象"而非地基**——它不统一、会静默丢行、git 历史在另一个 repo;
> ③ 所有信号只做 **Stage2 软提示**,不进 Stage1 硬召回门,不做硬降权。

---

## 盲审修订日志(2026-06-05)

3×T0(opus-4-8 架构 / gpt-5.5 对抗 / deepseek-v4-pro 代码核实)盲审,一致 **REVISE**。已修正:

| # | 盲审发现 | 修订 |
|---|---|---|
| P0-1 | 数据契约错:audit 无 `slug`(用 `target: "<scope>:<id>:<slug>"`);operation 是 `create` 非 `capture`,且实际 ~25 个值;`reactivated` 不是 operation。照原文实现 churn≡0 | §0 schema + §3 词汇全部对齐真实代码 |
| P0-2 | **把时间字段塞 Stage1 index = 在硬召回门做 silent reject,违反自身不变量1**(Stage1 只让被选 slug 进 Stage2,未选即终态) | 时间字段**全部移到 Stage2-only**(§4) |
| P1-1 | "不硬降权"是会计花招:churn_hint 经 reranker 必然压排名 | §2/§7 直面"LLM 中介降权",约束 caution 仅作 `why` 证据、不得作唯一排除理由 |
| P1-2 | audit `turn_id` 是"沉淀处理轮"非"决策轮";偏差1 在 session 粒度仍在 | §0 下调 claim:只修字面 "sediment" 坍缩,不修 write-time |
| P1-3 | audit append-only 无界;现有 aggregator 只尾读 2MB/500 行;全量扫会让 search IO-bound | §3/§6 改增量/有界 reader |
| GPT-5.5 | abrain/world-lane 经 `appendAbrainAudit`(writer.ts:1625)**不 spread 因果锚**;git commit 在 `abrainHome` repo 非 projectRoot;reject 行 schema 异构;Stage1 注入非"一行改动"(贯穿多调用点);shadow full-turn replay 无 harness | §0 加 lane 缺口与 git repo 方向;§5 降级为 retrieval-shadow;§6 重划 MVP |
| DeepSeek | 锚点 writer.ts:380 错(应 267/588);其余 13/14 锚点正确 | 附录已改 |

## 实现进度(2026-06-05)

| 阶段 | commit | 状态 |
|---|---|---|
| P0 audit 可用性工具 + 报告 | `8914865` | ✅ 已跑真实数据(见 §0.3) |
| P1 frontmatter→Stage2 时间字段(gated 默认 off) | `f821129` | ✅ smoke 全绿 |
| shadow 可检测 maxim demotion + schema freshnessSignals | `3598a54` | ✅ DeepSeek 代码审计无 bug |
| dogfood opportunity-case 生成 | (本次) | ✅ `scripts/dogfood-shadow-cases.mjs` |
| 跑 dogfood shadow + 决定翻 flag | — | ⏳ 待真实 LLM 批跑 |

**已知缺口(本期文档化,不补)**:
1. **path-A 注入热路径无 shadow 埋点**:只有显式 `memory_search`(`llmSearchEntries`)有 shadow 块;`llmSearchEntriesWithVerdict`(path-A 常驻注入)没有。→ dogfood 样本=显式搜索,不能据此推断 path-A 行为。补它要给注入热路径加一次 Stage2 调用(主会话延迟),留给 dogfood milestone 再定。
2. **shadow 只测排序 diff,不测答案效用**:`any_high_confidence_maxim_demoted` 能做"安全否决";"价值放行"需配 opportunity denominator + 人工 oracle(见 `scripts/dogfood-shadow-cases.mjs` 产出的 `expected_*` 字段)。

---

## 0. 数据源现实(改方向的依据)

### 0.1 timeline 的三个固有偏差(为什么不直接聚合 timeline)
1. **处理时 ≠ 事件时**:时间戳 = `nowIso()`(`writer.ts:177`→`_shared/runtime.ts:46`)。`buildMarkdown` 顶部一次 `nowIso()`,`created`/`updated`/timeline 首行 **三戳同值**(`writer.ts:262`);update 行戳是 `mergeUpdateMarkdown` 再次 `nowIso()`(`writer.ts:403`),即 sediment `agent_end` 批跑落盘时刻。**分钟级聚类是批边界产物,不是真实时序。**
2. **session 归因坍缩**:timeline session 字段 = `draft.sessionId || "sediment"`(`writer.ts:267`/`588`/`1570`/`2096`),curator 批量写大多退化成字面 `"sediment"`。
3. **幸存者/compaction 偏差(最毒)**:软删/合并源 → `status=archived` 进 archive 目录,`memory_search` 默认过滤(`search.ts` `entryMatchesFilters`);硬删 → `git rm`+`fs.unlink` 整段从工作树消失。**churn/震荡最剧的条目恰恰最可能已被删/archive**,活语料聚合系统性漏掉检测目标。完整链只在 git history 里。

### 0.2 audit.jsonl 不是干净地基(盲审推翻的乐观假设)
`appendAudit`(`writer.ts:731`)→ `<projectRoot>/.pi-astack/sediment/audit.jsonl`。**真实** enriched schema(`writer.ts:769`):

```jsonc
{
  "timestamp": "2026-06-05T14:52:00.000+08:00", // append 时刻,仍是写入时不是事件时
  // 以下来自 spreadAnchor(getCurrentAnchor()) —— 仅 project-side appendAudit 有:
  "session_id": "...",      // 是"触发沉淀的轮",不是"用户决策的轮"
  "turn_id": "...",         // 同上;anchor 缺失路径无此字段
  "audit_version": <n>, "pid": <n>, "project_root": "...",
  // 以下随 event 而变(非保证):
  "operation": "create|update|merge|archive|supersede|delete|reject|error|skip|route_rejected|auto_write|explicit_extract|about_me_extract|dry_run|staging_resolve|staging_ageout|archive_reactivation|archive_reactivation_apply|archive_reactivation_decision|correction_classifier|aggregator_advisory|multi_view_replay_*|...",
  "target": "project:<id>:<slug>",  // ← 不是 "slug"!主路径用 target,需 split 取 slug
  "reason": "...",          // 仅部分事件(reject 等)
  "correlation_id": "...",  // 仅当 caller 传 auditContext.correlationId
  "prompt_version": "..."   // 仅当 caller 主动 spread,enriched 层不强制
}
```

盲审实测的**地基裂缝**(全部回查代码确认):
- **abrain/world/workflow/about-me lane 经 `appendAbrainAudit`(`writer.ts:1625`),不调 `spreadAnchor`** → 这些行**没有 `turn_id`**;但 P0 实测 abrain mutation 行仍带 caller 供给的 `session_id`/`correlation_id`(各 ~87%)。即 turn 级归因不可用、session 级可用(非 anchor 保证)。〔§0.3 已用实测数订正盲审时"没有因果锚"的过度断言〕
- **audit 会静默丢行**:成功路径先写 markdown/`gitCommit` 再 `await appendAudit` → entry 已落盘但 audit 行可能缺;诊断行多为 fire-and-forget `appendAudit(...).catch(()=>{})` → 静默丢。**audit 不是完整事件流。**
- **operation `create` 非 `capture`**;`reactivated` 不是 operation(reactivation = `update` op + `archive_reactivation_apply` 旁路行)。
- **git 历史在另一个 repo**:`gitCommit` 执行 `git -C abrainHome ...`(`writer.ts:662,682-688`),不是 projectRoot。要查 hard delete/历史必须读 **abrain repo** 的 git log 并按 project id 路径过滤。
- **无界增长**:`appendAudit` 是裸 `fs.appendFile`,无 rotation。现有 `sediment/aggregator.ts` 之所以不炸是**只尾读**(`JSONL_TAIL_READ_BYTES=2MB`,`DEFAULT_AUDIT_ROW_LIMIT=500`,`readJsonl` 从 `stat.size-maxBytes` 起读,`aggregator.ts:383-413`)。

### 0.3 P0 实测回填(2026-06-05,`scripts/audit-usability-report.mjs`,见 `docs/audits/2026-06-05-audit-jsonl-usability-p0.md`)
真实数据把上面盲审推断换成数字:
- **完整性好**:project 4254 行 / abrain 107 行,corrupt=0、缺 timestamp=0。
- **churn 可算**:project 208 churn 行(update/merge/supersede)、abrain 11——counts timing-invariant,鲁棒但偏稀疏(低样本)。
- **mutation 100% 可 join slug**,但 `target` 实测 **4 形态**:`project:<id>:<slug>` / **legacy 2-part `project:<slug>`(397 行,早于项目绑定)** / `world:<slug>` / path(`*.md`)+ 独立 `slug` 字段。slug-parser 必须覆盖全部,漏 legacy 2-part 会静默丢 ~40% 历史行。
- **turn_id 是 recency-gated**:project mutation 全量仅 14.1%,但 2026-05-27(ADR 0027 C6)后 ≈100%;abrain 行 **0%**。→ 决策-turn 归因只在近期窗口可靠。
- **session_id / correlation_id**:project mutation ~81%、abrain mutation ~87%(caller 供给,非 anchor 保证)。

→ **结论**:audit 数据源比 timeline 更正确,但远未到"可直接进检索热路径"。**先审计它,再用它。**

---

## 1. 范围

| 纳入 | 明确不做 |
|---|---|
| (a) frontmatter 派生时间/生命周期字段 → **Stage2** | 任何时间信号进 **Stage1 召回门** |
| (b) audit.jsonl **可用性审计报告**(被审计对象) | 把 audit 当检索地基(直到报告证明可用) |
| (c) **retrieval-shadow** 验证(候选 diff + 后验) | full-turn answer replay(无 harness) |
| (后续)audit 抗偏差聚合(churn/merge 链/震荡) | reranker 分数乘子 / 硬 recency-decay / 硬降权 / silent reject / 持久共现图 |

**硬约束**:AI-Native(prompt>机械门控)、第二脑隐形自治、反对 silent reject/硬降权、主会话/检索层不写记忆或 confidence、小步可测先埋 metrics。

---

## 2. 维度判定(3×T0 共识)

| 维度 | 判定 | 形式 |
|---|---|---|
| 生命周期事实(status/superseded_by/derives_from/reactivated 标记) | ✅ 真杠杆,最高 | **Stage2** 字段(frontmatter 直接可得) |
| kind-aware 新鲜度 | ✅ 留但只做**字段** | `staleness_days`/`kind_durability` 进 **Stage2**,不做乘子 |
| churn → caution | ⚠️ 留但延后 | 依赖 audit;过 P0 报告后做;仅作 `why` 证据,**不得作唯一排除理由** |
| 决策震荡/反转链 | ✅ caution-only | `superseded_by` 正向链(单向);反向不可靠 |
| 注意力分布 | 🔶 半装饰 | 只叫 "recently touched",用 audit anchor;延后 |
| 时间共现图 / 成熟度 / cadence / centrality / action-count 排名 | ❌ 砍 | — |

**关于"软提示 ≠ 不降权"(盲审 P1-1,诚实交代)**:`churn_hint=高→"谨慎采信"` 这类 caution 经 reranker **必然压低排名**,效果等同隐形降权,只是从算术洗成 LLM 中介。本设计不自欺:**判据 = caution 只能作为 Stage2 `why` 字段的证据之一,绝不得作为把某条排除/沉底的唯一理由**;reranker prompt 显式声明这一点。可接受的理由:它发生在 Stage2(候选已召回、非选中≠终态、受 prompt 规则约束),而非 Stage1 硬门。

---

## 3. 算法(分两批:frontmatter-only 先行,audit 聚合后续)

### 3A. frontmatter-only(第一刀,无 audit 依赖)
全部从已加载的 `MemoryEntry`(`parser.ts` 已读 `created/updated/status/confidence/frontmatter/timeline`)派生:
```
staleness_days  = round((now - max(updated, timeline 末行时间)) / 86400)
kind_durability = { maxim:90, decision:60, anti-pattern:45, pattern:45, fact:30, preference:30, smell:14 }[kind]  // 天,仅作"这类知识衰减快慢"的事实,不算分
status_caution  = { active:none, provisional:low, contested:mid, deprecated:high, archived:high, superseded:high }[status]
lifecycle       = { superseded_by?:present, derives_from?:present, last_timeline_action:<parse timeline 末行> }
```
maxim 的 `kind_durability` 最大 → 模型在已有 freshness 规则下自行权衡,不被机械压制。

### 3B. audit 聚合(P0 报告通过后才做;离线,不进 search 热路径)
- **读取**:增量/有界 reader,复用 `aggregator.ts` 尾读模式(2MB/500 行起步)+ 保存 `{size, mtimeMs, last_offset, parserVersion}` 游标只读新增 bytes;cache key = `size+mtimeMs+parserVersion`(**不是行数**,行数失效要扫全文)。
- **slug 解析**:从 `target` split(`"<scope>:<id>:<slug>"`),不假设有 `slug` 字段。
- **churn**(timing-invariant,对三偏差鲁棒):
  ```
  mutations = count(operation ∈ {update, merge, supersede})   // 真 audit 词汇;create 是诞生不算 churn
  // reactivation 从 operation=archive_reactivation_apply 推,不是 "reactivated"
  churn_rate = mutations / max(1, lifetime_days)
  ```
  merge 链归因:解析 source archived timeline 行 note(格式 `merged into <targetSlug>: <reason>`,由 `mergeProjectEntries`→`archiveProjectEntry` 写)反推边;**标注此边可信度中等**(依赖 free-text + source 可能已 hard delete)。
- **震荡链**:`superseded_by`(数组,单元素,`supersedeProjectEntry` 写)建**单向 forward** 链;反向(`derives_from`)不保证写,不建。hard-deleted 旧节点只能靠 abrain git 恢复。
- **session/attention**:abrain-lane 无 turn_id → 只用 project-side 行;orphan/缺锚行标为"下界"。
- **残留 bias 必须随输出声明**:`n_hard_deleted: unknown`、`missing_turn_id_rate`、`abrain_lane_no_anchor`、采样偏差(空白≠没关注)、write-time(turn_id=处理轮非决策轮)。措辞禁用 "priority/重要性",只用 "recently touched / 沉淀分布"。

---

## 4. (a) Stage2-only 时间字段(第一刀落点)

**为什么不进 Stage1**(盲审 P0-2,已回查):Stage1 是**硬召回门**——只有被选中的 slug 进 Stage2 重排(picks 过滤 `llm-search.ts:333/380`,未选即永不出结果)。给召回器看 `stale=120d/churn=高`,模型**必然**据此不选 → 这是发生在最有害位置的 silent reject,直接违反硬约束。**因此所有时间信号只进 Stage2。**

**改动点**:`entryForStage2`(`llm-search.ts:456`,紧挨已有 freshness 规则 `:504-506`)的 `pieces[]` 增加:
```
status_caution: <none|low|mid|high>
staleness_days: <n>
kind_durability: <n>d
lifecycle: superseded_by=<...> | derives_from=<...> | last_action=<...>
(churn_hint: <低|中|高>)   // 仅 3B 就绪后
```
Stage2 prompt 增一句:`这些时间字段是证据,不是排除指令;caution 高的条目可降低可信度表述,但不得仅因 caution 高而排除一条语义相关的条目`(对齐 `:506` 已有"不许仅因新就压过 maxim")。

**plumbing 现实**(盲审:非一行改动):`entryForStage2` 入参需带上派生字段,涉及 `entryForStage2` / Stage2 候选构造;3A 全部可从 `MemoryEntry` 现有字段算,不改 `parser`/`MemoryEntry`,不动 Stage1 `buildLlmIndexText`。

---

## 5. (c) retrieval-shadow 验证(降级,full-turn replay 是画饼)

盲审实测:**无 full-turn replay harness**,现有 path-A ledger / `search-metrics.jsonl` 只有 query/hits/injected_slugs/verdict。故验证降级为:
- **retrieval-shadow**:同一 query,baseline vs enhanced(加 Stage2 字段)的**候选/排序 diff** + final selected slugs + 后验(memory-footnote 自报 decisive/confirmatory/unused + 用户是否 3 轮内纠正)。不声称重放最终答案。
- 复用已有 memory-footnote 自报协议(零新增机制)。
- 指标:`stale_decision_avoided` / `late_recall_rate` / `user_correction_within_3_turns` / `noise_injection_rate` / `retrieved_unused_rate`。
- 升级门槛(非统计显著):近 20–30 次 enhanced ≥5 次明确更好、严重误导 ≤1 → 才允许 briefing 升格注入。

---

## 6. 分阶段(重划后的真 MVP)

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **P0 audit 可用性报告** | 有界 reader 读 project+abrain 两路 audit tail,输出覆盖率:missing_turn_id 率 / missing_correlation_id 率 / target-无-slug / operation 分布 / reject 原因分布 / abrain-lane 缺锚率 | 无(只读诊断) | 无 |
| **P1 frontmatter→Stage2(真·周末版)** | §3A 字段进 `entryForStage2`(§4)+ retrieval-shadow 写盘 | 无 audit/git | 局部噪声,Stage2 可控 |
| **P2 audit 聚合(仅当 P0 报告达标)** | §3B churn/merge 链/震荡,离线产 cache | P0 报告 | 中 |
| **P3 briefing shadow** | startup briefing 候选写 `.state`,**默认不注入** | P2 | 无 |
| **P4 升格注入** | 过 §5 门槛后走 time-injector 同类尾部注入(prompt-cache 友好,`time-injector/index.ts`) | §5 门槛 | 注意力污染 |

**真周末版 = P0 报告 + P1 frontmatter→Stage2 + retrieval-shadow 写盘。** 不碰 audit 聚合、不碰 git log、不碰 churn→confidence、不碰 briefing。

---

## 7. 验收 / 不变量(可校验化)

| # | 不变量 | 如何强制 |
|---|---|---|
| 1 | **时间信号 Stage2-only,不进 Stage1** | 代码评审 grep:`buildLlmIndexText`(`llm-search.ts:226`)不得出现 stale/churn/caution 字段 |
| 2 | 新鲜度只做字段不做乘子 | grep:排序路径无时间相关算术乘子 |
| 3 | caution 不得作唯一排除理由 | Stage2 prompt 常量含该句;评审查 prompt |
| 4 | 主会话/检索层不写记忆/confidence | 现有架构已强制(sediment 单写,检索层无写路径)✅ |
| 5 | briefing 升格前必过 shadow 门槛 | `briefing.inject=false` 默认 + 读门槛 metrics 的 gate 函数(非口号) |
| 6 | 措辞禁用 "priority/重要性" | 集中为一处 prompt 模板常量(评审可查),不散落 |
| 7 | 聚合输出必附残留 bias 声明 | 聚合器返回结构含 `bias_notes` 字段,缺则测试失败 |

---

## 附:关键代码锚点(盲审已逐条核实)

- timeline 时间戳:`writer.ts:177,262,403`(+`_shared/runtime.ts:46`)
- session 默认 "sediment":`writer.ts:267`(build)/`588`(update)/`1570`/`2096` ← **原 380 为误,已改**
- timeline 解析:`parser.ts:285`(`splitCompiledTruth`);lint T1–T10:`lint.ts:46-200`
- audit 写入 + 因果锚:`writer.ts:731`(`appendAudit`),`769`(enriched/`spreadAnchor`)
- **abrain-lane audit(不 spread 锚)**:`writer.ts:1625`(`appendAbrainAudit`)
- audit 事件用 `target` 非 `slug`:`writer.ts:915,965,991,1000,1012`
- git commit 在 abrain repo:`writer.ts:662`(`gitCommit`),`682-688`(`git -C abrainHome`)
- 现有有界尾读(P0 reader 参照):`aggregator.ts:383-389,395-413`
- Stage1 硬召回门(picks 过滤):`llm-search.ts:333,380`;index 构造:`buildLlmIndexText` `226-265`(summary 行 `262`)
- **Stage2 插入点**:`entryForStage2` `llm-search.ts:456`;已有 freshness 规则 `504-506`;`timeline_tail` `531`
- 时间比较 UTC 归一:`utils.ts:142`(`compareTimestamps`)
- search 默认只排 archived:`search.ts`(`entryMatchesFilters`)
- 注入参考(尾部、cache 友好):`time-injector/index.ts`
