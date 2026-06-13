---
doc_type: adr
status: accepted
---

# ADR 0003 — 主会话只读，sediment 单写

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的决策已上提 `INV-MAIN-SESSION-READ-ONLY` + `REQ-005`，以那里为 canonical。以下机制正文**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

> ⚠️ PARTIALLY HISTORICAL：核心原则“主会话只读 / sediment 单写”仍是 current invariant；旧 gbrain CLI、postgres role、bash regex guard 实现只作为历史参考。

- **状态**: Accepted。**Guard 实现已过时**（2026-05-07）— memory-architecture.md §6.1 定义了新的读工具 `memory_search/get/list/neighbors` 替代 `gbrain_search/get/query`。Guard 的拦截目标从 gbrain CLI/bash 变为 memory write tools（仅 sediment 可见）。读写分离核心原则不变。
- **2026-05-09 补充**（由 [ADR 0014 v1.3](0014-abrain-as-personal-brain.md) 带入）：主会话只读原则**不取消**，但补充为两层：
  - **层 1 mechanic**：LLM tool call surface 中**没有**定制 brain mutation tool——没有 `vault_write`/`brain_write` 这类专门入口。Lane V 的 `/secret` 是用户物理键入 TUI 命令触发 main pi 进程内 vaultWriter library 同步调用（不进 LLM tool surface）。Lane G `/about-me` 仍走 sediment 异步。sediment 仍为记忆类写入的唯一 dedicated writer。
  - **层 2 best-effort residual surface**（已知 trade-off）：LLM 仍可通过通用 tool（bash / edit / write / dispatch_agents）间接写 brain SOT（例如 bash 调 `secret-tool` + `age` 手写加密文件、bash spawn 子 pi、edit/write 改 markdown SOT）。这些路径**不被机制拦截**，靠 §6.5.1 stdout 默认不回流 + §6.6 redaction + sediment audit 后置检测三重防护层 best-effort 覆盖。详 ADR 0014 §坟处 #10。
- **2026-05-18 R8 补充**（由 [ADR 0022](0022-prompt-user-tool.md) 带入）：`prompt_user` LLM-facing tool + P3c-lightweight trust elevation 以及 DEEPSEEK xhigh audit 对 ADR 0003 「软化」的可能质疑。**重新论证**：P3c-lightweight 让 sediment curator 将 `toolResult:prompt_user` 视为 USER-ATTESTED，似乎给主会话开了影响 brain SOT 决策的信道。**但**：`prompt_user` 答案的信任源是 **用户物理键盘** （TUI 对话框勾选 / 输入），**不是 LLM 推断**。从信任源论，该信号类比 [ADR 0021](0021-lane-g-identity-skills-habits-writer.md) Lane A explicit `MEMORY:` block（用户亲手写出的 fence），是「用户亲手造事」而非「LLM 诱导事件」。层 1 mechanic 仍成立：主会话仍不直接 mutate brain SOT、prompt_user 仅写 audit.jsonl（ADR 0022 INV-F）、sediment 仍是唯一 dedicated writer。变化仅仅是输入信号中多了一个类似 Lane A 的高置信号，curator 必须将候选 ground 在 (question + options + reason + answer) 完整上下文（ADR 0022 INV-M，防 LLM 通过引导性问题造造伪 user-attested 信号）。

  本 ADR 主体描述的 bash regex / postgres 凭证隔离 / protected paths guard 已被 memory-architecture.md §6 的 tool registration 分离替代——主 session 不注册定制 mutation tool 但仍能通过通用 bash/edit 间接触达 brain SOT。详 ADR 0014 §坟处 #10 与不变量 #1 的精确 wording。
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0002（superseded by memory-architecture.md）/ ADR 0004（sediment 写入）
- **后续**: [memory-architecture.md](../memory-architecture.md) §6（新 tool 接口），§8（读写分离与 sediment 行为）；[ADR 0014 v1.3](0014-abrain-as-personal-brain.md)（不变量 #1 拆为 mechanic + best-effort 两层；vault 写入例外；坟处 #10 LLM 通用 tool 间接写 brain residual surface）

## 背景

