#!/usr/bin/env node
/** Execute one real repository smoke through the production outcome collector
 *  with an isolated replay of a real production Path A exposure trace.
 *
 *  Required env:
 *    OUTCOME_SOURCE_ABRAIN_HOME  read-only source abrain (e.g. /home/worker/.abrain)
 *    OUTCOME_PATH_A_INJECT_ID    real path-a inject id to replay
 *
 *  Optional env:
 *    ABRAIN_HOME  isolated write target (must not equal the user ~/.abrain)
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PATH_A_LEDGER_REL = ".state/memory/path-a-ledger.jsonl";

// Always isolate production acceptance writes. Never default to the user's real ~/.abrain.
const userAbrain = path.resolve(process.env.HOME || os.homedir(), ".abrain");
const requestedAbrain = process.env.ABRAIN_HOME ? path.resolve(process.env.ABRAIN_HOME) : "";
const isolatedDefault = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rm-outcome-001-"));
const abrainHome = requestedAbrain && requestedAbrain !== userAbrain
  ? requestedAbrain
  : path.join(isolatedDefault, "abrain");
if (path.resolve(abrainHome) === userAbrain) {
  throw new Error("refusing to write production acceptance evidence into user ~/.abrain");
}
fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });

const sourceAbrainRaw = process.env.OUTCOME_SOURCE_ABRAIN_HOME;
const injectId = String(process.env.OUTCOME_PATH_A_INJECT_ID || "").trim();
if (!sourceAbrainRaw || !sourceAbrainRaw.trim()) {
  throw new Error("OUTCOME_SOURCE_ABRAIN_HOME is required (read-only real production abrain)");
}
if (!injectId) {
  throw new Error("OUTCOME_PATH_A_INJECT_ID is required (real path-a inject id; no synthetic/empty fallback)");
}
const sourceAbrain = path.resolve(sourceAbrainRaw);
if (sourceAbrain === path.resolve(abrainHome)) {
  throw new Error("OUTCOME_SOURCE_ABRAIN_HOME must differ from the isolated write target ABRAIN_HOME");
}

const dossierPath = path.join(repoRoot, "docs/evidence/2026-07-22-rm-outcome-001-production.json");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const outcome = jiti(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return result.stdout;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

/** Read-only load of one exact path-a ledger row. Never opens source for write. */
function loadRealPathAInjection(sourceHome, wantedInjectId) {
  const ledgerPath = path.join(sourceHome, PATH_A_LEDGER_REL);
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`source path-a ledger missing (read-only): ${PATH_A_LEDGER_REL}`);
  }
  const fd = fs.openSync(ledgerPath, "r");
  let raw;
  try {
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let match = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.inject_id !== wantedInjectId) continue;
    if (match) throw new Error(`duplicate path-a inject id in source ledger: ${wantedInjectId}`);
    match = { line: line.endsWith("\n") ? line : `${line}\n`, row };
  }
  if (!match) {
    throw new Error(`OUTCOME_PATH_A_INJECT_ID not found in source path-a ledger (no synthetic/empty fallback): ${wantedInjectId}`);
  }
  const { row, line } = match;
  if (row.outcome !== "injected") {
    throw new Error(`path-a row outcome must be "injected", got ${JSON.stringify(row.outcome)}`);
  }
  if (typeof row.session_id !== "string" || !row.session_id.trim()) {
    throw new Error("path-a row missing session_id");
  }
  if (row.turn_id === undefined || row.turn_id === null || row.turn_id === "") {
    throw new Error("path-a row missing turn_id");
  }
  if (!Array.isArray(row.injected_slugs) || row.injected_slugs.length === 0) {
    throw new Error("path-a row injected_slugs must be a non-empty array");
  }
  const slugs = [];
  for (const rawSlug of row.injected_slugs) {
    const slug = String(rawSlug ?? "").trim();
    if (!slug) throw new Error("path-a row contains empty injected slug");
    slugs.push(slug);
  }
  return {
    line,
    row,
    sessionId: row.session_id,
    turnId: row.turn_id,
    slugs,
    rowSha256: sha256(line),
    sourceLedgerRelativePath: PATH_A_LEDGER_REL,
  };
}

