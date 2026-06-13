---
doc_type: migration
status: active
---

# Migration — `.pensieve/` → `~/.abrain/projects/<id>/`

> **状态**：ACTIVE RUNBOOK（2026-05-15）——B4 `/memory migrate --go`、B4.5 strict binding、B5 sediment writer cutover 均已 ship。本文只描述 legacy `.pensieve/` 历史数据迁入 `~/.abrain/projects/<id>/` 的 per-repo 操作；sediment 新写入已经不触碰 `.pensieve/`。
> **依赖**：[ADR 0014](../adr/0014-abrain-as-personal-brain.md) / [ADR 0017](../adr/0017-project-binding-strict-mode.md) / [brain-redesign-spec.md](../brain-redesign-spec.md) / [architecture/abrain.md](../architecture/abrain.md)
> **前置**：[vault-bootstrap.md](vault-bootstrap.md)（vault 基础设施已 ship，P0a-P0c.read）

## 1. 模型：per-repo 一次性迁移

**单用户 14 仓场景**——比起多人多机渐进迁移，per-repo 一次性更适合。每个 `.pensieve/` 仓在用户主动触发时整体搬迁到 abrain，git 是回滚网，不做 backup，不留 symlink。

**重要边界：legacy Pensieve seed 不是项目知识。** 原版 Pensieve（归档于 `~/.pi/archived/pensieve-pre-rewrite/.src/templates/`）会在每个项目初始化时复制 9 个默认 seed：5 个 knowledge/maxim + 4 个 `run-when-*` pipeline。`/memory migrate --go` 都会从项目 `.pensieve/` prune 这些 seed，**但根据 disposition 区分哪些进全局 abrain**：

- `disposition: "extract"` — 5 个 knowledge/maxim（`taste-review-content` 与四个 Linus 品味 maxim）：canonical copy 手工提炼后进 `~/.abrain/knowledge/<slug>.md`；prune 后全局可检索。
- `disposition: "obsolete"` — 4 个 `run-when-*` pipeline：设计与当前 pi-astack 不匹配，**不提炼进全局**。原因：
  - `run-when-committing`：原设计要求主会话手动调 `self-improve.md` 写记忆；现 pi-astack 是 sediment 在 `agent_end` 自动沉淀，AGENTS.md 还明文禁止主会话直接写记忆。
  - `run-when-planning`：“动手前先查”已由 AGENTS.md + `memory_search` 覆盖；seed 里 `grep .pensieve/decisions/` 路径完全过时。
  - `run-when-reviewing-code`：Task Blueprint 合理但 Task 6 “手动沉淀”冲突 auto-sediment；用户需要可触发的 review pipeline 应走 pi prompt template（`~/.pi/agent/prompts/review.md`）而不是 abrain `workflows/`（后者没有主会话 trigger executor）。
  - `run-when-syncing-to-main`：Pensieve 项目本身的 zh→main 翻译流程，跨项目无意义。

`/memory migrate --dry-run` 会为两类 seed 生成不同的 skipped reason；`--go` 仅 prune，不复制任何文件到 `projects/<id>/`。audit row 中 `action: pruned` 的 entry 可用于后期拼接迁移 forensics。

**核心原则**：

| 维度 | 决策 | 理由 |
|---|---|---|
| **粒度** | 单仓一次性（不 per-file，不全局批处理） | 14 仓挨个迁，每仓单一 commit，逆向只看那个 commit |
| **触发** | 用户在仓 cwd 内先 `/abrain bind --project=<id>`，再主动 `/memory migrate --go` | 不预定 migration window，不锁所有仓，按用户节奏；身份决定不由 migrate 负责 |
| **源仓状态** | 父仓 / `.pensieve/` 不要求 clean 或 tracked；工作区当前内容就是迁移输入快照 | 既然要退役 legacy `.pensieve/`，源目录的 git 卫生不该阻止迁移；只保护 abrain 目标侧一致性 |
| **symlink** | 不留 | runtime resolver 在 sediment writer 内部定位新路径；symlink 是另一种 split-brain 风险源 |
| **dual-read 期** | memory facade 长期 dual-read `.pensieve/` + `~/.abrain/projects/<id>/`（已 ship） | 单仓迁完即 forward-only；其他仓未迁仍读旧路径，无需统一切换 |

