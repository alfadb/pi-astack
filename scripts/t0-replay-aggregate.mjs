#!/usr/bin/env node
/**
 * t0-replay-aggregate — aggregate replay evaluation results by REAL model.
 *
 * Reuses t0-eval-aggregate.mjs's aggregate() — the ONLY identity-aware
 * aggregation logic — and adds replay-specific reporting:
 *
 *   - replay.slots: per-model replay vs historical candidate slots (from the
 *     replay sidecar's source.kind)
 *   - replay.calls: replay call attempts/cost/failures (from the replay
 *     sidecar's replay.attempt_log) — the replay build's own spend, separate
 *     from the judge spend
 *   - replay.source_episodes: source episode -> replay episode mapping
 *
 * The existing 48-episode production record is NEVER touched: this command
 * reads only the replay dataset + replay eval output.
 *
 * Usage:
 *   node scripts/t0-replay-aggregate.mjs [options]
 *
 * Options:
 *   --episodes <path>   replay episodes.jsonl (default:
 *                       ~/.pi/.pi-astack/t0-replay/episodes.jsonl)
 *   --meta <path>       replay episodes.meta.jsonl sidecar (default: same dir)
 *   --eval <dir>        evaluation output dir (default:
 *                       ~/.pi/.pi-astack/t0-replay-eval)
 *   --output <path>     aggregate output file (default: <eval>/aggregate.json)
 *   --quiet             suppress per-model lines
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCli, loadEpisodes, writeJsonFile } from "./t0-eval-common.mjs";
import { aggregate } from "./t0-eval-aggregate.mjs";
import { REPLAY_SCHEMA_VERSION } from "./t0-replay-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = parseCli(argv);
  const home = path.resolve(process.env.HOME || os.homedir());
  const episodesPath = args.episodes ? path.resolve(args.episodes) : path.join(home, ".pi", ".pi-astack", "t0-replay", "episodes.jsonl");
  const metaPath = args.meta ? path.resolve(args.meta) : path.join(path.dirname(episodesPath), "episodes.meta.jsonl");
  const evalDir = args.eval ? path.resolve(args.eval) : path.join(home, ".pi", ".pi-astack", "t0-replay-eval");
  return {
    episodesPath,
    metaPath,
    evalDir,
    output: args.output ? path.resolve(args.output) : path.join(evalDir, "aggregate.json"),
    quiet: args.quiet === true,
  };
}

function loadMeta(metaPath) {
  if (!fs.existsSync(metaPath)) throw new Error(`meta sidecar not found: ${metaPath}`);
  const records = [];
  for (const line of fs.readFileSync(metaPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && typeof row.episode_id === "string") records.push(row);
    } catch {
      /* skip malformed lines */
    }
  }
  return records;
}

function loadEvalRecords(evalDir) {
  const records = [];
  const evalSub = path.join(evalDir, "eval");
  if (fs.existsSync(evalSub)) {
    for (const name of fs.readdirSync(evalSub)) {
      if (!name.endsWith(".json")) continue;
      try {
        const row = JSON.parse(fs.readFileSync(path.join(evalSub, name), "utf8"));
        if (row && typeof row === "object" && typeof row.episode_id === "string") records.push(row);
      } catch {
        /* skip */
      }
    }
  }
  if (records.length > 0) return records;
  const indexFile = path.join(evalDir, "eval-index.jsonl");
  if (fs.existsSync(indexFile)) {
    for (const line of fs.readFileSync(indexFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === "object" && typeof row.episode_id === "string") records.push(row);
      } catch {
        /* skip */
      }
    }
  }
  return records;
}

/**
 * Replay-specific reporting from the replay sidecar: per-model replay vs
 * historical slots, replay call attempts/cost/failures, and the source
 * episode mapping.
 */
export function replayReport(metaRecords) {
  const slots = {}; // model -> { replay: n, historical: n }
  const calls = { total: 0, ok: 0, failed: 0, attempts: 0, cost: 0, cost_source: null, by_model: {} };
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
      const r = slot.replay;
      if (!r) continue;
      calls.total++;
      if (slot.in_body === true) calls.ok++;
      else calls.failed++;
      calls.attempts += typeof r.attempts === "number" ? r.attempts : 0;
      calls.cost += typeof r.cost === "number" ? r.cost : 0;
      const cm = calls.by_model[model] ?? { total: 0, ok: 0, failed: 0, attempts: 0, cost: 0 };
      cm.total++;
      if (slot.in_body === true) cm.ok++;
      else cm.failed++;
      cm.attempts += typeof r.attempts === "number" ? r.attempts : 0;
      cm.cost += typeof r.cost === "number" ? r.cost : 0;
      calls.by_model[model] = cm;
    }
  }
  const costSources = new Set();
  for (const meta of metaRecords) {
    for (const slot of meta.slots ?? []) {
      if (typeof slot.replay?.cost_source === "string") costSources.add(slot.replay.cost_source);
    }
  }
  calls.cost_source = costSources.size === 0 ? null : costSources.size === 1 ? [...costSources][0] : "mixed";
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const episodes = loadEpisodes(options.episodesPath);
  const metaRecords = loadMeta(options.metaPath);
  const evalRecords = loadEvalRecords(options.evalDir);
  if (evalRecords.length === 0) {
    console.error(`t0-replay-aggregate: no evaluation records found in ${options.evalDir}`);
    process.exit(2);
  }
  const base = aggregate(evalRecords, episodes, metaRecords);
  const replay = replayReport(metaRecords);
  const result = {
    ...base,
    replay_schema_version: REPLAY_SCHEMA_VERSION,
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
    console.log(`replay calls: ${calls.total} (ok=${calls.ok}, failed=${calls.failed}, attempts=${calls.attempts}), cost=$${calls.cost.toFixed(4)} (${calls.cost_source ?? "n/a"})`);
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
  main();
}
