---
doc_type: research
status: active
---

# 2026-07-04 Agent Memory and Wiki Memory Survey

> 仅供研究参考。本文记录对 AI Agent memory、LLM Wiki 和 second-brain 演化模式的调研。
> 它是带来源链接的工作资料，不是已批准的 direction、requirements 或 ADR。

## 范围

这份综述合并了以下 11 篇微信文章正文，并结合主会话里交叉核对过的主源 / 项目链接。若需要逐篇展开观点、理论、工具机制和风险，请继续读取配套详细笔记：[2026-07-04-agent-memory-and-wiki-memory-source-notes.md](./2026-07-04-agent-memory-and-wiki-memory-source-notes.md)。

1. [AutoMem](https://mp.weixin.qq.com/s/R2r7Zh_Mt1p_rZUpiqSpSA) | 记忆不是存储而是决策，斯坦福团队推出AutoMem 把人类的记忆观念迁移到 LLM
2. [Ontology / enterprise semantics](https://mp.weixin.qq.com/s/-gYJRXLgl8hFzkHfiMVuGg) | 本体到底构建的是什么？
3. [claude-obsidian / LLM Wiki productization](https://mp.weixin.qq.com/s/hkH8b8b5pxZi-jywlnYSAw) | Karpathy 的 LLM Wiki 终于有人实现了：8,200+ 星，Obsidian 秒变 AI 大脑
4. [Memory OS](https://mp.weixin.qq.com/s/RB_t7vkRiZrrGY-Vvel8Mw) | 1045 Star、7 层记忆 OS：用 Qdrant+SQLite 给 Hermes Agent 装本地长期记忆
5. [Cross-agent memory layer](https://mp.weixin.qq.com/s/9z2NVSurrx44RQDHpbq33A) | 一套记忆系统，横跨所有Agent（Hermes/OpenClaw/Codex/ClaudeCode/etc.）
6. [LLM Wiki x GBrain](https://mp.weixin.qq.com/s/R78sLkL1GUIbCukOxZ6Lkw) | Hermes Agent 记忆增强: LLM Wiki × GBrain
7. [Cognee v1.0](https://mp.weixin.qq.com/s/Pp6dazyxLB1Jj62lcDrCaw) | AI 终于能“记住一切”了！Cognee v1.0 ...
8. [Wiki Memory theory](https://mp.weixin.qq.com/s/bMDh7a7hQ5GeFNBKTEzItw) | Wiki Memory：智能体记忆的新范式
9. [Holographic memory](https://mp.weixin.qq.com/s/xTf6xHS7HSEzBuwmJRPbHw) | Holographic 可能是最适合普通人的 hermes 记忆插件
10. [MemPalace](https://mp.weixin.qq.com/s/mq67_EfpCKU2b03vpIa67g) | 本地优先的AI记忆：逐字存储，召回率96.6%，零API调用
11. [TencentDB Agent Memory](https://mp.weixin.qq.com/s/_bWALRSvQN0Rr1kiRsqoLA) | 腾讯开源 Agent 记忆方案：不堆历史、不暴力摘要、Token 最高省 61%

已核对的主源链接：

- [AutoMem arXiv](https://arxiv.org/abs/2607.01224)
- [AutoMem project](https://autolearnmem.github.io/)
- [LangChain Wiki Memory](https://www.langchain.com/blog/wiki-memory)
- [Karpathy LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)
- [Memory OS](https://github.com/ClaudioDrews/memory-os)
- [MemOS](https://github.com/MemTensor/MemOS)
- [MemOS Cloud OpenClaw plugin](https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin)
- [Cognee announcement](https://www.cognee.ai/blog/cognee-news/cognee-1-0-announcement)
- [Cognee GitHub](https://github.com/topoteretes/cognee)
- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [MemPalace](https://github.com/MemPalace/mempalace)
- [GBrain](https://github.com/garrytan/gbrain)
- [DeepWiki docs](https://docs.devin.ai/work-with-devin/deepwiki)
- [DeepWiki blog](https://cognition.com/blog/deepwiki)
- [AutoWiki](https://factory.ai/news/wiki)
- [Holographic Memory technical deep dive](https://hindsight.vectorize.io/guides/2026/04/21/guide-hermes-agent-holographic-memory-technical-deep-dive)
- [Holographic repo discovered](https://github.com/bysc1000/holographic-memory)

## 总体判断

这些材料的共同方向很清楚：agent memory 正在从“聊天记录 + 向量检索”转向一层独立的基础设施。
记忆不再只是被动存储，而是被描述为一种可治理、可演化、可验证的上下文资产，并且带有生命周期控制。

这个变化不只是技术层面的，也是概念层面的：

- memory 不是单纯扩大 context window
- memory 不是单一向量数据库
- 文件和 wiki 风格工件正在重新成为一等公民的记忆载体
- 原始证据和更高层抽象必须同时保留
- memory 需要 forget、improve、decay、trust scoring 这类生命周期操作
- agent memory 正在变成可共享、可隔离、可审计、可版本化的资产边界

## 各来源定位

### 1. AutoMem

[AutoMem arXiv](https://arxiv.org/abs/2607.01224) / [project](https://autolearnmem.github.io/)

核心想法是 meta-memory：系统不只是存记忆，还学习如何管理记忆。
文章把 memory 解释成一个决策过程，通过结构优化和熟练度训练，让模型学会何时保留、何时检索、何时组织记忆。

这类材料的重要性在于：
- memory policy 可以被训练
- memory 管理属于模型行为的一部分，而不是后置检索插件
- 长期方向不只是更好的存储，而是更强的记忆操作能力

### 2. 企业本体 / 语义治理

本体文章把 memory 描述为语义结构，而不是原始事实堆积。
它最值得注意的地方是 schema 思维：用 7 类语义范畴和 29 种句式模式作为治理层，控制系统能够表达和归一化什么。

这类材料的重要性在于：
- memory 需要 schema，而不只是 embedding
- 企业记忆需要语义治理和类型化投影
- 价值不只在检索更准，还在控制意义漂移

### 3. claude-obsidian / 产品化的 LLM Wiki

[claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) 和 Karpathy 的 LLM Wiki gist 展示了 wiki 形态如何变成可用产品界面。
核心模式是把 Obsidian 式文件变成 AI 可读的知识库，而 wiki 本身变成记忆接口。

这类材料的重要性在于：
- wiki memory 是持久知识最自然的载体形态
- 文件原生工作流降低了人工审阅和编辑成本
- 知识通过页面、反链和结构化笔记来组织，而不是黑箱式记忆块

### 4. Memory OS

[Memory OS](https://github.com/ClaudioDrews/memory-os) 提供了一个基于 Qdrant + SQLite 的七层本地记忆结构。
这里最重要的主张是 ground-truth 分层：不是所有记忆都等价，系统应该区分证据、投影和派生视图。

这类材料的重要性在于：
- 本地优先的 memory 也可以做分层
- 证据层级必须显式存在
- 设计承认高层摘要必须能回溯到原始真相

### 5. 跨 agent 记忆资产化

跨 agent 文章主张让 Hermes、OpenClaw、Codex、ClaudeCode 等 agent 共用一套记忆系统。
这一步的本质是资产化：memory 不再绑定某一个助手，而是绑定更大的项目或用户上下文。

这类材料的重要性在于：
- memory 成为可迁移的基础设施
- 共享 memory 需要 agent_id、user_id、project_id 之类的边界
- 跨 agent 复用只有在隔离和 provenance 明确时才有价值

### 6. LLM Wiki x GBrain

Hermes / LLM Wiki / GBrain 的组合提出三层模型：raw、wiki 和 vector。
这个拆分有价值，因为它避免把所有记忆压成单一存储。

这类材料的重要性在于：
- 原始证据、人工整理 wiki 和向量召回承担的是不同工作
- wiki 适合承载持久概念知识
- vector 只是检索辅助，不是整个记忆系统本身

### 7. Cognee

[Cognee announcement](https://www.cognee.ai/blog/cognee-news/cognee-1-0-announcement) 和 [Cognee GitHub](https://github.com/topoteretes/cognee) 把 memory 描述成一个 API 面，提供 remember / recall / improve / forget 等操作。
关键变化是把生命周期操作做成一等公民。

这类材料的重要性在于：
- memory 不只是检索，也包括整理和修订
- 生命周期动词让 memory 系统更容易测试和治理
- 这个模型更像平台，而不是一次性索引

### 8. Wiki Memory 理论

[LangChain Wiki Memory](https://www.langchain.com/blog/wiki-memory) 以及 Harrison Chase 相关的 wiki memory 表述，定义了一种更接近活知识库而不是转录存储的记忆理论。
它是这份综述里最清楚表达 wiki-memory 路线的材料。

这类材料的重要性在于：
- wiki memory 更适合领域知识和稳定抽象
- 它不能替代短期状态或高频事件
- 这种理论明确要求记忆是可编辑、结构化、可检查的

### 9. Holographic memory

[technical deep dive](https://hindsight.vectorize.io/guides/2026/04/21/guide-hermes-agent-holographic-memory-technical-deep-dive) / [repo](https://github.com/bysc1000/holographic-memory)

Holographic memory 是一种轻量的本地 cold-memory 层。
它值得注意的机制包括 trust scoring、time decay、contradiction detection，以及一种偏向实际本地使用、而不是重基础设施的设计。

这类材料的重要性在于：
- memory 可以很小、很本地，但仍然有用
- trust 和 decay 是 memory 的核心操作
- contradiction 处理应该属于 memory 系统内部，而不只是 prompt 层

### 10. MemPalace

[MemPalace](https://github.com/MemPalace/mempalace) 强调逐字保留原始内容，同时支持语义检索。
它对“过度摘要”形成了一个重要修正：系统保留精确源文本，同时仍然提供更高层访问。

这类材料的重要性在于：
- 原始证据仍然可查询
- 摘要不能抹掉源文本保真度
- raw 与 semantic 并存时，memory 质量更稳定

### 11. TencentDB Agent Memory

[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 描述了一个符号化短期层 + L0-L3 长期金字塔。
它强调不要堆历史，也不要强行做暴力摘要，并给出了显著的 token 节省结果。

这类材料的重要性在于：
- 短期记忆和长期记忆应该结构性分离
- 符号化 memory 可以减少 token 浪费
- memory pyramid 比单体存储更适合作为操作契约

## 统一理论框架

横跨这些材料，最强的共同结论是：

1. Memory 不是上下文窗口扩容。
2. Memory 不是单一向量库。
3. 文件和 wiki 页面仍然是核心记忆载体。
4. 原始证据和高层抽象都必须保留下来。
5. Memory 需要 lifecycle 控制：remember、recall、improve、forget、decay、trust。
6. Memory 应该可验证、可追溯，而不只是可检索。
7. Agent memory 正在往资产模型演进，需要清楚的所有权和隔离。

从实现上看，一个稳健的 memory stack 更像受治理的知识系统，而不是 embedding 的杂物袋。
较稳的分层模式是：
- L1 原始证据
- L2 结构化投影 / wiki 摘要 / 语义视图
- L3 profile、规则、偏好和方向类抽象

这也是为什么多份材料会收敛到 raw/wiki/vector、evidence/projection/derived，或者分层 pyramid 这样的结构。

## 工具路线对比

| 路线 | 代表来源 | 优势 | 局限 | 更适合的场景 |
|---|---|---|---|---|
| 可训练 memory skill | AutoMem | 学的是 memory 操作，而不只是存储 | 更难验证，也更难落地运维 | 长期研究方向 |
| 企业语义建模 | 本体文章 | schema、治理、意义控制 | 容易变重、变脆 | 需要强 taxonomy 的领域 |
| Wiki memory | LangChain Wiki Memory、claude-obsidian、AutoWiki、DeepWiki | 人可读、可编辑、可导航 | 对短期状态和事件洪流较弱 | 领域知识和持久抽象 |
| 本地分层 memory OS | Memory OS | 分层清晰、本地控制、可追溯到 ground truth | 运维复杂度较高 | 单用户或本地 agent 工作流 |
| 跨 agent memory | MemOS、OpenClaw plugin、cross-agent article | 便于多 agent 复用 | 必须有严格身份和作用域隔离 | 共享项目记忆 |
| 原文保留型 memory | MemPalace | 证据保真度高，语义回收强 | 存储和整理成本高 | 审计密集型工作流 |
| 轻量本地事实库 | Holographic | 简单、本地、带 trust/decay 机制 | 适用范围有限 | 个人助手记忆 |
| 图谱式 memory 平台 | Cognee | 生命周期 API 和图式操作完整 | 平台复杂度高 | 产品化 memory 基础设施 |
| 符号化 + 金字塔 memory | TencentDB Agent Memory | token 效率高，语义分层清晰 | 需要精细的分层策略 | 生产级 agent memory |

## 对 pi-astack second-brain 演化的含义

这些材料给 `pi-astack` 的设计提供了几条比较明确的启发：

1. 保持 `docs/` 和 `abrain/` 的边界。研究材料应留在 `docs/research/`，它是参考资料，不是政策。
2. 不要把所有东西都压进向量数据库。原始证据层必须保持独立可访问。
3. 保持 L1 原始证据、L2 结构化投影、L3 profile / rules / direction 分层可追踪。
4. Wiki memory 适合领域知识，但不适合短期状态或快速变化事件。
5. Memory 注入需要明确权限级别。避免 memory-zero，即系统没有原则性地决定什么能进上下文。
6. 跨 agent 共享必须严格隔离 `agent_id` / `user_id` / `project_id`。
7. `forget`、`improve`、`decay` 和 trust scoring 属于生命周期能力，不只是检索技巧。
8. 如果目标是让模型学会记忆操作本身，AutoMem 是一个可继续追踪的长期方向。

## 待解问题

- 哪些材料应继续停留在 research，哪些应升级到 ADR / requirements，哪些应交给 sediment 自动记忆？
- `pi-astack` 是否需要一个人可读的 LLM Wiki 层，还是现有 docs + abrain 的分工已经足够？
- 新的 memory 机制应如何依据生产数据来验收，而不只凭概念吸引力？
- 在任何内容进入持久记忆之前，中文自动抽取质量应如何度量和审计？

## 研究状态说明

本文刻意保持非规范性。
需要逐篇细节、原文主源和机制拆解时，请读取配套详细笔记：[2026-07-04-agent-memory-and-wiki-memory-source-notes.md](./2026-07-04-agent-memory-and-wiki-memory-source-notes.md)。
它的作用是把当前研究面整理出来，方便后续判断某个想法应进入：
- `docs/research/`，作为工作资料
- `docs/requirements.md` 或 `docs/direction.md`，作为已接受的人类侧政策
- 新 ADR，作为决策记录
- 或者记忆底座，作为实现细节

这一级别的归类仍然需要人类复核。
