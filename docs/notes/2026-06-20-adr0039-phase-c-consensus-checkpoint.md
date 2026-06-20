# ADR0039 Phase C 多 T0 共识检查点：canonical=projection 反转 GO/NO-GO（2026-06-20）

> 协议要求的记忆架构变更前共识。4 个 Knowledge 反转硬前置 blocker 全部完成 + 生产验证后，
> 就「是否执行 Phase C 真相面反转」征询 4 家跨厂 T0。主会话不投决定票。
> 参与 T0：opus-4-8、gpt-5.5、deepseek-v4-pro、kimi-k2.7-code。

## 结论：一致 CONDITIONAL GO（仅 step 1），projection_only NO-GO

四家一致：4 blocker + 质量门（0 content-loss）**足以进入中间态
`projection_with_legacy_fallback`**，但**不足以直接 `projection_only`**（需 soak +
coverage=1.0 + fresher-wins 注意）。且**一致硬性前置：执行前必须 pi 重启 + preflight**。

证据链（四家认可闭合）：
- blocker① L1/L2 commit 归属（writer 原子 sweep，生产 reconcile/prepush PASS）
- blocker② REQ-009 freshness（生产 2767 slug：semantic_diff=0、stale 精确自恢复）
- blocker③ hot overlay 有界预算（count500/token2M/time30s + 诊断 + 集成测试）
- blocker④ 语义质量门（kind/status/provenance/confidence=0，relations 0.072%≤5%）

## 机制（一致）

### 三态 flag
`knowledgeProjector.canonicalReadMode: "legacy" | "projection_with_legacy_fallback" |
"projection_only"`，默认 `legacy`。独立 flag（不复用 hotOverlayEnabled）。读 flag 应每次
loadEntries 实时读（resolveSedimentSettings 已是每次读），读侧热回滚无需重启。

### 关键：stable-view 与 hot-overlay 永久三分离（HB-C）
- **stable-view（post-flip 取胜 primary store）**：新增 `readKnowledgeStableViewStores`，
  返回 `l2/views/knowledge/latest/{projects/<id>,world}` **全量** StoreRef，**不带 files
  白名单**（走正常 dir-walk，与 legacy store 同机制），**无界**。
- **hot-overlay（recent-events 桥）**：`readKnowledgeProjectionStores` 维持**有界**
  （files 白名单 + count/token/time cap），永远追加在 stores 末尾仅补缺。
- 禁止以「统一抽象」合并入口、禁止给 stable-view 套 500-cap（>500 尾巴会从真相面静默消失）。
  settings.ts 注释「OVERLAY role only; stable-view is a separate unbounded path」是契约位。

### resolveStores 三态优先级
```
legacy（现状/回滚）：       [abrain-project, world, pensieve] + overlay(末尾, 输 dedup)
projection_with_legacy_fb： [proj-stable-project, proj-stable-world, abrain-project, world,
                            pensieve] + overlay(末尾)   ← first-wins 选 projection, legacy 补缺
projection_only：          [proj-stable-project, proj-stable-world] + overlay(末尾)
                            ← legacy 移出取胜池, 仅 doctor 可见
```
回滚 = 单 flag 切回 legacy，零数据迁移（legacy md 全程 dual-write 保活）。

## 硬性前置：pi 重启 + preflight（一致，non-negotiable）

运行中 pi 进程持**启动时旧代码 + 旧设置快照**：(1) 旧 writer 不 sweep l1/l2（blocker①
修在代码 `5045df4` 但运行时未加载）；(2) sidecar 缓存 `l2OutputRoot=state`，新写投影进
`.state` 不进 `l2/`。**直接翻 flag 会同时引爆**：prepush dirty-view 永久阻断 + stable-view
读 `l2/` 的 read-after-write 缺口（刚写的 slug 在取胜路径看不到，overlay 500-cap 兜不住尾巴）
+ 字段门被 l2 滞后推回未知态。

强制次序（写进 runbook + 翻 flag 工具的 preflight，preflight 失败拒绝翻）：
1. drain 在飞写入 → **pi restart**（加载 blocker① 代码 + repo 投影）
2. 重启后 reproject 把 l2/ 与全部 L1 对齐 → catch-up commit l1/l2/manifest
3. 重跑 blocker② dossier A/B（semantic_diff 仍=0）+ blocker④ 字段门（0 content-loss）
4. `smoke:memory` + reconcile + prepush 三连 PASS；read root == write root（无 .state/l2 分叉）
5. 报告入 git → 才允许翻 `legacy → projection_with_legacy_fallback`

## Rollout / soak

- **step 1 soak**（`projection_with_legacy_fallback`）：≥1 周 + ≥3 session（含真实 agent_end
  写），每日 canary 重跑 blocker②④ 门（0 content-loss 持续）、memory_search recall A/B 不退化、
  overlay-budget.jsonl 无 overflow、prepush 全程 PASS、每次 agent_end 后 git 干净。
- **step 2**（`→ projection_only`）：soak 全过 + **coverage=1.0**（shared==total legacy）+
  stable-view 无界 reader 证明能在 latency 预算内枚举全语料。
- **回滚触发**（入 settings 文档）：①字段门回归 ②recall A/B 退化 ③prepush 反复 dirty-block
  ④overlay 预算反复溢出 ⑤sidecar/writer 提交分叉 → 单 flag 回 legacy。
- legacy 物理删除：`projection_only` soak ≥2 周零事故前不删（r2 硬边界 2 不放松）。

## 三条 Phase C 硬边界（在 r2 三条之上追加）

1. **质量门 + coverage 门控 STATE TRANSITION**：0-content-loss 字段门必须在进入中间态**之前**
   于**实际 post-restart 读侧语料**重验通过（中间态 fallback 是 read-error 级、非 per-field、
   非 fresher-wins，"能读但更差"会静默盖好的 legacy）；coverage=1.0 额外门控 projection_only。
2. **read root == write root == committed clean，先于翻 flag**：无 .state/l2 分叉、projectOnWrite
   同步生效、l2/ 提交干净；stale projection 永不得赢过更新的 legacy。
3. **stable-view（无界）与 hot-overlay（有界）永久代码路径 + 目录根 + 预算策略三分离**；
   禁止 500-cap 渗入取胜路径。

## 执行状态（本轮）

主会话**无法**执行真正的 flip——一致共识把 pi 重启列为 non-negotiable 前置，主会话不能重启
运行中的 pi。本轮**只记录共识**，不写 flip 代码也不翻 flag。下一步分两段：
- **A（可在主会话做，安全）**：实现三态 flag + 无界 stable-view reader 代码，默认 `legacy`
  （零行为变化、完全可逆、未翻 flag 不激活）+ preflight 工具。
- **B（需用户动作）**：用户 pi 重启 → 跑 preflight（reproject + 重验 blocker②④ + 三连 PASS）
  → 翻 `projection_with_legacy_fallback` → soak。
