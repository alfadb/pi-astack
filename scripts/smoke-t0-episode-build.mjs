#!/usr/bin/env node
/**
 * smoke-t0-episode-build — offline-deterministic unit tests for the T0
 * historical evaluation pipeline (scripts/t0-episode-build.mjs).
 *
 * Section 1: unit tests of the pure functions (episode-local candidate ids,
 *   blind-key resolution, episode-local redactor with referential
 *   pseudonyms, body eligibility, dataset-mode detection, resource caps,
 *   grouping with null/empty semantics, join confidence, runId computation,
 *   fragment reassembly, toolResult parsing, legacy heuristic join,
 *   last-non-empty-assistant-turn output recovery, episode-level filters).
 *
 * This smoke is OFFLINE-DETERMINISTIC: it never reads the production
 * dispatch audit / parent session transcripts and never touches production
 * paths. All fixtures are hand-written; every temp dir is created under
 * os.tmpdir() and removed in a finally block. Real-data acceptance against
 * the current /home/worker/.pi corpus lives in the explicit read-only
 * production dossier (scripts/dossier-t0-episode-build-production.mjs,
 * npm run dossier:t0-episode-build-production) — not here.
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

await check("buildEpisodeRedactor: UUIDv7 session ids (019f/01a0) redacted — incl. underscore-delimited / uppercase forms; UUIDv4 / rep- / slot- / unhyphenated / hex-embedded intact", () => {
  // Contract for production SESSION_ID_RE: canonical hyphenated UUIDv7
  // (8-4-7xxx-[89ab]xxx-12, any 8-hex first segment), hex-context lookarounds,
  // case-insensitive (uppercase UUIDv7 is caught too).
  const key = "a".repeat(64);
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", ["openai/gpt-5.6-sol"], []);
  const v7_019f = "019ff87f-13bd-70c8-abca-e4bb132c6140";
  const v7_019e = "019e1234-5678-7abc-8def-0123456789ab";
  const v7_01a0 = "01a0abcd-ef01-7a01-b234-567890abcdef";
  const v4 = "550e8400-e29b-41d4-a716-446655440000";
  const repId = "rep-1151132f9fe65e18";
  const slotId = "slot-rep-1151132f9fe65e18-c0dcace754bc";
  const unhyphenated = "019ff87f13bd70c8abcae4bb132c6140";
  const out = redact(`session ${v7_019f} and ${v7_019e} and ${v7_01a0} plus ${v4} plus ${repId} ${slotId} raw ${unhyphenated}`);
  assert.ok(!out.includes(v7_019f) && !out.includes(v7_019e) && !out.includes(v7_01a0),
    "redactor must replace 019e/019f/01a0 UUIDv7 session ids");
  assert.ok((out.match(/\[session\]/g) || []).length >= 3, "each UUIDv7 must become [session]");
  assert.ok(out.includes(v4), "UUIDv4 must not be redacted as a session id");
  assert.ok(out.includes(repId) && out.includes(slotId), "anonymous rep-/slot- HMAC ids must not be redacted");
  assert.ok(out.includes(unhyphenated), "unhyphenated 32hex must not be treated as a session id");
  // Hex-context lookaround: adjacent hex digits must not false-positive a match.
  const embedded = `aa${v7_019f}bb`;
  assert.equal(redact(embedded), embedded, "hex-embedded UUIDv7 must not be redacted");
  // Non-hex adjacency (underscore in filenames) still redacts — lookaround is hex-only, not \\b.
  assert.equal(redact(`file_${v7_019f}.jsonl`), "file_[session].jsonl");
  // Case-insensitive: uppercase UUIDv7 (quoted / file-name forms) redacts too.
  assert.equal(redact(`file_${v7_019f.toUpperCase()}.jsonl`), "file_[session].jsonl");
  assert.equal(redact(`_${v7_01a0.toUpperCase()}_`), "_[session]_");
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

await check("collectResidualIds finds old-style mN ids (incl. underscore-delimited / uppercase) and ignores ordinary text / longer words", () => {
  assert.deepEqual(M.collectResidualIds(["m12 and m7 and m3", "no ids here", 42]), ["m12", "m3", "m7"]);
  assert.deepEqual(M.collectResidualIds(["schema v4, 5.3%, MiniMax-M3"]), ["M3"]);
  // With the corpus universe, the version fragment inside a KNOWN model name
  // is masked first — MiniMax-M3 is a model, never a residual id.
  assert.deepEqual(M.collectResidualIds(["schema v4, 5.3%, MiniMax-M3"], ["minimax/MiniMax-M3"]), []);
  // Shared alnum-context boundary + case-insensitive: underscore-delimited /
  // file-name / uppercase forms are collected, a longer alphanumeric word is not.
  assert.deepEqual(M.collectResidualIds(["artifact_m12.json and _m2 and M12"]), ["M12", "m12", "m2"]);
  assert.deepEqual(M.collectResidualIds(["taskm12x", "m12x"]), [], "taskm12x / m12x must not be collected as residual ids");
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
  // Shared alnum-context boundary: underscore-delimited ambiguous tokens still
  // fail closed; a longer alphanumeric word containing a token never matches.
  assert.deepEqual(none(["field _M3_ is set."]), ["M3"]);
  assert.deepEqual(none(["route _K3_ chosen"]), ["K3"]);
  assert.deepEqual(none(["task3 and sdk3 and k3s"]), [], "task3/sdk3/k3s must not be bare ambiguous tokens");
  assert.deepEqual(none(["taskv4pro and taskv4-prox"]), [], "longer-word v4pro/v4-pro must not be bare ambiguous tokens");
  // A known full token in underscore-delimited form is masked FIRST (no
  // false-kill of its v4-pro / K3 fragment), while the bare fragment still fails.
  assert.deepEqual(none(["_deepseek-v4-pro_"]), [], "_deepseek-v4-pro_ is a known token, not a bare v4-pro");
  assert.deepEqual(none(["_minimax/MiniMax-M3_"]), [], "_minimax/MiniMax-M3_ is a known token, not a bare M3");
  assert.deepEqual(none(["_kimi-coding/k3_"]), [], "_kimi-coding/k3_ is a known token, not a bare K3");
  // Residual old-style ids are undeterminable (model id vs numbered criterion)
  // and fail closed like bare ambiguous tokens. A residual id that matches an
  // ambiguous token is recorded in the canonical ambiguous form.
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["m2. requiredTail naming"], corpus, ["m2"]), ["M2"]);
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["m12 and m7"], corpus, ["m12", "m7"]), ["m12", "m7"]);
  // A residual id must NOT mask a bare ambiguous token ("m2" must not mask
  // the criterion "M2").
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["M2 criterion"], corpus, ["m2"]), ["M2"]);
  // Residual ids in underscore-delimited / file-name form fail closed too
  // (collected via collectResidualIds, then rejected like any residual).
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["artifact_m2.json"], corpus, ["m2"]), ["M2"]);
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["artifact_m12.json"], corpus, ["m12"]), ["m12"]);
  assert.deepEqual(M.detectAmbiguousIdentityTokens(["taskm12x"], corpus, ["m12"]), ["m12"], "a collected residual id fails closed even when its text form is a longer word");
});

await check("buildEpisodeRedactor: shared alnum-context boundary — underscore-delimited full/vendor/family/alias + artifact_dtr run + _m2/artifact_m12/M12 residuals all redact; task3/sdk3/k3s/xdtr_…/taskm12x never false-killed; empty entity universe still redacts session/run/residual", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash", "kimi-coding/k3", "minimax/MiniMax-M3"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, ["m12", "m2"]);
  // Underscore-delimited identity tokens (file names / field names): full
  // name, vendor, family and alias all redact — \b would leak every one.
  const out = redact(
    "dossier_openai_review.md, run_deepseek/deepseek-v4-flash_log, _openai/gpt-5.6-sol_, _gpt-5.6-sol_, _GPT 5.6 Sol_, _deepseek_, _claude opus_"
  );
  for (const tok of ["openai", "deepseek", "gpt-5.6-sol", "claude opus"]) {
    assert.ok(!out.includes(tok), `underscore-delimited token must redact: ${tok} (got: ${out})`);
  }
  assert.ok(out.includes("dossier_[model-") && out.includes("_log"), "file-name separator context is preserved around pseudonyms");
  // Run ids: artifact_dtr_<hex>.json / _dtr_<hex>_ / uppercase DTR_<HEX> all
  // redact; a longer word (xdtr_…y) never matches.
  const run = "dtr_0123456789abcdef0123456789abcdef";
  assert.equal(redact(`see artifact_${run}.json`), "see artifact_[run].json");
  assert.equal(redact(`_${run}_`), "_[run]_");
  assert.equal(redact("DTR_0123456789ABCDEF0123456789ABCDEF"), "[run]");
  assert.ok(redact(`xdtr_${run}y`).includes(run), "xdtr_…y must never be redacted as a run id");
  // Residual ids: artifact_m12.json / uppercase M12 redact (per-id pseudonym
  // when collected, generic fallback otherwise); taskm12x never matches. The
  // ambiguous mN shape (m2) is fail-closed domain — never replaced by guess.
  const m12 = redact("artifact_m12.json");
  assert.match(m12, /^artifact_\[model-[a-z]+\]\.json$/);
  assert.equal(redact("M12"), redact("m12"), "uppercase and lowercase residual ids redact identically");
  assert.equal(redact("_m2"), "_m2", "an ambiguous m2 is never mechanically replaced (fail-closed domain)");
  assert.ok(redact("taskm12x").includes("taskm12x"), "taskm12x must never be redacted as a residual id");
  // Longer alphanumeric words containing known basename tokens never match.
  assert.equal(redact("task3 and sdk3 and k3s"), "task3 and sdk3 and k3s");
  // Empty entity universe: no early identity return — session/run/residual
  // replacement still runs (residual falls back to the generic pseudonym).
  const { redact: redactEmpty } = M.buildEpisodeRedactor(key, "ep-1", [], []);
  const emptyOut = redactEmpty(`session 019ff87f-13bd-70c8-abca-e4bb132c6140 run ${run} m12`);
  assert.equal(emptyOut, "session [session] run [run] [model-unknown]");
  assert.ok(redactEmpty("plain text stays plain").includes("plain text stays plain"));
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

await check("splitBasename keeps numeric version runs together; aliasVariants re-expands numeric compounds (4-8 → 4,8) and fails closed on malformed/unbounded basenames", () => {
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
  // The pure numeric compound part ("4-8") is re-expanded to "4"/"8" before
  // the full -/space/_ separator combination, so every underscore form of
  // the version run is a WHOLE alias token — claude_opus_4_8 /
  // claude-opus-4_8 / claude_opus_4-8 are all the same entity token (no
  // leftover "_8").
  for (const form of ["claude_opus_4_8", "claude-opus-4_8", "claude_opus_4-8", "claude_opus 4_8"]) {
    assert.ok(opus.includes(form), `aliasVariants must generate ${form}`);
  }
  // Fail-closed input bounds: empty / over-long basenames, empty parts
  // (leading / trailing / double hyphen) and more than ALIAS_MAX_PARTS
  // re-expanded parts throw immediately — a malformed basename must never
  // enter the token/regex/provider path.
  assert.throws(() => M.aliasVariants(""), /non-empty/);
  assert.throws(() => M.aliasVariants("a--b"), /empty part/);
  assert.throws(() => M.aliasVariants("-claude"), /empty part/);
  assert.throws(() => M.aliasVariants("claude-"), /empty part/);
  assert.throws(() => M.aliasVariants("a".repeat(257)), /length/);
  assert.throws(() => M.aliasVariants("a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q"), /parts/);
  // The redactor fails closed on a model name with an empty basename
  // ("provider/") before any redaction work.
  assert.throws(() => M.buildEpisodeRedactor("a".repeat(64), "ep-1", ["provider/"], []), /non-empty/);
  // Normal current names pass.
  for (const name of ["gpt-5.6-sol", "claude-opus-4-8", "deepseek-v4-flash", "kimi-k2.7-code", "MiniMax-M2.7-highspeed", "gpt-5.3-codex-spark"]) {
    assert.ok(M.aliasVariants(name).length > 0, `${name} must pass the alias bounds`);
  }
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

await check("buildEpisodeRedactor: underscore-internal aliases redact whole (claude_opus_4-8 / claude_opus_4_8 / gpt_5.6_sol / deepseek_v4_flash), provider+underscore form leaves no version; glued pseudonym/version residues collapse; normal text passes", () => {
  const key = "a".repeat(64);
  const corpus = ["anthropic/claude-opus-4-8", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Whole underscore aliases are ONE model entity token — no 4-8/5.6/v4
  // version residue and no identity fragment survives. The numeric compound
  // "4-8" re-expands into "4"/"8", so the underscore form of the version
  // run (claude_opus_4_8 / claude-opus-4_8) is a whole alias token too.
  for (const alias of ["claude_opus_4-8", "Claude_Opus_4-8", "claude_opus_4_8", "Claude_Opus_4_8", "claude-opus-4_8", "gpt_5.6_sol", "deepseek_v4_flash", "Deepseek_V4_Flash"]) {
    assert.match(redact(alias), /^\[model-[a-z]+\]$/, `${alias} must become exactly one pseudonym, got: ${redact(alias)}`);
  }
  // The finite complete `-`/space/`_` separator combination covers the mixed
  // forms as the same model entity token.
  for (const mixed of ["claude_opus 4-8", "claude-opus_4-8", "claude opus_4-8", "gpt_5.6-sol", "gpt-5.6_sol", "deepseek_v4-flash"]) {
    assert.match(redact(mixed), /^\[model-[a-z]+\]$/, `${mixed} must become exactly one pseudonym, got: ${redact(mixed)}`);
  }
  // Provider + underscore basename form: the basename collapses whole and the
  // vendor redacts as its own family entity — no version fragment survives.
  const prov = redact("anthropic/claude_opus_4-8");
  assert.match(prov, /^\[model-[a-z]+\]\/\[model-[a-z]+\]$/, `provider+underscore form must be vendor/basename pseudonyms, got: ${prov}`);
  assert.ok(!prov.includes("4-8") && !prov.includes("opus") && !prov.includes("claude"), `provider+underscore form must not leave identity/version residue, got: ${prov}`);
  // Uppercase-`V` version residue: the explicit `[vV]?` case (never a whole-
  // regex /i) clears a `deepseek_V4` family+version residue whole — the
  // family token redacts to its own pseudonym and the `_V4` fragment is
  // collapsed, leaving no V4/version residue.
  assert.match(redact("deepseek_V4"), /^\[model-[a-z]+\]$/, `deepseek_V4 must redact whole with no V4 residue, got: ${redact("deepseek_V4")}`);
  assert.ok(!/[Vv]?4/.test(redact("deepseek_V4")), `deepseek_V4 must leave no V4 version residue, got: ${redact("deepseek_V4")}`);
  // Defense-in-depth: hand-crafted glued pseudonym/version residues collapse
  // (the version fragment never survives next to a pseudonym), including the
  // underscore-version forms the SHORT grammar covers.
  for (const residue of ["[model-a]_[model-b]_4_8", "[model-a]_[model-b]_4-8", "[model-a]_5.6_[model-b]", "[model-a]_v4_[model-b]", "[model-a]-4-8", "5.6-[model-b]", "[model-a]_4-8", "[model-a]_4_8", "[model-a]_v4"]) {
    assert.ok(!/[0-9]/.test(redact(residue)), `glued residue ${residue} must collapse its version fragment, got: ${redact(residue)}`);
  }
  // A candidate id + glued version collapses to the candidate id (both
  // separator forms).
  assert.equal(redact("c0_5"), "c0", "candidate id + glued version must collapse to the candidate id");
  assert.equal(redact("c0-5"), "c0", "candidate id + dash-glued version must collapse to the candidate id");
  // The candidate side of the adjacency is any canonical candidate id
  // (c(?:0|[1-9]\d*), no leading zeros), so a long non-zero candidate
  // collapses too; a leading-zero candidate (c01) is NOT canonical and is
  // never a legal adjacency.
  assert.equal(redact("c123_5"), "c123", "an unbounded canonical candidate id + glued version must collapse to the candidate id");
  assert.equal(redact("c123-5"), "c123", "an unbounded canonical candidate id + dash-glued version must collapse to the candidate id");
  assert.equal(redact("c01_5"), "c01_5", "a non-canonical leading-zero candidate id is not a legal adjacency and must NOT collapse");
  assert.equal(redact("c01-5"), "c01-5", "a non-canonical leading-zero candidate id is not a legal adjacency and must NOT collapse");
  // Short-version false positives are NEVER touched: a 4-digit year glued to
  // a candidate is a date, candidate-vs-candidate text and echoed anonymous
  // HMAC ids are ordinary text, and space-separated review labels / dates /
  // standalone version numbers pass untouched.
  assert.equal(redact("c0-2026-05-28"), "c0-2026-05-28", "a 4-digit year glued to a candidate is a date, not a version fragment");
  assert.equal(redact("slot-rep-1234567890123456-c01234567890"), "slot-rep-1234567890123456-c01234567890", "an echoed anonymous slot id must not be collapsed");
  assert.equal(redact("candidates c0-c1 diverged"), "candidates c0-c1 diverged", "candidate-vs-candidate text must not be collapsed");
  assert.equal(redact("R1 [model-a] and R2 [model-b] are the review items."), "R1 [model-a] and R2 [model-b] are the review items.");
  assert.equal(redact("The release date 2026-05-28 was noted."), "The release date 2026-05-28 was noted.");
  assert.equal(redact("The version 4-8 or 5.6 is fine."), "The version 4-8 or 5.6 is fine.");
  assert.equal(redact("15.692 74-78 5.3%"), "15.692 74-78 5.3%");
});

await check("buildEpisodeRedactor: SHORT version grammar is CHAIN-BOUNDED — full chains / date-version slices / non-canonical candidates never collapse; bare [model] residue collapses; real residues still collapse", () => {
  const key = "a".repeat(64);
  const corpus = ["anthropic/claude-opus-4-8", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Chain-bound minimal reproduction: a longer `pseudo⇄version` chain must
  // NEVER be collapsed mid-way (start inside a `digit + [._-]` run) nor
  // swallow the first segments leaving a `-4`/`_4` residue (end before
  // `[._-] + digit`), and the version slice `28-c0` inside a date must
  // never match — these were the round-three review finds.
  for (const keep of ["c0-1-2-3-4", "[model-a]_1_2_3_4", "1-2-3-4-c0", "released 2026-05-28-c0", "2026_05_28_c0", "c0-2026", "c0-c1", "c01_5", "c01-5", "1-2-3-4-c0-2", "1-c0-2-3-4-5"]) {
    assert.equal(redact(keep), keep, `${keep} must pass through untouched (chain-bound guard)`);
  }
  // Uppercase-`V` version residues collapse like the lowercase forms (the
  // explicit `[vV]?` case — never a whole-regex /i).
  for (const [residue, want] of [["[model-a]_V4", "[model-a]"], ["[model]_V4", "[model]"], ["c123_V4", "c123"], ["[model-a]_V4_[model-b]", "[model-a]_[model-b]"]]) {
    assert.equal(redact(residue), want, `${residue} must collapse to ${want} (uppercase V case)`);
  }
  // SANDWICH residues — a version on BOTH sides of the middle pseudo /
  // canonical candidate — collapse ENTIRELY to the middle token, never a
  // partial pair that would orphan the trailing version (`1.2-c123` must
  // not collapse alone leaving `-v3_4`).
  for (const [residue, want] of [["1-[model-a]-2", "[model-a]"], ["1_[model]_2", "[model]"], ["1_c0_2", "c0"], ["1.2-c123-v3_4", "c123"], ["1-[model-a]-2-3", "[model-a]"]]) {
    assert.equal(redact(residue), want, `${residue} must collapse entirely to ${want}`);
  }
  assert.equal(redact("slot-rep-1234567890123456-c01234567890"), "slot-rep-1234567890123456-c01234567890", "echoed anonymous slot ids must not be collapsed");
  assert.equal(redact("slot-rep-1151132f9fe65e18-c0dcace754bc"), "slot-rep-1151132f9fe65e18-c0dcace754bc", "the accidental 8-c0 hex boundary must not be collapsed");
  // The BARE pseudonym form `[model]` is a legal adjacency side (production
  // matches it like the oracle): a glued residue collapses to the bare
  // pseudonym.
  assert.equal(redact("[model]-4"), "[model]", "bare [model] + glued version must collapse to [model]");
  assert.equal(redact("[model]_4_8"), "[model]", "bare [model] + underscore version must collapse to [model]");
  // Real short residues still collapse (pseudo⇄version adjacency, both
  // separator forms, both directions, candidate side included).
  for (const [residue, want] of [
    ["[model-a]_[model-b]_4_8", "[model-a]_[model-b]"],
    ["[model-a]_5.6_[model-b]", "[model-a]_[model-b]"],
    ["[model-a]_v4_[model-b]", "[model-a]_[model-b]"],
    ["c0_5", "c0"],
    ["c0-5", "c0"],
    ["c123_5", "c123"],
    ["c123-5", "c123"],
    ["5.6-[model-b]", "[model-b]"],
  ]) {
    assert.equal(redact(residue), want, `${residue} must collapse to ${want}`);
  }
  // A full in-grammar chain (pseudo + at most 3 short components) still
  // collapses: `[model-a]_1_2_3` is a full chain, `1-2-3-4-c0` is not a
  // legal version run (4 components) and must stay.
  assert.equal(redact("[model-a]_1_2_3"), "[model-a]", "a full 3-component chain must collapse");
  assert.equal(redact("c0-2026-05-28"), "c0-2026-05-28", "a 4-digit year glued to a candidate is a date, not a version fragment");
  assert.equal(redact("candidates c0-c1 diverged"), "candidates c0-c1 diverged", "candidate-vs-candidate text must not be collapsed");
  assert.equal(redact("The version 4-8 or 5.6 is fine."), "The version 4-8 or 5.6 is fine.", "standalone version numbers are ordinary text");
});

await check("buildEpisodeRedactor: every [._-]-joined version segment may carry its own v/V prefix (c0-5_v4 / [model-a]-1-v2 / 1-[model-a]-2-v3 / 1-v2-c0 / c0-v1_V2-v3) and the tail guard is widened to [._-][vV]?\\d so a pair never eats a prefix leaving a -V2/_v4 residue (1-[model-a]-V2-3-4-5 / c0-1-v2-3-4 / 1-v2-3-4-c0 stay)", () => {
  const key = "a".repeat(64);
  const corpus = ["anthropic/claude-opus-4-8", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // The old grammar only allowed `v`/`V` on the FIRST version segment, so
  // `c0-5_v4` / `1-v2-c0` / `c0-v1_V2-v3` left a `_v4`/`-v2` residue. Now
  // every `[._-]`-joined segment may carry its own prefix and the whole
  // glued chain collapses.
  for (const [residue, want] of [
    ["c0-5_v4", "c0"],
    ["[model-a]-1-v2", "[model-a]"],
    ["1-[model-a]-2-v3", "[model-a]"],
    ["1-v2-c0", "c0"],
    ["c0-v1_V2-v3", "c0"],
  ]) {
    assert.equal(redact(residue), want, `${residue} must collapse entirely to ${want} (per-segment v/V)`);
  }
  // deepseek family token redacts, and the glued `_4_v4` version collapses
  // whole — no `_v4` residue survives (known corpus never ends in `_v4`).
  const ds = redact("run_deepseek_4_v4.log");
  assert.match(ds, /^run_\[model-[a-z]+\]\.log$/, `run_deepseek_4_v4.log must collapse to a pseudonym with no _v4 residue, got: ${ds}`);
  assert.ok(!/[Vv]?4/.test(ds) && !/[Vv]\d/.test(ds), `run_deepseek_4_v4.log must leave no version residue, got: ${ds}`);
  // WIDENED tail guard: a pair must not eat a prefix leaving a `-V2`/`_v4`
  // residue. These 4-component version runs stay untouched.
  for (const keep of ["1-[model-a]-V2-3-4-5", "c0-1-v2-3-4", "1-v2-3-4-c0"]) {
    assert.equal(redact(keep), keep, `${keep} must pass through untouched (4-component version run)`);
  }
});

await check("buildEpisodeRedactor: alias-connected components merge into ONE model identity (github-copilot/gpt-5.5 + openai/gpt-5.5; claude-opus-4-8 + claude_opus_4_8 + 'Claude Opus 4 8'); reverse/rotated corpus order is identical; non-overlapping alias sets stay distinct", () => {
  const key = "a".repeat(64);
  const corpus = ["github-copilot/gpt-5.5", "openai/gpt-5.5"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Both full refs, the bare basename and every humanized alias share ONE
  // pseudonym — a per-route first-wins split could never make BOTH full refs
  // AND the bare basename consistent.
  const a = redact("github-copilot/gpt-5.5");
  assert.match(a, /^\[model-[a-z]+\]$/);
  assert.equal(a, redact("openai/gpt-5.5"), "both routes sharing one basename must share one pseudonym");
  assert.equal(a, redact("gpt-5.5"), "the bare basename must share the merged pseudonym");
  assert.equal(a, redact("GPT 5.5"), "the space alias must share the merged pseudonym");
  // Reverse corpus order: the entity key (model-component:<min lower alias
  // token>) is corpus-order independent, so the pseudonym assignment is
  // byte-identical.
  const { redact: redactRev } = M.buildEpisodeRedactor(key, "ep-1", [...corpus].reverse(), []);
  assert.equal(redactRev("github-copilot/gpt-5.5"), a, "reverse corpus order must assign the same pseudonym");
  assert.equal(redactRev("openai/gpt-5.5"), a, "reverse corpus order must assign the same pseudonym");
  // model↔family collisions still resolve to the merged MODEL entity, and a
  // different basename stays a distinct entity.
  assert.equal(redact("gpt-5.5"), redact("gpt 5.5"), "family-token collision keeps the merged model pseudonym");
  assert.notEqual(a, redact("xai/grok-4.5"), "a different basename must stay a distinct pseudonym");
  // ALIAS-CONNECTED COMPONENT: three routes whose case-insensitive
  // [basename, ...aliasVariants] token sets overlap (claude-opus-4-8's
  // variants include `Claude Opus 4 8` / `Claude_Opus_4_8`, exactly the
  // other two basenames) must union into ONE anonymous model identity —
  // every full ref and every bare alias shares the pseudonym.
  const trio = ["anthropic/claude-opus-4-8", "vendor/claude_opus_4_8", "vendor2/Claude Opus 4 8"];
  const { redact: redactTrio } = M.buildEpisodeRedactor(key, "ep-1", trio, []);
  const c = redactTrio("anthropic/claude-opus-4-8");
  assert.match(c, /^\[model-[a-z]+\]$/);
  assert.equal(c, redactTrio("vendor/claude_opus_4_8"), "claude_opus_4_8 full ref must share the alias-connected pseudonym");
  assert.equal(c, redactTrio("vendor2/Claude Opus 4 8"), "space-form full ref must share the alias-connected pseudonym");
  for (const bare of ["claude-opus-4-8", "claude_opus_4_8", "Claude Opus 4 8", "Claude_Opus_4_8", "claude_opus_4-8", "claude opus 4 8"]) {
    assert.equal(redactTrio(bare), c, `bare alias ${bare} must share the alias-connected pseudonym`);
  }
  // Rotating the corpus order must NOT change the component key (min lower
  // token is corpus-order independent) → byte-identical output for every ref.
  for (const order of [[trio[1], trio[2], trio[0]], [trio[2], trio[0], trio[1]]]) {
    const { redact: redactRot } = M.buildEpisodeRedactor(key, "ep-1", order, []);
    for (const name of trio) assert.equal(redactRot(name), c, `rotated corpus order must assign the same pseudonym to ${name}`);
  }
  // Non-overlapping alias token sets stay distinct entities.
  const { redact: redactMix } = M.buildEpisodeRedactor(key, "ep-1", [...trio, "xai/grok-4.5"], []);
  assert.notEqual(redactMix("xai/grok-4.5"), c, "a non-overlapping basename must stay a distinct pseudonym");
});

await check("buildEpisodeRedactor: final redacted prompt/output-like strings contain no raw model tokens and no version residue (whole-word claude_opus_4_8; short-version collapse)", () => {
  const key = "a".repeat(64);
  const corpus = ["anthropic/claude-opus-4-8", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-flash"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Prompt-like text: raw mentions (dash / space / underscore numeric forms)
  // are fully de-identified — no raw token and no version fragment survives.
  const promptLike = redact(
    "Compare claude_opus_4_8 with claude-opus-4_8 and claude_opus_4-8; also gpt_5.6_sol and deepseek_v4_flash."
  );
  for (const raw of ["claude", "opus", "4_8", "4-8", "gpt", "5.6", "sol", "deepseek", "v4", "flash"]) {
    assert.ok(!promptLike.toLowerCase().includes(raw.toLowerCase()), `prompt-like text must not contain ${raw}: ${promptLike}`);
  }
  assert.match(promptLike, /^Compare \[model-[a-z]+\] with \[model-[a-z]+\] and \[model-[a-z]+\]; also \[model-[a-z]+\] and \[model-[a-z]+\]\.$/, `prompt-like text must be pure pseudonyms, got: ${promptLike}`);
  // Output-like text carrying glued residues (a partially redacted alias) is
  // collapsed to pseudonyms with no version digits — the candidate id "c0"
  // is the legitimate collapse target, never a version fragment.
  const outputLike = redact("We compared [model-a]_[model-b]_4_8 and c0_5 and c0-5 across the board.");
  assert.equal(outputLike, "We compared [model-a]_[model-b] and c0 and c0 across the board.", `glued residues must collapse to their pseudonym/candidate, got: ${outputLike}`);
});

await check("buildEpisodeRedactor: referential consistency on token collisions — a basename/alias that is ALSO a family token (gpt-5.5 / grok-4.5 / glm-5.2 / minimax-m3) keeps ONE model pseudonym (explicit model-first-wins, not sort order / last-write)", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.5", "xai/grok-4.5", "zai-coding-cn/glm-5.2", "minimax/MiniMax-M3"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Full name and bare basename must share ONE pseudonym even though the
  // basename is also a family token (family entities are inserted AFTER
  // model entities — the explicit first-wins lookup, never the sorted regex
  // order or last-write).
  assert.equal(redact("openai/gpt-5.5"), redact("gpt-5.5"), "openai/gpt-5.5 and gpt-5.5 must share one pseudonym");
  assert.equal(redact("openai/gpt-5.5"), redact("GPT 5.5"), "the space alias of gpt-5.5 must share the same pseudonym");
  assert.equal(redact("minimax/MiniMax-M3"), redact("MiniMax-M3"), "minimax/MiniMax-M3 and MiniMax-M3 must share one pseudonym");
  assert.equal(redact("minimax/MiniMax-M3"), redact("MiniMax M3"), "the space alias of MiniMax-M3 must share the same pseudonym");
  assert.equal(redact("xai/grok-4.5"), redact("grok-4.5"), "xai/grok-4.5 and grok-4.5 must share one pseudonym");
  assert.equal(redact("zai-coding-cn/glm-5.2"), redact("glm-5.2"), "zai-coding-cn/glm-5.2 and glm-5.2 must share one pseudonym");
  // Different models stay referentially distinct.
  assert.notEqual(redact("openai/gpt-5.5"), redact("xai/grok-4.5"), "different models must not collapse");
  assert.notEqual(redact("minimax/MiniMax-M3"), redact("zai-coding-cn/glm-5.2"), "different models must not collapse");
  // A different family entity (gpt-5.6 prefix) still gets its own pseudonym.
  assert.notEqual(redact("openai/gpt-5.5"), redact("gpt-5.6"), "gpt-5.5 and the gpt-5.6 family prefix are different entities");
  // The bare ambiguous K3/M3 rule is NOT weakened by the collision fix.
  assert.equal(redact("K3"), "K3", "bare K3 is fail-closed domain, never mechanically replaced");
  assert.equal(redact("M3"), "M3", "bare M3 is fail-closed domain, never mechanically replaced");
});

await check("buildEpisodeRedactor: object KEYS redact recursively; two original keys redacting to the same key fail closed (no silent overwrite); __proto__ keys stay own properties", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Keys AND values both pass through the identity redaction.
  const obj = redact({ "openai/gpt-5.6-sol": "deepseek/deepseek-v4-pro", label: "plain", nested: { "gpt-5.6-sol": 1 } });
  const pseudo = redact("openai/gpt-5.6-sol");
  assert.ok(!("openai/gpt-5.6-sol" in obj), "a model-name object key must be redacted");
  assert.ok(Object.keys(obj).includes(pseudo), "the redacted key must be the model pseudonym");
  assert.equal(obj[pseudo], redact("deepseek/deepseek-v4-pro"), "values redact independently of keys");
  assert.equal(obj.label, "plain", "unaffected keys pass through");
  assert.equal(obj.nested[pseudo], 1, "nested object keys redact too");
  // Two DISTINCT original keys that redact to the same key must throw
  // (fail-closed) instead of silently overwriting one of them — at any depth.
  assert.throws(() => redact({ "gpt-5.6-sol": 1, "GPT-5.6-Sol": 2 }), /key collision/);
  assert.throws(() => redact({ args: { "gpt-5.6-sol": 1, "GPT-5.6-Sol": 2 } }), /key collision/);
  // A "__proto__" key (own property from JSON.parse) stays an own property
  // — never a prototype mutation.
  const fromJson = redact(JSON.parse('{"__proto__": "safe", "gpt-5.6-sol": 1}'));
  assert.equal(Object.getPrototypeOf(fromJson), Object.prototype, "no prototype pollution");
  assert.equal(Object.prototype.hasOwnProperty.call(fromJson, "__proto__"), true);
  assert.equal(fromJson["__proto__"], "safe");
});

await check("judgeMeaningfulMissing: CLOSED token set — no audit values, no trace-path existence leak; final mode always []", () => {
  // thinking missing + reasoning_chars mismatch WITH a reasoning_trace_path
  // present: the path existence must NOT leak into the body and the mismatch
  // must NOT carry audit/recovered numbers.
  const slot = { row: { thinking: "high", reasoning_trace_path: "/home/worker/.pi/agent/sessions/019f/session.jsonl", reasoning_chars: 1234 } };
  const evidence = { thinking: "", toolCalls: [] };
  const missing = M.judgeMeaningfulMissing(slot, evidence, "full_trajectory");
  assert.deepEqual(missing, ["thinking_missing", "thinking_chars_mismatch"]);
  for (const tok of missing) {
    assert.ok(!/\d/.test(tok), `missing token must not carry numbers: ${tok}`);
    assert.ok(!tok.includes("path"), `missing token must not leak trace-path existence: ${tok}`);
    assert.ok(!tok.includes("audit"), `missing token must not mention audit: ${tok}`);
  }
  // A matching reasoning_chars yields only thinking_missing; thinking=off
  // suppresses the missing-thinking token; perfect evidence yields [].
  assert.deepEqual(M.judgeMeaningfulMissing({ row: { thinking: "high", reasoning_chars: 0 } }, { thinking: "", toolCalls: [] }, "full_trajectory"), ["thinking_missing"]);
  assert.deepEqual(M.judgeMeaningfulMissing({ row: { thinking: "off" } }, { thinking: "", toolCalls: [] }, "full_trajectory"), [], "thinking=off means missing thinking is not judge-meaningful");
  assert.deepEqual(M.judgeMeaningfulMissing({ row: { thinking: "high", reasoning_chars: 5 } }, { thinking: "abcde", toolCalls: [] }, "full_trajectory"), []);
  // final mode: always [].
  assert.deepEqual(M.judgeMeaningfulMissing(slot, evidence, "final_answer_only"), []);
});

await check("buildReadme: dataset-mode text is mode-conditional and mutually exclusive (final: only final answers; full: recovered trajectory + missing_evidence, never 'only final answers')", () => {
  const mkStats = (dataset_mode) => ({ schema_version: 3, filters: { min_models: 2 }, dataset_mode });
  const finalReadme = M.buildReadme(mkStats("final_answer_only"));
  const fullReadme = M.buildReadme(mkStats("full_trajectory"));
  assert.ok(finalReadme.includes("final_answer_only"), "final README declares its mode");
  assert.ok(/contains only final answers/.test(finalReadme), "final README must state only final answers");
  assert.ok(!/recovered thinking/.test(finalReadme), "final README must not claim trajectory content");
  assert.ok(fullReadme.includes("full_trajectory"), "full README declares its mode");
  assert.ok(/recovered thinking/.test(fullReadme), "full README must state recovered thinking");
  assert.ok(fullReadme.includes("tool-call trajectory"), "full README must state the tool-call trajectory");
  assert.ok(fullReadme.includes("final stop reason"), "full README must state the final stop reason");
  assert.ok(fullReadme.includes("missing_evidence"), "full README must state missing_evidence");
  assert.ok(!/only final answers/.test(fullReadme), "full README must never claim 'only final answers'");
});

await check("stablePreflightText: strings pass through, undefined/null-safe, non-strings use stable JSON (nested keys included) so bare ambiguous tokens inside them fail the episode closed", () => {
  assert.equal(M.stablePreflightText("plain"), "plain");
  assert.equal(M.stablePreflightText(undefined), "");
  assert.equal(M.stablePreflightText(null), "");
  assert.equal(M.stablePreflightText(42), "42");
  assert.equal(M.stablePreflightText(false), "false");
  // A non-string surface (tools allowlist / stop reason / terminal_state)
  // keeps its nested structure in the scan text, so a bare ambiguous token or
  // residual id inside a nested key/value is detected by the preflight.
  const tools = ["read", { run: "deepseek", criteria: "M3" }];
  const text = M.stablePreflightText(tools);
  assert.equal(text, JSON.stringify(tools), "non-strings must use stable JSON");
  assert.ok(text.includes("M3") && text.includes("deepseek"), "nested tokens must survive into the scan text");
  // Unserializable values fail closed with a clear error — String() would
  // lose nested identity, so it must never be the fallback.
  const cyclic = { a: {} };
  cyclic.a.self = cyclic;
  assert.throws(() => M.stablePreflightText(cyclic), /stablePreflightText/);
  assert.throws(() => M.stablePreflightText(10n), /stablePreflightText/);
  // JSON.stringify returning undefined (function / symbol / a toJSON that
  // returns undefined) also fails closed — never a String() degradation.
  assert.throws(() => M.stablePreflightText(() => {}), /stablePreflightText/);
  assert.throws(() => M.stablePreflightText(Symbol("x")), /stablePreflightText/);
  assert.throws(() => M.stablePreflightText({ toJSON: () => undefined }), /stablePreflightText/);
});

await check("redactNullableBodyString: raw ?? null, redacted, strictly string|null — string/null pass, redaction applies, number/object/array throw", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  // Strings pass through the episode redactor.
  assert.equal(M.redactNullableBodyString("stop", redact, "stop_reason"), "stop");
  assert.equal(M.redactNullableBodyString("tool_use: openai/gpt-5.6-sol", redact, "stop_reason"),
    redact("tool_use: openai/gpt-5.6-sol"), "the value must pass through the episode redactor");
  // undefined/null normalize to null (raw `?? null` first).
  assert.equal(M.redactNullableBodyString(undefined, redact, "terminal_state"), null);
  assert.equal(M.redactNullableBodyString(null, redact, "terminal_state"), null);
  // Non-string non-null values fail closed (redaction never changes a scalar's
  // type, so a drifted input can never be written).
  assert.throws(() => M.redactNullableBodyString(42, redact, "failure_type"), /failure_type must be string\|null/);
  assert.throws(() => M.redactNullableBodyString({ type: "stop" }, redact, "stop_reason"), /stop_reason must be string\|null/);
  assert.throws(() => M.redactNullableBodyString(["stop"], redact, "terminal_state"), /terminal_state must be string\|null/);
});

await check("parseArgs: explicit --max-output-bytes 0 / negative throws (fail-closed); default unchanged; positive values floor; capOutput keeps 0 semantics", () => {
  assert.throws(() => M.parseArgs({ "max-output-bytes": 0 }), /max-output-bytes/);
  assert.throws(() => M.parseArgs({ "max-output-bytes": -5 }), /max-output-bytes/);
  assert.throws(() => M.parseArgs({ "max-output-bytes": "0" }), /max-output-bytes/);
  assert.throws(() => M.parseArgs({ "max-output-bytes": "-1" }), /max-output-bytes/);
  // Default unchanged when the flag is absent.
  assert.equal(M.parseArgs({}).maxOutputBytes, M.DEFAULT_MAX_OUTPUT_BYTES);
  // Positive values still parse (floored like the other caps).
  assert.equal(M.parseArgs({ "max-output-bytes": 200 }).maxOutputBytes, 200);
  assert.equal(M.parseArgs({ "max-output-bytes": 200.9 }).maxOutputBytes, 200);
  // capOutput (pure helper) keeps its 0 semantics — the guard is producer-level.
  assert.equal(M.capOutput("x", 0), "");
});

await check("buildEpisodes rejects maxOutputBytes < 1 (direct callers must pass a positive integer)", () => {
  // The entry guard runs before any filesystem IO, so a minimal options
  // object is enough to trigger the fail-closed check.
  assert.throws(() => M.buildEpisodes({ maxOutputBytes: 0 }), /maxOutputBytes/);
  assert.throws(() => M.buildEpisodes({ maxOutputBytes: -1 }), /maxOutputBytes/);
  assert.throws(() => M.buildEpisodes({ maxOutputBytes: 1.5 }), /maxOutputBytes/);
  assert.throws(() => M.buildEpisodes({ maxOutputBytes: undefined }), /maxOutputBytes/);
});

await check("assembleTrajectoryFields fails closed on contract drift: object finalStopReason / non-string thinking / non-array tool_calls throw (redaction never changes a value's type)", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  const opts = { maxToolArgsBytes: 1024, maxToolResultBytes: 1024 };
  // An object stop reason (direct caller / dispatch-trace drift) must throw —
  // redaction returns the object unchanged, so it can never be written.
  assert.throws(
    () => M.assembleTrajectoryFields({ thinking: "t", toolCalls: [], finalStopReason: { type: "stop" } }, redact, opts),
    /final_stop_reason must be string\|null/,
  );
  // Non-string thinking must throw after redaction.
  assert.throws(
    () => M.assembleTrajectoryFields({ thinking: { text: "t" }, toolCalls: [], finalStopReason: null }, redact, opts),
    /thinking must be a string/,
  );
  // Non-array tool_calls must throw after redaction.
  assert.throws(
    () => M.assembleTrajectoryFields({ thinking: "t", toolCalls: { read: "x" }, finalStopReason: null }, redact, opts),
    /tool_calls must be an array/,
  );
  // A number thinking also throws (not silently written).
  assert.throws(
    () => M.assembleTrajectoryFields({ thinking: 42, toolCalls: [], finalStopReason: null }, redact, opts),
    /thinking must be a string/,
  );
});

await check("assembleTrajectoryFields / capToolCalls: thinking/final stop are redacted before writing, thinking_chars == written thinking.length, tool_calls re-capped after redaction — the cap bounds CONTENT bytes for strings and writes a fixed marker object for other over-cap values (never a JSON-level bound)", () => {
  const key = "a".repeat(64);
  const corpus = ["openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", corpus, []);
  const opts = { maxToolArgsBytes: 1024, maxToolResultBytes: 64 };
  const evidence = {
    thinking: "compare openai/gpt-5.6-sol with deepseek/deepseek-v4-pro",
    toolCalls: [
      { name: "read", args: { path: "/openai/gpt-5.6-sol/config" }, result: "ok", isError: false },
      { name: "bash", args: { cmd: "run deepseek/deepseek-v4-pro" }, result: { data: "y".repeat(500) }, isError: false },
    ],
    finalStopReason: "tool_use: openai/gpt-5.6-sol",
  };
  const fields = M.assembleTrajectoryFields(evidence, redact, opts);
  assert.equal(fields.thinking_chars, fields.thinking.length, "thinking_chars must equal the written thinking length");
  assert.ok(!fields.thinking.includes("openai") && !fields.thinking.includes("deepseek"), "thinking must be redacted");
  assert.ok(fields.final_stop_reason.includes("tool_use"), "final stop reason passes through redaction");
  assert.ok(!fields.final_stop_reason.includes("openai"), "final stop reason must be redacted");
  assert.ok(Array.isArray(fields.tool_calls), "tool_calls must be an array");
  assert.ok(!JSON.stringify(fields.tool_calls).includes("openai") && !JSON.stringify(fields.tool_calls).includes("deepseek"), "tool args/results must be redacted");
  // Under-cap args pass through as the redacted OBJECT itself (capJson returns
  // the original value when its JSON fits) — never re-serialized, never a marker.
  assert.deepEqual(fields.tool_calls[0].args, redact({ path: "/openai/gpt-5.6-sol/config" }),
    "under-cap args must be the redacted object, unchanged in shape");
  // The second call's result exceeds maxToolResultBytes AFTER redaction
  // (redaction can lengthen tokens): it is a NON-STRING over-cap value, so it
  // becomes the fixed marker object — its exact shape is the protocol, never
  // the raw big object and never a size-bound JSON.
  const big = fields.tool_calls[1].result;
  assert.deepEqual(big, { truncated: true, marker: "[truncated]" },
    "over-cap non-string values must become the fixed marker object");
  // Over-cap STRINGS are tail-truncated to maxBytes CONTENT bytes (the marker
  // plus the tail). The cap is a content-byte bound — JSON serialization adds
  // quotes/escape overhead on top, so the serialized form may legitimately
  // exceed maxBytes; that is NOT part of the cap protocol and is never
  // asserted as a bound (no `<= cap + N` pseudo-evidence).
  const stringCapped = M.capToolCalls(
    [{ name: "read", args: null, result: "z".repeat(200), isError: false }],
    opts.maxToolArgsBytes,
    opts.maxToolResultBytes,
  );
  assert.equal(typeof stringCapped[0].result, "string");
  assert.ok(stringCapped[0].result.startsWith("[truncated]"), "over-cap strings are tail-truncated with the marker");
  assert.ok(M.utf8ByteLength(stringCapped[0].result) <= opts.maxToolResultBytes,
    "the cap bounds CONTENT bytes for strings, not the JSON wrapper");
  assert.ok(M.utf8ByteLength(JSON.stringify(stringCapped[0].result)) > opts.maxToolResultBytes,
    "the JSON-serialized form can exceed the cap (quotes/escapes) — the cap is content bytes only");
  // Null final stop reason and empty evidence pass through.
  const empty = M.assembleTrajectoryFields({ thinking: "", toolCalls: [], finalStopReason: null }, redact, opts);
  assert.equal(empty.thinking, "");
  assert.equal(empty.thinking_chars, 0);
  assert.deepEqual(empty.tool_calls, []);
  assert.equal(empty.final_stop_reason, null);
});

// ── Section 2: new fail-closed contracts (unit) ──────────────────────────

await check("assertThinkingLevel / isLegalThinkingLevel / THINKING_LEVELS: null and all legal values pass; illegal / identity-bearing / wrong-type values fail closed", () => {
  assert.deepEqual(M.THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const v of [null, "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(M.isLegalThinkingLevel(v), true, `legal value ${JSON.stringify(v)} must pass`);
    assert.equal(M.assertThinkingLevel(v, "test"), v, `legal value ${JSON.stringify(v)} must pass through`);
  }
  for (const v of ["openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro", "M3", "K3", "", "HIGH", "high ", 42, {}, ["high"], undefined, true]) {
    assert.equal(M.isLegalThinkingLevel(v), false, `illegal value ${JSON.stringify(v)} must fail`);
    assert.throws(() => M.assertThinkingLevel(v, "test"), /must be null or one of/, `illegal value ${JSON.stringify(v)} must throw`);
  }
});

await check("capToolCalls: exact own-key contract — plain record with exactly name,args,result,isError; name string, isError boolean, args/result own-present JSON values; missing/extra/inherited/wrong type fail closed; output rebuilds the four keys (no spread)", () => {
  const valid = M.capToolCalls([{ name: "read", args: { path: "/x" }, result: "ok", isError: false }], 1024, 4096);
  assert.deepEqual(Object.keys(valid[0]).sort(), ["args", "isError", "name", "result"]);
  assert.equal(valid[0].name, "read");
  assert.equal(valid[0].isError, false);
  assert.deepEqual(valid[0].args, { path: "/x" });
  assert.equal(valid[0].result, "ok");
  // Missing key.
  assert.throws(() => M.capToolCalls([{ name: "read", args: null, result: "ok" }], 1024, 4096), /own keys/);
  // Extra key (never spread into the output).
  assert.throws(() => M.capToolCalls([{ name: "read", args: null, result: "ok", isError: false, id: "t1" }], 1024, 4096), /own keys/);
  // Inherited key is not accepted as present.
  const inherited = Object.create({ name: "read" });
  inherited.args = null; inherited.result = "ok"; inherited.isError = false;
  assert.throws(() => M.capToolCalls([inherited], 1024, 4096), /own keys/);
  // Wrong types.
  assert.throws(() => M.capToolCalls([{ name: 42, args: null, result: "ok", isError: false }], 1024, 4096), /name must be a string/);
  assert.throws(() => M.capToolCalls([{ name: "read", args: null, result: "ok", isError: "no" }], 1024, 4096), /isError must be a boolean/);
  // args/result must be JSON values (undefined / function fail).
  assert.throws(() => M.capToolCalls([{ name: "read", args: undefined, result: "ok", isError: false }], 1024, 4096), /args/);
  assert.throws(() => M.capToolCalls([{ name: "read", args: null, result: () => {}, isError: false }], 1024, 4096), /result/);
  // Non-record items fail.
  assert.throws(() => M.capToolCalls([null], 1024, 4096), /plain record/);
  assert.throws(() => M.capToolCalls(["read"], 1024, 4096), /plain record/);
  // Post-redaction cap still applies (assembleTrajectoryFields path).
  const big = M.capToolCalls([{ name: "read", args: null, result: "z".repeat(200), isError: false }], 1024, 64);
  assert.ok(big[0].result.startsWith("[truncated]"));
});

await check("parseCli: strict raw-argv parsing — rejects --flag=value, unknown flags, positionals, duplicates, missing values, boolean-with-value; legal space-form argv parses", () => {
  // --flag=value form is rejected (would otherwise silently fall back to defaults).
  assert.throws(() => M.parseCli(["--output=/tmp/x"]), /not supported/);
  // Unknown flag.
  assert.throws(() => M.parseCli(["--typo"]), /unknown option/);
  // Positional.
  assert.throws(() => M.parseCli(["foo"]), /positional/);
  // Duplicate flag.
  assert.throws(() => M.parseCli(["--output", "/tmp/a", "--output", "/tmp/b"]), /duplicate/);
  // Value flag missing its value.
  assert.throws(() => M.parseCli(["--output"]), /requires a value/);
  assert.throws(() => M.parseCli(["--output", "--quiet"]), /requires a value/);
  // Boolean flag with a value.
  assert.throws(() => M.parseCli(["--no-archive", "true"]), /must not take a value/);
  assert.throws(() => M.parseCli(["--quiet", "1"]), /must not take a value/);
  // Legal space-form argv parses.
  const opts = M.parseCli(["--output", "/tmp/x", "--min-models", "3", "--no-archive", "--quiet", "--seed", "42"]);
  assert.equal(opts.output, path.resolve("/tmp/x"));
  assert.equal(opts.minModels, 3);
  assert.equal(opts.noArchive, true);
  assert.equal(opts.quiet, true);
  assert.equal(opts.seed, "42");
  // Boolean flags adjacent to each other are fine.
  const opts2 = M.parseCli(["--no-archive", "--quiet"]);
  assert.equal(opts2.noArchive, true);
  assert.equal(opts2.quiet, true);
});

await check("parseCli: semantic raw-value gates — blank values, degenerate --models CSV, invalid since/until, malformed numerics and blank blind-key/seed/output all throw; legal boundaries (2/0/1/date/models) still parse", () => {
  // Blank / whitespace-only values are rejected (never a default-path fallback
  // or a derived key).
  for (const flag of ["output", "blind-key", "seed", "project-root", "sessions-root", "audit", "archive-dir", "since", "until", "models", "min-models", "max-output-bytes"]) {
    assert.throws(() => M.parseCli([`--${flag}`, "   "]), /empty or whitespace-only/, `--${flag} whitespace must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, ""]), /empty or whitespace-only/, `--${flag} empty must throw`);
  }
  // --models: explicit CSV must be semantically non-empty — whitespace, ",",
  // ",," and "a,,b" fail closed instead of silently dropping empty segments.
  assert.throws(() => M.parseCli(["--models", " "]), /empty or whitespace-only/);
  assert.throws(() => M.parseCli(["--models", ","]), /non-empty model names/);
  assert.throws(() => M.parseCli(["--models", ",,"]), /non-empty model names/);
  assert.throws(() => M.parseCli(["--models", "a,,b"]), /non-empty model names/);
  assert.throws(() => M.parseCli(["--models", "a,"]), /non-empty model names/);
  assert.throws(() => M.parseCli(["--models", ",a"]), /non-empty model names/);
  assert.throws(() => M.parseCli(["--models", "/"]), /non-empty model names/);
  assert.throws(() => M.parseCli(["--models", "a,/"]), /non-empty model names/, "a bare slash segment must throw");
  assert.throws(() => M.parseCli(["--models", "/,b"]), /non-empty model names/, "a bare slash segment must throw");
  // A legal CSV parses into trimmed non-empty segments.
  assert.deepEqual(M.parseCli(["--models", "openai/gpt-5.6-sol, anthropic/claude-opus-5"]).models,
    ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"]);
  // Absent --models stays undefined (default selection).
  assert.equal(M.parseCli([]).models, undefined);
  // --since / --until: a supplied value must be a strict ISO date — an
  // invalid / non-ISO / timezone-less / invalid-calendar value must never
  // silently drop the time window.
  for (const flag of ["since", "until"]) {
    assert.throws(() => M.parseCli([`--${flag}`, "not-a-date"]), /valid ISO date/, `--${flag} invalid date must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, "2026-13-99"]), /valid ISO date/, `--${flag} out-of-range date must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, "2026-02-30"]), /valid ISO date/, `--${flag} invalid calendar date must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, "August 1, 2026"]), /valid ISO date/, `--${flag} non-ISO date must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, "08/01/2026"]), /valid ISO date/, `--${flag} non-ISO date must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, "2026-08-01T12:34:56"]), /valid ISO date/, `--${flag} timezone-less datetime must throw`);
  }
  // Legal ISO dates parse (date-only, Z, fraction, legal offset) and normalize
  // to canonical ISO via parseIso.
  assert.equal(M.parseCli(["--since", "2026-08-01"]).since, "2026-08-01T00:00:00.000Z", "date-only normalizes to UTC midnight");
  assert.equal(M.parseCli(["--since", "2026-08-01T00:00:00.000Z"]).since, "2026-08-01T00:00:00.000Z");
  assert.equal(M.parseCli(["--until", "2026-08-31T00:00:00.000Z"]).until, "2026-08-31T00:00:00.000Z");
  assert.equal(M.parseCli(["--since", "2026-08-01T12:34:56.123Z"]).since, "2026-08-01T12:34:56.123Z", "fractional seconds parse");
  assert.equal(M.parseCli(["--since", "2026-08-01T12:34:56+08:00"]).since, "2026-08-01T04:34:56.000Z", "legal offset normalizes to UTC");
  // Proleptic Gregorian leap years: 0000 IS a leap year (divisible by 400),
  // 0001 is not — Date.UTC's 0000..0099 → 1900s mapping must never leak in.
  assert.equal(M.parseCli(["--since", "0000-02-29"]).since, "0000-02-29T00:00:00.000Z", "0000-02-29 is a legal proleptic Gregorian leap day");
  assert.throws(() => M.parseCli(["--since", "0001-02-29"]), /valid ISO date/, "0001-02-29 is not a leap day");
  assert.throws(() => M.parseCli(["--since", "0000-02-30"]), /valid ISO date/, "0000-02-30 is not a calendar day");
  // Outer whitespace is REJECTED (never trimmed before validation): a
  // leading/trailing space or NBSP must fail closed, not silently normalize.
  assert.throws(() => M.parseCli(["--since", " 2026-08-01"]), /valid ISO date/, "leading space must be rejected");
  assert.throws(() => M.parseCli(["--since", "2026-08-01 "]), /valid ISO date/, "trailing space must be rejected");
  assert.throws(() => M.parseCli(["--since", "\u00A02026-08-01"]), /valid ISO date/, "leading NBSP must be rejected");
  assert.throws(() => M.parseCli(["--since", "2026-08-01\u00A0"]), /valid ISO date/, "trailing NBSP must be rejected");
  // --min-models: strict positive decimal >= 2 (abc / negative / decimal /
  // too-small / exponent / hex / signed / leading-zero all throw).
  for (const bad of ["abc", "-1", "0", "1", "1.5", "2.5", "2e1", "0x10", "+3", "02", "007"]) {
    assert.throws(() => M.parseCli(["--min-models", bad]), /integer >= 2/, `--min-models ${bad} must throw`);
  }
  assert.equal(M.parseCli(["--min-models", "2"]).minModels, 2, "boundary 2 parses");
  assert.equal(M.parseCli(["--min-models", "3"]).minModels, 3);
  // Non-negative integer caps: abc / negative / decimal throw, 0 is legal.
  const capKeys = {
    "max-tool-result-bytes": "maxToolResultBytes",
    "max-tool-args-bytes": "maxToolArgsBytes",
    "max-episode-bytes": "maxEpisodeBytes",
    "max-total-bytes": "maxTotalBytes",
  };
  for (const [flag, outKey] of Object.entries(capKeys)) {
    for (const bad of ["abc", "-1", "1.5", "2e1", "0x10", "+3", "02"]) {
      assert.throws(() => M.parseCli([`--${flag}`, bad]), /non-negative integer/, `--${flag} ${bad} must throw`);
    }
    assert.equal(M.parseCli([`--${flag}`, "0"])[outKey], 0, `--${flag} boundary 0 parses`);
  }
  // --max-output-bytes: positive integer (keeps the >= 1 error semantics);
  // abc / negative / decimal / zero / exponent / hex / signed / leading-zero
  // throw, never a fallback/floor.
  for (const bad of ["abc", "-1", "0", "1.5", "2e1", "0x10", "+3", "02"]) {
    assert.throws(() => M.parseCli(["--max-output-bytes", bad]), /positive integer >= 1/, `--max-output-bytes ${bad} must throw`);
  }
  assert.equal(M.parseCli(["--max-output-bytes", "1"]).maxOutputBytes, 1, "boundary 1 parses");
  assert.equal(M.parseCli(["--max-output-bytes", "200"]).maxOutputBytes, 200);
  // Blank blind-key / seed / output are rejected before parseArgs; a non-empty
  // but invalid-hex blind-key is still rejected later by resolveBlindKey.
  assert.throws(() => M.parseCli(["--blind-key", " "]), /empty or whitespace-only/);
  assert.throws(() => M.parseCli(["--seed", " "]), /empty or whitespace-only/);
  assert.throws(() => M.parseCli(["--output", " "]), /empty or whitespace-only/);
  assert.equal(M.parseCli(["--blind-key", "ab".repeat(32)]).blindKey, "ab".repeat(32));
  assert.equal(M.parseCli(["--seed", "42"]).seed, "42");
});

await check("parseCli: raw numeric safe-integer gate — 400-digit / >MAX_SAFE_INTEGER values throw for min-models and every cap; MAX_SAFE_INTEGER boundary parses", () => {
  const huge = "9".repeat(400); // Number() coerces to Infinity
  const overflow = "9007199254740992"; // 2^53, finite but rounds to a non-safe integer
  const maxSafe = String(Number.MAX_SAFE_INTEGER); // 9007199254740991
  // min-models: huge / overflow throw (>= 2 semantics unchanged); the
  // MAX_SAFE_INTEGER boundary (>= 2) parses.
  assert.throws(() => M.parseCli(["--min-models", huge]), /integer >= 2/, "400-digit min-models must throw");
  assert.throws(() => M.parseCli(["--min-models", overflow]), /integer >= 2/, "2^53 min-models must throw");
  assert.equal(M.parseCli(["--min-models", maxSafe]).minModels, Number.MAX_SAFE_INTEGER, "MAX_SAFE_INTEGER min-models parses");
  // Every non-negative cap: huge / overflow throw; MAX_SAFE_INTEGER parses.
  const capKeys = {
    "max-tool-result-bytes": "maxToolResultBytes",
    "max-tool-args-bytes": "maxToolArgsBytes",
    "max-episode-bytes": "maxEpisodeBytes",
    "max-total-bytes": "maxTotalBytes",
  };
  for (const [flag, outKey] of Object.entries(capKeys)) {
    assert.throws(() => M.parseCli([`--${flag}`, huge]), /non-negative integer/, `--${flag} 400-digit must throw`);
    assert.throws(() => M.parseCli([`--${flag}`, overflow]), /non-negative integer/, `--${flag} 2^53 must throw`);
    assert.equal(M.parseCli([`--${flag}`, maxSafe])[outKey], Number.MAX_SAFE_INTEGER, `--${flag} MAX_SAFE_INTEGER parses`);
  }
  // max-output-bytes: huge / overflow throw; MAX_SAFE_INTEGER parses.
  assert.throws(() => M.parseCli(["--max-output-bytes", huge]), /positive integer >= 1/, "400-digit max-output-bytes must throw");
  assert.throws(() => M.parseCli(["--max-output-bytes", overflow]), /positive integer >= 1/, "2^53 max-output-bytes must throw");
  assert.equal(M.parseCli(["--max-output-bytes", maxSafe]).maxOutputBytes, Number.MAX_SAFE_INTEGER, "MAX_SAFE_INTEGER max-output-bytes parses");
});

// ── Section 3: offline buildEpisodes integration (fail-closed guards) ────

/**
 * Self-contained offline fixture: a temp sessions root + audit jsonl
 * describing one or more dispatch_parallel calls, each with dispatch-trace
 * events per task. Returns { options, sessionId, runIdsByCall, dir }.
 */
