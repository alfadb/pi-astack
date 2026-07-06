# ADR0039 二轮共识：真相面反转定序（2026-06-20）

> 协议要求的二轮多 T0 共识审计记录。一轮把「首次 canonical=projection 反转先
> Constraint 还是先 Knowledge」推迟到 B0–B4 机制建好后定。B0–B4 已完成，本轮定。
> 参与 T0：opus-4-8、gpt-5.5、deepseek-v4-pro、kimi-k2.7-code。结论：4/4 AGREE。

## 一致结论

### 1. 一轮定序之争作废 —— Constraint 读已反转，首次读反转唯一落在 Knowledge

四家实读代码后一致确认：

- **Constraint 读已是 compiled-view canonical**：`composeRuntimeRuleInjection` 在
  `compiled.ok` 时直接 return compiled injection；当时 legacy 仅 read-error fallback
  （`compiledViewInjection.enabled=true`, `fallbackToLegacyOnError` value was `true`）。
- **Knowledge 读仍是 legacy canonical**：`loadEntries` 把 projection store 追加在
  数组**最后**，dedup first-store-wins → projection 永远输给 legacy
  （abrain-project > world > .pensieve）。projection 只是 overlay。

所以一轮的「先 Constraint」在读面**已经发生**；真正待做的「首次 canonical=projection
读反转」现在唯一落在 **Knowledge**。无定序之争。

### 2. Constraint 只剩 P4 退休（与 Knowledge 解耦并行）

- P4-a（低风险，可独立 ship）：删/收缩 `tier1-ruleset-adjudicator` 死代码 + import；
  event-fail fallback 改为 queued evidence + diagnostic，不再走 `writeAbrainRule`。
- P4-b（推迟到 Knowledge soak 后）：把 `fallbackToLegacyOnError` 翻 false、移除 legacy
  rules 读兜底。

### 3. Knowledge 反转机制：resolveStores 三态 store 优先级 flag

- `legacy`（现状/回滚态）：projection 追加末尾。
- `projection_with_legacy_fallback`：projection 排到 abrain-project **之前**，
  first-store-wins 选 projection；legacy 留数组补缺。
- `projection_only`：projection 在前，legacy 不进 dedup 取胜池（仅 doctor 可见）。
- 回滚 = 单 flag 切回 legacy，零数据迁移（legacy md 全程 dual-write 保活）。

### 4. 关键新硬门：projection-vs-legacy 语义字段级 diff 质量门（0 content-loss）

覆盖率 1.0 **必要不充分**。`legacy_import` 投影经确定性 renderer，与原 legacy md
**不逐字节相等**（多了 sediment_* frontmatter、Timeline 重写），逐字节 diff 无意义。
必须做 **语义字段级 diff**：对每个 (scope, slug) 比较 `parseEntry` 产出的
`title/kind/status/confidence/provenance/compiledTruth/triggerPhrases/relations`，
归一化差异放行、content-loss/截断/relation 掉边标红。门槛 = **0 content-loss**。

**opus 锐化（影响硬边界）**：中间态 `projection_with_legacy_fallback` **不保护内容质量**
——fallback 只在 read-error 触发，不做 per-field 回退。「能读但更差」的 projection 会
**静默盖住**好的 legacy md。所以质量门必须挡在**进入中间态之前**，不是只挡 projection_only。

## 反转前 4 个 blocker（一致）

1. **live-write 的 L1+L2 commit 归属（最硬）**：`projectKnowledgeEvidenceEvent` 只
   `fs.writeFile`，不自提交；提交搭 legacy writer 的 gitCommit。B3 已 flip
   `l2OutputRoot=repo`，每次 agent_end 都在 l2/ 留未提交 delta → B4 dirty-block 会让
   下次 brain-repo push 永久被拦。**必须二选一在反转前落地**：(a) sediment sidecar 拥有
   独立 commit + push lease（ADR0020 延伸），或 (b) 暂回 `l2OutputRoot=state` 直到
   sidecar commit 就位。
2. **REQ-009 accuracy-contract**：embedding/FTS 索引按 sourcePath 键控；projection 是
   新路径，反转前必须 reindex projection store，否则召回静默掉档。memory_search 不许
   降到 BM25/grep。projection-shadow 阶段跑 LLM rerank A/B。
3. **hot overlay 有界预算**：`readKnowledgeProjectionStores` 无 count/time/token 上限，
   一旦升为取胜 store 即违反 §6。必须加 maxCandidates/maxAgeMs/maxBytes 至少一道硬上限，
   或先把 hotOverlayEnabled 退回 false。同步 projector（projectOnWrite=true）下 overlay
   实际为空，可接受，但迁异步前必须建出有界 overlay。
4. **legacy dual-write 全程保活**：soak 期 legacy md 不删不停写，作中间态兜底 + 回滚目标。

## 三条硬边界（任一不满足不准翻 flag）

1. **质量门挡在中间态之前**：未产出「projection-vs-legacy 语义字段级 diff = 0
   content-loss」的入 git 报告前，连 `projection_with_legacy_fallback` 都不准开。
2. **写事务原子化先于读反转**：同一写事务 append L1 + project L2 + commit，legacy
   dual-write 保活；未提交/未索引状态下翻读 flag 会同时引爆 prepush 误杀 + read-after-write 缺口。
3. **同步前提 + 索引覆盖锁死**：反转仅在 projectOnWrite=true 同步投影下有效，embedding/FTS
   必须先 reindex projection 路径；迁异步前必须先建 §6 有界 hot overlay。

## 执行顺序（据此分批，每批 flag-guarded + 真实数据 + 提交推送）

- **Phase A（Constraint P4-a，并行低风险）**：退休 adjudicator 死代码/import；event-fail
  改 queued+diagnostic。
- **Phase B-prep（Knowledge 反转前置，硬门）**：① live-write L1+L2 commit 归属（sidecar
  commit lease 或暂回 state）；② projection-vs-legacy 语义 diff 质量门（doctor/CLI，入 git
  报告，0 content-loss）；③ hot overlay 有界预算或退 hotOverlayEnabled=false；④ reindex
  projection 路径 + memory_search A/B。
- **Phase C（Knowledge 读反转）**：三态 flag legacy → projection_with_legacy_fallback
  →（soak ≥1 周 + ≥3 session 无回归）→ projection_only。
- **Phase D（Constraint P4-b）**：Knowledge soak 通过后翻 fallbackToLegacyOnError=false。
