---
doc_type: adr
status: accepted
date: 2026-07-24
---

# ADR 0044 — Central Sediment Edge Authority（T0 R4）

- **Status**: Accepted（2026-07-24，用户批准第二大脑 central sediment 的 T0 R4 一致方案）。
- **Date**: 2026-07-24。
- **Relates-to**: [ADR 0003](./0003-main-session-read-only.md), [ADR 0020](./0020-abrain-auto-sync-to-remote.md), [ADR 0024](./0024-second-brain-from-natural-conversation.md), [ADR 0027](./0027-coupled-stigmergic-dual-loop-agent-system.md) C6, [ADR 0039](./0039-constraint-pipeline-reset.md), [ADR 0040](./0040-unified-proposition-evidence-model.md), [ADR 0045](./0045-sediment-worker-safe-rpc-command.md)（Stage A daemon worker **机制**，叠在本目标 contract 之上，不是并列 primary）。
- **Implementation authority**: 中心与 edge lifecycle 的**实施规格与代码**由 pi-router 仓库负责；详案完整路径：`/home/worker/work/components/pi-router/docs/architecture/central-memory-sediment.md`。本 ADR 只固定 Pi / pi-astack 侧不变量与职责边界，**不**复写中心数据库完整设计。
- **Implementation status**: **capture-only protocol shadow implemented（Pi 侧第一兼容切片，默认关）**。`sediment.edgeProtocolShadow.enabled` 默认关闭；启用后：`session_start` 幂等 durable layout 初始化（不算 end gate）；`agent_end` 写 durable raw sidecar + candidate（与 local intake 独立并发；默认 off 在 settings gate 后同步 no-op、零 edge 产物、无 cwd/owner/git/edge filesystem I/O——settings gate 仍读取配置，不宣称绝对 zero cost）；`agent_settled` 写 TerminalWitness（`settlement_status=unsupported_core_capability`）；**不**切 authority、**不** seal、**不** open link。完整 Stage A/B/C 仍未实施；现有本地 sediment intake/queue/publication 仍是唯一 `local_primary`。Pi core 仍缺 SessionManager mutation transaction/fsync 与 launch broker；pi-router 中心路径未接。Pi-side slice production acceptance 方法为 **v3 真实 session 多 turn**（边界=**terminal assistant**：`role=assistant && stopReason !== 'toolUse'`）；主会话 `dossier:edge-protocol-shadow-production` 实跑已归档并通过，见 [edge protocol shadow production acceptance v3](../evidence/2026-07-24-edge-protocol-shadow-production-acceptance.json)（`result=accepted`；每轮100 terminal turns，分布于32 sessions，共3轮/300 samples；integrity 4200/4200；aggregate `agent_end` p99=57.708ms / witness p99=18.624ms，均 &lt;100ms；implementation_source_digest sha256 `7949c2e4b40b42ddde2f5d8561ce729c21a999a02e1cbddd31186c88503bd870`）。**默认仍 off、capture-only**；Stage A/B/C 未完成；local intake 仍是唯一 primary；**不**宣称 cutover / 中心路径启用。详情只认该 evidence，勿在本 ADR 复制全表。

## 1. 背景与生产问题

当前第二大脑写入权威仍在每台设备：`agent_end` 虽已尽量把语义工作 detached，但 durable intake、本地 queue、extractor/curator、L1/L2 publication 与 Git 收敛仍发生在 edge。多 Pi 实例、多 checkout、跨设备 OFD/CAS/join 与积压恢复把“一个 turn 的后台沉淀”变成多 writer、多锁、多物理副本问题。

已观察到的硬边界：

1. **交互路径不能等语义闭环**。Pi 会 await `agent_end` / `agent_settled`；任何 LLM、Git、network、recovery、drain 进入 awaited handler 都会把用户交互拖成秒到分钟级。
2. **`agent_end` 不是 turn final**。auto-retry、compaction、queued continuation、dispatch link 都可能在 low-level end 后继续。把 candidate 当 settled 会沉淀错误 branch / leaf。
3. **本地 Git 在线协调不适合中心权威**。device join、push rejection、双设备同时写与 OFD/CAS 版本差，使单一观测与修复面缺失。
4. **C6 causal identity 与执行代际必须分离**。C6 = `(session_id, turn_id, subturn, sub_agent_label, parent)` 是跨 L1/L2 因果/问责锚点，跨层不得漂移。若把 seal / late launch / restart / fence 的执行代际写成新 `turn_id`/`subturn`，或用 `run_generation` 冒充它们，审计与 memory join 会静默串线。

曾考虑的“中心直接 join capture + terminal / 永久双写 / 把 memory 塞进 router session history”不够：

