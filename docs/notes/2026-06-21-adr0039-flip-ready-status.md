---
doc_type: notes
status: active
---

# ADR0039 flip-ready 状态（机械前置全绿）— 2026-06-21

> 本文是 R3 闸门授权（[`2026-06-21-adr0039-flip-phase-authorization-r3.md`](./2026-06-21-adr0039-flip-phase-authorization-r3.md)）下的 flip 机械前置实施收尾记录。
> **结论：A7/A6/A5/A4 全部落码 + 真实生产数据验证全绿；GO 套件 7/7 就位。P1 真 flip 未执行、本阶段不执行。**

## GO 套件状态（R3 D3，全部 ✅）

| # | GO 条件 | 状态 | 证据 / 提交 |
|---|---|---|---|
| 1 | reconcile b0 coverage=1.0 | ✅ | `reconcile:adr0039` b0_coverage_ratio 1.0000（legacy→L1） |
| 2 | flip-probe 投影全胜 + 0 泄漏 | ✅ | `dossier:adr0039-phase-c-flip-probe` PASS |
| 3 | reindex-ab 字段语义 diff 0 | ✅ | `dossier:adr0039-reindex-ab` kind/status 0% |
| 4 | **A4** coverage 硬门落码 + PASS（L1-derived 分母） | ✅ | `gate:adr0039-flip-coverage` PASS：active 1.0000(2784/2784) + archived tombstone 1.0000(33/33) + 字段保真 0 mismatch(2738) + allowlist 扣除显式枚举（smell=1/other_status=238）。提交 `b7e0c4f` |
| 5 | **A7** L1-only rebuild canary 哈希净 | ✅ | `dossier:adr0039-l1-rebuild-canary` 3056 byte_match / 33 archived tombstone / 0 diff。提交 `d0d8de8` |
| 6 | **A5** read-error fail-loud 就位 | ✅ | parser.ts 两处静默兜底改响亮 + projection_only throw。提交 `9f21651` |
| 7 | **A6** legacy-read tripwire 活跃 | ✅ | `getLegacyColdReadStats()` + projection_only anomaly 响亮 + smoke 守护。提交 `8a952bc` |

机械前置全部 additive/可逆，**current 模式零行为变更**（A5/A6 的 fail-closed/throw 仅 projection_only 触发）。两仓提交干净。

## A4 gate 设计要点（满足 R3 收敛定义）

- **分母从 L1 算**，非 legacy 文件数 / L2 数（避免循环自证，R3 opus/kimi）。
- 两条覆盖均 1.0：active（用户可见读面）+ archived tombstone（ADR0031 复活面，R3 opus/kimi 调和）。
- 扣除项 = **code 常量 allowlist 显式枚举 + 落日志**：`EXCLUDED_KINDS={smell}`、`EXCLUDED_SLUGS={_index}`、非 active/archived status（other_status）、render=delete。staging 结构性不在 L1（backfill skip smell→staging）仍被断言。
- **字段保真闭合 deepseek 缺口**：legacy_import 身份的 trigger_phrases/derives_from/kind/status 对比 legacy 源——reconcile 的 L1→L2 byte-compare 与 A7 的 L1-only rebuild 都看不到 legacy→L1 **提取** bug，本门补上。实测 2738 checked / 0 mismatch。

## P1 flip 之前仍未决（不在本阶段）

**P1 真 flip（`canonicalReadMode=projection_only`，settings.ts:477，默认 legacy）未执行，本 goal 硬边界禁止执行。** 授权 P1 前还差：

1. **shadow-window nuance（R4 待定）**：确定性绿之外是否再加一道生产 shadow dual-read diff 窗口——opus 主张加（复用 dualread-audit.ts，真实流量 set+hash diff、N 次读 0 分歧、按调用数有界非墙钟），deepseek 主张 flip-probe 本身即有界 live 验证、不必加。**这是 P1 授权前唯一未达全体一致的点，须 R4 快速定。**
2. **用户确认**：P1 是 silent-recall-loss-prone 的行为变更（flag 热可回滚但失败难发现），按 R3 须用户拍板。
3. **flip 后立即**：A6 稳态断言切到 `counter≡0`（flip 前 fallback 合法、counter 必非零）；跑 flip-probe + A4 gate + A7 canary 复验。

## 已知 testability debt（记录，非阻塞）

- **A5 projection_only-throw 路径无法廉价单测**：`PI_STACK_SETTINGS_PATH` 硬编码、`resolveSedimentSettings()` 从盘读不可注入，故无法在单测里强制 projection_only + 诱发 projection 读错误来断言抛错。由 **flip-time 真实验证 + A6 tripwire 运行时守护**兜底（projection_only 下 legacy 浮现即响亮，正是 A5 失败模式的探测器）。若将来要补单测，最小改动 = `resolveSedimentSettings` 支持 `PI_STACK_SETTINGS_PATH` env override。

## 周期化（R3 kimi D4）

A7 canary（`dossier:adr0039-l1-rebuild-canary`）+ A4 gate（`gate:adr0039-flip-coverage`）应周期复跑，不只 pre-flip 一次性——snapshot 通过不证连续写入下仍通过。

## 边界

本阶段只把 flip 机械前置做到 flip-ready 并文档化。P1 须 shadow-window 经 R4 定 + 用户确认后另起。逐步、flag-guarded、真实数据验证，legacy 全程 dual-write 保活作冷灾备/回滚。
