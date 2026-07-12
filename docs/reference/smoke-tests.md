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

# Legacy hook cleanup / native git-sync boundary changes
npm run smoke:abrain-legacy-hook-cleanup
npm run smoke:abrain-git-sync
npm run smoke:script-registry-drift
```

The retained ADR0039 standalone CLI is an operator-invoked local integrity checker, not a hook or live runtime/device-sync gate:

```bash
npm run check:adr0039-integrity
```

For doc-only changes, run at least `npm run smoke:paths` if paths/runtime references were touched. For memory/sediment/vault changes, run the relevant subset above plus any command-specific smoke. For sanitizer or sediment secret-boundary changes, run `npm run smoke:memory` because it covers typed placeholders, prompt redaction, audit raw_text/error redaction, trigger phrase sanitization, and `memory_search` query redaction.

## Historical note

Older audit/docs snapshots listed “15”, “27”, “28”, or other smoke totals and sometimes mixed npm aliases with file names. Treat audit lists as snapshots, not live reference; derive current script names from `package.json#scripts`.
