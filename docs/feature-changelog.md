---
doc_type: consensus
status: active
---

# Feature / Requirement Change Log

> **功能/需求级**变更记录——不是代码变更/commit 流水。人类拥有，agent 代起草，人类签字。
> 规则：每条至少回答"什么需求/功能方向/人类级约束/验收/非目标变了"。只回答"什么代码变了"的不进这里（那是 git / abrain 技术记忆）。
> 状态：`proposed` / `accepted` / `rejected` / `superseded`。

---

## 2026-07-24 — accepted — Sediment intake owner-root isolation and foreground footer fencing (adee7c5 regression)

### 变更

修复 adee7c5 引入的回归：`session_start` 曾全局扫描 `~/.abrain/.state/sediment/intake/pending`，把其它 checkout（如 pi-router2）的 pending 交给当前实例评估，并用当前 UI reporter 显示别 session/root 的 `project_not_bound:path_unconfirmed`。用户明确要求当前目录不管别目录。

Durable intake receipt 现在记录 canonical `sourceProjectRoot`（绑定/git root，不是任意 subdir cwd），并参与 stable identity。旧 v2 receipt 保持向后兼容：可从 cwd/session source 解析 owner root；无法可靠确认 owner 时不由任意实例 claim，只写 status/audit 并留 pending。`session_start` recovery 必须传入当前 boot 的 physical project root，只调度 owner root 严格相等的 pending；相同 `project_id` 不同 checkout 隔离，不按全局 projectId 扫描。Foreground status fencing：set footer / notify 前验证 target sessionId == current foreground sessionId，并用 session epoch/generation 防止 `/new` `/resume` `/reload` 后旧 async callback 更新新 UI。非 foreground recovery 可写 source audit 与内部 state，但不得 setStatus/notify 当前 UI。Global publication one-shot 仍可收敛 accepted L1，但其状态不得写当前 session footer，除非 receipt 对应当前 foreground session。session_start/agent_start 在当前 bound 且无本 session 错误时清掉跨 session 污染 footer，不隐藏真实当前 session failure。

### 验收边界

`smoke:sediment-intake-publication` 增加真实两个 temp git roots、相同 project_id 的隔离断言：root A 启动只处理 A receipt，B 保持 pending 且 A footer 无 B warning；切换/new 后旧 generation 不能覆盖；当前 session `path_unconfirmed` 仍正确显示；旧 v2 receipt owner 兼容；同 root 重启恢复继续通过。回归 intake pub/queue/memory/knowledge/canonical session start。生产只读验证：`/home/worker/.pi`（pi-global bound）owner selector 不得选中 pi-router2 pending，且不消费/删除 production pending。

### 状态

`accepted` with regression fix。

### 关联

[architecture/sediment.md](architecture/sediment.md)；[Smoke reference](reference/smoke-tests.md)。

## 2026-07-23 — accepted — Sediment event-first acceptance expansion and queue retirement (phase 2)

### 变更

Sediment `agent_end` 第一条端到端切片：在任何 canonical startup / Git busy 判断之前，将当前可沉淀窗口以稳定 `windowId`、create-only、fsync 写入 `~/.abrain/.state/sediment/intake/pending/`。intake 仅保存不可变的 Pi session-file/tip 坐标、capture diagnostics 与 digests，不复制 transcript，也不是 semantic truth；恢复时用 Pi JSONL parser 重建该 tip 的精确 branch。process-local queue 改由 durable intake 驱动：当前 `agent_end` 异步消费；`session_start` 在取得 model registry 后扫描 pending 恢复。同 session 串行、跨 session 保持既有 max concurrency。不再用 15 分钟 TTL 删除 durable intake，也不因 canonical busy 永久 park 评估。

Knowledge 的 accepted durability 已从 create 扩到 update/delete/archive/supersede/merge/reactivation-as-update：生产 `event_first` + legacy markdown disabled 下先读 stable view 并做 output/watermark/event-identity guard，再 create-only 追加 L1，随后为每个 event create-only 写 publication work，只有整组都 durable 才返回 `durable_pending` 并允许 checkpoint 前移。Outbox 仅引用 `eventId`，不复制 event body 或 L2 payload。merge target/source 的 receipt 不全时保持 nonterminal HOLD；崩溃后重复重放生成相同 eventId/outboxId。每类 operation 的 `created_at_utc` 来自 immutable source timestamp，缺失以 terminal `source_timestamp_unavailable` fail-closed 并允许 checkpoint 前移，不用 `new Date` fallback，也不重复调用 LLM。`entry_not_found`、duplicate/validation/lint/status-precondition/credential 等确定性 reject 保留原 taxonomy；L1 append write/collision 与 outbox write failure 仍为 nonterminal。

并发 invariant 改为 event topology 权威：L2 stable watermark 可以是当前 L1 的已验证 ancestor；publication lag 不再触发锁内二次 freshness/duplicate 拒绝。并发同 slug event 共享 causal parent，winner 只由 deterministic topo fold 决定。Legacy 配置继续旧同步 markdown/lock/Git 路径。Outbox publisher 在一次 OFD acquisition 后只冻结一次 ready batch（普通目标 <=64，merge 不拆；单原子组 >64 可单独完整 freeze，禁止静默饿死）和 HEAD；semantic closure 仅为 frozen HEAD tree 中 registry-validated Knowledge L1 + frozen batch validated L1。HEAD 通过 structured `ls-tree` + `cat-file --batch` 读取，projection API 对显式 node set 纯计算，freeze 后新增 L1/outbox 或其他 worktree drift 不进入 cohort。batch 全部 L1、affected L2 output/removal 与同 closure manifest 由一次 temp-index/ref-CAS/index convergence 发布；HEAD dangling watermark/manifest 同批自动修复，无 pending 时显式 one-shot 也可 repair-only。CAS 后 ack 前崩溃由 HEAD byte no-op、index convergence 后再 ack；busy/CAS/index failure 与 detached/unborn/symbolic-ref 暂不可用前不 ack、不进 failed，partial receipt 留 pending；仅 content/schema/identity/path 确定性 terminal 进 `failed/`。Publisher 不调用 startup/requestDrain/whole-history recovery，不新增 push，push 与 ack 解耦。

Sediment 专用 queue 删除 `waitUntilReady`、park/wake、TTL、park bytes、readyPending 与 external readiness lifecycle，只保留 per-key latest coalesce、同 key 串行、跨 key max concurrency、`more` continuation 和 error containment；重启恢复完全由 durable intake 负责。`extensions/sediment/index.ts` 不再 import/call canonical startup consumer。每次 `agent_end`/`session_start` 最多触发一次 one-shot publisher；busy 立即返回并留盘，无 timer/backoff，terminal unknown/failed 进入可见 `failed/`，完成后 footer 回 completed/idle。merge outbox 带稳定 batch identity/size 与同一 intake `windowId`，durable receipt 不全时 publisher 跳过整个 partial batch；仅 exact window 仍 pending 时 hold（legacy 无 windowId 才 session fallback），防止崩溃恢复前 stable parent 先推进。producer nonce replay 与 done receipt lookup 保证 publication 后重放不新增 L1 或重新入队。

ABOUT-ME 没有 append-only identity L1 domain。把完整 sanitized identity draft 复制进 intent outbox 会扩大隐私驻留且仍不构成 semantic truth，因此 Phase 2 保留 existing synchronous `writeAbrainAboutMeUnlocked` 路径，不宣称 L1/durable_pending；这是明确的 Phase 3 schema/privacy blocker。RM-FORGET 正式授权和门控不变。

### 验收边界

