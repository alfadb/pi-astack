#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const abrainHome = path.resolve(process.env.ABRAIN_ROOT || path.join(os.homedir(), ".abrain"));
const stateDir = path.join(abrainHome, ".state", "sediment");
const stagingDir = path.join(stateDir, "staging");
const proposalPath = path.join(stateDir, "entry-lifecycle-proposals.jsonl");
const derivedTargetPath = path.join(stateDir, "lifecycle-convergence.json");
const outputPath = path.join(repoRoot, "docs", "evidence", "2026-07-23-rm-lifecycle-002-production.json");
const now = new Date();

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function fileHash(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? sha256(fs.readFileSync(file)) : null;
}

function stagingInventory() {
  const buckets = { active_provisional: 0, active_multiview: 0, abandoned_multiview: 0, other_json: 0, corrupt_json: 0 };
  const hashes = [];
  const payloadHashes = [];
  const payloadContentHashes = [];
  const lifecycleMetadataHashes = [];
  if (!fs.existsSync(stagingDir)) return {
    ...buckets,
    aggregate_sha256: sha256(""),
    payload_excluding_lifecycle_sha256: sha256(""),
    payload_content_multiset_excluding_lifecycle_sha256: sha256(""),
    lifecycle_metadata_sha256: sha256(""),
  };
  const visit = (dir, abandoned) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, abandoned || entry.name === "abandoned");
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const bytes = fs.readFileSync(absolute);
      const relative = path.relative(stagingDir, absolute).split(path.sep).join("/");
      hashes.push(`${relative}\0${sha256(bytes)}`);
      try {
        const parsed = JSON.parse(bytes.toString("utf8"));
        if (parsed?.entry?.kind === "provisional-correction" && !abandoned) buckets.active_provisional++;
        else if (parsed?.entry?.kind === "multiview-pending" && abandoned) buckets.abandoned_multiview++;
        else if (parsed?.entry?.kind === "multiview-pending") buckets.active_multiview++;
        else buckets.other_json++;
        const lifecycleMetadata = {};
        if (parsed?.entry && typeof parsed.entry === "object") {
          for (const key of Object.keys(parsed.entry).filter((key) => key.startsWith("lifecycle_")).sort()) {
            lifecycleMetadata[key] = parsed.entry[key];
            delete parsed.entry[key];
          }
        }
        const payloadHash = sha256(stable(parsed));
        payloadHashes.push(`${relative}\0${payloadHash}`);
        payloadContentHashes.push(payloadHash);
        lifecycleMetadataHashes.push(`${relative}\0${sha256(stable(lifecycleMetadata))}`);
      } catch {
        buckets.corrupt_json++;
      }
    }
  };
  visit(stagingDir, false);
  return {
    ...buckets,
    aggregate_sha256: sha256(hashes.sort().join("\n")),
    payload_excluding_lifecycle_sha256: sha256(payloadHashes.sort().join("\n")),
    payload_content_multiset_excluding_lifecycle_sha256: sha256(payloadContentHashes.sort().join("\n")),
    lifecycle_metadata_sha256: sha256(lifecycleMetadataHashes.sort().join("\n")),
  };
}

function durableMemoryInventory() {
  const hashes = [];
  let files = 0;
  const visit = (surface, dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(surface, absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(path.join(abrainHome, surface), absolute).split(path.sep).join("/");
      hashes.push(`${surface}/${relative}\0${sha256(fs.readFileSync(absolute))}`);
      files++;
    }
  };
  for (const surface of ["projects", "knowledge"]) visit(surface, path.join(abrainHome, surface));
  return { files, aggregate_sha256: sha256(hashes.sort().join("\n")) };
}

function proposalInventory() {
  if (!fs.existsSync(proposalPath)) return { rows: 0, corrupt_rows: 0, file_sha256: null };
  const bytes = fs.readFileSync(proposalPath);
  let rows = 0;
  let corruptRows = 0;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      rows++;
    } catch {
      corruptRows++;
    }
  }
  return { rows, corrupt_rows: corruptRows, file_sha256: sha256(bytes) };
}

