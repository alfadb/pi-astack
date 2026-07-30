---
doc_type: adr
status: accepted
date: 2026-07-30
---

# ADR 0046 — Daemon-Owned Canonical Convergence（DCC）

- **Status**: Accepted target / in progress（2026-07-30，用户确认目标合同；**D0 完成**；**D1 Linux local implemented**（POSIX `0700`/`0600` attestation writer/verifier + kick/observe）；**Windows DCC attestation native current-primary-TokenUser protected-DACL writer/verifier pending** — 当前切片 **fail-closed**（control `unavailable` / `attestation_unavailable`；不静默依赖 inherited/default ACL）；**production acceptance pending**；**D2 implemented locally / production pending**；**D3/D4 locally implemented / production pending**（foreground cutover + bind continuation + sync v1 explicit fail-closed；**未**生产验收；criteria **不**宣称生产通过）；**D5 local six-condition observation/tests implemented / production pending**（TUI/foreground strict read-only six-condition helper + `/abrain status` DCC 段 closed aggregate；本地 smoke 覆盖 store-absent / ready / lock-free / epoch-nonce mismatch / pending-blocked attestation / HEAD mismatch / corrupt-changed / Windows fail-closed / Linux real flock）；**production observer aggregate CLI implemented locally + D5 harden（2026-07-30）**：`scripts/dcc-production-observer-aggregate.mjs`（`npm run dcc:observe-production`；fixture `smoke:dcc-production-observer-aggregate` 含 absolute-invalid / ABRAIN leaf symlink / bind-intent intermediate symlink；`DCC_ABRAIN_ROOT` 必须 absolute nonempty；inventory counts `Number.isSafeInteger>=0`；stdout sync write；一行 schema v1；ready 仅六条件 ready **且** inventory 全 0；`absolute_invalid`/`continuation_*`/`inventory_unavailable` 闭集；无 exact epoch/nonce/head/path/count）；`/abrain status` 的 DCC catch 仅 closed 固定日志（不 console 原始 error/path）；**既有 binding diagnostics path 保留**（no-path 不覆盖用户 binding 面）；router `scripts/accept_dcc_production.sh` 消费该 CLI（无 TEST_HOOKS）。**生产 acceptance 仍 pending**——需真实部署；当前 installed 很可能 unavailable；**未**声称业务写全量迁移或 Windows 支持；criteria **不**勾选。不预写正式验收成功；**不**声称 Windows DCC attestation 已实现）
- **Date**: 2026-07-30
- **Relates-to**: [ADR 0045](./0045-sediment-worker-safe-rpc-command.md)（Stage A worker RPC / process-level startup 历史合同；本 ADR 迁移 canonical convergence ownership，**保留** 0045 历史机制）, [ADR 0044](./0044-central-sediment-edge-authority.md), [ADR 0027](./0027-coupled-stigmergic-dual-loop-agent-system.md) C6, LSEA worker-first admission（[local-sediment-executor-authority.md](../architecture/local-sediment-executor-authority.md)）, pi-router living plan DCC section + `docs/architecture/central-memory-sediment.md` §8.3.8
- **Implementation authority**: convergence executor / attestation / kick-observe 的 **pi-astack worker 面** 在本仓库；daemon scheduler/status/backoff 与 deploy-order gate 在 pi-router；foreground cutover + continuation 跨两仓。完整 living plan SOT：`/home/worker/work/components/pi-router/plan.md` DCC H1。
- **Hierarchy**: DCC **叠在** LSEA physical authority 之上，**不是**第二 authority。attestation **不是** formal ConsumerAck / Stage A readiness / center primary。A0 完成前 local sediment 语义 primary 边界仍受 ADR 0044/0045 约束；本 ADR 只迁移 **canonical convergence executor** 所有权。

## 1. Context

LSEA 已把 store-present strict regime 下的 semantic execution authority 收敛到 daemon holder：TUI 对 `held|draining|free|unavailable` 全部 capture-only，settings=`foreground` 只暂停 daemon，不授予 TUI execution。但 **canonical convergence**（whole-L1 startup / process-level bootstrap 与后续 ready 后的跨会话收敛 apply）历史上仍可能落在 foreground/TUI 路径（例如 `session_start` whole-L1、process-level startup attempt、`/abrain sync` 类 direct mutation）。

这造成三类合同裂缝：

