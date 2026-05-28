# ADR 0025 v2 — Sediment Meta-Curator：让 sediment 演化为 ADR 0024 第二大脑

- **状态**：v2 草稿（2026-05-22），等待用户 review 后覆盖 v1（R0/R1/R1.1/R1.2）。
- **目的**：[ADR 0024](0024-second-brain-from-natural-conversation.md) §5 六条能力点的具体落地设计。ADR 0024 说的是 "是什么 / 为什么"（含 4 条 invariant + AI-Native 原则 + 能力点骨架），本 ADR 说的是 "现状是什么 / 缺什么 / 怎么填"。
- **范围**：sediment 扩展 + abrain (brain backend) + memory (retrieval facade) 三个 extension 一起看。具体改哪个文件 / 哪一段代码、哪些下游 ADR 要反向 patch，在 §4 / §5 落点。
- **不在本 ADR 范围**：(a) 重申 ADR 0024 invariant / 哲学（重复就是 drift 风险）；(b) 跑 audit / 跑 dogfood / 实际 ship——这是后续 PR 的事。

**v1 → v2 重写动机**：v1 R0 → R1.2 是补丁式叠加，§0.5 残留旧 "C." 标题、§8 两套 phase 表共存、§1 接口面是 markdown 脑补未对照过实际代码。v2 一次性整理：以 ADR 0024 为基准、以 sediment / abrain / memory 当前 23K 行 TS 真实代码为对照、扔掉 R8 P0-X / R1 / R1.1 / R1.2 patch 标记，重新组织。

v1 内容保留在 git history（commits `bd16805` → `417730f`）；R8 audit 文档独立存活作 archive 决策 paper trail（不并入本 ADR）。

---

## 0. 起草说明

### 这份文档**只写**

- 现有 sediment / abrain / memory 代码的真实形态（§1）
- 现实跟 ADR 0024 的 gap 分布（§2）
- 设计约束分层与 explicit 评估项（§3）
- 六能力点的机制设计：prompt skeleton + 与现有代码的接口 + 工程量 + 跟下游 ADR 的反向 patch（§4）
- 实施路径与几个 R2+ 决策点（§5）
- 测试设计与边界自检（§6 / §7）

### 这份文档**不写**

- ADR 0024 invariant / AI-Native / 接受代价 / 走偏信号本身的论证——那是 ADR 0024 的事
- 本 ADR 设计点的 R0/R1/R1.1/R1.2 演进史——在 git history
- 任何 R8 P0-X 标记，本 ADR 是 baseline 不是 patch 集合

如果发现本 ADR 在重复 ADR 0024 内容 → **删掉**，引用即可。

---

## 1. 代码现实（基于探索后的 ground truth）

本节信息来源：3 家并行 sub-agent 探索（DeepSeek v4-pro 跑 sediment 核心 5500 行、GPT-5.5 跑 abrain + memory 16000 行、DeepSeek v4-flash 跑 sediment 辅助 1700 行），三轮 cross-check。所有结论 cite file:line。

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

**七区硬编码** @ `extensions/abrain/brain-layout.ts:28-36`：

```ts
const BRAIN_ZONES = [
  "identity", "skills", "habits", "workflows",
  "projects", "knowledge", "vault",
] as const;
```

`ZONE_META` 给出每区 role @ :47-54，但**是 documentation-only**——运行时不使用，writer enum 和局部 router 才是 source of truth（`brain-layout.ts:43-46`）。`ensureBrainLayout()` 仅做 mkdir @ :69-101。

`always vs listed tier` 在 brain-layout.ts **没有代码模型**。Lane G 写 about-me 时硬排除 knowledge/workflows/projects/vault @ `about-me-router.ts:59-63`（whitelist=identity/skills/habits/staging）。

**现有 staging 已存在但不是 ADR 0025 v1 §1.4 设想的形态**：

- 真实存在的 staging：`projects/<id>/observations/staging/` @ `writer.ts:1797-2037`（Lane G project-local sub-zone）
- memory_search **已显式排除** @ `parser.ts:31-42`、`parser.ts:727-749`（`scanStore` 设 `excludeStaging`）
- v1 §1.4 设想的 sidecar staging：`~/.abrain/.state/sediment/staging/` @ 全代码**不存在**

**对本 ADR 的含义**：§4.1 主动纠错的 staging 写入有两个选项——(a) 复用现有 `projects/<id>/observations/staging/`（但当前只用于 Lane G）；(b) 新建 sidecar `~/.abrain/.state/sediment/staging/`（v1 §1.4 设想，跟 checkpoint 同父目录但语义独立）。R2+ 决策。

**memory_search corpus 来源** @ `extensions/memory/parser.ts:120-172`：`resolveStores()` 顺序 abrain project → world `~/.abrain/` → legacy `.pensieve/`。world store 扫 `~/.abrain/` 但排除 `projects/` 和 `vault/`（`parser.ts:19-29`、:744-749）。**默认 exclude archived** @ `search.ts:12-16`：无 `filters.status` 且 `entry.status === "archived"` 返回 false。

**实现是两阶段 LLM rerank** @ `llm-search.ts:340-548`——已经 ADR 0015 化。`search.ts::searchEntries` 老 BM25 路径是 dead code @ :65-67。

### 1.3 sanitizer / audit / git-sync 真实形态

**sanitizer @ `extensions/sediment/sanitizer.ts`** 是 14 类 deterministic regex pattern-match：

| 类 | 规则 | 行号 |
|---|---|---|
| pem_private_key | `-----BEGIN PRIVATE KEY-----...END...` | :45-47 |
| anthropic_api_key | `sk-ant-[A-Za-z0-9_-]{20,}` | :48 |
| openai_api_key | `sk-[A-Za-z0-9_-]{20,}` | :50 |
| github_token | `gh[pousr]_[A-Za-z0-9_]{20,}` | :51 |
| jwt_token | `eyJ...` 三段 base64url | :52-53 |
| aws_access_key | `(AKIA\|ASIA)` + 16 字符 | :56 |
| connection_url | `scheme://user:pass@host` | :58-59 |
| bearer_token | `Bearer\s+...` 20+ 字符 | :64-65 |
| slack_token | `xox[abprs]-...` | :66 |
| google_api_key | `AIza...` 35 字符 | :67 |
| stripe_key | `(sk\|pk\|rk)_(live\|test)_...` | :68 |
| generic_secret_assignment | keyword + `:=` + value ≥16 字符 | :76-77 |
| short_secret_assignment | keyword + value 8-15 字符 | :79-81 |
| unicode_bypass fallback | Unicode bypass → 整行 redact | :115-148 |

**调用点** @ `llm-extractor.ts:148`（pre-sanitize LLM 输入边界）+ `:116-121`（post-sanitize audit 预览）。`sanitizeForMemory()` 是唯一 exports。**没有 LLM-based 升级路径的 hook**。

**误 redact 风险点**（具体例子）：
- 用户讨论"我的 API key 配置遵循 sk-xxxx pattern"（"xxxx" 长到 20+ 字符）→ `openai_api_key` regex 命中 → 整段 `[SECRET:openai_api_key]` 替代 → classifier 看不到 active correction 语义
- LLM 输出 PEM 示例解释 `openssl` 用法 → 完整 `pem_private_key` 块被 redact
- 调试 JWT 库时输出知名 example token `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4...` → 严格 `jwt_token` 三段命中 → redact

**`extensions/abrain/redact.ts` 是另一套**（不是同一套 sanitizer）：服务 git-sync / prompt_user / vault UI / audit。函数 `redactCredentials` / `sanitizePathLike` / `redactPromptParams` / `redactSecretAnswer`（`redact.ts:14-176`）。两套并存，不重叠职责。

**audit @ `writer.ts`** 已经包含丰富字段：

```jsonc
{
  "timestamp": "2026-05-23T...",
  "audit_version": 2,
  "operation": "auto_write",
  "session_id": "...",
  "settings_snapshot": { ... },
  "candidates": [{ "kind": "fact", "confidence": 7, ... }],
  "results": [{ "status": "created", "slug": "...", "gitCommit": "..." }],
  "curator": [{ "decision": { "op": "create", "rationale": "<自然语言>" }, "stage_ms": {...} }],
  "stage_ms": { "window_build": 5, "llm_total": 3000, "write_total": 200, "total": 3500 },
  "background_async": true,
  // ...
}
```

`curator.decision.rationale` 已经包含 LLM 自然语言 rationale @ `curator.ts::parseDecision:220`。**audit 缺的不是 reasoning trace 整体**——缺的是 6-step chain-of-thought structured trace（quote / alternative / disconfirmer / downgrade / commit / self-critique）。

**`appendAudit` 调用点** 分布：writer.ts:655（主入口）+ writer.ts:1454（`appendAbrainAudit` for world-scope/workflow/about-me）+ `abrain/git-sync.ts:637`（独立 sync audit）。三个 audit 输出点，可在新 ADR 设计时统一也可保留分布——R2+ 决策。

