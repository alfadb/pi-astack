# outcome → classifier 复判反馈闭环 — P2 设计 + liveness 审计 (v2)

**状态**: **已实现 (2026-05-30)**。设计 v2 经 3-T0 Round-1 一致 SHIP 后落地，附 §8 实现记录。
（原为 implement 前的 liveness 审计 + 设计，按
`adr-pipeline-liveness-checks-before-implementation` maxim 先定设计、后写代码。）
**v1→v2**: 经 2-model 盲审（gpt-5.5 REWORK / deepseek-v4-pro SHIP-WITH-FIXES）修正一个 BLOCKING
（跨项目 slug 污染）+ echo-chamber 方向反了 + dead-loop 声明过强。见 §7 review log。
**对应 ADR**: 0025 §4.2.5（outcome 依赖）+ §4.1（classifier confidence 评估）
**ADR 设计意图原文**（0025:865）: "§4.1 unified classifier confidence 评估读最近的 outcome
记录（被纠错过的 entry 更不可信）"
**前置（已 ship）**: outcome-ledger；`readOutcomeLedger` / `summarizeEntryActivity` 读侧 API
（已被 Path B 复用：`memory/index.ts:627-630` 调 + `memory/decide.ts:89/230` 渲染）；
`readProjectOutcomeRows` 项目过滤（`aggregator.ts:476`）；correction-pipeline classifier（§4.1）

---

## 0. 一句话

classifier 判一条新纠错信号时，让它**看到候选 target entry 的 outcome 历史**（按**当前项目**过滤），
由 LLM 自己据此**对 entry 的表面权威打折**（不是抬高纠错可信度）——纯读、读写分离、prompt-native。

---

## 1. Liveness 审计（implement 前必做，证据 grounded）

### 1.1 classifier 当前输入面

`runCorrectionPipeline(branchEntries, relatedEntries, deps)`（`correction-pipeline.ts:218`），prompt 由
`buildClassifierPrompt({windowText, stagingContext, relatedEntries})`（`correction-pipeline.ts:91`）拼。
`RelatedEntryCard`（`correction-pipeline.ts:53-62`）字段 `slug/title/scope/kind/status/summary`，
**无 outcome / trust 字段**——注入点。prompt 里 `=== RELATED MEMORY ENTRIES ===` 块在
`correction-pipeline.ts:124-141`。

### 1.2 wire 点

index.ts:1733-1762：`relatedEntries` 由 `llmSearchEntries` 结果 `.map()` 出 card（1750-1760），
1763 传给 `runCorrectionPipeline`。**enrich 插在 map 之后、调用之前**。index.ts 已 import
`./outcome-collector`（`index.ts:53`），无循环依赖。

### 1.3 可复用读侧 API（不另造）

- `readProjectOutcomeRows(projectRoot, rowLimit)`（`aggregator.ts:476`，目前 aggregator-local）——
  读全局 ledger 后按 `normalizeProjectRoot(row.project_root)` **过滤本项目**。**本设计须复用它**（见 §2.1）。
- `summarizeEntryActivity(rows, slugs, 30)`（`outcome-collector.ts:542`）→ per-slug `EntryActivityStats`
  （`outcome-collector.ts:519`）：`decisive_count/confirmatory_count/retrieved_unused_count/
  decisive_streak/possible_echo_chamber/total_retrievals/last_seen`。
- `possible_echo_chamber = decisive_streak>=5`（`outcome-collector.ts:597`）。**Path B 用法**
  （`memory/decide.ts:230`）："possible_echo_chamber=true → downgrade language to pending
  reconfirmation; do NOT call it a clear/current user preference" —— 即**对 entry 表面权威打折**，
  这是本设计要对齐的正确方向（v1 写反了，见 §7）。

### 1.4 现有消费者（无重复 / 不打架，盲审 VERIFIED）

| 消费者 | 读 | 目的 | 调度 |
|---|---|---|---|
| aggregator（§4.3） | `readProjectOutcomeRows`+趋势 | 跨会话趋势 audit-only | 24h debounce（非 inline） |
| Path B（`memory/index.ts:627`） | `summarizeEntryActivity`+echo-chamber | 决策简报权重 | per-turn 读 |
| **本设计（新）** | 同上，按项目过滤 | classifier confidence 校准 | per-turn 读 |

三者**只读** ledger、各取所需、无写竞争；aggregator 24h debounce 不与 per-turn 读 race。

### 1.5 dead-loop 审计（v2 修正——v1 声明过强）

**无 DIRECT 回路**：classifier 只读 ledger；ledger 只由 `collectOutcomes/writeOutcomeLedger` 在
agent_end 从 memory-footnote / tool-result 喂（`index.ts:1247-1249`，`outcome-collector.ts:271/347`）；
classifier 产出写 staging / curator-context（`correction-pipeline.ts:342-372`），**从不写 outcome 行**。

