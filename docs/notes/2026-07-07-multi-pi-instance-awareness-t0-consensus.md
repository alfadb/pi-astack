---
doc_type: notes
status: first-pass-implemented
---

# 多 pi 主实例防丢失/防回退首版 - 2026-07-07

## Scope

本 note 记录多 pi 主实例并行时的首版实现方案。主要目标不是让一个 pi session 完整知道其它 session 正在做什么，而是防止某个 session 基于旧上下文覆盖、删除、回退其它 session 已经落盘的修改。presence、heartbeat、peer 列表只作为辅助信号；写入前 stale-context guard 是主线。

实现落在 `pi-astack` extension/shared infra 内，不修改官方 pi 分发包。作用域以 `projectRoot` 为边界：优先复用现有 `projectRoot` resolver（git toplevel 优先，非 git 项目回到 `ctx.cwd` 解析路径）。运行态目录为 `<projectRoot>/.pi-astack/instances/`，该目录应 gitignored，presence IO 均按 best-effort/fail-degrade 处理；只有命中明确 stale-context 或高危回退风险时才阻断工具调用。

## Presence Storage

每个主 pi OS 进程持有一个单写者 manifest：`.pi-astack/instances/<instance_id>.json`。实例只写自己的文件，通过 temp+rename 做原子覆盖。manifest 是当前态真源；registry view 只能由目录扫描派生。可选 `events.jsonl` 只用于低频审计，不是真源，并且必须有硬上限或轮转策略。

不采用共享 read-modify-write registry，不采用共享 `state.json`，也不采用 SQLite/WAL 作为 presence 真源。`instance_id` 是 OS 进程级身份，使用 `globalThis[Symbol.for(...)]` 保持同一进程内稳定；`/new`、`/resume`、`/reload` 都不得把 `session_id` 当实例身份。PID 只能作为辅助字段，不得作为唯一身份。

## Manifest Schema

manifest 字段应包含：`schema_version`, `instance_id`, `pid`, `ppid?`, `device_id?`, `hostname?`, `project_root`, `session_id?`, `session_file?`, `session_epoch`, `model?`, `started_at`, `updated_at`, `heartbeat_at`, `heartbeat_seq`, `heartbeat_interval_ms`, `stale_after_ms`, `status`, `activity`, `current_tool?`, `target_paths[]`, `observed_files[]`, `recent_writes[]`, `held_locks[]`, `subtasks?`。

`status` 取值为 `active | idle | stale | suspended | exiting`。路径默认记录为 project-relative。manifest 不记录 prompt 原文、tool output、reasoning、secret 或完整命令输出。

## Session Identity And Epoch

`instance_id` 属于 OS 进程，`session_id` / `session_file` 属于当前 foreground session。`/new` 与同进程 `/resume` 复用 `instance_id`，但递增 `session_epoch`，清空 foreground `activity` / `target_paths`，并更新 `session_id` / `session_file`。`/reload` 不生成新 `instance_id`，也不得重复启动 heartbeat timer。

`session_epoch` 用于防止旧 session 的延迟回调覆盖新 foreground session 的 manifest/activity。`/resume` 跨 `projectRoot` 时，旧项目 manifest 尽量写 `exiting` 后 unlink，新项目用同一 `instance_id` 写新 manifest；如果未来存在后台 lease，可保留后台状态到 lease 释放。

## Heartbeat

实例级 wall-clock timer 从 `session_start` 启动，在 `session_shutdown` 停止。默认参数为 `interval=15s`，`stale_after=45s`，即三次 miss 后视为 stale，参数可配置。心跳更新 manifest 的 `heartbeat_at` / `updated_at`，并递增 `heartbeat_seq`。

可以复用现有 heartbeat 的模式、常量和测试思想，但 dispatch per-task heartbeat 路径不能被当作实例 presence 真源。presence IO 失败不阻断普通任务；guard 判定需要在缺失 presence 时退化为本地文件指纹检查。

## Ctrl+Z And Liveness

活性判断必须区分 PID 与 heartbeat。PID alive 但 heartbeat stale 时，应明确展示为 `suspended` 或 `stale`，不能因为 PID 仍存在就误判为 `active`。PID liveness 必须限定在 device/host 作用域内，避免跨主机 PID 复用造成误判。

PID dead 或 clean shutdown 后遗留的 manifest 可以清理。PID alive + stale 时，默认不自动 kill、不自动 SIGCONT，也不自动偷用户或外部资源锁。`session_shutdown` 应尽量写入 `exiting`/tombstone 后 unlink；崩溃场景走 stale 清理。

manifest GC 必须复核 heartbeat、PID、device 和 mtime，只能 unlink 其他实例的文件，不能改写别人的 manifest。

## Write-Before Guard Mainline

首版主线是工具写入前 guard，而不是全项目互斥。实例记录本 session epoch 中观察过的文件指纹：普通文件使用 `stat` 的 `mtimeMs`、`size` 和 `sha1`；缺失、目录和其它类型也保留结构化状态。`read` / `grep` / `find` / `ls` 等读路径进入 `observed_files`，成功 `edit` / `write` / 可识别写入命令更新本实例 `recent_writes` 与已知写入指纹。

