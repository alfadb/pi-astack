---
doc_type: adr
status: accepted
date: 2026-07-23
---

# ADR 0043: 生命周期收敛与可逆终态

## Context

Sediment 同时存在三类长期工作项：

- `provisional-correction` staging；
- `multiview-pending` staging；
- `entry-lifecycle-proposals.jsonl` 中的生命周期 proposal。

它们此前各自记录 retry、defer 与 terminal，缺少统一的有界状态语义和统一的守恒读模型。由此产生三类风险：失败项可以无限悬挂，`superseded_no_successor` E2 会被误写成人工复核，终态 cleanup 会退化成物理删除或只保留 digest。

本 ADR 只收敛生命周期控制面。它不改变 durable memory 的语义权威，不授权新的 writer，不建立 Lane G，也不建立用户、人类或 operator 管理队列。

## Decision

### 1. Source ledger 与读模型分离

原 source record 仍是唯一写权威：staging JSON 与 lifecycle proposal JSONL 承担状态迁移。统一文件 `~/.abrain/.state/sediment/lifecycle-convergence.json` 只是确定性、原子写、可丢弃重建的 read model，不获得反向写 source 的权力。

每个工作项必须有稳定 `item_id`，并投影以下最小状态：

- `created_at`、`updated_at`；
- `current_state`；
- `attempt`；
- `failure_class`；
- `next_retry_not_before` 或 `new_evidence_trigger`；
- `deadline`；
- terminal 时的 `terminal_at` 与 `terminal_reason`。

只允许 source-side reconciliation 写回缺失的调度字段或执行明确的 deadline terminal；read-model rebuild 始终只读 source，不能续期、终结、隐藏或移动任何 source item。

read model 每次持久化前必须读取上一版 persisted model 的稳定 `item_id` inventory。首次没有 baseline 时允许 `bootstrap_no_previous_model`，但 metrics 必须显式记录；其后任何上一版非终态或终态 `item_id` 在新 source projection 中消失，都令 `continuity_holds=false`、列入 `missing_previous_item_ids`、rebuild fail-closed，并保留 last-good model。live multiview 移入 `abandoned/` 仍保留同一 `item_id`，不属于消失。

`entry-lifecycle-proposals.jsonl` 的 1000 行边界是响亮容量门：满载时 duplicate/no-op 仍可读取，但任何真实新 arrival 必须整次失败且不得部分覆盖；read-model source metrics 必须暴露 proposal row count、limit 与 limit-reached。不得以 tail slice 或 `limited` 静默丢弃新 arrival。

### 2. 有界 pending 与失败分类

所有非 terminal 项必须同时具备下一触发和 deadline，不允许 `pending + no schedule + no deadline`：

| failure class | 调度语义 |
|---|---|
| `provider` | 指数 backoff，单次不超过 24 小时 |
| `transient` | transport/runtime 短暂失败，bounded exponential backoff |
| `parse` | 短 backoff 后重试 |
| `conflict` | bounded backoff；新冲突证据也可提前触发 |
| `writer` | 已获 reviewer 决定但 persistence 失败；writer-only backoff，deadline 到期全局终态归档 |
| `semantic_defer` | 等待具名新证据，同时保留低频自治 recheck |
| `none` | 首次 pending 的短调度窗口 |

每个 deadline 都必须有 source-side 自治动作：multiview 到期由全局 sweep 写 terminal metadata 并原子移入 `abandoned/`；provisional 到期原地写 `soft_archived` 与 `provisional_deadline_expired`；普通 proposal 到期原地写 terminal reason。E1 `frontmatter_superseded + execution_ready` 例外采用真正有界重试：初始 `attempt=0`，deadline 到期且 `attempt < 3` 时原地 `attempt+1`，以 5 分钟为基数生成有上限的指数 retry（单次不超过 24 小时）和新的 1 天 deadline；`attempt=3` 的下一次 deadline 到期才以 `lifecycle_retry_cap_reached` terminal。每次迁移都保留 proposal 全文字段、provenance 与稳定 identity。后续独立证据仍可重新打开 eligible E2。`multiview-pending` 到 retry cap、stale 或 lifecycle deadline 后，必须全局 sweep 到 terminal；不能因当前 project owner 不匹配而绕过。

`next_retry_not_before_iso` 是 multiview replay/writer 的 operational canonical 字段，只能由实际 replay/writer attempt 写入。lifecycle reconciliation 可以读取它并更新 `lifecycle_next_retry_not_before` mirror，但不得反向创建或续写 operational 字段；read model 优先读取 lifecycle mirror，缺失时才兼容读取 operational canonical。

### 3. E2 是自治 evidence-defer，不是 review queue

`superseded_no_successor` 的 E2 固定为：

- `disposition=defer_until_new_evidence`；
- `status=deferred_until_new_evidence`；
- `failure_class=semantic_defer`；
- `new_evidence_trigger=new_valid_successor_edge|status_no_longer_superseded|independent_attributed_evidence`；
- 有 `next_retry_not_before` 与 `deadline`。

所有 E2 identity、successor/status reconcile 和 attributed-evidence join 都以规范化 `project_root` + slug 为作用域；跨项目同名 slug 不得终结、替换或重开另一项目的 E2。

三种自治迁移为：

1. 发现有效 successor edge：旧 E2 terminal `failed/successor_edge_observed`，自动创建 E1 `execution_ready` proposal；
2. 条目不再是 `superseded`：E2 terminal `failed/status_no_longer_superseded`；
3. independent attributed evidence 到达：E2 重新打开为 `pending/execution_ready`。