**但存在 SLOW INDIRECT 回路**（盲审 gpt 抓到）：classifier signal → curator（`index.ts:2284`）→ writer
写/改 entry → 该 entry 日后被检索 → footnote → ledger。这条慢回路不可能完全消除，**靠 prompt 守**：
track-record 是**诊断输入**，**不得单凭它**抬高 durable 纠错 confidence 或反向加固 entry（见 §2.3）。

---

## 2. 设计

### 2.1 schema + wire（BLOCKING fix：按项目过滤）

把 `readProjectOutcomeRows` + `normalizeProjectRoot` 从 aggregator.ts **上提到 outcome-collector.ts**
（共享，避免重复），aggregator 与本 wire 都 import。`RelatedEntryCard` 加可选字段：

```ts
outcome_activity?: { decisive: number; confirmatory: number; retrieved_unused: number;
                     possible_echo_chamber: boolean; last_seen?: string };
```

wire（index.ts ~1761，map 之后）：

```
const slugs = relatedEntries.map(e => e.slug);
let activity = [];
try { activity = summarizeEntryActivity(readProjectOutcomeRows(projectRoot, ROW_LIMIT), slugs, 30); }
catch { /* silent-skip, INV-INVISIBILITY */ }
const bySlug = new Map(activity.map(a => [a.slug, a]));
relatedEntries = relatedEntries.map(e => {
  const a = bySlug.get(e.slug);
  // 只在「真有数据」时附——summarizeEntryActivity 对每个 slug 都返回 zeroed 记录(:558)，
  // 必须用 last_seen / 任一 count>0 区分「有记录」vs「全零」(盲审 P2-2)
  const seen = a && (a.last_seen || a.decisive_count || a.confirmatory_count
                     || a.retrieved_unused_count || a.total_retrievals);
  return seen ? { ...e, outcome_activity: {...} } : e;
});
```

`projectRoot` 由 classifier 上下文的 `cwd` / binding 解析（与 sediment writer 同源）。
**为什么 BLOCKING**：`readOutcomeLedger()` 是 user-global、跨所有项目；`summarizeEntryActivity`
只按 bare slug 匹配（`outcome-collector.ts:565`，slug 经 `sanitizeSlug` 去前缀:75，与 related
slug 同 namespace）。两个项目若有同名 slug（如 `prefer-pnpm-over-yarn`），会把别项目的活跃度
喂进本项目 classifier——静默污染（写侧路径，更危险）。aggregator 已用 `readProjectOutcomeRows`
解决（`aggregator.ts:480`），本设计照抄。

### 2.2 prompt 改动（两处，prompt-native）

**(a)** `relatedBlock`（`correction-pipeline.ts:124-141`）每个有数据的 entry 加一行，例：
`track-record: decisive×0 confirmatory×1 retrieved-unused×4 ⚠️possible-echo-chamber last_seen=2026-05-12`
无数据不渲染该行（或显式 `track-record: (none recorded)`）。

**(b)** `active-correction-classifier-v1.md` Step 5 confidence calibration（~line 201）加**判断指引**
（方向已按盲审修正）：
> target entry 的 track-record 用来**给它的「表面权威」打折**，**不**直接抬高纠错可信度：
> - 高 retrieved-unused 或 ⚠️possible-echo-chamber ⇒ 别把这条 entry 当成「明确的当前偏好」
>   （它可能 stale，或近期 decisive 是助手自我强化而非用户重新确认）；**但 durable 纠错仍需要
>   用户当前话语与 entry scope 的内容冲突作硬证据**——track-record 不替代内容匹配。
> - 高 decisive 且无 echo-chamber ⇒ well-grounded，纠错它需要更强证据。
> **bias caution（加进 Step 0 cautions a-j 同级）**：track-record 是 advisory 不是 ground truth。
> 高 retrieved-unused 可能是 stale，也可能是「领域专用、平时本就少召回」；echo-chamber 可能是
> sycophancy，也可能是用户真的反复确认。永远拿 track-record 去**权衡**、不去**裁决**。

### 2.3 invariant / AI-Native 合规

- **AI-Native**：track-record 是 raw signal，LLM 权衡，无机械阈值 gate 分类（区别于 about-me 0.6）。
- **INV-INVISIBILITY**：纯后台、读失败 silent-skip、无用户面。
- **INV-IMPLICIT-GROUND-TRUTH**：outcome 来自真实 footnote / 检索使用，非预测。
- **dead-loop**：见 §1.5——无直接回路；间接慢回路靠 §2.2 prompt 守（track-record 不单独决策）。

---

## 3. 分阶段

