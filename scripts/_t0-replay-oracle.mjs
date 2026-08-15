/**
 * _t0-replay-oracle — INDEPENDENTLY MAINTAINED fixed anti-leak oracle for the
 * T0 replay anonymous-body contract.
 *
 * The forbidden model names, basenames, family tokens, leaky version
 * fragments, residual old-style ids, source episode ids and cost/usage
 * markers are hardcoded here and deliberately NOT derived from the redactor's
 * own token lists — the redactor must pass the oracle, it must not define it
 * (no self-verification).
 *
 * Shared by the offline smoke (smoke-t0-replay.mjs) and the production
 * dossier (dossier-t0-replay-production.mjs) so the two never drift.
 *
 * Two complementary surfaces:
 *   - CONTENT (assertNoOracleLeak on replayBodyContentText): model names,
 *     basenames, family tokens, version fragments, partial criteria, source
 *     episode / session / run ids in prompt + slot outputs. Free-text JSON
 *     is LEGAL here: an answer may legitimately mention {"cost": …} /
 *     {"usage": …} / {"content_hash": …} — only real parsed object keys
 *     are structural sidecar markers (see STRUCTURE).
 *   - STRUCTURE (assertAnonymousBodyStructure): the parsed episode object's
 *     exact key allow-lists, anonymous id shapes and sidecar markers (cost /
 *     usage / content_hash / … forbidden as ANY object key at ANY depth,
 *     exact key match) — it never scans HMAC episode_id/slot_id with
 *     pseudonymAdjacentVersionRe (anonymous ids are not a leak surface, and
 *     the short-version + ASCII-alphanumeric-context grammar never matches
 *     their hex boundaries anyway, so an echoed id in content is legal).
 *   - assertAnonymousReplayBody composes both. The key allow-lists below are
 *     INDEPENDENT hardcoded copies — never imported from t0-replay-build's
 *     BODY_EPISODE_KEYS/BODY_SLOT_KEYS — so the oracle verifies the
 *     redactor/body contract instead of inheriting it.
 */

import assert from "node:assert/strict";

export const ORACLE = {
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
  // M1 is deliberately NOT an ambiguous identity token, so this content is
  // rejected HERE (the oracle), not consumed by the redactor/ambiguity scan.
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
  // a 4-digit year ("c0-2026-05-28"), dates
  // ("2026-05-28"), standalone version numbers ("4-8"), candidate-vs-
  // candidate text ("candidates c0-c1 diverged"), space-separated digits
  // ("R1 [model-af]"), a non-canonical leading-zero candidate ("c01_5")
  // and echoed anonymous HMAC ids
  // ("slot-rep-…-c01234567890" / "…e18-c0dc…" hex boundaries) are ordinary
  // text, not leaks. Independently maintained — never imported from
  // production's PSEUDONYM_VERSION_RE.
  pseudonymAdjacentVersionRe: /(?<![A-Za-z0-9])(?<!\d[._-])(?:(?:\[model(?:-[a-z]+)?\]|c(?:0|[1-9]\d*))[_-][vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}|[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}[_-](?:\[model(?:-[a-z]+)?\]|c(?:0|[1-9]\d*))[_-][vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}|[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}[_-](?:\[model(?:-[a-z]+)?\]|c(?:0|[1-9]\d*)))(?![A-Za-z0-9]|[._-][vV]?\d)/,
  // Source episode id shape, ALPHANUMERIC-CONTEXT + case-insensitive (never
  // \b: "_" is a word char, so \b misses artifact_ep-<16 hex>.json, and the
  // ids are canonical lowercase). Matches ep-<16 hex> embedded between
  // separators (_ . - space …) and uppercase EP-…, but NEVER the anonymous
  // rep-<16 hex> / slot-rep-… HMAC ids ("ep" there is preceded by an
  // alphanumeric "r"). Deliberately NON-global: a /g regex in assertNoOracleLeak
  // would carry lastIndex across .test() calls (flake). The production
  // replace (t0-replay-build SOURCE_EPISODE_ID_RE) is the equivalent /gi
  // form; this oracle regex is independently maintained, never imported.
  sourceEpisodeIdRe: /(?<![A-Za-z0-9])ep-[0-9a-f]{16}(?![A-Za-z0-9])/i,
  // STRUCTURAL sidecar markers ONLY: consumed exclusively by
  // assertAnonymousBodyStructure's walkObjectKeys (a parsed object key at
  // ANY depth fails closed). They are NEVER scanned in free text — an answer
  // that mentions {"cost": …} / {"usage": …} / {"content_hash": …} in
  // prose/JSON-in-string is legal content, not a leak.
  costMarkers: ["cost", "tokens_in", "tokens_out", "duration_ms", "attempt_log", "called_at", "usage", "blind_key", "source_episode_id", "content_hash", "output_source", "join_confidence", "join_note"],
  // Session ids are UUIDv7 (8-4-7xxx-variant-12, e.g.
  // 019ff87f-13bd-70c8-abca-e4bb132c6140; the 019e/019f/01a0 ULID-style
  // prefixes are just the timestamp half). The full shape never matches
  // UUIDv4 ids or the anonymous rep-/slot- HMAC hex ids. Hex-context
  // lookarounds (not \b) + case-insensitive: an underscore-delimited /
  // uppercase UUIDv7 (`_019FF87F-…_`) is caught too.
  sessionIdRe: /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f])/i,
  // Dispatch run ids (`dtr_<hex>`) — ASCII-alphanumeric-context +
  // case-insensitive (never \b): `artifact_dtr_<hex>.json` / `_dtr_<hex>_` /
  // uppercase `DTR_<HEX>` are all caught, while a longer alphanumeric word
  // (`xdtr_…y`) never matches. NON-global like every ORACLE regex.
  runIdRe: /(?<![A-Za-z0-9])dtr_[0-9a-f]{20,}(?![A-Za-z0-9])/i,
};

