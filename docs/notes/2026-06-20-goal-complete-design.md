# Goal 系统完整设计（T0 两轮收敛定稿，2026-06-20）

> 收敛过程：R1 四份独立完整设计 → R2 收敛轮。**骨架 4/4 批准、零 objection**；分歧 D1 工具面 3:1、D2 证据账存放 3:1、D3 v1 边界 4/4——少数方均明确让步。面板：kimi-k2.7-code / gpt-5.5 / deepseek-v4-pro / MiniMax-M3，主会话（Anthropic）综合。
> 关系：本文是**完整架构（愿景 + 分期）**；`2026-06-20-living-plan-ledger-v1-impl-draft.md` 是其 **v1 切片**的代码级 impl 细节。

## 0. 更正（2026-06-20，用户指出，覆盖 D2 投票）
原 D2「证据账 git 跟踪 `.pi-astack/goal/evidence/`」**作废**。两条硬事实：(1) `.pi-astack/` 在 `.gitignore` 明确忽略，directory-layout.md §4 写死「runtime state/log/output，应 gitignored，不是 memory SOT」；(2) 现有 goal 架构的 SOT 是 **session 事件树**（`pi-goal-event`，随分支 fork/resume），`.pi-astack/goal/` 只是可重建的**物化视图**。根因是 D2 选项措辞把 evidence 锚到了按约定不跟踪的目录，面板在不知此事实下投了「git 跟踪」。**更正后：证据账 = `pi-goal-evidence` 事件条目（SOT，随 fork）+ `.pi-astack/goal/` 物化视图（gitignored 缓存），非 git 跟踪**。详见下方 §A/§E/§投票留痕已改。

## 0.1 接地复审发现（2026-06-20，T0×4 读真实代码审计）
4 家一致：D2 更正本身成立（事件源有 `pi-goal-event` 真实先例：state.ts `replayGoalEvents` + index.ts:490 用 getBranch），但揪出同型 grounding gap 若干——**v1 比「薄」更重，下列须在写码前定**：
- **G1（blocker，4/4）**：`replayGoalEvents` 是 last-write-wins（每事件带全量 state 快照），证据是 append 累加——直接复用会让同一 criterion 第二次 check 覆盖而非追加。须新写 `replayGoalEvidenceEvents` 做 fold（按 criterion_id）。
- **G2（deepseek/MiniMax）**：goal 扩展现无写用户文件能力（只有 readGoalDoc，无 writeGoalDoc；只写自己 .pi-astack 视图）。“goal_check 写 [x] 进 plan.md”是新能力。**更优解（拟采纳）：goal_check 不写 doc——AI 用 edit 写 [x]/[~]，goal_check 只记证据，注入 parser 在渲染时按证据匹配把 [x] 判定为有效/降级 [!]。** 扩展永不写用户 doc，更贴“验证不写、只核”。
- **G3（kimi/gpt/MiniMax）**：goal_check(cmd:) “真跑”是新能力——扩展现无 shell 执行路径（grep child_process 无）。须建 exec（child_process）+ 安全边界（allowlist/超时/no-tty/cwd）。
- **G4（gpt/MiniMax）**：goal_check 未挡 machine turn / sub-agent。`isCurrentTurnGoalContinuation` 挡 set/resume 未挡 check；sub-agent 用 inMemory()，readSessionId 经 getSessionFile() 已 fail-closed（gates 住）但须显式 pin。
- **G5（kimi/MiniMax）**：§A 称 criteria SOT=plan.md 行，但现实 success_criteria 是 /goal set --criteria= 的静态数组、plan.md 从未被解析。cross-check 的 criterion_id 取自哪边须定（v1 须加 plan.md parser）。
- 文档残留（部分已就地修）：§G “证据账（git 文件）”→事件源；§E 截断句补全；§B vs v1draft `goal_log` 矛盾（按 D1 只留 goal_check，删 goal_log）；evidence schema 补 session_id；.json/.jsonl 统一为 .json 视图。
结论：可推进，但先做一轮“实现就绪”决议把 G1-G5 定了再写码。

