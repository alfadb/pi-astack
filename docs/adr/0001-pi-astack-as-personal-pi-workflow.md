# ADR 0001 — pi-astack 作为 alfadb 为 pi 打造的个人工作流仓

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的治理纪律（vendor read-only / 单向依赖 / 使用即开发）已上提 `direction.md`，以那里为 canonical。以下机制正文**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

> ⚠️ PARTIALLY HISTORICAL：本文保留项目定位、使用即开发、vendor+端口层和硬纪律；记忆基础设施实现细节以 [../current-state.md](../current-state.md) 与 [README.md](./README.md) 为准。

- **状态**: Accepted。**记忆基础设施部分已过时**——gbrain 唯一存储被 [memory-architecture.md](../memory-architecture.md) 取代（2026-05-07），改为纯 markdown+git 架构。项目定位、vendor+端口层模式、使用即开发工作流、硬纪律均不变。
- **日期**: 2026-05-05
- **决策者**: alfadb（唯一作者）

## 背景

alfadb 在 `~/.pi/` dotfiles 仓下维护 6 块 pi 相关代码，分散在 4 个 git repo + 2 处散文件中：

| 当前位置 | 形态 | 行数级别 | 归属 |
|---|---|---|---|
| `agent/extensions/gbrain/` | 散文件 extension | ~270 行 | alfadb 100% own |
| `agent/extensions/retry-stream-eof.ts` | 散文件功能 | ~130 行 | alfadb 100% own，**自有功能不向上游 PR** |
| `agent/skills/pi-model-curator/` | in-tree | ~350 行 | alfadb 100% own |
| `agent/skills/pi-multi-agent/` | submodule，独立 repo | ~2500 行 | alfadb 100% own（含 `multi_dispatch` + `vision` + `imagine`） |
| `agent/skills/pi-sediment/` | submodule，独立 repo | ~2400 行 | alfadb 100% own |
| `agent/skills/pi-gstack/` | submodule，alfadb fork 自 garrytan/gstack；19 skill 移植 | 19 skill + 1 ext + ship.md | alfadb own port，跟踪 garrytan 上游 |
| `agent/skills/pensieve/` | submodule，kingkongshot/Pensieve `pi` 私有长寿命分支（28 commits）| pi adapter + .src/ 大量改动 | **将退场**（详见 ADR 0005） |

经过三轮 multi-model debate（claude-opus-4-7 + gpt-5.5 + deepseek-v4-pro × 2 轮 × xhigh）+ 双 T0 独立批判验证（gpt-5.5-xhigh + claude-opus-4-7-xhigh，两份独立结论高度收敛），三方一致：

- 当前形态是**用 npm 心智在用 pi**，应回到 pi 哲学的"作者为某个 harness 打造一整套工作流"形态——这与 garrytan/gstack 为 claude-code 打造的个人工作流仓是同一种心智模型。
- 项目本质是 **alfadb 整个记忆/工作流基础设施的重构**，不是简单的代码合并。pensieve 项目作为 pi-astack 组件不存在；记忆基础设施由 gbrain 唯一承载（详见 ADR 0002）。

## 决策

建立 `github.com/alfadb/pi-astack` 单一 monorepo，作为 alfadb 为 pi 打造的个人工作流仓，**以 git submodule 形式挂在 `~/.pi/agent/skills/pi-astack/`**。

### 定位与心智模型

- **不是**：Linux distribution（为不同环境打包同一软件）、npm 包集合（谁都能拿出一个独立消费单位）、为多 harness 抓各种适配的库
- **是**：作者常用 pi 这个 harness，把自己常用的、认同的工作流资源集成在一个仓里。参考 garrytan/gstack —— gstack 作者常用 claude-code，就为 claude-code 打造一套他认同的 review/qa/security/ship 工作流，不断演进。**pi-astack 与 pi 的关系 = gstack 与 claude-code 的关系**。
- **不为**外部 contributor 优化，也不为跨 harness 入口优化

### 仓库结构

仓库结构遵守"vendor + 自有端口层"模式（v6.5 版，无 runtime/pensieve）：

