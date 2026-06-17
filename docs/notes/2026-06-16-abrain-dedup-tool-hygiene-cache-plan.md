---
doc_type: plan
status: active
created: 2026-06-16
---

# abrain 去重收敛 + 工具面瘦身 + 缓存修复 实施计划

来源:2026-06-16 会话(从 10 篇文章梳理 → 跨厂商 T0 盲评 → sediment 去重架构定稿)。本文是 goal 的执行依据。

## 目标

把本会话确定的几项改动落地:让记忆条目去重发生在"沉淀当下、由 LLM 判定",从源头止住条目重复累积;清理已积压的重复与断链;补上规则的"理由保鲜";修复开头固定内容的缓存浪费;删除无自动职责的 `memory_neighbors`;增加工具空转检测。

## 关键边界(必须遵守)

- 主会话只写**代码**(pi-astack 扩展);**绝不手动编辑 `~/.abrain` 下的任何记忆条目**。记忆条目的增/改/合并/归档只由后台 sediment 运行新代码时发生。
- 信任分层保留(Option B):明确指令与不确定假设走不同信任,**不合并成单一通道**;差别只落在"LLM 失败时的兜底"——明确指令兜底新增(永不丢),不确定假设兜底跳过/暂存。
- 去重/合并的最大风险是**误合并 = 语料污染**:合并必须保全两边内容、软删可撤、有审计;拿不准标"存疑"而非合并/删除。
- 相似度分数(字面重合 / 嵌入相似)只用于**挑候选**,永不替 LLM 做去留决定。
- **验证不自证**:动到 sediment 写入路径的改动(任务 A),完成判定必须经一次跨厂商 T0 审查 + 既有 smoke 通过,不能只靠自评。

## 任务分解

### T0 量旧账(先做,只读,给后续投入定量)
- 用现成嵌入索引跑一遍大库(约 2777 条),统计近重复对数量/分布;数现存重复规则(已知 5 条黑话规则)与断链数。
- 验收:产出一份计数报告(近重复率、重复规则数、断链数)。
- 可逆:纯读,无副作用。

### A 去重主力:沉淀当下"查 → LLM 判 → 写"(核心)
- A1 规则路径:去掉 `Jaccard ≥ 0.85` 这道门;改为"先取同范围全部规则(集合小)→ LLM 决定整套操作";裁决空间从 {更新/合并/新增} **扩到含"归档相悖/被取代的旧条目"**。
- A2 大库路径:修稳策展器现有的写入时去重(候选用嵌入召回 + 开头段聚合;LLM 判;修掉把全库拖进去的老问题)。
- 验收:重放黑话规则那一例,走"归档旧的 + 更新/合并"而非新建;一组已知重复/相悖对的判定准确率达标;`smoke:tier1-jaccard-adjudication`、`oracle:dedup-neardup`、`oracle:dedup-p5b`、`smoke:abrain-rule-writer*` 通过 + 新增"归档相悖"用例;**跨厂商 T0 审查通过**。
- 可逆:代码改动 git 可撤;运行产生的归档为软删可撤。

### B 清旧账(在 A 把新增口堵住后)
- 一次性清存量:已有重复规则交 A 的"查→判"合并/归档;机械修断链(目标改名→重定向、被删→剔除),标记孤儿/缺出处。
- 验收:5 条黑话规则收敛成一条(其余标被取代);现存断链清零或标记;golden 样本验证检测逻辑(真值=文件系统)。

### C 理由保鲜
- 对带 `source_ref` 的条目(约 251 条)检查所指 ADR 是否仍在/被取代;源失效的标出来等复查。**不用 `memory_neighbors`。**
- 验收:埋一条源 ADR 已废弃的样本被正确标出;`smoke:derive-provenance` 等相关通过。

### D 缓存修复(独立,可与 A 并行)
- 把每轮会变的注入(分钟时钟、每轮锚点)挪到末尾,固定内容(指令/规则目录)留开头。
- 验收:改动前后量开头固定内容的缓存命中率确认回升;不动"搜索全文重排"那个已知取舍;相关 smoke 通过。
- 可逆:注入顺序调整 git 可撤。

### E 工具空转检测(次要)
- dispatch 侧检测滑窗内完全相同的 (工具,参数) 重复调用 → 抑制 + 注入反思。
- 验收:构造重复调用样本被掐断;`smoke:dispatch` 通过。