export function oracleBasenames() {
  return ORACLE.modelNames.map((n) => n.slice(n.lastIndexOf("/") + 1));
}

export function assertNoOracleLeak(text, where) {
  // Full model names are matched as case-insensitive ALPHANUMERIC-CONTEXT
  // tokens (never a bare substring, never \b): a full name is a leak only as
  // a standalone/separator-delimited token, so an uppercase underscore-
  // delimited form (RUN_DEEPSEEK/DEEPSEEK-V4-FLASH_LOG) is still rejected
  // while a longer alphanumeric word containing the name (xkimi-coding/k3y)
  // is not. Same boundary as the basenames below.
  for (const name of ORACLE.modelNames) {
    const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    assert.ok(!re.test(text), `${where} leaks full model name ${name}`);
  }
  // Basenames are matched as case-insensitive ALPHANUMERIC-CONTEXT tokens
  // (never a bare substring, never \b): a basename is a leak only as a
  // standalone/separator-delimited token, so task3 / sdk3 / block3 / chunk3 /
  // k3s are NOT false-killed by the basename "k3", while a standalone K3 or
  // an underscore-delimited _K3_ (an id inside a file name / field name) is
  // still rejected. Family-token / leak-fragment checks below use the same
  // boundary.
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
  assert.ok(!ORACLE.sourceEpisodeIdRe.test(text), `${where} leaks a source episode id`);
  assert.ok(!ORACLE.sessionIdRe.test(text), `${where} leaks a session id`);
  assert.ok(!ORACLE.runIdRe.test(text), `${where} leaks a dispatch run id`);
  // NOTE: ORACLE.costMarkers are deliberately NOT scanned here. Free-text
  // JSON fragments ({"cost": …, {"usage": …, {"content_hash": …) are LEGAL
  // answer content; the structural oracle (assertAnonymousBodyStructure)
  // fails closed on those keys only as real parsed object keys via
  // walkObjectKeys.
}

/**
 * Content fields of an anonymous replay body (prompt + slot outputs) — the
 * surface the oracle is applied to, mirroring the episode-build oracle
 * (smoke-t0-episode-build.mjs checks prompt + outputs, never structural
 * metadata). Structural fields are deliberately excluded: episode_id and
 * slot_id are HMAC hex whose <hex-digit>-c<digits> boundaries randomly match
 * pseudonymAdjacentVersionRe without being leaks, and the body's exact key
 * set is already enforced by assertAnonymousBody at write time.
 *
 * FAILS CLOSED on non-string prompt / slot outputs: joining a nested object
 * would stringify it as "[object Object]" and smuggle identity into the
 * scan surface — a nested object is a structural violation, not content,
 * and must never be scanned as text.
 */
export function replayBodyContentText(episode) {
  if (typeof episode.prompt !== "string") {
    throw new Error("replayBodyContentText: episode.prompt must be a string (a nested object would be joined as [object Object])");
  }
  for (const slot of episode.slots ?? []) {
    if (typeof slot.output !== "string") {
      throw new Error("replayBodyContentText: slot.output must be a string (a nested object would be joined as [object Object])");
    }
  }
  return [episode.prompt, ...(episode.slots ?? []).map((s) => s.output)].join("\n");
}

// ── structural oracle (independent of t0-replay-build) ────────────────────

