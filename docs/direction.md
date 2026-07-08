---
doc_type: consensus
status: active
canonical_for: INV-INVISIBILITY, INV-AUTONOMY, INV-IMPLICIT-GROUND-TRUTH, INV-ACTIVE-CORRECTION, INV-MAIN-SESSION-READ-ONLY, INV-GROUND-TRUTH-TIERED, INV-DUAL-INVARIANT, INV-USER-NOT-WORKER, INV-TELL-NOT-ASK, INV-COST-NOT-A-GATE, INV-GIT-IS-RECOVERY, INV-SYNC-DETERMINISTIC-MERGE, INV-REVERSIBLE-AUTONOMY
---

# Direction - 不变量 / 取舍 / 走偏信号(承重墙)

> 人类把控的技术大方向。**abrain 不可读 ⇒ 这是人类随时比对、否决方向漂移的可读面。**
> agent 任务开始必读;任何细节决定不得违反这里的不变量;触碰则按 `README.md` §5 升级。
> 这里只写"任何实现都不许违反什么 + 哪些信号该把人类叫回来",不写机制实现(机制在 abrain + 代码)。

---

## 1. 核心不变量(hard invariant)

这些是面向用户所有设计的总边界。来源:ADR 0024 §2、0003、0013、0028、0027、0033、0020。

### INV-INVISIBILITY(隐身性)
用户**不参与大脑管理**--不审批、不裁决、不投票、不归档、**不手动编辑 / 恢复任何条目**、不定期审查、不手动同步、不批准学习结果。"隐身"指**管理负担对用户隐身**,**不是**"运行状态不可见"(footer/notify/audit/`/abrain status` 等健康反馈正常显示)。
**判别口诀**:系统**告诉**用户大脑做了什么 → ✓;系统**要求**用户为大脑做事 → ✗。
唯一合法的"弹窗+[Y/N]"是 `vault_release`(审批**数据流出边界**,非审批大脑学什么)。

### INV-AUTONOMY(自治性)
大脑通过观察自然对话学习。用户不做"专门为维护大脑而存在的动作"。哪怕用户一个月不看任何元 UI,大脑也应越来越准。

### INV-IMPLICIT-GROUND-TRUTH(隐式真实信号)
所有真实信号来自自然对话本身--输入、决定、接受/修改/拒绝 LLM 输出、沉默、跟进、主动纠错。"隐式"指**采集方式不靠元 UI**,不是指用户被动。LLM 的解释(outcome/multi-view/aggregator)**不得**被升格为 ground truth。

### INV-ACTIVE-CORRECTION(主动纠错通道)
用户在任务里自然冒出的"以后用 X / 忘掉那条 / 你怎么记成 Y / 现在更倾向 Z"是**核心真实信号通道,不算元工作**。系统必须能识别并送进 sediment。

### INV-MAIN-SESSION-READ-ONLY(主会话对记忆只读,ADR 0003)
主会话 LLM 不是记忆写入者;**sediment sidecar 是唯一专用写入者**。已接受的残余面:LLM 仍可经通用 bash 等路径间接写--这是显式接受的取舍,不是漏洞。

### INV-GROUND-TRUTH-TIERED(真实信号分层,ADR 0028 + ADR 0039)
**显式用户指令是"被见证的 ground truth"**:确定性提交、对用户可见、**永不被 LLM skip/stage 丢弃**;它**不走**与 LLM 推断知识相同的概率管线。ADR 0039 后,确定性提交先表现为 witnessed Evidence Event 持久化,再由域 projector / compiler 生成 stable view;投影延迟必须通过 queued / stale / projected 状态可见,不能静默丢失。
**分层按 provenance 门控**:Tier-1(确定性提交)当且仅当 verbatim 落在 **USER-ROLE 消息** ∧ is_directive ∧ durable;content-in-transcript / tool_result / file / assistant turn **不是** Tier-1(挡掉 README "always use Yarn" 注入陷阱),落 Tier-2 由 curator 可 skip。代价非对称(过度提升有界、漏判=静默丢失)→ 对 user 祈使句分类偏向 Tier-1。