**git-sync** @ `extensions/abrain/git-sync.ts`：已经 transport-only @ :4-24。`pushAsync` / `fetchAndFF` / `sync` / `getStatus` 操作 git；冲突走 git 3-way merge，不走 LLM merge / rebase。无 origin 时跳过 @ :32、:273-285；失败写 `.state/git-sync.jsonl` 且不抛 @ :319-327、:381-434。**已知 gap**：sediment writer 自己的 `gitCommit()` @ `writer.ts:586` 没接入 git-sync singleFlight，可能跟 auto-merge 抢 index.lock @ `git-sync.ts:40-46`。本 ADR 不修这个问题，但 §5 实施路径里必须明确承认它存在。

### 1.4 现有反模式 + auto-write 默认不开

**ADR 0024 §4.2 反模式表三项已在代码中是合法路径**：

| ADR 0024 反模式 | 代码现状 |
|---|---|
| `MEMORY-RULE:` / `MEMORY-ABOUT-ME:` 围栏让用户手动注入 | Lane A `parseExplicitMemoryBlocks` + Lane G `parseExplicitAboutMeBlocks` 实现 @ `extractor.ts:173-220` + `index.ts:789-795` |
| `/about-me` 命令让用户主动声明 | `/about-me` slash command 注册 @ `extensions/sediment/index.ts:2244-2246` |
| 用户主动跑 `sediment self-improve` | 当前 `/abrain` 子命令含 `self-improve`，由用户主动跑 |

**`autoLlmWriteEnabled` 默认 `false`** @ `extensions/sediment/settings.ts:54`：

```ts
autoLlmWriteEnabled: false,  // ← Lane C 默认不跑
```

这意味着：**ADR 0024 设想的 auto-write 现在默认不开。用户必须主动去 `~/.pi/agent/pi-astack-settings.json` 设 `sediment.autoLlmWriteEnabled: true` 才能让整个 ADR 0024 设想跑起来。** 本 ADR §5.3 列这个作为 R2+ 决策点（要不要改默认值）。

**这对本 ADR 的含义**：

- §4 各能力点上线后不会立刻让大多数用户感受到——除非用户主动开 `autoLlmWriteEnabled: true`
- 反模式 deprecation （§5.4）必须在 ADR 0024 设想真正跑起来之后做，否则用户失去现有显式入口
- ADR 0024 设想跟现实的 "感觉差距" 大部分是因为默认不开，不是设想本身有问题

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
| `promptVersion` 字段 | **没有** @ `settings.ts:27-77`、audit schema、`llm-extractor.ts:28-36` quality gate | §4.5 classifier prompt 演进需要从零加配套字段，工程量上调 |
| classifier 输出 zone/tier/op | **没有** — extractor 只产 `kind/status/confidence` @ `llm-extractor.ts:160-180` | §4.1 主动纠错 prompt 不是改现有版本，是从零写 |
| multi-view 跨 provider 注册 | **没有** — extractor + curator 都是 deepseek 单 provider @ `settings.ts:63-69`（`deepseek/deepseek-v4-pro` + `deepseek/deepseek-v4-flash`） | §4.4 multi-view 需要跨 provider 的 model registry + fallback 名单 |
| evidence-first 6 步推理轨迹 | **没有** — curator prompt 是扭的 "选 7 op 之一" @ `curator.ts:497` | §4.1 / §4.4 prompt 是 0→1 新写不是现有版本改进 |
| `outcome_history` 台账 | **没有** — entry frontmatter schema 是开放 `Record<string, Jsonish>` @ `types.ts:45` 但默认逻辑不理解新语义 | §4.2 outcome 台账走独立 sidecar 文件，不进 entry frontmatter |
| staging-loader | **没有** — checkpoint @ `~/.abrain/.state/sediment/checkpoint.json` 是 per-session slot @ `checkpoint.ts:37-41`，跟 staging 语义无关 | §4.1.5 staging 时间戳基础设施完全独立 |

**Settings 配置面** @ `settings.ts:27-77`：暴露 `enabled` / `gitCommit` / `extractorModel` / `curatorModel` / `extractor*Timeout` / `curator*Timeout` / `maxWindowChars` / `autoLlmWriteEnabled` / `autoWriteRawAuditChars` / `defaultConfidence` / `lockTimeoutMs`。**没有 `promptVersion` / `multiViewProviders` / `stagingMaxAge` 这些配套字段**。本 ADR §4 / §5 各能力点要加的 settings 字段需要同 PR 加进去。

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

### 2.2 六能力点：现实 baseline + 缺多少

| 能力点 | 现实 baseline | 缺多少 |
|---|---|---|
| 1. 主动纠错识别 | 0 — extractor prompt 没有 active correction 任务、没有 `CorrectionSignal` 输出 schema | **整条** |
| 2. outcome self-report | 0 — `agent_end` handler 不注入 outcome prompt 给主会话 LLM、没有 `outcome_history` ledger | **整条** |
| 3. 跨会话 aggregator | 0 — 没有 scheduler hook、没有 aggregator 文件、没有 daily/weekly/monthly cron | **整条** |
| 4. multi-view verification | 0 — `curateProjectDraft` 单次 LLM 调用、没有 Pass 1 Blind + Pass 2 Reveal 拆分、extractor + curator 同 provider | **整条**（含 multi-provider 配套设施） |
| 5. classifier prompt 演进 | 0 — 没有 `promptVersion` 字段、没有 `/abrain audit classifier` 诊断入口 | **整条** + 配套字段 |
| 6. 静默归档 + 回滚 | △ — `status=archived` soft delete 已在 `archiveProjectEntry` @ `writer.ts:734`（thin wrapper over `updateProjectEntry`），但**没有 N 天窗口、没有 git rm 硬归档、没有反证检测 prompt、没有 reactivation reviewer** | 半条（soft delete 在，windowing + reasoning 全无） |

### 2.3 §6 接受代价跟现状的兼容性

ADR 0024 §6 列 9 条该设计必须接受的代价。逐条评估跟代码现实的兼容性：

| # | §6 代价 | 现实兼容性 |
|---|---|---|
| 1 | 错误传播跨设备 | ✓ git-sync transport-only 已落地，沉积错误确实会跨设备传播 |
| 2 | 偶发"假高置信" | ✓ 现状（无 multi-view）下假高置信代价已在 — ADR 0024 设计跑起来后 multi-view 反而降低 |
| 3 | 静默归档误删 | △ 现状 `status=archived` 软删除已有，但缺 N 天回滚窗口 + 反证检测——ADR 0024 设想真正跑起来时需补上，才能说真正承担这条代价 |
| 4 | 跨设备最终一致延迟 | ✓ git-sync 是 fire-and-forget，延迟天然存在 |
| 5 | 用户察觉不到的偏差累积 | ✗ 现状无 aggregator + Classifier Health Meta-Check——这条代价当前**没有任何对冲机制**。aggregator ship 前用户察觉不到设计在悄悄漂移 |
| 6 | 主动纠错疲劳 | ✗ 现状无主动纠错识别——这条代价目前**完全不存在**（连主动纠错信号都没识别），但 §4.1 ship 后会出现 |
| 7 | Multi-view 翻倍调用成本 | ✗ 现状单 provider、单调用，成本翻倍这条代价目前不存在；§4.4 ship 后才会出现 |
| 8 | 早期推理质量参差 | ✗ 现状 classifier prompt 是 baseline (无 evidence-first)，"早期参差" 是设计跑起来之后的 prompt 迭代代价 |
| 9 | LLM 推理失败本底概率 | ✓ ADR 0024 不变的本底风险 |

**这意味着**：§6 的 9 条代价里，§4 上线前实际只有 1/4/9 真正存在；2/3/5/6/7/8 是能力点上线后才出现的代价。§5 实施路径里**每个能力点上线时必须明确承认它引入的新代价**。

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

**本能力点必须最先 ship**——其他五条空声明。

#### 4.1.2 触发条件 + 输入输出 schema

在 `agent_end` hook、Lane C curator op 决定之前插入。所有 `agent_end` 都跑——不预筛选（与 ADR 0024 §3.3 "几个典型机械形态" 对齐：classifier 不靠预筛选阈值，靠 prompt 引导）。

**Lane A / G 是否也跑 classifier**：是。Lane A/G 是用户显式 fence 写入但**内容本身可能含主动纠错语义**（如用户在 `MEMORY:` fence 内写 "忘掉旧的 yarn 偏好"）。Lane A/G 命中 classifier 后，把识别结果作为额外 metadata 附加到 fence 写入路径，不阻断 Lane A/G 同步落盘。

**⚠️ 所有新 LLM 调用都必须先过 sanitizer**（这是 §3.1 A' 层的结果约束，不准商量）：classifier 拿到的 `packed_window` 在送进 LLM 之前**必须**走一趟 `sanitizeForMemory()`——跟现有 `llm-extractor.ts:148` 同款路径。不管 classifier 是挂在 Lane C 还是 Lane A/G，这个 sanitizer 入口是硬性的。不是"建议"，是"不过 sanitizer 不准调 LLM"。这等于把 §1.3 那个 14 类 regex 堵门原样搬到新 classifier 的输入边界上。

**Input**：

```ts
interface ClassifierInput {
  conversation_window: ConversationTurn[];     // 完整 window，不预剪
  recently_loaded_entries: MemoryEntry[];      // 本 session 主会话 inject 过的 entry
  related_entries: MemoryEntry[];              // memory_search 召回的相关 entry
  staging_context: StagingEntry[];             // 从 staging-loader 拼提的 staging（K 条）
}
```

