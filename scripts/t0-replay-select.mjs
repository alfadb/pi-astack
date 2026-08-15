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
 *   --exclusions <path>  source exclusions.jsonl (default: same dir as meta)
 *   --stats <path>      source stats.json (default: same dir as meta)
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
  parseStrictCli,
  nonNegativeInt,
  isSafeDecimal,
  NONNEGATIVE_DECIMAL_RE,
  POSITIVE_DECIMAL_RE,
  loadEpisodes,
  loadExclusionRecords,
  loadStats,
  makeJudgeInvoker,
  assertProducerInventory,
} from "./t0-eval-common.mjs";
import {
  loadMeta,
  selectFairReplayEpisodes,
  preflightClassifierCheckpoints,
  validateFairManifestProvenance,
  classifierCheckpointDir,
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

/** Closed allowlist of value-bearing raw CLI flags for t0-replay-select. */
const SELECT_VALUE_FLAGS = Object.freeze([
  "episodes", "meta", "exclusions", "stats", "episode", "limit",
  "concurrency", "output", "checkpoint-dir", "models-json", "timeout-ms",
  "max-retries", "thinking", "classifier-models", "downstream-judges",
]);
/** Closed allowlist of boolean raw CLI flags for t0-replay-select. */
const SELECT_BOOLEAN_FLAGS = Object.freeze([
  "hard-only", "no-resume", "json", "quiet",
]);
/** Value flags that may repeat and accumulate (space form only). */
const SELECT_REPEATABLE_VALUE_FLAGS = Object.freeze(["episode"]);
const SELECT_NON_NEG_INT_FLAGS = new Set(["limit", "max-retries"]);
const SELECT_POS_INT_FLAGS = new Set(["concurrency", "timeout-ms"]);

function assertNonNegativeIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, NONNEGATIVE_DECIMAL_RE)) {
    throw new Error(`t0-replay-select: --${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

function assertPositiveIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, POSITIVE_DECIMAL_RE)) {
    throw new Error(`t0-replay-select: --${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * Explicit CSV flag gate: every comma segment must be semantically non-empty
 * after trim — `,`, `,,`, `a,,b` fail closed instead of silently dropping
 * empty segments (which could otherwise widen a selection or fall back to
 * defaults via parseModelList's null). Repeated flags still accumulate
 * (parseStrictCli repeatable).
 */
function assertNonEmptyCsvRaw(flag, value) {
  const segments = String(value).split(",").map((s) => s.trim());
  if (segments.some((s) => s.length === 0)) {
    throw new Error(`t0-replay-select: --${flag} requires a non-empty comma-separated value (each segment must be non-empty), got ${JSON.stringify(value)}`);
  }
}

/**
 * Strict raw-argv entry for the CLI. Uses shared parseStrictCli (closed
 * allowlist; rejects --flag=value / unknown / positional / non-repeatable
 * duplicates / missing values / boolean-with-value) plus raw numeric and
 * non-empty value gates so a malformed argv can never silently resolve the
 * production default paths. Exported for offline tests.
 */
export function parseArgs(argv) {
  const args = parseStrictCli(argv, {
    valueFlags: SELECT_VALUE_FLAGS,
    booleanFlags: SELECT_BOOLEAN_FLAGS,
    repeatableValueFlags: SELECT_REPEATABLE_VALUE_FLAGS,
  });
  for (const [key, raw] of Object.entries(args)) {
    if (raw === true) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (SELECT_NON_NEG_INT_FLAGS.has(key)) {
        assertNonNegativeIntRaw(key, value);
      } else if (SELECT_POS_INT_FLAGS.has(key)) {
        assertPositiveIntRaw(key, value);
      } else if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`t0-replay-select: --${key} requires a non-empty value`);
      }
    }
  }
  // Explicit CSV flags (--episode / --classifier-models / --downstream-judges):
  // every comma segment must be semantically non-empty after trim — `,`,
  // `,,`, `a,,b` fail closed instead of silently dropping empty segments.
  // This prevents an explicit-but-empty CSV from widening the selection or
  // falling back to defaults via parseModelList's null (e.g. `--episode ,`
  // must throw before parse, never become a full run). Repeated --episode
  // flags still accumulate (parseStrictCli repeatable).
  for (const key of ["episode", "classifier-models", "downstream-judges"]) {
    const raw = args[key];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      assertNonEmptyCsvRaw(key, value);
    }
  }
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const episodesPath = args.episodes
    ? path.resolve(args.episodes)
    : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
  const metaPath = args.meta
    ? path.resolve(args.meta)
    : path.join(path.dirname(episodesPath), "episodes.meta.jsonl");
  const exclusionsPath = args.exclusions
    ? path.resolve(args.exclusions)
    : path.join(path.dirname(metaPath), "exclusions.jsonl");
  const statsPath = args.stats
    ? path.resolve(args.stats)
    : path.join(path.dirname(metaPath), "stats.json");
  const rawEpisode = args.episode;
  const episodeIds = rawEpisode === undefined
    ? null
    : (Array.isArray(rawEpisode) ? rawEpisode : [rawEpisode])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
  const hardOnly = args["hard-only"] === true;
  const output = args.output !== undefined ? path.resolve(args.output) : null;
  const checkpointDir = args["checkpoint-dir"]
    ? path.resolve(args["checkpoint-dir"])
    : (output ? path.join(path.dirname(output), "checkpoints-fair") : null);
  // Paid persistence gate: classify mode (non-hard-only) MUST have a durable
  // checkpoint target — explicit --checkpoint-dir or derived from --output.
  // Without one, paid classifier requests would have no durable target; this
  // throws BEFORE any load / invoker / provider work.
  if (!hardOnly && !checkpointDir) {
    throw new Error(
      "t0-replay-select: classify mode requires a durable checkpoint target — pass --checkpoint-dir or --output "
      + "(checkpoints derive from the output dir); without one, paid classifier requests have no durable target",
    );
  }
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
  // Legal custom downstream sets are DEFAULT supersets: every fixed
  // DEFAULT_DOWNSTREAM_JUDGES member must be present. A custom set that
  // drops a required replay-eval judge would silently weaken the
  // self-candidate exclusion (a judge candidate could re-enter the sample),
  // so it fails closed here — BEFORE any return / I/O / invoker work.
  for (const required of DEFAULT_DOWNSTREAM_JUDGES) {
    if (!downstreamJudges.includes(required)) {
      throw new Error(
        `t0-replay-select: --downstream-judges must include every default downstream judge (missing ${required}) — `
        + "a custom set may only ADD judges, never drop a required replay-eval judge",
      );
    }
  }

  return {
    episodesPath,
    metaPath,
    exclusionsPath,
    statsPath,
    episodeIds,
    limit: nonNegativeInt(args.limit, undefined),
    concurrency: nonNegativeInt(args.concurrency, CLASSIFIER_DEFAULT_CONCURRENCY),
    output,
    checkpointDir,
    hardOnly,
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

/**
 * Minimal safe output-intent extraction from RAW argv, used ONLY for the
 * fail-closed pre-deletion of an existing manifest in classify mode. Scans
 * the raw tokens with the SAME convention parseStrictCli uses (a flag
 * followed by a non-flag token consumes it as its VALUE) WITHOUT running any
 * full-argument validation:
 *   - a BARE `--hard-only` flag (not followed by a value token) →
 *     { hardOnly: true, output: null } (no deletion; hard-only never
 *     pre-deletes old output, it atomically replaces on success); a
 *     `--hard-only <value>` form is NOT a bare flag under the strict
 *     parser's convention (the next token is consumed as its value) and is
 *     therefore treated as classify intent — parseStrictCli rejects the
 *     value form ("boolean option --hard-only must not take a value") after
 *     preflight has revoked the uniquely determinable --output
 *   - exactly one distinct `--output <value>` → { hardOnly, output: value }
 *   - no `--output` → { hardOnly, output: null }
 *   - multiple DIFFERENT `--output` values, or a `--output` with no value
 *     → null (ambiguous — never delete a path we cannot uniquely determine;
 *     parseArgs rejects the invocation with a clear error). A repeated
 *     IDENTICAL `--output` value is still uniquely determinable (preflight
 *     may revoke it) but parseArgs rejects any duplicate occurrence.
 *   - a malformed equals form `--output=<nonempty path>` is ALSO recognized
 *     (parseStrictCli rejects `--flag=value`, but the uniquely determinable
 *     path is still revoked before the strict parse fails); an empty
 *     `--output=` stays ambiguous → null (nothing deleted).
 *   - `--hard-only=true` (or any `--hard-only=<value>`) is a value form, NOT
 *     a bare flag → classify intent (its unique `--output` is revoked); only
 *     a BARE `--hard-only` sets hardOnly and pre-deletes nothing.
 * Pure, no I/O, exported for offline tests.
 */
export function preflightOutputIntent(argv) {
  let hardOnly = false;
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--hard-only") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        // strict-parser convention: `--hard-only <value>` consumes the next
        // token as a VALUE — not a bare flag, so classify intent
        // (parseStrictCli rejects the value form explicitly).
        i++;
      } else {
        hardOnly = true;
      }
    } else if (token.startsWith("--hard-only=")) {
      // equals form is a value form → classify intent, never a bare flag
      // (parseStrictCli rejects `--flag=value` explicitly).
    } else if (token === "--output") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null; // flag without a value → ambiguous
      values.push(next);
      i++;
    } else if (token.startsWith("--output=")) {
      const value = token.slice("--output=".length);
      if (value.length === 0) return null; // empty `--output=` → ambiguous
      values.push(value);
    }
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) return null; // multiple different outputs → ambiguous
  return { hardOnly, output: distinct.length === 1 ? distinct[0] : null };
}

