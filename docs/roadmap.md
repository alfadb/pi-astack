---
doc_type: consensus
status: active
---

# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。**只装未完成/计划**——已 ship 的当前事实写入 [`docs/current-state.md`](./current-state.md)，功能/需求级变更写入 [`docs/feature-changelog.md`](./feature-changelog.md)，多轮审计与 commit 级实施流水写入 `docs/audits/` 或保留在 git history（REQ-006：roadmap 不是 changelog）。

## 文档体系 Phase 2（共识层重构）

Phase 1 已建共识层（`README`/`vision`/`direction`/`requirements`/`feature-changelog`，见 [`docs/README.md`](./README.md)）。Phase 2 **整体完成**：23 份 ADR 方向上提 `direction.md`（12 不变量）/`requirements.md`（REQ-001..009）；`current-state.md`/`architecture/*` 去代码镜像只留契约；frontmatter + `docs-doctor` 守卫落地。

**abrain 侧物理 ingest/瘦身已收官**（[ADR 0034](./adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md) 实现）：全 19 份机制 ADR 处置完毕（12 SLIM + 5 机制存档 ingest 入 pi-global = 256 entries + 2 superseded 只标 archived），机制分解入 abrain + `direction_impact` 注解 + 承重墙按需渲染 rationale（带 pinned `source_ref` SHA，见 `README.md` §4）；原机制 prose 由各 ADR slim banner 标注的 git 基线保留。后续唯一已知缺口：pinned SHA 的 **staleness re-sync**（0034 ratify 显式 defer，待 dogfood 出现首例 stale 后带证据起草）。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| **ADR 0024 R0 patch 同 PR 交付**（阶段 0，纯文档） | ADR 0023→R5（删 INV-R8/R9、删 `/rule veto`、删 `MEMORY-RULE:` first-class、加 INV-R12 auto-demote + `last_cited_at` 字段）+ ADR 0021 patch（删 `/about-me` first-class）+ ADR 0017 patch（sediment defer + auto-bind）+ ADR 0016 patch（self-improve cron化）+ ADR 0020 patch（silent power-user only）+ docs/current-state.md / brain-redesign-spec.md / architecture/ 同步。 | **R0 不同 PR 交付→ ADR 0024 不算 Accepted**，后续所有设计 hold。纯文档 2-3 天工作量。 |
| **ADR 0025 起草 (meta-curator subsystem)** | 基于 ADR 0024 三条 invariant + §4.2 五条 capability 清单详细设计：outcome feedback edge + cross-session aggregator + multi-view verification + classifier auto-iteration + silent archive rollback window。 | R0 完成后立刻起草 → multi-LLM xhigh audit ≥ 2 轮 P0 收敛 → R2-R6 实施阶段 phase。 |
| **ADR 0023 R5 / ADR 0024 R2-R6 实施**（阶段 1-5） | R2 (outcome edge + auto-demote, ~300-500 LOC) → R3 (cross-session aggregator, ~500-800 LOC) → R4 (multi-view verification, ~300-500 LOC) → R5 (classifier auto-iteration, ~500-800 LOC) → R6 (silent archive window, ~200-300 LOC)。合计 ≈ pi-astack 当前体量翻倍。 | 多季度迭代，不是单次 ship。按真实 dogfood 反馈逐步 ship。Lane G G3/G4/G5 在这个路径里自然关闭（G3 → ADR 0023 R5 unified classifier；G4 → ADR 0024 §4.2.2/4.2.5；G5 → ADR 0024 §4.2.1 下游）。 |
| Lane G G4–G5 | G1 writer + G2 `/about-me` slash + agent_end 双-lane 已 ship（详 [ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）；G3 aboutness classifier 由 ADR 0023 R1 合并 unified classifier 关闭。剩余：G4 `review-staging` slash + 30-day TTL、G5 region-aware ranking hint。 | G4–G5 无阻塞；自然在 ADR 0024 R2-R6 路径里关闭。 |
| Vault P0d | masked input、`.env` import、`/vault migrate-backend` wizard | 保持 fail-closed，不引入 plaintext fallback。Vault P1（active project resolver + `/secret` scope 路由 + `$PVAULT_/$GVAULT_`）已 ship。 |
| `abrain-age-key` identity passphrase wrap | 让 `~/.abrain/.vault-identity/master.age` 能用 passphrase 加密后进 git，实现跨设备仅 `git clone abrain` + 输一次 passphrase。详见 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md) §"P0d 增强"。 | 技术依赖未定：(Y2) `age-encryption` JS lib in-process unwrap · (Y1) `node-pty` 模拟 pseudo-tty 。合并 P0d ADR 决策。 |
| Tier 3 legacy backends reader UX | `ssh-key` / `gpg-file` / `passphrase-only` 在 ADR 0019 后是 explicit-only。`passphrase-only` reader 仍不能解锁（同一 tty pass-through 问题）。 | 上项 abrain-age-key passphrase wrap 落地后该 gap 自动关闭（同一 unwrap 路径）；在那之前 `/vault status` 仍会在旧 backend init 后显示 deprecation 提示。 |
| Abrain auto-sync UX P0e | [ADR 0020](./adr/0020-abrain-auto-sync-to-remote.md) 已 ship 的 baseline（后台 push + 启动 ff-fetch + `/abrain sync` / `/abrain status`）上还差几个 UX 增强点。 | TUI footer 提示 `ahead > 0` 超 5 分钟；周期性 fetch（e.g. 每 15 min）；conflict suggestion logging（量化 LLM auto-merge 不做的代价）。全部是 deferred YAGNI，等真实 usage signal 再推进。 |

