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
  if (!fs.existsSync(stagingDir)) return { ...buckets, aggregate_sha256: sha256("") };
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
      } catch {
        buckets.corrupt_json++;
      }
    }
  };
  visit(stagingDir, false);
  return { ...buckets, aggregate_sha256: sha256(hashes.sort().join("\n")) };
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

if (!fs.existsSync(abrainHome)) throw new Error("production source root does not exist");

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
const sourceHashesUnchanged = beforeSources.staging.aggregate_sha256 === afterSources.staging.aggregate_sha256
  && beforeSources.proposals.file_sha256 === afterSources.proposals.file_sha256;
const sourceInventoryUnchanged = stable(beforeSources) === stable(afterSources);
const durableMemoryUnchanged = stable(beforeDurableMemory) === stable(afterDurableMemory);
const firstPassSourceActionApplied = proposalReconcile.written === true
  || terminalSweep.terminal > 0
  || terminalSweep.already_terminal_archived > 0
  || sourceReconcile.updated > 0;
const codeFiles = [
  "extensions/sediment/lifecycle-convergence.ts",
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

const dossier = {
  schema_version: "rm-lifecycle-002-production/v1",
  generated_at: now.toISOString(),
  scope: "production lifecycle source reconciliation and rebuildable read-model verification",
  evidence_mode: firstPassSourceActionApplied ? "source_migration_plus_idempotent_verification" : "idempotent_verification_only",
  initial_migration_evidence_claimed: firstPassSourceActionApplied,
  privacy: "counts and SHA-256 only; no source body, slug, project path, or candidate text",
  self_sha256_convention: "sha256(UTF-8 recursive-key-sorted compact JSON of the dossier before self_sha256 is added; arrays preserve order)",
  source_selection: process.env.ABRAIN_ROOT === undefined ? "default_user_global_production" : "explicit_override",
  boundaries: {
    durable_memory_mutated: false,
    physical_delete_used: false,
    lane_g_pipeline_created: false,
    human_or_operator_queue_created: false,
    staging_hard_delete_authorization: "blocked/separate_authorization_required",
    lifecycle_read_model_role: "derived_target_only",
  },
  before: {
    sources: beforeSources,
    durable_memory: beforeDurableMemory,
    derived_target_sha256: derivedTargetBeforeSha256,
    metrics: compactMetrics(beforeBuild.read_model),
  },
  actions: {
    proposal_reconcile: proposalReconcile,
    terminal_sweep: terminalSweep,
    source_reconcile: sourceReconcile,
  },
  source_transition_observation: {
    first_pass_source_action_applied: firstPassSourceActionApplied,
    source_hashes_unchanged: sourceHashesUnchanged,
    source_inventory_unchanged: sourceInventoryUnchanged,
    durable_memory_unchanged: durableMemoryUnchanged,
  },
  after: {
    sources: afterSources,
    durable_memory: afterDurableMemory,
    derived_target_sha256: derivedTargetAfterSha256,
    metrics: compactMetrics(afterBuild.read_model),
  },
  idempotency_replay: {
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
  },
  acceptance: {
    production_source_selected: process.env.ABRAIN_ROOT === undefined && beforeBuild.read_model.metrics.arrivals > 0,
    source_hash_transition_accounted: firstPassSourceActionApplied ? !sourceHashesUnchanged : sourceHashesUnchanged,
    source_inventory_transition_accounted: firstPassSourceActionApplied || sourceInventoryUnchanged,
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
    repeat_is_idempotent: repeatProposal.written === false
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
      && repeatBuild.written === false,
  },
  artifacts: {
    lifecycle_read_model_sha256: fileHash(lifecycle.lifecycleConvergencePath(abrainHome)),
    code_sha256: codeHashes,
  },
};

if (!Object.values(dossier.acceptance).every(Boolean)) throw new Error(`production acceptance failed: ${JSON.stringify({ acceptance: dossier.acceptance, idempotency_replay: dossier.idempotency_replay })}`);
dossier.self_sha256 = sha256(stable(dossier));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temp = `${outputPath}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, outputPath);
console.log(JSON.stringify({ ok: true, self_sha256: dossier.self_sha256, evidence_mode: dossier.evidence_mode, metrics: dossier.after.metrics, actions: dossier.actions }, null, 2));
