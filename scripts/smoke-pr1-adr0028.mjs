#!/usr/bin/env node
/**
 * Smoke: ADR 0028 PR1 read-only rules neighbors + Tier-1 direct lane.
 *
 * Pins migration invariants:
 * 1. rules-as-neighbors are read-only context only;
 * 2. Tier-1 user-expressed durable directives write deterministically before LLM;
 * 3. non-Tier-1 signals still fall through to the legacy extractor path;
 * 4. R4 outcome contradictions can contest an injected rule deterministically;
 * 5. R3 negative recall audits user-role imperatives without corresponding rules.
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
    { title: "Global Glab", body: "git.alfadb.cn 仓库必须使用 glab 管理。", kind: "preference", tier: "always", scope: "global", entryConfidence: 8, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  await writeAbrainRule(
    { title: "Project Design First", body: "本项目每次先写设计再动代码。", kind: "decision", tier: "listed", scope: { projectId: fx.projectId }, entryConfidence: 7, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
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
  const decision = parseDecision(JSON.stringify({ op: "create", zone: "rules", tier: "always", rule_scope: "global", rationale: "new rule" }), new Map([["global-glab", "rules"]]));
  assert(decision.op === "create" && decision.zone === "rules" && decision.tier === "always" && decision.ruleScope === "global", `rules create should parse, got ${JSON.stringify(decision)}`);
});

await check("S5: curator prompt labels rule neighbors as READ-ONLY", async () => {
  const fx = freshFixture("pr1-s5");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "Global Glab", body: "git.alfadb.cn 仓库必须使用 glab 管理。", kind: "preference", tier: "always", scope: "global", entryConfidence: 8, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  const entries = loadReadonlyRuleNeighborEntries({ abrainHome: fx.abrainHome, cwd: fx.root });
  const prompt = buildCuratorPrompt({ title: "Glab duplicate", kind: "preference", status: "active", confidence: 8, compiledTruth: "git.alfadb.cn 仓库必须使用 glab 管理。" }, entries);
  assert(prompt.includes("scope: rules (READ-ONLY reference"), "prompt must mark rule neighbor scope as read-only");
  assert(prompt.includes("Do NOT target a rule slug"), "prompt must warn curator not to mutate rule neighbors");
});

await check("S6: schema exposes rules flag and removes Tier-1 shadow flag", async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf-8"));
  const props = schema.properties?.sediment?.properties ?? {};
  assert(props.rulesAsReadonlyNeighborsEnabled?.type === "boolean" && props.rulesAsReadonlyNeighborsEnabled?.default === false, "rulesAsReadonlyNeighborsEnabled schema missing/default wrong");
  assert(!Object.prototype.hasOwnProperty.call(props, "tier1ShadowEnabled"), "tier1ShadowEnabled schema flag must be removed");
});

await check("S7: settings resolver carries rules default and no shadow flag", async () => {
  assert(DEFAULT_SEDIMENT_SETTINGS.rulesAsReadonlyNeighborsEnabled === false, "rulesAsReadonlyNeighborsEnabled default must be false");
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
    { title: "GitHub repos use gh", body: quote, kind: "preference", tier: "always", scope: "global", entryConfidence: 8, routingConfidence: 0.9, routingReason: "seed", zone: "rules" },
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
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", tier: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
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
});

await check("S16: R4 outcome edge ignores non-contradictory footnotes", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "GitHub repos use gh", body: "所有 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", tier: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
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
  assert(/status:\s*"?active"?/.test(raw), `non-contradictory outcome must leave rule active: ${raw}`);
  const rows = readJsonl(sedimentAuditPath(fx.root));
  assert(!rows.some((row) => row.operation === "rule_outcome_edge"), `non-contradictory outcome must not write R4 audit row: ${JSON.stringify(rows)}`);
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
    { title: "GitHub repos use gh", body: quote, kind: "preference", tier: "always", scope: "global", entryConfidence: 9, routingConfidence: 1, routingReason: "smoke", zone: "rules" },
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
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    "[]",
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
  assert(classifier?.ok === true && classifier?.staging_written === true, `real agent_end must run classifier/staging: ${JSON.stringify(rows)}`);
  assert(direct?.deterministic_direct_path === true && direct?.signal_consumed === true, `real agent_end must direct-write: ${JSON.stringify(rows)}`);
  assert(auto?.checkpoint_advanced === true && auto?.background_async === true, `real agent_end audit must advance after write: ${JSON.stringify(rows)}`);
  assert(!rows.some((row) => row.operation === "directive_recall_audit"), `same-turn direct write must suppress R3 missing audit: ${JSON.stringify(rows)}`);
  assert(globalThis.__ADR0028_PR1_INVOCATIONS__ === 2, `direct path should only call pre-search + classifier, got ${globalThis.__ADR0028_PR1_INVOCATIONS__}`);
});

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${total} assertions (ADR 0028 PR1).`);
