# ADR 0022 — `prompt_user` LLM-facing 同步问答工具（与 `vault_release` 共享 PromptDialog substrate，独立语义）

- **状态**：Accepted (R4 P0 收敛 2026-05-17)。R3 综合稿 → R4 multi-LLM P0 审计 (opus-4-7 / gpt-5.5 / deepseek-v4-pro 并行) → P0 收敛轨迹 3 → 0（GPT 找 P0×3 / DEEPSEEK 找 P0×2 / OPUS P0=0）→ 本版本应用全部 R4 修补包。详见文末 §"R1-R4 multi-LLM design discussion trail"。
- **依赖**：[ADR 0014](0014-abrain-as-personal-brain.md) §6（sub-pi 三层 guard、单一沉淀者、layer 1 不变量、invariant #5 vault 明文授权）、[ADR 0016](0016-sediment-as-llm-curator.md)（prompt 引导 > 机械门控；sediment 是唯一 brain writer）、[ADR 0018](0018-sediment-curator-defense-layers.md)（curator defense 边界；不退化 trigger phrase / body preservation）、[ADR 0019](0019-abrain-self-managed-vault-identity.md)（vault identity 边界、fail-closed）、[ADR 0020](0020-abrain-auto-sync-to-remote.md) §invariant 7（`redactCredentials` 已 codified）、[ADR 0021](0021-lane-g-identity-skills-habits-writer.md) §D4（Lane G G2 `/about-me` 与本 ADR 的关系）
- **扩展**：现有 `vault_release` / `authorizeVaultRelease` / `releaseSessionGrants` substrate；不替换、不重命名，仅共享 PromptDialog UI overlay 组件与一组提升后的 redaction primitives
- **触发**：三家主流 CLI（Claude Code `AskUserQuestion` v2.0.21+、Codex `request_user_input` 2026-02-26、OpenCode `question`）在 2025-2026 全部上线同类 LLM-facing 同步问答工具，形态高度收敛。pi-astack 当前唯一让 LLM 问用户的机制是把问题写进 transcript → turn 结束 → `agent_end` → sediment 拿到半截上下文，UX 差且 sediment 时机错乱。需要 turn 内同步 await 的结构化 question tool。

---

## 1. 背景

### 1.1 当前痛点

主会话 LLM 经常需要等用户决策（"用哪个 framework / 真要 deploy / 哪个 PR 先合 / 框架升级到 v18 还是 v19"）。今天唯一手段：

1. LLM 把问题写成 assistant text → turn 结束
2. `agent_end` 触发 sediment
3. sediment 看到的是"提了问题但用户还没答"的残缺上下文
4. 用户下一轮回答 → 新 turn 开始 → LLM 把答案 stitch 回来

两个具体问题：

- **UX**：用户看到一段普通 markdown，options 排版靠 LLM 自己拼，没有 chip / 焦点 / 自由文本 fallback / 键盘导航 / multi-select / masked input。3+ options 时用户肉眼扫读比点选慢 2-5 倍。
- **sediment 时机错乱**：`agent_end` 在 LLM 等回答时触发，sediment 拿到的是 *"开了一个 question，body 是 '你想用 Next.js 还是 Remix？'"*。这条信号既不是"事实"也不是"偏好"。sediment 现在的 prompt 不会强 reject 它——curator 可能把"用户考虑 Next.js"沉淀进 `projects/<id>/knowledge/`，污染 substrate。

### 1.2 三家方案为何成为行业标准

| 维度 | 三家共识 |
|---|---|
| Tool shape | 一次调用 1–4 questions × 2–4 options × `{label, description}`；命名几乎一致 |
| Schema | `header`（短 chip）+ `question`（完整句子）+ `options[]` + `multiSelect` 或 `type` |
| 自由文本 | 三家全部强制提供 "Other" 逃生口（Claude client 自动加 / Codex server `normalize` 强制 `is_other=true` / OpenCode `custom: true` 默认） |
| Subagent 拒绝 | 三家全部 fail-fast（Codex `is_non_root_agent()`、Claude defer、OpenCode session-bound finalizer） |
| 返回值 | 结构化对象 `answers: { [id]: string[] }`，always array |
| Permission/Question 关系 | 行业有分歧：Claude 合并 `canUseTool`，Codex/OpenCode 分开两个 substrate。pi-astack 选 OpenCode 路线（见 §2.A） |

行业把它做成 first-class tool 而不是 transcript 文本的根本原因：**"LLM 等用户"在 agent loop 中是一种与"调用工具"语义平级的 yield 点**，必须有专属 substrate（pending state、cancel、timeout、redaction）。pi-astack 已经在 `vault_release` 上踩过这条路（grant 状态、UI authorization、audit lane、i18n），现在把它推广到一般化 question 上是顺水推舟。

### 1.3 与 pi-astack 设计哲学的对齐

- **prompt 引导 > 机械门控**（ADR 0016）：是否调用 `prompt_user` 由 LLM 决定。我们不写 "每次 message > 200 字符自动 prompt" 这类自动化。
- **单一沉淀者**（ADR 0016）：`prompt_user` 不写 markdown，只写 `audit.jsonl`；sediment 在下一个 `agent_end` 自然 pick up question + answer 的完整对，curator 现在拿到的是"问题+答案"对而不是"残缺半截"。
- **fail closed**（ADR 0019）：UI 不可用 / sub-pi / secret context 出错 → 拒绝，不 fallback 到 plaintext 普通文本。
- **typed redaction 而非 silent reject**（ADR 0016 sanitizer）：secret 边界优先 redact + 继续，而不是抛 exception 整体失败。

---

## 2. 三家分歧 — pi-astack 的选择

| # | 分歧 | pi-astack 选择 | 理由 |
|---|---|---|---|
| **A** | permission 与 question 是否合并到同一 LLM-facing tool | **❌ 分开**（OpenCode/Codex 模式） | `vault_release` 是"敏感数据释放 + 用户授权"安全语义；`prompt_user` 是"等用户决策"通用语义。合并会让 LLM 误把 credential release 当普通问答，弱化 ADR 0014 invariant #5 的 namespace-level signal，也污染 audit lane 与 prompt discipline。**底层 UI substrate 共享**（同一个 `<PromptDialog>` overlay 组件，variant 不同），**LLM-facing API 完全分开**。 |
| **B** | 是否原生支持 `type: "secret"` masked input | **✅ P0 启用，但严格 placeholder-only** | masked input 是真实需求（Codex 已上线，Vault P0d 也需要）。但 raw secret **不返回 LLM、不写 audit、不进 sediment transcript**；tool result 只返回 opaque placeholder `[REDACTED_SECRET:<id>]`；audit 只记 `lengthBucket: "1-8"\|"9-32"\|">32"`；**不**通过 sessionVaultKeys 写盘。明确：`prompt_user(type:"secret")` 不释放 vault secret、不能 bypass `vault_release`，只是让用户输入一次性 token 后由 caller-side extension（如 follow-up 的 vault P0d wizard）短期使用。raw secret 在 PromptDialog overlay 闭包中以 caller 的 callback 形式消费。 |
| **C** | 是否支持 defer / resume | **❌ 不支持** | 需要持久化 pending question state、关联 session id、shutdown 后恢复。pi-astack 当前 session lifecycle 由 pi runtime 决定，abrain 没有 session 续盘机制。ROI 不够；P0 backlog 留位。 |
| **D** | `header` 长度上限 | **12 display cells**（按 terminal visible width，不是 JS `string.length`） | 与 Claude/Codex 对齐；TUI chip 渲染在 80-col 终端 + 4 个 question 横排时，> 12 cells 会触发省略或换行。中文/全角字符必须按 cell 计算，否则 `"设置数据库连接"` (= 7 chars = 14 cells) 会爆 chip。超长直接 `schema-invalid`，不 silently truncate。 |
| **E** | "Other" 自由文本是否强制开 | **✅ 强制开，server normalize，LLM 无法关闭**（Codex 模式） | 用户必须有 escape hatch。LLM 自己写了 `"Other"`/`"其它"`/`"其他"` 等同义 label 由 server 去重为 canonical Other。**不引入 `forbidOther` LLM-controllable 字段**——如果真有 ExitPlanMode-like 不可逃逸场景，那是另一个独立工具（参考 Claude 的 `ExitPlanMode` 与 `AskUserQuestion` 分离），不应通过本 ADR 加字段补。`vault_release` variant 在内部走 PromptDialog 时由 caller-side 配置 suppress Other，**与 LLM-facing schema 无关**。 |
| **F** | Question 数上限 | **4** | Claude 12k 用户经验上 4 已接近用户认知带宽上限；3（Codex）太紧（多一个 question 就要发两次 tool call，破坏 atomic 决策语义）；任意数（OpenCode）会让 LLM 把不相关问题塞一起。 |

---

## 3. 决策

### D1. 工具 schema 与返回值（最终版）

```typescript
// extensions/abrain/prompt-user/types.ts (新文件)

export type PromptUserQuestionType =
  | "single"      // 单选 options，必须提供 options[]
  | "multi"       // 多选 options，必须提供 options[]
  | "text"        // 自由文本，omit options[]
  | "secret";     // masked input，omit options[]；返回 placeholder

// R7.2 (2026-05-17): 合并双字段为单字段 label, 并删除所有长度限制。
// 原 「{label, description}」设计是业内 (cc/codex/opencode) 作法但 LLM
// 实际写时二者意思重复。合并后 LLM 可写“TypeScript”或
// “TypeScript — 强类型 web 全栈”, 长度自决, OptionList 自动 wrap。
export interface PromptUserOption {
  label: string;             // 任意长度, OptionList 自动 wrap 多行
  recommended?: boolean;     // UI 在 label 末加 " (Recommended)"；不影响返回值
}

export interface PromptUserQuestion {
  id: string;                          // /^[a-z][a-z0-9_]{0,31}$/，snake_case，call 内唯一
  header: string;                      // 任意长度 (R7.2: 删 12 cells 限), pi-tui Text 自动 wrap
  question: string;                    // 完整句子，非空, 任意长度
  type: PromptUserQuestionType;
  options?: PromptUserOption[];        // 2–4，type: single|multi 必填；text|secret 必须省略
}

export interface PromptUserParams {
  reason: string;                      // why pause — non-empty, 任意长度, sanitized + audited
  questions: PromptUserQuestion[];     // 1–4
  timeoutSec?: number;                 // clamp [30, 1800]，default 600
}

export type PromptUserResult =
  | { ok: true;
      answers: Record<string, string[]>;   // always array；single/text/secret 也 length=1
      durationMs: number;
      // 仅当包含 type:"secret" 时出现；answers[id] 内为 placeholder。
      redactions?: Record<string, { type: "secret"; placeholder: string }>;
      // R4 fix：D8.4 soft cap warning 也走 detail，因此 success branch 同样可有 detail。
      // sanitized short string；LLM 可读但 non-fatal。
      detail?: string;
    }
  | { ok: false;
      reason:
        | "user-rejected"            // 用户在 dialog 内显式 Cancel/Esc/选 "No"
        | "timeout"                  // 超过 timeoutSec
        | "ui-unavailable"           // !ctx.hasUI 或 §D7 fallback 下也不可用 (R6 删除 terminal width 档)
        | "subagent-blocked"         // PI_ABRAIN_DISABLED=1
        | "schema-invalid"           // params 不符合 schema（含 concurrent pending：见 D8）
        | "cancelled";               // ctx.signal abort 或 session_shutdown
      durationMs: number;
      detail?: string;               // sanitized, short, for model debugging
    };
```

