# Goal/Workflow 能力 + ADR 0028 收尾 — 实施计划 v2.1（3×T0 Round-1 收敛 + 主控深度复核版）

Date: 2026-06-10. 状态：**v2.1 收敛，可开工**。v2→v2.1 为主控逐条复核
后的修正（4 处实质修正，见 §深度复核修正记录），代码断言均经主控直接
read/grep 二次核验。
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
  正确 API（主控复核 pi docs extensions.md:1337-1361）：
  `pi.sendUserMessage(content, options?)` —— "Always triggers a turn"，
  options 仅 `deliverAs`（streaming 时必填；空闲时可省）。**注意：
  `triggerTurn` 是 `pi.sendMessage` 的参数，sendUserMessage 没有此项**
  （Round-1 三家引用的签名互不一致，v2 抄错，已修正）。v1 草案的"降级为
  footer 提示"分支**删除**。
  **加分发现（extensions.md:841）**：`event.source` 已结构化区分
  `"interactive"`（用户键入）/ `"rpc"` / `"extension"`（经 sendUserMessage）
  —— goal 续行在**事件层**有现成结构化标识。但 sediment 窗口构建器
  （checkpoint.ts:250-346）打包 turn 时**只保留 `msg.role`，不保留 source
  元数据**（主控核验），故 transcript 层隔离仍须靠文本前缀（见 P1）。
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
- **Tier-1 Jaccard dedup 的精确危害（v2.1 措辞精化）**：Tier-1 直写经
  writeAbrainRule（index.ts:3846）→ `findSimilarRuleSlug` 无条件拦截
  （writer.ts:2094/2088，阈值 RULE_DEDUP_SIMILARITY_THRESHOLD=0.85，
  rule-writer.ts:262），返回 `status:"deduped"`，index.ts:3876 将 deduped
  计入 `signal_consumed`。注意：短 lane 对 tier1_direct 结果**有 notify**
  （"Tier-1 rule (bg)"），并非完全无 tell —— 真正危害是**语义层**：
  ①Jaccard ≥0.85 false-merge 会把不同指令（如"用 pnpm workspace"vs"用
  pnpm"）判为同条而吞掉新指令内容；②既有规则不被 update/刷新。P0.3 仍
  必要，但定性为"概率近似闸门在 Tier-1 kill path"（R5'/R2' 冲突），
  而非"零可见性静默丢失"。
- **drain 残留是已接受的 Known residual，勿当 bug 修**：index.ts:2435-2442
  注释明确"(3-T0 review 2026-06-10, accepted)"——drain pass 无自有
  classifier，extractor llm_skip 越过 held window 时 **R3' recall flag 是
  设计内安全网**。v2 把它"升为 blocking"与当日 3-T0 合议冲突，v2.1 撤回
  （见 P0.4）。
- **shortWindowClassifierOnly 分支已实质 R2' 合规，勿删整段**：主控复核
  index.ts:2649-2760——该分支今天已走 `tryAutoWriteLane` → `tier1_direct`
  直写 + no-loss 推进（isCapturedTier1Result/terminalReject/safelyStaged）
  + `auditDirectiveRecall`。ADR 0028 删除项针对的是 seed-bridge 时代的
  escalation 语义，其实质已消亡；现存的是合法的"tiny window 不烧
  extractor"预算分支。剩余工作 = 命名/注释除旧 + 逻辑去重，**不是删除**。
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
  **sunset 注记（v2.1）**：conf>=8 fallback 是对 ADR 0028 R2' "当且仅当"
  定义的**过渡期偏离**——shadow audit 显示 is_directive 召回已覆盖
  conf>=8 case 后，应移除 fallback 回归 ADR 原文；这是显式 walk-back
  条件，PR-2 描述须引用本注记。

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

### P0.4 清理（v2.1 改写：收编而非删除）
- `shortWindowClassifierOnly`：**不删分支**（短窗口 Tier-1 捕获依赖它，
  见 §已核验事实）。改为：①提取短 lane / 主 lane / drain 三处重复的
  no-loss 推进判定为共享 helper（captured/terminalReject/safelyStaged
  逻辑已在三处近似复制）；②更新 index.ts:2649 起的陈旧注释（仍写"ESCALATES
  to FULL curator + multi-view lane"，实际已是 tier1_direct 优先）；
  ③`escalated_from`/`escalation_*` 等 audit key 改名**仅在 grep 确认无
  消费方（aggregator/health 查询）后**进行，否则保留双读。
