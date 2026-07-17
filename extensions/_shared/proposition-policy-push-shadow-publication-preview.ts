import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import {
  expectedL1EventPath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1WritePreflight,
} from "./l1-schema-registry";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  publicationEvidencePackRelative,
  publicationIntentRelative,
  publicationPlannedDiffRelative,
  publicationReviewRelativePaths,
} from "./proposition-policy-push-publication-evidence";
import {
  PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID,
  PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS,
  PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
  buildPropositionPolicyPushShadow,
  validatePropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";
import {
  PROPOSITION_POLICY_PUSH_PUBLICATION_CLI,
  PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME,
  PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET,
  PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
  capturePublicationWholeSnapshot,
  diffPublicationInventory,
  previewProductionPublicationTarget,
} from "./proposition-policy-push-shadow-publication";
import {
  buildTypescriptStaticDependencyGraph,
  extractJitiRepoModules,
  validateTypescriptStaticDependencyGraph,
  type TypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";

export const PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_SCHEMA = "proposition-policy-push-publication-contract-dossier/v4" as const;
export const PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v4.json" as const;
export const PROPOSITION_POLICY_PUSH_P2A21_PREVIEW_CLI = "scripts/dossier-proposition-policy-push-publication-preview.mjs" as const;
export const P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256 = "d080b5c01c980a5633d9ee251bd21c251e47b4fcf71fd82dd1fc4c995d7a1d6d" as const;

const DOSSIER_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HISTORICAL_DOSSIERS = Object.freeze([
  {
    generation: "v1",
    schema_version: "proposition-policy-push-shadow-dossier/v1",
    relative_path: "docs/evidence/2026-07-13-adr0040-p2a1-production-preview-dossier.json",
    dossier_hash: "2747e57f0488e58a39f1e77001169edf0a91b7bd4ff645c0ae10287dda398172",
    raw_sha256: "7424e208df28851d54a5f429a7e361d2a29db301bc5139e0f1dfaf195bdb1911",
  },
  {
    generation: "v2",
    schema_version: "proposition-policy-push-shadow-dossier/v2",
    relative_path: "docs/evidence/2026-07-13-adr0040-p2a1-production-preview-dossier-v2.json",
    dossier_hash: "56ac3e422d58fe6c00ff1f7c2554e898261b2ff7b37614ad81cdd4d2ac813ee4",
    raw_sha256: "8c6223f98ad676773537570f6cfe9e07d4559a14bfb1d45ceca3bf71fa690d62",
  },
  {
    generation: "p2a1-v3",
    schema_version: "proposition-policy-push-shadow-dossier/v3",
    relative_path: "docs/evidence/2026-07-14-adr0040-p2a1-production-preview-dossier-v3.json",
    dossier_hash: "188c7948df5f6b4d60291f9f736895fcb0935bc6f72dc088f48370219e353ee6",
    raw_sha256: "191a763cef7c13a122ab4743f04f11369c2ac427057c51b7940d506f2abf4292",
  },
  {
    generation: "p2a21-v1-historical",
    schema_version: "proposition-policy-push-publication-contract-dossier/v1",
    relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier.json",
    dossier_hash: "9bb992493a30883a1bdcd2ea0631b90354dcc8c274b77a0bbd17ab821d7c7716",
    raw_sha256: "810ff59ae174e52bc5a49f6e7e9c508965956122e7746b99f30f8a468c051554",
  },
  {
    generation: "p2a21-v2-historical",
    schema_version: "proposition-policy-push-publication-contract-dossier/v2",
    relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v2.json",
    dossier_hash: "94b2abbc707b117a239ae9e60086ea0bc78a97565b637f4abedb450b20643268",
    raw_sha256: "b4b3b96d4f20b3617a4ae8a0de090e16e9de6dfbf32a34fe6238f711c0acb029",
  },
  {
    generation: "p2a21-v3-historical",
    schema_version: "proposition-policy-push-publication-contract-dossier/v3",
    relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v3.json",
    dossier_hash: "a87dbcecc48e6330608d562de5f29c9d168fbe7c36cdab1362970119664bf0f5",
    raw_sha256: "fe4bc1df10ffbc572a3eb269dca05b6f51c9961b957fffa2ce45ffee4e555de4",
  },
] as const);
const RUNTIME_FORBIDDEN_MODULES = Object.freeze([
  "extensions/_shared/proposition-policy-push-shadow-publication-preview.ts",
  "extensions/_shared/proposition-policy-push-shadow-publication.ts",
  "extensions/_shared/proposition-policy-push-shadow-preview.ts",
  "extensions/_shared/proposition-policy-push-shadow.ts",
] as const);
const SOURCE_ENTRYPOINTS = Object.freeze({
  publisher: "scripts/publish-proposition-policy-push-shadow.mjs",
  dossier: "scripts/dossier-proposition-policy-push-publication-preview.mjs",
  planned_diff: "scripts/generate-proposition-policy-push-planned-diff.mjs",
  smoke: "scripts/smoke-proposition-policy-push-publication-p2a21.mjs",
} as const);
const SOURCE_SCRIPT_COMMANDS = Object.freeze({
  "publish:proposition-policy-push-shadow": "node scripts/publish-proposition-policy-push-shadow.mjs --abrain /home/worker/.abrain",
  "dossier:proposition-policy-push-publication-preview": "node scripts/dossier-proposition-policy-push-publication-preview.mjs --abrain /home/worker/.abrain",
  "generate:proposition-policy-push-planned-diff": "node scripts/generate-proposition-policy-push-planned-diff.mjs",
  "smoke:proposition-policy-push-publication-p2a21": "node scripts/smoke-proposition-policy-push-publication-p2a21.mjs",
} as const);
const AUTHORITATIVE_SOURCE_CLOSURE_SCHEMA = "proposition-policy-push-authoritative-source-closure/v1" as const;

export interface PropositionPolicyPushP2a21Dossier {
  schema_version: typeof PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  dossier_hash_scope: typeof DOSSIER_HASH_SCOPE;
  mode: "real_production_read_only_publication_preview";
  authorization: Readonly<Record<string, unknown>>;
  preserved_history: readonly Readonly<Record<string, unknown>>[];
  production_source: Readonly<Record<string, unknown>>;
  semantic_bundle: Readonly<Record<string, unknown>>;
  publication_contract: Readonly<Record<string, unknown>>;
  target_observation: Readonly<Record<string, unknown>>;
  mutation_proof: Readonly<Record<string, unknown>>;
  runtime_isolation: Readonly<Record<string, unknown>>;
  authoritative_source_closure: Readonly<Record<string, unknown>>;
  assertions: Readonly<Record<string, boolean>>;
  dossier_hash: string;
}

export class PropositionPolicyPushP2a21PreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushP2a21PreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionPolicyPushP2a21ProductionPreview(options: {
  abrainHome: string;
  repoRoot: string;
  outputPath: string;
  registryPath?: string;
}): Promise<PropositionPolicyPushP2a21Dossier> {
  const repoRoot = path.resolve(options.repoRoot);
  const outputPath = await assertOutputPath(options.outputPath, repoRoot);
  const abrainHome = path.resolve(options.abrainHome);
  if (abrainHome !== PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME) throw failure("PROPOSITION_POLICY_PUSH_REAL_ABRAIN_REQUIRED", "preview is hard-limited to /home/worker/.abrain");
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas", "l1-schema-role-registry.json"));
  await validateHistoricalDossierBytes(repoRoot);

  const before = await capturePublicationWholeSnapshot(abrainHome);
  const targetBefore = await previewProductionPublicationTarget({ abrainHome });
  const bundle = await buildPropositionPolicyPushShadow({ abrainHome, repoRoot, registryPath });
  validatePropositionPolicyPushBundle(bundle);
  assertDeploymentNeutralManifest(bundle.manifest);
  const registry = loadL1SchemaRegistry(registryPath);
  const scan = await scanWholeL1Validated({ abrainHome, registry });
  const propositionRecords = scan.all.filter((record) => record.registration.domain === "proposition");
  const sourceRecord = propositionRecords.find((record) => record.eventId === PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID);
  if (!sourceRecord) throw failure("PROPOSITION_POLICY_PUSH_PRODUCTION_SOURCE", "fixed production evidence is missing");
  const genericGate = await genericWriteGateCode({ abrainHome, registry, record: sourceRecord });
  const runtimeIsolation = await captureP2a21RuntimeIsolation(repoRoot);
  const authoritativeSourceClosure = await captureAuthoritativeSourceClosure(repoRoot);
  const targetAfter = await previewProductionPublicationTarget({ abrainHome });
  const after = await capturePublicationWholeSnapshot(abrainHome);
  const exactDiff = diffPublicationInventory(before.rows, after.rows);
  const wholeUnchanged = before.summary.snapshot_hash === after.summary.snapshot_hash
    && exactDiff.created.length === 0
    && exactDiff.modified.length === 0
    && exactDiff.removed.length === 0;
  if (!wholeUnchanged) throw failure("PROPOSITION_POLICY_PUSH_ABRAIN_MUTATION", "whole production abrain changed during read-only preview", { before: before.summary.snapshot_hash, after: after.summary.snapshot_hash, exactDiff });

  const exclusion = bundle.exclusions.exclusions[0];
  const diagnostic = bundle.diagnostics.diagnostics[0];
  const exactResult = bundle.entries.entries.length === 0
    && bundle.exclusions.exclusions.length === 1
    && bundle.diagnostics.diagnostics.length === 1
    && exclusion?.source_event_id === PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID
    && exclusion.reason_code === "consumer_hints_policy_false"
    && diagnostic?.source_event_id === exclusion.source_event_id
    && diagnostic.reason_code === exclusion.reason_code;
  const exactSource = propositionRecords.length === 2
    && bundle.manifest.source.proposition_genesis_count === 1
    && bundle.manifest.source.proposition_evidence_count === 1
    && bundle.manifest.source.proposition_lifecycle_count === 0
    && bundle.manifest.source.proposition_selected_count === 0
    && bundle.manifest.source.proposition_foldable_count === 0;
  const assertions = deepFreeze({
    production_target_absent_before: targetBefore.state === "absent",
    production_target_absent_after: targetAfter.state === "absent",
    whole_real_abrain_byte_identical_no_carve_out: wholeUnchanged,
    no_abrain_entry_created: exactDiff.created.length === 0,
    no_abrain_entry_modified: exactDiff.modified.length === 0,
    no_abrain_entry_removed: exactDiff.removed.length === 0,
    manifest_schema_is_deployment_neutral_v2: bundle.manifest.schema_version === PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
    semantic_manifest_has_no_published_to_abrain: !canonicalizeJcs(bundle.manifest).includes("published_to_abrain"),
    semantic_manifest_has_no_placement_or_path_keys: manifestDeploymentKeys(bundle.manifest).length === 0,
    shadow_push_only_no_runtime_consumer: bundle.manifest.authority === "shadow_push_only_no_runtime_consumer",
    runtime_consumer_false: bundle.manifest.candidate_contract.runtime_consumer === false,
    relevance_only_no_injection_verdict: bundle.manifest.candidate_contract.semantics === "relevance_only_no_injection_verdict",
    exact_production_zero_entries_one_exclusion_one_diagnostic: exactResult,
    exact_production_genesis_plus_one_evidence: exactSource,
    generic_write_gate_disabled: genericGate === "L1_SCHEMA_WRITE_DISABLED",
    projection_envelope_phase_disabled: bundle.manifest.projection_envelope_contract.phase === "phase_disabled",
    historical_p2a1_v1_v2_v3_and_p2a21_v1_v2_v3_bytes_preserved: true,
    runtime_graph_covers_all_25_extension_roots: runtimeIsolation.dependency_graph.roots.length === 25,
    runtime_graph_has_no_forbidden_module: runtimeIsolation.violations.length === 0,
    runtime_graph_has_no_unresolved_dynamic_loader: runtimeIsolation.dependency_graph.unresolved_dynamic_loaders.length === 0,
    package_extension_list_matches_frozen_p1b_hash: runtimeIsolation.package_pi_extensions_hash === P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256,
    authoritative_source_closure_hash_valid: sourceClosureHashValid(authoritativeSourceClosure),
    publisher_jiti_modules_exactly_equal_publisher_ts_graph_roots: true,
    planned_diff_jiti_modules_exactly_equal_planned_diff_ts_graph_roots: true,
    package_script_commands_exact: true,
    actual_publication_not_authorized: true,
    no_force_or_environment_bypass: true,
  });
  if (Object.values(assertions).some((value) => value !== true)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_ASSERTION", "P2a.2.1 preview assertion failed", { assertions });

  const dossierBase = {
    schema_version: PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    dossier_hash_scope: DOSSIER_HASH_SCOPE,
    mode: "real_production_read_only_publication_preview" as const,
    authorization: {
      phase: "ADR0040-P2a.2.1",
      status: "completed_authorized_repo_contract_and_read_only_preview_only",
      authorization_basis: "explicit_user_scope_for_ancestor_recovery_fix_and_read_only_v4_preview",
      actual_publication_status: "blocked_not_authorized",
      next_required_gate: "six_durable_review_artifacts_on_current_planned_diff_plus_trusted_user_attestation_and_exact_role_user_authorization",
      p2a22_actual_publication: "blocked_separate_authorization_required",
      p2b_stable_view: "blocked_separate_authorization_required",
      p3_runtime_read_flip: "blocked_separate_authorization_required",
      p4_legacy_retirement: "blocked_separate_authorization_required",
    },
    preserved_history: HISTORICAL_DOSSIERS,
    production_source: {
      abrain_home: abrainHome,
      input_event_ids: bundle.manifest.source.input_event_ids,
      input_event_ids_hash: bundle.manifest.source.input_event_ids_hash,
      production_event_id: PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID,
      proposition_event_count: bundle.manifest.source.proposition_event_count,
      proposition_genesis_count: bundle.manifest.source.proposition_genesis_count,
      proposition_evidence_count: bundle.manifest.source.proposition_evidence_count,
      proposition_lifecycle_count: bundle.manifest.source.proposition_lifecycle_count,
      proposition_selected_count: bundle.manifest.source.proposition_selected_count,
      proposition_foldable_count: bundle.manifest.source.proposition_foldable_count,
      generic_write_gate: genericGate,
    },
    semantic_bundle: {
      manifest_schema_version: bundle.manifest.schema_version,
      deployment_neutral: true,
      forbidden_deployment_keys: ["published_to_abrain", "placement", "*path", "*paths"],
      authority: bundle.manifest.authority,
      runtime_consumer: bundle.manifest.candidate_contract.runtime_consumer,
      semantics: bundle.manifest.candidate_contract.semantics,
      bundle_hash: bundle.manifest.bundle_hash,
      manifest_sha256: sha256Hex(bundle.bytes["manifest.json"]),
      artifact_rows: ["diagnostics.json", "entries.json", "exclusions.json"].map((name) => bundle.manifest.artifacts.find((row) => row.name === name)),
      entry_count: bundle.manifest.result.entry_count,
      exclusion_count: bundle.manifest.result.exclusion_count,
      diagnostic_count: bundle.manifest.result.diagnostic_count,
      production_exclusion: {
        source_event_id: exclusion!.source_event_id,
        filter_stage: exclusion!.filter_stage,
        reason_code: exclusion!.reason_code,
        record_hash: exclusion!.record_hash,
      },
      production_diagnostic: {
        source_event_id: diagnostic!.source_event_id,
        filter_stage: diagnostic!.filter_stage,
        reason_code: diagnostic!.reason_code,
        record_hash: diagnostic!.record_hash,
      },
    },
    publication_contract: {
      hard_abrain_home: PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME,
      hard_target_root: PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET,
      target_relative_name: PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
      bundle_relative_name: `bundles/${bundle.manifest.bundle_hash}`,
      latest_relative_symlink_value: `bundles/${bundle.manifest.bundle_hash}`,
      publisher_cli: PROPOSITION_POLICY_PUSH_PUBLICATION_CLI,
      planned_diff_generator_cli: SOURCE_ENTRYPOINTS.planned_diff,
      evidence_pack_relative_path: publicationEvidencePackRelative(bundle.manifest.bundle_hash),
      planned_diff_artifact_relative_path: publicationPlannedDiffRelative(bundle.manifest.bundle_hash),
      review_artifact_relative_paths_fixed_vendor_order: publicationReviewRelativePaths(bundle.manifest.bundle_hash),
      publication_intent_relative_path: publicationIntentRelative(bundle.manifest.bundle_hash),
      planned_diff_policy: "deterministic_current_content_bound_bundle_hard_target_absent_prestate_exact_final_inventory_and_protected_prestate",
      review_artifact_policy: "lstat_realpath_read_raw_sha256_canonical_metadata_fixed_vendor_order_common_current_diff_hash_plus_trusted_user_attestation_not_cryptographic_vendor_provenance",
      bundle_policy: "immutable_content_addressed_deterministic_no_replace_files_absent_or_exact_identical",
      latest_policy: "relative_symlink_no_replace_absent_or_exact_identical",
      intent_policy: "self_hashed_evidence_paths_raw_hashes_review_record_and_transcript_authorization_bound_before_any_abrain_mutation",
      recovery_states: ["absent", "staging_partial", "bundle_ready", "complete"],
      ancestor_only_recovery_policy: "evidence_reconstructs_exact_absent_prestate_only_after_exact_planned_created_ancestor_rows_are_removed_foreign_path_content_or_symlink_fails_closed",
      coordination_policy: "lock_free_convergent_deterministic_no_replace_writes_no_anonymous_or_persistent_lock_residue",
      collision_policy: "exact_identical_is_idempotent_otherwise_fail_closed",
      mutation_policy: "whole_abrain_before_after_exact_whitelist_plus_protected_outside_target_equality",
      authorization_policy: "not_authorized_by_default_no_force_no_environment_bypass_test_crash_hooks_only_on_sandbox_test_api",
      sandbox_tested_only: true,
      production_executed: false,
    },
    target_observation: {
      before: targetBefore,
      after: targetAfter,
      expected_state: "absent",
      target_created: false,
    },
    mutation_proof: {
      scope: "whole_real_abrain_before_after_no_carve_out",
      before: before.summary,
      after: after.summary,
      unchanged: wholeUnchanged,
      exact_diff: exactDiff,
      repo_evidence_output_path: outputPath,
      repo_evidence_write_sequence: "after_final_real_abrain_after_snapshot",
    },
    runtime_isolation: runtimeIsolation,
    authoritative_source_closure: authoritativeSourceClosure,
    assertions,
  };
  const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) }) as PropositionPolicyPushP2a21Dossier;
  validatePropositionPolicyPushP2a21Dossier(dossier);
  return dossier;
}