function compactMetrics(model) {
  return {
    cohort_cutover_at: model.cohort_cutover_at,
    arrivals: model.metrics.arrivals,
    terminal: model.metrics.terminal,
    pending: model.metrics.pending,
    unbounded_pending: model.metrics.unbounded_pending,
    retry_count: model.metrics.retry_count,
    oldest_pending_age_days: model.metrics.oldest_pending_age_days,
    oldest_fresh_pending_age_days: model.metrics.oldest_fresh_pending_age_days,
    failure_classes: model.metrics.failure_classes,
    cohorts: model.metrics.cohorts,
    queues: model.metrics.queues,
    continuity_holds: model.metrics.continuity_holds,
    continuity_baseline: model.metrics.continuity_baseline,
    previous_item_count: model.metrics.previous_item_count,
    missing_previous_item_ids_count: model.metrics.missing_previous_item_ids.length,
    missing_previous_item_ids_sha256: sha256(model.metrics.missing_previous_item_ids.join("\n")),
    conservation: model.metrics.conservation,
    source: model.metrics.source,
    stable_item_ids_sha256: sha256(model.rows.map((row) => row.item_id).sort().join("\n")),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function dossierSelfHashValid(value) {
  if (!value || typeof value !== "object" || typeof value.self_sha256 !== "string") return false;
  const preimage = cloneJson(value);
  const claimed = preimage.self_sha256;
  delete preimage.self_sha256;
  return sha256(stable(preimage)) === claimed;
}

function buildHistoricalRetainedEvidence(sourceDossier) {
  if (!dossierSelfHashValid(sourceDossier)) return null;
  const run = sourceDossier.current_run ?? sourceDossier;
  const before = run.before;
  const after = run.after;
  const actions = run.actions;
  const transition = {
    historical_source_transition_rows: actions?.source_reconcile?.updated,
    historical_multiview_transition_rows: actions?.source_reconcile?.multiview_updated,
    before_unbounded_pending: before?.metrics?.unbounded_pending,
    after_unbounded_pending: after?.metrics?.unbounded_pending,
    before_staging_aggregate_sha256: before?.sources?.staging?.aggregate_sha256,
    after_staging_aggregate_sha256: after?.sources?.staging?.aggregate_sha256,
    before_payload_excluding_lifecycle_sha256: before?.sources?.staging?.payload_excluding_lifecycle_sha256,
    after_payload_excluding_lifecycle_sha256: after?.sources?.staging?.payload_excluding_lifecycle_sha256,
    before_durable_memory_sha256: before?.durable_memory?.aggregate_sha256,
    after_durable_memory_sha256: after?.durable_memory?.aggregate_sha256,
  };
  const acceptance = {
    source_dossier_self_hash_valid: true,
    exact_35_row_source_transition: transition.historical_source_transition_rows === 35,
    exact_35_row_multiview_transition: transition.historical_multiview_transition_rows === 35,
    unbounded_pending_converged_1_to_0: transition.before_unbounded_pending === 1
      && transition.after_unbounded_pending === 0,
    staging_full_hash_changed: typeof transition.before_staging_aggregate_sha256 === "string"
      && typeof transition.after_staging_aggregate_sha256 === "string"
      && transition.before_staging_aggregate_sha256 !== transition.after_staging_aggregate_sha256,
    payload_excluding_lifecycle_unchanged: typeof transition.before_payload_excluding_lifecycle_sha256 === "string"
      && transition.before_payload_excluding_lifecycle_sha256 === transition.after_payload_excluding_lifecycle_sha256,
    durable_memory_unchanged: typeof transition.before_durable_memory_sha256 === "string"
      && transition.before_durable_memory_sha256 === transition.after_durable_memory_sha256,
  };
  if (!Object.values(acceptance).every(Boolean)) return null;
  return {
    evidence_mode: "historical_retained_source_transition",
    source_dossier_schema_version: sourceDossier.schema_version,
    source_dossier_generated_at: sourceDossier.generated_at,
    source_dossier_self_sha256: sourceDossier.self_sha256,
    source_dossier: cloneJson(sourceDossier),
    transition,
    acceptance,
  };
}

function loadHistoricalRetainedEvidence() {
  if (!fs.existsSync(outputPath)) throw new Error("historical production lifecycle dossier is missing");
  const previous = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (!dossierSelfHashValid(previous)) throw new Error("previous production lifecycle dossier self hash is invalid");
  const historicalSource = previous.historical_retained_evidence?.source_dossier ?? previous;
  const retained = buildHistoricalRetainedEvidence(historicalSource);
  if (!retained) throw new Error("self-hash-valid historical 35-row lifecycle transition evidence is unavailable");
  return retained;
}

if (!fs.existsSync(abrainHome)) throw new Error("production source root does not exist");
const historicalRetainedEvidence = loadHistoricalRetainedEvidence();

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const lifecycle = await jiti.import(path.join(repoRoot, "extensions", "sediment", "lifecycle-convergence.ts"));
const proposal = await jiti.import(path.join(repoRoot, "extensions", "sediment", "entry-lifecycle-proposals.ts"));

const beforeSources = { staging: stagingInventory(), proposals: proposalInventory() };
const beforeDurableMemory = durableMemoryInventory();
const derivedTargetBeforeSha256 = fileHash(derivedTargetPath);
const beforeBuild = lifecycle.rebuildLifecycleConvergence({ abrainHome, now });
if (!beforeBuild.ok) throw new Error(`before rebuild failed closed: ${beforeBuild.error}`);

const proposalReconcile = proposal.reconcileLifecycleProposalDeferrals({ now });
if (!proposalReconcile.ok) throw new Error(`proposal reconcile failed closed: ${proposalReconcile.error}`);
const terminalSweep = lifecycle.sweepMultiviewTerminalEntries({ now });
if (!terminalSweep.ok) throw new Error("multiview terminal sweep failed");
const sourceReconcile = lifecycle.reconcileStagingLifecycleSources({ abrainHome, now });
if (!sourceReconcile.ok) throw new Error("source reconciliation failed");
const afterBuild = lifecycle.rebuildLifecycleConvergence({ abrainHome, now });
if (!afterBuild.ok) throw new Error(`after rebuild failed closed: ${afterBuild.error}`);

const repeatProposal = proposal.reconcileLifecycleProposalDeferrals({ now });
const repeatSweep = lifecycle.sweepMultiviewTerminalEntries({ now });
const repeatReconcile = lifecycle.reconcileStagingLifecycleSources({ abrainHome, now });
const repeatBuild = lifecycle.rebuildLifecycleConvergence({ abrainHome, now });
if (!repeatProposal.ok || !repeatSweep.ok || !repeatReconcile.ok || !repeatBuild.ok) throw new Error("idempotency replay failed");

const afterSources = { staging: stagingInventory(), proposals: proposalInventory() };
const afterDurableMemory = durableMemoryInventory();
const derivedTargetAfterSha256 = fileHash(derivedTargetPath);
const derivedTargetHashChanged = derivedTargetBeforeSha256 !== derivedTargetAfterSha256;
const derivedReadModelWriteApplied = beforeBuild.written === true || afterBuild.written === true;
const stagingHashChanged = beforeSources.staging.aggregate_sha256 !== afterSources.staging.aggregate_sha256;
const proposalHashChanged = beforeSources.proposals.file_sha256 !== afterSources.proposals.file_sha256;
const stagingPayloadPathInventoryUnchanged = beforeSources.staging.payload_excluding_lifecycle_sha256
  === afterSources.staging.payload_excluding_lifecycle_sha256;
const stagingPayloadContentUnchanged = beforeSources.staging.payload_content_multiset_excluding_lifecycle_sha256
  === afterSources.staging.payload_content_multiset_excluding_lifecycle_sha256;
const sourceHashesUnchanged = !stagingHashChanged && !proposalHashChanged;
const sourceInventoryUnchanged = stable(beforeSources) === stable(afterSources);
const durableMemoryUnchanged = stable(beforeDurableMemory) === stable(afterDurableMemory);
const currentSourceActionApplied = proposalReconcile.written === true
  || terminalSweep.terminal > 0
  || terminalSweep.already_terminal_archived > 0
  || sourceReconcile.updated > 0;
const currentEvidenceMode = currentSourceActionApplied
  ? "current_source_actions_plus_idempotent_verification"
  : "current_idempotent_verification_only";
const currentActions = {
  before_read_model_build: { ok: beforeBuild.ok, written: beforeBuild.written },
  proposal_reconcile: proposalReconcile,
  terminal_sweep: terminalSweep,
  source_reconcile: sourceReconcile,
  after_read_model_build: { ok: afterBuild.ok, written: afterBuild.written },
};
const currentBefore = {
  sources: beforeSources,
  durable_memory: beforeDurableMemory,
  derived_target_sha256: derivedTargetBeforeSha256,
  metrics: compactMetrics(beforeBuild.read_model),
};
const currentAfter = {
  sources: afterSources,
  durable_memory: afterDurableMemory,
  derived_target_sha256: derivedTargetAfterSha256,
  metrics: compactMetrics(afterBuild.read_model),
};
const idempotencyReplay = {
  proposal_written: repeatProposal.written,
  proposal_migrated_e2: repeatProposal.migrated_e2,
  proposal_scheduled_nonterminal: repeatProposal.scheduled_nonterminal,
  multiview_terminal: repeatSweep.terminal,
  source_updated: repeatReconcile.updated,
  proposal_deadline_terminal: repeatProposal.deadline_terminal,
  proposal_bounded_retry_scheduled: repeatProposal.bounded_retry_scheduled,
  proposal_retry_cap_terminal: repeatProposal.retry_cap_terminal,
  multiview_deadline_expired: repeatSweep.deadline_expired,
  multiview_already_terminal_archived: repeatSweep.already_terminal_archived,
  source_deadline_terminal: repeatReconcile.deadline_terminal,
  read_model_written: repeatBuild.written,
  metrics_equal: stable(compactMetrics(repeatBuild.read_model)) === stable(compactMetrics(afterBuild.read_model)),
};
const repeatIsIdempotent = repeatProposal.written === false
  && repeatProposal.migrated_e2 === 0
  && repeatProposal.scheduled_nonterminal === 0
  && repeatProposal.deadline_terminal === 0
  && repeatProposal.bounded_retry_scheduled === 0
  && repeatProposal.retry_cap_terminal === 0
  && repeatSweep.terminal === 0
  && repeatSweep.already_terminal_archived === 0
  && repeatSweep.deadline_expired === 0
  && repeatReconcile.updated === 0
  && repeatReconcile.deadline_terminal === 0
  && repeatBuild.written === false;
const currentAcceptance = {
  production_source_selected: process.env.ABRAIN_ROOT === undefined && beforeBuild.read_model.metrics.arrivals > 0,
  source_hash_transition_matches_current_actions: currentSourceActionApplied === !sourceHashesUnchanged,
  source_inventory_transition_matches_current_actions: currentSourceActionApplied === !sourceInventoryUnchanged,
  derived_target_hash_transition_matches_read_model_actions: derivedReadModelWriteApplied === derivedTargetHashChanged,
  initial_unbounded_pending_converged_or_not_applicable: beforeBuild.read_model.metrics.unbounded_pending === 0
    ? afterBuild.read_model.metrics.unbounded_pending === 0
    : afterBuild.read_model.metrics.unbounded_pending === 0
      && afterBuild.read_model.metrics.unbounded_pending < beforeBuild.read_model.metrics.unbounded_pending,
  staging_payload_content_excluding_lifecycle_unchanged: stagingPayloadContentUnchanged,
  durable_memory_unchanged: durableMemoryUnchanged,
  read_model_is_derived_target_only: lifecycle.lifecycleConvergencePath(abrainHome) === derivedTargetPath,
  total_conservation: afterBuild.read_model.metrics.conservation.holds,
  legacy_conservation: afterBuild.read_model.metrics.cohorts.legacy.conservation_holds,
  fresh_conservation: afterBuild.read_model.metrics.cohorts.fresh.conservation_holds,
  continuity_holds: afterBuild.read_model.metrics.continuity_holds,
  missing_previous_item_ids_zero: afterBuild.read_model.metrics.missing_previous_item_ids.length === 0,
  continuity_uses_persisted_baseline: afterBuild.read_model.metrics.continuity_baseline === "persisted_read_model",
  unbounded_pending_zero: afterBuild.read_model.metrics.unbounded_pending === 0,
  source_corrupt_rows_zero: afterSources.staging.corrupt_json === 0 && afterSources.proposals.corrupt_rows === 0,
  repeat_is_idempotent: repeatIsIdempotent,
};
const codeFiles = [
  "extensions/sediment/lifecycle-convergence.ts",
  "extensions/sediment/lifecycle-source-metadata.ts",
  "extensions/sediment/entry-lifecycle-proposals.ts",
  "extensions/sediment/multiview-staging-io.ts",
  "extensions/sediment/multiview-staging-replay.ts",
  "extensions/sediment/staging-ageout.ts",
  "scripts/smoke-lifecycle-convergence.mjs",
  "scripts/smoke-entry-lifecycle-proposals.mjs",
  "scripts/dossier-rm-lifecycle-002-production.mjs",
  "docs/adr/0043-lifecycle-convergence-and-reversible-terminal-state.md",
  "docs/transition-register.machine.json",
];
const codeHashes = Object.fromEntries(codeFiles.map((file) => [file, fileHash(path.join(repoRoot, file))]));
const codeAggregate = sha256(codeFiles.map((file) => `${file}\0${codeHashes[file]}`).join("\n"));
const currentRunHistoricalMigrationClaimed = false;

const dossier = {
  schema_version: "rm-lifecycle-002-production/v2",
  generated_at: now.toISOString(),
  scope: "production lifecycle source-metadata reconciliation and rebuildable read-model verification",
  evidence_mode: "historical_transition_retained_plus_current_run_verification",
  privacy: "counts and SHA-256 only in current evidence; the retained self-hash preimage preserves the prior counts/hash-only dossier",
  self_sha256_convention: "sha256(UTF-8 recursive-key-sorted compact JSON of the dossier before self_sha256 is added; arrays preserve order)",
  source_selection: process.env.ABRAIN_ROOT === undefined ? "default_user_global_production" : "explicit_override",
  boundaries: {
    durable_memory_mutated_in_current_run: !durableMemoryUnchanged,
    lifecycle_source_mutated_in_current_run: !sourceHashesUnchanged,
    lifecycle_source_mutation_recorded_by_current_actions: currentSourceActionApplied === !sourceHashesUnchanged,
    derived_read_model_mutated_in_current_run: derivedTargetHashChanged,
    derived_read_model_mutation_recorded_by_current_actions: derivedReadModelWriteApplied === derivedTargetHashChanged,
    physical_delete_used: false,
    lane_g_pipeline_created: false,
    human_or_operator_queue_created: false,
    staging_hard_delete_authorization: "blocked/separate_authorization_required",
    lifecycle_read_model_role: "derived_target_only",
  },
  historical_retained_evidence: historicalRetainedEvidence,
  current_run: {
    generated_at: now.toISOString(),
    evidence_mode: currentEvidenceMode,
    historical_35_row_migration_claimed: currentRunHistoricalMigrationClaimed,
    source_action_classification: {
      action_applied: currentSourceActionApplied,
      proposal_file_rewritten: proposalReconcile.written === true,
      multiview_terminal_archived: terminalSweep.terminal,
      multiview_existing_terminal_archived: terminalSweep.already_terminal_archived,
      source_records_updated: sourceReconcile.updated,
      source_deadline_terminal: sourceReconcile.deadline_terminal,
      derived_read_model_written: derivedReadModelWriteApplied,
      derived_read_model_write_reason: derivedReadModelWriteApplied
        ? "real wall-clock generated_at/as_of refresh and any recorded source transition"
        : "derived target bytes already matched this invocation",
    },
    before: currentBefore,
    actions: currentActions,
    source_transition_observation: {
      initial_unbounded_pending_present: beforeBuild.read_model.metrics.unbounded_pending > 0,
      before_unbounded_pending: beforeBuild.read_model.metrics.unbounded_pending,
      after_unbounded_pending: afterBuild.read_model.metrics.unbounded_pending,
      unbounded_pending_delta: afterBuild.read_model.metrics.unbounded_pending - beforeBuild.read_model.metrics.unbounded_pending,
      source_hashes_unchanged: sourceHashesUnchanged,
      source_inventory_unchanged: sourceInventoryUnchanged,
      staging_full_hash_changed: stagingHashChanged,
      proposal_hash_changed: proposalHashChanged,
      staging_payload_path_inventory_excluding_lifecycle_unchanged: stagingPayloadPathInventoryUnchanged,
      staging_payload_content_multiset_excluding_lifecycle_unchanged: stagingPayloadContentUnchanged,
      durable_memory_unchanged: durableMemoryUnchanged,
      staging_hash_explanation: stagingHashChanged
        ? "staging source bytes/location changed only through the current run's recorded terminal sweep or lifecycle source reconciliation"
        : "staging source bytes and locations were already converged; no staging mutation occurred",
      proposal_hash_explanation: proposalHashChanged
        ? "entry lifecycle proposal source changed through the current run's recorded proposal reconcile action"
        : "entry lifecycle proposal source was unchanged",
      durable_hash_explanation: "projects/knowledge aggregate is outside lifecycle source metadata and remained unchanged",
    },
    after: currentAfter,
    idempotency_replay: idempotencyReplay,
    acceptance: currentAcceptance,
  },
  acceptance: {
    historical_retained_transition_valid: Object.values(historicalRetainedEvidence.acceptance).every(Boolean),
    current_run_valid: Object.values(currentAcceptance).every(Boolean),
    current_run_does_not_claim_historical_migration: !currentRunHistoricalMigrationClaimed,
    code_hashes_all_present: Object.values(codeHashes).every((value) => typeof value === "string"),
  },
  artifacts: {
    lifecycle_read_model_sha256: fileHash(lifecycle.lifecycleConvergencePath(abrainHome)),
    code_sha256: codeHashes,
    code_aggregate_sha256_convention: "sha256(join('\\n', codeFiles in recorded insertion order as relativePath + NUL + file sha256))",
    code_aggregate_sha256: codeAggregate,
  },
};

if (!Object.values(dossier.current_run.acceptance).every(Boolean) || !Object.values(dossier.acceptance).every(Boolean)) {
  throw new Error(`production acceptance failed: ${JSON.stringify({ acceptance: dossier.acceptance, current_run_acceptance: dossier.current_run.acceptance, idempotency_replay: dossier.current_run.idempotency_replay })}`);
}
dossier.self_sha256 = sha256(stable(dossier));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temp = `${outputPath}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, outputPath);
console.log(JSON.stringify({
  ok: true,
  self_sha256: dossier.self_sha256,
  evidence_mode: dossier.evidence_mode,
  historical_transition: dossier.historical_retained_evidence.transition,
  current_run: {
    evidence_mode: dossier.current_run.evidence_mode,
    metrics: dossier.current_run.after.metrics,
    actions: dossier.current_run.actions,
  },
}, null, 2));
