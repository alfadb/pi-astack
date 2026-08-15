# T0 Production Replay (fair prompt-only)

Production replay of current models on real production task prompts from the
existing anonymous T0 episode dataset, **selected only via the fair
prompt-only selection manifest**.

Two experiment modes:

1. **Fair default (source thinking)** — `deepseek/deepseek-v4-flash` +
   `xai/grok-4.5`. Same neutral system/user, NO tools, thinking = each source
   episode's original `thinking_level`. Body may include historical + replay
   slots (indistinguishable). `--thinking` override is forbidden.
2. **`--current-only` (equal conditions)** — Flash + Grok + `openai/gpt-5.5`
   control. Same neutral system/user, NO tools, thinking unified to explicit
   `high` (bound into protocol hash). Body contains **only** the three current
   candidates (`history_excluded=true`). An episode enters the paired
   capability main set only when **all three** succeed. Manifest fields:
   `experiment_mode=current_models_equal_conditions`, `thinking=high`,
   `history_excluded=true`. This is **prompt-only judgment qualification**,
   not agentic execution capability.

**Unified prompt-only counterfactual.** Every replay is a **no-tools,
prompt-only counterfactual**: the model receives the same neutral system
prompt, the same prompt-only capability contract (no tools, browsing,
search, files, workspace or live external state; answer from the task prompt
+ existing knowledge only; never announce or attempt tool use; output the
complete final answer directly), and the same thinking policy per mode. The
protocol text is identical for every model / episode / attempt and is bound
into the checkpoint `protocol_hash` (including the retry hint).

**`tools:null` caveat.** Historical episodes carry `tools: null` in the body,
which only means **no explicit tools allowlist was recorded** for that
episode — it is NOT evidence that the historical model ran with an empty
effective toolset, and it does NOT establish a strict equal-runtime
capability delta between historical and replay answers. Replay answers are
prompt-only by construction; historical answers are not. Capability claims
must be scoped to the replay counterfactual, never inferred from
`tools:null`.

Unsupported thinking levels and generation degeneration fail closed (sidecar
only; successful attempts always have `error_class=null`).

Selection must carry full `selected[]` records (`episode_ids-only` is
rejected). `--allow-legacy-select` is fixture-only and cannot combine with
`--current-only`.

## Pipeline

```
t0-replay-select.mjs     fair prompt-only selection + dual-judge classification
                         → selection.json ONLY (no Flash/Grok; no build/run)

t0-replay-build.mjs      MUST consume --selection <manifest.json>
                         validates kind/schema/protocol, selected ids,
                         join_confidence, tools=null, classifier/downstream
                         judges; builds ONLY selected episodes

t0-replay-eval.mjs       wrapper: t0-eval on a COMMITTED replay dataset
                         (--dataset <dir>; rejects bare --episodes/--meta/
                         child-internal flags; pins the fixed judge roles)
t0-replay-aggregate.mjs  aggregate by real model + replay/historical report
                         (--dataset <dir> + --eval <dir>; rejects bare
                         --episodes/--meta)
```

**No legacy selector bypass.** CLI without `--selection` fails closed. The
internal `selectReplayEpisodes` helper remains for fixture unit tests only
(`--allow-legacy-select`). Old `/tmp/t0-replay-pilot-*` unfair pilots must
never be read as input.

## Default judge roles (`t0-replay-eval`)

| role | model |
|---|---|
| evaluator0 | `openai/gpt-5.6-sol` |
| evaluator1 | `anthropic/claude-opus-5` |
| verifier | `kimi-coding/k3` (temporary paid high-value use — third vendor) |
| adjudicator | `openai/gpt-5.6-sol` |
| counterfactual | `anthropic/claude-opus-5` |

The fair selection manifest already excludes these three judge candidates
from historical slots. K3 system/user canaries are part of
`dossier:t0-replay-production`.

## Fair selection (`t0-replay-select`)

Shared implementation: `scripts/t0-replay-fair-common.mjs`.

Hard gates: `join_confidence ∈ {exact, heuristic}`, `tools === null`,
body/meta 1:1, self-contained, ≥1 strong reference, ≥1 specialist, no
downstream-judge candidates. Dual LLM classification (default Sol + Opus5).

```bash
npm run t0:replay-select -- \
  --output ~/.pi/.pi-astack/t0-replay-fair/selection.json \
  --classifier-models openai/gpt-5.6-sol,anthropic/claude-opus-5 \
  --downstream-judges openai/gpt-5.6-sol,anthropic/claude-opus-5,kimi-coding/k3
```

`--exclusions <path>` / `--stats <path>` (default: same dir as `--meta`)
name the source `exclusions.jsonl` / `stats.json`; the selector asserts the
FULL producer inventory (episodes + meta + exclusions + stats) before any
invoker work.

