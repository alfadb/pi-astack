---
doc_type: notes
status: active
---

# Second Brain P0G Semantic Acceptance Review - 2026-07-05

## Scope

P0G is a read-only semantic acceptance review for Second Brain constraint shadow output. It is repo documentation only.

This note does not authorize or perform:

- Runtime flip.
- `fallbackToLegacyOnError` change.
- Compiled-view runtime injection.
- Legacy retirement, archive, or delete.
- Evidence write.

## Input Evidence

Latest artifact and evidence baseline:

- Production shadow decision: `constraints=38`, `exclusions=17`, `unresolved=0`.
- Diff: `validationStatus=valid`, `totalSources=36`, `mappedSources=36`, `unmappedSources=0`, `conflicts=0`, `notMemory=6`, `archivedObserved=11`.
- Event coverage: `injectableCoverageRatio=1`, `coverageRatio=0.9`.
- Legacy parallel delta: `matchedOutcomes=20`, `mismatchedOutcomes=0`.
- Corpus split: `coverageOk=true`, `needsAttention=0`.
- Latest audit row: `observedAtUtc=2026-07-05T12:29:14.313Z`, `status=delta`, `stale=false`, `activeProjectId=pi-global`, `summary legacyRules=25 shadowConstraints=38 compiledOnly=19 legacyOnly=6 bothMatch=0 textDelta=19 inconsistentDiagnostics=0`.

## P0G T0 Review

Round1 produced 5 usable T0 outputs from OpenAI, DeepSeek, Moonshot, MiniMax, and Z.ai. All five returned `ACCEPT_P0G_REVIEW_WITH_BLOCKERS`.

The Anthropic route produced no usable content because of provider/account unavailability and was not counted.

Round2 used the same five usable T0 reviewers. All five reached unanimous refined Option B.

## Consensus

The structural and observability gate passes.

The review accepts 8 `normalization_possible` text deltas and accepts 10 of 11 `semantic_review_required` text deltas as semantic equivalents in this T0 round.

The sub2api sync/release rule remains `human_required` because the user previously deferred that policy call. The runtime-kill-switch remains `human_required` in `legacyOnly/settings_not_memory` because the user previously deferred that policy/settings call.

The config-comments scope caveat only blocks deletion/archive. It does not block P0G semantic review.

P0G review acceptance is not convergence acceptance and not runtime flip acceptance because dual-read status remains `delta` and `compiledOnlyBackfillAllowed=false`.

## Accepted Items

Accepted `semantic_review_required` items:

- Pi-Astack Direction And Detail Ownership.
- Avoid Unnecessary Fallback Material.
- Pi-Global Private Files May Be Tracked.
- Verify Document Claims Against Files.
- Use Literal UTF-8 Output.
- PR Replies And Chinese Metadata.
- Use Glab For Alfadb Git Management.
- No Hard-Wrapped ADR Paragraphs.
- Professional Neutral Vocabulary.
- Production Data Required For Acceptance.

Accepted `normalization_possible` items:

- Use Gh For GitHub Management.
- Base Methodology On Pi-Astack.
- Global Development Methodology Standard.
- Charter Drift Signals Incomplete State.
- L2 Markdown Is Read Only.
- Memory Refactors Require Multi-T0 Consensus.
- T0 Model Choice Is Cost Blind.
- Normalize Windows Paths For UI Labels.

## Remaining Human Decisions

- Sub2api sync/release policy.
- Runtime-kill-switch settings/runtime-governance policy.

Config-comments global legacy deletion/scope acceptance is deletion-only. It is not a P0G semantic review blocker.

## Forbidden Actions

This note forbids treating P0G review acceptance as authorization for:

- Runtime flip.
- `fallbackToLegacyOnError` change.
- Compiled-view runtime injection.
- Legacy retirement, archive, or delete.
- Evidence write.
- Production `~/.abrain` write.

## Validation/Repository State

Repository-only documentation change created at `docs/notes/2026-07-05-second-brain-p0g-semantic-acceptance-review.md`.

No production `~/.abrain` write was performed. No production write command was run.

Validation: `git diff --check -- docs/notes/2026-07-05-second-brain-p0g-semantic-acceptance-review.md` passed.
