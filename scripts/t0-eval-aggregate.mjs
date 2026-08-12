#!/usr/bin/env node
/**
 * t0-eval-aggregate — aggregate T0 evaluation results by REAL model.
 *
 * This is the ONLY command allowed to read the identity sidecar
 * (episodes.meta.jsonl). It maps episode-local candidate ids (c0..cN) from
 * the evaluation outputs back to the real model names, then aggregates:
 *
 *   - correctness            per-model distribution of overall_correctness
 *                            ratings across both evaluators
 *   - unsupported/contradicted noise
 *                            per-model counts of unsupported/contradicted
 *                            claims flagged by the evaluators
 *   - unique valid contribution
 *                            per-model count of candidates with a
 *                            unique_valid_contribution from the
 *                            counterfactual judge
 *   - counterfactual net value
 *                            per-model distribution of net_value
 *   - unresolved             per-model unresolved verdicts / abstains
 *   - judge disagreement     per-model evaluator disagreement
 *
 * Availability (slots excluded from the capability body, from the sidecar's
 * in_body / exclusion_reason) is reported SEPARATELY and never mixed into the
 * capability aggregates.
 *
 * Usage:
 *   node scripts/t0-eval-aggregate.mjs [options]
 *
 * Options:
 *   --episodes <path>   episodes.jsonl (default: ~/.pi/.pi-astack/t0-episodes/episodes.jsonl)
 *   --meta <path>       episodes.meta.jsonl sidecar (default: same dir as episodes)
 *   --eval <dir>        evaluation output dir (default: ~/.pi/.pi-astack/t0-eval)
 *   --output <path>     aggregate output file (default: <eval>/aggregate.json)
 *   --quiet             suppress per-model lines
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVAL_SCHEMA_VERSION,
  parseCli,
  loadEpisodes,
  writeJsonFile,
  normalizeNoiseType,
} from "./t0-eval-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = parseCli(argv);
  const home = path.resolve(process.env.HOME || os.homedir());
  const episodesPath = args.episodes ? path.resolve(args.episodes) : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
  const metaPath = args.meta ? path.resolve(args.meta) : path.join(path.dirname(episodesPath), "episodes.meta.jsonl");
  const evalDir = args.eval ? path.resolve(args.eval) : path.join(home, ".pi", ".pi-astack", "t0-eval");
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
  // Primary source: the full per-episode records (with stages). The index is
  // a summary and may be clobbered by a later resume run on a subset.
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
  // Fallback: index entries (summary-only, no stages) when eval/ is absent.
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

/** Count availability slots from the given meta records. */
function countAvailability(metaRecords) {
  const availability = {
    slots_total: 0,
    slots_in_body: 0,
    slots_excluded: 0,
    by_reason: {},
    by_model: {},
  };
  for (const meta of metaRecords) {
    for (const slot of meta.slots ?? []) {
      availability.slots_total++;
      if (slot.in_body === true) {
        availability.slots_in_body++;
      } else {
        availability.slots_excluded++;
        const reason = slot.exclusion_reason ?? "unknown";
        availability.by_reason[reason] = (availability.by_reason[reason] ?? 0) + 1;
        const model = slot.model ?? "unknown";
        const m = availability.by_model[model] ?? { excluded: 0, by_reason: {} };
        m.excluded++;
        m.by_reason[reason] = (m.by_reason[reason] ?? 0) + 1;
        availability.by_model[model] = m;
      }
    }
  }
  return availability;
}

/**
 * Aggregate evaluation records by real model.
 * Returns { capability: { by_model }, availability, corpus_availability }.
 */