1. **双执行面**：authority 说 daemon-only，但 convergence 仍可能由 TUI 启动，出现无人窗口或双写窗口。
2. **静默假成功**：TUI 直接 canonical mutation 在 daemon 未 ready 时可能看起来“成功”，或 cutover 时只关 `session_start` 却漏掉 bind intent / sync 等路径。
3. **观察面缺失**：没有与 exact LSEA epoch+nonce 绑定的 sibling attestation，status 要么泄露 secret，要么无法区分 “paused / failed / never kicked”。

用户确认目标稳态：**Daemon-Owned Canonical Convergence（DCC）**——同一 LSEA holder 的 daemon-managed long-lived sediment worker 是 store-present 下唯一 canonical convergence executor。

## 2. Decision

### 2.1 Ownership

在 **authority store present** 的 strict regime 下：

- **唯一 canonical convergence executor** = 同一 LSEA holder 管理的 long-lived sediment worker（daemon-spawned，process-lifetime fence 仍属 LSEA）。
- TUI / ordinary foreground **不再**执行 whole-L1 startup，也 **不**因下列信号获得执行许可：
  - settings=`foreground`（仅 daemon pause）
  - authority `free`
  - authority/store `unavailable` / corrupt / unreadable
- store **absent** 只保留 worker-first rollout **legacy** 兼容窗口；不是 TUI 授权，也不是长期双执行面。

LSEA 合同保持正交：

- **不**修改 `authority.json` schema v1
- **不**新增第二把 authority lock
- attestation **不**替代 authority fence，也 **不**充当 formal ConsumerAck / Stage A readiness

### 2.2 Sibling convergence attestation（strict v1；固定契约）

路径（私有原子文件，Unix 文件 `0600` / 目录 `0700` 意图）：

```text
<ABRAIN>/.state/sediment/canonical-convergence/attestation.json
```

**Fixed strict v1**（实现拒 unknown/duplicate keys；字段名与类型**固定**如下，**不是**开放草稿）：

| field | 要求 |
| --- | --- |
| `schema` | 固定 `pi-astack/canonical-convergence-attestation/v1` |
| `local_executor_epoch` | nonzero canonical decimal string（exact 当前 LSEA epoch） |
| `local_executor_holder_nonce` | 64 lowercase hex（exact 当前 LSEA holder nonce） |
| `convergence_generation` | independent nonzero canonical decimal string；**禁止**复用 local/session/link/run generation |
| `outcome` | closed：**仅** `pending` \| `ready` \| `blocked` |
| `reason_code` | closed string；`ready` **必须** `none`；`pending`/`blocked` **禁止** free-text；具体 closed codes 由实现常量 + 测试冻结（文档禁止开放措辞替代 closed set） |
| `canonical_head` | `ready`：exact full **40 或 64** lowercase hex Git OID；`pending`/`blocked`：**必须** `null` |
| `published_at_ms` | nonnegative safe integer |

写入合同：

- 同目录 create-new temp → write → flush → atomic rename/replace → revalidate
- private dir/file 权限与 LSEA private objects 同级意图（**目标合同不变**：Unix `0700`/`0600`；**Windows same-principal protected DACL**）
- **平台落地边界（诚实）**：Linux/Unix local writer/verifier **已实现**（POSIX mode 强校验）。Windows 目标仍是 current-primary-TokenUser protected DACL；仓内 Node TS **不能**证明该 DACL，也无可复用 Node ACL verifier——**不得**静默依赖 inherited/default ACL。当前切片在 win32 上 **fail-closed**（kick/observe → control-result `status=unavailable` / `reason_code=attestation_unavailable` / `convergence_generation=null` / `retryable=true`；exported reader 抛 `CanonicalAttestationError(attestation_unavailable)`；内部写路径 defense-in-depth 拒绝创建不受保护对象），直至后续 native writer/verifier
- exact `canonical_head` **只**存在于该私有 `0600` attestation，供 TUI cheap live HEAD 对比
- status / log / result / error **不得**暴露 exact head / epoch / nonce / path；对外只 closed aggregate

TUI 有效观察（写授权 / whole-L1 门闩；**全部**满足才可能授权）：

1. authority store present
2. strict held + daemon holder
3. physical lock observed held
4. attestation `local_executor_epoch` + `local_executor_holder_nonce` **exact** 匹配当前 authority
5. attestation `outcome=ready`
6. live HEAD **exact** 匹配 attestation `canonical_head`

