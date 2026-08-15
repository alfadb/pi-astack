#!/usr/bin/env node
/**
 * t0-replay-build — fair prompt-only production replay of current models.
 *
 * MUST consume a fair selection manifest from t0-replay-select
 * (`--selection selection.json`). The legacy internal selector remains only
 * for fixture unit tests and is NOT a fair-selection bypass for production
 * runs — CLI without --selection fails closed. Production selection must
 * carry full `selected[]` records (episode_ids-only is rejected).
 *
 * Two experiment modes:
 *
 * 1) Fair default (source thinking):
 *    Replays deepseek/deepseek-v4-flash + xai/grok-4.5 on selected prompts.
 *    Both models receive the SAME neutral system/user protocol, NO tools,
 *    and the SAME thinking = each source episode's original thinking_level.
 *    Body may include historical + successful replay slots (indistinguishable).
 *    `--thinking` override is forbidden on this path.
 *
 * 2) `--current-only` (equal conditions):
 *    Replays deepseek/deepseek-v4-flash, xai/grok-4.5, openai/gpt-5.5 control.
 *    Same neutral system/user, NO tools, thinking unified to explicit `high`
 *    (bound into protocol_hash). Body contains ONLY the three current
 *    candidates (history_excluded). An episode enters the paired capability
 *    body only when ALL three succeed; otherwise sidecar/checkpoint keep
 *    attempts+cost but the episode is excluded from the main set.
 *    experiment_mode=current_models_equal_conditions.
 *
 * Body is a fresh anonymous episode set: only t0-eval-needed fields
 * (prompt/dataset_mode/thinking/tools=null/slots{slot_id,model_id,output,result}).
 * All identity, source, attempt, cost, join live in the meta sidecar.
 * Outputs only include checkpoints matching current selection_hash +
 * protocol_hash (old checkpoints never mix into episodes/stats).
 *
 * Usage:
 *   node scripts/t0-replay-build.mjs --selection <manifest.json> [options]
 *   node scripts/t0-replay-build.mjs --selection <manifest.json> --current-only [options]
 */

import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  nonNegativeInt,
  parseStrictCli,
  isSafeDecimal,
  NONNEGATIVE_DECIMAL_RE,
  POSITIVE_DECIMAL_RE,
  loadEpisodes,
  loadExclusionRecords,
  loadStats,
  makeJudgeInvoker,
  callJudge,
  sumAttemptCosts,
  aggregateCostSource,
  sleep,
  sha256Hex,
  asRecord,
  episodeContentHash,
  summarizeFailedOutput,
  ATTEMPT_LEDGER_VERSION,
  ATTEMPT_LEDGER_CONTRACT_ID,
  validateAttemptLedgerV2,
  summarizeCosts,
  assertProducerInventory,
  writeTextFileAtomic,
} from "./t0-eval-common.mjs";

import {
  EPISODE_SCHEMA_VERSION,
  BLIND_KEY_FILE,
  BLIND_KEY_HEX_LENGTH,
  resolveBlindKey,
  buildEpisodeRedactor,
  detectAmbiguousIdentityTokens,
  collectResidualIds,
  episodeLocalModelIds,
  episodeSlotId,
  episodeSlotOrder,
  capOutput,
  utf8ByteLength,
  TRUNCATED_MARKER,
} from "./t0-episode-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  assertAnonymousReplayBody,
  assertNoOracleLeak,
} from "./_t0-replay-oracle.mjs";

export const REPLAY_SCHEMA_VERSION = 1;
/**
 * Fixed, protocol-stable slot-level oracle rejection marker written to the
 * checkpoint sidecar (`replay.error`). The independent oracle's assertion
 * DETAIL (which token leaked, in which wording) must never become a stable
 * semantic of the checkpoint public sidecar: the oracle text may evolve
 * (new tokens / rewording) without invalidating checkpoints — the
 * contextual rebuild deep-compares the sidecar, so only a fixed string is
 * deterministic across oracle edits. The detailed assertion text is only
 * ever surfaced in the source-preflight console (quiet=false) and is
 * discarded for slots; the public source-preflight exclusion `detail` is the
 * separate fixed REPLAY_SOURCE_ORACLE_REJECTION_ERROR string.
 */
export const REPLAY_ORACLE_REJECTION_ERROR = "oracle content rejection";
/**
 * Fixed, protocol-stable SOURCE-preflight oracle rejection marker written to
 * the public exclusions (`source_oracle_content_rejected` records). The
 * independent oracle's assertion DETAIL (which token leaked, in which
 * wording) must never become a stable semantic of the public exclusions /
 * stats: the oracle text may evolve (new tokens / rewording) without
 * changing the public payload — the exclusion `detail` is always this fixed
 * string (stable shape), and the real assertion message is only ever
 * surfaced in the `quiet=false` source-preflight console via a separate
 * in-memory map, never in any public file. A regression test simulates
 * different oracle assertion texts and asserts the public payload stays
 * byte-identical.
 */
export const REPLAY_SOURCE_ORACLE_REJECTION_ERROR = "source oracle content rejection";
/**
 * Redactor identity bound into the replay protocol hash. Still the same
 * NOT-YET-PUBLISHED v6 increment (there is no v7): the double-review fixes
 * below are part of v6, which has never produced a canonical checkpoint.
 * v5 → v6 covers the shared alnum-context boundary / run+residual /
 * empty-universe defense:
 *   - the episode redactor and the independent oracle now apply the SAME
 *     ASCII-alphanumeric-context boundary (never \b) to every known-token
 *     scan: underscore-delimited full names / vendor / family / alias
 *     tokens (`dossier_openai_review.md`, `run_deepseek/deepseek-v4-flash_log`,
 *     `_openai/gpt-5.6-sol_`) redact fully, while longer alphanumeric words
 *     (`task3`/`sdk3`/`k3s`) are never false-killed;
 *   - underscore-INTERNAL model aliases are now full model-entity tokens:
 *     aliasVariants generates the finite complete `-`/space/`_` separator
 *     combination, so `claude_opus_4-8` / `gpt_5.6_sol` /
 *     `deepseek_v4_flash` (and the `anthropic/claude_opus_4-8` provider
 *     form) redact whole with one pseudonym, never a version residue; the
 *     production PSEUDONYM_VERSION_RE and both independent oracle copies
 *     reject/collapse `_`/`-`-glued pseudonym/cN + [vV]?-version chains;
 *     the SANDWICH `VERSION[_-]PSEUDO[_-]VERSION` form collapses entirely
 *     to the middle pseudo/candidate, so a partially redacted model name
 *     never leaves a version fragment on either side;
 *   - the token→pseudonym lookup keeps EXPLICIT model-entity priority, so
 *     a basename/alias that is also a family token (`gpt-5.5`/`grok-4.5`/
 *     `glm-5.2`/`minimax-m3`) keeps ONE model pseudonym (referential
 *     consistency), never the sort order / last-write; and MODEL IDENTITY
 *     ENTITIES are now ALIAS-CONNECTED COMPONENTS over the case-insensitive
 *     `[basename, ...aliasVariants]` token sets (small DSU equivalence
 *     closure) — two routes sharing one basename
 *     (`github-copilot/gpt-5.5` + `openai/gpt-5.5`), or one basename being
 *     another model's alias variant (`claude-opus-4-8` +
 *     `vendor/claude_opus_4_8` + `Claude Opus 4 8`), are ONE anonymous
 *     model identity whose full refs / bare basenames / aliases all share
 *     one pseudonym; the component key is the corpus-order-independent
 *     minimum lowercased alias token (a per-route / per-case first-wins
 *     split could never make both full refs AND the bare basenames
 *     consistent, and no two model entities can share a replaceable
 *     token);
 *   - ALIAS INPUT BOUNDS + numeric-underscore expansion: aliasVariants
 *     fails closed on an empty / over-long basename, an empty part
 *     (leading / trailing / double hyphen) or more than 8 expanded parts
 *     (max 3^7 = 2187 combinations), and re-expands pure numeric compound
 *     parts (`4-8` → `4`,`8`) so `claude_opus_4_8` / `claude-opus-4_8` /
 *     `claude_opus_4-8` are the SAME whole-alias token (no `_8` residue);
 *   - SHORT version-fragment grammar, CHAIN-BOUNDED: the production
 *     collapse regex and both independent oracle copies now use
 *     `[vV]?\d{1,2}(?:[._-][vV]?\d{1,2}){0,2}` (the leading `v` is covered
 *     explicitly for both cases, never a whole-regex `/i`) with a canonical
 *     candidate cN
 *     (`c(?:0|[1-9]\d*)`, no leading zeros) and a `\[model(?:-[a-z]+)?\]`
 *     pseudonym side (bare `[model]` included) under
 *     ASCII-alphanumeric-context lookarounds plus `(?<!\d[._-])` /
 *     `(?![A-Za-z0-9]|[._-][vV]?\d)` chain bounds, with a SANDWICH
 *     `VERSION[_-]PSEUDO[_-]VERSION` alternative ordered before the
 *     version-first pair (so a v-prefixed right-hand version is never
 *     orphaned) — `[model-a]_[model-b]_4_8`,
 *     `[model-a]_5.6_[model-b]`, `[model-a]_v4_[model-b]`, `[model-a]_V4`,
 *     `c0_5`, `c0-5`,
 *     `[model]-4` and the sandwiches `1-[model-a]-2` / `1_c0_2` /
 *     `1.2-c123-v3_4` collapse/reject, while `c0-2026-05-28`, dates, standalone
 *     `4-8`, `candidates c0-c1 diverged`, `R1 [model-a]`, echoed anonymous
 *     HMAC ids (`slot-rep-…-c01234567890` / the accidental `8-c0` hex
 *     boundary) and FULL chains / date-version slices
 *     (`c0-1-2-3-4`, `[model-a]_1_2_3_4`, `1-2-3-4-c0`,
 *     `released 2026-05-28-c0`, `2026_05_28_c0`, `c0-2026`, `c01_5`) and
 *     four-segment sandwiches with either side extended
 *     (`1-2-3-4-c0-2`, `1-c0-2-3-4-5`)
 *     never match (the old "deliberately unbounded" oracle narrative is
 *     gone; a chain is never collapsed mid-way or left with a residue);
 *   - dispatch run ids are now alnum-context + case-insensitive
 *     (`artifact_dtr_<hex>.json` / `_dtr_<hex>_` / uppercase `DTR_<HEX>` all
 *     redact; `xdtr_…y` never matches) and the oracle explicitly scans them;
 *   - residual old-style ids (`_m2` / `artifact_m12.json` / uppercase `M12`)
 *     are collected/redacted/rejected with the same boundary + `i`;
 *   - session ids (UUIDv7) are hex-context + case-insensitive (uppercase
 *     UUIDv7 caught);
 *   - the redactor no longer identity-returns on an empty entity universe:
 *     session/run/residual replacement runs even with zero known tokens;
 *   - the anonymous-body oracle (assertAnonymousBodyStructure) and the
 *     production write guard (assertAnonymousBody) enforce the EXACT public
 *     type/value contract (schema_version/dataset_mode/episode_id/prompt/
 *     thinking/tools/slots/slot types, shapes and result) with EXACT OWN
 *     keys (Object.hasOwn — an inherited `prompt` is never an own key) and
 *     reject null / non-object / array episodes and null / array slots, not
 *     just keys;
 *   - writeOutputs snapshots `{episodes, sidecar, exclusions, stats}` into
 *     one-time canonicalized plain JSON BEFORE any guard/mkdir/write — all
 *     guards and the renderer operate only on the snapshot, so a getter
 *     that changes on re-read can never make the guarded bytes differ from
 *     the written bytes (no guard/render TOCTOU);
 *   - the slot-level oracle rejection sidecar error is a FIXED stable string
 *     (REPLAY_ORACLE_REJECTION_ERROR), never the oracle's assertion detail.
 * Old checkpoints built under v1/v2/v3/v4/v5 (different boundary semantics /
 * underscore leaks / run+residual gaps / empty-universe identity return /
 * key-only body checks / per-route basename splitting / unbounded version
 * grammar / oracle-text-dependent sidecar errors) carry a different
 * protocol_hash and are never resumed.
 */
export const REPLAY_REDACTOR_ID = "episode-local-v6";
/**
 * Replay checkpoint contract id — the structural binding increment that made
 * every replay checkpoint carry the private raw-output replay material and
 * made checkpointValid a contextual rebuild validator. Bound into the replay
 * protocol hash (NOT a ledger v3 bump — ATTEMPT_LEDGER_VERSION stays 2): old
 * material-less checkpoints carry a different protocol_hash and are stale,
 * so they are never resumed/admitted. This is a structural internal binding,
 * NOT a provider attestation.
 */
export const REPLAY_CHECKPOINT_CONTRACT_ID = "t0-replay-checkpoint-v1:raw-output-material+contextual-rebuild";
/**
 * Exact top-level key set of a replay checkpoint as the current producer
 * writes it (processEpisode). checkpointValid enforces this closed set — an
 * extra key can smuggle private data into the public surfaces, a missing key
 * can hide a required binding. This is a structural internal binding, NOT a
 * provider attestation.
 */
export const REPLAY_CHECKPOINT_TOP_KEYS = Object.freeze([
  "ledger_version",
  "schema_version",
  "source_episode_id",
  "source_content_hash",
  "source_thinking",
  "replay_thinking",
  "selection_hash",
  "protocol_hash",
  "experiment_mode",
  "history_excluded",
  "replay_models",
  "replay_material",
  "episode",
  "sidecar",
  "exclusion",
  "built_at",
]);
/**
 * Exact key set of one private replay-material entry (buildReplayMaterial).
 * The raw accepted output lives ONLY under `raw_accepted_output` — a name
 * that cannot collide with the legitimate `output` field of body slots — and
 * is mapped back to `output` only when rebuilding via materialToReplayResults.
 */
export const REPLAY_MATERIAL_ENTRY_KEYS = Object.freeze([
  "model",
  "ok",
  "raw_accepted_output",
  "calledAt",
  "thinking",
  "attempts",
  "attempt_log",
  "cost",
  "cost_source",
  "usage",
  "error",
  "error_class",
  "exclusion_reason",
]);
export const REPLAY_DEFAULT_MODELS = ["deepseek/deepseek-v4-flash", "xai/grok-4.5"];
/** Equal-conditions current-only candidates (Flash + Grok + GPT-5.5 control). */
export const CURRENT_ONLY_MODELS = Object.freeze([
  "deepseek/deepseek-v4-flash",
  "xai/grok-4.5",
  "openai/gpt-5.5",
]);
export const CURRENT_ONLY_THINKING = "high";
export const CURRENT_ONLY_EXPERIMENT_MODE = "current_models_equal_conditions";
export const REPLAY_DEFAULT_THINKING = "high"; // legacy fixture / current-only unified level
export const REPLAY_DEFAULT_LIMIT = 2;
export const REPLAY_DEFAULT_CONCURRENCY = 2;
export const REPLAY_DEFAULT_MAX_RETRIES = 2;
export const REPLAY_DEFAULT_TIMEOUT_MS = 600_000;
export const REPLAY_DEFAULT_MAX_OUTPUT_BYTES = 200_000;
export const REPLAY_DEFAULT_MAX_EPISODE_BYTES = 1_000_000;
export const REPLAY_DEFAULT_MAX_TOTAL_BYTES = 500_000_000;
export const REPLAY_SELECTION_KIND = "prompt_only_replay_selection";
export const REPLAY_SELECTION_SCHEMA_VERSION = 1;
export const DATASET_COMMIT_FILE = "dataset.commit.json";
export const REPLAY_DATASET_GENERATION_KIND = "t0_replay_dataset_generation";
export const REPLAY_DATASET_GENERATION_SCHEMA_VERSION = 1;
export const REPLAY_DATASET_GENERATION_CONTRACT_ID = "t0-replay-dataset-generation-v1";
/**
 * Producer contract id of the replay DATASET producer (t0-replay-build's
 * derive/buildStats/buildReadme/canonicalization/hard-gate/oracle-output
 * surface). Bound into the generation closure identity — the committed
 * loader fails closed on a stale producer contract. ANY semantic change to
 * buildStats / buildReadme / canonicalizeJsonKeys / canonicalizeExclusions /
 * the hard gates / the source-oracle-v6 preflight / the fixed source-oracle
 * rejection payload must bump this id (old loaders then explicitly reject
 * the generation as stale instead of silently re-deriving different bytes).
 * This is a structural internal binding, NOT a provider attestation, and it
 * does NOT bump REPLAY_SCHEMA_VERSION / the protocol hash / checkpoints.
 */
export const REPLAY_DATASET_PRODUCER_CONTRACT_ID =
  "t0-replay-dataset-producer-v2:hard-gates+source-oracle-v6+canonical-renderer+readme-stats-schema+fixed-source-error+nullable-cost";
export const REPLAY_PUBLICATION_INTENT_FILE = ".replay-publication-intent.json";
export const REPLAY_PUBLICATION_INTENT_KIND = "t0_replay_dataset_publication_intent";
export const REPLAY_PUBLICATION_INTENT_SCHEMA_VERSION = 1;
export const REPLAY_PUBLICATION_INTENT_CONTRACT_ID = "t0-replay-publication-intent-v1";
export const REPLAY_GENERATIONS_DIR = ".replay-generations";
export const REPLAY_PUBLIC_FILES = Object.freeze([
  "episodes.jsonl",
  "episodes.meta.jsonl",
  "exclusions.jsonl",
  "stats.json",
  "README.md",
]);
export const ALLOWED_JOIN_CONFIDENCES = Object.freeze(["exact", "heuristic"]);

/**
 * Outer watchdog budget for a full live replay build run: episodes run in
 * parallel up to `concurrency`, so the whole run is `ceil(episodeCount /
 * concurrency)` serial batches, each bounded by (maxRetries+1) attempts ×
 * per-attempt timeoutMs, plus a margin for transport backoff, serialization
 * and write-to-disk. This covers the FULL inner retry contract — without it
 * the outer watchdog could kill the last inner attempt before it finishes.
 * It does NOT change the per-call provider timeout (timeoutMs stays the
 * single-attempt budget).
 * Fail-fast: episodeCount/concurrency must be positive integers; the rest
 * must be non-negative finite integers; timeoutMs and marginMs must
 * additionally be positive.
 */
export function replayBuildWatchdogMs({ episodeCount = 1, concurrency = 1, maxRetries = REPLAY_DEFAULT_MAX_RETRIES, timeoutMs = REPLAY_DEFAULT_TIMEOUT_MS, marginMs = 600_000 } = {}) {
  for (const [name, value] of [["episodeCount", episodeCount], ["concurrency", concurrency]]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`replayBuildWatchdogMs: ${name} must be a positive integer, got ${value}`);
    }
  }
  for (const [name, value] of [["maxRetries", maxRetries], ["timeoutMs", timeoutMs], ["marginMs", marginMs]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`replayBuildWatchdogMs: ${name} must be a non-negative finite integer, got ${value}`);
    }
  }
  if (timeoutMs === 0 || marginMs === 0) {
    throw new TypeError(`replayBuildWatchdogMs: timeoutMs and marginMs must be positive, got timeoutMs=${timeoutMs}, marginMs=${marginMs}`);
  }
  const serialBatches = Math.ceil(episodeCount / concurrency);
  return serialBatches * (maxRetries + 1) * timeoutMs + marginMs;
}

/** Near-cap threshold for generation degeneration (bytes or actual call output tokens). */
export const DEGENERATION_NEAR_CAP_RATIO = 0.9;
/** Bumped when degeneration heuristics change — bound into protocol_hash. */
export const DEGENERATION_RULES_VERSION = 2;
/** Absolute floor for token/visible extreme imbalance (spare normal short-sign answers). */
export const DEGENERATION_IMBALANCE_MIN_OUTPUT_TOKENS = 16_384;
/** Visible Unicode length above which extreme imbalance does not apply alone. */
export const DEGENERATION_IMBALANCE_MAX_VISIBLE_CHARS = 400;
/** output_tokens / visible_chars ratio that marks extreme imbalance. */
export const DEGENERATION_IMBALANCE_MIN_RATIO = 50;

export const STRONG_REFERENCE_MODELS = ["openai/gpt-5.5", "anthropic/claude-opus-4-8"];
export const SPECIALIST_MODELS = ["moonshotai/kimi-k2.7-code", "zai-coding-cn/glm-5.2", "minimax/MiniMax-M3"];
export const REPLAY_JUDGE_MODELS = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "kimi-coding/k3"];

export const REPLAY_JUDGE_ROLES = {
  evaluator0: "openai/gpt-5.6-sol",
  evaluator1: "anthropic/claude-opus-5",
  verifier: "kimi-coding/k3",
  adjudicator: "openai/gpt-5.6-sol",
  counterfactual: "anthropic/claude-opus-5",
};

export const REPLAY_SYSTEM_PROMPT = "You are a helpful AI assistant. Respond to the user's request.";
/**
 * Prompt-only capability contract — identical for every model / episode /
 * attempt. The replay model has NO tools, browsing, search, files, workspace
 * or live external state; it answers from the task prompt + existing
 * knowledge only, never announces or attempts tool use, and outputs the
 * complete final answer directly. This text is fixed: it never changes the
 * source prompt bytes, system prompt, model, thinking, timeout, retries or
 * degeneration rules.
 */
export const REPLAY_USER_PROTOCOL =
  "You have no tools, browsing, search, file access, workspace, or live external state. "
  + "Answer the task prompt below using only the prompt itself and your existing knowledge. "
  + "Do not announce or attempt any tool use. Produce your complete final answer directly.";
/** Retry hint appended to the user content on content-failure retries. Bound into protocol_hash. */
export const REPLAY_RETRY_HINT =
  "\n\nYour previous response was not accepted. Please answer the task prompt directly with a complete, non-empty final answer.";

const EXTENDED_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Body field allow-lists (historical and replay slots are indistinguishable).
export const BODY_EPISODE_KEYS = Object.freeze([
  "schema_version",
  "dataset_mode",
  "episode_id",
  "prompt",
  "thinking",
  "tools",
  "slots",
]);
export const BODY_SLOT_KEYS = Object.freeze(["slot_id", "model_id", "output", "result"]);

// ── small helpers ─────────────────────────────────────────────────────────