**Output**：

```ts
interface CorrectionSignal {
  // Step 1-2 evidence
  user_quote: string;                       // verbatim quote
  surrounding_context: string;              // ≥3 行前后文
  three_readings: {
    durable: string;                        // 最强 1 句论据
    task_local: string;
    debug: string;
  };

  // Step 2b-4 disconfirmation + weight-based re-evaluation
  initial_lean: "durable" | "task-local" | "debug";
  disconfirmer: string | null;
  downgrade_applied: boolean;

  // Step 5 final classification
  typing: "durable" | "task-local" | "debug";
  scope_description: string;                // 自然语言（不是枚举）
  correction_intent: string;                // 自然语言（不是枚举）
  confidence: number;                       // 0-10

  // Step 6 self-critique
  most_likely_error_direction: string;      // 必须 reference step-1 quote
  most_likely_error_reason: string;

  // Step 7 self-rating（仅 audit，不影响 commit）
  reasoning_quality: {
    quote_faithfulness: number;             // 0-10
    alternative_consideration: number;
    self_critique_concreteness: number;
  };

  // 归属处理
  target_entry_slug: string | null;
  resolution_hypothesis: string | null;
}
```

#### 4.1.3 完整 Prompt

下面是 production-ready prompt。从 v1 R1 §2.3 保留 verbatim（R8 P0-A 全量重写后稳定）。

```
# Reasoning normalization preamble (§4.4 multi-view 共用，prepended)

Your reasoning trace MUST follow this fixed structure across all
classification dimensions: quote → claim → alternative → uncertainty
→ resolving evidence. Do not rearrange. Do not skip stages. Different
base models (Claude/GPT/DeepSeek) have different default reasoning
styles; this preamble normalizes the surface so downstream multi-view
verification (§4.4) can compare apples-to-apples.

# Active-correction classifier

You are reading the latest conversation window. Decide whether a user
utterance contains an active correction signal — a natural-language
statement that updates the brain's knowledge about user preference,
identity, or anti-pattern. The user does NOT see you run.

# What counts as active correction (positive examples)

- "以后用 X" / "from now on use X"                  ← durable preference shift
- "我换了,现在用 pnpm" / "I switched, using pnpm now"  ← durable shift, no "以后" marker
- "忘掉那条" / "forget that one"                    ← supersede instruction
- "你怎么记成 Y 了" / "wait you remembered Y?"      ← contradiction surfacing
- "现在我更倾向 Z" / "now I prefer Z"                ← preference update
- "这个项目用 X,但平时用 Y"                          ← scoped durable
- "X 项目不要用 Y"                                   ← scoped negation
- "以后不要用 X 了"                                  ← durable + supersession 复合

# What does NOT count (negative examples)

- "we used X here because the task required it"      ← task instruction, not preference
- "let's try Y this time" / "这次试试 Y"            ← experimental, not durable
- "X is broken, switch to Y for now" / "X 坏了先用 Y" ← debug, not preference
- "X 也行吧"                                         ← reluctant acceptance, not preference
- "你看着办"                                         ← delegation, not preference
- "哎 X 又挂了"                                      ← casual complaint, not correction
- (用户选 A 不选 B 但未说明)                         ← indirect signal, not active correction

# Bias cautions — self-check BEFORE producing the structured output below

(a) Post-hoc rationalization: am I about to write step 5 first in my
    head then back-fill step 1-4? If I notice this urge, restart from
    step 1.
(b) Sycophantic agreement: am I classifying as 'durable' because that's
    the highest-stake category and feels important?
(c) Anchoring on recently_loaded_entries: did seeing an existing entry
    push me toward classifying the utterance as superseding it, when
    actually the user was just task-instructing?
(d) Helpfulness / over-extraction: am I labeling this as a correction
    because there's real evidence, or because returning null feels like
    a 'lazy' answer? Returning null is a SUCCESSFUL run.
(e) Recency / verbatim-length bias: am I overweighting the most recent
    utterance? Re-read the FULL window.
(f) Provisional-as-fact anchoring: when staging_context contains entries
    with status=provisional + attribution_pending=true, am I treating
    them as confirmed evidence instead of unconfirmed guesses?
(g) Confirmation toward existing entries: if the utterance matches a
    high-confidence existing entry topic, am I forcing a supersede
    interpretation where a CREATE or SKIP would be more faithful?
(h) Pattern-match overfitting: positive examples above are templates,
    not exhaustive. Non-template-shaped corrections still count.
(i) Translation / code-switch: 中文"先 / 这次 / 以后 / 平时 / 现在"
    映射到英文 'first / this time / from now on / normally / now' 时
    是否被直译误伤?

# Your output structure is fixed. You MUST follow it in order.

Step 1 — Quote the user's exact words (no paraphrasing). Include ≥3
         lines of surrounding context. If multiple candidate utterances,
         list ALL.

Step 2 — For EACH of {durable, task-local, debug, NOT-A-CORRECTION},
         write the strongest 1-sentence case FOR that reading, using
         ONLY step-1 quotes. The fourth option NOT-A-CORRECTION is
         required. If NOT-A-CORRECTION is genuinely stronger than the
         other three combined → return null and exit. For the remaining
         three: give each a real case, not a strawman.

Step 2b — LEAN-DECLARATION: Re-read your four cases. State which one
          currently looks strongest in one sentence, citing which step-1
          quote made it strongest. Then state: "If I were forced to
          argue the OPPOSITE in a debate, which of the other three
          cases would I pick as my opening argument? Quote that case."

Step 3 — Disconfirmation search. For the reading you currently lean
         toward, find the SINGLE observation in this transcript that
         would MOST undermine your lean. Quote it. If you cannot find
         one, say so explicitly + declare your search depth: "I scanned
         full window" / "I only scanned last N turns".

Step 4 — Weight-based re-evaluation. If step 3 produced a real
         disconfirmer (not a hedge, not a tautology), weigh it against
         step-2 evidence:
           - Does the disconfirmer attack DURABILITY, SCOPE, or just
             narrow scope?
           - When weighed against step-2 supporting evidence, does it
             shift confidence enough to warrant a tier downgrade?
         State your reasoning explicitly. Then commit:
           - If downgrade: which tier now? (durable→task-local→debug)
           - If no downgrade: why does the disconfirmer not outweigh
             the confirming evidence? Quote both sides.
         If step 3 declared shallow search + no disconfirmer: apply
         downgrade-by-one-tier regardless.

Step 5 — NOW commit the final classification:
         - typing: durable / task-local / debug
         - scope_description: natural-language paragraph describing
           when this correction applies. SCOPED DURABLE lives here —
           e.g. "durable for current React project, may extend to all
           frontend, unclear cross-device". NOT an enum field.
         - correction_intent: natural-language phrase ("new preference"
           / "scope narrowing" / "supersede" / "forget" / "contradiction
           surfacing" / "identity declaration"). Free text.
         - confidence: 0-10
         - target_entry_slug: from related_entries (NOT staging_context),
           by topic / trigger phrase / semantic similarity. If strong
           match, set slug. If weak / no match, set null AND fill
           resolution_hypothesis below.

Step 6 — Self-critique: "If I am wrong, the most likely error direction
         is ___ because ___". The 'because' clause MUST cite EITHER a
         step-3 disconfirmer OR a step-2 alternative case quote — not
         generic phrases. The 'direction' must name a specific
         alternative typing or NOT-A-CORRECTION.

Step 7 — Reasoning quality self-rating (audit-only, doesn't affect
         commit). Rate 0-10:
         - quote_faithfulness: did I quote verbatim or paraphrase?
         - alternative_consideration: did I genuinely engage with the
           other readings, or strawman?
         - self_critique_concreteness: is step-6 anchored to specific
           quotes, or generic boilerplate?
         Persisted to audit.jsonl. §4.3 aggregator auto-detects degradation.

# Staging-context handling

If staging_context contains entries with attribution_pending=true:

  WARNING: These are UNCONFIRMED HYPOTHESES from previous classifier
  runs. They may be wrong in topic, scope, or existence.

    - DO NOT treat as confirmatory evidence in step 2 cases.
    - DO NOT cite hypothesis content as if it were user-stated preference.
    - As a SEPARATE task this run (after step 7), for EACH provisional
      staging entry:
        (a) Does the current utterance + window RESOLVE this hypothesis?
            Three outcomes:
              - Same thing → promote to durable entry, OR attribute to
                existing entry slug you now found.
              - Different thing → leave provisional, age clock continues.
              - Direct refutation → mark for archive.
        (b) Default if uncertain: let it age. Resolve ONLY when evidence
            is unambiguous AND your reasoning trace quotes BOTH the
            staging hypothesis AND the new utterance side-by-side.
        (c) Before resolving "same thing", ask: "Why might this NOT be
            the same thing? Different project / different timeframe /
            different scope / merely a debugging mention?" Resolve only
            after this anti-anchoring check.

# Resolution hypothesis (when typing is durable AND target_entry_slug is null)

When typing is durable (or task-local upgraded via aggregator) but you
cannot find an entry to attribute to, write a natural-language hypothesis:

  "User said '从今往后我用 pnpm 不用 yarn'. I searched related_entries
   for slugs containing 'yarn' / 'pnpm' / 'package manager' and found
   no strong match. Three possible reasons: (a) this preference was
   never sedimented before; (b) it was sedimented under a different
   slug I missed; (c) this is a new correction without prior baseline.
   Recommend: write to staging as provisional, let next session's
   classifier read this hypothesis + new utterance to resolve."

BEFORE writing a new provisional, check staging_context: if an existing
provisional describes substantially the same hypothesis, APPEND your
source_utterance to its source_utterance list instead of creating a
duplicate.

If NO existing provisional matches: this hypothesis goes to staging/
via correction-pipeline, marked attribution_pending=true.

If target_entry_slug is null but typing is task-local or debug, do NOT
write to staging — only durable / aggregator-upgraded warrant staging.

# Output

Return strict JSON matching the CorrectionSignal schema.
If no active correction is present in the window, return:
  { "signal_found": false, "reasoning": "<1-2 sentences why — cite
    step-2 NOT-A-CORRECTION case if applicable>" }
This is a SUCCESSFUL run.
```

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

