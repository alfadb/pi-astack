import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalL1EnvelopeJson,
  expectedL1EventPath,
} from "./l1-schema-registry";
import {
  buildPropositionPolicyPushShadow,
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";
import {
  PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION,
  compilePropositionPolicyStableView,
  stableViewCanonicalizeJcs,
  stableViewSha256Hex,
  validateStableViewCompileProfile,
} from "./proposition-policy-stable-view";
import {
  PROPOSITION_POLICY_STABLE_VIEW_COMPILER_ARTIFACT_NAMES,
  PROPOSITION_POLICY_STABLE_VIEW_CONTRACT_RELATIVE,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS,
  buildPropositionPolicyStableViewCompilerManifestBase,
} from "./proposition-policy-stable-view-contract";
import {
  buildTypescriptStaticDependencyGraph,
  validateTypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";

export const PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE = ".state/sediment/proposition-policy-stable-view/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME = "/home/worker/.abrain" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET = `${PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME}/${PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE}` as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_MANIFEST_SCHEMA = "proposition-policy-stable-view-publication-manifest/v2" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE = "schemas/proposition-policy-stable-view-compile-profile-v1.json" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PUBLISHER_RELATIVE = "extensions/_shared/proposition-policy-stable-view-publisher.ts" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_TEXT = "确认发布当前 ADR0040 Policy stable view。" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_MAX_AGE_MS = 5 * 60 * 1_000;

const MANIFEST_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with bundle_hash and manifest_hash omitted" as const;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"] as const);
const NON_MANIFEST_ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "parity.json", "view.json", "view.md"] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PRODUCTION_SESSION_ROOT = "/home/worker/.pi/agent/sessions" as const;
const AUTHORIZATION_FUTURE_TOLERANCE_MS = 30_000;

type ArtifactName = typeof ARTIFACT_NAMES[number];
export type StableViewPublicationMode = "preview" | "production";

export interface PropositionPolicyStableViewBundle {
  bundle_hash: string;
  artifacts: Readonly<Record<ArtifactName, string>>;
  manifest: Readonly<Record<string, unknown>>;
  source_bundle: PropositionPolicyPushBundle;
}

/** Historical P2b1 type name retained for callers; the bundle is now 0/1/N. */
export type PropositionPolicyStableViewMvpBundle = PropositionPolicyStableViewBundle;

export interface PropositionPolicyStableViewPublicationResult {
  mode: StableViewPublicationMode;
  status: "created" | "identical";
  bundle_hash: string;
  target_root: string;
  bundle_directory: string;
  latest_symlink: string;
  latest_value: string;
  source_counts: {
    input_events: number;
    candidates: number;
    exclusions: number;
    diagnostics: number;
  };
  stable_item_count: number;
  view_utf8_bytes: number;
  artifact_rows: readonly Readonly<{ name: ArtifactName; bytes: number; sha256: string }>[];
}

export class PropositionPolicyStableViewPublisherError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyStableViewPublisherError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function buildStableViewProductionAuthorizationText(): string {
  return PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_TEXT;
}

export async function buildPropositionPolicyStableViewBundle(options: {
  sourceAbrainHome: string;
  repoRoot: string;
}): Promise<PropositionPolicyStableViewBundle> {
  const sourceAbrainHome = assertExactDirectory(options.sourceAbrainHome, "source abrain home");
  const repoRoot = assertExactDirectory(options.repoRoot, "repository root");
  const registryPath = path.join(repoRoot, "schemas", "l1-schema-role-registry.json");
  const profilePath = path.join(repoRoot, ...PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE.split("/"));
  const profileRaw = readCanonicalJsonFile(profilePath, "compile profile");
  const profile = validateStableViewCompileProfile(profileRaw.parsed);

  const firstProjection = await buildPropositionPolicyPushShadow({ abrainHome: sourceAbrainHome, repoRoot, registryPath });
  validateGeneralProjection(firstProjection);
  const sourceRows = readCanonicalL1Rows(sourceAbrainHome, firstProjection.manifest.source.input_event_ids);
  const secondProjection = await buildPropositionPolicyPushShadow({ abrainHome: sourceAbrainHome, repoRoot, registryPath });
  validateGeneralProjection(secondProjection);
  if (firstProjection.manifest.bundle_hash !== secondProjection.manifest.bundle_hash
    || !sameBundleBytes(firstProjection, secondProjection)) {
    fail("SOURCE_RACE", "P2a projection changed while source provenance was captured");
  }
  const sourceRowsAfter = readCanonicalL1Rows(sourceAbrainHome, secondProjection.manifest.source.input_event_ids);
  if (stableViewCanonicalizeJcs(sourceRows) !== stableViewCanonicalizeJcs(sourceRowsAfter)) {
    fail("SOURCE_RACE", "canonical L1 raw bytes changed while the projection was built");
  }

  const request = deepFreeze({
    source_bundle_hash: secondProjection.manifest.bundle_hash,
    source: {
      entries: secondProjection.entries,
      exclusions: secondProjection.exclusions,
      diagnostics: secondProjection.diagnostics,
      manifest: secondProjection.manifest,
    },
    compile_profile: profile,
    mode: "real" as const,
  });
  const evaluation = compilePropositionPolicyStableView(request);
  if (evaluation.pipeline !== "completed" || !["ready_empty", "ready_nonempty"].includes(evaluation.outcome_code) || !evaluation.artifacts) {
    fail("COMPILE_FAILED", "general policy-set compiler did not produce an all-five stable set", {
      pipeline: evaluation.pipeline,
      outcome_code: evaluation.outcome_code,
    });
  }
  const compilerManifestRaw = evaluation.artifacts["manifest.json"];
  const compilerManifest = parseCanonicalJson(compilerManifestRaw, "compiler manifest") as Record<string, unknown>;
  const view = parseCanonicalJson(evaluation.artifacts["view.json"], "compiler view") as Record<string, unknown>;
  const parity = parseCanonicalJson(evaluation.artifacts["parity.json"], "compiler parity") as Record<string, unknown>;
  const conservation = asRecord(parity.source_conservation, "compiler parity.source_conservation");
  const dispositions = asArray(conservation.dispositions, "compiler parity.source_conservation.dispositions").map((raw, index) => asRecord(raw, `compiler disposition[${index}]`));
  const candidateIds = new Set(secondProjection.entries.entries.map((entry) => entry.source_event_id));
  const candidateDispositions = dispositions
    .filter((row) => candidateIds.has(String(row.source_event_id)))
    .map((row) => ({ source_event_id: String(row.source_event_id), disposition: String(row.disposition) }))
    .sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  if (candidateDispositions.length !== candidateIds.size || candidateDispositions.some((row) => !["included", "excluded"].includes(row.disposition))) {
    fail("CANDIDATE_DISPOSITION_INVALID", "compiler parity does not provide one included/excluded disposition for every P2a candidate");
  }
  const items = asArray(view.items, "compiler view.items").map((raw, index) => asRecord(raw, `compiler view.items[${index}]`));
  const itemHashes = items.map((item, index) => {
    assertSha256(item.item_payload_sha256, `compiler view.items[${index}].item_payload_sha256`);
    return String(item.item_payload_sha256);
  });
  const projectIds = [...new Set(items.map((item) => asRecord(item.scope, "compiler item scope"))
    .filter((scope) => scope.scope_level === "project")
    .map((scope) => String(scope.project_id)))].sort(compareCodeUnits);
  const globalItemCount = items.filter((item) => asRecord(item.scope, "compiler item scope").scope_level === "global").length;
  const sourceClosure = buildTypescriptStaticDependencyGraph({
    repoRoot,
    roots: [PROPOSITION_POLICY_STABLE_VIEW_PUBLISHER_RELATIVE],
    explicitFiles: [PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE],
  });
  validateTypescriptStaticDependencyGraph(sourceClosure, {
    requiredPaths: [
      PROPOSITION_POLICY_STABLE_VIEW_PUBLISHER_RELATIVE,
      PROPOSITION_POLICY_STABLE_VIEW_CONTRACT_RELATIVE,
      "extensions/_shared/proposition-policy-stable-view.ts",
      "extensions/_shared/proposition-policy-push-shadow.ts",
      PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE,
    ],
  });

  const preliminary = {
    "diagnostics.json": evaluation.artifacts["diagnostics.json"],
    "parity.json": evaluation.artifacts["parity.json"],
    "view.json": evaluation.artifacts["view.json"],
    "view.md": evaluation.artifacts["view.md"],
  } as const;
  const artifactRows = NON_MANIFEST_ARTIFACT_NAMES.map((name) => artifactRow(name, preliminary[name]));
  const inputEventIds = secondProjection.manifest.source.input_event_ids;
  const manifestBase = deepFreeze({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_MANIFEST_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    bundle_hash_scope: MANIFEST_HASH_SCOPE,
    manifest_hash_scope: MANIFEST_HASH_SCOPE,
    authority: "bounded_multi_item_persisted_session_canary_default_off",
    canonical_source: {
      truth: "canonical_production_l1_only",
      input_event_count: inputEventIds.length,
      input_event_ids: inputEventIds,
      input_event_ids_hash: stableViewJcsSha256Hex(inputEventIds),
      input_event_rows: sourceRows,
      input_event_rows_hash: stableViewJcsSha256Hex(sourceRows),
      physical_accounting: {
        genesis_event_ids: [secondProjection.manifest.epoch.genesis_event_id],
        genesis_event_ids_hash: stableViewJcsSha256Hex([secondProjection.manifest.epoch.genesis_event_id]),
        evidence_event_ids: secondProjection.manifest.source.evidence_event_ids,
        evidence_event_ids_hash: secondProjection.manifest.source.evidence_event_ids_hash,
        lifecycle_event_ids: secondProjection.manifest.source.lifecycle_event_ids,
        lifecycle_event_ids_hash: secondProjection.manifest.source.lifecycle_event_ids_hash,
        observed_only_event_ids: [secondProjection.manifest.epoch.genesis_event_id, ...secondProjection.manifest.source.lifecycle_event_ids].sort(compareCodeUnits),
        observed_only_event_ids_hash: stableViewJcsSha256Hex([secondProjection.manifest.epoch.genesis_event_id, ...secondProjection.manifest.source.lifecycle_event_ids].sort(compareCodeUnits)),
      },
    },
    projection: {
      builder: "buildPropositionPolicyPushShadow",
      bundle_hash: secondProjection.manifest.bundle_hash,
      source_counts: {
        proposition_event_count: secondProjection.manifest.source.proposition_event_count,
        proposition_genesis_count: secondProjection.manifest.source.proposition_genesis_count,
        proposition_evidence_count: secondProjection.manifest.source.proposition_evidence_count,
        proposition_lifecycle_count: secondProjection.manifest.source.proposition_lifecycle_count,
        proposition_selected_count: secondProjection.manifest.source.proposition_selected_count,
        proposition_foldable_count: secondProjection.manifest.source.proposition_foldable_count,
      },
      result: secondProjection.manifest.result,
      source_resolution_inventory_hash: secondProjection.manifest.source.source_resolution_inventory_hash,
      artifact_rows: secondProjection.manifest.artifacts,
    },
    candidate_dispositions: {
      basis: PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION,
      candidate_count: candidateDispositions.length,
      dispositions: candidateDispositions,
      dispositions_hash: stableViewJcsSha256Hex(candidateDispositions),
      semantic_inference_performed: false,
      canonical_event_mutated: false,
      decision_l1_event_created: false,
    },
    compiler: {
      api: "compilePropositionPolicyStableView",
      compile_key: evaluation.compile_key,
      decision_identity: evaluation.decision_identity,
      compiler_output_manifest_hash: compilerManifest.manifest_hash,
      compiler_output_manifest_raw_sha256: stableViewSha256Hex(compilerManifestRaw),
      compile_profile: {
        relative_path: PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE,
        profile_hash: profile.profile_hash,
        raw_sha256: profileRaw.raw_sha256,
        bytes: Buffer.byteLength(profileRaw.raw),
      },
      source_closure: sourceClosure,
    },
    stable_view: {
      result_kind: evaluation.outcome_code,
      item_count: items.length,
      item_hashes: itemHashes,
      item_hashes_hash: stableViewJcsSha256Hex(itemHashes),
      scope_summary: {
        global_item_count: globalItemCount,
        project_item_count: items.length - globalItemCount,
        project_ids: projectIds,
        project_ids_hash: stableViewJcsSha256Hex(projectIds),
      },
      source_closure: compilerManifest.source_closure,
      injectable_payload_utf8_bytes: Buffer.byteLength(preliminary["view.md"]),
      renderer: "ordered-statements-double-newline-terminal-newline-v1",
      artifact_set: "all_five_or_none",
      artifact_names: ARTIFACT_NAMES,
      non_manifest_artifact_rows: artifactRows,
      manifest_artifact_identity: "manifest_hash_self_preimage_sha256",
    },
  });
  const manifestHash = stableViewJcsSha256Hex(manifestBase);
  const manifest = deepFreeze({ ...manifestBase, bundle_hash: manifestHash, manifest_hash: manifestHash });
  const artifacts = deepFreeze({
    ...preliminary,
    "manifest.json": canonicalJson(manifest),
  }) as Readonly<Record<ArtifactName, string>>;
  const bundle = deepFreeze({
    bundle_hash: manifestHash,
    artifacts,
    manifest,
    source_bundle: secondProjection,
  });
  validatePropositionPolicyStableViewBundle(bundle);
  return bundle;
}

