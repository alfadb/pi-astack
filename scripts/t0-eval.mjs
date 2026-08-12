#!/usr/bin/env node
/**
 * t0-eval — fully automatic LLM evaluation of anonymous T0 episodes.
 *
 * Reads ONLY the specified episodes.jsonl (the anonymous blind body from
 * t0-episode-build.mjs). Never opens blind-key.json / episodes.meta.jsonl /
 * stats.json / exclusions.jsonl in the dataset directory. Judge calls carry
 * NO tools. Outputs are keyed by episode-local candidate ids (c0..cN); model
 * identity recovery is the separate aggregator command's job.
 *
 * Pipeline per episode (all stages schema-validated, bounded retry, resumable):
 *   1. evaluator_0 / evaluator_1 — two anonymous independent evaluators
 *   2. verifier                  — adversarial attack on both evaluations
 *   3. adjudicator               — final candidate verdicts + evidence
 *   4. counterfactual            — per-candidate information loss / noise
 *                                   reduction / unique valid contribution
 *
 * Usage:
 *   node scripts/t0-eval.mjs [options]
 *
 * Options:
 *   --episodes <path>   episodes.jsonl to evaluate (default:
 *                       ~/.pi/.pi-astack/t0-episodes/episodes.jsonl)
 *   --episode <id>      episode id to evaluate (repeatable / comma-separated)
 *   --limit <n>         max episodes to evaluate (default: 1 — never the
 *                       whole dataset by default)
 *   --concurrency <n>   max episodes evaluated in parallel (default: 2)
 *   --models <csv>      judge models, roles in order: evaluator0, evaluator1,
 *                       verifier, adjudicator, counterfactual; custom 1-5
 *                       models with missing roles falling back to the first
 *                       model, more than 5 rejected (default: cross-vendor
 *                       alternation — evaluator0/adjudicator gpt-5.6-sol,
 *                       evaluator1/verifier/counterfactual claude-opus-5)
 *   --output <dir>      output directory (default:
 *                       ~/.pi/.pi-astack/t0-eval)
 *   --models-json <path>  models.json path (default: ~/.pi/agent/models.json)
 *   --max-retries <n>   bounded retries per judge call (default: 2)
 *   --timeout-ms <n>    per-call timeout (default: 600000)
 *   --no-resume         ignore existing checkpoints
 *   --quiet             suppress per-episode progress lines
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  EVAL_SCHEMA_VERSION,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
  DEFAULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  parseCli,
  nonNegativeInt,
  loadEpisodes,
  selectEpisodes,
  resolveJudgeModels,
  makeJudgeInvoker,
  callJudge,
  parseJsonOutput,
  validateStage,
  normalizeStageEnums,
  episodeContentHash,
  loadCheckpoint,
  saveCheckpoint,
  buildJudgeProtocolHash,
  buildJudgeSchemaHash,
  buildJudgeFeed,
  buildJudgeUserContent,
  ANON_RULES,
  attemptCost,
  sumAttemptCosts,
  summarizeCosts,
  aggregateCostSource,
  buildStageTool,
  dedupeAttempts,
  filterCheckpointStages,
  scanEvalRecords,
  sleep,
  summarizeFailedOutput,
  writeJsonFile,
  appendJsonl,
} from "./t0-eval-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── prompts ──────────────────────────────────────────────────────────────

// ANON_RULES (shared hard rules) lives in t0-eval-common.mjs: it is delivered
// TWICE per stage — as part of the system prompt below (complete, with the
// full JSON example) AND as the authoritative protocol prefix of the user
// payload (compressed, semantics + enumerations complete, no JSON example)
// via buildJudgeUserContent. The user-payload copy is the fallback that keeps
// the protocol alive when a provider intermittently drops the system message.

const EVALUATOR_PROMPT = `${ANON_RULES}

Your job: evaluate the task prompt and each candidate answer.

For EACH candidate, produce:
1. claims: classify the candidate's claims into four buckets:
   - supported: claims supported by the prompt/context
   - unsupported: claims asserted without support in the prompt/context
   - contradicted: claims contradicted by the prompt/context
   - unverifiable: claims that cannot be verified from the given material
2. missed_critical_points: important points the candidate missed
3. instruction_following: rating full|partial|none|unresolved + notes
   Mechanical constraints HARD rule: when the task prompt states checkable
   limits (character/word counts e.g. 500字以内), required item counts
   (e.g. 3-5条), fixed labels/choices (三选一 / ACCEPT|REJECT / 签署|不签署),
   required sections/order, or other fixed output format, you MUST verify
   them against the candidate text and cite observed vs required values in
   instruction_following.notes (e.g. "字数≈480/上限500; 理由条数=4/要求3-5;
   结论标签=有"). Do NOT award rating=full from prose style alone if a
   mechanical constraint fails or was not checked. Missing required structure
   → none; violated count/limit/label → at most partial.
4. overall_correctness: rating correct|partially_correct|incorrect|unresolved
   + confidence (0..1) + notes
5. noise_types: choose from the closed set ONLY: fabrication,
   unsupported_claim, contradiction, irrelevance, repetition, verbosity,
   severity_overstatement, instruction_violation, other (use "other" only
   when nothing else fits).

Also assess task_understanding: did the candidate understand the task?

You may set abstain=true for a candidate when you cannot evaluate it; you are
NOT required to name a winner.

OUTPUT FORMAT (hard requirement): your ENTIRE response must be a single valid
JSON object matching the schema below. No prose, no markdown headings, no
bullet lists, no code fences, no explanation before or after the JSON. The
response must start with "{" and end with "}".

Respond with the JSON object:
{
  "schema_version": 1,
  "stage": "evaluator",
  "evaluator_index": 0,
  "episode_id": "<episode id>",
  "task_understanding": { "ok": true, "confidence": 0.0, "summary": "...", "unresolved": false },
  "candidates": [
    {
      "candidate_id": "c0",
      "claims": { "supported": [], "unsupported": [], "contradicted": [], "unverifiable": [] },
      "missed_critical_points": [],
      "instruction_following": { "rating": "full", "notes": "..." },
      "overall_correctness": { "rating": "correct", "confidence": 0.0, "notes": "..." },
      "noise_types": [],
      "abstain": false,
      "abstain_reason": null
    }
  ],
  "notes": "..."
}`;

const VERIFIER_PROMPT = `${ANON_RULES}

Your job: adversarial verification of two independent evaluations of the same
episode. Attack the evidence and bias of BOTH evaluations.

For each attack, produce:
- target: "evaluator_0" | "evaluator_1" | "candidate_<id>"
- issue: what is wrong
- severity: high|medium|low
- evidence_weakness: where the evaluation's evidence is weak or missing
- bias_suspected: any bias you suspect (style-based identity guessing,
  adoption-as-correctness, anchoring, leniency, etc.)
- suggestion: how to fix it

Also assess overall evidence quality of each evaluation and list bias_flags.

OUTPUT FORMAT (hard requirement): your ENTIRE response must be a single valid
JSON object matching the schema below. No prose, no markdown headings, no
bullet lists, no code fences, no explanation before or after the JSON. The
response must start with "{" and end with "}".

Respond with the JSON object:
{
  "schema_version": 1,
  "stage": "verifier",
  "episode_id": "<episode id>",
  "attacks": [
    {
      "target": "evaluator_0",
      "issue": "...",
      "severity": "high",
      "evidence_weakness": "...",
      "bias_suspected": "...",
      "suggestion": "..."
    }
  ],
  "overall": {
    "evaluator_0_evidence_quality": "strong",
    "evaluator_1_evidence_quality": "weak",
    "bias_flags": [],
    "notes": "..."
  }
}`;

const ADJUDICATOR_PROMPT = `${ANON_RULES}

Your job: adjudicate the episode given two independent evaluations and an
adversarial verification of those evaluations. Produce a final verdict for
EACH candidate.

For each candidate, produce:
- verdict: adopt|consider|reject|unresolved
- confidence: 0..1
- evidence: reasons supporting the verdict
- counter_evidence: reasons against the verdict
- noise_assessment: how much of the candidate's output is noise
- notes

Also assess evaluator_disagreement (high|medium|low|unresolved) and list any
unresolved candidate ids.

OUTPUT FORMAT (hard requirement): your ENTIRE response must be a single valid
JSON object matching the schema below. No prose, no markdown headings, no
bullet lists, no code fences, no explanation before or after the JSON. The
response must start with "{" and end with "}".

Respond with the JSON object:
{
  "schema_version": 1,
  "stage": "adjudicator",
  "episode_id": "<episode id>",
  "verdicts": [
    {
      "candidate_id": "c0",
      "verdict": "adopt",
      "confidence": 0.0,
      "evidence": [],
      "counter_evidence": [],
      "noise_assessment": "...",
      "notes": "..."
    }
  ],
  "disagreement": { "evaluator_disagreement": "low", "summary": "..." },
  "unresolved": [],
  "notes": "..."
}`;

const COUNTERFACTUAL_PROMPT = `${ANON_RULES}

Your job: counterfactual analysis. For EACH candidate, imagine removing that
candidate's answer from the episode and judge:

- information_loss: how much valid information would be lost (high|medium|low|none|unresolved)
- noise_reduction: how much noise would be removed (high|medium|low|none|unresolved)
- unique_valid_contribution: what unique valid content this candidate adds that
  no other candidate provides (string, or null if none)
- net_value: overall value of keeping this candidate (positive|neutral|negative|unresolved)
- notes

OUTPUT FORMAT (hard requirement): your ENTIRE response must be a single valid
JSON object matching the schema below. No prose, no markdown headings, no
bullet lists, no code fences, no explanation before or after the JSON. The
response must start with "{" and end with "}".

Respond with the JSON object:
{
  "schema_version": 1,
  "stage": "counterfactual",
  "episode_id": "<episode id>",
  "per_candidate": [
    {
      "candidate_id": "c0",
      "information_loss": "low",
      "noise_reduction": "low",
      "unique_valid_contribution": null,
      "net_value": "neutral",
      "notes": "..."
    }
  ],
  "notes": "..."
}`;

// ── pipeline ─────────────────────────────────────────────────────────────

/**
 * Stage-specific corrective hints: models that drift into prose or answer the
 * task instead of producing the evaluation report are steered back with the
 * exact required structure (the full example lives in the stage prompt).
 */
