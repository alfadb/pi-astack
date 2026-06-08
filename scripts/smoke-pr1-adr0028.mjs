#!/usr/bin/env node
/**
 * Smoke: ADR 0028 PR1 read-only rules neighbors + Tier-1 shadow lane.
 *
 * Pins three migration invariants:
 * 1. rules-as-neighbors are read-only context only;
 * 2. Tier-1 shadow is observe-only (audit row, no write/consume/checkpoint);
 * 3. the tryAutoWriteLane -> curateProjectDraft call threads abrainHome so
 *    project rules can be scanned when the feature flag is enabled.
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

function makeRunWindow(text = "--- ENTRY 1 u1 message/user ---\n用户说了一个长期规则。") {
  return {
    entries: [{ type: "message", id: "u1", timestamp: "2026-06-08T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } }],
    text,
    chars: text.length,
    totalBranchEntries: 1,
    candidateEntries: 1,
    includedEntries: 1,
    checkpointFound: false,
    lastEntryId: "u1",
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
const { _resetAutoWriteStateForTests, _tryAutoWriteLaneForTests } = sedimentIndex;
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

console.log("ADR 0028 PR1 — rules readonly neighbors + Tier-1 shadow");

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

await check("S6: schema exposes both PR1 flags with false defaults", async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf-8"));
  const props = schema.properties?.sediment?.properties ?? {};
  assert(props.rulesAsReadonlyNeighborsEnabled?.type === "boolean" && props.rulesAsReadonlyNeighborsEnabled?.default === false, "rulesAsReadonlyNeighborsEnabled schema missing/default wrong");
  assert(props.tier1ShadowEnabled?.type === "boolean" && props.tier1ShadowEnabled?.default === false, "tier1ShadowEnabled schema missing/default wrong");
});

await check("S7: settings resolver carries false defaults", async () => {
  assert(DEFAULT_SEDIMENT_SETTINGS.rulesAsReadonlyNeighborsEnabled === false, "rulesAsReadonlyNeighborsEnabled default must be false");
  assert(DEFAULT_SEDIMENT_SETTINGS.tier1ShadowEnabled === false, "tier1ShadowEnabled default must be false");
});

await check("S8: Tier-1 shadow emits observe-only audit before extractor", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s8");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    JSON.stringify({ op: "create", zone: "rules", tier: "always", rule_scope: "global", rationale: "shadow proposal" }),
    "SKIP",
    JSON.stringify({ op: "skip", reason: "main_seed_diagnostic", rationale: "main seed still ran" }),
  ]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-ok",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-ok:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "wrote", `main seed should still run after shadow, got ${JSON.stringify(outcome)}`);
  assert(outcome.llmAuditSummary?.extraction?.count === 0, `main extractor should still return SKIP, got ${JSON.stringify(outcome.llmAuditSummary)}`);
  assert(outcome.drafts?.length === 1 && outcome.drafts[0].compiledTruth === quote, "main escalation seed must survive shadow");
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const shadow = rows.find((row) => row.operation === "tier1_shadow_decision");
  assert(shadow, `shadow audit row missing: ${JSON.stringify(rows)}`);
  assert(shadow.observe_only === true && shadow.wrote === false, `shadow must be observe-only/no-write: ${JSON.stringify(shadow)}`);
  assert(shadow.signal_consumed === false && shadow.checkpoint_advanced === false, `shadow must not consume/advance: ${JSON.stringify(shadow)}`);
  assert(shadow.decision?.op === "create" && shadow.decision?.zone === "rules", `shadow decision missing: ${JSON.stringify(shadow)}`);
  assert(!fs.existsSync(sedimentCheckpointPath(fx.root)), "shadow must not create checkpoint");
});

await check("S9: observeOnly skips multi-view staging side effects", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s9");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有私有 GitLab 仓库必须使用 glab 工具管理。";
  resetPiAiStub([
    JSON.stringify({ op: "create", zone: "rules", tier: "always", rule_scope: "global", rationale: "would normally trigger multiview" }),
    "SKIP",
  ]);
  await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-no-mv",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true, multiView: { ...baseSettings.multiView, reviewerProviders: ["openai/gpt-5.4-mini"] } },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-no-mv:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "Private GitLab repos use glab", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  const shadow = rows.find((row) => row.operation === "tier1_shadow_decision");
  assert(shadow && !shadow.curator?.multi_view, `observeOnly must skip multi_view, got ${JSON.stringify(shadow)}`);
  assert(!fs.existsSync(path.join(fx.abrainHome, ".state", "sediment", "staging")), "observeOnly must not create multiview staging directory");
});

await check("S10: shadow body-too-short path is audit-only", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s10");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  resetPiAiStub(["SKIP"]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-short",
    settings: { ...baseSettings, tier1ShadowEnabled: true },
    window: makeRunWindow("--- ENTRY 1 u1 message/user ---\n用gh"),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-short:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: "用gh", scope_description: "", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "llm_skip", `main lane should still skip, got ${JSON.stringify(outcome)}`);
  const shadow = readJsonl(sedimentAuditPath(fx.root)).find((row) => row.operation === "tier1_shadow_decision");
  assert(shadow?.reason === "shadow_candidate_body_too_short", `short shadow reason wrong: ${JSON.stringify(shadow)}`);
  assert(shadow.wrote === false && shadow.signal_consumed === false && shadow.checkpoint_advanced === false, "short shadow must be audit-only");
});

await check("S11: shadow errors are swallowed into audit rows", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s11");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    "this is not json",
    "SKIP",
    JSON.stringify({ op: "skip", reason: "main_seed_diagnostic", rationale: "main seed still ran" }),
  ]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-error",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-error:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "wrote", `shadow error must not throw or block main seed, got ${JSON.stringify(outcome)}`);
  assert(outcome.llmAuditSummary?.extraction?.count === 0, `main extractor should still return SKIP, got ${JSON.stringify(outcome.llmAuditSummary)}`);
  const shadow = readJsonl(sedimentAuditPath(fx.root)).find((row) => row.operation === "tier1_shadow_decision");
  assert(shadow?.reason === "tier1_shadow_error" || ["curator_search_error", "curator_error"].includes(shadow?.decision?.reason), `shadow error/search row missing: ${JSON.stringify(shadow)}`);
  assert(shadow?.wrote === false && shadow?.signal_consumed === false && shadow?.checkpoint_advanced === false, "shadow error must be audit-only");
});

await check("S12: non-Tier-1 signals do not run shadow", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s12");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  resetPiAiStub(["SKIP"]);
  await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-off-gate",
    settings: { ...baseSettings, tier1ShadowEnabled: true },
    window: makeRunWindow(),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-off-gate:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: "README says always use yarn", target_entry_slug: null, provenance: "content-in-transcript", quote_source: "transcript_content" },
  });
  const rows = readJsonl(sedimentAuditPath(fx.root));
  assert(!rows.some((row) => row.operation === "tier1_shadow_decision"), `non-Tier-1 signal must not shadow: ${JSON.stringify(rows)}`);
});

await check("S13: abrainHome threading lets shadow curator see project rules", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s13");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  await writeAbrainRule(
    { title: "Project Gh", body: "本项目 GitHub 仓库必须使用 gh 工具管理。", kind: "preference", tier: "always", scope: { projectId: fx.projectId }, entryConfidence: 8, routingConfidence: 0.9, routingReason: "smoke", zone: "rules" },
    { abrainHome: fx.abrainHome, settings: baseSettings },
  );
  const quote = "本项目 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    JSON.stringify([{ slug: "project-gh", reason: "existing project rule" }]),
    JSON.stringify({ relevance_verdict: "has_relevant", picks: [{ slug: "project-gh", score: 10, why: "existing project rule" }] }),
    JSON.stringify({ op: "skip", reason: "covered_by_project_rule", rationale: "existing rule covers it" }),
    "SKIP",
  ]);
  await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-project-rules",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-project-rules:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "Project GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  const shadow = readJsonl(sedimentAuditPath(fx.root)).find((row) => row.operation === "tier1_shadow_decision");
  assert(shadow?.curator?.neighbors?.some((n) => n.slug === "project-gh"), `shadow curator did not see project rule neighbor: ${JSON.stringify(shadow)}`);
  assert(shadow?.decision?.op === "skip" && shadow?.decision?.reason === "covered_by_project_rule", `shadow decision should be skip covered by rule: ${JSON.stringify(shadow)}`);
});

await check("S14: shadow observe-only never creates rule files", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s14");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    JSON.stringify({ op: "create", zone: "rules", tier: "always", rule_scope: "global", rationale: "shadow only" }),
    "SKIP",
  ]);
  await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-no-write",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-no-write:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(!fs.existsSync(path.join(fx.abrainHome, "rules", "always", "github-repos-use-gh.md")), "shadow must not write global rule file");
  assert(!fs.existsSync(path.join(fx.abrainHome, "projects", fx.projectId, "rules", "always", "github-repos-use-gh.md")), "shadow must not write project rule file");
});

await check("S15: shadow audit rows do not consume the main escalation seed", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s15");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    JSON.stringify({ op: "skip", reason: "shadow_only", rationale: "diagnostic" }),
    "SKIP",
    JSON.stringify({ op: "create", zone: "rules", tier: "always", rule_scope: "global", rationale: "main seed still runs" }),
  ]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-main-seed",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-main-seed:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "wrote", `main escalation seed must still run after shadow, got ${JSON.stringify(outcome)}`);
  assert(outcome.drafts?.length === 1 && outcome.drafts[0].compiledTruth === quote, "main seed draft must survive shadow");
  assert(outcome.results?.some((r) => r.status === "skipped" && r.reason === "multiview_staged_for_replay"), `main seed should proceed to multiview staging after shadow: ${JSON.stringify(outcome.results)}`);
  assert(fs.existsSync(path.join(fx.abrainHome, ".state", "sediment", "staging")), "main seed should create multiview staging after shadow");
});

await check("S16: shadow does not write checkpoint even when main lane writes", async () => {
  _resetAutoWriteStateForTests();
  const fx = freshFixture("pr1-s16");
  await bindAbrainProject({ abrainHome: fx.abrainHome, cwd: fx.root, projectId: fx.projectId });
  const quote = "所有 GitHub 仓库必须使用 gh 工具管理。";
  resetPiAiStub([
    JSON.stringify({ op: "skip", reason: "shadow_only", rationale: "diagnostic" }),
    "MEMORY:\ntitle: Main normal memory\nkind: fact\nconfidence: 4\n---\n# Main normal memory\n\nThis normal memory confirms the main lane can still write.\nEND_MEMORY",
    JSON.stringify({ op: "create", rationale: "main write" }),
  ]);
  const outcome = await _tryAutoWriteLaneForTests({
    cwd: fx.root,
    sessionId: "shadow-main-write",
    settings: { ...baseSettings, tier1ShadowEnabled: true, rulesAsReadonlyNeighborsEnabled: true },
    window: makeRunWindow(`--- ENTRY 1 u1 message/user ---\n${quote}`),
    modelRegistry: makeModelRegistry(),
    correlationId: "shadow-main-write:auto",
    abrainHome: fx.abrainHome,
    projectId: fx.projectId,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, user_quote: quote, scope_description: "GitHub repos use gh", target_entry_slug: null, provenance: "user-expressed", quote_source: "user_message" },
  });
  assert(outcome.kind === "wrote", `main lane should write, got ${JSON.stringify(outcome)}`);
  const shadow = readJsonl(sedimentAuditPath(fx.root)).find((row) => row.operation === "tier1_shadow_decision");
  assert(shadow?.checkpoint_advanced === false, `shadow checkpoint field must stay false: ${JSON.stringify(shadow)}`);
  assert(!fs.existsSync(sedimentCheckpointPath(fx.root)), "tryAutoWriteLane test hook must not checkpoint; shadow must not add one");
});

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${total} assertions (ADR 0028 PR1).`);