历史 raw `review_required` E2 必须原地迁移并移除该字段；不得把它映射到人审、operator queue 或用户管理面。

### 4. Terminal 必须保留全文且可逆

Staging terminal 采用明确 disposition + 原子 move 到 `abandoned/`。终态记录保留完整 candidate、reason、timestamps 与原 provenance，live loader 不再拾取它。重复 sweep/archive 是幂等成功。

E1 的 `lifecycle_deadline_expired` 兼容终态或 `lifecycle_retry_cap_reached` 新终态不是永久死亡状态。当且仅当该 E1 所属的规范化 `project_root` 再次执行 frontmatter scan，并在同次 scan 中仍观察到该 slug 为 `status=superseded` 且具有 valid non-self successor 时，scan 作为 target-project executor-capacity/session trigger，可以把同一 proposal identity 原地重开为 `pending/execution_ready` 并启动新的 bounded retry epoch。全局 reconcile 和其他 project 的 scan 都不得重开它；同名跨项目 slug 必须严格隔离。该机制不新增队列，不扩大 forgetting executor 权限，也不改变 E2 的三种证据迁移。

禁止以下 cleanup：

- `unlink`；
- 把 staging cleanup 解释为 `git rm`；
- 只保留 digest、摘要或丢失原 candidate 的 tombstone。

物理删除不是本状态机的后续阶段。`staging.hard-delete` 继续在 transition register 中保持 `blocked / separate_authorization_required`；只有新的独立 ADR 和显式授权才能改变这一边界。

### 5. Cohort 与守恒验收

切换点固定为 `2026-07-16T18:55:00.000Z`：此前为 legacy cohort，此后为 fresh cohort。每次 rebuild 必须同时给出总量与 cohort 分量：

- arrivals；
- terminal；
- pending；
- oldest pending age；
- retry count；
- failure-class distribution；
- unbounded pending。

硬验收为：

```text
classification_delta = arrivals - terminal - pending = 0
continuity_holds = true
missing_previous_item_ids = []
unbounded_pending = 0
```

`arrivals = terminal + pending` 只证明本次 projection 分类完整，不能单独称为守恒。真正的 loss detection 来自上一版 persisted stable inventory；total conservation 只有在分类完整且 continuity 成立时才为 true，legacy/fresh cohort 也会因该 cohort 的 prior item 丢失而失败。source 腐损、proposal cap overflow 或 continuity loss 时 rebuild fail-closed，并保留最后一个完整 read model，不得用部分输入覆盖 ledger。

## Consequences

正向后果：

- 三条历史队列共享一个可审计的有界生命周期；
- provider/parse/conflict/defer 不再混成含糊 pending；
- E2 不再制造任何人工记忆管理面；
- terminal cleanup 不损失原始证据；
- restart、repeat sweep 与 rebuild 可通过稳定 ID 和守恒式验证。

接受的代价：

- `abandoned/` 会长期保留全文，占用本地存储；
- read model 是额外派生文件，必须维护 schema 与原子重建；
- 统一 metrics 不消除 source queue 各自的业务差异，writer authorization 仍由原边界控制。

## Non-Goals

- 不改变 forgetting executor 的 durable archive 权限；
- 不新增 Lane G pipeline；
- 不把 contested/low-confidence 条目送入人类队列；
- 不把 transition register 的 blocked 面解释为已授权；
- 不以 cohort 指标自动触发任何物理删除。

## Verification

2026-07-23 跨供应商 T0 复核通过，无未解决 P0/P1；本阶段为 `completed / authorized`，fully authorized（transition-register machine enum: `authorized`）。该授权只覆盖本 ADR 的生命周期收敛面，不授权 `staging.hard-delete`，不新增 Lane G、人审/operator queue，也不扩大 forgetting executor 权限。

规范性回归入口为 `npm run smoke:lifecycle-convergence` 与 `npm run smoke:entry-lifecycle-proposals`。它们必须覆盖 legacy/fresh、双项目同 slug E2 隔离、E2 三态、provider/transient/writer backoff、+1d/+7d deadline source action、E1 首次 expiry bounded pending retry、E1 retry-cap terminal、其他 project scan 不重开、目标 project valid scan 原 identity 重开并可被 executor 消费、stale/retry-cap terminal、全文保留、幂等 sweep/rebuild、source corruption/cap/continuity fail-closed、restart stable IDs、守恒与无 Lane G/operator queue。

Production dossier 必须把 `continuity_holds=true` 与 missing count zero 纳入 acceptance。若首轮执行实际迁移 source，dossier 必须分开记录 first-pass mutation 和后续 idempotent replay；若 source 已迁移，本次只可称 `idempotent_verification_only`，不得冒充首次 migration evidence。2026-07-23 最终 production evidence 属于 `idempotent_verification_only`，不声明首次 migration 证据。`self_sha256` 的 canonical convention 是：递归按 object key 排序、array 保序、compact JSON 序列化，计算时排除尚未写入的 `self_sha256` 字段，再对 UTF-8 bytes 做 SHA-256。

相关决策：[ADR 0024](./0024-second-brain-from-natural-conversation.md)、[ADR 0025](./0025-sediment-meta-curator-subsystem.md)、[ADR 0031](./0031-autonomous-self-calibrating-forgetting.md)。