**关键不变量**：

1. `answers[id]` 永远是 array（即使 `single` 答案 length=1）。LLM 端代码无 branch；与三家共识一致。
2. `text` 类型答案 array.length=1，element = sanitized free-text。空输入出现在 single 上是 no-op (不推进)，但在 multi 上允许 length=0。
3. `secret` 类型答案 array.length=1，element = `[REDACTED_SECRET:<id>]` placeholder；raw secret 不通过 tool result 返回。
4. "Other" 文本以普通 string 出现在 answer array 中；audit row 标记 `via=other`；LLM 视角下与预设 label 平权。R7.3: 多选模式下 Other 是否计入 answer 完全由 otherText 是否非空推导, 不需要 explicit toggle。
5. Schema validation 失败 → `ok:false, reason:"schema-invalid"`，**不抛异常**（ADR 0020 §Constraint 4 同款 no-throw policy）。
6. `durationMs` 在 success 与 failure 路径**都**返回，便于 audit 与 LLM 判断 cancel/timeout 区别。
7. **R7.2 schema 简化**: 所有用户可见字段的长度限制 (MAX_HEADER_DISPLAY_CELLS / MAX_REASON_LEN / MAX_QUESTION_LEN / MAX_OPTION_LABEL_LEN / MAX_OPTION_LABEL_WORDS / MAX_OPTION_DESC_*) 以及 4KB payload 软上限全部删除。保留的是「结构性 + 安全性」检查: 1-4 questions / 2-4 options / ID_REGEX / VALID_TYPES / INV-G 字段拒 / control chars 拒 / timeoutSec clamp。LLM 自决长度，TUI 自动 wrap。
8. **R7.2 字段合并**: PromptUserOption 删除 `description?: string` 字段, 合并到 `label`。老 LLM 仍传 description 被 validator silent-drop (避免迁移期间中断)。INV-D 从 5 字段 (reason / header / question / option.label / option.description) 减为 4 字段。

返回示例：

```jsonc
{
  "ok": true,
  "answers": {
    "framework": ["Remix"],
    "deploy_envs": ["staging", "prod"],
    "free_form_note": ["please don't auto-merge"],
    "one_time_token": ["[REDACTED_SECRET:one_time_token]"]
  },
  "redactions": {
    "one_time_token": { "type": "secret", "placeholder": "[REDACTED_SECRET:one_time_token]" }
  },
  "durationMs": 8432
}
```

> _[基础: OPUS §3.D1，去掉 `forbidOther`；吸收: GPT D1 display-cells / failure reason 枚举扩到 6；吸收: GPT D6 placeholder + redactions 字段]_

### D2. 与 `vault_release` 的合并范围

| 问题 | 决策 | 理由 |
|---|---|---|
| **(1) UI 渲染**：能否换成同一 `<PromptDialog>` overlay？ | **✅ 共用组件，不同 variant**。新组件 `extensions/abrain/prompt-user/ui/PromptDialog.ts`，接收 `variant: "question" \| "vault_release" \| "bash_output_release"`。`authorizeVaultRelease` / `authorizeVaultBashOutput` 内部走 `ctx.ui.custom(PromptDialog, {variant: ...})`，**视觉 affordance 改善**（红框 + key/scope/reason 显式 chip）。 | UI 一致性 + 单一交互路径维护 + 键盘导航/主题/i18n/IME 统一。 |
| **(2) Tool 名字**：保留 `vault_release` 还是合到 `prompt_user`？ | **✅ 保留 `vault_release` 独立 LLM-facing tool** | 三个理由：(a) `vault_release` 已通过 ADR 0014 §6 sub-pi guard / ADR 0019 vault identity edge 的多轮审计；(b) prompt guideline 完全不同（"reason: 为何 plaintext 必须进 context" vs "reason: 为何暂停问用户"），合并会稀释 prompt discipline；(c) grant 状态有 session/remember 模型，prompt_user 没有 stable join key。tool name 本身就是 ADR 0014 invariant #5 的 namespace-level signal。 |
| **(3) Grant 状态逻辑放哪？** | **保留在 `extensions/abrain/index.ts`** | `releaseSessionGrants` / `releaseRememberDenies` / `bashOutputSessionGrants` 三个 in-memory Set 全留在 abrain 模块。`prompt_user` **不引入 remember 概念**——每次 question 都是 fresh，因为 question 文本是动态的，没有 stable join key。 |
| **(4) Audit lane 是否统一？** | **❌ Lane 分开，writer helper 共享** | 新增 lane `prompt_user`；保留 lane `vault_release` / `bash_inject` / `bash_output`。**共享**底层 `safeAuditAppend()` + sanitizer + truncate helper（位于 abrain 内部，**不**提升到 `_shared/`）。检索语义不同：vault auditor 按 key 查"哪些 secret 被释放"；prompt_user auditor 按 turn 查"LLM 何时停下问什么"。Schema 也不同（vault 的 op enum 是 release/release_denied/release_blocked，prompt_user 是 ask/response/blocked），合并 lane 会强迫 consumer 反复 switch type。 |
| **(5) Sub-pi 三层 guard 如何复用？** | **完全继承 `PI_ABRAIN_DISABLED=1` 三层 guard**，不引入新 env var | `prompt-user` 不是独立 extension，而是 abrain extension 内部 module（`extensions/abrain/prompt-user/`），自动继承：(a) dispatch spawn 端 env 注入；(b) abrain `activate()` early-return 不注册 tool；(c) handler 内 fail-fast 第三层。详 §D3。 |

**vault_release UI 迁移的 fallback 保留期**：`authorizeVaultRelease` 改成 `ctx.ui.custom(PromptDialog, ...)` 后，**保留**原 `ui.select(title, choices)` 路径作为 fallback（在 custom throw 或 unavailable 时降级），至少保留到：(a) 两个 release cycle；(b) `smoke-abrain-vault-reader.mjs` 中 PromptDialog 路径与 fallback 路径都至少 28 个 assertion 覆盖；(c) 真实用户场景至少 1 周无 regression report。满足后另起 PR 移除 fallback。

> _[基础: OPUS §3.D2 表；吸收: DEEPSEEK §7 汇总；吸收: GPT D2.1 variant tagged union; 新增: 迁移 fallback 保留期]_

### D3. Sub-pi / 非交互模式的三层 guard 实现路径

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 1: dispatch sub-pi spawn 注入 PI_ABRAIN_DISABLED=1             │
│ extensions/dispatch/index.ts L298-300 已有；ordering 必须保持        │
│ "deny-by-default"：`...process.env` 之后注入，防 user export 逃逸    │
│   const childEnv = { ...process.env, PI_ABRAIN_DISABLED: "1" };      │
│ prompt_user 自动继承，不需要新 env var。                              │
└──────────────────────────────────────────────────────────────────────┘
            ↓ 子进程启动
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 2: abrain extension activate() early-return                    │
│ extensions/abrain/index.ts L599 已有；prompt-user 模块挂在 abrain    │
│ 内部，自动继承——不另注册 extension。                                 │
│ 子进程视角下 prompt_user tool 完全不存在（不进 tool registry）。     │
└──────────────────────────────────────────────────────────────────────┘
            ↓ 假如有人通过 RPC / 测试绕过 layer 1+2
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3: handler fail-fast（defense-in-depth，不是 reuse）           │
│ async execute(toolCallId, params, signal, _onUpdate, ctx) {          │
│   const started = Date.now();                                        │
│   if (process.env.PI_ABRAIN_DISABLED === "1") {                      │
│     auditPromptBlocked({ reason: "subagent" });                      │
│     return { ok:false, reason:"subagent-blocked",                    │
│              durationMs: Date.now()-started };                       │
│   }                                                                  │
│   if (!ctx.hasUI) {                                                  │
│     auditPromptBlocked({ reason: "no-ui" });                         │
│     return { ok:false, reason:"ui-unavailable",                      │
│              durationMs: Date.now()-started };                       │
│   }                                                                  │
│   // R4 fix：ctx.ui.custom 缺失不是 first-line reject，而是降级到    │
│   // §D7 fallback 路径（select/input chained）。secret type 在       │
│   // fallback 下仍 ui-unavailable 因 ui.input 无 masked mode。       │
│   // → normal flow / fallback dispatch                               │
│ }                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

**为什么 prompt_user 必须严格 sub-pi block**：

- Sub-pi 没有真实用户监听（dispatch 起的是 headless `pi` 进程），任何 prompt 都会 hang 到 timeout。
- 子进程的"用户回答"如果被 transcribed 回主 session 的 tool_result，会被主 session 当成 user-attested 信号——这是 ADR 0021 不变量 #5 已经记录的 prompt-injection 残面，本 ADR 不愿放大它。
- `ctx.hasUI === false`（print mode `-p`、JSON mode、CI smoke）等价于"没真实交互用户"，直接拒绝。
- **`ctx.hasUI` 与 `ctx.ui.custom` 检查分两步走**：先看 `hasUI`；hasUI=true 但 `typeof ctx.ui.custom !== "function"`（部分 RPC 客户端）→ 走 §D7 fallback chained 而非 reject。这与 R2 #18 裁决一致。

**Narrow terminal 降级（R6 2026-05-17 重写）**：

R6 后主路径采用 inline 底部 editor 区域替换（详见 §D7 R6 更新），
不再是居中弹窗，也不再需要 60%/100% width 赋值。editor 容器本身
跟随终端宽，pi-tui Text 组件自动换行。原“< 60 cells 拒绝”这一
档被删除 —— split-pane tmux / 手机 SSH / iPad mini 这些常见场景
都营生在 40–59 cells区间，拒绝它们反而是造成真实用户丢失。

| terminal width | R6 行为 |
|---|---|
| 任意宽度 | inline editor-region 替换（`overlay: false`），Text 自动换行 |

