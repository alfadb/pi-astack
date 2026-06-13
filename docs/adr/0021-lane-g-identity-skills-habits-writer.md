---
doc_type: adr
status: accepted
---

# ADR 0021 — Lane G writer：`identity/skills/habits` 三区落地

> 🗄️ **ARCHIVE-CLASS · 机制存档（Phase-2，3×T0 mark-in-place）**：G1/G2 已 shipped 的**当前**设计（非历史，偏 0025 同类被误分类）；writer/fence/router 机制 + 七区 invariant 仍 enforced。机制正文原地保留可读、物理归档延后至 abrain ingest lane 落地，勿移勿删。

- **状态**：Accepted（2026-05-15）；**G1 ✅ shipped 2026-05-16**（commit `63bb9da`）；**G2 ✅ shipped 2026-05-20**（`/about-me` slash + agent_end 双 lane wire-up）；G3–G5 backlog。G1 经 4 轮 multi-LLM audit（opus-4-7 / opus-4-6 / gpt-5.5 / sonnet-4-6 / deepseek-v4-pro 多厂交叉验证），P0 收敛轨迹 2 → 1 → 1 → 0。
- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md)（§3.3 + §3.5 deterministic router 是本 ADR 的设计前置）、[ADR 0013](0013-asymmetric-trust-three-lanes.md)（trust lane 框架）、[ADR 0016](0016-sediment-as-llm-curator.md)（sediment-as-curator 架构，本 ADR 复用其 writer/sanitizer/lock substrate）、[ADR 0018](0018-sediment-curator-defense-layers.md)（writer 防御层 trigger_phrases UNION、body-preservation）
- **被引用**：G1 ship 后反向更新：ADR 0014 实施现状表的 Lane G 行从 "待实施" 改为“G1 ✅ shipped 2026-05-16”；docs/current-state.md、docs/roadmap.md、docs/brain-redesign-spec.md 同步。
- **触发**：2026-05-15 multi-LLM doc-vs-code audit（round 1+2）关闭 9 项 backlog 后，剩余三项真 backlog 中 Lane G 工程量最大但**无外部依赖阻塞**；现有 ADR 0014 §3.5 已有完整 router spec，再 defer 没有意义。

## 背景

ADR 0014 落地 1.5 个月后，`~/.abrain/` 七区物理目录全部就位（`brain-layout.ts::ensureBrainLayout`），但 `identity/` `skills/` `habits/` 三区 **全是空 mkdir** —— 没有 writer 函数、没有 slash 触发、没有 router 实现。`brain-redesign-spec.md §3` 显式将该 gap 列入 pending；`current-state.md §5` 不变量 #5 写明"任何文档声称 `/about-me` 已可用都过时"。

后果：所有 about-me 性质的信号（用户偏好、认知风格、技术栈倾向）目前要么散落在每个 project 的笔记里（错误的 store），要么根本没有沉淀。memory_search 在跨项目场景下找不到"用户层的稳定事实"作为顶层 evidence，rerank 质量与 ADR 0014 D1 §"跨项目原生支持"的承诺有差距。

ADR 0014 §3.5 已经把 deterministic router 规范、`validateRouteDecision` 强约束 enforcer、低 confidence → staging 的 lifecycle 写完，剩下的纯是工程化与 cutover。

## 决策

### D1. Lane G writer 函数 `writeAbrainAboutMe`

新增 `extensions/sediment/writer.ts::writeAbrainAboutMe`，对标 `writeAbrainWorkflow` 的接口风格（B1 已建立的 abrain-side substrate 模板：abrain-side lock + abrain-side audit + abrain repo git commit），三区共享同一个 writer，物理目录由 `region: "identity"|"skills"|"habits"` 参数选择：

```typescript
export interface AboutMeDraft {
  title: string;                                  // ≤ 80 char
  body: string;                                   // ≥ 20 char compiled truth
  region: "identity" | "skills" | "habits";       // determined by router (D3) before writer
  routingConfidence: number;                      // [0,1]; writer 不参与决策，但写入 frontmatter 供 doctor
  routeCandidates: string[];                      // ["identity","habits"] etc.；同上
  routingReason: string;                          // sanitized
  triggerPhrases?: string[];
  tags?: string[];
  status?: EntryStatus;                           // default "active"
  slug?: string;                                  // optional explicit override
  timelineNote?: string;
  sessionId?: string;
}

export interface WriteAboutMeOptions {
  abrainHome: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditContext?: WriterAuditContext;
}
```