function hmacHex(key, data) {
  return createHmac("sha256", key).update(String(data), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Canonical sorted object: a shallow copy with keys in ascending order.
 * Every by_* / map-style stats output is wrapped through this so the public
 * stats.json key order is deterministic regardless of insertion order (which
 * could otherwise depend on checkpoint scan order / worker completion order).
 */
export function sortedObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * Recursively canonicalize JSON object keys (ascending), preserving array
 * order. The shared pure renderer input: every public payload is rendered
 * from the canonicalized form, so object key insertion order anywhere in a
 * checkpoint (episode / sidecar / attempt_log / usage / audit / …) that the
 * contextual validator accepts can never change the five public bytes —
 * stableStringify-equivalent content always renders byte-identically.
 */
export function canonicalizeJsonKeys(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJsonKeys(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalizeJsonKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * Canonicalize the public exclusions list: dedupe by episode_id+reason only
 * when the records are byte-identical (same stableStringify — covers every
 * byte-affecting field; JSON key-order-only variants are the same payload),
 * then sort by the full stableStringify tuple. Every emitted record is the
 * canonicalized form (recursive key sort), so a stable-equal duplicate never
 * keeps the first original's key order. The result is byte-identical for the
 * same (manifest, cumulative checkpoint set) regardless of input order —
 * never dependent on concurrent push or selection/build/checkpoint
 * concatenation order. Records sharing an episode_id+reason key with
 * DIFFERENT payloads fail closed: deduping would have to arbitrarily prefer
 * one, so a conflicting set is a data-integrity error, never a silent
 * first-wins pick.
 */
export function canonicalizeExclusions(exclusions) {
  const seenEx = new Map(); // key → stableStringify of the canonicalized record
  const deduped = [];
  for (const raw of exclusions) {
    const e = canonicalizeJsonKeys(raw);
    const key = `${e.episode_id}::${e.reason ?? ""}`;
    const serialized = stableStringify(e);
    if (seenEx.has(key)) {
      if (seenEx.get(key) !== serialized) {
        throw new Error(
          `canonicalizeExclusions: conflicting exclusion records share episode_id+reason ${JSON.stringify(key)} `
          + `with different payloads — cannot dedupe deterministically (fail closed)`,
        );
      }
      continue;
    }
    seenEx.set(key, serialized);
    deduped.push(e);
  }
  deduped.sort((a, b) => {
    const sa = stableStringify(a);
    const sb = stableStringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return deduped;
}

function loadMeta(metaPath, { strict = false } = {}) {
  if (!fs.existsSync(metaPath)) throw new Error(`meta sidecar not found: ${metaPath}`);
  const records = [];
  const seenIds = new Set();
  const lines = fs.readFileSync(metaPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lineNo = i + 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      if (strict) {
        throw new Error(`episodes.meta.jsonl ${metaPath}:${lineNo}: invalid JSON: ${err.message}`);
      }
      continue;
    }
    if (strict) {
      if (!asRecord(row)) {
        throw new Error(`episodes.meta.jsonl ${metaPath}:${lineNo}: record is not a JSON object`);
      }
      if (typeof row.episode_id !== "string" || !row.episode_id) {
        throw new Error(`episodes.meta.jsonl ${metaPath}:${lineNo}: missing or invalid episode_id`);
      }
      if (seenIds.has(row.episode_id)) {
        throw new Error(`episodes.meta.jsonl ${metaPath}: duplicate episode_id ${row.episode_id} (line ${lineNo})`);
      }
      seenIds.add(row.episode_id);
    } else if (!(row && typeof row === "object" && typeof row.episode_id === "string")) {
      continue;
    }
    records.push(row);
  }
  return records;
}

function sameStringSet(a, b) {
  const A = new Set(a ?? []);
  const B = new Set(b ?? []);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

// ── structural hard gates (shared with the fair selector) ─────────────────
//
// These are the SAME pure gate helpers the fair selector (t0-replay-select /
// t0-replay-fair-common) applies. t0-replay-fair-common imports them from
// here (dependency direction fair-common → replay-build, never a cycle) and
// re-exports them, so the build's eligibility resolver and the selector can
// never drift apart: a manifest that passed selection is re-resolved here
// with the FULL gate set, never a weaker subset.

/** Body slots and in_body meta slots must form a complete one-to-one map by
 * slot_id: same size, same ids, no orphans either side, no duplicate ids. */
export function bodyMetaSlotMapComplete(episode, meta) {
  if (!meta || !Array.isArray(episode?.slots) || !Array.isArray(meta?.slots)) {
    return { ok: false, reason: "slot_arrays_missing" };
  }
  const bodySlots = episode.slots;
  const metaInBody = meta.slots.filter((s) => s && s.in_body === true);
  if (bodySlots.length === 0) return { ok: false, reason: "body_empty" };
  if (bodySlots.length !== metaInBody.length) {
    return { ok: false, reason: "slot_count_mismatch", body: bodySlots.length, meta_in_body: metaInBody.length };
  }
  const bodyIds = bodySlots.map((s) => s?.slot_id);
  const metaIds = metaInBody.map((s) => s?.slot_id);
  if (bodyIds.some((id) => typeof id !== "string" || !id)) return { ok: false, reason: "body_slot_id_invalid" };
  if (metaIds.some((id) => typeof id !== "string" || !id)) return { ok: false, reason: "meta_slot_id_invalid" };
  if (new Set(bodyIds).size !== bodyIds.length) return { ok: false, reason: "body_slot_id_duplicate" };
  if (new Set(metaIds).size !== metaIds.length) return { ok: false, reason: "meta_slot_id_duplicate" };
  const metaSet = new Set(metaIds);
  for (const id of bodyIds) {
    if (!metaSet.has(id)) return { ok: false, reason: "body_slot_missing_in_meta", slot_id: id };
  }
  const bodySet = new Set(bodyIds);
  for (const id of metaIds) {
    if (!bodySet.has(id)) return { ok: false, reason: "meta_slot_missing_in_body", slot_id: id };
  }
  return { ok: true };
}

export function outputsSelfContained(episode) {
  if ((episode.missing_evidence ?? []).length > 0) return false;
  if (!Array.isArray(episode.slots) || episode.slots.length === 0) return false;
  return episode.slots.every((s) =>
    typeof s?.output === "string"
    && s.output.length > 0
    && !s.output.startsWith(TRUNCATED_MARKER));
}

export function joinConfidenceAllowed(join) {
  return ALLOWED_JOIN_CONFIDENCES.includes(join);
}

/**
 * Evaluate the FULL structural hard-gate set for one episode — the same rule
 * set the fair selector applies. Returns { ok, reasons[], models, map,
 * join_confidence }. reasons is empty when ok.
 *
 * Note: judgeModels here are DOWNSTREAM judges (self-candidate exclusion),
 * not classifier models.
 */
export function evaluateHardGates(episode, meta, {
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  downstreamJudges = REPLAY_JUDGE_MODELS,
} = {}) {
  const reasons = [];
  if (!meta) reasons.push("meta_missing");
  if (!joinConfidenceAllowed(episode?.join_confidence)) reasons.push("join_not_allowed");
  // tools must be strict JSON null — empty string / missing / "none" all fail.
  if (episode?.tools !== null) reasons.push("tools_not_null");
  if (!outputsSelfContained(episode)) reasons.push("not_self_contained");

  const map = bodyMetaSlotMapComplete(episode, meta);
  if (!map.ok) reasons.push("body_meta_slot_map_incomplete");

  const models = (meta?.slots ?? []).filter((s) => s.in_body === true).map((s) => s.model);
  const strongSet = new Set(strongRefs);
  const specSet = new Set(specialists);
  const judgeSet = new Set(downstreamJudges);
  if (!models.some((m) => strongSet.has(m))) reasons.push("no_strong_reference");
  if (!models.some((m) => specSet.has(m))) reasons.push("no_specialist");
  if (models.some((m) => judgeSet.has(m))) reasons.push("contains_judge_model");

  return {
    ok: reasons.length === 0,
    reasons,
    models,
    map,
    join_confidence: episode?.join_confidence ?? null,
  };
}

// ── selection manifest ────────────────────────────────────────────────────

/**
 * Hash of the fair selection identity that checkpoint protocol binds to.
 *
 * Binds the FULL semantic manifest content — not just episode_ids — so any
 * change to selected/classification/count/exclusion content changes the
 * hash: kind, schema, protocol, classify flag, thinking, judge/classifier/
 * downstream models, counts, exclusion_distribution, the complete
 * selected[] / excluded[] / classifications[] records, episode_ids and
 * hard_only/limit. A hand-edited or derived manifest (e.g. a two-line
 * episode_ids-only rewrite) therefore hashes differently and is rejected by
 * checkpoint/provenance binding.
 *
 * Deliberately NOT bound (stable relocation semantics):
 *   - `episodes` / `meta` absolute paths — the manifest must survive a
 *     corpus relocation without invalidating every checkpoint;
 *   - `generated_at` — a timestamp, not selection semantics (identical
 *     content regenerated later must hash identically);
 *   - `concurrency` — a runtime execution parameter, not selection content.
 *   - `cost` — a derived summary of the classification attempts; the
 *     per-record cost/cost_breakdown inside selected[]/classifications[]
 *     are already bound, and the top-level summary is deterministic given
 *     the same checkpoints, so it adds no independent semantic signal.
 */
export function selectionManifestHash(selection) {
  return sha256Hex(stableStringify({
    kind: selection.kind,
    schema_version: selection.schema_version,
    protocol_hash: selection.protocol_hash,
    classify: selection.classify === true,
    thinking: selection.thinking ?? null,
    judge_models: selection.judge_models ?? [],
    classifier_models: selection.classifier_models ?? selection.judge_models ?? [],
    downstream_judges: selection.downstream_judges ?? [],
    counts: selection.counts ?? null,
    exclusion_distribution: selection.exclusion_distribution ?? null,
    selected: selection.selected ?? [],
    excluded: selection.excluded ?? [],
    classifications: selection.classifications ?? [],
    episode_ids: selection.episode_ids ?? (selection.selected ?? []).map((s) => s.episode_id),
    hard_only: selection.hard_only === true,
    limit: selection.limit ?? null,
  }));
}

/**
 * Load + validate a fair prompt-only selection manifest.
 * Fail-closed on kind/schema/protocol, selected ids, join_confidence,
 * tools=null, classifier/downstream judge configuration.
 *
 * Full `selected[]` records are required (episode_ids-only is a closed P1
 * bypass and is rejected). Every episode_id must have a complete selected row.
 */
export function loadAndValidateSelection(selectionPath, {
  requireClassifier = true,
  expectedDownstream = REPLAY_JUDGE_MODELS,
  selectionObject,
} = {}) {
  if (!selectionPath) {
    throw new Error("t0-replay-build: --selection <manifest.json> is required (fair prompt-only path; no default sample)");
  }
  const resolved = path.resolve(selectionPath);
  let selection = selectionObject;
  if (selection === undefined) {
    if (!fs.existsSync(resolved)) throw new Error(`selection manifest not found: ${resolved}`);
    try {
      selection = JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch (err) {
      throw new Error(`selection manifest is not valid JSON: ${resolved}: ${err.message}`);
    }
  }
  if (!asRecord(selection)) throw new Error("selection manifest must be a JSON object");
  if (selection.kind !== REPLAY_SELECTION_KIND) {
    throw new Error(`selection kind must be ${REPLAY_SELECTION_KIND}, got ${JSON.stringify(selection.kind)}`);
  }
  if (selection.schema_version !== REPLAY_SELECTION_SCHEMA_VERSION) {
    throw new Error(`selection schema_version must be ${REPLAY_SELECTION_SCHEMA_VERSION}, got ${JSON.stringify(selection.schema_version)}`);
  }
  if (typeof selection.protocol_hash !== "string" || !/^[0-9a-f]{64}$/.test(selection.protocol_hash)) {
    throw new Error("selection protocol_hash must be a 64-hex sha256");
  }
  // ── complete classified-manifest gate (fail-closed) ───────────────────
  // A replay-build input must be the FULL product of a classify-mode
  // selector run: classify===true, hard_only===false, limit===null, complete
  // selected[]/excluded[]/classifications[]/counts, and a consistent
  // coverage/order identity. Hand-written, partial, malformed, null-row,
  // data-insufficient or hard-only manifests are all rejected here — a
  // hand-written or derived manifest cannot bypass by omitting
  // classifications or counts. The downstream production dossiers run the
  // stronger validateFairManifestProvenance REBUILD on top; this loader is
  // the depth gate. (Hard exclusions legitimately have no classification;
  // only hard-PASS candidates must all appear in classifications.)
  if (selection.classify !== true) {
    throw new Error("selection classify must be true (a classified fair manifest is required; hard-only listings are not replay-build inputs)");
  }
  if (selection.hard_only !== false) {
    throw new Error("selection hard_only must be false (a classified fair manifest is required; hard_only listings are not replay-build inputs)");
  }
  if (selection.limit !== null) {
    throw new Error(`selection limit must be null (full manifest required), got ${JSON.stringify(selection.limit)}`);
  }
  const selected = selection.selected;
  if (!Array.isArray(selected)) {
    throw new Error("selection selected must be an array of full selected[] records (episode_ids-only / missing selected rejected)");
  }
  if (selected.length < 2) {
    throw new Error(`selection selected.length must be >= 2 (a fair prompt-only replay set requires at least 2 replayable episodes; data-insufficient manifests are rejected), got ${selected.length}`);
  }
  const episodeIds = selection.episode_ids;
  if (!Array.isArray(episodeIds)) {
    throw new Error("selection episode_ids must be an array");
  }
  if (episodeIds.length !== selected.length) {
    throw new Error(`selection selected.length (${selected.length}) != episode_ids.length (${episodeIds.length})`);
  }
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    if (!asRecord(row)) {
      throw new Error(`selection selected[${i}] must be a JSON object (malformed/null rows rejected)`);
    }
    if (row.episode_id !== episodeIds[i]) {
      throw new Error(`selection selected[${i}].episode_id must equal episode_ids[${i}] (same length and order required)`);
    }
    if (typeof row.episode_id !== "string" || row.episode_id.length <= 3 || !row.episode_id.startsWith("ep-")) {
      throw new Error(`selection episode id invalid: ${JSON.stringify(row.episode_id)}`);
    }
  }
  if (new Set(episodeIds).size !== episodeIds.length) {
    throw new Error("selection episode ids must be unique (duplicates rejected)");
  }
  const byId = new Map(selected.map((s) => [s.episode_id, s]));
  for (const row of selected) {
    if (!ALLOWED_JOIN_CONFIDENCES.includes(row.join_confidence)) {
      throw new Error(`selection ${row.episode_id}: join_confidence must be exact|heuristic, got ${JSON.stringify(row.join_confidence)}`);
    }
    if (row.tools !== null) {
      throw new Error(`selection ${row.episode_id}: tools must be null (prompt-only), got ${JSON.stringify(row.tools)}`);
    }
    if (row.replayable !== true) {
      throw new Error(`selection ${row.episode_id}: replayable must be true`);
    }
  }

  // ── fail-closed state gate: no execution-failed / judge_call_failed /
  // non-completed classification may enter the replay build. A partial
  // manifest (any classification that did not complete) must never silently
  // shrink the sample. The 10-key classification row does NOT carry
  // classification_status (the checkpoint final does) — only reject when the
  // field is present and non-completed, or when a failure reason is present.
  // The scan covers ALL three places a failed row can hide: selected /
  // classifications / excluded.
  const FAILURE_REASONS = ["judge_call_failed", "execution_failure"];
  const rejectFailedRow = (row, where) => {
    if (!asRecord(row)) return;
    const reasons = Array.isArray(row.reasons) ? row.reasons : [];
    const failed = reasons.filter((r) => typeof r === "string" && FAILURE_REASONS.includes(r));
    if (failed.length > 0) {
      throw new Error(
        `selection ${where} ${row.episode_id ?? "?"}: ${failed.join(", ")} — failed classifications are rejected (no partial manifest)`,
      );
    }
    if (row.classification_status !== undefined && row.classification_status !== "completed") {
      throw new Error(
        `selection ${where} ${row.episode_id ?? "?"}: classification_status ${JSON.stringify(row.classification_status)} — only completed classifications are admissible`,
      );
    }
  };
  for (const s of selected) {
    rejectFailedRow(s, "selected");
  }
  for (const c of Array.isArray(selection.classifications) ? selection.classifications : []) {
    rejectFailedRow(c, "classifications");
  }
  for (const e of Array.isArray(selection.excluded) ? selection.excluded : []) {
    rejectFailedRow(e, "excluded");
  }

  // ── classification coverage gate ───────────────────────────────────────
  const classifications = selection.classifications;
  if (!Array.isArray(classifications)) {
    throw new Error("selection classifications must be an array (missing classifications rejected)");
  }
  const classificationIds = new Set();
  for (let i = 0; i < classifications.length; i++) {
    const c = classifications[i];
    if (!asRecord(c)) {
      throw new Error(`selection classifications[${i}] must be a JSON object (malformed/null rows rejected)`);
    }
    if (typeof c.episode_id !== "string" || !c.episode_id) {
      throw new Error(`selection classifications[${i}].episode_id must be a non-empty string`);
    }
    if (c.episode_id.length <= 3 || !c.episode_id.startsWith("ep-")) {
      throw new Error(`selection classifications[${i}].episode_id must be a non-empty ep-* id, got ${JSON.stringify(c.episode_id)}`);
    }
    if (classificationIds.has(c.episode_id)) {
      throw new Error(`selection classifications episode_id ${c.episode_id} duplicated`);
    }
    classificationIds.add(c.episode_id);
  }
  // Every selected (hard-pass) episode must have a classification — a
  // hand-written / partial manifest that drops a hard-pass candidate's
  // classification is rejected.
  for (const id of episodeIds) {
    if (!classificationIds.has(id)) {
      throw new Error(`selection ${id}: missing classification row (classifications must cover every selected episode id)`);
    }
  }

  // ── excluded coverage gate ─────────────────────────────────────────────
  const excluded = selection.excluded;
  if (!Array.isArray(excluded)) {
    throw new Error("selection excluded must be an array");
  }
  const excludedIds = new Set();
  for (let i = 0; i < excluded.length; i++) {
    const e = excluded[i];
    if (!asRecord(e)) {
      throw new Error(`selection excluded[${i}] must be a JSON object (malformed/null rows rejected)`);
    }
    if (typeof e.episode_id !== "string" || e.episode_id.length <= 3 || !e.episode_id.startsWith("ep-")) {
      throw new Error(`selection excluded[${i}] must carry a non-empty ep-* episode_id, got ${JSON.stringify(e.episode_id)}`);
    }
    if (excludedIds.has(e.episode_id)) {
      throw new Error(`selection excluded episode_id ${e.episode_id} duplicated`);
    }
    excludedIds.add(e.episode_id);
  }
  const counts = selection.counts;
  if (!asRecord(counts)) {
    throw new Error("selection counts must be an object");
  }
  if (typeof counts.excluded !== "number" || !Number.isInteger(counts.excluded) || counts.excluded !== excluded.length) {
    throw new Error(`selection counts.excluded must equal excluded.length (got ${counts.excluded} vs ${excluded.length})`);
  }
  // Every NON-hard excluded row must carry a classification (it is a
  // classified non-replayable hard-pass candidate); hard exclusions
  // legitimately have none.
  for (const e of excluded) {
    if (e.stage !== "hard" && !classificationIds.has(e.episode_id)) {
      throw new Error(`selection excluded ${e.episode_id}: non-hard exclusion must have a classification row`);
    }
  }

  // ── exact partition gate (structural depth) ────────────────────────────
  // selected ∪ non-hard-excluded must be EXACTLY the classification set
  // (bidirectional: no orphan / missing), selected disjoint from ALL
  // excluded, hard exclusions never classified, and every classification
  // row's replayable must be the boolean its partition side implies (true
  // iff selected, false iff non-hard excluded — never both). These are
  // structural checks over the manifest shape only: the loader is a depth
  // gate and cannot prove provenance from a hand-written shape alone — that
  // is validateFairManifestProvenance (full producer reconstruction over
  // the real corpus + checkpoints).
  const selectedSet = new Set(episodeIds);
  const hardExcludedIds = new Set();
  const nonHardExcludedIds = new Set();
  for (const e of excluded) {
    if (e.stage === "hard") hardExcludedIds.add(e.episode_id);
    else nonHardExcludedIds.add(e.episode_id);
  }
  for (const id of excludedIds) {
    if (selectedSet.has(id)) {
      throw new Error(`selection ${id}: episode cannot be both selected and excluded (selected/excluded overlap rejected)`);
    }
  }
  for (const id of hardExcludedIds) {
    if (classificationIds.has(id)) {
      throw new Error(`selection ${id}: hard-excluded episode must not have a classification row`);
    }
  }
  for (const c of classifications) {
    if (typeof c.replayable !== "boolean") {
      throw new Error(`selection classifications ${c.episode_id}: replayable must be a boolean`);
    }
    if (selectedSet.has(c.episode_id) && c.replayable !== true) {
      throw new Error(`selection classifications ${c.episode_id}: replayable must be true (the episode is selected)`);
    }
    if (nonHardExcludedIds.has(c.episode_id) && c.replayable !== false) {
      throw new Error(`selection classifications ${c.episode_id}: replayable must be false (the episode is a non-hard exclusion)`);
    }
  }
  // Bidirectional classification coverage: ids == selected ∪ non-hard-excluded.
  const expectedClassIds = new Set([...selectedSet, ...nonHardExcludedIds]);
  for (const id of expectedClassIds) {
    if (!classificationIds.has(id)) {
      throw new Error(`selection ${id}: missing classification row (classifications must cover every selected id and every non-hard exclusion)`);
    }
  }
  for (const id of classificationIds) {
    if (!expectedClassIds.has(id)) {
      throw new Error(`selection classifications ${id}: orphan classification (no selected / non-hard-excluded episode with this id)`);
    }
  }

  if (counts.classified !== classifications.length) {
    throw new Error(`selection counts.classified (${counts.classified}) must equal classifications.length (${classifications.length})`);
  }
  if (counts.replayable !== selected.length) {
    throw new Error(`selection counts.replayable (${counts.replayable}) must equal selected.length (${selected.length})`);
  }
  if (counts.data_insufficient !== false) {
    throw new Error("selection counts.data_insufficient must be false (data-insufficient manifests are rejected)");
  }
  if (counts.hard_pass_limited !== classifications.length) {
    throw new Error(`selection counts.hard_pass_limited (${counts.hard_pass_limited}) must equal classifications.length (${classifications.length})`);
  }
  // Counts closure: full/no-filter classified manifest — hard_pass equals
  // the classified set, and source equals hard_pass + hard exclusions.
  if (counts.hard_pass !== classifications.length) {
    throw new Error(`selection counts.hard_pass (${counts.hard_pass}) must equal classifications.length (${classifications.length})`);
  }
  if (counts.source !== counts.hard_pass + hardExcludedIds.size) {
    throw new Error(`selection counts.source (${counts.source}) must equal hard_pass (${counts.hard_pass}) + hard exclusions (${hardExcludedIds.size})`);
  }
  const classifier = selection.classifier_models ?? selection.judge_models;
  if (requireClassifier) {
    if (!Array.isArray(classifier) || classifier.length !== 2 || new Set(classifier).size !== 2) {
      throw new Error("selection classifier_models/judge_models must be exactly two distinct models");
    }
  }
  const downstream = selection.downstream_judges;
  if (!Array.isArray(downstream) || downstream.length < 1 || downstream.length > 5) {
    throw new Error("selection downstream_judges must be 1..5 models");
  }
  if (expectedDownstream && !sameStringSet(downstream, expectedDownstream)) {
    // Soft check: warn via throw only when completely missing a required judge.
    for (const m of expectedDownstream) {
      if (!downstream.includes(m)) {
        throw new Error(`selection downstream_judges missing required judge candidate ${m}`);
      }
    }
  }
  const hash = selectionManifestHash({ ...selection, episode_ids: episodeIds });
  return {
    path: resolved,
    selection: { ...selection, episode_ids: episodeIds },
    episodeIds,
    selectedRows: selected,
    selectedById: byId,
    selectionHash: hash,
    classifierModels: classifier ?? [],
    downstreamJudges: downstream,
    protocolHash: selection.protocol_hash,
  };
}

// ── selection (legacy fixture-only) ───────────────────────────────────────

/**
 * LEGACY internal selector — fixture unit tests ONLY.
 * Production CLI path must use --selection; this is NOT a fair bypass.
 */
export function selectReplayEpisodes(episodes, metaById, {
  episodeIds = null,
  limit = REPLAY_DEFAULT_LIMIT,
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  judgeModels = REPLAY_JUDGE_MODELS,
  preferExact = true,
} = {}) {
  const strongSet = new Set(strongRefs);
  const specSet = new Set(specialists);
  const judgeSet = new Set(judgeModels);
  const explicit = episodeIds && episodeIds.length > 0 ? new Set(episodeIds) : null;

  const scored = [];
  const excluded = [];
  for (const episode of episodes) {
    if (explicit && !explicit.has(episode.episode_id)) continue;
    const meta = metaById.get(episode.episode_id);
    const reasons = [];
    if (!meta) reasons.push("meta_missing");
    const models = (meta?.slots ?? []).filter((s) => s.in_body === true).map((s) => s.model);
    if (!models.some((m) => strongSet.has(m))) reasons.push("no_strong_reference");
    if (!models.some((m) => specSet.has(m))) reasons.push("no_specialist");
    if (models.some((m) => judgeSet.has(m))) reasons.push("contains_judge_model");
    const selfContained = (episode.missing_evidence ?? []).length === 0
      && Array.isArray(episode.slots) && episode.slots.length > 0
      && episode.slots.every((s) => typeof s?.output === "string" && s.output.length > 0 && !s.output.startsWith(TRUNCATED_MARKER));
    if (!selfContained) reasons.push("not_self_contained");
    if (reasons.length > 0) {
      excluded.push({ episode_id: episode.episode_id, reasons });
      continue;
    }
    scored.push({ episode, meta, models, exact: episode.join_confidence === "exact" });
  }
  if (preferExact) {
    scored.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  }
  const limited = explicit
    ? scored
    : (limit !== undefined && Number.isFinite(limit) ? scored.slice(0, limit) : scored);
  return { selected: limited.map((s) => s.episode), excluded };
}

/**
 * Resolve selected source episodes strictly from the fair manifest.
 * Re-validates the SELECTOR'S FULL structural hard-gate set (body/meta 1:1,
 * self-contained, strong reference, specialist, no downstream judge, tools
 * null, join allowed) via the shared evaluateHardGates — never a weaker
 * subset — plus the selection-row-specific checks (source presence, meta
 * presence, selection tools null).
 */
export function resolveSelectedSourceEpisodes(sourceEpisodes, metaById, selectionInfo) {
  // The selection's OWN downstream-judge set drives the re-gate — never a
  // hardcoded weaker set. It must be an array and contain every FIXED
  // REPLAY_JUDGE_MODELS member (a custom downstream set may only ADD
  // judges): a manifest whose downstream_judges dropped a required judge
  // would silently re-admit a judge candidate here, so it fails closed
  // BEFORE any gate evaluation.
  const downstreamJudges = selectionInfo.downstreamJudges;
  if (!Array.isArray(downstreamJudges)) {
    throw new Error(
      "t0-replay-build: resolveSelectedSourceEpisodes requires selectionInfo.downstreamJudges to be an array "
      + `(got ${JSON.stringify(downstreamJudges)})`,
    );
  }
  for (const required of REPLAY_JUDGE_MODELS) {
    if (!downstreamJudges.includes(required)) {
      throw new Error(
        `t0-replay-build: selectionInfo.downstreamJudges must include every fixed replay judge (missing ${required}) — `
        + "a custom downstream set may only ADD judges, never drop a required replay-eval judge",
      );
    }
  }
  const byId = new Map(sourceEpisodes.map((e) => [e.episode_id, e]));
  const selected = [];
  const excluded = [];
  for (const id of selectionInfo.episodeIds) {
    const episode = byId.get(id);
    const meta = metaById.get(id);
    const row = selectionInfo.selectedById.get(id);
    const reasons = [];
    if (!episode) reasons.push("source_episode_missing");
    if (row && row.tools !== null) reasons.push("selection_tools_not_null");
    const join = row?.join_confidence ?? episode?.join_confidence;
    if (!ALLOWED_JOIN_CONFIDENCES.includes(join)) reasons.push("join_not_allowed");
    if (episode) {
      // The selector's FULL structural hard-gate set — the same rule set the
      // fair selector applies, so a manifest that passed selection can never
      // be re-resolved with weaker gates here (no_strong_reference /
      // no_specialist / body_meta_slot_map_incomplete included).
      const gate = evaluateHardGates(episode, meta, { downstreamJudges });
      reasons.push(...gate.reasons);
    }
    if (reasons.length > 0) {
      excluded.push({ episode_id: id, reason: "selection_resolve", reasons: [...new Set(reasons)] });
      continue;
    }
    selected.push({
      episode,
      meta,
      selectionRow: row ?? null,
      source_content_hash: episodeContentHash(episode),
      join_confidence: join,
      thinking: episode.thinking_level ?? null,
    });
  }
  return { selected, excluded };
}

/** Source episode id shape that must never appear in the anonymous body. */
export const SOURCE_EPISODE_ID_RE = /(?<![A-Za-z0-9])ep-[0-9a-f]{16}(?![A-Za-z0-9])/gi;

/**
 * Shared replay-content transform: the EXACT same transform applied to the
 * prompt, every publishable historical output and every successful replay
 * output — the episode-local redactor followed by source-episode-id
 * redaction (`ep-<16 hex>` → `[episode]`). The source id is matched with an
 * ALPHANUMERIC-CONTEXT, case-insensitive pattern (never \b, never
 * case-sensitive): "_" is a word char so \b misses `artifact_ep-<16 hex>.json`
 * and the ids are canonical lowercase but a quoted/uppercase form
 * (`EP-0123456789ABCDEF`) must still be caught. The lookarounds never match
 * the anonymous `rep-<16 hex>` / `slot-rep-…` HMAC ids ("ep" there is
 * preceded by an alphanumeric "r"). Global /gi is fine here — String.replace
 * resets lastIndex; the INDEPENDENT oracle regex (_t0-replay-oracle.mjs) is
 * the equivalent non-global /i form and is never imported from here.
 */
export function withSourceEpisodeIdRedaction(redact) {
  return (text) => redact(text).replace(SOURCE_EPISODE_ID_RE, "[episode]");
}

/**
 * Shared pure "source body texts" definition: the exact raw texts that WOULD
 * enter the replay body if this source episode were built. The prompt is
 * ALWAYS included; a historical slot output is included ONLY when
 * historyExcluded=false AND the slot has a matching meta model AND the output
 * is non-empty — exactly the slots that produce a historical body slot. An
 * orphan / non-body / non-published historical surface never affects the
 * redactor or the preflight. current-only / historyExcluded still checks the
 * prompt.
 */
export function sourceBodyTexts(sourceEpisode, sourceMeta, { historyExcluded = false } = {}) {
  const texts = [String(sourceEpisode?.prompt ?? "")];
  if (!historyExcluded) {
    for (const slot of sourceEpisode?.slots ?? []) {
      const metaSlot = (sourceMeta?.slots ?? []).find((s) => s.slot_id === slot.slot_id);
      const output = typeof slot.output === "string" ? slot.output : "";
      if (metaSlot?.model && output.length > 0) texts.push(output);
    }
  }
  return texts;
}

/**
 * Fail-closed source preflight over the shared source body texts (prompt
 * ALWAYS + publishable historical outputs): any bare ambiguous identity token
 * / residual id (K2/M2/M3/K3/v4-pro/v4pro/mN) that the redactor must never
 * guess rejects the WHOLE source episode — producer fail-closed semantics
 * ("exclude the whole episode, never guess"). The source episode builder
 * already excludes ambiguous sources from the corpus, but a prompt or a
 * historical output built by an older pipeline can carry a bare ambiguous
 * token that redaction would risk publishing. Pure and deterministic; run
 * over the FULL selected source universe BEFORE any blind-key write /
 * invoker, so a rejected source never reaches a provider.
 *
 * Returns the sorted ambiguous tokens ([] when the episode is clean).
 */
export function detectSourceAmbiguity(sourceEpisode, sourceMeta, corpusModelNames, { historyExcluded = false } = {}) {
  const texts = sourceBodyTexts(sourceEpisode, sourceMeta, { historyExcluded }).filter((t) => t.length > 0);
  if (texts.length === 0) return [];
  return detectAmbiguousIdentityTokens(texts, corpusModelNames, collectResidualIds(texts, corpusModelNames));
}

/**
 * The transformed source body texts the build will publish, computed with
 * the SAME transform buildReplayEpisode applies: episode-local redactor
 * (EMPTY residual list — source residuals are forbidden) + source episode id
 * → `[episode]`. Deterministic for a fixed (blind, corpus, options, source);
 * the preflight oracle check runs on these exact strings, so a source that
 * passes preflight publishes oracle-clean body content.
 */
export function transformedSourceBodyTexts(item, blind, corpusModelNames, options) {
  const episodeId = buildReplayEpisodeId(blind.key, item.episode.episode_id, options.models);
  const { redact } = buildEpisodeRedactor(blind.key, episodeId, corpusModelNames, []);
  const transform = withSourceEpisodeIdRedaction(redact);
  return sourceBodyTexts(item.episode, item.meta, { historyExcluded: options.historyExcluded === true })
    .filter((t) => t.length > 0)
    .map((t) => transform(t));
}

/**
 * Corpus model universe for the replay redactor / identity scan: mirrors the
 * producer's FULL model universe — the surviving meta slots PLUS the
 * producer-inventory-verified stats.models.by_name keys and
 * stats.models.absent_from_body PLUS the current replay routes
 * (options.models; a replay candidate may not survive in the source corpus
 * meta/stats at all — without it a mention like "grok-4.5" in a source body
 * would be partially redacted into a pseudonym + leftover version fragment
 * and then rejected by the oracle) — sorted, deduped. A model that only
 * survives in stats (its episodes were too-large / orphaned) is still a
 * KNOWN token: without it a mention like "kimi-k2.7-code" could be
 * mis-killed as a bare "K2" ambiguity. Structural anomalies are already
 * fail-closed by assertProducerInventory before this helper runs; the merge
 * itself is defensive (asRecord / Array.isArray guards).
 */
export function resolveCorpusModelNames(sourceMeta, sourceStats, replayModels) {
  const names = new Set();
  for (const m of sourceMeta ?? []) {
    for (const s of m?.slots ?? []) {
      if (typeof s?.model === "string" && s.model) names.add(s.model);
    }
  }
  const byName = asRecord(sourceStats?.models?.by_name) ? sourceStats.models.by_name : null;
  if (byName) {
    for (const key of Object.keys(byName)) names.add(key);
  }
  if (Array.isArray(sourceStats?.models?.absent_from_body)) {
    for (const n of sourceStats.models.absent_from_body) {
      if (typeof n === "string" && n) names.add(n);
    }
  }
  for (const m of replayModels ?? []) {
    if (typeof m === "string" && m) names.add(m);
  }
  return [...names].sort();
}

// ── thinking support ──────────────────────────────────────────────────────

/**
 * Mirror pi-ai getSupportedThinkingLevels: null map entries are unsupported;
 * xhigh/max require an explicit non-null map entry.
 */
export function isThinkingLevelSupported(model, level) {
  if (!level || level === "off") {
    if (!model) return true;
    if (!model.reasoning) return true;
    const mapped = model.thinkingLevelMap?.off;
    return mapped !== null;
  }
  if (!model) return false;
  if (!model.reasoning) return false;
  const map = model.thinkingLevelMap;
  if (!map) return true;
  if (Object.prototype.hasOwnProperty.call(map, level)) {
    return map[level] !== null;
  }
  if (level === "xhigh" || level === "max") return false;
  return EXTENDED_THINKING_LEVELS.includes(level);
}

export function resolveModelFromInvoker(invoker, modelRef) {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) return null;
  return invoker.registry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1)) ?? null;
}

/**
 * Preflight compatibility selection (pure, deterministic, no I/O).
 *
 * Picks the first `limit` episodes (in manifest order) whose source
 * `thinking_level` is supported by EVERY replay model in the current real
 * registry. Episodes that fail preflight — missing episode, empty thinking,
 * unregistered replay model, or a thinking level unsupported by any replay
 * model — are reported with per-model reasons and are NEVER sent to a
 * provider. They are preflight incompatibilities, NOT provider/generation
 * failures, and do not count into the actual replay slots.
 *
 * Callers pass a resolver (e.g. `(ref) => R.resolveModelFromInvoker(invoker,
 * ref)`) and the support callback (default `R.isThinkingLevelSupported`);
 * no registry, no filesystem, no provider calls happen here.
 *
 * Returns { selected, excluded, compatibleCount }:
 * - selected: first `limit` compatible episodes [{ episode_id, thinking }]
 * - excluded: ALL incompatible episodes in the manifest, each with
 *   { episode_id, thinking, reasons: [{ model, reason }] }
 * - compatibleCount: total compatible episodes in the manifest
 */
export function selectCompatibleEpisodes(episodeIds, episodesById, modelRefs, {
  resolveModel = null,
  isSupported = isThinkingLevelSupported,
  limit = REPLAY_DEFAULT_LIMIT,
} = {}) {
  const selected = [];
  const excluded = [];
  let compatibleCount = 0;
  for (const id of episodeIds) {
    const episode = episodesById.get(id);
    const thinking = episode?.thinking_level ?? null;
    const reasons = [];
    if (!episode) {
      reasons.push({ model: null, reason: "episode_missing" });
    } else if (!thinking) {
      reasons.push({ model: null, reason: "thinking_missing" });
    } else {
      for (const ref of modelRefs) {
        const model = resolveModel ? resolveModel(ref) : null;
        if (!model) {
          reasons.push({ model: ref, reason: "model_not_registered" });
          continue;
        }
        if (!isSupported(model, thinking)) {
          reasons.push({ model: ref, reason: "thinking_level_unsupported" });
        }
      }
    }
    if (reasons.length > 0) {
      excluded.push({ episode_id: id, thinking, reasons });
      continue;
    }
    compatibleCount++;
    if (selected.length < limit) {
      selected.push({ episode_id: id, thinking });
    }
  }
  return { selected, excluded, compatibleCount };
}

// ── protocol hash / checkpoint ────────────────────────────────────────────

/**
 * Checkpoint protocol hash binds selection + source + models + thinking +
 * system/user protocol + retry hint + resource/retry + redactor + schema +
 * experiment mode / history exclusion. Any change invalidates resume.
 */
export function buildReplayProtocolHash({
  selectionHash,
  sourceContentHash,
  models,
  thinking,
  systemPrompt = REPLAY_SYSTEM_PROMPT,
  userProtocol = REPLAY_USER_PROTOCOL,
  retryHint = REPLAY_RETRY_HINT,
  maxOutputBytes,
  maxEpisodeBytes,
  timeoutMs,
  maxRetries,
  redactorId = REPLAY_REDACTOR_ID,
  schemaVersion = REPLAY_SCHEMA_VERSION,
  episodeSchemaVersion = EPISODE_SCHEMA_VERSION,
  experimentMode = null,
  historyExcluded = false,
  degenerationRulesVersion = DEGENERATION_RULES_VERSION,
  replayCheckpointContractId = REPLAY_CHECKPOINT_CONTRACT_ID,
}) {
  return sha256Hex(stableStringify({
    selection_hash: selectionHash,
    source_content_hash: sourceContentHash,
    models: [...models],
    thinking,
    system_prompt: systemPrompt,
    user_protocol: userProtocol,
    retry_hint: retryHint,
    max_output_bytes: maxOutputBytes,
    max_episode_bytes: maxEpisodeBytes,
    timeout_ms: timeoutMs,
    max_retries: maxRetries,
    redactor: redactorId,
    schema_version: schemaVersion,
    episode_schema_version: episodeSchemaVersion,
    experiment_mode: experimentMode,
    history_excluded: historyExcluded === true,
    degeneration_rules_version: degenerationRulesVersion,
    replay_checkpoint_contract_id: replayCheckpointContractId,
    ledger_version: ATTEMPT_LEDGER_VERSION,
    ledger_contract_id: ATTEMPT_LEDGER_CONTRACT_ID,
  }));
}

// ── degeneration detection ────────────────────────────────────────────────

/** Unicode-aware visible length (code points), for CJK short answers. */
export function visibleCharLength(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Array.from(text).length;
}

/** English + Chinese line-start action-intent openers (no final answer yet). */
const ACTION_LINE_START = /^(?:i(?:'ll| will)|let me|i am going to|i'm going to|i need to|i should|going to|我先|让我|我将|我需要先|我来|先收集|先检查|我去|我准备|接下来我|我会先)/i;
/** English tool/file action phrases. */
const ACTION_EN_TOOL = /\b(?:read|open|check|run|execute|inspect|search|look at|look into)\b.{0,40}\b(?:file|repo|directory|workspace|command|test|tool)\b/i;
/** Chinese mid-text action intent (collect/check/search evidence…). */
const ACTION_CN_BODY = /(?:我先|让我|我将|我需要先|我来|先收集|先检查|我去|我准备|接下来我|我会先).{0,80}(?:收集|检查|查看|搜索|读取|分析|调研|证据|文件|仓库|代码|资料|信息)/;
/** Markers that a real conclusion/sign-off was produced (not pure action). */
const CONCLUSION_MARKER = /(?:\*\*结论\*\*|结论\s*[:：]|签署|不签署|\bACCEPT\b|\bREJECT\b|\bBLOCK\b|\bOBJECT\b|\bAGREE\b|\bDISAGREE\b|同意|反对|ACCEPT WITH CHANGES|SIGN)/i;

function isActionIntentLine(line) {
  return ACTION_LINE_START.test(line) || ACTION_EN_TOOL.test(line) || ACTION_CN_BODY.test(line);
}

/**
 * Detect generation degeneration that must never enter the capability body.
 * Returns { degenerated, reasons } — reasons empty when healthy.
 *
 * maxOutputTokens must be the ACTUAL per-call max output cap (if known),
 * never the model-catalog maxTokens. Prefer usage.output + visible text for
 * extreme imbalance (e.g. 98304 tokens / 75 visible chars).
 */
export function detectGenerationDegeneration(text, {
  maxOutputBytes = REPLAY_DEFAULT_MAX_OUTPUT_BYTES,
  usage = null,
  maxOutputTokens = null,
} = {}) {
  const reasons = [];
  if (typeof text !== "string" || text.length === 0) {
    return { degenerated: true, reasons: ["empty_output"] };
  }
  const bytes = utf8ByteLength(text);
  if (bytes >= Math.floor(maxOutputBytes * DEGENERATION_NEAR_CAP_RATIO)) {
    reasons.push("near_max_output_bytes");
  }
  const outTokens = usage?.output ?? usage?.output_tokens ?? usage?.completion_tokens ?? null;
  const visibleChars = visibleCharLength(text);
  // near_max_output_tokens: ONLY when caller supplies this call's real cap.
  // Never use model-catalog maxTokens (often far above the gateway/call cap).
  if (typeof outTokens === "number" && typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
    if (outTokens >= Math.floor(maxOutputTokens * DEGENERATION_NEAR_CAP_RATIO)) {
      reasons.push("near_max_output_tokens");
    }
  }
  // Extreme token/visible imbalance from usage.output alone (no catalog).
  // Must catch 98304 tokens / 75 chars; must spare normal short signs like
  // "签署"/"ACCEPT" with moderate reasoning tokens (hundreds–low thousands).
  if (
    typeof outTokens === "number"
    && outTokens >= DEGENERATION_IMBALANCE_MIN_OUTPUT_TOKENS
    && visibleChars > 0
    && visibleChars < DEGENERATION_IMBALANCE_MAX_VISIBLE_CHARS
  ) {
    const ratio = outTokens / visibleChars;
    if (ratio >= DEGENERATION_IMBALANCE_MIN_RATIO) {
      reasons.push("token_visible_extreme_imbalance");
    }
  }

  const lines = text.split(/\r?\n/);
  // Number / list stream: majority of non-empty lines are bare numbers or
  // trivial numbered list markers with little substance.
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length >= 12) {
    const trivial = nonEmpty.filter((l) =>
      /^[\d]+([.)]\s*)?$/.test(l)
      || /^\d+[.)]\s*\S{0,8}$/.test(l)
      || /^[-*•]\s*\S{0,8}$/.test(l)
      || /^[\d\s.,;:|+\-*/=]+$/.test(l));
    if (trivial.length / nonEmpty.length >= 0.7) reasons.push("number_or_list_stream");
  }

  // Repeated tail loop: last chunk repeats many times.
  if (text.length >= 400) {
    const window = Math.min(80, Math.floor(text.length / 8));
    const tail = text.slice(-window);
    if (tail.trim().length >= 20) {
      let count = 0;
      let idx = 0;
      while (idx < text.length) {
        const at = text.indexOf(tail, idx);
        if (at === -1) break;
        count++;
        idx = at + window;
      }
      if (count >= 4) reasons.push("repeated_tail_loop");
    }
    // Line-level repetition
    if (nonEmpty.length >= 8) {
      const last = nonEmpty[nonEmpty.length - 1];
      if (last.length >= 12) {
        const rep = nonEmpty.filter((l) => l === last).length;
        if (rep >= 5 && rep / nonEmpty.length >= 0.4) reasons.push("repeated_tail_loop");
      }
    }
  }

  // Action intent only — no substantive answer / conclusion (EN + ZH).
  // Avoid false kills on short sign answers (签署/ACCEPT): those have no
  // action intent and are not extreme-imbalance under the token floor above.
  const actionHits = nonEmpty.filter((l) => isActionIntentLine(l));
  const wholeIsAction = isActionIntentLine(text.trim()) || ACTION_CN_BODY.test(text);
  const hasConclusion = CONCLUSION_MARKER.test(text);
  const substance = nonEmpty.filter((l) => l.length >= 40 && !isActionIntentLine(l));
  if (
    !hasConclusion
    && text.length < 800
    && (
      (nonEmpty.length >= 1 && actionHits.length >= 1 && substance.length === 0)
      || (nonEmpty.length <= 3 && actionHits.length === nonEmpty.length && nonEmpty.length > 0)
      || (wholeIsAction && substance.length === 0 && visibleChars < 400)
    )
  ) {
    reasons.push("action_intent_without_substance");
  }

  return { degenerated: reasons.length > 0, reasons: [...new Set(reasons)] };
}

// ── replay episode id ─────────────────────────────────────────────────────

export function buildReplayEpisodeId(blindKey, sourceEpisodeId, replayModels) {
  const digest = sha256Hex(`${sourceEpisodeId}\u0000${[...replayModels].sort().join(",")}`);
  return `rep-${hmacHex(blindKey, `replay-episode\0${digest}`).slice(0, 16)}`;
}

// ── replay call ───────────────────────────────────────────────────────────

/**
 * One replay answer call with bounded retry. Same neutral system/user for all
 * models; thinking is the source episode's original level. Degeneration and
 * unsupported thinking are infrastructure_or_generation_failure.
 *
 * Provider-call accounting: the actual request entries in each
 * `callJudge(maxRetries:0)` result's `attempt_log` are the SOLE provider-call
 * fact (0 or 1 per call). Each real entry keeps its request_id/usage/cost/
 * cost_source/error_class; the replay layer attaches the degeneration /
 * content / identity-redaction outcome to the SAME entry — it never creates a
 * new entry that drops request_id. Pre-request failures (invalid ref / model
 * not found / auth / unsupported thinking — callJudge returns an empty
 * ledger) return immediately with attempts=0 and an empty attempt_log: the
 * slot still fails closed, but it is NOT a provider request and never counts
 * as an unknown-cost attempt.
 */
export async function runReplayAnswer(invoker, modelRef, prompt, {
  thinking = REPLAY_DEFAULT_THINKING,
  maxRetries = REPLAY_DEFAULT_MAX_RETRIES,
  timeoutMs = REPLAY_DEFAULT_TIMEOUT_MS,
  maxOutputChars = REPLAY_DEFAULT_MAX_OUTPUT_BYTES,
  operation = "t0_replay_answer",
  model = null,
  backoff = null,
} = {}) {
  const attemptLog = [];
  // Fail-closed before any call when thinking is unsupported for this model.
  // Pre-request: NO provider request was made — attempts=0, empty ledger.
  const resolvedModel = model ?? resolveModelFromInvoker(invoker, modelRef);
  if (!resolvedModel) {
    return {
      ok: false,
      error: `model not found: ${modelRef}`,
      error_class: "infrastructure_or_generation_failure",
      exclusion_reason: "replay_model_not_found",
      usage: null,
      modelRef,
      attempts: 0,
      attempt_log: [],
      cost: null,
      cost_source: null,
    };
  }
  if (!isThinkingLevelSupported(resolvedModel, thinking)) {
    return {
      ok: false,
      error: `thinking level ${JSON.stringify(thinking)} unsupported for ${modelRef}`,
      error_class: "infrastructure_or_generation_failure",
      exclusion_reason: "thinking_level_unsupported",
      usage: null,
      modelRef,
      attempts: 0,
      attempt_log: [],
      cost: null,
      cost_source: null,
    };
  }

  let lastError = null;
  let lastUsage = null;
  let lastErrorClass = "content";
  let contentFailed = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const hint = contentFailed ? REPLAY_RETRY_HINT : "";
    const userContent = `${REPLAY_USER_PROTOCOL}\n\n${prompt}${hint}`;
    const result = await callJudge(invoker, modelRef, REPLAY_SYSTEM_PROMPT, userContent, {
      maxRetries: 0,
      timeoutMs,
      maxOutputChars,
      operation,
      module: "t0-replay",
      reasoning: thinking,
    });
    // Pre-request failure (invalid ref / model not found / auth): NO actual
    // provider request was made (empty ledger). The failure is deterministic
    // — retrying cannot help — so return immediately with attempts=0 and an
    // empty ledger (the slot still fails closed, but it is not a provider
    // request / unknown-cost attempt).
    if (result.attempt_log.length === 0) {
      return {
        ok: false,
        error: result.error ?? "pre-request failure",
        error_class: "infrastructure_or_generation_failure",
        exclusion_reason: "replay_call_failed",
        usage: null,
        modelRef,
        attempts: 0,
        attempt_log: [],
        cost: null,
        cost_source: null,
      };
    }
    // The actual request entries in result.attempt_log are the SOLE
    // provider-call fact (0 or 1 with maxRetries:0). Each keeps its
    // request_id/usage/cost/cost_source/error_class; the replay layer attaches
    // the degeneration / content / identity-redaction outcome to the SAME
    // entry — never a new entry that drops request_id.
    for (const entry of result.attempt_log) {
      if (entry.ok && typeof result.text === "string" && result.text.length > 0) {
        // Use only this call's actual max-output cap when known. Never the
        // model-catalog maxTokens (often much higher than the gateway/call cap).
        const actualMaxOutputTokens = typeof result.maxOutputTokens === "number"
          ? result.maxOutputTokens
          : (typeof result.usage?.max_output_tokens === "number"
            ? result.usage.max_output_tokens
            : null);
        const deg = detectGenerationDegeneration(result.text, {
          maxOutputBytes: maxOutputChars,
          usage: entry.usage,
          maxOutputTokens: actualMaxOutputTokens,
        });
        if (deg.degenerated) {
          attemptLog.push({
            ...entry,
            ok: false,
            error: `generation degeneration: ${deg.reasons.join(",")}`,
            error_class: "infrastructure_or_generation_failure",
            degeneration_reasons: deg.reasons,
            raw_output: summarizeFailedOutput(result),
          });
          lastError = `generation degeneration: ${deg.reasons.join(",")}`;
          lastUsage = entry.usage;
          lastErrorClass = "infrastructure_or_generation_failure";
          // Near hard caps are not fixed by retry; action-intent / imbalance may be.
          if (deg.reasons.some((r) => r.startsWith("near_max_"))) {
            return {
              ok: false,
              error: lastError,
              error_class: "infrastructure_or_generation_failure",
              exclusion_reason: "infrastructure_or_generation_failure",
              usage: lastUsage,
              modelRef,
              attempts: attemptLog.length,
              attempt_log: attemptLog,
              cost: sumAttemptCosts(attemptLog),
              cost_source: aggregateCostSource(attemptLog),
            };
          }
          contentFailed = true;
          continue;
        }
        attemptLog.push({
          ...entry,
          ok: true,
          error: null,
          error_class: null,
          // The accepted output hash binds this request to the RAW accepted
          // output string (sha256 of result.text) — the sidecar replay
          // metadata keeps the same hash for the future body binding, and a
          // relabelled/no-success slot can never pass checkpointValid.
          accepted_output_hash: sha256Hex(result.text),
        });
        return {
          ok: true,
          output: result.text,
          error_class: null,
          exclusion_reason: null,
          usage: entry.usage,
          modelRef,
          attempts: attemptLog.length,
          attempt_log: attemptLog,
          cost: sumAttemptCosts(attemptLog),
          cost_source: aggregateCostSource(attemptLog),
        };
      }
      const errClass = entry.error_class === "transport"
        ? "transport"
        : (entry.error_class ?? "content");
      attemptLog.push({
        ...entry,
        ok: false,
        error: entry.error ?? "empty output",
        error_class: errClass,
        raw_output: summarizeFailedOutput(result),
      });
      lastError = entry.error ?? "empty output";
      lastUsage = entry.usage;
      lastErrorClass = errClass;
      if (errClass === "transport") {
        if (attempt < maxRetries) {
          const delay = backoff ? backoff(attempt) : 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
          await sleep(delay);
        }
        continue;
      }
      contentFailed = true;
    }
  }
  const exclusion = lastErrorClass === "infrastructure_or_generation_failure"
    ? "infrastructure_or_generation_failure"
    : "replay_call_failed";
  return {
    ok: false,
    error: lastError,
    error_class: lastErrorClass === "transport" || lastErrorClass === "content"
      ? lastErrorClass
      : "infrastructure_or_generation_failure",
    exclusion_reason: exclusion,
    usage: lastUsage,
    modelRef,
    attempts: attemptLog.length,
    attempt_log: attemptLog,
    cost: sumAttemptCosts(attemptLog),
    cost_source: aggregateCostSource(attemptLog),
  };
}

