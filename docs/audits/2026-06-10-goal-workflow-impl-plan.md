# Goal/Workflow 能力 + ADR 0028 收尾 — 实施计划 v2（3×T0 Round-1 收敛版）

Date: 2026-06-10. 状态：**v2 收敛，可开工**。
来源链：deep-research 报告（ADR 0024-0028 gap 审计 + Claude Code dynamic
workflows / Codex /goal / token-saver-loop 调研，6 worker + citation pass）
→ 实施计划 v1 → 3×T0 Round-1 盲审（claude-opus-4-8 / gpt-5.5 /
deepseek-v4-pro，互不可见，均带仓库 read 权限验证 file:line）→ 主控收敛。

Repo: /home/worker/.pi/agent/skills/pi-astack。ADR 基准: docs/adr/0024~0028。
后续会话接续实施时：**先读本文档全文**，按 §PR 切分顺序执行，每个 PR 沿用
既定工作流（实现 → 3×T0 盲审 → 收敛 → push）。

## Round-1 verdict 矩阵

| Phase | opus-4-8 | gpt-5.5 | deepseek-v4-pro | 收敛结果 |
|---|---|---|---|---|
| P0 工程债 | ACCEPT/MODIFY | MODIFY | ACCEPT/MODIFY | v2 已折入全部修正 |
| P1 goal | ACCEPT(MODIFY) | MODIFY | MODIFY | v2 已折入（provenance 隔离 + re-entrancy） |
| P2 workflow | MODIFY | **REJECT** | MODIFY | 拆"实验通道/生产"两级化解（见 §P2） |
| P3 成本分层 | ACCEPT | MODIFY | ACCEPT | 并入 P2，advisory-only |

## 已核验事实（不要重查）

- **O1 已闭合：pi extension 可注入合成续行 turn。**
  `pi.sendUserMessage(content, { deliverAs: "followUp", triggerTurn: true })`
  （pi docs extensions.md:1337-1363，三家独立核验）。v1 草案的"降级为
  footer 提示"分支**删除**。
- **R4' outcome edge 已实现，勿重做**：`applyRuleOutcomeEdge`
  （sediment/index.ts:700-835，CONTRADICT→contested + MATCH 自回声扣除，
  commit 5a9f958）。Round-1 deepseek 标"完全缺失"是误判（其指计划未列，
  因为代码已 shipped）。本计划只新增 goal-outcome 与该 edge 的**集成**。
- **R3' 召回审计已实现，勿重做**：`directive_recall_audit` keyed on
  `raw_user_role_transcript`（sediment/index.ts:646-652，smoke
  scripts/smoke-pr1-adr0028.mjs:341-349）。
- **Tier-1 谓词契约 spec 已在代码注释里**：validation.ts:18 写明
  `provenance==='user-expressed' ∧ is_directive ∧ durable`（**无 confidence
  项**），而实现（correction-pipeline.ts:34-44）用 `confidence>=8` 替代了
  `is_directive` —— P0.1 是"对齐 spec"而非"新设计"。
- **Tier-1 静默 dedup 在违反 no-loss-with-tell**：Tier-1 直写经
  writeAbrainRule（index.ts:3846）→ `findSimilarRuleSlug` 无条件拦截
  （writer.ts:2207-2210，返回 `status:"deduped"`），index.ts:3876 仍标
  `signal_consumed:true` —— 用户重述指令被静默消费。P0.3 是修复，优先级高。
- **singleFlight KNOWN GAP 属实**：git-sync.ts:40-46 自注；sediment writer
  直调 commit 在 writer.ts:2232；`gitCommitAbrain` 被 rules/workflows/
  about-me 多 writer 复用 → 修复必须落 `_shared`，不能只接 rules writer。

## 三家共识裁定（O2-O5）

- **O2（R5' 调和，2:1 否决 v1 的机械 UPDATE）**：Tier-1 路径 Jaccard 命中
  → **既不 skip 也不机械 UPDATE**，升格为 curator LLM 裁决（邻居已加载，
  输出空间 {update, merge, create}，**排除 skip/stage**，符合 R2'+R5'）；
  curator 失败/超时 → 按 R2' 原文走**确定性 default-zone create**（接受可见
  的近重复，靠 tell + R4' 事后纠正）。exact body-hash → 幂等 no-op（保留，
  确定性门合法）。与 2026-06-07 write-time dedup T0 共识的调和：该共识针对
  exact duplicate 场景，Jaccard 相似 ≠ exact duplicate，两者不冲突，PR
  描述须显式引用此调和。Tier-2 路径：Jaccard 退为 curator 邻居预过滤。