`smoke:sediment-knowledge-mutations` 在 `canonicalGitRuntime.enabled=true` 的真实 temp Git repo 建立 stable view，再由 fresh child 持有真实 OFD，覆盖 update/hard-delete/archive/supersede/reactivate/merge 全部 L1+outbox+checkpoint accepted 且 L2/HEAD 不变，释放后 one-shot 收敛；另覆盖 scheduler busy immediate-return、partial batch gate、同 slug 并发 deterministic fold、merge partial-crash all-event replay、detached HEAD retry/pending、windowId exact-hold 与 merge 成员同 window，以及 stable parent 已推进后的 eventId/done-outbox 重放幂等。`smoke:sediment-agent-end-queue` 聚焦 latest coalesce、同 key 串行、不同 session 并发、continuation 和 strict error recovery，并静态证明 park/readiness API 已删除。`smoke:sediment-intake-publication` 另构造 tracked A、disk-only B、batch C 与 freeze-after tail D，锁定 HEAD/manifest 只含 A/C、B 仍 untracked、D 留下一批；并覆盖 `projectOnWrite=false` L1 cohort、CAS 后 crash/noop ack、无 pending dangling-L2 repair-only、L1 conservation、canonical enabled、oversized atomic freeze、exact-window readiness 与 non-cohort staged preservation。`smoke:memory` 的 missing timestamp 与 terminal reject 断言同步锁定 taxonomy；forgetting formal gate、reactivation/staging/multiview 保持回归。`dossier:sediment-intake-production-readonly` 默认 stdout，仅 `--output` 写文件，仍只读且不消费 live intake/outbox。生产 repair-only frozen-publisher 证据（closure 3→0、L1 tail 827→827、exact 3-path cohort、无 push）已持久化为 [production acceptance](evidence/2026-07-23-sediment-production-acceptance.json)，状态为 `accepted`。

### 残余与非目标

Shared canonical runtime 仍供其他 owner 使用；constraint/outcome 全 mutation outbox 与 ABOUT-ME semantic domain 未完成。publication outbox 不做新 daemon/SQLite/全局沉淀 worker，不退回 shared-index `git add`。

### 关联

[ADR 0027](adr/0027-coupled-stigmergic-dual-loop-agent-system.md)；[architecture/sediment.md](architecture/sediment.md)；[Smoke reference](reference/smoke-tests.md)；[production acceptance](evidence/2026-07-23-sediment-production-acceptance.json)。

## 2026-07-23 — accepted — RM-FORGET-001 formal full-production authorization

### 变更

用户作出 fresh explicit authorization：不增加 canary，不等待 30d、recall/none baseline 或 reviewer，直接正式全量启用 RM-FORGET real apply。production `memory.forgetting.enabled=true`、`instrumentation=true`、字面布尔 `executorRealApplyEnabled=true`，并保留 effective `sediment.autoLlmWriteEnabled=true` 全局门，dedicated/global/AND 三者均为 true。memory/sediment 的 `loadPiStackSettings` 每次 resolve 都同步读取父 settings，forgetting slice 在每个 `agent_end` 重新 resolve 双门；formal authority 已 armed、无需重启，并在下一次 `agent_end` 生效。所有当前代码允许的 E1 kind 可执行；非 E1 继续既有 evidence/kind gates。

### 验收边界

5/batch、20/day、CAS、corpus floor、resurrection backoff 保持 circuit breakers，不是 canary。30d、recall/none 与 reviewer 改为运行中观察和后续放量质量指标，不再作为启用前门。armed production dossier 必须在任何 executor 前聚合 eligible；若非零立即停止。本次 eligible=0，只证明双门配置与 source/durable/demote/reactivation 前后 hash 不变、current action=0，不声称 nonzero executor 已验收，也不手工制造 candidate。

### 状态

`forgetting.upstream-wiring` 改为 `in_progress / authorized`。正式全量路径已授权且会由下一次 `agent_end` 热重读生效；尚无自然出现的 nonzero production demote + reactivation audit，因此不是 completed。

### 不变边界

不移除 5/batch、20/day、CAS、corpus floor 或 resurrection backoff；不执行本次 production demote；不修改 durable memory status/body；不建立 canary、Lane G 或人工队列；不 hard-delete。自治终态仅全文 `archived`，archive reactivation 保持独立。

### 关联

[ADR 0031](adr/0031-autonomous-self-calibrating-forgetting.md)；[Roadmap](roadmap.md)；[Transition register](transition-register.md)；[armed production dossier](evidence/2026-07-23-rm-forget-001-real-apply-gate-production.json)。

---

## 2026-07-23 — superseded — RM-FORGET-001 fail-closed real-apply hold

> 本条的双门实现与 fail-closed 语义继续有效；其中“保持 production gate false、等待前置指标再授权”的状态已由上方 fresh explicit authorization 取代。

### 变更

新增专用 `memory.forgetting.executorRealApplyEnabled` real demote gate，默认 false，生产显式 false，且只接受字面布尔 true；缺失、旧 settings、null、字符串与数字均 fail-closed。真实 demote 采用 AND 双门：专用 gate 提供独立授权；global write authority 与既有 effective `sediment.autoLlmWriteEnabled` 语义一致，布尔 true 和 schema 合法的 legacy `"true"` 均有效，`staging-only`、false/`"false"`、缺失和 malformed 均关闭。二者任一不能单独授权。`memory.forgetting.enabled` 继续运行 decay、frontmatter bridge、E2 reconcile、lifecycle convergence 与 proposal planning/dry-run。agent_end 编排与 executor 双层检查；hold summary/audit 分别使用 `executor_real_apply_gate_closed` 或 `global_write_authority_gate_closed` / `real_apply_hold`，不得误报 `real_apply`。

### 验收边界

focused smoke 动态覆盖 E1 全 kind（含长尾）与非 E1：dedicated 四象限仍仅字面布尔 true 可开；global raw-value matrix 证明布尔 true 与 legacy `"true"` 投影为 true，而 staging-only、false/`"false"`、缺失和 malformed 投影为 false。任一 effective gate 关闭时 callback 零构造零调用、proposal 不 executed、lifecycle hooks 继续，并直接向 executor 注入 callback 验证第二道全局门仍拒绝。archive reactivation 继续按既有 `autoLlmWriteEnabled` 逻辑独立运行。真实 production dossier 仅记录 aggregate counts/hashes，确认双门 effective closed、eligible current=0、proposal/durable/lifecycle/demote/reactivation hashes 不变及 lifecycle read-only build 可运行；它不声称真实 candidate blocking 或 production demote 已验收。

### 状态与解除条件

该 hold 落地当时，`RM-FORGET-001` / `forgetting.upstream-wiring` 为 `blocked / separate_authorization_required`，并把 dossier、recall/none baseline、30d window、reviewer/evidence 与 fresh authorization 列作解除前置；这些启用前置已由上方 fresh explicit authorization supersede。staging hard-delete 的 blocked 边界未变。

### 非目标

不执行 production demote，不修改 durable memory status/body，不开启 real gate，不回退 RM-LIFECYCLE-002，不关闭 archive reactivation，不新增 Lane G、人审队列或 hard-delete。

### 关联

[ADR 0031](adr/0031-autonomous-self-calibrating-forgetting.md)；[Roadmap](roadmap.md)；[Transition register](transition-register.md)；[production gate dossier](evidence/2026-07-23-rm-forget-001-real-apply-gate-production.json)。

---

## 2026-07-23 — accepted — RM-LIFECYCLE-002 bounded lifecycle convergence

### 变更

provisional staging、multiview-pending 与 entry-lifecycle proposal 统一为 source-ledger-first 的有界生命周期：每个 pending 项必须有 attempt、failure class、下一 retry 或 new-evidence trigger、deadline；deadline 到期必须执行 source-side 自治动作。所有 multiview transient creation branch 统一经过同一 IO 边界，在共享 mutation lock 内用单一 helper 生成稳定 item/cohort/attempt/failure/schedule/deadline/trigger，并与 source 文件同次原子创建，不等待下一次 `agent_end` reconcile。E1 execution-ready 首次到期不再永久 failed，而是在 3 次 cap 内执行 bounded exponential retry，到 cap 才 terminal。统一 read model 只作只读重建，不获得 source writer 权限。

E1 的兼容 `lifecycle_deadline_expired` 或新 retry-cap terminal 仅在所属 project 再次扫描并确认 durable `superseded + valid successor` 时按同一 proposal identity 原地重开；其他 project scan 不得重开。E2 `superseded_no_successor` 仍为自治 `defer_until_new_evidence`，successor/status restoration/independent attributed evidence 按规范化 project_root 隔离地自动终态、创建 E1 或重开，不建立人类/operator queue。stale/retry-cap/deadline terminal 使用全文保真的可逆 archive。proposal 1000 行 cap 对新 arrival fail-loud，不再 silent limited。

