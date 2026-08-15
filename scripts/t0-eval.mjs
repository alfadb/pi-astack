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
 *
 * Strict raw CLI: only the space form (`--flag value` / bare `--bool`) is
 * accepted. Unknown flags, positional tokens, `--flag=value` forms,
 * duplicate non-repeatable flags, value-less value flags, boolean flags
 * with a value, malformed numerics (abc/negative/decimal) and
 * whitespace/comma-semantic-empty values all fail closed — a malformed
 * argv never silently falls back to the production defaults.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  EVAL_SCHEMA_VERSION,
  ATTEMPT_LEDGER_VERSION,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
  DEFAULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  parseStrictCli,
  nonNegativeInt,
  isSafeDecimal,
  NONNEGATIVE_DECIMAL_RE,
  POSITIVE_DECIMAL_RE,
  loadEpisodes,
  assertProducerBodyEpisodes,
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
  STAGE_SYSTEM_PROMPTS,
  CORRECTIVE_HINTS,
  sumAttemptCosts,
  aggregateCostSource,
  summarizeCosts,
  sha256Hex,
  buildStageTool,
  dedupeAttempts,
  filterCheckpointForResume,
  EVAL_CHECKPOINT_STAGE_KEYS,
  EVAL_CHECKPOINT_STAGE_ROLE,
  STAGE_ROLE_KEYS,
  scanEvalRecords,
  buildEvalSummaryFromStages,
  loadCommittedEvalGeneration,
  loadEvalPublicationIntent,
  clearEvalPublicationIntent,
  evalIntentMatchesCommitted,
  planEvalPublicationRecovery,
  publishEvalGeneration,
  mergeEvalRecords,
  assertEvalRecoveryIntentIdentity,
  deepEqual,
  REPLAY_EVAL_JUDGE_MODELS_CSV,
  sleep,
  summarizeFailedOutput,
  loadReplayEvalCorpus,
  resolveReplayEvalBinding,
} from "./t0-eval-common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Re-export the common corpus loader so offline smoke / wrappers keep a
// stable import surface on t0-eval.mjs. Capability mint + disk-write gate
// live ONLY in t0-eval-common.mjs.
export { loadReplayEvalCorpus };

/**
 * Publish a REPLAY eval generation. Thin wrapper: rejects bare
 * replayDatasetGenerationId and forwards the binding to the common sole
 * disk-writer authority (publishEvalGeneration). All corpus/judge/capability
 * verification happens inside common — this wrapper never injects a raw id.
 */
export function publishReplayEvalGeneration(args = {}) {
  if (Object.prototype.hasOwnProperty.call(args, "replayDatasetGenerationId")
    && args.replayDatasetGenerationId !== undefined) {
    throw new Error("publishReplayEvalGeneration: do not pass bare replayDatasetGenerationId; supply replayBinding from loadReplayEvalCorpus");
  }
  return publishEvalGeneration(args);
}

// ── prompts ──────────────────────────────────────────────────────────────

// The four COMPLETE stage system prompts (ANON_RULES + stage definition +
// full JSON example) AND the four stage corrective hints live in
// t0-eval-common.mjs as the frozen exported STAGE_SYSTEM_PROMPTS /
// CORRECTIVE_HINTS — the judge protocol hash binds their body, so a
// system-prompt OR corrective-hint semantic edit changes the hash and
// invalidates every old checkpoint/record (no manual revision bump can be
// missed). t0-eval.mjs imports them and keeps NO local duplicate. ANON_RULES
// is delivered TWICE per stage — as part of the system prompt (complete,
// with the full JSON example) AND as the authoritative protocol prefix of
// the user payload (compressed, semantics + enumerations complete, no JSON
// example) via buildJudgeUserContent. The user-payload copy is the fallback
// that keeps the protocol alive when a provider intermittently drops the
// system message.

// ── pipeline ─────────────────────────────────────────────────────────────

/**
 * Stage-specific corrective hints: models that drift into prose or answer the
 * task instead of producing the evaluation report are steered back with the
 * exact required structure (the full example lives in the stage prompt). The
 * four COMPLETE hints live in t0-eval-common.mjs as the frozen exported
 * CORRECTIVE_HINTS — the judge protocol hash binds their body, so a
 * corrective-hint semantic edit changes the hash and invalidates every old
 * checkpoint/record. t0-eval.mjs imports them and keeps NO local duplicate.
 */

/**
 * Rebind the accepted-output hash of a stage's LATEST ok=true ledger entry to
 * the STORED stage data. runStage binds the hash to its normalized result;
 * the evaluator index injection (evaluator_0 → 0 / evaluator_1 → 1) happens
 * afterwards, so the binding is recomputed over the final data — the exact
 * value every validator re-derives from stage.data. Idempotent for stages
 * whose data is unchanged.
 */
function bindAcceptedHash(stage) {
  if (!stage?.ok || !stage.data) return stage;
  const hash = sha256Hex(JSON.stringify(stage.data));
  const log = stage.attempt_log;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.ok === true) {
      log[i].accepted_output_hash = hash;
      break;
    }
  }
  return stage;
}

/**
 * Skipped stage (upstream failed / missing): inherits the prior same-model
 * history ledger (attempts/cost/source preserved — cascade drops the stage,
 * never the real paid attempts), new_attempts=0. A later success re-runs the
 * stage and appends the new success as the LAST ledger entry. The `stage`
 * field is the REAL role (evaluator_0/1 → "evaluator", the rest same name).
 */
function skippedStage(stageName, error, modelRef, attemptHistory) {
  const histLog = attemptHistory[stageName] ?? [];
  const summary = summarizeCosts(histLog);
  return {
    stage: EVAL_CHECKPOINT_STAGE_ROLE[stageName],
    ok: false,
    error,
    modelRef,
    attempts: histLog.length,
    new_attempts: 0,
    usage: null,
    cost: summary.cost,
    cost_source: summary.cost_source,
    attempt_log: histLog,
  };
}

