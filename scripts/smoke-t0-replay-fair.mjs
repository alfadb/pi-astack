#!/usr/bin/env node
/**
 * smoke-t0-replay-fair — OFFLINE DETERMINISTIC tests for fair prompt-only
 * replay selection and dual-judge classification (scripts/
 * t0-replay-fair-common.mjs + t0-replay-build.mjs helpers).
 *
 * Pure fixtures + mock invoker only (hard gates, body/meta 1:1, mechanical
 * pos/neg, dual-judge merge, dual-call with schema retry,
 * checkpoint/resume/cost, dual-judge contract, classifier protocol-hash
 * stability, fair-manifest protocol_hash binding, corpus/meta set closure)
 * plus the v2 fail-closed checkpoint lifecycle (existing malformed/stale/
 * identity-mismatch/body-invalid/failed checkpoints and --no-resume with an
 * existing checkpoint throw before any provider call with 0 invoker calls;
 * atomic create-if-absent saves never overwrite; a missing path stays the
 * only legal cache miss) and fully offline real-spawn CLI tests of
 * t0-replay-select with EXPLICIT
 * temp episodes/meta/output/checkpoint/models paths (never the production
 * default paths, no provider contact — classify-mode scenarios either fail
 * pre-request or are all-mechanical): fail-closed pre-deletion, strict
 * load, filtered-classify refusal (--episode/--limit + --output), the
 * --hard-only <value> rejection, duplicate/value-less --output ambiguity,
 * atomic publish and hard-only listings. It NEVER reads production episode
 * data or provider config, never creates a real invoker, and never sends
 * provider requests.
 *
 * The real-data hard-gate scan + CLI cross-check (read-only, no network)
 * live in the explicit dossier:
 *   npm run dossier:t0-replay-fair-production
 *
 * Full dual LLM classification is the separate `t0:replay-select` production
 * run — this smoke never self-proves success on an empty candidate set.
 *
 * Does NOT call Flash/Grok and does NOT run replay build/eval.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const C = await import(path.join(root, "scripts/t0-eval-common.mjs"));
const F = await import(path.join(root, "scripts/t0-replay-fair-common.mjs"));
const S = await import(path.join(root, "scripts/t0-replay-select.mjs"));

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

const GOOD_PROMPT = "Review the following consensus text only. Reply SIGN or REVISE.\n\nConsensus:\n1. Evidence is append-only.\n2. Projectors are pure readers.";

const EMBEDDED_CODE_PROMPT = "Review the following embedded code and reply SIGN or REVISE.\n\n```js\nexport const x = 1;\n```";

const EMBEDDED_FILE_PROMPT = "review following embedded code/file content:\n\n--- file: policy.md ---\n# Policy\nAllow read-only access.";

const CN_EMBEDDED_PROMPT = "请审阅以下代码，给出是否签署的判断。\n\nfunction foo() { return 1; }";

const FILE_PROMPT = "请阅读 /home/worker/.pi/agent/skills/pi-astack/docs/adr/0040.md 与当前代码，判断是否授权。";

const CMD_PROMPT = "Run npm run smoke:t0-eval and report whether all checks pass.";

const LIVE_PROMPT = "Review current git status and the live workspace diff.";

// Producer-shaped fixture ids: episode ids are ep-<16 hex> and slot ids are
// slot-<episode_id>-<12 hex> (the strict producer-shape inventory checks
// apply to the provenance corpus). The legacy ep-fair-000X labels are mapped
// to legal ids by the fixture builders.
const FIX_F1 = "ep-0a1b2c3d4e5f60b1";
const FIX_F2 = "ep-0a1b2c3d4e5f60b2";
const FIX_F3 = "ep-0a1b2c3d4e5f60b3";
const FIX_F4 = "ep-0a1b2c3d4e5f60b4";
const FIX_F5 = "ep-0a1b2c3d4e5f60b5";
const FIX_F6 = "ep-0a1b2c3d4e5f60b6";
const FIX_F7 = "ep-0a1b2c3d4e5f60b7";
const FIX_F8 = "ep-0a1b2c3d4e5f60b8";
const FIX_ORPHAN_FAIR = "ep-0a1b2c3d4e5f60c1";
const FIX_CLI1 = "ep-0a1b2c3d4e5f60d1";
const FIX_CLI2 = "ep-0a1b2c3d4e5f60d2";
const FIX_CLI7 = "ep-0a1b2c3d4e5f60d7";
const FIX_CLI_M1 = "ep-0a1b2c3d4e5f60e1";
const FIX_CLI_M2 = "ep-0a1b2c3d4e5f60e2";
const FIX_CLI_M3 = "ep-0a1b2c3d4e5f60e3";
const FIX_FAIR_IDS = {
  "ep-fair-0001": FIX_F1,
  "ep-fair-0002": FIX_F2,
  "ep-fair-0003": FIX_F3,
  "ep-fair-0004": FIX_F4,
  "ep-fair-0005": FIX_F5,
  "ep-fair-0006": FIX_F6,
  "ep-fair-0007": FIX_F7,
  "ep-fair-0008": FIX_F8,
  "ep-cli-0001": FIX_CLI1,
  "ep-cli-0002": FIX_CLI2,
  "ep-cli-0007": FIX_CLI7,
  "ep-cli-mech-0001": FIX_CLI_M1,
  "ep-cli-mech-0002": FIX_CLI_M2,
  "ep-cli-mech-0003": FIX_CLI_M3,
};
function fixFairId(id) { return FIX_FAIR_IDS[id] ?? id; }
function fSlot(episodeId, n) {
  return `slot-${episodeId}-${String(n).padStart(12, "0")}`;
}

function makeEpisode(id, {
  prompt = GOOD_PROMPT,
  tools = null,
  join_confidence = "exact",
  slots = null,
} = {}) {
  const eid = fixFairId(id);
  // Producer contract: body slots carry exact|heuristic; the episode-level
  // value is DERIVED from the slots (single distinct value, or "mixed"). A
  // "mixed" episode therefore has a mix of exact/heuristic slots.
  const slotConfidence = join_confidence === "mixed" ? null : join_confidence;
  const defaultSlots = [
    { slot_id: fSlot(eid, 1), model_id: "c0", output: "SIGN", output_source: "dispatch_trace", output_chars: 4, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: slotConfidence ?? "exact", join_note: join_confidence, missing_evidence: [] },
    { slot_id: fSlot(eid, 2), model_id: "c1", output: "SIGN with notes", output_source: "dispatch_trace", output_chars: 15, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: slotConfidence ?? "heuristic", join_note: join_confidence, missing_evidence: [] },
    { slot_id: fSlot(eid, 3), model_id: "c2", output: "REVISE point 2", output_source: "dispatch_trace", output_chars: 14, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: slotConfidence ?? "heuristic", join_note: join_confidence, missing_evidence: [] },
  ];
  const bodySlots = slots ?? defaultSlots;
  return {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: eid,
    prompt,
    thinking_level: "high",
    tools,
    model_count: bodySlots.length,
    join_confidence,
    missing_evidence: [],
    slots: bodySlots,
  };
}

function makeMeta(id, models, { mapOrphan = false } = {}) {
  const eid = fixFairId(id);
  const slots = models.map((model, i) => ({
    slot_id: mapOrphan && i === 1 ? fSlot(eid, 99) : fSlot(eid, i + 1),
    model,
    in_body: true,
    exclusion_reason: null,
  }));
  return { schema_version: 3, dataset_mode: "final_answer_only", episode_id: eid, slots };
}

const STRONG = "openai/gpt-5.5";
const SPEC = "moonshotai/kimi-k2.7-code";
const OTHER = "deepseek/deepseek-v4-pro";
const JUDGE = "openai/gpt-5.6-sol";

const FIXTURE_EPISODES = [
  makeEpisode("ep-fair-0001"), // exact + good — hard pass
  makeEpisode("ep-fair-0002", { join_confidence: "mixed" }), // mixed join — exclude
  makeEpisode("ep-fair-0003", { tools: "read,bash" }), // tools not null
  makeEpisode("ep-fair-0004"), // contains judge model (via meta)
  makeEpisode("ep-fair-0005", {
    slots: [
      { slot_id: fSlot(FIX_F5, 1), model_id: "c0", output: "A", output_source: "dispatch_trace", output_chars: 1, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
      { slot_id: fSlot(FIX_F5, 2), model_id: "c1", output: "B", output_source: "dispatch_trace", output_chars: 1, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
    ],
  }),
  makeEpisode("ep-fair-0006", { prompt: FILE_PROMPT }), // mechanical files
  makeEpisode("ep-fair-0007", { join_confidence: "heuristic" }), // builder heuristic — ALLOWED
  makeEpisode("ep-fair-0008", { prompt: EMBEDDED_CODE_PROMPT }), // embedded code — must hard-pass + not mechanical
];

const FIXTURE_META = [
  makeMeta("ep-fair-0001", [STRONG, SPEC, OTHER]),
  makeMeta("ep-fair-0002", [STRONG, SPEC, OTHER]),
  makeMeta("ep-fair-0003", [STRONG, "minimax/MiniMax-M3", OTHER]),
  makeMeta("ep-fair-0004", [JUDGE, STRONG, SPEC]),
  makeMeta("ep-fair-0005", [STRONG, SPEC], { mapOrphan: true }),
  makeMeta("ep-fair-0006", ["anthropic/claude-opus-4-8", "zai-coding-cn/glm-5.2", "minimax/MiniMax-M3"]),
  makeMeta("ep-fair-0007", [STRONG, SPEC, OTHER]),
  makeMeta("ep-fair-0008", [STRONG, SPEC, OTHER]),
];

function goodJudgment(overrides = {}) {
  return {
    schema_version: 1,
    replayable: true,
    requires_workspace: false,
    requires_files: false,
    requires_commands: false,
    requires_live_external_state: false,
    requires_tool_verification: false,
    reasons: ["self-contained embedded text"],
    confidence: 0.85,
    ...overrides,
  };
}

/**
 * Mock invoker that routes through callJudge's real path (registry +
 * auditStreamSimple). Supports per-model scripted responses and schema-failure
 * then success for retry coverage.
 */
