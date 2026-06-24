#!/usr/bin/env node
/**
 * Smoke: ADR 0028 PR1 read-only rules neighbors + Tier-1 direct lane.
 *
 * Pins migration invariants:
 * 1. rules-as-neighbors are read-only context only;
 * 2. Tier-1 user-expressed durable directives write deterministically before LLM;
 * 3. non-Tier-1 signals still fall through to the legacy extractor path;
 * 4. R4 outcome contradictions can contest an injected rule deterministically;
 *    MATCH evidence lands in rule-outcome-edge.jsonl with mechanical self-echo
 *    deduction (decisive=injection_compliance, filler/parrot/missing
 *    counterfactual deducted), user-role restatements are the user-anchored
 *    MATCH source, the edge consumes only the per-turn ledger delta, and a
 *    MATCH never mutates rule status (ADR 0028 R4' asymmetry);
 * 5. R3 negative recall audits user-role imperatives without corresponding rules;
 * 6. R6' staging narrowing: Tier-1-eligible durable signals skip the
 *    provisional-staging net whenever the deterministic direct lane is live
 *    (autoLlmWriteEnabled === true); staging keeps firing in false/"staging-only"
 *    modes where the direct lane never runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-pr1-stubs-"));

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

const piAiStubPath = path.join(stubRoot, "pi-ai.cjs");
writeFile(piAiStubPath, `
class EventStream {
  constructor(_isDone, _getResult) {}
}
exports.EventStream = EventStream;
exports.parseStreamingJson = () => null;
exports.streamSimple = function streamSimple(_model, opts, _config) {
  const prompt = opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] && opts.messages[0].content[0].text || "";
  globalThis.__ADR0028_PR1_PROMPTS__ = globalThis.__ADR0028_PR1_PROMPTS__ || [];
  globalThis.__ADR0028_PR1_PROMPTS__.push(prompt);
  const i = globalThis.__ADR0028_PR1_INVOCATIONS__ || 0;
  globalThis.__ADR0028_PR1_INVOCATIONS__ = i + 1;
  const text = (globalThis.__ADR0028_PR1_RESPONSES__ || [])[i] || "SKIP";
  return { result: async () => ({ stopReason: "complete", content: [{ type: "text", text }] }) };
};
exports.Type = {};
`);

const piCodingAgentStubPath = path.join(stubRoot, "pi-coding-agent.cjs");
writeFile(piCodingAgentStubPath, `
class AgentSession {}
AgentSession.prototype._buildRuntime = function () {};
AgentSession.prototype._emit = function () {};
AgentSession.prototype._runAutoCompaction = function () { return false; };
class InteractiveMode {}
InteractiveMode.prototype.handleEvent = function () {};
exports.AgentSession = AgentSession;
exports.InteractiveMode = InteractiveMode;
`);

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai": piAiStubPath,
    // Production migrated to the /compat subpath (pi 0.80.0 moved the global
    // stream API off the pi-ai root); alias it to the same stub.
    "@earendil-works/pi-ai/compat": piAiStubPath,
    "@earendil-works/pi-coding-agent": piCodingAgentStubPath,
  },
});
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-pr1-home-"));
process.env.HOME = smokeHome;
writeFile(path.join(smokeHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
  sediment: {
    enabled: true,
    autoLlmWriteEnabled: true,
    gitCommit: false,
    minWindowChars: 0,
    extractorModel: "mock/extractor",
    classifierModel: "mock/classifier",
    curatorModel: "mock/curator",
    extractorAuditRawChars: 1000,
    autoWriteRawAuditChars: 1000,
    multiView: { proposerProviders: [], reviewerProviders: [], fallbackProviders: [] },
  },
  memory: {
    search: {
      stage1Model: "mock/search-stage1",
      stage2Model: "mock/search-stage2",
    },
  },
}, null, 2));

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function freshFixture(label = "pr1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-${label}-root-`));
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-${label}-abrain-`));
  process.env.ABRAIN_ROOT = abrainHome;
  return { root, abrainHome, projectId: `${label}-project` };
}

/** Pre-seed every fire-and-forget "IfDue" side lane (aggregator, staging
 *  resolver/ageout, archive-reactivation, entry-telemetry) as recently-run so
 *  none of them races the classifier for the ORDERED pi-ai stub responses.
 *  The race was latent in every real-agent_end check: the aggregator's
 *  skeptical-historian LLM call sometimes consumed response[0] before the
 *  classifier did, flipping the classifier's parsed signal per run. */
function quietIfDueLanes(fx) {
  const dir = path.join(fx.root, ".pi-astack", "sediment");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = JSON.stringify({ last_run_ts: new Date().toISOString(), status: "ok" }, null, 2) + "\n";
  for (const name of [
    "aggregator-last-run.json",
    "staging-resolver-last-run.json",
    "staging-ageout-last-run.json",
    "archive-reactivation-last-run.json",
    "entry-telemetry-last-run.json",
  ]) fs.writeFileSync(path.join(dir, name), stamp, "utf-8");
}

function ruleEdgeLedgerPath(fx) {
  return path.join(fx.abrainHome, ".state", "sediment", "rule-outcome-edge.jsonl");
}

function makeUserEntry(id, text) {
  return { type: "message", id, timestamp: "2026-06-08T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } };
}

function makeRunWindow(text = "--- ENTRY 1 u1 message/user ---\n用户说了一个长期规则。") {
  return {
    entries: [makeUserEntry("u1", text)],
    text,
    chars: text.length,
    totalBranchEntries: 1,
    candidateEntries: 1,
    includedEntries: 1,
    checkpointFound: false,
    lastEntryId: "u1",
  };
}

function makeAgentEndHarness(branch) {
  const handlers = new Map();
  const status = [];
  return {
    pi: {
      on(name, handler) { handlers.set(name, handler); },
      registerCommand() {},
      tools: { register() {} },
    },
    ctx: {
      cwd: undefined,
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "agent-end-session",
        getSessionFile: () => path.join(smokeHome, "sessions", "agent-end-session.jsonl"),
      },
      modelRegistry: makeModelRegistry(),
      ui: {
        notify() {},
        setStatus(key, message) { status.push({ key, message }); },
      },
    },
    async fireAgentEnd(cwd) {
      const handler = handlers.get("agent_end");
      assert(typeof handler === "function", "sediment extension must register agent_end");
      this.ctx.cwd = cwd;
      await handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, this.ctx);
    },
    status,
  };
}