/**
 * Pending stage (same-model history exists but the stage was cascade-dropped
 * or never ran): a failed stage that carries the prior same-model history
 * ledger (attempts/cost/source recomputed from it), new_attempts=0, no data.
 * Materialized BEFORE any provider call/save so every incremental checkpoint
 * keeps a precise history↔stage closure — the paid downstream history is
 * never dropped from disk even if the process crashes before the stage
 * re-runs. A later run replaces it: a success appends the new success as the
 * LAST ledger entry, an upstream failure replaces it with skippedStage — both
 * carry the same ledger. The `stage` field is the REAL role.
 */
function pendingStage(stageName, modelRef, histLog) {
  const summary = summarizeCosts(histLog);
  return {
    stage: EVAL_CHECKPOINT_STAGE_ROLE[stageName],
    ok: false,
    error: "pending rerun: dependency or prior failure",
    modelRef,
    attempts: histLog.length,
    new_attempts: 0,
    usage: null,
    cost: summary.cost,
    cost_source: summary.cost_source,
    attempt_log: histLog,
  };
}

/**
 * Materialize pending stages: every legal same-model stage that exists in
 * attemptHistory but not in the resumable stages dict (cascade-dropped by
 * filterCheckpointForResume, or never ran) becomes a pending failed stage
 * carrying its history. This runs right after the filter and before any
 * provider call/save, so the FIRST incremental save already writes the full
 * downstream history to disk — a crash there can never lose it.
 */
function materializePendingStages(stages, attemptHistory, judgeModels) {
  for (const stageName of EVAL_CHECKPOINT_STAGE_KEYS) {
    if (stageName in stages) continue;
    const histLog = attemptHistory[stageName];
    if (!Array.isArray(histLog)) continue;
    const roleKey = STAGE_ROLE_KEYS[stageName];
    const roleModel = roleKey ? judgeModels?.[roleKey] : null;
    if (!roleModel) continue;
    stages[stageName] = pendingStage(stageName, roleModel, histLog);
  }
  return stages;
}

/**
 * One stage with bounded corrective retries. Failures are classified:
 *   - content/schema failures (parse, schema, empty, truncated) retry with a
 *     stage-specific corrective hint that includes the ORIGINAL error summary
 *     (never lost);
 *   - transport failures (auth, HTTP, 429, timeout — the call itself failed,
 *     the model's answer was never wrong) retry with backoff and NO
 *     corrective hint.
 * Every actual provider request is recorded in `attempt_log` with its
 * request_id, parse/schema error, error class, usage, provider-reported cost
 * (estimation only as fallback, marked) and normalization changes —
 * first-attempt rejections are fully diagnosable. The actual request entries
 * in callJudge's `attempt_log` are the SOLE provider-call fact: each keeps
 * its request_id/usage/cost/error_class, and the outer layer adds the
 * protocol attempt index, parse/schema validation, normalized_changes and a
 * bounded (<=2KB) raw-output / parsed summary (`raw_output`) for failed
 * attempts (the judge body is de-identified by construction, so it never
 * carries sidecar identity material).
 * `priorAttempts` (from the checkpoint's cross-run `attempt_history`) are
 * prepended to the log so a failed stage's earlier attempts survive a resume;
 * `new_attempts` counts only actual requests made in this invocation.
 * Pre-request failures (invalid ref / model not found / auth — callJudge
 * returns an empty ledger) return a stage error immediately with
 * priorAttempts untouched and new_attempts=0: the failure is deterministic,
 * so corrective/transport retries cannot help.
 * Structured output (json_schema constrained sampling) is used when the
 * project API supports it; the corrective-retry loop remains the safety net.
 */
