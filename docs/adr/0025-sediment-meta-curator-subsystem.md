# ADR 0025 v3 — Sediment Meta-Curator：让 sediment 演化为 ADR 0024 第二大脑

- **状态**：v3 consolidated baseline（2026-06-12）。本文是 ADR 0024 六能力点的架构决策记录，不再承载实施状态快照或 commit timeline。
- **目的**：[ADR 0024](0024-second-brain-from-natural-conversation.md) §5 六条能力点的具体落地设计。ADR 0024 说的是 "是什么 / 为什么"（含 4 条 invariant + AI-Native 原则 + 能力点骨架），本 ADR 说的是这些能力点的机制边界、取舍与约束。
- **范围**：sediment 扩展 + abrain (brain backend) + memory (retrieval facade) 三个 extension 的架构边界。文件级实现真相以 [`../current-state.md`](../current-state.md) 与代码为准；未完成计划以 [`../roadmap.md`](../roadmap.md) 为准。
- **不在本 ADR 范围**：(a) 重申 ADR 0024 invariant / 哲学（重复就是 drift 风险）；(b) 跑 audit / 跑 dogfood / 实际发布；(c) 实施快照、完成标记、提交列表。

历史草稿、实施批次和 audit 流水保留在 git history / `docs/audits/`；不并入 ADR 正文。

---

## 0. 起草说明

### 这份文档**只写**

- 影响 ADR 0024 六能力点的架构边界与设计取舍
- 设计约束分层与 explicit 评估项（§3）
- 六能力点的机制设计：prompt skeleton、接口边界、与下游 ADR 的关系（§4）
- 仍属于设计选择的 phase 依赖与 R2+ 决策点（§5）
- 测试原则与边界自检（§6 / §7）

### 这份文档**不写**

- ADR 0024 invariant / AI-Native / 接受代价 / 走偏信号本身的论证——那是 ADR 0024 的事
- 当前实现状态、已完成清单、提交链、R0/R1/R1.1/R1.2 演进史——分别在 `current-state.md`、`roadmap.md`、`docs/audits/` 或 git history
- 任何 R8 P0-X 标记，本 ADR 是 baseline 不是 patch 集合

如果发现本 ADR 在重复 ADR 0024 内容或记录实施流水 → **删掉**，引用即可。

---

## 1. 代码现实（设计前提）

本节只保留与六能力点决策相关的结构事实作为设计前提；文件级实现真相以 [`../architecture/sediment.md`](../architecture/sediment.md) 与代码为准，不在本 ADR 重复 file:line 清单。

### 1.1 现有两条 write lane（重要：不是单一 write loop）

`agent_end` hook @ `extensions/sediment/index.ts:554` 触发后存在 **两条独立 write lane**：

```
agent_end
  │
  ├─ 同步捕获 ctx（cwd / sessionId / branch / notify / setStatus）@ :594-630
  ├─ ephemeral / unhealthy stop / project_not_bound guards @ :644-737
  ├─ buildRunWindow（增量窗口 + checkpoint） @ :746
  ├─ parseExplicitMemoryBlocks(window.text)       → drafts: Lane A   @ :789
  ├─ parseExplicitAboutMeBlocks(window.text)      → aboutMeDrafts: Lane G @ :795
  │
  ├─ drafts.length > 0 OR aboutMeDrafts.length > 0 ?
  │
  │  ── YES ───────────────────────────────────────────────────────────┐
  │   【Lane A / G — 显式同步落盘】                                     │
  │   ├─ 不调 LLM（fence 解析 → 直写 writer）                          │
  │   ├─ Lane A: writeProjectEntry @ writer.ts:1065                    │
  │   ├─ Lane G: writeAbrainAboutMe @ writer.ts:2069                   │
  │   ├─ validate → sanitize → buildMarkdown → dedupe → lint → lock   │
  │   ├─ atomicWrite → gitCommit → fire-and-forget push → appendAudit │
  │   └─ saveSessionCheckpoint                                         │
  │                                                                    │
  │  ── NO ────────────────────────────────────────────────────────────┤
  │   【Lane C — 后台 LLM auto-write，fire-and-forget】                 │
  │   ├─ autoWriteInFlight check → return early @ :1006              │
  │   ├─ setStatus(\"running\") + checkpoint optimistic advance         │
  │   ├─ tryAutoWriteLane() @ :1684  ← NOT awaited                    │
  │   │   ├─ runLlmExtractor(window.text) @ llm-extractor.ts:160     │
  │   │   │     └─ 1 LLM call → freeform MEMORY: fence text          │
  │   │   ├─ parseExplicitMemoryBlocks(llmResult.rawText)            │
  │   │   └─ for each draft:                                          │
  │   │         ├─ curateProjectDraft @ curator.ts:616               │
  │   │         │     ├─ loadEntries → llmSearchEntries (1 LLM)      │
  │   │         │     └─ callCuratorModel (1 LLM) → 7-op decision    │
  │   │         └─ 按 op 分派 writer (create/update/merge/...)        │
  │   ├─ appendAudit (per outcome)                                    │
  │   ├─ notify (user-visible if any)                                 │
  │   └─ scheduleDrainIfBacklog @ :823 (recursive drain loop)        │
  │
  └─ agent_end returns（不等 Lane C 完成）
```

**关键观察**：

1. **Lane A / G 不走 LLM、不走 curator**——直接 fence 解析 → writer。`MEMORY:` 和 `MEMORY-ABOUT-ME:` fence 是当前**用户主动注入路径**，是 ADR 0024 §4.2 反模式列表中的 "MEMORY-RULE: / MEMORY-ABOUT-ME: 围栏让用户手动注入" 的实现。
2. **Lane C 完全 fire-and-forget**——`agent_end` 不 await bg work，主会话不被 sediment 延迟阻塞。这跟 ADR 0024 INV-INVISIBILITY 一致 —— INV 要求的是"用户不参与管理、不被阻塞等待 sediment",**不要求 sediment 对用户不可见**（footer / notify 状态指示正常运行，并不违反）。
3. **Lane C 每个 draft 独立 try/catch** @ index.ts:1810-1821——一个 candidate crash 不 kill 其他 candidate。好的隔离设计，保留。
4. **`scheduleDrainIfBacklog` recursive drain loop** @ :823——bg 完成后递归检查新条目积压。适合挂接 aggregator scheduler 但目前只 drain auto-write。

**这对 ADR 0024 的含义**：六能力点的所有新 hook **必须考虑两条 lane**——主动纠错识别可能由 Lane A 显式触发（用户在 MEMORY: fence 里写"忘掉 X"）或 Lane C 隐式触发（自然对话里说"忘掉 X"由 extractor 提取）；outcome self-report 必须挂在主会话 LLM 的 response 流（不属于 Lane A/C/G 任一条）；archive 反证检测需要在 Lane C 里跑。

### 1.2 七区 layout + 现有 staging + memory_search corpus

七区硬编码 @ `extensions/abrain/brain-layout.ts`（identity / skills / habits / workflows / projects / knowledge / vault）；`ZONE_META` 是 documentation-only，运行时以 writer enum + 局部 router 为准。**`always vs listed tier` 在 brain-layout 没有代码模型**（该语义属 ADR 0028 rules 子系统）。

**现有 staging 不是 v1 §1.4 设想形态**：真实存在的是 `projects/<id>/observations/staging/`（Lane G project-local，memory_search 已显式排除）；v1 设想的 sidecar `~/.abrain/.state/sediment/staging/` 全代码不存在。→ §4.1 staging 写入有两选项：(a) 复用现有 project-local staging；(b) 新建 sidecar（§4.1.5 决策）。

memory_search corpus = abrain project → world `~/.abrain/`（排除 projects/vault）→ legacy `.pensieve/`，默认 exclude archived；实现已是 ADR 0015 两阶段 LLM rerank（老 BM25 路径 dead code）。

### 1.3 sanitizer / audit / git-sync 真实形态

**sanitizer @ `extensions/sediment/sanitizer.ts`**：14 类 deterministic regex（PEM / 各家 API key / JWT / AWS / connection URL / bearer / slack / google / stripe / generic+short secret assignment / unicode-bypass 整行 redact），唯一 export `sanitizeForMemory()`，**无 LLM 升级 hook**——所有新 LLM 调用必须先过它（§3.1 A' 层硬约束）。已知误 redact 风险：用户讨论 key pattern / PEM/JWT 示例可能被整段 redact 而让 classifier 看不到语义（§3.2.B 评估是否升级混合方案）。另有 `extensions/abrain/redact.ts`（服务 git-sync/prompt_user/vault/audit，职责不重叠）。

