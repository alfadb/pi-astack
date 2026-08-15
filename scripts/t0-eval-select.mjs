#!/usr/bin/env node
/**
 * t0-eval-select — judge-self-candidate avoidance selector.
 *
 * Reads ONLY the identity sidecar (episodes.meta.jsonl) and prints episode ids
 * whose in_body candidate set satisfies:
 *   - include: every model in --include must be present (all-of semantics)
 *   - exclude: any model in --exclude present → episode is dropped
 *
 * This is the judge-self-candidate avoidance step: the judge models (the
 * models that will evaluate the episodes) must never be candidates in the
 * episodes they judge, so episodes containing any judge model are excluded.
 * The judge pipeline itself (t0-eval.mjs) still reads ONLY episodes.jsonl —
 * this selector is a separate, identity-aware command and its output (plain
 * episode ids) is the only thing that crosses into the judge path.
 *
 * Usage:
 *   node scripts/t0-eval-select.mjs [options]
 *
 * Options:
 *   --episodes <path>  episodes.jsonl (default: same dir as meta)
 *   --meta <path>      episodes.meta.jsonl sidecar (default:
 *                      ~/.pi/.pi-astack/t0-episodes/episodes.meta.jsonl)
 *   --exclusions <path>  exclusions.jsonl (default: same dir as meta)
 *   --stats <path>     stats.json (default: same dir as meta)
 *   --include <csv>    target models that must ALL be present in the episode
 *   --exclude <csv>    judge models; episodes containing any are excluded
 *   --limit <n>        max episode ids to print (default: all matches)
 *   --json             print a JSON array instead of one id per line
 *   --output <path>    persist the selection as a script-produced JSON file
 *                      (metadata + episode_ids; never hand-written)
 *   --quiet            suppress the summary line on stderr
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictCli, nonNegativeInt, isSafeDecimal, NONNEGATIVE_DECIMAL_RE, loadEpisodes, loadExclusionRecords, loadStats, assertProducerInventory } from "./t0-eval-common.mjs";
import { loadMeta } from "./t0-replay-fair-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Closed allowlist of value-bearing raw CLI flags for t0-eval-select. */
const EVAL_SELECT_VALUE_FLAGS = Object.freeze([
  "episodes", "meta", "exclusions", "stats", "include", "exclude", "limit", "output",
]);
/** Closed allowlist of boolean raw CLI flags for t0-eval-select. */
const EVAL_SELECT_BOOLEAN_FLAGS = Object.freeze(["json", "quiet"]);
const EVAL_SELECT_NON_NEG_INT_FLAGS = new Set(["limit"]);

/**
 * Explicit CSV flag gate: every comma segment must be semantically non-empty
 * after trim — `,`, `,,`, `a,,b` fail closed instead of silently dropping
 * empty segments (which could otherwise widen the selection).
 */
function assertNonEmptyCsvRaw(flag, value) {
  const segments = String(value).split(",").map((s) => s.trim());
  if (segments.some((s) => s.length === 0)) {
    throw new Error(`t0-eval-select: --${flag} requires a non-empty comma-separated value (each segment must be non-empty), got ${JSON.stringify(value)}`);
  }
}

function assertNonNegativeIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, NONNEGATIVE_DECIMAL_RE)) {
    throw new Error(`t0-eval-select: --${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * Strict raw-argv entry for the CLI. Uses shared parseStrictCli (closed
 * allowlist; rejects --flag=value / unknown / positional / duplicates /
 * missing values / boolean-with-value) plus raw numeric and non-empty value
 * gates so a malformed argv can never silently resolve the production
 * default paths. Exported for offline tests.
 */
export function parseArgs(argv) {
  const args = parseStrictCli(argv, {
    valueFlags: EVAL_SELECT_VALUE_FLAGS,
    booleanFlags: EVAL_SELECT_BOOLEAN_FLAGS,
  });
  for (const [key, raw] of Object.entries(args)) {
    if (raw === true) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (EVAL_SELECT_NON_NEG_INT_FLAGS.has(key)) {
        assertNonNegativeIntRaw(key, value);
      } else if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`t0-eval-select: --${key} requires a non-empty value`);
      }
    }
  }
  // Explicit CSV flags (--include / --exclude): every comma segment must be
  // semantically non-empty after trim — `,`, `,,`, `a,,b` fail closed
  // instead of silently dropping empty segments (which could otherwise
  // widen the selection). When the flag is absent the value stays an empty
  // array; main() then requires at least one of --include / --exclude.
  for (const key of ["include", "exclude"]) {
    const raw = args[key];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      assertNonEmptyCsvRaw(key, value);
    }
  }
  const home = path.resolve(process.env.HOME || os.homedir());
  const metaPath = args.meta ? path.resolve(args.meta) : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.meta.jsonl");
  const episodesPath = args.episodes ? path.resolve(args.episodes) : path.join(path.dirname(metaPath), "episodes.jsonl");
  const exclusionsPath = args.exclusions ? path.resolve(args.exclusions) : path.join(path.dirname(metaPath), "exclusions.jsonl");
  const statsPath = args.stats ? path.resolve(args.stats) : path.join(path.dirname(metaPath), "stats.json");
  const csv = (v) => (typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  return {
    episodesPath,
    metaPath,
    exclusionsPath,
    statsPath,
    include: csv(args.include),
    exclude: csv(args.exclude),
    limit: nonNegativeInt(args.limit, undefined),
    json: args.json === true,
    output: args.output ? path.resolve(args.output) : null,
    quiet: args.quiet === true,
  };
}

function loadMetaRecords(metaPath) {
  return loadMeta(metaPath, { strict: true });
}

export function selectEpisodeIds(metaRecords, { include = [], exclude = [] } = {}) {
  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);
  const ids = [];
  for (const meta of metaRecords) {
    const models = (meta.slots ?? []).filter((s) => s.in_body === true).map((s) => s.model);
    // A sidecar-only record (no in_body slot — e.g. a below-min terminal
    // meta) is NEVER a selectable episode: the selector's output (plain
    // episode ids) crosses into the judge path, and identity material must
    // not. Exclude-only must therefore not emit meta-only ids either.
    if (models.length === 0) continue;
    if (includeSet.size > 0 && ![...includeSet].every((m) => models.includes(m))) continue;
    if (excludeSet.size > 0 && models.some((m) => excludeSet.has(m))) continue;
    ids.push(meta.episode_id);
  }
  return ids;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.include.length === 0 && options.exclude.length === 0) {
    console.error("t0-eval-select: at least one of --include / --exclude is required");
    process.exit(2);
  }
  // FULL producer-inventory closure (episodes + meta + exclusions + stats)
  // BEFORE any output: the four-file dataset is one atomic producer unit.
  // Orphan meta records are only legal as the below-min terminal set
  // recorded in exclusions + stats — an arbitrary orphan fails closed here,
  // and the selector never emits a sidecar-only id into the judge path.
  const episodes = loadEpisodes(options.episodesPath, { strict: true });
  const metaRecords = loadMetaRecords(options.metaPath);
  const exclusions = loadExclusionRecords(options.exclusionsPath);
  const stats = loadStats(options.statsPath);
  assertProducerInventory({
    episodes,
    meta: metaRecords,
    exclusions,
    stats,
    label: "t0-eval-select",
  });
  const ids = selectEpisodeIds(metaRecords, { include: options.include, exclude: options.exclude });
  const limited = options.limit !== undefined && Number.isFinite(options.limit) ? ids.slice(0, options.limit) : ids;
  if (options.output) {
    // Persist the selection as a script-produced artifact (metadata + the
    // complete id list) — the file is never hand-written.
    const payload = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      meta: options.metaPath,
      include: options.include,
      exclude: options.exclude,
      limit: options.limit ?? null,
      count: limited.length,
      total_matches: ids.length,
      episode_ids: limited,
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
    if (!options.quiet) console.error(`t0-eval-select: wrote ${limited.length} episode ids to ${options.output}`);
  }
  if (options.json) {
    console.log(JSON.stringify(limited));
  } else {
    for (const id of limited) console.log(id);
  }
  if (!options.quiet) {
    console.error(`t0-eval-select: ${limited.length}/${ids.length} episodes (include=${options.include.join(",") || "-"}, exclude=${options.exclude.join(",") || "-"})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