function makeMockInvoker(script) {
  const state = { calls: [] };
  const invoker = {
    state,
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}` }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async (_root, meta, _piAi, _model, opts) => {
      const modelRef = meta.model_ref;
      state.calls.push({ modelRef, attempt: meta.attempt, opts });
      const q = script[modelRef];
      if (!q || !q.length) {
        throw new Error(`no scripted response for ${modelRef}`);
      }
      const step = q.shift();
      if (step.throw) throw new Error(step.throw);
      if (step.toolArgs !== undefined) {
        return {
          stopReason: "stop",
          content: [{ type: "toolCall", name: "submit_classification", arguments: step.toolArgs }],
          usage: step.usage ?? { input: 10, output: 20, cost: step.cost ?? 0.01 },
        };
      }
      return {
        stopReason: step.stopReason ?? "stop",
        content: [{ type: "text", text: step.text ?? "" }],
        usage: step.usage ?? { input: 10, output: 5, cost: step.cost ?? 0.005 },
      };
    },
  };
  return invoker;
}

/**
 * Complete legal v2 completed-checkpoint fixture payload: dual judgments +
 * per-judge ledger with unique request_ids and usage-consistent cost/source,
 * final rebuilt from the producer's own merge/summary helpers. Shared by the
 * checkpoint-binding, atomic-save and stale/fail-closed lifecycle tests so
 * they never drift.
 */
function completedCheckpointFixture({
  episodeId = FIX_F1,
  prompt = GOOD_PROMPT,
  judge_models = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
  thinking = "medium",
  requestPrefix = "req-cp",
  replayable = true,
  confidence = 0.9,
  reason = "ok",
} = {}) {
  const prompt_hash = F.promptHash(prompt);
  const protocol_hash = F.classifierProtocolHash();
  const allFalseFlags = {
    requires_workspace: false, requires_files: false, requires_commands: false,
    requires_live_external_state: false, requires_tool_verification: false,
  };
  const j0 = { ok: true, judgment: { schema_version: 1, replayable, ...allFalseFlags, reasons: [reason], confidence } };
  const j1 = { ok: true, judgment: { schema_version: 1, replayable, ...allFalseFlags, reasons: [reason], confidence } };
  const merged = F.mergeDualJudgments(j0, j1, { judge0: judge_models[0], judge1: judge_models[1] });
  const attempt_log = {
    [judge_models[0]]: [{ attempt: 0, request_id: `${requestPrefix}-0`, model_ref: judge_models[0], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(merged.judgments[judge_models[0]])), usage: { input: 10, output: 5, cost: { total: 0.01 } }, cost: 0.01, cost_source: "provider" }],
    [judge_models[1]]: [{ attempt: 0, request_id: `${requestPrefix}-1`, model_ref: judge_models[1], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(merged.judgments[judge_models[1]])), usage: { input: 10, output: 5, cost: { total: 0.01 } }, cost: 0.01, cost_source: "provider" }],
  };
  const costSummary = F.summarizeClassifierCosts(attempt_log);
  const final = {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    episode_id: episodeId,
    stage: "llm",
    classification_status: "completed",
    replayable: merged.replayable,
    reasons: merged.reasons,
    confidence: merged.confidence,
    cost: costSummary.cost,
    cost_source: costSummary.cost_source,
    cost_breakdown: costSummary.cost_breakdown,
    has_unknown_cost: costSummary.has_unknown,
    known_total: costSummary.known_total,
    attempts: 2,
    judge_models,
    prompt_hash,
    protocol_hash,
    thinking,
    from_checkpoint: false,
    flags: merged.flags,
    disagreement: merged.disagreement,
    judgments: merged.judgments,
    attempt_log,
  };
  return {
    payload: {
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: episodeId,
      prompt_hash,
      protocol_hash,
      judge_models,
      thinking,
      judgments: merged.judgments,
      attempt_log,
      final,
    },
    final,
    prompt,
  };
}

// ── Section 1: fixtures ───────────────────────────────────────────────────

console.log("t0-replay-fair unit tests (fixtures + mock invoker)\n");

await check("hard gates: exact|heuristic + tools_null + strong + specialist + no_downstream_judge + map", () => {
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById, { limit: undefined });
  const ids = hard.candidates.map((c) => c.episode.episode_id).sort();
  assert.deepEqual(
    ids,
    [FIX_F1, FIX_F6, FIX_F7, FIX_F8],
    `hard-pass ids=${ids.join(",")}`,
  );
  // exact preferred before heuristic
  const order = hard.candidates.map((c) => c.episode.episode_id);
  const exactIdx = order.indexOf(FIX_F1);
  const heurIdx = order.indexOf(FIX_F7);
  assert.ok(exactIdx < heurIdx, "exact must sort before heuristic");
  assert.equal(hard.join_tier.exact, 3);
  assert.equal(hard.join_tier.heuristic, 1);

  const byId = Object.fromEntries(hard.excluded.map((e) => [e.episode_id, e.reasons]));
  assert.ok(byId[FIX_F2]?.includes("join_not_allowed"));
  assert.ok(byId[FIX_F3]?.includes("tools_not_null"));
  assert.ok(byId[FIX_F4]?.includes("contains_judge_model"));
  assert.ok(byId[FIX_F5]?.includes("body_meta_slot_map_incomplete"));
});

await check("tools must be strict null (empty string / undefined fail)", () => {
  const meta = makeMeta("ep-tools", [STRONG, SPEC, OTHER]);
  const empty = makeEpisode("ep-tools", { tools: "" });
  empty.tools = "";
  const g1 = F.evaluateHardGates(empty, meta);
  assert.equal(g1.ok, false);
  assert.ok(g1.reasons.includes("tools_not_null"));
  const undef = makeEpisode("ep-tools2");
  delete undef.tools;
  const g2 = F.evaluateHardGates(undef, makeMeta("ep-tools2", [STRONG, SPEC, OTHER]));
  assert.equal(g2.ok, false);
  assert.ok(g2.reasons.includes("tools_not_null"));
});

await check("contains_judge_model uses downstream judges only (not classifier set alone)", () => {
  const ep = makeEpisode("ep-dj");
  const meta = makeMeta("ep-dj", ["openai/gpt-5.6-sol", STRONG, SPEC]);
  // Default downstream includes Sol → exclude
  const gDefault = F.evaluateHardGates(ep, meta);
  assert.ok(gDefault.reasons.includes("contains_judge_model"));
  // Empty-of-Sol downstream → pass (classifier Sol is independent)
  const gCustom = F.evaluateHardGates(ep, meta, {
    downstreamJudges: ["kimi-coding/k3"],
  });
  assert.equal(gCustom.ok, true, gCustom.reasons.join(","));
});

await check("body/meta 1:1 map detects orphan and count mismatch", () => {
  const ep = FIXTURE_EPISODES.find((e) => e.episode_id === FIX_F5);
  const meta = FIXTURE_META.find((m) => m.episode_id === FIX_F5);
  const map = F.bodyMetaSlotMapComplete(ep, meta);
  assert.equal(map.ok, false);
  const good = F.bodyMetaSlotMapComplete(
    FIXTURE_EPISODES.find((e) => e.episode_id === FIX_F1),
    FIXTURE_META.find((m) => m.episode_id === FIX_F1),
  );
  assert.equal(good.ok, true);
});

await check("mechanical exclude: positives exclude, embedded-code negatives do not", () => {
  for (const p of F.MECHANICAL_POSITIVE_EXAMPLES) {
    const r = F.mechanicalExclude(p);
    assert.equal(r.excluded, true, `expected exclude: ${p.slice(0, 60)}`);
  }
  for (const p of F.MECHANICAL_NEGATIVE_EXAMPLES) {
    const r = F.mechanicalExclude(p);
    assert.equal(r.excluded, false, `false positive: ${p.slice(0, 60)} → ${r.reasons.join(",")}`);
  }
  // explicit named fixtures
  assert.equal(F.mechanicalExclude(FILE_PROMPT).excluded, true);
  assert.equal(F.mechanicalExclude(CMD_PROMPT).excluded, true);
  assert.equal(F.mechanicalExclude(LIVE_PROMPT).excluded, true);
  assert.equal(F.mechanicalExclude(GOOD_PROMPT).excluded, false);
  assert.equal(F.mechanicalExclude(EMBEDDED_CODE_PROMPT).excluded, false);
  assert.equal(F.mechanicalExclude(EMBEDDED_FILE_PROMPT).excluded, false);
  assert.equal(F.mechanicalExclude(CN_EMBEDDED_PROMPT).excluded, false);
});

await check("normalizeClassifierJudgment: requires_* forces non-replayable", () => {
  const bad = F.normalizeClassifierJudgment({
    schema_version: 1,
    replayable: true,
    requires_workspace: false,
    requires_files: true,
    requires_commands: false,
    requires_live_external_state: false,
    requires_tool_verification: false,
    reasons: ["needs files"],
    confidence: 0.9,
  });
  assert.equal(bad.ok, true);
  assert.equal(bad.judgment.replayable, false);
  assert.ok(bad.judgment.normalized?.includes("requires_true_forces_non_replayable"));
});

await check("mergeDualJudgments: either false or disagreement → fail-closed; third rejected", () => {
  const yes = { ok: true, judgment: goodJudgment() };
  const no = {
    ok: true,
    judgment: goodJudgment({
      replayable: false,
      requires_workspace: true,
      reasons: ["needs workspace"],
      confidence: 0.7,
    }),
  };
  const disagree = F.mergeDualJudgments(yes, no, { judge0: "sol", judge1: "opus" });
  assert.equal(disagree.replayable, false);
  assert.equal(disagree.disagreement, true);
  const bothYes = F.mergeDualJudgments(yes, yes, { judge0: "sol", judge1: "opus" });
  assert.equal(bothYes.replayable, true);
  const bothNo = F.mergeDualJudgments(no, no, { judge0: "sol", judge1: "opus" });
  assert.equal(bothNo.replayable, false);
  assert.throws(
    () => F.mergeDualJudgments(yes, yes, { judge0: "sol", judge1: "sol" }),
    /distinct/,
  );
});

await check("requireExactlyTwoDistinctJudges: rejects 1 / 3 / duplicates", () => {
  assert.deepEqual(
    F.requireExactlyTwoDistinctJudges(["openai/gpt-5.6-sol", "anthropic/claude-opus-5"]),
    ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
  );
  assert.throws(() => F.requireExactlyTwoDistinctJudges(["a"]), /exactly 2/);
  assert.throws(() => F.requireExactlyTwoDistinctJudges(["a", "b", "c"]), /third/);
  assert.throws(() => F.requireExactlyTwoDistinctJudges(["a", "a"]), /distinct/);
  assert.throws(() => F.requireDownstreamJudges([]), /1\.\.5/);
  assert.throws(() => F.requireDownstreamJudges(["a", "a"]), /distinct/);
  assert.deepEqual(F.requireDownstreamJudges(["a", "b", "c"]), ["a", "b", "c"]);
});

await check("protocol hash is stable for fixed protocol text", () => {
  const h1 = F.classifierProtocolHash();
  const h2 = F.classifierProtocolHash();
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  const h3 = F.classifierProtocolHash({ systemPrompt: "different" });
  assert.notEqual(h1, h3);
});

await check("checkpoint binds schema_version + episode_id + prompt_hash + protocol_hash + 2 judges + thinking; malformed/stale/identity/body-invalid existing checkpoints FAIL CLOSED (throw, never a cache miss)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cp-"));
  const episodeId = FIX_F1;
  const judge_models = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  const thinking = "medium";
  const { payload } = completedCheckpointFixture({ episodeId, judge_models, thinking, requestPrefix: "req-cp" });
  const { prompt_hash, protocol_hash } = payload;
  const file = path.join(tmp, "checkpoints", `${episodeId}.json`);
  const saveBody = (extra = {}) => F.saveClassifierCheckpoint(tmp, episodeId, { ...payload, ...extra }, { prompt: GOOD_PROMPT });
  const load = (opts = {}) => F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash, protocol_hash, judge_models, thinking, prompt: GOOD_PROMPT, ...opts,
  });
  saveBody();
  const hit = load();
  assert.ok(hit);
  assert.equal(hit.final.replayable, true);

  // ── v2 lifecycle fail-closed: an EXISTING checkpoint that is not a valid
  // completed hit under the CURRENT contract THROWS — it is never a cache
  // miss and never silently re-classified. ──
  assert.throws(() => load({ prompt_hash: F.promptHash("other") }), /identity mismatch \(prompt_hash/);
  assert.throws(() => load({ protocol_hash: "0".repeat(64) }), /stale \(protocol_hash/);
  assert.throws(() => load({ judge_models: ["openai/gpt-5.6-sol", "other/model"] }), /identity mismatch \(judge_models/);
  assert.throws(() => load({ thinking: "high" }), /identity mismatch \(thinking/);

  // Incomplete final schema → the write-time self-validation refuses to
  // persist a body that fails the pure contract (fail-closed at the producer,
  // never a write-then-reload approximation).
  assert.throws(() => F.saveClassifierCheckpoint(tmp, episodeId, {
    ...payload,
    final: { episode_id: episodeId, replayable: true },
  }, { prompt: GOOD_PROMPT }), /refusing to write a checkpoint that fails the classifier body contract/);
  // The failed save never overwrote the previous legal checkpoint; with the
  // file removed, load() misses — a MISSING path is the only legal 0-call
  // miss (an incomplete final is never resumable).
  fs.rmSync(file, { force: true });
  assert.equal(load(), null);

  // ── fake v2 body: top-level ledger_version=2 but the body is NOT
  // recomputable from the real request ledger → throws (body invalid). ──
  saveBody();
  const originalBytes = fs.readFileSync(file, "utf8");
  const restore = () => fs.writeFileSync(file, originalBytes);
  // 1. Missing request_id.
  const noId = JSON.parse(originalBytes);
  delete noId.attempt_log[judge_models[0]][0].request_id;
  fs.writeFileSync(file, `${JSON.stringify(noId, null, 2)}\n`);
  assert.throws(() => load(), /body invalid/, "missing request_id must fail closed");
  restore();
  // 2. Duplicate request_id across judges.
  const dup = JSON.parse(originalBytes);
  dup.attempt_log[judge_models[0]][0].request_id = "req-dup";
  dup.attempt_log[judge_models[1]][0].request_id = "req-dup";
  fs.writeFileSync(file, `${JSON.stringify(dup, null, 2)}\n`);
  assert.throws(() => load(), /body invalid/, "duplicate request_id must fail closed");
  restore();
  // 3. Forged cost/source (does not match attemptCost(modelRef, usage)).
  const fakeCost = JSON.parse(originalBytes);
  fakeCost.attempt_log[judge_models[0]][0].cost = 999;
  fakeCost.attempt_log[judge_models[0]][0].cost_source = "provider";
  fakeCost.final.cost = 999;
  fakeCost.final.cost_breakdown = { provider: 999, estimated: 0, unknown: 0 };
  fs.writeFileSync(file, `${JSON.stringify(fakeCost, null, 2)}\n`);
  assert.throws(() => load(), /body invalid/, "forged cost/source must fail closed");
  restore();
  // 4. attempts mismatch (final.attempts != sum of judge log lengths).
  const badAttempts = JSON.parse(originalBytes);
  badAttempts.final.attempts = 7;
  fs.writeFileSync(file, `${JSON.stringify(badAttempts, null, 2)}\n`);
  assert.throws(() => load(), /body invalid/, "attempts mismatch must fail closed");
  restore();
  // The restored legal checkpoint resumes again (the failed attempts only
  // ever THREW — the on-disk facts were never touched).
  assert.ok(load(), "restored legal checkpoint loads again");

  fs.rmSync(tmp, { recursive: true, force: true });
});

await check("v2 lifecycle: malformed / truncated / non-object existing checkpoints throw BEFORE any invoker call (0-call, never a cache miss)", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
  assert.ok(cand);
  const cases = [
    { name: "malformed JSON", content: "{ not json" },
    { name: "truncated JSON", content: `{"ledger_version": ${F.ATTEMPT_LEDGER_VERSION}, "final": {` },
    { name: "non-object", content: "[1,2,3]" },
  ];
  for (const { name, content } of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-pre-"));
    try {
      fs.mkdirSync(path.join(tmp, "checkpoints"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "checkpoints", `${FIX_F1}.json`), content);
      const invoker = makeMockInvoker({}); // would throw if any judge were called
      await assert.rejects(
        () => F.classifyCandidate(invoker, cand, {
          judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
        }),
        /existing checkpoint .* is (malformed|not a JSON object)/,
        `${name} checkpoint must fail closed`,
      );
      assert.equal(invoker.state.calls.length, 0, `${name}: 0 provider calls before the throw`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

await check("v2 lifecycle: stale / identity-mismatch / body-invalid existing checkpoints throw BEFORE any invoker call (0-call)", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
  assert.ok(cand);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-stale-"));
  try {
    // Build a REAL completed checkpoint via the producer path (valid body),
    // then mutate the on-disk binding fields to simulate stale/foreign state.
    const invoker0 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 }],
    });
    await F.classifyCandidate(invoker0, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
    });
    const file = path.join(tmp, "checkpoints", `${FIX_F1}.json`);
    const originalBytes = fs.readFileSync(file, "utf8");
    const expectFail = async (mutate, re) => {
      const cp = JSON.parse(originalBytes);
      mutate(cp);
      fs.writeFileSync(file, `${JSON.stringify(cp, null, 2)}\n`);
      const invoker = makeMockInvoker({});
      await assert.rejects(
        () => F.classifyCandidate(invoker, cand, {
          judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
        }),
        re,
      );
      assert.equal(invoker.state.calls.length, 0, "0 provider calls before the throw");
    };
    await expectFail((cp) => { cp.ledger_version = 1; }, /stale \(ledger_version/);
    await expectFail((cp) => { cp.schema_version = 99; }, /stale \(schema_version/);
    await expectFail((cp) => { cp.protocol_hash = "0".repeat(64); }, /stale \(protocol_hash/);
    await expectFail((cp) => { cp.episode_id = "ep-other0000000000"; }, /identity mismatch \(checkpoint episode_id/);
    await expectFail((cp) => { cp.prompt_hash = "0".repeat(64); }, /identity mismatch \(prompt_hash/);
    await expectFail((cp) => { cp.judge_models = ["openai/gpt-5.6-sol", "other/model"]; }, /identity mismatch \(judge_models/);
    await expectFail((cp) => { cp.thinking = "high"; }, /identity mismatch \(thinking/);
    await expectFail((cp) => { cp.final.attempts = 7; }, /body invalid/);
    // The untouched completed checkpoint still resumes 0-call (the failed
    // attempts only ever threw — the on-disk facts were never modified).
    fs.writeFileSync(file, originalBytes);
    const invokerFinal = makeMockInvoker({});
    const resumed = await F.classifyCandidate(invokerFinal, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
    });
    assert.equal(resumed.from_checkpoint, true);
    assert.equal(invokerFinal.state.calls.length, 0, "restored completed checkpoint resumes 0-call");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("v2 lifecycle: --no-resume with an existing checkpoint (valid or invalid) throws BEFORE any invoker call — paid facts never wiped; a fresh dir proceeds", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
  assert.ok(cand);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-noresume-"));
  try {
    // A real completed checkpoint (paid facts) on disk.
    const invoker0 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 }],
    });
    await F.classifyCandidate(invoker0, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
    });
    const file = path.join(tmp, "checkpoints", `${FIX_F1}.json`);
    const originalBytes = fs.readFileSync(file, "utf8");
    // resume=false + existing VALID completed checkpoint → refused, 0 calls.
    const invoker1 = makeMockInvoker({});
    await assert.rejects(
      () => F.classifyCandidate(invoker1, cand, {
        judgeModels: [sol, opus], outputDir: tmp, resume: false, thinking: "medium",
      }),
      /--no-resume refuses to overwrite existing checkpoint/,
    );
    assert.equal(invoker1.state.calls.length, 0, "no-resume + valid existing: 0 provider calls");
    assert.equal(fs.readFileSync(file, "utf8"), originalBytes, "valid existing checkpoint untouched");
    // resume=false + existing INVALID file → still refused, 0 calls.
    fs.writeFileSync(file, "{ corrupt garbage");
    const invoker2 = makeMockInvoker({});
    await assert.rejects(
      () => F.classifyCandidate(invoker2, cand, {
        judgeModels: [sol, opus], outputDir: tmp, resume: false, thinking: "medium",
      }),
      /--no-resume refuses to overwrite existing checkpoint/,
    );
    assert.equal(invoker2.state.calls.length, 0, "no-resume + invalid existing: 0 provider calls");
    assert.equal(fs.readFileSync(file, "utf8"), "{ corrupt garbage", "invalid existing checkpoint untouched");
    // resume=false + FRESH dir → normal classification proceeds (missing
    // path is the legal fresh case).
    const fresh = path.join(tmp, "fresh");
    const invoker3 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ confidence: 0.75 }), cost: 0.02 }],
    });
    const freshResult = await F.classifyCandidate(invoker3, cand, {
      judgeModels: [sol, opus], outputDir: fresh, resume: false, thinking: "medium",
    });
    assert.equal(freshResult.classification_status, "completed");
    assert.ok(invoker3.state.calls.length >= 2, "fresh --no-resume dir classifies normally");
    assert.ok(fs.existsSync(path.join(fresh, "checkpoints", `${FIX_F1}.json`)), "fresh checkpoint saved");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("saveClassifierCheckpoint: atomic create-if-absent — no tmp left, existing byte-identical, second save / pre-existing target rejected (race loser)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-atomic-"));
  const episodeId = FIX_F1;
  const judge_models = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  const thinking = "medium";
  const { payload } = completedCheckpointFixture({ episodeId, judge_models, thinking, requestPrefix: "req-atomic" });
  const scanTmp = (dir) => {
    const out = [];
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) out.push(...scanTmp(p));
      else if (n.includes(".tmp-")) out.push(p);
    }
    return out;
  };
  try {
    const file = F.saveClassifierCheckpoint(tmp, episodeId, payload, { prompt: GOOD_PROMPT });
    assert.ok(fs.existsSync(file));
    const firstBytes = fs.readFileSync(file, "utf8");
    assert.deepEqual(scanTmp(tmp), [], "atomic save must leave no temp files");
    // A second save of the SAME episode must be REJECTED (create-if-absent —
    // the race loser never overwrites) and the existing bytes stay identical.
    assert.throws(
      () => F.saveClassifierCheckpoint(tmp, episodeId, payload, { prompt: GOOD_PROMPT }),
      /refusing to overwrite existing checkpoint/,
      "second save of an existing episode must be rejected",
    );
    assert.equal(fs.readFileSync(file, "utf8"), firstBytes, "existing bytes unchanged after the refused second save");
    assert.deepEqual(scanTmp(tmp), [], "no temp files after the refused second save");
    // A pre-existing target (simulated concurrent writer) is likewise never
    // replaced — even by a DIFFERENT valid payload.
    const otherPayload = { ...payload, final: { ...payload.final, prompt_hash: F.promptHash("other") } };
    assert.throws(
      () => F.saveClassifierCheckpoint(tmp, episodeId, otherPayload, { prompt: GOOD_PROMPT }),
      /refusing to overwrite existing checkpoint/,
      "race-loser write must be rejected",
    );
    assert.equal(fs.readFileSync(file, "utf8"), firstBytes, "existing bytes unchanged after the race-loser write");
    assert.deepEqual(scanTmp(tmp), [], "no temp files after the race-loser write");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("mock invoker: dual call + schema-fail retry + cost breakdown", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const invoker = makeMockInvoker({
    [sol]: [
      // first attempt: invalid schema (missing confidence)
      {
        toolArgs: {
          schema_version: 1,
          replayable: true,
          requires_workspace: false,
          requires_files: false,
          requires_commands: false,
          requires_live_external_state: false,
          requires_tool_verification: false,
          reasons: ["ok"],
        },
        cost: 0.01,
      },
      // retry: valid
      { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.02 },
    ],
    [opus]: [
      { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.03 },
    ],
  });

  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
  assert.ok(cand);

  const result = await F.classifyCandidate(invoker, cand, {
    judgeModels: [sol, opus],
    maxRetries: 2,
    resume: false,
    outputDir: null,
    thinking: "medium",
  });
  assert.equal(result.replayable, true, result.reasons?.join(","));
  assert.equal(result.stage, "llm");
  assert.equal(result.judge_models.length, 2);
  assert.ok(result.attempts >= 3, `expected retries, attempts=${result.attempts}`);
  assert.equal(result.cost_source, "provider");
  assert.ok(result.cost_breakdown);
  assert.ok(result.cost_breakdown.provider > 0);
  assert.equal(typeof result.cost, "number");
  // Both models actually called
  const called = new Set(invoker.state.calls.map((c) => c.modelRef));
  assert.ok(called.has(sol) && called.has(opus), [...called].join(","));
});

await check("mock invoker: checkpoint resume skips second dual call", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-resume-"));
  const invoker1 = makeMockInvoker({
    [sol]: [{ toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.01 }],
    [opus]: [{ toolArgs: goodJudgment({ confidence: 0.75 }), cost: 0.02 }],
  });
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F8);
  assert.ok(cand);

  const first = await F.classifyCandidate(invoker1, cand, {
    judgeModels: [sol, opus],
    outputDir: tmp,
    resume: true,
    thinking: "medium",
  });
  assert.equal(first.replayable, true);
  assert.equal(first.from_checkpoint, false);
  const callsAfterFirst = invoker1.state.calls.length;
  assert.ok(callsAfterFirst >= 2);

  // Second invoker would throw if called — resume must not invoke it.
  const invoker2 = makeMockInvoker({});
  const second = await F.classifyCandidate(invoker2, cand, {
    judgeModels: [sol, opus],
    outputDir: tmp,
    resume: true,
    thinking: "medium",
  });
  assert.equal(second.from_checkpoint, true);
  assert.equal(second.replayable, true);
  assert.equal(invoker2.state.calls.length, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});

await check("runClassifierJudge: pre-request failures (model not found / auth) are 0-call — attempts=0, empty ledger, no fake unknown entries, no corrective retry", async () => {
  // Model not found: callJudge returns an empty ledger → immediate return.
  const invoker = {
    registry: {
      find: () => null,
      getApiKeyAndHeaders: async () => { throw new Error("must not be called"); },
    },
  };
  const r1 = await F.runClassifierJudge(invoker, "unknown/model", GOOD_PROMPT, { maxRetries: 3 });
  assert.equal(r1.ok, false);
  assert.equal(r1.attempts, 0, "model-not-found must be attempts=0 (no provider request)");
  assert.deepEqual(r1.attempt_log, [], "model-not-found must have an empty ledger (no fake unknown entries)");
  assert.equal(r1.cost, null);
  assert.equal(r1.cost_source, null);
  assert.deepEqual(r1.cost_breakdown, { provider: 0, estimated: 0, unknown: 0 });

  // Auth unavailable: empty ledger → immediate return, no corrective retry.
  let authCalls = 0;
  const invoker2 = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}` }),
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: false, error: "missing api key" };
      },
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => { throw new Error("must not be called"); },
  };
  const r2 = await F.runClassifierJudge(invoker2, "openai/gpt-5.6-sol", GOOD_PROMPT, { maxRetries: 3 });
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts, 0, "auth failure must be attempts=0 (no provider request)");
  assert.deepEqual(r2.attempt_log, []);
  assert.equal(authCalls, 1, "auth is checked once — no meaningless corrective retry");
});

