---
doc_type: adr
status: accepted
---

# ADR 0035 - memory stage1 从 full-body 全库海选改为 embedding 候选检索(sublinear retrieval)

- **状态**:Accepted(2026-06-13;3×T0 跨厂商盲审 opus-4-8 / gpt-5.5 / deepseek-v4-pro 一致 RATIFY WITH REVISIONS,修订集已并入——§2 安全网双触发 + provider 熔断、§3 证据正偏披露 + 端到端 oracle 列为转产硬门、§4 content-hash 失效 + embedding-model 版本戳 + freshness 原子协议。设计基线,未实现)。
- **依赖**:[ADR 0015](0015-memory-search-llm-driven-retrieval.md)(已 archived,机制 ingest 入 abrain;本 ADR **supersede 其 stage1 候选面决策**,对应 abrain slug `stage1-uses-full-body-candidate-surface` 与 `full-body-stage1-prioritizes-recall-over-cache-compactness`,但**保留**其双阶段框架 `two-stage-search-separates-recall-from-precision`、result-cache 禁令 `result-cache-breaks-memory-freshness`、freshness 契约 `fresh-search-surface-preserves-new-entry-recall`、accuracy-is-contract 立场)、[ADR 0003](0003-main-session-read-only.md)(主会话只读 / sediment 单写,embedding 增量写归 sediment 侧)。
- **触发**:2026-06-13 stage1 候选面从 frontmatter 索引切到 `full_body_v3`(把全库 active entry 全文塞进一个 flash prompt),当天即引入 O(库规模 × 搜索频率)成本回归——sub2api `usage_logs` 实测单日 deepseek-v4-flash 104 次 search、5290 万 token、$7.97 ≈ ¥57;prefix KV cache 命中率从 frontmatter 时代的 99.8% 崩到 12.5%(每次 fresh 生成 + sediment 每 agent_end 写入打散 prefix)。该切换直接违背既有 anti-pattern `whole-vault-llm-recall-does-not-scale`(全库 LLM 召回在 1000+ 条崩溃),而库已 2215 条 active / ~184 万 token。
- **反方向澄清**:不走"库治理压缩"(归档/删除低价值条目去缩小候选面)——违背第二大脑自我演化原则(`knowledge-base-self-evolving`),且自我演化保证库高质量但不保证库变小(2215 → 未来上万),检索架构本身必须 sublinear。

---

## 1. 问题:full-body stage1 是 O(库规模) 的成本回归

ADR 0015 的双阶段检索本身正确:stage1 高召回粗筛、stage2 高精度精排。问题出在 stage1 的**候选面**实现。`full_body_v3` 把全库所有 active entry 的 `compiledTruth + timeline` 拼成单个 prompt 发给 stage1 模型(deepseek-v4-flash),让它读完全库选候选。其成本 = O(库规模 × 搜索频率),与 query 无关:库越大、搜索越频繁,每次都重读整库。queryRewriter 输入有 ~3KB cap、stage2 只读候选,均非成本源;唯一失控点是 stage1 候选面。

frontmatter 索引被换掉的理由(召回准确率不足)是真实的——`full-body-stage1-prioritizes-recall-over-cache-compactness` 记录了这次为召回牺牲紧凑性与缓存的取舍。但代价被低估:full-body 把召回问题用"喂全库给 LLM"解决,这正是 `whole-vault-llm-recall-does-not-scale` 标记的 anti-pattern 的更激进版(全文而非 summary)。两条既有记忆在系统内自相矛盾,本 ADR 解开这个矛盾。

注:本设计**不恢复 KV cache**(盲审澄清)。top-N 每 query 不同,stage1 前缀仍变,cache 命中不会回到 99.8%。省钱来自候选面 token 体量从 O(库) 砍到 O(N) 的 ~20× 缩量,而非 cache 复活——不得把 cache 复活当卖点。

## 2. 决策:stage1 候选面改为 embedding 向量检索 + 精确字段 hybrid,候选集再交 LLM 精选

把 stage1 从"全库 LLM 海选"拆成 **stage0 向量粗召回 + stage1 LLM 精选小候选集**,stage2 不变。数据流:

`query → embedding → 余弦 top-N 候选池(+ 精确字段 sparse 补盲) → full-body 仅喂这 N 条给 stage1 LLM 精选 → stage2 精排`