## 0.2 G1-G6 实现就绪决议（2026-06-20，T0×4 投票，用户授权 T0 自决）
G1-G5 均收敛到 ①，并新增 4/4 一致的 G6：
- **G1（4/4 ①）**：新写 `replayGoalEvidenceEvents`，按 criterion_id 留**全量 append 历史**（含失败）；当前状态=最近一次成功且仍有效。`replayGoalEvents`（LWW 快照）不动，另起 fold 函数。
- **G2（4/4 ①）**：**扩展永不写用户 doc**。AI 用 edit 写 `[x]/[~]`，goal_check 只记证据；parser 渲染时判 verified/降级 `[!]`。避免“扩展写 [x] → 下轮当自己证据”的循环依赖。status 分两列 `claimed N | verified M`。
- **G3（3:1 ①，deepseek 投③不重跑）**：child_process spawn 真跑（cwd+超时+no-tty+捕 exit/输出 sha+输出封顶），不做硬 allowlist（命令本就能在 AI 的 bash 跑）；可加“危险命令拒绝/确认”软护栏。
- **G4（4/4 ①）**：goal_check 加 `isCurrentTurnGoalContinuation` gate（machine/continuation turn 禁 check，否则判官自喂）；sub-agent 经 readSessionId/getSessionFile 已 fail-closed，显式 pin。
- **G5（3:1 ①，deepseek 投②slug/hash）**：plan.md parser 为 criteria SOT，criterion_id=显式 `- [ ] (id) text` 标记；缺 id 时 parser 报错+建议/`--auto-id` 首注降摩擦。新增 `CriterionDef {id,text}`，旧 `string[]` 自动生成 id 向后兼容。
- **G6（新，4/4 一致）：证据有效期/防漂移锁**。每条 evidence 快照 check 时的 criterion 文本 + 输入指纹（相关 file sha 集 / cmd sha）；当前 plan.md 文本或输入与快照不符 → parser 渲染为 **stale**（降级，须 re-check），不沿用绿勾。堵死“改文案/漂代码还留 [x]”，也是 G1“仍有效”的判据。
- **evidence schema**（gpt/deepseek）：`{goal_id, session_id, criterion_id, criterion_text_sha, kind, raw, result:{exit,stdout_sha}, input_fp, turn, ts, status:verified|failed}`。
结论：设计达到**实现就绪**；impl 草案将按 G1-G6 整段重写（G2 无写、G6 指纹 ripple 较大，重写比打补丁干净）。

## 核心命题（一句话）
**两账分离**：人读的「真账」(plan.md，user/AI 写) + 机器可回放的「执行账」(evidence ledger，事件源)，**两账对账不合并**；AI 谁都能在 plan.md 写 `[x]`，但**只有 OS/git 进程域的 `goal_check` 记下匹配证据才算有效**（否则渲染 `[!]`）——「验证不由同一 AI」落地为「**进程边界 = 信任边界**」(不是第二个 LLM)。

## A. 概念分层
| 层 | 载体 | 持久 |
|---|---|---|
| 目标 Objective | goal 元数据（一行 / doc 指针） | 是（事件溯源） |
| 计划 Plan | plan.md 步骤序列 | 是（git） |
| 验收 Criteria | plan.md `[ ]/[~]/[x]` 行 | 是（git） |
| 当前状态 Current State | **每轮从 plan.md 派生** | 否（派生，不另存 cursor） |
| 决策日志 Decision Log | plan.md append-only 段（纯文本散文） | 是（git） |
| 证据账 Evidence Ledger | **session 事件树**（`pi-goal-evidence` 条目=SOT）+ `.pi-astack/goal/` 物化视图（gitignored 缓存） | 是（事件溯源，随分支 fork；**非 git 跟踪**） |
| 预算/元 Meta | goal 状态机 | 是（事件溯源） |

## B. 工具与命令面（D1：只加 goal_check，3:1）
- 保留：`goal_set / status / pause / resume / stop / clear`。
- **新增唯一工具：`goal_check(criterion, evidence)`**。
- 决策日志 / 进度 / note：一律 `edit` doc（纯文本 append）。
- 不加：plan tool / mode 切换 / todo DB / `goal_decide` / `goal_progress`。原则：「能 `edit` doc 的不开新工具；只有必须系统亲跑才升格成工具」。
- 异议澄清：MiniMax 主张加 `goal_decide`（防裸 edit 决策日志产生 `[!]`），已让步；**关键澄清——`[!]` 只针对 `[x]` 验收勾，决策日志是散文非勾选，裸 edit 不产生 `[!]` 风险**，故 ① 干净。

