# ADR0039 Phase C step 1 反转已执行：canonical=projection（2026-06-20）

> 真相面反转里程碑。Knowledge canonical 读从 legacy markdown 反转为 l2/ 投影
> （L1 Evidence Events 的确定性派生视图），legacy 作 fallback。中间态
> `projection_with_legacy_fallback`，按 Phase C 多 T0 共识执行。

## 执行内容

- 生产 `knowledgeProjector.canonicalReadMode` = `projection_with_legacy_fallback`（outer aa1f590）。
- flag 热读：`loadPiStackSettings` 每次 readFileSync 无缓存，loadEntries 每次重读 → 即时生效、热回滚。
- 机制（段 A，inner ea352fd）：loadEntries 把无界 stable-view（l2/views/knowledge）插到 stores
  最前，first-store-wins 选 projection；legacy 留池补缺；overlay 末尾。

## 反转前置（全部完成 + 生产验证）

- 多 T0 二轮共识（定序）+ Phase C 共识检查点（CONDITIONAL GO step 1）。
- blocker① L1/L2 commit 归属（writer 原子 sweep）。
- blocker② REQ-009 embedding freshness（零语义漂移 + 自恢复）。
- blocker③ hot overlay 有界预算（+ 诊断路径修复：改写 .state）。
- blocker④ projection-vs-legacy 语义质量门（kind/status/provenance/confidence 0%，relations 0.072%）。
- pi 两次重启（激活 blocker① writer sweep + repo 投影；激活段 A flag 代码）。
- world-reads-l2 泄漏修复（rg 绝对路径匹配 → home 排除 globs 默认开 + stable-view opt-out）。

## 确定性探针验证（真实生产语料，dossier:adr0039-phase-c-flip-probe）

不依赖运行中 pi 或 memory_search（其 LLM 检索在本 session 返回 [] —— 与 canonicalReadMode
无关，flip+revert 均 []，是环境/LLM-search 事项，另行排查）。探针用真实 scanStore +
readKnowledgeStableViewStores：
- legacy world 171 / project 1411；stable-view world 171 / project 1130。
- **world-reads-l2 泄漏 0/0**；stable-view source_path 全在 l2/；**shared 全部 projection 胜出**
  （world 171/171，project 1130 winner correct）。
- legacy-only 281（project 非 knowledge / 未投影项）正确走 fallback —— 中间态语义成立。

## Soak（step 1，每日 canary）

- `npm run dossier:adr0039-phase-c-flip-probe`（projection 胜出 + 无 l2 泄漏 + fallback）。
- `npm run dossier:adr0039-reindex-ab`（blocker②④ 质量门 0 content-loss）。
- `npm run check:adr0039-integrity`（手动 local integrity checker：l1↔l2 reconcile + dirty-view；不是 live hook/runtime gate）。
- 检查 `.state/sediment/knowledge-projection/overlay-budget.jsonl`（overlay 溢出，预期但 stable-view 胜出故惰性）。
- memory_search recall 人工抽查（注意 LLM-search [] 混淆需先排除）。
- 回归触发（任一）→ 单 flag 回 `legacy`：①质量门回归 ②recall 退化 ③手动 integrity checker 反复报告 dirty view
  ④projection 胜出探针 fail ⑤sidecar/writer 提交分叉。

## 进入 projection_only 的门（step 2，未到）

- step 1 soak ≥1 周 + ≥3 session 无回归。
- **coverage=1.0 over ALL read entries**（不只 knowledge）——当前 project 有 281 legacy-only，
  projection_only 会让它们消失，故必须先把这些纳入投影或确认可弃。
- legacy 物理删除 ≥2 周零事故前不做（dual-write 全程保活）。

## 回滚

单 flag `canonicalReadMode` → `legacy`，热生效，零数据迁移（legacy markdown 全程 dual-write）。