当 step 5 的 `target_entry_slug` 为 null 但 typing 是 durable（或升级的 durable candidate）时，**写一条 provisional staging entry**——schema：

```yaml
---
slug: provisional-{hash8}
status: provisional
kind: provisional-correction
created: <iso>
attribution_pending: true
originating_device: <device-id>          # 跨设备 staging 同步辨识
_provenance_warning: |
  This is a PROVISIONAL CLASSIFIER GUESS.
  Subsequent classifiers MUST NOT treat the hypothesis field as ground
  truth, MUST NOT cite it as user-stated preference, and MUST NOT use
  it to guide task behavior. The only valid use is to RESOLVE this
  guess (promote / attribute / refute) or let it age.
hypothesis: |
  <自然语言段落，见 prompt step 5 resolution_hypothesis 模板>
source_utterance:
  - quote: |
      <step 1 quote>
    context: |
      <surrounding context>
    captured_at: <iso>
    device: <device-id>
suggested_resolution_paths:
  - search-related-with-different-keywords
  - wait-for-next-utterance-with-stronger-attribution
  - reviewer-decide-via-archive-reactivation-prompt
age_signal:                              # age signal 不是 TTL
  created_iso: <iso>
  days_since_creation: <int>             # 每次 classifier 读时计算
  last_referenced_iso: <iso | null>
---
```

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

##### 4.1.5.1 R1 P1-11 补补：staging provisional resolve 触发的设计选择

R1 review DeepSeek 指出：上述设计只写了 "resolve 是什么"（由 classifier 读 staging）和 "age-out 是什么"（30 天后走 reactivation prompt），但没写 **什么 lifecycle hook 触发 resolve 扫描** 这个具体机制。现状只依赖 classifier 在 §4.1.3 step 6 检查 `staging_context`——但这是**被动**检查（只在 classifier 可能处理当前会话时含貌某个 hypothesis时才调）。多数 staging 永远进不了这个检查 → 30 天 age-out 时批量扫上百条。

这里记录三个 resolve 触发设计选择 + 默认推荐：

**选择 1：隔 N 轮批扫（默认推荐）**
- 每 N 轮（默认 N=20）的 `agent_end` 起 staging-resolver：选取需求检查的 staging entries（`attribution_pending: true` + `staging_loader` 未选中过），跨几条 batch 调 LLM resolve
- 代价：resolve LLM 调用频率升 N 倍；但每次仅扫 N 条 × 1 LLM 调用，总成本可控
- 优势：不依赖 classifier 被动发现机会；staging entry 被看到的期望时间从 N=30 天降为 N=N×轮平均间隔（多为 1-3 天）

**选择 2：需求驱动（lazy resolve）**
- 只在某个主会话轮次 classifier 说 "我看到 staging 里有可能相关的" 时 resolve 那些。表面是现状但主动量化 staging-loader 选中准别
- 代价：依然依赖 classifier 能遇到相关上下文；不相关场景的 staging 永不会 resolve
- 优势：resolve LLM 调用成本最低；与现代码套路一致

**选择 3：主动扫描所有**
- 每个 `agent_end` 都走 staging-loader 选取 + LLM resolve
- 代价：LLM 成本爆炸（每轮都走 + staging 可能有 100+ 条需要评估）
- 优势：resolve 延迟最低；但成本不可接受

**默认选择 1**（批扫）：N=20 作为默认，可调。staging 被看到期望从 30 天 → 1-3 天。选择 2 作为 fallback（如果选择 1 未启用），选择 3 在高价值-明确质量信号 staging 上作为可选。

**实现状态 (2026-05-27)**：staging-resolver 未实现。当前走选择 2 的 implicit 路径 (lazy resolve via classifier §4.1.3 step 6)。R1 P1-11 被重新分类为 P2-with-design-binding：resolve 触发路径已预先绑定，开工 staging-resolver 时默认选择 1。

#### 4.1.6 跟两条 write lane 的接口

新文件：

```
extensions/sediment/
├── correction-pipeline.ts        ← classifier + resolver 合并
├── context-packer.ts             ← conversation_window 裁剪 (token-budgeted)
├── staging-loader.ts             ← 从 staging/ 加载 staging_context
├── staging-types.ts              ← staging frontmatter schema 定义
└── prompts/
    ├── reasoning-normalization-preamble-v1.md
    ├── active-correction-classifier-v1.md
    └── context-packer-v1.md
```

现有文件改动：

| 文件 | 改动 |
|---|---|
| `index.ts` @ Lane C `tryAutoWriteLane` :1684 | 在 `runLlmExtractor` 之后、`curateProjectDraft` 之前调 `correctionPipeline.handle()` |
| `index.ts` @ Lane A/G synchronous :1308/1355 | fence 解析后也跑 classifier（不阻断同步落盘），结果作为 metadata 附加到 audit |
| `curator.ts::curateProjectDraft` :616 | 加入参数 `context: CorrectionSignal \| null`；区分 "来自主动纠错的 create/update" 与 "正常 observation" |
| `writer.ts` | 接受 sidecar staging 写入路径；`appendAudit` schema 加 `prompt_version` + `correction_signal` 字段 |
| `settings.ts` | 加 `correctionClassifierModel` / `stagingDir` / `stagingMaxAgeDays` 配置 |

数据流：

```
Lane C agent_end
  ├─ context-packer.run(window) → packed_window
  ├─ staging-loader.run(packed_window) → staging_context (K 条)
  ├─ runLlmExtractor(packed_window) → MEMORY: fence draft
  ├─ correctionPipeline.handle:
  │     ├─ classifier(packed_window, related, staging_context) → CorrectionSignal | null
  │     └─ if signal:
  │           if typing=durable && conf≥8 → queue for §4.4 multi-view
  │           if typing=durable && conf<8 → attach to curator context
  │           if typing=task-local → session working set
  │           if typing=debug → audit only
  │           if target_entry_slug=null && typing=durable → staging-write provisional
  ├─ curateProjectDraft(draft, context=CorrectionSignal | null)
  └─ writer.commit (atomic + git + appendAudit with correction_signal)
```

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

主会话 LLM 的 system prompt 加一段：

```
# Self-tracking footnote (R2 elaboration: scope/exact format)

After each tool invocation that returns memory entries into your
reasoning context, attach brief self-report footnotes at the end of
your response. For entries you used, mark decisive/confirmatory; for
entries retrieved but not adopted, mark retrieved-unused and explain why:

  ```memory-footnote
  entry: <slug>
  used: decisive | confirmatory | retrieved-unused
  counterfactual: |
    <If used=decisive: 1-sentence description of what you would have
     done if this entry had NOT been in context, citing the action you
     just took. If used=confirmatory: "would have made the same
     decision independently". If used=retrieved-unused: why you did
     not use it.>
  ```

This footnote is for the second-brain to track entry usage. It may be
visible to the user as a lightweight signal that the second brain
participated; do not ask the user to approve/review it. Do not skip it.
```

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
- §4.4 multi-view P0.5 ship 后可选择性抽样复查 outcome self-report 质量（防主会话 LLM sycophancy）

### 4.3 跨会话趋势观察（aggregator）

> **实施状态 (2026-05-28)**：aggregator v0.2 → v1 (prompt-native skeptical historian) 切换已完成。
>
> - **调度**：agent_end + 24h debounce sentinel @ `~/.abrain/.state/sediment/aggregator-ledger.jsonl`。fire-and-forget 后台跑 (ctx.signal **NOT** 传入，避免 main turn 退出时 abort)。
> - **v1 prompt 完整实现**：`extensions/sediment/prompts/aggregator-skeptical-historian-v1.md` (533 行)。本节下文 §4.3.2 “R2 展开”承诺已兑现。
> - **骨架覆盖**：(a) skeptical historian + falsifiability + sycophancy self-check；(b) prior 8 ledger runs 作 prior context；(c) classifier health 7 天 rolling trend delta + significant_drop flag；(d) P1.5 multi-view watchdog signals；(e) STRUCTURAL_CONTEXT 注入（未实现能力点 ADR 锚点）；(f) counterfactual quotes / reverse-anchor / INV-INVISIBILITY 自检；(g) 三态 `aggregator_engine` 字段。
> - **degraded fallback**：v0.2 mechanical path 保留，modelRegistry 缺失或 v1 LLM 失败时回退；ledger 写 `degraded_to_mechanical: true`。
> - **实现文件**：`extensions/sediment/aggregator-llm.ts` (410 行) + `extensions/sediment/aggregator.ts` (修订 加 AggregatorSummary.aggregator_engine 字段)。
> - **设置**：`aggregatorModel` (default deepseek/deepseek-v4-pro) / `aggregatorTimeoutMs` (default 600000) / `aggregatorMaxRetries` (default 1，transport 只 / NO prompt-level repair retry)。
>
> 本节下文 §4.3.1-§4.3.4 作为 v1 设计骨架 / 补补 保留作参考。

