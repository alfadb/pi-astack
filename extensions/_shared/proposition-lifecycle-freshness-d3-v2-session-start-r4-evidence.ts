/// <reference types="node" />
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { parseJsonRejectDuplicateKeys } from "./strict-json";
import { captureProtectedPrestate, readPublishedD3PubSelection, D3_PUB_HARD_ROOT } from "./proposition-lifecycle-freshness-production-core";
import {
  activationRootHasNoBoundObject,
  buildD3V2SessionStartAdapterManifest,
  validateD3V2SessionStartAdapterManifest,
  normalizeSettingsMutationClosed,
} from "./proposition-lifecycle-freshness-d3-v2-session-start";
import { captureTrustedSessionPrefixAttestation } from "./trusted-session-transcript";
import * as r4 from "./proposition-lifecycle-freshness-d3-v2-session-start-r4";

const PREDECESSOR_HASH = "2475dbbc475be1b11e6039d917566f079645a46ae33d383d406f67676af04995";
const DOSSIER_SCHEMA = "adr0040-d3-v2-session-start-r4-execution-ready-dossier/v2";
const PREVIEW_SCHEMA = "adr0040-d3-v2-session-start-r4-production-read-only-preview/v2";

export interface R4LiveEvidenceBuild {
  dossier: Readonly<Record<string, unknown>>;
  dossierRaw: string;
  preview: Readonly<Record<string, unknown>>;
  previewRaw: string;
  sourceCommitClosure: Readonly<Record<string, unknown>>;
  protectedBefore: Readonly<Record<string, unknown>>;
  protectedAfter: Readonly<Record<string, unknown>>;
}

export function protectedD3V2R4ProductionPaths(repoRootInput: string): readonly string[] {
  const repoRoot = path.resolve(repoRootInput);
  return Object.freeze([...new Set([
    resolveGitMetadataRoot(repoRoot),
    r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH,
    r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH,
    D3_PUB_HARD_ROOT,
    r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT,
    r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT,
    r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT,
    r4.D3_V2_R4_PRODUCTION_RUNTIME_AUDIT,
    r4.D3_V2_R4_PRODUCTION_OPERATOR_AUDIT,
    r4.D3_V2_R4_PRODUCTION_QUARANTINE_TARGET,
    path.dirname(r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT),
  ].map((item) => path.resolve(item)))].sort(compare));
}

