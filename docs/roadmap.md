# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。历史 phase checklist 已归档，不再作为路线图。

> **2026-05-15 同步**：roadmap 上一版有几条 debt 已经在 2026-05-14 R5/R6 audit 中落地（dispatch temp prompt uniqueness、vault read/bash fail-closed、writer git rollback、migrate-go frontmatter preservation、Vault P1 active project resolver），本次清理移出 backlog，列入下方 **§ "已落地的旧 backlog（不要再当 debt）"** 防止再被当成未完成项。
>
> **2026-05-15 PM 补充**：multi-LLM audit (round 1+2) 同日关闭三项 backlog：**Curator scope binding (create 分支)**、**sediment update/merge unknown frontmatter preservation 系统化测试**、**memory parser kind/status 枚举 enforcement**（该项本次初检才发现，同日修复）。均进§"已落地不变量"。
>
> **2026-05-17 同步**：ADR 0022 (`prompt_user` LLM-facing 同步问答工具) P1 + P2 + P3a + P2-fix 完成。LLM 现在可以调 `prompt_user(...)` 暂停 turn 问用户问题，解决 sediment 拿到残缺 turn 的问题。详 [ADR 0022](./adr/0022-prompt-user-tool.md) §4 与 [current-state §10](./current-state.md#10-prompt_user-状态adr-0022)。R4 multi-LLM ADR audit + 1 轮 implementation P1 audit (OPUS + DEEPSEEK xhigh)，P0 共识 0，7 个 P1 全部 ship-with-smoke。P3b/P3c 进入 backlog（下表）。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| **ADR 0022 P3b：vault_release UI 迁移** | `authorizeVaultRelease` / `authorizeVaultBashOutput` 主路径迁到 `<PromptDialog>` overlay（variant `vault_release` / `bash_output_release`），保留 `ui.select` fallback。¨ ~150 LOC 代码 + `smoke:abrain-vault-reader` +5 assertion。验证 INV-E（PromptDialog 不持 grant 状态）。 | 安排时对 vault state machinery 做完整 multi-LLM audit（high-value review 点）。 |
| **ADR 0022 P3c：sediment evidence 注入 `prompt_user` 信号** | sediment evidence assembly 读本 turn `lane:"prompt_user"` audit 行，输出 user-attested signal 段注入 curator prompt。让 curator 区分「用户决策」与「LLM 思考」。¨ ~80 LOC + smoke。 | 需先读 sediment curator prompt 结构。与 P3b 独立，可独立 ship。 |
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
