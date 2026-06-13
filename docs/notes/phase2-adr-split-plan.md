# Phase-2 执行计划 — ADR 方向/机制劈分（4×T0 收敛版）

> 工作文档（非共识面，不被 docs-doctor 纳入 canonical 扫描）。
> 来源：2026-06-13 跨厂商 T0 决策轮（opus-4-8 / deepseek-v4-pro / gpt-5.5 / kimi-k2.6），
> 围绕"主会话不能写 abrain"这个硬约束收敛。goal 跨轮跟随本文件。
> 规范上位：docs/README.md（章程）、docs/direction.md（不变量墙）。

## 0. 收敛结论（signable）

### D1 — abrain 写入约束的解法（crux，4 家一致）
主会话在 Phase-2 **不写 abrain**。"机制归 abrain"重释为两步：

1. **现在**：机制正文 **MOVE 到 `docs/archive/adr/`**（git 跟踪、单副本、`read` 可读），
   在 `docs/adr/NNNN-*.md` 留 slim 决策残桩（编号+标题+一句决策+指针）。
2. **以后**：sediment 侧的独立 ingest lane 从 archive/git 把机制分解为多条短 typed entry 入 abrain（独立 ADR，见 §3）。

**硬纪律（DeepSeek+Kimi 重点）**：绝不把机制"删成残桩、只剩 git 历史"。working agent 不会在任务中途做 git 考古；rationale 本身就是护栏（例：0018 的数据丢失证据阻止重新引入同一 bug）。MOVE-到-archive 保持 working tree 可读 = 可接受；delete-to-git-only = footgun，禁止。

**完成判定**：Phase-2 "doc 侧完成" ≠ "整体完成"。README §4 的"按需渲染 rationale"墙要求 abrain 已 ingest；在 spun-out ADR 落地前，archived rationale 是二等公民，整体完成被它 block。

### 为什么 archive-and-defer 是对的设计（Opus）
一次性把 23 份 ADR 批量 dump 进 abrain 本身违反 INV-IMPLICIT-GROUND-TRUTH（sediment 从自然信号学，不吃 bulk doc-dump），正是项目不信任的"机械回填"。所以"归档+延后由 sediment 自然 ingest"不是 workaround，是正解。

## 1. 23 份 ADR 处置表（Opus 主笔，判别式：abrain 能否靠更好代码自改且人类不失方向控制？能→detail，不能→direction）

