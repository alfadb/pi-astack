# 目标（不变量）: 打通 goal-v1 活账本的端到端闭环并自举验证
# Updated: turn 2    active: dogfood-live-passed

> 这是 spike 的 dogfood 账本（Q5 决定：用「实现 v1 自身」当 plan.md，自举）。
> 形态遵循 complete-design §0.2 决议：criterion 带显式 `(id)`；证据 spike 期只用 `cmd:`；
> `[x]` 由 AI 用 edit 写=声明，只有 `goal_check(id, cmd:…)` 记下匹配且未漂移的证据才算 verified，否则渲染 `[!]`；
> criterion 文本或输入 file 漂移 → `stale`（G6）。
> 状态（已完成，turn 2 /reload 后）：7 条 criteria 均经 live `goal_check` 真跑证据、全 verified；已在本会话
> 真触发过 stale（criterion 文案漂移）与 [!]（无证据声明）并复原。证据事件落在会话 jsonl，为热区注入的 SOT。

## 验收标准（[ ]未做 / [~]已做未独立验证 / [x]已写声明，verified 由证据账判）
- [x] (ev) `pi-goal-evidence` 事件 append + 新写 `replayGoalEvidenceEvents` 按 criterion_id fold（含失败，当前态=最近成功且仍有效，G1） — 证据: cmd:`npm run smoke:goal-evidence`
- [x] (parser) plan.md parser 抽 `[ ]/[x]/[~]` 行 + `(id)` 标记，作为 criteria SOT（G5①）；缺 id 报错+建议 — 证据: cmd:`npm run smoke:goal-evidence`
- [x] (xcheck) 注入热区交叉核验：`[x]` 有匹配未漂移证据→verified；无证据→`[!]`；文本/输入漂移→stale（G2+G6） — 证据: cmd:`npm run smoke:goal-ledger`
- [x] (exec) `goal_check(cmd:)` child_process spawn 真跑（cwd+超时+no-tty+捕 exit/输出 sha+输出封顶，G3） — 证据: cmd:`npm run smoke:goal-exec`
- [x] (gate) goal_check 加 `isCurrentTurnGoalContinuation` gate（machine/continuation turn 禁 check）+ sub-agent 经 readSessionId fail-closed（G4） — 证据: file:./extensions/goal/index.ts
- [x] (hotzone) 热区注入显示 `claimed N | verified M` + 当前状态 + 最近决策，≤500 token，每轮从 plan.md 重解析 — 证据: cmd:`npm run smoke:goal-ledger`
- [x] (dogfood) 在一个真实多步任务上 dogfood 跑通，且**真触发** ≥1 次 `stale` + ≥1 次 `[!]`（真实生产数据，非构造，Q4）；smoke-goal-e2e 已用真 spawn+真 fs 漂移触发 stale/[!]，剩「活会话内 goal_check loop」待 /reload — 证据: cmd:`npm run smoke:goal-e2e`

## 当前状态（整块替换，禁止局部改）
- 方案: 三文件 evidence.ts/exec.ts/index.ts + state.ts 已落地并 /reload 生效；7 criteria 全部经 live goal_check 记证据
- 下一步: v1 收口完成；后续 v2 候选（git 证据更多形态、热区 token 预算调优、多目标）按需再开
- 阻塞/风险: 无。承重墙（G2 扩展不写 doc + parser 渲染手感）已在真实会话验证，[!]/stale 噪声可控、语义清晰

## 决策日志（append-only）
- T0 spike 启动：Q1=②垂直切片；Q2=①先验 claim-vs-verified 闭环；Q3=③边写边收敛(先清草案残留)；Q4=③真任务+smoke 都要；Q5 收口=cmd-only/parser最小/criterion_id 取自 plan.md (id)/dogfood 自举
- T1 spike 落地：evidence.ts/exec.ts/index.ts 三件 + 7 个 smoke 全绿(57 checks)；G1-G6 全部成形；超出 spike 最小集额外补了 file:/git: 证据 + 当前状态/决策日志注入(向「完整 v1」收口)；LSP 零诊断
- T2 live dogfood(/reload 后)：在本 spike plan.md 上跑通整条 goal_check 闭环——7 criteria 全 verified；真触发 stale(ev 改文案漂移)与 [!](demo 无证据声明)，后撤销演示改动恢复全 verified；证据事件落在会话 jsonl，复算热区=下轮注入内容（真实生产数据，非构造，Q4 达成）
