# ADR 0018 — Sediment Curator Defense Layers（沉积器 curator 三层防御）

> 🗄️ **ARCHIVE-CLASS · 机制存档 / PENDING-INGEST（Phase-2，3×T0 mark-in-place）**：本 ADR 是 **AI-Native 原则的经验证据链**（commit 521405b/2e8924d 两次数据丢失 + 机械门控撤回），被 0016/0021/0022/0023/0024 引用；删除=重新引入已修 bug 的风险。机制正文原地保留可读、物理归档延后至 abrain ingest lane 落地，**勿移勿删**。

- **状态**：Accepted（2026-05-13），**已实施后部分 revert**。Layer 1（curator prompt 约束）与 Layer 2 trigger_phrases UNION 保留；Layer 2 的 body_shrink / body_section_loss 机械门控于 `ee1c809` 按设计移除（信任 LLM 自进化哲学，见 world maxim `prefer-prompt-engineering-over-mechanical-guards`）；Layer 3 对应 smoke fixtures 同步移除。实施时间线：`07e4a3e`（三层落地）→ `3c604c8`（清理）→ `ee1c809`（revert 机械门控）。
- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md) §"B5 sediment writer cutover"、[ADR 0016](0016-sediment-as-llm-curator.md) §"curator workflow"、[ADR 0017](0017-project-binding-strict-mode.md) §"sediment strict write guard"。
- **触发**：B5 sediment writer cutover（2026-05-13）让 sediment auto-write 落 abrain 后，48 小时内出现 2 次 curator data-loss P0：abrain commits `521405b`（trigger_phrases 5 个被替换为不相关 4 个，丢失检索锚点）+ `2e8924d`（45 行 entry 被压成 27 行，4 evidence + 3 fix + principle 三个 load-bearing sections 整段消失，原本应该 CREATE with derives_from 的 downstream observation 被当成 UPDATE）。

## 决策摘要

sediment curator（ADR 0016）的"update over create"原则在 LLM-driven 实践中表现出**过度激进**倾向：任何 topic 相关的 candidate 都被解释为 update 现有 entry，且 update 时的 compiled_truth "new current best truth, not append-only delta" 指令被解释为**整体覆盖**而非**整合 delta**。

针对此问题落地**三层互补防御**（后经哲学反思，部分调整）：

1. **Layer 1（curator prompt 上游约束）** ✅ 保留：更严格区分 update vs create 的语义边界；明确 update 是 INTEGRATE delta，不是 REPLACE；trigger_phrases UNION 而非 REPLACE。
2. **Layer 2（writer 层兜底）**：
   - ~~`body_shrink`~~ / ~~`body_section_loss`~~ **已于 `ee1c809` 移除**。决策理由：silent reject 创建不可修复的死条目（curator 反复尝试同一操作 → 反复被拒 → 无人通知 → entry 永久腐烂），违反 sediment 自我进化哲学（信任 LLM curator 自纠错，偶然的知识降级可被后续迭代修复）。详见 world maxim `prefer-prompt-engineering-over-mechanical-guards`。
   - trigger_phrases auto-UNION ✅ 保留（非 reject gate，为数据 enrichment；writer 强制 case-insensitive dedup，现有 casing 优先）。
3. **Layer 3（smoke regression lock）**：body_shrink / body_section_loss 的 4 个 smoke fixtures 于 `ee1c809` 同步移除；trigger_phrases UNION 的 smoke fixtures 保留。

当前防线总结：**prompt 是主防线（update-vs-create discipline + body-preservation contract）、trigger_phrases UNION 是数据 enrichment 兜底。自进化哲学下，偶然的知识降级可被后续迭代自我修复——不设机械 blocking，仅保留安全边界（sanitizer）。**

## 背景与问题

### 实证 1：trigger_phrases 全替换（commit 521405b）

被 update 的 entry：`sediment-architecture-shift-from-gate-heavy-extractor-to-llm-curator`。

trigger_phrases 字段从：

```yaml
trigger_phrases:
  - "bidirectional gate"
  - "input gate"
  - "output gate"
  - "sanitizer must be"
  - "sanitizer bidirectional"
  - "gate heavy extractor"
```

被替换为：

```yaml
trigger_phrases:
  - "clean window"
  - "auto_write lane"
  - "end-to-end verification"
  - "pi-global sediment"
```