落盘路径：`~/.abrain/<region>/<slug>.md`（region 决定顶层目录，三区都是 abrain-home 的直接子目录，**不挂在 `projects/`** —— Lane G 写的是 about alfadb，跨 project 共享）。

复用现有 substrate（与 `writeAbrainWorkflow` 同）：
- sanitizer：`sanitizeForMemory`（title/body/trigger/tags/timelineNote 都过）
- markdown lint：`lintMarkdown`
- 锁：`<abrainHome>/.state/sediment/locks/about-me.lock`（与 workflow.lock 独立，避免 Lane G 与 B1 互相阻塞）
- audit：`abrainSedimentAuditPath(abrainHome)`，row 携 `lane: "about_me"`（已在 ADR 0014 §审计扩展 lane enum 中预留）
- git commit：abrain repo（与 workflow 同）
- atomic write：tmp + rename
- git rollback：参 sediment writer 现有"if gitCommit===null then unlink + git reset HEAD" 模式（[审计 F-round2-2026-05-14 落实]）

**显式不复用**：`writeProjectEntry` 的 `projectId` / project-binding / `<projectRoot>/.pi-astack/` 路径 —— Lane G 与 project 无关。

### D2. 触发：`MEMORY-ABOUT-ME` fence + `/about-me` slash

两条入口都最终走 `parseExplicitAboutMeBlocks` → curator routing → `writeAbrainAboutMe`，**对称于 Lane A 的 `MEMORY:` fence + Lane C 的 auto-extractor**：

| 入口 | 用户感知 | 实现 |
|---|---|---|
| `MEMORY-ABOUT-ME:` fence | 用户在普通 message 内嵌的声明 | `extractor.ts::parseExplicitAboutMeBlocks` (与 `parseExplicitMemoryBlocks` 同构，fence 头改为 `MEMORY-ABOUT-ME:`，结束 marker 仍为 `END_MEMORY`；fence-in-code-block 跳过规则一致) |
| `/about-me <text>` slash | 用户主动 slash | slash handler 把 `<text>` 包成 `MEMORY-ABOUT-ME:\n<text>\nEND_MEMORY` 插入 transcript（**user role**），sediment agent_end 自然 pick up；slash handler **不直接调 writer** —— 保持 ADR 0014 不变量 #1 layer 1 mechanic（main session 不直接 mutate brain SOT）。详 D4。 |

slash 的 `<text>` body 默认 sanitize + length-validate；空 body 走 TUI multi-line input prompt（与 `/secret set` 体验对齐）。

### D3. Router：从 ADR 0014 §3.5 spec 落实

实现 `extensions/sediment/about-me-router.ts`，三 stage 严格按 spec：

**Stage 1 — Lane allowlist (deterministic)**：`laneAllowlist["about_me"] = {identity, skills, habits, staging}`；这是 hard guard，**Lane G 永远不能写到 knowledge/workflows/projects** —— `validateRouteDecision` 拒绝并写 `route_rejected` audit。

**Stage 2 — aboutness classifier (LLM)**：复用 curator 的 LLM 调用 substrate（同一个 sediment model + JSON-mode + temperature=0）。Classifier prompt 输入 `{title, body, candidates: ["identity","skills","habits"]}`，强制 JSON-only 输出：

```json
{
  "chosen_region": "identity" | "skills" | "habits",
  "route_candidates": ["identity", ...],
  "routing_reason": "≤200 char rationale",
  "routing_confidence": 0.0~1.0
}
```

