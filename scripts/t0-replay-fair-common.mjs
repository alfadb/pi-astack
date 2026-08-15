/**
 * t0-replay-fair-common — fair prompt-only replay sample classification.
 *
 * Scope: selection + semantic classification of source episodes for a
 * prompt-only judgment replay list. Does NOT cover agentic execution, and
 * does not call Flash/Grok or modify the replay build/run path.
 *
 * Hard structural gates (fail-closed, before any LLM call):
 *   - join_confidence ∈ {exact, heuristic}  (builder-verified only; exact
 *     preferred / stratified; do NOT hard-exclude heuristic)
 *   - episode.tools === null  (original historical task had no tools)
 *   - body/meta slot_id one-to-one mapping complete (body slots ↔ in_body meta)
 *   - self-contained outputs (no missing evidence, non-empty, not truncated)
 *   - ≥1 strong reference (gpt-5.5 / opus-4-8) among in_body candidates
 *   - ≥1 specialist (K2.7 / GLM / M3)
 *   - none of the CLI --downstream-judges (default: replay-eval five roles
 *     deduped → Sol / Opus5 / K3). Classifier judges are independent and do
 *     NOT drive this exclusion.
 *
 * Semantic self-contained judgment (prompt-only):
 *   - Dual independent judges (default Sol + Opus 5; CLI --classifier-models
 *     must be exactly two distinct models) see ONLY the anonymous prompt
 *   - Structured fields: replayable, requires_*, reasons, confidence
 *   - Either judge non-replayable / disagreement → fail-closed
 *   - Mechanical hard exclude only for prompts that clearly require external
 *     repo / file path / command / test / live state (not embedded code review)
 *
 * Checkpoints bind schema_version + episode_id + prompt_hash + protocol_hash
 * + exactly two distinct judge_models + thinking; hits re-validate final schema.
 */

import fs from "node:fs";
import path from "node:path";

import {
  sha256Hex,
  asRecord,
  assertSafeEpisodeId,
  callJudge,
  parseJsonOutput,
  validateSchema,
  summarizeCosts,
  summarizeFailedOutput,
  sleep,
  ATTEMPT_LEDGER_VERSION,
  ATTEMPT_LEDGER_CONTRACT_ID,
  validateAttemptLedgerV2,
  episodeMetaSetParity,
  validateProducerInventory,
} from "./t0-eval-common.mjs";
import {
  STRONG_REFERENCE_MODELS,
  SPECIALIST_MODELS,
  REPLAY_JUDGE_MODELS,
  ALLOWED_JOIN_CONFIDENCES,
  bodyMetaSlotMapComplete,
  outputsSelfContained,
  joinConfidenceAllowed,
  evaluateHardGates,
} from "./t0-replay-build.mjs";

export {
  STRONG_REFERENCE_MODELS,
  SPECIALIST_MODELS,
  REPLAY_JUDGE_MODELS,
  ALLOWED_JOIN_CONFIDENCES,
  bodyMetaSlotMapComplete,
  outputsSelfContained,
  joinConfidenceAllowed,
  evaluateHardGates,
  ATTEMPT_LEDGER_VERSION,
};

export const FAIR_SELECT_SCHEMA_VERSION = 1;
export const CLASSIFIER_SCHEMA_VERSION = 1;
/**
 * Classifier result/checkpoint contract version. Bumped whenever the
 * checkpoint `final` state contract changes (e.g. the explicit
 * `classification_status` field). Bound into classifierProtocolHash() so a
 * contract change invalidates every old checkpoint/manifest — old finals
 * without `classification_status` are never resumed or admitted.
 * Deliberately independent of ATTEMPT_LEDGER_VERSION (ledger identity).
 *
 * v2 (2026-08): checkpoint lifecycle is fail-closed. An EXISTING checkpoint
 * is never a cache miss and never overwritten: malformed / unknown / stale /
 * identity-mismatch / body-invalid checkpoints AND valid `failed`
 * (diagnostic) checkpoints throw before any invoker/provider call;
 * `--no-resume` with an existing checkpoint throws instead of overwriting;
 * saves are atomic create-if-absent (the race loser is rejected). v1
 * checkpoints (written when failed checkpoints were re-called + overwritten
 * and when `--no-resume` silently replaced files) are stale under v2 and
 * fail closed.
 */
export const CLASSIFIER_RESULT_CONTRACT_VERSION = 2;
export const CLASSIFIER_DEFAULT_JUDGES = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
/** Default self-judge exclusion set: replay-eval five roles, deduped. */
export const DEFAULT_DOWNSTREAM_JUDGES = [...REPLAY_JUDGE_MODELS];
export const CLASSIFIER_DEFAULT_MAX_RETRIES = 2;
export const CLASSIFIER_DEFAULT_TIMEOUT_MS = 600_000;
export const CLASSIFIER_DEFAULT_CONCURRENCY = 2;
export const CLASSIFIER_DEFAULT_THINKING = "medium";

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

function jsonSemanticEqual(a, b) {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

/**
 * Classifier system prompt — identity-free, tool-free, judgment only.
 * Protocol text is hashed into protocol_hash for checkpoint binding.
 */
export const CLASSIFIER_SYSTEM_PROMPT = `You are a prompt-only replayability classifier for anonymous historical task prompts.

You judge whether a SINGLE anonymous task prompt can be answered fairly by a model that receives ONLY the prompt text — no tools, no workspace, no files, no shell, no live external state, and no ability to verify claims against a real repository.

This is prompt-only judgment. It does NOT cover agentic execution.

Rules:
- You see only the anonymous prompt. There are no tools and no identity metadata.
- Mark replayable=true ONLY if a competent model can produce a complete, self-contained answer from the prompt text alone.
- If the prompt requires reading external files, inspecting a workspace/repo, running commands/tests, checking live external state, or tool-based verification, set the corresponding requires_* field to true and set replayable=false.
- Embedded code/text inside the prompt (e.g. "review the following code", "以下代码") is self-contained material — that alone is NOT a workspace/file requirement.
- Prefer fail-closed: when uncertain, set replayable=false and explain why.
- Output a single JSON object matching the schema. No prose outside JSON.`;

export const CLASSIFIER_USER_PROTOCOL = `Classify the anonymous task prompt below for prompt-only replayability.

Return ONE JSON object with exactly these fields:
- schema_version: number 1
- replayable: boolean
- requires_workspace: boolean
- requires_files: boolean
- requires_commands: boolean
- requires_live_external_state: boolean
- requires_tool_verification: boolean
- reasons: string[] (short, concrete; at least one entry)
- confidence: number in [0, 1]

Hard constraints:
- If ANY requires_* is true, replayable MUST be false.
- If the prompt can be answered from its embedded text alone (review of quoted/embedded code or text, pure reasoning, design judgment with all needed material in the prompt), requires_* are false and replayable may be true.
- Do not invent tools. Do not assume a workspace exists.`;

export const CLASSIFIER_OUTPUT_SCHEMA = {
  type: "object",
  required: [
    "schema_version",
    "replayable",
    "requires_workspace",
    "requires_files",
    "requires_commands",
    "requires_live_external_state",
    "requires_tool_verification",
    "reasons",
    "confidence",
  ],
  properties: {
    schema_version: { type: "number" },
    replayable: { type: "boolean" },
    requires_workspace: { type: "boolean" },
    requires_files: { type: "boolean" },
    requires_commands: { type: "boolean" },
    requires_live_external_state: { type: "boolean" },
    requires_tool_verification: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
};

/**
 * Final classification record schema (checkpoint / resume validation).
 * Strict: a checkpoint hit is only reused when every required field is valid.
 */
export const FINAL_CLASSIFICATION_SCHEMA = {
  type: "object",
  required: [
    "episode_id",
    "stage",
    "classification_status",
    "replayable",
    "reasons",
    "confidence",
    "cost",
    "cost_source",
    "cost_breakdown",
    "attempts",
    "judge_models",
    "prompt_hash",
    "protocol_hash",
    "thinking",
    "schema_version",
  ],
  properties: {
    episode_id: { type: "string" },
    stage: { type: "string" },
    // Explicit state contract: completed = mechanical exclude or a legal
    // dual-judge merge (incl. semantic non-replayable / disagreement);
    // failed = at least one judge produced no valid judgment (preflight /
    // auth / http / timeout / truncation / schema / content). Never inferred
    // from reasons.
    classification_status: { type: "string", enum: ["completed", "failed"] },
    replayable: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    cost: { type: "number", allowNull: true },
    cost_source: { type: "string", allowNull: true },
    cost_breakdown: { type: "object" },
    attempts: { type: "number" },
    judge_models: { type: "array", items: { type: "string" } },
    prompt_hash: { type: "string" },
    protocol_hash: { type: "string" },
    thinking: { type: "string" },
    schema_version: { type: "number" },
    mechanical: { type: "object", allowNull: true },
    flags: { type: "object", allowNull: true },
    disagreement: { type: "boolean", allowNull: true },
    judgments: { type: "object", allowNull: true },
    attempt_log: { type: "object", allowNull: true },
    from_checkpoint: { type: "boolean", allowNull: true },
  },
};

/** Strict tool schema for constrained sampling (all properties required). */
function toStrictClassifierSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "replayable",
      "requires_workspace",
      "requires_files",
      "requires_commands",
      "requires_live_external_state",
      "requires_tool_verification",
      "reasons",
      "confidence",
    ],
    properties: {
      schema_version: { type: "number" },
      replayable: { type: "boolean" },
      requires_workspace: { type: "boolean" },
      requires_files: { type: "boolean" },
      requires_commands: { type: "boolean" },
      requires_live_external_state: { type: "boolean" },
      requires_tool_verification: { type: "boolean" },
      reasons: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
    },
  };
}

export function buildClassifierTool() {
  return {
    name: "submit_classification",
    description: "Submit the prompt-only replayability classification as a single JSON object. Structured-output mechanism only — cannot read files or take any action.",
    parameters: toStrictClassifierSchema(),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
}

export function classifierProtocolHash({
  systemPrompt = CLASSIFIER_SYSTEM_PROMPT,
  userProtocol = CLASSIFIER_USER_PROTOCOL,
  schemaVersion = CLASSIFIER_SCHEMA_VERSION,
  schema = CLASSIFIER_OUTPUT_SCHEMA,
  resultContractVersion = CLASSIFIER_RESULT_CONTRACT_VERSION,
} = {}) {
  return sha256Hex(JSON.stringify({
    schema_version: schemaVersion,
    ledger_version: ATTEMPT_LEDGER_VERSION,
    ledger_contract_id: ATTEMPT_LEDGER_CONTRACT_ID,
    result_contract_version: resultContractVersion,
    system: systemPrompt,
    user_protocol: userProtocol,
    output_schema: schema,
  }));
}

export function promptHash(prompt) {
  return sha256Hex(String(prompt ?? ""));
}

// ── dual-judge model contract ─────────────────────────────────────────────

/**
 * Public dual-judge contract: exactly TWO distinct model refs.
 * Rejects missing, duplicates, or a third (or more) model.
 */
export function requireExactlyTwoDistinctJudges(models, { label = "classifier-models" } = {}) {
  if (!Array.isArray(models)) {
    throw new Error(`${label}: expected an array of exactly 2 distinct model refs`);
  }
  if (models.length !== 2) {
    throw new Error(
      `${label}: requires exactly 2 distinct models, got ${models.length}`
      + (models.length > 2 ? " (third+ rejected)" : ""),
    );
  }
  const [a, b] = models;
  if (typeof a !== "string" || !a.trim() || typeof b !== "string" || !b.trim()) {
    throw new Error(`${label}: each model ref must be a non-empty string`);
  }
  if (a === b) {
    throw new Error(`${label}: the two models must be distinct (got duplicate ${a})`);
  }
  return [a, b];
}

/**
 * Parse a comma-separated / repeated CLI model list into a clean string[].
 */
export function parseModelList(raw) {
  if (raw === undefined || raw === true || raw === false || raw === null) return null;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * Downstream judges for self-candidate exclusion: 1..5 distinct model refs.
 */
export function requireDownstreamJudges(models, { label = "downstream-judges" } = {}) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 5) {
    throw new Error(`${label}: requires 1..5 distinct model refs, got ${models?.length ?? 0}`);
  }
  const cleaned = models.map((m) => {
    if (typeof m !== "string" || !m.trim()) {
      throw new Error(`${label}: each model ref must be a non-empty string`);
    }
    return m.trim();
  });
  const uniq = [...new Set(cleaned)];
  if (uniq.length !== cleaned.length) {
    throw new Error(`${label}: model refs must be distinct (duplicates rejected)`);
  }
  return uniq;
}

// ── meta loading ──────────────────────────────────────────────────────────

/**
 * Read the episodes.meta.jsonl sidecar.
 *
 * `strict` (default false) is the fail-closed corpus mode used by the fair
 * selector and the production dossiers: any non-empty line that fails
 * JSON.parse, any non-object record, any missing/invalid episode_id, any
 * episode_id with leading/trailing whitespace and any duplicate episode_id
 * throws with the path + 1-based line number (duplicate errors also name
 * the id). In strict mode an episode_id must be a non-empty string that is
 * unchanged by trim() — blank and whitespace-padded ids are rejected (a
 * "ep-x " id is a different identity than "ep-x" and would silently split
 * the corpus). The default permissive mode keeps skipping malformed /
 * unusable lines exactly as before.
 */
