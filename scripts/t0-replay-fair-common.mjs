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
  callJudge,
  parseJsonOutput,
  validateSchema,
  attemptCost,
  summarizeCosts,
  sleep,
} from "./t0-eval-common.mjs";
import {
  STRONG_REFERENCE_MODELS,
  SPECIALIST_MODELS,
  REPLAY_JUDGE_MODELS,
} from "./t0-replay-build.mjs";

export { STRONG_REFERENCE_MODELS, SPECIALIST_MODELS, REPLAY_JUDGE_MODELS };

// TRUNCATED_MARKER lives on episode-build; keep a local copy so this module
// does not pull the heavy episode builder just for a string constant.
const TRUNCATED_MARKER = "[truncated]";

export const FAIR_SELECT_SCHEMA_VERSION = 1;
export const CLASSIFIER_SCHEMA_VERSION = 1;
export const CLASSIFIER_DEFAULT_JUDGES = ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"];
/** Default self-judge exclusion set: replay-eval five roles, deduped. */
export const DEFAULT_DOWNSTREAM_JUDGES = [...REPLAY_JUDGE_MODELS];
export const CLASSIFIER_DEFAULT_MAX_RETRIES = 2;
export const CLASSIFIER_DEFAULT_TIMEOUT_MS = 600_000;
export const CLASSIFIER_DEFAULT_CONCURRENCY = 2;
export const CLASSIFIER_DEFAULT_THINKING = "medium";