主会话同时具有读写记忆能力会有几个问题：
- 主 LLM 冲动写入（看到一个有趣观察就写，污染长期记忆）
- 重复写入（多轮会话识别同一洞察，每次都写）
- 跨 source 误写（项目事件被写到 default source）
- 写入与对话耦合，无法事后审计

brain maxim `give-main-agents-read-only-knowledge-tools-delegate-all-writes-to-a-sidecar` 明确要求：主会话只读，sidecar 单写。

## 决策

主会话**只读**记忆，**不写**记忆。所有写入由 pi-sediment（sidecar）代理。

v6.5.1 修订："只读"不能只靠"不注册 gbrain_put tool"这种 omission，必须有机制性 guard。主会话仍拥有 `bash` / `edit` / `write` / `dispatch_agents` 等通用能力，若不拦截，会绕过 sediment、voter、source-router、schema-enforcer、readback、pending queue 与 audit log。

### 主会话工具集与强制 guard（历史实现，已被 memory-architecture.md §6 替代）

> **⚠️ 过时**：以下 guard 实现基于 gbrain CLI/bash 拦截。新架构中读写分离由 tool 注册控制（memory-architecture.md §8.1）：主 session 仅注册 `memory_search/get/list/neighbors`，sediment 独享内部 writer substrate（create/update/merge/archive/supersede/delete/skip），不注册 LLM-facing 写工具。不再需要 bash 命令字符串解析来拦截写入。

| 类别 | Tools / 机制 | 说明 |
|---|---|---|
| 记忆读 | `gbrain_search` / `gbrain_get` / `gbrain_query` | 三个 read tool，迁入 `extensions/gbrain/`，含 markdown fallback |
| 沉淀写 | **无** | 主会话不注册任何写记忆的 tool |
| 写入绕道拦截 | `tool_call` guard | 阻断 bash/generic file tools 对 gbrain 与 memory cache 的写入绕道 |
| 子代理权限 | `dispatch_agent(s)` 默认 `tools=∅` | 默认无工具；mutating tools 不委托给子代理；详见 ADR 0009 |

#### Guard 1：阻断 direct gbrain CLI write + postgres 直连

`extensions/gbrain/` 或 `extensions/sediment/` 注册 `pi.on("tool_call", ...)` handler，拦截主会话 `bash` 命令。

**方法**：不靠 regex 匹配 `event.input.command` 字符串（可被绝对路径、bash -c、eval、管道、空格变体绕过），而是解析 argv token 树：

```typescript
// extensions/gbrain/guard-bash.ts

const WRITE_SUBCOMMANDS = new Set([
  "put", "put-page", "delete", "update", "import",
  "migrate", "restore", "sources",  // sources sub-subcommands checked below
]);
const SOURCE_MUTATIONS = new Set(["add", "remove", "update"]);

function isGbrainWriteAttempt(command: string): boolean {
  const tokens = parseCommandTokens(command);  // splits pipelines, &&, ||, ;, subshells, backticks
  for (const cmd of tokens) {
    const argv = splitArgv(cmd);
    if (argv.length < 2) continue;

    const basename = path.basename(argv[0]);
    if (basename !== "gbrain" && basename !== "gbrain.exe") {
      // Check for postgres direct connection attempt
      if (basename === "psql" || basename === "pgcli") {
        if (argv.some(a => a.includes("INSERT INTO pages") || a.includes("UPDATE pages"))) {
          return true;  // direct db write attempt
        }
      }
      continue;
    }

    const sub = argv[1];
    if (WRITE_SUBCOMMANDS.has(sub)) {
      if (sub === "sources") {
        const subsub = argv[2];
        if (SOURCE_MUTATIONS.has(subsub)) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

// parseCommandTokens splits on pipe (`|`), &&, ||, `;`, subshell (`$(...)`, backticks),
// and single/double-quoted strings to avoid substring false positives
```

命中后返回 `{ block: true, reason }`，提示："长期记忆写入由 sediment 处理；用户显式管理请用 `/memory-pending ...` 或手工 shell（不经 LLM）"。

