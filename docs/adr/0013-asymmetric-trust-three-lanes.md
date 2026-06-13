---
doc_type: adr
status: accepted
---

# ADR 0013 — Asymmetric Trust 三段式（LLM / explicit / promotion）

> 📐 **方向已上提承重墙（Phase-2 SLIM，3×T0 Model B）**：本 ADR 的 trust × 影响半径原则已上提 `direction.md` §1（信任×影响半径），以那里为 canonical。以下机制正文（含 Lane D gate / Q-table 等不可代替 rationale）**待 sediment 入 abrain 后归档**，之前保留可读、勿删。

> ⚠️ PARTIALLY HISTORICAL：trust × blast radius 思想仍有效；Lane B/D promotion 和 Lane C 旧机械 gates 已被 ADR 0014/0016 取代，主体中的相关实现计划仅作历史参考。

- **状态**: **Accepted (partially superseded by [ADR 0014](0014-abrain-as-personal-brain.md) §D3 + [ADR 0016](0016-sediment-as-llm-curator.md))**。2026-05-08 原状态 "Accepted"，2026-05-11 反映 supersede 范围明确化。
  - **Lane B / Lane D 被 ADR 0014 §D3 失效**（2026-05-09）——abrain 七区拓扑下不再有「project → world promotion」概念（所有写入直接定位到对应区域）。
  - **Lane C 的 G2-G13 / readiness / rolling / rate / sampling 机械 gate 被 ADR 0016 删除**（2026-05-10），转向 direct LLM curator + sensitive-info/storage gates。
  - **原 Lane A（explicit MEMORY）仍然生效；原 Lane C 名字保留但内部机制重写（LLM curator）**。ADR 0014 §D3 在之上新增 Lane G（about-me declare）+ Lane V（vault declare，不走 sediment IPC）。Trust tier 概念本身仍然是下面设计的基本盘，但具体 Lane B/D/C-gate 描述请参考 supersede source。
- **日期**: 2026-05-08
- **决策者**: alfadb
- **依赖**: [memory-architecture.md](../memory-architecture.md) §8（sediment pipeline）/ §9（promotion）
- **被引用**: [`archive/migration/phase-2.3-promotion-gates.md`](../archive/migration/phase-2.3-promotion-gates.md) §1（historical）
- **触发**: 2026-05-08 Phase 1.4 LLM auto-write lane 首日 burn-in

## 背景

Phase 1.4 把 sediment 从"显式 `MEMORY:` block 同步写入"扩展为"在显式 miss 后调度 LLM bg promise 自动 extract + 写入"。第一天 6 次 fire 共 14 候选，落盘 12 条，**经手动 prune + G13 dedupe 后留存 7 条**。失留率 ~50%，主要原因：

1. **`reason-combinations` slug 截断**：title 含 `/` 时 `normalizeBareSlug` 把 `/` 当 path 分隔符，slug 丢失上文。
2. **transient observations 被错记**：「audit-trail-schema-restart-verification」是当下时刻的运行时事件，6 个月后无意义。
3. **同一洞察的 paraphrased 双 entry**：`normalizebareslug-breaks-on-...` + `normalizebareslug-must-not-be-used-for-...`，word-trigram = 0.000 但语义相同（→ G13）。
4. **LLM 偶发输出 maxim/active 状态**：把 `confidence: 8 + status: active` 直接写就把"权威 entry"权交给了 LLM。

教训抽象：**LLM 自动写入需要远比假设的更多 guard rails**——不是模型不够聪明，是 prompt + LLM 永远是 best-effort approximation，多个 lane 的失败模式不同，**用统一 gate set 既不够、又会过度束缚**。

同时观察到：**用户亲手在对话里输入 `MEMORY: ... END_MEMORY`** 的写入路径完全没有这些质量问题——用户已经通过物理键盘动作背书了内容，再叠加内容验证就是侮辱用户。  
而 Phase 2.3 设计稿里的 `/sediment promote <slug>` 又是另一类——**用户主动**但**目标是 world store（跨项目永久知识）**，blast radius 比 project store 大一个数量级。

