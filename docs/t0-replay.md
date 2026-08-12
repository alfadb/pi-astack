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

t0-replay-eval.mjs       t0-eval with the replay experiment's judge roles
t0-replay-aggregate.mjs  aggregate by real model + replay/historical report
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
from historical slots. K3 system/user canaries are part of `smoke:t0-replay`.

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
  --episodes ~/.pi/.pi-astack/t0-replay-current-run/episodes.jsonl \
  --output ~/.pi/.pi-astack/t0-replay-current-eval

npm run t0:replay-aggregate -- \
  --episodes ~/.pi/.pi-astack/t0-replay-current-run/episodes.jsonl \
  --meta ~/.pi/.pi-astack/t0-replay-current-run/episodes.meta.jsonl \
  --eval ~/.pi/.pi-astack/t0-replay-current-eval
```

### Build CLI options

| Option | Default | Meaning |
|---|---|---|
| `--selection <path>` | **required** | fair `prompt_only_replay_selection` manifest (full `selected[]`) |
| `--current-only` | off | equal-conditions mode (3 models, thinking=high, history excluded, paired body) |
| `--episodes <path>` | `~/.pi/.pi-astack/t0-episodes/episodes.jsonl` | source body |
| `--meta <path>` | same dir | source identity sidecar |
| `--episode <id>` | — | optional subset of selection ids |
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

### Checkpoint protocol hash

Binds: selection hash, source content hash, models, thinking, system+user
protocol, max output/episode bytes, timeout, retry, redactor id, schema
versions, `experiment_mode`, `history_excluded`, `degeneration_rules_version`.
Any change invalidates resume. Outputs only include checkpoints matching the
current `selection_hash` + per-episode `protocol_hash` (old checkpoints never
mix in).

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

`selection.selected_this_run` vs `selection.cumulative` (body episodes under
the current selection+protocol only) and `selection.cumulative_checkpoints`
are reported separately.

`t0-replay-aggregate` adds `paired_current_only` when the dataset is
current-only: only fully paired episodes; per-model evaluator0/1 correctness,
adjudicator verdicts, counterfactual net, noise/claims. Notes OpenAI family
overlap (Sol adjudicator vs GPT-5.5 control) while Opus scores remain
independent.

## Outputs

```
~/.pi/.pi-astack/t0-replay-fair/
  selection.json
  checkpoints-fair/

~/.pi/.pi-astack/t0-replay-fair-run/   # fair n=9 (source thinking)
~/.pi/.pi-astack/t0-replay-fair-eval/

~/.pi/.pi-astack/t0-replay-current-run/  # current-only equal conditions
  episodes.jsonl
  episodes.meta.jsonl
  blind-key.json
  exclusions.jsonl
  stats.json
  README.md
  checkpoints/

~/.pi/.pi-astack/t0-replay-current-eval/
  eval/
  summary.json
  aggregate.json   # includes paired_current_only
```

## Tests

```bash
npm run smoke:t0-replay-fair   # fair select fixtures + prod hard scan
npm run smoke:t0-replay        # build unit + fair-selection real subset chain
```

`smoke:t0-replay` covers: manifest bypass rejection (including episode_ids-only),
anonymous body fields, current-only three-model equal conditions / no history
slots / paired exclusion, fair `--thinking` rejection, checkpoint protocol +
selection isolation, failure retention, degeneration, resource caps, K3
system/user canaries, fair-selection build/eval/aggregate. It does **not**
read `/tmp/t0-replay-pilot-*` unfair pilots or old fair-run results as input.

## Sample size

The current fair selection has **n=9** replayable episodes. All capability
claims from this run must emphasize the n=9 (or smaller paired-n) limit — not
a large-N production scoreboard. Prompt-only judgment qualification does not
cover agentic execution capability.