#### 4.3.1 调度

定时任务（不在 `agent_end` 跑），频率 daily / weekly / monthly 三层窗口。每层窗口跑一次独立 prompt。

**挂载点**：复用 §1.1 `scheduleDrainIfBacklog` recursive drain loop @ `index.ts:823`——bg drain 完成 + idle 时检测 last_aggregator_run，决定是否跑。

#### 4.3.2 prompt skeleton

对应 ADR 0024 §5.3（"持怀疑态度的史官 + 默认无发现就是成功 + falsifiability + sycophancy self-check"）。完整 prompt R2 展开。

#### 4.3.3 Classifier Health Meta-Check（附加任务）

每次 aggregator 跑完正常工作后，追加一段 prompt 让它审视最近 50 条 classifier audit trace：

- quote rate（含 verbatim quote 的比例）
- alternative mention rate
- concrete self-critique rate（不是 generic boilerplate）

任一维度 < 40% → 写 advisory flag 进 audit.jsonl，下次作者读诊断入口（§4.5）时看到。

**光看静态阈值不够**——如果 quote rate 从 95% 慢慢跌到 85%，不会触发 <40% 但跌幅本身值得关注。追加一条趋势检测：任一维度 7 天移动平均下降 ≥ 10 个百分点时也写 advisory flag（"classifier reasoning quality trending down"）。这条也是 prompt 里让 aggregator LLM 自己算的——给最近 50 条 trace 里前 25 条和后 25 条各算一个均值，比较差值。不要搞机械阈值逻辑。

#### 4.3.4 关键设计点（R2 已解决 2026-05-28）

- ~~调度机制~~ → **agent_end + 24h debounce sentinel** (scheduleAggregator in extensions/sediment/index.ts)
- ~~窗口大小~~ → **daily/weekly/monthly 三层窗口由 v1 prompt 自己分析**，不在 infra 层预定 (避免机械切分)
- ~~hypothesis → staging~~ → **v1 不写 staging，只 emit advisory**（跟 ADR 0024 §5.3 advisory not blocking 一致）
- ~~cron 资源~~ → **fire-and-forget 后台跑，单次 ~30s + ~10K token** (dogfood 验证)

### 4.4 Multi-view verification

