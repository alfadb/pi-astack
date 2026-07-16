import * as fs from "node:fs/promises";
import * as os from "node:os";
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
  PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID,
  PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS,
  PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_SCHEMA as PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_V1_SCHEMA,
  assertNoPropositionPolicyPushForbiddenKeys,
  buildPropositionPolicyPushShadow,
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";
import {
  buildTypescriptStaticDependencyGraph,
  validateTypescriptStaticDependencyGraph,
  type TypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";

export const PROPOSITION_POLICY_PUSH_PREVIEW_HARD_ABRAIN_REALPATH = "/home/worker/.abrain" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_SCHEMA = "proposition-policy-push-shadow-dossier/v3" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-14-adr0040-p2a1-production-preview-dossier-v3.json" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_SCHEMA = "proposition-policy-push-shadow-dossier/v2" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-13-adr0040-p2a1-production-preview-dossier-v2.json" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_HASH = "56ac3e422d58fe6c00ff1f7c2554e898261b2ff7b37614ad81cdd4d2ac813ee4" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V2_RAW_SHA256 = "8c6223f98ad676773537570f6cfe9e07d4559a14bfb1d45ceca3bf71fa690d62" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-13-adr0040-p2a1-production-preview-dossier.json" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_HASH = "2747e57f0488e58a39f1e77001169edf0a91b7bd4ff645c0ae10287dda398172" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_V1_RAW_SHA256 = "7424e208df28851d54a5f429a7e361d2a29db301bc5139e0f1dfaf195bdb1911" as const;
export const PROPOSITION_POLICY_PUSH_PREVIEW_CLI = "scripts/dossier-proposition-policy-push-shadow-preview.mjs" as const;
export const P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256 = "d080b5c01c980a5633d9ee251bd21c251e47b4fcf71fd82dd1fc4c995d7a1d6d" as const;

const DOSSIER_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted" as const;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const POLICY_SHADOW_FORBIDDEN_SEGMENT_PREFIXES = Object.freeze(["propositionpolicypushshadow", "propositionpolicyshadow"] as const);
const ABRAIN_SURFACE_KEYS = Object.freeze(["constraint_shadow", "knowledge", "knowledge_shadow", "l1", "l2", "projects", "rules"] as const);
const RUNTIME_SURFACE_KEYS = Object.freeze(["abrain_runtime_entry", "constraint_compiler_runtime", "memory_runtime", "package_registration", "rule_injector_runtime", "runtime_config", "sediment_runtime"] as const);
const CONTRACT_SURFACE_KEYS = Object.freeze(["l1_schema_registry", "lifecycle_resolver", "policy_push_preview", "policy_push_projector", "proposition_contract"] as const);
const RUNTIME_FORBIDDEN_MODULE_PATHS = Object.freeze([
  "extensions/_shared/proposition-policy-push-shadow-preview.ts",
  "extensions/_shared/proposition-policy-push-shadow.ts",
] as const);
const HISTORICAL_EXPECTED_PROJECTOR_IMPORTERS = Object.freeze([
  "extensions/_shared/proposition-policy-push-shadow-preview.ts",
  "scripts/smoke-proposition-policy-push-shadow-p2a1.mjs",
] as const);
const HISTORICAL_EXPECTED_PREVIEW_IMPORTERS = Object.freeze([
  "scripts/dossier-proposition-policy-push-shadow-preview.mjs",
  "scripts/smoke-proposition-policy-push-shadow-p2a1.mjs",
] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type InventoryKind = "directory" | "file" | "symlink";

interface InventoryRow {
  path: string;
  kind: InventoryKind;
  bytes: number;
  sha256: string;
  target: string | null;
}

interface WholeAbrainSnapshot {
  schema_version: "proposition-policy-push-whole-abrain-snapshot/v1";
  scope: "all_abrain_entries_no_carve_out";
  entry_count: number;
  directory_count: number;
  file_count: number;
  symlink_count: number;
  bytes: number;
  rows_hash: string;
  snapshot_hash: string;
}

interface WholeAbrainCapture {
  summary: WholeAbrainSnapshot;
  rows: readonly InventoryRow[];
}

interface TreeDigest {
  state: "missing" | "present";
  entry_count: number;
  directory_count: number;
  file_count: number;
  symlink_count: number;
  bytes: number;
  rows_hash: string;
}

interface FileDigest {
  state: "missing" | "present";
  bytes: number;
  sha256: string;
}

interface ProtectedSnapshot {
  schema_version: "proposition-policy-push-protected-surfaces/v1";
  abrain: Readonly<Record<typeof ABRAIN_SURFACE_KEYS[number], TreeDigest>>;
  runtime: Readonly<Record<typeof RUNTIME_SURFACE_KEYS[number], TreeDigest | FileDigest>>;
  contracts: Readonly<Record<typeof CONTRACT_SURFACE_KEYS[number], FileDigest>>;
  abrain_hash: string;
  runtime_hash: string;
  contracts_hash: string;
  snapshot_hash: string;
}

export interface PropositionPolicyPushPreviewDossier {
  schema_version: typeof PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  dossier_hash_scope: typeof DOSSIER_HASH_SCOPE;
  dossier_hash: string;
  mode: "real_read_only_preview";
  supersession: Readonly<Record<string, unknown>>;
  authorization: Readonly<Record<string, unknown>>;
  source: Readonly<Record<string, unknown>>;
  preview: Readonly<Record<string, unknown>>;
  mutation_proof: Readonly<Record<string, unknown>>;
  protected_before: ProtectedSnapshot;
  protected_after: ProtectedSnapshot;
  runtime_isolation: Readonly<Record<string, unknown>>;
  source_dependency_evidence: TypescriptStaticDependencyGraph;
  assertions: Readonly<Record<string, boolean>>;
}

export class PropositionPolicyPushPreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushPreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionPolicyPushProductionPreview(options: {
  abrainHome: string;
  outputPath: string;
  repoRoot?: string;
  registryPath?: string;
  runtimeConfigPath?: string;
}): Promise<PropositionPolicyPushPreviewDossier> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outputPath = await assertPreviewOutputPath(options.outputPath, repoRoot);
  const abrainHome = await assertHardProductionAbrain(options.abrainHome);
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const runtimeConfigPath = path.resolve(options.runtimeConfigPath ?? path.join(repoRoot, "..", "..", "pi-astack-settings.json"));
  const registry = loadL1SchemaRegistry(registryPath);
  await validateSupersededDossiers(repoRoot);

  const wholeBefore = await captureWholeAbrain(abrainHome);
  const protectedBefore = await captureProtectedSnapshot({ abrainHome, repoRoot, registryPath, runtimeConfigPath });
  const bundle = await buildPropositionPolicyPushShadow({ abrainHome, repoRoot, registryPath });
  const scan = await scanWholeL1Validated({ abrainHome, registry });
  const propositionRecords = scan.all.filter((record) => record.registration.domain === "proposition");
  const productionRecord = propositionRecords.find((record) => record.eventId === PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID);
  if (!productionRecord) throw failure("PROPOSITION_POLICY_PUSH_PRODUCTION_SOURCE_INVALID", "fixed production evidence event is missing");
  const productionStatement = sourcePropositionStatement(productionRecord.body);
  const genericGate = await genericWriteGateCode({ abrainHome, registry, record: productionRecord });
  const tempValidation = await validateBundleInTempSandbox(bundle);
  const sourceDependencies = buildTypescriptStaticDependencyGraph({
    repoRoot,
    roots: ["extensions/_shared/proposition-policy-push-shadow.ts"],
    explicitFiles: ["schemas/l1-schema-role-registry.json"],
  });
  validateTypescriptStaticDependencyGraph(sourceDependencies, { requiredPaths: PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS });
  const runtimeIsolation = await captureRuntimeIsolation(repoRoot);
  const protectedAfter = await captureProtectedSnapshot({ abrainHome, repoRoot, registryPath, runtimeConfigPath });
  const wholeAfter = await captureWholeAbrain(abrainHome);
  const wholeDiff = diffInventory(wholeBefore.rows, wholeAfter.rows);

  const wholeUnchanged = wholeBefore.summary.snapshot_hash === wholeAfter.summary.snapshot_hash
    && wholeDiff.created.length === 0
    && wholeDiff.modified.length === 0
    && wholeDiff.removed.length === 0;
  const policyShadowPrefixAbsence = capturePolicyShadowPrefixAbsence(wholeBefore.rows, wholeAfter.rows);
  if (!wholeUnchanged) {
    throw failure("PROPOSITION_POLICY_PUSH_ABRAIN_MUTATION_DETECTED", "whole real abrain changed during preview; no dossier was written", {
      before: wholeBefore.summary.snapshot_hash,
      after: wholeAfter.summary.snapshot_hash,
      created: wholeDiff.created.map((row) => row.path),
      modified: wholeDiff.modified.map((row) => row.path),
      removed: wholeDiff.removed.map((row) => row.path),
    });
  }
  const protectedUnchanged = protectedBefore.snapshot_hash === protectedAfter.snapshot_hash;
  const productionExclusion = bundle.exclusions.exclusions[0];
  const productionDiagnostic = bundle.diagnostics.diagnostics[0];
  const exactProductionResult = bundle.entries.entries.length === 0
    && bundle.exclusions.exclusions.length === 1
    && bundle.diagnostics.diagnostics.length === 1
    && productionExclusion?.source_event_id === PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID
    && productionExclusion.reason_code === "consumer_hints_policy_false"
    && productionDiagnostic?.source_event_id === productionExclusion.source_event_id
    && productionDiagnostic.reason_code === productionExclusion.reason_code
    && productionDiagnostic.code === "POLICY_CANDIDATE_EXCLUDED";
  const exactSource = propositionRecords.length === 2
    && bundle.manifest.source.proposition_genesis_count === 1
    && bundle.manifest.source.proposition_evidence_count === 1
    && bundle.manifest.source.proposition_lifecycle_count === 0
    && bundle.manifest.source.proposition_selected_count === 0
    && bundle.manifest.source.proposition_foldable_count === 0
    && canonicalizeJcs(bundle.manifest.source.evidence_event_ids) === canonicalizeJcs([PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID])
    && bundle.manifest.source.lifecycle_event_ids.length === 0
    && bundle.manifest.result.entry_count + bundle.manifest.result.exclusion_count === bundle.manifest.source.proposition_evidence_count;
  const sourceDependencyBase = { ...sourceDependencies } as Record<string, unknown>;
  delete sourceDependencyBase.graph_hash;
  const assertions = deepFreeze({
    whole_real_abrain_byte_identical_no_carve_out: wholeUnchanged,
    no_abrain_directory_file_or_symlink_created: wholeDiff.created.length === 0,
    no_abrain_entry_modified: wholeDiff.modified.length === 0,
    no_abrain_entry_removed: wholeDiff.removed.length === 0,
    protected_surfaces_unchanged: protectedUnchanged,
    exact_production_zero_entries_one_exclusion_one_diagnostic: exactProductionResult,
    production_exclusion_and_diagnostic_source_reason_match: productionExclusion?.source_event_id === productionDiagnostic?.source_event_id && productionExclusion?.reason_code === productionDiagnostic?.reason_code,
    proposition_selected_zero: bundle.manifest.source.proposition_selected_count === 0,
    proposition_foldable_zero: bundle.manifest.source.proposition_foldable_count === 0,
    generic_write_gate_disabled: genericGate === "L1_SCHEMA_WRITE_DISABLED",
    projection_envelope_phase_disabled: bundle.manifest.projection_envelope_contract.phase === "phase_disabled",
    shadow_push_only_no_runtime_consumer: bundle.manifest.authority === "shadow_push_only_no_runtime_consumer",
    no_policy_shadow_publication: !("published_to_abrain" in bundle.manifest.candidate_contract),
    production_policy_shadow_prefix_absent_before: policyShadowPrefixAbsence.absent_before === true,
    production_policy_shadow_prefix_absent_after: policyShadowPrefixAbsence.absent_after === true,
    temp_sandbox_removed: tempValidation.removed === true,
    runtime_import_isolation_exact: runtimeIsolation.exact,
    runtime_graph_covers_all_package_extension_roots: runtimeIsolation.dependency_graph.roots.length === 25,
    runtime_graph_has_no_unresolved_dynamic_loader: runtimeIsolation.dependency_graph.unresolved_dynamic_loaders.length === 0,
    package_pi_extensions_unchanged: runtimeIsolation.package_pi_extensions_unchanged,
    package_pi_extensions_matches_p1b_authorized_jcs_hash: runtimeIsolation.package_pi_extensions_hash === P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256,
    bundle_semantic_completeness_validated: bundle.manifest.result.entry_count + bundle.manifest.result.exclusion_count === bundle.manifest.source.proposition_evidence_count,
    source_dependency_inventory_hash_bound: sourceDependencies.graph_hash === jcsSha256Hex(sourceDependencyBase),
    production_source_exact_genesis_plus_one_evidence: exactSource,
  });
  if (Object.values(assertions).some((value) => value !== true)) {
    throw failure("PROPOSITION_POLICY_PUSH_PREVIEW_ASSERTION_FAILED", "P2a.1 production preview assertions did not all pass", { assertions });
  }

  const dossierBase = {
    schema_version: PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    dossier_hash_scope: DOSSIER_HASH_SCOPE,
    mode: "real_read_only_preview" as const,
    supersession: {
      generation: "v3",
      supersedes: [
        {
          generation: "v1",
          schema_version: PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_V1_SCHEMA,
          relative_path: PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH,
          dossier_hash: PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_HASH,
          raw_sha256: PROPOSITION_POLICY_PUSH_PREVIEW_V1_RAW_SHA256,
          reason: "v1 remains immutable history; v2 superseded its exact-only live-baseline collision",
        },
        {
          generation: "v2",
          schema_version: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_SCHEMA,
          relative_path: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_RELATIVE_PATH,
          dossier_hash: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_HASH,
          raw_sha256: PROPOSITION_POLICY_PUSH_PREVIEW_V2_RAW_SHA256,
          reason: "v3 supersedes v2 because the P2a.1 T0 BLOCK required semantic-complete bundle validation, AST runtime isolation, exhaustive precedence evidence, and transitive source inventory",
        },
      ],
      remediation: "P2a.1_T0_BLOCK_semantic_completeness_runtime_graph_precedence_source_inventory",
      production_publication_remains_unauthorized: true,
    },
    authorization: {
      phase: "ADR0040-P2a.1",
      status: "completed_authorized_read_only_preview",
      scope: "repo_side_policy_push_shadow_projector_plus_real_read_only_preview_only",
      authorization_basis: "six_vendor_unanimous_plus_explicit_user_contract",
      authorized_vendors: ["Anthropic", "DeepSeek", "MiniMax", "Moonshot", "OpenAI", "Z.ai"],
      p2a2_status: "blocked_separate_authorization_required",
      p2b_status: "blocked_separate_authorization_required",
      p3_status: "blocked_separate_authorization_required",
      p4_status: "blocked_separate_authorization_required",
    },
    source: {
      abrain_home: abrainHome,
      scanner: bundle.manifest.source.scanner,
      whole_l1: bundle.manifest.source.whole_l1,
      consumed_classification: bundle.manifest.source.consumed_classification,
      epoch_id: bundle.manifest.epoch.epoch_id,
      genesis_event_id: bundle.manifest.epoch.genesis_event_id,
      production_event_id: PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID,
      input_event_ids: bundle.manifest.source.input_event_ids,
      input_event_ids_hash: bundle.manifest.source.input_event_ids_hash,
      evidence_event_ids: bundle.manifest.source.evidence_event_ids,
      evidence_event_ids_hash: bundle.manifest.source.evidence_event_ids_hash,
      lifecycle_event_ids: bundle.manifest.source.lifecycle_event_ids,
      lifecycle_event_ids_hash: bundle.manifest.source.lifecycle_event_ids_hash,
      source_resolution_inventory_hash: bundle.manifest.source.source_resolution_inventory_hash,
      proposition_event_count: bundle.manifest.source.proposition_event_count,
      proposition_genesis_count: bundle.manifest.source.proposition_genesis_count,
      proposition_evidence_count: bundle.manifest.source.proposition_evidence_count,
      proposition_lifecycle_count: bundle.manifest.source.proposition_lifecycle_count,
      proposition_selected_count: bundle.manifest.source.proposition_selected_count,
      proposition_foldable_count: bundle.manifest.source.proposition_foldable_count,
      generic_write_gate: genericGate,
      projection_envelope_phase: bundle.manifest.projection_envelope_contract.phase,
    },
    preview: {
      build_mode: "in_memory_plus_removed_temp_sandbox",
      publication_mode: "none",
      abrain_shadow_path: null,
      authority: bundle.manifest.authority,
      candidate_semantics: bundle.manifest.candidate_contract.semantics,
      bundle_hash: bundle.manifest.bundle_hash,
      manifest_exact_bytes_sha256: sha256Hex(bundle.bytes["manifest.json"]),
      artifact_rows: bundle.manifest.artifacts,
      entry_count: bundle.manifest.result.entry_count,
      exclusion_count: bundle.manifest.result.exclusion_count,
      diagnostic_count: bundle.manifest.result.diagnostic_count,
      production_exclusion: {
        source_event_id: productionExclusion!.source_event_id,
        filter_stage: productionExclusion!.filter_stage,
        reason_code: productionExclusion!.reason_code,
        record_hash: productionExclusion!.record_hash,
      },
      production_diagnostic: {
        source_event_id: productionDiagnostic!.source_event_id,
        filter_stage: productionDiagnostic!.filter_stage,
        reason_code: productionDiagnostic!.reason_code,
        code: productionDiagnostic!.code,
        record_hash: productionDiagnostic!.record_hash,
      },
      temp_sandbox: tempValidation,
    },
    mutation_proof: {
      scope: "whole_real_abrain_before_after_no_carve_out",
      before: wholeBefore.summary,
      after: wholeAfter.summary,
      unchanged: wholeUnchanged,
      exact_diff: wholeDiff,
      policy_shadow_prefix_absence: policyShadowPrefixAbsence,
      abrain_directories_created: 0,
      abrain_files_created: 0,
      abrain_symlinks_created: 0,
      repo_evidence: {
        mutation_domain: "repo_evidence_outside_abrain",
        output_path: outputPath,
        repo_relative_path: PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_RELATIVE_PATH,
        write_policy: "direct_docs_evidence_symlink_safe_no_replace_absent_or_exact_identical",
        write_sequence: "after_successful_whole_abrain_after_snapshot_and_dossier_finalization",
      },
    },
    protected_before: protectedBefore,
    protected_after: protectedAfter,
    runtime_isolation: {
      dependency_graph: runtimeIsolation.dependency_graph,
      forbidden_runtime_module_paths: runtimeIsolation.forbidden_runtime_module_paths,
      runtime_violations: runtimeIsolation.runtime_violations,
      package_pi_extensions_count: runtimeIsolation.package_pi_extensions_count,
      package_pi_extensions_hash: runtimeIsolation.package_pi_extensions_hash,
      authorized_p1b_package_pi_extensions_hash: P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256,
      authorized_baseline_source: "ADR0040 P1b frozen package.json#pi.extensions RFC8785-JCS hash",
      package_pi_extensions_unchanged: runtimeIsolation.package_pi_extensions_unchanged,
      tests_previews_and_smokes_outside_runtime_roots_are_non_consumers: true,
      transitive_boundary: "all package.json#pi.extensions roots and recursively resolved static local import/export/require/jiti literals; unresolved dynamic loaders fail closed",
    },
    source_dependency_evidence: sourceDependencies,
    assertions,
  };
  const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) }) as PropositionPolicyPushPreviewDossier;
  if (canonicalizeJcs(dossier).includes(productionStatement)) throw failure("PROPOSITION_POLICY_PUSH_STATEMENT_LEAK", "preview dossier contains production statement text");
  validatePropositionPolicyPushPreviewDossier(dossier);
  return dossier;
}