const CORRECTIVE_HINTS = {
  evaluator: `\n\nYour previous response was not accepted. You are the anonymous EVALUATOR of this episode — your output is the evaluation report, NOT an answer to the task prompt. Your ENTIRE response must be a single valid JSON object with exactly these top-level fields: schema_version (number 1), stage ("evaluator"), evaluator_index (0 or 1), episode_id, task_understanding {ok, confidence, summary, unresolved}, candidates [{candidate_id, claims {supported, unsupported, contradicted, unverifiable}, missed_critical_points, instruction_following {rating: full|partial|none|unresolved, notes}, overall_correctness {rating: correct|partially_correct|incorrect|unresolved, confidence, notes}, noise_types (closed set: fabrication, unsupported_claim, contradiction, irrelevance, repetition, verbosity, severity_overstatement, instruction_violation, other), abstain, abstain_reason}], notes. No prose, no markdown, no code fences. Respond with ONLY the JSON object.`,
  verifier: `\n\nYour previous response was not accepted. You are the anonymous VERIFIER of this episode — your output is the verification report, NOT an answer to the task prompt. Your ENTIRE response must be a single valid JSON object with exactly these top-level fields: schema_version (number 1), stage ("verifier"), episode_id, attacks [{target, issue, severity: high|medium|low, evidence_weakness, bias_suspected, suggestion}], overall {evaluator_0_evidence_quality: strong|weak|unresolved, evaluator_1_evidence_quality: strong|weak|unresolved, bias_flags, notes}. No prose, no markdown, no code fences. Respond with ONLY the JSON object.`,
  adjudicator: `\n\nYour previous response was not accepted. You are the anonymous ADJUDICATOR of this episode — your output is the adjudication report, NOT an answer to the task prompt. Your ENTIRE response must be a single valid JSON object with exactly these top-level fields: schema_version (number 1), stage ("adjudicator"), episode_id, verdicts [{candidate_id, verdict: adopt|consider|reject|unresolved, confidence, evidence, counter_evidence, noise_assessment, notes}], disagreement {evaluator_disagreement: high|medium|low|unresolved, summary}, unresolved (ONLY episode candidate ids), unresolved_issues (free text), notes. No prose, no markdown, no code fences. Respond with ONLY the JSON object.`,
  counterfactual: `\n\nYour previous response was not accepted. You are the anonymous COUNTERFACTUAL judge of this episode — your output is the counterfactual report, NOT an answer to the task prompt. Your ENTIRE response must be a single valid JSON object with exactly these top-level fields: schema_version (number 1), stage ("counterfactual"), episode_id, per_candidate [{candidate_id, information_loss: high|medium|low|none|unresolved, noise_reduction: high|medium|low|none|unresolved, unique_valid_contribution: {exists: boolean, contribution: string|null, evidence: string[]}, net_value: positive|neutral|negative|unresolved, notes}], notes. No prose, no markdown, no code fences. Respond with ONLY the JSON object.`,
};