export function loadMeta(metaPath, { strict = false } = {}) {
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
      if (typeof row.episode_id !== "string" || !row.episode_id.trim()) {
        throw new Error(`episodes.meta.jsonl ${metaPath}:${lineNo}: missing or invalid episode_id`);
      }
      if (row.episode_id !== row.episode_id.trim()) {
        throw new Error(`episodes.meta.jsonl ${metaPath}:${lineNo}: episode_id must have no leading/trailing whitespace (got ${JSON.stringify(row.episode_id)})`);
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

// ── hard structural selection ─────────────────────────────────────────────
//
// The pure gate helpers (bodyMetaSlotMapComplete / outputsSelfContained /
// joinConfidenceAllowed / evaluateHardGates) live in t0-replay-build.mjs and
// are imported + re-exported above — the fair selector and the replay build's
// eligibility resolver share ONE rule set and can never drift apart.

/**
 * Scan all source episodes through hard gates. Returns candidates that pass
 * every hard condition plus a full exclusion list with reasons.
 * Candidates are stratified: exact-join first, then heuristic; stable by id.
 */
export function selectHardCandidates(episodes, metaById, {
  episodeIds = null,
  limit = undefined,
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  downstreamJudges = DEFAULT_DOWNSTREAM_JUDGES,
} = {}) {
  const explicit = episodeIds && episodeIds.length > 0 ? new Set(episodeIds) : null;
  const passed = [];
  const excluded = [];
  const distribution = Object.create(null);
  const join_tier = { exact: 0, heuristic: 0 };

  for (const episode of episodes) {
    if (explicit && !explicit.has(episode.episode_id)) continue;
    const meta = metaById.get(episode.episode_id) ?? null;
    const gate = evaluateHardGates(episode, meta, { strongRefs, specialists, downstreamJudges });
    if (!gate.ok) {
      excluded.push({
        episode_id: episode.episode_id,
        stage: "hard",
        reasons: gate.reasons,
        join_confidence: episode?.join_confidence ?? null,
      });
      for (const r of gate.reasons) distribution[r] = (distribution[r] ?? 0) + 1;
      continue;
    }
    if (gate.join_confidence === "exact") join_tier.exact += 1;
    else if (gate.join_confidence === "heuristic") join_tier.heuristic += 1;
    passed.push({
      episode,
      meta,
      models: gate.models,
      join_confidence: gate.join_confidence,
      exact: gate.join_confidence === "exact",
    });
  }

  // Exact preferred, then stable by episode_id within tier.
  passed.sort((a, b) => {
    const tier = (b.exact ? 1 : 0) - (a.exact ? 1 : 0);
    if (tier !== 0) return tier;
    const x = a.episode.episode_id, y = b.episode.episode_id;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const limited = limit !== undefined && Number.isFinite(limit) ? passed.slice(0, limit) : passed;
  return {
    candidates: limited,
    all_hard_pass: passed,
    excluded,
    distribution,
    hard_pass_count: passed.length,
    join_tier,
  };
}

// ── fair manifest provenance validation ───────────────────────────────────
//
// Pure, read-only, no invoker / credentials / provider requests. Verifies a
// canonical `selection.json` is the COMPLETE product of the real classifier
// selector over the real corpus + its own checkpoints-fair/*.json — a
// hand-written or derived two-line manifest cannot pass. Works on any
// fixture temp dir (paths are parameters, never hardcoded production paths).

/**
 * Validate a fair selection manifest against the real corpus + the
 * selector's own checkpoints (canonical `selection.json` same-dir
 * `checkpoints-fair/*.json`). Returns { ok, errors: string[] } — errors is
 * empty when the manifest is a genuine full classifier-selector product.
 *
 * Checks (all fail-closed, no warn-only):
 *   - strict top-level identity: kind/schema_version constants, classify===true,
 *     hard_only===false, limit===null, protocol_hash === current
 *     classifierProtocolHash(), judge_models === classifier_models (both the
 *     checkpoints' actual dual-judge identity), downstream_judges === the
 *     downstreamJudges the fresh scan used, thinking === checkpoint thinking
 *   - classifications: length === hard candidates, episode_id unique and in
 *     the selector's hard-candidate order; every row deep-compared to its
 *     checkpoint final (stage / replayable / reasons / confidence / cost /
 *     cost_source / cost_breakdown / from_checkpoint) plus the
 *     checkpoint-final-only fields (flags / has_unknown_cost / known_total /
 *     attempts) and the checkpoint body (judgments / attempt_log per the
 *     real llm/mechanical schema)
 *   - selected: the COMPLETE expected rows rebuilt from hard.candidates +
 *     checkpoint finals per the real selector construction and sort (exact
 *     first, confidence desc, episode_id asc) — every row deepEqual, and
 *     episode_ids in the same order (reverse / reasons / confidence / tools /
 *     models / join forgery all rejected)
 *   - excluded: the full expected array (fresh hard exclusions in corpus
 *     order + non-replayable classification rows in hard-candidate order)
 *     deepEqual, including order and every selector-emitted field
 *   - counts: every selector-emitted count (source / hard_pass /
 *     hard_pass_limited / classified / replayable / excluded /
 *     data_insufficient / join_hard_pass / join_selected) rebuilt and
 *     compared; extra/missing/forged values rejected
 *   - exclusion_distribution: rebuilt from the fresh hard distribution +
 *     non-replayable classification reasons per the selector's exact rule;
 *     deepEqual, extra keys rejected
 *   - checkpoint body: llm stage requires the real schema's judgments /
 *     attempt_log present and consistent with final/identity; mechanical per
 *     the real schema. No cryptographic signature is claimed — but a
 *     hand-written manifest without forging every complete checkpoint cannot
 *     pass.
 */

/**
 * Checkpoint-body consistency per the real classifier schema, recomputed from
 * the SAME pure functions the producer uses (never hand-written approximations):
 *   - llm: mergeDualJudgments(cp.judgments) must reproduce the final's
 *     replayable/reasons/confidence/flags/disagreement; summarizeClassifierCosts
 *     (cp.attempt_log) must reproduce cost/cost_source/cost_breakdown/
 *     has_unknown_cost/known_total; attempts = sum of each judge log length;
 *     every new-format ledger attempt must carry a unique request_id.
 *   - mechanical: mechanicalExclude(real episode.prompt) must equal
 *     cp.mechanical and the final's mechanical; attempts=0, cost ledger empty.
 * Returns string[] of errors (empty when consistent).
 * Exported for offline structural tests of real failed checkpoints.
 *
 * `seenRequestIds` (optional) is a caller-owned Set shared across MULTIPLE
 * checkpoints: when provided, request_id uniqueness is enforced across the
 * whole set (one validateFairManifestProvenance invocation passes a single
 * global set so a request_id reused by two checkpoints fails closed). When
 * absent, a fresh local Set keeps the standalone per-checkpoint uniqueness
 * semantics unchanged.
 */
export function validateCheckpointBody(cp, f, { id, judgeModels, prompt, seenRequestIds = null }) {
  const errors = [];
  const stage = f.stage;
  const expectedKeys = [...judgeModels].sort();
  if (stage === "llm") {
    const judgments = cp.judgments;
    const attemptLog = cp.attempt_log;
    if (!asRecord(judgments)) errors.push("llm checkpoint must carry a judgments object");
    if (!asRecord(attemptLog)) errors.push("llm checkpoint must carry an attempt_log object");
    if (asRecord(judgments)) {
      if (JSON.stringify(Object.keys(judgments).sort()) !== JSON.stringify(expectedKeys)) {
        errors.push(`llm checkpoint judgments keys ${JSON.stringify(Object.keys(judgments).sort())} != judge models ${JSON.stringify(expectedKeys)}`);
      }
    }
    if (asRecord(attemptLog)) {
      if (JSON.stringify(Object.keys(attemptLog).sort()) !== JSON.stringify(expectedKeys)) {
        errors.push(`llm checkpoint attempt_log keys ${JSON.stringify(Object.keys(attemptLog).sort())} != judge models ${JSON.stringify(expectedKeys)}`);
      }
      for (const [model, log] of Object.entries(attemptLog)) {
        if (!Array.isArray(log)) errors.push(`llm checkpoint attempt_log.${model} must be an array`);
      }
    }
    if (!jsonSemanticEqual(f.attempt_log ?? null, attemptLog ?? null)) {
      errors.push("checkpoint final attempt_log must equal the checkpoint attempt_log");
    }
    // New-format ledger identity via the SHARED v2 validator: every attempt
    // entry must carry a non-empty request_id unique across the whole
    // checkpoint (or across the caller-provided global set when one is
    // passed), the model_ref that actually made the request, the
    // classifier operation (`t0_replay_fair_classify`) and a null-or-64-hex
    // accepted_output_hash, with cost/source recomputed from the real usage
    // via attemptCost(model_ref, usage) — a forged cost/source, a missing /
    // duplicated request_id, a sync-renamed model_ref or a foreign
    // operation fails closed here.
    const seenIds = seenRequestIds ?? new Set();
    for (const [model, log] of Object.entries(attemptLog ?? {})) {
      if (!Array.isArray(log)) continue;
      const ledgerCheck = validateAttemptLedgerV2(log, {
        modelRef: model,
        expectedOperation: "t0_replay_fair_classify",
        seenIds,
        label: `llm checkpoint attempt_log.${model}`,
      });
      for (const e of ledgerCheck.errors) errors.push(e);
      // Family accepted-output semantics: ok=true entries bind a 64-hex hash
      // of the accepted judgment, ok=false entries bind null; the judgment
      // stored for a judge is non-null IFF that judge's ledger ends in a
      // success whose hash equals sha256(JSON.stringify(judgment)) — and a
      // null judgment means the log has NO success entry at all (a
      // completed checkpoint therefore always has two real successes; a
      // failed checkpoint can never fake one by relabelling fields).
      const judgment = asRecord(judgments) ? judgments[model] : null;
      for (const [i, entry] of log.entries()) {
        const at = `llm checkpoint attempt_log.${model}[${i}]`;
        if (entry?.ok === true && typeof entry.accepted_output_hash !== "string") {
          errors.push(`${at}.accepted_output_hash must be a non-null 64-hex sha256 when ok=true, got ${JSON.stringify(entry.accepted_output_hash)}`);
        } else if (entry?.ok === false && entry.accepted_output_hash !== null) {
          errors.push(`${at}.accepted_output_hash must be null when ok=false, got ${JSON.stringify(entry.accepted_output_hash)}`);
        }
      }
      if (judgment !== null && judgment !== undefined) {
        const last = log.length > 0 ? log[log.length - 1] : null;
        const normalizedForHash = normalizeClassifierJudgment(judgment);
        const expectedHash = normalizedForHash.ok
          ? sha256Hex(JSON.stringify(normalizedForHash.judgment))
          : sha256Hex(JSON.stringify(judgment));
        if (!last || last.ok !== true) {
          errors.push(`llm checkpoint judge ${model}: judgment is non-null but the ledger has no success entry (the last entry must be the accepted success)`);
        } else if (last.accepted_output_hash !== expectedHash) {
          errors.push(`llm checkpoint judge ${model}: accepted output hash ${JSON.stringify(last.accepted_output_hash)} != sha256(JSON.stringify(judgment)) ${expectedHash} (a relabelled judgment can never pass)`);
        }
        for (const entry of log) {
          if (entry?.ok === true && entry.accepted_output_hash !== expectedHash) {
            errors.push(`llm checkpoint judge ${model}: ok=true entry hash ${JSON.stringify(entry.accepted_output_hash)} != sha256(JSON.stringify(judgment)) ${expectedHash}`);
          }
        }
      } else if (log.some((e) => e?.ok === true)) {
        errors.push(`llm checkpoint judge ${model}: judgment is null but the ledger contains a success entry (a null judgment can never claim a success)`);
      }
    }
    // Cost/attempts recomputed from the real ledger via the producer's own
    // pure helpers — the checkpoint final must be exactly reproducible.
    const costSummary = summarizeClassifierCosts(attemptLog ?? {});
    if (f.cost !== costSummary.cost) errors.push(`checkpoint final cost ${f.cost} != summarizeClassifierCosts ${costSummary.cost}`);
    if (f.cost_source !== costSummary.cost_source) errors.push(`checkpoint final cost_source ${f.cost_source} != summarizeClassifierCosts ${costSummary.cost_source}`);
    if (!jsonSemanticEqual(f.cost_breakdown ?? null, costSummary.cost_breakdown ?? null)) {
      errors.push("checkpoint final cost_breakdown != summarizeClassifierCosts cost_breakdown");
    }
    if (f.has_unknown_cost !== costSummary.has_unknown) errors.push(`checkpoint final has_unknown_cost ${f.has_unknown_cost} != summarizeClassifierCosts ${costSummary.has_unknown}`);
    if (f.known_total !== costSummary.known_total) errors.push(`checkpoint final known_total ${f.known_total} != summarizeClassifierCosts ${costSummary.known_total}`);
    const attempts = Object.values(attemptLog ?? {}).reduce((s, log) => s + (Array.isArray(log) ? log.length : 0), 0);
    if (f.attempts !== attempts) errors.push(`checkpoint final attempts ${f.attempts} != sum of judge log lengths ${attempts}`);
    // ── explicit state contract: branch on classification_status, never
    // inferred from reasons. completed = legal dual-judge merge (both
    // judgments valid, final carries merged flags/disagreement/judgments);
    // failed = at least one judge produced no valid judgment (partial
    // success judgment retained as the non-null slot, final carries NO
    // merged flags/disagreement/judgments).
    const status = f.classification_status;
    const [j0, j1] = judgeModels;
    if (status === "completed") {
      if (asRecord(judgments) && asRecord(judgments[j0]) && asRecord(judgments[j1])) {
        // Every stored judgment must re-pass the producer's own normalizer.
        const n0 = normalizeClassifierJudgment(judgments[j0]);
        const n1 = normalizeClassifierJudgment(judgments[j1]);
        if (!n0.ok) errors.push(`completed checkpoint judge ${j0} judgment invalid: ${n0.errors.join("; ")}`);
        if (!n1.ok) errors.push(`completed checkpoint judge ${j1} judgment invalid: ${n1.errors.join("; ")}`);
        const merged = mergeDualJudgments(
          { ok: true, judgment: judgments[j0] },
          { ok: true, judgment: judgments[j1] },
          { judge0: j0, judge1: j1 },
        );
        if (f.replayable !== merged.replayable) errors.push(`checkpoint final replayable ${f.replayable} != mergeDualJudgments ${merged.replayable}`);
        if (JSON.stringify(f.reasons) !== JSON.stringify(merged.reasons)) errors.push("checkpoint final reasons != mergeDualJudgments reasons");
        if (f.confidence !== merged.confidence) errors.push(`checkpoint final confidence ${f.confidence} != mergeDualJudgments ${merged.confidence}`);
        if (!jsonSemanticEqual(f.flags ?? null, merged.flags ?? null)) errors.push("checkpoint final flags != mergeDualJudgments flags");
        if (f.disagreement !== merged.disagreement) errors.push(`checkpoint final disagreement ${f.disagreement} != mergeDualJudgments ${merged.disagreement}`);
        if (!jsonSemanticEqual(f.judgments, judgments)) {
          errors.push("checkpoint final judgments must equal the checkpoint judgments");
        }
      } else {
        errors.push("completed llm checkpoint requires both judge judgments");
      }
    } else if (status === "failed") {
      // Real failed checkpoint: at least one judge slot is null (the judge
      // produced no valid judgment); any non-null slot is a partial success
      // judgment and must re-pass the producer's own normalizer.
      const vals = Object.values(judgments ?? {});
      if (vals.length === 0) {
        errors.push("failed checkpoint must carry a judgments object with one slot per judge");
      } else if (!vals.some((j) => j === null)) {
        errors.push("failed checkpoint must have at least one null judgment (two non-null judgments cannot be failed)");
      }
      for (const [model, j] of Object.entries(judgments ?? {})) {
        if (j === null) continue;
        const n = normalizeClassifierJudgment(j);
        if (!n.ok) errors.push(`failed checkpoint judge ${model} partial judgment invalid: ${n.errors.join("; ")}`);
      }
      // The failed final must NOT carry merged flags/disagreement/judgments.
      if (f.flags !== null && f.flags !== undefined) errors.push("failed checkpoint final flags must be null");
      if (f.disagreement !== null && f.disagreement !== undefined) errors.push("failed checkpoint final disagreement must be null");
      if (f.judgments !== null && f.judgments !== undefined) errors.push("failed checkpoint final judgments must be null");
    } else {
      errors.push(`llm checkpoint classification_status must be completed|failed, got ${JSON.stringify(status)}`);
    }
  } else if (stage === "mechanical") {
    if (cp.judgments !== null && cp.judgments !== undefined) errors.push("mechanical checkpoint judgments must be absent/null");
    if (cp.attempt_log !== null && cp.attempt_log !== undefined) errors.push("mechanical checkpoint attempt_log must be absent/null");
    if (!asRecord(cp.mechanical)) errors.push("mechanical checkpoint must carry a mechanical object");
    if (!jsonSemanticEqual(f.mechanical ?? null, cp.mechanical ?? null)) {
      errors.push("checkpoint final mechanical must equal the checkpoint mechanical");
    }
    // Re-run the real mechanical gate on the real prompt — the checkpoint
    // must be exactly reproducible from the corpus.
    const mech = mechanicalExclude(prompt);
    if (!jsonSemanticEqual(cp.mechanical ?? null, mech)) {
      errors.push("checkpoint mechanical must equal mechanicalExclude(real prompt)");
    }
    if (f.flags !== null && f.flags !== undefined) errors.push("mechanical checkpoint final flags must be null");
    if (f.attempts !== 0) errors.push(`mechanical checkpoint final attempts must be 0, got ${f.attempts}`);
    if (f.cost !== 0) errors.push(`mechanical checkpoint final cost must be 0, got ${f.cost}`);
    if (f.cost_source !== null) errors.push(`mechanical checkpoint final cost_source must be null, got ${JSON.stringify(f.cost_source)}`);
    if (f.has_unknown_cost !== false) errors.push("mechanical checkpoint final has_unknown_cost must be false");
    if (f.known_total !== 0) errors.push(`mechanical checkpoint final known_total must be 0, got ${f.known_total}`);
  } else {
    errors.push(`unknown classification stage ${JSON.stringify(stage)}`);
  }
  return errors;
}

export function validateFairManifestProvenance({
  manifest,
  episodes,
  metaById,
  checkpointDir,
  checkpointById,
  exclusions,
  stats,
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  downstreamJudges = DEFAULT_DOWNSTREAM_JUDGES,
} = {}) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!asRecord(manifest)) return { ok: false, errors: ["manifest must be a JSON object"] };

  // ── producer inventory (fail-closed at the entry) ─────────────────────
  // The four-file dataset (episodes/meta/exclusions/stats) is an ATOMIC
  // input/relocation unit: the corpus, its meta sidecar, the terminal
  // exclusions and the build stats must form one consistent producer
  // inventory BEFORE any manifest-specific check. exclusions + stats are
  // REQUIRED — missing them is a hard error, never a skip. This replaces the
  // old missing_meta-only parity check: orphan meta is only legal as the
  // below-min terminal set recorded in exclusions + stats (an arbitrary
  // orphan — meta without a below-min exclusion, or a below-min exclusion
  // without meta — fails closed here).
  if (exclusions === undefined || stats === undefined) {
    fail("validateFairManifestProvenance requires exclusions + stats (the producer inventory)");
  } else {
    const inv = validateProducerInventory({ episodes, meta: metaById, exclusions, stats });
    for (const e of inv.errors) fail(e);
  }

  // ── strict top-level key set: exactly the real selector output keys ────
  // (buildManifest + t0-replay-select payload). Any extra top-level key is
  // rejected; generated_at/episodes/meta/concurrency are non-semantic but
  // must exist with the right type.
  const TOP_LEVEL_KEYS = [
    "schema_version", "kind", "generated_at", "protocol_hash", "thinking",
    "judge_models", "classifier_models", "downstream_judges", "classify",
    "counts", "exclusion_distribution", "cost", "selected", "excluded",
    "classifications", "episodes", "meta", "limit", "concurrency",
    "hard_only", "episode_ids",
  ];
  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.includes(key)) fail(`manifest top-level key ${JSON.stringify(key)} is not a selector-emitted key`);
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in manifest)) fail(`manifest top-level key ${JSON.stringify(key)} is missing`);
  }
  if (typeof manifest.generated_at !== "string" || !Number.isFinite(Date.parse(manifest.generated_at))) {
    fail("manifest generated_at must be an ISO timestamp string");
  }
  if (typeof manifest.episodes !== "string" || typeof manifest.meta !== "string") {
    fail("manifest episodes/meta must be path strings");
  }
  if (!Number.isInteger(manifest.concurrency) || manifest.concurrency < 1) {
    fail("manifest concurrency must be a positive integer");
  }

  // ── strict top-level identity ──────────────────────────────────────────
  if (manifest.kind !== "prompt_only_replay_selection") {
    fail(`manifest kind must be "prompt_only_replay_selection", got ${JSON.stringify(manifest.kind)}`);
  }
  if (manifest.schema_version !== FAIR_SELECT_SCHEMA_VERSION) {
    fail(`manifest schema_version must be ${FAIR_SELECT_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schema_version)}`);
  }
  if (manifest.classify !== true) fail(`manifest classify must be true, got ${JSON.stringify(manifest.classify)}`);
  if (manifest.hard_only !== false) fail(`manifest hard_only must be false, got ${JSON.stringify(manifest.hard_only)}`);
  if (manifest.limit !== null && manifest.limit !== undefined) fail(`manifest limit must be null (full production manifest), got ${JSON.stringify(manifest.limit)}`);
  if (manifest.protocol_hash !== classifierProtocolHash()) {
    fail("manifest protocol_hash does not match the current classifier protocol (stale manifest)");
  }
  // judge_models === classifier_models (the selector emits both from the same
  // dual-judge list); both must be exactly two distinct models and equal the
  // checkpoints' actual judge identity.
  const judgeModels = Array.isArray(manifest.classifier_models) ? manifest.classifier_models : null;
  if (!Array.isArray(manifest.judge_models)) fail("manifest judge_models must be an array");
  if (JSON.stringify(manifest.judge_models ?? null) !== JSON.stringify(judgeModels)) {
    fail("manifest judge_models must equal classifier_models");
  }
  try {
    requireExactlyTwoDistinctJudges(judgeModels, { label: "manifest classifier_models" });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // downstream_judges must equal the downstreamJudges the fresh scan used
  // (the selector normalizes through requireDownstreamJudges: 1..5 distinct).
  let downstream = null;
  try {
    downstream = requireDownstreamJudges(
      Array.isArray(downstreamJudges) && downstreamJudges.length ? downstreamJudges : DEFAULT_DOWNSTREAM_JUDGES,
      { label: "downstream-judges" },
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (downstream && JSON.stringify(manifest.downstream_judges ?? null) !== JSON.stringify(downstream)) {
    fail(`manifest downstream_judges ${JSON.stringify(manifest.downstream_judges)} != scan downstream ${JSON.stringify(downstream)}`);
  }
  const thinking = manifest.thinking ?? null;

  const hard = selectHardCandidates(episodes, metaById, {
    limit: undefined,
    strongRefs,
    specialists,
    downstreamJudges: downstream ?? DEFAULT_DOWNSTREAM_JUDGES,
  });
  const hardIds = new Set(hard.candidates.map((c) => c.episode.episode_id));

  const selectedArr = Array.isArray(manifest.selected) ? manifest.selected : [];
  const excludedArr = Array.isArray(manifest.excluded) ? manifest.excluded : [];
  const classificationsArr = Array.isArray(manifest.classifications) ? manifest.classifications : [];
  const episodeIds = Array.isArray(manifest.episode_ids) ? manifest.episode_ids : [];
  if (checkpointById !== undefined) {
    if (!(checkpointById instanceof Map)) {
      fail("checkpointById must be a Map when provided");
    } else {
      const expectedIds = classificationsArr.map((c) => c?.episode_id).filter((id) => typeof id === "string");
      if (checkpointById.size !== expectedIds.length) {
        fail(`checkpointById size ${checkpointById.size} != classifications.length ${expectedIds.length} (exact coverage required)`);
      }
      for (const id of expectedIds) {
        if (!checkpointById.has(id)) fail(`checkpointById is missing classification ${id}`);
      }
      for (const id of checkpointById.keys()) {
        if (!expectedIds.includes(id)) fail(`checkpointById has extra classification ${String(id)}`);
      }
    }
  } else if (checkpointDir) {
    // Directory-mode provenance: the leaf's DIRECT `.json` files must be
    // EXACTLY the classifications' ids (extra/missing `.json` files and
    // non-regular/symlink `.json` entries fail closed; archive subdirectories
    // and non-json auxiliary items are ignored) — the same exact-direct-json
    // closure loadExactJsonMap enforces on the build consumption side, so
    // selector publish and build consume the same inventory contract.
    const expectedNames = classificationsArr
      .map((c) => (typeof c?.episode_id === "string" ? `${c.episode_id}.json` : null))
      .filter((n) => n !== null)
      .sort();
    let actualNames = [];
    let readFailed = false;
    try {
      for (const entry of fs.readdirSync(checkpointDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".json")) continue; // non-json auxiliary / archive subdirs ignored
        if (!entry.isFile()) {
          fail(`checkpointDir ${checkpointDir}: ${entry.name} is not a regular file (non-regular/symlink checkpoint entries fail closed)`);
          continue;
        }
        actualNames.push(entry.name);
      }
    } catch (err) {
      readFailed = true;
      fail(`checkpointDir ${checkpointDir} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!readFailed) {
      actualNames.sort();
      if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        fail(`checkpointDir ${checkpointDir}: direct .json inventory must exactly cover the manifest classifications (got ${JSON.stringify(actualNames)}, expected ${JSON.stringify(expectedNames)})`);
      }
    }
  }

  // ── classifications: length, uniqueness, selector order ─────────────────
  if (classificationsArr.length !== hard.candidates.length) {
    fail(`classifications.length ${classificationsArr.length} != hard candidates ${hard.candidates.length}`);
  }
  const classIds = new Set();
  for (let i = 0; i < classificationsArr.length; i++) {
    const c = classificationsArr[i];
    const id = c?.episode_id;
    if (typeof id !== "string") {
      fail(`classifications[${i}]: missing episode_id`);
      continue;
    }
    if (classIds.has(id)) fail(`classifications: duplicate episode_id ${id}`);
    classIds.add(id);
    const expectedId = hard.candidates[i]?.episode.episode_id;
    if (id !== expectedId) {
      fail(`classifications[${i}].episode_id ${JSON.stringify(id)} != selector order ${JSON.stringify(expectedId)}`);
    }
  }

  // ── per-classification checkpoint provenance + body ─────────────────────
  // request_id uniqueness is enforced ACROSS the whole manifest: one global
  // set is shared by every checkpoint's ledger validation, so a request_id
  // reused by two checkpoints fails closed (each checkpoint alone stays
  // locally unique via the same set).
  const globalSeenRequestIds = new Set();
  const episodesById = new Map(episodes.map((e) => [e.episode_id, e]));
  const finalsById = new Map(); // episode_id -> validated checkpoint final
  const fromCheckpointById = new Map(); // episode_id -> classification row from_checkpoint (this run's source)
  for (const c of classificationsArr) {
    const id = c?.episode_id;
    if (typeof id !== "string") continue;
    const episode = episodesById.get(id);
    if (!episode) {
      fail(`classification ${id}: episode missing from corpus`);
      continue;
    }
    const cpFile = checkpointDir ? path.join(checkpointDir, `${id}.json`) : `${id}.json`;
    let cp;
    if (checkpointById !== undefined) {
      if (!(checkpointById instanceof Map) || !checkpointById.has(id)) {
        fail(`classification ${id}: checkpoint missing from checkpointById`);
        continue;
      }
      cp = checkpointById.get(id);
    } else {
      if (!fs.existsSync(cpFile)) {
        fail(`classification ${id}: checkpoint missing (${cpFile})`);
        continue;
      }
      try {
        cp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
      } catch {
        fail(`classification ${id}: checkpoint is not valid JSON`);
        continue;
      }
    }
    if (!asRecord(cp) || !asRecord(cp.final)) {
      fail(`classification ${id}: checkpoint has no final record`);
      continue;
    }
    // Ledger-format binding: only checkpoints written under the CURRENT
    // ATTEMPT_LEDGER_VERSION are admissible — old checkpoints (no request_id
    // identity in their attempt logs) must never mix into a new manifest.
    if (cp.ledger_version !== ATTEMPT_LEDGER_VERSION) {
      fail(`classification ${id}: checkpoint ledger_version ${JSON.stringify(cp.ledger_version)} != current ${ATTEMPT_LEDGER_VERSION} (stale checkpoint)`);
      continue;
    }
    const pHash = promptHash(episode.prompt);
    const finalCheck = validateFinalClassification(cp.final, {
      prompt_hash: pHash,
      protocol_hash: classifierProtocolHash(),
      judge_models: judgeModels,
      thinking,
      episode_id: id,
    });
    if (!finalCheck.ok) {
      fail(`classification ${id}: checkpoint final invalid (${finalCheck.errors.join("; ")})`);
      continue;
    }
    // Fail-closed state contract: ONLY completed checkpoints may enter the
    // finals rebuild. A failed checkpoint (any judge without a valid
    // judgment) is a diagnostic artifact — it must never be admitted into
    // selected/excluded/counts, and a manifest built over it is rejected.
    if (cp.final.classification_status !== "completed") {
      fail(`classification ${id}: checkpoint classification_status must be completed (failed checkpoints never enter finals rebuild), got ${JSON.stringify(cp.final.classification_status)}`);
      continue;
    }
    if (cp.prompt_hash !== pHash) fail(`classification ${id}: checkpoint prompt_hash does not match the real episode prompt`);
    if (cp.protocol_hash !== classifierProtocolHash()) fail(`classification ${id}: checkpoint protocol_hash is stale`);
    if (JSON.stringify(cp.judge_models ?? null) !== JSON.stringify(judgeModels)) fail(`classification ${id}: checkpoint judge_models != manifest classifier_models`);
    if (cp.thinking !== thinking) fail(`classification ${id}: checkpoint thinking != manifest thinking`);
    const f = cp.final;
    // Manifest row vs checkpoint final (the fields the manifest row carries).
    // from_checkpoint is the SOURCE of this run (true on a legal resume), NOT
    // a checkpoint-final field — the stored final always records the original
    // run (false). The row must be a boolean; selected/excluded rows must
    // carry the SAME value as the classification row.
    if (typeof c.from_checkpoint !== "boolean") fail(`classification ${id}: from_checkpoint must be a boolean, got ${JSON.stringify(c.from_checkpoint)}`);
    if (c.stage !== f.stage) fail(`classification ${id}: stage ${JSON.stringify(c.stage)} != checkpoint final ${JSON.stringify(f.stage)}`);
    if (c.replayable !== f.replayable) fail(`classification ${id}: replayable ${c.replayable} != checkpoint final ${f.replayable}`);
    if (JSON.stringify(c.reasons) !== JSON.stringify(f.reasons)) fail(`classification ${id}: reasons differ from checkpoint final`);
    if (c.confidence !== f.confidence) fail(`classification ${id}: confidence ${c.confidence} != checkpoint final ${f.confidence}`);
    if (c.join_confidence !== null) fail(`classification ${id}: join_confidence must be null (the checkpoint final carries no join field), got ${JSON.stringify(c.join_confidence)}`);
    if (c.cost !== f.cost) fail(`classification ${id}: cost ${c.cost} != checkpoint final ${f.cost}`);
    if (c.cost_source !== f.cost_source) fail(`classification ${id}: cost_source ${c.cost_source} != checkpoint final ${f.cost_source}`);
    if (!jsonSemanticEqual(c.cost_breakdown ?? null, f.cost_breakdown ?? null)) fail(`classification ${id}: cost_breakdown differs from checkpoint final`);
    // Classification row key closure: exactly the 10 selector-emitted keys.
    const expectedRowKeys = ["episode_id", "stage", "replayable", "reasons", "confidence", "join_confidence", "cost", "cost_source", "cost_breakdown", "from_checkpoint"];
    for (const key of Object.keys(c)) {
      if (!expectedRowKeys.includes(key)) fail(`classification ${id}: ${JSON.stringify(key)} is not a selector-emitted classification field`);
    }
    for (const key of expectedRowKeys) {
      if (!(key in c)) fail(`classification ${id}: classification row is missing ${JSON.stringify(key)}`);
    }
    // Checkpoint-final-only fields (not in the manifest row).
    if (typeof f.has_unknown_cost !== "boolean") fail(`classification ${id}: checkpoint final has_unknown_cost must be a boolean`);
    if (typeof f.known_total !== "number" || !Number.isFinite(f.known_total)) fail(`classification ${id}: checkpoint final known_total must be a number`);
    if (typeof f.attempts !== "number" || !Number.isFinite(f.attempts)) fail(`classification ${id}: checkpoint final attempts must be a number`);
    if (typeof f.cost === "number" && f.known_total !== f.cost) fail(`classification ${id}: checkpoint final known_total ${f.known_total} != cost ${f.cost}`);
    // Checkpoint body per the real schema (judgments/attempt_log for llm,
    // mechanical object for mechanical) — recomputed from the producer's own
    // pure functions (mergeDualJudgments / summarizeClassifierCosts /
    // mechanicalExclude), never hand-written approximations.
    for (const e of validateCheckpointBody(cp, f, { id, judgeModels, prompt: episode.prompt, seenRequestIds: globalSeenRequestIds })) {
      fail(`classification ${id}: ${e}`);
    }
    finalsById.set(id, f);
    fromCheckpointById.set(id, c.from_checkpoint === true);
  }

  // ── selected: rebuild the COMPLETE expected rows from hard.candidates +
  // checkpoint finals via the SAME shared row construction the producer uses
  // (buildSelectedRow + compareSelectedRows) — the validator never
  // hand-writes an approximate row. from_checkpoint comes from the
  // classification row (this run's source), not the stored final.
  const expectedSelected = [];
  for (const candidate of hard.candidates) {
    const id = candidate.episode.episode_id;
    const f = finalsById.get(id);
    if (!f) continue; // checkpoint already failed above
    if (f.replayable !== true) continue;
    expectedSelected.push(buildSelectedRow(candidate, {
      ...f,
      from_checkpoint: fromCheckpointById.get(id) === true,
    }));
  }
  expectedSelected.sort(compareSelectedRows);
  if (selectedArr.length !== expectedSelected.length) {
    fail(`selected.length ${selectedArr.length} != expected ${expectedSelected.length}`);
  }
  for (const s of selectedArr) {
    if (!hardIds.has(s?.episode_id)) fail(`selected ${s?.episode_id} is not a hard-pass episode`);
  }
  for (let i = 0; i < expectedSelected.length; i++) {
    const exp = expectedSelected[i];
    const got = selectedArr[i];
    if (!asRecord(got)) {
      fail(`selected[${i}] must be an object`);
      continue;
    }
    for (const key of Object.keys(exp)) {
      if (!jsonSemanticEqual(got[key], exp[key])) {
        fail(`selected[${i}].${key} ${JSON.stringify(got[key])} != selector construction ${JSON.stringify(exp[key])}`);
      }
    }
    for (const key of Object.keys(got)) {
      if (!(key in exp)) fail(`selected[${i}].${key} is not a selector-emitted field`);
    }
  }
  if (episodeIds.length !== expectedSelected.length) fail(`episode_ids.length ${episodeIds.length} != expected selected ${expectedSelected.length}`);
  for (let i = 0; i < expectedSelected.length; i++) {
    if (episodeIds[i] !== expectedSelected[i].episode_id) {
      fail(`episode_ids[${i}] ${JSON.stringify(episodeIds[i])} != expected selected order ${JSON.stringify(expectedSelected[i].episode_id)}`);
    }
  }

  // ── excluded: rebuild the FULL expected array (hard exclusions in corpus
  // order + non-replayable classification rows in hard-candidate order) ───
  const expectedExcluded = hard.excluded.map((e) => ({
    episode_id: e.episode_id,
    stage: "hard",
    reasons: e.reasons,
    join_confidence: e.join_confidence,
  }));
  for (const candidate of hard.candidates) {
    const id = candidate.episode.episode_id;
    const f = finalsById.get(id);
    if (!f) continue;
    if (f.replayable === true) continue;
    expectedExcluded.push(buildExcludedRow(candidate, {
      ...f,
      from_checkpoint: fromCheckpointById.get(id) === true,
    }));
  }
  if (excludedArr.length !== expectedExcluded.length) {
    fail(`excluded.length ${excludedArr.length} != expected ${expectedExcluded.length}`);
  }
  for (let i = 0; i < expectedExcluded.length; i++) {
    const exp = expectedExcluded[i];
    const got = excludedArr[i];
    if (!asRecord(got)) {
      fail(`excluded[${i}] must be an object`);
      continue;
    }
    for (const key of Object.keys(exp)) {
      if (!jsonSemanticEqual(got[key], exp[key])) {
        fail(`excluded[${i}].${key} ${JSON.stringify(got[key])} != selector construction ${JSON.stringify(exp[key])}`);
      }
    }
    for (const key of Object.keys(got)) {
      if (!(key in exp)) fail(`excluded[${i}].${key} is not a selector-emitted field`);
    }
  }

  // ── counts: rebuild every selector-emitted count and compare ───────────
  const expectedCounts = {
    source: episodes.length,
    hard_pass: hard.hard_pass_count,
    hard_pass_limited: hard.candidates.length,
    classified: classificationsArr.length,
    replayable: expectedSelected.length,
    excluded: expectedExcluded.length,
    data_insufficient: expectedSelected.length < 2,
    join_hard_pass: { ...hard.join_tier },
    join_selected: { exact: 0, heuristic: 0 },
  };
  for (const s of expectedSelected) {
    if (s.join_confidence === "exact") expectedCounts.join_selected.exact += 1;
    else if (s.join_confidence === "heuristic") expectedCounts.join_selected.heuristic += 1;
  }
  const counts = asRecord(manifest.counts) ? manifest.counts : {};
  for (const key of Object.keys(expectedCounts)) {
    if (JSON.stringify(counts[key]) !== JSON.stringify(expectedCounts[key])) {
      fail(`counts.${key} ${JSON.stringify(counts[key])} != selector output ${JSON.stringify(expectedCounts[key])}`);
    }
  }
  for (const key of Object.keys(counts)) {
    if (!(key in expectedCounts)) fail(`counts.${key} is not a selector-emitted count`);
  }

  // ── top-level cost: deterministically rebuilt from the classification
  // finals via the SAME pure helper the producer uses (buildManifestCostSummary)
  // and deep-compared — a forged/derived cost summary cannot pass. ──────────
  const expectedCostBreakdown = emptyCostBreakdown();
  let expectedKnownTotal = 0;
  let expectedHasUnknown = false;
  for (const f of finalsById.values()) {
    accumulateCostBreakdown(expectedCostBreakdown, f);
    if (typeof f.known_total === "number") expectedKnownTotal += f.known_total;
    else if (typeof f.cost === "number") expectedKnownTotal += f.cost;
    if (f.has_unknown_cost === true || f.cost === null) expectedHasUnknown = true;
  }
  const expectedCost = buildManifestCostSummary({
    cost_breakdown: expectedCostBreakdown,
    known_total: expectedKnownTotal,
    has_unknown_cost: expectedHasUnknown,
  });
  if (!jsonSemanticEqual(manifest.cost ?? null, expectedCost)) {
    fail(`manifest cost does not match the classification finals (expected ${JSON.stringify(expectedCost)})`);
  }

  // ── exclusion_distribution: rebuild from the fresh hard distribution +
  // non-replayable classification reasons per the selector's exact rule ───
  const expectedDist = { ...hard.distribution };
  for (const candidate of hard.candidates) {
    const id = candidate.episode.episode_id;
    const f = finalsById.get(id);
    if (!f) continue;
    if (f.replayable === true) continue;
    const stage = f.stage === "mechanical" ? "mechanical" : "llm";
    for (const reason of f.reasons ?? []) {
      const key = reason.startsWith("mechanical_") || reason.startsWith("dual_judge_")
        || reason.startsWith("either_") || reason.startsWith("judge_")
        ? reason
        : `${stage}_excluded`;
      expectedDist[key] = (expectedDist[key] ?? 0) + 1;
    }
    expectedDist[`${stage}_total`] = (expectedDist[`${stage}_total`] ?? 0) + 1;
  }
  const dist = asRecord(manifest.exclusion_distribution) ? manifest.exclusion_distribution : {};
  for (const key of Object.keys(expectedDist)) {
    if (dist[key] !== expectedDist[key]) {
      fail(`exclusion_distribution.${key} ${dist[key]} != selector output ${expectedDist[key]}`);
    }
  }
  for (const key of Object.keys(dist)) {
    if (!(key in expectedDist)) fail(`exclusion_distribution.${key} is not a selector-emitted key`);
  }

  return { ok: errors.length === 0, errors };
}

// ── mechanical hard exclude ───────────────────────────────────────────────

/**
 * Mechanical fail-closed patterns: ONLY prompts that clearly demand external
 * repo/file-path access, command/test execution, or live-state inspection.
 *
 * High precision. Do NOT match embedded-content review such as:
 *   - "Review the following embedded code"
 *   - "review following embedded code/file content"
 *   - "以下代码" / "请审阅以下嵌入的文件内容"
 *
 * Ambiguous cases remain for the dual LLM judges.
 */
export const MECHANICAL_EXCLUDE_PATTERNS = [
  {
    reason: "mechanical_requires_files",
    // Absolute unix/home paths (external filesystem).
    re: /(?:^|[\s'"(\[]|【)(?:\/home\/|\/Users\/|\/tmp\/|\/var\/|\/etc\/|~\/)[^\s'"]+/,
  },
  {
    reason: "mechanical_requires_files",
    // Explicit external path-read verbs (not "embedded file content").
    re: /(?:读取|打开|检查|审阅)\s*(?:仓库|工作区|本地|磁盘|外部).{0,20}(?:文件|源码|路径)|(?:read|open|inspect|check)\s+(?:the\s+)?(?:file|path)\s+(?:at|from)\s+/i,
  },
  {
    reason: "mechanical_requires_commands",
    re: /(?:运行|执行|跑)\s*(?:一下)?\s*(?:命令|测试|smoke|npm|脚本|单元测试|集成测试)|(?:run|execute)\s+(?:the\s+)?(?:command|test|smoke|npm|script|unit\s+tests?|integration\s+tests?)\b|npm\s+run\b|node\s+scripts\/|pytest\b|cargo\s+test\b/i,
  },
  {
    reason: "mechanical_requires_live_repo_state",
    re: /(?:当前|现有|实际|实时)\s*(?:仓库|代码|diff|状态|工作区|工作树)|(?:current|existing|actual|live)\s+(?:repo|repository|diff|state|workspace|codebase|worktree)\b|git\s+(?:status|diff|log|show)\b|review\s+(?:the\s+)?(?:actual\s+)?current\s+diff\b/i,
  },
  {
    reason: "mechanical_requires_workspace",
    re: /(?:在)?(?:工作区|仓库内|代码树)\s*(?:中|里)?\s*(?:查看|检查|阅读|打开|核实)|(?:in\s+the\s+(?:repo|repository|workspace|codebase))\b|working\s+tree|check\s+out\s+the\s+code|clone\s+the\s+(?:repo|repository)/i,
  },
];

/** Documented positive fixtures (must mechanical-exclude). */
export const MECHANICAL_POSITIVE_EXAMPLES = [
  "请阅读 /home/worker/.pi/agent/skills/pi-astack/docs/adr/0040.md 与当前代码，判断是否授权。",
  "Run npm run smoke:t0-eval and report whether all checks pass.",
  "Review current git status and the live workspace diff.",
  "Open the file at /tmp/repro/main.ts and verify the export.",
  "请在工作区中查看实现是否与草案一致。",
];

/** Documented negative fixtures (must NOT mechanical-exclude). */
export const MECHANICAL_NEGATIVE_EXAMPLES = [
  "Review the following embedded code and reply SIGN or REVISE.\n\n```js\nexport const x = 1;\n```",
  "review following embedded code/file content:\n\nfile content here",
  "请审阅以下代码，给出是否签署的判断。\n\nfunction foo() { return 1; }",
  "请审阅以下嵌入的文件内容，只基于文中材料裁决。\n\n--- file: policy.md ---\n# Policy\n...",
  "Based on the quoted consensus text only, decide SIGN or REVISE.",
];

/**
 * Scan a prompt for mechanical hard-exclude signals. Returns
 * { excluded, reasons[], matches[] }.
 */
export function mechanicalExclude(prompt) {
  const text = String(prompt ?? "");
  const reasons = [];
  const matches = [];
  for (const { reason, re } of MECHANICAL_EXCLUDE_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      reasons.push(reason);
      matches.push({ reason, match: m[0].slice(0, 120) });
    }
  }
  return { excluded: reasons.length > 0, reasons: [...new Set(reasons)], matches };
}

// ── classifier judgment normalization / dual-judge merge ──────────────────

export function requireFlags(judgment) {
  return {
    requires_workspace: judgment?.requires_workspace === true,
    requires_files: judgment?.requires_files === true,
    requires_commands: judgment?.requires_commands === true,
    requires_live_external_state: judgment?.requires_live_external_state === true,
    requires_tool_verification: judgment?.requires_tool_verification === true,
  };
}

export function anyRequireTrue(flags) {
  return Object.values(flags).some(Boolean);
}

/**
 * Normalize + validate a single judge's structured output. Fail-closed on
 * schema/inconsistency: if any requires_* is true, replayable is forced false.
 */
export function normalizeClassifierJudgment(raw) {
  const base = validateSchema(raw, CLASSIFIER_OUTPUT_SCHEMA);
  if (!base.ok) {
    return { ok: false, errors: base.errors, judgment: null };
  }
  if (raw.schema_version !== CLASSIFIER_SCHEMA_VERSION) {
    return { ok: false, errors: [`schema_version must be ${CLASSIFIER_SCHEMA_VERSION}`], judgment: null };
  }
  if (typeof raw.confidence !== "number" || !(raw.confidence >= 0 && raw.confidence <= 1)) {
    return { ok: false, errors: ["confidence must be a number in [0,1]"], judgment: null };
  }
  if (!Array.isArray(raw.reasons) || raw.reasons.length === 0 || raw.reasons.some((r) => typeof r !== "string" || !r.trim())) {
    return { ok: false, errors: ["reasons must be a non-empty string array"], judgment: null };
  }
  const flags = requireFlags(raw);
  let replayable = raw.replayable === true;
  const forced = [];
  if (anyRequireTrue(flags) && replayable) {
    replayable = false;
    forced.push("requires_true_forces_non_replayable");
  }
  return {
    ok: true,
    errors: [],
    judgment: {
      schema_version: CLASSIFIER_SCHEMA_VERSION,
      replayable,
      ...flags,
      reasons: raw.reasons.map((r) => r.trim()),
      confidence: raw.confidence,
      ...(forced.length ? { normalized: forced } : {}),
    },
  };
}

/**
 * Dual-judge merge: either non-replayable → exclude; disagreement on
 * replayable → fail-closed exclude. Requires_* disagreement that would
 * change the outcome is also fail-closed.
 *
 * Public dual-judge entry: enforces exactly two judgment inputs.
 */
export function mergeDualJudgments(j0, j1, { judge0, judge1 } = {}) {
  // Reject accidental third-arg misuse: only two judgments accepted.
  if (arguments.length > 3) {
    throw new Error("mergeDualJudgments: third judgment rejected — dual-judge only");
  }
  if (judge0 && judge1 && judge0 === judge1) {
    throw new Error("mergeDualJudgments: judge0 and judge1 must be distinct");
  }
  const reasons = [];
  if (!j0?.ok || !j1?.ok) {
    return {
      ok: false,
      replayable: false,
      reasons: ["judge_output_invalid", ...(j0?.errors ?? []), ...(j1?.errors ?? [])],
      disagreement: true,
      confidence: 0,
      flags: null,
    };
  }
  const a = j0.judgment;
  const b = j1.judgment;
  const disagreeReplayable = a.replayable !== b.replayable;
  if (disagreeReplayable) {
    reasons.push("dual_judge_disagreement_replayable");
  }
  for (const key of Object.keys(requireFlags(a))) {
    if (a[key] !== b[key]) reasons.push(`dual_judge_disagreement_${key}`);
  }
  const eitherNon = a.replayable === false || b.replayable === false;
  const disagreement = reasons.length > 0;
  const replayable = !eitherNon && !disagreement && a.replayable === true && b.replayable === true;
  if (eitherNon) reasons.push("either_judge_non_replayable");
  if (!replayable && reasons.length === 0) reasons.push("not_replayable");
  const flags = {
    requires_workspace: a.requires_workspace || b.requires_workspace,
    requires_files: a.requires_files || b.requires_files,
    requires_commands: a.requires_commands || b.requires_commands,
    requires_live_external_state: a.requires_live_external_state || b.requires_live_external_state,
    requires_tool_verification: a.requires_tool_verification || b.requires_tool_verification,
  };
  return {
    ok: true,
    replayable,
    reasons: [...new Set([
      ...reasons,
      ...a.reasons.map((r) => `${judge0 ?? "judge0"}: ${r}`),
      ...b.reasons.map((r) => `${judge1 ?? "judge1"}: ${r}`),
    ])],
    disagreement,
    confidence: Math.min(a.confidence, b.confidence),
    flags,
    judgments: { [judge0 ?? "judge0"]: a, [judge1 ?? "judge1"]: b },
  };
}

// ── cost helpers ──────────────────────────────────────────────────────────

/**
 * Flatten dual-judge attempt logs into a single attempt array and summarize
 * via summarizeCosts. Unknown costs are tracked in breakdown.unknown and
 * never silently coerced into a fake zero total: when any attempt lacks a
 * numeric cost, `cost` is null and `has_unknown` is true.
 */
export function summarizeClassifierCosts(attemptLogsByModel) {
  const flat = [];
  if (attemptLogsByModel && typeof attemptLogsByModel === "object") {
    for (const log of Object.values(attemptLogsByModel)) {
      if (Array.isArray(log)) flat.push(...log);
    }
  }
  const summary = summarizeCosts(flat);
  const has_unknown = flat.some((a) => typeof a?.cost !== "number")
    || summary.cost_source === "unknown"
    || (summary.cost_breakdown?.unknown > 0 && flat.some((a) => (a?.cost_source ?? "unknown") === "unknown" && typeof a?.cost !== "number"));
  // Prefer provider/estimated numeric totals; if any attempt has null cost,
  // do not pretend the total is a complete known figure.
  const anyNullCost = flat.some((a) => typeof a?.cost !== "number");
  return {
    cost: anyNullCost ? null : summary.cost,
    cost_source: summary.cost_source,
    cost_breakdown: summary.cost_breakdown,
    has_unknown: anyNullCost || has_unknown,
    known_total: summary.cost,
  };
}

export function emptyCostBreakdown() {
  return { provider: 0, estimated: 0, unknown: 0 };
}

export function accumulateCostBreakdown(into, part) {
  const src = part?.cost_breakdown ?? emptyCostBreakdown();
  into.provider += src.provider ?? 0;
  into.estimated += src.estimated ?? 0;
  into.unknown += src.unknown ?? 0;
  return into;
}

// ── shared manifest row construction (producer + validator use ONE code path) ─
//
// The real selector (selectFairReplayEpisodes / buildManifest) and the
// provenance validator (validateFairManifestProvenance) build every manifest
// row from these SAME helpers — the validator never hand-writes an
// approximate row, so producer and validator can never drift apart.

/**
 * Classification manifest row — the fixed strict 10-key set emitted by the
 * real selector: episode_id, stage, replayable, reasons, confidence,
 * join_confidence, cost, cost_source, cost_breakdown, from_checkpoint.
 * join_confidence is null (the checkpoint final carries no join field; the
 * selector emits join only on selected/excluded rows).
 */
export function buildClassificationRow(final, { join_confidence = null } = {}) {
  return {
    episode_id: final.episode_id,
    stage: final.stage,
    replayable: final.replayable,
    reasons: final.reasons,
    confidence: final.confidence,
    join_confidence: join_confidence ?? null,
    cost: final.cost,
    cost_source: final.cost_source ?? null,
    cost_breakdown: final.cost_breakdown ?? null,
    from_checkpoint: final.from_checkpoint === true,
  };
}

/** Selected row — the real selector's exact construction. */
export function buildSelectedRow(candidate, final) {
  return {
    episode_id: candidate.episode.episode_id,
    models: candidate.models,
    join_confidence: candidate.join_confidence,
    tools: candidate.episode.tools,
    stage: final.stage,
    replayable: true,
    confidence: final.confidence,
    reasons: final.reasons,
    flags: final.flags ?? null,
    cost: final.cost,
    cost_source: final.cost_source,
    cost_breakdown: final.cost_breakdown,
    from_checkpoint: final.from_checkpoint === true,
  };
}

/** Non-hard excluded row (llm/mechanical classification exclusion). */
export function buildExcludedRow(candidate, final) {
  const stage = final.stage === "mechanical" ? "mechanical" : "llm";
  return {
    episode_id: candidate.episode.episode_id,
    stage,
    reasons: final.reasons,
    join_confidence: candidate.join_confidence,
    confidence: final.confidence,
    flags: final.flags ?? null,
    cost: final.cost,
    cost_source: final.cost_source,
    from_checkpoint: final.from_checkpoint === true,
  };
}

/** Selected sort: exact join first, then confidence desc, then episode_id asc. */
export function compareSelectedRows(a, b) {
  const ae = a.join_confidence === "exact" ? 1 : 0;
  const be = b.join_confidence === "exact" ? 1 : 0;
  if (be !== ae) return be - ae;
  const ac = typeof a.confidence === "number" ? a.confidence : 0;
  const bc = typeof b.confidence === "number" ? b.confidence : 0;
  if (bc !== ac) return bc - ac;
  return a.episode_id < b.episode_id ? -1 : a.episode_id > b.episode_id ? 1 : 0;
}

/**
 * Top-level manifest `cost` summary — deterministic from the accumulated
 * classification cost_breakdown + known_total + has_unknown_cost. Shared by
 * the producer (buildManifest) and the validator (which rebuilds it from the
 * classification finals and deep-compares).
 */
export function buildManifestCostSummary({ cost_breakdown, known_total, has_unknown_cost }) {
  const sources = [];
  if ((cost_breakdown.provider ?? 0) > 0) sources.push("provider");
  if ((cost_breakdown.estimated ?? 0) > 0) sources.push("estimated");
  if ((cost_breakdown.unknown ?? 0) > 0 || has_unknown_cost) sources.push("unknown");
  let cost_source = null;
  if (sources.length === 1) cost_source = sources[0];
  else if (sources.length > 1) cost_source = "mixed";
  return {
    // Numeric total only when every attempt cost is known; otherwise null
    // so callers never treat unknown as 0.
    total: has_unknown_cost ? null : known_total,
    known_total,
    has_unknown: has_unknown_cost,
    currency: "USD",
    source: cost_source,
    breakdown: {
      provider: cost_breakdown.provider ?? 0,
      estimated: cost_breakdown.estimated ?? 0,
      unknown: cost_breakdown.unknown ?? 0,
    },
    note: "classifier costs via summarizeCosts; provider/estimated/unknown breakdown; unknown never coerced into a fake zero total",
  };
}

// ── single-judge LLM call ─────────────────────────────────────────────────

/**
 * One classifier judge call with bounded content retry. The judge sees ONLY
 * the anonymous prompt (no tools beyond structured-output submit tool).
 *
 * Provider-call accounting: the actual request entries in each
 * `callJudge(maxRetries:0)` result's `attempt_log` are the SOLE provider-call
 * fact (0 or 1 per call). Each real entry keeps its request_id/usage/cost/
 * cost_source/error_class; the classifier layer attaches the parse/schema/
 * normalization outcome to the SAME entry — it never creates a new entry that
 * drops request_id. Pre-request failures (invalid ref / model not found /
 * auth — callJudge returns an empty ledger) return immediately with
 * attempts=0 and an empty attempt_log: the failure is deterministic, so
 * corrective/transport retries cannot help, and it is NOT a provider request
 * / unknown-cost attempt.
 */
export async function runClassifierJudge(invoker, modelRef, prompt, {
  maxRetries = CLASSIFIER_DEFAULT_MAX_RETRIES,
  timeoutMs = CLASSIFIER_DEFAULT_TIMEOUT_MS,
  thinking = CLASSIFIER_DEFAULT_THINKING,
  operation = "t0_replay_fair_classify",
} = {}) {
  const tool = buildClassifierTool();
  const attemptLog = [];
  let contentFailed = false;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const hint = contentFailed
      ? "\n\nYour previous response was not accepted. Reply with ONE valid JSON object matching the schema exactly. If any requires_* is true, replayable must be false."
      : "";
    const userContent = `${CLASSIFIER_USER_PROTOCOL}\n\n## Anonymous task prompt\n\n${prompt}${hint}`;
    const result = await callJudge(invoker, modelRef, CLASSIFIER_SYSTEM_PROMPT, userContent, {
      maxRetries: 0,
      timeoutMs,
      operation,
      module: "t0-replay-fair",
      tool,
      reasoning: thinking,
    });
    // Pre-request failure (invalid ref / model not found / auth): NO actual
    // provider request was made (empty ledger). The failure is deterministic
    // — retrying cannot help — so return immediately with attempts=0 and an
    // empty ledger (no fake unknown entries, no meaningless corrective retry).
    if (result.attempt_log.length === 0) {
      return {
        ok: false,
        modelRef,
        error: result.error ?? "pre-request failure",
        judgment: null,
        attempts: 0,
        attempt_log: [],
        cost: null,
        cost_source: null,
        cost_breakdown: emptyCostBreakdown(),
      };
    }
    // The actual request entries in result.attempt_log are the SOLE
    // provider-call fact (0 or 1 with maxRetries:0). Each keeps its
    // request_id/usage/cost/cost_source/error_class; the classifier layer
    // attaches the parse/schema/normalization outcome to the SAME entry.
    for (const entry of result.attempt_log) {
      let parsed = result.structured && result.parsed ? result.parsed : null;
      if (!parsed && entry.ok && typeof result.text === "string") {
        const extracted = parseJsonOutput(result.text);
        parsed = extracted.parsed;
      }
      if (!entry.ok || !parsed) {
        const err = entry.error ?? "unparseable classifier output";
        attemptLog.push({
          ...entry,
          ok: false,
          error: err,
          error_class: entry.error_class ?? "content",
          raw_output: summarizeFailedOutput(result),
        });
        lastError = err;
        if (entry.error_class === "transport") {
          if (attempt < maxRetries) await sleep(2_000 * 2 ** attempt + Math.floor(Math.random() * 500));
          continue;
        }
        contentFailed = true;
        continue;
      }
      const normalized = normalizeClassifierJudgment(parsed);
      if (!normalized.ok) {
        attemptLog.push({
          ...entry,
          ok: false,
          error: normalized.errors.join("; "),
          error_class: "content",
          raw_output: summarizeFailedOutput(result),
        });
        lastError = normalized.errors.join("; ");
        contentFailed = true;
        continue;
      }
      attemptLog.push({
        ...entry,
        ok: true,
        error: null,
        error_class: null,
        // The accepted output hash binds this request to the semantic
        // judgment that was actually accepted (sha256 of the normalized
        // judgment) — a relabelled/forged judgment can never pass the
        // family validator's hash equality.
        accepted_output_hash: sha256Hex(JSON.stringify(normalized.judgment)),
      });
      const costSummary = summarizeCosts(attemptLog);
      return {
        ok: true,
        modelRef,
        judgment: normalized.judgment,
        attempts: attemptLog.length,
        attempt_log: attemptLog,
        cost: costSummary.cost,
        cost_source: costSummary.cost_source,
        cost_breakdown: costSummary.cost_breakdown,
      };
    }
  }
  const costSummary = summarizeCosts(attemptLog);
  return {
    ok: false,
    modelRef,
    error: lastError ?? "classifier judge failed",
    judgment: null,
    attempts: attemptLog.length,
    attempt_log: attemptLog,
    cost: costSummary.cost,
    cost_source: costSummary.cost_source,
    cost_breakdown: costSummary.cost_breakdown,
  };
}

// ── checkpoint ────────────────────────────────────────────────────────────

/**
 * Checkpoint ROOT → LEAF helper: the classifier checkpoint leaf directory
 * under a checkpoint ROOT. Every checkpoint read/write resolves through this
 * single helper (classifierCheckpointPath), so the root/leaf split can never
 * drift: the ROOT is the directory the selector owns (--checkpoint-dir or the
 * derived same-dir `checkpoints-fair`), the LEAF is `root/checkpoints` and
 * holds the `<episode_id>.json` files directly. Provenance consumers
 * (validateFairManifestProvenance / publishSelectionManifest) take the LEAF
 * as their checkpointDir parameter — never the root.
 */
export function classifierCheckpointDir(outputDir) {
  return path.join(outputDir, "checkpoints");
}

export function classifierCheckpointPath(outputDir, episodeId) {
  // The episode id becomes a filename component — the safe-id contract is
  // enforced here so a traversal id (`../`, path separators, NUL, "." / "..")
  // can never escape the checkpoint leaf; every read/write routes through this
  // function and is rejected BEFORE any file is created or touched.
  assertSafeEpisodeId(episodeId, { label: "classifierCheckpointPath episode_id" });
  return path.join(classifierCheckpointDir(outputDir), `${episodeId}.json`);
}

/**
 * Validate a checkpoint final payload against FINAL_CLASSIFICATION_SCHEMA
 * plus dual-judge / hash binding invariants.
 */
export function validateFinalClassification(final, {
  prompt_hash,
  protocol_hash,
  judge_models,
  thinking,
  episode_id,
  schema_version = FAIR_SELECT_SCHEMA_VERSION,
} = {}) {
  if (!asRecord(final)) return { ok: false, errors: ["final_not_object"] };
  const base = validateSchema(final, FINAL_CLASSIFICATION_SCHEMA);
  if (!base.ok) return { ok: false, errors: base.errors };
  const errors = [];
  if (final.schema_version !== schema_version) errors.push("schema_version_mismatch");
  if (episode_id && final.episode_id !== episode_id) errors.push("episode_id_mismatch");
  if (prompt_hash && final.prompt_hash !== prompt_hash) errors.push("prompt_hash_mismatch");
  if (protocol_hash && final.protocol_hash !== protocol_hash) errors.push("protocol_hash_mismatch");
  if (thinking && final.thinking !== thinking) errors.push("thinking_mismatch");
  try {
    requireExactlyTwoDistinctJudges(final.judge_models, { label: "final.judge_models" });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (judge_models && JSON.stringify(final.judge_models) !== JSON.stringify(judge_models)) {
    errors.push("judge_models_mismatch");
  }
  if (typeof final.replayable !== "boolean") errors.push("replayable_not_boolean");
  if (!Array.isArray(final.reasons)) errors.push("reasons_not_array");
  if (!asRecord(final.cost_breakdown)) errors.push("cost_breakdown_missing");
  return { ok: errors.length === 0, errors };
}

/**
 * lstat probe for the checkpoint lifecycle: the DIRECT target is stat'ed
 * (never followed), so a symlink — including a broken one — is an EXISTING
 * entry, never a cache miss. ENOENT is the ONLY "missing" signal; any other
 * stat error fails closed (an unreadable checkpoint entry must never be
 * treated as absent and never overwritten). Returns { existing: false } or
 * { existing: true, isFile, isSymbolicLink }.
 */
function probeCheckpointEntry(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return { existing: false };
    throw new Error(
      `t0-replay-fair: cannot stat checkpoint ${file}: ${err instanceof Error ? err.message : String(err)} `
      + "(fail-closed: an unreadable checkpoint entry is never a cache miss and is never overwritten)",
    );
  }
  return { existing: true, isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink() };
}

export function loadClassifierCheckpoint(outputDir, episodeId, {
  prompt_hash,
  protocol_hash,
  judge_models,
  thinking,
  prompt,
  schema_version = FAIR_SELECT_SCHEMA_VERSION,
  seenRequestIds = null,
}) {
  const file = classifierCheckpointPath(outputDir, episodeId);
  // Fail-closed lifecycle: an EXISTING checkpoint is never a cache miss and
  // never silently overwritten. Anything that is not a valid `completed`
  // checkpoint under the CURRENT contract throws a clear error BEFORE any
  // invoker/provider call — the recorded facts/cost on disk are never
  // ignored and never duplicated by a re-call.
  const refuse = (why) => {
    throw new Error(
      `t0-replay-fair: existing checkpoint ${file} (episode ${episodeId}) is ${why} — `
      + `it is NOT a cache miss and will NOT be overwritten. Archive/move the checkpoint `
      + `out of the active directory (preserving the recorded facts/cost) or use a fresh checkpoint dir before re-running.`,
    );
  };
  // lstat the DIRECT target: ENOENT is the only cache miss; any other stat
  // error fails closed above. An existing entry must be a REGULAR file — a
  // symlink (including broken), directory or any other non-regular entry is
  // refused BEFORE any read (readFileSync would follow the link; such an
  // entry must never be resumable, never a cache miss, never overwritten).
  const probe = probeCheckpointEntry(file);
  if (!probe.existing) return null;
  if (!probe.isFile) {
    return refuse(probe.isSymbolicLink ? "a symlink (not a regular file — checkpoint links are never followed)" : "not a regular file");
  }
  let cp;
  try {
    cp = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return refuse(`malformed (invalid JSON: ${err.message})`);
  }
  if (!asRecord(cp)) return refuse("not a JSON object");
  // Ledger-format binding: only checkpoints written under the CURRENT
  // ATTEMPT_LEDGER_VERSION are resumable — old checkpoints (no request_id
  // identity in their attempt logs) must never mix into a new run.
  if (cp.ledger_version !== ATTEMPT_LEDGER_VERSION) {
    return refuse(`stale (ledger_version ${JSON.stringify(cp.ledger_version)} != current ${ATTEMPT_LEDGER_VERSION})`);
  }
  if (cp.schema_version !== schema_version) {
    return refuse(`stale (schema_version ${JSON.stringify(cp.schema_version)} != current ${schema_version})`);
  }
  if (cp.episode_id !== episodeId) {
    return refuse(`identity mismatch (checkpoint episode_id ${JSON.stringify(cp.episode_id)} != ${JSON.stringify(episodeId)})`);
  }
  if (cp.prompt_hash !== prompt_hash) return refuse("identity mismatch (prompt_hash does not match the real episode prompt)");
  if (cp.protocol_hash !== protocol_hash) {
    return refuse("stale (protocol_hash does not match the current classifier protocol — contract bump or protocol drift)");
  }
  if (JSON.stringify(cp.judge_models ?? null) !== JSON.stringify(judge_models)) {
    return refuse(`identity mismatch (judge_models ${JSON.stringify(cp.judge_models)} != current ${JSON.stringify(judge_models)})`);
  }
  if (cp.thinking !== thinking) {
    return refuse(`identity mismatch (thinking ${JSON.stringify(cp.thinking)} != current ${JSON.stringify(thinking)})`);
  }
  const finalCheck = validateFinalClassification(cp.final, {
    prompt_hash,
    protocol_hash,
    judge_models,
    thinking,
    episode_id: episodeId,
    schema_version,
  });
  if (!finalCheck.ok) {
    return refuse(`body invalid (checkpoint final fails validation: ${finalCheck.errors.slice(0, 5).join("; ")})`);
  }
  // FULL body validation before any resume: the checkpoint must be
  // recomputable from the real request ledger (shared v2 validator per judge
  // with the real modelRef + checkpoint-wide unique request_ids) AND from the
  // real prompt (mechanicalExclude recompute). A fake v2 checkpoint —
  // missing/duplicate request_id, forged cost/source, attempts mismatch —
  // is never resumed. seenRequestIds (optional) is a caller-owned Set shared
  // across MULTIPLE checkpoints: when provided, request_id uniqueness is
  // enforced across the whole set (a request_id reused by two checkpoints
  // fails closed); when absent, the standalone per-checkpoint semantics are
  // unchanged.
  const bodyErrors = validateCheckpointBody(cp, cp.final, {
    id: episodeId,
    judgeModels: judge_models,
    prompt,
    seenRequestIds,
  });
  if (bodyErrors.length > 0) {
    return refuse(`body invalid (fails the recomputable classifier body contract: ${bodyErrors.slice(0, 5).join("; ")})`);
  }
  // State contract: ONLY completed checkpoints are resumable. A failed
  // checkpoint (any judge without a valid judgment) is a terminal DIAGNOSTIC
  // artifact — it is never resumed and never overwritten, and the judges are
  // never re-called (that would duplicate paid facts).
  if (cp.final.classification_status !== "completed") {
    return refuse(
      `a ${JSON.stringify(cp.final.classification_status)} diagnostic checkpoint (not resumable, not overwritable) — `
      + "a failed classification is diagnostic-only evidence; re-calling the judges would duplicate paid facts",
    );
  }
  return cp;
}

/**
 * Pure read-only preflight of the classifier checkpoint state for THIS run's
 * hard candidates — computed with the SAME episodeIds / limit / strongRefs /
 * specialists / downstreamJudges / judgeModels / thinking the real selector
 * (selectFairReplayEpisodes) will use. For every hard candidate under
 * outputDir:
 *   - resume=true: loadClassifierCheckpoint — a missing checkpoint (cache
 *     miss) and a valid `completed` checkpoint are allowed; a failed /
 *     malformed / stale / identity-mismatched / body-invalid checkpoint
 *     throws (the SAME fail-closed lifecycle the classifier itself uses).
 *   - resume=false: ANY existing checkpoint throws (--no-resume must never
 *     wipe recorded paid facts).
 * No writes, no invoker, no provider calls — callers run this AFTER the full
 * producer inventory passes and BEFORE makeJudgeInvoker, so a bad checkpoint
 * for candidate B is discovered before candidate A sends any paid request.
 * Legal checkpoints may be re-read freely (no caching needed). Returns
 * { candidates, resumable } for callers that want the hard-candidate list /
 * resumable count without re-running the gates.
 */
export function preflightClassifierCheckpoints(episodes, metaById, {
  episodeIds = null,
  limit = undefined,
  outputDir,
  resume = true,
  judgeModels = CLASSIFIER_DEFAULT_JUDGES,
  thinking = CLASSIFIER_DEFAULT_THINKING,
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  downstreamJudges = DEFAULT_DOWNSTREAM_JUDGES,
} = {}) {
  const protocol_hash = classifierProtocolHash();
  const judges = requireExactlyTwoDistinctJudges(judgeModels, { label: "classifier-models" });
  const downstream = requireDownstreamJudges(
    Array.isArray(downstreamJudges) && downstreamJudges.length
      ? downstreamJudges
      : DEFAULT_DOWNSTREAM_JUDGES,
    { label: "downstream-judges" },
  );
  const hard = selectHardCandidates(episodes, metaById, {
    episodeIds,
    limit,
    strongRefs,
    specialists,
    downstreamJudges: downstream,
  });
  // Full unfiltered runs (no --episode filter and limit===undefined) own the
  // whole active leaf: BEFORE reading any checkpoint, the leaf's direct
  // `.json` entries must be regular files and each existing name must belong
  // to this run's expected hard-candidate names (a subset is legal — missing
  // candidates are cache misses; an EXTRA `.json` or a non-regular/symlink
  // entry fails closed, exactly like the selector's publish/provenance
  // inventory). Archive subdirectories and non-json auxiliary items are
  // ignored. Filtered runs (--episode/--limit) skip the subset restriction:
  // a target-recovery run must tolerate non-target checkpoints in the leaf
  // (the per-candidate load still validates every existing target cp).
  const unfiltered = (episodeIds === null || episodeIds === undefined || episodeIds.length === 0)
    && limit === undefined;
  if (unfiltered) {
    const leaf = classifierCheckpointDir(outputDir);
    if (fs.existsSync(leaf)) {
      const expectedNames = new Set(hard.candidates.map((c) => `${c.episode.episode_id}.json`));
      for (const entry of fs.readdirSync(leaf, { withFileTypes: true })) {
        if (!entry.name.endsWith(".json")) continue; // archive dirs / non-json auxiliary ignored
        if (!entry.isFile()) {
          throw new Error(
            `t0-replay-fair: checkpoint leaf ${leaf}: ${entry.name} is not a regular file `
            + "(non-regular/symlink checkpoint entries fail closed on a full unfiltered run)",
          );
        }
        if (!expectedNames.has(entry.name)) {
          throw new Error(
            `t0-replay-fair: checkpoint leaf ${leaf}: ${entry.name} is not a hard candidate of this run `
            + "(extra checkpoint entries fail closed on a full unfiltered run; archive/move it out of the active directory)",
          );
        }
      }
    }
  }
  // request_id uniqueness is enforced ACROSS every existing target
  // checkpoint of this run: one global Set is shared by all
  // loadClassifierCheckpoint body validations, so a request_id reused by two
  // checkpoints fails closed here — BEFORE any invoker/provider call.
  const globalSeenRequestIds = new Set();
  let resumable = 0;
  for (const candidate of hard.candidates) {
    const episodeId = candidate.episode.episode_id;
    const pHash = promptHash(candidate.episode.prompt);
    if (!resume) {
      const existing = classifierCheckpointPath(outputDir, episodeId);
      // lstat existence semantics: ANY entry at the target — including a
      // broken symlink or directory — is an existing checkpoint that
      // --no-resume refuses to overwrite; ENOENT alone is a fresh slot.
      if (probeCheckpointEntry(existing).existing) {
        throw new Error(
          `t0-replay-fair: --no-resume refuses to overwrite existing checkpoint ${existing} (episode ${episodeId}). `
          + "Paid classifier facts must never be wiped by --no-resume — archive/move the checkpoint out of the active directory (preserving the facts) or use a fresh checkpoint dir.",
        );
      }
    } else {
      const cp = loadClassifierCheckpoint(outputDir, episodeId, {
        prompt_hash: pHash,
        protocol_hash,
        judge_models: judges,
        thinking,
        prompt: candidate.episode.prompt,
        seenRequestIds: globalSeenRequestIds,
      });
      if (cp && asRecord(cp.final)) resumable += 1;
    }
  }
  return { candidates: hard.candidates, resumable };
}

/**
 * Best-effort directory fsync after the create-if-absent publish (the link
 * itself is atomic; the dir fsync makes the new directory entry durable).
 * Some platforms/filesystems refuse directory fsync — best-effort only.
 */
function fsyncDir(dir) {
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

/**
 * Same-directory atomic CREATE-IF-ABSENT publish: write the full content to
 * a unique same-dir temp file, open/write/flush/fsync/close, then LINK the
 * temp onto the target. link() is atomic and fails with EEXIST when the
 * target already exists, so the race loser is rejected and an existing
 * checkpoint (with its recorded paid facts) is NEVER overwritten. The temp
 * is ALWAYS cleaned up (finally); a crash mid-write never leaves a partial
 * file at the canonical path (only a fully-fsynced file is ever linked).
 */
function publishCheckpointAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // Atomic create-if-absent: EEXIST → the race loser is rejected, the
    // existing checkpoint (and the facts it records) is never replaced.
    fs.linkSync(tmp, file);
    fs.unlinkSync(tmp);
    fsyncDir(dir);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(
        `saveClassifierCheckpoint: refusing to overwrite existing checkpoint ${file} — atomic create-if-absent `
        + "(a concurrent writer or an earlier save already published it; recorded facts are never replaced). "
        + "Archive/move the checkpoint out of the active directory (preserving the facts) or use a fresh checkpoint dir.",
      );
    }
    throw err;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export function saveClassifierCheckpoint(outputDir, episodeId, payload, { prompt = null } = {}) {
  // Write-time self-assert: the body about to be written must satisfy the
  // SAME pure contract loadClassifierCheckpoint / validateFairManifestProvenance
  // enforce — recomputed from the REAL prompt (mechanicalExclude recompute),
  // the REAL judge models and the REAL request ledger (per-judge
  // validateAttemptLedgerV2 + dual-judge merge + cost/attempts rebuild). A
  // producer bug is never persisted; mechanical checkpoints pass through the
  // same mechanical branch of the contract. This is the pure contract check,
  // never a write-then-reload approximation. It runs BEFORE the atomic
  // publish, so a refused save never creates or touches any file.
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error(`saveClassifierCheckpoint: ${episodeId} — the real prompt is required for the write-time body self-validation`);
  }
  const bodyErrors = validateCheckpointBody(payload, payload?.final, {
    id: episodeId,
    judgeModels: Array.isArray(payload?.judge_models) ? payload.judge_models : [],
    prompt,
  });
  if (bodyErrors.length > 0) {
    throw new Error(
      `saveClassifierCheckpoint: refusing to write a checkpoint that fails the classifier body contract (${bodyErrors.length}): ${bodyErrors.slice(0, 5).join("; ")}`,
    );
  }
  const file = classifierCheckpointPath(outputDir, episodeId);
  publishCheckpointAtomic(file, `${JSON.stringify({
    ledger_version: ATTEMPT_LEDGER_VERSION,
    ...payload,
  }, null, 2)}\n`);
  return file;
}

// ── classify one candidate ────────────────────────────────────────────────

function buildFinalRecord({
  episodeId,
  stage,
  classification_status,
  replayable,
  reasons,
  confidence,
  costSummary,
  attempts,
  judges,
  pHash,
  protocol_hash,
  thinking,
  extra = {},
}) {
  return {
    schema_version: FAIR_SELECT_SCHEMA_VERSION,
    episode_id: episodeId,
    stage,
    classification_status,
    replayable,
    reasons,
    confidence,
    cost: costSummary.cost,
    cost_source: costSummary.cost_source,
    cost_breakdown: costSummary.cost_breakdown ?? emptyCostBreakdown(),
    has_unknown_cost: costSummary.has_unknown === true,
    known_total: costSummary.known_total ?? 0,
    attempts,
    judge_models: [...judges],
    prompt_hash: pHash,
    protocol_hash,
    thinking,
    from_checkpoint: false,
    ...extra,
  };
}

/**
 * Classify one hard-pass candidate: mechanical gate first, then dual LLM
 * judges. Mechanical exclude wins even if both LLMs say replayable.
 *
 * Enforces exactly two distinct classifier judges (public dual-judge contract).
 */
export async function classifyCandidate(invoker, candidate, {
  judgeModels = CLASSIFIER_DEFAULT_JUDGES,
  maxRetries = CLASSIFIER_DEFAULT_MAX_RETRIES,
  timeoutMs = CLASSIFIER_DEFAULT_TIMEOUT_MS,
  thinking = CLASSIFIER_DEFAULT_THINKING,
  outputDir = null,
  resume = true,
  protocol_hash = classifierProtocolHash(),
} = {}) {
  const judges = requireExactlyTwoDistinctJudges(judgeModels, { label: "classifier-models" });
  const episode = candidate.episode;
  const episodeId = episode.episode_id;
  const pHash = promptHash(episode.prompt);

  if (outputDir) {
    if (!resume) {
      // --no-resume must NEVER wipe existing paid facts: an existing
      // checkpoint (valid or invalid) is refused BEFORE any invoker/provider
      // call — re-classifying would duplicate paid judge calls and
      // overwriting would erase the recorded cost/request_ids. lstat
      // existence semantics: ANY entry at the target — including a broken
      // symlink or directory — is existing; ENOENT alone is a fresh slot.
      const existing = classifierCheckpointPath(outputDir, episodeId);
      if (probeCheckpointEntry(existing).existing) {
        throw new Error(
          `t0-replay-fair: --no-resume refuses to overwrite existing checkpoint ${existing} (episode ${episodeId}). `
          + "Paid classifier facts must never be wiped by --no-resume — archive/move the checkpoint out of the active directory (preserving the facts) or use a fresh checkpoint dir.",
        );
      }
    } else {
      // resume: a valid `completed` checkpoint under the CURRENT contract is
      // a 0-call hit. Any EXISTING checkpoint that is malformed / stale /
      // identity-mismatched / body-invalid / a valid `failed` diagnostic
      // throws BEFORE any invoker/provider call — never a cache miss.
      const cp = loadClassifierCheckpoint(outputDir, episodeId, {
        prompt_hash: pHash,
        protocol_hash,
        judge_models: judges,
        thinking,
        prompt: episode.prompt,
      });
      if (cp && asRecord(cp.final)) {
        return { ...cp.final, from_checkpoint: true, checkpoint: cp };
      }
    }
  }

  const mechanical = mechanicalExclude(episode.prompt);
  if (mechanical.excluded) {
    const costSummary = {
      cost: 0,
      cost_source: null,
      cost_breakdown: emptyCostBreakdown(),
      has_unknown: false,
      known_total: 0,
    };
    const final = buildFinalRecord({
      episodeId,
      stage: "mechanical",
      classification_status: "completed",
      replayable: false,
      reasons: mechanical.reasons,
      confidence: 1,
      costSummary,
      attempts: 0,
      judges,
      pHash,
      protocol_hash,
      thinking,
      extra: { mechanical },
    });
    if (outputDir) {
      saveClassifierCheckpoint(outputDir, episodeId, {
        schema_version: FAIR_SELECT_SCHEMA_VERSION,
        episode_id: episodeId,
        prompt_hash: pHash,
        protocol_hash,
        judge_models: judges,
        thinking,
        mechanical,
        final,
        saved_at: new Date().toISOString(),
      }, { prompt: episode.prompt });
    }
    return final;
  }

  // Dual judges in parallel — never a third.
  const results = await Promise.all(judges.map((modelRef) =>
    runClassifierJudge(invoker, modelRef, episode.prompt, {
      maxRetries,
      timeoutMs,
      thinking,
    })));

  const attempt_log = {};
  for (const r of results) {
    attempt_log[r.modelRef] = r.attempt_log;
  }
  const costSummary = summarizeClassifierCosts(attempt_log);

  const normed = results.map((r) => {
    if (!r.ok || !r.judgment) {
      return { ok: false, errors: [r.error ?? "judge failed"], judgment: null };
    }
    return { ok: true, errors: [], judgment: r.judgment };
  });

  if (normed.some((n) => !n.ok)) {
    const final = buildFinalRecord({
      episodeId,
      stage: "llm",
      classification_status: "failed",
      replayable: false,
      reasons: ["judge_call_failed", ...normed.flatMap((n) => n.errors ?? [])],
      confidence: 0,
      costSummary,
      attempts: results.reduce((s, r) => s + (r.attempts ?? 0), 0),
      judges,
      pHash,
      protocol_hash,
      thinking,
      extra: {
        mechanical,
        attempt_log,
        // A failed final carries NO merged flags/disagreement/judgments —
        // the partial success judgment(s) live in the checkpoint body only.
        flags: null,
        disagreement: null,
        judgments: null,
      },
    });
    if (outputDir) {
      saveClassifierCheckpoint(outputDir, episodeId, {
        schema_version: FAIR_SELECT_SCHEMA_VERSION,
        episode_id: episodeId,
        prompt_hash: pHash,
        protocol_hash,
        judge_models: judges,
        thinking,
        mechanical,
        judgments: Object.fromEntries(results.map((r) => [r.modelRef, r.judgment])),
        attempt_log,
        final,
        saved_at: new Date().toISOString(),
      }, { prompt: episode.prompt });
    }
    return final;
  }

  const merged = mergeDualJudgments(normed[0], normed[1], {
    judge0: judges[0],
    judge1: judges[1],
  });

  const final = buildFinalRecord({
    episodeId,
    stage: "llm",
    classification_status: "completed",
    replayable: merged.replayable === true,
    reasons: merged.reasons,
    confidence: merged.confidence,
    costSummary,
    attempts: results.reduce((s, r) => s + (r.attempts ?? 0), 0),
    judges,
    pHash,
    protocol_hash,
    thinking,
    extra: {
      flags: merged.flags,
      mechanical,
      disagreement: merged.disagreement,
      judgments: merged.judgments,
      attempt_log,
    },
  });

  if (outputDir) {
    saveClassifierCheckpoint(outputDir, episodeId, {
      schema_version: FAIR_SELECT_SCHEMA_VERSION,
      episode_id: episodeId,
      prompt_hash: pHash,
      protocol_hash,
      judge_models: judges,
      thinking,
      mechanical,
      judgments: merged.judgments,
      attempt_log,
      cost: final.cost,
      cost_source: final.cost_source,
      cost_breakdown: final.cost_breakdown,
      final,
      saved_at: new Date().toISOString(),
    }, { prompt: episode.prompt });
  }
  return final;
}

// ── concurrency helper ────────────────────────────────────────────────────

export async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, Math.max(1, items.length)));
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

