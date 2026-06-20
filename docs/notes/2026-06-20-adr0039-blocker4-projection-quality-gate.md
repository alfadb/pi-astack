# ADR0039 Phase B-prep blocker④：projection-vs-legacy 语义质量门（2026-06-20）

> 二轮共识列出的 Knowledge 反转最后一个硬前置 + opes/deepseek 锐化的核心新门：
> 覆盖率 1.0 必要不充分，反转前必须证明 projection 与 legacy 在**所有读/搜索可见维度**
> 语义等价（0 content-loss）。本批把 blocker② 的 A/B 从 contentBasis 扩到字段级。

## 方法

扩展 `dossier:adr0039-reindex-ab`（同一脚本，真实 parseEntry 解析真实生产语料）。除
contentBasis（title/summary/compiledTruth/timeline）外，对每个共享 slug 逐字段比较
**contentBasis 之外**的读/搜索可见维度：kind、status、provenance、confidence、relations
（relatedSlugs 作集合比较）。生成 pass/fail 阈值。

## 阈值（directive）

| 维度 | 阈值 | 理由 |
|---|---|---|
| kind | **0%** loss（精确） | canonical 条目反转后丢 kind 是硬回归 |
| status | **0%** loss（精确） | 同上；status 影响默认过滤 |
| provenance | ≤5% 分歧 | 可在小容差内重新派生 |
| confidence | ≤5% 分歧 | 派生启发值，小差良性 |
| relations | ≤5% 分歧 | relatedSlugs 集合可小幅重算 |

## 结果（生产 ~/.abrain，2767 共享 slug）

```
shared_slugs: 2767   processed: 2767
field_gate:
  kind:       diverged=0     ratio=0       threshold=0%    pass=true
  status:     diverged=0     ratio=0       threshold=0%    pass=true
  provenance: diverged=0     ratio=0       threshold=≤5%   pass=true
  confidence: diverged=0     ratio=0       threshold=≤5%   pass=true
  relations:  diverged=2     ratio=0.072%  threshold=≤5%   pass=true
field_gate_pass: true
PASS — blocker④ field gate.
PASS — blocker② REQ-009（同 run：semantic_diff=0、stale 精确自恢复）。
```

- **kind/status/provenance/confidence：全 0 分歧** —— projection 逐条保留这些字段，零丢失。
- **relations：2/2767 = 0.072%**，远低于 5%。两例都是 projection 比 legacy **少一个关系**：
  - `semi-auto-mode-blocks-map-hole-clicks...`：少 `map-hole-click-gate-uses-currentworkmode...`。
  - `pi-astack-second-brain-compliance-gap-catalog-2026-05-29`：少一个**指向自身**的 self-relation
    （实为修正，self-relation 无意义）。
  - 二者均在容差内，且为关系收缩而非语义内容丢失。

## 结论

projection 与 legacy 在**所有读/搜索可见维度**（contentBasis + kind/status/provenance/
confidence/relations）语义等价：kind/status/provenance/confidence 0% 丢失，relations
0.072% ≤ 5%，叠加 blocker② 的 title/compiledTruth 零漂移。**canonical=projection 反转
内容安全**，blocker④ 质量门 PASS。

## 反转闸门状态

Knowledge 反转 4 个硬前置全部清除：
- blocker① L1/L2 commit 归属 ✓（代码 + 生产验证）
- blocker② REQ-009 embedding freshness ✓（零语义漂移 + 自恢复）
- blocker③ hot overlay 有界预算 ✓（count/token/time cap + overflow 诊断 + 集成测试）
- blocker④ projection-vs-legacy 语义质量门 ✓（本批，0 content-loss）

**下一步**：Phase C（canonical=projection 反转）是真相面反转 = 记忆架构变更。按
`second-brain-memory-multi-t0-consensus-refactoring-protocol`，**必须先记录多 T0 共识检查点**
（主会话不投决定票）才能执行 resolveStores 三态 flip。质量门已为该共识提供证据基础。