INV-A 保留 hasUI / sub-pi 两层，删除 terminal-width 第三层。
smoke `R6: narrow terminal (40 cols) does NOT reject anymore`
明确验证 cols=40 不再 false-positive。

> _[R6 起因：用户 2026-05-17 反馈【用弹窗是不是不太合适？业内 cc / codex / opencode 都是底部输入区】；调查发现 pi 的 ctx.ui.custom() 默认就是 editor 替换模式（`isOverlay = options?.overlay ?? false`），之前错说为弹窗是原作者误读 API。与R2/R3/R4 决议不冲突——五条主路径选 custom() 理由（紧凑布局 / chip / variant / overlayOptions / DynamicBorder 倒计时）在 inline 下全部成立，<PromptDialog> 组件代码不变。]_

原 R5 三档 overlay 降级描述（仅作历史备案）：

> R5 及之前：≥ 80 cells = `width: 60%`中央 overlay；60–79 = full-width overlay；< 60 = `ui-unavailable` reject。R6 后这套机制作废。

### D4. Session / turn finalizer（OpenCode 模式）

OpenCode 用 Effect.ts `Deferred` primitive + session-bound finalizer：session 销毁时所有 pending question 自动 reject。pi 的 SDK 已有等价信号：`session_shutdown` 事件（abrain/index.ts L868 已用同款模式）和 `ctx.signal`（turn AbortSignal）。

```typescript
// extensions/abrain/prompt-user/manager.ts
interface PendingPrompt {
  toolCallId: string;
  resolve: (r: PromptUserResult) => void;
  cleanup: () => void;          // 关闭 overlay、清 timer、移除 signal listener
  startedAt: number;
  innerController: AbortController; // 仅 listen outer ctx.signal，不 forward 给 sibling tool
}

const pending = new Map<string, PendingPrompt>();

export function cancelAllPending(reason: PromptUserResult["reason"]): void {
  const now = Date.now();
  for (const [, p] of pending) {
    p.cleanup();
    p.resolve({ ok: false, reason, durationMs: now - p.startedAt });
  }
  pending.clear();
}

// abrain activate() 内部 wire（与 vault_release session_shutdown handler 同位置）：
pi.on("session_shutdown", () => cancelAllPending("cancelled"));

// 每个 handler 调用：
ctx.signal?.addEventListener(
  "abort",
  () => {
    const p = pending.get(toolCallId);
    if (p) {
      pending.delete(toolCallId);
      p.cleanup();
      p.resolve({ ok: false, reason: "cancelled", durationMs: Date.now() - p.startedAt });
    }
  },
  { once: true },
);
```

**四个触发 cancel/resolve 的来源**：

| 触发 | resolve reason |
|---|---|
| 用户在 dialog 内点 Cancel / Esc / "No" 按钮 | `user-rejected` |
| `ctx.signal` abort（用户对 turn 整体 ESC） | `cancelled` |
| `session_shutdown`（pi 即将退出/切 session） | `cancelled` |
| `timeoutSec` 到期 | `timeout` |

**Internal AbortController 不 forward 给 sibling tool**：prompt_user 的 `innerController` 只在自己持有的 promise 上 listen outer `ctx.signal`，**不** 把 inner abort 广播回 outer。这确保 prompt_user 自身被取消时不会连带杀掉同 turn 的其他 in-flight tool call。

> _[基础: OPUS §3.D4 抽象 + DEEPSEEK §3.D4 `eventRegistry.on("session_shutdown")` 具体落点；新增: innerController 不 forward 给 sibling]_

### D5. Timeout 策略与默认值

| 参数 | 值 | 来源 |
|---|---|---|
| 默认 `timeoutSec` | **600**（10 分钟） | 用户离开座位/接电话的合理上限 |
| 最小 `timeoutSec` | **30** | < 30s LLM 会因 spec 紧迫感设到 10s，破坏 UX。clamp。 |
| 最大 `timeoutSec` | **1800**（30 分钟） | hard cap 防恶意/错误参数；超过 30 分钟用户多半已离场 |
| `timeoutSec=0` 语义 | **clamp 到 30**（拒绝"无限等待"语义） | 永久 pending 违反 fail-closed |
| 倒计时 UI | **最后 30s 显示** | 复用 `<DynamicBorder>` 已有 timing API（不要自己 setInterval 全屏 repaint） |

`timeoutSec=0` 是 DEEPSEEK R1 草稿的设计错误（允许无限挂起），R2 OPUS / GPT 双否决。R3 明确：`timeoutSec` 永远 clamp 到 `[30, 1800]`，不存在 "0 = 无超时" 路径。

**与 `vault_release` 的协调**：vault_release 当前没有 timeout 默认值；本 ADR **不改** vault_release 行为，但 backlog 留 "把 600s timeout 应用到 vault_release 的 PromptDialog"。

> _[基础: OPUS §3.D5；修正 min: 60 → 30（GPT 推荐）；新增: DynamicBorder 复用避免抖动]_

### D6. Secret 字段端到端 redaction 边界

> 本节是本 ADR 最严肃的部分。pi-astack 的 secret 边界历经 ADR 0019（vault identity）、ADR 0020 §invariant 7（git argv/stdout redaction）多轮加固；`prompt_user` 必须把这条 invariant 推到它的所有写入端。

#### D6.1 边界图

```
┌──────────────────────────────────────────────────────────────┐
│  USER (TUI)                                                  │
│    plaintext keypress                                        │
└──────────────────────────────────────────────────────────────┘
            │
            ▼  (masked rendering: "•••••" in PromptDialog Input)
┌──────────────────────────────────────────────────────────────┐
│  PromptDialog component memory (in-process only)             │
│    raw secret 存在 component-local buffer                    │
└──────────────────────────────────────────────────────────────┘
            │
            ├──→ Caller-side callback (extension internal)    [P4 deferred]
            │     P0 不暴露 callback API；raw secret 在 dialog close 
            │     时立即从 component-local buffer 销毁。caller 想消费
            │     raw secret 走 follow-up ADR（§D6.4 末）的 P3 路径。
            │     R4 fix：避免 INV-C 描述与 P0 可消费路径不一致。
            │
            ├──→ Tool result (LLM context)             → placeholder
            │     answers[id] = ["[REDACTED_SECRET:<id>]"]
            │     redactions[id] = { type:"secret", placeholder }
            │
            ├──→ audit.jsonl                            → lengthBucket
            │     { id, type:"secret", answered:true,
            │       lengthBucket:"1-8"|"9-32"|">32" }
            │     不存 raw / hash / prefix / suffix / char count
            │
            ├──→ sediment transcript scan               → placeholder
            │     transcript pre-pass redaction（兜底 defense-in-depth）
            │
            └──→ pi RPC log / session jsonl             → placeholder
                  tool result 进 session log 前 redact
```

#### D6.2 提升 `redactCredentials` 到公共 redaction primitive

ADR 0020 §invariant 7 已 codify 的 `redactCredentials()`（当前在 `extensions/abrain/git-sync.ts` L132-134）**提升到 `extensions/abrain/redact.ts`** 作为公共 helper：

```typescript
// extensions/abrain/redact.ts (新文件)
export function redactCredentials(input: string): string;     // 已有：URL credential pattern
export function redactSecretAnswer(s: string, id: string): string;
  // 整体替换为 `[REDACTED_SECRET:<id>]`
export function lengthBucket(s: string): "1-8" | "9-32" | ">32";
  // 仅 audit 使用，**不**返回 char count
export function redactPromptParams(p: PromptUserParams): PromptUserParams;
  // R4 fix：对所有 question 的 reason / header / question /
  // option.label / option.description 全部走 redactCredentials +
  // sanitizeForMemory。LLM 可能在任意 user-visible 字段嵌入
  // URL credential；漏一处就有 audit/UI 泄漏。
  // 注意：sanitize 后的 label 同时用于 UI 渲染和 answer 比对，
  // 保证 answer label 与 LLM 看到的 schema 一致。
```

`extensions/abrain/git-sync.ts` **移除 L133 原始 `redactCredentials` 定义**，改为 `export { redactCredentials } from "./redact"`，保留 import path 向后兼容；smoke 验证 `import from "./git-sync"` 与 `from "./redact"` 是同一函数引用，避免 drift。**位置在 abrain 内部，不在 `_shared/`**——`_shared/` 提升需要单独的 cross-extension API 安全评审，等真有第二个 consumer 再做。

#### D6.3 各写入端的具体规则

| 写入端 | `single` / `multi` / `text` | `secret` |
|---|---|---|
| **PromptDialog 渲染** | 明文 | 字符替换 `•` 等长显示；IME 按 `tui.md` `Focusable` 规则 |
| **Tool result → LLM context** | 明文 | `[REDACTED_SECRET:<id>]` placeholder；raw 不进 |
| **`redactions` 元数据** | 不存在 | 出现：`{ type:"secret", placeholder }` 让 LLM 知道有 redaction |
| **audit.jsonl** | answer 明文（先 `redactCredentials` + `sanitizeForMemory`，再 truncate 240 chars） | `{ id, type:"secret", answered:true, lengthBucket }`；**不存** raw / hash / prefix / suffix / char count |
| **sediment transcript scan** | 明文 | sediment `agent_end` pipeline 在 LLM curator 调用前，对 tool result 中 `redactions` 提及的 id 做 transcript pre-pass redaction（兜底；正常路径 tool result 已是 placeholder） |
| **pi RPC log / session jsonl** | 明文 | tool result post-processor 在写盘前 redact 同款 placeholder |

**`reason` / `header` / `question` / `option.label` 字段 (R7.2: 删 `option.description`)**：不论问题类型，**全部 4 个 user-visible 字段 (R7.2: 从 R4 的 5 字段减 description→label)**走 `redactCredentials` + `sanitizeForMemory`（R4 P0 fix：原 R3 仅列 3 字段，遗漏 `header` 和 `option.label`，会让 credential 经 chip header 或 answer summary 泄漏）。LLM 可能在 `reason` 中放 `"是否 deploy 到 https://user:tok@host/repo"` 这种 URL credential；redact 后的 label 同时用于 UI 渲染与 `answers[id]` 比对，保持 LLM 视角下 schema 与 answer 一致。

**Other free-text answer**：在 audit 写入路径走 `sanitizeForMemory` + `redactCredentials`；tool result 返回 LLM 时**不** sanitize（LLM 需要原文做下一步决策）。

#### D6.4 `type:"secret"` 的实际可用性边界（R4 修订）

**P0 实际范围**：`type:"secret"` schema **已开放**，但 P0 **不** 暴露 `onSecretAnswered(id, raw)` callback API。raw secret 在 PromptDialog 闭包中由组件 lifecycle 持有，**dialog close 时立即从 component-local buffer 销毁**。这意味着 P0 内 raw secret **无任何代码路径可消费**——这是有意为之，让 schema/UI/redaction 三层先 ship 并被 smoke 覆盖，再决定后续 callback API 的最终形态。

