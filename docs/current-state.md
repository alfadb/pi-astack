# Current State — pi-astack（2026-05-18）

本文是 pi-astack 的当前事实入口。旧路线图、迁移 checklist、历史 ADR 原文可能保留在 `docs/archive/` 或 `docs/adr/` 中，但只要和本文冲突，以本文与 `extensions/` 实现为准。

## 1. 一句话状态

pi-astack 当前是一个 **local pi package**：提供 9 个扩展、10 个 LLM-facing tools（`prompt_user` 2026-05-17 ship；`vault_release` UI 主路径 2026-05-18 P3b 迁移到共享 PromptDialog substrate）、若干 human slash commands，以及基于 `~/.abrain/` 的 markdown+git 记忆/数字孪生系统。

## 2. 当前实现清单

### 2.1 Runtime extensions

| 扩展 | 主要 surface | 状态 |
|---|---|---|
| `extensions/dispatch/` | `dispatch_agent`、`dispatch_parallel` | shipped；子代理是独立 pi 进程；2+ 并行任务必须用 `dispatch_parallel`。 |
| `extensions/memory/` | `memory_search`、`memory_get`、`memory_list`、`memory_neighbors`；`/memory ...` | shipped；只读 facade；ADR 0015 LLM retrieval；legacy `.pensieve/` dual-read。 |
| `extensions/sediment/` | `agent_end` hook；`/sediment status/dedupe` | shipped；唯一 dedicated writer；B5 后写入 abrain。 |
| `extensions/abrain/` | `vault_release`；**`prompt_user`**；`/abrain`、`/vault`、`/secret` | shipped；七区 layout、strict binding、vault P0a-P0c。`prompt_user` 2026-05-17 ship¨详§10。 |
| `extensions/vision/` | `vision(...)` | shipped；图片分析 fallback。 |
| `extensions/imagine/` | `imagine(...)` | shipped；OpenAI Responses API 生图。 |
| `extensions/model-curator/` | 模型能力表注入 | shipped；curated/raw model snapshot。 |
| `extensions/model-fallback/` | error hooks | shipped；初始模型重试耗尽后 fallback。 |
| `extensions/compaction-tuner/` | `/compaction-tuner ...` | shipped；按 context 百分比触发 compaction。INV-K (ADR 0022 P3a) — 检测到待决 `prompt_user` 对话时推迟本轮 compaction。 |

### 2.2 Vendor methodology references

| Path | Upstream | 状态 |
|---|---|---|
| `vendor/gstack/` | `https://github.com/garrytan/gstack.git` | read-only submodule；gstack / claude-code workflow methodology reference。 |
| `vendor/pensieve/` | `https://github.com/kingkongshot/Pensieve.git` | read-only submodule；Pensieve memory/workflow methodology reference。 |

Vendor 不属于 runtime surface；不要从 vendor 直接加载 pi 扩展，也不要在 vendor 内直接改端口层代码。

## 3. 记忆与 abrain 状态

