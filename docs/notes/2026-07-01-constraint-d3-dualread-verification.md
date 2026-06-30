---
doc_type: notes
status: active
---

# Constraint D3 / dual-read verification - 2026-07-01

This note records the read-only verification pass for the Constraint part of the second-brain cleanup sequence. No production setting was changed, `fallbackToLegacyOnError` was not flipped, and no `.abrain` constraint data was deleted.

## Commands run

| Command | Result |
|---|---|
| `npm run smoke:constraint-shadow-compiler` | PASS, 66 assertions |
| `npm run smoke:constraint-l2-repo-preflight` | PASS, 4 checks |
| `npm run smoke:constraint-evidence-event` | PASS, 37 checks |
| `npm run smoke:adr0039-reconcile` | PASS |
| `npm run dossier:constraint-shadow-report` | SKIP in dry-run mode; no real LLM call and no shadow artifacts written |

## Current `.abrain` state

`/home/worker/.abrain/.state/sediment/constraint-shadow/latest/event-coverage.json` reports:

| Field | Value |
|---|---:|
| `totalEvents` | 16 |
| `validEvents` | 16 |
| `invalidEvents` | 0 |
| `queuedEvents` | 0 |
| `projectedEvents` | 14 |
| `staleEvents` | 2 |
| `appendFailedEvents` | 0 |
| `deferredMergedSourceEvents` | 2 |
| `coverageRatio` | 0.875 |
| `injectableCoverageRatio` | 1 |

The latest `/home/worker/.abrain/.state/sediment/constraint-shadow/session-start-dualread/audit.jsonl` row still reports `status="delta"`:

| Field | Value |
|---|---:|
| Audit rows | 292 |
| Latest observed UTC | `2026-06-30T19:20:45.365Z` |
| Latest shadow stale | `true` |
| Latest `legacyRules` | 23 |
| Latest `shadowConstraints` | 33 |
| Latest `compiledOnly` | 15 |
| Latest `legacyOnly` | 5 |
| Latest `bothMatch` | 0 |
| Latest `textDelta` | 18 |

## Preflight warning

`smoke:constraint-l2-repo-preflight` passed, but warned that the cached decision was 56.5 hours old, above the 24 hour freshness target. This is not a failure for the read-only verification pass, but it blocks treating the current cache as flip-ready evidence without re-running the shadow compiler on fresh input.

## Decision

Constraint is not blocked by basic smoke coverage: compiler, L2 repo-mode preflight, evidence event smoke, and reconcile all pass. It is still not ready for a runtime fallback flip because the dual-read surface remains `delta`, the latest shadow is stale, and the legacy-only/settings-not-memory rows still need explicit disposition. The next action is evidence refresh and delta disposition, not changing `ruleInjector.compiledViewInjection.fallbackToLegacyOnError`.