export async function writePropositionPolicyPushProductionPreview(options: {
  abrainHome: string;
  outputPath: string;
  repoRoot?: string;
  registryPath?: string;
  runtimeConfigPath?: string;
}): Promise<{ dossier: PropositionPolicyPushPreviewDossier; status: DurableCreateStatus; raw_sha256: string }> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outputPath = await assertPreviewOutputPath(options.outputPath, repoRoot);
  const dossier = await buildPropositionPolicyPushProductionPreview({ ...options, repoRoot, outputPath });
  const raw = `${canonicalizeJcs(dossier)}\n`;
  const status = await durableAtomicCreateFile(outputPath, raw, { mode: 0o644 });
  if (status === "collision") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_COLLISION", "preview dossier path exists with different bytes", { outputPath });
  const readback = await fs.readFile(outputPath, "utf-8");
  if (readback !== raw) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_READBACK_MISMATCH", "preview dossier readback differs from exact bytes");
  return deepFreeze({ dossier, status, raw_sha256: sha256Hex(raw) });
}

export function validatePropositionPolicyPushPreviewDossier(dossier: PropositionPolicyPushPreviewDossier): void {
  validatePropositionPolicyPushPreviewV3Dossier(dossier);
}

export function validatePropositionPolicyPushPreviewV1Dossier(dossier: unknown): void {
  validateHistoricalPropositionPolicyPushPreviewDossier(dossier, "v1");
}

