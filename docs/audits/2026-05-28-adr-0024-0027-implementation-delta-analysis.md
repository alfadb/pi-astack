# ADR 0024–0027 当前实现差异分析报告 (2026-05-28)

**审计基线**：R5 unanimous BASELINE GREEN (2026-05-27)
**输入**：4 份 ADR (0024/0025/0026/0027) + R1 + R2-R5 审计 + 实证代码核查
**结论先行**：当前代码相对 ADR 0024–0027 已经从"方向性原型"进入"可 dogfood 的 L1 第二大脑系统"阶段。R1–R5 审计中提出的关键 P0/P1（L2 toolResult 污染、异步写入 wrong-turn anchor、cross-jiti singleton、sub-agent memory/tool surface mismatch 等）大多已关闭，R5 的 **BASELINE GREEN** 可以成立。
但如果按四份 ADR 的严格完整语义衡量，系统仍不是 full compliance：**ADR 0027 C5/heartbeat 未实现**仍是最大阻断；ADR 0025 的 **staging-resolver** 与 **archive-reactivation-reviewer** 未落地；ADR 0026 Path A 目前是"raw relevant memory injection v2"，不是原始设想里的 outcome-aware decision brief。

---

## 1. 基准判断口径

- **ADR 0024**：定义第二大脑的治理边界：隐身、自治、隐式真实信号、主动纠错，以及 AI-Native 原则。
- **ADR 0025**：写侧 sediment / meta-curator 子系统，负责"怎么学对、怎么改错、怎么自我演进"。
- **ADR 0026**：读侧 / 任务参与，负责"第二大脑怎么参与当前任务决策"。
- **ADR 0027**：L1/L2 双循环，多 agent 执行层与认知层的边界、因果锚点、失败语义。

审计口径：

| 状态 | 含义 |
|---|---|
| ✅ 符合 | 核心 invariant 已有代码路径支撑，且 R1–R5 中相关高优先级问题已关闭 |
| ◐ 部分符合 | 主路径可用，但仍有设计债 / v2 与 ADR 完整目标不一致 |
| ❌ 未实现 | ADR 明确要求的能力点目前只有 placeholder / 文档 / telemetry，没有实际闭环 |

---

## 2. 总体状态矩阵

| ADR / 能力 | 当前状态 | 结论 |
|---|---:|---|
| ADR 0024 INV-INVISIBILITY | ◐ | 主路径不要求用户审批记忆生命周期；footer/notify 属健康反馈，合法。但 `/about-me`、`MEMORY:*` fence 仍是过渡期反模式入口 |
| ADR 0024 INV-AUTONOMY | ◐ | `autoLlmWriteEnabled` 默认已改 true，并有 `"staging-only"` / false 回滚；但显式管理入口尚未 deprecate |
| ADR 0024 INV-IMPLICIT-GROUND-TRUTH | ✅/◐ | L2 sub-agent 输出已从 sediment extractor/classifier 输入中屏蔽；多用户共享 abrain 的 user attribution 仍是结构性未解问题 |
| ADR 0024 INV-ACTIVE-CORRECTION | ◐ | `correction-pipeline.ts` 已实现主动纠错分类 + staging；但 staging-resolver 未实现 |
| ADR 0024 AI-Native | ✅ | classifier / aggregator / multi-view / Path A cutoff 主要走 prompt-native；schema/anchor/lock/ledger 作为 infra 使用，边界基本正确 |
| ADR 0025 active correction | ◐ | 7-step prompt、sanitizer、staging 写入、audit 均已在；缺 dedicated staging resolver |
| ADR 0025 outcome self-report | ✅ | memory-footnote + tool-result 双源 outcome-ledger 已实现，并带 C6 anchor |
| ADR 0025 aggregator | ✅/◐ | prompt-native skeptical historian v1 已实现；机械 fallback 存在；结构性未实现项会显式注入 STRUCTURAL_CONTEXT |
| ADR 0025 multi-view | ◐ | P0.5 双 pass / cross-provider / staging replay 已有；Pass1 对 update/merge/supersede/delete rich payload 仍弱 |
| ADR 0025 archive rollback/reactivation | ❌ | `archiveReactivationReviewer: v0 placeholder`，实际 reviewer prompt 未实现 |
| ADR 0026 Path A | ◐ | always-on relevant memory injection 已实现；但不是 outcome-aware brief，只注入 raw entries |
| ADR 0026 Path B `memory_decide` | ✅/◐ | 决策简报、outcome 活跃度、矛盾检查、echo-chamber 提示已实现；multi-view verified 信息未消费 |
| ADR 0027 C1/C3/C4 L1/L2 边界 | ✅ | sub-agent 默认 read-only + memory/web read tools；主会话/子会话隔离已修复 |
| ADR 0027 C6 causal anchor | ✅/◐ | globalThis + ALS trigger-time anchor、subturn、device_id、ledger retrofit 已实现；仍是 fail-open 而非 strict MUST |
| ADR 0027 C5 fail/degrade/cancel/resume + heartbeat | ❌ | 仍未实现，是 L2 进入 mutating / production path 前的硬阻断 |

