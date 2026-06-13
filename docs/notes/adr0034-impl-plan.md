# ADR 0034 实施计划（living plan — abrain mechanism-ingest + direction_impact + rationale 渲染）

> 本文是 goal 的 living planning document（per goal-doc pattern）。每阶段推进就地更新勾选。
> ADR 源：[`docs/adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md`](../adr/0034-abrain-mechanism-ingest-and-rationale-rendering.md)（**Accepted** 2026-06-13，3×T0 一致 RATIFY WITH REVISIONS，修订集已并入）。

## 目标

实现 ADR 0034 定义的三块 abrain/sediment 侧能力，解锁 Phase-2 的"物理瘦身/归档"与 `README.md` §4 承重墙（按需渲染 rationale）：

1. **source-aware ingest lane**：按清单把 ADR 机制正文**分解**为多条 typed entry（一份 ADR ≠ 一条），带 `derives_from = 源路径#标题@SHA` + provenance + timeline；`--dry-run` 出 manifest → `--go`。
2. **`direction_impact` 注解**：entry schema 新增"触碰哪条 INV/REQ + relation + escalation"结构字段，`narrows/weakens/conflicts` 强制 `escalation=required` 且产人类可读提案（承重墙返回路径的结构化落点）。
3. **rationale 渲染路径**：按 query/slug 渲染审计用 rationale（短答 / 为何设计 / 被拒方案 / direction_impact / 证据 / 置信缺口）；**记忆缺失时显式报"无此 rationale"，绝不幻觉**。

## 门控原则（硬约束，贯穿全程）

- **G1 ratify-first**：ADR 0034 现为 Proposed。按项目一贯协议，**实现前先跨厂商 T0 评审收敛 → Accepted**（或按反馈修订再 ratify）。未 ratify 不进 Phase 1 编码。
- **G2 主会话不能写 abrain memory entry**（ADR 0003）：主会话**可写 ingest lane 的代码**（extensions/sediment|memory，是普通软件开发）；但**真正写入 `~/.abrain/`** 必须经 sediment lane 这条合法写路径，由用户显式发起（镜像 `/memory migrate --go`）。Phase 1-3 全程用 sandbox fixture + dry-run 验证，**不动真实 ~/.abrain**；真实 production ingest 是 Phase 4 单独 go/no-go。
- **G3 决策点 T0 门控**：每个有设计自由度的决策点（schema 落点、lane pipeline、渲染集成方式）先拉跨厂商 T0 收敛再落地，镜像 Phase-2 协议。
- **G4 每阶段 smoke 双向锁定**：新行为配 smoke + negative test（删 assertion 能 fail-fast），镜像现有 `smoke:memory` / `smoke:memory-sediment` 纪律。

## Phase 0 — Ratify ADR 0034（跨厂商 T0，纯设计，无代码）

**做法**：3×T0 盲审 ADR 0034 设计 + 交叉辩论收敛。审题：

- 三能力分解是否完备/正交？是否有第 4 块隐性缺口？
- `direction_impact` **schema 落点**：frontmatter（利查询，schema 改动）vs body 段过渡 vs 二者混合——哪个先落？（§5 张力）
- ingest lane 能否**建在现有 `writer.ts` 上**，而非硬等 ADR 0025 稳态 curator 管线？（注：ADR 0025 实为 status=accepted）解耦边界在哪？
- 一次性迁移 ingest vs INV-IMPLICIT-GROUND-TRUTH 的"显式有界例外"论证是否站得住？provenance 标记 + Tier-2 入库是否足够隔离？
- 分解粒度由 curator 判断的失控风险（走偏信号 #1 整篇 dump）——dry-run manifest 是否足以兜底？
- acceptance ⑨（archive-safe）与 §3 时序（archive 可先于 ingest）是否自洽？

**产出**：T0 收敛结论 → ADR 0034 改 `Accepted`（或带修订项再 ratify）；记录决策到 feature-changelog；更新本 plan 的 Phase 1-4 设计参数。

- [x] 3×T0 盲审 dispatch（opus-4-8 / gpt-5.5 / deepseek-v4-pro）
- [x] 收敛：**三路一致 RATIFY WITH REVISIONS**（无 NEEDS REWORK；仅 §3↔⑨ 时序 severity 上 GPT=P0 / opus+ds=P1，修法一致，无需第 2 轮）
- [x] ADR 0034 → **Accepted**（9 处修订已并入）+ feature-changelog 记录
- [x] 锁定 Phase 1-4 设计参数（见下）