/**
 * One stage with bounded corrective retries. Failures are classified:
 *   - content/schema failures (parse, schema, empty, truncated) retry with a
 *     stage-specific corrective hint that includes the ORIGINAL error summary
 *     (never lost);
 *   - transport failures (auth, HTTP, 429, timeout — the call itself failed,
 *     the model's answer was never wrong) retry with backoff and NO
 *     corrective hint.
 * Every attempt is recorded in `attempt_log` with its parse/schema error,
 * error class, usage, provider-reported cost (estimation only as fallback,
 * marked) and normalization changes — first-attempt rejections are fully
 * diagnosable. Failed attempts also keep a bounded (<=2KB) raw-output / parsed
 * summary (`raw_output`) for diagnosis; the judge body is de-identified by
 * construction, so it never carries sidecar identity material.
 * `priorAttempts` (from the checkpoint's cross-run `attempt_history`) are
 * prepended to the log so a failed stage's earlier attempts survive a resume;
 * `new_attempts` counts only calls made in this invocation.
 * Structured output (json_schema constrained sampling) is used when the
 * project API supports it; the corrective-retry loop remains the safety net.
 */
export async function runStage(invoker, modelRef, prompt, feed, { stage, episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts = [] }) {
  const tool = buildStageTool(stage);
  // Cross-run attempt history: prior attempts from earlier runs (a failed
  // stage re-runs on resume) are kept so their usage/cost are never lost.
  const attemptLog = [...priorAttempts];
  let newAttempts = 0; // calls made in THIS invocation (prior attempts are not re-counted)
  let lastError = null;
  let lastUsage = null;
  let contentFailed = false;
  let lastErrors = null; // specific validation errors from the previous attempt
  let lastParseError = null; // original parse error summary from the previous attempt
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    newAttempts++;
    let hint = "";
    if (contentFailed) {
      // The corrective hint is protocol-level (never evidence): it is marked
      // as such so the model cannot mistake it for part of the episode.
      hint = `## Protocol correction (authoritative)\n${(CORRECTIVE_HINTS[stage] ?? "").trim()}`;
      const detail = [];
      if (lastErrors && lastErrors.length > 0) {
        detail.push(`fix these validation errors from your previous response (keep the same structure):\n${lastErrors.map((e) => `- ${e}`).join("\n")}`);
      }
      if (lastParseError) {
        detail.push(`your previous response could not be parsed as JSON: ${lastParseError}`);
      }
      if (detail.length > 0) hint = `${hint}\n\nAdditionally, ${detail.join("\n")}`;
    }
    const userContent = buildJudgeUserContent(stage, feed, hint);
    const result = await callJudge(invoker, modelRef, prompt, userContent, {
      maxRetries: 0, // transport retries are handled below (bounded, backoff, no corrective hint)
      timeoutMs,
      operation: `t0_eval_${stage}`,
      tool,
    });
    const costInfo = attemptCost(modelRef, result.usage);
    let normalized = null;
    let changes = [];
    let validation = null;
    let parseError = null;
    if (result.ok) {
      if (result.structured) {
        normalized = normalizeStageEnums(stage, result.parsed, changes);
        validation = validateStage(stage, normalized, { candidateIds });
      } else {
        const { parsed, parse_error } = parseJsonOutput(result.text);
        if (parsed) {
          normalized = normalizeStageEnums(stage, parsed, changes);
          validation = validateStage(stage, normalized, { candidateIds });
        } else {
          parseError = parse_error;
        }
      }
    }
    const attemptOk = result.ok && normalized && validation?.ok;
    const attemptError = !result.ok
      ? result.error
      : parseError
        ? `JSON parse failed: ${parseError}`
        : validation && !validation.ok
          ? `schema validation failed: ${validation.errors.join("; ")}`
          : null;
    // Failure class: "transport" (auth/HTTP/429/timeout — the call itself
    // failed, the model's answer was never wrong) vs "content" (parse/schema/
    // empty/truncated — the model's answer was rejected).
    const errorClass = !result.ok
      ? (result.errorClass ?? "content")
      : parseError || (validation && !validation.ok)
        ? "content"
        : null;
    attemptLog.push({
      attempt,
      ok: attemptOk,
      error: attemptError,
      error_class: errorClass,
      usage: result.usage,
      cost: costInfo.cost,
      cost_source: costInfo.source,
      normalized_changes: changes,
      structured: result.structured ?? false,
      // Failed attempts keep a bounded (<=2KB) raw-output / parsed summary
      // for diagnosis (de-identified judge body, never sidecar material).
      ...(attemptOk ? {} : { raw_output: summarizeFailedOutput(result) }),
    });
    if (attemptOk) {
      const finalLog = dedupeAttempts(attemptLog);
      return {
        stage,
        ok: true,
        data: normalized,
        modelRef,
        attempts: finalLog.length,
        new_attempts: newAttempts,
        usage: result.usage,
        cost: sumAttemptCosts(finalLog),
        cost_source: aggregateCostSource(finalLog),
        attempt_log: finalLog,
      };
    }
    lastError = attemptError;
    lastUsage = result.usage;
    if (errorClass === "transport") {
      // Independent retry path: backoff, NO corrective hint — the previous
      // answer was never wrong, the call itself failed.
      if (attempt < maxRetries) {
        await sleep(2_000 * 2 ** attempt + Math.floor(Math.random() * 500));
      }
      continue;
    }
    contentFailed = true;
    lastErrors = validation && !validation.ok ? validation.errors : null;
    lastParseError = parseError;
  }
  const finalLog = dedupeAttempts(attemptLog);
  return {
    stage,
    ok: false,
    error: lastError ?? "unknown error",
    modelRef,
    attempts: finalLog.length,
    new_attempts: newAttempts,
    usage: lastUsage,
    cost: sumAttemptCosts(finalLog),
    cost_source: aggregateCostSource(finalLog),
    attempt_log: finalLog,
  };
}