function makeModelRegistry() {
  return {
    find: () => ({ id: "mock-model", contextWindow: 100000 }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-not-real", headers: {} }),
  };
}

function resetPiAiStub(responses) {
  globalThis.__ADR0028_PR1_INVOCATIONS__ = 0;
  globalThis.__ADR0028_PR1_RESPONSES__ = responses.slice();
  globalThis.__ADR0028_PR1_PROMPTS__ = [];
}

const runtime = await jiti.import(`${repoRoot}/extensions/_shared/runtime.ts`);
const outcomeCollector = await jiti.import(`${repoRoot}/extensions/sediment/outcome-collector.ts`);
const curator = await jiti.import(`${repoRoot}/extensions/sediment/curator.ts`);
const sedimentIndex = await jiti.import(`${repoRoot}/extensions/sediment/index.ts`);
const writer = await jiti.import(`${repoRoot}/extensions/sediment/writer.ts`);
const sedimentSettings = await jiti.import(`${repoRoot}/extensions/sediment/settings.ts`);

const {
  buildCuratorPrompt,
  isRuleNeighborEntry,
  loadReadonlyRuleNeighborEntries,
  neighborLaneFor,
  parseDecision,
  CuratorRejectError,
} = curator;
const { bindAbrainProject, sedimentAuditPath, sedimentCheckpointPath } = runtime;
const { writeOutcomeLedger } = outcomeCollector;
const { _applyRuleOutcomeEdgeForTests, _auditDirectiveRecallForTests, _refreshRuleCacheForOutcomeEdgeTests, _resetAutoWriteStateForTests, _tryAutoWriteLaneForTests, _waitForAutoWriteIdleForTests } = sedimentIndex;
const { writeAbrainRule } = writer;
const { DEFAULT_SEDIMENT_SETTINGS } = sedimentSettings;

const baseSettings = {
  ...DEFAULT_SEDIMENT_SETTINGS,
  enabled: true,
  autoLlmWriteEnabled: true,
  gitCommit: false,
  extractorModel: "mock/extractor",
  curatorModel: "mock/curator",
  extractorAuditRawChars: 1000,
  autoWriteRawAuditChars: 1000,
  multiView: {
    ...DEFAULT_SEDIMENT_SETTINGS.multiView,
    proposerProviders: [],
    reviewerProviders: [],
    fallbackProviders: [],
  },
};

console.log("ADR 0028 PR1 — rules readonly neighbors + Tier-1 direct");

await check("S1: loadReadonlyRuleNeighborEntries scans global + active-project rules", async () => {
  const fx = freshFixture("pr1-s1");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "Global Glab", body: "git.alfadb.cn 仓库必须使用 glab 管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 8, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  await writeAbrainRule(
    { title: "Project Design First", body: "本项目每次先写设计再动代码。", kind: "decision", injectMode: "listed", scope: { projectId: fx.projectId }, entryConfidence: 7, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );

  const entries = loadReadonlyRuleNeighborEntries({ abrainHome: fx.abrainHome, cwd: fx.root });
  assert(entries.length === 2, `expected 2 rule neighbors, got ${entries.length}`);
  assert(entries.every(isRuleNeighborEntry), "every loaded entry must be rule-lane");
  assert(entries.every((entry) => neighborLaneFor(entry) === "rules"), "neighborLaneFor(rule) must be rules");
  assert(entries.some((entry) => entry.slug === "global-glab" && entry.frontmatter?.rule_scope === "global"), "global rule shape missing");
  assert(entries.some((entry) => entry.slug === "project-design-first" && entry.frontmatter?.project_id === fx.projectId), "project rule shape missing");
});

await check("S2: rule neighbor detection works by frontmatter and path", async () => {
  const byFrontmatter = { slug: "a", scope: "project", frontmatter: { zone: "rules" }, sourcePath: "/tmp/a.md" };
  const byPath = { slug: "b", scope: "world", frontmatter: {}, sourcePath: "/tmp/.abrain/rules/always/b.md" };
  const plain = { slug: "c", scope: "project", frontmatter: {}, sourcePath: "/tmp/.abrain/projects/x/facts/c.md" };
  assert(isRuleNeighborEntry(byFrontmatter) && neighborLaneFor(byFrontmatter) === "rules", "frontmatter zone=rules must classify as rules");
  assert(isRuleNeighborEntry(byPath) && neighborLaneFor(byPath) === "rules", "rules/always path must classify as rules");
  assert(!isRuleNeighborEntry(plain) && neighborLaneFor(plain) === "project", "plain project entry must stay project lane");
});

await check("S3: parseDecision hard-rejects lifecycle ops targeting rule neighbors", async () => {
  const scopes = new Map([["global-glab", "rules"]]);
  for (const raw of [
    { op: "update", slug: "global-glab", patch: { compiled_truth: "x" } },
    { op: "archive", slug: "global-glab", reason: "retire" },
    { op: "delete", slug: "global-glab", mode: "soft", reason: "retire" },
    { op: "supersede", old_slug: "global-glab", reason: "retire" },
    { op: "merge", target: "global-glab", sources: ["global-glab"], compiled_truth: "merged" },
  ]) {
    let threw = false;
    try { parseDecision(JSON.stringify(raw), scopes); }
    catch (e) {
      threw = true;
      assert(e instanceof CuratorRejectError && e.code === "rules_lane_read_only", `wrong error for ${raw.op}: ${e?.code || e}`);
    }
    assert(threw, `${raw.op} must reject rules-lane target`);
  }
});

await check("S4: rules create remains allowed while existing-rule lifecycle is read-only", async () => {
  const decision = parseDecision(JSON.stringify({ op: "create", zone: "rules", inject_mode: "always", rule_scope: "global", rationale: "new rule" }), new Map([["global-glab", "rules"]]));
  assert(decision.op === "create" && decision.zone === "rules" && decision.injectMode === "always" && decision.ruleScope === "global", `rules create should parse, got ${JSON.stringify(decision)}`);
});

await check("S5: curator prompt labels rule neighbors as READ-ONLY", async () => {
  const fx = freshFixture("pr1-s5");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "Global Glab", body: "git.alfadb.cn 仓库必须使用 glab 管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 8, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  const entries = loadReadonlyRuleNeighborEntries({ abrainHome: fx.abrainHome, cwd: fx.root });
  const prompt = buildCuratorPrompt({ title: "Glab duplicate", kind: "preference", status: "active", confidence: 8, compiledTruth: "git.alfadb.cn 仓库必须使用 glab 管理。" }, entries);
  assert(prompt.includes("scope: rules (READ-ONLY reference"), "prompt must mark rule neighbor scope as read-only");
  assert(prompt.includes("Do NOT target a rule slug"), "prompt must warn curator not to mutate rule neighbors");
});

await check("S6: schema exposes ADR 0028-compliant Jaccard defaults and removes Tier-1 shadow flag", async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf-8"));
  const props = schema.properties?.sediment?.properties ?? {};
  assert(props.rulesAsReadonlyNeighborsEnabled?.type === "boolean" && props.rulesAsReadonlyNeighborsEnabled?.default === true, "rulesAsReadonlyNeighborsEnabled schema missing/default wrong");
  assert(props.tier1JaccardCuratorLane?.type === "boolean" && props.tier1JaccardCuratorLane?.default === true, "tier1JaccardCuratorLane schema missing/default wrong");
  assert(!Object.prototype.hasOwnProperty.call(props, "tier1ShadowEnabled"), "tier1ShadowEnabled schema flag must be removed");
});

await check("S7: settings resolver carries ADR 0028-compliant Jaccard defaults and no shadow flag", async () => {
  assert(DEFAULT_SEDIMENT_SETTINGS.rulesAsReadonlyNeighborsEnabled === true, "rulesAsReadonlyNeighborsEnabled default must be true");
  assert(DEFAULT_SEDIMENT_SETTINGS.tier1JaccardCuratorLane === true, "tier1JaccardCuratorLane default must be true");
  assert(!Object.prototype.hasOwnProperty.call(DEFAULT_SEDIMENT_SETTINGS, "tier1ShadowEnabled"), "tier1ShadowEnabled default must be removed");
});

await check("S8: Tier-1 direct writes global rule before extractor", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s8");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "direct-global",
    settings: { ...baseSettings, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: null,
    correlationId: "direct-global:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "tier1_direct", `Tier-1 direct expected, got ${JSON.stringify(outcome)}`);
  assert(outcome.result.status === "created", `direct writer should create rule, got ${JSON.stringify(outcome.result)}`);
  assert(outcome.result.ruleScope === "global", `rule scope should be global, got ${JSON.stringify(outcome.result)}`);
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 0, `direct path must bypass LLM, got ${globalThis.__ADR0028_PR1_INVOCATIONS__} invocations`);
  assert(fs.existsSync(path.join(fx.abrainHome, "rules", "always", "github-repos-use-gh.md")), "direct path must write global rule file");
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const direct = rows.find((row) => row.operation === "tier1_direct_write");
  assert(direct?.deterministic_direct_path === true, `tier1_direct_write audit missing: ${JSON.stringify(rows)}`);
  assert(direct.signal_consumed === true && direct.checkpoint_advanced === false, `direct audit consumption/checkpoint wrong: ${JSON.stringify(direct)}`);
  assert(!rows.some((row) => row.operation === "tier1_shadow_decision"), `shadow audit row must not exist: ${JSON.stringify(rows)}`);
  assert(!fs.existsSync(sedimentCheckpointPath(fx.root)), "tryAutoWriteLane test hook must not checkpoint");
});

await check("S9: Tier-1 direct infers project scope from directive", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s9");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "本项目 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "direct-project",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: null,
    correlationId: "direct-project:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "本项目 GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "tier1_direct", `Tier-1 direct expected, got ${JSON.stringify(outcome)}`);
  assert(outcome.result.ruleScope === "project" && outcome.result.projectId === fx.projectId, `rule scope should be project, got ${JSON.stringify(outcome.result)}`);
  assert(fs.existsSync(path.join(fx.abrainHome, "projects", fx.projectId, "rules", "always", "本项目-github-repos-use-gh.md")), "direct path must write project rule file");
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 0, "project direct path must bypass LLM");
});

await check("S10: Tier-1 direct pads terse directives instead of dropping", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s10");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "direct-short",
    settings: baseSettings,
    window: makeRunWindow("--- ENTRY 1 u1 message/user ---\n用gh"),
    modelRegistry: null,
    correlationId: "direct-short:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: "用gh", scope_description: "GitHub repositories must use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "tier1_direct", `short directive should still direct-write, got ${JSON.stringify(outcome)}`);
  assert(outcome.result.status === "created", `short directive should create via padded body, got ${JSON.stringify(outcome.result)}`);
  assert(fs.readFileSync(outcome.result.path, "utf-8").includes("GitHub repositories must use gh"), "padded body must include scope description");
});

