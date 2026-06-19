---
doc_type: notes
status: active
---

# ADR 0039 P3b — Constraint Evidence Event writer 受控实测第一阶段

本记录只覆盖 P3b 第一阶段：显式打开 `sediment.constraintEvidenceEventWriter.enabled`，保持 `ruleInjector.dualReadAudit.enabled=false`。目标是先收集真实 `agent_end` 路径产生的 L1 Constraint Evidence Events，并验证 append、审计、路径守卫、旧规则写入路径不受影响。P3b 第一阶段不切换 compiled view injection，不读取 shadow view 作为 runtime truth，不写 canonical rules、project rules、knowledge 或其它 canonical memory。

## 复审结论

P3a 完成后进行了多模型复审。成功返回的复审意见均支持受控实测，但不建议直接同时打开 event writer 与 dual-read audit。主要原因是 dual-read audit 的有效语义证据依赖新鲜 shadow compiler 输出；如果在缺少真实 L1 event 与重编节奏时同时打开，会把 session_start 审计降为基础设施可用性检查，难以区分 writer、compiler 与 audit 三层问题。因此本阶段只打开 event writer，dual-read audit 留在下一阶段，等真实 L1 event 被 shadow compiler 消费后再打开。

## 当前基线

2026-06-19 18:00 +0800 已手动运行 `node scripts/dossier-constraint-shadow-report.mjs --force --write --model openai/gpt-5.5 --max-retries 1`，生成新鲜 shadow 基线。结果为 `ok=true`，`inputRootHash=6d4c9c8bad195fe4c523e5c1cb4e98f286b34ac20dbe391f44c7b5b5da806748`，`sourceCount=33`，`constraints=17`，`exclusions=16`，`unresolved=0`，`unmappedSources=0`，`shadowOutputHash=e3a9c55d50982dc6b2dea030672b800a15817ea1bf875a55002027b9fd08a6ed`。该基线已写入 `/home/worker/.abrain/.state/sediment/constraint-shadow/latest/`，并包含 `event-coverage.json` 与 `legacy-parallel-delta.json`。

基线 `event-coverage.json` summary 为 `totalEvents=0`、`validEvents=0`、`invalidEvents=0`、`queuedEvents=0`、`projectedEvents=0`、`staleEvents=0`、`appendFailedEvents=0`、`coverageRatio=1`。这表示 P3b 第一阶段开启前还没有真实 L1 constraint evidence event，后续新增事件可以从零基线观察。

## 开关状态

本阶段只改 live settings：`/home/worker/.pi/agent/pi-astack-settings.json` 中 `sediment.constraintEvidenceEventWriter.enabled=true`。`ruleInjector.dualReadAudit.enabled=false` 保持不变，表示 session_start 仍不读取 shadow latest artifact 做审计。旧 rules 注入仍来自 legacy `rules/{always,listed}`，P3 compiled view injection 不在本阶段范围内。

## 回滚条件

任一条件命中时立即把 `sediment.constraintEvidenceEventWriter.enabled` 改回 `false`，保留已写 L1 event 与 `.state` audit 供复盘，不物理删除证据：

- `~/.abrain/rules/**`、`~/.abrain/projects/*/rules/**`、`~/.abrain/knowledge/**` 或 project memory canonical 文件出现非预期写入。
- L1 event 未落在 `~/.abrain/l1/events/sha256/<aa>/<bb>/<event_id>.json`，或 envelope、path、body hash 不一致。
- append failure 没有对应 audit/status，或 `CE_HASH_PATH_COLLISION`、未净化 secret/PII 入 L1。
- event 速率明显异常，持续产生大量低价值信号，说明 classifier/router 分类不稳定。
- shadow compiler 重跑后出现 `SC_EVENT_READ_ERROR`、`SC_EVENT_NOT_MEMORY_LEAK`、`SC_EVENT_SCOPE_BREACH` 且无法解释。

## 观察项

- L1 events：`/home/worker/.abrain/l1/events/sha256/**/*.json`，抽样检查 `event_type`、`scope.scope_hint`、`sanitizer.status`、`legacy_parallel_write` 与 envelope hash。
- Writer state：`/home/worker/.abrain/.state/sediment/constraint-events/**`，观察 append attempts、append failures、projection status 与 oldest queued age。
- Shadow compiler：定期运行 `node scripts/dossier-constraint-shadow-report.mjs --force --write --model openai/gpt-5.5 --max-retries 1`，查看 latest `event-coverage.json` 与 `legacy-parallel-delta.json`。
- Canonical memory：用 git/status/diff 检查 rules、knowledge、project memory 没有被本路径写入。

## 下一阶段进入条件

打开 `ruleInjector.dualReadAudit.enabled=true` 之前，至少需要看到真实 L1 event 被 shadow compiler 读取并出现在 `event-coverage.json`。若 writer 连续数轮无真实 event，可继续保持本阶段；若出现 append/path/sanitizer 问题，先回滚 writer 并修复，不进入 dual-read 阶段。