**Strict closed-allowlist CLI.** The selector's raw argv is parsed by the
shared `parseStrictCli` (closed allowlist; space form only): `--flag=value`
forms, unknown flags, positional arguments, non-repeatable duplicates
(`--episode` is the only repeatable value flag), value flags with a missing
value, and boolean flags given a value are all rejected — a malformed argv
can never silently resolve the production default paths. Raw value gates
apply on top: `--limit` / `--max-retries` must be non-negative integers,
`--concurrency` / `--timeout-ms` positive integers, and every other value
non-empty after trim (pure whitespace is rejected). Explicit CSV values
(`--episode` / `--classifier-models` / `--downstream-judges`) must be
semantically non-empty — every comma segment must be non-empty after trim
(`,` / `,,` / `ep-a,,ep-b` fail closed instead of silently dropping empty
segments, which could otherwise widen the selection or fall back to
defaults via `parseModelList`'s null); `--episode , --output …` throws
before parse and never becomes a full run.

**Classify mode requires a durable checkpoint target.** In classify mode
(non-`--hard-only`) the selector MUST have a checkpoint directory —
explicit `--checkpoint-dir` or derived from `--output` (same-dir
`checkpoints-fair`) — otherwise it throws BEFORE any load / invoker /
provider work: paid classifier requests must always have a durable target
for their recorded facts/cost. `--hard-only` listings need no checkpoint
target.

**Checkpoint root vs leaf (single shared helper).** The checkpoint
directory the selector owns (`--checkpoint-dir` / derived
`checkpoints-fair`) is the checkpoint **ROOT**; the actual
`<episode_id>.json` files live in the **LEAF** `root/checkpoints`.
`classifierCheckpointDir(root)` is the single helper that computes the
leaf (`path.join(root, "checkpoints")`), and `classifierCheckpointPath(
root, episodeId)` resolves every checkpoint read/write through it — the
root/leaf split can never drift. `classifierCheckpointPath` also enforces
the safe-id contract (`assertSafeEpisodeId`: `../`, path separators, NUL,
`.` / `..` are rejected) BEFORE any file is created or touched, so a
traversal episode id can never escape the leaf. Provenance consumers
(`validateFairManifestProvenance` / `publishSelectionManifest`) take the
**LEAF** as their `checkpointDir` parameter — never the root: the CLI main
derives it via `classifierCheckpointDir(options.checkpointDir)` before
publishing, and the dossier/build consumers pass the leaf directly
(`checkpoints-fair/checkpoints`).

**Full-batch checkpoint preflight before any paid request.** After the full
producer inventory passes and BEFORE `makeJudgeInvoker`, the selector runs
the pure read-only `preflightClassifierCheckpoints` over THIS run's hard
candidates (same episodeIds / limit / strongRefs / specialists /
downstreamJudges / judgeModels / thinking as the real selection): with
`resume` a missing checkpoint (cache miss) and a valid `completed`
checkpoint are allowed, while a failed / malformed / stale /
identity-mismatched / body-invalid checkpoint throws; with `--no-resume`
ANY existing checkpoint throws (paid facts are never wiped). A bad
checkpoint for candidate B is therefore discovered before candidate A sends
any paid request — no writes, no invoker, no provider calls.

**Selector output contract (fail-closed).** In classify mode the selector
removes any existing output manifest BEFORE any full-argument validation
that can throw and before any real invoker/provider work (a minimal safe
`preflightOutputIntent` scan of the raw argv — only the uniquely
determinable `--output` path is revoked; multiple DIFFERENT `--output`
values or a value-less `--output` are ambiguous, nothing is deleted, and
`parseArgs` rejects the invocation with a clear error; a repeated IDENTICAL
`--output` value is still uniquely determinable and is revoked, but
`parseArgs` rejects any duplicate occurrence). A malformed but uniquely
determinable `--output=<nonempty path>` (equals form) is also recognized
and revoked before the strict parse fails; multiple different outputs or an
empty `--output=` stay ambiguous/null and delete nothing. `--hard-only=true`
still classifies intent (its unique `--output` is revoked), while a bare
`--hard-only` stays hard-only and pre-deletes nothing. So a failed run never
leaves
a stale manifest that looks current. The new manifest is published
**atomically** (same-dir temp file + rename) only on success and only AFTER
the `data_insufficient` check; a crash/failure mid-write never leaves a
partial manifest at the canonical path and the temp is cleaned up. If any
classification fails, the selector exits non-zero and writes **no manifest**
(see the state contract below) — callers must treat a missing manifest /
non-zero exit as "no valid selection", never as an empty or partial sample.
`--hard-only` stays fully offline, does NOT pre-delete an old output, and
uses the same atomic publish (success atomically replaces). `--hard-only`
is a bare flag: `--hard-only <value>` is rejected by `parseArgs` (and
`preflightOutputIntent` follows the same parseCli semantics — a value form
is classify intent, so the unique `--output` is revoked before the parse
fails).

**Filtered classify runs never publish a manifest.** In classify mode, any
execution filter (`--episode <ids>` or `--limit <n>`, including `--limit 0`)
combined with `--output` is refused: after the old output has been revoked
by the preflight, the selector throws BEFORE any strict load / invoker /
provider work — nothing is classified, nothing is published and no tmp /
checkpoint is left behind. A filtered classify run is a DIAGNOSTIC, never
a complete production manifest (its counts would not cover the full
corpus). `--hard-only` listings may still filter and output (they are not
classified production manifests), and classify WITHOUT `--output` stays a
legal diagnostic run (it produces no consumable manifest).

**Data-insufficient classify runs publish nothing.** When classification was
requested and fewer than 2 replayable episodes survive, the selector exits
with code 2 and does NOT publish a manifest — a `<2` replayable classified
set is not a valid production manifest. Successful checkpoints are kept
(they are the durable state and are reused by a later run). `--hard-only`
listings are not production classified manifests and may output any count.

**Single-writer constraint.** The canonical selector output
(`selection.json`) does NOT support concurrent writers: callers must
serialize invocations on the same output path (the production dossiers are
serial). The atomic publish only guarantees single-writer crash/partial-write
safety — it is not a concurrent transaction.

**Strict corpus loading + producer inventory.** The selector (both
`--hard-only` and classify mode) and the replay build strict-load the source
`episodes.jsonl` / `episodes.meta.jsonl` (`loadEpisodes(…, { strict: true })`
/ `loadMeta(…, { strict: true })`): any non-empty line that fails JSON
parse, any non-object record, any missing/invalid `episode_id`, any
`episode_id` with leading/trailing whitespace (a `"ep-x "` id is a
different identity than `"ep-x"` and would silently split the corpus) and
any duplicate `episode_id` throws with the path + 1-based line number — a
malformed or duplicated corpus fails closed instead of silently shrinking
the candidate set.

**The four-file dataset is an atomic input/relocation unit.**
`episodes.jsonl` + `episodes.meta.jsonl` + `exclusions.jsonl` + `stats.json`
are one producer inventory: the corpus, its identity sidecar, the terminal
exclusions and the build stats must form a consistent whole, and the whole
moves/relocates together. After the strict loads and BEFORE any
invoker/provider work, the selector, the build and all three production
dossiers assert the FULL inventory via the shared pure
`validateProducerInventory` / `assertProducerInventory`
(t0-eval-common.mjs): every episode must have a meta record (an episode
without meta would otherwise be silently hard-excluded as `meta_missing`,
shrinking the candidate set while the manifest and its provenance rebuild
stay self-consistent over the shrunken corpus — the complete
manifest/corpus bypass); body/meta slots match 1:1 by `slot_id`;
`model_count` === distinct body model ids === distinct in-body meta models;
and the stats close over the corpus (`groups.episodes` /
`episodes_below_min_after_availability` / `episodes_ambiguous_identity` /
`availability.episodes_too_large` /
`availability.slots_excluded_by_reason.below_min_models_after_availability`).

**Legal terminal meta contract.** Orphan meta records (meta for episodes
whose body never materialized — t0-episode-build deliberately writes sidecar
records for below-min-models episodes) are ONLY legal as the below-min
terminal set: the orphan meta ids must equal the episode-level
`below_min_models_after_availability` exclusion ids bidirectionally, the
exclusion's `model_count` must equal the distinct below-min slot model count
and be `< stats.filters.min_models`, and the stats must agree. An arbitrary
orphan (meta without a below-min exclusion, or a below-min exclusion
without meta) fails closed — it is never a tolerated state. The old
`assertEpisodeMetaParity` helper remains for general set-closure callers,
but it only reports orphans; legality is established exclusively by
`validateProducerInventory`. The judge feed is unchanged: it still reads
ONLY `episodes.jsonl` (the anonymous blind body) — identity material stays
out of the judge path.

### Classifier state contract (`classification_status`)

Every classifier checkpoint `final` carries an explicit
`classification_status: "completed" | "failed"` (required by
`FINAL_CLASSIFICATION_SCHEMA`; never inferred from `reasons`):

- **completed** — mechanical hard exclude, or a legal dual-judge merge
  (including semantic non-replayable / disagreement). The final carries the
  merged `flags` / `disagreement` / `judgments`.
- **failed** — at least one judge produced no valid judgment (preflight /
  auth / http / timeout / truncation / schema / content). The failed
  checkpoint still saves the **full diagnostics**: both judge keys, the
  partial success judgment (or `null` per judge), `attempt_log` with
  `request_id` / cost, and the final carries NO merged
  `flags`/`disagreement`/`judgments`.

**Existing checkpoints fail closed — never a cache miss, never overwritten.**
`loadClassifierCheckpoint` returns a checkpoint only when it is a valid
`completed` final under the CURRENT contract. Any EXISTING checkpoint that
is not that — malformed / unknown / stale (`ledger_version`,
`schema_version`, `protocol_hash`) / identity-mismatched (`episode_id`,
`prompt_hash`, `judge_models`, `thinking`) / body-invalid (fails the
recomputable body contract) — THROWS a clear error before any
invoker/provider call: it is never treated as a cache miss and never
silently re-classified. A valid `failed` checkpoint (any judge without a
valid judgment) is a **terminal DIAGNOSTIC artifact**: resume throws
("not resumable, not overwritable") instead of re-calling the judges —
re-calling would duplicate paid facts, and overwriting would erase the
recorded `request_id` / cost evidence. The operator must archive/move the
checkpoint out of the active directory (preserving the recorded facts/cost)
or use a fresh checkpoint dir — never delete it. `--no-resume` follows the
same rule in reverse: if the target episode
checkpoint already exists (valid OR invalid), it throws before any
invoker/provider call — paid facts are never wiped by `--no-resume`.
Checkpoint saves are **atomic create-if-absent**: same-dir temp file +
flush/fsync + link-publish, so a crash never leaves a partial file at the
canonical path and a second save / concurrent writer (race loser) is
rejected (EEXIST) — an existing file is never overwritten.
`selectFairReplayEpisodes` fails closed after all hard candidate
classifications are saved: if any result is not `completed` it throws with
the episode id(s) + reason summary and returns **no partial manifest** — a
failed episode is never silently dropped as an ordinary exclusion.
`validateFairManifestProvenance` admits only `completed` checkpoints; any
`failed` checkpoint is a provenance error and can never enter the finals
rebuild. `t0-replay-build`'s `loadAndValidateSelection` rejects any
manifest whose `selected`/`classifications`/`excluded` rows
carry `judge_call_failed` / `execution_failure` or a non-`completed`
`classification_status` (when present) — the 10-key classification row does
not repeat checkpoint status, so a complete successful manifest is
unaffected.

### Complete classified manifest loader gate (`loadAndValidateSelection`)

The replay build's manifest loader is a fail-closed DEPTH gate on the full
classify-mode selector product — a hand-written, partial, malformed,
null-row, data-insufficient or hard-only manifest cannot bypass it by
omitting classifications or counts. It is a STRUCTURAL gate over the
manifest shape only: it cannot prove provenance from a hand-written shape
alone (a fully self-consistent shrunken manifest passes it — that is what
the full `validateFairManifestProvenance` REBUILD is for, which the
production dossiers AND the direct `t0-replay-build` run on the canonical
manifest before any request; see below):

- **identity**: `classify===true`, `hard_only===false`, `limit===null`;
- **selected**: must be an array of JSON-object rows, `selected.length >= 2`
  (a fair prompt-only replay set needs at least 2 replayable episodes), every
  row a non-null object with `episode_id === episode_ids[i]` (same length and
  same order), ids unique and non-empty `ep-`-prefixed, per-row
  `join_confidence ∈ {exact, heuristic}`, `tools===null`, `replayable===true`;
- **classifications**: must be present and an array; every entry a non-null
  object with a non-empty unique `ep-*` `episode_id`; classifications must
  cover EVERY selected episode id (a hard-pass candidate without a
  classification is rejected);
- **excluded**: must be an array of non-null objects with non-empty unique
  `ep-*` `episode_id`s; `counts.excluded === excluded.length`; every
  NON-hard excluded row (stage !== "hard") must have a classification — hard
  exclusions legitimately have none;
- **exact partition**: selected is disjoint from ALL excluded; hard-excluded
  episodes never appear in classifications; every classification row's
  `replayable` is a boolean that is `true` iff the episode is selected and
  `false` iff it is a non-hard exclusion (never both); the classification id
  set is EXACTLY `selected ∪ non-hard-excluded` (bidirectional — an orphan
  classification or a missing classification is rejected);
- **counts closure**: `counts.classified === classifications.length`,
  `counts.replayable === selected.length`, `counts.data_insufficient ===
  false`, `counts.hard_pass_limited === classifications.length`,
  `counts.hard_pass === classifications.length` (full/no-filter classified
  manifest), `counts.source === hard_pass + hard-exclusion count`;
- **failed rows**: the `judge_call_failed` / `execution_failure` /
  non-`completed` scan covers selected / classifications / excluded all
  three places.

**Direct build provenance.** `t0-replay-build` does NOT rely on the loader
alone: after the depth gate (and the `--episode` execution-subset checks,
which require ≥ 2 unique ids that are a subset of the selection, all before
any invoker/blind-key work), `buildReplay` runs the FULL
`validateFairManifestProvenance` on the selection manifest — checkpoint dir
fixed to the selection-adjacent `checkpoints-fair/checkpoints` — before any
blind-key write and before any invoker/provider request. This verifies the
current `classifierProtocolHash`, rejects stale-ledger checkpoints and
reconstructs the complete producer output from the real corpus +
checkpoints; a failure reports the first 10 errors and creates no
invoker/output. (The validator is loaded via a safe dynamic import inside
the async build body — t0-replay-fair-common statically imports this
module, so a top-level static import would be a cycle.)

**Result contract version.** `CLASSIFIER_RESULT_CONTRACT_VERSION` (2) is a
dedicated classifier result/checkpoint contract version, bound into
`classifierProtocolHash()` (independent of `ATTEMPT_LEDGER_VERSION` = 2).
v1 → v2 changed the checkpoint LIFECYCLE contract (see "Existing
checkpoints fail closed" above): existing checkpoints are fail-closed
instead of cache-miss (malformed / stale / failed checkpoints throw before
any provider call), `--no-resume` refuses to overwrite, and saves are
atomic create-if-absent. Bumping it invalidates every old checkpoint /
manifest: v1 checkpoints carry a different `protocol_hash` and fail closed
as stale — they are never resumed or admitted (old finals without
`classification_status` also fail `validateFinalClassification`).

## Build / run (`t0-replay-build`)

```bash
# Fair default (source thinking; historical+replay body)
npm run t0:replay-build -- \
  --selection ~/.pi/.pi-astack/t0-replay-fair/selection.json \
  --output ~/.pi/.pi-astack/t0-replay-fair-run

# Current-only equal conditions (Flash+Grok+GPT-5.5, thinking=high, no history)
npm run t0:replay-build -- \
  --selection ~/.pi/.pi-astack/t0-replay-fair/selection.json \
  --current-only \
  --output ~/.pi/.pi-astack/t0-replay-current-run

npm run t0:replay-eval -- \
  --dataset ~/.pi/.pi-astack/t0-replay-current-run \
  --output ~/.pi/.pi-astack/t0-replay-current-eval

npm run t0:replay-aggregate -- \
  --dataset ~/.pi/.pi-astack/t0-replay-current-run \
  --eval ~/.pi/.pi-astack/t0-replay-current-eval
```

Both wrappers consume ONLY the committed replay dataset. `t0:replay-eval`
requires a unique value-bearing `--dataset <dir>` and rejects bare
`--episodes` / `--replay-dataset` / `=`-forms / value-less or duplicate
`--dataset` (the child-internal `--replay-dataset` flag is injected by the
wrapper, never accepted from the CLI), and pins `--models` to the fixed
replay judge roles — an override that is not the exact five-role assignment
is rejected BEFORE the child is spawned (zero invoker). `t0:replay-aggregate`
requires `--dataset <dir>` (default `~/.pi/.pi-astack/t0-replay`) and rejects
bare `--episodes` / `--meta` — the corpus is ONLY the committed dataset,
never raw files.

### Build CLI options

**Strict raw CLI grammar.** `t0-replay-build` accepts only the space form
(`--flag value` / bare `--bool`); `--flag=value`, unknown/positional tokens,
non-repeatable duplicates, missing values, boolean-with-value, empty values
and invalid raw numerics all fail closed before any default production path
is resolved (`--episode` is the only repeatable value flag). Every supplied
value must be non-empty after trim (pure whitespace is rejected); explicit
CSV `--episode` / `--models` values must be semantically non-empty — every
comma segment must be non-empty after trim (`,` / `,,` / `ep-a,,ep-b` /
`model,,x` fail closed instead of silently dropping empty segments, which
could otherwise widen a selection or fall back to the default model set),
and the default `--models` resolve only when the flag is completely absent.

| Option | Default | Meaning |
|---|---|---|
| `--selection <path>` | **required** | fair `prompt_only_replay_selection` manifest (full `selected[]`) |
| `--current-only` | off | equal-conditions mode (3 models, thinking=high, history excluded, paired body) |
| `--episodes <path>` | `~/.pi/.pi-astack/t0-episodes/episodes.jsonl` | source body |
| `--meta <path>` | same dir | source identity sidecar |
| `--exclusions <path>` | same dir as `--meta` | source `exclusions.jsonl` (part of the atomic producer inventory) |
| `--stats <path>` | same dir as `--meta` | source `stats.json` (part of the atomic producer inventory) |
| `--episode <id>` | — | optional execution subset of selection ids: ≥ 2 unique ids, all present in the selection manifest (rejected before any invoker/blind-key work); only narrows THIS run — the manifest itself is always validated in full |
| `--models <csv>` | Flash,Grok (or Flash,Grok,GPT-5.5 under `--current-only`) | replay models |
| `--output <dir>` | `~/.pi/.pi-astack/t0-replay` (or `t0-replay-current-run`) | output dir |
| `--concurrency <n>` | `2` | parallel episodes |
| `--max-retries <n>` | `2` | per-call retries |
| `--timeout-ms <n>` | `600000` | per-call timeout |
| `--min-models <n>` | `2` (or all candidates under `--current-only`) | min distinct models in body |
| `--max-output-bytes` / `--max-episode-bytes` / `--max-total-bytes` | 200k / 1M / 500M | resource caps (fail-closed) |
| `--no-resume` | off | ignore checkpoints |
| `--allow-legacy-select` | off | fixture-only legacy selector (forbidden with `--current-only`) |
| `--thinking` | forbidden on fair path; only `high` under `--current-only` | thinking override |

Fair path: each episode uses its source `thinking_level`. If a model does not
support that level (`thinkingLevelMap[level] === null`), the slot fails closed
as `thinking_level_unsupported` / `infrastructure_or_generation_failure`.

Current-only: thinking is unified to `high` for all candidates and is part of
the protocol hash. Any model failure excludes the episode from the paired
capability body (`not_fully_paired`); sidecar retains attempts/cost.

### Anonymous body contract

Body fields only:

- `schema_version`, `dataset_mode`, `episode_id`, `prompt`, `thinking`,
  `tools` (always `null`)
- `slots[{slot_id, model_id, output, result}]`

Removed from body: `output_source`, `join_*`, `source_*`, history/replay
markers, cost/attempt/identity. Under fair default, historical and new slots
are **indistinguishable** in the body. Under `--current-only`, body has only
the current candidates (no historical answers). All identity, source prompt
hash, real models, attempt, cost, join live in `episodes.meta.jsonl`.

**Session-id redaction (full UUIDv7 shape).** Session ids are UUIDv7
(`8-4-7xxx-variant-12`, e.g. `019ff87f-13bd-70c8-abca-e4bb132c6140`; the
`019e`/`019f`/`01a0` ULID-style prefixes are just the timestamp half). Both
the production redactor (t0-episode-build.mjs) and the independent oracle
(_t0-replay-oracle.mjs) match the FULL shape — never a bare `019f` prefix —
so any UUIDv7 in prompt/output text is replaced with `[session]` (or rejected
by the oracle), while UUIDv4 ids and the anonymous `rep-`/`slot-` HMAC ids
are never matched.

**Unified replay-content transform (prompt / historical / replay).** The
SAME transform is applied to the source prompt, every publishable historical
output and every successful replay output: the episode-local redactor
(UUIDv7 → `[session]`, `dtr_…` run ids → `[run]`, corpus model names /
family tokens / leak fragments → one episode-local `[model-x]` pseudonym per
entity) followed by source episode-id redaction
(`ep-<16 hex>` → `[episode]`). Model aliases cover the full `-`/space/`_`
separator combination (`claude_opus_4-8` / `gpt_5.6_sol` /
`deepseek_v4_flash` are the same entity token as the canonical dash form,
so an underscore-internal alias never leaves a `4-8`/`5.6`/`v4` residue);
pure numeric compound parts (`4-8`) are internally re-expanded into their
digits, so the underscore form of a version run is a whole alias token too
(`claude_opus_4_8` / `claude-opus-4_8` / `claude_opus_4-8` are the SAME
entity token — never a leftover `_8`). Alias input is fail-closed bounded:
an empty / over-long basename, an empty part (leading / trailing / double
hyphen) or more than 8 expanded parts throws before any token/regex/provider
work. Model identity entities are ALIAS-CONNECTED COMPONENTS over the
case-insensitive `[basename, ...aliasVariants]` token sets (a small DSU
equivalence closure): two routes sharing one basename
(`github-copilot/gpt-5.5` + `openai/gpt-5.5`), or one basename being
another model's alias variant (`claude-opus-4-8` +
`vendor/claude_opus_4_8` + `vendor2/Claude Opus 4 8`), are ONE anonymous
model identity whose full refs / bare basenames / aliases all share one
pseudonym, corpus-order independent (the component key is the minimum
lowercased alias token — a per-route / per-case first-wins split could
never make both full refs AND the bare basenames consistent, and no two
model entities can ever share a replaceable token) — the body never claims
per-route same-basename distinguishability. The source id
is matched with an
ALPHANUMERIC-CONTEXT, case-insensitive pattern
(`(?<![A-Za-z0-9])ep-<16 hex>(?![A-Za-z0-9])`, `i`): `_` is a word char so
`\b` would miss `artifact_ep-0123456789abcdef.json`, and the ids are
canonical lowercase but a quoted/uppercase form (`EP-0123456789ABCDEF`)
must still be caught — both are replaced with `[episode]` (the separator
context is preserved: `artifact_ep-…` → `artifact_[episode].json`). The
lookarounds never match the anonymous `rep-<16 hex>` / `slot-rep-…` HMAC
ids (`ep` there is preceded by an alphanumeric `r`), so the anonymous ids
survive untouched. The residual old-style
ids (`mN`) are deliberately NOT part of the redactor's entity universe: they
are forbidden by the source preflight (fail-closed), so an ordinary
criterion like `M2` is never silently rewritten into a model pseudonym —
never guess.

**Full source-body preflight (prompt + publishable historical outputs,
BEFORE any provider work).** The shared pure `sourceBodyTexts` definition
mirrors exactly what would enter the body: the prompt is ALWAYS included;
a historical slot output is included ONLY when `history_excluded=false` AND
the slot has a matching meta model AND the output is non-empty. An orphan /
non-body / non-published historical surface never affects the redactor or
the preflight; `--current-only` / `history_excluded` still checks the
prompt. Every source body text is scanned with the producer's fail-closed
semantics: a bare context-ambiguous identity token / residual id (a
standalone `K2`/`M2`/`M3`/`K3`/`v4-pro`/`v4pro`, or any `mN` old-style id)
can never be reliably redacted, so the whole source episode is rejected —
never guessed, never mechanically rewritten. The check
(`detectSourceAmbiguity`) runs as a pure preflight over the FULL resolved
selected source universe — including episodes outside this run's
`--episode` subset — BEFORE any blind-key write and BEFORE
`makeJudgeInvoker`, so a rejected source is never discovered only after
provider calls. Rejected episodes are recorded in the public exclusions
with reason `source_ambiguous_identity_token` (+ the offending `tokens`), a
pure function of (manifest, corpus) the five public files carry
deterministically. After the ambiguity scan, the TRANSFORMED source body
texts (the same episode-local redactor + source-episode-id redaction the
build will apply; the blind key is resolved in memory — never persisted —
early enough for this transform) are validated against the independent
oracle BEFORE any provider work: a source that cannot be de-identified
(reason `source_oracle_content_rejected`) must never reach a provider. The
public exclusion record carries the FIXED protocol-stable detail
(`REPLAY_SOURCE_ORACLE_REJECTION_ERROR`), never the oracle's assertion
wording — the public exclusions/stats are byte-stable across oracle-text
edits, and the real assertion message is only surfaced in the
`quiet=false` source-preflight console via a separate in-memory map. On
the real selection path the surviving requested set must still be ≥ 2 after
preflight, otherwise the whole round fails closed before the provider.
`buildReplayEpisode` repeats the ambiguity check as an in-build invariant
defense (the production caller already preflights, so it never fires in the
normal provider path).

**Corpus model universe (incl. replay routes).** The redactor / identity
scan's known-token universe (`resolveCorpusModelNames`) mirrors the FULL
producer model universe: the surviving meta slots ∪ the
producer-inventory-verified `stats.models.by_name` keys ∪
`stats.models.absent_from_body` ∪ the current replay routes
(`options.models` — a replay candidate may not survive in the source corpus
meta/stats at all; without it a mention like `grok-4.5` in a source body
would be partially redacted into a pseudonym + leftover version fragment
and then rejected by the oracle). Sorted, deduped; a model that only
survives in stats or as a replay route is still a KNOWN token, never a
bare-ambiguity mis-kill.

**Oracle semantics (independent fixed oracle).** The independent oracle
(`_t0-replay-oracle.mjs`) is the production write-time final guard
(`writeOutputs`) and a per-slot / per-source fail-closed check before
provider work. Content surface (`assertNoOracleLeak` over prompt + slot
outputs): full model names, basenames, family tokens, leak fragments,
partial criteria, source episode / session / run ids, and `_`/`-`-glued
pseudonym/cN + SHORT `v?digit`-version chains (`[model-a]_[model-b]_4_8`,
`[model-a]_5.6_[model-b]`, `[model-a]_v4_[model-b]`, `c0_5`, `c0-5`,
`[model]-4` — while `c0-2026-05-28` / dates / standalone `4-8` /
`candidates c0-c1 diverged` / `R1 [model-a]` / echoed anonymous HMAC ids /
full chains (`c0-1-2-3-4` / `[model-a]_1_2_3_4` / `1-2-3-4-c0` /
`released 2026-05-28-c0`) are ordinary text).
Basenames are
matched as case-insensitive ALPHANUMERIC-CONTEXT tokens — a basename
embedded inside a longer word (`task3` / `sdk3` / `block3` / `chunk3` /
`k3s`) is NOT a leak, while a standalone / underscore-delimited `k3` still
is. Free text JSON is LEGAL: an answer may mention `{"cost": …}` /
`{"usage": …}` / `{"content_hash": …}` — only real parsed object keys are
structural sidecar markers, and `assertAnonymousBodyStructure` fails closed
on those at ANY nesting depth (exact key match, never substring).
`assertAnonymousBodyStructure` is STRICT TYPED: beyond the exact OWN-key
allow-lists (missing own keys — an inherited property is never an own key —
AND extra keys rejected; null / non-object / array episodes and null /
array slots rejected) it validates the EXACT public
type/value contract — `schema_version` must be the current anonymous
episode schema (3, independently hardcoded), `dataset_mode` must be
`"replay"`, `episode_id` / `prompt` / `thinking` / every slot field must be
strings with the anonymous id shapes scoped to the episode, `thinking` must
be one of the independently hardcoded levels `off|minimal|low|medium|high|
xhigh|max` (never an object / null), `tools` strict `null`, `slots` an
array, `result` `"ok"`. The content-text join (`replayBodyContentText`)
fails closed on non-string prompt / slot outputs — a nested object can
never be scanned as `"[object Object]"` text. The `_`/`-`-glued version
fragment grammar (production collapse + both independent oracle copies) is
deliberately SHORT — `[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}` with a canonical
candidate cN (`c(?:0|[1-9]\d*)`, no leading zeros) and a
`\[model(?:-[a-z]+)?\]` pseudonym side (bare `[model]` included) under
ASCII-alphanumeric-context lookarounds plus `(?<!\d[._-])` /
`(?![A-Za-z0-9]|[._-][vV]?\d)` chain bounds. The leading `v` is covered
explicitly for BOTH cases (`[vV]?`, never a whole-regex `/i`, so no other
canonical shape drifts). Three alternatives: the two PAIR forms
(pseudo⇄version, either direction) plus a SANDWICH form
`VERSION[_-]PSEUDO_OR_CANONICAL_CANDIDATE[_-]VERSION` ordered before the
version-first pair, so a v-prefixed right-hand version is never orphaned:
glued residues like `[model-a]_[model-b]_4_8` /
`[model-a]_5.6_[model-b]` / `[model-a]_v4_[model-b]` /
`[model-a]_V4` / `[model]_V4` / `c123_V4` / `c0_5` / `c0-5` /
`c123_5` / `c123-5` / `[model]-4` collapse/reject, and SANDWICH residues
`1-[model-a]-2` / `1_[model]_2` / `1_c0_2` / `1.2-c123-v3_4` collapse
ENTIRELY to the middle pseudo/candidate, while a 4-digit
year (`c0-2026-05-28`), dates, standalone version numbers (`4-8`),
candidate-vs-candidate text (`candidates c0-c1 diverged`), space-separated
digits (`R1 [model-a]`), a non-canonical leading-zero candidate
(`c01_5`), echoed anonymous HMAC ids
(`slot-rep-…-c01234567890` / the accidental `8-c0` hex boundary) and FULL
chains / date-version slices (`c0-1-2-3-4` / `[model-a]_1_2_3_4` /
`1-2-3-4-c0` / `released 2026-05-28-c0` / `2026_05_28_c0` / `c0-2026`)
or four-segment sandwiches with either side extended (`1-2-3-4-c0-2`,
`1-c0-2-3-4-5`) are ordinary text, never a leak — a chain is never
collapsed mid-way or left with a `-4`/`_4` residue, so content that echoes
an anonymous id is legal and the structural oracle never flakes scanning
ids with it.

### Checkpoint protocol hash

Binds: selection hash, source content hash, models, thinking, system+user
protocol, **retry hint**, max output/episode bytes, timeout, retry, redactor
id, schema versions, `experiment_mode`, `history_excluded`,
`degeneration_rules_version`, and **`ledger_version`** (the current
`ATTEMPT_LEDGER_VERSION` = 2). Any change invalidates resume. Outputs only
include checkpoints matching the current `selection_hash` + per-episode
`protocol_hash`; invalid/stale checkpoints (mismatched protocol, malformed
JSON, unknown source, wrong filename, duplicate ids) make the cumulative
scan **fail closed** — they are never silently skipped or mixed in.

**Ledger-format binding.** Every replay checkpoint carries the current
`ledger_version` at top level and `checkpointValid` requires it — an
old-format checkpoint (no `ledger_version`) is never resumed even when its
selection/protocol hashes match. The replay build's `runReplayAnswer` treats
`callJudge`'s `attempt_log` as the SOLE provider-call fact: every real
request keeps its `request_id`/usage/cost/cost_source, and the replay layer
attaches the degeneration/content/identity-redaction outcome to the SAME
entry (never a new entry that drops `request_id`). Pre-request failures
(model not found / unsupported thinking / auth) return `attempts=0` with an
empty ledger — the slot still fails closed, but it is NOT a provider request
and never counts as an unknown-cost attempt.

**Private replay material + contextual validation.** Every replay checkpoint
carries a private `replay_material` array — one entry per replay model in
exact `replay_models` order — holding the minimal snapshot needed to REBUILD
the public surfaces: the raw accepted output (pre-redaction, pre-cap),
called_at/thinking, the full attempt ledger, usage/cost/cost_source and the
provider-level error state. The raw accepted output lives ONLY inside the
checkpoint under the private key `raw_accepted_output` (a name that cannot
collide with the legitimate `output` field of body slots); it is never
published to `episodes.jsonl` / `episodes.meta.jsonl` / `stats.json`.

**Field-level private-material ban (no string-content matching).** The
write-time guard (`writeOutputs`) recursively rejects the private keys
`replay_material` and `raw_accepted_output` at ANY nesting depth of every
public artifact (body episodes, meta sidecar records, exclusions, stats;
the README is generated from stats, so it is covered transitively). This is
a STRUCTURAL field-level ban — it never compares string content, so a legal
answer that happens to equal the prompt or any other public text is never a
false positive, and the legitimate `output` field of body slots is never
rejected. (The smoke suite additionally asserts the raw outputs do not
appear in meta/stats/body non-output positions, but that is a test-side
check, not the guard.)

`checkpointValid` is now a CONTEXTUAL validator: it takes the real source
episode + meta, the blind key, the corpus model names, the current options
and the expected contentHash/models/protocolHash/selectionHash, and:
  1. self-binds the context: the expected `contentHash` must equal
     `episodeContentHash(sourceEpisode)` (a caller-supplied hash that does
     not match the source is a sync forgery), `sourceMeta.episode_id` must
     equal `sourceEpisode.episode_id`, `models` must equal
     `options.models` exactly and be unique, and `corpusModelNames` must be
     a string array;
  2. strictly checks the top-level identity/config fields (ledger/schema
     version, source id + content hash + thinking, replay thinking,
     selection/protocol hash, experiment mode, history exclusion, replay
     models) AND the checkpoint's exact top-level key set (exactly the
     fields the producer writes — an extra key can smuggle private data, a
     missing key can hide a binding) with a canonical UTC ISO `built_at`
     (`new Date().toISOString()` form);
  3. REQUIRES the private replay material (old material-less checkpoints
     are rejected) and validates it under the strict closure contract:
     one entry per model in exact order, EXACT key set per entry,
     `thinking` equal to the current `resolveReplayThinking` (a
     material+sidecar sync tamper can never change the thinking policy),
     valid ledgers, `calledAt` a canonical UTC ISO timestamp
     (`new Date().toISOString()` form), and
     checkpoint-wide unique `request_id`s;
  4. re-runs the real `buildReplayEpisode` over the material (mapped back
     via `materialToReplayResults`) and exact deep-compares `cp.episode` /
     `cp.sidecar` / `cp.exclusion`.

