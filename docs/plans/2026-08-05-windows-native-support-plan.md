---
doc_type: plan
status: active
created: 2026-08-05
updated: 2026-08-06
---

# pi-astack Windows 原生支持 Living Plan

**状态：Active；当前阶段：P0–P3 implementation + package plumbing 已落地；loader 已加 same-fd post-dlopen rehash + lstat 非 ENOENT fail-closed（TOCTOU 仍未完全闭合）；旧 892ddeb live artifact 已 unlock 并移出 worktree，pin 已恢复 `null`；最终 source commit 待建立，其后 clean production rebuild/package/artifact commit/dossier；production acceptance dossier 已封闭加固（hardCleanup strict / child exit assert / latest byte-exact / DACL system-owner 真拒绝 / live abrain bounded aggregate guard / structural+provenance 可报 `same_fd_post_dlopen_rehash:"pass"` / 全局 residual 仍含 `binary_hash_to_dlopen_toctou_not_fully_closed` ⇒ accepted:false；provenance section 可 pass 但不自动宣称 WIN-BINARY 完成）但仍未 accepted——dossier workers 开发验证全绿，full gate 待 final artifact；TOCTOU+DCC 仍 blocking**——adapter / stable-view / edge / DCC 物理层已接线；零参数 load 在 pin null 时 fail-closed；smokes 双态（pin null fail-closed / pin live child 正向，live 仅当 final pin 存在）；dossier 脚本已进 source closure；不 commit、不勾 criteria；未改 settings/~/.abrain。**

本计划是 pi-astack 生产级 Windows 原生支持的唯一 living plan。它冻结已确认决策、阶段边界与外部验收门；不宣称 Windows production acceptance 已完成。会话讨论只保留决策来源，不是执行权威。每次实施和验收必须同时核对 [ADR 0046](../adr/0046-daemon-owned-canonical-convergence.md)、[central-sediment-edge](../architecture/central-sediment-edge.md)、[local-sediment-executor-authority](../architecture/local-sediment-executor-authority.md)、[retained-directory-ofd-lock](../../extensions/_shared/retained-directory-ofd-lock.ts)、当前代码、live settings 与真实 Windows 主机证据。文档与现场冲突时，按下文 Replanning Protocol 处理。

## Destination

在第一支持矩阵内，为 pi-astack 提供**生产级** Windows 原生能力：跨进程互斥锁、crash-safe 释放、durable atomic pointer / replace、以及 DCC 所需的 current-primary-TokenUser protected-DACL writer/verifier。长期路径是**窄范围 N-API addon**；Linux retained OFD 实现保持行为不变；纯 TS lockfile 不作为生产 fallback。addon 缺失、错误架构、hash 不符必须 fail-closed；不运行时下载、不现场自动编译；binary 必须绑定 source/toolchain/target/hash/provenance。

## Stable Goal

使 pi-astack 在 Windows 10 1709+ / Windows Server 2019+、local NTFS、win32-x64、Node >=22.19 与 Node 24、`NAPI_VERSION` 9 上，对 sediment / LSEA / DCC / Policy stable-view / edge journal 等关键耐久路径达到与 Linux 同等生产 fail-closed 语义，且不削弱既有 Linux 生产行为。

## In Scope

- 窄范围 N-API addon 的 ABI 边界、加载、hash/provenance 校验与 fail-closed 策略。
- Windows native lock：跨进程 contention、holder crash 后释放、同一 retained identity 语义。
- Windows atomic pointer / durable replace：content-addressed `latest` 指针与 durable 文件替换。
- Windows protected-DACL writer/verifier：current-primary-TokenUser 私有对象；DCC attestation 在该能力完成并验收前继续 `attestation_unavailable` fail-closed。
- Linux zero-regression：保留现有 OFD lock 与 Linux DCC attestation 行为，不改语义权威。
- 第一支持矩阵上的真实 Windows production acceptance 与外部证据门。
- 与 stable-view injection、edge journal 相关的 Windows 耐久路径验收。

## Out of Scope

- 纯 TS lockfile 作为生产 fallback 或“降级可用”路径。
- 运行时下载 binary、现场自动编译、用户机器上的 node-gyp 构建作为生产路径。
- WSL 作为 Windows 原生验收替代；WSL 只可作开发旁路，不计入本计划 production acceptance。
- win32-arm64、非 NTFS、网络盘 / 可移动介质 / 非 local volume 作为第一矩阵目标。
- Node <22.19、非 `NAPI_VERSION` 9、非 win32-x64 目标。
- 扩大 addon 职责到业务逻辑、Git、LLM、network 或 broad FS framework。
- 将 inherited/default ACL、Everyone 可写对象或“看起来私有”的默认权限当作 protected-DACL 完成。
- 修改 Linux retained OFD 语义，或以 Windows 路径回写 Linux production contract。
- 本计划不自动授权 canonical-path P2/P3/P4 或其他无关 transition。

## Confirmed Facts

- Linux retained directory OFD lock 已存在且硬依赖 Linux（`process.platform !== "linux"` 直接 `OFD_LOCK_UNSUPPORTED`）；它不是 Windows 可移植实现。
- Linux DCC attestation writer/verifier 已 production accepted（2026-07-31）；Windows DCC attestation 当前切片 fail-closed：`status=unavailable` / `reason_code=attestation_unavailable`，不静默依赖 inherited/default ACL。
- 仓内纯 Node/TS **不能**证明 Windows protected DACL；无可复用的 Node ACL verifier 可替代 native writer/verifier。
- 已确认长期架构：窄范围 N-API addon，而非纯 TS 生产 fallback。
- 已确认第一支持矩阵：Windows 10 1709+ / Windows Server 2019+、local NTFS、win32-x64、Node >=22.19 与 Node 24、`NAPI_VERSION` 9。
- 已确认 fail-closed 规则：addon 缺失 / 错误架构 / hash 不符必须拒绝生产路径；不运行时下载；不现场自动编译。
- 已确认 binary 必须绑定 source / toolchain / target / hash / provenance。
- 本机工具链现已具备：`C:/BuildTools`（VsDevCmd + MSVC 14.44）+ `rustc`/`cargo` host `x86_64-pc-windows-msvc`；真实 `cargo build --release` 已产出 win32-x64 N-API cdylib。此前“仅有 rust/cargo、无 cl/cmake/msbuild”的 blocker **已解决**。
- 本计划创建时，**没有任何** Windows native lock / protected-DACL / production acceptance 实现被宣称完成。

## Frozen Contracts

- **生产目标**：生产级 Windows 原生支持；不是 best-effort、不是 partial degrade 即视为完成。
- **长期实现形态**：窄范围 N-API addon。
- **Linux 不变性**：Linux retained OFD 实现与已接受的 Linux DCC 行为保持语义不变；Windows 工作不得借机放宽 Linux fail-closed。
- **禁止生产 fallback**：纯 TS lockfile 不得作为生产 fallback。
- **第一支持矩阵**（缺一不可）：
  - OS：Windows 10 1709+、Windows Server 2019+
  - FS：local NTFS
  - ABI target：win32-x64
  - Node：>=22.19 与 Node 24
  - N-API：`NAPI_VERSION` 9
- **Core ABI / capabilities**：
  - Core addon ABI 冻结为 **v1**；功能用 **versioned capabilities** 扩展，不因增加 capability 而 bump core ABI。
  - Capabilities 合同可扩展：schema `array` + `minItems`/`uniqueItems`/`items.pattern` + `contains: retained_directory_lock_v1`；TS 已知 allowlist 且必须包含 retained、sorted unique。
  - **当前已知 sorted set**：`atomic_file_tempdir_v1`, `atomic_file_v1`, `protected_dacl_v1`, `retained_directory_lock_v1`。runtime manifest capabilities 必须与 native `getCapabilities()` exact match；loader allowlist 可扩展。**未 advertise 不得调用**。`atomic_file_tempdir_v1` 新增 `durableAtomicCreateFileWithTempDirectory`（显式 staging 目录）；**不**悄改 `durableAtomicCreateFile` same-dir temp 语义。
- **DCC 门闩**：在 protected-DACL writer/verifier 完成并验收前，Windows DCC 继续 `attestation_unavailable` fail-closed；禁止“先 ready 再补 DACL”。
- **Addon 加载门闩**：缺失、错误架构、hash 不符 → fail-closed；禁止 silent skip / soft warn / 回落 TS lock。
- **分发门闩**：不运行时下载、不现场自动编译。
- **Provenance 门闩**：每个 binary 必须绑定 source、toolchain、target、hash、provenance；缺任一绑定不得进入生产路径。生产 manifest pin 当前为 `null`（`windows-native-addon-pin.ts` package 输出；不进 source closure）；零参数生产 loader 继续 fail-closed。package/install plumbing 已存在但未写入非 null pin。生产成功加载后还须 package_rx 三点验证。
- **证据门闩**：acceptance 只认外部证据（`cmd:` / `file:` / `git:` 及固化 dossier）；模型自述、synthetic-only、WSL 替代均不算 production acceptance。temp package + dynamic pin 的 smoke **不等于** production acceptance。

