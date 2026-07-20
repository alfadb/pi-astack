#!/usr/bin/env node
/** R4.2 production operator. Default is a dynamic, non-authoritative preview. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HASH64,
  REVISION,
  SCHEMAS,
  STAGE_STATE,
  addSelfHash,
  canonicalizeJcs,
} from "../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs";
import {
  adoptAmbientStateProduction,
  buildDynamicReadOnlyReport,
  buildInitialDynamicPreview,
  buildPostDossierFixture,
  buildRuntimeEnablePreviewProduction,
  continueProduction,
  disposeRuntimeAuditTempProduction,
  disposeStagedTempProduction,
  executeProduction,
  loadAndValidateStaticBundle,
  previewRuntimeAuditTempDispositionProduction,
  previewStagedTempDispositionProduction,
  recoverReceiptProduction,
  rollbackGateProduction,
  rollbackProduction,
  runtimeEnableProduction,
} from "../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const forbidden = [
  "--force", "--yes", "--target", "--settings", "--session", "--authorization",
  "--authorization-json", "--authorization-text", "--preview-file", "--report",
  "--stdin", "--tuple", "--token", "--operation-id", "--attempt-id", "--path",
].find((flag) => argv.includes(flag) || argv.some((arg) => arg.startsWith(`${flag}=`)));
if (forbidden) throw new Error(`caller-supplied authority/path/preview input forbidden: ${forbidden}`);

const modes = new Set([
  "--validate-static", "--initial-preview", "--execute", "--continue", "--recover-receipt",
  "--adopt-ambient-state", "--preview-staged-temp-disposition", "--dispose-staged-temp",
  "--runtime-enable-preview", "--runtime-enable", "--preview-runtime-audit-temp-disposition",
  "--dispose-runtime-audit-temp", "--rollback-gate", "--rollback", "--generate-post-dossier",
]);
if (argv.length > 1 || (argv.length === 1 && !modes.has(argv[0]))) {
  throw new Error("usage: operator [--validate-static|--initial-preview|--execute|--continue|--recover-receipt|--adopt-ambient-state|--preview-staged-temp-disposition|--dispose-staged-temp|--runtime-enable-preview|--runtime-enable|--preview-runtime-audit-temp-disposition|--dispose-runtime-audit-temp|--rollback-gate|--rollback|--generate-post-dossier]");
}

function output(value) { process.stdout.write(`${canonicalizeJcs(value)}\n`); }
function haltFields(mode, error) {
  const mutation_count = Number.isSafeInteger(error?.mutationCount) ? error.mutationCount : 0;
  const status = error?.status === "NO_FURTHER_WRITE" || mutation_count > 0 ? "NO_FURTHER_WRITE" : "ZERO_WRITE_HALT";
  return { revision: REVISION, status, error_code: error?.code ?? "S2_NOT_AUTHORIZED", mutation_count, requested_mode: mode, authoritative: false, production_write_invoked: mutation_count > 0 };
}
function readonlyDenied(mode, error, staticContractHash) {
  const fields = haltFields(mode, error);
  return addSelfHash({
    schema_version: SCHEMAS.conflict_report,
    revision: REVISION,
    status: fields.status,
    static_contract_hash: staticContractHash,
    operation_id: HASH64.test(error?.operationId ?? "") ? error.operationId : "not_yet_derived",
    coordinate_hash: error.coordinateHash,
    before_identity: { state: "not_observed" },
    after_identity: { state: "not_observed" },
    retained_transcript_state: { verified: false, reason: fields.error_code, requested_mode: mode, stage_state: STAGE_STATE, production_write_invoked: fields.production_write_invoked },
    control_inventory: [],
    required_operator_action: "stop_or_coordinate_conflicting_writer_then_repreview_and_reauthorize",
    authoritative: false,
  }, "report_hash");
}

const mode = argv[0] ?? "--preview";
try {
  if (mode === "--preview") {
    output(buildDynamicReadOnlyReport(repoRoot));
  } else if (mode === "--validate-static") {
    const bundle = loadAndValidateStaticBundle(repoRoot);
    output({ verified: true, revision: REVISION, static_contract_hash: bundle.contract.value.static_contract_hash, source_manifest_hash: bundle.source.value.self_hash, adapter_manifest_hash: bundle.adapter.value.self_hash, operator_manifest_hash: bundle.operator.value.self_hash, dossier_hash: bundle.dossier.value.dossier_hash, preview_hash: bundle.preview.value.preview_hash, stage_state: STAGE_STATE, production_write_invoked: false });
  } else if (mode === "--initial-preview") {
    output(buildInitialDynamicPreview(repoRoot));
  } else if (mode === "--execute") {
    output(executeProduction(repoRoot));
  } else if (mode === "--continue") {
    output(continueProduction(repoRoot));
  } else if (mode === "--recover-receipt") {
    output(recoverReceiptProduction(repoRoot));
  } else if (mode === "--adopt-ambient-state") {
    output(adoptAmbientStateProduction(repoRoot));
  } else if (mode === "--preview-staged-temp-disposition") {
    output(previewStagedTempDispositionProduction(repoRoot));
  } else if (mode === "--dispose-staged-temp") {
    output(disposeStagedTempProduction(repoRoot));
  } else if (mode === "--runtime-enable-preview") {
    output({
      schema_version: "adr0040-d3-v2-session-start-r4.2-cli-runtime-preview-observation/v1",
      revision: REVISION,
      observation_only: true,
      same_pi_process_required_for_enable: true,
      cross_process_enable_promised: false,
      preview: buildRuntimeEnablePreviewProduction(repoRoot),
    });
  } else if (mode === "--runtime-enable") {
    output({
      ...runtimeEnableProduction(repoRoot),
      cli_process_scope: "observation_only_unless_preview_and_authorization_occur_in_this_same_process",
      cross_process_enable_promised: false,
    });
  } else if (mode === "--preview-runtime-audit-temp-disposition") {
    output(previewRuntimeAuditTempDispositionProduction(repoRoot));
  } else if (mode === "--dispose-runtime-audit-temp") {
    output(disposeRuntimeAuditTempProduction(repoRoot));
  } else if (mode === "--rollback-gate") {
    output(rollbackGateProduction(repoRoot));
  } else if (mode === "--rollback") {
    output(rollbackProduction(repoRoot));
  } else if (mode === "--generate-post-dossier") {
    const bundle = loadAndValidateStaticBundle(repoRoot);
    output(buildPostDossierFixture(bundle.contract.value));
  }
} catch (error) {
  const bundle = (() => { try { return loadAndValidateStaticBundle(repoRoot); } catch { return null; } })();
  const canEmitConflict = bundle && HASH64.test(error?.coordinateHash ?? "");
  output(canEmitConflict ? readonlyDenied(mode.slice(2), error, bundle.contract.value.static_contract_hash) : haltFields(mode.slice(2), error));
  if (mode !== "--preview" && mode !== "--validate-static") process.exitCode = 2;
}
