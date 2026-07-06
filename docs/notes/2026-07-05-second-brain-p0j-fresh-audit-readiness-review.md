---
doc_type: notes
status: active
---

# Second Brain P0J Fresh Audit Readiness Review - 2026-07-05

## Scope

This note records the result of one user-authorized fresh audit and a read-only T0 readiness review.

It does not authorize:

- New fresh audit.
- Production write beyond the already executed authorized audit scope.
- Runtime flip.
- `fallbackToLegacyOnError` change.
- New compiled-view runtime injection change or expansion.
- Legacy retirement, archive, or delete.
- Evidence write.

## Authorization

The user authorized a fresh audit. The actual execution scope was limited to:

- Shadow refresh write to `constraint-shadow/runs` and `constraint-shadow/latest`.
- Dual-read audit append through the existing low-risk entry point.

## Commands

Shadow refresh command:

```bash
npm run dossier:constraint-shadow-report -- --force --write --model openai/gpt-5.5 --max-retries 1 --max-compile-retries 2
```

The dual-read audit was triggered through the existing `runRuleInjectorDualReadAudit` low-risk entry point. The final assessment uses the comparable row with `cwd=/home/worker/.pi`. One non-comparable row with `cwd=/home/worker/.pi/agent/skills/pi-astack` was ignored.

## Fresh Shadow Result

- `ok=true`
- `runDir=/home/worker/.abrain/.state/sediment/constraint-shadow/runs/20260705T153852Z-e7fb9aa30155`
- `latestDir=/home/worker/.abrain/.state/sediment/constraint-shadow/latest`
- `inputRootHash=e7fb9aa301559cb08f2c69434cafbc4e4d82b6a5e02ef760e5bdde677635a8fa`
- `shadowOutputHash=f4f55f3bcb775d0fcbca54859c94b29309a1a880109a27b8e7796277510f63b0`
- `sourceCount=56`
- `constraints=37`
- `exclusions=17`
- `unresolved=0`
- `rulesFileListChanged=false`

## Diagnostics

- `SC_NOT_MEMORY_SETTINGS=6`
- `SC_UNCLASSIFIED=4`
- `SC_MAPPING_DISPOSITION_NORMALIZED=2`
- `inconsistentDiagnostics=0`

## Artifacts

Diff and corpus validation:

- `totalSources=36`
- `mappedSources=36`
- `unmappedSources=0`
- `conflicts=0`
- `validationStatus=valid`
- `coverageOk=true`
- `needsAttention=0`

Event coverage:

- `totalEvents=20`
- `validEvents=20`
- `projectedEvents=16`
- `staleEvents=4`
- `queuedEvents=0`
- `appendFailedEvents=0`
- `deferredMergedSourceEvents=4`
- `coverageRatio=0.8`
- `injectableCoverageRatio=1`

Legacy parallel:

- `matchedOutcomes=20`
- `mismatchedOutcomes=0`

## Latest Comparable Audit Row

- `observedAtUtc=2026-07-05T15:50:38.494Z`
- `cwd=/home/worker/.pi`
- `activeProjectId=pi-global`
- `status=delta`
- `stale=false`
- `legacyRules=25`
- `shadowConstraints=37`
- `compiledOnly=18`
- `legacyOnly=6`
- `bothMatch=0`
- `textDelta=19`
- `compiledOnlyBackfillAllowed=false`

## Delta Interpretation

- `constraints` changed from 38 to 37 and `compiledOnly` changed from 19 to 18. This is accepted because direct-push and parent-pointer events merged into one constraint.
- `staleEvents=4` are `merged_source` / `deferredMergedSourceEvents`, not invalid, queued, or append-failed events.
- `legacyOnly=6` are `settings_not_memory`; the runtime-kill-switch P0H disposition still applies.
- `textDelta=19` is now 6 `normalization_possible` plus 13 `semantic_review_required`. P0G/P0H semantic acceptance still covers all 19.

## T0 Review

- 5/5 reviewers report `convergencePass=true` under `structural_delta_accepted`.
- 5/5 reviewers report `runtimeReadinessPass=false`.
- There are no convergence blockers.
- Runtime readiness still requires separate settings flags review, staleness/read budgets, fallback/rollback plan, canary/shadow-primary plan, T0 runtime review, and explicit user authorization.

## Decision

P0I convergence remains passed on the fresh audit. This closes fresh audit evidence for convergence only.

This does not authorize runtime readiness or runtime flip.

## Forbidden Actions Remain

- No new fresh audit.
- No production `~/.abrain` write.
- No runtime flip.
- No `fallbackToLegacyOnError` change.
- No new compiled-view runtime injection change or expansion.
- No legacy retirement, archive, or delete.
- No evidence write.

## Next Step

Only with explicit user authorization, prepare the runtime readiness package/design. This is still not an automatic flip.
