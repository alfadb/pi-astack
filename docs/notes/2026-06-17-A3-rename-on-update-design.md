---
status: design-accepted
date: 2026-06-17
task: A3 — rename-on-update（update 允许改 slug，原子重写所有入边引用）
review: T0 design round 1 = PROCEED-WITH-CHANGES; round 2 = accepted after blocker corrections
---

# A3 设计 v2:rename-on-update

## 0. T0 设计评审结论与本版处置

三家不同厂商 T0 设计评审第一轮均给出 **PROCEED-WITH-CHANGES**:方向可以推进,但 v1 设计必须先补数据完整性要求。第二轮 focused 复核:openai **DESIGN-ACCEPTED**;deepseek/kimi 各指出一个恢复细节 blocker。本文已补齐:rollback 按 planned paths 精确恢复(禁止 reset 整仓),rollback 同步处理 VectorIndex stale/reconcile。

已纳入本版的关键修改:

- rename 只用于**同一条目、同一身份**的 slug 纠偏;概念替换/历史方案分叉仍用 `supersede`。
- v1 保持 **project-entry only**;但会重写 project/world 记忆条目文件中指向该 project entry 的限定入边。
- focused rename rewriter,不参数化现有 cross-scope 迁移 rewriter。
- wikilink 必须保留 alias/anchor: `[[old#x|label]] → [[new#x|label]]`。
- 新增 `newSlug` preflight:同 scope collision、全局 active-slug collision(当前 VectorIndex 以 bare slug 为 key)、P 内既有 bare `newSlug` 影子引用等都必须处理。
- inline YAML relation list 不再静默跳过:若 relation key 中存在 flow/inline list 且含 old/new slug,直接拒绝并提示改为 block list 后重试。
- rename + update 内容 patch 必须 **all-or-nothing**;失败时连内容 patch 一起回滚。
- 明确在同一个 abrain-wide sediment lock 内完成 plan/apply/commit;不跨锁写 rules/workflows 等独立区域。
- 增加最小事务标记(transaction marker)与 clean-worktree gate,用于进程中断后的运行时回滚/完成检查。此处不是人工恢复兜底,而是 abrain runtime 的确定性恢复路径。
- 加 `VectorIndex.renameSlug(old,new,expectedScope)`/失效重建路径,避免 rename 后 dense 召回短时间漏掉新 slug。
- 明确 `mergeUpdateMarkdown` 会保留旧 id,rename 必须在 merge 后、写入前覆盖 frontmatter `id`。

## 1. 目标 / 非目标

**目标**:让 `update` 操作可以改 project 条目的 slug（= 随内容演化的可读句柄,不是冻结 ID）。改名必须原子重写所有受支持的入边引用(正文 wikilink + frontmatter relation),不制造断链或错链。

**非目标**:
- 不是 `supersede`:supersede 表示身份分叉(建新条目、归档旧条目、`superseded_by` 指针)。rename 保留同一条目的时间线与身份,只换可读句柄。
- v1 不改 world 条目、不改 rules 条目。
- v1 不直接修改 rules/workflows/habits/identity/skills 等独立写入区域。现测这些区域中 `[[project:...]]` 引用数为 0;若未来存在,post-check 会报告为未处理外部区引用,而非静默承诺已重写。

## 2. 价值 + 与 supersede 的边界

rename 值得做,但必须低频。它解决的是“条目仍是同一个事实/决策/偏好,但 slug 已经明显误导”的问题。收益:

- 引用继续指向活条目,不用经过已归档条目的 `superseded_by` 跳转。
- 时间线连续,不会把一个持续演化的事实拆成多个身份。
- 减少归档噪声进入检索/邻居上下文。

`supersede` 仍是默认手段,适用于:

- 旧概念本身仍有历史意义;
- 新内容代表替代方案、相反结论、不同决策;
- 不确定是否同一身份。

rename 的触发规则见 §12。

## 3. v1 范围

**v1 in**:

- 只支持 `project:P:oldSlug → project:P:newSlug`。
- 重写 memory-entry stores: `~/.abrain/projects/*` 与 `~/.abrain/knowledge` 中的正文 wikilink 与受支持 frontmatter relation。
- 对 world 文件中的限定 `[[project:P:oldSlug]]` / `project:P:oldSlug` 也重写。

**v1 out**:

- world 条目 rename:需要判断每个 project 文件中的 bare `[[S]]` 是否因“本 project 无 S”而解析到 world:S,复杂度高一档。
- rules 条目 rename:rules 有独立 writer、注入模式、生命周期。
- 独立写入区域中的 project 引用重写:rules/workflows/habits/identity/skills 暂不写。若扫描发现这些区域含 `project:P:oldSlug`,v1 报告 `external_zone_reference_unhandled` 并拒绝 rename,避免假装“全量重写”。