// ── replay episode building ───────────────────────────────────────────────

/**
 * Build one replay episode body + sidecar.
 *
 * Body keeps only anonymous fields needed by t0-eval. Historical and replay
 * slots are indistinguishable (no output_source / join / source markers) when
 * history is included. Failures never enter the body; they remain in the
 * sidecar with attempt/cost.
 *
 * current-only / historyExcluded: body contains only successful current
 * candidates (no historical answers). requirePaired: body only when every
 * replay model succeeds (paired capability main set).
 *
 * Always returns { episode|null, sidecar, exclusion|null } so callers can
 * persist checkpoint+meta even when all replay slots fail.
 */
export function buildReplayEpisode({
  sourceEpisode,
  sourceMeta,
  blindKey,
  replayResults,
  corpusModelNames,
  options,
  selectionHash = null,
  protocolHash = null,
  experimentMode = null,
  historyExcluded = false,
  requirePaired = false,
  thinkingOverride = undefined,
}) {
  const episodeId = buildReplayEpisodeId(blindKey, sourceEpisode.episode_id, replayResults.map((r) => r.model));
  const thinking = thinkingOverride !== undefined
    ? thinkingOverride
    : (sourceEpisode.thinking_level ?? null);
  const sourcePromptHash = sha256Hex(String(sourceEpisode.prompt ?? ""));

  // ── source-body invariant defense (never guess) ─────────────────────────
  // The build's source preflight already rejects ambiguous source episodes
  // before any provider work; this is the in-build invariant backstop so a
  // direct/unit caller can never publish a guessed identity either. The scan
  // covers exactly the texts that WOULD enter the body (prompt + publishable
  // historical outputs); any bare ambiguous identity token / residual id
  // fails the whole episode closed — it is never mechanically rewritten.
  const sourceAmbiguous = detectSourceAmbiguity(sourceEpisode, sourceMeta, corpusModelNames, {
    historyExcluded: historyExcluded === true,
  });

  const historical = (sourceEpisode.slots ?? []).map((slot) => {
    const metaSlot = (sourceMeta?.slots ?? []).find((s) => s.slot_id === slot.slot_id);
    return {
      kind: "historical",
      model: metaSlot?.model ?? null,
      output: typeof slot.output === "string" ? slot.output : "",
      sourceSlotId: slot.slot_id,
      sourceModelId: slot.model_id,
      usage: metaSlot?.usage ?? null,
      audit: metaSlot?.audit ?? null,
      join_confidence: slot.join_confidence ?? sourceEpisode.join_confidence ?? null,
    };
  });
  // Episode-local redactor entity universe: corpus models + family/alias
  // tokens + leak fragments ONLY — one pseudonym per entity keeps referential
  // consistency across every surface the redactor touches. Source residual
  // old-style ids (`mN`) are deliberately NOT part of the universe: they are
  // forbidden by the preflight (fail-closed above), so an ordinary criterion
  // like "M2" is never silently rewritten into a model pseudonym.
  const { redact } = buildEpisodeRedactor(blindKey, episodeId, corpusModelNames, []);
  // Defense in depth: the source prompt and the historical raw outputs are
  // already redacted by the episode builder, but re-redact them here with the
  // same episode-local redactor so a UUIDv7 / session id / run id / model
  // identity / source episode id that survived an older redactor can never
  // pass through into the replay body. The SAME replay-content transform
  // (episode-local redactor + source episode id `ep-<16 hex>` → `[episode]`)
  // is applied to the prompt, every publishable historical output and every
  // successful replay output. Ambiguous identity tokens are never redacted by
  // guess: the invariant defense above (and the build's source preflight
  // BEFORE any provider work) rejects those episodes first.
  const contentTransform = withSourceEpisodeIdRedaction(redact);

  const replay = [];
  for (const r of replayResults) {
    // Sidecar replay metadata keeps the accepted_output_hash of the LATEST
    // ok=true ledger entry (the raw accepted output the provider produced)
    // for the future body binding — null when the ledger has no success.
    // Postprocess failures (ambiguous identity / redaction cap) keep the
    // successful provider entry AND the hash, but replay.error stays non-null.
    let acceptedOutputHash = null;
    for (let i = (r.attempt_log ?? []).length - 1; i >= 0; i--) {
      if (r.attempt_log[i]?.ok === true) {
        acceptedOutputHash = typeof r.attempt_log[i].accepted_output_hash === "string" ? r.attempt_log[i].accepted_output_hash : null;
        break;
      }
    }
    const base = {
      kind: "replay",
      model: r.model,
      calledAt: r.calledAt,
      thinking: r.thinking ?? thinking,
      attempts: r.attempts,
      attempt_log: r.attempt_log,
      accepted_output_hash: acceptedOutputHash,
      cost: r.cost,
      cost_source: r.cost_source,
      usage: r.usage,
      error_class: r.error_class ?? (r.ok ? null : "content"),
    };
    if (!r.ok) {
      replay.push({
        ...base,
        ok: false,
        error: r.error,
        inBody: false,
        exclusionReason: r.exclusion_reason
          ?? (r.error_class === "infrastructure_or_generation_failure"
            ? "infrastructure_or_generation_failure"
            : "replay_call_failed"),
      });
      continue;
    }
    const residualIds = collectResidualIds([r.output], corpusModelNames);
    const ambiguousTokens = detectAmbiguousIdentityTokens([r.output], corpusModelNames, residualIds);
    if (ambiguousTokens.length > 0) {
      replay.push({
        ...base,
        ok: false,
        error: `ambiguous identity token(s): ${ambiguousTokens.join(", ")}`,
        error_class: "infrastructure_or_generation_failure",
        ambiguousTokens,
        inBody: false,
        exclusionReason: "replay_ambiguous_identity_token",
      });
      continue;
    }
    const redactedFull = contentTransform(r.output);
    const capped = capOutput(redactedFull, options.maxOutputBytes);
    // Cap that hits the truncated marker is treated as infrastructure failure.
    if (typeof capped === "string" && capped.startsWith(TRUNCATED_MARKER)) {
      replay.push({
        ...base,
        ok: false,
        error: "output capped at max_output_bytes",
        error_class: "infrastructure_or_generation_failure",
        inBody: false,
        exclusionReason: "infrastructure_or_generation_failure",
      });
      continue;
    }
    // Independent oracle CONTENT check on the FINAL candidate (redacted +
    // capped) BEFORE this slot can enter the body: an oracle rejection is a
    // slot-level fail-closed exclusion — the provider succeeded and the raw
    // output stays in the private material, but the content must never be
    // published (the checkpoint remains valid; the slot is excluded).
    try {
      assertNoOracleLeak(capped, `replay output ${r.model} (redacted/capped)`);
    } catch (err) {
      replay.push({
        ...base,
        ok: false,
        error: REPLAY_ORACLE_REJECTION_ERROR,
        error_class: "infrastructure_or_generation_failure",
        inBody: false,
        exclusionReason: "replay_oracle_content_rejected",
      });
      continue;
    }
    replay.push({
      ...base,
      ok: true,
      output: capped,
      redacted: redactedFull !== r.output,
      inBody: true,
      exclusionReason: null,
      error_class: null,
    });
  }

  const replayInBody = replay.filter((r) => r.inBody);
  // current-only: never put historical answers in the judge body.
  const historicalInBody = historyExcluded
    ? []
    : historical.filter((h) => h.model && typeof h.output === "string" && h.output.length > 0);

  // Candidate models for body = (optional historical) + successful replay.
  const bodyModels = [...new Set([
    ...historicalInBody.map((h) => h.model),
    ...replayInBody.map((r) => r.model),
  ].filter(Boolean))];

  const modelIds = episodeLocalModelIds(blindKey, episodeId, bodyModels.length > 0 ? bodyModels : ["__none__"]);

  const bodySlots = [];
  for (const h of historicalInBody) {
    const runId = `hist:${h.sourceSlotId}`;
    bodySlots.push({
      runId,
      record: {
        slot_id: episodeSlotId(blindKey, episodeId, runId),
        model_id: modelIds.get(h.model),
        output: contentTransform(h.output),
        result: "ok",
      },
    });
  }
  for (const r of replayInBody) {
    const runId = `replay:${r.model}`;
    bodySlots.push({
      runId,
      record: {
        slot_id: episodeSlotId(blindKey, episodeId, runId),
        model_id: modelIds.get(r.model),
        output: r.output,
        result: "ok",
      },
    });
  }

  const bodyOrder = episodeSlotOrder(blindKey, episodeId, bodySlots.map((s) => s.runId));
  const byRunId = new Map(bodySlots.map((s) => [s.runId, s.record]));
  const slots = bodyOrder.map((runId) => byRunId.get(runId));

  const minModels = options.minModels ?? 2;
  const pairedTarget = replayResults.length;
  let exclusion = null;
  let episode = null;

  if (sourceAmbiguous.length > 0) {
    // Invariant defense (production callers preflight first, so this never
    // fires in the normal provider path): an ambiguous source episode is
    // excluded wholesale — never guessed.
    exclusion = {
      episode_id: sourceEpisode.episode_id,
      reason: "source_ambiguous_identity_token",
      tokens: sourceAmbiguous,
    };
  } else if (replayInBody.length === 0) {
    exclusion = {
      episode_id: sourceEpisode.episode_id,
      reason: "no_replay_candidates",
      replay_models: replayResults.map((r) => r.model),
    };
  } else if (requirePaired && replayInBody.length < pairedTarget) {
    // Any model failure → episode stays out of the paired capability main set.
    exclusion = {
      episode_id: sourceEpisode.episode_id,
      reason: "not_fully_paired",
      ok_models: replayInBody.map((r) => r.model),
      failed_models: replay.filter((r) => !r.inBody).map((r) => r.model),
      required: pairedTarget,
    };
  } else if (bodyModels.length < minModels) {
    exclusion = {
      episode_id: sourceEpisode.episode_id,
      reason: "below_min_models",
      model_count: bodyModels.length,
      min_models: minModels,
    };
  } else {
    episode = {
      schema_version: EPISODE_SCHEMA_VERSION,
      dataset_mode: "replay",
      episode_id: episodeId,
      prompt: contentTransform(sourceEpisode.prompt),
      thinking,
      tools: null,
      slots,
    };
    const epBytes = utf8ByteLength(JSON.stringify(episode));
    if (epBytes > options.maxEpisodeBytes) {
      exclusion = {
        episode_id: sourceEpisode.episode_id,
        reason: "episode_bytes_exceeded",
        bytes: epBytes,
        max_episode_bytes: options.maxEpisodeBytes,
      };
      episode = null;
    }
  }

  // Sidecar always records identity / source / attempts / cost / join.
  // historyExcluded still records historical provenance only via source_* fields;
  // historical candidate answers are omitted from sidecar slots entirely so they
  // cannot leak into any judge-adjacent surface.
  const sidecarSlots = [];
  if (!historyExcluded) {
    for (const h of historical) {
      const runId = h.model ? `hist:${h.sourceSlotId}` : `hist-orphan:${h.sourceSlotId}`;
      const inBody = Boolean(episode && h.model && historicalInBody.includes(h));
      sidecarSlots.push({
        slot_id: episode ? episodeSlotId(blindKey, episodeId, runId) : `pending-${runId}`,
        model: h.model,
        in_body: inBody,
        exclusion_reason: inBody ? null : (h.model ? (episode ? null : (exclusion?.reason ?? "episode_excluded")) : "historical_model_missing"),
        source: {
          kind: "historical",
          source_episode_id: sourceEpisode.episode_id,
          source_slot_id: h.sourceSlotId,
          source_model_id: h.sourceModelId,
        },
        join_confidence: h.join_confidence,
        usage: h.usage,
        audit: h.audit,
      });
    }
  }
  for (const r of replay) {
    const runId = `replay:${r.model}`;
    // When not fully paired, successful slots still stay out of the body.
    const inBody = Boolean(episode && r.inBody);
    sidecarSlots.push({
      slot_id: episode ? episodeSlotId(blindKey, episodeId, runId) : `pending-${runId}`,
      model: r.model,
      in_body: inBody,
      exclusion_reason: inBody
        ? null
        : (r.exclusionReason
          ?? (episode ? null : (exclusion?.reason ?? "replay_call_failed"))
          ?? "replay_call_failed"),
      ...(r.ambiguousTokens ? { ambiguous_identity_token: r.ambiguousTokens } : {}),
      source: { kind: "replay" },
      join_confidence: "replay",
      replay: {
        called_at: r.calledAt,
        thinking: r.thinking,
        model_config: {
          max_retries: options.maxRetries,
          timeout_ms: options.timeoutMs,
          max_output_chars: options.maxOutputBytes,
        },
        attempts: r.attempts,
        attempt_log: r.attempt_log,
        // The accepted output hash of the LATEST ok=true ledger entry (the
        // raw accepted output) — kept for the future body binding and equal
        // to the ledger's latest success hash (null when the ledger has no
        // success).
        accepted_output_hash: r.accepted_output_hash ?? null,
        error: r.ok ? null : r.error,
        // Successful attempts always have error_class=null.
        error_class: r.ok ? null : (r.error_class ?? "content"),
        cost: r.cost,
        cost_source: r.cost_source,
        usage: r.usage,
      },
    });
  }

  const sidecar = {
    schema_version: REPLAY_SCHEMA_VERSION,
    dataset_mode: "replay",
    episode_id: episodeId,
    source_episode_id: sourceEpisode.episode_id,
    source_content_hash: episodeContentHash(sourceEpisode),
    source_prompt_hash: sourcePromptHash,
    source_thinking: sourceEpisode.thinking_level ?? null,
    replay_thinking: thinking,
    source_join_confidence: sourceEpisode.join_confidence ?? null,
    selection_hash: selectionHash,
    protocol_hash: protocolHash,
    experiment_mode: experimentMode,
    history_excluded: historyExcluded === true,
    paired_required: requirePaired === true,
    replay_models: replayResults.map((r) => r.model),
    slots: sidecarSlots,
  };

  return { episode, sidecar, exclusion };
}