/** Historical P2b1 builder name retained with generalized set semantics. */
export const buildPropositionPolicyStableViewMvpBundle = buildPropositionPolicyStableViewBundle;

export function validatePropositionPolicyStableViewBundle(bundle: PropositionPolicyStableViewBundle): void {
  validatePropositionPolicyPushBundle(bundle.source_bundle);
  assertSha256(bundle.bundle_hash, "bundle.bundle_hash");
  exactKeys(bundle.artifacts as Record<string, unknown>, ARTIFACT_NAMES, "bundle.artifacts");
  const manifest = parseCanonicalJson(bundle.artifacts["manifest.json"], "manifest.json") as Record<string, unknown>;
  if (stableViewCanonicalizeJcs(manifest) !== stableViewCanonicalizeJcs(bundle.manifest)) {
    fail("MANIFEST_OBJECT_MISMATCH", "manifest object differs from exact manifest bytes");
  }
  const view = parseCanonicalJson(bundle.artifacts["view.json"], "view.json") as Record<string, unknown>;
  const diagnostics = parseCanonicalJson(bundle.artifacts["diagnostics.json"], "diagnostics.json") as Record<string, unknown>;
  const parity = parseCanonicalJson(bundle.artifacts["parity.json"], "parity.json") as Record<string, unknown>;
  validatePublicationManifest(manifest, bundle.bundle_hash, bundle.artifacts, bundle.source_bundle);
  validateStablePayloadRelations({ manifest, view, diagnostics, parity, viewMd: bundle.artifacts["view.md"], sourceBundle: bundle.source_bundle });
  assertPublicationAcceptanceEnvelope(bundle);
}

/** Historical P2b1 validator name retained with generalized set semantics. */
export const validatePropositionPolicyStableViewMvpBundle = validatePropositionPolicyStableViewBundle;

export async function publishPropositionPolicyStableView(options: {
  mode: StableViewPublicationMode;
  sourceAbrainHome: string;
  repoRoot: string;
  sandboxAbrainHome?: string;
  authorizationTranscriptPath?: string;
}): Promise<PropositionPolicyStableViewPublicationResult> {
  const sourceAbrainHome = path.resolve(options.sourceAbrainHome);
  const previewedBundle = await buildPropositionPolicyStableViewBundle({ sourceAbrainHome, repoRoot: options.repoRoot });
  let targetAbrainHome: string;
  let productionBinding: ReturnType<typeof buildProductionPublicationBinding> | undefined;
  if (options.mode === "production") {
    if (sourceAbrainHome !== PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME) {
      fail("NOT_AUTHORIZED", "production mode is fixed to /home/worker/.abrain");
    }
    productionBinding = buildProductionPublicationBinding(previewedBundle);
    validateProductionPublicationBinding(productionBinding, previewedBundle);
    if (!options.authorizationTranscriptPath) {
      fail("NOT_AUTHORIZED", "production publication requires a persisted transcript containing the short exact authorization sentence");
    }
    verifyProductionAuthorization(options.authorizationTranscriptPath, Date.now());
    targetAbrainHome = assertExactDirectory(PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME, "production abrain home");
  } else {
    if (!options.sandboxAbrainHome) fail("SANDBOX_REQUIRED", "preview mode requires an explicit sandbox abrain home");
    targetAbrainHome = assertSandboxDirectory(options.sandboxAbrainHome);
    if (targetAbrainHome === PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME) {
      fail("SANDBOX_REQUIRED", "preview mode cannot target the production abrain home");
    }
  }
  const result = materializeBundle({ mode: options.mode, targetAbrainHome, bundle: previewedBundle });
  if (productionBinding) validateProductionPublicationResult(productionBinding, result);
  return result;
}