audit @ `writer.ts` 已含丰富字段（candidates / results / `curator.decision.rationale` 自然语言 / stage_ms / background_async）；**缺的不是 reasoning trace 整体，而是 6-step structured trace**（quote / alternative / disconfirmer / downgrade / commit / self-critique）。`appendAudit` 分三个输出点（writer 主入口 + about-me/world + git-sync），统一与否 R2+ 决策。

git-sync @ `extensions/abrain/git-sync.ts` 已 transport-only（push / fetch-FF / sync，冲突走 git 3-way merge 不走 LLM，无 origin 跳过、失败不抛）。**已知 gap（ADR 0027 C2' 依据）**：sediment writer 自己的 `gitCommit()` 没接入 git-sync singleFlight，可能跟 auto-merge 抢 `index.lock`。本 ADR 不修，但 §5 必须承认它存在。

### 1.4 现有反模式 + auto-write 退路

ADR 0024 §4.2 反模式表中的显式入口（`MEMORY-*` 围栏、`/about-me`、用户主动跑 self-improve）在过渡期仍可作为兼容路径存在，但它们不是目标体验，也不应成为用户日常管理大脑的主路径。

`autoLlmWriteEnabled` 是产品化 rollout / 回滚开关，不是架构正确性的来源。本 ADR 只规定两点：

- 默认体验应逐步走向自然对话 auto-write，而不是要求用户手动维护记忆。
- 必须保留 `false` / `"staging-only"` 这类可逆退路，使高风险写入能力出现系统性误判时能降级到观察模式。

**这对本 ADR 的含义**：

- 反模式 deprecation（§5.4）只能在自然对话写入路径稳定、可诊断、可回滚之后进行。
- `current-state.md` 记录当前默认值与已落地行为；本 ADR 只记录为什么需要 auto-write 目标态和回滚模式。
- 用户能看到 footer / notify / audit 等运行状态反馈，但不应被要求为了 sediment 做管理事务。

### 1.5 ADR 0003 主会话只读现状：其实已经开了几个口子

**主会话 LLM 注册的工具** @ `extensions/abrain/index.ts:1411-1417` + `:1668-1678`：

- `vault_release(key, scope?, reason?)` — 高价值数据明确授权（用户在每次 release 时审批）
- `prompt_user({ reason, questions[] })` — 任务相关具体决策（ADR 0022 contract）

**`/secret set` slash command** @ `extensions/abrain/index.ts:2324`、`:2404` 调 `writeSecret` / `forgetSecret`——这是**用户走 vault 写路径**（不是直写 brain）。

**这意味着**：主会话只读的 sandbox 边界其实**已经被开了几个口子**：

- vault 写路径走 `vault_release` + slash command + 用户授权
- prompt_user 写路径走任务决策（不写 brain）

也就是说 "主会话 LLM 不能调任何写工具" 这个表述**当前已经不严格**。ADR 0003 真正护住的是 "不能直接写 brain entry"，不是 "不能调任何写类工具"。

本 ADR §3.2 / §5.2 把 ADR 0003 列为 B' 层（跟 ADR 0024 设想有内在张力）。三选项分析（保留 / 部分放松 / 彻底重设计）里的 "部分放松" 不是前所未闻——vault 已经开过同类型的口子了。

### 1.6 prompt 基础设施缺位

| 配套设施 | 现状 | 对本 ADR 的含义 |
|---|---|---|
| 配套能力 | 设计要求 | 对本 ADR 的含义 |
|---|---|---|
| `promptVersion` 字段 | prompt 版本必须进入 settings / audit / quality trace | §4.5 classifier prompt 演进需要可追踪版本边界，避免新旧 trace 混读 |
| classifier 输出 zone/tier/op | 主动纠错路径必须产出可路由的结构化信号，而不是依赖 extractor 偶然产 draft | §4.1 是 0→1 的新分类能力，不是现有 extractor 小修 |
| multi-view 跨 provider 注册 | reviewer 选择必须支持跨 provider / fallback / 空配置健康提示 | §4.4 不能把业务模型 ID 固定在源码默认值里 |
| evidence-first 推理轨迹 | classifier / reviewer 需要 quote → claim → alternative → uncertainty → resolving evidence 的可审计结构 | §4.1 / §4.4 的 prompt trace 是质量反馈，不是机械 gate |
| `outcome_history` 台账 | outcome 数据走独立 sidecar ledger，不进 entry frontmatter 热路径 | §4.2 闭合使用反馈，同时避免污染条目本体 |
| staging-loader | staging 是 sediment-controlled triage 队列，不应混入 `memory_search` corpus | §4.1.5 staging 时间戳与 resolve 生命周期独立于 checkpoint |

Settings 配置面应服务这些能力的可观测性、回滚和模型路由；具体字段是否已存在由 `current-state.md` 与代码记录。

---

## 2. ADR 0024 与现实的 gap 分析

### 2.1 四 invariant 在代码里的覆盖度

| invariant | 代码覆盖 | 评估 |
|---|---|---|
| INV-INVISIBILITY（管理负担） | △ 部分 | Lane C fire-and-forget @ `index.ts:1035` 不阻塞主会话（✓）；sediment 不问用户审批（✓）。但 `/about-me` slash + `MEMORY-ABOUT-ME:` 围栏仍要求用户主动声明（反模式），过渡期保留 |
| INV-INVISIBILITY（运行状态指示） | ✓ | footer / notify / audit 正常运行让用户明确感知大脑在工作 —— 2026-05-24 误删后已恢复。注意这两行不是独立 invariant,是 INV-INVISIBILITY 一体两面：管理负担隐身 + 运行状态可见。 |
| INV-AUTONOMY | △ 部分 | `prompt_user` 仅用任务决策（OK，ADR 0022），但 `/about-me` 让用户做元工作 violates；`autoLlmWriteEnabled` 默认 false 也让用户做"手动启用整个设想"的元工作 |
| INV-IMPLICIT-GROUND-TRUTH | △ 部分 | sediment 已读 conversation window 作为隐式信号（OK），但**最关键的隐式信号——用户接受/修改/拒绝 LLM 输出——完全没有仪器化**。用户接受了 yarn 的建议 = 用户至少不排斥 yarn；用户改了 pnpm 的 import = 用户偏好 pnpm。这个信号比主动纠错更频繁、更细粒度，但当前 classifier 只产 kind/status/confidence，没有任何 acceptance/rejection 信号产出。R10 三方审计都指出来了。0025 §4.2 outcome self-report 部分覆盖了"entry 用没用"，但不覆盖"LLM 的建议被用户接受/修改/拒绝了"——这是两个不同的信号维度 |
| INV-ACTIVE-CORRECTION | ✗ 未实现 | extractor + curator 没有任何 active correction 识别；用户说 "以后用 X" 完全依赖 LLM 偶然把 `status` 字段理解对，没有 6 步推理、没有 disconfirmation、没有 bias cautions |

### 2.2 六能力点：现实 baseline

六能力点的现实 baseline 几乎都是 0：主动纠错识别 / outcome self-report / 跨会话 aggregator / multi-view verification（含 multi-provider 配套）/ classifier prompt 演进配套都是**整条缺失**；静默归档**半条**（soft delete 在，缺 N 天窗口 + 反证检测 + reactivation reviewer）。

### 2.3 §6 接受代价跟现状的兼容性

ADR 0024 §6 列 9 条代价。逐条评估：能力点上线前**实际只有 1（跨设备错误传播，git-sync 已在）/ 4（最终一致延迟）/ 9（LLM 失败本底）真正存在**；2/3/5/6/7/8（假高置信、归档误删缺回滚窗、偏差累积无 aggregator、纠错疲劳、multi-view 翻倍成本、早期推理参差）都是对应能力点上线后才出现的代价。**§5 每个能力点上线时必须显式承认它引入的新代价。**

---

## 3. 设计约束分层

本节合并 v1 §0.5 + §0.6 + 基于 §1 代码现实刷新。**三层不再是"安全 vs 架构"二分**（v1 R1.1 错），而是 **结果 / 现有机制有张力 / 纯架构选择**。

### 3.1 A' 层 — 结果约束（不可破，机制可换）

下面两条是结果不可破。机制可换。本 ADR 任何能力点都不能破结果。

