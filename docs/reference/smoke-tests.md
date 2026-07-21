---
doc_type: reference
status: active
---

# Smoke Tests Reference

`package.json#scripts` is the smoke/dossier script live truth. This page documents how to inspect that registry and keeps only stable runbook guidance; do not maintain a copied full script inventory here.

## Current scripts

Derive the current smoke script list from `package.json#scripts`:

```bash
npm pkg get scripts

node -e 'const p=require("./package.json"); for (const name of Object.keys(p.scripts).filter((s)=>s.startsWith("smoke:")).sort()) console.log(`${name}\t${p.scripts[name]}`)'
```

For the default smoke gate, run the package alias instead of expanding it manually:

```bash
npm run smoke:all
```

`smoke:proposition-lifecycle-freshness-d3-pub` remains registered for historical pre-publication reproducibility but is intentionally excluded from `smoke:all`. D3-v2 adapter smokes now verify retained historical/offline code only; D3 has no production rule-injection call edge or runtime authority. P2a.2.1 (`smoke:proposition-policy-push-publication-p2a21`) and P2a.2.2 (`smoke:proposition-policy-push-live-publication-p2a22`) are also historical phase-bound checks and must not be interpreted as current runtime gates.

The ADR0040 production full-flip gate is:

```bash
npm run smoke:proposition-policy-stable-view-publisher  # /tmp-only concurrency/crash publication
npm run smoke:proposition-policy-stable-view-reader     # strict reader + fresh-session staged E2E
npm run smoke:abrain-rule-injector                       # sole-source call graph + sanitation
```

These smokes never invoke real production publication. The operator-only production command is `npm run publish:proposition-policy-stable-view -- --mode production`.

## Live prompt dossiers

Live LLM prompt dossiers are not default release gates. They usually require configured provider credentials/network and are registered under `dossier:*`, not `smoke:*`.

Derive the current dossier list from `package.json#scripts`:

```bash
node -e 'const p=require("./package.json"); for (const name of Object.keys(p.scripts).filter((s)=>s.startsWith("dossier:")).sort()) console.log(`${name}\t${p.scripts[name]}`)'
```

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
npm run smoke:sediment-agent-end-queue
npm run smoke:startup-classify-outside-barrier
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