**任一**失败 → **不得**授权写，也 **不得**触发 TUI whole-L1。

**D5 local implementation notes（2026-07-30；production pending）**：

- 导出 strict read-only helper `observeForegroundCanonicalConvergence`（`extensions/sediment/canonical-control.ts`）：复用 private attestation snapshot；store absent → closed `legacy`/`not_authorized`；store present 仅六条件全过 → `ready`/`none`；否则 closed `blocked`/`unavailable` + reason（无 exact epoch/nonce/head/path/generation）。
- **只读**：不创建 attestation/runtime/promise/timer，不 kick、不 apply continuation、不 Git mutation；HEAD 走既有 `GIT_OPTIONAL_LOCKS=0` 隔离；**不**读 daemon status。
- 稳定性复核：attestation 在 authority 观察 + HEAD 读取前后 bytes/identity 不变；变化 fail closed（`observation_unstable`）。Windows DCC attestation 当前仍 fail-closed `unavailable`/`attestation_unavailable`。
- `/abrain status` 的 **DCC 新增段**（six-condition observation + bind inventory）仅 closed aggregate；catch 不 console 原始 error/path。**既有 binding diagnostics**（project root/manifest/registry 等 path）**保留**——no-path 合同只约束 DCC aggregate surfaces，不覆盖用户 binding 诊断面。**不**启动 Path A。store-present session/sync/bind cutover 保持 D3/D4。
- **不**授予 TUI whole-L1，**不**新增 authority；vault/secret 真正写阶段 six-gate+barrier 与 migrate-go store-present reject **local implemented**；**不**声称同步 ready；生产验收 **pending**。
- **Production observer aggregate CLI（local implemented + D5 harden / production pending）**：`scripts/dcc-production-observer-aggregate.mjs` 以 jiti 加载 `observeForegroundCanonicalConvergence` + `inspectAbrainBindIntentInventory`（默认生产 deps，禁止 test hooks）；`DCC_ABRAIN_ROOT` 必须 absolute nonempty（相对路径→`absolute_invalid`；空→`env_missing`）；inventory counts 必须 `Number.isSafeInteger>=0`；stdout **sync write**（防 `process.exit` 截断）；恰好一行 `schema=pi-astack/dcc-production-observer-aggregate/v1` + `status`/`reason_code`；ready 仅六条件 ready 且 inventory 全 0；pending→`blocked`/`continuation_pending`；failed|invalid→`blocked`/`continuation_failed`；inventory 读失败→`unavailable`/`inventory_unavailable`；其它保留 closed observer reasons；stderr/stdout 不泄 path/exact secret/count；exit ready=0 其它=1。fixture smoke 覆盖 ready/pending/failed/corrupt/observer-fail/env-missing/absolute-invalid/ABRAIN leaf symlink/bind-intent intermediate symlink + zero tree delta，**不是** production 证据。

attestation 用途闭集：

1. 只读观察（daemon `observe`、operator aggregate status；对外无 exact secret）
2. 拒绝写 / loud fail-closed 决策输入（epoch-nonce mismatch、not ready、HEAD mismatch 等）
3. TUI 私有 cheap live HEAD 对比（仅读本地 `0600` attestation，不经 status/log 外泄）

**明确不是**：authority、ConsumerAck、retention watermark、formal Stage A readiness、center primary 证明。

### 2.3 状态机（目标；三层不得混称）

三层状态面**彼此不同**，禁止互相冒充：

| 层 | 闭集 / 形态 | 用途 |
| --- | --- | --- |
| **Attestation `outcome`** | **仅** `pending` \| `ready` \| `blocked` | 私有 durable 收敛证明；TUI 写门闩输入之一 |
| **Worker control-result `status`** | **仅** `pending` \| `running` \| `ready` \| `blocked` \| `unavailable` | kick/observe 立即返回的 closed aggregate（另有 `reason_code` / `convergence_generation` / `retryable` 跨字段不变量） |
| **Daemon status aggregate** | 可映射 `idle` / `running` / `ready` / `failed` / `paused` / `unavailable` | operator/status 观察；**不是** attestation outcome，也**不是** control-result 同构 |