→ 显然需要对**同一个 writer plumbing** 提供**三套不同强度的 gate**，而不是合并为一套。

---

## 决策

**Sediment 写入路径正式分为三个 trust lane，每个 lane 配一组 gate：**

```text
                       blast radius
                       ↓ low (project)        ↓ high (world)
    high trust   ┌──────────────────┬─────────────────────────┐
    user-typed   │  Lane A           │       (forbidden)        │
                 │  explicit MEMORY: │   no direct user→world   │
                 │  hard validation  │   write path             │
                 ├──────────────────┼─────────────────────────┤
    middle trust │  (degenerate)    │  Lane B                  │
    user-invoked │   user-invoked   │  /sediment promote       │
                 │   to project ≈ A │  Gate 1-5 enforced       │
                 ├──────────────────┼─────────────────────────┤
    low trust    │  Lane C          │  Lane D (historical)     │
    LLM bg       │  bg LLM lane     │  auto-promote based on   │
                 │  curator +       │  confidence × citations  │
                 │  redaction       │  Gate 1-5 + readiness    │
                 └──────────────────┴─────────────────────────┘
```

| Lane | 触发 | 目标 store | Gate 集 | 当前状态 |
|---|---|---|---|---|
| **A — explicit MEMORY:** | 用户在对话里输入 `MEMORY: ... END_MEMORY` block | project `~/.abrain/projects/<projectId>/` | validation + sanitizer typed redaction + lint/storage gates | ✅ 已实现 |
| **B — manual promote** | 用户手动调 `/sediment promote <slug>` | world `~/.abrain/` | Gate 1-5（去上下文化 / 跨实例 / 反例 / 冷却 / 冲突）| ⛔ historical，设计稿已归档 [`phase-2.3-promotion-gates.md`](../archive/migration/phase-2.3-promotion-gates.md) |
| **C — LLM auto-write bg** | sediment agent_end 在显式 miss 后调度 bg promise | project/world/workflow abrain zones（由 curator/writer 路由；**2026-05-31 实测**：当前 Lane C 实际只写 `projects/<id>/` + world `knowledge/`，workflow 等其余区 future-proof 未启用，见 `sediment/index.ts:347-364`；workflow-lane neighbor 在此路径是只读引用非 Lane C mutation 目标） | **ADR 0016 + 2026-05-15 sanitizer 修订后**：pre-LLM typed redaction + LLM extractor + ADR 0015 `memory_search` lookup + curator lifecycle ops；safety/storage gates 仅 sanitizer plaintext boundary + schema/lint/exact slug collision/lock/atomic write/audit/git。旧 G2-G13/readiness/rolling/rate/sampling 已删除。 | ✅ 已实现 |
| **D — LLM auto-promote** | confidence × citations 指标自动触发 | world `~/.abrain/` | Gate 1-5 + Lane C 全套 + 额外 readiness | ⛔ 不实现（Phase 5+ 评估）|

### 关键不变量

1. **Lane B 不退化为 Lane A**：即使用户手输 `/sediment promote`，目标是 world，blast radius 仍要 Gate 1-5 保护。"用户亲自调用"不能豁免 cross-project verification。
2. **Lane D 永久禁用直到 Phase 5+**：写到 world 的非用户自动路径风险过大。Phase 1.4 burn-in 留存率 7/12 是 project 级的；world 级要求几个数量级更高。
3. **Lane A 不收紧**：不要因为 Lane C 的失败教训去给 Lane A 加 gate。用户已经物理输入 `MEMORY:` 是不可越过的 trust signal。  
   反例校准：今天合并 `normalizebareslug` 双 entry 时，G13 在 explicit lane 默认关闭——用户想手记一个改述就让他记。
4. **每个 Lane 的 safety/storage boundary 必须 ENFORCEABLE，不只是 prompt 描述**：ADR 0016 后 semantic gates（例如 `disallowMaxim`）已删除，改由 curator prompt 决策；但 credential plaintext boundary、schema、lint、path、lock、atomic write、audit 仍必须由代码强制执行。
5. **Override 机制是 ESCAPE HATCH，不是默认路径**：Lane B 的 `--override-X --justification "<text>"` 必须 audit 全文记录；不允许"快进"绕过。

