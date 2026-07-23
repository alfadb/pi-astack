#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const abrainHome = path.resolve(process.env.ABRAIN_ROOT || path.join(os.homedir(), ".abrain"));
const settingsPath = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
const stateDir = path.join(abrainHome, ".state", "sediment");
const proposalPath = path.join(stateDir, "entry-lifecycle-proposals.jsonl");
const convergencePath = path.join(stateDir, "lifecycle-convergence.json");
const demoteLedgerPath = path.join(stateDir, "forgetting-demote-ledger.jsonl");
const reactivationLedgerPath = path.join(stateDir, "archive-reactivation-ledger.jsonl");
const outputPath = path.join(repoRoot, "docs", "evidence", "2026-07-23-rm-forget-001-real-apply-gate-production.json");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function fileHash(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? sha256(fs.readFileSync(file)) : null;
}

function jsonlInventory(file) {
  if (!fs.existsSync(file)) return { rows: 0, corrupt_rows: 0, file_sha256: null };
  const bytes = fs.readFileSync(file);
  let rows = 0;
  let corruptRows = 0;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { JSON.parse(line); rows++; }
    catch { corruptRows++; }
  }
  return { rows, corrupt_rows: corruptRows, file_sha256: sha256(bytes) };
}

function proposalInventory() {
  const base = jsonlInventory(proposalPath);
  const counts = {
    pending_execution_ready_archive: 0,
    e1_execution_ready_archive: 0,
    non_e1_execution_ready_archive: 0,
    long_tail_e1_execution_ready_archive: 0,
  };
  if (!fs.existsSync(proposalPath)) return { ...base, ...counts };
  const longTail = new Set(["anti-pattern", "maxim", "preference", "decision", "pattern"]);
  for (const line of fs.readFileSync(proposalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const executionReady = row?.op === "archive"
      && row?.status === "pending"
      && (row?.disposition ?? "execution_ready") === "execution_ready";
    if (!executionReady) continue;
    counts.pending_execution_ready_archive++;
    const e1 = row.evidence_source === "frontmatter_superseded"
      && row.expected_status === "superseded"
      && row.evidence_type === "superseded_by";
    if (e1) {
      counts.e1_execution_ready_archive++;
      if (longTail.has(row.kind)) counts.long_tail_e1_execution_ready_archive++;
    } else {
      counts.non_e1_execution_ready_archive++;
    }
  }
  return { ...base, ...counts };
}

function stagingInventory() {
  const stagingRoot = path.join(stateDir, "staging");
  const records = [];
  let files = 0;
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const relative = path.relative(stagingRoot, absolute).split(path.sep).join("/");
      records.push(`${relative}\0${sha256(fs.readFileSync(absolute))}`);
      files++;
    }
  };
  visit(stagingRoot);
  return { files, aggregate_sha256: sha256(records.sort().join("\n")) };
}

function durableInventory() {
  const records = [];
  let files = 0;
  const visit = (surface, root, dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(surface, root, absolute); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      records.push(`${surface}/${relative}\0${sha256(fs.readFileSync(absolute))}`);
      files++;
    }
  };
  for (const surface of ["projects", "knowledge"]) {
    const root = path.join(abrainHome, surface);
    visit(surface, root, root);
  }
  return { files, aggregate_sha256: sha256(records.sort().join("\n")) };
}

function sourceSnapshot() {
  return {
    settings_sha256: fileHash(settingsPath),
    staging_sources: stagingInventory(),
    proposals: proposalInventory(),
    durable_memory: durableInventory(),
    lifecycle_read_model_sha256: fileHash(convergencePath),
    demote_ledger: jsonlInventory(demoteLedgerPath),
    reactivation_ledger: jsonlInventory(reactivationLedgerPath),
  };
}

if (process.env.ABRAIN_ROOT !== undefined) throw new Error("production dossier forbids ABRAIN_ROOT override");
if (!fs.existsSync(abrainHome) || !fs.existsSync(settingsPath)) throw new Error("production settings/source missing");

const rawSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const rawForgetting = rawSettings?.memory?.forgetting;
const configuredGatePresent = !!rawForgetting && typeof rawForgetting === "object"
  && Object.prototype.hasOwnProperty.call(rawForgetting, "executorRealApplyEnabled");
const configuredGateType = configuredGatePresent ? typeof rawForgetting.executorRealApplyEnabled : "missing";
const rawSediment = rawSettings?.sediment;
const globalWriteGatePresent = !!rawSediment && typeof rawSediment === "object"
  && Object.prototype.hasOwnProperty.call(rawSediment, "autoLlmWriteEnabled");