await check("S11: Tier-1 direct dedups restated global rule", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s11");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: quote, kind: "preference", injectMode: "always", scope: "global", entryConfidence: 8, routingConfidence: 0.9, routingReason: "seed", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "direct-dedup",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: null,
    correlationId: "direct-dedup:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "tier1_direct", `dedup should still be direct, got ${JSON.stringify(outcome)}`);
  assert(outcome.result.status === "deduped" && outcome.result.reason?.startsWith("semantic_duplicate"), `direct restatement should dedup, got ${JSON.stringify(outcome.result)}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const direct = rows.find((row) => row.operation === "tier1_direct_write");
  assert(direct?.signal_consumed === true, `deduped direct result should be safely consumed: ${JSON.stringify(direct)}`);
});

await check("S12: non-Tier-1 signals fall through to extractor path", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s12");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "non-tier1",
    settings: baseSettings,
    window: makeRunWindow(),
    modelRegistry: makeModelRegistry(),
    correlationId: "non-tier1:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: "README says always use yarn", target_entry_slug: null, provenance: "content-in-transcript", quote_source: "transcript_content" },
  });
  assert(outcome.kind === "llm_skip", `non-Tier-1 should use extractor path and skip, got ${JSON.stringify(outcome)}`);
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 1, `non-Tier-1 path should invoke extractor once, got ${globalThis.__ADR0028_PR1_INVOCATIONS__}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  assert(!rows.some((row) => row.operation === "tier1_direct_write" || row.operation === "tier1_shadow_decision"), `non-Tier-1 must not direct/shadow: ${JSON.stringify(rows)}`);
});

await check("S13: direct path runs before model registry gate", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s13");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "direct-no-model-registry",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: undefined,
    correlationId: "direct-no-model-registry:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "tier1_direct", `direct path must bypass model registry gate, got ${JSON.stringify(outcome)}`);
});

await check("S14: direct path preserves deterministic provenance in rule markdown", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s14");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "direct-provenance",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: null,
    correlationId: "direct-provenance:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "tier1_direct", `direct expected, got ${JSON.stringify(outcome)}`);
  const raw = fs.readFileSync(outcome.result.path, "utf-8");
  assert(/provenance:\s*"?user-expressed"?/.test(raw), `rule markdown must preserve user-expressed provenance: ${raw}`);
});

await check("S15: R4 outcome edge contests contradicted injected rule", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s15");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "abc123" });
  await _applyRuleOutcomeEdgeForTests({
    cwd: fx.root,
    abrainHome: fx.abrainHome,
    settings: baseSettings,
    sessionId: "r4-contradict",
    rows: [{
      ts: new Date().toISOString(),
      session_id: "r4-contradict",
      entry_slug: "github-repos-use-gh",
      source: "memory-footnote",
      event_id: "footnote:github-repos-use-gh:test",
      used: "retrieved-unused",
      counterfactual: "This contradicted the injected rule; it was wrong for this task.",
      retrieval_count: 1,
    }],
  });
  const raw = fs.readFileSync(path.join(fx.abrainHome, "rules", "always", "github-repos-use-gh.md"), "utf-8");
  assert(/status:\s*"?contested"?/.test(raw), `R4 should mark rule contested: ${raw}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const edge = rows.find((row) => row.operation === "rule_outcome_edge");
  assert(edge?.edge === "CONTRADICT" && edge?.status_mutation === "status_to_contested", `R4 audit row wrong: ${JSON.stringify(rows)}`);
  const ledger = readJsonl(ruleEdgeLedgerPath(fx));
  assert(ledger.length === 1 && ledger[0].edge === "CONTRADICT" && ledger[0].rule_slug === "github-repos-use-gh" && ledger[0].injection_nonce === "abc123", `CONTRADICT must land in edge ledger: ${JSON.stringify(ledger)}`);
  assert(ledger[0].status_mutation === "status_to_contested" && ledger[0].evidence_source === "self_report", `CONTRADICT ledger row must carry mutation result + evidence source: ${JSON.stringify(ledger)}`);
});

await check("S16: R4' protocol-filler confirmatory (相同决定) is deducted, not confirmed", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "def456" });
  await _applyRuleOutcomeEdgeForTests({
    cwd: fx.root,
    abrainHome: fx.abrainHome,
    settings: baseSettings,
    sessionId: "r4-confirm",
    rows: [{
      ts: new Date().toISOString(),
      session_id: "r4-confirm",
      entry_slug: "github-repos-use-gh",
      source: "memory-footnote",
      event_id: "footnote:github-repos-use-gh:confirm",
      used: "confirmatory",
      counterfactual: "相同决定",
      retrieval_count: 1,
    }],
  });
  const raw = fs.readFileSync(path.join(fx.abrainHome, "rules", "always", "github-repos-use-gh.md"), "utf-8");
  assert(/status:\s*"?active"?/.test(raw), `MATCH path must leave rule active (no status mutation): ${raw}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const edge = rows.find((row) => row.operation === "rule_outcome_edge");
  assert(edge?.edge === "MATCH" && edge?.match_applied === false && edge?.deduct_reason === "counterfactual_claims_no_difference", `filler counterfactual must be deducted: ${JSON.stringify(rows)}`);
  assert(readJsonl(ruleEdgeLedgerPath(fx)).length === 0, "deducted filler must NOT land in edge ledger");
});