### Trust × Blast 决定 Gate 强度

```
gate_intensity ≈ (1 - trust_factor) × blast_radius_factor

trust_factor:        explicit (1.0) > promote (0.6) > LLM (0.2)
blast_radius_factor: world (5)      > project (1)

⇒
  Lane A: (1-1.0)*1   = 0   → minimal gates
  Lane B: (1-0.6)*5   = 2   → Gate 1-5
  Lane C: (1-0.2)*1   = 0.8 → G2-G13
  Lane D: (1-0.2)*5   = 4   → Gate 1-5 + G2-G13 + readiness ⇒ 复杂度过高，Phase 5+
```

数字仅作启发；实际 gate set 由架构需求决定（不是数学）。

### Audit 字段必须暴露 lane

每条 sediment audit row 必须含 `lane: "explicit" | "promote" | "auto_write" | "auto_promote"`（最后一个目前不出现），便于：

- `/sediment llm-report` 按 lane 分组质量统计
- 跨 lane 横向对比留存率（Lane C 是 7/12 ≈ 58%，Lane A 应该接近 100%，Lane B TBD）
- 后续把这些数字当 SLO，Lane C 跌破阈值触发 G10 rolling 跳闸

### Settings 命名约定

每个 lane 的 settings 用 lane 前缀：

> ⚠️ **以下 Lane C settings 已被 ADR 0016 删除**（autoWriteDisallowMaxim / autoWriteMaxConfidence / autoWriteForceProvisional 等 G2-G13 gate 参数全部移除；curator LLM 决策替代机械门控）。本段仅作历史记录，**不要据此修改 settings.json**——这些 key 写进去也不会生效。

```jsonc
"sediment": {
  // Lane C (auto-write LLM bg)
  "autoLlmWriteEnabled": true,
  "autoWriteForceProvisional": true,
  "autoWriteDisallowMaxim": true,
  "autoWriteDisallowNearDuplicate": true,
  "autoWriteMaxConfidence": 6,
  // ...

  // Lane B (manual promote, Phase 2.3)
  "promotionCoolingDays": 3,
  "promotionRequireJustificationChars": 30,
  // ...
}
```

Lane A 没有 settings——hard validation 是不可调的。

---

## 后果

### 好处

1. **失败模式可定位**：audit 里 `lane` 字段直接说明这条 entry 是哪条路径；postmortem 不需要重建上下文。
2. **gate 演化解耦**：G13 加到 Lane C 不影响 Lane A；Phase 5 给 Lane D 加 readiness 不动 Lane B。
3. **用户认知清晰**：footer status FSM (`📝 sediment running: auto-write ...`) 已经隐式让用户感知 Lane C 在跑；Phase 2.3 footer 可加 `📤 sediment promoting: <slug> (Gate 3/5)...` 同款机制。
4. **覆盖文档**：`memory-architecture.md` §8.1 "主会话只读"原则在 Lane A 实际是"主会话只读 + 显式标记可写"；本 ADR 把这个例外正式化。

### 坏处

1. **代码路径分支增多**：writer.ts 里 `opts.policy` 已经是 lane 区分的代理；Phase 2.3 还要加 promotion-specific code path。复用 substrate 但分支判断会扩散。  
   缓解：保持 `validateProjectEntryDraft(draft, policy)` 的 single-source-of-truth 原则；新 gate 只追加 `DraftPolicy` field，不重写 schema。
2. **测试矩阵爆炸**：smoke 已含 Lane A + Lane C 各自正反；Phase 2.3 要再加 Lane B × 5 gates × pass/fail × override = ~30 cases。  
   缓解：把 gate 评估器（`evaluateDecontextualization` 等）写成纯函数，单元测试覆盖；integration 只测组合。