export async function writePropositionPolicyPushP2a21ProductionPreview(options: {
  abrainHome: string;
  repoRoot: string;
  outputPath: string;
  registryPath?: string;
}): Promise<{ dossier: PropositionPolicyPushP2a21Dossier; status: DurableCreateStatus; raw_sha256: string }> {
  const dossier = await buildPropositionPolicyPushP2a21ProductionPreview(options);
  const raw = `${canonicalizeJcs(dossier)}\n`;
  const status = await durableAtomicCreateFile(path.resolve(options.outputPath), raw, { mode: 0o644 });
  if (status === "collision") throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_COLLISION", "dossier path exists with different bytes");
  if (await fs.readFile(path.resolve(options.outputPath), "utf-8") !== raw) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_READBACK", "dossier readback mismatch");
  return deepFreeze({ dossier, status, raw_sha256: sha256Hex(raw) });
}

export function validatePropositionPolicyPushP2a21Dossier(dossier: PropositionPolicyPushP2a21Dossier): void {
  exactKeys(asRecord(dossier), ["schema_version", "canonicalization", "hash_algorithm", "dossier_hash_scope", "mode", "authorization", "preserved_history", "production_source", "semantic_bundle", "publication_contract", "target_observation", "mutation_proof", "runtime_isolation", "authoritative_source_closure", "assertions", "dossier_hash"], "dossier");
  if (dossier.schema_version !== PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_SCHEMA
    || dossier.canonicalization !== "RFC8785-JCS"
    || dossier.hash_algorithm !== "sha256"
    || dossier.dossier_hash_scope !== DOSSIER_HASH_SCOPE
    || dossier.mode !== "real_production_read_only_publication_preview") throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "dossier identity drifted");
  const base = { ...dossier } as Record<string, unknown>;
  delete base.dossier_hash;
  assertSha256(dossier.dossier_hash, "dossier.dossier_hash");
  if (jcsSha256Hex(base) !== dossier.dossier_hash) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "dossier self-hash mismatch");
  if (canonicalizeJcs(dossier.preserved_history) !== canonicalizeJcs(HISTORICAL_DOSSIERS)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "historical dossier bindings drifted");
  const authorization = asRecord(dossier.authorization);
  if (authorization.phase !== "ADR0040-P2a.2.1"
    || authorization.status !== "completed_authorized_repo_contract_and_read_only_preview_only"
    || authorization.actual_publication_status !== "blocked_not_authorized"
    || authorization.next_required_gate !== "six_durable_review_artifacts_on_current_planned_diff_plus_trusted_user_attestation_and_exact_role_user_authorization") throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "authorization boundary drifted");
  const target = asRecord(dossier.target_observation);
  const beforeTarget = asRecord(target.before);
  const afterTarget = asRecord(target.after);
  if (beforeTarget.target_root !== PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET
    || afterTarget.target_root !== PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET
    || beforeTarget.state !== "absent"
    || afterTarget.state !== "absent"
    || target.target_created !== false) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "production target absence proof failed");
  const mutation = asRecord(dossier.mutation_proof);
  const before = asRecord(mutation.before);
  const after = asRecord(mutation.after);
  const diff = asRecord(mutation.exact_diff);
  if (mutation.scope !== "whole_real_abrain_before_after_no_carve_out"
    || mutation.unchanged !== true
    || before.snapshot_hash !== after.snapshot_hash
    || array(diff.created, "mutation.exact_diff.created").length
    || array(diff.modified, "mutation.exact_diff.modified").length
    || array(diff.removed, "mutation.exact_diff.removed").length) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "whole abrain zero-mutation proof failed");
  const semantic = asRecord(dossier.semantic_bundle);
  if (semantic.manifest_schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA
    || semantic.deployment_neutral !== true
    || semantic.authority !== "shadow_push_only_no_runtime_consumer"
    || semantic.runtime_consumer !== false
    || semantic.semantics !== "relevance_only_no_injection_verdict"
    || semantic.entry_count !== 0
    || semantic.exclusion_count !== 1
    || semantic.diagnostic_count !== 1) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "semantic bundle contract drifted");
  for (const key of ["bundle_hash", "manifest_sha256"]) assertSha256(semantic[key], `semantic_bundle.${key}`);
  const runtime = asRecord(dossier.runtime_isolation);
  const violations = array(runtime.violations, "runtime_isolation.violations");
  if (violations.length !== 0
    || runtime.package_pi_extensions_count !== 25
    || runtime.package_pi_extensions_hash !== P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256
    || canonicalizeJcs(runtime.forbidden_module_names) !== canonicalizeJcs(RUNTIME_FORBIDDEN_MODULES)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "runtime isolation drifted");
  validateTypescriptStaticDependencyGraph(runtime.dependency_graph as TypescriptStaticDependencyGraph);
  validateAuthoritativeSourceClosure(dossier.authoritative_source_closure);
  if (Object.values(dossier.assertions).some((value) => value !== true)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "dossier contains a false assertion");
}