export async function runStage(invoker, modelRef, prompt, feed, { stage, episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts = [] }) {
  const tool = buildStageTool(stage);
  // Cross-run attempt history: prior attempts from earlier runs (a failed
  // stage re-runs on resume) are kept so their usage/cost are never lost.
  const attemptLog = [...priorAttempts];
  let newAttempts = 0; // actual requests made in THIS invocation (prior attempts are not re-counted)
  let lastError = null;
  let lastUsage = null;
  let contentFailed = false;
  let lastErrors = null; // specific validation errors from the previous attempt
  let lastParseError = null; // original parse error summary from the previous attempt
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
    // Pre-request failure (invalid ref / model not found / auth): NO actual
    // provider request was made (empty ledger). The failure is deterministic
    // — retrying cannot help — so return the stage error immediately with
    // priorAttempts untouched and new_attempts=0 (episode summary
    // calls/new_calls stay 0 for this stage).
    if (result.attempt_log.length === 0) {
      return {
        stage,
        ok: false,
        error: result.error ?? "pre-request failure",
        modelRef,
        attempts: attemptLog.length,
        new_attempts: 0,
        usage: null,
        cost: sumAttemptCosts(attemptLog),
        cost_source: aggregateCostSource(attemptLog),
        attempt_log: dedupeAttempts(attemptLog),
      };
    }
    // The actual request entries in result.attempt_log are the SOLE
    // provider-call fact (0 or 1 with maxRetries:0). Each keeps its
    // request_id/usage/cost/error_class; the outer layer adds the protocol
    // attempt index, parse/schema validation, normalized_changes and the
    // bounded raw_output for failed attempts.
    for (const entry of result.attempt_log) {
      newAttempts++;
      let normalized = null;
      let changes = [];
      let validation = null;
      let parseError = null;
      if (entry.ok) {
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
      const attemptOk = Boolean(entry.ok) && Boolean(normalized) && Boolean(validation?.ok);
      const attemptError = !entry.ok
        ? entry.error
        : parseError
          ? `JSON parse failed: ${parseError}`
          : validation && !validation.ok
            ? `schema validation failed: ${validation.errors.join("; ")}`
            : null;
      // Failure class: "transport" (auth/HTTP/429/timeout — the call itself
      // failed, the model's answer was never wrong) vs "content" (parse/schema/
      // empty/truncated — the model's answer was rejected).
      const errorClass = !entry.ok
        ? (entry.error_class ?? "content")
        : parseError || (validation && !validation.ok)
          ? "content"
          : null;
      attemptLog.push({
        ...entry,
        attempt,
        ok: attemptOk,
        error: attemptError,
        error_class: errorClass,
        normalized_changes: changes,
        structured: result.structured ?? false,
        // The accepted output hash binds the ledger entry to the semantic
        // result that was actually accepted (sha256 of the normalized stage
        // data). Rejected attempts (transport/content/schema/parse) keep
        // callJudge's null — a rejected request never claims a result.
        ...(attemptOk ? { accepted_output_hash: sha256Hex(JSON.stringify(normalized)) } : {}),
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
          usage: entry.usage,
          cost: sumAttemptCosts(finalLog),
          cost_source: aggregateCostSource(finalLog),
          attempt_log: finalLog,
        };
      }
      lastError = attemptError;
      lastUsage = entry.usage;
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
  // Replay-dataset binding: ONLY a real loadReplayEvalCorpus capability
  // (options.replayBinding) is accepted. A bare forged
  // options.replayDatasetGenerationId is an explicit API rejection — never a
  // silent fallthrough. Normal mode (no binding) is byte-identical to the
  // legacy path.
  if (Object.prototype.hasOwnProperty.call(options ?? {}, "replayDatasetGenerationId")
    && options.replayDatasetGenerationId !== undefined) {
    throw new Error("evaluateEpisode: do not pass bare replayDatasetGenerationId; supply options.replayBinding from loadReplayEvalCorpus");
  }
  // Replay-mode episode without a binding: a dataset_mode=replay episode is
  // ONLY evaluable under a real loadReplayEvalCorpus capability. Omitting the
  // binding must fail BEFORE any checkpoint/feed/invoker work — a replay
  // episode evaluated as a normal episode would silently drop the committed
  // replay dataset binding (and produce a normal record for replay evidence).
  if (episode?.dataset_mode === "replay"
    && (options?.replayBinding === undefined || options?.replayBinding === null)) {
    throw new Error("evaluateEpisode: episode has dataset_mode=replay but no replayBinding — supply options.replayBinding from loadReplayEvalCorpus");
  }
  let replayDatasetGenerationId = null;
  if (options?.replayBinding !== undefined && options?.replayBinding !== null) {
    const ctx = resolveReplayEvalBinding(options.replayBinding);
    if (!ctx) {
      throw new Error("evaluateEpisode: replayBinding is not a capability produced by loadReplayEvalCorpus");
    }
    const episodeIdProbe = episode?.episode_id;
    const contentHashProbe = episodeContentHash(episode);
    // Member/hash lookup via the FROZEN ordered arrays only — the private
    // context never exposes a mutable container (a frozen Map would still
    // accept map.set, letting a resolved context inject foreign members).
    const memberIndex = ctx.orderedEpisodeIds.indexOf(episodeIdProbe);
    const expectedHash = memberIndex === -1 ? undefined : ctx.orderedContentHashes[memberIndex];
    if (expectedHash === undefined || expectedHash !== contentHashProbe) {
      throw new Error(`evaluateEpisode: episode ${JSON.stringify(episodeIdProbe)} is not a member of the bound replay corpus (or content hash mismatch)`);
    }
    if (!deepEqual(judgeModels, ctx.judgeModels)) {
      throw new Error("evaluateEpisode: judgeModels must be the fixed replay judge roles bound by loadReplayEvalCorpus");
    }
    replayDatasetGenerationId = ctx.generationId;
  }
  const episodeId = episode.episode_id;
  const contentHash = episodeContentHash(episode);
  const protocolHash = buildJudgeProtocolHash(replayDatasetGenerationId);
  const schemaHash = buildJudgeSchemaHash();
  const feed = buildJudgeFeed(episode);
  const candidateIds = (episode.slots ?? []).map((s) => s.model_id);
  // Checkpoint context: load/save bind every ok stage to THIS episode + the
  // CURRENT role assignment (data.episode_id, evaluator index, stage.modelRef,
  // accepted output hash) — a checkpoint whose stages belong to another
  // episode/index/role is never resumed and never written. In replay mode
  // the checkpoint is also bound to the committed replay dataset generation.
  const cpOpts = {
    protocolHash,
    schemaHash,
    expectedEpisodeId: episodeId,
    candidateIds,
    judgeModels,
    expectedReplayDatasetGenerationId: replayDatasetGenerationId,
  };

  const existing = resume ? loadCheckpoint(outputDir, episodeId, contentHash, cpOpts) : null;
  // Cross-run attempt history: failed stages re-run on resume keep their
  // earlier attempts (usage/cost) via the checkpoint's attempt_history — but
  // ONLY when the stage's role model is unchanged: attempts made by a
  // different model belong to that model's paid requests and must never be
  // attributed to the new model. filterCheckpointForResume drops both
  // mismatched completed stages and their history in one pass; same-model
  // failed history is kept so it continues accumulating.
  const { stages, attemptHistory } = existing
    ? filterCheckpointForResume(existing, judgeModels)
    : { stages: {}, attemptHistory: {} };
  // Materialize pending stages BEFORE any provider call/save: same-model
  // attempt history whose stage was cascade-dropped (or never ran) becomes a
  // pending failed stage carrying its history, so the FIRST incremental save
  // already writes the full downstream history to disk — a crash there can
  // never lose the paid downstream attempts.
  materializePendingStages(stages, attemptHistory, judgeModels);
  let newCalls = 0; // calls made in THIS run (checkpointed stages are not re-counted)

  const log = (msg) => { if (!quiet) console.log(`  [${episodeId}] ${msg}`); };

  // Checkpoint saves happen incrementally (crash-safe). The attempt history
  // is passed in FULL: every history entry has a materialized stage (and
  // every stage's log is merged back into the history by saveCheckpoint), so
  // each saved body keeps a precise history↔stage closure and self-validates.
  const save = () => {
    saveCheckpoint(outputDir, episodeId, contentHash, stages, attemptHistory, cpOpts);
  };


  // Stage 1: two independent evaluators (parallel). Each missing evaluator
  // re-runs independently — a successful evaluator is never re-run on resume
  // (zero new calls for it).
  const needE0 = stages.evaluator_0?.ok !== true;
  const needE1 = stages.evaluator_1?.ok !== true;
  if (needE0 || needE1) {
    log(`evaluating (${judgeModels.evaluator0}, ${judgeModels.evaluator1})`);
    const [e0, e1] = await Promise.all([
      needE0
        ? runStage(invoker, judgeModels.evaluator0, STAGE_SYSTEM_PROMPTS.evaluator, feed, { stage: "evaluator", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.evaluator_0 ?? [] })
        : stages.evaluator_0,
      needE1
        ? runStage(invoker, judgeModels.evaluator1, STAGE_SYSTEM_PROMPTS.evaluator, feed, { stage: "evaluator", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.evaluator_1 ?? [] })
        : stages.evaluator_1,
    ]);
    if (needE0) {
      stages.evaluator_0 = bindAcceptedHash({ ...e0, data: e0.data ? { ...e0.data, evaluator_index: 0 } : null });
      newCalls += e0.new_attempts;
    }
    if (needE1) {
      stages.evaluator_1 = bindAcceptedHash({ ...e1, data: e1.data ? { ...e1.data, evaluator_index: 1 } : null });
      newCalls += e1.new_attempts;
    }
    save();
  }

  // Stage 2: adversarial verifier (needs both evaluations).
  if (stages.verifier?.ok !== true) {
    const bothOk = stages.evaluator_0?.ok === true && stages.evaluator_1?.ok === true;
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
      stages.verifier = await runStage(invoker, judgeModels.verifier, STAGE_SYSTEM_PROMPTS.verifier, verifierFeed, { stage: "verifier", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.verifier ?? [] });
      newCalls += stages.verifier.new_attempts;
      save();
    } else {
      // Skipped stage (upstream failed / missing): the stage inherits the
      // prior same-model history ledger instead of writing an empty one — a
      // cascade drop keeps the real cost its earlier runs paid (history-stage
      // precise closure), and new_attempts=0 (nothing called this run).
      // A later success re-runs the stage and appends the new success as the
      // LAST ledger entry.
      stages.verifier = skippedStage("verifier", "skipped: one or both evaluations failed", judgeModels.verifier, attemptHistory);
    }
  }

  // Stage 3: adjudicator (needs episode + evaluations + verifier).
  if (stages.adjudicator?.ok !== true) {
    const evalsOk = stages.evaluator_0?.ok === true && stages.evaluator_1?.ok === true;
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
      stages.adjudicator = await runStage(invoker, judgeModels.adjudicator, STAGE_SYSTEM_PROMPTS.adjudicator, adjudicatorFeed, { stage: "adjudicator", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.adjudicator ?? [] });
      newCalls += stages.adjudicator.new_attempts;
      save();
    } else {
      stages.adjudicator = skippedStage("adjudicator", "skipped: one or both evaluations failed", judgeModels.adjudicator, attemptHistory);
    }
  }

  // Stage 4: counterfactual judge (needs episode + adjudicator verdicts).
  if (stages.counterfactual?.ok !== true) {
    if (stages.adjudicator?.ok === true) {
      log("counterfactual");
      const counterfactualFeed = [
        feed,
        "",
        "## Adjudicator verdicts",
        JSON.stringify(stages.adjudicator.data, null, 2),
      ].join("\n");
      stages.counterfactual = await runStage(invoker, judgeModels.counterfactual, STAGE_SYSTEM_PROMPTS.counterfactual, counterfactualFeed, { stage: "counterfactual", episodeId, candidateIds, maxRetries, timeoutMs, quiet, priorAttempts: attemptHistory.counterfactual ?? [] });
      newCalls += stages.counterfactual.new_attempts;
      save();
    } else {
      stages.counterfactual = skippedStage("counterfactual", "skipped: adjudicator failed", judgeModels.counterfactual, attemptHistory);
    }
  }

  const record = {
    schema_version: EVAL_SCHEMA_VERSION,
    ledger_version: ATTEMPT_LEDGER_VERSION,
    episode_id: episodeId,
    content_hash: contentHash,
    protocol_hash: protocolHash,
    schema_hash: schemaHash,
    // Replay-dataset binding: the record carries the field ONLY in replay
    // mode (normal records stay byte-identical, no unexpected field).
    ...(replayDatasetGenerationId !== null && replayDatasetGenerationId !== undefined
      ? { replay_dataset_generation_id: replayDatasetGenerationId }
      : {}),
    dataset_mode: episode.dataset_mode ?? null,
    model_count: episode.model_count ?? null,
    candidate_ids: (episode.slots ?? []).map((s) => s.model_id),
    judge_models: { ...judgeModels },
    stages,
    // Shared summary constructor: the record's summary is recomputed from its
    // own stage ledgers/data (new_calls is the run fact passed through), so
    // the cumulative scan/aggregate can never accept a forged total.
    summary: buildEvalSummaryFromStages(stages, { episodeId, newCalls }),
  };
  save();
  return record;
}

