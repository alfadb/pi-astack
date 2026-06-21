---
doc_type: notes
status: active
---

# ADR0039 P1 flip 已执行 + post-restart 运行时终验（2026-06-21）

> ADR0039 读契约里程碑：canonical 读从 projection_with_legacy_fallback 翻到 **projection_only**。
> R1-R4 多 T0 全部一致 + 用户确认。settings commit `633c8ac`（pi 仓 agent/pi-astack-settings.json）。

## 执行

- `sediment.knowledgeProjector.canonicalReadMode` = **projection_only**（热生效；loadEntries 每次 resolveSedimentSettings 重读）。reads 只走 L2 投影、删静默 legacy 热读兜底。
- A5 fail-loud + A6 tripwire 的新 parser 代码经**用户重启**加载武装。
- legacy markdown 冻结留盘作冷灾备（P2，未删）。

## Post-restart 运行时终验（全绿）

- settings 加载确认：canonicalReadMode=projection_only（+ constraint l2OutputRoot=repo）。
- A4 flip coverage 硬门：active 1.0000 / archived 1.0000 / 字段 legacy→L1 0 mismatch（L1-derived 分母）。
- A7 L1-only rebuild canary：3060 byte_match / 0 mismatch / 0 missing。
- flip-probe：投影全胜 + 0 泄漏。
- **活体 memory_search（A6 已武装）**：返回 10 条结果，全部来自 L2 投影（timeline=projected）——projection_only 运行时读路径正常、非空（绕开 live-search 空结果不可靠：非空即正向证据）。
- **A6 anomaly 诊断**：活体 search 后**无 `legacy-cold-access.jsonl`** → A6 counter 保持 0（projection_only 下 legacy 0 浮现）= flip 运行时干净。这是 R4 指定的「flip 后正确时点的运行时证据」。

## Post-flip 守护（持续）

稳态窗口内三道（R4）：A6 legacy-read counter 必须保持 0（任何 +1 → 告警 → 评估回滚）；A5 projection 错误率与 baseline 持平；reconcile b0=1.0 周期跑。回滚 = 单 flag `canonicalReadMode` → `projection_with_legacy_fallback`（热、秒级、零数据迁移、legacy 全程保活）。

## ADR0039 主链状态

写纪律 + L1/L2/L3 存储分层 + Constraint 注入 + Knowledge 投影 + 全覆盖回填（242 active + 5 archived tombstone）+ flip 机械前置（A4-A7）+ **P1 读契约 projection_only（live + 运行时验证）** —— **主链完成**。

## 剩余尾项（非主链）

1. **Constraint L2 repo-mode**：armed（l2OutputRoot=repo 已加载）但未物化（compiled-view 自 06-20 未重生成、真 constraint-projection-envelope 精确计数=0）——等下一条真实约束指令触发 compile 自然落 l2/views/constraint/。
2. **legacy markdown 物删**：gated，反转 soak ≥2 周零事故后另起 R 轮。
3. **P7 低频域**：gated-deferred（三臂 gate）。**P8 统一 ledger**：deferred。
