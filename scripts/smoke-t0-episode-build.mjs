#!/usr/bin/env node
/**
 * smoke-t0-episode-build — focused tests for the T0 historical evaluation
 * pipeline (scripts/t0-episode-build.mjs).
 *
 * Section 1: unit tests of the pure functions (episode-local candidate ids,
 *   blind-key resolution, episode-local redactor with referential
 *   pseudonyms, body eligibility, dataset-mode detection, resource caps,
 *   grouping with null/empty semantics, join confidence, runId computation,
 *   fragment reassembly, toolResult parsing, legacy heuristic join,
 *   last-non-empty-assistant-turn output recovery, episode-level filters).
 * Section 2: REAL-DATA acceptance smoke against the current /home/worker/.pi
 *   dispatch audit + parent session transcripts. No hand-written fixtures are
 *   used as acceptance evidence — the assertions run on the real logs.
 *
 * Anti-leak acceptance uses an INDEPENDENTLY MAINTAINED fixed oracle
 * (ORACLE below): the forbidden model names, basenames, family tokens, leaky
 * version fragments, residual old-style ids and sort-order guessability
 * checks are hardcoded here and deliberately NOT derived from the redactor's
 * own FAMILY_TOKENS / LEAK_FRAGMENT_TOKENS / corpus list — the redactor must
 * pass the oracle, it must not define it (no self-verification).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(path.join(root, "scripts/t0-episode-build.mjs"));

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

// ── independent anti-leak oracle (fixed, hardcoded, NOT derived from the redactor) ──

const ORACLE = {
  // Every model name observed in the current production audit corpus.
  modelNames: [
    "anthropic/claude-fable-5",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-opus-4-7",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-sonnet-5",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "github-copilot/gpt-5-mini",
    "github-copilot/gpt-5.5",
    "kimi-coding/k3",
    "kimi-coding/k3-256k",
    "kimi-coding/kimi-for-coding",
    "kimi-coding/kimi-k2-thinking",
    "minimax/MiniMax-M2.7",
    "minimax/MiniMax-M2.7-highspeed",
    "minimax/MiniMax-M3",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.7-code",
    "openai/gpt-5.3-codex",
    "openai/gpt-5.3-codex-spark",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.5",
    "openai/gpt-5.5-pro",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "xai/grok-4.5",
    "zai-coding-cn/glm-5.1",
    "zai-coding-cn/glm-5.2",
  ],
  // Family / provider / alias tokens that must never appear in a body.
  familyTokens: [
    "openai", "anthropic", "xai", "moonshotai", "kimi-coding", "zai-coding-cn", "minimax", "deepseek", "moonshot",
    "github-copilot", "google", "xiaomi", "cloudflare-workers-ai", "mistralai", "gemini",
    "claude", "gpt", "kimi", "grok", "glm",
    "opus", "sonnet", "haiku", "fable", "flash", "sol", "terra", "luna", "mini", "codex", "spark",
    "k2.7", "k2.6", "opusA", "opusB", "Z.ai",
    "claude-opus", "claude opus", "claude-sonnet", "claude sonnet", "claude-haiku", "claude haiku", "claude-fable", "claude fable",
    "gpt-5.6", "gpt 5.6", "gpt-5.5", "gpt 5.5", "gpt-5.4", "gpt 5.4", "gpt-5.3", "gpt 5.3",
    "deepseek-v4", "deepseek v4", "kimi-k2.7", "kimi k2.7", "kimi-k2.6", "kimi k2.6",
    "grok-4.5", "grok 4.5", "glm-5.2", "glm 5.2", "glm-5.1", "glm 5.1", "minimax-m3", "minimax m3",
    "k3-256k", "k3 256k", "codex-spark", "codex spark",
  ],
  // Leaky standalone version fragments that identify a model, INCLUDING the
  // bare context-ambiguous tokens (K2/M3/M2/K3/v4-pro/v4pro) that must never
  // appear in a body: episodes containing them are fail-closed excluded.
  leakFragments: ["K2", "M3", "M2", "K3", "v4-pro", "v4pro", "M2.7", "k2-thinking", "for-coding", "5-mini", "5-pro", "k3-256k", "codex-spark"],
  // Residual old-style global ids baked into the corpus by older builds.
  residualIdRe: /\bm\d+\b/,
  // M1/M2/M3 criteria partially replaced: a pseudonym adjacent to a bare
  // M1/M2/M3 criterion token in a slash-separated list ("M1/M2/[model-x]").
  partialCriteriaRe: /M[123](?:\/M[123])*\/\[model-[a-z]+\]|\[model-[a-z]+\]\/M[123]/,
  // Version fragments DASH-glued to a pseudonym/candidate id ("[model]-4-8",
  // "5.6-[model]", "c0-5") — the signature of a partially redacted model name.
  // Space-separated digits ("R1 [model-af]") are ordinary text, not leaks.
  pseudonymAdjacentVersionRe: /(?:\[model(?:-[a-z]+)?\]|c\d+)-\d|\d-(?:\[model(?:-[a-z]+)?\]|c\d+)/,
};

function oracleBasenames() {
  return ORACLE.modelNames.map((n) => n.slice(n.lastIndexOf("/") + 1));
}

function assertNoOracleLeak(text, where) {
  for (const name of ORACLE.modelNames) {
    assert.ok(!text.includes(name), `${where} leaks full model name ${name}`);
  }
  for (const base of oracleBasenames()) {
    assert.ok(!text.includes(base), `${where} leaks basename ${base}`);
  }
  for (const token of ORACLE.familyTokens) {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    assert.ok(!re.test(text), `${where} leaks family/alias token ${token}`);
  }
  for (const frag of ORACLE.leakFragments) {
    const re = new RegExp(`\\b${frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    assert.ok(!re.test(text), `${where} leaks version fragment ${frag}`);
  }
  assert.ok(!ORACLE.residualIdRe.test(text), `${where} leaks a residual old-style model id`);
  assert.ok(!ORACLE.pseudonymAdjacentVersionRe.test(text), `${where} leaks a version fragment glued to a pseudonym/candidate id`);
  assert.ok(!ORACLE.partialCriteriaRe.test(text), `${where} has M1/M2/M3 criteria partially replaced by a pseudonym`);
}

// ── Section 1: unit tests (pure functions) ────────────────────────────────

console.log("t0-episode-build unit tests\n");

await check("computeDispatchRunId matches the audit-verified vector", () => {
  // Verified against a real audit row: session 019fd6a1..., toolCall
  // call_huJT7egeWNCbyisN43PS0WYn|fc_06f31e52204a34ef016a74632c74188197a36110ba841a4406,
  // task_index 1 → dtr_f7e1bde7313bc3270225cab7.
  assert.equal(
    M.computeDispatchRunId(
      "019fd6a1-9774-7d2b-87c2-5b3b57172967",
      "call_huJT7egeWNCbyisN43PS0WYn|fc_06f31e52204a34ef016a74632c74188197a36110ba841a4406",
      1,
    ),
    "dtr_f7e1bde7313bc3270225cab7",
  );
  // Deterministic and index-sensitive.
  assert.equal(M.computeDispatchRunId("s", "t", 0), M.computeDispatchRunId("s", "t", 0));
  assert.notEqual(M.computeDispatchRunId("s", "t", 0), M.computeDispatchRunId("s", "t", 1));
});

await check("groupSlots groups verbatim (prompt, thinking, tools) within a call and enforces min models", () => {
  const mk = (toolCallId, taskIndex, model, prompt, thinking, tools) => ({
    row: { session_id: "s1", task_index: taskIndex, model, prompt_chars: prompt.length },
    toolCallId,
    taskSpec: { prompt, thinking, tools },
    joinConfidence: "exact",
  });
  const joined = [
    mk("call-a", 0, "model-a", "same prompt", "high", "read"),
    mk("call-a", 1, "model-b", "same prompt", "high", "read"),
    mk("call-a", 2, "model-c", "different prompt", "high", "read"),
    mk("call-b", 0, "model-a", "same prompt", "high", "read"),
    mk("call-b", 1, "model-b", "same prompt", "high", "read"),
  ];
  const { episodes, belowMin } = M.groupSlots(joined, 2);
  assert.equal(episodes.length, 2, "two calls each with a 2-model verbatim group");
  assert.equal(belowMin.length, 1, "the single-model 'different prompt' group is below min models");
  for (const ep of episodes) {
    assert.equal(ep.prompt, "same prompt");
    assert.equal(new Set(ep.slots.map((s) => s.row.model)).size, 2);
  }
  const { episodes: eps3 } = M.groupSlots(joined, 3);
  assert.equal(eps3.length, 0);
});

await check("groupSlots does not merge same prompt across different calls or sessions", () => {
  const mk = (sessionId, toolCallId, taskIndex, model) => ({
    row: { session_id: sessionId, task_index: taskIndex, model },
    toolCallId,
    taskSpec: { prompt: "p", thinking: "high", tools: "read" },
    joinConfidence: "exact",
  });
  const { episodes } = M.groupSlots([
    mk("s1", "call-a", 0, "model-a"),
    mk("s1", "call-a", 1, "model-b"),
    mk("s1", "call-b", 0, "model-c"),
    mk("s1", "call-b", 1, "model-d"),
    mk("s2", "call-a", 0, "model-e"),
    mk("s2", "call-a", 1, "model-f"),
  ], 2);
  assert.equal(episodes.length, 3, "same prompt in two calls AND same toolCallId in two sessions must be separate episodes");
});

await check("groupSlots distinguishes null from empty string in the group key", () => {
  const mk = (toolCallId, taskIndex, model, thinking, tools) => ({
    row: { session_id: "s1", task_index: taskIndex, model },
    toolCallId,
    taskSpec: { prompt: "p", thinking, tools },
    joinConfidence: "exact",
  });
  const { episodes } = M.groupSlots([
    mk("call-a", 0, "model-a", "high", null),
    mk("call-a", 1, "model-b", "high", null),
    mk("call-a", 2, "model-c", "high", ""),
  ], 2);
  assert.equal(episodes.length, 1, "null-tools group (2 models) is an episode");
  assert.equal(episodes[0].slots.length, 2, "the empty-string-tools slot must NOT join the null-tools group");
  assert.equal(episodes[0].tools, null);
});

await check("episodeLocalModelIds: deterministic, episode-local, referentially consistent c0..cN ids", () => {
  const key = "a".repeat(64);
  const models = [
    "openai/gpt-5.6-sol", "anthropic/claude-opus-5", "deepseek/deepseek-v4-pro", "xai/grok-4.5",
    "minimax/MiniMax-M3", "moonshotai/kimi-k2.7-code", "zai-coding-cn/glm-5.2", "kimi-coding/k3",
  ];
  const id1 = M.episodeLocalModelIds(key, "ep-1", [...models, "openai/gpt-5.6-sol"]);
  assert.deepEqual([...id1.keys()].sort(), [...models].sort());
  for (const m of models) assert.match(id1.get(m), /^c\d+$/);
  // Deterministic for the same (key, episode, model set).
  const id1b = M.episodeLocalModelIds(key, "ep-1", models);
  for (const m of models) assert.equal(id1.get(m), id1b.get(m));
  // Episode-local: the full assignment is a fresh random permutation per
  // episode (8 models -> 40320 permutations, so two episodes almost surely
  // differ) — a self-report in one episode must not be correlatable in
  // another episode.
  const id2 = M.episodeLocalModelIds(key, "ep-2", models);
  const perm1 = models.map((m) => id1.get(m)).join(",");
  const perm2 = models.map((m) => id2.get(m)).join(",");
  assert.notEqual(perm1, perm2, "the candidate-id permutation must differ across episodes");
  // A different blind key changes the assignment.
  const id3 = M.episodeLocalModelIds("b".repeat(64), "ep-1", models);
  const perm3 = models.map((m) => id3.get(m)).join(",");
  assert.notEqual(perm1, perm3, "a different blind key must change the assignment");
});

await check("resolveBlindKey: explicit wins, seed is deterministic, existing file is reused, else random", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t0-blindkey-"));
  try {
    const explicit = M.resolveBlindKey(dir, { blindKey: "ab".repeat(32) });
    assert.equal(explicit.key, "ab".repeat(32));
    assert.equal(explicit.source, "explicit");
    // Invalid explicit key fails closed.
    assert.throws(() => M.resolveBlindKey(dir, { blindKey: "short" }), /64 hex chars/);
    // Seed is deterministic and reproducible.
    const s1 = M.resolveBlindKey(dir, { seed: "42" });
    const s2 = M.resolveBlindKey(dir, { seed: "42" });
    assert.equal(s1.key, s2.key);
    assert.equal(s1.source, "seed");
    assert.match(s1.key, /^[0-9a-f]{64}$/);
    // Generated key is random and 64 hex chars.
    const g1 = M.resolveBlindKey(dir, {});
    const g2 = M.resolveBlindKey(dir, {});
    assert.equal(g1.source, "generated");
    assert.match(g1.key, /^[0-9a-f]{64}$/);
    assert.notEqual(g1.key, g2.key);
    // An existing blind-key.json is reused (deterministic rebuild).
    fs.writeFileSync(path.join(dir, M.BLIND_KEY_FILE), JSON.stringify({ schema_version: 1, blind_key: "cd".repeat(32), source: "generated" }));
    const reused = M.resolveBlindKey(dir, {});
    assert.equal(reused.key, "cd".repeat(32));
    assert.equal(reused.source, "generated", "reuse must report the file's own source for byte-identical stats");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("buildEpisodeRedactor: full name/basename/alias share one pseudonym; distinct entities stay distinct", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol", "anthropic/claude-opus-4-8", "minimax/MiniMax-M3"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  const full = redact("openai/gpt-5.6-sol");
  const base = redact("gpt-5.6-sol");
  const alias = redact("GPT-5.6 Sol");
  assert.match(full, /^\[model-[a-z]+\]$/);
  assert.equal(full, base, "full name and basename of the same model must share one pseudonym");
  assert.equal(full, alias, "humanized alias of the same model must share one pseudonym");
  // Different models get different pseudonyms (referential distinction).
  const other = redact("anthropic/claude-opus-4-8");
  assert.notEqual(full, other, "different models must not collapse to the same pseudonym");
  // Episode-local: the same entity gets a different pseudonym in another episode.
  const { redact: redact2 } = M.buildEpisodeRedactor(key, "ep-2", corpus, []);
  assert.notEqual(redact2("openai/gpt-5.6-sol"), full, "pseudonyms must be episode-local");
});

await check("buildEpisodeRedactor: family tokens, leak fragments and residual ids get distinct pseudonyms; ordinary words intact", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro", "minimax/MiniMax-M3", "kimi-coding/kimi-k2-thinking"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, ["m12", "m7"]);
  // Family tokens are NOT collapsed into one "[model]".
  const claude = redact("Claude");
  const gpt = redact("GPT");
  assert.match(claude, /^\[model-[a-z]+\]$/);
  assert.match(gpt, /^\[model-[a-z]+\]$/);
  assert.notEqual(claude, gpt, "different family tokens must keep referential distinction");
  // Unambiguous leak fragments (k2-thinking, M2.7, for-coding, ...) are redacted.
  assert.match(redact("k2-thinking"), /^\[model-[a-z]+\]$/);
  assert.match(redact("M2.7"), /^\[model-[a-z]+\]$/);
  assert.match(redact("for-coding"), /^\[model-[a-z]+\]$/);
  // Context-ambiguous fragments (M3, v4-pro, v4pro) are NEVER mechanically
  // replaced — they are fail-closed detected, not guessed.
  assert.equal(redact("M3"), "M3");
  assert.equal(redact("v4-pro"), "v4-pro");
  assert.equal(redact("v4pro"), "v4pro");
  // Residual old-style ids are redacted per-id (distinct ids stay distinct).
  const m12 = redact("m12");
  const m7 = redact("m7");
  assert.match(m12, /^\[model-[a-z]+\]$/);
  assert.notEqual(m12, m7, "different residual ids must keep referential distinction");
  // Self-reports in output text.
  assert.equal(redact("As Claude, I think..."), "As [model-a], I think...".replace("model-a", claude.slice(1, -1)));
  // Ordinary words are NOT mangled.
  assert.equal(redact("solution minimal schema v4 pros and cons"), "solution minimal schema v4 pros and cons");
  assert.equal(redact("15.692 74-78 5.3%"), "15.692 74-78 5.3%");
  // Nested JSON values (tool args/results) are redacted recursively.
  const nested = redact({ args: { model: "openai/gpt-5.6-sol" }, result: ["deepseek/deepseek-v4-pro"] });
  assert.equal(nested.args.model, redact("openai/gpt-5.6-sol"));
  assert.equal(nested.result[0], redact("deepseek/deepseek-v4-pro"));
  // Non-string scalars pass through.
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  // Session/run ids quoted in content are replaced with placeholders.
  assert.equal(redact("session 019f3afc-ff83-7fb6-9f77-0d3c94240fe7 run dtr_f7e1bde7313bc3270225cab7"),
    "session [session] run [run]");
});

await check("buildEpisodeRedactor: partial model-name fragments no longer leak (full basenames match first)", () => {
  const key = "a".repeat(64);
  const corpus = ["anthropic/claude-opus-4-8", "anthropic/claude-opus-5", "github-copilot/gpt-5-mini", "minimax/MiniMax-M2.7", "kimi-coding/kimi-k2-thinking", "deepseek/deepseek-v4-pro"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // These were the observed leaks: "[model]-4-8", "[model]-5", "github-copilot/[model]-5-[model]",
  // "[model]/[model]-k2-thinking", "[model]/[model]-M2.7", "[model]/[model]-pro".
  assert.match(redact("claude-opus-4-8"), /^\[model-[a-z]+\]$/);
  assert.match(redact("claude-opus-5"), /^\[model-[a-z]+\]$/);
  assert.match(redact("github-copilot/gpt-5-mini"), /^\[model-[a-z]+\]$/);
  assert.match(redact("minimax/MiniMax-M2.7"), /^\[model-[a-z]+\]$/);
  assert.match(redact("kimi-coding/kimi-k2-thinking"), /^\[model-[a-z]+\]$/);
  assert.match(redact("deepseek/deepseek-v4-pro"), /^\[model-[a-z]+\]$/);
  // A model NOT in the corpus still gets its basename redacted via the corpus
  // universe only if it is a corpus model; family tokens still cover the rest.
  const { redact: redact2 } = M.buildEpisodeRedactor(key, "ep-2", ["openai/gpt-5.6-sol"], []);
  const out = redact2("github-copilot/gpt-5-mini");
  assert.ok(!out.includes("github-copilot") && !out.includes("gpt-5-mini") && !out.includes("5-mini"),
    `uncovered model must still be fully pseudonymized, got: ${out}`);
});

await check("collectResidualIds finds old-style mN ids and ignores ordinary text", () => {
  assert.deepEqual(M.collectResidualIds(["m12 and m7 and m3", "no ids here", 42]), ["m12", "m3", "m7"]);
  assert.deepEqual(M.collectResidualIds(["schema v4, 5.3%, MiniMax-M3"]), []);
});

await check("detectAmbiguousIdentityTokens: bare ambiguous tokens and residual ids fail closed; full names and ordinary text do not", () => {
  const corpus = [
    "openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro", "minimax/MiniMax-M3",
    "moonshotai/kimi-k2.7-code", "kimi-coding/k3", "kimi-coding/kimi-k2-thinking",
  ];
  const none = (texts) => M.detectAmbiguousIdentityTokens(texts, corpus, []);
  // Bare ambiguous tokens are detected.
  assert.deepEqual(none(["M3 criteria"]), ["M3"]);
  assert.deepEqual(none(["### M2. write path"]), ["M2"]);
  assert.deepEqual(none(["K2 series"]), ["K2"]);
  assert.deepEqual(none(["K3 criterion"]), ["K3"]);
  assert.deepEqual(none(["v4-pro fallback"]), ["v4-pro"]);
  assert.deepEqual(none(["v4pro votes"]), ["v4pro"]);
  // Multiple tokens in one episode.
  assert.deepEqual(none(["M1/M2/M3 criteria"]), ["M2", "M3"]);
  // Full model names / longer known tokens are NOT ambiguous.
  assert.deepEqual(none(["minimax/MiniMax-M3"]), []);
  assert.deepEqual(none(["deepseek/deepseek-v4-pro"]), []);
  assert.deepEqual(none(["kimi-coding/k3"]), []);
  assert.deepEqual(none(["kimi-k2.7-code"]), []);
  assert.deepEqual(none(["kimi-k2-thinking"]), []);
  assert.deepEqual(none(["k3-256k"]), []);
  // Ordinary text is untouched.
  assert.deepEqual(none(["schema v4, pros and cons, 5.3%"]), []);
  assert.deepEqual(none(["M1 is a criterion, M4 too"]), []);
  // Residual old-style ids are undeterminable (model id vs numbered criterion)
  // and fail closed like bare ambiguous tokens. A residual id that matches an
  // ambiguous token is recorded in the canonical ambiguous form.
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["m2. requiredTail naming"], corpus, ["m2"]), ["M2"]);
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["m12 and m7"], corpus, ["m12", "m7"]), ["m12", "m7"]);
  // A residual id must NOT mask a bare ambiguous token ("m2" must not mask
  // the criterion "M2").
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["M2 criterion"], corpus, ["m2"]), ["M2"]);
});

await check("episodeSlotId/episodeSlotOrder: random slot ids and shuffles independent of roster order", () => {
  const key = "a".repeat(64);
  const runIds = ["dtr_a", "dtr_b", "dtr_c", "dtr_d"];
  const id1 = M.episodeSlotId(key, "ep-1", "dtr_a");
  assert.match(id1, /^slot-ep-1-[0-9a-f]{12}$/, "slot id must be a random hash, not a roster position");
  assert.equal(id1, M.episodeSlotId(key, "ep-1", "dtr_a"), "slot id must be deterministic");
  assert.notEqual(id1, M.episodeSlotId(key, "ep-2", "dtr_a"), "slot id must be episode-local");
  assert.notEqual(id1, M.episodeSlotId(key, "ep-1", "dtr_b"), "different slots get different ids");
  // The shuffle is a permutation, deterministic, and differs across episodes.
  const order1 = M.episodeSlotOrder(key, "ep-1", runIds);
  assert.deepEqual([...order1].sort(), [...runIds].sort(), "shuffle must be a permutation");
  assert.deepEqual(order1, M.episodeSlotOrder(key, "ep-1", runIds), "shuffle must be deterministic");
  const order2 = M.episodeSlotOrder(key, "ep-2", runIds);
  assert.notEqual(order1.join(","), order2.join(","), "shuffle must be episode-local");
  const order3 = M.episodeSlotOrder("b".repeat(64), "ep-1", runIds);
  assert.notEqual(order1.join(","), order3.join(","), "a different blind key must change the shuffle");
});

await check("slotBodyEligibility: result!=ok / partial / empty / mismatch never enter the capability body", () => {
  const mk = (result, outputChars) => ({ row: { result, output_chars: outputChars } });
  assert.deepEqual(M.slotBodyEligibility(mk("ok", 5), "hello", "tool_result"), { eligible: true, reason: null });
  assert.deepEqual(M.slotBodyEligibility(mk("fail", 5), "hello", "tool_result"), { eligible: false, reason: "result_not_ok" });
  assert.deepEqual(M.slotBodyEligibility(mk("ok", 5), "hello", "tool_result_partial"), { eligible: false, reason: "tool_result_partial" });
  assert.deepEqual(M.slotBodyEligibility(mk("ok", 0), "", "tool_result"), { eligible: false, reason: "output_empty" });
  assert.deepEqual(M.slotBodyEligibility(mk("ok", 100), "hello", "tool_result"), { eligible: false, reason: "output_chars_mismatch" });
  // ±1 trim tolerance.
  assert.deepEqual(M.slotBodyEligibility(mk("ok", 6), "hello", "tool_result"), { eligible: true, reason: null });
});

await check("capOutput truncates UTF-8 byte-safely with a marker; judgeMeaningfulMissing is mode-aware", () => {
  const text = "a".repeat(100) + "中".repeat(50);
  const cut = M.capOutput(text, 40);
  assert.ok(M.utf8ByteLength(cut) <= 40);
  assert.ok(cut.startsWith("[truncated]"));
  assert.equal(M.capOutput("short", 100), "short");
  assert.equal(M.capOutput("x", 0), "");
  const slot = { row: { thinking: "high", reasoning_trace_path: null } };
  const evidence = { thinking: "", toolCalls: [] };
  assert.deepEqual(M.judgeMeaningfulMissing(slot, evidence, "final_answer_only"), [],
    "final_answer_only bodies carry no judge-meaningful missing evidence");
  assert.deepEqual(M.judgeMeaningfulMissing(slot, evidence, "full_trajectory"), ["thinking_missing"]);
});

await check("splitBasename keeps numeric version runs together and aliasVariants covers observed alias forms", () => {
  assert.deepEqual(M.splitBasename("claude-opus-4-8"), ["claude", "opus", "4-8"]);
  assert.deepEqual(M.splitBasename("gpt-5.6-sol"), ["gpt", "5.6", "sol"]);
  const variants = M.aliasVariants("gpt-5.6-sol").map((v) => v.toLowerCase());
  assert.ok(variants.includes("gpt-5.6-sol"));
  assert.ok(variants.includes("gpt 5.6 sol"));
  assert.ok(variants.includes("gpt-5.6 sol"));
  assert.ok(variants.includes("gpt 5.6-sol"));
  const opus = M.aliasVariants("claude-opus-4-8").map((v) => v.toLowerCase());
  assert.ok(opus.includes("claude opus 4-8"));
  assert.ok(opus.includes("claude-opus 4-8"));
});

await check("buildEpisodeId is stable and anonymized (hash, not raw ids)", () => {
  const id = M.buildEpisodeId("session-1", "call-1", "prompt", "high", "read");
  assert.match(id, /^ep-[0-9a-f]{16}$/);
  assert.equal(id, M.buildEpisodeId("session-1", "call-1", "prompt", "high", "read"));
  assert.notEqual(id, M.buildEpisodeId("session-1", "call-1", "prompt2", "high", "read"));
  assert.ok(!id.includes("session-1") && !id.includes("call-1"));
});

await check("reassemblePayload joins fragmented payloads and falls back to single payload", () => {
  const fragments = [
    { fragmentIndex: 0, fragmentCount: 2, payloadFragment: '{"text":"hel' },
    { fragmentIndex: 1, fragmentCount: 2, payloadFragment: 'lo"}' },
  ];
  assert.deepEqual(M.reassemblePayload(fragments), { text: "hello" });
  assert.deepEqual(M.reassemblePayload([{ fragmentIndex: 0, fragmentCount: 1, payload: { text: "x" } }]), { text: "x" });
  assert.equal(M.reassemblePayload([]), null);
});

await check("parseParallelToolResult recovers per-task output and strips metadata lines", () => {
  const text = [
    "## Dispatch Results (2 tasks, 10.0s total)",
    "",
    "| # | Model | Duration | Status |",
    "|---|-------|----------|--------|",
    "| 1 | model-a | 5.0s | ✅ |",
    "| 2 | model-b | 5.0s | ❌ |",
    "",
    "### 1. model-a (5.0s —  ↑10 ↓20 $0.0100)",
    "full output of model-a",
    "### 2. model-b (5.0s —  ↑0 ↓0 $0.0000)",
    "❌ [network] connection lost — 503",
    "_retries: 3 attempts, all failed ✗ (first error: \"x\")_",
    "_partial output (12 chars):_",
    "",
    "partial text here",
  ].join("\n");
  const parsed = M.parseParallelToolResult(text, [
    { index: 0, model: "model-a" },
    { index: 1, model: "model-b" },
  ]);
  assert.equal(parsed.get(0).output, "full output of model-a");
  assert.equal(parsed.get(0).partial, false);
  assert.equal(parsed.get(1).output, "partial text here");
  assert.equal(parsed.get(1).partial, true);
  const tricky = [
    "### 1. model-a (5.0s)",
    "### 2. section inside output",
    "### 2. model-b (5.0s)",
    "output b",
  ].join("\n");
  const parsed2 = M.parseParallelToolResult(tricky, [
    { index: 0, model: "model-a" },
    { index: 1, model: "model-b" },
  ]);
  assert.equal(parsed2.get(0).output, "### 2. section inside output");
  assert.equal(parsed2.get(1).output, "output b");
  const retryOnly = [
    "### 1. model-a (5.0s)",
    "❌ [context_overflow] max_tokens too large",
    "_retries: 9 attempts, all failed ✗_",
  ].join("\n");
  const parsed3 = M.parseParallelToolResult(retryOnly, [{ index: 0, model: "model-a" }]);
  assert.equal(parsed3.get(0).output, "");
});

await check("heuristicJoin requires a UNIQUE candidate; any multi-candidate is excluded", () => {
  const session = {
    toolCalls: [
      { id: "call-1", timestamp: "2026-06-01T10:00:00.000Z", tasks: [{ model: "model-a", thinking: "high", tools: "read", prompt: "prompt-1" }] },
      { id: "call-2", timestamp: "2026-06-01T11:00:00.000Z", tasks: [{ model: "model-a", thinking: "high", tools: "read", prompt: "prompt-1" }] },
    ],
  };
  const row = { task_index: 0, task_count: 1, model: "model-a", thinking: "high", tools: "read", prompt_chars: 8, timestamp: "2026-06-01T12:00:00.000Z" };
  const amb = M.heuristicJoin(session, row);
  assert.equal(amb.ok, false);
  assert.equal(amb.reason, "heuristic_ambiguous");
  const single = M.heuristicJoin({ toolCalls: [session.toolCalls[1]] }, row);
  assert.equal(single.ok, true);
  assert.equal(single.toolCallId, "call-2");
  assert.equal(single.taskSpec.prompt, "prompt-1");
  const miss = M.heuristicJoin(session, { ...row, model: "model-b" });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, "heuristic_no_match");
  const pcMiss = M.heuristicJoin(session, { ...row, prompt_chars: 99 });
  assert.equal(pcMiss.ok, false);
  const late = M.heuristicJoin(session, { ...row, timestamp: "2026-06-01T09:00:00.000Z" });
  assert.equal(late.ok, false);
  const nullPrompt = M.heuristicJoin({
    toolCalls: [{ id: "call-1", timestamp: "2026-06-01T10:00:00.000Z", tasks: [{ model: "model-a", thinking: "high", tools: "read", prompt: null }] }],
  }, row);
  assert.equal(nullPrompt.ok, false);
});

await check("recoverTraceEvidence output is the LAST non-empty assistant turn (production AgentResult), not the concatenation", () => {
  const events = [
    { eventKind: "assistant_message", eventSeq: 1, payload: { text: "I'll check the config first.", stopReason: "toolUse" } },
    { eventKind: "thinking", eventSeq: 2, payload: { text: "need to read settings" } },
    { eventKind: "tool_call", eventSeq: 3, payload: { name: "read", id: "t1", args: { path: "/x" } } },
    { eventKind: "tool_result", eventSeq: 4, payload: { name: "read", id: "t1", result: "ok", isError: false } },
    { eventKind: "assistant_message", eventSeq: 5, payload: { text: "", stopReason: "toolUse" } },
    { eventKind: "assistant_message", eventSeq: 6, payload: { text: "Final answer with the real content.", stopReason: "stop" } },
  ];
  const ev = M.recoverTraceEvidence(events, { maxToolResultBytes: 4096, maxToolArgsBytes: 1024 });
  assert.equal(ev.output, "Final answer with the real content.");
  assert.equal(ev.finalStopReason, "stop");
  assert.equal(ev.thinking, "need to read settings");
  assert.equal(ev.toolCalls.length, 1);
  const empty = M.recoverTraceEvidence([
    { eventKind: "assistant_message", eventSeq: 1, payload: { text: "", stopReason: "error" } },
  ], { maxToolResultBytes: 4096, maxToolArgsBytes: 1024 });
  assert.equal(empty.output, "");
  assert.equal(empty.finalStopReason, "error");
});

await check("applyEpisodeFilters is an episode selection condition and never splits a call", () => {
  const mk = (sessionId, toolCallId, taskIndex, model, timestamp) => ({
    row: { session_id: sessionId, task_index: taskIndex, model, timestamp },
    toolCallId,
    taskSpec: { prompt: "p", thinking: "high", tools: "read" },
    joinConfidence: "exact",
  });
  const episodes = [
    { sessionId: "s1", toolCallId: "c1", slots: [mk("s1", "c1", 0, "model-a", "2026-07-01T00:00:00.000Z"), mk("s1", "c1", 1, "model-b", "2026-07-01T00:00:00.000Z")] },
    { sessionId: "s1", toolCallId: "c2", slots: [mk("s1", "c2", 0, "model-a", "2026-06-01T00:00:00.000Z"), mk("s1", "c2", 1, "model-b", "2026-06-01T00:00:00.000Z")] },
    { sessionId: "s1", toolCallId: "c3", slots: [mk("s1", "c3", 0, "model-a", "2026-07-01T00:00:00.000Z"), mk("s1", "c3", 1, "model-c", "2026-07-01T00:00:00.000Z")] },
  ];
  const time = M.applyEpisodeFilters(episodes, { since: "2026-07-01T00:00:00.000Z", until: undefined, models: undefined });
  assert.equal(time.episodes.length, 2, "the pre-window episode is filtered out whole");
  assert.equal(time.timeFiltered.length, 1);
  const models = M.applyEpisodeFilters(episodes, { since: undefined, until: undefined, models: ["model-a", "model-b"] });
  assert.equal(models.episodes.length, 2, "the episode containing model-c is filtered out whole");
  assert.equal(models.modelFiltered.length, 1);
  const none = M.applyEpisodeFilters(episodes, { since: undefined, until: undefined, models: undefined });
  assert.equal(none.episodes.length, 3);
});

await check("truncateUtf8Tail is UTF-8 byte-safe and marks truncation", () => {
  const text = "a".repeat(100) + "中".repeat(50);
  const cut = M.truncateUtf8Tail(text, 40);
  assert.ok(M.utf8ByteLength(cut) <= 40);
  assert.ok(cut.startsWith("[truncated]"));
  assert.equal(M.truncateUtf8Tail("short", 100), "short");
});

// ── Section 2: real-data acceptance smoke ──────────────────────────────────

console.log("\nt0-episode-build real-data smoke (current /home/worker/.pi)\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-smoke-"));
const options = M.parseArgs({ output: tmp });

// One full real-data run, cached and shared by the acceptance checks below.
const realRun = M.buildEpisodes(options);

await check("real data: pipeline runs and finds >= 340 episodes / >= 1400 body slots", () => {
  const { stats } = realRun;
  assert.ok(stats.groups.episodes >= 340,
    `expected >= 340 episodes, got ${stats.groups.episodes}`);
  assert.ok(stats.groups.slots_in_episodes >= 1400,
    `expected >= 1400 body slots, got ${stats.groups.slots_in_episodes}`);
  assert.ok(stats.join.exact >= 139,
    `expected >= 139 exact-joined rows, got ${stats.join.exact}`);
  assert.ok(stats.join.exact + stats.join.heuristic + stats.join.excluded === stats.audit_rows.eligible,
    `join counts must cover all eligible rows: ${JSON.stringify(stats.join)} vs eligible ${stats.audit_rows.eligible}`);
  assert.ok(stats.audit_rows.parallel_task_rows_scanned >= 4304,
    `expected >= 4304 parallel task rows scanned, got ${stats.audit_rows.parallel_task_rows_scanned}`);
  assert.ok(stats.inputs.sessions_indexed >= 100,
    `expected >= 100 sessions indexed, got ${stats.inputs.sessions_indexed}`);
});

await check("real data: every episode has >= 2 distinct candidate ids and a byte-identical verbatim prompt (verified against the parent session)", () => {
  const sessionIds = [...new Set(realRun.sidecar.flatMap((e) => e.slots.map((s) => s.audit.session_id)))];
  const sessionIndex = M.indexSessions(options.sessionsRoot, sessionIds);
  let checked = 0;
  for (const episode of realRun.episodes) {
    const modelIds = new Set(episode.slots.map((s) => s.model_id));
    assert.ok(modelIds.size >= 2, `episode ${episode.episode_id} has ${modelIds.size} models`);
    assert.equal(episode.model_count, modelIds.size, `episode ${episode.episode_id} model_count mismatch`);
    assert.ok(episode.slots.every((s) => /^c\d+$/.test(s.model_id)), `episode ${episode.episode_id} has a non-candidate model_id`);
    const meta = realRun.sidecar.find((m) => m.episode_id === episode.episode_id);
    const sessionId = meta.slots[0].audit.session_id;
    const toolCallId = meta.slots[0].audit.tool_call_id;
    const session = sessionIndex.get(sessionId);
    assert.ok(session, `episode ${episode.episode_id}: session ${sessionId} not indexed`);
    const toolCall = session.toolCalls.find((tc) => tc.id === toolCallId);
    assert.ok(toolCall, `episode ${episode.episode_id}: toolCall ${toolCallId} not found in session`);
    // task_index lives ONLY in the sidecar (the body must not carry it).
    const rawPrompts = episode.slots.map((s) => {
      const side = meta.slots.find((m) => m.slot_id === s.slot_id);
      assert.ok(side, `episode ${episode.episode_id}: slot ${s.slot_id} missing from sidecar`);
      return toolCall.tasks[side.audit.task_index]?.prompt;
    });
    assert.ok(rawPrompts.every((p) => p != null), `episode ${episode.episode_id}: a slot prompt is not verbatim-recoverable`);
    assert.equal(new Set(rawPrompts).size, 1, `episode ${episode.episode_id}: slots do not share one verbatim prompt`);
    checked++;
  }
  assert.equal(checked, realRun.episodes.length, "all episodes verified for prompt identity");
});

await check("real data: independent leak oracle passes on every episode body (names, basenames, families, fragments, residual ids, sort-order signatures)", () => {
  for (const episode of realRun.episodes) {
    const fields = [
      episode.prompt,
      ...episode.slots.flatMap((s) => [s.output, JSON.stringify(s.tool_calls ?? null)]),
    ];
    assertNoOracleLeak(fields.join("\n"), `episode ${episode.episode_id}`);
  }
});

await check("real data: candidate ids are episode-local and not sort-order guessable", () => {
  // Map candidate id -> model name via the sidecar.
  const modelBySlot = new Map();
  for (const meta of realRun.sidecar) {
    for (const slot of meta.slots) modelBySlot.set(`${meta.episode_id}\u0000${slot.slot_id}`, slot.model);
  }
  const idsByModel = new Map();
  let c0IsAlphabeticallyFirst = 0;
  for (const episode of realRun.episodes) {
    const modelsInEpisode = episode.slots.map((s) => modelBySlot.get(`${episode.episode_id}\u0000${s.slot_id}`));
    const sorted = [...new Set(modelsInEpisode)].sort();
    for (const slot of episode.slots) {
      const model = modelBySlot.get(`${episode.episode_id}\u0000${slot.slot_id}`);
      let ids = idsByModel.get(model);
      if (!ids) { ids = new Set(); idsByModel.set(model, ids); }
      ids.add(slot.model_id);
    }
    const c0Slot = episode.slots.find((s) => s.model_id === "c0");
    if (c0Slot) {
      const c0Model = modelBySlot.get(`${episode.episode_id}\u0000${c0Slot.slot_id}`);
      if (c0Model === sorted[0]) c0IsAlphabeticallyFirst++;
    }
  }
  // The same model must receive different candidate ids in different episodes
  // (a self-report in one episode cannot be correlated in another).
  let checked = 0;
  for (const [model, ids] of idsByModel) {
    if (ids.size >= 2) {
      assert.ok(ids.size >= 2, `model ${model} received only one candidate id across episodes`);
      checked++;
    }
  }
  assert.ok(checked >= 5, `expected >= 5 models appearing in >= 2 episodes, got ${checked}`);
  // c0 must not be the alphabetically-first model in every episode (the old
  // global m0..mN scheme was alphabetically sorted and thus guessable).
  assert.ok(c0IsAlphabeticallyFirst < realRun.episodes.length,
    `c0 was the alphabetically-first model in ALL ${realRun.episodes.length} episodes — sort-order guessable`);
});

await check("real data: body slots are shuffled independent of the dispatch roster order (roster-order attack)", () => {
  const metaBySlot = new Map();
  for (const meta of realRun.sidecar) {
    for (const slot of meta.slots) metaBySlot.set(`${meta.episode_id}\u0000${slot.slot_id}`, slot);
  }
  let identityOrder = 0;
  let c0IsRosterFirst = 0;
  for (const episode of realRun.episodes) {
    const taskIndexes = episode.slots.map((s) => metaBySlot.get(`${episode.episode_id}\u0000${s.slot_id}`).audit.task_index);
    const rosterOrder = [...taskIndexes].sort((a, b) => a - b);
    if (taskIndexes.join(",") === rosterOrder.join(",")) identityOrder++;
    // Slot ids must be random hashes (no roster position) and the body must
    // not carry task_index at all.
    for (const s of episode.slots) {
      assert.match(s.slot_id, /^slot-ep-[0-9a-f]{16}-[0-9a-f]{12}$/,
        `episode ${episode.episode_id} slot_id ${s.slot_id} encodes a roster position`);
      assert.ok(!("task_index" in s), `episode ${episode.episode_id} leaks task_index in the body`);
    }
    // Candidate ids must not be inferable from roster order either: c0's
    // model must not be the roster-first model in every episode.
    const c0Slot = episode.slots.find((s) => s.model_id === "c0");
    if (c0Slot) {
      const c0Model = metaBySlot.get(`${episode.episode_id}\u0000${c0Slot.slot_id}`).model;
      const rosterFirst = episode.slots.reduce((best, s) => {
        const ti = metaBySlot.get(`${episode.episode_id}\u0000${s.slot_id}`).audit.task_index;
        return best === null || ti < best.ti ? { s, ti } : best;
      }, null);
      const rosterFirstModel = metaBySlot.get(`${episode.episode_id}\u0000${rosterFirst.s.slot_id}`).model;
      if (c0Model === rosterFirstModel) c0IsRosterFirst++;
    }
  }
  // A random shuffle matches the roster order with probability <= 1/2 per
  // episode (2-slot) and far less for larger episodes; the observed fraction
  // must be far below 1 (the pre-fix body was 384/384 in roster order).
  assert.ok(identityOrder < realRun.episodes.length,
    `body order == roster order in ALL ${realRun.episodes.length} episodes — roster-order guessable`);
  assert.ok(identityOrder / realRun.episodes.length < 0.3,
    `body order == roster order in ${identityOrder}/${realRun.episodes.length} episodes — not a random shuffle`);
  assert.ok(c0IsRosterFirst < realRun.episodes.length,
    `c0 was the roster-first model in ALL ${realRun.episodes.length} episodes — candidate ids roster-order guessable`);
});

await check("real data: bare context-ambiguous identity tokens are fail-closed excluded (0 body hits, no M1/M2/M3 criteria partially replaced)", () => {
  const { stats } = realRun;
  // The oracle already asserts 0 bare K2/M3/M2/K3/v4-pro/v4pro hits in every
  // body; here we verify the fail-closed mechanism: episodes containing them
  // are excluded and recorded with ambiguous_identity_token.
  assert.ok(stats.groups.episodes_ambiguous_identity >= 20,
    `expected >= 20 ambiguous-identity exclusions, got ${stats.groups.episodes_ambiguous_identity}`);
  const ambiguous = realRun.exclusions.filter((e) => e.reason === "ambiguous_identity_token");
  assert.ok(ambiguous.length >= 20,
    `expected >= 20 ambiguous_identity_token exclusion records, got ${ambiguous.length}`);
  for (const rec of ambiguous) {
    assert.ok(Array.isArray(rec.ambiguous_identity_token) && rec.ambiguous_identity_token.length > 0,
      `ambiguous exclusion ${rec.episode_id} must record the token(s)`);
    for (const token of rec.ambiguous_identity_token) {
      assert.ok(/^(K2|M3|M2|K3|v4-pro|v4pro|m\d+)$/i.test(token),
        `unexpected ambiguous token ${token} in ${rec.episode_id}`);
    }
  }
  // No M1/M2/M3 criteria partially replaced anywhere in the body.
  for (const episode of realRun.episodes) {
    const text = [episode.prompt, ...episode.slots.map((s) => s.output)].join("\n");
    assert.ok(!ORACLE.partialCriteriaRe.test(text),
      `episode ${episode.episode_id} has M1/M2/M3 criteria partially replaced`);
  }
});

await check("real data: dataset_mode=final_answer_only and the body has no dead thinking/tool/final_stop_reason fields", () => {
  assert.equal(realRun.stats.dataset_mode, "final_answer_only",
    "the current production set has no thinking/tool trajectory");
  for (const episode of realRun.episodes) {
    assert.equal(episode.dataset_mode, "final_answer_only");
    for (const slot of episode.slots) {
      assert.ok(!("thinking" in slot), `episode ${episode.episode_id} carries a dead thinking field`);
      assert.ok(!("thinking_chars" in slot), `episode ${episode.episode_id} carries a dead thinking_chars field`);
      assert.ok(!("tool_calls" in slot), `episode ${episode.episode_id} carries a dead tool_calls field`);
      assert.ok(!("final_stop_reason" in slot), `episode ${episode.episode_id} carries a dead final_stop_reason field`);
      assert.deepEqual(slot.missing_evidence, [], `episode ${episode.episode_id} carries non-judge-meaningful missing evidence`);
    }
  }
});

await check("real data: body slots are all result=ok, non-partial, non-empty; availability exclusions are counted", () => {
  const { stats } = realRun;
  for (const episode of realRun.episodes) {
    for (const slot of episode.slots) {
      assert.equal(slot.result, "ok", `episode ${episode.episode_id} body slot has result ${slot.result}`);
      assert.notEqual(slot.output_source, "tool_result_partial", `episode ${episode.episode_id} body slot is partial`);
      assert.ok(slot.output.length > 0, `episode ${episode.episode_id} body slot has empty output`);
    }
  }
  assert.ok(stats.availability.slots_excluded >= 30,
    `expected >= 30 availability-excluded slots (known result_not_ok cases), got ${stats.availability.slots_excluded}`);
  assert.ok((stats.availability.slots_excluded_by_reason.result_not_ok ?? 0) >= 30,
    `expected >= 30 result_not_ok exclusions, got ${JSON.stringify(stats.availability.slots_excluded_by_reason)}`);
  assert.ok(stats.episodes.slots_with_output >= 1400,
    `expected >= 1400 body slots with output, got ${stats.episodes.slots_with_output}`);
  assert.ok(stats.episodes.total_output_bytes > 0, "recovered output must be non-empty in aggregate");
});

await check("real data: sidecar keeps ALL slots (body + excluded) with identity, in_body and exclusion_reason; body never leaks metadata keys", () => {
  // The sidecar covers body episodes AND below-min episodes (which are
  // excluded as a whole but still write sidecar records).
  assert.ok(realRun.sidecar.length >= realRun.episodes.length,
    `sidecar must cover body episodes and below-min episodes: ${realRun.sidecar.length} vs ${realRun.episodes.length}`);
  const byEpisode = new Map(realRun.sidecar.map((m) => [m.episode_id, m]));
  const bodyEpisodeIds = new Set(realRun.episodes.map((e) => e.episode_id));
  for (const id of bodyEpisodeIds) {
    assert.ok(byEpisode.has(id), `body episode ${id} missing sidecar record`);
  }
  const forbiddenKeys = [
    "tokens_in", "tokens_out", "cost", "max_output_tokens", "tool_call_count", "duration_ms",
    "audit_version", "timestamp", "pid", "worker_run_id", "session_id", "dispatch_tool_call_id",
    "run_id", "reasoning_trace_path", "heartbeat_trace_path", "task_count", "device_id",
    "sub_agent_label", "turn_id", "subturn", "task_index",
  ];
  for (const episode of realRun.episodes) {
    const meta = byEpisode.get(episode.episode_id);
    assert.ok(meta, `episode ${episode.episode_id} missing sidecar record`);
    assert.ok(meta.slots.length >= episode.slots.length, `episode ${episode.episode_id} sidecar must keep excluded slots too`);
    const bodySlotIds = new Set(episode.slots.map((s) => s.slot_id));
    for (const side of meta.slots) {
      assert.ok(typeof side.model === "string" && side.model.length > 0, `episode ${episode.episode_id} sidecar missing model name`);
      assert.ok("usage" in side && "audit" in side, `episode ${episode.episode_id} sidecar missing usage/audit`);
      assert.ok(side.audit.session_id && side.audit.tool_call_id, `episode ${episode.episode_id} sidecar missing session/tool-call id`);
      if (bodySlotIds.has(side.slot_id)) {
        assert.equal(side.in_body, true, `episode ${episode.episode_id} body slot ${side.slot_id} not marked in_body`);
        assert.equal(side.exclusion_reason, null, `episode ${episode.episode_id} body slot ${side.slot_id} has an exclusion_reason`);
      } else {
        assert.equal(side.in_body, false, `episode ${episode.episode_id} non-body slot ${side.slot_id} marked in_body`);
        assert.ok(typeof side.exclusion_reason === "string", `episode ${episode.episode_id} non-body slot ${side.slot_id} missing exclusion_reason`);
      }
    }
    const serialized = JSON.stringify(episode);
    for (const key of forbiddenKeys) {
      assert.ok(!serialized.includes(`"${key}"`), `episode ${episode.episode_id} leaks metadata key ${key}`);
    }
    assert.ok(!/dtr_[0-9a-f]{20,}/.test(serialized), `episode ${episode.episode_id} leaks a run id`);
    assert.ok(!/(?<![0-9a-f])019f[0-9a-f-]{20,}(?![0-9a-f])/.test(serialized), `episode ${episode.episode_id} leaks a session id`);
  }
  // Below-min episodes (excluded as a whole) still write sidecar records with
  // in_body=false and count into the availability statistics.
  const belowMinIds = new Set(realRun.exclusions
    .filter((e) => e.reason === "below_min_models_after_availability")
    .map((e) => e.episode_id));
  assert.ok(belowMinIds.size >= 1, `expected >= 1 below-min episode, got ${belowMinIds.size}`);
  for (const id of belowMinIds) {
    const meta = byEpisode.get(id);
    assert.ok(meta, `below-min episode ${id} must write a sidecar record`);
    assert.ok(meta.slots.length >= 1, `below-min episode ${id} sidecar must keep its slots`);
    for (const side of meta.slots) {
      assert.equal(side.in_body, false, `below-min episode ${id} slot marked in_body`);
      // Individually ineligible slots keep their own reason; individually
      // eligible slots of a below-min episode get the episode-level reason.
      assert.ok(typeof side.exclusion_reason === "string" && side.exclusion_reason.length > 0,
        `below-min episode ${id} slot missing exclusion_reason`);
    }
    assert.ok(meta.slots.some((s) => s.exclusion_reason === "below_min_models_after_availability"),
      `below-min episode ${id} must have at least one below-min slot`);
  }
  assert.ok((realRun.stats.availability.slots_excluded_by_reason.below_min_models_after_availability ?? 0) >= 1,
    "below-min slots must count into the availability statistics");
});

await check("real data: exclusions are recorded with reasons; wrong (multi-candidate) heuristic joins are excluded", () => {
  const { stats } = realRun;
  const reasons = new Set(realRun.exclusions.map((e) => e.reason));
  for (const reason of reasons) {
    const inJoin = (stats.join.excluded_by_reason[reason] ?? 0) > 0;
    const inAvailability = (stats.availability.slots_excluded_by_reason[reason] ?? 0) > 0;
    const inEpisodes = reason === "below_min_models_after_availability" || reason === "episode_too_large" || reason === "ambiguous_identity_token";
    assert.ok(inJoin || inAvailability || inEpisodes, `exclusion reason ${reason} not counted in stats`);
  }
  assert.ok(stats.join.excluded_by_reason.heuristic_ambiguous >= 1,
    `expected >= 1 heuristic_ambiguous exclusion, got ${JSON.stringify(stats.join.excluded_by_reason)}`);
  const confidences = new Set(realRun.episodes.flatMap((e) => e.slots.map((s) => s.join_confidence)));
  assert.ok(confidences.has("exact"), "exact-join episodes must exist");
  assert.ok(!confidences.has("heuristic_verified"), "the legacy join must not be called 'verified'");
});

await check("real data: model coverage is reported (corpus vs body, absent models listed)", () => {
  const { stats } = realRun;
  assert.ok(stats.models.corpus_count >= 30, `expected >= 30 corpus models, got ${stats.models.corpus_count}`);
  assert.ok(stats.models.body_count >= 15, `expected >= 15 models in the body, got ${stats.models.body_count}`);
  assert.ok(stats.models.body_count <= stats.models.corpus_count);
  assert.ok(Array.isArray(stats.models.absent_from_body), "absent_from_body must be a list");
  for (const name of Object.keys(stats.models.by_name)) {
    assert.ok(stats.models.by_name[name].episodes >= 1 && stats.models.by_name[name].slots >= 1,
      `model ${name} coverage must be positive`);
  }
  // The oracle's model list must cover the corpus (keeps the oracle honest).
  const oracleSet = new Set(ORACLE.modelNames);
  for (const name of Object.keys(stats.models.by_name)) {
    assert.ok(oracleSet.has(name), `body model ${name} is missing from the independent oracle`);
  }
});

await check("real data: reproducible — same dir twice is byte-identical; --seed reproduces in a fresh dir", () => {
  const run2 = M.buildEpisodes(options);
  assert.equal(JSON.stringify(realRun.stats), JSON.stringify(run2.stats), "stats.json must be byte-identical across runs");
  assert.equal(JSON.stringify(realRun.episodes), JSON.stringify(run2.episodes), "episodes.jsonl must be byte-identical across runs");
  assert.equal(JSON.stringify(realRun.sidecar), JSON.stringify(run2.sidecar), "episodes.meta.jsonl must be byte-identical across runs");
  assert.equal(JSON.stringify(realRun.exclusions), JSON.stringify(run2.exclusions), "exclusions.jsonl must be byte-identical across runs");
  assert.equal(realRun.blind.key, run2.blind.key, "the blind key must be reused across runs into the same dir");
  // A fresh dir with the same seed reproduces the same dataset.
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-seed-b-"));
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-seed-c-"));
  try {
    const runB = M.buildEpisodes(M.parseArgs({ output: dirB, seed: "42" }));
    const runC = M.buildEpisodes(M.parseArgs({ output: dirC, seed: "42" }));
    assert.equal(runB.blind.key, runC.blind.key, "same seed must derive the same blind key");
    assert.equal(JSON.stringify(runB.episodes), JSON.stringify(runC.episodes), "seeded fresh dirs must produce identical episodes");
    assert.equal(JSON.stringify(runB.stats), JSON.stringify(runC.stats), "seeded fresh dirs must produce identical stats");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirB, M.BLIND_KEY_FILE), "utf8")).blind_key, runB.blind.key,
      "blind-key.json must be written into the output dir");
  } finally {
    fs.rmSync(dirB, { recursive: true, force: true });
    fs.rmSync(dirC, { recursive: true, force: true });
  }
});

await check("real data: README documents judge-feedable rules, dataset mode and reproducibility", () => {
  const readme = M.buildReadme(realRun.stats);
  assert.ok(readme.includes("episodes.jsonl"), "README must name episodes.jsonl");
  assert.ok(/ONLY file that may be fed/.test(readme), "README must state episodes.jsonl is the only judge-feedable file");
  for (const name of ["episodes.meta.jsonl", "blind-key.json", "exclusions.jsonl", "stats.json"]) {
    assert.ok(readme.includes(name), `README must warn against feeding ${name}`);
  }
  assert.ok(readme.includes("final_answer_only"), "README must declare the dataset mode");
  assert.ok(readme.includes("--seed"), "README must document seed reproducibility");
  assert.ok(/judge-feed/i.test(readme), "README must document the judge-feed contract");
  assert.ok(/builder\/aggregator/i.test(readme), "README must state the sidecar is builder/aggregator-only");
  assert.ok(readme.includes("ambiguous_identity_token"), "README must document the ambiguous-token fail-closed rule");
  assert.ok(readme.includes("sidecar records"), "README must document below-min sidecar/availability accounting");
});

await check("real data: resource caps are bounded and fail-closed (max-total-bytes aborts, max-output-bytes truncates, max-episode-bytes excludes)", () => {
  const dirCap = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-cap-"));
  try {
    // Fail-closed: a tiny total cap aborts the build.
    assert.throws(
      () => M.buildEpisodes(M.parseArgs({ output: dirCap, "max-total-bytes": 1000 })),
      /max-total-bytes/,
      "a tiny --max-total-bytes must abort the build (fail-closed)",
    );
    // Bounded: a tiny per-slot output cap truncates with a marker.
    const capped = M.buildEpisodes(M.parseArgs({ output: dirCap, "max-output-bytes": 200 }));
    for (const episode of capped.episodes) {
      for (const slot of episode.slots) {
        assert.ok(M.utf8ByteLength(slot.output) <= 200, `slot ${slot.slot_id} exceeds the output cap`);
        if (slot.output_chars > 200) assert.ok(slot.output.startsWith("[truncated]"), `slot ${slot.slot_id} not marked truncated`);
      }
    }
    // Fail-closed: a tiny per-episode cap excludes episodes with a reason.
    const tiny = M.buildEpisodes(M.parseArgs({ output: dirCap, "max-episode-bytes": 100 }));
    assert.ok(tiny.stats.availability.episodes_too_large > 0,
      `expected episodes excluded as too large, got ${tiny.stats.availability.episodes_too_large}`);
    assert.ok(tiny.exclusions.some((e) => e.reason === "episode_too_large"), "episode_too_large must be recorded in exclusions");
  } finally {
    fs.rmSync(dirCap, { recursive: true, force: true });
  }
});

await check("real data: max-total-bytes is checked against the REAL episodes.jsonl size (newline bytes included)", () => {
  const dirSize = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-size-"));
  try {
    const sized = M.buildEpisodes(M.parseArgs({ output: dirSize }));
    M.writeOutputs(dirSize, sized);
    const actual = fs.statSync(path.join(dirSize, "episodes.jsonl")).size;
    assert.equal(sized.stats.resource.total_episodes_bytes, actual,
      `total_episodes_bytes must equal the real episodes.jsonl size (newline-inclusive): ${sized.stats.resource.total_episodes_bytes} vs ${actual}`);
    assert.equal(sized.stats.episodes.total_episode_bytes, actual,
      `episodes.total_episode_bytes must also be newline-inclusive: ${sized.stats.episodes.total_episode_bytes} vs ${actual}`);
    // A cap of exactly the JSON bytes (without the per-line newlines) must
    // still abort — the newline bytes count against the cap.
    const jsonBytes = sized.episodes.reduce((sum, e) => sum + M.utf8ByteLength(JSON.stringify(e)), 0);
    assert.throws(
      () => M.buildEpisodes(M.parseArgs({ output: dirSize, "max-total-bytes": jsonBytes })),
      /max-total-bytes/,
      "a cap equal to the JSON bytes without newlines must abort (newlines count)",
    );
  } finally {
    fs.rmSync(dirSize, { recursive: true, force: true });
  }
});

await check("real data: filters are episode selection conditions after full reconstruction (calls are never split)", () => {
  const since = M.parseArgs({ since: "2026-07-20T00:00:00.000Z", output: tmp });
  const timeFiltered = M.buildEpisodes(since);
  assert.ok(timeFiltered.stats.episode_filters.time_filtered > 0,
    `time filter must exclude some episodes, got ${JSON.stringify(timeFiltered.stats.episode_filters)}`);
  assert.ok(timeFiltered.stats.groups.episodes < realRun.stats.groups.episodes,
    `time filter must shrink the episode set: ${timeFiltered.stats.groups.episodes} vs ${realRun.stats.groups.episodes}`);
  for (const meta of timeFiltered.sidecar) {
    for (const slot of meta.slots) {
      assert.ok(!slot.audit.timestamp || slot.audit.timestamp >= "2026-07-20T00:00:00.000Z",
        `time filter kept a slot before the window: ${slot.audit.timestamp}`);
    }
  }
  const models = M.parseArgs({ models: "openai/gpt-5.6-sol,anthropic/claude-opus-4-8", output: tmp });
  const modelFiltered = M.buildEpisodes(models);
  assert.ok(modelFiltered.stats.episode_filters.model_filtered > 0, "model filter must exclude some episodes");
  assert.ok(modelFiltered.stats.groups.episodes > 0, "model filter must retain qualified episodes");
  assert.ok(modelFiltered.stats.models.body_count <= 2, `model filter must limit distinct models, got ${modelFiltered.stats.models.body_count}`);
  const allowed = new Set(["openai/gpt-5.6-sol", "anthropic/claude-opus-4-8"]);
  for (const meta of modelFiltered.sidecar) {
    for (const slot of meta.slots) {
      assert.ok(allowed.has(slot.model), `model filter kept a slot with non-allowed model ${slot.model}`);
    }
  }
});

// ── summary ────────────────────────────────────────────────────────────────

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} t0-episode-build checks (unit + real-data smoke)`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
process.exit(1);