### INV-SYNC-DETERMINISTIC-MERGE(同步只走确定性合并,ADR 0020)
跨设备同步只用**确定性 git 操作**:ff + git 自带 3-way auto-merge(无冲突分叉自动合并)。**LLM 合并冲突被明确拒绝**--知识库里一句幻觉就污染基底且事后难查。真冲突 abort 并向用户出 runbook("提示用户去处理"),不静默、不 LLM 编造。

### 信任 × 影响半径(ADR 0013)
门的严格度 ∝ (1-信任) × 影响半径;用户亲手输入 > 用户调用 > LLM 后台;不存在用户→world 的直接自动写。

### INV-DUAL-INVARIANT(L1/L2 双不变量治理,非正交,ADR 0027 C1')
L1(认知)与 L2(执行/swarm)各持**不可互相归约**的 invariant 集,不可用一套 curator policy 覆盖两层(L1 的 INV-INVISIBILITY ≠ L2 的 bounded-latency)。但二者**非正交**:L2 outcome 经 stigmergic trace 反馈 L1 认知,L1 意图/偏好以 annotation 约束 L2 调度--互嵌共生闭环。任何用一套 policy 覆盖两层的设计都会破其中一边。

### INV-USER-NOT-WORKER(用户不作 swarm worker,ADR 0027 C4')
用户在 L1/L2 中**不作** worker/reviewer/curator/hub/调度节点。合法角色仅:L1 隐式信号源 + L1 决策参谋接受方(ADR 0026);L2 主任务发起方(自然对话 + `prompt_user` 任务决策 + `vault_release` 授权)。拒绝的是"把用户踢出 loop 的自治长跑"(Devin/SWE-agent),**不是**拒绝后台并行。L2 整体对用户**必须可问责**:任何失败在 L1 当前 turn 内可见 / 可归因 / 可追问。

### INV-TELL-NOT-ASK(调用面自然语言优先,ADR 0033)
用户与 LLM 永远用自然语言;工具调用由 LLM 决定。要求用户记忆/敲出 slash 命令是把机器接口成本转嫁给人 = INV-INVISIBILITY 在能力面的违反形态(slash 管理命令是过渡反模式)。能力面(goal/workflow/dispatch)**零确认弹窗、零 per-run 人肉点头**。三层归位:**结构层管不变量、认知层管判断、用户管意图**;确认弹窗是把"判断"错放进"意图"层。

**2026-07-08 operator 边界补注（理由：单用户部署中用户兼任维护者，需区分用户角色与维护者逃生口）**:诊断/迁移类 slash 命令是维护者逃生口，不构成对用户角色的元工作；它们不得成为正常产品调用面，也不得要求用户以 slash 形式完成日常任务。每个此类 slash 必须在文档或 tool declaration 标注退役条件；无法标注退役条件者应退役。

### INV-COST-NOT-A-GATE(成本归用户,永不作闸,ADR 0033 + T0 cost-blind)
成本不是设计维度。处理方式 = 事后透明(run 汇总含 `totalCost`),**永不拦截执行**。

### INV-GIT-IS-RECOVERY（git 是全部恢复机制，ADR 0033）
会话内变更改坏了就重来；git 的常规使用就是全部恢复机制。为低概率/低损失/可重做事件建专用防护 = 过度工程（第二大脑同型 anti-pattern：LLM 反复默认机械护栏）。

### INV-REVERSIBLE-AUTONOMY（自治遗忘必须有界可逆，ADR 0031）
大脑对记忆生命周期**完全自治**（遗忘策略零人类可调参数：忘什么/多快/保护谁/`kind` 权重全由大脑自学自标定）；但任何自治遗忘动作必须**有界可逆**：(a) **无自治物理删除**——自治遗忘终点是 `archived`（全文留盘、sparse 可达），`git rm` 不在自治授权内；(b) 被降级条目必须有**至少一条运行时可达、不依赖任何人类手动介入（手动编辑条目 / `git revert`）、也不依赖大脑主动想起**的复活通道（当前：sparse 召回 + 用户纠错）；(c) 将来任何物理回收须先满足 (b) 的检索等价保真度。
**与 INV-GIT-IS-RECOVERY 的边界**：git-as-recovery 对**人类操作的会话内编辑**成立；但自治遗忘的恢复者是**大脑**，而大脑运行时**从不读 git log**，故其复活面必须在工作树内（`archived` 终态下限）而非 git history。这不是新建专用防护，而是复用既有 `archived` 软删除状态 + **拒绝新增**自治销毁能力——与反过度工程一致。

