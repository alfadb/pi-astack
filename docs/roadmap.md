# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。历史 phase checklist 已归档，不再作为路线图。

ADR 只记录架构决策和取舍，不承载实施流水账。已 ship 的当前事实写入 [`docs/current-state.md`](./current-state.md)；未完成计划写入本文；多轮审计和 commit 级时间线写入 `docs/audits/` 或保留在 git history。

## 文档体系 Phase 2（共识层重构后续）

Phase 1 已建共识层（`README`/`vision`/`direction`/`requirements`/`feature-changelog`，见 [`docs/README.md`](./README.md)）。Phase 2 待办：

- 按“方向头部留共识、机制正文归 abrain”劈分现有 23 份 ADR：方向/不变量抽进 `direction.md`/`requirements.md`，机制正文归 abrain（sediment 写）或归档（见 `README.md` §7 劈分表）。
- `current-state.md` / `architecture/*` 中复述代码的部分收敛为“代码派生”；只留方向/契约。
- 给 abrain 补技术细节本体（调用链/模块图/机制 rationale）+ “细节触碰方向→升级”标注能力 + 按需渲染 rationale 供人类审计（承重墙，见 `README.md` §4）。
- 加 `docs-doctor` P0 检查：链接/锉点解析、frontmatter 必填、canonical 正文禁裸 commit hash、`canonical_for` 唯一性、扩展清单 == `ls extensions/`。

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
>
> **2026-05-19 同步**：**ADR 0022 P3b post-audit P2 (e) + (h) shipped**（commit `8571257` + `ec20b27`，已 push）。(e) 补 real-PromptDialog vault variant 渲染 smoke，锁定 allowOther / titlePrefix / accentColor / hint text，`smoke:prompt-user-option-list` 46 → 54。(h) 改 unknown choice 返回 `dialog_error` 以触发 ui.select fallback，`smoke:abrain-vault-reader` 21 → 22。均经 negative-test 双向锁定。**同日 OPUS-4-7 + GPT-5.5 + DEEPSEEK-V4-pro 三路并行 xhigh audit 对剩余 22 项 P2 重组为 housekeeping batch plan**（5 项 won't-fix / 1 项 awaiting-user-decision / 14 项 进 3 个 batch），详下方专设章节 [`## ADR 0022 housekeeping batch`](#adr-0022-housekeeping-batch-2026-05-19-multi-llm-synthesis)。
>
> **2026-05-21 同步**：**[ADR 0023](./adr/0023-session-start-rule-injection.md) R4 终版 Accepted**（仅设计，未实施）→ 三家深度 reviewer review (OPUS + GPT-5.5 + DEEPSEEK) 揭示 sediment 是 write-only loop，反馈边全缺 → **用户根本性 product philosophy redirect**：“第二大脑主动观察我 + 通过 LLM 自行演进自行进化 + 不能由我来纠正 + 不能由我去看” → **[ADR 0024](./adr/0024-second-brain-from-natural-conversation.md) Accepted**（framing ADR）。
>
> **2026-05-21 同步 (cont.)**：**[ADR 0024](./adr/0024-second-brain-from-natural-conversation.md) Accepted** — 三条 hard invariant：INV-INVISIBILITY（隐身性、不让用户感受“管理大脑”）+ INV-AUTONOMY（自治性、不需用户参与维护）+ INV-IMPLICIT-GROUND-TRUTH（隐式 ground truth，来自自然交互不是 veto/digest）。明确“自然交互 vs 管理大脑”边界。Supersedes 部分：ADR 0023 R4 的 INV-R8/R9/`/rule veto`/`MEMORY-RULE:` fence first-class 入口 + ADR 0021 的 `/about-me` slash + ADR 0016 的手动 self-improve。**R0 patch 同 PR 必交付物**：ADR 0023→R5、ADR 0021/0017/0016/0020 patch + docs sync。后续 ADR 0025（meta-curator subsystem）详细设计：outcome feedback edge + cross-session aggregator + multi-view verification + classifier auto-iteration + silent archive rollback window。实施合计工程量 ≈ pi-astack 当前体量翻倍，多季度迭代。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| **ADR 0024 R0 patch 同 PR 交付**（阶段 0，纯文档） | ADR 0023→R5（删 INV-R8/R9、删 `/rule veto`、删 `MEMORY-RULE:` first-class、加 INV-R12 auto-demote + `last_cited_at` 字段）+ ADR 0021 patch（删 `/about-me` first-class）+ ADR 0017 patch（sediment defer + auto-bind）+ ADR 0016 patch（self-improve cron化）+ ADR 0020 patch（silent power-user only）+ docs/current-state.md / brain-redesign-spec.md / architecture/ 同步。 | **R0 不同 PR 交付→ ADR 0024 不算 Accepted**，后续所有设计 hold。纯文档 2-3 天工作量。 |
| **ADR 0025 起草 (meta-curator subsystem)** | 基于 ADR 0024 三条 invariant + §4.2 五条 capability 清单详细设计：outcome feedback edge + cross-session aggregator + multi-view verification + classifier auto-iteration + silent archive rollback window。 | R0 完成后立刻起草 → multi-LLM xhigh audit ≥ 2 轮 P0 收敛 → R2-R6 实施阶段 phase。 |
| **ADR 0023 R5 / ADR 0024 R2-R6 实施**（阶段 1-5） | R2 (outcome edge + auto-demote, ~300-500 LOC) → R3 (cross-session aggregator, ~500-800 LOC) → R4 (multi-view verification, ~300-500 LOC) → R5 (classifier auto-iteration, ~500-800 LOC) → R6 (silent archive window, ~200-300 LOC)。合计 ≈ pi-astack 当前体量翻倍。 | 多季度迭代，不是单次 ship。按真实 dogfood 反馈逐步 ship。Lane G G3/G4/G5 在这个路径里自然关闭（G3 → ADR 0023 R5 unified classifier；G4 → ADR 0024 §4.2.2/4.2.5；G5 → ADR 0024 §4.2.1 下游）。 |
| Lane G G3–G5 | G1 writer（`writeAbrainAboutMe` + fence extractor + router）✅ shipped 2026-05-16；**G2 `/about-me` slash + agent_end 双-lane wire-up ✅ shipped 2026-05-20**（详 [ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md) "G2 关键设计决定"）。剩余：~~G3 aboutness LLM classifier~~（**由 ADR 0023 R1 合并 unified classifier 关闭**）、G4 `review-staging` slash + 30-day TTL、G5 region-aware ranking hint。 | G2 实现就走 `pi.sendUserMessage` 注入 MEMORY-ABOUT-ME fence + agent_end 内 Lane A/G 并行同步写循环；UI 临时用 `ctx.ui.select`+`ctx.ui.input`（与 /abrain / /secret / /vault 一致），askPromptUser overlay 作为 polish 预留。G3 由 ADR 0023 R1 合并 unified classifier 关闭；G4–G5 无其他阻塞。 |
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
| ADR 0022 housekeeping batch (2026-05-19 multi-LLM synthesis) | 参见下方专设章节 [`## ADR 0022 housekeeping batch`](#adr-0022-housekeeping-batch-2026-05-19-multi-llm-synthesis)。原 P3b post-audit P2 10 项 + T0 xhigh P2 6 项 + P2 review polish 6 项 经 OPUS-4-7 / GPT-5.5 / DEEPSEEK-V4-pro 三路并行 xhigh audit 重组：2 项 shipped, 5 项 won't-fix, 1 项 awaiting-user-decision, 3 个执行 batch。 | 下一轮 housekeeping session 拿该章节直接执行。 |
| ~~**ADR 0022 P3b post-audit P2 backlog** (2026-05-18 P3b high audit 留)~~ → **已被 2026-05-19 multi-LLM synthesis 章节取代**。本行保留 audit 轨迹 origin 供历史查询；执行请看下方章节。 (2026-05-18 P3b high audit 留) | 10 项 P2/P3，全部为 UX / 重构 / 覆盖 gap，**不影响正确性**：<br>**(a) Refactor**: `applyChoice` 在 `authorizeVaultRelease` + `authorizeVaultBashOutput` 双份复制¨抽 `mapVaultReleaseChoice` / `mapVaultBashOutputChoice` helper (OPUS)。<br>**(b) Telemetry**: `cachedVaultDialogBuilder=null` 时（pi-tui 加载失败）静默退化到 `ui.select`，没有 startup audit / notify；“fallback 可画生” 的观察期拿不到信号 (OPUS)。<br>**(c) Test gap**: `__authorizeVaultReleaseForTests` + `__authorizeVaultBashOutputForTests` exports 为 dead code¨需 stage 完整 `index.ts` 的 smoke 写一个 grant isolation E2E (vault → prompt_user → vault 不串话)，填 INV-E 端到端验证的另一半 (DEEPSEEK)。**R8 中 GPT-5.5 P1#1 fail-closed envelope smoke gap 也并入该 stage-index 工作**。<br>**(d) Test gap**: `ui.select` fallback 路径 (cachedBuilder=null) 无 smoke (DEEPSEEK)。<br>**(e) Test gap**: 真实 PromptDialog vault variant 渲染 smoke ~~¨现在 P3b smoke 用 fake buildDialog，如果 `allowOther` flag 退化虚假仍绿~~ ✅ **shipped 2026-05-19** (commit 8571257): `smoke:prompt-user-option-list` 46 → 54 (+8 assertion) 渲染真实 `buildPromptDialog` 映证 vault_release / bash_output_release variant，覆盖 allowOther 门控 / titlePrefix / accentColor / progress marker / hint text。Negative test 验证：强改 `allowOther = true` 会 fail-fast 3 条 assertion，invariant 双向锁定 (GPT-5.5 + DEEPSEEK)。<br>**(f) UX**: Vault auth options 不本地化¨中文 session 下顶部 reason 是中文但选项还是英文。修补需拆分 display label vs stable enum value，或文档化「英文 enum 是审计稳定值」(GPT-5.5)。<br>**(g) Telemetry**: INV-D audit row 不记 `ui_path` 元数据¨问题排查时无法区分 overlay 路径 vs select fallback 产生的 `reason: "cancelled"` (DEEPSEEK P0 重分类 P2)。<br>**(h) Defense in depth**: vault-authorize.ts 里 unknown choice ~~现在返回 `cancelled`~~ ✅ **shipped 2026-05-19** (commit 待推): unknown choice 返回 `dialog_error` + `detail` 包含截断后的非法值与期望 choices，触发 `index.ts` 中已有的 `ui.select` fallback 路径。detail 中 choice slice 到 64 字符 + choices.join 到 256，避免 hostile dialog flood audit/notify。`smoke:abrain-vault-reader` 21 → 22 (+1 新 truncation 断言 + 原 unknown choice 断言语义更新)；negative test 验证改回 `cancelled` 会 fail-fast 2 条 (OPUS)。<br>**(i) UX**: 40 列 narrow terminal 下 vault dialog hint text 可能 wrap 两行¨中文本地化后更明显 (GPT-5.5)。<br>**(j) Code style**: OptionList 在 vault variant 下的 `otherIdx=-1` 逻辑是 defense in depth，但 vault 路径理论上永不调 Other-related path；可考虑 vault 专用 OptionList 变体进一步减一条代码路径 (DEEPSEEK)。 | 不阻塞 P3b 可用。推荐一轮汇总 housekeeping commit 一起清（各项独立 commit 会丢失 audit 原始联动上下文）。 |
| ~~**ADR 0022 T0 xhigh audit P2 backlog** (2026-05-18 T0 xhigh 留)~~ → **已被 2026-05-19 multi-LLM synthesis 章节取代**。本行保留 audit 轨迹 origin。 (2026-05-18 T0 xhigh 留) | T0 xhigh 三路并行（opus-4-7 / gpt-5.5 / deepseek-v4-pro）后留下的 6 项 P2 架构层 / UX / 防护增强，**不影响 ADR 0022 closing**：<br>**(D5) Vault visual confusion attack surface**: LLM 可以构造 prompt_user 调用让其 header/options 文案接近真实 vault 对话框（如设 header="Release github-token?"，options="Yes once/Session/No/Deny + remember"）。颜色（accent vs warning）与标题（"Question" vs "Vault Release"）不同，但用户可能误认为真实授权。实际危害有限（prompt_user "Yes once" 不会释放任何 secret），但信任侵蚀是真的。修补方案：PromptDialog vault variant 加固定锁图标 🔒，question variant 加 footnote 「此对话框询问的是普通问题，不是 vault 授权」 (DEEPSEEK xhigh)。<br>**(D7) Compaction defer for vault dialog**: INV-K 仅覆盖 prompt_user pending，vault dialog pending 时 compaction 仍会触发。修补方案：vault-authorize.ts 暴露 `isVaultDialogInFlight()`，compaction-tuner 同时检查两者。或者 INV-K 提升为“存在 active user-facing overlay 时 defer” (DEEPSEEK xhigh)。<br>**(D4) Curator answer quality 分级**: P3c-lightweight 当前是单层 USER-ATTESTED；未来可能需 attestation: "guided" / "deliberate" / "neutral" 三级 (推荐 vs Other vs non-recommended) (DEEPSEEK xhigh)。留 P3c-heavyweight 启动时启用。<br>**(D6) Vault cross-host pre-flight**: SSH 到新机器未 scp identity 时，vault 对话框仍会弹出 → 授权 → 解密失败。可优化为在 vault-authorize 构造对话框之前 pre-flight 检查 identity file，未成功直接 fail 不弹框 (DEEPSEEK xhigh)。<br>**(D9) ADR 0014 Lane V 定义补充 PromptDialog 共享 substrate 注释**: P3b 后 vault 授权 UI 走 PromptDialog overlay variant，但 ADR 0014 Lane V 原文本未提及。加一句说明：UI substrate 共享但 lane trust / grant state / audit lane / writer path 独立 (DEEPSEEK xhigh)。<br>**(GPT-5.5 #1 smoke gap)** fail-closed envelope for ui.select/confirm in authorizeVaultRelease 代码已 ship（R8 commit 4f7a4cc）但 smoke 需 stage 完整 index.ts，合并到 (c) 一起做。 | DEEPSEEK xhigh “audit-fatigue” 元策略（原 P0）不在 ADR 0022 范围，独立走 ADR 0001 §8 amendment 未来 session。推荐这轮汇总 housekeeping commit 与 P3b post-audit P2 backlog 合并一起清。 |

## ADR 0022 housekeeping batch (2026-05-19 multi-LLM synthesis)

> 三路并行 xhigh audit：OPUS-4-7 + GPT-5.5 + DEEPSEEK-V4-pro。2.5× parallel speedup（522.6s → 211.3s）。
>
> **输入**: P3b post-audit P2 10 项 + T0 xhigh P2 6 项 + P2 review polish 6 项 = 合计 22 项 P2
> **输出**: 2 项 shipped (e/h) · 5 项 won't-fix · 1 项 awaiting-user-decision · 14 项 进 3 个执行 batch
>
> 三家共识则直接应用；分歧处采取“守势选项”（例如 (a) refactor 是否 won't-fix 一项上 OPUS 认为高价值、GPT-5.5 中等、DEEPSEEK 判为 cosmetic，采 DEEPSEEK）。

### ✅ Shipped

| 项 | commit | 效果 |
|---|---|---|
| (e) real-PromptDialog vault variant 渲染 smoke | `8571257` | `smoke:prompt-user-option-list` 46 → 54 (+8); allowOther 双向锁定 |
| (h) unknown choice → `dialog_error` | `ec20b27` | `smoke:abrain-vault-reader` 21 → 22; 触发 ui.select fallback 而非静默拒绝 |
| (b)+(g)+(D9) Batch A 子组 1 | `ff3dd9e` | `VaultEvent.ui_path` 字段 + `startup_telemetry` op + ADR 0014 Lane V 共享 substrate 注释。`authorizeVaultRelease` / `authorizeVaultBashOutput` 返回 `ui_path` (overlay/select/confirm/cached/none) 、audit 函数接受 ui_path 参数、调用点全部 wire 传递。activate() 检测 builder=null 设 flag，session_start once-per-process 发出带 `ui_path:"select"` 的 telemetry row 与 `ui.notify` warning。`smoke:abrain-vault-writer` +2 assertion (28→30)：ui_path round-trip + startup_telemetry schema。 |
| → Batch A 子组 1 post-audit fix (P0 + P1-1) | `c2cbe85` | **2026-05-19 OPUS-4-7 + DEEPSEEK-V4-pro xhigh 三路 audit 测出共识 P0**：`ff3dd9e` 中 `tool_result` bash output handler 的 inline 调用未随 `authorizeVaultBashOutput` 返回型重构同步，`decision !== "release"` 变成 object-vs-string 永真 → 所有 vault bash output 被静默 withhold，且 `auditBashOutput` 两个调用点都没传 `ui_path` (g) 在 bash_output lane 上未生效。修：`outcome.decision !== "release"` 与两处传 `outcome.ui_path`。顺手修 OPUS P1-1：activate() 成功路径 clear `vaultDialogBuilderInitFailed=false` 防热 reload false-positive telemetry。`smoke:abrain-vault-bash` +1 assertion (18→19) grep-anchor 锁 “outcome.decision !== release” 与 “outcome.ui_path”，同时 negative anchor 拒绝 `decision !== "release"` 重现 (outer-envelope catch 的 legitimate 2-arg 调用被有意排除，详 OPUS P1-5)。Negative test 双向验证。**P1-2 (OPUS) / P1-4 (DEEPSEEK) coverage gap 仍留 Batch A 子组 2 (stage-index `smoke:abrain-vault-grant-isolation`) 端到端覆盖**。其余 P1（OPUS P1-3 telemetry i18n 与 “wait for first ui.custom” 异步、P1-4 两个 outcome shape 不一致、P1-5 outer-catch outcome hoist、P1-6 ADR 0022 INV table 加 INV-O、DEEPSEEK P1-2 startup_telemetry 语义漂移、P1-3 `none` vs absent）与 P2 项进 Batch C polish sweep。 |
| (c)+(d) Batch A 子组 2: stage-index grant isolation E2E (初 ship) | `912d5f0` | 新 `scripts/smoke-abrain-vault-grant-isolation.mjs` (17 assertion)。Stage `extensions/abrain/index.ts`，通过 `__authorizeVaultReleaseForTests` / `__authorizeVaultBashOutputForTests` 驱动五个 UI substrate 分支。覆盖：**(c)** INV-E grant isolation、fail-closed envelope、**(d)** ui.select/confirm fallback、**(g)** ui_path 端到端 stamp。Vault 释放 6 + Bash output 5 + grant isolation 3 + telemetry 1 + export shape 1 + cached fast-path 1 = 17 assertion。 |
| → Batch A 子组 2 post-audit fix (3-way T0 一致 P0) | `863d6e6` | **2026-05-19 OPUS-4-7 + GPT-5.5 + DEEPSEEK-V4-pro xhigh 三路一致 P0** (罕见 unanimous)：912d5f0 的 smoke 并不能抓住 ff3dd9e 的 P0。原因：ff3dd9e 的 bug 在 `tool_result` handler 调用点，而 smoke 只直接调 `__authorizeVaultBashOutputForTests` helper — helper 返回在 ff3dd9e 时已正确，bug 完全在 caller 侧。修：抽 `processVaultBashToolResult` 为 module-level function，加 handler E2E test-only exports。smoke +5 handler E2E assertion (17→22)。**Negative test 双向验证**。 |
| → Batch A 子组 2 third-round audit fix | `d5d5881` | **第 3 轮 GPT-5.5 + DEEPSEEK-V4-pro 2/2 共识 P1** (OPUS 本轮 timeout)：863d6e6 的 commit body 声称 require-time fail-fast 已加，但 edit batch atomic rollback 只营 commit message，代码中从未落实。修：真正加 fail-fast loop 验证 11 个 test-only exports + DEEPSEEK P2-2 vacuous assertion 改为诚实断言 + GPT P2-1 count drift 不再受 failures.length 干扰 + docs sync。**双 Negative test 验证**：加 bogus export 名后 fail-fast 立即 throw；改 EXPECTED=99 后 drift 立即 fail。 |
| **(D7) Batch B Compaction defer for vault dialog** ✅ (2026-05-20) | _本轮_ | INV-K 从 prompt_user 拓宽到 vault 授权 dialog。新增 `extensions/compaction-tuner/vault-defer.ts` 叶模块 (`isPendingVaultDialogBlocking()`)，镜像 `prompt-user-defer.ts` 同一防御语义（hook 抩/缺失/类型错 → false）。`extensions/abrain/vault-authorize.ts` 新增稳定公共 API `isVaultDialogInFlight()`（不同于现有 `__peekVaultDialogLockForTests` test-only 函数，该 API 是 cross-extension contract）。`abrain/index.ts` activate() 发布 `__abrainVaultDialogInFlight` globalThis hook，同用 `Object.defineProperty configurable:false writable:false` 加固（镜像 Batch C 对 `__abrainPromptUserGetPending` 的保护）。`compaction-tuner/index.ts` trigger 路径双 check：prompt_user 在前（更常见），vault 在后；audit reason 独立（`prompt_user_pending` 保留 + `vault_dialog_pending` 新增）以便调试。新 `smoke:compaction-tuner-vault-defer` 14 assertion 覆盖所有 hook 状态分枝 + 真实 vault-authorize 集成 + 两个 substrate 不名称折叠防御 + 2 个 grep-anchor 锁 hook 名称与 hardening。3 个 negative test 双向验证：(1) helper 常返 false fail、(2) trigger 路径刪 vault check fail、(3) hardening 退化 `configurable:true` fail。Prerequisite “vault-authorize lock 泄漏 smoke” 发现已被 `smoke:abrain-vault-reader` 5 条 assertion 覆盖（成功 / pre-abort / mid-dialog abort / dual-call sequencing / concurrent gate）。 |
| Batch C polish sweep + 3rd-round audit deferred closure | _本轮_ | **本 batch 同时闭环原计划与 3 轮 audit deferred 项**：(1) `__secretLengths` → `__secretLengthsInternal` 改名明确“非 wire”、(2) `displayWidth` helper grep 发现早被删 (no-op)、(3) `__abrainPromptUserGetPending` hook 改用 `Object.defineProperty configurable:false writable:false` 防 LLM eval / extension 静默重绑为 `() => 0` 绕过 INV-K compaction defer + `smoke:abrain-vault-bash` 19→20 grep anchor、(4) `__seedVaultBashRunForTests` / `__clearVaultBashRunsForTests` 加 `PI_ASTACK_ENABLE_TEST_HOOKS=1` env gate (GPT P1#2 3rd round)、(5) **DEEPSEEK P2-1 + P2-2 闭环**：发现原 outer-envelope test 是 vacuous-true 原因是原代码 outer try 内 `vaultBashRuns.delete(toolCallId)` 在 throw 之前已跱，outer catch 再 `.get()` 永远 undefined — fallback 路径不可达。修：record 提升到 outer scope + `auditBashOutput` 外 加 try/catch + fallback `safeAuditAppend({key:"(unreadable)", reason:"outer_catch_audit_failed:*"})`。outer-envelope assertion 升级为验证 fallback row 真存在。(6) docs/reference/smoke-tests.md 从 15 →25 + docs/directory-layout.md 从 17 →25 同步。**Negative test**：移除 env var 、重现 record.delete-before-throw、重现原 plain assignment 都能独立拦截。 |

### ❌ Closed as won't-fix (三路共识 / 主调采纳)

| 项 | 不修理由 | 主调来源 |
|---|---|---|
| (a) `applyChoice` refactor | Cosmetic refactor；消除 15 行复制品却引入 indirect helper，无多次修改痕迹时不增加可读性 | DEEPSEEK |
| (D4) Curator attestation 分级 | "YAGNI 的 YAGNI"；P3c-heavyweight 本身已 deferred，在未产生 curator 误判样本前不启动三级划分 | DEEPSEEK |
| (D6) Vault cross-host pre-flight | 用户操作失误场景；加 pre-flight 只把报错从“解密失败”前移到“弹框前”。UX 差异微小，且需 vault-reader 暴露 pre-flight API，改动面大 | DEEPSEEK + GPT-5.5 |
| (j) vault-only OptionList 变体 | `otherIdx=-1` 是单条 if，零维护成本；抽变体反而增加 PromptDialog variant 矩阵复杂度 | OPUS + DEEPSEEK |
| `overlayOptions` 响应式宽度 | inline `{ overlay:false }` 已是主路径，旧 overlay 宽度议题 obsolete；且依赖 pi-tui 还没有的 width-reactive API | GPT-5.5 |

### 🟡 Awaiting user decision (不该 LLM 拍板)

| 项 | 决策点 |
|---|---|
| (f.copy) Vault auth options 各 locale 的具体翻译文案 | 例如"Yes once"译为“本次允许”还是“授权一次”。属于 UI 文案选择，不是技术决策。在 (f.arch) ship 后另起 PR 填。**Scope clarifications from 2026-05-20 post-audit** (OPUS P2-3 + DEEPSEEK P1-2): (a) 实现 `vaultReleaseDisplayLabel` / `vaultBashOutputDisplayLabel` 必须遵守社交安全契约（总函数 / never-throws / distinct outputs / 详见 `abrain/index.ts:vaultReleaseDisplayLabel` JSDoc）；(b) `(Recommended)` 后缀中英混合需要 (f.copy) PR 同时决定：要么保留英文，要么额外推 PromptDialog 加 `recommendedSuffixLabel?: string`；(c) 同时需在 `rebuildLayout` items.map 处加 try/catch fallback（或依赖 mapper 严格总函数要求），避免 locale mapper bug 炸掉 dialog。 |

> **2026-05-19 OPUS 复检后调整**: 原 (f) 被拆为 (f.arch) 与 (f.copy)。OPUS 论证：“拆 display label / stable enum value 是事实正确答案” — 理由 (a) audit 字段必须英文稳定，否则跨 locale 不可 grep；(b) “Yes once” 之类 UI 字符串直接进 audit 是 R5 之前那批 sanitize bug 同类。方案 (1) 永久把 UI 钉死英文违反 i18n 友好原则。架构决策被从 awaiting 中移出，进 (f.arch)；仅保留具体译文为用户决策点。

### 📦 Batch A — Vault auth observability + index-level smoke (优先)

代码集中：`extensions/abrain/index.ts` + `extensions/abrain/vault-authorize.ts` + `scripts/smoke-abrain-vault-reader.mjs` (或新增 `smoke:abrain-vault-grant-isolation`)。

| 项 | 做法 | LOC |
|---|---|---|
| (b) `cachedVaultDialogBuilder=null` telemetry | activate() 中 builder=null 且 ui.custom 可用时一次性 audit + `ui.notify`；观察期能收到 fallback 退化信号 | ~15 |
| (g) INV-D `ui_path` metadata | vault audit row 加 `ui_path: "overlay"\|"select"\|"confirm"` 字段；区分 overlay 路径与 select fallback 产生的 `reason:"cancelled"` | ~25 |
| (D9) ADR 0014 Lane V 注释 | docs only：加一句“UI substrate 共享但 lane trust / grant state / audit lane / writer path 独立” | ~10 |
| (c) Grant isolation E2E + GPT-5.5 #1 fail-closed envelope | stage 完整 index.ts smoke：vault → prompt_user → vault 不串话 + ui.select/confirm throw 走 try/catch fail-closed；DEEPSEEK 估 ~50 / OPUS+GPT-5.5 估 ~150 LOC，**取上限** | ~150 |
| (d) ui.select fallback smoke | cachedBuilder=null 路径的 mock ui.select 覆盖；与 (c) 共用 stage | ~50 |

**子组切分建议**：(b)(g)(D9) 合一次 commit (~50 LOC, 低风险)；(c)(d) 合另一次 commit (~200 LOC, stage-index 脚手架需独立 audit)。

**OPUS 2026-05-19 补充**: A3 (unknown-choice → fallback 集成 smoke gap) 与 A4 (dialog_error 不写 audit row) 都会被 (g) `ui_path` 字段自然覆盖 — fallback 路径产生的 audit row 携 `ui_path:"select"` 可作为“发生过 fallback” 的证据。不需单独补。

**回归风险**：stage-index 可能触发 lazy require / CJS transpile / pi API mock 漂移 (GPT-5.5)。INV-D 加字段是向后兼容的，但需 grep 确认无硬编码 audit schema consumer。

### 📦 Batch B — Vault UX defense

| 项 | 做法 | LOC | 状态 |
|---|---|---|---|
| **(D5)** Vault visual confusion 🔒 | PromptDialog vault variant 加固定锁图标；question variant 加 footnote“此对话框非 vault 授权”；补 render smoke | ~20 | ✅ **shipped 2026-05-20** + post-audit — vault variant 标题 prefix 加 🔒 (三重视觉信号：WARNING 色 + 🔒 + 'Vault Release' 文本); question variant 加 muted footnote "(LLM question — not a vault authorization)"。Post-audit (OPUS P2-4) 补上 footnote 覆盖 secret/text/multi 3 种 question 类型。`smoke:prompt-user-option-list` +5 D5 + 3 post-audit D5 = 8 D5 assertion + 1 negative test。 |
| **(D7)** Compaction defer for vault | vault-authorize.ts export `isVaultDialogInFlight()`；compaction-tuner 添 OR 条件。复用 `getPendingPromptCount` 的 hook 模式，避免引入跨扩展反向依赖 | ~15 | ✅ **shipped 2026-05-20** — 新 `extensions/compaction-tuner/vault-defer.ts` 叶模块镜像 `prompt-user-defer.ts`；`vault-authorize.ts` 新增公共 API `isVaultDialogInFlight()`；`abrain/index.ts` activate() 发布 `__abrainVaultDialogInFlight` hook 同用 `defineProperty configurable:false` 加固；compaction-tuner trigger 路径添独立 audit reason `vault_dialog_pending`。新 `smoke:compaction-tuner-vault-defer` 14 assertion + 3 negative test 双向锁定（helper 常返 false / trigger 路径刪 vault check / hardening 退化 `configurable:true` 都能 fail-fast）。不含 multi-LLM audit——镜像 P3a (`prompt-user-defer.ts`) 已经三轮审计过的成熟模式，仅需 negative test 验证 assertion 生效。 |
| **(i)** 40-col narrow terminal hint wrap | vault hint text 按 width 分档或缩短 | ~10 | ✅ **shipped 2026-05-20** + post-audit — `BuildDialogArgs` 新 `compactHint?: boolean`；vault variants 默认 true (hint 拆 typeHint / actionHint 两行), question variant default false (LLM-facing 宽终端假设)。Post-audit (DEEPSEEK P2-1) 补上 40-col render 验证（之前只验证 80-col 下拆分存在但不验证实际受益）。`smoke:prompt-user-option-list` +3 i + 2 post-audit i = 5 i assertion + 1 negative test。 |
| **(f.arch)** Vault auth label/value 拆分架构 | 拆 display label / stable enum value | ~40 | ✅ **shipped 2026-05-20** + post-audit docs — `BuildDialogArgs` 新 `labelFor?: (rawValue) => string`；OptionList items 明确分离 value (稳定 enum) 与 label (显示文本)。`VAULT_RELEASE_AUTH_CHOICES` / `VAULT_BASH_OUTPUT_AUTH_CHOICES` 文档明确声明为 STABLE ENUM + 新增 `VaultReleaseChoice` / `VaultBashOutputChoice` 类型别名。新增 `vaultReleaseDisplayLabel` / `vaultBashOutputDisplayLabel` (今日 identity、预留 f.copy localize)，JSDoc 添加 5 条 f.copy 实现契约 (总函数 / never-throws / distinct outputs / CJK OK / Recommended 后缀范围 — DEEPSEEK P2-2/P2-3 + OPUS P2-3 post-audit 表述)。`applyChoice` 与所有 audit row 文中以 enum 记录，audit 跨 locale grep 不受 UI 译文影响。`smoke:prompt-user-option-list` +5 f.arch assertion + 1 negative test。Translation copy (f.copy) 仍留空 awaiting user decision。 |

**回归风险**：(D5) 渲染高度变化 × (i) 窄终端 wrap 在同一代码路径交错。~~(D7) 如 `__vaultDialogInFlight` finally 丢解锁，compaction 永远被 defer）动 compaction-tuner 前先补 vault-authorize lock 泄漏 smoke。~~ → (D7) 实际 ship 时发现 `smoke:abrain-vault-reader` 已覆盖 5 条 lock 泄漏 assertion（成功 / pre-abort fast reject / mid-dialog abort / dual-call sequencing / concurrent gate），prerequisite 自动满足。

### 📦 Batch C — P2 polish sweep + 3rd-round audit deferred (partial shipped)

| 项 | 做法 | LOC | 状态 |
|---|---|---|---|
| `__secretLengths` 重命名 | 改为 `__secretLengthsInternal` 明确“非 wire” | ~10 | ✅ |
| `displayWidth` East Asian | grep 发现 helper 早被删 (stale backlog entry) | 0 | ✅ (no-op) |
| `globalThis` hook non-configurable | `Object.defineProperty(globalThis, '__abrainPromptUserGetPending', { configurable:false, writable:false })` + grep-anchor smoke | ~25 | ✅ |
| `PI_ASTACK_ENABLE_TEST_HOOKS` env gate | `__seedVaultBashRunForTests` / `__clearVaultBashRunsForTests` 添加 env gate（GPT P1#2 3rd round） | ~15 | ✅ |
| outer catch `auditBashOutput` defense-in-depth | `record` hoist 到 outer scope；加 fallback `safeAuditAppend` 漏网 (DEEPSEEK P2-1+P2-2 3rd round) | ~30 | ✅ |
| docs/reference/smoke-tests.md + directory-layout.md 同步 | 补全 25 条 smoke (从 17 过期) | ~30 | ✅ |
| `redactCredentials` 多-@ 边界 | userinfo vs `user@host@realm` 区分，只 redact userinfo — 需新 smoke fixture | ~10 | ⏭️ Batch D |
| `via=fallback_chain` audit 结构化 | model-fallback audit 加 `{ via, fallbackSteps }`；audit schema 变动需独立 audit | ~10 | ⏭️ Batch D |

### 执行优先级

1. ~~**Batch A 子组 1** (b + g + D9) — ~50 LOC, 单 commit, 低风险。首先做。~~ ✅ **shipped 2026-05-19** (本表 “Shipped” 区)。
2. ~~**Batch A 子组 2** (c + d) — ~200 LOC, 新 smoke entry `smoke:abrain-vault-grant-isolation`；三路并行 xhigh audit。INV-E 端到端封口；ui_path 端到端 stamp 验证也在这里。~~ ✅ **shipped 2026-05-19** (`912d5f0` + post-audit fix: 3-way T0 unanimous P0 “smoke 不能抓 ff3dd9e P0” 补 handler E2E)。
3. **Batch B 全部 shipped (2026-05-20)** — ~~(D7)~~ + ~~(D5+i+f.arch)~~：<br>   • (D7) commits `c409cde` + `157ba38` (post-audit fix)：INV-K 从 prompt_user 拓宽到 vault dialog。`smoke:compaction-tuner-vault-defer` 17 assertion。<br>   • (D5 + i + f.arch) 本轮 commit：Vault 视觉防骗骗化 🔒 + 40-col 宽容 hint 拆 2 行 + label/value 架构拆分（`labelFor` + `vaultReleaseDisplayLabel`/`vaultBashOutputDisplayLabel` 作为 localize hook point）。`smoke:prompt-user-option-list` 54 → 67 (+13 assertion + 4 negative test)。(f.copy) 译文进入 awaiting user decision。
4. ~~**Batch C** (polish sweep) — ~40 LOC, 单 commit (多 edits[])。~~ ✅ **shipped 2026-05-19** (上表 6/8 完成，2 项顺延 Batch D)。实际 ~110 LOC (超过原计划，因为 3rd-round audit deferred 项一并闭环)。
5. **Batch D** — `redactCredentials` 多-@ + `via=fallback_chain` audit schema，需独立 smoke + audit。~20 LOC。

**合计**：~~4 commit, ~335 LOC~~ → 实际 6+ commit。Batch A/B/C 均 ship，仅剩 Batch D + (f.copy) translation copy。每 commit 跑一轮三路 xhigh audit（镜像 P3a 的 D7 例外）。

### 本表说明

本表取代原 Architecture debt 表中三行 P2 backlog（P2 review polish / P3b post-audit / T0 xhigh）。原三行作为 audit 轨迹 origin 以 strikethrough 保留供历史查阅。下一轮 housekeeping session 拿本章节直接执行。

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

## Pending flips（过渡态机械门，ADR 0024 §7.6 条款）

| 门 | flip/移除条件 | 证据源 |
|---|---|---|
| `tier1JaccardCuratorLane: false`（显式 rollback 时 Jaccard 自治 dedup 回到 Tier-1 kill path） | 已于 2026-06-12 翻默认 true；保留此项作为 rollback 再评估条件：观察窗口（aggregator 30 天 / tail 行数限）内被裁决行（create/update/merge，error 不计）≥ 50 条 且 false-merge 份额（would_decision=create）≤ 5% | aggregator P1.5 watchdog `tier1_jaccard_shadow.flip_ready`（仅用于 rollback evidence/advisory，不机械自翻） |
| `conf≥8` 非指令 durable 过渡 fallback（correction-pipeline isTier1Directive，仅 no-target） | 审计窗口内 `tier1_direct_write` 中 `is_directive!==true && confidence>=8` 不再产生被用户纠正的 accepted corrections / recall misses → 移除 fallback 回 ADR 原文谓词 | `tier1_direct_write` audit 的 `is_directive` / `confidence` / correction outcome 维度（O5 sunset） |
| multi-view skip-cache 7d TTL | P1.5 Pass-1 schema 升级后 not-synthesizable 计数持续为 0 一个季度 → 删 cache | watchdog `pass1_op_not_synthesizable_count` |

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd / BM25 optional acceleration | 旧 BM25/tf-idf 仅作为 deprecated dead code 留在 `extensions/memory/search.ts`，不是 `memory_search` fallback；可做离线诊断/加速实验。 |
| Cross-device abrain sync | 等真实多机冲突反馈；不要提前 over-engineer。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Skills/prompts/vendor port | `skills/`、`prompts/`、`vendor/gstack/` 仍是计划，不在 current repo tree。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
