---
doc_type: consensus
status: active
---

# 第二大脑过渡态登记表

`docs/transition-register.machine.json` 是本登记表的 machine source of truth；本文仅是人类可读镜像。所有状态、授权、复审日期和 stable ID 变更必须先更新 JSON，再同步下面的确定性镜像与详细说明。

<!-- transition-register-machine-mirror:start -->
## Machine source 镜像

> 此区块由 `docs/transition-register.machine.json` 确定性生成；JSON 是 machine source of truth，Markdown 仅用于人类阅读。

| Stable ID | 面 | Phase | Authorization | Review by | Risk |
|---|---|---|---|---|---|
| `canonical_path.p1` | canonical_path P1 | `completed` | `authorized` | 2026-07-24 | `critical` |
| `canonical_path.p2` | canonical_path P2 | `blocked` | `not_authorized` | 2026-07-24 | `critical` |
| `canonical_path.p3` | canonical_path P3 | `blocked` | `not_authorized` | 2026-07-24 | `critical` |
| `canonical_path.p4a` | canonical_path P4a | `blocked` | `not_authorized` | 2026-07-24 | `critical` |
| `canonical_path.p4b` | canonical_path P4b | `blocked` | `not_authorized` | 2026-07-24 | `critical` |
| `constraint.adr0034-staleness-resync` | ADR 0034 staleness re-sync | `gated_deferred` | `blocked_on_trigger` | 2026-07-24 | `low` |
| `constraint.auto-refresh-failed-run-retry` | auto-refresh failed-run 重试 | `observe` | `authorized` | 2026-07-24 | `high` |
| `constraint.dual-read-audit-retirement` | dual-read audit 关闭 | `blocked_on_prerequisite` | `not_applicable` | 2026-07-24 | `medium` |
| `constraint.dual-read-flip` | Constraint 双读 flip | `blocked_on_evidence` | `separate_authorization_required` | 2026-07-24 | `critical` |
| `constraint.read-flip-state-to-git-l2` | read-flip .state→git L2 | `blocked` | `separate_authorization_required` | 2026-07-24 | `critical` |
| `constraint.tier2-legacy-write-gate` | tier2RulesLegacyWriteGate observe→block | `observe` | `blocked_on_prerequisite` | 2026-07-24 | `high` |
| `dispatch.hub-dogfood` | hub dogfood | `dogfood` | `authorized` | 2026-07-15 | `high` |
| `forgetting.kind-evidence-strength-v1` | KIND_EVIDENCE_STRENGTH 映射表（v1 过渡面） | `observe` | `authorized` | 2026-07-24 | `medium` |
| `forgetting.upstream-wiring` | forgetting 上游接线 | `in_progress` | `authorized` | 2026-07-24 | `high` |
| `knowledge.legacy-physical-retirement` | Knowledge legacy 物删 | `ready_for_decision` | `separate_authorization_required` | 2026-07-24 | `high` |
| `knowledge.o5-confidence-fallback-review` | O5 conf≥8 fallback 巡检 | `observe` | `authorized` | 2026-07-24 | `medium` |
| `memory.adr0035-0037-slim-ingest` | ADR 0035/0036/0037 slim+ingest | `blocked_on_definition` | `not_applicable` | 2026-07-24 | `medium` |
| `memory.dedup-archived-dense` | dedup-archived 无 dense 通道 | `blocked_on_implementation` | `authorized` | 2026-07-24 | `medium` |
| `memory.l3-chunks-embeddings-graph` | L3 chunks/embeddings/graph 表 | `gated_deferred` | `blocked_on_trigger` | 2026-07-24 | `low` |
| `memory.p7-low-frequency-three-arm-gate` | P7 低频域三臂 gate | `gated_deferred` | `blocked_on_trigger` | 2026-07-24 | `low` |
| `outcome.unknown-attribution` | outcome unknown 占比溯因 | `observe` | `authorized` | 2026-07-24 | `medium` |
| `proposition.adr0040-p0a` | ADR0040 P0a/P0b1 schema+sandbox genesis | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p0b2-production-genesis` | ADR0040 P0b2 real production genesis append | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p1a-knowledge-pull-shadow-foundation` | ADR0040 P1a Knowledge pull shadow foundation | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p1b-knowledge-pull-consumer` | ADR0040 P1b non-empty Knowledge pull shadow experiment | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p2a1-policy-push-projector-preview` | ADR0040 P2a.1 policy push projector + read-only preview | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p2a2-policy-push-shadow-publication` | ADR0040 P2a.2 actual policy push shadow publication | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p2a21-policy-push-publication-contract-preview` | ADR0040 P2a.2.1 policy push publication contract + read-only preview | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p2a22-live-system-publication-contract-preview` | ADR0040 P2a.2.2 live-system publication contract + read-only preview | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p2b-policy-push-stable-view` | ADR0040 P2b Policy/Constraint stable-view compile + parity | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p2b1-stable-view-compiler-substrate` | ADR0040 P2b.1 repo/sandbox stable-view compiler substrate | `completed` | `authorized` | 2026-07-24 | `critical` |
| `proposition.adr0040-p3-d3-v2-session-start` | ADR0040 P3 D3-v2 session_start single-consumer | `blocked` | `separate_authorization_required` | 2026-07-26 | `critical` |
| `proposition.adr0040-p3-runtime-read-flips` | ADR0040 P3 runtime consumer read flips | `blocked` | `separate_authorization_required` | 2026-07-24 | `critical` |
| `proposition.adr0040-p4-legacy-authority-retirement` | ADR0040 P4 legacy authority retirement | `blocked` | `separate_authorization_required` | 2026-07-24 | `critical` |
| `staging.hard-delete` | staging 硬删 | `blocked` | `separate_authorization_required` | 2026-07-24 | `high` |
<!-- transition-register-machine-mirror:end -->

## Canonical path 阶段门

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| canonical_path P1 | 2026-07-10 | `completed / authorized`；S3/S1/S4/P1-B 与全部 local-v2/drain/restart/native-git/Curator stable criteria 已有匹配证据；P2/P3 未授权、未执行。 | 已满足；completion record 保持可复核。 | R3.4.2 living plan、[P1 completion record](./completions/2026-07-12-canonical-path-p1-completion.md)、runtime restart manifest。 | 保持 P1 closed；P2/P3 仅在各自取得新的独立 unanimous multi-T0 授权后启动。 |
| canonical_path P2 | 2026-07-10 | `blocked / not_authorized`；Knowledge fold-input truth cutover 未执行。 | P1 完成并取得新的独立 unanimous multi-T0 授权，再满足 byte equality 与完整链/冲突门。 | R3.4.2 living plan Phase Table。 | 仅准备候选 diff 与只读证据。 |
| canonical_path P3 | 2026-07-10 | `blocked / not_authorized`；Constraint read flip 未执行。 | P1 完成并取得新的独立 unanimous multi-T0 授权，再满足 genesis、K=5 与连续 7 日门。 | R3.4.2 living plan Phase Table。 | 仅准备 read-source diff 与 verifier。 |
| canonical_path P4a | 2026-07-10 | `blocked / not_authorized`；legacy archive move 未执行且禁止物理删除。 | P2/P3 均完成并取得 P4a 独立授权，完成 snapshot manifest 与 restore byte verify。 | R3.4.2 living plan Phase Table。 | 保持 blocked，不移动或删除 legacy 内容。 |
| canonical_path P4b | 2026-07-10 | `blocked / not_authorized`；最终 observation/declaration 未开始。 | P4a 完成并取得 P4b 独立授权，固定 14 日门与全部事件门通过。 | R3.4.2 living plan Phase Table。 | 保持 blocked；P4a 完成不自动授权 P4b。 |

## 已就绪待决策

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| Knowledge legacy 物删 | 2026-07-05 soak 届满 | Knowledge legacy 物删 soak 已满 ≥14 日历日（2026-06-21 起算）；A6 tripwire 干净，无 legacy-cold-access.jsonl。 | R 轮批准 legacy archive/delete，且定义恢复路径与失败回滚。 | Knowledge projection_only 运行数据、A6 tripwire、2026-07-08 审计。 | 启动 Knowledge legacy retirement R 轮。 |

## 滞留需推进

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| Constraint 双读 flip | 2026-07-08 审计登记 | 数据门在 2026-07-08 治理审计窗口总体达标；但 2026-07-08 06:53Z shadow run 出现一次 compile 失败（SC_COMPILER_VALIDATION_FAILED），同 source 在 06:37Z 成功，定性为 LLM 输出抖动；失败后第 29 条 constraint-evidence 待投影。 | 重跑 compile 成功并确认第 29 条 evidence 已投影后，再完成明确 flip/retirement 决策，记录授权、回滚条件与 R 轮边界。 | constraint dual-read audit、shadow compiler metrics、2026-07-08 三源交叉审计。 | 先重跑 compile 确认，再评估 flip；不得把既有 fallback=false 直接等同于 legacy retirement。 |
| ADR0040 P3 D3-v2 session_start single-consumer | 2026-07-19 | `blocked / separate_authorization_required`；R4.1保持target `019f6f1d-cc5c-7fcf-bcee-18dd618656ff`与独立authorization transcript `019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc`分离。新增独立R4.1 adapter evidence，绑定实时82-file闭包self/graph=`47ca017012d46a9a68e4081353c39882febe37824c4cd09b8985469434e40f1c`/`b8cd87198c002a94d8384d39e2002331b4f1d222ca5d88168260396d5ae9ab75`；operator/dossier/preview self=`0f799e266a8726685b177aca94351e4e413d78c850d76dc29762258f3d3c6907`/`1312f357170499438bf096400073fac910d4782a1ae3d578add7e790920e4842`/`cf66f1ccdeb53504a19e42d1a0d0144ff771a12a5713ca02eca851c9563904a2`。generic preview snapshot仅覆盖稳定面，活跃授权文件改用允许尾部append的冻结prefix/dev/ino/header/session-ID attestation；target仍要求完整身份/字节不变。settings pre raw=`64b5045111148e8d9828e6da70d591d23f491029ca873b2575fd945c15ba43d5`。S2/P3仍未授权。 | 先将R4.1及root `package-lock.json`纳入一个真实published commit，使每个critical/graph live byte等于`HEAD:<path>`；之后从独立authorization transcript取得fresh execute授权。continue与rollback仍各自独立授权，聚合P3保持blocked。 | [R4.1 design](./notes/2026-07-19-adr0040-d3-v2-session-start-r4-design.md)、[R4.1 adapter manifest](./evidence/2026-07-19-adr0040-d3-v2-session-start-r4-adapter-manifest.json)、[immutable R3.9 note](./notes/2026-07-19-adr0040-d3-v2-session-start-execution-ready.md)、[operator manifest](./evidence/2026-07-19-adr0040-d3-v2-session-start-r4-operator-manifest.json)、[R4.1 dossier](./evidence/2026-07-19-adr0040-d3-v2-session-start-r4-execution-ready-dossier.json)、[read-only preview](./evidence/2026-07-19-adr0040-d3-v2-session-start-r4-production-read-only-preview.json)、R4.1 smoke；R3.9 predecessor不改写。 | 保持S2 NOT_AUTHORIZED；禁止本修正轮production execute/continue、live settings/session/control/D3/.abrain写、rollback、commit或push。 |
| ADR0040 P3 runtime consumer read flips | 2026-07-13 | `blocked / separate_authorization_required`；聚合P3仍blocked。D3-v2 session_start已有R4.1 corrected create/bind operator与runtime exact gate，但S2仍NOT_AUTHORIZED且live v2 key absent；Knowledge pull、Policy push、canonical L2等其它runtime consumer均未读取published D3 selection。 | 每个consumer分别完成前置projector、独立授权、rollback与fail-closed定义。 | ADR0040、D3-PUB post-publication dossier、D3-v2 R3.9 predecessor与R4 execution-ready dossier。 | 禁止合并多个consumer flip授权。 |
| ADR0040 P4 legacy authority retirement | 2026-07-13 | `blocked / separate_authorization_required`；legacy rules/constraint/Knowledge authority完全未变。 | 前置consumer阶段完成、独立retirement授权、保留cold audit且不转换legacy为proposition authority。 | ADR0040 no-migration、P1a dossier。 | 禁止archive/delete/migration/authority change。 |
| hub dogfood | 2026-07-08 审计登记 | ADR 0030 已 walk-back 至 material 模式离线判定；本批落地判定回填格式 `hub-judgments.jsonl`，并执行首次真实跨厂商 material 盲判。 | 累计 ≥20 次 material 判定且质量 ≥ human-pick；计数以 `hub-judgments.jsonl` 为准。30 天无新 material 判定则告警并重评；若 2026-07-15 前未产生 ≥1 次真实判定则关闭 `dispatch.hub.enabled`。 | ADR 0030 walkback、hub audit、`hub-judgments.jsonl`、2026-07-08 治理批 audit。 | 继续回填 material 判定；触发 stale-guard 或 fail-closed 条件时执行开关处理。 |
| forgetting 上游接线 | 2026-07-08 审计登记 | decay→lifecycle_proposal 接线已落地（2026-07-08）；pending 与计数以 `~/.abrain/.state/sediment/entry-lifecycle-proposals.jsonl` 为准。 | executor 消费一个受控批次，且 demote ledger 与 reactivation window 可审计。 | entry-lifecycle-proposals ledger、forgetting-demote-ledger、aggregator run ledger、decay-shadow audit、2026-07-08 审计。 | 用小批量验证 executor 消费链路。 |
| dedup-archived 无 dense 通道 | 2026-07-09 T0 R2/R3 登记 | embedding 仅 embed active（embedding.ts:655），sedimentDedup status:[all] 只能靠 BM25 词面命中 archived。 | embed/prune 合法集扩展至 archived（检索 profile 的 active 过滤不变，仅 sedimentDedup 消费 archived dense 候选）+ smoke 覆盖。 | search-profiles.ts:55、embedding.ts:655 | 修复应先于或同批于 C2 受控批次放量。 |
| KIND_EVIDENCE_STRENGTH 映射表（v1 过渡面） | 2026-07-09 | kind→证据强度确定性 infra 白名单，长尾 kind 排除自动 demote。 | 大脑内部 reviewer lane 上线后退化为 prompt 引导。 | ADR 0031 修订记录 | reviewer lane 设计。 |
| auto-refresh failed-run 重试 | 2026-07-08 审计登记 | 取证确认 failed/threw 后无重试并静默悬挂约 13 小时；本批已加有界重试（retryAttempt≤1）。若代码批次遇到架构限制未完全落地，以治理批 audit 的实际结果为准。 | 重试机制经真实失败触发验证，并能在失败后留下可审计记录。 | auto-refresh run ledger、2026-07-08 治理批 audit。 | 临时缓解为 owner 手动 re-trigger；等待真实失败验证重试链路。 |
| tier2RulesLegacyWriteGate observe→block | 2026-07-08 审计登记 | 仍停在 observe；缺少足够前置保证。 | tier2 evidence 路径存在，或 constraint legacy retirement gate 通过。 | settings gate、constraint retirement 计划。 | 等待前置条件；触发后把 observe 切到 block。 |
| read-flip .state→git L2 | 2026-07-08 审计登记 | Constraint runtime consumer 仍读 .state compiled view；git L2 是审计/投影面。 | 门控元数据进入 git L2，preflight smoke 通过，并完成一次 multi-T0 复审。 | current-state §3、L2 projection output、preflight smoke。 | 设计并执行 .state→git L2 read-flip 复审。 |
| dual-read audit 关闭 | 2026-07-08 审计登记 | dual-read audit 仍作为过渡监控面存在。 | constraint legacy retirement 完成，且无新的 undispositioned delta。 | dual-read audit、constraint retirement gate。 | 绑定到 constraint legacy retirement 完成后关闭。 |
| staging 硬删 | 2026-07-08 审计登记 | canonical-path P1 production acceptance 已完成，但这不构成 staging 硬删授权；staging backlog 仍需按 inventory/metrics 指针评估。 | 硬删 runbook、回滚验证与独立授权完成。 | staging inventory、promotion/ageout metrics、canonical-path P1 completion dossier。 | 另行完成硬删 runbook、回滚验证与授权后再讨论硬删。 |
| O5 conf≥8 fallback 巡检 | 2026-07-08 审计登记 | 仍需持续确认 conf≥8 非指令 durable fallback 没有引入用户纠正或召回漏失。 | 审计窗口内无被用户纠正的 accepted corrections / recall misses，可移除 fallback 回 ADR 原文谓词。 | tier1_direct_write audit、O5 sunset 指标。 | 做一次窗口巡检并记录结论。 |
| ADR 0035/0036/0037 slim+ingest | 2026-07-08 审计登记 | slim 与 ingest 相关工作仍未形成可退出的闭环状态。 | slim/ingest 验收口径、数据样本与回滚边界齐备。 | ADR 0035/0036/0037 实施记录、ingest 指标。 | 汇总三项当前实态，拆出最小验收批次。 |
| outcome unknown 占比溯因 | 2026-07-08 审计登记；T0 R2 usage 语义修复落地 | 当前结论：68.6% 是 missing-used observation bucket，主要由 retrieval-only/tool-result 与 injection-only/path-a-injected 组成；不再当作 classifier/parser unknown。usage 语义已拆成 per-source ratio + self_report + derived attribution：新 `path-a-implicit` 为 observation-only `injected_no_self_report`，旧 implicit-unused 仅 legacy 分桶。R5 prompt revision deterministic dossier sidecar scaffolding 已落地；真实 generation 由 reinforced evidence gate 控制。 | per-source ratio 与 derived attribution 稳定可解释；R5 退出条件为真实 reinforced classifier prompt pattern 产出一条 `prompt-revision-proposals.jsonl` proposal，并经 operator disposition（accept/reject/defer + reason）处理。 | outcome-ledger、2026-07-08 outcome unknown triage、aggregator per-source buckets/derived_attribution、prompt-revision-proposals sidecar。 | 继续跟踪 per-source ratio；等待真实 reinforced pattern 进入 sidecar 并完成 operator disposition；禁止把 `path-a-injected` 与新 `path-a-implicit` 双计为 exposure denominator。 |

## 已收口

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| ADR0040 P0a/P0b1 schema+sandbox genesis | 2026-07-12 | `completed / authorized`；P0a/P0b1 contracts完成。Genesis binding hashes是immutable historical provenance；P1b仅给inactive evidence allowlist增加dedicated producer并更新current anchors，未重写genesis。 | proposition contract保持defined-inactive且generic preflight为`L1_SCHEMA_WRITE_DISABLED`；historical binding与current anchors均可复核。 | ADR 0040、P0a/P0b1 notes、`extensions/_shared/proposition-genesis-writer.ts`。 | 保持completed；P1b non-empty shadow experiment已另行授权完成，P1 consumer parity/read flip仍独立门控。 |
| ADR0040 P0b2 real production genesis append | 2026-07-13 | `completed / authorized`；production genesis event `3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3`已追加并保持唯一、inert、defined-inactive。 | 已满足exact append、readback、selected/foldable unchanged、generic gate disabled与protected surface equality。 | [ratification record](./evidence/2026-07-13-adr0040-p0b2-production-ratification-record.json)、[post-execute dossier](./evidence/2026-07-13-adr0040-p0b2-production-post-execute-dossier.json)。 | 保持P0完成；P1a、P1b、P2a.1与inert P2a.2 publication已完成；P1 consumer parity/read flip、P2b/P3/P4继续分别门控。 |
| ADR0040 P1a Knowledge pull shadow foundation | 2026-07-13 | `completed / authorized`；shared resolver与历史genesis-only 0-card production bundle完成；superseding v3 dossier修复completion evidence边界；无runtime consumer。P1a dossier保留当时registry hash，P1b后的current registry hash另行记录。 | whole-L1 strict+defined-inactive-only输入；五操作matrix与拓扑fail-closed；deterministic JCS原子bundle；P1a历史bundle保持0 cards，P1b另行发布one-card bundle，selected/foldable仍0。 | [proposition contracts](./notes/adr0040-proposition-contracts.md)、[v3 evidence](./evidence/2026-07-13-adr0040-p1a-production-shadow-dossier-v3.json)。 | 保持consumer-free；P1b shadow完成不构成memory/search consumer或read flip授权。 |
| ADR0040 P1b non-empty Knowledge pull shadow experiment | 2026-07-13 | `completed / authorized`，且仅覆盖non-empty shadow experiment。Latest exact trusted-session授权坐标记录在ratification record（line=173、raw=normalized SHA-256 `a6a03be7154bec4dcb564cc9555ab5e5d8cad019fbc4220fc9c6783e4516584a`、prefix `667645dfecf0ae7481bbfe6a9465751ecac417f86cb8e505c46312cace983993`）绑定v2 preview。Production CLI createevent `beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585`并立即`identical`，发布one-card bundle `7ec9bab9b741d078c917e6f8cd97cbb46d1f3a3c046e0f7f7bac1730edf0d139`及latest；post dossier self-hash=`a8ab9f8e65975fe425405b218b9fb3ff24ed5ef905419948026ccbb5f5e66cfe`。Memory/search仍未接线。 | Ratification/intent/post均self-hashed有效；whole-L1严格为genesis+1 evidence，selected/foldable=0，shadow 1 card/0 exclusions/0 diagnostics，generic gate disabled，L2/live consumer/legacy authority unchanged。P1 consumer parity/read flip仍未完成。 | [proposition contracts](./notes/adr0040-proposition-contracts.md)、[ratification](./evidence/2026-07-13-adr0040-p1b-production-ratification-record.json)、[post dossier](./evidence/2026-07-13-adr0040-p1b-production-post-execute-dossier.json)，intent路径与hash由两者共同绑定。 | 保持one-card shadow consumer-free；另行评审memory/search parity后才可授权P1 read flip。P2a.1/P2a.2 completion不改变该边界；generic writes与P2b/P3/P4继续blocked。 |
| ADR0040 P2a.1 policy push projector + read-only preview | 2026-07-13 | `completed / authorized`，且2026-07-14 T0 BLOCK已修复；范围仍仅是repo-side deterministic candidate projector、standalone validator、offline smoke与真实只读preview。Production event `beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585`因`consumer_hints.policy=false`得到exact 0 entries/1 exclusion/1 matching diagnostic；bundle=`28b415c67f6c2cf488759a1dc29aab893f4d4a20f33b420dad9d871c9ab1725e`。 | output IDs精确等于resolver evidence集合；statement-free resolution inventory重放连续lifecycle topology/terminal/disposition/activation；九阶段36个earlier/later pairs加9个suffix全覆盖；全重哈希对抗样本均拒绝；25个runtime roots的AST闭包匹配P1b冻结JCS hash且无projector/preview；source exact-byte transitive inventory已绑定。V3 full abrain无豁免前后相等且policy prefix空。 | [proposition contracts](./notes/adr0040-proposition-contracts.md)、[authoritative v3 dossier](./evidence/2026-07-14-adr0040-p2a1-production-preview-dossier-v3.json) self-hash=`188c7948df5f6b4d60291f9f736895fcb0935bc6f72dc088f48370219e353ee6`；v1/v2字节保留并由v3绑定。 | 保持build-only且consumer-free；P2a.2 later completed inert publication under separate authorization，P2b/P3/P4仍blocked。 |
| ADR0040 P2a.2.1 policy push publication contract + read-only preview | 2026-07-14 | `completed / authorized`历史范围保留：repo contract、temp-sandbox mutation/SIGKILL suite、canonical v1 planned-diff generator与real read-only v1-v4 previews。Bundle=`dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0`；v1 plan content/raw=`4abcb8e5a1074f03e1fd0c907c46c5b2949bb8abca8a0e80e53040ea86577b32`/`7cd37d339625be77a11bc2c51a9abcf2a95776d8433f9fdaa1ce83fc9acbbe8f`。 | Historical deterministic whole-snapshot contract remains byte-verifiable；P2a.2.2 superseded it for the later completed P2a.2 authorization. | [proposition contracts](./notes/adr0040-proposition-contracts.md)、[authoritative historical v4 dossier](./evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v4.json)、v1-v3 dossiers与v1 plan。 | 保持所有historical bytes；禁止回用v1 whole-snapshot plan。 |
| ADR0040 P2a.2.2 live-system publication contract + read-only preview | 2026-07-14 | `completed / authorized` for the repo contract, sandbox bwrap/mutation/race/SIGKILL evidence, static v2 plan, and historical real read-only previews. Final plan raw/self=`20f400af40eb9119d17c1fb9b26eb0b2383777fd364f37b326cad4ca1875b408`/`3177101400ceed3b5da86d6d6d99a1b269d8deef9b9bd418cfbaa33ad0c91f0a`；production nonzero replay raw/self=`79f91ff3e32714643f0ab2bfe7346296cc2980f4332675ed69d9a6fc57730f16`/`3cffac9192f8dcb40a967871781ee1f486ee74670f1ba9f789985fbf2d065e70`。Preview target absence was historical；actual P2a.2 later completed separately。 | Verified-FD bwrap/Node/helper execution, exact parent/v1 delta, terminal three-stream identity, byte-hashed Git rows, real runtime/publication graph closure, SIGKILL recovery, bounded ENOENT concurrency, and nonzero production append replay all passed. Historical preview and v1 plan bytes remain immutable. | [proposition contracts](./notes/adr0040-proposition-contracts.md)、[final static plan](./evidence/adr0040-p2a2-publication-review-dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0/publication-plan-v2.json)、[nonzero replay dossier](./evidence/2026-07-14-adr0040-p2a22-production-nonzero-append-replay-dossier.json)。 | 保持preview evidence immutable；actual P2a.2已完成，runtime consumer仍由P2b/P3单独门控。 |
| ADR0040 P2a.2 actual policy push shadow publication | 2026-07-13 | `completed / authorized`；second-round六厂商一致`SIGN`与fresh exact `role=user`授权后，production target已发布inert bundle `dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0`及`latest`。Inventory=`ee29acf5f4fc106156999f6685baf407eaf1aa523e6d2f5a292de3d4be4edb4d`；runtime consumer=false，restart=false。 | 已满足final plan、six-review byte set、intent、nonzero replay、confined five-way AND execution与corrected post-dossier验证；P2b/P3/P4不随本阶段自动授权。 | [Final plan/reviews/intent](./evidence/adr0040-p2a2-publication-review-dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0/)、[nonzero replay dossier](./evidence/2026-07-14-adr0040-p2a22-production-nonzero-append-replay-dossier.json)、[corrected post dossier](./evidence/2026-07-14-adr0040-p2a2-production-post-execution-dossier.json)。 | 保持published shadow inert且consumer-free；P2b stable view与各P3 read flip继续分别授权，P4仍blocked。 |
| ADR0040 P2b.1 repo/sandbox stable-view compiler substrate | 2026-07-14 | `completed / authorized`；该阶段历史范围仅是six-path repo/sandbox deterministic compiler与real read-only empty-source preview。Frozen P2a 0/1/1编译为`ready_empty`、0 items/0 injectable bytes；whole abrain与P2a inventory unchanged，temp removed，runtime unreachable。Real append与D3 shadow/WF/PUB后来只在各自独立授权下完成。 | 已满足exact six-path create、focused/adversarial smokes、effective-bwrap real preview与canonical plan/dossier self-hash；后续D3 completion不回写该阶段原始non-production scope。 | [P2b.1 note](./notes/2026-07-14-adr0040-p2b1-stable-view-design.md)、[plan](./evidence/adr0040-p2b1-stable-view-design/implementation-authorization-plan.json)、[dossier](./evidence/2026-07-14-adr0040-p2b1-production-read-only-preview-dossier.json)。 | 保持P2b.1历史plan与empty-source preview immutable。 |
| ADR0040 P2b Policy/Constraint stable-view compile + parity | 2026-07-13 | `completed / authorized`；real policy append、D3 shadow、D3-WF sandbox replay与D3-PUB generation-0 publication均已在独立exact授权下完成。Production v2 closure为3 input events/1 active policy candidate/1 stable item，intent/proof/committed head/selection闭合，first=`published`且replay=`identical`；selection仍runtime-inert。 | 已满足real append、nonempty deterministic P2a/stable artifacts、proof/head/selection、parity与publication readback；completion不包含任何runtime consumer/read flip。 | [Real append post dossier](./evidence/2026-07-14-adr0040-real-policy-proposition-append-production-post-execute-dossier.json)、[D3-WF dossier](./evidence/2026-07-17-adr0040-d3-wf-sandbox-replay-dossier.json)、[D3-PUB completion](./notes/2026-07-17-adr0040-d3-pub-production-completion.md)、[post-publication dossier](./evidence/2026-07-17-adr0040-d3-pub-production-post-publication-dossier.json)。 | 保持published D3 selection runtime-inert；selection存在后不得重跑pre-publication D3-PUB gate，任何runtime consumer/read flip仍属P3独立授权。 |

## 已收口记录

- ADR0040 real policy proposition append已完成：event `1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6`经fresh Stage-3 authorization与独立S2 recovery授权完成到clean S4；ratification、recovery dossier与terminal post dossier保持可复核。
- ADR0040 D3 shadow已完成repo/sandbox control plane与真实production只读preview；没有production D3 mutation或runtime consumer。长期设计见 [D3 lifecycle freshness design](./notes/adr0040-d3-lifecycle-freshness-design.md)。
- ADR0040 D3-WF已完成OFD-fenced system-temp staged append/replay与proof/head/selection验收；production L1/D3/config/runtime未变。长期设计见 [D3 lifecycle freshness design](./notes/adr0040-d3-lifecycle-freshness-design.md)。
- ADR0040 D3-PUB generation 0已完成runtime-inert production publication：3/1/1 closure、first `published`、replay `identical`、v1 absent、protected snapshots unchanged；post-publication evidence见[completion note](./notes/2026-07-17-adr0040-d3-pub-production-completion.md)。
- canonical-path P1 已于 2026-07-12 完成，证据与残余风险见 [P1 completion record](./completions/2026-07-12-canonical-path-p1-completion.md)；P2/P3 继续 `blocked/not_authorized`，未创建授权票或启动实现。
- P5.6 verifier 已从待决策面移除：roadmap 已标 DONE，后续仅按回归监控处理。
- legacy rule `body_hash` 漂移已从过渡面移除：写侧 hash 已改为 post-transform 计算（`writer.ts:3604-3612`，`rule-writer.ts:300` 注释），2026-06-24 已 re-stamp，最近运行报告 0 mismatch；证据收口见 `docs/audits/2026-07-08-governance-fix-batch.md`。
- tool-contract 相关文档面按本批退役完成；后续若代码或 smoke 仍残留，以治理批 audit 与代码批结果为准。

## 健康 gated-defer

这些面不占过渡预算，触发即行动。

| 面 | 进入时间 | 当前状态 | 退出条件 | 证据源 | 下一动作 |
|---|---|---|---|---|---|
| P7 低频域三臂 gate | 2026-06-21 gated-deferred | identity / skills / habits / workflows / project-memory / rationale 等低频域仍无触发证据。 | 任一 gate arm 触发：30 天内足量 constraint-evidence、真实 identity-class 塑形错误、或可 replay 的历史事实样本。 | roadmap P7、ADR0039 P7 consensus。 | 无触发则继续 deferred；触发时按 P7 runbook 执行。 |
| L3 chunks/embeddings/graph 表 | 2026-07-08 审计登记 | 派生索引/表保持可重建，不作为 git SOT；当前无必须物化的新证据。 | 真实规模、查询延迟或恢复成本证明需要物化。 | ADR0039 L3 schema defer、runtime search metrics。 | 保持 deferred，触发时先做 schema 与 rebuild 评审。 |
| ADR 0034 staleness re-sync | 2026-07-08 审计登记 | staleness re-sync 暂无当前故障触发。 | 出现 staleness 复发、跨源不一致或 re-sync 失败证据。 | ADR0034 impl plan、staleness audit。 | 无触发则不推进；触发即进入修复批次。 |

## 巡检机制

本表为唯一登记面；每次新增 shadow、observe、dogfood 状态必须同步登记退出条件。建议巡检周期为双周。