const globalWriteGateType = globalWriteGatePresent ? typeof rawSediment.autoLlmWriteEnabled : "missing";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const memorySettings = await jiti.import(path.join(repoRoot, "extensions", "memory", "settings.ts"));
const sedimentSettings = await jiti.import(path.join(repoRoot, "extensions", "sediment", "settings.ts"));
const lifecycle = await jiti.import(path.join(repoRoot, "extensions", "sediment", "lifecycle-convergence.ts"));
const normalizedForgetting = memorySettings.resolveForgettingSettings(rawSettings.memory ?? {});
const rawGlobalWriteGate = rawSediment?.autoLlmWriteEnabled;
const globalWriteAuthorityEnabled = sedimentSettings.isSedimentGlobalWriteAuthorityEnabled(rawGlobalWriteGate);
const expectedGlobalWriteAuthorityEnabled = rawGlobalWriteGate === true
  || (typeof rawGlobalWriteGate === "string" && rawGlobalWriteGate.trim().toLowerCase() === "true");
const realApplyAuthorityEnabled = normalizedForgetting.executorRealApplyEnabled && globalWriteAuthorityEnabled;
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
const schemaGate = schema.properties.memory.properties.forgetting.properties.executorRealApplyEnabled;
const schemaGlobalWriteGate = schema.properties.sediment.properties.autoLlmWriteEnabled;

const before = sourceSnapshot();
const lifecycleReadOnly = lifecycle.rebuildLifecycleConvergence({ abrainHome, now: new Date(), persist: false });
if (!lifecycleReadOnly.ok || !lifecycleReadOnly.read_model || lifecycleReadOnly.written) {
  throw new Error(`read-only lifecycle build failed: ${lifecycleReadOnly.error ?? "unexpected_write"}`);
}
const after = sourceSnapshot();
const sourcesUnchanged = stable(before) === stable(after);
const codeFiles = [
  "extensions/memory/settings.ts",
  "extensions/sediment/settings.ts",
  "extensions/sediment/forgetting-agent-end.ts",
  "extensions/sediment/forgetting-executor.ts",
  "extensions/sediment/index.ts",
  "scripts/smoke-forgetting-real-apply-gate.mjs",
  "scripts/dossier-rm-forget-001-gate-production.mjs",
  "pi-astack-settings.schema.json",
];
const codeAggregate = sha256(codeFiles.map((file) => `${file}\0${fileHash(path.join(repoRoot, file))}`).join("\n"));
const metrics = lifecycleReadOnly.read_model.metrics;

