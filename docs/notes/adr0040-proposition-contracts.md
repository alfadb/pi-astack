---
doc_type: design-note
status: active
---

# ADR0040 proposition contracts

本文合并 ADR0040 P0-P2a 阶段中需要长期维护的 proposition、lifecycle、授权与 publication 契约。阶段状态以 [transition register](../transition-register.md) 为准，当前实现以 [current state](../current-state.md) 为准，长期机器证据以 [transition register machine source](../transition-register.machine.json)、canonical evidence 与本文 Authority pointers 为准。

## Defined-inactive 与 canonical 字段

`defined_inactive` 是完整但不生效的 schema 声明阶段：registry entry 必须声明 `body_schema`、`event_types` 与 `producers`，同时必须保持 `write_enabled=false`、`fold_eligible=false`。Whole-L1 scanner 将匹配事件分类为 `defined-inactive-shadow`；它们不得进入 selected 或 foldable 集合。专用、逐项授权的 writer 可以写固定 tuple，但 generic proposition preflight 必须持续返回 `L1_SCHEMA_WRITE_DISABLED`。

每个非 genesis proposition event 必须显式携带 `epoch.epoch_id` 与 `epoch.genesis_event_id`，不得从时间或文件位置推断 epoch。Production genesis body 为避免自引用环，不携带自己的 `genesis_event_id`；genesis event ID 本身是 epoch anchor，后续 evidence 与 lifecycle event 必须显式绑定该 anchor。Genesis scope 与 contract kind 必须匹配：`schema_contract` 对应 schema contract，`production` 对应 production genesis；cutover contract 固定为 no-migration、要求 production genesis，且 P0 effect 仅为 `defined_inactive_only`。

Temporal facets 只接受严格 RFC3339 UTC timestamp 或 null。Canonical proposition facts 不包含 `injectMode`、`always`、`listed`、`priority`、Policy eligibility 或 session-start eligibility；这些字段属于 projector/consumer 的派生决策，不能由 writer 固化为 canonical authority。Immutable production event body 不得携带 `preview`、`blocked`、`execute-disabled` 或其它可变运营状态；此类状态只能进入 dossier/register，不得进入 production event 的 immutable semantic body。Proposition body、envelope、manifest 与 self-addressed records 使用 RFC8785/JCS UTF-8 canonical bytes 和 SHA-256 identity。

## Binding manifest

Production genesis 必须绑定创建时的 registry/schema 状态。Binding manifest 至少闭合以下语义：

- registry identity；
- validated registry object 的 JCS hash；
- registry exact file bytes hash；
- derived proposition schema contract 的 JCS hash；
- binding manifest 自身的 JCS hash。

这些值是 genesis 创建时的 immutable historical provenance，不要求 current registry 永远 byte-identical。后续独立授权可以为 inactive schema 增加专用 producer，但不得重写 genesis，也不得借此启用 generic writes。`schema_contract` fixture 可以没有 production binding；`production_genesis` 必须有 binding，且 producer 与 manifest identity 必须精确匹配。

## Ratification 与 transcript 边界

Production executor 不从对话上下文、caller 提供的 raw text 或自称已授权的 JSON 推断授权。Machine ratification record 必须绑定 exact preview/plan、event 或 publication tuple、target、output、允许动作及 trusted transcript coordinate；executor 必须自行读取受信 session root 下的 JSONL，并验证首行 session header、session ID、无重复 message ID、连续 parent chain、目标 `role=user` message 的 id/parent/line/timestamp/text identity，以及包含该行的 transcript prefix bytes identity。

授权语义先检查否定、撤回与重复模板，再接受唯一、完整且精确绑定目标的授权表达。Tool output、assistant text、synthetic production record、路径逃逸、symlink、header/anchor/chain 不一致或仅有 self-hash 的伪造 record 均不得获得授权。Executor 不提供 env、force、yes、bypass 或 caller-supplied raw-text 通道；existing target 只允许 exact-identical recovery，不允许覆盖或 tuple drift。