await check("S16b: R4' self-echo deduction — parroted rule text never confirms", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16b");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const body = "所有 GitHub 仓库必须使用 gh 工具管理。";
  await writeAbrainRule(
    { title: "GitHub repos use gh", body, kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "echo1" });
  await _applyRuleOutcomeEdgeForTests({
    cwd: fx.root,
    abrainHome: fx.abrainHome,
    settings: baseSettings,
    sessionId: "r4-echo",
    rows: [{
      ts: new Date().toISOString(),
      session_id: "r4-echo",
      entry_slug: "github-repos-use-gh",
      source: "memory-footnote",
      event_id: "footnote:github-repos-use-gh:echo",
      used: "confirmatory",
      counterfactual: body,
      retrieval_count: 1,
    }],
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const edge = rows.find((row) => row.operation === "rule_outcome_edge");
  assert(edge?.edge === "MATCH" && edge?.match_applied === false && edge?.deduct_reason === "echo_of_injected_text", `echo must be deducted in audit: ${JSON.stringify(rows)}`);
  const ledger = readJsonl(ruleEdgeLedgerPath(fx));
  assert(ledger.length === 0, `deducted echo must NOT land in edge ledger: ${JSON.stringify(ledger)}`);
});

await check("S16c: R4' missing counterfactual carries no independent evidence", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16c");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "nocf1" });
  await _applyRuleOutcomeEdgeForTests({
    cwd: fx.root,
    abrainHome: fx.abrainHome,
    settings: baseSettings,
    sessionId: "r4-nocf",
    rows: [{
      ts: new Date().toISOString(),
      session_id: "r4-nocf",
      entry_slug: "github-repos-use-gh",
      source: "memory-footnote",
      event_id: "footnote:github-repos-use-gh:nocf",
      used: "confirmatory",
      retrieval_count: 1,
    }],
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const edge = rows.find((row) => row.operation === "rule_outcome_edge");
  assert(edge?.match_applied === false && edge?.deduct_reason === "missing_counterfactual", `missing counterfactual must be deducted: ${JSON.stringify(rows)}`);
  assert(readJsonl(ruleEdgeLedgerPath(fx)).length === 0, "no-evidence MATCH must not land in edge ledger");
});

await check("S16d: R4' tool-result retrieval of injected rule is self-echo by construction", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16d");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "tool1" });
  await _applyRuleOutcomeEdgeForTests({
    cwd: fx.root,
    abrainHome: fx.abrainHome,
    settings: baseSettings,
    sessionId: "r4-tool",
    rows: [{
      ts: new Date().toISOString(),
      session_id: "r4-tool",
      entry_slug: "github-repos-use-gh",
      source: "tool-result",
      event_id: "tool:github-repos-use-gh:1",
      retrieval_count: 3,
    }],
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  assert(!rows.some((row) => row.operation === "rule_outcome_edge"), `tool-result row must produce no edge at all: ${JSON.stringify(rows)}`);
  assert(readJsonl(ruleEdgeLedgerPath(fx)).length === 0, "tool-result row must not land in edge ledger");
});

await check("S16e: R4' edge ledger dedups repeated agent_end scans by event_id", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16e");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "dedup1" });
  const row = {
    ts: new Date().toISOString(),
    session_id: "r4-dedup",
    entry_slug: "github-repos-use-gh",
    source: "memory-footnote",
    event_id: "footnote:github-repos-use-gh:dedup",
    used: "confirmatory",
    counterfactual: "即使没有这条规则我也会选 gh：仓库 CI 脚本全部基于 gh 实现，独立判断一致。",
    retrieval_count: 1,
  };
  const callArgs = { cwd: fx.root, abrainHome: fx.abrainHome, settings: baseSettings, sessionId: "r4-dedup", rows: [row] };
  await _applyRuleOutcomeEdgeForTests(callArgs);
  await _applyRuleOutcomeEdgeForTests(callArgs);
  const ledger = readJsonl(ruleEdgeLedgerPath(fx));
  assert(ledger.length === 1 && ledger[0].edge === "MATCH" && ledger[0].evidence_source === "self_report", `substantive confirmatory must survive once: ${JSON.stringify(ledger)}`);
});

await check("S16f: R4' decisive on injected rule is injection compliance, not confirmation", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16f");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "compliance1" });
  await _applyRuleOutcomeEdgeForTests({
    cwd: fx.root,
    abrainHome: fx.abrainHome,
    settings: baseSettings,
    sessionId: "r4-compliance",
    rows: [{
      ts: new Date().toISOString(),
      session_id: "r4-compliance",
      entry_slug: "github-repos-use-gh",
      source: "memory-footnote",
      event_id: "footnote:github-repos-use-gh:compliance",
      used: "decisive",
      counterfactual: "没有这条规则我会直接用 curl 调 REST API。",
      retrieval_count: 1,
    }],
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const edge = rows.find((row) => row.operation === "rule_outcome_edge");
  assert(edge?.match_applied === false && edge?.deduct_reason === "injection_compliance", `decisive must be deducted as injection compliance: ${JSON.stringify(rows)}`);
  assert(readJsonl(ruleEdgeLedgerPath(fx)).length === 0, "injection compliance must not land in edge ledger");
});

await check("S16g: R4' user restatement of injected rule is the user-anchored MATCH", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16g");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: quote, kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "restate1" });
  const callArgs = {
    cwd: fx.root,
    sessionId: "r4-restate",
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
  };
  await _auditDirectiveRecallForTests(callArgs);
  await _auditDirectiveRecallForTests(callArgs);
  const ledger = readJsonl(ruleEdgeLedgerPath(fx));
  assert(ledger.length === 1 && ledger[0].edge === "MATCH" && ledger[0].evidence_source === "user_directive_restatement" && ledger[0].rule_slug === "github-repos-use-gh", `restatement must land once in edge ledger: ${JSON.stringify(ledger)}`);
  assert(ledger[0].outcome_event_id?.startsWith("restatement:github-repos-use-gh:"), `restatement event id wrong: ${JSON.stringify(ledger)}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const edges = rows.filter((row) => row.operation === "rule_outcome_edge");
  assert(edges.length === 1 && edges[0].evidence_source === "user_directive_restatement" && edges[0].keyed_on === "raw_user_role_transcript", `restatement audit must appear exactly once (delta-gated): ${JSON.stringify(edges)}`);
  assert(!rows.some((row) => row.operation === "directive_recall_audit"), `restated directive is not a recall gap: ${JSON.stringify(rows)}`);
});

await check("S16h: writeOutcomeLedger returns only the per-turn delta", async () => {
  const fx = freshFixture("pr1-s16h");
  const row = {
    ts: new Date().toISOString(),
    session_id: "delta-session",
    entry_slug: "some-entry",
    source: "memory-footnote",
    event_id: "footnote:some-entry:delta",
    used: "confirmatory",
    counterfactual: "独立理由。",
    retrieval_count: 1,
  };
  const first = writeOutcomeLedger([row], fx.root);
  const second = writeOutcomeLedger([row], fx.root);
  assert(Array.isArray(first) && first.length === 1, `first write must report 1 new row: ${JSON.stringify(first)}`);
  assert(Array.isArray(second) && second.length === 0, `rescan must report 0 new rows: ${JSON.stringify(second)}`);
});

await check("S17: R3 negative recall audits missing user imperative rule", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s17");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "r3missing" });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  await _auditDirectiveRecallForTests({
    cwd: fx.root,
    sessionId: "r3-missing",
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const recall = rows.find((row) => row.operation === "directive_recall_audit");
  assert(recall?.keyed_on === "raw_user_role_transcript", `R3 audit must key on raw transcript: ${JSON.stringify(rows)}`);
  assert(recall?.missing_rule_count === 1, `R3 audit should report one missing rule: ${JSON.stringify(recall)}`);
  assert(recall?.candidates?.[0]?.quote === quote, `R3 audit candidate quote wrong: ${JSON.stringify(recall)}`);
});

await check("S18: R3 negative recall suppresses when corresponding rule exists", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s18");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: quote, kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "r3covered" });
  await _auditDirectiveRecallForTests({
    cwd: fx.root,
    sessionId: "r3-covered",
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  assert(!rows.some((row) => row.operation === "directive_recall_audit"), `covered directive should not emit R3 audit: ${JSON.stringify(rows)}`);
});

await check("S19: real agent_end direct Tier-1 path writes then checkpoints", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s19");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  quietIfDueLanes(fx);
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    JSON.stringify({ signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" }),
  ]);
  const branch = [makeUserEntry("u1", quote)];
  const harness = makeAgentEndHarness(branch);
  sedimentIndex.default(harness.pi);
  await harness.fireAgentEnd(fx.root);
  await _waitForAutoWriteIdleForTests();

  const rulePath = path.join(fx.abrainHome, "rules", "always", "github-repos-use-gh.md");
  assert(fs.existsSync(rulePath), "real agent_end path must write global Tier-1 rule file");
  const checkpoint = JSON.parse(fs.readFileSync(sedimentCheckpointPath(fx.root), "utf-8"));
  assert(checkpoint.sessions?.["agent-end-session"]?.lastProcessedEntryId === "u1", `agent_end must checkpoint after write: ${JSON.stringify(checkpoint)}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const classifier = rows.find((row) => row.operation === "correction_classifier");
  const direct = rows.find((row) => row.operation === "tier1_direct_write");
  const auto = rows.find((row) => row.operation === "auto_write" && row.extractor === "active_correction_direct");
  assert(classifier?.ok === true && classifier?.staging_written === false && classifier?.staging_suppressed_reason === "tier1_direct_lane", `R6': Tier-1 signal must suppress the staging net when the direct lane is live: ${JSON.stringify(rows)}`);
  assert(direct?.deterministic_direct_path === true && direct?.signal_consumed === true, `real agent_end must direct-write: ${JSON.stringify(rows)}`);
  assert(auto?.checkpoint_advanced === true && auto?.background_async === true, `real agent_end audit must advance after write: ${JSON.stringify(rows)}`);
  assert(!rows.some((row) => row.operation === "directive_recall_audit"), `same-turn direct write must suppress R3 missing audit: ${JSON.stringify(rows)}`);
  // PR-A2 (F5): the Tier-1 hit no longer preempts the window — the extractor
  // follow-up runs over the same window (R1' disjoint authority), so the
  // main lane now spends exactly 2 LLM calls: classifier + extractor (stub
  // returns SKIP for call #2 → llm_skip outcome, advance still safe).
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 2, `with IfDue lanes quieted the direct path spends exactly 2 LLM calls (classifier + extractor follow-up), got ${globalThis.__ADR0028_PR1_INVOCATIONS__}`);
  const extractorSkip = rows.find((row) => row.operation === "skip" && row.reason === "llm_returned_skip");
  assert(extractorSkip?.background_async === true, `extractor follow-up must leave its own audit row: ${JSON.stringify(rows)}`);
});

await check("S20: R6' staging suppression requires live settings AND window ownership", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s20");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const correctionPipeline = await jiti.import(`${repoRoot}/extensions/sediment/correction-pipeline.ts`);
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  const classifierJson = JSON.stringify({ signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" });
  const win = makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`);

  // Degraded mode: the direct lane never runs, so the staging net MUST fire
  // even when the caller owns the window.
  resetPiAiStub([classifierJson]);
  const stagingOnly = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, autoLlmWriteEnabled: "staging-only" },
    modelRegistry: makeModelRegistry(),
    directLaneOwnsWindow: true,
  });
  assert(stagingOnly.ok === true && stagingOnly.escalateToCurator === true, `staging-only: Tier-1 predicate should still fire: ${JSON.stringify(stagingOnly)}`);
  assert(stagingOnly.stagingWritten === true && !stagingOnly.stagingSuppressedReason, `staging-only mode must keep the staging net: ${JSON.stringify(stagingOnly)}`);

  // Live settings but NOT window owner (explicit/about_me lane or in-flight
  // turn): the directive would otherwise survive only in volatile memory —
  // staging MUST keep firing (3-T0 P0 fix).
  resetPiAiStub([classifierJson]);
  const notOwner = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, autoLlmWriteEnabled: true },
    modelRegistry: makeModelRegistry(),
  });
  assert(notOwner.ok === true && notOwner.escalateToCurator === true, `non-owner: Tier-1 predicate should fire: ${JSON.stringify(notOwner)}`);
  assert(notOwner.stagingWritten === true && !notOwner.stagingSuppressedReason, `live settings WITHOUT window ownership must keep the staging net: ${JSON.stringify(notOwner)}`);

  // Live settings AND window owner: the same signal skips staging (R6').
  resetPiAiStub([classifierJson]);
  const live = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, autoLlmWriteEnabled: true },
    modelRegistry: makeModelRegistry(),
    directLaneOwnsWindow: true,
  });
  assert(live.ok === true && live.escalateToCurator === true, `live: Tier-1 predicate should fire: ${JSON.stringify(live)}`);
  assert(live.stagingWritten === false && live.stagingSuppressedReason === "tier1_direct_lane", `owned live direct lane must suppress the staging net: ${JSON.stringify(live)}`);
});

await check("S21: cross-turn mode flip parks a consumed Tier-1 signal in staging, never drops it", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s21");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "mode-flip",
    settings: { ...baseSettings, autoLlmWriteEnabled: "staging-only" },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: null,
    correlationId: "mode-flip:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "ineligible" && outcome.eligibility.reason === "auto_write_staging_only_mode", `staging-only must stay ineligible: ${JSON.stringify(outcome)}`);
  const stagingDir = path.join(fx.abrainHome, ".state", "sediment", "staging");
  const staged = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter((f) => f.endsWith(".json")) : [];
  assert(staged.length === 1, `consumed Tier-1 signal must be parked in staging: ${JSON.stringify(staged)}`);
  assert(fs.readFileSync(path.join(stagingDir, staged[0]), "utf-8").includes(quote), "staged entry must carry the verbatim quote");
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const capture = rows.find((row) => row.operation === "tier1_degraded_capture");
  assert(capture?.mode === "staging-only" && capture?.staging_written === true, `degraded capture must be audited: ${JSON.stringify(rows)}`);
});

await check("S22: tier1 checkpoint advance — captured/terminal advance, transient holds", async () => {
  const { _shouldAdvanceAfterAutoOutcomeForTests } = sedimentIndex;
  const mk = (status, reason) => ({ kind: "tier1_direct", draft: {}, result: { status, ...(reason ? { reason } : {}) }, writeStart: 0 });
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("created")) === true, "captured create must advance");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("deduped")) === true, "dedup must advance");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "validation_error_body")) === true, "terminal deterministic reject must advance (R3' recall flag is the net)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "git_commit_failed")) === false, "transient reject must HOLD the checkpoint");
});

await check("S23: F2 — deterministic Tier-1 rejects are terminal (advance), transients HOLD", async () => {
  // 2026-06-12 audit fix plan PR-A1 F2: duplicate_slug / lint_error /
  // kind_invalid reproduce identically every retry — HOLDing them burned one
  // classifier call per turn until the window scrolled (silent loss with only
  // the recall flag as trace). Terminal set now aligned with
  // shouldAdvanceAfterResults.
  const { _shouldAdvanceAfterAutoOutcomeForTests } = sedimentIndex;
  const mk = (status, reason) => ({ kind: "tier1_direct", draft: {}, result: { status, ...(reason ? { reason } : {}) }, writeStart: 0 });
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "duplicate_slug")) === true, "duplicate_slug must be terminal (advance)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "duplicate_slug_race")) === true, "duplicate_slug_race must be terminal (advance)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "lint_error")) === true, "lint_error must be terminal (advance)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "kind_invalid: not-a-kind")) === true, "kind_invalid must be terminal (advance)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "status_precondition_failed")) === true, "CAS precondition failure must be terminal (advance)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "git_commit_failed")) === false, "git_commit_failed stays transient (HOLD)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests(mk("rejected", "lock_timeout")) === false, "unknown/lock reasons stay transient (HOLD)");
});

await check("S24: F1 — unparseable classifier output is ok:false + parse_error, not a silent no-signal", async () => {
  const correctionPipeline = await jiti.import(`${repoRoot}/extensions/sediment/correction-pipeline.ts`);
  const { runCorrectionPipeline } = correctionPipeline;
  const fx = freshFixture("pr1-s24");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const mockRegistry = {
    find: (provider, id) => ({ provider, id }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "smoke-key" }),
  };
  // Garbage (non-JSON) classifier output — the prompt mandates strict JSON
  // even for no-correction windows, so this is a genuine parse failure.
  resetPiAiStub(["TOTALLY NOT JSON — the model rambled instead of emitting the schema."]);
  const garbage = await runCorrectionPipeline(
    [makeUserEntry("u1", "以后所有仓库都用 gh 管理。")],
    [],
    { settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry },
  );
  assert(garbage.ok === false, `parse failure must be ok:false, got ${JSON.stringify(garbage)}`);
  assert(garbage.parseError === true, `parse failure must set parseError, got ${JSON.stringify(garbage)}`);
  assert(String(garbage.error || "").includes("classifier_output_unparseable"), `error must name the failure class, got ${garbage.error}`);
  assert(garbage.signal === null && garbage.stagingWritten === false, "parse failure must not fabricate a signal or stage");
  // Legal JSON without the required signal_found boolean is also a schema
  // failure, not an implicit no-signal. This catches prompt key drift.
  resetPiAiStub(['```json\n{"reasoning": "no correction in window"}\n```']);
  const missingSignalFound = await runCorrectionPipeline(
    [makeUserEntry("u1", "以后所有仓库都用 gh 管理。")],
    [],
    { settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry },
  );
  assert(missingSignalFound.ok === false, `missing signal_found must be ok:false, got ${JSON.stringify(missingSignalFound)}`);
  assert(missingSignalFound.parseError === true, `missing signal_found must set parseError, got ${JSON.stringify(missingSignalFound)}`);
  assert(String(missingSignalFound.error || "").includes("classifier_output_unparseable"), `missing signal_found must use parse failure class, got ${missingSignalFound.error}`);
  assert(missingSignalFound.signal === null && missingSignalFound.stagingWritten === false, "missing signal_found must not fabricate a no-signal or stage");
  resetPiAiStub(['```json\n{"signal_found": "false", "reasoning": "no correction in window"}\n```']);
  const nonBooleanSignalFound = await runCorrectionPipeline(
    [makeUserEntry("u1", "以后所有仓库都用 gh 管理。")],
    [],
    { settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry },
  );
  assert(nonBooleanSignalFound.ok === false, `non-boolean signal_found must be ok:false, got ${JSON.stringify(nonBooleanSignalFound)}`);
  assert(nonBooleanSignalFound.parseError === true, `non-boolean signal_found must set parseError, got ${JSON.stringify(nonBooleanSignalFound)}`);
  assert(nonBooleanSignalFound.signal === null && nonBooleanSignalFound.stagingWritten === false, "non-boolean signal_found must not fabricate a no-signal or stage");
  // Control: a valid no-signal JSON stays ok:true WITHOUT parseError.
  resetPiAiStub(['```json\n{"signal_found": false, "reasoning": "no correction in window"}\n```']);
  const noSignal = await runCorrectionPipeline(
    [makeUserEntry("u1", "帮我看看这个函数。")],
    [],
    { settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry },
  );
  assert(noSignal.ok === true && noSignal.parseError === undefined, `valid no-signal must stay ok:true without parseError, got ${JSON.stringify(noSignal)}`);
  assert(noSignal.signal?.signal_found === false, "valid no-signal must carry the parsed signal");
});

await check("S25: F3/F4 — recall-audit lane coverage + drain tell call sites are pinned in source", async () => {
  // Static source pin (ADR 0025 §6.1 Tier-1 mechanical assertion): the F3/F4
  // fixes are call-site additions inside the agent_end closure — not reachable
  // from a cheap unit harness — so pin their presence structurally. If a
  // refactor legitimately moves them, update the expected counts here.
  const src = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "index.ts"), "utf-8");
  const recallCalls = (src.match(/await auditDirectiveRecall\(\{/g) || []).length;
  // 5 lanes: main bg + short escalation + short no-signal advance (F3a) +
  // drain + explicit/about_me combined (F3b/c).
  assert(recallCalls === 5, `expected 5 auditDirectiveRecall call sites (main/short-esc/short-no-signal/drain/explicit+about_me), got ${recallCalls}`);
  // Count call sites (total occurrences minus the function definition); the
  // main-bg site spreads the call across lines so a `notify(formatRuleTell(`
  // joint regex would undercount.
  const tellCalls = (src.match(/formatRuleTell\(/g) || []).length - 1;
  // 5 tell surfaces: self-report contested demote + short lane + main bg lane
  // + drain (F4) + stance-flip contested demote (PR-B2 F8).
  assert(tellCalls === 5, `expected 5 formatRuleTell call sites (contested/short/main/drain/stance-flip), got ${tellCalls}`);
});

await check("S26: F1 convergence — staging-only + classifier parse failure HOLDs the main-lane checkpoint", async () => {
  // 3×T0 R1 gpt-5.5 BLOCKING fix: in staging-only mode an ineligible lane +
  // parse failure means NOTHING ran over the window (no extractor / no Tier-1
  // / no staging) — advancing would permanently skip it on a transient fault.
  const { _holdForStagingOnlyParseFailureForTests } = sedimentIndex;
  const ineligible = { kind: "ineligible", eligibility: { eligible: false, reason: "auto_write_staging_only_mode" } };
  const parseFail = { ok: false, signal: null, parseError: true };
  const stagingOnly = { ...baseSettings, autoLlmWriteEnabled: "staging-only" };
  assert(_holdForStagingOnlyParseFailureForTests(ineligible, parseFail, stagingOnly) === true, "staging-only + parse failure + ineligible must HOLD");
  assert(_holdForStagingOnlyParseFailureForTests(ineligible, parseFail, baseSettings) === false, "true mode must not hold (extractor + recall net applies)");
  assert(_holdForStagingOnlyParseFailureForTests(ineligible, { ok: true, signal: { signal_found: false } }, stagingOnly) === false, "clean no-signal must not hold");
  assert(_holdForStagingOnlyParseFailureForTests(ineligible, null, stagingOnly) === false, "absent classifier result must not hold");
  assert(_holdForStagingOnlyParseFailureForTests({ kind: "wrote", results: [] }, parseFail, stagingOnly) === false, "non-ineligible outcomes keep their own advance semantics");
});

await check("S27: PR-A2 — Tier-1 hit no longer preempts the window; extractor follow-up runs (R1' disjoint authority)", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s27");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "followup",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}\n另外这个项目的构建用了自定义 esbuild 插件。`),
    modelRegistry: makeModelRegistry(),
    correlationId: "followup:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    tier1ExtractorFollowUp: true,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message", is_directive: true },
  });
  // The outcome is now the EXTRACTOR pass (stub returns SKIP → llm_skip),
  // with the Tier-1 write attached as the `tier1` prefix.
  assert(outcome.kind === "llm_skip", `extractor follow-up outcome expected (llm_skip), got ${outcome.kind}`);
  assert(outcome.tier1?.result?.status === "created", `tier1 prefix must carry the directive write, got ${JSON.stringify(outcome.tier1?.result)}`);
  // gpt-5.5 R1 nit: exact count pins "no classifier ran, exactly one
  // extractor follow-up" — correctionSignal was passed directly.
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 1, `extractor follow-up must run exactly once, got ${globalThis.__ADR0028_PR1_INVOCATIONS__} invocations`);
  assert(fs.existsSync(path.join(fx.abrainHome, "rules", "always", "github-repos-use-gh.md")), "Tier-1 rule file must still be written");
  // Opt-out path (short classifier-only lane semantics): no follow-up arg →
  // pure tier1_direct, zero LLM calls.
  _resetAutoWriteStateForTests();
  const fx2 = freshFixture("pr1-s27b");
  await bindAbrainProject({ abrainHome: fx2.abrainHome, cwd: fx2.root, projectId: fx2.projectId });
  resetPiAiStub(["SKIP"]);
  const pure = await _tryAutoWriteLaneForTests({
    cwd: fx2.root,
    sessionId: "followup-optout",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "followup-optout:auto",
    abrainHome: fx2.abrainHome,
    projectId: fx2.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message", is_directive: true },
  });
  assert(pure.kind === "tier1_direct", `opt-out must stay pure tier1_direct, got ${pure.kind}`);
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 0, `opt-out path must not burn the extractor, got ${globalThis.__ADR0028_PR1_INVOCATIONS__}`);
});