旧 phrases 含 "bidirectional gate" / "input gate" 等概念，是 entry 的核心检索锚点；丢了之后用户 `memory_search "bidirectional gate"` 不再命中这条 entry。新 phrases 描述的是本会话讨论的新主题（end-to-end 验证），不该挤掉旧 phrases。

### 实证 2：load-bearing sections 整段覆盖（commit 2e8924d）

被 update 的 entry：`sanitizer-credential-patterns-are-perpetually-incomplete`。

| 维度 | 之前 | 之后 |
|---|---|---|
| 行数 | 45 | 27 |
| 词数 | 241 | 206 |
| title | "Sanitizer Credential Patterns Are Perpetually Incomplete" | "Pre-sanitize smoke fixture self-residue in assistant output" |
| H2 sections | Evidence (4 bullets), Fix (3 steps), Principle | — |

candidate 实际描述的是一个 **downstream operational hazard**——assistant 解释 pre-sanitize abort 时在 chat 里重复 fixture credential 字符串，造成 self-fulfilling abort cycle。这本该 CREATE 一条新 entry with `derives_from: [sanitizer-credential-patterns-are-perpetually-incomplete]`，**完全不该 update 这个上游 pattern entry**。

curator 把"topic 相关"等同于"update target"，又把 update 解释成 overwrite，复合得到 P0 data loss。

### 共同模式

两次 P0 都是同一根因的两个表现面：

- 根因 1：curator 对 "update over create" 的字面化执行——只要 candidate 触碰相关主题就视为 update target，不区分 refines-same-claim vs downstream-observation。
- 根因 2：curator 对 "new current best truth, not append-only delta" 的过度解释——把 candidate 的 compiled_truth 当成 entry 的新身体替换，而不是当成应该 integrate 进 existing body 的 delta。

第 2 次的损害更严重（永久丢失 evidence/fix/principle，仅 git history 可救），sample size = 2 已足以判定 **systematic problem**（首次仅是 trigger_phrases 替换、易被忽视；第二次直接覆盖 body 才暴露真实严重性）。

## 决策细节

### Layer 1：Curator prompt 约束（`extensions/sediment/curator.ts:makeCuratorPrompt`）

加 4 段新指令：

1. **Update vs create discipline**

   ```text
   - Use UPDATE only when the candidate REFINES the SAME claim the
     neighbor already makes (corrects an error, adds confidence, narrows
     scope, supplies a better compiled truth for the SAME assertion).
   - Use CREATE with `derives_from: [<neighbor-slug>]` when the
     candidate is a DOWNSTREAM observation that builds on the
     neighbor's premise but states a DIFFERENT claim (a new failure
     mode, a new operational hazard, a new consequence, a new
     specialization). 'Same topic area' is NOT sufficient grounds for
     update; the candidate must contradict, supersede, or directly
     refine the neighbor's claim.
   - When in doubt: prefer CREATE with derives_from over UPDATE. A
     spurious duplicate is recoverable via merge later; an UPDATE that
     overwrites durable evidence/fix/principle sections is data loss
     recoverable only via git history.
   ```

2. **Update body-preservation contract**

   ```text
   - For update, compiled_truth should be the new current best truth,
     not an append-only delta. But: PRESERVE the neighbor's Evidence,
     Fix, Principle, code-example, and similarly-load-bearing sections
     VERBATIM unless the candidate explicitly contradicts a specific
     sentence in them. Removing such a section because the candidate
     'no longer discusses it' is the bug. The candidate's
     compiled_truth is a DELTA proposal; you must integrate it into
     the existing body, not replace the body.
   - The candidate's title is a HINT, not a directive. Do NOT change
     the neighbor's title via the title patch field unless the
     candidate's title genuinely renames the same claim (e.g. fixing a
     typo). If the candidate's title describes a different claim than
     the neighbor's title, that is a strong signal you should CREATE,
     not UPDATE.
   ```

3. **trigger_phrases UNION semantics**

   ```text
   - trigger_phrases on update: UNION the existing trigger_phrases
     with the candidate's, do not REPLACE. Drop existing phrases only
     if they describe a sub-claim the candidate explicitly retires;
     otherwise keep all old phrases (they are retrieval anchors,
     losing them breaks future memory_search). If you want to fully
     replace trigger_phrases, you almost certainly meant CREATE.
   ```

### Layer 2：Writer 机械底线 — 已部分移除 ⚠️

