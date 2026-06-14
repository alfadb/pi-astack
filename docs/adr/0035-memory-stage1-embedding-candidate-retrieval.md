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

- **freshness 守恒(P2 盲审修订 2026-06-14,方向 B)**:新建 / 更新 entry 必须下次 search 立即可召回。**P2 实现裁决**:当前 search 全量 `loadEntries`(所有 active entry 已在内存),故 freshness 由 **search-time content-hash diff** 保证——对每条已加载 entry 算 `contentHashOf`,与索引向量的 hash 比对,`!isFresh`(新写 / 改写 / 未索引 / 向量陈旧)的条目 **bounded-union 进候选池**(走 `selectStage0.maxFallback` cap,禁无界)。此法天然覆盖手工编辑 / `git pull` / crash-in-between(loadEntries 读最新文件内容,hash diff 不依赖 mtime 精度或 manifest 标记可靠性),比原 dirty-manifest+mtime 方案**更可靠且零额外 stat / 零常驻 dirty 状态 / 无并发写竞态**。reconcile(写入向量)由 agent_end 后台 `buildCorpusEmbeddings(loadEntries)` 承担(已是 content-hash gated 完整 reconcile),embedding 成功后原子替换索引;失败时该条目继续走 search-time bounded-union 兜底,绝不"等索引就绪"而漏召,也绝不回退全库 full-body。**dirty-manifest 列 deferred**:仅当未来 search 停止全量加载(物理分区,§7)、内存不再持有全部 entry 时才需要持久化 dirty 标记——届时 manifest 才有承重价值。裁决依据:3×T0 盲审(opus 主张丢弃 / gpt+deepseek 倾向保留作 crash 网),采纳 opus——search-time hash diff 已覆盖 crash 网全部场景,且与 ADR 真实目标(stage1 **LLM token** sublinear,非文件 I/O;§52 一直接受 O(N) I/O)一致。保留 ADR 0015 `fresh-search-surface-preserves-new-entry-recall`。**P6 饱和饥饿修复(2026-06-14,4×T0 事后 review)**:bounded-union 原把 stale 排 dense/sparse 之后,候选面饱和(dense+sparse 填满 maxCand)时 stale 预算归零、新写未索引 entry 被挤出 → 违反本不变量;修复为 stale/missing 保底 floor(`stage0StaleFloorRatio` 默认 0.1,按 updated desc 最近变更优先进 floor),floor 是下限(超 floor 的 stale 仍补到 maxCand,不设独立上限),`smoke-stage0-freshness` 对照守护(floor=0.1 probe 必进 / floor=0 probe 被挤出)。
- **索引一致性(盲审新增)**:向量按 **content-hash(`compiledTruth + timeline`) keyed 失效**,非仅 keyed-by-slug——entry 仅改 status/confidence 等元数据时**不** re-embed(省 API),内容变才失效重算;陈旧 slug 向量不得残留。索引带 **embedding-model 版本戳**:provider / model 变更时强制整库重 embed,**禁止跨模型 query 向量与库向量混用**(否则静默污染相似度)。
- **索引不入 git(3×T0 决策 2026-06-13)**:向量索引存 `.state/`(已 .gitignore),不跟踪。承重理由不是"派生物"审美,而是 git 对高熵 float 矩阵无法有效 delta + 单文件双设备并发 sediment 写 = 近 100% merge 冲突(float 数组不可 auto-merge)+ 仓库膨胀。embedding 非确定性(浮点噪声 cosine 差 <0.001)是红鲱鱼:单设备已是常态(query 向量即时算 vs index 向量上次写,本就不同调用),不影响 top-N 排序;跨设备靠 content-hash 增量 + 版本戳保证一致。否决 manifest 中间方案(slug→hash 本地 O(1) 可算,manifest 省不了 embedding 反增并发冲突文件)。
- **冷启动 fallback 必须有界(3×T0 决策,opus 致命点修正)**:多设备各自本地 rebuild(订阅 embedding ~0 成本;全库首次 ~6.5min @ TPM 600K,双设备并发挤同一订阅 ~13min)。**关键**:索引空/部分时**禁止**回退全库 full-body union——那正是 §1 要消灭的 O(库)回归,冷启动窗口内每次 search 都会撞回旧成本或召回崩。故:(a) rebuild 后台非阻塞;(b) 空索引期 fallback 有界(预算/采样,绝不 per-search O(库));(c) 版本戳重建会让所有设备同步爆发重建窗口,重建恒后台。
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
- **P4 oracle 实测修正(2026-06-14)**:oracle baseline **必须用强 model**(minimax-M3 / deepseek-v4-pro 级),弱 model 会污染 coverage。实测:`deepseek-v4-flash` 作 baseline 时 full-body 倾向**凑满** stage2Limit、选入语义不相关 entry(stage0 dense 正确地不召回它们),使平均 coverage 被悲观拉低到 81%;同一 query("scope filter 必须在 topN 之前")换 `deepseek-v4-pro` baseline → picks 精准为 1 条相关 entry、stage0 **coverage 100%**。故 coverage 硬门评估**必须先用强 baseline 剥离弱 model 噪声**,否则把 baseline 噪声误判为 stage0 漏召。工具:`scripts/oracle-stage0-replay.mjs`(ORACLE_MODEL 可覆盖 baseline model)。coverage gap 调优已落地:stage0PoolLimit 100→200 + sparse 字段权重(高信号 ×3/body ×1)防 body 命中挤占 dense。
- **代码改动点**:`buildLlmIndexText` 从接收全库 `MemoryEntry[]` 改为接收 stage0 top-N(接口近零改动);`STAGE1_CANDIDATE_SURFACE` 与 `search-metrics.jsonl` 的 `stage1_surface` 字段同步;`verdict=none / insufficient_pool` 回退分支当前代码**未预埋**,须在 `llmSearchEntries` / `llmSearchEntriesWithVerdict` 两处新增;sediment curator 复用同一 search 内核,自动受益。
- **P2 盲审必修 bug(2026-06-14,三家共识,reconcile 接入前必须修)**:(1) **全局索引 prune 数据丢失(最高危)**——`buildCorpusEmbeddings` 的 `prune(validSlugs)` 接收单 project 的 active slugs 会删除其他 project 向量;reconcile 必须 **scope-filtered prune**(只 prune 本次 reconcile scope 内的 slug)或加载全库 active。(2) **共享索引无锁 RMW**——`VectorIndex` save 是 atomic-rename 但 read-modify-write 不串行,多 project session / 多设备并发 reconcile 会 clobber 彼此 upsert;须加锁(复用 sediment lock)或转 per-scope 索引文件。(3) **coverage() 只看 slug-presence 不看 hash**——更新的 entry(slug 仍在索引、向量陈旧)不算 missing,会用旧向量 cosine 排序、编辑后可能掉出 top-N;`selectStage0`/`coverage` 的 fallback 集须改为 "slug 缺失 **OR** `!isFresh(slug, hash)`"(thread content-hash)。(4) **hard-delete 向量残留**——prune 与 embed 解耦,纯本地 prune 不依赖 embedding API 可用性。
- **P3 盲审修订集(2026-06-14,3×T0 opus/gpt-5.5/deepseek 一致 RATIFY WITH REVISIONS,实现前须并入)**:(1)**折叠整条双阶段内核**——`llmSearchEntries`/`llmSearchEntriesWithVerdict` 90% 重复且已漂移,抽 `runTwoStageSearch(candidateEntries,...)→{hits,verdict,timing}`,两函数变薄包装,stage0 只集成一次。(2)**scope+filters 统一用 corpus allow-set**——`loadEntries` 返回的 corpus(filteredEntries 后)已是 scope+filter 正确全集,直接作 `allowSlugs` 传 `topN`(扫描跳过),弃读路径 scopeTagOf 反推(消 8/2352 误分类脆弱);索引只存 {hash,vec,scope} 无 status/kind,filters 必须靠 allow-set,否则 topN(100) 可能全被 post-hoc filter 丢空。(3)**sparse 必须扫 body**——ADR 编号/函数名/错误码常在 compiledTruth/timeline,不在 trigger/title/slug;in-memory 子串零 I/O。否定/反义是双通道盲区,显式靠安全网兜,不声称已解。(4)**候选面总条数硬上限**(真成本旋钮)——dense∪sparse∪stale 可能 150+,buildLlmIndexText 全文 token 爬回;设绝对上限(~300,非库%),超限按 dense 分→sparse 精确→bounded stale 逐出。(5)**熔断禁静默+持久状态+短超时**——query embed 失败回退 sparse+有界采样**必须可观测**(metrics stage0_mode=sparse_fallback,违反 accuracy-is-contract 不可静默降级);持久熔断状态(.state open/half-open+cooldown,避免每 session 重撞死 provider);query embed 短超时(~600 token,非 60s entry 超时),失败即开闸不叠重试。(6)**insufficient_pool 用结构信号非绝对 cosine 在线门**——doubao cosine 未校准/分布漂移,固定阈值必误触;主判定 pool<K + verdict=none + stage1 picks 空,绝对 cosine 仅作离线 best-entry-rank 探针。扩召**一次**有界(topN×3,绝对上限 ~400 非库%),仍 none 返回 none。(7)**非-active-status 查询 dense 盲区**——索引只 embed active,filters.status=superseded/archived 的 slug 不在索引→dense 恒空,这类查询回退过滤后全 corpus 喂 stage1(罕见+条目少,可接受)。(8)**oracle 离线 replay 非 inline 双跑**——inline 双跑让 full-body O(库) 成本灰度期每 query 复活;改 always-log stage0 候选池 + 周期重放 search-metrics.jsonl 历史 query 对照 full-body picks(或 ≤1% 后台 shadow)。(9)**verdict 语义漂移文档化**——P3 后 verdict=none = "stage0 池内无相关"(pool-relative)非"全库无相关"(vault-relative);best-entry-rank 探针未部署前不可凭 verdict=none 切流。(10)**stage1Limit ≥ stage0 池**——避链式召回瓶颈(端到端 = stage0×stage1×stage2 recall);拆 stage0PoolLimit(~100) 与 stage1OutputLimit;query-embed 热路径延迟(path-A 每轮)量化+阈值,劣化熔断。
- **待定参数**(交灰度收敛):候选集 N(初始 100,给 A/B 收敛准则);hybrid 融合权重与 sparse 字段集;embedding provider 长期选型(doubao 现成 vs 恢复 Bailian text-embedding-v4 vs 启用 Gemini);向量索引分区(3×T0 决策 2026-06-13):P1 起点用**全局单文件 + per-entry scope tag + scope-filter-before-topN**——YAGNI(2475 条全量 load + 纯 JS 扫描毫秒级,性能拐点远未到),正确性靠 before-filter(不稀释候选预算、不损 recall);**物理分 store(per-project + shared knowledge)列 deferred**,触发条件:库 >1 万 / JSON parse >100-200ms / 内存压力。硬约束:scope filter 必须 **before-topN**(扫描时跳过 out-of-scope 向量),**禁 after-topN**(正确条目被无关 scope 挤出 top-N 则损 recall——deepseek 指出)。物理分 store 触发时一并评估存储格式(单文件→JSONL 增量 / sqlite)与跨设备 rebuild 范围(只 rebuild 当前 project);单向量 vs 多向量(title / body chunk / timeline 分离,解决 §3 截断盲区)。
- **观测**:`search-metrics.jsonl` 增 stage0 字段——候选池命中、回退触发率、best-entry-rank、dirty-union size、query-embed 延迟,为灰度 A/B 与走偏信号供数据。
- **P6 方向 B 事后 review + freshness 饥饿修复(2026-06-14,4×T0 REVISE-B 共识)**:opus / gpt-5.5 / deepseek-v4-pro / kimi-k2.6 读真实代码独立判断 → **4/4 一致 REVISE-B(不返工 A)**。连原反对方 gpt/deepseek 收回担忧:search 全量 `loadEntries` 下 content-hash diff 在**检测层面严格强于 manifest**(覆盖手工编辑/git pull/markDirty 失败,且 hash>mtime),manifest 反而引入腐败/遗忘标记/并发写 race,唯一承重价值在"search 停止全量加载"时(已 deferred)。但一致揭出 **stale 饱和饥饿 bug**(见 §4),已修(stale floor)+ smoke + oracle 21 query 强 baseline coverage 97.3% 无回归。**P6 follow-up backlog(本轮未实施,待单独评估,部分需设计 review)**:(a) **reconcile 解耦 sediment 写**——现只 `wroteVectorRelevant` 触发,纯读会话/git pull 后索引不重建、dense 静默退化;拟 search 时 stale 比例超阈值触发后台 reconcile。(b) **冷启动/model-bump 整库 rebuild 移出 agent_end awaited**(现持锁 ~6.5min,与"后台非阻塞"不符)。(c) **contentHashOf 含完整 body 但 embeddingInput 截断 3500** → 长 entry 尾部改动白触发 re-embed(成本噪声,4家都提)。(d) **content-hash 在 parser 解析时算一次挂 entry**,免 per-search 重算。(e) **独立 best-entry-rank ground-truth 探针**(现只 stage0_best_dense_rank,静默掉召监控不到)。