- 没有 **session 级 durable sequencer** 时，capture、rewrite、link、seal、GC 会各自发明顺序；
- 没有 **capture 先 fsync session JSONL 再 pin journal** 时，pin-only 会假成功；
- 没有 **candidate ≠ settled** 与 **唯一 launch broker** 时，中心或 edge 会把未关闭 link 的 run 当终态；
- 没有 **authority_generation + 单 primary** 时，shadow 会滑向双主；
- 把 memory 塞进 `session_events.payload_json` 或复用 dispatch 状态机会混显示历史与 memory lease/privacy/retention。

## 2. 决策摘要

把长期记忆的 **接收 / 排队 / 裁决 / 发布** 权威迁到中心 memory service；Pi 与 edge 只保证 **source 不丢、本地交互不阻塞、C6 不漂移**。

| 层 | 唯一职责 |
|---|---|
| Pi / pi-astack | 本地 durable capture / witness；session journal 合同；C6 与 `run_generation` 分离；unsupported 可观测降级 |
| pi-router daemon | edge lifecycle boundary：可靠传输、source redrive、Stage A headless worker 桥、fencing |
| 中心 `pi_memory_*` | source/job/immutable evidence、lease/DLQ、fenced publish、authority mode、query |
| Git / Markdown | 仅异步导出 / 审计 / 灾备；**不是**在线 authority |

**禁止永久双主**。每个 `(tenant × owner × scope × domain)` 只能处于 `local_primary` / `central_shadow` / `central_primary` / `rollback_draining` 之一，并带 `authority_generation` 与 watermark。

## 3. Pi 侧非阻塞产品不变量

1. **`agent_end` / `agent_settled` 只做本地 durable capture / witness**，目标 p99 `< 100ms`（正常生产 payload 分布）。**不得**等待 LLM、Git、network、recovery、drain、中心 ACK 或 semantic worker。
2. **启动只读严格有效的本地 bundle / journal 投影**。无效、半写、epoch 不匹配状态不得被解释为 ready memory authority。
3. **中心故障不阻塞 Pi**。用户交互继续；memory 只延迟。cutover 后本地不得擅自恢复 canonical mutation 冒充中心。
4. **主会话仍不直接写长期记忆**（ADR 0003）。canonical decision 不回到 LLM-facing write tool。
5. **observable-disable 只禁新 capture / 新 semantic 写**；既有读取继续；写一次低基数 durable audit + 一次诊断；恢复后自动探测；关闭期间 **零 pending** 新 source。

## 4. Per-session durable journal / sequencer

每个 Pi session 有且仅有一个 **append-only durable journal / sequencer**：

- 单调 `producer_seq`；
- `session_writer_epoch` + 单 writer 锁；
  - **capture-only protocol shadow（本仓库已实现）**：`session_writer_epoch` = 每个 Node 进程唯一且稳定的 journal writer identity（string），写在每条 record 上；**不是** SessionManager epoch，**不**充当 launch fence。`producer_seq` 唯一真值是 journal record 文件名（OFD 锁下扫 max+1 再 durable create；崩溃后仅凭文件名恢复）；**无** writer-state 第二 head。candidate `run_generation` = 其 `producer_seq`（protocol-shadow 临时执行代际；未来 core broker 可提供正式 generation；非 core fence）。
  - 完整 Stage A 的 SessionManager writer epoch / transaction / launch fence 仍未实施。
- SessionManager 的 append / rewrite / migrate / truncate / delete / GC，以及 candidate / link / witness / seal，**必须**走同一事务 API；
- `retention_watermark = min(required consumer durable ACK)`；**禁止**用 TTL 在 sequence 上打洞；
- 消费者只有在其 authority generation 正式退役后才可从 required set 移除。

该 journal 是 edge 顺序与崩溃恢复的物理基础，不是 semantic memory store。

## 5. Capture durability

Capture 顺序硬约束：

1. 先 **flush + fsync session JSONL 及其父目录**；
2. 记录 file identity / size / tail digest / frozen tip；
3. 再写 candidate 并 **pin journal fsync**。

若 runtime 无法提供上述 durability：

- 走 **durable raw sidecar**，或
- **observable-disable**（见 §3 第 5 条）；

**禁止 pin-only 假成功**（journal 说 pin 了但 session bytes 未 durable）。

## 6. Candidate / witness / link / seal 契约

### 6.1 Candidate ≠ settled

- `agent_end` 产生 **candidate capture**（immutable source 坐标 + digest + tip）。
- `agent_settled` 写 **TerminalWitness**，不是 canonical memory decision。
- 唯一 **launch broker** 必须先 **durable-open** continuation / source link，再允许后续 run 占用执行资源。

### 6.2 Link

每个 open link 至少携带：

