#!/usr/bin/env node
/**
 * Smoke: sediment multi-view review-all + rich Pass 1 synthesis.
 * Offline: injects a mock model caller, no real LLM/API calls.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

process.env.ABRAIN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-multi-view-abrain-"));

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true, moduleCache: false });
const { runMultiView } = jiti(path.join(repoRoot, "extensions/sediment/multi-view.ts"));
const settingsModule = jiti(path.join(repoRoot, "extensions/sediment/settings.ts"));
const baseSettings = settingsModule.DEFAULT_SEDIMENT_SETTINGS;

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function makeSettings(overrides = {}) {
  const { multiView: multiViewOverrides = {}, ...rest } = overrides;
  return {
    ...baseSettings,
    curatorModel: "mock/curator",
    curatorTimeoutMs: 10_000,
    ...rest,
    multiView: {
      ...baseSettings.multiView,
      reviewerProviders: ["mock/reviewer"],
      fallbackProviders: [],
      synthesisModel: "mock/synth",
      ...multiViewOverrides,
    },
  };
}

const registeredModels = new Set([
  "mock/reviewer",
  "mock/synth",
  "mock/curator",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "minimax/MiniMax-M3",
]);

const modelRegistry = {
  find(provider, id) {
    return registeredModels.has(`${provider}/${id}`) ? { provider, id } : null;
  },
  async getApiKeyAndHeaders() {
    return { ok: true, apiKey: "mock" };
  },
};

function makeCandidate(confidence = 5) {
  return {
    title: "Prefer pnpm",
    kind: "preference",
    status: "active",
    confidence,
    compiledTruth: "Use pnpm for package management in this project.",
  };
}

function makeNeighbor(slug = "prefer-yarn", overrides = {}) {
  return {
    slug,
    id: slug,
    scope: "project",
    kind: "preference",
    status: "active",
    confidence: 5,
    title: slug,
    summary: `Summary for ${slug}.`,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    sourcePath: `/tmp/${slug}.md`,
    displayPath: `/tmp/${slug}.md`,
    storeRoot: "/tmp",
    frontmatter: {},
    compiledTruth: `Existing truth for ${slug}.`,
    timeline: ["created"],
    relatedSlugs: [],
    relations: [],
    tokenCounts: new Map(),
    tokenTotal: 1,
    ...overrides,
  };
}

function makeCaller(responses) {
  const queue = [...responses];
  const calls = [];
  const caller = async (ref, parsed, _registry, prompt, _settings, passName, _signal, options) => {
    calls.push({ ref, parsed, prompt, pass: passName, options });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected model call: ${passName}`);
    if (next.pass && next.pass !== passName) throw new Error(`expected pass ${next.pass}, got ${passName}`);
    if (next.throw) throw new Error(next.throw);
    if (next.ok === false) return { ok: false, error: next.error ?? "mock failure" };
    return { ok: true, text: typeof next.text === "string" ? next.text : JSON.stringify(next.text) };
  };
  caller.calls = calls;
  return caller;
}

async function run(args, responses, settings = makeSettings({ multiView: { reviewAllMutations: true } })) {
  const caller = makeCaller(responses);
  const result = await runMultiView({
    proposerRawText: JSON.stringify(args.proposerDecision),
    candidate: args.candidate ?? makeCandidate(),
    neighbors: args.neighbors ?? [makeNeighbor()],
    correctionSignal: null,
    settings,
    modelRegistry,
    callModel: caller,
    originProjectId: "proj-smoke",
    ...args,
  });
  return { result, calls: caller.calls };
}

function passNames(calls) {
  return calls.map((c) => c.pass).join(",");
}

function isSynthesisFailed(result) {
  return result.final_decision.op === "skip" && result.final_decision.reason === "synthesis_failed";
}

console.log("Smoke: multi-view review-all + synthesis\n");

// B1: flag off preserves legacy heuristic: low-confidence project create is untriggered.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "create", rationale: "low conf project create" }, candidate: makeCandidate(5) },
    [],
    makeSettings({ multiView: { reviewAllMutations: false } }),
  );
  check("reviewAllMutations=false keeps low-conf project create untriggered", result.triggered === false);
  check("flag-off path makes no model calls", calls.length === 0, `calls=${calls.length}`);
}

// B1: flag on reviews every mutating op.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "create", rationale: "low conf project create" }, candidate: makeCandidate(5) },
    [
      { pass: "pass1", text: { op: "create", scope: "project", slug_target: null, reasoning: "create is fine" } },
      { pass: "pass2", text: { verdict: "confirm_proposer", rationale: "ok" } },
    ],
  );
  check("reviewAllMutations=true triggers low-conf project create", result.triggered === true);
  check("review-all trigger reason is audited on result", result.trigger_reason === "review_all_mutations", result.trigger_reason);
  check("flag-on path runs pass1+pass2", passNames(calls) === "pass1,pass2", passNames(calls));
}

// B1: op=skip remains unreviewed even when flag is on.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "skip", reason: "nothing to write" }, candidate: makeCandidate(5) },
    [],
  );
  check("reviewAllMutations=true does not review op=skip", result.triggered === false);
  check("skip path makes no model calls", calls.length === 0, `calls=${calls.length}`);
}

// Reviewer diversity selection: cross-vendor beats list-order same-provider when available.
{
  const settings = makeSettings({
    curatorModel: "openai/gpt-5.5",
    multiView: { reviewerProviders: ["openai/gpt-5.4-mini", "minimax/MiniMax-M3"], synthesisModel: "mock/synth", reviewAllMutations: true },
  });
  const { result, calls } = await run(
    { proposerDecision: { op: "create", rationale: "create" }, candidate: makeCandidate(5) },
    [
      { pass: "pass1", text: { op: "create", scope: "project", slug_target: null, reasoning: "create" } },
      { pass: "pass2", text: { verdict: "confirm_proposer", rationale: "ok" } },
    ],
    settings,
  );
  check("proposer=openai selects minimax reviewer when registered", calls[0]?.ref === "minimax/MiniMax-M3", calls[0]?.ref);
  check("cross-vendor reviewer diversity is audited on result", result.reviewer_diversity === "cross-vendor", result.reviewer_diversity);
  check("cross-vendor reviewer diversity is passed to model caller", calls.every((c) => c.options?.reviewerDiversity === "cross-vendor"), JSON.stringify(calls.map((c) => c.options)));
}

// Reviewer diversity selection: same-vendor cross-model is accepted when no other vendor is available.
{
  const settings = makeSettings({
    curatorModel: "openai/gpt-5.5",
    multiView: { reviewerProviders: ["openai/gpt-5.4-mini"], synthesisModel: "mock/synth", reviewAllMutations: true },
  });
  const { result, calls } = await run(
    { proposerDecision: { op: "create", rationale: "create" }, candidate: makeCandidate(5) },
    [
      { pass: "pass1", text: { op: "create", scope: "project", slug_target: null, reasoning: "create" } },
      { pass: "pass2", text: { verdict: "confirm_proposer", rationale: "ok" } },
    ],
    settings,
  );
  check("same-vendor cross-model reviewer is accepted", calls[0]?.ref === "openai/gpt-5.4-mini", calls[0]?.ref);
  check("same-vendor cross-model diversity is audited", result.reviewer_diversity === "same-vendor-cross-model", result.reviewer_diversity);
}

// Reviewer diversity selection: same-model isolated review is the final degradation.
{
  const settings = makeSettings({
    curatorModel: "openai/gpt-5.5",
    multiView: { reviewerProviders: ["openai/gpt-5.5"], synthesisModel: "mock/synth", reviewAllMutations: true },
  });
  const { result, calls } = await run(
    { proposerDecision: { op: "create", rationale: "create" }, candidate: makeCandidate(5) },
    [
      { pass: "pass1", text: { op: "create", scope: "project", slug_target: null, reasoning: "create" } },
      { pass: "pass2", text: { verdict: "confirm_proposer", rationale: "ok" } },
    ],
    settings,
  );
  check("same-model isolated reviewer is accepted", calls[0]?.ref === "openai/gpt-5.5", calls[0]?.ref);
  check("same-model diversity is audited", result.reviewer_diversity === "same-model", result.reviewer_diversity);
}

// B2: confirm_pass1 update gets a full payload from synthesis.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "update", slug: "prefer-yarn", patch: { title: "Prefer yarn" }, rationale: "proposer" } },
    [
      { pass: "pass1", text: { op: "update", slug_target: "prefer-yarn", scope: "project", reasoning: "prefer-yarn should be updated from the candidate" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "Pass 1 better matches prefer-yarn." } },
      { pass: "synthesis", text: { op: "update", slug: "prefer-yarn", patch: { compiled_truth: "Use pnpm for package management in this project." }, rationale: "synthesized update" } },
    ],
  );
  check("synthesis success returns full update decision", result.final_decision.op === "update", JSON.stringify(result.final_decision));
  check("synthesized update preserves pass1 slug_target", result.final_decision.slug === "prefer-yarn", JSON.stringify(result.final_decision));
  check("synthesis success sets synthesized marker", result.synthesized === true, JSON.stringify(result));
  check("synthesis model is called after pass1/pass2", passNames(calls) === "pass1,pass2,synthesis", passNames(calls));
}

// op matches but slug mismatches: deterministic synthesis_failed.
{
  const { result } = await run(
    { proposerDecision: { op: "update", slug: "prefer-yarn", patch: { title: "Prefer yarn" }, rationale: "proposer" }, neighbors: [makeNeighbor("prefer-yarn"), makeNeighbor("prefer-npm")] },
    [
      { pass: "pass1", text: { op: "update", slug_target: "prefer-yarn", scope: "project", reasoning: "update prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm update prefer-yarn" } },
      { pass: "synthesis", text: { op: "update", slug: "prefer-npm", patch: { compiled_truth: "Wrong target." }, rationale: "wrong slug" } },
    ],
  );
  check("synthesis same-op slug mismatch skips with synthesis_failed", isSynthesisFailed(result), JSON.stringify(result.final_decision));
  check("slug mismatch is not staged", result.staged === undefined, JSON.stringify(result.staged));
}

// Invented neighbor slug is rejected by parseDecision and remains deterministic.
{
  const { result } = await run(
    { proposerDecision: { op: "update", slug: "prefer-yarn", patch: { title: "Prefer yarn" }, rationale: "proposer" } },
    [
      { pass: "pass1", text: { op: "update", slug_target: "prefer-yarn", scope: "project", reasoning: "update prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm update prefer-yarn" } },
      { pass: "synthesis", text: { op: "update", slug: "invented-neighbor", patch: { compiled_truth: "Invented." }, rationale: "bad slug" } },
    ],
  );
  check("synthesis invented neighbor slug rejects with synthesis_failed", isSynthesisFailed(result), JSON.stringify(result.final_decision));
}

// Merge succeeds when every source slug is anchored in pass rationale/proposer merge sources.
{
  const neighbors = [makeNeighbor("prefer-yarn"), makeNeighbor("prefer-npm")];
  const { result } = await run(
    { proposerDecision: { op: "merge", target: "prefer-yarn", sources: ["prefer-yarn", "prefer-npm"], compiledTruth: "Combine package manager preferences." }, neighbors },
    [
      { pass: "pass1", text: { op: "merge", slug_target: "prefer-yarn", scope: "project", reasoning: "merge prefer-yarn with prefer-npm" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "prefer-yarn and prefer-npm describe one preference." } },
      { pass: "synthesis", text: { op: "merge", target: "prefer-yarn", sources: ["prefer-yarn", "prefer-npm"], compiled_truth: "Use pnpm for package management in this project.", rationale: "merge anchored sources" } },
    ],
  );
  check("merge synthesis succeeds with anchored sources", result.final_decision.op === "merge" && result.final_decision.sources.includes("prefer-npm"), JSON.stringify(result.final_decision));
}

// Merge source not anchored: deterministic synthesis_failed.
{
  const neighbors = [makeNeighbor("prefer-yarn"), makeNeighbor("prefer-npm")];
  const { result } = await run(
    { proposerDecision: { op: "update", slug: "prefer-yarn", patch: { title: "Prefer yarn" }, rationale: "proposer" }, neighbors },
    [
      { pass: "pass1", text: { op: "merge", slug_target: "prefer-yarn", scope: "project", reasoning: "merge prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm merge prefer-yarn" } },
      { pass: "synthesis", text: { op: "merge", target: "prefer-yarn", sources: ["prefer-npm"], compiled_truth: "Use pnpm for package management in this project.", rationale: "unanchored source" } },
    ],
  );
  check("merge synthesis with unanchored source skips with synthesis_failed", isSynthesisFailed(result), JSON.stringify(result.final_decision));
}

// Supersede newSlug may be dropped when unanchored; supersede still executes.
{
  const neighbors = [makeNeighbor("prefer-yarn"), makeNeighbor("prefer-pnpm")];
  const { result } = await run(
    { proposerDecision: { op: "supersede", oldSlug: "prefer-yarn", reason: "old preference" }, neighbors },
    [
      { pass: "pass1", text: { op: "supersede", slug_target: "prefer-yarn", scope: "project", reasoning: "supersede prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "prefer-yarn is stale" } },
      { pass: "synthesis", text: { op: "supersede", old_slug: "prefer-yarn", new_slug: "prefer-pnpm", reason: "old preference" } },
    ],
  );
  check("supersede unanchored newSlug is dropped", result.final_decision.op === "supersede" && result.final_decision.newSlug === undefined, JSON.stringify(result.final_decision));
  check("supersede still executes after dropping newSlug", result.final_decision.op === "supersede" && result.final_decision.oldSlug === "prefer-yarn", JSON.stringify(result.final_decision));
}

// Delete confirm_pass1 is never synthesized and stays not_synthesizable.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "delete", slug: "prefer-yarn", mode: "hard", reason: "remove" } },
    [
      { pass: "pass1", text: { op: "delete", slug_target: "prefer-yarn", scope: "project", reasoning: "delete prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm delete" } },
    ],
  );
  check("delete confirm_pass1 skips as not synthesizable", result.final_decision.op === "skip" && result.final_decision.reason === "multiview_pass1_op_not_synthesizable", JSON.stringify(result.final_decision));
  check("delete confirm_pass1 does not call synthesis", passNames(calls) === "pass1,pass2", passNames(calls));
}

// Synthesis transport failure stages for replay instead of synthesis_failed.
{
  const { result } = await run(
    { proposerDecision: { op: "update", slug: "prefer-yarn", patch: { title: "Prefer yarn" }, rationale: "proposer" } },
    [
      { pass: "pass1", text: { op: "update", slug_target: "prefer-yarn", scope: "project", reasoning: "update prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm update prefer-yarn" } },
      { pass: "synthesis", ok: false, error: "mock synthesis outage" },
    ],
  );
  check("synthesis transport failure stages", result.staged?.state === "synthesis_call_failed", JSON.stringify(result));
  check("synthesis transport failure returns staged_for_replay", result.final_decision.op === "skip" && result.final_decision.reason === "multiview_staged_for_replay", JSON.stringify(result.final_decision));
}

// Create confirm_pass1 is locally synthesizable with no synthesis call.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "create", rationale: "create" } },
    [
      { pass: "pass1", text: { op: "create", slug_target: null, scope: "project", reasoning: "create local payload" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm create" } },
    ],
  );
  check("create confirm_pass1 synthesizes locally", result.final_decision.op === "create", JSON.stringify(result.final_decision));
  check("create confirm_pass1 makes zero synthesis calls", passNames(calls) === "pass1,pass2", passNames(calls));
}

// Archive confirm_pass1 is locally synthesizable with no synthesis call.
{
  const { result, calls } = await run(
    { proposerDecision: { op: "archive", slug: "prefer-yarn", reason: "stale" } },
    [
      { pass: "pass1", text: { op: "archive", slug_target: "prefer-yarn", scope: "project", reasoning: "archive prefer-yarn" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm archive" } },
    ],
  );
  check("archive confirm_pass1 synthesizes locally", result.final_decision.op === "archive" && result.final_decision.slug === "prefer-yarn", JSON.stringify(result.final_decision));
  check("archive confirm_pass1 makes zero synthesis calls", passNames(calls) === "pass1,pass2", passNames(calls));
}

// Rules-lane neighbor targets are rejected by synthesis parseDecision.
{
  const rulesNeighbor = makeNeighbor("always-run-tests", {
    kind: "rule",
    scope: "project",
    sourcePath: "/tmp/rules/always/always-run-tests.md",
    displayPath: "/tmp/rules/always/always-run-tests.md",
    frontmatter: { zone: "rules" },
  });
  const { result } = await run(
    { proposerDecision: { op: "update", slug: "always-run-tests", patch: { title: "Always run tests" }, rationale: "proposer" }, neighbors: [rulesNeighbor] },
    [
      { pass: "pass1", text: { op: "update", slug_target: "always-run-tests", scope: "project", reasoning: "update always-run-tests" } },
      { pass: "pass2", text: { verdict: "confirm_pass1", rationale: "confirm update always-run-tests" } },
      { pass: "synthesis", text: { op: "update", slug: "always-run-tests", patch: { compiled_truth: "Always run smoke tests." }, rationale: "rules lane target" } },
    ],
  );
  check("rules-lane neighbor target rejects with synthesis_failed", isSynthesisFailed(result), JSON.stringify(result.final_decision));
}

console.log("\n----");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) process.exit(1);
