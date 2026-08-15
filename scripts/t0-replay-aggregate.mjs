#!/usr/bin/env node
/**
 * t0-replay-aggregate — aggregate replay evaluation results by REAL model.
 *
 * Reuses t0-eval-aggregate.mjs's aggregate() — the ONLY identity-aware
 * aggregation logic — and adds replay-specific reporting:
 *
 *   - replay.slots: per-model replay vs historical candidate slots (from the
 *     replay sidecar's source.kind)
 *   - replay.calls: replay call attempts/cost/failures recomputed from the
 *     verified attempt_log ledgers (ternary known_cost / cost_complete /
 *     cost) — the replay build's own spend, separate from the judge spend
 *   - replay.source_episodes: source episode -> replay episode mapping
 *
 * Corpus input is ONLY a committed replay dataset via `--dataset <dir>`:
 * bare --episodes/--meta paths are rejected. Eval input is a committed
 * replay eval generation bound to the same dataset generation id.
 *
 * Usage:
 *   node scripts/t0-replay-aggregate.mjs --dataset <committed-replay-dir> [options]
 *
 * Options:
 *   --dataset <dir>     committed replay dataset directory (default:
 *                       ~/.pi/.pi-astack/t0-replay)
 *   --eval <dir>        evaluation output dir (default:
 *                       ~/.pi/.pi-astack/t0-replay-eval)
 *   --output <path>     aggregate output file (default: <eval>/aggregate.json)
 *   --quiet             suppress per-model lines
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCommittedEvalGeneration,
  writeJsonFile,
  resolveJudgeModels,
  REPLAY_EVAL_JUDGE_MODELS_CSV,
} from "./t0-eval-common.mjs";
import { aggregate } from "./t0-eval-aggregate.mjs";
import {
  REPLAY_SCHEMA_VERSION,
  loadCommittedReplayDataset,
  summarizeReplayCallsFromMeta,
} from "./t0-replay-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pure arg normalizer for t0-replay-aggregate (no I/O, no process.exit) —
 * the single authority the CLI and offline smoke tests share.
 *
 * Contract:
 *   - `--dataset <dir>` is the ONLY corpus input (default may remain);
 *   - `--episodes` / `--meta` and their `=` forms are REJECTED;
 *   - value-less / duplicate `--dataset` / `--eval` / `--output` fail closed;
 *   - `--eval` / `--output` / `--quiet` retained.
 */
export function normalizeReplayAggregateArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new Error("normalizeReplayAggregateArgs: argv must be an array");
  }
  let datasetDir = null;
  let evalDir = null;
  let output = null;
  let quiet = false;
  let quietSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--dataset=")) {
      throw new Error("t0-replay-aggregate rejects --dataset=<dir> (use --dataset <dir>)");
    }
    if (token.startsWith("--episodes=")) {
      throw new Error("t0-replay-aggregate rejects --episodes=<path> (the corpus is ONLY the committed replay dataset via --dataset)");
    }
    if (token.startsWith("--meta=")) {
      throw new Error("t0-replay-aggregate rejects --meta=<path> (the corpus is ONLY the committed replay dataset via --dataset)");
    }
    if (token.startsWith("--eval=")) {
      throw new Error("t0-replay-aggregate rejects --eval=<dir> (use --eval <dir>)");
    }
    if (token.startsWith("--output=")) {
      throw new Error("t0-replay-aggregate rejects --output=<path> (use --output <path>)");
    }
    if (token === "--dataset") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--dataset requires a directory path");
      }
      if (datasetDir !== null) {
        throw new Error("--dataset must be specified exactly once");
      }
      datasetDir = path.resolve(next);
      i++;
      continue;
    }
    if (token === "--episodes") {
      throw new Error("t0-replay-aggregate rejects --episodes (the corpus is ONLY the committed replay dataset via --dataset)");
    }
    if (token === "--meta") {
      throw new Error("t0-replay-aggregate rejects --meta (the corpus is ONLY the committed replay dataset via --dataset)");
    }
    if (token === "--eval") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--eval requires a directory path");
      }
      if (evalDir !== null) {
        throw new Error("--eval must be specified exactly once");
      }
      evalDir = path.resolve(next);
      i++;
      continue;
    }
    if (token === "--output") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--output requires a path");
      }
      if (output !== null) {
        throw new Error("--output must be specified exactly once");
      }
      output = path.resolve(next);
      i++;
      continue;
    }
    if (token === "--quiet") {
      if (quietSeen) {
        throw new Error("--quiet must be specified at most once");
      }
      quietSeen = true;
      quiet = true;
      continue;
    }
    throw new Error(`t0-replay-aggregate: unknown argument ${JSON.stringify(token)}`);
  }
  const home = path.resolve(process.env.HOME || os.homedir());
  const resolvedDataset = datasetDir ?? path.join(home, ".pi", ".pi-astack", "t0-replay");
  const resolvedEval = evalDir ?? path.join(home, ".pi", ".pi-astack", "t0-replay-eval");
  return {
    datasetDir: resolvedDataset,
    evalDir: resolvedEval,
    output: output ?? path.join(resolvedEval, "aggregate.json"),
    quiet,
  };
}