1. **vendor/**（read-only nested submodule，仅作移植参考与未来 diff 源）
   - `vendor/gstack/` → `garrytan/gstack@bf65487`（外部上游，alfadb 是 read-only 消费者）
   - **没有** `vendor/pensieve/`（详见 ADR 0005）

2. **extensions/**（pi 行为扩展，alfadb own）
   - 详见 [docs/directory-layout.md](../directory-layout.md)。

3. **skills/ prompts/**（pi 资源端口层，alfadb own）

4. **defaults/pi-astack.defaults.json**（package-local fallback / 文档示例；运行时配置走官方 pi settings chain）

5. **gbrain 部署是 alfadb 自决**（pi-astack 不代管）；offlineuff08详见 ADR 0007）只要求 alfadb 提供可用的 gbrain 连接

### "使用即开发"工作流（关键约束）

alfadb 是 **pi-astack 的唯一作者，也是唯一使用者**：
- pi-astack **必须**以 git submodule 形式挂在 `~/.pi/agent/skills/pi-astack/`，可随时 `cd` 进入直接编辑
- pi 加载方式是 `settings.json: packages: ["~/.pi/agent/skills/pi-astack"]`（**local path**，不是 `git:` URL）
- `pi install git:github.com/alfadb/pi-astack` 仅作为"假想他人安装"的备用入口
- 所有提交都在 pi-astack submodule 内做，~/.pi 仓只追踪 submodule 指针 SHA

### 记忆基础设施（v6.5 → v6.8 → v7 心智演进）

> **⚠️ 过时信息**：以下段落描述 v6.5-v6.8 的 gbrain 记忆基础设施，已被 [memory-architecture.md](../memory-architecture.md)（2026-05-07）取代。当前架构：markdown+git 唯一 source of truth；项目级走 `<project>/.pensieve/`；世界级走 `~/.abrain/`；sediment 单写；主会话只读（`memory_search/get/list/neighbors`）。详见 memory-architecture.md。

要点（历史记录）：

详见 ADR 0002（gbrain 唯一记忆存储）、ADR 0003（主会话只读）、ADR 0004（sediment 写入策略）、ADR 0005（pensieve 退场）、ADR 0007（offline 降级）、ADR 0008（~/.pi 双重身份路由）、ADR 0009（multi-agent 自由化）。

要点（历史记录，已被 memory-architecture.md 取代）：
- 记忆基础设施 = gbrain（postgres + pgvector）唯一承载；gbrain 部署由 alfadb 自决，pi-astack 不提供安装兜底
- 项目记忆 → gbrain `source: pi-astack`（federated=false）
- 跨项目准则 → gbrain `source: default`（federated=true）
- 主会话只读（`gbrain_search/get/query` 三个 tool），不写记忆
- sediment 是唯一写入者，按"单写 / 分离写 / 派生写"三种合法策略写入
- sediment 沾用 pensieve 4 象限（maxim/decision/knowledge/short-term） + gstack 字段（confidence/source） 双重哲学做出入判断
- multi-agent 作为基础能力裸露 `dispatch_agent`/`dispatch_agents`，主会话自由组合；原 4 strategy 降为 cookbook 模板
- ~/.pi 同时是 pi-astack 开发环境与其他项目的 pi 基础环境，source 路由按 ADR 0008 区分

## 废弃清单

详见 ADR 0006（组件合并）。摘要：

| 实体 | 处置 |
|---|---|
| `alfadb/pi-gstack` repo | archive，整体并入 `pi-astack/skills/` + `pi-astack/extensions/` |
| `alfadb/pi-multi-agent` repo | archive（subtree merge 入 `pi-astack/extensions/multi-agent/`） |
| `alfadb/pi-sediment` repo | archive（subtree merge 入 `pi-astack/extensions/sediment/`） |
| `kingkongshot/Pensieve@feature/auto-sediment-hook` 分支 | 删除（详见 ADR 0005） |
| `kingkongshot/Pensieve@pi` 分支 | 删除（详见 ADR 0005） |
| `~/.pi/agent/extensions/gbrain/` | 移入 `pi-astack/extensions/gbrain/` |
| `~/.pi/agent/extensions/retry-stream-eof.ts` | 移入 `pi-astack/extensions/retry-stream-eof/`（**自有功能，永久 own**） |
| `~/.pi/agent/skills/pi-model-curator/` | 移入 `pi-astack/extensions/model-curator/` |
| `~/.pi/.pensieve/` 数据 | triage + import 到 gbrain `source: pi-astack`，物理目录删除（详见 ADR 0005、ADR 0006） |

## 后果

### 正面
- `~/.pi/agent/settings.json` 从 13 行配置降到 1 行 local path
- 单作者跨"6 块代码"的同步开销基本归零
- 上游升级路径清晰（LLM 阅 diff → 语义判断 → 端口层适配）
- 单一记忆基础设施（gbrain），主会话只读 + sediment 单写，符合 brain maxim "Give Main Agents Read-Only Knowledge Tools; Delegate All Writes to a Sidecar"
- alfadb 改一行立即生效（local submodule + `/reload`）

### 负面
- 单仓体积变大（vendor + 端口层）
- 上游升级需要手工 cherry-pick 而非 merge
- 引入 postgres 依赖（gbrain 后端）；offline 需配齐两件套兜底（markdown export + read fallback；gbrain 部署由 alfadb 自决，详见 ADR 0007）
- ~/.pi 仓需要追踪 pi-astack submodule SHA

## 硬纪律（执行铁律）

### 1. vendor/ 严格只读
- **任何**对 vendor/ 内文件的修改都必须迁移到端口层
- vendor/ 只为两件事服务：(a) 移植参考源 (b) 升级 diff 源
- 端口层永远不能 `import` 或 `source` `vendor/*/...` 路径

### 2. 单向依赖
```
extensions/ → 调用 → skills/ + prompts/
extensions/ → 不依赖 → vendor/
skills/ prompts/ → 不依赖 → 任何代码
```

### 3. UPSTREAM.md 必须实时维护
- vendor SHA 升级必须同时更新 UPSTREAM.md
- 每条端口层资源（如果来自 vendor）必须能从 UPSTREAM.md 找到上游来源行
- "自有功能"（retry-stream-eof / memory architecture / 等）**不进** UPSTREAM.md（详见 UPSTREAM.md 三分类）

### 4. vendor bump 独立 commit
- `chore(vendor): bump gstack to <sha>` 不夹其他改动
- 紧跟着的 commit 是端口层的适配（如有需要）
- 这一对 commit 永远成对出现

### 5. 第一阶段不抽 shared/ 包
- 哪怕 vision-core / imagine-core / gbrain-cli / agent-loop 看起来重复
- 等 rule of three（≥3 个真实消费者）自然浮现
- 这条来自 claude-opus 在 debate 中的强意见

### 6. 棘轮规则（rule-of-three 的具体化）
- 同一 utility 出现第 2 个 caller → 提取到 internal 共享位置
- 同一 vendor 文件被改动第 2 次 → 升格为正式 patch 文件
- gbrain ad-hoc retry 出现第 2 种 pattern → 收进 gbrain 的统一 client

### 7. 沉淀基础设施
- pi-astack 仓内**不创建** `.pensieve/` 目录（pensieve 项目已退场）
- 所有沉淀走 gbrain，由 sediment 写入
- ~/.pi/.gbrain-cache/（markdown 快照兜底）在 ~/.pi/.gitignore 中（详见 ADR 0007）

## 不在本 ADR 决策的事（YAGNI）

- 是否在 npm registry 发布 pi-astack
- 是否抽 `packages/` 共享原语
- 是否做 affected-only CI
- 是否抽 lint / shellcheck CI

这些等真实需求出现再决策。

### 已明确否定的事

- **不通过 `npm run` 脚本机械化 vendor bump 与 diff 判断**：上游变更的语义判断必须经过 LLM 阅读 diff + alfadb 讨论。详见 UPSTREAM.md 的「上游升级工作流」章节。
- **不引入 memory_intent 主会话写入通道**（v6 版曾提议，v6.5 删除）：sediment 从 agent_end 完整上下文识别用户写入意图已足够，加 intent tool 反而增加双路径融合复杂度。

## 引用

- brain maxim: `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`（2026-05-05 沉淀）
- brain maxim: `give-main-agents-read-only-knowledge-tools-delegate-all-writes-to-a-sidecar`（v6.5 设计依据）
- pi 官方文档: `packages.md`、`extensions.md`、`skills.md`
- 三轮 debate 结论: 三模型一致同意"作者为某个 harness 打造一整套工作流仓"形态
- 双 T0 批判结论: gpt-5.5-xhigh 与 claude-opus-4-7-xhigh 独立批判 v6 高度收敛 → v6.5 修订版
- 后续 ADR: 0002-0009（v6.5/v6.5.1 体系 9 条 ADR）
