#!/usr/bin/env node
/**
 * smoke-t0-replay — OFFLINE DETERMINISTIC tests for the T0 production replay
 * pipeline (scripts/t0-replay-build.mjs + t0-replay-eval.mjs +
 * t0-replay-aggregate.mjs).
 *
 * This is the offline deterministic suite: unit tests with synthetic fixtures
 * (manifest gate, anonymous body fields, checkpoint invalidation, failure
 * retention, degeneration, resource caps, candidate-id re-ordering, redaction
 * + fail-closed ambiguous tokens, aggregate compatibility, independent leak
 * oracle, fair-manifest protocol-hash binding and eligibility screening). It
 * never reads production episodes/selection, never creates a real invoker,
 * never sends provider requests, and never spawns the live pipeline against
 * production data (CLI fixture tests only).
 *
 * The production/live acceptance (real fair selection, real replay calls, K3
 * canaries, live eval/aggregate) lives in the explicit dossier:
 *   npm run dossier:t0-replay-production  # scripts/dossier-t0-replay-production.mjs
 *
 * Anti-leak acceptance uses an INDEPENDENTLY MAINTAINED fixed oracle
 * (scripts/_t0-replay-oracle.mjs): the forbidden model names, basenames,
 * family tokens, leaky version fragments, residual old-style ids, source
 * episode ids and cost/usage markers are hardcoded there and deliberately NOT
 * derived from the redactor's own token lists — the redactor must pass the
 * oracle, it must not define it (no self-verification).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = await import(path.join(root, "scripts/t0-replay-build.mjs"));
const F = await import(path.join(root, "scripts/t0-replay-fair-common.mjs"));
const C = await import(path.join(root, "scripts/t0-eval-common.mjs"));
const { aggregate } = await import(path.join(root, "scripts/t0-eval-aggregate.mjs"));
const {
  replayReport,
  pairedCurrentOnlyReport,
  normalizeReplayAggregateArgs,
  loadCommittedReplayEvalGeneration,
} = await import(path.join(root, "scripts/t0-replay-aggregate.mjs"));
const { assertNoOracleLeak, assertAnonymousReplayBody, ORACLE } = await import(path.join(root, "scripts/_t0-replay-oracle.mjs"));
const { buildEpisodeRedactor, resolveBlindKey } = await import(path.join(root, "scripts/t0-episode-build.mjs"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}



// ── fixtures ──────────────────────────────────────────────────────────────
// Producer-shaped fixture ids: episode ids are ep-<16 hex> and slot ids are
// slot-<episode_id>-<12 hex> (the strict producer-shape inventory checks
// apply to the fixtures written by spawnBuild).
const FIX_R1 = "ep-0a1b2c3d4e5f60a1";
const FIX_R2 = "ep-0a1b2c3d4e5f60a2";
const FIX_R3 = "ep-0a1b2c3d4e5f60a3";
function rSlot(episodeId, n) {
  return `slot-${episodeId}-${String(n).padStart(12, "0")}`;
}

const FIXTURE_EPISODES = [
  {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: FIX_R1,
    prompt: "Review the R4 changes in the dispatch module. [model-a] and [model-b] both flagged the anchor scope issue.",
    thinking_level: "high",
    tools: null,
    model_count: 3,
    join_confidence: "exact",
    missing_evidence: [],
    slots: [
      { slot_id: rSlot(FIX_R1, 1), model_id: "c0", output: "R4 review: the anchor scope fix is correct and the ALS propagation works.", output_source: "dispatch_trace", output_chars: 73, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact (tool-call id)", missing_evidence: [] },
      { slot_id: rSlot(FIX_R1, 2), model_id: "c1", output: "The fix looks good. No new issues found.", output_source: "dispatch_trace", output_chars: 40, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact (tool-call id)", missing_evidence: [] },
      { slot_id: rSlot(FIX_R1, 3), model_id: "c2", output: "I found a regression in the ALS path: the anchor is lost on retry.", output_source: "dispatch_trace", output_chars: 66, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact (tool-call id)", missing_evidence: [] },
    ],
  },
  {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: FIX_R2,
    prompt: "Adjudicate the ADR 0040 policy push. [model-c] signed, [model-d] rejected.",
    thinking_level: "medium",
    tools: null,
    model_count: 3,
    join_confidence: "heuristic",
    missing_evidence: [],
    slots: [
      { slot_id: rSlot(FIX_R2, 1), model_id: "c0", output: "Verdict: SIGN.", output_source: "dispatch_trace", output_chars: 14, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "heuristic", join_note: "unique match", missing_evidence: [] },
      { slot_id: rSlot(FIX_R2, 2), model_id: "c1", output: "Verdict: REJECT — the policy is not ready.", output_source: "dispatch_trace", output_chars: 42, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "heuristic", join_note: "unique match", missing_evidence: [] },
      { slot_id: rSlot(FIX_R2, 3), model_id: "c2", output: "Verdict: SIGN with caveats.", output_source: "dispatch_trace", output_chars: 27, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "heuristic", join_note: "unique match", missing_evidence: [] },
    ],
  },
  {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: FIX_R3,
    prompt: "A prompt with a judge model candidate.",
    thinking_level: "high",
    tools: null,
    model_count: 3,
    join_confidence: "exact",
    missing_evidence: [],
    slots: [
      { slot_id: rSlot(FIX_R3, 1), model_id: "c0", output: "Answer A.", output_source: "dispatch_trace", output_chars: 9, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
      { slot_id: rSlot(FIX_R3, 2), model_id: "c1", output: "Answer B.", output_source: "dispatch_trace", output_chars: 9, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
      { slot_id: rSlot(FIX_R3, 3), model_id: "c2", output: "Answer C.", output_source: "dispatch_trace", output_chars: 9, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
    ],
  },
];

const FIXTURE_META = [
  {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: FIX_R1,
    slots: [
      { slot_id: rSlot(FIX_R1, 1), model: "openai/gpt-5.5", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: "dtr_fixture0001a" } },
      { slot_id: rSlot(FIX_R1, 2), model: "moonshotai/kimi-k2.7-code", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: "dtr_fixture0001b" } },
      { slot_id: rSlot(FIX_R1, 3), model: "deepseek/deepseek-v4-pro", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: "dtr_fixture0001c" } },
    ],
  },
  {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: FIX_R2,
    slots: [
      { slot_id: rSlot(FIX_R2, 1), model: "anthropic/claude-opus-4-8", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: "dtr_fixture0002a" } },
      { slot_id: rSlot(FIX_R2, 2), model: "zai-coding-cn/glm-5.2", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: "dtr_fixture0002b" } },
      { slot_id: rSlot(FIX_R2, 3), model: "minimax/MiniMax-M3", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: "dtr_fixture0002c" } },
    ],
  },
  {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: FIX_R3,
    slots: [
      { slot_id: rSlot(FIX_R3, 1), model: "openai/gpt-5.6-sol", in_body: true, exclusion_reason: null, usage: {}, audit: {} },
      { slot_id: rSlot(FIX_R3, 2), model: "openai/gpt-5.5", in_body: true, exclusion_reason: null, usage: {}, audit: {} },
      { slot_id: rSlot(FIX_R3, 3), model: "moonshotai/kimi-k2.7-code", in_body: true, exclusion_reason: null, usage: {}, audit: {} },
    ],
  },
];

const FIXTURE_CORPUS = [...new Set(FIXTURE_META.flatMap((m) => m.slots.map((s) => s.model)))].sort();
const FIXTURE_OPTIONS = { maxOutputBytes: 200_000, maxRetries: 2, timeoutMs: 600_000, minModels: 2, maxEpisodeBytes: 1_000_000, models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"] };

/**
 * Recompute the producer-shaped stats from fixture records, mirroring
 * t0-episode-build.buildStats semantics for every field the inventory
 * validator verifies (utf8ByteLength byte totals, JS string length for
 * slots_with_output, sparse maps — an empty category is absent).
 * corpus_count/absent_from_body are not derivable from the four files, so
 * the fixture sets a consistent closure (corpus_count = body_count +
 * absent_from_body.length).
 */
function producerStats(episodes, meta, exclusions, { minModels = 2, schemaVersion = 3, datasetMode = "final_answer_only", maxOutputBytes = 200000, maxEpisodeBytes = 1000000, maxTotalBytes = 500000000 } = {}) {
  const bodyIds = new Set(episodes.map((e) => e.episode_id));
  const orphanIds = meta.filter((m) => !bodyIds.has(m.episode_id)).map((m) => m.episode_id);
  const episodeLevel = exclusions.filter((x) => "episode_id" in x);
  const joinRows = exclusions.filter((x) => !("episode_id" in x));
  const belowMinCount = episodeLevel.filter((x) => x.reason === "below_min_models_after_availability").length;
  const ambiguousCount = episodeLevel.filter((x) => x.reason === "ambiguous_identity_token").length;
  const tooLargeCount = episodeLevel.filter((x) => x.reason === "episode_too_large").length;
  const joinByReason = {};
  for (const x of joinRows) joinByReason[x.reason] = (joinByReason[x.reason] ?? 0) + 1;
  // availability (producer semantics: body-episode in_body=false slots count
  // their own reason; orphan slots count below_min once per slot AND their
  // own reason when it differs — the producer double-counts below-min).
  const avail = {};
  const addAvail = (r) => { avail[r] = (avail[r] ?? 0) + 1; };
  for (const m of meta) {
    const isOrphan = orphanIds.includes(m.episode_id);
    for (const s of m.slots ?? []) {
      if (isOrphan) {
        addAvail("below_min_models_after_availability");
        if (s.exclusion_reason !== "below_min_models_after_availability" && s.exclusion_reason) addAvail(s.exclusion_reason);
      } else if (s.in_body === false && s.exclusion_reason) {
        addAvail(s.exclusion_reason);
      }
    }
  }
  const slotsExcluded = Object.values(avail).reduce((a, n) => a + n, 0);
  // episodes stats (producer semantics: utf8ByteLength for byte totals, JS
  // string length for slots_with_output, sparse maps).
  const byModelCount = {}, byThinking = {}, byConfidence = {}, byJoinConfidence = {}, byOutputSource = {};
  let slotsWithOutput = 0, slotsMissingOutput = 0, slotsRedacted = 0, totalOutputBytes = 0, totalEpisodeBytes = 0;
  for (const ep of episodes) {
    byModelCount[ep.model_count] = (byModelCount[ep.model_count] ?? 0) + 1;
    byThinking[ep.thinking_level ?? "null"] = (byThinking[ep.thinking_level ?? "null"] ?? 0) + 1;
    byConfidence[ep.join_confidence] = (byConfidence[ep.join_confidence] ?? 0) + 1;
    totalEpisodeBytes += Buffer.byteLength(JSON.stringify(ep), "utf8") + 1;
    for (const s of ep.slots ?? []) {
      byJoinConfidence[s.join_confidence] = (byJoinConfidence[s.join_confidence] ?? 0) + 1;
      byOutputSource[s.output_source] = (byOutputSource[s.output_source] ?? 0) + 1;
      if (s.output.length > 0) slotsWithOutput++; else slotsMissingOutput++;
      if (s.redacted === true) slotsRedacted++;
      totalOutputBytes += Buffer.byteLength(s.output, "utf8");
    }
  }
  // models: by_name from meta in_body slots (episodes = distinct episodes,
  // slots = in_body slot count per model).
  const byName = {};
  for (const m of meta) {
    if (!bodyIds.has(m.episode_id)) continue;
    for (const s of m.slots ?? []) {
      if (s.in_body !== true) continue;
      const e = byName[s.model] ?? (byName[s.model] = { episodes: new Set(), slots: 0 });
      e.episodes.add(m.episode_id);
      e.slots++;
    }
  }
  const byNameOut = {};
  for (const [name, e] of Object.entries(byName)) byNameOut[name] = { episodes: e.episodes.size, slots: e.slots };
  const bodyCount = Object.keys(byNameOut).length;
  return {
    schema_version: schemaVersion,
    dataset_mode: datasetMode,
    filters: { min_models: minModels, max_output_bytes: maxOutputBytes, max_episode_bytes: maxEpisodeBytes, max_total_bytes: maxTotalBytes },
    join: { excluded: joinRows.length, excluded_by_reason: joinByReason },
    groups: {
      episodes: episodes.length,
      episodes_below_min_after_availability: belowMinCount,
      episodes_ambiguous_identity: ambiguousCount,
      slots_in_episodes: episodes.reduce((s, e) => s + (e.slots?.length ?? 0), 0),
    },
    availability: { slots_excluded: slotsExcluded, slots_excluded_by_reason: avail, episodes_too_large: tooLargeCount },
    episodes: {
      by_model_count: byModelCount,
      by_thinking_level: byThinking,
      by_join_confidence: byConfidence,
      slots_by_join_confidence: byJoinConfidence,
      slots_by_output_source: byOutputSource,
      slots_with_output: slotsWithOutput,
      slots_missing_output: slotsMissingOutput,
      slots_redacted: slotsRedacted,
      total_output_bytes: totalOutputBytes,
      total_episode_bytes: totalEpisodeBytes,
    },
    models: { corpus_count: bodyCount, body_count: bodyCount, absent_from_body: [], by_name: byNameOut },
    resource: { max_output_bytes: maxOutputBytes, max_episode_bytes: maxEpisodeBytes, max_total_bytes: maxTotalBytes, total_episodes_bytes: totalEpisodeBytes },
  };
}

function mockReplayResult(model, output, extra = {}) {
  return {
    model,
    ok: true,
    output,
    calledAt: "2026-08-12T00:00:00.000Z",
    thinking: "high",
    attempts: 1,
    attempt_log: [{ attempt: 0, request_id: `req-${model}`, model_ref: model, operation: "t0_replay_answer", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(output), usage: { input: 10, output: 5, cost: 0.001 }, cost: 0.001, cost_source: "provider" }],
    cost: 0.001,
    cost_source: "provider",
    usage: { input: 10, output: 5, cost: 0.001 },
    error_class: null,
    exclusion_reason: null,
    ...extra,
  };
}

function writeFairSelectionFixture(dir, episodeIds, overrides = {}) {
  const selected = episodeIds.map((id) => ({
    episode_id: id,
    models: ["openai/gpt-5.5", "moonshotai/kimi-k2.7-code"],
    join_confidence: "exact",
    tools: null,
    stage: "llm",
    replayable: true,
    confidence: 0.9,
    reasons: ["fixture"],
    ...(overrides.selectedRow ?? {}),
  }));
  // Complete classified-manifest fixture: one classification per selected id
  // by default, no exclusions, full counts. The build gate requires all of
  // these, so a fixture that omits them would be falsely rejected (and a
  // hand-written manifest lacking them must NOT pass).
  const classifications = overrides.classifications ?? episodeIds.map((id) => ({
    episode_id: id,
    stage: "llm",
    replayable: true,
    reasons: ["fixture"],
    confidence: 0.9,
    join_confidence: null,
    cost: 0.01,
    cost_source: "provider",
    cost_breakdown: { provider: 0.01, estimated: 0, unknown: 0 },
    from_checkpoint: false,
  }));
  const excluded = overrides.excluded ?? [];
  const manifest = {
    schema_version: 1,
    kind: "prompt_only_replay_selection",
    generated_at: "2026-08-12T00:00:00.000Z",
    protocol_hash: "a".repeat(64),
    thinking: "medium",
    judge_models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
    classifier_models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
    downstream_judges: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "kimi-coding/k3"],
    classify: true,
    hard_only: false,
    limit: null,
    selected,
    excluded,
    classifications,
    episode_ids: episodeIds,
    counts: {
      source: episodeIds.length,
      hard_pass: episodeIds.length,
      hard_pass_limited: classifications.length,
      classified: classifications.length,
      replayable: selected.length,
      excluded: excluded.length,
      data_insufficient: false,
      join_hard_pass: { exact: episodeIds.length, heuristic: 0 },
      join_selected: { exact: episodeIds.length, heuristic: 0 },
    },
    ...overrides.manifest,
  };
  const p = path.join(dir, "selection.json");
  fs.writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`);
  return p;
}

// ── Section 1: unit tests (fixtures) ──────────────────────────────────────

console.log("t0-replay unit tests (fixtures)\n");

await check("manifest gate: missing --selection fails closed (no legacy default sample)", () => {
  const args = R.parseArgs({});
  assert.equal(args.selectionPath, undefined);
  assert.equal(args.allowLegacySelect, false);
});

await check("manifest gate: invalid kind/schema rejected", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-bad-"));
  const p = path.join(tmp, "bad.json");
  fs.writeFileSync(p, JSON.stringify({ schema_version: 1, kind: "not_fair", protocol_hash: "a".repeat(64), selected: [], episode_ids: ["ep-1"] }));
  assert.throws(() => R.loadAndValidateSelection(p), /kind must be/);
  fs.writeFileSync(p, JSON.stringify({
    schema_version: 99,
    kind: "prompt_only_replay_selection",
    protocol_hash: "a".repeat(64),
    classifier_models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
    downstream_judges: R.REPLAY_JUDGE_MODELS,
    selected: [{ episode_id: "ep-aaaaaaaaaaaaaaaa", join_confidence: "exact", tools: null, replayable: true }],
    episode_ids: ["ep-aaaaaaaaaaaaaaaa"],
  }));
  assert.throws(() => R.loadAndValidateSelection(p), /schema_version/);
});

await check("manifest gate: tools!=null or bad join_confidence rejected", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-tools-"));
  const p = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
  const read = () => JSON.parse(fs.readFileSync(p, "utf8"));
  let m = read();
  m.selected[0].join_confidence = "mixed";
  fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  assert.throws(() => R.loadAndValidateSelection(p), /join_confidence/);
  m = read();
  m.selected[0].tools = "bash";
  m.selected[0].join_confidence = "exact"; // keep the row otherwise legal so the tools check fires
  fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  assert.throws(() => R.loadAndValidateSelection(p), /tools must be null/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

await check("manifest gate: valid fair selection accepted + hash stable", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-ok-"));
  const p = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
  const info = R.loadAndValidateSelection(p);
  assert.equal(info.episodeIds.length, 2);
  assert.match(info.selectionHash, /^[0-9a-f]{64}$/);
  const info2 = R.loadAndValidateSelection(p);
  assert.equal(info.selectionHash, info2.selectionHash);
});

await check("fair manifest protocol_hash must equal the current classifier protocol hash (dossier preflight binding)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-proto-"));
  try {
    // A manifest produced by the fair selector carries protocol_hash =
    // classifierProtocolHash() (the selector's own pure helper). The replay
    // production dossier validates this BEFORE any request; this locks the
    // comparison offline.
    const p = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"], {
      manifest: { protocol_hash: F.classifierProtocolHash() },
    });
    const info = R.loadAndValidateSelection(p);
    assert.equal(info.protocolHash, F.classifierProtocolHash(), "current manifest must bind the current classifier protocol");
    // A stale manifest (protocol text changed since selection) must be
    // detected by the same comparison — the dossier's fail-closed preflight.
    const stale = {
      ...JSON.parse(fs.readFileSync(p, "utf8")),
      protocol_hash: F.classifierProtocolHash({ systemPrompt: "a different protocol" }),
    };
    fs.writeFileSync(p, `${JSON.stringify(stale, null, 2)}\n`);
    const staleInfo = R.loadAndValidateSelection(p);
    assert.notEqual(staleInfo.protocolHash, F.classifierProtocolHash(), "stale protocol hash must not match");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("loadAndValidateSelection rejects judge_call_failed / execution_failure / non-completed classification rows (no partial manifest)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-failed-"));
  try {
    const base = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(tmp, name), "utf8"));
    // classification row with judge_call_failed reason → rejected.
    const m1 = read("selection.json");
    m1.classifications = [{ episode_id: "ep-aaaaaaaaaaaaaaaa", stage: "llm", replayable: false, reasons: ["judge_call_failed", "timeout"], confidence: 0 }];
    const p1 = path.join(tmp, "sel1.json");
    fs.writeFileSync(p1, `${JSON.stringify(m1, null, 2)}\n`);
    assert.throws(() => R.loadAndValidateSelection(p1), /judge_call_failed/);
    // classification row with classification_status=failed → rejected.
    const m2 = read("selection.json");
    m2.classifications = [{ episode_id: "ep-aaaaaaaaaaaaaaaa", stage: "llm", replayable: false, reasons: ["timeout"], confidence: 0, classification_status: "failed" }];
    const p2 = path.join(tmp, "sel2.json");
    fs.writeFileSync(p2, `${JSON.stringify(m2, null, 2)}\n`);
    assert.throws(() => R.loadAndValidateSelection(p2), /classification_status/);
    // excluded row with execution_failure → rejected.
    const m3 = read("selection.json");
    m3.excluded = [{ episode_id: "ep-aaaaaaaaaaaaaaaa", stage: "llm", reasons: ["execution_failure"], join_confidence: "exact" }];
    const p3 = path.join(tmp, "sel3.json");
    fs.writeFileSync(p3, `${JSON.stringify(m3, null, 2)}\n`);
    assert.throws(() => R.loadAndValidateSelection(p3), /execution_failure/);
    // selected row with a failure reason → rejected (the scan covers
    // selected / classifications / excluded all three places).
    const m5 = read("selection.json");
    m5.selected[0].reasons = ["judge_call_failed"];
    const p5 = path.join(tmp, "sel5.json");
    fs.writeFileSync(p5, `${JSON.stringify(m5, null, 2)}\n`);
    assert.throws(() => R.loadAndValidateSelection(p5), /judge_call_failed/);
    // Completed classification rows covering BOTH selected ids are
    // admissible — the 10-key row does not repeat checkpoint status.
    const m4 = read("selection.json");
    m4.classifications = [
      { episode_id: "ep-aaaaaaaaaaaaaaaa", stage: "llm", replayable: true, reasons: ["self-contained"], confidence: 0.9 },
      { episode_id: "ep-bbbbbbbbbbbbbbbb", stage: "llm", replayable: true, reasons: ["self-contained"], confidence: 0.9 },
    ];
    const p4 = path.join(tmp, "sel4.json");
    fs.writeFileSync(p4, `${JSON.stringify(m4, null, 2)}\n`);
    const info = R.loadAndValidateSelection(p4);
    assert.equal(info.episodeIds.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("complete classified manifest gate: classify/hard_only/limit/counts/coverage/duplicate/order/malformed violations all reject; hard exclusions legal; full manifest accepted", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-gate-"));
  try {
    const base = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
    const read = () => JSON.parse(fs.readFileSync(base, "utf8"));
    // Legal full manifest accepted.
    assert.equal(R.loadAndValidateSelection(base).episodeIds.length, 2);
    const mutate = (fn) => {
      const m = read();
      fn(m);
      const p = path.join(tmp, `sel-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
      return p;
    };
    // classify!==true / missing → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.classify; })), /classify must be true/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.classify = false; })), /classify must be true/);
    // hard_only!==false / missing → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.hard_only; })), /hard_only must be false/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.hard_only = true; })), /hard_only must be false/);
    // limit !== null → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.limit; })), /limit must be null/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.limit = 2; })), /limit must be null/);
    // selected missing / wrong type / <2 → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.selected; })), /selected must be an array/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.selected = "nope"; })), /selected must be an array/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.selected = [m.selected[0]];
      m.episode_ids = [m.episode_ids[0]];
      m.classifications = [m.classifications[0]];
      m.counts.replayable = 1;
      m.counts.classified = 1;
      m.counts.hard_pass_limited = 1;
      m.counts.join_selected = { exact: 1, heuristic: 0 };
    })), /selected\.length must be >= 2/);
    // null / malformed selected row → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.selected[1] = null; })), /selected\[1\] must be a JSON object/);
    // selected id duplicate → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.selected[1].episode_id = m.selected[0].episode_id;
      m.episode_ids[1] = m.episode_ids[0];
    })), /unique/);
    // episode_ids wrong length / order → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.episode_ids = [m.episode_ids[1], m.episode_ids[0]]; })), /same length and order/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.episode_ids = [m.episode_ids[0]]; })), /!= episode_ids\.length/);
    // classifications missing / non-array → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.classifications; })), /classifications must be an array/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.classifications = {}; })), /classifications must be an array/);
    // classification null / malformed row → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.classifications[0] = null; })), /classifications\[0\] must be a JSON object/);
    // classification empty / missing episode_id → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.classifications[0].episode_id; })), /episode_id must be a non-empty string/);
    // duplicate classification episode_id → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.classifications[1].episode_id = m.classifications[0].episode_id; })), /duplicated/);
    // missing coverage (a selected id without classification) → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.classifications = [m.classifications[0]]; })), /missing classification row/);
    // counts.classified mismatch → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.classified = m.classifications.length + 1; })), /counts\.classified/);
    // counts.replayable mismatch → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.replayable = m.selected.length + 1; })), /counts\.replayable/);
    // counts.data_insufficient true → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.data_insufficient = true; })), /data_insufficient/);
    // counts.hard_pass_limited mismatch → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.hard_pass_limited = m.classifications.length + 1; })), /counts\.hard_pass_limited/);
    // counts missing / wrong type → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.counts; })), /counts must be an object/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts = "nope"; })), /counts must be an object/);
    // excluded missing / null row → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { delete m.excluded; })), /excluded must be an array/);
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.excluded = [null]; m.counts.excluded = 1; })), /excluded\[0\] must be a JSON object/);
    // counts.excluded mismatch → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.excluded = m.excluded.length + 1; })), /counts\.excluded/);
    // non-hard excluded without classification → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.excluded = [{ episode_id: "ep-cccccccccccccccc", stage: "llm", reasons: ["needs workspace"], join_confidence: "exact" }];
      m.counts.excluded = 1;
    })), /non-hard exclusion must have a classification row/);
    // HARD exclusions without classification are LEGAL (accepted).
    const legalHard = mutate((m) => {
      m.excluded = [{ episode_id: "ep-hard-aaaaaaaaaaaa", stage: "hard", reasons: ["no_specialist"], join_confidence: "exact" }];
      m.counts.excluded = 1;
      m.counts.source = 3;
      m.counts.hard_pass = 2;
    });
    assert.equal(R.loadAndValidateSelection(legalHard).episodeIds.length, 2);
    // failed reason in a selected row → reject (scan covers selected too).
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.selected[0].reasons = ["execution_failure"]; })), /execution_failure/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("loadAndValidateSelection exact partition: table-driven review mutations (orphan / deleted nonreplayable / overlap / duplicate / reversed replayable / hard-with-classification / forged counts) all reject; fully-consistent shrunken shape passes the DEPTH gate only", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-partition-"));
  try {
    // Base partition: 2 selected (replayable) + 1 non-replayable llm
    // exclusion (classified) + 1 hard exclusion (unclassified).
    const base = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"], {
      classifications: [
        { episode_id: "ep-aaaaaaaaaaaaaaaa", stage: "llm", replayable: true, reasons: ["fixture"], confidence: 0.9, join_confidence: null, cost: 0.01, cost_source: "provider", cost_breakdown: { provider: 0.01, estimated: 0, unknown: 0 }, from_checkpoint: false },
        { episode_id: "ep-bbbbbbbbbbbbbbbb", stage: "llm", replayable: true, reasons: ["fixture"], confidence: 0.9, join_confidence: null, cost: 0.01, cost_source: "provider", cost_breakdown: { provider: 0.01, estimated: 0, unknown: 0 }, from_checkpoint: false },
        { episode_id: "ep-nonreplay-aaaaaa", stage: "llm", replayable: false, reasons: ["needs workspace"], confidence: 0.6, join_confidence: null, cost: 0.01, cost_source: "provider", cost_breakdown: { provider: 0.01, estimated: 0, unknown: 0 }, from_checkpoint: false },
      ],
      excluded: [
        { episode_id: "ep-nonreplay-aaaaaa", stage: "llm", reasons: ["needs workspace"], join_confidence: "exact", confidence: 0.6, flags: null, cost: 0.01, cost_source: "provider", from_checkpoint: false },
        { episode_id: "ep-hard-aaaaaaaaaaaa", stage: "hard", reasons: ["no_specialist"], join_confidence: "exact" },
      ],
      manifest: {
        counts: { source: 4, hard_pass: 3, hard_pass_limited: 3, classified: 3, replayable: 2, excluded: 2, data_insufficient: false, join_hard_pass: { exact: 3, heuristic: 0 }, join_selected: { exact: 2, heuristic: 0 } },
      },
    });
    const read = () => JSON.parse(fs.readFileSync(base, "utf8"));
    const mutate = (fn) => {
      const m = read();
      fn(m);
      const p = path.join(tmp, `part-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
      return p;
    };
    // Legal full partition passes.
    assert.equal(R.loadAndValidateSelection(base).episodeIds.length, 2);
    // 1. orphan classification (id in neither selected nor non-hard excluded) → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications.push({ episode_id: "ep-orphan-aaaaaaaa", stage: "llm", replayable: true, reasons: ["x"], confidence: 0.9 });
      m.counts.classified = 4;
      m.counts.hard_pass_limited = 4;
      m.counts.hard_pass = 4;
    })), /orphan classification/);
    // 2a. delete the non-replayable classification + its excluded row, adjust
    // PART of the counts → rejected (counts closure).
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications = m.classifications.filter((c) => c.episode_id !== "ep-nonreplay-aaaaaa");
      m.excluded = m.excluded.filter((e) => e.episode_id !== "ep-nonreplay-aaaaaa");
      m.counts.classified = 2;
      m.counts.hard_pass_limited = 2;
      m.counts.hard_pass = 2;
      // counts.excluded / counts.source left stale → closure rejects.
    })), /counts\.excluded/);
    // 2b. delete the non-replayable classification + excluded row and adjust
    // ALL counts consistently → the DEPTH gate cannot detect it (a
    // self-consistent shrunken shape is structurally valid); full provenance
    // (validateFairManifestProvenance) is what catches it. Documented
    // boundary: the loader is a depth gate, not a provenance proof.
    const shrunk = mutate((m) => {
      m.classifications = m.classifications.filter((c) => c.episode_id !== "ep-nonreplay-aaaaaa");
      m.excluded = m.excluded.filter((e) => e.episode_id !== "ep-nonreplay-aaaaaa");
      m.counts = { source: 3, hard_pass: 2, hard_pass_limited: 2, classified: 2, replayable: 2, excluded: 1, data_insufficient: false, join_hard_pass: { exact: 3, heuristic: 0 }, join_selected: { exact: 2, heuristic: 0 } };
    });
    assert.equal(R.loadAndValidateSelection(shrunk).episodeIds.length, 2, "fully-consistent shrunken shape passes the depth gate (provenance is the real gate)");
    // 3. selected / non-hard excluded overlap → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.excluded.push({ episode_id: "ep-bbbbbbbbbbbbbbbb", stage: "llm", reasons: ["needs workspace"], join_confidence: "exact" });
      m.counts.excluded = 3;
    })), /both selected and excluded/);
    // 4. excluded duplicate id → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.excluded.push({ ...m.excluded[0] });
      m.counts.excluded = 3;
    })), /excluded episode_id .* duplicated/);
    // 5a. classification replayable reversed vs partition: selected id's
    // classification says replayable=false → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications[0].replayable = false;
    })), /replayable must be true \(the episode is selected\)/);
    // 5b. non-hard excluded id's classification says replayable=true → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications[2].replayable = true;
    })), /replayable must be false \(the episode is a non-hard exclusion\)/);
    // 5c. classification replayable not a boolean → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications[0].replayable = "yes";
    })), /replayable must be a boolean/);
    // 6. hard exclusion WITH a classification row → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications.push({ episode_id: "ep-hard-aaaaaaaaaaaa", stage: "llm", replayable: false, reasons: ["x"], confidence: 0.9 });
      m.counts.classified = 4;
      m.counts.hard_pass_limited = 4;
      m.counts.hard_pass = 4;
    })), /hard-excluded episode must not have a classification row/);
    // 7a. forged counts.source (≠ hard_pass + hard exclusions) → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.source = 99; })), /counts\.source/);
    // 7b. forged counts.hard_pass (≠ classifications.length) → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => { m.counts.hard_pass = 99; })), /counts\.hard_pass/);
    // 8. excluded row without a valid ep-* id → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.excluded[0].episode_id = "not-an-id";
    })), /non-empty ep-\* episode_id/);
    // 9. classification id without the ep-* shape → reject.
    assert.throws(() => R.loadAndValidateSelection(mutate((m) => {
      m.classifications[0].episode_id = "x";
    })), /non-empty ep-\* id/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn build: shape-valid manifest without checkpoints fails at FULL provenance (no output/invoker created); partial selection fails the depth gate; --episode <2 / duplicate / not-in-selection rejected before invoker; inconsistent producer inventory fails before provenance", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-build-provenance-"));
  try {
    // Temp strict matching corpus: 2 hard-pass episodes + meta (explicit
    // temp paths only — the production default paths are never read).
    const episodesPath = path.join(tmp, "episodes.jsonl");
    const metaPath = path.join(tmp, "episodes.meta.jsonl");
    const exclusionsPath = path.join(tmp, "exclusions.jsonl");
    const statsPath = path.join(tmp, "stats.json");
    fs.writeFileSync(episodesPath, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(metaPath, [FIXTURE_META[0], FIXTURE_META[1]].map((m) => JSON.stringify(m)).join("\n") + "\n");
    // The four-file dataset is one atomic producer unit: the build asserts
    // the FULL inventory (episodes + meta + exclusions + stats) before the
    // loader/provenance/blind-key/invoker, so the fixture must carry a
    // consistent exclusions + stats (no episode-level terminal exclusions —
    // the fixture corpus has no orphans).
    const writeConsistentInventory = () => {
      fs.writeFileSync(exclusionsPath, "");
      fs.writeFileSync(statsPath, `${JSON.stringify(producerStats([FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]], []), null, 2)}\n`);
    };
    writeConsistentInventory();
    // Minimal temp provider registry (never the production config).
    const registryPath = path.join(tmp, "registry.json");
    fs.writeFileSync(registryPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    // Shape-valid manifest (passes the loader depth gate) but NO
    // checkpoints-fair → full provenance fails at the missing checkpoints.
    const selDir = path.join(tmp, "sel-full");
    fs.mkdirSync(selDir, { recursive: true });
    const sel = writeFairSelectionFixture(selDir, [FIX_R1, FIX_R2], {
      manifest: {
        protocol_hash: F.classifierProtocolHash(),
        episodes: episodesPath,
        meta: metaPath,
        concurrency: 2,
      },
    });
    const spawnBuild = (args) => {
      try {
        const stdout = execFileSync(process.execPath, [path.join(root, "scripts/t0-replay-build.mjs"), ...args], { encoding: "utf8", timeout: 60_000 });
        return { status: 0, stdout, stderr: "" };
      } catch (err) {
        return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
      }
    };
    const invArgs = ["--episodes", episodesPath, "--meta", metaPath, "--exclusions", exclusionsPath, "--stats", statsPath, "--models-json", registryPath];
    const outDir = path.join(tmp, "out");
    const r1 = spawnBuild(["--selection", sel, "--output", outDir, ...invArgs]);
    assert.notEqual(r1.status, 0, `provenance failure expected: ${r1.stderr}`);
    assert.match(r1.stderr, /provenance validation FAILED/);
    assert.match(r1.stderr, /checkpoint missing/);
    assert.ok(!fs.existsSync(outDir), "no output dir created (failure before blind-key write / invoker)");
    // Partial selection (1 selected) → the loader depth gate rejects before
    // provenance (a partial manifest is not a replay-build input).
    const partialDir = path.join(tmp, "sel-partial");
    fs.mkdirSync(partialDir, { recursive: true });
    const partial = writeFairSelectionFixture(partialDir, [FIX_R1]);
    const outDir2 = path.join(tmp, "out2");
    const r2 = spawnBuild(["--selection", partial, "--output", outDir2, ...invArgs]);
    assert.notEqual(r2.status, 0, `partial selection must fail: ${r2.stderr}`);
    assert.match(r2.stderr, /selected\.length must be >= 2/);
    assert.ok(!fs.existsSync(outDir2), "no output dir created");
    // --episode with 1 id → rejected before invoker.
    const r3 = spawnBuild(["--selection", sel, "--episode", FIX_R1, "--output", path.join(tmp, "out3"), ...invArgs]);
    assert.notEqual(r3.status, 0, `single --episode must fail: ${r3.stderr}`);
    assert.match(r3.stderr, /--episode requires at least 2 ids/);
    assert.ok(!fs.existsSync(path.join(tmp, "out3")), "no output dir created");
    // --episode duplicate ids → rejected before invoker.
    const r4 = spawnBuild(["--selection", sel, "--episode", `${FIX_R1},${FIX_R1}`, "--output", path.join(tmp, "out4"), ...invArgs]);
    assert.notEqual(r4.status, 0, `duplicate --episode must fail: ${r4.stderr}`);
    assert.match(r4.stderr, /--episode ids must be unique/);
    assert.ok(!fs.existsSync(path.join(tmp, "out4")), "no output dir created");
    // --episode id not in the selection → rejected before invoker.
    const r5 = spawnBuild(["--selection", sel, "--episode", `${FIX_R1},ep-unknown-aaaaaaaa`, "--output", path.join(tmp, "out5"), ...invArgs]);
    assert.notEqual(r5.status, 0, `out-of-selection --episode must fail: ${r5.stderr}`);
    assert.match(r5.stderr, /is not in the selection manifest/);
    assert.ok(!fs.existsSync(path.join(tmp, "out5")), "no output dir created");
    // Inconsistent producer inventory (stats.groups.episodes wrong) → the
    // build fails at assertProducerInventory BEFORE the loader/provenance/
    // blind-key/invoker — no output dir, no invoker.
    const badStats = producerStats([FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]], []);
    badStats.groups.episodes = 3;
    fs.writeFileSync(statsPath, `${JSON.stringify(badStats, null, 2)}\n`);
    const outDir6 = path.join(tmp, "out6");
    const r6 = spawnBuild(["--selection", sel, "--output", outDir6, ...invArgs]);
    assert.notEqual(r6.status, 0, `inconsistent inventory must fail: ${r6.stderr}`);
    assert.match(r6.stderr, /producer inventory validation failed/);
    assert.ok(!fs.existsSync(outDir6), "no output dir created (inventory failure before blind-key write / invoker)");
    // Restore the consistent inventory for the remaining assertions.
    writeConsistentInventory();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("build directory-mode provenance: exact direct-json inventory — extra .json fails closed; archive subdir + non-json auxiliary ignored (selector publish and build consume the same closure)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-build-dirinv-"));
  try {
    const ids = [FIX_R1, FIX_R2];
    const { manifestPath } = buildFairProvenanceFixture(tmp, ids);
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, ids.map(eligibleEpisode), ids.map(eligibleMeta));
    const checkpointDir = path.join(path.dirname(manifestPath), "checkpoints-fair", "checkpoints");
    const build = async (outDir) => R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, output: outDir, quiet: true, seed: "dirinv",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    // Baseline: exact inventory builds.
    const ok = await build(path.join(tmp, "out-ok"));
    assert.equal(ok.episodes.length, 2, "exact inventory must build");
    // Extra direct .json (not a classification) → full provenance fails
    // closed BEFORE any blind-key write / invoker.
    fs.writeFileSync(path.join(checkpointDir, "ep-extra000000000000.json"), "{}");
    await assert.rejects(
      () => build(path.join(tmp, "out-extra")),
      /checkpoint inventory must exactly cover|direct \.json inventory/,
      "extra direct .json must fail the build provenance closed",
    );
    assert.ok(!fs.existsSync(path.join(tmp, "out-extra")), "no output dir created (provenance failure before blind-key write / invoker)");
    fs.rmSync(path.join(checkpointDir, "ep-extra000000000000.json"), { force: true });
    // Archive subdir (with .json inside) + non-json auxiliary items are
    // IGNORED — the direct-json inventory still passes.
    fs.mkdirSync(path.join(checkpointDir, "archive"), { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "archive", "ep-old00000000000000.json"), "{}");
    fs.writeFileSync(path.join(checkpointDir, "README.txt"), "auxiliary");
    const ok2 = await build(path.join(tmp, "out-archive"));
    assert.equal(ok2.episodes.length, 2, "archive subdir + non-json auxiliary must not break the inventory");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("resolveSelectedSourceEpisodes: full fair eligibility gates (meta/tools/join/self-contained/judge) on fixtures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-elig-"));
  try {
    // ep-fixture-0003 has openai/gpt-5.6-sol in its in_body meta → contains a
    // downstream judge; 0001/0002 are eligible.
    const sel = writeFairSelectionFixture(tmp, [FIX_R1, FIX_R2, FIX_R3]);
    const info = R.loadAndValidateSelection(sel);
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    const resolved = R.resolveSelectedSourceEpisodes(FIXTURE_EPISODES, metaById, info);
    assert.deepEqual(resolved.selected.map((s) => s.episode.episode_id), [FIX_R1, FIX_R2]);
    const ex = resolved.excluded.find((e) => e.episode_id === FIX_R3);
    assert.ok(ex && ex.reasons.includes("contains_judge_model"), `reasons: ${ex?.reasons?.join(",")}`);

    // Missing meta (episode EXISTS in source, no meta record) is reported
    // per-episode (never silently dropped).
    const toolsEpisode = { ...FIXTURE_EPISODES[0], episode_id: "ep-tools-aaaaaaaa", tools: "bash" };
    const noMetaEpisode = { ...FIXTURE_EPISODES[0], episode_id: "ep-nometa-aaaaaaaa" };
    const sel2 = writeFairSelectionFixture(tmp, [FIX_R1, "ep-tools-aaaaaaaa", "ep-nometa-aaaaaaaa"]);
    const info2 = R.loadAndValidateSelection(sel2);
    const resolved2 = R.resolveSelectedSourceEpisodes([FIXTURE_EPISODES[0], toolsEpisode, noMetaEpisode], metaById, info2);
    assert.deepEqual(resolved2.selected.map((s) => s.episode.episode_id), [FIX_R1]);
    const exTools = resolved2.excluded.find((e) => e.episode_id === "ep-tools-aaaaaaaa");
    assert.ok(exTools && exTools.reasons.includes("tools_not_null"), `reasons: ${exTools?.reasons?.join(",")}`);
    const exNoMeta = resolved2.excluded.find((e) => e.episode_id === "ep-nometa-aaaaaaaa");
    assert.ok(exNoMeta && exNoMeta.reasons.includes("meta_missing"), `reasons: ${exNoMeta?.reasons?.join(",")}`);

    // Not self-contained (truncated / empty output) is a structural exclusion.
    const notSelfContained = {
      ...FIXTURE_EPISODES[1],
      episode_id: "ep-trunc-aaaaaaaa",
      slots: [{ ...FIXTURE_EPISODES[1].slots[0], output: "[truncated]" }],
    };
    const notSelfContained2 = {
      ...FIXTURE_EPISODES[2],
      episode_id: "ep-trunc-bbbbbbbbbb",
      slots: [{ ...FIXTURE_EPISODES[2].slots[0], output: "[truncated]" }],
    };
    // The complete-manifest gate requires >= 2 selected, so the fixture
    // selects two not-self-contained ids; both must resolve as excluded.
    const sel3 = writeFairSelectionFixture(tmp, ["ep-trunc-aaaaaaaa", "ep-trunc-bbbbbbbbbb"]);
    const info3 = R.loadAndValidateSelection(sel3);
    const resolved3 = R.resolveSelectedSourceEpisodes([notSelfContained, notSelfContained2], metaById, info3);
    assert.equal(resolved3.selected.length, 0);
    const exTrunc = resolved3.excluded.find((e) => e.episode_id === "ep-trunc-aaaaaaaa");
    assert.ok(exTrunc && exTrunc.reasons.includes("not_self_contained"), `reasons: ${exTrunc?.reasons?.join(",")}`);
    const exTrunc2 = resolved3.excluded.find((e) => e.episode_id === "ep-trunc-bbbbbbbbbb");
    assert.ok(exTrunc2 && exTrunc2.reasons.includes("not_self_contained"), `reasons: ${exTrunc2?.reasons?.join(",")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("fair selection: default+extra downstream_judges passes loader + provenance + resolve; the extra-judge candidate is excluded by the gate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-superset-"));
  try {
    // The EXTRA judge is NOT a fixed replay judge: an episode whose meta
    // carries it is gate-eligible under the DEFAULT set but excluded
    // (contains_judge_model) under the default+extra superset — proving the
    // custom set really gates, never a weaker/fallback set. Pure fixture,
    // zero provider calls.
    const EXTRA_JUDGE = "xai/grok-4.6";
    const FIX_RX = "ep-0a1b2c3d4e5f60a6";
    assert.ok(!F.REPLAY_JUDGE_MODELS.includes(EXTRA_JUDGE), "extra judge must not be a fixed replay judge");
    const downstream = [...F.DEFAULT_DOWNSTREAM_JUDGES, EXTRA_JUDGE];
    // Inline extra-judge episode/meta (eligibleEpisode/eligibleMeta are
    // declared later in this module and reference FIX_R5 in TDZ here — the
    // episode is built directly instead). Gate-eligible in every dimension
    // (tools null, exact join, strong + specialist, self-contained) EXCEPT
    // the extra judge in its in_body meta.
    const rxEpisode = {
      schema_version: 3,
      dataset_mode: "final_answer_only",
      episode_id: FIX_RX,
      prompt: `Adjudicate the policy push for ${FIX_RX}. [model-a] signed, [model-b] rejected.`,
      thinking_level: "high",
      tools: null,
      model_count: 3,
      join_confidence: "exact",
      missing_evidence: [],
      slots: [1, 2, 3].map((n) => ({
        slot_id: rSlot(FIX_RX, n),
        model_id: `c${n - 1}`,
        output: n === 1 ? "SIGN" : n === 2 ? "SIGN with notes" : "REVISE point 2",
        output_source: "dispatch_trace",
        output_chars: n === 1 ? 4 : n === 2 ? 15 : 14,
        result: "ok",
        terminal_state: null,
        stop_reason: null,
        failure_type: null,
        join_confidence: "exact",
        join_note: "exact",
        missing_evidence: [],
      })),
    };
    const rxMeta = {
      schema_version: 3,
      dataset_mode: "final_answer_only",
      episode_id: FIX_RX,
      slots: [
        { slot_id: rSlot(FIX_RX, 1), model: "openai/gpt-5.5", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: `dtr_fixture${FIX_RX.slice(-4)}a` } },
        { slot_id: rSlot(FIX_RX, 2), model: "moonshotai/kimi-k2.7-code", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: `dtr_fixture${FIX_RX.slice(-4)}b` } },
        { slot_id: rSlot(FIX_RX, 3), model: EXTRA_JUDGE, in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: `dtr_fixture${FIX_RX.slice(-4)}c` } },
      ],
    };
    const { manifestPath, episodes, meta, stats, exclusions } = buildFairProvenanceFixture(tmp, [FIX_R1, FIX_R2, FIX_RX], {
      episodesOverride: { [FIX_RX]: rxEpisode },
      metaOverride: { [FIX_RX]: rxMeta },
      downstreamJudges: downstream,
    });
    const metaById = new Map(meta.map((m) => [m.episode_id, m]));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // The manifest's excluded list carries the extra-judge episode as a HARD
    // exclusion (contains_judge_model) — the gate, not a dropped selection.
    assert.deepEqual(manifest.downstream_judges, downstream);
    const exRx = manifest.excluded.find((e) => e.episode_id === FIX_RX);
    assert.ok(exRx && exRx.stage === "hard" && exRx.reasons.includes("contains_judge_model"), `excluded reasons: ${exRx?.reasons?.join(",")}`);
    assert.deepEqual(manifest.episode_ids, [FIX_R1, FIX_R2]);
    // Loader (depth gate) accepts the default+extra downstream set.
    const info = R.loadAndValidateSelection(manifestPath);
    assert.deepEqual(info.downstreamJudges, downstream);
    // Provenance (full rebuild over the real corpus + its own checkpoints)
    // passes with the SAME downstream set — no default fallback after the
    // custom selection.
    const prov = F.validateFairManifestProvenance({
      manifest,
      episodes,
      metaById,
      exclusions,
      stats,
      checkpointDir: path.join(path.dirname(manifestPath), "checkpoints-fair", "checkpoints"),
      downstreamJudges: downstream,
    });
    assert.deepEqual(prov.errors, [], `provenance errors: ${prov.errors.join("; ")}`);
    // Resolve re-gates the selected episodes with the manifest's OWN
    // downstream set — R1/R2 stay selected, zero exclusions.
    const resolved = R.resolveSelectedSourceEpisodes(episodes, metaById, info);
    assert.deepEqual(resolved.selected.map((s) => s.episode.episode_id), [FIX_R1, FIX_R2]);
    assert.deepEqual(resolved.excluded, []);
    // The gate is really the EXTRA judge: under the DEFAULT set alone the
    // same episode is a hard candidate; under the superset it is excluded.
    const defaultHard = F.selectHardCandidates(episodes, metaById, { limit: undefined });
    assert.ok(defaultHard.candidates.some((c) => c.episode.episode_id === FIX_RX), "extra-judge episode is gate-eligible under the default set");
    const supersetHard = F.selectHardCandidates(episodes, metaById, { limit: undefined, downstreamJudges: downstream });
    const exGate = supersetHard.excluded.find((e) => e.episode_id === FIX_RX);
    assert.ok(exGate && exGate.reasons.includes("contains_judge_model"), "extra-judge episode excluded by the superset gate");
    assert.deepEqual(supersetHard.candidates.map((c) => c.episode.episode_id).sort(), [FIX_R1, FIX_R2].sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("snapshotReplayCallIdentity: stable per-replay-slot call identity (called_at + attempt_log); deterministic", () => {
  const meta = [{
    episode_id: "rep-abc",
    slots: [
      {
        slot_id: "s0",
        model: "deepseek/deepseek-v4-flash",
        in_body: true,
        source: { kind: "replay" },
        replay: {
          called_at: "2026-08-12T00:00:00.000Z",
          attempts: 2,
          attempt_log: [
            { attempt: 0, request_id: "req-snap-0", ok: false, error: "429", error_class: "transport", usage: null, cost: null, cost_source: null },
            { attempt: 1, request_id: "req-snap-1", ok: true, error: null, error_class: null, usage: { input: 10, output: 5, cost: 0.01 }, cost: 0.01, cost_source: "provider" },
          ],
        },
      },
      { slot_id: "s1", model: "openai/gpt-5.5", in_body: true, source: { kind: "historical" }, usage: {} },
    ],
  }];
  const snap1 = R.snapshotReplayCallIdentity(meta);
  assert.equal(snap1.length, 1, "only replay slots are snapshotted");
  assert.equal(snap1[0].model, "deepseek/deepseek-v4-flash");
  assert.equal(snap1[0].called_at, "2026-08-12T00:00:00.000Z");
  assert.equal(snap1[0].attempt_log_length, 2);
  assert.equal(snap1[0].attempt_log[1].ok, true);
  // Deterministic: same input → same snapshot.
  assert.deepEqual(R.snapshotReplayCallIdentity(meta), snap1);
  // A re-call changes called_at → mismatch (the resume contract's detector).
  const reCalled = JSON.parse(JSON.stringify(meta));
  reCalled[0].slots[0].replay.called_at = "2026-08-13T00:00:00.000Z";
  assert.notDeepEqual(R.snapshotReplayCallIdentity(reCalled), snap1, "a re-called slot must change the snapshot");
  // An extra attempt also changes the snapshot.
  const extraAttempt = JSON.parse(JSON.stringify(meta));
  extraAttempt[0].slots[0].replay.attempt_log.push({ attempt: 2, request_id: "req-snap-2", ok: true, error: null, error_class: null, usage: { input: 10, output: 5, cost: 0.01 }, cost: 0.01, cost_source: "provider" });
  assert.notDeepEqual(R.snapshotReplayCallIdentity(extraAttempt), snap1);
});

await check("legacy selection helper still works for fixtures only", () => {
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const { selected, excluded } = R.selectReplayEpisodes(FIXTURE_EPISODES, metaById, { limit: 10 });
  assert.deepEqual(selected.map((e) => e.episode_id), [FIX_R1, FIX_R2]);
  assert.ok(excluded.some((e) => e.episode_id === FIX_R3 && e.reasons.includes("contains_judge_model")));
});

await check("replay episode id: deterministic, order-insensitive", () => {
  const key = "a".repeat(64);
  const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
  const id1 = R.buildReplayEpisodeId(key, "ep-x", models);
  const id2 = R.buildReplayEpisodeId(key, "ep-x", [...models].reverse());
  assert.equal(id1, id2);
  assert.match(id1, /^rep-[0-9a-f]{16}$/);
});

await check("anonymous body: only allowed fields; historical/replay indistinguishable", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "b".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    selectionHash: "c".repeat(64), protocolHash: "d".repeat(64),
  });
  assert.equal(built.exclusion, null);
  const ep = built.episode;
  R.assertAnonymousBody(ep);
  assert.equal(ep.dataset_mode, "replay");
  assert.equal(ep.tools, null);
  assert.equal(ep.thinking, "high");
  assert.equal(ep.slots.length, 5);
  // No body field may reveal source kind.
  for (const slot of ep.slots) {
    assert.deepEqual(Object.keys(slot).sort(), ["model_id", "output", "result", "slot_id"]);
    assert.equal(slot.result, "ok");
  }
  // Historical outputs preserved; replay outputs present.
  const outputs = new Set(ep.slots.map((s) => s.output));
  assert.ok(outputs.has("Replay answer one."));
  assert.ok(outputs.has("Replay answer two."));
  assert.ok(outputs.has(src.slots[0].output));
  // Sidecar holds identity/source/cost/join.
  const sc = built.sidecar;
  assert.equal(sc.source_episode_id, FIX_R1);
  assert.equal(sc.source_thinking, "high");
  assert.equal(sc.selection_hash, "c".repeat(64));
  assert.equal(sc.protocol_hash, "d".repeat(64));
  const replaySlots = sc.slots.filter((s) => s.source?.kind === "replay");
  assert.equal(replaySlots.length, 2);
  for (const s of replaySlots) {
    assert.equal(s.in_body, true);
    assert.equal(s.replay.error_class, null);
  }
  // Combined oracle = structural (exact keys, id shapes, sidecar markers)
  // + content (prompt/output model-name scans); R.assertAnonymousBody stays
  // the production write-time guard, checked independently alongside.
  assertAnonymousReplayBody(ep, "anonymous body");
});

await check("anonymous body: new answers redacted; independent oracle passes", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "I compared with GPT-5.5 and Claude Opus 4-8; the deepseek-v4-pro answer is close but the kimi-k2.7-code one is better."),
    mockReplayResult("xai/grok-4.5", "A substantive independent answer without model names."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "c".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  const body = JSON.stringify(built.episode);
  // Oracle on the content surface (prompt + outputs), like the episode-build
  // oracle: structural slot_id/episode_id hex is not a leak surface.
  assertAnonymousReplayBody(built.episode, "replay body");
  assert.match(body, /\[model-[a-z]+\]/);
});

await check("oracle: partial criteria + glued version fragments rejected; normal anonymous body not false-killed", () => {
  // M1/M2/M3 criteria partially replaced by a pseudonym in a slash list is
  // the signature of a partially redacted model name — rejected. (M1-only
  // strings keep the failure attributable to partialCriteriaRe, not the
  // context-ambiguous M2/M3 leakFragments.)
  assert.throws(() => assertNoOracleLeak("Criteria list: M1/M1/[model-x] for scoring.", "test"), /partially replaced/);
  assert.throws(() => assertNoOracleLeak("Criteria list: [model-x]/M1 for scoring.", "test"), /partially replaced/);
  // Version fragments DASH-glued to a pseudonym/candidate id ("[model]-4-8",
  // "c0-5") are partially redacted model names — rejected.
  assert.throws(() => assertNoOracleLeak("Scored [model-af]-4-8 above baseline.", "test"), /glued to a pseudonym/);
  assert.throws(() => assertNoOracleLeak("Candidate c0-5 disagreed.", "test"), /glued to a pseudonym/);
  // Normal anonymous body text passes: pseudonyms and a bare M1 criterion are
  // ordinary text when not glued to a version fragment or mixed into a
  // slash-separated criteria list.
  assertNoOracleLeak("Review the R4 changes: [model-a] and [model-b] both flagged the anchor scope issue.", "normal anonymous body");
  assertNoOracleLeak("The M1 criterion was applied consistently across candidates.", "normal anonymous body");
});

await check("oracle boundary semantics: source ep-ids are alnum-context + case-insensitive (artifact_ep-…/EP-… rejected, rep-/slot-rep- anonymous ids pass); full names and basenames are alnum-context tokens (uppercase underscore full names rejected, task3/sdk3/block3/chunk3/k3s pass, standalone/_K3_ rejected); free-text JSON cost/usage/content_hash is legal content", () => {
  // Source episode ids: embedded between separators (underscore) and in
  // uppercase must be caught; the anonymous rep-/slot-rep- HMAC ids must
  // never match ("ep" there is preceded by an alphanumeric "r").
  assert.throws(() => assertNoOracleLeak("see artifact_ep-0123456789abcdef.json", "test"), /source episode id/, "artifact_ep-… must be rejected");
  assert.throws(() => assertNoOracleLeak("EP-0123456789ABCDEF", "test"), /source episode id/, "uppercase EP-… must be rejected");
  assert.throws(() => assertNoOracleLeak("x.ep-0123456789abcdef.", "test"), /source episode id/, "dot-delimited ep-… must be rejected");
  assert.throws(() => assertNoOracleLeak("Review ep-0123456789abcdef here.", "test"), /source episode id/, "standalone ep-… must still be rejected");
  assertNoOracleLeak("rep-0123456789abcdef", "anonymous rep id");
  assertNoOracleLeak("slot-rep-0123456789abcdef-0123456789ab", "anonymous slot-rep id");
  // Basename matching is a case-insensitive alphanumeric-context token scan:
  // a basename embedded inside a longer word is NOT a leak, a standalone /
  // underscore-delimited token still is.
  for (const ok of ["handle task3 in the queue.", "the sdk3 build passed.", "block3 config", "chunk3 data", "run a k3s cluster"]) {
    assertNoOracleLeak(ok, `ordinary text containing a k3-embedded word: ${ok}`);
  }
  assert.throws(() => assertNoOracleLeak("The K3 criterion applies.", "test"), /basename k3/, "standalone K3 must be rejected");
  assert.throws(() => assertNoOracleLeak("field _K3_ is set.", "test"), /basename k3/, "underscore-delimited _K3_ must be rejected");
  assert.throws(() => assertNoOracleLeak("route k3-256k", "test"), /basename k3/, "k3-256k must be rejected (real kimi-coding/k3-256k basename)");
  // Family/leak tokens are alnum-context + case-insensitive like basenames:
  // underscore-delimited vendor/family tokens (file names / field names) are
  // leaks, while longer alphanumeric words never match.
  assert.throws(() => assertNoOracleLeak("see dossier_openai_review.md for the notes", "test"), /family\/alias token openai/, "underscore-delimited vendor token must be rejected");
  // Full model names are case-insensitive alnum-context tokens like
  // basenames: an uppercase underscore-delimited full name is a leak, a
  // longer alphanumeric word containing the name is not.
  assert.throws(() => assertNoOracleLeak("read run_deepseek/deepseek-v4-flash_log", "test"), /leaks full model name deepseek\/deepseek-v4-flash/, "underscore-delimited full model name must be rejected");
  assert.throws(() => assertNoOracleLeak("RUN_DEEPSEEK/DEEPSEEK-V4-FLASH_LOG", "test"), /leaks full model name deepseek\/deepseek-v4-flash/, "uppercase underscore-delimited full model name must be rejected");
  assertNoOracleLeak("xkimi-coding/k3y is a longer word containing a full model name", "longer word containing a full model name");
  // Family tokens are alnum-context + case-insensitive: the FIRST family
  // token in the list that matches rejects the text — "deepseek" here, not
  // the longer "deepseek-v4" (the underscore between v4 and flash breaks
  // the hyphenated family token).
  assert.throws(() => assertNoOracleLeak("run_deepseek-v4_flash_log", "test"), /family\/alias token deepseek$/, "underscore-delimited family token must be rejected");
  assert.throws(() => assertNoOracleLeak("_gpt-5.6_ answered", "test"), /family\/alias token gpt/, "underscore-delimited family token must be rejected");
  assertNoOracleLeak("dossieropenaireview is a longer word containing the vendor", "longer word containing openai");
  // Dispatch run ids: artifact_dtr_… / _dtr_…_ / uppercase DTR_… are all
  // leaks (alnum-context + case-insensitive); a longer word (xdtr_…y) is not.
  assert.throws(() => assertNoOracleLeak("run artifact_dtr_0123456789abcdef0123456789abcdef.json", "test"), /dispatch run id/, "artifact_dtr_… must be rejected");
  assert.throws(() => assertNoOracleLeak("run _dtr_0123456789abcdef0123456789abcdef_", "test"), /dispatch run id/, "_dtr_…_ must be rejected");
  assert.throws(() => assertNoOracleLeak("run DTR_0123456789ABCDEF0123456789ABCDEF", "test"), /dispatch run id/, "uppercase DTR_… must be rejected");
  assertNoOracleLeak("review xdtr_0123456789abcdef0123456789abcdefy", "longer word containing dtr_…");
  // Residual ids: underscore-delimited / file-name / uppercase forms are
  // leaks; a longer word (taskm12x) is not.
  assert.throws(() => assertNoOracleLeak("see artifact_m12.json", "test"), /residual old-style/, "artifact_m12.json must be rejected");
  assert.throws(() => assertNoOracleLeak("field _m2 is set", "test"), /version fragment M2/, "_m2 must be rejected (M2 leak fragment)");
  assert.throws(() => assertNoOracleLeak("id M12", "test"), /residual old-style/, "uppercase M12 must be rejected");
  assertNoOracleLeak("taskm12x is not an id", "longer word containing m12");
  // Free-text JSON fragments are LEGAL content: an answer may mention
  // {"cost": …}, {"usage": …}, {"content_hash": …} — only parsed object keys
  // are structural sidecar markers (assertAnonymousBodyStructure).
  assertNoOracleLeak('The JSON response was {"cost": 0.01}.', "free-text JSON cost");
  assertNoOracleLeak('payload {"usage": 3} times', "free-text JSON usage");
  assertNoOracleLeak('{"content_hash": "abc123"} appears in the snippet', "free-text JSON content_hash");
  assertNoOracleLeak('{"tokens_in": 10, "tokens_out": 5}', "free-text JSON tokens markers");
});

await check("structural oracle: exact allow-list keys + anonymous id shapes; sidecar marker injections rejected", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "n".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  assert.equal(built.exclusion, null);
  const ep = built.episode;
  // Normal fixture body passes the combined (structural + content) oracle.
  assertAnonymousReplayBody(ep, "fixture body");
  // Top-level sidecar marker key is rejected.
  assert.throws(() => assertAnonymousReplayBody({ ...ep, usage: { tokens_in: 1 } }, "x"), /sidecar key "usage"/);
  // Slot sidecar marker key is rejected.
  assert.throws(
    () => assertAnonymousReplayBody({ ...ep, slots: [{ ...ep.slots[0], called_at: "2026-08-13T00:00:00.000Z" }, ...ep.slots.slice(1)] }, "x"),
    /sidecar key "called_at"/,
  );
  // Nested object marker ({audit:{cost:1}}) inside an allowed key's value is rejected.
  assert.throws(() => assertAnonymousReplayBody({ ...ep, thinking: { audit: { cost: 1 } } }, "x"), /sidecar key "cost"/);
  // source_episode_id nested inside an allowed key's value is rejected.
  assert.throws(() => assertAnonymousReplayBody({ ...ep, thinking: { source_episode_id: "ep-aaaaaaaaaaaaaaaa" } }, "x"), /sidecar key "source_episode_id"/);
  // Unknown extra top-level key is rejected by the allow-list (not a marker).
  assert.throws(() => assertAnonymousReplayBody({ ...ep, model_count: 3 }, "x"), /top-level keys/);
});

await check("structural oracle: anonymous HMAC slot ids never match the version-fragment grammar — the accidental digit-c<digits> boundary (…8-c0…) is not a flake, and the echoed id is legal CONTENT", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "o".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  const ep = built.episode;
  // This is the REAL slot id from the last production dossier run: its
  // "…e18-" + "c0dc…" boundary contains the accidental "8-c0" sequence.
  // The bounded SHORT-version grammar + ASCII-alphanumeric-context
  // lookarounds never match it (the trailing "d" trips the lookahead) — so
  // scanning ids could never flake, and an echoed anonymous id in CONTENT is
  // legal (no "deliberately unbounded" oracle hack needed).
  const flakeId = "slot-rep-1151132f9fe65e18-c0dcace754bc";
  assert.equal(ORACLE.pseudonymAdjacentVersionRe.test(flakeId), false, "the accidental 8-c0 hex boundary must NOT match the bounded grammar");
  assertNoOracleLeak(flakeId, "echoed anonymous slot id");
  assertNoOracleLeak("slot-rep-1234567890123456-c01234567890", "echoed anonymous slot id with a long c-run");
  const withC0 = {
    ...ep,
    episode_id: "rep-1151132f9fe65e18",
    slots: ep.slots.map((s, i) => ({
      ...s,
      slot_id: i === 0 ? flakeId : `slot-rep-1151132f9fe65e18-${String(i).padStart(12, "0")}`,
    })),
  };
  assertAnonymousReplayBody(withC0, "slot id with accidental 8-c0");
});

await check("P1: nested object values in prompt / thinking / slot.output fail the production assert, the independent oracle AND writeOutputs (no five files); legal free-text JSON strings still pass", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-nested-"));
  try {
    const stats = { schema_version: 1 };
    // The nested object carries NO sidecar marker key — the failure must be
    // attributable to the EXACT type/value contract, not to walkObjectKeys.
    const nested = { note: "openai/gpt-5.5 ep-0123456789abcdef dtr_0123456789abcdef0123456789abcdef 019ff87f-13bd-70c8-abca-e4bb132c6140" };
    const base = {
      schema_version: 3,
      dataset_mode: "replay",
      episode_id: "rep-0123456789abcdef",
      prompt: "Clean prompt.",
      thinking: "high",
      tools: null,
      slots: [{ slot_id: "slot-rep-0123456789abcdef-0123456789ab", model_id: "c0", output: "Clean answer.", result: "ok" }],
    };
    const cases = [
      { name: "nested-prompt", mut: (ep) => ({ ...ep, prompt: nested }) },
      { name: "nested-thinking", mut: (ep) => ({ ...ep, thinking: nested }) },
      { name: "nested-slot-output", mut: (ep) => ({ ...ep, slots: [{ ...ep.slots[0], output: nested }] }) },
    ];
    for (const tc of cases) {
      const ep = tc.mut(base);
      // 1) Production write-time assert rejects the nested VALUE (not the key set).
      assert.throws(() => R.assertAnonymousBody(ep), /must be a string/, `${tc.name}: production assert must reject the nested value`);
      // 2) Independent oracle rejects it too (structural type check first).
      assert.throws(() => assertAnonymousReplayBody(ep, "nested body"), /must be a string/, `${tc.name}: independent oracle must reject the nested value`);
      // 3) writeOutputs rejects BEFORE any fs write — no five files, no dir.
      const outDir = path.join(tmp, tc.name);
      assert.throws(() => R.writeOutputs(outDir, { episodes: [ep], sidecar: [], exclusions: [], stats }), /must be a string/, `${tc.name}: writeOutputs must reject the nested value`);
      assert.ok(!fs.existsSync(outDir), `${tc.name}: output dir must not be created`);
      for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
        assert.ok(!fs.existsSync(path.join(outDir, name)), `${tc.name}: ${name} must not be written`);
      }
    }
    // The type contract is value-exact: wrong schema / dataset / thinking are
    // rejected by BOTH guards, not just the key allow-list.
    assert.throws(() => R.assertAnonymousBody({ ...base, schema_version: 2 }), /schema_version/);
    assert.throws(() => assertAnonymousReplayBody({ ...base, schema_version: 2 }, "x"), /schema_version/);
    assert.throws(() => R.assertAnonymousBody({ ...base, dataset_mode: "final_answer_only" }), /dataset_mode/);
    assert.throws(() => assertAnonymousReplayBody({ ...base, dataset_mode: "final_answer_only" }, "x"), /dataset_mode/);
    assert.throws(() => R.assertAnonymousBody({ ...base, thinking: "turbo" }), /thinking/);
    assert.throws(() => assertAnonymousReplayBody({ ...base, thinking: "turbo" }, "x"), /thinking/);
    // 4) Legal free-text JSON strings (cost/usage/content_hash in prose) still
    // pass both guards — only parsed object keys are structural markers.
    const legal = { ...base, prompt: 'The JSON response was {"cost": 0.01, "usage": 3} and {"content_hash": "abc123"} was in the snippet.' };
    R.assertAnonymousBody(legal);
    assertAnonymousReplayBody(legal, "legal free-text JSON body");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("P1: assertAnonymousBody exact own keys — null / non-object / array / String-object top, inherited prompt, null/array slots all rejected; the independent oracle rejects the same", () => {
  const base = {
    schema_version: 3,
    dataset_mode: "replay",
    episode_id: "rep-0123456789abcdef",
    prompt: "Clean prompt.",
    thinking: "high",
    tools: null,
    slots: [{ slot_id: "slot-rep-0123456789abcdef-0123456789ab", model_id: "c0", output: "Clean answer.", result: "ok" }],
  };
  // Top-level shape: null / undefined / primitives / array / String object.
  // (A String object passes the typeof-object shape check but its index keys
  // leak through the extra-key allow-list — both guards reject it.)
  for (const bad of [null, undefined, 42, "str", [], new String("x")]) {
    assert.throws(() => R.assertAnonymousBody(bad), /plain object|leaks field/, `assertAnonymousBody must reject ${String(bad)}`);
    assert.throws(() => assertAnonymousReplayBody(bad, "x"), /episode must be an object|top-level keys/, `oracle must reject ${String(bad)}`);
  }
  // An INHERITED prompt is not an own key: the exact-own-key contract must
  // reject it even though `in` would see it (the old `key in episode` check
  // would pass an inherited string prompt through to the type checks).
  const inherited = Object.create({ prompt: "openai/gpt-5.5 inherited prompt" });
  Object.assign(inherited, base);
  delete inherited.prompt;
  assert.throws(() => R.assertAnonymousBody(inherited), /missing field prompt/, "an inherited prompt must not satisfy the own-key contract");
  assert.throws(() => assertAnonymousReplayBody(inherited, "x"), /top-level keys/, "the oracle must reject the inherited-prompt episode (missing own prompt)");
  // Null / array slots.
  assert.throws(() => R.assertAnonymousBody({ ...base, slots: [null] }), /slot must be a non-null plain object/, "a null slot must be rejected");
  assert.throws(() => R.assertAnonymousBody({ ...base, slots: [[]] }), /slot must be a non-null plain object/, "an array slot must be rejected");
  assert.throws(() => R.assertAnonymousBody({ ...base, slots: [null, base.slots[0]] }), /slot must be a non-null plain object/, "a null slot among valid slots must be rejected");
  assert.throws(() => assertAnonymousReplayBody({ ...base, slots: [null] }, "x"), /each slot must be an object/, "the oracle must reject a null slot");
  assert.throws(() => assertAnonymousReplayBody({ ...base, slots: [[]] }, "x"), /each slot must be an object/, "the oracle must reject an array slot");
  // writeOutputs rejects the same shapes before any fs write (snapshot-first).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-ownkeys-"));
  try {
    const stats = { schema_version: 1 };
    assert.throws(() => R.writeOutputs(path.join(tmp, "o1"), { episodes: [inherited], sidecar: [], exclusions: [], stats }), /missing field prompt|top-level keys/);
    assert.ok(!fs.existsSync(path.join(tmp, "o1")), "no dir on inherited-prompt rejection");
    assert.throws(() => R.writeOutputs(path.join(tmp, "o2"), { episodes: [{ ...base, slots: [null] }], sidecar: [], exclusions: [], stats }), /slot/);
    assert.ok(!fs.existsSync(path.join(tmp, "o2")), "no dir on null-slot rejection");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("anonymous body: slot model_id must be a CANONICAL candidate cN (c(?:0|[1-9]\\d*), no leading zeros) — c01 is rejected by BOTH the production assertAnonymousBody and the independent oracle; canonical unbounded candidates pass", () => {
  const base = {
    schema_version: 3,
    dataset_mode: "replay",
    episode_id: "rep-0123456789abcdef",
    prompt: "Clean prompt.",
    thinking: "high",
    tools: null,
    slots: [{ slot_id: "slot-rep-0123456789abcdef-0123456789ab", model_id: "c0", output: "Clean answer.", result: "ok" }],
  };
  const withModelId = (id) => ({ ...base, slots: [{ ...base.slots[0], model_id: id }] });
  for (const bad of ["c01", "c007", "c0123", "c0.1", "c0-5", "c0x"]) {
    assert.throws(() => R.assertAnonymousBody(withModelId(bad)), /canonical candidate cN/, `production assertAnonymousBody must reject non-canonical model_id ${bad}`);
    assert.throws(() => assertAnonymousReplayBody(withModelId(bad), "x"), /canonical candidate cN/, `the independent oracle must reject non-canonical model_id ${bad}`);
  }
  // Canonical unbounded candidate ids (no leading zeros) pass both guards.
  for (const good of ["c0", "c1", "c12", "c123", "c1234567890"]) {
    R.assertAnonymousBody(withModelId(good));
    assertAnonymousReplayBody(withModelId(good), "canonical model_id " + good);
  }
});

await check("oracle + redactor: underscore-internal model aliases leave no version/identity residue; glued pseudonym/version residues are rejected; SHORT version grammar false positives pass; normal text passes", () => {
  // Raw underscore aliases are model identity — the oracle rejects them (a
  // family token at the alnum boundary, e.g. "claude" in claude_opus_4-8).
  for (const alias of ["claude_opus_4-8", "claude_opus_4_8", "gpt_5.6_sol", "deepseek_v4_flash", "anthropic/claude_opus_4-8"]) {
    assert.throws(() => assertNoOracleLeak(alias, "test"), /leaks/, `raw underscore alias ${alias} must be rejected`);
  }
  // Hand-crafted glued residues: pseudonym/cN + `_`/`-` + short v?digit
  // version (including the underscore version forms the SHORT grammar
  // covers), plus the BARE pseudonym form `[model]` (production collapses
  // it, the oracle rejects the raw residue).
  for (const residue of ["[model-a]_[model-b]_4_8", "[model-a]_[model-b]_4-8", "[model-a]_5.6_[model-b]", "[model-a]_v4_[model-b]", "c0_5", "c0-5", "[model-a]_4-8", "5.6_[model-b]", "c123_5", "c123-5", "[model]-4", "[model-a]_V4", "[model]_V4", "c123_V4", "1-[model-a]-2", "1_[model]_2", "1_c0_2", "1.2-c123-v3_4", "c0-5_v4", "[model-a]-1-v2", "1-[model-a]-2-v3", "1-v2-c0", "c0-v1_V2-v3"]) {
    assert.throws(() => assertNoOracleLeak(residue, "test"), /glued to a pseudonym/, `glued residue ${residue} must be rejected`);
  }
  // SHORT-version false positives are ordinary text, not leaks: a 4-digit
  // year glued to a candidate (date), candidate-vs-candidate text, dates,
  // standalone version numbers, a non-canonical leading-zero candidate and
  // echoed anonymous HMAC ids (including a long c-run after a separator and
  // the accidental 8-c0 hex boundary).
  assertNoOracleLeak("Released on c0-2026-05-28; candidates c0-c1 diverged.", "date + candidate-vs-candidate text");
  assertNoOracleLeak("The non-canonical id c01_5 and c01-5 are not legal candidate adjacencies.", "non-canonical leading-zero candidates");
  assertNoOracleLeak("slot-rep-1234567890123456-c01234567890 and slot-rep-1151132f9fe65e18-c0dcace754bc", "echoed anonymous slot ids");
  assertNoOracleLeak("R1 [model-a] and R2 [model-b] are the review items.", "space-separated review labels");
  assertNoOracleLeak("The release date 2026-05-28 was noted.", "date");
  assertNoOracleLeak("The version 4-8 or 5.6 is fine.", "standalone version numbers");
  // CHAIN-BOUND CONTROLS: a longer `pseudo⇄version` chain must never be
  // rejected mid-way (start inside a `digit + [._-]` run), never swallow
  // the first segments leaving a `-4`/`_4` residue (end before
  // `[._-] + digit`), and the version slice `28-c0` inside a date must
  // never match — these were the round-three review finds.
  assertNoOracleLeak("Chains c0-1-2-3-4, [model-a]_1_2_3_4, 1-2-3-4-c0, c0-2026 and the four-segment sandwiches 1-2-3-4-c0-2 / 1-c0-2-3-4-5 are ordinary text.", "full chains + four-segment sandwiches");
  assertNoOracleLeak("1-[model-a]-V2-3-4-5, c0-1-v2-3-4 and 1-v2-3-4-c0 are 4-component version runs and stay.", "4-component version runs with per-segment v prefixes");
  assertNoOracleLeak("Released 2026-05-28-c0 / 2026_05_28_c0 are dates, not version residues.", "date-version slices");
  // The production redactor redacts the underscore aliases whole (one
  // pseudonym, no 4-8/5.6/v4 residue), collapses the glued residues and
  // leaves the ordinary text untouched.
  const { redact } = buildEpisodeRedactor("k".repeat(64), "rep-aaaaaaaaaaaaaaaa", ["anthropic/claude-opus-4-8", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash"], []);
  for (const alias of ["claude_opus_4-8", "claude_opus_4_8", "gpt_5.6_sol", "deepseek_v4_flash"]) {
    assert.match(redact(alias), /^\[model-[a-z]+\]$/);
  }
  assert.equal(redact("R1 [model-a] and 2026-05-28 and 4-8."), "R1 [model-a] and 2026-05-28 and 4-8.");
  assert.equal(redact("c0-2026-05-28 and slot-rep-1234567890123456-c01234567890 and c0-c1 diverged."), "c0-2026-05-28 and slot-rep-1234567890123456-c01234567890 and c0-c1 diverged.");
  // Uppercase-`V` and SANDWICH residues collapse entirely to the middle
  // pseudo/candidate (never a partial pair orphaning a trailing version).
  assert.equal(redact("[model-a]_V4 and [model]_V4 and c123_V4"), "[model-a] and [model] and c123", "uppercase-V residues must collapse");
  assert.equal(redact("1-[model-a]-2 and 1_[model]_2 and 1_c0_2 and 1.2-c123-v3_4"), "[model-a] and [model] and c0 and c123", "sandwich residues must collapse entirely");
  assert.equal(redact("1-2-3-4-c0-2 and 1-c0-2-3-4-5"), "1-2-3-4-c0-2 and 1-c0-2-3-4-5", "four-segment sandwiches must never partial-collapse");
  // Every `[._-]`-joined version segment may carry its own `v`/`V` prefix:
  // these per-segment-v residues collapse whole, never leaving a `_v4`/`-v2`
  // residue, and a `run_deepseek_4_v4.log` residue leaves no `_v4` tail.
  assert.equal(redact("c0-5_v4 and [model-a]-1-v2 and 1-[model-a]-2-v3 and 1-v2-c0 and c0-v1_V2-v3"), "c0 and [model-a] and [model-a] and c0 and c0", "per-segment-v residues must collapse entirely");
  const dsReplay = redact("run_deepseek_4_v4.log");
  assert.match(dsReplay, /^run_\[model-[a-z]+\]\.log$/, `run_deepseek_4_v4.log must collapse with no _v4 residue, got: ${dsReplay}`);
  // WIDENED tail guard: a pair must not eat a prefix leaving a `-V2`/`_v4`
  // residue — these 4-component version runs pass through untouched.
  assert.equal(redact("1-[model-a]-V2-3-4-5 and c0-1-v2-3-4 and 1-v2-3-4-c0"), "1-[model-a]-V2-3-4-5 and c0-1-v2-3-4 and 1-v2-3-4-c0", "4-component version runs must pass untouched");
  // The candidate side of the adjacency is any canonical candidate id (no
  // leading zeros): long non-zero candidates collapse, leading-zero (c01)
  // candidates never do.
  assert.equal(redact("c123_5 and c123-5 and c01_5 and c01-5"), "c123 and c123 and c01_5 and c01-5", "canonical unbounded candidates collapse; non-canonical c01 must NOT");
  // Chain-bound redactor controls: full chains pass through untouched; the
  // BARE `[model]` residue collapses to `[model]` (matching the oracle's
  // bare-pseudonym grammar).
  assert.equal(redact("c0-1-2-3-4 and [model-a]_1_2_3_4 and 1-2-3-4-c0 and released 2026-05-28-c0 and 2026_05_28_c0 and c0-2026"),
    "c0-1-2-3-4 and [model-a]_1_2_3_4 and 1-2-3-4-c0 and released 2026-05-28-c0 and 2026_05_28_c0 and c0-2026",
    "full chains and date-version slices must never collapse");
  assert.equal(redact("[model]-4 and [model]_4_8"), "[model] and [model]", "bare [model] residues must collapse to [model]");
  assert.equal(redact("[model-a]_1_2_3"), "[model-a]", "a full 3-component chain must collapse");
});

await check("failure retention: failed replay excluded from body, kept in sidecar with attempts/cost", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    {
      ...mockReplayResult("xai/grok-4.5", ""),
      ok: false,
      error: "transport timeout",
      error_class: "transport",
      exclusion_reason: "replay_call_failed",
      attempts: 1,
      cost: 0.02,
      cost_source: "provider",
      attempt_log: [{ attempt: 0, request_id: "req-grok-fail", ok: false, error: "transport timeout", error_class: "transport", usage: { input: 10, output: 5, cost: 0.02 }, cost: 0.02, cost_source: "provider" }],
    },
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "d".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  assert.equal(built.episode.slots.length, 4);
  const grok = built.sidecar.slots.find((s) => s.model === "xai/grok-4.5");
  assert.equal(grok.in_body, false);
  assert.equal(grok.exclusion_reason, "replay_call_failed");
  assert.equal(grok.replay.error, "transport timeout");
  assert.equal(grok.replay.attempts, 1);
  assert.equal(grok.replay.cost, 0.02);
});

await check("failure retention: all replay failed still returns sidecar + exclusion (no body)", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    { ...mockReplayResult("deepseek/deepseek-v4-flash", ""), ok: false, error: "x", error_class: "content", exclusion_reason: "replay_call_failed" },
    { ...mockReplayResult("xai/grok-4.5", ""), ok: false, error: "y", error_class: "content", exclusion_reason: "replay_call_failed" },
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "f".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  assert.equal(built.episode, null);
  assert.equal(built.exclusion.reason, "no_replay_candidates");
  assert.ok(built.sidecar);
  assert.equal(built.sidecar.slots.filter((s) => s.source?.kind === "replay").length, 2);
  for (const s of built.sidecar.slots.filter((s) => s.source?.kind === "replay")) {
    assert.equal(s.in_body, false);
    assert.ok(s.replay);
  }
});

await check("ambiguous identity token fails the slot closed", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "The M3 evaluation criteria are unclear."),
    mockReplayResult("xai/grok-4.5", "Fine answer."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "e".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  const flash = built.sidecar.slots.find((s) => s.model === "deepseek/deepseek-v4-flash");
  assert.equal(flash.in_body, false);
  assert.equal(flash.exclusion_reason, "replay_ambiguous_identity_token");
  assertAnonymousReplayBody(built.episode, "body with ambiguous token excluded");
});

await check("degeneration: number/list stream, repeated tail, action-only, near-cap", () => {
  const listStream = Array.from({ length: 30 }, (_, i) => `${i + 1}.`).join("\n");
  const d1 = R.detectGenerationDegeneration(listStream, { maxOutputBytes: 10_000 });
  assert.equal(d1.degenerated, true);
  assert.ok(d1.reasons.includes("number_or_list_stream"));

  const unit = "REPEAT_BLOCK_XYZ_12345_";
  const loop = unit.repeat(20);
  const d2 = R.detectGenerationDegeneration(loop, { maxOutputBytes: 10_000 });
  assert.equal(d2.degenerated, true);
  assert.ok(d2.reasons.includes("repeated_tail_loop"));

  const action = "I'll read the file and run the test suite in the workspace.";
  const d3 = R.detectGenerationDegeneration(action, { maxOutputBytes: 10_000 });
  assert.equal(d3.degenerated, true);
  assert.ok(d3.reasons.includes("action_intent_without_substance"));

  const near = "x".repeat(9500);
  const d4 = R.detectGenerationDegeneration(near, { maxOutputBytes: 10_000 });
  assert.equal(d4.degenerated, true);
  assert.ok(d4.reasons.includes("near_max_output_bytes"));

  const ok = "This is a substantive answer that addresses the question with concrete reasoning and a clear conclusion about the design tradeoff.";
  const d5 = R.detectGenerationDegeneration(ok, { maxOutputBytes: 10_000 });
  assert.equal(d5.degenerated, false);
});

await check("degeneration: Chinese action intent without substance", () => {
  const zh = "我先收集关于 LLM agent 长程任务中 todo/checklist 有效性、目标漂移、以及 Code 等实战经验的证据。";
  const d = R.detectGenerationDegeneration(zh, { maxOutputBytes: 200_000, usage: { output: 200 } });
  assert.equal(d.degenerated, true);
  assert.ok(d.reasons.includes("action_intent_without_substance"), d.reasons.join(","));

  for (const open of ["让我检查仓库状态", "我将先搜索相关证据", "我需要先查看文件", "我来收集资料", "先检查代码再回答"]) {
    const dx = R.detectGenerationDegeneration(open, { maxOutputBytes: 200_000 });
    assert.equal(dx.degenerated, true, open);
    assert.ok(dx.reasons.includes("action_intent_without_substance"), open);
  }
});

await check("degeneration: 98k tokens / 75 visible chars is extreme imbalance", () => {
  const text = "我先收集关于 LLM agent 长程任务中 todo/checklist 有效性、目标漂移、以及 [model-bp] Code 等实战经验的证据。";
  assert.equal(R.visibleCharLength(text), 75);
  const d = R.detectGenerationDegeneration(text, {
    maxOutputBytes: 200_000,
    usage: { output: 98_304 },
    // catalog maxTokens must NOT be required; imbalance uses usage.output
    maxOutputTokens: null,
  });
  assert.equal(d.degenerated, true);
  assert.ok(d.reasons.includes("token_visible_extreme_imbalance"), d.reasons.join(","));
  // catalog-sized max must not be used by caller; when actual call cap is known:
  const dCap = R.detectGenerationDegeneration(text, {
    maxOutputBytes: 200_000,
    usage: { output: 98_304 },
    maxOutputTokens: 98_304, // actual call cap
  });
  assert.ok(dCap.reasons.includes("near_max_output_tokens"));
  // catalog-like huge max would NOT fire near_max (and must not be passed in prod)
  const dCatalog = R.detectGenerationDegeneration(text, {
    maxOutputBytes: 200_000,
    usage: { output: 98_304 },
    maxOutputTokens: 500_000,
  });
  assert.ok(!dCatalog.reasons.includes("near_max_output_tokens"));
  assert.ok(dCatalog.reasons.includes("token_visible_extreme_imbalance"));
});

await check("degeneration: normal short sign answers are NOT false-killed", () => {
  const cases = [
    { text: "签署", usage: { output: 717 } },
    { text: "**签署**\n\n无最小阻塞性修改。", usage: { output: 1129 } },
    { text: "ACCEPT", usage: { output: 504 } },
    { text: "**ACCEPT**", usage: { output: 556 } },
    { text: "ACCEPT\n\n仍认为不存在严格更好的整体方案。", usage: { output: 16 } },
  ];
  for (const c of cases) {
    const d = R.detectGenerationDegeneration(c.text, {
      maxOutputBytes: 200_000,
      usage: c.usage,
      maxOutputTokens: null,
    });
    assert.equal(d.degenerated, false, `${JSON.stringify(c.text)} reasons=${d.reasons.join(",")}`);
  }
});

await check("degeneration in build: infrastructure_or_generation_failure not in body", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    {
      ...mockReplayResult("deepseek/deepseek-v4-flash", ""),
      ok: false,
      error: "generation degeneration: number_or_list_stream",
      error_class: "infrastructure_or_generation_failure",
      exclusion_reason: "infrastructure_or_generation_failure",
      attempt_log: [{ attempt: 0, request_id: "req-degen-flash", ok: false, error_class: "infrastructure_or_generation_failure", error: "generation degeneration", usage: { input: 10, output: 5, cost: 0.001 }, cost: 0.001, cost_source: "provider" }],
    },
    mockReplayResult("xai/grok-4.5", "A fine substantive answer that stays in the body."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "i".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  const flash = built.sidecar.slots.find((s) => s.model === "deepseek/deepseek-v4-flash");
  assert.equal(flash.in_body, false);
  assert.equal(flash.exclusion_reason, "infrastructure_or_generation_failure");
  assert.equal(flash.replay.error_class, "infrastructure_or_generation_failure");
  assert.ok(built.episode.slots.every((s) => s.output !== ""));
});

await check("thinking support: null map entry is unsupported (fail-closed)", () => {
  const flashLike = { reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } };
  assert.equal(R.isThinkingLevelSupported(flashLike, "high"), true);
  assert.equal(R.isThinkingLevelSupported(flashLike, "medium"), false);
  assert.equal(R.isThinkingLevelSupported(flashLike, "xhigh"), false);
  const grokLike = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } };
  assert.equal(R.isThinkingLevelSupported(grokLike, "medium"), true);
  assert.equal(R.isThinkingLevelSupported(grokLike, "xhigh"), false);
});

await check("preflight compatibility: first-2 compatible in manifest order; medium/missing/model-missing excluded", () => {
  // Mirrors the real registry: Flash maps medium to null, Grok supports medium.
  const flashLike = { reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } };
  const grokLike = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } };
  const registry = new Map([
    ["deepseek/deepseek-v4-flash", flashLike],
    ["xai/grok-4.5", grokLike],
  ]);
  const resolveModel = (ref) => registry.get(ref) ?? null;
  const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
  const episodesById = new Map([
    ["ep-a", { episode_id: "ep-a", thinking_level: "high" }],
    ["ep-b", { episode_id: "ep-b", thinking_level: "medium" }],
    ["ep-c", { episode_id: "ep-c", thinking_level: "high" }],
    ["ep-d", { episode_id: "ep-d", thinking_level: "medium" }],
    ["ep-no-think", { episode_id: "ep-no-think" }],
  ]);

  // high/medium mix: first 2 compatible are ep-a (high) and ep-c (high);
  // ep-b/ep-d (medium) are preflight-incompatible because Flash maps medium
  // to null — reported with per-model reasons, never sent to a provider.
  const r1 = R.selectCompatibleEpisodes(["ep-a", "ep-b", "ep-c", "ep-d"], episodesById, models, { resolveModel });
  assert.deepEqual(r1.selected.map((s) => s.episode_id), ["ep-a", "ep-c"]);
  assert.equal(r1.compatibleCount, 2);
  assert.deepEqual(r1.excluded.map((e) => e.episode_id), ["ep-b", "ep-d"]);
  for (const ex of r1.excluded) {
    assert.equal(ex.thinking, "medium");
    assert.ok(ex.reasons.some((r) => r.model === "deepseek/deepseek-v4-flash" && r.reason === "thinking_level_unsupported"));
    assert.ok(!ex.reasons.some((r) => r.model === "xai/grok-4.5"), "Grok supports medium — must not be blamed");
  }

  // Missing episode + missing thinking_level are preflight exclusions too.
  const r2 = R.selectCompatibleEpisodes(["ep-a", "ep-missing", "ep-no-think"], episodesById, models, { resolveModel });
  assert.deepEqual(r2.selected.map((s) => s.episode_id), ["ep-a"]);
  assert.equal(r2.compatibleCount, 1);
  assert.deepEqual(r2.excluded.map((e) => e.episode_id), ["ep-missing", "ep-no-think"]);
  assert.ok(r2.excluded[0].reasons.some((r) => r.reason === "episode_missing"));
  assert.ok(r2.excluded[1].reasons.some((r) => r.reason === "thinking_missing"));

  // Unregistered replay model fails the episode closed (dossier throws globally).
  const r3 = R.selectCompatibleEpisodes(["ep-a"], episodesById, ["deepseek/deepseek-v4-flash", "xai/ghost-9"], { resolveModel });
  assert.equal(r3.selected.length, 0);
  assert.equal(r3.compatibleCount, 0);
  assert.ok(r3.excluded[0].reasons.some((r) => r.model === "xai/ghost-9" && r.reason === "model_not_registered"));

  // Custom support callback path (no registry dependency).
  const r4 = R.selectCompatibleEpisodes(["ep-a", "ep-b"], episodesById, models, {
    resolveModel,
    isSupported: (m, lvl) => m.thinkingLevelMap?.[lvl] != null,
  });
  assert.deepEqual(r4.selected.map((s) => s.episode_id), ["ep-a"]);
  assert.equal(r4.compatibleCount, 1);
});

await check("replayBuildWatchdogMs: ceil(episodeCount/concurrency) serial batches × (maxRetries+1) × timeout + margin; invalid params fail closed", () => {
  // Episodes run in parallel up to `concurrency`; each serial batch is
  // bounded by (maxRetries+1) attempts × timeoutMs, plus a margin.
  // Defaults (1 episode, 1 concurrency, 2, 600000, 600000) → 3 × 600000 + 600000 = 2_400_000.
  assert.equal(R.replayBuildWatchdogMs(), 2_400_000);
  // 2 episodes / concurrency 2 → ceil(2/2)=1 batch → unchanged 2_400_000.
  assert.equal(R.replayBuildWatchdogMs({ episodeCount: 2, concurrency: 2 }), 2_400_000);
  // 3 episodes / concurrency 2 → ceil(3/2)=2 batches → 2×3×600000+600000 = 4_200_000.
  assert.equal(R.replayBuildWatchdogMs({ episodeCount: 3, concurrency: 2 }), 4_200_000);
  // 4 episodes / concurrency 3 → ceil(4/3)=2 batches → 4_200_000.
  assert.equal(R.replayBuildWatchdogMs({ episodeCount: 4, concurrency: 3 }), 4_200_000);
  // 2 episodes / concurrency 1 → 2 batches → 4_200_000.
  assert.equal(R.replayBuildWatchdogMs({ episodeCount: 2, concurrency: 1 }), 4_200_000);
  // maxRetries=0 → 1 × 1 × 600000 + 600000 = 1_200_000.
  assert.equal(R.replayBuildWatchdogMs({ maxRetries: 0 }), 1_200_000);
  // Invalid parameters fail closed (never a silent fallback).
  assert.throws(() => R.replayBuildWatchdogMs({ maxRetries: -1 }), /non-negative/);
  assert.throws(() => R.replayBuildWatchdogMs({ timeoutMs: 0 }), /positive/);
  assert.throws(() => R.replayBuildWatchdogMs({ marginMs: 0 }), /positive/);
  assert.throws(() => R.replayBuildWatchdogMs({ timeoutMs: 1.5 }), /integer/);
  assert.throws(() => R.replayBuildWatchdogMs({ maxRetries: Infinity }), /integer/);
  assert.throws(() => R.replayBuildWatchdogMs({ episodeCount: 0 }), /positive/);
  assert.throws(() => R.replayBuildWatchdogMs({ episodeCount: 1.5 }), /integer/);
  assert.throws(() => R.replayBuildWatchdogMs({ concurrency: 0 }), /positive/);
  assert.throws(() => R.replayBuildWatchdogMs({ concurrency: 2.5 }), /integer/);
});

await check("selectionManifestHash binds the FULL semantic manifest (selected/classifications/counts/exclusion/hard_only/limit), not just episode_ids", () => {
  const base = {
    schema_version: 1,
    kind: "prompt_only_replay_selection",
    protocol_hash: "a".repeat(64),
    classify: true,
    thinking: "medium",
    judge_models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
    classifier_models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
    downstream_judges: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "kimi-coding/k3"],
    counts: { source: 2, hard_pass: 2, classified: 2, replayable: 1, excluded: 1 },
    exclusion_distribution: { no_strong_reference: 1 },
    selected: [{ episode_id: "ep-aaaaaaaaaaaaaaaa", models: ["openai/gpt-5.5"], join_confidence: "exact", tools: null, stage: "llm", replayable: true, confidence: 0.9, reasons: ["r1"] }],
    excluded: [{ episode_id: "ep-bbbbbbbbbbbbbbbb", stage: "hard", reasons: ["no_specialist"] }],
    classifications: [{ episode_id: "ep-aaaaaaaaaaaaaaaa", stage: "llm", replayable: true, reasons: ["r1"], confidence: 0.9 }],
    episode_ids: ["ep-aaaaaaaaaaaaaaaa"],
    hard_only: false,
    limit: null,
  };
  const h = R.selectionManifestHash(base);
  // Any selected/classification/count/exclusion content change changes the hash.
  assert.notEqual(R.selectionManifestHash({ ...base, selected: [{ ...base.selected[0], reasons: ["r2"] }] }), h, "selected reasons change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, selected: [{ ...base.selected[0], episode_id: "ep-cccccccccccccccc" }] }), h, "selected id change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, classifications: [{ ...base.classifications[0], replayable: false }] }), h, "classification change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, counts: { ...base.counts, hard_pass: 3 } }), h, "counts change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, exclusion_distribution: { no_specialist: 1 } }), h, "exclusion_distribution change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, episode_ids: ["ep-bbbbbbbbbbbbbbbb"] }), h, "episode_ids change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, hard_only: true }), h, "hard_only change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, limit: 5 }), h, "limit change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, classify: false }), h, "classify change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, thinking: "high" }), h, "thinking change must change hash");
  assert.notEqual(R.selectionManifestHash({ ...base, downstream_judges: ["openai/gpt-5.6-sol"] }), h, "downstream change must change hash");
  // Relocation-stable: absolute paths / generated_at / concurrency are NOT bound.
  assert.equal(R.selectionManifestHash({ ...base, episodes: "/some/abs/path/episodes.jsonl", meta: "/some/abs/path/meta.jsonl" }), h, "absolute paths must not change the hash (relocation-stable)");
  assert.equal(R.selectionManifestHash({ ...base, generated_at: "2026-08-13T00:00:00.000Z" }), h, "generated_at must not change the hash");
  assert.equal(R.selectionManifestHash({ ...base, concurrency: 8 }), h, "concurrency must not change the hash");
});

await check("oracle + redactor: full UUIDv7 shape (8-4-7xxx-variant-12) catches 019e/019f/01a0; UUIDv4 and anonymous rep-/slot- HMAC ids are NOT matched", () => {
  // UUIDv7 session ids across the ULID-style timestamp prefixes.
  const v7_019f = "019ff87f-13bd-70c8-abca-e4bb132c6140";
  const v7_019e = "019e1234-5678-7abc-8def-0123456789ab";
  const v7_01a0 = "01a0abcd-ef01-7a01-b234-567890abcdef";
  for (const id of [v7_019f, v7_019e, v7_01a0]) {
    assert.ok(ORACLE.sessionIdRe.test(id), `oracle must match UUIDv7 ${id}`);
    assert.throws(() => assertNoOracleLeak(`session ${id} in text`, "test"), /session id/, `oracle must reject ${id}`);
    // Case-insensitive: uppercase UUIDv7 (quoted / file-name forms) is caught too.
    assert.ok(ORACLE.sessionIdRe.test(id.toUpperCase()), `oracle must match uppercase UUIDv7 ${id.toUpperCase()}`);
    assert.throws(() => assertNoOracleLeak(`session ${id.toUpperCase()} in text`, "test"), /session id/, `oracle must reject uppercase ${id.toUpperCase()}`);
  }
  // UUIDv4 (version nibble 4) must NOT match.
  const v4 = "550e8400-e29b-41d4-a716-446655440000";
  assert.ok(!ORACLE.sessionIdRe.test(v4), "UUIDv4 must not match the session-id oracle");
  assertNoOracleLeak(`uuid ${v4} in text`, "uuidv4");
  // Anonymous rep-/slot- HMAC ids must NOT match the session-id oracle. (The
  // content oracle also accepts them: the bounded SHORT-version grammar +
  // alnum-context lookarounds never match their hex boundaries — an
  // accidental "…e18-c0dc…" "8-c0" sequence is blocked by the trailing
  // alnum — so an echoed anonymous id is legal content with no random flake.)
  const repId = "rep-1151132f9fe65e18";
  const slotId = "slot-rep-1151132f9fe65e18-c0dcace754bc";
  assert.ok(!ORACLE.sessionIdRe.test(repId), "anonymous rep- id must not match");
  assert.ok(!ORACLE.sessionIdRe.test(slotId), "anonymous slot- id must not match");
  // The production redactor (t0-episode-build) replaces UUIDv7 with [session]
  // and leaves UUIDv4 / anonymous ids untouched.
  const { redact } = buildEpisodeRedactor("k".repeat(64), "rep-aaaaaaaaaaaaaaaa", [], []);
  const out = redact(`session ${v7_019f} and ${v7_019e} and ${v7_01a0} plus ${v4} plus ${repId} ${slotId}`);
  assert.ok(!out.includes(v7_019f) && !out.includes(v7_019e) && !out.includes(v7_01a0), "redactor must replace all UUIDv7 session ids");
  assert.ok(out.includes("[session]"), "redactor must use the [session] placeholder");
  assert.ok(out.includes(v4), "redactor must leave UUIDv4 untouched");
  assert.ok(out.includes(repId) && out.includes(slotId), "redactor must leave anonymous rep-/slot- ids untouched");
  // Uppercase UUIDv7 redacts too (case-insensitive session-id pattern).
  assert.equal(redact(`file_${v7_019f.toUpperCase()}.jsonl`), "file_[session].jsonl");
});

await check("replay body: source prompt is re-redacted (UUIDv7 cannot pass through into the body; oracle is the fail-closed backstop)", () => {
  const src = {
    ...FIXTURE_EPISODES[0],
    prompt: "Review the R4 changes. Session 019ff87f-13bd-70c8-abca-e4bb132c6140 was used.",
  };
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "m".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  assert.equal(built.exclusion, null);
  const body = JSON.stringify(built.episode);
  assert.ok(!body.includes("019ff87f-13bd-70c8-abca-e4bb132c6140"), "UUIDv7 must not pass through into the replay body");
  assert.ok(body.includes("[session]"), "UUIDv7 must be replaced with [session]");
  // The combined oracle (structural + content) passes on the redacted body.
  assertAnonymousReplayBody(built.episode, "redacted replay body");
});

await check("runReplayAnswer: 5-attempt transport-then-success — usage=null attempts are cost null/source null in the ledger, never a fake 0; calls/attempts/unknown propagate", async () => {
  // 5 actual provider requests: attempts 0-3 throw transport (usage null),
  // attempt 4 succeeds. runReplayAnswer's attempt_log must record all 5
  // exactly once; the 4 unknown attempts are cost null/source null; the
  // returned cost is only the known success cost; cost_source is mixed.
  let calls = 0;
  const invoker = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => {
      calls++;
      if (calls < 5) throw new Error("429 rate limit");
      return { stopReason: "stop", content: [{ type: "text", text: "A complete final answer with a clear conclusion." }], usage: { input: 100, output: 50, cost: 0.02 } };
    },
  };
  const r = await R.runReplayAnswer(invoker, "deepseek/deepseek-v4-flash", "Task prompt", {
    thinking: "high", maxRetries: 4, timeoutMs: 5_000, backoff: () => 0,
  });
  assert.equal(calls, 5, "exactly 5 actual provider requests");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.attempts, 5);
  assert.equal(r.attempt_log.length, 5, "every actual request recorded exactly once");
  for (let i = 0; i < 4; i++) {
    assert.equal(r.attempt_log[i].ok, false);
    assert.equal(r.attempt_log[i].error_class, "transport");
    assert.equal(r.attempt_log[i].usage, null);
    assert.equal(r.attempt_log[i].cost, null, `attempt ${i} must be cost null, never a fake 0`);
    assert.equal(r.attempt_log[i].cost_source, null);
  }
  assert.equal(r.attempt_log[4].ok, true);
  assert.equal(r.attempt_log[4].cost, 0.02);
  assert.equal(r.attempt_log[4].cost_source, "provider");
  assert.equal(r.cost, 0.02, "known cost only — unknown attempts never enter the total");
  assert.equal(r.cost_source, "mixed");
});

await check("checkpoint protocol hash binds selection/source/models/thinking/protocol/resources", () => {
  const base = {
    selectionHash: "s".repeat(64),
    sourceContentHash: "c".repeat(64),
    models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
    thinking: "high",
    maxOutputBytes: 200_000,
    maxEpisodeBytes: 1_000_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  };
  const h1 = R.buildReplayProtocolHash(base);
  const h2 = R.buildReplayProtocolHash(base);
  assert.equal(h1, h2);
  const h3 = R.buildReplayProtocolHash({ ...base, thinking: "medium" });
  assert.notEqual(h1, h3);
  const h4 = R.buildReplayProtocolHash({ ...base, selectionHash: "t".repeat(64) });
  assert.notEqual(h1, h4);
  const h5 = R.buildReplayProtocolHash({ ...base, maxRetries: 3 });
  assert.notEqual(h1, h5);
});

await check("replay protocol: prompt-only capability contract (no tools/search/live state; direct final answer)", () => {
  const p = R.REPLAY_USER_PROTOCOL;
  // Explicit no-tools / no-search / no-live-state semantics.
  assert.match(p, /no tools, browsing, search, file access, workspace, or live external state/i);
  // Answer from the task prompt + existing knowledge only.
  assert.match(p, /using only the prompt itself and your existing knowledge/i);
  // Never announce or attempt tool use.
  assert.match(p, /do not announce or attempt any tool use/i);
  // Direct complete final answer.
  assert.match(p, /complete final answer directly/i);
  // Identical for every model/episode/attempt (a constant, not per-run text).
  assert.equal(R.REPLAY_USER_PROTOCOL, p);
});

await check("protocol hash binds the retry hint (any change invalidates resume)", () => {
  const base = {
    selectionHash: "s".repeat(64),
    sourceContentHash: "c".repeat(64),
    models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
    thinking: "high",
    maxOutputBytes: 200_000,
    maxEpisodeBytes: 1_000_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  };
  const h1 = R.buildReplayProtocolHash(base);
  // Default binds REPLAY_RETRY_HINT.
  assert.equal(R.buildReplayProtocolHash({ ...base, retryHint: R.REPLAY_RETRY_HINT }), h1);
  // Any retry-hint change changes the hash.
  assert.notEqual(R.buildReplayProtocolHash({ ...base, retryHint: "a different retry hint" }), h1);
  assert.notEqual(R.buildReplayProtocolHash({ ...base, retryHint: "" }), h1);
});

await check("retry hint: degeneration retry sends REPLAY_RETRY_HINT on the second attempt", async () => {
  const calls = [];
  const invoker = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async (_root, meta, _piAi, _model, opts) => {
      calls.push({ attempt: meta.attempt, userContent: opts.messages[0].content[0].text });
      if (calls.length === 1) {
        // Action-intent-only output → generation degeneration (never in body).
        return { stopReason: "stop", content: [{ type: "text", text: "I'll read the file and run the test suite in the workspace." }], usage: { input: 10, output: 5 } };
      }
      return { stopReason: "stop", content: [{ type: "text", text: "A substantive final answer with a clear conclusion." }], usage: { input: 10, output: 5 } };
    },
  };
  const r = await R.runReplayAnswer(invoker, "deepseek/deepseek-v4-flash", "Task prompt", {
    thinking: "high", maxRetries: 2, timeoutMs: 5_000,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 2, "degeneration must trigger exactly one retry");
  assert.ok(calls[0].userContent.includes(R.REPLAY_USER_PROTOCOL));
  assert.ok(!calls[0].userContent.includes(R.REPLAY_RETRY_HINT), "first attempt must not carry the retry hint");
  assert.ok(calls[1].userContent.includes(R.REPLAY_RETRY_HINT), "second attempt must carry REPLAY_RETRY_HINT");
  assert.ok(calls[1].userContent.includes("Task prompt"));
});

await check("runReplayAnswer: pre-request failures (model not found / thinking unsupported) are 0-call — attempts=0, empty ledger, no unknown-cost attempt", async () => {
  // Model not found: resolveModelFromInvoker returns null → fail-closed slot
  // but NO provider request (attempts=0, empty attempt_log).
  const invoker = {
    registry: {
      find: () => null,
      getApiKeyAndHeaders: async () => { throw new Error("must not be called"); },
    },
  };
  const r1 = await R.runReplayAnswer(invoker, "unknown/model", "Task prompt", { thinking: "high" });
  assert.equal(r1.ok, false);
  assert.equal(r1.exclusion_reason, "replay_model_not_found");
  assert.equal(r1.attempts, 0, "model-not-found must be attempts=0 (no provider request)");
  assert.deepEqual(r1.attempt_log, [], "model-not-found must have an empty ledger");
  assert.equal(r1.cost, null);
  assert.equal(r1.cost_source, null);

  // Thinking unsupported: fail-closed before any call.
  const invoker2 = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: false }),
      getApiKeyAndHeaders: async () => { throw new Error("must not be called"); },
    },
  };
  const r2 = await R.runReplayAnswer(invoker2, "deepseek/deepseek-v4-flash", "Task prompt", { thinking: "high" });
  assert.equal(r2.ok, false);
  assert.equal(r2.exclusion_reason, "thinking_level_unsupported");
  assert.equal(r2.attempts, 0, "unsupported thinking must be attempts=0 (no provider request)");
  assert.deepEqual(r2.attempt_log, [], "unsupported thinking must have an empty ledger");
  assert.equal(r2.cost, null);
  assert.equal(r2.cost_source, null);

  // Auth unavailable: callJudge returns an empty ledger → pre-request failure,
  // attempts=0, no retry.
  let authCalls = 0;
  const invoker3 = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: false, error: "missing api key" };
      },
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => { throw new Error("must not be called"); },
  };
  const r3 = await R.runReplayAnswer(invoker3, "deepseek/deepseek-v4-flash", "Task prompt", {
    thinking: "high", maxRetries: 3, timeoutMs: 5_000,
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.attempts, 0, "auth failure must be attempts=0 (no provider request)");
  assert.deepEqual(r3.attempt_log, [], "auth failure must have an empty ledger");
  assert.equal(authCalls, 1, "auth is checked once — no meaningless retry");
});

await check("runReplayAnswer: every real request keeps its request_id — success, transport-then-success, degeneration-then-success all unique", async () => {
  // Success: one real request, request_id preserved from callJudge's ledger.
  const invokerOk = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => ({ stopReason: "stop", content: [{ type: "text", text: "A complete final answer with a clear conclusion." }], usage: { input: 10, output: 5, cost: 0.01 } }),
  };
  const ok = await R.runReplayAnswer(invokerOk, "deepseek/deepseek-v4-flash", "Task prompt", { thinking: "high", timeoutMs: 5_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempt_log.length, 1);
  assert.equal(typeof ok.attempt_log[0].request_id, "string");
  assert.ok(ok.attempt_log[0].request_id.length > 0, "success entry must keep its request_id");
  assert.equal(ok.attempt_log[0].ok, true);
  assert.equal(ok.attempt_log[0].cost, 0.01);

  // Transport-then-success: 3 real requests, all request_ids unique.
  let calls = 0;
  const invokerT = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => {
      calls++;
      if (calls < 3) throw new Error("429 rate limit");
      return { stopReason: "stop", content: [{ type: "text", text: "A complete final answer with a clear conclusion." }], usage: { input: 10, output: 5, cost: 0.02 } };
    },
  };
  const t = await R.runReplayAnswer(invokerT, "deepseek/deepseek-v4-flash", "Task prompt", {
    thinking: "high", maxRetries: 3, timeoutMs: 5_000, backoff: () => 0,
  });
  assert.equal(t.ok, true);
  assert.equal(t.attempt_log.length, 3);
  const tIds = t.attempt_log.map((e) => e.request_id);
  assert.ok(tIds.every((id) => typeof id === "string" && id.length > 0), "every real request must keep its request_id");
  assert.equal(new Set(tIds).size, 3, "transport retries must each carry a DIFFERENT request_id");
  assert.equal(t.attempt_log[0].error_class, "transport");
  assert.equal(t.attempt_log[2].ok, true);

  // Degeneration-then-success: 2 real requests, request_ids unique; the
  // degeneration entry keeps the SAME request_id as the underlying call.
  let dCalls = 0;
  const invokerD = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => {
      dCalls++;
      if (dCalls === 1) {
        return { stopReason: "stop", content: [{ type: "text", text: "I'll read the file and run the test suite in the workspace." }], usage: { input: 10, output: 5 } };
      }
      return { stopReason: "stop", content: [{ type: "text", text: "A substantive final answer with a clear conclusion." }], usage: { input: 10, output: 5, cost: 0.01 } };
    },
  };
  const d = await R.runReplayAnswer(invokerD, "deepseek/deepseek-v4-flash", "Task prompt", {
    thinking: "high", maxRetries: 2, timeoutMs: 5_000,
  });
  assert.equal(d.ok, true);
  assert.equal(d.attempt_log.length, 2);
  const dIds = d.attempt_log.map((e) => e.request_id);
  assert.equal(new Set(dIds).size, 2, "degeneration retry must carry a DIFFERENT request_id");
  assert.equal(d.attempt_log[0].error_class, "infrastructure_or_generation_failure");
  assert.ok(d.attempt_log[0].degeneration_reasons?.length > 0, "degeneration entry keeps its reasons on the SAME request_id entry");
  assert.equal(d.attempt_log[1].ok, true);
});

await check("replay checkpoint: ledger_version written + old-format checkpoint never resumed (same-ID idempotent resume)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-cp-ledger-"));
  try {
    const src = FIXTURE_EPISODES[0];
    const srcMeta = FIXTURE_META[0];
    const contentHash = C.episodeContentHash(src);
    const protocolHash = R.buildReplayProtocolHash({
      selectionHash: "s".repeat(64),
      sourceContentHash: contentHash,
      models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
      thinking: "high",
      maxOutputBytes: 200_000,
      maxEpisodeBytes: 1_000_000,
      timeoutMs: 600_000,
      maxRetries: 2,
    });
    const replayEpisodeId = R.buildReplayEpisodeId("k".repeat(64), src.episode_id, ["deepseek/deepseek-v4-flash", "xai/grok-4.5"]);
    const cpFile = path.join(tmp, "checkpoints", `${replayEpisodeId}.json`);
    // New-format checkpoint: ledger_version written at top level.
    const results = [
      mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
      mockReplayResult("xai/grok-4.5", "Replay answer two."),
    ];
    const built = R.buildReplayEpisode({
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      selectionHash: "s".repeat(64), protocolHash,
    });
    const cp = {
      ledger_version: C.ATTEMPT_LEDGER_VERSION,
      schema_version: R.REPLAY_SCHEMA_VERSION,
      source_episode_id: src.episode_id,
      source_content_hash: contentHash,
      source_thinking: src.thinking_level ?? null,
      replay_thinking: "high",
      selection_hash: "s".repeat(64),
      protocol_hash: protocolHash,
      experiment_mode: null,
      history_excluded: false,
      replay_models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
      replay_material: R.buildReplayMaterial(results),
      episode: built.episode,
      sidecar: built.sidecar,
      exclusion: built.exclusion,
      built_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(cpFile), { recursive: true });
    fs.writeFileSync(cpFile, `${JSON.stringify(cp, null, 2)}\n`);
    // Same-ID resume: the contextual validator accepts the new-format
    // checkpoint (real source episode/meta, blind key, corpus, options).
    const validArgs = {
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      contentHash, models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
      protocolHash, selectionHash: "s".repeat(64),
    };
    const valid = R.checkpointValid(cp, validArgs);
    assert.equal(valid, true);
    // Old-format checkpoint (no ledger_version) with the SAME id/hash is NOT
    // resumed — the ledger contract changed.
    const oldCp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    delete oldCp.ledger_version;
    fs.writeFileSync(cpFile, `${JSON.stringify(oldCp, null, 2)}\n`);
    const stale = R.checkpointValid(oldCp, validArgs);
    assert.equal(stale, false, "old-format checkpoint (no ledger_version) must never be resumed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("checkpointValid: top-level v2 with fake replay ledger (missing/duplicate request_id, forged cost/source, attempts mismatch, slot coverage, sidecar identity) is NEVER valid; legal v2 still valid", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-cp-fakev2-"));
  try {
    const src = FIXTURE_EPISODES[0];
    const srcMeta = FIXTURE_META[0];
    const contentHash = C.episodeContentHash(src);
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    const protocolHash = R.buildReplayProtocolHash({
      selectionHash: "s".repeat(64),
      sourceContentHash: contentHash,
      models,
      thinking: "high",
      maxOutputBytes: 200_000,
      maxEpisodeBytes: 1_000_000,
      timeoutMs: 600_000,
      maxRetries: 2,
    });
    const results = [
      mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
      mockReplayResult("xai/grok-4.5", "Replay answer two."),
    ];
    const built = R.buildReplayEpisode({
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      replayResults: results,
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      selectionHash: "s".repeat(64), protocolHash,
    });
    const mkCp = (overrides = {}) => ({
      ledger_version: C.ATTEMPT_LEDGER_VERSION,
      schema_version: R.REPLAY_SCHEMA_VERSION,
      source_episode_id: src.episode_id,
      source_content_hash: contentHash,
      source_thinking: src.thinking_level ?? null,
      replay_thinking: "high",
      selection_hash: "s".repeat(64),
      protocol_hash: protocolHash,
      experiment_mode: null,
      history_excluded: false,
      replay_models: models,
      replay_material: R.buildReplayMaterial(results),
      episode: built.episode,
      sidecar: JSON.parse(JSON.stringify(built.sidecar)),
      exclusion: built.exclusion,
      built_at: new Date().toISOString(),
      ...overrides,
    });
    const validArgs = {
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      contentHash, models, protocolHash, selectionHash: "s".repeat(64),
    };
    assert.equal(R.checkpointValid(mkCp(), validArgs), true, "legal v2 replay checkpoint must be valid");
    // 1. Missing request_id in a replay slot ledger → invalid.
    const noId = mkCp();
    delete noId.sidecar.slots.find((s) => s.source?.kind === "replay").replay.attempt_log[0].request_id;
    assert.equal(R.checkpointValid(noId, validArgs), false, "missing request_id must be invalid");
    // 2. Duplicate request_id across replay slots → invalid.
    const dup = mkCp();
    const slots = dup.sidecar.slots.filter((s) => s.source?.kind === "replay");
    slots[1].replay.attempt_log[0].request_id = slots[0].replay.attempt_log[0].request_id;
    assert.equal(R.checkpointValid(dup, validArgs), false, "duplicate request_id must be invalid");
    // 3. Forged cost/source (does not match attemptCost(modelRef, usage)) → invalid.
    const fakeCost = mkCp();
    fakeCost.sidecar.slots.find((s) => s.source?.kind === "replay").replay.attempt_log[0].cost = 999;
    assert.equal(R.checkpointValid(fakeCost, validArgs), false, "forged cost/source must be invalid");
    // 4. attempts != log.length → invalid.
    const badAttempts = mkCp();
    badAttempts.sidecar.slots.find((s) => s.source?.kind === "replay").replay.attempts = 7;
    assert.equal(R.checkpointValid(badAttempts, validArgs), false, "attempts mismatch must be invalid");
    // 5. Replay slot coverage: a replay model missing from the sidecar → invalid.
    const missingSlot = mkCp();
    missingSlot.sidecar.slots = missingSlot.sidecar.slots.filter((s) => s.source?.kind !== "replay" || s.model !== "xai/grok-4.5");
    assert.equal(R.checkpointValid(missingSlot, validArgs), false, "missing replay slot must be invalid");
    // 6. Sidecar identity mismatch (sidecar.source_content_hash != top-level) → invalid.
    const idMismatch = mkCp();
    idMismatch.sidecar.source_content_hash = "0".repeat(64);
    assert.equal(R.checkpointValid(idMismatch, validArgs), false, "sidecar identity mismatch must be invalid");
    // 7. episode non-null must pass assertAnonymousBody (a leaked sidecar key fails).
    const leak = mkCp();
    leak.episode = { ...built.episode, usage: { tokens_in: 1 } };
    assert.equal(R.checkpointValid(leak, validArgs), false, "anonymous-body leak must be invalid");
    // 8. All-failed episode=null stays legal (pre-request unsupported empty
    // ledger is legal too) — the MATERIAL must be all-failed as well, so the
    // contextual rebuild reproduces the same all-failed surfaces.
    const allFailedResults = [
      { ...mockReplayResult("deepseek/deepseek-v4-flash", ""), ok: false, error: "model not found", error_class: "infrastructure_or_generation_failure", exclusion_reason: "replay_model_not_found", attempts: 0, attempt_log: [], cost: null, cost_source: null, usage: null, output: null },
      { ...mockReplayResult("xai/grok-4.5", ""), ok: false, error: "model not found", error_class: "infrastructure_or_generation_failure", exclusion_reason: "replay_model_not_found", attempts: 0, attempt_log: [], cost: null, cost_source: null, usage: null, output: null },
    ];
    const allFailedBuilt = R.buildReplayEpisode({
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      replayResults: allFailedResults, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      selectionHash: "s".repeat(64), protocolHash,
    });
    const allFailed = mkCp({
      episode: null,
      replay_material: R.buildReplayMaterial(allFailedResults),
      sidecar: allFailedBuilt.sidecar,
      exclusion: allFailedBuilt.exclusion,
    });
    assert.equal(R.checkpointValid(allFailed, validArgs), true, "all-failed episode=null with empty ledgers must stay legal");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("checkpointValid: replay relabel / no-success+error null rejected — a success claim requires a real accepted success bound to the sidecar hash", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-relabel-"));
  try {
    const src = FIXTURE_EPISODES[0];
    const srcMeta = FIXTURE_META[0];
    const contentHash = C.episodeContentHash(src);
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    const protocolHash = R.buildReplayProtocolHash({
      selectionHash: "s".repeat(64),
      sourceContentHash: contentHash,
      models,
      thinking: "high",
      maxOutputBytes: 200_000,
      maxEpisodeBytes: 1_000_000,
      timeoutMs: 600_000,
      maxRetries: 2,
    });
    const results = [
      mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
      mockReplayResult("xai/grok-4.5", "Replay answer two."),
    ];
    const built = R.buildReplayEpisode({
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      replayResults: results,
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      selectionHash: "s".repeat(64), protocolHash,
    });
    const mkCp = (overrides = {}) => ({
      ledger_version: C.ATTEMPT_LEDGER_VERSION,
      schema_version: R.REPLAY_SCHEMA_VERSION,
      source_episode_id: src.episode_id,
      source_content_hash: contentHash,
      source_thinking: src.thinking_level ?? null,
      replay_thinking: "high",
      selection_hash: "s".repeat(64),
      protocol_hash: protocolHash,
      experiment_mode: null,
      history_excluded: false,
      replay_models: models,
      replay_material: R.buildReplayMaterial(results),
      episode: built.episode,
      sidecar: JSON.parse(JSON.stringify(built.sidecar)),
      exclusion: built.exclusion,
      built_at: new Date().toISOString(),
      ...overrides,
    });
    const validArgs = {
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      contentHash, models, protocolHash, selectionHash: "s".repeat(64),
    };
    const slot = (cp) => cp.sidecar.slots.find((s) => s.source?.kind === "replay");
    // 1. No-success + error null: relabel a failed slot as success
    // (replay.error=null) while the ledger has NO success entry → rejected.
    const noSuccess = mkCp();
    const s1 = slot(noSuccess);
    s1.replay.attempt_log[0].ok = false;
    s1.replay.attempt_log[0].error = "boom";
    s1.replay.attempt_log[0].error_class = "content";
    s1.replay.attempt_log[0].accepted_output_hash = null;
    s1.replay.error = null;
    s1.replay.accepted_output_hash = null;
    assert.equal(R.checkpointValid(noSuccess, validArgs), false, "replay.error=null with no success entry must be rejected");
    // 2. Relabel: replay.error=null with a success entry but the sidecar
    // accepted_output_hash does not equal the ledger's latest success hash →
    // rejected (the body binding is broken).
    const wrongHash = mkCp();
    slot(wrongHash).replay.accepted_output_hash = "0".repeat(64);
    assert.equal(R.checkpointValid(wrongHash, validArgs), false, "sidecar accepted_output_hash must equal the latest ledger success hash");
    // 3. Relabel: replay.error=null but the LAST ledger entry is a failure
    // (a success earlier, a failure later) → rejected (the accepted success
    // must be the latest entry).
    const lastFailed = mkCp();
    const s3 = slot(lastFailed);
    s3.replay.attempt_log.push({ attempt: 1, request_id: "req-last-fail", model_ref: s3.model, operation: "t0_replay_answer", ok: false, error: "boom", error_class: "content", accepted_output_hash: null, usage: null, cost: null, cost_source: null });
    s3.replay.attempts = 2;
    s3.replay.error = null;
    assert.equal(R.checkpointValid(lastFailed, validArgs), false, "replay.error=null requires the LAST entry to be the accepted success");
    // 4. A postprocess failure (successful provider entry + hash, but
    // replay.error non-null) stays legal — the provider call was real. The
    // failure state is DERIVED from the material: the raw output carries an
    // ambiguous identity token (M3), so the contextual rebuild reproduces
    // the same in_body=false / error non-null slot.
    const postFailResults = [
      mockReplayResult("deepseek/deepseek-v4-flash", "The M3 evaluation criteria are unclear."),
      mockReplayResult("xai/grok-4.5", "Replay answer two."),
    ];
    const postFailBuilt = R.buildReplayEpisode({
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      replayResults: postFailResults, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      selectionHash: "s".repeat(64), protocolHash,
    });
    const postFail = mkCp({
      replay_material: R.buildReplayMaterial(postFailResults),
      episode: postFailBuilt.episode,
      sidecar: postFailBuilt.sidecar,
      exclusion: postFailBuilt.exclusion,
    });
    const s4 = slot(postFail);
    assert.equal(s4.in_body, false, "ambiguous raw output must exclude the slot from the body");
    assert.equal(s4.exclusion_reason, "replay_ambiguous_identity_token");
    assert.equal(R.checkpointValid(postFail, validArgs), true, "postprocess failure keeps the real provider success + hash while replay.error stays non-null");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("cumulative scan: a hash-matching but ledger-forged checkpoint is never admitted (scanValidCheckpoints); legal checkpoints are", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-scan-"));
  try {
    const srcA = FIXTURE_EPISODES[0];
    const srcB = FIXTURE_EPISODES[1];
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    const mkProtocol = (src) => R.buildReplayProtocolHash({
      selectionHash: "s".repeat(64),
      sourceContentHash: C.episodeContentHash(src),
      models,
      thinking: "high",
      maxOutputBytes: 200_000,
      maxEpisodeBytes: 1_000_000,
      timeoutMs: 600_000,
      maxRetries: 2,
    });
    const mkCp = (src, srcMeta) => {
      const contentHash = C.episodeContentHash(src);
      const protocolHash = mkProtocol(src);
      const results = [
        mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one.", { thinking: src.thinking_level ?? "high" }),
        mockReplayResult("xai/grok-4.5", "Replay answer two.", { thinking: src.thinking_level ?? "high" }),
      ];
      // Per-source request_ids so the cumulative directory never contains a
      // cross-checkpoint duplicate (the scan rejects those).
      results[0].attempt_log[0].request_id = `req-${src.episode_id}-flash`;
      results[1].attempt_log[0].request_id = `req-${src.episode_id}-grok`;
      const built = R.buildReplayEpisode({
        sourceEpisode: src, sourceMeta: srcMeta, blindKey,
        replayResults: results,
        corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
        selectionHash: "s".repeat(64), protocolHash,
      });
      return {
        cp: {
          ledger_version: C.ATTEMPT_LEDGER_VERSION,
          schema_version: R.REPLAY_SCHEMA_VERSION,
          source_episode_id: src.episode_id,
          source_content_hash: contentHash,
          source_thinking: src.thinking_level ?? null,
          replay_thinking: src.thinking_level ?? "high",
          selection_hash: "s".repeat(64),
          protocol_hash: protocolHash,
          experiment_mode: null,
          history_excluded: false,
          replay_models: models,
          replay_material: R.buildReplayMaterial(results),
          episode: built.episode,
          sidecar: built.sidecar,
          exclusion: built.exclusion,
          built_at: new Date().toISOString(),
        },
        contentHash,
        protocolHash,
      };
    };
    const blindKey = "k".repeat(64);
    const a = mkCp(srcA, FIXTURE_META[0]);
    const b = mkCp(srcB, FIXTURE_META[1]);
    const checkpointsDir = path.join(tmp, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const writeCp = (src, cp) => {
      const id = R.buildReplayEpisodeId(blindKey, src.episode_id, models);
      fs.writeFileSync(path.join(checkpointsDir, `${id}.json`), `${JSON.stringify(cp, null, 2)}\n`);
    };
    writeCp(srcA, a.cp);
    writeCp(srcB, b.cp);
    const selectedBySourceId = new Map([
      [srcA.episode_id, { sourceEpisode: srcA, sourceMeta: FIXTURE_META[0], source_content_hash: a.contentHash }],
      [srcB.episode_id, { sourceEpisode: srcB, sourceMeta: FIXTURE_META[1], source_content_hash: b.contentHash }],
    ]);
    const expectedProtocolBySource = new Map([
      [srcA.episode_id, a.protocolHash],
      [srcB.episode_id, b.protocolHash],
    ]);
    const scanArgs = {
      selectedBySourceId, expectedProtocolBySource, models, selectionHash: "s".repeat(64),
      blindKey, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    };
    // Both legal → both admitted.
    let admitted = R.scanValidCheckpoints(checkpointsDir, scanArgs);
    assert.equal(admitted.length, 2, "legal checkpoints must be admitted");
    // Forge B's ledger (remove request_id from the SIDECAR) while ALL hashes
    // still match → the scan must FAIL CLOSED (throw), never silently skip.
    const bFile = path.join(checkpointsDir, `${R.buildReplayEpisodeId(blindKey, srcB.episode_id, models)}.json`);
    const forged = JSON.parse(fs.readFileSync(bFile, "utf8"));
    delete forged.sidecar.slots.find((s) => s.source?.kind === "replay").replay.attempt_log[0].request_id;
    fs.writeFileSync(bFile, `${JSON.stringify(forged, null, 2)}\n`);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /invalid checkpoint|request_id/, "forged checkpoint must fail the scan closed");
    // Old-format (no ledger_version) with matching hashes → fail closed too.
    const oldFmt = JSON.parse(fs.readFileSync(bFile, "utf8"));
    delete oldFmt.ledger_version;
    fs.writeFileSync(bFile, `${JSON.stringify(oldFmt, null, 2)}\n`);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /invalid checkpoint|ledger_version/, "old-format checkpoint must fail the scan closed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("cumulative build: a hash-matching but ledger-forged checkpoint never enters episodes/meta/stats (full buildReplay run)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-build-scan-"));
  try {
    // Temp corpus: FIX_R1 + FIX_R2 (both legacy hard-pass).
    const episodesPath = path.join(tmp, "episodes.jsonl");
    const metaPath = path.join(tmp, "episodes.meta.jsonl");
    const exclusionsPath = path.join(tmp, "exclusions.jsonl");
    const statsPath = path.join(tmp, "stats.json");
    fs.writeFileSync(episodesPath, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(metaPath, [FIXTURE_META[0], FIXTURE_META[1]].map((m) => JSON.stringify(m)).join("\n") + "\n");
    fs.writeFileSync(exclusionsPath, "");
    fs.writeFileSync(statsPath, `${JSON.stringify(producerStats([FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]], []), null, 2)}\n`);
    const registryPath = path.join(tmp, "registry.json");
    fs.writeFileSync(registryPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    const outDir = path.join(tmp, "out");
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    // Deterministic blind key via --seed so the pre-created checkpoints match
    // the ids buildReplay resolves.
    const blind = resolveBlindKey(outDir, { seed: "scan-test" });
    const mkProtocol = (src) => R.buildReplayProtocolHash({
      selectionHash: "legacy",
      sourceContentHash: C.episodeContentHash(src),
      models,
      thinking: src.thinking_level ?? "high",
      maxOutputBytes: 200_000,
      maxEpisodeBytes: 1_000_000,
      timeoutMs: 600_000,
      maxRetries: 2,
    });
    const checkpointsDir = path.join(outDir, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    for (const [i, src] of [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].entries()) {
      const srcMeta = FIXTURE_META[i];
      const contentHash = C.episodeContentHash(src);
      const protocolHash = mkProtocol(src);
      const results = [
        mockReplayResult("deepseek/deepseek-v4-flash", `Replay answer ${i} one.`, { thinking: src.thinking_level ?? "high" }),
        mockReplayResult("xai/grok-4.5", `Replay answer ${i} two.`, { thinking: src.thinking_level ?? "high" }),
      ];
      // Per-source request_ids so the cumulative directory never contains a
      // cross-checkpoint duplicate (the scan rejects those).
      results[0].attempt_log[0].request_id = `req-${src.episode_id}-flash`;
      results[1].attempt_log[0].request_id = `req-${src.episode_id}-grok`;
      const built = R.buildReplayEpisode({
        sourceEpisode: src, sourceMeta: srcMeta, blindKey: blind.key,
        replayResults: results,
        corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
        selectionHash: null, protocolHash,
      });
      const replayEpisodeId = R.buildReplayEpisodeId(blind.key, src.episode_id, models);
      fs.writeFileSync(path.join(checkpointsDir, `${replayEpisodeId}.json`), `${JSON.stringify({
        ledger_version: C.ATTEMPT_LEDGER_VERSION,
        schema_version: R.REPLAY_SCHEMA_VERSION,
        source_episode_id: src.episode_id,
        source_content_hash: contentHash,
        source_thinking: src.thinking_level ?? null,
        replay_thinking: src.thinking_level ?? "high",
        selection_hash: null,
        protocol_hash: protocolHash,
        experiment_mode: null,
        history_excluded: false,
        replay_models: models,
        replay_material: R.buildReplayMaterial(results),
        episode: built.episode,
        sidecar: built.sidecar,
        exclusion: built.exclusion,
        built_at: new Date().toISOString(),
      }, null, 2)}\n`);
    }
    const options = R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      "models-json": registryPath, output: outDir, "allow-legacy-select": true, quiet: true, seed: "scan-test",
    });
    // Run 1: both checkpoints valid → both skipped → both episodes in output.
    const run1 = await R.buildReplay(options);
    assert.equal(run1.episodes.length, 2, "both legal checkpoints enter output");
    // Forge the second checkpoint's ledger (remove request_id) — ALL hashes
    // still match the expected contentHash/protocol/selection.
    const forgedFile = fs.readdirSync(checkpointsDir).filter((n) => n.endsWith(".json")).find((n) => {
      const cp = JSON.parse(fs.readFileSync(path.join(checkpointsDir, n), "utf8"));
      return cp.source_episode_id === FIXTURE_EPISODES[1].episode_id;
    });
    const forged = JSON.parse(fs.readFileSync(path.join(checkpointsDir, forgedFile), "utf8"));
    delete forged.sidecar.slots.find((s) => s.source?.kind === "replay").replay.attempt_log[0].request_id;
    fs.writeFileSync(path.join(checkpointsDir, forgedFile), `${JSON.stringify(forged, null, 2)}\n`);
    // Run 2: the forged checkpoint fails checkpointValid → the PRE-SCAN
    // (before any invoker/provider work) fails closed and the whole run
    // throws — the forged episode can never enter episodes.jsonl / stats,
    // and no provider request is ever made.
    let run2Failed = false;
    let run2Msg = "";
    try {
      await R.buildReplay(options);
    } catch (err) {
      run2Failed = true;
      run2Msg = err.message;
    }
    assert.ok(run2Failed, "forged checkpoint must fail the run closed at the pre-scan");
    assert.match(run2Msg, /invalid checkpoint|request_id/, "pre-scan must report the forged checkpoint");
    // The output files from run 1 are untouched (run 2 never wrote).
    const stats2 = JSON.parse(fs.readFileSync(path.join(outDir, "stats.json"), "utf8"));
    assert.equal(stats2.episodes.count, 2, "run 1 stats must be untouched (run 2 failed before writing)");
    const outEpisodes = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(outEpisodes.length, 2, "run 1 episodes.jsonl must be untouched");
    // The blind key is persisted only AFTER the pre-scan passes: run 1
    // (clean pre-scan) wrote it, run 2 (forged checkpoint) must leave it
    // byte-identical — the reused-key path never rewrites the file.
    const blindKeyFile = path.join(outDir, "blind-key.json");
    assert.ok(fs.existsSync(blindKeyFile), "blind-key.json must be written after the pre-scan passes (run 1)");
    const blindKeyBefore = fs.readFileSync(blindKeyFile, "utf8");
    assert.equal(fs.readFileSync(blindKeyFile, "utf8"), blindKeyBefore, "blind-key.json must be unchanged when the pre-scan fails (run 2)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("pre-scan: a bad checkpoint in the existing checkpoints dir fails the run BEFORE makeJudgeInvoker (zero provider-adjacent work)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-prescan-"));
  try {
    const episodesPath = path.join(tmp, "episodes.jsonl");
    const metaPath = path.join(tmp, "episodes.meta.jsonl");
    const exclusionsPath = path.join(tmp, "exclusions.jsonl");
    const statsPath = path.join(tmp, "stats.json");
    fs.writeFileSync(episodesPath, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(metaPath, [FIXTURE_META[0], FIXTURE_META[1]].map((m) => JSON.stringify(m)).join("\n") + "\n");
    fs.writeFileSync(exclusionsPath, "");
    fs.writeFileSync(statsPath, `${JSON.stringify(producerStats([FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]], []), null, 2)}\n`);
    const outDir = path.join(tmp, "out");
    const checkpointsDir = path.join(outDir, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    // A malformed checkpoint in the EXISTING dir.
    fs.writeFileSync(path.join(checkpointsDir, "garbage.json"), "{not json");
    // models-json points at a NONEXISTENT file: if makeJudgeInvoker were
    // reached, it would throw an ENOENT mentioning this path. The pre-scan
    // must fail FIRST with the checkpoint error — proving zero
    // makeJudgeInvoker / provider-adjacent work.
    const missingRegistry = path.join(tmp, "no-such-registry.json");
    const options = R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      "models-json": missingRegistry, output: outDir, "allow-legacy-select": true, quiet: true, seed: "prescan-test",
    });
    let failed = false;
    let msg = "";
    try {
      await R.buildReplay(options);
    } catch (err) {
      failed = true;
      msg = err.message;
    }
    assert.ok(failed, "a bad checkpoint must fail the run closed at the pre-scan");
    assert.match(msg, /malformed/, "the pre-scan must report the malformed checkpoint");
    assert.ok(!msg.includes("no-such-registry.json"), "makeJudgeInvoker must never be reached (pre-scan fails first)");
    // No output files were written.
    assert.ok(!fs.existsSync(path.join(outDir, "episodes.jsonl")), "no output may be written when the pre-scan fails");
    // The blind key must NOT be persisted before the pre-scan: a bad
    // checkpoint leaves no blind-key.json behind (zero provider-adjacent
    // work AND zero blind-key write).
    assert.ok(!fs.existsSync(path.join(outDir, "blind-key.json")), "blind-key.json must not be created when the pre-scan fails");
    // A pre-existing blind-key.json (reused key) must also be left UNCHANGED
    // when the pre-scan fails — the reused-key path never rewrites the file.
    const reusedDir = path.join(tmp, "out-reused");
    const reusedCheckpoints = path.join(reusedDir, "checkpoints");
    fs.mkdirSync(reusedCheckpoints, { recursive: true });
    fs.writeFileSync(path.join(reusedCheckpoints, "garbage.json"), "{not json");
    const reusedKeyFile = path.join(reusedDir, "blind-key.json");
    const reusedKey = "ab".repeat(32);
    const reusedKeyContent = `${JSON.stringify({ schema_version: 1, blind_key: reusedKey, source: "generated" }, null, 2)}\n`;
    fs.writeFileSync(reusedKeyFile, reusedKeyContent);
    const reusedOptions = R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      "models-json": missingRegistry, output: reusedDir, "allow-legacy-select": true, quiet: true,
    });
    let reusedFailed = false;
    try {
      await R.buildReplay(reusedOptions);
    } catch (err) {
      reusedFailed = true;
    }
    assert.ok(reusedFailed, "a bad checkpoint must fail the run closed at the pre-scan (reused-key dir)");
    assert.equal(
      fs.readFileSync(reusedKeyFile, "utf8"),
      reusedKeyContent,
      "blind-key.json must be byte-identical when the pre-scan fails (reused key never rewritten)",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("REPLAY_REDACTOR_ID bumped v5→v6: protocol hash changes and the constant is v6 (shared alnum-context boundary + run/residual + empty-universe defense + fixed oracle rejection error); old v5 checkpoints are stale", () => {
  assert.equal(R.REPLAY_REDACTOR_ID, "episode-local-v6", "redactor id must be bumped to v6 (shared alnum-context boundary for known tokens / run ids / residuals, case-insensitive session ids, empty-universe defense, fixed oracle rejection sidecar error)");
  assert.equal(R.REPLAY_ORACLE_REJECTION_ERROR, "oracle content rejection", "the slot-level oracle rejection sidecar error must be the fixed protocol-stable string");
  assert.equal(R.REPLAY_SOURCE_ORACLE_REJECTION_ERROR, "source oracle content rejection", "the source-preflight oracle rejection public exclusion detail must be the fixed protocol-stable string");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /^t0-replay-dataset-producer-v2:/, "the dataset producer contract id must be the v2 nullable-cost binding increment");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /hard-gates/, "producer contract id must bind the hard gates");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /source-oracle-v6/, "producer contract id must bind the source-oracle-v6 preflight");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /canonical-renderer/, "producer contract id must bind the canonical renderer");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /readme-stats-schema/, "producer contract id must bind the README/stats schema");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /fixed-source-error/, "producer contract id must bind the fixed source-oracle rejection payload");
  assert.match(R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, /nullable-cost/, "producer contract id must bind the v2 nullable-cost public stats contract");
  const base = {
    selectionHash: "s".repeat(64),
    sourceContentHash: "c".repeat(64),
    models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
    thinking: "high",
    maxOutputBytes: 200_000,
    maxEpisodeBytes: 1_000_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  };
  const hV6 = R.buildReplayProtocolHash(base);
  const hV5 = R.buildReplayProtocolHash({ ...base, redactorId: "episode-local-v5" });
  assert.notEqual(hV6, hV5, "redactor v5→v6 must change the protocol hash (old v5 checkpoints invalidated)");
  // Default binds the current v6 constant.
  assert.equal(R.buildReplayProtocolHash({ ...base, redactorId: R.REPLAY_REDACTOR_ID }), hV6);
  // The ledger contract id (request-id + model-ref + operation +
  // accepted-output binding) is bound into the replay protocol hash too: a
  // pre-binding checkpoint carries a different protocol_hash and is stale.
  assert.equal(C.ATTEMPT_LEDGER_VERSION, 2, "the version is NOT bumped — the contract id marks the binding increment");
  assert.match(C.ATTEMPT_LEDGER_CONTRACT_ID, /request-id.*model-ref.*operation.*accepted-output/i);
  // The replay checkpoint contract id (raw-output material + contextual
  // rebuild) is bound into the protocol hash as well — old material-less
  // checkpoints carry a different protocol_hash and are stale, WITHOUT a
  // ledger v3 bump.
  assert.equal(R.REPLAY_CHECKPOINT_CONTRACT_ID, "t0-replay-checkpoint-v1:raw-output-material+contextual-rebuild");
  assert.notEqual(R.buildReplayProtocolHash({ ...base, replayCheckpointContractId: "t0-replay-checkpoint-v0" }), hV6, "the replay checkpoint contract id must be bound into the protocol hash (old material-less checkpoints are stale)");
  assert.match(hV6, /^[0-9a-f]{64}$/);
});

// ── replay material + contextual validation (malicious) ──────────────────

/** Build a legal material-carrying checkpoint + its contextual validArgs. */
function mkValidCp(overrides = {}) {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const contentHash = C.episodeContentHash(src);
  const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
  const protocolHash = R.buildReplayProtocolHash({
    selectionHash: "s".repeat(64),
    sourceContentHash: contentHash,
    models,
    thinking: "high",
    maxOutputBytes: 200_000,
    maxEpisodeBytes: 1_000_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  });
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    selectionHash: "s".repeat(64), protocolHash,
  });
  const cp = {
    ledger_version: C.ATTEMPT_LEDGER_VERSION,
    schema_version: R.REPLAY_SCHEMA_VERSION,
    source_episode_id: src.episode_id,
    source_content_hash: contentHash,
    source_thinking: src.thinking_level ?? null,
    replay_thinking: "high",
    selection_hash: "s".repeat(64),
    protocol_hash: protocolHash,
    experiment_mode: null,
    history_excluded: false,
    replay_models: models,
    replay_material: R.buildReplayMaterial(results),
    episode: built.episode,
    sidecar: built.sidecar,
    exclusion: built.exclusion,
    built_at: new Date().toISOString(),
    ...overrides,
  };
  return {
    cp,
    validArgs: {
      sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
      contentHash, models, protocolHash, selectionHash: "s".repeat(64),
    },
  };
}

await check("replay material: buildReplayMaterial round-trips through buildReplayEpisode (exact rebuild)", () => {
  const { cp, validArgs } = mkValidCp();
  assert.equal(R.checkpointValid(cp, validArgs), true, "legal material-carrying checkpoint must be valid");
  // The material is exactly the minimal snapshot the producer needs: rebuild
  // from the material alone (mapped back via materialToReplayResults)
  // reproduces the public surfaces byte-for-byte.
  const rebuilt = R.buildReplayEpisode({
    sourceEpisode: validArgs.sourceEpisode,
    sourceMeta: validArgs.sourceMeta,
    blindKey: validArgs.blindKey,
    replayResults: R.materialToReplayResults(cp.replay_material),
    corpusModelNames: validArgs.corpusModelNames,
    options: validArgs.options,
    selectionHash: validArgs.selectionHash,
    protocolHash: validArgs.protocolHash,
    thinkingOverride: "high",
  });
  assert.equal(JSON.stringify(rebuilt.episode), JSON.stringify(cp.episode));
  assert.equal(JSON.stringify(rebuilt.sidecar), JSON.stringify(cp.sidecar));
  assert.equal(JSON.stringify(rebuilt.exclusion), JSON.stringify(cp.exclusion));
  // One material entry per model, order strictly matching models.
  assert.deepEqual(cp.replay_material.map((m) => m.model), validArgs.models);
  // The raw accepted output lives ONLY in the material under the private
  // key `raw_accepted_output` (never in the public surfaces).
  for (const m of cp.replay_material) {
    assert.equal(typeof m.raw_accepted_output, "string");
    assert.ok(!("output" in m), "material must not carry a public `output` key (raw_accepted_output is the private name)");
    assert.ok(!JSON.stringify(cp.sidecar).includes(m.raw_accepted_output), "raw output must not appear in the sidecar");
  }
});

await check("checkpointValid: body-only tamper rejected (raw output binding)", () => {
  const { cp, validArgs } = mkValidCp();
  const tampered = JSON.parse(JSON.stringify(cp));
  const flashBodySlot = tampered.episode.slots.find((s) => s.output === "Replay answer one.");
  assert.ok(flashBodySlot, "the flash replay output must be in the body");
  flashBodySlot.output = "TAMPERED BODY OUTPUT";
  assert.equal(R.checkpointValid(tampered, validArgs), false, "body-only tamper must be rejected (the body must be rebuilt from the material)");
});

await check("checkpointValid: body+sidecar sync tamper rejected (material is the binding surface)", () => {
  const { cp, validArgs } = mkValidCp();
  const sync = JSON.parse(JSON.stringify(cp));
  const newOutput = "TAMPERED SYNC OUTPUT";
  const flashBodySlot = sync.episode.slots.find((s) => s.output === "Replay answer one.");
  assert.ok(flashBodySlot);
  flashBodySlot.output = newOutput;
  // Sync-tamper the sidecar slot + ledger hash to match the new body output
  // — the OLD validator (internal hash consistency only) would pass this;
  // the contextual rebuild from the untouched material reproduces the
  // original surfaces and rejects it.
  const flashSlot = sync.sidecar.slots.find((s) => s.source?.kind === "replay" && s.model === "deepseek/deepseek-v4-flash");
  flashSlot.replay.accepted_output_hash = C.sha256Hex(newOutput);
  flashSlot.replay.attempt_log[0].accepted_output_hash = C.sha256Hex(newOutput);
  assert.equal(R.checkpointValid(sync, validArgs), false, "body+sidecar sync tamper must be rejected (the material still binds the original raw output)");
});

await check("checkpointValid: source/historical prompt/output/meta mapping tamper rejected", () => {
  // (a) Source prompt changed (content hash updated too) → the top-level
  // source_content_hash binding rejects it.
  const a = mkValidCp();
  const srcA = JSON.parse(JSON.stringify(FIXTURE_EPISODES[0]));
  srcA.prompt = "A DIFFERENT source prompt.";
  assert.equal(R.checkpointValid(a.cp, { ...a.validArgs, sourceEpisode: srcA, contentHash: C.episodeContentHash(srcA) }), false, "source prompt tamper must be rejected (source_content_hash binding)");
  // (b) Historical slot output changed in the source (content hash NOT
  // updated) → the contextual rebuild from the real source produces a
  // different body → rejected.
  const b = mkValidCp();
  const srcB = JSON.parse(JSON.stringify(FIXTURE_EPISODES[0]));
  srcB.slots[0].output = "TAMPERED HISTORICAL OUTPUT";
  assert.equal(R.checkpointValid(b.cp, { ...b.validArgs, sourceEpisode: srcB }), false, "historical output tamper must be rejected (the body is rebuilt from the source)");
  // (c) Source meta tamper (historical slot model changed — meta is NOT part
  // of the content hash) → the rebuilt sidecar differs → rejected.
  const c = mkValidCp();
  const metaC = JSON.parse(JSON.stringify(FIXTURE_META[0]));
  metaC.slots[0].model = "openai/gpt-5.6-sol";
  assert.equal(R.checkpointValid(c.cp, { ...c.validArgs, sourceMeta: metaC }), false, "source meta tamper must be rejected (the sidecar is rebuilt from the meta)");
});

await check("checkpointValid: forged raw output/hash in material rejected", () => {
  const { cp, validArgs } = mkValidCp();
  const forged = JSON.parse(JSON.stringify(cp));
  forged.replay_material[0].raw_accepted_output = "FORGED RAW OUTPUT";
  assert.equal(R.checkpointValid(forged, validArgs), false, "forged raw output must be rejected (the success hash is recomputed from the raw output)");
  // Forging the ledger hash to match the forged output but leaving the body
  // untouched → the rebuild from the forged material produces a different
  // body → rejected.
  const forged2 = JSON.parse(JSON.stringify(cp));
  forged2.replay_material[0].raw_accepted_output = "FORGED RAW OUTPUT";
  forged2.replay_material[0].attempt_log[0].accepted_output_hash = C.sha256Hex("FORGED RAW OUTPUT");
  assert.equal(R.checkpointValid(forged2, validArgs), false, "forged raw output + hash must be rejected (the body no longer matches the material)");
});

await check("checkpointValid: missing material (old checkpoint) rejected", () => {
  const { cp, validArgs } = mkValidCp();
  delete cp.replay_material;
  assert.equal(R.checkpointValid(cp, validArgs), false, "old material-less checkpoint must be rejected");
  // A material with the wrong model order / count is rejected too.
  const wrongOrder = mkValidCp();
  wrongOrder.cp.replay_material = [wrongOrder.cp.replay_material[1], wrongOrder.cp.replay_material[0]];
  assert.equal(R.checkpointValid(wrongOrder.cp, wrongOrder.validArgs), false, "material order must match models exactly");
  const wrongCount = mkValidCp();
  wrongCount.cp.replay_material = [wrongCount.cp.replay_material[0]];
  assert.equal(R.checkpointValid(wrongCount.cp, wrongCount.validArgs), false, "each model must have exactly one material entry");
});

await check("checkpointValid: material exact key set — extra/missing keys rejected", () => {
  const { cp, validArgs } = mkValidCp();
  // Extra key on a material entry → rejected (a closed serialization contract).
  const extra = JSON.parse(JSON.stringify(cp));
  extra.replay_material[0].smuggled = "x";
  assert.equal(R.checkpointValid(extra, validArgs), false, "extra material key must be rejected");
  // Missing key on a material entry → rejected.
  const missing = JSON.parse(JSON.stringify(cp));
  delete missing.replay_material[0].raw_accepted_output;
  assert.equal(R.checkpointValid(missing, validArgs), false, "missing material key must be rejected");
  // Top-level extra key → rejected.
  const topExtra = JSON.parse(JSON.stringify(cp));
  topExtra.smuggled = "x";
  assert.equal(R.checkpointValid(topExtra, validArgs), false, "extra top-level key must be rejected");
  // Top-level missing key → rejected.
  const topMissing = JSON.parse(JSON.stringify(cp));
  delete topMissing.built_at;
  assert.equal(R.checkpointValid(topMissing, validArgs), false, "missing top-level key must be rejected");
  // built_at not a valid ISO timestamp → rejected.
  const badBuiltAt = JSON.parse(JSON.stringify(cp));
  badBuiltAt.built_at = "not-a-timestamp";
  assert.equal(R.checkpointValid(badBuiltAt, validArgs), false, "invalid built_at must be rejected");
  // built_at parseable but NOT canonical (new Date().toISOString() form) → rejected.
  const nonCanonicalBuiltAt = JSON.parse(JSON.stringify(cp));
  nonCanonicalBuiltAt.built_at = "2026-08-13T22:00:00Z";
  assert.equal(R.checkpointValid(nonCanonicalBuiltAt, validArgs), false, "non-canonical (Date.parse-acceptable) built_at must be rejected");
});

await check("checkpointValid: context self-binding — contentHash/sourceMeta/models/corpus sync forgery rejected", () => {
  const { cp, validArgs } = mkValidCp();
  // contentHash that does not match the real source episode (caller + source
  // swapped together) → rejected.
  const srcX = JSON.parse(JSON.stringify(FIXTURE_EPISODES[0]));
  srcX.prompt = "A DIFFERENT source prompt.";
  assert.equal(R.checkpointValid(cp, { ...validArgs, sourceEpisode: srcX, contentHash: C.episodeContentHash(srcX) }), false, "contentHash must equal episodeContentHash(sourceEpisode)");
  // sourceMeta whose episode_id does not match the source episode → rejected.
  const metaX = JSON.parse(JSON.stringify(FIXTURE_META[1]));
  assert.equal(R.checkpointValid(cp, { ...validArgs, sourceMeta: metaX }), false, "sourceMeta.episode_id must equal sourceEpisode.episode_id");
  // models with duplicates → rejected.
  assert.equal(R.checkpointValid(cp, { ...validArgs, models: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash"] }), false, "duplicate models must be rejected");
  // models not equal to options.models → rejected.
  assert.equal(R.checkpointValid(cp, { ...validArgs, models: ["xai/grok-4.5", "deepseek/deepseek-v4-flash"] }), false, "models must equal options.models exactly");
  // corpusModelNames not a string array → rejected.
  assert.equal(R.checkpointValid(cp, { ...validArgs, corpusModelNames: [123] }), false, "corpusModelNames must be a string array");
});

await check("checkpointValid: thinking sync tamper rejected (material thinking must equal resolveReplayThinking)", () => {
  const { cp, validArgs } = mkValidCp();
  // Sync-tamper: material thinking + top-level replay_thinking + sidecar
  // replay_thinking all rewritten to a different level — the material
  // thinking binding rejects it (the expected policy cannot be bypassed).
  const sync = JSON.parse(JSON.stringify(cp));
  for (const m of sync.replay_material) m.thinking = "medium";
  sync.replay_thinking = "medium";
  for (const s of sync.sidecar.slots) {
    if (s.source?.kind === "replay") s.replay.thinking = "medium";
  }
  assert.equal(R.checkpointValid(sync, validArgs), false, "material+sidecar thinking sync tamper must be rejected");
});

await check("checkpointValid: ok=true ledger closure — exactly one success, the LAST entry", () => {
  const { cp, validArgs } = mkValidCp();
  // Two successes in the ledger → rejected.
  const twoSuccess = JSON.parse(JSON.stringify(cp));
  const m0 = twoSuccess.replay_material[0];
  m0.attempt_log.push({ ...m0.attempt_log[0], attempt: 1, request_id: "req-extra-success" });
  m0.attempts = 2;
  m0.cost = 0.002;
  m0.cost_source = "provider";
  assert.equal(R.checkpointValid(twoSuccess, validArgs), false, "multiple ok=true ledger entries must be rejected");
  // Success NOT last (a later failure) → rejected.
  const successNotLast = JSON.parse(JSON.stringify(cp));
  const m1 = successNotLast.replay_material[0];
  m1.attempt_log.push({ attempt: 1, request_id: "req-later-fail", model_ref: m1.model, operation: "t0_replay_answer", ok: false, error: "boom", error_class: "content", accepted_output_hash: null, usage: null, cost: null, cost_source: null });
  m1.attempts = 2;
  m1.error = "boom";
  m1.error_class = "content";
  m1.exclusion_reason = "replay_call_failed";
  assert.equal(R.checkpointValid(successNotLast, validArgs), false, "a success followed by a later failure must be rejected");
});

await check("checkpointValid: ok=false ledger closure — no success entries; error/error_class/exclusion derived from the LAST entry", () => {
  const { cp, validArgs } = mkValidCp();
  // Failed material whose ledger carries an ok=true entry → rejected.
  const failedWithSuccess = JSON.parse(JSON.stringify(cp));
  failedWithSuccess.replay_material[0].ok = false;
  failedWithSuccess.replay_material[0].raw_accepted_output = null;
  failedWithSuccess.replay_material[0].error = "boom";
  failedWithSuccess.replay_material[0].error_class = "content";
  failedWithSuccess.replay_material[0].exclusion_reason = "replay_call_failed";
  assert.equal(R.checkpointValid(failedWithSuccess, validArgs), false, "ok=false material with an ok=true ledger entry must be rejected");
  // m.error must equal the LAST ledger entry's error → rejected when not.
  const badError = JSON.parse(JSON.stringify(cp));
  const m2 = badError.replay_material[0];
  m2.ok = false;
  m2.raw_accepted_output = null;
  m2.error = "DIFFERENT error";
  m2.error_class = "content";
  m2.exclusion_reason = "replay_call_failed";
  m2.attempt_log[0].ok = false;
  m2.attempt_log[0].error = "real error";
  m2.attempt_log[0].error_class = "content";
  m2.attempt_log[0].accepted_output_hash = null;
  assert.equal(R.checkpointValid(badError, validArgs), false, "m.error must equal the last ledger entry's error");
  // exclusion_reason must follow runReplayAnswer derivation → rejected when not.
  const badExclusion = JSON.parse(JSON.stringify(cp));
  const m3 = badExclusion.replay_material[0];
  m3.ok = false;
  m3.raw_accepted_output = null;
  m3.error = "boom";
  m3.error_class = "content";
  m3.exclusion_reason = "infrastructure_or_generation_failure";
  m3.attempt_log[0].ok = false;
  m3.attempt_log[0].error = "boom";
  m3.attempt_log[0].error_class = "content";
  m3.attempt_log[0].accepted_output_hash = null;
  assert.equal(R.checkpointValid(badExclusion, validArgs), false, "exclusion_reason must be derived from the last error_class (content -> replay_call_failed)");
  // Legal failed material (transport, non-empty ledger) stays valid.
  const legalFail = JSON.parse(JSON.stringify(cp));
  const m4 = legalFail.replay_material[0];
  m4.ok = false;
  m4.raw_accepted_output = null;
  m4.error = "transport timeout";
  m4.error_class = "transport";
  m4.exclusion_reason = "replay_call_failed";
  m4.attempt_log[0].ok = false;
  m4.attempt_log[0].error = "transport timeout";
  m4.attempt_log[0].error_class = "transport";
  m4.attempt_log[0].accepted_output_hash = null;
  // The rebuild must reproduce the same all-failed surfaces.
  const rebuiltFail = R.buildReplayEpisode({
    sourceEpisode: validArgs.sourceEpisode, sourceMeta: validArgs.sourceMeta, blindKey: validArgs.blindKey,
    replayResults: R.materialToReplayResults(legalFail.replay_material),
    corpusModelNames: validArgs.corpusModelNames, options: validArgs.options,
    selectionHash: validArgs.selectionHash, protocolHash: validArgs.protocolHash, thinkingOverride: "high",
  });
  legalFail.episode = rebuiltFail.episode;
  legalFail.sidecar = rebuiltFail.sidecar;
  legalFail.exclusion = rebuiltFail.exclusion;
  assert.equal(R.checkpointValid(legalFail, validArgs), true, "legal failed material (transport, non-empty ledger) must stay valid");
});

await check("checkpointValid: empty-ledger pre-request failure — strict combos only", () => {
  const { cp, validArgs } = mkValidCp();
  const mkPre = (overrides) => {
    const c = JSON.parse(JSON.stringify(cp));
    const m = c.replay_material[0];
    Object.assign(m, {
      ok: false, raw_accepted_output: null, attempts: 0, attempt_log: [],
      cost: null, cost_source: null, usage: null,
      error: "model not found", error_class: "infrastructure_or_generation_failure", exclusion_reason: "replay_model_not_found",
      ...overrides,
    });
    return c;
  };
  // Legal pre-request combos stay valid (rebuild reproduces the surfaces).
  for (const reason of ["replay_model_not_found", "thinking_level_unsupported", "replay_call_failed"]) {
    const c = mkPre({ exclusion_reason: reason });
    const rebuilt = R.buildReplayEpisode({
      sourceEpisode: validArgs.sourceEpisode, sourceMeta: validArgs.sourceMeta, blindKey: validArgs.blindKey,
      replayResults: R.materialToReplayResults(c.replay_material),
      corpusModelNames: validArgs.corpusModelNames, options: validArgs.options,
      selectionHash: validArgs.selectionHash, protocolHash: validArgs.protocolHash, thinkingOverride: "high",
    });
    c.episode = rebuilt.episode;
    c.sidecar = rebuilt.sidecar;
    c.exclusion = rebuilt.exclusion;
    assert.equal(R.checkpointValid(c, validArgs), true, `legal pre-request combo ${reason} must stay valid`);
  }
  // Wrong error_class for an empty ledger → rejected.
  assert.equal(R.checkpointValid(mkPre({ error_class: "content" }), validArgs), false, "empty ledger requires error_class=infrastructure_or_generation_failure");
  // Unknown exclusion_reason for an empty ledger → rejected.
  assert.equal(R.checkpointValid(mkPre({ exclusion_reason: "made_up_reason" }), validArgs), false, "empty ledger requires a legal pre-request exclusion_reason");
  // Non-null cost for an empty ledger → rejected.
  assert.equal(R.checkpointValid(mkPre({ cost: 0.01, cost_source: "provider" }), validArgs), false, "empty ledger requires cost/cost_source null");
});

await check("checkpointValid: calledAt must be a canonical UTC ISO timestamp (new Date().toISOString() form)", () => {
  const { cp, validArgs } = mkValidCp();
  const bad = JSON.parse(JSON.stringify(cp));
  bad.replay_material[0].calledAt = "not-a-timestamp";
  assert.equal(R.checkpointValid(bad, validArgs), false, "invalid calledAt must be rejected");
  // Date.parse-acceptable but non-canonical text → rejected.
  const nonCanonical = JSON.parse(JSON.stringify(cp));
  nonCanonical.replay_material[0].calledAt = "2026-08-13T22:00:00Z";
  assert.equal(R.checkpointValid(nonCanonical, validArgs), false, "non-canonical (Date.parse-acceptable) calledAt must be rejected");
});

await check("checkpointValid: legal raw accepted output EQUAL to the prompt stays valid (no content false positive)", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const contentHash = C.episodeContentHash(src);
  const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
  const protocolHash = R.buildReplayProtocolHash({
    selectionHash: "s".repeat(64),
    sourceContentHash: contentHash,
    models,
    thinking: "high",
    maxOutputBytes: 200_000,
    maxEpisodeBytes: 1_000_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  });
  // The raw accepted output is EXACTLY the source prompt text.
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", src.prompt),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    selectionHash: "s".repeat(64), protocolHash,
  });
  const cp = {
    ledger_version: C.ATTEMPT_LEDGER_VERSION,
    schema_version: R.REPLAY_SCHEMA_VERSION,
    source_episode_id: src.episode_id,
    source_content_hash: contentHash,
    source_thinking: src.thinking_level ?? null,
    replay_thinking: "high",
    selection_hash: "s".repeat(64),
    protocol_hash: protocolHash,
    experiment_mode: null,
    history_excluded: false,
    replay_models: models,
    replay_material: R.buildReplayMaterial(results),
    episode: built.episode,
    sidecar: built.sidecar,
    exclusion: built.exclusion,
    built_at: new Date().toISOString(),
  };
  const validArgs = {
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
    corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    contentHash, models, protocolHash, selectionHash: "s".repeat(64),
  };
  assert.equal(R.checkpointValid(cp, validArgs), true, "a legal answer equal to the prompt must stay valid (content equality is not a leak)");
});

await check("scan: wrong filename / malformed JSON / unknown source / duplicate source / duplicate replay id / cross-checkpoint duplicate request_id all fail closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-scan-fail-"));
  try {
    const blindKey = "k".repeat(64);
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    const mkCp = (src, srcMeta) => {
      const contentHash = C.episodeContentHash(src);
      const protocolHash = R.buildReplayProtocolHash({
        selectionHash: "s".repeat(64),
        sourceContentHash: contentHash,
        models,
        thinking: src.thinking_level ?? "high",
        maxOutputBytes: 200_000,
        maxEpisodeBytes: 1_000_000,
        timeoutMs: 600_000,
        maxRetries: 2,
      });
      const results = [
        mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one.", { thinking: src.thinking_level ?? "high" }),
        mockReplayResult("xai/grok-4.5", "Replay answer two.", { thinking: src.thinking_level ?? "high" }),
      ];
      results[0].attempt_log[0].request_id = `req-${src.episode_id}-flash`;
      results[1].attempt_log[0].request_id = `req-${src.episode_id}-grok`;
      const built = R.buildReplayEpisode({
        sourceEpisode: src, sourceMeta: srcMeta, blindKey,
        replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
        selectionHash: "s".repeat(64), protocolHash,
      });
      return {
        cp: {
          ledger_version: C.ATTEMPT_LEDGER_VERSION,
          schema_version: R.REPLAY_SCHEMA_VERSION,
          source_episode_id: src.episode_id,
          source_content_hash: contentHash,
          source_thinking: src.thinking_level ?? null,
          replay_thinking: src.thinking_level ?? "high",
          selection_hash: "s".repeat(64),
          protocol_hash: protocolHash,
          experiment_mode: null,
          history_excluded: false,
          replay_models: models,
          replay_material: R.buildReplayMaterial(results),
          episode: built.episode,
          sidecar: built.sidecar,
          exclusion: built.exclusion,
          built_at: new Date().toISOString(),
        },
        contentHash,
        protocolHash,
      };
    };
    const a = mkCp(FIXTURE_EPISODES[0], FIXTURE_META[0]);
    const b = mkCp(FIXTURE_EPISODES[1], FIXTURE_META[1]);
    const checkpointsDir = path.join(tmp, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const aId = R.buildReplayEpisodeId(blindKey, FIXTURE_EPISODES[0].episode_id, models);
    const bId = R.buildReplayEpisodeId(blindKey, FIXTURE_EPISODES[1].episode_id, models);
    const writeCp = (name, cp) => fs.writeFileSync(path.join(checkpointsDir, name), `${JSON.stringify(cp, null, 2)}\n`);
    const selectedBySourceId = new Map([
      [FIXTURE_EPISODES[0].episode_id, { sourceEpisode: FIXTURE_EPISODES[0], sourceMeta: FIXTURE_META[0], source_content_hash: a.contentHash }],
      [FIXTURE_EPISODES[1].episode_id, { sourceEpisode: FIXTURE_EPISODES[1], sourceMeta: FIXTURE_META[1], source_content_hash: b.contentHash }],
    ]);
    const expectedProtocolBySource = new Map([
      [FIXTURE_EPISODES[0].episode_id, a.protocolHash],
      [FIXTURE_EPISODES[1].episode_id, b.protocolHash],
    ]);
    const scanArgs = {
      selectedBySourceId, expectedProtocolBySource, models, selectionHash: "s".repeat(64),
      blindKey, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    };
    // Legal baseline: both admitted.
    writeCp(`${aId}.json`, a.cp);
    writeCp(`${bId}.json`, b.cp);
    assert.equal(R.scanValidCheckpoints(checkpointsDir, scanArgs).length, 2, "legal checkpoints must be admitted");
    // 1. Wrong filename: a valid checkpoint under a non-derived name. The
    // scan fails closed either on the filename mismatch or (when the real
    // file was already seen) on the duplicate source id.
    writeCp("rep-wrong-name.json", a.cp);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /duplicate source_episode_id|filename does not match/, "wrong filename must fail closed");
    fs.rmSync(path.join(checkpointsDir, "rep-wrong-name.json"));
    // 2. Malformed JSON (raw bytes, not stringified).
    fs.writeFileSync(path.join(checkpointsDir, "garbage.json"), "{not json");
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /malformed/, "malformed JSON must fail closed");
    fs.rmSync(path.join(checkpointsDir, "garbage.json"));
    // 3. Unknown source.
    const unknown = JSON.parse(JSON.stringify(a.cp));
    unknown.source_episode_id = "ep-ffffffffffffffff";
    writeCp("rep-unknown.json", unknown);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /unknown source/, "unknown source must fail closed");
    fs.rmSync(path.join(checkpointsDir, "rep-unknown.json"));
    // 4. Duplicate source id: a second file for the same source (wrong name).
    writeCp("rep-dup-source.json", a.cp);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /duplicate source_episode_id|filename does not match/, "duplicate source id must fail closed");
    fs.rmSync(path.join(checkpointsDir, "rep-dup-source.json"));
    // 5. Duplicate replay episode id: two different sources, same sidecar id.
    // The forged checkpoint is inherently invalid (its sidecar id cannot be
    // rebuilt from its own source), so the scan fails closed either on the
    // duplicate replay id (when the real file was already seen) or on the
    // contextual validation (when the forged file is scanned first).
    const dupReplay = JSON.parse(JSON.stringify(b.cp));
    dupReplay.sidecar.episode_id = a.cp.sidecar.episode_id;
    dupReplay.episode.episode_id = a.cp.sidecar.episode_id;
    writeCp(`${bId}.json`, dupReplay);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /duplicate replay episode_id|invalid checkpoint/, "duplicate replay id must fail closed");
    fs.rmSync(path.join(checkpointsDir, `${bId}.json`));
    writeCp(`${bId}.json`, b.cp);
    // 6. Cross-checkpoint duplicate request_id: internally consistent
    // checkpoint whose flash ledger reuses A's request_id.
    const dupReq = JSON.parse(JSON.stringify(b.cp));
    const sharedId = a.cp.replay_material[0].attempt_log[0].request_id;
    dupReq.replay_material[0].attempt_log[0].request_id = sharedId;
    const bFlashSlot = dupReq.sidecar.slots.find((s) => s.source?.kind === "replay" && s.model === "deepseek/deepseek-v4-flash");
    bFlashSlot.replay.attempt_log[0].request_id = sharedId;
    writeCp(`${bId}.json`, dupReq);
    assert.throws(() => R.scanValidCheckpoints(checkpointsDir, scanArgs), /duplicate request_id/, "cross-checkpoint duplicate request_id must fail closed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("writeOutputs: raw accepted output never published (meta/stats/body non-output positions)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-leak-"));
  try {
    // Temp corpus: FIX_R1 + FIX_R2 (both legacy hard-pass).
    const episodesPath = path.join(tmp, "episodes.jsonl");
    const metaPath = path.join(tmp, "episodes.meta.jsonl");
    const exclusionsPath = path.join(tmp, "exclusions.jsonl");
    const statsPath = path.join(tmp, "stats.json");
    fs.writeFileSync(episodesPath, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.writeFileSync(metaPath, [FIXTURE_META[0], FIXTURE_META[1]].map((m) => JSON.stringify(m)).join("\n") + "\n");
    fs.writeFileSync(exclusionsPath, "");
    fs.writeFileSync(statsPath, `${JSON.stringify(producerStats([FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]], []), null, 2)}\n`);
    const registryPath = path.join(tmp, "registry.json");
    fs.writeFileSync(registryPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    const outDir = path.join(tmp, "out");
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    const blind = resolveBlindKey(outDir, { seed: "leak-test" });
    const rawOutputs = [];
    const checkpointsDir = path.join(outDir, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
    for (const [i, src] of [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].entries()) {
      const srcMeta = FIXTURE_META[i];
      const contentHash = C.episodeContentHash(src);
      const protocolHash = R.buildReplayProtocolHash({
        selectionHash: "legacy",
        sourceContentHash: contentHash,
        models,
        thinking: src.thinking_level ?? "high",
        maxOutputBytes: 200_000,
        maxEpisodeBytes: 1_000_000,
        timeoutMs: 600_000,
        maxRetries: 2,
      });
      const results = [
        mockReplayResult("deepseek/deepseek-v4-flash", `Leak probe answer ${i} one.`, { thinking: src.thinking_level ?? "high" }),
        mockReplayResult("xai/grok-4.5", `Leak probe answer ${i} two.`, { thinking: src.thinking_level ?? "high" }),
      ];
      results[0].attempt_log[0].request_id = `req-${src.episode_id}-flash`;
      results[1].attempt_log[0].request_id = `req-${src.episode_id}-grok`;
      rawOutputs.push(results[0].output, results[1].output);
      const built = R.buildReplayEpisode({
        sourceEpisode: src, sourceMeta: srcMeta, blindKey: blind.key,
        replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
        selectionHash: null, protocolHash,
      });
      const replayEpisodeId = R.buildReplayEpisodeId(blind.key, src.episode_id, models);
      fs.writeFileSync(path.join(checkpointsDir, `${replayEpisodeId}.json`), `${JSON.stringify({
        ledger_version: C.ATTEMPT_LEDGER_VERSION,
        schema_version: R.REPLAY_SCHEMA_VERSION,
        source_episode_id: src.episode_id,
        source_content_hash: contentHash,
        source_thinking: src.thinking_level ?? null,
        replay_thinking: src.thinking_level ?? "high",
        selection_hash: null,
        protocol_hash: protocolHash,
        experiment_mode: null,
        history_excluded: false,
        replay_models: models,
        replay_material: R.buildReplayMaterial(results),
        episode: built.episode,
        sidecar: built.sidecar,
        exclusion: built.exclusion,
        built_at: new Date().toISOString(),
      }, null, 2)}\n`);
    }
    const options = R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      "models-json": registryPath, output: outDir, "allow-legacy-select": true, quiet: true, seed: "leak-test",
    });
    const run = await R.buildReplay(options);
    assert.equal(run.episodes.length, 2, "both legal checkpoints enter output");
    // Raw accepted outputs must NOT appear in meta / stats / body non-output
    // positions. They MAY appear as body slot outputs (the redacted/capped
    // public answer — unchanged here because the fixtures carry no identity
    // tokens and are far below the cap).
    const metaText = fs.readFileSync(path.join(outDir, "episodes.meta.jsonl"), "utf8");
    const statsText = fs.readFileSync(path.join(outDir, "stats.json"), "utf8");
    for (const raw of rawOutputs) {
      assert.ok(!metaText.includes(raw), `raw output leaked into episodes.meta.jsonl: ${raw}`);
      assert.ok(!statsText.includes(raw), `raw output leaked into stats.json: ${raw}`);
    }
    const bodyText = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8");
    for (const line of bodyText.trim().split("\n").filter(Boolean)) {
      const ep = JSON.parse(line);
      const { slots, ...rest } = ep;
      const restText = JSON.stringify(rest);
      for (const raw of rawOutputs) {
        assert.ok(!restText.includes(raw), `raw output leaked into a body non-output field: ${raw}`);
      }
    }
    // The material itself lives ONLY in the checkpoint files.
    for (const name of fs.readdirSync(checkpointsDir)) {
      const cp = JSON.parse(fs.readFileSync(path.join(checkpointsDir, name), "utf8"));
      assert.ok(Array.isArray(cp.replay_material), "checkpoint must carry the private replay material");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("writeOutputs: structural private-key guard — replay_material/raw_accepted_output at any depth refused; content equality is never a false positive", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-write-guard-"));
  try {
    const { cp } = mkValidCp();
    const stats = { schema_version: 1 };
    // Sidecar record carrying replay_material → refused.
    const leakySidecar = [{ ...cp.sidecar, replay_material: cp.replay_material }];
    assert.throws(() => R.writeOutputs(path.join(tmp, "out1"), { episodes: [cp.episode], sidecar: leakySidecar, exclusions: [], stats }), /replay_material/);
    // A private key nested at ANY depth of a public artifact → refused
    // (structural, field-level — not string-content matching).
    const raw = cp.replay_material[0].raw_accepted_output;
    const nestedMeta = [{ ...cp.sidecar, deep: { deeper: { raw_accepted_output: raw } } }];
    assert.throws(() => R.writeOutputs(path.join(tmp, "out2"), { episodes: [cp.episode], sidecar: nestedMeta, exclusions: [], stats }), /raw_accepted_output/);
    const nestedStats = { schema_version: 1, deep: { replay_material: [raw] } };
    assert.throws(() => R.writeOutputs(path.join(tmp, "out3"), { episodes: [cp.episode], sidecar: [cp.sidecar], exclusions: [], stats: nestedStats }), /replay_material/);
    const nestedExclusion = { episode_id: "ep-x", reason: "x", deep: { raw_accepted_output: raw } };
    assert.throws(() => R.writeOutputs(path.join(tmp, "out4"), { episodes: [cp.episode], sidecar: [cp.sidecar], exclusions: [nestedExclusion], stats }), /raw_accepted_output/);
    // Body episodes are already closed by assertAnonymousBody (a private key
    // is outside the fixed body key set), so a body carrying one is refused
    // either way — the private key can never reach disk.
    const nestedBody = { ...cp.episode, deep: { raw_accepted_output: raw } };
    assert.throws(() => R.writeOutputs(path.join(tmp, "out5"), { episodes: [nestedBody], sidecar: [cp.sidecar], exclusions: [], stats }), /anonymous body leaks field deep|raw_accepted_output/);
    // Content equality is NEVER a leak: a legal answer that happens to
    // equal the prompt (or any other public text) publishes fine — the
    // guard is field-level, not string-content matching.
    const okStats = {
      schema_version: 1,
      replay: { models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"], history_excluded: false, experiment_mode: null, thinking_policy: "source_episode_thinking_level", thinking: null, paired_required: false },
      selection: { mode: "legacy_fixture", selected_this_run: 1, cumulative: 1, cumulative_checkpoints: 1 },
      inputs: { selection_hash: null },
    };
    const sameAsPrompt = { ...cp.episode, prompt: raw };
    const sameAsPromptMeta = [{ ...cp.sidecar, note: raw }];
    R.writeOutputs(path.join(tmp, "out6"), { episodes: [sameAsPrompt], sidecar: sameAsPromptMeta, exclusions: [], stats: { ...okStats, note: raw } });
    assert.ok(fs.existsSync(path.join(tmp, "out6", "episodes.jsonl")), "content-equal public text must publish (no false positive)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("writeOutputs: ONE-TIME snapshot before guards/render — a getter that returns clean on the first read and a leak on re-reads is read exactly once (clean public bytes); a first-read leak is rejected before mkdir; sidecar/stats private-key getters share the same semantics", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-touctou-"));
  try {
    // buildReadme renders the public README from the snapshot stats, so a
    // successful write needs a README-renderable stats shape.
    const okStats = {
      schema_version: 1,
      replay: { models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"], history_excluded: false, experiment_mode: null, thinking_policy: "source_episode_thinking_level", thinking: null, paired_required: false },
      selection: { mode: "legacy_fixture", selected_this_run: 1, cumulative: 1, cumulative_checkpoints: 1 },
      inputs: { selection_hash: null },
    };
    const clean = {
      schema_version: 3,
      dataset_mode: "replay",
      episode_id: "rep-0123456789abcdef",
      prompt: "Clean prompt.",
      thinking: "high",
      tools: null,
      slots: [{ slot_id: "slot-rep-0123456789abcdef-0123456789ab", model_id: "c0", output: "Clean answer.", result: "ok" }],
    };
    // Episode prompt getter: clean on the FIRST read, a model identity leak
    // on every subsequent read. The snapshot reads it exactly once, so the
    // guarded value AND the written bytes are the clean first-read value.
    let promptReads = 0;
    const leakOnSecondRead = { ...clean };
    Object.defineProperty(leakOnSecondRead, "prompt", {
      enumerable: true, configurable: true,
      get() { promptReads++; return promptReads === 1 ? "Clean prompt." : "openai/gpt-5.5 leaked on re-read"; },
    });
    const outDir = path.join(tmp, "out1");
    R.writeOutputs(outDir, { episodes: [leakOnSecondRead], sidecar: [], exclusions: [], stats: okStats });
    assert.equal(promptReads, 1, "the prompt getter must be read exactly once (at snapshot time)");
    const body = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8");
    assert.ok(body.includes("Clean prompt."), "the snapshot value must be the guarded AND written value");
    assert.ok(!body.includes("gpt-5.5") && !body.includes("leaked"), "the second-read leak must never reach the public bytes");
    // Getter that returns a leak on the FIRST read: the guard rejects the
    // snapshot BEFORE any mkdir/write — no dir, no files.
    const leakOnFirstRead = { ...clean };
    Object.defineProperty(leakOnFirstRead, "prompt", { enumerable: true, configurable: true, get() { return "openai/gpt-5.5"; } });
    const outDir2 = path.join(tmp, "out2");
    assert.throws(() => R.writeOutputs(outDir2, { episodes: [leakOnFirstRead], sidecar: [], exclusions: [], stats: okStats }), /leaks/, "a first-read leak must be rejected by the guard");
    assert.ok(!fs.existsSync(outDir2), "no output dir created when the snapshot rejects");
    // Sidecar getter: clean first read, private-key-bearing object on
    // re-reads → snapshot reads once → clean public bytes (the private key
    // scan runs on the snapshot).
    let metaReads = 0;
    const metaRec = { schema_version: 1, episode_id: "rep-0123456789abcdef", slots: [] };
    Object.defineProperty(metaRec, "deep", {
      enumerable: true, configurable: true,
      get() { metaReads++; return metaReads === 1 ? { note: "clean" } : { raw_accepted_output: "leak-on-reread" }; },
    });
    const outDir3 = path.join(tmp, "out3");
    R.writeOutputs(outDir3, { episodes: [clean], sidecar: [metaRec], exclusions: [], stats: okStats });
    assert.equal(metaReads, 1, "the sidecar getter must be read exactly once");
    const metaText = fs.readFileSync(path.join(outDir3, "episodes.meta.jsonl"), "utf8");
    assert.ok(!metaText.includes("raw_accepted_output"), "a second-read private key must never reach the meta bytes");
    // Stats getter: same one-time snapshot semantics.
    let statsReads = 0;
    const statsObj = { ...okStats };
    Object.defineProperty(statsObj, "deep", {
      enumerable: true, configurable: true,
      get() { statsReads++; return statsReads === 1 ? { note: "clean" } : { replay_material: ["leak-on-reread"] }; },
    });
    const outDir4 = path.join(tmp, "out4");
    R.writeOutputs(outDir4, { episodes: [clean], sidecar: [], exclusions: [], stats: statsObj });
    assert.equal(statsReads, 1, "the stats getter must be read exactly once");
    const statsText = fs.readFileSync(path.join(outDir4, "stats.json"), "utf8");
    assert.ok(!statsText.includes("replay_material"), "a second-read replay_material must never reach the stats bytes");
    // First-read private key in the sidecar/stats snapshot → rejected before mkdir.
    const badMeta = { schema_version: 1, episode_id: "rep-0123456789abcdef", slots: [] };
    Object.defineProperty(badMeta, "deep", { enumerable: true, configurable: true, get() { return { raw_accepted_output: "x" }; } });
    const outDir5 = path.join(tmp, "out5");
    assert.throws(() => R.writeOutputs(outDir5, { episodes: [clean], sidecar: [badMeta], exclusions: [], stats: okStats }), /raw_accepted_output/, "a first-read private key must be rejected");
    assert.ok(!fs.existsSync(outDir5), "no dir on first-read private-key rejection");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("resource cap: max episode bytes excludes body but keeps sidecar", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "j".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS,
    options: { ...FIXTURE_OPTIONS, maxEpisodeBytes: 50 },
  });
  assert.equal(built.episode, null);
  assert.equal(built.exclusion.reason, "episode_bytes_exceeded");
  assert.ok(built.sidecar.slots.length >= 5);
});

await check("deterministic body for fixed blind key", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const a = R.buildReplayEpisode({ sourceEpisode: src, sourceMeta: srcMeta, blindKey: "g".repeat(64), replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS });
  const b = R.buildReplayEpisode({ sourceEpisode: src, sourceMeta: srcMeta, blindKey: "g".repeat(64), replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS });
  assert.equal(JSON.stringify(a.episode), JSON.stringify(b.episode));
});

await check("aggregate compatibility: maps real models; replay vs historical layered in meta", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
    mockReplayResult("xai/grok-4.5", "Replay answer two."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "h".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
  });
  const candidateIds = built.episode.slots.map((s) => s.model_id);
  const mkEval = (idx) => ({
    schema_version: 1, stage: "evaluator", evaluator_index: idx, episode_id: built.episode.episode_id,
    task_understanding: { ok: true, confidence: 0.9, summary: "s" },
    candidates: candidateIds.map((cid) => ({
      candidate_id: cid, claims: { supported: ["x"], unsupported: [], contradicted: [], unverifiable: [] },
      missed_critical_points: [], instruction_following: { rating: "full", notes: "" },
      overall_correctness: { rating: "correct", confidence: 0.8, notes: "" }, noise_types: [], abstain: false, abstain_reason: null,
    })),
  });
  const evalRecord = {
    schema_version: 1, episode_id: built.episode.episode_id, content_hash: "h", dataset_mode: "replay",
    model_count: candidateIds.length, candidate_ids: candidateIds,
    judge_models: { evaluator0: "openai/gpt-5.6-sol", evaluator1: "anthropic/claude-opus-5", verifier: "kimi-coding/k3", adjudicator: "openai/gpt-5.6-sol", counterfactual: "anthropic/claude-opus-5" },
    stages: {
      evaluator_0: { ok: true, data: mkEval(0) },
      evaluator_1: { ok: true, data: mkEval(1) },
      adjudicator: { ok: true, data: { schema_version: 1, stage: "adjudicator", episode_id: built.episode.episode_id, verdicts: candidateIds.map((cid) => ({ candidate_id: cid, verdict: "adopt", confidence: 0.8, evidence: [], counter_evidence: [] })), disagreement: { evaluator_disagreement: "low", summary: "" }, unresolved: [] } },
      counterfactual: { ok: true, data: { schema_version: 1, stage: "counterfactual", episode_id: built.episode.episode_id, per_candidate: candidateIds.map((cid) => ({ candidate_id: cid, information_loss: "low", noise_reduction: "low", unique_valid_contribution: { exists: true, contribution: "c", evidence: [] }, net_value: "positive" })) } },
    },
    summary: { calls: 5, cost: 0.1, cost_source: "provider", cost_breakdown: { provider: 0.1, estimated: 0, unknown: 0 }, unresolved: [], errors: [], complete: true },
  };
  const base = aggregate([evalRecord], [built.episode], [built.sidecar]);
  const models = new Set(base.capability.by_model.map((m) => m.model));
  for (const m of ["deepseek/deepseek-v4-flash", "xai/grok-4.5", "openai/gpt-5.5", "moonshotai/kimi-k2.7-code", "deepseek/deepseek-v4-pro"]) {
    assert.ok(models.has(m), `aggregate missing model ${m}`);
  }
  const rep = replayReport([built.sidecar]);
  assert.equal(rep.slots["deepseek/deepseek-v4-flash"].replay, 1);
  assert.equal(rep.slots["openai/gpt-5.5"].historical, 1);
  assert.equal(rep.calls.total, 2);
  assert.equal(rep.calls.ok, 2);
  // All-known ledger ternary: known_cost numeric, cost_complete true, cost === known_cost.
  assert.equal(rep.calls.known_cost, 0.002);
  assert.equal(rep.calls.unknown_attempts, 0);
  assert.equal(rep.calls.cost_complete, true);
  assert.equal(rep.calls.cost, 0.002);
  assert.equal(rep.calls.cost_source, "provider");
  assert.deepEqual(rep.calls.cost_breakdown, { provider: 0.002, estimated: 0, unknown: 0 });
  assert.equal(rep.calls.by_model["deepseek/deepseek-v4-flash"].cost, 0.001);
  assert.equal(rep.calls.by_model["deepseek/deepseek-v4-flash"].cost_complete, true);
  assert.equal(rep.source_episodes[0].source_episode_id, FIX_R1);
});

await check("manifest gate: episode_ids-only rejected (P1 bypass closed)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-sel-ids-only-"));
  const p = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  // Strip selected + classifications (the episode_ids-only bypass form): the
  // complete-manifest gate must reject it — a selected-less / classification-
  // less manifest is exactly the P1 bypass.
  m.selected = [];
  delete m.classifications;
  fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  assert.throws(() => R.loadAndValidateSelection(p), /selected|classifications/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

await check("current-only: body has only 3 current candidates, no historical slots", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Equal-condition answer alpha with concrete reasoning."),
    mockReplayResult("xai/grok-4.5", "Equal-condition answer beta with concrete reasoning."),
    mockReplayResult("openai/gpt-5.5", "Equal-condition answer gamma with concrete reasoning."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "k".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: { ...FIXTURE_OPTIONS, minModels: 3 },
    experimentMode: R.CURRENT_ONLY_EXPERIMENT_MODE,
    historyExcluded: true,
    requirePaired: true,
    thinkingOverride: R.CURRENT_ONLY_THINKING,
    selectionHash: "s".repeat(64), protocolHash: "p".repeat(64),
  });
  assert.equal(built.exclusion, null);
  assert.equal(built.episode.slots.length, 3);
  assert.equal(built.episode.thinking, "high");
  R.assertAnonymousBody(built.episode);
  const outputs = new Set(built.episode.slots.map((s) => s.output));
  assert.ok(outputs.has("Equal-condition answer alpha with concrete reasoning."));
  assert.ok(outputs.has("Equal-condition answer beta with concrete reasoning."));
  assert.ok(outputs.has("Equal-condition answer gamma with concrete reasoning."));
  // Historical outputs must NOT appear.
  for (const h of src.slots) {
    assert.ok(!outputs.has(h.output), "historical output leaked into current-only body");
  }
  // Sidecar has only replay slots; real models + prompt hash recorded.
  assert.equal(built.sidecar.slots.length, 3);
  assert.ok(built.sidecar.slots.every((s) => s.source?.kind === "replay"));
  assert.equal(built.sidecar.history_excluded, true);
  assert.equal(built.sidecar.experiment_mode, R.CURRENT_ONLY_EXPERIMENT_MODE);
  assert.match(built.sidecar.source_prompt_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(built.sidecar.replay_models, [
    "deepseek/deepseek-v4-flash", "xai/grok-4.5", "openai/gpt-5.5",
  ]);
  for (const s of built.sidecar.slots) {
    assert.equal(s.in_body, true);
    assert.equal(s.replay.error_class, null);
    assert.equal(s.replay.thinking, "high");
  }
  assertAnonymousReplayBody(built.episode, "current-only body");
});

await check("current-only: any model failure excludes episode from paired body (sidecar kept)", () => {
  const src = FIXTURE_EPISODES[0];
  const srcMeta = FIXTURE_META[0];
  const results = [
    mockReplayResult("deepseek/deepseek-v4-flash", "Flash ok."),
    {
      ...mockReplayResult("xai/grok-4.5", ""),
      ok: false, error: "transport timeout", error_class: "transport",
      exclusion_reason: "replay_call_failed",
    },
    mockReplayResult("openai/gpt-5.5", "Control ok."),
  ];
  const built = R.buildReplayEpisode({
    sourceEpisode: src, sourceMeta: srcMeta, blindKey: "l".repeat(64),
    replayResults: results, corpusModelNames: FIXTURE_CORPUS, options: { ...FIXTURE_OPTIONS, minModels: 3 },
    experimentMode: R.CURRENT_ONLY_EXPERIMENT_MODE,
    historyExcluded: true,
    requirePaired: true,
    thinkingOverride: "high",
  });
  assert.equal(built.episode, null);
  assert.equal(built.exclusion.reason, "not_fully_paired");
  assert.ok(built.sidecar);
  assert.equal(built.sidecar.slots.length, 3);
  const flash = built.sidecar.slots.find((s) => s.model === "deepseek/deepseek-v4-flash");
  const grok = built.sidecar.slots.find((s) => s.model === "xai/grok-4.5");
  assert.equal(flash.in_body, false);
  assert.equal(flash.exclusion_reason, "not_fully_paired");
  assert.equal(flash.replay.error_class, null); // success attempt still null
  assert.equal(grok.in_body, false);
  assert.equal(grok.exclusion_reason, "replay_call_failed");
  assert.equal(grok.replay.error_class, "transport");
});

await check("current-only: protocol hash binds experiment_mode + history_excluded + high thinking", () => {
  const base = {
    selectionHash: "s".repeat(64),
    sourceContentHash: "c".repeat(64),
    models: [...R.CURRENT_ONLY_MODELS],
    thinking: "high",
    maxOutputBytes: 200_000,
    maxEpisodeBytes: 1_000_000,
    timeoutMs: 600_000,
    maxRetries: 2,
    experimentMode: R.CURRENT_ONLY_EXPERIMENT_MODE,
    historyExcluded: true,
  };
  const h1 = R.buildReplayProtocolHash(base);
  const h2 = R.buildReplayProtocolHash({ ...base, historyExcluded: false });
  const h3 = R.buildReplayProtocolHash({ ...base, experimentMode: null });
  const h4 = R.buildReplayProtocolHash({ ...base, thinking: "medium" });
  assert.notEqual(h1, h2);
  assert.notEqual(h1, h3);
  assert.notEqual(h1, h4);
});

await check("current-only parseArgs: defaults three models + high + output dir", () => {
  const args = R.parseArgs({ "current-only": true, selection: "/tmp/sel.json" });
  assert.equal(args.currentOnly, true);
  assert.deepEqual(args.models, [...R.CURRENT_ONLY_MODELS]);
  assert.equal(args.historyExcluded, true);
  assert.equal(args.requirePaired, true);
  assert.equal(args.experimentMode, R.CURRENT_ONLY_EXPERIMENT_MODE);
  assert.equal(args.minModels, 3);
  assert.match(args.output, /t0-replay-current-run$/);
});

await check("parseCliArgs strict offline pure parser: legal space argv (incl. repeat --episode); rejects --flag=value / unknown / positional / duplicate / missing / bool-value / invalid numeric / empty; malicious argv never yields production defaults", () => {
  // Legal space-form argv with repeatable --episode accumulates and reaches parseArgs.
  const ok = R.parseCliArgs([
    "--selection", "/tmp/sel.json",
    "--episodes", "/tmp/e.jsonl",
    "--meta", "/tmp/m.jsonl",
    "--output", "/tmp/out",
    "--models-json", "/tmp/models.json",
    "--episode", "ep-aaaaaaaaaaaaaaaa",
    "--episode", "ep-bbbbbbbbbbbbbbbb",
    "--limit", "0",
    "--concurrency", "2",
    "--max-retries", "0",
    "--timeout-ms", "1",
    "--min-models", "2",
    "--max-output-bytes", "1",
    "--max-episode-bytes", "1",
    "--max-total-bytes", "1",
    "--quiet",
    "--no-resume",
  ]);
  assert.equal(ok.selectionPath, path.resolve("/tmp/sel.json"));
  assert.equal(ok.episodesPath, path.resolve("/tmp/e.jsonl"));
  assert.equal(ok.metaPath, path.resolve("/tmp/m.jsonl"));
  assert.equal(ok.output, path.resolve("/tmp/out"));
  assert.equal(ok.modelsJsonPath, path.resolve("/tmp/models.json"));
  assert.deepEqual(ok.episodeIds, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
  assert.equal(ok.limit, 0);
  assert.equal(ok.concurrency, 2);
  assert.equal(ok.maxRetries, 0);
  assert.equal(ok.timeoutMs, 1);
  assert.equal(ok.minModels, 2);
  assert.equal(ok.maxOutputBytes, 1);
  assert.equal(ok.maxEpisodeBytes, 1);
  assert.equal(ok.maxTotalBytes, 1);
  assert.equal(ok.quiet, true);
  assert.equal(ok.resume, false);

  // Shared helper: repeatable value accumulate; non-repeatable still reject.
  const raw = C.parseStrictCli(
    ["--episode", "a", "--episode", "b", "--output", "/tmp/x", "--quiet"],
    {
      valueFlags: ["episode", "output"],
      booleanFlags: ["quiet"],
      repeatableValueFlags: ["episode"],
    },
  );
  assert.deepEqual(raw.episode, ["a", "b"]);
  assert.equal(raw.output, "/tmp/x");
  assert.equal(raw.quiet, true);

  const reject = (argv, re) => {
    assert.throws(() => R.parseCliArgs(argv), re);
  };
  // --flag=value forms (known value + boolean).
  reject(["--output=/tmp/out"], /--flag=value|not supported/);
  reject(["--selection=/tmp/sel.json"], /--flag=value|not supported/);
  reject(["--quiet=true"], /--flag=value|not supported/);
  // unknown / positional
  reject(["--bogus"], /unknown option/);
  reject(["/tmp/e.jsonl"], /positional/);
  reject(["--selection", "/tmp/sel.json", "stray"], /positional/);
  // non-repeatable duplicate + boolean duplicate
  reject(["--output", "/tmp/a", "--output", "/tmp/b"], /duplicate/);
  reject(["--quiet", "--quiet"], /duplicate/);
  // missing value / next token is a flag
  reject(["--output"], /requires a value/);
  reject(["--output", "--quiet"], /requires a value/);
  // boolean with value
  reject(["--quiet", "yes"], /must not take a value/);
  reject(["--current-only", "1"], /must not take a value/);
  // invalid numeric (supplied raw)
  reject(["--limit", "-1"], /non-negative integer/);
  reject(["--limit", "1.5"], /non-negative integer/);
  reject(["--limit", "abc"], /non-negative integer/);
  reject(["--max-retries", "01"], /non-negative integer/);
  reject(["--concurrency", "0"], /positive integer/);
  reject(["--concurrency", "-2"], /positive integer/);
  reject(["--timeout-ms", "0"], /positive integer/);
  reject(["--min-models", "0"], /positive integer/);
  reject(["--max-output-bytes", "0"], /positive integer/);
  reject(["--max-episode-bytes", "x"], /positive integer/);
  reject(["--max-total-bytes", "1e3"], /positive integer/);
  // empty value
  reject(["--episodes", ""], /non-empty value/);
  reject(["--output", ""], /non-empty value/);
  reject(["--selection", ""], /non-empty value/);
  reject(["--models", ""], /non-empty value/);
  // semantic-empty CSV values fail closed (OpenAI repro): pure whitespace,
  // bare commas, and mixed empty segments must throw — never silently drop
  // segments (which could widen a selection or fall back to default models).
  reject(["--episode", " "], /non-empty value/);
  reject(["--episode", ","], /comma-separated value/);
  reject(["--episode", ",,"], /comma-separated value/);
  reject(["--episode", "ep-a,,ep-b"], /comma-separated value/);
  reject(["--episode", "ep-a", "--episode", ",ep-b"], /comma-separated value/);
  reject(["--episode", "ep-a", "--episode", "ep-b,"], /comma-separated value/);
  reject(["--models", " "], /non-empty value/);
  reject(["--models", ","], /comma-separated value/);
  reject(["--models", ",,"], /comma-separated value/);
  reject(["--models", "model,,x"], /comma-separated value/);
  reject(["--models", "model-a,"], /comma-separated value/);
  // Legal CSV with surrounding spaces still parses (segments trimmed).
  const csvOk = R.parseCliArgs(["--selection", "/tmp/sel.json", "--episode", "ep-a, ep-b", "--models", "deepseek/deepseek-v4-flash, xai/grok-4.5"]);
  assert.deepEqual(csvOk.episodeIds, ["ep-a", "ep-b"]);
  assert.deepEqual(csvOk.models, ["deepseek/deepseek-v4-flash", "xai/grok-4.5"]);
  // Default models resolve ONLY when --models is completely absent: a
  // supplied-but-invalid --models already threw above, never a default.
  const noModels = R.parseCliArgs(["--selection", "/tmp/sel.json"]);
  assert.deepEqual(noModels.models, [...R.REPLAY_DEFAULT_MODELS]);

  // Malicious / malformed argv must throw — never return an options object
  // (so the raw CLI path cannot silently resolve default production dirs).
  // Keep every static string free of production path fragments so the offline
  // lock (smoke-script-registry-drift) stays green.
  const malicious = [
    ["--output=/tmp/pwned"],
    ["--episodes=/tmp/not-a-legal-equals-form.jsonl"],
    ["--typo-selection", "/tmp/sel.json"],
    ["--selection"],
    ["--selection", "/tmp/sel.json", "--output", "/tmp/out", "--bogus"],
    ["--quiet", "true"],
    ["--concurrency", "0"],
    ["--limit", "nope"],
  ];
  for (const argv of malicious) {
    let threw = false;
    let leaked = null;
    try {
      leaked = R.parseCliArgs(argv);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, `expected throw for ${JSON.stringify(argv)}`);
    assert.equal(leaked, null, `malicious argv must not yield options: ${JSON.stringify(argv)}`);
  }
  // Object API fixture compatibility is unchanged (parseArgs({}) still builds
  // default paths for fixtures — only the raw argv path is strict).
  const fixture = R.parseArgs({ selection: "/tmp/sel.json", episodes: "/tmp/e.jsonl", output: "/tmp/out" });
  assert.equal(fixture.selectionPath, path.resolve("/tmp/sel.json"));
  assert.equal(fixture.episodesPath, path.resolve("/tmp/e.jsonl"));
  assert.equal(fixture.output, path.resolve("/tmp/out"));
});

await check("parseCliArgs raw numeric safe-integer gate: 400-digit / >MAX_SAFE_INTEGER values throw for every numeric flag BEFORE any default/I/O; MAX_SAFE_INTEGER boundary parses; --min-models 1 rejects instead of clamping", () => {
  const huge = "9".repeat(400); // Number() coerces to Infinity
  const overflow = "9007199254740992"; // 2^53, finite but rounds to a non-safe integer
  const maxSafe = String(Number.MAX_SAFE_INTEGER); // 9007199254740991
  const reject = (argv, re) => {
    assert.throws(() => R.parseCliArgs(argv), re);
  };
  // Non-negative flags: huge / overflow throw; MAX_SAFE_INTEGER parses.
  const outKey = { "limit": "limit", "max-retries": "maxRetries", "concurrency": "concurrency", "timeout-ms": "timeoutMs", "max-output-bytes": "maxOutputBytes", "max-episode-bytes": "maxEpisodeBytes", "max-total-bytes": "maxTotalBytes" };
  for (const flag of ["limit", "max-retries"]) {
    reject([`--${flag}`, huge], /non-negative integer/);
    reject([`--${flag}`, overflow], /non-negative integer/);
    assert.equal(R.parseCliArgs([`--${flag}`, maxSafe])[outKey[flag]], Number.MAX_SAFE_INTEGER, `--${flag} MAX_SAFE_INTEGER parses`);
  }
  // Positive flags: huge / overflow throw; MAX_SAFE_INTEGER parses.
  for (const flag of ["concurrency", "timeout-ms", "max-output-bytes", "max-episode-bytes", "max-total-bytes"]) {
    reject([`--${flag}`, huge], /positive integer/);
    reject([`--${flag}`, overflow], /positive integer/);
    assert.equal(R.parseCliArgs([`--${flag}`, maxSafe])[outKey[flag]], Number.MAX_SAFE_INTEGER, `--${flag} MAX_SAFE_INTEGER parses`);
  }
  // --min-models: huge / overflow throw; MAX_SAFE_INTEGER (>= 2) parses;
  // a value below the fair-path floor (1) REJECTS instead of clamping.
  reject(["--min-models", huge], /positive integer/);
  reject(["--min-models", overflow], /positive integer/);
  reject(["--min-models", "1"], /integer >= 2/, "--min-models 1 must reject, never clamp to 2");
  assert.equal(R.parseCliArgs(["--min-models", maxSafe]).minModels, Number.MAX_SAFE_INTEGER, "--min-models MAX_SAFE_INTEGER parses");
  assert.equal(R.parseCliArgs(["--min-models", "2"]).minModels, 2, "--min-models 2 parses");
  // Object API legacy clamp is unchanged (fixture callers may pass 1 and get
  // the floor) — only the raw argv path rejects.
  assert.equal(R.parseArgs({ "min-models": 1 }).minModels, 2, "object API keeps the legacy clamp");
});

await check("fair path rejects --thinking override; current-only rejects non-high (temp fixture --episodes/--meta, never default production paths)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-think-gate-"));
  const sel = writeFairSelectionFixture(tmp, ["ep-aaaaaaaaaaaaaaaa"]);
  // Explicit temp fixture paths so the negative case never depends on
  // validation order to avoid reading the default production episodes path.
  const fixtureEpisodes = path.join(tmp, "missing.jsonl");
  const fixtureMeta = path.join(tmp, "missing-meta.jsonl");
  // Fair + thinking override
  let failed = false;
  let msg = "";
  try {
    execFileSync(process.execPath, [
      path.join(root, "scripts/t0-replay-build.mjs"),
      "--selection", sel,
      "--thinking", "high",
      "--episodes", fixtureEpisodes,
      "--meta", fixtureMeta,
      "--output", path.join(tmp, "out-fair"),
      "--models-json", path.join(tmp, "nonexistent-models.json"),
    ], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    failed = true;
    msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
  }
  assert.ok(failed, "fair path must reject --thinking");
  assert.match(msg, /forbids --thinking|thinking/);

  failed = false;
  msg = "";
  try {
    execFileSync(process.execPath, [
      path.join(root, "scripts/t0-replay-build.mjs"),
      "--selection", sel,
      "--current-only",
      "--thinking", "medium",
      "--episodes", fixtureEpisodes,
      "--meta", fixtureMeta,
      "--output", path.join(tmp, "out-cur"),
      "--models-json", path.join(tmp, "nonexistent-models.json"),
    ], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    failed = true;
    msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
  }
  assert.ok(failed, "current-only must reject non-high thinking");
  assert.match(msg, /requires thinking=high|thinking/);
});

await check("current-only rejects --allow-legacy-select; missing selection still fails (temp fixture --episodes/--meta, never default production paths)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-cur-legacy-"));
  // Explicit temp fixture paths so the negative case never depends on
  // validation order to avoid reading the default production episodes path.
  const fixtureEpisodes = path.join(tmp, "missing.jsonl");
  const fixtureMeta = path.join(tmp, "missing-meta.jsonl");
  let failed = false;
  let msg = "";
  try {
    execFileSync(process.execPath, [
      path.join(root, "scripts/t0-replay-build.mjs"),
      "--current-only",
      "--allow-legacy-select",
      "--episodes", fixtureEpisodes,
      "--meta", fixtureMeta,
      "--output", path.join(tmp, "out"),
      "--models-json", path.join(tmp, "nonexistent-models.json"),
    ], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    failed = true;
    msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
  }
  assert.ok(failed);
  assert.match(msg, /allow-legacy-select|selection/);

  failed = false;
  msg = "";
  try {
    execFileSync(process.execPath, [
      path.join(root, "scripts/t0-replay-build.mjs"),
      "--current-only",
      "--episodes", fixtureEpisodes,
      "--meta", fixtureMeta,
      "--output", path.join(tmp, "out2"),
      "--models-json", path.join(tmp, "nonexistent-models.json"),
    ], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    failed = true;
    msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
  }
  assert.ok(failed);
  assert.match(msg, /selection/);
});

await check("checkpoint dir isolation: mismatched selection/protocol not admitted to outputs", () => {
  // Unit-level: buildReplayProtocolHash differences + filter logic via exported helpers.
  const a = R.buildReplayProtocolHash({
    selectionHash: "a".repeat(64), sourceContentHash: "c".repeat(64),
    models: [...R.CURRENT_ONLY_MODELS], thinking: "high",
    maxOutputBytes: 200_000, maxEpisodeBytes: 1_000_000, timeoutMs: 600_000, maxRetries: 2,
    experimentMode: R.CURRENT_ONLY_EXPERIMENT_MODE, historyExcluded: true,
  });
  const b = R.buildReplayProtocolHash({
    selectionHash: "b".repeat(64), sourceContentHash: "c".repeat(64),
    models: [...R.CURRENT_ONLY_MODELS], thinking: "high",
    maxOutputBytes: 200_000, maxEpisodeBytes: 1_000_000, timeoutMs: 600_000, maxRetries: 2,
    experimentMode: R.CURRENT_ONLY_EXPERIMENT_MODE, historyExcluded: true,
  });
  assert.notEqual(a, b, "different selection_hash must change protocol_hash");
});

await check("paired_current_only aggregate only counts fully paired episodes", () => {
  // Build two synthetic meta rows: one fully paired, one partial.
  const models = [...R.CURRENT_ONLY_MODELS];
  const mkMeta = (id, okMask) => ({
    episode_id: id,
    source_episode_id: `ep-${id.slice(-8)}aaaaaaaa`,
    experiment_mode: R.CURRENT_ONLY_EXPERIMENT_MODE,
    history_excluded: true,
    paired_required: true,
    replay_models: models,
    slots: models.map((m, i) => ({
      slot_id: `s${i}`,
      model: m,
      in_body: okMask[i] === true,
      source: { kind: "replay" },
      replay: {
        attempts: 1,
        attempt_log: [{ attempt: 0, request_id: `req-${m}-${i}`, ok: okMask[i], error: okMask[i] ? null : "transport timeout", error_class: okMask[i] ? null : "transport", usage: okMask[i] ? { input: 10, output: 5, cost: 0.01 } : null, cost: okMask[i] ? 0.01 : null, cost_source: okMask[i] ? "provider" : null }],
        error_class: okMask[i] ? null : "transport",
        cost: 0.01,
        cost_source: "provider",
      },
    })),
  });
  const metaPaired = mkMeta("rep-paired00000001", [true, true, true]);
  const metaUnpaired = mkMeta("rep-unpaired000001", [true, false, true]);
  const epPaired = {
    schema_version: 3, dataset_mode: "replay", episode_id: "rep-paired00000001",
    prompt: "p", thinking: "high", tools: null,
    slots: [
      { slot_id: "s0", model_id: "c0", output: "a", result: "ok" },
      { slot_id: "s1", model_id: "c1", output: "b", result: "ok" },
      { slot_id: "s2", model_id: "c2", output: "c", result: "ok" },
    ],
  };
  const report = pairedCurrentOnlyReport(
    [metaPaired, metaUnpaired],
    [], // no eval — empty by_model is fine
    [epPaired],
    [],
  );
  assert.equal(report.paired_n, 1);
  assert.equal(report.unpaired_n, 1);
  assert.deepEqual(report.episode_ids, ["rep-paired00000001"]);
  assert.equal(report.family_overlap.present, true);
  assert.ok(report.family_overlap.families.includes("openai"));
  assert.match(report.scope_note, /prompt-only/);
});

await check("CLI rejects production path without --selection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-cli-noselect-"));
  let failed = false;
  let msg = "";
  try {
    execFileSync(process.execPath, [
      path.join(root, "scripts/t0-replay-build.mjs"),
      "--episodes", path.join(tmp, "missing.jsonl"),
      "--meta", path.join(tmp, "missing-meta.jsonl"),
      "--output", path.join(tmp, "out"),
      "--models-json", path.join(tmp, "nonexistent-models.json"),
      "--limit", "1",
    ], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    failed = true;
    msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
  }
  assert.ok(failed, "must fail without --selection");
  assert.match(msg, /--selection/);
});

// ── P0: deterministic public artifacts + full-selection subset + blind key ─

/**
 * Mock invoker injected via `options.invoker`: routes through callJudge's
 * real path (registry.find + getApiKeyAndHeaders + auditStreamSimple) but
 * serves deterministic replay answers with zero provider. Records every call
 * (modelRef + user text) for the "provider mock only serves missing items"
 * assertion.
 */
function makeReplayMockInvoker(serve) {
  const calls = [];
  const invoker = {
    calls,
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}`, reasoning: true }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async (_root, meta, _piAi, model, opts) => {
      const modelRef = meta.model_ref;
      const userText = opts.messages[0].content[0].text;
      calls.push({ modelRef, userText });
      const served = serve(modelRef, userText);
      if (!served) throw new Error(`mock: no answer for ${modelRef}`);
      return {
        stopReason: "stop",
        content: [{ type: "text", text: served.text }],
        usage: served.usage ?? { input: 10, output: 5, cost: 0.001 },
      };
    },
  };
  return invoker;
}

/** A failed replay result (provider answered but unusable / rejected). */
function mockFailedResult(model, { error = "mock failure", errorClass = "content", exclusionReason = "replay_call_failed" } = {}) {
  return {
    model,
    ok: false,
    output: null,
    calledAt: "2026-08-12T00:00:00.000Z",
    thinking: "high",
    attempts: 1,
    attempt_log: [{
      attempt: 0, request_id: `req-${model}-fail`, model_ref: model, operation: "t0_replay_answer",
      ok: false, error, error_class: errorClass, accepted_output_hash: null,
      usage: { input: 10, output: 5, cost: 0.001 }, cost: 0.001, cost_source: "provider",
    }],
    cost: 0.001,
    cost_source: "provider",
    usage: { input: 10, output: 5, cost: 0.001 },
    error,
    error_class: errorClass,
    exclusion_reason: exclusionReason,
  };
}

function readFiveFiles(dir) {
  const out = {};
  for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
    out[name] = fs.readFileSync(path.join(dir, name), "utf8");
  }
  return out;
}

// Extra eligible corpus episodes for the two-disjoint-subset fair test
// (FIX_R1/FIX_R2 come from the shared fixture).
const FIX_R4 = "ep-0a1b2c3d4e5f60a4";
const FIX_R5 = "ep-0a1b2c3d4e5f60a5";
function eligibleEpisode(id) {
  if (id === FIX_R1) return FIXTURE_EPISODES[0];
  if (id === FIX_R2) return FIXTURE_EPISODES[1];
  const join = id === FIX_R5 ? "heuristic" : "exact";
  return {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: id,
    prompt: `Adjudicate the policy push for ${id}. [model-a] signed, [model-b] rejected.`,
    thinking_level: "high",
    tools: null,
    model_count: 3,
    join_confidence: join,
    missing_evidence: [],
    slots: [1, 2, 3].map((n) => ({
      slot_id: rSlot(id, n),
      model_id: `c${n - 1}`,
      output: n === 1 ? "SIGN" : n === 2 ? "SIGN with notes" : "REVISE point 2",
      output_source: "dispatch_trace",
      output_chars: n === 1 ? 4 : n === 2 ? 15 : 14,
      result: "ok",
      terminal_state: null,
      stop_reason: null,
      failure_type: null,
      join_confidence: join,
      join_note: "exact",
      missing_evidence: [],
    })),
  };
}
function eligibleMeta(id) {
  if (id === FIX_R1) return FIXTURE_META[0];
  if (id === FIX_R2) return FIXTURE_META[1];
  return {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: id,
    slots: [
      { slot_id: rSlot(id, 1), model: "openai/gpt-5.5", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: `dtr_fixture${id.slice(-4)}a` } },
      { slot_id: rSlot(id, 2), model: "moonshotai/kimi-k2.7-code", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: `dtr_fixture${id.slice(-4)}b` } },
      { slot_id: rSlot(id, 3), model: "deepseek/deepseek-v4-pro", in_body: true, exclusion_reason: null, usage: { tokens_in: 1, tokens_out: 100, cost: 0.01 }, audit: { run_id: `dtr_fixture${id.slice(-4)}c` } },
    ],
  };
}

/**
 * Full fair fixture: a corpus + checkpoints-fair + a manifest that is the
 * COMPLETE product of the real classifier selector (all ids hard-pass and
 * replayable, llm stage, both judges agree), built with the selector's own
 * pure helpers so validateFairManifestProvenance passes. Returns
 * { manifestPath, episodes, meta, stats, exclusions }.
 */
function buildFairProvenanceFixture(dir, ids, { episodesOverride = {}, metaOverride = {}, downstreamJudges = [...F.DEFAULT_DOWNSTREAM_JUDGES] } = {}) {
  const corpusEpisodes = ids.map((id) => episodesOverride[id] ?? eligibleEpisode(id));
  const corpusMeta = ids.map((id) => metaOverride[id] ?? eligibleMeta(id));
  const metaById = new Map(corpusMeta.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(corpusEpisodes, metaById, { limit: undefined, downstreamJudges });
  const protocol_hash = F.classifierProtocolHash();
  const judgeModels = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  const thinking = "medium";
  const checkpointDir = path.join(dir, "checkpoints-fair", "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  const exclusions = [];
  const stats = producerStats(corpusEpisodes, corpusMeta, exclusions);
  const classifications = [];
  const selected = [];
  const excluded = hard.excluded.map((e) => ({
    episode_id: e.episode_id, stage: "hard", reasons: e.reasons, join_confidence: e.join_confidence,
  }));
  const exclusion_distribution = { ...hard.distribution };
  const ALL_FALSE_FLAGS = {
    requires_workspace: false, requires_files: false, requires_commands: false,
    requires_live_external_state: false, requires_tool_verification: false,
  };
  for (const id of hard.candidates.map((c) => c.episode.episode_id)) {
    const ep = corpusEpisodes.find((e) => e.episode_id === id);
    const candidate = hard.candidates.find((x) => x.episode.episode_id === id);
    const pHash = F.promptHash(ep.prompt);
    const j0 = { ok: true, judgment: { schema_version: 1, replayable: true, ...ALL_FALSE_FLAGS, reasons: ["self-contained embedded text"], confidence: 0.85 } };
    const j1 = { ok: true, judgment: { schema_version: 1, replayable: true, ...ALL_FALSE_FLAGS, reasons: ["self-contained embedded text"], confidence: 0.85 } };
    const merged = F.mergeDualJudgments(j0, j1, { judge0: judgeModels[0], judge1: judgeModels[1] });
    const attempt_log = {
      [judgeModels[0]]: [{ attempt: 0, request_id: `req-${id}-0`, model_ref: judgeModels[0], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(merged.judgments[judgeModels[0]])), usage: { input: 10, output: 5, cost: { total: 0.015 } }, cost: 0.015, cost_source: "provider" }],
      [judgeModels[1]]: [{ attempt: 0, request_id: `req-${id}-1`, model_ref: judgeModels[1], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(merged.judgments[judgeModels[1]])), usage: { input: 10, output: 5, cost: { total: 0.015 } }, cost: 0.015, cost_source: "provider" }],
    };
    const final = {
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: id,
      stage: "llm",
      classification_status: "completed",
      replayable: true,
      reasons: merged.reasons,
      confidence: merged.confidence,
      cost: 0.03,
      cost_source: "provider",
      cost_breakdown: { provider: 0.03, estimated: 0, unknown: 0 },
      has_unknown_cost: false,
      known_total: 0.03,
      attempts: 2,
      judge_models: judgeModels,
      prompt_hash: pHash,
      protocol_hash,
      thinking,
      from_checkpoint: false,
      mechanical: F.mechanicalExclude(ep.prompt),
      flags: merged.flags,
      disagreement: merged.disagreement,
      judgments: merged.judgments,
      attempt_log,
    };
    fs.writeFileSync(path.join(checkpointDir, `${id}.json`), `${JSON.stringify({
      ledger_version: F.ATTEMPT_LEDGER_VERSION,
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: id,
      prompt_hash: pHash,
      protocol_hash,
      judge_models: judgeModels,
      thinking,
      mechanical: F.mechanicalExclude(ep.prompt),
      judgments: merged.judgments,
      attempt_log,
      final,
      saved_at: "2026-08-12T00:00:00.000Z",
    }, null, 2)}\n`);
    classifications.push({
      episode_id: id, stage: "llm", replayable: true, reasons: merged.reasons, confidence: merged.confidence,
      join_confidence: null, cost: 0.03, cost_source: "provider", cost_breakdown: { provider: 0.03, estimated: 0, unknown: 0 }, from_checkpoint: false,
    });
    selected.push({
      episode_id: id, models: candidate.models, join_confidence: candidate.join_confidence, tools: null,
      stage: "llm", replayable: true, confidence: merged.confidence, reasons: merged.reasons, flags: merged.flags,
      cost: 0.03, cost_source: "provider", cost_breakdown: { provider: 0.03, estimated: 0, unknown: 0 }, from_checkpoint: false,
    });
  }
  selected.sort(F.compareSelectedRows);
  const join_selected = { exact: 0, heuristic: 0 };
  for (const s of selected) {
    if (s.join_confidence === "exact") join_selected.exact += 1;
    else if (s.join_confidence === "heuristic") join_selected.heuristic += 1;
  }
  const manifest = {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    kind: "prompt_only_replay_selection",
    generated_at: "2026-08-12T00:00:00.000Z",
    protocol_hash,
    thinking,
    judge_models: judgeModels,
    classifier_models: judgeModels,
    downstream_judges: [...downstreamJudges],
    classify: true,
    counts: {
      source: corpusEpisodes.length,
      hard_pass: hard.hard_pass_count,
      hard_pass_limited: hard.candidates.length,
      classified: classifications.length,
      replayable: selected.length,
      excluded: excluded.length,
      data_insufficient: false,
      join_hard_pass: { ...hard.join_tier },
      join_selected,
    },
    exclusion_distribution,
    cost: F.buildManifestCostSummary({
      // Cost covers the CLASSIFIED candidates (hard exclusions pay nothing);
      // when the corpus has hard exclusions, corpusEpisodes.length would
      // over-count.
      cost_breakdown: { provider: 0.03 * classifications.length, estimated: 0, unknown: 0 },
      known_total: 0.03 * classifications.length,
      has_unknown_cost: false,
    }),
    selected,
    excluded,
    classifications,
    episodes: "/abs/path/episodes.jsonl",
    meta: "/abs/path/episodes.meta.jsonl",
    limit: null,
    concurrency: 2,
    hard_only: false,
    episode_ids: selected.map((s) => s.episode_id),
  };
  const manifestPath = path.join(dir, "selection.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, episodes: corpusEpisodes, meta: corpusMeta, stats, exclusions };
}

/**
 * Fair fixture with a hard-PASS but NON-replayable candidate: corpus has the
 * `replayableIds` (selected, replayable) + `nonReplayableId` (passes the hard
 * gates, dual-judge classified replayable:false → non-hard excluded). The
 * manifest is the COMPLETE product of the real selector over this corpus
 * (the same pure helpers buildFairProvenanceFixture uses), so
 * validateFairManifestProvenance passes. Used by the selectionInfoOverride
 * tamper regression: the non-replayable hard-pass episode must never become
 * replayable through tampered override derived info.
 */
function buildFairNonReplayableFixture(dir, replayableIds, nonReplayableId) {
  const ids = [...replayableIds, nonReplayableId];
  const corpusEpisodes = ids.map((id) => eligibleEpisode(id));
  const corpusMeta = ids.map((id) => eligibleMeta(id));
  const metaById = new Map(corpusMeta.map((m) => [m.episode_id, m]));
  const downstreamJudges = [...F.DEFAULT_DOWNSTREAM_JUDGES];
  const hard = F.selectHardCandidates(corpusEpisodes, metaById, { limit: undefined, downstreamJudges });
  const protocol_hash = F.classifierProtocolHash();
  const judgeModels = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  const thinking = "medium";
  const checkpointDir = path.join(dir, "checkpoints-fair", "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  const exclusions = [];
  const stats = producerStats(corpusEpisodes, corpusMeta, exclusions);
  const classifications = [];
  const selected = [];
  const excluded = hard.excluded.map((e) => ({
    episode_id: e.episode_id, stage: "hard", reasons: e.reasons, join_confidence: e.join_confidence,
  }));
  const exclusion_distribution = { ...hard.distribution };
  const ALL_FALSE_FLAGS = {
    requires_workspace: false, requires_files: false, requires_commands: false,
    requires_live_external_state: false, requires_tool_verification: false,
  };
  for (const id of hard.candidates.map((c) => c.episode.episode_id)) {
    const ep = corpusEpisodes.find((e) => e.episode_id === id);
    const candidate = hard.candidates.find((x) => x.episode.episode_id === id);
    const pHash = F.promptHash(ep.prompt);
    const isReplayable = replayableIds.includes(id);
    const j0 = { ok: true, judgment: { schema_version: 1, replayable: isReplayable, ...ALL_FALSE_FLAGS, reasons: ["self-contained embedded text"], confidence: 0.85 } };
    const j1 = isReplayable
      ? { ok: true, judgment: { schema_version: 1, replayable: true, ...ALL_FALSE_FLAGS, reasons: ["self-contained embedded text"], confidence: 0.85 } }
      : { ok: true, judgment: { schema_version: 1, replayable: false, ...ALL_FALSE_FLAGS, requires_workspace: true, reasons: ["needs workspace"], confidence: 0.6 } };
    const merged = F.mergeDualJudgments(j0, j1, { judge0: judgeModels[0], judge1: judgeModels[1] });
    const attempt_log = {
      [judgeModels[0]]: [{ attempt: 0, request_id: `req-${id}-0`, model_ref: judgeModels[0], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(merged.judgments[judgeModels[0]])), usage: { input: 10, output: 5, cost: { total: 0.015 } }, cost: 0.015, cost_source: "provider" }],
      [judgeModels[1]]: [{ attempt: 0, request_id: `req-${id}-1`, model_ref: judgeModels[1], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(merged.judgments[judgeModels[1]])), usage: { input: 10, output: 5, cost: { total: 0.015 } }, cost: 0.015, cost_source: "provider" }],
    };
    const final = {
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: id,
      stage: "llm",
      classification_status: "completed",
      replayable: isReplayable,
      reasons: merged.reasons,
      confidence: merged.confidence,
      cost: 0.03,
      cost_source: "provider",
      cost_breakdown: { provider: 0.03, estimated: 0, unknown: 0 },
      has_unknown_cost: false,
      known_total: 0.03,
      attempts: 2,
      judge_models: judgeModels,
      prompt_hash: pHash,
      protocol_hash,
      thinking,
      from_checkpoint: false,
      mechanical: F.mechanicalExclude(ep.prompt),
      flags: merged.flags,
      disagreement: merged.disagreement,
      judgments: merged.judgments,
      attempt_log,
    };
    fs.writeFileSync(path.join(checkpointDir, `${id}.json`), `${JSON.stringify({
      ledger_version: F.ATTEMPT_LEDGER_VERSION,
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: id,
      prompt_hash: pHash,
      protocol_hash,
      judge_models: judgeModels,
      thinking,
      mechanical: F.mechanicalExclude(ep.prompt),
      judgments: merged.judgments,
      attempt_log,
      final,
      saved_at: "2026-08-12T00:00:00.000Z",
    }, null, 2)}\n`);
    classifications.push({
      episode_id: id, stage: "llm", replayable: isReplayable, reasons: merged.reasons, confidence: merged.confidence,
      join_confidence: null, cost: 0.03, cost_source: "provider", cost_breakdown: { provider: 0.03, estimated: 0, unknown: 0 }, from_checkpoint: false,
    });
    if (isReplayable) {
      selected.push({
        episode_id: id, models: candidate.models, join_confidence: candidate.join_confidence, tools: null,
        stage: "llm", replayable: true, confidence: merged.confidence, reasons: merged.reasons, flags: merged.flags,
        cost: 0.03, cost_source: "provider", cost_breakdown: { provider: 0.03, estimated: 0, unknown: 0 }, from_checkpoint: false,
      });
    } else {
      excluded.push({
        episode_id: id, stage: "llm", reasons: merged.reasons, join_confidence: candidate.join_confidence,
        confidence: merged.confidence, flags: merged.flags, cost: 0.03, cost_source: "provider", from_checkpoint: false,
      });
      for (const reason of merged.reasons) {
        const key = reason.startsWith("mechanical_") || reason.startsWith("dual_judge_")
          || reason.startsWith("either_") || reason.startsWith("judge_")
          ? reason
          : "llm_excluded";
        exclusion_distribution[key] = (exclusion_distribution[key] ?? 0) + 1;
      }
      exclusion_distribution.llm_total = (exclusion_distribution.llm_total ?? 0) + 1;
    }
  }
  selected.sort(F.compareSelectedRows);
  const join_selected = { exact: 0, heuristic: 0 };
  for (const s of selected) {
    if (s.join_confidence === "exact") join_selected.exact += 1;
    else if (s.join_confidence === "heuristic") join_selected.heuristic += 1;
  }
  const manifest = {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    kind: "prompt_only_replay_selection",
    generated_at: "2026-08-12T00:00:00.000Z",
    protocol_hash,
    thinking,
    judge_models: judgeModels,
    classifier_models: judgeModels,
    downstream_judges: downstreamJudges,
    classify: true,
    counts: {
      source: corpusEpisodes.length,
      hard_pass: hard.hard_pass_count,
      hard_pass_limited: hard.candidates.length,
      classified: classifications.length,
      replayable: selected.length,
      excluded: excluded.length,
      data_insufficient: false,
      join_hard_pass: { ...hard.join_tier },
      join_selected,
    },
    exclusion_distribution,
    cost: F.buildManifestCostSummary({
      // Cost covers the CLASSIFIED candidates (hard exclusions pay nothing).
      cost_breakdown: { provider: 0.03 * classifications.length, estimated: 0, unknown: 0 },
      known_total: 0.03 * classifications.length,
      has_unknown_cost: false,
    }),
    selected,
    excluded,
    classifications,
    episodes: "/abs/path/episodes.jsonl",
    meta: "/abs/path/episodes.meta.jsonl",
    limit: null,
    concurrency: 2,
    hard_only: false,
    episode_ids: selected.map((s) => s.episode_id),
  };
  const manifestPath = path.join(dir, "selection.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, episodes: corpusEpisodes, meta: corpusMeta, stats, exclusions };
}

function writeCorpus(dir, episodes, meta) {
  const episodesPath = path.join(dir, "episodes.jsonl");
  const metaPath = path.join(dir, "episodes.meta.jsonl");
  const exclusionsPath = path.join(dir, "exclusions.jsonl");
  const statsPath = path.join(dir, "stats.json");
  fs.writeFileSync(episodesPath, episodes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(metaPath, meta.map((m) => JSON.stringify(m)).join("\n") + "\n");
  fs.writeFileSync(exclusionsPath, "");
  fs.writeFileSync(statsPath, `${JSON.stringify(producerStats(episodes, meta, []), null, 2)}\n`);
  return { episodesPath, metaPath, exclusionsPath, statsPath };
}

await check("P0 determinism: first build vs full resume rebuild — five public byte payloads identical (zero provider calls on resume)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-five-1-"));
  try {
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const outDir = path.join(tmp, "out");
    const serve = (m) => ({ text: `Replay answer for ${m}.` });
    // Run 1: first build — the mock invoker serves both episodes (new
    // checkpoints written).
    const run1 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "det-five-1",
      invoker: makeReplayMockInvoker(serve),
    }));
    assert.equal(run1.episodes.length, 2, "first build must produce 2 body episodes");
    assert.equal(run1.run.requested, 2);
    assert.equal(run1.run.new_checkpoints, 2);
    assert.equal(run1.run.reused_requested, 0);
    assert.equal(run1.run.dataset_checkpoints, 2);
    assert.equal(run1.run.dataset_episodes, 2);
    const five1 = readFiveFiles(outDir);
    // Run 2: full resume rebuild — every checkpoint reused, the mock must
    // never be called (any call throws → test fails).
    const run2 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "det-five-1",
      invoker: makeReplayMockInvoker(() => { throw new Error("resume must make zero provider calls"); }),
    }));
    assert.equal(run2.run.new_checkpoints, 0);
    assert.equal(run2.run.reused_requested, 2);
    assert.equal(run2.run.dataset_checkpoints, 2);
    const five2 = readFiveFiles(outDir);
    for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.equal(five2[name], five1[name], `${name} must be byte-identical between first build and resume rebuild`);
    }
    // Public stats carry NO per-run fact: selected_this_run / new / reused
    // are absent (they live in buildReplay's private `run` return), and the
    // cumulative counts are recomputable from the checkpoint set.
    const stats = JSON.parse(five2["stats.json"]);
    assert.equal(stats.selection.selected_this_run, undefined, "selected_this_run must not be in public stats");
    assert.equal(stats.selection.cumulative, 2);
    assert.equal(stats.selection.cumulative_checkpoints, 2);
    // Absolute input paths are replaced by stable basenames (same-evidence
    // rebuild across directories must be byte-identical).
    assert.equal(stats.inputs.episodes, "episodes.jsonl");
    assert.equal(stats.inputs.meta, "episodes.meta.jsonl");
    assert.equal(stats.inputs.selection, null);
    // README must not carry the per-run fact either.
    assert.ok(!five2["README.md"].includes("selected_this_run"), "README must not mention selected_this_run");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("P0 determinism: exclusions canonicalization is order-independent (shuffled worker/scan order → identical bytes)", () => {
  const a = { episode_id: "ep-aaaa", reason: "no_replay_candidates", replay_models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"] };
  const b = { episode_id: "ep-bbbb", reason: "below_min_models", model_count: 1, min_models: 2 };
  const c = { episode_id: "ep-cccc", reason: "selection_resolve", reasons: ["no_strong_reference"] };
  const base = [a, b, c];
  const canonical = JSON.stringify(R.canonicalizeExclusions(base));
  const shuffled = JSON.stringify(R.canonicalizeExclusions([...base].reverse()));
  assert.equal(shuffled, canonical, "exclusion order must not depend on input order");
  // Identical (episode_id, reason) duplicates are deduped deterministically.
  const withDup = JSON.stringify(R.canonicalizeExclusions([b, a, a, c, b, c]));
  assert.equal(withDup, canonical, "duplicate (episode_id, reason) must be deduped deterministically");
  // Sorted by the stable closed tuple (stableStringify): episode_id asc.
  const out = R.canonicalizeExclusions([c, a, b]);
  assert.deepEqual(out.map((e) => e.episode_id), ["ep-aaaa", "ep-bbbb", "ep-cccc"], "canonical exclusion order must be the stable sorted tuple");
  // by_* / map-style stats keys are canonically sorted too.
  assert.deepEqual(Object.keys(R.sortedObject({ b: 1, a: 2, c: 3 })), ["a", "b", "c"]);
});

await check("canonicalizeExclusions: byte-identical duplicates dedupe order-independently; same episode_id+reason with different payloads fails closed in BOTH orders", () => {
  const rec = { episode_id: "ep-aaaa", reason: "no_replay_candidates", replay_models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"] };
  const other = { episode_id: "ep-bbbb", reason: "below_min_models", model_count: 1, min_models: 2 };
  // Identical records in shuffled input orders → identical canonical output.
  const outA = JSON.stringify(R.canonicalizeExclusions([other, rec, rec, other, rec]));
  const outB = JSON.stringify(R.canonicalizeExclusions([rec, other, other, rec, other]));
  assert.equal(outA, outB, "identical duplicates must dedupe to the same output regardless of input order");
  assert.equal(
    JSON.stringify(R.canonicalizeExclusions([rec, rec])),
    JSON.stringify(R.canonicalizeExclusions([rec])),
    "exact duplicates must collapse to a single record",
  );
  // JSON key-order-only variants are the SAME payload (stableStringify-equal)
  // and must dedupe, never fail.
  const swapped = {};
  for (const k of Object.keys(rec).reverse()) swapped[k] = rec[k];
  assert.deepEqual(R.canonicalizeExclusions([rec, swapped]), [rec], "key-order-only variants are the same payload and must dedupe");
  // Same episode_id+reason with a DIFFERENT payload must fail closed in both
  // input orders — never an arbitrary first-wins pick.
  const conflictA = { episode_id: "ep-aaaa", reason: "no_replay_candidates", replay_models: ["deepseek/deepseek-v4-flash"] };
  const conflictB = { episode_id: "ep-aaaa", reason: "no_replay_candidates", replay_models: ["xai/grok-4.5"] };
  for (const input of [[conflictA, conflictB], [conflictB, conflictA]]) {
    assert.throws(
      () => R.canonicalizeExclusions(input),
      /different payloads.*fail closed|fail closed/i,
      "same episode_id+reason with different payloads must fail closed in both input orders",
    );
  }
});

await check("P0 determinism: concurrency + scan order do not change the five files (exclusion-bearing checkpoint set)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-five-2-"));
  try {
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    // Pre-create the SAME deterministic checkpoint set in two dirs: FIX_R1
    // fails build (exclusion checkpoint), FIX_R2 succeeds (body checkpoint).
    const mkCp = (src, srcMeta, i) => {
      const contentHash = C.episodeContentHash(src);
      const protocolHash = R.buildReplayProtocolHash({
        selectionHash: "legacy", sourceContentHash: contentHash, models,
        thinking: src.thinking_level ?? "high", maxOutputBytes: 200_000, maxEpisodeBytes: 1_000_000,
        timeoutMs: 600_000, maxRetries: 2,
      });
      const results = i === 0
        ? [mockFailedResult("deepseek/deepseek-v4-flash"), mockFailedResult("xai/grok-4.5")]
        : [
          mockReplayResult("deepseek/deepseek-v4-flash", `Replay answer ${i} one.`, { thinking: src.thinking_level ?? "high" }),
          mockReplayResult("xai/grok-4.5", `Replay answer ${i} two.`, { thinking: src.thinking_level ?? "high" }),
        ];
      results[0].attempt_log[0].request_id = `req-${src.episode_id}-flash`;
      results[1].attempt_log[0].request_id = `req-${src.episode_id}-grok`;
      const built = R.buildReplayEpisode({
        sourceEpisode: src, sourceMeta: srcMeta, blindKey: blind.key, replayResults: results,
        corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS, selectionHash: null, protocolHash,
      });
      return {
        ledger_version: C.ATTEMPT_LEDGER_VERSION,
        schema_version: R.REPLAY_SCHEMA_VERSION,
        source_episode_id: src.episode_id,
        source_content_hash: contentHash,
        source_thinking: src.thinking_level ?? null,
        replay_thinking: src.thinking_level ?? "high",
        selection_hash: null,
        protocol_hash: protocolHash,
        experiment_mode: null,
        history_excluded: false,
        replay_models: models,
        replay_material: R.buildReplayMaterial(results),
        episode: built.episode,
        sidecar: built.sidecar,
        exclusion: built.exclusion,
        built_at: new Date().toISOString(),
      };
    };
    const blind = resolveBlindKey(path.join(tmp, "out3"), { seed: "det-five-2" });
    for (const [i, src] of [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]].entries()) {
      const cp = mkCp(src, FIXTURE_META[i], i);
      const replayEpisodeId = R.buildReplayEpisodeId(blind.key, src.episode_id, models);
      for (const d of [path.join(tmp, "out3"), path.join(tmp, "out4")]) {
        fs.mkdirSync(path.join(d, "checkpoints"), { recursive: true });
        fs.writeFileSync(path.join(d, "checkpoints", `${replayEpisodeId}.json`), `${JSON.stringify(cp, null, 2)}\n`);
      }
    }
    const never = () => { throw new Error("all checkpoints reused — provider must never be called"); };
    const run3 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: path.join(tmp, "out3"), "allow-legacy-select": true, quiet: true, seed: "det-five-2",
      concurrency: 1, invoker: makeReplayMockInvoker(never),
    }));
    const run4 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: path.join(tmp, "out4"), "allow-legacy-select": true, quiet: true, seed: "det-five-2",
      concurrency: 2, invoker: makeReplayMockInvoker(never),
    }));
    assert.equal(run3.episodes.length, 1, "FIX_R2 body only");
    assert.equal(run3.exclusions.length, 1, "FIX_R1 exclusion checkpoint contributes the exclusion");
    assert.equal(run3.exclusions[0].reason, "no_replay_candidates");
    const f3 = readFiveFiles(path.join(tmp, "out3"));
    const f4 = readFiveFiles(path.join(tmp, "out4"));
    for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.equal(f4[name], f3[name], `${name} must be byte-identical across concurrency/scan order (exclusions included)`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("P0 subset accumulation: --episode A then disjoint B on the same dir — pre-scan accepts A, mock serves only B, post-scan = A∪B; external cp still rejected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-subset-"));
  try {
    const ids = [FIX_R1, FIX_R2, FIX_R4, FIX_R5];
    const { manifestPath } = buildFairProvenanceFixture(tmp, ids);
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, ids.map(eligibleEpisode), ids.map(eligibleMeta));
    const outDir = path.join(tmp, "out");
    const subsetA = [FIX_R1, FIX_R4];
    const subsetB = [FIX_R2, FIX_R5];
    // Run A: first subset. The mock serves every requested item.
    const runA = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, episode: subsetA, output: outDir, quiet: true, seed: "p0-subset",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    assert.equal(runA.episodes.length, 2, "run A must produce 2 body episodes");
    assert.equal(runA.run.requested, 2);
    assert.equal(runA.run.new_checkpoints, 2);
    assert.equal(runA.run.dataset_checkpoints, 2);
    // Run B: disjoint subset on the SAME dir. The pre-scan must accept A's
    // checkpoints (they are legal manifest checkpoints — the scan context is
    // the FULL manifest), and the provider mock must only serve B's items
    // (A's checkpoints are reused).
    const bPrompts = new Set(subsetB.map((id) => eligibleEpisode(id).prompt));
    const invokerB = makeReplayMockInvoker((m, userText) => {
      if (![...bPrompts].some((p) => userText.includes(p))) {
        throw new Error(`mock must only serve B's missing items, got prompt: ${userText.slice(0, 80)}`);
      }
      return { text: `Replay answer for ${m}.` };
    });
    const runB = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, episode: subsetB, output: outDir, quiet: true, seed: "p0-subset",
      invoker: invokerB,
    }));
    assert.equal(runB.episodes.length, 4, "post-scan public set must be A∪B (4 body episodes)");
    assert.equal(runB.run.requested, 2);
    assert.equal(runB.run.new_checkpoints, 2, "B's items are new");
    assert.equal(runB.run.reused_requested, 0, "A's items are not requested this run");
    assert.equal(runB.run.dataset_checkpoints, 4);
    assert.equal(runB.run.dataset_episodes, 4);
    assert.equal(invokerB.calls.length, 4, "provider mock must only work for B's missing items (2 episodes × 2 models)");
    const publicIds = new Set(runB.episodes.map((e) => e.episode_id));
    for (const id of subsetA) assert.ok(publicIds.has(R.buildReplayEpisodeId(resolveBlindKey(outDir, { seed: "p0-subset" }).key, id, ["deepseek/deepseek-v4-flash", "xai/grok-4.5"])), `A item ${id} must stay in the public set`);
    for (const id of subsetB) assert.ok(publicIds.has(R.buildReplayEpisodeId(resolveBlindKey(outDir, { seed: "p0-subset" }).key, id, ["deepseek/deepseek-v4-flash", "xai/grok-4.5"])), `B item ${id} must be in the public set`);
    // A checkpoint for an episode OUTSIDE the manifest still fails closed.
    const externalId = "ep-0a1b2c3d4e5f60a9";
    const extName = R.buildReplayEpisodeId(resolveBlindKey(outDir, { seed: "p0-subset" }).key, externalId, ["deepseek/deepseek-v4-flash", "xai/grok-4.5"]);
    fs.writeFileSync(path.join(outDir, "checkpoints", `${extName}.json`), `${JSON.stringify({ source_episode_id: externalId, sidecar: { episode_id: "rep-x" } }, null, 2)}\n`);
    let extFailed = false;
    try {
      await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        selection: manifestPath, episode: subsetB, output: outDir, quiet: true, seed: "p0-subset",
        invoker: makeReplayMockInvoker((m) => ({ text: `x` })),
      }));
    } catch (err) {
      extFailed = true;
    }
    assert.ok(extFailed, "manifest-external checkpoint must fail the pre-scan closed");
    // A manifest-episode checkpoint with a STALE protocol still fails closed.
    fs.rmSync(path.join(outDir, "checkpoints", `${extName}.json`), { force: true });
    const r1File = fs.readdirSync(path.join(outDir, "checkpoints")).find((n) => {
      const cp = JSON.parse(fs.readFileSync(path.join(outDir, "checkpoints", n), "utf8"));
      return cp.source_episode_id === FIX_R1;
    });
    const stale = JSON.parse(fs.readFileSync(path.join(outDir, "checkpoints", r1File), "utf8"));
    stale.protocol_hash = "0".repeat(64);
    fs.writeFileSync(path.join(outDir, "checkpoints", r1File), `${JSON.stringify(stale, null, 2)}\n`);
    let staleFailed = false;
    try {
      await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        selection: manifestPath, episode: subsetB, output: outDir, quiet: true, seed: "p0-subset",
        invoker: makeReplayMockInvoker((m) => ({ text: `x` })),
      }));
    } catch (err) {
      staleFailed = true;
    }
    assert.ok(staleFailed, "stale-protocol checkpoint must fail closed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("P0 blind key: first atomic write; reuse never rewrites (bytes+mtime+write interception); pre-scan bad cp zero writes; explicit/seed conflict fails closed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-blindkey-"));
  try {
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const serve = (m) => ({ text: `Replay answer for ${m}.` });
    // 1) First persistence: fresh dir, seed → blind-key.json written once
    //    with the seed-derived key (source "seed").
    const outDir = path.join(tmp, "out");
    await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "p0-bk",
      invoker: makeReplayMockInvoker(serve),
    }));
    const keyFile = path.join(outDir, "blind-key.json");
    assert.ok(fs.existsSync(keyFile), "blind-key.json must be written on first persistence");
    const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    assert.equal(parsed.schema_version, 1, "persisted file closed shape");
    assert.match(parsed.blind_key, /^[0-9a-f]{64}$/, "persisted key must be 64 hex");
    assert.equal(parsed.source, "seed");
    const bytes1 = fs.readFileSync(keyFile, "utf8");
    const mtime1 = fs.statSync(keyFile).mtimeMs;
    // 2) Reuse (resume): the file must NOT be rewritten — bytes + mtime
    //    unchanged, and a write interception proves zero writes. A 1.1s
    //    pause makes any rewrite visible in mtime.
    await new Promise((r) => setTimeout(r, 1100));
    const writes = [];
    const origWrite = fs.writeFileSync;
    const origRename = fs.renameSync;
    fs.writeFileSync = function (file, ...rest) {
      if (String(file) === keyFile) writes.push("writeFileSync");
      return origWrite.call(this, file, ...rest);
    };
    fs.renameSync = function (from, to, ...rest) {
      if (String(to) === keyFile) writes.push("renameSync");
      return origRename.call(this, from, to, ...rest);
    };
    try {
      await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        output: outDir, "allow-legacy-select": true, quiet: true, seed: "p0-bk",
        invoker: makeReplayMockInvoker(() => { throw new Error("resume must not call the provider"); }),
      }));
    } finally {
      fs.writeFileSync = origWrite;
      fs.renameSync = origRename;
    }
    assert.deepEqual(writes, [], "reuse must not write blind-key.json (write interception)");
    assert.equal(fs.readFileSync(keyFile, "utf8"), bytes1, "blind-key.json bytes must be unchanged on reuse");
    assert.equal(fs.statSync(keyFile).mtimeMs, mtime1, "blind-key.json mtime must be unchanged on reuse");
    // 3) Pre-scan failure (bad checkpoint) → zero blind-key writes; a
    //    missing file stays missing.
    const badDir = path.join(tmp, "bad");
    fs.mkdirSync(path.join(badDir, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(badDir, "checkpoints", "garbage.json"), "{not json");
    const badKeyFile = path.join(badDir, "blind-key.json");
    const badWrites = [];
    fs.writeFileSync = function (file, ...rest) {
      if (String(file) === badKeyFile) badWrites.push("writeFileSync");
      return origWrite.call(this, file, ...rest);
    };
    fs.renameSync = function (from, to, ...rest) {
      if (String(to) === badKeyFile) badWrites.push("renameSync");
      return origRename.call(this, from, to, ...rest);
    };
    let badFailed = false;
    try {
      await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        output: badDir, "allow-legacy-select": true, quiet: true, seed: "p0-bk-bad",
        invoker: makeReplayMockInvoker(serve),
      }));
    } catch (err) {
      badFailed = true;
    }
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
    assert.ok(badFailed, "bad checkpoint must fail the run closed");
    assert.deepEqual(badWrites, [], "pre-scan failure must not write blind-key.json");
    assert.ok(!fs.existsSync(badKeyFile), "blind-key.json must not be created when the pre-scan fails");
    // 4) Explicit/seed conflict with an existing file → fail closed, never
    //    overwrite. seed "p0-bk" derives a different key than the file.
    const conflictKey = "cd".repeat(32);
    const conflictDir = path.join(tmp, "conflict");
    fs.mkdirSync(conflictDir, { recursive: true });
    fs.writeFileSync(path.join(conflictDir, "blind-key.json"), `${JSON.stringify({ schema_version: 1, blind_key: conflictKey, source: "generated" }, null, 2)}\n`);
    const conflictBytes = fs.readFileSync(path.join(conflictDir, "blind-key.json"), "utf8");
    let conflictFailed = false;
    try {
      await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        output: conflictDir, "allow-legacy-select": true, quiet: true, seed: "p0-bk",
        invoker: makeReplayMockInvoker(serve),
      }));
    } catch (err) {
      conflictFailed = true;
    }
    assert.ok(conflictFailed, "seed conflicting with the persisted key must fail closed");
    assert.equal(fs.readFileSync(path.join(conflictDir, "blind-key.json"), "utf8"), conflictBytes, "conflicting seed must not overwrite blind-key.json");
    // 5) Explicit --blind-key matching the persisted key → reuse (no
    //    rewrite), and stats record the FILE's own source ("generated") —
    //    reuse is decided by key equality, never by the parsed source field.
    const matchDir = path.join(tmp, "match");
    fs.mkdirSync(matchDir, { recursive: true });
    fs.writeFileSync(path.join(matchDir, "blind-key.json"), `${JSON.stringify({ schema_version: 1, blind_key: conflictKey, source: "generated" }, null, 2)}\n`);
    const matchBytes = fs.readFileSync(path.join(matchDir, "blind-key.json"), "utf8");
    const runMatch = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: matchDir, "allow-legacy-select": true, quiet: true, "blind-key": conflictKey,
      invoker: makeReplayMockInvoker(serve),
    }));
    assert.equal(fs.readFileSync(path.join(matchDir, "blind-key.json"), "utf8"), matchBytes, "matching explicit key must not rewrite blind-key.json");
    assert.equal(runMatch.stats.blind_key.source, "generated", "reused file's own source field is recorded (never judged by parsed source)");
    assert.equal(runMatch.stats.blind_key.sha256, C.sha256Hex(conflictKey), "stats carries only the key hash, never the raw key");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("P0 blind key: fresh full build with NO --seed/--blind-key — one key drives pre-scan, persisted file, checkpoints and post-scan; resume reuses it unchanged (zero writes, zero provider)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-blindkey-fresh-"));
  try {
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const outDir = path.join(tmp, "out");
    const serve = (m) => ({ text: `Replay answer for ${m}.` });
    // Run 1: fresh dir, no seed, no blind-key → resolveBlindKey generates one
    // key and the SAME blind must drive the pre-scan, the persisted file, the
    // checkpoints and the post-scan (a second random resolution would make
    // the post-scan reject the just-written checkpoints after provider work).
    const run1 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true,
      invoker: makeReplayMockInvoker(serve),
    }));
    assert.equal(run1.episodes.length, 2, "fresh no-seed build must produce 2 body episodes");
    assert.equal(run1.run.new_checkpoints, 2);
    const keyFile = path.join(outDir, "blind-key.json");
    assert.ok(fs.existsSync(keyFile), "blind-key.json must be written on first persistence");
    const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    assert.equal(parsed.schema_version, 1, "persisted file closed shape");
    assert.match(parsed.blind_key, /^[0-9a-f]{64}$/, "persisted key must be canonical lowercase 64 hex");
    assert.equal(parsed.source, "generated", "no seed / no blind-key → persisted source is generated");
    // The persisted key IS the key that bound the pre/post checkpoint scan:
    // every checkpoint filename is derived from it (the post-scan validated
    // them — the run succeeded), so the checkpoint set is consistent with the
    // persisted key and stats carry only its hash.
    for (const src of [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]]) {
      const expectedName = `${R.buildReplayEpisodeId(parsed.blind_key, src.episode_id, FIXTURE_OPTIONS.models)}.json`;
      assert.ok(fs.existsSync(path.join(outDir, "checkpoints", expectedName)), `checkpoint ${expectedName} must exist under the persisted key`);
    }
    assert.equal(run1.stats.blind_key.sha256, C.sha256Hex(parsed.blind_key), "stats must carry only the persisted key hash");
    const bytes1 = fs.readFileSync(keyFile, "utf8");
    // Run 2: full resume with NO seed/blind-key — the persisted key is
    // reused, the file is never rewritten (write interception), and the
    // provider is never called.
    await new Promise((r) => setTimeout(r, 1100));
    const writes = [];
    const origWrite = fs.writeFileSync;
    const origRename = fs.renameSync;
    fs.writeFileSync = function (file, ...rest) {
      if (String(file) === keyFile) writes.push("writeFileSync");
      return origWrite.call(this, file, ...rest);
    };
    fs.renameSync = function (from, to, ...rest) {
      if (String(to) === keyFile) writes.push("renameSync");
      return origRename.call(this, from, to, ...rest);
    };
    let run2;
    try {
      run2 = await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        output: outDir, "allow-legacy-select": true, quiet: true,
        invoker: makeReplayMockInvoker(() => { throw new Error("resume must not call the provider"); }),
      }));
    } finally {
      fs.writeFileSync = origWrite;
      fs.renameSync = origRename;
    }
    assert.deepEqual(writes, [], "resume must not write blind-key.json (write interception)");
    assert.equal(fs.readFileSync(keyFile, "utf8"), bytes1, "blind-key.json bytes must be unchanged on resume");
    assert.equal(run2.run.reused_requested, 2, "resume reuses both checkpoints");
    assert.equal(run2.run.new_checkpoints, 0);
    assert.equal(run2.stats.blind_key.sha256, C.sha256Hex(parsed.blind_key), "resume stats must carry the same persisted key hash");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("P0 blind key: malformed / extra-key / missing-key / bad schema / non-canonical / illegal-source blind-key.json fails closed BEFORE makeJudgeInvoker (zero writes, zero provider)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-blindkey-shape-"));
  try {
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const key = "ab".repeat(32);
    const cases = [
      { name: "malformed JSON", content: "{not json" },
      { name: "extra key", content: `${JSON.stringify({ schema_version: 1, blind_key: key, source: "generated", extra: 1 }, null, 2)}\n` },
      { name: "missing key", content: `${JSON.stringify({ schema_version: 1, blind_key: key }, null, 2)}\n` },
      { name: "bad schema_version", content: `${JSON.stringify({ schema_version: 2, blind_key: key, source: "generated" }, null, 2)}\n` },
      { name: "non-canonical case", content: `${JSON.stringify({ schema_version: 1, blind_key: key.toUpperCase(), source: "generated" }, null, 2)}\n` },
      { name: "illegal source", content: `${JSON.stringify({ schema_version: 1, blind_key: key, source: "reused" }, null, 2)}\n` },
      { name: "non-object file", content: `[1,2,3]\n` },
    ];
    for (const tc of cases) {
      const outDir = path.join(tmp, tc.name.replace(/\s+/g, "-"));
      fs.mkdirSync(outDir, { recursive: true });
      const keyFile = path.join(outDir, "blind-key.json");
      fs.writeFileSync(keyFile, tc.content);
      const bytes = fs.readFileSync(keyFile, "utf8");
      // models-json points at a NONEXISTENT file: if makeJudgeInvoker were
      // reached it would throw an ENOENT naming it; the persist preflight
      // must fail FIRST with the shape error. The injected invoker must also
      // never be reached. No seed/blind-key: resolveBlindKey reads the file
      // itself (key matches trivially), so ONLY the strict closed-shape
      // preflight can reject — never a key-conflict mask.
      const missingRegistry = path.join(tmp, "no-such-registry.json");
      let failed = false;
      let msg = "";
      try {
        await R.buildReplay(R.parseArgs({
          episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
          output: outDir, "allow-legacy-select": true, quiet: true,
          "models-json": missingRegistry,
          invoker: makeReplayMockInvoker(() => { throw new Error("provider must never be called"); }),
        }));
      } catch (err) {
        failed = true;
        msg = err.message;
      }
      assert.ok(failed, `${tc.name}: must fail closed`);
      assert.ok(!msg.includes("no-such-registry.json"), `${tc.name}: makeJudgeInvoker must never be reached`);
      assert.ok(!msg.includes("provider must never be called"), `${tc.name}: provider must never be reached`);
      assert.equal(fs.readFileSync(keyFile, "utf8"), bytes, `${tc.name}: blind-key.json must not be rewritten`);
      assert.ok(!fs.existsSync(path.join(outDir, "episodes.jsonl")), `${tc.name}: no output files written`);
      assert.ok(!fs.existsSync(path.join(outDir, "checkpoints")), `${tc.name}: no checkpoints written`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── A: historical raw-output redaction + fail-closed preflight ────────────

await check("A: historical slots with UUIDv7 / run id / model identity are re-redacted — original tokens never enter the body; prompt re-redaction still passes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-hist-redact-"));
  try {
    const v7_019f = "019ff87f-13bd-70c8-abca-e4bb132c6140";
    const v7_01a0 = "01a0abcd-ef01-7a01-b234-567890abcdef";
    const runId = "dtr_0123456789abcdef0123456789abcdef";
    const rawLeak = `Session ${v7_019f} / ${v7_01a0} — ${runId} — openai/gpt-5.5 answered: the anchor scope fix is correct.`;
    const src = {
      ...FIXTURE_EPISODES[0],
      prompt: `Review the R4 changes. Session ${v7_019f} run ${runId} was used.`,
      slots: [
        { ...FIXTURE_EPISODES[0].slots[0], output: rawLeak, output_chars: rawLeak.length },
        { ...FIXTURE_EPISODES[0].slots[1], output: "The fix looks good. No new issues found." },
        FIXTURE_EPISODES[0].slots[2],
      ],
    };
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [src, FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const outDir = path.join(tmp, "out");
    const run = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "hist-redact",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    assert.equal(run.episodes.length, 2, "both episodes build (UUIDv7 / run id is redactable, not ambiguous)");
    const bodyText = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8");
    // No original identity token anywhere in the public body (historical slot
    // output AND source prompt, both re-redacted with the episode-local
    // redactor).
    for (const tok of [v7_019f, v7_01a0, runId, "openai/gpt-5.5", "019f", "01a0", "dtr_0123456789"]) {
      assert.ok(!bodyText.includes(tok), `identity token must not appear in the body: ${tok}`);
    }
    // Redaction placeholders are present and the independent oracle accepts
    // the whole published body.
    assert.ok(bodyText.includes("[session]"), "UUIDv7 must be replaced with [session]");
    assert.ok(bodyText.includes("[run]"), "run id must be replaced with [run]");
    assert.ok(/\[model-[a-z]\]/.test(bodyText), "model identity must be replaced with an episode-local pseudonym");
    for (const line of bodyText.trim().split("\n").filter(Boolean)) {
      assertAnonymousReplayBody(JSON.parse(line), "redacted historical body");
    }
    // The raw leaked output appears in NO public file.
    for (const name of ["episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.ok(!fs.readFileSync(path.join(outDir, name), "utf8").includes(rawLeak), `${name} must not carry the raw historical output`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: source preflight — ambiguous identity tokens in historical raw outputs reject the episode BEFORE makeJudgeInvoker (zero provider calls for it, exclusion recorded)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-hist-ambig-"));
  try {
    // FIX_R2's first historical output carries a bare ambiguous token ("K3"
    // is a downstream judge basename AND an ordinary criterion — never
    // guess/redact).
    const ambig = {
      ...FIXTURE_EPISODES[1],
      slots: [{ ...FIXTURE_EPISODES[1].slots[0], output: "Verdict: K3 says SIGN.", output_chars: "Verdict: K3 says SIGN.".length }, FIXTURE_EPISODES[1].slots[1], FIXTURE_EPISODES[1].slots[2]],
    };
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], ambig], [FIXTURE_META[0], FIXTURE_META[1]]);
    const outDir = path.join(tmp, "out");
    const calls = [];
    const run = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "hist-ambig",
      invoker: makeReplayMockInvoker((m, userText) => {
        calls.push(userText);
        return { text: `Replay answer for ${m}.` };
      }),
    }));
    assert.equal(run.episodes.length, 1, "only the clean episode builds");
    assert.equal(run.exclusions.length, 1, "the ambiguous episode is excluded");
    assert.equal(run.exclusions[0].episode_id, FIX_R2);
    assert.equal(run.exclusions[0].reason, "source_ambiguous_identity_token");
    assert.deepEqual(run.exclusions[0].tokens, ["K3"]);
    // Rejected BEFORE any provider work: only the clean episode's 2 replay
    // calls happened (2 models × 1 episode).
    assert.equal(calls.length, 2, "zero provider calls for the rejected episode");
    const cpFiles = fs.readdirSync(path.join(outDir, "checkpoints")).filter((n) => n.endsWith(".json"));
    assert.equal(cpFiles.length, 1, "no checkpoint for the rejected episode");
    assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "checkpoints", cpFiles[0]), "utf8")).source_episode_id, FIX_R1);
    // The ambiguous historical output never appears in any public file.
    for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.ok(!fs.readFileSync(path.join(outDir, name), "utf8").includes("K3 says SIGN"), `${name} must not carry the ambiguous historical output`);
    }
    // A run whose ONLY requested episode is preflight-rejected fails closed
    // (no replayable episodes) — never a silent empty build.
    let emptyFailed = false;
    try {
      await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        output: path.join(tmp, "out2"), "allow-legacy-select": true, quiet: true, seed: "hist-ambig",
        episode: [FIX_R2],
        invoker: makeReplayMockInvoker(() => { throw new Error("must never be called"); }),
      }));
    } catch (err) {
      emptyFailed = true;
    }
    assert.ok(emptyFailed, "a run whose only requested episode is preflight-rejected must fail closed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: source-oracle rejection public exclusions carry the FIXED detail (never the oracle assertion wording) — different oracle assertion texts yield byte-identical public payloads", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-src-oracle-fixed-"));
  try {
    // Two different oracle-failing source prompts (different episodes →
    // different assertion `where` labels → different real messages): one
    // trips the partial-criteria rule in the M-first order, the other in the
    // pseudonym-first order — same fixed public detail.
    const badA = { ...FIXTURE_EPISODES[0], prompt: "Criteria list: M1/M1/[model-x] for scoring." };
    const badB = { ...FIXTURE_EPISODES[1], prompt: "[model-x]/M1 for scoring." };
    fs.mkdirSync(path.join(tmp, "corpusA"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "corpusB"), { recursive: true });
    const corpusA = writeCorpus(path.join(tmp, "corpusA"), [badA, eligibleEpisode(FIX_R2)], [eligibleMeta(FIX_R1), eligibleMeta(FIX_R2)]);
    const corpusB = writeCorpus(path.join(tmp, "corpusB"), [eligibleEpisode(FIX_R1), badB], [eligibleMeta(FIX_R1), eligibleMeta(FIX_R2)]);
    const runA = await R.buildReplay(R.parseArgs({
      episodes: corpusA.episodesPath, meta: corpusA.metaPath, exclusions: corpusA.exclusionsPath, stats: corpusA.statsPath,
      output: path.join(tmp, "outA"), "allow-legacy-select": true, quiet: true, seed: "src-oracle-fixed-a",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    const runB = await R.buildReplay(R.parseArgs({
      episodes: corpusB.episodesPath, meta: corpusB.metaPath, exclusions: corpusB.exclusionsPath, stats: corpusB.statsPath,
      output: path.join(tmp, "outB"), "allow-legacy-select": true, quiet: true, seed: "src-oracle-fixed-b",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    const exA = runA.exclusions.find((e) => e.reason === "source_oracle_content_rejected");
    const exB = runB.exclusions.find((e) => e.reason === "source_oracle_content_rejected");
    assert.ok(exA && exB, "both runs must record a source_oracle_content_rejected exclusion");
    assert.equal(exA.detail, R.REPLAY_SOURCE_ORACLE_REJECTION_ERROR, "public exclusion detail must be the fixed marker");
    assert.equal(exB.detail, R.REPLAY_SOURCE_ORACLE_REJECTION_ERROR, "public exclusion detail must be the fixed marker regardless of the oracle assertion text");
    assert.ok(!exA.detail.includes("partially replaced") && !exA.detail.includes("leaks"), "public detail must not carry oracle assertion wording");
    assert.ok(!exB.detail.includes("partially replaced") && !exB.detail.includes("leaks"), "public detail must not carry oracle assertion wording");
    // The real assertion messages differ, but the public payloads are
    // byte-identical for the same episode shape.
    const exclusionsTextA = fs.readFileSync(path.join(tmp, "outA", "exclusions.jsonl"), "utf8");
    const exclusionsTextB = fs.readFileSync(path.join(tmp, "outB", "exclusions.jsonl"), "utf8");
    const recA = exclusionsTextA.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.reason === "source_oracle_content_rejected");
    const recB = exclusionsTextB.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.reason === "source_oracle_content_rejected");
    // The records differ only in episode_id (different rejected episodes);
    // the fixed detail + stable shape must be identical.
    assert.deepEqual(
      { ...recA, episode_id: "<ep>" },
      { ...recB, episode_id: "<ep>" },
      "the public source-oracle rejection records must be identical across different oracle assertion texts",
    );
    assert.deepEqual(recA, { episode_id: recA.episode_id, reason: "source_oracle_content_rejected", detail: R.REPLAY_SOURCE_ORACLE_REJECTION_ERROR }, "the public record must be exactly the stable shape");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── A2: source ep-id redaction + full source-body preflight + oracle guards ─

await check("A: source ep-id + UUIDv7 + dtr + model identity in prompt AND historical output are fully de-identified; the same source id in a successful replay output is de-identified too; alnum-context boundary forms (artifact_ep-… / uppercase EP-…) become [episode] while anonymous rep-/slot-rep- ids survive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-epred-"));
  try {
    const v7 = "019ff87f-13bd-70c8-abca-e4bb132c6140";
    const v7b = "01a0abcd-ef01-7a01-b234-567890abcdef";
    const runId = "dtr_0123456789abcdef0123456789abcdef";
    const srcId = FIX_R1;
    // Boundary forms: artifact_ep-<16 hex> (underscore is a word char, \b
    // misses it) and uppercase EP-<16 hex> must BOTH be caught; the
    // anonymous rep-<16 hex> / slot-rep-… HMAC ids must be preserved.
    // Underscore-delimited vendor/family tokens (file names: dossier_openai_
    // review.md, run_deepseek/deepseek-v4-flash_log) and run ids in
    // artifact_dtr_… / _dtr_…_ / uppercase DTR_… forms must ALL be
    // de-identified (shared alnum-context boundary).
    const src = {
      ...FIXTURE_EPISODES[0],
      prompt: `Review episode ${srcId} in session ${v7} (run ${runId}) — openai/gpt-5.5 answered first. See artifact_ep-0123456789abcdef.json and EP-0123456789ABCDEF; rep-0123456789abcdef and slot-rep-0123456789abcdef-0123456789ab are anonymous ids. See dossier_openai_review.md and run_deepseek/deepseek-v4-flash_log; the artifact_${runId}.json and ${runId.toUpperCase()} and _${runId}_ were cited.`,
      slots: (() => {
        const histOutput = `Answer for ${srcId}: artifact_ep-0123456789abcdef.json and EP-0123456789ABCDEF; session ${v7b}, run ${runId}, deepseek-v4-pro says the anchor fix is correct. See _grok-4.5_ and run_deepseek-v4_flash_log in dossier_openai_review.md.`;
        return [
          { ...FIXTURE_EPISODES[0].slots[0], output: histOutput, output_chars: histOutput.length },
          { ...FIXTURE_EPISODES[0].slots[1], output: "The fix looks good. No new issues found." },
          FIXTURE_EPISODES[0].slots[2],
        ];
      })(),
    };
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [src, FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const outDir = path.join(tmp, "out");
    // The successful replay output carries the SAME source episode id (both
    // boundary forms) + a model identity + underscore-delimited vendor/family
    // tokens + run id forms — all must be de-identified.
    const run = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "ep-red",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay of ${srcId} / artifact_ep-0123456789abcdef / EP-0123456789ABCDEF using openai/gpt-5.5 in session ${v7} / ${runId}; see dossier_openai_review.md, run_deepseek/deepseek-v4-flash_log, artifact_${runId}.json and _gpt-5.5_.` })),
    }));
    assert.equal(run.episodes.length, 2, "both episodes build (ep-id is redactable, not ambiguous)");
    const bodyText = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8");
    for (const tok of [srcId, v7, v7b, runId, "openai/gpt-5.5", "deepseek-v4-pro", "grok-4.5", "019ff87f", "01a0abcd", "dtr_0123456789", "artifact_ep-0123456789abcdef", "EP-0123456789ABCDEF", "dossier_openai_review", "run_deepseek", "deepseek-v4-flash_log", "_gpt-5.5_"]) {
      assert.ok(!bodyText.includes(tok), `identity token must not appear in the body: ${tok}`);
    }
    assert.ok(bodyText.includes("artifact_[episode].json"), "underscore-delimited artifact_ep-… must be replaced with [episode] (separator context preserved)");
    assert.ok(bodyText.includes("[episode]"), "source episode id must be replaced with [episode]");
    assert.ok(bodyText.includes("[session]"), "UUIDv7 must be replaced with [session]");
    assert.ok(bodyText.includes("[run]"), "run id must be replaced with [run]");
    assert.ok(/\[model-[a-z]\]/.test(bodyText), "model identity must be replaced with an episode-local pseudonym");
    // Anonymous ids are NEVER matched by the source-ep-id transform ("ep" in
    // rep-/slot-rep- is preceded by an alphanumeric "r").
    assert.ok(bodyText.includes("rep-0123456789abcdef"), "anonymous rep-<16 hex> id must be preserved");
    assert.ok(bodyText.includes("slot-rep-0123456789abcdef-0123456789ab"), "anonymous slot-rep-… id must be preserved");
    for (const line of bodyText.trim().split("\n").filter(Boolean)) {
      assertAnonymousReplayBody(JSON.parse(line), "de-identified replay body");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: fair + legacy paths — bare K3 / M2 / residual m2 in the source PROMPT rejects the episode before provider/key write; a normal M2 is never rewritten into a model pseudonym", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-prompt-ambig-"));
  try {
    for (const [label, prompt, expected] of [
      ["bare K3", "The K3 criterion applies to the review.", ["K3"]],
      ["bare M2", "Apply criterion M2 to all candidates.", ["M2"]],
      ["residual m2", "Check item m2 in the list.", ["M2"]],
    ]) {
      const src = { ...FIXTURE_EPISODES[0], prompt };
      const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [src, FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
      const outDir = path.join(tmp, `out-${label.replace(/\s+/g, "-")}`);
      const calls = [];
      const run = await R.buildReplay(R.parseArgs({
        episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
        output: outDir, "allow-legacy-select": true, quiet: true, seed: `prompt-ambig-${label}`,
        invoker: makeReplayMockInvoker((m, userText) => { calls.push(userText); return { text: `Replay answer for ${m}.` }; }),
      }));
      assert.equal(run.episodes.length, 1, `${label}: only the clean episode builds`);
      const ex = run.exclusions.find((e) => e.episode_id === FIX_R1);
      assert.ok(ex, `${label}: prompt-ambiguous episode must be excluded`);
      assert.equal(ex.reason, "source_ambiguous_identity_token", `${label}: exclusion reason`);
      assert.deepEqual(ex.tokens, expected, `${label}: offending tokens`);
      assert.equal(calls.length, 2, `${label}: zero provider calls for the rejected episode`);
      // The normal criterion is never rewritten into a model pseudonym.
      const exText = fs.readFileSync(path.join(outDir, "exclusions.jsonl"), "utf8");
      assert.ok(!exText.includes("[model-"), `${label}: exclusion must not contain a model pseudonym`);
      const bodyText = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8");
      assert.ok(!bodyText.includes("[model-unknown]"), `${label}: body must not contain the generic residual pseudonym`);
      // A run whose ONLY requested episode is prompt-rejected fails closed
      // BEFORE provider AND before the blind-key write.
      const failDir = path.join(tmp, `fail-${label.replace(/\s+/g, "-")}`);
      let failed = false;
      try {
        await R.buildReplay(R.parseArgs({
          episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
          output: failDir, "allow-legacy-select": true, quiet: true, seed: `prompt-ambig-fail-${label}`,
          episode: [FIX_R1],
          invoker: makeReplayMockInvoker(() => { throw new Error("must never be called"); }),
        }));
      } catch (err) { failed = true; }
      assert.ok(failed, `${label}: a run whose only requested episode is prompt-rejected must fail closed`);
      assert.ok(!fs.existsSync(path.join(failDir, "blind-key.json")), `${label}: no blind-key.json written`);
      assert.ok(!fs.existsSync(path.join(failDir, "episodes.jsonl")), `${label}: no public files written`);
    }
    // Unit: the empty-residual redactor leaves a normal M2 untouched (never
    // a model pseudonym).
    const unitRedact = buildEpisodeRedactor("k".repeat(64), "rep-0123456789abcdef", FIXTURE_CORPUS, []).redact;
    assert.equal(unitRedact("Apply criterion M2 to all candidates."), "Apply criterion M2 to all candidates.", "a normal M2 must never be rewritten by the redactor");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: orphan/non-published historical output with m2 does not affect a clean prompt's transform; historyExcluded=true historical m2 never touches the body, but a prompt m2 is still rejected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-orphan-"));
  try {
    // (a) Orphan historical slot (no matching meta slot → no model) with an
    // m2 output: the shared source-body definition excludes it — the build
    // proceeds and the orphan surface never touches the transform.
    const orphanSrc = {
      ...FIXTURE_EPISODES[0],
      slots: [
        { ...FIXTURE_EPISODES[0].slots[0], output: "Verdict: m2 criteria apply.", output_chars: "Verdict: m2 criteria apply.".length },
        FIXTURE_EPISODES[0].slots[1],
        FIXTURE_EPISODES[0].slots[2],
      ],
    };
    const orphanMeta = { ...FIXTURE_META[0], slots: [FIXTURE_META[0].slots[1], FIXTURE_META[0].slots[2]] };
    const builtOrphan = R.buildReplayEpisode({
      sourceEpisode: orphanSrc, sourceMeta: orphanMeta, blindKey: "k".repeat(64),
      replayResults: [
        mockReplayResult("deepseek/deepseek-v4-flash", "Replay answer one."),
        mockReplayResult("xai/grok-4.5", "Replay answer two."),
      ],
      corpusModelNames: FIXTURE_CORPUS, options: FIXTURE_OPTIONS,
    });
    assert.ok(builtOrphan.episode, "orphan m2 must not reject the episode");
    assert.ok(!JSON.stringify(builtOrphan.episode).includes("m2"), "orphan m2 must never enter the body");
    assertAnonymousReplayBody(builtOrphan.episode, "orphan-m2 body");
    assert.ok(builtOrphan.sidecar.slots.some((s) => s.source?.kind === "historical" && s.exclusion_reason === "historical_model_missing"), "the orphan historical slot is recorded as model-missing in the sidecar");

    // (b) current-only / historyExcluded=true: a PUBLISHABLE historical slot
    // with m2 never touches the body; a clean prompt builds all candidates.
    const histSrc = {
      ...FIXTURE_EPISODES[0],
      slots: [
        { ...FIXTURE_EPISODES[0].slots[0], output: "Verdict: m2 criteria apply.", output_chars: "Verdict: m2 criteria apply.".length },
        FIXTURE_EPISODES[0].slots[1],
        FIXTURE_EPISODES[0].slots[2],
      ],
    };
    const ids = [FIX_R1, FIX_R2, FIX_R4];
    const fixtureDir = path.join(tmp, "fair");
    const { manifestPath } = buildFairProvenanceFixture(fixtureDir, ids, { episodesOverride: { [FIX_R1]: histSrc } });
    const corpusDir = path.join(tmp, "corpus");
    fs.mkdirSync(corpusDir, { recursive: true });
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(corpusDir, ids.map((id) => (id === FIX_R1 ? histSrc : eligibleEpisode(id))), ids.map(eligibleMeta));
    const curOut = path.join(tmp, "cur");
    const run = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, "current-only": true, output: curOut, quiet: true, seed: "orphan-cur",
      invoker: makeReplayMockInvoker((m) => ({ text: `Current answer for ${m}.` })),
    }));
    assert.equal(run.episodes.length, 3, "current-only: historical m2 must not reject the episode");
    const curBody = fs.readFileSync(path.join(curOut, "episodes.jsonl"), "utf8");
    assert.ok(!curBody.includes("m2"), "current-only: historical m2 must never enter the body");
    for (const line of curBody.trim().split("\n").filter(Boolean)) assertAnonymousReplayBody(JSON.parse(line), "current-only body");

    // (c) current-only with a PROMPT m2 is still rejected before provider.
    const badSrc = { ...FIXTURE_EPISODES[0], prompt: "Check item m2 in the list." };
    const fixtureDir2 = path.join(tmp, "fair2");
    const { manifestPath: manifestPath2 } = buildFairProvenanceFixture(fixtureDir2, ids, { episodesOverride: { [FIX_R1]: badSrc } });
    const corpusDir2 = path.join(tmp, "corpus2");
    fs.mkdirSync(corpusDir2, { recursive: true });
    const { episodesPath: ep2, metaPath: meta2, exclusionsPath: exclusions2Path, statsPath: st2 } = writeCorpus(corpusDir2, ids.map((id) => (id === FIX_R1 ? badSrc : eligibleEpisode(id))), ids.map(eligibleMeta));
    const curOut2 = path.join(tmp, "cur2");
    const calls = [];
    const run2 = await R.buildReplay(R.parseArgs({
      episodes: ep2, meta: meta2, exclusions: exclusions2Path, stats: st2,
      selection: manifestPath2, "current-only": true, output: curOut2, quiet: true, seed: "orphan-cur2",
      invoker: makeReplayMockInvoker((m, userText) => { calls.push(userText); return { text: `Current answer for ${m}.` }; }),
    }));
    assert.equal(run2.episodes.length, 2, "current-only: the prompt-m2 episode is rejected");
    const ex2 = run2.exclusions.find((e) => e.episode_id === FIX_R1);
    assert.ok(ex2 && ex2.reason === "source_ambiguous_identity_token", "current-only prompt m2 must be rejected");
    assert.equal(calls.length, 6, "zero provider calls for the rejected episode (2 episodes × 3 models)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: production write guard — a structurally valid body whose CONTENT carries a source ep-id / model token is rejected by the oracle final guard BEFORE any fs write (no five files)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-write-oracle-"));
  try {
    const stats = { schema_version: 1 };
    const cases = [
      { name: "source ep id in prompt", prompt: "Review ep-0123456789abcdef here.", output: "Answer.", err: /source episode id/ },
      { name: "model name in output", prompt: "Clean prompt.", output: "I recommend openai/gpt-5.5.", err: /model name|basename/ },
    ];
    for (const tc of cases) {
      const outDir = path.join(tmp, tc.name.replace(/\s+/g, "-"));
      const leakyEp = {
        schema_version: 3,
        dataset_mode: "replay",
        episode_id: "rep-0123456789abcdef",
        prompt: tc.prompt,
        thinking: "high",
        tools: null,
        slots: [{ slot_id: "slot-rep-0123456789abcdef-0123456789ab", model_id: "c0", output: tc.output, result: "ok" }],
      };
      // Structurally valid: assertAnonymousBody alone would pass — only the
      // oracle CONTENT guard can see the leak.
      R.assertAnonymousBody(leakyEp);
      assert.throws(() => R.writeOutputs(outDir, { episodes: [leakyEp], sidecar: [], exclusions: [], stats }), tc.err, `${tc.name}: oracle final guard must reject`);
      // The guard completes BEFORE any filesystem write: the dir itself must
      // not be created (mkdir happens after every guard).
      assert.ok(!fs.existsSync(outDir), `${tc.name}: output dir must not be created`);
      for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
        assert.ok(!fs.existsSync(path.join(outDir, name)), `${tc.name}: ${name} must not be written`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: successful replay output failing the independent oracle is slot-level fail-closed (checkpoint still valid, never in body); a source body oracle anomaly fails BEFORE provider", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-oracle-slot-"));
  try {
    // (a) slot-level: flash's redacted/capped candidate fails the oracle
    // (partial criteria "M1/M1/[model-x]" — the signature of a partially
    // redacted model name), grok's is clean. The content is chosen so the
    // ambiguous detector / redactor do NOT consume it first: "M1" is not an
    // ambiguous identity token and "[model-x]" is not a known redactor
    // token, so the failure is attributable to the ORACLE alone. The
    // episode still builds with the clean slots; the failing slot is
    // recorded as a fail-closed exclusion and the checkpoint set stays
    // valid (the run's post-scan validates every checkpoint).
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const outDir = path.join(tmp, "out");
    const run = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outDir, "allow-legacy-select": true, quiet: true, seed: "oracle-slot",
      invoker: makeReplayMockInvoker((m) => ({
        text: m.includes("flash") ? "Criteria list: M1/M1/[model-x] for scoring." : `Replay answer for ${m}.`,
      })),
    }));
    assert.equal(run.episodes.length, 2, "both episodes build (the failing slot is excluded, the episode is not)");
    const bodyText = fs.readFileSync(path.join(outDir, "episodes.jsonl"), "utf8");
    assert.ok(!bodyText.includes("M1/M1/[model-x]"), "the oracle-failing replay output must never enter the body");
    for (const line of bodyText.trim().split("\n").filter(Boolean)) assertAnonymousReplayBody(JSON.parse(line), "oracle-slot body");
    const metaText = fs.readFileSync(path.join(outDir, "episodes.meta.jsonl"), "utf8");
    const flashSlots = metaText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).flatMap((r) => r.slots).filter((s) => s.source?.kind === "replay" && s.model === "deepseek/deepseek-v4-flash");
    assert.equal(flashSlots.length, 2, "one failing flash slot per episode");
    for (const s of flashSlots) {
      assert.equal(s.in_body, false, "the oracle-failing slot must stay out of the body");
      assert.equal(s.exclusion_reason, "replay_oracle_content_rejected", "slot-level fail-closed exclusion reason");
      // The sidecar error is the FIXED protocol-stable marker — the oracle's
      // assertion DETAIL (which token leaked, in which wording) must never
      // become a stable semantic of the checkpoint public sidecar, so an
      // oracle-text edit cannot invalidate checkpoints.
      assert.equal(s.replay.error, R.REPLAY_ORACLE_REJECTION_ERROR, "sidecar replay.error must be the exact fixed marker");
      assert.ok(!s.replay.error.includes("partially replaced") && !s.replay.error.includes("leaks"),
        `sidecar replay.error must not carry the oracle's specific assertion message: ${s.replay.error}`);
    }
    // (b) source body oracle anomaly: the source prompt itself fails the
    // oracle after the transform — the whole round fails BEFORE provider /
    // key write (zero provider calls, no blind-key.json, no public files).
    const badSrc = { ...FIXTURE_EPISODES[0], prompt: "Criteria list: M1/M1/[model-x] for scoring." };
    const fixtureDir = path.join(tmp, "fair");
    const ids = [FIX_R1, FIX_R2];
    const { manifestPath } = buildFairProvenanceFixture(fixtureDir, ids, { episodesOverride: { [FIX_R1]: badSrc } });
    const corpusDir = path.join(tmp, "corpus2");
    fs.mkdirSync(corpusDir, { recursive: true });
    const { episodesPath: ep2, metaPath: meta2, exclusionsPath: ex2, statsPath: st2 } = writeCorpus(corpusDir, ids.map((id) => (id === FIX_R1 ? badSrc : eligibleEpisode(id))), ids.map(eligibleMeta));
    const out2 = path.join(tmp, "out2");
    let failed = false;
    try {
      await R.buildReplay(R.parseArgs({
        episodes: ep2, meta: meta2, exclusions: ex2, stats: st2,
        selection: manifestPath, output: out2, quiet: true, seed: "oracle-src",
        invoker: makeReplayMockInvoker(() => { throw new Error("source oracle failure must fail before provider"); }),
      }));
    } catch (err) { failed = true; }
    assert.ok(failed, "a source whose transformed body fails the oracle must fail the round closed");
    assert.ok(!fs.existsSync(path.join(out2, "blind-key.json")), "no blind-key.json written on source oracle failure");
    assert.ok(!fs.existsSync(path.join(out2, "episodes.jsonl")), "no public files written on source oracle failure");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("A: corpusModelNames mirrors the FULL producer model universe (meta slots ∪ stats by_name ∪ absent_from_body ∪ replay routes); a stats-only model is a known token, never a bare-ambiguity mis-kill", () => {
  const meta = [{ episode_id: "ep-aaa", slots: [{ slot_id: "s1", model: "openai/gpt-5.5", in_body: true }] }];
  const stats = {
    models: {
      by_name: { "openai/gpt-5.5": { episodes: 1, slots: 1 }, "deepseek/deepseek-v4pro": { episodes: 1, slots: 1 } },
      absent_from_body: ["kimi-coding/k3"],
    },
  };
  const names = R.resolveCorpusModelNames(meta, stats, ["deepseek/deepseek-v4-flash", "xai/grok-4.5"]);
  assert.deepEqual(names, ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4pro", "kimi-coding/k3", "openai/gpt-5.5", "xai/grok-4.5"], "meta ∪ stats by_name ∪ absent_from_body ∪ replay routes, sorted, deduped");
  // A replay route that does NOT survive in the corpus is still a KNOWN
  // token: "xai/grok-4.5" mention must be masked as one entity, so the
  // redactor never leaves a "grok"→pseudonym + "-4.5" leftover fragment.
  const ep = { episode_id: "ep-0123456789abcdef", prompt: "The grok-4.5 candidate answered.", slots: [] };
  const metaRec = { episode_id: "ep-0123456789abcdef", slots: [] };
  assert.deepEqual(R.detectSourceAmbiguity(ep, metaRec, names), [], "a known replay-route mention must not be treated as bare ambiguity");
  const { redact } = buildEpisodeRedactor("k".repeat(64), "rep-0123456789abcdef", names, []);
  const transformed = redact("The grok-4.5 candidate answered.");
  assert.match(transformed, /\[model-[a-z]+\]/);
  assert.ok(!transformed.includes("grok-4.5") && !transformed.includes("-4.5"), "a replay-route full name must redact to ONE pseudonym, never a leftover version fragment: " + transformed);
  // A stats-only model mention is masked as a known token: "deepseek-v4pro"
  // (basename of the stats-only deepseek/deepseek-v4pro) must never be
  // mis-killed as a bare "v4pro" ambiguity.
  const ep2 = { episode_id: "ep-0123456789abcdef", prompt: "The deepseek-v4pro candidate answered.", slots: [] };
  assert.deepEqual(R.detectSourceAmbiguity(ep2, metaRec, names), [], "a known stats-only model mention must not be treated as bare ambiguity");
  assert.deepEqual(R.detectSourceAmbiguity(ep2, metaRec, ["openai/gpt-5.5"]), ["v4pro"], "without the full universe the mention is mis-killed as bare ambiguity");
});

// ── B: canonical public payload renderer ──────────────────────────────────

await check("B: public renderer — checkpoint recursive key reorder still passes checkpointValid and renders the five files byte-identical; canonicalizeExclusions key-order-only duplicates are byte-identical in both orders", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-keyorder-"));
  try {
    // canonicalizeExclusions: key-order-only duplicates canonicalize to the
    // same bytes in both input orders, and a single record renders
    // identically (never the first original's key order).
    const rec = { episode_id: "ep-aaaa", reason: "no_replay_candidates", replay_models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"] };
    const swapped = {};
    for (const k of Object.keys(rec).reverse()) swapped[k] = rec[k];
    const cA = JSON.stringify(R.canonicalizeExclusions([rec, swapped]));
    const cB = JSON.stringify(R.canonicalizeExclusions([swapped, rec]));
    assert.equal(cA, cB, "key-order-only duplicates must be byte-identical in both input orders");
    assert.equal(cA, JSON.stringify(R.canonicalizeExclusions([rec])), "single-record output must be the canonicalized form");

    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const out1 = path.join(tmp, "out1");
    const run1 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: out1, "allow-legacy-select": true, quiet: true, seed: "keyorder",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    assert.equal(run1.episodes.length, 2);
    const five1 = readFiveFiles(out1);
    const deepReverseKeys = (value) => {
      if (Array.isArray(value)) return value.map(deepReverseKeys);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort().reverse()) out[k] = deepReverseKeys(value[k]);
        return out;
      }
      return value;
    };
    const blind = JSON.parse(fs.readFileSync(path.join(out1, "blind-key.json"), "utf8")).blind_key;
    const models = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
    // The corpus model names must come from THIS corpus's meta (the two
    // written episodes), not the module-level FIXTURE_CORPUS (which also
    // covers FIX_R3's meta) — the redactor entity universe is corpus-scoped.
    // It must ALSO include the current replay routes (options.models), which
    // buildReplay merges into the universe via resolveCorpusModelNames.
    const corpusModelNames = [...new Set(
      [FIXTURE_META[0], FIXTURE_META[1]].flatMap((m) => (m.slots ?? []).map((s) => s.model)).filter(Boolean),
    )].concat(models).filter((v, i, a) => a.indexOf(v) === i).sort();
    const cps = fs.readdirSync(path.join(out1, "checkpoints")).filter((n) => n.endsWith(".json"));
    assert.equal(cps.length, 2);
    const out2 = path.join(tmp, "out2");
    fs.mkdirSync(path.join(out2, "checkpoints"), { recursive: true });
    fs.copyFileSync(path.join(out1, "blind-key.json"), path.join(out2, "blind-key.json"));
    for (const name of [...cps].reverse()) {
      const cp = JSON.parse(fs.readFileSync(path.join(out1, "checkpoints", name), "utf8"));
      const reordered = deepReverseKeys(cp);
      const src = cp.source_episode_id === FIX_R1 ? FIXTURE_EPISODES[0] : FIXTURE_EPISODES[1];
      const srcMeta = cp.source_episode_id === FIX_R1 ? FIXTURE_META[0] : FIXTURE_META[1];
      const contentHash = C.episodeContentHash(src);
      const protocolHash = R.buildReplayProtocolHash({
        selectionHash: "legacy", sourceContentHash: contentHash, models,
        thinking: src.thinking_level ?? "high", maxOutputBytes: 200_000, maxEpisodeBytes: 1_000_000,
        timeoutMs: 600_000, maxRetries: 2,
      });
      // Recursive key order is not part of the contextual validator's
      // contract: the reordered checkpoint must still be accepted.
      const okReorder = R.checkpointValid(reordered, {
        sourceEpisode: src, sourceMeta: srcMeta, blindKey: blind,
        corpusModelNames, options: FIXTURE_OPTIONS,
        contentHash, models, protocolHash, selectionHash: null,
      });
      assert.equal(okReorder, true, `${name}: recursive key reorder must still pass checkpointValid`);
      fs.writeFileSync(path.join(out2, "checkpoints", name), `${JSON.stringify(reordered, null, 2)}\n`);
    }
    // All-resume rebuild on the reordered checkpoint set (reversed creation
    // order): every checkpoint reused, zero provider calls, five files
    // byte-identical to the un-reordered build.
    const run2 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: out2, "allow-legacy-select": true, quiet: true, seed: "keyorder",
      invoker: makeReplayMockInvoker(() => { throw new Error("all checkpoints reused — provider must never be called"); }),
    }));
    assert.equal(run2.run.reused_requested, 2);
    assert.equal(run2.run.new_checkpoints, 0);
    const five2 = readFiveFiles(out2);
    for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.equal(five2[name], five1[name], `${name} must be byte-identical after recursive key reorder`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── C: blind-key exclusive first publication (stale-negative race) ────────

await check("C: blind-key stale-negative exists observation — exclusive hard-link publication never overwrites; EEXIST loser reads + validates the winner (same key reuse, different key fails closed)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-blindkey-race-"));
  try {
    const winnerKey = "ab".repeat(32);
    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir, { recursive: true });
    const keyFile = path.join(outDir, "blind-key.json");
    const winnerBytes = `${JSON.stringify({ schema_version: 1, blind_key: winnerKey, source: "generated" }, null, 2)}\n`;
    fs.writeFileSync(keyFile, winnerBytes);
    const mtime1 = fs.statSync(keyFile).mtimeMs;
    // Deterministic stale-negative: the loser's existsSync sees NO file even
    // though the winner's canonical exists, and its hard-link publish hits
    // EEXIST (the winner's link already landed).
    const origExists = fs.existsSync;
    const origLink = fs.linkSync;
    let linkCalls = 0;
    fs.existsSync = function (p) {
      if (String(p) === keyFile) return false; // stale negative
      return origExists.call(this, p);
    };
    fs.linkSync = function (from, to) {
      if (String(to) === keyFile) {
        linkCalls++;
        const err = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      return origLink.call(this, from, to);
    };
    try {
      // Same key → reuse: winner's bytes/mtime untouched, no canonical write.
      const same = R.persistBlindKey(outDir, { key: winnerKey, source: "explicit" });
      assert.equal(same.key, winnerKey);
      assert.equal(same.source, "generated", "reuse records the winner file's own source");
      assert.equal(fs.readFileSync(keyFile, "utf8"), winnerBytes, "winner canonical bytes must be unchanged");
      assert.equal(fs.statSync(keyFile).mtimeMs, mtime1, "winner canonical mtime must be unchanged");
      assert.equal(linkCalls, 1, "loser attempted exactly one exclusive publish");
      // Different key → fail closed, never overwrite.
      assert.throws(
        () => R.persistBlindKey(outDir, { key: "cd".repeat(32), source: "seed" }),
        /different blind key/,
        "different key must fail closed",
      );
      assert.equal(fs.readFileSync(keyFile, "utf8"), winnerBytes, "different key must never overwrite the winner");
      assert.equal(fs.statSync(keyFile).mtimeMs, mtime1, "winner canonical mtime must be unchanged after conflict");
      assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.includes(".tmp-")), [], "loser temp must be cleaned up");
    } finally {
      fs.existsSync = origExists;
      fs.linkSync = origLink;
    }
    // Winner path: no EEXIST → the canonical is created atomically from the
    // fully-written + fsynced temp; temp cleaned up; bytes complete.
    const out2 = path.join(tmp, "out2");
    const won = R.persistBlindKey(out2, { key: winnerKey, source: "generated" });
    assert.equal(won.key, winnerKey);
    const parsed2 = JSON.parse(fs.readFileSync(path.join(out2, "blind-key.json"), "utf8"));
    assert.equal(parsed2.schema_version, 1);
    assert.equal(parsed2.blind_key, winnerKey, "winner canonical must carry the full payload");
    assert.equal(parsed2.source, "generated");
    assert.deepEqual(fs.readdirSync(out2).filter((n) => n.includes(".tmp-")), [], "winner temp must be cleaned up");
    // The first blind itself must pass exact producer-shape validation.
    assert.throws(() => R.persistBlindKey(out2, { key: "NOTHEX", source: "generated" }), /blind_key is not canonical/);
    assert.throws(() => R.persistBlindKey(out2, { key: winnerKey, source: "reused" }), /illegal source/);
    assert.throws(() => R.persistBlindKey(out2, { key: winnerKey }), /illegal source/);
    // Serial reuse (existsSync true) still works with zero writes.
    const bytes = fs.readFileSync(path.join(out2, "blind-key.json"), "utf8");
    const mtime2 = fs.statSync(path.join(out2, "blind-key.json")).mtimeMs;
    const reuse = R.persistBlindKey(out2, { key: winnerKey, source: "explicit" });
    assert.equal(reuse.key, winnerKey);
    assert.equal(reuse.source, "generated");
    assert.equal(fs.readFileSync(path.join(out2, "blind-key.json"), "utf8"), bytes, "serial reuse must not rewrite");
    assert.equal(fs.statSync(path.join(out2, "blind-key.json")).mtimeMs, mtime2, "serial reuse must not touch mtime");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── D: P2 closures (max_total_bytes / relocation) ─────────────────────────

await check("D: max_total_bytes is a publication guard, not public stats identity — changing only it keeps the five files byte-identical and stats carry no max_total_bytes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-maxtotal-"));
  try {
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, [FIXTURE_EPISODES[0], FIXTURE_EPISODES[1]], [FIXTURE_META[0], FIXTURE_META[1]]);
    const mkArgs = (out, maxTotalBytes) => R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: out, "allow-legacy-select": true, quiet: true, seed: "maxtotal",
      "max-total-bytes": maxTotalBytes,
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    });
    // Build once under maxTotalBytes=1M, then resume-rebuild the SAME
    // checkpoint closure (copied, blind key included) under 500M — fresh
    // builds carry per-call called_at timestamps, so only a same-checkpoint
    // comparison is byte-meaningful. max_total_bytes is not bound into the
    // protocol hash, so both values accept the same checkpoints.
    const outA = path.join(tmp, "outA");
    const runA = await R.buildReplay(mkArgs(outA, 1_000_000));
    assert.equal(runA.episodes.length, 2);
    const fiveA = readFiveFiles(outA);
    const outB = path.join(tmp, "outB");
    fs.mkdirSync(path.join(outB, "checkpoints"), { recursive: true });
    fs.copyFileSync(path.join(outA, "blind-key.json"), path.join(outB, "blind-key.json"));
    for (const name of fs.readdirSync(path.join(outA, "checkpoints")).filter((n) => n.endsWith(".json"))) {
      fs.copyFileSync(path.join(outA, "checkpoints", name), path.join(outB, "checkpoints", name));
    }
    const runB = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      output: outB, "allow-legacy-select": true, quiet: true, seed: "maxtotal",
      "max-total-bytes": 500_000_000,
      invoker: makeReplayMockInvoker(() => { throw new Error("all checkpoints reused — provider must never be called"); }),
    }));
    assert.equal(runB.run.reused_requested, 2);
    assert.equal(runB.run.new_checkpoints, 0);
    const fiveB = readFiveFiles(outB);
    for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.equal(fiveB[name], fiveA[name], `${name} must be byte-identical when only max_total_bytes changes`);
    }
    const stats = JSON.parse(fiveB["stats.json"]);
    assert.equal(stats.resource.max_total_bytes, undefined, "max_total_bytes must not enter the public stats identity");
    assert.equal(stats.resource.max_output_bytes, 200_000, "max_output_bytes stays (bound into the checkpoint protocol hash)");
    // The guard itself still fails closed (publication guard, not identity).
    let guardFailed = false;
    try {
      await R.buildReplay(mkArgs(path.join(tmp, "outC"), 1));
    } catch (err) {
      guardFailed = true;
    }
    assert.ok(guardFailed, "max_total_bytes below the body size must fail closed (publication guard)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("D: subset accumulation then relocation — same blind key + checkpoint closure in a fresh output with reversed checkpoint creation order rebuilds all-resume byte-identically", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-p0-relocate-"));
  try {
    const ids = [FIX_R1, FIX_R2, FIX_R4, FIX_R5];
    const { manifestPath } = buildFairProvenanceFixture(tmp, ids);
    const { episodesPath, metaPath, exclusionsPath, statsPath } = writeCorpus(tmp, ids.map(eligibleEpisode), ids.map(eligibleMeta));
    const out1 = path.join(tmp, "out1");
    // Subset A then disjoint subset B on the same dir (cumulative closure).
    await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, episode: [FIX_R1, FIX_R4], output: out1, quiet: true, seed: "p0-reloc",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    const runB = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, episode: [FIX_R2, FIX_R5], output: out1, quiet: true, seed: "p0-reloc",
      invoker: makeReplayMockInvoker((m) => ({ text: `Replay answer for ${m}.` })),
    }));
    assert.equal(runB.run.dataset_checkpoints, 4, "cumulative closure is A∪B");
    const five1 = readFiveFiles(out1);
    // Relocate: copy the blind key + every checkpoint to a fresh output,
    // writing the checkpoints in REVERSE readdir order (reversed creation
    // order on disk → real directory-enumeration-order evidence).
    const out2 = path.join(tmp, "out2");
    fs.mkdirSync(path.join(out2, "checkpoints"), { recursive: true });
    fs.copyFileSync(path.join(out1, "blind-key.json"), path.join(out2, "blind-key.json"));
    const cps = fs.readdirSync(path.join(out1, "checkpoints")).filter((n) => n.endsWith(".json"));
    assert.equal(cps.length, 4);
    for (const name of [...cps].reverse()) {
      fs.copyFileSync(path.join(out1, "checkpoints", name), path.join(out2, "checkpoints", name));
    }
    // All-resume rebuild (no --episode): every checkpoint reused, zero
    // provider calls, five files byte-identical.
    const run2 = await R.buildReplay(R.parseArgs({
      episodes: episodesPath, meta: metaPath, exclusions: exclusionsPath, stats: statsPath,
      selection: manifestPath, output: out2, quiet: true, seed: "p0-reloc",
      invoker: makeReplayMockInvoker(() => { throw new Error("all checkpoints reused — provider must never be called"); }),
    }));
    assert.equal(run2.run.reused_requested, 4);
    assert.equal(run2.run.new_checkpoints, 0);
    assert.equal(run2.run.dataset_checkpoints, 4);
    const five2 = readFiveFiles(out2);
    for (const name of ["episodes.jsonl", "episodes.meta.jsonl", "exclusions.jsonl", "stats.json", "README.md"]) {
      assert.equal(five2[name], five1[name], `${name} must be byte-identical after relocation + reversed creation order + all-resume`);
    }
    assert.equal(
      fs.readFileSync(path.join(out2, R.DATASET_COMMIT_FILE), "utf8"),
      fs.readFileSync(path.join(out1, R.DATASET_COMMIT_FILE), "utf8"),
      "dataset commit must be deterministic across subset accumulation, resume and relocation with the same logical basenames",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


async function makeCommittedReplayFixture(rootDir, ids = [FIX_R1, FIX_R2]) {
  const fairDir = path.join(rootDir, "fair");
  fs.mkdirSync(fairDir, { recursive: true });
  const { manifestPath } = buildFairProvenanceFixture(fairDir, ids);
  const corpusDir = path.join(rootDir, "corpus");
  fs.mkdirSync(corpusDir, { recursive: true });
  const corpus = writeCorpus(corpusDir, ids.map(eligibleEpisode), ids.map(eligibleMeta));
  const output = path.join(rootDir, "output");
  const options = R.parseArgs({
    episodes: corpus.episodesPath,
    meta: corpus.metaPath,
    exclusions: corpus.exclusionsPath,
    stats: corpus.statsPath,
    selection: manifestPath,
    output,
    quiet: true,
    seed: "committed-fixture",
    invoker: makeReplayMockInvoker((model) => ({ text: `Committed fixture answer for ${model}.` })),
  });
  const built = await R.buildReplay(options);
  return { ...corpus, manifestPath, output, options, built };
}

await check("dataset commit: committed loader round-trips the reconstructed dataset, returns deep-frozen values, and missing marker never falls back to raw files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-commit-roundtrip-"));
  try {
    const fixture = await makeCommittedReplayFixture(tmp);
    assert.ok(fs.existsSync(path.join(fixture.output, R.DATASET_COMMIT_FILE)));
    const loaded = await R.loadCommittedReplayDataset(fixture.output);
    assert.deepEqual(loaded.episodes, fixture.built.episodes);
    assert.deepEqual(loaded.meta, fixture.built.sidecar);
    assert.equal(loaded.generationId, fixture.built.generationId);
    assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.episodes) && Object.isFrozen(loaded.episodes[0]));
    fs.rmSync(path.join(fixture.output, R.DATASET_COMMIT_FILE));
    assert.equal(await R.loadCommittedReplayDataset(fixture.output), null, "public files without the marker are not committed evidence");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("dataset commit: marker/public/closure/source/selection/fair/blind/replay/extra tampering all fail closed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-commit-tamper-"));
  try {
    const fixture = await makeCommittedReplayFixture(path.join(tmp, "base"));
    const marker = JSON.parse(fs.readFileSync(path.join(fixture.output, R.DATASET_COMMIT_FILE), "utf8"));
    const generationDir = path.join(fixture.output, R.REPLAY_GENERATIONS_DIR, marker.generation_id);
    const fairName = fs.readdirSync(path.join(generationDir, "fair-checkpoints"))[0];
    const replayName = fs.readdirSync(path.join(generationDir, "replay-checkpoints"))[0];
    const cases = [
      ["marker", (out) => {
        const file = path.join(out, R.DATASET_COMMIT_FILE);
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        value.extra = true;
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      }],
      ["public", (out) => fs.appendFileSync(path.join(out, "episodes.jsonl"), " ")],
      ["closure", (out, gen) => fs.appendFileSync(path.join(gen, "closure.json"), " ")],
      ["source", (out, gen) => fs.appendFileSync(path.join(gen, "source", "episodes.jsonl"), " ")],
      ["selection", (out, gen) => fs.appendFileSync(path.join(gen, "selection.json"), " ")],
      ["fair checkpoint", (out, gen) => fs.appendFileSync(path.join(gen, "fair-checkpoints", fairName), " ")],
      ["blind key", (out, gen) => fs.appendFileSync(path.join(gen, "blind-key.json"), " ")],
      ["replay checkpoint", (out, gen) => fs.appendFileSync(path.join(gen, "replay-checkpoints", replayName), " ")],
      ["extra file", (out, gen) => fs.writeFileSync(path.join(gen, "extra.txt"), "extra")],
    ];
    for (const [name, mutate] of cases) {
      const caseRoot = path.join(tmp, name.replaceAll(" ", "-"));
      const out = path.join(caseRoot, "output");
      fs.mkdirSync(caseRoot, { recursive: true });
      fs.cpSync(fixture.output, out, { recursive: true });
      const copiedMarker = JSON.parse(fs.readFileSync(path.join(out, R.DATASET_COMMIT_FILE), "utf8"));
      const copiedGeneration = path.join(out, R.REPLAY_GENERATIONS_DIR, copiedMarker.generation_id);
      mutate(out, copiedGeneration);
      await assert.rejects(() => R.loadCommittedReplayDataset(out), undefined, `${name} tamper must fail closed`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("selectionInfoOverride: derived info is never trusted — tampering episodeIds/selectedById to add a non-replayable hard-pass episode is neutralized before invoker/write (rebuilt from the manifest body); the committed bundle loader still round-trips", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-override-tamper-"));
  try {
    // Corpus: 2 replayable + 1 hard-pass NON-replayable candidate (the
    // selector classified it replayable:false, so it must never be
    // replayable through any override).
    const fairDir = path.join(tmp, "fair");
    fs.mkdirSync(fairDir, { recursive: true });
    const { manifestPath } = buildFairNonReplayableFixture(fairDir, [FIX_R1, FIX_R2], FIX_R4);
    const corpusDir = path.join(tmp, "corpus");
    fs.mkdirSync(corpusDir, { recursive: true });
    const corpus = writeCorpus(corpusDir, [eligibleEpisode(FIX_R1), eligibleEpisode(FIX_R2), eligibleEpisode(FIX_R4)], [eligibleMeta(FIX_R1), eligibleMeta(FIX_R2), eligibleMeta(FIX_R4)]);
    const legal = R.loadAndValidateSelection(manifestPath);
    assert.deepEqual(legal.episodeIds, [FIX_R1, FIX_R2]);
    // Tampered override: keep the legal manifest BODY but extend the derived
    // episodeIds/selectedById with the non-replayable hard-pass episode.
    const tampered = {
      ...legal,
      episodeIds: [...legal.episodeIds, FIX_R4],
      selectedById: new Map([...legal.selectedById, [FIX_R4, {
        episode_id: FIX_R4, models: ["openai/gpt-5.5", "moonshotai/kimi-k2.7-code"],
        join_confidence: "exact", tools: null, stage: "llm", replayable: true,
        confidence: 0.9, reasons: ["forged"],
      }]]),
    };
    const out = path.join(tmp, "output");
    const invoker = makeReplayMockInvoker((model) => ({ text: `Replay answer for ${model}.` }));
    const opts = R.parseArgs({
      episodes: corpus.episodesPath,
      meta: corpus.metaPath,
      exclusions: corpus.exclusionsPath,
      stats: corpus.statsPath,
      selection: manifestPath,
      output: out,
      quiet: true,
      seed: "override-tamper",
      invoker,
    });
    opts.selectionInfoOverride = tampered;
    const run = await R.buildReplay(opts);
    assert.equal(run.episodes.length, 2, "the forged hard-pass episode must never enter the replay set");
    assert.equal(run.run.dataset_checkpoints, 2, "only the two replayable episodes may have replay checkpoints");
    assert.equal(invoker.calls.length, 4, "exactly 2 episodes × 2 replay models must be requested");
    assert.ok(!invoker.calls.some((c) => c.userText.includes(FIX_R4)), "the invoker must never see the forged non-replayable episode");
    const cpNames = fs.readdirSync(path.join(out, "checkpoints")).filter((n) => n.endsWith(".json"));
    assert.equal(cpNames.length, 2);
    for (const name of cpNames) {
      const cp = JSON.parse(fs.readFileSync(path.join(out, "checkpoints", name), "utf8"));
      assert.notEqual(cp.source_episode_id, FIX_R4, `no replay checkpoint may exist for the forged episode (${name})`);
    }
    // The real committed-bundle loader — the ONLY production consumer of
    // selectionInfoOverride — still round-trips a committed dataset.
    const commit = await makeCommittedReplayFixture(path.join(tmp, "commit"));
    const loaded = await R.loadCommittedReplayDataset(commit.output);
    assert.deepEqual(loaded.episodes, commit.built.episodes);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Forge a generation closure + marker on a copied committed output: applies
 * `mutate(closure)`, recomputes the closure bytes/hash, the generation id
 * preimage and the marker locator, renames the generation dir and rewrites
 * the marker — so the loader reaches the closure identity validation (not a
 * bytes/hash mismatch) and fails closed on the forged semantic.
 */
function forgeGenerationClosure(out, mutate) {
  const markerFile = path.join(out, R.DATASET_COMMIT_FILE);
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  const genDir = path.join(out, R.REPLAY_GENERATIONS_DIR, marker.generation_id);
  const closureFile = path.join(genDir, "closure.json");
  const closure = JSON.parse(fs.readFileSync(closureFile, "utf8"));
  mutate(closure);
  const closureText = `${JSON.stringify(R.canonicalizeJsonKeys(closure), null, 2)}\n`;
  const closureSha = C.sha256Hex(closureText);
  const preimage = `${JSON.stringify(R.canonicalizeJsonKeys({
    contract_id: R.REPLAY_DATASET_GENERATION_CONTRACT_ID,
    schema_version: R.REPLAY_DATASET_GENERATION_SCHEMA_VERSION,
    closure_sha256: closureSha,
    files_digest: marker.files_digest,
  }), null, 2)}\n`;
  const generationId = C.sha256Hex(preimage);
  const newGenDir = path.join(out, R.REPLAY_GENERATIONS_DIR, generationId);
  fs.renameSync(genDir, newGenDir);
  fs.writeFileSync(path.join(newGenDir, "closure.json"), closureText);
  marker.generation_id = generationId;
  marker.closure = {
    path: `${R.REPLAY_GENERATIONS_DIR}/${generationId}/closure.json`,
    bytes: Buffer.byteLength(closureText, "utf8"),
    sha256: closureSha,
  };
  fs.writeFileSync(markerFile, `${JSON.stringify(R.canonicalizeJsonKeys(marker), null, 2)}\n`);
}

await check("dataset commit: generation closure identity binds the producer contract id and the exact current model arrays; a stale producer contract fails closed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-producer-contract-"));
  try {
    const fixture = await makeCommittedReplayFixture(path.join(tmp, "base"));
    const marker = JSON.parse(fs.readFileSync(path.join(fixture.output, R.DATASET_COMMIT_FILE), "utf8"));
    const closure = JSON.parse(fs.readFileSync(path.join(fixture.output, R.REPLAY_GENERATIONS_DIR, marker.generation_id, "closure.json"), "utf8"));
    assert.equal(closure.identity.producer_contract_id, R.REPLAY_DATASET_PRODUCER_CONTRACT_ID, "closure identity must carry the exact current producer contract id");
    assert.deepEqual(closure.identity.strong_reference_models, R.STRONG_REFERENCE_MODELS, "closure identity must carry the exact current strong_reference_models array");
    assert.deepEqual(closure.identity.specialist_models, R.SPECIALIST_MODELS, "closure identity must carry the exact current specialist_models array");
    assert.deepEqual(closure.identity.replay_judge_models, R.REPLAY_JUDGE_MODELS, "closure identity must carry the exact current replay_judge_models array");
    // The validator exact-matches the arrays: the committed round-trip passes.
    await R.loadCommittedReplayDataset(fixture.output);
    // A forged stale producer contract id fails closed at the closure
    // identity validation (not a bytes/hash mismatch).
    const staleOut = path.join(tmp, "stale");
    fs.cpSync(fixture.output, staleOut, { recursive: true });
    forgeGenerationClosure(staleOut, (closure) => {
      closure.identity.producer_contract_id = "t0-replay-dataset-producer-v0:old";
    });
    await assert.rejects(
      () => R.loadCommittedReplayDataset(staleOut),
      /stale for the current replay dataset producer contract/,
      "a stale producer contract id must fail closed explicitly",
    );
    // A forged model-array drift fails closed too (validator exact match).
    const driftOut = path.join(tmp, "drift");
    fs.cpSync(fixture.output, driftOut, { recursive: true });
    forgeGenerationClosure(driftOut, (closure) => {
      closure.identity.replay_judge_models = [...R.REPLAY_JUDGE_MODELS, "openai/gpt-5.5"];
    });
    await assert.rejects(
      () => R.loadCommittedReplayDataset(driftOut),
      /replay_judge_models must exactly match/,
      "a forged judge-model array drift must fail closed explicitly",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("replay_build_context basenames are strictly safe: . / .. / slash / backslash / NUL all fail closed in the producer shape AND in a forged closure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-basename-"));
  try {
    const base = {
      episodesPath: "episodes.jsonl", metaPath: "episodes.meta.jsonl", exclusionsPath: "exclusions.jsonl",
      statsPath: "stats.json", selectionPath: "selection.json", models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
      currentOnly: false, experimentMode: null, historyExcluded: false, requirePaired: false,
      thinkingOverride: null, minModels: 2, maxOutputBytes: 200_000, maxEpisodeBytes: 1_000_000,
      maxRetries: 2, timeoutMs: 600_000,
    };
    const good = R.buildReplayBuildContext(base);
    assert.equal(good.episodes_basename, "episodes.jsonl");
    // Pure shape: every forbidden basename value fails closed.
    for (const [key, bad] of [
      ["episodesPath", ".."], ["metaPath", "."], ["exclusionsPath", "/"],
      ["statsPath", "a\\b"], ["selectionPath", "a\0b"],
    ]) {
      assert.throws(
        () => R.buildReplayBuildContext({ ...base, [key]: bad }),
        /safe basename/,
        `${key}=${JSON.stringify(bad)} must fail closed`,
      );
    }
    // Forged closure with a bad basename fails closed at the loader too.
    const fixture = await makeCommittedReplayFixture(path.join(tmp, "base"));
    for (const [key, bad] of [["episodes_basename", ".."], ["meta_basename", "."], ["selection_basename", "a\\b"], ["stats_basename", "a\0b"]]) {
      const out = path.join(tmp, `forge-${key}`);
      fs.cpSync(fixture.output, out, { recursive: true });
      forgeGenerationClosure(out, (closure) => {
        closure.replay_build_context[key] = bad;
      });
      await assert.rejects(
        () => R.loadCommittedReplayDataset(out),
        /safe basename/,
        `forged ${key}=${JSON.stringify(bad)} must fail closed`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("dataset publication: every failpoint leaves either the old commit loadable or an exact recoverable intent, with no temp residue", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-commit-failpoints-"));
  try {
    const fixture = await makeCommittedReplayFixture(path.join(tmp, "base"));
    const failpoints = [
      "beforeBundlePublish", "afterBundlePublish", "beforeIntentWrite", "afterIntentWrite",
      "beforeMarkerRevoke", "afterMarkerRevoke",
      ...R.REPLAY_PUBLIC_FILES.flatMap((name) => [`beforePublicWrite:${name}`, `afterPublicWrite:${name}`]),
      "beforeMarkerWrite", "afterMarkerWrite",
    ];
    for (const failpoint of failpoints) {
      const out = path.join(tmp, failpoint.replaceAll("/", "_").replaceAll(":", "_"));
      fs.cpSync(fixture.output, out, { recursive: true });
      const options = { ...fixture.options, output: out, publicationFailpoint: failpoint };
      options.invoker = makeReplayMockInvoker(() => { throw new Error("all committed checkpoints must be reused"); });
      await assert.rejects(() => R.buildReplay(options), /publication failpoint/);
      const markerExists = fs.existsSync(path.join(out, R.DATASET_COMMIT_FILE));
      const intentExists = fs.existsSync(path.join(out, R.REPLAY_PUBLICATION_INTENT_FILE));
      if (["beforeBundlePublish", "afterBundlePublish", "beforeIntentWrite", "afterIntentWrite", "beforeMarkerRevoke"].includes(failpoint)) {
        assert.ok(markerExists, `${failpoint}: old marker must remain`);
        await R.loadCommittedReplayDataset(out);
      } else if (failpoint === "afterMarkerWrite") {
        assert.ok(markerExists && intentExists, "marker-last publication may leave only a stale exact intent");
        await R.loadCommittedReplayDataset(out);
      } else {
        assert.ok(!markerExists && intentExists, `${failpoint}: recovery intent must be authoritative while marker is absent`);
        const recoveryOptions = { output: out, resume: true, allowLegacySelect: false };
        Object.defineProperty(recoveryOptions, "invoker", { get() { throw new Error("recovery must not create/read an invoker"); } });
        const recovered = await R.buildReplay(recoveryOptions);
        assert.equal(recovered.recovered, true);
        assert.deepEqual(recovered.run, {
          requested: 0,
          new_checkpoints: 0,
          reused_requested: 0,
          dataset_checkpoints: 2,
          dataset_episodes: 2,
        });
        // Every recovery must end in a fully loadable committed dataset with
        // the exact target generation and bytes (the loader re-verifies the
        // five public files byte-by-byte against the marker descriptors).
        const loaded = await R.loadCommittedReplayDataset(out);
        assert.equal(loaded.generationId, recovered.generationId, `${failpoint}: recovered generation must load`);
        assert.equal(loaded.episodes.length, 2, `${failpoint}: recovered dataset must carry the full body`);
      }
      const leftovers = fs.readdirSync(out).filter((name) => name.includes(".tmp-"));
      const generationLeftovers = fs.readdirSync(path.join(out, R.REPLAY_GENERATIONS_DIR)).filter((name) => name.startsWith(".tmp-"));
      assert.deepEqual([...leftovers, ...generationLeftovers], [], `${failpoint}: no temp residue`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("dataset recovery: differing old marker plus new intent — an interrupted recovery leaves a mixed public state (episodes new, another file old), and the second recovery completes the exact target generation with zero invoker; loader verifies per-file bytes/hash", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-commit-differing-intent-"));
  try {
    const ids = [FIX_R1, FIX_R2, FIX_R4, FIX_R5];
    const fairDir = path.join(tmp, "fair");
    fs.mkdirSync(fairDir, { recursive: true });
    const { manifestPath } = buildFairProvenanceFixture(fairDir, ids);
    const corpusDir = path.join(tmp, "corpus");
    fs.mkdirSync(corpusDir, { recursive: true });
    const corpus = writeCorpus(corpusDir, ids.map(eligibleEpisode), ids.map(eligibleMeta));
    const output = path.join(tmp, "output");
    const common = {
      episodes: corpus.episodesPath,
      meta: corpus.metaPath,
      exclusions: corpus.exclusionsPath,
      stats: corpus.statsPath,
      selection: manifestPath,
      output,
      quiet: true,
      seed: "cumulative-recovery",
    };
    const first = await R.buildReplay(R.parseArgs({
      ...common,
      episode: [FIX_R1, FIX_R2],
      invoker: makeReplayMockInvoker((model) => ({ text: `First generation answer for ${model}.` })),
    }));
    const oldGeneration = first.generationId;
    const secondOptions = R.parseArgs({
      ...common,
      episode: [FIX_R4, FIX_R5],
      invoker: makeReplayMockInvoker((model) => ({ text: `Second generation answer for ${model}.` })),
    });
    secondOptions.publicationFailpoint = "afterIntentWrite";
    await assert.rejects(() => R.buildReplay(secondOptions), /publication failpoint/);
    const stillOld = await R.loadCommittedReplayDataset(output);
    assert.equal(stillOld.generationId, oldGeneration, "the old marker remains loadable before revoke");
    const oldByPath = new Map(stillOld.marker.files.map((d) => [d.path, d]));
    const intent = JSON.parse(fs.readFileSync(path.join(output, R.REPLAY_PUBLICATION_INTENT_FILE), "utf8"));
    assert.notEqual(intent.generation_id, oldGeneration, "intent targets the cumulative A-union-B generation");
    const targetByPath = new Map(intent.target_marker.files.map((d) => [d.path, d]));
    // The two generations must genuinely differ in episodes.jsonl — the
    // mixed-state assertions below are not same-generation self-proof.
    assert.notEqual(
      targetByPath.get("episodes.jsonl").sha256,
      oldByPath.get("episodes.jsonl").sha256,
      "precondition: the target A-union-B episodes.jsonl must differ from the old generation",
    );
    // FIRST recovery: interrupted right after episodes.jsonl is written —
    // throws, marker absent, intent still authoritative.
    const firstRecovery = { output, resume: true, allowLegacySelect: false, publicationFailpoint: "afterPublicWrite:episodes.jsonl" };
    Object.defineProperty(firstRecovery, "invoker", { get() { throw new Error("differing-intent recovery must be zero-invoker"); } });
    await assert.rejects(() => R.buildReplay(firstRecovery), /publication failpoint/);
    assert.ok(!fs.existsSync(path.join(output, R.DATASET_COMMIT_FILE)), "marker must be absent after the interrupted recovery");
    assert.ok(fs.existsSync(path.join(output, R.REPLAY_PUBLICATION_INTENT_FILE)), "intent must remain authoritative");
    // Mixed public state: episodes.jsonl carries the NEW target content, and
    // at least one other public file still carries the OLD content (judged
    // against the old descriptors — if a file's old and target hashes
    // coincide, it is indistinguishable and the episodes.jsonl delta alone
    // proves the interrupted write).
    const epText = fs.readFileSync(path.join(output, "episodes.jsonl"), "utf8");
    assert.equal(
      C.sha256Hex(epText),
      targetByPath.get("episodes.jsonl").sha256,
      "episodes.jsonl must carry the new target content after the interrupted recovery",
    );
    const otherStillOld = R.REPLAY_PUBLIC_FILES.filter((name) => name !== "episodes.jsonl").some((name) => {
      const text = fs.readFileSync(path.join(output, name), "utf8");
      return C.sha256Hex(text) === oldByPath.get(name).sha256;
    });
    assert.ok(otherStillOld, "at least one other public file must still carry the old content after the interrupted recovery");
    // SECOND recovery: bad current semantic/path arguments + zero invoker
    // completes the publication of the exact target generation.
    const recoveryOptions = { output, resume: true, allowLegacySelect: false, currentOnly: true, selectionPath: "/bad" };
    Object.defineProperty(recoveryOptions, "invoker", { get() { throw new Error("differing-intent recovery must be zero-invoker"); } });
    const recovered = await R.buildReplay(recoveryOptions);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.generationId, intent.generation_id);
    assert.equal(recovered.run.dataset_checkpoints, 4);
    // Loader: generation = intent target, every public file bytes/hash exact
    // against the target marker descriptors (not same-generation self-proof).
    const loaded = await R.loadCommittedReplayDataset(output);
    assert.equal(loaded.generationId, intent.generation_id);
    for (const d of intent.target_marker.files) {
      const text = fs.readFileSync(path.join(output, d.path), "utf8");
      assert.equal(Buffer.byteLength(text, "utf8"), d.bytes, `${d.path} bytes must match the target marker`);
      assert.equal(C.sha256Hex(text), d.sha256, `${d.path} hash must match the target marker`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("dataset recovery: --no-resume rejects, bad current semantic/path arguments are ignored with zero invoker, stale exact intent clears, and legacy cannot touch committed state", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-commit-recovery-"));
  try {
    const fixture = await makeCommittedReplayFixture(path.join(tmp, "base"));
    const recoveryOut = path.join(tmp, "recovery");
    fs.cpSync(fixture.output, recoveryOut, { recursive: true });
    await assert.rejects(
      () => R.buildReplay({ ...fixture.options, output: recoveryOut, publicationFailpoint: "afterMarkerRevoke" }),
      /publication failpoint/,
    );
    await assert.rejects(
      () => R.buildReplay({ output: recoveryOut, resume: false, allowLegacySelect: false }),
      /--no-resume/,
    );
    const badCurrent = {
      output: recoveryOut,
      resume: true,
      allowLegacySelect: false,
      currentOnly: true,
      selectionPath: "/does/not/exist.json",
      episodesPath: "/does/not/exist.jsonl",
      episodeIds: ["bad"],
    };
    Object.defineProperty(badCurrent, "invoker", { get() { throw new Error("exact recovery must be zero-invoker"); } });
    const recovered = await R.buildReplay(badCurrent);
    assert.equal(recovered.recovered, true);
    await R.loadCommittedReplayDataset(recoveryOut);

    const staleOut = path.join(tmp, "stale");
    fs.cpSync(fixture.output, staleOut, { recursive: true });
    const marker = JSON.parse(fs.readFileSync(path.join(staleOut, R.DATASET_COMMIT_FILE), "utf8"));
    const markerText = `${JSON.stringify(marker, null, 2)}\n`;
    const intent = {
      schema_version: R.REPLAY_PUBLICATION_INTENT_SCHEMA_VERSION,
      kind: R.REPLAY_PUBLICATION_INTENT_KIND,
      contract_id: R.REPLAY_PUBLICATION_INTENT_CONTRACT_ID,
      generation_id: marker.generation_id,
      marker_sha256: C.sha256Hex(markerText),
      target_marker: marker,
    };
    fs.writeFileSync(
      path.join(staleOut, R.REPLAY_PUBLICATION_INTENT_FILE),
      `${JSON.stringify(R.canonicalizeJsonKeys(intent), null, 2)}\n`,
    );
    await assert.rejects(
      () => R.buildReplay({ output: staleOut, resume: true, allowLegacySelect: false }),
      /--selection/,
      "an exact stale intent is cleared and normal validation continues",
    );
    assert.ok(!fs.existsSync(path.join(staleOut, R.REPLAY_PUBLICATION_INTENT_FILE)));
    await assert.rejects(
      () => R.buildReplay({ ...fixture.options, output: fixture.output, allowLegacySelect: true, selectionPath: undefined }),
      /legacy.*cannot touch/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── canonical replay-eval producer capability (offline, mock invoker only) ──

function makeEvalStageOutputs(episode) {
  const ids = (episode.slots ?? []).map((s) => s.model_id);
  const cand = (id) => ({
    candidate_id: id,
    claims: { supported: [], unsupported: [], contradicted: [], unverifiable: [] },
    missed_critical_points: [],
    instruction_following: { rating: "full", notes: "n" },
    overall_correctness: { rating: "correct", confidence: 0.8, notes: "n" },
    noise_types: [],
    abstain: false,
    abstain_reason: null,
  });
  const verdict = (id) => ({
    candidate_id: id,
    verdict: "adopt",
    confidence: 0.9,
    evidence: [],
    counter_evidence: [],
    noise_assessment: "n",
    notes: "x",
  });
  const cf = (id) => ({
    candidate_id: id,
    information_loss: "low",
    noise_reduction: "low",
    unique_valid_contribution: { exists: false, contribution: null, evidence: [] },
    net_value: "neutral",
    notes: "",
  });
  return {
    t0_eval_evaluator: {
      schema_version: 1,
      stage: "evaluator",
      evaluator_index: 0,
      episode_id: episode.episode_id,
      task_understanding: { ok: true, confidence: 0.9, summary: "understood", unresolved: false },
      candidates: ids.map(cand),
      notes: "",
    },
    t0_eval_verifier: {
      schema_version: 1,
      stage: "verifier",
      episode_id: episode.episode_id,
      attacks: [{ target: "evaluator_0", issue: "i", severity: "low", evidence_weakness: "w", bias_suspected: "b", suggestion: "s" }],
      overall: { evaluator_0_evidence_quality: "strong", evaluator_1_evidence_quality: "strong", bias_flags: [], notes: "" },
    },
    t0_eval_adjudicator: {
      schema_version: 1,
      stage: "adjudicator",
      episode_id: episode.episode_id,
      verdicts: ids.map(verdict),
      disagreement: { evaluator_disagreement: "low", summary: "s" },
      unresolved: [],
      unresolved_issues: [],
      notes: "",
    },
    t0_eval_counterfactual: {
      schema_version: 1,
      stage: "counterfactual",
      episode_id: episode.episode_id,
      per_candidate: ids.map(cf),
      notes: "",
    },
  };
}

function makeEvalMockInvoker(episodeById) {
  return {
    registry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }) },
    // callJudge meta has {module,operation,model_ref,attempt} only — resolve the
    // episode from the judge feed header (`# Episode <id>`).
    auditStreamSimple: async (_root, meta, _piAi, _model, opts) => {
      const feed = opts?.messages?.[0]?.content?.[0]?.text ?? "";
      // Match the feed header exactly (single `# Episode <id>`), never the
      // protocol section title `## Episode evidence (untrusted data)`.
      // Use String.match (not RegExp.exec) so the T0 offline-lock detector
      // does not treat this as a child_process exec surface.
      const m = feed.match(/(?:^|\n)# Episode ([^\n]+)/);
      const episode = (m && episodeById.get(m[1].trim())) || episodeById.values().next().value;
      const outputs = makeEvalStageOutputs(episode);
      const data = { ...outputs[meta.operation], episode_id: episode.episode_id };
      return {
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(data) }],
        usage: { input: 100, output: 50, cost: { total: 0.01 } },
      };
    },
    projectRoot: "/tmp",
    piAi: {},
  };
}

await check("replay-eval producer capability: loadReplayEvalCorpus → evaluateEpisode(binding) → publishReplayEvalGeneration → loadCommittedEvalGeneration (mock invoker only); wrong corpus/binding rejected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-eval-cap-"));
  try {
    const E = await import(path.join(root, "scripts/t0-eval.mjs"));
    const fixture = await makeCommittedReplayFixture(tmp);
    // loadReplayEvalCorpus must run before any output/invoker work.
    const corpus = await E.loadReplayEvalCorpus(fixture.output);
    assert.equal(corpus.generationId, fixture.built.generationId);
    assert.ok(corpus.replayBinding && typeof corpus.replayBinding === "object");
    assert.ok(Object.isFrozen(corpus));
    assert.ok(Array.isArray(corpus.episodes) && corpus.episodes.length > 0);
    assert.equal(corpus.episodesPath, path.join(path.resolve(fixture.output), "episodes.jsonl"));

    const judgeModels = C.resolveJudgeModels(C.REPLAY_EVAL_JUDGE_MODELS_CSV);
    const episodeById = new Map(corpus.episodes.map((e) => [e.episode_id, e]));
    const invoker = makeEvalMockInvoker(episodeById);
    const evalOut = path.join(tmp, "eval-out");
    const records = [];
    for (const episode of corpus.episodes) {
      const record = await E.evaluateEpisode(invoker, episode, judgeModels, {
        outputDir: evalOut,
        maxRetries: 0,
        timeoutMs: 5000,
        resume: false,
        quiet: true,
        replayBinding: corpus.replayBinding,
      });
      assert.equal(record.replay_dataset_generation_id, corpus.generationId);
      assert.equal(record.protocol_hash, C.buildJudgeProtocolHash(corpus.generationId));
      // Checkpoint carries the real marker generation.
      const cp = C.loadCheckpoint(evalOut, episode.episode_id, C.episodeContentHash(episode), {
        protocolHash: C.buildJudgeProtocolHash(corpus.generationId),
        schemaHash: C.buildJudgeSchemaHash(),
        expectedEpisodeId: episode.episode_id,
        candidateIds: (episode.slots ?? []).map((s) => s.model_id),
        judgeModels,
        expectedReplayDatasetGenerationId: corpus.generationId,
      });
      assert.ok(cp, "bound checkpoint must load");
      assert.equal(cp.replay_dataset_generation_id, corpus.generationId);
      records.push(record);
    }

    // Valid-binding wrong episode rejected.
    const foreign = {
      episode_id: "ep-not-in-corpus",
      dataset_mode: "final_answer_only",
      model_count: 1,
      prompt: "x",
      slots: [{ slot_id: "s0", model_id: "c0", output: "y" }],
    };
    await assert.rejects(
      () => E.evaluateEpisode(invoker, foreign, judgeModels, {
        outputDir: evalOut,
        maxRetries: 0,
        timeoutMs: 5000,
        resume: false,
        quiet: true,
        replayBinding: corpus.replayBinding,
      }),
      /not a member of the bound replay corpus/,
    );
    // Valid-binding wrong judges rejected.
    const wrongJudges = C.resolveJudgeModels("openai/gpt-5.6-sol");
    await assert.rejects(
      () => E.evaluateEpisode(invoker, corpus.episodes[0], wrongJudges, {
        outputDir: evalOut,
        maxRetries: 0,
        timeoutMs: 5000,
        resume: false,
        quiet: true,
        replayBinding: corpus.replayBinding,
      }),
      /fixed replay judge roles/,
    );
    // Bare generation id rejected even when it matches the real id.
    await assert.rejects(
      () => E.evaluateEpisode(invoker, corpus.episodes[0], judgeModels, {
        outputDir: evalOut,
        maxRetries: 0,
        timeoutMs: 5000,
        resume: false,
        quiet: true,
        replayDatasetGenerationId: corpus.generationId,
      }),
      /bare replayDatasetGenerationId|replayBinding/,
    );

    const runFacts = {
      new_calls: records.reduce((s, r) => s + (r.summary?.new_calls ?? 0), 0),
      episodes_in_run: records.length,
      limit: records.length,
      concurrency: 1,
      max_retries: 0,
      timeout_ms: 5000,
      resume: true,
      no_resume: false,
    };
    const summary = E.publishReplayEvalGeneration({
      replayBinding: corpus.replayBinding,
      outputDir: evalOut,
      episodes: corpus.episodes,
      records,
      judgeModels,
      episodesPath: corpus.episodesPath,
      runFacts,
    });
    assert.equal(summary.kind, "t0_replay_eval_generation");
    assert.equal(summary.replay_dataset_generation_id, corpus.generationId);
    assert.equal(summary.protocol_hash, C.buildJudgeProtocolHash(corpus.generationId));

    // Index / record / summary all carry the real marker generation.
    const indexText = fs.readFileSync(path.join(evalOut, "eval-index.jsonl"), "utf8");
    for (const line of indexText.trim().split("\n")) {
      const row = JSON.parse(line);
      assert.equal(row.replay_dataset_generation_id, corpus.generationId);
    }
    for (const r of records) {
      const onDisk = JSON.parse(fs.readFileSync(path.join(evalOut, "eval", `${r.episode_id}.json`), "utf8"));
      assert.equal(onDisk.replay_dataset_generation_id, corpus.generationId);
    }
    const summaryOnDisk = JSON.parse(fs.readFileSync(path.join(evalOut, "summary.json"), "utf8"));
    assert.equal(summaryOnDisk.kind, "t0_replay_eval_generation");
    assert.equal(summaryOnDisk.replay_dataset_generation_id, corpus.generationId);

    const loaded = C.loadCommittedEvalGeneration(evalOut, {
      episodes: corpus.episodes,
      expectedJudgeModels: judgeModels,
      expectedReplayDatasetGenerationId: fixture.built.generationId,
    });
    assert.ok(loaded);
    assert.equal(loaded.summary.replay_dataset_generation_id, fixture.built.generationId);
    assert.equal(loaded.records.length, records.length);

    // Wrong corpus (reordered / truncated) publish rejected.
    assert.throws(
      () => E.publishReplayEvalGeneration({
        replayBinding: corpus.replayBinding,
        outputDir: path.join(tmp, "bad-corpus"),
        episodes: [...corpus.episodes].reverse(),
        records,
        judgeModels,
        episodesPath: corpus.episodesPath,
        runFacts,
      }),
      /ordered corpus|corpus digest|identity mismatch/,
    );
    assert.throws(
      () => E.publishReplayEvalGeneration({
        replayBinding: corpus.replayBinding,
        outputDir: path.join(tmp, "bad-corpus2"),
        episodes: corpus.episodes.slice(0, 1),
        records: records.slice(0, 1),
        judgeModels,
        episodesPath: corpus.episodesPath,
        runFacts,
      }),
      /length|ordered corpus|corpus digest/,
    );
    // Forged binding rejected.
    assert.throws(
      () => E.publishReplayEvalGeneration({
        replayBinding: Object.freeze({}),
        outputDir: path.join(tmp, "bad-bind"),
        episodes: corpus.episodes,
        records,
        judgeModels,
        episodesPath: corpus.episodesPath,
        runFacts,
      }),
      /not a capability produced by loadReplayEvalCorpus/,
    );
    // Bare generation id rejected on the high-level wrapper.
    assert.throws(
      () => E.publishReplayEvalGeneration({
        replayBinding: corpus.replayBinding,
        replayDatasetGenerationId: corpus.generationId,
        outputDir: path.join(tmp, "bad-bare"),
        episodes: corpus.episodes,
        records,
        judgeModels,
        episodesPath: corpus.episodesPath,
        runFacts,
      }),
      /do not pass bare replayDatasetGenerationId/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("replay-eval capability immutability: a resolved binding context exposes NO mutable container (frozen arrays only — no Map to inject ids/hashes into); foreign episodes rejected before invoker/checkpoint/feed; real members still evaluate", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-eval-immut-"));
  try {
    const E = await import(path.join(root, "scripts/t0-eval.mjs"));
    const fixture = await makeCommittedReplayFixture(tmp);
    const corpus = await E.loadReplayEvalCorpus(fixture.output);
    const ctx = C.resolveReplayEvalBinding(corpus.replayBinding);
    assert.ok(ctx, "resolved context must be reachable");
    // Every reachable container in the resolved context is immutable: the
    // context object, the ordered id/hash arrays, the judge map and its
    // `all` array. There is NO Map (Object.freeze on a Map would still
    // accept map.set — the old episodeContentById injection vector).
    assert.ok(Object.isFrozen(ctx), "context must be frozen");
    assert.ok(Object.isFrozen(ctx.orderedEpisodeIds), "orderedEpisodeIds must be frozen");
    assert.ok(Object.isFrozen(ctx.orderedContentHashes), "orderedContentHashes must be frozen");
    assert.ok(Object.isFrozen(ctx.judgeModels), "judgeModels must be frozen");
    assert.ok(Object.isFrozen(ctx.judgeModels.all), "judgeModels.all must be frozen");
    assert.equal(ctx.episodeContentById, undefined, "no mutable Map may be exposed");
    // Injection attempts all throw (frozen) — a resolved context can never
    // mint a foreign member or rewrite a member hash.
    assert.throws(() => ctx.orderedEpisodeIds.push("ep-foreign0000000000"), TypeError, "id injection must throw");
    assert.throws(() => ctx.orderedContentHashes.push("0".repeat(64)), TypeError, "hash injection must throw");
    assert.throws(() => ctx.judgeModels.all.push("xai/grok-4.6"), TypeError, "judge injection must throw");
    assert.throws(() => { ctx.judgeModels.evaluator0 = "xai/grok-4.6"; }, TypeError, "judge field rewrite must throw");
    // A foreign episode is rejected BEFORE any invoker/checkpoint/feed work.
    const judgeModels = C.resolveJudgeModels(C.REPLAY_EVAL_JUDGE_MODELS_CSV);
    const episodeById = new Map(corpus.episodes.map((e) => [e.episode_id, e]));
    let invokerCalls = 0;
    const baseInvoker = makeEvalMockInvoker(episodeById);
    const invoker = {
      ...baseInvoker,
      auditStreamSimple: async (...args) => {
        invokerCalls++;
        return baseInvoker.auditStreamSimple(...args);
      },
    };
    const foreign = {
      episode_id: "ep-not-in-corpus",
      dataset_mode: "final_answer_only",
      model_count: 1,
      prompt: "x",
      slots: [{ slot_id: "s0", model_id: "c0", output: "y" }],
    };
    const evalOut = path.join(tmp, "eval-out");
    await assert.rejects(
      () => E.evaluateEpisode(invoker, foreign, judgeModels, {
        outputDir: evalOut, maxRetries: 0, timeoutMs: 5000, resume: false, quiet: true,
        replayBinding: corpus.replayBinding,
      }),
      /not a member of the bound replay corpus/,
    );
    assert.equal(invokerCalls, 0, "no invoker call may be made for a foreign episode");
    assert.ok(!fs.existsSync(C.checkpointPath(evalOut, foreign.episode_id)), "no checkpoint may be written for a foreign episode");
    // A real member still evaluates (the frozen-array lookup works).
    const record = await E.evaluateEpisode(invoker, corpus.episodes[0], judgeModels, {
      outputDir: evalOut, maxRetries: 0, timeoutMs: 5000, resume: false, quiet: true,
      replayBinding: corpus.replayBinding,
    });
    assert.equal(record.replay_dataset_generation_id, corpus.generationId);
    assert.equal(record.episode_id, corpus.episodes[0].episode_id);
    assert.ok(invokerCalls > 0, "a real member must reach the invoker");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("nullable replay cost ternary: all-known + mixed-unknown ledgers for summarizeReplayCallsFromMeta / buildStats / replayReport total+by_model", () => {
  // All-known: two provider attempts → known_cost sum, cost_complete true, cost === known_cost.
  const knownMeta = [{
    episode_id: "rep-known",
    slots: [
      {
        model: "deepseek/deepseek-v4-flash", in_body: true, source: { kind: "replay" },
        replay: {
          attempts: 99, cost: 999, // deliberately wrong aggregates — must be ignored
          attempt_log: [
            { attempt: 0, cost: 1, cost_source: "provider" },
            { attempt: 1, cost: 2, cost_source: "estimated" },
          ],
        },
      },
      {
        model: "xai/grok-4.5", in_body: true, source: { kind: "replay" },
        replay: {
          attempts: 1, cost: 5,
          attempt_log: [{ attempt: 0, cost: 5, cost_source: "provider" }],
        },
      },
    ],
  }];
  const known = R.summarizeReplayCallsFromMeta(knownMeta);
  assert.equal(known.total, 2);
  assert.equal(known.ok, 2);
  assert.equal(known.attempts, 3, "attempts must come from ledger length, not r.attempts");
  assert.equal(known.known_cost, 8);
  assert.equal(known.unknown_attempts, 0);
  assert.equal(known.cost_complete, true);
  assert.equal(known.cost, 8);
  assert.equal(known.cost_source, "mixed");
  assert.deepEqual(known.cost_breakdown, { provider: 6, estimated: 2, unknown: 0 });
  assert.equal(known.by_model["deepseek/deepseek-v4-flash"].known_cost, 3);
  assert.equal(known.by_model["deepseek/deepseek-v4-flash"].cost, 3);
  assert.equal(known.by_model["deepseek/deepseek-v4-flash"].cost_complete, true);
  assert.equal(known.by_model["deepseek/deepseek-v4-flash"].attempts, 2);
  assert.equal(known.by_model["xai/grok-4.5"].cost, 5);
  // replayReport must share the same ternary.
  const knownRep = replayReport(knownMeta);
  assert.equal(knownRep.calls.cost, 8);
  assert.equal(knownRep.calls.cost_complete, true);
  assert.equal(knownRep.calls.known_cost, 8);

  // Mixed unknown: non-number cost never completes as 0; known_cost is the known subtotal.
  const mixedMeta = [{
    episode_id: "rep-mixed",
    slots: [
      {
        model: "deepseek/deepseek-v4-flash", in_body: true, source: { kind: "replay" },
        replay: {
          attempts: 2, cost: 1,
          attempt_log: [
            { attempt: 0, cost: 1, cost_source: "provider" },
            { attempt: 1, cost: null, cost_source: null },
          ],
        },
      },
      {
        model: "xai/grok-4.5", in_body: false, source: { kind: "replay" },
        replay: {
          attempts: 1, cost: null,
          attempt_log: [{ attempt: 0, cost: undefined, cost_source: "unknown" }],
        },
      },
    ],
  }];
  const mixed = R.summarizeReplayCallsFromMeta(mixedMeta);
  assert.equal(mixed.total, 2);
  assert.equal(mixed.ok, 1);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.attempts, 3);
  assert.equal(mixed.known_cost, 1);
  assert.equal(mixed.unknown_attempts, 2);
  assert.equal(mixed.cost_complete, false);
  assert.equal(mixed.cost, null, "incomplete known subtotal is never the complete cost");
  assert.equal(mixed.by_model["deepseek/deepseek-v4-flash"].known_cost, 1);
  assert.equal(mixed.by_model["deepseek/deepseek-v4-flash"].unknown_attempts, 1);
  assert.equal(mixed.by_model["deepseek/deepseek-v4-flash"].cost, null);
  assert.equal(mixed.by_model["deepseek/deepseek-v4-flash"].cost_complete, false);
  assert.equal(mixed.by_model["xai/grok-4.5"].known_cost, 0);
  assert.equal(mixed.by_model["xai/grok-4.5"].unknown_attempts, 1);
  assert.equal(mixed.by_model["xai/grok-4.5"].cost, null);
  const mixedRep = replayReport(mixedMeta);
  assert.equal(mixedRep.calls.cost, null);
  assert.equal(mixedRep.calls.cost_complete, false);
  assert.equal(mixedRep.calls.known_cost, 1);
  assert.equal(mixedRep.calls.unknown_attempts, 2);

  // buildStats must reuse the helper via checkpoint sidecars and keep error counters.
  const stats = R.buildStats({
    options: {
      episodesPath: "/tmp/episodes.jsonl",
      metaPath: "/tmp/episodes.meta.jsonl",
      models: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
      minModels: 2,
      maxOutputBytes: 200_000,
      maxEpisodeBytes: 1_000_000,
      currentOnly: false,
      historyExcluded: false,
      requirePaired: false,
    },
    blind: { source: "seed", key: "a".repeat(64) },
    sourceEpisodes: [{ episode_id: "ep-src" }],
    selectionExcluded: [],
    checkpoints: [{ sidecar: mixedMeta[0], episode: null }],
    exclusions: [],
    corpusModelNames: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
  });
  assert.equal(stats.replay.calls.known_cost, 1);
  assert.equal(stats.replay.calls.unknown_attempts, 2);
  assert.equal(stats.replay.calls.cost_complete, false);
  assert.equal(stats.replay.calls.cost, null);
  assert.equal(stats.replay.calls.attempts, 3);
  assert.ok("degeneration" in stats.replay.calls.by_model["deepseek/deepseek-v4-flash"]);
  assert.ok("thinking_unsupported" in stats.replay.calls.by_model["deepseek/deepseek-v4-flash"]);
  // Slot-level r.cost must remain untouched by the helper.
  assert.equal(mixedMeta[0].slots[0].replay.cost, 1);
  assert.equal(mixedMeta[0].slots[1].replay.cost, null);
});

await check("aggregate CLI: normalizeReplayAggregateArgs rejects --episodes/--meta/=form/duplicates/value-less; accepts --dataset", () => {
  const ok = normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--eval", "/tmp/ev", "--output", "/tmp/out.json"]);
  assert.equal(ok.datasetDir, path.resolve("/tmp/ds"));
  assert.equal(ok.evalDir, path.resolve("/tmp/ev"));
  assert.equal(ok.output, path.resolve("/tmp/out.json"));
  assert.equal(ok.quiet, false);
  const quiet = normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--quiet"]);
  assert.equal(quiet.quiet, true);
  assert.throws(() => normalizeReplayAggregateArgs(["--episodes", "/tmp/e", "--meta", "/tmp/m"]), /--episodes/);
  assert.throws(() => normalizeReplayAggregateArgs(["--meta", "/tmp/m"]), /--meta/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset"]), /requires a directory/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset", "/tmp/a", "--dataset", "/tmp/b"]), /exactly once/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset=/tmp/ds"]), /--dataset=/);
  assert.throws(() => normalizeReplayAggregateArgs(["--episodes=/tmp/e"]), /--episodes=/);
  assert.throws(() => normalizeReplayAggregateArgs(["--meta=/tmp/m"]), /--meta=/);
  assert.throws(() => normalizeReplayAggregateArgs(["--eval"]), /requires a directory/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--eval", "/tmp/a", "--eval", "/tmp/b"]), /exactly once/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--output"]), /requires a path/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--output", "/tmp/a", "--output", "/tmp/b"]), /exactly once/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--quiet", "--quiet"]), /at most once/);
  assert.throws(() => normalizeReplayAggregateArgs(["--dataset", "/tmp/ds", "--unknown"]), /unknown argument/);
});

await check("aggregate committed path: markerless/bare-path CLI rejected; real committed fixture + bound eval succeeds with generation ids; wrong/ordinary eval rejected", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-replay-agg-committed-"));
  try {
    // Markerless dir: public files without commit marker are never evidence.
    // Spawn argv uses only statically-provable tmp roots (T0 offline lock).
    fs.mkdirSync(path.join(tmp, "bare"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "bare", "episodes.jsonl"), "\n");
    fs.writeFileSync(path.join(tmp, "bare", "episodes.meta.jsonl"), "\n");
    let bareRun;
    try {
      execFileSync(process.execPath, [
        path.join(root, "scripts", "t0-replay-aggregate.mjs"),
        "--dataset", path.join(tmp, "bare"),
        "--eval", path.join(tmp, "no-eval"),
        "--output", path.join(tmp, "out-bare.json"),
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      bareRun = { status: 0, stderr: "" };
    } catch (err) {
      bareRun = { status: err.status ?? 1, stderr: String(err.stderr ?? "") + String(err.message ?? "") };
    }
    assert.notEqual(bareRun.status, 0, "markerless dataset must fail closed");
    assert.match(String(bareRun.stderr ?? ""), /no committed replay dataset|dataset\.commit\.json/i);

    // Bare --episodes/--meta rejected at the pure normalizer surface (a
    // subprocess missing --dataset would trip the T0 offline lock).
    assert.throws(
      () => normalizeReplayAggregateArgs(["--episodes", path.join(tmp, "bare", "episodes.jsonl"), "--meta", path.join(tmp, "bare", "episodes.meta.jsonl")]),
      /--episodes/,
    );

    // Positive: real committed mock fixture + existing bound eval positive fixture.
    // Dataset dir is the fixture output at path.join(tmp, "pos", "output") —
    // the spawn must name that path literally so the offline lock can prove
    // the tmp root (fixture.output itself is not statically analyzable).
    const E = await import(path.join(root, "scripts/t0-eval.mjs"));
    const fixture = await makeCommittedReplayFixture(path.join(tmp, "pos"));
    assert.equal(fixture.output, path.join(tmp, "pos", "output"));
    const corpus = await E.loadReplayEvalCorpus(path.join(tmp, "pos", "output"));
    const judgeModels = C.resolveJudgeModels(C.REPLAY_EVAL_JUDGE_MODELS_CSV);
    const episodeById = new Map(corpus.episodes.map((e) => [e.episode_id, e]));
    const invoker = makeEvalMockInvoker(episodeById);
    const records = [];
    for (const episode of corpus.episodes) {
      records.push(await E.evaluateEpisode(invoker, episode, judgeModels, {
        outputDir: path.join(tmp, "pos-eval"),
        maxRetries: 0,
        timeoutMs: 5000,
        resume: false,
        quiet: true,
        replayBinding: corpus.replayBinding,
      }));
    }
    const runFacts = {
      new_calls: records.reduce((s, r) => s + (r.summary?.new_calls ?? 0), 0),
      episodes_in_run: records.length,
      limit: records.length,
      concurrency: 1,
      max_retries: 0,
      timeout_ms: 5000,
      resume: true,
      no_resume: false,
    };
    const summary = E.publishReplayEvalGeneration({
      replayBinding: corpus.replayBinding,
      outputDir: path.join(tmp, "pos-eval"),
      episodes: corpus.episodes,
      records,
      judgeModels,
      episodesPath: corpus.episodesPath,
      runFacts,
    });
    assert.equal(summary.kind, "t0_replay_eval_generation");
    assert.equal(summary.replay_dataset_generation_id, corpus.generationId);

    execFileSync(process.execPath, [
      path.join(root, "scripts", "t0-replay-aggregate.mjs"),
      "--dataset", path.join(tmp, "pos", "output"),
      "--eval", path.join(tmp, "pos-eval"),
      "--output", path.join(tmp, "aggregate.json"),
      "--quiet",
    ], { encoding: "utf8" });
    const result = JSON.parse(fs.readFileSync(path.join(tmp, "aggregate.json"), "utf8"));
    assert.equal(result.replay_dataset_generation_id, fixture.built.generationId);
    assert.equal(result.eval_generation_id, summary.generation_id);
    assert.equal(result.episodes_evaluated, corpus.episodes.length);
    assert.ok(typeof result.replay.calls.known_cost === "number");
    assert.equal(result.replay.calls.cost_complete, result.replay.calls.unknown_attempts === 0);
    assert.equal(result.replay.calls.cost, result.replay.calls.cost_complete ? result.replay.calls.known_cost : null);

    // Wrong expected generation id rejected.
    const wrongId = "f".repeat(64);
    assert.throws(
      () => loadCommittedReplayEvalGeneration(path.join(tmp, "pos-eval"), corpus.episodes, {
        expectedReplayDatasetGenerationId: wrongId,
        expectedJudgeModels: judgeModels,
      }),
      /replay_dataset_generation_id|expected committed replay/,
    );
    // Markerless ordinary eval dir → null (not evidence) even when a
    // committed replay generation id is expected.
    fs.mkdirSync(path.join(tmp, "ordinary-eval", "eval"), { recursive: true });
    assert.equal(
      loadCommittedReplayEvalGeneration(path.join(tmp, "ordinary-eval"), corpus.episodes, {
        expectedReplayDatasetGenerationId: corpus.generationId,
        expectedJudgeModels: judgeModels,
      }),
      null,
      "markerless eval dir must return null",
    );
    // Positive: common sole disk writer accepts the real binding (no bare id).
    const rebound = C.publishEvalGeneration({
      replayBinding: corpus.replayBinding,
      outputDir: path.join(tmp, "pos-eval-rebind"),
      episodes: corpus.episodes,
      records,
      judgeModels,
      episodesPath: corpus.episodesPath,
      runFacts,
    });
    assert.equal(rebound.kind, "t0_replay_eval_generation");
    assert.equal(rebound.replay_dataset_generation_id, corpus.generationId);
    // Bare id is always rejected by the sole disk writer.
    assert.throws(
      () => C.publishEvalGeneration({
        outputDir: path.join(tmp, "pos-eval-bare"),
        episodes: corpus.episodes,
        records,
        judgeModels,
        episodesPath: corpus.episodesPath,
        runFacts,
        replayDatasetGenerationId: corpus.generationId,
      }),
      /bare replayDatasetGenerationId/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  console.error(`\nt0-replay smoke failed: ${failures.length}/${passed + failures.length}`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.error?.message || f.error}`);
  process.exit(1);
}
console.log(`\nt0-replay smoke passed: ${passed}/${passed}`);