判定 hint（写进 system prompt，对齐 spec §3.5 + ADR 0014 §"开放问题 Q1"）：
- **identity/**：稳定自述、价值观、认知偏好、个人叙事（"我对 over-engineering 过敏"、"我重视类型安全"）
- **habits/**：观察到的重复行为模式、统计上的倾向（"我倾向先跑 smoke 再 commit"、"我 PR 拆分粒度偏细"）
- **skills/**：技术 / 元能力 inventory（"我熟 TypeScript"、"我用 vim 比 vscode 多"）

边界 case sediment 自己给低 confidence，由 Stage 3 接管。

**Stage 3 — staging gate**：`routing_confidence < 0.6` → 写 `~/.abrain/projects/<active>/observations/staging/<YYYY-MM-DD>--<pid>--<sessionStartEpoch>.md`（spec 已定义路径 schema），entry frontmatter 携带原始候选 `route_candidates` + reason 供后续 `review-staging` 接管。**不直写 identity/habits/skills** —— ADR 0014 §3.5 staging trust budget 原则。

router 决策结果**强制走** `validateRouteDecision` enforcer（ADR 0014 §3.5 v1.2 补的 6-rule gate）；其中 Lane G hard exclusions（rule 4）与 confidence gate（rule 3）是 Lane G 主路径。

### D4. `/about-me` slash 走 fence-in-transcript（不直接调 writer）

ADR 0014 不变量 #1 layer 1：main session 的 TUI command handler **不能直接** 持有 brain mutation 入口（vault 例外，那是 user-typing-driven sync write，受 layer 1 保护）。Lane G 的 trust 来自用户主动声明，但**写入仍走 sediment async** —— 与 Lane A `MEMORY:` 完全对称。

slash 实现路径：
1. `extensions/sediment/index.ts` 注册 `registerCommand("about-me", …)`
2. handler 收到 `<text>` → sanitize length → 调 `ctx.transcript.append({role: "user", content: \`MEMORY-ABOUT-ME:\n${text}\nEND_MEMORY\`})`（API 待 pi extension SDK 确认；如不支持 user-role inject 则降级为"打印 fence 模板给用户复制黏贴"，但保留 layer 1 不变量）
3. sediment 下一次 agent_end 触发 `parseExplicitAboutMeBlocks` → router → writer

slash 自己**不**接触 `~/.abrain/` 任何文件；smoke 用 `parseExplicitAboutMeBlocks` 直接测 fence，验证端到端无需经过 TUI。

### D5. Frontmatter schema

复用现有 `MemoryEntry` frontmatter，新增 4 个 Lane-G-specific 字段（在 audit lane 之外，作为 entry-level 数据），供 doctor / review-staging / memory_search hint 使用：

```yaml
id: <slug>
title: <sanitized>
kind: maxim | preference | fact | smell | pattern | anti-pattern | decision    # ENTRY_KINDS canonical
status: active | provisional | ...                                              # ENTRY_STATUSES canonical
schema_version: 1
created: <ISO>
updated: <ISO>
trigger_phrases: [ ... ]
# Lane G 专有字段
region: identity | skills | habits | staging      # echo D3 router 决策
route_candidates: [identity, habits, ...]         # router Stage 2 多选
routing_reason: <≤200 char>
routing_confidence: 0.0~1.0
lane: about_me                                    # echo audit lane
```

`region` 字段 **frontmatter source of truth**：memory_search 与 review-staging 都从 frontmatter 取，不靠目录路径反推（避免 mv 后失同步）。

### D6. 衰减不在 P0 范围

ADR 0014 §2.2 / §2.3 提到 skills/habits 90 天未强化 → confidence decay → status:deprecated。**P0 不做 decay**，等真有数据再决定衰减曲线（YAGNI）。frontmatter 留 `confidence` 字段位置（按 ENTRY validation 已有），但 writer 默认 confidence=5 (out of 5)，无自动衰减。

## 关键不变量

1. **Lane G 物理目录互斥**：`identity/skills/habits` 三区在 abrain-home 顶层，每条 entry 物理上只在一处（spec §不变量 #7 的具化）。**slug 全局唯一跨 region** —— writer dedupe 扫描三区 + staging 共四个目录；slug 撞了拒写并 audit `dedupe_collision`。
2. **`validateRouteDecision` 是 hard gate**：Lane G writer 入口 **必须** 先过 `validateRouteDecision`；missing 字段、lane-target mismatch、low confidence 未走 staging 全部 throw `RouterError`，writer 不写任何 markdown 不写任何 audit row（只写 `route_rejected` audit + 原始输入到 `staging/rejected/`，避免静默丢入作样本）。
3. **`/about-me` slash 不直接调 writer**：slash handler 只 inject fence 进 transcript，sediment async pick up；保持 ADR 0014 不变量 #1 layer 1 mechanic。
4. **Lane G 不写 vault**：Lane G classifier 拒绝判定到 vault；vault 入口只走 `/secret` (Lane V)。
5. **Lane G fence trust 边界继承 Lane A**（P1-4 audit 2026-05-15 修正）：`MEMORY-ABOUT-ME:` 享受两层机械防御——(a) `parseExplicitAboutMeBlocks::isInsideCodeFence` 跟 `parseExplicitMemoryBlocks` 同机制跳过 fenced code block、(b) sediment 在 dispatch sub-agent 子进程是 `ephemeral_session` early-return（`sediment/index.ts::agent_end` ~L601），不跳提取。**但**：子进程输出经 `tool_result` 回流主 session transcript 后，主 session 的 sediment 会在自己的 agent_end 中看到那些字符，包括 sub-agent 写的 `MEMORY-ABOUT-ME:`。这是与 Lane A `MEMORY:` 等同的 trust 边界，属 ADR 0014 trade-off #9 “LLM 主动 exfiltration / prompt injection” 的已知 residual surface，Lane G 未额外加固。未来 G3 LLM classifier 上线后可考虑在 classifier prompt 里加 provenance 提示（这是 sub-agent 输出？）作 best-effort 过滤，但依然不是机制保证。
6. **memory_search Lane G surface：G1 后默认可搜**（P1-7 audit 2026-05-15 修正）：identity/skills/habits 是 abrainHome 的顶层子目录，**G1 ship 后已被 world store walker 默认包含**（world store root = abrainHome；walker 只排 projects/ + vault/），不需要在 `resolveStores` 里新增 store。缺的是 *region-aware ranking hint*：G5 要做的是让 RRF 融合前的 boost 识别 `frontmatter.region` 字段 → 按 ADR 0014 §4.1 的 about-me+world surface 作业为 1.0× baseline 同时供各 region 级别的微动系数；project store 仍是 2.0×、other-projects 0.3×不变。跨 store first-wins（abrain-project > world > legacy-pensieve）不变，不被 Lane G 引入的区覆写。
7. **staging 不进 memory_search**（P0-B audit fix 2026-05-16）：spec §3.5 staging lifecycle 要求 facade 默认排除 staging。G1 实施点：`parser.ts::scanStore` 对 project store 传入 `STAGING_IGNORE_REL_PATHS = {"observations/staging", "observations/staging/rejected"}`，walker `walkMarkdownFiles` 新增 `opts.ignoreRelPaths`（relpath-anchored，不是 basename match，避免误伤所有叫 staging 的目录）；listFilesWithRg `--glob !**/observations/staging/**` + `!**/observations/staging/rejected/**` 作为主路径。world store 本身已被 WORLD_EXTRA_IGNORE_DIRS 排了 `projects/`，staging 在 projects 下口，间接被排，不需额外动作。

## 后果

### 好处

- **abrain 七区设计承诺兑现**：3/7 空 zone 中 identity/skills/habits 三个落地后，剩 vault（已 ship P0c）+ workflows（已 ship B1）+ projects/knowledge（已 ship B5）全部有 writer，七区设计承诺基本对齐。
- **跨项目 LLM context 提升**：memory_search 在跨项目场景下能找到"用户层稳定事实"作为顶层 evidence。例如 `/decide` 类高层工具不再每次都要重新猜用户偏好。
- **`/about-me` 用户级 visible value**：用户能主动写"我是谁"信号，不再依赖每个 project 笔记的散落痕迹。
- **router 实现重用**：`validateRouteDecision` 是 ADR 0014 §3.5 已规范的 enforceable gate，本 ADR 是其首个 production caller。Lane C 跨项目升级路径（auto-write → knowledge/）未来也可复用同一个 validator。

### 坏处

- **classifier 错分类风险**：identity vs habit 的边界在自然语言上是软的（"我重视类型安全" vs "我倾向先开 strict"），单条 LLM 判定可能不稳。缓解：低 confidence → staging（不直接污染 identity）；用户可通过 `review-staging` 校正；frontmatter 携带 `routing_reason` 供事后审计。
- **slash → transcript inject 依赖 SDK 能力**：若 pi extension API 不支持 user-role 注入，需要降级为"打印 fence 模板让用户复制"。这是已知 trade-off，写在 D4。
- **staging 目录磁盘垃圾**：30 天未 review → 静默删除（spec §3.5 staging lifecycle 已规范），但 audit 留痕；review-staging slash 在 P0 不实现，需后续 phase。
- **dedupe 跨四目录扫描成本**：每次 writer 调用扫 identity+skills+habits+staging 全部 entry 看 slug 撞不撞；当前 entry 数极少（0），未来过千需建索引。当前接受 O(N) 扫描。

### 中性

- **不影响**：Lane A/C/V 写路径、memory_search 现有双阶段 LLM retrieval、ADR 0017 strict project binding。
- **简化**：deterministic router 此前是 spec 描述，本 ADR 让它有第一个 production 实现，未来 Lane C "auto_write → knowledge/ 跨项目升级" 可直接复用 `validateRouteDecision`。
- **延后**：skills/habits 衰减曲线（D6）、review-staging slash（P0 不做）、`/about-me edit` / `/about-me list`（P0 不做，由 memory_search/get 替代）。

## 实施 phase

| Phase | 内容 | 验收 |
|---|---|---|
| **G1 (this ship)** | `writeAbrainAboutMe` writer 三区落盘 + sanitizer/lint/lock/audit/git commit 全套；`parseExplicitAboutMeBlocks` fence extractor；`validateRouteDecision` 在 `extensions/sediment/about-me-router.ts` 暴露 + Lane G 路径 wire-up；**parser.ts 加 STAGING_IGNORE_REL_PATHS 实施不变量 #7**（P0-B 2026-05-16）；smoke fixture 覆盖：三区 happy path、validation_error、sanitizer reject、staging 路径（confidence<0.6）、lane-target mismatch reject、git rollback、dedupe collision、全管道 loadEntries 验证 staging 被排 + identity 被发现 | smoke-memory-sediment.mjs 新增 about-me block 全绿 |
| **G2 ✅ shipped 2026-05-20** | `/about-me` slash command 注册 + transcript inject 路径（`pi.sendUserMessage` → MEMORY-ABOUT-ME fence → 下一 agent_end 同步写）；agent_end 内 Lane A + Lane G 双同步写循环并行（共用 parse 阶段，独立 audit / correlation_id / shouldAdvance；checkpoint 仅在两 lane 都 terminal 时 advance）；空 body 走 `ctx.ui.select` + `ctx.ui.input` 两步 prompt（与 /abrain / /secret / /vault 一致；askPromptUser overlay 作为未来 polish 入口预留）；`--region=` / `--title="..."` 标志解析；body ≥ 20 / ≤ 4000 chars 前置 gate；fence builder ↔ extractor round-trip smoke 验证 | smoke-memory-sediment.mjs 新增 G2 block 全绿：parseAboutMeArgs 9 用例 / deriveAboutMeTitle / 三区 fence round-trip / fence-in-code-block 防御 / 默认 confidence=1.0 + canonical routingReason / 低置信 fence → router 自动降级 staging（验证 P0-1 wire-up 不变量） |
| **G3** | aboutness LLM classifier 接入（curator model 复用，prompt 模板 + JSON-mode + temperature=0）；当前 G1 暂用 fence 内 `region:` 显式声明（user-attested），G3 接入后 LLM 默认决策、用户 `region:` 强制覆盖 | router fixture 10-15 例正反样本 |
| **G4** | `review-staging` slash + staging 30-day TTL job（facade walker 排除已在 G1 落实，见不变量 #7） | manual + smoke |
| **G5** | identity/skills/habits **已在 G1 后被 world store walker 默认包含**（P1-7 audit 2026-05-15 修正：resolveStores 不需动）。G5 真正要做的是 region-aware ranking hint：在 stage1 candidate selection / stage2 rerank prompt 里把 `frontmatter.region` 作为 surface boost 信号 → ADR 0014 §4.1 about-me+world 的 1.0× baseline + region 级别微调 | smoke：Lane G entry 写后能被 memory_search 找到（已 G1）+ ranking hint 负载测试 |

P0 实施单元 = **G1**，本 ADR 落地的同一会话内完成。**G2 已 2026-05-20 ship**，G3-G5 列入 roadmap，由真实使用反馈决定优先级。

### G2 关键设计决定（2026-05-20）

1. **transcript inject 走 `pi.sendUserMessage`**：ADR 0021 D4 草拟时担心 "SDK 是否支持 user-role inject"；2026-05-20 确认 pi 0.75+ 一直暴露 `pi.sendUserMessage(content, options?)`，直接用即可。代价是每次 `/about-me` 触发一次 LLM turn（fence 出现 in chat → assistant 通常回 "Noted." → sediment 在该 turn agent_end 写入），可接受 — layer-1 mechanic 由此自然满足。
2. **slash UI 用 `ctx.ui.select` + `ctx.ui.input` 不复用 askPromptUser overlay**：askPromptUser 的 chained-fallback path 走的就是这两个 primitive；overlay 路径需要 sediment lazy require pi-tui + buildDialog + audit sink wiring — 跨 extension 耦合退不出价值。未来 polish PR 可升级。
3. **routingReason 是 canonical fixed string**（`"user-attested via MEMORY-ABOUT-ME fence (G1)"`），不拼接 timelineNote。理由：routing_reason 是 routing rationale（D5 设计），timelineNote 是 Timeline section 叙事 — G2 初版误将二者同源导致 “route_rejected (router rule)” 轮废当理由使用。Smoke 捕获后修复。G3 LLM classifier 上线后会用 LLM 给出的 rationale 覆盖。
4. **agent_end 双 lane checkpoint 互锁**：`combinedShouldAdvance = laneA && laneG`。任一 lane 失败都不 advance — 避免 Lane A 在 Lane G git 失败后静默吐掉 下一会话重试机会，反之亦然。两个 audit row 都携 `checkpoint_advanced: combined` + `lane_advance_decision: <self>` 双字段以供取证。

## 与上游 ADR 的关系

| 上游 | 关系 | 说明 |
|---|---|---|
| ADR 0013 trust lanes | **扩展实施** | Lane G/V/workflow 在 ADR 0014 已规划，本 ADR 是 Lane G 的首个 writer 实现 |
| ADR 0014 abrain seven-zone | **落实 §3.3 §3.5** | router spec / validateRouteDecision / staging lifecycle 三个核心规范都在 0014，本 ADR 是它们的 production cutover |
| ADR 0016 sediment-as-curator | **复用 substrate** | sanitizer/lock/audit/git commit/lint 全套复用 writer.ts 现有 helper；不另起 substrate |
| ADR 0018 curator defenses | **沿用 trigger_phrases UNION** | Lane G 写路径在 G1 不涉及 update/merge，但 future G2+ 用 `/about-me` 重写既有 entry 时必须沿用 UNION + body-preservation |

## 开放问题

| Q | 问题 | 当前答案 |
|---|---|---|
| Q1 | 三区 frontmatter `kind` 字段语义？ identity 都用 `maxim`? skills 都用 `fact`? | 用 ENTRY_KINDS 现有枚举，按 aboutness 自然映射（identity → `maxim` 或 `preference`；skills → `fact`；habits → `pattern`）；不新增 kind 枚举值。`region` 字段才是 Lane G 的判别字段。 |
| Q2 | LLM classifier 与 sediment 现有 curator 共用 model 还是独立配置？ | 共用：reuse `settings.model` + JSON-mode；router 决策是 sediment 的 sub-task，没必要独立配 |
| Q3 | 用户编辑现有 identity entry 路径？ | P0 不做。后续 `/about-me edit <slug>` 走 sediment `updateProjectEntry` 风格（merge frontmatter，preserve unknown）。当前用户可手 edit markdown，sediment 在 agent_end 不会反弹 |
| Q4 | identity entry 是否进 git commit message 摘要？ | 是。abrain repo commit message 与 workflow 同 style：`about-me: <slug> [<region>] (<lane>)`；不暴露 body |
| Q5 | 三区是否需要 `_snapshot.md` derived view？ | P0 不做。仿 `projects/<id>/_index.md` 模式（每次 agent_end 后由 sediment regen），P0 不实施；P0 用户走 memory_search 而不是 snapshot |

## 参考

- ADR 0014 §3.3 Lane G、§3.5 deterministic router、§4.1 facade boost、§审计扩展
- `docs/archive/brain-redesign-spec-v1.5-original.md` §2.1-2.3（identity/skills/habits 区细则）、§3.5（router 三阶段）
- `docs/current-state.md` §5 不变量 #5（`/about-me` 当前文档承诺与代码差距）
- `extensions/sediment/writer.ts::writeAbrainWorkflow`（本 ADR writer 接口模板）
- `extensions/sediment/extractor.ts::parseExplicitMemoryBlocks`（本 ADR fence extractor 模板）