| 阶段 | 内容 | 风险 |
|---|---|---|
| **P2.A（本设计）** | outcome **使用**历史按项目过滤 enrich + prompt 打折指引 | 低：纯读、复用 API、可选字段、silent-skip、项目过滤 |
| **P2.B（follow-on，需独立设计）** | §4.2.5 字面「被纠错过」：读 `audit.jsonl` `operation=correction_classifier && target_entry_slug=slug` 的历史纠错次数 | **中**：回流风险，见 §4-Q2 |

**注意（盲审 P1-3）**：P2.A 的信号是 outcome **使用**模式，**不等于** §4.2.5 字面的「被纠错次数」。
本设计把 P2.A 定位为**互补的信任维度（usage/echo context）**，不宣称它关闭 §4.2.5；§4.2.5 的字面
兑现是 P2.B。

---

## 4. Open questions（implement / P2.B 前必须答）

1. **先 A 还是直接 B**：P2.A 安全可复用、先上积累 dogfood；P2.B 才是 §4.2.5 字面。倾向先 A。
2. **P2.B 回流 dead-loop**：「被纠错 N 次」若推 classifier 更易接受新纠错、而新纠错又 +1 → 自激
   de-trust。守法（盲审强化）：只数 **writer 实际 applied + distinct session + 项目过滤 + typing=durable**
   的纠错，排除 staging/task-local/debug/未落写；且这些计数**只用来触发 review / multi-view 复核，
   不直接抬 classifier confidence**。P2.B 设计必须先解决这条。
3. **windowDays=30 bootstrap**：新项目 / 低频偏好 30 天外 → 永远 (none recorded)，feature 初期近乎
   惰性（盲审 P2-1，可接受）。可考虑 60/90d + `last_seen` 软信号。等 dogfood。
4. **token / 热路径**：related ≤10 条，每条 +一行≈几十 token，`readProjectOutcomeRows` KB 级、try/catch
   silent，无新 LLM 调用——盲审 VERIFIED 无 perf 问题。

---

## 5. Smoke 计划（盲审修正：去机械断言）

扩 `scripts/smoke-classifier-prompt.mjs` + 新 `scripts/smoke-outcome-classifier-enrich.mjs`，断言：
- **项目过滤**：两个项目同 slug，本项目 classifier 只见本项目 outcome（防 §2.1 污染）；
- **向后兼容**：ledger 空 / 读失败 → 不抛、cards 退化为无 outcome_activity、行为同当前实现；
- **渲染**：有数据时 prompt 出现 track-record 行 + echo-chamber 标记；全零时 (none recorded)；
- **质性**（**不**断言 `confidence>=baseline`——prompt 是判断式非阈值）：reasoning_trace 在
  echo-chamber fixture 下提到「对 entry 表面权威打折 / 仍需内容匹配」。

---

## 6. 不做（守 maxim）

- ❌ P2.A 不写任何 classifier→ledger 回写（保 §1.5 读写分离）。
- ❌ 不加「retrieved_unused>N 就降 confidence」硬阈值（§3 红线）——只给 LLM 看。
- ❌ 不让 track-record **单独**抬高纠错 confidence（防 §1.5 间接回路 + 防腐蚀好 entry）。
- ❌ 不动 aggregator / Path B 的 outcome 消费（各自独立，§1.4）。

---

## 7. Review log

**2026-05-30 盲审**（gpt-5.5 high / deepseek-v4-pro high，独立，257s，~$0.20）。verdict:
gpt = **REWORK**，deepseek = **SHIP-WITH-FIXES**。两家**独立收敛**到同一 BLOCKING。已纳入：

| # | 盲审发现 | v2 处理 |
|---|---|---|
| BLOCKING | 跨项目 slug 污染：`readOutcomeLedger` 全局 + slug-only 匹配 | §2.1 改用 `readProjectOutcomeRows(projectRoot)`，上提到 outcome-collector 共享 |
| P1（方向反了） | v1 说 echo-chamber → 纠错更可信，会腐蚀被反复确认的好 entry | §2.2(b) 改为「对 entry 表面权威打折，不抬纠错 confidence，durable 纠错仍需内容匹配」，对齐 `decide.ts:230` |
| P1（dead-loop） | v1「结构性无回路」过强；存在 signal→curator→entry→检索→footnote 间接慢回路 | §1.5 重写，承认间接回路，靠 §2.2 prompt 守 |
| P1（语义） | P2.A 的 usage 信号 ≠ §4.2.5 字面「被纠错过」 | §3 注明 P2.A 是 usage/echo context，不宣称关闭 §4.2.5 |
| P1（P2.B 守法） | 「durable+applied」仍是 classifier 派生非用户确认 | §4-Q2：P2.B 计数只触发 review/multi-view，不直接抬 confidence |
| P2 | summarizeEntryActivity 对每 slug 返回 zeroed 记录 | §2.1 用 last_seen/count>0 区分有数据 vs 全零 |
| P2 | 引用错 `sediment/decide.ts:135` | 全文改 `memory/index.ts:627` + `memory/decide.ts:89/230` |
| P2 | smoke `confidence>=baseline` 机械 | §5 改质性断言 + 项目过滤测 |