| ADR | 处置 | 一句理由 |
|---|---|---|
| 0001 personal-pi-workflow | EXTRACT-then-SLIM | vendor read-only / 单向依赖 / ratchet 是治理价值→vision/direction；gbrain 旧机制→archive |
| 0003 main-session read-only | EXTRACT-then-SLIM | 决策=INV-MAIN-SESSION-READ-ONLY（已在 direction+REQ-005）；bash-guard 机制过时。**结构承重**（0032/0033 引它当权威支柱），编号必须可解析 |
| 0006 component-consolidation | EXTRACT-then-ARCHIVE | 组件清单/路径/迁移可代码派生（UPSTREAM.md 为真）；仅三分类原则值得抽 |
| 0009 multi-agent base capability | EXTRACT-then-SLIM | "dispatch 是底座非固定策略工厂"=方向立场；API/模板/改名=机制。0032 引它→留桩 |
| 0010 sediment single-agent | EXTRACT-then-ARCHIVE | 被 0016 取代；3-model 投票失败的 5 根因是高价值经验→INGEST-QUEUE |
| 0013 asymmetric-trust 3-lanes | EXTRACT-then-SLIM | trust×blast-radius 原则=方向（已在 direction §1）；Lane B/D 死、Lane C 被 0016 删。留桩，0014/0016 引 |
| 0014 abrain personal brain | KEEP-as-direction | abrain 定位+七区拓扑+vault 授权不变量=方向，6 处引用。**任务 B 须剥掉巨型 commit-status 头（REQ-006 镜像）** |
| 0015 memory_search rerank | EXTRACT-then-ARCHIVE | 纯机制（两段 rerank/模型/阈值/KV）；仅"accuracy-is-contract / 无 grep 退路"立场→requirements |
| 0016 sediment as LLM curator | EXTRACT-then-SLIM | "重门→LLM curator"=AI-Native 价值（direction §2/REQ-003）；pipeline=细节。0018/0022/0023 引→留桩 |
| 0017 project-binding strict | EXTRACT-then-SLIM | "project-id 唯一身份；未绑定拒写"=高反转成本绑定不变量→direction/requirements；schema/resolver=机制 |
| 0018 curator defense layers | EXTRACT-then-ARCHIVE | 先例记录：试机械门→退回信任 LLM。强 AI-Native 证据→INGEST-QUEUE；无新方向 |
| 0019 self-managed vault identity | EXTRACT-then-ARCHIVE | age/Tier-1/.vault-backend=代码正确性；仅"不依赖系统 ssh key/可移植身份"取舍值一薄注 |
| 0020 abrain auto-sync | EXTRACT-then-SLIM | **D-A 已解**：不变量=「禁 LLM 幻觉 merge」，确定性 git auto-merge（4 轮审计加固）是允许的；冲突语义=方向，phases/router=机制 |
| 0021 Lane G writer | EXTRACT-then-ARCHIVE | writer/fence/router/schema/phases=机制；Lane G 概念已在 0014 区模型。0022/0023 引→先 patch 后 archive |
| 0022 prompt_user tool | EXTRACT-then-SLIM | prompt_user 契约+对 vault_release 的信任/隐私边界=方向；1045 行 dialog/redaction/审计=机制 |
| 0023 session-start rule injection | EXTRACT-then-SLIM | "always-apply 需 push / 显式规则必须被看见"=方向（叠 REQ-004+0028）；classifier/schema=机制 |
| 0024 second-brain charter | KEEP-as-direction | 全 4 不变量+AI-Native+代价+走偏信号的 canonical 出处。去重不变量*陈述*改引 direction.md；§5 六能力留骨架 |
| 0025 sediment meta-curator | EXTRACT-then-ARCHIVE(≈全文) | 0024 §5 的机制对偶，无独有方向。README §5 锚点须重指 archive |
| 0026 decision participation | EXTRACT-then-SLIM | §3.1 walk-back（弃决策点/执行二分→检索参与）=方向事件→feature-changelog/direction；path A/B=机制 |
| 0027 coupled stigmergic dual-loop | KEEP-as-direction | C1'/C3'/C4' 拓扑不变量=方向，0028/0032/0033 引。**须把 C1'/C3'/C4' 镜像进 direction.md（当前缺，D-C）** |
| 0028 ground-truth-tiered | EXTRACT-then-SLIM | R1'-R6' ground-truth-强度为主轴=方向（INV-GROUND-TRUTH-TIERED/REQ-004 已抽）；GTIER 谓词+数据流→abrain。留不变量脊桩 |
| 0032 goal runtime + workflow | EXTRACT-then-SLIM | "自治须用户授权/有界/可见；结构持否决"(W1-W13)=方向；DSL/执行映射/失败语义=机制 |
| 0033 NL-first invocation | KEEP-as-direction | 方向密集且新：tell-not-ask、"成本是用户的非门"、"git 是恢复机制"、反过度工程→INV-INVISIBILITY/AI-Native 扩展**尚未进 direction.md**，抽出同时保留修订记录 |

**计数**：KEEP 4（0014/0024/0027/0033）· SLIM 12 · EXTRACT-then-ARCHIVE 7（0006/0010/0015/0018/0019/0021/0025）· ARCHIVE-as-is 0（每份先过 verify-extract，因各含≥1 方向 nugget 或经验）。

## 2. 安全操作顺序（Opus+GPT 收敛；交叉引用按编号，杀手是 adr/README.md 锚点中枢）

规则：**EXTRACT(加法) → SLIM(原地，引用不破) → patch 入链引用者 → ARCHIVE(移动) → 剥代码镜像 → 重指锚点中枢 → STRICT 收紧**。永不在 patch 引用者前 archive；永不在 extract 验证前 delete。