/**
 * Anonymous replay body top-level key allow-list. INDEPENDENT hardcoded copy
 * of t0-replay-build's BODY_EPISODE_KEYS — deliberately NOT imported, so the
 * oracle stays an independent verifier of the body contract.
 */
export const ANONYMOUS_BODY_TOP_KEYS = Object.freeze([
  "schema_version",
  "dataset_mode",
  "episode_id",
  "prompt",
  "thinking",
  "tools",
  "slots",
]);

/**
 * Anonymous replay body slot key allow-list. INDEPENDENT hardcoded copy of
 * t0-replay-build's BODY_SLOT_KEYS — deliberately NOT imported.
 */
export const ANONYMOUS_BODY_SLOT_KEYS = Object.freeze([
  "slot_id",
  "model_id",
  "output",
  "result",
]);

/**
 * Anonymous body schema_version. INDEPENDENT hardcoded value of the current
 * episode schema (t0-episode-build EPISODE_SCHEMA_VERSION = 3) — the oracle
 * pins the exact value itself, never importing it from production, so a
 * production schema drift cannot silently pass a stale body.
 */
export const ANONYMOUS_BODY_SCHEMA_VERSION = 3;

/**
 * Anonymous body thinking allow-list. INDEPENDENT hardcoded copy of
 * t0-replay-build's EXTENDED_THINKING_LEVELS — a nested object or null
 * smuggled into `thinking` must never pass the key allow-list alone.
 */
export const ANONYMOUS_BODY_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Anonymous replay episode id: rep- + 16 hex (HMAC sha256 slice). */
export const ANONYMOUS_EPISODE_ID_RE = /^rep-[0-9a-f]{16}$/;

/** Source episode id shape (what the anonymous id must NOT match). */
export const SOURCE_EPISODE_ID_RE = /^ep-[0-9a-f]{16}$/;

/**
 * Anonymous generated slot id shape: slot-<anonymous episode id>-<12 hex>
 * (HMAC sha256 slice, carries no roster position).
 */
export const ANONYMOUS_SLOT_ID_RE = /^slot-rep-[0-9a-f]{16}-[0-9a-f]{12}$/;

/** Episode-local canonical candidate id: c0, c1, c12, c123, … (no leading
 * zeros — `c01` is NOT canonical) — never a real model ref. */
export const ANONYMOUS_MODEL_ID_RE = /^c(?:0|[1-9]\d*)$/;

function walkObjectKeys(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkObjectKeys(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      visit(key);
      walkObjectKeys(value[key], visit);
    }
  }
}

/**
 * PURE STRUCTURAL anti-leak oracle for one anonymous replay body episode.
 * Fails closed on the parsed object (no text scanning here):
 *
 *   - top-level / slot keys must be EXACTLY the anonymous body allow-lists
 *     (missing AND extra keys both rejected)
 *   - the EXACT public type/value contract is enforced, not just the keys:
 *     schema_version must be the current anonymous episode schema
 *     (ANONYMOUS_BODY_SCHEMA_VERSION = 3, independently hardcoded),
 *     dataset_mode must be "replay", episode_id/prompt/thinking must be
 *     strings with the anonymous id shape, thinking must be one of the
 *     independent hardcoded extended thinking levels (never an object /
 *     null), tools must be strict null, slots must be an array, and every
 *     slot field (slot_id / model_id / output / result) must be a string
 *     with the anonymous id shapes scoped to the episode; result must be
 *     "ok" — a nested object smuggled into prompt / thinking / output can
 *     never pass the key allow-list alone
 *   - NO nested object key may match a sidecar marker (cost, tokens_in,
 *     tokens_out, duration_ms, attempt_log, called_at, usage, blind_key,
 *     source_episode_id, content_hash, output_source, join_confidence,
 *     join_note) — exact key match, never substring, so ordinary words in
 *     free-text values are not false-killed (values are not scanned here;
 *     the content oracle covers prompt/output text)
 *   - tools must be strict null
 *   - episode_id must be anonymous rep-<16 hex> and not a source ep-… id
 *   - each slot.model_id must be a canonical candidate cN (`c(?:0|[1-9]\d*)`, no leading zeros)
 *   - each slot.slot_id must match the anonymous generated shape
 *     (slot-<episode_id>-<12 hex>), be scoped to its own episode_id and
 *     contain no source model name
 *   - each slot.result must be "ok" (only successful slots enter the body)
 *
 * Deliberately does NOT apply pseudonymAdjacentVersionRe to episode_id /
 * slot_id: anonymous ids are not a leak surface — and the bounded short-
 * version grammar + ASCII-alphanumeric-context lookarounds never match
 * their hex boundaries anyway (an accidental "8-c0" inside "…e18-c0dc…"
 * is blocked by the trailing alnum), so an echoed anonymous id in CONTENT
 * is legal (assertNoOracleLeak) with no random flake.
 */
