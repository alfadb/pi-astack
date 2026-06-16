---
doc_type: review-evidence
status: verified-no-change
created: 2026-06-16
gate: cross-vendor verification (goal g-eaaa09e1, task A2) — 2 cross-vendor T0 (opus-4-8 + deepseek-v4-pro) both CONFIRM-NO-CHANGE (see §5)
---

# A2 验证证据包:大库写入时去重的「全库 bypass」已修(无需改码)

## 结论(待独立核实)

A2 的目标 bug —— sediment 写入时去重 search 用 `status:["all"]` 从后门回退**全库 full_body**(大库每轮每 candidate 一次 ~915K token、cache=0)—— **在 A2 之前已被 P7(ADR 0035)+ ADR 0037 profile facade 彻底修复**。本次 A2 是**核实**,**不需要改码**。下面是证据;请独立验证有无我漏掉的残留 bypass。

## 证据链

1. **策展器去重已走 profile**:`curator.ts:1065` `runMemorySearch("sedimentDedup", ...)`。`sedimentDedup` profile(`search-profiles.ts:55`)= `status:["all"], limit:5, searchOverrides → dedupChunk0Aggregation:true`。不再手搓 dedupSettings。

2. **P7:`selectStage0Pool` 对 `status:["all"]` 无全库回退**(`llm-search.ts:722-805`)。非-active 查询走有界 hybrid:dense(active 索引)+ sparse(全 corpus 扫但只产 slug 命中)+ stale(仅可索引集)。唯一 `return null → 全 corpus` 是**嵌入未配置**(line 730;现已配置/ON)。熔断(dense 不可用→sparse-only)与 sparse 空(→ `poolLimit` recency 采样)两条 fallback **都有界**("禁全库 full-body")。

3. **全部 search 内核调用方已审计**,无一绕过 facade:curator→sedimentDedup、correction→correctionSearch(active,limit10)、decide→decideSearch(active,limit8)、pathA→pathAInject(active)、tool→toolSearch。无裸 `llmSearchEntries(` 调用(见证据 4 的结构守卫)。

4. **两道确定性回归守卫,均绿**:
   - `smoke:stage0-nonactive`:断言 `status:["all"]` 走 stage0 缩候选、不可索引集不塞 stale —— 输出 "全库 full_body 漏洞已堵"。
   - `smoke:search-profiles`:断言 `dedupChunk0Aggregation` 强制 true(全局 flag 漏不进);**并扫描 extensions/ 全部 .ts、禁止任何裸 `llmSearchEntries(`/`__oracleKernel` 调用**(强制唯一入口 = `runMemorySearch(profile)`)。

## 残留 / 范围说明

- **bypass 本身:无残留**。P7 让**任意** `status:["all"]` 查询(不止 sedimentDedup)都在内核被收成有界候选 —— 是结构性堵死,不是单 profile 打补丁。
- `oracle:dedup-p5b` / `oracle:dedup-neardup` 是 **live-LLM / scratch-index 的评测 harness,不是回归门**;本次一个命中瞬时 LLM 错误、一个因缺 scratch 索引 SKIP,均与 A2 无关(A2 未改任何码)。
- **范围外(本次不做)**:全局 `dedupChunk0Aggregation` 默认 false、靠 profile override 钉 true。未来若新增 `status:["all"]` 的 profile,它仍会被 P7 收成有界(**bypass 安全**),但可能漏掉 chunk0 聚合(那是 **false-merge 质量**问题,与"全库 bypass"是两回事)。可作为独立的小型不变式守卫(每个 status:all profile 强制 chunk0),不归 A2。

## 给验证者的问题

1. 有没有**任何** search 内核调用方(curator/aggregator/lint/doctor/decay/resurrection/coverage 等 sidecar)从后门回退全库 / 绕过 profile facade,是我漏审的?
2. `selectStage0Pool` 在 `status:["all"]` 下是否真的没有全库 full-body 路径(除嵌入未配置)?
3. 两道回归守卫是否真的锁住该不变式(不是表面绿)?
4. "A2 无需改码"这个结论成立吗?还是确有该补的码?

## 5. 验证结果(2026-06-16,2 家跨厂商 T0)

opus-4-8 + deepseek-v4-pro,各自独立读码 + 跑 smoke:**两家均 CONFIRM-NO-CHANGE**。

- `selectStage0Pool` 全路径枚举(deepseek):唯一全库路径 = 嵌入未配置(`return null`,line 730);hybrid / 熔断 sparse-only / 空-sparse recency 采样 / stale(仅可索引集)/ 安全网扩召(≤400)**全部有界**。
- 5 个调用方全经 `runMemorySearch(profile)`;extensions/ **零裸 `llmSearchEntries(` / `__oracleKernel` 调用**(grep-guard 确认);aggregator/decay/resurrection/lifecycle 等 sidecar 根本不触检索内核。
- 两家都读了断言(非看 banner):`smoke:stage0-nonactive`(pool=400≤maxCand 1290、不可索引 55 probe 零入池、非 active 经 sparse 召回)+ `smoke:search-profiles`(chunk0 强钉 + grep-guard)均**真锁不变式**。
- 诚实 caveat(两家一致,非残留 bypass):嵌入未配置 OR `stage0Enabled=false` 仍走全库 full_body — 但那是全局降级/kill-switch 态、对 5 个 profile 一视同仁、与 `status:["all"]` 无关,生产配置(嵌入 ON、stage0Enabled 默认 true)下不复活 A2 bug。

**结论**:A2 验证关通过,无需改码。bug 在 A2 前已被 P7 + ADR 0037 结构性堵死。