/**
 * Atomic manifest publish: write to a same-dir temp file, then rename over
 * the target. A crash/failure mid-write never leaves a partial manifest at
 * the canonical path; the temp is cleaned up on failure. Single-writer only
 * (see docs/t0-replay.md — the canonical selector output does not support
 * concurrent writers; callers must serialize). Exported for offline tests.
 */
export function publishJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

/**
 * Provenance-gated atomic publish: validate the payload against the REAL
 * corpus + its own checkpoints (validateFairManifestProvenance) BEFORE the
 * atomic rename. A fake v2 classifier checkpoint can never cause a publish —
 * provenance fails and nothing is written (the old output was already
 * revoked by the preflight). hard-only listings never reach this path;
 * data_insufficient classify runs never reach it either (the caller checks
 * before invoking). Exported for offline tests (real temp checkpoint +
 * publication path).
 *
 * checkpointDir is the LEAF (the directory holding `<episode_id>.json`
 * directly) — derive it from the checkpoint ROOT via the shared
 * classifierCheckpointDir(root) helper; the root itself is never a valid
 * checkpointDir here.
 *
 * downstreamJudges is the scan's downstream-judge set (the same value the
 * fresh scan used). It is forwarded to validateFairManifestProvenance so a
 * legal non-default CLI/producer configuration never falls back to the
 * default set after paid work; a wrong/missing mismatch still fails closed.
 */
