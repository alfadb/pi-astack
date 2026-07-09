---
doc_type: adr
status: archived
---

# ADR 0025 v3 — Sediment Meta-Curator：让 sediment 演化为 ADR 0024 第二大脑

> 🗄️ **机制已 ingest 入 abrain（pi-global），本 ADR 归档**：本 ADR 是 ADR 0024 §5 六能力点的机制对偶（含被 0027/0028 引用的独立决策：A'/B'/C' 约束分层、放宽 ADR 0003 主会话只读、conf<8 盲区）。机制 rationale 已由 ADR 0034 ingest lane 分解为 **36 条 typed entry** 存入第二大脑，逐条 rationale 经 `renderRationale` 可得（带 pinned `source_ref` SHA）。其中触碰方向承重墙的 escalation 已浮现：`conf-below-eight-multi-view-bypass-blast-radius`（narrows INV-ACTIVE-CORRECTION，required）/ `adr-0003-three-conflict-points-resolution-options`（conflicts INV-MAIN-SESSION-READ-ONLY + REQ-005，proposed）。原机制 prose（704 行）见 `docs/notes/adr0034-impl-plan.md` 记录的 prose 基线。

## 现状与约束沉淀（已入 abrain，逐条 slug）

§1 现状：`sediment-two-independent-write-lanes` · `lane-c-fire-and-forget-non-blocking` · `draft-level-isolation-separate-try-catch` · `seven-zone-hardcoded-staging-not-in-code` · `sanitizer-14-deterministic-regex-no-llm-hook` · `audit-has-rich-fields-missing-structured-trace` · `git-sync-singleflight-index-lock-gap` · `auto-write-three-state-rollback-switches` · `adr-0003-sandbox-already-has-breaches`

§3 约束分层：`constraint-layering-three-tier-results-tension-choices` · `staging-to-durable-requires-multi-view-gate` · `conf-below-eight-multi-view-bypass-blast-radius` · `adr-0003-three-conflict-points-resolution-options` · `sanitizer-false-redaction-hybrid-upgrade-path` · `about-me-fence-deprecation-requires-auto-write-stable`

§6 测试：`smoke-tests-advisory-only-never-release-gates`

## 六能力点机制（方向见 [ADR 0024](./0024-second-brain-from-natural-conversation.md)；机制逐条入 abrain）

### 4.1 主动纠错识别（前置能力）

abrain slugs：`active-correction-is-prerequisite-capability` · `classifier-runs-all-lanes-sanitizer-hard-gate` · `correction-prompt-reasoning-constraints` · `correction-three-semantic-routing-paths` · `conf-below-eight-multi-view-bypass-blast-radius` · `provisional-staging-entry-with-provenance-warning` · `staging-resolve-batch-scan-n-rounds`

### 4.2 outcome self-report

abrain slugs：`outcome-self-report-three-approach-tradeoff` · `outcome-footnote-loss-prefer-loss-over-guess` · `outcome-ledger-independent-sidecar`

### 4.3 跨会话趋势观察（aggregator）

abrain slugs：`aggregator-scheduled-on-drain-loop-debounced` · `classifier-health-meta-check-trend-detection`

### 4.4 Multi-view verification

abrain slugs：`multi-view-five-trigger-conditions` · `devil-advocate-virtual-reviewer-rlhf-mitigation` · `multi-view-cross-provider-strategy-settings-driven` · `multi-view-replay-never-silent-fallback-to-proposer`

### 4.5 Classifier prompt 自身演进

abrain slugs：`prompt-version-field-p0-mandatory-infrastructure`

### 4.6 静默归档 + 回滚窗口

abrain slugs：`archive-live-use-bridge-detection` · `archive-git-rm-after-reviewer-final-judgment`（**注：此机制条目为历史记录，自治硬删除授权已被 ADR 0031 / ADR 0039 取代；自治遗忘终点是 `archived` 全文 runtime tombstone，`git rm` 不在自治授权内**） · `archive-cross-device-absolute-timestamp-no-reset` · `archive-existing-entry-migration-steps`