- `owner_session_epoch`
- `executor_epoch`
- `launch_token`
- `lease_until`

旧 child 必须被 fence；不得在新 token / 新 epoch 下继续写同一 source 身份。

### 6.3 Seal

Seal 仅当同时满足：

1. source 已 terminal（含 `ready` 收口或 `source_dead`）；
2. 全部 links closed；
3. witness / terminal 条件满足；
4. journal watermark 连续（无跨 required consumer 的洞）。

last-close 触发 seal；pending materialize 必须可在崩溃后按 journal 恢复。

### 6.4 C6 与 `run_generation` 分离

- **C6 causal identity** = `(session_id, turn_id, subturn, sub_agent_label, parent)`：跨 L1/L2 因果语义与问责锚点；**跨层不漂移**。
- **`run_generation`** = 同一因果工作在 seal / late launch / restart / fence 上的**执行代际**，用于 fence 旧 child / 旧 publisher / 旧 materialize。
- `run_generation` **绝不能**复用字段、改写或冒充 `turn_id`/`subturn`。
- seal 后 late/new launch **必须**新 `run_generation`；是否产生新 `turn_id`/`subturn` **只由真实因果事件决定**，不得由执行重试/重启决定。
- 审计与 memory join 必须以 C6 问责、以 `run_generation` 隔离执行代际；二者不得混用。

### 6.5 Pair admission identity（capture-only protocol shadow）

- **Durable pair admission key** = `(session_id, terminal leaf message id)`，leaf id 从真实 SessionManager / terminal descriptor（`leaf_tip.id`）读取；**不是** C6。
- C6 **完整保留**在 candidate / witness 上作 attribution / 审计，**不作**唯一 admission。
- 不同 leaf 即使 C6 相同 → 写独立 candidate+witness，并记录 `c6_collision` diagnostic（不 fail closed）。
- 同 leaf 同 content digest → 幂等 reuse。
- 同 leaf 不同 content digest → fail closed `terminal_identity_content_conflict`（不 append）。
- Immutable journal：不得改写旧 records；scan/index 可从 candidate `leaf_tip` 或 content digest 推导 legacy leaf identity（`legacy_content:<digest>`）；新 capture 同时查真实 leaf key 与 legacy key，**仅**在相同 C6 + 相同 digest 时 reuse，避免重复 pair。
- `writeEdgeTerminalWitness`：调用者提供 leaf identity 时必须 exact leaf+C6 candidate；未命中 → fail closed `leaf_not_found`（**禁止**回退 C6 latest）；无 leaf 且同 C6 恰 1 个 candidate 才允许，多于 1 → `ambiguous_candidate`；`agent_settled` 传真实 leaf id。
- Source-only 不可见：每次 pair capture 写 durable **capture audit**（session/digest/C6/leaf/result；含 conflict）。journal 未引用 sources 仅由 **operator** `recover-edge-unreferenced-sources` 恢复：
  - 默认 dry-run 零写；`--execute` 才写 candidate+witness
  - **绝不合成 C6/leaf**。**权威身份** = 唯一 capture-audit 对 `(session,digest)` 的 `leaf_tip`+C6（保留原 number/string/subturn/subagent/parent）。**生产 source messages 不保证有 entry id**（实测常无 `id`/`messageId`）；source 末端 terminal assistant 字段**仅作一致性检查**（有 id 则必须与 audit leaf match，否则 `source_audit_leaf_mismatch`），**不是**与 audit 并列的双独立证据。缺 id 时用 audit leaf，不猜。
  - execute 强制：`--owner-project-root` realpath、`--session-id` 或 `--all-sessions`、正整数 `--limit`（≤100，只计 eligible）、`--capture-audit-path`、`--operator-audit-path`
  - 无法唯一匹配 → `nonrecoverable`（崩溃 source-only 无 audit 保持 source-only，不能猜）
  - 旧 `c6_content_conflict`（不同真实 leaf）可 recover；`terminal_identity_content_conflict` **永不** recover（`rejected`）
  - 同 writer lock + monotonic `producer_seq`；只写 candidate+witness，不创建 semantic job/ACK、不改 source bytes；**不**在 `session_start` 自动回放
  - source 读：lstat / `O_NOFOLLOW` / ≤8MiB，symlink fail-closed；capture/operator audit append：lstat/realpath parent + `O_NOFOLLOW|O_APPEND` + regular file + bounded line，symlink fail-closed；capture-audit 读上限 32MiB（`capture_audit_too_large`，本轮无 rotation）；session root 必须属于 edge owner layout；stdout/operator audit 不输出原始 session/path/digest/leaf 全值（hash/record id prefix）；execute operator audit 只记 eligible action + summary（不含 already_referenced 噪声）；summary 含 `limit_reached`/`truncated`/`remaining_unknown`，limit 命中不伪装全量结论

