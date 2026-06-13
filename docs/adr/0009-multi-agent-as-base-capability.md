# ADR 0009 - multi-agent 作为基础能力,调用模式作为模板参考

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的方向立场（dispatch 是基座能力、非固定策略工厂；反约束 LLM）见 `direction.md`，以那里为 canonical。以下机制正文**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

> ⚠️ PARTIALLY HISTORICAL：原则“dispatch 是基础能力”仍有效；旧 `dispatch_agents`、`multi_dispatch`、`extensions/multi-agent/`、templates cookbook 细节只作为历史设计动机。

- **状态**: Accepted (revised 2026-05-11)
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0001(pi-astack 定位)/ ADR 0006(组件合并)
- **补充说明（2026-05-07）**：本 ADR 中的 "sediment voter 借 dispatch_agents 跑 3 个 model" 例子已被 ADR 0010 证伪。sediment 已转为单 agent + lookup tools（memory-architecture.md §8.2），不再是 dispatch_agents 的消费者。dispatch_agent/agents 作为主会话基础能力的设计初衷不变。
- **补充说明（2026-05-13，`dispatch_agents` → `dispatch_parallel` 重命名）**：`dispatch_agents` 因与 `dispatch_agent` 仅差一个 `s` 字符导致 LLM 频繁误判（该用复数的用单数串行跑，该用单数的用复数浪费并行设施），已于 2026-05-13 重命名为 `dispatch_parallel`。新名在语义空间完全分离（agent vs parallel），避免拼写混淆。下文出现的 `dispatch_agents` 请读为 `dispatch_parallel`；所有 `promptSnippet`、`promptGuidelines`、schema、error message 已同步更新。
- **补充说明（2026-05-11，实现差异 reconciliation）**：本 ADR 原文描述的组件路径与实际 v0.1 ship 状态有出入，设计原则（"基础能力 > 固定 strategy"）不变：
  - 目录从 `extensions/multi-agent/` 重命名为 `extensions/dispatch/`；vision/imagine 同期拆出为独立扩展。下文出现的 `extensions/multi-agent/...` 请读为 `extensions/dispatch/...`。
  - `multi_dispatch(strategy, tasks)` 始终未成 registered tool 发出。`extensions/dispatch/index.ts` 只注册 `dispatch_agent` + `dispatch_parallel`（原名 `dispatch_agents`，2026-05-13 重命名为 `dispatch_parallel`）。下文提到的 "`multi_dispatch` 保留作为兼容 / v0.2 下架" 一入场就省了。
  - `extensions/multi-agent/templates/{parallel,debate,chain,ensemble}.md` 未建。代替是 `promptSnippet` + LLM 自主组合；cookbook 未来要加会作为主会话 skills (`~/.pi/agent/skills/...`) 下发。
  - `vision` / `imagine` 由独立扩展 `extensions/vision/` `extensions/imagine/` 提供。

## 背景

pi-multi-agent 在 alfadb/pi-multi-agent 仓中以四种"调用模式"(strategy)暴露:
- `parallel` - 多任务独立并行执行
- `debate` - 多模型多轮辩论
- `chain` - 任务串行接力
- `ensemble` - 独立投票 + 综合

历史上这四种 strategy 是固定枚举的 API 字段(`multi_dispatch(strategy, tasks[])`),主会话必须从中选一种。

但实际使用中:
- 主会话遇到的实际任务往往是**多种模式的组合**(先 parallel 收集,再 debate 收敛;或先 chain 推理,最后 ensemble 投票)
- 现有四种 strategy 不能覆盖所有场景(如:动态根据中间结果决定是否再加一个 reviewer)
- 主会话被迫"映射"实际需求到固定模式,损失表达力

更关键的是:**主会话本身是高能力 LLM**,能理解"我想让两个不同模型独立审查这段代码、然后再让第三个模型综合"这种意图。固定 strategy 反而限制了它的判断。

## 决策