export function validatePropositionPolicyPushPreviewV2Dossier(dossier: unknown): void {
  validateHistoricalPropositionPolicyPushPreviewDossier(dossier, "v2");
}

function validatePropositionPolicyPushPreviewV3Dossier(input: unknown): void {
  const dossier = input as PropositionPolicyPushPreviewDossier;
  assertNoPropositionPolicyPushForbiddenKeys(dossier);
  assertNoStatementKey(dossier);
  assertExactKeys(asRecord(dossier), ["schema_version", "canonicalization", "hash_algorithm", "dossier_hash_scope", "dossier_hash", "mode", "supersession", "authorization", "source", "preview", "mutation_proof", "protected_before", "protected_after", "runtime_isolation", "source_dependency_evidence", "assertions"], "dossier");
  assertExactKeys(asRecord(dossier.supersession), ["generation", "supersedes", "remediation", "production_publication_remains_unauthorized"], "dossier.supersession");
  const supersedes = array(dossier.supersession.supersedes, "dossier.supersession.supersedes");
  if (supersedes.length !== 2) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "v3 must bind exactly v1 and v2 dossiers");
  for (const [index, row] of supersedes.entries()) {
    assertExactKeys(asRecord(row), ["generation", "schema_version", "relative_path", "dossier_hash", "raw_sha256", "reason"], `dossier.supersession.supersedes[${index}]`);
    assertSha256(asRecord(row).dossier_hash, `dossier.supersession.supersedes[${index}].dossier_hash`);
    assertSha256(asRecord(row).raw_sha256, `dossier.supersession.supersedes[${index}].raw_sha256`);
    if (typeof asRecord(row).reason !== "string" || !(asRecord(row).reason as string).trim()) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "supersession reason is missing");
  }
  const expectedSupersession = [
    { generation: "v1", schema_version: PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_V1_SCHEMA, relative_path: PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH, dossier_hash: PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_HASH, raw_sha256: PROPOSITION_POLICY_PUSH_PREVIEW_V1_RAW_SHA256 },
    { generation: "v2", schema_version: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_SCHEMA, relative_path: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_RELATIVE_PATH, dossier_hash: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_HASH, raw_sha256: PROPOSITION_POLICY_PUSH_PREVIEW_V2_RAW_SHA256 },
  ];
  for (const [index, expected] of expectedSupersession.entries()) {
    const row = asRecord(supersedes[index]);
    for (const [key, value] of Object.entries(expected)) if (row[key] !== value) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "v3 prior dossier binding drifted", { index, key });
  }
  if (dossier.supersession.generation !== "v3"
    || dossier.supersession.remediation !== "P2a.1_T0_BLOCK_semantic_completeness_runtime_graph_precedence_source_inventory"
    || dossier.supersession.production_publication_remains_unauthorized !== true) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "v3 supersession boundary drifted");

  assertExactKeys(asRecord(dossier.authorization), ["phase", "status", "scope", "authorization_basis", "authorized_vendors", "p2a2_status", "p2b_status", "p3_status", "p4_status"], "dossier.authorization");
  const authorizedVendors = array(dossier.authorization.authorized_vendors, "dossier.authorization.authorized_vendors");
  if (canonicalizeJcs(authorizedVendors) !== canonicalizeJcs(["Anthropic", "DeepSeek", "MiniMax", "Moonshot", "OpenAI", "Z.ai"])) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "authorized vendor set drifted");
  if (dossier.authorization.phase !== "ADR0040-P2a.1"
    || dossier.authorization.status !== "completed_authorized_read_only_preview"
    || dossier.authorization.p2a2_status !== "blocked_separate_authorization_required"
    || dossier.authorization.p2b_status !== "blocked_separate_authorization_required"
    || dossier.authorization.p3_status !== "blocked_separate_authorization_required"
    || dossier.authorization.p4_status !== "blocked_separate_authorization_required") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "authorization boundary drifted");

  assertExactKeys(asRecord(dossier.source), ["abrain_home", "scanner", "whole_l1", "consumed_classification", "epoch_id", "genesis_event_id", "production_event_id", "input_event_ids", "input_event_ids_hash", "evidence_event_ids", "evidence_event_ids_hash", "lifecycle_event_ids", "lifecycle_event_ids_hash", "source_resolution_inventory_hash", "proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "generic_write_gate", "projection_envelope_phase"], "dossier.source");
  const inputEventIds = array(dossier.source.input_event_ids, "dossier.source.input_event_ids");
  const evidenceEventIds = array(dossier.source.evidence_event_ids, "dossier.source.evidence_event_ids");
  const lifecycleEventIds = array(dossier.source.lifecycle_event_ids, "dossier.source.lifecycle_event_ids");
  assertSortedUniqueStrings(inputEventIds, "dossier.source.input_event_ids");
  assertSortedUniqueStrings(evidenceEventIds, "dossier.source.evidence_event_ids");
  assertSortedUniqueStrings(lifecycleEventIds, "dossier.source.lifecycle_event_ids", { allowEmpty: true });
  if (dossier.source.input_event_ids_hash !== jcsSha256Hex(inputEventIds)
    || dossier.source.evidence_event_ids_hash !== jcsSha256Hex(evidenceEventIds)
    || dossier.source.lifecycle_event_ids_hash !== jcsSha256Hex(lifecycleEventIds)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "source event ID hash drifted");
  assertSha256(dossier.source.source_resolution_inventory_hash, "dossier.source.source_resolution_inventory_hash");
  if (dossier.source.generic_write_gate !== "L1_SCHEMA_WRITE_DISABLED"
    || dossier.source.projection_envelope_phase !== "phase_disabled"
    || dossier.source.proposition_event_count !== 2
    || dossier.source.proposition_genesis_count !== 1
    || dossier.source.proposition_evidence_count !== 1
    || dossier.source.proposition_lifecycle_count !== 0
    || dossier.source.proposition_selected_count !== 0
    || dossier.source.proposition_foldable_count !== 0
    || canonicalizeJcs(inputEventIds) !== canonicalizeJcs(["3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3", PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID])
    || canonicalizeJcs(evidenceEventIds) !== canonicalizeJcs([PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID])
    || lifecycleEventIds.length !== 0) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "source gates drifted");

  assertExactKeys(asRecord(dossier.preview), ["build_mode", "publication_mode", "abrain_shadow_path", "authority", "candidate_semantics", "bundle_hash", "manifest_exact_bytes_sha256", "artifact_rows", "entry_count", "exclusion_count", "diagnostic_count", "production_exclusion", "production_diagnostic", "temp_sandbox"], "dossier.preview");
  assertExactKeys(asRecord(dossier.preview.production_exclusion), ["source_event_id", "filter_stage", "reason_code", "record_hash"], "dossier.preview.production_exclusion");
  assertExactKeys(asRecord(dossier.preview.production_diagnostic), ["source_event_id", "filter_stage", "reason_code", "code", "record_hash"], "dossier.preview.production_diagnostic");
  assertExactKeys(asRecord(dossier.preview.temp_sandbox), ["schema_version", "artifact_count", "artifact_rows_hash", "exact_readback", "removed"], "dossier.preview.temp_sandbox");
  const artifactRows = array(dossier.preview.artifact_rows, "dossier.preview.artifact_rows");
  for (const [index, row] of artifactRows.entries()) validateArtifactRow(row, `dossier.preview.artifact_rows[${index}]`);
  if (canonicalizeJcs(artifactRows.map((row) => asRecord(row).name)) !== canonicalizeJcs(["diagnostics.json", "entries.json", "exclusions.json"])) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "artifact rows drifted");
  if (dossier.preview.authority !== "shadow_push_only_no_runtime_consumer"
    || dossier.preview.publication_mode !== "none"
    || dossier.preview.abrain_shadow_path !== null
    || dossier.preview.entry_count !== 0
    || dossier.preview.exclusion_count !== 1
    || dossier.preview.diagnostic_count !== 1
    || dossier.preview.entry_count + dossier.preview.exclusion_count !== dossier.source.proposition_evidence_count) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "exact production preview result drifted");
  const productionExclusion = asRecord(dossier.preview.production_exclusion);
  const productionDiagnostic = asRecord(dossier.preview.production_diagnostic);
  if (productionExclusion.source_event_id !== PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID
    || productionExclusion.reason_code !== "consumer_hints_policy_false"
    || productionDiagnostic.source_event_id !== productionExclusion.source_event_id
    || productionDiagnostic.reason_code !== productionExclusion.reason_code
    || productionDiagnostic.code !== "POLICY_CANDIDATE_EXCLUDED") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "production exclusion/diagnostic binding drifted");
  for (const [at, value] of [["bundle_hash", dossier.preview.bundle_hash], ["manifest_exact_bytes_sha256", dossier.preview.manifest_exact_bytes_sha256], ["exclusion_record_hash", productionExclusion.record_hash], ["diagnostic_record_hash", productionDiagnostic.record_hash]] as const) assertSha256(value, `dossier.preview.${at}`);

  const mutationProof = asRecord(dossier.mutation_proof);
  assertExactKeys(mutationProof, ["scope", "before", "after", "unchanged", "exact_diff", "policy_shadow_prefix_absence", "abrain_directories_created", "abrain_files_created", "abrain_symlinks_created", "repo_evidence"], "dossier.mutation_proof");
  const exactDiff = asRecord(mutationProof.exact_diff);
  assertExactKeys(exactDiff, ["created", "modified", "removed"], "dossier.mutation_proof.exact_diff");
  const created = array(exactDiff.created, "dossier.mutation_proof.exact_diff.created");
  const modified = array(exactDiff.modified, "dossier.mutation_proof.exact_diff.modified");
  const removed = array(exactDiff.removed, "dossier.mutation_proof.exact_diff.removed");
  validateWholeSnapshot(mutationProof.before);
  validateWholeSnapshot(mutationProof.after);
  validatePolicyShadowPrefixAbsence(asRecord(mutationProof.policy_shadow_prefix_absence));
  validateProtectedSnapshot(dossier.protected_before);
  validateProtectedSnapshot(dossier.protected_after);
  const before = asRecord(mutationProof.before);
  const after = asRecord(mutationProof.after);
  if (mutationProof.unchanged !== true || before.snapshot_hash !== after.snapshot_hash || created.length || modified.length || removed.length
    || mutationProof.abrain_directories_created !== 0 || mutationProof.abrain_files_created !== 0 || mutationProof.abrain_symlinks_created !== 0
    || dossier.protected_before.snapshot_hash !== dossier.protected_after.snapshot_hash) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "zero-mutation proof failed");
  const repoEvidence = asRecord(mutationProof.repo_evidence);
  assertExactKeys(repoEvidence, ["mutation_domain", "output_path", "repo_relative_path", "write_policy", "write_sequence"], "dossier.mutation_proof.repo_evidence");
  const expectedOutputPath = path.resolve(__dirname, "..", "..", ...PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_RELATIVE_PATH.split("/"));
  if (repoEvidence.output_path !== expectedOutputPath || repoEvidence.repo_relative_path !== PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_RELATIVE_PATH) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "v3 repo evidence output binding drifted");

  const runtimeIsolation = asRecord(dossier.runtime_isolation);
  assertExactKeys(runtimeIsolation, ["dependency_graph", "forbidden_runtime_module_paths", "runtime_violations", "package_pi_extensions_count", "package_pi_extensions_hash", "authorized_p1b_package_pi_extensions_hash", "authorized_baseline_source", "package_pi_extensions_unchanged", "tests_previews_and_smokes_outside_runtime_roots_are_non_consumers", "transitive_boundary"], "dossier.runtime_isolation");
  const runtimeGraph = runtimeIsolation.dependency_graph as TypescriptStaticDependencyGraph;
  validateTypescriptStaticDependencyGraph(runtimeGraph);
  const forbiddenPaths = array(runtimeIsolation.forbidden_runtime_module_paths, "dossier.runtime_isolation.forbidden_runtime_module_paths");
  const runtimeViolations = array(runtimeIsolation.runtime_violations, "dossier.runtime_isolation.runtime_violations");
  if (canonicalizeJcs(forbiddenPaths) !== canonicalizeJcs(RUNTIME_FORBIDDEN_MODULE_PATHS)
    || runtimeViolations.length !== 0
    || runtimeGraph.roots.length !== 25
    || runtimeIsolation.package_pi_extensions_count !== 25
    || runtimeIsolation.package_pi_extensions_hash !== P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256
    || runtimeIsolation.authorized_p1b_package_pi_extensions_hash !== P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256
    || runtimeIsolation.package_pi_extensions_unchanged !== true
    || runtimeIsolation.tests_previews_and_smokes_outside_runtime_roots_are_non_consumers !== true) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "runtime isolation evidence drifted");
  validateTypescriptStaticDependencyGraph(dossier.source_dependency_evidence, { requiredPaths: PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS });

  const assertionKeys = ["whole_real_abrain_byte_identical_no_carve_out", "no_abrain_directory_file_or_symlink_created", "no_abrain_entry_modified", "no_abrain_entry_removed", "protected_surfaces_unchanged", "exact_production_zero_entries_one_exclusion_one_diagnostic", "production_exclusion_and_diagnostic_source_reason_match", "proposition_selected_zero", "proposition_foldable_zero", "generic_write_gate_disabled", "projection_envelope_phase_disabled", "shadow_push_only_no_runtime_consumer", "no_policy_shadow_publication", "production_policy_shadow_prefix_absent_before", "production_policy_shadow_prefix_absent_after", "temp_sandbox_removed", "runtime_import_isolation_exact", "runtime_graph_covers_all_package_extension_roots", "runtime_graph_has_no_unresolved_dynamic_loader", "package_pi_extensions_unchanged", "package_pi_extensions_matches_p1b_authorized_jcs_hash", "bundle_semantic_completeness_validated", "source_dependency_inventory_hash_bound", "production_source_exact_genesis_plus_one_evidence"];
  assertExactKeys(asRecord(dossier.assertions), assertionKeys, "dossier.assertions");
  if (Object.values(dossier.assertions).some((value) => value !== true)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier contains a false assertion");
  if (dossier.schema_version !== PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_SCHEMA
    || dossier.canonicalization !== "RFC8785-JCS"
    || dossier.hash_algorithm !== "sha256"
    || dossier.dossier_hash_scope !== DOSSIER_HASH_SCOPE
    || dossier.mode !== "real_read_only_preview") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier identity drifted");
  const base = { ...dossier } as Record<string, unknown>;
  delete base.dossier_hash;
  if (!SHA256_PATTERN.test(dossier.dossier_hash) || jcsSha256Hex(base) !== dossier.dossier_hash) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier self hash mismatch");
}