/**
 * Private replay material: the minimal serializable snapshot of the replay
 * results needed to REBUILD the public surfaces (episode/sidecar/exclusion)
 * via buildReplayEpisode. One entry per model, order strictly matching
 * `models`. The raw accepted output lives ONLY here (inside the checkpoint)
 * under the private key `raw_accepted_output` — a name that cannot collide
 * with the legitimate `output` field of body slots — and it is never
 * published to episodes.jsonl / episodes.meta.jsonl / stats. This is a
 * structural internal binding, NOT a provider attestation: the validator
 * re-runs the real producer over this material and exact deep-compares the
 * public surfaces, and the success output hash is recomputed from the raw
 * output.
 */
export function buildReplayMaterial(replayResults) {
  return (replayResults ?? []).map((r) => ({
    model: r.model,
    ok: r.ok === true,
    raw_accepted_output: r.ok === true ? (typeof r.output === "string" ? r.output : null) : null,
    calledAt: r.calledAt ?? null,
    thinking: r.thinking ?? null,
    attempts: r.attempts,
    attempt_log: r.attempt_log ?? [],
    cost: r.cost ?? null,
    cost_source: r.cost_source ?? null,
    usage: r.usage ?? null,
    error: r.ok === true ? null : (r.error ?? null),
    error_class: r.ok === true ? null : (r.error_class ?? null),
    exclusion_reason: r.ok === true ? null : (r.exclusion_reason ?? null),
  }));
}

/**
 * Map private material entries back to the replay-result shape
 * buildReplayEpisode expects (`raw_accepted_output` → `output`). The
 * material is the ONLY private surface the rebuild may read — the public
 * body/sidecar are never trusted as rebuild inputs.
 */
export function materialToReplayResults(material) {
  return (material ?? []).map((m) => ({
    model: m.model,
    ok: m.ok === true,
    output: m.ok === true ? (typeof m.raw_accepted_output === "string" ? m.raw_accepted_output : null) : null,
    calledAt: m.calledAt ?? null,
    thinking: m.thinking ?? null,
    attempts: m.attempts,
    attempt_log: m.attempt_log ?? [],
    cost: m.cost ?? null,
    cost_source: m.cost_source ?? null,
    usage: m.usage ?? null,
    error: m.ok === true ? null : (m.error ?? null),
    error_class: m.ok === true ? null : (m.error_class ?? null),
    exclusion_reason: m.ok === true ? null : (m.exclusion_reason ?? null),
  }));
}

/** Assert body has only allowed keys (for tests + write-time guard). */
export function assertAnonymousBody(episode) {
  // EXACT shape first: the body must be a non-null plain object — a null /
  // primitive / array / String-object episode can never be a valid body, and
  // a missing own key must never be satisfied by an inherited property
  // (Object.hasOwn below).
  if (episode === null || episode === undefined || typeof episode !== "object" || Array.isArray(episode)) {
    throw new Error(`anonymous body must be a non-null plain object, got ${episode === null ? "null" : episode === undefined ? "undefined" : Array.isArray(episode) ? "array" : typeof episode}`);
  }
  for (const key of Object.keys(episode)) {
    if (!BODY_EPISODE_KEYS.includes(key)) {
      throw new Error(`anonymous body leaks field ${key}`);
    }
  }
  // Missing keys fail closed too: the body must carry EXACTLY the anonymous
  // body field set as OWN keys — a missing key can hide a required binding,
  // an extra key can smuggle private data, and an inherited property is NOT
  // an own key (an inherited `prompt` would otherwise leak identity while
  // passing a key allow-list).
  for (const key of BODY_EPISODE_KEYS) {
    if (!Object.hasOwn(episode, key)) throw new Error(`anonymous body is missing field ${key}`);
  }
  // EXACT public type/value contract (independent of the oracle, using this
  // module's own constants): a nested object / wrong value smuggled into a
  // public field must never pass the key allow-list alone.
  if (episode.schema_version !== EPISODE_SCHEMA_VERSION) {
    throw new Error(`anonymous body schema_version must be ${EPISODE_SCHEMA_VERSION}, got ${JSON.stringify(episode.schema_version)}`);
  }
  if (episode.dataset_mode !== "replay") {
    throw new Error(`anonymous body dataset_mode must be "replay", got ${JSON.stringify(episode.dataset_mode)}`);
  }
  if (typeof episode.episode_id !== "string" || !/^rep-[0-9a-f]{16}$/.test(episode.episode_id)) {
    throw new Error("anonymous body episode_id must be a rep-<16 hex> string");
  }
  if (typeof episode.prompt !== "string") {
    throw new Error(`anonymous body prompt must be a string, got ${typeof episode.prompt}`);
  }
  if (typeof episode.thinking !== "string" || !EXTENDED_THINKING_LEVELS.includes(episode.thinking)) {
    throw new Error(`anonymous body thinking must be a string in [${EXTENDED_THINKING_LEVELS.join("/")}], got ${JSON.stringify(episode.thinking)}`);
  }
  if (episode.tools !== null) throw new Error("anonymous body tools must be null");
  if (!Array.isArray(episode.slots)) throw new Error("anonymous body slots must be an array");
  for (const slot of episode.slots) {
    // Each slot must be a non-null plain object — never null, never an array.
    if (slot === null || slot === undefined || typeof slot !== "object" || Array.isArray(slot)) {
      throw new Error(`anonymous body slot must be a non-null plain object, got ${slot === null ? "null" : slot === undefined ? "undefined" : Array.isArray(slot) ? "array" : typeof slot}`);
    }
    for (const key of Object.keys(slot)) {
      if (!BODY_SLOT_KEYS.includes(key)) {
        throw new Error(`anonymous body slot leaks field ${key}`);
      }
    }
    // Exact own-key closure per slot, like the episode level.
    for (const key of BODY_SLOT_KEYS) {
      if (!Object.hasOwn(slot, key)) throw new Error(`anonymous body slot is missing field ${key}`);
    }
    if (typeof slot.slot_id !== "string" || !/^slot-rep-[0-9a-f]{16}-[0-9a-f]{12}$/.test(slot.slot_id) || !slot.slot_id.startsWith(`slot-${episode.episode_id}-`)) {
      throw new Error("anonymous body slot slot_id must be scoped to its anonymous episode_id (slot-<rep id>-<12 hex>)");
    }
    if (typeof slot.model_id !== "string" || !/^c(?:0|[1-9]\d*)$/.test(slot.model_id)) {
      throw new Error("anonymous body slot model_id must be a canonical candidate cN (c(?:0|[1-9]\\d*), no leading zeros)");
    }
    if (typeof slot.output !== "string") {
      throw new Error(`anonymous body slot output must be a string, got ${typeof slot.output}`);
    }
    if (slot.result !== "ok") {
      throw new Error(`anonymous body slot result must be "ok", got ${JSON.stringify(slot.result)}`);
    }
  }
}

/**
 * Stable call-identity snapshot of every replay slot across meta sidecar
 * records (per the real episodes.meta.jsonl schema). Pure + deterministic.
 *
 * Used by resume acceptance (dossier-t0-replay-production.mjs) to prove the
 * resume step made ZERO new provider calls: when a checkpoint is reused, the
 * meta sidecar is written back byte-identically, so the snapshot deepEquals
 * the pre-resume one. If any checkpoint is MISSED and a slot is re-called,
 * `called_at` (new Date().toISOString() per call) and/or the attempt_log
 * must differ — a snapshot mismatch therefore fails the resume contract.
 *
 * Each entry covers: episode id, slot identity, source/replay model,
 * `replay.called_at`, attempt count and the FULL per-attempt log (attempt /
 * ok / error / error_class / model_ref / operation / accepted_output_hash /
 * usage / cost / cost_source — the entries themselves are the stable
 * identity).
 */
export function snapshotReplayCallIdentity(metaRecords) {
  const snap = [];
  for (const record of metaRecords ?? []) {
    for (const slot of record?.slots ?? []) {
      if (slot?.source?.kind !== "replay") continue;
      snap.push({
        episode_id: record.episode_id,
        slot_id: slot.slot_id ?? null,
        model: slot.model ?? null,
        called_at: slot.replay?.called_at ?? null,
        attempts: typeof slot.replay?.attempts === "number" ? slot.replay.attempts : null,
        attempt_log_length: Array.isArray(slot.replay?.attempt_log) ? slot.replay.attempt_log.length : null,
        attempt_log: slot.replay?.attempt_log ?? null,
      });
    }
  }
  return snap;
}

// ── CLI ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { ...argv };
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const episodesPath = args.episodes ? path.resolve(args.episodes) : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
  const metaPath = args.meta ? path.resolve(args.meta) : path.join(path.dirname(episodesPath), "episodes.meta.jsonl");
  const exclusionsPath = args.exclusions ? path.resolve(args.exclusions) : path.join(path.dirname(metaPath), "exclusions.jsonl");
  const statsPath = args.stats ? path.resolve(args.stats) : path.join(path.dirname(metaPath), "stats.json");
  const rawEpisode = args.episode;
  const episodeIds = rawEpisode === undefined || rawEpisode === true
    ? undefined
    : (Array.isArray(rawEpisode) ? rawEpisode : [rawEpisode])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
  const selectionPath = typeof args.selection === "string" && args.selection.trim()
    ? path.resolve(args.selection.trim())
    : undefined;
  const currentOnly = args["current-only"] === true;
  const models = typeof args.models === "string" && args.models.trim()
    ? args.models.split(",").map((m) => m.trim()).filter(Boolean)
    : (currentOnly ? [...CURRENT_ONLY_MODELS] : [...REPLAY_DEFAULT_MODELS]);
  const thinkingCli = typeof args.thinking === "string" && args.thinking.trim() ? args.thinking.trim() : undefined;
  return {
    episodesPath,
    metaPath,
    exclusionsPath,
    statsPath,
    selectionPath,
    episodeIds,
    // limit is ignored when --selection is provided; kept only for legacy fixture helpers.
    limit: nonNegativeInt(args.limit, REPLAY_DEFAULT_LIMIT),
    concurrency: Math.max(1, nonNegativeInt(args.concurrency, REPLAY_DEFAULT_CONCURRENCY)),
    models,
    // Fair path forbids --thinking. current-only forces high (CLI may only
    // restate high). Legacy fixture path may override.
    thinkingCli,
    thinkingOverride: undefined, // resolved in buildReplay after mode validation
    currentOnly,
    experimentMode: currentOnly ? CURRENT_ONLY_EXPERIMENT_MODE : null,
    historyExcluded: currentOnly,
    requirePaired: currentOnly,
    output: args.output ? path.resolve(args.output) : path.join(home, ".pi", ".pi-astack", currentOnly ? "t0-replay-current-run" : "t0-replay"),
    modelsJsonPath: args["models-json"] ? path.resolve(args["models-json"]) : path.join(agentDir, "models.json"),
    maxRetries: nonNegativeInt(args["max-retries"], REPLAY_DEFAULT_MAX_RETRIES),
    timeoutMs: nonNegativeInt(args["timeout-ms"], REPLAY_DEFAULT_TIMEOUT_MS),
    resume: args["no-resume"] !== true,
    blindKey: typeof args["blind-key"] === "string" && args["blind-key"].trim() ? args["blind-key"].trim() : undefined,
    seed: args.seed !== undefined && args.seed !== true && String(args.seed).trim() !== "" ? String(args.seed) : undefined,
    minModels: Math.max(currentOnly ? models.length : 2, nonNegativeInt(args["min-models"], currentOnly ? models.length : 2)),
    maxOutputBytes: nonNegativeInt(args["max-output-bytes"], REPLAY_DEFAULT_MAX_OUTPUT_BYTES),
    maxEpisodeBytes: nonNegativeInt(args["max-episode-bytes"], REPLAY_DEFAULT_MAX_EPISODE_BYTES),
    maxTotalBytes: nonNegativeInt(args["max-total-bytes"], REPLAY_DEFAULT_MAX_TOTAL_BYTES),
    quiet: args.quiet === true,
    allowLegacySelect: args["allow-legacy-select"] === true,
    // Test-only runtime injection: a mock invoker (registry + auditStreamSimple
    // + piAi + projectRoot) replaces makeJudgeInvoker so offline fixture tests
    // can serve provider answers without any real provider. Never a CLI flag.
    invoker: args.invoker ?? null,
  };
}

/** Resolve per-episode thinking under the active experiment mode. */
export function resolveReplayThinking(options, sourceEpisode) {
  if (options.currentOnly) return CURRENT_ONLY_THINKING;
  if (options.thinkingOverride !== undefined) return options.thinkingOverride;
  return sourceEpisode?.thinking_level ?? null;
}

/** Closed allowlist of value-bearing raw CLI flags for t0-replay-build. */
const REPLAY_BUILD_VALUE_FLAGS = Object.freeze([
  "episodes", "meta", "exclusions", "stats", "selection", "episode",
  "limit", "concurrency", "models", "thinking", "output", "models-json",
  "max-retries", "timeout-ms", "blind-key", "seed", "min-models",
  "max-output-bytes", "max-episode-bytes", "max-total-bytes",
]);
/** Closed allowlist of boolean raw CLI flags for t0-replay-build. */
const REPLAY_BUILD_BOOLEAN_FLAGS = Object.freeze([
  "current-only", "no-resume", "quiet", "allow-legacy-select",
]);
/** Value flags that may repeat and accumulate (space form only). */
const REPLAY_BUILD_REPEATABLE_VALUE_FLAGS = Object.freeze(["episode"]);
const REPLAY_BUILD_NON_NEG_INT_FLAGS = new Set(["limit", "max-retries"]);
const REPLAY_BUILD_POS_INT_FLAGS = new Set([
  "concurrency", "timeout-ms", "min-models",
  "max-output-bytes", "max-episode-bytes", "max-total-bytes",
]);

function assertNonNegativeIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, NONNEGATIVE_DECIMAL_RE)) {
    throw new Error(`t0-replay-build: --${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

function assertPositiveIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, POSITIVE_DECIMAL_RE)) {
    throw new Error(`t0-replay-build: --${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * Explicit CSV flag gate: every comma segment must be semantically non-empty
 * after trim — `,`, `,,`, `a,,b` fail closed instead of silently dropping
 * empty segments (which could otherwise widen a selection or fall back to
 * defaults). Repeated flags still accumulate (parseStrictCli repeatable).
 */
function assertNonEmptyCsvRaw(flag, value) {
  const segments = String(value).split(",").map((s) => s.trim());
  if (segments.some((s) => s.length === 0)) {
    throw new Error(`t0-replay-build: --${flag} requires a non-empty comma-separated value (each segment must be non-empty), got ${JSON.stringify(value)}`);
  }
}

/**
 * Strict raw-argv entry for the CLI. Uses shared parseStrictCli (closed
 * allowlist; rejects --flag=value / unknown / positional / non-repeatable
 * duplicates / missing values / boolean-with-value) plus raw numeric and
 * non-empty value gates so a malformed argv can never silently resolve the
 * production default paths. The object API `parseArgs` is unchanged for
 * fixture callers.
 */
export function parseCliArgs(argv) {
  const args = parseStrictCli(argv, {
    valueFlags: REPLAY_BUILD_VALUE_FLAGS,
    booleanFlags: REPLAY_BUILD_BOOLEAN_FLAGS,
    repeatableValueFlags: REPLAY_BUILD_REPEATABLE_VALUE_FLAGS,
  });
  for (const [key, raw] of Object.entries(args)) {
    if (raw === true) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (REPLAY_BUILD_NON_NEG_INT_FLAGS.has(key)) {
        assertNonNegativeIntRaw(key, value);
      } else if (REPLAY_BUILD_POS_INT_FLAGS.has(key)) {
        assertPositiveIntRaw(key, value);
      } else if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`t0-replay-build: --${key} requires a non-empty value`);
      }
    }
  }
  // --min-models: the raw CLI must REJECT a value below the fair-path floor
  // (>= 2) instead of clamping it in parseArgs — `--min-models 1` must never
  // silently become 2 after paid work. The object API (parseArgs) keeps its
  // legacy clamp for fixture callers; only the raw argv path is strict.
  if (args["min-models"] !== undefined && Number(args["min-models"]) < 2) {
    throw new Error(`t0-replay-build: --min-models must be an integer >= 2 (got ${JSON.stringify(args["min-models"])})`);
  }
  // Explicit CSV flags (--episode / --models): every comma segment must be
  // semantically non-empty after trim — `,`, `,,`, `a,,b` fail closed
  // instead of silently dropping empty segments (which could otherwise
  // widen a selection or fall back to defaults). Repeated --episode flags
  // still accumulate (parseStrictCli repeatable). The strict raw gate above
  // already threw on a pure-whitespace value, so a supplied --models is
  // never silently replaced by the default model set.
  for (const key of ["episode", "models"]) {
    const raw = args[key];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      assertNonEmptyCsvRaw(key, value);
    }
  }
  return parseArgs(args);
}

// ── stats / outputs ───────────────────────────────────────────────────────

/**
 * Stable `source` values the production producers may persist into
 * blind-key.json. resolveBlindKey returns "explicit" (--blind-key) / "seed"
 * / "generated" on every first-write path — t0-episode-build writes only
 * when blind.source !== "reused" and replay's persistBlindKey writes only on
 * the missing-file path — so "reused" is never a persisted value: a file
 * carrying any other source is not producer-written and is rejected.
 */
export const BLIND_KEY_PERSISTED_SOURCES = Object.freeze(["explicit", "seed", "generated"]);

/**
 * Strict closed-shape preflight for an existing blind-key.json. Producers
 * write exactly { schema_version: 1, blind_key, source } — anything else
 * (extra/missing keys, wrong schema_version, non-canonical blind_key case,
 * illegal source) is a lost/corrupted paid-directory fact and fails closed
 * rather than being silently replaced or reused. Returns { key, source } on
 * success.
 */
export function validateBlindKeyFileShape(parsed, keyFile) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`blind-key.json exists but is not a JSON object: ${keyFile}`);
  }
  const keys = Object.keys(parsed).sort();
  const expected = ["blind_key", "schema_version", "source"];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(
      `blind-key.json exists but has an invalid shape: expected exactly {schema_version, blind_key, source}, got ${JSON.stringify(keys)}: ${keyFile}`,
    );
  }
  if (parsed.schema_version !== 1) {
    throw new Error(`blind-key.json exists with schema_version ${JSON.stringify(parsed.schema_version)} — must be 1: ${keyFile}`);
  }
  if (typeof parsed.blind_key !== "string" || !new RegExp(`^[0-9a-f]{${BLIND_KEY_HEX_LENGTH}}$`).test(parsed.blind_key)) {
    throw new Error(`blind-key.json exists but blind_key is not canonical lowercase ${BLIND_KEY_HEX_LENGTH}-hex: ${keyFile}`);
  }
  if (typeof parsed.source !== "string" || !BLIND_KEY_PERSISTED_SOURCES.includes(parsed.source)) {
    throw new Error(
      `blind-key.json exists with illegal source ${JSON.stringify(parsed.source)} — producers persist only ${BLIND_KEY_PERSISTED_SOURCES.join("|")}: ${keyFile}`,
    );
  }
  return { key: parsed.blind_key, source: parsed.source };
}

/** Best-effort directory fsync after the exclusive publish (some platforms
 * refuse directory fsync — best-effort only; the link itself is atomic). */
function fsyncDirBestEffort(dir) {
  let dfd = null;
  try {
    dfd = fs.openSync(dir, "r");
    fs.fsyncSync(dfd);
  } catch {
    /* best-effort: directory fsync is not supported everywhere */
  } finally {
    if (dfd !== null) {
      try { fs.closeSync(dfd); } catch { /* ignore */ }
    }
  }
}