> **⚠️ `ee1c809` 后状态（2026-05-13 revert）：** 以下 (a) `body_shrink` 和 (b) `body_section_loss` 机械门控已被按设计移除，不再存在于当前 writer 代码中。保留此节仅作决策历史记录。
> 移除理由：silent reject 创建不可修复的死条目（curator 反复尝试同一操作 → 反复被拒 → 无人通知 → entry 永久腐烂），违反 sediment 自我进化哲学。
> 当前 writer 仅保留 **(c) trigger_phrases auto-UNION** 作为数据 enrichment 兜底（非阻塞门控），以及 **(d) skipBodyShrinkGuard 已随 (a)(b) 一并移除**，
> `mergeUpdateMarkdown` 的 `mergeOpts: {} = {}` 参数是无用残留。
>
> 参考头部决策摘要获取当前实际防线。

以下为 `07e4a3e` 原实施内容（历史参考）：

#### (a) ~~`body_shrink` reject~~（已于 `ee1c809` 移除）

```text
if (patch.compiledTruth !== undefined && !mergeOpts.skipBodyShrinkGuard) {
  const oldLen = existingCompiledTruth.trim().length;
  const newLen = compiledTruth.length;
  if (oldLen > 0 && newLen < oldLen * 0.5) {
    return { error: "body_shrink: ..." };
  }
}
```

- 触发条件：update 携带新 compiledTruth 且字节长度 < 旧的 50%。
- 阈值 0.5 选择依据：常规 trim（删少量 stale 句子）通常 <20%；激进 consolidation 罕见过半。0.5 loose 够允许合法 refactor，tight 够 catch 字节级 outright overwrite。
- 注：单独的 byte-length 检测 catch 不住 `2e8924d` 类（只 shrunk 14% 但删 3 个 H2 sections），需要 (b) 补强。

#### (b) ~~`body_section_loss` reject~~（已于 `ee1c809` 移除）

```text
if (patch.compiledTruth !== undefined && !mergeOpts.skipBodySectionLossGuard) {
  const oldH2 = collectH2(existingCompiledTruth);
  if (oldH2.size >= 2) {
    const newH2 = collectH2(compiledTruth);
    const retained = [...oldH2].filter((h) => newH2.has(h)).length;
    const required = Math.ceil(oldH2.size / 2);
    if (retained < required) {
      return { error: "body_section_loss: ..." };
    }
  }
}
```

- 触发条件：旧 body 有 ≥2 个 `## ` H2 sections 时，新 body 必须 retain ≥ ceil(旧/2) 个原 H2。
- 比 byte-length 更准抓 `2e8924d` 类——"短 shrink 但删 sections"。
- 案例：旧 4 个 sections（Evidence / Fix / Principle / Implications）→ required ≥2；如果新 body 只保留 1 个，触发 reject。

#### (c) trigger_phrases auto-UNION ✅ 保留

```text
const existingRaw = frontmatter.trigger_phrases;
const existing: string[] = Array.isArray(existingRaw)
  ? (existingRaw as unknown[]).filter((v): v is string => typeof v === "string")
  : typeof existingRaw === "string" && existingRaw.trim()
    ? [existingRaw.trim()]
    : [];
// case-insensitive dedup, existing wins on conflict
const seen = new Set<string>();
const union: string[] = [];
for (const p of [...existing, ...candidate]) {
  const key = p.trim().toLowerCase();
  if (!key || seen.has(key)) continue;
  seen.add(key);
  union.push(p);
}
```

- writer 层强制 union，curator 想 REPLACE 也做不到。
- case-insensitive dedup：`"alpha phrase"` 与 `"ALPHA Phrase"` 视为同一 phrase，保留先遇到的 casing（通常是 existing）。
- 同时支持 scalar string 形式（手写 / legacy entry 可能用 `trigger_phrases: only-one` 而非列表）——defense-in-depth，避免 Array.isArray 检查导致 silent drop。

#### (d) ~~`skipBodyShrinkGuard` opt-in 旁路~~（已于 `ee1c809` 随 (a)(b) 一并移除）

```text
mergeProjectEntries → updateProjectEntry({ skipBodyShrinkGuard: true })
```

- 仅 `mergeProjectEntries` 设 true，因为 merge 是 consolidation：合成 body 比每个 source 都短是正常工作产物，不应被 floor 误杀。
- archive / supersede / soft-delete 不传 compiledTruth，guard 自然 skip（`if (patch.compiledTruth !== undefined)`），无需 flag。

### Layer 3：Smoke regression lock — 已部分移除 ⚠️