## 7. Source 状态与 edge redrive

Source 状态机最小集合：`pending | ready | dead`。

- daemon 在 startup 与周期 reconciler 中做**有界**重驱；
- candidate source closure **可提前上传并单独 durable**；source receipt ACK **仅**表示 source 已持久，**绝不**创建 semantic job；
- `dead` → terminal `source_dead`，**不**创建 memory job；
- **job admission 只发生在**可验证 TurnSettled（edge `terminal_seal`：source ready、witness 匹配、links closed、连续 sealed producer watermark）的中心 `AcceptTurnSettled` 事务；完整事务边界见 pi-router 详案；
- **任何 ACK 永不表示 sediment 完成**。

## 8. Unsupported runtime 降级

下列情况不得静默“差不多可用”：

| 条件 | 要求 |
|---|---|
| 无法 fsync session JSONL / journal pin | durable raw sidecar 或 observable-disable |
| local model 不能保证 `local_only` / no egress / no vault plaintext | deterministic projector + terminal `unsupported`；**禁止**外泄 |
| no-egress raw / local-redacted | 仅作 capture/outbox payload；本地 durable closure 后按 retention 回收；canonical memory 仍走 tombstone |
| 功能关闭 | 只禁新 capture/semantic 写；读继续；零 pending |

## 9. Pi 与 pi-router 职责 / 实施归属

| 归属 | 内容 |
|---|---|
| **本仓库（pi-astack）** | 记录产品不变量、C6/`run_generation`、capture/journal/link/seal 合同、降级语义；已落地 **capture-only protocol shadow**（`extensions/sediment/edge-protocol-shadow.ts`，默认关）。后续完整 Stage A 仍依赖 Pi core transaction/broker 与 pi-router |
| **pi-router 仓库** | 完整实施规格、proto/schema、daemon Stage A bridge、中心 `pi_memory_*` service、Stage B/C authority、生产验收与代码 |
| **详案路径** | `/home/worker/work/components/pi-router/docs/architecture/central-memory-sediment.md` |
| **实施执行方** | 在 `/home/worker/work/components/pi-router` 启动且绑定该仓库的 Pi 实例；**本文不代替实施，不把任务写成已完成** |

迁移阶段（由 pi-router 详案展开，此处只锁边界）：

- **Stage A**：现有 Rust daemon 作为 edge lifecycle boundary，spawn headless TS sediment worker 作迁移桥，复用现有 pipeline；Pi 内 queue/recovery/replay/timer 关闭；parity + `local_executor_epoch` fence 后切换；kill-switch **不并发**双执行器。
- **Stage B**：central shadow（不发布产品权威）。
- **Stage C**：逐 scope authority 切换。初始中心最小集合：source / job / immutable content-addressed event；其余推迟。

## 10. 验收原则（Pi 视角）

验收必须用**真实生产数据**，synthetic 只能补 race/异常码，不能当唯一证据。与 Pi 直接相关的门槛包括：

- 当前积压可回放；
- Pi 重启 / 掉电后 journal 与 capture 不丢、不假 ready；
- capture / rewrite 竞态不产生 pin-only；
- source / link / seal 崩溃窗口可恢复；
- GC 水位不产生 sequence 洞；
- C6 跨层不漂移；seal/late launch/restart 使用新 `run_generation`，且不得用其改写/冒充 `turn_id`/`subturn`；
- no-egress replay 不外泄；
- disabled 期间零 pending；
- single writer / fencing 成立；
- 中心故障不阻塞 Pi 交互。

完整中心侧矩阵见 pi-router 详案。

## 11. 非目标

- 不在本 ADR 规定中心完整 DDL / proto 字段清单。
- 不把 memory 塞进 router `session_events` 或 dispatch 状态机。
- 不恢复 gbrain / 本地 postgres 作为 canonical memory。
- 不授权主会话 LLM write tool。
- 不把 personal/partial sharing 产品策略未决项阻塞 schema 最小字段（默认 private；共享创建 derived team event）。
- 不在文档落盘时宣称 Stage A/B/C 已完成。

## 12. 后果

- Pi 本地 sediment 从“完整 semantic + Git writer”收缩为 **durable capture / witness 面**（迁移期经 daemon bridge 执行旧 pipeline）。
- 跨设备最终一致与决策权威上移到中心；本地 Git 退为导出/灾备。
- C6 继续服务因果问责且跨层不漂移；执行代际由 `run_generation` 承担，避免把 seal/重试/重启误写成新 turn。
- 实施与验收债务集中在 pi-router；pi-astack 若提前改 capture 路径，必须保持本 ADR 不变量，并与 pi-router 详案对齐。