## Current State

> 本节是 living plan 的可重写热区。阶段切换、发现现场冲突或形成新阻塞时整节更新；不要在此冻结会快速过期的运行数量。

- 当前阶段：**P0–P3 implementation probe + package plumbing 完成；loader same-fd post-dlopen rehash + trusted-leaf lstat 非 ENOENT fail-closed 已落地（TOCTOU residual 仍在）；pin=`null`（旧 892ddeb live 已 unlock 移出）；P4 dossier 已加固（未 accepted）；final source commit + clean rebuild/package/artifact commit 待做**。
- **Live pin / artifact**：`windows-native-addon-pin.ts` 已恢复 `null`；旧 `892ddeb` live artifact 已 unlock 并移出 worktree；**不得**再以该旧 live 包作 final 证据。源码改后既有 artifact commit 视为 stale，须在 final source commit 后 clean rebuild/package/artifact commit（本切片不 package/build/commit）。
- **Loader TOCTOU 缓解（2026-08-06；≠ 完全闭合）**：`assertTrustedLeafPath` 逐组件 lstat 仅 ENOENT 可 defer 到 MISSING；EACCES/EPERM/EBUSY/其他 → `PATH_UNTRUSTED`（detail 仅 bounded check/code，不泄 path）；realpath 同类 fail-closed。生产/测试共同 load flow：binary fd 自 hash 前持有到 load 后；dlopen 后 **same-fd** 全量 rehash exact `manifest.binary_sha256`（`assertSameFdBinaryHash`，positional read / 64MiB ceiling，不从 path 重读）→ 不符 `BINARY_MUTATED` → 再 after-load fd/path identity + self identity。smoke 覆盖：lstat 非 ENOENT→PATH_UNTRUSTED；ENOENT→MISSING；load callback 原地改内容（保 size/mtime）→ same-fd rehash BINARY_MUTATED；既有 replace race 仍过。source hygiene 静态检查 rehash 顺序。
- **Production acceptance dossier（2026-08-06 再封闭；≠ accepted）**：`scripts/dossier-windows-native-production-acceptance.mjs` + `dossier:windows-native-production-acceptance`；controller 永不 dlopen；closed workers 单 JSON stdout；`WorkerFail` throw + 顶层 catch 统一 emit/exit（禁 process.exit 绕 finally）。**hardCleanup strict**：成功路径 kill(仅存活 child)/restore/hardRm 后 temp 仍在或 hardRm 失败 → throw 使 worker fail；失败路径 best-effort 且 `cleanup_errors` bounded 写入 failure JSON，不吞。retained/edge 所有自然 exit 断言 `code===0 && signal==null`；timeout/非 0 带 bounded stderr 诊断；crash holder `taskkill` 单独标 `holder_exit_expected_taskkill`（不按自然 exit 失败）。stable latest **仅** byte-exact `bundles/<hash>\n`（删 contains-hash 宽松）；DACL tamper 加 icacls Everyone readback + native verify deny。DACL system owner-mismatch：实际存在 targets 必须全部 denied，禁止全 absent_skip 仍 claim denied；≥1 成功拒绝；residual 标明非第二账户主动 tamper。live `~/.abrain` guard = bounded recursive aggregate（stable-view / recovery / edge-protocol-shadow / canonical-convergence / local-executor-authority），只输出 count+sha256（含 hidden；rel+type+size+mtime+小文件 content hash；条目/总 bytes 封顶 → invalid/accepted false）；before/after exact。structural/provenance 可输出 `same_fd_post_dlopen_rehash:"pass"`（loader contract static + 成功路径）；全局 residual **仍**恒含 `binary_hash_to_dlopen_toctou_not_fully_closed`（无 native bootstrap 原子保证；ancestor-delete-handles / same-token-admin 残留）⇒ `accepted:false`；provenance section 可 pass 但 **不**自动宣称 WIN-BINARY 完成。sections：provenance zeroarg+package_rx；retained-lock async 三阶段 barrier 16×3 + crash；DACL 矩阵；stable-view temp ABRAIN_ROOT production self-publication + loud zero；edge pair/coord/audit/tamper/partial；DCC not_covered partial。脏树 full run→`gates_failed`；**dossier workers 开发验证全绿；full gate 待 final artifact**。不 commit、不勾 criteria。
- **Post-pin smoke 双态（2026-08-06）**：7 个冲突 smoke（addon / retained-lock / retained adapter / dcc-windows / dcc-worker / stable-windows / edge-windows）pin null 保留 fail-closed；pin live 允许并在 child 验证 production zeroarg 正向；controller 不因 live dlopen 阻塞 live 包覆盖/删除；temp suites 独立且不称 production。**当前 pin=`null` → 走 fail-closed 态。**
- **Production package / pin / package_rx plumbing（2026-08-06；pin 现 `null`；final 待 source commit 后 rebuild；≠ production acceptance）**：
  - pin 常量拆到 `extensions/_shared/windows-native-addon-pin.ts`（初值 null；package 输出；**不进** source closure）；loader import/re-export。
  - `scripts/package-windows-native-addon.mjs`：`package|install|unlock|verify`；package 只接受 `mode=production` + `development_only=false` + `dirty=false` + native_tests/clippy/repro passed；复制 staging `.node` → `native/windows/win32-x64/`；exact manifest/v1 LF raw bytes；hash 后严格模板覆写 pin.ts；temp/test loader 验证 manifest/binary/self identity；**不**下载/编译。
  - install：校验 pin/manifest/hash/self identity 后 `setProtectedPath` files→dir `package_rx` 并 native reverify；失败不声称安装。
  - unlock：优先合法 addon 改 private_rw（dir 先）；失败仅用固定 `%SystemRoot%\System32\icacls.exe` reset exact subtree 且只看 exit；再验 writable。
  - verify：生产零参数 loader + package_rx 三点；bounded JSON 证据（无 path/SID 原文）。
  - 生产零参数 loader：dlopen+self identity 成功后、返回前 native verify package dir/binary/manifest exact `package_rx`；闭码 `WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID`；测试 options loader 不强制 ACL。
  - `__TEST.loadWindowsNativeAddon` 门控 `PI_ASTACK_ENABLE_TEST_HOOKS=1`；纯 parse helper 不门。
  - 自引用：build hard-assert pin/artifacts 不进 closure；package script + package smoke **进** closure。
  - 可复现：Cargo 1.97.1 stable 无法启用 profile `trim-paths="all"`；build driver 注入稳定 `--remap-path-prefix`（native/repo/cargo/rustup/user homes）等价路径剥离；**设置 `CARGO_ENCODED_RUSTFLAGS` 时必须显式重含 `-C` + `link-arg=/Brepro`**（ENCODED 会覆盖 `.cargo/config.toml` rustflags，不得丢失 /Brepro）；assert 最终 encoded flags 含 /Brepro 与 remap。toolchain_id preimage 去掉 cargo_home/rustup_home 与 raw locale banner，改 numeric cl/link + trimmed SDK；build-info 可保留 raw diagnostics。
  - **Production 证据字段（manifest v1 + BuildIdentity，尚未发布可现在定）**：`build_mode` development|production；`reproducibility` skipped|dual_clean_match；`native_tests`/`clippy` = passed；`build_config_sha256`（至少 cargo config raw bytes sha256）。build.rs 从受控 env 编入；build driver **gates 后**再 release build，env 值为真实 passed/dual_clean_match|skipped；package 只接受 production + dual_clean_match + passed + passed 并与 binary self-identity exact；schema/loader/fake manifests/smokes 同步。build_id preimage 含同字段；build-info 写真实 `build_id_preimage_sha256` 与这些字段，package 可重算交叉核验。release 产物扫描禁止嵌入 repoRoot/userProfile/cargoHome/rustupHome（ASCII 大小写 + UTF-16LE）。
  - `.gitattributes`：首行 `* text=auto eol=lf`；`.node` binary；manifest `-text`；pin.ts LF；**`.gitattributes` 本身进 source closure**；closure 文本拒绝 CRLF。`.gitignore` 允许固定 production `.node`，仍 ignore `target/`。
  - loader 生产路径：`PIN_SOURCE_COMMIT` 非 null/40hex 且等于 `manifest.source_commit`（闭式错误）；test options 不要求。`__TEST.loadWindowsNativeAddonEnforcingPackageAcl` 门控 ACL 强制。
  - unlock：`loadInstalledForAcl` **throw** 不 die/process.exit（catch 可落 icacls）；无 pin/坏 binary/缺 DLL → 固定 icacls reset fallback + 明确 method。package 写前 directory create/delete writability probe；裸 EACCES 变 closed 提示；binary ≤64MiB；post-verify 失败恢复原 pin/manifest/binary 或 pin→null fail-closed。install ACL 部分失败 best-effort private_rw 并提示。
  - smoke：`smoke:windows-native-package`（无 artifact/pin → SKIP；live 固定包只读 production verify；hash/missing/ACL tamper 用独立 temp package；production ACL gate 经 temp + test-hooks enforcing 入口；unlock↔install 仅动 live ACL 并 restore）。
  - **本切片：旧 live 已清；pin=`null`；final 待 source commit + clean rebuild/package/artifact commit；不 commit；criteria 全不勾。**