| 结果 | 当前机制 |
|---|---|
| raw secret / credential 不出 sanitizer 屏障到 LLM context / audit / memory / git blob | `extensions/sediment/sanitizer.ts` 14 类 regex（§1.3） |
| vault 明确授权外不自动 release | `extensions/abrain/vault-reader.ts` + 用户授权 `vault_release` + `/secret set` slash + UI 弹窗 |
| staging 里的 provisional hypothesis **不能**在没有 multi-view 审查的情况下自动升成 durable entry。**例外**（R1 P1-6 补补）：§4.1.4 对 `durable, confidence < 8` 走 curator 直写不走 multi-view 是本表克隆出来的明确例外路径——不是“隐式破例”而是§4.1.4 「⚠️ conf<8 盲区」明确接受的 blast radius（conf<8 是多数 correction 分布区间，走 multi-view 成本爆炸）。P1 原型验证 conf<8 误判率，高于阈值时临时纳入 multi-view 或提升直写门槛。**本表这一行只限 staging 路径**；curator 直写路径不受本表约束 | §4.4 multi-view verification。这条放在这里是硬性规定：staging 升格前必须过一道跨 provider 双审。如果 multi-view 挂了或没启用，provisional 只能保持 staging 或 age-out |

机制层可以为 ADR 0024 设想演进——例如 sanitizer regex 可升级为 regex + LLM 混合（详 §3.2.B），vault 机制细节（age 加密 / passphrase / 跨设备 sync）跟本 ADR 无关。

### 3.2 B' 层 — 现有机制跟 ADR 0024 有内在张力（R2+ 明确评估）

下面三项是 "安全 / 正确性低层联动不严重，但机制本身跟 ADR 0024 有内在张力"。R2+ 必须 explicit 评估 "保留 / 重设计 / 在本 ADR 场景下特例"。

#### 3.2.A ADR 0003 主会话只读

**v1 R1.1 走过弯路**：当时把 ADR 0003 一刀切归为 "A 层不可破"。回头看这个判断错了。

**正确认识**：ADR 0003 是 ADR 0024 之前定下来的架构选择，跟 ADR 0024 设想有根本性的张力。

**三个冲突点**：

1. **latency / friction 违反 INV-ACTIVE-CORRECTION**——用户说 "忘掉那条" 跟 "用 React 不用 Vue" 性质一样，零延迟期望。但 ADR 0003 强制路径：主会话 LLM 不能直接 mutate brain → 信号交给 sediment sidecar → agent_end 跑 → 几轮后才生效。用户感觉大脑反应迟钝。
2. **outcome self-report 设计妥协**：ADR 0024 §5.2 + R7 audit DeepSeek 强调最高信噪比是 "当时干活那个 LLM 本人交代"。但 ADR 0003 强制主会话 LLM 不能直接写 outcome ledger → v1 R1 §3.3 退而求其次选方案 C（主会话附带 `memory-footnote`，sidecar 解读写 ledger）。这是结构妥协；footnote 可见本身不是问题，属于 ADR 0024 §2 允许用户感知大脑工作的健康反馈。
3. **防御目标重叠**：ADR 0003 防 "LLM 被 prompt injection 写错 brain"；ADR 0024 §3 AI-Native + §5 multi-view + ADR 0016 LLM curator + A' 层 sanitizer 也在防同一件事。R7 audit 21/21 PE-form 是正面证据 AI-Native + multi-view 体系能防这一类。两套机制叠加本身不是问题，但其中一套破坏 ADR 0024 设想、另一套又能提供同等保护时，应该重审这一套是否多余。

**§1.5 给的现实**：主会话只读边界其实已经被开了几个口子——`vault_release` / `prompt_user` / `/secret set` 都是主会话 LLM 能调的写类工具（vault 写、用户决策捕获）。所以 "全无写工具" 这个表述在现实里已经不严格。新加 `brain.supersede` / `brain.note` 之类的工具不是前所未闻。

**三个 R2+ 处理选项**（详 §5.2 决策点）：

| 选项 | 内容 | ADR 0024 适配 | 安全代价 | 工程量 |
|---|---|---|---|---|
| 1（v1 默认） | 保留 ADR 0003 + 接受 latency；outcome 走方案 C `memory-footnote` + sidecar ledger | 中 | 最低 | 低 |
| 2 | 部分放松——主会话 LLM 在 active correction / outcome 场景下可调 `brain.*` 工具，**工具内部仍走 sediment writer + multi-view + audit** | 高 | 中（依赖 AI-Native + multi-view 替代 sandbox） | 中-大 |
| 3 | 彻底重设计——没有 "主会话 vs sediment" 二分；主会话 LLM 本身就是 sediment 在任务对话中的化身；ADR 0003 / 0010 / 0013 同步重写 | 最高 | 高 | 大 |

#### 3.2.B ADR 0018 sanitizer 当前 regex 实现

**结果保留在 A' 层**。**机制有张力**：

§1.3 列举的 14 类 regex 在 active correction 语义讨论场景下会误 redact（"我的 API key 配置遵循 sk-xxxx pattern" → `[SECRET:openai_api_key]`），违反 INV-IMPLICIT-GROUND-TRUTH。

**三个处理选项**（R2+ 决策）：

| 选项 | 内容 | 优势 | 劣势 |
|---|---|---|---|
| 1（v1 默认） | 保留 regex sanitizer + 接受误 redact 损失部分 active correction 信号 | 机制简单、保证不漏过 raw secret | active correction 误识别率上升 |
| 2 | 升级为 LLM-based sanitize（让 LLM 判断 "是真 secret 还是讨论 secret pattern"） | 跟 AI-Native 一致、语义准 | LLM 误判可能漏过 raw secret → 破 A' 结果 |
| 3（推荐） | 混合：regex 作底（保 A' 结果不漏过 raw secret）+ LLM advisory（对 regex 拦截的区间重新判断 "是语义讨论吗"，是的话恢复原文给 classifier，原 redact 仍在 audit / git） | 结果安全 + 信号不丢 | 机制复杂、LLM 错判仍存在但可避免漏过 |

**当前 sanitizer 完全不支持选项 2/3 的 hook 点**——需要新接口暴露 "每个 redaction 的原文偏移 + 模式名"。

#### 3.2.C `/about-me` 反模式 + Lane A/G fence 反模式

§1.4 显示 `/about-me` slash command 已经存在 @ `index.ts:2244`，`MEMORY:` / `MEMORY-ABOUT-ME:` fence 是 Lane A/G 当前实现。**跟 ADR 0024 §4.2 反模式表三项直接冲突**。

**处理路径**：

- **不能立刻删**——`autoLlmWriteEnabled` 默认 false 时，fence 是用户当前唯一的显式记忆入口
- **ADR 0024 设想跑起来 + 默认开启之后** 才能废弃（§5.4 同步反向 patch ADR 0024 §4.2 加废弃时间表）
- **过渡期间**`/about-me` 降为 "高级用户诊断入口"，从 `/help` quickstart 文案中抑制出现（同 §4.3 "高级用户诊断入口" 处理）

### 3.3 C' 层 — 纯架构选择（可为 ADR 0024 重新设计）

下面六项是纯架构选择。R2+ 在能力点详细设计时根据 "跟 ADR 0024 设想多契合" 自由重设计 + 同步反向 patch 下游 ADR：

| 架构 | 现状 cite | R2+ 重设计可能形态 |
|---|---|---|
| ADR 0014 七区 layout | `brain-layout.ts:28`（硬编码 7 zone）+ `ZONE_META` documentation-only | 重组 zone（如 staging 升格为正式区 / 新 zone 表达 confidence-tiered preferences） |
| ADR 0015 memory_search corpus / ranking | `parser.ts:120-172` corpus 三源 + `llm-search.ts:340-548` 两阶段 rerank | 扩展 corpus 含 staging / outcome-ledger / aggregator hypothesis |
| ADR 0016 curator 7 op | `curator.ts::parseDecision:220-360` 全部落地 | 新增 op（`promote-to-staging` / `reactivate-from-archive` / `defer` / `accept-provisional`） |
| ADR 0020 transport-only sync | `git-sync.ts:4-24` + `pushAsync` fire-and-forget | staging / durable / outcome ledger 不同同步语义（如 staging 不立刻 sync 等 resolve 后才 sync） |
| ADR 0023 R4 unified classifier 合并 | sediment 这边 **完全不存在**（§1.6 现实纠正） | 三种形态都是 0→1：单一 unified call / 全拆 4 个独立 call / 中道（zone+tier+op 一个 + correction 独立） |
| 现有 sediment write loop（两 lane） | `index.ts:554-1271` + `writer.ts:1065-2069` + `curator.ts:616` | 重写为 active-reflection-agent 原生结构（不挂接 hook 而重设两条 lane） |

### 3.4 工程量评估（基于 §1 代码现实）