function makeBuildFixture(calls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-fixture-"));
  const sessionId = "019ff87f-13bd-70c8-abca-e4bb132c6140";
  const sessionLines = [];
  const auditLines = [];
  const runIdsByCall = new Map();
  for (const call of calls) {
    const {
      toolCallId,
      withTrajectory = true,
      thinking = "high",
      prompt = "same prompt",
      output = "final output",
      models = ["openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro"],
    } = call;
    const taskCount = models.length;
    const runIds = [];
    for (let i = 0; i < taskCount; i++) runIds.push(M.computeDispatchRunId(sessionId, toolCallId, i));
    runIdsByCall.set(toolCallId, runIds);
    const tasks = models.map((model, i) => ({ name: `task-${i}`, model, thinking, tools: "read", prompt }));
    sessionLines.push(JSON.stringify({
      type: "message",
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "dispatch_parallel", arguments: { tasks } }] },
    }));
    for (let i = 0; i < taskCount; i++) {
      const runId = runIds[i];
      if (withTrajectory) {
        sessionLines.push(JSON.stringify({ type: "custom", customType: M.DISPATCH_TRACE_CUSTOM_TYPE, data: { recordType: "event", runId, eventSeq: 1, eventKind: "thinking", payload: { text: "thinking text" } } }));
        sessionLines.push(JSON.stringify({ type: "custom", customType: M.DISPATCH_TRACE_CUSTOM_TYPE, data: { recordType: "event", runId, eventSeq: 2, eventKind: "tool_call", payload: { name: "read", id: `t${i}`, args: { path: "/x" } } } }));
        sessionLines.push(JSON.stringify({ type: "custom", customType: M.DISPATCH_TRACE_CUSTOM_TYPE, data: { recordType: "event", runId, eventSeq: 3, eventKind: "tool_result", payload: { name: "read", id: `t${i}`, result: "ok", isError: false } } }));
      }
      sessionLines.push(JSON.stringify({ type: "custom", customType: M.DISPATCH_TRACE_CUSTOM_TYPE, data: { recordType: "event", runId, eventSeq: 4, eventKind: "assistant_message", payload: { text: output, stopReason: "stop" } } }));
    }
    for (let i = 0; i < taskCount; i++) {
      auditLines.push(JSON.stringify({
        operation: "dispatch_parallel.task",
        session_id: sessionId,
        dispatch_tool_call_id: toolCallId,
        task_index: i,
        task_count: taskCount,
        model: models[i],
        thinking,
        tools: "read",
        prompt_chars: prompt.length,
        result: "ok",
        output_chars: output.length,
        timestamp: "2026-08-01T00:00:00.000Z",
      }));
    }
  }
  const sessionDir = path.join(dir, "sessions", "019f");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `session_${sessionId}.jsonl`), sessionLines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "audit.jsonl"), auditLines.join("\n") + "\n");
  const options = M.parseArgs({
    projectRoot: dir,
    "sessions-root": path.join(dir, "sessions"),
    audit: path.join(dir, "audit.jsonl"),
    "archive-dir": path.join(dir, "archive"),
    "no-archive": true,
    output: path.join(dir, "out"),
    "max-episode-bytes": 1_000_000,
  });
  return { options, sessionId, runIdsByCall, dir };
}