// ── CLI ─────────────────────────────────────────────────────────────────

/** Closed allowlist of value-bearing raw CLI flags for t0-eval. */
const T0_EVAL_VALUE_FLAGS = Object.freeze([
  "episodes", "episode", "limit", "concurrency", "models", "output",
  "models-json", "max-retries", "timeout-ms", "replay-dataset",
]);
/** Closed allowlist of boolean raw CLI flags for t0-eval. */
const T0_EVAL_BOOLEAN_FLAGS = Object.freeze(["no-resume", "quiet"]);
/** Value flags that may repeat and accumulate (space form only). */
const T0_EVAL_REPEATABLE_VALUE_FLAGS = Object.freeze(["episode"]);
const T0_EVAL_NON_NEG_INT_FLAGS = new Set(["limit", "max-retries"]);
const T0_EVAL_POS_INT_FLAGS = new Set(["concurrency", "timeout-ms"]);

function assertNonNegativeIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, NONNEGATIVE_DECIMAL_RE)) {
    throw new Error(`t0-eval: --${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

function assertPositiveIntRaw(flag, value) {
  if (typeof value !== "string" || !isSafeDecimal(value, POSITIVE_DECIMAL_RE)) {
    throw new Error(`t0-eval: --${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * Export the pure CLI arg parser (parseStrictCli + raw value gates only —
 * no I/O, no invoker) so the offline smoke suite can assert negative CLI
 * behavior without subprocess spawns.
 */
export function parseArgs(argv) {
  const args = parseStrictCli(argv, {
    valueFlags: T0_EVAL_VALUE_FLAGS,
    booleanFlags: T0_EVAL_BOOLEAN_FLAGS,
    repeatableValueFlags: T0_EVAL_REPEATABLE_VALUE_FLAGS,
  });
  // Raw value gates: numeric flags must be well-formed integers (no
  // abc/negative/decimal silent fallback), every other supplied value must
  // be non-empty after trim (paths may contain internal spaces, pure
  // whitespace is rejected) — a malformed argv can never silently resolve
  // the production default paths/roles.
  for (const [key, raw] of Object.entries(args)) {
    if (raw === true) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (T0_EVAL_NON_NEG_INT_FLAGS.has(key)) {
        assertNonNegativeIntRaw(key, value);
      } else if (T0_EVAL_POS_INT_FLAGS.has(key)) {
        assertPositiveIntRaw(key, value);
      } else if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`t0-eval: --${key} requires a non-empty value`);
      }
    }
  }
  // Explicit CSV flags (--episode / --models): every comma segment must be
  // semantically non-empty after trim — `,`, `,,`, `a,,b` fail closed
  // instead of silently dropping empty segments. Repeated --episode flags
  // still accumulate (parseStrictCli repeatable).
  for (const key of ["episode", "models"]) {
    const raw = args[key];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const segments = String(value).split(",").map((s) => s.trim());
      if (segments.some((s) => s.length === 0)) {
        throw new Error(`t0-eval: --${key} requires a non-empty comma-separated value (each segment must be non-empty), got ${JSON.stringify(value)}`);
      }
    }
  }
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  // Repeated --episode flags accumulate (parseStrictCli turns repeats into
  // an array); comma-separated values are also split. The CSV gate above
  // guarantees every segment is non-empty.
  const rawEpisode = args.episode;
  const episodeIds = rawEpisode === undefined
    ? undefined
    : (Array.isArray(rawEpisode) ? rawEpisode : [rawEpisode])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim());
  // Replay mode: the corpus is the FROZEN committed replay dataset
  // (--replay-dataset <dir>), mutually exclusive with --episodes — the
  // replay eval consumes ONLY the committed dataset, never raw episodes.
  // No direct generation-id CLI/env exists: the id is derived solely from
  // loadCommittedReplayDataset(dir) after parse.
  const rawReplayDataset = args["replay-dataset"];
  const replayDatasetDir = rawReplayDataset ? path.resolve(rawReplayDataset) : null;
  if (replayDatasetDir && args.episodes) {
    throw new Error("--replay-dataset and --episodes are mutually exclusive (replay eval consumes ONLY the committed replay dataset)");
  }
  // Replay mode pins the judge roles to the replay experiment's exact
  // roles; any different --models fails BEFORE any invoker (an identical
  // explicit value is accepted). Default models resolve ONLY when the flag
  // is completely absent (parseStrictCli guarantees a supplied --models is
  // a single non-empty CSV).
  let models;
  if (replayDatasetDir) {
    const replayModels = resolveJudgeModels(REPLAY_EVAL_JUDGE_MODELS_CSV);
    if (args.models !== undefined) {
      const explicit = resolveJudgeModels(args.models);
      if (!deepEqual(explicit, replayModels)) {
        throw new Error(`--replay-dataset requires the fixed replay judge roles (${REPLAY_EVAL_JUDGE_MODELS_CSV}) — a different --models is rejected before any invoker`);
      }
      models = explicit;
    } else {
      models = replayModels;
    }
  } else {
    models = resolveJudgeModels(args.models);
  }
  return {
    episodesPath: args.episodes ? path.resolve(args.episodes) : (replayDatasetDir ? null : path.join(home, ".pi", ".pi-astack", "t0-episodes", "episodes.jsonl")),
    replayDatasetDir,
    episodeIds,
    limit: nonNegativeInt(args.limit, DEFAULT_LIMIT),
    concurrency: Math.max(1, nonNegativeInt(args.concurrency, DEFAULT_CONCURRENCY)),
    models,
    outputDir: args.output ? path.resolve(args.output) : path.join(home, ".pi", ".pi-astack", "t0-eval"),
    modelsJsonPath: args["models-json"] ? path.resolve(args["models-json"]) : path.join(agentDir, "models.json"),
    maxRetries: nonNegativeInt(args["max-retries"], DEFAULT_MAX_RETRIES),
    timeoutMs: nonNegativeInt(args["timeout-ms"], DEFAULT_TIMEOUT_MS),
    resume: args["no-resume"] !== true,
    quiet: args.quiet === true,
  };
}

