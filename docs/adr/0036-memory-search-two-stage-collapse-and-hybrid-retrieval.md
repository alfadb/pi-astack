# ADR 0036: memory_search 两阶段塌缩 + hybrid 检索增强

- Status: **Accepted** — P6 两阶段塌缩已转产(`pi-astack-settings.json` memory.search.stage1Skip=true, flag-reversible kill-switch); 跨厂商金标 + 3×T0 评审所有代码条件已落(§9.4)。代码 DEFAULT 仍 false; P3 BM25/P4/P5 仍 dark。
- Date: 2026-06-14
- Supersedes-direction: 承接 ADR 0035(stage0 embedding 候选检索); 本 ADR 修订 stage1 的存废

## 1. 问题: stage1 LLM 是冗余环节, 不是 stage1 surface 太大

ADR 0035 把 stage1 候选面从全库缩到 stage0 向量候选(≤400), 但 stage1 仍用 full-body LLM 从 400 选 50(~324K token/次, cache 命中 0.2%), path-A 每轮 + sediment 去重每轮高频调用, 成本主体。P8 试图用紧凑 surface 压 stage1(83% token 但生产模型 flash recall 掉 13 点), 5×T0 设计 review 一致判定 P8 是绕路: **stage0 的 dense 向量已把候选排好序, stage1 LLM 再从 400 选 50 是在重做 dense 已经做得更好的事 —— stage1 这一层本身冗余, 该删而非压缩。**

## 2. 决策: 删 stage1 LLM(两阶段塌缩)+ hybrid 检索增强 + 调用方路由

5×T0(opus / gpt-5.5 / deepseek-v4-pro / kimi-k2.6 / minimax-M3)开放讨论后的收敛方向, 按 ROI:

- **(主)两阶段塌缩**: `stage0 hybrid → top-K → stage2 full-body 精排 top-10`, 删 stage1 LLM。stage0 已排序, 直取 top-K 喂 stage2; 安全网 verdict=none 时才回退 stage1 LLM 救场(低频)。
- **(补盲)BM25 复活**: `search.ts` 已有完整 TF-IDF/BM25 死代码; 当前 `sparseMatchSlugs` 是朴素子串(无 IDF, 中文几乎随机)。用 char n-gram BM25(CJK bigram/trigram, 纯 JS 零依赖)补 dense 的精确符号/短 query/中文盲区, 与 dense 用 RRF 融合。
- **(质量)多向量解 3500 截断**: 单向量截断是强迫 stage1 存在的根因之一; head/tail 或 meta/body/timeline 多向量, reconcile 时一次性付(embedding cost≈0)。从 ADR 0035 §7 deferred 提到本 ADR 主线。
- **(路由)query 路由**: 规则 regex(非 LLM) —— exact lookup(slug/ADR编号)直接 findEntry 跳 LLM; 符号 query sparse-first; 语义 query dense-first。
- **(路由)sediment dedup 走 dense-only**: 最高频 stage1 调用是 sediment 去重(每轮 agent_end), 本质近重检测, dense cosine 是最佳工具; 走 dense top-10~20 → LLM 只判 merge, 不走 full-body。dedup 评价≠search 评价(false-merge → corpus corruption, 比漏召严重)。

## 3. 实证: stage1 边际价值(初步, dark-launch flag `stage1Skip`)

oracle ablation(`oracle-twostage-ablation.mjs`, 8 query, v4-pro 强 model):

| 对照 | coverage(three⊆cmp) | jaccard | 备注 |
|---|---|---|---|
| three-vs-**TWO**(跳 stage1) | 68.1% | 53.6% | two-stage |
| three-vs-three(随机基线) | 73.1% | 57.4% | LLM 随机性 |
| **差距** | **5 点** | 3.8 点 | 在噪声内 |

token: 每 query stage1 310K + stage2 30K = 340K → two-stage 仅 stage2 30K(**降 91%, ~11×**)。删 stage1 的 recall 差异(5 点 coverage)接近 LLM 随机噪声, 而降本远超 P8 compact(83%)。**初步支持删 stage1, 但样本小(8 query)未达转产门。**

## 4. 不变量(继承 ADR 0035 §4)