3. **trust 评级是主观的**：今天觉得 explicit MEMORY: 是 highest trust，明天发现用户复制粘贴 LLM 输出冒充手输怎么办？  
   缓解：sanitizer 仍在 Lane A 强制运行（jwt/pem/ip 等不可绕过）；trust 不等于"任何内容都接受"。如果未来发现 Lane A 漏洞再 ADR 0013-amend。

### 中性

- 与 ADR 0010 / 0011 / 0012 的关系：本 ADR 是**实施层**决策，不动那些**模型调用层 / 架构层**决策。0010 单 agent 内核、0011 双轨被 memory-architecture.md superseded、0012 双 target 同样被 superseded——本 ADR 在 memory-architecture.md 之上做实施细分。

---

## 实施现状

### 已落地（Lane A + Lane C）

| 组件 | 文件 | 提交 |
|---|---|---|
| Lane A explicit MEMORY: extractor | `extensions/sediment/extractor.ts`（fence-aware） | `68a14a0` |
| Lane A writer with hard validation | `extensions/sediment/writer.ts` + `validation.ts` | 多次迭代 |
| Lane C bg LLM extractor + parser | `extensions/sediment/llm-extractor.ts` | `e1541bb`（fire-and-forget UX）|
| Lane C G2-G13 gates | `validation.ts` `DraftPolicy` overlay + `dedupe.ts` G13 | `b0b6136 / 608ed79 / c06ae77` |
| Lane C audit raw_text + rolling gate | `report.ts` + audit operation `auto_write` | `608ed79` |
| Lane C footer FSM | `extensions/sediment/index.ts` `applySedimentStatus` | `166aa85` |

### 待落地（Lane B）

[`archive/migration/phase-2.3-promotion-gates.md`](../archive/migration/phase-2.3-promotion-gates.md)。该设计已被 ADR 0014 七区路由取代，保留为历史动机。

### 永久不落地（Lane D）

直到出现以下三个全部满足才开 Phase 5 评估：

1. Lane C 留存率（writes 留存到 30 天后）≥ 90% 且持续 3 个月
2. 用户 manual promote 的 audit 显示 ≥ 50% 是被自动 score 排在 top 5 的 candidate（说明评分算法靠谱）
3. 至少 2 个独立 ABRAIN store（多机/多用户）协同验证 cross-instance score

不满足任一 → Lane D 仍是 forbidden zone，文档明确写"未实现是设计选择，不是 backlog 待办"。

---

## 开放问题

| Q | 问题 | 当前答案 |
|---|---|---|
| Q1 | Lane A 是否需要 audit 行？ | 是。已实现（operation: explicit_extract）|
| Q2 | Lane C 失败时是否降级到 Lane A 提示用户手记？ | 不。失败 audit 即可，不打扰用户 |
| Q3 | Lane B 失败的 entry 进入"待处理 review queue"吗？ | 不入持久 queue。`/sediment promotion-status` 实时计算 |
| Q4 | Trust tier 是否暴露给 LLM 看？ | 不。Facade §5.4 原则下 lane 是 internal concern |
| Q5 | 是否提供 `/sediment trust-tier <slug>` 让用户查询某条 entry 来源 lane？ | 通过 `memory_get` 返回的 audit hint 即可，不另开命令 |
| Q6 | Override audit 是否需要二次确认（双 prompt）？| 不。`--justification "<≥30 chars>"` 已是 friction。再加确认框是 UI 噪音 |

---

## 参考

- 触发事件 commits（2026-05-08）：
  - `b0b6136` Lane C G2-G8 安全前置
  - `608ed79` Lane C G9-G12 接入 + audit raw_text
  - `e1541bb` Lane C fire-and-forget UX
  - `c06ae77` Lane C G13 soft near-duplicate
  - `166aa85` Lane C footer status FSM
- 历史设计文档：[`archive/migration/phase-2.3-promotion-gates.md`](../archive/migration/phase-2.3-promotion-gates.md)（Lane B，已 superseded）
- 架构主线：[`memory-architecture.md`](../memory-architecture.md)