/**
 * Decide what this run evaluates — the SINGLE shared run-planning function
 * used by main() and directly testable offline (the smoke suite tests this
 * real function, so removing the recovery wiring from main() goes red).
 * Four explicit states, in priority order:
 *   - committed generation exists AND (no intent OR the intent exactly
 *     matches the committed generation — a stale same-generation intent):
 *     normal CLI selection (--episode/--limit);
 *   - committed generation exists BUT the intent does NOT match it (the
 *     intent's generation_id differs — an UNFINISHED publication whose
 *     intent was written before the old marker was revoked): RECOVERY mode —
 *     the run COMPLETES the interrupted publication's target generation
 *     with ZERO provider work: --episode/--limit are completely ignored,
 *     every target is rebuilt to its EXACT record (from an exact raw record
 *     or a complete current-protocol/model/episode checkpoint via
 *     planEvalPublicationRecovery), and any target that cannot be rebuilt
 *     with zero calls throws here (fail closed BEFORE any invoker). The
 *     committed marker is NEVER the authoritative target — the old A records
 *     can only enter via the exact recovered set. `resume: false`
 *     (--no-resume) is explicitly rejected in recovery mode: recovery
 *     REQUIRES the checkpoint/raw exact-rebuild semantics, and the flag must
 *     never be able to trigger a paid re-run of an interrupted publication;
 *   - marker MISSING + intent: recovery mode (same semantics as above);
 *   - marker MISSING + no intent: normal CLI selection (legacy raw-recovery
 *     baseline).
 * `checkpoints` (Map episode_id -> loaded checkpoint or null) is the
 * caller's preflight-loaded per-target checkpoint set (recovery mode only).
 * Returns { mode: "normal" | "recovery", selected, recoveredRecords } where
 * recoveredRecords is the exact already-written/rebuildable target set
 * (recovery mode only, null otherwise) and selected is ALWAYS empty in
 * recovery mode (zero provider work).
 */