function replayPathARowExact(targetHome, sourceLine) {
  const targetLedger = path.join(targetHome, PATH_A_LEDGER_REL);
  fs.mkdirSync(path.dirname(targetLedger), { recursive: true, mode: 0o700 });
  // Exact byte-for-byte replay of the single production ledger line into the isolated root.
  fs.writeFileSync(targetLedger, sourceLine, { encoding: "utf8", mode: 0o600, flag: "w" });
  const reread = fs.readFileSync(targetLedger, "utf8");
  if (reread !== sourceLine) throw new Error("isolated path-a ledger replay is not byte-identical");
  return {
    relative_path: PATH_A_LEDGER_REL,
    bytes: Buffer.byteLength(sourceLine),
    sha256: sha256(sourceLine),
  };
}

const sourceTrace = loadRealPathAInjection(sourceAbrain, injectId);
const replayMeta = replayPathARowExact(abrainHome, sourceTrace.line);

// Snapshot source ledger mtime/size after read so we can assert no mutation of user abrain.
const sourceLedgerPath = path.join(sourceAbrain, PATH_A_LEDGER_REL);
const sourceLedgerStatBefore = fs.statSync(sourceLedgerPath);

const headCommit = git(["rev-parse", "HEAD"]).trim();
const branchText = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
const statusBytes = Buffer.from(git(["status", "--porcelain=v1", "-z"], "buffer"));
const repositoryIdentity = {
  head_commit: headCommit,
  branch: branchText || null,
  worktree_status_sha256: sha256(statusBytes),
  worktree_dirty: statusBytes.length > 0,
};
const executable = process.execPath;
const argv = [path.join("scripts", "smoke-canonical-path-foundation.mjs")];
const startedAt = new Date().toISOString();
const commandResult = spawnSync(executable, argv, { cwd: repoRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
const finishedAt = new Date().toISOString();
const runId = `rm-outcome-001-${randomUUID()}`;
const collectorArgs = {
  abrainHome,
  projectRoot: repoRoot,
  // Bind outcome to the real production session/turn of the replayed path-a row.
  sessionId: sourceTrace.sessionId,
  turnId: sourceTrace.turnId,
  injectIds: [injectId],
  runId,
  startedAt,
  finishedAt,
  executable,
  argv,
  exitCode: commandResult.status,
  signal: commandResult.signal,
  stdout: commandResult.stdout ?? Buffer.alloc(0),
  stderr: commandResult.stderr ?? Buffer.alloc(0),
  repositoryIdentity,
};

const collected = await outcome.recordProductionCommandOutcome(collectorArgs);
if (collected.error || !collected.outcome || !collected.rejudge) {
  throw new Error(`production collector failed: ${JSON.stringify(collected)}`);
}
if (!Array.isArray(collected.exposures) || collected.exposures.length === 0) {
  throw new Error(`expected real replayed exposures, got empty: ${JSON.stringify(collected)}`);
}
if (collected.exposures.length !== sourceTrace.slugs.length) {
  throw new Error(`exposure count ${collected.exposures.length} != injected slug count ${sourceTrace.slugs.length}`);
}
if (collected.attribution !== "unknown") {
  throw new Error(`production attribution must remain unknown, got ${collected.attribution}`);
}

const replayed = await outcome.recordProductionCommandOutcome(collectorArgs);
if (
  replayed.outcome !== collected.outcome
  || replayed.rejudge !== collected.rejudge
  || JSON.stringify(replayed.exposures) !== JSON.stringify(collected.exposures)
) {
  throw new Error("production collector replay was not idempotent");
}

const l1Path = outcome.outcomeEvidenceEventPath(abrainHome, collected.outcome);
const rejudgePath = outcome.outcomeEvidenceEventPath(abrainHome, collected.rejudge);
const envelope = JSON.parse(fs.readFileSync(l1Path, "utf8"));
const rejudgeEnvelope = JSON.parse(fs.readFileSync(rejudgePath, "utf8"));
const validated = outcome.validateOutcomeEvidenceEnvelope(envelope);
const validatedRejudge = outcome.validateOutcomeEvidenceEnvelope(rejudgeEnvelope);
if (!validated.ok || !validatedRejudge.ok) {
  throw new Error(`L1 outcome/rejudge validation failed: ${JSON.stringify({ validated, validatedRejudge })}`);
}
const registry = l1.loadL1SchemaRegistry();
l1.validateL1Envelope(envelope, {
  registry,
  abrainHome,
  filePath: l1Path,
  relativePath: l1.expectedL1EventRelativePath(collected.outcome),
  expected: { domain: "knowledge", role: "evidence", producer: outcome.OUTCOME_EVIDENCE_PRODUCER },
});
l1.validateL1Envelope(rejudgeEnvelope, {
  registry,
  abrainHome,
  filePath: rejudgePath,
  relativePath: l1.expectedL1EventRelativePath(collected.rejudge),
  expected: { domain: "knowledge", role: "evidence", producer: outcome.OUTCOME_EVIDENCE_PRODUCER },
});

// Every candidate must resolve to a real replayed exposure L1 (hash-only paths, no memory bodies).
const exposureL1 = [];
for (const eventId of collected.exposures) {
  const filePath = outcome.outcomeEvidenceEventPath(abrainHome, eventId);
  if (!fs.existsSync(filePath)) throw new Error(`missing replayed exposure L1 for ${eventId}`);
  const expEnvelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const expValidated = outcome.validateOutcomeEvidenceEnvelope(expEnvelope);
  if (!expValidated.ok) throw new Error(`exposure L1 invalid: ${JSON.stringify(expValidated)}`);
  l1.validateL1Envelope(expEnvelope, {
    registry,
    abrainHome,
    filePath,
    relativePath: l1.expectedL1EventRelativePath(eventId),
    expected: { domain: "knowledge", role: "evidence", producer: outcome.OUTCOME_EVIDENCE_PRODUCER },
  });
  if (expEnvelope.body.event_type !== "memory_exposure_observed") {
    throw new Error(`candidate is not memory_exposure_observed: ${eventId}`);
  }
  if (expEnvelope.body.payload?.source_kind !== "path_a") {
    throw new Error(`exposure source_kind must be path_a: ${eventId}`);
  }
  if (expEnvelope.body.session_id !== String(sourceTrace.sessionId) || expEnvelope.body.turn_id !== String(sourceTrace.turnId)) {
    throw new Error(`exposure session/turn mismatch for ${eventId}`);
  }
  exposureL1.push({
    event_id: eventId,
    relative_path: l1.expectedL1EventRelativePath(eventId),
    envelope_sha256: sha256File(filePath),
    entry_slug: expEnvelope.body.payload.entry_slug,
  });
}

const rebuilt = outcome.rebuildOutcomeEvidenceIndex(abrainHome);
if (!rebuilt.ok) throw new Error(`index rebuild failed: ${JSON.stringify(rebuilt)}`);
const indexRows = outcome.readOutcomeEvidenceIndex(abrainHome);
const outcomeIndexRow = indexRows.find((row) => row.event_id === collected.outcome);
const rejudgeIndexRow = indexRows.find((row) => row.event_id === collected.rejudge);
if (!outcomeIndexRow || !rejudgeIndexRow) throw new Error("L1 events are absent from rebuilt outcome index");
if (
  outcomeIndexRow.event_type !== envelope.body.event_type
  || outcomeIndexRow.terminal_status !== envelope.body.payload.terminal_status
  || outcomeIndexRow.attribution_status !== envelope.body.attribution.status
) {
  throw new Error("outcome L1/index fields differ");
}
if (rejudgeIndexRow.causal_parents[0] !== collected.outcome || rejudgeIndexRow.rejudge_decision !== rejudgeEnvelope.body.payload.decision) {
  throw new Error("rejudge L1/index join differs");
}

const candidateIds = outcomeIndexRow.candidate_exposure_event_ids || [];
const verifiedExposureIds = outcomeIndexRow.exposure_event_ids || [];
if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
  throw new Error("outcome index candidate_exposure_event_ids must be non-empty for real exposure replay");
}
if (verifiedExposureIds.length !== 0) {
  throw new Error("unknown attribution must not promote candidates into verified exposure_event_ids");
}
if (envelope.body.attribution.exposure_event_ids.length !== 0) {
  throw new Error("outcome L1 verified exposure_event_ids must stay empty under unknown attribution");
}
const candidateSet = new Set(candidateIds);
const exposureSet = new Set(collected.exposures);
if (candidateIds.length !== collected.exposures.length || [...candidateSet].some((id) => !exposureSet.has(id))) {
  throw new Error("candidate_exposure_event_ids must exactly match replayed exposure L1 event ids");
}
if (outcomeIndexRow.attribution_status !== "unknown" || collected.attribution !== "unknown") {
  throw new Error("attribution must remain unknown (same-turn exposure is not causation)");
}
if (rejudgeIndexRow.causal_parents.length !== 1 || rejudgeIndexRow.causal_parents[0] !== collected.outcome) {
  throw new Error("rejudge parent must point at the outcome event");
}

// Source abrain must remain untouched (read-only).
const sourceLedgerStatAfter = fs.statSync(sourceLedgerPath);
if (
  sourceLedgerStatAfter.mtimeMs !== sourceLedgerStatBefore.mtimeMs
  || sourceLedgerStatAfter.size !== sourceLedgerStatBefore.size
) {
  throw new Error("source path-a ledger was mutated; expected read-only access");
}
if (path.resolve(abrainHome) === userAbrain || path.resolve(abrainHome) === sourceAbrain) {
  throw new Error("write target escaped isolation");
}

const command = [executable, ...argv].join(" ");
const dossierBase = {
  schema_version: "rm-outcome-001-production-evidence/v1",
  generated_at_utc: finishedAt,
  isolation: {
    mode: "isolated_replay_of_real_production_trace",
    target_abrain_home_sha256: sha256(path.resolve(abrainHome)),
    source_abrain_home_sha256: sha256(sourceAbrain),
    user_abrain_home_sha256: sha256(userAbrain),
    uses_user_abrain: false,
    source_readonly: true,
    target_isolated: true,
    no_user_abrain_writes: true,
  },
  production_trace_replay: {
    mode: "isolated_replay_of_real_production_trace",
    inject_id: injectId,
    source_ledger_relative_path: sourceTrace.sourceLedgerRelativePath,
    source_row_sha256: sourceTrace.rowSha256,
    replayed_ledger_relative_path: replayMeta.relative_path,
    replayed_ledger_sha256: replayMeta.sha256,
    injected_slug_count: sourceTrace.slugs.length,
    // Slug identities only (not memory bodies). Sorted for stable dossier hash.
    injected_slug_sha256s: sourceTrace.slugs.map((slug) => sha256(slug)).sort(),
    session_id: String(sourceTrace.sessionId),
    turn_id: String(sourceTrace.turnId),
    byte_identical_ledger_replay: replayMeta.sha256 === sourceTrace.rowSha256,
  },
  project: {
    repo_root_sha256: sha256(repoRoot),
    repository_identity: repositoryIdentity,
  },
  command: {
    executable,
    argv,
    // Prefer argv-only display so host absolute node path is not required in the dossier.
    display: ["node", ...argv].join(" "),
    started_at_utc: startedAt,
    finished_at_utc: finishedAt,
    exit_code: commandResult.status,
    signal: commandResult.signal,
    stdout_sha256: sha256(commandResult.stdout ?? Buffer.alloc(0)),
    stdout_bytes: (commandResult.stdout ?? Buffer.alloc(0)).length,
    stderr_sha256: sha256(commandResult.stderr ?? Buffer.alloc(0)),
    stderr_bytes: (commandResult.stderr ?? Buffer.alloc(0)).length,
  },
  production_collector: {
    run_id: runId,
    outcome_event_id: collected.outcome,
    rejudge_event_id: collected.rejudge,
    exposure_event_ids: collected.exposures,
    exposure_count: collected.exposures.length,
    attribution: collected.attribution,
    inject_ids: [injectId],
    idempotent_replay_verified: true,
  },
  l1: {
    outcome_relative_path: l1.expectedL1EventRelativePath(collected.outcome),
    rejudge_relative_path: l1.expectedL1EventRelativePath(collected.rejudge),
    exposure_relative_paths: exposureL1.map((row) => row.relative_path).sort(),
    outcome_envelope_sha256: sha256(fs.readFileSync(l1Path)),
    rejudge_envelope_sha256: sha256(fs.readFileSync(rejudgePath)),
    exposure_envelope_sha256s: exposureL1.map((row) => row.envelope_sha256).sort(),
    registry_validation: true,
    jcs_content_address_validation: true,
  },
  derived_index: {
    path_relative_to_abrain: path.relative(abrainHome, outcome.outcomeEvidenceIndexPath(abrainHome)).split(path.sep).join("/"),
    rebuilt_rows: rebuilt.rows,
    outcome_row: outcomeIndexRow,
    rejudge_row: rejudgeIndexRow,
    exposure_rows: indexRows
      .filter((row) => collected.exposures.includes(row.event_id))
      .map((row) => ({
        event_id: row.event_id,
        event_type: row.event_type,
        session_id: row.session_id,
        turn_id: row.turn_id,
        attribution_status: row.attribution_status,
        memory_entry_slugs: row.memory_entry_slugs,
        observation_kind: row.observation_kind,
      })),
  },
  consistency: {
    l1_event_id_equals_body_hash: envelope.event_id === envelope.body_hash,
    outcome_l1_index_match: true,
    rejudge_parent_join_match: true,
    dossier_binds_exact_command_result: true,
    unknown_attribution_explicit: collected.attribution === "unknown" && outcomeIndexRow.attribution_status === "unknown",
    real_exposure_trace_replayed: true,
    candidate_join_only: candidateIds.length > 0 && verifiedExposureIds.length === 0,
    no_false_attribution: collected.attribution === "unknown" && verifiedExposureIds.length === 0 && envelope.body.attribution.basis === "causal_anchor_only",
    candidate_exposure_event_ids_nonempty: candidateIds.length > 0,
    each_candidate_has_replayed_exposure_l1: exposureL1.length === candidateIds.length,
    rejudge_parent_points_to_outcome: rejudgeIndexRow.causal_parents[0] === collected.outcome,
    source_readonly_verified: true,
    target_isolated_verified: path.resolve(abrainHome) !== userAbrain && path.resolve(abrainHome) !== sourceAbrain,
    no_user_abrain_writes: true,
  },
};
const dossier = { ...dossierBase, dossier_sha256: jcs.jcsSha256Hex(dossierBase) };
fs.mkdirSync(path.dirname(dossierPath), { recursive: true });
fs.writeFileSync(dossierPath, `${jcs.canonicalizeJcs(dossier)}\n`, "utf8");
const reread = JSON.parse(fs.readFileSync(dossierPath, "utf8"));
const rereadBase = { ...reread };
delete rereadBase.dossier_sha256;
if (reread.dossier_sha256 !== jcs.jcsSha256Hex(rereadBase)) throw new Error("dossier self-hash mismatch");
if (commandResult.status !== 0) throw new Error(`real repository command failed with exit ${commandResult.status}`);
process.stdout.write(`${JSON.stringify({
  dossier: path.relative(repoRoot, dossierPath),
  command,
  exit_code: commandResult.status,
  outcome_event_id: collected.outcome,
  rejudge_event_id: collected.rejudge,
  exposure_count: collected.exposures.length,
  inject_id: injectId,
  attribution: collected.attribution,
  mode: "isolated_replay_of_real_production_trace",
})}\n`);