function validateHistoricalPropositionPolicyPushPreviewDossier(input: unknown, generation: "v1" | "v2"): void {
  const dossier = input as PropositionPolicyPushPreviewDossier;
  assertNoPropositionPolicyPushForbiddenKeys(dossier);
  assertNoStatementKey(dossier);
  const rootKeys = ["schema_version", "canonicalization", "hash_algorithm", "dossier_hash_scope", "dossier_hash", "mode", "authorization", "source", "preview", "mutation_proof", "protected_before", "protected_after", "runtime_isolation", "assertions"];
  if (generation === "v2") rootKeys.push("supersession");
  assertExactKeys(asRecord(dossier), rootKeys, "dossier");
  if (generation === "v2") {
    assertExactKeys(asRecord(dossier.supersession), ["generation", "supersedes_schema_version", "supersedes_relative_path", "supersedes_dossier_hash", "supersedes_raw_sha256", "reason", "projector_bundle_unchanged", "production_publication_remains_unauthorized"], "dossier.supersession");
  }
  assertExactKeys(asRecord(dossier.authorization), ["phase", "status", "scope", "authorization_basis", "authorized_vendors", "p2a2_status", "p2b_status", "p3_status", "p4_status"], "dossier.authorization");
  assertExactKeys(asRecord(dossier.source), ["abrain_home", "scanner", "whole_l1", "consumed_classification", "epoch_id", "genesis_event_id", "production_event_id", "input_event_ids", "input_event_ids_hash", "proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "generic_write_gate", "projection_envelope_phase"], "dossier.source");
  assertExactKeys(asRecord(dossier.preview), ["build_mode", "publication_mode", "abrain_shadow_path", "authority", "candidate_semantics", "bundle_hash", "manifest_exact_bytes_sha256", "artifact_rows", "entry_count", "exclusion_count", "diagnostic_count", "production_exclusion", "production_diagnostic", "temp_sandbox"], "dossier.preview");
  assertExactKeys(asRecord(dossier.preview.production_exclusion), ["source_event_id", "filter_stage", "reason_code", "record_hash"], "dossier.preview.production_exclusion");
  assertExactKeys(asRecord(dossier.preview.production_diagnostic), ["source_event_id", "filter_stage", "reason_code", "code", "record_hash"], "dossier.preview.production_diagnostic");
  assertExactKeys(asRecord(dossier.preview.temp_sandbox), ["schema_version", "artifact_count", "artifact_rows_hash", "exact_readback", "removed"], "dossier.preview.temp_sandbox");
  const mutationProofKeys = ["scope", "before", "after", "unchanged", "exact_diff", "abrain_directories_created", "abrain_files_created", "abrain_symlinks_created", "repo_evidence"];
  if (generation === "v2") mutationProofKeys.push("policy_shadow_prefix_absence");
  assertExactKeys(asRecord(dossier.mutation_proof), mutationProofKeys, "dossier.mutation_proof");
  assertExactKeys(asRecord(dossier.mutation_proof.exact_diff), ["created", "modified", "removed"], "dossier.mutation_proof.exact_diff");
  assertExactKeys(asRecord(dossier.mutation_proof.repo_evidence), ["mutation_domain", "output_path", "repo_relative_path", "write_policy", "write_sequence"], "dossier.mutation_proof.repo_evidence");
  assertExactKeys(asRecord(dossier.runtime_isolation), ["projector_direct_importers", "preview_direct_importers", "runtime_importers", "package_pi_extensions_count", "package_pi_extensions_hash", "package_pi_extensions_unchanged", "tests_and_fixtures_are_non_runtime_consumers", "transitive_boundary"], "dossier.runtime_isolation");
  const assertionKeys = ["whole_real_abrain_byte_identical_no_carve_out", "no_abrain_directory_file_or_symlink_created", "no_abrain_entry_modified", "no_abrain_entry_removed", "protected_surfaces_unchanged", "exact_production_zero_entries_one_exclusion_one_diagnostic", "production_exclusion_and_diagnostic_source_reason_match", "proposition_selected_zero", "proposition_foldable_zero", "generic_write_gate_disabled", "projection_envelope_phase_disabled", "shadow_push_only_no_runtime_consumer", "no_policy_shadow_publication", "temp_sandbox_removed", "runtime_import_isolation_exact", "package_pi_extensions_unchanged", "production_source_exact_genesis_plus_one_evidence"];
  if (generation === "v2") assertionKeys.push("production_policy_shadow_prefix_absent_before", "production_policy_shadow_prefix_absent_after");
  assertExactKeys(asRecord(dossier.assertions), assertionKeys, "dossier.assertions");

  const previewRecord = asRecord(dossier.preview);
  const productionExclusion = asRecord(previewRecord.production_exclusion);
  const productionDiagnostic = asRecord(previewRecord.production_diagnostic);
  const mutationProof = asRecord(dossier.mutation_proof);
  const prefixAbsence = generation === "v2" ? asRecord(mutationProof.policy_shadow_prefix_absence) : null;
  if (prefixAbsence) validatePolicyShadowPrefixAbsence(prefixAbsence);
  const wholeBefore = asRecord(mutationProof.before);
  const wholeAfter = asRecord(mutationProof.after);
  const exactDiff = asRecord(mutationProof.exact_diff);
  const created = array(exactDiff.created, "dossier.mutation_proof.exact_diff.created");
  const modified = array(exactDiff.modified, "dossier.mutation_proof.exact_diff.modified");
  const removed = array(exactDiff.removed, "dossier.mutation_proof.exact_diff.removed");
  for (const [at, rows] of [["created", created], ["modified", modified], ["removed", removed]] as const) {
    for (const [index, row] of rows.entries()) validateInventoryRow(row, `dossier.mutation_proof.exact_diff.${at}[${index}]`);
  }
  const artifactRows = array(previewRecord.artifact_rows, "dossier.preview.artifact_rows");
  for (const [index, row] of artifactRows.entries()) validateArtifactRow(row, `dossier.preview.artifact_rows[${index}]`);
  const artifactNames = artifactRows.map((row) => asRecord(row).name);
  if (canonicalizeJcs(artifactNames) !== canonicalizeJcs(["diagnostics.json", "entries.json", "exclusions.json"])) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier artifact rows are not the exact code-unit ordered set");
  const sourceRecord = asRecord(dossier.source);
  const inputEventIds = array(sourceRecord.input_event_ids, "dossier.source.input_event_ids");
  assertSortedUniqueStrings(inputEventIds, "dossier.source.input_event_ids");
  for (const [index, eventId] of inputEventIds.entries()) assertSha256(eventId, `dossier.source.input_event_ids[${index}]`);
  if (sourceRecord.input_event_ids_hash !== jcsSha256Hex(inputEventIds)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier input event id hash mismatch");
  for (const key of ["proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count"]) assertCount(sourceRecord[key], `dossier.source.${key}`);
  const authorizationRecord = asRecord(dossier.authorization);
  const authorizedVendors = array(authorizationRecord.authorized_vendors, "dossier.authorization.authorized_vendors");
  assertSortedUniqueStrings(authorizedVendors, "dossier.authorization.authorized_vendors");
  if (canonicalizeJcs(authorizedVendors) !== canonicalizeJcs(["Anthropic", "DeepSeek", "MiniMax", "Moonshot", "OpenAI", "Z.ai"])) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "authorized vendor set drifted");
  const isolationArrays = {} as Record<string, unknown[]>;
  for (const key of ["projector_direct_importers", "preview_direct_importers", "runtime_importers"]) {
    isolationArrays[key] = array(dossier.runtime_isolation[key], `dossier.runtime_isolation.${key}`);
    assertSortedUniqueStrings(isolationArrays[key], `dossier.runtime_isolation.${key}`, { allowEmpty: true });
  }
  if (canonicalizeJcs(isolationArrays.projector_direct_importers) !== canonicalizeJcs(HISTORICAL_EXPECTED_PROJECTOR_IMPORTERS)
    || canonicalizeJcs(isolationArrays.preview_direct_importers) !== canonicalizeJcs(HISTORICAL_EXPECTED_PREVIEW_IMPORTERS)
    || isolationArrays.runtime_importers.length !== 0) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "runtime isolation importer set drifted");
  validateWholeSnapshot(mutationProof.before);
  validateWholeSnapshot(mutationProof.after);
  validateProtectedSnapshot(dossier.protected_before);
  validateProtectedSnapshot(dossier.protected_after);

  const expectedSchema = generation === "v2" ? PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_SCHEMA : PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_V1_SCHEMA;
  if (dossier.schema_version as string !== expectedSchema
    || dossier.canonicalization !== "RFC8785-JCS"
    || dossier.hash_algorithm !== "sha256"
    || dossier.dossier_hash_scope !== DOSSIER_HASH_SCOPE
    || dossier.mode !== "real_read_only_preview") {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier identity drifted");
  }
  const base = { ...dossier } as Record<string, unknown>;
  delete base.dossier_hash;
  if (!SHA256_PATTERN.test(dossier.dossier_hash) || jcsSha256Hex(base) !== dossier.dossier_hash) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier self hash mismatch");
  if (generation === "v2") {
    if (dossier.supersession.generation !== "v2"
      || dossier.supersession.supersedes_schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_V1_SCHEMA
      || dossier.supersession.supersedes_relative_path !== PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH
      || dossier.supersession.supersedes_dossier_hash !== PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_HASH
      || dossier.supersession.supersedes_raw_sha256 !== PROPOSITION_POLICY_PUSH_PREVIEW_V1_RAW_SHA256
      || dossier.supersession.projector_bundle_unchanged !== true
      || dossier.supersession.production_publication_remains_unauthorized !== true) {
      throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "v2 supersession binding drifted");
    }
  }
  if (dossier.authorization.phase !== "ADR0040-P2a.1"
    || dossier.authorization.status !== "completed_authorized_read_only_preview"
    || dossier.authorization.p2a2_status !== "blocked_separate_authorization_required"
    || dossier.authorization.p2b_status !== "blocked_separate_authorization_required"
    || dossier.authorization.p3_status !== "blocked_separate_authorization_required"
    || dossier.authorization.p4_status !== "blocked_separate_authorization_required") {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "authorization boundary drifted");
  }
  if (dossier.source.generic_write_gate !== "L1_SCHEMA_WRITE_DISABLED"
    || dossier.source.projection_envelope_phase !== "phase_disabled"
    || dossier.source.proposition_event_count !== 2
    || dossier.source.proposition_genesis_count !== 1
    || dossier.source.proposition_evidence_count !== 1
    || dossier.source.proposition_lifecycle_count !== 0
    || dossier.source.proposition_selected_count !== 0
    || dossier.source.proposition_foldable_count !== 0
    || canonicalizeJcs(inputEventIds) !== canonicalizeJcs(["3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3", PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID])) {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "source gates drifted");
  }
  if (dossier.preview.authority !== "shadow_push_only_no_runtime_consumer"
    || dossier.preview.publication_mode !== "none"
    || dossier.preview.abrain_shadow_path !== null
    || dossier.preview.entry_count !== 0
    || dossier.preview.exclusion_count !== 1
    || dossier.preview.diagnostic_count !== 1) {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "exact production preview result drifted");
  }
  if (productionExclusion.source_event_id !== PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID
    || productionExclusion.reason_code !== "consumer_hints_policy_false"
    || productionDiagnostic.source_event_id !== productionExclusion.source_event_id
    || productionDiagnostic.reason_code !== productionExclusion.reason_code
    || productionDiagnostic.code !== "POLICY_CANDIDATE_EXCLUDED") {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "production exclusion/diagnostic binding drifted");
  }
  const repoEvidence = asRecord(dossier.mutation_proof.repo_evidence);
  const expectedRelativePath = generation === "v2" ? PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_RELATIVE_PATH : PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH;
  const expectedOutputPath = path.resolve(__dirname, "..", "..", ...expectedRelativePath.split("/"));
  if (repoEvidence.mutation_domain !== "repo_evidence_outside_abrain"
    || repoEvidence.output_path !== expectedOutputPath
    || repoEvidence.repo_relative_path !== expectedRelativePath
    || repoEvidence.write_policy !== "direct_docs_evidence_symlink_safe_no_replace_absent_or_exact_identical"
    || repoEvidence.write_sequence !== "after_successful_whole_abrain_after_snapshot_and_dossier_finalization") {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "repo evidence output binding drifted");
  }
  if (dossier.mutation_proof.unchanged !== true
    || wholeBefore.snapshot_hash !== wholeAfter.snapshot_hash
    || created.length
    || modified.length
    || removed.length
    || dossier.mutation_proof.abrain_directories_created !== 0
    || dossier.mutation_proof.abrain_files_created !== 0
    || dossier.mutation_proof.abrain_symlinks_created !== 0
    || dossier.protected_before.snapshot_hash !== dossier.protected_after.snapshot_hash
    || (prefixAbsence && (prefixAbsence.absent_before !== true || prefixAbsence.absent_after !== true))) {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "zero-mutation proof failed");
  }
  if (Object.values(dossier.assertions).some((value) => value !== true)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "dossier contains a false assertion");
  assertSha256(dossier.preview.bundle_hash, "dossier.preview.bundle_hash");
  assertSha256(dossier.preview.manifest_exact_bytes_sha256, "dossier.preview.manifest_exact_bytes_sha256");
  assertSha256(productionExclusion.record_hash, "dossier.preview.production_exclusion.record_hash");
  assertSha256(productionDiagnostic.record_hash, "dossier.preview.production_diagnostic.record_hash");
  assertSha256(dossier.runtime_isolation.package_pi_extensions_hash, "dossier.runtime_isolation.package_pi_extensions_hash");
}