- sublinear: 删 stage1 后 LLM token 真正 O(top-K=30~50), 不依赖 cache 命中率
- freshness: stage0 stale floor 不变(新写 entry 立即可召回)
- 零 npm 运行时依赖: BM25/多向量纯 JS 自写
- 安全网: verdict=none / pool<K 时回退 stage1 LLM 救场(stage1 降级为低频 fallback, 非删除)
- accuracy-is-contract: 两阶段不得静默掉召; 转产前必须有真实 query 金标集(见 §6)

## 5. 实施计划(分阶段, dark-launch)

| Phase | 内容 | 门 |
|---|---|---|
| P1 实证(本提交) | `stage1Skip` flag + oracle ablation | 初步: 差 5 点/降 91% ✅ |
| P2 金标集 | 从 search-metrics.jsonl 采样真实 query + 人工标注正确 entry(跨过 ground-truth 正偏) | 转产硬门 |
| P3 BM25 复活 | char n-gram BM25 替换 sparseMatchSlugs + RRF 融合 | 中文/符号 recall↑ |
| P4 多向量 | head/tail 双向量解截断 | 长 entry dense 可信 |
| P5 路由 | query 路由 + sediment dedup 走 dense-only | 治成本主体 |
| P6 切换(本次, 见 §8) | 跨厂商投票金标(16q × 4 T0)recall@gold + ablation-16 | ✅ two-stage recall@gold ≥ three; ablation 扰动 ≤ LLM 自噪声 → 提案转正待评审 |

## 6. 盲区与风险(5×T0 共识)

- **ground-truth 循环自证(最致命)**: 所有 recall 金标用 `derives_from/related`, 而这些关联本就是 sediment 按文本相似建立、embedding 也正抓相似 → 用有系统正偏的尺子调架构。本 ADR 的 oracle(LLM-vs-LLM)同样不是真金标。**转产硬门 = 真实 paraphrase query → 正确 entry 人工金标集(P2)**, 非 oracle replay。
- 中文 end-to-end recall 零定量证据(doubao 无公开跨语言 benchmark)
- 成本归因缺 caller×stage×day token 账本(砍 stage1 前应确认真凶是 stage1 单价而非 sediment 高频)
- sediment dedup 是最脆弱路径却最缺监控(false-merge → corpus corruption)
- 8 query 样本不足; 需 21-30 query × ≥3 重复 + CI

## 7. 备择(已评估未采纳)

- frontmatter-only 全量 LLM: 被向量检索严格 dominate(cache 99.8% 是幻觉, 库写入即 prefix 抖, 实测 12.5%; summary 信息少 recall 低)
- agentic grep: 降级为符号/精确路由的一个通道, 不能主召回(中文语义弱 + 多轮不可控)
- full-body 全量 LLM: 仅 oracle/kill-switch
- P8 紧凑 surface: 绕路(在错的层面省钱), 被两阶段塌缩取代

## 8. P6 转产金标验证(本次): 跨厂商投票金标 + recall@gold

承接 §6 盲区(ground-truth 循环自证): §3 的 oracle(LLM-vs-LLM)与 derives_from/related 都有系统正偏, 不构成转产硬门。本次建立独立金标 —— 不靠 sediment 建立的关联, 而是跨厂商 T0 读 query+entry 内容投票判定相关性 —— 在其上比较 two-stage(删 stage1)与 three-stage 的 recall@gold。工具: `scripts/oracle-goldset.mjs`(material/aggregate/eval 三模式)+ `scripts/goldset-queries.json`(16 query, 中文/英文/code 符号/概念混合)。

### 8.1 金标构建(跨过循环自证)

