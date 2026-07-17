---
doc_type: design-note
status: active
---

# ADR0040 D3 lifecycle freshness design

本文合并 D3 shadow control plane 与 D3-WF staged append/replay 的长期设计语义。Production completion 与当前授权状态分别见 [D3-PUB completion](./2026-07-17-adr0040-d3-pub-production-completion.md) 和 [transition register](../transition-register.md)。

## Dual-pointer authority

D3 使用两个互相独立的 authoritative pointer：`heads/current.json` 是同步 freshness/safety gate，`selections/current.json` 是唯一 artifact activation point。Writer 必须 head-first：先推进 head，使 reader 立即看见 noncommitted 或 head/selection mismatch，再推进 selection。初始创建也遵循该顺序。

Root `current.json`、root latest、artifact subtree latest/current 与任何 secondary activation pointer 都不存在且必须被拒绝。P2a/stable CAS 的存在不产生 authority；只有 current selection 对 exact committed head 与完整 artifact closure 的绑定才能激活 artifact。

Head 与 selection 都是 immutable predecessor chain。Head generation 从 genesis 开始严格加一，predecessor hash 必须精确，epoch 不变，source corpus append-only，generation 与完整链长度一致。Selection 具有独立单调 `seq`，其 predecessor selection 必须精确，generation 不回退且必须等于所绑定 head generation。Selected selection 绑定 exact head、P2a bundle、stable bundle、stable manifest 与 rendered view；blocked selection 将 artifact refs 全部置 null 并绑定 reason/detail。

## Reader protocol

Reader 只访问显式 control root 下的 pointers、head、intent、proof、selection 与 artifact CAS；它不扫描 L1，不运行 scanner、resolver、projector 或 compiler，也不 lazy-create 缺失 CAS。所有 control record 都必须验证 embedded identity、requested hash 与 CAS filename 一致，predecessor chain 使用同一 protected reader。

第一次读取顺序固定为 head pointer 后 selection pointer。每个 pointer 以 `O_NOFOLLOW` 打开 regular file，并比较 pathname lstat、opened FD fstat、read-after fstat、canonical raw bytes、pointer hash 及 dev/ino/mode/nlink/size/mtime/ctime identity。读取 control chain 与 artifacts 后，reader 仍按 head 后 selection 的顺序二次读取；前后 raw bytes、hash 与完整 identity 必须相同，replace-same-bytes 与 A-B-A 都 fail closed。Head secondary-read failure 优先于 selection secondary-read failure。

Missing head 与 missing selection 必须分别分类，不能伪装成 artifact `missing_cas`。Shadow profile 在 current head noncommitted 或 committed-head/old-selection 窗口返回 freshness failure，不激活旧 artifact。D3-WF profile只在完整验证 transaction closure 后允许两个明确 fallback window：`intent/old` 与 valid `committed/old` 返回 fully validated old selection；新 artifact 仍只能由 new selection 激活，proof 缺失或 mismatch 必须先于新 artifact activation 失败。

## CAS layout and durability

Shadow control layout 固定为：

```text
heads/current.json
heads/v1/<head_hash>/head.json
intents/v1/<intent_hash>/intent.json
selections/current.json
selections/v1/<selection_hash>/selection.json
p2a/v2/bundles/<p2a_bundle_hash>/{diagnostics.json,entries.json,exclusions.json,manifest.json}
stable/v1/bundles/<stable_bundle_hash>/{diagnostics.json,manifest.json,parity.json,view.json,view.md}
```

D3-WF 使用独立 `proposition-lifecycle-freshness-sandbox-cas/v3` root 与不兼容的 intent/head/selection v2、proof v1、P2a manifest v3、stable manifest v3。Reader 不跨 layout fallback。V3 wrapper 绑定原 v2 artifact 的 exact raw bytes、length 与 hash；stable wrapper 还绑定 compile profile bytes，source binding 保存完整排序 source rows。

Immutable document 与 artifact 采用 same-filesystem temp、file fsync、no-replace hardlink、directory fsync、cleanup fsync 与 exact readback。Existing target 只接受 exact bytes；CAS collision 不覆盖。Pointer materialization 顺序是 immutable head CAS、selected artifact CAS、immutable selection CAS、head pointer、selection pointer。Blocked selection 不物化 P2a/stable artifacts。返回 `identical` 前必须重读双 pointer、两条 chain、control CAS 与全部 active artifacts；缺失 CAS 被 exact 恢复时返回 `recovered`。Production protected-surface 验收必须对整个 future D3 root 做一次 missing-to-missing 全量快照，不得拆分为 `heads` 或 `selections` 子 root；该快照同时覆盖 root、intents、heads、selections、p2a、stable 及非法 root pointer。

## Production pointer CAS boundary

Shadow `advancePointer` 的 read-check 加 atomic rename 不是 production expected-predecessor CAS。它没有把“观察到 expected predecessor”与“替换 pointer”组成不可分割条件，两个分歧 writer 可能在检查后互相覆盖。Production writer 禁止复用该函数或声称 rename 本身提供 CAS。

