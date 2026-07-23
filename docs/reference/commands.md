---
doc_type: reference
status: active
---

# Commands and Tools Reference

## 1. LLM-facing tools

These tools may be visible to the assistant depending on pi settings and sub-pi isolation.

| Tool | Purpose | Notes |
|---|---|---|
| `dispatch_agent({model, thinking, prompt, tools?, timeoutMs?})` | Run one independent in-process sub-agent. | Use only for a single task. `timeoutMs` is the no-progress idle timeout. |
| `dispatch_parallel({tasks, timeoutMs?})` | Run multiple independent in-process sub-agents in parallel. | Both fields live inside the same top-level object; per-task `tools` allowlist supported. Use for 2+ independent tasks. `timeoutMs` is the default per-task idle timeout. |
| `memory_search(query, filters?)` | Semantic retrieval over project + world memory. | ADR 0015 LLM retrieval; hard error if model unavailable. |
| `memory_decide(context, options?, constraints?)` | Synthesize a decision brief from relevant memories. | ADR 0026 Path B: use for high-value decisions where documented history may change the choice. |
| `abrain_get(slug, options?)` | Exact entry lookup. | May expose scope/source_path for debug/provenance. |
| `memory_list(filters?)` | Metadata browsing. | Not relevance-ranked. |
| `memory_activity(options?)` | Read bounded recent activity / attention timeline summaries. | Use only for recent activity, attention timeline, or project allocation questions. |
| `vault_release(key, scope?, reason?)` | Release secret plaintext into LLM context after user authorization. | Do not use for shell commands; prefer `$VAULT_*` injection. |
| `vision(imageBase64? | path?, prompt, mimeType?)` | Analyze image with best available vision model. | For screenshots/photos/diagrams when the current model cannot process images. |
| `imagine(prompt, imagePath?, size?, quality?, style?, inputFidelity?, model?)` | Generate or image-to-image edit via OpenAI image model. | `imagePath` enables local reference-image editing; output saved under `.pi-astack/imagine/`. |

`memory_get` is a configuration/history compatibility name only. Dispatch CSV and persisted workflow JSON load it as `abrain_get`; historical outcome/evidence/replay readers accept both. It is not registered or advertised to models. A resumed historical branch that emits a new `memory_get` tool call cannot execute it because pi has no hidden alias; start a new turn or fork and use `abrain_get`.

## 2. Human slash command groups

### `/abrain`

```text
/abrain bind --project=<id>
/abrain status
/abrain sync
```

- `bind` / `status`: ADR 0017 strict project binding. Required before project-scoped sediment/vault writes. `status` also shows device Git delivery state for the current branch and its configured upstream: ahead/behind counts plus the last push and fetch results.
- `sync` ([ADR 0020](../adr/0020-abrain-auto-sync-to-remote.md)): maintenance trigger for the same automatic protocol used at startup and after canonical writes: native `git fetch`, deterministic device join, then exact-OID push to the configured branch upstream. L1 is add-only unioned, registered L2 is rebuilt from complete union L1, and other tracked paths use fail-closed file-level three-way selection. The repository's current branch, configured upstream, authentication, transport, URL rewrites, and other Git configuration remain device/user-owned. Network/auth/timeout failures are fail-soft; a real bilateral content conflict is reported as a typed fail-closed result and is never guessed by merge-tree, rebase, force push, or LLM merge. `/abrain sync` is a maintenance escape hatch, not a normal requirement for the user. After first deploying the OFD mutation barrier, restart all already-running pi instances before relying on cross-process exclusion.
- `PI_ABRAIN_NO_AUTOSYNC=1` env var disables both startup fetch and post-commit push (for offline / CI use).

### `/memory`

```text
/memory migrate --dry-run
/memory migrate --go
/memory lint [target]
/memory doctor-lite [target]
/memory check-backlinks [target]
```

Notes:

- `/memory migrate --project=<id>` is deprecated and rejected.
- Migration reads active project binding from `/abrain bind` artifacts.
- `_index.md` and graph are derived artifacts.

### `/sediment`

```text
/sediment status
/sediment dedupe --title <title>
```

Sediment writing normally happens on `agent_end`; these commands are diagnostics/maintenance, not general write tools.

### `/vault` and `/secret`

```text
/vault status
/vault init [--backend=<backend>]
/secret set [--global|--project=<id>] <key>=<value>
/secret list [--global|--project=<id>|--all-projects]
/secret forget [--global|--project=<id>] <key>
```