## 4. scope-aware 引用解析规则

abrain 有多个 project + world。bare `[[S]]` 按**所在文件 scope 本地优先**解析(project > world)。所以裸 slug 全库替换是错的。

v1 rename project-P 的 `oldSlug → newSlug` 时:

| 引用形式 | P 的 project-entry 文件 | 其它 project Q 的文件 | world 文件 |
|---|---|---|---|
| bare `[[oldSlug]]` / relation `oldSlug` | **改**为 bare `newSlug` | 不改 | 不改 |
| 限定 `[[project:P:oldSlug]]` / relation `project:P:oldSlug` | **改**为 `project:P:newSlug` | **改** | **改** |
| 限定 `project:Q:oldSlug`、`world:oldSlug` | 不改 | 不改 | 不改 |

关键不变式:只重写真正解析到 `project:P:oldSlug` 的引用。bare 引用只在 P 的 project-entry 文件中重写;限定 `project:P:oldSlug` 在 memory-entry stores 全域重写。

### 4.1 wikilink 保形规则

`parseWikilinkTarget` 会为匹配目标剥离 alias/anchor,但 rename rewriter 不能丢这些信息。实现必须基于原始 inner string 做 slug 段替换:

- `[[oldSlug|显示文本]] → [[newSlug|显示文本]]`
- `[[oldSlug#anchor|显示文本]] → [[newSlug#anchor|显示文本]]`
- `[[project:P:oldSlug#anchor|显示文本]] → [[project:P:newSlug#anchor|显示文本]]`

只替换 slug 段,保留 `#anchor` 与 `|alias`。若原引用写成 `oldSlug.md` 或 `path/to/oldSlug.md`,匹配时按 normalize 识别,输出规范化为 `newSlug`(后缀/路径不保留),但 alias/anchor 仍保留。

### 4.2 frontmatter relation 规则

支持形式:

```yaml
derives_from:
  - oldSlug
  - project:P:oldSlug
relates_to: oldSlug
```

不支持且必须拒绝的形式:

```yaml
relates_to: [oldSlug, other]
```

若受支持 relation key 中出现 inline/flow list 且包含 oldSlug/newSlug 相关值,返回 `unsupported_inline_relation`,不静默跳过。

### 4.3 文件 scope 判定

v1 通过 store 路径判定文件 scope(projects/<id> 或 knowledge)。如果 frontmatter `scope` 与路径矛盾(例如 projects/P 下写 `scope: world`),rename preflight 拒绝,因为 bare 引用解析无法可靠判断。

## 5. newSlug preflight

rename 前必须在同一个锁内完成以下检查:

1. `oldSlug` 文件存在且 status 不是 `archived`/`superseded`。
2. `newSlug` slugify 后非空、与 oldSlug 不同。
3. P 中已存在 `newSlug` → 拒绝 `rename_collision`。
4. **全 active corpus 中已存在 `newSlug` → v1 拒绝**。语义上 project slug 可同名,但当前 `VectorIndex` 以 bare slug 为 key;v1 不主动制造新的跨 scope 同名,直到向量索引升级为 scope-qualified key。已有历史同名不在本次修复范围。
5. P 内既有 bare `[[newSlug]]` 或 relation `newSlug` 必须处理:如果它当前解析到 world:newSlug,则自动改为 `world:newSlug`;若它当前是断链,默认拒绝 `preexisting_newslug_bare_ref`,避免 rename 后意外吸附到新条目。
6. relation inline/flow list 若含 old/new slug → 拒绝(§4.2)。
7. 独立区域(rules/workflows/habits/identity/skills)若含 `project:P:oldSlug` → 拒绝并报告,不跨锁写。
8. git working tree 必须干净(至少本次计划涉及的 abrain repo 干净);否则拒绝,避免回滚覆盖无关修改。

## 6. 模块 / API

新模块(设计):

```ts
// extensions/memory/rename-entry.ts
export type RenameTarget = {
  scope: "project";
  projectId: string;
  oldSlug: string;
  newSlug: string;
};

export type RenamePlan = {
  target: RenameTarget;
  baseHead: string;
  entryOldPath: string;
  entryNewPath: string;
  fileChanges: Array<{ path: string; oldContentHash: string; newContent: string; changes: RenameChange[] }>;
  vectorIndexAction: "rename" | "invalidate" | "none";
  warnings: string[];
};

export async function planRename(target, env): Promise<RenamePlan>;
export async function applyRename(plan, env): Promise<RenameApplyResult>;
```