> **⚠️ `ee1c809` 后状态：** body_shrink / body_section_loss 的 4 个 smoke fixtures 已同步移除。
> 保留的 fixtures：trigger_phrases UNION（create + update + legacy scalar form）、curator prompt marker 检查、sanitizer 防线。
> 以下为历史 fixture 表（已不反映当前 smoke）：

以下为 `07e4a3e` 原 fixture 清单（历史参考）：

新增 6 个 curator prompt marker 断言 + 7 个 writer defense fixture：

| Fixture | 验证 |
|---|---|
| `body_shrink` reject + audit.detail | (a) 工作 + reason 是 `body_shrink` 不是错误细节字符串 |
| preserve ≥50% body 仍然 update 成功 | (a) 不误杀合法 refactor |
| 4 trigger_phrases UNION (alpha 原 casing wins + delta added + ALPHA dup dropped) | (c) UNION 语义 + case-insensitive dedup |
| scalar trigger_phrases form UNION 不静默丢失 | (c) defense-in-depth for legacy entry |
| archive 不被 body_shrink 误杀 | (d) guard 自然 skip |
| merge 允许 shrink body（合成 body ≪ source 各自） | (d) skipBodyShrinkGuard 旁路 |
| `body_section_loss` reject + audit.detail | (b) H2-aware floor 抓 2e8924d 类 |

未来重构若 break 任一 invariant，smoke 立即报红。

## 实施现状（含 revert 记录）

> **⚠️ 2026-05-14 审计更新：** 当前实际防线 = Layer 1 prompt + writer trigger_phrases UNION + sanitizer/storage gates。
> 原机械门控（body_shrink, body_section_loss, skipBodyShrinkGuard, 对应 smoke fixtures）已于 `ee1c809` 移除。
> 下方表格记录完整实施时间线，标注哪些已保留、哪些已移除。

| 工作 | 状态 | commit | 当前 |
|---|---|---|---|
| 受损 entry restore | ✅ | abrain `f066279` (git checkout HEAD~1) | — |
| Layer 1 prompt | ✅ | pi-astack `07e4a3e` 内 curator.ts | ✅ 保留 |
| Layer 2 writer trigger_phrases UNION | ✅ | pi-astack `07e4a3e` 内 writer.ts | ✅ 保留 |
| Layer 2 writer body_shrink / body_section_loss | ✅ | pi-astack `07e4a3e` → **`ee1c809`** | ❌ 已移除 |
| Layer 3 smoke: trigger_phrases UNION + prompt markers | ✅ | pi-astack `07e4a3e` 内 smoke | ✅ 保留 |
| Layer 3 smoke: body_shrink / body_section_loss fixtures | ✅ | pi-astack `07e4a3e` → **`ee1c809`** | ❌ 已移除 |
| 父仓 bump + re-enable | ✅ | `3e3adf1` settings.json autoLlmWriteEnabled: true | — |
| production end-to-end verify | ✅ | abrain `c3c659f` (create) + `1695728` (update +14/-5, 6→7 H2 sections) | — |

## 双模型 review 关键发现

- **opus**（130s）：发现 1 P1（merge 路径会被 body_shrink 误杀，因为 merge 合成 body 必然 shrink）→ 修复 (d)；发现 1 P1（注释声称"catch 2e8924d"但 byte-length 阈值实际抓不住）→ 加 (b) section-loss floor + 注释改"strictly more severe than 2e8924d"。
- **deepseek**（177s）：发现 1 P2（trigger_phrases 是 scalar string 时会被 silent dropped）→ 修复 (c) scalar 兼容分支；验证 5 个 writer mutation path（update / archive / supersede / merge / soft-delete）guard 行为全部正确。

两个 model 都 GO。

## 不变量保护范围（当前 `ee1c809` 后）

> **⚠️ 2026-05-14 审计更新：** 当前不变量的实际保护机制：
> - `trigger_phrases` 可被覆盖（无 reject）：writer UNION 兜底
> - `entry` load-bearing sections：**无机械保护**（信任 curator prompt + 后续迭代自修复）
> - `entry.body` 50% shrink：**无机械保护**
> - `entry.body` H2 sections：**无机械保护**
>
> 原 `07e4a3e` 声称的 Layer 2 guard 保护已不再适用。详见决策摘要。

以下为 `07e4a3e` 原不变量的历史记录：

