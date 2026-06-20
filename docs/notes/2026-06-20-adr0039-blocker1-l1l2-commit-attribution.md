# ADR0039 Phase B-prep blocker①：L1/L2 commit 归属（2026-06-20）

> 二轮共识列出的 Knowledge 反转 4 个硬前置 blocker 之首。本批落地 + 生产验证。

## 问题（live）

B3 把 `l2OutputRoot=repo` flip 到生产后，每次 agent_end 写知识都会产生派生态：
- L1 Evidence Event 写到 `l1/events/...`（l1/ B3 起已入 git 跟踪）。
- L2 投影写到 `l2/views/knowledge/...`（repo 模式）。

但 sediment writer 的提交函数 `gitCommitManyUnlocked` / `gitCommitAbrainUnlocked`
只 `git add` 具体 canonical 文件，**不提交 l1/l2**。结果：
- 每次写后 l1/l2 留未提交 delta → git-sync auto-merge preflight 遇 dirty tree 拒绝。
- B4 pre-push dirty-view 阻断永久拦截 brain-repo push。

生产实证（修复前）：brain tree 有 3 个未提交 L1 事件 + 1 个未提交 canonical 删除
（sediment 自身 supersede/dedup 一个 decision，`legacy_parallel_write.git_commit=null`
证实旧代码漏提交）。

## 修复

`gitCommitManyUnlocked` / `gitCommitAbrainUnlocked`：`git add` canonical 时一并
`git add -A -- l1 l2`（仅当目录存在）。l1/ append-only 内容寻址、l2/ 由 reconcile
字节重投影校验，同提交安全；`.state/` 仍 gitignore。写事务变为 canonical + L1 + L2 原子。

## 验证

- **代码（真实路径）**：`smoke-memory-sediment` 加真实 `writeProjectEntry`
  (gitCommit=true, knowledgeEvidenceEventWriter=event_first, l2OutputRoot=repo,
  projectionMode=topo) 块：写后 `git status --porcelain` 干净，HEAD 提交含
  `l1/events/`、`l2/views/knowledge/`、canonical `.md`。`npm run smoke:memory` PASS。
- **生产数据**：reproject（repo+topo, 2766 identities, 2765 projected, 1 removed,
  0 failed）同步 l2/；catch-up 提交 3 个 L1 事件 + canonical 删除 + 1 个新 l2 world
  文件 + manifest（brain `932b5f5c..d6c2fe82`）。reconcile + prepush 双双 PASS
  （l1=2770, coverage=1.0, projected=2765, corpus=2765, dirty-view 不再拦截）。

## 关键运行时发现（影响 rollout）

运行中的 pi 进程 / sediment sidecar 持**启动时的旧代码 + 旧设置快照**：
- 旧代码：writer 不 sweep l1/l2 → 本次修复要 **pi 重启** 才在运行时生效。
- 旧设置：sidecar 缓存 `l2OutputRoot=state`（B3 flip 之前的值）→ B3 后新条目投影
  进了 `.state/sediment/knowledge-projection/`（gitignored）而非 l2/。本批 reproject
  已把 l2/ 与全部 2770 个 L1 事件对齐；但**重启前**新写仍会：(a) 留未提交 l1/ 事件
  （旧代码不 sweep）、(b) 投影进 .state 使 l2/ 再度滞后。

→ 必须 **pi 重启** 才能同时激活：(1) writer 的 l1/l2 原子 sweep、(2) sidecar 读取
`l2OutputRoot=repo`。重启前每次 agent_end 仍可能留少量未提交 l1/ + l2/ 滞后，需手动
reproject + catch-up 提交（如本批）才能 push。这是「live sediment 写」归属的剩余项，
应在 B5 反转前与 sidecar commit/lease 一并定稿。

## 提交

- inner `5045df4`（writer sweep + smoke 验证块）
- brain `d6c2fe82`（生产 catch-up + l2 reproject 对齐）
- outer `fac4a5c`（指针；`agent/settings.json` 排除）