- **DCC attestation 物理层 integration（2026-08-06；pin null → 生产仍 fail-closed）**：
  - `canonical-control.ts`：`isDccAttestationPlatformSupported(win32)` 仅当 production 零参数 loader 成功且 capabilities 含 `protected_dacl_v1`+`atomic_file_v1`；pin null/加载失败 → false，不抛坏 startup；Linux 判定不变。
  - Windows ensure → `ensureProtectedDirectory`+`verify private_rw`；write → `durableAtomicReplaceFile`；read → `readProtectedFile` 先 DACL+identity 再既有 strict JSON parser；snapshot identity = vol/file_id/size；`sameSnapshot` 平台 union（Linux dev/ino 不变）；CAS 写前 sameSnapshot + replace + readback raw exact；missing→null；DACL 问题 → unavailable/write_failed，不 ready。
  - 测试 seam：`deps.windowsDccNativeAddon` + test-hooks env + 进程级 override；**不**把 package 动态 pin 接入生产 loader。
  - smoke：`scripts/smoke-dcc-windows-attestation.mjs`（temp abrain、状态机、DACL/CAS/六条件、production pin-null unavailable）。
  - **不等于** `WIN-DCC-READY` / production acceptance。
- **Policy stable-view Windows durable path integration（2026-08-06；pin null → 生产仍 fail-closed）**：
  - Linux 保持 latest symlink + POSIX staging rename；zero regression 入口为既有 publisher/reader/recovery smokes。
  - Windows：`latest` = protected private_rw regular pointer file，严格编码 `bundles/<64 hex>\n`；`durableAtomicCreate/Replace` + `readProtectedFile`；stable 根/bundles/bundle/artifacts/latest 均 private_rw；弱/继承/tamper DACL、reparse、类型错误 fail-closed。
  - Bundle：final unique hash dir + create-only 全文件后才切换 latest；same-hash idempotence；crash before latest 保留旧 view；无 symlink / 无 TS lockfile / 无普通 Node rename 作为耐久发布。
  - Reader：strict valid 可注入；missing/invalid/tampered → loud zero；无 compiled/D3/legacy fallback；Windows 专用 reason（`latest_not_regular`/`latest_tampered`/`windows_native_unavailable`）不泄露原生错误。
  - 模块：`proposition-policy-stable-view-windows-native.ts`（生产零参数 load 成功缓存；测试 ALS/override 需 `PI_ASTACK_ENABLE_TEST_HOOKS=1`）。
  - fsyncDirectory：Windows 不再 EPERM 崩（验证 exact directory；文件耐久由 native WRITE_THROUGH 或 file fsync 承担）。
  - smoke：`scripts/smoke-proposition-policy-stable-view-windows.mjs`（temp package dynamic pin；publish/read/injection、malformed/tamper/missing、contention/idempotence、crash-before-latest、switch）。
  - **Edge journal / edge-protocol-shadow Windows durable path integration（2026-08-06；pin null → 生产仍 fail-closed）**：
    - Linux 保持既有 OFD lock + durableAtomicCreateFile + O_APPEND audit + POSIX mode/fsync 合同；格式与行为 zero-regression。
    - Windows 生产物理层：`edge-protocol-shadow-windows-native.ts`；layout → `ensureProtectedDirectory` private_rw（existing weak/tampered **不** auto-repair）；create → native `durableAtomicCreateFile` no-replace；audit append → create-if-absent + `durableAppendFile`（file-identity mutex，**不**与外层 `journal/lock` retained mutex 同目录）；read/validation → `readProtectedFile` + 字节上限；目录/文件 `verifyProtectedPath`。
    - 跨进程协调：外层 `withRetainedDirectoryLock(journal/lock)`；append 内层为 audit 文件 identity mutex；journal records 为 create-only（无 append mutex）。禁止 TS lockfile / 普通 Node append/rename 作为生产 durable 路径。
    - crash partial JSONL：Windows reader/audit fail-closed；下一 writer 仅 append，不得静默截断/洗白。
    - 生产 addon：零参数 load 成功缓存；temp-addon 注入需 `PI_ASTACK_ENABLE_TEST_HOOKS=1`（ALS/explicit deps/gated override）；pin null 生产 fail-closed。
    - smoke：`scripts/smoke-edge-protocol-shadow-windows.mjs` + 通用 `smoke-edge-protocol-shadow` 在 win32 上注入 temp package；source closure / package scripts 已登记。
    - **不等于** `WIN-EDGE-JOURNAL` / production acceptance。
  - **2026-08-06 审查闭合（implementation；仍 ≠ production acceptance）**：
    - `ensureStableViewProtectedDirectory` **不再**对已有 `DACL_INVALID` 目录 `setProtectedPath` 自动修复；existing weak/tampered fail-closed；仅 native ensure 创建新目录。
    - **绝不** rm/recreate content-addressed bundle 目录。same-hash 异常：先严格判 protected latest 指向；live latest→该 hash 时 partial/collision/foreign fail-closed 不修；latest 不指向/不存在时仅允许安全补齐 crash residual（dir protected、条目为五 artifact 子集、已存在 artifact protected+bytes exact、extra/collision/DACL fail；create-only 缺文件；exact verify；不原地替换已有 artifact）。
    - native atomic replace temp 文法确认：`.latest.pi-astack-tmp.<pid>-<nanos>.tmp`。publisher 持锁清理 stable root 下严格匹配的 regular+private_rw latest temp；unsafe type/DACL fail；reader 允许并忽略该 exact temp（publish 窗口 foreign_root）；其他 foreign 仍 fail。binding `mutation_inventory` 诚实列出 `transient_prefixes=[.latest.pi-astack-tmp.]` + `cleanup_required=true`；bundle create-only 不在 stable root 生成 temp，不虚构前缀。
    - Windows reader artifact 读使用 hard artifact 上限，TS 按 runtime max/total 判 oversize；native `TOO_LARGE` → `oversize`；latest > pointer max → `latest_invalid`（非 `latest_tampered`）。
    - test addon ALS/override 在 resolve 时重查 `PI_ASTACK_ENABLE_TEST_HOOKS`；reset/has singleton test API 亦 gate；生产 API 显式 addon 仍有 env gate。
    - latest 首次 create collision：读回 exact same → idempotent，否则 fail。
    - Linux reader：严格 existing publisher temp 文法（`.staging-...` dir / `.latest-...` symlink）在 publish 窗口可忽略；近似名/unsafe type 仍 foreign；**未**改 POSIX 写协议。
    - smoke 增补：tampered root/bundles DACL 不自动修；live partial/collision 不删不洗白；non-live residual 安全补齐；native latest temp 清理/忽略与 foreign 近似名拒绝；oversize reason；hooks unset 后 override 不可用。Windows stable-view smoke 20 项通过；POSIX publisher/reader/recovery 在 win32 上 SKIP。
  - **不等于** `WIN-STABLE-VIEW-INJECTION` / production acceptance。
