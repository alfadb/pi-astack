---
doc_type: reference
status: active
---

# Smoke Tests Reference

`package.json#scripts` 是 smoke test **live truth**。本文只是便于阅读的镜像；修改脚本时请同步本文。若本文与 `package.json` 冲突，以 `package.json` 为准。

## Current scripts（2026-06-12, 91 total）

| npm script | File | Coverage |
|---|---|---|
| `smoke:turn-progress` | `scripts/smoke-turn-progress.mjs` | turn-progress extension registration / status rendering basics |
| `smoke:memory` | `scripts/smoke-memory-sediment.mjs` | memory facade + sediment integration regressions, including credential typed-redaction boundary |
| `smoke:sanitizer-homoglyph` | `scripts/smoke-sanitizer-homoglyph.mjs` | sanitizer homoglyph / lookalike secret-boundary regression coverage |
| `smoke:derive-provenance` | `scripts/smoke-derive-provenance.mjs` | active-correction signal quote-source → provenance derivation, including sanitized user-message matching |
| `smoke:rule-footer-realtime` | `scripts/smoke-rule-footer-realtime.mjs` | real-time rules footer refresh after rules directory changes |
| `smoke:tier1-directive-defer` | `scripts/smoke-tier1-directive-defer-resolution.mjs` | ADR 0028 Tier-1 deterministic directive commit path when curator multi-view defers |
| `smoke:pr1-adr0028` | `scripts/smoke-pr1-adr0028.mjs` | ADR 0028 PR1: rules-as-readonly-neighbors, Tier-1 direct deterministic write, real `agent_end` checkpoint ordering, R4' outcome edge (CONTRADICT contest + echo-guarded MATCH weak-confirm into rule-outcome-edge.jsonl + per-turn ledger delta contract), R3 negative recall audit, and shadow-flag removal invariants |
| `smoke:pr-c-hygiene` | `scripts/smoke-pr-c-hygiene.mjs` | PR-C hygiene source locks for ADR 0024–0028 cleanup invariants |
| `smoke:evolution-ledger` | `scripts/smoke-evolution-ledger.mjs` | L1 Sediment Evolution Loop v1 internal evolution-ledger lifecycle / scoping / degraded-run guard / identity convergence (`adoptUnsluggedAlias`) |
| `smoke:entry-telemetry` | `scripts/smoke-entry-telemetry.mjs` | Outcome→Entry feedback edge Tier-A telemetry sidecar: cumulative/rolling aggregation, hysteresis preservation, project scoping, sidecar-only boundary (never writes durable markdown) |
| `smoke:entry-lifecycle-proposals` | `scripts/smoke-entry-lifecycle-proposals.mjs` | Outcome→Entry feedback edge M3 read-only proposal sink: proposals sourced from PROMOTED advisories only (not demoted/exoneration), status=pending, project scoping, §8 observation-only boundary (no writer/curator/multi-view) |
| `smoke:cas-guard` | `scripts/smoke-cas-guard.mjs` | writer-side CAS / expected-state guard regressions |
| `smoke:staging-resolver` | `scripts/smoke-staging-resolver.mjs` | ADR 0025 §4.1.5.1 staging-resolver triage + advisory `promote_candidate` path |
| `smoke:staging-ageout` | `scripts/smoke-staging-ageout.mjs` | ADR 0025 §4.1.5 / §4.6.6 reversible staging age-out soft-archive path |
| `smoke:memory-path-a` | `scripts/smoke-memory-path-a.mjs` | ADR 0026 Path A always-on relevant-memory injection substrate |
| `smoke:dispatch` | `scripts/smoke-dispatch-input-compat.mjs` | dispatch input compatibility |
| `smoke:dispatch-output-format` | `scripts/smoke-dispatch-output-format.mjs` | dispatch sub-agent output formatting (no legacy truncation regression) |
| `smoke:dispatch-subagent-tool-allowlist` | `scripts/smoke-dispatch-subagent-tool-allowlist.mjs` | in-process sub-agent tool allowlist boundary; vault/prompt tools excluded by default |
| `smoke:dispatch-project-trust` | `scripts/smoke-dispatch-project-trust.mjs` | pi 0.79.0 Project Trust boundary for the shared sub-agent loader |
| `smoke:fallback-timing` | `scripts/smoke-model-fallback-mutation-timing.mjs` | model-fallback mutation timing |
| `smoke:vision` | `scripts/smoke-vision.mjs` | vision tool registration/schema/basic path |
| `smoke:imagine` | `scripts/smoke-imagine.mjs` | imagine tool registration/schema/output path |
| `smoke:web-search` | `scripts/smoke-web-search.mjs` | web_search / web_fetch registration and basic provider contract |
| `smoke:model-curator-live-reapply` | `scripts/smoke-model-curator-live-reapply.mjs` | model-curator settings edits take effect without restart |
| `smoke:pi-internals-subagent` | `scripts/smoke-pi-internals-subagent.mjs` | shared pi-internals sub-agent detection helpers |
| `smoke:c5-terminal-state` | `scripts/smoke-c5-terminal-state.mjs` | ADR 0027 §C5 terminal_state taxonomy and per-state fields |
| `smoke:c5-audit-row-schema` | `scripts/smoke-c5-audit-row-schema.mjs` | dispatch audit v2 row schema with terminal_state fields |
| `smoke:c5-hole-materialization` | `scripts/smoke-c5-hole-materialization.mjs` | dispatch_parallel materialized result holes / aggregate state regressions |
| `smoke:c5-heartbeat` | `scripts/smoke-c5-heartbeat.mjs` | ADR 0027 heartbeat writer substrate |
| `smoke:c5-heartbeat-consumer` | `scripts/smoke-c5-heartbeat-consumer.mjs` | heartbeat liveness consumer / stale verdict mapping |
| `smoke:c5-heartbeat-dispatch-integration` | `scripts/smoke-c5-heartbeat-dispatch-integration.mjs` | heartbeat integration with dispatch runtime |
| `smoke:c5-heartbeat-lifecycle` | `scripts/smoke-c5-heartbeat-lifecycle.mjs` | heartbeat lifecycle stop/finally cleanup regressions |
| `smoke:archive-reactivation` | `scripts/smoke-archive-reactivation.mjs` | ADR 0025 §4.6 archive-reactivation reviewer path |
| `smoke:causal-anchor` | `scripts/smoke-causal-anchor.mjs` | ADR 0027 §C6 causal anchor core helpers |
| `smoke:causal-anchor-retrofit` | `scripts/smoke-causal-anchor-retrofit.mjs` | anchor fields retrofitted into existing ledgers/audit rows |
| `smoke:sediment-l2-withhold` | `scripts/smoke-sediment-l2-withhold.mjs` | P0-α: sub-agent toolResult withheld from sediment learning loop |
| `smoke:causal-anchor-trigger-snapshot` | `scripts/smoke-causal-anchor-trigger-snapshot.mjs` | trigger-time anchor snapshot for async/background lanes |
| `smoke:subagent-boundary-sentinel` | `scripts/smoke-subagent-boundary-sentinel.mjs` | SDK drift sentinel for sub-agent session identity boundary |
| `smoke:memory-subagent-prompt` | `scripts/smoke-memory-subagent-prompt.mjs` | sub-agent memory-tools prompt variant without memory-footnote sink |
| `smoke:causal-anchor-device-id` | `scripts/smoke-causal-anchor-device-id.mjs` | device_id in causal anchor for cross-device disambiguation |
| `smoke:r2-newp1-fixes` | `scripts/smoke-r2-newp1-fixes.mjs` | ADR 0024–0027 R2 NEW-P1 regression bundle |
| `smoke:jiti-singleton` | `scripts/smoke-jiti-singleton.mjs` | globalThis / Symbol singleton hardening across jiti module copies |
| `smoke:per-turn-cost` | `scripts/smoke-per-turn-cost.mjs` | per-turn cost sidecar and rollup feed |
| `smoke:multi-view` | `scripts/smoke-multi-view.mjs` | multi-view review-all mutations gate and Pass 1 rich-payload synthesis |
| `smoke:paths` | `scripts/smoke-pi-astack-paths.mjs` | runtime path helpers and package layout assumptions |
| `smoke:vault-subpi-isolation` | `scripts/smoke-vault-subpi-isolation.mjs` | legacy sub-pi vault isolation regression coverage |
| `smoke:abrain` | `scripts/smoke-abrain-backend-detect.mjs` | vault backend detection |
| `smoke:abrain-bootstrap` | `scripts/smoke-abrain-bootstrap.mjs` | abrain/vault bootstrap |
| `smoke:abrain-vault-writer` | `scripts/smoke-abrain-vault-writer.mjs` | vault write/encrypt path |
| `smoke:abrain-vault-reader` | `scripts/smoke-abrain-vault-reader.mjs` | vault read/release path |
| `smoke:abrain-vault-grant-isolation` | `scripts/smoke-abrain-vault-grant-isolation.mjs` | INV-E grant cross-key isolation E2E + ui_path stamp + fail-closed envelope |
| `smoke:abrain-vault-bash` | `scripts/smoke-abrain-vault-bash.mjs` | bash injection/output handling + audit fallback hardening |
| `smoke:abrain-vault-identity` | `scripts/smoke-abrain-vault-identity.mjs` | vault file identity / placeholder format |
| `smoke:abrain-git-sync` | `scripts/smoke-abrain-git-sync.mjs` | abrain git auto-sync (ADR 0020) |
| `smoke:git-singleflight` | `scripts/smoke-git-singleflight.mjs` | shared git single-flight serialization helper |
| `smoke:abrain-active-project` | `scripts/smoke-abrain-active-project.mjs` | strict active project binding |
| `smoke:abrain-secret-scope` | `scripts/smoke-abrain-secret-scope.mjs` | project/global secret scope behavior |
| `smoke:abrain-i18n` | `scripts/smoke-abrain-i18n.mjs` | abrain i18n strings |
| `smoke:abrain-redact` | `scripts/smoke-abrain-redact.mjs` | abrain redactor unit coverage |
| `smoke:abrain-rule-injector` | `scripts/smoke-abrain-rule-injector.mjs` | ADR 0023/0028 read-only rules catalog injection: scan, strict binding, nonce strip, idempotency, no full-body prompt leak |
| `smoke:abrain-rule-writer` | `scripts/smoke-abrain-rule-writer.mjs` | ADR 0023 rule-writer parser / frontmatter / hint and size invariants |
| `smoke:abrain-rule-writer-fs` | `scripts/smoke-abrain-rule-writer-fs.mjs` | ADR 0023/0028 rule writer filesystem orchestration, rollback, dedup, budget advisory telemetry, and curator escalation gate |
| `smoke:prompt-user` | `scripts/smoke-prompt-user.mjs` | prompt_user manager + secret redaction + INV-A/B/C/D contracts |
| `smoke:prompt-user-finalizer` | `scripts/smoke-prompt-user-finalizer.mjs` | prompt_user dialog teardown / disposer / secret wipe |
| `smoke:prompt-user-subpi` | `scripts/smoke-prompt-user-subpi.mjs` | sub-agent prompt_user disabled |
| `smoke:prompt-user-option-list` | `scripts/smoke-prompt-user-option-list.mjs` | PromptDialog real-render vault & question variants |
| `smoke:compaction-tuner-prompt-user` | `scripts/smoke-compaction-tuner-prompt-user.mjs` | INV-K compaction defer while prompt_user dialog pending |
| `smoke:compaction-tuner-vault-defer` | `scripts/smoke-compaction-tuner-vault-defer.mjs` | INV-K compaction defer while vault dialog pending |
| `smoke:compaction-tuner-backoff` | `scripts/smoke-compaction-tuner-backoff.mjs` | compaction-tuner retry/backoff guard |
| `smoke:compaction-tuner-turn-boundary` | `scripts/smoke-compaction-tuner-turn-boundary.mjs` | compaction-tuner turn-boundary behavior |
| `smoke:compaction-tuner-openai-remote-compact` | `scripts/smoke-compaction-tuner-openai-remote-compact.mjs` | compaction-tuner OpenAI Responses remote compaction, marker injection, invalid-response fallback, and `remoteOpenAICompaction.auditPayload` sidecar audit modes (`off`/`shape`/`full`) |
| `smoke:persistent-input-history` | `scripts/smoke-persistent-input-history.mjs` | persistent-input-history SDK-drift defense and replay matching |
| `smoke:time-injector` | `scripts/smoke-time-injector.mjs` | time-injector session prompt block |
| `smoke:verify-after-edit` | `scripts/smoke-verify-after-edit.mjs` | verify-after-edit extension registration / edit-result contract |
| `smoke:tool-parallel-cap` | `scripts/smoke-tool-parallel-cap.mjs` | tool parallelism cap / concurrency guard |
| `smoke:edit-strip-empty` | `scripts/smoke-edit-strip-empty.mjs` | edit-strip-empty behavior |
| `smoke:empty-visible-output-retry` | `scripts/smoke-empty-visible-output-retry.mjs` | empty visible assistant output retry conversion |
| `smoke:task-local-working-set` | `scripts/smoke-task-local-working-set.mjs` | active-correction task-local working set path |
| `smoke:outcome-classifier-enrich` | `scripts/smoke-outcome-classifier-enrich.mjs` | outcome-ledger → classifier enrichment path |
| `smoke:script-registry-drift` | `scripts/smoke-script-registry-drift.mjs` | package smoke registry vs `scripts/smoke-*.mjs` drift guard; dossiers stay outside default gate |
| `smoke:adr-readme-anchors` | `scripts/smoke-adr-readme-anchors.mjs` | ADR README link/anchor/navigation-only drift guard |
| `smoke:aggregator-llm-parse` | `scripts/smoke-aggregator-llm-parse.mjs` | aggregator LLM prompt input construction and tolerant output parsing |
| `smoke:aggregator-structural-context` | `scripts/smoke-aggregator-structural-context.mjs` | STRUCTURAL_CONTEXT staleness lint for known-unimplemented capabilities |
| `smoke:p15-pass1-op-breakdown` | `scripts/smoke-p15-pass1-op-breakdown.mjs` | P1.5 watchdog Pass1 op-type breakdown instrumentation |
| `smoke:goal-state` | `scripts/smoke-goal-state.mjs` | goal state machine, CLI parsing, persisted view, injection block |
| `smoke:goal-autocontinue` | `scripts/smoke-goal-autocontinue.mjs` | goal auto-continue judge, budget pre-decrement, stop/ESC gates |
| `smoke:goal-doc-tools` | `scripts/smoke-goal-doc-tools.mjs` | document-driven goal source and goal tool registration |
| `smoke:workflow-dsl` | `scripts/smoke-workflow-dsl.mjs` | workflow JSON DSL validation and dry-run diagnostics |
| `smoke:workflow-executor` | `scripts/smoke-workflow-executor.mjs` | workflow DAG executor, retry/degrade/cancel/semaphore invariants |
| `smoke:workflow-tools` | `scripts/smoke-workflow-tools.mjs` | workflow_validate/list/run tool surface and config gates |
| `smoke:model-curator-tiers` | `scripts/smoke-model-curator-tiers.mjs` | model-curator tier roster loading/rendering and fail-closed config checks |