async function validateBundleInTempSandbox(bundle: PropositionPolicyPushBundle): Promise<Readonly<Record<string, unknown>>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-policy-push-preview-"));
  let rowsHash = "";
  try {
    for (const name of ARTIFACT_NAMES) await fs.writeFile(path.join(root, name), bundle.bytes[name], { encoding: "utf-8", flag: "wx", mode: 0o600 });
    const readBytes = {} as Record<typeof ARTIFACT_NAMES[number], string>;
    for (const name of ARTIFACT_NAMES) readBytes[name] = await fs.readFile(path.join(root, name), "utf-8");
    const reconstructed = deepFreeze({
      manifest: JSON.parse(readBytes["manifest.json"]),
      entries: JSON.parse(readBytes["entries.json"]),
      exclusions: JSON.parse(readBytes["exclusions.json"]),
      diagnostics: JSON.parse(readBytes["diagnostics.json"]),
      bytes: readBytes,
    }) as PropositionPolicyPushBundle;
    validatePropositionPolicyPushBundle(reconstructed);
    for (const name of ARTIFACT_NAMES) if (readBytes[name] !== bundle.bytes[name]) throw failure("PROPOSITION_POLICY_PUSH_TEMP_READBACK_MISMATCH", `${name} temp readback differs`);
    rowsHash = jcsSha256Hex(ARTIFACT_NAMES.map((name) => ({ name, bytes: Buffer.byteLength(readBytes[name]), sha256: sha256Hex(readBytes[name]) })));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const removed = await fs.lstat(root).then(() => false, (err: unknown) => isNodeError(err) && err.code === "ENOENT");
  if (!removed) throw failure("PROPOSITION_POLICY_PUSH_TEMP_REMOVE_FAILED", "preview temp sandbox remains after validation", { root });
  return deepFreeze({
    schema_version: "proposition-policy-push-temp-validation/v1",
    artifact_count: ARTIFACT_NAMES.length,
    artifact_rows_hash: rowsHash,
    exact_readback: true,
    removed: true,
  });
}