// ── full fair selection pipeline ──────────────────────────────────────────

/**
 * Full fair prompt-only selection:
 *   1. hard structural gates on all source episodes
 *   2. optional LLM dual-judge classification of hard-pass candidates
 *
 * When classify=false, returns hard candidates only (no LLM).
 * When classify=true, requires invoker; classifies hard-pass (after limit).
 */
export async function selectFairReplayEpisodes(episodes, metaById, {
  episodeIds = null,
  limit = undefined,
  classify = true,
  invoker = null,
  judgeModels = CLASSIFIER_DEFAULT_JUDGES,
  maxRetries = CLASSIFIER_DEFAULT_MAX_RETRIES,
  timeoutMs = CLASSIFIER_DEFAULT_TIMEOUT_MS,
  thinking = CLASSIFIER_DEFAULT_THINKING,
  concurrency = CLASSIFIER_DEFAULT_CONCURRENCY,
  outputDir = null,
  resume = true,
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  downstreamJudges = DEFAULT_DOWNSTREAM_JUDGES,
  quiet = false,
} = {}) {
  const protocol_hash = classifierProtocolHash();
  const judges = classify
    ? requireExactlyTwoDistinctJudges(judgeModels, { label: "classifier-models" })
    : (Array.isArray(judgeModels) ? [...judgeModels] : []);
  const downstream = requireDownstreamJudges(
    Array.isArray(downstreamJudges) && downstreamJudges.length
      ? downstreamJudges
      : DEFAULT_DOWNSTREAM_JUDGES,
    { label: "downstream-judges" },
  );

  const hard = selectHardCandidates(episodes, metaById, {
    episodeIds,
    limit,
    strongRefs,
    specialists,
    downstreamJudges: downstream,
  });

  const exclusion_distribution = { ...hard.distribution };
  const excluded = [...hard.excluded];
  const selected = [];
  const cost_breakdown = emptyCostBreakdown();
  let known_total = 0;
  let has_unknown_cost = false;
  let classified = 0;
  const classifications = [];

  if (!classify) {
    for (const c of hard.candidates) {
      selected.push({
        episode_id: c.episode.episode_id,
        models: c.models,
        join_confidence: c.join_confidence,
        tools: c.episode.tools,
        stage: "hard",
        replayable: null,
      });
    }
    // Stratify selected by join confidence (exact first) — already sorted.
    return buildManifest({
      episodes,
      hard,
      selected,
      excluded,
      exclusion_distribution,
      classified: 0,
      cost_breakdown,
      known_total: 0,
      has_unknown_cost: false,
      classifications,
      protocol_hash,
      judgeModels: judges,
      downstreamJudges: downstream,
      thinking,
      classify: false,
      data_insufficient: selected.length < 2,
    });
  }

  if (!invoker) {
    throw new Error("selectFairReplayEpisodes: invoker is required when classify=true");
  }

  if (outputDir) fs.mkdirSync(classifierCheckpointDir(outputDir), { recursive: true });

  const results = await mapPool(hard.candidates, concurrency, async (candidate) => {
    if (!quiet) {
      console.error(`t0-replay-fair: classify ${candidate.episode.episode_id}`);
    }
    return classifyCandidate(invoker, candidate, {
      judgeModels: judges,
      maxRetries,
      timeoutMs,
      thinking,
      outputDir,
      resume,
      protocol_hash,
    });
  });

  // Fail-closed state gate: every hard candidate classification must be
  // completed (checkpoints already saved above). Any failed classification
  // aborts the whole selection with a clear error — a failed episode must
  // never be silently dropped as an ordinary exclusion, and a partial
  // manifest must never be returned. hard-only (classify=false) is
  // unaffected.
  const failedResults = results
    .map((r, i) => ({ r, candidate: hard.candidates[i] }))
    .filter(({ r }) => r.classification_status !== "completed");
  if (failedResults.length > 0) {
    const summary = failedResults
      .map(({ r, candidate }) => `${candidate.episode.episode_id}: ${(r.reasons ?? []).join("; ")}`)
      .join(" | ");
    throw new Error(
      `selectFairReplayEpisodes: ${failedResults.length} classification(s) failed (fail-closed; no partial manifest): ${summary}`,
    );
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const candidate = hard.candidates[i];
    classified += 1;
    accumulateCostBreakdown(cost_breakdown, r);
    if (typeof r.known_total === "number") known_total += r.known_total;
    else if (typeof r.cost === "number") known_total += r.cost;
    if (r.has_unknown_cost === true || r.cost === null) has_unknown_cost = true;
    classifications.push(r);
    if (r.replayable === true) {
      selected.push(buildSelectedRow(candidate, r));
    } else {
      const stage = r.stage === "mechanical" ? "mechanical" : "llm";
      excluded.push(buildExcludedRow(candidate, r));
      for (const reason of r.reasons) {
        const key = reason.startsWith("mechanical_") || reason.startsWith("dual_judge_")
          || reason.startsWith("either_") || reason.startsWith("judge_")
          ? reason
          : `${stage}_excluded`;
        exclusion_distribution[key] = (exclusion_distribution[key] ?? 0) + 1;
      }
      exclusion_distribution[`${stage}_total`] = (exclusion_distribution[`${stage}_total`] ?? 0) + 1;
    }
  }

  // Final stratification: exact join first, then classifier confidence desc.
  selected.sort(compareSelectedRows);

  return buildManifest({
    episodes,
    hard,
    selected,
    excluded,
    exclusion_distribution,
    classified,
    cost_breakdown,
    known_total,
    has_unknown_cost,
    classifications,
    protocol_hash,
    judgeModels: judges,
    downstreamJudges: downstream,
    thinking,
    classify: true,
    data_insufficient: selected.length < 2,
  });
}

