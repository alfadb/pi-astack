---
doc_type: plan
status: active
created: 2026-07-10
updated: 2026-07-11
---

# pi-astack canonical-path convergence R3.4.2 全阶段 Living Plan

**状态：Active；当前阶段：P1 authorized / in progress。**

本计划的决策基线是 2026-07-10 经 Fable、OpenAI、DeepSeek、Kimi、MiniMax、GLM 六个独立供应商七轮审查后全票 `ACCEPT` 的 **R3.4.2 累积规范**，即 R3.3、R3.3.1、R3.4、R3.4.1、R3.4.2 的合订状态。会话转写稿只保留决策来源和讨论脉络，不是唯一执行权威；每次实施和验收必须同时核对 [ADR 0039](../adr/0039-constraint-pipeline-reset.md)、[transition register](../transition-register.md)、[current state](../current-state.md)、[roadmap](../roadmap.md)、[2026-07-10 完整审计](/home/worker/.pi/.pi-astack/reports/pi-astack-full-audit-2026-07-10.md)、当前代码、live settings、实际文件和 Git 状态。文档与现场冲突时，按下文 Replanning Protocol 处理，不得用旧转写覆盖现场证据。

## Stable Goal

结束 pi-astack 长期混合迁移态并收敛到唯一 canonical path：Git L1 内容寻址事件是唯一语义 truth；runtime 不直接读 L1，只读经过 schema/role/hash 校验且以 atomic Git publication 发布的 L2 bundle；`.state`、SQLite、embedding、ledger 和其它 L3 仅为可丢弃、可重建的 cache/index，不承担语义、授权或恢复 truth。Knowledge 与 Constraint 的生产读写、恢复、同步、归档和治理记录最终都必须与这一分层一致。

## Frozen Constraints

- Knowledge 当前 `projection_only` 不回滚；P1 不新增 truth cutover 或 read flip。
- Constraint runtime 只允许在独立授权的 P3 从当前 `.state` compiled view flip 到 validated atomic Git L2；P1/P2 不得提前改变该读取源。
- 不引入跨实例 presence、lease、leader election、second ref 或其它隐性协调权威。
- 禁止 `git reset --hard`、force checkout、启发式 owner 判断、破坏 worktree 的恢复和对已发布 commit 的破坏性回滚。
- synthetic fixture 可用于开发测试，但不计入 production acceptance；禁止 synthetic acceptance、伪造 production provenance 或用模型自述替代外部证据。
- 不物理删除 legacy 内容；P4a 只允许 inventory、snapshot、move/archive 和可验证 restore。
- `.state` 不得承载 claim、slot、decision、episode、recovery、authorization 或 canonical truth；恢复权威必须是注册并校验过的耐久 L1 metadata 与 Git/remote 外部状态。
- 不使用 heuristic ownership；cohort ownership、schema role、路径和 producer 必须由 machine-readable registry 与确定性规则证明。
- P2、P3、P4a、P4b 各自都需要新的六供应商或同等独立 multi-T0 unanimous 授权；上一阶段完成不自动授权下一阶段，P2 与 P3 的授权也互不替代。

## Current State

> 本节是 living plan 的可重写热区。每次阶段切换、发现现场冲突或形成新阻塞时整节更新；不要在此冻结会快速过期的运行数量。