```text
attestation outcome:
  pending --success--> ready
  pending --fail/corrupt/mismatch--> blocked
  ready|blocked --new convergence_generation (new kick)--> pending

control-result status (worker kick/observe; not outcome enum):
  kick accepted --> pending (startup_requested)
  in-flight coalesce / observe runtime mid-flight --> running (startup_running)
  durable ready attestation --> ready (reason none)
  owner/startup fail / attestation infra --> blocked
  authority/attestation missing-or-mismatch --> unavailable

daemon status (illustrative mapping, not outcome enum):
  idle/paused --kick/startup/periodic--> running
  running --success--> ready
  running --fail--> failed
  * --settings/free/unavailable--> paused|unavailable
```

要点：

- daemon `running` 不承诺 canonical mutation 完成；只有 attestation `outcome=ready`（且 TUI 有效观察六条件全过）才表示该 `convergence_generation` 下可观察成功收敛并可考虑写门闩。
- **control-result `ready` ≠ 仅凭 process-local runtime-ready**：observe 在 attestation 仍 `pending` 时若 peek 到 runtime `ready`，**必须**继续映射为 control `running`（不得绕过 durable attestation CAS 发布）。
- settings pause / authority free / unavailable → daemon status 可进入 `paused` / `unavailable`，attestation 可停在 `pending`/`blocked`；**允许停摆**，必须 loud 可观察，**禁止** TUI 接管填补。
- corrupt attestation / epoch-nonce mismatch → fail closed；**禁止**删除 attestation/store “恢复 legacy”。
- **D1 stale pending**：attestation 停在 `pending`（含 deferred settle）时，**不**由 observe 推进；由 daemon startup/periodic/backoff 发出的**新 kick** 推进（新 `convergence_generation` + 新 attempt）。D1 **不**实现 daemon scheduler 本身。

### 2.4 Worker control 协议方向

在既有 worker-safe RPC 面之上增加 control 方向（命令名以落地常量为准；文档层固定语义）：

| 命令语义 | 要求 |
| --- | --- |
| `kick` | 请求一次 **真实、可验证的新鲜** convergence attempt；**立即返回**；始终在 **worker-budget task ALS 外** 驱动；同 root **in-flight singleflight/coalesce**；**settled ready 后**下一 kick **不得**只复用 fulfilled ready promise 虚增 attestation generation，必须驱动 runtime 新一轮 startup/convergence（可命中实时 last-known-ready gate 快速 ready）；普通 `getCanonicalStartupPromise` 历史 ready-reuse 语义保持 |
| `observe` | 只读报告 attestation/control aggregate；**zero side-effect**（不 kick、不写 attestation、不创建 runtime/promise/timer、不触发 Git/文件 mutation/pipeline）；**不**凭 process-local runtime-ready 越权发布 durable ready |

握手（D1）：

- **握手 = command presence**（worker 注册 `sediment-worker-canonical-control` 等命令；daemon 以命令是否存在做 deploy/handshake gate）
- **旧 exact-one capability bytes 不变**：`sediment-worker-capabilities` 载荷仍为既有 exact-one 数组（含 `local_executor_authority_process_lifetime_v1`）；**不**声称新增 DCC capability string，**不**破坏旧 exact-one readers
- 旧 daemon 不理解 kick/observe 时不得被新 worker 误导为“已 convergence healthy”

与 ADR 0045 process-level startup 的关系：

- 0045 描述的 process-level startup attempt / `runOutsideWorkerBudget` / cooperative deferred 是 **历史 worker 内机制**
- DCC 把 **谁有权触发与拥有 canonical convergence** 收口到 daemon kick/observe + long-lived worker；kick 的 fresh-after-settled-ready 是 DCC 对 process-level attempt 的显式控制语义
- 0045 历史合同保留；canonical ownership 迁移指针见 ADR 0045 更新小节

### 2.5 Daemon lifecycle（external trigger）

第一版 external lifecycle trigger **仅**：

1. daemon startup
2. periodic schedule
3. backoff retry

**Out of scope（v1）**：TUI loopback wake endpoint。未来若需要低延迟 wake，必须新决策，不得在 cutover 时偷偷加入。

Daemon 职责方向：

- first-class kick/observe 客户端
- **command-presence handshake 未就绪** → 不宣称 healthy convergence
- status/log/result/error aggregate only（无 exact epoch/nonce/head/path）；daemon status 映射与 attestation `outcome` / control-result `status` 解耦
- startup/periodic/backoff 调度与可观察停摆（D2+；D1 只提供 worker 侧 kick/observe 接收面）