export function aggregate(evalRecords, episodes, metaRecords) {
  // Map slot_id -> model_id per episode from the body.
  const slotToCandidate = new Map(); // `${episodeId}\0${slotId}` -> model_id
  for (const ep of episodes) {
    for (const slot of ep.slots ?? []) {
      slotToCandidate.set(`${ep.episode_id}\0${slot.slot_id}`, slot.model_id);
    }
  }
  // Map candidate_id -> real model per episode from the sidecar.
  const candidateToModel = new Map(); // `${episodeId}\0${candidateId}` -> model
  for (const meta of metaRecords) {
    for (const slot of meta.slots ?? []) {
      if (slot.in_body !== true) continue;
      const candidateId = slotToCandidate.get(`${meta.episode_id}\0${slot.slot_id}`);
      if (candidateId !== undefined && typeof slot.model === "string") {
        candidateToModel.set(`${meta.episode_id}\0${candidateId}`, slot.model);
      }
    }
  }

  const byModel = new Map(); // model -> aggregate
  const getModel = (model) => {
    let agg = byModel.get(model);
    if (!agg) {
      agg = {
        model,
        episodes: new Set(),
        candidate_slots: 0,
        // Per-evaluator rating breakdown; candidate_slots counts each real
        // candidate once (not once per evaluator).
        evaluator_ratings: {
          evaluator_0: { correct: 0, partially_correct: 0, incorrect: 0, unresolved: 0 },
          evaluator_1: { correct: 0, partially_correct: 0, incorrect: 0, unresolved: 0 },
        },
        correctness: { correct: 0, partially_correct: 0, incorrect: 0, unresolved: 0 },
        claims: { supported: 0, unsupported: 0, contradicted: 0, unverifiable: 0 },
        missed_critical_points: 0,
        noise_types: {},
        unique_valid_contribution: 0,
        counterfactual_net_value: { positive: 0, neutral: 0, negative: 0, unresolved: 0 },
        counterfactual_information_loss: { high: 0, medium: 0, low: 0, none: 0, unresolved: 0 },
        counterfactual_noise_reduction: { high: 0, medium: 0, low: 0, none: 0, unresolved: 0 },
        unresolved_verdicts: 0,
        abstains: 0,
        judge_disagreement: { high: 0, medium: 0, low: 0, unresolved: 0 },
        verdicts: { adopt: 0, consider: 0, reject: 0, unresolved: 0 },
      };
      byModel.set(model, agg);
    }
    return agg;
  };

  // Availability is limited to the EVALUATED episodes; the full corpus is
  // reported separately in corpus_availability (never mixed).
  const evaluatedEpisodeIds = new Set(evalRecords.map((r) => r.episode_id));
  const availability = countAvailability(metaRecords.filter((m) => evaluatedEpisodeIds.has(m.episode_id)));
  const corpusAvailability = countAvailability(metaRecords);

  for (const rec of evalRecords) {
    const episodeId = rec.episode_id;
    const stages = rec.stages ?? {};
    const modelOf = (candidateId) => candidateToModel.get(`${episodeId}\0${candidateId}`);

    // Evaluators: correctness + claims + noise per candidate. candidate_slots
    // counts each real candidate once per episode (distinct across evaluators).
    const distinctByModel = new Map(); // model -> Set of candidate ids
    for (const stageKey of ["evaluator_0", "evaluator_1"]) {
      const stage = stages[stageKey];
      if (!stage?.ok || !stage.data) continue;
      for (const cand of stage.data.candidates ?? []) {
        const model = modelOf(cand.candidate_id);
        if (!model) continue;
        const agg = getModel(model);
        agg.episodes.add(episodeId);
        let set = distinctByModel.get(model);
        if (!set) { set = new Set(); distinctByModel.set(model, set); }
        set.add(cand.candidate_id);
        const rating = cand.overall_correctness?.rating;
        if (rating) {
          agg.evaluator_ratings[stageKey][rating] = (agg.evaluator_ratings[stageKey][rating] ?? 0) + 1;
          agg.correctness[rating] = (agg.correctness[rating] ?? 0) + 1;
        }
        const claims = cand.claims ?? {};
        for (const bucket of ["supported", "unsupported", "contradicted", "unverifiable"]) {
          agg.claims[bucket] += Array.isArray(claims[bucket]) ? claims[bucket].length : 0;
        }
        agg.missed_critical_points += Array.isArray(cand.missed_critical_points) ? cand.missed_critical_points.length : 0;
        for (const noise of cand.noise_types ?? []) {
          const key = normalizeNoiseType(noise);
          agg.noise_types[key] = (agg.noise_types[key] ?? 0) + 1;
        }
        if (cand.abstain === true) agg.abstains++;
      }
    }
    for (const [model, set] of distinctByModel) {
      getModel(model).candidate_slots += set.size;
    }

    // Adjudicator: verdicts + unresolved + disagreement.
    const adj = stages.adjudicator;
    if (adj?.ok && adj.data) {
      for (const v of adj.data.verdicts ?? []) {
        const model = modelOf(v.candidate_id);
        if (!model) continue;
        const agg = getModel(model);
        agg.verdicts[v.verdict] = (agg.verdicts[v.verdict] ?? 0) + 1;
        if (v.verdict === "unresolved") agg.unresolved_verdicts++;
      }
      const disagreement = adj.data.disagreement?.evaluator_disagreement;
      if (disagreement) {
        // Disagreement is episode-level; attribute to every model in the episode.
        const models = new Set();
        for (const v of adj.data.verdicts ?? []) {
          const model = modelOf(v.candidate_id);
          if (model) models.add(model);
        }
        for (const model of models) {
          getModel(model).judge_disagreement[disagreement] = (getModel(model).judge_disagreement[disagreement] ?? 0) + 1;
        }
      }
    }

    // Counterfactual: unique valid contribution + net value + info loss + noise reduction.
    const cf = stages.counterfactual;
    if (cf?.ok && cf.data) {
      for (const c of cf.data.per_candidate ?? []) {
        const model = modelOf(c.candidate_id);
        if (!model) continue;
        const agg = getModel(model);
        // Structured contribution: only exists=true counts.
        if (c.unique_valid_contribution?.exists === true) agg.unique_valid_contribution++;
        if (c.net_value) agg.counterfactual_net_value[c.net_value] = (agg.counterfactual_net_value[c.net_value] ?? 0) + 1;
        if (c.information_loss) agg.counterfactual_information_loss[c.information_loss] = (agg.counterfactual_information_loss[c.information_loss] ?? 0) + 1;
        if (c.noise_reduction) agg.counterfactual_noise_reduction[c.noise_reduction] = (agg.counterfactual_noise_reduction[c.noise_reduction] ?? 0) + 1;
      }
    }
  }

  const byModelOut = [...byModel.values()]
    .map((agg) => ({
      model: agg.model,
      episodes: agg.episodes.size,
      candidate_slots: agg.candidate_slots,
      evaluator_ratings: agg.evaluator_ratings,
      correctness: agg.correctness,
      claims: agg.claims,
      missed_critical_points: agg.missed_critical_points,
      noise_types: agg.noise_types,
      unique_valid_contribution: agg.unique_valid_contribution,
      counterfactual_net_value: agg.counterfactual_net_value,
      counterfactual_information_loss: agg.counterfactual_information_loss,
      counterfactual_noise_reduction: agg.counterfactual_noise_reduction,
      unresolved_verdicts: agg.unresolved_verdicts,
      abstains: agg.abstains,
      judge_disagreement: agg.judge_disagreement,
      verdicts: agg.verdicts,
    }))
    .sort((a, b) => b.candidate_slots - a.candidate_slots);

  return {
    schema_version: EVAL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    episodes_evaluated: evalRecords.length,
    capability: { by_model: byModelOut },
    availability,
    corpus_availability: corpusAvailability,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const episodes = loadEpisodes(options.episodesPath);
  const metaRecords = loadMeta(options.metaPath);
  const evalRecords = loadEvalRecords(options.evalDir);
  if (evalRecords.length === 0) {
    console.error(`t0-eval-aggregate: no evaluation records found in ${options.evalDir}`);
    process.exit(2);
  }
  const result = aggregate(evalRecords, episodes, metaRecords);
  writeJsonFile(options.output, result);
  console.log(`t0-eval-aggregate: ${result.episodes_evaluated} episodes, ${result.capability.by_model.length} models`);
  if (!options.quiet) {
    for (const m of result.capability.by_model) {
      const c = m.correctness;
      console.log(`  ${m.model}: slots=${m.candidate_slots} correct=${c.correct} partial=${c.partially_correct} incorrect=${c.incorrect} unresolved=${c.unresolved} unsupported=${m.claims.unsupported} contradicted=${m.claims.contradicted} unique=${m.unique_valid_contribution} net+=${m.counterfactual_net_value.positive}`);
    }
  }
  console.log(`availability: ${result.availability.slots_in_body}/${result.availability.slots_total} in body, ${result.availability.slots_excluded} excluded`);
  console.log(`output: ${options.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