/**
 * Load the full per-episode replay evaluation records — the ONLY evidence
 * the CLI accepts. Reuses the shared fail-closed committed generation loader
 * (loadCommittedEvalGeneration) bound to the committed replay dataset
 * generation id + fixed replay judge roles: a missing summary.json returns
 * null; a present ordinary (non-replay) generation, wrong generation id, or
 * markerless dir is rejected. ONLY manifest-listed records are read.
 */
export function loadCommittedReplayEvalGeneration(evalDir, episodes, {
  expectedReplayDatasetGenerationId = null,
  expectedJudgeModels = null,
} = {}) {
  const committed = loadCommittedEvalGeneration(evalDir, {
    episodes,
    expectedReplayDatasetGenerationId,
    expectedJudgeModels,
    expectedGenerationKind: "replay",
  });
  return committed;
}

/**
 * Replay-specific reporting from the replay sidecar: per-model replay vs
 * historical slots, replay call attempts/cost/failures recomputed from
 * verified attempt_log ledgers (ternary known_cost/cost_complete/cost),
 * and the source episode mapping.
 */
export function replayReport(metaRecords) {
  const slots = {}; // model -> { replay: n, historical: n }
  const sourceEpisodes = [];
  let historyExcluded = false;
  let experimentMode = null;
  for (const meta of metaRecords) {
    if (meta.history_excluded === true) historyExcluded = true;
    if (typeof meta.experiment_mode === "string") experimentMode = meta.experiment_mode;
    sourceEpisodes.push({
      source_episode_id: meta.source_episode_id ?? null,
      replay_episode_id: meta.episode_id,
      source_content_hash: meta.source_content_hash ?? null,
      source_prompt_hash: meta.source_prompt_hash ?? null,
      replay_models: meta.replay_models ?? null,
      experiment_mode: meta.experiment_mode ?? null,
      history_excluded: meta.history_excluded === true,
    });
    for (const slot of meta.slots ?? []) {
      const model = slot.model ?? "unknown";
      const kind = slot.source?.kind === "historical" ? "historical" : "replay";
      const m = slots[model] ?? { replay: 0, historical: 0 };
      if (slot.in_body === true) m[kind]++;
      slots[model] = m;
    }
  }
  // Shared pure helper: recompute from attempt_log ledgers only — never
  // trust r.cost / r.attempts aggregates. Slot-level r.cost is untouched.
  const calls = summarizeReplayCallsFromMeta(metaRecords);
  return {
    slots,
    calls,
    source_episodes: sourceEpisodes,
    history_excluded: historyExcluded,
    experiment_mode: experimentMode,
  };
}

/**
 * Paired current-only report: only episodes where every replay_model is in_body
 * (fully paired). Capability metrics re-aggregated on that subset alone.
 *
 * Marks family_overlap when any evaluator/adjudicator shares a vendor family
 * with a candidate (e.g. Sol + GPT-5.5 both OpenAI). Opus independent scores
 * remain available via evaluator_1 / counterfactual.
 */