function exactOwnKeys(value, expected, label) {
  if (!asRecord(value)) throw new Error(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must carry exactly ${JSON.stringify(expected)} (got ${JSON.stringify(Object.keys(value))})`);
  }
}

function canonicalPretty(value) {
  return `${JSON.stringify(canonicalizeJsonKeys(value), null, 2)}\n`;
}

function fileDescriptor(relativePath, text) {
  return { path: relativePath, bytes: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) };
}

function assertSafeRelativePath(relativePath, label = "relative path") {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty forward-slash relative path`);
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`${label} contains an unsafe path component: ${JSON.stringify(relativePath)}`);
  }
  if (path.posix.normalize(relativePath) !== relativePath) {
    throw new Error(`${label} is not normalized: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readJsonObjectStrict(file, label) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (err) {
    throw new Error(`${label} cannot be read: ${err.message}`);
  }
  let value;
  try { value = JSON.parse(text); } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (!asRecord(value)) throw new Error(`${label} must be a JSON object`);
  return { text, value };
}

function loadExactJsonMap(dir, ids, label) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || !ids.every((id) => typeof id === "string" && id)) {
    throw new Error(`${label}: ids must be unique non-empty strings`);
  }
  if (!fs.existsSync(dir)) throw new Error(`${label}: checkpoint missing (directory not found: ${dir})`);
  // Exact DIRECT-json inventory: the leaf's direct `.json` entries must be
  // regular files whose names are EXACTLY the expected `<id>.json` set.
  // Extra/missing `.json` files, and non-regular/symlink `.json` entries,
  // fail closed. Archive subdirectories and non-json auxiliary items are
  // ignored (they are not checkpoint inventory).
  const expectedNames = ids.map((id) => `${id}.json`).sort();
  const actualNames = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue; // non-json auxiliary / archive subdirs ignored
    if (!entry.isFile()) {
      throw new Error(`${label}: ${entry.name} is not a regular file (non-regular/symlink checkpoint entries fail closed)`);
    }
    actualNames.push(entry.name);
  }
  actualNames.sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`${label}: checkpoint inventory must exactly cover the manifest classifications`);
  }
  const map = new Map();
  for (const id of ids) map.set(id, readJsonObjectStrict(path.join(dir, `${id}.json`), `${label} ${id}`).value);
  return map;
}

function normalizeSelectionSnapshot(selection, selectionHash) {
  const normalized = canonicalizeJsonKeys({
    ...selection,
    generated_at: "1970-01-01T00:00:00.000Z",
    episodes: "episodes.jsonl",
    meta: "episodes.meta.jsonl",
    concurrency: 1,
  });
  if (selectionManifestHash(normalized) !== selectionHash) {
    throw new Error("normalized selection snapshot changed selectionManifestHash");
  }
  return normalized;
}

function writeFsyncedFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function recursiveFileInventory(root) {
  const out = [];
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
      else throw new Error(`generation bundle contains a non-regular entry: ${rel}`);
    }
  };
  visit(root, "");
  return out;
}

function generationPreimage(closureSha256, filesDigest) {
  return canonicalPretty({
    contract_id: REPLAY_DATASET_GENERATION_CONTRACT_ID,
    schema_version: REPLAY_DATASET_GENERATION_SCHEMA_VERSION,
    closure_sha256: closureSha256,
    files_digest: filesDigest,
  });
}

function validateFileDescriptor(descriptor, label) {
  exactOwnKeys(descriptor, ["path", "bytes", "sha256"], label);
  assertSafeRelativePath(descriptor.path, `${label}.path`);
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) throw new Error(`${label}.bytes must be a non-negative safe integer`);
  if (typeof descriptor.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) throw new Error(`${label}.sha256 must be lowercase 64-hex`);
}

function parseDatasetCommit(marker, label = DATASET_COMMIT_FILE) {
  exactOwnKeys(marker, ["schema_version", "kind", "contract_id", "generation_id", "closure", "files", "files_digest"], label);
  if (marker.schema_version !== REPLAY_DATASET_GENERATION_SCHEMA_VERSION) throw new Error(`${label}.schema_version must be ${REPLAY_DATASET_GENERATION_SCHEMA_VERSION}`);
  if (marker.kind !== REPLAY_DATASET_GENERATION_KIND) throw new Error(`${label}.kind must be ${REPLAY_DATASET_GENERATION_KIND}`);
  if (marker.contract_id !== REPLAY_DATASET_GENERATION_CONTRACT_ID) throw new Error(`${label}.contract_id is not current`);
  if (typeof marker.generation_id !== "string" || !/^[0-9a-f]{64}$/.test(marker.generation_id)) throw new Error(`${label}.generation_id must be lowercase 64-hex`);
  validateFileDescriptor(marker.closure, `${label}.closure`);
  const expectedClosurePath = `${REPLAY_GENERATIONS_DIR}/${marker.generation_id}/closure.json`;
  if (marker.closure.path !== expectedClosurePath) throw new Error(`${label}.closure.path must be ${expectedClosurePath}`);
  if (!Array.isArray(marker.files) || marker.files.length !== REPLAY_PUBLIC_FILES.length) throw new Error(`${label}.files must contain the fixed five-file manifest`);
  marker.files.forEach((d, i) => {
    validateFileDescriptor(d, `${label}.files[${i}]`);
    if (d.path !== REPLAY_PUBLIC_FILES[i]) throw new Error(`${label}.files[${i}].path must be ${REPLAY_PUBLIC_FILES[i]}`);
  });
  if (typeof marker.files_digest !== "string" || !/^[0-9a-f]{64}$/.test(marker.files_digest)) throw new Error(`${label}.files_digest must be lowercase 64-hex`);
  const expectedDigest = sha256Hex(stableStringify(marker.files));
  if (marker.files_digest !== expectedDigest) throw new Error(`${label}.files_digest mismatch`);
  const expectedGeneration = sha256Hex(generationPreimage(marker.closure.sha256, marker.files_digest));
  if (marker.generation_id !== expectedGeneration) throw new Error(`${label}.generation_id mismatch`);
  return marker;
}

function parsePublicationIntent(intent, label = REPLAY_PUBLICATION_INTENT_FILE) {
  exactOwnKeys(intent, ["schema_version", "kind", "contract_id", "generation_id", "marker_sha256", "target_marker"], label);
  if (intent.schema_version !== REPLAY_PUBLICATION_INTENT_SCHEMA_VERSION) throw new Error(`${label}.schema_version must be ${REPLAY_PUBLICATION_INTENT_SCHEMA_VERSION}`);
  if (intent.kind !== REPLAY_PUBLICATION_INTENT_KIND) throw new Error(`${label}.kind must be ${REPLAY_PUBLICATION_INTENT_KIND}`);
  if (intent.contract_id !== REPLAY_PUBLICATION_INTENT_CONTRACT_ID) throw new Error(`${label}.contract_id is not current`);
  const marker = parseDatasetCommit(intent.target_marker, `${label}.target_marker`);
  const markerText = canonicalPretty(marker);
  if (intent.marker_sha256 !== sha256Hex(markerText)) throw new Error(`${label}.marker_sha256 mismatch`);
  if (intent.generation_id !== marker.generation_id) throw new Error(`${label}.generation_id must equal target_marker.generation_id`);
  return { intent, marker, markerText };
}

function makePublicationIntent(marker) {
  const markerText = canonicalPretty(marker);
  const intent = {
    schema_version: REPLAY_PUBLICATION_INTENT_SCHEMA_VERSION,
    kind: REPLAY_PUBLICATION_INTENT_KIND,
    contract_id: REPLAY_PUBLICATION_INTENT_CONTRACT_ID,
    generation_id: marker.generation_id,
    marker_sha256: sha256Hex(markerText),
    target_marker: marker,
  };
  return { intent, text: canonicalPretty(intent), markerText };
}

function invokePublicationFailpoint(options, name) {
  const hook = options?.publicationFailpoint;
  if (typeof hook === "function") hook(name);
  else if (hook === name) throw new Error(`t0-replay-build injected publication failpoint: ${name}`);
}

function assertSafeBasename(name, label) {
  if (typeof name !== "string" || !name || name === "." || name === ".."
    || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`${label} must be a safe basename (rejects empty, ".", "..", "/", "\\" and NUL): ${JSON.stringify(name)}`);
  }
  return name;
}

export function buildReplayBuildContext(options) {
  const context = {
    episodes_basename: assertSafeBasename(path.basename(options.episodesPath), "replay_build_context.episodes_basename"),
    meta_basename: assertSafeBasename(path.basename(options.metaPath), "replay_build_context.meta_basename"),
    exclusions_basename: assertSafeBasename(path.basename(options.exclusionsPath), "replay_build_context.exclusions_basename"),
    stats_basename: assertSafeBasename(path.basename(options.statsPath), "replay_build_context.stats_basename"),
    selection_basename: assertSafeBasename(path.basename(options.selectionPath), "replay_build_context.selection_basename"),
    models: [...options.models],
    current_only: options.currentOnly === true,
    experiment_mode: options.experimentMode ?? null,
    history_excluded: options.historyExcluded === true,
    require_paired: options.requirePaired === true,
    thinking_override: options.thinkingOverride ?? null,
    min_models: options.minModels,
    max_output_bytes: options.maxOutputBytes,
    max_episode_bytes: options.maxEpisodeBytes,
    max_retries: options.maxRetries,
    timeout_ms: options.timeoutMs,
  };
  exactOwnKeys(context, [
    "episodes_basename", "meta_basename", "exclusions_basename", "stats_basename", "selection_basename",
    "models", "current_only", "experiment_mode", "history_excluded", "require_paired", "thinking_override",
    "min_models", "max_output_bytes", "max_episode_bytes", "max_retries", "timeout_ms",
  ], "replay_build_context");
  return context;
}

function publicManifest(payloads) {
  const files = REPLAY_PUBLIC_FILES.map((name) => fileDescriptor(name, payloads[name]));
  return { files, filesDigest: sha256Hex(stableStringify(files)) };
}

function publishImmutableGeneration(outputDir, {
  sourceEpisodes,
  sourceMeta,
  sourceExclusions,
  sourceStats,
  selectionInfo,
  fairCheckpointById,
  blind,
  replayCheckpoints,
  replayBuildContext,
  payloads,
}) {
  const normalizedSelection = normalizeSelectionSnapshot(selectionInfo.selection, selectionInfo.selectionHash);
  const bundleTexts = new Map();
  bundleTexts.set("source/episodes.jsonl", sourceEpisodes.map((v) => JSON.stringify(v)).join("\n") + (sourceEpisodes.length ? "\n" : ""));
  bundleTexts.set("source/episodes.meta.jsonl", sourceMeta.map((v) => JSON.stringify(v)).join("\n") + (sourceMeta.length ? "\n" : ""));
  const canonicalSourceExclusions = sourceExclusions.map((v) => canonicalizeJsonKeys(v));
  bundleTexts.set("source/exclusions.jsonl", canonicalSourceExclusions.map((v) => JSON.stringify(v)).join("\n") + (canonicalSourceExclusions.length ? "\n" : ""));
  bundleTexts.set("source/stats.json", canonicalPretty(sourceStats));
  bundleTexts.set("selection.json", canonicalPretty(normalizedSelection));
  bundleTexts.set("blind-key.json", canonicalPretty({ schema_version: 1, blind_key: blind.key, source: blind.source }));
  for (const [id, cp] of [...fairCheckpointById.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    bundleTexts.set(`fair-checkpoints/${id}.json`, canonicalPretty(cp));
  }
  for (const cp of [...replayCheckpoints].sort((a, b) => (a.source_episode_id < b.source_episode_id ? -1 : a.source_episode_id > b.source_episode_id ? 1 : 0))) {
    const replayId = buildReplayEpisodeId(blind.key, cp.source_episode_id, replayBuildContext.models);
    bundleTexts.set(`replay-checkpoints/${replayId}.json`, canonicalPretty(cp));
  }
  const fileManifest = [...bundleTexts.entries()]
    .map(([relativePath, text]) => fileDescriptor(relativePath, text))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fairManifest = fileManifest.filter((d) => d.path.startsWith("fair-checkpoints/"));
  const replayManifest = fileManifest.filter((d) => d.path.startsWith("replay-checkpoints/"));
  const corpusDescriptors = fileManifest.filter((d) => d.path.startsWith("source/"));
  const corpusDigest = sha256Hex(stableStringify(corpusDescriptors));
  const identity = {
    producer_contract_id: REPLAY_DATASET_PRODUCER_CONTRACT_ID,
    replay_schema_version: REPLAY_SCHEMA_VERSION,
    episode_schema_version: EPISODE_SCHEMA_VERSION,
    redactor_id: REPLAY_REDACTOR_ID,
    attempt_ledger_version: ATTEMPT_LEDGER_VERSION,
    attempt_ledger_contract_id: ATTEMPT_LEDGER_CONTRACT_ID,
    replay_checkpoint_contract_id: REPLAY_CHECKPOINT_CONTRACT_ID,
    strong_reference_models: [...STRONG_REFERENCE_MODELS],
    specialist_models: [...SPECIALIST_MODELS],
    replay_judge_models: [...REPLAY_JUDGE_MODELS],
    corpus_digest: corpusDigest,
    selection_manifest_hash: selectionInfo.selectionHash,
    selection_protocol_hash: selectionInfo.protocolHash,
    blind_key_sha256: sha256Hex(blind.key),
    blind_key_source: blind.source,
    fair_checkpoints: fairManifest,
    replay_checkpoints: replayManifest,
  };
  const closure = {
    schema_version: REPLAY_DATASET_GENERATION_SCHEMA_VERSION,
    kind: REPLAY_DATASET_GENERATION_KIND,
    contract_id: REPLAY_DATASET_GENERATION_CONTRACT_ID,
    identity,
    replay_build_context: replayBuildContext,
    files: fileManifest,
  };
  const closureText = canonicalPretty(closure);
  const closureSha = sha256Hex(closureText);
  const { files, filesDigest } = publicManifest(payloads);
  const generationId = sha256Hex(generationPreimage(closureSha, filesDigest));
  const marker = {
    schema_version: REPLAY_DATASET_GENERATION_SCHEMA_VERSION,
    kind: REPLAY_DATASET_GENERATION_KIND,
    contract_id: REPLAY_DATASET_GENERATION_CONTRACT_ID,
    generation_id: generationId,
    closure: fileDescriptor(`${REPLAY_GENERATIONS_DIR}/${generationId}/closure.json`, closureText),
    files,
    files_digest: filesDigest,
  };
  const generationsDir = path.join(outputDir, REPLAY_GENERATIONS_DIR);
  const generationDir = path.join(generationsDir, generationId);
  fs.mkdirSync(generationsDir, { recursive: true });
  if (fs.existsSync(generationDir)) {
    validateGenerationBundle(outputDir, marker);
    return { marker, markerText: canonicalPretty(marker), generationDir, reused: true };
  }
  const tmpDir = path.join(generationsDir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    fs.mkdirSync(tmpDir);
    for (const [relativePath, text] of bundleTexts) writeFsyncedFile(path.join(tmpDir, ...relativePath.split("/")), text);
    writeFsyncedFile(path.join(tmpDir, "closure.json"), closureText);
    const dirs = new Set([tmpDir]);
    for (const relativePath of bundleTexts.keys()) {
      let dir = path.dirname(path.join(tmpDir, ...relativePath.split("/")));
      while (dir.startsWith(tmpDir)) {
        dirs.add(dir);
        if (dir === tmpDir) break;
        dir = path.dirname(dir);
      }
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) fsyncDirBestEffort(dir);
    fs.renameSync(tmpDir, generationDir);
    fsyncDirBestEffort(generationsDir);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
    // Single-writer rename race: a concurrent winner may have published the
    // same generation dir between our existsSync and renameSync. Linux
    // reports ENOTEMPTY (some platforms EEXIST) for rename onto an existing
    // non-empty directory — both are accepted, then the winner is validated
    // EXACTLY (inventory + bytes + hashes) before reuse; anything else
    // rethrows.
    if ((err?.code === "EEXIST" || err?.code === "ENOTEMPTY") && fs.existsSync(generationDir)) {
      validateGenerationBundle(outputDir, marker);
      return { marker, markerText: canonicalPretty(marker), generationDir, reused: true };
    }
    throw err;
  }
  validateGenerationBundle(outputDir, marker);
  return { marker, markerText: canonicalPretty(marker), generationDir, reused: false };
}

function validateGenerationBundle(outputDir, marker) {
  parseDatasetCommit(marker);
  const generationDir = path.join(outputDir, REPLAY_GENERATIONS_DIR, marker.generation_id);
  const closureFile = path.join(generationDir, "closure.json");
  const closureRead = readJsonObjectStrict(closureFile, "generation closure.json");
  if (Buffer.byteLength(closureRead.text, "utf8") !== marker.closure.bytes || sha256Hex(closureRead.text) !== marker.closure.sha256) {
    throw new Error("generation closure.json bytes/hash mismatch with dataset commit");
  }
  const closure = closureRead.value;
  if (closureRead.text !== canonicalPretty(closure)) throw new Error("generation closure.json must be canonical pretty JSON with one trailing newline");
  exactOwnKeys(closure, ["schema_version", "kind", "contract_id", "identity", "replay_build_context", "files"], "generation closure");
  if (closure.schema_version !== REPLAY_DATASET_GENERATION_SCHEMA_VERSION || closure.kind !== REPLAY_DATASET_GENERATION_KIND || closure.contract_id !== REPLAY_DATASET_GENERATION_CONTRACT_ID) {
    throw new Error("generation closure identity is not current");
  }
  exactOwnKeys(closure.identity, [
    "producer_contract_id", "replay_schema_version", "episode_schema_version", "redactor_id", "attempt_ledger_version", "attempt_ledger_contract_id",
    "replay_checkpoint_contract_id", "strong_reference_models", "specialist_models", "replay_judge_models",
    "corpus_digest", "selection_manifest_hash", "selection_protocol_hash",
    "blind_key_sha256", "blind_key_source", "fair_checkpoints", "replay_checkpoints",
  ], "generation closure.identity");
  if (closure.identity.producer_contract_id !== REPLAY_DATASET_PRODUCER_CONTRACT_ID) {
    throw new Error("generation closure is stale for the current replay dataset producer contract");
  }
  if (closure.identity.replay_schema_version !== REPLAY_SCHEMA_VERSION
    || closure.identity.episode_schema_version !== EPISODE_SCHEMA_VERSION
    || closure.identity.redactor_id !== REPLAY_REDACTOR_ID
    || closure.identity.attempt_ledger_version !== ATTEMPT_LEDGER_VERSION
    || closure.identity.attempt_ledger_contract_id !== ATTEMPT_LEDGER_CONTRACT_ID
    || closure.identity.replay_checkpoint_contract_id !== REPLAY_CHECKPOINT_CONTRACT_ID) {
    throw new Error("generation closure is stale for the current replay contracts");
  }
  for (const [key, expected] of [
    ["strong_reference_models", STRONG_REFERENCE_MODELS],
    ["specialist_models", SPECIALIST_MODELS],
    ["replay_judge_models", REPLAY_JUDGE_MODELS],
  ]) {
    if (stableStringify(closure.identity[key]) !== stableStringify(expected)) {
      throw new Error(`generation closure.identity.${key} must exactly match the current producer model arrays`);
    }
  }
  for (const key of ["corpus_digest", "selection_manifest_hash", "selection_protocol_hash", "blind_key_sha256"]) {
    if (typeof closure.identity[key] !== "string" || !/^[0-9a-f]{64}$/.test(closure.identity[key])) throw new Error(`generation closure.identity.${key} must be lowercase 64-hex`);
  }
  if (!BLIND_KEY_PERSISTED_SOURCES.includes(closure.identity.blind_key_source)) throw new Error("generation closure.identity.blind_key_source is invalid");
  if (!Array.isArray(closure.identity.fair_checkpoints) || !Array.isArray(closure.identity.replay_checkpoints)) {
    throw new Error("generation closure checkpoint manifests must be arrays");
  }
  const expectedContextKeys = [
    "episodes_basename", "meta_basename", "exclusions_basename", "stats_basename", "selection_basename",
    "models", "current_only", "experiment_mode", "history_excluded", "require_paired", "thinking_override",
    "min_models", "max_output_bytes", "max_episode_bytes", "max_retries", "timeout_ms",
  ];
  exactOwnKeys(closure.replay_build_context, expectedContextKeys, "generation closure.replay_build_context");
  const ctx = closure.replay_build_context;
  for (const key of ["episodes_basename", "meta_basename", "exclusions_basename", "stats_basename", "selection_basename"]) {
    assertSafeBasename(ctx[key], `generation closure.replay_build_context.${key}`);
  }
  if (!Array.isArray(ctx.models) || ctx.models.length === 0 || new Set(ctx.models).size !== ctx.models.length || !ctx.models.every((m) => typeof m === "string" && m)) {
    throw new Error("generation closure.replay_build_context.models must be an ordered non-empty unique string array");
  }
  for (const key of ["current_only", "history_excluded", "require_paired"]) {
    if (typeof ctx[key] !== "boolean") throw new Error(`generation closure.replay_build_context.${key} must be boolean`);
  }
  if (ctx.experiment_mode !== null && typeof ctx.experiment_mode !== "string") throw new Error("generation closure.replay_build_context.experiment_mode must be null|string");
  if (ctx.thinking_override !== null && typeof ctx.thinking_override !== "string") throw new Error("generation closure.replay_build_context.thinking_override must be null|string");
  for (const key of ["min_models", "max_output_bytes", "max_episode_bytes", "max_retries", "timeout_ms"]) {
    if (!Number.isSafeInteger(ctx[key]) || ctx[key] < 0) throw new Error(`generation closure.replay_build_context.${key} must be a non-negative safe integer`);
  }
  if (!Array.isArray(closure.files) || closure.files.length === 0) throw new Error("generation closure.files must be non-empty");
  const expectedInventory = ["closure.json"];
  const seen = new Set();
  const texts = new Map();
  for (let i = 0; i < closure.files.length; i++) {
    const descriptor = closure.files[i];
    validateFileDescriptor(descriptor, `generation closure.files[${i}]`);
    const fixedPaths = new Set([
      "source/episodes.jsonl", "source/episodes.meta.jsonl", "source/exclusions.jsonl", "source/stats.json",
      "selection.json", "blind-key.json",
    ]);
    const checkpointPath = /^(?:fair-checkpoints|replay-checkpoints)\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
    if (!fixedPaths.has(descriptor.path) && !checkpointPath.test(descriptor.path)) {
      throw new Error(`generation closure.files contains a path outside the closed bundle schema: ${descriptor.path}`);
    }
    if (seen.has(descriptor.path)) throw new Error(`generation closure.files duplicates ${descriptor.path}`);
    seen.add(descriptor.path);
    expectedInventory.push(descriptor.path);
    const file = path.join(generationDir, ...descriptor.path.split("/"));
    const text = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(text, "utf8") !== descriptor.bytes || sha256Hex(text) !== descriptor.sha256) {
      throw new Error(`generation bundle file bytes/hash mismatch: ${descriptor.path}`);
    }
    texts.set(descriptor.path, text);
  }
  for (const requiredPath of [
    "source/episodes.jsonl", "source/episodes.meta.jsonl", "source/exclusions.jsonl", "source/stats.json",
    "selection.json", "blind-key.json",
  ]) {
    if (!seen.has(requiredPath)) throw new Error(`generation closure.files is missing ${requiredPath}`);
  }
  const actualInventory = recursiveFileInventory(generationDir).sort();
  expectedInventory.sort();
  if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error("generation bundle recursive inventory has missing or extra files");
  }
  const sourceDescriptors = closure.files.filter((d) => d.path.startsWith("source/"));
  if (sha256Hex(stableStringify(sourceDescriptors)) !== closure.identity.corpus_digest) throw new Error("generation corpus_digest mismatch");
  const fairDescriptors = closure.files.filter((d) => d.path.startsWith("fair-checkpoints/"));
  const replayDescriptors = closure.files.filter((d) => d.path.startsWith("replay-checkpoints/"));
  if (stableStringify(fairDescriptors) !== stableStringify(closure.identity.fair_checkpoints)) throw new Error("generation fair checkpoint manifest mismatch");
  if (stableStringify(replayDescriptors) !== stableStringify(closure.identity.replay_checkpoints)) throw new Error("generation replay checkpoint manifest mismatch");
  return { generationDir, closure, closureText: closureRead.text, texts };
}

function parseJsonlSnapshot(text, label) {
  const out = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch (err) {
      throw new Error(`${label}:${index + 1} is not valid JSON: ${err.message}`);
    }
    if (!asRecord(value)) throw new Error(`${label}:${index + 1} must be a JSON object`);
    out.push(value);
  }
  return out;
}

function jsonMapFromBundle(texts, descriptors, prefix, label) {
  const map = new Map();
  for (const descriptor of descriptors) {
    if (!descriptor.path.startsWith(prefix) || !descriptor.path.endsWith(".json")) throw new Error(`${label} has an invalid path ${descriptor.path}`);
    const name = descriptor.path.slice(prefix.length);
    if (!name || name.includes("/")) throw new Error(`${label} path must contain one safe filename: ${descriptor.path}`);
    let value;
    try { value = JSON.parse(texts.get(descriptor.path)); } catch (err) {
      throw new Error(`${label} ${name} is not valid JSON: ${err.message}`);
    }
    if (!asRecord(value)) throw new Error(`${label} ${name} must be a JSON object`);
    if (texts.get(descriptor.path) !== canonicalPretty(value)) throw new Error(`${label} ${name} must be canonical recursive-key-order JSON`);
    map.set(name, value);
  }
  return map;
}

async function reconstructCommittedMarker(outputDir, marker, { comparePublic = true } = {}) {
  const bundle = validateGenerationBundle(outputDir, marker);
  const { closure, texts } = bundle;
  const required = [
    "source/episodes.jsonl", "source/episodes.meta.jsonl", "source/exclusions.jsonl", "source/stats.json",
    "selection.json", "blind-key.json",
  ];
  for (const relativePath of required) {
    if (!texts.has(relativePath)) throw new Error(`generation bundle is missing ${relativePath}`);
  }
  const sourceEpisodesText = texts.get("source/episodes.jsonl");
  const sourceMetaText = texts.get("source/episodes.meta.jsonl");
  const sourceExclusionsText = texts.get("source/exclusions.jsonl");
  const sourceEpisodes = parseJsonlSnapshot(sourceEpisodesText, "bundle source/episodes.jsonl");
  const sourceMeta = parseJsonlSnapshot(sourceMetaText, "bundle source/episodes.meta.jsonl");
  const sourceExclusions = parseJsonlSnapshot(sourceExclusionsText, "bundle source/exclusions.jsonl");
  if (sourceEpisodesText !== sourceEpisodes.map((v) => JSON.stringify(v)).join("\n") + (sourceEpisodes.length ? "\n" : "")) {
    throw new Error("bundle source/episodes.jsonl must be the insertion-order-preserving parsed snapshot");
  }
  if (sourceMetaText !== sourceMeta.map((v) => JSON.stringify(v)).join("\n") + (sourceMeta.length ? "\n" : "")) {
    throw new Error("bundle source/episodes.meta.jsonl must be the insertion-order-preserving parsed snapshot");
  }
  const canonicalExclusions = sourceExclusions.map((v) => canonicalizeJsonKeys(v));
  if (sourceExclusionsText !== canonicalExclusions.map((v) => JSON.stringify(v)).join("\n") + (canonicalExclusions.length ? "\n" : "")) {
    throw new Error("bundle source/exclusions.jsonl must be canonical JSONL");
  }
  let sourceStats;
  let selection;
  let blindFile;
  try {
    sourceStats = JSON.parse(texts.get("source/stats.json"));
    selection = JSON.parse(texts.get("selection.json"));
    blindFile = JSON.parse(texts.get("blind-key.json"));
  } catch (err) {
    throw new Error(`generation bundle JSON snapshot is malformed: ${err.message}`);
  }
  if (!asRecord(sourceStats)) throw new Error("bundle source/stats.json must be a JSON object");
  if (texts.get("source/stats.json") !== canonicalPretty(sourceStats)) throw new Error("bundle source/stats.json must be canonical JSON");
  if (texts.get("selection.json") !== canonicalPretty(selection)) throw new Error("bundle selection.json must be canonical JSON");
  if (selection.generated_at !== "1970-01-01T00:00:00.000Z" || selection.episodes !== "episodes.jsonl" || selection.meta !== "episodes.meta.jsonl" || selection.concurrency !== 1) {
    throw new Error("bundle selection.json deterministic normalization fields are invalid");
  }
  if (texts.get("blind-key.json") !== canonicalPretty(blindFile)) throw new Error("bundle blind-key.json must be canonical JSON");
  const blind = validateBlindKeyFileShape(blindFile, "bundle blind-key.json");
  if (sha256Hex(blind.key) !== closure.identity.blind_key_sha256 || blind.source !== closure.identity.blind_key_source) {
    throw new Error("bundle blind-key identity does not match closure");
  }
  const ctx = closure.replay_build_context;
  const logicalRoot = path.join(bundle.generationDir, ".logical");
  const selectionPath = path.join(logicalRoot, ctx.selection_basename);
  const selectionInfo = loadAndValidateSelection(selectionPath, { selectionObject: selection });
  if (selectionInfo.selectionHash !== closure.identity.selection_manifest_hash
    || selectionInfo.protocolHash !== closure.identity.selection_protocol_hash) {
    throw new Error("bundle selection identity does not match closure");
  }
  const fairByName = jsonMapFromBundle(texts, closure.identity.fair_checkpoints, "fair-checkpoints/", "bundle fair checkpoints");
  const fairCheckpointById = new Map();
  for (const [name, cp] of fairByName) fairCheckpointById.set(name.slice(0, -5), cp);
  const replayCheckpointByName = jsonMapFromBundle(texts, closure.identity.replay_checkpoints, "replay-checkpoints/", "bundle replay checkpoints");
  const options = {
    episodesPath: path.join(logicalRoot, ctx.episodes_basename),
    metaPath: path.join(logicalRoot, ctx.meta_basename),
    exclusionsPath: path.join(logicalRoot, ctx.exclusions_basename),
    statsPath: path.join(logicalRoot, ctx.stats_basename),
    selectionPath,
    episodeIds: undefined,
    limit: REPLAY_DEFAULT_LIMIT,
    concurrency: 1,
    models: [...ctx.models],
    thinkingCli: undefined,
    thinkingOverride: ctx.thinking_override,
    currentOnly: ctx.current_only,
    experimentMode: ctx.experiment_mode,
    historyExcluded: ctx.history_excluded,
    requirePaired: ctx.require_paired,
    output: bundle.generationDir,
    modelsJsonPath: "verification-only-never-read",
    maxRetries: ctx.max_retries,
    timeoutMs: ctx.timeout_ms,
    resume: true,
    blindKey: undefined,
    seed: undefined,
    minModels: ctx.min_models,
    maxOutputBytes: ctx.max_output_bytes,
    maxEpisodeBytes: ctx.max_episode_bytes,
    maxTotalBytes: Number.POSITIVE_INFINITY,
    quiet: true,
    allowLegacySelect: false,
    invoker: null,
    verificationOnly: true,
    sourceEpisodesOverride: sourceEpisodes,
    sourceMetaOverride: sourceMeta,
    sourceExclusionsOverride: sourceExclusions,
    sourceStatsOverride: sourceStats,
    selectionInfoOverride: selectionInfo,
    fairCheckpointById,
    replayCheckpointByName,
    blindOverride: blind,
  };
  const rebuilt = await buildReplay(options);
  const { files, filesDigest } = publicManifest(rebuilt.payloads);
  if (filesDigest !== marker.files_digest || stableStringify(files) !== stableStringify(marker.files)) {
    throw new Error("reconstructed public payload manifest does not match dataset commit");
  }
  for (const ep of rebuilt.episodes) {
    assertAnonymousBody(ep);
    assertAnonymousReplayBody(ep, "committed replay loader");
    assertNoPrivateMaterialKeys(ep, "committed episodes.jsonl");
  }
  for (const rec of rebuilt.sidecar) assertNoPrivateMaterialKeys(rec, "committed episodes.meta.jsonl");
  for (const rec of rebuilt.exclusions) assertNoPrivateMaterialKeys(rec, "committed exclusions.jsonl");
  assertNoPrivateMaterialKeys(rebuilt.stats, "committed stats.json");
  if (comparePublic) {
    for (const descriptor of marker.files) {
      const file = path.join(outputDir, descriptor.path);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch (err) {
        throw new Error(`committed public file cannot be read: ${descriptor.path}: ${err.message}`);
      }
      if (text !== rebuilt.payloads[descriptor.path]
        || Buffer.byteLength(text, "utf8") !== descriptor.bytes
        || sha256Hex(text) !== descriptor.sha256) {
        throw new Error(`committed public file bytes mismatch: ${descriptor.path}`);
      }
    }
  }
  return { rebuilt, bundle };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export async function loadCommittedReplayDataset(outputDir) {
  const markerFile = path.join(outputDir, DATASET_COMMIT_FILE);
  if (!fs.existsSync(markerFile)) return null;
  const start = readJsonObjectStrict(markerFile, DATASET_COMMIT_FILE);
  const marker = parseDatasetCommit(start.value);
  if (start.text !== canonicalPretty(marker)) throw new Error(`${DATASET_COMMIT_FILE} must be canonical pretty JSON with one trailing newline`);
  // First verification pass: full contextual rebuild + the exact public
  // bytes against rebuilt.payloads and the marker descriptors (never
  // weakened).
  const { rebuilt } = await reconstructCommittedMarker(outputDir, marker, { comparePublic: true });
  // Marker probe #2: a concurrent publication may have revoked/replaced the
  // marker while we rebuilt — a disappearance (ENOENT) is wrapped into the
  // same explicit "changed while" error, never a raw ENOENT.
  let secondText;
  try {
    secondText = fs.readFileSync(markerFile, "utf8");
  } catch (err) {
    throw new Error(`${DATASET_COMMIT_FILE} changed while the committed dataset was being loaded (marker disappeared): ${err.message}`);
  }
  if (secondText !== start.text) {
    throw new Error(`${DATASET_COMMIT_FILE} changed while the committed dataset was being loaded`);
  }
  // Second verification pass: byte-by-byte re-read of the five public files
  // against rebuilt.payloads + the marker descriptors — catches a public
  // file swapped between the first compare and the marker probe.
  for (const descriptor of marker.files) {
    const file = path.join(outputDir, descriptor.path);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (err) {
      throw new Error(`committed public file changed while the committed dataset was being loaded (${descriptor.path} disappeared): ${err.message}`);
    }
    if (text !== rebuilt.payloads[descriptor.path]
      || Buffer.byteLength(text, "utf8") !== descriptor.bytes
      || sha256Hex(text) !== descriptor.sha256) {
      throw new Error(`committed public file changed while the committed dataset was being loaded: ${descriptor.path}`);
    }
  }
  // Marker probe #3: exact final read — any change/disappearance since probe
  // #2 fails closed.
  let thirdText;
  try {
    thirdText = fs.readFileSync(markerFile, "utf8");
  } catch (err) {
    throw new Error(`${DATASET_COMMIT_FILE} changed while the committed dataset was being loaded (marker disappeared): ${err.message}`);
  }
  if (thirdText !== start.text) {
    throw new Error(`${DATASET_COMMIT_FILE} changed while the committed dataset was being loaded`);
  }
  return deepFreeze({
    episodes: rebuilt.episodes,
    meta: rebuilt.sidecar,
    exclusions: rebuilt.exclusions,
    stats: rebuilt.stats,
    marker,
    generationId: marker.generation_id,
  });
}

function publishCommittedPayloads(outputDir, marker, payloads, options, { intentAlreadyExists = false } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const markerFile = path.join(outputDir, DATASET_COMMIT_FILE);
  const intentFile = path.join(outputDir, REPLAY_PUBLICATION_INTENT_FILE);
  const publication = makePublicationIntent(marker);
  const reuseIntent = intentAlreadyExists || fs.existsSync(intentFile);
  if (reuseIntent) {
    const existing = readJsonObjectStrict(intentFile, REPLAY_PUBLICATION_INTENT_FILE);
    const parsed = parsePublicationIntent(existing.value);
    if (existing.text !== publication.text || parsed.markerText !== publication.markerText) {
      throw new Error("existing replay publication intent differs from the target generation");
    }
  } else {
    invokePublicationFailpoint(options, "beforeIntentWrite");
    writeTextFileAtomic(intentFile, publication.text);
    invokePublicationFailpoint(options, "afterIntentWrite");
  }
  invokePublicationFailpoint(options, "beforeMarkerRevoke");
  fs.rmSync(markerFile, { force: true });
  fsyncDirBestEffort(outputDir);
  invokePublicationFailpoint(options, "afterMarkerRevoke");
  for (const name of REPLAY_PUBLIC_FILES) {
    invokePublicationFailpoint(options, `beforePublicWrite:${name}`);
    writeTextFileAtomic(path.join(outputDir, name), payloads[name]);
    invokePublicationFailpoint(options, `afterPublicWrite:${name}`);
  }
  invokePublicationFailpoint(options, "beforeMarkerWrite");
  writeTextFileAtomic(markerFile, publication.markerText);
  invokePublicationFailpoint(options, "afterMarkerWrite");
  fs.rmSync(intentFile, { force: true });
  fsyncDirBestEffort(outputDir);
}

async function planReplayPublicationState(options) {
  const markerFile = path.join(options.output, DATASET_COMMIT_FILE);
  const intentFile = path.join(options.output, REPLAY_PUBLICATION_INTENT_FILE);
  const markerExists = fs.existsSync(markerFile);
  const intentExists = fs.existsSync(intentFile);
  if (options.allowLegacySelect && (markerExists || intentExists)) {
    throw new Error("legacy --allow-legacy-select is uncommitted fixture tooling and cannot touch a committed or recovering replay directory");
  }
  let committed = null;
  let markerText = null;
  if (markerExists) {
    markerText = fs.readFileSync(markerFile, "utf8");
    committed = await loadCommittedReplayDataset(options.output);
  }
  if (!intentExists) return { committed };
  const intentRead = readJsonObjectStrict(intentFile, REPLAY_PUBLICATION_INTENT_FILE);
  const parsedIntent = parsePublicationIntent(intentRead.value);
  if (intentRead.text !== canonicalPretty(parsedIntent.intent)) throw new Error(`${REPLAY_PUBLICATION_INTENT_FILE} must be canonical pretty JSON with one trailing newline`);
  if (markerExists && markerText === parsedIntent.markerText) {
    fs.rmSync(intentFile, { force: true });
    fsyncDirBestEffort(options.output);
    return { committed };
  }
  if (options.resume !== true) {
    throw new Error("replay publication recovery is required but --no-resume was supplied");
  }
  const recovered = await reconstructCommittedMarker(options.output, parsedIntent.marker, { comparePublic: false });
  publishCommittedPayloads(options.output, parsedIntent.marker, recovered.rebuilt.payloads, options, { intentAlreadyExists: true });
  return {
    recovered: {
      episodes: recovered.rebuilt.episodes,
      sidecar: recovered.rebuilt.sidecar,
      exclusions: recovered.rebuilt.exclusions,
      stats: recovered.rebuilt.stats,
      marker: parsedIntent.marker,
      generationId: parsedIntent.marker.generation_id,
      run: {
        requested: 0,
        new_checkpoints: 0,
        reused_requested: 0,
        dataset_checkpoints: recovered.rebuilt.checkpoints.length,
        dataset_episodes: recovered.rebuilt.episodes.length,
      },
      recovered: true,
    },
  };
}

/**
 * Persist the blind key for an output directory, strictly ordered AFTER the
 * pre-scan proved the existing checkpoints dir clean (a bad checkpoint fails
 * closed with zero invoker/provider work AND no blind-key.json
 * created/modified).
 *
 * `blind` MUST be the already-resolved blind object the caller's pre-scan
 * used (buildReplay passes its resolveBlindKey result in): this function
 * never resolves/generates a key itself, so the pre-scan, the persisted
 * file, the checkpoints and the post-scan all share one key — a fresh
 * no-seed first run can never split into two random keys.
 *
 * - The passed `blind` itself must be exact producer shape (canonical
 *   lowercase 64-hex key + a source among the stable persisted values) — a
 *   malformed blind can never be written.
 * - An existing blind-key.json is NEVER rewritten (bytes/mtime kept) and
 *   must pass the strict closed-shape preflight (validateBlindKeyFileShape):
 *   exact keys {schema_version, blind_key, source}, schema_version===1,
 *   canonical lowercase 64-hex blind_key, and a source among the stable
 *   values the producers persist. Extra/missing keys, non-canonical case,
 *   wrong schema_version and illegal sources all fail closed BEFORE the
 *   invoker/provider is created.
 * - Reuse is decided by file existence + key equality, never by the parsed
 *   `source` field (the file may legitimately store source:"generated"); an
 *   explicit --blind-key/--seed whose derived key CONFLICTS with the
 *   persisted key fails closed instead of overwriting, a matching key is
 *   reused without rewriting.
 * - FIRST publication is race-safe exclusive create-if-absent: a
 *   same-directory temp is fully written + fsynced, then published via an
 *   atomic hard link (`fs.linkSync`), NEVER a rename-overwrite of the
 *   canonical. An EEXIST loser reads + strict-validates the winner (which is
 *   by construction a complete file — the winner published the same way) and
 *   reuses it on key equality / fails closed on conflict; the canonical
 *   bytes are never clobbered by a concurrent writer. The temp is always
 *   cleaned up (finally), the dir fsync is best-effort.
 * - A lost/corrupted paid-directory fact is never replaced by a fresh key:
 *   an existing-but-invalid file throws (fail closed).
 *
 * Returns { key, source } — the key is always the passed `blind.key`;
 * source reflects the persisted file's own (strict-validated) source field
 * when the file exists, so repeated builds produce byte-identical stats.
 */
export function persistBlindKey(outputDir, blind) {
  const keyFile = path.join(outputDir, BLIND_KEY_FILE);
  // The blind to persist must itself be exact producer shape — a malformed
  // first blind can never be published.
  validateBlindKeyFileShape({ schema_version: 1, blind_key: blind.key, source: blind.source }, keyFile);
  if (fs.existsSync(keyFile)) {
    // Re-validate the persisted file even when an explicit --blind-key/--seed
    // was given (resolveBlindKey skips the file in that case): an explicit
    // key can never silently overwrite a different persisted key, and a
    // corrupted / non-producer-shaped file is never replaced by a fresh key.
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    } catch {
      throw new Error(`blind-key.json exists but is not valid JSON: ${keyFile}`);
    }
    const fileBlind = validateBlindKeyFileShape(parsed, keyFile);
    if (blind.key !== fileBlind.key) {
      throw new Error(
        `blind-key.json exists with a different blind key — explicit --blind-key/--seed conflicts with the persisted key; refusing to overwrite (${keyFile})`,
      );
    }
    // Same key: reuse the persisted file — never rewrite (bytes/mtime kept).
    return { key: fileBlind.key, source: fileBlind.source };
  }
  // Exclusive first publication (race-safe): fully-written + fsynced
  // same-dir temp, then atomic create-if-absent hard link. The canonical is
  // NEVER rename-overwritten, so a concurrent winner can never be clobbered
  // and the winner's canonical is always a complete file.
  fs.mkdirSync(outputDir, { recursive: true });
  const payload = `${JSON.stringify({ schema_version: 1, blind_key: blind.key, source: blind.source }, null, 2)}\n`;
  const tmp = path.join(outputDir, `.${path.basename(keyFile)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, keyFile);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Lost the race: read + strict-validate the winner, never overwrite.
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      } catch {
        throw new Error(`blind-key.json exists but is not valid JSON: ${keyFile}`);
      }
      const fileBlind = validateBlindKeyFileShape(parsed, keyFile);
      if (blind.key !== fileBlind.key) {
        throw new Error(
          `blind-key.json exists with a different blind key — explicit --blind-key/--seed conflicts with the persisted key; refusing to overwrite (${keyFile})`,
        );
      }
      return { key: fileBlind.key, source: fileBlind.source };
    }
    fsyncDirBestEffort(outputDir);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  return blind;
}

