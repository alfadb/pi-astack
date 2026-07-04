---
doc_type: research-index
status: active
---

# research

`docs/research/` 是一个面向人的研究资料架子，用来放按路径组织的参考材料。
这里收集的是笔记、综述、来源链接、对比和工作性假设，供后续判断是否值得进入正式文档使用。

## 边界

- research 不是 direction。
- research 不是 requirements。
- research 不是 ADR。
- research 可以影响这些产物，但不能替代它们。
- 任何从 research 升级到 direction、requirements 或 ADR 的内容，都需要明确的人类批准。

## 命名

建议使用日期前缀，保持可排序、易扫描：

- `YYYY-MM-DD-topic.md` 作为日期报告
- `YYYY-MM-DD-topic-notes.md` 作为辅助笔记
- 名称尽量小写、连字符分隔、ASCII-only

## 后续会话加载建议

如果用户要求继续研究 `pi-astack` 第二大脑演进，建议按这个顺序读取：

1. 先读本 README，确认 research 的边界、索引和文件位置。
2. 再读综述文件，先拿到整体判断、来源范围和主要分层结论。
3. 需要逐篇细节时，再按需读取 source-notes，回查每篇文章的观点、理论和机制。

## 索引

| 文件 | 状态 | 说明 |
|---|---|---|
| [2026-07-04-agent-memory-and-wiki-memory-survey.md](./2026-07-04-agent-memory-and-wiki-memory-survey.md) | active | 关于 AI Agent memory、LLM Wiki 和 second-brain 演化路径的研究综述，包含来源链接与后续研究用的综合判断。 |
| [2026-07-04-agent-memory-and-wiki-memory-source-notes.md](./2026-07-04-agent-memory-and-wiki-memory-source-notes.md) | active | 11 篇文章的逐篇详细笔记，按固定结构整理观点、理论、机制、启发和风险。 |

## 维护

- 优先保留简短、带来源链接的总结，避免没有依据的长篇发挥。
- 需要回查的判断点，尽量把规范 URL 写在结论旁边。
- 所有推测性综合都要明确标记为 research，不要写成已接受政策。
- 如果 research 笔记开始影响产品方向，应在评审后把决定性内容迁移到 `docs/direction.md`、`docs/requirements.md`，或新建 ADR。