- drain 残留（index.ts:2435-2442）：**撤回 v2 的 blocking 定性**。这是
  2026-06-10 3-T0 显式接受的 Known residual（R3' recall flag 为安全网）。
  本计划只加观察项：recall flag 出现 drain-lane 真实丢失案例时再回看该
  接受决定。
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
  2. **provenance 隔离（INV-IMPLICIT-GROUND-TRUTH 关键防线，v2.1 落地
     机制修正）**：双层防线——
     (a) **transcript 层（主防线）**：续行消息带机器前缀
     `[pi-goal-continuation goal_id=...]`；sediment `deriveProvenance` 把
     带该前缀的 user-role turn 判为 `assistant-observed`（确定性字符串
     检查，fail-closed）。理由：窗口构建器（checkpoint.ts:250-346）只保留
     `msg.role`，event.source 不进 transcript，前缀是唯一幸存信号。
     (b) **事件层（辅助）**：可订阅事件处用 `event.source==="extension"`
     （extensions.md:841）结构化判别；goal extension 同时以
     `pi.appendEntry("goal-continuation", ...)` 留 ledger 供交叉核对。
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
| PR-1 | P0.6a `_shared/git-singleflight` 接入 | 无 | ✅ **已完成 2026-06-10**（见下 PR-1 实施记录） |
| PR-2 | P0.1 is_directive + 谓词对齐 + prompt v2 + 5 类 fixtures + P0.5 tell 契约 | 无 | ✅ **已完成 2026-06-10**（见下 PR-2 实施记录） |
| PR-3 | P0.2 唯一 turn 映射 fail-closed + 函数头注释 | PR-2 | ✅ **已完成 2026-06-10**（见下 PR-3 实施记录） |
| PR-4 | P0.3 Jaccard→curator 裁决 lane + shadow audit + feature flag | PR-2 | ✅ **已完成 2026-06-10**（flag default off，见下 PR-4 实施记录） |
| PR-5 | P0.4 收编（no-loss 共享 helper + 注释除旧；不删分支不动 drain） | PR-2 | ✅ **已完成 2026-06-10**（见下 PR-5 实施记录） |
| PR-6 | P1a goal：state/commands/injection（无 auto-continue） | 无（可与 P0 并行） | ✅ **已完成 2026-06-11**（见下 PR-6 实施记录） |
| PR-7 | P1b goal：auto-continue + provenance 隔离 + re-entrancy + R4' 集成 | PR-6 | ✅ **已完成 2026-06-11**（autoContinue default off，见下 PR-7 实施记录） |
| PR-8 | ADR 0032 起草 → 3×T0 合议 | PR-6/7 实战反馈 | ✅ **合议接受 2026-06-11**（见下 PR-8 实施记录） |
| PR-9 | P2a DSL + parser + dry-run + smoke | PR-8 accepted | ✅ **已完成 2026-06-11**（见下 PR-9 实施记录） |
| PR-10 | P2b 执行器 + C5/C6/heartbeat 集成 + P0.6b 锁 + P3 成本策略 | PR-9 + PR-1 | ✅ **已完成 2026-06-11**（见下 PR-10 实施记录） |

每 PR：实现 → 3×T0 盲审 → 收敛 → push。PR-4 是行为变更风险最高项，shadow
audit 期间观察 ≥1 周真实负载再切默认。

### 第二期（ADR 0033，2026-06-11 首日 dogfood 触发）

用户四连裁决（slash 是死 UI / 成本非设计维度 / git 下 repo 内变更
可逆 / 专用防护=过度工程）触发调用面重设。计划表：

| PR | 内容 | 状态 |
|---|---|---|
| PR-11 | ADR 0033 起草 → 3×T0 合议 | ✅ **合议接受 2026-06-11**（见下 PR-11 记录） |
| PR-12 | workflow tools（validate/list/run）+ 归宿 + W12 进程级信号量 + N1/N2/N3/N5 smoke | ✅ **已完成 2026-06-11**（见下 PR-12 记录） |
| PR-13 | 文档驱动 goal（GoalState v2/judge 注入+转义+framing）+ goal tools + W1'/N4 smoke | 待开工 |

### PR-12 实施记录（2026-06-11 完成）