| 项 | 改 vs 不改 | 工程量 | 反向 patch 下游 ADR |
|---|---|---|---|
| sediment 两条 lane 新挂载点 | 改（每条 lane 都加 hook） | 中 | — |
| 主动纠错 prompt（§4.1） | 新加（0→1） | 大（含 220 行 prompt + correction-pipeline.ts + staging schema） | ADR 0023 R5 |
| outcome self-report（§4.2） | 新加（依 §5.2 ADR 0003 选项） | 中-大 | ADR 0003（如选 2/3） + ADR 0014（如 outcome ledger 进 frontmatter） |
| aggregator scheduler（§4.3） | 新加 | 中 | — |
| multi-view 配套设施（§4.4） | 新加（含 multi-provider 注册表 + rate-limit 处理 + fallback 降级） | 大 | —。R9 audit 两家独立指出这个 "大" 可能还低估了——从单 provider deepseek 加完整的跨 provider 体系涉及 settings / curator / extractor / index / audit 五个文件的改动，实际接近 "大+" |
| `promptVersion` 配套字段（§4.5） | 新加 settings + audit 字段 | 小 | — |
| 静默归档 N 天窗口（§4.6） | 扩展现有 soft delete | 中 | ADR 0020（如 archive_at 跨设备） |
| `autoLlmWriteEnabled` 默认改为 true | 一行 settings 改动 | 极小（但需实际跑一阵的数据支撑） | ADR 0024 §6 同步明确承认 |
| `/about-me` 反模式 deprecate | slash command + Lane G fence 移除 | 小（含 migration 文案） | ADR 0024 §4.2 timeline |
| ADR 0018 sanitizer 升级混合（§3.2.B） | 改 sanitizer 接口 + 加 LLM advisory | 中-大 | ADR 0018 |
| ADR 0003 部分放松（§5.2 选 2） | 注册新工具 `brain.supersede` etc. | 中 | ADR 0003 |
| ADR 0003 彻底重设计（§5.2 选 3） | 主会话 LLM = sediment 化身 | 大 | ADR 0003 / 0010 / 0013 |

---

## 4. 六能力点架构设计

### 4.1 主动纠错识别（前置能力）

#### 4.1.1 为什么是前置

INV-ACTIVE-CORRECTION 决定其他五条能力的输入质量：

- §4.2 outcome self-report 要知道 "用户在 task 里反馈了什么" → 需要主动纠错识别
- §4.3 aggregator 看跨会话趋势 → 需要先识别每个会话里的纠错信号
- §4.4 multi-view 触发条件之一是 "主动纠错相关的归档" → 需要识别
- §4.6 静默归档反证检测 → 需要识别用户是否在自然对话里 "重新启用旧偏好"

**本能力点必须作为前置能力优先具备**——其他五条都依赖它提供可靠输入。

#### 4.1.2 触发条件 + 输入输出 schema

在 `agent_end` hook、Lane C curator op 决定之前插入。所有 `agent_end` 都跑——不预筛选（与 ADR 0024 §3.3 "几个典型机械形态" 对齐：classifier 不靠预筛选阈值，靠 prompt 引导）。

**Lane A / G 是否也跑 classifier**：是。Lane A/G 是用户显式 fence 写入但**内容本身可能含主动纠错语义**（如用户在 `MEMORY:` fence 内写 "忘掉旧的 yarn 偏好"）。Lane A/G 命中 classifier 后，把识别结果作为额外 metadata 附加到 fence 写入路径，不阻断 Lane A/G 同步落盘。

**⚠️ 所有新 LLM 调用都必须先过 sanitizer**（这是 §3.1 A' 层的结果约束，不准商量）：classifier 拿到的 `packed_window` 在送进 LLM 之前**必须**走一趟 `sanitizeForMemory()`——跟现有 `llm-extractor.ts:148` 同款路径。不管 classifier 是挂在 Lane C 还是 Lane A/G，这个 sanitizer 入口是硬性的。不是"建议"，是"不过 sanitizer 不准调 LLM"。这等于把 §1.3 那个 14 类 regex 堵门原样搬到新 classifier 的输入边界上。

**Input** `ClassifierInput`：conversation_window（完整不预剪）+ recently_loaded_entries + related_entries（memory_search 召回）+ staging_context（K 条）。

**Output** `CorrectionSignal`：user_quote + surrounding_context + three_readings{durable/task_local/debug} + initial_lean/disconfirmer/downgrade_applied + typing + scope_description/correction_intent（**自然语言非枚举**）+ confidence + most_likely_error_{direction,reason}（必引 step-1 quote）+ reasoning_quality（仅 audit）+ target_entry_slug/resolution_hypothesis。完整 TS 定义以实现代码为准。

#### 4.1.3 prompt 契约（规范源 = prompt asset，正文不内嵌）

production 规范源：`extensions/sediment/prompts/active-correction-classifier-v2.md` +
`extensions/sediment/prompts/reasoning-normalization-preamble-v1.md`（与 §4.4 multi-view 共用）。
ADR 正文**不内嵌 prompt 全文**——内嵌副本会与 asset 各自演进而 drift（本节即是活样本：早期内嵌文本停在
step-7 数字自评 / `LEAN-DECLARATION` 旧名，asset 已迭代到 v2 并加入 `is_directive` 检测与保守默认）。
本节只声明 prompt 必须满足的决策约束；逐字 prompt 以 asset 为准。

prompt 必须满足的约束（改 prompt 时不可破坏）：
- **reasoning 规范化前导**：推理轨迹固定为 quote → claim → alternative → uncertainty → resolving evidence，
  让 §4.4 multi-view 能跨基座（Claude/GPT/DeepSeek）对齐比较。
- **四读强制**：对 {durable, task-local, debug, NOT-A-CORRECTION} 各给最强一句论据；NOT-A-CORRECTION 必选，
  它更强则返回 null 退出——**返回 null 是成功运行，不是偷懒**。
- **证伪 + 降级**：先找最能推翻当前倾向的单条观察，按其攻击 durability / scope 决定是否降一档；浅搜且无证伪一律降一档。
- **保守默认**：durable vs task-local 不确定 → task-local；纠错 vs 普通任务指令不确定 → `signal_found=false`。
- **bias 自检**（产出前）：post-hoc 合理化 / sycophancy / 锚定既有 entry / 过度提取 / recency / provisional-as-fact /
  指令 vs 纠错 / 中英 code-switch 直译误伤。
- **scope / intent 为自然语言自由文本，不是 enum**。
- **staging provisional 是未确认假设**：不得当确证证据；单独任务逐条判 resolve / age / refute，resolve 必须并排引用
  staging 假设与新 utterance + 反锚定自检。
- **resolution_hypothesis**：durable 但找不到归属 entry 时写自然语言假设入 staging（去重后）；task-local / debug 不入 staging。

输入 `ClassifierInput` / 输出 `CorrectionSignal` schema 见 §4.1.2。

#### 4.1.4 三种语义的处理路径

| typing | 处理 | 写到哪里 |
|---|---|---|
| **durable**，confidence ≥ 8 | 高价值 → 走 §4.4 multi-view → 通过后 update existing entry / create new entry | curator 按 ADR 0023 R5 unified classifier 路由到 zone（identity / habits / skills / 项目 rules） |
| **durable**，confidence < 8 | 中价值 → directly update entry via curator（不走 multi-view） | 对应 zone |
| **task-local** | 不进 sediment 永久区，但**代入同会话后续 agent_end 的 curator context**（session-local working set） | 不持久化；session 结束清除 |
| **debug** | 不进任何持久区 | 仅 audit.jsonl 记一条 |

**复杂语义由 `scope_description` 承载**：scoped durable / identity declaration / negation 都不强填三类。typing 只是 confidence routing primitive，复杂语义全部走 `scope_description` + `correction_intent` 两个自然语言字段。

**升级路径**（task-local → durable candidate）：不走机械 N=2 阈值。Aggregator（§4.3）读多次 task-local 证据，**由 prompt 引导**判断是否提出 durable candidate："为什么这可能仍不是 durable / 未来两周什么会证伪" 写出后再提 candidate。

**不确定时的默认**：偏向 task-local（避免污染 durable 区）。

**⚠️ conf<8 的盲区**：conf<8 的 durable 输出直接走 curator 直写，没有 multi-view 审查。R10 审计指出这是"最大的 blast radius"——分类器把一句闲聊误判为 conf=6 的 durable correction，直接绕过所有保护层写入。大多数 correction 落在 conf<8 这个区间（真正高置信的很少），但恰好是这个区间没有任何独立验证。P1 原型验证时会专门测这个区间的误判率。如果原型发现 conf<8 误判率高，考虑临时把直写门槛提到 conf=7 或加一条 staging-only 中间路径。