在 `edit` / `write` / `rm` / `mv` / 可识别 bash 写入前，如果目标文件当前指纹不同于本实例观察指纹，且不是本实例已知写入造成，则判为 stale-context 风险并阻断。`edit` 的 exact `oldText` 仍是重要保护，但不能替代 stale-context 可见性；如果 peer 正在 target/observed/recent-write 同一路径，普通 `edit`、批量 edit 与大范围 edit 首版走显式告警，whole-file `write`、`rm` / `mv` 走阻断。

whole-file `write`、批量替换、删除/移动、以及会修改 worktree 或 index 的危险 git 命令属于高风险面。`git reset`、`checkout`、`restore`、`clean`、`rebase`、`merge`、`switch` 等命令默认阻断，提示先读取当前状态或取得用户显式确认，优先防止回退其它 session 已落盘修改。

## Locks And Reclaim

presence 本身不替代现有模块内部锁。新增或整合 per-resource lease 只用于窄域强制互斥；锁真源是 per-resource 文件，manifest 的 `held_locks[]` 只是展示镜像。锁记录应包含 `owner_instance_id`, `token`, `resource`, `class`, `acquired_at`, `renewed_at`, `fence_epoch?`。

首版预留基础 per-resource lease helper，目标资源类别限定为 `git`、`session`、`.pi-astack` 内部状态等静默损坏面。普通工作树 `edit` / `write` 默认不走强锁，避免把可并行文件任务全局串行化。

没有 fencing 或 commit-time token recheck 的锁，不得在 PID alive + stale 时自动回收。如果内部锁实现了 fencing，且资源可重试或幂等，可以在较长 `reclaim_after` 后回收并写审计；否则需要用户显式 override。PID dead 的 stale lock 可以按 token 校验回收。

cross-process git/session lease 是新增职责，不能误以为现有 git-singleflight 已覆盖该问题。

## Hard Mutual Exclusion Boundary

硬阻断只覆盖并发写会造成静默损坏或全局状态破坏的资源：git index/ref/branch critical section；同一个 pi `session_file` 的写入、compaction、fork、name 等 session mutation；`.pi-astack` 内部非 append-only 状态、索引重建、约束编译、记忆索引等。

用户工作树普通 edit/write、普通读、独立文件任务、未知 bash 默认采用 advisory/confirm，不做全项目串行。同文件编辑冲突必须可见并提示，但默认不是不可绕过的硬锁。

## Activity Privacy

默认只保存结构化 activity、tool、path、held_locks、model、time，不保存 prompt 摘要。可配置 opt-in 保存 redacted 且 hard-truncated 的 prompt label，长度上限为 80-200 字符。redaction 只是防御措施，不作为安全边界。

## User Visible Surface

footer/status 显示 peer 数、active/idle/stale/suspended 状态和 guard risk 数。notify 用于 stale-context 阻断、危险 git 阻断和 peer activity 告警。首版提供 `/peers` 命令列出实例、session、activity、target paths 和近期风险；如果 command API 不可用，footer 与 notify/console 仍应 fail-degrade。单实例常态保持低噪声。

## Model Visible Surface

`before_agent_start` 每轮读取 peers 和近期 guard risk。只有存在 peer、stale/suspended、lock、conflict 或 stale-context risk 时，才注入短的 volatile runtime block。注入使用 volatile suffix，避免写入持久 session 历史，也避免破坏稳定 prompt 前缀。

注入内容不包含 prompt 原文、tool output 或 reasoning，并说明这是当前环境快照，不是覆盖用户指令。block 必须明确强调主目标是避免覆盖、删除、回退其它 session 已落盘修改；它是运行态 guard 提示，不是 memory/sediment 真源。volatile block 需要长度上限和轻量 redaction。

## Sub-Agent Boundary

dispatch v3 in-process sub-agent 不注册为 peer，只作为父主实例的 `subtasks` 或 `activity` 呈现。只有不同主 pi OS 进程才是 peer。

## Non-Goals

本方案明确不做 daemon/socket/网络协调，不自动 kill peer，不做全项目串行，不做跨机器同步，不默认生成 LLM prompt 摘要，不把 registry 当作 memory 或 sediment 真源，不用裸 PID 作为唯一身份，不使用共享 RMW `state.json`。

## Implementation Notes

`projectRoot` resolver 必须和现有 pi-astack 模块保持一致。symlink/realpath 差异不能让 presence 路径与 sediment/dispatch 路径分裂。

`events.jsonl` 如实现，必须有硬上限或轮转，避免长期运行导致无界增长。

实现时应优先保证 fail-degrade：presence 读写失败不能阻断普通任务，只有命中明确硬互斥资源并确认冲突时才进入阻断或用户确认路径。

## Verification Expectations

首版 smoke 应至少覆盖 instance_id/session_epoch、manifest 单写者原子更新、目录扫描派生 registry view、heartbeat stale 判定、PID alive + stale 展示、sub-agent 不注册 peer、文件指纹 stale-context guard、whole-file write 高风险阻断、危险 git 命令识别、peer activity 告警、volatile block 文本格式。后续增强再覆盖 PID dead GC、manifest GC 不改写他人文件、per-resource token 校验、volatile block 不持久化集成验证，以及 hard mutual exclusion 边界的更多正反例。