function validateGeneralProjection(bundle: PropositionPolicyPushBundle): void {
  validatePropositionPolicyPushBundle(bundle);
  if (bundle.entries.entries.some((entry) => entry.effective_facets.consumer_hints.policy !== true
      || entry.lifecycle.disposition !== "active")) {
    fail("PROJECTION_INVALID", "P2a candidates must remain validated policy=true active entries");
  }
}

function validatePublicationManifest(
  manifest: Record<string, unknown>,
  expectedBundleHash: string,
  artifacts: Readonly<Record<ArtifactName, string>>,
  sourceBundle: PropositionPolicyPushBundle,
): void {
  exactKeys(manifest, ["schema_version", "canonicalization", "hash_algorithm", "bundle_hash_scope", "manifest_hash_scope", "authority", "canonical_source", "projection", "candidate_dispositions", "compiler", "stable_view", "bundle_hash", "manifest_hash"], "manifest");
  if (manifest.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_MANIFEST_SCHEMA
    || manifest.canonicalization !== "RFC8785-JCS"
    || manifest.hash_algorithm !== "sha256"
    || manifest.bundle_hash_scope !== MANIFEST_HASH_SCOPE
    || manifest.manifest_hash_scope !== MANIFEST_HASH_SCOPE
    || manifest.authority !== "bounded_multi_item_persisted_session_canary_default_off"
    || manifest.bundle_hash !== expectedBundleHash
    || manifest.manifest_hash !== expectedBundleHash) {
    fail("MANIFEST_IDENTITY_INVALID", "publication manifest identity differs");
  }
  const base = deepClone(manifest);
  delete base.bundle_hash;
  delete base.manifest_hash;
  if (stableViewJcsSha256Hex(base) !== expectedBundleHash) fail("MANIFEST_HASH_INVALID", "publication manifest self-hash differs");

  const source = asRecord(manifest.canonical_source, "manifest.canonical_source");
  exactKeys(source, ["truth", "input_event_count", "input_event_ids", "input_event_ids_hash", "input_event_rows", "input_event_rows_hash", "physical_accounting"], "manifest.canonical_source");
  const inputIds = asArray(source.input_event_ids, "manifest.canonical_source.input_event_ids").map(String);
  const sourceRows = asArray(source.input_event_rows, "manifest.canonical_source.input_event_rows");
  if (source.truth !== "canonical_production_l1_only"
    || source.input_event_count !== inputIds.length
    || inputIds.length > PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS
    || source.input_event_ids_hash !== stableViewJcsSha256Hex(inputIds)
    || source.input_event_rows_hash !== stableViewJcsSha256Hex(sourceRows)
    || stableViewCanonicalizeJcs(inputIds) !== stableViewCanonicalizeJcs(sourceBundle.manifest.source.input_event_ids)
    || sourceRows.length !== inputIds.length) fail("SOURCE_PROVENANCE_INVALID", "canonical source closure differs from the P2a source");
  const rowIds: string[] = [];
  for (const [index, raw] of sourceRows.entries()) {
    const row = asRecord(raw, `manifest.canonical_source.input_event_rows[${index}]`);
    exactKeys(row, ["event_id", "relative_path", "bytes", "raw_sha256"], `manifest.canonical_source.input_event_rows[${index}]`);
    assertSha256(row.event_id, `manifest.canonical_source.input_event_rows[${index}].event_id`);
    assertSha256(row.raw_sha256, `manifest.canonical_source.input_event_rows[${index}].raw_sha256`);
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0
      || row.relative_path !== `l1/events/sha256/${String(row.event_id).slice(0, 2)}/${String(row.event_id).slice(2, 4)}/${row.event_id}.json`) {
      fail("SOURCE_PROVENANCE_INVALID", "canonical input row shape or path differs", { index });
    }
    rowIds.push(String(row.event_id));
  }
  if (stableViewCanonicalizeJcs(rowIds) !== stableViewCanonicalizeJcs(inputIds)
    || new Set(inputIds).size !== inputIds.length
    || inputIds.some((value, index) => index > 0 && compareCodeUnits(inputIds[index - 1]!, value) >= 0)) {
    fail("SOURCE_PROVENANCE_INVALID", "canonical input rows are duplicate, reordered, or foreign");
  }
  const accounting = asRecord(source.physical_accounting, "manifest.canonical_source.physical_accounting");
  exactKeys(accounting, ["genesis_event_ids", "genesis_event_ids_hash", "evidence_event_ids", "evidence_event_ids_hash", "lifecycle_event_ids", "lifecycle_event_ids_hash", "observed_only_event_ids", "observed_only_event_ids_hash"], "manifest.canonical_source.physical_accounting");
  const expectedObservedOnly = [sourceBundle.manifest.epoch.genesis_event_id, ...sourceBundle.manifest.source.lifecycle_event_ids].sort(compareCodeUnits);
  const expectedAccounting = {
    genesis_event_ids: [sourceBundle.manifest.epoch.genesis_event_id],
    genesis_event_ids_hash: stableViewJcsSha256Hex([sourceBundle.manifest.epoch.genesis_event_id]),
    evidence_event_ids: sourceBundle.manifest.source.evidence_event_ids,
    evidence_event_ids_hash: sourceBundle.manifest.source.evidence_event_ids_hash,
    lifecycle_event_ids: sourceBundle.manifest.source.lifecycle_event_ids,
    lifecycle_event_ids_hash: sourceBundle.manifest.source.lifecycle_event_ids_hash,
    observed_only_event_ids: expectedObservedOnly,
    observed_only_event_ids_hash: stableViewJcsSha256Hex(expectedObservedOnly),
  };
  if (stableViewCanonicalizeJcs(accounting) !== stableViewCanonicalizeJcs(expectedAccounting)) fail("SOURCE_PROVENANCE_INVALID", "physical proposition accounting differs from P2a source partitions");

  const projection = asRecord(manifest.projection, "manifest.projection");
  exactKeys(projection, ["builder", "bundle_hash", "source_counts", "result", "source_resolution_inventory_hash", "artifact_rows"], "manifest.projection");
  const expectedSourceCounts = {
    proposition_event_count: sourceBundle.manifest.source.proposition_event_count,
    proposition_genesis_count: sourceBundle.manifest.source.proposition_genesis_count,
    proposition_evidence_count: sourceBundle.manifest.source.proposition_evidence_count,
    proposition_lifecycle_count: sourceBundle.manifest.source.proposition_lifecycle_count,
    proposition_selected_count: sourceBundle.manifest.source.proposition_selected_count,
    proposition_foldable_count: sourceBundle.manifest.source.proposition_foldable_count,
  };
  if (projection.builder !== "buildPropositionPolicyPushShadow"
    || projection.bundle_hash !== sourceBundle.manifest.bundle_hash
    || projection.source_resolution_inventory_hash !== sourceBundle.manifest.source.source_resolution_inventory_hash
    || stableViewCanonicalizeJcs(projection.source_counts) !== stableViewCanonicalizeJcs(expectedSourceCounts)
    || stableViewCanonicalizeJcs(projection.result) !== stableViewCanonicalizeJcs(sourceBundle.manifest.result)
    || stableViewCanonicalizeJcs(projection.artifact_rows) !== stableViewCanonicalizeJcs(sourceBundle.manifest.artifacts)) {
    fail("PROJECTION_PROVENANCE_INVALID", "publication projection closure differs from the validated P2a bundle");
  }

  const candidate = asRecord(manifest.candidate_dispositions, "manifest.candidate_dispositions");
  exactKeys(candidate, ["basis", "candidate_count", "dispositions", "dispositions_hash", "semantic_inference_performed", "canonical_event_mutated", "decision_l1_event_created"], "manifest.candidate_dispositions");
  const candidateRows = asArray(candidate.dispositions, "manifest.candidate_dispositions.dispositions").map((raw, index) => {
    const row = asRecord(raw, `manifest.candidate_dispositions.dispositions[${index}]`);
    exactKeys(row, ["source_event_id", "disposition"], `manifest.candidate_dispositions.dispositions[${index}]`);
    assertSha256(row.source_event_id, `manifest.candidate_dispositions.dispositions[${index}].source_event_id`);
    if (row.disposition !== "included" && row.disposition !== "excluded") fail("CANDIDATE_DISPOSITION_INVALID", "real candidate disposition must be included or excluded", { index });
    return row;
  });
  const candidateIds = sourceBundle.entries.entries.map((entry) => entry.source_event_id);
  if (candidate.basis !== PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION
    || candidate.candidate_count !== candidateRows.length
    || candidateRows.length !== candidateIds.length
    || candidate.dispositions_hash !== stableViewJcsSha256Hex(candidateRows)
    || stableViewCanonicalizeJcs(candidateRows.map((row) => row.source_event_id)) !== stableViewCanonicalizeJcs(candidateIds)
    || candidate.semantic_inference_performed !== false
    || candidate.canonical_event_mutated !== false
    || candidate.decision_l1_event_created !== false) fail("CANDIDATE_DISPOSITION_INVALID", "candidate dispositions do not exactly cover P2a entries");

  const compiler = asRecord(manifest.compiler, "manifest.compiler");
  exactKeys(compiler, ["api", "compile_key", "decision_identity", "compiler_output_manifest_hash", "compiler_output_manifest_raw_sha256", "compile_profile", "source_closure"], "manifest.compiler");
  for (const field of ["compile_key", "compiler_output_manifest_hash", "compiler_output_manifest_raw_sha256"] as const) assertSha256(compiler[field], `manifest.compiler.${field}`);
  const expectedDecisionIdentity = candidateRows.length === 0
    ? "empty-source/no-decision/v1"
    : stableViewJcsSha256Hex({
      schema_version: "proposition-policy-stable-view-policy-set-decision/v1",
      basis: PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION,
      source_bundle_hash: projection.bundle_hash,
      candidate_dispositions: candidateRows,
    });
  if (compiler.api !== "compilePropositionPolicyStableView" || compiler.decision_identity !== expectedDecisionIdentity) {
    fail("COMPILER_IDENTITY_INVALID", "compiler API or deterministic candidate decision identity differs");
  }
  const compileProfile = asRecord(compiler.compile_profile, "manifest.compiler.compile_profile");
  exactKeys(compileProfile, ["relative_path", "profile_hash", "raw_sha256", "bytes"], "manifest.compiler.compile_profile");
  for (const field of ["profile_hash", "raw_sha256"] as const) assertSha256(compileProfile[field], `manifest.compiler.compile_profile.${field}`);
  if (compileProfile.relative_path !== PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE
    || !Number.isSafeInteger(compileProfile.bytes) || Number(compileProfile.bytes) <= 0
    || compiler.compile_key !== stableViewJcsSha256Hex({
      source_bundle_hash: projection.bundle_hash,
      compile_profile_hash: compileProfile.profile_hash,
      accepted_decision_hash_or_empty_sentinel: expectedDecisionIdentity,
    })) fail("COMPILER_IDENTITY_INVALID", "compile profile or compile key differs");
  validateTypescriptStaticDependencyGraph(compiler.source_closure as never, {
    requiredPaths: [
      PROPOSITION_POLICY_STABLE_VIEW_PUBLISHER_RELATIVE,
      PROPOSITION_POLICY_STABLE_VIEW_CONTRACT_RELATIVE,
      "extensions/_shared/proposition-policy-stable-view.ts",
      "extensions/_shared/proposition-policy-push-shadow.ts",
      PROPOSITION_POLICY_STABLE_VIEW_PROFILE_RELATIVE,
    ],
  });

  const stableView = asRecord(manifest.stable_view, "manifest.stable_view");
  exactKeys(stableView, ["result_kind", "item_count", "item_hashes", "item_hashes_hash", "scope_summary", "source_closure", "injectable_payload_utf8_bytes", "renderer", "artifact_set", "artifact_names", "non_manifest_artifact_rows", "manifest_artifact_identity"], "manifest.stable_view");
  const itemHashes = asArray(stableView.item_hashes, "manifest.stable_view.item_hashes");
  if (!Number.isSafeInteger(stableView.item_count) || Number(stableView.item_count) < 0 || Number(stableView.item_count) > PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS
    || itemHashes.length !== stableView.item_count || itemHashes.some((value) => typeof value !== "string" || !SHA256_PATTERN.test(value))
    || stableView.item_hashes_hash !== stableViewJcsSha256Hex(itemHashes)
    || stableView.result_kind !== (Number(stableView.item_count) === 0 ? "ready_empty" : "ready_nonempty")
    || !Number.isSafeInteger(stableView.injectable_payload_utf8_bytes) || Number(stableView.injectable_payload_utf8_bytes) < 0
    || stableView.renderer !== "ordered-statements-double-newline-terminal-newline-v1"
    || stableView.artifact_set !== "all_five_or_none"
    || stableViewCanonicalizeJcs(stableView.artifact_names) !== stableViewCanonicalizeJcs(ARTIFACT_NAMES)
    || stableView.manifest_artifact_identity !== "manifest_hash_self_preimage_sha256") fail("STABLE_CONTRACT_INVALID", "stable-view bounded all-five contract differs");
  const rows = asArray(stableView.non_manifest_artifact_rows, "manifest.stable_view.non_manifest_artifact_rows");
  const expectedRows = NON_MANIFEST_ARTIFACT_NAMES.map((name) => artifactRow(name, artifacts[name]));
  if (stableViewCanonicalizeJcs(rows) !== stableViewCanonicalizeJcs(expectedRows)) {
    fail("ARTIFACT_HASH_INVALID", "non-manifest artifact rows differ from exact bytes");
  }
}