- **O3（ADR）**：必须先 ADR 后实现。0029/0030/0031 为话题预留号
  （ADR 0027 §6 + ADR 0028 编号说明），goal/workflow runtime ADR 取
  **0032**（起草时再确认是否仍为下一空号）。goal 部分可轻量（ADR 0027 伞
  下小节或与 workflow 合篇）；workflow 部分必须含 **H5 论证**：静态声明式
  DAG 编排 ≠ hub 动态派工，故实验通道不触 ADR 0030 gate；**生产化晋升
  blocked on ADR 0030 evaluation harness**（化解 gpt REJECT）。
- **O4（DSL）**：**JSON**（JSON Schema 约束），非 YAML（agent 生成缩进易
  错）、非沙箱 JS（任意代码执行面，破 C3' infra-structured）。配
  `workflow dry-run` 校验命令。
- **O5（confidence 退出 directive kill 门）**：三家一致退出。收敛谓词：
  `signal_found ∧ durable ∧ !target_entry_slug ∧ provenance==='user-expressed'
  ∧ (is_directive || confidence>=8)`
  —— is_directive 豁免 confidence 门（召回偏置）；conf>=8 保留为
  **非 directive** durable 信号的既有通路（迁移安全）。confidence 降级用途：
  audit 字段 + tell 文案标注（is_directive ∧ conf≤2 → tell 加 "⚠️ low
  confidence"，仍写入）。

## Phase P0 — ADR 0028 工程债 + singleFlight

### P0.1 is_directive（对齐 validation.ts:18 spec）
- `CorrectionSignal` 加 `is_directive?: boolean`（correction-pipeline.ts:47
  区域）；classifier prompt v1→v2：OUTPUT JSON 加字段 + 召回偏置段 + 显式
  **abstain 清单**（疑问句"能不能用 Y?"；否定祈使"不要记这条"=correction
  非 preference；用户复述已有规则；用户引述他人祈使句→应由 quote_source
  挡）。新增独立谓词函数 `isTier1Directive()`，避免 shouldEscalateToCurator
  语义膨胀。谓词按 O5 收敛式改。
- smoke fixtures：祈使/疑问/陈述/否定祈使/引述他人祈使（5 类）。

### P0.2 跨 turn fail-closed（收敛解释，附 walk-back 注记）
- `deriveProvenance`（correction-pipeline.ts:251-275）改为唯一 turn 映射：
  quote 命中**不同 role 的多个 turn** → fail-closed 降 Tier-2（ADR 0028 §6
  规范）；quote 仅命中**多个 user-role turn** → 仍判 user_message（role 派生
  无歧义，重复陈述是更强信号），但 audit 记 `multi_match:true`。
  此为对 ADR"跨多 turn fail-closed"的收敛解释（fail-closed 针对 role 歧义，
  非同 role 重复）；若 dogfood 出现同 role 多命中误判案例，回看本段。
- 更新函数头注释（现注释写"user-role match wins"，与新策略需一致）。

### P0.3 R5' 调和（按 O2 收敛方案）
- writer.ts:2207 Jaccard 拦截改造：Tier-1 调用路径上 `findSimilarRuleSlug`
  命中 → 不返回 deduped，改走 curator 裁决 lane（输出 {update,merge,create}，
  禁 skip/stage）；curator 不可用 → 确定性 create。update 路径带 **evidence
  行级去重**（同 quote 不重复 append）防膨胀。
- **迁移护栏（ADR 0028 §9.4，三家都点名缺失）**：feature flag
  `sediment.tier1JaccardCuratorLane`（default off）+ dual-path shadow audit
  ——新路径只读对照、旧路径唯一写者，确认召回不退化再切；保留旧 gate 为
  回滚路径。
- Tier-2：Jaccard 降为 curator 邻居预过滤（不再自主 gate）。

### P0.4 清理
- 删 `shortWindowClassifierOnly` 特例（index.ts:2121, 2649 整段），短窗口
  并入统一 `tryAutoWriteLane` no-loss 语义，保留 tiny-window 资源预算。
- drain 残留（index.ts:2435-2442）升为 blocking：
  `auto.kind==="tier1_direct" && !captured` 时不推进 checkpoint；drain 不再
  自行越过 held window。
- 修 index.ts:23 过时头注释（"optimistically advances"已不符实际）。

### P0.5 R3' tell 契约（分操作类型，落 dispatch/resultSummary 层）
- create → "📌 new rule: <title>"；update → "📝 updated rule: <title>"；
  supersede → "🔄 replaced: <old> → <new>"；contest → "⚠️ contested: <title>"；
  exact-dedup → "♻️ already noted: <title>"；rejected-with-recall →
  "⚠️ rule rejected (<reason>), recall flag recorded"。