/**
 * Recompute public replay call cost stats from verified attempt_log ledgers
 * on sidecar meta records. NEVER trusts slot.replay.cost / attempts aggregates;
 * slot-level r.cost is never mutated.
 *
 * Ternary cost semantics (aligned with eval):
 *   - known_cost: always-numeric sum of attempts with numeric cost evidence
 *     (provider/estimated numeric enter known; non-number cost is never a
 *     fake 0 completion)
 *   - unknown_attempts: count of attempts where typeof cost !== "number"
 *   - cost_complete = (unknown_attempts === 0)
 *   - cost = cost_complete ? known_cost : null  (partial never presented as total)
 *   - cost_source / cost_breakdown recomputed from the attempt ledgers
 *   - attempts = ledger length (not r.attempts)
 *
 * Returns the calls object used by both stats.replay.calls and aggregate
 * replayReport.calls. by_model entries carry the same ternary fields.
 */
export function summarizeReplayCallsFromMeta(metaRecords) {
  const emptyBreakdown = () => ({ provider: 0, estimated: 0, unknown: 0 });
  const emptyModel = () => ({
    total: 0, ok: 0, failed: 0, attempts: 0,
    known_cost: 0, unknown_attempts: 0,
    cost_complete: true, cost: 0, cost_source: null,
    cost_breakdown: emptyBreakdown(),
  });
  const calls = {
    total: 0, ok: 0, failed: 0, attempts: 0,
    known_cost: 0, unknown_attempts: 0,
    cost_complete: true, cost: 0, cost_source: null,
    cost_breakdown: emptyBreakdown(),
    by_model: {},
  };
  const allSources = new Set();
  const modelSources = new Map();
  for (const meta of metaRecords ?? []) {
    for (const slot of meta?.slots ?? []) {
      const r = slot.replay;
      if (!r) continue;
      const model = slot.model ?? "unknown";
      const log = Array.isArray(r.attempt_log) ? r.attempt_log : [];
      const inBody = slot.in_body === true;
      calls.total++;
      if (inBody) calls.ok++;
      else calls.failed++;
      calls.attempts += log.length;
      const m = calls.by_model[model] ?? emptyModel();
      m.total++;
      if (inBody) m.ok++;
      else m.failed++;
      m.attempts += log.length;
      if (!modelSources.has(model)) modelSources.set(model, new Set());
      const mSrcs = modelSources.get(model);
      for (const a of log) {
        const src = a?.cost_source ?? "unknown";
        const hasNum = typeof a?.cost === "number";
        const cost = hasNum ? a.cost : 0;
        if (!hasNum) {
          calls.unknown_attempts++;
          m.unknown_attempts++;
        } else {
          // provider/estimated numeric enter known; any other numeric still
          // contributes to known_cost (sum of numeric evidence) while landing
          // in cost_breakdown.unknown — never fabricate a complete 0 total.
          calls.known_cost += cost;
          m.known_cost += cost;
        }
        if (src === "provider") {
          calls.cost_breakdown.provider += cost;
          m.cost_breakdown.provider += cost;
        } else if (src === "estimated") {
          calls.cost_breakdown.estimated += cost;
          m.cost_breakdown.estimated += cost;
        } else {
          calls.cost_breakdown.unknown += cost;
          m.cost_breakdown.unknown += cost;
        }
        allSources.add(src);
        mSrcs.add(src);
      }
      calls.by_model[model] = m;
    }
  }
  calls.cost_complete = calls.unknown_attempts === 0;
  calls.cost = calls.cost_complete ? calls.known_cost : null;
  calls.cost_source = allSources.size === 0 ? null : allSources.size === 1 ? [...allSources][0] : "mixed";
  for (const [model, m] of Object.entries(calls.by_model)) {
    m.cost_complete = m.unknown_attempts === 0;
    m.cost = m.cost_complete ? m.known_cost : null;
    const srcs = modelSources.get(model) ?? new Set();
    m.cost_source = srcs.size === 0 ? null : srcs.size === 1 ? [...srcs][0] : "mixed";
  }
  return calls;
}

export function buildStats({
  options,
  blind,
  sourceEpisodes,
  selectionExcluded,
  checkpoints,
  exclusions,
  corpusModelNames,
  selectionInfo = null,
}) {
  // Public call cost stats are recomputed solely from verified attempt_log
  // ledgers via the shared pure helper (same ternary as aggregate). Slot-level
  // r.cost is never trusted and never mutated.
  const sidecarRecords = checkpoints.map((cp) => cp.sidecar).filter(Boolean);
  const baseCalls = summarizeReplayCallsFromMeta(sidecarRecords);
  const replayCalls = {
    ...baseCalls,
    by_model: {},
    by_error_class: {},
  };
  // Enrich by_model with build-only error counters; preserve the ternary
  // cost fields produced by the shared helper.
  for (const [model, m] of Object.entries(baseCalls.by_model)) {
    replayCalls.by_model[model] = { ...m, degeneration: 0, thinking_unsupported: 0 };
  }
  const byModelCount = {};
  const slotsBySource = { historical: 0, replay: 0 };
  const availabilityByReason = {};
  let totalEpisodeBytes = 0;
  let bodyEpisodes = 0;
  for (const cp of checkpoints) {
    const ep = cp.episode;
    if (ep) {
      bodyEpisodes++;
      byModelCount[ep.slots?.length ?? 0] = (byModelCount[ep.slots?.length ?? 0] ?? 0) + 1;
      totalEpisodeBytes += utf8ByteLength(JSON.stringify(ep)) + 1;
    }
    for (const slot of cp.sidecar?.slots ?? []) {
      if (slot.in_body === true) {
        slotsBySource[slot.source?.kind === "historical" ? "historical" : "replay"]++;
      } else {
        availabilityByReason[slot.exclusion_reason ?? "unknown"] = (availabilityByReason[slot.exclusion_reason ?? "unknown"] ?? 0) + 1;
      }
      const r = slot.replay;
      if (r) {
        const ec = r.error_class ?? (slot.in_body ? null : "unknown");
        if (ec) replayCalls.by_error_class[ec] = (replayCalls.by_error_class[ec] ?? 0) + 1;
        const m = replayCalls.by_model[slot.model];
        if (!m) {
          // Theoretically unreachable: every model with a replay slot must
          // already have a by_model entry from summarizeReplayCallsFromMeta.
          // Never forge a complete $0 fallback that would silently mask a
          // ledger/closure bug.
          throw new Error(`buildStats: internal closure error: model ${JSON.stringify(slot.model)} has a replay slot but is missing from by_model (summarizeReplayCallsFromMeta must have produced an entry)`);
        }
        if (slot.exclusion_reason === "thinking_level_unsupported") {
          m.thinking_unsupported++;
        } else if (
          slot.exclusion_reason === "infrastructure_or_generation_failure"
          || (Array.isArray(r.attempt_log)
            && r.attempt_log.some((a) => a.error_class === "infrastructure_or_generation_failure"
              && !(a.error || "").includes("thinking level")))
        ) {
          m.degeneration++;
        }
        replayCalls.by_model[slot.model] = m;
      }
    }
  }

  const selectionExcludedByReason = {};
  for (const e of selectionExcluded) {
    for (const r of e.reasons ?? [e.reason].filter(Boolean)) {
      selectionExcludedByReason[r] = (selectionExcludedByReason[r] ?? 0) + 1;
    }
  }

  return {
    schema_version: REPLAY_SCHEMA_VERSION,
    dataset_mode: "replay",
    inputs: {
      // Stable locators only — absolute input paths would break
      // same-evidence rebuild across directories (the five public files must
      // be byte-identical for the same checkpoint set regardless of where
      // the corpus lives). Source semantic validation is unaffected: the
      // loader/provenance still validate the real files by path.
      episodes: path.basename(options.episodesPath),
      meta: path.basename(options.metaPath),
      selection: selectionInfo?.path ? path.basename(selectionInfo.path) : null,
      selection_hash: selectionInfo?.selectionHash ?? null,
      selection_protocol_hash: selectionInfo?.protocolHash ?? null,
      episodes_available: sourceEpisodes.length,
      corpus_models: corpusModelNames.length,
    },
    selection: {
      mode: options.currentOnly
        ? "current_only_manifest"
        : (selectionInfo ? "fair_manifest" : "legacy_fixture"),
      // cumulative = body episodes under CURRENT selection+protocol only
      // (old checkpoints with mismatched hashes are never mixed in). These
      // are recomputable from the cumulative checkpoint set alone — the
      // per-run facts (requested / new / reused) live in buildReplay's
      // private `run` return, never in the public files, so the five files
      // are byte-identical for the same checkpoint set regardless of how
      // this run was invoked (--episode subset / resume).
      cumulative: bodyEpisodes,
      cumulative_checkpoints: checkpoints.length,
      excluded: selectionExcluded.length,
      excluded_by_reason: sortedObject(selectionExcludedByReason),
      classifier_models: selectionInfo?.classifierModels ?? null,
      downstream_judges: selectionInfo?.downstreamJudges ?? null,
    },
    replay: {
      models: options.models,
      thinking_policy: options.currentOnly
        ? "unified_high"
        : "source_episode_thinking_level",
      thinking: options.currentOnly ? CURRENT_ONLY_THINKING : null,
      experiment_mode: options.experimentMode ?? null,
      history_excluded: options.historyExcluded === true,
      paired_required: options.requirePaired === true,
      system_prompt: REPLAY_SYSTEM_PROMPT,
      user_protocol: REPLAY_USER_PROTOCOL,
      calls: {
        ...replayCalls,
        by_model: sortedObject(replayCalls.by_model),
        by_error_class: sortedObject(replayCalls.by_error_class),
      },
    },
    episodes: {
      count: bodyEpisodes,
      checkpoints: checkpoints.length,
      by_slot_count: sortedObject(byModelCount),
      slots_by_source: slotsBySource,
      total_episode_bytes: totalEpisodeBytes,
    },
    availability: {
      slots_excluded: Object.values(availabilityByReason).reduce((s, n) => s + n, 0),
      by_reason: sortedObject(availabilityByReason),
    },
    build_exclusions: exclusions,
    blind_key: { source: blind.source, sha256: sha256Hex(blind.key) },
    resource: {
      min_models: options.minModels,
      max_output_bytes: options.maxOutputBytes,
      max_episode_bytes: options.maxEpisodeBytes,
      // max_total_bytes is a publication guard (checked after the run, not
      // bound into the checkpoint protocol) — it never enters the public
      // stats identity, so changing only it cannot change the five files.
    },
  };
}

export function buildReadme(stats) {
  const historyExcluded = stats.replay?.history_excluded === true;
  const experimentMode = stats.replay?.experiment_mode ?? null;
  const thinkingPolicy = stats.replay?.thinking_policy ?? "source_episode_thinking_level";
  return `# T0 Fair Prompt-Only Replay Dataset

Generated by \`scripts/t0-replay-build.mjs\` (schema v${stats.schema_version}).

## What this is

A fair prompt-only production replay: \`${(stats.replay.models ?? []).join("` / `")}\`
re-answered selected production prompts. Selection came from a fair
\`prompt_only_replay_selection\` manifest (not the legacy internal selector).

${historyExcluded
    ? "Body episodes contain **only** the current candidate answers under a fresh blind key (history_excluded=true). An episode enters the paired capability main set only when every current model succeeds."
    : "Each body episode keeps historical candidate answers + successful replay answers under a fresh blind key. Historical and replay slots are **indistinguishable** in the body (no source/output_source/join markers)."}

## Judge-feedable files

- **episodes.jsonl** — the ONLY file that may be fed to an anonymous LLM judge.

Body fields only: \`schema_version\`, \`dataset_mode\`, \`episode_id\`, \`prompt\`,
\`thinking\`, \`tools\` (always null), \`slots[{slot_id,model_id,output,result}]\`.

## Commit and private evidence

\`dataset.commit.json\` is the sole dataset commit point. If it is absent,
the directory is not committed evidence even when the five public files are
present. The marker binds the exact five public payloads and locates only
\`.replay-generations/<generation_id>/closure.json\`; the generation id binds
the current closure contract, closure hash and public files digest.

Generation bundles are immutable, single-writer evidence. They are never
modified after directory rename and have no automatic garbage collection. A
publication crash is resumed exactly from \`.replay-publication-intent.json\`
and the immutable target bundle with zero provider calls. Legacy
\`--allow-legacy-select\` fixture output remains uncommitted and cannot touch a
directory containing a marker or publication intent.

**The generation bundle is private evidence — never feed or share it
indiscriminately.** \`.replay-generations/<generation_id>/\` contains a full
copy of the source corpus (\`source/episodes.jsonl\`,
\`source/episodes.meta.jsonl\`, \`source/exclusions.jsonl\`, \`source/stats.json\`),
the plaintext blind key (\`blind-key.json\`), the full selection manifest, the
exact fair classifier checkpoints, and every raw accepted replay output
(\`replay-checkpoints/*.json\` — the private \`raw_accepted_output\` material).
These are sensitive: never feed them to a judge, never share them
indiscriminately, and never publish them as part of the dataset. There is no
automatic garbage collection — bundles accumulate until explicitly removed.

## NEVER feed to a judge

- **episodes.meta.jsonl** — identity, source mapping, attempts/cost/join
- **blind-key.json**
- **exclusions.jsonl**
- **stats.json**
- **dataset.commit.json**
- **.replay-publication-intent.json**
- **.replay-generations/**
- **checkpoints/**

Only \`episodes.jsonl\` is judge-feedable. Marker, intent, closure, private
snapshots, checkpoints, metadata, stats and exclusions are never judge input.

## Replay protocol

All models received the SAME neutral system/user protocol, NO tools, and the
SAME thinking policy (\`${thinkingPolicy}\`${stats.replay?.thinking ? ` = \`${stats.replay.thinking}\`` : ""}).
Unsupported thinking levels and generation degeneration are recorded as
\`infrastructure_or_generation_failure\` in the sidecar and never enter the body.
Successful attempts have \`error_class=null\`.

**\`tools:null\` caveat.** Historical episodes carry \`tools: null\` in the body,
which only means **no explicit tools allowlist was recorded** for that episode
— it is NOT evidence that the historical model ran with an empty effective
toolset, and it does NOT establish a strict equal-runtime capability delta
between historical and replay answers. Replay answers are prompt-only by
construction; historical answers are not. Capability claims must be scoped to
the replay counterfactual, never inferred from \`tools:null\`.

experiment_mode: \`${experimentMode ?? "null (fair source-thinking)"}\`
history_excluded: \`${historyExcluded}\`
paired_required: \`${stats.replay?.paired_required === true}\`

## Selection

- mode: \`${stats.selection.mode}\`
- cumulative body episodes: ${stats.selection.cumulative}
- cumulative matching checkpoints: ${stats.selection.cumulative_checkpoints}
- selection_hash: \`${stats.inputs.selection_hash ?? "n/a"}\`

This is **prompt-only judgment qualification**, not an agentic execution score.
`;
}