- 当前阶段：P1 in progress / P1-A blocked；S3、S4、P1-S1-GIT 与 P1-B 已完成，R3.4.2 仍只直接授权 P1 的实现和真实取证，不授权 P2/P3/P4a/P4b 执行。
- 2026-07-11 production 事件 supersede 旧 preflight 快照：当前 HEAD `7cee20851b1daf98550209213d0afd69535f2693`，origin/main `10bfaf359486a7d6e39179f2dd1b0dd2a00d7cca`，ahead 4/behind 0。legacy push episode `352f3b248001958d4ea61e355ffb8315883b7154210281bd48e0179b3e601c88` 的 intent event 为 `bd65fa3fbca74822374fc67afd725c2667e0878e0e3e0253905dbddcc23c80af`、terminal event 为 `43821737b55b2568744e6e539a3e93aa7ac9dd874e8aa663932ab57a3a1a22d9`、target=该 HEAD；五个 outcome 被记录为 retryable 后 terminal，实际 push 未尝试。
- 根因不是普通网络重试耗尽：v1 episode 未绑定 credential-free endpoint/policy，clean Git transport 隔离了 production helper，pre-transport credential/config 失败又被宽泛归为 retryable；同时缺少 owner-only terminal closure，导致 immutable terminal 永久全局阻断 startup。
- 两位独立 T0 第五轮一致 `ACCEPT`，后续 T0 补充审查也一致通过；修订已实现为 disabled candidate：remote scope/push intent/outcome v2、固定 transport policy、process-local credential broker、stable object-only remote proof、per-public-cycle transport lifecycle、显式 legacy terminal candidate/attestation resolver、same-scope fresh-live resolution 与首次 unlock drain。v1 仅保留读取和受保护 fixture writer；production writer 只生成 v2。
- credential helper 原文只在 broker 父进程内存与每次调用的匿名 fd3 script pipe 中短暂存在；临时目录/config 固定 0700/0600，config 只注册 fixed adapter+socket capability+helper index。Git 自身执行 ordered get/stop/quit 与 store/erase；remote transport 使用 literal endpoint、禁 prompt/rewrite/redirect、scrub inherited `GIT_*`，proof 固定 `tip_before == fetched_oid == tip_after` 后再做 ancestry。
- production settings 已按真实 Git urlmatch 事实固定完整 credential lattice：unscoped 0、host scope provenance `25359d035fecbf5c3f669616500f4491eb3e55089ad84e84b5d9795e79e1f44f` 内 ordered reset+shell、path-prefix 0、exact-repo 0、include 0、effective helper 1；credential resolution fingerprint 为 `3383decbb77e63abab2f97931ef6f22b96693051d921a90b698e9c0bf4c7ddd1`，transport policy id 为 `4c29c864bda62aa9d980a1d4aed9027752baeb4f57a4d50779a8e97b6b92370b`。production 只读 helper/policy preflight 已通过且不再有 `COUNT_MISMATCH`；`canonicalGitRuntime.enabled=false` 保持不变。
- 新增 smoke 已覆盖 broker get/store/erase/order/quit、四层 scope/count/include/order/reset/kind/hash drift、endpoint protocol/host/path binding、Git helper 实际单-LF wire shape、percent path 一次处理、hooks/TLS override fail-closed、sentinel 隔离、v1/v2 envelope、严格 `transport_attempted`、stable proof 不改 FETCH_HEAD/ref/index/worktree、candidate/attestation/fresh-proof 三条件、same-scope target 变化仍阻断，以及 startup 关闭后 steady-state 新 cycle 真 push成功。全部临时仓库测试不计 production acceptance。
- 当前实现轮次没有执行任何 `/home/worker/.abrain` mutation，没有运行 production resolver、fetch 或 push；P1-A 三项 criterion 与 P1-S2-RECOVERY 仍保持未勾选。

## Phase Table

| Phase | 状态 | 当前授权 | 前置 | 退出证据 | 下一授权 |
|---|---|---|---|---|---|
| P1 | authorized / in progress（S3/S4/S1/P1-B 完成；S2 partial evidence；P1-A next） | R3.4.2 直接授权实现与取证 | 执行前现场刷新；S3 写前门先行 | P1-S3/S1/S2/S4、P1-B、P1-A 全部有真实外部证据；完成记录落盘 | P2 与 P3 分别发起新的独立 unanimous multi-T0 gate；可在 P1 后并行 |
| P2 | blocked / not authorized | 无 | P1 完成；P2 新 T0 全票 | 全量 production byte equality；至少 3 条完整链且至少 1 条 live；冲突覆盖 | P4a 仍不得开始，等待 P3 也完成并另行授权 |
| P3 | blocked / not authorized | 无 | P1 完成；P3 新 T0 全票；可与 P2 并行 | genesis 0-delta；K=5 真实 delta/replay；连续 7 个日历日每日 1 次 zero-drift verifier | P4a 仍不得开始，等待 P2 也完成并另行授权 |
| P4a | blocked / not authorized | 无 | P2 与 P3 都完成；P4a 新 T0 全票 | live inventory、registry export、content-addressed snapshot+manifest、restore byte verify；只移不删 | 独立发起 P4b unanimous multi-T0 gate |
| P4b | blocked / not authorized | 无 | P4a 完成；P4b 新 T0 全票 | 固定 14 日观察窗及全部事件门；zero drift；canonical register partition 清零 | 满足“全部完成”定义后结束本计划 |

## Acceptance Criteria

### Evidence Discipline