export function buildD3V2R4LiveEvidence(repoRootInput: string): R4LiveEvidenceBuild {
  const repoRoot = path.resolve(repoRootInput);
  const protectedPaths = protectedD3V2R4ProductionPaths(repoRoot);
  const targetFullBefore = captureExactRegularIdentity(r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH);
  const protectedBefore = captureProtectedPrestate(protectedPaths);

  const manifest = r4.buildD3V2R4OperatorManifest(repoRoot);
  r4.validateD3V2R4OperatorManifest(manifest);
  const manifestEvidence = readCanonical(path.join(repoRoot, r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE), "manifest_hash");
  r4.validateD3V2R4OperatorManifest(manifestEvidence.value);
  if (canonicalizeJcs(manifest) !== canonicalizeJcs(manifestEvidence.value)) fail("R4_EVIDENCE_MANIFEST", "operator manifest evidence differs from live source closure");

  const predecessor = readCanonical(path.join(repoRoot, r4.D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE), "dossier_hash");
  if (predecessor.value.revision !== "R3.9" || predecessor.value.dossier_hash !== PREDECESSOR_HASH || predecessor.value.default_deny?.status !== "NOT_AUTHORIZED") {
    fail("R4_EVIDENCE_PREDECESSOR", "immutable R3.9 predecessor identity differs");
  }

  const published = readPublishedD3PubSelection(D3_PUB_HARD_ROOT) as any;
  const d3 = deepFreeze({
    selection_hash: published.selection.selection_hash,
    head_hash: published.head.head_hash,
    proof_hash: published.proof.proof_hash,
    intent_hash: published.selection.intent_hash,
    stable_bundle_hash: published.artifact_closure.stable.bundle_hash,
    p2a_bundle_hash: published.artifact_closure.p2a.bundle_hash,
    generation: published.selection.generation,
    selection_seq: published.selection.seq,
  });
  const adapterManifest = buildD3V2SessionStartAdapterManifest({ repoRoot });
  validateD3V2SessionStartAdapterManifest(adapterManifest);
  const adapterManifestEvidence = readCanonical(path.join(repoRoot, r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE), "manifest_hash");
  validateD3V2SessionStartAdapterManifest(adapterManifestEvidence.value);
  if (canonicalizeJcs(adapterManifest) !== canonicalizeJcs(adapterManifestEvidence.value)) {
    fail("R4_EVIDENCE_ADAPTER_MANIFEST", "R4.1 adapter manifest evidence differs from the live closed rebuild");
  }

  const targetFile = captureTrustedSessionPrefixAttestation({
    sessionsRoot: r4.D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT,
    sessionPath: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH,
    expectedSessionId: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_ID,
    prefixBytes: r4.D3_V2_R4_FROZEN_TARGET_PREFIX_BYTES,
  });
  const authFile = captureTrustedSessionPrefixAttestation({
    sessionsRoot: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT,
    sessionPath: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH,
    expectedSessionId: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID,
    prefixBytes: r4.D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_BYTES,
  });
  if (targetFile.prefix_sha256 !== r4.D3_V2_R4_FROZEN_TARGET_PREFIX_SHA256 || authFile.prefix_sha256 !== r4.D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_SHA256) {
    fail("R4_EVIDENCE_SESSION_PREFIX", "source-frozen target or authorization prefix differs");
  }
  const targetBinding = deepFreeze({ session_id: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_ID, sessions_root: r4.D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT, session_file: targetFile });
  const authorizationBinding = deepFreeze({ session_id: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID, sessions_root: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT, session_file: authFile });

  const settings = r4.captureD3V2R4SettingsPrestate(r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH);
  const settingsBinding = r4.buildD3V2R4SettingsBinding({ controlRoot: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT, operatorManifestHash: manifest.manifest_hash, settingsPath: r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH });
  const desired = r4.buildD3V2R4DesiredSettings({ sessionId: targetBinding.session_id, d3, adapterManifestHash: adapterManifest.manifest_hash, r4Binding: settingsBinding });
  const settingsPostRaw = r4.renderD3V2R4SettingsPost(settings.parsed, desired);
  const sourceCommitClosure = r4.inspectD3V2R4SourceCommitClosure(repoRoot, { manifest_hash: manifest.manifest_hash, graph_hash: manifest.graph.graph_hash, source_closure_hash: manifest.source_closure_hash });
  const liveRule = asRecord(settings.parsed.ruleInjector, "live ruleInjector");
  const liveV1 = optionalRecord(liveRule.propositionPolicyStableViewInjection);
  const liveV1Selector = optionalRecord(liveV1?.selector);
  const liveV1Ids = Array.isArray(liveV1Selector?.session_ids) ? liveV1Selector.session_ids : [];
  const controlAbsent = !lstatMaybe(r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT);
  const rollbackAbsent = !lstatMaybe(r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT);
  const activationAbsentRecovery = deepFreeze({
    settings: "exact_A_pre_only",
    intent: "exact_tuple_final_or_exact_deterministic_pending",
    activation: "absent_no_final_or_pending",
    receipt: "absent_no_final_or_pending",
    closure: "fresh_continue_auth+target_auth_bindings+source_evidence+control_inventory",
    action: ["build_and_validate_expected_activation", "create_only_activation", "settings_CAS", "create_only_receipt"],
    settings_post_or_receipt_present: "halt_without_cleanup",
  });

  const targetFileAfter = captureTrustedSessionPrefixAttestation({
    sessionsRoot: r4.D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT,
    sessionPath: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH,
    expectedSessionId: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_ID,
    prefixBytes: r4.D3_V2_R4_FROZEN_TARGET_PREFIX_BYTES,
  });
  const authFileAfter = captureTrustedSessionPrefixAttestation({
    sessionsRoot: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT,
    sessionPath: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH,
    expectedSessionId: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID,
    prefixBytes: r4.D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_BYTES,
  });
  const targetFullAfter = captureExactRegularIdentity(r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH);
  const protectedAfter = captureProtectedPrestate(protectedPaths);
  const protectedEqual = canonicalizeJcs(protectedBefore) === canonicalizeJcs(protectedAfter);
  const targetFullEqual = canonicalizeJcs(targetFullBefore) === canonicalizeJcs(targetFullAfter);
  const targetPrefixEqual = canonicalizeJcs(targetFile) === canonicalizeJcs(targetFileAfter);
  const authorizationFrozenPrefixEqual = canonicalizeJcs(authFile) === canonicalizeJcs(authFileAfter);
  const adapterEvidenceExact = canonicalizeJcs(adapterManifest) === canonicalizeJcs(adapterManifestEvidence.value);
  const settingsNonV2Equal = settingsDeepSemanticsOutsideV2Equal(settings.parsed, settingsPostRaw);
  const assertions = deepFreeze({
    target_and_authorization_sessions_distinct: String(targetBinding.session_id) !== String(authorizationBinding.session_id) && targetBinding.session_file.path !== authorizationBinding.session_file.path && (targetBinding.session_file.dev !== authorizationBinding.session_file.dev || targetBinding.session_file.ino !== authorizationBinding.session_file.ino),
    target_prefix_matches_source_freeze: targetBinding.session_file.prefix_bytes === r4.D3_V2_R4_FROZEN_TARGET_PREFIX_BYTES && targetBinding.session_file.prefix_sha256 === r4.D3_V2_R4_FROZEN_TARGET_PREFIX_SHA256,
    authorization_prefix_matches_source_freeze: authorizationBinding.session_file.prefix_bytes === r4.D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_BYTES && authorizationBinding.session_file.prefix_sha256 === r4.D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_SHA256,
    target_complete_identity_and_bytes_unchanged: targetFullEqual && targetPrefixEqual,
    authorization_append_tolerant_frozen_prefix_identity_header_session_unchanged: authorizationFrozenPrefixEqual,
    authorization_session_excluded_from_generic_stable_snapshot: !protectedPaths.includes(path.resolve(r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH)) && !protectedPaths.includes(path.resolve(path.dirname(r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH))),
    target_not_in_v1_selector: !liveV1Ids.includes(targetBinding.session_id),
    v2_prestate_absent_or_exact_disabled_empty: settings.v2_prestate === "absent" || settings.v2_prestate === "disabled_empty",
    foreign_authorized_activation_absent: activationRootHasNoBoundObject(r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT),
    r3_9_predecessor_exact: predecessor.value.revision === "R3.9" && predecessor.value.dossier_hash === PREDECESSOR_HASH,
    adapter_manifest_live_rebuilt_equals_new_r4_evidence: adapterManifest.graph.files.length === 82 && adapterEvidenceExact,
    adapter_manifest_new_path_in_operator_head_blob_closure: manifest.critical_required_paths.includes(r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE) && manifest.graph.files.some((row) => row.path === r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE),
    operator_manifest_live_equals_evidence: canonicalizeJcs(manifest) === canonicalizeJcs(manifestEvidence.value),
    package_lock_in_manifest_and_not_ignored_by_live_policy: manifest.graph.files.some((row) => row.path === "package-lock.json") && !fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8").split(/\r?\n/).includes("package-lock.json"),
    control_and_rollback_roots_distinct: path.resolve(r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT) !== path.resolve(r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT),
    control_and_rollback_roots_unpublished: controlAbsent && rollbackAbsent,
    settings_post_hash_recomputed: sha256Hex(settingsPostRaw) === sha256Hex(r4.renderD3V2R4SettingsPost(settings.parsed, desired)),
    settings_other_keys_v1_and_nested_semantics_preserved: settingsNonV2Equal,
    natural_intent_final_only_window_recovery_closed: activationAbsentRecovery.settings === "exact_A_pre_only" && activationAbsentRecovery.activation === "absent_no_final_or_pending" && activationAbsentRecovery.receipt === "absent_no_final_or_pending" && activationAbsentRecovery.settings_post_or_receipt_present === "halt_without_cleanup",
    protected_snapshot_equal: protectedEqual,
  });
  if (!Object.values(assertions).every((value) => value === true)) fail("R4_EVIDENCE_ASSERTION", "one or more executable dossier predicates failed", { assertions });

  const previewStabilityPolicy = deepFreeze({
    generic_snapshot: "stable_surfaces_only_excludes_active_authorization_transcript_and_its_parent_directory",
    target_session: "exact_complete_identity_and_bytes_must_remain_unchanged",
    authorization_session: "append_tolerant_frozen_prefix_bytes_sha256_dev_ino_header_sha256_and_session_id_must_remain_unchanged",
    operator_zero_write: "strace_must_show_no_mutating_filesystem_syscall",
  });
  const sourceCommitClosureContract = deepFreeze({
    graph_and_critical_files: "execute_continue_require_exact_nonignored_HEAD_blobs",
    evidence_files: "adapter_operator_dossier_preview_require_exact_nonignored_HEAD_blobs",
    git_optional_locks: "0",
    enforcement: "execute_continue_only_preview_remains_read_only",
  });

  const dossierBase = {
    schema_version: DOSSIER_SCHEMA,
    revision: r4.D3_V2_R4_REVISION,
    predecessor_revision: "R3.9",
    canonicalization: "RFC8785-JCS",
    mode: "production_create_bind_operator_execution_ready_read_only",
    authorization_status: "NOT_AUTHORIZED",
    executable: false,
    target_session_binding: targetBinding,
    authorization_transcript_binding: authorizationBinding,
    d3_identities: d3,
    adapter_manifest: { relative_path: r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE, raw_sha256: sha256Hex(adapterManifestEvidence.raw), manifest_hash: adapterManifest.manifest_hash, graph_hash: adapterManifest.graph.graph_hash },
    operator_manifest: { relative_path: r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE, raw_sha256: sha256Hex(manifestEvidence.raw), manifest_hash: manifest.manifest_hash, graph_hash: manifest.graph.graph_hash, source_closure_hash: manifest.source_closure_hash, file_count: manifest.graph.files.length },
    predecessor_dossier: { relative_path: r4.D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE, raw_sha256: sha256Hex(predecessor.raw), self_hash: predecessor.value.dossier_hash },
    settings: { path: r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH, allowed_prestate: settings.v2_prestate, pre_identity: settings.identity, post_raw_sha256: sha256Hex(settingsPostRaw), desired_v2_subtree: desired, mutation_scope: "only_v2_key", parser: "duplicate_key_rejecting_json", lock: "retained_settings_parent_OFD", noncooperative_writer_residual: r4.D3_V2_R4_NONCOOPERATIVE_WRITER_RESIDUAL },
    control_paths: { control_root: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT, intent: "intents/{operation_id}.json", activation: "activations/{operation_id}.json", receipt: "receipts/{operation_id}.json", operator_audit_path: r4.D3_V2_R4_PRODUCTION_OPERATOR_AUDIT, rollback_target: r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT, old_activation_root: r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT, runtime_audit_path: r4.D3_V2_R4_PRODUCTION_RUNTIME_AUDIT, quarantine_target: r4.D3_V2_R4_PRODUCTION_QUARANTINE_TARGET },
    authorization_contract: { initial_phrase_utf8_bytes: Buffer.byteLength(r4.D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE), initial_phrase_sha256: sha256Hex(r4.D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE), continue_phrase_utf8_bytes: Buffer.byteLength(r4.D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE), continue_phrase_sha256: sha256Hex(r4.D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE), coordinates_read_only_from_authorization_transcript: authorizationBinding.session_id, target_prefix_independently_verified: targetBinding.session_id, latest_standalone_role_user_exact_required: true, continue_later_coordinate_required: true },
    operation_contract: { operation_id: "SHA256(RFC8785-JCS(full_authorization_tuple))", object_order: ["intent", "activation", "settings_CAS", "receipt"], create_only_pending: ".<operation_id>.<kind>.pending", execute_existing_target_or_pending: "halt", fresh_continue_exact_pending_recovery_only: true, activation_authorized_once_no_flip: true, auto_retry: false },
    runtime_gate: { required_faces: ["settings_post", "intent", "AUTHORIZED_activation", "commit_receipt"], target_trusted_jsonl_required: true, authorization_trusted_jsonl_required: true, pending_temp_result: "selected_zero_injection", mismatch_result: "selected_zero_injection_no_ADR0039_fallback" },
    recovery: { requires_fresh_continue_authorization: true, states: ["A_pre+exact_I+no_A+no_R=>create_A_then_CAS+R", "A_pre+I+A+no_R=>CAS+R", "B_post+I+A+no_R=>R", "B_post+I+A+R=>terminal", "A_pre+R=>halt", "B_post+no_A=>halt", "all_A_B_or_object_mismatch=>halt"], activation_absent_reconstruction: activationAbsentRecovery, pending_recovery: ["temp_nlink1_exact=>unlink_fsync_then_republish", "final+temp_same_inode_nlink2_exact=>unlink_temp_fsync", "final_nlink1_exact=>fsync_and_verify", "foreign_temp=>halt"] },
    rollback_boundary: { invoked: controlAbsent && rollbackAbsent ? "no_live_control_or_rollback_root" : "unexpected_live_state", preauthorized: false, state_root_must_equal_activation_rollback_target: r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT, independent_from_control_root: path.resolve(r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT) !== path.resolve(r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT) },
    source_commit_binding: { manifest_closure_hash: manifest.source_closure_hash, package_lock_tracked_at_required_commit: true, every_graph_and_critical_file_must_equal_HEAD_blob: true, git_optional_locks: "0", clean_status_is_not_commit_closure: true, runtime_commit_binding_required_for_execute_continue: true },
    preview_stability_policy: previewStabilityPolicy,
    protected_snapshot: { roots: protectedPaths, before_hash: protectedBefore.snapshot_hash, after_hash: protectedAfter.snapshot_hash, before_row_count: protectedBefore.row_count, after_row_count: protectedAfter.row_count, equal: protectedEqual },
    assertions,
    status: "S2_NOT_AUTHORIZED",
  };
  const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) });
  validateDossierClosed(dossier);
  const dossierRaw = `${canonicalizeJcs(dossier)}\n`;

  const previewBase = {
    schema_version: PREVIEW_SCHEMA,
    revision: r4.D3_V2_R4_REVISION,
    mode: "production_read_only_preview",
    authorization_status: "NOT_AUTHORIZED",
    executable: false,
    dossier: { relative_path: r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE, raw_sha256: sha256Hex(dossierRaw), self_hash: dossier.dossier_hash },
    operator_manifest_hash: manifest.manifest_hash,
    adapter_manifest: { relative_path: r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE, raw_sha256: sha256Hex(adapterManifestEvidence.raw), manifest_hash: adapterManifest.manifest_hash, graph_hash: adapterManifest.graph.graph_hash },
    target_session_binding: targetBinding,
    authorization_transcript_binding: authorizationBinding,
    settings_pre_raw_sha256: settings.identity.raw_sha256,
    settings_post_raw_sha256: sha256Hex(settingsPostRaw),
    preview_stability_policy: previewStabilityPolicy,
    protected_snapshot: { roots: protectedPaths, before_hash: protectedBefore.snapshot_hash, after_hash: protectedAfter.snapshot_hash, equal: protectedEqual },
    source_commit_closure_contract: sourceCommitClosureContract,
    assertions,
    status: "S2_NOT_AUTHORIZED",
  };
  const preview = deepFreeze({ ...previewBase, preview_hash: jcsSha256Hex(previewBase) });
  validatePreviewClosed(preview);
  const previewRaw = `${canonicalizeJcs(preview)}\n`;
  return { dossier, dossierRaw, preview, previewRaw, sourceCommitClosure, protectedBefore, protectedAfter };
}

