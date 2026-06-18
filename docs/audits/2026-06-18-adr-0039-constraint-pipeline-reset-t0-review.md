# ADR 0039 Constraint Pipeline Reset — 4×T0 多轮审查记录

## 结论

ADR 0039 于 2026-06-18 经 4×T0 多轮讨论与草稿复审后接受。主会话只负责组织审查与记录结果，不裁决架构方案。

## 设计讨论收敛

第一轮独立方案提出四类方向：全上下文 Reconciler、语义对象模型与可逆 diff、约束分类与自然归宿、Constraint/Knowledge/Settings 分层。四方共同确认当前规则路径的问题不是单个 classifier 或 writer 缺陷，而是把约束、知识、配置、工具契约混入同一实时写入路径。

第二轮交叉讨论排除三个方向：纯写时 Reconciler 仍保留 active mutation 的竞态与顺序问题；纯 session_start 动态裁决会引入启动延迟与注入抖动；完整全域 event sourcing 对当前规模过重。共同收敛到 append-only Constraint Draft/Event、后台 compiler、稳定 Compiled Constraint View。

第三轮候选方案签署检查中，Opus、GPT-5.5、DeepSeek、Kimi-k2.6 全部 SIGN，无架构 blocker。四方一致认为该方案在“更少补丁面 + 可落地 + 符合硬约束”三者综合上优于已讨论替代方案。

## ADR 草稿 R1 审查

R1 对 `docs/adr/0039-constraint-pipeline-reset.md` 草稿进行逐文审查。

- Opus: BLOCK。阻断项为 §6 将 git revert 表述为确定性恢复路径，与 ADR 0031 的“运行时恢复不依赖人类手动编辑或 git revert”冲突。
- GPT-5.5: SIGN。提出非阻断建议：强化 memory rule 镜像措辞、git revert 与 ADR 0031 对齐、Draft/Event 非 staging。
- DeepSeek: SIGN。提出非阻断建议：compiler 活性机制、cold-start 边界、settings/tool 诊断闭环。
- Kimi-k2.6: BLOCK。阻断项为 §6 git revert 恢复路径与 ADR 0031 冲突，以及 §11 迁移 phase 流水侵入 ADR 正文。

R1 后主会话仅执行文本修订：将 git revert 退回离线灾备与审计基座，不作为自治运行时恢复面；将迁移 phase 表移至 `docs/roadmap.md#constraint-pipeline-reset-migration`，ADR 正文只保留迁移边界。

## ADR 草稿 R2 复审

R2 对修订后的 ADR 与 roadmap 锚点复审。

- Opus: SIGN。确认两个 R1 blocker 均已消除；ADR 0024/0028/0031 关系准确；无段内硬换行；未把主会话或人类放回裁决位置；旧写时裁决补丁面未残留。
- GPT-5.5: SIGN。确认 R1 blocker 已消除；建议实施时为旧写时 adjudicator freeze 增加显式 guard/audit。
- DeepSeek: SIGN。确认 §6/§8 与 ADR 0031 对齐，§11 不再承载 phase 流水；建议在 roadmap 中量化 compiler 活性、compiled view 稳定性与 compiler 输出质量观测。
- Kimi-k2.6: SIGN。确认两个 blocker 消除；建议后续补充 compiler 活性 SLO、ADR 0031 术语映射、audit 路径指引。

R2 结果为 4/4 SIGN，无架构 blocker。因此 ADR 0039 状态改为 accepted。

## 保留的非阻断实现事项

- compiler 需要活性保证，例如 drain-loop 或 session_start stale 检测后的异步触发，并在 roadmap 或实现计划中量化。
- compiled view 应记录来源 draft/event hash、compiler 版本、输入输出 view hash，避免无解释漂移。
- 运行时恢复面是上一份稳定 compiled view 与 append-only draft/event；git 仅作为离线灾备和审计基座。
- 冲突策略需要显式化，默认不销毁原始证据。
- Knowledge 域与 Constraint 域边界应在实现前明确，避免在 router/compiler 处再生局部特殊逻辑。

## 是否还有更好的方案

R2 四个 T0 均回答没有。理由一致：当前方案移除旧实时写时裁决的主要补丁面，复用现有 markdown/git 基座，保持主会话只读、用户不审批、scope 保守、四域隔离与可逆自治边界；已讨论替代方案至少在补丁面、延迟抖动或工程重量之一上退化。