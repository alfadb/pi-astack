#!/usr/bin/env node
/**
 * dossier-t0-episode-build-production — EXPLICIT read-only production-data
 * dossier for the T0 historical evaluation pipeline
 * (scripts/t0-episode-build.mjs).
 *
 * NOT a default smoke. This dossier:
 * - reads REAL production dispatch audit + parent session transcripts
 *   (~/.pi/.pi-astack/dispatch/audit.jsonl, ~/.pi/agent/sessions/)
 * - runs the FULL real-data acceptance suite (formerly smoke Section 2):
 *   episode counts, verbatim prompt identity, independent anti-leak oracle,
 *   episode-local candidate ids, roster-order shuffle, ambiguous-token
 *   fail-closed exclusions, dataset mode, availability accounting, sidecar
 *   completeness, exclusion reasons, model coverage, reproducibility,
 *   README contract, resource caps, filters
 * - is READ-ONLY: NO network, NO provider calls, NO paid LLM calls — it only
 *   reads the local audit/session corpus; every scratch output goes to
 *   os.tmpdir() and is removed in a finally block (even when a build throws)
 * - run it explicitly:
 *     npm run dossier:t0-episode-build-production
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
  // Residual old-style ids (`mN`) — ASCII-alphanumeric-context, case-aware
  // (never \b: `_` is a word char, so \b misses `_m2` / `artifact_m12.json`;
  // uppercase `M12` must also be caught). Lowercase `mN` always matches;
  // uppercase `MN` matches except the standalone single-digit criterion `M1`
  // (an uppercase `M1` review item is ordinary text — it must never be
  // mistaken for a residual id; `M2`/`M3` are rejected by the leak-fragment
  // scan). A longer alphanumeric word (`taskm12x`) never matches.
  residualIdRe: /(?<![A-Za-z0-9])(?:m\d+|M(?:0|[2-9]\d*|1\d+))(?![A-Za-z0-9])/,
  // M1/M2/M3 criteria partially replaced: a pseudonym adjacent to a bare
  // M1/M2/M3 criterion token in a slash-separated list ("M1/M2/[model-x]").
  partialCriteriaRe: /M[123](?:\/M[123])*\/\[model-[a-z]+\]|\[model-[a-z]+\]\/M[123]/,
  // Version fragments glued to a pseudonym/candidate id with `_` OR `-`
  // ("[model]-4-8", "[model-a]_[model-b]_4_8", "[model-a]_5.6_[model-b]",
  // "[model-a]_v4_[model-b]", "c0-5", "c0_5", "5.6-[model]") — the
  // signature of a partially redacted model name. The version grammar is
  // deliberately SHORT: `[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}` (at most 3
  // two-digit components), the pseudonym side is `\[model(?:-[a-z]+)?\]`
  // (bare `[model]` and the generated `[model-a]`… forms) and the candidate
  // side is any canonical candidate id `c(?:0|[1-9]\d*)` (no leading
  // zeros): a long non-zero digit run ("c1234567890-5") is a real
  // unbounded candidate id and collapses, while an echoed anonymous HMAC
  // slot id — leading-zero ("…-c01234567890") or hex (…"8-c0dc") — is
  // never canonical. The leading `v` is covered explicitly for BOTH cases
  // (`[vV]?`, never a whole-regex `/i` flag, so no other canonical shape
  // drifts), and every `[._-]`-joined segment may carry its own `v`/`V`
  // prefix (`c0-5_v4`, `1-[model-a]-2-v3`): `[model-a]_V4` / `[model]_V4`
  // / `c123_V4` are rejected like the lowercase forms. There are three alternatives: the two PAIR forms
  // (pseudo⇄version, either direction) PLUS a SANDWICH form
  // `VERSION[_-]PSEUDO_OR_CANONICAL_CANDIDATE[_-]VERSION` — ordered BEFORE
  // the version-first pair so a v-prefixed right-hand version is never
  // orphaned: `1-[model-a]-2` / `1_[model]_2` / `1_c0_2` /
  // `1.2-c123-v3_4` are all rejected whole (never a partial pair leaving
  // `-v3_4`). The adjacency is additionally CHAIN-BOUNDED at both
  // ends, so a partial match inside a longer chain never fires: overall
  // start must not follow `digit + [._-]` (`(?<!\d[._-])`) and overall end
  // must not precede `[._-] + [vV]? + digit` (`(?![A-Za-z0-9]|[._-][vV]?\d)`) — so
  // `c0-1-2-3-4` / `[model-a]_1_2_3_4` / `1-2-3-4-c0` and the version slice
  // `28-c0` inside `released 2026-05-28-c0` / `2026_05_28_c0` are ordinary
  // text (a chain must never be collapsed mid-way or leave a `-4`/`_4`
  // residue), and a four-segment sandwich with either side extended
  // (`1-2-3-4-c0-2`, `1-c0-2-3-4-5`) never partial-matches. All under the
  // SAME ASCII-alphanumeric-context lookarounds as production (never \b):
  // a 4-digit year ("c0-2026-05-28"), dates ("2026-05-28"),
  // standalone version numbers ("4-8"), candidate-vs-
  // candidate text ("candidates c0-c1 diverged"), space-separated digits
  // ("R1 [model-af]"), a non-canonical leading-zero candidate ("c01_5")
  // and echoed anonymous HMAC ids
  // ("slot-rep-…-c01234567890" / "…e18-c0dc…" hex boundaries) are ordinary
  // text, not leaks. Independently maintained — never imported
  // from production's PSEUDONYM_VERSION_RE or the replay oracle.
  pseudonymAdjacentVersionRe: /(?<![A-Za-z0-9])(?<!\d[._-])(?:(?:\[model(?:-[a-z]+)?\]|c(?:0|[1-9]\d*))[_-][vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}|[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}[_-](?:\[model(?:-[a-z]+)?\]|c(?:0|[1-9]\d*))[_-][vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}|[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}[_-](?:\[model(?:-[a-z]+)?\]|c(?:0|[1-9]\d*)))(?![A-Za-z0-9]|[._-][vV]?\d)/,
  // Canonical hyphenated UUIDv7 session ids (independent of production
  // SESSION_ID_RE — same shape, not imported): 8-4-7xxx-[89ab]xxx-12, any
  // 8-hex first segment (019e/019f/01a0 ULID-style prefixes included),
  // hex-context lookarounds (not \b) + case-insensitive (uppercase UUIDv7
  // caught too).
  sessionIdRe: /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f])/i,
  // Dispatch run ids (`dtr_<hex>`) — ASCII-alphanumeric-context +
  // case-insensitive (never \b): `artifact_dtr_<hex>.json` / `_dtr_<hex>_` /
  // uppercase `DTR_<HEX>` are all caught, while a longer alphanumeric word
  // (`xdtr_…y`) never matches. NON-global like every ORACLE regex.
  runIdRe: /(?<![A-Za-z0-9])dtr_[0-9a-f]{20,}(?![A-Za-z0-9])/i,
};

function oracleBasenames() {
  return ORACLE.modelNames.map((n) => n.slice(n.lastIndexOf("/") + 1));
}

function assertNoOracleLeak(text, where) {
  // Full model names and basenames are matched as case-insensitive
  // ALPHANUMERIC-CONTEXT tokens (never a bare substring, never \b): a full
  // name / basename is a leak only as a standalone/separator-delimited token,
  // so task3 / sdk3 / block3 / chunk3 / k3s are NOT false-killed by the
  // basename "k3", while a standalone K3 / an underscore-delimited _K3_ (an
  // id inside a file name / field name) and an uppercase underscore-delimited
  // full name (RUN_DEEPSEEK/DEEPSEEK-V4-FLASH_LOG) are still rejected.
  // Independently maintained — never imported from production or the replay
  // oracle.
  for (const name of ORACLE.modelNames) {
    const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    assert.ok(!re.test(text), `${where} leaks full model name ${name}`);
  }
  for (const base of oracleBasenames()) {
    const re = new RegExp(`(?<![A-Za-z0-9])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    assert.ok(!re.test(text), `${where} leaks basename ${base}`);
  }
  // Family/alias tokens are matched as case-insensitive ALPHANUMERIC-CONTEXT
  // tokens (never \b, never a bare substring): `_` is a word char, so \b
  // misses underscore-delimited tokens (`dossier_openai_review.md`,
  // `run_deepseek/deepseek-v4-flash_log`), while the lookarounds stop a
  // longer alphanumeric word from matching a contained token (`task3` /
  // `sdk3` / `k3s` never match `k3`). Leak fragments use the same boundary.
  for (const token of ORACLE.familyTokens) {
    const re = new RegExp(`(?<![A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    assert.ok(!re.test(text), `${where} leaks family/alias token ${token}`);
  }
  for (const frag of ORACLE.leakFragments) {
    const re = new RegExp(`(?<![A-Za-z0-9])${frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    assert.ok(!re.test(text), `${where} leaks version fragment ${frag}`);
  }
  assert.ok(!ORACLE.residualIdRe.test(text), `${where} leaks a residual old-style model id`);
  assert.ok(!ORACLE.pseudonymAdjacentVersionRe.test(text), `${where} leaks a version fragment glued to a pseudonym/candidate id`);
  assert.ok(!ORACLE.partialCriteriaRe.test(text), `${where} has M1/M2/M3 criteria partially replaced by a pseudonym`);
  assert.ok(!ORACLE.sessionIdRe.test(text), `${where} leaks a session id`);
  assert.ok(!ORACLE.runIdRe.test(text), `${where} leaks a dispatch run id`);
}

/**
 * Strict base-field type contract for every body slot (the producer writes
 * these via redactNullableBodyString / capOutput / joinRows, so a drifted
 * value fails the dossier instead of being silently accepted):
 *   - terminal_state / stop_reason / failure_type: string|null;
 *   - result: exactly "ok";
 *   - output: string; output_chars: non-negative integer == output.length;
 *   - output_source: string; join_note: string;
 *   - redacted: when present, exactly true.
 */