export function pairedCurrentOnlyReport(metaRecords, evalRecords, episodes, baseCapabilityByModel) {
  const pairedEpisodeIds = [];
  const unpaired = [];
  const targetModels = new Set();
  for (const meta of metaRecords) {
    const replayModels = Array.isArray(meta.replay_models) ? meta.replay_models : [];
    for (const m of replayModels) targetModels.add(m);
    const replaySlots = (meta.slots ?? []).filter((s) => s.source?.kind === "replay" || s.replay);
    const byModel = new Map(replaySlots.map((s) => [s.model, s]));
    const allOk = replayModels.length > 0 && replayModels.every((m) => byModel.get(m)?.in_body === true);
    // Body-present episodes are also paired under requirePaired builds.
    const bodyPaired = meta.paired_required === true
      ? allOk && Boolean(episodes.find((e) => e.episode_id === meta.episode_id))
      : allOk;
    if (bodyPaired) pairedEpisodeIds.push(meta.episode_id);
    else {
      unpaired.push({
        episode_id: meta.episode_id,
        source_episode_id: meta.source_episode_id ?? null,
        ok_models: replayModels.filter((m) => byModel.get(m)?.in_body === true),
        failed_models: replayModels.filter((m) => byModel.get(m)?.in_body !== true),
      });
    }
  }
  const pairedSet = new Set(pairedEpisodeIds);
  const pairedMeta = metaRecords.filter((m) => pairedSet.has(m.episode_id));
  const pairedEval = evalRecords.filter((r) => pairedSet.has(r.episode_id));
  const pairedEpisodes = episodes.filter((e) => pairedSet.has(e.episode_id));
  const pairedAgg = pairedEval.length > 0
    ? aggregate(pairedEval, pairedEpisodes, pairedMeta)
    : { capability: { by_model: [] }, episodes_evaluated: 0 };

  // Family overlap note: Sol adjudicator/evaluator0 vs openai/gpt-5.5 candidate.
  const candidateFamilies = new Set([...targetModels].map((m) => String(m).split("/")[0]));
  const judgeFamilies = new Set(["openai", "anthropic", "kimi-coding"]);
  const familyOverlap = [...candidateFamilies].filter((f) => judgeFamilies.has(f));

  const byModel = (pairedAgg.capability?.by_model ?? []).map((m) => ({
    model: m.model,
    episodes: m.episodes,
    candidate_slots: m.candidate_slots,
    evaluator_ratings: m.evaluator_ratings,
    correctness: m.correctness,
    verdicts: m.verdicts,
    counterfactual_net_value: m.counterfactual_net_value,
    unique_valid_contribution: m.unique_valid_contribution,
    claims: m.claims,
    noise_types: m.noise_types,
    missed_critical_points: m.missed_critical_points,
    unresolved_verdicts: m.unresolved_verdicts,
    judge_disagreement: m.judge_disagreement,
  }));

  return {
    experiment_mode: "current_models_equal_conditions",
    paired_n: pairedEpisodeIds.length,
    unpaired_n: unpaired.length,
    unpaired,
    episode_ids: pairedEpisodeIds,
    models: [...targetModels],
    family_overlap: {
      present: familyOverlap.length > 0,
      families: familyOverlap,
      note: familyOverlap.includes("openai")
        ? "evaluator0/adjudicator openai/gpt-5.6-sol shares OpenAI family with openai/gpt-5.5 control; evaluator1/counterfactual anthropic/claude-opus-5 is independent and reported separately"
        : "no candidate/judge family overlap detected",
    },
    scope_note: "prompt-only judgment qualification on fully paired current-only episodes; does NOT cover agentic execution capability",
    by_model: byModel,
    // Keep a thin pointer to full (possibly unpaired-mixed) capability for audit.
    full_capability_model_count: (baseCapabilityByModel ?? []).length,
  };
}