async function captureWholeAbrain(abrainHome: string): Promise<WholeAbrainCapture> {
  const rows = await inventoryTree(abrainHome, abrainHome);
  const rowsHash = jcsSha256Hex(rows);
  const summary: WholeAbrainSnapshot = deepFreeze({
    schema_version: "proposition-policy-push-whole-abrain-snapshot/v1",
    scope: "all_abrain_entries_no_carve_out",
    entry_count: rows.length,
    directory_count: rows.filter((row) => row.kind === "directory").length,
    file_count: rows.filter((row) => row.kind === "file").length,
    symlink_count: rows.filter((row) => row.kind === "symlink").length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    rows_hash: rowsHash,
    snapshot_hash: jcsSha256Hex({ scope: "all_abrain_entries_no_carve_out", rows }),
  });
  return deepFreeze({ summary, rows });
}

async function captureProtectedSnapshot(options: {
  abrainHome: string;
  repoRoot: string;
  registryPath: string;
  runtimeConfigPath: string;
}): Promise<ProtectedSnapshot> {
  const abrain = {
    constraint_shadow: await treeDigest(path.join(options.abrainHome, ".state", "sediment", "constraint-shadow")),
    knowledge: await treeDigest(path.join(options.abrainHome, "knowledge")),
    knowledge_shadow: await treeDigest(path.join(options.abrainHome, ".state", "sediment", "proposition-knowledge-shadow")),
    l1: await treeDigest(path.join(options.abrainHome, "l1")),
    l2: await treeDigest(path.join(options.abrainHome, "l2")),
    projects: await treeDigest(path.join(options.abrainHome, "projects")),
    rules: await treeDigest(path.join(options.abrainHome, "rules")),
  };
  const runtime = {
    abrain_runtime_entry: await fileDigest(path.join(options.repoRoot, "extensions", "abrain", "index.ts")),
    constraint_compiler_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "sediment", "constraint-compiler")),
    memory_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "memory")),
    package_registration: await fileDigest(path.join(options.repoRoot, "package.json")),
    rule_injector_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "abrain", "rule-injector")),
    runtime_config: await fileDigest(options.runtimeConfigPath),
    sediment_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "sediment")),
  };
  const contracts = {
    l1_schema_registry: await fileDigest(options.registryPath),
    lifecycle_resolver: await fileDigest(path.join(options.repoRoot, "extensions", "_shared", "proposition-lifecycle-resolver.ts")),
    policy_push_preview: await fileDigest(path.join(options.repoRoot, "extensions", "_shared", "proposition-policy-push-shadow-preview.ts")),
    policy_push_projector: await fileDigest(path.join(options.repoRoot, "extensions", "_shared", "proposition-policy-push-shadow.ts")),
    proposition_contract: await fileDigest(path.join(options.repoRoot, "extensions", "_shared", "proposition.ts")),
  };
  const abrainHash = jcsSha256Hex(abrain);
  const runtimeHash = jcsSha256Hex(runtime);
  const contractsHash = jcsSha256Hex(contracts);
  return deepFreeze({
    schema_version: "proposition-policy-push-protected-surfaces/v1",
    abrain,
    runtime,
    contracts,
    abrain_hash: abrainHash,
    runtime_hash: runtimeHash,
    contracts_hash: contractsHash,
    snapshot_hash: jcsSha256Hex({ abrain, runtime, contracts }),
  });
}

