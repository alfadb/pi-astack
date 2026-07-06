---
doc_type: notes
status: active
---

# Second Brain P0K Runtime Operational Envelope - 2026-07-05

## Scope

This note is repo documentation and a runtime readiness package only.

It does not authorize:

- Settings edit.
- Fresh audit.
- Production `~/.abrain` write.
- Runtime flip.
- `fallbackToLegacyOnError` change.
- Legacy retirement, archive, or delete.
- Evidence write.

## Ground Truth Correction

Compiled-view runtime injection is already enabled with legacy fallback.

P0I/P0J wording such as "no compiled-view runtime injection" means no new compiled-view runtime injection change or expansion was authorized by those notes. It does not mean the actual live setting was disabled.

## Actual Runtime State

The current envelope is compiled-primary with legacy fallback.

Current `/home/worker/.pi/agent/pi-astack-settings.json` values:

- `ruleInjector.compiledViewInjection.enabled=true`
- `ruleInjector.compiledViewInjection.fallbackToLegacyOnError=true`
- `ruleInjector.compiledViewInjection.requireFresh=true`
- `ruleInjector.compiledViewInjection.staleAfterMs=86400000`
- `ruleInjector.compiledViewInjection.maxReadBytes=1000000`
- `ruleInjector.compiledViewInjection.minCoverageRatio=1`

The compiled-view source is `.state/sediment/constraint-shadow/latest/compiled-view.md`.

This session's prompt source is `constraint-shadow-compiled-view`.

## Code Semantics

`readCompiledRuleInjectionForRuntime` validates the decision schema, performs a bounded read, applies the coverage gate using `injectableCoverageRatio` or `coverageRatio`, checks freshness via queued or append-failed pending evidence, applies the active-project section filter, then injects the compiled view.

`composeRuntimeRuleInjection` returns compiled injection when the compiled runtime read is ok. If compiled-view injection is enabled and `fallbackToLegacyOnError=false`, it returns `undefined` on compiled-read failure. Otherwise it returns legacy `composeRuleInjection(cache)`.

## Fresh Evidence

P0J fresh audit convergence passed on the latest comparable row:

- `observedAtUtc=2026-07-05T15:50:38.494Z`
- `status=delta`
- `stale=false`
- `shadowConstraints=37`
- `compiledOnly=18`
- `legacyOnly=6`
- `textDelta=19`
- `inconsistentDiagnostics=0`
- `injectableCoverageRatio=1`
- `queued=0`
- `appendFailed=0`
- `matchedOutcomes=20`
- `mismatchedOutcomes=0`

## T0 P0K Review

- 5/5 reviewers found the current state acceptable for continued operation.
- 5/5 reviewers found `fallbackToLegacyOnError=false` not authorized and not ready.

## Decision

- Current envelope: `ACCEPTABLE_CONTINUE_OPERATION`.
- `fallbackToLegacyOnError=false`: `NOT AUTHORIZED`.
- Legacy retirement: `NOT AUTHORIZED`.

## Blockers For Fallback False

- No explicit JSON/settings parameters were authorized for the change.
- The current audit still has `status=delta` under structural acceptance.
- There is no sustained observation window.
- There is no canary or fail-closed rollback package.
- `legacyOnly=6` settings_not_memory entries are retained and dispositioned but not retireable.
- `textDelta=19` is semantically accepted but not byte parity.
- Fallback false would convert read, coverage, or staleness failure into no-rule injection.

## Required Next Gate Before Fallback False

- Explicit user authorization with JSON parameters.
- Sustained clean latest comparable audit rows across an agreed observation window.
- Canary or shadow-primary fail-closed plan.
- Rollback plan.
- Settings review.
- T0 runtime pass.
- Separate legacy retirement gate.

## Forbidden Actions Remain

- No settings edit.
- No fresh audit.
- No production `~/.abrain` write.
- No runtime flip.
- No `fallbackToLegacyOnError` change.
- No legacy retirement, archive, or delete.
- No evidence write.

## Next Step

If the user wants, prepare a concrete P0L fallback-false gate proposal with JSON parameters, observation window, canary, and rollback. Do not execute it automatically.