- **Adapter 接线（2026-08-06）；pin=`null` → 实际 production 仍 fail-closed**：
  - 新增 `extensions/_shared/retained-directory-lock.ts`（platform-neutral production adapter）。
  - Linux → 现有 `acquireRetainedDirectoryOfdLock`（语义全保留；wrapper 补 `assertIdentity`）。
  - Windows → production `loadWindowsNativeAddon` singleton + `tryAcquireRetainedDirectoryLock`；native null→BUSY；错误映射 `RetainedDirectoryLockError`；**绝不** fallback TS lockfile；pin null → `WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING` fail-closed。
  - 其它平台 → `RETAINED_DIRECTORY_LOCK_UNSUPPORTED`。
  - 已改非 fd 生产调用点：canonical-mutation-barrier、l1-validated-scan-cache、edge-protocol-shadow `withJournalWriter`、sediment intake、stable-view recovery audit、worker-rpc、stable-view publisher lock（Linux 保留 fstat(fd)；Windows `assertIdentity` 且接受 fd null）。
  - **未改** fd/procfd 消费者：proposition-lifecycle-freshness-production-core/D3、real-policy append 等仍直连 OFD Linux-only。
  - 测试 seam：`retainedDirectoryLockTestApi`（显式函数；temp package dynamic pin 注入；无生产 env override）。
  - smoke：`scripts/smoke-retained-directory-lock.mjs` + `smoke:retained-directory-lock`。
  - **未**改 settings / `~/.abrain`；**未**写 production pin；**不等于** production acceptance。
- **不得**因本切片勾选任一 acceptance criterion。`WIN-LOCK-CONTENTION-CRASH` / `WIN-DACL-TAMPER` / `WIN-DCC-READY` 等仍要求 production integration / 完整外证；当前 temp-root + dynamic pin multi-process smoke **不是**这些门的全部证据。
- **协议 supersede（审查实证）**：初版 `CreateFileW(DELETE)` 目录 handle 方案已被证据 supersede 并移除。现行协议为零文件 **Global named mutex**（无 sentinel / 无 ADS）：目录仅 identity probe；mutex 名 `Global\pi-astack-retained-v1-<sidhash8>-<volumehex16>-<fileidhex32>`；`CreateMutexW` + protected SD + handle 级 DACL verify + `WaitForSingleObject(0)`。
- **Named mutex default DACL / predictable-name squat**：实现探测路径已用 current-primary-TokenUser protected DACL + SID hash 短标识闭合；**仍不得**据此勾选 criteria 或接生产（DCC/pin/TOCTOU/production 接线仍 blocker）。
- 已落地（2026-08-05 P1 封闭审查 + P2/P3 垂直切片）：
  - **Core ABI v1 + 可扩展 capabilities**：
    - TS loader — ABI=1；capabilities allowlist = sorted `{atomic_file_tempdir_v1, atomic_file_v1, protected_dacl_v1, retained_directory_lock_v1}` + must-contain retained；lease 含 `acquired_after_abandon`；错误闭集含 `MUTEX_NAMESPACE_DENIED`/`DACL_INVALID`/`IO_FAILED`/…；map error **前缀锚定**（`RETAINED_DIRECTORY_LOCK_`/`PROTECTED_DACL_`/`ATOMIC_FILE_`）；identity 规范化失败会 close raw lease；BUSY=`null`；pin=`null`；`__TEST` 暂存。
    - schema — capabilities 为 extensible array（`minItems`/`uniqueItems`/`items.pattern`/`contains retained`），**不再** exact const。
  - **Native lock（TLS + 路径合同 + protected DACL）**：
    - `crate-type = ["cdylib", "rlib"]`；cargo test/clippy 为真实 gate；模块化 `pathutil`/`security`/`protected_path`/`atomic_file`。
    - held set = **owner-thread-local**；同线程重入 → BUSY；跨线程靠 OS `WAIT_TIMEOUT`。
    - mutex 名含 **current TokenUser SID FNV-1a 短 hash（8 hex，不暴露 SID）** + volume/fileid。
    - `CreateMutexW` 传入 current-TokenUser protected SD；new/existing 均在 Wait **前** handle 级 `GetSecurityInfo`+`GetAce`+`EqualSid` 复核 owner/group/DACL；weak/foreign/squat → `DACL_INVALID`（**不得**当 BUSY）。处理 `ERROR_ALREADY_EXISTS`。
    - `WAIT_ABANDONED` → `acquired_after_abandon=true`。
  - **protected_dacl_v1**：
    - current primary TokenUser via `OpenProcessToken`+`GetTokenInformation(TokenUser)`。
    - owner/group=TokenUser；DACL present/non-defaulted/protected；exact one ACCESS_ALLOWED ACE；no inherited flags；mask 按 profile/kind exact。
    - profiles closed set：`private_rw`（file/dir FILE_ALL_ACCESS）、`package_rx`（dir traverse/read；file read/execute；不授 write/delete）。
    - exports：`ensureProtectedDirectory` / `setProtectedPath` / `verifyProtectedPath`。
    - 威胁边界（合同）：owner 隐式可改 DACL；same-token 恶意进程不在合同内。
  - **atomic_file_v1**：
    - 路径 absolute local NTFS/no reparse；destination parent 必须 native verify `private_rw`。
    - `durableAtomicCreateFile`：parent private_rw + **no-DELETE parent handle guard**；same-dir unique temp CREATE_NEW + private_rw DACL；`write_all_flush` 显式 64KiB WriteFile + FILE_FLAG_WRITE_THROUGH + FlushFileBuffers；same-volume 原子 no-replace publish；collision → false；type(dir) → NOT_FILE；**MoveFileEx 成功即 authoritative published**（无 post-publish path reverify）；TempFile 空 path 不 DeleteFileW。
    - `durableAtomicReplaceFile`：同上 parent guard；`MOVEFILE_REPLACE_EXISTING|WRITE_THROUGH`；SHARING 可重试；ACCESS_DENIED 重试耗尽 → ACCESS_DENIED；dir dest → NOT_FILE；成功后不 post-publish reverify。
    - `durableAppendFile`：identity → mutex wait → open 后 **query_file_id_info exact 比较**，变更 → IDENTITY_CHANGED 且不写；同 DACL named mutex；64KiB chunk flush。
    - `readProtectedFile`：一次 handle 读；handle 级 DACL/reparse/identity；ceiling；**maxBytes=0 → INVALID_PATH（非 TOO_LARGE）**；前后 identity/size 不变。
    - **Durability 诚实声明**：temp content 依赖 WRITE_THROUGH + FlushFileBuffers；publish 是 same-volume atomic rename；**MOVEFILE_WRITE_THROUGH 文档只保证 copy+delete 路径 flush**，不声称同卷 directory metadata flush / 硬件 FUA；函数名保留，residual 明确。
    - **Append/mutex 名 squat residual**：predictable Global 名仍可被同机 weak DACL DoS；acquire fail-closed。same-token malice 继续 out-of-contract。
  - **构建 provenance 分离**：默认 development（dirty 允许，`development_only=true`）；production 模式要求 clean；source closure 含新 smoke；默认 dev 双 clean repro；native_tests/clippy 真实 gate。
  - **Smoke（三个）**：
    - ABI smoke — 可扩展 capabilities + 新错误码闭集。
    - retained smoke — controller/worker；temp package binaryPath；16 进程 barrier 等。
    - durable-dacl smoke（真实 probe）— private/package_rx；icacls tamper exit0+readback 后 native 拒；foreign group 收敛；mutex squat helper 默认 DACL → DACL_INVALID/MUTEX_NAMESPACE_DENIED（非 BUSY）；16 create err=null/created false=collision/barrier skew 有界；replace reader barrier+success/error counts+必见 OLD+NEW；16×1MiB append head/tail hash+LEN 哨兵；kill-during-attempt ready→native+多 delay 强杀 dest 仅 exact OLD|NEW；leaf+ancestor junction 拒；maxBytes=0 非 TOO_LARGE；temp 无残留。
- **P0 退出判定**：TOCTOU 仍未闭合；production pin 现 `null`；Linux zero-regression 外证入口未固化。
- **P1/P2/P3 判定**：均为 **implementation probe**（temp smoke 真机通过；DCC 物理层为 integration probe）；**有效生产仍受 pin null + final artifact 缺失阻塞**；**不等于**对应 acceptance criteria 已满足。
- Linux 侧：retained OFD / DCC production acceptance 继续有效。
- Windows 侧：pin=`null` → DCC 仍 `attestation_unavailable`；零参 load fail-closed；test seam 下物理层/状态机可跑；adapter 已接线；**未**改 settings / `~/.abrain`。
- 工具链：blocker 已解决。
- **TOCTOU + DCC：仍 blocking**。
- 本文件是唯一 living plan。

## Phase Table