> **实施状态 update (2026-05-28, post batch 6)**：§4.4.6 中记录的 batch 1-3 状态 (2026-05-24) 之后又有 4 个 commit cycle 落地，不拆另节如下：
>
> - `aggregator_engine` 三态字段晋升到 `AggregatorSummary` (顺手小活 #3, commit 974250a)
> - `summarizePriorAggregatorRuns` 读 last 8 ledger rows 馈 v1 prompt (commit 5130811)
> - `aggregatorModel` / `aggregatorTimeoutMs` / `aggregatorMaxRetries` settings + schema (commit 974250a)
> - audit row 加 `aggregator_engine` 字段跟 P1-1 round-2 closure (commit d144e4c)
> - `STRUCTURAL_CONTEXT` 静态注入 + staleness lint smoke (commit 974250a, drift 捡到 1 个 stale entry 当场删)
> - **multi-view writer dispatch v1 stub 未升 v2** (仍是 §4.4.6 D v1 限制)——待 path A 受制因素 v3 路线同期处理

#### 4.4.1 触发条件

- 置信度 ≥ 8 的 create
- 提升到 always tier 的 promote
- 归档高置信度 entry
- 跨区迁移（preferences → maxims）
- 用户主动纠错触发的 durable update（来自 §4.1）

#### 4.4.2 prompt skeleton

对应 ADR 0024 §5.4（两次独立 API 调用 / Blind Pass 1 / Reveal Pass 2 / anchor bias self-check）+ §4.1 开头 reasoning normalization preamble（共用）。

**两次独立的 API 调用是硬性要求**——一次调用里假装 "先 blind 再 reveal" 不可信。§6 已经接受 multi-view 翻倍成本。

#### 4.4.3 Devil's advocate 层

ADR 0024 §5.4 末尾承认 "跨基座仍有 RLHF 训练相关性"。为避免两个 reviewer 同方向错——Reveal Pass 2 末尾加：

```
You and the proposer reached agreement above. Before committing:

Play devil's advocate ONE MORE TIME. What is the strongest objection a
skeptical third reviewer — someone from a DIFFERENT model family with
DIFFERENT RLHF training — would raise against your shared conclusion?
Write this objection out in 1-3 sentences, citing specific evidence.

Then judge: does this devil's-advocate objection identify a real risk,
or is it strawman / generic? If real risk → downgrade your agreement
to DEFER. If strawman → keep your agreement but record the objection
in audit for future review.
```

纯 prompt-engineered 三拨 layer，不增加 API 调用（虚拟 reviewer）。

#### 4.4.4 跨 provider 策略（基于 §1.6 现实从 0 加）

**§1.6 给的现实**：extractor + curator 两个都是 deepseek 家单 provider。跨 provider 的配套设施完全没有。

**新增 settings**：

```ts
// extensions/sediment/settings.ts
interface MultiViewSettings {
  proposerProviders: string[];      // 例：["anthropic/claude-opus-4-7", "deepseek/deepseek-v4-pro"]
  reviewerProviders: string[];      // 例：["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]
  fallbackProviders: string[];      // rate-limit / error fallback
  costBudgetPerOpUsd: number;       // soft budget，超 → DEFER
}
```

**P0.5 最小版本**：写死的 fallback 名单上线（不动态选）；P3 完整版转动态选择 + rate-limit 处理 + cost 预算。

#### 4.4.5 关键设计点（R3 必须解决）

- provider 失败 / rate-limit 时的 fallback graceful 处理
- **DEFER 后的归宿**：reviewer DEFER 时，那个 op 是写 staging 还是直接丢弃？**默认写 staging**（与 §4.1.5 attribution_pending 同款路径），避免信号丢失
- 成本预算：每个高价值操作翻倍 token 调用，预估每月成本（dogfood 校准）
- 两 reviewer 同方向错的限制：devil's advocate 部分缓解；明确接受局限（同 ADR 0024 §6）

#### 4.4.6 Implementation status (post-batch 1-3, 2026-05-24)

P0.5 初始实现（commit `fec969e`）在选出后由三家 T0 reviewer（Opus 4-7 / GPT-5.5 / DeepSeek v4-pro）审查，识别出 4 条 P0 阻塞 + 7 条 P1。随后的 batch 1–3 (16 commits) 逐条修补。本小节记录“设计 (§4.4.1–4.4.5) 跟实现”的差异，以免后续 reviewer 重研。

##### A. §4.4.1 触发条件

设计劗5 条。**实现 (batch 1)** 扩充为含更 fine-grained 的 OR 触发路径（见§4.4 原始 5 条以外 + `update_high_confidence_candidate` / `update_high_confidence_neighbor` / `update_compiled_truth_rewrite` / `archive_target_not_in_neighbors` fail-safe）。 fail-safe 分支是 public-API defense （避免绕过 parseDecision 的 caller silently skip review）。

未实现： "提升到 always tier 的 promote" 、"跨区迁移”两条—— promote tier 语义依赖 §4.5 classifier prompt 演进 (未 ship)，cross-zone migration 依赖 ADR 0014 zone semantic clarification (未实现)。

##### B. §4.4.2 prompt skeleton + §4.4.3 devil's advocate

P0.5 使用 ` extensions/sediment/prompts/multi-view-pass{1-blind,2-reveal}-v1.md`，跟 §4.4.2 + §4.4.3 设计 1:1 实现。两次独立 API 调用 + Blind Pass 1 + Reveal Pass 2 + devil's advocate prompt 末尾 都在位。batch 1.5 G4 reviewer 反馈后给 Pass 1 prompt 加了 “Workflow-lane neighbors (HARD CONSTRAINT)” 章节 —— 避免 Pass 1 reviewer 推荐 workflow-lane 上的 destructive op。

##### C. §4.4.4 跨 provider 策略

P0.5 默认 settings (extensions/sediment/settings.ts)：
  - `reviewerProviders: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4-mini"]`
  - `fallbackProviders: []`
  - proposer 仍是单一 deepseek (curator 默认)

静态名单在 selectReviewerModel 中顺序选择。P3 计划动态选择 + rate-limit 处理 + cost 预算  4.4 全部设计跟进。

##### D. §4.4.5 关键设计点 — batch 3 重点修补

P0.5 初始实现在这里**产生了 R-series 三家 T0 reviewer 一致识别的 P0.3 冲击**：runMultiView 在 7 条 fallback path 上 silent 回退到 proposer 直写。这违反 §3.1 A' 层 "non-trivial create / destructive ops MUST be double-reviewed" 硬约束。

batch 3 全系列 (commits `3718d91` → `1a6f6f7`, 11 commits) 实施§4.4.5 · "DEFER 默认写 staging" 的全面推广：

  - 新 staging kind `multiview-pending` (独立于 `provisional-correction`)
  - 6 条 transient fallback path 都走 staging（`reviewer_unavailable` / `pass1_call_failed` / `pass1_unparseable` / `pass2_call_failed` / `pass2_unparseable` / `deferred`）
  - 第 7 条 `confirm_pass1_not_synthesizable` **保留 op=skip** 不 staging（设计同事以外：Pass 1 schema 缺 rich payload 是已知限制，staging 会 dead-loop。P1.5 护 Pass 1 schema 后可以重考虑）
  - Reviewer raw text 持久化：`<abrainHome>/.state/sediment/multi-view-metrics.jsonl` sidecar (batch 2)
  - agent_end 独立 Lane R 跟进 staging 重审，`MAX_REPLAY_PER_AGENT_END = 3` · retry caps `5/3 (transient/deferred)` · stale cutoff `14 天`
  - Replay terminal 走 “op=skip + 删除 + audit”（不依赖 §4.6 archive-reactivation prompt）

“一锁”补充设计点：

  - 跨设备 race（deepseek D2 design review 原担心）实测抵消—— `~/.abrain/.gitignore` line 2 是 `.state/`，staging 文件完全单设备本地存储。`originating_device` 字段限定为 audit marker，不 gate replay
  - A' 层默认错误策略：`writeMultiviewPending` throw IO/validation 错误 不 catch—— 本轮 candidate 丢失 优于 silent fall back to proposer 直写。Replay framework 错误 付 audit 阶段 catch
  - signal abort 不消耗 retry budget（batch 3c-i.5 fix R4）：abort 时 delete 新 staging + 原 entry attempts 不变
  - replay `triggered=false` 守 A' （batch 3c-i.5 fix R1）：replay 中 shouldTriggerMultiView 返回 false (e.g. neighbor archived 让 confidence 不足) drop candidate 而非 silent fall back

v1 限制 (P0.5 acceptable)：

  - `writeApprovedToBrain` stub—— replay 决定 op!=skip 时 audit `multi_view_replay_would_write` + `candidate_lost: true` 但**不实际调 op dispatcher**。需抽 `sediment/index.ts:2280-2440` 里的 300 行 op dispatcher 为独立函数后接入，留下一 phase
  - **原 turn vs replay 写脑不对称**（batch 6 T0 review 补记）：原 turn 走 `confirm_proposer` / `confirm_pass1` synthesizable 时 proposer / synthesized decision 会被常规写入脑 (curator 主路径)。但 staging 重审后走同样路径时，`writeApprovedToBrain` v1 stub 会抹去写脑动作。同一个 candidate 被 proposer 创建时 reviewer 同意则写，被 staging 重审时 reviewer 同意**仍不写**。A' 层不破（reviewer 跰了）但 INV-AUTONOMY “脑从自然对话学习” 出现隐性 gap。dogfood 用户 audit 里 grep `candidate_lost: true` 能陆续定量这个损失。
  - kill switch 复用 `classifierEnabled` (`settings.autoLlmWriteEnabled !== false`)—— v2 可加独立 `multiViewReplayEnabled`
  - `confirm_pass1_not_synthesizable` 依然 dead-loop 风险（candidate 下轮 extractor 可能重复产出）—— P3 加 candidate-identity throttle。本轮不拦截

T0 reviewer 同意上述 v1 限制不影响 A' 闭合 (Opus PASS、Sonnet re-verified、DeepSeek ship-ready)。batch 6 三家 T0 重审 (Opus 4-7 / GPT-5.5 / DeepSeek v4-pro) 返回 PASS / HOLD / PASS — GPT 找出的 ctx.signal 传递 P1 是 user pre-existing pattern 不在本批次范围。

**详细 invariant 表 + state machine + commit timeline：** 见 `docs/audits/2026-05-24-adr-0025-p0.5-multi-view-batch-1-3-implementation.md` (T3 dossier, ADR 0025 §6.3 指定模式)。

### 4.5 Classifier prompt 自身演进

#### 4.5.1 诊断入口

> **实施状态 (2026-05-28)**：`/abrain audit classifier [--limit=N]` 已 ship (commit 974250a, 顺手小活 #4)。实现于 `extensions/abrain/index.ts handleAbrainAudit`，输出最近 N 条 classifier audit row (compact 格式 含 typing / confidence / intent / user_quote / most_likely_error) + classifier health snapshot (含 7 天 rolling trend + significant_drop flag)。从 `/help` 推广文案 隐藏，符合 ADR 0024 §4.3 高级用户诊断入口处理。

`/abrain audit classifier` 命令展示最近 N 条 classifier reasoning trace，标红 advisory flag。**只是诊断入口，不是用户日常工作流**。从 quickstart / `/help` 推广文案中抑制（同 ADR 0024 §4.3 高级用户诊断入口处理）。

#### 4.5.2 `promptVersion` 配套字段（基于 §1.6 现实从 0 加，必须与 §4.1 P0 同期上线）

settings.ts 加字段：

```ts
interface PromptVersionSubstrate {
  activeCorrectionClassifier: string;   // 例: "active-correction-classifier-v1"
  multiViewPass1: string;
  multiViewPass2: string;
  outcomeSelfReport: string;
  aggregator: string;
  archiveReactivationReviewer: string;
}
```

audit.jsonl 每条记录含 `prompt_version` + semantic note + `reasoning_trace`：

```jsonc
{
  // ...existing audit fields...
  "prompt_version": {
    "active_correction_classifier": "v1",
    "_semantic_note": "v1 introduces evidence-first 6-step + bias cautions"
  },
  "reasoning_trace": {
    "step_1_quote": "...",
    "step_2_cases": {...},
    "step_2b_lean": "...",
    "step_3_disconfirmer": "...",
    "step_4_weight": "...",
    "step_5_commit": "...",
    "step_6_self_critique": "...",
    "step_7_self_rating": {...}
  }
}
```

**为什么必须 P0 同期**：缺这些字段几周后 prompt v2 读旧 trace 会出现软 schema migration 问题——v1 prompt 输出跟 v2 输出格式可能不同，audit reader 无法区分版本归属。

#### 4.5.3 跨 prompt 版本兼容

ADR 0024 §4.2 R7 加的 row "reasoning_trace 跨 prompt 版本兼容" 在这里落地：新 prompt 读旧 trace 时被 prompt 中的 `_semantic_note` 告知 "这是旧版 prompt 产出，提取 quote 和 uncertainty 即可，别套现在的 label"。

#### 4.5.4 不做的事

- **不**做月度自动 prompt diff job
- **不**做 LLM 自动改自己 prompt（闭环自我修改风险）
- **不**做 prompt accuracy threshold gate

人在 loop：作者发现 systematic blind spot → 手动改 prompt → 验证新 prompt 不引入回归用 fixture **仅供参考**，不是 ship-block gate。

### 4.6 静默归档 + 回滚窗口

#### 4.6.1 N 天窗口的具体值

建议 30 天，但需要 dogfood 验证。

#### 4.6.2 反证检测 prompt

N 天内 sediment 看到用户在自然对话里提到归档 entry 的内容时，让 curator LLM 直接判断：

```
You are reviewing an entry archived <N> days ago. The user in the
current conversation mentioned content related to this entry.

Decide: keep archived / reactivate.

CRITICAL: Distinguish "user merely mentioned the topic" vs "user is
actively using the entry's preference again". Mention alone is NOT
reactivation.

Default: keep archived. Only reactivate when there is a LIVE-USE BRIDGE
— specifically: user is currently performing a task where the entry's
preference is being applied AND the application is consistent with
the entry's content.

Cite both:
  - the archived entry's content (verbatim quote)
  - the user's current utterance (verbatim quote)

State which one supports your decision.
```

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

**重要：现状是 `autoLlmWriteEnabled` 默认 false，大多数用户没开 Lane C**。所以 phase 0 / 1 / 2 ship 在 default-off 下不影响大多数用户。这是天然的渐进 dogfood 安全网。

**⚠️ R10 三方审计三家一致要求：P1 开工前必须先验证 classifier prompt 在真实对话上的表现。** 这是硬性前置——不跑原型验证不准写 P1 代码。原型验证的要求：拿 50-60 条真实对话窗口（20 条明显该有 correction、20 条模糊、20 条明显不该有），用 §4.1.3 prompt 跑 3 个不同 model，人工 review：(a) 7 步顺序是否被遵守（step 2b 真的在站反面还是走形式？）(b) 误判率——该 null 却 produce signal / 该 durable 却判 task-local 的比例 (c) staging provisional 的创建率 vs resolve 率。原型通过标准：false positive rate < 20%（考虑到还没 multi-view 保护，这个门槛比 P5.5 的 15% 宽松），且 step-skipping 率（明显跳步或合并步的比例）< 15%。原型不过 → 回炉调 prompt 重跑 → 再不过 → 考虑拆 prompt（DeepSeek 建议的 Call 1 分类 + Call 2 staging resolution 两段式）。

| Phase | 范围 | 工程量 | 阻塞前置 |
|---|---|---|---|
| **P0** | 只动配套基础：`promptVersion` 字段 + audit schema 扩展 + multi-provider settings 接口 + staging 目录创建 | 小 | 本 ADR ship |
| **P1** | §4.1 主动纠错识别完整能力：correction-pipeline + classifier prompt + staging-loader + Lane A/C/G 三处挂载点 | 大 | P0 |
| **P1.5** | §4.4 multi-view 最小版本：写死的 provider fallback 名单 + Pass 1/Pass 2 拆分；仅覆盖 §4.1 conf≥8 durable + 高置信 archive | 中-大（R9 audit 共识：跨 provider 配套涉及的文件多，"中" 偏乐观） | P1 |
| **P2** | §4.2 outcome self-report（默认起点选方案 C，等 §5.2 ADR 0003 决策） | 中 | P1（要 classifier 消费 outcome 数据） |
| **P3** | §4.3 aggregator + Classifier Health Meta-Check | 中-大 | P2（要 outcome 历史） |
| **P3.5** | §4.4 multi-view full：dynamic provider 选择 + rate-limit + cost 预算 + DEFER 处理 | 大 | P1.5 dogfood |
| **P4** | §4.5 classifier prompt 演进：诊断入口 `/abrain audit classifier` + iteration ritual | 小-中 | P1 数月 dogfood 后 |
| **P5** | §4.6 静默归档 + 回滚窗口 | 中 | P1（要 classifier 识别 reactivation 信号） |
| **P5.5** | `autoLlmWriteEnabled` 默认值改 true 决策（见 §5.3） | 极小（一行 settings）+ dogfood 数据支撑 | P1-P5 全部 ship 数月 dogfood |
| **P6** | 废弃 `/about-me` + `MEMORY-*:` 围栏这几个反模式（见 §5.4 同步反向 patch ADR 0024 §4.2） | 中（含迁移文案） | P5.5（ADR 0024 设想默认开启后才能动现有入口） |

**并行轨**：P0 / P1 配套基础必须串行；P1.5 + P2 + P3 跨 phase 可并行；P4 + P5 可并行。**P5.5 / P6 是 ADR 0024 设想跑通之后才碰的**——不要在设想没真跑起来前去动现有入口。

### 5.2 §3.2.A ADR 0003 三选项决策点（R2+ 必答）

R2+ multi-LLM audit 必须 explicit 评估以下问题才能选项：

1. **AI-Native + multi-view 能不能提供跟 sandbox 同等的 prompt injection 防护？** R7 audit 21/21 PE-form 是 RLHF 偏置阻断证据；能不能防恶意 injection 需 dogfood + 独立评估
2. **active correction latency 实际是几秒？几轮对话？几分钟？** P1 ship 后量化，决定 "是否足够破坏延伸大脑体验"
3. **outcome self-report 方案 C（`memory-footnote` + sidecar）vs 方案 A（本人直接写 ledger）实际质量差多少？** P2 ship 后双试验
4. **选项 2/3 的 ADR 0003 / 0010 / 0013 要改多少？** §1.5 提到现在已经开了几个口子（vault_release / prompt_user 是先例），这暗示选项 2 工程量比 R1.2 估计的低；选项 3 工程量可能超出本 ADR 主体

**默认起点**：选项 1（保留 ADR 0003，outcome 走方案 C）。但 R2+ 评估后允许跳到 2 或 3。

### 5.3 `autoLlmWriteEnabled` default 改 true 决策点（新 — §1.4 现实驱动）

**2026-05-24 状态更新：部分完成**。
默认值已改 `true`（commit `<本提交>`），tristate `boolean | "staging-only"` 退路已接入、ADR 0024 §6 代价 #10 反向 patch 已落。

注：下面三条 R2+ 必答 + 三条硬条件是原设计送付门槛。**本仓是单用户项目（alfadb）**，其中“3 用户 × 4 周”结构性不可能满足。单用户 dogfood 实证可用信号：
- 77 次 classifier 运行、5 次 durable conf 7–8 命中（质量看起来健康，但 typing 路由未实现 §4.1 T1-1 前无法直接计算 false-positive 率）
- 495 次 create operation 在用户本地 `autoLlmWriteEnabled: true` override 下跑过，未出现 manifest 用户投诉
- 9 条 staging provisional，远低任何胀胀阈值

P5.5 原设想的三条硬条件是为了“原作者不在看时防静默 durable 区污染”设计的。单用户仓里**用户 = 作者**，错沉淀表现为直接的 dogfood 挫败 —— 反馈环比三用户 dogfood 设想的紧得多。因此在该仓上以“用户授权 + 三态退路在位”为前提提前跳过三条硬条件。

**仍待完成**：§4.1 T1-1 typing 路由部分完成（2026-05-24 commit `<dispatch-helper>`）：debug 不进 curator、task-local 不污染当前 curator、durable 保留 curator forward；session-local working set 未实现（task-local 从未来 curator 丢失）。现在 audit 能直接按 dispatch decision (`forwarded_to_curator`/`dropped_debug`/`dropped_task_local`/`dropped_unknown_typing`) 分 bucket 计算 false-positive 率，一旦积累一段时间可回头验证本次跳过硬条件的决策是否被数据证伪。

---

R2+ 必答（历史记录，以下问题仍适用于多用户仓增量评估）：

1. P1-P5 ship 后**积累几个月 dogfood 数据**：classifier 在 P1.5 multi-view 保护下的 false positive 率？错沉淀的频率？
2. 跨设备错误传播代价（ADR 0024 §6 #1）实测有多大？
3. 用户被要求为 sediment 做管理事务的频率有多高（应该几乎 0，验证 INV-INVISIBILITY 管理负担部分落地）？注意**不是**"用户感知到 sediment 运行的频率"——后者接近每次会话（footer / notify 会告诉用户），是健康的运行状态指示，不违反 INV。

**默认起点**：P5.5 时**默认值改为 true**。但允许保留一段用户主动开启的过渡期（如 `autoLlmWriteEnabled: "rollout"` 渐进灰度）。

**开启前必须过的几个硬条件**（不说 "几个月" 这种模糊的，给具体数字）：
1. 至少 3 个用户 × 4 周实际跑过 P1-P5，classifier 的 false positive rate（判成 durable 实际是 task-local 或 NOT-A-CORRECTION 的比例）< 15%。这个数据来自人工抽查 audit trace。
2. 用户在 dogfood 期间没有因为 sediment 的错误行为（误归档 / 误归 durable 导致 LLM 按错偏好行动）投诉过。
3. staging 膨胀率不失控：月新增 < 50 条，resolve 率 > 30%（不然 staging 堆成垃圾场）。

**万一改 true 后出事怎么回滚**：加一个全局开关 `autoLlmWriteEnabled: false`——跟现状一模一样，值改回 false 立刻关掉整个 auto-write 链路。再加一个 staging-only 模式（`"staging-only"`）：classifier 正常跑、正常写 staging，但不出 durable 写操作——等于把整条 Lane C bg 降到只观察不行动。P5.5 ship 时这两个开关都要在，不然等于没有退路。

**反向 patch**：ADR 0024 §6 需要明确承认 "默认开启之后用户察觉不到的偏差累积是首次真正存在的代价"——这跟 §2.3 评估一致。

### 5.4 反向 patch 下游 ADR 清单

| 下游 ADR | patch 内容 | 触发 phase |
|---|---|---|
| **ADR 0024 §4.2 反模式表** | 加 deprecation timeline / clarify `/about-me` + `MEMORY-*:` fence 在 P6 前是过渡期合法路径 | P6 |
| **ADR 0024 §4.3 灰色地带表** | 删/软化 "同一类纠错跨会话重复 ≥ 2 次自动升级为 durable" 机械门 — 跟 §3 AI-Native + 本 ADR §4.1.4 矛盾，改为 "由 aggregator prompt 跨会话趋势判断" | P3（aggregator ship 时） |
| **ADR 0023 R5 unified classifier patch** | 加 `correction_signal` 输出维度（如选 §3.3 unified call X）或拆为多个专精 classifier（如选 Y/Z）；同步本 ADR §3.3 R2+ 决策 | P1 |
| **ADR 0014 七区 layout** | 如 §4.1.5 选项 S（sidecar staging）→ 七区列表加一条说明 sidecar staging 不计入七区 invariant #7 | P1 |
| **ADR 0015 memory_search corpus** | 如 §4.1.5 选项 P（复用 Lane G staging）→ 已经 OK；选项 S（sidecar）→ 加 staging-loader corpus 例外说明 | P1 |
| **ADR 0016 curator 7 op** | 如新增 op（`promote-to-staging` / `reactivate-from-archive`）→ 同 PR patch | P5 |
| **ADR 0018 sanitizer** | 如选 §3.2.B 选项 3 混合 → patch sanitizer 接口 + 加 LLM advisory hook | P2 或更晚（dogfood §4.1 误 redact 频率后定） |
| **ADR 0020 transport-only sync** | §4.6.4 archive_at 跨设备字段 + §4.1.5 originating_device 同步语义 | P5 |
| **ADR 0003 主会话只读** | 如 §5.2 选项 2/3 → 同 PR patch（加上口子清单或重写 sandbox 边界） | P2 或更晚（§5.2 决策点） |

**反向 patch 不同 PR 交付 → 本 ADR Pn 不准 ship**。

---

## 6. 测试设计（三层 smoke）

按 ADR 0024 §3 AI-Native 原则，**三层 smoke 都不是 ship-block gate**——只用于 "留信号给作者"，不阻断写入。

### 6.1 Tier 1 — 自动断言（机械可验证的局部约束）

- classifier 输出符合 JSON schema（`CorrectionSignal`）
- staging entry frontmatter 字段齐全
- 软归档 entry 在 N 天内文件仍存在
- multi-view 触发条件命中时确实跑了两次独立 API 调用（log 验证）
- `prompt_version` 字段在每条 audit row 都存在

结构性验证，fail = bug 必须修。**Infra 层机械合法**（同 ADR 0024 §3 三态标注）。

### 6.2 Tier 2 — LLM-as-judge advisory

- 用一个独立 LLM 读 classifier 在 30 个 fixture utterance 上的 reasoning trace，按 §4.1.3 bias cautions 9 条打分
- 输出 advisory report：哪几个 trace 看起来 post-hoc rationalization / 哪几个 anchor bias 严重
- **不是 ship-block**：分数低不阻断，只留 advisory flag 给作者改 prompt

### 6.3 Tier 3 — 信息对照 dossier

- 每次 prompt 重大改动后，跑一份 dogfood 对比 dossier：旧 prompt vs 新 prompt 在最近 100 个真实 utterance 上的输出差异
- 不是测试，是给作者 review 的对照表

每个 Phase 实施时按上面三层各做一份，存 `docs/audits/2026-XX-XX-adr-0025-pN-smoke.md`。

---

## 7. 与 ADR 0024 边界的对齐自检

每个 Phase ship 前必须走这张表。任何 ✗ 触碰 → 该 Phase 不能 ship，必须先回 ADR 0024 调 invariant。

### 7.1 Invariant 边界

| # | ADR 0024 边界 | 本 Phase 检查 |
|---|---|---|
| 1 | INV-INVISIBILITY（不要求用户做事） | 任何 `prompt_user` 位于 sediment 生命周期 / `[Y/N]` 审批弹窗 / "请处理" 提示？✗ 必须避免。纯告诉 (`notify("X done", "info")` / footer 状态) 是 ✓ 合法反馈 |
| 2 | INV-INVISIBILITY（staging 不被误推为需用户裁决） | staging 条目是否可能通过 curator 错误操作间接要求用户裁决？✗ 必须避免 |
| 3 | INV-AUTONOMY | 任何 `prompt_user` 询问 sediment 生命周期 / `/rule veto` / 月度 manual workflow？✗ |
| 4 | INV-IMPLICIT-GROUND-TRUTH（不走元 UI） | 任何信号收集走元 UI 不走自然对话？✗ |
| 5 | INV-IMPLICIT-GROUND-TRUTH（充分利用） | 本 Phase 是否充分利用 acceptance / 沉默 / 跟进 / 修改 等隐式信号？✓ |
| 6 | INV-IMPLICIT-GROUND-TRUTH（不诱导反馈） | 任何 `agent_end` prompt 是否可能诱导主会话 LLM 主动向用户收集反馈？✗ |
| 7 | INV-IMPLICIT-GROUND-TRUTH（LLM 解释 ≠ 用户信号） | outcome / multi-view / aggregator 是否被误升为 ground truth？✗ |
| 8 | INV-ACTIVE-CORRECTION | classifier 能稳定识别 task-natural 纠错？✓ 必须 |

### 7.2 AI-Native 原则（3 态标注）

| 状态 | 检查 |
|---|---|
| ☑ PE-form | LLM 行为层防出错走 prompt 工程？✓（默认期望） |
| ☑ Infra | 持久化基础设施（JSON parse / schema validate / file I/O / git op / audit log）走机械？✓（允许） |
| ✗ Mech-on-LLM | LLM 行为层加机械门（schema 拦截 / 阈值 / 哈希 / TTL / smoke-as-block）？✗（违反 → 必须 justify (1) PE-first 不够 (2) Infra 决不了 (3) 仅限局部范围 + 未来移除条件） |

### 7.3 §4.2 反模式

本 Phase 是否引入或还原以下反模式？任一触发 → ✗。

- LLM 问 "沉淀为规则吗?" / 学习周报附带"请审查并标错"等 要求用户裁决 / 审批 / 点选项 的弹窗 (纯告诉弹窗/footer/notify 不是反模式 —— 2026-05-24 误删后澄清)
- `MEMORY-RULE:` / `MEMORY-ABOUT-ME:` 围栏让用户手动注入（**例外**：P6 之前是过渡期合法路径，§3.2.C）
- `/rule add` / `/rule veto` / `/about-me`（**例外**：P6 之前是过渡期合法路径）
- 月度 sediment self-improve 要用户主动跑
- `/brain health` 自动展板让用户检视
- 机械关卡替代 prompt 工程作为 LLM 行为层主要防出错手段
- fixture 准确率当发布拦截关卡
- 预定义枚举字段替代 LLM 自然语言推理

### 7.4 §6 接受的代价

本 Phase 是否显式 acknowledge 以下代价？任一项未 acknowledge = 设计漏接受面。

| # | 代价 | 本 Phase 额外需求 |
|---|---|---|
| 1 | 错误传播跨设备 | ADR 0020 sync 是否能在 N 天回滚窗口内正确传播反证 |
| 2 | 偶发 "假高置信" | dogfood 校准 "数周到数月" 假设 |
| 3 | 静默归档误删 | reactivation prompt 必须 ship（§4.6） |
| 4 | 跨设备最终一致延迟 | staging 加 `originating_device` 字段（§4.1.5） |
| 5 | 错沉淀内容察觉不到（2026-05-24 重措辞） | aggregator + Classifier Health Meta-Check（§4.3）。注：footer / notify 会告诉用户《发生了什么》（X created/updated）但不要求审阅内容——偏差仍可能累积。 |
| 6 | 主动纠错疲劳 | 不强制 N=2 机械升级（§4.1.4） |
| 7 | Multi-view 翻倍调用成本 | P3.5 ship 后验证实际 vs 预期 |
| 8 | 早期推理质量参差 | classifier §4.1.3 step 7 self-rating + audit |
| 9 | LLM 推理失败本底概率 | multi-view 部分补偿；devil's advocate prompt（§4.4.3） |

### 7.5 §7 走偏信号

本 Phase ship 前检查 ADR 0024 §7 走偏信号 1-7 中的任何一条是否已触发。另需补充检查：staging 区 age-out 率 + 未 resolve 率是否持续 > 60%。

### 7.6 下游 ADR 边界

本 Phase 是否触及以下 ADR 边界？任一触及 → 在该 ADR 项下逐项说明不违反原 invariant（§5.4 反向 patch 清单）。

- ADR 0003 主会话只读 → §5.2 决策
- ADR 0014 invariant #7（七区互斥） → §4.1.5 staging 路径选项 S 是否第 8 区？
- ADR 0017 strict-binding → project-rules 注入不泄漏
- ADR 0018 sanitizer → §3.2.B 机制升级是否破 A' 结果
- ADR 0020 transport-only → §4.1.5 originating_device + §4.6.4 archive_at
- ADR 0022 prompt_user contract → 仅任务相关，不是 sediment 生命周期决策

### 7.7 代码现实校验（v2 新增）

本 Phase 上线时 §1 描述的代码现实是否还成立？

- 两条 lane（Lane A/G 同步 + Lane C 后台）结构是否还同 §1.1？
- 七区列表是否还是 7 个？新增 zone 是否 §5.4 同步 patch 了 ADR 0014？
- sanitizer 14 类 regex 是否还是这些？升级混合方案时是否 §5.4 同步 patch 了 ADR 0018？
- `autoLlmWriteEnabled` 现行默认值是什么？还是 false 还是已改 true？跟 §5.3 决策一致？

### 7.8 高级用户诊断入口

`/abrain audit classifier` / `/rule list` / `/abrain status` 等诊断入口是否在 quickstart / `/help` / 推广文案中被抑制？✓ 必须（符合 ADR 0024 §4.3）。

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
- [ADR 0025 R0 R8 prompt-engineering review](../audits/2026-05-22-adr-0025-r0-prompt-engineering-review.md) — v1 R0 三家 T0 平均可行性 61%，6 个 P0 + 1 P1 + 7 盲点全部在 v1 R1 / v2 §4 落地

### v1 → v2 重写过程的 git 锚

- v1 R0 起草：`bd16805`
- v1 R0 R8 audit：`16cca23`
- v1 R0 → R1：`613cb48` + `a59f368`
- v1 R1 → R1.1：`8eabc72`（约束分层 A/B/C）
- v1 R1.1 → R1.2：`417730f`（ADR 0003 张力识别）
- v2 重写（本文件）：（commit 待 Phase D rename 后产生）