await check("runClassifierJudge: transport/content corrective retries keep unique request_ids; cost not duplicated", async () => {
  const sol = "openai/gpt-5.6-sol";
  // Transport failure then success: 2 real requests, unique request_ids.
  let calls = 0;
  const invokerT = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}` }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => {
      calls++;
      if (calls === 1) throw new Error("429 rate limit");
      return { stopReason: "stop", content: [{ type: "toolCall", name: "submit_classification", arguments: goodJudgment({ confidence: 0.8 }) }], usage: { input: 10, output: 5, cost: 0.02 } };
    },
  };
  const t = await F.runClassifierJudge(invokerT, sol, GOOD_PROMPT, { maxRetries: 2 });
  assert.equal(t.ok, true, t.error);
  assert.equal(t.attempts, 2);
  assert.equal(t.attempt_log.length, 2);
  const tIds = t.attempt_log.map((e) => e.request_id);
  assert.ok(tIds.every((id) => typeof id === "string" && id.length > 0), "every real request must keep its request_id");
  assert.equal(new Set(tIds).size, 2, "transport retry must carry a DIFFERENT request_id");
  assert.equal(t.attempt_log[0].error_class, "transport");
  assert.equal(t.attempt_log[1].ok, true);
  assert.equal(t.cost, 0.02, "cost must not be duplicated across retries");

  // Content (schema) failure then success: 2 real requests, unique request_ids.
  let cCalls = 0;
  const invokerC = {
    registry: {
      find: (provider, modelId) => ({ provider, id: modelId, ref: `${provider}/${modelId}` }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    projectRoot: "/tmp",
    piAi: {},
    auditStreamSimple: async () => {
      cCalls++;
      if (cCalls === 1) {
        // Invalid schema (missing confidence) → content failure + corrective retry.
        return { stopReason: "stop", content: [{ type: "toolCall", name: "submit_classification", arguments: { schema_version: 1, replayable: true, requires_workspace: false, requires_files: false, requires_commands: false, requires_live_external_state: false, requires_tool_verification: false, reasons: ["ok"] } }], usage: { input: 10, output: 5, cost: 0.01 } };
      }
      return { stopReason: "stop", content: [{ type: "toolCall", name: "submit_classification", arguments: goodJudgment({ confidence: 0.9 }) }], usage: { input: 10, output: 5, cost: 0.02 } };
    },
  };
  const c = await F.runClassifierJudge(invokerC, sol, GOOD_PROMPT, { maxRetries: 2 });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.attempts, 2);
  const cIds = c.attempt_log.map((e) => e.request_id);
  assert.equal(new Set(cIds).size, 2, "content corrective retry must carry a DIFFERENT request_id");
  assert.equal(c.attempt_log[0].error_class, "content");
  assert.equal(c.attempt_log[1].ok, true);
  assert.equal(c.cost, 0.03, "both real requests' costs summed exactly once");
});

await check("classifyCandidate mechanical exclude short-circuits without LLM", async () => {
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const fileCand = hard.candidates.find((c) => c.episode.episode_id === FIX_F6);
  assert.ok(fileCand);
  const invoker = {
    registry: {
      find() { throw new Error("LLM should not be called for mechanical exclude"); },
      async getApiKeyAndHeaders() { throw new Error("LLM should not be called"); },
    },
  };
  const result = await F.classifyCandidate(invoker, fileCand, { resume: false, outputDir: null });
  assert.equal(result.replayable, false);
  assert.equal(result.stage, "mechanical");
  assert.ok(result.reasons.some((r) => r.startsWith("mechanical_")));
  assert.deepEqual(result.cost_breakdown, { provider: 0, estimated: 0, unknown: 0 });
});

await check("selectFairReplayEpisodes hard-only + mock full classify path", async () => {
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hardOnly = await F.selectFairReplayEpisodes(FIXTURE_EPISODES, metaById, {
    classify: false,
    quiet: true,
  });
  assert.equal(hardOnly.counts.hard_pass, 4);
  assert.equal(hardOnly.selected.length, 4);
  assert.equal(hardOnly.classify, false);
  // Must not self-prove from empty
  assert.ok(hardOnly.counts.hard_pass > 0);

  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  // 3 non-mechanical hard-pass (0001,0007,0008) × 2 judges
  const invoker = makeMockInvoker({
    [sol]: [
      { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 },
      { toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.01 },
      { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.01 },
    ],
    [opus]: [
      { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.02 },
      { toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.02 },
      { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 },
    ],
  });
  const full = await F.selectFairReplayEpisodes(FIXTURE_EPISODES, metaById, {
    classify: true,
    invoker,
    judgeModels: [sol, opus],
    concurrency: 2,
    quiet: true,
    resume: false,
  });
  assert.equal(full.counts.hard_pass, 4);
  assert.equal(full.counts.classified, 4);
  // 0006 mechanical exclude; three replayable
  assert.equal(full.counts.replayable, 3);
  assert.equal(full.cost.has_unknown, false);
  assert.ok(full.cost.breakdown.provider > 0);
  assert.equal(full.cost.source, "provider");
  assert.ok(full.selected.every((s) => s.tools === null));
  assert.ok(full.selected.some((s) => s.join_confidence === "heuristic"));
  assert.ok(full.selected.some((s) => s.join_confidence === "exact"));
});

await check("unknown cost is not reported as a fake zero total", () => {
  const summary = F.summarizeClassifierCosts({
    a: [{ attempt: 0, cost: null, cost_source: "unknown" }],
    b: [{ attempt: 0, cost: 0.05, cost_source: "provider" }],
  });
  assert.equal(summary.cost, null, "mixed null cost must not coerce total to a number");
  assert.equal(summary.has_unknown, true);
  assert.ok(summary.cost_breakdown);
});

// ── fair manifest provenance validation (fixture corpus + mock checkpoints) ─
// The validator must work on a fixture temp dir (paths are parameters, never
// hardcoded production paths) and reject every hand-edited / derived form.

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

function buildProvenanceFixture(dir) {
  // The provenance corpus must be inventory-consistent (episodes/meta/
  // exclusions/stats form one atomic producer unit). ep-fair-0005's meta
  // deliberately carries an orphan in_body slot (mapOrphan) for the hard-gate
  // tests — it is excluded from the provenance corpus (it was hard-excluded
  // by the map gate anyway, so hard_pass is unchanged).
  const corpusEpisodes = FIXTURE_EPISODES.filter((e) => e.episode_id !== FIX_F5);
  const corpusMeta = FIXTURE_META.filter((m) => m.episode_id !== FIX_F5);
  const metaById = new Map(corpusMeta.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(corpusEpisodes, metaById, { limit: undefined });
  const hardIds = hard.candidates.map((c) => c.episode.episode_id);
  const replayable = [FIX_F1, FIX_F7];
  const mechanicalExcluded = [FIX_F6];
  const protocol_hash = F.classifierProtocolHash();
  const judgeModels = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  const thinking = "medium";
  const checkpointDir = path.join(dir, "checkpoints-fair", "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  // Consistent producer inventory for the corpus: no episode-level terminal
  // exclusions (no orphans), stats agreeing with the corpus shape.
  const exclusions = [];
  const stats = producerStats(corpusEpisodes, corpusMeta, exclusions);
  const classifications = [];
  const selected = [];
  const excluded = hard.excluded.map((e) => ({
    episode_id: e.episode_id, stage: "hard", reasons: e.reasons, join_confidence: e.join_confidence,
  }));
  // exclusion_distribution is built with the selector's exact rule: the fresh
  // hard distribution + per-reason keys of non-replayable classifications.
  const exclusion_distribution = { ...hard.distribution };
  const ALL_FALSE_FLAGS = {
    requires_workspace: false, requires_files: false, requires_commands: false,
    requires_live_external_state: false, requires_tool_verification: false,
  };
  for (const id of hardIds) {
    const ep = corpusEpisodes.find((e) => e.episode_id === id);
    const candidate = hard.candidates.find((x) => x.episode.episode_id === id);
    const pHash = F.promptHash(ep.prompt);
    const isReplayable = replayable.includes(id);
    const stage = mechanicalExcluded.includes(id) ? "mechanical" : "llm";
    const mech = F.mechanicalExclude(ep.prompt);
    // llm stage: both judges were called (real costs); mechanical: no calls.
    const cost = stage === "llm" ? 0.03 : 0;
    const cost_source = stage === "llm" ? "provider" : null;
    const cost_breakdown = stage === "llm"
      ? { provider: 0.03, estimated: 0, unknown: 0 }
      : { provider: 0, estimated: 0, unknown: 0 };
    // The final's merged fields are computed with the producer's OWN
    // mergeDualJudgments so the checkpoint body is exactly reproducible.
    let reasons;
    let confidence;
    let flags = null;
    let disagreement = null;
    let judgments = null;
    if (stage === "llm") {
      const j0 = {
        ok: true,
        judgment: {
          schema_version: 1, replayable: isReplayable, ...ALL_FALSE_FLAGS,
          reasons: ["self-contained embedded text"], confidence: 0.85,
        },
      };
      const j1 = isReplayable
        ? { ok: true, judgment: { schema_version: 1, replayable: true, ...ALL_FALSE_FLAGS, reasons: ["self-contained embedded text"], confidence: 0.85 } }
        : { ok: true, judgment: { schema_version: 1, replayable: false, ...ALL_FALSE_FLAGS, requires_workspace: true, reasons: ["needs workspace"], confidence: 0.6 } };
      const merged = F.mergeDualJudgments(j0, j1, { judge0: judgeModels[0], judge1: judgeModels[1] });
      reasons = merged.reasons;
      confidence = merged.confidence;
      flags = merged.flags;
      disagreement = merged.disagreement;
      judgments = merged.judgments;
    } else {
      reasons = mech.reasons;
      confidence = 1;
    }
    const attempt_log = stage === "llm"
      ? {
          [judgeModels[0]]: [{ attempt: 0, request_id: `req-${id}-0`, model_ref: judgeModels[0], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(judgments[judgeModels[0]])), usage: { input: 10, output: 5, cost: { total: 0.015 } }, cost: 0.015, cost_source: "provider" }],
          [judgeModels[1]]: [{ attempt: 0, request_id: `req-${id}-1`, model_ref: judgeModels[1], operation: "t0_replay_fair_classify", ok: true, error: null, error_class: null, accepted_output_hash: C.sha256Hex(JSON.stringify(judgments[judgeModels[1]])), usage: { input: 10, output: 5, cost: { total: 0.015 } }, cost: 0.015, cost_source: "provider" }],
        }
      : null;
    const final = {
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: id,
      stage,
      classification_status: "completed",
      replayable: isReplayable,
      reasons,
      confidence,
      cost,
      cost_source,
      cost_breakdown,
      has_unknown_cost: false,
      known_total: cost,
      attempts: stage === "llm" ? 2 : 0,
      judge_models: judgeModels,
      prompt_hash: pHash,
      protocol_hash,
      thinking,
      from_checkpoint: false,
      mechanical: mech,
      ...(stage === "llm" ? { flags, disagreement, judgments, attempt_log } : {}),
    };
    fs.writeFileSync(path.join(checkpointDir, `${id}.json`), `${JSON.stringify({
      ledger_version: F.ATTEMPT_LEDGER_VERSION,
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episode_id: id,
      prompt_hash: pHash,
      protocol_hash,
      judge_models: judgeModels,
      thinking,
      mechanical: mech,
      ...(stage === "llm" ? { judgments, attempt_log } : {}),
      final,
      saved_at: "2026-08-12T00:00:00.000Z",
    }, null, 2)}\n`);
    classifications.push({
      episode_id: id, stage, replayable: isReplayable, reasons, confidence,
      join_confidence: null, cost, cost_source, cost_breakdown, from_checkpoint: false,
    });
    if (isReplayable) {
      selected.push({
        episode_id: id, models: candidate.models, join_confidence: candidate.join_confidence, tools: null,
        stage, replayable: true, confidence, reasons, flags,
        cost, cost_source, cost_breakdown, from_checkpoint: false,
      });
    } else {
      excluded.push({
        episode_id: id, stage, reasons, join_confidence: candidate.join_confidence, confidence,
        flags, cost, cost_source, from_checkpoint: false,
      });
      for (const reason of reasons) {
        const key = reason.startsWith("mechanical_") || reason.startsWith("dual_judge_")
          || reason.startsWith("either_") || reason.startsWith("judge_")
          ? reason
          : `${stage}_excluded`;
        exclusion_distribution[key] = (exclusion_distribution[key] ?? 0) + 1;
      }
      exclusion_distribution[`${stage}_total`] = (exclusion_distribution[`${stage}_total`] ?? 0) + 1;
    }
  }
  const manifest = {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    kind: "prompt_only_replay_selection",
    generated_at: "2026-08-12T00:00:00.000Z",
    protocol_hash,
    thinking,
    judge_models: judgeModels,
    classifier_models: judgeModels,
    downstream_judges: [...F.DEFAULT_DOWNSTREAM_JUDGES],
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
      join_selected: { exact: 1, heuristic: 1 },
    },
    exclusion_distribution,
    cost: { total: 0.09, known_total: 0.09, has_unknown: false, currency: "USD", source: "provider", breakdown: { provider: 0.09, estimated: 0, unknown: 0 }, note: "classifier costs via summarizeCosts; provider/estimated/unknown breakdown; unknown never coerced into a fake zero total" },
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
  return { manifest, manifestPath, checkpointDir, metaById, exclusions, stats, episodes: corpusEpisodes };
}

await check("provenance: full fixture manifest + mock checkpoints pass; hand-edited selected/reasons/classification/count are rejected", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    // Full manifest passes.
    const ok = F.validateFairManifestProvenance(base);
    assert.equal(ok.ok, true, ok.errors.join("; "));
    // Hand-edited selected (fake episode) → rejected.
    const modSel = JSON.parse(JSON.stringify(manifest));
    modSel.selected.push({ episode_id: "ep-fake000000000000", models: [], join_confidence: "heuristic", tools: null, stage: "llm", replayable: true, confidence: 0.9, reasons: ["fake"] });
    modSel.episode_ids.push("ep-fake000000000000");
    modSel.counts.replayable = modSel.selected.length;
    const rSel = F.validateFairManifestProvenance({ ...base, manifest: modSel });
    assert.equal(rSel.ok, false, "hand-edited selected must be rejected");
    assert.ok(rSel.errors.some((e) => e.includes("not a hard-pass episode")), rSel.errors.join("; "));
    // Hand-edited reasons → rejected.
    const modReasons = JSON.parse(JSON.stringify(manifest));
    modReasons.classifications[0].reasons = ["hand-edited reason"];
    const rReasons = F.validateFairManifestProvenance({ ...base, manifest: modReasons });
    assert.equal(rReasons.ok, false, "hand-edited reasons must be rejected");
    assert.ok(rReasons.errors.some((e) => e.includes("reasons differ")), rReasons.errors.join("; "));
    // Hand-edited classification (replayable flip) → rejected.
    const modClass = JSON.parse(JSON.stringify(manifest));
    modClass.classifications[0].replayable = !modClass.classifications[0].replayable;
    const rClass = F.validateFairManifestProvenance({ ...base, manifest: modClass });
    assert.equal(rClass.ok, false, "hand-edited classification must be rejected");
    // Hand-edited counts → rejected.
    const modCounts = JSON.parse(JSON.stringify(manifest));
    modCounts.counts.hard_pass = 999;
    const rCounts = F.validateFairManifestProvenance({ ...base, manifest: modCounts });
    assert.equal(rCounts.ok, false, "hand-edited counts must be rejected");
    assert.ok(rCounts.errors.some((e) => e.includes("counts.hard_pass")), rCounts.errors.join("; "));
    // Hand-edited exclusion_distribution → rejected.
    const modDist = JSON.parse(JSON.stringify(manifest));
    modDist.exclusion_distribution = { no_specialist: 999 };
    const rDist = F.validateFairManifestProvenance({ ...base, manifest: modDist });
    assert.equal(rDist.ok, false, "hand-edited exclusion_distribution must be rejected");
    // Hand-written two-line manifest (episode_ids only) → rejected.
    const hand = { schema_version: 1, kind: "prompt_only_replay_selection", protocol_hash: manifest.protocol_hash, classify: true, selected: manifest.selected, episode_ids: manifest.episode_ids };
    const rHand = F.validateFairManifestProvenance({ ...base, manifest: hand });
    assert.equal(rHand.ok, false, "hand-written two-line manifest must be rejected");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: missing checkpoint / wrong prompt hash / selected not hard-pass / empty hard-pass all fail closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-neg-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    // Missing checkpoint → rejected.
    fs.rmSync(path.join(checkpointDir, `${FIX_F1}.json`), { force: true });
    const rMissing = F.validateFairManifestProvenance(base);
    assert.equal(rMissing.ok, false, "missing checkpoint must be rejected");
    assert.ok(rMissing.errors.some((e) => e.includes("checkpoint missing")), rMissing.errors.join("; "));
    // Wrong prompt hash (checkpoint edited) → rejected.
    const cpFile = path.join(checkpointDir, `${FIX_F7}.json`);
    const cp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    cp.prompt_hash = "0".repeat(64);
    fs.writeFileSync(cpFile, `${JSON.stringify(cp, null, 2)}\n`);
    const rHash = F.validateFairManifestProvenance(base);
    assert.equal(rHash.ok, false, "wrong checkpoint prompt_hash must be rejected");
    assert.ok(rHash.errors.some((e) => e.includes("prompt_hash")), rHash.errors.join("; "));
    // Selected not hard-pass (swap a selected id to a hard-excluded episode) → rejected.
    const modSel = JSON.parse(JSON.stringify(manifest));
    modSel.selected[0].episode_id = FIX_F2;
    modSel.episode_ids[0] = FIX_F2;
    const rNotHard = F.validateFairManifestProvenance({ ...base, manifest: modSel });
    assert.equal(rNotHard.ok, false, "selected not hard-pass must be rejected");
    assert.ok(rNotHard.errors.some((e) => e.includes("not a hard-pass episode")), rNotHard.errors.join("; "));
    // Empty hard-pass (manifest claims hard_pass=0 with empty sets) → rejected.
    const modEmpty = JSON.parse(JSON.stringify(manifest));
    modEmpty.counts.hard_pass = 0;
    modEmpty.counts.hard_pass_limited = 0;
    modEmpty.counts.classified = 0;
    modEmpty.counts.replayable = 0;
    modEmpty.counts.excluded = FIXTURE_EPISODES.length;
    modEmpty.selected = [];
    modEmpty.excluded = [];
    modEmpty.classifications = [];
    modEmpty.episode_ids = [];
    const rEmpty = F.validateFairManifestProvenance({ ...base, manifest: modEmpty });
    assert.equal(rEmpty.ok, false, "empty hard-pass manifest must be rejected (no empty-set self-proof)");
    assert.ok(rEmpty.errors.some((e) => e.includes("counts.hard_pass")), rEmpty.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: reverse selected+episode_ids, selected field forgery, duplicate classification, excluded forgery, counts/distribution forgery, identity forgery, llm checkpoint body forgery all fail", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-neg2-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    // Baseline passes.
    assert.equal(F.validateFairManifestProvenance(base).ok, true, F.validateFairManifestProvenance(base).errors.join("; "));

    // 1. Reverse selected + episode_ids → rejected (order is the selector's).
    const rev = JSON.parse(JSON.stringify(manifest));
    rev.selected.reverse();
    rev.episode_ids.reverse();
    const rRev = F.validateFairManifestProvenance({ ...base, manifest: rev });
    assert.equal(rRev.ok, false, "reversed selected must be rejected");
    assert.ok(rRev.errors.some((e) => e.includes("selected[0]")), rRev.errors.join("; "));

    // 2. Selected field forgery (reasons / confidence / tools / models / join) → rejected.
    for (const [field, value] of [
      ["reasons", ["forged reason"]],
      ["confidence", 0.99],
      ["tools", "read,bash"],
      ["models", ["forged/model"]],
      ["join_confidence", "heuristic"],
    ]) {
      const mod = JSON.parse(JSON.stringify(manifest));
      mod.selected[0][field] = value;
      const r = F.validateFairManifestProvenance({ ...base, manifest: mod });
      assert.equal(r.ok, false, `selected[0].${field} forgery must be rejected`);
      assert.ok(r.errors.some((e) => e.includes(`selected[0].${field}`)), r.errors.join("; "));
    }

    // 3. Duplicate classification → rejected.
    const dup = JSON.parse(JSON.stringify(manifest));
    dup.classifications.push({ ...dup.classifications[0] });
    dup.counts.classified = dup.classifications.length;
    const rDup = F.validateFairManifestProvenance({ ...base, manifest: dup });
    assert.equal(rDup.ok, false, "duplicate classification must be rejected");
    assert.ok(rDup.errors.some((e) => e.includes("duplicate episode_id")), rDup.errors.join("; "));

    // 4. Non-hard excluded id / reasons forgery → rejected.
    const exForged = JSON.parse(JSON.stringify(manifest));
    exForged.excluded[4].reasons = ["forged reason"];
    const rEx = F.validateFairManifestProvenance({ ...base, manifest: exForged });
    assert.equal(rEx.ok, false, "excluded reasons forgery must be rejected");
    assert.ok(rEx.errors.some((e) => e.includes("excluded[4].reasons")), rEx.errors.join("; "));
    const exId = JSON.parse(JSON.stringify(manifest));
    exId.excluded[4].episode_id = FIX_F2; // a hard-excluded id in a non-hard row
    const rExId = F.validateFairManifestProvenance({ ...base, manifest: exId });
    assert.equal(rExId.ok, false, "excluded id forgery must be rejected");

    // 5. join_selected / data_insufficient forgery → rejected.
    const jf = JSON.parse(JSON.stringify(manifest));
    jf.counts.join_selected = { exact: 2, heuristic: 0 };
    const rJf = F.validateFairManifestProvenance({ ...base, manifest: jf });
    assert.equal(rJf.ok, false, "join_selected forgery must be rejected");
    assert.ok(rJf.errors.some((e) => e.includes("counts.join_selected")), rJf.errors.join("; "));
    const di = JSON.parse(JSON.stringify(manifest));
    di.counts.data_insufficient = true;
    const rDi = F.validateFairManifestProvenance({ ...base, manifest: di });
    assert.equal(rDi.ok, false, "data_insufficient forgery must be rejected");
    assert.ok(rDi.errors.some((e) => e.includes("counts.data_insufficient")), rDi.errors.join("; "));

    // 6. Extra distribution key → rejected.
    const dist = JSON.parse(JSON.stringify(manifest));
    dist.exclusion_distribution.forged_key = 1;
    const rDist = F.validateFairManifestProvenance({ ...base, manifest: dist });
    assert.equal(rDist.ok, false, "extra distribution key must be rejected");
    assert.ok(rDist.errors.some((e) => e.includes("forged_key")), rDist.errors.join("; "));

    // 7. kind / schema / downstream / judge identity forgery → rejected.
    const kind = JSON.parse(JSON.stringify(manifest));
    kind.kind = "hand_written";
    assert.equal(F.validateFairManifestProvenance({ ...base, manifest: kind }).ok, false, "kind forgery must be rejected");
    const schema = JSON.parse(JSON.stringify(manifest));
    schema.schema_version = 2;
    assert.equal(F.validateFairManifestProvenance({ ...base, manifest: schema }).ok, false, "schema_version forgery must be rejected");
    const dj = JSON.parse(JSON.stringify(manifest));
    dj.downstream_judges = ["forged/model"];
    assert.equal(F.validateFairManifestProvenance({ ...base, manifest: dj }).ok, false, "downstream_judges forgery must be rejected");
    const jm = JSON.parse(JSON.stringify(manifest));
    jm.judge_models = ["forged/model", "other/model"];
    assert.equal(F.validateFairManifestProvenance({ ...base, manifest: jm }).ok, false, "judge_models forgery must be rejected");
    const cm = JSON.parse(JSON.stringify(manifest));
    cm.classifier_models = ["forged/model", "other/model"];
    assert.equal(F.validateFairManifestProvenance({ ...base, manifest: cm }).ok, false, "classifier_models forgery must be rejected");

    // 8. llm checkpoint missing judgments/attempt_log → rejected.
    const cpFile = path.join(checkpointDir, `${FIX_F1}.json`);
    const cp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    delete cp.judgments;
    delete cp.attempt_log;
    fs.writeFileSync(cpFile, `${JSON.stringify(cp, null, 2)}\n`);
    const rBody = F.validateFairManifestProvenance(base);
    assert.equal(rBody.ok, false, "llm checkpoint missing judgments/attempt_log must be rejected");
    assert.ok(rBody.errors.some((e) => e.includes("judgments")), rBody.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: legal resume manifest (from_checkpoint=true) passes; reverse/extra classification/duplicate/伪cost/缺request_id new checkpoint all fail", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-resume-"));
  const judgeModels = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    // Baseline passes.
    assert.equal(F.validateFairManifestProvenance(base).ok, true, F.validateFairManifestProvenance(base).errors.join("; "));

    // 1. Legal resume: every classification/selected/excluded row flips
    // from_checkpoint to true (the selector resumed from its own checkpoints
    // and emitted from_checkpoint=true) — provenance must still pass, because
    // from_checkpoint is the run's source, NOT a checkpoint-final field.
    const resume = JSON.parse(JSON.stringify(manifest));
    for (const c of resume.classifications) c.from_checkpoint = true;
    for (const s of resume.selected) s.from_checkpoint = true;
    for (const e of resume.excluded) {
      if (e.stage !== "hard") e.from_checkpoint = true;
    }
    const rResume = F.validateFairManifestProvenance({ ...base, manifest: resume });
    assert.equal(rResume.ok, true, `legal resume manifest must pass: ${rResume.errors.join("; ")}`);

    // 2. Resume with a selected row that disagrees with its classification
    // row (from_checkpoint mismatch) → rejected.
    const mismatch = JSON.parse(JSON.stringify(resume));
    mismatch.selected[0].from_checkpoint = false;
    const rMismatch = F.validateFairManifestProvenance({ ...base, manifest: mismatch });
    assert.equal(rMismatch.ok, false, "selected from_checkpoint must equal the classification row");
    assert.ok(rMismatch.errors.some((e) => e.includes("selected[0].from_checkpoint")), rMismatch.errors.join("; "));

    // 3. Extra classification field (identity injection) → rejected.
    const extra = JSON.parse(JSON.stringify(manifest));
    extra.classifications[0].judgments = { forged: true };
    const rExtra = F.validateFairManifestProvenance({ ...base, manifest: extra });
    assert.equal(rExtra.ok, false, "extra classification field must be rejected");
    assert.ok(rExtra.errors.some((e) => e.includes("judgments")), rExtra.errors.join("; "));

    // 4. Extra classification row (beyond hard candidates) → rejected.
    const dup = JSON.parse(JSON.stringify(manifest));
    dup.classifications.push({ ...dup.classifications[0], episode_id: FIX_F2 });
    dup.counts.classified = dup.classifications.length;
    const rDup = F.validateFairManifestProvenance({ ...base, manifest: dup });
    assert.equal(rDup.ok, false, "extra classification row must be rejected");
    assert.ok(rDup.errors.some((e) => e.includes("classifications.length")), rDup.errors.join("; "));

    // 5. 伪cost: forged top-level cost summary → rejected (rebuilt from finals).
    const fakeCost = JSON.parse(JSON.stringify(manifest));
    fakeCost.cost.known_total = 999;
    fakeCost.cost.total = 999;
    const rCost = F.validateFairManifestProvenance({ ...base, manifest: fakeCost });
    assert.equal(rCost.ok, false, "forged top-level cost must be rejected");
    assert.ok(rCost.errors.some((e) => e.includes("manifest cost")), rCost.errors.join("; "));

    // 6. 缺request_id: a NEW-format checkpoint whose attempt_log entry lacks
    // request_id → rejected (ledger identity is mandatory).
    const cpFile = path.join(checkpointDir, `${FIX_F1}.json`);
    const cp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    delete cp.attempt_log[judgeModels[0]][0].request_id;
    fs.writeFileSync(cpFile, `${JSON.stringify(cp, null, 2)}\n`);
    const rNoId = F.validateFairManifestProvenance(base);
    assert.equal(rNoId.ok, false, "new-format checkpoint missing request_id must be rejected");
    assert.ok(rNoId.errors.some((e) => e.includes("request_id")), rNoId.errors.join("; "));

    // 7. Duplicate request_id across the checkpoint → rejected.
    const cp2 = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    cp2.attempt_log[judgeModels[0]][0].request_id = "req-dup";
    cp2.attempt_log[judgeModels[1]][0].request_id = "req-dup";
    fs.writeFileSync(cpFile, `${JSON.stringify(cp2, null, 2)}\n`);
    const rDupId = F.validateFairManifestProvenance(base);
    assert.equal(rDupId.ok, false, "duplicate request_id must be rejected");
    assert.ok(rDupId.errors.some((e) => e.includes("duplicate request_id")), rDupId.errors.join("; "));

    // 8. Stale ledger_version checkpoint → rejected.
    const cp3 = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    cp3.ledger_version = 1;
    fs.writeFileSync(cpFile, `${JSON.stringify(cp3, null, 2)}\n`);
    const rStale = F.validateFairManifestProvenance(base);
    assert.equal(rStale.ok, false, "stale ledger_version checkpoint must be rejected");
    assert.ok(rStale.errors.some((e) => e.includes("ledger_version")), rStale.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: producer inventory at the entry — missing meta fails; an ARBITRARY orphan fails closed; only the below-min terminal set (exclusion + stats agreeing) is legal", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-parity-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    assert.equal(F.validateFairManifestProvenance(base).ok, true, F.validateFairManifestProvenance(base).errors.join("; "));
    // Missing meta (an episode without a meta record): the episode would
    // otherwise be silently hard-excluded as meta_missing — a hard error at
    // the validator entry, even without a caller-side assert.
    const missingMeta = new Map(metaById);
    missingMeta.delete(FIX_F1);
    const rMissing = F.validateFairManifestProvenance({ ...base, metaById: missingMeta });
    assert.equal(rMissing.ok, false, "missing meta must fail provenance");
    assert.ok(rMissing.errors.some((e) => e.includes("has no meta record (missing_meta)") && e.includes(FIX_F1)), rMissing.errors.join("; "));
    // An ARBITRARY orphan (meta with no episode body, no below-min
    // exclusion) is NOT legal: the four-file dataset is one atomic producer
    // unit, so orphan meta ids must equal the below_min_models_after_availability
    // exclusion ids. This replaces the old "orphan tolerated" contract.
    const orphanMeta = new Map(metaById);
    orphanMeta.set(FIX_ORPHAN_FAIR, { episode_id: FIX_ORPHAN_FAIR, slots: [] });
    const rOrphan = F.validateFairManifestProvenance({ ...base, metaById: orphanMeta });
    assert.equal(rOrphan.ok, false, "arbitrary orphan meta must fail provenance");
    assert.ok(rOrphan.errors.some((e) => e.includes("orphan-without-exclusion")), rOrphan.errors.join("; "));
    // The LEGAL below-min terminal set (orphan meta + matching exclusion +
    // stats agreeing) passes the inventory at the entry.
    const legalMeta = new Map(metaById);
    legalMeta.set(FIX_ORPHAN_FAIR, {
      schema_version: 3,
      dataset_mode: "final_answer_only",
      episode_id: FIX_ORPHAN_FAIR,
      slots: [
        { slot_id: fSlot(FIX_ORPHAN_FAIR, 1), model: "m1", in_body: false, exclusion_reason: "below_min_models_after_availability" },
      ],
    });
    const legalExclusions = [
      ...exclusions,
      { episode_id: FIX_ORPHAN_FAIR, reason: "below_min_models_after_availability", model_count: 1 },
    ];
    const legalStats = {
      ...stats,
      groups: { ...stats.groups, episodes_below_min_after_availability: 1 },
      availability: { ...stats.availability, slots_excluded: 1, slots_excluded_by_reason: { below_min_models_after_availability: 1 } },
    };
    const rLegal = F.validateFairManifestProvenance({ ...base, metaById: legalMeta, exclusions: legalExclusions, stats: legalStats });
    assert.equal(rLegal.ok, true, `legal below-min terminal set must pass: ${rLegal.errors.join("; ")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: missing exclusions/stats (inventory not provided) fails closed — never a skip; stats tampering rejected", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-inv-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    // No exclusions/stats → hard error (the old missing_meta-only check is
    // gone; the full inventory is REQUIRED).
    const rNoInv = F.validateFairManifestProvenance({ manifest, episodes, metaById, checkpointDir });
    assert.equal(rNoInv.ok, false, "missing exclusions/stats must fail closed");
    assert.ok(rNoInv.errors.some((e) => e.includes("requires exclusions + stats")), rNoInv.errors.join("; "));
    // Only exclusions, no stats → still a hard error.
    const rNoStats = F.validateFairManifestProvenance({ manifest, episodes, metaById, checkpointDir, exclusions });
    assert.equal(rNoStats.ok, false, "missing stats must fail closed");
    // Stats tampering: groups.episodes wrong → rejected at the entry.
    const badStats = { ...stats, groups: { ...stats.groups, episodes: stats.groups.episodes + 1 } };
    const rTamper = F.validateFairManifestProvenance({ manifest, episodes, metaById, checkpointDir, exclusions, stats: badStats });
    assert.equal(rTamper.ok, false, "stats tampering must fail closed");
    assert.ok(rTamper.errors.some((e) => e.includes("groups.episodes")), rTamper.errors.join("; "));
    // Stats tampering: min_models not positive → rejected.
    const badMin = { ...stats, filters: { ...stats.filters, min_models: 0 } };
    const rMin = F.validateFairManifestProvenance({ manifest, episodes, metaById, checkpointDir, exclusions, stats: badMin });
    assert.equal(rMin.ok, false, "min_models tampering must fail closed");
    assert.ok(rMin.errors.some((e) => e.includes("min_models")), rMin.errors.join("; "));
    // Consistent inventory still passes.
    const ok = F.validateFairManifestProvenance({ manifest, episodes, metaById, checkpointDir, exclusions, stats });
    assert.equal(ok.ok, true, ok.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: request_id is globally unique ACROSS checkpoints in one invocation (reuse by two checkpoints rejected; standalone local uniqueness preserved; real distinct ids pass)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-reqid-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    // Baseline passes (every checkpoint's request_ids are distinct).
    assert.equal(F.validateFairManifestProvenance(base).ok, true, F.validateFairManifestProvenance(base).errors.join("; "));
    // Forge: FIX_F7's checkpoint reuses FIX_F1's request_ids. Both
    // checkpoints are individually legal (structure/cost/hash unchanged) —
    // only the cross-checkpoint reuse must fail closed.
    const cp1 = JSON.parse(fs.readFileSync(path.join(checkpointDir, `${FIX_F1}.json`), "utf8"));
    const cp7File = path.join(checkpointDir, `${FIX_F7}.json`);
    const cp7 = JSON.parse(fs.readFileSync(cp7File, "utf8"));
    const reusedIds = Object.values(cp1.attempt_log).map((log) => log[0].request_id);
    for (const [model, log] of Object.entries(cp7.attempt_log)) {
      log[0].request_id = reusedIds.shift();
      cp7.final.attempt_log[model][0].request_id = log[0].request_id;
    }
    fs.writeFileSync(cp7File, `${JSON.stringify(cp7, null, 2)}\n`);
    // Standalone validateCheckpointBody on the forged cp still passes: the
    // per-checkpoint local uniqueness semantics are preserved.
    const standalone = F.validateCheckpointBody(cp7, cp7.final, {
      id: FIX_F7, judgeModels: cp7.judge_models, prompt: episodes.find((e) => e.episode_id === FIX_F7).prompt,
    });
    assert.deepEqual(standalone, [], standalone.join("; "));
    // Full provenance rejects the cross-checkpoint reuse.
    const r = F.validateFairManifestProvenance(base);
    assert.equal(r.ok, false, "cross-checkpoint request_id reuse must be rejected");
    assert.ok(r.errors.some((e) => e.includes("duplicate request_id")), r.errors.join("; "));
    // Restore the checkpoint verbatim → passes again (real distinct ids).
    const cp7Orig = JSON.parse(fs.readFileSync(cp7File, "utf8"));
    for (const [model, log] of Object.entries(cp7Orig.attempt_log)) {
      log[0].request_id = `req-${FIX_F7}-${model === cp7Orig.judge_models[0] ? 0 : 1}`;
      cp7Orig.final.attempt_log[model][0].request_id = log[0].request_id;
    }
    fs.writeFileSync(cp7File, `${JSON.stringify(cp7Orig, null, 2)}\n`);
    const ok = F.validateFairManifestProvenance(base);
    assert.equal(ok.ok, true, ok.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("provenance: directory-mode exact direct-json inventory — extra/missing/non-regular/symlink .json fail closed; archive subdir + non-json auxiliary ignored", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-provenance-dirinv-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const base = { manifest, episodes, metaById, checkpointDir, exclusions, stats };
    // Baseline passes.
    assert.equal(F.validateFairManifestProvenance(base).ok, true, F.validateFairManifestProvenance(base).errors.join("; "));
    // Extra direct .json (not a classification) → fail closed.
    fs.writeFileSync(path.join(checkpointDir, "ep-extra000000000000.json"), "{}");
    const rExtra = F.validateFairManifestProvenance(base);
    assert.equal(rExtra.ok, false, "extra direct .json must fail closed");
    assert.ok(rExtra.errors.some((e) => e.includes("inventory must exactly cover")), rExtra.errors.join("; "));
    fs.rmSync(path.join(checkpointDir, "ep-extra000000000000.json"), { force: true });
    // Missing direct .json → fail closed.
    const cp8Bytes = fs.readFileSync(path.join(checkpointDir, `${FIX_F8}.json`), "utf8");
    fs.rmSync(path.join(checkpointDir, `${FIX_F8}.json`), { force: true });
    const rMissing = F.validateFairManifestProvenance(base);
    assert.equal(rMissing.ok, false, "missing direct .json must fail closed");
    assert.ok(rMissing.errors.some((e) => e.includes("inventory must exactly cover")), rMissing.errors.join("; "));
    // Restore the checkpoint verbatim.
    fs.writeFileSync(path.join(checkpointDir, `${FIX_F8}.json`), cp8Bytes);
    // Non-regular .json (a directory named like a checkpoint) → fail closed.
    fs.rmSync(path.join(checkpointDir, `${FIX_F8}.json`), { force: true });
    fs.mkdirSync(path.join(checkpointDir, `${FIX_F8}.json`), { recursive: true });
    const rDir = F.validateFairManifestProvenance(base);
    assert.equal(rDir.ok, false, "a directory named *.json must fail closed");
    assert.ok(rDir.errors.some((e) => e.includes("not a regular file")), rDir.errors.join("; "));
    fs.rmdirSync(path.join(checkpointDir, `${FIX_F8}.json`));
    // Symlink .json → fail closed.
    fs.symlinkSync(path.join(checkpointDir, `${FIX_F1}.json`), path.join(checkpointDir, `${FIX_F8}.json`));
    const rLink = F.validateFairManifestProvenance(base);
    assert.equal(rLink.ok, false, "a symlink named *.json must fail closed");
    assert.ok(rLink.errors.some((e) => e.includes("not a regular file")), rLink.errors.join("; "));
    fs.unlinkSync(path.join(checkpointDir, `${FIX_F8}.json`));
    fs.writeFileSync(path.join(checkpointDir, `${FIX_F8}.json`), cp8Bytes);
    // Archive subdir (with .json inside) + non-json auxiliary items are
    // IGNORED — the direct-json inventory still passes.
    fs.mkdirSync(path.join(checkpointDir, "archive"), { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "archive", "ep-old00000000000000.json"), "{}");
    fs.writeFileSync(path.join(checkpointDir, "README.txt"), "auxiliary");
    fs.writeFileSync(path.join(checkpointDir, ".gitkeep"), "");
    const ok = F.validateFairManifestProvenance(base);
    assert.equal(ok.ok, true, ok.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("publishSelectionManifest: a legal non-default downstreamJudges publishes (no default fallback after paid work); missing/wrong mismatch still fails closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-pubdj-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const output = path.join(tmp, "selection.json");
    // A legal non-default downstream set that does not change the hard
    // candidates of the fixture corpus (xai/grok-4.6 is not in any meta).
    const nonDefault = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "kimi-coding/k3", "xai/grok-4.6"];
    const payload = { ...manifest, downstream_judges: nonDefault };
    // Explicit same-set publish succeeds (the scan used this set).
    S.publishSelectionManifest({
      payload, episodes, metaById, exclusions, stats, checkpointDir, output,
      downstreamJudges: nonDefault,
    });
    assert.ok(fs.existsSync(output), "legal non-default downstreamJudges must publish");
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")).downstream_judges, nonDefault);
    // Missing downstreamJudges (falls back to the default set) → the
    // manifest's non-default set mismatches → fail closed, no publish.
    fs.rmSync(output, { force: true });
    assert.throws(
      () => S.publishSelectionManifest({ payload, episodes, metaById, exclusions, stats, checkpointDir, output }),
      /provenance validation FAILED before publish/,
      "missing downstreamJudges must fail closed (default fallback mismatch)",
    );
    assert.ok(!fs.existsSync(output), "failed provenance must not publish");
    // Wrong set (same hard candidates, different downstream_judges) → fail
    // closed on the downstream_judges mismatch itself.
    const wrong = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "kimi-coding/k3", "xai/grok-4.7"];
    assert.throws(
      () => S.publishSelectionManifest({ payload, episodes, metaById, exclusions, stats, checkpointDir, output, downstreamJudges: wrong }),
      /provenance validation FAILED before publish/,
      "wrong downstreamJudges must fail closed",
    );
    assert.ok(!fs.existsSync(output), "wrong downstreamJudges must not publish");
    // Default-config manifest still publishes with the default set (default
    // compatibility preserved).
    S.publishSelectionManifest({
      payload: manifest, episodes, metaById, exclusions, stats, checkpointDir, output,
      downstreamJudges: [...F.DEFAULT_DOWNSTREAM_JUDGES],
    });
    assert.ok(fs.existsSync(output), "default downstreamJudges must still publish");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── fail-closed state contract (classification_status) ────────────────────

await check("protocol hash binds the classifier result contract version + the ledger contract id (fixture assertion)", () => {
  const h1 = F.classifierProtocolHash();
  const h2 = F.classifierProtocolHash({ resultContractVersion: 3 });
  assert.notEqual(h1, h2, "result contract version must be bound into the protocol hash");
  const h3 = F.classifierProtocolHash({ resultContractVersion: F.CLASSIFIER_RESULT_CONTRACT_VERSION });
  assert.equal(h1, h3);
  assert.equal(F.CLASSIFIER_RESULT_CONTRACT_VERSION, 2);
  // The ledger contract id (request-id + model-ref + operation +
  // accepted-output binding) is bound into the classifier protocol hash too:
  // a pre-binding checkpoint/manifest carries a different protocol_hash and
  // is therefore stale (never resumed / never admitted).
  assert.equal(C.ATTEMPT_LEDGER_VERSION, 2, "the version is NOT bumped — the contract id marks the binding increment");
  assert.match(C.ATTEMPT_LEDGER_CONTRACT_ID, /request-id.*model-ref.*operation.*accepted-output/i);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

await check("classifyCandidate: one judge success + other transport-exhausted → failed checkpoint keeps partial judgment + ledger; resume THROWS (0-call, bytes unchanged)", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-fail1-"));
  try {
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
    const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
    assert.ok(cand);
    // Judge 0 succeeds; judge 1 transport-exhausts all retries.
    const invoker1 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ throw: "503 upstream" }, { throw: "503 upstream" }, { throw: "503 upstream" }],
    });
    const first = await F.classifyCandidate(invoker1, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium", maxRetries: 2,
    });
    assert.equal(first.classification_status, "failed");
    assert.equal(first.replayable, false);
    assert.ok(first.reasons.includes("judge_call_failed"), first.reasons.join(","));
    assert.equal(first.flags, null);
    assert.equal(first.disagreement, null);
    assert.equal(first.judgments, null);
    // Failed checkpoint saved with full diagnostics: both judge keys, the
    // partial success judgment retained, null for the failed judge, and a
    // ledger with request_ids + cost.
    const cpFile = path.join(tmp, "checkpoints", `${FIX_F1}.json`);
    const cp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    assert.equal(cp.final.classification_status, "failed");
    assert.deepEqual(Object.keys(cp.judgments).sort(), [sol, opus].sort());
    assert.ok(cp.judgments[sol] !== null, "partial success judgment must be retained");
    assert.equal(cp.judgments[opus], null, "failed judge slot must be null");
    assert.ok(Array.isArray(cp.attempt_log[sol]) && cp.attempt_log[sol].length >= 1);
    assert.ok(Array.isArray(cp.attempt_log[opus]) && cp.attempt_log[opus].length >= 1);
    assert.ok(cp.attempt_log[opus].every((e) => typeof e.request_id === "string" && e.request_id));
    assert.ok(cp.attempt_log[opus].every((e) => e.error_class === "transport"));
    // ── v2 lifecycle: a valid FAILED checkpoint is a terminal diagnostic —
    // the next resume THROWS before any invoker call: the two judges are
    // never re-called and the paid facts are never overwritten. ──
    const oldBytes = fs.readFileSync(cpFile, "utf8");
    const invoker2 = makeMockInvoker({}); // would throw if any judge were called
    await assert.rejects(
      () => F.classifyCandidate(invoker2, cand, {
        judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium", maxRetries: 2,
      }),
      /diagnostic checkpoint \(not resumable, not overwritable\)/,
    );
    assert.equal(invoker2.state.calls.length, 0, "failed checkpoint must NOT re-call the judges (0 provider calls)");
    // The on-disk diagnostic checkpoint is byte-identical: request_ids and
    // recorded cost are untouched.
    const cp2Bytes = fs.readFileSync(cpFile, "utf8");
    assert.equal(cp2Bytes, oldBytes, "failed checkpoint must remain byte-identical after the refused resume");
    const cp2 = JSON.parse(cp2Bytes);
    assert.equal(cp2.final.classification_status, "failed");
    assert.ok(cp2.judgments[sol] !== null, "partial success judgment still retained");
    assert.equal(cp2.judgments[opus], null, "failed judge slot still null");
    assert.equal(cp2.attempt_log[opus].length, 3, "failed judge's paid attempts still recorded");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("classifyCandidate: both judges fail → failed; checkpoint not resumable", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-fail2-"));
  try {
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
    const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F7);
    assert.ok(cand);
    const invoker1 = makeMockInvoker({
      [sol]: [{ throw: "timeout" }, { throw: "timeout" }, { throw: "timeout" }],
      [opus]: [{ throw: "timeout" }, { throw: "timeout" }, { throw: "timeout" }],
    });
    const first = await F.classifyCandidate(invoker1, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium", maxRetries: 2,
    });
    assert.equal(first.classification_status, "failed");
    assert.equal(first.replayable, false);
    const cp = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F7}.json`), "utf8"));
    assert.equal(cp.final.classification_status, "failed");
    assert.equal(cp.judgments[sol], null);
    assert.equal(cp.judgments[opus], null);
    assert.ok(cp.attempt_log[sol].length >= 1 && cp.attempt_log[opus].length >= 1);
    // ── v2 lifecycle: a both-judge-failed checkpoint is ALSO a terminal
    // diagnostic — resume throws before any invoker call (0 calls) and the
    // on-disk paid facts stay byte-identical. ──
    const failCpFile = path.join(tmp, "checkpoints", `${FIX_F7}.json`);
    const oldBytes = fs.readFileSync(failCpFile, "utf8");
    const invoker2 = makeMockInvoker({});
    await assert.rejects(
      () => F.classifyCandidate(invoker2, cand, {
        judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium", maxRetries: 2,
      }),
      /diagnostic checkpoint \(not resumable, not overwritable\)/,
    );
    assert.equal(invoker2.state.calls.length, 0, "both-judge-failed checkpoint must not re-call the judges (0 provider calls)");
    assert.equal(fs.readFileSync(failCpFile, "utf8"), oldBytes, "failed checkpoint bytes unchanged after the refused resume");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("selectFairReplayEpisodes: any failed classification → throws (no partial manifest); next resume round fails closed on the failed checkpoint (0-call)", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-mixed-"));
  try {
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    // Hard candidates in selector order: 0001, 0006 (mechanical), 0008,
    // 0007. concurrency=1 keeps the scripted responses deterministic.
    const invoker1 = makeMockInvoker({
      [sol]: [
        { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }, // 0001
        { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.01 }, // 0008
        { toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.01 }, // 0007
      ],
      [opus]: [
        { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.02 }, // 0001
        { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 }, // 0008
        { throw: "503" }, { throw: "503" }, { throw: "503" },        // 0007 fails
      ],
    });
    await assert.rejects(
      () => F.selectFairReplayEpisodes(FIXTURE_EPISODES, metaById, {
        classify: true, invoker: invoker1, judgeModels: [sol, opus], concurrency: 1,
        quiet: true, resume: false, outputDir: tmp,
      }),
      new RegExp(FIX_F7),
    );
    // No partial manifest is returned; checkpoints are saved: 0001/0008
    // completed, 0007 failed (diagnostic).
    const cp1 = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F1}.json`), "utf8"));
    assert.equal(cp1.final.classification_status, "completed");
    const cp7 = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F7}.json`), "utf8"));
    assert.equal(cp7.final.classification_status, "failed");
    const cp8 = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F8}.json`), "utf8"));
    assert.equal(cp8.final.classification_status, "completed");
    // ── v2 lifecycle: next round with resume — 0001/0008 resume from their
    // completed checkpoints (0 calls), but 0007's FAILED diagnostic
    // checkpoint throws before any invoker call: the whole selection fails
    // closed, the judges are never re-called and the paid facts are never
    // overwritten. ──
    const cp7Bytes = fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F7}.json`), "utf8");
    const invoker2 = makeMockInvoker({});
    await assert.rejects(
      () => F.selectFairReplayEpisodes(FIXTURE_EPISODES, metaById, {
        classify: true, invoker: invoker2, judgeModels: [sol, opus], concurrency: 1,
        quiet: true, resume: true, outputDir: tmp,
      }),
      /diagnostic checkpoint \(not resumable, not overwritable\)/,
    );
    assert.equal(invoker2.state.calls.length, 0, "failed checkpoint must not re-call the judges (0 provider calls)");
    const cp7b = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F7}.json`), "utf8"));
    assert.equal(cp7b.final.classification_status, "failed", "failed diagnostic checkpoint stays failed");
    assert.equal(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F7}.json`), "utf8"), cp7Bytes, "failed checkpoint bytes unchanged");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("validateCheckpointBody: real partial-failed checkpoint passes; forged failed with two non-null judgments rejected; provenance rejects any failed cp", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-body-"));
  try {
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
    const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
    assert.ok(cand);
    const invoker = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ throw: "503" }, { throw: "503" }, { throw: "503" }],
    });
    const failed = await F.classifyCandidate(invoker, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium", maxRetries: 2,
    });
    assert.equal(failed.classification_status, "failed");
    const cp = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F1}.json`), "utf8"));
    // The real failed checkpoint is structurally explainable: no errors.
    const bodyErrors = F.validateCheckpointBody(cp, cp.final, {
      id: FIX_F1, judgeModels: [sol, opus], prompt: GOOD_PROMPT,
    });
    assert.deepEqual(bodyErrors, [], bodyErrors.join("; "));
    // Forged failed: flip a completed checkpoint's status to failed while
    // both judgments are non-null → rejected.
    // A FRESH subdir is required for the completed classification: the
    // failed checkpoint above is a terminal diagnostic — resume in the same
    // dir would throw (and overwriting is never allowed).
    const completedDir = path.join(tmp, "completed");
    const invoker2 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 }],
    });
    const completed = await F.classifyCandidate(invoker2, cand, {
      judgeModels: [sol, opus], outputDir: completedDir, resume: true, thinking: "medium", maxRetries: 2,
    });
    assert.equal(completed.classification_status, "completed");
    const cp2 = JSON.parse(fs.readFileSync(path.join(completedDir, "checkpoints", `${FIX_F1}.json`), "utf8"));
    const forged = JSON.parse(JSON.stringify(cp2));
    forged.final.classification_status = "failed";
    const forgedErrors = F.validateCheckpointBody(forged, forged.final, {
      id: FIX_F1, judgeModels: [sol, opus], prompt: GOOD_PROMPT,
    });
    assert.ok(forgedErrors.some((e) => e.includes("at least one null judgment")), forgedErrors.join("; "));
    // Provenance rejects any failed checkpoint (never enters finals rebuild).
    const { manifest, checkpointDir, metaById: mb, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const cpFile = path.join(checkpointDir, `${FIX_F1}.json`);
    const cp3 = JSON.parse(fs.readFileSync(cpFile, "utf8"));
    cp3.final.classification_status = "failed";
    cp3.judgments[opus] = null; // structurally-consistent failed cp
    fs.writeFileSync(cpFile, `${JSON.stringify(cp3, null, 2)}\n`);
    const r = F.validateFairManifestProvenance({ manifest, episodes, metaById: mb, checkpointDir, exclusions, stats });
    assert.equal(r.ok, false, "provenance must reject a failed checkpoint");
    assert.ok(r.errors.some((e) => e.includes("classification_status must be completed")), r.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("classifier relabel / all-failed completed / save self-validation: a completed checkpoint requires two REAL accepted successes bound to the stored judgments", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-relabel-"));
  try {
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
    const cand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
    assert.ok(cand);
    const invoker = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 }],
    });
    const completed = await F.classifyCandidate(invoker, cand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium", maxRetries: 2,
    });
    assert.equal(completed.classification_status, "completed");
    const cp = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F1}.json`), "utf8"));
    // 1. Relabel: flip the final's replayable without touching the stored
    // judgments → the body contract recomputes the merge and rejects.
    const relabel = JSON.parse(JSON.stringify(cp));
    relabel.final.replayable = !relabel.final.replayable;
    const rRelabel = F.validateCheckpointBody(relabel, relabel.final, {
      id: FIX_F1, judgeModels: [sol, opus], prompt: GOOD_PROMPT,
    });
    assert.ok(rRelabel.some((e) => e.includes("replayable")), rRelabel.join("; "));
    // 2. Relabel the JUDGMENT itself (content changed, hash kept) → the
    // accepted-output hash no longer equals sha256(JSON.stringify(judgment)).
    const jRelabel = JSON.parse(JSON.stringify(cp));
    jRelabel.judgments[sol].replayable = !jRelabel.judgments[sol].replayable;
    const rJRelabel = F.validateCheckpointBody(jRelabel, jRelabel.final, {
      id: FIX_F1, judgeModels: [sol, opus], prompt: GOOD_PROMPT,
    });
    assert.ok(rJRelabel.some((e) => e.includes("accepted output hash")), rJRelabel.join("; "));
    // 3. All-failed completed: keep classification_status=completed but flip
    // both judge ledgers to real failures (no success entry) → rejected.
    const allFailed = JSON.parse(JSON.stringify(cp));
    for (const model of [sol, opus]) {
      allFailed.attempt_log[model][0].ok = false;
      allFailed.attempt_log[model][0].error = "boom";
      allFailed.attempt_log[model][0].error_class = "content";
      allFailed.attempt_log[model][0].accepted_output_hash = null;
    }
    const rAllFailed = F.validateCheckpointBody(allFailed, allFailed.final, {
      id: FIX_F1, judgeModels: [sol, opus], prompt: GOOD_PROMPT,
    });
    assert.ok(rAllFailed.some((e) => e.includes("no success entry")), rAllFailed.join("; "));
    // 4. Save self-validation: the producer refuses to write a body whose
    // accepted hash does not bind the stored judgment (never a
    // write-then-reload approximation).
    const badSave = JSON.parse(JSON.stringify(cp));
    badSave.attempt_log[sol][0].accepted_output_hash = "0".repeat(64);
    assert.throws(
      () => F.saveClassifierCheckpoint(tmp, FIX_F1, badSave, { prompt: GOOD_PROMPT }),
      /refusing to write a checkpoint that fails the classifier body contract/,
      "saveClassifierCheckpoint must self-validate the accepted-output binding before writing",
    );
    // The on-disk checkpoint is untouched by the refused save.
    const after = JSON.parse(fs.readFileSync(path.join(tmp, "checkpoints", `${FIX_F1}.json`), "utf8"));
    assert.equal(after.attempt_log[sol][0].accepted_output_hash, cp.attempt_log[sol][0].accepted_output_hash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("classification_status=completed for mechanical, dual-judge success, and semantic non-replayable; resume stays 0-call", async () => {
  const sol = "openai/gpt-5.6-sol";
  const opus = "anthropic/claude-opus-5";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-completed-"));
  try {
    const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
    const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
    // mechanical (0006)
    const mechCand = hard.candidates.find((c) => c.episode.episode_id === FIX_F6);
    const mech = await F.classifyCandidate({}, mechCand, { resume: false, outputDir: tmp });
    assert.equal(mech.classification_status, "completed");
    assert.equal(mech.stage, "mechanical");
    // dual-judge success (0001)
    const okCand = hard.candidates.find((c) => c.episode.episode_id === FIX_F1);
    const invoker1 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 }],
    });
    const ok = await F.classifyCandidate(invoker1, okCand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
    });
    assert.equal(ok.classification_status, "completed");
    assert.equal(ok.replayable, true);
    // semantic non-replayable (both judges agree non-replayable) → completed
    const noCand = hard.candidates.find((c) => c.episode.episode_id === FIX_F8);
    const invoker2 = makeMockInvoker({
      [sol]: [{ toolArgs: goodJudgment({ replayable: false, requires_workspace: true, reasons: ["needs workspace"], confidence: 0.6 }), cost: 0.01 }],
      [opus]: [{ toolArgs: goodJudgment({ replayable: false, requires_workspace: true, reasons: ["needs workspace"], confidence: 0.6 }), cost: 0.02 }],
    });
    const no = await F.classifyCandidate(invoker2, noCand, {
      judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium",
    });
    assert.equal(no.classification_status, "completed");
    assert.equal(no.replayable, false);
    assert.ok(no.reasons.some((r) => r.includes("either_judge_non_replayable") || r.includes("not_replayable")), no.reasons.join(","));
    // Resume: all three completed checkpoints resume with 0 calls.
    const invoker3 = makeMockInvoker({});
    const r1 = await F.classifyCandidate(invoker3, mechCand, { outputDir: tmp, resume: true });
    assert.equal(r1.from_checkpoint, true);
    const r2 = await F.classifyCandidate(invoker3, okCand, { judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium" });
    assert.equal(r2.from_checkpoint, true);
    const r3 = await F.classifyCandidate(invoker3, noCand, { judgeModels: [sol, opus], outputDir: tmp, resume: true, thinking: "medium" });
    assert.equal(r3.from_checkpoint, true);
    assert.equal(invoker3.state.calls.length, 0, "completed checkpoints resume with 0 calls");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("loadMeta strict: malformed JSON / non-object / missing id / duplicate id throw path+1-based line; permissive default preserved", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-meta-strict-"));
  const p = path.join(tmp, "episodes.meta.jsonl");
  const good = { episode_id: "ep-a", slots: [] };
  const good2 = { episode_id: "ep-b", slots: [] };
  try {
    // Permissive default keeps skipping malformed lines / records without a
    // usable episode_id (exact legacy behavior), while valid rows load.
    fs.writeFileSync(p, `${JSON.stringify(good)}\nnot json\n${JSON.stringify(7)}\n${JSON.stringify({ slots: [] })}\n${JSON.stringify(good2)}\n`);
    assert.deepEqual(F.loadMeta(p).map((m) => m.episode_id), ["ep-a", "ep-b"]);
    // strict: malformed JSON line → throw with path + 1-based line number.
    fs.writeFileSync(p, `${JSON.stringify(good)}\nnot json\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /episodes\.meta\.jsonl .*:2: invalid JSON/);
    // strict: primitive / non-object record → throw with line number.
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify(7)}\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /:2: record is not a JSON object/);
    // strict: object missing episode_id → throw with line number.
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify({ slots: [] })}\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /:2: missing or invalid episode_id/);
    // strict: whitespace-only / leading-trailing whitespace episode_id →
    // throw (blank and padded ids are a different identity than "ep-a").
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify({ episode_id: "  " })}\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /:2: missing or invalid episode_id/);
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify({ episode_id: " ep-a" })}\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /:2: episode_id must have no leading\/trailing whitespace/);
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify({ episode_id: "ep-a " })}\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /:2: episode_id must have no leading\/trailing whitespace/);
    // Permissive default: whitespace-padded ids still load (legacy behavior).
    fs.writeFileSync(p, `${JSON.stringify({ episode_id: " ep-a " })}\n`);
    assert.deepEqual(F.loadMeta(p).map((m) => m.episode_id), [" ep-a "]);
    // strict: duplicate episode_id → throw naming the id.
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify({ ...good })}\n`);
    assert.throws(() => F.loadMeta(p, { strict: true }), /duplicate episode_id ep-a/);
    // strict: valid corpus passes.
    fs.writeFileSync(p, `${JSON.stringify(good)}\n${JSON.stringify(good2)}\n`);
    assert.deepEqual(F.loadMeta(p, { strict: true }).map((m) => m.episode_id), ["ep-a", "ep-b"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── offline real-spawn CLI tests (t0-replay-select, explicit temp paths) ──
// These spawn the REAL selector CLI with explicit temp episodes/meta/output/
// checkpoint/models paths ONLY — the production default paths are never read
// and no provider is ever contacted (PI_OFFLINE=1; classify-mode scenarios
// either fail pre-request with a minimal empty registry or are
// all-mechanical).

function writeCliFixture(dir, episodes, metaRecords) {
  const episodesPath = path.join(dir, "episodes.jsonl");
  const metaPath = path.join(dir, "episodes.meta.jsonl");
  const exclusionsPath = path.join(dir, "exclusions.jsonl");
  const statsPath = path.join(dir, "stats.json");
  fs.writeFileSync(episodesPath, episodes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(metaPath, metaRecords.map((m) => JSON.stringify(m)).join("\n") + "\n");
  // The four-file dataset is one atomic producer unit: the selector CLI
  // asserts the FULL inventory (episodes + meta + exclusions + stats) before
  // any invoker work, so the fixture must carry a consistent exclusions +
  // stats (no episode-level terminal exclusions — the fixture corpus has no
  // orphans).
  fs.writeFileSync(exclusionsPath, "");
  fs.writeFileSync(statsPath, `${JSON.stringify(producerStats(episodes, metaRecords, []), null, 2)}\n`);
  return { episodesPath, metaPath, exclusionsPath, statsPath };
}

function writeMinimalModelsJson(dir) {
  const p = path.join(dir, "models.json");
  fs.writeFileSync(p, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  return p;
}

function noTmpFiles(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).every((n) => !n.includes(".tmp-"));
}

function spawnSelect(args) {
  const script = path.join(root, "scripts", "t0-replay-select.mjs");
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PI_OFFLINE: "1" },
  });
}

await check("preflightOutputIntent: single output / hard-only / no output / ambiguous (duplicate or missing value) all classified correctly", () => {
  assert.deepEqual(S.preflightOutputIntent(["--output", "/tmp/out.json", "--hard-only"]), { hardOnly: true, output: "/tmp/out.json" });
  assert.deepEqual(S.preflightOutputIntent(["--output", "/tmp/out.json"]), { hardOnly: false, output: "/tmp/out.json" });
  assert.deepEqual(S.preflightOutputIntent(["--hard-only"]), { hardOnly: true, output: null });
  assert.deepEqual(S.preflightOutputIntent([]), { hardOnly: false, output: null });
  assert.equal(S.preflightOutputIntent(["--output", "/tmp/a.json", "--output", "/tmp/b.json"]), null, "different outputs → ambiguous");
  assert.deepEqual(S.preflightOutputIntent(["--output", "/tmp/a.json", "--output", "/tmp/a.json"]), { hardOnly: false, output: "/tmp/a.json" }, "identical duplicate value is still uniquely determinable");
  assert.equal(S.preflightOutputIntent(["--output", "--hard-only"]), null, "flag without a value → ambiguous");
  // parseCli semantics: `--hard-only <value>` consumes the next token as its
  // VALUE — NOT a bare hard-only flag (classify intent; parseArgs rejects the
  // value form explicitly after preflight revokes the unique output).
  assert.deepEqual(S.preflightOutputIntent(["--output", "/tmp/out.json", "--hard-only", "x"]), { hardOnly: false, output: "/tmp/out.json" }, "--hard-only <value> is classify intent (value consumed)");
  assert.deepEqual(S.preflightOutputIntent(["--hard-only", "x"]), { hardOnly: false, output: null }, "--hard-only <value> alone is not hard-only");
  assert.deepEqual(S.preflightOutputIntent(["--hard-only", "x", "--hard-only"]), { hardOnly: true, output: null }, "a later bare --hard-only flag still counts");
  // malformed equals form: `--output=<nonempty path>` is uniquely determinable
  // and revoked even though parseStrictCli rejects `--flag=value`.
  assert.deepEqual(S.preflightOutputIntent(["--output=/tmp/eq.json"]), { hardOnly: false, output: "/tmp/eq.json" }, "equals-form single output is uniquely determinable");
  assert.deepEqual(S.preflightOutputIntent(["--output=/tmp/eq.json", "--output", "/tmp/eq.json"]), { hardOnly: false, output: "/tmp/eq.json" }, "equals + space identical value is still uniquely determinable");
  assert.equal(S.preflightOutputIntent(["--output=/tmp/eq.json", "--output", "/tmp/other.json"]), null, "equals + space different outputs → ambiguous");
  assert.equal(S.preflightOutputIntent(["--output="]), null, "empty `--output=` → ambiguous");
  assert.equal(S.preflightOutputIntent(["--output=", "--output", "/tmp/x.json"]), null, "empty `--output=` mixed with a value → ambiguous");
  // `--hard-only=true` is a value form → classify intent (its unique output is
  // revoked); only a BARE `--hard-only` stays hard-only and pre-deletes nothing.
  assert.deepEqual(S.preflightOutputIntent(["--output=/tmp/eq.json", "--hard-only=true"]), { hardOnly: false, output: "/tmp/eq.json" }, "--hard-only=true is classify intent, output revoked");
  assert.deepEqual(S.preflightOutputIntent(["--hard-only=true"]), { hardOnly: false, output: null }, "--hard-only=true alone is not hard-only");
  assert.deepEqual(S.preflightOutputIntent(["--output=/tmp/eq.json", "--hard-only"]), { hardOnly: true, output: "/tmp/eq.json" }, "bare --hard-only stays hard-only (no predelete) but still reports the output");
});

await check("select parseArgs strict raw parser: legal space argv (incl. repeat --episode); rejects = / unknown / positional / duplicate / missing / bool-value / bad numeric / empty; classify without a checkpoint target fails", () => {
  // Legal space-form argv with repeatable --episode accumulates and reaches
  // the options object; --output derives the checkpoint dir.
  const ok = S.parseArgs([
    "--episodes", "/tmp/e.jsonl",
    "--meta", "/tmp/m.jsonl",
    "--exclusions", "/tmp/x.jsonl",
    "--stats", "/tmp/s.json",
    "--output", "/tmp/out/selection.json",
    "--episode", "ep-aaaaaaaaaaaaaaaa",
    "--episode", "ep-bbbbbbbbbbbbbbbb",
    "--limit", "0",
    "--concurrency", "2",
    "--max-retries", "0",
    "--timeout-ms", "1",
    "--thinking", "high",
    "--classifier-models", "openai/gpt-5.6-sol,anthropic/claude-opus-5",
    "--downstream-judges", "openai/gpt-5.6-sol,anthropic/claude-opus-5,kimi-coding/k3",
    "--models-json", "/tmp/models.json",
    "--checkpoint-dir", "/tmp/cp",
    "--quiet",
    "--no-resume",
    "--json",
  ]);
  assert.equal(ok.episodesPath, path.resolve("/tmp/e.jsonl"));
  assert.equal(ok.metaPath, path.resolve("/tmp/m.jsonl"));
  assert.equal(ok.exclusionsPath, path.resolve("/tmp/x.jsonl"));
  assert.equal(ok.statsPath, path.resolve("/tmp/s.json"));
  assert.equal(ok.output, path.resolve("/tmp/out/selection.json"));
  assert.deepEqual(ok.episodeIds, ["ep-aaaaaaaaaaaaaaaa", "ep-bbbbbbbbbbbbbbbb"]);
  assert.equal(ok.limit, 0);
  assert.equal(ok.concurrency, 2);
  assert.equal(ok.maxRetries, 0);
  assert.equal(ok.timeoutMs, 1);
  assert.equal(ok.thinking, "high");
  assert.equal(ok.checkpointDir, path.resolve("/tmp/cp"));
  assert.equal(ok.quiet, true);
  assert.equal(ok.resume, false);
  assert.equal(ok.json, true);
  // --output alone derives the checkpoint dir (paid persistence target).
  const derived = S.parseArgs(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json"]);
  assert.equal(derived.checkpointDir, path.resolve("/tmp/out/checkpoints-fair"));
  // hard-only needs no checkpoint target.
  const hardOnly = S.parseArgs(["--hard-only", "--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl"]);
  assert.equal(hardOnly.hardOnly, true);
  assert.equal(hardOnly.checkpointDir, null);

  const reject = (argv, re) => {
    assert.throws(() => S.parseArgs(argv), re);
  };
  // --flag=value forms (known value + boolean).
  reject(["--output=/tmp/out"], /--flag=value|not supported/);
  reject(["--episodes=/tmp/e.jsonl"], /--flag=value|not supported/);
  reject(["--quiet=true"], /--flag=value|not supported/);
  // unknown / positional
  reject(["--bogus"], /unknown option/);
  reject(["/tmp/e.jsonl"], /positional/);
  reject(["--episodes", "/tmp/e.jsonl", "stray"], /positional/);
  // non-repeatable duplicate + boolean duplicate
  reject(["--output", "/tmp/a", "--output", "/tmp/b"], /duplicate/);
  reject(["--quiet", "--quiet"], /duplicate/);
  // missing value / next token is a flag
  reject(["--output"], /requires a value/);
  reject(["--output", "--quiet"], /requires a value/);
  // boolean with value
  reject(["--quiet", "yes"], /must not take a value/);
  reject(["--hard-only", "1"], /must not take a value/);
  // invalid numeric (supplied raw)
  reject(["--limit", "-1"], /non-negative integer/);
  reject(["--limit", "1.5"], /non-negative integer/);
  reject(["--limit", "abc"], /non-negative integer/);
  reject(["--max-retries", "01"], /non-negative integer/);
  reject(["--concurrency", "0"], /positive integer/);
  reject(["--concurrency", "-2"], /positive integer/);
  reject(["--timeout-ms", "0"], /positive integer/);
  // empty value
  reject(["--episodes", ""], /non-empty value/);
  reject(["--output", ""], /non-empty value/);
  reject(["--episode", ""], /non-empty value/);
  reject(["--classifier-models", ""], /non-empty value/);
  // semantic-empty CSV values fail closed (OpenAI repro): pure whitespace,
  // bare commas, and mixed empty segments must throw — never silently drop
  // segments (which could widen the selection or fall back to defaults via
  // parseModelList's null). `--episode , --output ...` must throw before
  // parse, never become a full run.
  reject(["--episode", " "], /non-empty value/);
  reject(["--episode", ","], /comma-separated value/);
  reject(["--episode", ",,"], /comma-separated value/);
  reject(["--episode", "ep-a,,ep-b"], /comma-separated value/);
  reject(["--episode", "ep-a", "--episode", ",ep-b"], /comma-separated value/);
  reject(["--episode", ",", "--output", "/tmp/out.json"], /comma-separated value/);
  reject(["--classifier-models", " "], /non-empty value/);
  reject(["--classifier-models", ","], /comma-separated value/);
  reject(["--classifier-models", ",,"], /comma-separated value/);
  reject(["--classifier-models", "openai/gpt-5.6-sol,,anthropic/claude-opus-5"], /comma-separated value/);
  reject(["--downstream-judges", " "], /non-empty value/);
  reject(["--downstream-judges", ","], /comma-separated value/);
  reject(["--downstream-judges", ",,"], /comma-separated value/);
  reject(["--downstream-judges", "openai/gpt-5.6-sol,,kimi-coding/k3"], /comma-separated value/);
  // Legal CSV with surrounding spaces still parses (segments trimmed).
  const csvOk = S.parseArgs(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", "--episode", "ep-a, ep-b", "--classifier-models", "openai/gpt-5.6-sol, anthropic/claude-opus-5", "--downstream-judges", "openai/gpt-5.6-sol, anthropic/claude-opus-5, kimi-coding/k3"]);
  assert.deepEqual(csvOk.episodeIds, ["ep-a", "ep-b"]);
  assert.deepEqual(csvOk.classifierModels, ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"]);
  assert.deepEqual(csvOk.downstreamJudges, ["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "kimi-coding/k3"]);
  // classify mode without a durable checkpoint target (no --checkpoint-dir,
  // no --output) fails BEFORE any load / invoker / provider work.
  reject(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl"], /durable checkpoint target/);
  reject(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--checkpoint-dir", ""], /non-empty value/);
});

await check("select parseArgs downstream-judges regression: a custom set missing a DEFAULT judge is rejected; default superset (default+extra) parses", () => {
  const base = ["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json"];
  const defaults = F.DEFAULT_DOWNSTREAM_JUDGES;
  assert.ok(defaults.length === 3 && defaults.includes("kimi-coding/k3"), "defaults are the three fixed replay judges");
  // Missing any one default judge → parse rejected (would silently weaken
  // the self-candidate exclusion) BEFORE any return / I/O / invoker work.
  for (const dropped of defaults) {
    const custom = defaults.filter((m) => m !== dropped).join(",");
    assert.throws(
      () => S.parseArgs([...base, "--downstream-judges", custom]),
      /must include every default downstream judge/,
      `dropping ${dropped} must be rejected`,
    );
  }
  // Default + extra (a strict superset) parses and normalizes to the union.
  const extra = "xai/grok-4.6";
  const superset = S.parseArgs([...base, "--downstream-judges", [...defaults, extra].join(",")]);
  assert.deepEqual(superset.downstreamJudges, [...defaults, extra]);
  // The bare default set parses unchanged.
  const plain = S.parseArgs([...base, "--downstream-judges", defaults.join(",")]);
  assert.deepEqual(plain.downstreamJudges, defaults);
  // --downstream-judges is NOT a repeatable flag: a second occurrence is a
  // strict duplicate-option rejection (only --episode accumulates).
  assert.throws(
    () => S.parseArgs([...base, "--downstream-judges", defaults[0], "--downstream-judges", defaults.slice(1).join(",")]),
    /duplicate option --downstream-judges/,
  );
});

await check("select parseArgs raw numeric safe-integer gate: 400-digit / >MAX_SAFE_INTEGER values throw BEFORE any default/I/O; MAX_SAFE_INTEGER boundary parses", () => {
  const huge = "9".repeat(400); // Number() coerces to Infinity
  const overflow = "9007199254740992"; // 2^53, finite but rounds to a non-safe integer
  const maxSafe = String(Number.MAX_SAFE_INTEGER);
  const reject = (argv, re) => {
    assert.throws(() => S.parseArgs(argv), re);
  };
  // Non-negative flags: huge / overflow throw; MAX_SAFE_INTEGER parses.
  for (const flag of ["limit", "max-retries"]) {
    reject(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", `--${flag}`, huge], /non-negative integer/);
    reject(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", `--${flag}`, overflow], /non-negative integer/);
    assert.equal(S.parseArgs(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", `--${flag}`, maxSafe])[flag === "limit" ? "limit" : "maxRetries"], Number.MAX_SAFE_INTEGER, `--${flag} MAX_SAFE_INTEGER parses`);
  }
  // Positive flags: huge / overflow throw; MAX_SAFE_INTEGER parses.
  for (const flag of ["concurrency", "timeout-ms"]) {
    reject(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", `--${flag}`, huge], /positive integer/);
    reject(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", `--${flag}`, overflow], /positive integer/);
    assert.equal(S.parseArgs(["--episodes", "/tmp/e.jsonl", "--meta", "/tmp/m.jsonl", "--output", "/tmp/out/selection.json", `--${flag}`, maxSafe])[flag === "timeout-ms" ? "timeoutMs" : "concurrency"], Number.MAX_SAFE_INTEGER, `--${flag} MAX_SAFE_INTEGER parses`);
  }
});

await check("preflightClassifierCheckpoints: pure read-only full-batch preflight — A missing + B malformed/failed throws (zero invoker concept); valid completed allowed; --no-resume with any existing throws", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-preflight-"));
  try {
    const episodes = [makeEpisode("ep-cli-0001"), makeEpisode("ep-cli-0002")];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const metaById = new Map(meta.map((m) => [m.episode_id, m]));
    const outputDir = path.join(tmp, "checkpoints-fair");
    const cpDir = path.join(outputDir, "checkpoints");
    const cpFile = (id) => path.join(cpDir, `${id}.json`);
    const preflight = (opts = {}) => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, ...opts });
    const ids = (r) => r.candidates.map((c) => c.episode.episode_id);
    // No checkpoints at all → legal (all cache misses), zero resumable.
    assert.deepEqual(ids(preflight()), [FIX_CLI1, FIX_CLI2]);
    assert.equal(preflight().resumable, 0);
    // A missing + B malformed → throws (B's bad checkpoint is discovered
    // before any invoker/provider concept exists — the pure function takes
    // no invoker at all).
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(cpFile(FIX_CLI2), "{not json");
    assert.throws(() => preflight(), /malformed/);
    // A missing + B a valid completed checkpoint → allowed, resumable=1.
    // (The malformed file is removed first — atomic create-if-absent never
    // overwrites an existing checkpoint.)
    fs.rmSync(cpFile(FIX_CLI2), { force: true });
    const { payload } = completedCheckpointFixture({ episodeId: FIX_CLI2, requestPrefix: "req-pf" });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI2, payload, { prompt: GOOD_PROMPT });
    const ok = preflight();
    assert.equal(ok.resumable, 1);
    assert.deepEqual(ids(ok), [FIX_CLI1, FIX_CLI2]);
    // A missing + B a failed diagnostic checkpoint → throws (never resumable).
    // (Flipping the status on a completed body is caught by the body
    // contract — two non-null judgments cannot be failed — either way the
    // existing checkpoint fails closed.)
    const failed = JSON.parse(fs.readFileSync(cpFile(FIX_CLI2), "utf8"));
    failed.final.classification_status = "failed";
    fs.writeFileSync(cpFile(FIX_CLI2), `${JSON.stringify(failed, null, 2)}\n`);
    assert.throws(() => preflight(), /body invalid|diagnostic checkpoint/);
    // --no-resume with ANY existing checkpoint → throws (paid facts never wiped).
    assert.throws(() => preflight({ resume: false }), /--no-resume refuses to overwrite/);
    // --no-resume with a fresh dir → legal.
    const fresh = path.join(tmp, "fresh");
    assert.deepEqual(ids(F.preflightClassifierCheckpoints(episodes, metaById, { outputDir: fresh, resume: false })), [FIX_CLI1, FIX_CLI2]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("preflightClassifierCheckpoints regression: cross-cp duplicate request_id throws before invoker; distinct+missing passes; full-run extra/symlink inventory fails closed, filtered run tolerates them", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-preflight2-"));
  try {
    const episodes = [makeEpisode("ep-cli-0001"), makeEpisode("ep-cli-0002"), makeEpisode("ep-cli-0007")];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const metaById = new Map(meta.map((m) => [m.episode_id, m]));
    const outputDir = path.join(tmp, "checkpoints-fair");
    const cpDir = path.join(outputDir, "checkpoints");
    const cpFile = (id) => path.join(cpDir, `${id}.json`);
    const preflight = (opts = {}) => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, ...opts });
    const ids = (r) => r.candidates.map((c) => c.episode.episode_id);
    fs.mkdirSync(cpDir, { recursive: true });
    // Two valid completed checkpoints REUSING the same request_ids + a third
    // target missing → the shared global Set catches the cross-cp duplicate
    // BEFORE any invoker/provider concept (the pure preflight takes none).
    const p1 = completedCheckpointFixture({ episodeId: FIX_CLI1, requestPrefix: "req-shared" });
    const p2 = completedCheckpointFixture({ episodeId: FIX_CLI2, requestPrefix: "req-shared" });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI1, p1.payload, { prompt: GOOD_PROMPT });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI2, p2.payload, { prompt: GOOD_PROMPT });
    assert.throws(() => preflight(), /body invalid/, "cross-cp duplicate request_id must fail closed");
    // Distinct request_ids + one target missing → legal (a subset of the
    // expected names is allowed — missing candidates are cache misses),
    // resumable=2, all three candidates scanned.
    fs.rmSync(cpFile(FIX_CLI1), { force: true });
    fs.rmSync(cpFile(FIX_CLI2), { force: true });
    const a1 = completedCheckpointFixture({ episodeId: FIX_CLI1, requestPrefix: "req-a" });
    const a2 = completedCheckpointFixture({ episodeId: FIX_CLI2, requestPrefix: "req-b" });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI1, a1.payload, { prompt: GOOD_PROMPT });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI2, a2.payload, { prompt: GOOD_PROMPT });
    const ok = preflight();
    assert.equal(ok.resumable, 2);
    assert.deepEqual(ids(ok), [FIX_CLI1, FIX_CLI2, FIX_CLI7]);
    // Full unfiltered run + an EXTRA direct .json (not a hard candidate) →
    // the leaf inventory check fails closed before any checkpoint read.
    fs.writeFileSync(cpFile("ep-extra000000000000"), "{}");
    assert.throws(() => preflight(), /extra checkpoint entries fail closed/);
    fs.rmSync(cpFile("ep-extra000000000000"), { force: true });
    // Full unfiltered run + a symlink .json → non-regular fails closed.
    fs.rmSync(cpFile(FIX_CLI2), { force: true });
    fs.symlinkSync(cpFile(FIX_CLI1), cpFile(FIX_CLI2));
    assert.throws(() => preflight(), /not a regular file/);
    // Filtered run (target recovery) tolerates the SAME extra + symlink:
    // no inventory subset restriction; the existing TARGET checkpoint still
    // validates (CLI1 is a valid completed checkpoint).
    fs.writeFileSync(cpFile("ep-extra000000000000"), "{}");
    const filtered = F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI1] });
    assert.equal(filtered.resumable, 1);
    assert.deepEqual(ids(filtered), [FIX_CLI1]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("checkpoint lifecycle regression: lstat existence semantics — broken symlink / symlink / directory at a target is an EXISTING entry: resume refuses before read (never a cache miss), filtered preflight throws with another target missing, --no-resume throws for ANY entry incl. broken symlink, and classifyCandidate's runtime guard refuses with 0 calls", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-lstat-"));
  try {
    const episodes = [makeEpisode("ep-cli-0001"), makeEpisode("ep-cli-0002")];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const metaById = new Map(meta.map((m) => [m.episode_id, m]));
    const outputDir = path.join(tmp, "checkpoints-fair");
    const cpDir = path.join(outputDir, "checkpoints");
    const cpFile = (id) => path.join(cpDir, `${id}.json`);
    fs.mkdirSync(cpDir, { recursive: true });
    const loadArgs = {
      prompt_hash: F.promptHash(GOOD_PROMPT),
      protocol_hash: F.classifierProtocolHash(),
      judge_models: [...F.CLASSIFIER_DEFAULT_JUDGES],
      thinking: F.CLASSIFIER_DEFAULT_THINKING,
      prompt: GOOD_PROMPT,
    };
    const hardCand = F.selectHardCandidates(episodes, metaById).candidates.find((c) => c.episode.episode_id === FIX_CLI1);
    assert.ok(hardCand);
    // 1. A BROKEN symlink at a target is an EXISTING entry: resume must
    //    refuse (never a cache miss — a fresh call would duplicate paid
    //    facts); the filtered preflight throws while the other target is
    //    missing; --no-resume refuses too.
    fs.symlinkSync(path.join(cpDir, "no-such-target.json"), cpFile(FIX_CLI1));
    assert.throws(() => F.loadClassifierCheckpoint(outputDir, FIX_CLI1, loadArgs), /symlink/);
    assert.throws(
      () => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI1] }),
      /symlink/,
      "filtered resume with a broken-symlink target (and the other target missing) must throw, not cache-miss",
    );
    assert.throws(
      () => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI1], resume: false }),
      /--no-resume refuses to overwrite/,
      "--no-resume with a broken symlink must refuse (lstat existence semantics)",
    );
    // 2. A VALID symlink (pointing at a real regular checkpoint elsewhere)
    //    is also refused — links are never followed.
    fs.rmSync(cpFile(FIX_CLI1), { force: true });
    const a1 = completedCheckpointFixture({ episodeId: FIX_CLI1, requestPrefix: "req-ls1" });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI1, a1.payload, { prompt: GOOD_PROMPT });
    fs.symlinkSync(cpFile(FIX_CLI1), cpFile(FIX_CLI2));
    assert.throws(
      () => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI2] }),
      /symlink/,
      "filtered resume with a symlink target must refuse (never follow the link)",
    );
    assert.throws(
      () => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI2], resume: false }),
      /--no-resume refuses to overwrite/,
      "--no-resume with a valid symlink must refuse",
    );
    // 3. A DIRECTORY at a target is an existing non-regular entry → refuse.
    fs.rmSync(cpFile(FIX_CLI2), { force: true });
    fs.rmSync(cpFile(FIX_CLI1), { force: true });
    fs.mkdirSync(cpFile(FIX_CLI1));
    assert.throws(() => F.loadClassifierCheckpoint(outputDir, FIX_CLI1, loadArgs), /not a regular file/);
    assert.throws(
      () => F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI1], resume: false }),
      /--no-resume refuses to overwrite/,
      "--no-resume with a directory at the target must refuse",
    );
    // 4. The runtime per-candidate guard: classifyCandidate --no-resume with
    //    a broken symlink refuses BEFORE any invoker call (0 provider calls).
    fs.rmdirSync(cpFile(FIX_CLI1));
    fs.symlinkSync(path.join(cpDir, "no-such-target.json"), cpFile(FIX_CLI1));
    const invoker = makeMockInvoker({});
    await assert.rejects(
      () => F.classifyCandidate(invoker, hardCand, {
        judgeModels: [...F.CLASSIFIER_DEFAULT_JUDGES], outputDir, resume: false, thinking: F.CLASSIFIER_DEFAULT_THINKING,
      }),
      /--no-resume refuses to overwrite/,
      "classifyCandidate --no-resume with a broken symlink must refuse before any provider call",
    );
    assert.equal(invoker.state.calls.length, 0, "no-resume + broken symlink: 0 provider calls");
    // 5. Sanity: ENOENT stays the only legal cache miss, and a filtered run
    //    with a REGULAR valid target + a non-target extra file stays legal.
    fs.rmSync(cpFile(FIX_CLI1), { force: true });
    assert.equal(F.loadClassifierCheckpoint(outputDir, FIX_CLI1, loadArgs), null, "ENOENT is the only cache miss");
    const a2 = completedCheckpointFixture({ episodeId: FIX_CLI1, requestPrefix: "req-ls2" });
    F.saveClassifierCheckpoint(outputDir, FIX_CLI1, a2.payload, { prompt: GOOD_PROMPT });
    fs.writeFileSync(cpFile("ep-extra000000000000"), "{}");
    const filtered = F.preflightClassifierCheckpoints(episodes, metaById, { outputDir, episodeIds: [FIX_CLI1] });
    assert.equal(filtered.resumable, 1, "regular target resumed; non-target extra tolerated on a filtered run");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("classifierCheckpointPath: unsafe episode ids are rejected before any mkdir/write and never escape the checkpoint leaf", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-unsafeid-"));
  try {
    const root = path.join(tmp, "checkpoints-fair");
    const leaf = F.classifierCheckpointDir(root);
    const bad = ["../escape", "a/b", "a\\b", "a\u0000b", ".", "..", "..\\x", "a/../b", "ep-1/../../escape"];
    for (const id of bad) {
      assert.throws(() => F.classifierCheckpointPath(root, id), /safe path component/, `classifierCheckpointPath must reject ${JSON.stringify(id)}`);
    }
    // Rejected ids never created the leaf and never escaped it.
    assert.ok(!fs.existsSync(leaf), "no checkpoint leaf created by rejected ids");
    assert.ok(!fs.existsSync(path.join(tmp, "escape.json")), "no escape file");
    assert.ok(!fs.existsSync(path.join(tmp, "escape")), "no escape dir");
    // A legal id resolves into the leaf.
    assert.equal(F.classifierCheckpointPath(root, FIX_F1), path.join(leaf, `${FIX_F1}.json`));
    // saveClassifierCheckpoint with an unsafe id is rejected before any
    // mkdir/write (the path assert fires before publishCheckpointAtomic).
    const { payload } = completedCheckpointFixture({ episodeId: FIX_F1 });
    assert.throws(() => F.saveClassifierCheckpoint(root, "../escape", payload, { prompt: GOOD_PROMPT }), /safe path component/);
    assert.ok(!fs.existsSync(leaf), "no checkpoint leaf created by the rejected save");
    assert.ok(!fs.existsSync(path.join(tmp, "escape.json")), "no escape file from the rejected save");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: classify mode without a durable checkpoint target (no --checkpoint-dir / --output) fails before any load / invoker / provider work", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-nocp-"));
  try {
    const { episodesPath, metaPath } = writeCliFixture(tmp, [makeEpisode("ep-cli-0001")], [makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER])]);
    const modelsJson = writeMinimalModelsJson(tmp);
    const r = spawnSelect(["--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r.status, 0, `classify without a checkpoint target must fail: ${r.stderr}`);
    assert.match(r.stderr, /durable checkpoint target/);
    assert.ok(noTmpFiles(tmp), "no tmp files");
    // Explicit --checkpoint-dir satisfies the gate (no --output needed): the
    // run proceeds past the gate and fails later on the empty registry.
    const r2 = spawnSelect(["--checkpoint-dir", path.join(tmp, "cp"), "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r2.status, 0, "with a checkpoint target it proceeds past the gate (fails later on the empty registry)");
    assert.ok(!/durable checkpoint target/.test(r2.stderr), "explicit --checkpoint-dir satisfies the paid-persistence gate");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: full-batch checkpoint preflight runs BEFORE makeJudgeInvoker (nonexistent models-json is the ordering witness); a bad checkpoint for B aborts before any provider work", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-preflight-"));
  try {
    const episodes = [makeEpisode("ep-cli-0001"), makeEpisode("ep-cli-0002")];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const { episodesPath, metaPath } = writeCliFixture(tmp, episodes, meta);
    const output = path.join(tmp, "selection.json");
    // B has a malformed checkpoint under the derived checkpoint dir.
    const cpDir = path.join(tmp, "checkpoints-fair", "checkpoints");
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(path.join(cpDir, `${FIX_CLI2}.json`), "{not json");
    // --models-json points at a NONEXISTENT path: if the preflight ran AFTER
    // makeJudgeInvoker, the ENOENT from the missing models.json would surface
    // first. The checkpoint error surfacing proves the preflight runs BEFORE
    // makeJudgeInvoker — candidate A never sends a request before B's bad
    // checkpoint is discovered.
    const r = spawnSelect(["--output", output, "--episodes", episodesPath, "--meta", metaPath, "--models-json", path.join(tmp, "nonexistent-models.json")]);
    assert.notEqual(r.status, 0, `expected nonzero exit, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /malformed/);
    assert.ok(!/ENOENT/.test(r.stderr), "checkpoint preflight must surface before the missing models-json (preflight runs before makeJudgeInvoker)");
    assert.ok(!fs.existsSync(output), "no output on preflight failure");
    assert.ok(noTmpFiles(tmp), "no tmp files");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("publishJsonAtomic: writes+renames atomically, leaves no tmp; serialization failure leaves no tmp and never touches an existing target", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-pub-"));
  try {
    const target = path.join(tmp, "selection.json");
    S.publishJsonAtomic(target, { kind: "prompt_only_replay_selection", selected: [] });
    assert.ok(fs.existsSync(target));
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).kind, "prompt_only_replay_selection");
    assert.ok(noTmpFiles(tmp), "no tmp files after success");
    // Pre-existing target + serialization failure (circular ref): the old
    // target is untouched and no tmp remains.
    fs.writeFileSync(target, "OLD");
    const circular = { a: 1 };
    circular.self = circular;
    assert.throws(() => S.publishJsonAtomic(target, circular), TypeError);
    assert.equal(fs.readFileSync(target, "utf8"), "OLD", "failed publish must not touch the existing target");
    assert.ok(noTmpFiles(tmp), "no tmp files after failure");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("publishSelectionManifest: a fake v2 classifier checkpoint can never cause a selection publish (real temp checkpoint + publication path); legal checkpoints publish", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-pubgate-"));
  try {
    const { manifest, checkpointDir, metaById, exclusions, stats, episodes } = buildProvenanceFixture(tmp);
    const output = path.join(tmp, "selection.json");
    const base = { payload: manifest, episodes, metaById, exclusions, stats, checkpointDir, output };
    // Legal checkpoints → provenance passes → atomic publish.
    S.publishSelectionManifest(base);
    assert.ok(fs.existsSync(output), "legal manifest must publish");
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).kind, "prompt_only_replay_selection");
    // Corrupt the checkpoint ledger (missing request_id) → provenance fails
    // → NO publish, no tmp, and the pre-existing output is untouched.
    const cpFile = path.join(checkpointDir, `${FIX_F1}.json`);
    const originalCp = fs.readFileSync(cpFile, "utf8");
    const cp = JSON.parse(originalCp);
    delete cp.attempt_log[judgeModelsForFixture()[0]][0].request_id;
    fs.writeFileSync(cpFile, `${JSON.stringify(cp, null, 2)}\n`);
    fs.writeFileSync(output, "OLD MANIFEST");
    assert.throws(() => S.publishSelectionManifest(base), /provenance validation FAILED before publish/);
    assert.equal(fs.readFileSync(output, "utf8"), "OLD MANIFEST", "failed provenance must not touch the existing output");
    assert.ok(noTmpFiles(tmp), "no tmp files after failed provenance publish");
    // Restore the checkpoint verbatim → publish succeeds again.
    fs.writeFileSync(cpFile, originalCp);
    S.publishSelectionManifest(base);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).kind, "prompt_only_replay_selection", "restored checkpoint must publish");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("producer→validator→publish integration: selectFairReplayEpisodes + mock invoker writes real checkpoints to the ROOT; publishSelectionManifest via the shared leaf helper succeeds; passing the ROOT as checkpointDir reports missing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-integration-"));
  try {
    // 3 non-mechanical hard-pass candidates (exact + 2 heuristic): the
    // producer classifies all three with the mock invoker and writes real
    // completed checkpoints to the checkpoint ROOT (root/checkpoints leaf).
    const episodes = [
      makeEpisode("ep-cli-0001"),
      makeEpisode("ep-cli-0002", { join_confidence: "heuristic" }),
      makeEpisode("ep-cli-0007", { join_confidence: "heuristic" }),
    ];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const metaById = new Map(meta.map((m) => [m.episode_id, m]));
    const exclusions = [];
    const stats = producerStats(episodes, meta, exclusions);
    const sol = "openai/gpt-5.6-sol";
    const opus = "anthropic/claude-opus-5";
    const invoker = makeMockInvoker({
      [sol]: [
        { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.01 },
        { toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.01 },
        { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.01 },
      ],
      [opus]: [
        { toolArgs: goodJudgment({ confidence: 0.8 }), cost: 0.02 },
        { toolArgs: goodJudgment({ confidence: 0.7 }), cost: 0.02 },
        { toolArgs: goodJudgment({ confidence: 0.9 }), cost: 0.02 },
      ],
    });
    const checkpointRoot = path.join(tmp, "checkpoints-fair");
    const manifest = await F.selectFairReplayEpisodes(episodes, metaById, {
      classify: true,
      invoker,
      judgeModels: [sol, opus],
      concurrency: 2,
      quiet: true,
      resume: false,
      outputDir: checkpointRoot,
    });
    assert.ok(manifest.counts.replayable >= 2, `expected >=2 replayable, got ${manifest.counts.replayable}`);
    // The producer actually wrote >=2 completed checkpoints to the LEAF
    // (root/checkpoints) — never hand-copied.
    const leaf = F.classifierCheckpointDir(checkpointRoot);
    const cpFiles = fs.readdirSync(leaf).filter((n) => n.endsWith(".json"));
    assert.ok(cpFiles.length >= 2, `expected >=2 checkpoints in the leaf, got ${cpFiles.length}`);
    for (const n of cpFiles) {
      const cp = JSON.parse(fs.readFileSync(path.join(leaf, n), "utf8"));
      assert.equal(cp.final.classification_status, "completed");
    }
    assert.equal(fs.readdirSync(checkpointRoot).filter((n) => n.endsWith(".json")).length, 0, "checkpoints live in the leaf, never the root");
    // Real payload — the same shape the CLI main builds before publishing.
    const payload = {
      ...manifest,
      schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
      episodes: "/abs/path/episodes.jsonl",
      meta: "/abs/path/episodes.meta.jsonl",
      limit: null,
      concurrency: 2,
      hard_only: false,
      classifier_models: [sol, opus],
      downstream_judges: [...F.DEFAULT_DOWNSTREAM_JUDGES],
      episode_ids: manifest.selected.map((s) => s.episode_id),
    };
    const output = path.join(tmp, "selection.json");
    // Positive: publish via the SAME leaf helper the CLI main uses.
    S.publishSelectionManifest({
      payload, episodes, metaById, exclusions, stats,
      checkpointDir: F.classifierCheckpointDir(checkpointRoot),
      output,
    });
    assert.ok(fs.existsSync(output), "legal producer manifest must publish");
    // Reload + re-validate provenance against the same leaf → ok.
    const reloaded = JSON.parse(fs.readFileSync(output, "utf8"));
    const prov = F.validateFairManifestProvenance({
      manifest: reloaded, episodes, metaById, exclusions, stats,
      checkpointDir: F.classifierCheckpointDir(checkpointRoot),
    });
    assert.equal(prov.ok, true, prov.errors.join("; "));
    // Negative: passing the ROOT as checkpointDir must report missing
    // checkpoints (the validator treats checkpointDir as the LEAF).
    const provRoot = F.validateFairManifestProvenance({
      manifest: reloaded, episodes, metaById, exclusions, stats,
      checkpointDir: checkpointRoot,
    });
    assert.equal(provRoot.ok, false, "the ROOT is never a valid checkpointDir");
    assert.match(provRoot.errors.join("; "), /checkpoint missing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function judgeModelsForFixture() {
  return ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
}

await check("spawn CLI: invalid classifier args in classify mode pre-delete the old output (no stale manifest survives a failed invocation)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-badargs-"));
  try {
    const { episodesPath, metaPath } = writeCliFixture(tmp, [makeEpisode("ep-cli-0001")], [makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER])]);
    const modelsJson = writeMinimalModelsJson(tmp);
    const output = path.join(tmp, "selection.json");
    fs.writeFileSync(output, "STALE MANIFEST");
    const r = spawnSelect([
      "--output", output,
      "--classifier-models", "openai/gpt-5.6-sol", // 1 model → parseArgs throws
      "--episodes", episodesPath,
      "--meta", metaPath,
      "--models-json", modelsJson,
    ]);
    assert.notEqual(r.status, 0, `expected nonzero exit, got ${r.status}: ${r.stderr}`);
    assert.ok(!fs.existsSync(output), "old output must be deleted before argument validation");
    assert.ok(noTmpFiles(tmp), "no tmp files");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: malformed episodes/meta fail closed (strict load) with no output and no tmp", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-malformed-"));
  try {
    const good = makeEpisode("ep-cli-0001");
    const modelsJson = writeMinimalModelsJson(tmp);
    const output = path.join(tmp, "out", "selection.json");
    const checkpointDir = path.join(tmp, "out", "checkpoints-fair");
    const metaPath = path.join(tmp, "episodes.meta.jsonl");
    fs.writeFileSync(metaPath, `${JSON.stringify(makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER]))}\n`);
    // Malformed episodes.jsonl (bad JSON line) → strict load throws.
    const epPath = path.join(tmp, "episodes.jsonl");
    fs.writeFileSync(epPath, `${JSON.stringify(good)}\nthis is not json\n`);
    const r1 = spawnSelect(["--output", output, "--checkpoint-dir", checkpointDir, "--episodes", epPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r1.status, 0, `malformed episodes must fail: ${r1.stderr}`);
    assert.match(r1.stderr, /:2: invalid JSON/);
    assert.ok(!fs.existsSync(output), "no output after malformed episodes");
    assert.ok(noTmpFiles(path.join(tmp, "out")), "no tmp files");
    // Malformed meta (duplicate episode_id) → strict load throws.
    fs.writeFileSync(epPath, `${JSON.stringify(good)}\n`);
    fs.writeFileSync(metaPath, `${JSON.stringify(makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER]))}\n${JSON.stringify(makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER]))}\n`);
    const r2 = spawnSelect(["--output", output, "--checkpoint-dir", checkpointDir, "--episodes", epPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r2.status, 0, `duplicate meta episode_id must fail: ${r2.stderr}`);
    assert.match(r2.stderr, new RegExp(`duplicate episode_id ${FIX_CLI1}`));
    assert.ok(!fs.existsSync(output), "no output after malformed meta");
    assert.ok(noTmpFiles(path.join(tmp, "out")), "no tmp files");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: model refs not in the temp registry fail pre-request (zero provider calls); no output, no tmp, failed diagnostic checkpoints only", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-nomodel-"));
  try {
    const episodes = [makeEpisode("ep-cli-0001"), makeEpisode("ep-cli-0002", { join_confidence: "heuristic" })];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const { episodesPath, metaPath } = writeCliFixture(tmp, episodes, meta);
    const modelsJson = writeMinimalModelsJson(tmp); // { providers: {} } — Sol/Opus5 not registered
    const output = path.join(tmp, "selection.json");
    const r = spawnSelect([
      "--output", output,
      "--episodes", episodesPath,
      "--meta", metaPath,
      "--models-json", modelsJson,
      "--classifier-models", "openai/gpt-5.6-sol,anthropic/claude-opus-5",
    ]);
    assert.notEqual(r.status, 0, `expected nonzero exit, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /classification\(s\) failed/i);
    assert.ok(!fs.existsSync(output), "no output on classification failure");
    assert.ok(noTmpFiles(tmp), "no tmp files");
    // Diagnostic failed checkpoints may exist (never completed ones).
    const cpDir = path.join(tmp, "checkpoints-fair", "checkpoints");
    if (fs.existsSync(cpDir)) {
      const cps = fs.readdirSync(cpDir).filter((n) => n.endsWith(".json"));
      assert.ok(cps.length > 0, "failed classifications save diagnostic checkpoints");
      for (const n of cps) {
        const cp = JSON.parse(fs.readFileSync(path.join(cpDir, n), "utf8"));
        assert.equal(cp.final.classification_status, "failed");
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: all-mechanical classify run is data insufficient — exit 2, no output published, completed checkpoints kept", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-insuff-"));
  try {
    // Hard-pass candidates whose prompts are all mechanical-excluded: no LLM
    // calls happen, but the selector CLI still constructs its invoker from
    // the temp minimal registry, classifications complete mechanically and
    // checkpoints are saved — then <2 replayable → data insufficient →
    // nothing published.
    const episodes = [
      makeEpisode("ep-cli-mech-0001", { prompt: FILE_PROMPT }),
      makeEpisode("ep-cli-mech-0002", { prompt: CMD_PROMPT }),
      makeEpisode("ep-cli-mech-0003", { prompt: LIVE_PROMPT }),
    ];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const { episodesPath, metaPath } = writeCliFixture(tmp, episodes, meta);
    const modelsJson = writeMinimalModelsJson(tmp);
    const output = path.join(tmp, "selection.json");
    const r = spawnSelect(["--output", output, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.equal(r.status, 2, `expected exit 2 for data insufficient, got ${r.status}: ${r.stderr}`);
    assert.ok(!fs.existsSync(output), "data-insufficient runs must not publish the manifest");
    assert.ok(noTmpFiles(tmp), "no tmp files");
    const cpDir = path.join(tmp, "checkpoints-fair", "checkpoints");
    const cps = fs.readdirSync(cpDir).filter((n) => n.endsWith(".json"));
    assert.equal(cps.length, 3, "every mechanical classification saves a completed checkpoint");
    for (const n of cps) {
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, n), "utf8"));
      assert.equal(cp.final.classification_status, "completed", "mechanical checkpoints are completed and kept");
      assert.equal(cp.final.stage, "mechanical");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: duplicate --output values or a value-less --output never delete anything and are rejected by parseArgs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-ambig-"));
  try {
    const { episodesPath, metaPath } = writeCliFixture(tmp, [makeEpisode("ep-cli-0001")], [makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER])]);
    const modelsJson = writeMinimalModelsJson(tmp);
    // Two different --output values: ambiguous → nothing deleted, parseArgs rejects.
    const outA = path.join(tmp, "a.json");
    const outB = path.join(tmp, "b.json");
    fs.writeFileSync(outA, "STALE A");
    fs.writeFileSync(outB, "STALE B");
    const r1 = spawnSelect(["--output", outA, "--output", outB, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r1.status, 0, "duplicate --output must be rejected");
    assert.match(r1.stderr, /duplicate option --output/);
    assert.equal(fs.readFileSync(outA, "utf8"), "STALE A", "ambiguous output must never be deleted");
    assert.equal(fs.readFileSync(outB, "utf8"), "STALE B", "ambiguous output must never be deleted");
    // --output with no value: ambiguous → nothing deleted, parseArgs rejects.
    const outC = path.join(tmp, "c.json");
    fs.writeFileSync(outC, "STALE C");
    const r2 = spawnSelect(["--output", "--hard-only", "--episodes", episodesPath, "--meta", metaPath]);
    assert.notEqual(r2.status, 0, "value-less --output must be rejected");
    assert.match(r2.stderr, /--output requires a value/);
    assert.equal(fs.readFileSync(outC, "utf8"), "STALE C", "value-less --output must never delete anything");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: malformed equals-form --output=<path> is uniquely determinable — old output revoked before the strict parse fails; no provider/checkpoint", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-eqout-"));
  // The equals-form token must be a fully static string for the registry AST
  // lock (a runtime path substitution is unresolvable), so the output path is
  // a fixed absolute path under os.tmpdir() that the test creates and cleans up.
  const output = "/tmp/t0-fair-eqout-selection.json";
  try {
    const { episodesPath, metaPath } = writeCliFixture(tmp, [makeEpisode("ep-cli-0001")], [makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER])]);
    const modelsJson = writeMinimalModelsJson(tmp);
    const checkpointDir = path.join(tmp, "checkpoints-fair");
    fs.writeFileSync(output, "STALE MANIFEST");
    // `--output=<path>` is rejected by parseStrictCli (--flag=value), but the
    // uniquely determinable path is still revoked by preflightOutputIntent
    // before the strict parse fails — no stale manifest survives.
    const r = spawnSelect([`--output=${output}`, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson, "--checkpoint-dir", checkpointDir]);
    assert.notEqual(r.status, 0, `expected nonzero exit, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /--output/);
    assert.ok(!fs.existsSync(output), "old output must be deleted before the strict parse fails");
    assert.ok(!fs.existsSync(checkpointDir), "no checkpoint dir created (no provider work)");
    assert.ok(noTmpFiles(tmp), "no tmp files");
  } finally {
    fs.rmSync(output, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: hard-only success does NOT pre-delete the old output but atomically replaces it; no tmp left", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-hard-"));
  try {
    const episodes = [makeEpisode("ep-cli-0001"), makeEpisode("ep-cli-0007", { join_confidence: "heuristic" })];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const { episodesPath, metaPath } = writeCliFixture(tmp, episodes, meta);
    const output = path.join(tmp, "selection.json");
    fs.writeFileSync(output, "STALE MANIFEST");
    const r = spawnSelect(["--hard-only", "--output", output, "--episodes", episodesPath, "--meta", metaPath]);
    assert.equal(r.status, 0, `hard-only must succeed: ${r.stderr}`);
    const content = fs.readFileSync(output, "utf8");
    assert.ok(!content.includes("STALE MANIFEST"), "stale content must be replaced, not appended");
    const manifest = JSON.parse(content);
    assert.equal(manifest.hard_only, true);
    assert.equal(manifest.classify, false);
    assert.deepEqual(manifest.episode_ids.sort(), [FIX_CLI1, FIX_CLI7]);
    assert.ok(noTmpFiles(tmp), "no tmp files after atomic replace");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: filtered classify (--episode / --limit incl. 0) with --output is refused — old output revoked, no tmp/checkpoint/provider; hard-only may still filter + output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-filtered-"));
  try {
    // 3 hard-pass episodes (exact + 2 heuristic): the refusal happens before
    // any strict load / invoker / provider work, so the corpus shape only
    // needs to be present.
    const episodes = [
      makeEpisode("ep-cli-0001"),
      makeEpisode("ep-cli-0002", { join_confidence: "heuristic" }),
      makeEpisode("ep-cli-0007", { join_confidence: "heuristic" }),
    ];
    const meta = episodes.map((e) => makeMeta(e.episode_id, [STRONG, SPEC, OTHER]));
    const { episodesPath, metaPath } = writeCliFixture(tmp, episodes, meta);
    const modelsJson = writeMinimalModelsJson(tmp);
    // --episode subset + --output in classify mode → refused.
    const output1 = path.join(tmp, "selection1.json");
    fs.writeFileSync(output1, "STALE MANIFEST");
    const r1 = spawnSelect(["--output", output1, "--episode", `${FIX_CLI1},${FIX_CLI2}`, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r1.status, 0, `filtered classify with --output must fail: ${r1.stderr}`);
    assert.match(r1.stderr, /filtered classify run is a diagnostic/i);
    assert.ok(!fs.existsSync(output1), "old output must be revoked before the refusal");
    assert.ok(noTmpFiles(tmp), "no tmp files");
    assert.ok(!fs.existsSync(path.join(tmp, "checkpoints-fair")), "no checkpoints created (refusal before any classification)");
    // --limit 2 + --output → refused (same contract).
    const output2 = path.join(tmp, "selection2.json");
    fs.writeFileSync(output2, "STALE MANIFEST 2");
    const r2 = spawnSelect(["--output", output2, "--limit", "2", "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r2.status, 0, `--limit with --output must fail: ${r2.stderr}`);
    assert.match(r2.stderr, /filtered classify run is a diagnostic/i);
    assert.ok(!fs.existsSync(output2), "old output must be revoked before the refusal");
    assert.ok(noTmpFiles(tmp), "no tmp files");
    assert.ok(!fs.existsSync(path.join(tmp, "checkpoints-fair")), "no checkpoints created");
    // --limit 0 + --output → refused (0 is still an execution filter).
    const output3 = path.join(tmp, "selection3.json");
    fs.writeFileSync(output3, "STALE MANIFEST 3");
    const r3 = spawnSelect(["--output", output3, "--limit", "0", "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r3.status, 0, `--limit 0 with --output must fail: ${r3.stderr}`);
    assert.match(r3.stderr, /filtered classify run is a diagnostic/i);
    assert.ok(!fs.existsSync(output3), "old output must be revoked before the refusal");
    // Classify WITHOUT --output stays a legal diagnostic run (no consumable
    // manifest): it must not be refused for the filter alone. It still fails
    // — now on the paid-persistence gate (classify mode without
    // --checkpoint-dir / --output has no durable checkpoint target) — but
    // NOT on the filtered-output refusal.
    const rDiag = spawnSelect(["--episode", `${FIX_CLI1},${FIX_CLI2}`, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(rDiag.status, 0, "diagnostic classify still fails (no durable checkpoint target) — but NOT on the filtered-output refusal");
    assert.ok(!/filtered classify run is a diagnostic/i.test(rDiag.stderr), "no filter+output refusal without --output");
    // hard-only may still filter AND output (listings are not classified
    // production manifests).
    const output4 = path.join(tmp, "hard.json");
    const r4 = spawnSelect(["--hard-only", "--output", output4, "--episode", `${FIX_CLI1},${FIX_CLI2}`, "--episodes", episodesPath, "--meta", metaPath]);
    assert.equal(r4.status, 0, `hard-only + filter + output must succeed: ${r4.stderr}`);
    assert.ok(fs.existsSync(output4), "hard-only filtered listing publishes");
    assert.deepEqual(JSON.parse(fs.readFileSync(output4, "utf8")).episode_ids.sort(), [FIX_CLI1, FIX_CLI2]);
    assert.ok(noTmpFiles(tmp), "no tmp files");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("spawn CLI: --hard-only <value> is rejected (not mistaken for hard-only); the old output is revoked as classify intent first, then parseArgs fails", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cli-hovalue-"));
  try {
    const { episodesPath, metaPath } = writeCliFixture(tmp, [makeEpisode("ep-cli-0001")], [makeMeta("ep-cli-0001", [STRONG, SPEC, OTHER])]);
    const modelsJson = writeMinimalModelsJson(tmp);
    // `--hard-only x`: preflight follows parseCli semantics — the value is
    // consumed, so this is NOT a bare hard-only flag (classify intent) → the
    // unique --output is revoked; parseArgs then rejects the value form.
    const output = path.join(tmp, "selection.json");
    fs.writeFileSync(output, "STALE MANIFEST");
    const r = spawnSelect(["--hard-only", "true", "--output", output, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r.status, 0, `--hard-only with a value must be rejected: ${r.stderr}`);
    assert.match(r.stderr, /--hard-only must not take a value/);
    assert.ok(!fs.existsSync(output), "old output must be revoked (classify intent) before parseArgs rejects the value form");
    assert.ok(noTmpFiles(tmp), "no tmp files");
    // Same-value duplicate --output: uniquely revocable by preflight, but
    // parseArgs rejects the duplicate occurrence.
    const out2 = path.join(tmp, "dup.json");
    fs.writeFileSync(out2, "STALE DUP");
    const r2 = spawnSelect(["--output", out2, "--output", out2, "--episodes", episodesPath, "--meta", metaPath, "--models-json", modelsJson]);
    assert.notEqual(r2.status, 0, `duplicate --output must be rejected: ${r2.stderr}`);
    assert.match(r2.stderr, /duplicate option --output/);
    assert.ok(!fs.existsSync(out2), "identical-duplicate output is uniquely determinable and revoked");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log("");
if (failures.length) {
  console.error(`\nt0-replay-fair smoke failed: ${failures.length}/${passed + failures.length}`);
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.error instanceof Error ? f.error.stack : f.error}`);
  }
  process.exit(1);
}
console.log(`t0-replay-fair smoke passed: ${passed}/${passed}`);
console.log("NOTE: real-data hard-gate scan + CLI cross-check is `npm run dossier:t0-replay-fair-production` (read-only, no network).");
console.log("NOTE: full production dual-LLM classification is via `npm run t0:replay-select` (not this smoke).");