/**
 * Private material keys that must NEVER appear in any public artifact. The
 * raw accepted output lives only under `raw_accepted_output` inside the
 * checkpoint; `replay_material` is the container. The legitimate `output`
 * field of body slots is NOT in this set — a legal answer that happens to
 * equal a prompt or any other public text is never a leak (field-level
 * structural ban, not string-content matching).
 */
const PRIVATE_MATERIAL_KEYS = Object.freeze(["replay_material", "raw_accepted_output"]);

/**
 * Recursively reject any occurrence of a private material key in a public
 * artifact. Structural, field-level: an object carrying `replay_material` /
 * `raw_accepted_output` at ANY nesting depth is refused, regardless of the
 * string content of the values (content equality with a prompt or another
 * public text is never a false positive).
 */
function assertNoPrivateMaterialKeys(value, where) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateMaterialKeys(item, where);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (PRIVATE_MATERIAL_KEYS.includes(key)) {
        throw new Error(`writeOutputs: private checkpoint material key ${JSON.stringify(key)} must never be published (found in ${where})`);
      }
      assertNoPrivateMaterialKeys(value[key], where);
    }
  }
}

export function preparePublicPayloads({ episodes, sidecar, exclusions, stats }) {
  const snapshot = {
    episodes: (episodes ?? []).map((e) => canonicalizeJsonKeys(e)),
    sidecar: (sidecar ?? []).map((e) => canonicalizeJsonKeys(e)),
    exclusions: (exclusions ?? []).map((e) => canonicalizeJsonKeys(e)),
    stats: canonicalizeJsonKeys(stats ?? {}),
  };
  for (const ep of snapshot.episodes) assertAnonymousBody(ep);
  for (const ep of snapshot.episodes) assertAnonymousReplayBody(ep, "anonymous replay body (production write guard)");
  for (const rec of snapshot.sidecar) assertNoPrivateMaterialKeys(rec, "episodes.meta.jsonl");
  for (const e of snapshot.exclusions) assertNoPrivateMaterialKeys(e, "exclusions.jsonl");
  assertNoPrivateMaterialKeys(snapshot.stats, "stats.json");
  for (const ep of snapshot.episodes) assertNoPrivateMaterialKeys(ep, "episodes.jsonl");
  return { snapshot, payloads: renderPublicPayloads(snapshot) };
}

export function writeOutputs(outputDir, values) {
  const { payloads } = preparePublicPayloads(values);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of REPLAY_PUBLIC_FILES) writeTextFileAtomic(path.join(outputDir, name), payloads[name]);
}

/**
 * Shared pure public-payload renderer: the ONLY writer of the five public
 * files. Recursively canonicalizes object keys (arrays keep order) and
 * returns the exact payload bytes for episodes.jsonl / episodes.meta.jsonl /
 * exclusions.jsonl / stats.json / README.md. Guards (assertAnonymousBody /
 * assertNoPrivateMaterialKeys) must run BEFORE rendering; this function
 * itself never writes.
 */
export function renderPublicPayloads({ episodes = [], sidecar = [], exclusions = [], stats = {} } = {}) {
  const cEpisodes = episodes.map((e) => canonicalizeJsonKeys(e));
  const cSidecar = sidecar.map((e) => canonicalizeJsonKeys(e));
  const cExclusions = exclusions.map((e) => canonicalizeJsonKeys(e));
  const cStats = canonicalizeJsonKeys(stats);
  return {
    "episodes.jsonl": cEpisodes.map((e) => JSON.stringify(e)).join("\n") + (cEpisodes.length > 0 ? "\n" : ""),
    "episodes.meta.jsonl": cSidecar.map((e) => JSON.stringify(e)).join("\n") + (cSidecar.length > 0 ? "\n" : ""),
    "exclusions.jsonl": cExclusions.map((e) => JSON.stringify(e)).join("\n") + (cExclusions.length > 0 ? "\n" : ""),
    "stats.json": `${JSON.stringify(cStats, null, 2)}\n`,
    "README.md": buildReadme(cStats),
  };
}

// ── main pipeline ─────────────────────────────────────────────────────────

/**
 * Canonical UTC ISO-8601 timestamp check: the string must parse AND round-trip
 * through `new Date(s).toISOString()` unchanged — the exact form the producer
 * writes (`new Date().toISOString()`). Date.parse-acceptable but non-canonical
 * texts (e.g. `2026-08-13T22:00:00Z`, `2026-08-13 22:00:00`) are rejected.
 */
function isCanonicalIsoTimestamp(s) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

/**
 * Validate the private replay material under the strict closure contract:
 * one entry per model in exact `models` order; each entry carries EXACTLY
 * the producer's key set; `thinking` must equal the current
 * resolveReplayThinking (a material+sidecar sync tamper can never change the
 * thinking policy); ok=true entries carry the raw accepted output whose
 * sha256 MUST equal the ledger's ok=true accepted_output_hash (RECOMPUTED
 * here — never trusted from the file) and the ledger must contain EXACTLY
 * ONE ok=true entry, the LAST one, with all prior entries failed/null-hash;
 * ok=false entries carry no raw output, must not claim any ok=true ledger
 * entry, and must close over the LAST ledger entry's error/error_class with
 * exclusion_reason derived per runReplayAnswer
 * (infrastructure_or_generation_failure -> same name, else replay_call_failed);
 * an empty ledger keeps only the legal pre-request failure combos;
 * attempts/cost/cost_source/usage close over the attempt_log; calledAt is a
 * canonical UTC ISO timestamp (new Date().toISOString() form); request_ids are unique across the whole
 * checkpoint (shared seenIds). Postprocess failures (ambiguous identity /
 * redaction cap) are NOT material-level failures: the provider succeeded
 * (ok=true, raw output present) and the failure state is re-derived by
 * buildReplayEpisode during the contextual rebuild.
 */