Material ledger closure: an `ok=true` entry must carry a non-empty
`raw_accepted_output` whose sha256 equals the ledger's ok=true
`accepted_output_hash` (RECOMPUTED here — never trusted from the file), the
ledger must contain EXACTLY ONE ok=true entry and it must be the LAST one
(all prior entries failed with null hash), and error/error_class/
exclusion_reason are null. An `ok=false` entry carries no raw output, must
not claim any ok=true ledger entry, and must close over the LAST ledger
entry's error/error_class with `exclusion_reason` derived per
`runReplayAnswer` (infrastructure_or_generation_failure -> same name, else
replay_call_failed); an empty ledger keeps only the legal pre-request
failure combos (error_class=infrastructure_or_generation_failure with
exclusion_reason in {replay_model_not_found, thinking_level_unsupported,
replay_call_failed}, usage/cost/source null). A body/sidecar sync tamper
that does not touch the material can never pass — the rebuild reproduces
the original surfaces from the raw outputs. Postprocess failures (ambiguous
identity / redaction cap) are modeled correctly: the provider succeeded
(ok=true, raw output present) and the failure state is re-derived by the
rebuild; pre-request / complete failures have no raw output. This is a
structural internal JSON binding, NOT a provider attestation — a fully
consistent rewrite of material + body + sidecar + hashes is outside its
scope. The binding increment is marked by `REPLAY_CHECKPOINT_CONTRACT_ID`
(`t0-replay-checkpoint-v1:raw-output-material+contextual-rebuild`), bound
into the replay protocol hash — old material-less checkpoints carry a
different `protocol_hash` and are stale, WITHOUT a ledger v3 bump
(`ATTEMPT_LEDGER_VERSION` stays 2).

