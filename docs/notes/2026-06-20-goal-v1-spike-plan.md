# 目标（不变量）: 打通 goal-v1 活账本的端到端闭环并自举验证
# Updated: turn 1    active: spike-built-pending-reload

> 这是 spike 的 dogfood 账本（Q5 决定：用「实现 v1 自身」当 plan.md，自举）。
> 形态遵循 complete-design §0.2 决议：criterion 带显式 `(id)`；证据 spike 期只用 `cmd:`；
> `[x]` 由 AI 用 edit 写=声明，只有 `goal_check(id, cmd:…)` 记下匹配且未漂移的证据才算 verified，否则渲染 `[!]`；
> criterion 文本或输入 file 漂移 → `stale`（G6）。
> 状态说明：以下 `[x]` 的 cmd 证据已用 `node scripts/...` 直接真跑通过；live `goal_check` 记录证据 +
> 真实会话 dogfood 须 `/reload` 后进行（本会话启动时旧 goal 扩展已加载，新 goal_check 工具尚未热载）。

## 验收标准（[ ]未做 / [~]已做未独立验证 / [x]已写声明，verified 由证据账判）
- [x] (ev) `pi-goal-evidence` 事件 append + 新写 `replayGoalEvidenceEvents` 按 criterion_id fold（含失败，当前态=最近成功且仍有效，G1） — 证据: cmd:`npm run smoke:goal-evidence`
- [x] (parser) plan.md parser 抽 `[ ]/[x]/[~]` 行 + `(id)` 标记，作为 criteria SOT（G5①）；缺 id 报错+建议 — 证据: cmd:`npm run smoke:goal-evidence`
- [x] (xcheck) 注入热区交叉核验：`[x]` 有匹配未漂移证据→verified；无证据→`[!]`；文本/输入漂移→stale（G2+G6） — 证据: cmd:`npm run smoke:goal-ledger`
- [x] (exec) `goal_check(cmd:)` child_process spawn 真跑（cwd+超时+no-tty+捕 exit/输出 sha+输出封顶，G3） — 证据: cmd:`npm run smoke:goal-exec`
- [x] (gate) goal_check 加 `isCurrentTurnGoalContinuation` gate（machine/continuation turn 禁 check）+ sub-agent 经 readSessionId fail-closed（G4） — 证据: file:./extensions/goal/index.ts
- [x] (hotzone) 热区注入显示 `claimed N | verified M` + 当前状态 + 最近决策，≤500 token，每轮从 plan.md 重解析 — 证据: cmd:`npm run smoke:goal-ledger`
- [ ] (dogfood) 在一个真实多步任务上 dogfood 跑通，且**真触发** ≥1 次 `stale` + ≥1 次 `[!]`（真实生产数据，非构造，Q4）；smoke-goal-e2e 已用真 spawn+真 fs 漂移触发 stale/[!]，剩「活会话内 goal_check loop」待 /reload — 证据: cmd:`npm run smoke:goal-e2e`

## 当前状态（整块替换，禁止局部改）
- 方案: 三文件落地 evidence.ts(G1/G5/G6 纯逻辑) + exec.ts(G3 真跑) + index.ts 接 goal_check 工具(G4 gate) 与 doc 型注入热区(G2)；git 证据 + 当前状态/决策注入已补齐
- 下一步: `/reload` 后用真实多步任务 dogfood，跑 live goal_check 记录证据，确认 [x]→verified、真触发 stale/[!]
- 阻塞/风险: 本会话无法热载新工具，dogfood 须下个会话；G2「扩展不写 doc」+ parser 渲染手感是承重墙，dogfood 重点观察 [!]/stale 噪声

## 决策日志（append-only）
- T0 spike 启动：Q1=②垂直切片；Q2=①先验 claim-vs-verified 闭环；Q3=③边写边收敛(先清草案残留)；Q4=③真任务+smoke 都要；Q5 收口=cmd-only/parser最小/criterion_id 取自 plan.md (id)/dogfood 自举
- T1 spike 落地：evidence.ts/exec.ts/index.ts 三件 + 7 个 smoke 全绿(57 checks)；G1-G6 全部成形；超出 spike 最小集额外补了 file:/git: 证据 + 当前状态/决策日志注入(向「完整 v1」收口)；LSP 零诊断