## 2. precondition（`--go` 强制检查，dry-run 也必须能解析 target project）

B4.5 后，迁移前必须先完成 strict binding：

```text
/abrain bind --project=<id>
# /abrain bind auto-commits bind artifacts on both sides using exact pathspecs:
#   project repo: .abrain-project.json
#   ~/.abrain repo: .gitignore (if changed) + projects/<id>/_project.json
# If auto-commit warns/skips/fails, fix those commits before --go.
/memory migrate --dry-run
/memory migrate --go
```

执行 `/memory migrate --go` 验证：

1. **active project binding 状态为 `bound`** —— 当前仓必须有合法 `.abrain-project.json`，`~/.abrain/projects/<id>/_project.json` 必须存在且匹配，当前 path 必须已登记在 `~/.abrain/.state/projects/local-map.json`。未 bound / path_unconfirmed / registry_missing 均拒绝。`/memory migrate --project=<id>` 被废弃并拒绝。
2. **`.pensieve/` 内有至少 1 个用户 entry­**（排除 `.state/`/`.index/` 下的派生文件）——避免幂等双迁时跟仓中只剩 derived 文件仍提交一个空迁移 commit
3. **`~/.abrain` working tree clean** —— 确保 abrain 一侧 mv 后能干净 commit、出问题能用 preflight 捕获的 `abrainPreSha` 精确 rollback（详 §5；不是 `HEAD~1` —— abrain 有 N+1 commits）

**不再作为 hard precondition**：父仓 git clean、`.pensieve/` tracked。B4 的旧设计把 git 当作源仓唯一 rollback 网；B5 后 `.pensieve/` 是 legacy 输入快照，dirty / ignored / untracked 内容也应该可以迁走。实现上父仓 cleanup commit 只提交本次成功删除的 tracked legacy source 精确 pathspec，不会把 unrelated staged changes（包括 `.pensieve/state.md` 这类 staged support file）带进迁移 commit；ignored/untracked source 只从磁盘删除，不产生 parent commit。

**隐藏 hard-fail（代码 sanity check，不被上述 5 项覆盖）**：preflightMigrationGo 另外还会拒绝以下场景——这些项不可能被用户 bypass，不列为独立 preflight，但调试时需要知道它们存在：

- `pensieveTarget` 路径不存在（用户输错或仓里根本没 `.pensieve/`）
- `pensieveTarget` 不是真实目录（例如 `.pensieve` 是 symlink、普通文件、或传了 repo root `.`）——避免把别的 repo 的记忆经 symlink 迁入当前 project id
- `abrainHome` 路径不存在（`~/.abrain` 从未被 `/vault init` 创建过）
- 父仓 root 不存在（`gitToplevel(parentRepoRoot)` 返回 null，表明 cwd 不在 git 仓内）
- `abrainHome` 是普通目录而非 git repo（`gitIsClean` 不能判定，后续 commit/rollback 会失败）

加上这 4 项，B4.5 后 `/memory migrate --go` 实际运行时总共检查 7 项。spec 上面只列 3 项是因为那三项是「用户可能遇到 + 能够手工修复」的路径，这四项是 sanity guard。

dry-run（`/memory migrate` 默认 / `/memory migrate --dry-run`）也必须先解析到 `bound` active project，否则无法可靠渲染 target_path。它仍不执行 git clean / tracked 等写前 precondition，但不会在未绑定项目上展示猜测出来的目标目录。

## 3. 迁移动作（`/memory migrate --go` 内部步骤）