**Fail-closed cumulative scan, BEFORE any provider work.**
`scanValidCheckpoints` uses the SAME contextual validator as the resume
path and the write-time self-assert, and FAILS CLOSED (throws) on any
`.json` that is malformed, has an unknown source, is an invalid checkpoint,
or whose filename does not equal the replay episode id derived from
blindKey/source id/models. It also rejects duplicate `source_episode_id`,
duplicate replay `episode_id` and cross-checkpoint duplicate `request_id`
in the cumulative directory. Non-`.json` files are ignored. Nothing
silently skips. The build runs this scan TWICE: a PRE-SCAN immediately
after corpus + manifest + blind key + context are resolved and BEFORE
`makeJudgeInvoker` / any provider request — a bad checkpoint in the existing
directory fails the whole run with zero provider-adjacent work (an empty /
missing checkpoints dir is legal); the blind key is resolved in memory but
`blind-key.json` is only persisted AFTER the pre-scan passes, so a bad
checkpoint neither creates nor modifies it — and a POST-SCAN after the run
for the final cumulative summary (each newly written checkpoint is also
self-validated before write). The pre-scan result is not reused: the resume
path re-validates per episode.

**Blind-key first publication is race-safe exclusive create-if-absent.**
`persistBlindKey` never rename-overwrites the canonical: a same-directory
temp is fully written + fsynced, then published via an atomic hard link
(`fs.linkSync`), so the canonical is created only if absent. A concurrent
loser whose `existsSync` observed no file still gets `EEXIST` from the link,
reads + strict-validates the winner (which is by construction a complete
file — the winner published the same way), reuses it on key equality and
fails closed on a key conflict; the winner's bytes are never clobbered and
never rewritten (bytes/mtime kept). The first blind itself must pass the
exact producer-shape validation (canonical lowercase 64-hex key + legal
`source`), the temp is always cleaned up, and the dir fsync is best-effort.
The serial paths are unchanged: an existing strict-valid file is reused on
key equality, a conflicting explicit `--blind-key`/`--seed` fails closed, a
malformed/corrupted file fails closed, and the whole persist step still
happens strictly AFTER the pre-scan and BEFORE `makeJudgeInvoker`.