下面每一行都使用 goal parser 的真实格式 `- [ ] (criterion-id) text`。ID 是稳定证据主键；不得复用或改名。只有外部证据已经存在并且与当前 criterion 文本匹配时，才允许用普通 edit 把 `[ ]` 改成 `[x]`，随后用 `goal_check` 记录验证；裸 `[x]`、模型自述或旧 goal 的 evidence 都不算 verified。`goal_check` 的 evidence 必须是 `cmd:<shell>`、`file:<path>` 或 `git:<sha>`；`cmd:` 记录真实执行结果，`file:`/`git:` 只证明对应工件或 Git object 的可验证事实。复合 production 条件优先固化为不可变 dossier、content-addressed manifest 或包含 dossier 的 Git commit，再由 `file:`/`git:` 指向；不得把多条未经固化的聊天描述拼成通过证据。criterion 文本或声明输入发生语义漂移会令既有 evidence stale，必须重新检查。所有项目初始未完成。

- [x] (P1-S3-REGISTRY) 中央 machine-readable schema-role registry 已成为新 schema 的写前门；所有 whole-L1 scanners 在任何 L2 输出前统一验证 RFC8785/JCS SHA-256 envelope、内容寻址路径、文件名/body hash、schema role 与 producer；unknown/invalid fail closed；machine transition-register source 已被 startup 与 smoke 消费。
- [x] (P1-S1-GIT) Git 提交原语使用临时 `GIT_INDEX_FILE`、`write-tree`、exact `diff-tree`/blob 校验、`commit-tree` 与 `update-ref <ref> <candidate> <frozen>` CAS；发布后 exact-cohort shared-index 幂等收敛到 current HEAD，并证明 worktree 与 non-cohort staged entries 保持不变，owned-path index conflict fail closed。
- [ ] (P1-S2-RECOVERY) attempt/drain/push 使用 byte-deterministic atomic no-replace claim；curator slot 固定 1..3，drain/push stable episode 固定 1..5 且不因 refreeze、重启或新事件重置；`commit_prepared`、`commit_published`、`index_converged` 状态完整，并通过 restart、missing/late result、CAS/remote-contained reconcile、预算耗尽 terminal alert 验证。
- [x] (P1-S4-SHADOW) Knowledge 新链在 isolated shadow namespace 产生 E1 candidate、attempt claim、E2 decision、E3 apply/receipt，Constraint genesis 只锚定既有 committed projection/validated decision且不重跑历史 LLM；可复算 dossier 覆盖 provenance/input/output hashes，并证明 canonical read、fold、ref 与 push zero impact。
- [x] (P1-B-TRACE) 带 provenance 的真实 production trace 已在隔离环境 replay，覆盖 claim race、prepared/published/index crash windows、CAS 与 unrelated/descendant ref drift、owned index conflict、push retry 与 remote-contained、symlink/path escape、hash/envelope mismatch、unknown schema/role，且证明 zero canonical mutation；纯 synthetic fixture 不计入本项。
- [ ] (P1-A-DRAIN-CURRENT) 第一笔真实 production drain 已处理执行时现场积压，push/reconcile gate 为 green、upstream `ahead=0`，exact cohort、published commit、index convergence、remote containment 与无 worktree/non-cohort stage 损失均固化在不可变 production dossier。
- [ ] (P1-A-DRAIN-NEXT) 第一笔 drain 后由一次后续真实 sediment write 触发第二笔 production drain，并再次自动 commit、index converge、push 到 clean 与 `ahead=0`；不得用人工构造事件或重复第一笔 cohort 替代。
- [ ] (P1-A-RUNTIME) P1 真实生产验收跨过一次真实进程 restart，完成 shadow-write→canonical push 不阻塞证明，并以 production Constraint genesis dossier 证明 0-delta；恢复 episode、slot 预算和 canonical cleanliness 在重启前后连续。
- [ ] (P1-CLOSE-GATE) P1 completion record 已引用全部 S3/S1/S2/S4/A/B 不可变证据并记录残余风险；P2 与 P3 均保持未执行，且分别创建“需新六供应商或同等独立 multi-T0 unanimous 授权”的 machine transition gate。
- [ ] (P2-AUTH) P2 的候选 diff、P1 completion dossier、rollback/stop 条件与 production 取证方案已获新的六供应商或同等独立 multi-T0 unanimous 授权；该授权明确只覆盖 Knowledge fold-input truth cutover，不授权 P3/P4。
- [ ] (P2-BYTE-EQUALITY) P2 对完整 production baseline 与 shadow accepted-decision fold 执行全量重投影并达到 byte-for-byte equality；输入集合、renderer/template 版本、bundle hash、差异命令与 zero-diff 结果固化为不可变 dossier。
- [ ] (P2-CHAINS-CONFLICT) P2 已验证至少 3 条 `candidate→attempt→decision→apply→receipt` 完整 canonical 链，其中至少 1 条为授权后真实 live production 链，并覆盖 accept/reject/conflict 或等价冲突处置，证明只有 accepted decision 成为新的 canonical fold input。
- [ ] (P3-AUTH) P3 的 read-source diff、genesis 与 P1 dossier、fail-closed/rollback 条件、七日观测方案已获新的六供应商或同等独立 multi-T0 unanimous 授权；该授权明确只覆盖 Constraint validated Git L2 read flip，不授权 P4。
- [ ] (P3-DELTA-DRIFT) P3 已证明 genesis 0-delta，完成 K=5 个带 provenance 的真实 Constraint delta 或真实 production trace replay，并在连续 7 个日历日各运行至少 1 次 verifier、共 7 次均为 bundle/hash/read zero drift；事件门和七日日历门同时满足。
- [ ] (P4A-AUTH) P4a 的 live inventory、保留/移动映射、restore runbook、失败停止条件与不删除声明已获新的六供应商或同等独立 multi-T0 unanimous 授权；证据明确 P2/P3 均已完成，且不授权 P4b。
- [ ] (P4A-ARCHIVE) P4a 已从 live inventory 与 registry export 生成 content-addressed snapshot+manifest，执行 archive move 后逐字节 restore verification 成功；所有 legacy 内容只移动/归档、不物理删除，canonical runtime 与 Git L1/L2 bundle 不依赖 archive 位置。
- [ ] (P4B-AUTH) P4b completion observation/declaration 已在 P4a 后获得新的六供应商或同等独立 multi-T0 unanimous 授权；授权冻结 14 日窗口与事件门，禁止用延长 soak、额外 synthetic run 或上一阶段票据替代任何门。
- [ ] (P4B-SOAK-QUERIES) P4b 已完成固定 14 个日历日观察窗、累计至少 15 次 verifier、至少 5 次 production `memory_search` 和至少 20 条真实 query replay，所有结果均指向同一 validated Git L2 canonical bundle 且 zero drift；14 日不得压缩，延长也不得替代事件数量。
- [ ] (P4B-RUNTIME-RESTORE) P4b 已验证至少 3 条 canonical 完整链且至少 1 条 live、至少 3 次真实 `session_start` 注入的 content hash 等于对应 bundle hash，并完成真实 delta、真实 restart、P4a archive restore 后再验证，所有 read/fold/reconcile/push 仍 zero drift。
- [ ] (ALL-DONE-CONVERGED) P4b 独立授权后的全部日历门与事件门均已通过，transition register 的 canonical-path partition 清零，且 `docs/current-state.md`、`docs/roadmap.md`、`docs/transition-register.md` 与实际文件、live settings、runtime read sources、Git refs/index/worktree/remote 状态一致；最终 completion dossier 可由命令、文件和 Git object 独立复核。