### 2.6 Foreground direct-call audit 与 cutover

Cutover 前必须审计所有 foreground/TUI **direct canonical mutation** 路径，至少包括：

- whole-L1 / process-level startup（含 `session_start` 触发面）
- bind intent 类需要 canonical apply 的路径
- `/abrain sync` 及同类同步/收敛命令

规则：

1. **不能静默成功**：若 daemon/worker 未 ready，必须 durable intent 或显式 fail-closed，禁止看起来成功但未收敛。
2. **不能只关 `session_start`**：遗漏 continuation/sync 路径 = cutover 不合格。
3. bind intent：保留 durable intent，由 daemon ready 后的 continuation apply。
4. sync 类：daemon delegation **或** 显式 fail-closed 合同；二选一必须文档化并测试。

**Execution-time dynamic cutover mutation fence（local implemented；production pending）**：

- **schedule-time posture 不足以授权 mutation**：store absent 时进入 process-local queue / OFD wait 的旧任务，可能在等待期间遇到 authority store 创建；因此所有 canonical mutation 必须在实际 operation 前重新分类 posture。真实竞态合同为：`absent → 等待真实 cross-process OFD root flock → store present → 取得锁` 时，无 mutation-authority context 必须固定闭集拒绝，operation count=0、canonical tree 零 delta。
- shared `canonical-mutation-authority` 使用独立 `AsyncLocalStorage`（**不得**复用 worker-budget ALS），以 global symbol + version 跨 jiti 多实例共享；context 绑定 canonical ABRAIN root、role（`daemon|foreground_observed`）与 closed revalidate callback。store absent 保留 legacy；store present 仅 active same-root lease 且本次 revalidate 成功才允许，否则统一 `canonical_mutation_not_authorized`，error 不含 path/raw detail。
- context 是**短 lease**：只覆盖 authorized callback 的完整 `await` 生命周期；callback settle 后先 invalidate lease。ALS 可能传播到 detached Promise / timer，但 inherited context 在 lease 失效后不得继续写，防止后台 continuation 借旧授权跨越 cutover/revocation。
- `canonical-mutation-barrier` 的 outer / in-singleflight / try / nested-held 路径都执行 dynamic assert；至少在排队/取锁前与拿到 OFD 锁后、进入 operation 前复核。project repo 若无 authority store 仍走 legacy barrier，不因 ABRAIN DCC gate 误阻断。
- daemon context 范围：worker RPC 每次 `runAgentEndPass` iteration；maintenance 真正 repair/drain；DCC kick 的 next-turn repair → whole-L1 startup promise → bind continuation settle（使用 initial admission 同一 observation seam、exact epoch/nonce、holder daemon）。kick handler 仍立即返回；后台 frame 必须 await full startup/settle 后才失效，authority revoke 导致 blocked/`startup_failed`，不得 ready。
- foreground vault 在 outer six-condition ready 后创建 `foreground_observed` context，revalidate 仍为 strict six-condition ready/none，并覆盖 barrier + operation；store absent 不创建 context/barrier。semantic writer 即使 `gitCommit=false` 也在 operation 前 assert；tracked canonical writers（knowledge/outcome/constraint evidence、Tier-1 proposition、constraint projection L1/L2、production proposition L1）在真正 L1/L2 mutation 段自包含 `withCanonicalMutationBarrier`（preflight/read-CAS/write 整体 OFD；nested 不死锁；store absent legacy）。**不**把 `.state/sediment/proposition-policy-stable-view` recovery child 当作 canonical fence 对象。`.state` pending marker/audit/sequence/L3 sync 不属于 canonical semantic authority，不因此阻断；offline output/project files 不扩大 gate。

**D3/D4 local implementation notes（2026-07-30；production pending）**：