await check("buildEpisodes: a publishable trajectory episode yields full_trajectory with real published trajectory (no throw)", () => {
  const fx = makeBuildFixture([{ toolCallId: "call-1", withTrajectory: true }]);
  try {
    const result = M.buildEpisodes(fx.options);
    assert.equal(result.stats.dataset_mode, "full_trajectory");
    assert.equal(result.episodes.length, 1);
    const episode = result.episodes[0];
    assert.ok(episode.slots.some((s) =>
      (typeof s.thinking === "string" && s.thinking.length > 0)
      || (Array.isArray(s.tool_calls) && s.tool_calls.length > 0)),
      "published full_trajectory body must carry real trajectory evidence");
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

await check("buildEpisodes: full_trajectory whose trajectory episode is excluded as too-large fails closed (empty-full guard)", () => {
  const fx = makeBuildFixture([{ toolCallId: "call-1", withTrajectory: true }]);
  try {
    fx.options.maxEpisodeBytes = 1;
    assert.throws(() => M.buildEpisodes(fx.options), /full_trajectory/);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

await check("buildEpisodes: full_trajectory whose only published episode has no trajectory fails closed (empty-full guard)", () => {
  // call-1 carries trajectory but is excluded as too-large (big output);
  // call-2 is publishable but has no trajectory — the published body would
  // be a consumer-rejected empty shell, so the build must fail closed.
  const fx = makeBuildFixture([
    { toolCallId: "call-1", withTrajectory: true, output: "x".repeat(5000) },
    { toolCallId: "call-2", withTrajectory: false, output: "final output" },
  ]);
  try {
    fx.options.maxEpisodeBytes = 2000;
    assert.throws(() => M.buildEpisodes(fx.options), /full_trajectory/);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

await check("buildEpisodes: an illegal / identity-bearing thinking_level throws in Pass A (before any body write)", () => {
  for (const bad of ["openai/gpt-5.6-sol", "M3", { x: 1 }]) {
    const fx = makeBuildFixture([{ toolCallId: "call-1", withTrajectory: true, thinking: bad }]);
    try {
      assert.throws(() => M.buildEpisodes(fx.options), /thinking_level/);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  }
});

// ── summary ────────────────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} t0-episode-build unit checks (offline-deterministic)`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
process.exit(1);