export function loadVerifiedD3V2R4ProductionEvidence(
  repoRootInput: string,
  options: { mode: "preview" | "execute" | "continue" } = { mode: "preview" },
): {
  frozen: r4.D3V2R4FrozenBinding;
  preview: Readonly<Record<string, unknown>>;
  previewRaw: string;
  sourceCommitClosure: Readonly<Record<string, unknown>>;
  evidenceFilesExactAtHead: boolean;
} {
  const repoRoot = path.resolve(repoRootInput);
  const dossierPath = path.join(repoRoot, r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE);
  const previewPath = path.join(repoRoot, r4.D3_V2_R4_PREVIEW_RELATIVE);
  const manifestPath = path.join(repoRoot, r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE);
  const adapterManifestPath = path.join(repoRoot, r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE);
  const committedDossier = readCanonical(dossierPath, "dossier_hash");
  const committedPreview = readCanonical(previewPath, "preview_hash");
  const committedManifest = readCanonical(manifestPath, "manifest_hash");
  const committedAdapterManifest = readCanonical(adapterManifestPath, "manifest_hash");
  validateDossierClosed(committedDossier.value);
  validatePreviewClosed(committedPreview.value);
  r4.validateD3V2R4OperatorManifest(committedManifest.value as any);
  validateD3V2SessionStartAdapterManifest(committedAdapterManifest.value);
  const d = committedDossier.value;
  let sourceCommitClosure: Readonly<Record<string, unknown>>;
  if (options.mode === "continue") {
    verifyContinueLiveInputs(repoRoot, d, committedPreview.value, committedManifest, committedAdapterManifest);
    sourceCommitClosure = r4.inspectD3V2R4SourceCommitClosure(repoRoot, { manifest_hash: d.operator_manifest.manifest_hash, graph_hash: d.operator_manifest.graph_hash, source_closure_hash: d.operator_manifest.source_closure_hash });
  } else {
    const rebuilt = buildD3V2R4LiveEvidence(repoRoot);
    if (canonicalizeJcs(liveComparableDossier(committedDossier.value)) !== canonicalizeJcs(liveComparableDossier(rebuilt.dossier))
      || canonicalizeJcs(liveComparablePreview(committedPreview.value)) !== canonicalizeJcs(liveComparablePreview(rebuilt.preview))) {
      fail("R4_EVIDENCE_LIVE_REBUILD", "committed dossier/preview semantic bindings differ from full live reconstruction");
    }
    sourceCommitClosure = rebuilt.sourceCommitClosure;
  }
  const evidenceFilesExactAtHead = [
    [r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE, committedDossier.raw],
    [r4.D3_V2_R4_PREVIEW_RELATIVE, committedPreview.raw],
    [r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE, committedManifest.raw],
    [r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE, committedAdapterManifest.raw],
  ].every(([relative, raw]) => exactHeadBlob(repoRoot, relative, raw));
  return { frozen: frozenFromDossier(d, committedDossier.raw), preview: committedPreview.value, previewRaw: committedPreview.raw, sourceCommitClosure, evidenceFilesExactAtHead };
}