- store-present ordinary foreground = `capture_only`（held/free/unavailable/corrupt 一律；settings=`foreground` **不**授权）。
- `session_start` capture_only：**不** schedule whole-L1、**不** apply bind intent、**不** auto git sync。
- **`/abrain sync` v1 = explicit fail-closed**（loud warning reject；**不** await Path A / apply / gitSync）。daemon delegation 仍是未来可选增强，**不是**本切片成功条件。
- tracked `/abrain bind` capture_only：只写 durable intent；**不** opportunistic apply、**不** schedule foreground bind consumer。local-map-only fast path 可保留。
- activation store-present：**verify-only** brain layout（root + 全部 zone + `rules/always|listed`，真实目录非 symlink、realpath 不逃逸）+ verify-only `.state/` ignore；**禁止** ordinary foreground mkdir/chmod/write 或补写 tracked canonical `.gitignore`。store absent legacy（含 root 完全不存在的 first-boot）仍 ensure layout + auto-ensure ignore；**不得**因 classifier fail-closed 误判 capture_only。
- **authority-admitted kick owns strict layout repair**（store-present）：DCC kick 在 authority admission 之后、pending attestation 已发布之后、**next event-loop turn**（`setImmediate` / 等价 macrotask；**不是** Promise microtask）内、whole-L1 startup 之前调用 strict closed-error repair helper。pending attestation + control result **先**返回 awaiter，再 repair/startup——microtask 调度会在 `await kick` 恢复前同步跑 repair，破坏 immediate-return 证据。real repair（及 gated test repair hook）在 `withCanonicalMutationBarrier` 内执行，避免与已授权 TUI business write 并发；barrier busy / repair throw → 终态 attestation `blocked`/`startup_failed` retryable，**绝不** ready。**不**创建 root；existing zone/mode 必须 plain dir；仅创建缺失 known zones / `rules/{always,listed}`（0700）并安全 ensure `.gitignore` 含 `.state/`。observe **绝不** repair。TUI 保持 verify-only 零写；若 local safety 已 blocked，store-present assert 路径允许重新执行 verify-only refresh（仍零写），使 DCC 修复后现有进程可恢复。
- **periodic ready kick 有短暂 pending failclosed 窗口**：新 kick 发布 pending attestation 后、settle 完成前，TUI 六条件观察为 not-ready（`attestation_not_ready`）；这是正确 fail-closed，不是缺陷。**production pending**。
- deploy 前须对历史 `failed` / `invalid` bind-intent 记录做 **清点与人工处理**。语义精确为：每次 kick **终态**持续/重新判定 `continuation_failed`（blocked）；repair attempt 期间 attestation 可为 `running`/`pending`，但**绝不** ready，直至人工处理。
- **Foreground direct-call audit — remaining TUI business writes（local；production pending）**：
  - **vault six-gate + context + barrier**：store-present 下 `/secret set`、`/secret forget`、`/vault init` 的**真正写阶段**走 `withForegroundDirectCanonicalBusinessWrite`：先 strict `observeForegroundCanonicalConvergence`（必须 ready/none），创建 short-lived `foreground_observed` mutation context，再进入 `withCanonicalMutationBarrier`；barrier 拿锁后 shared authority revalidate + 显式 inner 六条件观察仍 ready 才执行 operation。任一观察失败 / authority revalidate 失败 / lock busy / 异常 → 仅闭集短码 `dcc_canonical_write_not_authorized:<closed>`（不泄 path/raw error）。store absent → legacy 原样（不新增 context/barrier/observer）。list/status/参数错误/idempotent no-op preflight **不** gate；vault init 在只读/idempotent preflight 完成后、`runInit` 写事务前包裹。**写成功不 kick、不 await 同步 ready/convergence**——业务文件本身 durable，daemon periodic kick 收敛；**不**声称同步 ready。
  - **`/memory migrate --go` store-present capture_only v1 = explicit loud reject**（在任何 `runMigrationGo`/目标写之前；dry-run/lint 不变；store absent legacy go 不变）。
  - **assertVaultLocalSafety** = local safety + DCC observation/barrier at writes；**never Path A**。
  - 其它 `registerCommand` TUI 路径：仅真实 tracked ABRAIN write 纳入；state audit / read-only / project plan writers 不改。

### 2.7 Continuation 迁移

```text
TUI/foreground intent
  → durable intent record (no silent canonical mutation)
  → DCC worker whole-L1 diagnostics ready
  → same authority-admitted worker applies bind continuation
       (inspect inventory → applyAllPending → re-inspect)
  → only then read final HEAD and publish ready attestation
  → aggregate status / loud failure (closed reason codes)
```

**Bind continuation closed reason codes（attestation + control-result；固定）**：

| reason_code | when | control status / attestation outcome | retryable |
| --- | --- | --- | --- |
| `continuation_pending` | inventory still has pending **or** apply/inspect threw | `pending` | `true` |
| `continuation_failed` | inventory has failed **or** invalid（含历史 failed；corrupt 计 invalid） | `blocked` | `false` |

