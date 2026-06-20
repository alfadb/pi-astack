# 活账本（living plan ledger）薄 v1 — impl 草案

> 状态：草案，待用户过目。决策链见对话：要不要 todolist → goal 已覆盖多少 → 纯目标 vs checklist（T0 3/3）→ checklist 会错/会变 → 重定义为"活账本"→ 方案 T0 设计评审（3/3 ship-with-changes）→ scope 决策（T0 4/4 全票 B 薄 v1）。
> 血缘：ADR 0032（goal runtime）/ 0033（doc-driven goal）。本草案是对 `extensions/goal/` 的最小增量，**不建新 todo 工具**。

## 0. 必须先纠正的事实前提（影响设计，不改决策）

之前讨论（含给 T0 的题面）说"`goal_set(doc=plan.md)` 把整个 doc 每轮重注入 system prompt 尾部"。**读 `state.ts` 后确认这是错的。**

真实行为（`state.ts:formatGoalBlock` + `index.ts:before_agent_start`）：
- doc 型 goal **只注入一行指针**：`Goal document: <display_path>` + `Read/update that document when you need the full plan; this block is only the compact pointer.`
- 每轮注入的 `success_criteria` 来自 `/goal set --criteria="a;b"` 的**静态字符串数组**（`GoalState.success_criteria`），**不是从 doc 解析的**，且无 done 状态。
- doc 正文**从不进 prompt**；AI 想看 plan.md 必须自己 `read`。

两个结论：
1. **"漏洞1（全量注入 doc + append-only 日志撑爆 context）"在今天的代码里不存在**——因为 doc 正文压根没注入。所以"section-aware 注入"不是"裁剪现有全量注入"，而是**从'只有指针'升级为'注入热区'**。
2. 但这也意味着：**今天 doc 型 goal 根本没有"靠重注入对抗 compaction 漂移"的能力**——只有一行"去读文件"的软提示。这正是 MiniMax 警告的"软约束、30 轮后被无声跳过"，而且是当前默认态。薄 v1 的改动 #1 恰好把这条软约束升成硬约束（热区每轮真注入，覆盖脑内状态）。

## 1. Scope（锁定，T0 4/4 全票 B）

**两处必做（缺一即降级为无强制力的 A）：**
- 改动 #1：section-aware **热区注入**（替换 doc 型的指针-only 行为）。
- 改动 #2：**system-recordable 证据校验**（含四家一致要求的"可回放 + `[~]` 泄压阀"）。

**明确延后（不做）：** 漂移对账、自动 re-derive、结构 lint/语义校验、定期 nudge、多 doc 防串台。

## 2. 改动 #1：热区注入

**触点：** `state.ts:formatGoalBlock`（doc 分支）+ 新增一个 doc 解析器；`index.ts:before_agent_start` 的注入路径不变（仍走 `wrapVolatile` + `stripGoalBlock` + 尾部 append，prompt-cache 安全）。

**解析规则（plan.md → 热区）：** 按 markdown section 标题切片，只取热区：
- `# 目标` 一行
- `# Updated: turn N  active: <sub-task>` 一行
- `## 验收标准` 中**未勾 + `[~]`** 项（已勾 `[x]` 进冷区）
- `## 当前状态`（方案 / 下一步 / 阻塞）整块
- `## 决策日志` 的**最近 3 条**

**冷区（不注入，AI 按需 `read` plan.md）：** 已勾验收项、完整决策日志。

**Token 上限：** 热区拼好后 **≤ ~500 token 硬上限**；超出 **硬报错不静默裁剪**（沉默裁剪会丢"下一步/阻塞"这种关键信息且无告警）。报错形式：注入一行 `⚠ ledger hot-zone over budget (N tok) — compress 当前状态/合并阻塞项` 让 AI 自己压缩。

**决策日志归档：** 当 `## 决策日志` 行数 > 阈值（默认 30），最旧的滚到同目录 `plan.md.archive`（append），plan.md 只留尾部 N 条。归档由 sanctioned mutator（见 §3 `goal_log`）触发，不靠裸 edit。

> 注：热区解析失败（plan.md 结构不符）时 **fail-safe 退回当前的指针-only 行为** + notify，绝不让解析异常打断 before_agent_start。

## 3. 改动 #2：system-recordable 证据校验