export function publishSelectionManifest({ payload, episodes, metaById, exclusions, stats, checkpointDir, output, downstreamJudges }) {
  const provenance = validateFairManifestProvenance({
    manifest: payload,
    episodes,
    metaById,
    exclusions,
    stats,
    checkpointDir,
    downstreamJudges,
  });
  if (!provenance.ok) {
    throw new Error(
      `t0-replay-select: manifest provenance validation FAILED before publish (${provenance.errors.length}):\n  - ${provenance.errors.slice(0, 10).join("\n  - ")}`,
    );
  }
  publishJsonAtomic(output, payload);
  return output;
}

async function main() {
  // Fail-closed output contract: in classify mode, remove any existing
  // output manifest BEFORE any full-argument validation that can throw and
  // before any real invoker/provider work — a failed run must never leave a
  // stale manifest that looks current. Only the uniquely determinable
  // --output path is revoked (a duplicate / missing-value --output is
  // ambiguous: nothing is deleted and parseArgs rejects the invocation).
  const intent = preflightOutputIntent(process.argv.slice(2));
  if (intent && !intent.hardOnly && intent.output && fs.existsSync(intent.output)) {
    fs.rmSync(intent.output, { force: true });
  }

  const options = parseArgs(process.argv.slice(2));

  // Classify mode with any execution filter (--episode ids or --limit,
  // including --limit 0) plus --output is refused: a filtered classify run
  // is a DIAGNOSTIC, never a complete production manifest. The old output
  // (if any) was already revoked by the preflight above; this throw happens
  // before any strict load / invoker / provider work, so nothing is
  // classified, nothing is published and no tmp / checkpoint is left
  // behind. hard-only listings may filter and output (they are not
  // classified production manifests); classify without --output stays a
  // valid diagnostic run (it produces no consumable manifest).
  const filtered = (options.episodeIds?.length ?? 0) > 0 || options.limit !== undefined;
  if (!options.hardOnly && options.output && filtered) {
    throw new Error(
      "t0-replay-select: classify mode with --episode/--limit filtering and --output is refused "
      + "(a filtered classify run is a diagnostic, never a complete production manifest). "
      + "Use --hard-only for filtered listings, or drop --episode/--limit for a full classify run.",
    );
  }

  const episodes = loadEpisodes(options.episodesPath, { strict: true });
  const metaRecords = loadMeta(options.metaPath, { strict: true });
  const metaById = new Map(metaRecords.map((m) => [m.episode_id, m]));
  // FULL producer-inventory closure (episodes + meta + exclusions + stats)
  // BEFORE any invoker/provider work: the four-file dataset is one atomic
  // producer unit. Orphan meta records are only legal as the below-min
  // terminal set recorded in exclusions + stats — an arbitrary orphan fails
  // closed here. The facts carry the legal terminal set for reporting.
  const exclusions = loadExclusionRecords(options.exclusionsPath);
  const stats = loadStats(options.statsPath);
  const facts = assertProducerInventory({
    episodes,
    meta: metaById,
    exclusions,
    stats,
    label: "t0-replay-select",
  });
  if (!options.quiet && facts.orphan_meta.length > 0) {
    console.error(`t0-replay-select: ${facts.orphan_meta.length} legal terminal meta record(s) (below-min, no episode body): ${JSON.stringify(facts.orphan_meta)}`);
  }

  // Full-batch classifier checkpoint preflight AFTER the full producer
  // inventory passes and BEFORE any invoker/provider work: every hard
  // candidate's checkpoint state is validated up front (resume: missing /
  // valid completed allowed, failed/malformed/stale/body-invalid throw;
  // --no-resume: any existing throws). A bad checkpoint for candidate B is
  // discovered before candidate A sends any paid request. Pure read-only —
  // no writes, no invoker.
  if (!options.hardOnly) {
    preflightClassifierCheckpoints(episodes, metaById, {
      episodeIds: options.episodeIds,
      limit: options.limit,
      outputDir: options.checkpointDir,
      resume: options.resume,
      judgeModels: options.classifierModels,
      thinking: options.thinking,
      downstreamJudges: options.downstreamJudges,
    });
  }

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

  // Data-insufficient classify runs publish NOTHING: a <2 replayable
  // classified set is not a valid production manifest. Successful
  // checkpoints are kept (they are the durable state); the process exits 2
  // so callers can detect the condition. hard-only listings are not
  // production classified manifests and may publish any count. The atomic
  // publish therefore always happens AFTER the data_insufficient check.
  const dataInsufficient = !options.hardOnly && payload.counts.data_insufficient === true;
  if (options.output && !dataInsufficient) {
    if (options.hardOnly) {
      // hard-only listings are NOT classified production manifests — they
      // never go through classification provenance (no classifier checkpoints
      // exist for a hard-only run). Atomic replace on success only.
      publishJsonAtomic(options.output, payload);
    } else {
      // FULL manifest provenance BEFORE the atomic publish: the payload must be
      // the complete product of the real classifier over the real corpus + its
      // own checkpoints. A fake v2 checkpoint can never cause a publish —
      // provenance fails and nothing is written (the old output was already
      // revoked by the preflight). data_insufficient classify runs publish
      // nothing (checked above).
      publishSelectionManifest({
        payload,
        episodes,
        metaById,
        exclusions,
        stats,
        // checkpointDir is the LEAF (the dir holding <episode_id>.json
        // directly): derive it from the checkpoint ROOT via the shared
        // helper so provenance reads the SAME checkpoints the classifier
        // wrote (root/checkpoints), never the root itself.
        checkpointDir: classifierCheckpointDir(options.checkpointDir),
        // The scan's downstream-judge set — provenance must verify the
        // manifest against the SAME set the fresh scan used (a legal
        // non-default --downstream-judges must never fall back to the
        // default after paid work).
        downstreamJudges: options.downstreamJudges,
        output: options.output,
      });
    }
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
  if (dataInsufficient) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`t0-replay-select failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { main };
