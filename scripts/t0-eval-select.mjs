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
 *   --meta <path>      episodes.meta.jsonl sidecar (default:
 *                      ~/.pi/.pi-astack/t0-episodes/episodes.meta.jsonl)
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

import { parseCli, nonNegativeInt } from "./t0-eval-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = parseCli(argv);
  const home = path.resolve(process.env.HOME || os.homedir());
  const metaPath = args.meta ? path.resolve(args.meta) : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.meta.jsonl");
  const csv = (v) => (typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  return {
    metaPath,
    include: csv(args.include),
    exclude: csv(args.exclude),
    limit: nonNegativeInt(args.limit, undefined),
    json: args.json === true,
    output: args.output ? path.resolve(args.output) : null,
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

export function selectEpisodeIds(metaRecords, { include = [], exclude = [] } = {}) {
  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);
  const ids = [];
  for (const meta of metaRecords) {
    const models = (meta.slots ?? []).filter((s) => s.in_body === true).map((s) => s.model);
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
  const metaRecords = loadMeta(options.metaPath);
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