async function captureAuthoritativeSourceClosure(repoRoot: string): Promise<Readonly<Record<string, unknown>>> {
  const dynamicJitiModules = deepFreeze({
    publisher: extractJitiRepoModules({ repoRoot, entrypoint: SOURCE_ENTRYPOINTS.publisher, repoRootIdentifiers: ["repoRoot"] }),
    dossier: extractJitiRepoModules({ repoRoot, entrypoint: SOURCE_ENTRYPOINTS.dossier, repoRootIdentifiers: ["repoRoot"] }),
    planned_diff: extractJitiRepoModules({ repoRoot, entrypoint: SOURCE_ENTRYPOINTS.planned_diff, repoRootIdentifiers: ["repoRoot"] }),
    smoke: extractJitiRepoModules({ repoRoot, entrypoint: SOURCE_ENTRYPOINTS.smoke, repoRootIdentifiers: ["sourceRepoRoot"] }),
  });
  const graphs = deepFreeze({
    publisher: buildTypescriptStaticDependencyGraph({ repoRoot, roots: dynamicJitiModules.publisher }),
    dossier: buildTypescriptStaticDependencyGraph({ repoRoot, roots: dynamicJitiModules.dossier }),
    planned_diff: buildTypescriptStaticDependencyGraph({ repoRoot, roots: dynamicJitiModules.planned_diff }),
    smoke: buildTypescriptStaticDependencyGraph({ repoRoot, roots: dynamicJitiModules.smoke }),
  });
  for (const [name, graph] of Object.entries(graphs)) {
    validateTypescriptStaticDependencyGraph(graph);
    if (canonicalizeJcs(graph.roots) !== canonicalizeJcs(dynamicJitiModules[name as keyof typeof dynamicJitiModules])) {
      throw failure("PROPOSITION_POLICY_PUSH_SOURCE_CLOSURE", `${name} dynamic jiti modules do not exactly equal that executable's TS graph roots`);
    }
  }
  const allGraphPaths = new Set(Object.values(graphs).flatMap((graph) => graph.files.map((row) => row.path)));
  for (const required of [
    ...PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS.filter((relative) => relative.endsWith(".ts")),
    "extensions/_shared/proposition-policy-push-publication-evidence.ts",
    "extensions/_shared/proposition-policy-push-shadow-publication.ts",
    "extensions/_shared/proposition-policy-push-shadow-publication-preview.ts",
    "extensions/_shared/proposition-p1b-transcript.ts",
    "extensions/_shared/durable-write.ts",
    "extensions/_shared/typescript-static-dependency-graph.ts",
  ]) if (!allGraphPaths.has(required)) throw failure("PROPOSITION_POLICY_PUSH_SOURCE_CLOSURE", "required TS source/dependency is absent from executable graph union", { required });

  const packageFile = path.join(repoRoot, "package.json");
  const packageRaw = await fs.readFile(packageFile);
  const pkg = JSON.parse(packageRaw.toString("utf-8")) as { scripts?: Record<string, unknown> };
  const scripts = pkg.scripts ?? {};
  for (const [name, command] of Object.entries(SOURCE_SCRIPT_COMMANDS)) {
    if (scripts[name] !== command) throw failure("PROPOSITION_POLICY_PUSH_SOURCE_CLOSURE", "package script command drifted", { name, expected: command, actual: scripts[name] });
  }
  const inventoryPaths = [...new Set([
    ...Object.values(SOURCE_ENTRYPOINTS),
    "package.json",
    ...PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS,
    ...allGraphPaths,
  ])].sort(compareCodeUnits);
  const entrypointSet = new Set<string>(Object.values(SOURCE_ENTRYPOINTS));
  const semanticSourceSet = new Set<string>(PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS);
  const rows = [] as Array<{ path: string; bytes: number; sha256: string; roles: readonly string[] }>;
  for (const relative of inventoryPaths) {
    const file = path.join(repoRoot, ...relative.split("/"));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) throw failure("PROPOSITION_POLICY_PUSH_SOURCE_CLOSURE", "source closure file is unsafe", { relative });
    const bytes = await fs.readFile(file);
    const roles = [
      ...(entrypointSet.has(relative) ? ["executable_entrypoint"] : []),
      ...(relative === "package.json" ? ["package_and_script_registry"] : []),
      ...(semanticSourceSet.has(relative) ? ["semantic_source_artifact"] : []),
      ...(allGraphPaths.has(relative) ? ["typescript_graph_root_or_dependency"] : []),
    ].sort(compareCodeUnits);
    rows.push(deepFreeze({ path: relative, bytes: bytes.length, sha256: sha256Hex(bytes), roles: Object.freeze(roles) }));
  }
  const inventoryBase = {
    scope: "closed_world_four_executables_package_scripts_and_all_reachable_ts_module_bytes" as const,
    executable_entrypoints: SOURCE_ENTRYPOINTS,
    package_json_path: "package.json" as const,
    package_script_commands: SOURCE_SCRIPT_COMMANDS,
    rows: Object.freeze(rows),
  };
  const executableInventory = deepFreeze({ ...inventoryBase, inventory_hash: jcsSha256Hex(inventoryBase) });
  const base = {
    schema_version: AUTHORITATIVE_SOURCE_CLOSURE_SCHEMA,
    closure_claim: "two_explicit_components_ts_ast_module_graphs_plus_closed_world_executable_source_inventory" as const,
    js_dynamic_loader_boundary: "JS entrypoints are hashed executable artifacts; their canonical jiti module lists are AST-extracted and matched to TS graph roots, not claimed as TS graph nodes" as const,
    components: Object.freeze(["typescript_ast_module_graphs", "closed_world_executable_source_inventory"]),
    dynamic_jiti_modules: dynamicJitiModules,
    typescript_ast_module_graphs: graphs,
    executable_source_inventory: executableInventory,
  };
  const closure = deepFreeze({ ...base, closure_hash: jcsSha256Hex(base) });
  validateAuthoritativeSourceClosure(closure);
  return closure;
}

