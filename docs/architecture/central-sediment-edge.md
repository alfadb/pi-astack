---
doc_type: architecture
status: active
---

# Central Sediment Edge Contract — Pi 侧边界

> **决策权威**：[ADR 0044](../adr/0044-central-sediment-edge-authority.md)  
> **实施规格（完整目标架构）**：`/home/worker/work/components/pi-router/docs/architecture/central-memory-sediment.md`  
> **状态**：目标边界已批准；**capture-only protocol shadow implemented（默认关）**。完整 Stage A/B/C 未实施。当前生产权威行为仍以 [sediment.md](./sediment.md) 本地 intake/queue 为准。Pi-side slice production acceptance **v3 已归档并通过**：[edge protocol shadow production acceptance v3](../evidence/2026-07-24-edge-protocol-shadow-production-acceptance.json)（每轮100 terminal turns，分布于32 sessions，共3轮/300 samples；integrity 4200/4200；aggregate end p99=57.708ms / witness p99=18.624ms；implementation_source_digest sha256 `7949c2e4b40b42ddde2f5d8561ce729c21a999a02e1cbddd31186c88503bd870`）。**默认仍 off、capture-only**；Stage A/B/C 未完成；local intake 唯一 primary；**不**宣称 cutover / 中心路径启用。

本文只保存 Pi / pi-astack 必须遵守的 edge 合同，**不**复制中心数据库、queue 或 query 完整设计。

## 1. 为什么要改

本地 sediment 已能 durable intake 并 detached 语义工作，但仍把接收权威、执行器、publication 与 Git 协调放在设备上。多实例 / 多设备下难以单点观测与修复；把 `agent_end` 当 final 或把 memory 塞进 router 显示历史都会丢 branch identity 与隐私/lease 语义。

T0 R4 选择：edge **只保证 source 不丢且交互不阻塞**；中心成为 source/job/decision 权威。

## 2. 非阻塞不变量

| 不变量 | 含义 |
|---|---|
| Awaited 路径 p99 `<100ms` 目标（正常生产分布） | `agent_end` / `agent_settled` 只做本地 durable capture / TerminalWitness；不等 LLM / Git / network / recovery / drain / 中心 |
| Startup 严格 | 只读严格有效本地 journal/bundle；半写不得 ready |
| 中心可消失 | 中心故障只延迟 memory，不阻塞用户交互 |
| 主会话只读 | 不新增 LLM-facing memory write |
| Disable 语义 | observable-disable 只禁新 capture/semantic 写；读继续；零 pending；低基数 audit + 一次诊断；恢复自动探测 |

## 3. Session journal / sequencer

每 session 单一 append-only journal：

- `producer_seq` + `session_writer_epoch` + 单 writer 锁；
  - **capture-only protocol shadow（本仓库已实现）**：`session_writer_epoch` 是**每个 Node 进程唯一且稳定**的 journal writer identity（string；启动时间+pid+UUID），写入每条 record；**不是** SessionManager epoch，**不**提供 launch fence。`producer_seq` 唯一真值是 journal record 文件名（持 OFD 锁后扫 records 目录 `max+1`，再 durable create）；崩溃后仅凭文件名恢复，**无** writer-state / 第二 head。candidate 的 `run_generation` = 其 `producer_seq`（protocol-shadow 临时执行代际；未来 core broker 可提供正式 generation；**不**声称 core fence）。
  - 完整 Stage A journal 的 SessionManager writer epoch / launch fence 语义仍属未实施合同。
- SessionManager append/rewrite/migrate/truncate/delete/GC 与 candidate/link/witness/seal 同一事务 API；
- `retention_watermark = min(required consumer durable ACK)`；禁 TTL sequence 洞；
- 消费者经 authority generation 正式退役后才移除。

## 4. Capture durability

1. flush + fsync session JSONL 与父目录；
2. 记录 file identity / size / tail digest / frozen tip；
3. candidate + pin journal fsync。

不支持则 durable raw sidecar 或 observable-disable；**禁止 pin-only 假成功**。

## 5. Candidate / link / witness / seal

```text
agent_end        → Candidate capture (not settled)
launch broker    → durable-open continuation/source link
agent_settled    → TerminalWitness
links close      → last-close may seal
seal             → source terminal + links closed + witness match + continuous sealed producer watermark
                   → TurnSettled envelope (job admission input to center)
post-seal late/new launch → new run_generation (execution generation only)
```

Link 字段最小集：`owner_session_epoch` / `executor_epoch` / `launch_token` / `lease_until`；旧 child fence；崩溃后按 journal materialize。

**C6 causal identity** = `(session_id, turn_id, subturn, sub_agent_label, parent)`：因果语义与问责；跨层不漂移。`turn_id`/`subturn` 只由真实因果事件推进。  
**`run_generation`** = 同一因果工作在 seal / late launch / restart / fence 上的执行代际。**绝不能**复用字段、改写或冒充 `turn_id`/`subturn`。二者分离，禁止混用。