async function treeDigest(root: string): Promise<TreeDigest> {
  const stat = await lstatIfPresent(root);
  if (!stat) return deepFreeze({ state: "missing", entry_count: 0, directory_count: 0, file_count: 0, symlink_count: 0, bytes: 0, rows_hash: jcsSha256Hex([]) });
  const rows = await inventoryTree(root, root);
  return deepFreeze({
    state: "present",
    entry_count: rows.length,
    directory_count: rows.filter((row) => row.kind === "directory").length,
    file_count: rows.filter((row) => row.kind === "file").length,
    symlink_count: rows.filter((row) => row.kind === "symlink").length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    rows_hash: jcsSha256Hex(rows),
  });
}

async function inventoryTree(root: string, file: string): Promise<readonly InventoryRow[]> {
  const rows: InventoryRow[] = [];
  const walk = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current);
    const relative = relativeUnix(root, current) || ".";
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(current);
      rows.push({ path: relative, kind: "symlink", bytes: 0, sha256: sha256Hex(target), target });
      return;
    }
    if (stat.isDirectory()) {
      rows.push({ path: relative, kind: "directory", bytes: 0, sha256: jcsSha256Hex({ kind: "directory" }), target: null });
      for (const child of (await fs.readdir(current)).sort(compareCodeUnits)) await walk(path.join(current, child));
      return;
    }
    if (!stat.isFile()) throw failure("PROPOSITION_POLICY_PUSH_SNAPSHOT_UNSUPPORTED", "snapshot found a non-file/directory/symlink entry", { path: current });
    const content = await fs.readFile(current);
    rows.push({ path: relative, kind: "file", bytes: content.length, sha256: sha256Hex(content), target: null });
  };
  await walk(file);
  rows.sort((left, right) => compareCodeUnits(left.path, right.path));
  return Object.freeze(rows);
}

async function fileDigest(file: string): Promise<FileDigest> {
  const stat = await lstatIfPresent(file);
  if (!stat) return deepFreeze({ state: "missing", bytes: 0, sha256: jcsSha256Hex(null) });
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure("PROPOSITION_POLICY_PUSH_PROTECTED_UNSAFE", "protected file is a symlink or non-file", { file });
  const content = await fs.readFile(file);
  return deepFreeze({ state: "present", bytes: content.length, sha256: sha256Hex(content) });
}

function diffInventory(before: readonly InventoryRow[], after: readonly InventoryRow[]): Readonly<Record<string, readonly InventoryRow[]>> {
  const beforeMap = new Map(before.map((row) => [row.path, row]));
  const afterMap = new Map(after.map((row) => [row.path, row]));
  return deepFreeze({
    created: after.filter((row) => !beforeMap.has(row.path)),
    modified: after.filter((row) => beforeMap.has(row.path) && canonicalizeJcs(beforeMap.get(row.path)) !== canonicalizeJcs(row)),
    removed: before.filter((row) => !afterMap.has(row.path)),
  });
}

function capturePolicyShadowPrefixAbsence(before: readonly InventoryRow[], after: readonly InventoryRow[]): Readonly<Record<string, unknown>> {
  const matches = (rows: readonly InventoryRow[]): readonly string[] => Object.freeze(rows
    .map((row) => row.path)
    .filter((relative) => relative.split("/").some((segment) => {
      const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, "");
      return POLICY_SHADOW_FORBIDDEN_SEGMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    }))
    .sort(compareCodeUnits));
  const beforeMatches = matches(before);
  const afterMatches = matches(after);
  return deepFreeze({
    schema_version: "proposition-policy-push-prefix-absence/v1",
    scope: "all_abrain_relative_paths_no_carve_out",
    normalized_forbidden_segment_prefixes: POLICY_SHADOW_FORBIDDEN_SEGMENT_PREFIXES,
    before_matches: beforeMatches,
    after_matches: afterMatches,
    absent_before: beforeMatches.length === 0,
    absent_after: afterMatches.length === 0,
  });
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
        producer: String(options.record.body.producer && typeof options.record.body.producer === "object" ? (options.record.body.producer as Record<string, unknown>).name : ""),
        eventType: "proposition_observed",
      },
    });
    return "UNEXPECTED_SUCCESS";
  } catch (err) {
    return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
  }
}

export async function captureRuntimeIsolation(repoRoot: string) {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8")) as { pi?: { extensions?: unknown } };
  const extensions = pkg.pi?.extensions;
  if (!Array.isArray(extensions)
    || extensions.some((entry) => typeof entry !== "string" || !entry)
    || new Set(extensions).size !== extensions.length) {
    throw failure("PROPOSITION_POLICY_PUSH_PACKAGE_INVALID", "package pi.extensions must be a unique string array");
  }
  const packageHash = jcsSha256Hex(extensions);
  const dependencyGraph = buildTypescriptStaticDependencyGraph({
    repoRoot,
    roots: extensions as string[],
  });
  validateTypescriptStaticDependencyGraph(dependencyGraph);
  const reachable = new Set(dependencyGraph.files.map((row) => row.path));
  const runtimeViolations = Object.freeze(RUNTIME_FORBIDDEN_MODULE_PATHS.filter((forbidden) => reachable.has(forbidden)).sort(compareCodeUnits));
  const packageUnchanged = extensions.length === 25 && packageHash === P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256;
  if (!packageUnchanged) throw failure("PROPOSITION_POLICY_PUSH_RUNTIME_BASELINE_DRIFT", "package pi.extensions differs from the frozen P1b authorized RFC8785-JCS baseline", { count: extensions.length, packageHash, expected: P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256 });
  if (runtimeViolations.length > 0) throw failure("PROPOSITION_POLICY_PUSH_RUNTIME_CONSUMER_DETECTED", "policy push preview/projector is reachable from a package runtime root", { runtimeViolations });
  return deepFreeze({
    dependency_graph: dependencyGraph,
    forbidden_runtime_module_paths: RUNTIME_FORBIDDEN_MODULE_PATHS,
    runtime_violations: runtimeViolations,
    package_pi_extensions_count: extensions.length,
    package_pi_extensions_hash: packageHash,
    package_pi_extensions_unchanged: packageUnchanged,
    exact: packageUnchanged && runtimeViolations.length === 0 && dependencyGraph.unresolved_dynamic_loaders.length === 0,
  });
}

async function assertHardProductionAbrain(input: string): Promise<string> {
  const resolved = path.resolve(input);
  if (resolved !== PROPOSITION_POLICY_PUSH_PREVIEW_HARD_ABRAIN_REALPATH) throw failure("PROPOSITION_POLICY_PUSH_REAL_ABRAIN_REQUIRED", "preview requires exact /home/worker/.abrain", { actual: resolved });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(resolved) !== resolved) throw failure("PROPOSITION_POLICY_PUSH_REAL_ABRAIN_REQUIRED", "real abrain path or realpath is unsafe");
  return resolved;
}

async function validateSupersededDossiers(repoRoot: string): Promise<void> {
  const rows = [
    {
      generation: "v1",
      relativePath: PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH,
      rawSha256: PROPOSITION_POLICY_PUSH_PREVIEW_V1_RAW_SHA256,
      dossierHash: PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_HASH,
      validate: validatePropositionPolicyPushPreviewV1Dossier,
    },
    {
      generation: "v2",
      relativePath: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_RELATIVE_PATH,
      rawSha256: PROPOSITION_POLICY_PUSH_PREVIEW_V2_RAW_SHA256,
      dossierHash: PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_HASH,
      validate: validatePropositionPolicyPushPreviewV2Dossier,
    },
  ] as const;
  for (const row of rows) {
    const expected = path.resolve(repoRoot, ...row.relativePath.split("/"));
    const file = await assertRepoEvidencePath(expected, repoRoot, row.relativePath);
    const raw = await fs.readFile(file, "utf-8");
    if (sha256Hex(raw) !== row.rawSha256) throw failure("PROPOSITION_POLICY_PUSH_PRIOR_DOSSIER_INVALID", `superseded ${row.generation} raw SHA-256 drifted`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw failure("PROPOSITION_POLICY_PUSH_PRIOR_DOSSIER_INVALID", `superseded ${row.generation} dossier is not valid JSON`, { error: err instanceof Error ? err.message : String(err) });
    }
    row.validate(parsed);
    if (asRecord(parsed).dossier_hash !== row.dossierHash) throw failure("PROPOSITION_POLICY_PUSH_PRIOR_DOSSIER_INVALID", `superseded ${row.generation} dossier hash drifted`);
  }
}

