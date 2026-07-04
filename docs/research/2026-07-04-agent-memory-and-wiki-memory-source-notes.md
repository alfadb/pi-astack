---
doc_type: research
status: active
---

# 2026-07-04 Agent Memory and Wiki Memory Source Notes

> 仅供研究参考。本文是对 11 篇来源文章的逐篇笔记，用来补足综述中的压缩表达，方便后续会话按篇回查观点、理论和机制。

## 1. AutoMem

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/R2r7Zh_Mt1p_rZUpiqSpSA>
- 主源：<https://arxiv.org/abs/2607.01224>
- 项目页：<https://autolearnmem.github.io/>

### 核心观点
AutoMem 的核心不是“给模型多存一些东西”，而是把记忆本身定义成一种决策过程。文章强调记忆管理应回答三个问题：什么要写入、什么时候取回、如何组织。它借用认知科学里的 metamemory 视角，把记忆操作从被动存储提升为可学习、可优化的行为。

### 理论模型
这篇文章把 memory 能力拆成两条轴线：一条是 structure scaffolding，即通过 prompts、文件 schema、action vocabulary 给模型提供可操作的结构；另一条是 proficiency training，即通过训练让模型本身逐渐学会更成熟的记忆操作。文章还引入 meta-LLM 审查长轨迹来优化结构，以及另一个闭环从“好记忆动作”中筛数据训练 memory expert。

### 工具 / 机制
文中机制包括 LOG/PLAN 风格的记忆动作轨迹、文件系统作为 memory 的承载层、外循环结构优化、以及 memory expert 的 LoRA / 微调路线。实验环境主要放在 Crafter、MiniHack、NetHack 这类游戏任务上，用来观察记忆操作如何影响长期代理行为。

### 对 pi-astack 第二大脑的启发
对 pi-astack 来说，这篇文章最值得长期追踪的点是“记忆操作可以成为可学习技能”。但在当前阶段，更稳妥的做法仍然是先把结构、证据链和可追溯性治理好，再谈训练式 memory policy。它提醒我们不要把记忆只理解成索引，而要把写入、检索、组织都当成明确动作。

### 风险 / 待验证点
它的验证重心在游戏环境，离真实工程工作流还有迁移距离。训练出来的 memory policy 是否能稳定泛化到文档、研究和跨会话协作，需要额外验证。

### 可复用关键词
metamemory，memory action，what to encode，when to retrieve，how to organize，structure scaffolding，proficiency training，file system memory，LOG/PLAN，memory expert。

## 2. 本体构建

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/-gYJRXLgl8hFzkHfiMVuGg>

### 核心观点
这篇材料的重点不是抽象哲学，而是把本体当作企业语义层来用。它要解决的是业务世界如何被稳定地拆成对象、关系、约束、术语、规则、流程、权限和 CRUD 这些可治理的表达单位。

### 理论模型
文章背后的理论前提是 schema / ontology 可以作为控制意义漂移的语言层。换句话说，系统不是先有一堆事实再临时解释，而是先定义语义结构，后续输入和输出都要在这个结构里被归一化和约束。

### 工具 / 机制
材料提到 7 类语义和 29 句式，用来表达业务对象描述、分层约束、术语统一、控制规则、流程操作、权限和 CRUD 查询。它的重点是把语义治理变成可操作的模板，而不是只停留在概念图上。

### 对 pi-astack 第二大脑的启发
pi-astack 的 L1 / L2 / L3 投影如果要稳定，就不能只记录文本片段，还要知道对象类型、关系类型和约束类型。尤其是后续要做 profile、规则和偏好层时，typed schema 会比纯文本摘要更可靠。

### 风险 / 待验证点
本体方法容易变重，尤其在早期会诱发“先设计完语义宇宙再开始记录”的偏差。对 pi-astack 来说，它更适合作为语义治理工具，而不是压过证据链和实际工作流的先验框架。

### 可复用关键词
ontology，schema，semantic governance，enterprise semantics，typed relation，constraint layer，terminology normalization，workflow semantics，permission semantics。

## 3. claude-obsidian / LLM Wiki

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/hkH8b8b5pxZi-jywlnYSAw>
- 主源：<https://github.com/AgriciDaniel/claude-obsidian>
- 参考原型：<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>

### 核心观点
这组材料的核心是把 Obsidian 变成一个会自组织的 AI 第二大脑。LLM 读取原始笔记，提取实体、概念和关系，再生成交叉引用的 Markdown wiki，让知识在页面之间持续编织。

### 理论模型
它延续的是 Karpathy 提出的 LLM Wiki pattern：把知识编译一次，之后长期复利。这里的关键不是“问答接口”，而是让知识以可链接、可导航、可重排的方式落在文件系统里，形成持续生长的知识图谱。