### 验收边界

固定 legacy/fresh cohort；`arrivals = terminal + pending` 只作为本次分类完整性，真正守恒由上一版 persisted stable item inventory 的 `continuity_holds=true`、`missing_previous_item_ids=[]` 验收，并要求 `unbounded_pending=0`。focused smoke 覆盖七种 multiview 创建分支在 reconcile 前立即有界、未知 state 显式 throw/corrupt-source fail-closed、terminal live 残留先清 schedule 后全文归档、fresh module restart ID 稳定、双项目同 slug、E1 +2d 首次 pending retry、推进到 cap terminal、其他 project 不重开、目标 project 原 identity 重开并可被 executor 消费、+1d/+7d deadline source action、provider/transient/writer、capacity cap、rebuild/idempotency、corrupt/continuity fail-closed。2026-07-23 跨供应商 T0 复核通过，无未解决 P0/P1；阶段为 `completed / authorized`，fully authorized（machine enum: `authorized`）。production dossier v2 将原 35-row、unbounded 1→0、payload-excluding-lifecycle/durable unchanged 且 self-hash-valid 的首次迁移完整保留为 historical evidence；每次真实 wall-clock rerun 在 `current_run` 下独立记录 before/actions/after 和 evidence mode，当前无 initial unbounded 时不要求 `before>0`，新 action 不冒充首次 35-row 迁移。

### 非目标

不新增 Lane G，不改变 durable writer/forgetting authorization，不授权 staging hard-delete、`git rm`、`unlink` 或 digest-only tombstone。`staging.hard-delete` 继续 `blocked / separate_authorization_required`。

### 关联

[ADR 0043](adr/0043-lifecycle-convergence-and-reversible-terminal-state.md)；[Transition register](transition-register.md)；[Current state](current-state.md)；[production dossier](evidence/2026-07-23-rm-lifecycle-002-production.json)。

---

## 2026-07-23 — accepted — RM-LIFECYCLE-001 reversible archived lifecycle substrate

### 变更

完成 archived lifecycle retrieval substrate：active 与 archived 均可保留于可重建 dense index，但 archived dense 候选仅供 `sedimentDedup` 使用，默认 active/user-facing retrieval 不泄漏 archived 或 superseded。reconcile 的合法集必须是完整 lifecycle corpus；archived-dense profile 缺少该集合时 fail-closed，不触发 add/prune。

生产验收拆为两门：真实 production archived surface（当前快照 15 条，重跑门只要求 archived>0 并记录实际数量）与真实 query corpus 验证 dense dedup、默认 active 边界和 archived 非 orphan；真实历史 archived→active 链验证 A 的 ledger/audit/git provenance、C 的 ADR0039 L1 event chain，并以 A 的 archived 历史快照通过正式 writer/CAS 做隔离重放。dossier 不伪造无 ledger provenance 的 formal reviewer observation，也不重放 LLM decision。

### 验收边界

`npm run smoke:archived-dense`、`npm run smoke:stage0-nonactive` 与 `npm run dossier:rm-lifecycle-001-production` 必须通过。production dossier 不写 `~/.abrain`、不重新调用 LLM 制造 decision、不输出 source 正文或 slug 明文；记录 source ledger/audit/git/L1 hashes、隔离 writer/CAS 结果与自 hash。

### 非目标

历史真实 reactivation 只证明可逆 lifecycle substrate，**不**等同于 `RM-FORGET-001` nonzero demote 批次完成。后续 fresh authorization 已把 forgetting 改为 `in_progress / authorized`，但不授权 physical delete，也不把历史 reactivation 冒充本次 action 验收。

### 关联

[Roadmap](roadmap.md)；[Transition register](transition-register.md)；[production dossier](evidence/2026-07-23-rm-lifecycle-001-production.json)。

---

## 2026-07-22 — accepted — RM-OUTCOME-001 outcome evidence spine

### 变更

建立内容寻址 L1 outcome evidence spine：`memory exposure -> action/outcome -> rejudge`，并派生可重建 index。独立真实来源限定为 test/lint/build、明确 workflow/tool terminal result、git revert/rewrite 与用户自然纠正；unknown 与 candidate 显式保留，不为 memory join 伪造因果。普通 LLM self-report、footnote、exposure 与沉默不具独立权威。lifecycle proposal 按 slug 消费 attributed independent evidence；prompt-revision 另需 index `proposal_id` 精确绑定稳定 proposal_id，否则安全 defer。历史人审行迁为自治终态或 `defer_until_new_evidence`，不建 human/operator queue、不自动改 prompt。真实 Path A 隔离重放写入 production dossier，供 L1/index 一致性验收。

### 验收边界

独立来源可稳定重放；unknown 不伪造 join；非独立信号不触发 rejudge。lifecycle 仅 attributed independent evidence 重开；prompt-revision 仅 proposal-bound attributed independent evidence 解锁。主要命令：`npm run smoke:outcome-evidence`、`npm run smoke:outcome-classifier-enrich`、`npm run dossier:outcome-evidence-production`。dossier 证明 L1/index 与自治 rejudge 一致，**不**宣称 attributed 生产闭环已完成。

### 非目标

不自动改 prompt；不建立人工标注/operator disposition 队列；不把 footnote/沉默/exposure 升格为独立 outcome；不夸大为 attributed 生产闭环。

### 关联

[Roadmap RM-OUTCOME-001](roadmap.md)；[Transition register](transition-register.md)；[production dossier](evidence/2026-07-22-rm-outcome-001-production.json)；[2026-07-08 outcome unknown triage](audits/2026-07-08-outcome-unknown-triage.md)。

---

## 2026-07-22 — accepted — Retire dispatch_hub

### 变更

立即退役 `dispatch_hub`：运行时工具面只保留 `dispatch_agent` / `dispatch_parallel`；删除 hub 专属实现、settings schema/live 配置与 smoke/oracle/backfill 入口。ADR 0030 标为 superseded，transition stable ID 收口为 completed；历史 ADR、audit 与 material ledger 保留但不再增长。

### 原因

真实采用极低，唯一 material 判定为 `human_better`。`task -> hub -> worker` 同时引入任务到 hub、hub 到 worker 的两级有损转述，而主会话已有的 direct dispatch primitives 足以表达模型、角色与并行策略。

### 验收边界

runtime、schema、live settings 与 package scripts 不再出现 hub 能力；不继续 20 条 dogfood。历史 transcript 中的旧 `dispatch_hub` toolResult 仍由 sediment withhold，防止回放时把 L2 聚合误当用户隐式真值。`dispatch_agent` / `dispatch_parallel` 行为不变。

### 非目标

不删除真实历史 ADR/audit/ledger，不修改 direct dispatch 的执行、并发、工具授权或审计语义。

### 关联

[ADR 0030](adr/0030-l2-hub-baseline-and-evaluation-harness.md)；[Transition register](transition-register.md)；[Current state](current-state.md)。

---

## 2026-07-21 — accepted — Concurrent startup busy retry and post-mutation classification lock scope

### 变更

Canonical startup 改为显式 phase machine：锁外 initial freeze/classify；锁内复验后只做 journal bootstrap；锁外 recovery classify；再次入锁复验并做 metadata index/recovery/backlog mutation，同时冻结 final `HEAD + scanRoot + statusHash`；锁外 final classify；最后入锁复验 tuple 且确认无 open/quarantined recovery 才发布 ready。任何 drift 都释放 barrier 后从 initial freeze 独立有界重算，未验证状态不得宣称 ready。