| 主题 | 当前事实 |
|---|---|
| Source of truth | markdown 文件 + git history。 |
| gbrain | 已退场；只保留 timeline/graph 方法论影响。 |
| `.pensieve/` | legacy 只读迁移源；sediment 不再写入。 |
| 项目写入 | `~/.abrain/projects/<projectId>/...`。 |
| 世界知识 | `~/.abrain/knowledge/<slug>.md`。 |
| workflows | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/`。 |
| 七区 | `identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`。 |
| 已有 writer 覆盖 | `projects/`、`knowledge/`、`workflows/`、`vault/`。 |
| Lane G writer G1 ✅ shipped | `identity/` / `skills/` / `habits/` 三区 writeAbrainAboutMe + parseExplicitAboutMeBlocks fence + validateRouteDecision（[ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）。端到端：G2 `/about-me` slash、G3 LLM classifier、G4 review-staging、G5 region-aware ranking hint仍在 backlog。 |
| 跨设备同步 | [ADR 0020](./adr/0020-abrain-auto-sync-to-remote.md)：sediment commit 后后台 `git push origin HEAD:main`；pi 启动 `git fetch + merge --ff-only`。冲突 ff 不可能 → `/abrain status` 提示 + `/abrain sync` 产出运行本。LLM 自动解冲突被明确拒绝（知识库幻觉风险）。 |

## 4. Project binding strict mode

Project-scoped memory/vault 权限不再从 cwd、git remote 或旧 `.gbrain-source` 推断。当前必须有三件套一致：

1. 项目仓内：`<project>/.abrain-project.json`
2. abrain 仓内：`~/.abrain/projects/<id>/_project.json`
3. host-local 映射：`~/.abrain/.state/projects/local-map.json`

推荐操作：

```text
/abrain bind --project=<id>
/abrain status
```

active project 是 pi 启动时/会话绑定时的快照；在 shell 中 `cd` 不会自动切换 project scope。

## 5. Memory read path

LLM 只使用：

- `memory_search(query, filters?)`
- `memory_get(slug, options?)`
- `memory_list(filters?)`
- `memory_neighbors(slug, options?)`

`memory_search` 当前语义：

- 查询 active project abrain store、legacy `<cwd>/.pensieve/`（仅在存在时只读接入，不再写入）和 world store。
- World store 扫描范围是整个 `~/.abrain/`，只排除 `projects/**` 与 `vault/**`；因此 `knowledge/`、`workflows/` 下有 frontmatter 的 md 都可检索（`extensions/memory/parser.ts:72-74,526-538`）。
- 两阶段 LLM rerank：候选选择 + full-content rerank。
- 默认排除 `status=archived`（`search.ts:12-16`）；**`superseded`/`deprecated` 仍然会进入默认结果**，需要 active-only 可显式 `filters.status=active`。
- 返回 normalized cards，字段：`slug/title/summary/score/kind/status/confidence/created/updated/rank_reason/timeline_tail/related_slugs`；不暴露 backend/source_path/scope（`memory_get` exact lookup 作为 debug 接口可暴露）。
- LLM search model 不可用时 hard error（包装为 `isError` tool result）；没有 grep/BM25 fallback。

## 6. Sediment write path

sediment 是唯一 dedicated writer：

1. `agent_end` 读取 session window。
2. 先解析显式 `MEMORY: ... END_MEMORY` blocks。
3. 在进入 LLM / audit / writer 前运行 sanitizer：credential/secret-like strings 被替换为 `[SECRET:<type>]`，不再因 pattern 命中阻断整轮。
4. 没有显式 block 且 `autoLlmWriteEnabled=true` 时，LLM extractor 只接收 redacted transcript，并在 prompt 中被要求保留 typed placeholders、不得还原 raw secret。
5. curator 通过已 redacted 的 `memory_search` query 找邻居并决定 `create/update/merge/archive/supersede/delete/skip`。
6. writer 上锁、lint、atomic write、append audit、best-effort git commit；audit raw text / error / candidates[].title 均存 redacted form（candidates.title 的 sanitizer 覆盖于 2026-05-15 补，之前 explicit/auto-write 两条 lane 的 audit candidates 数组中 title 未走 sanitizer）。
7. git commit 失败时 writer 会 `git reset HEAD -- <rel>` 并 `unlink` 刚刚写入的文件，避免孤儿 staged changes（2026-05-14 R5/R6 audit 落实）。

当前路径：

| scope | 条目路径 | audit 路径 |
|---|---|---|
| project | `~/.abrain/projects/<id>/<kindDir>/<slug>.md` | `<projectRoot>/.pi-astack/sediment/audit.jsonl` |
| world | `~/.abrain/knowledge/<slug>.md` | `~/.abrain/.state/sediment/audit.jsonl` |
| workflow | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/` | `~/.abrain/.state/sediment/audit.jsonl` |

Entry 写锁统一在 `~/.abrain/.state/sediment/locks/`，因为多个项目会写同一个 abrain git repo；project checkpoint/session locks 仍在 `<projectRoot>/.pi-astack/sediment/locks/`。

## 7. Vault 状态

Backend 架构按 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md)：abrain 自管 age keypair 为 Tier 1 默认，ssh-key / gpg-file / passphrase-only 降为 Tier 3 explicit-only。

已实现：

- `/vault status`
- `/vault init [--backend=<backend>]` — 不传 flag 默认走 `abrain-age-key`（`age-keygen` 生成专属 keypair，不复用系统 ssh key）。明示 `--backend=ssh-key/gpg-file/passphrase-only` 仍可用，但 stderr warning 提示跨设备负担。
- `/secret set/list/forget`（global/project scope，默认 active project）
- `vault_release(key, scope?, reason?)`（plaintext 进入 LLM 前要求用户授权；prompt 经当前 session model 翻译为用户语言）
- `$VAULT_<key>`：project → global fallback
- `$PVAULT_<key>`：project-only
- `$GVAULT_<key>`：global-only
- bash 输出默认 withheld，授权后 release，并对 plaintext 做 literal redaction（仅覆盖 text part）
- tool_call inject 错误 `block:true`；tool_result authorization/redaction throw 全 withhold + audit `bash_inject_block`/`bash_output_withhold`（2026-05-14 R6 audit fix）
- sub-pi 默认无 vault 工具/权限（三层：dispatch spawn env override + abrain extension activate guard + vault-reader 二次 guard）

**abrain-age-key 路径详情**（ADR 0019）：

- `~/.abrain/.vault-identity/master.age`：abrain 专属私钥、0600、**gitignore**。2026-05-15 后不再寄生 `~/.ssh/id_*`。
- `~/.abrain/.vault-identity/master.age.pub`：公钥，进 git。
- `~/.abrain/.vault-pubkey`：与 `master.age.pub` 同内容，保留以兼容 vault-writer（ADR 0019 invariant 6）。
- `~/.abrain/.vault-master.age`：**abrain-age-key 不生成此文件**（单层 keypair）；仅 Tier 3 backend 使用。
- 跨设备同步：用户手动 `scp ~/.abrain/.vault-identity/master.age …` + `chmod 0600`。误操作失败时 reader 报 actionable error（含 `scp` / `chmod 0600` 提示）而不是 silent "vault locked"。

**旧 backend 用户**（如果 `.vault-backend` 是 `ssh-key`/`gpg-file`/`passphrase-only`）：

- `ssh-key` 与 `gpg-file`：reader 仍 fail-soft 正常解锁（分别调 `ssh-keygen`/`gpg --decrypt`）。
- `passphrase-only`：**reader 已知不能解锁** — `vault-reader.ts::defaultExec` 为避免子进程 prompt 坏 main pi，在未显式传 `input` 时把 `stdio[0]` 设为 `ignore`，age scrypt 拿不到 tty 输入 → 30s 后超时 SIGKILL。该 gap 在 ADR 0019 + roadmap “Tier 3 legacy backends reader UX” 中已记录，**需等 P0d `abrain-age-key` passphrase wrap 落地后一并关闭**（同一 unwrap 路径）。

在所有三种旧 backend 上，`/vault status` 都会显示 `⚠ DEPRECATED backend (ADR 0019)` + 重 init 指令（`backend-detect.ts::formatBackendDeprecation` ~L346）。

未实现/roadmap：

- P0d：`abrain-age-key` identity passphrase wrap（让 `.vault-identity/master.age` 可进 git，跨设备仅 `git clone abrain` + 输一次 passphrase）、masked input、`.env` import、`/vault migrate-backend` wizard。技术依赖选型（`age-encryption` JS lib vs `node-pty`）未定。
- Lane G G2–G5：`/about-me` slash + transcript inject、G3 LLM classifier、G4 review-staging slash + 30-day TTL、G5 region-aware ranking hint（G1 writer + extractor + router ✅ shipped 2026-05-16，详 [ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）

## 8. 当前测试入口

`package.json#scripts` 是 smoke 列表 live truth。当前 **25 个**（2026-05-17 ADR 0022 P1+P2+P3a +5；2026-05-18 R7 OptionList +1；2026-05-19 dispatch-output-format +1；2026-05-19 batch A 子组 2 grant-isolation +1），P3b + post-audit fix assertion 在 `smoke:abrain-vault-reader` 内 +15（6 → 21）：

```text
smoke:memory
smoke:dispatch
smoke:dispatch-output-format          # 2026-05-19 formatResult truncation regression
smoke:fallback-timing
smoke:vision
smoke:imagine
smoke:paths
smoke:vault-subpi-isolation
smoke:abrain
smoke:abrain-bootstrap
smoke:abrain-vault-writer              # 2026-05-19 batch A (g): ui_path + startup_telemetry schema (+2 assertion, 28→30)
smoke:abrain-vault-reader              # ADR 0022 P3b + post-audit: 6 → 21 assertion
smoke:abrain-vault-grant-isolation     # 2026-05-19 batch A 子组 2: stage-index E2E (23 assertion, third-audit fixed require-time fail-fast + count drift)
smoke:abrain-vault-bash
smoke:abrain-vault-identity
smoke:abrain-git-sync
smoke:abrain-active-project
smoke:abrain-secret-scope
smoke:abrain-i18n
smoke:abrain-redact                    # ADR 0022 P1
smoke:prompt-user                      # ADR 0022 P2
smoke:prompt-user-finalizer            # ADR 0022 P2
smoke:prompt-user-subpi                # ADR 0022 P2
smoke:prompt-user-option-list          # ADR 0022 R7 OptionList
smoke:compaction-tuner-prompt-user     # ADR 0022 P3a
```

25/25 全绿为 ship 门槛。

## 9. 历史文档处理原则

- ADR 保留设计推演与取代关系；先读 [adr/INDEX.md](./adr/INDEX.md)。
- 旧 monolith 原文移入 [archive/](./archive/)；不要把 archive 当 current spec。
- 迁移目录只保留仍可执行的操作手册；已完成的 phase plan/checklist 移入 archive。

## 10. `prompt_user` 状态（ADR 0022）

LLM-facing 同步问答工具，与 `vault_release` 共享 `<PromptDialog>` overlay substrate但 LLM tool / grant 状态 / audit lane / tool name 独立。解决主会话需要用户决策时 sediment 拿到残缺 turn 的问题。

### 已 ship（P1 + P2 + P3a + P2-fix + P3b + P3b-post-audit + P3c-lightweight）

> **2026-05-18 closing milestone**: 这一轮合计 5 个 commit（8abb48b P3b / 6ae5771 post-audit / + P3c 轻量路径 + P2 backlog 入档）后，**ADR 0022 的所有 P0/P1 stage 完全 ship**。后续 P4 以及 P3b post-audit 留下的 10 项 P2 进入 housekeeping 阶段（详见 [roadmap.md](./roadmap.md) `Architecture debt` 表）。

- **P1**：`redactCredentials` 提升到 `abrain/redact.ts`；新增 `redactSecretAnswer` / `lengthBucket` / `redactPromptParams` / `sanitizePathLike`；`prompt-user/types.ts` 纯类型骨架。¨commit `0e937f7`。
- **P2**：完整 LLM 工具表面¨`prompt-user/{schema,manager,service,handler,ui/PromptDialog}.ts`；abrain/index.ts 注册 `prompt_user` tool + session_shutdown finalizer + globalThis pending hook。commit `b9565c2`。
- **P3a**：`compaction-tuner/prompt-user-defer.ts` 叶模块 + INV-K guard 在 trigger 路径。`getPendingPromptCount > 0` 时跳过本轮 compaction 并 audit，rearm state 不消耗。commit `29439cb`。
- **P2-fix**：多-LLM review（OPUS + DEEPSEEK xhigh）找出的 7 个 P1 修补¨`hasControlChars` 拒 \t\n\r / `redactCredentials` 扩到任意 scheme / `redactPromptParams` 下沉到 service 入口 / 加 `sanitizePathLike` / narrow terminal reject / chained fallback multi 多次 confirm / INV-I 发 audit。commit `8676c5f`。
- **P3b** (2026-05-18 上午)：`authorizeVaultRelease` / `authorizeVaultBashOutput` 主路径迁到 PromptDialog overlay（variant `vault_release` / `bash_output_release`）。新增 `extensions/abrain/vault-authorize.ts` thin wrapper，不走 `service.askPromptUser`（不共享 prompt_user 的 concurrent gate / audit lane / grant 状态，INV-D/E 边界）。`PromptDialog` 扩 `allowOther` flag：variant != "question" 时关闭 Other 选项（vault 决策不允许自由逃逸）；同时隐藏 `(N/M)` progress，提示改为 `enter authorize • esc deny`。`ui.select` 保留为 fallback。`smoke:abrain-vault-reader` 6 → 14 assertion。
- **P3b post-audit fix** (2026-05-18 下午)：OPUS+GPT-5.5+DEEPSEEK 三路并行 xhigh audit 产出 **0 P0 / 6 共识 P1**，全部 ship：
  - **#1** pre-aborted signal early-return不再调 `ui.custom`（OPUS+GPT-5.5：stale overlay UX bug）
  - **#2** mid-dialog abort 主动 `done(null)` teardown overlay（OPUS：dialog stays on screen after caller settled）
  - **#3** **vault 独立 concurrent gate** — pi parallel tool mode 下两个 `vault_release` 同时发会开两个 dialog 串话授权，现在第二个返回 `dialog_error`（OPUS）
  - **#4** vault variant 入口 shape invariant（`choices.length >= 2`）防 buggy caller 渲染锁死 UI（GPT-5.5）
  - **#5** `signal` narrow type check（`typeof signal.addEventListener === 'function'`）防 fake AbortSignal 抛 TypeError（OPUS P2 升级为安全边界 P1）
  - **#6** INV-E refinement— module-level `__vaultDialogInFlight` lock 是 **concurrency state**，**不是** grant state；smoke 明确区分两者边界
  - `smoke:abrain-vault-reader` 14 → 21 assertion (+7）。P2 （applyChoice 复制 / startup telemetry / 真实 PromptDialog render smoke / vault enum localization / `__authorizeVault*ForTests` exports 的 grant isolation smoke）推迟。

### 不变量覆盖（11 / 11 — P3b 后 INV-E 可验证；R8 后 INV-C 在所有 cancel 路径上均验证）

> **2026-05-18 R8 同步**：T0 xhigh GPT-5.5 #4 报告 coverage table 与代码漂移— row A 原写 `cols < 60 三层 reject` 但 R6 已删 narrow terminal reject（R6§2026-05-17 inline editor 走后 Text 自动 wrap，40-col 不拒）。已同步到 actual state。

| INV | 覆盖路径 | smoke |
|---|---|---|
| A | sub-pi 3 层（PI_ABRAIN_DISABLED env / activate early-return / handler subagent reject）+ hasUI=false reject；narrow terminal 不再 reject（R6 2026-05-17 删） | `smoke:prompt-user`, `smoke:prompt-user-subpi` |
| B | 4 个 cancel 源全部 wire （timeout / signal / cancelAll / done） | `smoke:prompt-user-finalizer` |
| C | secret raw 不跨 PromptDialog 闭包；placeholder + lengthBucket 走 audit；R8 后所有 cancel 路径（timeout / signal / cancelAllPending）均调 `__wipeSecrets` + `done(null)` teardown | `smoke:prompt-user` (R8 +3 disposer assertion) |
| D | 4 字段 (reason/header/question/option.label) × (redactCredentials + sanitizePathLike) | `smoke:prompt-user`, `smoke:abrain-redact` |
| **E** | `vault-authorize.ts` 零 grant state（dialog lock 是 concurrency state不是 grant state，P3b-post-audit fix #6 明确边界）；dialog substrate 不持 grant。连续 vault_release 不串话；vault variant 不含 Other；concurrent vault dialog 被拒 | **`smoke:abrain-vault-reader` (P3b + post-audit 合计 +15 assertion)** |
| F | 只写 audit jsonl，不写 markdown | `smoke:prompt-user` fs.readdirSync 验证 |
| G | schema 拒绝 `scope`/`key`/`vault`/`secret_key` 令牌；vault 内部 caller bypass schema (直接调 buildPromptDialog) | `smoke:prompt-user` |
| H | answers 永远 `Record<string, string[]>` | `smoke:prompt-user` |
| I | concurrent ≤ 1 + 独特 detail + audit；vault 走独立 gate不占用 prompt_user concurrent 名额 | `smoke:prompt-user` |
| J | `redactCredentials` 单一定义点 + import 双路径 `===` | `smoke:abrain-redact` |
| K | compaction-tuner 检测到 pending 时跳过 + audit，不消耗 rearm | `smoke:compaction-tuner-prompt-user` |

INV-E 的端到端实现另一半（`index.ts` 内 grant 状态在 dialog session 中不被串话）现在由 **`smoke:abrain-vault-grant-isolation`** (Batch A 子组 2 ～ Batch A 子组 2 第三轮 post-audit, 23 assertion) 端到端覆盖：grant cross-key isolation、deny+remember cross-key no-pollution、PromptDialog substrate 零 module-level state、UI substrate 全 5 路径 (overlay/select/confirm/cached/none) 的 ui_path stamp、fail-closed envelope on ui.select/confirm throw、handler E2E 驱动的 release/withhold/non-bash/unknown-toolCallId/outer-envelope 五路径。原文提到的 `smoke:abrain-vault-bash` + `smoke:prompt-user` 仍作为辅助覆盖与源代码 grep-anchor 防线保留。

### 已 ship - P3c 轻量路径 (2026-05-18 晚间)

- **P3c-lightweight**：扩 `extensions/sediment/llm-extractor.ts` trust boundary 段加 prompt_user exception（18 行 prompt + 2 个正例 + 1 个反例 + 1 句 sanitizer defense-in-depth）。`message/toolResult:prompt_user` 开头的 entry 被明确标为 USER-ATTESTED，与普通 `role=toolResult` 区分；curator 可将基于 prompt_user 答案的候选沉淀为 `preference` / `decision`，不需 assistant 重新 establish substance。`smoke:memory` extractor-prompt assertion 加 8 个 anchor needle 锁住 exception block，**negative test 验证**：删任何一个 anchor 都会 fail-fast。**原重量 P3c（≈80 LOC 独立 audit consumer）仍保留在 deferred YAGNI**，等出现「curator 误判 prompt_user 答案」的实际案例再启动。

### 未实现（deferred）

- **P3c-heavyweight**（原重量路径，调整为 YAGNI）：sediment evidence assembly 读本 turn `lane:"prompt_user"` audit 行，输出独立 user-attested signal 段注入 curator prompt。轻量路径 ship 后该多事。
- **P4**：`type:multi` 真正多选 toggle UI（现 P0 退化为单选）；caller-side raw secret consumer API；defer/resume API（需 pi 核心支持）。
- **P3b post-audit P2 backlog**（10 项）：applyChoice 复制 · cachedVaultDialogBuilder=null 静默退化 telemetry 缺失 · `__authorizeVault*ForTests` grant isolation E2E smoke · `ui.select` fallback 路径无 smoke · 真实 PromptDialog vault variant 渲染 smoke · vault enum 本地化 vs 审计稳定性 tension · INV-D ui_path 元数据 · unknown choice 该返 `dialog_error` 调论 · 40 列 hint wrap · vault OptionList 小重构。详 [roadmap.md](./roadmap.md) `Architecture debt`。

### 多-LLM 审计轨迹

- ADR 本体：R1 独立提案 → R2 交叉审计 → R3 综合 → R4 P0 收敛 3→0。
- P2 实施：1 轮 P1 audit（OPUS + DEEPSEEK；GPT-5.5 执行失败）¨P0 共识 0，7 个 P1 全部 ship-with-smoke。
- P3b ship + post-audit fix （2026-05-18）：3-way parallel xhigh audit（opus-4-7 / gpt-5.5 / deepseek-v4-pro）产出 0 P0 / 6 共识 P1 全部 ship-with-smoke。这轮 audit 发现的最大问题是 pi 默认 parallel tool mode 下 vault 需要独立 concurrent gate（原设计考虑了 prompt_user INV-I，但 vault 走独立 path 后丢了同类保护）。P2 项推迟为下一轮 housekeeping。
- P3c-lightweight ship（2026-05-18 晚间）：不走 multi-LLM audit¨¨10 LOC prompt 修改不值得，negative test 已证明 assertion 生效。后续 dogfood 与实际 usage signal 评估足够。