## ADR 0035 — memory stage1 embedding 候选检索实施

[ADR 0035](./adr/0035-memory-stage1-embedding-candidate-retrieval.md)(Accepted;3×T0 跨厂商盲审 opus-4-8/gpt-5.5/deepseek-v4-pro 一致 RATIFY WITH REVISIONS,修订集已并入)的分阶段实施。stage1 候选面从 full-body 全库海选改为 embedding 向量检索 + LLM 精选小候选集,成本从 O(库×频率) 降为 O(N);supersede ADR 0015 的 stage1 候选面决策,保留其双阶段框架 + result-cache 禁令 + freshness 契约。

**Phase 0 前置确认(已完成)**:embedding provider `doubao-embedding-vision` @ sub2api 网关(`/v1/embeddings`,dim 2048,batch≤10)配通实测;走方舟 Coding Plan 订阅额度(cost=0,非 metered);ToS 核实——embedding 为 Coding Plan 官方功能(2026-03-31 上线,RAG/agent-memory/OpenViking 用途),无违约风险;约束 TPM 600K/min(全库 embed 限流分批 ~4min)+ 按调用次数消耗套餐额度。召回实测 related-recall top-100=98%(ground truth 用 derives_from/related,有正偏,见 ADR §3)。

| Phase | Intent | 盲审硬约束 |
|---|---|---|
| P1 embedding 基建 ✅ | 向量索引模块(abrain `.state`,content-hash keyed 失效 + embedding-model 版本戳);embed 封装(batch≤10 + TPM 限流 + 重试);纯 JS 余弦 top-N + scope-filter-before-topN;全库初始 embed(实测 2350 向量,12 project + world)。已 ship(`embedding.ts` + smoke) | content-hash 失效(metadata-only 不 re-embed);版本戳跨模型禁混用;索引不入 git;scope 按物理位置 |
| P2 写入路径增量 embed(sediment 侧,ADR 0003)✅ | **方向 B(P2 盲审改,ADR §46)**:freshness 改 search-time content-hash diff(`staleOrMissingSlugs`:内存 entries vs 索引,未索引+陈旧 bounded-union),**无 dirty-manifest**(deferred 到物理分区);reconcile = agent_end `tryAutoWriteLane` 写后 best-effort `reconcileEmbeddings`(content-hash gated + scope-safe prune + 文件锁串行 RMW);修 4 高危 bug(全局 prune 删他 project / 无锁 / coverage 只看 slug / hard-delete 残留)。已 ship(`embedding.ts` + `sediment/index.ts` + smoke 16/16) | freshness:search-time diff 天然覆盖手工编辑/git pull/crash;reconcile 失败不阻塞 sediment,search bounded-union 兜底,禁回退全库 |
| P3 stage1 改造(3×T0 盲审修订已并入,ADR §7) | 抽 `runTwoStageSearch` 内核(两函数折叠,stage0 集成一次);stage0 = query embed → hybrid(dense topN[**corpus allow-set** 非 scopeTagOf] ∪ sparse[trigger/title/slug/**body**] ∪ staleOrMissing bounded),候选面**硬上限 ~300**;feature flag `stage0Enabled` 默认 off(dark-launch) | insufficient_pool 用**结构信号 pool<K** 非绝对 cosine 在线门;熔断**禁静默**(metrics+持久状态+短超时)+ sparse-only 兜底禁全库;扩召一次有界(topN×3 上限 ~400);非-active-status 查询回退全 corpus;verdict=none 改 **pool-relative** 语义;stage1Limit≥池;oracle **离线 replay** 非 inline 双跑 |
| P4 A/B 灰度 + 转产硬门 ✅ | `oracle:stage0` 离线 replay(full-body vs stage0 coverage/parity)+ `search-metrics.jsonl` stage0 字段(pool_hit/fallback/best_dense_rank/stale/embed_ms, `smoke:stage0-metrics` 验证)。**stage0Enabled flag 已开(dark-launch)** | **转产硬门达标**:21 query 强 baseline(v4-pro)coverage **95.1% ≥95%**(中文 11=92.4% + 英文/config 10=98%);baseline 必须强 model(flash 噪声拉低, 见 ADR §7);parity 低是 stage1/2 选择差异非召回问题 |
| P5 切换 + 旧 surface 下线 ✅ | stage0 成默认(`DEFAULT_SEARCH_SETTINGS.stage0Enabled=true`, settings.json 移除显式 flag 单源);`full_body_v3` 退役为 flag-off kill-switch + oracle baseline;收敛权重 poolLimit 300/maxCand 400/sparse 3:1(oracle tuning 从 200/300 提升) | **oracle final 21 query 强 baseline coverage 98.1% ≥95%**(19/21 query 100%; 200/300=94.1% → 300/400=98.1%);走偏信号监控(top-100<95% / verdict=none 率升 / best-rank 劣化)回看;kill-switch + 安全网双触发 + search-time freshness 兜底 |
| P6 方向 B 事后 review + freshness 饥饿修复 ✅ | 4×T0(opus/gpt-5.5/deepseek-v4-pro/kimi-k2.6)读代码独立 review 方向 B → 4/4 REVISE-B(不返工 A);揭出 stale 饱和饥饿 bug → `selectStage0Pool` 加 stale floor(`stage0StaleFloorRatio` 0.1, updated desc 优先, 下限非上限);`smoke-stage0-freshness` 对照守护 | **freshness 不变量兑现**:floor=0.1 probe 必进/floor=0 被挤出;oracle 21 query 强 baseline coverage 97.3% 无回归;应改(reconcile 解耦写/冷启动 rebuild 异步/截断一致性)记 ADR §7 backlog |
| P8 stage1 紧凑 surface 降本(探索, dark-launch off) | flag `stage1CompactSurface`(off); stage1 去 compiledTruth/timeline 粗筛, body 留 stage2; `oracle:compact-surface` 对比 + prompt-surface 对齐修复 | token 304K→52K(降 83%) 但生产模型 flash recall coverage 54.4% vs 基线 67.5%(差 13 点, 弱模型损失放大); 4×T0 DARK-LAUNCH 不转正; 待 stage1-50 度量+21×3 重复+compact-v2 薄证据+sediment 路径验证 |
| P7 非-active 查询 stage0 化(sediment 去重漏洞) ✅ | 4×T0 设计 review: sediment curator 去重 search(status:["all"])触发 wantsNonActive→null→每轮全库 full_body 915K。修:(1) 删 wantsNonActive→null 走 hybrid; (2) load-bearing: staleOrMissingSlugs 只算可索引集(active 且非 zone:rules), 防非 active+rule neighbors 塞爆 stale | `smoke-stage0-nonactive`(不回退全库+55 不可索引 probe staleCount=0+相关非 active sparse 召回) + oracle active coverage 100% 无回归; backlog: 中文 sparse 弱/防复发 guard/dedup oracle |

**待定参数**(灰度收敛):候选集 N(初始 100);hybrid 权重 + sparse 字段集;向量存储格式(JSON 单文件 vs JSONL 增量 vs abrain-state sqlite,含 >5000 迁移);单向量 vs 多向量(解决实验 `[:3500]` 截断盲区);embedding provider 长期选型(doubao 现成首选,备选恢复 Bailian text-embedding-v4 / 启用 Gemini)。

## Architecture debt

| Item | Intent |
|---|---|
| Schema evolution | frontmatter/audit/binding schema 的 version upgrade path（当前 `schema_version: 1` 字段已写入，缺多版本兼容/迁移策略）。 |
| Runtime path docs/tests | 避免 `.pensieve`/`.pi-astack`/`.abrain .state` 路径漂移。 |
| Model fallback vs curator whitelist | 当前 model-curator session_start 只 WARN，不阻止 curator 删掉 fallback 候选；需要 curator 在 whitelist 时尊重 fallbackModels 列表，或 fallback 路径自带 whitelist bypass。 |
| Audit 新字段默认 sanitize | 新加 audit 字段须默认走 `sanitizeAuditText`（曾有 explicit/auto-write lane 的 `candidates[].title` 漏 sanitize 的先例，已修；保留此项作纪律提醒）。 |

> ADR 0022 `prompt_user` 的 housekeeping batch（P3b post-audit / T0 xhigh / polish sweep 等 P2 项）已全部 ship 或 won't-fix；实施流水与 audit 轨迹见 git history 与 `docs/audits/`，不再镜像于此。

## Architecture invariants（已守护，禁止退化）

以下几条曾是 roadmap debt，2026-05-14 R5/R6 audit 已落地为不变量：未来 PR 退化这些行为应视为 regression。

> **行号策略**：每次大幅插入后行号会过期；改用 `file::symbol` 锚点（函数 / 常量名），仅在需要时附"~行号"提示多次插入后请重新 grep，不要依赖冻结的绝对行号。

| Invariant | 当前防线 |
|---|---|
| Dispatch temp prompt uniqueness | `extensions/dispatch/index.ts::runSubprocess`（现 ~L233）每次调用独立 `fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-"))`；并发 worker 各持独立 tmpDir。 |
| Vault read/bash fail-closed | `extensions/abrain/index.ts` 中 `eventRegistry.on("tool_call", …)`（~L660） 与 `eventRegistry.on("tool_result", …)`（~L697）：`prepared.kind === "block"` 或 inject try/catch → `auditBashInjectBlock` + `return { block: true }`；tool_result authorization/redaction throw 全 withhold + `auditBashOutput("bash_output_withhold", …)`。 |
| Writer git rollback | `extensions/sediment/writer.ts` 中 `deleteProjectEntry`、`updateProjectEntry`、`writeProjectEntry`、`writeAbrainWorkflow` 在 `gitCommit()===null` 时 `git reset HEAD -- <rel>` + `fs.unlink(target)`；四条写路径均覆盖。 |
| Vault P1 active project resolver | 核心引擎在 `extensions/_shared/runtime.ts::resolveActiveProject`；`extensions/abrain/index.ts` 中 `parseSecretScopeFlags`/`resolveSecretScope`、`bootActiveProject` 快照（session_start）、`/secret` 命令处理；`extensions/abrain/vault-bash.ts::buildBootVaultBashDeps`（`$PVAULT_/$GVAULT_/$VAULT_` 路由 + `pvaultBlockReason` 拒绝）。`--project=<id>` 必须等于 boot-time 绑定；默认走 active project。 |
| Curator scope binding（非 create ops） | `extensions/sediment/curator.ts::validateScope`（调用点在 update / merge / archive / supersede / delete）强制 neighbor scope 一致；只有 create 仍 prompt-only（下方 create-branch 行已加约束）。 |
| Migrate-go unknown frontmatter preservation | `extensions/memory/migrate-go.ts::preservedFrontmatterLines` + `buildNormalizedFrontmatter`：迁移路径保留未知 frontmatter raw lines。 |
| Memory store priority post-B5 cutover | `extensions/memory/parser.ts::resolveStores` 固定为 `abrain-project > world > legacy-pensieve`；`loadEntries` dedup 跨 store first-wins **不可被 confidence/updated 推翻**；`scanStore` 对 world 传 `WORLD_EXTRA_IGNORE_DIRS={projects,vault}`。 |
| Memory read-path kind/status 枚举归一 | `extensions/memory/parser.ts::normalizeKind`/`normalizeStatus` 在 parseEntry 里被调用：`entry.kind`/`entry.status` 总是 sediment/validation.ts ENTRY_KINDS/ENTRY_STATUSES 枚举之一；legacy `pipeline`/`knowledge` + 任意未知值被 fold 到最近的 canonical kind，原值保留在可选 `legacyKind`/`legacyStatus` 供 doctor。LLM-facing card 不再看到未声明的 kind。 |
| Curator create-branch scope binding | `extensions/sediment/curator.ts::parseDecision` create 分支加两条硬约束：(a) 每个 `derives_from` slug 必须在 allowedSlugs 中（防幻觉 slug）；(b) 若 `scope:"world"`，每个 `derives_from` neighbor 必须也是 world-scope（防漏 project context 进 world store）。project create 仍可从 world 派生（合法 specialization）。 |
| Sediment update/merge unknown frontmatter preservation 覆盖 | `scripts/smoke-memory-sediment.mjs` "fm-preserve" fixture：注入 unknown scalar/array、update body 无 patch / 有 patch 两路，验证 unknown 存活 + 保护 key 唯一 + parseEntry roundtrip。 |

## Pending flips（过渡态机械门，ADR 0024 §7.6 条款）

| 门 | flip/移除条件 | 证据源 |
|---|---|---|
| `tier1JaccardCuratorLane: false`（显式 rollback 时 Jaccard 自治 dedup 回到 Tier-1 kill path） | 已翻默认 true；保留此项作为 rollback 再评估条件：观察窗口（aggregator 30 天 / tail 行数限）内被裁决行（create/update/merge，error 不计）≥ 50 条 且 false-merge 份额（would_decision=create）≤ 5% | aggregator P1.5 watchdog `tier1_jaccard_shadow.flip_ready`（仅用于 rollback evidence/advisory，不机械自翻） |
| `conf≥8` 非指令 durable 过渡 fallback（correction-pipeline isTier1Directive，仅 no-target） | 审计窗口内 `tier1_direct_write` 中 `is_directive!==true && confidence>=8` 不再产生被用户纠正的 accepted corrections / recall misses → 移除 fallback 回 ADR 原文谓词 | `tier1_direct_write` audit 的 `is_directive` / `confidence` / correction outcome 维度（O5 sunset） |
| multi-view skip-cache 7d TTL | P1.5 Pass-1 schema 升级后 not-synthesizable 计数持续为 0 一个季度 → 删 cache | watchdog `pass1_op_not_synthesizable_count` |

## ADR 0031 — 自治自标定遗忘实施(埋点优先,dark-launch)

设计见 [ADR 0031](./adr/0031-autonomous-self-calibrating-forgetting.md)。原则:**先补标定数据(Lane G 当年缺的那块),再上可逆 demote;auto-destroy 永远 supersession-gated + 必留大脑可复活 tombstone;disuse 永不触发物理删除**。分阶段,全程 dark-launch flag 守卫、默认 off:

**Phase 0 — instrumentation(零行为变化,只埋点观测 N 周)**。埋点写 `.state` 侧指标,不污染 entry frontmatter 的语义内容:

- `last_retrieval_hit_at` / `retrieval_hit_count`:该 entry 进 stage0 候选 / 被 `topN` 命中。
- `last_cited_at` / `cited_count`:被 agent **最终采用**(进 path-A inject 块 / decide brief / 实际进 prompt)——「被用」≠「被检索」(承接 roadmap `last_cited_at`)。
- `superseded_by` / `contradicted_by` 事件:真值变化信号,安全降级的**主**驱动。
- demote / resurrection 事件流(active↔archived,带触发信号快照)。

目的:积累 Lane G 当年缺的衰减标定数据;此阶段**不做任何 demote/delete**。

**Phase 1 — 可逆基座 + 影子标记(仍不真动)**:tombstone / 大脑可复活影子(`slug`/`kind`/`hash`/`successor`/`digest`/`reactivation_hint`)使「物理回收」也对大脑可逆;decay-scorer 输出 `would_demote` / `would_delete` 影子标记 + 衰减分,**只标不动**;影子回归用最近 N 个真实 query / decide brief 跑 (corpus) vs (corpus − would-demote 集),量 brief 质量是否下降。

**Phase 2 — resurrection 稳态自标定(观测闭环)**:resurrection rate 做反馈(复活频繁→自动调慢、噪声/近重涨→调快);kind 权重 / 窗口由大脑自学(prompt-native,非硬编码人类策略);自审闸 = resurrection rate 超阈值自动回退衰减系数。

**Phase 3 — 开启自治 demote(可逆),destroy 仍 gated**:`active→archived` 自治 demote 上线(可逆,误判靠 resurrection 自愈);auto `git rm` 仅 **supersession-gated**(有 active 稳定 successor)+ 必留 tombstone;结构护栏(非策略)= 可逆基座 + tombstone + resurrection 自回退 + 每批 demote 速率上限(防单次模型偏差级联)。数据不足前不开 Phase 3。

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd / BM25 optional acceleration | 旧 BM25/tf-idf 仅作为 deprecated dead code 留在 `extensions/memory/search.ts`，不是 `memory_search` fallback；可做离线诊断/加速实验。 |
| Cross-device abrain sync | 等真实多机冲突反馈；不要提前 over-engineer。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Skills/prompts/vendor port | `skills/`、`prompts/`、`vendor/gstack/` 仍是计划，不在 current repo tree。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