function frozenFromDossier(d: Record<string, any>, dossierRaw: string): r4.D3V2R4FrozenBinding {
  return deepFreeze({
    schema_version: "adr0040-d3-v2-session-start-r4-frozen-execution-binding/v2",
    target_session_binding: runtimeSessionBinding(d.target_session_binding),
    authorization_transcript_binding: runtimeSessionBinding(d.authorization_transcript_binding),
    settings_path: d.settings.path,
    settings_pre: d.settings.pre_identity,
    settings_post_raw_sha256: d.settings.post_raw_sha256,
    desired_settings: d.settings.desired_v2_subtree,
    control_root: d.control_paths.control_root,
    old_activation_root: d.control_paths.old_activation_root,
    runtime_audit_path: d.control_paths.runtime_audit_path,
    operator_audit_path: d.control_paths.operator_audit_path,
    rollback_target: d.control_paths.rollback_target,
    quarantine_target: d.control_paths.quarantine_target,
    d3_identities: d.d3_identities,
    adapter_manifest_hash: d.adapter_manifest.manifest_hash,
    operator_manifest: { relative_path: d.operator_manifest.relative_path, raw_sha256: d.operator_manifest.raw_sha256, manifest_hash: d.operator_manifest.manifest_hash, graph_hash: d.operator_manifest.graph_hash, source_closure_hash: d.operator_manifest.source_closure_hash },
    predecessor_dossier: d.predecessor_dossier,
    execution_dossier: { relative_path: r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE, raw_sha256: sha256Hex(dossierRaw), self_hash: d.dossier_hash },
    source_commit: null,
    source_commit_required_at_production_authorization: true,
  }) as r4.D3V2R4FrozenBinding;
}