Threat boundary 是 pi runtime 管理的 trusted session root。Transcript prefix hash、record self-hash 与 parent-chain validation 提供该边界内的 provenance binding；它们不宣称抵御能够同时任意改写本地 session JSONL 与 executor code 的攻击者。

## Frozen tuple 与 no-bypass writer

Dedicated genesis/evidence writers 不接收任意 proposition JSON，而是从代码中的 frozen tuple 重建唯一允许的 body，完成 schema、epoch、producer、target 与 canonical-bytes 验证后，以 durable no-replace create 发布。Frozen P1b evidence tuple保留以下长期语义：producer 为 dedicated production evidence writer；statement 为“统一真相源、不同消费投影是第一要务。”；modality/language 为 `normative`/`zh`；authority 为 user-attested；scope 为 global；temporal horizon 为 durable；maturity 为 accepted/reviewed；contestability 为 uncontested；sensitivity 为 public；retrieval hint 为 true、policy hint 为 false；lineage arrays 为空，并绑定 production epoch/genesis。

Frozen tuple 不授权通用写入，不授权从 transcript 任意抽取新 event，也不授权 runtime consumer。Missing ratification、tuple drift、same-epoch different body、different epoch conflict、target collision、noncanonical bytes、symlink/realpath escape 或 output collision 都必须在 mutation 前 fail closed。Intent 必须先于 production append durable 创建；恢复只接受 intent、ratification、tuple、prestate、target 与 output 全部 exact 的同一 transaction。

## Shared lifecycle

Effective-state resolver 只消费 fixed epoch/genesis 下、whole-L1 validated 且分类为 `defined-inactive-shadow` 的 proposition evidence/lifecycle records。它不使用文件顺序、wall clock、locale、consumer hint 或 latest-wins。每个 lifecycle event 的 `facets.lineage.causal_parents` 成员必须与 `target_event_ids` 精确一致；未知 parent、跨 epoch/genesis、因果环、分叉、重复 replacement claim、非法 target kind 或无法归入唯一 evidence root 的拓扑使整个 resolution fail closed。

| Operation | Targets | Legal state target | Result |
|---|---:|---|---|
| `retract` | 1 | evidence / rescope / reactivate | retracted |
| `rescope` | 1 | evidence / rescope / reactivate | active，采用新的 effective spatial scope |
| `archive` | 1 | evidence / rescope / reactivate | archived |
| `reactivate` | 1 | retract / archive | active |
| `supersede` | 2 | old evidence/rescope/reactivate + replacement evidence | old lineage superseded；replacement 独立 active |

`supersede` replacement 的 `facets.lineage.supersedes` 必须精确指向被替代 lineage 的 root evidence。P0 `cutover` 是 genesis boundary declaration，不是 effective-state operation，resolver 必须拒绝把它当作上述五种状态动作。

## Knowledge pull contract

Pull card 保留 source evidence 的 exact statement、modality、language、source event/epoch、original/effective facets、effective scope、lifecycle lineage、terminal event 与 disposition。`consumer_hints` 只作为原始 facet 保留，不参与 card inclusion；`normative` proposition 可以进入 pull shadow，但不由此获得 push authority。

以下 source 不生成 searchable card，只生成不含 statement/free text 的 exclusion 与 diagnostic：

- terminal lifecycle 为 retracted、archived 或 superseded；
- modality 为 `meta-lifecycle`；
- scope 不能确定为 global/project/domain；
- temporal state 需要外部 evaluation context 或为 unknown；
- sensitivity 为 secret/secret-adjacent、handling 为 withhold/unknown，或要求 projector 不支持的 redact；
- contestability 为 contested/requires-review/unknown。

Pull projector 不生成 `injectMode`、priority、always、listed、Policy eligibility 或 session-start eligibility。Bundle 中的 manifest/cards/exclusions/diagnostics 必须 deterministic；manifest 绑定 bundle directory identity，`latest` 只能指向验证后的 immutable bundle。

## Policy relevance 与 exclusion 全序

Policy candidate entry 只表达 `policy_push` face relevance，冻结 marker 为 `relevance_only_no_injection_verdict`。它不是 injection、session-start、ranking、runtime consumption 或 authority verdict；manifest authority 必须保持 shadow-only/no-runtime-consumer 语义。