**PostgreSQL 凭证隔离（v6.5.2 关键）**：gbrain 底层是 PostgreSQL CLI wrapper。主会话 bash tool 如果能读 `~/.gbrain/config.toml` 就能拼出 `psql ... INSERT INTO pages` 直连数据库，完全绕过 sediment 单写体系。因此：
- gbrain 数据库应有**两个 role**：`gbrain_read`（select-only）和 `gbrain_write`（select + insert/update/delete）
- sediment 和服务端使用 `gbrain_write` role
- 主会话 bash tool **看到的 `~/.gbrain/config.toml` 只能含 `gbrain_read` 凭证**，不能拿到写权限
- 或者 `config.toml` 归 sediment 专有路径，主会话读不到

#### Guard 2：保护 memory cache / routing marker（v6.5.2 加固）

阻断主会话通过 `write` / `edit` / `bash` 修改以下路径（含 realpath 解析，防 symlink 攻击）：

```typescript
const PROTECTED_PATTERNS = [
  /\.gbrain-source/,
  /\.gbrain-scratch/,
  /\.gbrain-config/,
  /\.gbrain-cache\//,     // ⬅ v6.5.2 补上，含 sediment.log / pending.jsonl / markdown/
  /\/\.gbrain\//,          // ⬅ ~/.gbrain/ 配置目录
];

function isProtectedPath(inputPath: string): boolean {
  const resolved = realpathSafe(inputPath) ?? inputPath;
  return PROTECTED_PATTERNS.some(p => p.test(resolved));
}
```

**为什么需要保护 `.gbrain-cache/`**：
- `sediment.log` — 含 voter 行为、证据引用、写入决策，伪造会破坏审计完整性
- `sediment-pending.jsonl` — 含候选条目和证据，LLM 可直接注入恶意 pending 条目
- `markdown/` — offline fallback 的降级搜索源，污染后 gbrain 不可用时主会话拿到攻击者控制的内容，绕过整个 voter/schema/readback 链

#### Guard 3：dispatch_agents 不得 capability escalation

主会话不能通过 `dispatch_agents({ tools: "bash,edit,write" })` 把写权限委托给子代理。ADR 0009 规定：子代理默认无工具；readonly tools 需要显式 allowlist；mutating tools 默认拒绝或需要用户确认，sediment voter 永远 `tools=∅`。

### sediment 触发机制

sediment 通过 pi 的 `agent_end` event 监听完整 agent 上下文，自主判断：
- 这一轮有几条独立洞察？
- 每条洞察归属哪个 source？
- 是否需要派生写（详见 ADR 0004）？
- 是否符合 schema 约束？readback assert 通过吗？

用户在对话里说"记下这条 / 以后记住这个决定 / promote 这条 short-term"——sediment 从 agent_end 完整对话上下文识别用户意图，无需额外 intent tool。

若用户要求立刻确认是否落库，主会话应提示查看 `/memory-pending list` 或 sediment.log，而不是承诺"我已经记住"。

## 与 v6 原版的差异

v6 原版曾提议引入 `memory_remember` / `memory_refine` / `memory_promote` 三个 intent tool（M2），让主会话生成结构化 intent 给 sediment 消费。**v6.5 删除该提议**，理由：

1. sediment 看完整 agent_end 上下文，能从对话文本识别用户写入意图
2. 多一个 tool 增加主会话认知负担（什么时候调？fail-closed 怎么处理？）
3. 多一条消费路径（intent queue + agent_end 上下文，两路融合）
4. 没解决根本问题：sediment 仍可能误判，intent 只是"加权重"

如果未来发现 sediment 上下文识别真的不够，再单独立项加（v6.6+）。**v6.5 不需要它**。

## 后果

### 正面
- 主会话写入冲动归零
- 写入与对话解耦，sediment 可以做 multi-agent vote / dedupe / refine 等异步处理
- 审计简单：所有写入一处来源
- 兼容 brain maxim

### 负面
- 用户说"记下这条"后没有即时反馈（sediment 是异步的）
- 用户必须信任 sediment 的判断（黑箱风险）
- **缓解**：sediment 的写入决策必须**可追溯**——每次 agent_end 后产出一条简短日志（写了什么 / 没写什么 / 为何不写），写入 `~/.pi/.gbrain-cache/sediment.log`（gitignored），用户可随时查阅

## 引用

- brain maxim: `give-main-agents-read-only-knowledge-tools-delegate-all-writes-to-a-sidecar`
- ADR 0002: gbrain 作为唯一记忆存储
- ADR 0004: sediment 写入策略