### 工具 / 机制
项目公开了 15 个 skills，覆盖 ingest、query、lint、autoresearch 等流程，并支持 LYT、PARA、Zettelkasten 和 Generic 等组织方式。检索层采用 BM25、context prefix 和 cosine rerank，写入侧还强调多写锁，避免并发写破坏知识结构。

### 对 pi-astack 第二大脑的启发
pi-astack 如果要有一个人类可读的 wiki 层，这类方案很有参考价值。它说明文件系统可以同时承担人读和机读职责，但前提是要和 abrain 的自动记忆边界分清：research / wiki / 自动记忆不能混成一团。

### 风险 / 待验证点
很多工具细节来自项目自己的说明，真实质量最终取决于写入纪律、去重策略和冲突处理。若没有稳定的规范，wiki 很容易从知识层退化为“自动生成的杂页集合”。

### 可复用关键词
LLM Wiki，Obsidian，cross-reference，ingest，query，lint，autoresearch，BM25，rerank，multi-writer lock。

## 4. Memory OS

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/RB_t7vkRiZrrGY-Vvel8Mw>
- 主源：<https://github.com/ClaudioDrews/memory-os>

### 核心观点
Memory OS 的主张是：长期记忆不是聊天搜索，而是一套本地 memory infrastructure。它尤其强调不同记忆类型不能混放，ground truth、派生事实、会话材料和创造性内容应该分层存放。

### 理论模型
这套系统给出的是 7 层记忆 OS 的思路，并通过 Ground Truth hierarchy 明确告诉 agent 哪些记忆更权威、哪些只是投影。它的理论重点是“权威性分层”，而不是简单追求召回率。

### 工具 / 机制
实现上用 Workspace MEMORY / USER / CREATIVE 做分区，配合 SQLite + FTS5 存 sessions，structured facts trust scoring 管理事实可信度，再结合 Fabric recall、Qdrant hybrid search、LLM Wiki 和 SOUL / rulebook 形成完整栈。

### 对 pi-astack 第二大脑的启发
pi-astack 当前的 L1 evidence、L2 projection、L3 partial profile 方向和这类分层是同构的。它额外提醒我们：注入上下文时必须明确权威等级，否则系统会把派生内容当成事实，污染后续判断。

### 风险 / 待验证点
这类系统通常运维复杂，并依赖特定 agent 运行时。最重要的风险是 ground truth 层一旦写错，后续所有派生层都会被放大错误。

### 可复用关键词
memory infrastructure，ground truth hierarchy，trust scoring，hybrid search，FTS5，workspace partition，structured facts，LLM Wiki，rulebook。

## 5. MemOS CLI 跨 Agent

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/9z2NVSurrx44RQDHpbq33A>
- 主源：<https://github.com/MemTensor/MemOS>
- 云插件：<https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin>

### 核心观点
这篇材料把 agent 记忆视为资产，而不是某个聊天客户端的临时缓存。它强调记忆应可备份、可迁移、可跨机器复用，也可跨 Agent 共享。

### 理论模型
它的关键思想是把 memory 从 agent 客户端中抽出来，变成共享基础设施；CLI 只是人、脚本和 agent 都能调用的共同接口。这样 memory 才能从“某个工具的附属物”变成“可治理的资源层”。

### 工具 / 机制
核心接口是 `memos add/search/chat/init`，并支持 Hermes、Codex、Cursor、Claude、OpenClaw 等调用场景。系统通过 `agent_id`、`user_id` 做隔离，云端 API key 则承担远程能力接入。

### 对 pi-astack 第二大脑的启发
pi-astack 如果要跨会话、跨工具共享记忆，就必须把 project / user / agent 边界说清楚。这里最值得借鉴的不是“能共享”，而是“共享时 provenance 和作用域必须保留”。

### 风险 / 待验证点
云依赖和权限隔离是主要风险。另一个问题是：如果 `agent_id` 不是命令级的一等概念，而只是 prompt 约定，系统很容易退化成靠人为纪律维持的脆弱约束。

### 可复用关键词
memory as asset，cross-agent memory，CLI interface，agent_id，user_id，provenance，shared infrastructure，portable memory。

## 6. LLM Wiki × GBrain

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/R78sLkL1GUIbCukOxZ6Lkw>
- 主源：<https://github.com/garrytan/gbrain>

### 核心观点
这篇材料把 raw 原始材料、LLM Wiki 结构化知识和 GBrain 向量搜索明确拆成三层。它的基本判断是：不同层做不同事，向量检索只是定位层，不是知识本身。