---

## 2. AI-Native 原则(技术里的人类价值,不可降格)

> **任何能力点防出错的主要路径必须是 prompt 工程**(注入上下文 + 引导推理 + 让 LLM 自验证),**不能是机械护栏**(schema 拦截 / 阈值 / TTL / 哈希 / 用测试当阻断)。机械工程只能做兜底或基础设施(git / 文件系统 / 同步 / `session-id+turn-id` 锚点 / heartbeat),**不能作为 LLM 行为层主防线**。

由来:多轮多模型评审反复把"防出错"推向加机械门(RLHF 偏置),人类 R6 介入升格此原则;R7 实证有效。
**自检义务**:提"加某种关卡/schema/测试拦截"时,先问"能不能改成给 LLM 多塞上下文 + 让它自验证?";改不了才走机械,且必须显式说明为什么不能用 prompt。
**合法例外**(不算违反):defense-in-depth(prompt 为主路径 + 代码只能拒绝 + 走 audit-flagged skip);已 justify 且声明了 flip/移除条件的过渡态机械门;ADR 0028 的来源边界门(provenance / 幂等 / sanitize)。**无条件的机械门是走偏信号。**

**认知/infra 分层边界(ADR 0027 C3')**:上述约束**仅适用于认知层**(classifier / curator / writer / reviewer / 参谋决策 / 证据评估 / 主动纠错语义分类)。**Infra 层**(tool schema / audit 事件格式 / 状态机 / retry 计数 / cost accounting / wire format / heartbeat / cancellation token / done-marker schema / singleFlight lock)走 structured 是正当的,不受此约束。判别:加一个 done-marker JSON schema → infra,✓;加一个"classifier 准确率 <80% 阻断写入"→ 认知层机械门,✗。

**2026-07-08 机械护栏 justification 对照表（理由：区分 infra/provider/落盘补偿与认知层机械门，防止例外无条件扩张）**:

| 护栏 | 分层判定 | 触发它的真实故障 | 移除条件 |
|---|---|---|---|
| `tool-circuit-breaker` | infra liveness | 待补证；现有代码只证明其为 repeated tool-call breaker（`extensions/_shared/tool-circuit-breaker.ts`），未在目标资料中找到可确证事故记录 | 连续 dogfood audit 无重复 tool-call 卡死，且上游 pi/模型层提供等价 liveness 终止语义后退役 |
| `thinking-repeat-breaker` | infra liveness | 待补证；现有代码只证明其监听 visible `thinking_delta` 重复（`extensions/_shared/thinking-repeat-detector.ts`），未在目标资料中找到可确证事故记录 | 连续 dogfood audit 无 visible-thinking 重复卡死，或 provider 不再暴露该失败模式且上游提供等价终止语义后退役 |
| `edit-strip-empty` | provider 协议补偿 | Opus 4.8 dogfood 频繁生成空值幻构属性如 `newText2: ""`，触发 pi edit schema `additionalProperties:false` 拒绝；证据见 `extensions/edit-strip-empty/index.ts` 文件头注释 | 目标模型不再产生空值幻构属性，或上游 schema/prepareArguments 原生忽略空值未知字段且 smoke 证明行为等价后退役 |
| `empty-visible-output-retry` | provider 协议补偿 | provider 返回 hidden thinking 但 visible text 为空、`stopReason:"stop"` 且无 error，pi 会当成功导致 UI 静默停止；证据见 `extensions/empty-visible-output-retry/index.ts` 文件头注释 | provider/pi 将“无可见输出但正常 stop”原生标记为 retryable error，且 smoke 覆盖后退役 |
| `verify-after-edit` | 落盘正确性 | 2026-05-30 dogfood 中 Opus 4.8 多批 edits 原子失败/部分成功后，模型据成功行误以为所有变更落盘并继续 commit/push；证据见 `extensions/verify-after-edit/index.ts` 文件头注释 | pi edit 原生返回足够的 post-edit disk truth，或模型/tool 合约强制每次 edit 后可见校验窗口且 smoke 覆盖后退役 |
| `tool-parallel-cap` | provider 协议补偿 | Anthropic-family dogfood 中单 assistant message 产生 10+ parallel `tool_use`，导致部分状态交错、阻塞 verify-after-edit 反馈、放大 edit batch 原子回滚类问题；证据见 `extensions/tool-parallel-cap/index.ts` 文件头注释 | 目标模型不再批量并行 tool_use，或 harness 能串行化依赖敏感工具并保留逐步反馈，且 `smoke:tool-parallel-cap` 可删除后退役 |

---

## 3. 已接受的代价

不接受这些 = 不接受这份设计 = 回到"用户维护大脑"或"机械门兜底"。来源 ADR 0024 §6。

- 错误跨设备传播(直到下次自然对话产生反证)。
- 偶发"假高置信",自动纠正前可能误导数周到数月。
- 自治归档误降级（`archived` 终态下限 + 运行时复活通道作为回退保障，见 INV-REVERSIBLE-AUTONOMY；不再单靠 git history）；跨设备最终一致延迟。
- 错沉淀**内容**察觉不到(footer/notify 告诉发生了什么,但不要求逐条审阅)。
- 主动纠错疲劳;multi-view 翻倍 token 成本;早期 prompt 推理质量参差;LLM 推理失败本底概率。
- 默认开启后用户察觉不到的偏差累积(对冲:aggregator + multi-view + sanitizer + `"staging-only"` 退路)。

---

## 4. 走偏信号(出现任一条 → 回头审视方向,可能需要 walk-back)

这是承重墙的返回路径:当 abrain 的细节决定累积侵蚀方向,下列可观测信号把人类叫回。来源 ADR 0024 §7。

1. 自然对话纠正不了的错持续累积 → INV-AUTONOMY 可能需部分回退(引入轻量用户参与)。
2. 跨设备错误传播代价过大 → 可能需 per-device override。
3. Multi-view 跨基座调用成本不可承受 → 需更轻量自检替代。
4. 跨设备主动纠错疲劳显著 → 下调重复升级阈值,或显式识别"已经说过了"。
5. classifier 推理质量持续退化(quote / alternative / self-critique rate 持续 <40% 或下降 ≥15pp 且改 prompt 数轮无改善)→ 该能力点降级 staging-only 或拆独立 ADR。
6. **AI-Native 原则在某能力点反复证伪**(多轮 prompt 迭代仍达不到 baseline)→ 该点单独允许机械兜底(须说明已尝试轮数 + 系统性失败证据 + 局部范围 + 未来移除条件),**不全盘 walk-back 原则**。
7. R6 删除的"准确率阈值 / 月度自动迭代 / 准确率 smoke"被实战证明确实必需 → 重新引入,但必须 framed 为"仅供参考指标"而非硬关卡。
8. **goal/workflow/dispatch 能力面重新出现确认弹窗或 per-run 用户动作**(INV-TELL-NOT-ASK / INV-COST-NOT-A-GATE 被侵蚀--最可能形态:未来 PR 以"安全"为名复活机械门/人肉点头,ADR 0033 总纲被推翻)→ 立即按 README §5 升级。

9. **归档冷存储（`archived`）按 `kind`/领域分布严重失衡，或 resurrection rate 长期趋零而 corpus 持续膨胀**（自治遗忘策略偏盲、长尾被静默系统性流失的信号，ADR 0031）→ 回看 ADR 0031 基线，检查衰减是否偏盲。

**walk-back 必须基于真实实战数据，不是“想象中可能会”。**

---

## 5. 与 abrain 的关系

本文件是 docs(人类共识);机制实现细节在 abrain + 代码。任何 abrain 细节决定若触碰本文件任一条目,必须按 `README.md` §5 升级给人类签字,不得静默改写方向。详细机制 rationale 由 agent 经 `memory_search` 从 abrain 召回并按需讲成人话供人类审计。