function validateAuthoritativeSourceClosure(input: Readonly<Record<string, unknown>>): void {
  const closure = asRecord(input);
  exactKeys(closure, ["schema_version", "closure_claim", "js_dynamic_loader_boundary", "components", "dynamic_jiti_modules", "typescript_ast_module_graphs", "executable_source_inventory", "closure_hash"], "authoritative_source_closure");
  if (closure.schema_version !== AUTHORITATIVE_SOURCE_CLOSURE_SCHEMA
    || closure.closure_claim !== "two_explicit_components_ts_ast_module_graphs_plus_closed_world_executable_source_inventory"
    || closure.js_dynamic_loader_boundary !== "JS entrypoints are hashed executable artifacts; their canonical jiti module lists are AST-extracted and matched to TS graph roots, not claimed as TS graph nodes"
    || canonicalizeJcs(closure.components) !== canonicalizeJcs(["typescript_ast_module_graphs", "closed_world_executable_source_inventory"])) {
    throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "authoritative source closure identity drifted");
  }
  const dynamic = asRecord(closure.dynamic_jiti_modules);
  const graphs = asRecord(closure.typescript_ast_module_graphs);
  exactKeys(dynamic, ["publisher", "dossier", "planned_diff", "smoke"], "authoritative_source_closure.dynamic_jiti_modules");
  exactKeys(graphs, ["publisher", "dossier", "planned_diff", "smoke"], "authoritative_source_closure.typescript_ast_module_graphs");
  const graphPaths = new Set<string>();
  for (const name of ["publisher", "dossier", "planned_diff", "smoke"] as const) {
    const graph = graphs[name] as TypescriptStaticDependencyGraph;
    validateTypescriptStaticDependencyGraph(graph);
    if (canonicalizeJcs(graph.roots) !== canonicalizeJcs(dynamic[name])) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", `${name} dynamic module binding differs from TS graph roots`);
    for (const row of graph.files) graphPaths.add(row.path);
  }
  const inventory = asRecord(closure.executable_source_inventory);
  exactKeys(inventory, ["scope", "executable_entrypoints", "package_json_path", "package_script_commands", "rows", "inventory_hash"], "authoritative_source_closure.executable_source_inventory");
  if (inventory.scope !== "closed_world_four_executables_package_scripts_and_all_reachable_ts_module_bytes"
    || canonicalizeJcs(inventory.executable_entrypoints) !== canonicalizeJcs(SOURCE_ENTRYPOINTS)
    || inventory.package_json_path !== "package.json"
    || canonicalizeJcs(inventory.package_script_commands) !== canonicalizeJcs(SOURCE_SCRIPT_COMMANDS)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "executable/source inventory contract drifted");
  const rows = array(inventory.rows, "authoritative_source_closure.executable_source_inventory.rows").map((row) => asRecord(row));
  const rowPaths = rows.map((row) => String(row.path));
  if (new Set(rowPaths).size !== rowPaths.length || rowPaths.some((value, index) => index > 0 && compareCodeUnits(rowPaths[index - 1]!, value) >= 0)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "source inventory paths are not sorted unique");
  for (const required of [...Object.values(SOURCE_ENTRYPOINTS), "package.json", ...PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS, ...graphPaths]) if (!rowPaths.includes(required)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "source inventory is not closed", { required });
  for (const row of rows) {
    exactKeys(row, ["path", "bytes", "sha256", "roles"], "authoritative_source_closure.executable_source_inventory.rows[]");
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "source inventory byte count invalid");
    assertSha256(row.sha256, "authoritative_source_closure.executable_source_inventory.rows[].sha256");
  }
  const inventoryBase = { ...inventory };
  delete inventoryBase.inventory_hash;
  assertSha256(inventory.inventory_hash, "authoritative_source_closure.executable_source_inventory.inventory_hash");
  if (jcsSha256Hex(inventoryBase) !== inventory.inventory_hash) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "source inventory hash mismatch");
  const base = { ...closure };
  delete base.closure_hash;
  assertSha256(closure.closure_hash, "authoritative_source_closure.closure_hash");
  if (jcsSha256Hex(base) !== closure.closure_hash) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "authoritative source closure hash mismatch");
}