---

## 3. R1–R5 已关闭 vs 仍残留

### 3.1 已关闭

| R1/R2/R3/R4 问题 | 当前状态 |
|---|---|
| P0-α sub-agent toolResult 污染 sediment | `L2_WITHHELD_MARKER` 已修复，classifier path 也复用 |
| P0-β async writer write-time anchor | `runWithTriggerAnchor()` + ALS 已修复 |
| P1-1 sub-agent boundary sentinel | globalThis WeakSet + sentinel 方向 |
| P1-2 memory_decide prompt/tool mismatch | Route A'：sub-agent 默认 memory_search/get/neighbors/decide，但不要求 footnote |
| P1-3 missing JSONL anchors | outcome / aggregator / search / multi-view metrics 等已补 anchor |
| NEW-P1-A context-packer bypass | 已修复 |
| NEW-P1-B decisionBriefId opaque | 已改成 anchored schema |
| R3 subturn not propagated | dispatch_parallel task 已用 per-task subAnchor + ALS |
| R4 jiti singleton breakage | globalThis singleton，R5 baseline green |

### 3.2 显式缺口

| 优先级 | 缺口 | 影响 |
|---|---|---|
| P0 | ADR 0027 C5 + heartbeat 未实现 | L2 不能进入 mutating / production main path |
| P1 | ADR 0025 staging-resolver 未实现 (§4.1.5.1) | provisional staging 无独立 resolve 闭环 |
| P1 | ADR 0025 archive-reactivation-reviewer 未实现 (§4.6) | archived entry 不能 prompt-driven reactivate |
| P1 | P6 deprecation 未启动 (`/about-me` + fence) | 过渡期反模式仍在用户交互面 |
| P1 | Path A 不消费 outcome-ledger / 不生成 brief | "参谋"能力在 Path A 上仍弱 |
| P1/P2 | multi-view Pass1 rich op schema 不足 | update/merge/supersede/delete 可能 defer/skip 循环 |
| P2 | C6 strictness fail-open | anchor 缺失时不会硬失败 |
| P2 | Path A v3 (full-body stage1 / HyDE / brief synthesizer) 未做 | stage1 index-only、rewriter cost-bias prompt 残留 |

---

## 4. 关键证据点（按文件）

