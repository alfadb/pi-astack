---
doc_type: adr
status: accepted
---

# ADR 0028 - Sediment Ground-Truth-Tiered Rearchitecture

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：R1'-R6' 规范脚已上提 `INV-GROUND-TRUTH-TIERED`（含 provenance 门控）+ `REQ-004`，以那里为 canonical。以下机制正文（含 §2 根因 bug-chain / §10 debate 等不可代替 rationale）**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

- **状态**:**v1.1 合议接受(2026-06-07)**。三家跨 provider T0 reviewer(Claude Opus 4-8 / GPT-5.5 / DeepSeek v4-pro)经 **3 轮辩论全票签署** 条款 R1'-R6'(详 §10)。v1.1 增补:另一轮 **3 轮全票** 的「全局分层」辩论产出 **统一最小分层模型**(§12),并据此校正了 §1 对 Tier 的措辞。无保留意见悬置。
- **触发**:一次实地 E2E(排查 TUI 底栏 `rules: none` 长期为 0)暴露用户显式全局规则被静默丢失数周。连续 5 个补丁(escalation / seed-bridge / no-loss invariant / 0.85 dedup / 归属守卫)修好了表象,但三家 T0 独立判定这些补丁是某个**根因的症状**,要求 stop-and-rearchitect。
- **依赖**:[ADR 0023](0023-session-start-rule-injection.md)(rules 注入 + 写路径)、[ADR 0024](0024-second-brain-from-natural-conversation.md)(第二大脑哲学 + 四 invariant + AI-Native 原则)、[ADR 0025](0025-sediment-meta-curator-subsystem.md)(sediment 写侧落地)、[ADR 0027](0027-coupled-stigmergic-dual-loop-agent-system.md)(L1/L2 双环拓扑)。
- **对偶**:ADR 0024 定**哲学不变量**;本 ADR 修正其一条具体推论--`INV-IMPLICIT-GROUND-TRUTH` 把"所有信号都是隐式且等价"当真,而**用户显式指令是显式 ground truth**,必须按 ground-truth 强度分层,不能与 LLM 推断假设同管线。
- **编号说明**:ADR 0027 §范围曾把 0028 预留给"IDE/host 边界"。该话题顺延至 0031;本号按用户指定用于本次 sediment 重构。
- **迁移成本**:本 ADR 按用户指令 **不计迁移成本**(greenfield 允许)。§9 给分阶段落地建议,但设计正确性优先于增量兼容。

---

## 0. 起草说明

### 写什么
- 根因诊断(§2):为什么连续打补丁修不好。
- 三家 T0 全票签署的 6 条共识不变式 R1'-R6'(§3)--本 ADR 的规范性核心。
- 目标架构与逐轮数据流(§4-§7)。
- 接受的代价 + 走偏信号(§8);分阶段落地(§9);3 轮辩论评审史(§10)。

### 不写什么
- ADR 0024 四 invariant / AI-Native 原则的论证(引用,不重复)。
- 现有 Tier-2 概率管线(extractor/curator/multi-view/skeptical-historian)的内部细节--本 ADR **保留**它,只在边界处引用。
- 具体 TypeScript schema / wire format--属实现层,实现 PR 里定,本 ADR 只定边界与不变式。

---

## 1. 一句话总纲

> **以 ground-truth 强度为信号流的主分区轴。** 用户在自己消息里说出的显式指令(attested ground truth)与 LLM 从对话里推断的假设(uncertain hypothesis)是两个认知类别,必须走两条路径:前者**确定性提交、不可被 LLM 丢弃、可见**;后者保留现有概率管线、完全隐形。一个候选**永不**需要两个检测权威同时同意。
>
> **(v1.1 校正,详 §12)**:后续"全局分层"辩论(3×T0 另一轮 3 轮全票)校正了这里的措辞:ground-truth 强度不是一个独立的**存储轴**,而是 **AX-PROVENANCE 轴**(用户表达 / 助手观察 / 转录内容);Tier-1/Tier-2 是在写时对该轴的**计算谓词**(非并行分类)。R1'-R6' 不变。

---

## 2. 根因

