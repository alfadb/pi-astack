# Aggregator + Classifier Health Meta-Check — P0 实施设计 (v2)

**状态**: 设计已固化, 待 coding (估 1-1.5 天)
**对应 ADR**: 0024 §5.3 + 0025 §4.3 + §4.5
**前置 commit**: b25db52 (timeout 20min) / 9b5fd47 (INV-INVISIBILITY 重定义)
**v2 修订自**: /tmp/aggregator-design-draft.md (v1)
**Review by**: deepseek-v4-pro (full critique 在本会话上下文)

---

## 1. v1 → v2 关键修正(DeepSeek 抓到的 blocking 问题)

| # | v1 错误 | v2 修正 | 证据 |
|---|---|---|---|
| **A3 blocking** | 草案说读 `~/.abrain/.state/sediment/audit.jsonl` | 改为 `sedimentAuditPath(projectRoot)` = `<projectRoot>/.pi-astack/sediment/audit.jsonl` | abrain home 该文件 0 条 classifier,project-local 24h 内 105 条 |
| **B1 blocking** | "ADR §4.3.2 史官 prompt skeleton" 太抽象 | 草案 §4 落地 concrete JSON output schema | 不定义 schema → aggregator output 不可消费 |
| **B2 blocking** | reasoning_trace schema variant 没考虑 | aggregator prompt 显式处理 `signal_found=true/false` 两 schema + `prompt_version` 字段感知 | active-correction-classifier-v1.md:244-278 vs :254-270 两个 schema |
| **E3 blocking** | aggregator LLM timeout → catch 吞 → last-run 不更新 → retry storm | timeout / error 时也写 last-run.json (含 `lastRunStatus: "timeout"/"error"`) | 防一天烧 50 个 20min × 8h × …… |
| A1 改进 | 挂 `scheduleDrainIfBacklog finally` | 改挂 `maybeSetIdleIfNoInflight` 内 (两条路径汇合点) | drain loop 和 main bg 都汇合于此 |
| A2 改进 | `aggregator-last-run.json` 单 lastRun 字段 | 用 `Record<string, string>` (window → ISO ts) 留多窗口扩展 | future weekly/monthly 不破坏 schema |
| C 改进 | staging 膨胀监控 → P0 不做 | P0 做 (10 行 `fs.readdir`+count,不烧 LLM token) | "轻量 Infra 兜底"per ADR §4.3.3 |
| D 改进 | advisory flag 时 notify "可选" | advisory flag 时 footer 显示 `🧠 classifier health: degraded` | ADR 0024 §2 "明确感知大脑工作"的健康反馈 |
| E1 改进 | "跟 checkpoint 同 pattern" 含糊 | 直接复用 `withFileLock` (_shared/runtime.ts:717-725) | 现成 helper,not-invented-here |
| E2 hook | 草案缺误报反馈通道 | advisory schema 留 `advisory_id: uuid` 字段(P1 加 dismiss CLI) | minimal hook P0 可观察,P1 可扩展 |
| A4/A5 改进 | `aggregatorReadLastN: 50` 默认 | 取消该 setting; 按时间窗口拉全部 trace; 加 `events_scanned >= 10` minimum 否则 skip | 24h 实测 105 条,50 是 1/2 窗口 |

---

## 2. 五个前置决策(v2 终版)

| # | 决策 | 结论 |
|---|---|---|
| 1 | drain loop 挂载点 | `maybeSetIdleIfNoInflight` 内部 `(_G.__sediment_inflightCount ?? 0) <= 0` 时触发 `maybeRunAggregatorIfDue` |
| 2 | 窗口分层 | P0 只做 daily; `last-run.json` schema 留多窗口扩展空间 |
| 3 | trace 拉取量 | 取消硬截断;按 24h 时间窗口拉所有 classifier audit + reasoning_trace |
| 4 | output 写哪 | 双写: (a) project-local audit.jsonl 写 `operation: aggregator_run` (single source of truth); (b) `aggregator-advisory.jsonl` 写 advisory(诊断快捷读路径) |
| 5 | scheduler | 机会调度: idle 时检 last_run,距上次 ≥ 24h 才跑 |

---

## 3. 文件清单 + LOC 估算