Candidate 必须同时满足 active lifecycle、受信 user/operator authority、resolved scope、durable unbounded temporal horizon、public/non-redacted sensitivity、uncontested 且无 counterevidence、accepted/reviewed maturity、normative modality 与 `consumer_hints.policy=true`。不满足时，每个 source 只产生一个 statement-free exclusion 及同 reason 的 diagnostic。

首因判定采用固定九阶段全序：

1. lifecycle
2. safety
3. scope
4. temporal
5. sensitivity
6. contestability
7. maturity
8. modality
9. policy hint

Validator 必须使 entry 与 exclusion source IDs 精确分割 resolver evidence set，重放连续 lifecycle topology，并拒绝 omission、duplicate、foreign lifecycle、reordered/gapped lineage 或 fabricated terminal，即使攻击者重算全部 record/artifact/manifest hashes。

## INV-LIVE-PUBLICATION-CONFINEMENT

`INV-LIVE-PUBLICATION-CONFINEMENT`：高风险 live publication 的静态授权只绑定 bundle/final inventory、proposition/schema/registry/projector/runtime/source、confinement 与 drift-registry anchors，不绑定 review 时的 live whole-abrain snapshot 或 Git HEAD；实际 mutation 必须在 execution time 重新验证所有 static anchors、registered append streams、protected paths、Git forensics 与 executable identity。

Mutation 只能经 fail-closed confinement 运行。Bubblewrap、Node 与 helper 必须通过 no-follow opened FD 验证并从已打开对象执行或绑定，不得 pathname reopen，不得在 confinement 不可用时 fallback。Bootstrap 的真实 kernel writable surface 是受验证 parent bind，helper 只能创建 hardcoded target；installer 随后只获得 exact target bind。Registered append streams 允许的变化仅是保留已固定 prefix 的完整、schema-valid newline suffix；replacement、truncate、torn row、unknown stream 或 protected-path drift 均阻断 completion。

Production completion 是五个独立 verdict 的逻辑 AND：

- `confinement`：namespace、read-only host、network/capability/environment/FD 与 executable handoff 均有效；
- `target`：target inventory、bytes、mode、ownership、pointer 与 residue 精确符合 plan；
- `protected`：所有 non-target protected paths 保持 canonical per-path equality；
- `drift`：仅 registered streams 出现允许的 append-only suffix，Git metadata/worktree 分类无越权变化；
- `runtime`：static source/runtime/publication graph anchors 与 forbidden reachability 仍精确成立。

任何 verdict 为 false 都使 completion=false；即使 target 已创建也保持 inert，不得在 anchor advance 后追认旧 target complete。Same-plan recovery 仅在全部 static anchors 与 durable transaction state 仍 exact 时允许。

## Authority pointers

长期机器证据由 [transition register](../transition-register.machine.json) 索引。关键 canonical artifacts 包括 [P1a v3 dossier](../evidence/2026-07-13-adr0040-p1a-production-shadow-dossier-v3.json)、[P1b post-execute dossier](../evidence/2026-07-13-adr0040-p1b-production-post-execute-dossier.json)、[P2a.1 v3 dossier](../evidence/2026-07-14-adr0040-p2a1-production-preview-dossier-v3.json)、[P2a.2 static plan](../evidence/adr0040-p2a2-publication-review-dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0/publication-plan-v2.json) 与 [P2a.2 post-execution dossier](../evidence/2026-07-14-adr0040-p2a2-production-post-execution-dossier.json)。P1a v1 BLOCK 的根因是 dossier ancestor symlink containment 不完整、mutation inventory 只覆盖 shadow subtree 而不足以支持整体变更声明、以及 latest bundle identity 未同时绑定 pointer hash、bundle directory identity 与 validated manifest hash。v2 因 live baseline 跨运行演进，在同一路径的 exact-only 写入时发生 dossier bytes collision；该路径未覆盖旧证据，故以新路径 v3 取代。该过程证明 existing output 只允许 exact-identical recovery，不允许 overwrite。Immutable evidence 的 bytes 与 self-hash 不由本文重述或改写。