async function main() {
  let options;
  try {
    options = normalizeReplayAggregateArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`t0-replay-aggregate: ${err.message}`);
    process.exit(2);
  }
  // Committed corpus only — never bare-read episodes/meta/stats.
  const loaded = await loadCommittedReplayDataset(options.datasetDir);
  if (loaded === null) {
    console.error(`t0-replay-aggregate: no committed replay dataset found in ${options.datasetDir} (dataset.commit.json missing — public files without a commit marker are never evidence)`);
    process.exit(2);
  }
  const { episodes, meta: metaRecords, generationId } = loaded;
  if (!Array.isArray(episodes) || episodes.length === 0) {
    console.error(`t0-replay-aggregate: committed replay dataset has zero body episodes in ${options.datasetDir}`);
    process.exit(2);
  }
  const expectedJudgeModels = resolveJudgeModels(REPLAY_EVAL_JUDGE_MODELS_CSV);
  let committedEval;
  try {
    committedEval = loadCommittedReplayEvalGeneration(options.evalDir, episodes, {
      expectedReplayDatasetGenerationId: generationId,
      expectedJudgeModels,
    });
  } catch (err) {
    console.error(`t0-replay-aggregate: ${err.message}`);
    process.exit(2);
  }
  if (committedEval === null) {
    console.error(`t0-replay-aggregate: no committed evaluation generation found in ${options.evalDir} (summary.json missing — eval records without a commit marker are never evidence)`);
    process.exit(2);
  }
  const evalRecords = committedEval.records;
  if (evalRecords.length === 0) {
    console.error(`t0-replay-aggregate: committed generation has zero evaluation records in ${options.evalDir}`);
    process.exit(2);
  }
  const base = aggregate(evalRecords, episodes, metaRecords);
  const replay = replayReport(metaRecords);
  const result = {
    ...base,
    replay_schema_version: REPLAY_SCHEMA_VERSION,
    replay_dataset_generation_id: generationId,
    eval_generation_id: committedEval.summary.generation_id,
    replay,
  };
  const isCurrentOnly = replay.history_excluded === true
    || replay.experiment_mode === "current_models_equal_conditions"
    || metaRecords.some((m) => m.history_excluded === true || m.experiment_mode === "current_models_equal_conditions");
  if (isCurrentOnly) {
    result.paired_current_only = pairedCurrentOnlyReport(
      metaRecords,
      evalRecords,
      episodes,
      base.capability?.by_model,
    );
  }
  writeJsonFile(options.output, result);
  console.log(`t0-replay-aggregate: ${result.episodes_evaluated} episodes, ${result.capability.by_model.length} models`);
  if (!options.quiet) {
    for (const m of result.capability.by_model) {
      const c = m.correctness;
      const r = result.replay.slots[m.model] ?? { replay: 0, historical: 0 };
      console.log(`  ${m.model}: slots=${m.candidate_slots} (replay=${r.replay}, historical=${r.historical}) correct=${c.correct} partial=${c.partially_correct} incorrect=${c.incorrect} unresolved=${c.unresolved} unsupported=${m.claims.unsupported} contradicted=${m.claims.contradicted} unique=${m.unique_valid_contribution} net+=${m.counterfactual_net_value.positive}`);
    }
    const calls = result.replay.calls;
    // Never call .toFixed on a null cost — print known / incomplete explicitly.
    const costLine = calls.cost_complete
      ? `cost=$${Number(calls.known_cost).toFixed(4)} (${calls.cost_source ?? "n/a"})`
      : `cost=incomplete known=$${Number(calls.known_cost).toFixed(4)} unknown_attempts=${calls.unknown_attempts} (${calls.cost_source ?? "n/a"})`;
    console.log(`replay calls: ${calls.total} (ok=${calls.ok}, failed=${calls.failed}, attempts=${calls.attempts}), ${costLine}`);
    if (result.paired_current_only) {
      const p = result.paired_current_only;
      console.log(`paired current-only: n=${p.paired_n} unpaired=${p.unpaired_n} family_overlap=${p.family_overlap.present} (${p.family_overlap.families.join(",") || "none"})`);
      for (const m of p.by_model) {
        const e0 = m.evaluator_ratings?.evaluator_0 ?? {};
        const e1 = m.evaluator_ratings?.evaluator_1 ?? {};
        console.log(
          `  paired ${m.model}: e0(correct=${e0.correct ?? 0},partial=${e0.partially_correct ?? 0},incorrect=${e0.incorrect ?? 0}) `
          + `e1(correct=${e1.correct ?? 0},partial=${e1.partially_correct ?? 0},incorrect=${e1.incorrect ?? 0}) `
          + `verdict adopt=${m.verdicts?.adopt ?? 0}/consider=${m.verdicts?.consider ?? 0}/reject=${m.verdicts?.reject ?? 0} `
          + `net+=${m.counterfactual_net_value?.positive ?? 0} unsupported=${m.claims?.unsupported ?? 0}`,
        );
      }
    }
  }
  console.log(`output: ${options.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`t0-replay-aggregate failed: ${err.message}`);
    process.exit(1);
  });
}
