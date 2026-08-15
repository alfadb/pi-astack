#!/usr/bin/env node
/**
 * dossier-t0-replay-fair-production — EXPLICIT read-only production dossier
 * for the fair prompt-only replay hard-gate scan (scripts/
 * t0-replay-fair-common.mjs + t0-replay-select.mjs).
 *
 * NOT a default smoke. This dossier:
 * - reads REAL production data ONLY:
 *     ~/.pi/.pi-astack/t0-episodes/episodes.jsonl
 *     ~/.pi/.pi-astack/t0-episodes/episodes.meta.jsonl
 *     ~/.pi/agent/models.json (presence check only — no registry, no invoker)
 *     ~/.pi/.pi-astack/t0-replay-fair/selection.json (existing complete fair
 *       manifest is REQUIRED — a missing manifest fails closed, never skipped)
 * - runs the hard structural-gate scan over the real corpus and reports the
 *   exclusion distribution / join tiers
 * - spawns the REAL production selector (`t0-replay-select --hard-only`) and
 *   cross-checks its output against the in-process scan (CLI agreement)
 * - checks CLI argument validation (classifier-models count, downstream
 *   judges range) on the real CLI
 * - verifies the fair manifest's protocol_hash equals the CURRENT classifier
 *   protocol hash (a missing or STALE manifest both exit non-zero — no skip,
 *   no warn-only)
 *
 * It makes NO provider/network/paid calls and writes NO output files (read
 * only): missing real data fails closed with non-zero exit; the hard scan
 * and CLI comparison must agree on the real corpus. Synthetic fixtures are
 * NOT production acceptance — fixture coverage lives in
 * `npm run smoke:t0-replay-fair` (offline) and the dual-LLM classification
 * is `npm run t0:replay-select` (production, paid).
 *
 * Run it explicitly:
 *   npm run dossier:t0-replay-fair-production
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = await import(path.join(root, "scripts/t0-replay-fair-common.mjs"));
const C = await import(path.join(root, "scripts/t0-eval-common.mjs"));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── read-only production acceptance (real data, no provider/network) ──────

console.log("\ndossier-t0-replay-fair-production — EXPLICIT read-only production hard-gate scan (real corpus, NO provider/network calls, no output files)\n");

const home = path.resolve(process.env.HOME || os.homedir());
const sourceEpisodesPath = path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
const sourceMetaPath = path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.meta.jsonl");
const sourceExclusionsPath = path.join(home, ".pi", ".pi-astack", "t0-episodes", "exclusions.jsonl");
const sourceStatsPath = path.join(home, ".pi", ".pi-astack", "t0-episodes", "stats.json");
const modelsJsonPath = path.join(home, ".pi", "agent", "models.json");
const fairSelectionPath = path.join(home, ".pi", ".pi-astack", "t0-replay-fair", "selection.json");

await check("real data: source episodes + meta + exclusions + stats + models.json + fair selection manifest exist (fail closed when missing)", () => {
  assert.ok(fs.existsSync(sourceEpisodesPath), `missing ${sourceEpisodesPath}`);
  assert.ok(fs.existsSync(sourceMetaPath), `missing ${sourceMetaPath}`);
  assert.ok(fs.existsSync(sourceExclusionsPath), `missing ${sourceExclusionsPath}`);
  assert.ok(fs.existsSync(sourceStatsPath), `missing ${sourceStatsPath}`);
  assert.ok(fs.existsSync(modelsJsonPath), `missing ${modelsJsonPath}`);
  assert.ok(fs.existsSync(fairSelectionPath), `missing ${fairSelectionPath}`);
});

const sourceEpisodes = C.loadEpisodes(sourceEpisodesPath, { strict: true });
const sourceMeta = F.loadMeta(sourceMetaPath, { strict: true });
const sourceMetaById = new Map(sourceMeta.map((m) => [m.episode_id, m]));
assert.ok(sourceEpisodes.length > 0, `real corpus is empty: ${sourceEpisodesPath}`);
assert.ok(sourceMeta.length > 0, `real meta sidecar is empty: ${sourceMetaPath}`);

await check("real data: FULL producer inventory closure (episodes + meta + exclusions + stats; orphan meta only legal as the below-min terminal set)", () => {
  // Fail-closed BEFORE any scan/provider work: the four-file dataset is one
  // atomic producer unit. An episode without a meta record would otherwise
  // be silently hard-excluded as meta_missing, shrinking the candidate set
  // while the manifest/rebuild stay self-consistent. Orphan meta records
  // are only legal as the below-min terminal set recorded in exclusions +
  // stats — an arbitrary orphan (meta without a below-min exclusion, or a
  // below-min exclusion without meta) fails closed here.
  const exclusions = C.loadExclusionRecords(sourceExclusionsPath);
  const stats = C.loadStats(sourceStatsPath);
  const facts = C.assertProducerInventory({
    episodes: sourceEpisodes,
    meta: sourceMetaById,
    exclusions,
    stats,
    label: "dossier-t0-replay-fair-production",
  });
  if (facts.orphan_meta.length > 0) {
    console.log(`  legal terminal meta (below-min, no episode body): ${facts.orphan_meta.length} — ${JSON.stringify(facts.orphan_meta)}`);
  }
});

await check("real data: hard-gate scan reports distribution on the REAL corpus (not fixtures)", () => {
  const hard = F.selectHardCandidates(sourceEpisodes, sourceMetaById, { limit: undefined });
  console.log(`  hard_pass=${hard.hard_pass_count} / source=${sourceEpisodes.length}`);
  console.log(`  join_tier=${JSON.stringify(hard.join_tier)}`);
  console.log(`  hard exclusion_distribution=${JSON.stringify(hard.distribution)}`);
  assert.equal(typeof hard.hard_pass_count, "number");
  assert.equal(hard.hard_pass_count + hard.excluded.length, sourceEpisodes.length, "hard_pass + excluded must cover the whole corpus");
  // Fail-closed on the scan itself: hard_pass==0 is a corpus fact (surfaced
  // as a warning — the dual-call machinery is covered by fixture mocks), but
  // an empty meta map or a broken scan is a dossier failure.
  if (hard.hard_pass_count === 0) {
    console.log("  WARN: real corpus hard_pass=0 — corpus fact; fixture mocks cover dual-call path");
  } else {
    for (const c of hard.candidates) {
      assert.equal(c.episode.tools, null);
      assert.ok(["exact", "heuristic"].includes(c.join_confidence));
    }
  }
});

await check("real data: CLI --hard-only lists exactly the in-process hard-pass ids (CLI agreement)", () => {
  const script = path.join(root, "scripts/t0-replay-select.mjs");
  const r = spawnSync(process.execPath, [script, "--hard-only", "--json", "--quiet"], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  const ids = JSON.parse(r.stdout.trim() || "[]");
  const hard = F.selectHardCandidates(sourceEpisodes, sourceMetaById, { limit: undefined });
  assert.deepEqual(ids.sort(), hard.candidates.map((c) => c.episode.episode_id).sort());
  console.log(`  CLI --hard-only agreed on ${ids.length} hard-pass ids`);
});

await check("real data: CLI rejects classifier-models count ≠ 2 and downstream-judges out of 1..5", () => {
  const script = path.join(root, "scripts/t0-replay-select.mjs");
  const one = spawnSync(process.execPath, [script, "--hard-only", "--classifier-models", "openai/gpt-5.6-sol", "--quiet"], {
    encoding: "utf8",
    env: process.env,
  });
  assert.notEqual(one.status, 0);
  assert.match(one.stderr, /exactly 2|classifier-models/i);

  const three = spawnSync(process.execPath, [
    script, "--hard-only",
    "--classifier-models", "openai/gpt-5.6-sol,anthropic/claude-opus-5,kimi-coding/k3",
    "--quiet",
  ], { encoding: "utf8", env: process.env });
  assert.notEqual(three.status, 0);

  const six = spawnSync(process.execPath, [
    script, "--hard-only",
    "--downstream-judges", "a,b,c,d,e,f",
    "--quiet",
  ], { encoding: "utf8", env: process.env });
  assert.notEqual(six.status, 0);
  assert.match(six.stderr, /1\.\.5|downstream-judges/i);
});

await check("real data: current classifier protocol_hash matches the production fair selection manifest (missing/stale both fail closed)", () => {
  // fairSelectionPath is guaranteed to exist by the required-input check
  // above; a stale protocol_hash fails closed with expected/actual printed.
  const selection = JSON.parse(fs.readFileSync(fairSelectionPath, "utf8"));
  const current = F.classifierProtocolHash();
  console.log(`  manifest protocol_hash=${selection.protocol_hash}`);
  console.log(`  current classifierProtocolHash()=${current}`);
  assert.equal(selection.protocol_hash, current, "fair selection protocol_hash must match the current classifier protocol (regenerate via t0:replay-select)");
});

await check("real data: manifest is the COMPLETE classifier-selector product (full hard-gate scan + checkpoints-fair provenance; hard_pass>0, no empty-set self-proof)", () => {
  const manifest = JSON.parse(fs.readFileSync(fairSelectionPath, "utf8"));
  const checkpointDir = path.join(path.dirname(fairSelectionPath), "checkpoints-fair", "checkpoints");
  const exclusions = C.loadExclusionRecords(sourceExclusionsPath);
  const stats = C.loadStats(sourceStatsPath);
  const provenance = F.validateFairManifestProvenance({
    manifest,
    episodes: sourceEpisodes,
    metaById: sourceMetaById,
    exclusions,
    stats,
    checkpointDir,
  });
  if (!provenance.ok) {
    throw new Error(`provenance validation failed (${provenance.errors.length}):\n  - ${provenance.errors.slice(0, 10).join("\n  - ")}`);
  }
  // No empty-set self-proof: a manifest whose selected/classifications are
  // consistent with an EMPTY hard-pass set proves nothing — the real corpus
  // must actually have hard-pass episodes and the manifest must select from
  // them.
  assert.ok(manifest.counts?.hard_pass > 0, `hard_pass must be > 0 (got ${manifest.counts?.hard_pass}) — empty-set manifests are not production acceptance`);
  assert.ok(manifest.counts?.replayable > 0, `replayable must be > 0 (got ${manifest.counts?.replayable})`);
  console.log(`  provenance OK: source=${manifest.counts.source} hard_pass=${manifest.counts.hard_pass} classified=${manifest.counts.classified} replayable=${manifest.counts.replayable} excluded=${manifest.counts.excluded} (${manifest.classifications?.length ?? 0} classifications vs checkpoints)`);
});

console.log("");
if (failures.length) {
  console.error(`\ndossier-t0-replay-fair-production failed: ${failures.length}/${passed + failures.length}`);
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.error instanceof Error ? f.error.stack : f.error}`);
  }
  process.exit(1);
}

console.log(`dossier-t0-replay-fair-production passed: ${passed}/${passed}`);
console.log(`inputs:`);
console.log(`  episodes: ${sourceEpisodesPath} (${sourceEpisodes.length} records)`);
console.log(`  meta:     ${sourceMetaPath} (${sourceMeta.length} records)`);
console.log(`  models.json: ${modelsJsonPath} (presence check only — no registry, no invoker)`);
console.log(`outputs: none (read-only dossier — no files written)`);
console.log("NOTE: full dual-LLM classification is `npm run t0:replay-select` (production, paid); fixture coverage is `npm run smoke:t0-replay-fair` (offline).");