function runtimeSessionBinding(value: Record<string, any>): r4.D3V2R4SessionBinding {
  const file = value.session_file;
  return deepFreeze({
    session_id: String(value.session_id),
    sessions_root: String(value.sessions_root),
    session_file: { path: String(file.path), dev: Number(file.dev), ino: Number(file.ino), prefix_bytes: Number(file.prefix_bytes), prefix_sha256: String(file.prefix_sha256) },
  });
}

function verifyContinueLiveInputs(
  repoRoot: string,
  d: Record<string, any>,
  preview: Record<string, any>,
  manifestEvidence: { raw: string; value: Record<string, any> },
  adapterManifestEvidence: { raw: string; value: Record<string, any> },
): void {
  const manifest = r4.buildD3V2R4OperatorManifest(repoRoot);
  if (canonicalizeJcs(manifest) !== canonicalizeJcs(manifestEvidence.value)
    || d.operator_manifest.raw_sha256 !== sha256Hex(manifestEvidence.raw)
    || d.operator_manifest.manifest_hash !== manifest.manifest_hash
    || d.operator_manifest.graph_hash !== manifest.graph.graph_hash
    || d.operator_manifest.source_closure_hash !== manifest.source_closure_hash) fail("R4_EVIDENCE_CONTINUE_MANIFEST", "continue live operator manifest differs");
  const predecessor = readCanonical(path.join(repoRoot, r4.D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE), "dossier_hash");
  if (canonicalizeJcs(d.predecessor_dossier) !== canonicalizeJcs({ relative_path: r4.D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE, raw_sha256: sha256Hex(predecessor.raw), self_hash: predecessor.value.dossier_hash }) || predecessor.value.dossier_hash !== PREDECESSOR_HASH) fail("R4_EVIDENCE_CONTINUE_PREDECESSOR", "continue predecessor differs");
  const published = readPublishedD3PubSelection(D3_PUB_HARD_ROOT) as any;
  const liveD3 = { selection_hash: published.selection.selection_hash, head_hash: published.head.head_hash, proof_hash: published.proof.proof_hash, intent_hash: published.selection.intent_hash, stable_bundle_hash: published.artifact_closure.stable.bundle_hash, p2a_bundle_hash: published.artifact_closure.p2a.bundle_hash, generation: published.selection.generation, selection_seq: published.selection.seq };
  if (canonicalizeJcs(liveD3) !== canonicalizeJcs(d.d3_identities)) fail("R4_EVIDENCE_CONTINUE_D3", "continue live D3 differs");
  const adapter = buildD3V2SessionStartAdapterManifest({ repoRoot });
  validateD3V2SessionStartAdapterManifest(adapter);
  validateD3V2SessionStartAdapterManifest(adapterManifestEvidence.value);
  const adapterIdentity = { relative_path: r4.D3_V2_R4_ADAPTER_MANIFEST_RELATIVE, raw_sha256: sha256Hex(adapterManifestEvidence.raw), manifest_hash: adapter.manifest_hash, graph_hash: adapter.graph.graph_hash };
  if (canonicalizeJcs(adapter) !== canonicalizeJcs(adapterManifestEvidence.value)
    || canonicalizeJcs(d.adapter_manifest) !== canonicalizeJcs(adapterIdentity)
    || canonicalizeJcs(preview.adapter_manifest) !== canonicalizeJcs(adapterIdentity)) fail("R4_EVIDENCE_CONTINUE_ADAPTER", "continue live adapter manifest/evidence differs");
  const targetFile = captureTrustedSessionPrefixAttestation({ sessionsRoot: r4.D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT, sessionPath: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH, expectedSessionId: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_ID, prefixBytes: r4.D3_V2_R4_FROZEN_TARGET_PREFIX_BYTES });
  const authFile = captureTrustedSessionPrefixAttestation({ sessionsRoot: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT, sessionPath: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH, expectedSessionId: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID, prefixBytes: r4.D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_BYTES });
  const target = { session_id: r4.D3_V2_R4_PRODUCTION_TARGET_SESSION_ID, sessions_root: r4.D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT, session_file: targetFile };
  const authorization = { session_id: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID, sessions_root: r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT, session_file: authFile };
  if (canonicalizeJcs(target) !== canonicalizeJcs(d.target_session_binding) || canonicalizeJcs(authorization) !== canonicalizeJcs(d.authorization_transcript_binding)) fail("R4_EVIDENCE_CONTINUE_SESSIONS", "continue target/auth session bindings differ");
  const expectedPaths = { control_root: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT, intent: "intents/{operation_id}.json", activation: "activations/{operation_id}.json", receipt: "receipts/{operation_id}.json", operator_audit_path: r4.D3_V2_R4_PRODUCTION_OPERATOR_AUDIT, rollback_target: r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT, old_activation_root: r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT, runtime_audit_path: r4.D3_V2_R4_PRODUCTION_RUNTIME_AUDIT, quarantine_target: r4.D3_V2_R4_PRODUCTION_QUARANTINE_TARGET };
  if (canonicalizeJcs(expectedPaths) !== canonicalizeJcs(d.control_paths)) fail("R4_EVIDENCE_CONTINUE_PATHS", "continue control/rollback paths differ");
  const raw = fs.readFileSync(r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH);
  const currentIdentity = fileIdentity(r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH, raw);
  const isPre = canonicalizeJcs(currentIdentity) === canonicalizeJcs(d.settings.pre_identity);
  let isPost = false;
  try {
    const root = asRecord(parseJsonRejectDuplicateKeys(raw), "continue settings");
    const rule = asRecord(root.ruleInjector, "continue settings ruleInjector");
    isPost = sha256Hex(raw) === d.settings.post_raw_sha256 && canonicalizeJcs(rule[r4.D3_V2_R4_SETTINGS_KEY]) === canonicalizeJcs(d.settings.desired_v2_subtree);
  } catch { isPost = false; }
  if (!isPre && !isPost) fail("R4_EVIDENCE_CONTINUE_SETTINGS", "continue settings is neither exact dossier A nor B");
  const roots = protectedD3V2R4ProductionPaths(repoRoot);
  if (canonicalizeJcs(d.protected_snapshot.roots) !== canonicalizeJcs(roots) || canonicalizeJcs(preview.protected_snapshot.roots) !== canonicalizeJcs(roots)) fail("R4_EVIDENCE_CONTINUE_PROTECTED", "continue protected root inventory differs");
}

