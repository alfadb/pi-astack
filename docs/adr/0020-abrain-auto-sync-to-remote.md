---
doc_type: adr
status: accepted
---

# ADR 0020 - Abrain automatic multi-device convergence

> 机制 rationale 已由 ADR 0034 ingest lane 分解入第二大脑；方向契约见 [`direction.md`](../direction.md) 的 `INV-SYNC-DETERMINISTIC-MERGE`。

## 状态

Accepted。2026-07-20 修订以 deterministic device join 取代旧 `ff-only` / 通用 Git 3-way / 人工 divergence 处理描述。

## 决策

跨设备同步以用户已 clone repo 并配置 branch upstream 为前提。pi-astack 只继承用户的 remote、认证和 transport 环境，不创建、不改写也不猜测这些配置；网络、认证和 timeout 失败只写 `.state` audit 与 warning，不阻断本地 canonical writer 或 startup。

正式 native `git fetch` 完成后，git-sync 必须分别把 `HEAD^{commit}` 与 `@{upstream}^{commit}` 解析为固定 exact OID。只有两个固定 OID 严格相同时才返回 typed `fetch/result=noop`、`merged=0` 和 overall `ok=true`；该路径不得调用 `prepareDeviceJoin` / canonical settlement，不得读取完整 tree、扫描 whole L1、重建或验证 L2，不得获取 canonical mutation barrier，也不得 push。不得用 ahead/behind count、tree equality、ancestor relation 或可变 symbolic ref 观察替代该 OID 等值条件。相等观察后的本地 ref race 留给后续 writer/sync；非相等路径由 coordinator 的 stale/CAS 重算以及 exact push 的 fresh HEAD OID 和 remote non-force rejection 重新判定。

上述 fast path 不是 canonical 完整性捷径。Canonical `session_start` / recovery 仍先处理 journal、dirty canonical backlog、whole-L1 history 与 L2/integrity proof，startup autosync 只能从其 `local_ready` continuation 启动；因此 device noop 不得改变或绕过本地先行顺序。这个职责分离也是性能边界：一个已 canonical-ready、fetch 后同 tip 的大仓库，其 device delivery 成本只允许由 fetch、两次 commit OID resolution 和 best-effort `.state` audit 主导，不能随 tracked tree/L1/L2 规模线性增长。

仅当固定 OID 不同时，convergence 才解析本地 `H`、upstream `U` 和唯一 merge-base `B` 的完整 tree map。L1 的 `B -> H` 与 `B -> U` 都必须 add-only；已有路径的删除、mode 变化或 blob 变化一律 typed fail-closed；两侧新增同一路径时 mode/blob 必须完全相同。注册 L2 不采用任一父提交内容，而是从 union L1 通过已有版本化 reconciler 完整重建，包括 tracked `l2/views/knowledge/latest/manifest.json`。其余 tracked path 逐文件执行三方选择：单侧变化取变化、双侧同结果取该值、双侧不同 fail-closed。实现不得调用 `git merge-tree`、rebase、force push 或 LLM merge。

候选 tree 由临时 index 组装，并验证 exact L1 union、完整注册 L2 以及全树无多余或缺失路径。divergence 候选使用固定 identity/message/date 的 `commit-tree -p H -p U`，保证相同输入产生相同 merge commit。

## 发布与恢复

所有 `gitCommit:true` writer/projector 与 join 的 ref/index/worktree mutation 共享 per-repo retained-directory OFD barrier，包括 `canonicalGitRuntime.enabled=false` 的 legacy commit 路径；进程内顺序固定为先 `gitSingleFlight`、后 OFD，持 OFD 时不得再等待同仓库 single-flight。Constraint compiler/verifier 的 LLM 阶段不持 OFD；专用 compiler lock 仍覆盖整轮，成功编译后只把确定性 L1/L2 落盘与 commit/CAS 阶段放入 OFD，并在首个 repo write 前重验编译前 HEAD 与 `inputRootHash`/input event set。首次部署该 barrier 后，所有已加载旧实现的 pi 实例必须重启。

非 noop join 的 fetch、tree 计算和 push 不持 OFD 锁；同 OID fast path 完全不进入 OFD 发布边界。发布进入锁后先恢复既有 device-join journal、恢复 canonical local-drain journal并排空合法 pending canonical 写入；如果 HEAD 已非 `H`，释放锁后重算。写 journal/CAS 前验证完整 `H -> M` delta 的每条 worktree path：普通 create 只接受 absent 或由完整 delta 证明可移除的合法目录，ignored 第三状态同样拒绝；唯一迁移例外是 reconciler-owned registered L2 的旧 untracked+ignored leaf，可在锁内先归一化为 exact H 前像，同时 candidate 必须删除旧 `l2/views/knowledge/latest/manifest.json` ignore 行。journal 绑定完整 tracked delta；CAS 后先按深度移除删除项以关闭 directory/file blockers，再物化 L1 create-only、注册 L2 全量重建结果和普通 tracked add/replace/mode update，最后让 shared index 收敛到 `M`。恢复只接受每条 journal path 为 exact `H` 前像或 exact `M` 后像，任何第三状态 fail-closed；只可删除名称绑定 journal M blob、类型/owner/link count及内容前缀验证通过的本协议 atomic temp，未知 dirty 仍 fail-closed。清 journal 前必须验证 `HEAD=M`、index `write-tree=M^{tree}`、全部 tracked worktree 类型/mode/bytes 与 `M` 一致，并专项验证 L1/L2。candidate 必须保留 `.state/` exclusion；noncanonical Git path、dirty directory replacement、不可物化 symlink target和 changed gitlink 均在 journal/CAS 前 typed fail-closed。

push 使用 exact commit OID 到 configured upstream destination。push rejection 触发有界 `fetch -> join -> exact-OID push` 加 jitter；startup、writer detached delivery 和 rejection retry 共用该路径。真实内容冲突保持 typed fail-closed，不升级为人工日常合并或 LLM 裁决。

## 验收

`npm run smoke:abrain-device-join` 覆盖 clean divergence、L2 manifest 重建、旧 ignored+不同 bytes manifest 首次迁移、普通 ignored create pre-CAS 拒绝、普通 tracked add/modify/delete/mode 与 directory/file transition、L1 修改/删除/同路径异 blob 拒绝、普通双侧冲突、`.state/` contract、gitlink pre-CAS rejection、journal 各崩溃点与 validated atomic temp 恢复、dirty unknown、跨进程 OFD 互斥、长编译不阻塞 writer、startup timeout 可重试、legacy writer 与 join 互斥、detached-context lease invalidation、CAS 各窗口 race 与有界 push retry。`npm run smoke:abrain-git-sync` 覆盖真实 bare remote 的 writer `fetch -> join -> exact-OID push`、behind fast-forward 与 divergence、同 tip 6000-file 仓库在 prepare/barrier fault injection 下的 typed fast noop 和 3s 上限、真实 canonical `session_start` 先 drain dirty L1/L2 backlog 再启动 autosync、constraint refresh event、network/timeout/rejection fail-soft 和禁用策略源码边界。