## C. 注入模型
- 热区 ≤500 tok 每轮重注：目标一行 + 当前状态(in_progress/阻塞) + 未勾验收 + 最近 3 决策 +（doc 路径/预算）。
- **每轮从 plan.md 重新解析**（+ 回放最近 evidence），不靠对话 history 自然留存——与 codex 的根本分歧点。
- 冷区（全文 / 决策日志全文 / 证据账）：按需 `read`。
- 超预算：硬报错；决策按 LRU 截或子预算切（MiniMax D4）。解析失败 fail-safe 退回「指针行为」，绝不打断 before_agent_start。

## D. 验证模型
- `[x]` **只能**由 `goal_check` 产生。
- evidence ∈ `cmd:`（真跑，记 exit + 输出 sha） / `file:`（存在+非空，记 mtime/size/sha） / `git:<sha>`（校验存在）。`cmd:` 真跑护栏：超时 + no-tty + 证据命令应幂等/只读。
- **写路径（deepseek D4 澄清）**：`goal_check` 把证据写入**证据账**，只把 `[x]` 写入 plan.md——「两账分离」落到写路径。
- **失败也入账（kimi+gpt D4）**：`goal_check` 失败 → 写证据账 `status:failed` + 建议，但**绝不**改 doc 的 `[ ]/[~]/[x]`（失败不降级、不伪造）。保「可回放」连失败路径一起留，供回归/复盘。
- `[!]` = 裸 `edit` 的 `[x]`（证据账查无匹配）→ 注入时渲染降级、不计完成。**强制为结构性（parser 交叉核验），非 LLM 自律**（MiniMax D4：被审者不能自审）。
- `[~]` = 已做未独立验证泄压阀（**v1，4/4**）；散文理由，不入证据账，下轮须升 `[x]` 或回退。
- 「独立」= OS/git 进程域，非第二个 LLM；单人自用，进程边界即信任边界。

## E. 生命周期
- 挂账本（默认不挂）：`doc=` / criteria>3 / 首次 `goal_check` / 涉 git 产物。
- auto-continue 判官：只读 doc+证据账，**禁写 `[x]`**，只建议下一步或 stop；其「禁写」靠非-LLM 结构（parser / pre-tool-call 钩子扫 `[x]`），不靠判官自律。
- fork/resume：plan.md（用户文件，是否进 git 由用户定）+ 证据账（session 事件树，随分支 fork）；从 doc+证据重建。evidence 条目内携带 check 时的 git sha，同 sha 可复用/识别过期。
- GC：完成归档；stale(N 天无活动) 提示；plan.md 留 git 不主动删。
- **证据账存放（D2 已更正）**：SOT = `pi.appendEntry("pi-goal-evidence", …)` 事件条目（与现有 `pi-goal-event` 同模式：随分支 fork、resume 后仍在、可回放）；`.pi-astack/goal/<sessionId>.evidence.json` 仅作 **gitignored 物化视图/快查缓存**，可从事件重建。**不 git 跟踪**（`.pi-astack/` 本就 gitignored）。
  - 放弃的属性：跨机器经项目 git 复制证据——但这在 gitignored 的 `.pi-astack/` 下本就不可行，且非 v1 需求。诚实降级：在新机器/克隆上打开一个 committed 的 plan.md，其 `[x]` 因本地无匹配 evidence 而渲染成 `[!] 未验证`，须 re-check——这正是「验证不由旧的 AI/机器声明背书」原则的正确收尾，不是缺陷。

## F. 非目标（两条线，4/4 一致）
- 不走 codex 极简端：纯自报 status / 无证据 / 无文件 / 跨 compaction 靠运气。
- 不走过度工程端：todo DB / plan schema / 依赖 DAG / 多 agent / Gantt / RBAC / 优先级矩阵 / 自动生成计划 / 强制所有 edit 走工具 / 第二个 AI 审计（→ v2+）。
- 划线：**验证薄而硬（核心承诺不省）；其余全松（plan/状态/决策都靠 doc 自然语言）**。plan.md = SOT。