function fileIdentity(file: string, raw: Buffer): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || raw.length !== stat.size) fail("R4_EVIDENCE_SETTINGS", "settings file identity is unsafe");
  return identityFromStat(stat, raw);
}

function captureExactRegularIdentity(fileInput: string): Readonly<Record<string, unknown>> {
  const file = path.resolve(fileInput);
  const namedBefore = fs.lstatSync(file);
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) fail("R4_EVIDENCE_TARGET", "target session is not an exact regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const heldBefore = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const heldAfter = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(file);
    const beforeIdentity = identityFromStat(namedBefore, raw);
    const heldBeforeIdentity = identityFromStat(heldBefore, raw);
    const heldAfterIdentity = identityFromStat(heldAfter, raw);
    const afterIdentity = identityFromStat(namedAfter, raw);
    if (raw.length !== heldBefore.size
      || canonicalizeJcs(beforeIdentity) !== canonicalizeJcs(heldBeforeIdentity)
      || canonicalizeJcs(heldBeforeIdentity) !== canonicalizeJcs(heldAfterIdentity)
      || canonicalizeJcs(heldAfterIdentity) !== canonicalizeJcs(afterIdentity)) {
      fail("R4_EVIDENCE_TARGET", "target session identity or complete bytes changed while reading");
    }
    return deepFreeze(afterIdentity);
  } finally { fs.closeSync(fd); }
}

function identityFromStat(stat: fs.Stats, raw: Buffer): Record<string, unknown> {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, raw_sha256: sha256Hex(raw) };
}