await check("S28: PR-A2 — combined advance semantics: BOTH tier1 and extractor outcome must be settle-safe", async () => {
  const { _shouldAdvanceAfterAutoOutcomeForTests } = sedimentIndex;
  const t1ok = { draft: {}, result: { status: "created" }, writeStart: 0, signal: {} };
  const t1transient = { draft: {}, result: { status: "rejected", reason: "git_commit_failed" }, writeStart: 0, signal: {} };
  const t1terminal = { draft: {}, result: { status: "rejected", reason: "duplicate_slug" }, writeStart: 0, signal: {} };
  assert(_shouldAdvanceAfterAutoOutcomeForTests({ kind: "llm_skip", tier1: t1ok }) === true, "captured tier1 + llm_skip must advance");
  assert(_shouldAdvanceAfterAutoOutcomeForTests({ kind: "llm_error", tier1: t1ok }) === false, "captured tier1 + transient extractor error must HOLD");
  assert(_shouldAdvanceAfterAutoOutcomeForTests({ kind: "llm_skip", tier1: t1transient }) === false, "transient tier1 reject must HOLD even when extractor skipped");
  assert(_shouldAdvanceAfterAutoOutcomeForTests({ kind: "llm_skip", tier1: t1terminal }) === true, "terminal tier1 reject + llm_skip must advance (recall flag is the net)");
  assert(_shouldAdvanceAfterAutoOutcomeForTests({ kind: "wrote", results: [{ status: "created" }], tier1: t1ok }) === true, "captured tier1 + captured extractor write must advance");
});