#### 4.1.5 记忆归属处理（找不到对应 entry 时）

当 step 5 的 `target_entry_slug` 为 null 但 typing 是 durable（或升级的 durable candidate）时，**写一条 provisional staging entry**。schema 关键字段：`status: provisional` / `kind: provisional-correction` / `attribution_pending: true` / `originating_device`（跨设备辨识）/ `_provenance_warning`（**这是 classifier 猜测：后续 classifier 不得当 ground truth、不得引为用户偏好、不得指导任务行为；唯一合法用途是 resolve 或 let it age**）/ `hypothesis`（自然语言）/ `source_utterance[]`（quote+context+captured_at+device）/ `suggested_resolution_paths` / `age_signal`（**age 不是 TTL**，`days_since_creation` 每次 classifier 读时计算）。

**staging 路径选择**（§1.2 现实给出两选项）：

- 选项 P：复用现有 `projects/<id>/observations/staging/`（已存在 + memory_search 已 exclude，但当前只用于 Lane G）
- 选项 S：新建 sidecar `~/.abrain/.state/sediment/staging/`（v1 §1.4 设想，跟 checkpoint 同父目录但语义独立）

**推荐选项 S**：理由 (1) sediment-controlled staging 跟 Lane G project-level staging 语义不同（前者是 classifier hypothesis，后者是 LLM extracted observation 等待 curator）；(2) staging-loader 实现独立，不污染 memory_search corpus / Lane G 路径。但 R2+ 评估 token / 工程量后定。

**staging-loader**（新文件 `extensions/sediment/staging-loader.ts`）：

- 每次 `agent_end`、classifier 调用前，按 (a) 语义相关性（当前会话主题 vs staging hypothesis）+ (b) 最老 K 条 pending-queue 两个源拼提 staging 条目作为 `staging_context`
- K 由 token budget 决定（预计 5-10）
- **不走 `memory_search` corpus**——staging 不污染主会话 memory_search
- **怎么做到 "语义相关性"**：R2 评估两个方向。方向 A：全文 keyword + slug/title 模糊匹配（零 LLM 成本，但只能做字面匹配，用户说的 "忘掉 yarn" 匹配不到 slug 是 "prefer-pnpm" 的条目）。方向 B：每次 agent_end 跑 staging-loader 时多加一次轻量 LLM 调用（"这个 staging hypothesis 跟当前会话主题相关吗？yes/no + 1 句理由"），token 成本低但实时性强。**建议起点是 B**——因为 D 点靠 keyword 找不到对应 entry 的 staging hypothesis 永远不会被 resolve，等于白存。如果跑下来成本太高再降成 A。

**30 天 age-out**：超 30 天未 resolve 的 staging 走 archive-reactivation-reviewer prompt（与 §4.6 同 prompt）判断 archive / keep aging / promote to durable。**软归档判断走 prompt decision**（不是机械 TTL）；硬删除窗口（`git rm` 后 git history 仍可恢复）仍是文件 lifecycle，允许机械（同 ADR 0024 §5.6）。

**staging 膨胀监控**：classifier 可能倾向 produce 很多 provisional hypothesis。如果 staging 在 30 天内堆到 100+ 条，K=5-10 的 staging-loader 一大部分条目永远不会被选中→永远 resolve 不了→age-out 时批量扫上百条的 token 开销很大。这条警告写进 §4.3.3 Classifier Health Meta-Check——当 staging 目录文件数超 50 或月增长率超 30 条时，自动在 audit 里写 advisory flag，作者回来看。这是一个轻量的 Infra 兜底（数文件数不用 LLM），不搞机械 hard cap 但留个信号。

**跨设备 staging 同步**：设备 B classifier 看到 `originating_device != current_device` 且当前 context 无关 → prompt 引导默认 "wait for next session on originating device"，不强行在设备 B resolve。

##### 4.1.5.1 staging resolve 触发机制

classifier 被动检查 `staging_context` 不够（多数 staging 进不了检查 → 30 天 age-out 时批量扫上百条）。resolve 触发三选项：① **隔 N 轮批扫（默认 N=20）**——staging 被看到期望从 30 天降到 1-3 天，成本可控；② **lazy**（classifier 遇到相关才 resolve，最低成本但不相关 staging 永不 resolve）；③ **每轮全扫**（延迟最低但成本不可接受）。**默认①，② 作 fallback**；`promote_candidate` 不直达 durable，必须走 advisory / reviewer，避免 attribution 不足的 hypothesis 被机械提升。

#### 4.1.6 跟两条 write lane 的接口

新文件：`correction-pipeline.ts`（classifier + resolver）、`context-packer.ts`、`staging-loader.ts`、`staging-types.ts` + prompt assets。改动现有文件：`index.ts` Lane C（`runLlmExtractor` 后、`curateProjectDraft` 前调 `correctionPipeline.handle()`）+ Lane A/G（fence 解析后也跑 classifier，不阻断同步落盘，结果入 audit metadata）；`curator.ts::curateProjectDraft` 加 `context: CorrectionSignal | null`；`writer.ts` 接受 sidecar staging + audit 加 `prompt_version`/`correction_signal`；`settings.ts` 加 classifier model / staging 配置。

数据流：`agent_end` → context-packer → staging-loader → extractor → `correctionPipeline.handle`（classifier 产 `CorrectionSignal`：durable&conf≥8 入 §4.4 multi-view / durable&conf<8 入 curator context / task-local 入 session working set / debug 仅 audit / 无归属 durable 写 provisional staging）→ curateProjectDraft → writer.commit（atomic + git + audit 含 correction_signal）。

### 4.2 outcome self-report

#### 4.2.1 对应 ADR 0024 §5.2

ADR 0024 §5.2。核心思想：不让 curator 旁观猜测——真正知道 entry 有没有用上的是当时干活那个 LLM。在 `agent_end` 注入 prompt 让原始 LLM 第一人称交代 DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED + counterfactual quote。

#### 4.2.2 谁来跑：三选项 A/B/C 跟 §3.2.A ADR 0003 决策联动

| 方案 | 描述 | ADR 0003 要求 |
|---|---|---|
| A | session 最后一轮 prompt 原始 LLM self-report + 直接写 outcome ledger | §3.2.A 选项 2/3 ADR 0003 放松 |
| B | `agent_end` 启独立 sidecar LLM 读 transcript + entry 列表后 self-report | §3.2.A 选项 1 兼容 |
| **C** | 原始会话 LLM 每轮附带 `memory-footnote` 自我报告，sediment 在 `agent_end` 汇总；该 footnote 可见，属于“让用户感知大脑参与”的健康反馈，不要求用户管理 | §3.2.A 选项 1 兼容 |

**§3.2.A 选项 2/3 重新让 A 进入候选**——v1 R1 选 C 是被 ADR 0003 逼的；R1.2 识别出 ADR 0003 是张力不是不可破；§3.2.A 又识别出 vault_release / prompt_user 已经是开口子的先例。R2+ 走 multi-LLM audit 重新评估 A/B/C 三方案。

**默认起点选 C**（保守路径）：

#### 4.2.3 方案 C prompt skeleton（默认起点）

prompt 契约（逐字以 extension 注入文本为准，正文不内嵌）：主会话 system prompt 注入 `memory-footnote` 协议——
每次有 memory entry 进入推理上下文后，在回复末尾对每条标 `decisive` / `confirmatory` / `retrieved-unused` +
counterfactual；`decisive` 必须能引出“没有这条会做的不同动作”，否则降为 `confirmatory`；footnote 可见但不要求用户审阅。
该协议由 memory/sediment extension 在 session 注入（与本会话顶部 memory-footnote 区块同源），ADR 不复制全文以免 drift。

sediment 在 `agent_end` 从 response stream 提取 `memory-footnote` fenced block → outcome-collector 汇总 → 写 outcome-ledger（独立 sidecar，不进 entry frontmatter）。

**关键 bias caution**：outcome LLM 也是 RLHF 训练的，"yes used it" 是 helpful answer。Prompt 引导："Am I marking DECISIVE because I genuinely couldn't have made this decision without the entry, or because saying 'yes I used it' feels helpful? If I cannot quote a counterfactual action I would have taken otherwise → mark CONFIRMATORY not DECISIVE."

**footnote 丢失怎么办**：`memory-footnote` 位于 response 末尾——如果用户发了下一条消息前 LLM response 还没走完（被截断）、或者 session crash、或者 LLM 忘了写，sediment 在 `agent_end` 汇总时就看不到某些 entry 的 footnote。分三种情况处理：