const dossier = {
  schema_version: "rm-forget-001-real-apply-gate-production/v1",
  generated_at: new Date().toISOString(),
  evidence_mode: "production_configuration_and_zero_write_verification_only",
  scope: "fail-closed forgetting real-apply gate hold",
  privacy: "aggregate counts and SHA-256 only; no slug, body, source path, candidate text, or frontmatter",
  self_sha256_convention: "sha256(UTF-8 recursive-key-sorted compact JSON before self_sha256; arrays preserve order)",
  production_truth: {
    source_selection: "default_user_global_production",
    dedicated_gate_configured_present: configuredGatePresent,
    dedicated_gate_configured_type: configuredGateType,
    dedicated_gate_effective_enabled: normalizedForgetting.executorRealApplyEnabled,
    dedicated_gate_schema_type: schemaGate.type,
    dedicated_gate_schema_default: schemaGate.default,
    global_write_gate_configured_present: globalWriteGatePresent,
    global_write_gate_configured_type: globalWriteGateType,
    global_write_authority_effective_enabled: globalWriteAuthorityEnabled,
    global_write_gate_schema_enum: schemaGlobalWriteGate.enum,
    global_write_authority_semantics: "effective sediment auto-write true: boolean true or legacy string 'true'; staging-only/false/missing/malformed are closed",
    real_apply_authority_semantics: "literal boolean memory.forgetting.executorRealApplyEnabled===true AND effective sediment.autoLlmWriteEnabled=true",
    real_apply_authority_effective_enabled: realApplyAuthorityEnabled,
    real_apply_authority_effective_closed: !realApplyAuthorityEnabled,
    forgetting_evaluation_enabled: normalizedForgetting.enabled,
    archive_reactivation_authority: "existing sediment.autoLlmWriteEnabled semantics",
    archive_reactivation_authority_independent_of_dedicated_gate: true,
    eligible_current: before.proposals.pending_execution_ready_archive,
    eligible_e1_current: before.proposals.e1_execution_ready_archive,
    eligible_non_e1_current: before.proposals.non_e1_execution_ready_archive,
    eligible_long_tail_e1_current: before.proposals.long_tail_e1_execution_ready_archive,
  },
  before,
  lifecycle_read_only_hook: {
    ok: lifecycleReadOnly.ok,
    persist: false,
    written: lifecycleReadOnly.written,
    arrivals: metrics.arrivals,
    terminal: metrics.terminal,
    pending: metrics.pending,
    unbounded_pending: metrics.unbounded_pending,
    corrupt_records: metrics.source.corrupt_records,
    stable_item_ids_sha256: sha256(lifecycleReadOnly.read_model.rows.map((row) => row.item_id).sort().join("\n")),
  },
  after,
  boundaries: {
    production_demote_executed: false,
    durable_memory_mutated: false,
    proposal_source_mutated: false,
    forgetting_gate_opened: false,
    archive_reactivation_disabled: false,
    lane_g_created: false,
    human_review_queue_created: false,
    hard_delete_used: false,
    production_candidate_mutation_blocking_claimed: false,
    dynamic_candidate_mutation_blocking_evidence: "focused automated smoke only",
  },
  acceptance: {
    production_settings_selected: before.settings_sha256 !== null,
    dedicated_gate_effective_closed: normalizedForgetting.executorRealApplyEnabled === false,
    global_write_authority_matches_effective_auto_write_semantics: globalWriteAuthorityEnabled === expectedGlobalWriteAuthorityEnabled,
    global_write_schema_accepts_boolean_and_legacy_string_true: schemaGlobalWriteGate.enum.includes(true)
      && schemaGlobalWriteGate.enum.includes("true"),
    dual_gate_real_apply_effective_closed: !realApplyAuthorityEnabled,
    gate_schema_default_false: schemaGate.type === "boolean" && schemaGate.default === false,
    eligible_current_zero: before.proposals.pending_execution_ready_archive === 0,
    eligible_e1_current_zero: before.proposals.e1_execution_ready_archive === 0,
    staging_source_hash_unchanged: before.staging_sources.aggregate_sha256 === after.staging_sources.aggregate_sha256,
    proposal_hash_unchanged: before.proposals.file_sha256 === after.proposals.file_sha256,
    durable_hash_unchanged: before.durable_memory.aggregate_sha256 === after.durable_memory.aggregate_sha256,
    lifecycle_target_hash_unchanged: before.lifecycle_read_model_sha256 === after.lifecycle_read_model_sha256,
    demote_ledger_hash_unchanged: before.demote_ledger.file_sha256 === after.demote_ledger.file_sha256,
    reactivation_ledger_hash_unchanged: before.reactivation_ledger.file_sha256 === after.reactivation_ledger.file_sha256,
    lifecycle_hook_read_only_ran: lifecycleReadOnly.ok && lifecycleReadOnly.written === false,
    all_production_sources_unchanged: sourcesUnchanged,
    no_real_candidate_claim: before.proposals.pending_execution_ready_archive === 0
      && before.proposals.e1_execution_ready_archive === 0,
  },
  artifacts: {
    implementation_code_aggregate_sha256: codeAggregate,
  },
};

if (!Object.values(dossier.acceptance).every(Boolean)) {
  throw new Error(`production gate acceptance failed: ${JSON.stringify(dossier.acceptance)}`);
}
dossier.self_sha256 = sha256(stable(dossier));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, outputPath);
console.log(JSON.stringify({
  ok: true,
  self_sha256: dossier.self_sha256,
  dual_gate_real_apply_effective_closed: dossier.production_truth.real_apply_authority_effective_closed,
  dedicated_gate_effective_enabled: dossier.production_truth.dedicated_gate_effective_enabled,
  global_write_authority_effective_enabled: dossier.production_truth.global_write_authority_effective_enabled,
  eligible_current: dossier.production_truth.eligible_current,
  eligible_e1_current: dossier.production_truth.eligible_e1_current,
  proposal_sha256: dossier.after.proposals.file_sha256,
  durable_aggregate_sha256: dossier.after.durable_memory.aggregate_sha256,
  lifecycle_read_only_written: dossier.lifecycle_read_only_hook.written,
}, null, 2));