- **dense 主召回**:query 与每条 entry 各算一个向量,余弦相似度取 top-N。成本 O(N) 与库规模解耦——库从 2215 涨到上万,stage1 喂给 LLM 的 token 不变。
- **hybrid 补盲**:embedding 对否定 / 反义 / 罕见专名(ADR 编号、函数名、错误码、slug)/ 极短 query 有盲区,用 trigger_phrases / slug / 精确字段做字符级 sparse 信号融合(如 RRF 或加权 boost),不作主召回、只补漏。
- **候选集 N**:初始取 **100**(见 §3 实测,related-recall 98.0%);N 是召回/成本旋钮,灰度期 A/B 收敛(初始值非定论,正式收敛准则见 §7)。
- **embedding 模型可配置、首选 doubao-embedding-vision**:架构决策是"stage1 候选面走向量检索",embedding provider 是可替换实现参数(settings 配置)。首个落地选 doubao-embedding-vision——当前 sub2api 上游唯一现成可达(方舟 Coding Plan,Bailian/阿里删除、gemini 不可调度、无真 OpenAI apikey),走订阅而非 metered,实测召回达标(§3)。长期可替换为 text-embedding-v4(需恢复 Bailian)或 Gemini Embedding 2(cross-lingual 公榜更强),provider 切换不改架构。**须先核实方舟 Coding Plan sub2api ToS 是否限定 coding 工具用途**——若禁后台 / agent-memory 用途(参照 GLM Coding Plan 同类 caveat),则首选回退到恢复 Bailian text-embedding-v4。

## 3. 证据:在 2215 条真实第二大脑语料上实测召回

ground truth 用 entry 间已声明的 `derives_from` / `related`(系统/sediment 沉淀的语义关联,1234 entry / 1576 关联)。doubao-embedding-vision(dim 2048)全库 embed 后:

- **related-recall**:top-10 = 80.8%、top-25 = 91.8%、top-50 = 95.8%、**top-100 = 98.0%**、top-200 = 98.7%。
- **self-retrieval**(title 召回自身):top1 = 96% / top5 = 100% / MRR = 0.981。
- **真实 query 定性**(path-a-ledger,中英混合):多条 query 的 top-8 主题对口,中文 query 准确召回中英混合标题条目,跨语言语义对齐成立。

**方法论诚实边界(盲审强化,三家一致指出)**:related-recall 用 `derives_from/related` 作 ground truth 存在**系统性正偏**——这些关联常因两条 entry 文本/主题相近才被 sediment 建立,embedding 也正抓相近性,构成**循环自证**;且关联条目多同期同批写入、共享词表,比真实改写 query 的 surface gap 小。故 98%@top-100 是**乐观上界**,端到端真实召回会更低。self-retrieval(title→自身)因 body 含 title 而 trivially 高,未测 paraphrase;真实 query 仅 N=5 定性、无 ground truth。**结论**:三角证据足以支撑"方向成立、值得投实施",但**不足以单独作为转产依据**;端到端 full-body stage1 picks oracle 列为**灰度转产硬门**(§7)。另:验证脚本 `[:3500]` 截断使长 entry 尾部(timeline / supersede 记录)未入向量,是未披露盲区,实施须解决(见 §7 单/多向量)。

## 4. 不变量(必须守,违反即设计失败)

- **freshness 守恒(原子协议,盲审强化)**:新建 / 更新 entry 必须下次 search 立即可召回。机制写成协议而非口号:(a) sediment 写 entry 与写 dirty-manifest 同事务 / 原子落盘;(b) 每次 search union dirty-manifest + mtime 扫描未索引 entry,确保 crash-in-between 不漏;(c) embedding 成功后原子替换索引并清 dirty;(d) embedding API 临时失败时该 dirty entry 直接 union 进候选池兜底,绝不"等索引就绪"而漏召。保留 ADR 0015 `fresh-search-surface-preserves-new-entry-recall`。
- **索引一致性(盲审新增)**:向量按 **content-hash(`compiledTruth + timeline`) keyed 失效**,非仅 keyed-by-slug——entry 仅改 status/confidence 等元数据时**不** re-embed(省 API),内容变才失效重算;陈旧 slug 向量不得残留。索引带 **embedding-model 版本戳**:provider / model 变更时强制整库重 embed,**禁止跨模型 query 向量与库向量混用**(否则静默污染相似度)。
- **非 result cache**:缓存的是 **entry 向量**(随内容 hash 变化而失效),不是 query→slug 结果列表。守 ADR 0015 `result-cache-breaks-memory-freshness`——向量索引不隐藏新写入条目。
- **accuracy-is-contract(安全网双触发,盲审补漏)**:召回不可静默退化。**仅靠 stage2 verdict=none 回退不够**——最危险失败是正确 entry 落在 top-N 外、stage2 从池内挑了似是而非条目并判 has_relevant,**静默掉召**。故安全网**双触发**:(a) verdict=none;(b) 候选池信号不足(stage2 max 相似度低于阈值 / 显式 `insufficient_pool` 信号),并埋 best-entry-rank 探针监控。回退**不得无界**:加预算 / 采样 / 限流 / 熔断,只在高风险信号触发,防恶意或 provider 劣化 query 把回退放大成 O(库) 在线常态。
- **零 npm 运行时依赖**:向量存 abrain `.state` 下 JSON/JSONL,余弦用纯 JS,embedding 走 provider HTTP API。不引入 faiss/chroma 等 native 库。2215 量级线性扫(~18MB 矩阵)可忽略;上万条时瓶颈是矩阵加载/解析 I/O 而非计算,届时评估 JSONL 增量 / 分桶 / 预归一化(纯 JS 可行约到 5 万条)。
- **自我演化不被外部干预**:不靠归档 / 删除压缩库规模来降本;降本来自检索架构 sublinear 化,库治理仍由 sediment 自主演化(update/merge/split/archive)负责。