- 落点：writer notify 在 dispatch 层（writer.ts:1979），契约实现于
  dispatch/resultSummary，不在 writer 内部。

### P0.6 singleFlight（拆 a/b）
- **P0.6a（独立先发）**：singleFlight 实现外提到
  `_shared/git-singleflight.ts`；`gitCommitAbrain` 全部调用方（rules/
  workflows/about-me writers + git-sync auto-merge）统一接入；
  writer.ts:2232 直调点收编。smoke：并发 commit 不抢 `.git/index.lock`。
- **P0.6b（随 P2）**：`_shared` 通用 per-key 写锁原语（workflow stage 输出
  文件域，与 abrain git 锁域正交）。

## Phase P1 — goal extension（新 extensions/goal/）

- **状态**：`.pi-astack/goal/<sessionId>.json` 为物化视图 +
  `pi.appendEntry` 记录 session-local goal events 为事件源（防 session
  fork/resume 漂移）。schema：{schema_version, objective,
  success_criteria[], status: active|paused|achieved|abandoned,
  budget{max_continuations, max_wall_minutes}, counters, anchor(C6)}。
  stale 文件 GC（按 mtime + session 不存在清理）。
- **/goal 命令**：set/pause/resume/clear/status。用户设 goal = C4' 授权。
- **注入**：每 turn 注入活动 goal + 进度（time-injector 模式），对治
  compaction goal drift。
- **续行（auto-continue）**：agent_end → 快档 LLM 判
  achieved/blocked/continue（认知层）；预算/安全边界 structured。续行经
  `pi.sendUserMessage(..., {deliverAs:"followUp", triggerTurn:true})`。
  **硬约束**：
  1. **re-entrancy guard**：注入前**先递减** counters/预算（续行 turn 会再
     触发 agent_end，后递减 = 无限自触发）。
  2. **provenance 隔离（INV-IMPLICIT-GROUND-TRUTH 关键防线）**：续行消息带
     机器前缀 `[pi-goal-continuation source=extension goal_id=...]`；
     sediment 侧 deriveProvenance / classifier 须把带该前缀的 user-role
     turn **排除出 user-expressed Tier-1**（机器合成 ≠ 用户 ground truth）。
  3. 每次续行 notify（tell-not-ask）；blocker → prompt_user；
     budget 耗尽 → 停 + notify。
- **R4' 集成**：goal achieved/blocked/abandoned 写 injection ledger
  （`type:"goal_outcome"`），避免 goal 自身成 write-only loop。
- **kill switches**：`goal.enabled`、`goal.autoContinue`（分两个 PR 上线：
  先 state/commands/injection，后 auto-continue）。
- smoke：状态机迁移、预算耗尽停、pause/resume、续行不自触发（预算先减）、
  续行消息被 sediment Tier-1 排除。

## Phase P2 — workflow engine（新 extensions/workflow/）+ P3 成本分层

**前置**：ADR 0032 起草并过 3×T0（含 H5 论证：静态声明式 DAG ≠ hub 动态
派工）；P0.6a/b。**ADR 排在 P1 之后起草**——goal 实战会喂 runtime 语义。

**两级通道（化解 gpt REJECT）**：
- **v1 = 实验通道**：`workflow.enabled`（default off）+
  `workflow.readOnly=true`（worker 默认 read-only tools）；固定/显式 DSL，
  无动态拓扑变更；mutating stage 沿用 PI_MULTI_AGENT_ALLOW_MUTATING 且必须
  跑在 dispatch 出的 sub-agent（主会话 read-only，ADR 0003）。
- **生产化晋升 blocked on ADR 0030 evaluation harness**（H5）。

**设计要点**：
- DSL：JSON Schema 约束的 JSON。stages[{id, kind: agent|parallel, model,
  thinking, prompt, tools, on_fail: retry|degrade|abort, max_retries}]。
  `workflow dry-run` 先校验后执行。
- 映射：agent→dispatch runInProcess；parallel→dispatch_parallel（4 并发
  cap，**嵌套拒绝** + cap 不被击穿，加 smoke）；每 stage C6 锚点
  （subtask_seq 由 workflow engine 经 deriveSubAgentAnchor 模式分配）+
  C5 四态 + heartbeat；stage 间数据契约校验（output path 存在性）+ 整体
  timeout guard。
- 中间结果写 `.pi-astack/workflow/<anchor>/stage-<id>.md`（经 P0.6b
  per-key 锁），只回传 path + 摘要。
- 失败策略 = 四向裁决映射：通过=completed / 同级重试=retry /
  降级=degraded / 人工=cancelled+prompt_user。
- **resume 前向兼容**：v1 不实现 resume，但 per-stage completion 必须落盘
  （state layout 可加 resume 不破 schema）——stage 失败后修复再续是核心
  场景，不能锁死。