0. **[DONE] docs-doctor 守卫先行**（本轮已落）。先在迁移前的树上跑绿基线，之后每步对照。
1. **抽取（纯加法，不破任何东西）**：把 KEEP/SLIM/EXTRACT 各 ADR 的方向抽进 direction.md + requirements.md + feature-changelog.md，对现有内容**去重不复制**，set `canonical_for`。显式补已知缺口：0027 C1'/C3'/C4'(/C6)、0033 tell-not-ask/cost-not-gate/git-recovery、0015 no-grep-fallback、0017 binding-identity、0028 R1'-R6'、0020 no-hallucinated-merge、0022 prompt_user 边界、0013 trust×blast、0026 walk-back。
   - **进度**：✅ 抽取 pass 全部完成。✅ 0027(C1'/C3'/C4')、0033(tell-not-ask/cost/git/走偏#8) → direction.md；✅ 0017→REQ-007、0022→REQ-008、0026 walk-back→feature-changelog；✅ 0028(provenance 门控补 INV-GROUND-TRUTH-TIERED + R3' 召回审计补 REQ-004)、0020→INV-SYNC-DETERMINISTIC-MERGE、0015→REQ-009、0013 确认已在 direction §1。frontmatter/canonical_for 未铺（随极简 frontmatter 批量上）。strip 阶段（current-state + architecture/*5 + directory-layout）✅ 完成。
2. **SLIM（原地标注，非删成残桩——3×T0 裁决 Model B）**：原计划"机制换成残桩指向 git 历史"与 D1 硬纪律冲突（delete-to-git-only = footgun）且 abrain ingest 未落。**裁决 Model B**（DeepSeek 主张 + GPT 锦点安全证据 + Opus spine ADR 同意）：每份 SLIM ADR **只加一个方向头块**（决策一句 + 指向已上提的 INV-*/REQ-* + “机制正文待 sediment 入 abrain 后归档，之前保留可读”标记），**机制正文不移不删**。物理瘦身推迟到 abrain ingest lane 落地。满足 goal criterion 的“标记待 sediment 入 abrain”，零断锁/零 split-brain/可逆。
   - **不可代替 rationale（DeepSeek，原地保留零风险）**：0022(§10 R1-R4 trail/§D6.1 redaction 边界图/INV-A..N)、0023(§1.4 威胁模型/§11 演化史)、0016(gate-by-gate 删除理据)、0020(Alt A-F + why-not-LLM-merge + 4 轮审计)、0028(§2 根因 bug-chain/§10 debate)、0032(§6 H5 判别/§4 provenance 隔离)、0013(Lane D gate + Q-table)。
   - **0018 重评（DeepSeek Dissent 3）**：现 EXTRACT-then-ARCHIVE，但持 AI-Native 经验证据链（commit 521405b/2e8924d 数据丢失）；archive 阶段重评是否改 in-place mark。
   - **锦点（GPT）**：仅 0017 `#sediment-strict-write-guard`（0014 引）与 0026 四锦点（README 引）有入链 #anchor；Model B 标题不动→零断锦点。frontmatter 未铺期勿让 stub 指不存在的 archive 路径。
3. **ARCHIVE 类 7 份：mark-in-place，不 move——3×T0 近一致裁决）**：Opus（从 A 反转）/DeepSeek/GPT 一致 mark-in-place。GPT 量化 move 成本=44 处 repatch + 0025 六个带锦 hub 链；mark 成本=0。**两变体**：SUPERSEDED（真过时/代码可复现：0006、0019）vs 机制存档/PENDING-INGEST（载不可代替 rationale 或仍活跃：0010、0015、0018、0021、0025）。原路径/标题不动 → 零断锦/零 patch/无重定向桩。物理移动到 `docs/archive/adr/` 推迟到 abrain ingest lane 落地。
   - **reclass 发现（Opus Dissent 2 + DeepSeek Dissent A/B）**：0025（及 0021）被错分类——是被 0027(KEEP)/0028 引用的**活跃设计**（§3.1/3.2 约束分层、§3.2.A 放宽 0003 三选项、§4.1.4 conf<8 盲区等 0024 无的独立决策），读起来像 SLIM-12。因处置统一为 mark-in-place，bucket 标签已无关执行，给机制存档 marker 即可。