**Redactor version.** `REPLAY_REDACTOR_ID` is currently `episode-local-v6` —
a single NOT-YET-PUBLISHED increment over v5 (there is no v7; the v6 temp
smokes are not a canonical checkpoint). v5 → v6 covers:
  - the SHARED ASCII-alphanumeric-context boundary (never `\b`, never a bare
    substring) applied to EVERY known-token scan — full names, basenames,
    vendor / family / alias tokens: underscore-delimited forms
    (`dossier_openai_review.md`, `run_deepseek/deepseek-v4-flash_log`,
    `_openai/gpt-5.6-sol_`) redact fully, while longer alphanumeric words
    (`task3` / `sdk3` / `k3s`) are never false-killed;
  - underscore-INTERNAL model aliases are full model-entity tokens: the
    alias generator produces the finite complete `-`/space/`_` separator
    combination, so `claude_opus_4-8` / `gpt_5.6_sol` /
    `deepseek_v4_flash` (and the `anthropic/claude_opus_4-8` provider form)
    redact whole with one pseudonym — no version residue; the production
    version-collapse regex and both independent oracle copies reject /
    collapse `_`- or `-`-glued pseudonym/cN + `v?digit`-version chains
    (`[model-a]_[model-b]_4_8`, `[model-a]_5.6_[model-b]`,
    `[model-a]_v4_[model-b]`, `c0_5`, `c0-5`) while `R1 [model-a]`, dates,
    standalone version numbers and candidate-vs-candidate text stay ordinary
    text;
  - ALIAS INPUT BOUNDS + numeric-underscore expansion: aliasVariants fails
    closed on an empty / over-long basename, an empty part (leading /
    trailing / double hyphen) or more than 8 expanded parts (max 3^7 =
    2187 combinations), and re-expands pure numeric compound parts (`4-8` →
    `4`,`8`) so `claude_opus_4_8` / `claude-opus-4_8` / `claude_opus_4-8`
    are the SAME whole-alias token (no `_8` residue);
  - SHORT version-fragment grammar, CHAIN-BOUNDED: the collapse/reject
    regexes now use `[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}` (the leading `v` is
    covered explicitly for both cases, never a whole-regex `/i`) with a
    canonical candidate cN (`c(?:0|[1-9]\d*)`, no leading zeros) and a
    `\[model(?:-[a-z]+)?\]` pseudonym side (bare `[model]` included) under
    ASCII-alphanumeric-context lookarounds, so `c0-2026-05-28` (a date),
    echoed anonymous HMAC ids (`slot-rep-…-c01234567890` / the accidental
    `8-c0` hex boundary), a non-canonical leading-zero candidate (`c01_5`),
    candidate-vs-candidate text (`candidates c0-c1 diverged`) and — with
    the `(?<!\d[._-])` / `(?![A-Za-z0-9]|[._-][vV]?\d)` chain bounds — full
    chains / date-version slices (`c0-1-2-3-4` / `[model-a]_1_2_3_4` /
    `1-2-3-4-c0` / `released 2026-05-28-c0` / `2026_05_28_c0` / `c0-2026`)
    never match — while a long non-zero candidate id (`c123_5` /
    `c123-5`) is a real unbounded candidate and collapses — and the old
    "deliberately unbounded" oracle narrative is gone;
  - the token → pseudonym lookup is explicit model-entity-priority, so a
    basename/alias that is also a family token (`gpt-5.5` / `grok-4.5` /
    `glm-5.2` / `minimax-m3`) keeps ONE model pseudonym (referential
    consistency — never the sort order / last-write); and MODEL IDENTITY
    ENTITIES are ALIAS-CONNECTED COMPONENTS over the case-insensitive
    `[basename, ...aliasVariants]` token sets (small DSU equivalence
    closure) — two routes sharing one basename (`github-copilot/gpt-5.5` +
    `openai/gpt-5.5`), or one basename being another model's alias variant
    (`claude-opus-4-8` + `vendor/claude_opus_4_8` + `Claude Opus 4 8`),
    are ONE anonymous model identity (full refs / bare basenames / aliases
    all share one pseudonym, corpus-order independent), so the body never
    claims per-route same-basename distinguishability and no two model
    entities can share a replaceable token;
  - dispatch run ids are alnum-context + case-insensitive
    (`artifact_dtr_<hex>.json` / `_dtr_<hex>_` / uppercase `DTR_<HEX>` all
    redact, `xdtr_…y` never) and the oracle scans them; residual old-style
    ids (`_m2` / `artifact_m12.json` / uppercase `M12`) are
    collected/redacted/rejected with the same boundary; session ids
    (UUIDv7) are hex-context + case-insensitive;
  - the redactor no longer identity-returns on an empty model universe:
    session / run / residual replacement runs even with zero known tokens;
  - the STRICT TYPED oracle: `assertAnonymousBodyStructure` (and the
    production write guard `assertAnonymousBody`) enforce the EXACT public
    type/value contract — `schema_version` (current episode schema 3),
    `dataset_mode` (`"replay"`), `episode_id` / `prompt` / `thinking`
    strings, `thinking` one of `off|minimal|low|medium|high|xhigh|max`,
    `tools` strict `null`, `slots` an array with every slot field a string
    and `result` `"ok"` — with EXACT OWN keys (Object.hasOwn: an inherited
    `prompt` is never an own key) and null / non-object / array episodes
    and null / array slots rejected, not just the key allow-lists; a nested
    object smuggled into a public field can never pass;
  - writeOutputs snapshots `{episodes, sidecar, exclusions, stats}` into
    one-time canonicalized plain JSON BEFORE any guard / mkdir / write — all
    guards and the renderer operate only on the snapshot, so a getter that
    changes on re-read can never make the guarded bytes differ from the
    written bytes (no guard/render TOCTOU);
  - the slot-level oracle rejection sidecar error is a FIXED stable string
    (`REPLAY_ORACLE_REJECTION_ERROR`), never the oracle's assertion detail;
  - the source-preflight oracle rejection public exclusion detail is the
    FIXED stable string `REPLAY_SOURCE_ORACLE_REJECTION_ERROR` — the public
    exclusions/stats never carry oracle assertion wording (the real message
    is console-only), so an oracle-text edit cannot change the five public
    files.