Production/D3-WF pointer advance 必须在 retained OFD lock 内完成：读取 expected predecessor、准备 deterministic pointer temp、紧邻 rename 再读 predecessor、rename、parent fsync、residue cleanup 与 exact readback都发生在同一 retained lock lifetime 内。Stale predecessor、fork、foreign successor、invalid pointer、selection ahead 或 foreign pointer temp 必须无覆盖阻断。D3-SSR 只有在 publication 后单独定义 persisted session selector、runtime fallback、audit 与 rollback，并取得独立授权后，才能改变 single-session read source。

## Acyclic intent/proof/head graph

Intent 绑定 transaction、staged lifecycle event、unique predecessor head/selection、source-production snapshot、fence epoch、C0 与 deterministic post-state prediction。Prediction 包含 exact post-corpus rows、P2a/stable artifacts、manifest identities、rendered bytes 与 compile profile bytes。Fence epoch 等于 predecessor committed generation 加一。

Intent head 为避免自引用，将 `intent_head_hash` 留空。Independent proof 随后绑定 actual intent-head hash；committed head 再绑定 proof 与 actual intent-head hash，因此图保持 acyclic。D3-PUB proof 按 `intent_hash` 执行 immutable intent-keyed no-replace 寻址，以断开自引用；该路径是 intent-keyed identity route，不是 content-addressed CAS path。Proof identity 删除且只删除 `proof_hash` 与 `audit` 后按 RFC8785/JCS SHA-256 计算。

Proof 闭合 intent、intent head、stage/final append、predecessor head/selection、fence 与 retained-lock identity、C0/C1/Ccommit/Cpost、post scans 及所有 artifact/manifest/render/profile raw identities。C1 与 pre-link Ccommit 是 durable immutable checkpoint CAS，但不替代 file/directory fsync。Proof file fsync、parent fsync、canonical readback 与完整 validation 必须在 committed-head pointer 可推进前完成。

## S0-S4 append FSM

Lifecycle event append 使用以下 durable FSM：

| State | Durable shape |
|---|---|
| S0 | stage absent；deterministic temp 与 final absent |
| S1 | exact stage present；temp/final absent |
| S2 | exact deterministic temp present；final absent |
| S3 | temp 与 final 是 exact same-inode links，`nlink=2` |
| S4 | exact final 为 mode `0600`、`nlink=1`；temp absent |

Stage CAS 必须先于 intent。Append 以 `O_EXCL` 创建 deterministic temp，写 exact bytes，file fsync 与 parent fsync；验证 control root、stage、L1 parent/temp/final 位于同一 device；no-replace hardlink 到 final；parent fsync；unlink temp；再次 parent fsync；最后 file fsync 与 exact readback。`EXDEV` 转为 explicit blocked state。

Existing exact S2/S3/S4 是 recovery input。S3 recovery只在 temp/final 为同一 exact inode、bytes/mode/link count 全部正确时 unlink temp 并 fsync parent，收敛到 S4；target-existing branch也必须先完成该 pair recovery。Stage/temp/final 的 bytes、symlink、type、mode、nlink、inode、device 或 foreign residue 不匹配时 fail closed。Recovery 只在下一次 retained-lock invocation 发生，不声明 autonomous recovery；没有 TTL、lease age 或 mtime abort。

Transaction publication 顺序固定为 stage、intent、intent-head CAS/pointer、append、P2a/stable CAS、proof CAS、committed-head CAS/pointer、selection CAS/pointer。Accepted same-transaction recovery shapes仅为 stage-before-intent、old/old、intent/old、committed/old 与 committed/new。Intent/new、selection ahead、forked current、different transaction、missing S3/S4 Ccommit witness 或 foreign successor 都阻断。Explicit abort 需要独立 authorization，不得由超时推断。

## Retained OFD lock boundary

Retained lock helper 以 `O_NOFOLLOW|O_DIRECTORY` 打开 existing control root，验证 lstat/fstat/realpath identity，将同一 open file description 作为 child fd 3 交给 no-follow-opened `flock -xn 3`，并在完整 async transaction 期间由 parent 保持 FD。Exit status 1 映射为 `BUSY`；其它非零、signal、spawn error 或 identity drift 都阻断。Parent close 或 holder `SIGKILL` 释放 lock。

该锁不创建 lock file，不依赖 PID、mtime、lease、TTL 或 cleanup protocol。它只串行化 official writers，不声称排除 foreign writer；因此 lock 内仍必须执行 expected-predecessor checks、C0/C1/Ccommit/Cpost、named/opened identity rechecks、durable pointer readback 与 foreign-state rejection。`flock` inode 受 host-root trust boundary 保护，恶意 root 或 `/proc` 控制不在该协议的防御范围。

## Authority pointers

长期机器证据见 [D3-WF sandbox dossier](../evidence/2026-07-17-adr0040-d3-wf-sandbox-replay-dossier.json)、[D3-PUB source capsule](../evidence/2026-07-17-adr0040-d3-pub-source-capsule.json)、[D3-PUB static plan](../evidence/2026-07-17-adr0040-d3-pub-static-plan.json) 与 [post-publication dossier](../evidence/2026-07-17-adr0040-d3-pub-production-post-publication-dossier.json)。这些 immutable artifacts 保留原字节；本文不复制其 preview 字段或测试枚举。
