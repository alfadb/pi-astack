# ADR0039 Constraint P4-a 实施后 4×T0 独立验证审计（2026-06-20）

> 全局规则「验证别自己说了算 / 证据不能来自做它的同一个 AI」要求的实施后独立复核。
> P4-a 的*设计*已经 2 轮 4×T0 共识（见 2026-06-20-adr0039-p4a-consensus.md）并已 SHIP
> （commit f87e80b），但最终 diff 此前只由主会话自审 + smoke。本轮 4 家跨厂 T0 **独立读
> 已落地代码**做验证审计（非重新设计），并显式轮询是否有更优替代方案。
> 参与 T0：anthropic/claude-opus-4-8、openai/gpt-5.5、deepseek/deepseek-v4-pro、
> moonshotai/kimi-k2.7-code。主会话只主持。

## 结论：4/4 VERIFIED，零 defect，alternative-design poll 一致「ship as-is」

四家独立在 SHIPPED 代码上逐条 trace，确认实现忠实于共识 v3：

- **GAP-1（终结分类）**：`index.ts:587-588` `isTerminalTier1Reject` 对
  `constraint_evidence_append_failed:*` 默认终结、唯一例外 `:write_failed`（覆盖 catch 块
  `:unknown`/任意 message 反例）。trace 确认：确定性 append 失败（invalid/path_violation/
  collision/blocked/unknown）→ checkpoint **前进**（不再无限 HOLD）+ `auditDirectiveRecall`
  以 raw-transcript 为键 fire（REQ-004 兜底，`coveredTexts=[]`）→ **无静默丢失**；
  `:write_failed`（IO 瞬态）→ 非终结 HOLD → 内容寻址幂等重 append。
- **GAP-2（storage-only 退休）**：`index.ts:4622-4638` rollback 写已是确定性
  `writeAbrainRule(semanticDedup:"off")` + `p4a_rollback_storage_only` 标记，**仅 rollback
  配置可达**（event_first 守卫早返回）；两 adjudicator 文件已删、无 dangling import；
  `tier1RuleSetAdjudication`/`tier1JaccardShadowAudit` 从 type/default/parser/schema/
  package.json/smoke 硬删；保留 `tier1JaccardCuratorLane`（curator-decision-writer.ts:118 live）
  + 两个 evidence rollback flag（index.ts:4535/4577 live）。
- **Phase 隔离（kimi）**：严格 write-path-only —— 未翻 `compiledViewInjection.
  fallbackToLegacyOnError`（rule-injector 默认 true 不变）、未碰 Knowledge/rule-injector 读路径、
  未删 `rules/**`。
- **可逆**：变更面有界，`git revert f87e80b` 机械干净。
- **Consumer 完整性（deepseek 全表）**：零 broken import；幸存引用全部 benign（历史 doc /
  forbidden-import guard / 注释 / 验证缺失的新 smoke / B5 故意保留的 orphan）。

### Alternative-design poll（显式轮询，4/4）
- 一致 **N / ship as-is**。两个候选「改进」均为已决、有据的选择：
  (a) `:write_failed` 持久化——Q-B 4/4 已选非终结 HOLD 不新建文件（.state 不入 git、相关性
  失败、无 drain 消费者、durable retry 留给未来 L3 SQLite jobs），重开会回退；
  (b) disposition 函数统一——`isTerminalTier1Reject` 与 `shouldAdvanceAfterResults` 故意分离
  （不同 writer / reason 词汇，3×T0 R1 Nit-A），统一反而耦合。

## 处置：零必需代码改动；仅清理 P4-a 删除遗留的 stale doc

本轮**未**改 P4-a 实现代码（VERIFIED）。仅做 3/4 家共同指出的、属 P4-a 删除范围内的
stale-doc 清理（引用已删文件 = 误导）：

- `docs/reference/smoke-tests.md`：删两行已不存在脚本（`smoke:tier1-jaccard-adjudication`、
  `dossier:tier1-adjudicator-prompt`）。`smoke:tier1-directive-defer` 脚本仍在，保留。
- `extensions/goal/judge.ts:163`：注释去掉对已删 `tier1-adjudicator` 的 dangling 引用。

## 非阻塞 follow-up（记录，不在本轮做）

1. `writer.ts` 死代码簇 `listRulesInScope`(3030) / `readRuleForAdjudication`(3054)：现仅被
   B5 故意保留的 orphan `applyTier1RuleAdjudication`(3112) 内部调用，零外部消费者——将来
   清理 pass 一并删（与 B5 orphan 一起）。
2. `index.ts:585` `TODO(adr0039-p4a-sanitizer)`：`:blocked` 臂今不可达（integration.ts:94-97
   硬编码 sanitizer `passed`），真 sanitizer 接线落地后补一个能触达 `:blocked` 终结分类的 smoke。
3. （gpt-5.5）可补一个 `_shouldAdvanceAfterAutoOutcomeForTests` 的行为级 smoke 覆盖
   `:write_failed` vs `:invalid` 前进语义，补充现有 source-string guard。
4. （kimi）若 rollback 真启用，监控 `p4a_rollback_storage_only` 行的近重规则增长（rollback
   故意关 semantic dedup）。