- 交付：workflow/index.ts 按 ADR 0033 重写为工具优先：注册
workflow_validate/workflow_list/workflow_run 三个 LLM tool（tell-not-ask、
无 --yes/无确认弹窗），slash `/workflow` 降级为直通道并共用 helper；
runWorkflowCore 内置确定性校验机器门（enabled=false→workflow_disabled、
validation_failed、execution_failed 全结构化 isError 路径），失败不裸抛；
workflow_run thread AbortSignal 进 executeWorkflow。workflow_list 枚举
`<projectRoot>/workflows/*.json` + `~/.abrain/workflows/*.{json,md}` +
strict-bound project `~/.abrain/projects/<id>/workflows/*.{json,md}`，.md
non-runnable/.json runnable，namespace 不折叠；示例移入 repo `workflows/`。
executor.ts W12 从 per-run semaphore 升级进程级 globalThis singleton（N5），
opts.semaphore 仅测试 seam。
- 盲审：R1 opus GREEN-with-nits / deepseek 无输出但执行成功 / gpt RED。
唯一 BLOCKING：executeWorkflow 启动异常裸抛，违 ADR 0033 §2.1 结构化
错误契约——修为 runWorkflowCore try/catch → `{kind:"execution_failed"}`；
gpt R2 GREEN-with-nits。NIT 采纳：safeNotify 防 notify 抛错、workflow_list
用 strict-bound projectRoot（子目录 cwd 也能见项目 workflows）、abrainDirs
resolve 后去重。未采纳/记录：slash debug path 的 runId 细节显示依赖
start notify，可接受；行为级 runner 零调用 smoke 可后补。
- smoke：workflow-tools 4 checks（list/~/disabled-source/executor sem seam），
workflow-executor 19 checks，workflow-dsl 13 checks，全量回归绿。

### PR-11 实施记录（2026-06-11 完成，ADR 0033 合议接受）

- 交付：docs/adr/0033-natural-language-first-invocation-and-doc-driven-
goal.md——总纲四行（把活干好/零弹窗/成本归用户/git 即恢复）；修订
0032 闸系：闸(c) 废除（结构承重转 ADR 0003 主会话只读——LLM 不能
现编拓扑立即执行）、闸(b) 降启动 tell、闸(a) 保留（资产属性）；
晋升机检谓词化；W1→W1'（机器 turn 拒绝面收缩为 set/resume 两个，
workflow_run 在续行 turn 放行——权威创建≠有界执行）；W7→W7'；
8 工具契约；文档驱动 goal（GoalState v2/head+tail 截断/goal-doc
转义/checkbox 回声 framing/W4 诚实弱化标注）；zone 双 lane（.md
惯例/.json 资产）+ namespace 限定不折叠；N1-N5 新不变量。
- 合议：3×T0 xhigh 一致 ACCEPT-with-required-changes，全部 RC/M 已
并入。最有价值三击：①opus/deepseek 收敛指出草案自造门倒挂（机器
turn 拒 workflow_run 却放 dispatch_parallel）——拒绝面收缩为权威创建
两工具；②opus/deepseek 收敛打开 doc 自勾回声 false-achieved 通道
（勾选=CLAIM 非证据的 judge framing + 走偏信号）；③opus RC6 补论证
承重砖：ADR 0003 主会话只读才是替代闸(c) 的结构门。另 opus RC5/
gpt RC4/deepseek M4 三家收敛 16KB head-preserving 会丢尾部验收标准
（改 head+tail+显式标记，删 W5 类比）。
- 哲学前提由 principal 直接给定，合议范围限自洽性/实现性/漏洞闭合，
不重议哲学——三家均在此前提下完成。

### PR-10 实施记录（2026-06-11 完成，全计划收官）