function assertBodySlotBaseTypes(slot, where) {
  for (const k of ["terminal_state", "stop_reason", "failure_type"]) {
    assert.ok(typeof slot[k] === "string" || slot[k] === null,
      `${where} ${k} must be string|null, got ${JSON.stringify(slot[k])}`);
  }
  assert.equal(slot.result, "ok", `${where} result must be "ok"`);
  assert.equal(typeof slot.output, "string", `${where} output must be a string`);
  assert.ok(Number.isInteger(slot.output_chars) && slot.output_chars >= 0,
    `${where} output_chars must be a non-negative integer, got ${JSON.stringify(slot.output_chars)}`);
  assert.equal(slot.output_chars, slot.output.length, `${where} output_chars must equal output.length`);
  assert.equal(typeof slot.output_source, "string", `${where} output_source must be a string`);
  assert.equal(typeof slot.join_note, "string", `${where} join_note must be a string`);
  if (Object.hasOwn(slot, "redacted")) {
    assert.equal(slot.redacted, true, `${where} redacted must be exactly true when present`);
  }
}

// ── pure oracle fixtures (no production data; offline-safe) ────────────────

console.log("\nt0-episode-build production dossier — pure oracle fixtures\n");

await check("oracle.sessionIdRe / residualIdRe / runIdRe / family+leak boundary: canonical hyphenated UUIDv7 (any 8hex incl. 019f/01a0; underscore/uppercase too) rejects UUIDv4 / rep- / slot- / unhyphenated / hex-embedded; residual + run ids are alnum-context (underscore/uppercase caught, longer words never); family/leak tokens are alnum-context (dossier_openai_review.md caught, task3/sdk3/k3s never)", () => {
  const v7_019f = "019ff87f-13bd-70c8-abca-e4bb132c6140";
  const v7_019e = "019e1234-5678-7abc-8def-0123456789ab";
  const v7_01a0 = "01a0abcd-ef01-7a01-b234-567890abcdef";
  for (const id of [v7_019f, v7_019e, v7_01a0]) {
    assert.ok(ORACLE.sessionIdRe.test(id), `oracle must match UUIDv7 ${id}`);
    // Underscore-delimited / uppercase UUIDv7 (file-name / quoted forms) is
    // caught too — the redactor must redact it and the oracle must reject it.
    assert.ok(ORACLE.sessionIdRe.test(`_${id.toUpperCase()}`), `oracle must match underscore-adjacent uppercase UUIDv7 ${id.toUpperCase()}`);
  }
  // UUIDv4 (version nibble 4) must not match.
  const v4 = "550e8400-e29b-41d4-a716-446655440000";
  assert.ok(!ORACLE.sessionIdRe.test(v4), "UUIDv4 must not match");
  // Anonymous rep-/slot- HMAC ids must not match.
  assert.ok(!ORACLE.sessionIdRe.test("rep-1151132f9fe65e18"), "rep- HMAC must not match");
  assert.ok(!ORACLE.sessionIdRe.test("slot-rep-1151132f9fe65e18-c0dcace754bc"), "slot- HMAC must not match");
  // Unhyphenated 32-hex is not a session id under this contract.
  assert.ok(!ORACLE.sessionIdRe.test("019ff87f13bd70c8abcae4bb132c6140"), "unhyphenated 32hex must not match");
  // Hex-context lookaround: adjacent hex digits must not false-positive.
  assert.ok(!ORACLE.sessionIdRe.test(`aa${v7_019f}bb`), "hex-embedded UUIDv7 must not match");
  // Non-hex adjacency (e.g. underscore in filenames) still matches — lookaround is hex-only.
  assert.ok(ORACLE.sessionIdRe.test(`_${v7_019f}`), "underscore-adjacent UUIDv7 must match");
  // Residual ids: underscore-delimited / uppercase forms are leaks, longer
  // alphanumeric words never match.
  for (const leak of ["_m2", "artifact_m12.json", "M12", "m7"]) {
    assert.ok(ORACLE.residualIdRe.test(leak), `residual ${leak} must match`);
  }
  assert.ok(!ORACLE.residualIdRe.test("taskm12x"), "taskm12x must not match a residual id");
  // Run ids: artifact_dtr_… / _dtr_…_ / uppercase DTR_… are leaks, a longer
  // word (xdtr_…y) never matches.
  for (const leak of ["artifact_dtr_0123456789abcdef0123456789abcdef.json", "_dtr_0123456789abcdef0123456789abcdef_", "DTR_0123456789ABCDEF0123456789ABCDEF"]) {
    assert.ok(ORACLE.runIdRe.test(leak), `run id form ${leak} must match`);
  }
  assert.ok(!ORACLE.runIdRe.test("xdtr_0123456789abcdef0123456789abcdefy"), "xdtr_…y must not match a run id");
  // Family/leak boundary: underscore-delimited vendor/family tokens and the
  // bare ambiguous leak fragments are leaks (file names / field names);
  // longer alphanumeric words never match. The full dossier oracle
  // (assertNoOracleLeak) is the fail-closed check — "_K3_" / "field _M3_"
  // are leak FRAGMENTS (K3/M3), not family tokens, so checking familyTokens
  // alone would miss them; assert.throws proves the whole oracle rejects
  // them and accepts the ordinary words.
  for (const leak of ["dossier_openai_review.md", "run_deepseek/deepseek-v4-flash_log", "_K3_", "field _M3_"]) {
    assert.throws(() => assertNoOracleLeak(leak, "oracle fixture"), /leaks/, `${leak} must be rejected by the full oracle (family token, full name or leak fragment)`);
  }
  for (const ok of ["task3", "sdk3", "k3s", "block3", "chunk3"]) {
    assert.ok(!ORACLE.leakFragments.some((f) => new RegExp(`(?<![A-Za-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(ok)), `${ok} must never match a leak fragment`);
    assertNoOracleLeak(ok, "ordinary text");
  }
  // Full names / basenames are case-insensitive alnum-context tokens too:
  // uppercase underscore-delimited full names and standalone/_K3_ basenames
  // are leaks; longer alphanumeric words (task3/sdk3/k3s) never match.
  for (const leak of ["RUN_DEEPSEEK/DEEPSEEK-V4-FLASH_LOG", "_ANTHROPIC/CLAUDE-OPUS-5_", "DEEPSEEK/DEEPSEEK-V4-PRO"]) {
    assert.ok(ORACLE.modelNames.some((n) => new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(leak)), `${leak} must match a full model name`);
  }
  for (const leak of ["K3", "_K3_", "k3-256k"]) {
    assert.ok(oracleBasenames().some((b) => new RegExp(`(?<![A-Za-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(leak)), `${leak} must match a basename`);
  }
  for (const ok of ["task3", "sdk3", "k3s", "block3", "chunk3"]) {
    assert.ok(!oracleBasenames().some((b) => new RegExp(`(?<![A-Za-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(ok)), `${ok} must never match a basename`);
  }
});

await check("oracle.pseudonymAdjacentVersionRe: SHORT version grammar + alnum lookarounds + chain bounds — glued residues rejected (incl. bare [model]), mid-chain/date slices and full chains never, dates / candidate-vs-candidate / standalone versions / echoed anonymous ids never", () => {
  // Version fragments glued to a pseudonym/candidate id are rejected,
  // including the BARE pseudonym form `[model]` (production collapses it,
  // the oracle rejects the raw residue).
  for (const residue of ["[model-a]_[model-b]_4_8", "[model-a]_5.6_[model-b]", "[model-a]_v4_[model-b]", "c0_5", "c0-5", "[model-a]_4-8", "[model-a]_4_8", "5.6-[model-b]", "[model]-4", "c123_5", "c123-5", "[model-a]_V4", "[model]_V4", "c123_V4", "1-[model-a]-2", "1_[model]_2", "1_c0_2", "1.2-c123-v3_4", "c0-5_v4", "[model-a]-1-v2", "1-[model-a]-2-v3", "1-v2-c0", "c0-v1_V2-v3"]) {
    assert.ok(ORACLE.pseudonymAdjacentVersionRe.test(residue), `glued residue ${residue} must be rejected`);
  }
  // False positives stay ordinary text: a 4-digit year glued to a candidate
  // (date), dates, candidate-vs-candidate text, standalone version numbers,
  // space-separated review labels, a non-canonical leading-zero candidate
  // and echoed anonymous HMAC ids (incl. the accidental "8-c0" hex boundary
  // and a long c-run after a separator).
  for (const ok of [
    "c0-2026-05-28",
    "2026-05-28",
    "candidates c0-c1 diverged",
    "4-8",
    "R1 [model-a]",
    "slot-rep-1234567890123456-c01234567890",
    "slot-rep-1151132f9fe65e18-c0dcace754bc",
  ]) {
    assert.ok(!ORACLE.pseudonymAdjacentVersionRe.test(ok), `${ok} must never match the version-fragment grammar`);
  }
  // CHAIN BOUNDS: a longer chain must never be collapsed mid-way or leave a
  // residue — the regex must not fire on a partial slice (start inside a
  // `digit + [._-]` run) or swallow the first segments leaving `-4`/`_4`
  // (end before `[._-] + digit`), and the version slice `28-c0` inside a
  // date must never match.
  for (const ok of [
    "c0-1-2-3-4",
    "[model-a]_1_2_3_4",
    "1-2-3-4-c0",
    "released 2026-05-28-c0",
    "2026_05_28_c0",
    "c0-2026",
    "c0-c1",
    "c01_5",
    "c01-5",
    "1-2-3-4-c0-2",
    "1-c0-2-3-4-5",
    "1-[model-a]-V2-3-4-5",
    "c0-1-v2-3-4",
    "1-v2-3-4-c0",
  ]) {
    assert.ok(!ORACLE.pseudonymAdjacentVersionRe.test(ok), `${ok} must never match a partial version-fragment chain`);
  }
  // The full content oracle agrees (rejects residues incl. bare [model],
  // uppercase-V and SANDWICH forms; passes ordinary text and full chains).
  assert.throws(() => assertNoOracleLeak("Scored [model-af]_4_8 above baseline.", "fixture"), /glued to a pseudonym/);
  assert.throws(() => assertNoOracleLeak("raw [model]-4 residue", "fixture"), /glued to a pseudonym/);
  assert.throws(() => assertNoOracleLeak("[model-a]_V4 and 1_c0_2 and 1.2-c123-v3_4", "fixture"), /glued to a pseudonym/);
  assertNoOracleLeak("Released on c0-2026-05-28 and 2026-05-28; candidates c0-c1 diverged; slot-rep-1234567890123456-c01234567890.", "ordinary text");
  assertNoOracleLeak("Chains c0-1-2-3-4, [model-a]_1_2_3_4, 1-2-3-4-c0 and released 2026-05-28-c0 are ordinary text; c01_5 is not canonical.", "full chains + dates");
});

await check("redactor: alias-connected components merge into ONE model identity (github-copilot/gpt-5.5 + openai/gpt-5.5; claude-opus-4-8 + claude_opus_4_8 + 'Claude Opus 4 8'); reverse/rotated corpus order identical; non-overlapping alias sets distinct", () => {
  const key = "a".repeat(64);
  const pair = ["github-copilot/gpt-5.5", "openai/gpt-5.5"];
  const { redact } = M.buildEpisodeRedactor(key, "ep-1", pair, []);
  const a = redact("github-copilot/gpt-5.5");
  const b = redact("openai/gpt-5.5");
  assert.match(a, /^\[model-[a-z]+\]$/);
  assert.equal(a, b, "both routes sharing one basename must share one pseudonym");
  assert.equal(a, redact("gpt-5.5"), "the bare basename must share the merged pseudonym");
  assert.equal(a, redact("GPT 5.5"), "the space alias must share the merged pseudonym");
  // Reverse corpus order: same component key (min lower alias token) → same
  // pseudonym assignment → byte-identical output.
  const { redact: redactRev } = M.buildEpisodeRedactor(key, "ep-1", [...pair].reverse(), []);
  assert.equal(redactRev("github-copilot/gpt-5.5"), a, "reverse corpus order must assign the same pseudonym");
  assert.equal(redactRev("openai/gpt-5.5"), a, "reverse corpus order must assign the same pseudonym");
  // model↔family collision still resolves to the merged MODEL entity, and a
  // different basename stays a distinct entity.
  assert.equal(redact("gpt-5.5"), redact("gpt 5.5"), "family-token collision keeps the merged model pseudonym");
  assert.notEqual(a, redact("xai/grok-4.5"), "a different basename must stay a distinct pseudonym");
  // ALIAS-CONNECTED COMPONENT: three routes whose case-insensitive
  // [basename, ...aliasVariants] token sets overlap (claude-opus-4-8's
  // variants include `Claude Opus 4 8` / `Claude_Opus_4_8`, which are
  // exactly the other two basenames) must union into ONE anonymous model
  // identity — every full ref and every bare alias shares the pseudonym.
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
  const rot1 = [trio[1], trio[2], trio[0]];
  const rot2 = [trio[2], trio[0], trio[1]];
  for (const order of [rot1, rot2]) {
    const { redact: redactRot } = M.buildEpisodeRedactor(key, "ep-1", order, []);
    for (const name of trio) assert.equal(redactRot(name), c, `rotated corpus order must assign the same pseudonym to ${name}`);
  }
  // Non-overlapping alias token sets stay distinct entities.
  const { redact: redactMix } = M.buildEpisodeRedactor(key, "ep-1", [...trio, "xai/grok-4.5"], []);
  assert.notEqual(redactMix("xai/grok-4.5"), c, "a non-overlapping basename must stay a distinct pseudonym");
});

// ── real-data acceptance (production corpus) ───────────────────────────────

console.log("\nt0-episode-build production-data dossier (current /home/worker/.pi)\n");

// All scratch outputs live under os.tmpdir() and are removed in the finally
// block below — even when a build throws, the temp dir is cleaned up.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t0-episode-dossier-"));
try {
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
      assert.ok(episode.slots.every((s) => /^c(?:0|[1-9]\d*)$/.test(s.model_id)), `episode ${episode.episode_id} has a non-candidate model_id`);
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

  await check("real data: independent leak oracle passes on the FULL body content (prompt, tools, output, thinking, final stop reason, tool_calls incl. nested tool object keys, terminal/stop/failure, join/missing fields — canonical episode_id/slot_id/model_id excluded)", () => {
    for (const episode of realRun.episodes) {
      const fields = [];
      const push = (v) => {
        if (v === undefined || v === null) return;
        fields.push(typeof v === "string" ? v : JSON.stringify(v));
      };
      // Episode-level content surfaces. Canonical episode_id is NOT scanned
      // (an anonymous hash — it must never false-positive the oracle).
      push(episode.prompt);
      push(episode.tools);
      push(episode.thinking_level);
      push(episode.join_confidence);
      push(episode.missing_evidence);
      for (const s of episode.slots) {
        // Canonical slot_id / model_id are NOT scanned (anonymous hashes /
        // cN labels — they must never false-positive the oracle).
        push(s.output);
        push(s.output_source);
        push(s.output_chars);
        push(s.result);
        push(s.terminal_state);
        push(s.stop_reason);
        push(s.failure_type);
        push(s.join_confidence);
        push(s.join_note);
        push(s.missing_evidence);
        push(s.redacted);
        // Trajectory surfaces: thinking text, final stop reason and the FULL
        // tool_calls JSON (JSON.stringify covers nested tool object keys).
        push(s.thinking);
        push(s.thinking_chars);
        push(s.tool_calls);
        push(s.final_stop_reason);
      }
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

  await check("real data: dataset mode is STRICT — only two modes; final omits trajectory own-fields with empty missing evidence; full carries all four trajectory fields with exact types, self-consistent thinking_chars, a closed missing set, the exact slot-union episode missing and real recovered evidence", () => {
    const { stats } = realRun;
    const mode = stats.dataset_mode;
    assert.ok(mode === "final_answer_only" || mode === "full_trajectory",
      `dataset_mode must be one of final_answer_only|full_trajectory, got ${mode}`);
    const EPISODE_KEYS = ["schema_version", "dataset_mode", "episode_id", "prompt", "thinking_level", "tools", "model_count", "join_confidence", "missing_evidence", "slots"];
    const SLOT_BASE_KEYS = ["slot_id", "model_id", "output", "output_source", "output_chars", "result", "terminal_state", "stop_reason", "failure_type", "join_confidence", "join_note", "missing_evidence"];
    const SLOT_FULL_KEYS = [...SLOT_BASE_KEYS, "thinking", "thinking_chars", "tool_calls", "final_stop_reason"];
    const MISSING_TOKENS = new Set(["thinking_missing", "thinking_chars_mismatch"]);
    let trajectorySlots = 0;
    for (const episode of realRun.episodes) {
      // Exact own-key closure: unknown/new fields fail by default.
      assert.deepEqual(Object.keys(episode).sort(), [...EPISODE_KEYS].sort(),
        `episode ${episode.episode_id} own-key closure broken`);
      assert.equal(episode.dataset_mode, mode, `episode ${episode.episode_id} dataset_mode must match the corpus mode`);
      for (const slot of episode.slots) {
        // STRICT BIDIRECTIONAL own-key closure: expected keys are exactly
        // base|full PLUS `redacted` iff it is an own property. Every base/full
        // key must be PRESENT (a missing base key now fails — the old check
        // only rejected extra keys) and no extra key may appear; `redacted` is
        // optional but must never be an inherited property.
        const expectedSlotKeys = mode === "final_answer_only" ? [...SLOT_BASE_KEYS] : [...SLOT_FULL_KEYS];
        if (Object.hasOwn(slot, "redacted")) expectedSlotKeys.push("redacted");
        assert.deepEqual(Object.keys(slot).sort(), [...expectedSlotKeys].sort(),
          `episode ${episode.episode_id} slot own-key closure broken (expected ${expectedSlotKeys.join(",")})`);
        // Strict base-field types: terminal_state/stop_reason/failure_type are
        // string|null, result is exactly "ok", output/output_chars/output_source/
        // join_note are the producer's basic types, redacted is exactly true when
        // present.
        assertBodySlotBaseTypes(slot, `episode ${episode.episode_id}`);
        // missing_evidence: always an array of unique strings — a closed set in
        // full mode, exactly [] in final mode.
        assert.ok(Array.isArray(slot.missing_evidence), `episode ${episode.episode_id} slot missing_evidence must be an array`);
        assert.ok(slot.missing_evidence.every((t) => typeof t === "string"),
          `episode ${episode.episode_id} slot missing_evidence must be all strings`);
        assert.equal(new Set(slot.missing_evidence).size, slot.missing_evidence.length,
          `episode ${episode.episode_id} slot missing_evidence must have no duplicates`);
        if (mode === "final_answer_only") {
          // final: trajectory own fields must be ABSENT (Object.hasOwn — never
          // a prototype-satisfiable `in`); missing evidence exactly [].
          for (const k of ["thinking", "thinking_chars", "tool_calls", "final_stop_reason"]) {
            assert.ok(!Object.hasOwn(slot, k), `episode ${episode.episode_id} final-mode slot carries ${k}`);
          }
          assert.deepEqual(slot.missing_evidence, [], `episode ${episode.episode_id} final-mode slot carries missing evidence`);
        } else {
          // full: all four trajectory fields OWN (Object.hasOwn, never `in`),
          // exact types, self-consistent.
          for (const k of ["thinking", "thinking_chars", "tool_calls", "final_stop_reason"]) {
            assert.ok(Object.hasOwn(slot, k), `episode ${episode.episode_id} full-mode slot missing ${k}`);
          }
          assert.equal(typeof slot.thinking, "string", `episode ${episode.episode_id} thinking must be a string`);
          assert.ok(Number.isInteger(slot.thinking_chars) && slot.thinking_chars >= 0,
            `episode ${episode.episode_id} thinking_chars must be a non-negative integer, got ${JSON.stringify(slot.thinking_chars)}`);
          assert.equal(slot.thinking_chars, slot.thinking.length,
            `episode ${episode.episode_id} thinking_chars must equal the written thinking.length`);
          assert.ok(Array.isArray(slot.tool_calls), `episode ${episode.episode_id} tool_calls must be an array`);
          assert.ok(typeof slot.final_stop_reason === "string" || slot.final_stop_reason === null,
            `episode ${episode.episode_id} final_stop_reason must be string|null`);
          for (const tok of slot.missing_evidence) {
            assert.ok(MISSING_TOKENS.has(tok), `episode ${episode.episode_id} unexpected missing_evidence token ${tok}`);
          }
          if (slot.thinking.length > 0 || slot.tool_calls.length > 0) trajectorySlots++;
        }
      }
      // Episode missing_evidence: array of unique strings; EXACTLY the slot
      // union in full mode, exactly [] in final mode.
      assert.ok(Array.isArray(episode.missing_evidence), `episode ${episode.episode_id} missing_evidence must be an array`);
      assert.ok(episode.missing_evidence.every((t) => typeof t === "string"),
        `episode ${episode.episode_id} missing_evidence must be all strings`);
      assert.equal(new Set(episode.missing_evidence).size, episode.missing_evidence.length,
        `episode ${episode.episode_id} missing_evidence must have no duplicates`);
      if (mode === "full_trajectory") {
        // Episode missing_evidence must be EXACTLY the slot union (closed set).
        const union = [...new Set(episode.slots.flatMap((s) => s.missing_evidence))].sort();
        assert.deepEqual([...episode.missing_evidence].sort(), union,
          `episode ${episode.episode_id} missing_evidence must equal the exact slot union`);
      } else {
        assert.deepEqual(episode.missing_evidence, [], `episode ${episode.episode_id} final-mode episode missing_evidence must be empty`);
      }
    }
    if (mode === "full_trajectory") {
      // The full claim must be grounded in real evidence: at least one body
      // slot carries recovered thinking or tool calls.
      assert.ok(trajectorySlots >= 1,
        "full_trajectory mode requires >= 1 body slot with non-empty thinking or tool_calls");
    }
  });

  await check("real data: every episode thinking_level is null or a legal producer closed-set value (off|minimal|low|medium|high|xhigh|max)", () => {
    // Independently hardcoded closed set (never imported from production) —
    // the producer must never write an identity-bearing or drifted value.
    const LEGAL_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const episode of realRun.episodes) {
      assert.ok(episode.thinking_level === null || LEGAL_THINKING_LEVELS.has(episode.thinking_level),
        `episode ${episode.episode_id} has illegal thinking_level ${JSON.stringify(episode.thinking_level)}`);
    }
  });

  await check("real data: body slots are all result=ok, non-partial, non-empty; availability exclusions are counted", () => {
    const { stats } = realRun;
    for (const episode of realRun.episodes) {
      for (const slot of episode.slots) {
        // Strict base-field types (terminal_state/stop_reason/failure_type
        // string|null, result ok, output/output_chars/output_source/join_note
        // basic types, redacted===true when present).
        assertBodySlotBaseTypes(slot, `episode ${episode.episode_id}`);
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
      assert.ok(!ORACLE.runIdRe.test(serialized), `episode ${episode.episode_id} leaks a run id`);
      assert.ok(!ORACLE.sessionIdRe.test(serialized), `episode ${episode.episode_id} leaks a session id`);
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
    // The oracle's model list must cover the corpus (keeps the oracle honest):
    // every body model AND every absent-from-body corpus model.
    const oracleSet = new Set(ORACLE.modelNames);
    for (const name of Object.keys(stats.models.by_name)) {
      assert.ok(oracleSet.has(name), `body model ${name} is missing from the independent oracle`);
    }
    for (const name of stats.models.absent_from_body) {
      assert.ok(oracleSet.has(name), `absent-from-body corpus model ${name} is missing from the independent oracle`);
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
    // The Dataset mode section is mode-conditional and the two mode texts are
    // mutually exclusive (final never claims trajectory content, full never
    // claims "only final answers").
    const mode = realRun.stats.dataset_mode;
    assert.ok(mode === "final_answer_only" || mode === "full_trajectory", `unexpected dataset mode ${mode}`);
    assert.ok(readme.includes(mode), `README must declare the dataset mode ${mode}`);
    if (mode === "final_answer_only") {
      assert.ok(/contains only final answers/.test(readme), "final README must state the body contains only final answers");
      assert.ok(!/recovered thinking/.test(readme), "final README must not claim recovered trajectory content");
    } else {
      assert.ok(/recovered thinking/.test(readme), "full README must state recovered thinking/trajectory");
      assert.ok(readme.includes("tool-call trajectory"), "full README must state the tool-call trajectory");
      assert.ok(readme.includes("final stop reason"), "full README must state the final stop reason");
      assert.ok(readme.includes("missing_evidence"), "full README must state missing_evidence");
      assert.ok(!/only final answers/.test(readme), "full README must never claim 'only final answers'");
    }
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
      // Fail-closed: a tiny per-episode cap excludes episodes with a reason —
      // OR the empty-full fail-closed guard fires (a full_trajectory build
      // whose trajectory episodes were all excluded as too-large). Both are
      // legal cap outcomes; any OTHER error must propagate (never swallowed).
      let tiny = null;
      try {
        tiny = M.buildEpisodes(M.parseArgs({ output: dirCap, "max-episode-bytes": 100 }));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        assert.match(msg, /full_trajectory/,
          `a tiny max-episode-bytes build must either return or throw the empty-full fail-closed guard, got: ${msg}`);
      }
      if (tiny) {
        assert.ok(tiny.stats.availability.episodes_too_large > 0,
          `expected episodes excluded as too large, got ${tiny.stats.availability.episodes_too_large}`);
        assert.ok(tiny.exclusions.some((e) => e.reason === "episode_too_large"), "episode_too_large must be recorded in exclusions");
        // Mode-aware: a returned tiny build must be final_answer_only OR carry
        // real published trajectory evidence in full_trajectory mode.
        if (tiny.stats.dataset_mode === "full_trajectory") {
          const publishedTrajectory = tiny.episodes.some((e) => e.slots.some((s) =>
            (typeof s.thinking === "string" && s.thinking.length > 0)
            || (Array.isArray(s.tool_calls) && s.tool_calls.length > 0)));
          assert.ok(publishedTrajectory,
            "a returned tiny max-episode-bytes build in full_trajectory mode must carry real published trajectory evidence");
        }
      }
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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── summary ────────────────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} t0-episode-build production-data dossier checks`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
process.exit(1);