- 保存：**仅用户显式触发** `writeAbrainWorkflow` 入 abrain workflows zone。
  **自污染围栏（opus A8）**：workflow trace 为 assistant-observed，默认不进
  Tier-1 注入面；"sediment 观察 trace 自动沉淀 workflow"推迟到独立后续
  ADR，本期不做。
- P3（并入）：stage model 缺省策略接 model-curator 注解——检索/执行=便宜
  档，裁决/综合=T0；advisory-only，不改变 T0 盲审 cost-blind 原则，不把低
  价模型用于最终 correctness 裁决；重试计数/降级 structured，裁决 prompt
  认知层。

## PR 切分与顺序（收敛版）

| PR | 内容 | 依赖 | 备注 |
|---|---|---|---|
| PR-1 | P0.6a `_shared/git-singleflight` 接入 | 无 | 最小独立，先发 |
| PR-2 | P0.1 is_directive + 谓词对齐 + prompt v2 + 5 类 fixtures + P0.5 tell 契约 | 无 | CorrectionSignal API 尽早定 |
| PR-3 | P0.2 唯一 turn 映射 fail-closed + 函数头注释 | PR-2 | 含 multi_match audit |
| PR-4 | P0.3 Jaccard→curator 裁决 lane + shadow audit + feature flag | PR-2 | 行为变更，独立审；引用 06-07 dedup 共识调和 |
| PR-5 | P0.4 清理（shortWindow 删除 + drain blocking + 头注释） | PR-2 | 删多写少 |
| PR-6 | P1a goal：state/commands/injection（无 auto-continue） | 无（可与 P0 并行） | goal.enabled flag |
| PR-7 | P1b goal：auto-continue + provenance 隔离 + re-entrancy + R4' 集成 | PR-6；provenance 隔离需 sediment 侧小改（可并 PR-3） | goal.autoContinue flag |
| PR-8 | ADR 0032 起草 → 3×T0 合议 | PR-6/7 实战反馈 | 文档 only，含 H5 论证 |
| PR-9 | P2a DSL + parser + dry-run + smoke | PR-8 accepted | |
| PR-10 | P2b 执行器 + C5/C6/heartbeat 集成 + P0.6b 锁 + P3 成本策略 | PR-9 + PR-1 | workflow.enabled/readOnly flags |

每 PR：实现 → 3×T0 盲审 → 收敛 → push。PR-4 是行为变更风险最高项，shadow
audit 期间观察 ≥1 周真实负载再切默认。

## 回滚/开关清单

`sediment.tier1JaccardCuratorLane`（PR-4，default off→灰度）、
`goal.enabled` / `goal.autoContinue`（PR-6/7）、
`workflow.enabled` / `workflow.readOnly`（PR-10）、
旧 Jaccard gate 代码保留至 shadow audit 通过后一个版本再删。

## 显式不做 / 推迟

- workflow 自动沉淀（sediment 观察 trace 学习 workflow）→ 独立后续 ADR。
- workflow resume 实现 → v2（但 v1 state layout 必须前向兼容）。
- hub 动态派工 / 动态拓扑 → ADR 0030 之后。
- 沙箱 JS workflow → 不做（C3' 边界）。
- P0.2 同 role 多命中降级（deepseek 场景 3）→ 不做，audit 观察；误判案例
  出现再回看。

## 走偏信号（命中即回看本计划）

- shadow audit 期 Tier-1 召回下降 → PR-4 方案回滚，重审 O2 裁定。
- goal 续行出现 sediment 把合成消息写成 user-expressed 规则 → provenance
  隔离失效，立即关 goal.autoContinue。
- workflow stage 并发写锁竞争频繁 → P0.6b 锁粒度需重设计。
- is_directive 召回偏置导致周新增规则 >3 条误写 → 回看 O5 谓词，考虑恢复
  confidence 软门。

## Provenance

- deep-research：6 worker（deepseek-v4-pro / sonnet-4-6 / gpt-5.4 /
  MiniMax-M3 / kimi-k2-thinking / MiniMax-M2.7）+ gpt-5.5 citation pass。
- Round-1 盲审：claude-opus-4-8（342s）/ gpt-5.5（187s）/
  deepseek-v4-pro（283s），各自独立核验 writer.ts dedup、
  correction-pipeline 谓词、git-sync gap、pi extensions.md sendUserMessage。
- 收敛裁定人：主会话（2026-06-10）。2:1 分歧仅 O2（opus 接受机械 UPDATE
  with-mods，gpt/deepseek 否决），按 R5' 原文"curator LLM 为语义权威"裁向
  多数。