P0 价值：

1. **UX 验证**：用户能在 dialog 中看到 masked input；LLM 收到 placeholder 而非干扰回答
2. **redaction 边界先于真实流量验证**：smoke 覆盖 INV-C 全部写入端
3. **避免 P0 暴露未验证 API**：callback signature/lifecycle/error path 等设计点单独 follow-up ADR 评审

**P0 明确不支持** 的场景：

- 通过 LLM tool call 把 raw secret 注入到 bash 命令（这是 vault_release / `$VAULT_<key>` 的职责）
- 把 secret 长期存储到 vault（这是 `/secret set <key>` 的职责）
- 把 secret 跨 turn 留存（PromptDialog buffer 在 dialog close 时清空）

如果未来需要"LLM 经由 `prompt_user(secret)` 拿到的 token 注入 bash"，必须走 follow-up ADR：引入 `sessionVaultKeys` 写入路径 + `agent_end` 自动清空 + `$PROMPT_VAULT_<id>` env injection + smoke。这个 follow-up 工程量估约 80-120 行 TS + 一个 smoke fixture，**不**算"小补丁"。

#### D6.5 与 `vault_release` 的边界声明

`vault_release` 是**唯一**允许"已存 vault secret plaintext 进入 model context"的 LLM-facing path。它继续：

- 先 grant 授权；再 release；audit `lane:"vault_release"`；对 bash output 做 literal redaction；sub-pi fail-closed。

`prompt_user(type:"secret")` 永远不释放 vault secret，不返回 raw secret 给 LLM。两条路径**绝不可能**通过组合 `prompt_user + vault_release` 实现 vault bypass，因为 prompt_user 的 raw secret 从一开始就**不进入 LLM 决策路径**。

> _[基础: GPT §3.D6 完整 redaction 边界；吸收: OPUS D6.2 redact primitive 提升 + INV-D 三处独立 redact 模式；吸收: GPT D6.3 lengthBucket + 不存 hash 安全理由；新增: §D6.4 实际可用性边界划清]_

### D7. UI 实现：`ctx.ui.custom()` 自定义组件为主路径（R6 2026-05-17 重写, R7 拼有 OptionList）

**R7 补充决策 (2026-05-17, 同日晚间)**: 底层组件从 pi-tui SelectList
换为自定义的 `OptionList`。原 SelectList 有三个在 prompt_user UX 上
不可接受的限制:

  1. **不支持多选** — SelectList 是单选设计; `type:"multi"` 在原实现下
     是单选退化 (ADR §4.5 P4 backlog)。R7 上线真多选 (space-toggle
     预设项 + Other text 自动计入 = multi answer)。
  2. **description 单行硬截断** — SelectList 在设计上是单行表格 (label 列
     + description 列同行并排),超长 description 被 `normalizeToSingleLine` +
     `truncateToWidth` 静默丢后半句。R7.2 进一步合并双字段为单 label,
     OptionList 原生多行 wrap (`wrapToWidth` CJK-aware)。
  3. **Other 提供点隐藏列表** — 原实现选 Other 则 `swapBody(Input)` 让
     选项列表消失, 多选场景下用户看不到其他项。R7 护 cc-style 内嵌
     input: Other 行下方永久渲染 Input 框与其他选项并存。

**R7.3 OptionList 状态机 (简化)**: 原设计有 「list focused ↔ input focused」
两个状态 + Enter 切换 input mode。R7.3 用户反馈「other 的输入操作用
 enter 纯属多余, 方向键就可以」 —— 废掉 input mode 切换, 永远 list focused,
只在 highlight=Other 时把打字键 / Backspace 路由给 Other 的内嵌 Input。
多选模式下 Other 的「是否选中」以 otherText 是否非空推导, 不需要
 explicit toggle (用户: 「多选模式下判断 other 有没有选中就根据用户有
没有输入内容判断」)。

**R7 wizard 多 question 左右键切换 (cc-style)**: 原实现是单向 advance
 wizard, 用户 不能回到上一个 question 改答案。R7 一次性构建所有
 question component 缓存, ← 切上一问 / → 切下一问, 各 component 状态
不丢。在 Other input 有焦点时:
  - 光标在最前 (cursor==0) + ← → 切问题
  - 光标在最后 (cursor==length) + → → 切问题
  - 其他位置: ← / → 移动光标
Enter on non-last 等价于 → (advance); Enter on last = submit + collect 所有
entries。Esc 任位置 cancel。

**R7 不变量保护**:
  - INV-H: OptionList.collect() 返 string[] (single length 0..1, multi length 0..N);
           text/secret 包装返 [value]。
  - INV-C: MaskedInput.wipe() 在 finish (submit AND cancel) 时被 wizard 调用,
           raw 不离闭包; Enter 不再走 onSubmit-via-Enter 逻辑, 由 wizard 控制。
  - INV-D: 4 字段 redact 不变 (删除 option.description 后)。
  - INV-G: 仅 PromptUserOption {label, recommended?}, 不收 description / scope / key。

**R7 smoke**: `scripts/smoke-prompt-user-option-list.mjs` 35 个 case 覆盖
 OptionList 状态机 / MaskedInput / wizard 导航 / INV-C buffer wipe。与原
 smoke-prompt-user.mjs (37 case) 互补, 合计 prompt-user 相关 smoke 95/95。

#### D7 (原 R6 设计)

**R6 决策（覆盖原决策）**：主路径 = `ctx.ui.custom(factory, { overlay: false })` ——
底部 editor 区域替换，不是屏幕居中弹窗。`ctx.ui.select` / `ctx.ui.input`
chained 作为 fallback；`ctx.hasUI === false` 或 `ctx.ui.custom` 不可用 →
`ok:false, reason:"ui-unavailable"`。**terminal width 阈值检查删除**（见 §D3
"Narrow terminal 降级 R6 重写"）。

**R6 起因**：R1–R5 原决策误读 pi `ctx.ui.custom()` 默认行为为弹窗，实际上
`interactive-mode.js:1778` 写得很明白——`isOverlay = options?.overlay ?? false`，
默认就是 editor 区域替换。Claude Code / Codex / OpenCode 三家业内都是底部
inline，pi 内建 `ui.select / input / confirm / editor` 也是底部 inline——
prompt_user 走 overlay 是孤例。R6 拨乱反正。

**主路径选择 `custom()` 的理由（五条在 R6 inline 下全部成立）**：

1. **多 question / 多 option 的紧凑布局**：select chained 要弹 N 次 modal，4 个 question 弹 4 次让用户失去上下文。custom inline 可以 single-pass 渲染 wizard（1/N 进度）。
2. **chip + free-text 同时呈现**：select 不支持“选择 + 自由输入”混合输入。
3. **变化的 affordance**：`vault_release` variant 用 warning accent color 的标题 + reason banner；`question` variant 用 accent color；select 不能 variant化。
4. **与 pi 内建 dialogs 视觉一致**：R6 后 PromptDialog 和 `ui.select / input` 走同一套 `editorContainer.clear() + addChild()` 路径，进一步加强一致性（R5 原“与 dialogs 一致”是错说，pi 内建 dialogs 本来就不是 overlay）。
5. **上下边框 + 可选倒计时**：`<PromptDialog>` 在顶底各 wrap 一条 `DynamicBorder(paint)`，paint 走 variant accent color（question=accent、vault_*=warning）——与 pi 内建 `ExtensionSelectorComponent` / `ExtensionInputComponent` 作法一致（都是取代 editor 后自己负责边框，因为 pi 默认 editor 的 borderColor 是 editor 组件自己渲染，被替换后边框跟着消失）。P4 backlog：倒计时以“(5:42)”文本形式附加到 hint 行。

> **R6 迭代记录**：R6 首版曾试图去掉上下两条 DynamicBorder，误以为 editor 容器自带边框。用户实际看到后反馈“输入框的上下边框线没有了”，当场改回 —— pi 默认 editor 的边框是 editor 组件自己渲染的 `borderColor`，不在 `editorContainer` 上。占用 editor 区域的组件都要自己包边框（这也是 pi 内建 ExtensionSelector / ExtensionInput 的一贯作法）。

**Fallback 路径**（custom 因任何理由 throw 时）：

```typescript
async function promptViaSelectChain(
  qs: PromptUserQuestion[],
  ctx: ExtensionContext,
): Promise<PromptUserResult> {
  const started = Date.now();
  const answers: Record<string, string[]> = {};
  for (const q of qs) {
    if (q.type === "text") {
      const v = await ctx.ui.input(q.question);
      if (v === undefined) return { ok: false, reason: "user-rejected", durationMs: Date.now() - started };
      answers[q.id] = [v];
      continue;
    }
    if (q.type === "secret") {
      // ctx.ui.input 当前 SDK 无 masked mode；fallback 直接 ui-unavailable 避免泄漏
      return { ok: false, reason: "ui-unavailable", durationMs: Date.now() - started,
               detail: "secret type requires PromptDialog inline editor replacement" };
    }
    const labels = q.options!.map(o => o.label);
    labels.push("Other…");                                       // 永远 server-forced
    const choice = await ctx.ui.select(q.question, labels);
    if (choice === undefined) return { ok: false, reason: "user-rejected", durationMs: Date.now() - started };
    if (choice === "Other…") {
      const v = await ctx.ui.input("Your answer:");
      if (v === undefined) return { ok: false, reason: "user-rejected", durationMs: Date.now() - started };
      answers[q.id] = [v];
    } else {
      answers[q.id] = [choice];
    }
  }
  return { ok: true, answers, durationMs: Date.now() - started };
}
```

**Multi-select fallback**：`ctx.ui.select` 不支持 multi；fallback 中 `type:"multi"` 退化为多次 `ui.confirm("include X?")`（已知体验降级；audit 标 `via=fallback_chain`）。

**vault_release 的 UI 共用方式**：

```typescript
// extensions/abrain/index.ts authorizeVaultRelease 改造（R6：inline，不改对外签名）
const choice = await ctx.ui.custom<typeof VAULT_RELEASE_AUTH_CHOICES[number] | undefined>(
  (tui, theme, kb, done) => new PromptDialog({
    tui, theme, keybindings: kb, done,
    variant: "vault_release",
    title, scope, key, reason,
    choices: VAULT_RELEASE_AUTH_CHOICES,        // suppress "Other" — caller-side config，非 LLM-facing
  }),
  { overlay: false }                             // R6 inline editor-region replacement
);
// fallback：custom 不可用 → 回退到现有 ui.select(...)；fallback 保留期见 §D2 末
```

**Keybindings**：