### F 删除 memory_neighbors(独立,安全,可先做)
- 删工具定义 + 处理函数 + `import` + 底层 `neighbors()`/`oneHopNeighbors()` + dispatch/hub/workflow 三处白名单 + sediment 提示词那一项。
- 验收:`grep memory_neighbors` 在代码里清零;dispatch/workflow 白名单解析不报错;`smoke:dispatch`、`smoke:dispatch-hub`、`smoke:memory` 通过。
- 可逆:纯代码 git 可撤;将来需有向/类型边遍历再加回。

## 非目标(明确不做)

- 流中拦截写法、文件改动哈希校验(违反"宁可重做不堆机械护栏")。
- 各开独立工作目录、实时成本看板、真调试器接入。
- 照搬外部 +8 条规则与斜杠命令群。
- 对外知识格式(OKF)导出(仅互通才做)。
- 合并成单一沉淀通道(已否决,走 Option B)。
- "先写后收口"作为去重主力(已否决,改为写入当下判)。

## 推荐顺序

F(安全热身,验证改-测闭环)→ T0 量旧账 → A(先 A1 规则、再 A2 大库)→ B → D(可与 A 并行)→ C → E。

## T0 量旧账 结果(2026-06-16,只读测量)

方法:近重复用嵌入索引 chunk0 余弦(N=2458 条已嵌入 active 条目);规则去重用主题关键词(字符 n-gram 聚类会把短规则全并成一簇,不可信,已弃);断链用 `[[wikilink]]` 目标 slug/路径解析并分类。脚本为 `/tmp` 只读分析(不入库)。

### (1) 近重复对(嵌入余弦)
| 桶 | 对数 |
|---|---|
| cos ≥ 0.95 | 0 |
| 0.90–0.95 | 12 |
| 0.85–0.90 | 35 |
| 0.80–0.85 | 125 |
| 合计 ≥ 0.80 | 172 |

- ≥0.90 的 12 对涉及 24 个不同条目(去重候选上界)。
- ≥0.92 的 Top 8 经核验**全部是真重复**(同一事实/决策换措辞),例:`taste-review` ⟷ `taste-review-content`(0.946)、`pi-does-not-support-at-import...` ⟷ `...support-import...`(0.943)、`model-curator-tiers-required-structured-roster` ⟷ `t0-roster-should-be-structured-under-model-curator-tiers`(0.94)、`metallb-l2-mode-needs-periodic-garp...` ⟷ `...requires-periodic-garp...`(0.924)。
- **结论**:大库近重复是"几十对"量级、不是失控爆炸——现有策展器写入时去重大体在工作;A2 是"修稳 + 收尾扫这几十对",规模可控。

### (2) 重复规则
- rules 区共 29 条;"行业黑话/专业中性词"主题簇 = **5 条**(冗余 4)——与已知一致。
- 全量规则去重**必须 LLM 判**:确定性字符 n-gram 既会漏(原黑话漏判)又会过合(把 25 条全并一簇),两头都不可信——这正坐实 A1"分数只挑候选、LLM 拍板"的设计。

### (3) 断链(wikilink 总数 2606)
| 类别 | 数量 | 处置 |
|---|---|---|
| 已解析(存在) | 2031 | — |
| `[[:space:]]` 等正则伪链接 | 3 | 剔除(非真链接) |
| 旧约定 `[[knowledge/*/content]]`(此类文件实际为 0,已失效) | 242 | 机械重写/剔除 |
| `[[short-term/*]]` | 2 | 核查 |
| 其它真断链(含 `decisions/X`、`日期前缀`、title 式、误链 TOML 键如 `[[runners]]`) | 328 | 部分可机械重写、部分需判断/剔除 |
| **未解析合计** | **575(22%)** | B 任务范围 |

- 旁证:`knowledge/*/content.md` 实际存在 0 个 → 那 242 条是历史失效链接。
- 异常:嵌入索引里命中 rules 区 slug 的有 **2 条** → 存在跨区同名 slug(同一 slug 既在 rules 又在普通区),B 顺带核查。

### 对 A/B 的范围结论
- **A1 规则路径 + B 黑话簇**:最确定、收益最高(5→1)。先做。
- **A2 大库写入时去重**:真存在但规模小(~几十对),以"修稳现有 + 收尾扫 ≥0.85 的 ~47 对"为度,勿过度投入。
- **B 断链清理**:量大(575),但以"失效路径约定"为主,多为机械重写/剔除,少数需判断;并核查 2 处跨区同名 slug。