硬约束：

- continuation apply 发生在 **ready attestation 发布之前**（whole-L1 ready 之后、最终 HEAD 读取之前）。
- 历史 `failed` / `invalid`：**每次 kick 终态**持续/重新判定 `continuation_failed`；repair attempt 期间可为 running/pending，但**绝不** ready，直至人工处理。**不得**被洗掉、自动 requeue 或静默忽略。
- pending invalid 在 DCC apply 路径 **fail closed**（strict loader；不可 loose readFile 静默 skip）。
- observe **zero side-effect**：绝不能 inspect/apply continuation。
- public status/log 只暴露 aggregate counts（pending/failed/invalid）与 closed reason codes，**不**泄露 itemId/path/exact path/detail。

Continuation 不是第二 authority；它只是把“用户意图”与“daemon-owned apply”解耦，避免 cutover 后意图丢失或 TUI 直写。

### 2.8 Failure semantics

| 条件 | 行为 |
| --- | --- |
| settings=`foreground` | daemon pause（LSEA）；convergence 可停摆；**不**授权 TUI |
| authority `free` / `unavailable` | loud fail-closed / paused；**不**授权 TUI |
| worker 缺 control command presence | daemon 不得 kick 成功路径装健康；deploy-order fail |
| observe 失败 | 只读重试/告警；zero mutation |
| kick 失败 / backoff | 可观察停摆；不转 TUI |
| attestation corrupt / epoch-nonce mismatch | fail closed；禁止删文件恢复 legacy |
| direct TUI mutation without ready | durable intent 或显式 reject；禁止静默成功 |

### 2.9 部署 / 回滚

硬顺序：

1. **Worker**：control command presence + kick/observe + attestation（旧 exact-one capability bytes 不变）
2. **Daemon**：scheduler + status + backoff + command-presence handshake
3. **Foreground**：cutover + continuation/delegation

回滚原则：

- 回滚 foreground cutover 不得假造 “TUI 因 free/unavailable 自动合法”
- **禁止**删除 authority store 或 attestation 作为恢复 legacy TUI execution 的手段
- store absent legacy 只服务 worker-first rollout 窗口，不是运维开关
- 回滚必须保持 fail-closed 可观察，优先停摆而不是双执行面

### 2.10 验收方向

criterion ids（SOT：pi-router `plan.md` DCC section）：

- `dcc-contract`
- `dcc-worker-control`
- `dcc-daemon-scheduler`
- `dcc-foreground-cutover`
- `dcc-continuations`
- `dcc-deploy-order`
- `dcc-tests`
- `dcc-real-production`

真实验收 **必须** 使用生产数据（aggregate-only）；合成不得作为唯一证据。本 ADR **不预写成功**。

## 3. Non-goals

- 修改 LSEA `authority.json` v1 或增加第二 authority lock
- 将 attestation 升格为 formal ConsumerAck / required-consumer retention / Stage A complete
- v1 TUI loopback wake endpoint
- center Stage B/C primary cutover
- 用删除 store/attestation 恢复 legacy TUI whole-L1
- 把 DCC 宣称为 center memory authority 或 formal readiness

## 4. Consequences

- Canonical convergence 与 LSEA physical authority 对齐为 daemon-owned，消除 store-present 下 TUI whole-L1 双执行面
- 需要跨仓分阶段落地；乱序部署会引入无人 convergence 窗口——deploy-order gate 成为硬约束
- Foreground 必须从“直接执行”迁到“durable intent / delegation / loud reject”
- ADR 0045 历史 worker RPC 与 process-level startup 叙述保留；ownership 以本 ADR + plan DCC 为准
- 操作者必须接受：pause/free/unavailable 时 convergence 可以停摆，且这是正确 fail-closed，不是缺陷捷径

## 5. 相关文档

- pi-router `plan.md` — DCC living plan / 验收 SOT
- pi-router `docs/architecture/central-memory-sediment.md` §8.3.8
- pi-router `docs/daemon-manual-start.md` — DCC operator 摘要
- [ADR 0045](./0045-sediment-worker-safe-rpc-command.md)
- [central-sediment-edge.md](../architecture/central-sediment-edge.md)
- [local-sediment-executor-authority.md](../architecture/local-sediment-executor-authority.md)