multi-agent 作为**基础能力**而非"固定模式工厂"。

### 核心 API(基础能力)

主会话可自主组合调用,不被四种 strategy 绑定。

```typescript
// 单任务委托
dispatch_agent({
  model: string,
  thinking: "off"|"minimal"|"low"|"medium"|"high"|"xhigh",
  prompt: string,
  tools?: string,            // 子代理可用工具(默认无)
  timeoutMs?: number
})
// → returns { id, result, usage, durationMs }

// 多任务并行(基础并发原语)
dispatch_agents([{...}, {...}, ...]) // 数组形式
// → returns [{...result1}, {...result2}, ...]
```

主会话拿到结果后**自主决定**:
- 是否再发一轮(debate-like)
- 是否让另一个 model 综合(ensemble-like)
- 是否串行接力(chain-like)
- 是否半路加更多 reviewer

主会话用对话内的推理能力做"调度决策",而不是把决策硬编码在固定 strategy 里。

### 现有四种 strategy 的处置

`parallel` / `debate` / `chain` / `ensemble` 不消失,但**降级为模板**:

- 实现位置（**未落地**，见顶部 2026-05-11 reconciliation）:`pi-astack/extensions/multi-agent/templates/`
- 形式:每个 strategy 对应一份 markdown 描述("何时用、参数怎么填、如何融合结果")
- 主会话**参考**这些模板设计自己的调用,而不是被它们限制

例:

```markdown
# Template: debate (适用场景:多视角分析、风险审查)

何时用:
- 一个争议问题需要多个独立观点
- 不同模型可能有互补失败模式
- 需要 N 轮往返质询(N=2-3 轮典型)

调用骨架:
轮 1: dispatch_agents([
  { model: A, prompt: "你的视角1" },
  { model: B, prompt: "你的视角2" },
])
轮 2: dispatch_agents([
  { model: A, prompt: "看了 B 的回答,你怎么回应:${B_round1}" },
  { model: B, prompt: "看了 A 的回答,你怎么回应:${A_round1}" },
])
轮 3: dispatch_agent({ model: synthesizer, prompt: "综合 A B 两轮辩论:..." })

主会话决定何时停轮、何时换 model、何时加观察者。
```

主会话读这个模板**就像读一份 cookbook**,而不是调一个固定 API。

### sediment 怎么用 multi-agent

sediment 的多模型投票(ADR 0004)依赖 multi-agent 的基础能力:

```typescript
// sediment 内部
const votes = await dispatch_agents([
  { model: "openai/gpt-5.5",          thinking: "high", prompt: votePrompt(ctx) },
  { model: "anthropic/claude-opus-4-7", thinking: "high", prompt: votePrompt(ctx) },
  { model: "deepseek/deepseek-v4-pro",  thinking: "high", prompt: votePrompt(ctx) },
])
// sediment 自己决定 quorum 规则
```

sediment 不调"ensemble strategy",而是直接 `dispatch_agents`,自己组合 quorum 逻辑。

### 输入兼容契约(兼容 JSON 字符串与对象输入)

**背景实例**:调用者(主会话 LLM 或上层 RPC)生成参数时偶发会把 array / object 反序列化为 JSON 字符串,导致 `must be array` / `must be object` 的 schema 验证错误。实测出现过双重 stringify 场景(上层 RPC + 模型 prompt template 各 stringify 一次)。

**决策**（2026-05-11 修订：`multi_dispatch` 从未 ship，实际只有下述两个）:`dispatch_agent` / `dispatch_agents` 两个 registered tool 都保持 strict `parameters` schema;兼容逻辑统一放在 pi 官方 `n(args)` 钩子(argument preparation hook)里,调用同一个 `extensions/dispatch/input-compat.ts`。内部 typed API(sediment 调用)不走 registered tool,也不走 input compat。

原则:**兼容在 n(args)(argument preparation hook),契约在 parameters**。禁止用 `Type.Any()` 放宽主 schema 来绕过验证。