- 交付：①dispatch 共享 runner API（§8）——runInProcess/validateTools/
MAX_CONCURRENCY/DEFAULT_TIMEOUT_MS/AgentResult 导出；_sharedInfraPromise
改 globalThis Symbol.for slot（jiti moduleCache:false 双副本不重复
reload）；dispatch 现有路径零行为变化（全部源扫描 smoke 绿）。
②extensions/workflow/executor.ts 确定性 DAG 引擎：eager 调度 +
全局信号量（W12 真门，opus F1 跨波叠加场景 smoke 锁 peak=4）；W11
全分支确定性分类（FailureSource 闭集六枚举）；§7 degrade 语义（path
必产出否则 failed；下游结构化 degraded 标记；永不静默）；retry 有界；
abort=停排期+在飞 drain；外部 abort/超时=剪在飞→cancelled（C5 区分）；
state.json 逐终态落盘（resume 前向兼容）；P0.6b runDir per-key 锁；
trace 文件带 W10 assistant-observed 头；run 级 totalCost 汇总。
③/workflow run 两步式：无 --yes 呈现报告+effective 面（闸(b)），
带 --yes 才执行（闸(c)）；workflow.enabled 硬门；故意不注册 LLM
tool（§5 晋升机检项 3）；makeProductionRunner 走 dispatch validateTools
（M1 继承）+ deriveSubAgentAnchor + runWithTriggerAnchor + heartbeatCtx
（W13，与 dispatch_parallel 同构）。
- 盲审：R1 opus GREEN-with-nits / deepseek GREEN / gpt RED；gpt 追审
R2 RED→R3 RED→R4 GREEN。gpt 三轮逐步击穿 --yes 解析：R1 quote-unaware
全局 replace；R2 未闭合引号落 unquoted 分支；R3 贪婪 pair 吞内部引号。
终态：quoted 内容必须非空且无引号（[^"']+），其余 quote 形态一律
malformed fail-closed（不确认不改写不执行）；空参数拒绝。其余采纳：
child attempts 按 wave 计真实次数（opus）、launch-crash 走 setRecord
（opus/gpt）、timeoutMs 移到 sem.acquire 后（deepseek）、runId 随机后缀、
常量双源钳制+字面量相等 smoke 锁（MAX_CONCURRENCY/DEFAULT_TIMEOUT_MS）。
- 裁量裁定（opus UPHOLD ×3）：两步 --yes 门成立；degrade-only-on-final-
attempt 冗余无害（v1 retry×degrade 不可组合是设计内）；workflow_abort
在飞 drain vs 外部 abort 剪断的 C5 区分正确。deepseek 五维对抗扫描全
PASS（W7/W8 零拓扑自由度、M1 继承无绕过、W10 围栏、资源有界、§5
四门无触）。
- 入档观察项：deepseek NIT-2 sem 饱和时 deadline TOCTOU 窗口（有界，
per-stage timeout 兑底）；NIT-4 W10 围栏现状靠 sediment 无 fs 扫描面，
若未来 sediment 加 fs 扫描需把 .pi-astack/workflow/ 入机械 exclude；
workflow dogfood 需先开 workflow.enabled（实验通道，default off 不变）。

### PR-9 实施记录（2026-06-11 完成）

- 交付：新 extensions/workflow/{dsl,index}.ts——DSL v1 确定性校验器
（ADR 0032 §7 逐条：schema_version/id 全局唯一/needs 作用域/parallel
聚合节点/tools 白名单默认闭合/dispatch 硬拒（H5 M1）/W9 三重门静态
面 fail-not-strip/on_fail 边界/Kahn 波宽 W12 预检）+ /workflow dry-run
命令（§6 闸(a)(b)：只读磁盘 artifact + 结果呈现）。无执行器（PR-10）。
- 盲审：R1 三家均 GREEN-with-nits，无 BLOCKING 免 R2。NIT 全采纳：工具
名大小写归一（对齐 dispatch）、name/id 诊断净化、timeout 整数、成对
引号、duplicate needs 警告、memory_list 补白名单、W12 估算标签诚实化
（"wave estimate"——opus 指出 Kahn 波宽非真反链宽，eager 调度可跨波
叠加；runtime 信号量才是真门，已注入 PR-10 对齐项）。
- 裁量裁定（opus UPHOLD）：dry-run 不门 workflow.enabled（纯只读确定性
校验，author 辅助；不触 §5 晋升机检四条中任一）；W12 硬失败过严争
议裁为"可取且更优"（强制 needs 显式化使并发在 plan 中可见，服务
闸(b)）。
- PR-10 对齐项（入档）：runtime 信号量为并发真门（非 dry-run 估算）；
抽 dispatch 共享 runner API 时去重 READONLY_TOOLS/MAX_CONCURRENCY 常量；
dry-run 报告补 effective-tools 列（deepseek OBS-2）。

### PR-8 实施记录（2026-06-11 完成，ADR 0032 合议接受）

- 交付：docs/adr/0032-goal-runtime-and-declarative-workflow.md——Part A
ratify goal 运行时（PR-6/7 语义固化为 W1-W6）；Part B 为 PR-9/10 定
规范（H5 三判别线 + 三闸用户权威 + stage 内 dispatch 硬拒绝 +
声明式路由合法性 + 晋升机检定义 + DSL v1 边界 + degrade 语义 +
全局并发 cap + on_fail 确定性路由）；W1-W13 + 检验矩阵。
- 合议：3×T0 一致 ACCEPT-with-required-changes，全部 RC/M 已并入。
最有价值的两击：①deepseek 构造性击穿 H5 软肋——单 stage DSL +
dispatch_agent 工具 = 名义满足三判别线、实质 hub 派工；闭合：stage
tools 无条件禁 dispatch 类工具（dry-run 硬拒），解禁=触 H5=走 ADR
0030。②gpt 抓出 W3 规范-实现不一致——continuation 事件 append 失败
仅 warning 仍 send，reconcile 会回滚计数器使预算跨重启重花；代码随
ADR 同 commit 修复（event append 失败→不 send）+ smoke。另 opus
要求的 head-preserving 截断方向 smoke 锁定已加。
- PR-9 开工前置条件已满足。PR-10 需先抽 dispatch 共享 runner API
（runInProcess 现为私有，gpt 注记入 §8）。

### PR-7 实施记录（2026-06-11 完成，autoContinue default off）

- 交付：_shared/goal-continuation.ts 前缀契约（生产者/消费者共享模块）；
goal/judge.ts 快档 LLM 裁决 {achieved,blocked,continue}（C6 严格 parse，
assistant-claims-非证据 + machine-turn 双框架，</transcript> 转义，
回声消息标 [goal-continuation (machine)]）；goal/continue.ts 确定性编排
（预算检查先于 LLM 花费；预减+event-first+persist 成功才 send；persist
失败不 send 防坏 fs 无界循环；blocked/耗尽→paused+notify）；sediment
侧：deriveProvenance 前缀 demote 进 assistant 桶 + userTextForDirectiveRecall
跳过 continuation 文本；R4'：goal-owned outcome-ledger.jsonl
（achieved/blocked/耗尽/abandoned，含 /goal clear）；send 前写专用
pi-goal-continuation intent ledger（计划 2b）+ sendUserMessage
{deliverAs:"followUp"}（官方示例契约）。
- 盲审：R1 opus GREEN-with-nits（退出路径全闭合+前缀防线 load-bearing
假设验证：packer head-preserving 截断）/ gpt RED（sendUserMessage 裸调
违契约、专用 ledger 缺失、send 失败不可观测）/ deepseek GREEN（洗白链
扫描发现 recall 扫描残留面）；R2 gpt GREEN-with-nits。NIT 全采纳（回声
标签、转义、persist 失败 notify、resume 墙钟预警、queued 措辞）。
- 裁量裁定（opus UPHOLD）：blocked→paused+notify 而非计划原文的
prompt_user（bg hook 弹 modal 违 tell-not-ask）；goal-owned ledger 而非写
sediment outcome-ledger（外来 row 破坏 OutcomeRow schema/dedupe 契约；
未来 aggregator 只读不写）。
- 已记载观察项：send 送达失败仍不可同步观测（intent row+预算先烧=保守
方向）；resume 不 rebase 墙钟（预警已加，fresh set 重置）；R4' ledger
暂无读侧（未来 aggregator feed 入档）；judge 回声加速耗尽由 budget 硬停
兑底。

### PR-6 实施记录（2026-06-11 完成）

- 交付：新 extensions/goal/{state,index}.ts——事件源（pi-goal-event 随
session 树 fork）+ 物化视图（.pi-astack/goal/<sessionId>.json）；状态机
active⇄paused→abandoned（achieved 留 PR-7）；/goal set/pause/resume/
clear/status；每 turn 尾部注入 active goal（time-injector 模式，子代理
跳过）；goal.enabled default true（惰性）；mtime GC。agent_end 未订阅。
- 盲审：R1 opus/deepseek GREEN-with-nits + gpt RED；R2 gpt RED 残留；
R3 gpt GREEN。两个实质 BLOCKING 都在分支语义：①reconcile 误用
getEntries（全树）→改 getBranch（root→leaf），不可用则跳过；②当前
branch 无 goal 事件时旧 view 继续注入→replay null 时 removeGoalFile
（events-as-truth 收敛）。另采纳：event-first 写序（opus：view-before-
event 的 crash 窗口会回退迁移）、sanitizeGoalText（marker 碰撞中和+
control/bidi 滤除，opus/deepseek 同报：含 END_MARKER 的 objective 会让
strip 提前终止→残留跨 turn 累积）、长度上限 2000/300/10、已知 flag
白名单（未知 --flag 不被吞）、GC lstat 不跟 symlink、appendEntry 失败
显式 warning。smoke 12 checks。
- 裁量裁定（opus 全部 ENDORSE）：GC age-only（view 可从事件重建故非
破坏性）；set 替换任意状态（新 C4' 授权）；default enabled=true（不
set 零行为）；临时会话拒绝（无事件源可调和）。
- PR-7 接口点（deepseek N3 入档）：goal_id 建议升独立可 grep 行；
R4' goal_outcome ledger 显式顺延 PR-7；budget/counters 字段已就位。

### PR-4 实施记录（2026-06-10 完成，flag default off）

- 交付：`semanticDedup` 三态（dedup 遗留/report 中间态/off 裁决后绕过）；
新模块 tier1-adjudicator.ts（封闭裁决空间 {update,merge,create}、C6 严格
parse、resolveTier1JaccardHit 编排 + 可注入 adjudicateFn）；
applyTier1RuleAdjudication（update 证据 append+行级去重幂等；merge body
替换+hash 重算+幂等 body_unchanged+TOCTOU expectedBodyHash 见证+
merge_jaccard_vs_old audit 度量；splitFrontmatter 解析，fm patch 限域）；
flag OFF 默认：遗留 gate 唯一写者 + shadow audit（只读 adjudicator，
tier1_jaccard_shadow 行，独立退出门 tier1JaccardShadowAudit）。
- **Tier-2 双 flag 合取**（实现期修正计划）：Tier-2 跳过自主 gate 需
`tier1JaccardCuratorLane ∧ rulesAsReadonlyNeighborsEnabled`——后者（default
false）门住 curator rule-neighbor 加载，无邻居预过滤时绕 gate 会回归
06-07 glab 事故。三家裁定 APPROVED（比计划更保守，计划单 flag 欠设）。
- 盲审：R1 opus RED + gpt RED（同一 BLOCKING）+ deepseek GREEN-with-nits；
R2 opus/gpt 双 GREEN-with-nits。**B1（R1 BLOCKING）**：apply 阶段 reject 只有
entry_not_found 回退 create，违背 O2 "ANY failure→create"——修为通用规则
（唯一豁免 git_commit_failed：transient infra，HOLD/retry 是设计内 no-loss
路径，gpt R2 接受）。NIT 全采纳：shadow 退出门、splitFrontmatter、merge
幂等、TOCTOU 见证、prompt 注入面 <rule>/<directive> delimit（deepseek）、
parser docstring、settings schema 补齐。
- smoke：fs+编排 16 checks（含 B1 专项锁定）；live dossier 3/3（重述→
update，加例外→merge 保全双方，pnpm-workspace-vs-pnpm→both-preserving
merge；fixture 3 钉 R2' 不丢内容不钉 create/merge 口味）。
- 切换条件（§9.4）：shadow audit 观察 ≥1 周真实负载，would_decision 分布
显示裁决优于自主 gate 且 merge_jaccard_vs_old 不聚集低位，再翻
tier1JaccardCuratorLane；旧 gate 代码保留至翻默认后一个版本。

### PR-5 实施记录（2026-06-10 完成，零行为变化）

- **计划假设修正**：原计划设想"三处 no-loss 逻辑近似复制需共享
helper"，实况是主/drain lane 已用 shouldAdvanceAfterAutoOutcome，仅短
lane 内联且**有意更严**（要求正向捕获；all-terminal-reject 推进会让
无 extractor 重跑的短窗口丢信号）。故收编采"提取叶子谓词
hasPositiveWriteCapture + 文档化差异 + 禁止盲目统一"而非强行统一。
- 交付：hasPositiveWriteCapture 提取（逐字等价）；文件头 item 6 除旧
（"optimistically advances"→实际 safe-capture 语义）；短 lane
"#1 escalation"注释除旧（反映 tier1_direct 优先现实）。
- **audit key 决定**：escalated_from/escalation_* 保留不改名（grep 零
消费方，但保 jsonl 历史连续性），入注。
- 盲审：opus GREEN-with-nits / gpt GREEN / deepseek GREEN，零行为变化
经三家逐字比对坐实；文档 NIT（item 6 措辞、失信号链示例、类型注）
已采纳。

### PR-3 实施记录（2026-06-10 完成）

- 交付：deriveProvenance 唯一 turn 映射——跨 role 多命中 fail-closed 出
user_message（demote 确定性：transcript 优于 assistant）；同 user-role
多命中保留 user_message + multi_match；quote_multi_match/
quote_matched_roles 诊断字段贯通 CorrectionSignal → tier1_direct_write
audit → directive_recall audit（echo 子类归因，opus N1）→ staging 切片
（gpt N1）；smoke 5/5b/5c/5d/5e（含反转原"user wins"断言，14 断言）。
- 盲审：R1 opus GREEN-with-nits / gpt GREEN-with-nits / deepseek GREEN，
无 BLOCKING，免 R2。**回声裁决（3:0 维持严格 cross-role fail-closed）**：
assistant 回声用户指令→降 Tier-2 是接受的可见召回代价（R3' recall
flag 兑底）；对侧风险更危险——放宽会让"assistant 提议原词→用户重复
确认"场景下 assistant 生成内容静默冒充 user-expressed（无 recall flag
兑底，deepseek 量化分析）；且放宽会混淆结构源门与祈使门职责（opus）。
walk-back 数据化：directive_recall.quote_matched_roles=[user,assistant]
聚集→回看。
- 已接受观察项：短 quote 子串误命中（fail-closed 方向，已注释）；
multi_match 语义双载（靠 matched_roles 区分，未来可加
cross_role_ambiguous）；audit 集成 fixture（gpt N2，后续 PR 顺带）。

### PR-2 实施记录（2026-06-10 完成）

- 交付：`isTier1Directive()` 谓词（O5 收敛式 + sunset 注记，
shouldEscalateToCurator 为纯 alias）；CorrectionSignal.is_directive 字段
（parse 严格布尔 fail-closed）；classifier prompt v2（Directive detection
节：召回偏置只作用于 is_directive + 5 项 abstain 清单；v1 保留）；
promptVersion v2 + 语义注记；formatRuleTell() 固定 per-op tell 契约
（📌/📝/⚠️ contested/♻️/⚠️ rejected，区分 terminal/transient reject）+
isLowConfidenceDirective 标注；outcome edge contested 增加 warning 级 tell；
is_directive 进 tier1_direct_write audit 与 staging 切片（O5 sunset 审计
可测量）；谓词级 5 类 fixtures（rule-writer-fs + defer-resolution）+
LLM dossier 5 个 directive fixtures。
- 盲审：R1 opus GREEN-with-nits / gpt RED / deepseek GREEN。gpt BLOCKING
（主 bg lane coveredTexts 未按 isCapturedTier1Result 收窄，terminal
reject 压制 recall flag）事实成立并修复（三 lane 对齐）；R2 gpt GREEN。
- **LLM dossier 已补跑（2026-06-10 同日闭环）**：401 根因定位为
  **base URL 配错而非 key 失效**——环境 DEEPSEEK_API_KEY 是 sub2api 网关
  key（sk- + 64 hex），打官方 api.deepseek.com 必 401；正确用法
  `DEEPSEEK_BASE_URL=https://sub2api.alfadb.cn`（smoke 自拼 /v1/...，
  网络通路经无鉴权/带鉴权探针多次验证正常）。
  **dossier 结果（25 fixtures，deepseek-chat）**：directive 类 **5/5
  expected-aligned**——祈使→is_directive=true∧durable；疑问/引述他人
  →signal_found=false；陈述式→is_directive=false∧durable conf=7（正确
  落 conf fallback 阶梯下方→stage）；**"不要记这条"→is_directive=false
  ∧task-local（abstain 清单生效，召回偏置未过触）**。保守姿态未动摇
  （14 个 signal_found=false，ambiguous 类未被翻转）。obvious 类 4/5，
  唤一例 obvious-4 为模型畲形 JSON（缺收尾花括号，1/25）——生产侧同样
  fail→null→recall flag 兑底，符合 INFRA 序列化失败不重试哲学，不改。
  O5 sunset 计量基线已建立。
- 其余已接受 NIT：curator 多结果 lane 保留 tabular 形态（设计内切分）；
  dry_run 走 default 文案；负例输出 schema 不含 is_directive（parse
  fail-closed 兑底，观察项）。

### PR-1 实施记录（2026-06-10 完成）

- 交付：`extensions/_shared/git-singleflight.ts`（globalThis singleton，按
  resolved repo root 分 key 的 tail-chain）；git-sync pushAsync/fetchAndFF、
  writer 三个 commit helper（Unlocked 包装模式）、`/abrain bind`
  autoCommitPaths 调用点、migrate-go gitCommitAll 全部接入。git-sync.ts
  KNOWN GAP 注释改为 CLOSED。新增 smoke:git-singleflight（9 checks，含
  jiti 双副本共享链回归 + 真 git 并发 commit）；smoke-abrain-git-sync 与
  smoke-abrain-secret-scope 顺带修掉对 <os-tmp>/_shared 残留的隐式依赖。
- 盲审：Round-1 opus GREEN-with-nits / gpt-5.5 RED / deepseek
  GREEN-with-nits。gpt 两条 BLOCKING（bind autoCommitPaths、migrate-go
  gitCommitAll(abrainHome)）均事实成立并修复；Round-2 gpt 复核 GREEN。
  注：deepseek 对这两点的"非缺口"判定是误判（漏看 migrate-go:1308 的
  abrainHome 目标 + 低估已在飞子进程不受事件循环阻塞约束）。
- **已接受残留（评审共识 NIT，不阻塞，后续 PR 可顺带）**：
  1. writer.ts 9 处失败回滚 `git reset HEAD` 在锁外（caller 侧），与无
     pathspec `git commit` 组合存在 ghost-file 掃入窗口（预先存在，PR-1
     已收窄；候选修复：reset 移入 Unlocked 失败路径锁内）。
  2. key 仅 path.resolve，symlink/大小写别名不归一（跨进程仍靠 git 自身
     index.lock fail-soft，已在模块头注释声明）。
  3. `_queueDepth().hasInflight` 语义加宽为进程级 has-ever-enqueued（唯一
     消费方是 smoke #16，无生产 reader）。
  4. gitCommitAbrain/AboutMe 不触发 auto-push（仅内容 commit 触发）——
     ADR 0020 语义不对称，预先存在，PR-1 未改变。
  5. smoke 桥接目录 <os-tmp>/_shared 非隔离（各 smoke 每次运行前显式重写
     内容，已比残留依赖强；完全隔离需改为 tmpDir 内带 require 重写，
     secret-scope 已采该形态，git-sync smoke 留待后续）。

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

## 深度复核修正记录（v2 → v2.1，主控 2026-06-10）

实质修正 4 处：
1. **P0.4 shortWindowClassifierOnly**："删整段"→"收编+除旧"。三家 Round-1
   均沿用 ADR 0028 删除项清单而未细读分支现状；主控复核发现该分支已接
   tier1_direct + no-loss + recall audit，删除会回归 B2 类丢失。
2. **P0.4 drain**："升为 blocking"（gpt A6 采纳项）撤回——与当日 3-T0
   已接受的 Known residual 合议冲突（index.ts:2435 注释为证）。
3. **O1 API 签名**：`sendUserMessage` 无 `triggerTurn` 参数（三家引用互
   不一致，v2 采错版本）；正确为 `pi.sendUserMessage(content, {deliverAs?})`。
4. **P1 provenance 隔离机制**：从"前缀 + sediment 排除"细化为双层——
   transcript 层前缀为主防线（窗口构建器不保留 event.source，主控核验
   checkpoint.ts），事件层 `event.source==="extension"` 为辅。

措辞精化 2 处：Tier-1 Jaccard dedup 危害定性（有 notify，危害在语义
false-merge）；O5 conf>=8 fallback 加 sunset/walk-back 注记。
维持原判 6 处：is_directive 缺失（validation.ts:12-20 spec 注释 +
correction-pipeline.ts:43 conf≥8 + prompt grep=0 三证）；singleFlight gap
（git-sync.ts:40-46 原文 + writer.ts:2232 gitCommitAbrain 调用链）；
deriveProvenance 无唯一 turn 校验；R4'/R3' 已 shipped 勿重做；
writeAbrainWorkflow 存在（writer.ts:1689）；pi.appendEntry 存在
（extensions.md:1365）。

## Provenance

- deep-research：6 worker（deepseek-v4-pro / sonnet-4-6 / gpt-5.4 /
  MiniMax-M3 / kimi-k2-thinking / MiniMax-M2.7）+ gpt-5.5 citation pass。
- Round-1 盲审：claude-opus-4-8（342s）/ gpt-5.5（187s）/
  deepseek-v4-pro（283s），各自独立核验 writer.ts dedup、
  correction-pipeline 谓词、git-sync gap、pi extensions.md sendUserMessage。
- 收敛裁定人：主会话（2026-06-10）。2:1 分歧仅 O2（opus 接受机械 UPDATE
  with-mods，gpt/deepseek 否决），按 R5' 原文"curator LLM 为语义权威"裁向
  多数。
- v2.1 深度复核：主会话逐条 read/grep 二次核验（index.ts 2100-2185 /
  2425-2455 / 2640-2760 / 3870-3882；correction-pipeline.ts 28-83；
  validation.ts 1-30；writer.ts 2088-2236；git-sync.ts 38-50；prompts/
  目录；pi extensions.md sendUserMessage/appendEntry/event.source 节）。