### 2.1 单一根因
当前 sediment 把**"用户显式指令"(近确定)**与**"LLM 推断假设"(不确定)**当作同一认知类别,全部塞进一条为后者设计的概率化管线:`extractor → curator → multi-view → staging → dedup`。ground-truth 强度至多是某个 prompt 里的一个 confidence 浮点数,而非架构轴。

### 2.2 根因如何生成本会话的整条 bug 链
| 症状 | 机制(file:line) | 同源根因 |
|---|---|---|
| B1 规则进 staging 永不提升 | `correction-pipeline.ts` `durable && !target → writeStagingEntry`;staging→promotion v1 deferred(`staging-resolver.ts` 只 triage) | 显式指令走了为不确定假设设计的 staging |
| B2 escalation 只在 <200 字符窗口 | `index.ts` `shortWindowClassifierOnly = window.skipReason==='window_too_small'`(`checkpoint.ts:425`, `minWindowChars=200`) | window-gate 本为"extractor 是否有足够上下文"而设,被误用到规则 |
| B3 extractor 不吐 draft 即丢规则 | `tryAutoWriteLane` 在 curator 循环前 `compliantDrafts.length===0 → llm_skip`;correctionSignal 仅作 per-draft 上下文 | detection 权威分裂,classifier 无一类写路径 |
| B4 no-loss 漏洞 | 长/drain 车道在 lane 运行前乐观推进 checkpoint;`writeStagingEntry` 曾吞 IO 错误 | 系统假设概率路径会成功 |
| B5 dedup 误合并(pnpm vs yarn) | `rule-writer.ts` token-set Jaccard 0.7 把"用 pnpm"/"用 yarn"合并(0.75) | 用概率近似(token 重叠)处理本应精确的指令 |

### 2.3 "自白式" 烟枪
`index.ts buildEscalationSeedDraft`(2026-06-07 补丁)的存在本身就是证据:classifier 抓到一条 extractor 漏掉的 durable 指令,于是把信号**硬塞回 extractor 的 draft 流**。三家 T0 独立判定它是"需要一条独立路径"的自白--方向对、接线错。本 ADR 删除它。

### 2.4 第二根因(次要)
**detection 权威分裂**:general extractor(`llm-extractor.ts`,产 `MEMORY:` draft)与 active-correction classifier(`correction-pipeline.ts`,产 `CorrectionSignal`)是两个独立 LLM 调用,会"意见不合"。ADR 0025 §1.5 本**决定**统一,代码未落实。本 ADR 用 **disjoint authority**(非强制单调用)消解。

---

## 3. 共识不变式(三家 T0 全票签署,规范性)

> 以下 R1'-R6' 是 ADR 0028 的规范性核心。实现必须满足全部 6 条。每条标注其调和的 Round-1 立场。

**R1' - Disjoint detection authority(消解第二根因)。**
extractor 与 classifier 保持为**独立 stage / 模型**,但**权威不相交**:classifier **拥有** directive→Tier-1 候选,extractor **拥有** inferred→Tier-2 候选;任何候选**永不**需要两者同时同意。seed-bridge 因此消失(directive 候选直接 classifier→Tier-1 writer)。
*写序注*:同一句话可能同时被 classifier 标为 Tier-1、被 extractor 标为 Tier-2;writer 用确定性 body-hash/slug 去重,**Tier-1 写入胜出**,Tier-2 回声 no-op。
(调和 gpt"单候选单权威" + deepseek"分离的认知任务/模型"。)

**R2' - Tier-1 = 结构化来源门控的确定性提交(消解主根因 + B1/B2/B3)。**
一个候选是 **Tier-1** 当且仅当:`verbatim quote 结构化 grounded 在一条 USER-ROLE 消息(quote_source=user_message,对照转录校验,**非** tool_result/file/assistant turn) AND is_directive AND durable`。
- Tier-1 → **确定性保证提交**;router/curator 可**增益**(zone/tier/scope、update-vs-create、LLM 语义 dedup),但其输出空间**排除 skip 与 stage**;router 出错/超时 → 从 verbatim quote 做**确定性 default-zone create**。
- README/工具里的"always use Yarn"陷阱由**结构化来源检查**挡掉(content-in-transcript / tool_result ≠ user_message → **不是 Tier-1** → 落 Tier-2,那里 curator 可 skip)。
- **`is_directive` 召回偏置**:对 user-role 祈使语气话语,分类器**偏向** Tier-1。理由:过度提升有界(R3 tell + 用户可廉价纠正),漏判是**静默丢失**(本次拒绝吸收的失败)。非对称代价 → 非对称阈值。
(调和 opus/gpt"kill path 里没有 LLM" + deepseek"README 陷阱需防护"--防护是**确定性来源检查**而非概率 curator-skip。kill path 既不在 commit 也不在概率判断,而是上移到结构化 + 召回偏置的 is_directive,再由 R3 兜底。)