#### 兼容范围

| 字段 | 期望 | 偶发返回 | 兑底 |
|---|---|---|---|
| `dispatch_agents` 的 `tasks` | array | `"[{...},{...}]"` | JSON.parse(最多两层 unwrap)|
| `options` | object | `'{"taskTimeoutMs":1200000}'` | 同上 |
| `task.tools` | string CSV | `["read","edit"]` array | array → CSV (`.join(",")`) |
| `task.tools` | string CSV | `'["read","edit"]'` JSON 字符串 array | parse + join |
| `task.timeoutMs` | number | `"600000"` 数字字符串 | `Number(value)` |
| 任意嵌套 | array/object | stringified | 外层 unwrap 后递归进入子字段 |

#### 双重 unwrap 逻辑上限

```typescript
function unwrapStringified(value: unknown, maxDepth = 2): unknown {
  let current = value;
  for (let i = 0; i < maxDepth; i++) {
    if (typeof current !== "string") break;
    try {
      const parsed = JSON.parse(current);
      // 关键:parsed 仍是字符串才再次 parse;其他类型立即返回
      if (typeof parsed !== "string") return parsed;
      current = parsed;
    } catch {
      // 不是 JSON,按原值往后传(让下游 schema 报错)
      return current;
    }
  }
  return current;  // 远超两层还是字符串,让 schema validator 报错
}
```

两层是合理 sweet spot:
- 单层:覆盖 RPC 边界或模型 prompt template 其中一处误 stringify
- 双层:覆盖两处同时 stringify(已实测过)
- 三层+:应该是调用者严重错误,不仅迫掊护

#### 类型转换限定在已知字段

```typescript
function normalizeTaskSpec(raw: unknown): TaskSpec {
  const t = unwrapStringified(raw) as any;
  return {
    id: t.id,
    model: t.model,
    thinking: t.thinking,
    prompt: t.prompt,
    role: t.role,

    // tools: array → CSV;JSON 字符串 array → parse 后 join
    tools: (() => {
      const v = unwrapStringified(t.tools);
      return Array.isArray(v) ? v.join(",") : v;
    })(),

    // timeoutMs: 数字字符串 → number
    timeoutMs: typeof t.timeoutMs === "string" ? Number(t.timeoutMs) : t.timeoutMs,
  };
}
```

**原则**:新加字段**默认不**享受兑底,要兑底要显式加一行。避免"幽灵兼容"(某天某字段莫名其妙接受奇怪输入,没人记得为什么)。

#### 错误消息四要素

兑底失败时输出对模型友好的错误,含四部分:

```
Field 'tasks': expected array (or JSON string of array).
Got: string after 2 unwrap attempts.
Last unwrap result: '[{id:a}]' (still string, not parseable as JSON).
Hint: pass tasks as actual JSON array. Example:
  {"tasks": [{"id": "a", "model": "openai/gpt-5.5", "thinking": "low", "prompt": "..."}]}
```

四要素缺一不可:
1. **字段名** -- 模型看到才知道改哪个
2. **期望类型** -- 明确告诉它该是什么
3. **实际收到 + unwrap 进度** -- 让模型理解兑底已尽力
4. **修正示例** -- 1-shot 例子让模型下一轮直接抄

该错误模板放在 `input-compat.ts` 里导出 `formatCompatError(field, expected, gotPreview, hint)`,三个 registered tool 的 `n(args)` / `execute` 共用。

#### 适用范围

- `dispatch_agent` / `dispatch_agents` registered tool 的 `n(args)` hook（`multi_dispatch` 从未 ship，原文列出的第三个 hook 不存在）
- ~~multi_dispatch 兼容层内部转发~~（从未 ship，仅作设计动机记录） → dispatchAgents typed API 时不重复兑底(已在外层过一道)
- 子代理 / sediment 内部代码调用 → 不走兑底(代码调代码不会 stringify)