**问题：** goal 扩展不拥有 doc 写入——AI 用通用 `edit` 改 plan.md，扩展无法"拦截 `[x]`"。纯形式校验又被四家一致判定会被"形式合法语义空洞"绕过（`cmd: echo done`）。

**设计：sanctioned mutator + 注入时交叉核验 + 旁路证据账。**

### 3.1 新增 sanctioned mutator（扩 goal 工具面，非新 todo 工具）
- `goal_check(criterion_id, evidence)` — **唯一被认可的勾选路径**。`evidence` 必须是三选一：
  - `cmd:<shell>` — 系统**真的执行**该命令，记录 exit code + stdout/stderr 的 sha256；exit≠0 → 拒勾，返回失败。
  - `file:<path>[:lineRange]` — 系统 `stat`（+可选 grep lineRange），记录 mtime + size + 内容 sha；不存在 → 拒勾。
  - `git:<sha>` — 系统校验该 object 存在于当前 repo，记录 sha + 一行 subject；不存在 → 拒勾。
  - 校验通过后，由扩展把 plan.md 对应项写成 `[x] <criterion> — 证据: <evidence>  (verified @turn N, <recorded-ref>)`，并写一条旁路证据账。
- `goal_log(entry)` — append-only 写 `## 决策日志`，自动加 `T<turn>` 前缀，超阈值触发归档。让 AI 改账走它而非裸 edit（避免改坏结构 + 统一触发归档）。

### 3.2 旁路证据账（system-recorded，可回放）
**位置更正（2026-06-20，用户指出）**：`.pi-astack/` 按约定 gitignored（`.gitignore:7` + directory-layout.md §4），不得当持久 SOT。故证据账 SOT = `pi.appendEntry("pi-goal-evidence", …)` 事件条目（与现有 `pi-goal-event` 同模式：随分支 fork、resume 后仍在）；`.pi-astack/goal/<sessionId>.evidence.json` 仅作 **gitignored 物化视图/快查缓存**，可从事件重建。每条事件：
```
{ "criterion_id": "...", "evidence_kind": "cmd|file|git", "evidence_raw": "...",
  "result": { "exit": 0, "stdout_sha": "...", "...": "..." },
  "turn": N, "ts": "...", "replayable": true }
```
**这是"可回放/可复核"的落点：记录的是系统亲自跑/stat/verify 的结果，不是 AI 写的字符串。**

### 3.3 注入时交叉核验 + 可见降级
热区解析每个 `[x]` 时，拿 criterion 去 evidence.jsonl 对：
- 有匹配 verified 记录 → 正常渲染 `[x]`。
- **无匹配记录（= 有人裸 `edit` 直接打了 `[x]`）→ 热区渲染为 `[!] <criterion> — 未经系统验证`** + 一次 notify。做不到"阻止写入"，但做到"**裸勾立刻在每轮 prompt 里现形、且不计入完成**"。

### 3.4 诚实泄压阀 `[~]`
`[~] <criterion> — 已做，未独立验证` 是合法状态：AI 不必为过校验而造假。语义：进度可见、但**不计入验收完成**、热区照常注入（属未完成侧）。

### 3.5 诚实边界（写进文档，避免假安全感）
`goal_check(cmd:...)` 保证的是"**这条命令系统亲自跑过且 exit 0，结果系统记的**"，**不保证命令语义充分**（AI 仍可挑 `echo done`）。最后一道"命令是否真能证明这条验收"的语义判断，**外移给用户**——证据账设计成用户可复核（跳转 cmd 输出 / 文件位置 / commit）。这正是"验证不由做事 AI 自己说了算"的落地：事实层（跑没跑、过没过）交系统，语义层交人。

## 4. 账本模板（plan.md，发给用户/AI 的样板）
```
# 目标（不变量）: <一句>
# Updated: turn <N>    active: <当前子任务>

## 验收标准（[x]=系统已验证 / [~]=已做未验证 / [ ]=未做）
- [ ] A — 证据: cmd:`npm run smoke:x`
- [x] B — 证据: file:./dist/bundle.js   (verified @turn3)

## 当前状态（整块替换，禁止局部改）
- 方案: <approach B>
- 下一步: <下一轮第一个具体动作>
- 阻塞/风险: <if any>

## 决策日志（goal_log 追加；>30 行自动归档 plan.md.archive，永不注入）
- T5 试 A，因 Y；失败因 Z（证据 E）；转 B，因 W
```
（相对上一轮：砍了"已确证"——与 `[x]` 重叠会双写漂移。）

