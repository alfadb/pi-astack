---
doc_type: consensus
status: active
---

# Vision — pi-astack

> 人类拥有。agent 可起草，人类签字。这是项目的"为什么存在 + 要成为什么"，是最慢漂移、最高人类价值的一层。

## 1. 定位

pi-astack 不是"一个记忆插件"，而是 **alfadb 在 pi 里的个人运行环境 substrate + 第二大脑 / Jarvis substrate**（2026-07-08 定位补注理由：已 ship 的通用 pi 运行能力与隐形自治第二大脑需要显式分层）：

- 当前会话专注执行，**不直接维护长期记忆**。
- 长期记忆由 sidecar / 命令 / 用户授权路径沉淀为 **L1 Evidence Event**；L2 Markdown/git 是确定性投影与审计视图，L3 SQLite/embedding/ledger 是可重建派生层。
- `~/.abrain/` 不是 world knowledge dump，而是围绕"这个人"的**数字孪生**：身份、技能、习惯、工作流、项目知识、跨项目知识、秘密。
- LLM 面向的是**稳定 facade**：读记忆用 `memory_*`，多代理用 `dispatch_*`，秘密用授权后的 `vault_release` 或 bash env 注入；物理拓扑可以继续演进。

## 2. 两层结构

pi-astack 有两层：**substrate 层**是个人 pi 运行环境增强，覆盖模型路由、provider 护栏、通用工具、派发底座、工作流和宿主集成；**brain 层**是隐形自治第二大脑，覆盖长期记忆、证据、投影、自治遗忘、决策参与和主动纠错。隐形/自治类不变量只约束 brain 层；substrate 层遵循工程实用主义，只要不把用户重新变成大脑管理员、不绕过授权边界，就可以采用结构化协议、调试命令和 provider 补偿。已 ship 的 `web-search`、Context7、`vision`、`imagine`、goal/workflow、dispatch 等通用能力属于 substrate 层：它们增强 pi 的执行环境，并为 brain 层提供可调用底座，但本身不是第二大脑记忆本体（2026-07-08 定位补注理由：吸收运行实态，避免把所有通用能力误套隐形自治约束）。

## 3. 第二大脑的产品哲学

brain 层通过**观察自然对话**学习和纠错——用户不做任何专门为维护大脑而存在的动作。详见 `direction.md` 的四条不变量（这是把"愿景"钉成"任何实现都不许违反"的约束面）。

## 4. 非目标（明确不做）

- 不做"用户维护大脑"形态：不要求审批/裁决/投票/定期审查/手动同步/批准学习结果。
- 不做"机械门兜底"作为 LLM 行为层主防线（机械只能做 infra / 兜底）。
- `~/.abrain` 不做通用 world knowledge 仓库；它是"关于这个人"的孪生。
- 文档不做代码镜像 / 实现状态快照 / commit 流水（那是代码 + abrain 的域）。

## 5. 当前大方向目标

> 目标 = 愿景的可验证切片。任务级 backlog 在 `roadmap.md`，行为需求在 `requirements.md`。

- 让第二大脑能从自然对话**自动学习 + 自动纠错**，且对用户管理负担隐身（运行状态仍可见）。
- 让记忆**参与任务执行**（不只是被查询），在决策点给情境化建议。
- 维持**人类管方向 / abrain 管细节**的治理切分，并保有方向漂移的返回路径（见 `README.md` §4）。