### 子代理工具安全边界

> **2026-05-15 修订**：本节原表第一行写「主会话普通 `dispatch_agent(s)` | `[]` | 纯推理,无工具」与实际实现不符。`extensions/dispatch/index.ts:273` 实际默认 allowlist 是 `read,grep,find,ls`（read-only tools），不是 `[]`。下表已更正。安全边界仍然成立：mutating tools 默认拒绝、嵌套 dispatch 始终拒绝；只是 "默认" 那一档是 read-only 而不是 deny-all。

`dispatch_agent(s)` 是 capability boundary。默认必须是 deny-all 写权：

| 场景 | tools 默认 | 允许 |
|---|---|---|
| 主会话普通 `dispatch_agent(s)`（不传 tools） | `read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_neighbors,memory_decide` | 只读文件/搜索/列目录 + web 检索 + brain 只读（**2026-05-31 更正**：原表只列 `read,grep,find,ls`；ADR 0027 PR-B 后默认 allowlist 已扩入 web + memory 只读工具，让 sub-agent 能读 brain。以 `extensions/dispatch/index.ts` 默认 allowlist 字符串为准） |
| 显式 readonly + memory | 显式传 `read,grep,find,ls,memory_search,memory_get,memory_list,memory_neighbors` | 加上 markdown memory facade |
| vision / imagine | 单独 allow | 需要模型/图像场景时显式列出 |
| mutating tools (`bash`/`edit`/`write`) | 默认拒绝 | 必须 `PI_MULTI_AGENT_ALLOW_MUTATING=1` env gate 才能进入 allowlist；嵌套 `dispatch_agent`/`dispatch_parallel` 任何时候都拒绝 |
| sediment voter（设计假设，sediment 已不走 dispatch） | **永远 `[]`** | voter 是 pure reasoning;audit 记录 `voter_tools: []` |

`tools` 字段在 normalize 后必须经过 allowlist 校验:嵌套 dispatch 始终拒绝；mutating tools 在 env gate 缺失时拒绝并报错，不静默忽略（`extensions/dispatch/index.ts` `validateTools()`)。

### vision / imagine 工具不变

> **2026-05-11 修订**：`vision` / `imagine` 已被拆到独立扩展 `extensions/vision/` + `extensions/imagine/`，不再随 multi-agent (现 `dispatch`) 打包。本节以下描述的 "依附 pi-multi-agent" 已 stale；委托语义 (`tools: "vision,readonly"`) 不变。

`vision` 和 `imagine` 仍然是 pi-multi-agent 自带的两个 registered tool(通过 `pi.n()` 注册),主会话直接调。

它们不被本 ADR 影响:
- vision:主会话调用看图
- imagine:主会话调用生图
- 子代理可通过 `tools: "vision,readonly"` 委托使用

## 实现影响

### extensions/dispatch/index.ts

> **2026-05-11 修订**：原标题写 `extensions/multi-agent/index.ts`。实际 ship 路径是 `extensions/dispatch/index.ts`。`multi_dispatch` 从未落地；vision/imagine 拆入独立扩展。下表修正实现状态。

注册的工具集变化：

| 工具 | v6 之前 | shipped (extensions/dispatch/) |
|---|---|---|
| `dispatch_agent(opts)` | 不存在 | **新增**基础能力（唯一路径） |
| `dispatch_agents(opts[])` | 不存在 | **新增**基础并发能力（max 16 tasks，in-process worker pool MAX_CONCURRENCY=4） |
| ~~`multi_dispatch(strategy, tasks)`~~ | 固定 4 strategy | **未 ship**——原计划作为兼容 surface，实际未注册 |
| `vision(prompt, image)` | 已有 | 拆入 `extensions/vision/`（ADR 0006 reconciliation） |
| `imagine(prompt, ...)` | 已有 | 拆入 `extensions/imagine/`（ADR 0006 reconciliation） |

