# ADR 0036: memory_search 两阶段塌缩 + hybrid 检索增强

- Status: Proposed (探索中, dark-launch flag off)
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
| P6 切换 | 金标集 + 21-30 query×3 验证 → 删 stage1 转正 | coverage 接近随机基线 |

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