**残留**（implement 前可再过一眼，非 blocking）：windowDays bootstrap（§4-Q3）；P2.B 触发门槛量化
（≥60d dogfood + false-positive < 5% 等）待 P2.B 独立设计定。

### 7.1 多轮决策讨论（2026-05-30 Round 1，3-T0）

用户授权「无法决定拉 3 家 T0 多轮讨论」。Round 1（opus-4-8 / gpt-5.5 / deepseek-v4-pro
独立，340s）**三家一致 SHIP**（gpt 从 v1 的 REWORK 改判 SHIP；deepseek 维持 SHIP；opus 新判 SHIP）。
无 verdict 分歧→ 未走 Round 2。结论：**现在实现 P2.A**。三家各钉一条互补的实现约束，合并为下面检查表。

**implement pre-flight 检查表（三家 must-nail-down 合并）：**

1. **（opus）slug 归一一致**：enrich 前用**同一份** `sanitizeSlug` 归一 related slug 与 ledger
   `entry_slug` 再比对。实测：写侧 `entry_slug` 已 sanitize（`outcome-collector.ts:204/322`），llm-search
   返回经 `normalizeBareSlug`（`llm-search.ts:321/327`）也是 bare——两侧**当前已同 namespace**，
   所以这是防御性硬化（防 llm-search 日后改返 scoped slug 造成静默空转）。**伮§2.1 原称
   「经 sanitizeSlug 去前缀」不准：related slug 是因 normalizeBareSlug 而 bare，非 sanitizeSlug。**
   smoke 加一条 scoped-slug related entry 仍命中 bare ledger 行。
2. **（gpt）只用 canonical bound project root**：classifier 路径禁用任何 unscoped `readOutcomeLedger()`；
   只能用 `resolveActiveProject` 后的 projectRoot 调 `readProjectOutcomeRows`；未绑定/读败→不附
   `outcome_activity`。prompt 别把「high decisive → well-grounded」写太硬（防 LLM 把助手自用史
   误读为用户重新确认、固化 stale entry）。同 slug 双项目 smoke 锁死。
3. **（deepseek）ROW_LIMIT 常量 + 防稀释红线**：wire 点定一个明确 `ROW_LIMIT`（per-turn 热路径
   读，不能太大触磁盘、也不能太小截断有意义历史）并注释理据；`outcome_activity` **只在
   last_seen 或任 count>0 时附加**，严禁对所有 slug 零值填充（否则 10 条全零 track-record
   稀释真正有信号的条目）。

## 8. 实现记录（2026-05-30）

三家 must-nail-down 全部落实：
- **共享读侧**：`outcome-collector.ts` 新增 export `normalizeProjectRoot` + `readProjectOutcomeRows`
  + `sanitizeSlug`（canonical 共享版；aggregator 保留其 perf-tuned tail-read 本地变体，未动）。
- **wire**：`index.ts:~1763` map 后 enrich——`readProjectOutcomeRows(cwd, 5000)` 项目过滤、
  两侧 `sanitizeSlug` 归一、只在 last_seen/count>0 时附 `outcome_activity`、best-effort silent-skip。
- **schema**：`RelatedEntryCard.outcome_activity?`（correction-pipeline.ts）。
- **prompt**：relatedBlock 渲染 track-record 行 + 打折指引；classifier prompt Step 5 加方向
  正确的打折指引 + bias caution（对齐 `decide.ts:230`）。
- **smoke**：`scripts/smoke-outcome-classifier-enrich.mjs` 23/23（项目隔离 / 归一 / echo-chamber /
  零值守卫 / 渲染 / 打折指引）。回归：task-local 41/0、aggregator 20/20 + 3/3、memory-sediment
  加载 OK。

**意外收获（pre-existing bug 修复）**：buildClassifierPrompt 的 relatedBlock 原来是
`...args.relatedEntries.map(...).join("\n")`——末尾 `.join("\n")` 把条目拼成一个字符串，
再被 `...spread` **逐字符打散**。意味着 RELATED MEMORY ENTRIES 一直以“每字一行”的乱码
喂给 classifier（上方 stagingBlock 用的是正确的无末尾-join 写法）。本次顺手修复（去掉
末尾 `.join("\n")`）——P2.A 的 track-record 不修这个也形同虚设。