/**
 * Evaluate one episode. Returns the full episode evaluation record.
 * Stages are checkpointed individually; a completed stage is skipped on
 * resume only when the episode content hash matches AND the stage was run
 * with the same model as the current role assignment (failed/skipped stages
 * and model-role mismatches re-run automatically).
 */
export async function evaluateEpisode(invoker, episode, judgeModels, options) {
  const { outputDir, maxRetries, timeoutMs, resume, quiet } = options;
  const episodeId = episode.episode_id;
  const contentHash = episodeContentHash(episode);
  const protocolHash = buildJudgeProtocolHash();
  const schemaHash = buildJudgeSchemaHash();
  const feed = buildJudgeFeed(episode);
  const candidateIds = (episode.slots ?? []).map((s) => s.model_id);
  const cpOpts = { protocolHash, schemaHash };

  const existing = resume ? loadCheckpoint(outputDir, episodeId, contentHash, cpOpts) : null;
  // Cross-run attempt history: failed stages re-run on resume keep their
  // earlier attempts (usage/cost) via the checkpoint's attempt_history.
  const attemptHistory = existing?.attempt_history ?? {};
  const stages = existing ? filterCheckpointStages(existing, judgeModels) : {};
  let newCalls = 0; // calls made in THIS run (checkpointed stages are not re-counted)

  const log = (msg) => { if (!quiet) console.log(`  [${episodeId}] ${msg}`); };

  // Stage 1: two independent evaluators (parallel). Each missing evaluator
  // re-runs independently — a successful evaluator is never re-run on resume
  // (zero new calls for it).
  const needE0 = !stages.evaluator_0;
  const needE1 = !stages.evaluator_1;
  if (needE0 || needE1) {
    log(`evaluating (${judgeModels.evaluator0}, ${judgeModels.evaluator1})`);
    const [e0, e1] = await Promise.all([
      needE0
        ? runStage(invoker, judgeModels.evaluator0, EVALUATOR_PROMPT, feed, { stage: "evaluator", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.evaluator_0 ?? [] })
        : stages.evaluator_0,
      needE1
        ? runStage(invoker, judgeModels.evaluator1, EVALUATOR_PROMPT, feed, { stage: "evaluator", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.evaluator_1 ?? [] })
        : stages.evaluator_1,
    ]);
    if (needE0) {
      stages.evaluator_0 = { ...e0, data: e0.data ? { ...e0.data, evaluator_index: 0 } : null };
      newCalls += e0.new_attempts;
    }
    if (needE1) {
      stages.evaluator_1 = { ...e1, data: e1.data ? { ...e1.data, evaluator_index: 1 } : null };
      newCalls += e1.new_attempts;
    }
    saveCheckpoint(outputDir, episodeId, contentHash, stages, attemptHistory, cpOpts);
  }

  // Stage 2: adversarial verifier (needs both evaluations).
  if (!stages.verifier) {
    const bothOk = stages.evaluator_0?.ok && stages.evaluator_1?.ok;
    if (bothOk) {
      log("verifying");
      const verifierFeed = [
        feed,
        "",
        "## Evaluation 0",
        JSON.stringify(stages.evaluator_0.data, null, 2),
        "",
        "## Evaluation 1",
        JSON.stringify(stages.evaluator_1.data, null, 2),
      ].join("\n");
      stages.verifier = await runStage(invoker, judgeModels.verifier, VERIFIER_PROMPT, verifierFeed, { stage: "verifier", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.verifier ?? [] });
      newCalls += stages.verifier.new_attempts;
      saveCheckpoint(outputDir, episodeId, contentHash, stages, attemptHistory, cpOpts);
    } else {
      stages.verifier = { stage: "verifier", ok: false, error: "skipped: one or both evaluations failed", modelRef: judgeModels.verifier, attempts: 0, usage: null, cost: null, cost_source: null, attempt_log: [] };
    }
  }

  // Stage 3: adjudicator (needs episode + evaluations + verifier).
  if (!stages.adjudicator) {
    const evalsOk = stages.evaluator_0?.ok && stages.evaluator_1?.ok;
    if (evalsOk) {
      log("adjudicating");
      const adjudicatorFeed = [
        feed,
        "",
        "## Evaluation 0",
        JSON.stringify(stages.evaluator_0.data, null, 2),
        "",
        "## Evaluation 1",
        JSON.stringify(stages.evaluator_1.data, null, 2),
        "",
        "## Verifier",
        JSON.stringify(stages.verifier?.ok ? stages.verifier.data : { error: stages.verifier?.error ?? "no verifier" }, null, 2),
      ].join("\n");
      stages.adjudicator = await runStage(invoker, judgeModels.adjudicator, ADJUDICATOR_PROMPT, adjudicatorFeed, { stage: "adjudicator", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.adjudicator ?? [] });
      newCalls += stages.adjudicator.new_attempts;
      saveCheckpoint(outputDir, episodeId, contentHash, stages, attemptHistory, cpOpts);
    } else {
      stages.adjudicator = { stage: "adjudicator", ok: false, error: "skipped: one or both evaluations failed", modelRef: judgeModels.adjudicator, attempts: 0, usage: null, cost: null, cost_source: null, attempt_log: [] };
    }
  }

  // Stage 4: counterfactual judge (needs episode + adjudicator verdicts).
  if (!stages.counterfactual) {
    if (stages.adjudicator?.ok) {
      log("counterfactual");
      const counterfactualFeed = [
        feed,
        "",
        "## Adjudicator verdicts",
        JSON.stringify(stages.adjudicator.data, null, 2),
      ].join("\n");
      stages.counterfactual = await runStage(invoker, judgeModels.counterfactual, COUNTERFACTUAL_PROMPT, counterfactualFeed, { stage: "counterfactual", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.counterfactual ?? [] });
      newCalls += stages.counterfactual.new_attempts;
      saveCheckpoint(outputDir, episodeId, contentHash, stages, attemptHistory, cpOpts);
    } else {
      stages.counterfactual = { stage: "counterfactual", ok: false, error: "skipped: adjudicator failed", modelRef: judgeModels.counterfactual, attempts: 0, usage: null, cost: null, cost_source: null, attempt_log: [] };
    }
  }

  const stageNames = ["evaluator_0", "evaluator_1", "verifier", "adjudicator", "counterfactual"];
  // All recorded attempts across stages (including failed attempts from
  // earlier runs, via the cross-run attempt history) — summary calls/cost
  // must include every recorded attempt, never just the final run's.
  const allAttempts = stageNames.flatMap((s) => stages[s]?.attempt_log ?? []);
  const calls = allAttempts.length;
  const { cost, cost_source, cost_breakdown } = summarizeCosts(allAttempts);
  const unresolved = [];
  if (stages.adjudicator?.ok) {
    for (const v of stages.adjudicator.data.verdicts ?? []) {
      if (v.verdict === "unresolved") unresolved.push(v.candidate_id);
    }
    for (const id of stages.adjudicator.data.unresolved ?? []) unresolved.push(id);
  }
  const errors = stageNames
    .filter((s) => stages[s] && !stages[s].ok)
    .map((s) => ({ stage: s, error: stages[s].error }));

  const record = {
    schema_version: EVAL_SCHEMA_VERSION,
    episode_id: episodeId,
    content_hash: contentHash,
    protocol_hash: protocolHash,
    schema_hash: schemaHash,
    dataset_mode: episode.dataset_mode ?? null,
    model_count: episode.model_count ?? null,
    candidate_ids: (episode.slots ?? []).map((s) => s.model_id),
    judge_models: { ...judgeModels },
    stages,
    summary: {
      calls,
      new_calls: newCalls,
      cost,
      cost_source,
      cost_breakdown,
      // Per episode+candidate (never bare candidate ids).
      unresolved: [...new Set(unresolved)].map((candidateId) => ({ episode_id: episodeId, candidate_id: candidateId })),
      errors,
      complete: stageNames.every((s) => stages[s]?.ok),
    },
  };
  saveCheckpoint(outputDir, episodeId, contentHash, stages, attemptHistory, cpOpts);
  return record;
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = parseCli(argv);
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  // Repeated --episode flags accumulate (parseCli turns repeats into an
  // array); comma-separated values are also split.
  const rawEpisode = args.episode;
  const episodeIds = rawEpisode === undefined || rawEpisode === true
    ? undefined
    : (Array.isArray(rawEpisode) ? rawEpisode : [rawEpisode])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
  return {
    episodesPath: args.episodes ? path.resolve(args.episodes) : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl"),
    episodeIds,
    limit: nonNegativeInt(args.limit, DEFAULT_LIMIT),
    concurrency: Math.max(1, nonNegativeInt(args.concurrency, DEFAULT_CONCURRENCY)),
    models: resolveJudgeModels(args.models),
    outputDir: args.output ? path.resolve(args.output) : path.join(home, ".pi", ".pi-astack", "t0-eval"),
    modelsJsonPath: args["models-json"] ? path.resolve(args["models-json"]) : path.join(agentDir, "models.json"),
    maxRetries: nonNegativeInt(args["max-retries"], DEFAULT_MAX_RETRIES),
    timeoutMs: nonNegativeInt(args["timeout-ms"], DEFAULT_TIMEOUT_MS),
    resume: args["no-resume"] !== true,
    quiet: args.quiet === true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const episodes = loadEpisodes(options.episodesPath);
  const selected = selectEpisodes(episodes, { episodeIds: options.episodeIds, limit: options.limit });
  if (selected.length === 0) {
    console.error(`t0-eval: no episodes selected (${episodes.length} available, limit=${options.limit}, episode=${options.episodeIds?.join(",") ?? "any"})`);
    process.exit(2);
  }
  console.log(`t0-eval: ${selected.length}/${episodes.length} episodes, judges=${options.models.all.join(",")}, concurrency=${options.concurrency}, output=${options.outputDir}`);

  const invoker = await makeJudgeInvoker({ modelsJsonPath: options.modelsJsonPath });
  const records = [];
  const queue = [...selected];
  const workers = Array.from({ length: Math.min(options.concurrency, selected.length) }, async () => {
    while (queue.length > 0) {
      const episode = queue.shift();
      const record = await evaluateEpisode(invoker, episode, options.models, options);
      records.push(record);
      const s = record.summary;
      console.log(`  ${record.episode_id}: calls=${s.calls} cost=$${s.cost.toFixed(4)} unresolved=${s.unresolved.length} errors=${s.errors.length} complete=${s.complete}`);
    }
  });
  await Promise.all(workers);

  // Write per-episode records, then regenerate the index + summary from ALL
  // eval/*.json records in the output dir (cumulative state — a subset resume
  // run must never clobber the state of episodes it did not touch).
  const evalDir = path.join(options.outputDir, "eval");
  for (const record of records) {
    writeJsonFile(path.join(evalDir, `${record.episode_id}.json`), record);
  }
  const allRecords = scanEvalRecords(options.outputDir);
  const indexFile = path.join(options.outputDir, "eval-index.jsonl");
  fs.rmSync(indexFile, { force: true });
  for (const record of allRecords) {
    appendJsonl(indexFile, {
      schema_version: EVAL_SCHEMA_VERSION,
      episode_id: record.episode_id,
      content_hash: record.content_hash,
      candidate_ids: record.candidate_ids,
      judge_models: record.judge_models,
      summary: record.summary,
      path: path.join("eval", `${record.episode_id}.json`),
    });
  }

  const totalCalls = allRecords.reduce((sum, r) => sum + (r.summary?.calls ?? 0), 0);
  const newCalls = records.reduce((sum, r) => sum + (r.summary?.new_calls ?? 0), 0);
  const totalCost = allRecords.reduce((sum, r) => sum + (r.summary?.cost ?? 0), 0);
  const costBreakdown = allRecords.reduce(
    (acc, r) => {
      acc.provider += r.summary?.cost_breakdown?.provider ?? 0;
      acc.estimated += r.summary?.cost_breakdown?.estimated ?? 0;
      acc.unknown += r.summary?.cost_breakdown?.unknown ?? 0;
      return acc;
    },
    { provider: 0, estimated: 0, unknown: 0 },
  );
  // cost_source is derived from the distinct per-record sources so it always
  // agrees with the breakdown columns (provider / estimated / unknown).
  const costSources = new Set(allRecords.map((r) => r.summary?.cost_source).filter(Boolean));
  const cost_source = costSources.size === 0 ? null : costSources.size === 1 ? [...costSources][0] : "mixed";
  const unresolved = allRecords.flatMap((r) => (r.summary?.unresolved ?? []).map((u) => ({ episode_id: r.episode_id, candidate_id: u.candidate_id })));
  const errors = allRecords.flatMap((r) => r.summary?.errors ?? []);
  const complete = allRecords.filter((r) => r.summary?.complete).length;
  const summary = {
    schema_version: EVAL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    episodes_path: options.episodesPath,
    episodes_available: episodes.length,
    episodes_evaluated: allRecords.length,
    episodes_complete: complete,
    episodes_in_run: records.length,
    judge_models: options.models,
    calls: totalCalls,
    new_calls: newCalls,
    cost: totalCost,
    cost_source,
    cost_breakdown: costBreakdown,
    unresolved,
    errors,
    output: {
      eval_dir: evalDir,
      index: indexFile,
      checkpoints: path.join(options.outputDir, "checkpoints"),
    },
  };
  writeJsonFile(path.join(options.outputDir, "summary.json"), summary);

  console.log(`\nt0-eval done: ${records.length} episodes this run (${allRecords.length} cumulative), ${totalCalls} calls, cost $${totalCost.toFixed(4)} (${summary.cost_source ?? "n/a"}), ${complete} complete, ${errors.length} stage errors, ${unresolved.length} unresolved`);
  console.log(`output: ${options.outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`t0-eval failed: ${err.message}`);
    process.exit(1);
  });
}