function validateStablePayloadRelations(input: {
  manifest: Record<string, unknown>;
  view: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  parity: Record<string, unknown>;
  viewMd: string;
  sourceBundle: PropositionPolicyPushBundle;
}): void {
  const projection = asRecord(input.manifest.projection, "manifest.projection");
  const projectionResult = asRecord(projection.result, "manifest.projection.result");
  const candidate = asRecord(input.manifest.candidate_dispositions, "manifest.candidate_dispositions");
  const compiler = asRecord(input.manifest.compiler, "manifest.compiler");
  const stable = asRecord(input.manifest.stable_view, "manifest.stable_view");
  exactKeys(input.view, ["schema_version", "compile_key", "source_bundle_hash", "compile_profile_hash", "decision_identity", "fixture_synthetic", "result_kind", "items", "injectable_payload_utf8_bytes", "injectable_payload_sha256"], "view.json");
  const items = asArray(input.view.items, "view.items").map((raw, index) => asRecord(raw, `view.items[${index}]`));
  if (input.view.schema_version !== "proposition-policy-stable-view/v1"
    || input.view.compile_key !== compiler.compile_key
    || input.view.source_bundle_hash !== projection.bundle_hash
    || input.view.compile_profile_hash !== asRecord(compiler.compile_profile, "manifest.compiler.compile_profile").profile_hash
    || input.view.decision_identity !== compiler.decision_identity
    || input.view.fixture_synthetic !== false
    || input.view.result_kind !== stable.result_kind
    || items.length !== stable.item_count) fail("VIEW_INVALID", "stable view identity or item count differs");

  const itemHashes: string[] = [];
  const itemBySource = new Map<string, Record<string, unknown>>();
  const scopes: Record<string, unknown>[] = [];
  for (const [index, item] of items.entries()) {
    const at = `view.items[${index}]`;
    exactKeys(item, ["item_id", "statement", "statement_sha256", "scope", "scope_sha256", "source_event_ids", "source_lineage", "source_provenance", "item_payload_sha256"], at);
    for (const field of ["item_id", "statement_sha256", "scope_sha256", "item_payload_sha256"] as const) assertSha256(item[field], `${at}.${field}`);
    if (typeof item.statement !== "string" || !item.statement.length || item.statement_sha256 !== stableViewSha256Hex(item.statement)) fail("VIEW_PROVENANCE_INVALID", "item statement hash differs", { index });
    const scope = asRecord(item.scope, `${at}.scope`);
    exactKeys(scope, ["scope_level", "project_id", "domain"], `${at}.scope`);
    if (!((scope.scope_level === "global" && scope.project_id === null && scope.domain === null)
      || (scope.scope_level === "project" && typeof scope.project_id === "string" && scope.project_id.length > 0 && scope.domain === null))) {
      fail("VIEW_SCOPE_INVALID", "item scope is not exact global/project scope", { index });
    }
    if (item.scope_sha256 !== stableViewJcsSha256Hex(scope)) fail("VIEW_PROVENANCE_INVALID", "item scope hash differs", { index });
    const sourceIds = asArray(item.source_event_ids, `${at}.source_event_ids`).map(String);
    const lineageRows = asArray(item.source_lineage, `${at}.source_lineage`).map((raw, rowIndex) => asRecord(raw, `${at}.source_lineage[${rowIndex}]`));
    const provenanceRows = asArray(item.source_provenance, `${at}.source_provenance`).map((raw, rowIndex) => asRecord(raw, `${at}.source_provenance[${rowIndex}]`));
    if (sourceIds.length !== 1 || lineageRows.length !== 1 || provenanceRows.length !== 1) fail("VIEW_PROVENANCE_INVALID", "real stable item must bind exactly one source", { index });
    const provenance = provenanceRows[0]!;
    exactKeys(provenance, ["source_event_id", "source_body_sha256", "statement_sha256", "scope_sha256", "lineage_event_ids", "lifecycle_disposition", "lifecycle_activation", "lifecycle_terminal_event_id"], `${at}.source_provenance[0]`);
    const sourceId = sourceIds[0]!;
    for (const field of ["source_event_id", "source_body_sha256", "statement_sha256", "scope_sha256", "lifecycle_terminal_event_id"] as const) assertSha256(provenance[field], `${at}.source_provenance[0].${field}`);
    const lineageIds = asArray(provenance.lineage_event_ids, `${at}.source_provenance[0].lineage_event_ids`).map(String);
    const lineage = lineageRows[0]!;
    exactKeys(lineage, ["source_event_id", "lineage_event_ids"], `${at}.source_lineage[0]`);
    if (provenance.source_event_id !== sourceId || provenance.source_body_sha256 !== sourceId
      || provenance.statement_sha256 !== item.statement_sha256 || provenance.scope_sha256 !== item.scope_sha256
      || provenance.lifecycle_disposition !== "active" || provenance.lifecycle_activation !== "original"
      || lineage.source_event_id !== sourceId || stableViewCanonicalizeJcs(lineage.lineage_event_ids) !== stableViewCanonicalizeJcs(lineageIds)
      || new Set(lineageIds).size !== lineageIds.length) fail("VIEW_PROVENANCE_INVALID", "item source/body/statement/scope/lineage/lifecycle closure differs", { index });
    const sourceEntry = input.sourceBundle.entries.entries.find((entry) => entry.source_event_id === sourceId);
    if (!sourceEntry || sourceEntry.statement !== item.statement
      || sourceEntry.lifecycle.terminal_event_id !== provenance.lifecycle_terminal_event_id
      || stableViewCanonicalizeJcs(sourceEntry.lifecycle.lineage_event_ids) !== stableViewCanonicalizeJcs(lineageIds)) {
      fail("VIEW_PROVENANCE_INVALID", "item provenance differs from the P2a entry", { index });
    }
    const expectedItemId = stableViewJcsSha256Hex({ identity: `included:${sourceId}`, source_event_ids: [sourceId] });
    const itemBase = deepClone(item);
    delete itemBase.item_payload_sha256;
    if (item.item_id !== expectedItemId || item.item_payload_sha256 !== stableViewJcsSha256Hex(itemBase)) fail("VIEW_ITEM_HASH_INVALID", "item ID or payload self-hash differs", { index });
    if (itemBySource.has(sourceId)) fail("VIEW_PROVENANCE_INVALID", "duplicate source provenance across items", { sourceId });
    itemBySource.set(sourceId, item);
    itemHashes.push(String(item.item_payload_sha256));
    scopes.push(scope);
  }
  if (items.some((item, index) => index > 0 && compareCodeUnits(String(items[index - 1]!.item_id), String(item.item_id)) >= 0)
    || stableViewCanonicalizeJcs(itemHashes) !== stableViewCanonicalizeJcs(stable.item_hashes)) fail("VIEW_ITEM_HASH_INVALID", "items or item hashes are duplicate/reordered");
  const expectedMd = items.length === 0 ? "" : `${items.map((item) => String(item.statement)).join("\n\n")}\n`;
  if (input.viewMd !== expectedMd
    || input.view.injectable_payload_utf8_bytes !== Buffer.byteLength(expectedMd)
    || input.view.injectable_payload_sha256 !== stableViewSha256Hex(expectedMd)
    || stable.injectable_payload_utf8_bytes !== Buffer.byteLength(expectedMd)) fail("VIEW_RENDER_INVALID", "view.md is not the exact deterministic rendering of view.json items");
  const scopeSummary = asRecord(stable.scope_summary, "manifest.stable_view.scope_summary");
  exactKeys(scopeSummary, ["global_item_count", "project_item_count", "project_ids", "project_ids_hash"], "manifest.stable_view.scope_summary");
  const projectIds = [...new Set(scopes.filter((scope) => scope.scope_level === "project").map((scope) => String(scope.project_id)))].sort(compareCodeUnits);
  const globalCount = scopes.filter((scope) => scope.scope_level === "global").length;
  if (scopeSummary.global_item_count !== globalCount || scopeSummary.project_item_count !== items.length - globalCount
    || stableViewCanonicalizeJcs(scopeSummary.project_ids) !== stableViewCanonicalizeJcs(projectIds)
    || scopeSummary.project_ids_hash !== stableViewJcsSha256Hex(projectIds)) fail("VIEW_SCOPE_INVALID", "scope summary differs from exact items");

  exactKeys(input.diagnostics, ["schema_version", "compile_key", "diagnostics"], "diagnostics.json");
  const diagnostics = asArray(input.diagnostics.diagnostics, "diagnostics.diagnostics").map((raw, index) => asRecord(raw, `diagnostics.diagnostics[${index}]`));
  if (input.diagnostics.schema_version !== "proposition-policy-stable-view-diagnostics/v1"
    || input.diagnostics.compile_key !== compiler.compile_key || diagnostics.length !== projectionResult.exclusion_count) fail("DIAGNOSTICS_INVALID", "stable diagnostics identity or count differs");
  const expectedExcludedIds = input.sourceBundle.exclusions.exclusions.map((row) => row.source_event_id);
  for (const [index, diagnostic] of diagnostics.entries()) {
    exactKeys(diagnostic, ["code", "severity", "source_event_id", "filter_stage", "reason_code"], `diagnostics.diagnostics[${index}]`);
    if (diagnostic.code !== "POLICY_CANDIDATE_EXCLUDED" || diagnostic.severity !== "info"
      || diagnostic.filter_stage !== "stable_view_disposition" || diagnostic.reason_code !== "disposition_excluded"
      || diagnostic.source_event_id !== expectedExcludedIds[index]) fail("DIAGNOSTICS_INVALID", "stable diagnostic is foreign or reordered", { index });
  }

  exactKeys(input.parity, ["schema_version", "compile_key", "source_conservation", "deterministic_render", "scope_lineage", "noninterference"], "parity.json");
  if (input.parity.schema_version !== "proposition-policy-stable-view-parity/v1" || input.parity.compile_key !== compiler.compile_key) fail("PARITY_INVALID", "parity identity differs");
  const conservation = asRecord(input.parity.source_conservation, "parity.source_conservation");
  exactKeys(conservation, ["source_event_count", "source_event_ids_hash", "dispositions", "dispositions_hash", "diagnostic_count", "diagnostics_hash"], "parity.source_conservation");
  const dispositions = asArray(conservation.dispositions, "parity.source_conservation.dispositions").map((raw, index) => asRecord(raw, `parity disposition[${index}]`));
  const universe = [...input.sourceBundle.entries.entries.map((entry) => entry.source_event_id), ...expectedExcludedIds].sort(compareCodeUnits);
  if (conservation.source_event_count !== universe.length || conservation.source_event_ids_hash !== stableViewJcsSha256Hex(universe)
    || conservation.dispositions_hash !== stableViewJcsSha256Hex(dispositions) || conservation.diagnostic_count !== diagnostics.length
    || conservation.diagnostics_hash !== stableViewJcsSha256Hex(diagnostics) || dispositions.length !== universe.length) fail("PARITY_INVALID", "source conservation hash or count differs");
  const candidateRows = asArray(candidate.dispositions, "manifest.candidate_dispositions.dispositions");
  for (const [index, disposition] of dispositions.entries()) {
    exactKeys(disposition, ["source_event_id", "disposition", "item_id", "filter_stage", "reason_code"], `parity disposition[${index}]`);
    if (disposition.source_event_id !== universe[index]) fail("PARITY_INVALID", "source disposition is foreign or reordered", { index });
    const item = itemBySource.get(String(disposition.source_event_id));
    if (item) {
      if (disposition.disposition !== "included" || disposition.item_id !== item.item_id || disposition.filter_stage !== null || disposition.reason_code !== null) fail("PARITY_INVALID", "included disposition differs", { index });
    } else if (disposition.disposition !== "excluded" || disposition.item_id !== null
      || disposition.filter_stage !== "stable_view_disposition" || disposition.reason_code !== "disposition_excluded") fail("PARITY_INVALID", "excluded disposition differs", { index });
  }
  const actualCandidateRows = dispositions.filter((row) => input.sourceBundle.entries.entries.some((entry) => entry.source_event_id === row.source_event_id))
    .map((row) => ({ source_event_id: row.source_event_id, disposition: row.disposition }));
  if (stableViewCanonicalizeJcs(actualCandidateRows) !== stableViewCanonicalizeJcs(candidateRows)) fail("PARITY_INVALID", "manifest candidate dispositions differ from parity");
  const stableSourceClosure = asRecord(stable.source_closure, "manifest.stable_view.source_closure");
  if (stableViewCanonicalizeJcs(stableSourceClosure) !== stableViewCanonicalizeJcs({
    source_event_count: conservation.source_event_count,
    source_event_ids_hash: conservation.source_event_ids_hash,
    dispositions_hash: conservation.dispositions_hash,
    diagnostic_count: conservation.diagnostic_count,
    diagnostics_hash: conservation.diagnostics_hash,
  })) fail("PARITY_INVALID", "publication source closure differs from parity");
  validateCompilerOutputManifestBinding({
    compiler,
    projection,
    stable,
    view: input.view,
    diagnostics: input.diagnostics,
    parity: input.parity,
    viewMd: input.viewMd,
    sourceClosure: stableSourceClosure,
  });
  const render = asRecord(input.parity.deterministic_render, "parity.deterministic_render");
  if (render.renderer !== "ordered-statements-double-newline-terminal-newline-v1" || render.item_count !== items.length
    || render.items_hash !== stableViewJcsSha256Hex(items) || render.view_md_utf8_bytes !== Buffer.byteLength(expectedMd)
    || render.view_md_sha256 !== stableViewSha256Hex(expectedMd)) fail("PARITY_INVALID", "deterministic render parity differs");
  const scopeLineage = asRecord(input.parity.scope_lineage, "parity.scope_lineage");
  const commitments = asArray(scopeLineage.commitments, "parity.scope_lineage.commitments").map((raw, index) => asRecord(raw, `parity.scope_lineage.commitments[${index}]`));
  if (scopeLineage.source_entry_count !== input.sourceBundle.entries.entries.length
    || commitments.length !== input.sourceBundle.entries.entries.length
    || scopeLineage.commitments_hash !== stableViewJcsSha256Hex(commitments)) fail("PARITY_INVALID", "scope/lineage commitment count or hash differs");
  for (const [index, commitment] of commitments.entries()) {
    exactKeys(commitment, ["source_event_id", "source_body_sha256", "statement_sha256", "item_id", "scope_sha256", "lineage_event_ids_hash", "lineage_event_count", "lifecycle_disposition", "lifecycle_activation", "lifecycle_terminal_event_id"], `parity.scope_lineage.commitments[${index}]`);
    const entry = input.sourceBundle.entries.entries[index]!;
    const item = itemBySource.get(entry.source_event_id);
    if (commitment.source_event_id !== entry.source_event_id || commitment.source_body_sha256 !== entry.source_event_id
      || commitment.statement_sha256 !== stableViewSha256Hex(entry.statement)
      || commitment.item_id !== (item?.item_id ?? null) || commitment.scope_sha256 !== stableViewJcsSha256Hex(entry.effective_facets.spatial_scope)
      || commitment.lineage_event_ids_hash !== stableViewJcsSha256Hex(entry.lifecycle.lineage_event_ids)
      || commitment.lineage_event_count !== entry.lifecycle.lineage_event_ids.length
      || commitment.lifecycle_disposition !== entry.lifecycle.disposition || commitment.lifecycle_activation !== entry.lifecycle.activation
      || commitment.lifecycle_terminal_event_id !== entry.lifecycle.terminal_event_id) fail("PARITY_INVALID", "scope/lineage commitment differs from P2a entry", { index });
  }
  const noninterference = asRecord(input.parity.noninterference, "parity.noninterference");
  if (Object.values(noninterference).some((value) => value !== 0)) fail("PARITY_INVALID", "noninterference counters are nonzero");
}