/** Builder-verified join confidences accepted by fair selection. */
export const ALLOWED_JOIN_CONFIDENCES = Object.freeze(["exact", "heuristic"]);

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
} = {}) {
  return sha256Hex(JSON.stringify({
    schema_version: schemaVersion,
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

export function loadMeta(metaPath) {
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

// ── body/meta 1:1 mapping ─────────────────────────────────────────────────

/**
 * Body slots and in_body meta slots must form a complete one-to-one map by
 * slot_id: same size, same ids, no orphans either side, no duplicate ids.
 */
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

// ── hard structural selection ─────────────────────────────────────────────

/**
 * Evaluate hard structural gates for one episode. Returns
 * { ok, reasons[], models, map, join_confidence }. reasons is empty when ok.
 *
 * Note: judgeModels here are DOWNSTREAM judges (self-candidate exclusion),
 * not classifier models.
 */
export function evaluateHardGates(episode, meta, {
  strongRefs = STRONG_REFERENCE_MODELS,
  specialists = SPECIALIST_MODELS,
  downstreamJudges = DEFAULT_DOWNSTREAM_JUDGES,
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
    return a.episode.episode_id.localeCompare(b.episode.episode_id);
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

// ── single-judge LLM call ─────────────────────────────────────────────────

/**
 * One classifier judge call with bounded content retry. The judge sees ONLY
 * the anonymous prompt (no tools beyond structured-output submit tool).
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
    const costInfo = attemptCost(modelRef, result.usage);
    let parsed = result.structured && result.parsed ? result.parsed : null;
    if (!parsed && result.ok && typeof result.text === "string") {
      const extracted = parseJsonOutput(result.text);
      parsed = extracted.parsed;
    }
    if (!result.ok || !parsed) {
      const err = result.error ?? "unparseable classifier output";
      attemptLog.push({
        attempt,
        ok: false,
        error: err,
        error_class: result.errorClass ?? "content",
        usage: result.usage,
        cost: costInfo.cost,
        cost_source: costInfo.source ?? "unknown",
      });
      lastError = err;
      if (result.errorClass === "transport") {
        if (attempt < maxRetries) await sleep(2_000 * 2 ** attempt + Math.floor(Math.random() * 500));
        continue;
      }
      contentFailed = true;
      continue;
    }
    const normalized = normalizeClassifierJudgment(parsed);
    if (!normalized.ok) {
      attemptLog.push({
        attempt,
        ok: false,
        error: normalized.errors.join("; "),
        error_class: "content",
        usage: result.usage,
        cost: costInfo.cost,
        cost_source: costInfo.source ?? "unknown",
      });
      lastError = normalized.errors.join("; ");
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
      cost_source: costInfo.source ?? "unknown",
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

export function classifierCheckpointPath(outputDir, episodeId) {
  return path.join(outputDir, "checkpoints", `${episodeId}.json`);
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

export function loadClassifierCheckpoint(outputDir, episodeId, {
  prompt_hash,
  protocol_hash,
  judge_models,
  thinking,
  schema_version = FAIR_SELECT_SCHEMA_VERSION,
}) {
  const file = classifierCheckpointPath(outputDir, episodeId);
  if (!fs.existsSync(file)) return null;
  let cp;
  try {
    cp = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!asRecord(cp)) return null;
  if (cp.schema_version !== schema_version) return null;
  if (cp.episode_id !== episodeId) return null;
  if (cp.prompt_hash !== prompt_hash) return null;
  if (cp.protocol_hash !== protocol_hash) return null;
  if (JSON.stringify(cp.judge_models ?? null) !== JSON.stringify(judge_models)) return null;
  if (cp.thinking !== thinking) return null;
  const finalCheck = validateFinalClassification(cp.final, {
    prompt_hash,
    protocol_hash,
    judge_models,
    thinking,
    episode_id: episodeId,
    schema_version,
  });
  if (!finalCheck.ok) return null;
  return cp;
}

export function saveClassifierCheckpoint(outputDir, episodeId, payload) {
  const file = classifierCheckpointPath(outputDir, episodeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

// ── classify one candidate ────────────────────────────────────────────────

function buildFinalRecord({
  episodeId,
  stage,
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

  if (outputDir && resume) {
    const cp = loadClassifierCheckpoint(outputDir, episodeId, {
      prompt_hash: pHash,
      protocol_hash,
      judge_models: judges,
      thinking,
    });
    if (cp && asRecord(cp.final)) {
      return { ...cp.final, from_checkpoint: true, checkpoint: cp };
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
      });
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
      });
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
    });
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

  if (outputDir) fs.mkdirSync(path.join(outputDir, "checkpoints"), { recursive: true });

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
      selected.push({
        episode_id: candidate.episode.episode_id,
        models: candidate.models,
        join_confidence: candidate.join_confidence,
        tools: candidate.episode.tools,
        stage: r.stage,
        replayable: true,
        confidence: r.confidence,
        reasons: r.reasons,
        flags: r.flags ?? null,
        cost: r.cost,
        cost_source: r.cost_source,
        cost_breakdown: r.cost_breakdown,
        from_checkpoint: r.from_checkpoint === true,
      });
    } else {
      const stage = r.stage === "mechanical" ? "mechanical" : "llm";
      excluded.push({
        episode_id: candidate.episode.episode_id,
        stage,
        reasons: r.reasons,
        join_confidence: candidate.join_confidence,
        confidence: r.confidence,
        flags: r.flags ?? null,
        cost: r.cost,
        cost_source: r.cost_source,
        from_checkpoint: r.from_checkpoint === true,
      });
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
  selected.sort((a, b) => {
    const ae = a.join_confidence === "exact" ? 1 : 0;
    const be = b.join_confidence === "exact" ? 1 : 0;
    if (be !== ae) return be - ae;
    const ac = typeof a.confidence === "number" ? a.confidence : 0;
    const bc = typeof b.confidence === "number" ? b.confidence : 0;
    if (bc !== ac) return bc - ac;
    return a.episode_id.localeCompare(b.episode_id);
  });

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
  const sources = [];
  if ((cost_breakdown.provider ?? 0) > 0) sources.push("provider");
  if ((cost_breakdown.estimated ?? 0) > 0) sources.push("estimated");
  if ((cost_breakdown.unknown ?? 0) > 0 || has_unknown_cost) sources.push("unknown");
  let cost_source = null;
  if (sources.length === 1) cost_source = sources[0];
  else if (sources.length > 1) cost_source = "mixed";

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
    cost: {
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
    },
    selected,
    excluded,
    classifications: classifications.map((c) => ({
      episode_id: c.episode_id,
      stage: c.stage,
      replayable: c.replayable,
      reasons: c.reasons,
      confidence: c.confidence,
      join_confidence: c.join_confidence ?? null,
      cost: c.cost,
      cost_source: c.cost_source ?? null,
      cost_breakdown: c.cost_breakdown ?? null,
      from_checkpoint: c.from_checkpoint === true,
    })),
  };
}