## Live prompt dossiers

These are live LLM prompt dossiers, not default release gates. They require configured provider credentials/network and are registered under `dossier:*`, not `smoke:*`.

| npm script | File | Coverage |
|---|---|---|
| `dossier:classifier-prompt` | `scripts/dossier-classifier-prompt.mjs` | ADR 0025 active-correction classifier prompt fixture dossier; fail-fast on provider infra errors |

## Recommended subsets

```bash
# Minimal doc/path sanity
npm run smoke:paths

# Memory / sediment / second-brain changes
npm run smoke:memory
npm run smoke:derive-provenance
npm run smoke:tier1-directive-defer
npm run smoke:pr1-adr0028
npm run smoke:evolution-ledger
npm run smoke:memory-path-a
npm run smoke:staging-resolver
npm run smoke:outcome-classifier-enrich
npm run smoke:archive-reactivation

# Dispatch / L2 changes
npm run smoke:dispatch
npm run smoke:dispatch-subagent-tool-allowlist
npm run smoke:dispatch-project-trust
npm run smoke:c5-terminal-state
npm run smoke:c5-heartbeat-dispatch-integration

# Vault / prompt_user changes
npm run smoke:abrain-vault-reader
npm run smoke:abrain-vault-bash
npm run smoke:abrain-vault-grant-isolation
npm run smoke:abrain-rule-writer-fs
npm run smoke:prompt-user
npm run smoke:prompt-user-option-list
```

For doc-only changes, run at least `npm run smoke:paths` if paths/runtime references were touched. For memory/sediment/vault changes, run the relevant subset above plus any command-specific smoke. For sanitizer or sediment secret-boundary changes, run `npm run smoke:memory` because it covers typed placeholders, prompt redaction, audit raw_text/error redaction, trigger phrase sanitization, and `memory_search` query redaction.

## Historical note

Older audit/docs snapshots listed “15”, “27”, or “28” smoke tests and sometimes mixed npm aliases with file names. Treat audit lists as snapshots, not live reference; regenerate this page from `package.json#scripts` when scripts change.