| Phase | 名称 | 状态 | 前置 | 退出证据 | 下一动作 |
|---|---|---|---|---|---|
| P0 | ABI / tests scaffold | contract+build probe done；正式退出证据未齐 | 本计划生效；工具链可用 | core ABI v1 + capabilities 合同；fail-closed 测试；真实 win32-x64 构建探测。**正式退出仍缺**：native/package-protected TOCTOU 闭合、production pin 策略落地路径、Linux regression harness 外证入口 | 闭合 TOCTOU / 明确 pin 落地路径；不要把 temp smoke 当成 P0 全退出 |
| P1 | native lock | named-mutex **implementation probe**（protected DACL+SID hash 已落地；未接生产） | P0 合同可用；工具链可用 | Windows 跨进程 contention + crash release **生产路径**外证；Linux OFD zero-regression | 生产接线前：loader/provenance 门 + 去掉 `__TEST` + DCC 合同；禁止以 temp smoke 当 production acceptance |
| P2 | atomic pointer / durable replace | **implementation probe**（atomic_file_v1 temp smoke；未接生产） | P1 合同可用 | Windows durable replace / atomic pointer **生产路径**外部证据；相关 Linux 路径 zero-regression | 生产接线前完成 pin/TOCTOU；进入 P3 DCC 接线评估 |
| P3 | protected DACL + DCC | **implementation probe + DCC physical integration**（native temp smoke；canonical-control 已接物理层，pin=null 仍 fail-closed） | P2 合同可用 | protected-DACL **生产**外证；DACL tamper fail-closed；DCC 不再以 `attestation_unavailable` 作为唯一终态，且仅在 DACL 验收后才允许 ready 路径 | 生产 pin + TOCTOU 闭合后评估 production acceptance；进入 P4 |
| P4 | Windows production acceptance | not started | P3 退出 | 第一矩阵真实主机 production acceptance dossier；全部 stable criteria 有匹配外证 | 满足 Definition of Fully Complete 后可关闭本计划 |

任一阶段完成**不**自动放宽 Frozen Contracts，也**不**自动勾选未获外证的 criteria。

## Acceptance Criteria

### Evidence Discipline

下面每一行都使用 goal parser 的真实格式 `- [ ] (criterion-id) text`。ID 是稳定证据主键；不得复用或改名。只有外部证据已经存在并且与当前 criterion 文本匹配时，才允许用普通 edit 把 `[ ]` 改成 `[x]`，随后用 `goal_check` 记录验证；裸 `[x]`、模型自述或旧 goal 的 evidence 都不算 verified。`goal_check` 的 evidence 必须是 `cmd:<shell>`、`file:<path>` 或 `git:<sha>`。复合 production 条件优先固化为不可变 dossier / content-addressed manifest / 含 dossier 的 Git commit，再由 `file:` / `git:` 指向。criterion 文本或声明输入发生语义漂移会使既有 evidence stale，必须重新检查。**所有项目初始未完成；本切片不得勾选任何项。temp multi-process smoke ≠ production acceptance。**

- [ ] (WIN-LINUX-ZERO-REGRESSION) Linux retained OFD lock、既有 Linux DCC attestation 与相关 sediment/LSEA production 路径在引入 Windows native 路径后保持行为与 fail-closed 语义不变，并以 Linux 侧外部回归证据证明 zero-regression。
- [ ] (WIN-LOCK-CONTENTION-CRASH) 在第一支持矩阵的真实 Windows 主机上，native lock 证明跨进程 contention（第二持有者得到明确 BUSY/等价 closed 结果、不破坏第一持有者）以及 holder crash 后锁可被后续进程合法获取；证据不得仅来自同进程 mock。**注：当前 temp package + dynamic pin smoke 是实现探测，不是本 criterion 的完整 production integration 外证。**
- [ ] (WIN-STABLE-VIEW-INJECTION) 在第一支持矩阵的真实 Windows 主机上，Policy stable-view 的 durable pointer/read/injection 路径可按现有 production 合同工作：strict-valid 可注入、invalid/missing loud zero injection、无 compiled/D3/legacy fallback；相关 durable 写入不依赖纯 TS lockfile 生产 fallback。
- [ ] (WIN-EDGE-JOURNAL) 在第一支持矩阵的真实 Windows 主机上，edge journal 相关耐久路径（含跨进程协调所需的 native lock/durable replace 边界）按既有 closed 合同工作，并以外部证据证明成功路径与 fail-closed 路径。
- [ ] (WIN-DACL-TAMPER) Windows protected-DACL writer/verifier 在对象 ACL 被篡改、非 current-primary-TokenUser、或权限弱于合同要求时 fail-closed；不得把 inherited/default ACL 或“文件存在即可读”当作通过。
- [ ] (WIN-DCC-READY) 仅在 protected-DACL writer/verifier 完成并验收后，Windows DCC 才允许离开单纯 `attestation_unavailable` 终态；ready 路径必须满足既有六条件观察合同，且 attestation 私有对象受 protected-DACL 保护。
- [ ] (WIN-BINARY-PROVENANCE) 每个生产加载的 win32-x64 N-API binary 均可复核绑定 source、toolchain、target、hash 与 provenance；addon 缺失、错误架构或 hash 不符时生产路径 fail-closed，且不发生运行时下载或现场自动编译。**注：TOCTOU 仍未完全闭合；production pin 仍为 null。**
- [ ] (WIN-PRODUCTION-ACCEPTANCE) 在第一支持矩阵真实 Windows 主机上完成 production acceptance：覆盖 native lock、durable replace/atomic pointer、protected-DACL、DCC、stable-view injection 与 edge journal 的联合外证 dossier；WSL/synthetic-only/模型自述不计入本项。

## Current Blockers

- **工具链缺失：已解决** — `C:/BuildTools` VsDevCmd + MSVC 14.44 + rustc/cargo `x86_64-pc-windows-msvc`；`build:windows-native-addon` 真实 release 构建通过。
- **final source commit + production pin/artifact 待建立（主 blocker）**：package/install/unlock/verify plumbing 已就绪；旧 892ddeb live 已 unlock 移出，pin 已回 `null`；须 final source commit → clean-tree production build + package + artifact commit + tracked-in-HEAD 后才可 full dossier gate / P4 accepted。
- **hash→dlopen TOCTOU（部分缓解，未完全闭合；仍 blocking）**：held fd pre-hash + **same-fd post-dlopen rehash** + fd/path identity best-effort + production package_rx 三点（跨 token 重写边界）。**仍无** native bootstrap 原子保证；ancestor-delete-handles 与 same-token/admin 恶意残留合同外。**不得**因 `same_fd_post_dlopen_rehash:"pass"` 声称 TOCTOU 已完全解决；仍绑定 `WIN-BINARY-PROVENANCE`。
- **Adapter 已接线；有效生产取决于 final pin+package_rx（现 pin=`null`）**：非 fd 调用点已走 adapter；pin null → 零参 fail-closed。
- **Named mutex 默认 DACL / squat（实现探测已闭合，有效生产仍 blocker）**：实现探测路径已用 protected DACL + SID hash 名。**Availability residual**：predictable Global 名同机 squat 仍可 DoS（fail-closed）；same-token malice out-of-contract。
- **DCC / production acceptance（仍 blocking）**：DCC 物理层已接 native；sandbox 无法合法构造完整 live daemon/authorization ready 六条件时 dossier 记 `not_covered`/`partial`（不假 pass）。Adapter/DCC/package plumbing **不等于** production acceptance。
- **DELETE 目录 handle 方案已 supersede**：不得回退。
- 纯 TS lockfile 禁止作为生产 fallback。
- Windows production acceptance dossier：workers 开发验证全绿；full gate 待 final artifact；**accepted:false** 直至 final rebuild/package/artifact + 全准则覆盖；P4 前不得宣告完成。

## Next Probe

1. **建立 final source commit → clean-tree production build + package + artifact commit**：pin/artifacts tracked-in-HEAD；跑 `smoke:windows-native-package` + 7 个 post-pin smokes；仍不自动勾选 criteria。
2. **跑 `dossier:windows-native-production-acceptance` 全量**（final artifact 就绪后）：gates 通过后收集各 section 外证；DCC `not_covered` 保持 partial；不得为补 DCC 改生产合同。
3. **TOCTOU residual 评估**：same-fd rehash + package_rx + fd/path identity 之后仍开放的竞态（无 native bootstrap 原子性；ancestor-delete-handles / same-token-admin）；绑定 `WIN-BINARY-PROVENANCE`。
4. **Linux regression 外证入口**：标明并运行 `WIN-LINUX-ZERO-REGRESSION` 证据。
5. **P4 勾选纪律**：仅当 dossier `accepted:true` 且证据匹配时才允许 `goal_check`；本切片不勾。

## Execution Order (Planned)