function settingsDeepSemanticsOutsideV2Equal(pre: Record<string, any>, postRaw: string): boolean {
  const post = asRecord(parseJsonRejectDuplicateKeys(Buffer.from(postRaw)), "rendered settings post");
  const omitV2 = (input: Record<string, any>): Record<string, unknown> => {
    const copy = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    const rule = copy.ruleInjector;
    if (rule && typeof rule === "object" && !Array.isArray(rule)) delete rule[r4.D3_V2_R4_SETTINGS_KEY];
    return copy;
  };
  return canonicalizeJcs(omitV2(pre)) === canonicalizeJcs(omitV2(post));
}

function exactHeadBlob(repoRoot: string, relative: string, raw: string): boolean {
  const blob = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `HEAD:${relative}`], { encoding: "buffer", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 });
  const ignored = spawnSync("git", ["-C", repoRoot, "check-ignore", "--no-index", "-q", "--", relative], { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } });
  return blob.status === 0 && Buffer.isBuffer(blob.stdout) && blob.stdout.equals(Buffer.from(raw)) && ignored.status !== 0;
}

function liveComparableDossier(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, any>;
  delete copy.dossier_hash;
  copy.protected_snapshot = { roots: copy.protected_snapshot.roots, equal: copy.protected_snapshot.equal };
  return copy;
}

function liveComparablePreview(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, any>;
  delete copy.preview_hash;
  copy.dossier = { relative_path: copy.dossier.relative_path };
  copy.protected_snapshot = { roots: copy.protected_snapshot.roots, equal: copy.protected_snapshot.equal };
  return copy;
}

function validateDossierClosed(value: Record<string, unknown>): void {
  exactKeys(value, ["schema_version", "revision", "predecessor_revision", "canonicalization", "mode", "authorization_status", "executable", "target_session_binding", "authorization_transcript_binding", "d3_identities", "adapter_manifest", "operator_manifest", "predecessor_dossier", "settings", "control_paths", "authorization_contract", "operation_contract", "runtime_gate", "recovery", "rollback_boundary", "source_commit_binding", "preview_stability_policy", "protected_snapshot", "assertions", "status", "dossier_hash"], "R4 dossier");
  if (value.schema_version !== DOSSIER_SCHEMA || value.revision !== r4.D3_V2_R4_REVISION || value.predecessor_revision !== "R3.9" || value.authorization_status !== "NOT_AUTHORIZED" || value.executable !== false || value.status !== "S2_NOT_AUTHORIZED") fail("R4_EVIDENCE_SCHEMA", "dossier identity differs");
  validateSessionBinding(value.target_session_binding, "dossier target_session_binding");
  validateSessionBinding(value.authorization_transcript_binding, "dossier authorization_transcript_binding");
  exactKeys(asRecord(value.adapter_manifest, "dossier adapter_manifest"), ["relative_path", "raw_sha256", "manifest_hash", "graph_hash"], "dossier adapter_manifest");
  exactKeys(asRecord(value.operator_manifest, "dossier operator_manifest"), ["relative_path", "raw_sha256", "manifest_hash", "graph_hash", "source_closure_hash", "file_count"], "dossier operator_manifest");
  exactKeys(asRecord(value.predecessor_dossier, "dossier predecessor"), ["relative_path", "raw_sha256", "self_hash"], "dossier predecessor");
  const settings = asRecord(value.settings, "dossier settings");
  exactKeys(settings, ["path", "allowed_prestate", "pre_identity", "post_raw_sha256", "desired_v2_subtree", "mutation_scope", "parser", "lock", "noncooperative_writer_residual"], "dossier settings");
  normalizeSettingsMutationClosed(asRecord(settings.desired_v2_subtree, "dossier desired settings"), { requireExecutableShape: true });
  exactKeys(asRecord(value.control_paths, "dossier control_paths"), ["control_root", "intent", "activation", "receipt", "operator_audit_path", "rollback_target", "old_activation_root", "runtime_audit_path", "quarantine_target"], "dossier control_paths");
  exactKeys(asRecord(value.authorization_contract, "dossier authorization_contract"), ["initial_phrase_utf8_bytes", "initial_phrase_sha256", "continue_phrase_utf8_bytes", "continue_phrase_sha256", "coordinates_read_only_from_authorization_transcript", "target_prefix_independently_verified", "latest_standalone_role_user_exact_required", "continue_later_coordinate_required"], "dossier authorization_contract");
  exactKeys(asRecord(value.operation_contract, "dossier operation_contract"), ["operation_id", "object_order", "create_only_pending", "execute_existing_target_or_pending", "fresh_continue_exact_pending_recovery_only", "activation_authorized_once_no_flip", "auto_retry"], "dossier operation_contract");
  exactKeys(asRecord(value.runtime_gate, "dossier runtime_gate"), ["required_faces", "target_trusted_jsonl_required", "authorization_trusted_jsonl_required", "pending_temp_result", "mismatch_result"], "dossier runtime_gate");
  const recovery = asRecord(value.recovery, "dossier recovery");
  exactKeys(recovery, ["requires_fresh_continue_authorization", "states", "activation_absent_reconstruction", "pending_recovery"], "dossier recovery");
  exactKeys(asRecord(recovery.activation_absent_reconstruction, "dossier activation_absent_reconstruction"), ["settings", "intent", "activation", "receipt", "closure", "action", "settings_post_or_receipt_present"], "dossier activation_absent_reconstruction");
  exactKeys(asRecord(value.rollback_boundary, "dossier rollback_boundary"), ["invoked", "preauthorized", "state_root_must_equal_activation_rollback_target", "independent_from_control_root"], "dossier rollback_boundary");
  exactKeys(asRecord(value.source_commit_binding, "dossier source_commit_binding"), ["manifest_closure_hash", "package_lock_tracked_at_required_commit", "every_graph_and_critical_file_must_equal_HEAD_blob", "git_optional_locks", "clean_status_is_not_commit_closure", "runtime_commit_binding_required_for_execute_continue"], "dossier source_commit_binding");
  validatePreviewStabilityPolicy(value.preview_stability_policy, "dossier preview_stability_policy");
  exactKeys(asRecord(value.protected_snapshot, "dossier protected_snapshot"), ["roots", "before_hash", "after_hash", "before_row_count", "after_row_count", "equal"], "dossier protected_snapshot");
  validateExecutableAssertions(value.assertions, "dossier assertions");
  const base = { ...value }; delete base.dossier_hash;
  if (value.dossier_hash !== jcsSha256Hex(base)) fail("R4_EVIDENCE_HASH", "dossier hash differs");
}

