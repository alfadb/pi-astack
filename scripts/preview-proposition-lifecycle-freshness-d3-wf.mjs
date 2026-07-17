#!/usr/bin/env node
/** ADR0040 D3-WF real production full-copy sandbox append/replay preview. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-sandbox-writer.ts"));
const { buildPropositionPolicyPushShadow } = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));
const { canonicalizeJcs, jcsSha256Hex, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const PROTECTED = Object.freeze([
  "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1",
  "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
  "/home/worker/.abrain/.state/sediment/proposition-lifecycle-freshness/v1",
  "/home/worker/.abrain/.state/sediment/proposition-lifecycle-freshness/v2",
  "/home/worker/.pi/agent/pi-astack-settings.json",
  "/home/worker/.pi/agent/settings.json",
]);

export async function runPropositionLifecycleFreshnessD3WfPreview() {
  const maximumAttempts = 4; let lastError;
  for (let workflowAttempt = 1; workflowAttempt <= maximumAttempts; workflowAttempt += 1) {
    try { return await runPreviewAttempt(workflowAttempt); }
    catch (error) {
      lastError = error;
      if (error?.message !== "D3_WF_PRODUCTION_L1_CHANGED_AFTER_WORKFLOW" || workflowAttempt === maximumAttempts) throw error;
    }
  }
  throw lastError;
}

async function runPreviewAttempt(workflowAttempt) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-d3-wf-preview-"));
  const protectedBefore = writer.captureNoFollowProtectedSnapshot(PROTECTED);
  try {
    const copied = await writer.copyProductionL1ToLifecycleSandbox({ sandboxRoot });
    const initialized = await writer.initializeLifecycleSandboxWorkflow({
      sandboxRoot,
      sandboxAbrainHome: copied.sandbox_abrain_home,
      repoRoot,
      sourceProductionSnapshot: copied.proposition_source_snapshot,
    });
    if (initialized.status === "BUSY" || !initialized.reader?.ok) throw new Error("D3_WF_PREVIEW_BOOTSTRAP_FAILED");
    const baselineProjection = await buildPropositionPolicyPushShadow({ abrainHome: copied.sandbox_abrain_home, repoRoot, registryPath: path.join(repoRoot, "schemas", "l1-schema-role-registry.json") });
    const baselineCandidateIds = baselineProjection.entries.entries.map((entry) => entry.source_event_id).sort();
    const tuple = await writer.prepareSandboxArchiveTuple({ sandboxAbrainHome: copied.sandbox_abrain_home, repoRoot });
    const committed = await writer.executeLifecycleSandboxTransaction({
      sandboxRoot,
      sandboxAbrainHome: copied.sandbox_abrain_home,
      repoRoot,
      sourceProductionSnapshot: copied.proposition_source_snapshot,
      tuple: tuple.tuple,
      canonicalEventJson: tuple.canonical_event_json,
      expectedPredecessor: { head_hash: initialized.head_hash, selection_hash: initialized.selection_hash },
    });
    if (committed.status !== "committed" || !committed.reader?.ok) throw new Error("D3_WF_PREVIEW_COMMIT_FAILED");
    const identical = await writer.executeLifecycleSandboxTransaction({
      sandboxRoot,
      sandboxAbrainHome: copied.sandbox_abrain_home,
      repoRoot,
      sourceProductionSnapshot: copied.proposition_source_snapshot,
      tuple: tuple.tuple,
      canonicalEventJson: tuple.canonical_event_json,
      expectedPredecessor: { head_hash: initialized.head_hash, selection_hash: initialized.selection_hash },
    });
    if (identical.status !== "identical" || identical.transaction_id !== committed.transaction_id) throw new Error("D3_WF_PREVIEW_IDEMPOTENCE_FAILED");
    const committedProjection = await buildPropositionPolicyPushShadow({ abrainHome: copied.sandbox_abrain_home, repoRoot, registryPath: path.join(repoRoot, "schemas", "l1-schema-role-registry.json") });
    const committedCandidateIds = committedProjection.entries.entries.map((entry) => entry.source_event_id).sort();
    const productionWorkflowAfter = await writer.captureWholeL1RawSnapshot(copied.production_abrain_home);
    const protectedAfter = writer.captureNoFollowProtectedSnapshot(PROTECTED);
    const productionL1Equal = canonicalizeJcs(copied.production_after) === canonicalizeJcs(productionWorkflowAfter);
    const protectedEqual = canonicalizeJcs(protectedBefore) === canonicalizeJcs(protectedAfter);
    const targetCandidateRemoved = baselineCandidateIds.includes(tuple.target_event_id) && !committedCandidateIds.includes(tuple.target_event_id);
    const relativeChanges = {
      input_events_delta: committed.reader.source_counts.input_events - initialized.reader.source_counts.input_events,
      lifecycle_events_delta: committed.reader.source_counts.lifecycle_events - initialized.reader.source_counts.lifecycle_events,
      candidates_delta: committed.reader.source_counts.candidates - initialized.reader.source_counts.candidates,
      stable_items_delta: committed.reader.item_count - initialized.reader.item_count,
      target_candidate_removed: targetCandidateRemoved,
    };
    if (!productionL1Equal) throw new Error("D3_WF_PRODUCTION_L1_CHANGED_AFTER_WORKFLOW");
    if (!protectedEqual) throw new Error("D3_WF_PRODUCTION_PROTECTED_SURFACE_CHANGED");
    if (relativeChanges.input_events_delta !== 1 || relativeChanges.lifecycle_events_delta !== 1 || relativeChanges.candidates_delta !== -1 || relativeChanges.stable_items_delta !== -1 || !targetCandidateRemoved) throw new Error("D3_WF_DYNAMIC_RELATIVE_CHANGE_MISMATCH");
    const base = {
      schema_version: "adr0040-d3-wf-sandbox-replay-preview-dossier/v3",
      canonicalization: "RFC8785-JCS",
      hash_algorithm: "sha256",
      authority: "repo_and_system_temp_sandbox_only",
      truth: "sandbox_staged_append_replay",
      production_source: {
        abrain_home: copied.production_abrain_home,
        whole_l1_snapshot_schema: copied.production_before.schema_version,
        whole_l1_hash_algorithm: copied.production_before.hash_algorithm,
        whole_l1_rows_hash_scope: copied.production_before.rows_hash_scope,
        whole_l1_snapshot_hash_scope: copied.production_before.snapshot_hash_scope,
        whole_l1_event_count: copied.production_before.event_count,
        whole_l1_event_ids_hash: copied.production_before.event_ids_hash,
        whole_l1_raw_sha256s_hash: copied.production_before.raw_sha256s_hash,
        whole_l1_rows_hash: copied.production_before.rows_hash,
        whole_l1_snapshot_hash: copied.production_before.snapshot_hash,
        copy_bracket_after_raw_sha256s_hash: copied.production_after.raw_sha256s_hash,
        copy_bracket_after_snapshot_hash: copied.production_after.snapshot_hash,
        workflow_attempt: workflowAttempt,
        workflow_after_event_count: productionWorkflowAfter.event_count,
        workflow_after_event_ids_hash: productionWorkflowAfter.event_ids_hash,
        workflow_after_raw_sha256s_hash: productionWorkflowAfter.raw_sha256s_hash,
        workflow_after_rows_hash: productionWorkflowAfter.rows_hash,
        workflow_after_snapshot_hash: productionWorkflowAfter.snapshot_hash,
        before_after_equal: canonicalizeJcs(copied.production_before) === canonicalizeJcs(copied.production_after),
        workflow_after_equals_copy_bracket_after: productionL1Equal,
        all_event_ids_and_raw_hashes_equal: copied.all_event_ids_and_raw_hashes_equal,
        no_hardlinks_to_production: copied.no_hardlinks_to_production,
      },
      copied_proposition_prestate: {
        input_event_count: copied.proposition_source_snapshot.input_event_count,
        input_event_ids: copied.proposition_source_snapshot.input_event_ids,
        input_event_ids_hash: copied.proposition_source_snapshot.input_event_ids_hash,
        rows_hash: copied.proposition_source_snapshot.rows_hash,
        snapshot_hash: copied.proposition_source_snapshot.snapshot_hash,
      },
      archive_tuple: {
        target_real_active_evidence_event_id: tuple.target_event_id,
        target_evidence_raw_sha256: tuple.tuple.target_evidence_raw_sha256,
        lifecycle_event_id: tuple.event_id,
        lifecycle_event_raw_sha256: tuple.canonical_event_bytes_sha256,
        lifecycle_event_utf8_bytes: Buffer.byteLength(tuple.canonical_event_json),
        tuple_hash: tuple.tuple_hash,
        producer: tuple.tuple.producer,
      },
      baseline: {
        head_hash: initialized.head_hash,
        selection_hash: initialized.selection_hash,
        p2a_bundle_hash: initialized.reader.p2a_bundle_hash,
        stable_bundle_hash: initialized.reader.stable_bundle_hash,
        active_candidate_event_ids: baselineCandidateIds,
        item_count: initialized.reader.item_count,
        source_counts: initialized.reader.source_counts,
      },
      committed: {
        transaction_id: committed.transaction_id,
        intent_hash: committed.intent_hash,
        intent_head_hash: committed.intent_head_hash,
        proof_hash: committed.proof_hash,
        committed_head_hash: committed.committed_head_hash,
        selection_hash: committed.selection_hash,
        p2a_bundle_hash: committed.reader.p2a_bundle_hash,
        stable_bundle_hash: committed.reader.stable_bundle_hash,
        stable_manifest_hash: committed.reader.stable_manifest_hash,
        render_raw_sha256: sha256Hex(committed.reader.view_md),
        active_candidate_event_ids: committedCandidateIds,
        item_count: committed.reader.item_count,
        source_counts: committed.reader.source_counts,
        event_state: committed.event_state,
        relative_changes: relativeChanges,
      },
      recovery: {
        same_transaction_idempotent: true,
        idempotent_status: identical.status,
        idempotent_head_hash: identical.committed_head_hash,
        idempotent_selection_hash: identical.selection_hash,
      },
      production_nonmutation: {
        protected_paths: PROTECTED,
        before_snapshot_hash: protectedBefore.snapshot_hash,
        after_snapshot_hash: protectedAfter.snapshot_hash,
        equal: protectedEqual,
        production_l1_copy_bracket_equal: canonicalizeJcs(copied.production_before) === canonicalizeJcs(copied.production_after),
        production_l1_workflow_after_equal: productionL1Equal,
        observed_production_mutation: !(protectedEqual && productionL1Equal),
      },
    };
    return Object.freeze({ ...base, dossier_hash: jcsSha256Hex(base) });
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPropositionLifecycleFreshnessD3WfPreview()
    .then((dossier) => process.stdout.write(`${canonicalizeJcs(dossier)}\n`))
    .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
}