function sourceClosureHashValid(closure: Readonly<Record<string, unknown>>): boolean {
  const base = { ...closure };
  delete base.closure_hash;
  return typeof closure.closure_hash === "string" && closure.closure_hash === jcsSha256Hex(base);
}

async function captureP2a21RuntimeIsolation(repoRoot: string): Promise<Readonly<{
  dependency_graph: TypescriptStaticDependencyGraph;
  forbidden_module_names: typeof RUNTIME_FORBIDDEN_MODULES;
  violations: readonly string[];
  package_pi_extensions_count: number;
  package_pi_extensions_hash: string;
  package_pi_extensions_unchanged: true;
  transitive_boundary: string;
}>> {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8")) as { pi?: { extensions?: unknown } };
  const extensions = pkg.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.some((entry) => typeof entry !== "string" || !entry) || new Set(extensions).size !== extensions.length) throw failure("PROPOSITION_POLICY_PUSH_PACKAGE", "package pi.extensions must be a unique string array");
  const dependencyGraph = buildTypescriptStaticDependencyGraph({ repoRoot, roots: extensions as string[] });
  validateTypescriptStaticDependencyGraph(dependencyGraph);
  const reachable = new Set(dependencyGraph.files.map((row) => row.path));
  const violations = RUNTIME_FORBIDDEN_MODULES.filter((name) => reachable.has(name)).sort(compareCodeUnits);
  const packageHash = jcsSha256Hex(extensions);
  if (extensions.length !== 25 || packageHash !== P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256) throw failure("PROPOSITION_POLICY_PUSH_RUNTIME_BASELINE", "package extension baseline drifted", { count: extensions.length, packageHash });
  if (violations.length) throw failure("PROPOSITION_POLICY_PUSH_RUNTIME_CONSUMER", "publisher/projector/preview is reachable from a runtime extension root", { violations });
  return deepFreeze({
    dependency_graph: dependencyGraph,
    forbidden_module_names: RUNTIME_FORBIDDEN_MODULES,
    violations,
    package_pi_extensions_count: extensions.length,
    package_pi_extensions_hash: packageHash,
    package_pi_extensions_unchanged: true,
    transitive_boundary: "all package pi.extensions roots and recursively resolved static local import/export/require/import/jiti literals; unresolved dynamic loaders fail closed",
  });
}