### 理论模型
Wiki 在这里被视为预编译知识层，raw 则是不可变的原始材料。向量检索负责把用户引回相关区域，但真正的知识表达仍然要落在可读、可编辑、可比较的 wiki 结构上。

### 工具 / 机制
工作流里，Agent 会把 raw 文章消化成 entities、concepts、comparisons 和 queries；GBrain 负责定时 sync / embed，使用 DashScope embedding，并且受 batch-size 约束。

### 对 pi-astack 第二大脑的启发
pi-astack 的 research 笔记可以视作 raw / human-readable source 的一部分。如果未来要做 wiki 层，需要避免让 vector 成为唯一真相，否则检索会变成“看起来相关，但无法复查”的黑箱。

### 风险 / 待验证点
Agent 消化会消耗 token，GBrain 也依赖 embedding provider。raw 与 wiki 的同步策略若没有定义清楚，很容易出现版本漂移或重复编译。

### 可复用关键词
raw source，wiki layer，vector layer，entities，concepts，comparisons，sync，embed，precompiled knowledge。

## 7. Cognee

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/Pp6dazyxLB1Jj62lcDrCaw>
- 主源：<https://www.cognee.ai/blog/cognee-news/cognee-1-0-announcement>
- GitHub：<https://github.com/topoteretes/cognee>

### 核心观点
Cognee 的核心论点是：记忆层是 agent stack 缺失的基础设施，API 原语应该包含 remember、recall、improve、forget。它把 memory 从纯查询系统推进到可持续改进的生命周期系统。

### 理论模型
它采用 graph-native memory 思路，认为前置摄入和结构化整理会换来后续更低边际成本的召回。更重要的是，它承认记忆不是静态的，应该允许根据反馈持续改进。

### 工具 / 机制
实现上结合知识图谱、Postgres / pgvector、Rust core、TypeScript SDK，以及 COGX export。材料还提到 BEAM benchmark 和 token cost break-even，用来说明前期处理成本与后续收益之间的平衡。

### 对 pi-astack 第二大脑的启发
pi-astack 不应只优化 recall，还要把 improve、forget、decay 和 trust 当成生命周期能力来设计。这样第二大脑才不是越积越乱的档案柜，而是会随着使用逐步变好的系统。

### 风险 / 待验证点
宣传中的大数字需要按基准条件理解，尤其是“100B token”这类说法并不等于上下文窗口。break-even 也依赖查询重复度，不能直接外推到所有工作负载。

### 可复用关键词
remember，recall，improve，forget，graph-native memory，knowledge graph，break-even，lifecycle API，token economics。

## 8. Wiki Memory 理论

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/bMDh7a7hQ5GeFNBKTEzItw>
- 主源：<https://www.langchain.com/blog/wiki-memory>

### 核心观点
Wiki memory 被定义成一种 emerging pattern：让 agent 把 raw source data 变成 compact、persistent、agent-readable 的知识层。它不是简单存档，而是提前做高层综合。

### 理论模型
理论上，它和 RAG 的分工很清楚：RAG 查询时检索 raw chunks，而 wiki memory 预先计算出更高层的知识结构，避免每次都重新发现组织方式。它强调知识层本身就是一种缓存。

### 工具 / 机制
材料提到 DeepWiki、Karpathy LLM Wiki、AutoWiki 等例子，并把文件系统视为 inspectable、editable、versionable 的底座。也就是说，wiki memory 的容器仍然应该是普通文件，而不是黑盒数据库。

### 对 pi-astack 第二大脑的启发
pi-astack 的 research 或文档层可以成为人类可读知识层的一部分，但 wiki memory 不能被误解为全部记忆。它更适合领域知识与稳定抽象，不适合短期会话状态或高频事件日志。

### 风险 / 待验证点
这类结构一旦被过度套用到短期记忆，很容易丢失状态细节。它适合“知识”，不适合“正在发生的对话现场”。

### 可复用关键词
wiki memory，compact knowledge，persistent knowledge，raw chunks，agent-readable，inspectable，editable，versionable substrate。

## 9. Holographic

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/xTf6xHS7HSEzBuwmJRPbHw>
- 技术深挖：<https://hindsight.vectorize.io/guides/2026/04/21/guide-hermes-agent-holographic-memory-technical-deep-dive>
- 仓库：<https://github.com/bysc1000/holographic-memory>

### 核心观点
Holographic memory 的主张很直接：普通用户更需要本地、低成本、召回快的 cold memory，而不是复杂昂贵的异步总结系统。它偏向一个轻量但可持续的事实库，而不是大型基础设施。