- `↑/↓` navigate options
- `space` toggle multi option
- `enter` submit current text / 确认
- `tab` / `shift+tab` 切换 question card
- `esc` cancel → `user-rejected`
- `ctrl+c` 不被 PromptDialog 拦截（由 pi runtime 处理；通常等价于 turn abort → `cancelled`）

> _[基础: OPUS §3.D7；吸收: GPT D7 narrow terminal + feature detection；吸收: GPT fallback 代码 + multi 降级说明；新增: secret 在 fallback 直接 ui-unavailable]_

### D8. LLM 滥用治理

**总原则**：不做 silent reject gate；通过 prompt discipline + audit visibility + 最少必要 hard gate 引导 LLM 自律。

#### D8.1 prompt 引导（写进 `promptGuidelines`）

```typescript
toolRegistry.registerTool({
  name: "prompt_user",
  label: "Ask the user (interactive)",
  description:
    "Pause execution and ask the user 1–4 structured questions when " +
    "you genuinely need a decision you cannot infer. Returns user's " +
    "answers synchronously. The user sees a structured dialog with " +
    "chip-style options and a free-text 'Other' escape (always available). " +
    "Use sparingly — every call interrupts the user's flow.",
  promptSnippet:
    "prompt_user({reason, questions: [{id, header, question, type, options?}], timeoutSec?})",
  promptGuidelines: [
    "Call prompt_user ONLY when the answer materially changes which code path you take next. If the answer would not change your action, do not pause.",
    "Do not use prompt_user to confirm work you are about to do (the user expects you to act unless told otherwise). Use it to disambiguate between branches.",
    "Do not chain prompt_user calls back-to-back in the same turn — batch related questions into a single call (up to 4 questions).",
    "Do not use prompt_user(type:'secret') to release stored vault secrets — use vault_release. type:'secret' is for one-time user-provided tokens consumed by an extension; the raw value is NOT returned to you.",
    "Provide concrete options whenever possible. type:'text' is for inputs that do not have a small finite set of correct answers.",
    "header ≤ 12 display cells (count visible terminal cells, not JS string length — each CJK char = 2 cells, each ASCII char = 1 cell); question is a complete sentence; option labels 1–5 words.",
    "reason explains why you must pause (e.g. 'project framework choice affects scaffolding'), not a re-statement of the questions.",
    "memory_search past preferences first (e.g. memory_search('user preference framework')) before asking.",
  ],
  ...
});
```

#### D8.2 audit 暴露给 sediment（user-attested signal）

每次 prompt_user 调用 → audit 写**两行**：

```jsonl
{"ts":"...","op":"prompt_request","lane":"prompt_user","turn_id":"...","question_count":3,"question_ids":["framework","deploy_envs","note"],"types":["single","multi","text"],"reason_redacted":"...","timeoutSec":600}
{"ts":"...","op":"prompt_response","lane":"prompt_user","turn_id":"...","result":"ok","durationMs":8432,"answers_summary":{"framework":["Remix"],"deploy_envs":["staging","prod"],"note":"<truncated 240 chars>"},"via":{"framework":"label","note":"other"}}
```

`sediment` 在 `agent_end` 自然 pick up audit lane：

- `extensions/sediment/index.ts` 的 evidence assembly 增加 "prompt_user user-attested signal" 段：把本 turn 内的 `(question, answer)` 对作为**高 trust** evidence 注入 curator prompt（类似 Lane G fence trust 等级）。**不**自动写入；curator 仍判断是否值得沉淀，但优先级高于普通对话推断。
- sediment 看到 high frequency 后写入 `habits/` 区一条 entry "倾向于过度提问 prompt_user"由用户后续校正（与 ADR 0021 Lane G habits 思路同源）。

#### D8.3 唯一的 hard gate：concurrent pending ≤ 1

同一 session 同一时刻只允许 1 个 unresolved `prompt_user`。并发第二个 → 立即 `{ok:false, reason:"schema-invalid", detail:"another prompt is pending"}`。

理由：
- 多个 overlay 抢焦点会破坏 UX
- finalizer cleanup 顺序难保证
- audit response 归属混乱
- 这是 UI substrate 一致性保护，**不**是限制 LLM 自主（serial 调用 prompt_user 完全合法——一个答完再发下一个）

**不复用 `cancelled` reason**：避免 LLM 看到 `cancelled` 时无法区分"session 在收尾"和"被另一个 prompt 挡了"。用 `schema-invalid + detail` 显式区分。

#### D8.4 soft cap（信息提示，不拒绝）

handler 内累计本 turn 内 `prompt_user` 调用次数；> 2 时在返回值 `detail` 附加 `"third prompt_user call in same turn — consider batching"`（LLM 可读，sanitized short string）。**不** reject。Per-turn hard rate-limit 进 backlog，等真实滥用出现再加。

_注：detail 字段在 `ok:true` 和 `ok:false` 两个 branch 都存在（见 §D1 schema 修订），soft cap 走 success branch 的 detail，与 failure detail 共用字段但语义独立（success 是 warning，failure 是 error context）。_

> _[基础: OPUS §3.D8 三层；吸收: GPT single pending hard gate 但改为 concurrent ≤ 1（不是 per-session ≤ 1）；新增: sediment user-attested signal trust 等级]_

### D9. i18n

复用 `extensions/abrain/i18n.ts::localizePrompt`（已被 vault_release `authorizeVaultRelease` 验证）：

**Static UI chrome 走 `localizePrompt`**：

- "Submit" / "Cancel" / "Other…" / "Recommended" / "Select one" / "Select multiple"
- timeout 倒计时 hint
- Esc to cancel / Tab to switch question

**Dynamic content 不二次翻译**：

- `reason` / `question` / `option.label` / `option.description`：LLM 当前对话语言通常已匹配用户语言；二次翻译会引入语义失真且让 LLM 收到的 answer label 与自己 schema 不一致
- "Other" 用户自由文本答案：原文返回，不翻译

**vault_release variant 的 title**：继续走 `formatReleaseAuthorizationTitle` + `localizePrompt`（已有路径，不变）

**audit 存原文**：sanitized 但不翻译，方便审计时无歧义

> _[基础: GPT §3.D9（最完整）；与 OPUS / DEEPSEEK 同方向]_

### D10. 与 Lane G G2 (`/about-me` slash + transcript inject) 的关系

ADR 0021 §D4 已记录 G2 阻塞点：`/about-me` slash 想做 `ctx.transcript.append({role:"user", ...})` 注入 `MEMORY-ABOUT-ME:` fence，但 pi extension SDK 不一定提供 user-role transcript inject。

**`prompt_user` 提供的**：

- `/about-me` 空 body 时的 UI substrate（多行 input + region selector），用户直接在 TUI overlay 中键入，体验远好于"输 N 行的命令行参数"
- region selector 让用户选 `identity` / `skills` / `habits` / `auto`（让 LLM classifier 决定）

**`prompt_user` 不能提供的**：

- **Tool result 不是 user message**。`prompt_user` 返回的是 `role: tool` 的 tool result；G2 需要的是 `role: user` 的 transcript entry。两者在 sediment 视角和 LLM provenance 视角下**不等价**。
- 如果 SDK 仍不支持 user-role transcript append，G2 仍需降级为"生成 fence 模板请用户复制粘贴"。`prompt_user` **不替代**这条 SDK 依赖；只让降级 UI 更体面。

**G2 落地路径（SDK 支持后）**：

```
用户在 TUI 中输入 `/about-me`（空 body 或带文本）
   ↓
slash handler 调用内部 service askPromptUser(ctx, {
   reason: "Compose an about-me entry.",
   questions: [
     { id: "title",  header: "Title",  question: "Short title (≤ 80 char)", type: "text" },
     { id: "body",   header: "Body",   question: "What's true about you?", type: "text" },
     { id: "region", header: "Region", question: "Which region?",
       type: "single",
       options: [
         { label: "identity",     description: "stable self-narrative" },
         { label: "skills",       description: "tech / meta capability" },
         { label: "habits",       description: "observed recurring pattern" },
         { label: "auto",         description: "let the LLM classifier decide", recommended: true },
       ]
     }
   ]
})
   ↓ user answers
slash handler 调用 ctx.transcript.append({role:"user",
   content: `MEMORY-ABOUT-ME:\nregion: <region>\ntitle: <title>\n<body>\nEND_MEMORY`
})
   ↓
等同于用户手敲 fence，sediment agent_end 自然 pick up
```

**slash handler 调用的是内部 service `askPromptUser`（§D12），不是 LLM tool**——避免把用户 slash 操作记进 LLM tool audit lane，也避免 LLM 看到 G2 fence 生成路径。

> _[基础: GPT §3.D10 正确判断 "tool result ≠ user message"；明确否决 OPUS R1 的 "G2 直接受益" 论断]_

### D11. compaction-tuner 与 pending prompt_user 的协调

`compaction-tuner` 在 `agent_end` 触发 compaction（`extensions/compaction-tuner/index.ts` L138）；若 pending `prompt_user` 跨越 `agent_end`（极端情况：LLM 在多 turn 工作中先 prompt_user 等用户，期间 compaction 触发），answer 返回时 toolCallId 关联的 message 可能已被压缩。

**决策**：

1. `compaction-tuner` 在 `agent_end` handler 内检查 `pending.size > 0`；若为真，**跳过本轮 compaction trigger**，并写一条 audit `lane:"compaction", op:"deferred_for_prompt_user", pending_count: N`。
2. 下一次 `agent_end` 自然 retry（compaction-tuner 已是 percent-based trigger，不漏）。
3. **不**强制 prompt_user fail-fast；让用户的回答有时间到达。

实现：compaction-tuner 通过新 export `getPendingPromptCount()`（来自 prompt-user manager）查询，无循环依赖：

```typescript
// extensions/compaction-tuner/index.ts
import { getPendingPromptCount } from "../abrain/prompt-user/manager";

pi.on("agent_end", async (event, ctx) => {
  if (getPendingPromptCount() > 0) {
    auditCompactionDeferred({ pending: getPendingPromptCount() });
    return;
  }
  // … existing compaction logic
});
```

这是三家草稿都漏掉的协调点（R2 DEEPSEEK 审计指出）。

> _[新增 R3：R2 三家审计共同发现遗漏]_

### D12. Internal service vs LLM-facing tool 分层

`prompt_user` 是 **LLM-facing tool**；`/about-me`、未来 `/decide` 等 slash 应**通过内部 service `askPromptUser(ctx, params)` 调用**，**不**通过 LLM tool。

```typescript
// extensions/abrain/prompt-user/service.ts
export async function askPromptUser(
  ctx: ExtensionContext,
  params: PromptUserParams,
  options?: { source: "slash" | "extension"; auditLane?: string },
): Promise<PromptUserResult>;
```