**R3' - 高风险写入的可见性 + 召回审计(强制)。**
- Tier-1 **强制** tell-not-ask 确认面(footer/notify:"📌 noted as rule: ...")。合法(ADR 0024 §INV-R8 祝福 tell-surface;违规的是 ask=`[Y/N]`)。理由:去概率化移除了管线唯一的纠错器,可见面让误写对用户可观察。
- **负信号召回审计**(in-scope,轻量):触发左值是**转录窗口里存在 user-role 祈使句 AND 不存在对应规则** → recall flag。**键于原始转录,而非分类器已标注**(否则正好漏掉 is_directive 欠触发的 case)。这是 R2' 召回缺口的安全网。

**R4' - Outcome edge:闭合 write-only loop(in-scope,不可延期)。**
注入→下一轮用户行为对照,挂在 injection ledger(共享 session/turn 键,ADR 0027 C6 已埋)。
- **非对称**:CONTRADICT = 强 demote(动作:status→contested / authority-);MATCH/复用 = 弱确认(echo-guarded)。
- **自回声扣除**:MATCH **不得**把 agent 自己注入的规则文本当独立确认;join 先减自回声。
- 尽量 mechanical(无 LLM)。这是当前缺失的反馈边,是根因修复的纠错半环--只写不学的系统只会累积误差。

**R5' - Dedup:Jaccard 退为预过滤,curator LLM 为语义权威。**
Jaccard **永不**作自主 merge/写路径闸门;至多作便宜的召回预过滤。curator LLM(邻居已加载)是语义 dedup 权威。exact slug + body-hash 为确定性 no-op。

**R6' - Staging 收窄。**
staging **仅**留给 (a) 真正不确定的 Tier-2 假设 / 不可归属信号,(b) multi-view 瞬时失败的 defer-replay。staging **不是** Tier-1 路径,也**不是** Tier-1 fallback(Tier-1 fallback = 确定性 default-zone 写)。

---

## 4. 目标架构

### 4.1 逐轮数据流(agent_end,异步后台)
```
0. 显式 fence 抽取(SYNC,0 LLM)  parseExplicitMemoryBlocks → 直接 write → 推进 checkpoint
1. Outcome 采集(SYNC,0 LLM)     扫 tool result + memory-footnote → outcome-ledger.jsonl
                                 + R4' 注入→行为对照 join injection ledger(非对称,自回声扣除)
2. Classifier(1 LLM,快档)        产 CorrectionSignal{typing,conf,user_quote,quote_source,target_slug,...}
                                 R2' 结构化门控:quote_source=user_message ∧ is_directive(召回偏置) ∧ durable
        ├─ 是 → TIER-1 候选(disjoint:直接进 Tier-1 writer,不经 extractor)
        └─ 否 → 落 Tier-2 / staging(R6')
3. Extractor(1 LLM,推理档)       产 inferred MEMORY: draft → TIER-2 候选(disjoint)
4. 写路径:
   TIER-1: 确定性提交 ── 仅以下可触及,均不"丢":
            sanitize(redact-not-drop) · exact body-hash 幂等 no-op · schema/min-body
            router/curator 仅增益(zone/tier/scope/update-vs-create/LLM dedup),输出排除 skip/stage
            router 失败 → 确定性 default-zone create from verbatim quote
            → writeAbrainRule → git commit → 强制 tell footer(R3')→ injection ledger
   TIER-2: 现有概率管线(curator 可 skip/defer + 选择性 multi-view + staging) 原样保留
5. 负信号召回审计(R3'):转录有 user-role 祈使句但无对应规则 → recall flag(健康信号)
```