**收敛的修订集（已入 ADR）**：(1) §3 时序拆“保 SHA+收残桩可先” vs“物理删 prose 须在 ingest+渲染验证后” + ⑨ 加验证步；(2) direction_impact = **flat frontmatter**（非嵌套/非 body-only）；(3) provenance 用 AX-PROVENANCE 枚举 assistant-observed/content-in-transcript（`migrated-from-mechanism-docs` 降为 timeline marker）；(4) ADR 0025=accepted，仅复用 sanitizer+writer；(5) dry-run 加 coverage/stats；(6) git reset --hard pre-SHA 回滚；(7) 禁写 rules zone；(8) 渲染带 pinned SHA；(9) staleness re-sync 归后续 ADR。

## Phase 1 — `direction_impact` schema（代码 + smoke；最小、基础）

**做法**：按 Phase 0 落点，给 memory entry schema 加 `direction_impact` 结构（`ref` + `relation ∈ {supports,depends_on,touches,narrows,weakens,conflicts}` + `escalation ∈ {none,required,proposed,accepted,rejected}` + `proposal_ref`）。改 `extensions/memory/parser.ts`（解析）、`extensions/sediment/validation.ts`（枚举校验）、`extensions/memory/doctor.ts`（`weakens/conflicts` 必须 `escalation≠none` 的 lint）。`PROTECTED_FRONTMATTER_KEYS` 视情况纳入。

**acceptance**：⑥direction_impact 可查；⑦escalation 浮现而非静默接受（doctor 红线）。

- [x] schema 落点已定（Phase 0）：**flat frontmatter 编码**（非嵌套 map：`parser.ts:254` 跳缩进行；非 body-only：违反 ⑥ 可查）；direction_impact 非 `sediment/writer.ts:478` PROTECTED_FRONTMATTER_KEYS 故透传
- [x] leaf 模块 `extensions/memory/direction-impact.ts`（parseDirectionImpact，总函数/不抛；pipe 编码 `<relation> | <ref> | <escalation>[ | <proposal>]`）
- [x] parser 填 `MemoryEntry.directionImpact`（可查 ⑥）+ types 加字段
- [x] 读侧 lint.ts `D1 direction-impact`（doctor 经 lintTarget 捕获）+ 写侧 sediment/validation.ts validateProjectEntryDraft
- [x] `narrows/weakens/conflicts → escalation≠none` 红线（读写两侧同一总函数，不漂移）
- [x] `smoke:direction-impact` 32 assertions（双向 negative：红线违反必出 error）+ smoke:memory 回归绿

## Phase 2 — source-aware ingest lane（代码 + smoke）

**做法**：新 lane（建议 `extensions/memory/ingest-adr.ts`，复用 `migrate-go.ts` 的 index rebuild / git rollback / sanitizer / strict-binding 模式）。输入：ADR 清单 + 章节 split 标记 + 源 SHA。`--dry-run` 出 manifest（每条：compiled truth/kind/scope/status/confidence/derives_from/timeline）→ 确认 → `--go`。**分解**而非整篇 dump；每条 `derives_from = path#heading@SHA`；provenance 标 `migrated-from-mechanism-docs`，入 **Tier-2**。

**acceptance**：①无主会话直写；②dry-run；③每条有 derives_from；④分解无整篇 dump；⑤kind/status 合法；⑩secret 边界（走 sanitizer）。

- [x] lane 核心 `extensions/memory/ingest-adr.ts`：`planIngest`（纯，出 manifest + coverage + 分解 stats/flags）+ `buildIngestEntryMarkdown` + `runAdrIngest`（dry-run/go）
- [x] provenance=content-in-transcript（AX 枚举，机械非 Tier-1）+ timeline marker migrated-from-mechanism-docs + **source_ref 存 path#heading@SHA**（避开 derives_from 图链冲突）+ strict-binding（projectDir 必存，不靠 --project）
- [x] sanitizer 接线（⑩ secret 边界：sanitize 失败 withhold）+ git reset --hard pre-SHA 回滚 + index rebuild + ingest_adr 审计
- [x] decomposer **注入可测**（生产接 LLM 分解 prompt；smoke 注入 stub）——认知层走 prompt，无机械准确率门
- [x] `smoke:adr-ingest` 40 assertions（sandbox 临时 abrain git repo，不动真实 abrain；dry-run 不写 / go / 红线 skip / secret 脱敏 / withhold / 回滚删部分写入）
- [x] （Phase 4 prep）decomposer 核心 `extensions/memory/adr-decomposer.ts`：分解 prompt（AI-Native，要求拆分 + coverage self-report + 红线 escalation）+ `parseDecomposerResponse`（总函数，解 JSON→AdrSource）+ `decomposeAdr`（注入 llmCall）；`smoke:adr-decomposer` 22 assertions
- [ ] （Phase 4 prep 剩）live 命令注册 `/memory ingest-adr` + 接 ctx.modelRegistry 的生产 llmCall（薄集成，需 pi runtime）——真实写入需用户 go/no-go（G2）