4. **剥代码镜像（任务 B）**：current-state.md + architecture/* + 0014 commit-status 头→收敛为"代码派生"。docs-doctor 的 no-bare-hash + 扩展计数 检查把关。
   - **D-B 解**：current-state §2.1 扩展表保留「名字+surface+shipped/not 二态」，删实现声明/计数/commit；不要裸删导致一眼地图消失。
5. **重指 adr/README.md 锚点中枢**（§9/§10 表 + 所有 archived 锚点→archive 路径）。
6. **收尾**：STRICT=1 跑 docs-doctor 须绿；写 feature-changelog Phase-2 条目；建 `docs/archive/adr/INGEST-QUEUE.md` 供 sediment。

## 2.5 Strip manifest（current-state + architecture/* + directory-layout，3×T0 收敛——逐文件执行依据）

**总则**：逐块 CUT（纯代码镜像：计数/文件清单/commit/file:line/shipped-pending 表） / KEEP（方向/契约/不变量/取舍） / CONVERT（需要的操作地图→派生指针）。标准指针句式（GPT）：「Derived fact — not mirrored here. Canonical: <source>. Derive: <cmd>. Rationale: <ADR/REQ> 或 memory_search("...")。」

**current-state.md（存活为薄指针页，不删——删会断链）**：KEEP §4 绑定契约 + §9 文档治理 + 标题入口句；CUT §1.1 增量、§10 prompt_user ship-status及§198-203 hash；其余 CONVERT（§2.1 扩展表→名字+surface+shipped 二态一眼地图，Opus 已给替换文；§5/§6/§7 保留契约不变量（no-grep-fallback/single-writer/redaction 不可逆/vault_release 授权/可移植身份取舍），删 file:line 与 ship 明细）。

**architecture/*（DeepSeek 逐块表）**：overview §6 roadmap 表 CUT、§3 extensions 树 CONVERT，其余多 KEEP；abrain §2 zone 状态表/§8 roadmap CUT、六区拓扑+§7 六不变量+§6 git 边界 KEEP；memory §3 schema/§4 两段 rerank CUT/CONVERT、五核心契约+no-grep+status 语义 KEEP；sediment §2 pipeline 图/§4 路径表/§5 lock CUT/CONVERT、唯一写入者+secret 边界+sub-pi KEEP；vault §3 file:line/§8 shipped-pending 表 CUT、fail-closed/授权/注入契约/4-candidate 顺序 KEEP。

**强制 CONVERT 指针（C1-C10，防 ingest gap 期操作知识失联）**：memory/schema.ts、sediment/{pipeline,writer,kind-router,lock}.ts、abrain/{backend-detect,zone-registry}.ts、vault-bash.ts、UPSTREAM.md、roadmap.md。

**directory-layout.md（GPT）**：所有文件树/扩展清单/smoke 计数 CUT→`find extensions -maxdepth 1`/`npm pkg get scripts`/`find ~/.abrain`；KEEP 仅依赖边界规则 + vendor read-only + cwd-keyed history 方向。

**docs-doctor 漏检（GPT）**：shipped/pending 表、`file.ts:<line>`/`~L<line>`、assertion/smoke 计数、fenced 块内文件树 — 本 pass 手工 strip；可选扩 migration-WARN 检查（不全禁 fenced 图避免误报）。strip 后 purge 裸 hash → `STRICT=1` 升 ERROR。

**待人类偏好（DeepSeek U4）**：vault.md §2 路径列是保留为"canonical layout"（路径是 gitignore/0600 安全契约的一部分）还是转叙事句去路径——倾向 KEEP-as-canonical（路径本身是安全面契约）。

## 3. Spun-out ADR（abrain 侧，主会话不可执行，独立立项 — Kimi 主笔）

> ✅ **已落为 [ADR 0034](../adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md)（Proposed）**。下面是原始 handoff 契约，已被 0034 正式化。

**标题**：ADR — abrain mechanism-ingest + direction-impact annotation + rationale rendering。

**三块缺口**：(i) source-aware sediment ingest lane（现有 /memory migrate 只迁 .pensieve；Lane A 显式 MEMORY 不适合源文件批量；一份 ADR 应**分解**为多条 decision/pattern/anti-pattern/fact/smell/maxim 短 entry，带 derives_from=路径#标题@SHA）；(ii) `direction_impact` 注解（entry 上记触碰了哪条 INV/REQ + supports|depends_on|touches|narrows|weakens|conflicts + escalation 状态）；(iii) rationale 渲染路径（按 query/slug 渲"为何这样设计/被拒方案/证据/置信缺口"，**缺失必须报缺失不可幻觉**）。

**handoff 契约**：inputs=活动绑定+源 ADR 清单+方向/机制 split 标记+源 SHA；outputs=分解后的 typed entry+direction_impact+审计+ingest 报告+渲染/审计模式；acceptance=无主会话直写/有 dry-run/有 provenance/ADR 被分解/kind-status 合法/direction-impact 可查/escalation 被浮现而非静默接受/渲染缺失显式/archive-safe/secret 边界保留。**依赖**doc 侧 split 先产出稳定源集+标记，但不要求 docs 继续承载机制 prose。**时序**：archive 可先于 ingest（只要保留源路径/SHA）；但"整体完成"不可早于 ingest+渲染验证。

## 4. docs-doctor 当前 worklist（迁移期 WARN，逐步清零 / 收尾 STRICT 升 ERROR）

- **commit hash 残留**（REQ-006）：current-state.md §198-203、roadmap.md 多处、0032 §158 → 任务 B / 抽取时清。
- **8 条真断锚**（非 slugger 误报，已验证）：adr/README.md→0027 `#c1-双-invariant...`/`#c3-认知层...`（手工清理过的锚点丢了 `—`/`+`/`/` 产生的双连字符）、0026/0024/0025 部分；0014→brain-redesign-spec `#35-deterministic-router`/`#640-vault-执行者`（标题已不存在）；vault-bootstrap 锚点。→ §5 重指锚点 + 抽取改 0027 标题时一并修。
- **frontmatter 缺失**：全量（迁移期 advisory）→ 抽取/瘦身时按极简 frontmatter（doc_type/status[+canonical_for]）补，再 STRICT 升级。
- **hardcoded 计数**：0033 §169「8 tool」等 → 改代码派生表述。