差异：

| 维度 | LLM-facing `prompt_user` tool | Internal `askPromptUser` service |
|---|---|---|
| 调用方 | LLM tool call | slash handler / extension internal |
| Audit lane | `prompt_user` | 调用方指定（如 `lane:"slash_about_me"`） |
| Guard | sub-pi 三层 + concurrent ≤ 1 | concurrent ≤ 1（sub-pi 不适用，因为 slash 只在主 session 触发） |
| Schema validation | 完整 | 同套 |
| Sediment evidence 等级 | "user-attested signal"（高 trust） | "user direct input"（最高 trust） |

避免审计 lane 混淆 + 避免 LLM 看到 slash 生成的 fence 路径。

> _[新增 R3：GPT R2 审计提出的设计点]_

---

## 4. Phase / 实施

P0 范围（本 ADR ship 即落地）：

### 4.1 新文件

| 文件 | 内容 | 估算 LOC |
|---|---|---|
| `extensions/abrain/prompt-user/types.ts` | TypeScript types：`PromptUserQuestion`/`PromptUserParams`/`PromptUserResult`/`PromptUserOption`/`PromptUserQuestionType` | 80 |
| `extensions/abrain/prompt-user/schema.ts` | Validation：`validatePromptUserParams(params): {ok, errors}`；id regex / display-width / type-options 一致性 / 1-4 / 2-4 / option labels 1-5 words | 160 |
| `extensions/abrain/prompt-user/manager.ts` | `pending` Map + `PromptUserManager` + `cancelAllPending` + `getPendingPromptCount` + `addSignalListener` | 120 |
| `extensions/abrain/prompt-user/service.ts` | `askPromptUser(ctx, params, options)` internal entry | 100 |
| `extensions/abrain/prompt-user/handler.ts` | LLM tool `execute()`：三层 guard + schema validate + concurrent check + delegate to service | 100 |
| `extensions/abrain/prompt-user/ui/PromptDialog.ts` | TUI component：variant=question\|vault_release\|bash_output_release + chip layout + select/multi/text/secret render + keybindings + countdown via DynamicBorder | 280 |
| `extensions/abrain/redact.ts` | 提升 `redactCredentials` + 新增 `redactSecretAnswer` / `lengthBucket` / `redactPromptParams` | 80 |

### 4.2 修改文件

| 文件 | 修改 |
|---|---|
| `extensions/abrain/index.ts` | 注册 `prompt_user` LLM tool；wire `pi.on("session_shutdown", () => cancelAllPending("cancelled"))`；`authorizeVaultRelease` 主路径改为 `ctx.ui.custom(PromptDialog, {variant:"vault_release"})`，保留 `ui.select` fallback（§D2 末"保留期"）；`authorizeVaultBashOutput` 同款迁移；export `audit lane "prompt_user"` 至 `lanes` enum | 增 180 / 改 120 |
| `extensions/abrain/git-sync.ts` | **移除 L133 原始 `function redactCredentials` 定义**，改为 `export { redactCredentials } from "./redact"` re-export，保持 import path 向后兼容 | -10 / +1 |
| `extensions/compaction-tuner/index.ts` | `agent_end` handler 加 `getPendingPromptCount() > 0` 早返回 + audit | 25 |
| `extensions/sediment/index.ts` | evidence assembly 增加 "prompt_user user-attested signal" 段，从 audit `lane:"prompt_user"` 读本 turn 的 question+answer 对，注入 curator prompt | 60 |

### 4.3 Smoke 脚本

| 脚本 | assertion 目标 | 估算 LOC |
|---|---|---|
| `scripts/smoke-prompt-user.mjs` | ≥ 22 assertions：schema validation 各分支 / happy path single+multi+text+secret / Other path / i18n / lengthBucket / redactions field / reason redactCredentials | 320 |
| `scripts/smoke-prompt-user-subpi.mjs` | ≥ 8 assertions：spawn 子 pi with PI_ABRAIN_DISABLED / tool list 不含 prompt_user / 强制 RPC handler fail-fast → subagent-blocked / audit op=prompt_blocked / 子进程 fs 看不到 prompt_user 写入 / session_shutdown 不挂起 | 180 |
| `scripts/smoke-prompt-user-finalizer.mjs` | ≥ 12 assertions：session_shutdown → cancelled / ctx.signal abort → cancelled / timeout → timeout / concurrent pending → schema-invalid / fallback path (custom unavailable) → select chained / pending Map drained / overlay close 1 次 / durationMs 在 failure 也返回 | 240 |
| **回归**：`scripts/smoke-abrain-vault-reader.mjs` 扩展 | + 5 assertions：vault_release 走 PromptDialog overlay 后 grant 状态正确 / fallback path 仍工作 / sub-pi 仍看不到 vault_release tool / audit lane 仍为 vault_release / `authorizeVaultBashOutput` 走 `variant:"bash_output_release"` 后 `bashOutputSessionGrants` 设置正确（R4 新增） | +75 |
| **回归**：`package.json` | 新增 `smoke:prompt-user` / `smoke:prompt-user-subpi` / `smoke:prompt-user-finalizer` 三个 script | +3 |

### 4.4 PR 大小预估（R4 修订）

- TypeScript 新增: ~940 LOC（§4.1 合计 80+160+120+100+100+280+80 = 920，加少量 wiring）
- TypeScript 修改: ~310 LOC（§4.2 合计 180+1+25+60 + git-sync.ts 删除 10 行 = ~276，加边角）
- **TypeScript 总变动: ~1250 LOC（1100-1400 范围）**
- Smoke: ~800 LOC（不含 fixture data；含 fixture ≈ 1000）
- **合计 ~2050-2400 LOC**，单 PR 仍可落地（参考 ADR 0020 / 0021 同量级 PR 已 ship）。

### 4.5 实施进度 + 后续 Phase

**已 ship（2026-05-17）**：

| Phase | 内容 | Commit | Smoke |
|---|---|---|---|
| **P1** ✅ | `redactCredentials` 提升到 `abrain/redact.ts`；redact primitives 高级 family；`prompt-user/types.ts` 骨架 | `0e937f7` | `smoke:abrain-redact` |
| **P2** ✅ | 完整 LLM 工具表面（schema / manager / service / handler / PromptDialog）+ abrain wire-up + session_shutdown finalizer + globalThis pending hook | `b9565c2` | `smoke:prompt-user{,-finalizer,-subpi}` |
| **P3a** ✅ | `compaction-tuner/prompt-user-defer.ts` 叶模块 + INV-K guard | `29439cb` | `smoke:compaction-tuner-prompt-user` |
| **P2-fix** ✅ | OPUS+DEEPSEEK xhigh review 产出 7 项 P1 全修：`hasControlChars` 拒 \t\n\r / `redactCredentials` 扩全 scheme / `redactPromptParams` 下沉 service + 加 `sanitizePathLike` / narrow terminal reject / fallback multi 多次 confirm / INV-I 发 audit | `8676c5f` | +11 redact / +10 prompt-user assertion |

P1+P2+P3a+P2-fix 合计：TS ~5300 LOC + smoke ~3500 LOC，22/22 全量 smoke 零回归。

**deferred（本 ADR P0 不要求）**：

| Phase | 内容 | 估算 |
|---|---|---|
| **P3b** | `authorizeVaultRelease` / `authorizeVaultBashOutput` 主路径迁移到 `<PromptDialog>` overlay（variant `vault_release` / `bash_output_release`），保留 `ui.select` fallback。验证 INV-E smoke。 | ~150 LOC + 5 assertion |
| **P3c** | sediment evidence assembly 读 `lane:"prompt_user"` audit 行 → curator prompt，让 sediment 区分「用户决策」与「LLM 思考」。 | ~80 LOC + smoke |
| **P4** | `/about-me` slash 接 `askPromptUser` service（ADR 0021 G2 可复用）；`/decide` 类 high-level slash；`type:"secret"` raw consumer callback API；`type:"multi"` 真正多选 toggle；`type:"secret"` 经 `$PROMPT_VAULT_<id>` bash injection（新 follow-up ADR）；defer/resume（需 pi 核心 turn-resume API）；richer types（slider/date picker）；hard rate-limit | per-feature |

---

## 5. 关键不变量汇总（INV-A 到 INV-K）

| # | 不变量 | 来源 / 验证 |
|---|---|---|
| **INV-A** | sub-pi (`PI_ABRAIN_DISABLED=1`) 或 `!ctx.hasUI` 时，`prompt_user` handler 第一行 reject；不调 `ctx.ui.custom`；不写 markdown；仅写一条 `op=prompt_blocked` audit。**`ctx.ui.custom` 不可用单独走 §D7 fallback chained 路径，不计入 INV-A reject**（R4 修订与 R2 #18 一致）。**R6 (2026-05-17) 修订**：terminal-width < 60 这一档删除 —— 主路径改为 inline editor-region 替换后Text 组件自动换行，TUI 在 40-cell 窄屏上也能呈现，拒绝会造成真实用户丢失。 | §D3 (R6 重写) / §D7 (R6 重写)；smoke-prompt-user-subpi.mjs §sub-pi 两层 + smoke-prompt-user.mjs §R6 narrow terminal 不拒绝 |
| **INV-B** | 所有 pending prompt 在 `session_shutdown` / `ctx.signal abort` / `timeoutSec` 内 finite 时间 resolve；无 pending-forever 路径 | §D4；smoke-prompt-user-finalizer.mjs |
| **INV-C** | `type:"secret"` 的 raw answer 永不离开 PromptDialog 闭包；dialog close 时立即销毁 component-local buffer。LLM/sediment/audit/log 看到的引用必须是 `[REDACTED_SECRET:<id>]` placeholder 或 `lengthBucket`。**P0 不暴露 caller-side callback API**（移至 P4 deferred，避免未验证 surface） | §D6.3-D6.4；smoke-prompt-user.mjs §secret |
| **INV-D** | `reason` / `header` / `question` / `option.label` **4 个 user-visible 字段** 在 handler 入口 + `safeAuditAppend` 写入前 **两处独立**走 `redactCredentials` + `sanitizeForMemory`；sediment transcript pre-pass 在 LLM curator 调用前**兜底 secret placeholder**（仅 `type:secret`，不重复 scan URL credential）。任一遗漏由另一处兜底。**R7.2 (2026-05-17) 修订**：从 R4 的 5 字段减为 4，删除 `option.description` (PromptUserOption 合并为单字段 label)。老 LLM 仍传 description 被 schema validator silent-drop，不进 redact 路径也不会出现在 UI/audit。 | §D6.2-D6.3；smoke-prompt-user.mjs `R7.2 INV-D` case (4 字段 × 两处独立) |
| **INV-E** | PromptDialog 组件不持有 `releaseSessionGrants` / 任何 abrain SoT 状态；纯渲染 + 收键 + `done(value)`。grant 状态在 caller 侧（`authorizeVaultRelease`） | §D2 (3) / §D7；smoke-abrain-vault-reader.mjs 串行调用验证无串话 |
| **INV-F** | `prompt_user` 不写 `~/.abrain/` 任何 markdown / frontmatter；只写 `audit.jsonl` | §D10；smoke-prompt-user.mjs fs.readdirSync 验证 |
| **INV-G** | `prompt_user` tool schema 不接受 `scope` / `key` 参数；不暴露任何 vault 操作入口 | §D2 (2)；schema validation + smoke |
| **INV-H** | `answers` 永远是 `Record<string, string[]>`；single 答案 length === 1；类型仍 array | §D1；smoke 显式 type check |
| **INV-I** | 同一 session 同一时刻 concurrent pending `prompt_user` ≤ 1；第二个调用立即返回 `schema-invalid + detail:"another prompt is pending"`，**不**复用 `cancelled` reason | §D8.3；smoke-prompt-user-finalizer.mjs §concurrent |
| **INV-J** | `redactCredentials` 在 `extensions/abrain/redact.ts`；`git-sync.ts` 通过 re-export 保持向后兼容；ADR 0020 §invariant 7 不退化 | §D6.2；测试 import path 仍工作 |
| **INV-K** | `compaction-tuner` 在 `agent_end` 时 `getPendingPromptCount() > 0` 跳过本轮 compaction 并 audit；下一轮 retry | §D11；smoke-prompt-user-finalizer.mjs §compaction-defer |