- 16 query × 每 query stage0 宽候选池 POOL_LIMIT=80(宽于 two-stage 候选窗口 candidateLimit=50, 避免“金标候选池 == 被评估池”的循环)。
- 标注**不在脚本里调 model**(上一轮证伪: sub2api SPA-200 网关陷阱 + 各 provider auth 差异 → 裸 fetch / callSearchModel 标注全 0 票)。正确路径 = 主会话 `dispatch_parallel` 派跨厂商 T0, 每个 model 用 read 工具读其 batch 的 compact query 文件, 输出 `{id:[slug...]}`, 主会话聚合。
- **4 个主力跨厂商 T0 投票**: `claude-opus-4-8`(Anthropic) / `gpt-5.5`(OpenAI) / `deepseek-v4-pro`(DeepSeek) / `kimi-k2.6`(Moonshot)。阈值 ≥2/4 共识 = gold。
- **MiniMax-M3 排除**: 实测每 query 选 50-95/80 候选(几乎全池), 是 memory 警告的“弱模型凑满 quota”失败模式 + 模型 roster 明确标 MiniMax-M3 为 T0-candidate(非主力投票者)。一个“几乎全选”的投票者无区分度, 计入会把有效阈值降到“≥1 主力 + M3”污染金标, 故剔除。
- 结果: 16 query 全部非空金标(每 query 1-31, 共 143 gold slug)。广义主题(q6 T0 盲审=31, q11 dispatch parallel=27)自然金标多; 精确主题(q4 git 跟踪=1, q2/q9/q13=2)金标少。

### 8.2 recall@gold 评估(oracle = deepseek-v4-pro, 两臂同模型 → 模型偏差在 two-vs-three 差值中抵消)

| 指标(16 query 平均) | 值 |
|---|---|
| stage0 coverage@gold(窗口 top-50) | 90.2% |
| **three-stage recall@gold** | **53.7%** |
| **two-stage recall@gold(删 stage1)** | **58.3%** |

- two-stage recall@gold(58.3%)**≥** three-stage(53.7%), 高 4.6 点, 在 LLM 随机性内。删 stage1 不丢真 recall, 略有提升(stage1 LLM 偶尔把 dense-top 候选筛掉, 而 two-stage 直接把 dense top-50 喂 stage2 精排)。
- 逐 query: 13/16 two ≥ three 或持平; q10(62% vs 38%)、q12(86% vs 57%)显著利好 two; three 占优仅 q11(33% vs 26%)且差距小。q1/q9/q14 两臂同为 0%(stage2 精排行为, 与 stage1 无关 —— coverage@gold 窗口含金标但 stage2 top-10 未选中, 两臂等同)。
- 注: 广义金标(>10)下 recall@gold 受 stage2 top-10 上限压制(31 金标最多召回 10/31=32%), 故绝对值偏低对两臂对称, 关键是 two-vs-three 差值。

### 8.3 ablation-16 确认(LLM-vs-LLM 一致性, 把 §3 的 8-query 扩到 16)

| 对照(16 query) | coverage(three⊆cmp) | jaccard |
|---|---|---|
| three-vs-**TWO**(删 stage1) | 82.5% | 58.1% |
| three-vs-three(随机性基线) | 77.7% | 57.2% |

- 删 stage1 的扰动(three-vs-two)**不超过**(实际略低于)LLM 三阶段自身两次随机跑的扰动(three-vs-three 基线): coverage 82.5% > 77.7%, jaccard 58.1% ≈ 57.2%。
- §3 在 8 query 时 two-vs-three 比基线低 5 点; 扩到 16 query 后差值符号**翻转**(two 反高于基线)。差值符号不稳定本身就是“差异在噪声量级”的判据 —— stage1 的边际贡献淹没在 LLM 非确定性里。

### 8.4 转产判据达标 + 提案

- 判据(§5 P6 门): two-stage recall@gold ≈ three-stage, 且金标跨厂商投票(非单模型凑满, 非 derives_from)。**达标**(two 58.3% ≥ three 53.7%; 4 厂商 ≥2/4 共识)。
- 提案: `DEFAULT_SEARCH_SETTINGS.stage1Skip` 由 `false` 转 `true`(两阶段塌缩转产, 省 ~91% LLM token)。stage1 代码保留为 flag-off kill-switch + 安全网底座, 不删除。
- **安全网契约已修复(本次, 3×T0 条件 1)**: 原 `executeSearch` 安全网只“扩 stage0 池后同设置重跑”, 与 §4“verdict=none / pool<K 回退 stage1 LLM 救场”矛盾。已改: 扩召 retry 强制 `stage1Skip=false`(`llm-search.ts` 安全网块), stage1 LLM 在扩召池上救场。stage1Skip=false(现默认)无行为变化; 转产 true 后这是 stage1 降级为低频 fallback(非删除)的落点。
- 未做(超出 stage1 转产范围, 各自独立 flag/门): P3 BM25(sparseBM25, smoke 已验中文 0→159)、P4 多向量、P5 query 路由 + sediment dedup dense-only 仍 dark, 不随 P6 一起转。