```
1. 验证 precondition（§2）
2. 读取 .pensieve/ 所有 entry 的 frontmatter
3. 过滤 legacy Pensieve seed：路径 + 原始 seed `id`/`name` 同时匹配时，视为全局 bootstrap seed；不迁入 `projects/<id>`。dry-run 展示 `legacy Pensieve seed; extract to global abrain separately (...)`；`--go` 执行 `git rm` prune，action=`pruned`，计入 `seedPrunedCount` 与 `skippedCount`。
4. frontmatter normalize（实际是 **full rewrite + selective preserve**，不是「仅补缺失 kind」）：
   - **重写的标准字段**（`buildNormalizedFrontmatter`取代原值）：
     `id` / `scope` / `kind` / `status` / `confidence` / `schema_version=1` / `title` / `created` / `updated`
   - **从原 frontmatter 保留的非标准字段**（`preservedFrontmatterLines`）：
     `tags` / `trigger` / `trigger_phrases` / `relations` / `evidence` / 其他用户自定义 key 都原样摇进新 frontmatter。
   - **kind 推断优先级**：`frontmatter.kind` > `frontmatter.type`（legacy alias） > `inferKindFromPath(relSource)`。
     - pipelines/run-when-*.md → kind: pipeline（read-only legacy alias）
     - 其他无 kind → 按目录推断（maxims/ → maxim、decisions/ → decision、staging/ → smell、其余 → fact）
   - **`created` / `updated` 三路信号三角测量**（`resolveCreated` / `resolveUpdated`）：老版行为是“created/updated 缺失时填 migrationTimestamp”，会让所有 entry 看起来“刚刚创建”，LLM time-aware rerank 信号丢失。当前版本从三个信号源 triangulate：
     - `created = min(frontmatter.created, git-author-first(%aI), fs.birthtime)`
     - `updated = max(git-author-last(%aI), frontmatter.updated, fs.mtime-if-untracked-or-dirty-tracked)`
     - 为什么 author-date `%aI` 而不是 committer-date `%cI`：rebase / cherry-pick / amend 会重写 committer-date 但保留 author-date，后者才是“什么时候写下这份改动”的稳定信号。
     - 为什么 `updated` 的 `fs.mtime` 只在 untracked 或 dirty tracked 时参与：`git clone` / `checkout` / `git restore` 会把 clean tracked 文件的 mtime 重置为“拉下来”的时刻，产生虚假的“最近修改”信号；但 B5 后 dirty tracked `.pensieve` 允许迁移，working-tree edit 正是迁移输入，必须让 fs.mtime 参与。
     - 为什么 `created` 取 min 同时参考 fs.birthtime：本地从零开发场景下（先写下文件过几天才 commit）fs.birthtime 是真实创作时间；clone 场景下 fs.birthtime = clone 时刻（晚于 git-author-first），min 自动让 git 胜出。两种工作模式不需特殊处理。
     - `frontmatter.created: 2026-04-30`（纯日期）normalize 为 `2026-04-30T00:00:00 本地时区`，作者声明“那一天创作”被round 到当天 midnight；同日 git author-date `2026-04-30T16:43:21+08:00` 几乎总是晚于该 midnight，min 选 fm。全 ISO 的 frontmatter 原样 parse。
     - **当三个信号都缺失**（无 fm.created、`git log` 返回空、`fs.birthtimeMs == 0`）才 fallback 到 migrationTimestamp。fs.birthtime 在不支持 statx 的 fs 上会是 0/ctime，已 guard。
     - rename 边界：`git log` 未用 `--follow`（为了 batch 性能），rename 后 first-add 是 rename 那次 commit；fs.birthtime 也会在 rename 后重置。两者同时丢失 pre-rename 信号，不补救。
   - **表字段提取隐藏行为**：confidence 缺失时走 `defaultConfidence(kind)`（不同 kind 默认不同）。
   - **损坏 frontmatter 检测**：若 frontmatter 区存在但 `parseFrontmatter` 返回空对象（YAML 语法损坏），normalize 会在报告中加 `frontmatter-unparseable` note——与 `missing frontmatter`（原本就没有 frontmatter）区分，避免静默 fallback 默认值。
   - 数字注：~/.pi Phase 1 历史扫到 178 条候选；其中 5 条是 .index/.state 派生文件被 migrate-go 预过滤掉，实际计入 lint 报告与 apply-checklist 的「173 → 0 pending」是同一批用户 entry。
5. pipeline-型条目路由：
   - **唯一权威信号是 frontmatter `cross_project: true`**（文件名 `run-when-*` 不再做隐式启发——多项目可能撞名，2026-05-12 决策）
   - cross_project: true → ~/.abrain/workflows/（写 `writeAbrainWorkflow({crossProject: true})`）
   - 缺省 → ~/.abrain/projects/<id>/workflows/
   - 调用 writeAbrainWorkflow (B1 已 ship)
6. 其他 7 kind entry 物理跨仓 mv（实现走 atomic write + `git rm`）：
   .pensieve/<kind-dir>/<slug>.md → ~/.abrain/projects/<id>/<kind-dir>/<slug>.md
   - 跨仓 `git mv` 不可行（两个独立 git repo）——实际实现：
     - abrain 一侧 `atomicWrite()`（tmp + rename，防 partial）
     - 父仓一侧 `gitRmOrUnlink()`（先 `git rm`，失败 fallback `fs.unlink`）
   - 父仓 commit pathspec 限定为 `.pensieve`（不扫入并发 sediment auto-commit 的 `.pi-astack/` 改动）
   - **kind → 子目录映射**（与 `extensions/memory/migrate-go.ts` 中 `KNOWLEDGE_KIND_DIR` 严格一致）：
     | kind | 子目录 | 备注 |
     |---|---|---|
     | `maxim` | `maxims/` | 强约束 · 高权重 |
     | `decision` | `decisions/` | ADR-类深思熟虑 |
     | `anti-pattern` `pattern` `fact` `preference` | `knowledge/` | 一般知识合集 |
     | `smell` | `staging/` | 低信心待提纯 |
     | (any) status=archived | `archive/` | 已 supersede / 退役 |
7. 索引重建：
   - `.pensieve/.index/` / `.pensieve/.state/` 派生文件不迁移；root-level `.pensieve/state.md` 属于 legacy support file，`dry-run` 与 `--go` 都标记 skipped 并保留在原仓。
   - legacy Pensieve seed 不写入 project abrain；`--go` 会从项目 `.pensieve/` 删除 seed，前提是这些 seed 已由全局 bootstrap/refine 单独进入 `~/.abrain/knowledge/` / `~/.abrain/workflows/`。
   - `.pensieve/.index/graph.json` / `.pensieve/.state/*` 在原仓内保留为 legacy derived/support artifact，不迁移、不删除
   - `~/.abrain/projects/<id>/.index/graph.json` 重建
   - ~/.abrain/projects/<id>/_index.md 重建
8. 父仓 commit："chore: migrate .pensieve → ~/.abrain/projects/<id>"
   abrain 仓 commit："migrate(in): <projectId> (N entries from <parent-repo>)"
   - 若任一 entry 迁移失败，成功项仍可提交、失败项留在 `.pensieve`，summary 标记为 partial；重跑 `/memory migrate --go` 即可重试失败项。历史上 R7 曾使用 `.pensieve/MIGRATED_TO_ABRAIN` flag 防止已迁仓 sediment 重新写回 `.pensieve/`；**B5 sediment writer cutover（2026-05-13）已移除 flag 与所有相关 reject 路径**，sediment 不再触及 `.pensieve/`，flag 成为 dead code 被删除。
9. sediment runtime resolver 在下一次 agent_end 自动定位到 abrain projects 路径
   （writer 路径不再硬编码 .pensieve，由 resolveBrainPaths 决定）
```

## 4. 14 仓迁移建议顺序

按风险递增、按内容价值递减——先迁低风险/低价值仓验证流程，再迁主仓：

| 优先级 | 仓 | 条目数（截至 2026-05-12） | 建议时机 |
|---|---|---:|---|
| 1 | `~/.config/opencode` | 9 | 验证用：内容少、丢了影响最小 |
| 2 | `~/work/base/cluster` | 15 | 同上 |
| 3 | `~/work/base/sub2api` | 0 (untracked) | 同上；不再需要先 `git add .pensieve && commit`，直接以工作区快照迁移 |
| 4 | `~/work/base/proxies` | 21 | — |
| 5 | `~/work/dev-containers/{base,buildkit}` | 16, 33 | — |
| 6 | `~/work/base/happy` | 13 | — |
| 7 | `~/work/mes/nmh/docs` | 31 | — |
| 8 | `~/work/kihh/full` | 54 | — |
| 9 | `~/work/kenon/blk/full` | 16 | — |
| 10 | `~/.codex` | 42 | — |
| 11 | `~/.claude` | 85 | — |
| 12 | `~/work/uamp/full` | 194 | — |
| **最后** | **`~/.pi`** | **336** | 最主仓最后迁，前 13 仓的经验都已积累 |

表中条目数是早期粗扫值，包含 legacy seed 与 support file；实际 dry-run 的 `migrateCount` 会排除 seed/support，seed-only 仓可能显示 0 个 project migration item；`--go` 仍会 prune seed，但 B5 后不再写 `MIGRATED_TO_ABRAIN` guard。

每仓迁完后跑 `/memory doctor-lite ~/.abrain/projects/<id>/` 验证健康再迁下一个。`doctor-lite` 会识别 `~/.abrain/projects/<id>/` 这类 abrain project target；其 Migration 小节显示为 not applicable，不会把已迁移条目重新当作 legacy `.pensieve` 待迁移项。

## 5. 回滚

### 单仓刚迁完想撤销

`/memory migrate --go` 输出的 summary 末尾会打印 rollback 提示。abrain 侧仍要求 clean，因此可以安全 reset 到 pre-migration SHA；父仓侧由于现在允许 dirty/ignored/untracked，只在迁移开始时父仓 clean 且没有 ignored/untracked source 被迁移时打印 `git reset --hard <parentPreSha>`。若父仓本来就是 dirty，或 `.pensieve/` 被 `.gitignore` 隐藏导致 Git 仍显示 clean，summary 会建议 non-committing revert（或提示没有 parent commit），并提醒：若迁移项含未提交/ignored/untracked 内容，abrain 是完整副本，reset abrain 前必须先手工恢复。例：

```bash
Rollback (if needed):
  cd ~/work/uamp/full && git reset --hard a1b2c3d4...   # only when parent was clean
  cd ~/.abrain && git reset --hard e5f6g7h8...          # abrainPreSha
  # Note: abrain may have multiple commits from this migration (N workflows + 1 migrate-in).
  # The abrain reset above targets the SHA captured before *any* of them landed.
```

父仓 dirty 时可能显示：

```bash
Rollback (if needed):
  # Parent repo was dirty or ignored/untracked sources were migrated; do NOT reset --hard unless unrelated work is saved.
  # If migrated .pensieve entries had uncommitted or ignored/untracked content, abrain is the only full copy; copy them back before resetting abrain.
  cd ~/work/uamp/full && git revert -n <parentCommitSha>  # optional; review before commit
  cd ~/.abrain && git reset --hard e5f6g7h8...
```

**为什么不用 `HEAD~1`**：
- abrain 一侧 N 个 workflow commit + 1 个 migrate(in) commit = **N+1** 个 commit，`HEAD~1` 只能撤 1 个。
- sediment auto-commit 可能在迁移后并发落入任一侧仓，让 `HEAD~N` 指错位置。
- abrain pre-sha 在 preflight 阶段捕获，不会被后续任何 commit 污染。

如果 summary 已丢（终端滚出去），手动找两仓迁移 commit 的父 commit：

```bash
cd <parent> && git log --oneline -5   # 找 "chore: migrate .pensieve" 上一个 commit
cd ~/.abrain && git log --oneline -10 # 找第一个 "workflow:" / "migrate(in):" 的上一个 commit
```

### 多仓迁完后发现规则错（少见）

不要试图反向迁回所有已迁仓——成本超过收益。改成 forward fix：

1. 直接在 abrain 内改 frontmatter / mv 文件到正确位置
2. abrain commit
3. 不动已迁的父仓（`.pensieve` 已经空了，符合预期）

## 6. ADR 0014 状态推进路径

```
B1: workflows lane writer (✅ shipped 2026-05-12)
  → writeAbrainWorkflow API 可用；为 /memory migrate --go 提供 pipeline routing target

B3+B7: per-file migration substrate 剥离 (✅ shipped 2026-05-12)
  → 删除 sediment/migration.ts + /sediment migrate-one + /sediment migration-backups

B4: /memory migrate --go (✅ shipped 2026-05-12)
  → extensions/memory/migrate-go.ts；preflight + frontmatter 归一化 + pipeline 路由
  → smoke 覆盖 happy / dirty-source allowed / legacy frontmatter / .index .state 预过滤 / commits / pre-SHA rollback / 幂等 / collision / mixed batch / post-migration writer-to-abrain 等主路径与审计回归

B4.5: Project Binding Strict Mode (✅ shipped 2026-05-12)
  → /abrain bind --project=<id> 写 .abrain-project.json + projects/<id>/_project.json + .state/projects/local-map.json
  → /memory migrate 不再接受 --project；未 bound / path_unconfirmed / registry_missing 拒绝；target repo 与 cwd 不能错配
  → sediment project writes 与 project vault scope 同用 strict active project 状态

B5: writer cutover (✅ shipped 2026-05-13)
  → sediment 全 6 writer 函数走 `<abrainHome>/projects/<projectId>/`；R7 guard 与所有 `.pensieve/` 写路径删除；只保留 .pensieve 读入口供迁移。
  → B4.5 strict binding + 14 仓完成迁移后拍板。

P0d: vault wizard / mask input / .env import (pending)
  → 与 B5 独立，可并行

Lane G: /about-me + MEMORY-ABOUT-ME (pending)
其他 lane writer: identity / skills / habits (pending；world knowledge writer 已 ship)
```

## 7. 历史注记：废止的 8-phase 渐进方案

本文档 v1（2026-05-09）原为 8-phase 渐进迁移规划：

> P0 准备 → P1 单一入口 → P2 Facade dual-read → P3 hard-coded 清除 → P4 freeze write + smoke → P5 持锁迁移（manifest + epoch + drain assert）→ P6 writer cutover → P7 symlink 兼容期 → P8 清理 fallback

**为何废止**（2026-05-12 用户决策）：

- 8-phase 是为多人多机生产环境设计的（manifest / quiescence protocol / sub-pi 协调），单用户场景过度工程
- 14 仓数据变更不频，user 主动触发 per-repo 迁移即可，不需要 8-phase 全局协调
- backup 子系统与 git 重复（git 已是 canonical undo trail）
- symlink 兼容期是另一种 split-brain 风险源
- per-file migration 在 Phase 1 一次性完成后已剥离，其底座（`extensions/sediment/migration.ts`）2026-05-12 已删除；继续走 per-file 模式只会重新引入死代码

实际已 ship 的渐进步骤（P1 单一入口 resolver + P2 memory Facade dual-read）继续生效，但作为**长期 read-side 能力**（让 14 仓挨个迁的过程中老仓仍可读）而非 8-phase 中"准备 cutover"的临时态。