| 保护对象 | 由哪层 enforce（`07e4a3e`） | 失效条件 |
|---|---|---|
| Entry 不被整体覆盖 | Layer 1 prompt + Layer 2 (a) body_shrink | 字节 ≥50% 保留 |
| H2 sections 不被 wholesale 删除 | Layer 2 (b) body_section_loss | 旧有 ≥2 H2 时新版必须 retain ≥ ceil(旧/2) |
| trigger_phrases 不被替换 | Layer 2 (c) auto-UNION（机械保证，curator 无法 bypass） | 永真 |
| Merge consolidation 不被误杀 | Layer 2 (d) skipBodyShrinkGuard 旁路 | 仅 mergeProjectEntries 设 true |
| Downstream observation 不会撞 update 路径 | Layer 1 prompt "When in doubt prefer CREATE" | LLM 顺从 prompt；若不顺从，Layer 2 (a)/(b) 兜底 |

## 不做

- **不**配置化 `body_shrink` threshold（默认 0.5）。可配化会让用户在 autoLlmWriteEnabled 场景下意外调低到接近 0，等于关掉防线。如果将来确实出现"合法 >50% shrink"用例，正确做法是用 supersede/archive/delete 而非放开 floor。
- **不**强制 trigger_phrases 必须 UNION 且**完全**禁止 retire——curator 可通过 supersede/archive 整 entry 退役，单 phrase 微小 retire 当前**唯一**出路是手动 git 编辑。这是已知 limitation；若实际出现需要时，加 `patch.triggerPhrasesRetire: string[]` 显式字段（curator 必须主动 list 要删的，而非通过 omit 删）。
- **不**自动监控 "create-despite-neighbors" 数量。opus 提的 follow-up：新 prompt "when in doubt prefer CREATE" 可能催 duplicate 泛滥。但当前没有 audit 消费侧（无 alert 阈值、无 sediment self-improve hook），等真观察到 duplicate 家族（≥3 个 derives_from 同祖先）再做。

## 经验教训

1. ~~prompt 单层防御不够~~（`07e4a3e` 原始结论）。**`ee1c809` 后修订：** 机械门控的 silent reject 制造不可修复的死条目，比单次 LLM knowledge degradation 危害更严重。当前策略改为信任 LLM curator 的自进化能力——单次知识降级可被后续迭代自我修复。保留 trigger_phrases UNION 作为安全的数据 enrichment 兜底（非阻塞），同时依赖 sanitizer 作为硬安全边界。详见 world maxim `prefer-prompt-engineering-over-mechanical-guards`。
2. **Byte-length 不是 semantic loss 的好 proxy**。`2e8924d` 只 shrunk 14% 字节但删了全部 load-bearing sections。Structural check（H2 retention）才能抓"短 shrink 但 wholesale section loss"。
3. **Sample size = 2 已构成 systematic problem 证据**。首次 P0 仅 trigger_phrases 被换、易被忽视；第二次 body overwrite 才暴露真实严重性。第一次发生时若立即介入，可避免第二次。今后类似单次"奇怪"observation 应当被认真追踪。
4. **mutation API 的 guard 必须区分 op 语义**。同一个 `mergeUpdateMarkdown` 服务 update / archive / supersede / merge 四种 op，每种 op 的 invariant 不同（merge 允许 shrink；update 不允许；archive 不传 compiledTruth）。Guard 必须读 op 上下文或显式 opt-in flag 旁路，否则就会出现 opus 找到的"merge 被 update guard 误杀"现象。
5. **revert 永远是数据恢复第一手段**。abrain 是 git repo，git history 是 sediment data loss 的终极 rollback surface（commit message convention `sediment: <op> <slug> (project:<id>)` 让 grep 易追溯）。Layer 2 拒绝危险 update 时盘上不动（atomicWrite 不跑），更进一步降低了恢复成本。

## 引用

- pi-astack commits：`07e4a3e`（3 层 defense ship）、`3c604c8`（B5 cutover 后 deferred cleanup，prompt 软约束 wikilink hygiene）、`da4bf65`（B5 sediment writer cutover）
- abrain commits：`f066279`（restore curator P0 损坏 entry）、`c3c659f` + `1695728`（defense ship 后端到端 verified 的 2 个 sediment auto-write commit）
- 父仓 commits：`3e3adf1`（bump + re-enable）、`c69bdf3`（emergency disable）
- 历史 P0 commits：`521405b`（trigger_phrases 全替换）、`2e8924d`（load-bearing sections wholesale 删除）