(v4 → v5 had added the ALPHANUMERIC-CONTEXT + case-insensitive source
episode-id transform, the alnum-context basename scan (`task3`/`sdk3`/… no
longer false-killed), free-text JSON legality for `"cost":`/`"usage":`/
`"content_hash":` keys, and the replay routes in the corpus universe;
v3 → v4 had added the FULL source-body preflight incl. the prompt + source
episode-id redaction + the oracle final guard; v1 → v2 had added full
UUIDv7-shape session-id matching + prompt re-redaction; v2 → v3 added the
historical raw-output re-redaction and the historical-ambiguity preflight.)
The id is bound into the protocol hash, so checkpoints built under
v1/v2/v3/v4/v5 — which could let a UUIDv7 / run id / source episode id /
model identity pass through a historical slot, publish an ambiguous
identity token, rewrite a normal criterion into a pseudonym, miss a
separator-embedded / uppercase source id, false-kill an ordinary word
containing a basename, kill a legal free-text JSON answer, leak an
underscore-internal model alias / glued version residue, split a
same-basename route pair into inconsistent pseudonyms, or admit a
nested-object / inherited-key body through key-only checks — are ALL stale
and never
resumed; the cumulative scan still fails closed on them, never silently
skipping.

**`selection_hash` binds the FULL semantic manifest** — not just
`episode_ids`. `selectionManifestHash` hashes kind, schema, `protocol_hash`,
`classify`, `thinking`, judge/classifier/downstream models, `counts`,
`exclusion_distribution`, the complete `selected[]` / `excluded[]` /
`classifications[]` records, `episode_ids`, `hard_only` and `limit` — any
change to selected/classification/count/exclusion content changes the hash,
so a hand-edited or derived two-line manifest (e.g. an `episode_ids`-only
rewrite) hashes differently and is rejected by checkpoint/provenance
binding. Deliberately NOT bound (stable relocation semantics): the
`episodes`/`meta` absolute paths (a corpus relocation must not invalidate
every checkpoint), `generated_at` (a timestamp, not selection semantics) and
`concurrency` (a runtime parameter). The top-level `cost` summary is also
not bound independently — the per-record `cost`/`cost_breakdown` inside
`selected[]`/`classifications[]` are already bound, and the summary is
deterministic given the same checkpoints.

**Production re-runs.** A production re-run after any protocol change
(including a retry-hint or protocol-text edit) produces a new
`protocol_hash`; checkpoints built under the old hash are **never reused**
and never admitted into episodes/stats. A re-run must not claim continuity
with checkpoints built under a different protocol.

**Migration impact (ledger v2 + result contract v2).** The current
production fair selection manifest
(`~/.pi/.pi-astack/t0-replay-fair/selection.json`) and its
`checkpoints-fair/checkpoints/*.json` predate the `ledger_version` binding,
the `request_id` ledger identity, the `classification_status` result
contract, and the v2 fail-closed checkpoint lifecycle: the manifest's
`protocol_hash` no longer matches the current `classifierProtocolHash()`
and every checkpoint lacks `ledger_version` / `classification_status`, so
`dossier:t0-replay-fair-production` now fails closed at its read-only
preflight (zero provider requests) with a stale-protocol / stale-checkpoint
error. This is EXPECTED: the old manifest cannot be compatibly resumed —
it must be **regenerated in full** via `t0:replay-select` (new dual-LLM
classification under the current protocol, producing new-format checkpoints
with `request_id`-carrying ledgers and `classification_status` finals, and
never overwriting an existing checkpoint), and the production replay
dossier must be re-run against the regenerated manifest. No production pass
has been re-run yet under the new contract.

### Fair manifest provenance (pure validator)

`validateFairManifestProvenance` (t0-replay-fair-common.mjs) is a pure,
read-only validator (no invoker, no credentials, no provider requests) that
proves a canonical `selection.json` is the COMPLETE product of the real
classifier selector over the real corpus + its own
`checkpoints-fair/checkpoints/*.json`.
It does not just compare sets/self-hashes — it REBUILDS every selector output
from the real corpus + checkpoints and deep-compares. The producer
(`selectFairReplayEpisodes` / `buildManifest`) and the validator share ONE
row-construction code path (`buildClassificationRow` / `buildSelectedRow` /
`buildExcludedRow` / `compareSelectedRows` / `buildManifestCostSummary`) —
the validator never hand-writes an approximate row, so producer and
validator can never drift apart:

- **producer inventory at the entry**: `exclusions` + `stats` are REQUIRED
  (missing them is a hard error, never a skip) and the full
  `validateProducerInventory` runs at the entry — every episode must have a
  meta record (an episode without meta would otherwise be silently
  hard-excluded as `meta_missing`, keeping the manifest/rebuild
  self-consistent over a shrunken corpus), body/meta slots match 1:1,
  `model_count` closes over the body, and the stats close over the corpus;
  orphan meta records are only legal as the below-min terminal set recorded
  in exclusions + stats (an arbitrary orphan fails closed);