## 进度跟踪(2026-06-16)

- [x] **F** 删除 memory_neighbors — 提交 66c0418;smoke dispatch/dispatch-hub/memory 全绿。
- [x] **T0** 量旧账 — 提交 c308a9d;近重复 172 对(≥0.90 12 对/24 条)、黑话簇 5 条(冗余 4)、断链未解析 575(以失效路径约定为主)。
- [x] **A1** 规则路径全集裁决(去 Jaccard 门 + 归档相悖)— 提交 b75a950 → 7294e54 → 281bf18;两轮跨厂商 T0 复评通过(2 SHIP/1 SWC,SWC 已闭);smoke 11/11。残留:live LLM 质量带监控观测。
- [x] **A2** 大库写入时去重 — 验证结论:全库 bypass 已被 P7(ADR 0035)+ ADR 0037 profile facade 结构性修复,**无需改码**;2 家跨厂商 T0(opus/deepseek)独立 CONFIRM-NO-CHANGE;回归 smoke:stage0-nonactive + search-profiles 均绿。证据:docs/notes/2026-06-16-A2-fullcorpus-bypass-verification.md。
- [x] **B** 清旧账 — **决定(用户 2026-06-16):不在主会话整理、不建批量子系统,靠 sediment 正常运行自然演化**。A1 已上线 → 下次黑话主题被触碰即写入当下合并那一簇;575 断链危害低,保持 lint 标记、随条目处理自然收口。主会话零动作(守只读红线;合于“第二大脑应自主演化、不靠主会话维护”的取向)。
- [x] **D** 缓存分区修复 — 实测真凶是 goal 状态块(字母序靠前)+ path-A 召回夹在 stable 中间(time 本就在末尾);修复=volatile-suffix 协议(_shared,wrapVolatile + time-injector hoist 下沉)。提交 9ba223e。应对 2 家跨厂商 T0 SHIP-WITH-CHANGES:修 marker 碰撞转义 + seam 自洽 + CRLF;smoke:cache-partition 18 断言绿 + time/goal/memory-path-a 回归绿。证据:docs/notes/2026-06-16-D-cache-partition-review.md。
- [x] **C** 理由保鲜 — source_ref provenance liveness 检测器(只读, extensions/memory/provenance-liveness.ts)。parseSourceRef + checkProvenanceLiveness 给每条确定性 verdict(file_missing/superseded/ingested/proposed/heading_missing/live/unparseable, superseded 优先于 ingested)。关键:靠 heading-scoped ingest 标记区分“ADR 被 condense”(预期)与“真 drift”。样本验证(真实 251,只读): 全 source_ingested、0 actionable(provenance 干净,检测器是前瞻守卫)。写路径交 sediment。提交 4347a4f。应对 2 家跨厂商 T0 SHIP-WITH-CHANGES:修 heading-scoped ingest(防隐藏 drift)+ .md# 解析 + 路径逃逸 guard;smoke:derive-provenance 20 断言绿。证据:docs/notes/2026-06-16-C-provenance-liveness-review.md。
- [ ] **E** 工具空转检测。

### Backlog(D/C/E 之后)

- [ ] **A3 rename-on-update**(用户 2026-06-16 确立为方向,排 D/C/E 之后):`update` 允许改 slug/文件名——slug 是随内容演化的可读把手、不冻结。**硬约束:改名必须原子重写所有入边引用**(正文 `[[old]]`→`[[new]]` + frontmatter 关系如 derives_from),否则制造断链(= 575 那类的成因)。复用 `extensions/memory/rewrite-cross-scope.ts`(已能扫全库找入边并重写)。区别于 `supersede`(那是 fork 身份);rename 保留同一条的 created/timeline/git 历史(git mv)。软约束:仅内容显著演化才改名。动 sediment 写入路径 → 过一轮跨厂商 T0 评审。

## 验证总则

- 每项至少一条机械 / 可独立验证的证据(smoke 或计数),不靠自评。
- 任务 A(动 sediment 写入路径)完成前必须过一次跨厂商 T0 审查。
- 每次 commit 前 grep/read 确认改动确实落盘。