function buildManifest({
  episodes,
  hard,
  selected,
  excluded,
  exclusion_distribution,
  classified,
  cost_breakdown,
  known_total,
  has_unknown_cost,
  classifications,
  protocol_hash,
  judgeModels,
  downstreamJudges,
  thinking,
  classify,
  data_insufficient,
}) {
  const cost = buildManifestCostSummary({ cost_breakdown, known_total, has_unknown_cost });

  const join_selected = { exact: 0, heuristic: 0 };
  for (const s of selected) {
    if (s.join_confidence === "exact") join_selected.exact += 1;
    else if (s.join_confidence === "heuristic") join_selected.heuristic += 1;
  }

  return {
    schema_version: FAIR_SELECT_SCHEMA_VERSION,
    kind: "prompt_only_replay_selection",
    generated_at: new Date().toISOString(),
    protocol_hash,
    thinking: classify ? thinking : null,
    judge_models: classify ? [...judgeModels] : [],
    classifier_models: classify ? [...judgeModels] : [],
    downstream_judges: [...downstreamJudges],
    classify,
    counts: {
      source: episodes.length,
      hard_pass: hard.hard_pass_count,
      hard_pass_limited: hard.candidates.length,
      classified,
      replayable: selected.length,
      excluded: excluded.length,
      data_insufficient,
      join_hard_pass: { ...hard.join_tier },
      join_selected,
    },
    exclusion_distribution,
    cost,
    selected,
    excluded,
    classifications: classifications.map((c) => buildClassificationRow(c)),
  };
}