1. **没调的 entry 没写 footnote**：正常——sediment 无法区分 "没调" 和 "调了但忘了写"，保守处理当 "没调"。
2. **调了但 footnote 格式错**（fence 不完整、JSON 解析失败）：写进 audit 一条 `outcome_footnote_parse_error`，不猜测内容，不写 outcome-ledger。
3. **session crash 导致整批 footnote 丢失**：不尝试事后补——事后补的意思是让另一 LLM 读 transcript 猜测 "用了没"，这就变成了方案 B 的事后旁观，等于退回到 ADR 0003 妥协的最差方案。丢了就丢了，下次 session 正常跑会自然产生新的 footnote。

这是一条很现实的设计取舍：**宁丢不漏**。宁可少收几条 outcome，也不要靠猜测补一条假的。

#### 4.2.4 outcome-ledger schema

独立 sidecar 文件 `~/.abrain/.state/sediment/outcome-ledger.jsonl`：

```jsonc
{
  "timestamp": "2026-05-23T...",
  "session_id": "...",
  "entry_slug": "prefer-pnpm-over-yarn",
  "used": "decisive",
  "counterfactual": "If this entry weren't in context, I would have suggested yarn add lodash; instead I used pnpm add lodash because the entry said the user switched.",
  "source": "memory-footnote",   // or "method-a-self-report" / "method-b-sidecar-llm"
  "prompt_version": "outcome-self-report-v1"
}
```

#### 4.2.5 跟其他能力点的依赖

- §4.1 unified classifier confidence 评估读最近的 outcome 记录（被纠错过的 entry 更不可信）
- §4.3 aggregator 跨会话比对 outcome 趋势
- §4.5 classifier prompt 演进要看 outcome 数据是否系统性偏差
- §4.4 multi-view 启用后可选择性抽样复查 outcome self-report 质量（防主会话 LLM sycophancy）

### 4.3 跨会话趋势观察（aggregator）

Aggregator 是 prompt-native skeptical historian：它读取 outcome、classifier health、multi-view watchdog 与结构化上下文，输出 advisory 而不是直接写 staging 或阻断写入。机械 fallback 只允许用于记录降级事实与维持 ledger 连续性，不能替代 LLM 的跨会话趋势判断。

#### 4.3.1 调度

定时任务（不在 `agent_end` 跑），频率 daily / weekly / monthly 三层窗口。每层窗口跑一次独立 prompt。

**挂载点**：复用 §1.1 `scheduleDrainIfBacklog` recursive drain loop @ `index.ts:823`——bg drain 完成 + idle 时检测 last_aggregator_run，决定是否跑。

#### 4.3.2 prompt skeleton

对应 ADR 0024 §5.3（持怀疑态度的史官 / 默认无发现即成功 / falsifiability / sycophancy 自检）。production 规范源：`extensions/sediment/prompts/aggregator-skeptical-historian-v1.md`。

#### 4.3.3 Classifier Health Meta-Check（附加任务）

每次 aggregator 跑完正常工作后，追加一段 prompt 让它审视最近 50 条 classifier audit trace：

- quote rate（含 verbatim quote 的比例）
- alternative mention rate
- concrete self-critique rate（不是 generic boilerplate）

任一维度 < 40% → 写 advisory flag 进 audit.jsonl，下次作者读诊断入口（§4.5）时看到。

**光看静态阈值不够**——如果 quote rate 从 95% 慢慢跌到 85%，不会触发 <40% 但跌幅本身值得关注。追加一条趋势检测：任一维度 7 天移动平均下降 ≥ 10 个百分点时也写 advisory flag（"classifier reasoning quality trending down"）。这条也是 prompt 里让 aggregator LLM 自己算的——给最近 50 条 trace 里前 25 条和后 25 条各算一个均值，比较差值。不要搞机械阈值逻辑。

#### 4.3.4 关键设计点

- 调度应带 debounce，避免每轮会话都触发跨会话历史分析。
- 窗口解释交给 prompt；infra 可提供最近 ledger/audit 切片，但不预先机械切分 daily/weekly/monthly 结论。
- Aggregator 只 emit advisory，不直接写 staging，不阻断 curator。
- 后台执行不能因主 turn 退出而丢失已开始的历史观察；失败时写降级记录，等待下一次自然重试。

### 4.4 Multi-view verification

#### 4.4.1 触发条件

- 置信度 ≥ 8 的 create
- 提升到 always tier 的 promote
- 归档高置信度 entry
- 跨区迁移（preferences → maxims）
- 用户主动纠错触发的 durable update（来自 §4.1）

#### 4.4.2 prompt skeleton

对应 ADR 0024 §5.4（两次独立 API 调用 / Blind Pass 1 / Reveal Pass 2 / anchor bias self-check）+ §4.1 reasoning normalization preamble（共用）。production 规范源：`extensions/sediment/prompts/multi-view-pass1-blind-v1.md` + `multi-view-pass2-reveal-v1.md` + `reasoning-normalization-preamble-v1.md`。

**两次独立的 API 调用是硬性要求**——一次调用里假装 "先 blind 再 reveal" 不可信。§6 已经接受 multi-view 翻倍成本。

#### 4.4.3 Devil's advocate 层

ADR 0024 §5.4 末尾承认 "跨基座仍有 RLHF 训练相关性"。为避免两个 reviewer 同方向错——Reveal Pass 2 末尾追加一段 devil's-advocate 自检：让 reviewer 以“不同模型族 / 不同 RLHF 的第三方”身份提出对共识的最强反对，判定 real risk → 降为 DEFER，strawman → 保留共识但记 audit。逐字以 `extensions/sediment/prompts/multi-view-pass2-reveal-v1.md` 为准。

纯 prompt-engineered 三拨 layer，不增加 API 调用（虚拟 reviewer）。

#### 4.4.4 跨 provider 策略（基于 §1.6 现实从 0 加）

**§1.6 给的现实**：extractor + curator 两个都是 deepseek 家单 provider。跨 provider 的配套设施完全没有。

**新增 settings** `MultiViewSettings`：`proposerProviders` / `reviewerProviders`（**业务模型 ID 在 settings，不硬编码进源码**）/ `fallbackProviders`（rate-limit / error）/ `costBudgetPerOpUsd`（soft budget，超 → DEFER）。

**最小可行策略**：可先使用静态 fallback 名单；完整策略再转为动态选择 + rate-limit 处理 + cost 预算。

#### 4.4.5 关键设计点（R3 必须解决）

- provider 失败 / rate-limit 时的 fallback graceful 处理
- **DEFER 后的归宿**：reviewer DEFER 时，默认写 staging，避免信号丢失；但 user-expressed Tier-1 指令是例外，应确定性提交 proposer 决策而不是进入 replay 队列，防止显式用户指令被 defer/retry 机制静默吞掉。非指令候选仍按默认写 staging。
- 成本预算：每个高价值操作翻倍 token 调用，预估每月成本（dogfood 校准）
- 两 reviewer 同方向错的限制：devil's advocate 部分缓解；明确接受局限（同 ADR 0024 §6）

#### 4.4.6 Replay 与降级路径约束

Multi-view 的降级路径不得 silent fall back 到 proposer 直写；否则会破坏 §3.1 A' 层对高价值 create / destructive op 的双审要求。

- Transient reviewer failure（reviewer unavailable、pass call failed、unparseable、deferred）默认进入 `multiview-pending` staging，等待 replay lane 重审。
- `deferred` 遇到 user-expressed Tier-1 指令时例外：显式用户指令应确定性提交 proposer 决策，不能被 replay 上限、stale cutoff 或 terminal path 静默吞掉。
- `confirm_pass1_not_synthesizable` 可保留 `op=skip`，因为 pass-1 schema 缺少可重放 rich payload，写 staging 会造成 dead-loop；后续若 pass-1 schema 扩展，应重新评估。
- Replay terminal path 应软归档不可继续处理的候选，保留可追溯性；只有 reviewer 主动决定 skip 的候选可以删除 staging 行。
- Replay 写脑必须与原 turn 走同一 op dispatcher；同一 candidate 不应因为进入 staging replay 而丢失写脑动作。
- `signal` abort 不消耗 retry budget；abort 时清理本轮新 staging，保留原候选 attempts。
- Replay 中重新计算不再触发 multi-view 的候选应 drop/audit，不允许回退到 proposer 直写。

详细 invariant 表与 state machine 属于审计材料，放入 `docs/audits/`，不并入 ADR 正文。

### 4.5 Classifier prompt 自身演进