export function planEvalRun({ episodes, existingRecords, committed, recoveryIntent, episodeIds, limit, judgeModels = null, checkpoints = null, resume = true, replayDatasetGenerationId = null }) {
  if (committed && (!recoveryIntent || evalIntentMatchesCommitted(recoveryIntent, committed))) {
    return { mode: "normal", selected: selectEpisodes(episodes, { episodeIds, limit }), recoveredRecords: null };
  }
  if (recoveryIntent) {
    if (resume !== true) {
      throw new Error("planEvalRun: --no-resume is not allowed in recovery mode (recovery rebuilds the exact intent target records from checkpoints/raw with zero provider calls)");
    }
    const plan = planEvalPublicationRecovery({
      episodes,
      existingRecords,
      intent: recoveryIntent,
      judgeModels,
      checkpoints,
      replayDatasetGenerationId,
    });
    return { mode: "recovery", selected: plan.episodesToEvaluate, recoveredRecords: plan.recoveredRecords };
  }
  return { mode: "normal", selected: selectEpisodes(episodes, { episodeIds, limit }), recoveredRecords: null };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Strict corpus: the eval pipeline must never accept a record for an
  // episode that is not a real, well-formed body of the loaded corpus.
  // Replay mode: the corpus is the FROZEN committed replay dataset — load
  // it via loadReplayEvalCorpus (before any output mutation / invoker) and
  // mint a private capability token. evaluateEpisode / publish accept ONLY
  // the capability; the scalar generation id extracted from the private
  // context is passed to common plan/assert/load helpers, never as a bare
  // forgeable producer option. The episodesPath written into the summary is
  // the canonical locator `${datasetDir}/episodes.jsonl` and is NEVER
  // re-read (the bodies come from the loader).
  let episodes;
  let episodesPath = options.episodesPath;
  let replayBinding = null;
  let replayDatasetGenerationId = null;
  if (options.replayDatasetDir) {
    const corpus = await loadReplayEvalCorpus(options.replayDatasetDir);
    episodes = corpus.episodes;
    episodesPath = corpus.episodesPath;
    replayBinding = corpus.replayBinding;
    // Scalar extracted from the loader result for common plan/assert/load
    // only — never injected into evaluateEpisode / publish as a bare option.
    replayDatasetGenerationId = corpus.generationId;
    options.replayBinding = replayBinding;
    options.episodesPath = episodesPath;
  } else {
    episodes = loadEpisodes(options.episodesPath, { strict: true });
    // Normal --episodes corpus must never carry replay-mode bodies: those
    // require --replay-dataset (committed replay loader + capability).
    const replayIds = episodes
      .filter((e) => e?.dataset_mode === "replay")
      .map((e) => e.episode_id);
    if (replayIds.length > 0) {
      throw new Error(
        `t0-eval: normal --episodes corpus contains dataset_mode=replay episode(s) ${JSON.stringify(replayIds.slice(0, 8))}${replayIds.length > 8 ? ` (+${replayIds.length - 8} more)` : ""}; use --replay-dataset for replay evaluation`,
      );
    }
    // Normal-corpus body gate: right after the strict load + replay
    // rejection, the corpus must be ONE valid producer body episode set
    // (exact own key closure, unified legal dataset_mode, producer id
    // shapes, per-slot contract, derived join_confidence / model_count,
    // mode-specific missing_evidence). This runs BEFORE scanEvalRecords /
    // intent / any output mutation / makeJudgeInvoker — a malformed or
    // drifted body fails closed with zero invoker work. Replay-committed
    // corpora never pass through this normal validator.
    assertProducerBodyEpisodes(episodes);
  }
  // Preflight BEFORE any invoker/provider work (zero invoker on any
  // malformed/stale/tampered record or manifest):
  //   1. scanEvalRecords — the writer's fail-closed raw diagnostic over
  //      EVERY eval/*.json (including valid records the committed manifest
  //      does not list — uncommitted recovery material); in replay mode
  //      every record must carry the exact committed replay dataset
  //      generation id (markerless old raw records fail closed);
  //   2. loadCommittedEvalGeneration — when a summary.json exists, the
  //      committed generation must verify completely (closed key sets,
  //      record bytes/hashes, records_digest, index, totals, cross-record
  //      request_id uniqueness); in replay mode ONLY a replay generation
  //      carrying the exact id is accepted;
  //   3. loadEvalPublicationIntent — the PRIVATE writer-recovery intent of an
  //      interrupted publication (strict fail-closed load: malformed /
  //      unknown-kind / unsafe / duplicate / unsorted intent throws here,
  //      before any invoker).
  const existingRecords = scanEvalRecords(options.outputDir, {
    episodes,
    expectedJudgeModels: options.models,
    expectedReplayDatasetGenerationId: replayDatasetGenerationId,
  });
  const committed = loadCommittedEvalGeneration(options.outputDir, {
    episodes,
    expectedJudgeModels: options.models,
    expectedReplayDatasetGenerationId: replayDatasetGenerationId,
    expectedGenerationKind: replayBinding ? "replay" : "normal",
  });
  const recoveryIntent = loadEvalPublicationIntent(options.outputDir);
  // Intent kind preflight: a replay intent under normal mode (or vice versa)
  // fails here with a clear mode mismatch — never deferred to a later
  // record_sha / generation_id mismatch deep in recovery.
  if (recoveryIntent) {
    const expectReplay = Boolean(replayBinding);
    const isReplayIntent = recoveryIntent.kind === "t0_replay_eval_publication_intent";
    if (expectReplay !== isReplayIntent) {
      throw new Error(
        `t0-eval: writer-recovery intent kind ${JSON.stringify(recoveryIntent.kind)} does not match current mode (${expectReplay ? "replay" : "normal"}) — refuse to recover across branches`,
      );
    }
  }
  // P1-A: a committed marker can only outrank a stale intent that describes
  // EXACTLY the committed generation (same generation_id + target/identity
  // compatibility). An intent whose generation_id differs from the committed
  // marker is an UNFINISHED publication (the intent was written for a NEW
  // target generation before the old marker was revoked) — it must enter
  // precise zero-call recovery and can never be deleted or outranked by the
  // old marker.
  const intentMatchesCommitted = Boolean(recoveryIntent && committed && evalIntentMatchesCommitted(recoveryIntent, committed));
  // Recovery preflight: load the checkpoint of EVERY intent target BEFORE
  // any invoker — a malformed/truncated checkpoint throws here (fail
  // closed), and a missing / stale / incompatible one is recorded as null so
  // the recovery planner fails closed when a target has neither an exact raw
  // record nor a rebuildable checkpoint (recovery never re-evaluates). This
  // runs whenever recovery is needed — including the committed-marker +
  // mismatched-intent window (the old marker is present but the intent is an
  // unfinished publication). In replay mode the load binds the protocol
  // hash AND the expected generation id (markerless old checkpoints return
  // null and cannot be resumed).
  let recoveryCheckpoints = null;
  if (recoveryIntent && !intentMatchesCommitted) {
    const episodeById = new Map(episodes.map((e) => [e.episode_id, e]));
    recoveryCheckpoints = new Map();
    for (const t of recoveryIntent.targets) {
      const episode = episodeById.get(t.episode_id);
      recoveryCheckpoints.set(
        t.episode_id,
        episode
          ? loadCheckpoint(options.outputDir, t.episode_id, episodeContentHash(episode), {
              protocolHash: buildJudgeProtocolHash(replayDatasetGenerationId),
              schemaHash: buildJudgeSchemaHash(),
              expectedEpisodeId: t.episode_id,
              candidateIds: (episode.slots ?? []).map((s) => s.model_id),
              judgeModels: options.models,
              expectedReplayDatasetGenerationId: replayDatasetGenerationId,
            })
          : null,
      );
    }
  }
  if (committed && intentMatchesCommitted) {
    // A stale same-generation intent (crash between the summary commit and
    // the intent cleanup) describes EXACTLY the committed generation — clean
    // it up so the next publication starts from a clean state.
    clearEvalPublicationIntent(options.outputDir);
    console.log(`t0-eval: committed generation verified (${committed.records.length} records, generation_id=${committed.summary.generation_id.slice(0, 12)}…)`);
  } else if (committed && recoveryIntent) {
    // P1-A: committed marker + MISMATCHED intent — the intent is an
    // unfinished publication (written before the old marker was revoked). It
    // is NEVER deleted and NEVER outranked: the run completes the intent's
    // target generation with zero provider work.
    console.log(`t0-eval: committed generation verified (${committed.records.length} records, generation_id=${committed.summary.generation_id.slice(0, 12)}…) BUT an unfinished-publication intent exists (generation_id=${recoveryIntent.generation_id.slice(0, 12)}…) — recovery restricted to the intent target set`);
  } else if (recoveryIntent) {
    console.log(`t0-eval: no committed generation; interrupted-publication intent found (${recoveryIntent.targets.length} target record(s)) — recovery restricted to the intent target set`);
  } else if (existingRecords.length > 0) {
    console.log(`t0-eval: no committed generation; ${existingRecords.length} valid raw record(s) treated as uncommitted recovery material`);
  }

  // Run planning (shared planEvalRun): with a committed marker or no intent
  // the CLI selection stands; with an interrupted-publication intent the run
  // is in RECOVERY mode — ZERO provider work: every target is rebuilt to
  // its EXACT record (exact raw or complete current-protocol/model/episode
  // checkpoint), --episode/--limit are completely ignored, --no-resume is
  // rejected, and any target that cannot be rebuilt with zero calls fails
  // here, BEFORE any invoker.
  const runPlan = planEvalRun({
    episodes,
    existingRecords,
    committed,
    recoveryIntent,
    episodeIds: options.episodeIds,
    limit: options.limit,
    judgeModels: options.models,
    checkpoints: recoveryCheckpoints,
    resume: options.resume,
    replayDatasetGenerationId,
  });
  if (runPlan.mode === "recovery") {
    console.log(`t0-eval: recovery mode — ignoring --episode/--limit; ${runPlan.recoveredRecords.length} target record(s) rebuilt exactly per the intent (zero provider work)`);
  }
  if (runPlan.selected.length === 0) {
    if (runPlan.mode === "recovery") {
      // Every intent target is rebuilt exactly per the plan — zero provider
      // work: assert the intent identity (corpus_digest + records_digest +
      // reconstructed generation_id) BEFORE any disk mutation, then republish
      // the recovered set directly (the merge enforces the exact target-set
      // closure — a committed marker whose generation_id differs from the
      // intent is NEVER the baseline, the old A records can only enter via
      // the exact recovered set) and clean the intent.
      const merged = mergeEvalRecords({ committed, existingRecords, newRecords: [], recoveryIntent, recoveredRecords: runPlan.recoveredRecords });
      assertEvalRecoveryIntentIdentity({
        records: merged,
        intent: recoveryIntent,
        episodes,
        judgeModels: options.models,
        episodesPath,
        outputDir: options.outputDir,
        replayDatasetGenerationId,
      });
      const summary = replayBinding
        ? publishReplayEvalGeneration({
          replayBinding,
          outputDir: options.outputDir,
          episodes,
          records: merged,
          judgeModels: options.models,
          episodesPath,
          runFacts: {
            new_calls: 0,
            episodes_in_run: 0,
            limit: options.limit,
            concurrency: options.concurrency,
            max_retries: options.maxRetries,
            timeout_ms: options.timeoutMs,
            resume: options.resume,
            no_resume: !options.resume,
          },
        })
        : publishEvalGeneration({
          outputDir: options.outputDir,
          episodes,
          records: merged,
          judgeModels: options.models,
          episodesPath,
          runFacts: {
            new_calls: 0,
            episodes_in_run: 0,
            limit: options.limit,
            concurrency: options.concurrency,
            max_retries: options.maxRetries,
            timeout_ms: options.timeoutMs,
            resume: options.resume,
            no_resume: !options.resume,
          },
        });
      console.log(`\nt0-eval done (recovery republish, zero provider): ${summary.episodes_evaluated} cumulative records republished, ${summary.calls} calls, cost $${summary.known_cost.toFixed(4)} (${summary.cost_source ?? "n/a"}${summary.cost_complete ? "" : ", incomplete"}), ${summary.episodes_complete} complete, ${summary.errors.length} stage errors, ${summary.unresolved.length} unresolved`);
      console.log(`output: ${options.outputDir}`);
      return;
    }
    console.error(`t0-eval: no episodes selected (${episodes.length} available, limit=${options.limit}, episode=${options.episodeIds?.join(",") ?? "any"})`);
    process.exit(2);
  }
  console.log(`t0-eval: ${runPlan.selected.length}/${episodes.length} episodes, judges=${options.models.all.join(",")}, concurrency=${options.concurrency}, output=${options.outputDir}`);

  const invoker = await makeJudgeInvoker({ modelsJsonPath: options.modelsJsonPath });
  const records = [];
  const queue = [...runPlan.selected];
  const workers = Array.from({ length: Math.min(options.concurrency, runPlan.selected.length) }, async () => {
    while (queue.length > 0) {
      const episode = queue.shift();
      const record = await evaluateEpisode(invoker, episode, options.models, options);
      records.push(record);
      const s = record.summary;
      console.log(`  ${record.episode_id}: calls=${s.calls} cost=$${s.known_cost.toFixed(4)}${s.cost_complete ? "" : " (incomplete)"} unresolved=${s.unresolved.length} errors=${s.errors.length} complete=${s.complete}`);
    }
  });
  await Promise.all(workers);

  // Merge (shared baseline semantics — see mergeEvalRecords): with a
  // committed marker, ONLY the manifest-listed records are the accumulation
  // baseline; manifest-unlisted raw eval/*.json (valid recovery material)
  // can never be auto-promoted by an arbitrary subset run. When the marker
  // is MISSING but an interrupted-publication intent exists, the baseline is
  // ONLY the exact recovered records from planEvalPublicationRecovery, every
  // new record must be an intent target with a matching content_hash, and
  // the merged set must EXACTLY equal the intent target set (a partial
  // target publication throws) — the interrupted publication recovers ONLY
  // its last target set, never out-of-target raw. Only when the marker is
  // MISSING and no intent exists are ALL the strict raw records allowed as
  // the legacy recovery baseline. This run's records win by episode_id. The
  // merged set is validated in memory by publishEvalGeneration (episode
  // binding, judge models, protocol/schema hashes, cross-record request_id
  // uniqueness) BEFORE any disk mutation; the publication is atomic (records
  // + index + summary manifest as the single commit point).
  const merged = mergeEvalRecords({
    committed,
    existingRecords,
    newRecords: records,
    recoveryIntent,
    recoveredRecords: runPlan.mode === "recovery" ? runPlan.recoveredRecords : null,
  });
  const summary = replayBinding
    ? publishReplayEvalGeneration({
      replayBinding,
      outputDir: options.outputDir,
      episodes,
      records: merged,
      judgeModels: options.models,
      episodesPath,
      runFacts: {
        new_calls: records.reduce((sum, r) => sum + (r.summary?.new_calls ?? 0), 0),
        episodes_in_run: records.length,
        limit: options.limit,
        concurrency: options.concurrency,
        max_retries: options.maxRetries,
        timeout_ms: options.timeoutMs,
        resume: options.resume,
        no_resume: !options.resume,
      },
    })
    : publishEvalGeneration({
      outputDir: options.outputDir,
      episodes,
      records: merged,
      judgeModels: options.models,
      episodesPath,
      runFacts: {
        new_calls: records.reduce((sum, r) => sum + (r.summary?.new_calls ?? 0), 0),
        episodes_in_run: records.length,
        limit: options.limit,
        concurrency: options.concurrency,
        max_retries: options.maxRetries,
        timeout_ms: options.timeoutMs,
        resume: options.resume,
        no_resume: !options.resume,
      },
    });

  console.log(`\nt0-eval done: ${records.length} episodes this run (${summary.episodes_evaluated} cumulative), ${summary.calls} calls, cost $${summary.known_cost.toFixed(4)} (${summary.cost_source ?? "n/a"}${summary.cost_complete ? "" : ", incomplete"}), ${summary.episodes_complete} complete, ${summary.errors.length} stage errors, ${summary.unresolved.length} unresolved`);
  console.log(`output: ${options.outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`t0-eval failed: ${err.message}`);
    process.exit(1);
  });
}