- **strict top-level identity + key set**: `kind`/`schema_version` constants,
  `classify===true`, `hard_only===false`, `limit===null`, `protocol_hash` ===
  current `classifierProtocolHash()`, `judge_models` === `classifier_models`
  (both must be the checkpoints' actual dual-judge identity),
  `downstream_judges` === the downstream judges the fresh scan used,
  `thinking` === checkpoint thinking; the top-level key set is exactly the
  real selector output (any extra top-level key rejected; `generated_at` /
  `episodes` / `meta` / `concurrency` type-checked as non-semantic fields);
- **classifications**: length === hard candidates, `episode_id` unique and in
  the selector's hard-candidate order; every row is the fixed strict 10-key
  set (episode_id / stage / replayable / reasons / confidence /
  join_confidence / cost / cost_source / cost_breakdown / from_checkpoint)
  with bidirectional key closure (extra/missing keys rejected) and
  deep-compared to its checkpoint `final`; `from_checkpoint` is the run's
  SOURCE (boolean; true on a legal resume), NOT a checkpoint-final field —
  the stored final always records the original run, so a resume manifest is
  not hard-compared against `cp.final.from_checkpoint`;
- **checkpoint body recomputed from the producer's own pure functions**:
  llm stage — `mergeDualJudgments(cp.judgments)` must reproduce the final's
  replayable/reasons/confidence/flags/disagreement,
  `summarizeClassifierCosts(cp.attempt_log)` must reproduce
  cost/cost_source/cost_breakdown/has_unknown_cost/known_total, attempts =
  sum of each judge log length, and every new-format ledger attempt must
  carry a unique `request_id`; mechanical stage — `mechanicalExclude(real
  episode.prompt)` must equal `cp.mechanical` and the final's mechanical,
  attempts=0 with an empty cost ledger;
- **selected**: the COMPLETE expected rows rebuilt from `hard.candidates` +
  checkpoint finals via the shared `buildSelectedRow` + `compareSelectedRows`
  (exact first, confidence desc, episode_id asc) — every row deepEqual and
  `episode_ids` in the same order, so reverse / reasons / confidence /
  tools / models / join forgery are all rejected; selected/excluded
  `from_checkpoint` must equal the classification row's value;
- **excluded**: the full expected array (fresh hard exclusions in corpus
  order + non-replayable classification rows in hard-candidate order)
  deepEqual, including order and every selector-emitted field;
- **counts**: every selector-emitted count (source / hard_pass /
  hard_pass_limited / classified / replayable / excluded /
  data_insufficient / join_hard_pass / join_selected) rebuilt and compared;
  extra/missing/forged values rejected;
- **exclusion_distribution**: rebuilt from the fresh hard distribution +
  non-replayable classification reasons per the selector's exact rule;
  deepEqual, extra keys rejected;
- **top-level cost**: deterministically rebuilt from the classification
  finals via the shared `buildManifestCostSummary` and deep-compared — a
  forged/derived cost summary cannot pass;
- **ledger binding**: every checkpoint must carry the current
  `ledger_version` (2) — old-format checkpoints (no `request_id` identity)
  are rejected as stale;
- **state contract**: every checkpoint final must be
  `classification_status: "completed"` — a `failed` checkpoint (any judge
  without a valid judgment) is a diagnostic artifact and is rejected, so it
  can never enter the finals rebuild.

No cryptographic signature is claimed — but a hand-written manifest cannot
pass without also forging every complete checkpoint in the current
production corpus, which the per-row checkpoint deep-compare makes
infeasible. The validator works on any fixture temp dir (paths are
parameters, never hardcoded production paths). Both production dossiers call
it on the canonical real manifest BEFORE any provider request
(`dossier-t0-replay-production`) or as a read-only check
(`dossier-t0-replay-fair-production`, which additionally requires
`hard_pass>0` — no empty-set self-proof).

### Failure + degeneration

- Full or partial failure always writes checkpoint + meta + exclusion +
  attempt/cost.
- Generation degeneration (number/list streams, repeated tail loops, near max
  output bytes, near **actual call** max output tokens when known — never the
  model-catalog `maxTokens` — English/Chinese action-intent without substance,
  and token/visible extreme imbalance such as ~98k output tokens with ~75
  visible characters) → `infrastructure_or_generation_failure`, never enters
  body. Normal short sign answers (签署 / ACCEPT) with moderate reasoning
  tokens are not false-killed. Degeneration rule version is bound into
  `protocol_hash` so rule changes invalidate resume.
- Successful attempts have `error_class=null`.
- Current-only: any model failure → `not_fully_paired` (sidecar kept).

### Stats / aggregate

`selection.cumulative` (body episodes under the current selection+protocol
only) and `selection.cumulative_checkpoints` are recomputable from the
cumulative checkpoint set and are reported in the public `stats.json`.
Per-run facts (`requested`, `new_checkpoints`, `reused_requested`,
`dataset_checkpoints`, `dataset_episodes`) are returned by `buildReplay` as
private `run` facts and are NEVER written to the public files — the five
public files (`episodes.jsonl` / `episodes.meta.jsonl` / `exclusions.jsonl` /
`stats.json` / `README.md`) are byte-identical for the same checkpoint set
regardless of the `--episode` subset or resume method.

**Canonical public-payload renderer.** The five public files are written ONLY
by the shared pure renderer `renderPublicPayloads`, which recursively
canonicalizes JSON object keys (arrays keep order) before serializing. So
any recursive key reorder inside a checkpoint (episode / sidecar /
attempt_log / usage / audit / …) that the contextual validator accepts
(stableStringify-equivalent content) renders the five files byte-identically
— the bytes are a pure function of the payload content, never of key
insertion order. `canonicalizeExclusions` canonicalizes every emitted record
the same way, so a stable-equal duplicate (including a JSON key-order-only
variant) dedupes to the canonicalized object in either input order, while a
same `episode_id`+`reason` with a different payload still fails closed. The
write-time guards (`assertAnonymousBody` + the independent oracle
`assertAnonymousReplayBody` — structure AND content — + the field-level
private-material ban) all run BEFORE any filesystem write (including the
output-dir mkdir), so a rejected payload never leaves a partial five-file
publication. `writeOutputs` first snapshots `{episodes, sidecar, exclusions,
stats}` into ONE-TIME canonicalized plain JSON (canonicalizeJsonKeys —
never a stringify/parse round-trip, so cost `null`/unknown semantics
survive) BEFORE any guard / mkdir / write: every getter at any depth is read
exactly once, and all guards + the renderer operate only on the snapshot —
a getter that would return a different value on a second read can never
make the guarded bytes differ from the written bytes (no guard/render
TOCTOU). The renderer may re-canonicalize the (already plain) snapshot but
never re-reads the caller's original objects/getters.

**`max_total_bytes` is a publication guard, not public stats identity.** It is
checked after the run (fail-closed when the body exceeds it) and is NOT
bound into the checkpoint protocol hash, so it never enters the public
`stats.json`/README — changing only `--max-total-bytes` keeps the five files
byte-identical for the same checkpoint closure. (`max_output_bytes` /
`max_episode_bytes` remain in the public stats: they ARE bound into the
protocol hash and shape the body content.)

**Relocation determinism.** A subset accumulation (`--episode A`, then
disjoint `B` on the same dir) followed by moving the SAME blind key + exact
checkpoint closure to another output directory (checkpoints copied in
reversed creation order) rebuilds via plain all-resume (`no --episode`) with
zero provider calls and byte-identical five files — directory enumeration
order can never leak into the public bytes. `stats.inputs` carries stable
basenames (never absolute paths) so the same evidence rebuilds
byte-identically across directories.

**Cost accuracy (unknown never becomes a fake 0).** `estimateCost` /
`attemptCost` return unknown (`cost: null`, `source: null`) when usage is
missing or carries no numeric token/cost evidence — only a real usage object
that explicitly reports 0 tokens keeps an estimated 0. `callJudge` keeps a
per-attempt ledger (`attempt_log`) of EVERY actual provider request
(success, content failure, transport failure, usage null, cost null/source
null) — callers read the ledger, never just the final usage. Every actual
request carries a unique persistent `request_id` in its ledger entry (a
process-local `randomUUID()`, never sent to the provider); usage is
per-attempt private, so a transport throw never inherits the previous
attempt's usage/cost, and `dedupeAttempts` dedupes by `request_id` only
(byte-identical 429s from different runs are distinct real requests and are
both kept; repeated saves of the same `request_id` are idempotent). Replay
build
`stats.json` reports `replay.calls.unknown_attempts` and
`replay.calls.cost_breakdown {provider, estimated, unknown}` alongside the
summed known cost; no-usage transport attempts are `cost=null/source=null`
in the sidecar attempt logs. The replay cost summary is TERNARY and is
recomputed from the verified attempt_log ledgers only (never from
`r.cost` / `r.attempts` aggregates): `known_cost` is ALWAYS numeric (the sum
of the attempts with numeric cost evidence), `cost_complete =
(unknown_attempts === 0)`, and `cost` is numeric ONLY when `cost_complete`
is true (and then exactly equal to `known_cost`) — otherwise `cost` is
`null`. An incomplete known subtotal is never presented as the complete
total. The production dossiers print the same ledger
for their canaries and the final line is always "known total + N
unknown-cost attempt(s)" when any attempt lacks cost evidence — never a
claim of a complete precise total.

`t0-replay-aggregate` adds `paired_current_only` when the dataset is
current-only: only fully paired episodes; per-model evaluator0/1 correctness,
adjudicator verdicts, counterfactual net, noise/claims. Notes OpenAI family
overlap (Sol adjudicator vs GPT-5.5 control) while Opus scores remain
independent.

## Dataset commit, immutable generation, and crash recovery

`dataset.commit.json` is the sole commit point for a replay dataset. Its
absence means **no committed evidence**, even if `episodes.jsonl` or the other
public files happen to exist. Readers use `loadCommittedReplayDataset(output)`;
it returns `null` only when the marker is absent and never falls back to raw
public files or live checkpoints.

The schema-v1 marker is deterministic and clock/path independent. It binds the
exact fixed five-file manifest (`episodes.jsonl`, `episodes.meta.jsonl`,
`exclusions.jsonl`, `stats.json`, `README.md`) by byte count and SHA-256 plus a
`files_digest`. Its only private locator is the forward-slash-safe
`.replay-generations/<generation_id>/closure.json`. `generation_id` is the
SHA-256 of the current generation contract/schema, closure SHA-256 and public
files digest; the self locator is deliberately not in that preimage.

Before publication, the builder writes and fsyncs a complete private bundle
under `.replay-generations/.tmp-*`, then atomically renames it to the immutable
`<generation_id>` directory. The closed recursive inventory contains source
snapshots, a deterministic-normalized full selection, exact fair classifier
checkpoints, `blind-key.json`, canonical replay checkpoints and `closure.json`.
The closure binds current replay/episode/redactor/ledger/checkpoint contracts,
corpus and selection identities, blind-key identity, checkpoint manifests and
the closed replay build context needed for independent reconstruction.
The closure identity also binds `REPLAY_DATASET_PRODUCER_CONTRACT_ID`
(`t0-replay-dataset-producer-v2:hard-gates+source-oracle-v6+canonical-renderer+readme-stats-schema+fixed-source-error+nullable-cost`)
plus the exact current `strong_reference_models` / `specialist_models` /
`replay_judge_models` arrays. ANY semantic change to buildStats / buildReadme /
canonicalization / the hard gates / the source-oracle-v6 preflight / the fixed
source-oracle rejection payload / the nullable-cost semantics must bump that
id — an old loader then rejects the generation as explicitly stale instead of
silently re-deriving different bytes. It does NOT bump `REPLAY_SCHEMA_VERSION`
/ the protocol hash / checkpoints.
Existing generation directories are reused only after exact inventory,
byte-count and SHA-256 verification. Bundles are never edited and there is no
automatic GC.

Publication is single-writer. After the immutable bundle exists, the builder
atomically writes the private `.replay-publication-intent.json`, revokes the old
marker, atomically replaces each public file, and writes `dataset.commit.json`
last. A failure before marker revocation leaves the previous committed dataset
loadable. With an intent and no matching marker, normal `--resume` reconstructs
the exact target from its immutable bundle and exits with zero invoker/provider
work; `--no-resume` rejects. A stale intent whose target exactly equals the
committed marker is cleared before normal planning continues.

The committed loader validates marker, locator, closure, recursive inventory,
all private snapshots/checkpoints and the exact public bytes. It then invokes
the same replay preflight, provenance, contextual checkpoint scan, derive,
anonymous-body/oracle and private-key guards through the internal
verification-only path. That path cannot persist a blind key, create an
invoker, process an episode, call a provider or write output. It rereads the
marker at the end as a race probe and returns deeply frozen provider-safe
body episodes plus local metadata, exclusions, stats and generation identity.

Only `episodes.jsonl` may be fed to an anonymous judge. The marker, publication
intent, generation bundle/closure, source/selection snapshots, blind key,
checkpoints, metadata, exclusions and stats are **never** judge input. The
generation bundle is private evidence: it contains a full source-corpus copy,
the plaintext blind key and every raw accepted replay output
(`replay-checkpoints/*.json` — the private `raw_accepted_output` material) —
never feed or share it indiscriminately, and never publish it as part of the
dataset. Legacy
`--allow-legacy-select` remains uncommitted fixture tooling and refuses any
directory containing a marker or publication intent.

## Replay eval generation

Replay evaluation consumes ONLY the committed replay dataset. The eval CLI's
`--replay-dataset <dir>` (or the `t0:replay-eval --dataset <dir>` wrapper)
loads the corpus via `loadReplayEvalCorpus`, which reads the committed
generation from `dataset.commit.json` (markerless / incomplete datasets are
rejected before any invoker) and mints a PRIVATE capability token
(`replayBinding`, a WeakMap-backed opaque object). `evaluateEpisode` /
`publishReplayEvalGeneration` (the replay-mode publish wrapper) accept ONLY
that capability — a bare forged `replayDatasetGenerationId` (or a plain
object that looks like a binding) is rejected before any
checkpoint/feed/invoker work or disk mutation, and is never a disk-write
authority.

The whole replay eval chain binds the committed replay dataset's generation
id: every checkpoint / record / index row / summary / writer-recovery intent
carries `replay_dataset_generation_id` (lowercase 64-hex), the protocol hash
is derived with the generation id in its preimage, and a bound checkpoint /
record is never resumed or admitted by a normal run (and vice versa — a
normal product never carries the field). The committed generation's
`summary.json` has kind `t0_replay_eval_generation` (normal kind
`t0_eval_generation`); the loader kind gate rejects a replay generation under
normal mode and a normal generation under replay mode, and the intent kind
preflight refuses to recover across branches. The judge roles are pinned to
the fixed replay roles (`REPLAY_EVAL_JUDGE_MODELS_CSV`); a different
`--models` is rejected before any invoker.

`t0-replay-aggregate --dataset <dir> --eval <dir>` reads ONLY a committed
replay eval generation bound to the SAME dataset generation id + the fixed
replay judge roles: a missing `summary.json`, an ordinary (non-replay)
generation, a wrong generation id, or a markerless dir is rejected. The
aggregate reuses the shared identity-aware `aggregate()` and adds the
replay-specific report (per-model replay vs historical slots, replay call
attempts/cost recomputed from the verified attempt ledgers, source-episode
mapping) plus `paired_current_only` for current-only datasets.

## Stale producer marker (operator procedure)

When `loadCommittedReplayDataset` (or the committed loader) explicitly
reports that the generation closure is stale for the current replay dataset
producer contract (`producer_contract_id` mismatch), there is NO automatic
migration — the loader fails closed and the operator must act manually.
Production authorization is required before any of this. The procedure:

1. Confirm the single writer is stopped and that
   `.replay-publication-intent.json` does NOT exist. If an intent exists, do
   NOT do a manual marker removal — the interrupted publication must first
   be completed or investigated via exact intent recovery (the intent's
   target generation is reconstructed from its immutable bundle with zero
   provider work when the checkpoints are still legal).
2. Remove ONLY the old `dataset.commit.json` commit marker. Keep
   `blind-key.json`, the selection/provenance, the checkpoints and the
   immutable `.replay-generations/*` bundles — they are not touched.
3. Re-run the build with the FULL canonical selection, the SAME output
   directory, and plain resume (no `--episode`, no `--no-resume`): the run
   rebuilds from the still-legal checkpoints and publishes a NEW marker
   under the current producer contract.
4. While the marker is absent, the five public files are NOT evidence — no
   reader treats them as committed.
5. This may produce provider calls when checkpoints are also stale or
   missing — zero calls is NOT promised. Old bundles are never auto-deleted.

## Outputs

```
~/.pi/.pi-astack/t0-replay-fair/
  selection.json
  checkpoints-fair/

~/.pi/.pi-astack/t0-replay-fair-run/   # fair (source thinking)
~/.pi/.pi-astack/t0-replay-fair-eval/

~/.pi/.pi-astack/t0-replay-current-run/  # current-only equal conditions
  dataset.commit.json               # sole commit point, written last
  episodes.jsonl
  episodes.meta.jsonl
  blind-key.json
  exclusions.jsonl
  stats.json
  README.md
  checkpoints/                      # live resumable working state
  .replay-generations/<generation_id>/
    closure.json
    source/
    selection.json
    fair-checkpoints/
    blind-key.json
    replay-checkpoints/
  .replay-publication-intent.json   # crash-only transient private state

~/.pi/.pi-astack/t0-replay-current-eval/
  eval/
  summary.json
  aggregate.json   # includes paired_current_only
```

## Tests

```bash
npm run smoke:t0-replay-fair   # fair select fixtures + mock invoker (offline, default gate)
npm run smoke:t0-replay        # offline deterministic build/eval unit suite (default gate)
npm run dossier:t0-replay-fair-production  # EXPLICIT read-only production hard-gate scan (no network)
npm run dossier:t0-replay-production  # EXPLICIT production acceptance (real fair selection, live replay + K3 canaries, paid)
```

`smoke:t0-replay-fair` is the **offline deterministic** fair-selection suite:
pure fixtures + a mock invoker (hard gates, body/meta 1:1, mechanical
pos/neg, dual-judge merge, dual-call retry, checkpoint/resume/cost,
classifier protocol-hash stability, and the fail-closed state contract:
partial/both-judge failures produce `failed` diagnostic checkpoints that
are never resumed, `selectFairReplayEpisodes` rejects any non-completed
classification with no partial manifest, `validateCheckpointBody`
structurally explains real failed checkpoints, and provenance rejects any
`failed` checkpoint). It never reads production episodes,
never creates a real invoker, and never spawns the production selector — it
is part of the default `smoke:all` gate. The real-data hard-gate scan and
CLI cross-check live in the **read-only dossier**
(`dossier:t0-replay-fair-production`): it reads the real corpus
(`~/.pi/.pi-astack/t0-episodes/`, `~/.pi/agent/models.json` presence only)
plus the fair selection manifest
(`~/.pi/.pi-astack/t0-replay-fair/selection.json` — an existing complete
manifest is REQUIRED), runs the hard-gate scan and the real
`t0-replay-select --hard-only` CLI, cross-checks them, verifies CLI argument
validation and the manifest's `protocol_hash` vs the current classifier
protocol, prints the exclusion distribution and input paths, makes NO
provider/network calls, writes NO files, and fails closed (non-zero) on
missing data — a missing fair selection manifest or a STALE `protocol_hash`
are both non-zero (no skip, no warn-only).

`smoke:t0-replay` is the **offline deterministic** suite: manifest bypass
rejection (including episode_ids-only), anonymous body fields, current-only
three-model equal conditions / no history slots / paired exclusion, fair
`--thinking` rejection, checkpoint protocol + selection isolation, failure
retention, degeneration, resource caps. It never reads production episodes or
the fair selection, never creates a real invoker, and never sends provider
requests — it is part of the default `smoke:all` gate.

The **production acceptance dossier** (`dossier:t0-replay-production`) is NOT
a default gate and must be run explicitly: K3 system/user canaries, then a
fair-selection build/eval/aggregate on the first 2 episodes of the real fair
selection manifest that pass **both** preflight stages — (1) the build's own
full fair-selection eligibility gates (missing meta, `tools!=null`, join not
allowed, not self-contained, contains a downstream judge) via
`resolveSelectedSourceEpisodes`, then (2) source thinking level supported by
BOTH replay models in the current real registry — never a blind "first 2".
Before ANY request the dossier also validates the manifest's
`protocol_hash` against the current `classifierProtocolHash()` (a stale
manifest fails closed with expected/actual printed). The build consumes the
REAL full manifest via `--selection <manifest> --episode <2 ids>` (no
derived/patch fixture; the selection hash binds the full manifest).
Structural exclusions and thinking incompatibilities are reported
individually; compatible+buildable < 2 fails closed. Preflight-incompatible
episodes (e.g. source `thinking=medium` while `deepseek-v4-flash` maps
`medium` to `null`) are explicitly reported with per-model reasons and never
sent to a provider — they are preflight incompatibilities, NOT
provider/generation failures, and do not count into the 4 actual replay
slots. Acceptance is
strict: all 4 replay slots (2 episodes × Flash/Grok, derived from
`DOSSIER_EPISODE_COUNT × REPLAY_DEFAULT_MODELS.length` — no scattered magic
numbers) must succeed and enter
the body (`replay.calls.total === 4`, `ok === 4`, `failed === 0`; every slot
`in_body === true`, `error_class === null`) — provider/generation failures
are NOT treated as availability and cannot be skipped. It uses real
production data and real providers, is networked, may take a long time and
incur real LLM cost, and exits non-zero on any failure (missing data / auth /
HTTP / 429 / 5xx / timeout / truncation / content / schema). The build step's
outer watchdog is derived from the shared pure helper
`replayBuildWatchdogMs` = `ceil(episodeCount/concurrency) × (maxRetries+1) ×
timeoutMs + margin` (for 2 episodes / concurrency 2 this is 1 × 3 × 600s +
10min = 2_400_000 ms — unchanged — but the formula generalizes to any batch
count), so it
never kills the last inner attempt. The eval step's outer watchdog is derived
from the same shared helper over the judge pipeline's 4 serial levels
(evaluator_0/evaluator_1 in parallel, then verifier, adjudicator,
counterfactual) × `ceil(episodeCount/concurrency)` serial batches × full
retry/timeout budget + a 10-minute margin — the dossier passes its sample
count and concurrency explicitly and derives the CLI `--concurrency` from the
same constants — it does NOT
change the single-attempt provider timeout, and the live dossier may run for
hours (up to the full budget), which is why it is explicit-only. The resume
step's contract is **zero provider calls**: it re-runs the build and proves
checkpoint reuse via a byte-stable replay call-identity snapshot (source/
replay model, `replay.called_at`, attempt_log) deepEqual'd before/after and
prints `0 new replay calls / checkpoints reused` — a missed checkpoint
re-calls a slot and fails the resume. The resume watchdog
(`RESUME_NO_CALL_WATCHDOG_MS=300_000`) is a short fault limiter, not a retry
budget, because the step must not call providers at all. It does
**not** read
`/tmp/t0-replay-pilot-*` unfair pilots or old fair-run results as input, and
it finishes by printing the full provider-call/cost ledger (replay build +
eval + K3 canaries; unknown canary costs are marked, never fabricated as 0).

## Sample size

The fair selection manifest currently on disk has **n=9** replayable
episodes, but it predates the current classifier contract (see Migration
impact) and must be regenerated before any new production pass — the n=9
figure is not a current-valid claim. All capability claims from any run must
emphasize the small replayable-set (or smaller paired-n) limit — not a
large-N production scoreboard. Prompt-only judgment qualification does not
cover agentic execution capability.