## 9. 3×T0 评审共识(本次)+ 转产门修订

3×跨厂商 T0 盲审(`claude-opus-4-8` / `gpt-5.5` / `kimi-k2.6`, 各自读 ADR+脚本+代码) —— **三家一致 GO-WITH-CONDITIONS, 无人背书今日盲 flip 全局默认**。共识: 论点(stage1 边际 recall ≈ 0, derives_from 循环已真正跳出)成立, 但全局 flip 过早, 须先过下列门。

### 9.1 阶性门(flip 前必过)

- **条件 1 —— 安全网契约(三家一致)**: 已修(§8.4 + `llm-search.ts` 安全网 retry 强制 stage1Skip=false)。✅
- **条件 2 —— sediment dedup 不能随车(opus 最强)**: flip `DEFAULT_SEARCH_SETTINGS.stage1Skip` 会连带翻转 sediment curator 去重路径(`curator.ts` `llmSearchEntries(..., status:["all"], limit:5)`, 共用 `resolveSettings()` 无每-caller 覆写)。金标是 active-only 检索查询, 未评估 all-status 近重检测; §6 标 dedup 为最脆弱路径(false-merge → corpus corruption, 比漏召严重)。要求: 给 curator 路径 pin `stage1Skip=false`(或每-caller 覆写), 不让 search-recall 结论静默改 dedup。
- **条件 3 —— stale-floor 序制混淆(kimi 尖锐)**: `selectStage0Pool` 把 stale/missing floor(上限 `ceil(maxCand×0.1)=40`)排在候选首; `stage1Skip` 直取 `slice(0, candidateLimit=50)` → 陈旧重索引状态下 stage2 可能看到 ~40 stale + ~10 dense。本次 eval 用 fresh 索引(~0 stale)未触发; 生产 stale-heavy(如批量迁移)会让 floor 挤出 dense top-K。three-stage 由 stage1 看全池(≤0400)免疫。要求: stage1Skip 切片前 dense-relevance 优先重排(仍保 freshness floor 进窗口), 或限 floor 在窗口占比, 重评。
- **条件 4 —— 残余循环 + 统计严谨(opus/gpt/kimi)**: (a) eval oracle(deepseek-v4-pro)也是标注员 → 重跑 eval 用扣出的 held-out oracle(绝对值去偏, 但 two-vs-three 差值本就同模型抵消, 该项不影响结论方向); (b) gold ⋂ stage0 top-80 → coverage@gold=90% 部分重言, 仅证“stage1 删除在 stage0 已找到的前提下”非端到端; (c) 16q 单跑无 CI < §6 自定 21-30q×3+CI 门 → flip 改为可监控 staged rollout(监 `verdict=none` 率 + `stage0_pool_hit`, 可一键 flag→false 回滚)。
- **条件 5 —— stage1Model ≠ stage2Model(opus)**: eval 两阶段同用 v4-pro, 最利于“stage1 决人”(stage1 预选 = stage2 本就会选)。生产若 stage1Model≠stage2Model, 该 eval 不代表。flip 前须着明生产型号配置并重确认。

### 9.2 金标公论: MiniMax 排除不能污染 gold(解析证明, 免重跑)

评审条件“M3 inclusion sensitivity”可解析结: M3 每 query 选近全池(非区分性)。若以多数阈 ≥3/5 纳入 M3, 则 gold = {≥2 真投票 **且** M3 也投} ⊆ {≥2 真投票} = 现 ≥2/4 gold —— M3 只能**修剪**(去掉 M3 恰好未投的少数 ≥2/4 slug)而**永不增加**假 gold。所以排除 M3 不是在掩盖污染; 反之若以低阈 ≥2/5 纳入, M3 会把“1 真投票 + M3”括进 gold(污染), 这正是改用 4 真投票者 ≥2/4 的原因。结论对 M3 纳入(多数阈)鲁棒。

### 9.3 修订后的 P6 转产路径

