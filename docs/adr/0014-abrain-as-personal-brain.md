---
doc_type: adr
status: accepted
---

# ADR 0014 — Abrain Personal Brain Redesign（重定位 ~/.abrain 为 alfadb 数字孪生）

- **状态**：Accepted（2026-05-09）。**vault 子系统 P0a / P0b / P0c.write / P0c.read + P1 全部已 ship**（2026-05-09 → 2026-05-11）；**B1 workflows lane writer / B3+B7 per-file substrate 剥离 / B4 per-repo 迁移执行器 / B4.5 Project Binding Strict Mode 全部已 ship**（2026-05-12，commits `b6a4a49` / `b33f0e4` / `cc40792`→`a819302`→`37f03a6`→`122c0b2`；B4.5 详 [ADR 0017](0017-project-binding-strict-mode.md)：`.abrain-project.json` + `projects/<id>/_project.json` + `.state/projects/local-map.json`；迁移 `--project` 参数已拒绝）；**sediment 写入锁 stale-lock reclaim + writeAbrainWorkflow TOCTOU re-check 已修**（commits `54835cd` / `4993d77`）；**B5 sediment writer cutover 2026-05-13 已 ship**：sediment 6 函数（write/update/archive/delete/merge/supersede）全切 `<abrainHome>/projects/<projectId>/`，lock 切到 `<abrainHome>/.state/sediment/locks/`，`MIGRATED_TO_ABRAIN` guard 与所有 `.pensieve/` 写路径完全删除（详 [ADR 0017](0017-project-binding-strict-mode.md)；机制见 abrain `sediment-write-guard-audit-row`）。**B5 后 48 小时为 curator P0 data-loss 加三层防御**（prompt update-vs-create discipline + writer body_shrink/body_section_loss/trigger_phrases UNION + smoke invariant lock，详 [ADR 0018](0018-sediment-curator-defense-layers.md)）。详见下文「实施现状」表与 [migration/abrain-pensieve-migration.md §6](../migration/abrain-pensieve-migration.md#6-adr-0014-状态推进路径)。**待实施**：P0d（全 TUI onboarding wizard / mask input / `.env` import）+ Lane G writer（identity / skills / habits + `/about-me` command）。B5 sediment writer cutover 已于 2026-05-13 ship。**Lane G 详细实施 ADR 已出**：[ADR 0021](0021-lane-g-identity-skills-habits-writer.md)（2026-05-15 PM）拆出 G1-G5 五个 phase，G1（writer + fence extractor + router enforcer + smoke） 与本 ADR 包接。
- **部分取代**：[ADR 0013](0013-asymmetric-trust-three-lanes.md) Lane B（manual promote project→world）/ Lane D（auto-promote）——abrain 七区拓扑下不再有 promote 概念，sediment writer 直接将条目路由到七区内一个，详 §D3。
- **部分被取代**：§D5 早期 `_bindings.md` + git remote / cwd 前缀推断的 project binding 方案被 [ADR 0017](0017-project-binding-strict-mode.md) B4.5 strict binding 取代（`.abrain-project.json` + `_project.json` + `local-map.json` 三层验证）。
- **修订**：v1.4（2026-05-09，desktop-bias correction——vault unlock 从 OS keychain 依赖转为 portable identity （ssh-key/gpg-file/passphrase Tier 1），容器场景从 "不支持" 升 first-class）、v1.3（2026-05-09，incorporate Round 5 复核 P0 修订，含首次真代码修订）、v1.2（2026-05-09，incorporate Round 4 复核 P0 修订）、v1.1（2026-05-09，incorporate Round 3 复核 P0 修订）
- **日期**：2026-05-09
- **决策者**：alfadb
- **依赖**：[ADR 0003](0003-main-session-read-only.md)、[ADR 0010](0010-sediment-single-agent-with-lookup-tools.md)、[ADR 0013](0013-asymmetric-trust-three-lanes.md)、[memory-architecture.md](../memory-architecture.md)
- **被引用**：[brain-redesign-spec.md](../brain-redesign-spec.md)（详细规范）、[migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)、[migration/vault-bootstrap.md](../migration/vault-bootstrap.md)、[ADR 0017](0017-project-binding-strict-mode.md)（B4.5 strict project binding）
- **触发**：2026-05-09 三轮多模型辩论（Opus 4-7 / GPT-5.5 / DeepSeek v4-pro）+ 用户重定位 ~/.abrain + 一轮 P0 复核（三方 PASS after fixing P0）

## 背景

### 触发链

1. **用户原始诉求**：希望 pi 升级为"全能助手"，能学习习惯、记忆项目、辅助决策、观测全部 pi 操作
2. **三轮多模型辩论**（共耗时 ~6.5 分钟、$0.95）：从五个能力维度（C1-C5）拆解为六个核心架构分歧（A-F），三方在 R1 高度对立、R2 大幅让步
3. **用户关键 reframe（2026-05-09 18:25）**：把 ~/.abrain 从"world knowledge 仓库"重新定义为"**关于 alfadb 这个人的一切**"——含 identity、skills、habits、workflows、所有 projects（吃掉旧 .pensieve/）、knowledge、vault
4. **用户自主反思（2026-05-09 21:00）**：放弃"主体进程 + 分身 + 队列"激进方案，回归"N 个独立 pi 进程共享同一 brain"的克制路径
5. **brain layout v0.1 → v0.2 收敛**，五个开放点全部锁定

### 为什么需要这个 ADR

memory-architecture.md（v1.0，2026-05-07 通过两轮三模型评审）的 scope=project|world 二元划分**在新需求下不够用**：

- 它假设 world 是"跨项目通用 fact"——但用户要的 world 实际上是"alfadb 这个人"
- 它没有 identity / habits / skills / workflows / vault 的概念
- 它没有跨项目 portfolio view 的内生支持
- 它的 `.pensieve/` per-project 物理结构与"统一大脑"的认知模型冲突

ADR 0013 的 Lane B（manual promote project→world）和 Lane D（auto-promote）在新架构下**失去意义**——abrain 内部不再有"promote"概念，所有写入直接定位到对应区域。

## 决策

### D1. ~/.abrain 重定位为 alfadb 数字孪生 / Jarvis 大脑

七区结构：

| 区域 | 性质 | 写入者 |
|---|---|---|
| `identity/` | 关于"我"的固定事实 | 用户主动声明（Lane G）+ sediment 高门槛提炼 |
| `skills/` | 我会什么、熟练度 | sediment 观察 + 用户校正 |
| `habits/` | 我的行为模式 | sediment 观察 + 用户校正 |
| `workflows/` | 我的常用 pipeline | 用户主动声明 + sediment 补完 |
| `projects/<id>/` | 项目工作记忆（吃掉 .pensieve/） | sediment / 用户 |
| `knowledge/` | 跨项目通用 fact（旧 world scope） | sediment |
| `vault/` + `projects/<id>/vault/` | 双层秘密 | 用户主动（Lane V）；encrypted artifacts / metadata 可进 git，plaintext / lock / tmp 不进 git |
| `rules/{always,listed}` + `projects/<id>/rules/{always,listed}` | **第 8 类（独立于上述七区 entries 概念域）**：session-start 注入的行为规则（[ADR 0023](0023-session-start-rule-injection.md)） | sediment 全自动 lifecycle（classifier zone:"rules" → `writeAbrainRule`，2026-06-07 R1 CREATE/archive/delete ship） |

详细 schema、子目录、读写规则见 [brain-redesign-spec.md](../brain-redesign-spec.md)。

### D2. 项目知识从 `<cwd>/.pensieve/` 迁入 `~/.abrain/projects/<id>/`

`.pensieve/` 物理位置废止。每个项目的 decisions/knowledge/maxims/observations/habits/status/vault 子目录全部进入 abrain 内。

**B4.5 修订（ADR 0017）**：project id 是唯一身份，不再由 cwd / git remote 推断。项目仓通过 `.abrain-project.json` 声明 portable identity；abrain 侧通过 `~/.abrain/projects/<id>/_project.json` 注册项目；本机路径授权记录在 `~/.abrain/.state/projects/local-map.json`（local-only，支持多路径，不进 git）。三者全部匹配时 active project 状态才是 `bound`。未 bound / registry 缺失 / 当前 path 未确认时，拒绝 `/memory migrate --go`、sediment project writes 与 project vault scope。`~/.abrain/projects/_bindings.md` + remote/cwd 推断方案被 ADR 0017 取代。

### D3. Lane 模型扩展：A/C/G/V 四段

| Lane | 触发 | 目标 | 信任 | 状态 |
|---|---|---|---|---|
| **A** explicit MEMORY | `MEMORY: ... END_MEMORY` | `projects/<active>/` | 高 | ✅ 已有，迁移目标 |
| **C** auto-write | sediment LLM 后台 extract | `projects/<active>/` 或 `knowledge/` | 中 | ✅ 已有，迁移目标 |
| **G** about-me declare | `/about-me` 或 `MEMORY-ABOUT-ME:` block | `identity/` 或 `habits/` 或 `skills/`（按内容路由，**非** lane↔目录绑定） | 高 | 🆕 |
| **V** vault declare | `/secret <key>` 等系列命令（**同步**：user slash → main pi 进程内 vaultWriter library 同步调用 → 加密落盘 → 立即可用。**不走 sediment IPC**（v1.2 修订 N1） | 全局或项目级 vault | 最高 | 🆕 |
| ~~B promote~~ / ~~D auto-promote~~ | — | — | — | ⛔ 失去意义（abrain 内部无 promote） |

> Lane G 的目标在 identity / habits / skills 三区中按内容路由（deterministic router 见 [spec](../brain-redesign-spec.md)），不是 Lane 与目录的硬绑定。Lane G 保证 trust=高，目录由内容路由。**低置信样本（`routing_confidence < 0.6`）进 §3.5 staging review queue——不直接落 identity/habits**（v1.3 补，Round 5 Opus NP1-2：三区不是唯一出口，staging 是第四出口）。

### D4. Vault 双层架构

- **全局 vault** `~/.abrain/vault/`：跨项目通用秘密（github-token、API keys、ssh-key、私人事项）
- **项目级 vault** `~/.abrain/projects/<id>/vault/`：仅与某项目相关（prod-db-password 等）
- **加密**：age 单文件，单一 master key（全局与所有项目共享，避免管理 N+1 把 key）
- **解锁**（v1.4 重写）：依赖**用户已有的便携加密 identity** —— ssh-key (Tier 1 primary) / gpg-file (Tier 1) / passphrase (Tier 1 fallback) 三者覆盖几乎所有 dev 用户。OS keychain (macOS / secret-service / pass) 降为 Tier 2 optimization（有则用，没有也正常运行）。**容器场景**（alfadb 主开发环境）从 v1.3 的 "不支持 vault" 升 为 first-class（ssh-key 路径 OOTB 工作）。auto-unlock 等价物：ssh-agent / gpg-agent cache TTL。详 [vault-bootstrap.md](../migration/vault-bootstrap.md)。
- **明文不进 LLM context**（默认）：需 `vault_release` 工具调用 + TUI 授权（once/session/no/deny+remember 四档）
- **bash 注入**：`$VAULT_<key>` 解析顺序为 active project's vault → global vault；项目级覆盖全局
- **stdout/stderr redaction**：主进程在 bash 结果回流前做 best-effort 字面 match 替换为 `<vault:<scope>:<key>>`
- **git 策略（v1.4.6 dogfood 修订）**：明文 value、lock、tmp、runtime state 不进 git；`.vault-backend` / `.vault-pubkey` / `.vault-master.age` / encrypted `vault/*.md.age` / `vault/_meta/*.md` / `projects/*/vault/...` 可以随 abrain private repo 一起 git push，作为跨设备同步手段。ssh/gpg secret key 本身不上 git（由用户本身管理）。`vault forget` 删除 working tree 中的加密文件并追加 metadata timeline；若密文曾提交，git history 可能仍保留 ciphertext，但不含 plaintext。

### D5. 多 pi 进程共享 brain（无主体 / 无分身 / 无队列）

每个 pi 进程独立 lifecycle，互不通信。通过共享 ~/.abrain 协调：
- 不同 project 的 entry 写入：无锁（OS 文件系统）
- 聚合文件（`_index.md` / `_snapshot.md`）：先写 .tmp 再原子 rename，最坏情况是 update 被另一次覆盖（无伤大雅，因为是 derived）
- vault 同 key 并发写：flock `<vault-dir>/.lock`
- git commit：flock `~/.abrain/.git/.sediment-lock`
- portfolio sidecar 不挂在 agent_end 自动 regenerated；`_index.md` 由 `/memory rebuild --index` 显式触发（幂等，最后写入赢）。注意：curator `memory_search`（ADR 0015）不依赖磁盘 `_index.md`，所以无实时性影响；`_index.md` 是人类/LLM 可浏览 artifact。

### D6. 明确不做（current scope 外）

以下方向当前**不实施**，等真实使用反馈再决定：

- 主体进程 / 长跑 daemon / HTTP-Unix socket server
- 分身（spawn-and-queue / sub-agent orchestration）
- thread 抽象（跨 session 的"思考线程"一等公民化）
- multi-channel inbox（IM 接入）
- Lane D auto-promote（abrain 内部无 promote，永久消除）

不是"以后绝不做"，是"当前不做、跑两个月后基于真实 pain point 决定"。

## 关键不变量

1. **LLM tool surface 中没有定制 brain mutation tool**（v1.3 拆为 mechanic + best-effort 两段，Round 5 Opus NP1-1）：
   - **层 1 mechanic 不变量**：LLM 可调用的 tool 集中**没有** `vault_write` / `vault_put` / `secret_*` / `brain_write` 这类专门的 brain mutation 入口。sediment 仍为异步记忆写入唯一 dedicated writer（Lane A/C/G）；vaultWriter library **仅在 abrain extension activate 期间被 TUI command handler 同进程调用**（不在 module-level export 中公开、`require()` 取不到 `writeSecret`——详 spec §6.4.0）。
   - **层 2 best-effort residual surface**（已知 trade-off）：LLM 仍可通过通用 tool（bash / edit / write / dispatch_agents）间接写 brain SOT——例如 bash `secret-tool lookup` + `age -e` 手写加密文件、bash `pi /secret` spawn 子 pi（不走 dispatch_agents 路径）。防御手段：§6.5.1 stdout 默认不回流 + §6.6 redaction + sediment audit 后置检测三者叠加，但**不是机制保证**。详 §坟处 #10。
   - **Lane V 同步路径**（v1.2 引入）：user slash command `/secret`（用户物理键入）触发 main pi 进程内 vaultWriter 同步调用。user typing 是面向 TUI 的独立路径，不进 LLM tool surface，**由层 1 不变量保护**。Lane G `/about-me` 仍走 sediment 异步 agent_end 路径。
   - **UI substrate 共享边界**（ADR 0022 P3b后，2026-05-18）：Lane V 的 `vault_release` UI 与 Lane LLM-facing 的 `prompt_user` 工具共享 `<PromptDialog>` overlay substrate（`extensions/abrain/prompt-user/ui/PromptDialog.ts`）。**但 UI 是唯一共享位**：Lane trust 层 / grant 状态（`releaseSessionGrants` / `releaseRememberDenies` / `bashOutputSessionGrants` vs prompt_user 的 manager pending map） / audit lane（`vault_release` / `bash_output` vs `prompt_user`） / writer path（vault-writer.ts vs sediment）均独立。Vault 对话走 `extensions/abrain/vault-authorize.ts` 远路记账，不走 `prompt-user/service.askPromptUser`；vault 有独立的 concurrent gate（`__vaultDialogInFlight`）不占用 prompt_user 的 INV-I 名额。介面共享节省 TUI 代码重复，但不变量上两条 lane 仍然是平行的：`smoke:abrain-vault-reader` 的 INV-E assertion 锁住 “vault-authorize.ts 累计导出均为 function，零 module-level state”。
2. **Markdown + git 是 source of truth**（vault 例外：plaintext 永不进 git；encrypted artifacts + metadata 可作为 SOT 进 private git）：索引/derived view 可重建。
3. **Facade 不暴露 scope/backend/source_path** 给 LLM ranking surface：`memory_search(query)` 签名无多余形参（`scope` 不存在于 schema）。例外：`memory_get(slug)` 是 exact lookup/debug view，可返回 scope/source_path 供调试——不是 LLM 选后端的机制。
4. **跨 project vault 不互见**：active project（**boot-time snapshot**，详 spec §5.4）的 vault + 全局 vault 进 LLM context；其他 project 的 vault 连元数据都不暴露。会话中 bash `cd` 不改变 active project。
5. **vault 明文进 LLM context 必须 user-explicit 授权**：`vault_release` 工具调用 + TUI 弹框确认；best-effort redaction（不是绝对保证）但默认排除是硬不变量。**补充**：引用了 `$VAULT_*` env 的 bash 命令 stdout/stderr **默认不回流 LLM**，需用户 once-授权（详 spec §6.5.1）——这是 LLM 主动 exfiltration 的机制性防御，不仅依赖 redaction 过滤器。
6. **sub-pi 默认看不到任何 vault**：父 pi 已有授权不传给子 pi。**三层机制性 enforcement**（v1.2 强化，Round 4 GPT P0-N2）：(a) `dispatch_agents` 的 spawn 调用强制 `env: { ...process.env, PI_ABRAIN_DISABLED: "1" }`，顺序保证不能被上层 `export PI_ABRAIN_DISABLED=0` 覆盖；(b) abrain extension 启动第一行 `if (process.env.PI_ABRAIN_DISABLED === "1") return;`，不注册 tool / 不订阅事件 / 不加载 vault metadata；(c) `smoke:vault-subpi-isolation` 验证父 vault unlocked 时子 pi `vault status` 返回 locked。详 [vault-bootstrap.md](../migration/vault-bootstrap.md)。

   > **walk-back (2026-05-31, ADR 0027 PR-B v3 in-process)**：上述 (a) 子进程 spawn 注入 `PI_ABRAIN_DISABLED=1` 在 in-process `dispatch` 下**已非主路径**——sub-agent 不再是子进程、不 set 该 env，abrain 在共享 sub-agent loader 里照常 activate（`getSharedInfra` 用 `noExtensions:false`）并注册 `vault_release`。vault 对 dispatch sub-agent 的隔离现由**排他 `tools` allowlist** 保证：`vault_release`/`prompt_user` 不在 `KNOWN_TOOLS`（`validateTools` 拒绝调用方请求）、也不在默认 allowlist，`createAgentSession({tools})` 只暴露列出的工具，故 extension 注册的 `vault_release`/`prompt_user` **工具**在 sub-agent 内不可调用（SDK `agent-session.js` 用 `allowedToolNames` 硬过滤注册表，3-T0 盲审已核 pi 0.75.x 源码）。**范围限定**：这只保证两个**工具**不可调用，**不等于** vault 文件系统隔离——默认带 `read`/`grep` 的 sub-agent 仍能用绝对路径读 `~/.abrain/.vault-identity/master.age` 等密文/密钥（0600 只挡其他 OS 用户、不挡同用户同进程）。这是 ADR §不变量#1 层2 早已记录的 residual surface，本次未关闭；如需关闭须给 read/grep/find/ls 加 vault 路径 denylist（待独立决策）。(b) `PI_ABRAIN_DISABLED` env guard 仍在代码中，但 **v3 下已无任何地方自动 set 它**（v2 的 dispatch 子进程注入已移除）——它现在只是**手动 opt-out**，对「sub-agent 拿到 `bash` 后 spawn `pi`」这条 §不变量#1 层2 路径**并不自动生效**（子进程继承的 env 不含该 var）；该路径目前仅由「`bash` 非默认 + `PI_MULTI_AGENT_ALLOW_MUTATING` env gate」约束。新增 `smoke:dispatch-subagent-tool-allowlist` 断言工具排他性（旧 `smoke:vault-subpi-isolation` 只验 WeakSet + handler guard）。
7. **七区目录互斥**：identity/habits/skills/workflows/projects/knowledge/vault **七个目录**互斥（单条 entry 物理上只在一处），**但** habits/skills 等概念在全局与项目级有镜像目录（`habits/` 与 `projects/<id>/habits/` 并存），由 sediment 按 scope of generalization 决定写哪层。边界路由由 deterministic router 规范（§审计扩展 + spec §3.5）决定，不是 LLM-facing 选择。**`rules/` 是独立第 8 类**（[ADR 0023](0023-session-start-rule-injection.md)，2026-06-07 R1 patch）：它不是 entries 概念域的一员，不与上述七区互斥语义混淆——一条 rule 与其 knowledge/project 源条目可并存（`derives_from`/`promoted_from` 记 provenance），因为 rule 是 session-start 注入的 PUSH 副本，源条目仍走 pull-on-demand 检索，两者用途正交。
8. **"删除我所有秘密" = `rm -rf ~/.abrain/vault ~/.abrain/projects/*/vault`**：清除 working tree 中的 encrypted vault artifacts 与 metadata；如果这些密文已提交到 private git，history 可能仍保留 ciphertext，需要按用户选择另行处理 git history/remote。plaintext 不进 git。补充：filesystem 层面的残留（swap / journal / undelete recovery）属 OS-level，超出本 spec 范围。

## 后果

### 好处

1. **认知模型清晰**：~/.abrain 不再是"知识仓库"而是"我的孪生"——所有关于 alfadb 的事实在一个地方，结构对应"我是谁/我会什么/我怎么工作/我在做什么/我的秘密"。
2. **跨项目原生支持**：portfolio view、cross-project pattern 召回、跨项目 habit 学习全部内生，不需要单独 sidecar。
3. **隐私撤销边界清晰**：`/secret forget` 删除 working tree 中的 encrypted file 并保留 metadata timeline；`rm -rf ~/.abrain/vault ~/.abrain/projects/*/vault` 可清空本机 vault artifacts。若密文曾提交到 private git，history/remote 上仍可能保留 ciphertext，需要用户按需另行清理；plaintext 不进 git。
4. **工程量可控**：本质是"数据层重构 + sediment writer 路径切换"，pi 内核完全不动。失败回滚 = revert sediment 改动 + mv abrain/projects/* 回各项目 .pensieve/。
5. **未来不锁死**：spawn-and-queue / thread / 主体进程 都是可以以后加的"协调层"——共享 brain 是它们的前置基础设施，不会冲突。
6. **架构辩论复杂度大幅降低**：之前两轮 R1+R2 讨论的"observation 该放哪个 store"、"habit 该不该持久化"等问题，在新架构下要么自动解决要么变成局部决策。

### 坏处

1. **迁移成本**：现有 pi-astack 项目 `.pensieve/` 含 182 entries，必须一次性 mv（详 [migration playbook](../migration/abrain-pensieve-migration.md)）。其他绑定项目同样要走一遍。
2. **vault 引入 OS keychain 依赖**：systemd user service / launchd 配置首次需要用户手动设置；不同 OS 的实现不同。
3. **多 pi 并发的边界 case**：聚合文件最后写入赢策略接受了"瞬间不一致"代价。极罕见情况下用户可能看到旧版 _index.md（实际无副作用，因为 derived view）。
4. **ADR 0013 的 Lane B/D 失去意义**：迁移期需要文档说明"为什么这两个 Lane 在新架构下消失"——避免未来贡献者困惑。
5. **memory-architecture.md 部分 superseded**：那份文档是 2026-05-07 经两轮三模型评审通过的"权威规范"，现在它的 scope/backend/Facade 部分仍然成立，但物理拓扑（.pensieve/ + ~/.abrain/）需要明确标记 superseded。
6. **vault 明文 redaction 是 best-effort**：false positive（普通字符串恰好匹配）和 false negative（base64-encoded value 不匹配）都存在。这个 trade-off 比"完全不 redact"好两个数量级，但不是绝对保证——用户已知已选。
7. **机器被偷或被未授权 ssh 时 vault 全裸**：开机自动解锁 + 无超时 lock 是用户明确选择换便利；这个风险已知已选。
8. **abrain 主体本身的敏感度**：顶层 identity/values.md / cognitive-profile.md / self-narrative.md 全部进 git。private remote 凭证保护是隐含前置条件——未来需要单独 ADR 处理 abrain repo 本身的供应链安全（commit signing / verified push 等）。
9. **LLM 主动 exfiltration 是已知攻击面**：`echo $VAULT_xxx | base64` 类命令能让明文绕过字面 redaction。不变量 #5 的补充（引用 `$VAULT_*` 的 bash stdout 默认不回流 LLM）是机制性防御，但 prompt injection 场景下远不是绝对保证。在高价值 vault（如 prod credential）上这是主动选择的 known trade-off。
10. **LLM 通用 tool 间接写 brain 是 known residual surface**（v1.3 补，Round 5 Opus NP0-1）：不变量 #1 的层 1 mechanic 仅覆盖定制 mutation tool。LLM 仍可以通过 bash 调 `secret-tool` + `age` CLI 手写加密文件、通过 bash spawn 子 pi（不走 dispatch_agents）、通过 edit/write 工具直接改 markdown SOT。这些路径被 §6.5.1/6.6/sediment audit 三重防护层 best-effort 覆盖，但不是机制保证。与 #9 同类主动选择的 trade-off——补充说明 §不变量 #1 的层 2。

### 中性

- **不影响**：pi extension 系统、dispatch_agents 工具、main session 与 sediment 的进程关系、当前的 memory_search facade 的 LLM-facing 接口形状。
- **简化**：sediment writer 的 scope 概念从"project|world 二选一"变为"abrain 内部七区路由"——`kind: decision/knowledge/maxim/...` 决定子目录，scope 不再是显式选择。
- **延后**：spawn-and-queue / thread / 主体-分身模型 由真实使用驱动，至少观察两个月。

## 实施现状

**P0a-P0c shipped（2026-05-09 → 2026-05-11）+ B1 / B3+B7 / B4 / B4.5 shipped（2026-05-12）+ B5 shipped（2026-05-13）**，**P0d / Lane G 待实施**。完整 plan 在 [migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)（§1 per-repo 一次性迁移模型；原 8-phase plan 已于 v7.1 废止）与 [migration/vault-bootstrap.md](../migration/vault-bootstrap.md)。

### 当前已 ship（vault 子系统 P0）

| 子 phase | 动作 | 验收证据 |
|---|---|---|
| **P0a** | `backend-detect.ts` 七种 backend 探测 + `$SECRETS_BACKEND` env override | `extensions/abrain/backend-detect.ts:127-227` (detectBackend) + `scripts/smoke-abrain-backend-detect.mjs` |
| **P0b** | `bootstrap.ts` master key 生成 / age envelope / tmp 安装 / cleanup（inv1-inv6 事务安全） | `extensions/abrain/bootstrap.ts` + `scripts/smoke-abrain-bootstrap.mjs` |
| **P0c.write** | `vault-writer.ts` set/list/forget + age 公钥加密（不接触 master） + atomic lock + audit | `extensions/abrain/vault-writer.ts:368-449` (writeSecret) + `:478-537` (listSecrets) + `:538-595` (forgetSecret) + `scripts/smoke-abrain-vault-writer.mjs` |
| **P0c.read** | `vault-reader.ts` unlock master + per-key decrypt + `vault_release(key, scope?, reason?)` LLM tool（pre-flight + deny-first + i18n + description rendering）+ `$VAULT_` / `$PVAULT_` / `$GVAULT_` bash injection （default-withheld stdout）+ literal redaction + read-path audit closure | `extensions/abrain/vault-reader.ts` + `extensions/abrain/vault-bash.ts` + `extensions/abrain/index.ts:607-628` |
| **P1（vault 侧）** | strict active project resolver + `/secret` 默认 active project + `--global` / `--project=<id>`（必须匹配 bound active project）/ `--all-projects` | `extensions/_shared/runtime.ts` (resolveActiveProject / bindAbrainProject) + `scripts/smoke-abrain-active-project.mjs` + `scripts/smoke-abrain-secret-scope.mjs` |
| **B1: workflows lane writer** | `writeAbrainWorkflow` substrate 接受 pipeline-型条目，按 `crossProject` flag 路由到 `~/.abrain/workflows/`（跨项目）或 `~/.abrain/projects/<id>/workflows/`（项目特定）；独立 abrain-side lock（`<abrainHome>/.state/sediment/locks/workflow.lock`）+ audit（`<abrainHome>/.state/sediment/audit.jsonl`，lane="workflow"）+ git commit（abrain repo） | commit `b6a4a49`；`extensions/sediment/writer.ts:writeAbrainWorkflow` + `scripts/smoke-memory-sediment.mjs:abrain-workflows-lane-writer` 覆盖 10 个场景（cross-project / project-specific / 4 种 validation / sanitize / dedupe / dry_run / audit / git） |
| **B3+B7: per-file migration substrate 剥离** | 删除 `extensions/sediment/migration.ts` + `/sediment migrate-one` + `/sediment migration-backups` slash 命令与 backup 子系统；文档重写为 per-repo 一次性迁移模型（abrain-pensieve-migration.md 重写 ±200 行） | commit `b33f0e4` 净 +178/-1609 行；smoke 26 transpiled files 全过 |
| **B4: per-repo 迁移执行器** | `/memory migrate` 默认 dry-run（表格预览），`/memory migrate --go` 执行：preflight 检查 strict binding + 有用户条目 + abrain 仓 git clean（父仓 / `.pensieve` dirty 或 untracked 不再 hard-block）→逐文件 frontmatter 归一化（kind/scope/schema_version/Timeline）→ pipelines 走 `writeAbrainWorkflow` 路由→ knowledge kinds atomic write 到 `~/.abrain/projects/<id>/<kind-dir>/`→ 删除/清理 legacy 原件→abrain commit + parent cleanup commit（仅当有 tracked 删除可提交）。B4.5 后 project id 不再由 `--project` / remote / cwd 推断，而从 strict binding 读取 | commits `cc40792` (初出) + `a819302` (P0：索引重建 + pre-SHA rollback + stale docs) + `37f03a6` (P1/P2：GENERIC_BASENAMES + lane 枚举 + 文档 drift；其中 4 处 name-mismatch 在 `122c0b2` 补完) + `122c0b2` (audit 闭环：gitCommitAll pathspec + audit log 路径 + name-mismatch 补位 + smoke 补示)；`extensions/memory/migrate-go.ts` + `scripts/smoke-memory-sediment.mjs:per-repo migration --go` 覆盖 18 个场景（dirty source allowed / dirty abrain 拒绝 / happy path 2 knowledge + 2 workflow / legacy frontmatter 归一化 / .index .state 预过滤 / commits / pre-SHA rollback summary / 幂等带保护 + 6 边界）。另外 sediment 写入锁 stale-lock reclaim （commit `54835cd`）4 个 smoke g.1-g.4 不计入本表 |

| **B4.5: Project Binding Strict Mode** | 新增 `/abrain bind --project=<id>` / `/abrain bind`，写三层身份数据：`<project>/.abrain-project.json`（portable identity）、`~/.abrain/projects/<id>/_project.json`（tracked registry）、`~/.abrain/.state/projects/local-map.json`（local-only multi-path map）。废弃 `~/.abrain/projects/_bindings.md` + git remote / cwd prefix 推断；`/memory migrate` 不再接收 `--project`；未 bound 拒绝 migrate / sediment project writes / project vault scope。详 ADR 0017 | `extensions/_shared/runtime.ts` + `extensions/abrain/index.ts` + `extensions/memory/index.ts` + `extensions/sediment/index.ts`；smoke：strict resolver / bind happy / duplicate path / manifest conflict / path conflict / no partial on path_conflict / path_unconfirmed / migrate missing projectId refused / vault project-scope refused | B5 前置 |

### 待实施

| 子 phase | 动作 | 验收 | prerequisite |
|---|---|---|---|
| **P0d** | TUI onboarding wizard（`/vault init` 全交互菜单）+ `/secret set` mask input + `vault import-env` `.env` ingest | wizard 走完七种 backend dynamic menu + mask + import | — |
| **B5: writer cutover 到 abrain projects 路径** *(2026-05-13 ✅ shipped)* | sediment 6 个 writer 函数（write/update/archive/delete/merge/supersede）一次切完：entry markdown / git commit / lock 全部走 `<abrainHome>/projects/<projectId>/` + `<abrainHome>/.state/sediment/locks/`。`projectSlug` / `ensureProjectPensieveRoot` / `POST_MIGRATION_FLAG_REL` / `read/write/clearPostMigrationGuard` 与 R7 的 6 处 `if (guard) reject` 路径全删。dedupe 扫 abrain projects 树；curator entry-filter 不再要求 sourcePath 前缀 `.pensieve/`。audit / checkpoint 仍 project-local。migrate-go 删除 `writePostMigrationGuard` 调用。 | sediment 6 函数产出落 `~/.abrain/projects/<id>/`；14 仓 grep 无残留 `.pensieve` 写路径；smoke `smoke-memory-sediment` 17 个 writer fixture 全过；production smoke（~/.pi pi-global 项目 + sediment auto-write re-enabled）写入 abrain 验证。 | 2026-05-13 完成 |
| **Lane G G1 ✅ shipped 2026-05-16** | 详 [ADR 0021](0021-lane-g-identity-skills-habits-writer.md)。G1：`writeAbrainAboutMe` writer（三区共 writer） + `parseExplicitAboutMeBlocks` fence extractor + `validateRouteDecision` Lane G 路径 + parser.ts 加 `STAGING_IGNORE_REL_PATHS` walker 排除 staging 进 facade + smoke 全管道 loadEntries 验证。**仍 backlog**：G2 `/about-me` slash、G3 LLM aboutness classifier、G4 `review-staging` slash + staging TTL、G5 region-aware ranking hint。 | G1 smoke 全绿。G2–G5 在 ADR 0021 phase 表跳转 | — |

> 七区拓扑说明（P1-D audit 2026-05-16 round 3 更新）：extension activate 时 `ensureBrainLayout()`（`brain-layout.ts`）会创建全部七个顶层目录。**全七区现均有 writer**：`vault/`（P0c）+ `projects/`（B5 sediment write + memory Facade dual-read）+ `knowledge/`（curator `scope:"world"` 写路径）+ `workflows/`（B1 lane writer）+ `identity/` / `skills/` / `habits/`（[ADR 0021](0021-lane-g-identity-skills-habits-writer.md) G1 三区共享 `writeAbrainAboutMe`，2026-05-16 ship）。Lane G 仍在 backlog 的是 G2 `/about-me` slash + G3 LLM classifier + G4 review-staging + G5 region-aware ranking hint。
>
> **与 abrain-pensieve-migration.md 原 8-phase 计划的差异**（v7.1 修订，2026-05-12；B5 后源仓 precondition 放宽）：原 P5-P8 持锁渐进迁移 · writer cutover · symlink · 删 fallback 四个 phase 合并为 **单仓一次性迁移**（`/memory migrate --go`）：abrain git history 是目标侧 rollback 网，父仓 cleanup 是 best-effort/pathspec 限定 → 不需 backup 不需 symlink；per-repo 手工执行 → 不需 8-phase 全局协调。单用户场景 14 个仓变更不频，原为多人多机设计的渐进 phase 是过度工程。

关键约束（v7.1 单仓一次性迁移模型，B5 后修订）：父仓 / `.pensieve` clean+tracked 不再是 precondition，迁移读取 working tree 当前快照（包含 dirty / ignored / untracked）；迁完单仓后该仓 forward-only。取消迁移时，abrain 侧用 summary 打印的 `abrainPreSha` reset；父仓侧只有迁移开始时 clean 且没有 ignored/untracked source 被迁移时才建议 `git reset --hard <parentPreSha>`，否则用 `git revert -n <parentCommitSha>`（审阅后再提交）或手工从 abrain 恢复，避免误删 unrelated work / dirty ignored untracked 唯一副本。不依赖自定义 backup 子系统。不用 `HEAD~1` 是因为 abrain 会产生 N workflow commit + 1 migrate-in commit（N+1 个），且 sediment 可能并发插 commit。详 [abrain-pensieve-migration.md §5](../migration/abrain-pensieve-migration.md#5-回滚)。

B4 已 ship（2026-05-12，commit `cc40792` + 后续完善）；B5 writer cutover 已 ship（2026-05-13）。接下来是手动逐仓迁移剩余 12 仓（14 仓中 opencode-global + pi-global 已完成）。

## 审计扩展

**Cross-log timestamp 契约**（v1.3 补，Round 5 DS P1-D；Round 6 gpt-5.5 P3 修正）：sediment-events.jsonl（project + abrain 各一份）与 vault-events.jsonl 均为独立日志流，**跨流事件顺序按各自时间戳字段关联**——具体字段名实际**不一致**（源码权威）：

- sediment audit（`writer.ts:appendAudit` + `appendAbrainWorkflowAudit`）：行内字段名是 **`timestamp`**，值用 `formatLocalIsoTimestamp()`（local-tz aware），且每行携带 `audit_version` / `pid` / `project_root` 或 `abrain_home` 等 v2 enrichment 字段。
- vault audit（`vault-writer.ts:appendVaultEvent`）：行内字段名是 **`ts`** + `op`，schema 见 `VaultEvent` interface (`vault-writer.ts:232`)。

两个 schema **没有 shared base** —— 审计 merge-sort 工具需要同时支持 `timestamp || ts` 两个字段名。两个流之间**无全局序列号保证**；写入侧的持久性也不对称：vault append 走 `openSync + writeSync + fsyncSync`，sediment append 走 `fs.appendFile`（无显式 fsync），OS 崩溃时 vault 行更可能存活——这是 by design（sediment 数据真相在 git history，可重建；vault 事件是 fact-only log，无法重建）。

ADR 0013 要求每条 sediment audit row 含 `lane: "explicit" | "promote" | "auto_write" | "auto_promote"`。Lane G/V/workflow 引入后，lane enum 必须同步扩展：

```jsonc
// abrain audit (~/.abrain/.state/sediment/audit.jsonl) — lane 字段枚举
// project-side audit (<projectRoot>/.pi-astack/sediment/audit.jsonl) 同 schema，
// 只是 lane 取值集合更小（不会出现 workflow / about_me / vault_write）
{
  "lane": "explicit"      // Lane A — 仍有效（project 端）
         | "auto_write"    // Lane C — 仍有效（project 端）
         | "workflow"      // B1 新增 — writeAbrainWorkflow 写入（abrain 端独立 lane）
         | "about_me"      // Lane G — 待 Lane G writer ship 后启用（当前 grep 0 命中）
         // 注：vault writes 走独立 schema（vault-events.jsonl，op-based），不在此 lane enum 集合
         | "system" | "window"  // 内部 skip / 调度标签（不在 ADR 决策面，仅诊断用）
         // “promote” / “auto_promote” 不再处于枚举内——abrain 内部无 promote
}
```

**三处 audit log**（命名实际差异，源码权威）：
- project-side sediment：`extensions/_shared/runtime.ts` `sedimentAuditPath(projectRoot)`
- abrain-side sediment（workflow + future Lane G）：`extensions/_shared/runtime.ts` `abrainSedimentAuditPath(abrainHome)`
- vault：路径未抽到 `runtime.ts` 共享 helper；是 `extensions/abrain/vault-writer.ts:61` 的私有常量 `VAULT_EVENTS = path.join(".state", "vault-events.jsonl")`。与 sediment audit 独立 —— op-based schema，不进 sediment-events `lane` 枚举集。
- `<projectRoot>/.pi-astack/sediment/audit.jsonl`：project 端 Lane A / C 走这里（曾用 `.pensieve/.state/sediment-events.jsonl`，已由 `ensureSedimentLegacyMigrated()` 一次性迁移，仅 read-only 兼容）
- `~/.abrain/.state/sediment/audit.jsonl`：abrain 端 Lane G / workflow 走这里（B1 引入）
- `~/.abrain/.state/vault-events.jsonl`：**Lane V 独立 schema**（op-based，不是 lane-based；与上面两个 sediment audit row schema 不共用 `lane` 字段）

[memory-architecture.md](../memory-architecture.md) 的 supersede banner 同步修正为："audit row schema → 扩展 lane 字段，见 ADR 0014"。

### §vault-events.jsonl op 枚举（P0c.read audit closure, v1.4.6 / 2026-05-11）

`vault-events.jsonl` 不仅记录写入，也记录 P0c.read 路径的所有鉴权决策。`VaultEventOp` 完整枚举（见 `extensions/abrain/vault-writer.ts`）：

| op | 写入点 (lane) | 语义 |
|---|---|---|
| `create` | write path | `/secret set` 首次写入某 key |
| `rotate` | write path | `/secret set` 在已存在 key 上重写 |
| `forget` | write path | `/secret forget` 删除加密件（保留 _meta） |
| `recovered_missing_audit` | reconcile | crash 后启动 `reconcile()`（`extensions/abrain/vault-writer.ts:596`）扫描 vault 目录，为缺失 audit 的 _meta 文件补写一行 |
| `release` | vault_release | TUI 授权通过，明文已交付 LLM |
| `release_denied` | vault_release | TUI 拒绝（`no` / `deny_remember` / `session-deny` / …） |
| `release_blocked` | vault_release | pre-flight 拒绝在授权之前（key 不存在 / pre-flight 错 / decrypt 错） |
| `bash_inject` | bash tool_call hook | `$VAULT_*` / `$PVAULT_*` / `$GVAULT_*` 匹配，env file 已写入 |
| `bash_inject_block` | bash tool_call hook | bash hook 拒绝（key 缺 / `$PVAULT_*` 无 active project / decrypt 错） |
| `bash_output_release` | bash tool_result hook | 用户授权后续补发 redacted stdout/stderr 给 LLM |
| `bash_output_withhold` | bash tool_result hook | 用户拒绝 / 默认 withhold |

**不变量**：
1. **Plaintext NEVER enters audit rows**——`VaultEvent` 类型本身没有 `value` 槽；smoke (`smoke-abrain-vault-writer.mjs` 中 `appendVaultReadAudit` 断言) 验证任意 read-path row 不含 `value` 字段与 `"plaintext"` 字串。
2. **`command_preview` 只含变量引用**（`$VAULT_<name>`）——bash hook 在执行前重写命令，预览才抓取，所以不会被插值后的明文污染。长命令以 `truncateForPrompt(value, 240)` 截断（保头保尾）。
3. **`bash_inject` row 携 `variables[]`**：包含 `varName → scopeKey` 映射（例 `{varName: "VAULT_github_token", scopeKey: "global:github-token"}`）以供取证；bash multi-key row 用 `keys[]` 而非单个 `key` 字段。
4. **入口函数**：read-path 只能走 `appendVaultReadAudit(abrainHome, evt)`；write-path 走 内部 `appendVaultEvent`。两者同一个追加点 + fsync 路径。
5. **静态契约 smoke**：`smoke-abrain-backend-detect.mjs` 断言 7 个 read-path op 字面都出现在 `extensions/abrain/index.ts` 的 callsite——未来重构不能静默丢掉任一分支。
6. **失败语义**：audit 写失败 best-effort——`safeAuditAppend` 不 throw，vault 决策路径不被 audit 障碍（observability != enforcement）。

## 与上游 ADR 的关系

| 上游 | 关系 | 说明 |
|---|---|---|
| ADR 0003 主会话只读 | **保留** | sediment 仍唯一 writer，主 session 仍只读 |
| ADR 0010 sediment single-agent | **保留** | sediment 内核完全不动 |
| ADR 0011 / 0012 | 已被 memory-architecture.md superseded | 不变 |
| ADR 0013 三 Lane trust | **扩展为四 Lane** | A/C 保留，B/D 失去意义，新增 G/V |
| memory-architecture.md | **部分 superseded** | scope=project\|world 二元划分被吸收到 brain 七区结构；`.pensieve/` 物理位置废止；其余（writer policy、validation、rolling gate 等）保留 |

## 开放问题

| Q | 问题 | 当前答案 |
|---|---|---|
| Q1 | identity vs habits 边界（Q-A） | **trust 与目录路由分离**。Lane G 保证 trust=高，Lane C 保证 trust=中；identity / habits / skills 三区由 sediment 按 aboutness 分类路由（**不是 Lane↔目录硬绑定**）。habits 接受 Lane C 主写也接受 Lane G 校正；identity 通常 Lane G，sediment 跨多 session 稳定观察才能补充（高门槛）。具体路由规范见 [spec](../brain-redesign-spec.md) |
| Q2 | workflows MVP 写入策略（Q-B） | 保留目录占位，MVP 不主动 sediment 写；等用户主动声明再开始填 |
| Q3 | 团队协作 fallback（Q-C） | MVP 不实现 export 命令；等真有协作需求再加 `pi project export` |
| Q4 | vault key 命名规范（Q-D） | 自由形式，推荐 `<env>-<service>-<purpose>`，不强制 |
| Q5 | 多设备同步 vault（Q-E） | P0c.write 推荐 encrypted artifacts + metadata 随 abrain private git 同步；ssh/gpg secret key 不进 git、由用户自管。macOS/secret-service/pass 等非文件 backend 仍可能需要用户用 rsync/syncthing/iCloud 等方式同步或重建 unlock 条件；vault 自带 export/import 暂属过度工程 |
| Q6 | 跑通 2 个月后是否需要主体/分身？ | 不预设。基于真实 pain point 在另开 ADR 015+ 评估 |
| Q7 | OpenClaw 借鉴边界 | 个别工程模式可参考（sandbox 白名单、JSON Schema、device pairing）；架构理念不照搬（OpenClaw 是 short-task lifestyle，alfadb 是 long-haul cognitive） |

## 参考

### 触发文档（讨论 trace）

- 三轮多模型辩论 raw output：~/.pi/agent/sessions/--home-worker-.pi--/2026-05-09T*.jsonl line 101 (R1, 200.0s) / line 122 (R2, 179.1s)
- 萃取摘要：`/tmp/omni-discussion/round1-summary.md`、`/tmp/omni-discussion/round2/{opus,gpt,ds}.md`
- 草案：`/tmp/omni-discussion/brain-layout-v0.1.md`（initial）→ `brain-layout-v0.2.md`（收敛）→ 本 ADR + spec

### 相关项目

- [OpenClaw](https://github.com/openclaw/openclaw)（Peter Steinberger，依托 pi-mono）：short-task lifestyle 助手，与本 ADR 场景不同但部分工程模式可参考

### 详细规范

- **[brain-redesign-spec.md](../brain-redesign-spec.md)** —— 七区目录细则、Lane G/V 命令语义、vault 双层完整规范、并发处理、迁移路径
