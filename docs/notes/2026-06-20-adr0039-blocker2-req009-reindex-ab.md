# ADR0039 Phase B-prep blocker②：REQ-009 embedding freshness 跨反转 A/B（2026-06-20）

> 二轮共识列出的 Knowledge 反转硬前置 blocker②。确认 canonical=projection 反转
> 不回归 P6（memory_search recall/freshness/latency）。

## 问题

embedding 索引按 **slug + contentHashOf** 键控（`embedding.ts:62/65`），
`contentBasis = title + summary(派生自 compiledTruth,title) + compiledTruth + timeline`。
反转后 loadEntries 对同一 slug 从 legacy markdown 切到 l2/ projection markdown。
若 projection 的 title/compiledTruth 与 legacy 不一致 → contentHash 变 → dense 向量变 →
召回漂移（真回归）；若仅 timeline 不同 → 良性（staleOrMissingSlugs 自动重嵌恢复）。

## 方法（真实生产语料，确定性核心无 API 调用）

`scripts/dossier-adr0039-reindex-ab.mjs`（注册 `dossier:adr0039-reindex-ab`）：转译 memory
模块，对每个共享 slug 用**真实 parseEntry** 解析 legacy 与 projection markdown，用**真实
contentHashOf** 比较，分桶（identical / timeline-only / semantic），再驱动**真实
staleOrMissingSlugs + VectorIndex** 证明反转被精确检测且单次重嵌清零。

## 结果（生产 ~/.abrain，2763 共享 slug）

```
legacy_slugs: 3091   projection_slugs: 2763   shared: 2763   processed: 2763
buckets: identical=0  timeline_only_diff=2763  semantic_diff=0
stale_mechanism:
  flagged_after_flip: 2763
  flagged_equals_changed_set: true      ← staleOrMissingSlugs 精确等于变化集
  flagged_after_reembed: 0              ← 单次重嵌全清
  auto_recovered: true
PASS — 零语义漂移；精确 stale 检测；全自恢复 → 无召回回归。
```

- **recall**：semantic_diff=0 → projection 逐字节保留 title/compiledTruth（B2 单事件字节
  一致 + 忠实 payload 成立）→ dense 向量等价 → **召回不回归**。
- **freshness**：staleOrMissingSlugs 精确 flag 全部 2763 变化 slug（无漏报/误报），单次
  重嵌后 flag 归零 → **自恢复机制成立**。
- **latency**：反转会让全部 2763 条 stale（timeline 在 contentBasis 内，projection 重写
  Timeline）→ 触发一次性全量重嵌。等价于生产已在执行的标准 embedding 全量刷新
  （`~/.abrain/.state/memory/embeddings.json` 95MB，上次刷新 Jun 17）→ 无新增 latency
  量级，一次性、有界、自恢复。

## 反转时刻的执行

实际「post-flip embedding refresh」在 Phase C 反转生效时由现有 staleOrMissingSlugs →
重嵌路径**自动触发**（embedding 已配置：doubao-embedding-vision dim2048，sub2api）。
pre-flip 主动刷新只会重嵌 legacy（loadEntries 仍返回 legacy），无意义，故不在本阶段执行。
本 A/B 用 projection 实体 + 真实 staleOrMissingSlugs 模拟反转，是当前阶段的正确验证。

## 待定优化（非本批，需多 T0 共识 —— 改 freshness 键属记忆架构变更）

timeline_only_diff=2763 = 反转时每条都重嵌，纯因 timeline 进了 contentBasis 而 projection
重写了 Timeline。若把 volatile timeline 移出 contentBasis（或让 projection 保留稳定 timeline
表示），反转可变为**零重嵌 no-op**。这改变 embedding freshness 键，属记忆架构变更，按协议
需多 T0 共识后再做；记为候选，本批不动。

## 结论

REQ-009 不回归 P6：反转零语义漂移、stale 精确自恢复，latency 仅一次性全量重嵌（等价标准
刷新）。blocker② 清除。剩余 Knowledge 反转前置：blocker③ hot overlay 有界预算、blocker④
projection-vs-legacy 语义质量门（本 A/B 的 semantic_diff=0 已是该门的 contentBasis 维度强证据）。
