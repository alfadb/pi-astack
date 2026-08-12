#!/usr/bin/env node
/**
 * smoke-t0-replay-fair — focused tests for fair prompt-only replay selection
 * and dual-judge classification (scripts/t0-replay-fair-common.mjs +
 * t0-replay-select.mjs).
 *
 * Section 1: pure fixtures + mock invoker (hard gates, body/meta 1:1,
 *            mechanical pos/neg, dual-judge merge, dual-call with schema
 *            retry, checkpoint/resume/cost, dual-judge contract).
 * Section 2: production corpus hard-gate scan (report only; full dual LLM
 *            classification is the separate `t0:replay-select` production
 *            run — smoke never self-proves success on an empty candidate set).
 *
 * Does NOT call Flash/Grok and does NOT run replay build/eval.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = await import(path.join(root, "scripts/t0-replay-fair-common.mjs"));
const C = await import(path.join(root, "scripts/t0-eval-common.mjs"));

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

function makeEpisode(id, {
  prompt = GOOD_PROMPT,
  tools = null,
  join_confidence = "exact",
  slots = null,
} = {}) {
  const defaultSlots = [
    { slot_id: `${id}-a`, model_id: "c0", output: "SIGN", output_source: "dispatch_trace", output_chars: 4, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence, join_note: join_confidence, missing_evidence: [] },
    { slot_id: `${id}-b`, model_id: "c1", output: "SIGN with notes", output_source: "dispatch_trace", output_chars: 14, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence, join_note: join_confidence, missing_evidence: [] },
    { slot_id: `${id}-c`, model_id: "c2", output: "REVISE point 2", output_source: "dispatch_trace", output_chars: 13, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence, join_note: join_confidence, missing_evidence: [] },
  ];
  const bodySlots = slots ?? defaultSlots;
  return {
    schema_version: 3,
    dataset_mode: "final_answer_only",
    episode_id: id,
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
  const slots = models.map((model, i) => ({
    slot_id: mapOrphan && i === 1 ? `${id}-orphan` : `${id}-${["a", "b", "c", "d"][i]}`,
    model,
    in_body: true,
    exclusion_reason: null,
  }));
  return { schema_version: 3, episode_id: id, slots };
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
      { slot_id: "ep-fair-0005-a", model_id: "c0", output: "A", output_source: "dispatch_trace", output_chars: 1, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
      { slot_id: "ep-fair-0005-b", model_id: "c1", output: "B", output_source: "dispatch_trace", output_chars: 1, result: "ok", terminal_state: null, stop_reason: null, failure_type: null, join_confidence: "exact", join_note: "exact", missing_evidence: [] },
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

// ── Section 1: fixtures ───────────────────────────────────────────────────

console.log("t0-replay-fair unit tests (fixtures + mock invoker)\n");

await check("hard gates: exact|heuristic + tools_null + strong + specialist + no_downstream_judge + map", () => {
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById, { limit: undefined });
  const ids = hard.candidates.map((c) => c.episode.episode_id).sort();
  assert.deepEqual(
    ids,
    ["ep-fair-0001", "ep-fair-0006", "ep-fair-0007", "ep-fair-0008"],
    `hard-pass ids=${ids.join(",")}`,
  );
  // exact preferred before heuristic
  const order = hard.candidates.map((c) => c.episode.episode_id);
  const exactIdx = order.indexOf("ep-fair-0001");
  const heurIdx = order.indexOf("ep-fair-0007");
  assert.ok(exactIdx < heurIdx, "exact must sort before heuristic");
  assert.equal(hard.join_tier.exact, 3);
  assert.equal(hard.join_tier.heuristic, 1);

  const byId = Object.fromEntries(hard.excluded.map((e) => [e.episode_id, e.reasons]));
  assert.ok(byId["ep-fair-0002"]?.includes("join_not_allowed"));
  assert.ok(byId["ep-fair-0003"]?.includes("tools_not_null"));
  assert.ok(byId["ep-fair-0004"]?.includes("contains_judge_model"));
  assert.ok(byId["ep-fair-0005"]?.includes("body_meta_slot_map_incomplete"));
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
  const ep = FIXTURE_EPISODES.find((e) => e.episode_id === "ep-fair-0005");
  const meta = FIXTURE_META.find((m) => m.episode_id === "ep-fair-0005");
  const map = F.bodyMetaSlotMapComplete(ep, meta);
  assert.equal(map.ok, false);
  const good = F.bodyMetaSlotMapComplete(
    FIXTURE_EPISODES.find((e) => e.episode_id === "ep-fair-0001"),
    FIXTURE_META.find((m) => m.episode_id === "ep-fair-0001"),
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

await check("checkpoint binds schema_version + episode_id + prompt_hash + protocol_hash + 2 judges + thinking", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-fair-cp-"));
  const episodeId = "ep-fair-0001";
  const prompt_hash = F.promptHash(GOOD_PROMPT);
  const protocol_hash = F.classifierProtocolHash();
  const judge_models = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
  const thinking = "medium";
  const final = {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    episode_id: episodeId,
    stage: "llm",
    replayable: true,
    reasons: ["ok"],
    confidence: 0.9,
    cost: 0.02,
    cost_source: "provider",
    cost_breakdown: { provider: 0.02, estimated: 0, unknown: 0 },
    attempts: 2,
    judge_models,
    prompt_hash,
    protocol_hash,
    thinking,
  };
  F.saveClassifierCheckpoint(tmp, episodeId, {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    episode_id: episodeId,
    prompt_hash,
    protocol_hash,
    judge_models,
    thinking,
    final,
  });
  const hit = F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash, protocol_hash, judge_models, thinking,
  });
  assert.ok(hit);
  assert.equal(hit.final.replayable, true);

  assert.equal(F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash: F.promptHash("other"), protocol_hash, judge_models, thinking,
  }), null);
  assert.equal(F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash, protocol_hash: "0".repeat(64), judge_models, thinking,
  }), null);
  assert.equal(F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash, protocol_hash, judge_models: ["openai/gpt-5.6-sol", "other/model"], thinking,
  }), null);
  assert.equal(F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash, protocol_hash, judge_models, thinking: "high",
  }), null);

  // Incomplete final schema → miss
  F.saveClassifierCheckpoint(tmp, episodeId, {
    schema_version: F.FAIR_SELECT_SCHEMA_VERSION,
    episode_id: episodeId,
    prompt_hash,
    protocol_hash,
    judge_models,
    thinking,
    final: { episode_id: episodeId, replayable: true },
  });
  assert.equal(F.loadClassifierCheckpoint(tmp, episodeId, {
    prompt_hash, protocol_hash, judge_models, thinking,
  }), null);

  fs.rmSync(tmp, { recursive: true, force: true });
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
  const cand = hard.candidates.find((c) => c.episode.episode_id === "ep-fair-0001");
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
  const cand = hard.candidates.find((c) => c.episode.episode_id === "ep-fair-0008");
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

await check("classifyCandidate mechanical exclude short-circuits without LLM", async () => {
  const metaById = new Map(FIXTURE_META.map((m) => [m.episode_id, m]));
  const hard = F.selectHardCandidates(FIXTURE_EPISODES, metaById);
  const fileCand = hard.candidates.find((c) => c.episode.episode_id === "ep-fair-0006");
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

// ── Section 2: production corpus hard scan (no empty-set self-proof) ──────

console.log("\nt0-replay-fair production hard-gate scan (no Flash/Grok; no empty-set self-proof)\n");

const home = path.resolve(process.env.HOME || os.homedir());
const sourceEpisodesPath = path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
const sourceMetaPath = path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.meta.jsonl");
const modelsJsonPath = path.join(home, ".pi", "agent", "models.json");

await check("production: source episodes + meta exist", () => {
  assert.ok(fs.existsSync(sourceEpisodesPath), `missing ${sourceEpisodesPath}`);
  assert.ok(fs.existsSync(sourceMetaPath), `missing ${sourceMetaPath}`);
  assert.ok(fs.existsSync(modelsJsonPath), `missing ${modelsJsonPath}`);
});

const sourceEpisodes = C.loadEpisodes(sourceEpisodesPath);
const sourceMeta = F.loadMeta(sourceMetaPath);
const sourceMetaById = new Map(sourceMeta.map((m) => [m.episode_id, m]));

await check("production: hard-gate scan reports distribution (not empty-set success)", () => {
  const hard = F.selectHardCandidates(sourceEpisodes, sourceMetaById, { limit: undefined });
  console.log(`  hard_pass=${hard.hard_pass_count} / source=${sourceEpisodes.length}`);
  console.log(`  join_tier=${JSON.stringify(hard.join_tier)}`);
  console.log(`  hard exclusion_distribution=${JSON.stringify(hard.distribution)}`);
  assert.equal(typeof hard.hard_pass_count, "number");
  // Smoke success must not rest on an empty candidate set: if hard_pass==0
  // the pipeline still ran, but we surface it as a corpus warning rather
  // than a green "selection works" claim. Fixture section above already
  // proved non-empty dual-call behaviour via mocks.
  if (hard.hard_pass_count === 0) {
    console.log("  WARN: production hard_pass=0 — corpus fact; fixture mocks cover dual-call path");
  } else {
    assert.ok(hard.hard_pass_count >= 1);
    // tools strict null + join allowed on every hard-pass
    for (const c of hard.candidates) {
      assert.equal(c.episode.tools, null);
      assert.ok(["exact", "heuristic"].includes(c.join_confidence));
    }
  }
});

await check("production: CLI --hard-only lists only hard-pass ids", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = path.join(root, "scripts/t0-replay-select.mjs");
  const r = spawnSync(process.execPath, [script, "--hard-only", "--json", "--quiet"], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
  const ids = JSON.parse(r.stdout.trim() || "[]");
  const hard = F.selectHardCandidates(sourceEpisodes, sourceMetaById);
  assert.deepEqual(ids.sort(), hard.candidates.map((c) => c.episode.episode_id).sort());
});

await check("CLI rejects classifier-models count ≠ 2 and downstream-judges out of 1..5", async () => {
  const { spawnSync } = await import("node:child_process");
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

  const zeroDown = spawnSync(process.execPath, [
    script, "--hard-only",
    "--downstream-judges", "",
    "--quiet",
  ], { encoding: "utf8", env: process.env });
  // empty string → parseModelList null → defaults kick in → success, so use a
  // deliberate 6-model list instead.
  const six = spawnSync(process.execPath, [
    script, "--hard-only",
    "--downstream-judges", "a,b,c,d,e,f",
    "--quiet",
  ], { encoding: "utf8", env: process.env });
  assert.notEqual(six.status, 0);
  assert.match(six.stderr, /1\.\.5|downstream-judges/i);
  // silence unused
  void zeroDown;
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
console.log("NOTE: full production dual-LLM classification is via `npm run t0:replay-select` (not this smoke).");