## Phase 3 — rationale 渲染路径（代码 + smoke）

**做法**：扩 `extensions/memory/decide.ts` 或新渲染路径，按 query/slug 输出审计 rationale（短答 / 为何设计 / 被拒方案 / direction_impact / 证据[slug + ADR#标题@SHA + 代码符号] / 置信缺口）。**硬约束**：记忆缺失输出"abrain 无此 rationale；仅 git/docs/代码证据"，绝不幻觉。

**acceptance**：⑧渲染缺失显式报缺失（绝不幻觉）。

- [x] 渲染路径 `extensions/memory/rationale.ts`：`renderRationaleFromEntry`（纯，只格式化存储数据）+ `renderRationale`（async，注入 resolver）+ `formatRationale`
- [x] **missing-not-hallucinated 硬约束**：entry=null/resolver 抛/resolver 返 null → found=false + 显式“Do NOT fabricate…” fallback；未记录的节（被拒方案/source_ref）报 honest gap 不发明
- [x] 渲染带 pinned source_ref SHA（修订 #8）+ grounding（渲染文本是 body 子串，assert 验证）
- [x] `smoke:rationale` 29 assertions（缺失必报缺失 + 不幻觉 + pinned SHA 浮现 + honest gaps + async resolver）

## Phase 4 — production ingest + archive 解锁（go/no-go 门控；触碰 G2）

**做法**：能力全绿后，用户显式发起对真实 12 SLIM + 7 ARCHIVE ADR 的 ingest（经 sediment lane 合法写路径）。验证 rationale 经 abrain 可得（satisfies acceptance ⑨）后，才物理瘦身/归档 mark-in-place 的机制正文，ADR 收成方向残桩。

**acceptance**：⑨archive-safe（ingest 后 rationale 可得才允许物理移走 prose）。

- [x] 能力全绿（Phase 1-3 smoke pass：direction-impact 32 + adr-ingest 40 + rationale 29 = 101 assertions，smoke:memory 回归绿）
- [x] **用户显式 go/no-go**（2026-06-13 授权全量 + 物理瘦身 + 分批）；migration runner `scripts/run-adr-ingest.mjs` + verifier `scripts/verify-rationale.mjs`（经真实 sanitizer + lane 写真实 ~/.abrain，git 可回滚）
- [x] production ingest（分批：decompose via dispatch → dry-run 自查 → --go → verify）：**全 17 个 ingest ADR 完成**（12 SLIM = 0026/0001/0003/0009/0013/0016/0032/0017/0020/0028/0022/0023 + 5 机制存档 = 0010/0015/0018/0021/0025）；pi-global 911→1167（+256 entries，6 批 abrain commit 链可回滚）；superseded（0006/0019）按 SUPERSEDED 变体只标 archived 不 ingest。
- [x] rationale 可得验证 → 物理瘦身 → 方向残桩：**全 17 ADR ✅**（每个经 verify-rationale found=true + pinned `source_ref` SHA 后才 slim；含 0025 conf<8 红线 escalation 可得）；原 prose git @627de33；STRICT docs-doctor 全程绿（0025 保留 6 个 README 入链 §4.x 锚点）。
- [x] Phase-2 "整体完成" 达成（全 19 机制 ADR：12 SLIM + 7 ARCHIVE 处置完毕）

## 不变量（ADR 0034 §4，全程守）

- INV-MAIN-SESSION-READ-ONLY：durable 写经 sediment lane，不给主会话开 ingest 写工具
- AI-Native：分解 / direction_impact 分类 / 渲染都是认知层，走 prompt，不加机械准确率阻断门；manifest/provenance/审计/schema 是 infra 层走 structured
- provenance 门控：ADR 机制是 assistant/file provenance → 一律 Tier-2，永不冒充 Tier-1 用户指令
- secret 边界：复用 sediment sanitizer；sub-pi 不作 writer

## 边界 / 非目标

- 不在主会话直写 ~/.abrain（Phase 1-3 全 sandbox/dry-run）
- 渲染 prompt 的具体措辞、schema 字段最终形态由实现按 AI-Native 权衡（ADR 0034 §7 划为实现细节）
- 不硬等 ADR 0025 稳态 curator 管线：ADR 0025 status=accepted，本 ADR 仅复用其 sanitizer + writer 基建（Phase 0 裁定）；ingest lane 不 import curator.ts/multi-view.ts/staging-*。
