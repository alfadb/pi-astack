#!/usr/bin/env node
/**
 * t0-replay-select — fair prompt-only replay sample selection + classification.
 *
 * Builds a replayable source-episode list from real episodes.jsonl +
 * episodes.meta.jsonl for prompt-only judgment replay (NOT agentic execution).
 *
 * Pipeline:
 *   1. Hard structural gates (exact|heuristic join, tools===null, body/meta 1:1,
 *      self-contained outputs, ≥1 strong ref, ≥1 specialist, no downstream judges)
 *   2. Dual LLM prompt-only classifier (--classifier-models, exactly 2 distinct)
 *      on hard-pass candidates only — either non-replayable or disagreement
 *      → fail-closed
 *   3. Mechanical hard exclude for prompts that clearly require external files /
 *      commands / live repo state (overrides LLM true; does not false-positive
 *      embedded-code review)
 *
 * Outputs a JSON manifest with selected episode ids, exclusion reasons,
 * exclusion distribution, join tiers, and classifier cost breakdown.
 * Checkpoints bind schema_version + episode_id + prompt_hash + protocol_hash
 * + exactly two judge_models + thinking.
 *
 * This script does NOT call Flash/Grok and does NOT run replay build/eval.
 * It ONLY produces the fair selection manifest. Future replay-build must
 * consume this manifest; do not treat build's legacy internal selection as
 * a fair-selection bypass.
 *
 * Usage:
 *   node scripts/t0-replay-select.mjs [options]
 *
 * Options:
 *   --episodes <path>   source episodes.jsonl (default:
 *                       ~/.pi/.pi-astack/t0-episodes/episodes.jsonl)
 *   --meta <path>       source episodes.meta.jsonl sidecar (default: same dir)
 *   --episode <id>      restrict to source episode id(s); repeatable/comma
 *   --limit <n>         max hard-pass candidates to classify (default: all)
 *   --concurrency <n>   parallel classifier episodes (default: 2)
 *   --output <path>     write the JSON manifest
 *   --checkpoint-dir <dir>  classifier checkpoint directory
 *   --hard-only         skip LLM classification; list hard-pass candidates
 *   --no-resume         ignore existing classifier checkpoints
 *   --models-json <path>  models.json (default: ~/.pi/agent/models.json)
 *   --timeout-ms <n>    per-judge call timeout (default: 600000)
 *   --max-retries <n>   bounded retries per judge (default: 2)
 *   --thinking <level>  classifier thinking (default: medium)
 *   --classifier-models <a,b>
 *                       exactly 2 distinct classifier models (default:
 *                       openai/gpt-5.6-sol,anthropic/claude-opus-5)
 *   --downstream-judges <csv>
 *                       1..5 distinct models excluded as self-candidates
 *                       (default: Sol,Opus5,K3 — replay-eval five roles deduped)
 *   --json              print selected episode ids as a JSON array on stdout
 *   --quiet             suppress progress lines
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCli,
  nonNegativeInt,
  loadEpisodes,
  makeJudgeInvoker,
} from "./t0-eval-common.mjs";
import {
  loadMeta,
  selectFairReplayEpisodes,
  CLASSIFIER_DEFAULT_JUDGES,
  CLASSIFIER_DEFAULT_CONCURRENCY,
  CLASSIFIER_DEFAULT_MAX_RETRIES,
  CLASSIFIER_DEFAULT_TIMEOUT_MS,
  CLASSIFIER_DEFAULT_THINKING,
  DEFAULT_DOWNSTREAM_JUDGES,
  FAIR_SELECT_SCHEMA_VERSION,
  parseModelList,
  requireExactlyTwoDistinctJudges,
  requireDownstreamJudges,
} from "./t0-replay-fair-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = parseCli(argv);
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const episodesPath = args.episodes
    ? path.resolve(args.episodes)
    : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
  const metaPath = args.meta
    ? path.resolve(args.meta)
    : path.join(path.dirname(episodesPath), "episodes.meta.jsonl");
  const rawEpisode = args.episode;
  const episodeIds = rawEpisode === undefined || rawEpisode === true
    ? null
    : (Array.isArray(rawEpisode) ? rawEpisode : [rawEpisode])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
  const output = args.output ? path.resolve(args.output) : null;
  const checkpointDir = args["checkpoint-dir"]
    ? path.resolve(args["checkpoint-dir"])
    : (output ? path.join(path.dirname(output), "checkpoints-fair") : null);

  const classifierRaw = parseModelList(args["classifier-models"]);
  const classifierModels = requireExactlyTwoDistinctJudges(
    classifierRaw ?? [...CLASSIFIER_DEFAULT_JUDGES],
    { label: "--classifier-models" },
  );

  const downstreamRaw = parseModelList(args["downstream-judges"]);
  const downstreamJudges = requireDownstreamJudges(
    downstreamRaw ?? [...DEFAULT_DOWNSTREAM_JUDGES],
    { label: "--downstream-judges" },
  );

  return {
    episodesPath,
    metaPath,
    episodeIds,
    limit: nonNegativeInt(args.limit, undefined),
    concurrency: Math.max(1, nonNegativeInt(args.concurrency, CLASSIFIER_DEFAULT_CONCURRENCY)),
    output,
    checkpointDir,
    hardOnly: args["hard-only"] === true,
    resume: args["no-resume"] !== true,
    modelsJsonPath: args["models-json"]
      ? path.resolve(args["models-json"])
      : path.join(agentDir, "models.json"),
    timeoutMs: nonNegativeInt(args["timeout-ms"], CLASSIFIER_DEFAULT_TIMEOUT_MS),
    maxRetries: nonNegativeInt(args["max-retries"], CLASSIFIER_DEFAULT_MAX_RETRIES),
    thinking: typeof args.thinking === "string" && args.thinking.trim()
      ? args.thinking.trim()
      : CLASSIFIER_DEFAULT_THINKING,
    json: args.json === true,
    quiet: args.quiet === true,
    classifierModels,
    downstreamJudges,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const episodes = loadEpisodes(options.episodesPath);
  const metaRecords = loadMeta(options.metaPath);
  const metaById = new Map(metaRecords.map((m) => [m.episode_id, m]));

  let invoker = null;
  if (!options.hardOnly) {
    invoker = await makeJudgeInvoker({ modelsJsonPath: options.modelsJsonPath });
  }

  const manifest = await selectFairReplayEpisodes(episodes, metaById, {
    episodeIds: options.episodeIds,
    limit: options.limit,
    classify: !options.hardOnly,
    invoker,
    judgeModels: options.classifierModels,
    downstreamJudges: options.downstreamJudges,
    maxRetries: options.maxRetries,
    timeoutMs: options.timeoutMs,
    thinking: options.thinking,
    concurrency: options.concurrency,
    outputDir: options.checkpointDir,
    resume: options.resume,
    quiet: options.quiet,
  });

  const payload = {
    ...manifest,
    schema_version: FAIR_SELECT_SCHEMA_VERSION,
    episodes: options.episodesPath,
    meta: options.metaPath,
    limit: options.limit ?? null,
    concurrency: options.concurrency,
    hard_only: options.hardOnly,
    classifier_models: options.classifierModels,
    downstream_judges: options.downstreamJudges,
    episode_ids: manifest.selected.map((s) => s.episode_id),
  };

  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
    if (!options.quiet) {
      console.error(`t0-replay-select: wrote manifest (${payload.episode_ids.length} selected) to ${options.output}`);
    }
  }

  const ids = payload.episode_ids;
  if (options.json) {
    console.log(JSON.stringify(ids));
  } else {
    for (const id of ids) console.log(id);
  }

  if (!options.quiet) {
    const c = payload.counts;
    const cost = payload.cost;
    console.error(
      `t0-replay-select: source=${c.source} hard_pass=${c.hard_pass} `
      + `join_hard={exact:${c.join_hard_pass?.exact ?? 0},heuristic:${c.join_hard_pass?.heuristic ?? 0}} `
      + `classified=${c.classified} replayable=${c.replayable} excluded=${c.excluded} `
      + `cost_known_usd=${cost.known_total} cost_total=${cost.total} cost_source=${cost.source} `
      + `cost_breakdown=${JSON.stringify(cost.breakdown)}`
      + (c.data_insufficient ? " DATA_INSUFFICIENT(<2 replayable)" : ""),
    );
    console.error(`t0-replay-select: exclusion_distribution=${JSON.stringify(payload.exclusion_distribution)}`);
    if (c.data_insufficient) {
      console.error(
        "t0-replay-select: data insufficient for a fair prompt-only replay set "
        + `(replayable=${c.replayable} < 2). Hard gates require exact|heuristic join, tools=null, `
        + "body/meta 1:1, strong ref + specialist, no downstream-judge candidates, plus dual "
        + "prompt-only LLM classification and mechanical external workspace/file/command exclude.",
      );
    }
  }

  // Non-zero exit when classification was requested and fewer than 2
  // replayable survive — callers can detect data insufficiency.
  // hard-only listing never fails the process on count alone.
  if (!options.hardOnly && payload.counts.data_insufficient) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`t0-replay-select failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { parseArgs, main };