# Legacy hook cleanup / deterministic device join / production local-drain evidence changes
npm run smoke:abrain-legacy-hook-cleanup
npm run smoke:abrain-device-join
npm run smoke:abrain-git-sync
npm run smoke:canonical-git-runtime
npm run smoke:recovery-history-batch
npm run smoke:convergence-recovery
npm run smoke:production-metadata-prejoin
npm run smoke:production-existing-local-drain
npm run smoke:production-local-drain-next
npm run smoke:script-registry-drift
```

`smoke:sediment-agent-end-queue` drives the real registered extension handler through an awaited fake pi runner. It injects delayed and never-settling startup gates, asserts typical <100ms return with a 5,000-entry branch snapshot (clone bytes/latency metrics recorded; no false hard bound for multi-MB branches), verifies pre-claim coalescing and post-claim ordering, replays 43 entries oldest-first across count/char caps with exact-once ordering, proves same-lineage compaction oldest replay + legacy/unproven lineage fail-closed + branch-switch fail-closed, `ready=false→park→wake` and parked TTL eviction with audit, ready-pending backlog ≥12 windows without a next `agent_end`, multi-session never-ready non-blocking concurrency, global cross-key concurrency cap, `--unhandled-rejections=strict` classifier/correction reject containment with onError/audit, rejects retained ctx/session/UI surfaces, and proves audited rejection containment plus later-job recovery without `unhandledRejection`.

`smoke:memory` / sediment writer regressions also cover: ABOUT-ME staging basename free of wall-clock date/`Date.now`/random (fake clock 2026-01-01→01-02 same draft/session/source → 0 new files/commits, `staging_idempotent`); staging auditable metadata in frontmatter; main-lane partial-window `processedCandidateKeys` without watermark advance when candidate1 succeeds and candidate2 is transient, then retry skips candidate1 and advances after candidate2 success.

`smoke:startup-classify-outside-barrier` is the concurrent cold-start liveness gate. In a real temporary canonical repo, startup A drains an exact Knowledge cohort, advances HEAD, and holds its real recovery-mutation phase longer than B's injected 100ms single barrier timeout. Startup B proves two callers receive the same process-global promise, records `canonical_mutation_busy_retry`, starts every retry from a new `freeze_initial`, and eventually publishes ready without a busy error. A then delays post-mutation final classification for 3s **outside** the barrier; after B finishes its own lock phases, an independent barrier probe must acquire in <500ms and commits a real tracked HEAD drift. A must reject the stale final tuple, recompute, and only then publish ready. Final device settlement checkpoints recovery metadata, and the smoke verifies a clean repo, exact content commit cohort, and no open/quarantined recovery.

The same smoke preserves the low-level timeout contract (`CANONICAL_MUTATION_BUSY`), captures deterministic `10→20→40ms capped` barrier backoff, and proves three normal process-local waiters use one polling waiter plus one successful probe each instead of multiplying flock children. A permanent-holder fixture injects a 140ms startup busy total budget: both abrain/sediment consumers share typed deferred/retryable diagnostics, emit no error, retain no stale reporter or retry timer, then each run `onReady` once after holder release and an external lifecycle-style reschedule. A missing-repo terminal rejection produces one generic error across both consumers. All holders exit naturally; the smoke does not kill processes or touch `~/.abrain`. Smoke-all gives this test a 180s offline minimum.

`smoke:recovery-history-batch` creates a real 4,000-blob Git fixture and requires byte equality with exactly one `cat-file --batch` spawn per 4,000-object operation, independently covering historical snapshot reads and prepared-cohort validation. It also covers missing/non-blob objects, truncated bodies, bad delimiters, blob/output bounds, pre-spawn abort, child-process kill/reap on timeout, and ring-buffer property tests (every header/body/delimiter cut point, random multi-chunk cuts, multi-record, 1-byte grow+compact). `smoke:convergence-recovery` separately locks shared per-commit validation Promise reuse across certified-join and HEAD validation. `smoke:recovery-u-star-production-readonly` production-derived startup children use an explicit hard timeout ≤300s (`PI_ASTACK_PRODUCTION_STARTUP_TIMEOUT_MS`, default 300000) with progress logs; they must not be left unbounded.

`smoke:abrain-device-join` is the focused isolated protocol gate: it creates only temporary repositories and covers deterministic divergence, tracked L2 manifest rebuild, real legacy ignored-manifest adoption with different disk bytes and ignore cleanup, ordinary ignored-create rejection before journal/CAS, ordinary tracked operations and directory/file transitions, fail-closed conflicts, `.state/` retention, changed-gitlink rejection before CAS, journal crash and validated atomic-temp recovery, unknown-dirty rejection, cross-process OFD exclusion, long-compile lock scope, same-shared-promise startup retry across repeated low-level barrier timeouts, legacy-writer/join exclusion, detached-context lease invalidation, CAS races, and bounded exact-OID push retry. `smoke:abrain-git-sync` uses real temporary bare remotes and proves writer delivery performs fetch/join before exact-OID push.

`smoke:production-metadata-prejoin` is a production-derived conditional gate and remains in `smoke:all`. When the configured production source has only the exact registry-validated untracked v1/v2/v3 `1/4/4` recovery cohort, it clones that prestate into a temporary worktree and proves pre-join checkpoint/index convergence without changing the source. After that prestate has been consumed, it skips clone replay only after validating a clean worktree including untracked files, an exact corresponding metadata-checkpoint semantic manifest in reachable history, a subsequent deterministic device join, a tracked and non-ignored Knowledge manifest, and `HEAD` equality with the configured upstream using local refs only; it prints `SKIP:` and exits successfully. Partial cohorts, unrelated untracked files, tracked dirty state, stale/missing upstream refs, and incomplete or unknown publication evidence fail closed. No network fetch is performed. A separate parent process enforces a 360-second hard timeout by default (`PI_ASTACK_PRODUCTION_REPLAY_TIMEOUT_MS` accepts 1,000-600,000 milliseconds).

After deploying a build that introduces the OFD barrier, restart every already-running pi instance before treating these guarantees as active.

The retained ADR0039 standalone CLI is an operator-invoked local integrity checker, not a hook or live runtime/device-sync gate:

```bash
npm run check:adr0039-integrity
```

`recover:constraint-l2-merge-conflict` previews machine JSON by default and, only with explicit `--write`, replaces the unmerged Constraint compiled view from canonical L1 while leaving Knowledge, the index, and the active merge unresolved; its isolated boundary is covered by `smoke:constraint-l2-merge-conflict-recovery`.

For doc-only changes, run at least `npm run smoke:paths` if paths/runtime references were touched. For memory/sediment/vault changes, run the relevant subset above plus any command-specific smoke. For sanitizer or sediment secret-boundary changes, run `npm run smoke:memory` because it covers typed placeholders, prompt redaction, audit raw_text/error redaction, trigger phrase sanitization, and `memory_search` query redaction.

## Historical note

Older audit/docs snapshots listed “15”, “27”, “28”, or other smoke totals and sometimes mixed npm aliases with file names. Treat audit lists as snapshots, not live reference; derive current script names from `package.json#scripts`.