function validatePreviewClosed(value: Record<string, unknown>): void {
  exactKeys(value, ["schema_version", "revision", "mode", "authorization_status", "executable", "dossier", "operator_manifest_hash", "adapter_manifest", "target_session_binding", "authorization_transcript_binding", "settings_pre_raw_sha256", "settings_post_raw_sha256", "preview_stability_policy", "protected_snapshot", "source_commit_closure_contract", "assertions", "status", "preview_hash"], "R4 preview");
  if (value.schema_version !== PREVIEW_SCHEMA || value.revision !== r4.D3_V2_R4_REVISION || value.authorization_status !== "NOT_AUTHORIZED" || value.executable !== false || value.status !== "S2_NOT_AUTHORIZED") fail("R4_EVIDENCE_SCHEMA", "preview identity differs");
  exactKeys(asRecord(value.dossier, "preview dossier"), ["relative_path", "raw_sha256", "self_hash"], "preview dossier");
  exactKeys(asRecord(value.adapter_manifest, "preview adapter_manifest"), ["relative_path", "raw_sha256", "manifest_hash", "graph_hash"], "preview adapter_manifest");
  validateSessionBinding(value.target_session_binding, "preview target_session_binding");
  validateSessionBinding(value.authorization_transcript_binding, "preview authorization_transcript_binding");
  validatePreviewStabilityPolicy(value.preview_stability_policy, "preview preview_stability_policy");
  exactKeys(asRecord(value.protected_snapshot, "preview protected_snapshot"), ["roots", "before_hash", "after_hash", "equal"], "preview protected_snapshot");
  exactKeys(asRecord(value.source_commit_closure_contract, "preview source_commit_closure_contract"), ["graph_and_critical_files", "evidence_files", "git_optional_locks", "enforcement"], "preview source_commit_closure_contract");
  validateExecutableAssertions(value.assertions, "preview assertions");
  const base = { ...value }; delete base.preview_hash;
  if (value.preview_hash !== jcsSha256Hex(base)) fail("R4_EVIDENCE_HASH", "preview hash differs");
}

function validatePreviewStabilityPolicy(value: unknown, label: string): void {
  const policy = asRecord(value, label);
  exactKeys(policy, ["generic_snapshot", "target_session", "authorization_session", "operator_zero_write"], label);
  if (!Object.values(policy).every((item) => typeof item === "string" && item.length > 0)) fail("R4_EVIDENCE_SCHEMA", `${label} entries must be non-empty strings`);
}

function validateExecutableAssertions(value: unknown, label: string): void {
  const assertions = asRecord(value, label);
  if (Object.keys(assertions).length === 0 || !Object.values(assertions).every((item) => item === true)) {
    fail("R4_EVIDENCE_ASSERTION", `${label} contains a false or non-executable assertion`, { assertions });
  }
}

function validateSessionBinding(value: unknown, label: string): void {
  const binding = asRecord(value, label);
  exactKeys(binding, ["session_id", "sessions_root", "session_file"], label);
  const file = asRecord(binding.session_file, `${label}.session_file`);
  exactKeys(file, ["path", "dev", "ino", "session_id", "header_sha256", "prefix_bytes", "prefix_sha256"], `${label}.session_file`);
  if (file.session_id !== binding.session_id) fail("R4_EVIDENCE_SCHEMA", `${label} header session id differs from binding`);
}

function readCanonical(file: string, hashField: string): { raw: string; value: Record<string, any> } {
  const raw = fs.readFileSync(file, "utf8");
  const value = asRecord(parseJsonRejectDuplicateKeys(Buffer.from(raw)), file) as Record<string, any>;
  if (`${canonicalizeJcs(value)}\n` !== raw) fail("R4_EVIDENCE_CANONICAL", `${file} is not exact JCS+LF`);
  const base = { ...value }; delete base[hashField];
  if (value[hashField] !== jcsSha256Hex(base)) fail("R4_EVIDENCE_HASH", `${file} self-hash differs`);
  return { raw, value };
}

function resolveGitMetadataRoot(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } });
  if (result.status !== 0 || !result.stdout.trim()) fail("R4_EVIDENCE_GIT", "cannot resolve git metadata root read-only");
  return path.resolve(result.stdout.trim());
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(compare); const wanted = [...expected].sort(compare); if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("R4_EVIDENCE_SCHEMA", `${label} keys differ`, { actual, expected: wanted }); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("R4_EVIDENCE_SCHEMA", `${label} must be an object`); return value as Record<string, unknown>; }
function optionalRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { const error = new Error(`${code}: ${message}`); Object.assign(error, { code, detail }); throw error; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