#### 4.5.1 诊断入口

`/abrain audit classifier` 命令展示最近 N 条 classifier reasoning trace，标红 advisory flag。**只是诊断入口，不是用户日常工作流**。从 quickstart / `/help` 推广文案中抑制（同 ADR 0024 §4.3 高级用户诊断入口处理）。

#### 4.5.2 `promptVersion` 配套字段（基于 §1.6 现实从 0 加，必须与 §4.1 P0 同期上线）

settings.ts 加 `PromptVersionSubstrate`：每个 prompt（activeCorrectionClassifier / multiViewPass1/2 / outcomeSelfReport / aggregator / archiveReactivationReviewer）一个版本字符串。audit.jsonl 每条含 `prompt_version`（版本 + `_semantic_note`）+ `reasoning_trace`（step_1_quote … step_7_self_rating 的结构化轨迹）。

**为什么必须 P0 同期**：缺这些字段几周后 prompt v2 读旧 trace 会出现软 schema migration——audit reader 无法区分版本归属。

#### 4.5.3 跨 prompt 版本兼容

ADR 0024 §4.2 R7 加的 row "reasoning_trace 跨 prompt 版本兼容" 在这里落地：新 prompt 读旧 trace 时被 prompt 中的 `_semantic_note` 告知 "这是旧版 prompt 产出，提取 quote 和 uncertainty 即可，别套现在的 label"。

#### 4.5.4 不做的事

- **不**做月度自动 prompt diff job
- **不**做 LLM 自动改自己 prompt（闭环自我修改风险）
- **不**做 prompt accuracy threshold gate

人在 loop：作者发现 systematic blind spot → 手动改 prompt → 验证新 prompt 不引入回归用 fixture **仅供参考**，不是发布阻断 gate。

### 4.6 静默归档 + 回滚窗口

静默归档必须由 prompt-native reviewer 判断是否存在 live-use bridge；infra 只负责窗口、文件生命周期、锁与审计。`hard_archive_recommended` 可以先保持 audit-only，真正 `git rm` 必须等待 writer 侧 CAS/owner-aware release 能保证不会误删活跃条目。
#### 4.6.1 N 天窗口的具体值

建议 30 天，但需要 dogfood 验证。

#### 4.6.2 反证检测 prompt

N 天内 sediment 看到用户在自然对话里提到归档 entry 的内容时，让 curator LLM 判断 keep archived / reactivate。决策约束：区分“仅提及话题”与“正在重新使用该偏好”，提及不等于 reactivation；默认保持归档，只有 **live-use bridge**（用户当前任务正在应用该偏好且与 entry 内容一致）才恢复；判定须并排引用归档 entry 与当前 utterance。逐字规范源：`extensions/sediment/prompts/archive-reactivation-reviewer-v1.md`。

**默认偏向保持归档**——只有 live-use bridge 才恢复。

#### 4.6.3 git rm 时机

N 天窗口期间：`status=archived` 软删，文件保留。
N 天后：跑 archive-reactivation-reviewer prompt 最后一次判断 → 决定 reactivate / git rm。
git rm 后：文件从 working tree 删除，但 git history 仍可恢复。

**重要**：归档 entry **不进 memory_search corpus**（已有：`search.ts:12-16` 默认 exclude archived）。N 天软删窗口期间也不进，避免 classifier / curator 误把归档 entry 当作 active context。

#### 4.6.4 跨设备归档同步

ADR 0020 sync 处理 archive 中间状态：

- 加 `archive_at: <iso>` 字段（绝对时间，不是本地相对天数）
- 设备 A 归档 → sync 到设备 B → 设备 B 的 N 天窗口续 archive_at + 30d，**不 reset**

**反向 patch ADR 0020**：sync schema 加 `archive_at` 字段语义说明。

#### 4.6.5 跟现有 `status=archived` 的迁移路径

现状 @ `writer.ts::archiveProjectEntry:734`：直接调 `updateProjectEntry(slug, {status:"archived"})`。**没有 archive_at 字段、没有 reactivation reviewer**。

迁移：

1. `archiveProjectEntry` 加 `archive_at` 字段
2. 加 daily/weekly cron 跑 archive-reactivation-reviewer prompt 扫所有 archived 但 `now - archive_at < 30d` 的 entry
3. 跑反证检测 prompt 决定 reactivate / continue archive
4. `now - archive_at ≥ 30d` 的 entry 跑最后一次 reviewer prompt → reactivate / git rm

#### 4.6.6 跟 §4.1.5 staging age-out 的关系

§4.1.5 的 `attribution_pending` staging 条目 age out 走**同一套**反证检测 + reactivation 流程（archive-reactivation-reviewer prompt）。统一软删 → N 天窗口 → 硬归档。**一个 prompt 服务两个能力点**。

---

## 5. 实施路径

### 5.1 基于 §1 现实的 phase 安排

`autoLlmWriteEnabled` 必须有 `false` 与 `"staging-only"` 两条退路：前者回到无自动写入，后者保留 classifier / staging 观测但禁止 durable mutation。默认开启是产品决策点，不应移除这两条退路。

P1 前需用真实对话原型验证 classifier prompt（false-positive < 20%、step-skipping < 15%；不过则回炉或拆为“分类 + staging resolution”两段式）。分阶段 phase 顺序（P0 配套基础 → P1 主动纠错 → P1.5/P3.5 multi-view → P2 outcome → P3 aggregator → P4 prompt 演进 → P5 归档回滚 → P5.5 默认开启 → P6 废弃反模式）；**并行轨**：P0/P1 配套基础串行，P1.5+P2+P3 可并行，P4+P5 可并行；工程量估算与 backlog 见 [`../roadmap.md`](../roadmap.md)。**P5.5 / P6 必须在 ADR 0024 设想经 dogfood 跑通后才碰**，不在设想未真跑起来前动现有入口。

### 5.2 §3.2.A ADR 0003 三选项决策点（R2+ 必答）

R2+ multi-LLM audit 必须 explicit 评估以下问题才能选项：

1. **AI-Native + multi-view 能不能提供跟 sandbox 同等的 prompt injection 防护？** R7 audit 21/21 PE-form 是 RLHF 偏置阻断证据；能不能防恶意 injection 需 dogfood + 独立评估
2. **active correction latency 实际是几秒？几轮对话？几分钟？** 主动纠错路径启用后量化，决定 "是否足够破坏延伸大脑体验"
3. **outcome self-report 方案 C（`memory-footnote` + sidecar）vs 方案 A（本人直接写 ledger）实际质量差多少？** outcome 路径启用后双试验
4. **选项 2/3 的 ADR 0003 / 0010 / 0013 要改多少？** §1.5 提到现在已经开了几个口子（vault_release / prompt_user 是先例），这暗示选项 2 工程量比 R1.2 估计的低；选项 3 工程量可能超出本 ADR 主体

**默认起点**：选项 1（保留 ADR 0003，outcome 走方案 C）。但 R2+ 评估后允许跳到 2 或 3。

### 5.3 `autoLlmWriteEnabled` default 改 true 决策点（新 — §1.4 现实驱动）

默认开启前必须保留三态退路：`true`、`false`、`"staging-only"`。单用户项目可以用“用户授权 + 三态退路在位 + 直接 dogfood 反馈”提前承担风险；多用户项目仍必须按下面门槛评估。

**决策**：P5.5 时默认值改为 true（允许 `"rollout"` 渐进灰度过渡），但必须保留 `false`（立即关整条 auto-write）与 `"staging-only"`（classifier/staging 正常跑、不出 durable 写）两个回滚开关。单用户项目可用“用户授权 + 三态退路在位 + 直接 dogfood”提前承担风险；多用户项目必须过 dogfood 门槛（样本至少 3 用户 × 4 周；false-positive < 15%、无误行为投诉、staging 月新增<50 且 resolve 率>30%）。

**反向 patch**：ADR 0024 §6 需明确承认 "默认开启后用户察觉不到的偏差累积是首次真正存在的代价"（与 §2.3 评估一致）。

### 5.4 反向 patch 下游 ADR 清单