startup runtime 仅捕获 `CANONICAL_MUTATION_BUSY`，在不消耗 drift 次数的 monotonic 总预算内（生产默认 10 分钟，单次 barrier timeout 仍默认 30 秒）使用 exponential backoff+jitter；每次重试 fresh freeze，同 startup key 维持单 shared promise 与最多一个 timer。预算耗尽不 reject：返回 typed `startup=deferred/deferredReason=CANONICAL_MUTATION_BUSY/retryable=true` diagnostics，清 timer、逐出 instance/global promise，等待后续 session/agent-end lifecycle 再触发。未知异常仍 reject fail-closed。底层 OFD barrier probe 从固定 25ms 改为 capped exponential backoff+jitter，并保留可注入 random/sleep/now/probe 与单调用 timeout 语义。terminal startup rejection 按 key 最多一条 generic error；abrain/sediment continuation 继续读取动态最新 reporter。

### 验收边界

真实两个 startup 子进程：A 从有效 Knowledge backlog 执行真实 drain、推进 HEAD 并延迟 mutation phase；B 的同一 shared promise 经低层 timeout 后 fresh-freeze 重试并 ready。A 的 final classification 延迟超过单次 timeout 时，独立 barrier probe 仍在毫秒级获得锁并提交真实 tracked HEAD drift；A 必须拒绝 stale final tuple、重算后才 ready。最终 checkpoint 后 repo clean、exact content cohort 与 recovery closure 正确。永久 holder + 短总预算必须 deferred、无 red error/并发 timer；holder 自然释放后外部 consumer trigger 使 abrain/sediment `onReady` 各一次。多 waiter 的 probe 数只对应 process-local 首 waiter 的指数退避加各 waiter 成功 probe；低层 timeout 仍返回 `CANONICAL_MUTATION_BUSY`。canonical runtime/session-start/device-join/git-sync/sediment smoke 不回归。

### 残余与非目标

本变更不修改 `~/.abrain`，不管理或中止既有 pi 进程，不改变 device-join 显式 settlement 的同步分类边界。由于 canonical runtime 与 mutation barrier 属于 R4.2 source closure，六个 committed evidence inputs 从本次 exact index snapshot 重新生成并一同发布。

### 关联