## G. 分期路线
- **v1（薄，= living-ledger impl draft）— 已实现 + live 验证**：`goal_check(cmd/file/git，含失败入账)` + section-aware 热区注入 + `[x]/[!]/[~]` 三态（parser 强制） + 证据账（事件源 SOT + gitignored 视图） + 决策日志（edit doc）。
- **v2 — 已实现 + live 验证**：auto-continue 判官接证据账 / 证据账可视化（`goal_status` 展示最近 N 条 check） / GC 归档（goal_id 隔离 + gcEvidence 压缩 + staleByTime） / evidence 按 sha 去重缓存（仅 cmd + 有声明 inputs）。
- **v3 — 路线裁决（2026-06-20，跨厂商 T0 盲评 5 家：gpt-5.5 / deepseek-v4-pro / kimi-k2.7-code / MiniMax-M3 / glm-5.2，主会话只主持不投票）**：「现在挑一项做」全票 NONE——数据门未达（v1/v2 仅 smoke + 自参考 dogfood，非持续真实使用证据）。逐项裁决：
  - **第二 AI 审计 — DROP（5/5）**：违 v1 核心命题（信任=OS/git 进程边界，非第二个 LLM；AI 共享盲点）+ 本就 §F 非目标；判官已读账本只信 `[verified]`，再加审计 AI 是冗余。
  - **criteria 依赖图 DAG — DROP（5/5）**：§F 已列过度工程；自然语言列表顺序已表依赖，形式化 DAG 会在分解事后证错时反挡正确动作，且使 plan.md 退化成 DSL。
  - **plan mode 只读 — DROP（4/5，gpt 软化为不建子系统）**：典型机械主义；§B 已关「mode 切换」；危险操作 exec.ts 软护栏已管；prompt/约定即可达成。属 harness 层、非 goal 职责。
  - **跨会话 goal pool — 不建注册表（DROP 2 / DEFER 3，均归结为现在不建）**：plan.md 放固定路径**本身即跨会话 pool**（§E：新会话打开 committed plan.md → `[x]` 渲染 `[!]` 待本地 re-check）；建注册表=把 §F 否决的 todo-DB 偷渡回来。需求由约定满足。
  - **多 goal 并行 — DEFER（5/5，唯一「以后值得」能力）**：无 §F/命题冲突、有真实摩擦故事，但工程面 ≈2-3× v2（state 单例→列表、热区预算×N、判官选标的、goal_check 带 goal_id、status/dedup/GC/reconcile 全改）。**触发**：outcome-ledger 真记录到用户在同一会话为两条独立目标反复 goal_set 互相覆盖。
- **开门数据（v3 闸的钥匙，不在原清单上）**：把 v1/v2 用到 N 个真实、非自参考的异质任务上，由 outcome-ledger 统计 `[!]`/`stale` 的有用触发 vs 被忽略噪声、verified-vs-claimed 是否拦住用户在意的漂移。这份数据才决定 v3（实质只剩「多 goal 并行」一项）是否动。
- 一句话路线：**先把 markdown 钉成 SOT、把「完成」做成需要证据的工具调用，其余一律不动；v3 经盲评从 5 项剪到「实质 1 项且 DEFER」，体验和重规划留待真实使用数据驱动。**

## 从 codex 借的微纪律（写进注入约定，§11 of codex 分析）
1. **不复述**：注入了状态就禁止模型在回复里复述账本（省 token）。
2. **禁 pending→completed 跳变**：`[ ]→[x]` 不许一步到位，强制经 `[~]`/in_progress，天然制造「该调 goal_check」的停顿点。
3. **跳过最简单 25% / 不做单步 plan**：印证「小任务纯目标不挂账本」的阈值。

## 收敛投票留痕
- 骨架（A-G）：4/4 批准，零 objection。
- D1 工具面 → ① 只加 goal_check（kimi/gpt/deepseek 投①，MiniMax 投②已让步）。
- D2 证据账 → 原投 ② git 跟踪文件（3:1）；**已被用户更正覆盖**（见 §0）：`.pi-astack/` 按约定 gitignored，证据账改为 `pi-goal-evidence` 事件源（SOT，随 fork）+ `.pi-astack/` 物化视图缓存，非 git 跟踪。投票基于错误的位置前提（我的 D2 选项措辞之过）。
- D3 v1 边界 → ① `[~]` 入 v1 + 决策日志入 v1（4/4 一致；deepseek 由 R1 的 v2 改投 v1）。
- D4 增补（全采纳）：失败入账；失败只记不改 doc；goal_check 写路径=证据→账、`[x]`→doc；`[x]` enforcement 结构性非自律；热区超预算 LRU 截决策。