| 下游 ADR | patch 内容 | 触发 phase |
|---|---|---|
| **ADR 0024 §4.2 反模式表** | 加 deprecation timeline / clarify `/about-me` + `MEMORY-*:` fence 在 P6 前是过渡期合法路径 | P6 |
| **ADR 0024 §4.3 灰色地带表** | 删/软化 "同一类纠错跨会话重复 ≥ 2 次自动升级为 durable" 机械门 — 跟 §3 AI-Native + 本 ADR §4.1.4 矛盾，改为 "由 aggregator prompt 跨会话趋势判断" | aggregator 设计落地时 |
| **ADR 0023 R5 unified classifier patch** | 加 `correction_signal` 输出维度（如选 §3.3 unified call X）或拆为多个专精 classifier（如选 Y/Z）；同步本 ADR §3.3 R2+ 决策 | P1 |
| **ADR 0014 七区 layout** | 如 §4.1.5 选项 S（sidecar staging）→ 七区列表加一条说明 sidecar staging 不计入七区 invariant #7 | P1 |
| **ADR 0015 memory_search corpus** | 如 §4.1.5 选项 P（复用 Lane G staging）→ 已经 OK；选项 S（sidecar）→ 加 staging-loader corpus 例外说明 | P1 |
| **ADR 0016 curator 7 op** | 如新增 op（`promote-to-staging` / `reactivate-from-archive`）→ 同 PR patch | P5 |
| **ADR 0018 sanitizer** | 如选 §3.2.B 选项 3 混合 → patch sanitizer 接口 + 加 LLM advisory hook | P2 或更晚（dogfood §4.1 误 redact 频率后定） |
| **ADR 0020 transport-only sync** | §4.6.4 archive_at 跨设备字段 + §4.1.5 originating_device 同步语义 | P5 |
| **ADR 0003 主会话只读** | 如 §5.2 选项 2/3 → 同 PR patch（加上口子清单或重写 sandbox 边界） | P2 或更晚（§5.2 决策点） |

**反向 patch 必须与对应设计变更同步交付；否则该阶段不得发布。**

---

## 6. 测试设计（三层 smoke）

按 ADR 0024 §3 AI-Native 原则，**三层 smoke 都不是发布阻断 gate**——只用于 "留信号给作者"，不阻断写入。

- **Tier 1 自动断言**：classifier 输出符 `CorrectionSignal` schema / staging 字段齐全 / 软归档文件 N 天内存在 / multi-view 命中时确实两次独立 API 调用 / `prompt_version` 每条 audit 都有——结构性验证，fail=bug 必修，Infra 机械合法。
- **Tier 2 LLM-as-judge advisory**：独立 LLM 按 §4.1.3 bias cautions 给 reasoning trace 打分，只留 advisory flag，不阻断发布。
- **Tier 3 信息对照 dossier**：prompt 改动后旧/新在真实 utterance 上的输出差异，供作者 review。

具体 fixture / 断言清单见 [`../reference/smoke-tests.md`](../reference/smoke-tests.md)；每个 Phase 的 smoke 报告存 `docs/audits/`。

---

## 7. 与 ADR 0024 边界的对齐自检

**治理决策**：每个 Phase 发布前必须过一遍边界自检；任何 ✗ 触碰 → 该 Phase 不能发布，必须先回 ADR 0024 调 invariant。这是发布门禁（同 ADR 0027 C5 blocking gate 性质），不是表面检查。

自检覆盖八个维度（逐条 checklist 由所引 ADR 0024 §2 invariant / §3 AI-Native / §4.2 反模式 / §6 代价与本 ADR §2.3 / §5.4 构成，不在正文重复）：

1. **Invariant 边界**：INV-INVISIBILITY / AUTONOMY / IMPLICIT-GROUND-TRUTH / ACTIVE-CORRECTION 各条不被违反（纯告诉 footer/notify 合法；任何 sediment 生命周期的 `prompt_user`/审批弹窗/诱导收集反馈 ✗；LLM 解释不得升为 ground truth）。
2. **AI-Native 3 态**：PE-form ✓ / Infra 机械 ✓ / Mech-on-LLM ✗（违反需按 §3.2 自检 justify）。
3. **§4.2 反模式**：不引入要求用户裁决/审批的弹窗、机械关卡替代 prompt、枚举字段替代自然语言推理等（`MEMORY-*`/`/about-me` 在 P6 前是过渡期合法例外，§3.2.C）。
4. **§6 接受代价**：每个 Phase 必须显式 acknowledge 它引入的新代价（§2.3 已逐条映射哪个 Phase 引入哪条代价）。
5. **§7 走偏信号**：检查 ADR 0024 §7 信号 1-7 + staging age-out / 未 resolve 率是否持续 > 60%。
6. **下游 ADR 边界**：触及 ADR 0003/0014/0017/0018/0020/0022 任一边界时逐项说明不违反原 invariant（§5.4 反向 patch 清单）。
7. **代码现实校验**：上线时 §1 描述的两条 lane / 七区 / sanitizer / `autoLlmWriteEnabled` 默认值是否还成立（变了则 §5.4 同步 patch）。
8. **诊断入口抑制**：`/abrain audit classifier` / `/rule list` / `/abrain status` 在 quickstart / `/help` / 推广文案中被抑制（符合 ADR 0024 §4.3）。

---

## 8. 相关项目记忆 + audit 文档索引

### 项目记忆（指导本 ADR 设计）

- `in-vivo-correction-channel-as-durable-knowledge-source` (pattern, conf 8) — 主动纠错通道作为最可信 ground truth；§4.1 设计的直接依据
- `adr-0024-r7-prompt-engineering-review-classifier-must-use-evidence-first-decision-last-cot` (pattern, conf 8) — §4.1.3 prompt step 1-6 顺序的直接来源
- `multi-llm-review-exposes-five-actionable-design-flaws-in-intent-classification-architecture` (pattern, conf 8) — §4.1.3 prompt 末尾 "bias cautions" 9 条的部分来源
- `adr-0024-r7-review-multi-view-verification-requires-blind-first-reviewer-protocol-with-two-api-calls` (pattern, conf 8) — §4.4.2 两次独立 API 调用约束的直接来源
- `rlhf-reviewer-bias-toward-mechanical-derisk-in-ai-native-system-critique` (anti-pattern, conf 9) — §4.4 reviewer prompt 设计必须反 RLHF 机械偏置
- `prefer-prompt-engineering-over-mechanical-guards` (maxim, conf 9) — 本 ADR 全局指导原则
- `sediment-self-evolution-philosophy-trusts-llm-over-mechanical-blocking` (maxim, conf 8) — 同上
- `sediment-is-currently-write-only-loop-lacking-outcome-feedback` (pattern, conf 9) — §4.2 outcome self-report 要解决的根本问题。**v2 注**：该 entry 写于 v1 R1 前，"write-only loop" 描述不精确——§1.1 显示 sediment 实际是两条 lane（Lane A/G synchronous + Lane C bg auto-write）。entry 等 sediment 自己消化。
- `staged-rollout-better-than-big-bang` (maxim, conf 8) — §5.1 phase 安排的间接指导（但 v2 不再用 "渐进 vs 大重写二分" 的角度，§5.1 phase 安排是基于 §1 代码现实驱动的，不是从 maxim 默认推论出来的）

### 待沉淀的本 ADR 候选 maxim / pattern（sediment 自行决定）

- `code-reality-first-then-design`（候选 maxim）— v1 R0→R1.2 markdown 脑补、v2 强制 §1 代码探索为前置的反思
- `provisional-staging-hypothesis-as-prompt-form-anti-anchoring`（候选 pattern）— §4.1.5 `_provenance_warning` banner + WARNING prompt 段 + pending resolution queue 三者组合防 LLM 将 provisional hypothesis 错读为事实
- `layer-f-three-state-protocol-distinguishes-infra-from-llm-behavior`（候选 maxim）— ADR 0024 §3 + 本 ADR §7.2 沿用的 PE / Infra / Mech-on-LLM 三态标注
- `architecture-constraint-vs-result-constraint-distinction`（候选 maxim）— §3.1 A' 结果约束 vs §3.2 B' 机制约束的分层是 ADR 设计里一个稳定可复用的角度

### Audit 文档索引（archive，不污染主线）

- [ADR 0024 R1-R6 multi-LLM audit](../audits/2026-05-21-adr-0024-multi-llm-r1-r6.md) — ADR 0024 设计意图稳定过程
- [ADR 0024 R7 prompt-engineering review](../audits/2026-05-22-adr-0024-r7-prompt-engineering-review.md) — Layer F v2 三态标注首次实证
- [ADR 0025 R0 R8 prompt-engineering review](../audits/2026-05-22-adr-0025-r0-prompt-engineering-review.md) — v1 R0 三家 T0 平均可行性 61%，6 个 P0 + 1 P1 + 7 盲点构成本 ADR 的设计输入

### 设计演进索引

本 ADR 的草稿演进、审计批次与提交锚点保留在 `docs/audits/` 与 git history；正文只保留会影响当前设计边界的结论。