### 理论模型
它把热记忆 memory.md 和冷记忆插件分工，再用 trust scoring、decay 和 contradiction 管理事实库。理论上，这是一种以“事实可信度”和“时间衰减”为中心的记忆治理模型。

### 工具 / 机制
机制包括 `on_memory_write` 镜像、`fact_store` 主动写入、`auto_extract` 会话结束抽取，以及 SQLite / FTS5 / Jaccard / HRR 组合。它还把 trust_score 和 half-life decay 当作核心状态，而不是后处理装饰。

### 对 pi-astack 第二大脑的启发
pi-astack 可以借鉴 trust / decay / contradiction 作为生命周期信号，而不是只做静态索引。尤其是在中文工作流里，系统需要比“自动摘要”更谨慎地处理抽取质量。

### 风险 / 待验证点
auto_extract 对中文不友好，regex 或摘要误抽可能污染事实库。这个风险很现实，说明轻量不等于无校验。

### 可复用关键词
cold memory，fact store，trust score，decay，contradiction，FTS5，Jaccard，HRR，auto_extract。

## 10. MemPalace

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/mq67_EfpCKU2b03vpIa67g>
- 主源：<https://github.com/MemPalace/mempalace>

### 核心观点
MemPalace 强调不要总是摘要和改写，原始会话逐字保存本身就是重要能力。它的思路是先把证据保真保住，再通过语义搜索把相关内容找回来。

### 理论模型
这里的理论重心是“证据保真优先”，结构化索引只是控制检索范围的手段。也就是说，系统不应为了压缩而牺牲原文可核查性。

### 工具 / 机制
项目按 wings / rooms / drawers 组织内容，默认使用 ChromaDB，也支持 sqlite_exact、qdrant、pgvector 等后端。它还提供 MCP 工具、Claude Code hooks 和时间维度知识图谱，强调原文、索引和使用入口同时存在。

### 对 pi-astack 第二大脑的启发
pi-astack 的 L1 evidence 应尽量保持原始性，不能太早被摘要吞没。hooks、保留策略和可回溯结构都很关键，因为这决定了研究过程能不能重建。

### 风险 / 待验证点
逐字保存带来隐私和存储成本；语义召回也不等于知识整理。系统如果只解决“找回”，不解决“组织”，就会堆出一个更大的原文仓库。

### 可复用关键词
verbatim storage，evidence fidelity，semantic search，MCP hooks，retention，time graph，raw transcript。

## 11. TencentDB Agent Memory

### 原文与主源
- 微信原文：<https://mp.weixin.qq.com/s/_bWALRSvQN0Rr1kiRsqoLA>
- 主源：<https://github.com/TencentCloud/TencentDB-Agent-Memory>

### 核心观点
这篇材料的主张是：不要堆历史，也不要暴力摘要；短期记忆应该符号化卸载，长期记忆应该做成分层语义金字塔。它追求的是白盒、可调试、可追溯的记忆系统。

### 理论模型
它把记忆拆成 symbolic short-term memory 和 layered long-term memory 两部分，并用 L0 Conversation -> L1 Atom -> L2 Scenario -> L3 Persona 的方式表达层级。理论上，这是一个以可追溯粒度递进为核心的金字塔模型。

### 工具 / 机制
实现上有 Mermaid 任务地图、`refs/*.md` 原始日志、`node_id` 回溯链，以及 SQLite + sqlite-vec 的本地存储。它还支持 OpenClaw / Hermes 插件，说明该模型面向的是可嵌入的 agent 工具链。

### 对 pi-astack 第二大脑的启发
pi-astack 的 evidence / projection / profile 分层应保留 `node_id`、`source_ref` 这类可追踪链路。这样后续不只是知道“结论是什么”，还能回到“从哪段证据来”。

### 风险 / 待验证点
项目仍处于较早阶段，自测数据需要生产验证。另一个现实问题是 embedding / model 服务会影响“完全本地”的承诺，部署边界需要看清。

### 可复用关键词
symbolic short-term memory，layered long-term memory，semantic pyramid，node_id，source_ref，sqlite-vec，traceability，white-box memory。

## 交叉结论

这些 source notes 和综述一起看，能更清楚地说明当前研究的收敛点：记忆正在从“检索插件”变成“可治理的上下文基础设施”，并且逐步分化出 evidence、projection、wiki、profile、lifecycle 和 cross-agent sharing 这些独立责任。

对 pi-astack 来说，最重要的不是马上选定某一家实现，而是把可追溯、可分层、可回查、可演进这几件事先写清楚。具体是否进入产品化、规则化或自动记忆实现，仍然要再根据后续研究和人类判断决定。
