---
doc_type: notes
status: active
---

# ADR0039 R4 — shadow-window nuance 收敛：确定性绿充分放行（2026-06-21）

> R3 遗留的唯一未决点（P1 flip 前是否需一道生产 shadow dual-read diff 窗口）。
> 4×T0（opus-4-8 / gpt-5.5 / deepseek-v4-pro / kimi-k2.7-code）。主会话主持不投票。
> **结论：4/4 一致——确定性 GO 套件充分授权 P1，不需 shadow 窗口。opus（R3 提议方）收回主张。**

## 收敛论证（4/4 一致）

projection_only 是 **store-level 变更**（改 loadEntries 吃哪些 store），不是 query-level。
- **flip-probe = store 层效果的确定性穷举刻画**（全语料逐 slug 验证「投影胜出 + set/hash」，走同一条 loadEntries store-loading 路径），不是采样。
- **生产 shadow 窗口是按到达流量采样**：只能证明窗口期被触发的 binding 0 分歧，证不了未触发 binding 的不变性 → 对 store-level 变更**严格弱于** flip-probe（采样 ⊂ 全集）。拿采样补穷举，方向反了。

opus 逐一排掉 R3 自己担心的边缘：
- **per-project binding / scope 路由**：属 store-selection 参数空间，flip-probe 全语料 + A4 的 **L1-derived 分母**（active 2784/2784、archived 33/33 跨 project 逐条对齐）已穷举覆盖；真流量只命中子集。
- **overlay 预算 / 截断**：在 store 层之上/正交，对两种读模式影响对称、不引入 divergence；且 shadow 窗口（绕 rerank 的 set+hash diff）本身也不测它 → 零增量。
- **冷启动 rebuild / 并发 / 缓存（运行时态）**：pre-flip 窗口同样抓不到（它测 flip 前那一刻、不预言 flip 后漂移）；这是 **A6 post-flip tripwire 的职责**，A6 无论加不加窗口都在。

kimi 补充非对称：**A6（G1）捕获 shadow 永远捕不到的一类风险**——incomplete flip / caller bypass（pre-flip 阶段两路都在跑，legacy 调用是预期的，shadow 看不出）；而 shadow 能捕的并发类风险被 A5 fail-loud + hot-flag 秒级回滚压到等价 blast。故 shadow 对残余风险**无净改进、有净成本**。

deepseek：shadow 窗口本质是对 flip-probe 覆盖面的不信任——若 flip-probe 有盲区应修 flip-probe，而非加采样窗口弥补。A6 永久在线 > 有界窗口（窗口太短反而漏低频事件）。

## P1 GO-条件最终形式（4/4，无 shadow 窗口）

**Pre-flip 全部已满足（GO 套件 7/7 绿）：**
- flip-probe 全语料逐 slug 投影胜出 + set/hash + 0 泄漏（= 有界 live 验证，加载真实 scanStore+stable-view、绕 rerank）。前置：其语料枚举覆盖全 per-project binding + scope 路由（由 A4 L1-derived 逐 project active/archived 计数证明）。
- A4 flip coverage 硬门：L1-derived 分母，active 1.0000 + archived 1.0000 + 字段 legacy→L1 0 mismatch + allowlist 显式扣除。
- A7 canary 全语料 byte_match（3056/33/0）。
- A5 fail-loud 武装 + A6 tripwire 武装。
- reindex-ab 字段 0% + reconcile b0=1.0。
- hot-flag 回滚（单 flag、≤ 秒级、无需重启/重建索引）。

**Post-flip 守护闭环（A6 覆盖残余运行时态风险）：**
- 翻 `canonicalReadMode=projection_only` 后，稳态窗口（kimi 建议 ≥1× 业务高峰周期）内三道守护：A6 legacy-read counter **必须保持 0**（任何 +1 → 立即告警 → 评估回滚）；A5 projection 错误率与 baseline 持平；reconcile b0=1.0 周期跑漂移即告警。
- **flip 后立即复跑 flip-probe + A7 canary**——这才是真正的「运行时态」证据，且在正确时点（flip 后而非 flip 前）。
- 回滚：单 flag 回 current，A5/A6 在 current 下零行为变更兜底。

## 残余风险（坦诚，4/4 接受）

唯一无法被任何 pre/post 守护消除的：A7 取样时点之后、flip 之前新写入的、且仅在 live 并发下暴露的 projection 缺陷——被 A5 fail-loud + reconcile b0=1.0 + hot-flag 秒级回滚压到秒级 blast。shadow 窗口在数学上**不能消除**该风险（窗口内同样有新写入），只是「换汤」。

## 闸门结论

**ADR0039 P1 flip 的全部 consensus 前置已满足（R1-R4 全部一致）。** 剩唯一非技术闸门 = 用户确认（P1 是 silent-recall-loss-prone 的读路径行为变更，flag 热可回滚但失败难发现，R3 定须用户拍板）。