Mapper 为纯函数:输入 raw wikilink inner/relation value + 文件 scope + target,输出 replacement 或 null。它不调用 LLM。

复用 `rewrite-cross-scope.ts` 的叶子原语:代码区间检测、wikilink target parser、frontmatter split、relation key 集合、markdown 文件遍历/atomicWrite/git root helpers。**不参数化**现有 cross-scope 决策逻辑,因为 cross-scope 的输出是“bare → 加 scope 前缀”,rename 的输出是“原形保留,替换 slug 段”。

## 7. 写入路径 / op 接线

- `ProjectEntryUpdateDraft` 加 `newSlug?: string`。
- `update` decision 的 `newSlug` 放在 `patch.newSlug`。
- `updateProjectEntry` 在现有 abrain-wide sediment lock 内执行普通内容 merge 与 rename 规划。锁为 `<abrainHome>/.state/sediment/locks/sediment.lock`,覆盖所有 project/world memory-entry 写入;rename 不释放/重取锁。
- 若 `patch.newSlug` 为空或等于旧 slug,走现有 update。
- 若需要 rename:内容 patch + rename 是一个事务。任何 preflight/apply/commit 失败,整个 update 拒绝,内容 patch 不单独落地。
- `mergeUpdateMarkdown` 会保留旧 `frontmatter.id`;rename 必须在 merge 后、写 entry 新内容前显式覆盖 `id: project:P:newSlug`(以及必要的 slug/frontmatter 字段),并追加 `renamed` timeline 事件。

## 8. 原子性 / 恢复策略

### 8.1 基本原则

- 先在内存中 build plan,再 apply。
- 单次 git commit 是持久边界。
- rename 失败必须 all-or-nothing;不允许“内容更新成功但改名失败”的部分成功。
- 使用 git 作为确定性回滚机制,但不依赖人类手动恢复。

### 8.2 clean-worktree gate

apply 前要求相关 repo working tree/index 干净。若不干净,拒绝 `dirty_worktree`。

### 8.3 最小事务标记

apply 前写 `.state/sediment/rename-transaction.json`,内容包括 `baseHead`、old/new path、所有 planned file paths、content hashes、startedAt。它是 runtime 恢复输入,不是给人手动编辑的记录。

下次 sediment 获取同一全局锁时若发现该标记:

- **完成检查**:只有当 old path 不存在、new path 存在、new path frontmatter `id` 已是 `project:P:newSlug`、post-check 通过,才判定上次 rename 已完成并删除标记。`HEAD != baseHead` 只能说明期间发生过提交,不能单独证明 rename 成功。
- **rollback**:禁止 `git reset --hard baseHead` 这类整仓回退,因为 marker 之后可能已有其它正常提交。只能按 planned paths 精确恢复:对计划内既有文件执行 `git restore --source <baseHead> --staged --worktree -- <planned paths>`(或等价 per-file checkout),清理未提交的 new path,恢复/失效 VectorIndex(见 §9),删除标记,审计 `rename_transaction_rolled_back`,然后拒绝当前自动写入一次。
- **marker-only 崩溃**:若 marker 写入后、apply 第一步前进程退出,rollback 是 no-op(文件状态已等于 baseHead),仍删除 marker 并审计一次。

此处接受一个最小事务标记,因为 abrain 记忆条目不应依赖人类手动编辑/恢复;这是 runtime 可达的确定性恢复,不是额外的人工兜底。

### 8.4 apply 顺序

为减少持久半态中的断链窗口,采用“先创建新条目副本,最后删除旧条目”的顺序:

1. 写 entry 新路径内容(`newSlug.md`,已更新 id/timeline),旧路径暂留。
2. 重写所有入边引用。
3. 在仍持有 sediment 全局锁时更新向量索引(§9)或标记失效。
4. `git rm` old path(或等价删除旧文件并 `git add -A`;git 会按相似度识别 rename)。
5. `git add -A` planned paths + 单次 commit。
6. post-check:oldSlug 受支持引用归零、new path 存在、old path 不存在、entry id 正确。
7. 删除 transaction marker。

如果进程在 1-4 中断,最坏是短期重复条目或部分引用,不会出现大量引用指向不存在文件;下次 runtime rollback 消除半态。若中断发生在步骤 3 之后,rollback 必须同步恢复或失效 VectorIndex,避免搜索索引指向已回滚的 newSlug。

## 9. 向量索引与搜索一致性

当前 `VectorIndex` 以 bare slug 为 key,scope 只是记录字段。rename 后若不处理索引,stage0 dense 召回会短时间缺少 newSlug 或保留 oldSlug。

v1 要求:

- 新增 `VectorIndex.renameSlug(oldSlug, newSlug, expectedScope)`。
- 该调用必须发生在 sediment 全局锁仍持有期间。
- 若 oldSlug 记录存在且 `rec.scope === expectedScope` 且 newSlug key 不存在,直接移动向量记录并持久化。
- 否则不覆盖其它 scope 的记录;标记 old/new 为 stale,由下一次 reconcile 重建。由于 v1 preflight 拒绝全 active corpus 的 newSlug collision,正常路径应能直接移动。
- rollback 时若已经执行过 index rename,必须恢复旧索引记录或至少将 oldSlug/newSlug 都标记为 stale 并触发 reconcile;不能只回滚 git 文件而留下 newSlug 向量记录。

## 10. collision / 身份 / timeline

- 同 scope collision 拒绝。
- v1 全 active corpus newSlug collision 拒绝(§5.4)。这是当前索引实现限制,不是长期语义规则。
- rename 保留 `created` 与既有 timeline,追加 `renamed` 事件(`oldSlug → newSlug`)。
- id 从 `project:P:oldSlug` 变为 `project:P:newSlug`。
- staged 候选中若引用 oldSlug,replay 时可能出现 neighbor vanished;已有审计处理。v1 不重写 staging/audit 历史。

## 11. 验证 / post-check

apply 后必须在提交前做 post-check:

- 受支持 memory-entry stores 中不存在指向 `project:P:oldSlug` 的非代码区 wikilink/relation。
- P 的 project-entry 文件中不存在 bare `oldSlug` relation/wikilink。
- entry new path 存在,old path 不存在,id 正确,timeline 有 renamed 事件。
- 若独立区域存在未处理 oldSlug 限定引用,rename 失败并回滚(不把它们留成 broken link)。
- `VectorIndex` 对 newSlug 有 fresh 记录或已明确登记需要 reconcile。

## 12. curator 触发策略

prompt/决策规则:

> Rename is exceptional. Only set `newSlug` when the entry is clearly the same durable fact/decision/preference, but the current slug would materially mislead future retrieval or cause a reader to infer the wrong topic or outcome. Do not rename for cosmetic title polish, minor wording changes, normal scope broadening, or because a nicer slug exists. If the old concept remains historically meaningful, use `supersede`. If uncertain, do not rename.

硬条件:

- 不 rename `archived`/`superseded` 条目。
- 条目创建未满 7 天默认不 rename(避免新条目命名频繁变化),除非是明显 typo/项目名错误。
- 入边数 >20 时默认不 rename,除非 slug 与内容明显相反或会造成严重检索误导。
- 若 old slug 的关键词仍是正文中的核心概念,不 rename。

正例:

- old slug 表示被拒绝方案,条目已演化为通用/采纳决策;
- old slug 有 typo、错误项目名、错误技术名;
- old slug 过窄导致未来检索会找不到该条目。

## 13. 测试计划

纯函数:

- §4 表逐格:bare in P/Q/world、qualified project:P/Q/world、自引用、qualified ref in P 自己文件。
- alias/anchor: `[[old|label]]`、`[[old#x|label]]`、`[[project:P:old#x|label]]`。
- 代码区跳过。
- normalize: `old.md`、`path/to/old.md`。
- preflight:newSlug collision、全 active corpus collision、P 内 preexisting bare newSlug、inline YAML relation 拒绝、scope/frontmatter 矛盾拒绝。

集成(临时 abrain,非 live):

- project-P rename old→new:文件新建/旧删,id/timeline 正确。
- P 内 bare old 改;Q 内 bare old 不改;world 内 bare old 不改;全域 qualified `project:P:old` 改。
- frontmatter scalar/block-list relation 同步改;inline list 拒绝。
- world 文件中 qualified project ref 改。
- 独立区域若含 project:P:old 限定引用 → 拒绝并回滚。
- crash 模拟:在 apply 步骤 1/2/4 注入失败,确认 transaction rollback 后 worktree 干净、old entry 保持、new path 不留。
- VectorIndex renameSlug 成功/冲突/缺失三路。
- 每条关键断言做一次“故意打破→失败→还原”,确认真跑。

回归:

- `smoke:memory`
- `smoke:rewrite-cross-scope`
- `smoke:dispatch`

## 14. 实施顺序建议

1. 只实现纯 mapper + preflight + smoke,不接 writer。
2. 实现 transaction marker + apply/rollback + crash 注入 smoke。
3. 实现 writer 接线(`newSlug`)与 VectorIndex rename。
4. 跑回归 + 提交 T0 代码评审。

每一步独立提交,失败则回退,不把半成品接入 live sediment。