**Pair admission（capture-only protocol shadow）**：durable key = `(session_id, terminal leaf message id)`（真实 `leaf_tip.id`）。C6 完整保留 attribution 但不作唯一 admission。不同 leaf 同 C6 → 独立 pair + `c6_collision` diagnostic；同 leaf 同 digest 幂等；同 leaf 不同 digest → `terminal_identity_content_conflict`。旧 journal 不可改写；index 可从 `leaf_tip`/content 推导 legacy leaf；新 capture 同时查真实 leaf 与 `legacy_content:digest`，仅同 C6+digest reuse。Witness：有 leaf → exact leaf candidate（miss → `leaf_not_found`，禁止 C6 latest fallback）；无 leaf 且同 C6 恰 1 candidate 才允许，多于 1 → `ambiguous_candidate`。未引用 source 仅 operator `recover-edge-unreferenced-sources`：身份权威 = 唯一 capture-audit `leaf_tip`+C6（**生产 source 不保证 entry id**；source terminal 字段有则必须 match，仅一致性检查）；execute 强制 owner realpath / session scope / limit≤100 / capture-audit / operator-audit；`terminal_identity_content_conflict` 永不 recover；无 audit 保持 source-only；summary 标明 `limit_reached`/`truncated`/`remaining_unknown`。

## 6. Source 与降级

- source：`pending | ready | dead`；candidate source 可提前上传并单独 durable；**source receipt ACK ≠ job**；dead → `source_dead` / 无 job。
- job admission：仅中心 `AcceptTurnSettled`（TurnSettled envelope）；详见 pi-router 详案，本文不复制完整中心事务。
- unsupported fsync：sidecar 或 disable。
- local model：必须 local_only / no egress / no vault plaintext；否则 deterministic projector + terminal unsupported。
- no-egress raw/local-redacted：仅 capture/outbox payload；本地 closure 后按 retention 回收；canonical 仍 tombstone。
- **任何 ACK 永不表示 sediment 完成**。

## 7. 职责切分

| 组件 | 做 | 不做 |
|---|---|---|
| Pi / pi-astack | capture/witness、journal 合同、C6/`run_generation`、降级可观测性 | 中心 decision、中心 job lease、在线 Git 双写权威 |
| pi-router daemon | edge lifecycle、可靠传输、有界 redrive、Stage A headless TS worker 桥与 fence | 把 memory 塞进 `session_events` / dispatch |
| 中心 `pi_memory_*` | source/job/evidence publish、authority、query | 阻塞 Pi 交互路径 |
| Git | 异步导出/审计 | 在线 merge authority |

**实施**：由绑定 `/home/worker/work/components/pi-router` 的 Pi 实例按该仓库详案推进。本会话/本文件不代替实施。

## 8. 迁移阶段（指针）

- **Pi capture-only protocol shadow（本仓库，已实现，默认关）**：`sediment.edgeProtocolShadow`。`session_start` → 幂等 durable session layout 初始化（与 capture 相同 layout；**不**写 source/candidate；**不算** end 路径 p99 gate，但真实执行并单独报告 metrics）。`agent_end` → durable raw sidecar（`event.messages` JSON-safe 快照；`content_id`/`payload_digest` = exact serialized messages JSON bytes 的 sha256；create-only+fsync）再 candidate journal（含 capture 时 leaf_tip）；与 local intake durable write **彼此独立**（boundary 后尽早启动 edge Promise 并立即附 reject handler，再 intake，最后 await 已 fulfilled 的 edge；任一失败不阻止另一条；默认 off 在 settings gate 后同步 no-op、零 edge 产物、无 cwd/owner/git/edge filesystem I/O——settings gate 仍读取配置，不宣称绝对 zero cost）。`agent_settled` → TerminalWitness（settled leaf_tip；`settlement_status=unsupported_core_capability` / `capture_only`）。**不**写 `terminal_seal` / TurnSettled；**不**接 link open/close（Pi core 无 launch broker / session transaction）。既有 local intake 仍是唯一 local_primary；edge 可在 `sediment.enabled=false` 时独立 capture；失败 fail-closed 于 edge protocol，不影响 queue/recovery/publication。Retention/tombstone 由后续 required-consumer ACK 策略接管（本切片不自动删除 raw）。**生产验收方法 v3 = 真实 session 多 turn 生命周期**：**terminal assistant** = Pi JSONL 中 `role=assistant && stopReason !== 'toolUse'`（含 stop/length/error/aborted/缺省；`toolUse` 是同一 agent loop 的中间 tool call，**不算** agent_end）。每个真实 Pi JSONL 选一条主链（优先最新 **terminal assistant** leaf，按 id/parentId 回溯；若 active branch 尾部仍是 toolUse 且无 terminal leaf 则跳过，不伪造）；header-only SessionManager + 真实 `session_start` 一次；按主链 `appendMessage` 真实正文，每完整 run 只 fire 一次 `before_agent_start`（run 首个 user 之后，或 terminal 前无 active 时补一次），遇 **terminal assistant** 节点计时 `agent_end` + 计时 `agent_settled`；同 session 自然推进 C6/producer_seq（第一 cand=1，后续 cand=prevWitness+1，witness=cand+1，严格相邻）。收集多 session 至 ≥100 **terminal assistant** turns（尽力 ≥10 distinct sessions；生产数据不足时报告实际，禁止复制/合成）。默认 3 轮；`agent_end` 与 witness 各自任一轮或 aggregate p99≥100ms → `not_accepted` / exit 2。Integrity 适配同 session 多 turn（current C6/current leaf/current source；witness exact refs；longitudinal seq 严格相邻；filename/JCS/source digest；intake exact 匹配当前 session+turn_id+leaf）；任一失败 hard fail。权威数值与 accepted/not_accepted **仅**以已归档的 [edge protocol shadow production acceptance v3](../evidence/2026-07-24-edge-protocol-shadow-production-acceptance.json) 为准（`result=accepted`；每轮100 terminal turns，分布于32 sessions，共3轮/300 samples；4200/4200；aggregate end p99=57.708ms / witness p99=18.624ms；implementation_source_digest sha256 `7949c2e4b40b42ddde2f5d8561ce729c21a999a02e1cbddd31186c88503bd870`；全表与 round 细节只在 evidence）。**默认仍 off、capture-only**；Stage A/B/C 仍未完成；local intake 仍是唯一 primary；**不**宣称 cutover / 中心/seal 路径启用。
- Stage A（完整）：daemon spawn headless TS sediment worker；Pi 内 queue/recovery/replay/timer 关闭；parity + `local_executor_epoch` 后切换；kill-switch 不并发。**未实施**（缺 Pi core transaction + launch broker + pi-router bridge）。
- Stage B：central shadow。**未实施**。
- Stage C：逐 scope `local_primary → central_primary`（经 shadow/rollback_draining）；无 dual primary。**未实施**。

