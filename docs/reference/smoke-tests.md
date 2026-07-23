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
npm run smoke:proposition-policy-stable-view-recovery   # /tmp-only auto-rebuild/root/lock/adversarial recovery
npm run smoke:proposition-policy-stable-view-reader     # strict reader + fresh-session staged E2E
npm run smoke:abrain-rule-injector                       # sole-source call graph + sanitation
npm run smoke:canonical-session-start                   # canonical-ready detached scheduling + strict post-read
```

These smokes never target a live abrain; their production-mode calls bind only to generated roots below the system temp directory. Canonical-ready recovery is automatic under the 2026-07-21 user authorization. The manual diagnostic rerun command remains `npm run publish:proposition-policy-stable-view -- --mode production` and resolves production from `ABRAIN_ROOT` or `HOME/.abrain`.

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
npm run smoke:memory-tool-rename
npm run smoke:derive-provenance
npm run smoke:tier1-directive-defer
npm run smoke:pr1-adr0028
npm run smoke:evolution-ledger
npm run smoke:memory-path-a
npm run smoke:sediment-agent-end-queue
npm run smoke:sediment-intake-publication
npm run smoke:sediment-knowledge-mutations
npm run smoke:startup-classify-outside-barrier
npm run smoke:staging-resolver
npm run smoke:outcome-classifier-enrich
npm run smoke:forgetting-real-apply-gate
npm run smoke:forgetting-executor-real
npm run smoke:lifecycle-convergence
npm run smoke:entry-lifecycle-proposals
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

`smoke:forgetting-real-apply-gate` drives the exact forgetting orchestration function called by the real `agent_end` path. It constructs eligible E1 proposals across every kind plus a non-E1 attributed-evidence proposal and covers the dedicated/global four-quadrant matrix. The dedicated gate accepts only literal boolean true; the global raw-value matrix follows effective auto-write semantics, accepting boolean true and legacy `"true"` while rejecting staging-only, false/`"false"`, missing, and malformed values. Any closed effective quadrant leaves callbacks unconstructed and proposals pending with the precise `executor_real_apply_gate_closed` or `global_write_authority_gate_closed`; a direct executor injection also proves the second gate cannot be bypassed. Lifecycle hooks continue, while archive reactivation retains its existing independent `autoLlmWriteEnabled` behavior. The production companion `dossier:rm-forget-001-gate-production` is counts/hashes-only: it first stops on any nonzero eligible aggregate, and at eligible=0 proves the armed dedicated/global/AND configuration plus unchanged source/durable/demote/reactivation hashes and action=0. It does not claim a nonzero production executor acceptance.

`smoke:lifecycle-convergence` creates all seven multiview pending states through the production IO writer and checks the source bytes before any reconcile: stable item/cohort/attempt/failure/schedule/deadline/trigger must already exist, the read model must report `unbounded_pending=0`, and a fresh module restart must preserve IDs. It also proves unknown states throw and fail the corrupt-source read model closed, and that a terminal live residue clears stale pending schedules before full-text reversible archive. The remaining coverage includes source reconcile/idempotency, deadline terminal actions, continuity/corruption/cap fail-closed behavior, and conservation. `dossier:rm-lifecycle-002-production` retains the complete self-hash-valid historical 35-row transition preimage while each real wall-clock invocation records and accepts only its own `current_run` before/actions/after.

`smoke:sediment-agent-end-queue` locks the reduced scheduler contract: active-key latest coalescing without loss, same-key serialization, `more` continuation without another lifecycle edge, distinct-session concurrency under the global cap, strict unhandled-rejection containment, and later same-key recovery. It also asserts the queue source no longer exposes `waitUntilReady`, park/wake, TTL/bytes, readyPending, or readiness callbacks, and that sediment index no longer calls the canonical startup consumer.

`smoke:sediment-intake-publication` covers byte-stable create-only intake and exact Pi JSONL branch restoration, a 5,000-entry capture latency bound without transcript cloning, SIGKILL recovery through L1/outbox/checkpoint/ack, two fresh recovery children with exact-once event identity, fail-closed missing source retention, intake write failure audit/notify without enqueue, unknown outbox domain → `failed/`, detached HEAD → pending retry (not `failed/`), atomic groups larger than the ordinary 64 batch target freezing alone, exact-window readiness with legacy session fallback, and a real cross-process OFD-busy scenario where two sessions accept/checkpoint while L2 stays frozen before eventual L2/Git convergence. Its canonical-enabled fixture commits tracked A, leaves valid sibling B untracked with no outbox, freezes batch C, then appends outbox tail D after freeze: first HEAD/L2/manifest contain only A/C, B remains untracked, and D stays pending for the next one-shot. It additionally locks `projectOnWrite=false` L1 inclusion, non-cohort staged preservation, CAS-after-publication crash with pending receipt, HEAD-byte noop replay without a second commit, and no-pending repair-only of dangling L2/manifest with unchanged L1 cardinality. Startup/history recovery and push entry points are not used.

`smoke:sediment-knowledge-mutations` uses a canonical-enabled real temp Git repository and a fresh child holding the real OFD. It covers update, hard delete, archive, supersede, reactivation-as-update, and multi-event merge accepting at L1+eventId-only outbox+checkpoint while L2/HEAD remain unchanged; release then converges through one publisher call. It separately proves scheduler busy returns immediately, incomplete merge batches remain pending, concurrent same-slug events accept from one stable ancestor and fold deterministically, partial merge crash residue completes one stable batch with the same target event, detached HEAD keeps knowledge receipts pending, knowledge outbox stamps `windowId` with exact-window hold, merge members share one window/batch, and replay after stable-parent advancement neither adds L1 nor re-enqueues done outbox work. Status: `accepted` with [production acceptance evidence](../evidence/2026-07-23-sediment-production-acceptance.json). `dossier:sediment-intake-production-readonly` defaults to stdout and writes only with explicit `--output`; it remains read-only and does not consume live intake/outbox.

`smoke:memory-tool-rename` locks the `abrain_get` model-visible registration, legacy dispatch/workflow canonicalization, root and child active tool names, generated memory prompt, historical name recognition, and an Anthropic serializer payload snapshot with no `memory_get` tool definition.

`smoke:memory` / sediment writer regressions also cover: ABOUT-ME staging basename free of wall-clock date/`Date.now`/random (fake clock 2026-01-01→01-02 same draft/session/source → 0 new files/commits, `staging_idempotent`); staging auditable metadata in frontmatter; deterministic missing Knowledge source timestamp returns terminal `source_timestamp_unavailable` and advances without an LLM retry loop; main-lane partial-window `processedCandidateKeys` without watermark advance when candidate1 succeeds and candidate2 is transient, then retry skips candidate1 and advances after candidate2 success.

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