`/vault init` defaults to `--backend=abrain-age-key` ([ADR 0019](../adr/0019-abrain-self-managed-vault-identity.md)): abrain self-managed age keypair, identity gitignored, no reuse of `~/.ssh/id_*`. Explicit `--backend=ssh-key | gpg-file | passphrase-only` selects a Tier 3 legacy backend and produces a stderr warning about cross-device transport burden (or, for `passphrase-only`, the unimplemented reader tty pass-through).

`/secret` defaults to active project scope when bound; `--global` opts into global vault.

### `/compaction-tuner`

```text
/compaction-tuner status
/compaction-tuner trigger
/compaction-tuner reset
```

Reads settings from `~/.pi/agent/pi-astack-settings.json#compactionTuner`.

`summaryModels` is optional and defaults to `[]`, meaning **no override**: pi core compaction summarizes with the current main-session model. To use a dedicated summarization fallback list, opt in explicitly, for example:

```json
"compactionTuner": {
  "enabled": true,
  "thresholdPercent": 75,
  "summaryModels": [
    "anthropic/claude-sonnet-4-6",
    "deepseek/deepseek-v4-pro"
  ]
}
```

If every configured summary model fails, compaction-tuner returns control to pi core's default compaction path.

## 3. Bash secret injection

```bash
$VAULT_<key>   # project first, then global fallback
$PVAULT_<key>  # project only
$GVAULT_<key>  # global only
```

Use this instead of `vault_release` when plaintext only needs to reach a subprocess.

Suffix matching (`extensions/abrain/vault-bash.ts:97-104`) expands `$VAULT_<suffix>` to up to four candidates (raw / `_`→`-` / lower / lower+`_`→`-`) and picks the first present `.md.age`. Prefer one canonical casing per key.

## 4. Sub-agent tool allowlist and env gates

These govern what `dispatch_agent` / `dispatch_parallel` sub-pi processes can do. Authoritative implementation: `extensions/dispatch/index.ts`.

| Scenario | Effective `tools` |
|---|---|
| Main session calls `dispatch_agent` / `dispatch_parallel` without `tools` | **Default `read,grep,find,ls,web_search,web_fetch,memory_search,abrain_get,memory_decide`**. Not `[]`. |
| `tools: "read,grep,find,ls,web_search,web_fetch,memory_search,abrain_get,memory_decide"` | Explicitly matches the default read-only file/search, web, and targeted memory facade. |
| `tools` includes any of `bash` / `edit` / `write` | **Accepted** (2026-06-16): swarm workers may edit/write/run shell when the caller explicitly lists them. The old `PI_MULTI_AGENT_ALLOW_MUTATING` env gate was removed from the dispatch path (rationale: brain writes are git-recoverable; single-user threat model; see ADR 0003). The **workflow** channel keeps its own env gate via `enforceMutatingEnvGate` (ADR 0033 W9). |
| Sub-agent tries to call `dispatch_agent` / `dispatch_parallel` | **Always rejected.** Nested dispatch is unconditionally blocked. |

Sub-pi processes also inherit `PI_ABRAIN_DISABLED=1` (forced override after `...process.env`, so `export PI_ABRAIN_DISABLED=0` cannot defeat it). Inside a sub-pi the `abrain` extension's `activate()` early-returns without registering `vault_release`, `/vault`, `/secret`, or any vault hooks.

## 5. Transition / advanced commands

These commands exist for migration, diagnostics, or compatibility. They are not part of the normal second-brain workflow; prefer natural conversation plus background sediment unless a runbook specifically asks for one.

| Command | Status |
|---|---|
| Explicit memory fences | Lane A/G compatibility path for migration/debugging only. Do not promote as normal workflow; natural conversation plus background sediment is the default path. |

## 6. Pending / not current commands

The following names may appear in archived docs but are not current command surface:

| Old/pending command | Status |
|---|---|
| `pi memory migrate ...` | Use slash `/memory migrate ...` in pi session. |
| `/memory migrate --project=<id>` | Deprecated/rejected; use `/abrain bind --project=<id>` first. |
| `pi project switch <id>` | Not a current pi-astack command. |
| `pi brain rebuild-index` / `/memory rebuild` | Not a command; the `/memory rebuild` slash was retired 2026-06-15. graph/index are rebuilt internally by migrate/ingest + search-time auto-reconcile. |
| `pi brain review-staging` | Roadmap idea, not implemented. |
| `/vault import-env` / `/vault migrate-backend` | Vault P0d/P1 roadmap, not implemented. |
| `/sediment migrate-one` / `/sediment migration-backups` | Removed with per-file migration substrate. |
