# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。历史 phase checklist 已归档，不再作为路线图。

> **2026-05-15 同步**：roadmap 上一版有几条 debt 已经在 2026-05-14 R5/R6 audit 中落地（dispatch temp prompt uniqueness、vault read/bash fail-closed、writer git rollback、migrate-go frontmatter preservation、Vault P1 active project resolver），本次清理移出 backlog，列入下方 **§ "已落地的旧 backlog（不要再当 debt）"** 防止再被当成未完成项。
>
> **2026-05-15 PM 补充**：multi-LLM audit (round 1+2) 同日关闭三项 backlog：**Curator scope binding (create 分支)**、**sediment update/merge unknown frontmatter preservation 系统化测试**、**memory parser kind/status 枚举 enforcement**（该项本次初检才发现，同日修复）。均进§"已落地不变量"。
>
> **2026-05-17 同步**：ADR 0022 (`prompt_user` LLM-facing 同步问答工具) P1 + P2 + P3a + P2-fix 完成。LLM 现在可以调 `prompt_user(...)` 暂停 turn 问用户问题，解决 sediment 拿到残缺 turn 的问题。详 [ADR 0022](./adr/0022-prompt-user-tool.md) §4 与 [current-state §10](./current-state.md#10-prompt_user-状态adr-0022)。R4 multi-LLM ADR audit + 1 轮 implementation P1 audit (OPUS + DEEPSEEK xhigh)，P0 共识 0，7 个 P1 全部 ship-with-smoke。P3b/P3c 进入 backlog（下表）。
>
> **2026-05-18 同步**：**ADR 0022 P3b shipped + post-audit fix shipped**。
>
> P3b 主体（commit 8abb48b）：`authorizeVaultRelease` / `authorizeVaultBashOutput` 主路径迁到 PromptDialog overlay，保留 `ui.select` fallback。新增叶文件 `extensions/abrain/vault-authorize.ts`。`smoke:abrain-vault-reader` 6 → 14 assertion。INV-E (PromptDialog 不持 grant 状态) 首次可 smoke 验证。
>
> P3b post-audit fix（commit 待推）：OPUS+GPT-5.5+DEEPSEEK 三路并行 xhigh audit 产出 **0 P0 / 6 共识 P1**，全部 ship：(#1) pre-aborted signal early-return、(#2) mid-dialog abort 主动 done(null) teardown、(#3) **vault 独立 concurrent gate**（pi parallel tool mode 下两个 vault_release 同发不会串话授权）、(#4) vault variant shape invariant choices.length ≥ 2、(#5) signal narrow type check 防 fake AbortSignal 报错、(#6) INV-E refinement 明确 dialog lock 是 concurrency state 不是 grant state。`smoke:abrain-vault-reader` 14 → 21 assertion (+7)。
>
> P3c 原重量路径（~80 LOC 独立 audit consumer）**降为 YAGNI**，代以轻量路径：扩 `llm-extractor.ts` trust boundary白名单 `name="prompt_user"` toolResult 为 user-attested（≈10 LOC）。
>
> **2026-05-18 同步后续**：**ADR 0022 P3c（轻量路径）shipped** — `extensions/sediment/llm-extractor.ts` trust boundary 段加 prompt_user exception（18 行 prompt + 2 个正例 1 个反例 + 1 句 sanitizer defense-in-depth）。`smoke:memory` extractor-prompt assertion 加 8 个 anchor needle 锁定住 exception block (negative-test 验证：删任何一个 anchor 都会 fail-fast)。加上 P3b + P3b post-audit fix，**ADR 0022（`prompt_user` LLM-facing 同步问答工具）的所有 P0/P1 stage 完全 ship**；P4 (multi-select toggle / secret consumer API / defer-resume) 与下表 P3b audit 留的 10 个 P2 进入 housekeeping 阶段。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| Lane G G2–G5 | G1 writer（`writeAbrainAboutMe` + fence extractor + router）✅ shipped 2026-05-16，详 [ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)。剩余：G2 `/about-me` slash + transcript inject、G3 aboutness LLM classifier、G4 `review-staging` slash + 30-day TTL、G5 region-aware ranking hint。 | G2 在等 pi extension SDK 确认 user-role transcript inject API；其他无阻塞。**ADR 0022 P2 后 G2 可考虑复用 `askPromptUser` service 作为 `/about-me` UI substrate**，不再依赖 user-role inject API。 |
| Vault P0d | masked input、`.env` import、`/vault migrate-backend` wizard | 保持 fail-closed，不引入 plaintext fallback。Vault P1（active project resolver + `/secret` scope 路由 + `$PVAULT_/$GVAULT_`）已 ship。 |
| `abrain-age-key` identity passphrase wrap | 让 `~/.abrain/.vault-identity/master.age` 能用 passphrase 加密后进 git，实现跨设备仅 `git clone abrain` + 输一次 passphrase。详见 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md) §"P0d 增强"。 | 技术依赖未定：(Y2) `age-encryption` JS lib in-process unwrap · (Y1) `node-pty` 模拟 pseudo-tty 。合并 P0d ADR 决策。 |
| Tier 3 legacy backends reader UX | `ssh-key` / `gpg-file` / `passphrase-only` 在 ADR 0019 后是 explicit-only。`passphrase-only` reader 仍不能解锁（同一 tty pass-through 问题）。 | 上项 abrain-age-key passphrase wrap 落地后该 gap 自动关闭（同一 unwrap 路径）；在那之前 `/vault status` 仍会在旧 backend init 后显示 deprecation 提示。 |
| Abrain auto-sync UX P0e | [ADR 0020](./adr/0020-abrain-auto-sync-to-remote.md) 已 ship的 baseline（后台 push + 启动 ff-fetch + `/abrain sync` / `/abrain status`）上还差几个 UX 增强点。 | TUI footer 提示 `ahead > 0` 超 5 分钟；周期性 fetch（e.g. 每 15 min）；conflict suggestion logging（量化 LLM auto-merge 不做的代价）。全部是 deferred YAGNI，等真实 usage signal 再推进。 |

## Architecture debt

| Item | Intent |
|---|---|
| Schema evolution | frontmatter/audit/binding schema 的 version upgrade path（当前 `schema_version: 1` 字段已写入，缺多版本兼容/迁移策略）。 |
| Runtime path docs/tests | 避免 `.pensieve`/`.pi-astack`/`.abrain .state` 路径漂移。 |
| Model fallback vs curator whitelist | 当前 model-curator session_start 只 WARN，不阻止 curator 删掉 fallback 候选；需要 curator 在 whitelist 时尊重 fallbackModels 列表，或 fallback 路径自带 whitelist bypass。 |
| Sediment audit candidates.title sanitize | explicit lane 的 audit `candidates[].title` 字段在 R5 之前未走 `sanitizeForMemory`（auto-write lane 同）；2026-05-15 已修，但保留此项提醒未来新加 audit 字段须默认走 `sanitizeAuditText`。 |
| ADR 0022 P2 review P2 polish 丝项 | OPUS+DEEPSEEK review 中 7 项 P2 未动：`__secretLengths` 重命名 / `redactCredentials` 多-@ 边界 case / `displayWidth` 补 East Asian 码点 / `globalThis` hook non-configurable / `via=fallback_chain` audit 结构化 / overlayOptions 响应式宽度。 | 年中 housekeeping commit 项。不阻塞。 |
| **ADR 0022 P3b post-audit P2 backlog** (2026-05-18 P3b high audit 留) | 10 项 P2/P3，全部为 UX / 重构 / 覆盖 gap，**不影响正确性**：<br>**(a) Refactor**: `applyChoice` 在 `authorizeVaultRelease` + `authorizeVaultBashOutput` 双份复制¨抽 `mapVaultReleaseChoice` / `mapVaultBashOutputChoice` helper (OPUS)。<br>**(b) Telemetry**: `cachedVaultDialogBuilder=null` 时（pi-tui 加载失败）静默退化到 `ui.select`，没有 startup audit / notify；“fallback 可画生” 的观察期拿不到信号 (OPUS)。<br>**(c) Test gap**: `__authorizeVaultReleaseForTests` + `__authorizeVaultBashOutputForTests` exports 为 dead code¨需 stage 完整 `index.ts` 的 smoke 写一个 grant isolation E2E (vault → prompt_user → vault 不串话)，填 INV-E 端到端验证的另一半 (DEEPSEEK)。**R8 中 GPT-5.5 P1#1 fail-closed envelope smoke gap 也并入该 stage-index 工作**。<br>**(d) Test gap**: `ui.select` fallback 路径 (cachedBuilder=null) 无 smoke (DEEPSEEK)。<br>**(e) Test gap**: 真实 PromptDialog vault variant 渲染 smoke ~~¨现在 P3b smoke 用 fake buildDialog，如果 `allowOther` flag 退化虚假仍绿~~ ✅ **shipped 2026-05-19** (commit 8571257): `smoke:prompt-user-option-list` 46 → 54 (+8 assertion) 渲染真实 `buildPromptDialog` 映证 vault_release / bash_output_release variant，覆盖 allowOther 门控 / titlePrefix / accentColor / progress marker / hint text。Negative test 验证：强改 `allowOther = true` 会 fail-fast 3 条 assertion，invariant 双向锁定 (GPT-5.5 + DEEPSEEK)。<br>**(f) UX**: Vault auth options 不本地化¨中文 session 下顶部 reason 是中文但选项还是英文。修补需拆分 display label vs stable enum value，或文档化「英文 enum 是审计稳定值」(GPT-5.5)。<br>**(g) Telemetry**: INV-D audit row 不记 `ui_path` 元数据¨问题排查时无法区分 overlay 路径 vs select fallback 产生的 `reason: "cancelled"` (DEEPSEEK P0 重分类 P2)。<br>**(h) Defense in depth**: vault-authorize.ts 里 unknown choice 现在返回 `cancelled`；OPUS 认为应当 `dialog_error` 以触发 ui.select fallback，避免被动静默拒绝 (OPUS)。<br>**(i) UX**: 40 列 narrow terminal 下 vault dialog hint text 可能 wrap 两行¨中文本地化后更明显 (GPT-5.5)。<br>**(j) Code style**: OptionList 在 vault variant 下的 `otherIdx=-1` 逻辑是 defense in depth，但 vault 路径理论上永不调 Other-related path；可考虑 vault 专用 OptionList 变体进一步减一条代码路径 (DEEPSEEK)。 | 不阻塞 P3b 可用。推荐一轮汇总 housekeeping commit 一起清（各项独立 commit 会丢失 audit 原始联动上下文）。 |
| **ADR 0022 T0 xhigh audit P2 backlog** (2026-05-18 T0 xhigh 留) | T0 xhigh 三路并行（opus-4-7 / gpt-5.5 / deepseek-v4-pro）后留下的 6 项 P2 架构层 / UX / 防护增强，**不影响 ADR 0022 closing**：<br>**(D5) Vault visual confusion attack surface**: LLM 可以构造 prompt_user 调用让其 header/options 文案接近真实 vault 对话框（如设 header="Release github-token?"，options="Yes once/Session/No/Deny + remember"）。颜色（accent vs warning）与标题（"Question" vs "Vault Release"）不同，但用户可能误认为真实授权。实际危害有限（prompt_user "Yes once" 不会释放任何 secret），但信任侵蚀是真的。修补方案：PromptDialog vault variant 加固定锁图标 🔒，question variant 加 footnote 「此对话框询问的是普通问题，不是 vault 授权」 (DEEPSEEK xhigh)。<br>**(D7) Compaction defer for vault dialog**: INV-K 仅覆盖 prompt_user pending，vault dialog pending 时 compaction 仍会触发。修补方案：vault-authorize.ts 暴露 `isVaultDialogInFlight()`，compaction-tuner 同时检查两者。或者 INV-K 提升为“存在 active user-facing overlay 时 defer” (DEEPSEEK xhigh)。<br>**(D4) Curator answer quality 分级**: P3c-lightweight 当前是单层 USER-ATTESTED；未来可能需 attestation: "guided" / "deliberate" / "neutral" 三级 (推荐 vs Other vs non-recommended) (DEEPSEEK xhigh)。留 P3c-heavyweight 启动时启用。<br>**(D6) Vault cross-host pre-flight**: SSH 到新机器未 scp identity 时，vault 对话框仍会弹出 → 授权 → 解密失败。可优化为在 vault-authorize 构造对话框之前 pre-flight 检查 identity file，未成功直接 fail 不弹框 (DEEPSEEK xhigh)。<br>**(D9) ADR 0014 Lane V 定义补充 PromptDialog 共享 substrate 注释**: P3b 后 vault 授权 UI 走 PromptDialog overlay variant，但 ADR 0014 Lane V 原文本未提及。加一句说明：UI substrate 共享但 lane trust / grant state / audit lane / writer path 独立 (DEEPSEEK xhigh)。<br>**(GPT-5.5 #1 smoke gap)** fail-closed envelope for ui.select/confirm in authorizeVaultRelease 代码已 ship（R8 commit 4f7a4cc）但 smoke 需 stage 完整 index.ts，合并到 (c) 一起做。 | DEEPSEEK xhigh “audit-fatigue” 元策略（原 P0）不在 ADR 0022 范围，独立走 ADR 0001 §8 amendment 未来 session。推荐这轮汇总 housekeeping commit 与 P3b post-audit P2 backlog 合并一起清。 |

## Architecture invariants（已守护，禁止退化）

以下几条曾是 roadmap debt，2026-05-14 R5/R6 audit 已落地为不变量：未来 PR 退化这些行为应视为 regression。

> **行号策略（2026-05-15 调整）**：每次大幅插入（如 ADR 0020 startup hook 一次性下移 ~50 行）后行号会过期；2026-05-15 multi-LLM 审计发现上一版本表 4/6 条引用失效。**现改用 `file::symbol` 锚点**（函数 / 常量名），仅在需要时附“~行号”提示多次插入后请重新 grep，不要依赖冻结的绝对行号。

| Invariant | 当前防线 |
|---|---|
| Dispatch temp prompt uniqueness | `extensions/dispatch/index.ts::runSubprocess`（现 ~L233）每次调用独立 `fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-"))`；并发 worker 各持独立 tmpDir。 |
| Vault read/bash fail-closed | `extensions/abrain/index.ts` 中 `eventRegistry.on("tool_call", …)`（~L660） 与 `eventRegistry.on("tool_result", …)`（~L697）：`prepared.kind === "block"` 或 inject try/catch → `auditBashInjectBlock` + `return { block: true }`；tool_result authorization/redaction throw 全 withhold + `auditBashOutput("bash_output_withhold", …)`。 |
| Writer git rollback | `extensions/sediment/writer.ts` 中 `deleteProjectEntry`（~L834-845）、`updateProjectEntry`（~L1010-1020）、`writeProjectEntry`（~L1216-1230）、`writeAbrainWorkflow`（~L1696-1705）在 `gitCommit()===null` 时 `git reset HEAD -- <rel>` + `fs.unlink(target)`；四条写路径均覆盖。 |
| Vault P1 active project resolver | 核心引擎在 `extensions/_shared/runtime.ts::resolveActiveProject`；`extensions/abrain/index.ts` 中 `parseSecretScopeFlags`/`resolveSecretScope`（~L266-370）、`bootActiveProject` 快照（~L350-370, snapshot 在 session_start ~L592）、`/secret` 命令处理（~L1211+）；`extensions/abrain/vault-bash.ts::buildBootVaultBashDeps`（~L130-160，`$PVAULT_/$GVAULT_/$VAULT_` 路由 + `pvaultBlockReason` 拒绝）。`--project=<id>` 必须等于 boot-time 绑定；默认走 active project。 |
| Curator scope binding（非 create ops） | `extensions/sediment/curator.ts::validateScope`（函数定义～L97，调用点在 update@L117 / merge@L136,L143 / archive@L152 / supersede@L160 / delete@L168）强制 neighbor scope 一致；只有 create 仍 prompt-only（下方 backlog）。 |
| Migrate-go unknown frontmatter preservation | `extensions/memory/migrate-go.ts::preservedFrontmatterLines`（~L690）+ `buildNormalizedFrontmatter`（~L653, 调用~L846）：迁移路径保留未知 frontmatter raw lines。 |
| Memory store priority post-B5 cutover | `extensions/memory/parser.ts::resolveStores`（~L46）固定为 `abrain-project > world > legacy-pensieve`；`loadEntries` dedup（~L670）跨 store first-wins **不可被 confidence/updated 推翻**；`scanStore` 对 world 传 `WORLD_EXTRA_IGNORE_DIRS={projects,vault}` 镜像 `listFilesWithRg` 的 `--glob` 排除。（2026-05-15 memory audit 落实） |
| Memory read-path kind/status 枚举归一 | `extensions/memory/parser.ts::normalizeKind`/`normalizeStatus`（~L29-90）在 parseEntry 里被调用：`entry.kind`/`entry.status` 总是 sediment/validation.ts ENTRY_KINDS/ENTRY_STATUSES 枚举之一；legacy `pipeline`/`knowledge` + 任意未知值被 fold 到最近的 canonical kind，原值保留在可选 `legacyKind`/`legacyStatus` 供 doctor。LLM-facing card 不再看到未声明的 kind。（2026-05-15 audit round 2） |
| Curator create-branch scope binding | `extensions/sediment/curator.ts::parseDecision` create 分支加两条硬约束：(a) 每个 `derives_from` slug 必须在 allowedSlugs 中（防幻觉 slug）；(b) 若 `scope:"world"`，每个 `derives_from` neighbor 必须也是 world-scope（防漏 project context 进 world store）。project create 仍可从 world 派生（合法 specialization）。（2026-05-15 audit round 2） |
| Sediment update/merge unknown frontmatter preservation 覆盖 | `scripts/smoke-memory-sediment.mjs` 新增 “fm-preserve” 6 步 fixture：注入 unknown scalar/array、update body 无 patch / 有 patch 两路，验证 unknown 存活 + 保护 key 唯一 + parseEntry roundtrip。（2026-05-15 audit round 2） |

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd / BM25 optional acceleration | 旧 BM25/tf-idf 仅作为 deprecated dead code 留在 `extensions/memory/search.ts`，不是 `memory_search` fallback；可做离线诊断/加速实验。 |
| Cross-device abrain sync | 等真实多机冲突反馈；不要提前 over-engineer。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Skills/prompts/vendor port | `skills/`、`prompts/`、`vendor/gstack/` 仍是计划，不在 current repo tree。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
