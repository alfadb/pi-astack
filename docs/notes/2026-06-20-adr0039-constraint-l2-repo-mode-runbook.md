# ADR0039 Constraint L2 repo-mode enable — preflight + runbook（v3，2026-06-20）

> Constraint L2 迁移机制已 ship（`0cf801a`/`22a868b`/`9856dc2`/`2f14202`/`6b09369`）。
> 本翻转流程经 **4×T0 一致复审（3 轮，4/4 SIGN v3）**——见
> [`2026-06-20-adr0039-constraint-l2-repo-mode-preflight-consensus.md`](./2026-06-20-adr0039-constraint-l2-repo-mode-preflight-consensus.md)。
> 工具已实现：`smoke:constraint-l2-repo-preflight`（翻前，真实数据已 PASS）+
> `verify:constraint-l2-flip`（翻后）+ reconcile stale-L2 扫描 + `SC_L2_WRITE_FAILED` 诊断。
> 本文 supersede 早期主会话独写版（其 gate-scope 判断未经复审；4×T0 确认核心但补全了 preflight）。

## flip 定性（4/4 CONFIRM）

**additive / 低不可逆风险**，不是 P4-b 那种读路径行为 flip：

- repo-mode（`shadow-runner.ts:351`，additive best-effort try/catch）把 validated decision
  固化为不可变 L1 `constraint-projection-envelope/v1` 事件 + 渲染确定性 L2 到 git 跟踪的
  `~/.abrain/l2/views/constraint/`；`.state` bundle 仍无条件先写。
- **runtime 注入不变**：`rule-injector/index.ts:505` 无条件读 `.state` 的 `compiled-view.md`。
  翻 repo-mode 不改变注入什么。
- gate = 重启 + 翻后 reconcile，**不需要多周行为 soak**（无行为面可 soak）。
- 残余真风险（4×T0 补出，已用 preflight 闸住，非 soak 能查）：固化幂等键是 LLM 输出
  `decision_hash` 而非 `inputRootHash`（churn）；swallow 掉 `l2_write_failed` 留 stale L2。

## 翻前 preflight（主会话可跑，全只读 / 临时快照）

1. **【强制】真实数据流水线**：`npm run smoke:constraint-l2-repo-preflight`。它快照真实
   `~/.abrain` 的缓存 decision（**无 LLM**），直接固化→渲染→reconcile→幂等→inert→NS-2→
   git-delta，证 repo-mode 在你的真实语料上全绿。**红则不翻。**（无真实 decision 时 SKIP。）
2. 确定性 + 单元：`npm run smoke:constraint-shadow-compiler`（含 repo-mode 固化 + stale-L2 比较器 + 真实重投影）。
3. reconcile 干净：`npm run smoke:adr0039-reconcile`（含新 constraint stale-L2 扫描）。
4. **【硬前置】`~/.abrain` git 干净**：`git -C ~/.abrain status --porcelain` 必须为空
   （翻后归因才干净；非「应该」是「必须」）。

任一红 → 不翻。

## 翻 repo-mode（需用户操作）

1. 编辑 `/home/worker/.pi/agent/pi-astack-settings.json`，**插入**（当前 `constraintShadowCompiler`
   块**无** `l2OutputRoot` 键 → 默认 `state`；line-233 的 `repo` 是 `knowledgeProjector` 的，别混）：
   ```jsonc
   "constraintShadowCompiler": {
     "enabled": true,
     "l2OutputRoot": "repo",   // ← 插入这一行
     ...
   }
   ```
   schema 已允许（`pi-astack-settings.schema.json:315`）。
2. **重启 pi**（settings 在 boot 读；不重启不生效）。
3. 触发一次 constraint compile（正常 `agent_end` 自动刷新，或显式 refresh）。
4. **force commit sweep**（kimi）：constraint compiler 自己不 commit，搭下次 knowledge sediment
   commit 的车（`writer.ts:1058` blanket-stage `["l1","l2"]`）。翻后立即跑
   `git -C ~/.abrain add l1 l2 && git -C ~/.abrain commit -m "constraint L2 repo-mode 首翻"`，
   把 piggyback drain 掉，verify 才不与 auto-refresh 抢。

## 翻后验收（一条命令，别眼看 git）

`npm run verify:constraint-l2-flip` —— 单 exit code，做：(1) constraint L2 view 存在；
(2) 全量 reconcile 绿（含 stale-L2 扫描，捕 swallow 掉的 `l2_write_failed`）；(3) git 归因：
脏路径只能在 `l1/`/`l2/`（sediment 管），否则红。绿 = 翻转干净可提交。

补充观测：若固化/L2 写失败，runtime 现会发 `SC_L2_WRITE_FAILED` 诊断（bundle-b，进 diagnostics 流）。

## 回滚

- 设回 `l2OutputRoot: "state"` + 重启 → 停止写 L2（`.state` 注入不受影响）。
- **可逆性：behaviorally inert，NOT history-erasable。** 已固化的 L1 projection 事件
  content-addressed / 幂等 / 被 event-scan NS-2 foreign-skip，留着行为上无害；但它们已进
  `~/.abrain` git **历史**，`git rm` 只清工作树不清历史。别宣称「完全可逆」。
- 已入库 L2 view 如不想要：`git -C ~/.abrain rm -r l2/views/constraint/` 并 commit。

## NS-2 双向耦合（rollback 安全的前提，opus）

留下固化事件安全，**当且仅当** `constraint-projection-envelope/v1` **同时**：(i) 留在
constraint-evidence ingest 之外（event-scan 只 admit `constraint-evidence-envelope/v1`）**且**
(ii) 留在 `FOREIGN_SKIP_ENVELOPE_SCHEMAS` 白名单内（`event-scan.ts:57-59`）。**从 skip 集移除是
更可能的回归**：会 fall-through 全解析 → 标 invalid → `coverageRatio` 塌缩 → 注入在
`minCoverageRatio` 静默关闭。改 event-scan schema 集时必须守住这条。

## 为什么不在主会话强翻

settings boot 读 → 必须用户重启 pi；主会话改 settings 本进程不生效，且翻后验收依赖真实重启后的
compile 产物。故主会话只交付 preflight + 工具 + runbook，flip 由用户执行。