function validateCompilerOutputManifestBinding(input: {
  compiler: Record<string, unknown>;
  projection: Record<string, unknown>;
  stable: Record<string, unknown>;
  view: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  parity: Record<string, unknown>;
  viewMd: string;
  sourceClosure: Record<string, unknown>;
}): void {
  const resultKind = input.stable.result_kind;
  if (resultKind !== "ready_empty" && resultKind !== "ready_nonempty") {
    fail("COMPILER_MANIFEST_BINDING_INVALID", "compiler result kind cannot reconstruct the inner manifest");
  }
  const compileProfile = asRecord(input.compiler.compile_profile, "manifest.compiler.compile_profile");
  const artifactBytes: Record<string, string> = {
    "view.json": canonicalJson(input.view),
    "view.md": input.viewMd,
    "diagnostics.json": canonicalJson(input.diagnostics),
    "parity.json": canonicalJson(input.parity),
  };
  const artifactRows = PROPOSITION_POLICY_STABLE_VIEW_COMPILER_ARTIFACT_NAMES.map((name) => artifactRow(name, artifactBytes[name]!));
  const compilerManifestBase = buildPropositionPolicyStableViewCompilerManifestBase({
    compileKey: String(input.compiler.compile_key),
    sourceBundleHash: String(input.projection.bundle_hash),
    compileProfileHash: String(compileProfile.profile_hash),
    decisionIdentity: String(input.compiler.decision_identity),
    fixtureSynthetic: false,
    resultKind,
    artifactRows,
    sourceClosure: input.sourceClosure,
  });
  const expectedManifestHash = stableViewJcsSha256Hex(compilerManifestBase);
  const expectedManifestRaw = canonicalJson({ ...compilerManifestBase, manifest_hash: expectedManifestHash });
  if (input.compiler.compiler_output_manifest_hash !== expectedManifestHash
    || input.compiler.compiler_output_manifest_raw_sha256 !== stableViewSha256Hex(expectedManifestRaw)) {
    fail("COMPILER_MANIFEST_BINDING_INVALID", "published compiler manifest hashes do not bind the reconstructable deterministic compiler manifest");
  }
}