export function assertAnonymousBodyStructure(episode, where = "anonymous replay body") {
  assert.ok(episode && typeof episode === "object" && !Array.isArray(episode), `${where}: episode must be an object`);
  // Sidecar markers are forbidden as ANY object key, at any nesting depth
  // (top-level, slot, or a nested object inside an allowed key's value).
  walkObjectKeys(episode, (key) => {
    assert.ok(!ORACLE.costMarkers.includes(key), `${where}: leaks sidecar key "${key}"`);
  });
  const topKeys = Object.keys(episode).sort();
  assert.deepEqual(topKeys, [...ANONYMOUS_BODY_TOP_KEYS].sort(), `${where}: top-level keys must be exactly the anonymous body allow-list`);
  // EXACT public type/value contract (independent of production constants):
  // the key allow-list alone must never admit a nested object / wrong value
  // smuggled into a public field.
  assert.equal(episode.schema_version, ANONYMOUS_BODY_SCHEMA_VERSION, `${where}: schema_version must be the current anonymous episode schema ${ANONYMOUS_BODY_SCHEMA_VERSION}, got ${JSON.stringify(episode.schema_version)}`);
  assert.equal(episode.dataset_mode, "replay", `${where}: dataset_mode must be "replay", got ${JSON.stringify(episode.dataset_mode)}`);
  assert.equal(typeof episode.episode_id, "string", `${where}: episode_id must be a string, got ${typeof episode.episode_id}`);
  assert.match(episode.episode_id, ANONYMOUS_EPISODE_ID_RE, `${where}: episode_id must be anonymous rep-<16 hex>`);
  assert.ok(!SOURCE_EPISODE_ID_RE.test(episode.episode_id), `${where}: episode_id must not match a source ep-… id`);
  assert.equal(typeof episode.prompt, "string", `${where}: prompt must be a string, got ${typeof episode.prompt}`);
  assert.equal(typeof episode.thinking, "string", `${where}: thinking must be a string, got ${typeof episode.thinking}`);
  assert.ok(ANONYMOUS_BODY_THINKING_LEVELS.includes(episode.thinking), `${where}: thinking must be one of ${ANONYMOUS_BODY_THINKING_LEVELS.join("/")}, got ${JSON.stringify(episode.thinking)}`);
  assert.equal(episode.tools, null, `${where}: tools must be null`);
  assert.ok(Array.isArray(episode.slots), `${where}: slots must be an array`);
  for (const slot of episode.slots) {
    assert.ok(slot && typeof slot === "object" && !Array.isArray(slot), `${where}: each slot must be an object`);
    const slotKeys = Object.keys(slot).sort();
    assert.deepEqual(slotKeys, [...ANONYMOUS_BODY_SLOT_KEYS].sort(), `${where}: slot keys must be exactly the anonymous body allow-list`);
    assert.equal(typeof slot.slot_id, "string", `${where}: slot slot_id must be a string, got ${typeof slot.slot_id}`);
    assert.equal(typeof slot.model_id, "string", `${where}: slot model_id must be a string, got ${typeof slot.model_id}`);
    assert.equal(typeof slot.output, "string", `${where}: slot output must be a string, got ${typeof slot.output}`);
    assert.equal(typeof slot.result, "string", `${where}: slot result must be a string, got ${typeof slot.result}`);
    assert.match(slot.model_id, ANONYMOUS_MODEL_ID_RE, `${where}: slot model_id must be a canonical candidate cN`);
    assert.match(slot.slot_id, ANONYMOUS_SLOT_ID_RE, `${where}: slot_id must match the anonymous generated shape slot-<episode_id>-<12 hex>`);
    assert.ok(slot.slot_id.startsWith(`slot-${episode.episode_id}-`), `${where}: slot_id must be scoped to its own anonymous episode_id`);
    for (const base of oracleBasenames()) {
      assert.ok(!slot.slot_id.includes(base), `${where}: slot_id contains source model name ${base}`);
    }
    assert.equal(slot.result, "ok", `${where}: slot result must be "ok"`);
  }
}

/**
 * Combined anonymous replay body oracle: STRUCTURE (assertAnonymousBodyStructure)
 * + CONTENT (assertNoOracleLeak over prompt + slot outputs). Smoke and dossier
 * call this. t0-replay-build's own assertAnonymousBody stays the production
 * write-time guard — an independent check, never the oracle's source.
 */
export function assertAnonymousReplayBody(episode, where = "anonymous replay body") {
  assertAnonymousBodyStructure(episode, where);
  assertNoOracleLeak(replayBodyContentText(episode), where);
}
