---
doc_type: notes
status: active
---

# ADR0039 flip 阶段授权（新闸门）— 多 T0 一致共识 R3（2026-06-21）

> 新闸门：phase 通过不构成下一阶段授权，flip 阶段须重走 unanimity（参与 T0：
> opus-4-8 / gpt-5.5 / deepseek-v4-pro / kimi-k2.7-code）。主会话主持不投票。
> **结论：D1 授权 4/4 SIGN、D4 不 HOLD 4/4。** 授权进入 flip 机械前置；P1 真 flip 仍须全绿后另证。

## 触发：coverage 前置（P4-a 数据侧）已完成并真实数据验证全绿

- 回填 242 active 顶层散落（Q1/Q2）+ 5 archive/→全文 L2 tombstone（A2/A3）；pi-global active-canonical 缺口 281→34。
- reconcile b0 coverage=1.0 / projected 3055；flip-probe 投影全胜+0 泄漏；reindex-ab kind/status 0% 丢失。
- 剩 34 legacy-only = staging24 + smell9 + `_index`1，全部 by-design 不在 active 读面。

## D1 授权（4/4 SIGN）

coverage 前置充分到授权进入 flip 机械前置。关键判断成立：34 legacy-only 全在 active 读面之外（staging/smell 被 memory_search 排除、`_index` 非条目），projection_only 不会让任何**用户可见 active** 召回消失——此"不可见"是 flip 前既存状态，非 flip 造成的回归。**A2 红条件（kimi）已化解**：opus 读码确认 `projectKnowledgeEvidenceEvent` 对 operation=archive（非 delete）写全文 `renderKnowledgeProjectionMarkdown` + status=archived（writer.ts:1755），与 28 条现存 + 5 条新增 archived L2 一致——go-forward tombstone 已落码工作。

## D2 次序（substance 收敛；A4/A5 微序非阻塞）

一致：A7 canary（先验真、证可逆）+ A6 install（探针就位）早做 → A5 read-error→fail-loud → A4 coverage 硬门**落码**（不可仅靠人工口径）→ P1 flip。**所有家一致：A4 与 A5 都必须在 P1 之前，且 A4 必须是真实 coded gate。** 唯一微分歧：gpt-5.5 主张 A4 在 A5 之前（避免"更响亮但门仍人工"的中间态），opus/deepseek/kimi 列 A4 在 A5 之后——非阻塞，gpt 的 A4-早 偏好记为更安全微序。opus + kimi 强调：A6 的"稳态 counter≡0"断言只在 A5 删静默 fallback 后才成立，故 A6 install 先行、稳态断言在 flip 同 PR 切。

## D3 flip GO-条件（收敛 + 1 个待结 nuance）

一致：**确定性绿充分放行；live memory_search 不在放行集**（空结果无法区分 flip 坏 vs rerank 空，已知 anti-pattern）。GO 套件（AND，全绿）：
1. reconcile b0 coverage=1.0（分母**从 L1 算**）；2. flip-probe 全胜+0 泄漏；3. reindex-ab 字段语义 diff 0；4. A4 coverage gate 落码且返回 PASS；5. A7 L1-only rebuild canary 哈希干净；6. A5 fail-loud 就位（单测证 read-error 抛错不回退）；7. A6 legacy-read tripwire 活跃。

**「修正分母=1.0」精确定义（一致）**：分母 = 从 L1 event-set 身份算，status∈{active,archived} ∧ kind≠smell ∧ 不在 staging ∧ 非 `_index` 的 active-canonical 身份数；分子 = 这些身份在 L2 有投影且字段级保真者。被扣除的 staging/smell/archive/_index 须经 envelope schema allowlist **显式枚举计数并落日志**（不得静默丢弃；扣除项写成 gate 代码常量，防未来扩展静默改写）。

**待结 nuance（不阻塞授权，flip 前定）**：是否在确定性绿之外**再加一道生产 shadow dual-read diff 窗口**（opus 主张，复用 `dualread-audit.ts` 先例，真实流量下并行算 projection_only 读面 vs legacy 读面、确定性 set+hash diff、N 次真实读 0 分歧、按调用数有界非墙钟——天然绕开 live-search 坑）vs **flip-probe 本身即有界 live 验证、无需额外窗口**（deepseek：flip-probe 已加载真实 scanStore+stable-view、绕过 rerank）。

## D4 不 HOLD（4/4）+ 采纳的增强

无 HOLD：现存红区（A4/A5/A6/A7 未码、parser.ts 两处静默兜底在线）正是前置工作本身，flip 已被正确 gate。采纳增强：
- A4 字段门补 `trigger_phrases` + `derives_from` 维度（deepseek：reconcile byte-compare 覆盖 L1→projection 但未覆盖 legacy→L1 提取路径）。
- A7 canary + A4 字段 diff **dossier 化周期复跑**（kimi：snapshot 通过不证连续写入仍通过）。
- A6 `legacy_cold_access` 独立 schema version，定期 audit 列非零月份触发走偏诊断。

## opus 现场读码红区（A5 当前真红的精确位置，供实施）

`parser.ts:844-862` 投影读取块被 `try{…}catch{/* canonical stores remain read truth */}` 包住，且 `if(readMode==="projection_only") stores.length=0` 在 try **内部**——稳态视图读取抛错→catch 吞→保留 legacy 全集=静默回退。第二处 `scanStore(...).catch(()=>[])`（line 866）非 abort 错误返回 []→该 store 静默贡献 0。两处都须纳入 A5 fail-loud。`canonicalReadMode` flip flag 在 `settings.ts:477`（默认 legacy）。A4 当前无代码 gate `canonicalReadMode`（`minCoverageRatio` 只 gate constraint 注入）。

## 边界

本闸门只授权 flip 机械前置工程；P1 真 flip 须 D3 GO 套件全绿 + 待结 nuance（shadow window）定后，按协议再确认。逐步、flag-guarded、真实数据验证，不一次性重写。