function assertPublicationAcceptanceEnvelope(bundle: PropositionPolicyStableViewMvpBundle): void {
  const artifacts = bundle.artifacts as Readonly<Record<string, unknown>>;
  let totalBytes = 0;
  for (const name of ARTIFACT_NAMES) {
    const raw = artifacts[name];
    if (typeof raw !== "string") fail("PUBLICATION_ARTIFACT_INVALID", "publication artifact is not exact UTF-8 text", { name });
    const bytes = Buffer.byteLength(raw);
    if (bytes > PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES) {
      fail("PUBLICATION_ARTIFACT_OVERSIZE", "publication artifact exceeds the reader absolute hard limit", {
        name,
        bytes,
        limit: PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES,
      });
    }
    totalBytes += bytes;
  }
  if (totalBytes > PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES) {
    fail("PUBLICATION_BUNDLE_OVERSIZE", "publication all-five set exceeds the reader absolute hard limit", {
      bytes: totalBytes,
      limit: PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES,
    });
  }
  const manifest = asRecord(bundle.manifest, "bundle.manifest");
  const canonicalSource = asRecord(manifest.canonical_source, "bundle.manifest.canonical_source");
  const inputIds = asArray(canonicalSource.input_event_ids, "bundle.manifest.canonical_source.input_event_ids");
  if (inputIds.length > PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS) {
    fail("PUBLICATION_CANONICAL_INPUT_LIMIT", "publication canonical input count exceeds the reader absolute hard limit", {
      count: inputIds.length,
      limit: PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS,
    });
  }
}