---

## 6. Constraints（与现有 ADR 不变量的兼容性）

| 上游 ADR | 兼容性论证 |
|---|---|
| **ADR 0014 §6 sub-pi 三层 guard / invariant #6** | §D3 三层 guard 完全继承现有 PI_ABRAIN_DISABLED 机制；prompt-user 挂在 abrain 内部，不引入新 extension / 新 env var / 新 layer |
| **ADR 0014 invariant #1 layer 1（main session 不直接 mutate brain SOT）** | INV-F：prompt_user 不写 markdown；slash handler 通过 internal service 收输入后仍走 transcript inject 或 fence，sediment async 写盘 |
| **ADR 0014 invariant #5（vault 明文授权）** | §D2 (2) (3) + §D6.5：vault_release 保留独立 tool + 独立 grant 状态；INV-G 禁止 prompt_user 暴露任何 vault 入口；type:"secret" raw 永不进 LLM |
| **ADR 0016 单一沉淀者 + prompt 引导 > 机械门控** | INV-F：prompt_user 只写 audit.jsonl；§D8 治理以 prompt + audit 为主，唯一 hard gate 是 concurrent ≤ 1（UI substrate 一致性，不是语义判断） |
| **ADR 0018 trigger phrase / body preservation** | prompt_user 不接触 existing entry，不做 update/merge。无关 |
| **ADR 0019 vault identity / master key edge** | §D2 (2)(3) + §D6.5：vault_release 独立；secret raw 不通过 sessionVaultKeys 写盘；master key edge 不被本 ADR 触及 |
| **ADR 0020 §invariant 4 / 7（no-secret-in-argv / output redaction）** | INV-J：`redactCredentials` 提升到 redact.ts 公共 helper；prompt_user 不通过 argv 传 secret；写入端三处独立 redact |
| **ADR 0021 不变量 #5（fence trust 边界继承 Lane A）** | §D10：prompt_user 不替代 transcript inject API；§D6.3 sediment transcript pre-pass redaction 复用 fence trust scan 机制；不引入新 attack surface |

---

## 7. Verification

### 7.1 smoke-prompt-user.mjs（≥ 22 assertions）

| § | 场景 | 关键 assertion |
|---|---|---|
| 1 schema | `questions.length=0` → `schema-invalid` |
| 1 schema | `questions.length=5` → `schema-invalid` |
| 1 schema | R4: `option.label` 含 `https://user:tok@host` → handler 入口 redact 后 audit/UI 无明文 credential |
| 1 schema | R4: `header` 含 credential URL → handler 入口 redact 后 audit/UI 无明文 |
| 1 schema | `header` = 8 ASCII + 4 CJK（= 16 cells）→ `schema-invalid`（display-width，不是 chars） |
| 1 schema | `id` 非 snake_case → `schema-invalid` |
| 1 schema | `id` duplicate within call → `schema-invalid` |
| 1 schema | `type:"single"` 缺 options → `schema-invalid` |
| 1 schema | `type:"text"` 带 options → `schema-invalid` |
| 1 schema | option count = 1 / 5 → `schema-invalid` |
| 1 schema | option.label > 5 words → `schema-invalid` |
| 2 happy | single：mock done 返回 "A" → `answers: {q1: ["A"]}` |
| 2 happy | multi：done 返回 `["A","C"]` → array 顺序按 options 定义 |
| 2 happy | text：done 返回 "hello" → `answers: {note: ["hello"]}` |
| 2 happy | secret：done 返回 raw "tok_..." → `answers[id]` = `[REDACTED_SECRET:<id>]`；`redactions[id]` 存在；raw 不在 tool result |
| 2 happy | "Other" 路径：done 返回 `__other__` + 后续 input → answer 是普通 string；audit 标 `via=other` |
| 3 INV-D | `reason` 含 `https://user:tok@host` → audit / UI 显示均 redacted |
| 3 INV-D | audit row 截断 240 chars |
| 3 INV-C | secret raw 不在 audit；audit 只有 `lengthBucket` 字段 |
| 3 INV-C | secret raw 不在 sediment transcript（pre-pass redaction） |
| 3 INV-H | single 类型 answer.length === 1，类型仍 array（`Array.isArray` true） |
| 3 INV-F | `fs.readdirSync(~/.abrain/identity)` 在调用前后无变化 |
| 4 i18n | mock `localizePrompt` 翻译，验证 dialog UI chrome 用翻译版；question/options 保留原文 |
| 4 i18n | Other 自由文本答案返回不翻译 |
| 5 narrow | terminal width = 40 → `ok:false, reason:"ui-unavailable"` |
| 5 narrow | terminal width = 70 → 走 full-width overlay，正常 done |

### 7.2 smoke-prompt-user-subpi.mjs（≥ 8 assertions）

| § | assertion |
|---|---|
| Layer 1 | dispatch spawn 子 pi env 含 `PI_ABRAIN_DISABLED=1` |
| Layer 2 | 子 pi tool list 不包含 `prompt_user`（不通过 activate early-return 注册） |
| Layer 3 | 强行通过 RPC schema 调用 handler → `{ok:false, reason:"subagent-blocked"}` |
| audit | 子 pi 写一条 `op=prompt_blocked, reason=subagent` |
| isolation | 子 pi fs.readdirSync(~/.abrain) 看不到任何 prompt_user 写入 |
| isolation | 子 pi 不能 mutate vault grant Maps |
| shutdown | session_shutdown 在子 pi 退出时不挂起；exit code 0 |
| ordering | dispatch childEnv 注入在 `...process.env` 之后（user `PI_ABRAIN_DISABLED=0` 不能 bypass） |

### 7.3 smoke-prompt-user-finalizer.mjs（≥ 12 assertions）

| § | assertion |
|---|---|
| session_shutdown | drains pending → resolve all with `cancelled`；durationMs 返回 |
| signal abort | `ctx.signal.abort()` → 立即 resolve `cancelled`；inner controller 不 forward |
| timeout | `timeoutSec=2` mock fake timer → `timeout` after 2s；durationMs ≥ 2000 |
| timeout clamp | `timeoutSec=5` → normalize 到 30；`timeoutSec=3600` → normalize 到 1800 |
| concurrent | 第二个 in-flight prompt_user → `schema-invalid, detail:"another prompt is pending"`（不是 cancelled） |
| concurrent | 第一个 resolve 后第二个可正常调用 |
| pending Map | 所有 resolve 路径后 pending.size === 0 |
| overlay close | mock UI handle，验证 close 被调一次 |
| fallback | mock `ctx.ui.custom` 为 undefined → 走 select/input chained；type:"text" 正常；type:"secret" → `ui-unavailable`（无 masked input） |
| fallback throw | mock `ctx.ui.custom` 抛 → 捕获并降级到同款 chained fallback，不冒泡为 exception |
| fallback audit | fallback 路径 audit 标 `via=fallback_chain` |
| soft cap | 同 turn 第 3 次 prompt_user success 调用 → `ok:true` 且 `detail` 含 batching warning（R4：D1 schema success branch 加 detail） |
| compaction defer | `getPendingPromptCount() > 0` 时 compaction-tuner agent_end 跳过 + audit `lane:"compaction", op:"deferred_for_prompt_user"` |
| compaction retry | 下一次 agent_end pending=0 时 compaction 正常执行 |

### 7.4 smoke-abrain-vault-reader.mjs 扩展（+ 4 assertions）

| assertion |
|---|
| vault_release 走 `ctx.ui.custom(PromptDialog, {variant:"vault_release"})` → 4 choices 返回正确 |
| fallback 路径（custom unavailable）仍工作；`releaseSessionGrants` set 正确 |
| 串行调用 vault_release 与 prompt_user 验证 PromptDialog 无串话（INV-E） |
| audit lane 仍为 `vault_release`，不是 `prompt_user`（INV-D 边界） |

---

## 8. Backlog / Deferred

| 项 | 触发条件 |
|---|---|
| **defer/resume**：持久化 pending question 到 `.state/prompt-user/pending.jsonl`，pi 重启后恢复 | 需要 pi runtime 暴露 session-resume API |
| **`type:"secret"` 经 `sessionVaultKeys` 完整版**：用户输入 → 短期 vault key → `$PROMPT_VAULT_<id>` bash injection → `agent_end` 清空 | 用户真实场景出现"prompt 收到的 token 要用于命令" |
| **richer types**：slider（数值范围）、file picker、date picker、sortable list | 真实 use case > 2 次 |
| **vault_release timeoutSec=600 默认**：把本 ADR 的 timeout 策略推广到 vault_release | 同期或下个 cycle 落地 |
| **transcript partial turn recovery**（sediment 通用能力）：tool call complete 但 result 未到达时 sediment 的行为 | sediment 自我改进发现高频 |
| **prompt_user 答案作为 first-class sediment evidence**（trust budget 提升） | §D8.2 已注入 curator prompt；如发现 curator 仍低估，提升为 explicit trust signal |
| **plan-mode 等价工具**（Claude `ExitPlanMode` 同类） | pi-astack 引入 plan mode |
| **per-turn hard rate-limit**：> N 次 prompt_user 自动 reject | 真实滥用出现 |
| **TUI footer pending indicator**：footer 显示 "1 prompt pending: <header>" | 用户反馈"pending overlay 被其他 dialog 盖住找不到了" |
| **conflict frequency telemetry**：audit lane 的统计回流为后续设计 | ADR 0020 R4 同款 deferred 思路 |