| 文件 | 动作 | LOC |
|---|---|---|
| `extensions/sediment/aggregator.ts` | 新建: `runAggregator()` + `maybeRunAggregatorIfDue()` + `loadLastRun()` + `writeLastRun()` + `formatHealthReport()` | ~350-400 |
| `extensions/sediment/aggregator-prompt.ts` | 新建: `buildAggregatorPrompt()` + `parseAggregatorResponse()` + JSON schema 校验 | ~200-250 |
| `extensions/sediment/settings.ts` | 新增 6 字段 (`aggregatorEnabled`, `aggregatorWindowMs`, `aggregatorMinIntervalMs`, `aggregatorTimeoutMs`, `aggregatorModel`, `aggregatorMinEventsToRun`) + promptVersion + resolveSettings | ~50 |
| `extensions/sediment/index.ts` | hook 1: `maybeSetIdleIfNoInflight` 内部追加 `maybeRunAggregatorIfDue` 调用; hook 2: `/sediment health` slash subcommand; hook 3: footer 显示 advisory flag(via `applySedimentStatus` 扩展状态) | ~80 |
| `scripts/test-aggregator-prompt.mjs` | 新建: 独立 prompt 测试,seed real audit trace,validate JSON output 稳定 | ~100 |
| `scripts/smoke-aggregator.mjs` | 新建: end-to-end smoke (seed → run → assert) | ~120 |
| **总计** | | **~900 LOC** |

工程量重估: ~1-1.5 天 (含 prompt 工程 3-5 轮迭代调试)

---

## 4. aggregator output JSON schema (v2 必需)

```jsonc
{
  "advisory_id": "01HF...uuid",          // E2 hook: P1 dismiss 通道
  "ts": "2026-05-24T10:00:00.000Z",
  "window": "daily",
  "events_scanned": 105,                  // 报告实际扫了多少条
  "classifier_health": {
    "quote_rate_pct": 72,                 // ADR §4.3.3 三维度
    "alternative_mention_rate_pct": 58,
    "concrete_self_critique_rate_pct": 41,
    "trend_quote_delta_pct": -8,          // 前 25 vs 后 25 trace 差值
    "trend_alternative_delta_pct": 3,
    "trend_self_critique_delta_pct": -12
  },
  "staging_health": {                     // C 改进: P0 staging 膨胀监控
    "file_count": 17,
    "oldest_age_days": 4
  },
  "advisory_flags": [
    {
      "dimension": "self_critique",
      "severity": "warning",              // "warning" | "info"
      "message": "Concrete self-critique rate fell from 53% to 41% (trend -12pp)."
    }
  ],
  "self_check": {                         // ADR 0024 §5.3
    "falsifiability_test": "If next 7 days all have quote_rate > 80%, this warning is false.",
    "sycophancy_check": "No reward-seeking: real decline observed."
  },
  "no_hypothesis": false                  // 史官精神: 没发现就 true
}
```

阈值规则 (prompt 里让 LLM 自己判):
- 任一 `_pct < 40` → advisory_flag severity "warning"
- 任一 `_delta_pct ≤ -10` → advisory_flag severity "warning"
- 否则 → `no_hypothesis: true`, `advisory_flags: []`

---

## 5. aggregator prompt 关键段(伪码大纲)

```
你是 sediment 的史官 (chronicler). 阅读最近 24h 的 classifier reasoning trace, 给出健康度评估.

# 输入数据
{events_scanned} 条 classifier audit row. 每条含:
- prompt_version.active_correction_classifier (可能是 v1 / v2 / ...)
- prompt_version._semantic_note (告诉你这版 prompt 的核心 schema)
- signal.reasoning_trace (v1 schema): 
    - signal_found=true → step_1_quote, step_2_cases, step_3_disconfirmer, ..., step_6_self_critique, step_7_self_rating
    - signal_found=false → 只有 step_1_quote, step_2_cases, step_2b_lean
- 其他版本 prompt 看 _semantic_note 解读

# 任务 1: classifier health 三维度
对每条 trace, 判断:
- 是否含 verbatim quote (step_1_quote 非空 + 跟原文本 substring match)?
- 是否提及 alternative interpretation (step_3_disconfirmer 或 step_2b_lean)?
- 是否含 concrete self-critique (step_6_self_critique 非 generic boilerplate, 提到具体 bias / risk)?

算总比例 + 前 25 vs 后 25 趋势差.

# 任务 2: 史官精神
"默认无发现就是成功". 不要 fabricate hypothesis. 没显著问题就 no_hypothesis=true.

# 任务 3: Falsifiability + sycophancy self-check
每个 advisory_flag 必须可证伪. 输出 self_check 段.

# 输出 (严格 JSON, 不要 reasoning prose 在 JSON 外面)
{schema}
```