## Execution Order (Current P1)

1. **现场刷新**：只读采集 HEAD/ahead/status/settings/read-source/reconcile/transition machine source，建立 P1 execution dossier 的 provenance 基线；发现与计划冲突时先执行 Replanning Protocol。
2. **S3 写前门**：先实现 central schema-role registry、schema 注册纪律、所有 whole-L1 scanner 的统一先验验证，以及 machine-readable transition-register consumer；任何新恢复/shadow schema 在此前不得写入。
3. **S1 + S2**：在 S3 约束下实现 temporary-index commit/CAS/index-convergence 原语和 deterministic claim/curator/drain/push recovery state machine；两者共享状态契约，可并行开发但必须一起验证 crash 边界。
4. **S4 shadow**：实现 isolated Knowledge E1/attempt/E2/E3 链、Constraint genesis 和 reproducible dossier，保持 canonical zero impact。
5. **Unit/smoke**：覆盖纯函数、schema、Git plumbing、restart 和 fail-closed 分支；测试可以与实现并行开发，但只作为开发证据，不替代 P1-A/P1-B acceptance。
6. **P1-B 真实 trace replay**：使用带 provenance 的 production trace 在隔离 namespace/repo 回放故障矩阵并证明 zero canonical mutation；synthetic 只可补充覆盖。
7. **P1-A 真实 production drain**：最后执行两笔真实 drain、真实 restart、shadow-write→push 与 genesis 0-delta，固化不可变 dossier；未先通过 B 不进入 A。
8. **P1 close**：完成记录落盘后停止执行，分别请求 P2/P3 新 T0 授权；goal 不得自动越过授权门。