## 5. 何时挂（约定，不进代码）
仅当任务 ≥5-7 依赖步骤 / 跨文件 / 跨轮会触发 compaction / 有验证门禁 才 `goal_set(doc=plan.md)`；小任务纯目标不挂。

## 6. Smoke（必须真跑，不靠"另一个 AI 也觉得行"）
- `smoke:goal-ledger-hotzone`：构造一个含全 section 的 plan.md，断言热区只含未勾项+当前状态+最近3决策、冷区不进、超预算硬报错。
- `smoke:goal-evidence`：`goal_check(cmd:exit0)` → 写 evidence + 写 `[x]`；`goal_check(cmd:exit1)` → 拒勾；裸 edit 打 `[x]` → 注入渲染为 `[!]`。
- 真实验收：挂一个真多步任务跑一遍（用生产数据，非构造）。

## 7. 开放点 — 已由 T0 4 厂商收敛（2026-06-20）

面板：kimi-k2.7-code / gpt-5.5 / deepseek-v4-pro / MiniMax-M3，同时对照 codex。

- **Q-a：`goal_check(cmd:)` 真执行 → 定 ①真跑（3:1）。** 加护栏：超时 + 无交互(no-tty) + 证据命令应天然幂等/只读（test/lint/grep/git/build-check）；非幂等的本就不配当证据 → 用 `[~]` 或 `file:`/`git:` 工件替代。
  - 决定性论证（化解 MiniMax 的唯一反对）：`stat(file)`/`git cat` 是"系统读当前真相"，cmd 没有持久工件，它的"当前真相"只能靠**重跑**得到——所以 rerun(cmd) 正是 stat(file) 的同构物，不是破例；信任 AI 贴的**过去** stdout 才是不一致的自证路径（等于信任 AI 粘贴的 `cat` 输出，file: 也会拒）。
- **Q-b：`file:` 粒度 → 定 单职责分层（~4:0）。** `file:<path>` = 存在+非空即可放行，系统记录 mtime/size/内容 sha 作为**可回放元数据**（不作为通过条件）；内容/语义校验一律走 `cmd:grep`。不上 hash 双账本（避免 AI 烧 token 凑 hash 自证）。
- **Q-c：阈值 → 定 ①硬编码命名常量。** 四家都把 Q-c 列为让步点；薄 v1 无"500/30 不对"的实证信号，先集中成命名常量、留好将来提 `goal.ledger.*` 的位置，撞墙再配（避免无信号过早抽象）。

### 7.1 交叉问题结论：证据校验 vs codex 轻量路线 —— **4/4 一致：保留，且是刻意差异点**
codex 的 plan 是 *session 内、临时、TUI-only、无文件审计*，错了下一轮自纠、无沉淀代价；活账本是 *跨 session 的 git SOT*，一个假 `[x]` 写进决策日志就成了未来会话**默认相信的"事实"**——错误被持久化放大而非衰减。砍掉 #2 = 把脆弱性从 session 搬进 git history = **更糟的工程，不是更轻的工程**（退化成"持久化版 update_plan"：既丢 codex 的轻、又丢账本的可审计）。codex 移除 upfront plan 是治"说→停"（模型播报计划后过早停），与"完成判定该不该 AI 自证"不在同一问题域，不可借用——况且我们的热区注入是 past（决策日志）+ 当前状态，不是 future preamble。一句话：**账本是审计痕迹，不是 AI 忏悔录。**

### 7.2 新增的延后项（deepseek 提，归入 v1.1 候选，不进薄 v1）
摩擦风险：校验太烦 → 退化成裸打 `[x]`、`[!]` 满天飞。`[~]` 泄压阀已部分缓解。deepseek 建议"连续 3 个 `[~]` 触发一次 nudge 提醒走 goal_check"——这是窄 nudge，但仍属 §8 延后的 nudge 家族，**先不做**，等真实摩擦数据。

## 8. 明确不做（再次声明，防 scope 蔓延）
漂移对账、自动 re-derive、结构 lint、定期 nudge、多 doc 防串台——等真实长任务撞到失效再按数据加。