prompt 工程关键点:
1. **强制 JSON output**: 试 deepseek `response_format: { type: "json_object" }`,不支持则 prompt 里强约束 + parse 失败 retry 1 次
2. **escape window delimiters**: 复用 `buildLlmExtractorPrompt` 同款 `escapeWindowDelimiters`
3. **prompt_version 感知**: 把每条 row 的 `prompt_version.active_correction_classifier` + `_semantic_note` 都喂进 context

---

## 6. INV-INVISIBILITY 合规(v2)

- ✓ aggregator 自治运行,不询问用户裁决
- ✓ advisory 写文件(audit + advisory.jsonl),用户主动 `/sediment health` 拉取
- ✓ **有 advisory flag 时 footer 显示** `🧠 classifier health: degraded` (D 改进) — 告诉用户大脑发现了问题
- ✓ 不弹 [Y/N] 问 "要应用 advisory 吗"
- ✓ 不要求审阅每条 advisory
- ✓ `advisory_id` schema 留 P1 dismiss 通道(用户感觉到误报时可主动反馈)

---

## 7. 风险与缓解(v2)

| 风险 | 缓解 |
|---|---|
| aggregator LLM 误判(假阳性 advisory 噪音) | (a) advisory 只是诊断信号不触发动作; (b) 用户阅读时自己判断; (c) 7d trend 检测降低单点误判; (d) `advisory_id` 留 P1 dismiss 通道 |
| 跑一次 aggregator 烧 20min token | 24h 一次 + reasoning high + ~50-150 trace context,估算 $0.02-0.05/天,dogfood 可接受 |
| 多 session 同时检测 last-run 竞争 | `withFileLock` (复用 _shared/runtime.ts:717-725) |
| **timeout 导致 retry storm** | E3 修: timeout/error 时**仍更新** last-run.json + 标 `lastRunStatus`,防 24h 内重试 |
| Fresh install 数据稀疏 | `aggregatorMinEventsToRun >= 10`,不够 skip + 写 audit "skip: insufficient" |
| reasoning_trace 跨 prompt_version 不兼容 | prompt 里 emit `_semantic_note` 让 aggregator LLM 自己适配 |

---

## 8. 完工标准(v2)

- [ ] `runAggregator` 正确读 project-local audit + 写 advisory + 写 audit operation
- [ ] `maybeRunAggregatorIfDue` 挂在 `maybeSetIdleIfNoInflight` 内部,24h gate 生效
- [ ] timeout/error 时 last-run 仍更新, lastRunStatus 标记
- [ ] `withFileLock` 防并发
- [ ] `/sediment health` 显示最近 7 条 advisory
- [ ] advisory flag 时 footer 显示 `🧠 classifier health: degraded`
- [ ] staging 膨胀监控含在 advisory(`staging_health`段)
- [ ] aggregator JSON output schema 稳定(test-aggregator-prompt.mjs > 90% 解析成功)
- [ ] smoke test 通过
- [ ] typecheck 干净
- [ ] 重启 pi 后 24h 第一次自动跑(audit verify)
- [ ] 不影响主会话 / Lane C / 其他 sediment 路径

---

## 9. 下个 sprint 开始指令

```bash
# 1. 读本文件 + DeepSeek review (会话上下文 5ca0dcc 之后)
# 2. Phase 1 (1-2h): settings.ts + sedimentLocksDir + audit operation 注册
# 3. Phase 2 (2-3h): aggregator-prompt.ts + test-aggregator-prompt.mjs 跑通 JSON 稳定输出
# 4. Phase 3 (3-4h): aggregator.ts + index.ts hook + /sediment health + smoke
# 5. Phase 4 (1h):   typecheck + commit + 重启 pi 验证 24h 后自动跑
```

---

## 10. 不做(明确延后到 P1+)

- weekly / monthly window (P0 daily 够诊断,schema 已预留)
- hypothesis → staging 接口(需要多窗口 + multi-view,P1)
- 跨 provider devil's advocate(§4.4 任务)
- 自动归档基于 advisory(§4.6 任务)
- LLM 自动 dismiss advisory(P1: 加 `/sediment dismiss <advisory_id>`)