### 4.2 LLM 调用预算(每轮,全异步后台,用户不阻塞)
- classifier 1(快档) + extractor 1(推理档) + curator N(仅需 lifecycle 的候选) + multi-view 0-2(仅高风险 Tier-2)。
- Tier-1 写入在 detection 后**0 额外 LLM**(router 增益可选;dedup 在 ambiguous band 才唤 LLM)。常见轮次比现状**更少**调用且作用域更准。

### 4.3 谁能挡住每条写入
- **Tier-1**:只有确定性门(sanitize/幂等/schema)+ 结构化来源门;**无 LLM skip/stage 在 kill path**;失败→确定性 fallback 写。
- **Tier-2**:完整概率闸(curator skip/defer + multi-view + staging),完全隐形。

---

## 5. 保留 / 删除

**保留**:Tier-2 概率管线(extractor/curator/multi-view blind-first/skeptical-historian--对推断知识是对的)、rule-writer 基础设施(writeAbrainRule/lint/demote/lock/body-hash)、curator 作为 Tier-2 闸门与 Tier-1 增益器、evolution-ledger、footer/notify/audit(R3' 的可见性基底)、staging(收窄至 R6' 两用途)。

**删除 / 收编**:第二 detection 权威(改 disjoint)、**seed-bridge(`buildEscalationSeedDraft`)**、`shortWindowClassifierOnly` escalation 特例、durable 信号走 staging 的路径、长/drain 乐观推进(统一为"安全捕获才推进")、token-Jaccard 作写路径/合并闸门(退为预过滤)。

---

## 6. Tier-1 vs Tier-2 判定细节