细节、协议、验收矩阵与中心最小 schema 见 pi-router 详案。

### 8.1 自动化

- `npm run smoke:edge-protocol-shadow`（真并发跨进程 seq、candidate-vs-witness 竞态、toJsonSafe cycle/shared、sanitizeSessionId pure-dot、真实 extension wiring 隔离进程含 session_start layout init / default-off 零产物 / 同 session 多 turn seq+leaf+witness、durable-write verifyCreated、intake verifyCreated=false identical/collision、strict tsc、source fault injection、跨进程重启仅凭 record filenames 连续 seq、断言无 writer-state、`initializeEdgeProtocolShadowSession` 幂等）
- `npm run smoke:sediment-daemon-edge-capture`（continuous pair：terminal-leaf admission、同 leaf content conflict、同 C6 不同 leaf + `c6_collision`、A→B→A reuse、legacy candidate reuse、unreferenced source dry-run/execute/redrive + capture/operator audit、ambiguous witness、adversarial T1/T2/T4/T6/T7/T9、producer_seq、strict tsc）
- `npm run recover:edge-unreferenced-sources -- --abrain-home <path> [--owner-project-root <path>] [--session-id <id>|--all-sessions] [--limit N] [--capture-audit-path <path>] [--operator-audit-path <path>] [--execute]`（operator only；默认 dry-run；execute 强制 owner/session scope/limit/capture-audit/operator-audit；不合成 C6/leaf；不改 source；不写 job/ACK；不在 session_start 自动跑）
- `npm run dossier:edge-protocol-shadow-production`（**v3 full-handler 真实 session 多 turn** 验收：真实 extension `session_start` layout init + `agent_end` + `agent_settled`；真实 Pi JSONL 主链多 turn，边界=**terminal assistant**（`stopReason !== 'toolUse'`）；≥100 terminal turns × 3 轮；`agent_end` 与 witness 各自每轮+aggregate p99&lt;100ms；session_start metrics 单独报告非 gate；同 session 多 turn integrity hard fail（exact current intake + longitudinal seq）；不足/超标均 `not_accepted`，禁止 fixture；stdout 纯脱敏 JSON）。权威归档见 [edge protocol shadow production acceptance v3](../evidence/2026-07-24-edge-protocol-shadow-production-acceptance.json)（已通过：26×100×3、4200/4200、aggregate end/witness p99 均 &lt;100ms；默认 off / capture-only / 非 cutover；Stage A/B/C 未完成；local intake 唯一 primary）

## 9. 相关文档

- [ADR 0044](../adr/0044-central-sediment-edge-authority.md)
- [sediment.md](./sediment.md) — 当前本地实现契约
- [memory.md](./memory.md) — 当前读路径
- [ADR 0027 C6](../adr/0027-coupled-stigmergic-dual-loop-agent-system.md)
- `/home/worker/work/components/pi-router/docs/architecture/central-memory-sediment.md`