### ADR 0024 / 0025 写侧
- `extensions/sediment/settings.ts:189` `autoLlmWriteEnabled: true` (P5.5 pragmatic)
- `extensions/sediment/settings.ts:200-208` `promptVersion.archiveReactivationReviewer: "v0"` (placeholder)
- `extensions/sediment/checkpoint.ts:262-278` `L2_FANOUT_TOOL_NAMES` + `L2_WITHHELD_MARKER` (P0-α)
- `extensions/sediment/context-packer.ts:55-72` L2 屏蔽逻辑复用 (R2 NEW-P1-A 修复)
- `extensions/sediment/correction-pipeline.ts` 7-step classifier 完整实现
- `extensions/sediment/staging-loader.ts` 只 lazy load + stale count，**没有独立 resolver**
- `extensions/sediment/aggregator.ts:60-83` `STRUCTURAL_CONTEXT` 明确保留两个未实现项
- `extensions/sediment/multi-view.ts` P0.5 双 pass + staging replay 已实现
- `extensions/sediment/outcome-collector.ts:392-432` `writeOutcomeLedger()` 已带 `spreadAnchor`

### ADR 0026 读侧
- `extensions/memory/decide.ts:54-71` `buildDecisionBriefId` ADR 0026 §5.1 schema 实现
- `extensions/memory/decide.ts` brief prompt 含 RECENT USAGE / contradiction / caveats
- `extensions/memory/memory-context-injector.ts` Path A v2 always-on injection
- `extensions/memory/prompts/query-rewriter-v2.md` 仍残留 cost-saving 偏置
- `extensions/memory/llm-search.ts:710-720` LLM-side strong cutoff (`relevance_verdict`)

### ADR 0027 双循环
- `extensions/_shared/causal-anchor.ts:100-130` globalThis state singleton (R4 修复)
- `extensions/_shared/causal-anchor.ts:258-269` `getCurrentAnchor()` fail-open
- `extensions/_shared/causal-anchor.ts:292-296` `runWithTriggerAnchor()` ALS (P0-β)
- `extensions/_shared/causal-anchor.ts:372-410` `spreadAnchor()` + `device_id`
- `extensions/_shared/pi-internals.ts:580+` WeakSet globalThis singleton (R4 修复)
- `extensions/dispatch/index.ts:96-100` `KNOWN_TOOLS` + sub-agent allowlist
- `extensions/dispatch/index.ts:223-237` `failureType` (no `terminal_state`, **no heartbeat**)
- `extensions/dispatch/index.ts:1262-1284` `dispatch_parallel` per-task subAnchor + `runWithTriggerAnchor`

---

## 5. 推进备选 (按工程量从小到大)

1. **archive-reactivation-reviewer** (~小)：bounded, prompt + wire-up
2. **staging-resolver** (~中)：batch resolver + audit + aggregator feed
3. **P6 soft deprecation** (~小)：deprecation copy + suppress from /help
4. **Path A v3** (~中)：去 cost bias / stage1 full body / brief synthesizer / outcome consume
5. **C5 v1 + heartbeat** (~大，~1 周)：terminal_state schema + heartbeat trace + cancel/resume protocol

---

## 6. 最终判断

> ADR 0024 的 L1 第二大脑哲学已经基本落地；ADR 0025/0026 的主要读写闭环已经进入可 dogfood 状态；ADR 0027 的 causal trace / sub-agent isolation 已经经过 R5 基线修复。但严格 full compliance 被 C5/heartbeat、staging-resolver、archive-reactivation-reviewer 三类未实现能力卡住。

- 能不能继续 dogfood 主会话第二大脑：可以
- 是否满足四份 ADR 的完整严格要求：还没有
- 当前最大风险：未来任何人误以为 dispatch 已具备生产级 L2 failure semantics，从而默认开放 mutating sub-agent

---

## 7. 关键文档定位（reviewer 读取建议）

- `docs/adr/0024-second-brain-from-natural-conversation.md`
- `docs/adr/0025-sediment-meta-curator-subsystem.md`
- `docs/adr/0026-second-brain-decision-participation.md`
- `docs/adr/0027-coupled-stigmergic-dual-loop-agent-system.md`
- `docs/audits/2026-05-27-adr-0024-0027-implementation-r1.md`
- `docs/audits/2026-05-27-adr-0024-0027-implementation-r2-r5.md`