function validateReplayMaterial(material, { models, seenIds, expectedThinking, label = "replay_material" }) {
  const errors = [];
  if (!Array.isArray(material)) {
    return { ok: false, errors: [`${label} must be an array (old material-less checkpoints are rejected)`] };
  }
  if (material.length !== models.length) {
    return { ok: false, errors: [`${label}.length ${material.length} != models.length ${models.length} (each model exactly one material entry)`] };
  }
  for (let i = 0; i < material.length; i++) {
    const m = material[i];
    const at = `${label}[${i}]`;
    if (!asRecord(m)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    // Exact key set: the material is a closed serialization contract — an
    // extra key can smuggle private data into a rebuild, a missing key can
    // hide a required field.
    const keys = Object.keys(m).sort();
    const expectedKeys = [...REPLAY_MATERIAL_ENTRY_KEYS].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      errors.push(`${at} must carry EXACTLY the keys ${JSON.stringify(REPLAY_MATERIAL_ENTRY_KEYS)} (got ${JSON.stringify(Object.keys(m))})`);
    }
    if (m.model !== models[i]) {
      errors.push(`${at}.model ${JSON.stringify(m.model)} != models[${i}] ${JSON.stringify(models[i])} (material order must match models exactly)`);
    }
    if (typeof m.ok !== "boolean") {
      errors.push(`${at}.ok must be a boolean`);
    }
    // Thinking policy closure: the material's per-entry thinking must equal
    // the CURRENT resolveReplayThinking — a material+sidecar sync tamper
    // that rewrites thinking on both surfaces can never bypass the expected
    // policy (fair source-thinking / current-only unified high).
    if (m.thinking !== expectedThinking) {
      errors.push(`${at}.thinking ${JSON.stringify(m.thinking)} != expected replay thinking ${JSON.stringify(expectedThinking)} (material+sidecar sync tamper cannot change the thinking policy)`);
    }
    if (!isCanonicalIsoTimestamp(m.calledAt)) {
      errors.push(`${at}.calledAt must be a canonical UTC ISO timestamp (new Date().toISOString() form), got ${JSON.stringify(m.calledAt)}`);
    }
    if (!Array.isArray(m.attempt_log)) {
      errors.push(`${at}.attempt_log must be an array`);
      continue;
    }
    const ledgerCheck = validateAttemptLedgerV2(m.attempt_log, {
      modelRef: typeof m.model === "string" ? m.model : null,
      expectedOperation: "t0_replay_answer",
      seenIds,
      label: `${at}.attempt_log`,
    });
    errors.push(...ledgerCheck.errors);
    const successEntries = m.attempt_log.filter((e) => e?.ok === true);
    if (m.ok === true) {
      if (typeof m.raw_accepted_output !== "string" || m.raw_accepted_output.length === 0) {
        errors.push(`${at}.raw_accepted_output must be a non-empty string when ok=true (the raw accepted output)`);
      }
      if (m.error !== null && m.error !== undefined) errors.push(`${at}.error must be null when ok=true (provider success)`);
      if (m.error_class !== null && m.error_class !== undefined) errors.push(`${at}.error_class must be null when ok=true`);
      if (m.exclusion_reason !== null && m.exclusion_reason !== undefined) errors.push(`${at}.exclusion_reason must be null when ok=true`);
      // Exactly ONE accepted success, and it must be the LAST entry: a
      // relabelled earlier success or a success followed by a later failure
      // can never pass.
      if (successEntries.length !== 1) {
        errors.push(`${at}.ok=true requires EXACTLY ONE ok=true attempt_log entry (got ${successEntries.length})`);
      } else {
        const last = m.attempt_log[m.attempt_log.length - 1];
        if (last?.ok !== true) {
          errors.push(`${at}.ok=true requires the ok=true entry to be the LAST attempt_log entry (a later failure invalidates the accepted success)`);
        }
        const success = successEntries[0];
        if (typeof success.accepted_output_hash !== "string") {
          errors.push(`${at}.attempt_log ok=true entry must carry a 64-hex accepted_output_hash`);
        } else if (typeof m.raw_accepted_output === "string") {
          const recomputed = sha256Hex(m.raw_accepted_output);
          if (success.accepted_output_hash !== recomputed) {
            errors.push(`${at}.attempt_log ok=true accepted_output_hash ${JSON.stringify(success.accepted_output_hash)} != sha256(raw accepted output) ${recomputed} (the success hash must be recomputed from the raw accepted output)`);
          }
        }
      }
      // All prior entries must be failures binding a null hash.
      for (let j = 0; j < m.attempt_log.length - 1; j++) {
        const e = m.attempt_log[j];
        if (e?.ok === true) {
          errors.push(`${at}.attempt_log[${j}] must be ok=false (only the LAST entry may be the accepted success)`);
        } else if (e?.ok === false && e.accepted_output_hash !== null) {
          errors.push(`${at}.attempt_log[${j}] ok=false entry must bind accepted_output_hash null`);
        }
      }
    } else {
      if (m.raw_accepted_output !== null && m.raw_accepted_output !== undefined) {
        errors.push(`${at}.raw_accepted_output must be null when ok=false (no raw accepted output)`);
      }
      if (typeof m.error !== "string" || !m.error.trim()) {
        errors.push(`${at}.error must be a non-empty string when ok=false`);
      }
      if (!["content", "transport", "infrastructure_or_generation_failure"].includes(m.error_class)) {
        errors.push(`${at}.error_class must be content|transport|infrastructure_or_generation_failure when ok=false, got ${JSON.stringify(m.error_class)}`);
      }
      if (typeof m.exclusion_reason !== "string" || !m.exclusion_reason.trim()) {
        errors.push(`${at}.exclusion_reason must be a non-empty string when ok=false`);
      }
      // A failed slot must never claim an accepted success.
      if (successEntries.length > 0) {
        errors.push(`${at}.ok=false must not carry any ok=true attempt_log entry (a failed slot never claims an accepted success)`);
      }
      if (m.attempt_log.length > 0) {
        const last = m.attempt_log[m.attempt_log.length - 1];
        if (m.error !== last?.error) {
          errors.push(`${at}.error must equal the LAST attempt_log entry's error (${JSON.stringify(m.error)} != ${JSON.stringify(last?.error)})`);
        }
        if (m.error_class !== last?.error_class) {
          errors.push(`${at}.error_class must equal the LAST attempt_log entry's error_class (${JSON.stringify(m.error_class)} != ${JSON.stringify(last?.error_class)})`);
        }
        const expectedExclusion = last?.error_class === "infrastructure_or_generation_failure"
          ? "infrastructure_or_generation_failure"
          : "replay_call_failed";
        if (m.exclusion_reason !== expectedExclusion) {
          errors.push(`${at}.exclusion_reason ${JSON.stringify(m.exclusion_reason)} != runReplayAnswer derivation ${JSON.stringify(expectedExclusion)} (infrastructure_or_generation_failure -> same name, else replay_call_failed)`);
        }
      } else {
        // Empty ledger: legal pre-request failure only — strictly limited
        // error_class/exclusion_reason combos, usage/cost/source null.
        if (m.error_class !== "infrastructure_or_generation_failure") {
          errors.push(`${at}.empty attempt_log requires error_class=infrastructure_or_generation_failure (pre-request failure), got ${JSON.stringify(m.error_class)}`);
        }
        if (!["replay_model_not_found", "thinking_level_unsupported", "replay_call_failed"].includes(m.exclusion_reason)) {
          errors.push(`${at}.empty attempt_log requires exclusion_reason in {replay_model_not_found, thinking_level_unsupported, replay_call_failed} (pre-request failure), got ${JSON.stringify(m.exclusion_reason)}`);
        }
      }
    }
    if (m.attempts !== m.attempt_log.length) {
      errors.push(`${at}.attempts ${JSON.stringify(m.attempts)} != attempt_log.length ${m.attempt_log.length}`);
    }
    if (m.attempt_log.length > 0) {
      const summary = summarizeCosts(m.attempt_log);
      if (m.cost !== summary.cost) {
        errors.push(`${at}.cost ${JSON.stringify(m.cost)} != ledger summary ${JSON.stringify(summary.cost)}`);
      }
      if (m.cost_source !== summary.cost_source) {
        errors.push(`${at}.cost_source ${JSON.stringify(m.cost_source)} != ledger summary ${JSON.stringify(summary.cost_source)}`);
      }
      const last = m.attempt_log[m.attempt_log.length - 1];
      if (JSON.stringify(m.usage ?? null) !== JSON.stringify(last?.usage ?? null)) {
        errors.push(`${at}.usage must equal the last attempt_log entry's usage (usage/cost closure)`);
      }
    } else {
      if (m.attempts !== 0) errors.push(`${at}.attempts must be 0 for an empty attempt_log`);
      if (m.cost !== null) errors.push(`${at}.cost must be null for an empty attempt_log`);
      if (m.cost_source !== null) errors.push(`${at}.cost_source must be null for an empty attempt_log`);
      if (m.usage !== null && m.usage !== undefined) errors.push(`${at}.usage must be null for an empty attempt_log`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Contextual checkpoint validation: proves cp.episode / cp.sidecar /
 * cp.exclusion are EXACTLY the product of the real producer
 * (buildReplayEpisode) over the checkpoint's private replay material and the
 * REAL source episode / meta / blind key / corpus / current options.
 *
 * Inputs: the real sourceEpisode, sourceMeta, blindKey, corpusModelNames,
 * current options, and the expected contentHash / models / protocolHash /
 * selectionHash. The validator:
 *  1. strictly checks the top-level identity/config fields against the
 *     expected context (ledger/schema version, source id + content hash +
 *     thinking, replay thinking, selection/protocol hash, experiment mode,
 *     history exclusion, replay models) AND the context itself: the
 *     expected contentHash must be the REAL source episode's content hash,
 *     the source meta must be the meta OF the source episode, models must
 *     equal options.models exactly and be unique, corpusModelNames must be
 *     a string array, and the checkpoint must carry EXACTLY the producer's
 *     top-level key set with a canonical UTC ISO built_at
 *     (new Date().toISOString() form);
 *  2. REQUIRES the private replay material (old material-less checkpoints
 *     are rejected) and validates it under the strict closure contract
 *     (one entry per model in exact order, exact key set, thinking equal to
 *     the current resolveReplayThinking, valid ledgers, exactly-one-last
 *     success with the hash recomputed from the raw accepted output,
 *     checkpoint-wide unique request_ids);
 *  3. re-runs buildReplayEpisode over the material (mapped back via
 *     materialToReplayResults) and exact deep-compares cp.episode /
 *     cp.sidecar / cp.exclusion — a body/sidecar sync tamper that does not
 *     touch the material can never pass, because the rebuild reproduces the
 *     original surfaces from the raw outputs.
 *
 * This is a structural internal binding, NOT a provider attestation: a fully
 * consistent rewrite of material + body + sidecar + hashes is outside its
 * scope (no provider signature is forged or claimed).
 */
export function checkpointValid(cp, {
  sourceEpisode,
  sourceMeta,
  blindKey,
  corpusModelNames,
  options,
  contentHash,
  models,
  protocolHash,
  selectionHash = null,
}) {
  if (!cp || !asRecord(cp)) return false;
  // Ledger-format binding: only checkpoints written under the CURRENT
  // ATTEMPT_LEDGER_VERSION are resumable — old checkpoints (no request_id
  // identity in their attempt logs) must never mix into a new run.
  if (cp.ledger_version !== ATTEMPT_LEDGER_VERSION) return false;
  if (cp.schema_version !== REPLAY_SCHEMA_VERSION) return false;
  if (!sourceEpisode || !asRecord(sourceEpisode)) return false;
  if (!sourceMeta || !asRecord(sourceMeta)) return false;
  if (typeof blindKey !== "string" || !blindKey) return false;
  if (!options || !asRecord(options)) return false;
  // Context self-binding: the expected contentHash must be the REAL source
  // episode's content hash — a caller-supplied hash that does not match the
  // source is a sync forgery (contentHash + source swapped together).
  if (contentHash !== episodeContentHash(sourceEpisode)) return false;
  // The source meta must be the meta OF the source episode — a mismatched
  // meta record can never rebuild the sidecar.
  if (sourceMeta.episode_id !== sourceEpisode.episode_id) return false;
  // models must be exactly the current options.models and unique — a
  // duplicate or reordered model list can never rebuild the body.
  if (!Array.isArray(models) || models.length === 0) return false;
  if (new Set(models).size !== models.length) return false;
  if (JSON.stringify(models) !== JSON.stringify(options.models ?? null)) return false;
  // corpusModelNames must be a string array (the redactor/identity scan
  // depends on it).
  if (!Array.isArray(corpusModelNames) || !corpusModelNames.every((n) => typeof n === "string")) return false;
  // Strict top-level key set: the checkpoint is a closed serialization
  // contract — exactly the fields the producer writes, no more, no less.
  const topKeys = Object.keys(cp).sort();
  const expectedTopKeys = [...REPLAY_CHECKPOINT_TOP_KEYS].sort();
  if (JSON.stringify(topKeys) !== JSON.stringify(expectedTopKeys)) return false;
  // built_at must be a canonical UTC ISO timestamp (new Date().toISOString() form).
  if (!isCanonicalIsoTimestamp(cp.built_at)) return false;
  // Top-level identity/config binding: the checkpoint must be exactly the
  // product of THIS source episode / blind key / protocol / options.
  if (cp.source_episode_id !== sourceEpisode.episode_id) return false;
  if (cp.source_content_hash !== contentHash) return false;
  if (cp.source_thinking !== (sourceEpisode.thinking_level ?? null)) return false;
  const thinking = resolveReplayThinking(options, sourceEpisode);
  if (cp.replay_thinking !== thinking) return false;
  if (cp.selection_hash !== selectionHash) return false;
  if (cp.protocol_hash !== protocolHash) return false;
  if (cp.experiment_mode !== (options.experimentMode ?? null)) return false;
  if (cp.history_excluded !== (options.historyExcluded === true)) return false;
  if (JSON.stringify(cp.replay_models ?? null) !== JSON.stringify(models)) return false;
  // Private replay material: REQUIRED — old material-less checkpoints are
  // rejected. One entry per model, order strictly matching models, exact
  // key set, thinking equal to the current resolveReplayThinking, ledgers
  // valid, success hashes recomputed from the raw accepted output, and
  // request_ids unique across the whole checkpoint.
  const seenIds = new Set();
  const materialCheck = validateReplayMaterial(cp.replay_material, { models, seenIds, expectedThinking: thinking, label: "replay_material" });
  if (!materialCheck.ok) return false;
  // Contextual rebuild: re-run the REAL producer over the material (mapped
  // back to the replay-result shape) and exact deep-compare the public
  // surfaces.
  const rebuilt = buildReplayEpisode({
    sourceEpisode,
    sourceMeta,
    blindKey,
    replayResults: materialToReplayResults(cp.replay_material),
    corpusModelNames,
    options,
    selectionHash,
    protocolHash,
    experimentMode: options.experimentMode ?? null,
    historyExcluded: options.historyExcluded === true,
    requirePaired: options.requirePaired === true,
    thinkingOverride: thinking,
  });
  if (stableStringify(rebuilt.episode) !== stableStringify(cp.episode)) return false;
  if (stableStringify(rebuilt.sidecar) !== stableStringify(cp.sidecar)) return false;
  if (stableStringify(rebuilt.exclusion) !== stableStringify(cp.exclusion)) return false;
  return true;
}

/**
 * Cumulative checkpoint scan: admit ONLY checkpoints that pass the SAME
 * contextual checkpointValid as the resume path, and FAIL CLOSED (throw) on
 * any .json that is malformed, has an unknown source, is an invalid
 * checkpoint, or has a filename that does not equal the replay episode id
 * derived from blindKey/source id/models. Also rejects duplicate
 * source_episode_id, duplicate replay episode_id and cross-checkpoint
 * duplicate request_id in the cumulative directory. Non-.json files are
 * ignored. Exported for offline tests (real temp checkpoint scan).
 */
export function scanValidCheckpoints(checkpointsDir, {
  selectedBySourceId,
  expectedProtocolBySource,
  models,
  selectionHash = null,
  blindKey,
  corpusModelNames,
  options,
  checkpointByName,
}) {
  const allCheckpoints = [];
  if (checkpointByName === undefined && !fs.existsSync(checkpointsDir)) return allCheckpoints;
  const seenSourceIds = new Set();
  const seenReplayIds = new Set();
  const seenRequestIds = new Set();
  const checkpointNames = checkpointByName === undefined
    ? fs.readdirSync(checkpointsDir).filter((name) => name.endsWith(".json"))
    : [...checkpointByName.keys()];
  for (const name of checkpointNames) {
    if (!name.endsWith(".json") || name.includes("/") || name.includes("\\")) {
      throw new Error(`scanValidCheckpoints: unsafe checkpoint name ${JSON.stringify(name)}`);
    }
    let cp;
    if (checkpointByName !== undefined) {
      cp = checkpointByName.get(name);
    } else {
      try {
        cp = JSON.parse(fs.readFileSync(path.join(checkpointsDir, name), "utf8"));
      } catch (err) {
        throw new Error(`scanValidCheckpoints: malformed checkpoint JSON ${name}: ${err.message}`);
      }
    }
    if (!cp || !asRecord(cp)) {
      throw new Error(`scanValidCheckpoints: checkpoint ${name} is not a JSON object`);
    }
    const sourceId = cp.source_episode_id;
    const item = selectedBySourceId.get(sourceId);
    if (!item) {
      throw new Error(`scanValidCheckpoints: checkpoint ${name} has unknown source_episode_id ${JSON.stringify(sourceId)} (not in the current selection)`);
    }
    if (seenSourceIds.has(sourceId)) {
      throw new Error(`scanValidCheckpoints: duplicate source_episode_id ${JSON.stringify(sourceId)} (${name})`);
    }
    seenSourceIds.add(sourceId);
    // Filename binding: the checkpoint file name must be EXACTLY the replay
    // episode id derived from blindKey/source id/models.
    const replayEpisodeId = buildReplayEpisodeId(blindKey, sourceId, models);
    if (name !== `${replayEpisodeId}.json`) {
      throw new Error(`scanValidCheckpoints: checkpoint ${name} filename does not match the derived replay episode id ${replayEpisodeId}.json`);
    }
    const replayId = cp.sidecar?.episode_id;
    if (typeof replayId === "string") {
      if (seenReplayIds.has(replayId)) {
        throw new Error(`scanValidCheckpoints: duplicate replay episode_id ${JSON.stringify(replayId)} (${name})`);
      }
      seenReplayIds.add(replayId);
    }
    const expectedProtocol = expectedProtocolBySource.get(sourceId);
    if (!checkpointValid(cp, {
      sourceEpisode: item.sourceEpisode,
      sourceMeta: item.sourceMeta,
      blindKey,
      corpusModelNames,
      options,
      contentHash: item.source_content_hash,
      models,
      protocolHash: expectedProtocol,
      selectionHash,
    })) {
      throw new Error(`scanValidCheckpoints: checkpoint ${name} failed contextual validation (invalid checkpoint)`);
    }
    // Cross-checkpoint request_id uniqueness: the per-checkpoint ledger
    // validation only proves uniqueness WITHIN one checkpoint; the
    // cumulative directory must never contain the same request_id twice.
    for (const m of cp.replay_material ?? []) {
      for (const entry of m?.attempt_log ?? []) {
        if (typeof entry?.request_id !== "string") continue;
        if (seenRequestIds.has(entry.request_id)) {
          throw new Error(`scanValidCheckpoints: duplicate request_id ${JSON.stringify(entry.request_id)} across checkpoints (${name})`);
        }
        seenRequestIds.add(entry.request_id);
      }
    }
    allCheckpoints.push(cp);
  }
  return allCheckpoints;
}

export function buildEpisodeProtocolHash(item, options, selectionInfo) {
  const episode = item.episode;
  const contentHash = item.source_content_hash ?? episodeContentHash(episode);
  const thinking = resolveReplayThinking(options, episode);
  return buildReplayProtocolHash({
    selectionHash: selectionInfo?.selectionHash ?? "legacy",
    sourceContentHash: contentHash,
    models: options.models,
    thinking,
    systemPrompt: REPLAY_SYSTEM_PROMPT,
    userProtocol: REPLAY_USER_PROTOCOL,
    retryHint: REPLAY_RETRY_HINT,
    maxOutputBytes: options.maxOutputBytes,
    maxEpisodeBytes: options.maxEpisodeBytes,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    experimentMode: options.experimentMode ?? null,
    historyExcluded: options.historyExcluded === true,
  });
}

async function processEpisode(invoker, item, blind, corpusModelNames, options, selectionInfo) {
  const episode = item.episode;
  const meta = item.meta;
  const contentHash = item.source_content_hash ?? episodeContentHash(episode);
  const thinking = resolveReplayThinking(options, episode);
  const protocolHash = buildEpisodeProtocolHash(item, options, selectionInfo);
  const replayEpisodeId = buildReplayEpisodeId(blind.key, episode.episode_id, options.models);
  const checkpointFile = path.join(options.output, "checkpoints", `${replayEpisodeId}.json`);
  // The SAME contextual validator the cumulative scan uses: real source
  // episode/meta, blind key, corpus model names, current options and the
  // expected contentHash/models/protocolHash/selectionHash.
  const checkpointContext = {
    sourceEpisode: episode,
    sourceMeta: meta,
    blindKey: blind.key,
    corpusModelNames,
    options,
    contentHash,
    models: options.models,
    protocolHash,
    selectionHash: selectionInfo?.selectionHash ?? null,
  };

  if (options.resume && fs.existsSync(checkpointFile)) {
    let cp = null;
    try {
      cp = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    } catch {
      cp = null;
    }
    if (checkpointValid(cp, checkpointContext)) {
      return { checkpoint: cp, skipped: true };
    }
  }

  const replayResults = await Promise.all(options.models.map(async (modelRef) => {
    const model = resolveModelFromInvoker(invoker, modelRef);
    const r = await runReplayAnswer(invoker, modelRef, episode.prompt, {
      thinking,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputBytes,
      model,
    });
    return {
      ...r,
      model: modelRef,
      calledAt: new Date().toISOString(),
      thinking,
    };
  }));

  const built = buildReplayEpisode({
    sourceEpisode: episode,
    sourceMeta: meta,
    blindKey: blind.key,
    replayResults,
    corpusModelNames,
    options,
    selectionHash: selectionInfo?.selectionHash ?? null,
    protocolHash,
    experimentMode: options.experimentMode ?? null,
    historyExcluded: options.historyExcluded === true,
    requirePaired: options.requirePaired === true,
    thinkingOverride: thinking,
  });

  const cp = {
    ledger_version: ATTEMPT_LEDGER_VERSION,
    schema_version: REPLAY_SCHEMA_VERSION,
    source_episode_id: episode.episode_id,
    source_content_hash: contentHash,
    source_thinking: episode.thinking_level ?? null,
    replay_thinking: thinking,
    selection_hash: selectionInfo?.selectionHash ?? null,
    protocol_hash: protocolHash,
    experiment_mode: options.experimentMode ?? null,
    history_excluded: options.historyExcluded === true,
    replay_models: options.models,
    // Private replay material: the minimal raw-output snapshot needed to
    // rebuild the public surfaces. Lives ONLY inside the checkpoint — never
    // published to episodes.jsonl / episodes.meta.jsonl / stats.
    replay_material: buildReplayMaterial(replayResults),
    episode: built.episode,
    sidecar: built.sidecar,
    exclusion: built.exclusion,
    built_at: new Date().toISOString(),
  };
  // Write-time self-assert: this process must never persist a fake v2
  // checkpoint — the body about to be written must pass the SAME contextual
  // checkpointValid contract the resume path and the cumulative scan use.
  if (!checkpointValid(cp, checkpointContext)) {
    throw new Error(`t0-replay-build: internal checkpoint self-validation failed for ${replayEpisodeId} (refusing to write a fake v2 checkpoint)`);
  }
  writeTextFileAtomic(checkpointFile, `${JSON.stringify(cp, null, 2)}\n`);
  return { checkpoint: cp, skipped: false, exclusion: built.exclusion };
}

export function deriveReplayDataset({
  allCheckpoints,
  selectionExcluded,
  options,
  blind,
  sourceEpisodes,
  corpusModelNames,
  selectionInfo,
}) {
  const checkpoints = [...allCheckpoints].sort((a, b) => (
    a.source_episode_id < b.source_episode_id ? -1 : a.source_episode_id > b.source_episode_id ? 1 : 0
  ));
  const episodes = checkpoints.map((c) => c.episode).filter(Boolean);
  const sidecar = checkpoints.map((c) => c.sidecar);
  const exclusions = canonicalizeExclusions([
    ...selectionExcluded,
    ...checkpoints.filter((c) => c.exclusion).map((c) => c.exclusion),
  ]);
  const totalBodyBytes = episodes.reduce((sum, e) => sum + utf8ByteLength(JSON.stringify(e)) + 1, 0);
  if (Number.isFinite(options.maxTotalBytes) && totalBodyBytes > options.maxTotalBytes) {
    throw new Error(
      `t0-replay-build: total episodes.jsonl size ${totalBodyBytes} bytes exceeds `
      + `--max-total-bytes ${options.maxTotalBytes} (fail-closed)`,
    );
  }
  const stats = buildStats({
    options,
    blind,
    sourceEpisodes,
    selectionExcluded,
    checkpoints,
    exclusions,
    corpusModelNames,
    selectionInfo,
  });
  const { snapshot, payloads } = preparePublicPayloads({ episodes, sidecar, exclusions, stats });
  return {
    episodes: snapshot.episodes,
    sidecar: snapshot.sidecar,
    exclusions: snapshot.exclusions,
    stats: snapshot.stats,
    payloads,
    checkpoints,
  };
}

export async function buildReplay(options) {
  if (options.verificationOnly !== true) {
    const publicationState = await planReplayPublicationState(options);
    if (publicationState.recovered) return publicationState.recovered;
  }
  // Fair path requires --selection. Fail closed BEFORE touching source paths
  // so a missing --selection is never masked by episodes.jsonl errors.
  // Legacy select only with explicit flag (fixture tooling) — never default.
  let selectionInfo = null;
  let requestedItems = [];
  let selectionExcluded = [];
  // FULL resolved selection (never the requested subset): the scan context
  // and the public selection exclusions are always derived from the complete
  // manifest, so a --episode subset run can never reject other legal
  // manifest checkpoints or drop manifest exclusions.
  let fullResolvedSelected = [];

  if (options.currentOnly && options.allowLegacySelect) {
    throw new Error(
      "t0-replay-build: --current-only cannot combine with --allow-legacy-select "
      + "(legacy selector is not a fair/current-only bypass)",
    );
  }
  if (options.currentOnly && !options.selectionPath) {
    throw new Error(
      "t0-replay-build: --current-only requires --selection <manifest.json> "
      + "with full selected[] records",
    );
  }
  if (!options.selectionPath && !options.allowLegacySelect) {
    throw new Error(
      "t0-replay-build: --selection <manifest.json> is required. "
      + "Fair prompt-only replay must consume t0-replay-select output; "
      + "the legacy internal selector is not a fair bypass "
      + "(fixture tests may pass --allow-legacy-select).",
    );
  }

  // Thinking policy: fair forbids CLI override; current-only forces high.
  if (options.selectionPath && !options.currentOnly && options.thinkingCli) {
    throw new Error(
      "t0-replay-build: fair selection path forbids --thinking override "
      + "(uses each source episode's thinking_level; use --current-only for unified high)",
    );
  }
  if (options.currentOnly) {
    if (options.thinkingCli && options.thinkingCli !== CURRENT_ONLY_THINKING) {
      throw new Error(
        `t0-replay-build: --current-only requires thinking=${CURRENT_ONLY_THINKING} `
        + `(got ${JSON.stringify(options.thinkingCli)})`,
      );
    }
    options.thinkingOverride = CURRENT_ONLY_THINKING;
    options.experimentMode = CURRENT_ONLY_EXPERIMENT_MODE;
    options.historyExcluded = true;
    options.requirePaired = true;
    if (!options.models || options.models.length === 0) {
      options.models = [...CURRENT_ONLY_MODELS];
    }
    // Paired body requires every model; minModels must cover all candidates.
    options.minModels = Math.max(options.minModels ?? 0, options.models.length);
  } else if (options.allowLegacySelect && options.thinkingCli) {
    options.thinkingOverride = options.thinkingCli;
  } else {
    options.thinkingOverride = undefined;
  }

  const sourceEpisodes = options.sourceEpisodesOverride ?? loadEpisodes(options.episodesPath, { strict: true });
  const sourceMeta = options.sourceMetaOverride ?? loadMeta(options.metaPath, { strict: true });
  const metaById = new Map(sourceMeta.map((m) => [m.episode_id, m]));
  // FULL producer-inventory closure (episodes + meta + exclusions + stats)
  // BEFORE any blind-key write / invoker / provider work: the four-file
  // dataset is one atomic producer unit. Orphan meta records are only legal
  // as the below-min terminal set recorded in exclusions + stats — an
  // arbitrary orphan fails closed here. The facts carry the legal terminal
  // set for reporting.
  const sourceExclusions = options.sourceExclusionsOverride ?? loadExclusionRecords(options.exclusionsPath);
  const sourceStats = options.sourceStatsOverride ?? loadStats(options.statsPath);
  const facts = assertProducerInventory({
    episodes: sourceEpisodes,
    meta: metaById,
    exclusions: sourceExclusions,
    stats: sourceStats,
    label: "t0-replay-build",
  });
  if (!options.quiet && facts.orphan_meta.length > 0) {
    console.error(`t0-replay-build: ${facts.orphan_meta.length} legal terminal meta record(s) (below-min, no episode body): ${JSON.stringify(facts.orphan_meta)}`);
  }

  if (options.selectionPath) {
    // selectionInfoOverride may ONLY supply the manifest BODY (the `selection`
    // object — the committed-bundle loader verifies against in-memory files,
    // no logical files exist on disk). EVERY derived field (episodeIds /
    // selectedById / downstreamJudges / hash) is ALWAYS rebuilt through
    // loadAndValidateSelection, so a tampered override can never smuggle
    // non-replayable hard-pass episodes into the trusted selection view or
    // the scheduled replay set.
    const fullSelectionInfo = loadAndValidateSelection(options.selectionPath, {
      selectionObject: options.selectionInfoOverride?.selection,
    });
    // Optional --episode: after the loader's manifest validation, it only
    // narrows THIS execution — at least 2 ids, unique, and a subset of the
    // selection. Rejected before the provenance scan / blind-key write /
    // invoker (all provider-adjacent work). The full-manifest provenance
    // below always validates the manifest as read from disk, so the subset
    // can never weaken it. The subset NEVER rewrites the full selection
    // context: it only selects which episodes THIS run schedules / calls the
    // invoker for.
    let requestedIds = null;
    if (options.episodeIds?.length) {
      if (options.episodeIds.length < 2) {
        throw new Error(`t0-replay-build: --episode requires at least 2 ids (got ${options.episodeIds.length})`);
      }
      if (new Set(options.episodeIds).size !== options.episodeIds.length) {
        throw new Error(`t0-replay-build: --episode ids must be unique (duplicates rejected): ${JSON.stringify(options.episodeIds)}`);
      }
      const allow = new Set(fullSelectionInfo.episodeIds);
      for (const id of options.episodeIds) {
        if (!allow.has(id)) {
          throw new Error(`t0-replay-build: --episode ${id} is not in the selection manifest`);
        }
      }
      requestedIds = options.episodeIds;
    }
    // ── FULL fair-manifest provenance (BEFORE any blind-key write and
    // before any invoker/provider request): the selection manifest must be
    // the COMPLETE product of the real classifier selector over the real
    // corpus + its own checkpoints-fair/checkpoints (current
    // classifierProtocolHash, non-stale ledger checkpoints, full producer
    // reconstruction). The checkpoint dir is fixed to the
    // selection-adjacent `checkpoints-fair/checkpoints`. Loaded via a safe
    // DYNAMIC import — t0-replay-fair-common statically imports this
    // module, so a top-level static import would be a cycle; by the time
    // this async body runs, this module is fully initialized, so the
    // dynamic import is safe. A failure reports the first 10 errors and
    // creates NO invoker/output.
    const fair = await import("./t0-replay-fair-common.mjs");
    const fairCheckpointDir = path.join(path.dirname(options.selectionPath), "checkpoints-fair", "checkpoints");
    let fairCheckpointById = options.fairCheckpointById;
    let provenance;
    if (fairCheckpointById === undefined) {
      try {
        fairCheckpointById = loadExactJsonMap(
          fairCheckpointDir,
          fullSelectionInfo.selection.classifications.map((c) => c.episode_id),
          "fair classification checkpoints",
        );
      } catch (err) {
        provenance = { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
      }
    }
    provenance ??= fair.validateFairManifestProvenance({
      manifest: fullSelectionInfo.selection,
      episodes: sourceEpisodes,
      metaById,
      exclusions: sourceExclusions,
      stats: sourceStats,
      checkpointById: fairCheckpointById,
      // The selection's own downstream-judge set — provenance must re-run
      // the hard gates with the SAME set the selector used (a legal
      // non-default superset must never silently fall back to the fixed
      // set). validateFairManifestProvenance also verifies the manifest's
      // downstream_judges against this value.
      downstreamJudges: fullSelectionInfo.downstreamJudges,
    });
    fullSelectionInfo.fairCheckpointById = fairCheckpointById;
    if (!provenance.ok) {
      throw new Error(
        `t0-replay-build: selection manifest provenance validation FAILED (${provenance.errors.length}):\n  - ${provenance.errors.slice(0, 10).join("\n  - ")}`,
      );
    }
    // FULL resolve over the complete manifest — never the requested subset.
    // The scan context (fullSelectedBySourceId / full expected protocol) and
    // the public selection exclusions are derived from this full resolve, so
    // a --episode subset run accepts every legal manifest checkpoint and
    // reports the manifest's full exclusion set.
    const fullResolved = resolveSelectedSourceEpisodes(sourceEpisodes, metaById, fullSelectionInfo);
    fullResolvedSelected = fullResolved.selected;
    selectionExcluded = fullResolved.excluded;
    requestedItems = requestedIds
      ? fullResolved.selected.filter((it) => requestedIds.includes(it.episode.episode_id))
      : fullResolved.selected;
    selectionInfo = fullSelectionInfo;
  } else {
    // allowLegacySelect === true (fixture tooling only)
    const { selected, excluded } = selectReplayEpisodes(sourceEpisodes, metaById, {
      episodeIds: options.episodeIds,
      limit: options.limit,
    });
    requestedItems = selected.map((episode) => ({
      episode,
      meta: metaById.get(episode.episode_id),
      source_content_hash: episodeContentHash(episode),
      thinking: episode.thinking_level ?? null,
    }));
    fullResolvedSelected = requestedItems;
    selectionExcluded = excluded;
  }

  // FULL producer model universe (contract E): the surviving meta slots PLUS
  // the producer-inventory-verified stats.models.by_name keys and
  // stats.models.absent_from_body (sorted, deduped). A model that only
  // survives in stats (its episodes were too-large / orphaned) is still a
  // KNOWN token — without it a mention like "kimi-k2.7-code" could be
  // mis-killed as a bare "K2" ambiguity. Structural anomalies are already
  // fail-closed by assertProducerInventory above.
  const corpusModelNames = resolveCorpusModelNames(sourceMeta, sourceStats, options.models);

  // The blind key is resolved IN MEMORY here (pure: explicit/seed derivation
  // or an existing-file READ — never a write) because the source oracle
  // preflight below must transform the source body texts with the same
  // episode-local redactor the build will use. PERSISTENCE is unchanged and
  // still happens strictly AFTER the checkpoint pre-scan and BEFORE the
  // invoker; the SAME blind object drives the preflight, the pre-scan, the
  // checkpoints, the post-scan and the persisted file.
  const blind = options.blindOverride ?? resolveBlindKey(options.output, options);

  // ── SOURCE PREFLIGHT (pure, provider-free, BEFORE any blind-key write) ──
  // Fail-closed over the FULL resolved selected source universe (including
  // episodes outside this run's --episode subset): the prompt is ALWAYS
  // scanned (every mode, current-only included); historical raw outputs are
  // scanned only when they would actually enter the body (fair default:
  // model-carrying, non-empty — the shared sourceBodyTexts definition). Any
  // bare ambiguous identity token / residual id (K2/M2/M3/K3/v4-pro/v4pro/
  // mN) rejects the whole source episode — never guessed, never mechanically
  // rewritten. After the ambiguity scan, the TRANSFORMED source body texts
  // (the same episode-local redactor + source-episode-id redaction the build
  // will apply) are validated against the independent oracle BEFORE any
  // provider work — a source that cannot be de-identified must never reach a
  // provider. Rejections are a pure function of (manifest, corpus, blind,
  // options) the five public files can carry deterministically.
  const sourceRejected = [];
  // Real oracle assertion messages for the quiet=false console ONLY — never
  // a public-file semantic (the public exclusions carry the fixed
  // REPLAY_SOURCE_ORACLE_REJECTION_ERROR detail, so an oracle-text edit can
  // never change the five public files).
  const sourceOracleDetails = new Map();
  for (const item of fullResolvedSelected) {
    const tokens = detectSourceAmbiguity(item.episode, item.meta, corpusModelNames, {
      historyExcluded: options.historyExcluded === true,
    });
    if (tokens.length > 0) {
      sourceRejected.push({
        episode_id: item.episode.episode_id,
        reason: "source_ambiguous_identity_token",
        tokens,
      });
      continue;
    }
    // Oracle final-content check of the transformed source body texts (the
    // exact transform buildReplayEpisode applies — deterministic for the
    // same blind/corpus/options).
    try {
      for (const text of transformedSourceBodyTexts(item, blind, corpusModelNames, options)) {
        assertNoOracleLeak(text, `source ${item.episode.episode_id} body text (preflight transform)`);
      }
    } catch (err) {
      sourceRejected.push({
        episode_id: item.episode.episode_id,
        reason: "source_oracle_content_rejected",
        detail: REPLAY_SOURCE_ORACLE_REJECTION_ERROR,
      });
      sourceOracleDetails.set(item.episode.episode_id, err instanceof Error ? err.message : String(err));
    }
  }
  if (sourceRejected.length > 0) {
    const rejectedIds = new Set(sourceRejected.map((r) => r.episode_id));
    selectionExcluded = [...selectionExcluded, ...sourceRejected];
    requestedItems = requestedItems.filter((it) => !rejectedIds.has(it.episode.episode_id));
    fullResolvedSelected = fullResolvedSelected.filter((it) => !rejectedIds.has(it.episode.episode_id));
    if (!options.quiet) {
      for (const r of sourceRejected) {
        const oracleDetail = sourceOracleDetails.get(r.episode_id);
        console.error(
          `t0-replay-build: source preflight rejects ${r.episode_id} (${r.reason}`
          + `${r.tokens ? `: ${r.tokens.join(", ")}` : ""}${oracleDetail ? ` — ${oracleDetail}` : ""})`,
        );
      }
    }
  }

  // The real selection path must keep at least 2 replayable episodes after
  // source preflight — the whole round fails closed BEFORE the provider when
  // the surviving requested set drops below 2. Legacy fixture tooling keeps
  // its minimal logic (an empty requested set fails closed).
  if (options.selectionPath && requestedItems.length < 2) {
    throw new Error(
      `t0-replay-build: source preflight left only ${requestedItems.length} requested episode(s) — `
      + `a fair prompt-only replay round requires at least 2 (${sourceRejected.length} source rejection(s) recorded)`,
    );
  }
  if (requestedItems.length === 0) {
    throw new Error(
      `t0-replay-build: no replayable episodes resolved `
      + `(available=${sourceEpisodes.length}, selection=${selectionInfo?.episodeIds?.length ?? "legacy"}, `
      + `excluded=${selectionExcluded.length})`,
    );
  }

  // ── Contextual scan context (pure, provider-free) ─────────────────────
  // The cumulative checkpoint dir is scanned with the SAME contextual
  // validator as the resume path (real source episode/meta, blind key,
  // corpus, options, expected contentHash/models/protocol/selection). The
  // maps are pure derivations of corpus + manifest + blind key + options —
  // they are built BEFORE any invoker/provider work so the strict scan can
  // run first. They cover the FULL resolved selection (never the requested
  // subset): the cumulative dir may legitimately hold checkpoints for ANY
  // manifest episode (from earlier subset runs), and the pre/post scan must
  // accept them — only manifest-external / stale-protocol / invalid
  // checkpoints fail closed.
  const checkpointsDir = path.join(options.output, "checkpoints");
  const fullSelectedBySourceId = new Map(fullResolvedSelected.map((it) => [it.episode.episode_id, {
    sourceEpisode: it.episode,
    sourceMeta: it.meta,
    source_content_hash: it.source_content_hash,
  }]));
  const fullExpectedProtocolBySource = new Map();
  for (const item of fullResolvedSelected) {
    fullExpectedProtocolBySource.set(
      item.episode.episode_id,
      buildEpisodeProtocolHash(item, options, selectionInfo),
    );
  }
  const selectionHash = selectionInfo?.selectionHash ?? null;
  const scanArgs = {
    selectedBySourceId: fullSelectedBySourceId,
    expectedProtocolBySource: fullExpectedProtocolBySource,
    models: options.models,
    selectionHash,
    blindKey: blind.key,
    corpusModelNames,
    options,
    checkpointByName: options.replayCheckpointByName,
  };
  // ── PRE-SCAN (BEFORE any invoker/provider request) ─────────────────────
  // Any malformed / unknown-source / invalid / wrong-filename / duplicate
  // checkpoint in the existing checkpoints dir fails closed HERE — zero
  // provider requests, zero makeJudgeInvoker — so a bad checkpoint is never
  // discovered only after paid requests. An empty / missing checkpoints dir
  // is legal (returns []). The pre-scan result is not reused: the resume
  // path re-validates per episode, and the post-scan re-validates the full
  // cumulative dir after the run.
  const verifiedPreScan = scanValidCheckpoints(checkpointsDir, scanArgs);
  if (options.verificationOnly === true) {
    const derived = deriveReplayDataset({
      allCheckpoints: verifiedPreScan,
      selectionExcluded,
      options,
      blind,
      sourceEpisodes,
      corpusModelNames,
      selectionInfo,
    });
    return {
      ...derived,
      run: {
        requested: 0,
        new_checkpoints: 0,
        reused_requested: 0,
        dataset_checkpoints: derived.checkpoints.length,
        dataset_episodes: derived.episodes.length,
      },
      verification_only: true,
    };
  }

  // Persist the blind key ONLY after the strict pre-scan proved the existing
  // checkpoints dir clean: a bad checkpoint fails closed with zero
  // invoker/provider work AND no blind-key.json created/modified. The SAME
  // resolved blind that drove the pre-scan (and will drive the post-scan) is
  // passed in — persistBlindKey never resolves/generates a key itself, so a
  // fresh no-seed first run can never split into two random keys. An
  // existing strict-valid blind-key.json is never rewritten (persistBlindKey
  // decides reuse by file existence + key equality, never by the parsed
  // `source` field), an explicit --blind-key/--seed that conflicts with the
  // persisted key fails closed instead of overwriting, and any existing file
  // failing the closed-shape preflight (extra/missing keys, non-canonical
  // case, illegal source) fails closed BEFORE the invoker/provider exists.
  const persistedBlind = persistBlindKey(options.output, blind);

  const invoker = options.invoker ?? await makeJudgeInvoker({ modelsJsonPath: options.modelsJsonPath });
  const queue = [...requestedItems];
  let newCheckpoints = 0;
  let reusedRequested = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency, Math.max(1, requestedItems.length)) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        const result = await processEpisode(invoker, item, persistedBlind, corpusModelNames, options, selectionInfo);
        if (result.skipped) {
          reusedRequested++;
          continue;
        }
        newCheckpoints++;
        if (!options.quiet && result.checkpoint) {
          const s = result.checkpoint.sidecar;
          const bodyN = result.checkpoint.episode?.slots?.length ?? 0;
          const think = result.checkpoint.replay_thinking ?? result.checkpoint.source_thinking;
          console.log(
            `  ${s.episode_id}: source=${s.source_episode_id} thinking=${think} `
            + `body_slots=${bodyN} exclusion=${result.exclusion?.reason ?? "none"}`,
          );
        }
      }
    },
  );
  await Promise.all(workers);

  // ── POST-SCAN (after the run) ──────────────────────────────────────────
  // Re-scan the cumulative dir with the SAME strict contextual scan: the
  // pre-scan proved the pre-existing dir clean before any provider work, and
  // this scan proves the FULL dir (including checkpoints written by this
  // run, each self-validated before write) is clean for the final summary.
  // It FAILS CLOSED on malformed / unknown-source / invalid /
  // wrong-filename checkpoints and on duplicate source ids, duplicate
  // replay ids and cross-checkpoint duplicate request_ids — nothing
  // silently skips.
  const allCheckpoints = scanValidCheckpoints(checkpointsDir, scanArgs);
  const derived = deriveReplayDataset({
    allCheckpoints,
    selectionExcluded,
    options,
    blind: persistedBlind,
    sourceEpisodes,
    corpusModelNames,
    selectionInfo,
  });
  const { episodes, sidecar, exclusions: dedupedExclusions, stats, payloads } = derived;
  let marker = null;
  if (selectionInfo) {
    const replayBuildContext = buildReplayBuildContext(options);
    invokePublicationFailpoint(options, "beforeBundlePublish");
    const generation = publishImmutableGeneration(options.output, {
      sourceEpisodes,
      sourceMeta,
      sourceExclusions,
      sourceStats,
      selectionInfo,
      fairCheckpointById: selectionInfo.fairCheckpointById,
      blind: persistedBlind,
      replayCheckpoints: derived.checkpoints,
      replayBuildContext,
      payloads,
    });
    invokePublicationFailpoint(options, "afterBundlePublish");
    marker = generation.marker;
    publishCommittedPayloads(options.output, marker, payloads, options);
  } else {
    writeOutputs(options.output, { episodes, sidecar, exclusions: dedupedExclusions, stats });
  }
  // Private run facts — never published to the five public files: the public
  // stats/README only carry counts recomputable from the cumulative
  // checkpoint set, so the same checkpoint set yields byte-identical files
  // regardless of this run's --episode subset / resume method.
  const run = {
    requested: requestedItems.length,
    new_checkpoints: newCheckpoints,
    reused_requested: reusedRequested,
    dataset_checkpoints: allCheckpoints.length,
    dataset_episodes: episodes.length,
  };
  return {
    episodes,
    sidecar,
    exclusions: dedupedExclusions,
    stats,
    run,
    ...(marker ? { marker, generationId: marker.generation_id } : {}),
  };
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  buildReplay(options).then(({ episodes, stats, run }) => {
    const calls = stats.replay.calls;
    console.log(
      `t0-replay-build: body_episodes=${episodes.length}, `
      + `requested=${run.requested}, new_checkpoints=${run.new_checkpoints}, reused_requested=${run.reused_requested}, `
      + `dataset_checkpoints=${run.dataset_checkpoints}, `
      + `models=${options.models.join(",")}, `
      + `thinking=${options.currentOnly ? CURRENT_ONLY_THINKING : "source_episode"}, `
      + `experiment_mode=${options.experimentMode ?? "fair"}, `
      + `history_excluded=${options.historyExcluded === true}, `
      + `replay calls=${calls.total} (ok=${calls.ok}, failed=${calls.failed}, attempts=${calls.attempts}), `
      + (calls.cost_complete
        ? `cost=$${Number(calls.known_cost).toFixed(4)} (${calls.cost_source ?? "n/a"})`
        : `cost=incomplete known=$${Number(calls.known_cost).toFixed(4)} unknown_attempts=${calls.unknown_attempts} (${calls.cost_source ?? "n/a"})`)
      + `, blind_key=${stats.blind_key.source}`,
    );
    if (!options.quiet) {
      for (const episode of episodes) {
        const models = episode.slots.map((s) => s.model_id).join(",");
        console.log(`  ${episode.episode_id} models=${models} slots=${episode.slots.length} thinking=${episode.thinking}`);
      }
    }
    console.log(`output: ${options.output}`);
  }).catch((err) => {
    console.error(`t0-replay-build failed: ${err.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