await check("S29: PR-A3 — targeted directive commits as rule; follow-up curator gets the signal as context; no double commit", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s29");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "以后所有项目用 bun 不用 pnpm。";
  const targetedSignal = { signal_found: true, typing: "durable", confidence: 7, is_directive: true, user_quote: quote, scope_description: "all projects use bun", target_entry_slug: "project-uses-pnpm", correction_intent: "supersede", provenance: "user-expressed", quote_source: "user_message" };
  // Extractor emits a draft, memory_search selects the just-created rule
  // neighbor, and the follow-up reaches the curator; curator skips.
  resetPiAiStub([
    "MEMORY:\ntitle: 项目包管理器偏好\nkind: preference\nconfidence: 5\n---\n# 项目包管理器偏好\n\n用户现在用 bun。这条记录包管理器选择。\nEND_MEMORY",
    '[{"slug":"all-projects-use-bun","reason":"new Tier-1 rule is the relevant neighbor"}]',
    '{"relevance_verdict":"has_relevant","picks":[{"slug":"all-projects-use-bun","score":1,"why":"rule covers the directive"}]}',
    '{"op": "skip", "reason": "rule already covers it"}',
  ]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "targeted",
    settings: baseSettings,
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "targeted:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    tier1ExtractorFollowUp: true,
    correctionSignal: targetedSignal,
  });
  // (a) targeted directive commits deterministically as a rule.
  assert(outcome.tier1?.result?.status === "created", `targeted directive must direct-create a rule, got ${JSON.stringify(outcome.tier1?.result ?? outcome)}`);
  // (b) follow-up curator received the correction signal as context.
  const prompts = globalThis.__ADR0028_PR1_PROMPTS__ || [];
  const curatorPrompt = prompts.find((p) => p.includes("=== ACTIVE CORRECTION SIGNAL ==="));
  assert(curatorPrompt && curatorPrompt.includes(quote), `follow-up curator must see the correction context, prompts=${prompts.length}`);
  // No double commit: exactly ONE tier1_direct_write audit row.
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const directRows = rows.filter((row) => row.operation === "tier1_direct_write");
  assert(directRows.length === 1, `follow-up re-entry must NOT produce a second tier1_direct_write, got ${directRows.length}`);
  // (C4) targeted dimension lands in audit.
  assert(directRows[0]?.correction_signal?.target_entry_slug === "project-uses-pnpm", `tier1_direct_write must carry the target dimension: ${JSON.stringify(directRows[0]?.correction_signal)}`);
  // (e, opus NIT-2) curator skipped the targeted entry → outer auto_write row
  // must surface target_entry_touched=false (the dual-expression drift probe).
  // NOTE: the lane test hook doesn't run the caller-side audit block — assert
  // via the outcome shape instead: follow-up wrote nothing touching the target.
  const touched = outcome.kind === "wrote" && outcome.results.some((r) => r.slug === "project-uses-pnpm");
  assert(touched === false, `curator skip must leave the targeted entry untouched: ${JSON.stringify(outcome.kind === "wrote" ? outcome.results : outcome.kind)}`);
});