## Current Blockers

- P1-A 当前被 production legacy terminal 明确阻断。唯一允许的 closure 是 owner 显式调用 resolver，并逐项传入 exact legacy episode/intent/terminal IDs；禁止 `--all`、自动扫描、通配或把 IDs 硬编码进实现。resolver 必须先写 deterministic candidate，再经 broker push/prove 旧 target，最后写 attestation；candidate/attestation 本身不授权，startup 每次仍须 fresh live proof。
- production credential helper 漂移阻塞已由 corrected lattice 取代：只读 policy/helper preflight 对 unscoped→host→path-prefix→exact-repo、include count、reset/shell order、effective chain、fingerprint 全部通过且无 `COUNT_MISMATCH`。该结果只消除 helper blocker，不解决 legacy terminal，也不构成 production acceptance。
- production HEAD `7cee20851b1daf98550209213d0afd69535f2693` 仍 ahead origin/main 4。即使旧 target 已 equal/descendant resolved，也不能据此宣称 green；首次 unlock drain 后必须形成新 v2 push，并以 advertised OID=current target、ahead/behind=0/0 收口。
- `canonicalGitRuntime.enabled=false` 必须保持，直到 disabled candidate 被提交/外锚、显式 resolver 的 production runbook 经 owner 授权执行、真实 restart/drain/push dossier 全绿。本轮只读 preflight、smoke、旧 disabled manifest 和任何 candidate-only/attestation-only 状态都不满足 P1-A criterion。
- P2、P3、P4a、P4b 均受新的独立 unanimous multi-T0 授权阻塞；准备设计、只读核验和测试脚手架不得被描述成已获执行授权。
- P3 连续 7 日与 P4b 固定 14 日是不可压缩的真实日历门；等待更久不能替代规定的 verifier、query、chain、session_start、delta、restart、restore 等事件门，增加事件也不能缩短日历门。

## Replanning Protocol

现场证据、代码、settings、Git 或 production 状态与本计划冲突时，先停止受影响执行，整节更新 Current State，并在 Decision Log 追加日期、冲突证据、影响范围、采用的新路径和授权是否仍有效，再继续工作。Decision Log 只追加、不删除、不重写历史；错误决定通过后续条目 supersede。任何 criterion 文本的语义修改都会使匹配 evidence stale，修改前必须说明原因，修改后必须重新 `goal_check`。不得为让 goal 变绿而拆小、放宽、改名、删除或重新解释 acceptance gate；若门确需改变，必须走与原阶段相同或更强的独立 multi-T0 授权并保留旧文本与裁决记录。

## Decision Log

