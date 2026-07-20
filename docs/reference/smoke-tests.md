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
npm run smoke:production-metadata-prejoin
npm run smoke:production-existing-local-drain
npm run smoke:production-local-drain-next
npm run smoke:script-registry-drift
```

`smoke:abrain-device-join` is the focused isolated protocol gate: it creates only temporary repositories and covers deterministic divergence, tracked L2 manifest rebuild, real legacy ignored-manifest adoption with different disk bytes and ignore cleanup, ordinary ignored-create rejection before journal/CAS, ordinary tracked operations and directory/file transitions, fail-closed conflicts, `.state/` retention, changed-gitlink rejection before CAS, journal crash and validated atomic-temp recovery, unknown-dirty rejection, cross-process OFD exclusion, long-compile lock scope, retry after startup barrier timeout, legacy-writer/join exclusion, detached-context lease invalidation, CAS races, and bounded exact-OID push retry. `smoke:abrain-git-sync` uses real temporary bare remotes and proves writer delivery performs fetch/join before exact-OID push.

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
