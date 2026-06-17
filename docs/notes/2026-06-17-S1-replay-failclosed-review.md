---
status: review-passed
date: 2026-06-17
task: S1 — sediment multi-view replay project resolution → fail-closed
---

# S1: multi-view replay 的 project 解析改 fail-closed

## 背景(缺陷)

`sediment` 把知识候选暂存到 staging,在每次 agent_end 用 replay 循环写入 markdown 记忆库。
记忆库按 project 分(13 个 project)+ 一个全局 `world` 库。staged 候选记录
`origin_project_id`/`origin_project_root`(capture 时的活动 project)。replay 写入时目标是
**当前会话 binding**(`replayCwd`),不是 captured origin。

`isOtherProjectEntry` 在 origin≠current 时 defer,但 **origin 缺失时返回 false(fail-open)**,
导致候选被写进恰好活动的 project。已证实事故:kihh 领域决策 `ayhz0001-…-minimal-strategy`
被误写进 pi-global(两份逐字节相同、两次提交相隔 26 秒、均 "captured from multi-view
staging replay")。详见根因分析(plan 文档 S1 backlog 条目)。

## 修复

唯一写入收口是 `retryApprovedWriterOnly`(两个调用点:approved_decision 快路径 + runMultiView
后的成功路径,均汇入 `deps.writeApprovedToBrain` → `executeCuratorDecisionToBrain({projectRoot:
replayCwd})`)。在其 `try` 顶部加 **fail-closed binding gate**,用**权威的 `finalDecision.scope`**
(reviewer 可经 `pass1.scope` 把 project 提升为 world,所以 proposer scope 不可信):

- `scope:"world"` 或 global-rule create(`zone:"rules"`+`ruleScope:"global"`)→ 直接写
  (路由到全局库,与 binding 无关);
- project + `origin==current`(`classifyProjectPlacement`→"match")→ 写;
- project + origin 缺失(→"unplaceable")→ `archiveTerminalOrAudit` soft-archive,
  记 `terminal_no_origin`,**不写**(拒绝写入环境 project;重要洞见会在绑定项目的会话里被
  重新 capture);
- project + origin≠current(→"mismatch")→ defer(纵深防御,pre-filter 已先拦)。

pre-LLM `isOtherProjectEntry` **保持不变**:若据非权威的 proposer scope 去 defer 未钉 origin
的候选,会误弃 reviewer 本会提升为 world 的洞见。

新增 `terminal_no_origin` 指标(ReplayOutcome / ReplayBatchResult / init + index.ts 汇总日志)。

新增纯函数 `classifyProjectPlacement(originId, originRoot, deps)` → `"match"|"mismatch"|
"unplaceable"`(导出供测试),要求 id 与 root **都**存在且 `path.resolve` 相等才算 match。

### 已知窄边(显式接受)

rule-lifecycle(archive/delete)经 slug 查找解析 global vs project,无法在 replay 层不做
rule-file I/O 就分辨。未钉 origin 的 global-rule lifecycle(**仅遗留**——新 capture 必钉 origin)
会被 soft-archive 而非应用。罕见、可审计、可恢复,**绝不误写**。

## 跨厂商 T0 评审

3 家不同厂商盲审(读真实代码):

- **openai/gpt-5.5 → SHIP**:验证单收口(两调用点均汇入 writeApprovedToBrain)、写入确实落
  `replayCwd`、`"scope" in finalDecision` 类型安全、abandon-vs-defer 取舍正确、正常 binding
  下不会误 defer。指出 smoke 可补 post-review 路径与 pinned-match 等。
- **moonshotai/kimi-k2.6 → SHIP-WITH-CHANGES**:逐条验证单收口/写入目标/skip 类型安全;
  确认 abandon 取舍正确、world 不被误 defer;要求补 partial-origin 与 world+pinned-origin
  smoke,mismatch 分支审计串加 defense-in-depth 说明。
- **deepseek/deepseek-v4-pro → 超时(部分)**:正在追 `zone:"rules"`+`ruleScope:"global"`
  边界即被截断——该线索**确为真问题**。

### 落地的意见

- deepseek 的 zone:rules 线索 → 加 `isGlobalRuleCreate` 豁免(global rule create 路由到全局
  rules 库,无误写风险,不应被 project gate 弃)。**移除该豁免后回归守卫 smoke 确实失败**,
  证明豁免 load-bearing。
- kimi 的 partial-origin + 审计串说明 → 已落地。
- kimi 的 world+pinned-origin → 已有 world-no-origin 覆盖 world 豁免分支(pinned 不改变 world
  分支),未单列。
- gpt-5.5/kimi 的 post-review 路径 → 与 approved 快路径同一 `retryApprovedWriterOnly` 收口,
  smoke 经 approved 快路径确定性驱动该收口已足。

## 验证

- `tsc --noEmit`:0 error。
- `smoke:memory` 集成用例(`scripts/smoke-memory-sediment.mjs`,搜 "S1"):
  - unpinned project create → `terminal_no_origin`/不写/soft-archive;
  - unpinned **world** create → 仍写(证 scope-aware、不丢 world);
  - **partial origin**(id 有 root 无)→ unplaceable/不写;
  - unpinned **global-rule** create → 仍写(回归守卫)。
  - 全部经"故意打破 → 失败 → 还原"确认真跑(非死代码)。
- 回归:`smoke:staging-ageout` 44/44、`smoke:staging-resolver` 30/30、`smoke:pr-c-hygiene` ✅。

## 提交

- `fix(S1): sediment replay project 解析改 fail-closed(待 T0 评审)`
- `fix(S1): 落地 T0 评审意见 — global-rule 豁免 + 补 smoke`