[ADR 0027 C6](adr/0027-coupled-stigmergic-dual-loop-agent-system.md#c6新--跨-l1l2-causal-trace-共享-session-id--turn-id-锚点)；[Current state](current-state.md)；[Smoke reference](reference/smoke-tests.md)。

## 2026-07-20 — partially superseded 2026-07-23 — Awaited agent_end liveness and outside-barrier recovery classification

### 变更

Sediment 的 `agent_end` 从 awaited inline pipeline 改为 durable intake + process-level multi-key queue：handler 在交互预算内返回；同 key 串行、跨 key 有全局并发上限，checkpoint v3 保留 branch lineage + per-candidate idempotency，`more` continuation 继续处理冻结 backlog，后台 rejection 由 queue boundary containment。2026-07-23 已删除本条最初引入的 readiness park/wake/TTL/bytes/readyPending 机制；durable intake 是唯一 restart recovery source。

Canonical **startup 不可变 recovery-history classification 移出 mutation barrier**：`headBefore→scan/status→headAfter` 冻结（HEAD 变即 drift）；cache key 含 statusHash；freeze/scan 异常也进 barrier 稳定重抓（漂移重试 / 稳定 fail-closed）。batch parser 单次拷贝 + 容量倍增 ring buffer；property tests 覆盖 header/body/delimiter 全切点、随机切点、多 record、grow+compact。

### 验收边界

当前 queue 验收为 latest coalesce、同 key serial、跨 key cap、`more` continuation、`--unhandled-rejections=strict` error containment；restart losslessness 由 intake/recovery smoke 证明。Canonical recovery-history 的 4,000 blob、ring-buffer property、HEAD drift 和 multi-process cold-start 验收仍保留。

### 残余与非目标

`agent_settled` 不是替代触发器。本批不修改 `~/.abrain` production data。structuredClone 对 multi-MB / multi-10k-entry branch 不保证 <100ms。checkpoint lineage 的 processedCandidateKeys 是有界 rolling set，不是无限历史；writer 自身 duplicate terminal 仍是最终幂等网。v3 join search 仍是 O(pairs×merges)。device-join 路径上部分 classification 仍可能在已持有 barrier 的 mutation 流程内；cold-start awaitStartup 是锁外分类权威路径。真实 extension worker 对 LLM auto-write 大 backlog 的 end-to-end 时延未做硬 SLA。

### 关联

[ADR 0027 C6](adr/0027-coupled-stigmergic-dual-loop-agent-system.md#c6新--跨-l1l2-causal-trace-共享-session-id--turn-id-锚点)；[REQ-002](requirements.md#req-002--运行状态可见管理负担隐身)；[REQ-004](requirements.md#req-004--显式用户指令是被见证的-ground-truth)；[Smoke reference](reference/smoke-tests.md)。

## 2026-07-20 — accepted — Abrain automatic multi-device convergence

### 变更

Abrain device delivery从`fetch + ff-only + push`升级为自动确定性收敛：唯一merge-base完整tree join、L1 add-only精确并集、注册L2从union L1版本化全量重建、普通tracked路径文件级三方选择，以及exact-OID upstream push。真实双侧内容冲突typed fail-closed；merge-tree、rebase、force push与LLM merge不进入协议。

### 验收边界

per-repo OFD barrier覆盖`gitCommit:true` canonical/legacy writer、projector确定性落盘+commit/CAS与join mutation；constraint LLM compile/verifier保留专用compiler lock但在OFD外运行，publish前重验冻结HEAD和input root/event set。global singleton lease兼容jiti module copies且阻止detached continuation继承已释放锁，bind detached push显式退出barrier ALS。完整`H -> M` journal支持CAS各崩溃窗口恢复，publish前验证全部delta path；普通ignored碰撞pre-CAS拒绝，仅registered L2旧untracked+ignored投影可安全迁移并清旧manifest ignore行。恢复只接受exact H/M，且只清理与journal M blob前缀验证一致的协议atomic temp；未知dirty保持fail-closed。清journal前验证HEAD/index/全部tracked worktree及L1/L2。writer delivery与push rejection均执行有界fetch/join/push；网络、认证与timeout保持fail-soft。`l2/views/knowledge/latest/manifest.json`继续作为tracked canonical L2。startup barrier获取超时的rejected promise可在同进程重试。首次切换必须重启所有旧实例。

### 非目标

不管理remote、upstream、认证、transport或hooks；不把真实内容冲突交给LLM或日常用户人工合并；不修改`~/.abrain`生产数据。

### 关联

[ADR 0020](adr/0020-abrain-auto-sync-to-remote.md)；[Direction](direction.md#inv-sync-deterministic-merge同步只走确定性合并adr-0020)；[Smoke reference](reference/smoke-tests.md)。

## 2026-07-17 — accepted — ADR 0040 lifecycle freshness closure

### 变更

ADR0040 lifecycle freshness control plane采用独立 head freshness/safety pointer 与 selection activation pointer，staged append由retained OFD lock、S0-S4 recovery FSM及acyclic intent/proof/head/selection closure保护。Real policy proposition append与runtime-inert D3 generation-0 publication分别经独立授权完成。

### 验收边界

Published selection闭合production proposition source、policy candidate与stable item，但不连接Knowledge pull、Policy push、`session_start`、canonical L2或其它runtime consumer；未改变legacy authority。P1 consumer flip、P3与P4仍需独立授权。

### 关联

[D3 lifecycle freshness design](notes/adr0040-d3-lifecycle-freshness-design.md)；[D3-PUB completion](notes/2026-07-17-adr0040-d3-pub-production-completion.md)；[post-publication dossier](evidence/2026-07-17-adr0040-d3-pub-production-post-publication-dossier.json)；[transition register](transition-register.md)。

## 2026-07-14 — accepted — ADR 0040 deterministic pull/policy projections and confined publication

### 变更

Knowledge pull与Policy push均从统一 proposition/lifecycle SOT生成独立deterministic projection。Pull保留可检索命题而不派生push authority；Policy candidate只表达`relevance_only_no_injection_verdict`，并按固定九阶段首因全序排除不合格source。Policy publication使用static-plan authorization、verified-FD confinement、exact drift/protected-state validation及五项verdict AND。

### 验收边界

Projection与publication不启用generic proposition writes，不把candidate或published shadow解释为runtime injection authority，也不授权任何consumer read flip。长期契约见 [proposition contracts](notes/adr0040-proposition-contracts.md) 与 [D3 lifecycle freshness design](notes/adr0040-d3-lifecycle-freshness-design.md)；machine evidence由 [transition register](transition-register.md) 指向canonical plan、ratification、intent与post dossier。

### 关联

[Proposition contracts](notes/adr0040-proposition-contracts.md)；[P2a.2 plan/reviews/intent](evidence/adr0040-p2a2-publication-review-dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0/)；[P2a.2 post dossier](evidence/2026-07-14-adr0040-p2a2-production-post-execution-dossier.json)；[transition register](transition-register.md)。

## 2026-07-13 — accepted — ADR 0041 prompt_user 无期限等待

### 变更
`prompt_user` 不再暴露 `timeoutSec` 或任何 deadline 参数；删除默认超时、clamp、timer、倒计时与 `timeout` 终态。用户不回答时工具持续 pending，不把沉默解释为拒绝或允许继续。

### 验收边界
用户提交正常返回；用户取消/Esc 返回 `user-rejected`；turn `ctx.signal` abort 与 `session_shutdown`/显式 drain 返回 `cancelled`。所有终态仍先执行 disposer，擦除 PromptDialog 组件本地 secret/paste buffer 并关闭 editor region；并发 pending ≤ 1 与 compaction defer 不变。聚焦 smoke 必须证明经过观察窗口不会自动 settle，并证明 abort/shutdown 仍清理 pending 和 secret buffer。

### 非目标
不修改 `vault_release` 的授权语义，不放宽 sub-agent/UI/concurrency gate，不改变 secret placeholder/audit 边界，不修改历史 ADR 0022 正文；由 ADR 0041 对其 timeout 小节建立窄 supersede 关系。

### 关联
[ADR 0041](adr/0041-prompt-user-indefinite-wait.md)；[REQ-008](requirements.md#req-008--prompt_user-与-vault_release-语义边界分离adr-0022)；[current-state.md](current-state.md#10-prompt_user)。

## 2026-07-12 — accepted — ADR 0040 unified proposition and authorization contracts

### 变更

ADR0040将durable cognitive content统一为append-only L1 Evidence SOT上的typed proposition，并共享retract/rescope/supersede/archive/reactivate lifecycle。`defined_inactive`允许完整schema声明但保持non-writable/non-foldable；production genesis以binding manifest固定创建时registry/schema provenance，后续event显式绑定epoch/genesis。Canonical facts不包含`injectMode`、always、priority或session-start eligibility。

Production dedicated writer只能重建frozen tuple，并通过trusted transcript ratification、no-replace intent和exact recovery执行；不存在env/force/raw-text bypass。既有rules、constraint evidence与compiled rules不迁移、不自动激活进新policy view。

### 验收边界

ADR acceptance与任一阶段completion都不授权下一阶段、runtime read flip或legacy retirement；每个读取面独立授权。机器状态与证据由transition register维护，不在changelog复制hash和阶段流水。

### 关联

[ADR 0040](adr/0040-unified-proposition-evidence-model.md)；[proposition contracts](notes/adr0040-proposition-contracts.md)；[requirements](requirements.md)；[transition register](transition-register.md)。

## 2026-07-12 — accepted — Canonical-path P1 production 收口

### 变更
Canonical-path R3.4.2 P1 完成 production 收口：新增只读 fresh-process recovery verifier、不可变 report/manifest 与 temp-repo tamper smoke；同一 pending episode 的 claim→prepared→published→converged、exact candidate/cohort、真实 auto-write source、legacy 排除、HEAD/index/whole-L1 与 remote-after-ready 边界均可重建。完成取证后，前向删除一次性 prepared-stop probe 的全部 runtime/scheduler/writer/audit/test/runbook surface，保留 R2 startup content/metadata 修复。

### 残余风险
旧 armed 进程当时未先确认退出，fresh no-probe process 由审查 dispatch 意外启动，因此证据只支持“same pending episode 的真实 fresh-process recovery”，不支持“有序 operator replacement”。device fetch/push 只在 canonical ready 后观察到，继续不作为 canonical gate。

### 授权边界
P1 completion record 引用全部 stable criteria。P2/P3 保持 `blocked/not_authorized`，未启动、未创建授权票；后续仍分别需要新的六供应商或同等独立 multi-T0 unanimous 授权。

### 关联
[P1 completion record](completions/2026-07-12-canonical-path-p1-completion.md)；[runtime restart manifest](evidence/2026-07-12-canonical-path-p1-production-runtime-restart-manifest.json)；[Living Plan](plans/2026-07-10-canonical-path-convergence-r3.4.2-plan.md)。

## 2026-07-09 — accepted — ADR 0020 autosync fetch 领先补推语义补全

### 变更
ADR 0020 autosync 语义补全：`fetchAndFF` 在 fetch 后发现本地领先且远端无新提交时，不再只记录 fetch noop，而是补发后台 `pushAsync`。补推仍经过 ADR 0039 reconcile gate；gate 拒绝时按既有 push 审计面记录，不由 fetch 路径绕过。

### 原因
跨进程或早期异常可能留下本地已提交但未推送的 abrain 状态。启动 fetch 看到 `ahead > 0 && behind === 0` 时，卡在 noop 会让跨设备同步永久等待下一次写入触发 push。

### 需求影响
不新增用户交互面；autosync 仍 silent-by-default。该补推仅在本地领先且远端无新提交时触发，远端有新提交仍走既有 fast-forward/merge/divergence 处理。

### 非目标
不改变 ADR 0039 reconcile gate，不跳过 L1/L2 一致性检查，不在冲突或远端领先场景强推。

### 关联
[ADR 0020](adr/0020-abrain-auto-sync-to-remote.md)；[ADR 0039](adr/0039-constraint-pipeline-reset.md)。

## 2026-07-09 — accepted — 遗忘子系统收敛与 docs 冲突裁定

### 变更
遗忘子系统按 ADR 0031 walk-back 收敛：settings 四个策略链开关改为 `memory.forgetting.enabled` + `memory.forgetting.instrumentation` 两个语义开关，采用 evidence-first + kind prior 的自动 demote 前置条件，审计面改为异常/动作驱动，并新增 archived-vs-active kind 分布监控。同步修复 memory-system-vision 与 direction 的恢复/复活边界冲突，并在 docs README 增加内部冲突裁定规则。该条当时让 sediment 主开关 `autoLlmWriteEnabled` 单独承担 demote 生产授权；此口径已由 2026-07-23 RM-FORGET-001 AND 双门取代：dedicated gate 是独立授权，`autoLlmWriteEnabled===true` 仅作为仍必需但不充分的全局写 authority。

### 原因
经 3 轮 5×T0 一致共识，原四开关是依赖链而非独立安全面，dry-run/live 组合会制造观察与生产配置漂移；条目级自治遗忘的可逆面应限定在工作树内 archived 状态，Git 只承担库级灾备与人工例外通道。

### 需求影响
不新增用户管理面、不要求人类审批记忆、不开放自治物理删除。遗忘总开关关闭时不调度 decay 评估、无遗忘侧写入、无 mutation；复活链路独立于遗忘总开关，继续由 archive-reactivation 所属写入开关管理。

### 非目标
不实施代码改动，不修改 schema/settings，不清理既有 ledger，不把低复活率解释为安全证明。

### 关联
[ADR 0031](adr/0031-autonomous-self-calibrating-forgetting.md)；[memory-system-vision.md](memory-system-vision.md)；[README.md](README.md)；[transition-register.md](transition-register.md)。

## 2026-07-08 — accepted — R5 prompt revision dossier sidecar

### 变更
新增 R5 prompt revision proposal 的 deterministic dossier sidecar：`prompt-revision-proposals.jsonl` 只记录人审 proposal，包含 target prompt、current version、problem pattern、短 evidence excerpts、falsifier、summary、status 与 operator disposition 字段。

### 原因
T0 R2 收敛为先落观测/审计面，不输出 full prompt diff、不自动改 prompt 文件、不 bump promptVersion；真实生成必须由 reinforced classifier prompt evidence gate 触发。

### 需求影响
不新增用户管理面、不弹窗、不新增 slash UI、不自动 apply。当前普通 aggregator 输入不足以可靠生成完整 proposal 时保持 0 proposal；退出条件是后续真实 reinforced pattern 产出一条 proposal 并完成 operator disposition。

### 非目标
不写运行数字镜像，不把 proposal 当 durable writer/curator/archive/multi-view 输入，不新增 settings kill-switch。

---

## 2026-07-08 — accepted — outcome usage 语义分层修复

### 变更
outcome usage 语义拆为三层：exposure（`tool-result` / `path-a-injected`）、self_report（`memory-footnote`）、derived_attribution（同 session/turn/slug 的确定性 join）。新 `path-a-implicit` 不再写 `used:"retrieved-unused"`，只作为 observation-only `path_a_signal:"injected_no_self_report"`；旧 ledger 中已有 implicit-unused 行只进入 legacy 分桶。

### 原因
T0 R2 共识确认：把 Path A 注入但未自报的 silent 状态机械写成 retrieved-unused 会把“未观测到自报告”误当“确定未使用”，并污染 high_unused/demotion 类读侧信号。

### 需求影响
不新增 REQ；这是对既有 INV-INVISIBILITY / 自治第二大脑约束下 outcome 监控口径的语义修正。Runtime 不新增 sidecar LLM、不弹窗、不要求用户管理记忆、不自动改 prompt；R5 sidecar 仍为下一批。

### 非目标
不重写 memory-footnote parser，不改原始 ledger 行，不让 derived_attribution 参与 runtime 读取、排序、demote/archive/confidence 决策；禁止把 `path-a-injected` 与新 `path-a-implicit` 双计为 exposure denominator。

### 关联
[outcome unknown triage](audits/2026-07-08-outcome-unknown-triage.md)；[transition register](transition-register.md)。

---

## 2026-07-08 — accepted — 治理修复批

### 变更
本批按 6×T0 三轮一致裁决与用户 2026-07-08 会话授权执行治理修复：Q1 对 ADR 0039 记忆写入审批式弹窗条款 walk-back；Q4 把自治遗忘反失控参数拆分为 build-time 焊死地板与 Phase 2 自标定状态；Q5/Q6 退役 tool-contract 与 idleLoopGuard 相关文档面；hub dogfood 闭合判定回路，新增判定回填 ledger 与 fail-closed/stale-guard 纪律。

### 原因
治理审计发现 changelog 停摆、ADR0039 弹窗条款与 INV-INVISIBILITY/REQ-001/ADR0024 §4.2 冲突、若干文档把实现流水或易变计数写成长期事实。本批只执行已收敛裁决，不重新设计。

### 需求影响
无新增 REQ；修正的是既有不变量和文档治理纪律的执行方式。hub 仍为 owner dogfood，翻默认开仍需 material 模式累计判定且质量不低于 human-pick。

### 非目标
不改变代码实现真相；代码批次另行落地判定回填与 auto-refresh 有界重试。本条为追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-07-08。

### 关联
[治理修复批 audit](audits/2026-07-08-governance-fix-batch.md)；[ADR 0039](adr/0039-constraint-pipeline-reset.md)；[ADR 0030](adr/0030-l2-hub-baseline-and-evaluation-harness.md)；[ADR 0031](adr/0031-autonomous-self-calibrating-forgetting.md)。

---

## 2026-07-08 — accepted — 共识层定位补注：两层结构、机械护栏边界、operator 边界

### 变更
`vision.md` 明确 pi-astack 分为 substrate 层与 brain 层：通用 pi 运行环境增强不等于第二大脑记忆本体，隐形/自治不变量只约束 brain 层。`direction.md` 同步补入机械护栏 justification 对照表，区分 infra/provider/落盘补偿与认知层机械门；INV-TELL-NOT-ASK 增 operator 边界，说明诊断/迁移类 slash 是维护者逃生口，不得成为正常产品调用面。

### 原因
已 ship 的 web、Context7、vision、imagine、goal/workflow、dispatch 等能力被误套第二大脑隐形自治约束会造成治理混乱；同时既有机械补偿扩展需要给出真实故障、分层判定与退役条件，避免例外无限扩张。

### 需求影响
无新增 REQ；这是对现有 direction/vision 的边界澄清。本条为追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-07-08。

### 非目标
不把维护者命令升级为用户日常 UI，不为认知层机械门开新口子。

### 关联
[vision.md](vision.md)；[direction.md](direction.md)。

---

## 2026-06-21 — accepted — Knowledge 读路径切到 projection_only

### 变更
Knowledge 侧 canonical read mode 切到 `projection_only`：稳态读取来自 L1 Evidence Event 派生的 L2 projection，legacy markdown 保留为回滚、调试、迁移输入，不再进入稳态 winning pool。

### 原因
ADR 0039 的 event-first 证据架构要求 canonical memory 是投影结果，而不是旧 raw-context 写时裁决产物；Knowledge 是第一批迁移到投影读取的高频域。

### 需求影响
不新增 REQ；兑现 INV-GROUND-TRUTH-TIERED 与 REQ-004 在 ADR0039 后的 witnessed Evidence Event 语义。本条为追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-06-21。

### 非目标
不删除 legacy markdown；legacy retirement 仍需独立 gate。

### 关联
[ADR 0039](adr/0039-constraint-pipeline-reset.md)；`docs/notes/2026-06-21-adr0039-p1-flip-executed.md`。

---

## 2026-06-18/19 — accepted — ADR 0039 Constraint Pipeline Reset 扩展为统一证据架构

### 变更
ADR 0039 从 constraint-only reset 扩展为 Unified Evidence Architecture：所有长期记忆域先追加 Evidence Event，再由域自适应 projector/compiler 生成 stable view。REQ-004 的「确定性提交」语义修订为 USER-role durable directive 必须确定性追加 witnessed Evidence Event；存储基座经复审收敛为 HYBRID_MD_GIT_PLUS_DB：L1 Evidence Event SOT + L2 Markdown View + L3 SQLite/embedding/ledger 派生层。

### 原因
rules/constraints 的写时裁决问题不是局部 bug，而是 raw `agent_end` 直接 mutate canonical memory 的结构风险。Knowledge、identity、skills、habits、workflows、project memory、rationale 等面都会遇到同类风险。

### 需求影响
不新增 REQ；修订 REQ-004 的实现语义：确定性首先落在 witnessed Evidence Event，不等于实时写 active rule。queued/stale/projected 状态必须可见，不能静默丢失。本条为追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-06-18/19。

### 非目标
不是全域 event sourcing 数据库；不是让用户维护 Markdown；不是让主会话写 memory。

### 关联
[ADR 0039](adr/0039-constraint-pipeline-reset.md)；`docs/audits/2026-06-18-adr-0039-constraint-pipeline-reset-t0-review.md`；`docs/audits/2026-06-19-adr-0039-unified-evidence-architecture-t0-review.md`。

---

## 2026-06-16 — accepted — ADR 0030 L2 hub baseline 与 2026-07-08 material 判定 walk-back

### 变更
ADR 0030 accepted：caged-live dynamic hub 以默认关闭 flag 进入 owner dogfood，生产 audit 记录 hub assignment、worker disposition 与 summary。2026-07-08 治理批 walk-back 原在线双跑口径：在线 hub 调用没有 human-pick counterfactual，正确性判定改为 material 模式离线生成候选材料，再由跨厂商盲判回填 ledger。

### 原因
H5 gate 要保护的是 assignment correctness 不可凭 hub 自证。advisory shadow 测不了「不一致时谁对」，在线 hub 又缺 human-pick 对照；material 离线判定是当前可复审的最小闭环。

### 需求影响
hub enabled=true 仍只是 owner dogfood，不是默认开 ratify。翻默认开仍需累计足量 material 判定且质量不低于 human-pick。本条为追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-06-16，walk-back 实际发生日期 2026-07-08。

### 非目标
不引入成本闸、不引入 per-run 用户确认、不把 hub 产物作为 L1 ground truth。

### 关联
[ADR 0030](adr/0030-l2-hub-baseline-and-evaluation-harness.md)。

---

## 2026-06-15 — accepted — ADR 0031 自治遗忘与 INV-REVERSIBLE-AUTONOMY

### 变更
ADR 0031 accepted：遗忘策略零人类可调参数，自治遗忘终点固定为 `archived`，不授权自治物理删除；`direction.md` 新增 INV-REVERSIBLE-AUTONOMY，把「自治动作必须有界可逆」升格为方向不变量。

### 原因
第二大脑只进不出会导致近重、陈旧和噪声持续堆积，但安全风险来自不可逆销毁而非自治本身。`archived` 全文留盘 + sparse 可达 + 用户自然纠错是最小可逆基座。

### 需求影响
不新增 REQ；深化 INV-INVISIBILITY / INV-AUTONOMY，并把 roadmap 的 auto-demote 方向升格为结构不变量。本条为追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-06-15。

### 非目标
不做自治 `git rm`，不要求人类设置遗忘速率或审查降级队列。

### 关联
[ADR 0031](adr/0031-autonomous-self-calibrating-forgetting.md)；[direction.md](direction.md)。

---

## 2026-06-14 — accepted — memory_search 检索栈重构：embedding 候选 + 两阶段塌缩 + profile registry（ADR 0035/0036/0037）

### 变更
`memory_search` 的检索行为分三步演进（均已 Accepted、相关 flag 已转产）：
- **ADR 0035**：stage1 候选面从「全库 full-body 海选」改为 embedding 向量召回 + 小候选集，检索成本从 O(库×频率) 降为 O(N)；supersede ADR 0015 的候选面决策，保留其双阶段框架 + result-cache 禁令 + freshness 契约。
- **ADR 0036**：删除 stage1 LLM 环节（两阶段塌缩 `stage0 hybrid → top-K → stage2 精排`），并复活 BM25 sparse + 多向量补 dense 盲区；P6 两阶段塌缩、P3 BM25、P4 多向量、P5a query 路由均已转产，P5b sediment dedup dense-only 已实现并解除 stage1Skip/sparseBM25 临时 pin。
- **ADR 0037**：把分散在 5 个调用方手搓的检索 policy 收口为 typed `SearchProfile` registry + 单入口，消除「per-caller policy 漂移 / 全局 flag 泄漏到去重路径」一类事故；P1-P3 已实现，P5b 策略更新已落。

### 原因
原 stage1 用 full-body LLM 从候选里再选一遍，是在重做 dense 向量已经做得更好的排序，单次约 324K token 且 path-A / sediment 高频调用，是成本主体；策略分散又导致 false-merge corpus corruption 类事故。

### 需求影响
无新增 REQ；守住既有记忆 accuracy/recall 契约——stage0 转产硬门要求 21 query 强 baseline coverage ≥95%（final 实测 98.1%），未达标不转产。检索更快/更省属用户可感知行为变化，故按 `README.md` §5「用户可见行为变化」升级触发器记入本表。

### 非目标
不是代码变更日志；具体参数收敛（poolLimit/maxCand/sparse 权重）、oracle 度量、向量索引格式等为实现细节，归 `roadmap.md`「ADR 0035」段 + abrain + git。P3/P4/P5a/P5b/P6 转产事实从 ADR 头部下沉至本条，属于追溯补签，用户 2026-07-08 会话授权；实际发生日期 2026-06-14。

### 关联
[ADR 0035](adr/0035-memory-stage1-embedding-candidate-retrieval.md) / [ADR 0036](adr/0036-memory-search-two-stage-collapse-and-hybrid-retrieval.md) / [ADR 0037](adr/0037-memory-search-facade-profile-registry.md)；实施 phase 详 `roadmap.md`。这三份机制 ADR 的 slim + ingest 尚待执行（见 `roadmap.md` 残留缺口）。

---

## 2026-06-13 — accepted — ADR 0034 Phase-4 完成：全 19 机制 ADR 迁入 abrain，Phase-2 整体完成

### 变更
ADR 0034 mechanism-ingest lane 落地并跑完生产迁移：**全 19 份机制 ADR 处置完毕**——12 SLIM（0026/0001/0003/0009/0013/0016/0032/0017/0020/0028/0022/0023）+ 5 机制存档归档（0010/0015/0018/0021/0025）经 ingest lane 分解为 **256 条 typed entry** 写入 `~/.abrain/projects/pi-global/`（911→1167），ADR 物理瘦身为方向残桩；2 份 superseded（0006/0019）按变体只标 archived 不 ingest。每条机制的 rationale 现经 `renderRationale` 按需渲染（带 pinned `source_ref` SHA），README §4「按需渲染 rationale」承重墙兑现。

### 原因
ADR 机制正文越长越没人读，且与代码必然漂移；把不可代替的 rationale（如 0018 两次数据丢失先例链、0025 conf<8 盲区）沉到第二大脑，按需检索/渲染，而非埋在 700 行 ADR 里。这让「方向（docs，人类把控）/ 机制（abrain+代码，abrain 决定）」的两库模型在存量 ADR 上真正闭环。

### 需求影响
无新增 REQ；兑现既有 README §4 渲染契约。机制 entry 全部 `provenance=content-in-transcript`（Tier-2，永不冒充 Tier-1 用户指令）；触碰方向承重墙的两处 escalation 已浮现而非静默接受（0025 narrows INV-ACTIVE-CORRECTION / conflicts INV-MAIN-SESSION-READ-ONLY+REQ-005）。

### 非目标
不是代码变更日志。全程零主会话直编 abrain markdown——写入只经 ingest lane（守 G2 + ADR 0034 §4 四不变量）。staleness re-sync 归后续 ADR。

### 关联
迁移轨迹（可复现）：`scripts/run-adr-ingest.mjs` + `scripts/verify-rationale.mjs` + `notes/adr0034-ingest/*.json`（17 份分解记录）；分批 abrain commit 链可回滚；原机制 prose 基线统一记录在 `docs/notes/adr0034-impl-plan.md`（含 git 恢复命令）；living plan 见 `docs/notes/adr0034-impl-plan.md`。能力实现见 `extensions/memory/{direction-impact,ingest-adr,rationale,adr-decomposer}.ts`（123 smoke assertions）。

---

## 2026-06-13 — accepted — ADR 0034 Phase 1-3 实现：direction_impact + ingest lane + rationale 渲染（能力全绿）

### 变更
ADR 0034 三块能力的代码实现落地（均为主会话可执行的代码，未写真实 ~/.abrain）：
- **Phase 1 direction_impact schema**：`extensions/memory/direction-impact.ts`（flat frontmatter pipe 编码）+ parser 填 `MemoryEntry.directionImpact`（可查）+ 读侧 lint `D1` + 写侧 validation；narrows/weakens/conflicts→escalation≠none 红线。
- **Phase 2 source-aware ingest lane**：`extensions/memory/ingest-adr.ts`（planIngest 纯函数 + dry-run/go + provenance=content-in-transcript + source_ref 存 path#heading@SHA + git reset --hard 回滚 + sanitizer 边界 + 审计；decomposer 注入可测）。
- **Phase 3 rationale 渲染**：`extensions/memory/rationale.ts`（只格式化存储数据，missing-not-hallucinated 硬约束，带 pinned SHA）。

### 原因
Phase 0 ratify 后按 impl-plan 分阶段推进；三能力是 Phase-2 物理瘦身 + 承重墙渲染的前置。

### 需求影响
acceptance ①-⑧ + ⑩ 由代码 + smoke 覆盖：smoke:direction-impact 32 + smoke:adr-ingest 40 + smoke:rationale 29 = 101 assertions（均双向 negative），smoke:memory 回归绿。全程守 ADR 0034 §4 四不变量 + G2（主会话只写代码，sandbox/dry-run，不动真实 abrain）。

### 非目标 / 剩余
Phase 4（需用户 go/no-go，G2）：CLI `/memory ingest-adr` 命令 + 生产 LLM decomposer prompt 接线 + 对真实 12 SLIM/7 ARCHIVE ADR 的 production ingest + 验证 rationale 可得后物理瘦身（acceptance ⑨）。

> **收口**：上述 Phase 4 已完成 production ingest（全 19 机制 ADR / 256 条 entry，已记为 accepted）——见本文件「ADR 0034 Phase-4 完成」条目；本条「未写真实 ~/.abrain」仅描述 Phase 1-3 阶段（纯代码 / sandbox），不再是当前状态。

---

## 2026-06-13 — accepted — ADR 0034 ratify：abrain mechanism-ingest keystone 进入实现阶段

### 变更
ADR 0034（Phase-2 keystone：abrain mechanism-ingest lane + direction_impact 注解 + rationale 渲染）经 3×T0 跨厂商盲审（opus-4-8 / gpt-5.5 / deepseek-v4-pro）**一致 RATIFY WITH REVISIONS**，Proposed → **Accepted**，9 处修订已并入。同时立实现 goal（`docs/notes/adr0034-impl-plan.md`）分 4 阶段推进。

### 原因
ADR 0034 是 Phase-2 “物理瘦身/归档 + 承重墙渲染”的唯一阻塞能力。本项目协议：未 ratify 的 ADR 不进实现；故先 T0 评审收敛再编码。

### 需求影响（收敛的修订集）
(1) §3 时序拆“保 SHA + 收方向残桩可先于 ingest” vs“物理删 in-place prose 必须在 ingest + 渲染验证之后”，acceptance ⑨ 加三步验证；(2) direction_impact 首落 = **flat frontmatter**（非嵌套/非 body-only，因 parser 跳缩进行 + 违反可查）；(3) provenance 用 AX-PROVENANCE 枚举 assistant-observed/content-in-transcript（机械确保非 Tier-1），migrated-from-mechanism-docs 降为 timeline marker；(4) 依赖收窄：ADR 0025=accepted，仅复用 sanitizer+writer 基建不依赖稳态 curator 管线；(5) dry-run manifest 加 coverage/stats；(6) git reset --hard pre-SHA 回滚；(7) ingest 禁写 rules zone / inject_mode；(8) 渲染带出 pinned SHA 使源漂移可检；(9) staleness re-sync 归后续 ADR。

### 非目标
schema 字段最终形态 / lane pipeline / 渲染 prompt 措辞为实现细节（代码 + abrain），不写进 ADR。主会话只写代码，真实写入 ~/.abrain 是 Phase 4 经 sediment lane 单独 go/no-go。

---

## 2026-06-13 — accepted — roadmap.md strip：roadmap 回归 backlog 本职（STRICT-green 收尾）

### 变更
`roadmap.md` 删掉所有 ship-status（“同步” 变更块 + 整个 ADR 0022 housekeeping batch 章 + 3 行 ADR-0022 ship-status debt，203→92 行），只留真 backlog（P0/P1 / 架构 debt / 不变量守护 / pending flips / deferred / maxim）。

### 原因
REQ-006 + 文档治理：roadmap 只装未完成/计划；ship-status 属 current-state/feature-changelog/audits/git。原 roadmap 80% 是带 commit hash 的 ship-status，违反 REQ-006。

### 需求影响
`STRICT=1 npm run docs:doctor` 达成 **GREEN（零 ERROR）**——Phase-2 doc 侧收尾。残余 advisory 均为 ADR pending-ingest 机制正文的 commit 证据（待 ADR 0034 ingest 后清）。

### 非目标
ADR 0022 的实施流水/audit 轨迹不是删除，是移出 roadmap；原文保留在 git history / `docs/audits/`。

---

## 2026-06-13 — proposed — spun-out keystone：ADR 0034 abrain mechanism-ingest + rationale 渲染

### 变更
新增 [ADR 0034](adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md)（Proposed）：定义 sediment 侧三能力——source-aware ingest lane（把 ADR 机制分解为 typed entry 入 abrain）、`direction_impact` 结构注解（触碰 INV/REQ → 升级，不静默）、rationale 渲染（缺失必报缺失不幻觉）。

### 原因
Phase-2 把 23 份 ADR 方向上提、机制 mark-in-place，但主会话不能写 abrain（ADR 0003）；机制物理迁入 abrain + `README.md` §4 按需渲染 rationale 承重墙都 block 在这个能力上。它是 Phase-2 的 keystone。

### 需求影响
Phase-2 “整体完成”不早于 0034 落地 + 渲染验证；在此前承重墙靠 ADR 机制 in-place 可读兜底。

### 非目标
未实现；不含 memory schema 字段/sediment pipeline/渲染 prompt 的具体实现（→ 代码 + abrain）。

### 关联
handoff 契约源于跨厂商 T0（Kimi 主笔），记于 `docs/notes/phase2-adr-split-plan.md` §3。

---

## 2026-06-13 — accepted — Phase 2 抽取：方向不变量/需求上升为共识层一等公民

### 变更
从 ADR 机制正文中抽出方向承载条目，上升为 `direction.md`/`requirements.md` 一等公民（加法，未删任何 ADR）：
- `direction.md` 新增 5 条不变量：INV-DUAL-INVARIANT / INV-USER-NOT-WORKER（ADR 0027 C1'/C4'）、INV-TELL-NOT-ASK / INV-COST-NOT-A-GATE / INV-GIT-IS-RECOVERY（ADR 0033）；AI-Native 补认知/infra 分层边界（C3'）；走偏信号 +#8（能力面确认弹窗复活）。
- `requirements.md` 新增 REQ-007（项目身份绑定严格，ADR 0017）、REQ-008（prompt_user/vault_release 语义边界分离，ADR 0022）。
- 第二批：`direction.md` +INV-SYNC-DETERMINISTIC-MERGE（同步只走确定性合并，0020）、INV-GROUND-TRUTH-TIERED 增 provenance 门控（0028 R2'）；`requirements.md` +REQ-009（记忆 accuracy-contract，0015）、REQ-004 增召回审计/非对称阈值（0028 R3'）；0013 trust×blast 确认已在 direction §1（信任×影响半径）不重复。

### 原因
这些是跨实现不变的方向/契约（承重墙），之前埋在 ADR 机制正文里，人类不易随时比对/否决。Phase 2 把它们提到单一可读面。

### 历史方向事件（补记）
ADR 0026 §3.1 walk-back：第二大脑参与从"决策点/执行二分"改为"检索参与"（默认 Path A walk-back）——这是一次方向修正，机制归 abrain/代码。

### 非目标
不是代码变更日志；ABR 机制正文本轮未动（待后续 slim/archive）。

### 关联
决策点 #1（4×T0 收敛）见 `docs/notes/phase2-adr-split-plan.md`；下一批抽取：0028/0020/0013/0015。

---

## 2026-06-13 — accepted — 文档体系重构为"人类↔abrain 共识基础"两库模型

### 变更
项目文档（docs/）重定义为**人类与 abrain 的共识基础**，只装：愿景 / 目标 / 需求 / 方向（不变量+取舍+走偏信号）/ 功能变更。**技术大方向由人类把控（→ docs）；技术细节与实现由 abrain 决定（→ abrain + 代码）。** 引入 `REQ-001..006`（见 `requirements.md`）。

### 原因
abrain 内部人类可读性极差；凡需人类共识/审计/否决的东西不能只活在 abrain。用 prose 文档镜像代码事实会必然漂移（已观测 README/current-state/实际 三处扩展计数不一致）。

### 需求影响
新增 `REQ-001..006`；agent 任务开始须读 `vision`/`direction`/`requirements` 为不可违反方向，再查 abrain 技术知识，再读代码为当前真相（见 `README.md` §5）。

### 非目标
本条不是代码变更日志；不列 commit、改了哪些文件、重构步骤。

### 关联
经 3 轮跨厂商 T0 讨论收敛（证据见 git history / 后续 `docs/audits/`）；落地骨架见 `README.md`、`direction.md`。Phase 2（ADR 劈分 / current-state 收敛 / abrain 能力）见 `roadmap.md`。