- **quote_source 判定**(R2'):每条转录 turn 带 `role`(user/assistant/tool/system);verbatim quote 映射到唯一 turn,取 `turn.role`。哈希查表,非分类。跨多 turn 的 quote → fail-closed(不算 user_message → Tier-2)。README 内容到达于 `role=tool` turn,天然非 user_message,零误报。
- **is_directive 召回偏置**(R2'):user-role 祈使语气偏向 Tier-1;过度提升被 R3' tell + 用户纠正 + R4' outcome 兜住。
- **召回审计**(R3'):祈使句检测可正则+启发式(句首动词/无显式主语/"必须""不要"等 mood marker)高召回低成本;误报无害(只触发一次便宜复核);需要时也可挂快档 LLM。

---

## 7. Outcome edge(闭合写-only 环)

当前 outcome-collector 只有 mechanical 检索计数 + memory-footnote 自报(自报有 echo-chamber 风险,系统已自知 `possible_echo_chamber`)。**唯一锚定真实 ground truth(=用户)的边**是:规则 R 在第 N 轮被注入 → 第 N+1 轮用户行为是否**矛盾** R。
- 矛盾 → 强 demote R(→contested / authority-)。
- 匹配/复用 → 弱确认,echo-guarded,**先减自回声**(不把注入文本本身算确认)。
- 实现尽量 mechanical;join 键已由 ADR 0027 C6 埋好。

---

## 8. 接受的代价 + 走偏信号

**接受的代价**
- Tier-1 去概率化把"静默丢好指令"换成"可能静默写坏指令"--**仅当**同时有 R3' 可见面 + R4' outcome 才净收益(opus 载重论点,三家签署)。
- is_directive 召回偏置会**过度提升**一些边缘指令;有界且可纠。
- disjoint authority 下同句双发,靠 body-hash 去重(R1' 写序)。

**走偏信号(命中即回看本 ADR)**
- Tier-1 写入开始出现 user 没说过的规则 → 结构化来源门或 is_directive 召回偏置失准。
- 召回 flag 持续为 0 而用户仍报"规则没记上" → 审计左值键错(又键到了分类器标注)。
- outcome edge 只产 MATCH 从不产 CONTRADICT → 自回声没扣干净,退化成 echo chamber。
- staging 又开始堆积 durable 条目 → 有人把 Tier-1 信号误路由回 staging(B1 回归)。

---

## 9. 分阶段落地建议(不计迁移成本,但仍要安全顺序)

1. **P1 - 结构化来源 + disjoint 写路径**:加 `quote_source`(turn.role 查表)、classifier directive 候选直连 Tier-1 writer、删 seed-bridge / escalation 特例 / durable→staging。Tier-1 确定性提交 + R3' tell footer。
2. **P2 - 统一 no-loss 推进**:把短车道的"安全捕获才推进"推广到长/drain;Jaccard 退预过滤,curator LLM 语义 dedup。
3. **P3 - outcome edge + 召回审计**:injection ledger 行为对照(非对称 + 自回声扣除);转录键召回 flag。
4. **迁移期护栏**(gpt):统一/切换前先 dual-path shadow audit--新路径只读对照、只让既定路径写,确认召回不退化再切。drain 旧 staging。
每阶段沿用既定工作流:实现 → 3×T0 盲审 → 收敛 → push。

---

## 10. 三轮辩论评审史(provenance)

**Round 0(根因复审)**:3×T0 独立批判,收敛根因=ground-truth 强度未作主轴 + 双 detection 权威;三家独立点名 seed-bridge 为 band-aid;判定 stop-and-rearchitect。

**Round 1(立场)**:6 个开放问题。已收敛:Q3 可见 tell 强制 / Q4 outcome in-scope / Q5 Jaccard 不作权威 / Q6 staging 仅留不确定。剩 2v1:Q1 统一 vs 分离 detection;Q2 确定性 Tier-1 vs curator-gated。deepseek 给出关键 CONCEDE-IF:`quote_source===user_message → 跳过 taxonomy`。

**Round 2(调和草案 R1-R6)**:用 deepseek 的 CONCEDE-IF 把"README 陷阱"从概率 curator-skip 改为**确定性来源门**;用 **disjoint authority** 调和 Q1。结果:gpt 全签;deepseek 全签(确认 curator-skip 在 Tier-1 已死、quote_source 可无 LLM 实现);opus 签 R1/R4/R5/R6,对 R2/R3 提一个耦合改进--kill path 被**上移**到 is_directive,需 (a) 召回偏置 (b) 召回审计键于转录。

**Round 3(终批 R1'-R6')**:折入 opus 两条召回修补 + R1 写序注 + R4 自回声扣除。**gpt SIGN、deepseek SIGN、opus 条件已满足 → 三家全票。** 无悬置保留。

---

## 11. 一句话边界声明(防误读)

- 本 ADR **不**否定 ADR 0024 的隐形自治哲学;只修正"所有信号隐式且等价"这一条,引入**ground-truth 强度分层**与**可见性∝stakes**。
- Tier-2 概率管线**原样保留**--它对 LLM 推断知识是对的。本 ADR 只为**显式用户指令**新增确定性路径。
- "确定性提交"指**不可被 LLM skip/stage 丢弃**,不指绕过 sanitize/幂等/CAS/schema 等确定性安全门。

---

## 12. 统一最小分层模型(Unified Minimal Layering Model)

> v1.1 增补。用户质疑"第二大脑层是否太多"。3×T0(opus-4-8/gpt-5.5/deepseek-v4-pro)经 3 轮辩论**全票签署**:当前 **8 个分层维度塌缩为 3 个存储轴 + 1 个 facet + 4 个降级为子系统概念**。本节是 ADR 0028 关于"信息模型"的规范性补充;§1-§9 的写路径设计是它在 sediment 侧的落地。

### 12.1 现状:8 个重复编码的层
`L-ZONE`(七区+rules)、`L-KIND`(7 种 + 按 kind 的目录)、`L-SCOPE`(world/project)、`L-STATUS`(6 态)、`L-TIER`(always/listed)、`L-STAGING`(provisional/durable)、`L-GTIER`(ADR 0028 Tier-1/2)、`L-TRUST`(USER-EXPRESSED/ASSISTANT-OBSERVED/CONTENT-IN-TRANSCRIPT)。多处把**同一区分编码多次**:一条 rule = zone:rules + kind:preference + tier:always + scope:global(四标签);Tier-1 ≈ USER-EXPRESSED;staging ≈ provisional ≈ Tier-2-uncertain(三名一物)。

### 12.2 合议:3 存储轴 + 1 facet
| 轴 | 取值 | 唯一服务的功能 | 收编 |
|---|---|---|---|
| **AX-SCOPE** | world / project:&lt;id&gt; | 路由 + sync 边界 + 检索 boost(projectBoost) | L-SCOPE |
| **AX-PROVENANCE** | user-expressed / assistant-observed / content-in-transcript | **写路径选择**(确定性 vs 概率)+ R4' outcome 降级目标。**落盘 frontmatter**,由 `turn.role` 确定性派生(无 LLM enum);ledger 为 source-of-truth,frontmatter 为可重建的物化视图(写路径/读路径都本地、不查 ledger 热路径)。 | L-TRUST(删枚举)、**folds L-GTIER** |
| **AX-MATURITY** | active / archived / superseded / contested / provisional | 生命周期 + 注入资格。`deprecated` **folds→superseded**;默认检索排除 `{archived, superseded}`;`contested` 保持**可见+标注**(R4' CONTRADICT 的降级目标,live-but-disputed 要被 surface);`provisional` 保持**可见**,是 `normalizeStatus` 未知/降级态的中性 fold-target(**非** trust 信号)。 | L-STATUS |
| *facet* **f-CATEGORY**(=kind) | 7 种保留 | 检索/索引 **facet**(filter/sort/index section/label)--**非结构轴**;无任何读或生命周期路径分支于具体 kind 值(仅 Set.has + 排序 + 展示标签),值数量是调参细节,留 7 以保标签粒度(如 smell→"staging" 标签),将来仅当某值零独立读行为时再并。 | L-KIND |

### 12.3 降级为子系统概念(不是全局 per-entry 层)
- **ZONE** = 文件系统**写路由 + 可见性**约定(identity/skills/habits/knowledge/rules/vault/workflows);`MemoryEntry` **无 zone 字段**,memory_search 从不读它。保留为目录组织,不再称"层"。
- **INJECT-MODE** {always, listed, none} = **rules 子系统**注入预算（rule-injector 读）,**改名脱离 "tier"** 以免与本 ADR Tier-1/2 冲突;仅作用于 rules zone。存储与审计字段应使用 `inject_mode`;旧 `tier` 键只能作为迁移期双读兼容。`none` 表示非 rules zone 不注入，不应作为持久化存储值。
- **STAGING** = 瞬时 triage/replay **队列机制**(file-path 排除 + multi-view defer-replay);其 trust 含义 = AX-PROVENANCE + AX-MATURITY,不是独立轴。
- **GTIER(Tier-1/Tier-2)** = 写路径 **router 计算谓词** = `AX-PROVENANCE=user-expressed ∧ is_directive ∧ durable`;**不落盘**(写完即不可区分,这正是"确定性提交"的意义)。
- **L-TRUST 枚举删除**:零代码读;被 AX-PROVENANCE 的确定性 `turn.role` 派生取代。

### 12.4 与 ADR 0028 主体的关系
R1'-R6' **全部不变**--它们本就挂在 AX-PROVENANCE 上(R2' 的 `quote_source=user_message` 就是 AX-PROVENANCE=user-expressed 的机械化)。本节只把"Tier 是主分区轴"的**措辞**校正为"Tier = AX-PROVENANCE 的计算谓词",并把 provenance 从 ephemeral(只活在 classifier 决策瞬间)改为**落盘**,使 R4' outcome-edge 的降级可审计(§8 "走偏信号"已要求这点)。

### 12.5 随手发现的真 bug(实现期修)
`entryMatchesFilters`(extensions/memory/search.ts)默认仅排除 `archived` → `superseded`/`deprecated` 漏网,与 active 同等呈现("superseded 看起来仍 active")。按 AX-MATURITY 默认可见规则,需补默认排除 `superseded`(deprecated 已 folds)。注意: `provisional` / `contested` 默认可见不是漏网,而是 §12.2 本义——`provisional` 是未知/降级态中性 sink,`contested` 是 live-but-disputed 降级目标,调用方要隐藏它们必须显式传 `filters.status=active`。

### 12.6 三轮分层辩论评审史
- R1:三家以不同棱镜(正交性/需求反推/死层与失效)独立判每轴,收敛 L-ZONE/L-TRUST/L-GTIER/L-STAGING/L-TIER 降级、L-SCOPE 保留、L-STATUS 过度枚举;分歧:kind 数量、provenance 是否落盘。
- R2:统一模型草案 + 解决两 open。kind→facet 留 7(全票);provenance 落盘(全票,opus 以"写路径 update-gate 局部性"补强,ledger 为真理源);contested 留(R4' 降级目标)。
- R3:折入两修正(provisional 留作中性 sink;contested 保持可见;search.ts 默认排除对齐)→ **三家全票 SIGN** 最终模型。