1. **P0 ABI/tests**：冻结窄范围导出表面、加载器 fail-closed、hash/provenance schema、Linux regression harness 入口；解决或正式记录工具链路径。
2. **P1 native lock**：实现并外证 Windows 跨进程 contention 与 crash release；保持 Linux OFD 路径不动。
3. **P2 atomic pointer / durable replace**：实现 Windows durable pointer/replace；覆盖 stable-view `latest` 一类合同所需语义。
4. **P3 protected DACL + DCC**：实现 current-primary-TokenUser protected-DACL writer/verifier；通过 tamper 门后，才允许 Windows DCC ready 路径。
5. **P4 production acceptance**：在第一矩阵真实主机上跑联合验收，固化 dossier，再关闭本计划。

## Replanning Protocol

现场证据、代码、settings 或真实 Windows 主机状态与本计划冲突时，先停止受影响执行，整节更新 Current State，并在 Decision Log 追加日期、冲突证据、影响范围、采用的新路径，再继续工作。Decision Log 只追加、不删除、不重写历史；错误决定通过后续条目 supersede。任何 criterion 文本的语义修改都会使匹配 evidence stale；修改前必须说明原因，修改后必须重新验证。不得为让 goal 变绿而拆小、放宽、改名、删除或重新解释 acceptance gate。若门确需改变，必须保留旧文本与裁决记录，并获得不低于原决策强度的重新确认。

## Decision Log

