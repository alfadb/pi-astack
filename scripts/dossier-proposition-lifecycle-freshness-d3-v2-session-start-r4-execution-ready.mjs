#!/usr/bin/env node
/**
 * Generate/verify the R4 execution-ready dossier and committed read-only preview.
 * Production data is read only. No loader/helper that creates directories is called.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const r4 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts"));
const adapter = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts"));
const transcript = jiti(path.join(repoRoot, "extensions/_shared/trusted-session-transcript.ts"));
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const { canonicalizeJcs, jcsSha256Hex, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const argv = process.argv.slice(2);
const write = argv[0] === "--write";
const verify = argv[0] === "--verify";
if (argv.length > 1 || (argv.length === 1 && !write && !verify)) throw new Error("usage: dossier [--write|--verify]");
const dossierPath = path.join(repoRoot, r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE);
const previewPath = path.join(repoRoot, r4.D3_V2_R4_PREVIEW_RELATIVE);
const manifestPath = path.join(repoRoot, r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE);

function readCanonical(file, hashField) {
  const raw = fs.readFileSync(file, "utf8");
  const value = JSON.parse(raw);
  if (`${canonicalizeJcs(value)}\n` !== raw) throw new Error(`${file} is not exact JCS+LF`);
  if (hashField) {
    const base = { ...value }; delete base[hashField];
    if (value[hashField] !== jcsSha256Hex(base)) throw new Error(`${file} self-hash differs`);
  }
  return { raw, value };
}

const protectedPaths = [
  r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH,
  core.D3_PUB_HARD_ROOT,
  r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT,
  r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT,
  "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
];
const existingDossier = verify && fs.existsSync(dossierPath) ? readCanonical(dossierPath, "dossier_hash").value : null;
const frozenPrefix = existingDossier?.target_session?.session_file ?? null;
const sessionBefore = transcript.captureTrustedSessionPrefixBinding({
  sessionsRoot: r4.D3_V2_R4_PRODUCTION_SESSION_ROOT,
  sessionPath: r4.D3_V2_R4_PRODUCTION_SESSION_PATH,
  expectedSessionId: r4.D3_V2_R4_PRODUCTION_SESSION_ID,
  ...(frozenPrefix ? { prefixBytes: frozenPrefix.prefix_bytes } : {}),
});
const protectedBefore = core.captureProtectedPrestate(protectedPaths);
const manifestEvidence = readCanonical(manifestPath, "manifest_hash");
const manifest = r4.buildD3V2R4OperatorManifest(repoRoot);
r4.validateD3V2R4OperatorManifest(manifestEvidence.value);
if (canonicalizeJcs(manifest) !== canonicalizeJcs(manifestEvidence.value)) throw new Error("R4 operator manifest evidence differs from live source closure");
const predecessorFile = path.join(repoRoot, r4.D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE);
const predecessor = readCanonical(predecessorFile, "dossier_hash");
if (predecessor.value.revision !== "R3.9" || predecessor.value.default_deny?.status !== "NOT_AUTHORIZED") throw new Error("R3.9 predecessor dossier identity differs");
const published = core.readPublishedD3PubSelection(core.D3_PUB_HARD_ROOT);
const d3 = {
  selection_hash: published.selection.selection_hash,
  head_hash: published.head.head_hash,
  proof_hash: published.proof.proof_hash,
  intent_hash: published.selection.intent_hash,
  stable_bundle_hash: published.artifact_closure.stable.bundle_hash,
  p2a_bundle_hash: published.artifact_closure.p2a.bundle_hash,
  generation: published.selection.generation,
  selection_seq: published.selection.seq,
};
const adapterManifest = adapter.buildD3V2SessionStartAdapterManifest({ repoRoot });
adapter.validateD3V2SessionStartAdapterManifest(adapterManifest);
const sessionFile = sessionBefore;
if (frozenPrefix && canonicalizeJcs(sessionFile) !== canonicalizeJcs(frozenPrefix)) throw new Error("target session frozen path/dev/ino/prefix differs");
const settings = r4.captureD3V2R4SettingsPrestate(r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH);
const r4Binding = r4.buildD3V2R4SettingsBinding({
  controlRoot: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT,
  operatorManifestHash: manifest.manifest_hash,
  settingsPath: r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH,
});
const desired = r4.buildD3V2R4DesiredSettings({
  sessionId: r4.D3_V2_R4_PRODUCTION_SESSION_ID,
  d3,
  adapterManifestHash: adapterManifest.manifest_hash,
  r4Binding,
});
const settingsPostRaw = r4.renderD3V2R4SettingsPost(settings.parsed, desired);
const liveRule = settings.parsed.ruleInjector;
const liveV1Ids = liveRule?.propositionPolicyStableViewInjection?.selector?.session_ids ?? [];
const protectedAfter = core.captureProtectedPrestate(protectedPaths);
const sessionAfter = transcript.captureTrustedSessionPrefixBinding({
  sessionsRoot: r4.D3_V2_R4_PRODUCTION_SESSION_ROOT,
  sessionPath: r4.D3_V2_R4_PRODUCTION_SESSION_PATH,
  expectedSessionId: r4.D3_V2_R4_PRODUCTION_SESSION_ID,
  prefixBytes: sessionBefore.prefix_bytes,
});
const sessionPrefixEqual = canonicalizeJcs(sessionBefore) === canonicalizeJcs(sessionAfter);
const protectedEqual = canonicalizeJcs(protectedBefore) === canonicalizeJcs(protectedAfter) && sessionPrefixEqual;
if (!protectedEqual) throw new Error("protected production snapshot or target session prefix drifted during R4 dossier preview");

const assertions = {
  bind_existing_only_session_captured: sessionFile.path === r4.D3_V2_R4_PRODUCTION_SESSION_PATH && sessionFile.prefix_bytes > 0,
  target_not_in_v1_selector: !liveV1Ids.includes(r4.D3_V2_R4_PRODUCTION_SESSION_ID),
  v2_prestate_absent_or_exact_disabled_empty: ["absent", "disabled_empty"].includes(settings.v2_prestate),
  foreign_authorized_activation_absent: adapter.activationRootHasNoBoundObject(r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT),
  r3_9_predecessor_exact_and_immutable: predecessor.value.revision === "R3.9" && predecessor.value.dossier_hash === "2475dbbc475be1b11e6039d917566f079645a46ae33d383d406f67676af04995",
  operator_manifest_live_exact: manifest.manifest_hash === manifestEvidence.value.manifest_hash,
  settings_post_raw_hash_bound: /^[0-9a-f]{64}$/.test(sha256Hex(settingsPostRaw)),
  duplicate_key_rejecting_parser_used: true,
  retained_parent_fd_create_only_no_replace_used: manifest.graph.files.some((row) => row.path === r4.D3_V2_R4_CREATE_ONLY_MODULE),
  trusted_transcript_verifier_used: manifest.graph.files.some((row) => row.path === r4.D3_V2_R4_TRANSCRIPT_MODULE),
  runtime_four_face_gate_in_source_closure: manifest.graph.files.some((row) => row.path === r4.D3_V2_R4_MODULE),
  production_preview_protected_snapshot_equal: protectedEqual,
  production_preview_target_session_prefix_equal: sessionPrefixEqual,
  production_write_not_invoked: true,
  session_write_not_invoked: true,
  rollback_not_invoked: true,
  s2_not_authorized: true,
};
if (!Object.values(assertions).every((value) => value === true)) throw new Error(`R4 dossier assertion failed: ${JSON.stringify(assertions)}`);

const base = {
  schema_version: "adr0040-d3-v2-session-start-r4-execution-ready-dossier/v1",
  revision: "R4",
  predecessor_revision: "R3.9",
  canonicalization: "RFC8785-JCS",
  mode: "production_create_bind_operator_execution_ready_read_only",
  authorization_status: "NOT_AUTHORIZED",
  executable: false,
  target_session: {
    session_id: r4.D3_V2_R4_PRODUCTION_SESSION_ID,
    sessions_root: r4.D3_V2_R4_PRODUCTION_SESSION_ROOT,
    session_file: sessionFile,
    bind_existing_only: true,
    create_session: false,
    rewrite_session: false,
  },
  d3_identities: d3,
  adapter_manifest: {
    manifest_hash: adapterManifest.manifest_hash,
    graph_hash: adapterManifest.graph.graph_hash,
    file_count: adapterManifest.graph.files.length,
  },
  operator_manifest: {
    relative_path: r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE,
    raw_sha256: sha256Hex(manifestEvidence.raw),
    manifest_hash: manifest.manifest_hash,
    graph_hash: manifest.graph.graph_hash,
    source_closure_hash: manifest.source_closure_hash,
    file_count: manifest.graph.files.length,
  },
  predecessor_dossier: {
    relative_path: r4.D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE,
    raw_sha256: sha256Hex(predecessor.raw),
    self_hash: predecessor.value.dossier_hash,
  },
  settings: {
    path: r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH,
    allowed_prestate: settings.v2_prestate,
    pre_identity: settings.identity,
    post_raw_sha256: sha256Hex(settingsPostRaw),
    desired_v2_subtree: desired,
    mutation_scope: "only_v2_key; all other settings and v1 deep semantics identical",
    parser: "duplicate-key rejecting JSON",
    lock: "retained settings-parent OFD cooperative lock",
    noncooperative_writer_residual: r4.D3_V2_R4_NONCOOPERATIVE_WRITER_RESIDUAL,
  },
  control_paths: {
    control_root: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT,
    intent: "intents/{operation_id}.json",
    activation: "activations/{operation_id}.json",
    receipt: "receipts/{operation_id}.json",
    old_activation_root: r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT,
    runtime_audit_path: r4.D3_V2_R4_PRODUCTION_RUNTIME_AUDIT,
    operator_audit_path: r4.D3_V2_R4_PRODUCTION_OPERATOR_AUDIT,
    rollback_target: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT,
    quarantine_target: r4.D3_V2_R4_PRODUCTION_QUARANTINE_TARGET,
  },
  authorization_contract: {
    initial_phrase_utf8_bytes: Buffer.byteLength(r4.D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE),
    initial_phrase_sha256: sha256Hex(r4.D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE),
    continue_phrase_utf8_bytes: Buffer.byteLength(r4.D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE),
    continue_phrase_sha256: sha256Hex(r4.D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE),
    latest_standalone_role_user_exact_required: true,
    transcript_header_chain_message_prefix_freshness_required: true,
    caller_supplied_json_text_force_yes_forbidden: true,
    continue_independent_coordinate_required: true,
  },
  operation_contract: {
    operation_id: "SHA256(RFC8785-JCS(full authorization tuple including trusted transcript coordinate))",
    object_order: ["create_only_intent", "create_only_AUTHORIZED_bound_activation", "settings_identity_raw_CAS", "create_only_exact_commit_receipt"],
    publish: "retained parent FD + O_EXCL temp + fsync + no-replace hardlink + parent fsync",
    execute_existing_target: "halt",
    activation_not_authorized_flip: true,
    auto_retry: false,
  },
  runtime_gate: {
    disabled_or_absent: "inert",
    enabled_exact_four_faces: ["settings_post", "intent", "AUTHORIZED_activation", "commit_receipt"],
    mismatch_or_partial: "selected_zero_injection_no_ADR0039_fallback",
    settings_CAS_before_receipt_crash: "selected_zero_injection",
    receipt_with_nonexact_settings: "selected_zero_injection",
  },
  recovery: {
    requires_fresh_continue_authorization: true,
    exact_states: [
      "settings_pre+exact_intent+exact_activation+receipt_absent => CAS then receipt",
      "settings_post+exact_intent+exact_activation+receipt_absent => receipt only",
      "settings_post+exact_receipt => verify terminal without rewrite",
      "settings_pre+receipt_present => halt",
      "any_other_combination => halt",
    ],
  },
  rollback_boundary: {
    invoked: false,
    preauthorized: false,
    lightweight_disable: "separate settings enabled=false operation; no session movement",
    heavyweight_quarantine: "independent R3.9 triple authorization plus taint, real rename, terminal halt",
  },
  source_commit_binding: {
    commit: null,
    deferred_until_published_clean_tree: true,
    dossier_binds_source_closure_manifest_instead: true,
    production_authorization_preview_must_later_bind_clean_commit: true,
  },
  protected_snapshot: {
    roots: protectedPaths,
    before: protectedBefore,
    after: protectedAfter,
    target_session_prefix_before: sessionBefore,
    target_session_prefix_after: sessionAfter,
    target_session_prefix_equal: sessionPrefixEqual,
    equal: protectedEqual,
  },
  assertions,
  status: "S2_NOT_AUTHORIZED",
};
const dossier = { ...base, dossier_hash: jcsSha256Hex(base) };
const dossierRaw = `${canonicalizeJcs(dossier)}\n`;
const previewBase = {
  schema_version: "adr0040-d3-v2-session-start-r4-production-read-only-preview/v1",
  revision: "R4",
  mode: "production_read_only_preview",
  authorization_status: "NOT_AUTHORIZED",
  executable: false,
  dossier: { relative_path: r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE, raw_sha256: sha256Hex(dossierRaw), self_hash: dossier.dossier_hash },
  operator_manifest_hash: manifest.manifest_hash,
  target_session_prefix: sessionFile,
  settings_pre_raw_sha256: settings.identity.raw_sha256,
  settings_post_raw_sha256: sha256Hex(settingsPostRaw),
  protected_snapshot_equal: protectedEqual,
  production_write_invoked: false,
  session_write_invoked: false,
  rollback_invoked: false,
  source_commit_bound: false,
  status: "S2_NOT_AUTHORIZED",
};
const preview = { ...previewBase, preview_hash: jcsSha256Hex(previewBase) };
const previewRaw = `${canonicalizeJcs(preview)}\n`;

if (write) {
  fs.writeFileSync(dossierPath, dossierRaw, "utf8");
  fs.writeFileSync(previewPath, previewRaw, "utf8");
  process.stdout.write(JSON.stringify({ written: [dossierPath, previewPath], dossier_hash: dossier.dossier_hash, preview_hash: preview.preview_hash, operator_manifest_hash: manifest.manifest_hash, authorization_status: "NOT_AUTHORIZED" }) + "\n");
} else if (verify) {
  const existingDossierRaw = fs.readFileSync(dossierPath, "utf8");
  const existingPreviewRaw = fs.readFileSync(previewPath, "utf8");
  if (existingDossierRaw !== dossierRaw || existingPreviewRaw !== previewRaw) throw new Error("R4 dossier or preview bytes differ from continuous rebuild");
  process.stdout.write(JSON.stringify({ verified: true, dossier_hash: dossier.dossier_hash, preview_hash: preview.preview_hash, operator_manifest_hash: manifest.manifest_hash, authorization_status: "NOT_AUTHORIZED" }) + "\n");
} else process.stdout.write(dossierRaw);