## 5. 设计张力与取舍

- **embedding 盲区 vs hybrid 补盲**:dense 漏否定 / 反义 / 精确符号 / 短 query;取舍是 sparse 精确字段 + stage1 LLM 候选池二次过滤 + 安全网回退三重兜底,不追求 dense 单通道完美。
- **doubao 无公开 benchmark vs 自有语料实测**:doubao-embedding-vision 无公开 CMTEB / cross-lingual 榜(vendor-reported),违背"独立验证优先";取舍是用本仓真实中英语料实测(§3)替代公榜,且 provider 可替换,锁架构非锁模型。
- **单 provider 依赖 vs 可用性(盲审关键纠正)**:首选 doubao 走方舟 Coding Plan 单路。**provider 宕机时不得回退全库 full-body stage1**——那与安全网是同一条 O(库) 路径,故障期 100% search 撞回旧回归 + 多付 embedding 超时,比现状更糟。改为 circuit-breaker:宕机期用磁盘已持久化向量继续 dense 检索(仅新 entry 走 dirty-union),禁止把 provider 故障转成 O(库) 成本回归。provider 配置化便于长期切换。
- **新增常驻状态与写入路径复杂度**:引入向量索引常驻文件 + sediment 写入路径加一步 embed(新失败模式);取舍是这是 sublinear 的必要结构成本,用 write-time 增量 + content-hash 跳过 + dirty union 把失败模式收敛为"短暂多召"而非"漏召"。
- **每 search 多一次串行 embedding 往返**:交互延迟增加;取舍是 query embed token 小(~600)、延迟须在灰度量化并设阈值,劣化即熔断降级。

## 6. 接受的代价 + 走偏信号

接受的代价:(a) 一份常驻向量索引(~18MB@2215,随库线性增长);(b) sediment 写入路径多一次 embedding 调用与失败处理;(c) 对 embedding provider 可用性依赖(熔断降级而非全库回退);(d) 召回从"LLM 全库语义判断"退为"向量近似 + LLM 精选",理论上限略降,用 hybrid + 安全网补偿;(e) 每 search 一次 query-embed 网络往返延迟。

走偏信号(触发即回看本决策):灰度监控 related-recall 或端到端 oracle 召回跌破阈值(如 top-100 < 95%);stage2 verdict=none / insufficient_pool 触发率显著上升;best-entry-rank 探针显示正确条目频繁落 N 外;embedding API 失败率 / 延迟劣化拖累交互;dirty-union size 超总条目 5%;用户报告"以前能搜到现在搜不到"。

## 7. 依赖与后续

- **实施计划**(分阶段:embedding 基建 → stage1 改造 → A/B 灰度 → 切换 → 旧 surface 下线)归 [`roadmap.md`](../roadmap.md),不在本 ADR 正文展开。
- **转产硬门(盲审设定)**:灰度期必须用 **full-body stage1 picks 作端到端 oracle** 逐 query 对照,确认端到端召回不掉,方可全量切换——related-recall 因 §3 正偏不可单独作转产依据。
- **代码改动点**:`buildLlmIndexText` 从接收全库 `MemoryEntry[]` 改为接收 stage0 top-N(接口近零改动);`STAGE1_CANDIDATE_SURFACE` 与 `search-metrics.jsonl` 的 `stage1_surface` 字段同步;`verdict=none / insufficient_pool` 回退分支当前代码**未预埋**,须在 `llmSearchEntries` / `llmSearchEntriesWithVerdict` 两处新增;sediment curator 复用同一 search 内核,自动受益。
- **待定参数**(交灰度收敛):候选集 N(初始 100,给 A/B 收敛准则);hybrid 融合权重与 sparse 字段集;embedding provider 长期选型(doubao 现成 vs 恢复 Bailian text-embedding-v4 vs 启用 Gemini);向量存储格式(单文件 JSON vs JSONL 增量 vs abrain-state sqlite,含 >5000 条迁移路径);单向量 vs 多向量(title / body chunk / timeline 分离,解决 §3 截断盲区)。
- **观测**:`search-metrics.jsonl` 增 stage0 字段——候选池命中、回退触发率、best-entry-rank、dirty-union size、query-embed 延迟,为灰度 A/B 与走偏信号供数据。