### ~~extensions/multi-agent/templates/~~

> **2026-05-11 修订**：本节描述的 templates/ 目录从未落地。LLM 仅从 `dispatch_agent` / `dispatch_agents` 的 `promptSnippet` + `promptGuidelines` 获得指引，自主组合 parallel / debate / chain / ensemble 调用。原设计保留作为设计动机记录：

原计划（**未落地**）：新建目录,存放四种典型调用模式的 cookbook:

- `templates/parallel.md` - 独立并行 cookbook
- `templates/debate.md` - 多轮辩论 cookbook
- `templates/chain.md` - 串行接力 cookbook
- `templates/ensemble.md` - 投票综合 cookbook

主会话的 system prompt(`promptSnippet`)说明:"如果你想用某种典型模式,参考 templates/ 下的 cookbook;也可以直接用 dispatch_agent / dispatch_agents 自由组合。"

### ~~multi_dispatch 兼容~~

> **2026-05-11 修订**：`multi_dispatch` 从未作为 registered tool 发出，也没有任何 shipped 的 skill/prompt 依赖它。下述兼容 / deprecation timeline 仅作为设计动机记录。

原计划（**未落地**）：老的 `multi_dispatch(strategy, tasks)` API 不立即移除(保护已存在的 skill/prompt 调用)。
新代码与 sediment 直接用 `dispatch_agent` / `dispatch_agents`。

老接口在 v0.2 阶段标记 deprecated,v1.0 移除。

## 并发性事实(事实层,非决策)

ADR 0009 的核心命题是"multi-agent 是基础能力",前提是**它真并发**(不是 JS 单线程伪并发)。本节是未来调优 / 诊断时的事实参考。

### 证据链(保持在公共 / 本仓边界)

| 层级 | 机制 | 真并发证据 |
|---|---|---|
| dispatch 层 | `Promise.all(tasks.map(runTask))` | N 个 task 同时启动,不串行 await |
| runner 层 | 每个 task 一次独立 SDK LLM call | 单 task 独立 AbortSignal / timeout / model config |
| 运行时层 | Node.js async IO | LLM 调用是 network-bound,不是 CPU-bound 时间片模拟 |
| provider 层 | N 个 provider request | 远端模型各自独立计算,跨 provider 可分摊 rate limit |

**验收标准**:总时长 ≈ max(各 task 时长),不是 sum。长期 ADR 不绑定 `@earendil-works/pi-ai/dist/*` 或具体 provider 内部实现;底层实现变化由 P3/P4 并发性测试捕获。

## 真并发的真实约束

不是"并发=完美"。以下几项是设计时必须意识到的真实限制。

### 1. 共享 event loop(单进程)

pi 主进程是单 Node 进程。N 个 task 共享同一个 event loop。

**影响**:某 task 做大量 CPU-bound 处理(如 vision tool 加载大图、JSON.parse 一个 50MB 响应)会**短暂卡**其他 task 的 microtask 调度。对纯 LLM 调用(小 JSON 解析 + 流式 SSE)影响微乎其微(< 100ms 量级)。

**对 sediment 的意义**:sediment voter 几乎全部时间在等远程 API--真并发。总时长 ≈ max(三个 model 响应时间)。

### 2. SDK in-process call,不是子进程

`runner.ts` 注释明确:
> SDK-only: each task is an in-process completeSimple call

**影响**:N 个并发 task 共享同一个 Node 内存空间。一个 task 里如果 throw 没被 catch,会冒泡到 dispatch 层。runner 已在最外层 try-catch 兑底,异常不会击穿主进程,但**确实没有进程级隔离**。

**对 sediment 的意义**:sediment voter 跑的 prompt 是 pure read,不修改主进程状态,共享内存不是问题。如果未来 voter 能调 `read,edit,write`(狂野场景)才需要警惕。

### 3. provider 端 rate limit(最大实际瓶颈)