function materializeBundle(options: {
  mode: StableViewPublicationMode;
  targetAbrainHome: string;
  bundle: PropositionPolicyStableViewMvpBundle;
}): PropositionPolicyStableViewPublicationResult {
  assertPublicationAcceptanceEnvelope(options.bundle);
  validatePropositionPolicyStableViewBundle(options.bundle);
  const targetRoot = path.join(options.targetAbrainHome, ...PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
  ensureDirectoryChainNoSymlink(options.targetAbrainHome, targetRoot);
  const allowedRootEntries = new Set(["bundles", "latest"]);
  for (const name of fs.readdirSync(targetRoot)) {
    if (!allowedRootEntries.has(name)) fail("PUBLICATION_FOREIGN_STATE", "stable-view root contains a foreign entry", { name });
  }
  const bundlesRoot = path.join(targetRoot, "bundles");
  ensureDirectoryChainNoSymlink(options.targetAbrainHome, bundlesRoot);
  for (const name of fs.readdirSync(bundlesRoot)) {
    if (!SHA256_PATTERN.test(name)) fail("PUBLICATION_FOREIGN_STATE", "bundles root contains a non-content-addressed entry", { name });
    assertExactDirectory(path.join(bundlesRoot, name), "existing content-addressed bundle");
  }
  const bundleDir = path.join(bundlesRoot, options.bundle.bundle_hash);
  const existing = lstatIfPresent(bundleDir);
  let status: "created" | "identical";
  if (existing) {
    assertExactPublishedBundle(bundleDir, options.bundle.artifacts);
    status = "identical";
  } else {
    const stagingRoot = path.join(targetRoot, `.staging-${options.bundle.bundle_hash}-${process.pid}-${randomBytes(8).toString("hex")}`);
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    try {
      for (const name of ARTIFACT_NAMES) writeExclusiveFile(path.join(stagingRoot, name), options.bundle.artifacts[name]);
      fsyncDirectory(stagingRoot);
      try {
        fs.mkdirSync(bundleDir, { mode: 0o700 });
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      const names = fs.readdirSync(bundleDir);
      if (names.length !== 0) {
        assertExactPublishedBundle(bundleDir, options.bundle.artifacts);
      } else {
        for (const name of ARTIFACT_NAMES) {
          try {
            fs.linkSync(path.join(stagingRoot, name), path.join(bundleDir, name));
          } catch (error) {
            if (!isCode(error, "EEXIST")) throw error;
            const actual = readExactRegularFile(path.join(bundleDir, name), Number.MAX_SAFE_INTEGER);
            if (actual !== options.bundle.artifacts[name]) fail("PUBLICATION_COLLISION", "no-replace artifact collision", { name });
          }
        }
        fsyncDirectory(bundleDir);
        fsyncDirectory(bundlesRoot);
        assertExactPublishedBundle(bundleDir, options.bundle.artifacts);
      }
      status = "created";
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fsyncDirectory(targetRoot);
    }
  }

  const latest = path.join(targetRoot, "latest");
  const latestValue = `bundles/${options.bundle.bundle_hash}`;
  const latestStat = lstatIfPresent(latest);
  if (!latestStat) {
    fs.symlinkSync(latestValue, latest, "dir");
    fsyncDirectory(targetRoot);
  } else {
    if (!latestStat.isSymbolicLink()) fail("PUBLICATION_LATEST_UNSAFE", "latest exists as a non-symlink");
    const current = fs.readlinkSync(latest);
    if (!/^bundles\/[0-9a-f]{64}$/.test(current) || path.isAbsolute(current) || current.includes("..")) {
      fail("PUBLICATION_LATEST_UNSAFE", "latest is not a direct relative content-addressed symlink", { current });
    }
    if (current !== latestValue || options.mode === "production") {
      const temporary = path.join(targetRoot, `.latest-${process.pid}-${randomBytes(8).toString("hex")}`);
      fs.symlinkSync(latestValue, temporary, "dir");
      try { fs.renameSync(temporary, latest); } finally { fs.rmSync(temporary, { force: true }); }
      fsyncDirectory(targetRoot);
    }
  }
  assertExactLatest(latest, latestValue);
  assertExactPublishedBundle(bundleDir, options.bundle.artifacts);
  const view = JSON.parse(options.bundle.artifacts["view.json"]) as Record<string, unknown>;
  const artifactRows = ARTIFACT_NAMES.map((name) => artifactRow(name, options.bundle.artifacts[name]));
  return deepFreeze({
    mode: options.mode,
    status,
    bundle_hash: options.bundle.bundle_hash,
    target_root: targetRoot,
    bundle_directory: bundleDir,
    latest_symlink: latest,
    latest_value: latestValue,
    source_counts: {
      input_events: options.bundle.source_bundle.manifest.source.input_event_ids.length,
      candidates: options.bundle.source_bundle.manifest.result.entry_count,
      exclusions: options.bundle.source_bundle.manifest.result.exclusion_count,
      diagnostics: options.bundle.source_bundle.manifest.result.diagnostic_count,
    },
    stable_item_count: asArray(view.items, "view.items").length,
    view_utf8_bytes: Buffer.byteLength(options.bundle.artifacts["view.md"]),
    artifact_rows: artifactRows,
  });
}

function readCanonicalL1Rows(abrainHome: string, eventIds: readonly string[]): readonly Readonly<Record<string, unknown>>[] {
  return deepFreeze(eventIds.map((eventId) => {
    const file = expectedL1EventPath(abrainHome, eventId);
    const raw = readExactRegularFile(file, 16 * 1024 * 1024);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { fail("L1_RAW_INVALID", "canonical L1 event is not JSON", { eventId }); }
    if (parsed.event_id !== eventId || canonicalL1EnvelopeJson(parsed) !== raw) {
      fail("L1_RAW_NONCANONICAL", "canonical L1 event bytes are not exact JCS plus LF", { eventId });
    }
    return {
      event_id: eventId,
      relative_path: path.relative(abrainHome, file).split(path.sep).join("/"),
      bytes: Buffer.byteLength(raw),
      raw_sha256: stableViewSha256Hex(raw),
    };
  }));
}

function buildProductionPublicationBinding(bundle: PropositionPolicyStableViewMvpBundle) {
  const bundlesRoot = path.join(PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET, "bundles");
  const bundleDirectory = path.join(bundlesRoot, bundle.bundle_hash);
  const latestSymlink = path.join(PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET, "latest");
  const latestValue = `bundles/${bundle.bundle_hash}`;
  const sourceProjectionBundleHash = bundle.source_bundle.manifest.bundle_hash;
  assertSha256(sourceProjectionBundleHash, "source projection bundle hash");
  const base = deepFreeze({
    schema_version: "proposition-policy-stable-view-production-binding/v1",
    previewed_bundle_hash: bundle.bundle_hash,
    source_projection_bundle_hash: sourceProjectionBundleHash,
    source_abrain_home: PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_ABRAIN_HOME,
    target_root: PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET,
    bundle_directory: bundleDirectory,
    latest_symlink: latestSymlink,
    latest_value: latestValue,
    mutation_inventory: {
      durable_rows: [
        { path: PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET, kind: "directory", operation: "ensure_exact" },
        { path: bundlesRoot, kind: "directory", operation: "ensure_exact" },
        { path: bundleDirectory, kind: "directory", operation: "create_if_absent_or_verify_exact" },
        ...ARTIFACT_NAMES.map((name) => ({
          path: path.join(bundleDirectory, name),
          kind: "file",
          operation: "create_if_absent_or_verify_exact",
          bytes: Buffer.byteLength(bundle.artifacts[name]),
          sha256: stableViewSha256Hex(bundle.artifacts[name]),
        })),
        { path: latestSymlink, kind: "symlink", operation: "create_or_atomic_replace", symlink_value: latestValue },
      ],
      transient_parent: PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET,
      transient_prefixes: [`.staging-${bundle.bundle_hash}-`, ".latest-"],
      cleanup_required: true,
    },
  });
  return deepFreeze({ ...base, binding_hash: stableViewJcsSha256Hex(base) });
}

function validateProductionPublicationBinding(
  binding: ReturnType<typeof buildProductionPublicationBinding>,
  bundle: PropositionPolicyStableViewMvpBundle,
): void {
  const expected = buildProductionPublicationBinding(bundle);
  if (stableViewCanonicalizeJcs(binding) !== stableViewCanonicalizeJcs(expected)) {
    fail("PRODUCTION_BINDING_INVALID", "internally derived production bundle, source projection, paths, or mutation inventory changed");
  }
}

function validateProductionPublicationResult(
  binding: ReturnType<typeof buildProductionPublicationBinding>,
  result: PropositionPolicyStableViewPublicationResult,
): void {
  const expectedArtifactRows = (binding.mutation_inventory.durable_rows as readonly Readonly<Record<string, unknown>>[])
    .filter((row) => row.kind === "file")
    .map((row) => ({ name: path.basename(String(row.path)), bytes: row.bytes, sha256: row.sha256 }));
  if (result.mode !== "production"
    || result.bundle_hash !== binding.previewed_bundle_hash
    || result.target_root !== binding.target_root
    || result.bundle_directory !== binding.bundle_directory
    || result.latest_symlink !== binding.latest_symlink
    || result.latest_value !== binding.latest_value
    || stableViewCanonicalizeJcs(result.artifact_rows) !== stableViewCanonicalizeJcs(expectedArtifactRows)) {
    fail("PRODUCTION_BINDING_INVALID", "production result differs from the internally derived preview and mutation inventory binding");
  }
}

function verifyProductionAuthorizationCandidate(eventValue: unknown, nowMs: number, latestRoleUser: boolean): void {
  const event = asRecordOptional(eventValue);
  const message = asRecordOptional(event?.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const textPart = content.length === 1 ? asRecordOptional(content[0]) : undefined;
  const exactTextPart = textPart
    && stableViewCanonicalizeJcs(Object.keys(textPart).sort(compareCodeUnits)) === stableViewCanonicalizeJcs(["text", "type"]);
  if (!latestRoleUser || event?.type !== "message" || message?.role !== "user" || !exactTextPart
    || textPart?.type !== "text" || textPart.text !== PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_TEXT) {
    fail("NOT_AUTHORIZED", "latest role=user message is not the standalone exact short production authorization");
  }
  const timestampMs = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
  const ageMs = nowMs - timestampMs;
  if (!Number.isFinite(timestampMs) || !Number.isFinite(ageMs)
    || ageMs < -AUTHORIZATION_FUTURE_TOLERANCE_MS
    || ageMs > PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_MAX_AGE_MS) {
    fail("NOT_AUTHORIZED", "latest exact role=user production authorization is not fresh");
  }
}

function verifyProductionAuthorization(transcriptPath: string, nowMs: number): void {
  const sessionsRoot = assertExactDirectory(PRODUCTION_SESSION_ROOT, "production session root");
  const resolvedTranscript = path.resolve(transcriptPath);
  if (!pathInside(sessionsRoot, resolvedTranscript) || resolvedTranscript === sessionsRoot || !resolvedTranscript.endsWith(".jsonl")) {
    fail("NOT_AUTHORIZED", "production authorization transcript must be a persisted JSONL below the fixed pi sessions root");
  }
  const raw = readExactRegularFile(resolvedTranscript, 16 * 1024 * 1024);
  const events = raw.trimEnd().split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { fail("NOT_AUTHORIZED", "authorization transcript contains invalid JSON", { line: index + 1 }); }
  });
  const latestRoleUser = events.filter((event) => event.type === "message" && asRecordOptional(event.message)?.role === "user").at(-1);
  if (!latestRoleUser) fail("NOT_AUTHORIZED", "production authorization transcript has no role=user message");
  verifyProductionAuthorizationCandidate(latestRoleUser, nowMs, true);
}

function assertExactPublishedBundle(bundleDir: string, expected: Readonly<Record<ArtifactName, string>>): void {
  assertExactDirectory(bundleDir, "stable-view bundle directory");
  const names = fs.readdirSync(bundleDir).sort(compareCodeUnits);
  const wanted = [...ARTIFACT_NAMES].sort(compareCodeUnits);
  if (stableViewCanonicalizeJcs(names) !== stableViewCanonicalizeJcs(wanted)) {
    fail("PUBLICATION_PARTIAL_OR_FOREIGN", "stable-view bundle is not exact all-five", { names });
  }
  for (const name of ARTIFACT_NAMES) {
    const actual = readExactRegularFile(path.join(bundleDir, name), Number.MAX_SAFE_INTEGER);
    if (actual !== expected[name]) fail("PUBLICATION_COLLISION", "existing content-addressed bundle bytes differ", { name });
  }
}

function assertExactLatest(latest: string, expected: string): void {
  const stat = fs.lstatSync(latest);
  if (!stat.isSymbolicLink() || fs.readlinkSync(latest) !== expected) {
    fail("PUBLICATION_LATEST_UNSAFE", "latest symlink differs from the exact relative bundle reference");
  }
}

function ensureDirectoryChainNoSymlink(rootInput: string, targetInput: string): void {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  if (!pathInside(root, target)) fail("PUBLICATION_PATH_ESCAPE", "publication path escapes sandbox/production abrain root");
  assertExactDirectory(root, "publication abrain root");
  let current = root;
  const relative = path.relative(root, target);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) fs.mkdirSync(current, { mode: 0o700 });
    assertExactDirectory(current, "publication directory chain");
  }
}