async function validateHistoricalDossierBytes(repoRoot: string): Promise<void> {
  for (const row of HISTORICAL_DOSSIERS) {
    const file = path.join(repoRoot, ...row.relative_path.split("/"));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) throw failure("PROPOSITION_POLICY_PUSH_HISTORY_UNSAFE", "historical dossier is unsafe", { file });
    const raw = await fs.readFile(file, "utf-8");
    if (sha256Hex(raw) !== row.raw_sha256) throw failure("PROPOSITION_POLICY_PUSH_HISTORY_DRIFT", "historical dossier bytes changed", { generation: row.generation });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const base = { ...parsed };
    delete base.dossier_hash;
    if (parsed.schema_version !== row.schema_version || parsed.dossier_hash !== row.dossier_hash || jcsSha256Hex(base) !== row.dossier_hash) throw failure("PROPOSITION_POLICY_PUSH_HISTORY_DRIFT", "historical dossier identity or self-hash changed", { generation: row.generation });
  }
}

async function genericWriteGateCode(options: {
  abrainHome: string;
  registry: ReturnType<typeof loadL1SchemaRegistry>;
  record: Awaited<ReturnType<typeof scanWholeL1Validated>>["all"][number];
}): Promise<string> {
  try {
    await validateL1WritePreflight({
      abrainHome: options.abrainHome,
      envelope: options.record.envelope,
      targetPath: expectedL1EventPath(options.abrainHome, options.record.eventId),
      registry: options.registry,
      expected: {
        envelopeSchema: "proposition-evidence-envelope/v1",
        domain: "proposition",
        role: "evidence",
        producer: String((options.record.body.producer as Record<string, unknown>)?.name ?? ""),
        eventType: "proposition_observed",
      },
    });
    return "UNEXPECTED_SUCCESS";
  } catch (err) {
    return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
  }
}