await check("S30: PR-A3 — staging capture net extends to targeted Tier-1 in non-owning windows", async () => {
  const correctionPipeline = await jiti.import(`${repoRoot}/extensions/sediment/correction-pipeline.ts`);
  const fx = freshFixture("pr1-s30");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "以后所有项目用 bun 不用 pnpm。";
  const classifierJson = JSON.stringify({ signal_found: true, typing: "durable", confidence: 7, is_directive: true, user_quote: quote, scope_description: "all projects use bun", target_entry_slug: "project-uses-pnpm", provenance: "user-expressed", quote_source: "user_message" });
  const win = makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`);
  const mockRegistry = { find: (p, i) => ({ p, i }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) };
  // (f) non-owning window (no directLaneOwnsWindow): targeted Tier-1 gets the
  // staging net — previously it survived only in the volatile working set.
  resetPiAiStub([classifierJson]);
  const notOwner = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry,
  });
  assert(notOwner.escalateToCurator === true, `targeted directive must be Tier-1: ${JSON.stringify(notOwner.signal)}`);
  assert(notOwner.stagingWritten === true, `non-owning window must stage the targeted Tier-1 directive: ${JSON.stringify(notOwner)}`);
  // Owning window: suppressed like no-target Tier-1.
  resetPiAiStub([classifierJson]);
  const owner = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry, directLaneOwnsWindow: true,
  });
  assert(owner.stagingWritten === false && owner.stagingSuppressedReason === "tier1_direct_lane", `owning window suppresses staging: ${JSON.stringify(owner)}`);
  // Targeted NON-directive durable stays un-staged (attributed → curator path).
  resetPiAiStub([JSON.stringify({ signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "x", target_entry_slug: "project-uses-pnpm", provenance: "user-expressed", quote_source: "user_message" })]);
  const nonDirective = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, classifierModel: "mock/classifier" }, modelRegistry: mockRegistry,
  });
  assert(nonDirective.escalateToCurator !== true, "targeted conf9 non-directive must NOT be Tier-1 (A.3.1 boundary)");
  assert(nonDirective.stagingWritten === false, `targeted non-directive stays un-staged (curator advisory path): ${JSON.stringify(nonDirective)}`);
  // (deepseek R1) staging-only mode: the direct lane never runs — staging is
  // the ONLY capture path for targeted Tier-1 directives too.
  resetPiAiStub([classifierJson]);
  const stagingOnly = await correctionPipeline.runCorrectionPipeline(win.entries, [], {
    settings: { ...baseSettings, autoLlmWriteEnabled: "staging-only", classifierModel: "mock/classifier" }, modelRegistry: mockRegistry, directLaneOwnsWindow: true,
  });
  assert(stagingOnly.escalateToCurator === true && stagingOnly.stagingWritten === true && !stagingOnly.stagingSuppressedReason, `staging-only mode must stage the targeted Tier-1 directive: ${JSON.stringify(stagingOnly)}`);
  // (NIT-1) attribution fidelity: the staged file must carry target_entry_slug.
  const stagingDir = path.join(fx.abrainHome, ".state", "sediment", "staging");
  const stagedFiles = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter((f) => f.endsWith(".json")) : [];
  assert(stagedFiles.length > 0, "staging files must exist");
  const stagedWithTarget = stagedFiles.some((f) => {
    const doc = JSON.parse(fs.readFileSync(path.join(stagingDir, f), "utf-8"));
    return doc?.entry?.correction_signal?.target_entry_slug === "project-uses-pnpm";
  });
  assert(stagedWithTarget, "staged targeted directive must preserve target_entry_slug (NIT-1 attribution fidelity)");
});

await check("S31: PR-B1 — empty-reviewer advisory predicate + Jaccard shadow flip-readiness watchdog", async () => {
  const { shouldWarnUnconfiguredReviewers } = sedimentIndex;
  // Advisory predicate: live pipeline + empty reviewers → warn once.
  assert(shouldWarnUnconfiguredReviewers({ ...baseSettings, autoLlmWriteEnabled: true, multiView: { ...baseSettings.multiView, reviewerProviders: [] } }) === true, "live + empty reviewers must warn");
  assert(shouldWarnUnconfiguredReviewers({ ...baseSettings, autoLlmWriteEnabled: true, multiView: { ...baseSettings.multiView, reviewerProviders: ["a/x"] } }) === false, "configured reviewers must not warn");
  assert(shouldWarnUnconfiguredReviewers({ ...baseSettings, autoLlmWriteEnabled: "staging-only", multiView: { ...baseSettings.multiView, reviewerProviders: [] } }) === false, "staging-only mode must not warn (pipeline not live)");
  // Watchdog flip-readiness: feed tier1_jaccard_shadow rows into audit and scan.
  const aggregator = await jiti.import(`${repoRoot}/extensions/sediment/aggregator.ts`);
  const fx = freshFixture("pr1-s31");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const auditPath = sedimentAuditPath(fx.root);
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const ts = new Date().toISOString();
  const oldTs = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = [];
  for (let i = 0; i < 49; i++) rows.push(JSON.stringify({ timestamp: ts, operation: "tier1_jaccard_shadow", shadow_ok: true, would_decision: "update" }));
  rows.push(JSON.stringify({ timestamp: ts, operation: "tier1_jaccard_shadow", shadow_ok: true, would_decision: "create" }));
  // 盲审收敛 (opus BUG-2 / gpt BLOCKING): error 行不得稀释份额或灌满样本门。
  for (let i = 0; i < 60; i++) rows.push(JSON.stringify({ timestamp: ts, operation: "tier1_jaccard_shadow", shadow_ok: false, shadow_error: "adjudicator_failed" }));
  // gpt #5: 窗口外旧行不计入证据。
  for (let i = 0; i < 30; i++) rows.push(JSON.stringify({ timestamp: oldTs, operation: "tier1_jaccard_shadow", shadow_ok: true, would_decision: "create" }));
  fs.writeFileSync(auditPath, rows.join("\n") + "\n", "utf-8");
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 生产同款 30 天窗口
  const signals = aggregator._scanP15WatchdogSignalsForTests
    ? aggregator._scanP15WatchdogSignalsForTests(fx.root, cutoffMs, 5000, new Date())
    : null;
  assert(signals, "watchdog scan test export must exist");
  const shadow = signals.tier1_jaccard_shadow;
  assert(shadow.total === 110, `expected 110 in-window shadow rows (50 adjudicated + 60 error; 30 old excluded), got ${shadow.total}`);
  assert(shadow.adjudicated_total === 50, `adjudicated_total must exclude error + out-of-window rows, got ${shadow.adjudicated_total}`);
  assert(shadow.shadow_error_count === 60, `shadow_error_count wrong: ${shadow.shadow_error_count}`);
  assert(shadow.would_decision_breakdown.create === 1 && shadow.would_decision_breakdown.update === 49, `breakdown wrong: ${JSON.stringify(shadow.would_decision_breakdown)}`);
  // 1/50 = 2% false-merge ≤ 5% ∧ adjudicated ≥ 50 → flip ready；60 条 error
  // 行既不稀释份额也不计入样本门。
  assert(shadow.false_merge_share === 0.02, `share must be computed over adjudicated rows only: ${shadow.false_merge_share}`);
  assert(shadow.flip_ready === true, `flip_ready expected at 50 adjudicated / 2% create: ${JSON.stringify(shadow)}`);
  // 反例：只有 error 行时绝不 flip_ready（旧算法给 share=0 且 ready=true）。
  fs.writeFileSync(auditPath, Array.from({ length: 60 }, () => JSON.stringify({ timestamp: ts, operation: "tier1_jaccard_shadow", shadow_ok: false, shadow_error: "x" })).join("\n") + "\n", "utf-8");
  const errOnly = aggregator._scanP15WatchdogSignalsForTests(fx.root, cutoffMs, 5000, new Date()).tier1_jaccard_shadow;
  assert(errOnly.adjudicated_total === 0 && errOnly.flip_ready === false, `error-only window must never be flip_ready: ${JSON.stringify(errOnly)}`);
});

await check("S32: PR-B2 — stance-flip reversal is CONTRADICT (user-anchored strong demote), not MATCH, and keeps the recall flag", async () => {
  _resetAutoWriteStateForTests();
  const { _directiveStanceFlippedForTests } = sedimentIndex;
  // F9 unit: B5 pnpm/yarn archetype — high overlap, flipped key token.
  assert(_directiveStanceFlippedForTests("以后所有项目统一用 bun 不用 pnpm 管理依赖。", "所有项目统一用 pnpm 管理依赖。") === true, "反转（不用 pnpm vs 用 pnpm）必须判 flip");
  assert(_directiveStanceFlippedForTests("所有项目统一用 pnpm 管理依赖。", "所有项目统一用 pnpm 管理依赖。") === false, "纯复述不是 flip");
  assert(_directiveStanceFlippedForTests("现在可以用 yarn 了。", "不要用 yarn。") === true, "解禁（用 yarn vs 不要用 yarn）必须判 flip");
  assert(_directiveStanceFlippedForTests("这个函数怎么用？", "所有项目用 pnpm。") === false, "无 stance 对象的句子 fail-open 为非 flip");
  // R1 盲审收敛（fable BLOCKING-1 / gpt #1）：否定表补齐后，重申不再被
  // 裸「用」倒置为 endorsement → 不误判 flip。
  assert(_directiveStanceFlippedForTests("对，避免用 yarn，统一用 pnpm。", "禁止用 yarn，统一用 pnpm。") === false, "重申（避免用 yarn vs 禁止用 yarn）不是 flip");
  assert(_directiveStanceFlippedForTests("以后都不使用 pnpm。", "统一使用 pnpm。") === true, "不使用 必须进否定表");
  assert(_directiveStanceFlippedForTests("don’t use yarn anymore", "use yarn for all projects") === true, "curly apostrophe don’t 必须命中否定支");
  assert(_directiveStanceFlippedForTests("stop using pnpm.", "use pnpm everywhere") === true, "句尾 ASCII 句点不得粘在 token 上");
  assert(_directiveStanceFlippedForTests("because pnpm is broken we pause CI", "never use pnpm") === false, "because 的 use 尾不是 endorsement（词边界）");
  // R2 残留收敛（fable）：同义否定族——严禁/不应/不可/must not/shouldn't。
  assert(_directiveStanceFlippedForTests("对，所有项目严禁使用 yarn，统一用 pnpm。", "所有项目禁止使用 yarn，统一用 pnpm。") === false, "重申（严禁 vs 禁止）不是 flip");
  assert(_directiveStanceFlippedForTests("新代码不应该用 lodash。", "工具函数统一用 lodash。") === true, "不应该 必须进否定表");
  assert(_directiveStanceFlippedForTests("you must not use yarn here", "use yarn for all projects") === true, "must not use 必须命中否定支");
  assert(_directiveStanceFlippedForTests("we shouldn’t use yarn anymore", "use yarn for all projects") === true, "shouldn’t use 必须命中否定支");
  // F8 e2e: reversal → CONTRADICT 强 demote + recall flag，不计 MATCH。
  const fx = freshFixture("pr1-s32");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  // 长样板句（B5 形态）：共享样板必须占主导才能过 0.72 重叠门——这正是
  // F9 的隐患场景：重叠够高但 stance 翻转。
  const ruleBody = "所有项目统一用 pnpm 管理依赖，禁止混用包管理器，新项目初始化也统一走 pnpm 工作流模板。";
  await writeAbrainRule(
    // routingReason 复用正文句：scanRules 的 appliesWhen 回退到 routing_reason，
    // 使 ruleInjectedText 的 gram 集与引文重叠达标（模拟真实 tier1 规则的
    // applies_when 与正文同源形态）。
    { title: "Use pnpm", body: ruleBody, kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "所有项目统一用 pnpm 管理依赖", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "stanceflip" });
  // 单句（句号会被 directiveSentences 切分）且与 ruleInjectedText 的较小侧
  // gram 覆盖 ≥0.72（实测 0.80）：复用样板 + 翻转关键 token。
  const reversal = "所有项目统一用 bun 管理依赖，禁止混用包管理器，新项目初始化也统一走 bun 工作流模板，不用 pnpm";
  await _auditDirectiveRecallForTests({
    cwd: fx.root,
    sessionId: "stance-flip",
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${reversal}`),
    demote: { abrainHome: fx.abrainHome, settings: baseSettings },
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const contradictRow = rows.find((r) => r.operation === "rule_outcome_edge" && r.edge === "CONTRADICT" && r.evidence_source === "user_directive_stance_flip");
  assert(contradictRow?.rule_slug === "use-pnpm" && contradictRow?.keyed_on === "raw_user_role_transcript", `需要 user-anchored CONTRADICT 行: ${JSON.stringify(rows.filter((r) => r.operation === "rule_outcome_edge"))}`);
  assert(contradictRow?.status_mutation === "status_to_contested", `强 demote 必须生效: ${JSON.stringify(contradictRow)}`);
  assert(!rows.some((r) => r.operation === "rule_outcome_edge" && r.edge === "MATCH"), "反转绝不记 MATCH");
  const recall = rows.find((r) => r.operation === "directive_recall_audit");
  assert(recall?.candidates?.[0]?.reason === "user_role_imperative_reverses_injected_rule", `反转必须保留 recall flag（新指令尚无覆盖规则）: ${JSON.stringify(recall)}`);
  const ruleFile = fs.readFileSync(path.join(fx.abrainHome, "rules", "always", "use-pnpm.md"), "utf-8");
  assert(/status:\s*contested/.test(ruleFile), `规则文件必须落 contested: ${ruleFile.slice(0, 200)}`);
  // R1 收敛（fable M5 / gpt #3）：ledger 行本身必须携带 status_mutation（先
  // demote 后落账），消费者不需要 audit 文件即可区分“证据存在”与“demote 已执行”。
  const ledgerRows = readJsonl(ruleEdgeLedgerPath(fx)).filter((r) => r.evidence_source === "user_directive_stance_flip");
  assert(ledgerRows.length === 1 && ledgerRows[0].status_mutation === "status_to_contested", `ledger 行必须携带 status_mutation: ${JSON.stringify(ledgerRows)}`);
  // 同 session 重扫 dedup：不重复 demote/重复 ledger。
  await _auditDirectiveRecallForTests({
    cwd: fx.root,
    sessionId: "stance-flip",
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${reversal}`),
    demote: { abrainHome: fx.abrainHome, settings: baseSettings },
  });
  const contradictRows = readJsonl(sedimentAuditPath(fx.root)).filter((r) => r.operation === "rule_outcome_edge" && r.edge === "CONTRADICT");
  assert(contradictRows.length === 1, `同 session 重扫必须 dedup，得 ${contradictRows.length} 行`);
});

await check("S33: PR-B2 — same-turn covered reversal still demotes the stale rule (covered suppresses recall flag only)", async () => {
  // R1 盲审收敛（fable BLOCKING-2 / gpt #2）：主路径 B5 形态——用户说反转指令，
  // 同轮 tier1 已写新规则（coveredTexts 含该语句）。covered 只准压掩 recall
  // flag 与 MATCH，不得压掩对旧规则的 CONTRADICT 强 demote。
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s33");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const ruleBody = "所有项目统一用 pnpm 管理依赖，禁止混用包管理器，新项目初始化也统一走 pnpm 工作流模板。";
  await writeAbrainRule(
    { title: "Use pnpm", body: ruleBody, kind: "preference", injectMode: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "所有项目统一用 pnpm 管理依赖", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  _refreshRuleCacheForOutcomeEdgeTests({ abrainHome: fx.abrainHome, cwd: fx.root, nonce: "coveredflip" });
  const reversal = "所有项目统一用 bun 管理依赖，禁止混用包管理器，新项目初始化也统一走 bun 工作流模板，不用 pnpm";
  await _auditDirectiveRecallForTests({
    cwd: fx.root,
    sessionId: "covered-flip",
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${reversal}。`),
    coveredTexts: [reversal],
    demote: { abrainHome: fx.abrainHome, settings: baseSettings },
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const contradictRow = rows.find((r) => r.operation === "rule_outcome_edge" && r.edge === "CONTRADICT" && r.evidence_source === "user_directive_stance_flip");
  assert(contradictRow?.status_mutation === "status_to_contested", `covered 反转仍须强 demote 旧规则: ${JSON.stringify(rows.filter((r) => r.operation === "rule_outcome_edge"))}`);
  assert(!rows.some((r) => r.operation === "directive_recall_audit"), "同轮已覆盖 → 不报 recall 缺口");
  assert(!rows.some((r) => r.operation === "rule_outcome_edge" && r.edge === "MATCH"), "covered 反转绝不记 MATCH");
});

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${total} assertions (ADR 0028 PR1).`);