- Anthropic Tier 2: 1000 req/min + 200K input tokens/min
- OpenAI Tier 2: 类似量级
- 同一 provider 连续触发 N 个并发请求很可能撞 429

**对 sediment 的意义**:sediment voter 必须**跨 provider 多样化**(gpt-5.5 + claude-opus + deepseek),rate limit 不叠加。ADR 0004 已遵守这点。

### 4. 共享 abort signal

runner.ts 默认让所有并发 task 指向同一个父 AbortSignal(`rctx.signal`)。主会话 ESC 同步取消所有 task。

**对 sediment 的意义**:sediment **不能**共享主会话 signal(alfadb 下一轮按 ESC 不该取消上一轮后台 sediment)。sediment 必须用独立 AbortController,详见 ADR 0004 § 5.4。

## sediment voter 并发表现预估

3 个 voter task 同时跑(不同 provider,high thinking):

| 场景 | 总时长 |
|---|---|
| 串行三模型 high thinking | ~150-450s(不可接受,agent_end 后等不了)|
| **真并行**(v6.5 选型) | **~max(50-150) ≈ 100-150s**(可接受)|
| 5 min hard cap 内 | ✅ 能含 worst case |

实测参考(之前会话收集):
- gpt-5.5 xhigh 长批判 task = 249s
- claude-opus-4-7 xhigh = 130s
- voter prompt 输出 JSON 不是长文,预期比长批判短 30-50%

## 上线前验收(进 P3.x 验收标准)

真并发是 sediment 设计的硬前置依赖。如果 sediment 上线后才发现 voter 实际串行化,那不是"性能问题"而是"sediment 不可用"。

验证代价极低:dispatch.log 已在 task:start 打时间戳,看 3 行 task:start 时间差 < 1s 就行。

详见历史 `archive/migration/steps-v7-roadmap.md` P3 验收标准:
```bash
# P3.x 运行 voter 并发性验证
node extensions/sediment/test/voter-concurrency.ts
# 验收:3 条 task:start 时间戳 max - min < 1000ms
```

该测试文件留在 `extensions/sediment/test/` 永久保留作为回归测试。每次 SDK / multi-agent 升级后跑一次。

## 后果

### 正面
- 主会话调度自由度大幅提升
- sediment 的多模型投票可以更精细控制 quorum、超时、重试
- 现有四种 strategy 仍可参考(cookbook 形式)
- ~~兼容老 `multi_dispatch` 调用,渐进迁移~~（从未落地）

### 负面
- 主会话需要更明确的指导(system prompt 要说明"何时直接 dispatch,何时参考模板")
- ~~`dispatch_agent` 与 `multi_dispatch` 并存期间有 API 表面增加~~（`multi_dispatch` 从未落地，仅 dispatch_agent / dispatch_agents 两个 tool）
- 模板维护成本(4 份 cookbook 需要随主会话理解力提升保持更新)

### 风险
- 主会话误用:本来该用 ensemble 投票的场景,主会话只 dispatch 一个 agent → 缺乏交叉验证
- **缓解**:在 promptSnippet 中给出"什么时候应该至少用 2 个 agent 互相核验"的指导(特别是 sediment 投票场景)

## 引用

- ADR 0001: pi-astack 定位
- ADR 0004: sediment 写入策略(§ 5 运行时纪律依赖本 ADR 的真并发保证)
- ADR 0006: 组件合并清单(pi-multi-agent 迁入 extensions/dispatch/ + vision/imagine 拆为独立扩展，2026-05-11 reconciliation)
- pi-multi-agent 现有 API 表面(`multi_dispatch`, `vision`, `imagine`)
- pi-multi-agent 源码:`runner.ts` (in-process completeSimple)、`strategies/parallel.ts` (Promise.all fanout)
- pi 官方 SDK docs: `docs/sdk.md`
- pi-multi-agent 源码:`runner.ts` / `strategies/parallel.ts`(本仓迁入后以本仓代码为准)