function assertDeploymentNeutralManifest(manifest: unknown): void {
  const keys = manifestDeploymentKeys(manifest);
  if (keys.length) throw failure("PROPOSITION_POLICY_PUSH_DEPLOYMENT_FIELD", "semantic manifest contains deployment placement fields", { keys });
}

function manifestDeploymentKeys(value: unknown, at = "manifest"): string[] {
  const output: string[] = [];
  const walk = (current: unknown, currentAt: string): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => walk(child, `${currentAt}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const keyAt = `${currentAt}.${key}`;
      if (normalized === "publishedtoabrain" || normalized.endsWith("placement") || normalized.endsWith("path") || normalized.endsWith("paths")) output.push(keyAt);
      walk(child, keyAt);
    }
  };
  walk(value, at);
  return output.sort(compareCodeUnits);
}

async function assertOutputPath(input: string, repoRoot: string): Promise<string> {
  const expected = path.join(repoRoot, ...PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_RELATIVE_PATH.split("/"));
  const resolved = path.resolve(input);
  if (resolved !== expected) throw failure("PROPOSITION_POLICY_PUSH_P2A21_OUTPUT", "dossier output path is not exact", { resolved, expected });
  const parent = path.dirname(expected);
  let current = path.parse(parent).root;
  for (const component of path.relative(current, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_POLICY_PUSH_P2A21_OUTPUT", "dossier ancestor is unsafe", { current });
  }
  if (await fs.realpath(parent) !== parent) throw failure("PROPOSITION_POLICY_PUSH_P2A21_OUTPUT", "dossier parent realpath differs");
  const leaf = await fs.lstat(expected).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile())) throw failure("PROPOSITION_POLICY_PUSH_P2A21_OUTPUT", "dossier leaf is unsafe");
  return expected;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", "expected object");
  return value as Record<string, unknown>;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", `${at} must be an array`);
  return value;
}

function assertSha256(value: unknown, at: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw failure("PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_INVALID", `${at} must be lowercase SHA-256`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionPolicyPushP2a21PreviewError {
  return new PropositionPolicyPushP2a21PreviewError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
