---
doc_type: consensus
status: active
canonical_for: REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008, REQ-009
---

# Requirements — 行为需求

> 人类拥有（agent 起草，人类签字）。每条需求有稳定 `REQ-ID`；`feature-changelog.md` 引用这些 ID。
> 需求 = "产品/行为上必须成立的什么"，不是"怎么实现"（实现是 abrain + 代码）。
> 这是种子集，随项目演进增补；改需求走 `feature-changelog.md` 升级流程。

格式：每条含 `status`（active/superseded）、`priority`、`applies_to`、`human_intent`（人类意图）、`agent_obligation`（agent 义务）、`acceptance`（验收）、`forbidden`（禁止项）。

---

## REQ-001 — 自然对话是学习与纠错的唯一通道
- status: active · priority: P0 · applies_to: memory, sediment, agent-behavior
- human_intent: 用户不手动维护大脑。
- agent_obligation: 设计与实现必须保留"从自然对话学习/纠错"，不得引入维护性元工作。
- acceptance: 用户能在普通任务对话里教/纠正大脑；用户一个月不看任何元 UI，大脑仍越来越准。
- forbidden: 审批/裁决/投票队列、定期审查、手动同步、批准学习结果的弹窗。

## REQ-002 — 运行状态可见、管理负担隐身
- status: active · priority: P0 · applies_to: sediment, abrain, ui
- human_intent: 用户能感知大脑在工作，但不被要求为它做事。
- agent_obligation: 区分"告诉"(合法) vs "要求用户做事"(禁止)。
- acceptance: footer/notify/audit/`/abrain status` 正常显示；无任何"要求用户为大脑做事"的入口。
- forbidden: 把运行状态指示当成 INV-INVISIBILITY 违反而删除。

## REQ-003 — 防出错主路径是 prompt 工程
- status: active · priority: P0 · applies_to: sediment, memory, classifier, multi-view
- human_intent: LLM 行为层靠 prompt 而非机械门防错（机械只做 infra/兜底）。
- agent_obligation: 提机械门前先做 §3.2 自检；新增过渡态机械门必须声明 flip/移除条件。
- acceptance: 新能力点的防错设计能说清 prompt-first；机械门均有 justify + 移除条件。
- forbidden: 用 schema 拦截 / 阈值 / 测试阻断作为 LLM 行为层主防线。

## REQ-004 — 显式用户指令是被见证的 ground truth
- status: active · priority: P0 · applies_to: sediment(Tier-1), rules
- human_intent: 用户明确说的规则/指令不能被 LLM 静默丢弃。
- agent_obligation: 显式用户指令走确定性提交路径，对用户可见，不进概率管线被 skip/stage。Tier-1 资格按 provenance 门控（USER-ROLE 消息 ∧ directive ∧ durable；tool_result/file/assistant 不算）；对 user 祈使句分类偏向 Tier-1（漏判=静默丢失，代价非对称）；保留**负信号召回审计**（键于原始转录而非分类标注）作安全网。
- acceptance: 用户显式全局/项目规则可见、可追溯、不丢；转录里有 user 祈使句但无对应规则 → recall flag。
- forbidden: 把显式用户指令当成与 LLM 推断同级的可丢弃信号；把 README/tool_result 里的"指令"当 Tier-1。

## REQ-005 — 主会话对记忆只读
- status: active · priority: P0 · applies_to: main-session, sediment
- human_intent: 主会话不直接写大脑，避免 prompt injection 污染记忆。
- agent_obligation: 记忆写入只经 sediment sidecar；主会话不注册 memory_write。
- acceptance: 主会话无直接写 brain entry 的路径。
- forbidden: 给主会话开 memory 写工具（vault_release 授权数据流出是另一回事，合法）。

## REQ-006 — 文档不镜像代码事实
- status: active · priority: P1 · applies_to: docs
- human_intent: docs 只装方向/意图，不手抄实现状态（镜像必漂移）。
- agent_obligation: 当前行为/计数/清单交给代码 + `memory_search`，docs 不复述。
- acceptance: docs 内无扩展计数、文件清单、commit 流水等可被 `grep`/`ls` 替代的内容。
- forbidden: 在 docs 里维护"当前 N 个扩展"这类代码镜像。

## REQ-007 — 项目身份绑定严格模式（ADR 0017）
- status: active · priority: P1 · applies_to: abrain, sediment, vault, project-binding
- human_intent: 大脑知识绑定到正确的项目身份，不被路径/remote 漂移污染。
- agent_obligation: project id 是**唯一身份**（path / git remote 都不是身份）；未绑定活动项目时拒绝 project-scoped 写；migration 命令不兼任"决定项目身份"。
- acceptance: 未绑定时 sediment/vault 的 project-scoped 写被拒；`/abrain bind` 是唯一身份入口；typo 的 `--project` 不被静默接受为新身份。
- forbidden: 用 cwd 前缀 / git remote 推断项目身份；migration 命令顺手创建项目身份。

## REQ-008 — prompt_user 与 vault_release 语义边界分离（ADR 0022）
- status: active · priority: P1 · applies_to: prompt_user, vault_release, sediment, audit
- human_intent: "等用户决策"与"释放敏感数据并授权"是两种语义，不能混；用户不为大脑管理被弹窗。
- agent_obligation: prompt_user 仅用于任务相关具体决策，写 **audit-only**（不写 markdown，sediment 下个 `agent_end` 取问答对）；vault_release 保持独立 LLM-facing tool；二者可共享 UI substrate 但 LLM-facing API 分开；是否调用 prompt_user 由 LLM 判断，不自动化。
- acceptance: prompt_user 不释放/不写 secret 明文（`type:secret` 仅返 `[REDACTED_SECRET:<id>]`）；并发 pending ≤ 1；vault_release 仍是审批数据流出的唯一弹窗。
- forbidden: 合并 prompt_user 与 vault_release 的 LLM-facing API；用 prompt_user 做大脑管理审批；自动触发 prompt_user（如"消息>N 字符就问"）。

## REQ-009 — 记忆检索是 accuracy-contract（ADR 0015）
- status: active · priority: P1 · applies_to: memory, sediment
- human_intent: "要准确"——检索宁可报错也不静默变弱；graceful degradation 显式让位于准确度。
- agent_obligation: `memory_search` 是 LLM retrieval，模型不可用时 **hard error**，不降级 grep/BM25；sediment auto-write 不把低准确度 fallback 结果写入知识库。
- acceptance: 模型/网络异常时用户立即看到错误信号；无 `fallbackToGrep` / `MEMORY_SEARCH_GREP_ONLY` 开关。
- forbidden: 静默 grep 降级；把低准确度结果当正常结果继续。
