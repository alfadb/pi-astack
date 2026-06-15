---
doc_type: notes
status: active
---

# ADR 0031 Phase 1 — decay 影子判断设计共识(3×T0 design review, 2026-06-15)

3×T0(anthropic/claude-opus-4-8 · openai/gpt-5.5 · deepseek/deepseek-v4-pro)盲审「扩展 prompt-native aggregator 做 decay 判断」提案,**一致 GO-WITH-REVISIONS,无 NO-GO**。共识:decay 判断确属 skeptical historian 同一认知家族(`affirm_stale` 本就是证据门控的 decay verdict),prompt-native 满足 ADR 0031 §2.2,shadow-only 满足 §2.1,复用现有 M3 dry-run lifecycle-proposal 模式是正确的最小 Phase 1 落点。三条 P0 修订必须实现前并入。

## P0-1(一致):`decay_score` / `would_demote` 不放 `lifecycle_proposal` 内

`lifecycle_proposal` 只在 LLM 已有 §4.2 独立证据 + affirmative 判定该条目应改 standing 时才存在(`parseLifecycleProposal` 缺证据即丢弃)。把 decay 字段挂上去 → 覆盖坍缩到「已有 action 的条目」,恰是 decay 判断最不需要的 population;真正需要评分的是**大量未 promoted 的长尾**。

**决议**:aggregator 输出**正交** `entry_decay_assessments[]`(与 promoted/demoted 平级),写**独立 slug-keyed sidecar `decay-shadow.jsonl`**。`entry-lifecycle-proposals.jsonl` 逐字节不变(zero-behavior-change 免费拿到)。

## P0-2(一致):`would_demote` 必须继承 §4.2 独立证据门 —— disuse 单独永不触发

现有 prompt 已门控 lifecycle_proposal(`retrieved-unused` 单独 NEVER enough → 健康 disuse 走 demoted_signal 非 proposal)。新 `would_demote` 若自由 fire on 低 usage = §4 的 disuse→demote 后门,且会用 §4-illegal 信号训练未来 executor。

**决议**:prompt decay 段明确 —— `decay_score` 可把 disuse 当**上下文/颜色**,但 `would_demote` 仅在 §4.2 真值变化证据(`superseded_by` / `contradicted` / `version_stale`)present 时为 true;每行记 `demote_evidence_type`(null ⟺ would_demote=false;**usage-only 永不产生非空 type**)。

## P0-3(deepseek 显式 / opus graduation-gate / gpt P2):关联偏盲

aggregator 同模型 / 同 prompt / 同 run 兼做 archive-proposal + decay-score = 最强关联,正是 §5 警告的「curator/reviewer/decay-scorer 共享偏盲」。shadow 阶段是**标定问题非安全破口**(安全靠 §2.1 可逆地板,不靠 decay 准确度),Phase 1 可接受,但:

**决议**:(a) 记为 **graduation gate** —— shadow→真实 demote(Phase 3 flip)前,decay-scorer 必须是与 curator/reviewer **跨厂商去相关**的模型(同 T0 盲审 roster 纪律),否则静默 graduate 成关联偏盲;(b) prompt 加「关联偏盲自查」段;(c) shadow 验证按 `kind`×领域分组检测系统性偏斜。

## P1 共识

- **可复现回归打 invariant 不打 float**:0-1 LLM 分不可复现,不回归测其值(那是 direction.md §2 禁的机械门反模式)。改为 **deterministic infra-audit**:`would_demote_usage_only_count`(任一非零 = prompt regression)+ kind×disuse 分布统计。复用现有 `tier1_jaccard_shadow` 的 `false_merge_share`/`flip_ready` advisory 模式(合法 infra 兜底,非阻断门)。
- **deterministic scorer 复活为合法 AI-Native 兜底**:不作主决策路径,作**可复现影子基线**(回归对照组 B)+ 偏差检测(`|LLM_score − shadow_score| > ε` → audit flag,不阻断)。这调和了 gap 分析的原 deterministic 方案与 AI-Native(判别:不阻断 = infra ✓)。
- **canonical feed**:`entry-telemetry.jsonl`(sediment 侧,已含 echo_chamber + hysteresis + rolling window)做 decay 主 feed;`usage-metrics.json` 作 Phase-0 baseline,避免 historian 调和两套 usage 真值。

## P2

- `resurrection-rate-monitor` 扩展追踪 `would_demote` 结局(would_demote→后被复活 = 过激信号;would_demote=false→后被 archive = 漏判信号)→ 闭 §2.2 自标定回路。
- flag-gated(`forgetting.instrumentation` 或 sibling),shadow-only,默认 off。
- 回归:快照固化 LLM `decay_score`(不可复现)→ 双/三基线(完整 corpus / corpus−would_demote 快照 / corpus−shadow_score>θ deterministic 对照)对固定 query set 跑 recall@5;每 N 次 aggregator 跑一次回归,不逐次(避免过拟合单次 LLM 随机性)。

## 落地 schema(共识)

`decay-shadow.jsonl`(git-ignored sidecar,slug-keyed,默认 off):

```
{ slug, project_root, ts,
  decay_score: 0..1,                 // prompt-native, advisory color only
  would_demote: bool,                // 继承 §4.2 证据门
  demote_evidence_type: "superseded_by" | "contradicted" | "version_stale" | null,
  primary_driver: "supersede" | "contradiction" | "staleness" | "disuse" | "kind_atypical",
  decay_inputs: { window_retrieved_unused, decisive_streak, last_cited_at },  // context 非 driver
  falsifier, status: "shadow" }
```

+ deterministic infra-audit roll-up(`would_demote_usage_only_count` 等)做可复现回归钩子。

## 实现顺序(本设计落地前提)

aggregator 是**每轮 agent_end 跑的 live 背景模块** + prompt 是 tuned artifact → Phase 1 实现(改 prompt + 加正交输出 + sidecar writer)按本共识并入,并以 deterministic infra-audit 做零行为变化守卫。Phase 3 flag-off executor 与本扩展**正交**(消费既有 pending archive proposal,不依赖 decay 字段),可独立先落。