async function assertPreviewOutputPath(input: string, repoRoot: string): Promise<string> {
  return assertRepoEvidencePath(input, repoRoot, PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_RELATIVE_PATH);
}

async function assertRepoEvidencePath(input: string, repoRoot: string, relativePath: string): Promise<string> {
  const expected = path.resolve(repoRoot, ...relativePath.split("/"));
  const resolved = path.resolve(input);
  if (resolved !== expected) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_PATH_REJECTED", `dossier output must be ${expected}`, { actual: resolved });
  const parent = path.dirname(expected);
  let current = path.parse(parent).root;
  for (const component of path.relative(current, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_PATH_REJECTED", "dossier ancestor is a symlink or non-directory", { path: current });
  }
  if (await fs.realpath(parent) !== parent) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_PATH_REJECTED", "dossier parent realpath differs");
  const leaf = await lstatIfPresent(expected);
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile())) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_PATH_REJECTED", "dossier leaf is a symlink or non-file");
  return expected;
}

function sourcePropositionStatement(body: Readonly<Record<string, unknown>>): string {
  const proposition = asRecord(body.proposition);
  if (typeof proposition.statement !== "string" || !proposition.statement) throw failure("PROPOSITION_POLICY_PUSH_PRODUCTION_SOURCE_INVALID", "production source statement is missing");
  return proposition.statement;
}

function validateArtifactRow(value: unknown, at: string): void {
  const row = asRecord(value);
  assertExactKeys(row, ["name", "sha256", "bytes"], at);
  if (row.name !== "diagnostics.json" && row.name !== "entries.json" && row.name !== "exclusions.json") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at}.name invalid`);
  assertSha256(row.sha256, `${at}.sha256`);
  assertCount(row.bytes, `${at}.bytes`);
}

function validateInventoryRow(value: unknown, at: string): void {
  const row = asRecord(value);
  assertExactKeys(row, ["path", "kind", "bytes", "sha256", "target"], at);
  if (typeof row.path !== "string" || !row.path || (row.kind !== "directory" && row.kind !== "file" && row.kind !== "symlink")) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} identity invalid`);
  assertCount(row.bytes, `${at}.bytes`);
  assertSha256(row.sha256, `${at}.sha256`);
  if (row.target !== null && typeof row.target !== "string") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at}.target invalid`);
}

function validateWholeSnapshot(value: unknown): void {
  const snapshot = asRecord(value);
  assertExactKeys(snapshot, ["schema_version", "scope", "entry_count", "directory_count", "file_count", "symlink_count", "bytes", "rows_hash", "snapshot_hash"], "whole_snapshot");
  if (snapshot.schema_version !== "proposition-policy-push-whole-abrain-snapshot/v1" || snapshot.scope !== "all_abrain_entries_no_carve_out") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "whole snapshot identity invalid");
  for (const key of ["entry_count", "directory_count", "file_count", "symlink_count", "bytes"]) assertCount(snapshot[key], `whole_snapshot.${key}`);
  assertSha256(snapshot.rows_hash, "whole_snapshot.rows_hash");
  assertSha256(snapshot.snapshot_hash, "whole_snapshot.snapshot_hash");
}

function validatePolicyShadowPrefixAbsence(value: Record<string, unknown>): void {
  assertExactKeys(value, ["schema_version", "scope", "normalized_forbidden_segment_prefixes", "before_matches", "after_matches", "absent_before", "absent_after"], "policy_shadow_prefix_absence");
  const prefixes = array(value.normalized_forbidden_segment_prefixes, "policy_shadow_prefix_absence.normalized_forbidden_segment_prefixes");
  const beforeMatches = array(value.before_matches, "policy_shadow_prefix_absence.before_matches");
  const afterMatches = array(value.after_matches, "policy_shadow_prefix_absence.after_matches");
  assertSortedUniqueStrings(prefixes, "policy_shadow_prefix_absence.normalized_forbidden_segment_prefixes");
  assertSortedUniqueStrings(beforeMatches, "policy_shadow_prefix_absence.before_matches", { allowEmpty: true });
  assertSortedUniqueStrings(afterMatches, "policy_shadow_prefix_absence.after_matches", { allowEmpty: true });
  if (value.schema_version !== "proposition-policy-push-prefix-absence/v1"
    || value.scope !== "all_abrain_relative_paths_no_carve_out"
    || canonicalizeJcs(prefixes) !== canonicalizeJcs(POLICY_SHADOW_FORBIDDEN_SEGMENT_PREFIXES)
    || beforeMatches.length !== 0
    || afterMatches.length !== 0
    || value.absent_before !== true
    || value.absent_after !== true) {
    throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "production policy shadow prefix is not absent before and after");
  }
}

function validateProtectedSnapshot(value: ProtectedSnapshot): void {
  assertExactKeys(asRecord(value), ["schema_version", "abrain", "runtime", "contracts", "abrain_hash", "runtime_hash", "contracts_hash", "snapshot_hash"], "protected_snapshot");
  assertExactKeys(asRecord(value.abrain), ABRAIN_SURFACE_KEYS, "protected_snapshot.abrain");
  assertExactKeys(asRecord(value.runtime), RUNTIME_SURFACE_KEYS, "protected_snapshot.runtime");
  assertExactKeys(asRecord(value.contracts), CONTRACT_SURFACE_KEYS, "protected_snapshot.contracts");
  if (value.schema_version !== "proposition-policy-push-protected-surfaces/v1") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "protected snapshot schema invalid");
  for (const digest of Object.values(value.abrain)) validateTreeDigest(digest);
  for (const [key, digest] of Object.entries(value.runtime)) key === "abrain_runtime_entry" || key === "package_registration" || key === "runtime_config" ? validateFileDigest(digest) : validateTreeDigest(digest);
  for (const digest of Object.values(value.contracts)) validateFileDigest(digest);
  if (value.abrain_hash !== jcsSha256Hex(value.abrain) || value.runtime_hash !== jcsSha256Hex(value.runtime) || value.contracts_hash !== jcsSha256Hex(value.contracts) || value.snapshot_hash !== jcsSha256Hex({ abrain: value.abrain, runtime: value.runtime, contracts: value.contracts })) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "protected snapshot hash mismatch");
}

function validateTreeDigest(value: unknown): void {
  const digest = asRecord(value);
  assertExactKeys(digest, ["state", "entry_count", "directory_count", "file_count", "symlink_count", "bytes", "rows_hash"], "tree_digest");
  if (digest.state !== "present" && digest.state !== "missing") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "tree digest state invalid");
  for (const key of ["entry_count", "directory_count", "file_count", "symlink_count", "bytes"]) assertCount(digest[key], `tree_digest.${key}`);
  assertSha256(digest.rows_hash, "tree_digest.rows_hash");
}

function validateFileDigest(value: unknown): void {
  const digest = asRecord(value);
  assertExactKeys(digest, ["state", "bytes", "sha256"], "file_digest");
  if (digest.state !== "present" && digest.state !== "missing") throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "file digest state invalid");
  assertCount(digest.bytes, "file_digest.bytes");
  assertSha256(digest.sha256, "file_digest.sha256");
}

function assertNoStatementKey(value: unknown, at = "$root"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoStatementKey(child, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, "") === "statement") throw failure("PROPOSITION_POLICY_PUSH_STATEMENT_LEAK", `dossier contains statement at ${at}.${key}`);
    assertNoStatementKey(child, `${at}.${key}`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} must be an array`);
  return value;
}

function assertSortedUniqueStrings(values: readonly unknown[], at: string, options: { allowEmpty?: boolean } = {}): void {
  if (!options.allowEmpty && values.length === 0) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} must not be empty`);
  if (values.some((value) => typeof value !== "string" || !value) || new Set(values).size !== values.length || values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1] as string, value as string) >= 0)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} must be non-empty strings in unique code-unit order`);
}

function assertCount(value: unknown, at: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} must be a non-negative safe integer`);
}

function assertSha256(value: unknown, at: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", `${at} must be lowercase SHA-256`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("PROPOSITION_POLICY_PUSH_DOSSIER_INVALID", "expected object");
  return value as Record<string, unknown>;
}

async function lstatIfPresent(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeUnix(parent: string, child: string): string {
  return path.relative(parent, child).split(path.sep).join("/");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionPolicyPushPreviewError {
  return new PropositionPolicyPushPreviewError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
