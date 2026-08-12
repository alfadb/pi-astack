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
  loadEpisodes,
  makeJudgeInvoker,
  callJudge,
  attemptCost,
  sumAttemptCosts,
  aggregateCostSource,
  sleep,
  sha256Hex,
  asRecord,
  episodeContentHash,
  summarizeFailedOutput,
} from "./t0-eval-common.mjs";

import {
  EPISODE_SCHEMA_VERSION,
  BLIND_KEY_FILE,
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

export const REPLAY_SCHEMA_VERSION = 1;
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
export const REPLAY_REDACTOR_ID = "episode-local-v1";
export const ALLOWED_JOIN_CONFIDENCES = Object.freeze(["exact", "heuristic"]);

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
export const REPLAY_USER_PROTOCOL = "Answer the task prompt below. Produce your final answer directly.";

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

function loadMeta(metaPath) {
  if (!fs.existsSync(metaPath)) throw new Error(`meta sidecar not found: ${metaPath}`);
  const records = [];
  for (const line of fs.readFileSync(metaPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && typeof row.episode_id === "string") records.push(row);
    } catch {
      /* skip malformed lines */
    }
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

// ── selection manifest ────────────────────────────────────────────────────

/**
 * Hash of the fair selection identity that checkpoint protocol binds to.
 * Changes to selected ids / protocol / classifier / downstream judges invalidate.
 */
export function selectionManifestHash(selection) {
  return sha256Hex(stableStringify({
    kind: selection.kind,
    schema_version: selection.schema_version,
    protocol_hash: selection.protocol_hash,
    classifier_models: selection.classifier_models ?? selection.judge_models ?? [],
    downstream_judges: selection.downstream_judges ?? [],
    episode_ids: selection.episode_ids ?? (selection.selected ?? []).map((s) => s.episode_id),
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
} = {}) {
  if (!selectionPath) {
    throw new Error("t0-replay-build: --selection <manifest.json> is required (fair prompt-only path; no default sample)");
  }
  const resolved = path.resolve(selectionPath);
  if (!fs.existsSync(resolved)) throw new Error(`selection manifest not found: ${resolved}`);
  let selection;
  try {
    selection = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(`selection manifest is not valid JSON: ${resolved}: ${err.message}`);
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
  const selected = Array.isArray(selection.selected) ? selection.selected : [];
  if (selected.length === 0) {
    throw new Error(
      "selection must include full selected[] records "
      + "(episode_ids-only manifests are rejected; not a fair bypass)",
    );
  }
  const episodeIds = Array.isArray(selection.episode_ids)
    ? selection.episode_ids
    : selected.map((s) => s.episode_id);
  if (episodeIds.length === 0) throw new Error("selection has no episode_ids / selected entries");
  if (selected.length !== episodeIds.length) {
    throw new Error(`selection selected.length (${selected.length}) != episode_ids.length (${episodeIds.length})`);
  }
  for (const id of episodeIds) {
    if (typeof id !== "string" || !id.startsWith("ep-")) {
      throw new Error(`selection episode id invalid: ${JSON.stringify(id)}`);
    }
  }
  const byId = new Map(selected.map((s) => [s.episode_id, s]));
  for (const id of episodeIds) {
    const row = byId.get(id);
    if (!row) {
      throw new Error(
        `selection ${id}: missing full selected record `
        + "(episode_ids-only / partial selected rejected)",
      );
    }
    if (!ALLOWED_JOIN_CONFIDENCES.includes(row.join_confidence)) {
      throw new Error(`selection ${id}: join_confidence must be exact|heuristic, got ${JSON.stringify(row.join_confidence)}`);
    }
    if (row.tools !== null) {
      throw new Error(`selection ${id}: tools must be null (prompt-only), got ${JSON.stringify(row.tools)}`);
    }
    if (row.replayable !== true) {
      throw new Error(`selection ${id}: replayable must be true`);
    }
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
 * Re-validates tools=null, join_confidence, source presence, self-contained.
 */
export function resolveSelectedSourceEpisodes(sourceEpisodes, metaById, selectionInfo) {
  const byId = new Map(sourceEpisodes.map((e) => [e.episode_id, e]));
  const selected = [];
  const excluded = [];
  for (const id of selectionInfo.episodeIds) {
    const episode = byId.get(id);
    const meta = metaById.get(id);
    const row = selectionInfo.selectedById.get(id);
    const reasons = [];
    if (!episode) reasons.push("source_episode_missing");
    if (!meta) reasons.push("meta_missing");
    if (episode && episode.tools !== null) reasons.push("tools_not_null");
    if (row && row.tools !== null) reasons.push("selection_tools_not_null");
    const join = row?.join_confidence ?? episode?.join_confidence;
    if (!ALLOWED_JOIN_CONFIDENCES.includes(join)) reasons.push("join_not_allowed");
    if (episode) {
      const selfContained = (episode.missing_evidence ?? []).length === 0
        && Array.isArray(episode.slots) && episode.slots.length > 0
        && episode.slots.every((s) => typeof s?.output === "string" && s.output.length > 0 && !s.output.startsWith(TRUNCATED_MARKER));
      if (!selfContained) reasons.push("not_self_contained");
    }
    const models = (meta?.slots ?? []).filter((s) => s.in_body === true).map((s) => s.model);
    if (models.some((m) => REPLAY_JUDGE_MODELS.includes(m))) reasons.push("contains_judge_model");
    if (reasons.length > 0) {
      excluded.push({ episode_id: id, reason: "selection_resolve", reasons });
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

// ── protocol hash / checkpoint ────────────────────────────────────────────

/**
 * Checkpoint protocol hash binds selection + source + models + thinking +
 * system/user protocol + resource/retry + redactor + schema + experiment
 * mode / history exclusion. Any change invalidates resume.
 */
export function buildReplayProtocolHash({
  selectionHash,
  sourceContentHash,
  models,
  thinking,
  systemPrompt = REPLAY_SYSTEM_PROMPT,
  userProtocol = REPLAY_USER_PROTOCOL,
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
}) {
  return sha256Hex(stableStringify({
    selection_hash: selectionHash,
    source_content_hash: sourceContentHash,
    models: [...models],
    thinking,
    system_prompt: systemPrompt,
    user_protocol: userProtocol,
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
 */
export async function runReplayAnswer(invoker, modelRef, prompt, {
  thinking = REPLAY_DEFAULT_THINKING,
  maxRetries = REPLAY_DEFAULT_MAX_RETRIES,
  timeoutMs = REPLAY_DEFAULT_TIMEOUT_MS,
  maxOutputChars = REPLAY_DEFAULT_MAX_OUTPUT_BYTES,
  operation = "t0_replay_answer",
  model = null,
} = {}) {
  const attemptLog = [];
  // Fail-closed before any call when thinking is unsupported for this model.
  const resolvedModel = model ?? resolveModelFromInvoker(invoker, modelRef);
  if (!resolvedModel) {
    const entry = {
      attempt: 0,
      ok: false,
      error: `model not found: ${modelRef}`,
      error_class: "infrastructure_or_generation_failure",
      usage: null,
      cost: null,
      cost_source: null,
    };
    attemptLog.push(entry);
    return {
      ok: false,
      error: entry.error,
      error_class: "infrastructure_or_generation_failure",
      exclusion_reason: "replay_model_not_found",
      usage: null,
      modelRef,
      attempts: 1,
      attempt_log: attemptLog,
      cost: null,
      cost_source: null,
    };
  }
  if (!isThinkingLevelSupported(resolvedModel, thinking)) {
    const entry = {
      attempt: 0,
      ok: false,
      error: `thinking level ${JSON.stringify(thinking)} unsupported for ${modelRef}`,
      error_class: "infrastructure_or_generation_failure",
      usage: null,
      cost: null,
      cost_source: null,
    };
    attemptLog.push(entry);
    return {
      ok: false,
      error: entry.error,
      error_class: "infrastructure_or_generation_failure",
      exclusion_reason: "thinking_level_unsupported",
      usage: null,
      modelRef,
      attempts: 1,
      attempt_log: attemptLog,
      cost: null,
      cost_source: null,
    };
  }

  let lastError = null;
  let lastUsage = null;
  let lastErrorClass = "content";
  let contentFailed = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const hint = contentFailed
      ? "\n\nYour previous response was not accepted. Please answer the task prompt directly with a complete, non-empty final answer."
      : "";
    const userContent = `${REPLAY_USER_PROTOCOL}\n\n${prompt}${hint}`;
    const result = await callJudge(invoker, modelRef, REPLAY_SYSTEM_PROMPT, userContent, {
      maxRetries: 0,
      timeoutMs,
      maxOutputChars,
      operation,
      module: "t0-replay",
      reasoning: thinking,
    });
    const costInfo = attemptCost(modelRef, result.usage);
    if (result.ok && typeof result.text === "string" && result.text.length > 0) {
      // Use only this call's actual max-output cap when known. Never the
      // model-catalog maxTokens (often much higher than the gateway/call cap).
      const actualMaxOutputTokens = typeof result.maxOutputTokens === "number"
        ? result.maxOutputTokens
        : (typeof result.usage?.max_output_tokens === "number"
          ? result.usage.max_output_tokens
          : null);
      const deg = detectGenerationDegeneration(result.text, {
        maxOutputBytes: maxOutputChars,
        usage: result.usage,
        maxOutputTokens: actualMaxOutputTokens,
      });
      if (deg.degenerated) {
        attemptLog.push({
          attempt,
          ok: false,
          error: `generation degeneration: ${deg.reasons.join(",")}`,
          error_class: "infrastructure_or_generation_failure",
          degeneration_reasons: deg.reasons,
          usage: result.usage,
          cost: costInfo.cost,
          cost_source: costInfo.source,
          raw_output: summarizeFailedOutput(result),
        });
        lastError = `generation degeneration: ${deg.reasons.join(",")}`;
        lastUsage = result.usage;
        lastErrorClass = "infrastructure_or_generation_failure";
        // Near hard caps are not fixed by retry; action-intent / imbalance may be.
        if (deg.reasons.some((r) => r.startsWith("near_max_"))) {
          break;
        }
        contentFailed = true;
        continue;
      }
      attemptLog.push({
        attempt,
        ok: true,
        error: null,
        error_class: null,
        usage: result.usage,
        cost: costInfo.cost,
        cost_source: costInfo.source,
      });
      return {
        ok: true,
        output: result.text,
        error_class: null,
        exclusion_reason: null,
        usage: result.usage,
        modelRef,
        attempts: attemptLog.length,
        attempt_log: attemptLog,
        cost: sumAttemptCosts(attemptLog),
        cost_source: aggregateCostSource(attemptLog),
      };
    }
    const errClass = result.errorClass === "transport"
      ? "transport"
      : (result.errorClass ?? "content");
    attemptLog.push({
      attempt,
      ok: false,
      error: result.error ?? "empty output",
      error_class: errClass,
      usage: result.usage,
      cost: costInfo.cost,
      cost_source: costInfo.source,
      raw_output: summarizeFailedOutput(result),
    });
    lastError = result.error ?? "empty output";
    lastUsage = result.usage;
    lastErrorClass = errClass;
    if (errClass === "transport") {
      if (attempt < maxRetries) {
        await sleep(2_000 * 2 ** attempt + Math.floor(Math.random() * 500));
      }
      continue;
    }
    contentFailed = true;
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
  const { redact } = buildEpisodeRedactor(blindKey, episodeId, corpusModelNames, []);

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

  const replay = [];
  for (const r of replayResults) {
    const base = {
      kind: "replay",
      model: r.model,
      calledAt: r.calledAt,
      thinking: r.thinking ?? thinking,
      attempts: r.attempts,
      attempt_log: r.attempt_log,
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
    const residualIds = collectResidualIds([r.output]);
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
    const redactedFull = redact(r.output);
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
        output: h.output,
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

  if (replayInBody.length === 0) {
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
      prompt: sourceEpisode.prompt,
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

/** Assert body has only allowed keys (for tests + write-time guard). */
export function assertAnonymousBody(episode) {
  if (!episode) return;
  for (const key of Object.keys(episode)) {
    if (!BODY_EPISODE_KEYS.includes(key)) {
      throw new Error(`anonymous body leaks field ${key}`);
    }
  }
  if (episode.tools !== null) throw new Error("anonymous body tools must be null");
  for (const slot of episode.slots ?? []) {
    for (const key of Object.keys(slot)) {
      if (!BODY_SLOT_KEYS.includes(key)) {
        throw new Error(`anonymous body slot leaks field ${key}`);
      }
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { ...argv };
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const episodesPath = args.episodes ? path.resolve(args.episodes) : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl");
  const metaPath = args.meta ? path.resolve(args.meta) : path.join(path.dirname(episodesPath), "episodes.meta.jsonl");
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
  };
}

/** Resolve per-episode thinking under the active experiment mode. */
export function resolveReplayThinking(options, sourceEpisode) {
  if (options.currentOnly) return CURRENT_ONLY_THINKING;
  if (options.thinkingOverride !== undefined) return options.thinkingOverride;
  return sourceEpisode?.thinking_level ?? null;
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (key in args) {
        const prev = args[key];
        args[key] = Array.isArray(prev) ? [...prev, next] : [prev, next];
      } else {
        args[key] = next;
      }
      i++;
    } else {
      args[key] = true;
    }
  }
  return parseArgs(args);
}

// ── stats / outputs ───────────────────────────────────────────────────────

export function buildStats({
  options,
  blind,
  sourceEpisodes,
  selectedThisRun,
  selectionExcluded,
  checkpoints,
  buildExclusions,
  corpusModelNames,
  selectionInfo = null,
}) {
  const replayCalls = {
    total: 0, ok: 0, failed: 0, attempts: 0, cost: 0, cost_source: null,
    by_model: {},
    by_error_class: {},
  };
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
        replayCalls.total++;
        if (slot.in_body === true) replayCalls.ok++;
        else replayCalls.failed++;
        replayCalls.attempts += typeof r.attempts === "number" ? r.attempts : 0;
        replayCalls.cost += typeof r.cost === "number" ? r.cost : 0;
        const ec = r.error_class ?? (slot.in_body ? null : "unknown");
        if (ec) replayCalls.by_error_class[ec] = (replayCalls.by_error_class[ec] ?? 0) + 1;
        const m = replayCalls.by_model[slot.model] ?? {
          total: 0, ok: 0, failed: 0, attempts: 0, cost: 0, degeneration: 0, thinking_unsupported: 0,
        };
        m.total++;
        if (slot.in_body === true) m.ok++;
        else m.failed++;
        m.attempts += typeof r.attempts === "number" ? r.attempts : 0;
        m.cost += typeof r.cost === "number" ? r.cost : 0;
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
  const costSources = new Set();
  for (const cp of checkpoints) {
    for (const slot of cp.sidecar?.slots ?? []) {
      if (typeof slot.replay?.cost_source === "string") costSources.add(slot.replay.cost_source);
    }
  }
  replayCalls.cost_source = costSources.size === 0 ? null : costSources.size === 1 ? [...costSources][0] : "mixed";

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
      episodes_path: options.episodesPath,
      meta_path: options.metaPath,
      selection_path: selectionInfo?.path ?? null,
      selection_hash: selectionInfo?.selectionHash ?? null,
      selection_protocol_hash: selectionInfo?.protocolHash ?? null,
      episodes_available: sourceEpisodes.length,
      corpus_models: corpusModelNames.length,
    },
    selection: {
      mode: options.currentOnly
        ? "current_only_manifest"
        : (selectionInfo ? "fair_manifest" : "legacy_fixture"),
      selected_this_run: selectedThisRun.length,
      // cumulative = body episodes under CURRENT selection+protocol only
      // (old checkpoints with mismatched hashes are never mixed in).
      cumulative: bodyEpisodes,
      cumulative_checkpoints: checkpoints.length,
      excluded: selectionExcluded.length,
      excluded_by_reason: selectionExcludedByReason,
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
      calls: replayCalls,
    },
    episodes: {
      count: bodyEpisodes,
      checkpoints: checkpoints.length,
      by_slot_count: byModelCount,
      slots_by_source: slotsBySource,
      total_episode_bytes: totalEpisodeBytes,
    },
    availability: {
      slots_excluded: Object.values(availabilityByReason).reduce((s, n) => s + n, 0),
      by_reason: availabilityByReason,
    },
    build_exclusions: buildExclusions,
    blind_key: { source: blind.source, sha256: sha256Hex(blind.key) },
    resource: {
      min_models: options.minModels,
      max_output_bytes: options.maxOutputBytes,
      max_episode_bytes: options.maxEpisodeBytes,
      max_total_bytes: options.maxTotalBytes,
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

## NEVER feed to a judge

- **episodes.meta.jsonl** — identity, source mapping, attempts/cost/join
- **blind-key.json**
- **exclusions.jsonl**
- **stats.json**
- **checkpoints/**

## Replay protocol

All models received the SAME neutral system/user protocol, NO tools, and the
SAME thinking policy (\`${thinkingPolicy}\`${stats.replay?.thinking ? ` = \`${stats.replay.thinking}\`` : ""}).
Unsupported thinking levels and generation degeneration are recorded as
\`infrastructure_or_generation_failure\` in the sidecar and never enter the body.
Successful attempts have \`error_class=null\`.

experiment_mode: \`${experimentMode ?? "null (fair source-thinking)"}\`
history_excluded: \`${historyExcluded}\`
paired_required: \`${stats.replay?.paired_required === true}\`

## Selection

- mode: \`${stats.selection.mode}\`
- selected_this_run: ${stats.selection.selected_this_run}
- cumulative body episodes: ${stats.selection.cumulative}
- cumulative matching checkpoints: ${stats.selection.cumulative_checkpoints}
- selection_hash: \`${stats.inputs.selection_hash ?? "n/a"}\`

This is **prompt-only judgment qualification**, not an agentic execution score.
`;
}

export function writeOutputs(outputDir, { episodes, sidecar, exclusions, stats }) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const ep of episodes) assertAnonymousBody(ep);
  fs.writeFileSync(path.join(outputDir, "episodes.jsonl"), episodes.map((e) => JSON.stringify(e)).join("\n") + (episodes.length > 0 ? "\n" : ""));
  fs.writeFileSync(path.join(outputDir, "episodes.meta.jsonl"), sidecar.map((e) => JSON.stringify(e)).join("\n") + (sidecar.length > 0 ? "\n" : ""));
  fs.writeFileSync(path.join(outputDir, "exclusions.jsonl"), exclusions.map((e) => JSON.stringify(e)).join("\n") + (exclusions.length > 0 ? "\n" : ""));
  fs.writeFileSync(path.join(outputDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "README.md"), buildReadme(stats));
}

// ── main pipeline ─────────────────────────────────────────────────────────

function checkpointValid(cp, {
  contentHash,
  models,
  protocolHash,
  selectionHash = null,
}) {
  if (!cp || !asRecord(cp)) return false;
  if (cp.source_content_hash !== contentHash) return false;
  if (JSON.stringify(cp.replay_models ?? null) !== JSON.stringify(models)) return false;
  if (protocolHash && cp.protocol_hash !== protocolHash) return false;
  if (selectionHash && cp.selection_hash !== selectionHash) return false;
  if (!cp.sidecar || !asRecord(cp.sidecar)) return false;
  // episode may be null on full failure — still a valid checkpoint.
  return true;
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

  if (options.resume && fs.existsSync(checkpointFile)) {
    let cp = null;
    try {
      cp = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    } catch {
      cp = null;
    }
    if (checkpointValid(cp, {
      contentHash,
      models: options.models,
      protocolHash,
      selectionHash: selectionInfo?.selectionHash ?? null,
    })) {
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
    episode: built.episode,
    sidecar: built.sidecar,
    exclusion: built.exclusion,
    built_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  fs.writeFileSync(checkpointFile, `${JSON.stringify(cp, null, 2)}\n`);
  return { checkpoint: cp, skipped: false, exclusion: built.exclusion };
}

export async function buildReplay(options) {
  // Fair path requires --selection. Fail closed BEFORE touching source paths
  // so a missing --selection is never masked by episodes.jsonl errors.
  // Legacy select only with explicit flag (fixture tooling) — never default.
  let selectionInfo = null;
  let selectedItems = [];
  let selectionExcluded = [];

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

  const sourceEpisodes = loadEpisodes(options.episodesPath);
  const sourceMeta = loadMeta(options.metaPath);
  const metaById = new Map(sourceMeta.map((m) => [m.episode_id, m]));

  if (options.selectionPath) {
    selectionInfo = loadAndValidateSelection(options.selectionPath);
    // Optional further restrict via --episode (must be subset of selection).
    if (options.episodeIds?.length) {
      const allow = new Set(selectionInfo.episodeIds);
      for (const id of options.episodeIds) {
        if (!allow.has(id)) {
          throw new Error(`t0-replay-build: --episode ${id} is not in the selection manifest`);
        }
      }
      selectionInfo = {
        ...selectionInfo,
        episodeIds: options.episodeIds,
        selectedRows: selectionInfo.selectedRows.filter((r) => options.episodeIds.includes(r.episode_id)),
        selectedById: new Map(
          [...selectionInfo.selectedById.entries()].filter(([id]) => options.episodeIds.includes(id)),
        ),
      };
    }
    const resolved = resolveSelectedSourceEpisodes(sourceEpisodes, metaById, selectionInfo);
    selectedItems = resolved.selected;
    selectionExcluded = resolved.excluded;
  } else {
    // allowLegacySelect === true (fixture tooling only)
    const { selected, excluded } = selectReplayEpisodes(sourceEpisodes, metaById, {
      episodeIds: options.episodeIds,
      limit: options.limit,
    });
    selectedItems = selected.map((episode) => ({
      episode,
      meta: metaById.get(episode.episode_id),
      source_content_hash: episodeContentHash(episode),
      thinking: episode.thinking_level ?? null,
    }));
    selectionExcluded = excluded;
  }

  if (selectedItems.length === 0) {
    throw new Error(
      `t0-replay-build: no replayable episodes resolved `
      + `(available=${sourceEpisodes.length}, selection=${selectionInfo?.episodeIds?.length ?? "legacy"}, `
      + `excluded=${selectionExcluded.length})`,
    );
  }

  const blind = resolveBlindKey(options.output, options);
  if (blind.source !== "reused") {
    fs.mkdirSync(options.output, { recursive: true });
    fs.writeFileSync(
      path.join(options.output, BLIND_KEY_FILE),
      `${JSON.stringify({ schema_version: 1, blind_key: blind.key, source: blind.source }, null, 2)}\n`,
    );
  }

  const corpusModelNames = [...new Set(
    sourceMeta.flatMap((m) => (m.slots ?? []).map((s) => s.model)).filter(Boolean),
  )].sort();

  const invoker = await makeJudgeInvoker({ modelsJsonPath: options.modelsJsonPath });
  const buildExclusions = [];
  const queue = [...selectedItems];
  const workers = Array.from(
    { length: Math.min(options.concurrency, Math.max(1, selectedItems.length)) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        const result = await processEpisode(invoker, item, blind, corpusModelNames, options, selectionInfo);
        if (result.exclusion) buildExclusions.push(result.exclusion);
        if (result.skipped) continue;
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

  // Cumulative: scan checkpoints, but ONLY admit those matching the current
  // selection_hash + per-episode protocol_hash (and selected source ids).
  // Old/mismatched checkpoints never mix into episodes.jsonl / stats.
  const checkpointsDir = path.join(options.output, "checkpoints");
  const selectedBySourceId = new Map(selectedItems.map((it) => [it.episode.episode_id, it]));
  const expectedProtocolBySource = new Map();
  for (const item of selectedItems) {
    expectedProtocolBySource.set(
      item.episode.episode_id,
      buildEpisodeProtocolHash(item, options, selectionInfo),
    );
  }
  const selectionHash = selectionInfo?.selectionHash ?? null;
  const allCheckpoints = [];
  if (fs.existsSync(checkpointsDir)) {
    for (const name of fs.readdirSync(checkpointsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(checkpointsDir, name), "utf8"));
        if (!cp || !asRecord(cp) || !cp.sidecar) continue;
        const sourceId = cp.source_episode_id;
        if (!selectedBySourceId.has(sourceId)) continue;
        if (selectionHash && cp.selection_hash !== selectionHash) continue;
        const expectedProtocol = expectedProtocolBySource.get(sourceId);
        if (expectedProtocol && cp.protocol_hash !== expectedProtocol) continue;
        if (JSON.stringify(cp.replay_models ?? null) !== JSON.stringify(options.models)) continue;
        allCheckpoints.push(cp);
      } catch {
        /* skip malformed */
      }
    }
  }
  allCheckpoints.sort((a, b) => (
    (a.source_episode_id < b.source_episode_id ? -1 : a.source_episode_id > b.source_episode_id ? 1 : 0)
  ));

  const episodes = allCheckpoints.map((c) => c.episode).filter(Boolean);
  const sidecar = allCheckpoints.map((c) => c.sidecar);
  // Merge exclusions from selection resolve + build + checkpoint.exclusion
  const exclusions = [
    ...selectionExcluded,
    ...buildExclusions,
    ...allCheckpoints
      .filter((c) => c.exclusion)
      .map((c) => c.exclusion),
  ];
  // Dedupe exclusions by episode_id+reason
  const seenEx = new Set();
  const dedupedExclusions = [];
  for (const e of exclusions) {
    const key = `${e.episode_id}::${e.reason ?? ""}`;
    if (seenEx.has(key)) continue;
    seenEx.add(key);
    dedupedExclusions.push(e);
  }

  const totalBodyBytes = episodes.reduce((sum, e) => sum + utf8ByteLength(JSON.stringify(e)) + 1, 0);
  if (totalBodyBytes > options.maxTotalBytes) {
    throw new Error(
      `t0-replay-build: total episodes.jsonl size ${totalBodyBytes} bytes exceeds `
      + `--max-total-bytes ${options.maxTotalBytes} (fail-closed)`,
    );
  }

  const stats = buildStats({
    options,
    blind,
    sourceEpisodes,
    selectedThisRun: selectedItems,
    selectionExcluded,
    checkpoints: allCheckpoints,
    buildExclusions: dedupedExclusions,
    corpusModelNames,
    selectionInfo,
  });
  writeOutputs(options.output, { episodes, sidecar, exclusions: dedupedExclusions, stats });
  return { episodes, sidecar, exclusions: dedupedExclusions, stats };
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  buildReplay(options).then(({ episodes, stats }) => {
    const calls = stats.replay.calls;
    console.log(
      `t0-replay-build: body_episodes=${episodes.length}, `
      + `selected_this_run=${stats.selection.selected_this_run}, `
      + `cumulative_checkpoints=${stats.selection.cumulative_checkpoints}, `
      + `models=${options.models.join(",")}, `
      + `thinking=${options.currentOnly ? CURRENT_ONLY_THINKING : "source_episode"}, `
      + `experiment_mode=${options.experimentMode ?? "fair"}, `
      + `history_excluded=${options.historyExcluded === true}, `
      + `replay calls=${calls.total} (ok=${calls.ok}, failed=${calls.failed}, attempts=${calls.attempts}), `
      + `cost=$${Number(calls.cost ?? 0).toFixed(4)} (${calls.cost_source ?? "n/a"}), `
      + `blind_key=${stats.blind_key.source}`,
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
