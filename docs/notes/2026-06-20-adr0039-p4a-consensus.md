# ADR0039 Constraint P4-a 多 T0 一致共识 + 实施计划（2026-06-20）

> `second-brain-memory-multi-t0-consensus-refactoring-protocol` 要求的 memory-domain
> 架构分片执行前共识记录。参与 T0（4 厂跨架构）：anthropic/claude-opus-4-8、
> openai/gpt-5.5、deepseek/deepseek-v4-pro、moonshotai/kimi-k2.7-code。主会话只主持，
> 不投决定票。**结论：2 轮后 4/4 收敛一致（v3 计划）**。

## 分片范围

Constraint P4-a：退休 Tier-1 写时裁决器（ruleset/Jaccard adjudicator），并修复 event-append
失败处置。**严格 write-path-only**：不动 P4-b（`fallbackToLegacyOnError`）、不动 Knowledge、
不删 `rules/**` markdown（仍是 compiler 输入）。

## R1（1 SIGN / 3 REVISE）关键纠正

主会话初始把 GAP-1 误述为「event-append 失败 → 信号被丢弃」。opus + kimi 独立读码证伪：
`reason="constraint_evidence_append_failed:*"` **不在** `isTerminalTier1Reject`(index.ts:566)
终结集 → checkpoint **被 HOLD 不前进** → 下个 agent_end 重处理；且 `auditDirectiveRecall`
已 fire（keyed by raw transcript）。**真实缺陷相反**：确定性失败（invalid/collision/
path_violation/blocked）非终结 → checkpoint **永久 HOLD**，每轮烧一次 classifier+append。
故修复远小于「新建 retry-queue」。

R1 锁定（unanimous，不再辩）：sanitizer-`blocked`=诊断 only 永不 raw 入账（安全门）；
`writeAbrainRule` 留（Tier-2 curator-decision-writer.ts:128 live）；`tier1JaccardCuratorLane`
flag 留（Tier-2 :118 live）；legacy rules markdown 留作 compiler 输入；recall-audit 以
**raw transcript hash** 为键（REQ-004；已在 index.ts:906/941 shipped）。

## R2（converge）：v3 = v2 + opus MUST-1/MUST-2

- deepseek **SIGN**、kimi **SIGN**、gpt-5.5 **SIGN**；opus 条件 SIGN（落 MUST-1+MUST-2+config-assert）。
- 三家 SIGN-er 各自独立声明 `write_failed` 是 append 错误词汇里**唯一** transient → 与 opus
  「default-terminal except `:write_failed`」逐字等价 → v3 是实质一致，非主会话破票。
- Q-A（现在退休 vs 推迟）：**4/4 现在退休**。opus 撤回 R1 推迟主张：其真实顾虑是
  **数据/读路径**（事件稀疏 2 条 vs 多条 legacy 规则），而该顾虑已被锁定项覆盖（legacy
  markdown 仍是 compiler 输入、P4-b 未动、Knowledge 未动）；Part 2 只退休**写**裁决器，
  rollback 以确定性 storage-only `writeAbrainRule` 保留，git revert 是真代码回滚。
  唯一附加门：config-assert smoke 必须同 PR 落绿。
- Q-B（write_failed 持久化）：**4/4 取 (ii)** 非终结 HOLD，**不新建文件**。deepseek 撤回 (i)，
  认同四点：①相关性失败（同一 .state fs 刚失败）②`.state` 不入 git（§4.1）= 设备本地孤儿
  ③新 drain-loop 活性义务无消费者（§12）④持久 retry 应落未来 L3 SQLite jobs 表（§4.5）。

## v3 实施计划（4/4 SIGN）

**Part 1 — GAP-1 真修复**（index.ts `isTerminalTier1Reject`）：
任何 `constraint_evidence_append_failed:*` reason **终结**，**唯一例外** `:write_failed` 非终结。
（MUST-1：用「默认终结 except write_failed」而非闭合白名单，覆盖 catch 块的
`:unknown`/任意 message 反例 index.ts:~4508。）`:blocked` 防御性归类 + grep-able TODO
（今不可达：integration.ts:94-97 硬编码 sanitizer `passed`）。

**Part 2 — GAP-2 storage-only 退休**：
- 把 `if(tier1RuleSetAdjudication){resolveRuleWrite}else{Jaccard resolveTier1JaccardHit/
  runTier1JaccardAdjudication}` 整块（index.ts ~4613-4701）替换为单条确定性 storage-only
  `writeAbrainRule(draft,{exactDuplicateAsDedup:true,semanticDedup:"off"})`。该块仅在 rollback
  配置可达（writer disabled / mode≠event_first / 某 legacy* flag=true）→ rollback 保留为
  storage-only（ADR §P4「writer 只保留基础设施写文件能力」）。
- MUST-2：删去死变量 `adjudicationLaneOn`(index.ts:4467)。
- 删 index.ts imports：`resolveRuleWrite`、`resolveTier1JaccardHit`、`runTier1JaccardAdjudication`、
  `readRuleForAdjudication`、`listRulesInScope`（块外无消费者）。
- 删文件：`tier1-ruleset-adjudicator.ts`、`tier1-adjudicator.ts`、
  `scripts/smoke-tier1-ruleset-adjudication.mjs`、`scripts/smoke-tier1-jaccard-adjudication.mjs`、
  `scripts/dossier-tier1-adjudicator-prompt.mjs`。`applyTier1RuleAdjudication`(writer.ts:3112)
  留 1 版孤儿（kimi B5）。
- 硬删 flag：`tier1RuleSetAdjudication`、`tier1JaccardShadowAudit`（settings.ts type/default/
  parser + schema + package.json scripts + smoke-pr1-adr0028 断言）。
- 留 flag：`tier1JaccardCuratorLane`（Tier-2 live；index.ts 内停读，curator-decision-writer.ts:118
  保留）、`legacyFallbackOnEventFailure`、`legacyRuleWriteOnSuccessfulEvent`（evidence 回滚 →
  现 fall through 到 storage-only create）。
- 保留 forbidden-import guard 列表（smoke-constraint-evidence-event.mjs:660-661 /
  smoke-constraint-shadow-compiler.mjs:948-949）：守 P2 模块不引入这些符号，删后仍成立。
- 新增 config-assert smoke（opus 硬门）：断言部署 config（event_first + 两 legacy flag false）
  使 storage-only rollback 路径不可达 + adjudicator 文件已删 + 两 flag 已移除。
- rollback 行为变化（kimi 非阻塞）：rollback 丢 Jaccard 近重门（semanticDedup:'off'），近重
  检测移到 evidence normalizer + compiler，recall-audit 兜底；加 grep-able 行内注释说明。

## 边界

仅 write 路径；不动 P4-b/Knowledge/`rules/**`。每批 flag-guarded + 真实数据 + 内外层提交推送。