---

## 9. 开放问题与推荐答案

| Q | 问题 | 答案 |
|---|---|---|
| Q1 | `prompt_user` 是否允许在 sediment turn 内被 sediment LLM 调用？ | **否**。sediment 是后台 curator，没有真实用户监听。sediment 自己 registerTool 时不注册 prompt_user（与 vault_release 同款约束） |
| Q2 | 用户在 PromptDialog 内按 ESC 与按 No 是同语义吗？ | **是**：都 → `ok:false, reason:"user-rejected"`。audit 行 `via=esc` / `via=no_button` 区分 |
| Q3 | 答案中的 "Other" 自由文本是否走 `sanitizeForMemory`？ | **audit 路径走**（含 `redactCredentials`）；**tool result 不走**（LLM 需要原文） |
| Q4 | multi-select 答案的顺序 | **options 定义顺序**（不是用户勾选顺序）；保证可预测；与 OpenCode 一致 |
| Q5 | soft cap (>2 次/turn) 暴露给 LLM？ | **是**（`detail` 附 warning string），但不强制；soft cap 是引导 |
| Q6 | concurrent pending 第二个 call 用什么 reason？ | **`schema-invalid` + detail**，不复用 `cancelled`，避免与 session shutdown / signal abort 歧义 |
| Q7 | dynamic content（question/options）是否需要 i18n？ | **不需要**。LLM 通常已用当前用户语言；二次翻译会破坏 schema 与 answer label 一致性 |
| Q8 | `prompt_user` 在 `compaction-tuner` 期间发生怎么办？ | compaction defer（§D11 + INV-K）；pending 全部 resolve 后下一轮 retry |

---

## 10. R1-R4 multi-LLM design discussion trail

本 ADR 经历 R1 独立提案 + R2 交叉审计 + R3 综合稿 + R4 P0 收敛审计四轮 multi-LLM discussion。R4 P0 收敛于 2026-05-17 完成，本 ADR 即 R4-fix 应用后版本。

### R1 — 三家独立提案（2026-05-17）

| Model | 文件 | 关键立场 |
|---|---|---|
| `anthropic/claude-opus-4-7` | `/tmp/adr-0022-r1-opus.md` | P0 reject `type:"secret"` / `forbidOther` LLM-controllable / 三层 sub-pi guard / `redactCredentials` 提升公共 helper / 8 个具名 INV-A 至 INV-H |
| `openai/gpt-5.5` | `/tmp/adr-0022-r1-gpt.md` | P0 支持 `type:"secret"` 但 placeholder-only / single pending hard gate / "tool result ≠ user message" 否决 G2 直接受益论 / display-cells header / 6 个 failure reason 含 `cancelled` |
| `deepseek/deepseek-v4-pro` | `/tmp/adr-0022-r1-deepseek.md` | P0 支持 `type:"secret"` 但 `[SECRET:N chars]` 长度泄漏 / `timeoutSec=0` 允许无限挂起（错） / 双层 guard（不足） / `PI_PROMPT_USER_DISABLED` 新 env var（不必要） / G2 fallback 路径自相矛盾 |

### R2 — 三家交叉审计（2026-05-17）

每家审另两家，跳过自己。共识与裁决：

1. **`forbidOther` 必须删除**（OPUS 错，GPT/DEEPSEEK 共同否决）—— 违反 brief §4.3 共识
2. **`type:"secret"` P0 启用但严格 placeholder-only**（GPT 方案胜，OPUS 的 P0 reject 论据建在虚构的"vault SoT"引用上，DEEPSEEK 的长度泄漏被否）
3. **不引入新 `PI_PROMPT_USER_DISABLED` env**（DEEPSEEK 提出，GPT/OPUS 共同否决）—— prompt-user 挂 abrain 内部继承现有三层 guard
4. **`timeoutSec=0` 拒绝**（DEEPSEEK 错，OPUS/GPT 共同否决）
5. **failure reason 扩到 6 个**（合并 GPT 的 `cancelled` + OPUS 的 `schema-invalid` + brief 原 4 个）
6. **concurrent pending ≤ 1 hard gate**（GPT 提出，三家审计共同采纳；但 reason 用 `schema-invalid` 不是 `cancelled`）
7. **header = display cells 不是 chars**（GPT 提出，DEEPSEEK 审计同意）
8. **G2 关系**：tool result ≠ user message（GPT 正确，OPUS R1 的"G2 直接受益"论断被 GPT/DEEPSEEK 双否决）
9. **三家共同遗漏 7 项**（R3 §D3 ordering / §D4 inner controller / §D5 DynamicBorder / §D11 compaction defer / §D12 internal service / §D2 vault_release fallback 保留期 / §7 fallback smoke）—— R3 全部补入

R2 审计员逐项裁决记录在 `/tmp/adr-0022-r2-summary.md`，包含 20 条"已收敛的关键裁决" + 7 项遗漏设计点。

### R3 综合稿（本文，2026-05-17）

由 R2 收敛裁决直接落地为最终 ADR。每个 §D 末小字标注章节来源（`基础: OPUS §X + 吸收: GPT §Y / DEEPSEEK §Z`）。

### R4 — P0 收敛审计（2026-05-17 完成）

R3 综合稿经 3 家 T0 并行 P0 收敛审计：

| Model | 总评 | P0 数 | P1 数 |
|---|---|---|---|
| `anthropic/claude-opus-4-7` | A- | 0 | 5 |
| `openai/gpt-5.5` | B- | 3 | 4 |
| `deepseek/deepseek-v4-pro` | B+ | 2 | 4 |

**P0 收敛轨迹**：R1 暴露分歧 9 项 → R2 收敛到 20 条裁决 + 7 项补充 → R3 综合稿 P0 数 3 → **R4-fix 后 P0=0**。

**R4 应用的修补包**（本版本已落实）：

1. **GPT P0-1（ctx.ui.custom 矛盾）**：§D3 handler 伪代码、INV-A、§D7 fallback 三处统一为 "`ctx.ui.custom` 不可用 → 降级到 §D7 chained fallback；不计入 INV-A reject"，与 R2 裁决 #18 对齐
2. **GPT P0-2（D1 success branch 缺 detail 字段）**：§D1 `ok:true` branch 加 `detail?: string`；§D8.4 soft cap warning 通过 detail 返回；§7.3 smoke 加 soft-cap assertion
3. **GPT P0-3（redact 字段覆盖不全）**：§D6.2 `redactPromptParams` 扩到 5 个 user-visible 字段（`reason` / `header` / `question` / `option.label` / `option.description`）；§D6.3 文本同步更新；§5 INV-D 修订；§7.1 加 credential-in-label / credential-in-header smoke
4. **DEEPSEEK P0-1（LOC 估算不一致）**：§4.1 各文件 LOC 下调（schema 220→160，manager 180→120，handler 150→100，PromptDialog 380→280）；§4.4 PR 大小重算为 ~1250 LOC（1100-1400 范围）
5. **DEEPSEEK P0-2（INV-C 描述与 P0 可消费路径不一致）**：§D6.1 边界图中 caller-side callback 标为 P4 deferred；§D6.4 改为 P0 仅 ship schema/UI/redaction，**不**暴露 callback API；§5 INV-C 同步修订
6. **OPUS P1-1（INV-D 措辞 overpromise sediment 三处独立）**：§5 INV-D 精确为 "两处独立 + sediment 兜底（仅 secret placeholder，不 cover URL credential）"
7. **OPUS P1-3（bash_output_release variant 缺 smoke）**：§7.4 vault-reader 回归从 +4 → +5 assertion，加 `authorizeVaultBashOutput` PromptDialog 路径
8. **OPUS P1-4（Memory_search typo）**：§D8.1 promptGuidelines 修正大小写
9. **OPUS P1-5（git-sync.ts re-export 语义不明）**：§D6.2 + §4.2 明示 "移除 L133 原始定义，改为 re-export"，避免 module 内重复 symbol

**P2 issues**：行号 1 行偏差（git-sync.ts L132-134 实际 L133）、`pi.on` vs `eventRegistry.on` 风格、`visible-width` vs `display cells` 术语统一——保留至 ship 后 housekeeping commit，不阻塞。

pi-astack 现有 ADR 0019 / 0020 / 0021 都走完整 4 轮 multi-LLM audit；本 ADR 不破例，R4 fix-pack 应用完毕，可以 ship。

---

## 11. 参考

- **Brief**：`/tmp/adr-0022-brief.md`（R1 共享上下文）
- **R1 草稿**：`/tmp/adr-0022-r1-opus.md` / `/tmp/adr-0022-r1-gpt.md` / `/tmp/adr-0022-r1-deepseek.md`
- **R2 审计裁决**：`/tmp/adr-0022-r2-summary.md`
- **R2 instructions**：`/tmp/adr-0022-r2-instructions.md`
- Claude Code `AskUserQuestion`：https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-askuserquestion.md ；https://code.claude.com/docs/en/agent-sdk/user-input
- Codex `request_user_input`：`codex-rs/protocol/src/request_user_input.rs` / `codex-rs/core/src/tools/handlers/request_user_input.rs` / `request_user_input_spec.rs`
- OpenCode `question`：`packages/opencode/src/question/index.ts` / `packages/opencode/src/tool/question.ts` / `packages/opencode/src/permission/index.ts`
- pi SDK：`docs/extensions.md` §Custom UI / §ExtensionContext / §session_shutdown；`docs/tui.md` §OverlayOptions / §Focusable / §DynamicBorder
- pi-astack：
  - `extensions/abrain/index.ts` L208 `VAULT_RELEASE_AUTH_CHOICES` / L384-386 grant Sets / L455 `authorizeVaultBashOutput` / L552-580 `authorizeVaultRelease` / L599 abrain activate early-return / L868 `eventRegistry.on("session_shutdown", ...)` / L878 `registerTool("vault_release")`
  - `extensions/abrain/i18n.ts::localizePrompt`
  - `extensions/abrain/git-sync.ts` L132-134 `redactCredentials`
  - `extensions/dispatch/index.ts` L298-300 PI_ABRAIN_DISABLED env injection ordering（deny-by-default）
  - `extensions/compaction-tuner/index.ts` L138 agent_end 触发
- 上游 ADR：0014 §6 / 0016 / 0018 / 0019 / 0020 §invariant 7 / 0021 §D4