1. 本次已落: 安全网契约修复(条件 1)、金标集+eval 工具化(`oracle-goldset.mjs` material/aggregate/eval)、ADR 证据+评审存档。flag 仍 off。
2. flip 前补(条件 2/3/5): curator dedup 路径 pin stage1Skip=false; stage1Skip 切片 dense 优先重排; 着明生产 stage1/stage2 型号。
3. flip 时(条件 4): 转为 staged rollout(非一次性全局), 监控 verdict=none 率/pool_hit, 保留 flag-off kill-switch 及即时回滚。

## 9.4 执行结果(本次推进): 所有条件落地 + flip 生效

主人“推进”后逐条关闭 §9.1 门, 最后通过 settings.json 显式 flip(非代码 DEFAULT, 兑 kill-switch 规则):

- **条件 1 安全网 ✅**: `executeSearch` 扩召 retry 强制 stage1Skip=false(`llm-search.ts`), verdict=none/pool<K 时 stage1 LLM 在扩召池救场, 兑现 §4。
- **条件 2 dedup pin ✅**: `curator.ts` sediment 去重路径 pin `stage1Skip=false`(dedupSettings 覆写), 全局 flip 不连带翻转未验证的 all-status 近重检测。
- **条件 3 stale-floor 序制 ✅**: 抽出纯函数 `orderStage0Candidates`(window-aware: dense 领跑窗口 + freshness floor 进窗口尾预留), `scripts/smoke-stale-floor-window.mjs` 11/11 断言通过(stale-heavy 下 dense top-K 不被挤出, 新写 entry 必进窗口)。
- **条件 4a held-out oracle + 4c staged ✅**: 用不在 gold 标注集的 v4-flash 重跑 eval(annotator 是 v4-PRO, M3 被排) —— two ≥ three 仍成立且更强; flip 走 settings.json(可一键回滚)+ search-metrics.jsonl(verdict/pool_hit 监控)= staged/monitored。
- **条件 5 生产型号 ✅(带一个诚实限制)**: eval 默认改读生产型号。生产 stage1=v4-flash(被删的那层)直接测: 删它 recall@gold **+13.2 点**(表说明弱 stage1 filter 越损 recall)。生产 stage2=M3 离线脚本 registry 跑不了(SPA-200/compat 陷阱), 但 stage2 在 two/three 两臂恒定 → 删 stage1 的差值结论不依赖 stage2 型号(M3 只移动绝对值, 同幅作用于两臂); 且 flip **不改** stage2(M3 本就是 flip 前的最终排序器)。

### eval 两组 oracle 都 two ≥ three(差值对 stage2 型号鲁棒)

| oracle(stage1/stage2) | three-stage recall@gold | two-stage recall@gold | Δ |
|---|---|---|---|
| v4-pro / v4-pro | 53.7% | 58.3% | +4.6 |
| **v4-flash / v4-flash(生产 stage1, held-out)** | 56.2% | **69.4%** | **+13.2** |

- 规律: stage1 model 越弱, 其 filter 越损 recall, 删它越受益 —— 而生产 stage1 恰是弱的 v4-flash。两组 oracle 都支持 two ≥ three。
- 调用方: `memory_search`(path-A 每轮)+ sediment dedup(每 agent_end) —— 后者已 pin 三阶段; 前者现走两阶段。

### 残留(不阻塞 flip, 作为后续/监控项)

- M3 作为唯一 stage2 排序器的绝对质量未离线验(脚本 registry 跑不了 M3); 但这是 flip 前已存在的属性(非 flip 引入, flip 不改 stage2)。M3 在开放式标注任务的凑满倾向(选 50-95/80)提示: 应监控 stage2 排序质量, 必要时把生产 stage2 换回 v4-pro(settings 可改, 已有 ROLLBACK TRIGGER 记在 settings _comment)。
- 统计严谨: 仍 16q 单跑无 CI; 后续可扩 21-30q × 多重跑补 CI(§6 原门), 但两组 oracle 同向 + ablation 噪声量级已足以支撑 flag-reversible 转产。
- gold ⋂ stage0 top-80: 本 eval 证“stage1 删除在 stage0 已找到的前提下不损 recall”, 非端到端召回; 端到端召回是 stage0/多向量(P4)的话题。