function assertSandboxDirectory(input: string): string {
  const resolved = assertExactDirectory(input, "sandbox abrain home");
  const temp = fs.realpathSync(os.tmpdir());
  if (resolved === temp || !pathInside(temp, resolved)) fail("SANDBOX_REQUIRED", "preview target must be below the real system temp root");
  return resolved;
}

function assertExactDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  assertAncestorDirectoriesNoSymlink(resolved);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) {
    fail("UNSAFE_DIRECTORY", `${label} must be an exact non-symlink directory`, { resolved });
  }
  return resolved;
}

function assertAncestorDirectoriesNoSymlink(input: string): void {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("UNSAFE_ANCESTOR", "path ancestor is a symlink or non-directory", { current });
  }
}

function readExactRegularFile(file: string, maxBytes: number): string {
  assertAncestorDirectoriesNoSymlink(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== path.resolve(file)) fail("UNSAFE_FILE", "path is not an exact regular file", { file });
  if (stat.size > maxBytes) fail("FILE_OVERSIZE", "file exceeds bounded read budget", { file, bytes: stat.size, maxBytes });
  return fs.readFileSync(file, "utf8");
}

function readCanonicalJsonFile(file: string, label: string): { raw: string; parsed: unknown; raw_sha256: string } {
  const raw = readExactRegularFile(file, 16 * 1024 * 1024);
  const parsed = parseCanonicalJson(raw, label);
  return { raw, parsed, raw_sha256: stableViewSha256Hex(raw) };
}

function parseCanonicalJson(raw: string, label: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("JSON_INVALID", `${label} is not valid JSON`); }
  if (`${stableViewCanonicalizeJcs(parsed)}\n` !== raw) fail("JCS_INVALID", `${label} is not exact RFC8785-JCS plus LF`);
  return parsed;
}

function writeExclusiveFile(file: string, content: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function artifactRow<T extends ArtifactName>(name: T, raw: string): Readonly<{ name: T; bytes: number; sha256: string }> {
  return deepFreeze({ name, bytes: Buffer.byteLength(raw), sha256: stableViewSha256Hex(raw) });
}

function canonicalJson(value: unknown): string {
  return `${stableViewCanonicalizeJcs(value)}\n`;
}

function stableViewJcsSha256Hex(value: unknown): string {
  return stableViewSha256Hex(stableViewCanonicalizeJcs(value));
}

function sameBundleBytes(left: PropositionPolicyPushBundle, right: PropositionPolicyPushBundle): boolean {
  return ["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"].every((name) => (
    left.bytes[name as keyof PropositionPolicyPushBundle["bytes"]] === right.bytes[name as keyof PropositionPolicyPushBundle["bytes"]]
  ));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("OBJECT_KEYS_INVALID", `${at} has unexpected keys`, { actual, wanted });
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  const record = asRecordOptional(value);
  if (!record) fail("OBJECT_EXPECTED", `${at} must be an object`);
  return record;
}

function asRecordOptional(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("ARRAY_EXPECTED", `${at} must be an array`);
  return value;
}

function assertSha256(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("SHA256_INVALID", `${at} must be lowercase SHA-256`);
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function lstatIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepClone<T>(value: T): T {
  return JSON.parse(stableViewCanonicalizeJcs(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const __TEST = Object.freeze({ materializeBundle, verifyProductionAuthorizationCandidate });

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyStableViewPublisherError(code, message, detail);
}