- 2026-08-05：创建本 living plan 为 Windows 原生支持唯一执行计划。已确认：生产级目标；长期窄范围 N-API addon；Linux retained OFD 行为不变；纯 TS lockfile 不作为生产 fallback；第一支持矩阵为 Windows 10 1709+/Windows Server 2019+、local NTFS、win32-x64、Node >=22.19 与 Node 24、`NAPI_VERSION` 9；DCC 在 protected-DACL writer/verifier 完成并验收前继续 `attestation_unavailable` fail-closed；addon 缺失/错误架构/hash 不符 fail-closed；不运行时下载、不现场自动编译；binary 必须绑定 source/toolchain/target/hash/provenance。阶段划分为 P0 ABI/tests、P1 native lock、P2 atomic pointer/durable replace、P3 protected DACL+DCC、P4 Windows production acceptance。当前 blocker：本机只有 rust/cargo，无 cl/cmake/msbuild/node-gyp。本条目不宣称任何实现已完成，所有 acceptance criteria 保持未勾选。
- 2026-08-05：落地 P0 ABI/tests scaffold（非 P0 退出）。新增 `extensions/_shared/windows-native-addon.ts`（初版曾误标 ABI v1）+ `schemas/windows-native-addon-manifest-v1.json` + `scripts/smoke-windows-native-addon.mjs` 与 `smoke:windows-native-addon`。明确**不**接入 retained-directory-ofd-lock / DCC / edge / publisher 生产调用点。工具链 blocker 保留；全部 8 个 acceptance criteria 保持未勾选；**不**宣称 P0 完整退出。
- 2026-08-05：按审查反馈修正 P0 scaffold（仍非 P0 退出、仍不接生产调用点）。(1) 仅身份探测的 ABI 改为 **provisional ABI 0**；schema/version/文件名改为 `windows-native-addon-manifest-v0-provisional`，删除旧 v1 schema；P0 退出前还须冻结含 lock/durable replace/protected DACL 的 ABI v1。(2) 源码内 manifest SHA256 pin；生产默认 pin=`null` → `WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING` fail-closed；test seam 可传 `expectedManifestSha256`；先校验 raw bytes hash 再 parse。(3) 生产入口 `loadWindowsNativeAddon()` 零参数；options/seam 仅 `__TEST`；smoke 断言 arity=0 并 grep 无外部 `__TEST` 引用。(4) path 拒绝 symlink/reparse 可观察面（lstat/realpath 逐级；`PATH_UNTRUSTED`）。(5) `minimum_node` 严格相等 + prerelease-aware 运行时比较；删除不可达 platform/arch/napi 二次分支与死错误码 `PLATFORM_MISMATCH`。(6) hash→dlopen 增加 fd pre/post identity best-effort，**明确不声称完全解决**；Current State/Blocker/Decision Log 记录须由 native/package-protected 加载在 P0/P1 前闭合并绑定 `WIN-BINARY-PROVENANCE`；测试覆盖 load 期间替换被 post-check 拒绝。(7) 清理 fixture 死逻辑；错误码集合精确断言；真实当前平台零参数生产入口 fail-closed。全部 acceptance criteria 仍未勾选。
- 2026-08-05：实施 **P0→P1 首个真实垂直切片**（仍不接生产、仍不勾选 8 criteria）。(1) **Core ABI 冻结为 v1**；功能扩展改为 versioned capabilities；初始 exact capability `["retained_directory_lock_v1"]`；manifest/schema 升级为 `windows-native-addon-manifest/v1` 并新增 capabilities exact sorted unique 数组；**删除** v0 provisional schema。(2) TS loader 校验 ABI v1、capabilities、retained lock lease 接口；未 advertise 不得调用；生产 pin 仍 null；零参数生产 loader 仍 fail-closed。(3) 新增真实 napi-rs addon：`native/windows/{Cargo.toml,Cargo.lock,build.rs,src/lib.rs}`（napi 3.12.0 + windows 0.62.2，cdylib，NAPI 9）；**初版** Win32 目录锁曾用 `CreateFileW(DELETE)` 目录 handle（无 sentinel；DELETE 不 share；reparse 拒绝；FILE_ID_128 身份；BUSY=null）。(4) build driver + retained-lock smoke 多进程探测。(5) 工具链 blocker 解决。(6) TOCTOU 未闭合；生产未接。全部 criteria 未勾选。
- 2026-08-05：**P1 协议 supersede — DELETE 目录 handle → zero-file Global named mutex**（仍不接生产、仍不勾选 criteria）。审查实证表明 DELETE 目录 handle 会被 foreign CWD 劫持/阻止 chdir，且 ancestor junction 破坏互斥；因此替换为：目录仅 identity probe（share READ|WRITE|DELETE + BACKUP_SEMANTICS|OPEN_REPARSE_POINT；拒 leaf/ancestor reparse；`GetFinalPathNameByHandleW` 与规范输入一致）；identity = volume u64 hex16 + FILE_ID_128.Identifier hex32；mutex `Global\pi-astack-retained-v1-<vol>-<fid>` + `WaitForSingleObject(0)`；lease 持 mutex HANDLE + owner tid；close/Drop owner 线程 ReleaseMutex+CloseHandle。原生固定前缀错误闭集由 TS 映射为 `WindowsNativeAddonError` 闭码；BUSY 仍 null。构建强制 `--locked --offline --target x86_64-pc-windows-msvc`；source closure 扩展；`build_id`/`toolchain_id` 确定性；默认双 clean rebuild 复现；dirty→`development_only`；`rust-toolchain.toml` pin 1.97.1。schema capabilities 改为 exact const；manifest/getBuildIdentity 绑定 `toolchain_id`。smoke：非目标平台/`缺 artifact`→`SKIP:`；16 进程 barrier、foreign CWD、持锁 chdir、ancestor junction、relative、alias、GC、error no-leak。**默认 mutex DACL 仍非 protected → P3 前不可生产接线**；`__TEST` 暂存待生产打包前拆除；TOCTOU/pin 仍 blocker。
- 2026-08-05：**wrong-thread Drop fail-closed 修正**（仍不接生产、仍不勾选 criteria）。旧实现错误假设 wrong-thread `CloseHandle` 后 fresh mutex 安全并 clear `PROCESS_HELD`——last-handle close 可销毁 named kernel object，随后 `CreateMutexW` 装上新对象，造成同进程/跨进程双持。现合同：owner close/Drop = ReleaseMutex+CloseHandle+clear held set；wrong-thread explicit close = `WRONG_THREAD` 且保留 lease；wrong-thread Drop = 不 Release/不 Close/不 clear（泄漏 raw HANDLE 直至 owner thread/process exit）。TS FR 仅在 close 成功后标记 closed。覆盖：`native/windows` cargo test 真实 OS 线程（N-API Class 不可转入 worker_threads，不伪造）；smoke owner-thread GC/FR 释放 + worker_threads 边界/sibling isolate OS BUSY。
- 2026-08-05：**封闭 Windows lock v1 审查项（仍不接生产、仍不勾选 criteria）**。(1) 全局 `PROCESS_HELD` → **owner-thread-local** held set；记录 owner thread HANDLE（DuplicateHandle）防 TID reuse；ReleaseMutex 失败 → `MUTEX_FAILED` 不伪报 closed；wrong-thread Drop 可泄漏 mutex+thread handle。(2) lease `acquired_after_abandon`（WAIT_ABANDONED）。(3) 路径合同：拒 verbatim/device/空白/DOS device；内部 `\\?\`；`CompareStringOrdinal`；拒 8.3；组件级 ancestor walk；补 long/unicode/junction 测试。(4) `MUTEX_NAMESPACE_DENIED`；名 squat → **S0 P3 blocker**（后被 protected DACL 切片 supersede 为实现探测已闭合）。(5) capabilities 可扩展（contains retained + allowlist），去掉 exact const 矛盾。(6) native `cargo test`+`clippy -D warnings` 为 build gate；`crate-type` 含 rlib；build-info 记录。(7) TS identity 失败 close raw lease；map 前缀锚定；GC 无 expose hard fail + 自 reexec `--expose-gc`。(8) retained smoke controller/worker：只 require 校验后的 temp package binaryPath；cleanup hard fail。(9) build provenance dev/production 分离；剥离 ambient RUSTFLAGS 等；build_id 含 mode/repro/config；dirty 树不尝试 production。(10) plan 更新真实状态。
- 2026-08-05：**P2/P3 垂直切片 implementation probe（仍不接生产、仍不勾选 criteria、不改 settings/~/.abrain）**。(1) capabilities 扩展为 sorted known set `atomic_file_v1`/`protected_dacl_v1`/`retained_directory_lock_v1`；core ABI 保持 1；manifest 与 native self-report exact match。(2) `protected_dacl_v1`：TokenUser owner/group + protected exact single ACE；profiles `private_rw`/`package_rx`；exports ensure/set/verify；handle 级 GetSecurityInfo/GetAce/EqualSid 复核；威胁边界写入合同。(3) named mutex：protected SD 创建；Wait 前 verify；weak/foreign/squat → `DACL_INVALID`；mutex 名加 SID hash8。(4) `atomic_file_v1`：durableAtomicCreate/Replace/Append + readProtectedFile；parent private_rw 门；MoveFileEx WRITE_THROUGH residual 诚实声明；目录 Flush 不伪造成功；NTFS/FUA 残余声明。(5) smoke 初版 controller/worker 探测。(6) 默认双 clean repro + cargo test/clippy gate。(7) DCC/pin/TOCTOU/production 接线仍 blocker。
- 2026-08-05：**P2/P3 implementation probe 审查项真实修复（仍不接生产、criteria 全不勾）**。删除 fake crash worker → kill-during-attempt（ready→started→native replace 大 payload + 多 delay 强杀；dest exact OLD|NEW；无 started 不得称 crash 覆盖）。replace reader barrier+success/error counts+必见 OLD+NEW+closed 错误码。create16 err=null / created false=collision / barrier skew 有界。append 16×1MiB head/tail hash+LEN 哨兵 + native 64KiB chunk。icacls tamper exit0+readback 后拒。leaf+ancestor junction 真机拒。mutex squat 专用 Rust helper binary。移除 post-publish path reverify（MoveFileEx 成功即 published）。append open 后 identity exact。parent no-DELETE guard。setProtectedPath 两阶段 owner/group 收敛。ACL DWORD 对齐；KernelMutex+package_rx Result 拒绝静默 all-access。TempFile 空 path 不 DeleteFileW；删 nul；build.rs rerun modules。durability/MOVEFILE_WRITE_THROUGH residual 文档纠正。append Global 名 DoS residual。maxBytes=0≠TOO_LARGE；map fallback FAILED。
- 2026-08-06：**platform-neutral retained lock production adapter 接线（pin 仍 null → 实际 production 仍 fail-closed；criteria 全不勾；不改 settings/~/.abrain）**。新增 `extensions/_shared/retained-directory-lock.ts`：Linux 委托现有 OFD（不改 `retained-directory-ofd-lock.ts` 关键语义）；Windows 用 production loader singleton + `tryAcquireRetainedDirectoryLock`，null→BUSY，错误映射 `RetainedDirectoryLockError`，禁止 TS lockfile fallback；其它平台 unsupported。测试 seam `retainedDirectoryLockTestApi`（temp package dynamic pin，无 env override）。仅改非 fd 生产调用点（barrier / L1 scan mutex / edge journal writer / sediment intake / recovery audit / worker-rpc / publisher；publisher Linux 保留 fstat、Windows assertIdentity+fd null）。fd 消费者（D3 lifecycle / real-policy append）仍直连 OFD。新增 `scripts/smoke-retained-directory-lock.mjs`。**明确：adapter 接线 ≠ production acceptance；pin null 时 Windows 生产路径继续 fail-closed。**
- 2026-08-06：**DCC attestation 物理层 implementation integration**（仍不写 production pin、criteria 全不勾、不改 settings/~/.abrain）。`canonical-control.ts` 在 win32 上经 production 零参数 loader 成功且具备 `protected_dacl_v1`+`atomic_file_v1` 时才允许 attestation I/O；pin null → `attestation_unavailable` fail-closed 且不抛坏 startup。物理层：ensureProtectedDirectory/verify private_rw；durableAtomicReplaceFile；readProtectedFile + 既有 strict JSON；vol/file_id/size identity；sameSnapshot 平台 union；CAS 写前 sameSnapshot + replace + raw readback。测试 seam `deps.windowsDccNativeAddon`（temp package，非生产动态 pin）。新增 `scripts/smoke-dcc-windows-attestation.mjs`。Linux 状态机/严格 JSON/generation/六条件不变。
- 2026-08-06：**Policy stable-view Windows durable pointer/read production wiring**（仍不写 production pin、criteria 全不勾、不改 settings/~/.abrain）。Linux symlink 路径保持不变。Windows publisher/reader 走 native protected DACL + atomic_file：`latest` 为 regular pointer file（`bundles/<64hex>\n`）；bundle 用 final hash dir create-only 全文件后才切换 latest；reader loud zero 无 compiled/D3/legacy fallback。新增 `proposition-policy-stable-view-windows-native.ts` + `smoke-proposition-policy-stable-view-windows.mjs`；修复 Windows `fsyncDirectory` EPERM（验证目录，不伪造成功于文件耐久）。测试 seam 门控 `PI_ASTACK_ENABLE_TEST_HOOKS=1`（ALS/override）；生产仅零参数 load 成功缓存。**不等于** `WIN-STABLE-VIEW-INJECTION` production acceptance。
- 2026-08-06：**edge-protocol-shadow / edge journal Windows durable production wiring**（仍不写 production pin、criteria 全不勾、不改 settings/~/.abrain）。Linux 路径与 journal 格式不变。Windows：layout `ensureProtectedDirectory` private_rw（existing weak/tampered fail-closed，不 auto-repair）；source/record create → native `durableAtomicCreateFile`；audit JSONL → create-if-absent + `durableAppendFile`；read → `readProtectedFile`；锁序 = 外层 retained `journal/lock` + 内层 audit file-identity mutex（不同对象，无同线程重入死锁）。新增 `edge-protocol-shadow-windows-native.ts` + `smoke-edge-protocol-shadow-windows.mjs`；通用 edge smoke 在 win32 注入 temp package；source closure / package scripts 更新；移除 dcc-worker-control 中 Windows fsync EPERM durable residual skip。**不等于** `WIN-EDGE-JOURNAL` production acceptance。
- 2026-08-06：**Windows edge 审查项闭合（implementation；criteria 全不勾；不改 settings/~/.abrain）**。(1) layout/audit 共用 `ensureWindowsEdgeLayoutPath` ownership：共享祖先 `.state/sediment` 已存在只验 exact 非 reparse（不要求 private DACL）；缺失共享祖先普通 Node mkdir + exact 复核（绝不 protected）；自 `edge-protocol-shadow` 起 native protected。(2) audit 并发：parent-dir retained lock 覆盖 exists/create-or-append；锁序 parent→file append mutex；同字节每次落一行；BUSY fail-closed；禁止 audit 嵌套 journal/lock（ALS）。(3) 新 capability `atomic_file_tempdir_v1` + `durableAtomicCreateFileWithTempDirectory`（同卷 protected staging；双 parent guard 按 identity 稳定排序；MoveFileEx no-replace；不改既有 same-dir create ABI）；edge records/sources 走 `tmpPath` dirname staging。(4) audit NOT_FOUND 先 verify parent；list JSON.parse → `journal_record_corrupt` 不泄内容。(5) 16 进程 smoke 加载后 rendezvous barrier + identical payload 行数=32。(6) `retainedDirectoryLockTestApi` acquire/reset/has 全 test-hooks 门。(7) 删除 NOT_FOUND/TOO_LARGE message regex fallback。(8) DACL tamper smoke 走真实 capture 集成 fail。(9) frozen-contract adapter win32 record/source 走 production zeroarg `readProtected` + 目录/文件 DACL fail-closed（Linux 不变）。**不等于** production acceptance；全部 8 criteria 仍未勾选。
- 2026-08-06：**Windows native production provenance/package plumbing**（仍 pin=null、不跑 production build、不 commit、criteria 全不勾）。(1) pin 拆到 `windows-native-addon-pin.ts`（package 输出，硬排除 source closure）。(2) `package-windows-native-addon.mjs` package/install/unlock/verify；package 仅 production build-info；exact LF manifest + pin 模板；install package_rx files→dir；unlock native private_rw 或固定 `icacls.exe` reset（只看 exit）。(3) 生产零参数 loader 成功后 package_rx 三点；`PACKAGE_ACL_INVALID`；test options 不强制 ACL；`__TEST.loadWindowsNativeAddon` 门控 test hooks。(4) Cargo `trim-paths=all`；toolchain_id 去 path/locale。(5) gitattributes/gitignore/package scripts/package smoke。(6) 现有 fd/path identity 保留；same-token/admin 合同外；package_rx 跨 token；无 PowerShell 热路径。**不等于** `WIN-BINARY-PROVENANCE` / production acceptance。
- 2026-08-06：**production package 首 commit 前放行项修复**（仍 pin=null、不 commit、criteria 全不勾）。(1) `CARGO_ENCODED_RUSTFLAGS` 显式 `-C`+`link-arg=/Brepro` + remap，assert 不覆盖丢失 config 语义；development dual repro 真跑。(2) manifest/BuildIdentity 冻结证据字段 `build_mode`/`reproducibility`/`native_tests`/`clippy`/`build_config_sha256`；build.rs 受控 env；gates 后 build；package 只收 production/dual_clean_match/passed/passed 并与 binary exact；schema/loader/fakes/smokes 同步；build_id preimage + `build_id_preimage_sha256` 可交叉核验。(3) `.gitattributes` 首行 `* text=auto eol=lf` + binary override；自身进 source closure；closure 拒 CRLF。(4) 生产 loader 校验 `PIN_SOURCE_COMMIT` 非 null/40hex = manifest.source_commit；test options 不要求。(5) `loadInstalledForAcl` throw 不 die；icacls fallback + method；writability probe；64MiB 上限；post-verify 失败恢复 pin/artifacts fail-closed；install ACL 部分失败 best-effort unlock。(6) package smoke 不破坏 live .node；tamper 走 temp；ACL gate 走 test-hooks enforcing 入口。(7) capability 四方 + manifest 字段静态同步；binary 敏感路径扫描。(8) PIN source field 测试。(9) 本 plan 更新、**不勾** criteria。
- 2026-08-06：**post-pin smoke 双态 + Windows production acceptance dossier 实现**（不 commit、criteria 全不勾）。(1) 7 个 post-pin 冲突 smoke 最小修：pin null 保留 fail-closed；pin live 允许并 child 验证 production zeroarg 正向；controller 永不因 live dlopen 阻塞 live 包覆盖/删除；temp suites 独立不称 production；pre/post 都能跑。(2) 新增 `scripts/dossier-windows-native-production-acceptance.mjs` + package script；进 build source closure；controller/closed worker；强制 win32-x64 + git clean + pin/artifact tracked-in-HEAD + source_commit 范围仅 package 输出 + package_rx；env 无 test hooks；禁止 __TEST/override/deps injection；每 case 独立 child + hard temp cleanup + ~/.abrain before/after guard；sections：provenance / retained-lock 16×3 + crash abandon / DACL tamper / stable-view（preview residual 诚实）/ edge / DCC（不可构造则 `not_covered`→`partial`）；exit0≠accepted。(3) **决策**：当前 live pin/artifact 仅 post-pin 开发验证（旧 HEAD），final 待 clean rebuild；dossier 已实现但未 accepted。(4) 不勾任何 criteria。
- 2026-08-06：**Windows production acceptance dossier 加固**（不 commit、criteria 全不勾）。(1) worker failure：`dieWorker`→throw `WorkerFail`；顶层 catch 统一 emit/exit + hard cleanup/kill；禁 process.exit 绕 finally；`runWorker` 记 signal。(2) retained-lock async 三阶段 barrier（loaded→barrier→release 自然 exit；winner identity/zero-file；crash `/T /F` + abandon observed boolean 非门）。(3) DACL 全矩阵 + closed code + 无 SID 泄漏。(4) stable-view temp `ABRAIN_ROOT` production self-publication + managed injection + loud zero 三案；去掉 preview residual。(5) edge 真实 pair/candidate/witness/audit/16-proc/DACL tamper/partial no-whitewash。(6) DCC 诚实 not_covered：platform true；empty abrain observe/read/kick 非 ready；无伪造 authority；residual 写 live daemon+git+settled kick 前提。(7) controller：stable/edge full-pass-only；DCC not_covered⇒partial `accepted:false`。(8) 验证：`--self-test` ok；`provenance-load`/`retained-lock`/`dacl`/`stable-view`/`edge`/`dcc` workers 直接 ok；full dirty gate 停；smoke-windows-native-addon 抽查绿。顺带修 production publisher Windows latest pointer 行不得以 undefined sha256 进入 artifact_rows JCS 比较。
- 2026-08-06：**Windows production acceptance dossier 最后封闭（不 commit、criteria 全不勾）**。(1) hardCleanup strict：成功路径 temp residual/hardRm 失败 throw；失败路径 cleanup_errors bounded 入 failure JSON；仅存活 child 才 kill。(2) retained/edge child wait 断言 code===0/signal null + bounded stderr；crash holder taskkill 单独标。(3) stable latest 仅 byte-exact `bundles/<hash>\n`；DACL tamper 加 icacls readback + native verify deny。(4) system owner probes：存在 targets 全 denied；≥1 成功拒绝；residual 非第二账户主动 tamper。(5) live ~/.abrain guard → bounded recursive aggregate（count+sha256 only；含 hidden；封顶 invalid）。(6) 全局 residual 恒加 `binary_hash_to_dlopen_toctou_not_fully_closed` ⇒ accepted false；provenance 可 pass 不宣称 WIN-BINARY 完成。(7) 6 worker 再跑确认；plan 补记不勾。
- 2026-08-06：**loader same-fd post-dlopen rehash + trusted-leaf lstat fail-closed（不 commit、不 package/build、criteria 全不勾）**。(1) `assertTrustedLeafPath`：逐组件 lstat 仅 ENOENT 可 return 交 MISSING；EACCES/EPERM/EBUSY/其他 → `PATH_UNTRUSTED`；detail 仅 bounded check/code 不泄 path；realpath 同类不 fail-open。(2) 生产/测试共同 load：binary fd 自 hash 前持有到 load 后；dlopen 后 same-fd 全量 rehash exact `manifest.binary_sha256`（positional read + 64MiB ceiling，不从 path 重读）→ 不符 `BINARY_MUTATED` → 再 after-load identity + self identity。(3) smoke：lstat 非 ENOENT→PATH_UNTRUSTED；ENOENT→MISSING；load 内原地改内容（保 size/mtime）→ same-fd rehash BINARY_MUTATED；既有 replace race 仍过；source hygiene 静态检查 rehash 顺序。(4) dossier structural/provenance 输出 `same_fd_post_dlopen_rehash:"pass"`；TOCTOU residual **仍保留**并明确无 native bootstrap 原子保证、ancestor-delete-handles / same-token-admin 残留。(5) 既有 artifact commit 因源码变更 stale；本切片不 package/build/commit、不勾 criteria。

## Definition of Fully Complete

“全部完成”只在以下条件同时成立时成立：P0–P4 均有匹配外证；全部 stable criteria（`WIN-LINUX-ZERO-REGRESSION`、`WIN-LOCK-CONTENTION-CRASH`、`WIN-STABLE-VIEW-INJECTION`、`WIN-EDGE-JOURNAL`、`WIN-DACL-TAMPER`、`WIN-DCC-READY`、`WIN-BINARY-PROVENANCE`、`WIN-PRODUCTION-ACCEPTANCE`）为 verified；Linux zero-regression 仍成立；Windows DCC 不再依赖“无 DACL 却 ready”；生产加载路径对缺失/错架构/hash 不符 fail-closed；最终 completion dossier 可由命令、文件和 Git object 独立复核。任何一项未满足，本计划仍为 active 或 blocked，不得宣告完成。