- 2026-07-10：六个独立供应商经过七轮交叉审查，对 R3.4.2 累积规范全票 `ACCEPT`，并一致认为在 frozen constraints 下不存在严格更优方案；该票只直接授权 P1，实现完成与 production acceptance 仍需本计划所列外部证据。
- 2026-07-10：采用 living plan + `goal_set(doc=...)`，因为任务跨阶段、跨重启并包含 7/14 日真实时间门；本文保存稳定目标、可重写 Current State、外证 acceptance criteria 与 append-only Decision Log，goal evidence ledger 保存独立执行证据，二者不得合并为模型自证。
- 2026-07-10：P1 可直接从现场刷新和 S3 写前门开始，无需重复授权；P1 不包含新的 truth/read flip，Knowledge `projection_only` 与 Constraint 当前 read source 在 P1 保持不变。
- 2026-07-10：P2、P3、P4a、P4b 各需新的六供应商或同等独立 multi-T0 unanimous 授权；P1 通过不自动授权 P2/P3，P2/P3 通过不自动授权 P4a，P4a 通过不自动授权 P4b。
- 2026-07-10：因模型供应商配额限制，S3 实现由主会话直接接手完成（子代理中断前的产出经逐文件审查后保留并修复）。关键实现裁决：① JCS 抽取为共享实现且与旧实现字节级等价，真实生产 4051 事件全量 hash 复算零失败证明无回归；② durable-write 崩溃残留 temp 文件（`.{event}.json.{pid}.{ts}.{hex}.tmp`）识别为非事件残留并计数上报，其余不合规名称仍硬失败，避免合法协议残留卡死全部投影；③ constraint body 语义层问题（payload 细节）保留既有 invalid/diagnostic/coverage 机制，registry 层只硬失败 envelope/hash/path/role/producer 违规；④ 三个旧语义测试 fixture（merge-selfheal 毒药事件、shadow-compiler NS-2、repo-preflight 种子）改写为新 fail-closed 语义下的等价验证。提交 `e4124e6` 已推送 main 并同步更新 pi-global submodule 指针（`2d765ba`）；用户未提交的 dispatch/model-curator/llm-audit 改动保持不动。
- 2026-07-10：执行前真实生产 baseline dossier 确认 P1 现场为 red：pi-astack 现存工作树改动须保留，`~/.abrain` 仍 ahead 且 push gate blocked，Knowledge 保持 `projection_only`、Constraint 保持 `.state` fail-closed read，并且 central schema-role registry 与 machine transition-register source/register 尚不存在；因此 S3 foundation 是 P1 的首要依赖，任何 recovery 或 shadow schema 写入均须在其后。
- 2026-07-11：S1/S2 采用“GPT 实现 + 主会话审查 + Claude 独立审查 + GPT 修复 + Claude 最终复核”的闭环。首版 S2 将 recovery truth 写入自定义目录且 claim 含 owner identity，主会话拒绝该设计并要求全部状态进入标准 content-addressed L1 envelope、claim bytes 仅由 episode/lane/slot 决定。Claude 首轮进一步发现并发恢复会写出不同 authoritative result 从而永久毒化 fold、pending slot 可被跳过、drain episode 绑定 cohort root 会重置预算、unmerged index 可被覆盖、transient Git 错误会烧 slot；修复后 authoritative published/converged/abort/terminal body byte-stable，next-slot 阻止 pending，episode generation 由 genesis/previous closure 驱动，index 全路径预检后单锁批量更新。Claude 最终复核无 blocker，并识别 late abort 与 merge-base 非 1 错误两个窄窗口；二者随后修复，综合 smoke 增至 22/22。由于测试使用 synthetic temporary repositories，S1/S2 仅记为 P1-B 候选，不勾选 production acceptance criteria。
- 2026-07-11：S4 production shadow 取证期间两次并发 production 写入使首批 dossier 按设计正确失败；稳定窗口最终 report exact SHA-256 为 `0e96b67150a6a57315a600726301565a0461d7ac29ecb211d131efd8e9122ca6`，manifest SHA-256 为 `fa884...`。外证证明 Knowledge E1/attempt/E2/E3、Constraint committed genesis rerender byte-equal、8 个 impact flags 全 false、phase leak 0，Claude 最终复核确认可勾选 P1-S4-SHADOW；该裁决只计 S4，明确不计 P1-B。
- 2026-07-11：P1-B 多轮审查依次修复 source 回读、dossier shape validator、worker Git environment fail-closed、durable stderr 与 cache drift 语义；v4/v5 分别因 production/cache 并发漂移按设计 fail closed，v6/v7 在稳定窗口通过，`.state` 普通 cache 仅作 diagnostic 且不阻塞 acceptance，但 Constraint canonical read hash 仍是硬门；v7（report exact SHA-256 `0a692f5cfbc65b718b4791fdcc967ca9a637b4ec585b0c68c9c804c5c2c45f56`）是唯一权威 final，外证只计 P1-B 与其覆盖完整的 P1-S1-GIT，P1-S2-RECOVERY 仍等待 P1-A 补齐 curator 1..3 production evidence。
- 2026-07-11：重启后预检 supersede“下一步直接 controlled drains”：S1/S2 仅有 helper+harness 且未接 runtime，sediment 仍执行旧 `git add`/`git commit`/`pushAsync`，startup 无 recovery；production HEAD `a58a12a` ahead 3、staged 0、tracked L2 19、untracked L1 272 加 L2 58且持续变化，production recovery/curator/genesis events 均为 0；自 2026-07-09 存在的 0-byte `index.lock` 不得清理；默认 C-quoted porcelain 使 reconcile gate 漏掉 13 个非 ASCII L2 路径。裁决为先实现唯一 orchestrator、startup recovery、结构化 `-z` gate 与 P1-A dossier，真实重启后再由 runtime 自动 drain；不得手工调用 helper 冒充自动 drain。该调整不修改任何 criterion、checkbox 或 Phase 授权。
- 2026-07-11：上述 disabled candidate 已完成并经过四轮审查；收尾修复 artifact verifier 的 exact cohortPaths 绑定、所有 P1-A evidence 的显式 UTF-16 code-unit 排序及跨 locale 非 ASCII 覆盖，并将 convergence-recovery/git-exact-cohort Git stderr locale 固定为 C，同时保留 `GIT_*` scrub。相关 recovery 24/24、canonical runtime、foundation 18、git-sync 40、reconcile、constraint full 9/9、production-trace harness 8/8、audit/dispatch/memory/registry/diff smoke 全绿。
- 2026-07-11：真实 production 只读 preflight 未带 `--execute`，report `/tmp/p1a-preflight-commit-candidate.json` exact SHA-256 为 `58b1cebc7d92bd9f812903d75c931a43cade487046744f29f4e4e53f72c46b6d`、764024 bytes、implementation fingerprint `f67f81c1dc9fd3d64fd576b4d625d0e00db4ef358d04f0a6f3883de50f666297`；ownership accepted 375/375、remote stable、mutation false，blockers 精确为 kill switch disabled、index lock file、execute not requested。仓库 manifest 仅声明 `P1-A preflight only`/`non_acceptance=true`，不勾 criterion；裁决为 owner 处理 lock 后重跑 preflight，再 commit/push、启用 settings、真实重启并 execute。
- 2026-07-11：production 后续事件 supersede 上述 release sequence：HEAD 已到 `7cee2085` 且 ahead 4；legacy push episode 连续写出五个 retryable outcome 后 terminal，但 transport 从未尝试。根因定为 remote scope/transport policy 未入 identity、clean config 隔离 credential helper、pretransport 失败误分类及缺少 terminal owner closure；旧 terminal 不得删除、改写或由“remote descendant”自动抹平。
- 2026-07-11：两位独立 T0 第五轮对 P1-A 修订一致 `ACCEPT`。采用 remote scope v2 + deterministic push_outcome v2、exact-endpoint helper hash policy、内存 broker/fixed adapter、stable object-only proof、显式 candidate/attestation resolver 与 current-scope fresh-live unlock；v1 只读，不允许 production 新写。resolver CLI 必须传三个 exact IDs，事件继续使用 standard recovery envelope/registry，不创建额外 truth 文件。
- 2026-07-11：实施期只读 global config 采集仅落 helper 哈希，发现 exact endpoint lookup 与批准的三项 expected chain 漂移；裁决为 runtime fail closed 并保持 `canonicalGitRuntime.enabled=false`，不以 host scope、raw helper temp config 或宽泛 retry 降级。本轮只运行临时仓库 smoke 与 registry/runtime 回归，未执行任何 `.abrain` mutation，P1-A 仍未通过且所有 acceptance checkbox 保持原状。
- 2026-07-11：后续硬事实 supersede 上条的 helper 解释：Git 对当前 literal endpoint 的完整匹配为 unscoped 0 → host reset+shell → path-prefix 0 → exact-repo 0，effective helper 恰为 1；其它 host helper 不参与。实现改为每 session 从 include-expanded global config 结构化重算 lattice，并将 canonical endpoint context 与完整 resolution JCS fingerprint 纳入 policy 根。production exact-ID + policy/helper `--preflight` 返回 `preflight-valid`/`mutation=false` 且无 `COUNT_MISMATCH`；T0 补充审查一致通过。legacy terminal 仍 unresolved、resolver execute 未运行、runtime 仍 disabled，所有 P1-A/P1-S2 验收项保持未勾选。

## Definition of Fully Complete

“全部完成”只在 **P4b 已获得独立 unanimous multi-T0 授权后**成立：P4b 固定 14 日门及全部事件门均通过并有非 stale 外部证据；transition register 的 canonical-path partition 已清零；`docs/current-state.md`、`docs/roadmap.md`、`docs/transition-register.md` 与实际文件、live settings、runtime read source、Git HEAD/ref/index/worktree/upstream 状态完成收敛；L1 唯一 truth、validated atomic Git L2 唯一 runtime canonical read、L3/`.state` 仅 cache 的目标可由最终 dossier 独立复核。任何一项未满足，本计划仍为 active 或 blocked，不得宣告完成。
