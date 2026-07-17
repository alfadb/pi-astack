import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { fsyncDirectory } from "./durable-write";
import {
  defaultL1SchemaRegistryPath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1WritePreflight,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import {
  PROPOSITION_EVIDENCE_BODY_SCHEMA,
  PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  validatePropositionEvidenceBody,
  type PropositionFacets,
  type PropositionModality,
} from "./proposition";
import {
  prepareFixedProductionPropositionGenesisTuple,
  summarizePropositionGenesisScan,
} from "./proposition-genesis-writer";
import {
  PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX,
  resolvePropositionLifecycleEffectiveState,
  type PropositionEffectiveDisposition,
  type ResolvedPropositionState,
} from "./proposition-lifecycle-resolver";

export const PROPOSITION_KNOWLEDGE_SHADOW_MANIFEST_SCHEMA = "proposition-knowledge-pull-shadow-manifest/v1" as const;
export const PROPOSITION_KNOWLEDGE_SHADOW_CARDS_SCHEMA = "proposition-knowledge-pull-shadow-cards/v1" as const;
export const PROPOSITION_KNOWLEDGE_SHADOW_EXCLUSIONS_SCHEMA = "proposition-knowledge-pull-shadow-exclusions/v1" as const;
export const PROPOSITION_KNOWLEDGE_SHADOW_DIAGNOSTICS_SCHEMA = "proposition-knowledge-pull-shadow-diagnostics/v1" as const;
export const PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_SCHEMA = "proposition-knowledge-pull-shadow-p1a-dossier/v2" as const;
export const PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE = ".state/sediment/proposition-knowledge-shadow/v1" as const;
export const PROPOSITION_KNOWLEDGE_SHADOW_PRODUCTION_REASON = "genesis_only_no_post_genesis_propositions" as const;

const PROJECTION_ENVELOPE_SCHEMA = "proposition-projection-envelope/v1";
const BUNDLE_IDENTITY_SCHEMA = "proposition-knowledge-pull-shadow-bundle-identity/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_NAMES = Object.freeze(["cards.json", "diagnostics.json", "exclusions.json"] as const);
const ALL_BUNDLE_NAMES = Object.freeze(["cards.json", "diagnostics.json", "exclusions.json", "manifest.json"] as const);
const FORBIDDEN_DERIVED_KEYS = new Set(["injectmode", "priority", "always", "listed", "policyeligibility", "sessionstarteligibility"]);
const EXCLUSION_REASON_VALUES = Object.freeze([
  "lifecycle_archived",
  "lifecycle_retracted",
  "lifecycle_superseded",
  "meta_lifecycle_not_searchable",
  "unresolved_scope",
  "temporal_context_required",
  "unresolved_temporal_horizon",
  "sensitivity_secret",
  "sensitivity_secret_adjacent",
  "sensitivity_withhold",
  "unsupported_redaction",
  "unresolved_sensitivity",
  "contestability_contested",
  "contestability_requires_review",
  "contestability_unresolved",
] as const);

export type PropositionKnowledgeShadowExclusionReason =
  | "lifecycle_archived"
  | "lifecycle_retracted"
  | "lifecycle_superseded"
  | "meta_lifecycle_not_searchable"
  | "unresolved_scope"
  | "temporal_context_required"
  | "unresolved_temporal_horizon"
  | "sensitivity_secret"
  | "sensitivity_secret_adjacent"
  | "sensitivity_withhold"
  | "unsupported_redaction"
  | "unresolved_sensitivity"
  | "contestability_contested"
  | "contestability_requires_review"
  | "contestability_unresolved";

export interface PropositionKnowledgeShadowCard {
  card_schema_version: "proposition-knowledge-pull-shadow-card/v1";
  card_id: string;
  source_event_id: string;
  source_epoch: {
    epoch_id: string;
    genesis_event_id: string;
  };
  statement: string;
  modality: PropositionModality;
  language: string;
  original_facets: PropositionFacets;
  effective_facets: PropositionFacets;
  scope: PropositionFacets["spatial_scope"];
  lifecycle: {
    disposition: "active";
    activation: "original" | "reactivated";
    lineage_event_ids: readonly string[];
    lineage: ResolvedPropositionState["lifecycle_lineage"];
    terminal_event_id: string;
  };
}

export interface PropositionKnowledgeShadowExclusion {
  source_event_id: string;
  modality: PropositionModality;
  lifecycle_disposition: PropositionEffectiveDisposition;
  reason_codes: readonly PropositionKnowledgeShadowExclusionReason[];
}

export interface PropositionKnowledgeShadowDiagnostic {
  code: PropositionKnowledgeShadowExclusionReason;
  severity: "excluded";
  disposition: "not_searchable";
  source_event_ids: readonly string[];
}

export interface PropositionKnowledgeShadowArtifactRow {
  name: typeof ARTIFACT_NAMES[number];
  sha256: string;
  bytes: number;
}

export interface PropositionKnowledgeShadowManifest {
  schema_version: typeof PROPOSITION_KNOWLEDGE_SHADOW_MANIFEST_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  authority: "shadow_pull_only_no_runtime_consumer";
  projection_envelope_contract: {
    envelope_schema: "proposition-projection-envelope/v1";
    phase: "phase_disabled";
    body_schema: null;
    write_enabled: false;
    fold_eligible: false;
  };
  epoch: {
    epoch_id: string;
    genesis_event_id: string;
  };
  source: {
    scanner: "scanWholeL1Validated";
    whole_l1: true;
    consumed_classification: "defined-inactive-shadow";
    consumed_envelope_schemas: readonly ["proposition-evidence-envelope/v1", "proposition-genesis-envelope/v1", "proposition-lifecycle-envelope/v1"];
    proposition_event_count: number;
    proposition_genesis_count: number;
    proposition_evidence_count: number;
    proposition_lifecycle_count: number;
    proposition_selected_count: number;
    proposition_foldable_count: number;
    non_proposition_event_consumed_count: 0;
    input_event_ids: readonly string[];
    input_event_ids_hash: string;
    registry_file_sha256: string;
    proposition_contract_file_sha256: string;
  };
  result: {
    card_count: number;
    exclusion_count: number;
    diagnostic_count: number;
    disposition_reason: typeof PROPOSITION_KNOWLEDGE_SHADOW_PRODUCTION_REASON | "post_genesis_propositions_resolved";
  };
  operation_target_matrix: typeof PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX;
  artifacts: readonly PropositionKnowledgeShadowArtifactRow[];
  bundle_hash: string;
}

export interface PropositionKnowledgeShadowBundle {
  manifest: PropositionKnowledgeShadowManifest;
  cards: {
    schema_version: typeof PROPOSITION_KNOWLEDGE_SHADOW_CARDS_SCHEMA;
    epoch_id: string;
    genesis_event_id: string;
    cards: readonly PropositionKnowledgeShadowCard[];
  };
  exclusions: {
    schema_version: typeof PROPOSITION_KNOWLEDGE_SHADOW_EXCLUSIONS_SCHEMA;
    epoch_id: string;
    genesis_event_id: string;
    exclusions: readonly PropositionKnowledgeShadowExclusion[];
  };
  diagnostics: {
    schema_version: typeof PROPOSITION_KNOWLEDGE_SHADOW_DIAGNOSTICS_SCHEMA;
    epoch_id: string;
    genesis_event_id: string;
    diagnostics: readonly PropositionKnowledgeShadowDiagnostic[];
  };
  bytes: Readonly<Record<typeof ALL_BUNDLE_NAMES[number], string>>;
}

export interface PropositionKnowledgeShadowPublishResult {
  root: string;
  bundle_dir: string;
  latest_path: string;
  bundle_status: "created" | "identical";
  latest_status: "published";
  bundle: PropositionKnowledgeShadowBundle;
}

export class PropositionKnowledgeShadowError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionKnowledgeShadowError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionKnowledgeShadow(options: {
  abrainHome: string;
  repoRoot: string;
  registryPath?: string;
}): Promise<PropositionKnowledgeShadowBundle> {
  const abrainHome = path.resolve(options.abrainHome);
  const repoRoot = path.resolve(options.repoRoot);
  const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
  const registry = loadL1SchemaRegistry(registryPath);
  const projectionRegistration = registry.entries.find((entry) => entry.envelope_schema === PROJECTION_ENVELOPE_SCHEMA);
  if (
    !projectionRegistration
    || projectionRegistration.phase !== "phase_disabled"
    || projectionRegistration.body_schema !== undefined
    || projectionRegistration.write_enabled
    || projectionRegistration.fold_eligible
  ) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_REGISTRY_DRIFT", "projection envelope must remain a bodyless phase-disabled placeholder");
  }

  const tuple = await prepareFixedProductionPropositionGenesisTuple({ abrainHome, registryPath });
  const scan = await scanWholeL1Validated({ abrainHome, registry });
  return projectValidatedWholeL1(scan, {
    repoRoot,
    registryPath,
    expectedGenesisEventId: tuple.event_id,
    registryFileSha256: sha256Hex(fs.readFileSync(registryPath)),
  });
}

export async function publishPropositionKnowledgeShadow(options: {
  abrainHome: string;
  repoRoot: string;
  registryPath?: string;
}): Promise<PropositionKnowledgeShadowPublishResult> {
  const abrainHome = path.resolve(options.abrainHome);
  const bundle = await buildPropositionKnowledgeShadow(options);
  const root = path.resolve(abrainHome, ...PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE.split("/"));
  if (!pathInside(abrainHome, root) || root === abrainHome) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_ESCAPE", "shadow root escapes abrain home");
  const bundlesRoot = path.join(root, "bundles");
  await ensureDirectoryChainNoSymlink(abrainHome, bundlesRoot);
  const bundleDir = path.join(bundlesRoot, bundle.manifest.bundle_hash);
  const stageDir = path.join(root, `.bundle-${bundle.manifest.bundle_hash}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let bundleStatus: PropositionKnowledgeShadowPublishResult["bundle_status"] = "created";

  const existing = await lstatIfPresent(bundleDir);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_COLLISION", "existing bundle path is not a regular directory", { bundleDir });
    await assertBundleDirectoryBytes(bundleDir, bundle.bytes);
    bundleStatus = "identical";
  } else {
    await fsp.rm(stageDir, { recursive: true, force: true });
    await fsp.mkdir(stageDir, { mode: 0o700 });
    try {
      for (const name of ALL_BUNDLE_NAMES) await writeSyncedExclusive(path.join(stageDir, name), bundle.bytes[name]);
      await fsyncDirectory(stageDir);
      try {
        await fsp.rename(stageDir, bundleDir);
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        await assertBundleDirectoryBytes(bundleDir, bundle.bytes);
        bundleStatus = "identical";
      }
      await fsyncDirectory(bundlesRoot);
    } finally {
      await fsp.rm(stageDir, { recursive: true, force: true });
    }
  }

  const latestPath = path.join(root, "latest");
  const existingLatest = await lstatIfPresent(latestPath);
  if (existingLatest && !existingLatest.isSymbolicLink()) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_LATEST_UNSAFE", "latest must be absent or an atomically replaceable symlink", { latestPath });
  }
  const latestTmp = path.join(root, `.latest.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  await fsp.rm(latestTmp, { force: true });
  try {
    await fsp.symlink(`bundles/${bundle.manifest.bundle_hash}`, latestTmp, "dir");
    await fsp.rename(latestTmp, latestPath);
    await fsyncDirectory(root);
  } finally {
    await fsp.rm(latestTmp, { force: true });
  }
  await readLatestPropositionKnowledgeShadow({ abrainHome });
  return deepFreeze({ root, bundle_dir: bundleDir, latest_path: latestPath, bundle_status: bundleStatus, latest_status: "published", bundle });
}

export async function readLatestPropositionKnowledgeShadow(options: { abrainHome: string }): Promise<PropositionKnowledgeShadowBundle> {
  const abrainHome = path.resolve(options.abrainHome);
  await assertExistingDirectoryChainNoSymlink(path.parse(abrainHome).root, abrainHome);
  const abrainReal = await fsp.realpath(abrainHome);
  if (abrainReal !== abrainHome) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "abrain home must resolve without ancestor symlinks", { abrainHome, abrainReal });

  const root = path.resolve(abrainHome, ...PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE.split("/"));
  const bundlesRoot = path.join(root, "bundles");
  await assertExistingDirectoryChainNoSymlink(abrainHome, bundlesRoot);
  const rootReal = await fsp.realpath(root);
  const bundlesReal = await fsp.realpath(bundlesRoot);
  if (rootReal !== root || bundlesReal !== bundlesRoot || path.dirname(bundlesReal) !== rootReal) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "shadow root and bundles directory must resolve exactly without symlinks", { root, rootReal, bundlesRoot, bundlesReal });
  }

  const latest = path.join(root, "latest");
  const stat = await fsp.lstat(latest);
  if (!stat.isSymbolicLink()) fail("PROPOSITION_KNOWLEDGE_SHADOW_LATEST_UNSAFE", "latest pointer must be a symlink");
  const target = await fsp.readlink(latest);
  const match = /^bundles\/([0-9a-f]{64})$/.exec(target);
  if (!match) fail("PROPOSITION_KNOWLEDGE_SHADOW_LATEST_UNSAFE", "latest pointer target is not a deterministic bundle id", { target });
  const pointerBundleHash = match[1]!;
  const bundleDir = path.resolve(root, ...target.split("/"));
  if (!pathInside(bundlesRoot, bundleDir) || path.dirname(bundleDir) !== bundlesRoot || path.basename(bundleDir) !== pointerBundleHash) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_ESCAPE", "latest pointer does not name a direct deterministic bundle directory", { target, bundleDir, bundlesRoot });
  }
  await assertExistingDirectoryChainNoSymlink(abrainHome, bundleDir);
  const bundleReal = await fsp.realpath(bundleDir);
  if (bundleReal !== bundleDir || path.dirname(bundleReal) !== bundlesReal) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_UNSAFE", "bundle directory realpath or ancestor chain is unsafe", { bundleDir, bundleReal, bundlesReal });
  }
  const bundle = await readBundleDirectory(bundleDir);
  if (bundle.manifest.bundle_hash !== pointerBundleHash || path.basename(bundleReal) !== bundle.manifest.bundle_hash) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_ID_MISMATCH", "latest bundle directory name must equal the validated manifest bundle_hash", {
      pointerBundleHash,
      directoryBasename: path.basename(bundleReal),
      manifestBundleHash: bundle.manifest.bundle_hash,
    });
  }
  return bundle;
}

export async function runPropositionKnowledgeShadowP1a(options: {
  abrainHome: string;
  repoRoot: string;
  registryPath?: string;
  runtimeConfigPath?: string;
  dossierOutput?: { repoRelativePath: string };
}): Promise<{ publication: PropositionKnowledgeShadowPublishResult; dossier: Readonly<Record<string, unknown>> }> {
  const abrainHome = path.resolve(options.abrainHome);
  const repoRoot = path.resolve(options.repoRoot);
  const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
  const shadowRoot = path.resolve(abrainHome, ...PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE.split("/"));
  await assertExistingDirectoryChainNoSymlink(abrainHome, path.dirname(shadowRoot));
  const beforeProtectedAbrain = await captureFullProtectedAbrainSnapshot({ abrainHome, shadowRoot });
  const beforeProtected = await captureProtectedSnapshot({ abrainHome, repoRoot, registryPath, runtimeConfigPath: options.runtimeConfigPath });
  const beforeShadow = await inventoryTree(shadowRoot, { allowSymlinks: true });
  const publication = await publishPropositionKnowledgeShadow({ abrainHome, repoRoot, registryPath });
  const afterShadow = await inventoryTree(shadowRoot, { allowSymlinks: true });
  const afterProtected = await captureProtectedSnapshot({ abrainHome, repoRoot, registryPath, runtimeConfigPath: options.runtimeConfigPath });
  const afterProtectedAbrain = await captureFullProtectedAbrainSnapshot({ abrainHome, shadowRoot });
  const afterScan = await scanWholeL1Validated({ abrainHome, registry: loadL1SchemaRegistry(registryPath) });
  const summary = summarizePropositionGenesisScan(afterScan);
  const tuple = await prepareFixedProductionPropositionGenesisTuple({ abrainHome, registryPath });
  const genericGate = await genericWriteGateCode({ abrainHome, registryPath, tuple });
  const shadowMutationInventory = diffInventory(beforeShadow.rows, afterShadow.rows);
  assertAllowedShadowMutationInventory(shadowMutationInventory, publication.bundle.manifest.bundle_hash);
  const fullProtectedAbrainUnchanged = beforeProtectedAbrain.snapshot_hash === afterProtectedAbrain.snapshot_hash;
  const protectedUnchanged = beforeProtected.snapshot_hash === afterProtected.snapshot_hash;
  const contractBytesUnchanged = beforeProtected.contract_files_hash === afterProtected.contract_files_hash;
  const sourceStateAccepted = summary.propositionTotal === 1
    && summary.productionGenesis === 1
    && summary.propositionEvidence === 0
    && summary.propositionLifecycle === 0
    && summary.propositionProjection === 0
    && summary.propositionSelected === 0
    && summary.propositionFoldable === 0;
  const outputAccepted = publication.bundle.manifest.result.card_count === 0
    && publication.bundle.manifest.result.disposition_reason === PROPOSITION_KNOWLEDGE_SHADOW_PRODUCTION_REASON;
  const assertions = {
    full_abrain_outside_shadow_unchanged: fullProtectedAbrainUnchanged,
    protected_surfaces_unchanged: protectedUnchanged,
    registry_and_proposition_contract_bytes_unchanged: contractBytesUnchanged,
    only_shadow_prefix_changed: fullProtectedAbrainUnchanged,
    production_proposition_source_is_genesis_only: sourceStateAccepted,
    production_cards_zero_for_genesis_only_source: outputAccepted,
    proposition_selected_zero: summary.propositionSelected === 0,
    proposition_foldable_zero: summary.propositionFoldable === 0,
    generic_write_gate_disabled: genericGate === "L1_SCHEMA_WRITE_DISABLED",
    projection_envelope_phase_disabled: publication.bundle.manifest.projection_envelope_contract.phase === "phase_disabled",
    no_runtime_consumer: publication.bundle.manifest.authority === "shadow_pull_only_no_runtime_consumer",
  };
  if (Object.values(assertions).some((value) => value !== true)) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_PRODUCTION_ASSERTION_FAILED", "P1a production shadow assertions did not all pass", { assertions });
  }

  const repoEvidenceWrite = {
    requested: options.dossierOutput !== undefined,
    mutation_domain: "repo_evidence_outside_abrain",
    included_in_abrain_mutation_claim: false,
    repo_relative_path: options.dossierOutput?.repoRelativePath ?? null,
    output_policy: options.dossierOutput
      ? "validated_repo_docs_evidence_direct_json_absent_or_exact_identical_only"
      : "not_requested",
    write_sequence: options.dossierOutput
      ? "after_abrain_after_snapshot_and_dossier_finalization"
      : "not_applicable",
    actual_write_status_evidence: options.dossierOutput
      ? "emitted_in_cli_stdout_after_durable_create_and_readback"
      : "not_applicable",
  };
  const mutationInventory = {
    claim_scope: "all_abrain_entries_before_after",
    protected_scope: {
      description: "all abrain entries excluding only the exact proposition Knowledge shadow prefix",
      excluded_relative_prefix: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
      before: beforeProtectedAbrain,
      after: afterProtectedAbrain,
      unchanged: fullProtectedAbrainUnchanged,
    },
    shadow_scope: {
      relative_prefix: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
      before_inventory_hash: beforeShadow.hash,
      after_inventory_hash: afterShadow.hash,
      exact_diff: shadowMutationInventory,
      diff_policy: "immutable bundle create or identical reuse; latest symlink create or replace; no removal or bundle modification",
      allowed: true,
    },
    repo_evidence_write: repoEvidenceWrite,
  };
  const dossierBase = {
    schema_version: PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted",
    authorization: {
      phase: "ADR0040-P1a",
      status: "completed_authorized",
      scope: "knowledge_pull_shadow_foundation_only",
      next_phases: "separately_authorized",
    },
    source: {
      epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
      genesis_event_id: tuple.event_id,
      proposition_count: summary.propositionTotal,
      production_genesis_count: summary.productionGenesis,
      evidence_count: summary.propositionEvidence,
      lifecycle_count: summary.propositionLifecycle,
      projection_count: summary.propositionProjection,
      selected_count: summary.propositionSelected,
      foldable_count: summary.propositionFoldable,
      generic_write_gate: genericGate,
    },
    shadow: {
      root_relative_path: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
      latest_pointer: `${PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE}/latest`,
      bundle_hash: publication.bundle.manifest.bundle_hash,
      manifest_exact_bytes_sha256: sha256Hex(publication.bundle.bytes["manifest.json"]),
      artifact_rows: publication.bundle.manifest.artifacts,
      card_count: publication.bundle.manifest.result.card_count,
      exclusion_count: publication.bundle.manifest.result.exclusion_count,
      diagnostic_count: publication.bundle.manifest.result.diagnostic_count,
      disposition_reason: publication.bundle.manifest.result.disposition_reason,
      bundle_status: publication.bundle_status,
      latest_status: publication.latest_status,
    },
    mutation_inventory: mutationInventory,
    protected_before: beforeProtected,
    protected_after: afterProtected,
    assertions,
  };
  const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) });
  assertNoStatementTextInDossier(dossier);
  return deepFreeze({ publication, dossier });
}

export function canonicalPropositionKnowledgeShadowDossierJson(dossier: Readonly<Record<string, unknown>>): string {
  validateDossierSelfHash(dossier);
  return `${canonicalizeJcs(dossier)}\n`;
}

export function validateDossierSelfHash(dossier: Readonly<Record<string, unknown>>): void {
  const clone = { ...dossier };
  const claimed = clone.dossier_hash;
  delete clone.dossier_hash;
  if (typeof claimed !== "string" || !SHA256_PATTERN.test(claimed) || jcsSha256Hex(clone) !== claimed) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_HASH_INVALID", "dossier self hash mismatch");
  }
  assertNoStatementTextInDossier(dossier);
}

function projectValidatedWholeL1(
  scan: WholeL1ScanResult,
  options: {
    repoRoot: string;
    registryPath: string;
    expectedGenesisEventId: string;
    registryFileSha256: string;
  },
): PropositionKnowledgeShadowBundle {
  const propositionRecords = scan.definedInactiveShadow
    .filter((record) => record.registration.domain === "proposition")
    .sort((left, right) => compareCodeUnits(left.eventId, right.eventId));
  const allPhysicalProposition = scan.all.filter((record) => record.registration.domain === "proposition");
  if (allPhysicalProposition.length !== propositionRecords.length) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_INPUT_CLASS_INVALID", "physical proposition inputs must all be defined-inactive genesis/evidence/lifecycle records", {
      all: allPhysicalProposition.length,
      consumed: propositionRecords.length,
    });
  }
  const resolution = resolvePropositionLifecycleEffectiveState(propositionRecords, {
    expectedEpochId: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    expectedGenesisEventId: options.expectedGenesisEventId,
  });
  const cards: PropositionKnowledgeShadowCard[] = [];
  const exclusions: PropositionKnowledgeShadowExclusion[] = [];
  const diagnostics: PropositionKnowledgeShadowDiagnostic[] = [];

  for (const state of resolution.states) {
    const reasons = exclusionReasons(state);
    if (reasons.length) {
      exclusions.push(deepFreeze({
        source_event_id: state.source_event_id,
        modality: state.proposition.modality,
        lifecycle_disposition: state.disposition,
        reason_codes: Object.freeze(reasons),
      }));
      for (const reason of reasons) {
        diagnostics.push(deepFreeze({ code: reason, severity: "excluded", disposition: "not_searchable", source_event_ids: Object.freeze([state.source_event_id]) }));
      }
      continue;
    }
    cards.push(deepFreeze({
      card_schema_version: "proposition-knowledge-pull-shadow-card/v1",
      card_id: state.source_event_id,
      source_event_id: state.source_event_id,
      source_epoch: { epoch_id: state.epoch_id, genesis_event_id: state.genesis_event_id },
      statement: state.proposition.statement,
      modality: state.proposition.modality,
      language: state.proposition.language,
      original_facets: state.original_facets,
      effective_facets: state.effective_facets,
      scope: state.effective_facets.spatial_scope,
      lifecycle: {
        disposition: "active",
        activation: state.activation,
        lineage_event_ids: state.lifecycle_event_ids,
        lineage: state.lifecycle_lineage,
        terminal_event_id: state.terminal_event_id,
      },
    }));
  }
  cards.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  exclusions.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  diagnostics.sort((left, right) => compareCodeUnits(`${left.code}:${left.source_event_ids[0]}`, `${right.code}:${right.source_event_ids[0]}`));

  const cardsDocument = deepFreeze({
    schema_version: PROPOSITION_KNOWLEDGE_SHADOW_CARDS_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    cards: Object.freeze(cards),
  });
  const exclusionsDocument = deepFreeze({
    schema_version: PROPOSITION_KNOWLEDGE_SHADOW_EXCLUSIONS_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    exclusions: Object.freeze(exclusions),
  });
  const diagnosticsDocument = deepFreeze({
    schema_version: PROPOSITION_KNOWLEDGE_SHADOW_DIAGNOSTICS_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    diagnostics: Object.freeze(diagnostics),
  });
  const artifactBytes = {
    "cards.json": canonicalJson(cardsDocument),
    "diagnostics.json": canonicalJson(diagnosticsDocument),
    "exclusions.json": canonicalJson(exclusionsDocument),
  } as const;
  const artifacts = ARTIFACT_NAMES.map((name): PropositionKnowledgeShadowArtifactRow => ({
    name,
    sha256: sha256Hex(artifactBytes[name]),
    bytes: Buffer.byteLength(artifactBytes[name]),
  }));
  const propositionContractPath = path.join(options.repoRoot, "extensions", "_shared", "proposition.ts");
  const propositionContractFileSha256 = sha256Hex(fs.readFileSync(propositionContractPath));
  const summary = summarizePropositionGenesisScan(scan);
  const inputEventIds = resolution.input_event_ids;
  const resultReason = resolution.evidence_event_ids.length === 0 && resolution.lifecycle_event_ids.length === 0
    ? PROPOSITION_KNOWLEDGE_SHADOW_PRODUCTION_REASON
    : "post_genesis_propositions_resolved" as const;
  const bundleIdentity = {
    schema_version: BUNDLE_IDENTITY_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    input_event_ids: inputEventIds,
    artifacts,
  };
  const manifest: PropositionKnowledgeShadowManifest = deepFreeze({
    schema_version: PROPOSITION_KNOWLEDGE_SHADOW_MANIFEST_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    authority: "shadow_pull_only_no_runtime_consumer",
    projection_envelope_contract: {
      envelope_schema: PROJECTION_ENVELOPE_SCHEMA,
      phase: "phase_disabled",
      body_schema: null,
      write_enabled: false,
      fold_eligible: false,
    },
    epoch: { epoch_id: resolution.epoch_id, genesis_event_id: resolution.genesis_event_id },
    source: {
      scanner: "scanWholeL1Validated",
      whole_l1: true,
      consumed_classification: "defined-inactive-shadow",
      consumed_envelope_schemas: ["proposition-evidence-envelope/v1", "proposition-genesis-envelope/v1", "proposition-lifecycle-envelope/v1"],
      proposition_event_count: propositionRecords.length,
      proposition_genesis_count: summary.propositionGenesis,
      proposition_evidence_count: summary.propositionEvidence,
      proposition_lifecycle_count: summary.propositionLifecycle,
      proposition_selected_count: summary.propositionSelected,
      proposition_foldable_count: summary.propositionFoldable,
      non_proposition_event_consumed_count: 0,
      input_event_ids: inputEventIds,
      input_event_ids_hash: jcsSha256Hex(inputEventIds),
      registry_file_sha256: options.registryFileSha256,
      proposition_contract_file_sha256: propositionContractFileSha256,
    },
    result: {
      card_count: cards.length,
      exclusion_count: exclusions.length,
      diagnostic_count: diagnostics.length,
      disposition_reason: resultReason,
    },
    operation_target_matrix: PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX,
    artifacts: Object.freeze(artifacts),
    bundle_hash: jcsSha256Hex(bundleIdentity),
  });
  const bytes = deepFreeze({ ...artifactBytes, "manifest.json": canonicalJson(manifest) });
  const bundle = deepFreeze({ manifest, cards: cardsDocument, exclusions: exclusionsDocument, diagnostics: diagnosticsDocument, bytes });
  validatePropositionKnowledgeShadowBundle(bundle);
  return bundle;
}

export function validatePropositionKnowledgeShadowBundle(bundle: PropositionKnowledgeShadowBundle): void {
  assertExactKeys(bundle as unknown as Record<string, unknown>, ["manifest", "cards", "exclusions", "diagnostics", "bytes"], "bundle");
  assertExactKeys(bundle.manifest as unknown as Record<string, unknown>, ["schema_version", "canonicalization", "hash_algorithm", "authority", "projection_envelope_contract", "epoch", "source", "result", "operation_target_matrix", "artifacts", "bundle_hash"], "manifest");
  assertExactKeys(bundle.manifest.projection_envelope_contract as unknown as Record<string, unknown>, ["envelope_schema", "phase", "body_schema", "write_enabled", "fold_eligible"], "manifest.projection_envelope_contract");
  assertExactKeys(bundle.manifest.epoch as unknown as Record<string, unknown>, ["epoch_id", "genesis_event_id"], "manifest.epoch");
  assertExactKeys(bundle.manifest.source as unknown as Record<string, unknown>, ["scanner", "whole_l1", "consumed_classification", "consumed_envelope_schemas", "proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "non_proposition_event_consumed_count", "input_event_ids", "input_event_ids_hash", "registry_file_sha256", "proposition_contract_file_sha256"], "manifest.source");
  assertExactKeys(bundle.manifest.result as unknown as Record<string, unknown>, ["card_count", "exclusion_count", "diagnostic_count", "disposition_reason"], "manifest.result");
  assertExactKeys(bundle.cards as unknown as Record<string, unknown>, ["schema_version", "epoch_id", "genesis_event_id", "cards"], "cards");
  assertExactKeys(bundle.exclusions as unknown as Record<string, unknown>, ["schema_version", "epoch_id", "genesis_event_id", "exclusions"], "exclusions");
  assertExactKeys(bundle.diagnostics as unknown as Record<string, unknown>, ["schema_version", "epoch_id", "genesis_event_id", "diagnostics"], "diagnostics");
  assertExactKeys(bundle.bytes as unknown as Record<string, unknown>, ALL_BUNDLE_NAMES, "bytes");
  assertNoForbiddenDerivedKeys(bundle.cards);
  assertNoStatementKey(bundle.manifest, "manifest");
  assertNoStatementKey(bundle.exclusions, "exclusions");
  assertNoStatementKey(bundle.diagnostics, "diagnostics");
  assertExact(bundle.manifest.schema_version, PROPOSITION_KNOWLEDGE_SHADOW_MANIFEST_SCHEMA, "manifest.schema_version");
  assertExact(bundle.manifest.canonicalization, "RFC8785-JCS", "manifest.canonicalization");
  assertExact(bundle.manifest.hash_algorithm, "sha256", "manifest.hash_algorithm");
  assertExact(bundle.manifest.authority, "shadow_pull_only_no_runtime_consumer", "manifest.authority");
  assertExact(bundle.manifest.projection_envelope_contract.envelope_schema, PROJECTION_ENVELOPE_SCHEMA, "manifest.projection_envelope_contract.envelope_schema");
  assertExact(bundle.manifest.projection_envelope_contract.phase, "phase_disabled", "manifest.projection_envelope_contract.phase");
  if (bundle.manifest.projection_envelope_contract.body_schema !== null || bundle.manifest.projection_envelope_contract.write_enabled || bundle.manifest.projection_envelope_contract.fold_eligible) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_SCHEMA_INVALID", "projection envelope placeholder became active or acquired a body schema");
  }
  if (canonicalizeJcs(bundle.manifest.operation_target_matrix) !== canonicalizeJcs(PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX)) fail("PROPOSITION_KNOWLEDGE_SHADOW_SCHEMA_INVALID", "operation/target matrix drifted");
  assertExact(bundle.manifest.source.scanner, "scanWholeL1Validated", "manifest.source.scanner");
  assertExact(bundle.manifest.source.consumed_classification, "defined-inactive-shadow", "manifest.source.consumed_classification");
  if (bundle.manifest.source.whole_l1 !== true || bundle.manifest.source.non_proposition_event_consumed_count !== 0 || bundle.manifest.source.proposition_selected_count !== 0 || bundle.manifest.source.proposition_foldable_count !== 0) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_SOURCE_INVALID", "manifest source boundary drifted");
  }
  const expectedSchemas = ["proposition-evidence-envelope/v1", "proposition-genesis-envelope/v1", "proposition-lifecycle-envelope/v1"];
  if (canonicalizeJcs(bundle.manifest.source.consumed_envelope_schemas) !== canonicalizeJcs(expectedSchemas)) fail("PROPOSITION_KNOWLEDGE_SHADOW_SOURCE_INVALID", "consumed schema set drifted");
  assertSha256(bundle.manifest.source.registry_file_sha256, "manifest.source.registry_file_sha256");
  assertSha256(bundle.manifest.source.proposition_contract_file_sha256, "manifest.source.proposition_contract_file_sha256");
  assertSha256(bundle.manifest.source.input_event_ids_hash, "manifest.source.input_event_ids_hash");
  assertSortedUnique(bundle.manifest.source.input_event_ids, "manifest.source.input_event_ids");
  if (jcsSha256Hex(bundle.manifest.source.input_event_ids) !== bundle.manifest.source.input_event_ids_hash) fail("PROPOSITION_KNOWLEDGE_SHADOW_HASH_INVALID", "input event id set hash mismatch");
  if (bundle.manifest.source.proposition_event_count !== bundle.manifest.source.input_event_ids.length || bundle.manifest.source.proposition_event_count !== bundle.manifest.source.proposition_genesis_count + bundle.manifest.source.proposition_evidence_count + bundle.manifest.source.proposition_lifecycle_count) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_COUNT_INVALID", "source proposition counts are inconsistent");
  }
  assertExact(bundle.cards.schema_version, PROPOSITION_KNOWLEDGE_SHADOW_CARDS_SCHEMA, "cards.schema_version");
  assertExact(bundle.exclusions.schema_version, PROPOSITION_KNOWLEDGE_SHADOW_EXCLUSIONS_SCHEMA, "exclusions.schema_version");
  assertExact(bundle.diagnostics.schema_version, PROPOSITION_KNOWLEDGE_SHADOW_DIAGNOSTICS_SCHEMA, "diagnostics.schema_version");
  const epochValues = [bundle.cards.epoch_id, bundle.exclusions.epoch_id, bundle.diagnostics.epoch_id, bundle.manifest.epoch.epoch_id];
  if (epochValues.some((value) => value !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID)) fail("PROPOSITION_KNOWLEDGE_SHADOW_EPOCH_INVALID", "bundle epoch is not fixed production epoch");
  const genesisValues = [bundle.cards.genesis_event_id, bundle.exclusions.genesis_event_id, bundle.diagnostics.genesis_event_id, bundle.manifest.epoch.genesis_event_id];
  if (genesisValues.some((value) => value !== genesisValues[0] || !SHA256_PATTERN.test(value))) fail("PROPOSITION_KNOWLEDGE_SHADOW_EPOCH_INVALID", "bundle genesis ids disagree");
  if (bundle.manifest.result.card_count !== bundle.cards.cards.length || bundle.manifest.result.exclusion_count !== bundle.exclusions.exclusions.length || bundle.manifest.result.diagnostic_count !== bundle.diagnostics.diagnostics.length) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_COUNT_INVALID", "manifest result counts do not match artifacts");
  }
  if (bundle.manifest.source.proposition_evidence_count === 0 && bundle.manifest.source.proposition_lifecycle_count === 0) {
    if (bundle.manifest.result.disposition_reason !== PROPOSITION_KNOWLEDGE_SHADOW_PRODUCTION_REASON || bundle.cards.cards.length !== 0) fail("PROPOSITION_KNOWLEDGE_SHADOW_COUNT_INVALID", "genesis-only source must produce zero cards with the fixed reason");
  } else if (bundle.manifest.result.disposition_reason !== "post_genesis_propositions_resolved") {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_COUNT_INVALID", "post-genesis source has the wrong disposition reason");
  }
  assertSortedUnique(bundle.cards.cards.map((card) => card.source_event_id), "cards");
  assertSortedUnique(bundle.exclusions.exclusions.map((item) => item.source_event_id), "exclusions");
  for (const card of bundle.cards.cards) validateCard(card);
  for (const exclusion of bundle.exclusions.exclusions) validateExclusion(exclusion);
  for (const diagnostic of bundle.diagnostics.diagnostics) validateDiagnostic(diagnostic);
  for (const row of bundle.manifest.artifacts) {
    assertExactKeys(row as unknown as Record<string, unknown>, ["name", "sha256", "bytes"], `manifest.artifacts.${row.name}`);
    assertSha256(row.sha256, `manifest.artifacts.${row.name}.sha256`);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) fail("PROPOSITION_KNOWLEDGE_SHADOW_SCHEMA_INVALID", "artifact byte count invalid", { name: row.name });
  }
  const expectedArtifacts = ARTIFACT_NAMES.map((name): PropositionKnowledgeShadowArtifactRow => ({
    name,
    sha256: sha256Hex(bundle.bytes[name]),
    bytes: Buffer.byteLength(bundle.bytes[name]),
  }));
  if (canonicalizeJcs(expectedArtifacts) !== canonicalizeJcs(bundle.manifest.artifacts)) fail("PROPOSITION_KNOWLEDGE_SHADOW_HASH_INVALID", "artifact hashes do not match exact bytes");
  const expectedBundleHash = jcsSha256Hex({
    schema_version: BUNDLE_IDENTITY_SCHEMA,
    epoch_id: bundle.manifest.epoch.epoch_id,
    genesis_event_id: bundle.manifest.epoch.genesis_event_id,
    input_event_ids: bundle.manifest.source.input_event_ids,
    artifacts: expectedArtifacts,
  });
  if (bundle.manifest.bundle_hash !== expectedBundleHash) fail("PROPOSITION_KNOWLEDGE_SHADOW_HASH_INVALID", "bundle hash mismatch");
  for (const name of ALL_BUNDLE_NAMES) {
    const expectedObject = name === "manifest.json" ? bundle.manifest : name === "cards.json" ? bundle.cards : name === "exclusions.json" ? bundle.exclusions : bundle.diagnostics;
    if (bundle.bytes[name] !== canonicalJson(expectedObject)) fail("PROPOSITION_KNOWLEDGE_SHADOW_JCS_INVALID", `${name} is not deterministic RFC8785/JCS bytes`);
  }
}

function validateCard(card: PropositionKnowledgeShadowCard): void {
  assertExactKeys(card as unknown as Record<string, unknown>, ["card_schema_version", "card_id", "source_event_id", "source_epoch", "statement", "modality", "language", "original_facets", "effective_facets", "scope", "lifecycle"], "card");
  assertExactKeys(card.source_epoch as unknown as Record<string, unknown>, ["epoch_id", "genesis_event_id"], "card.source_epoch");
  assertExactKeys(card.lifecycle as unknown as Record<string, unknown>, ["disposition", "activation", "lineage_event_ids", "lineage", "terminal_event_id"], "card.lifecycle");
  assertExact(card.card_schema_version, "proposition-knowledge-pull-shadow-card/v1", "card.card_schema_version");
  assertSha256(card.card_id, "card.card_id");
  assertSha256(card.source_event_id, "card.source_event_id");
  if (card.card_id !== card.source_event_id) fail("PROPOSITION_KNOWLEDGE_SHADOW_CARD_INVALID", "card identity must preserve source event id");
  if (typeof card.statement !== "string" || !card.statement.trim() || typeof card.language !== "string" || !card.language.trim()) fail("PROPOSITION_KNOWLEDGE_SHADOW_CARD_INVALID", "card statement/language invalid");
  validatePropositionEvidenceBody({
    event_schema_version: PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: { name: "pi-astack.proposition-knowledge-shadow-validator", version: "v1" },
    epoch: card.source_epoch,
    proposition: { modality: card.modality, statement: card.statement, language: card.language },
    facets: card.original_facets,
  });
  validatePropositionEvidenceBody({
    event_schema_version: PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: { name: "pi-astack.proposition-knowledge-shadow-validator", version: "v1" },
    epoch: card.source_epoch,
    proposition: { modality: card.modality, statement: card.statement, language: card.language },
    facets: card.effective_facets,
  });
  if (card.modality === "meta-lifecycle" || card.lifecycle.disposition !== "active") fail("PROPOSITION_KNOWLEDGE_SHADOW_CARD_INVALID", "meta-lifecycle or inactive evidence became searchable");
  assertUnique(card.lifecycle.lineage_event_ids, "card.lifecycle.lineage_event_ids");
  if (card.lifecycle.lineage_event_ids.length !== card.lifecycle.lineage.length) fail("PROPOSITION_KNOWLEDGE_SHADOW_CARD_INVALID", "lifecycle lineage ids/count disagree");
  for (const [index, entry] of card.lifecycle.lineage.entries()) {
    assertExactKeys(entry as unknown as Record<string, unknown>, ["event_id", "operation", "state_target_event_id", "replacement_event_id"], `card.lifecycle.lineage[${index}]`);
    assertSha256(entry.event_id, `card.lifecycle.lineage[${index}].event_id`);
    assertSha256(entry.state_target_event_id, `card.lifecycle.lineage[${index}].state_target_event_id`);
    if (entry.replacement_event_id !== null) assertSha256(entry.replacement_event_id, `card.lifecycle.lineage[${index}].replacement_event_id`);
    if (!Object.hasOwn(PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX, entry.operation) || entry.event_id !== card.lifecycle.lineage_event_ids[index]) fail("PROPOSITION_KNOWLEDGE_SHADOW_CARD_INVALID", "lifecycle lineage operation/id invalid");
  }
  assertSha256(card.lifecycle.terminal_event_id, "card.lifecycle.terminal_event_id");
  if (canonicalizeJcs(card.scope) !== canonicalizeJcs(card.effective_facets.spatial_scope)) fail("PROPOSITION_KNOWLEDGE_SHADOW_CARD_INVALID", "card scope does not preserve effective spatial scope");
}

function validateExclusion(exclusion: PropositionKnowledgeShadowExclusion): void {
  assertExactKeys(exclusion as unknown as Record<string, unknown>, ["source_event_id", "modality", "lifecycle_disposition", "reason_codes"], "exclusion");
  assertSha256(exclusion.source_event_id, "exclusion.source_event_id");
  if (!exclusion.reason_codes.length || new Set(exclusion.reason_codes).size !== exclusion.reason_codes.length || [...exclusion.reason_codes].sort(compareCodeUnits).some((value, index) => value !== exclusion.reason_codes[index])) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_EXCLUSION_INVALID", "exclusion reasons must be non-empty, unique and sorted");
  }
  if (exclusion.reason_codes.some((reason) => !EXCLUSION_REASON_VALUES.includes(reason))) fail("PROPOSITION_KNOWLEDGE_SHADOW_EXCLUSION_INVALID", "unknown exclusion reason");
}

function validateDiagnostic(diagnostic: PropositionKnowledgeShadowDiagnostic): void {
  assertExactKeys(diagnostic as unknown as Record<string, unknown>, ["code", "severity", "disposition", "source_event_ids"], "diagnostic");
  if (diagnostic.severity !== "excluded" || diagnostic.disposition !== "not_searchable" || diagnostic.source_event_ids.length !== 1 || !EXCLUSION_REASON_VALUES.includes(diagnostic.code)) fail("PROPOSITION_KNOWLEDGE_SHADOW_DIAGNOSTIC_INVALID", "diagnostic shape invalid");
  assertSha256(diagnostic.source_event_ids[0]!, "diagnostic.source_event_ids[0]");
}

function exclusionReasons(state: ResolvedPropositionState): PropositionKnowledgeShadowExclusionReason[] {
  const reasons = new Set<PropositionKnowledgeShadowExclusionReason>();
  if (state.disposition === "archived") reasons.add("lifecycle_archived");
  if (state.disposition === "retracted") reasons.add("lifecycle_retracted");
  if (state.disposition === "superseded") reasons.add("lifecycle_superseded");
  if (state.proposition.modality === "meta-lifecycle") reasons.add("meta_lifecycle_not_searchable");
  if (state.effective_scope_resolution !== "resolved") reasons.add("unresolved_scope");
  const temporal = state.effective_facets.temporal_horizon;
  if (temporal.horizon === "unknown") reasons.add("unresolved_temporal_horizon");
  else if (temporal.horizon !== "durable" || temporal.valid_from !== null || temporal.valid_until !== null) reasons.add("temporal_context_required");
  const sensitivity = state.effective_facets.sensitivity;
  if (sensitivity.classification === "secret") reasons.add("sensitivity_secret");
  if (sensitivity.classification === "secret_adjacent") reasons.add("sensitivity_secret_adjacent");
  if (sensitivity.classification === "unknown" || sensitivity.handling === "unknown") reasons.add("unresolved_sensitivity");
  if (sensitivity.handling === "withhold") reasons.add("sensitivity_withhold");
  if (sensitivity.handling === "redact") reasons.add("unsupported_redaction");
  const contestability = state.effective_facets.contestability.status;
  if (contestability === "contested") reasons.add("contestability_contested");
  if (contestability === "requires_review") reasons.add("contestability_requires_review");
  if (contestability === "unknown") reasons.add("contestability_unresolved");
  return [...reasons].sort(compareCodeUnits);
}

async function readBundleDirectory(bundleDir: string): Promise<PropositionKnowledgeShadowBundle> {
  const stat = await fsp.lstat(bundleDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_UNSAFE", "bundle path is not a regular directory");
  const entries = (await fsp.readdir(bundleDir)).sort(compareCodeUnits);
  if (canonicalizeJcs(entries) !== canonicalizeJcs([...ALL_BUNDLE_NAMES].sort(compareCodeUnits))) fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_UNSAFE", "bundle directory contains an unexpected file set", { entries });
  const raw = {} as Record<typeof ALL_BUNDLE_NAMES[number], string>;
  for (const name of ALL_BUNDLE_NAMES) {
    const file = path.join(bundleDir, name);
    const fileStat = await fsp.lstat(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_UNSAFE", `${name} is not a regular file`);
    raw[name] = await fsp.readFile(file, "utf-8");
  }
  let manifest: PropositionKnowledgeShadowManifest;
  let cards: PropositionKnowledgeShadowBundle["cards"];
  let exclusions: PropositionKnowledgeShadowBundle["exclusions"];
  let diagnostics: PropositionKnowledgeShadowBundle["diagnostics"];
  try {
    manifest = JSON.parse(raw["manifest.json"]);
    cards = JSON.parse(raw["cards.json"]);
    exclusions = JSON.parse(raw["exclusions.json"]);
    diagnostics = JSON.parse(raw["diagnostics.json"]);
  } catch (err) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_JSON_INVALID", "bundle artifact is not JSON", { error: errorMessage(err) });
  }
  const bundle = deepFreeze({ manifest: manifest!, cards: cards!, exclusions: exclusions!, diagnostics: diagnostics!, bytes: deepFreeze(raw) });
  validatePropositionKnowledgeShadowBundle(bundle);
  return bundle;
}

async function assertBundleDirectoryBytes(bundleDir: string, expected: PropositionKnowledgeShadowBundle["bytes"]): Promise<void> {
  const actual = await readBundleDirectory(bundleDir);
  for (const name of ALL_BUNDLE_NAMES) {
    if (actual.bytes[name] !== expected[name]) fail("PROPOSITION_KNOWLEDGE_SHADOW_COLLISION", "deterministic bundle id exists with different bytes", { name, bundleDir });
  }
}

function assertAllowedShadowMutationInventory(inventory: Readonly<InventoryDiff>, bundleHash: string): void {
  const bundlePrefix = `bundles/${bundleHash}`;
  const allowedCreates = new Map<string, InventoryRow["kind"]>([
    [".", "directory"],
    ["bundles", "directory"],
    [bundlePrefix, "directory"],
    [`${bundlePrefix}/cards.json`, "file"],
    [`${bundlePrefix}/diagnostics.json`, "file"],
    [`${bundlePrefix}/exclusions.json`, "file"],
    [`${bundlePrefix}/manifest.json`, "file"],
    ["latest", "symlink"],
  ]);
  const unexpectedCreated = inventory.created.filter((row) => allowedCreates.get(row.path) !== row.kind);
  const unexpectedModified = inventory.modified.filter((row) => row.path !== "latest" || row.kind !== "symlink");
  if (unexpectedCreated.length || unexpectedModified.length || inventory.removed.length) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_UNEXPECTED_MUTATION", "shadow mutation inventory contains an entry outside the immutable bundle/latest policy", {
      unexpectedCreated,
      unexpectedModified,
      removed: inventory.removed,
    });
  }
}

interface ProtectedAbrainInventoryRow {
  path: string;
  kind: "directory" | "file" | "excluded_shadow_prefix";
  sha256: string;
  bytes: number;
}

async function captureFullProtectedAbrainSnapshot(options: { abrainHome: string; shadowRoot: string }): Promise<Readonly<Record<string, unknown>>> {
  const abrainHome = path.resolve(options.abrainHome);
  const shadowRoot = path.resolve(options.shadowRoot);
  if (!pathInside(abrainHome, shadowRoot) || shadowRoot === abrainHome) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_ESCAPE", "protected snapshot shadow exclusion escapes abrain home");
  await assertExistingDirectoryChainNoSymlink(path.parse(abrainHome).root, abrainHome);
  const abrainReal = await fsp.realpath(abrainHome);
  if (abrainReal !== abrainHome) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "abrain home must resolve exactly without ancestor symlinks", { abrainHome, abrainReal });

  const rows: ProtectedAbrainInventoryRow[] = [];
  const walk = async (file: string): Promise<void> => {
    const stat = await fsp.lstat(file);
    const rel = relativeUnix(abrainHome, file);
    if (file === shadowRoot) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "excluded shadow prefix must be a regular directory when present", { shadowRoot });
      return;
    }
    if (stat.isSymbolicLink()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PROTECTED_UNSAFE", "symlink outside the exact shadow prefix is not allowed in the full protected snapshot", { file });
    if (stat.isDirectory()) {
      if (rel) rows.push({ path: rel, kind: "directory", sha256: jcsSha256Hex({ kind: "directory" }), bytes: 0 });
      const children = (await fsp.readdir(file)).sort(compareCodeUnits);
      for (const child of children) await walk(path.join(file, child));
      return;
    }
    if (!stat.isFile()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PROTECTED_UNSAFE", "non-regular entry outside the exact shadow prefix", { file });
    const bytes = await fsp.readFile(file);
    rows.push({ path: rel, kind: "file", sha256: sha256Hex(bytes), bytes: bytes.length });
  };
  await walk(abrainHome);
  rows.push({
    path: relativeUnix(abrainHome, shadowRoot),
    kind: "excluded_shadow_prefix",
    sha256: jcsSha256Hex({ exact_exclusion: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE }),
    bytes: 0,
  });
  rows.sort((left, right) => compareCodeUnits(left.path, right.path));
  const counts = {
    entry_count: rows.length,
    directory_count: rows.filter((row) => row.kind === "directory").length,
    file_count: rows.filter((row) => row.kind === "file").length,
    symlink_count: 0,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
  return deepFreeze({
    schema_version: "proposition-knowledge-shadow-full-protected-abrain-snapshot/v1",
    scope: "all_abrain_entries_excluding_exact_shadow_prefix",
    excluded_relative_prefix: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
    symlink_policy: "reject_outside_exact_shadow_prefix",
    rows_hash: jcsSha256Hex(rows),
    ...counts,
    snapshot_hash: jcsSha256Hex({
      scope: "all_abrain_entries_excluding_exact_shadow_prefix",
      excluded_relative_prefix: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
      rows,
    }),
  });
}

async function captureProtectedSnapshot(options: {
  abrainHome: string;
  repoRoot: string;
  registryPath: string;
  runtimeConfigPath?: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const runtimeConfigPath = path.resolve(options.runtimeConfigPath ?? path.join(options.repoRoot, "..", "..", "pi-astack-settings.json"));
  const surfaces = {
    l1: await treeDigest(path.join(options.abrainHome, "l1")),
    live_l2_knowledge: await treeDigest(path.join(options.abrainHome, "l2", "views", "knowledge", "latest")),
    live_l2_constraint: await treeDigest(path.join(options.abrainHome, "l2", "views", "constraint", "latest")),
    constraint_shadow: await treeDigest(path.join(options.abrainHome, ".state", "sediment", "constraint-shadow")),
    rules: await treeDigest(path.join(options.abrainHome, "rules")),
    knowledge: await treeDigest(path.join(options.abrainHome, "knowledge")),
    projects: await treeDigest(path.join(options.abrainHome, "projects")),
    memory_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "memory")),
    sediment_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "sediment")),
    rule_injector_runtime: await treeDigest(path.join(options.repoRoot, "extensions", "abrain", "rule-injector")),
    abrain_runtime_entry: await fileDigest(path.join(options.repoRoot, "extensions", "abrain", "index.ts")),
    package_registration: await fileDigest(path.join(options.repoRoot, "package.json")),
    runtime_config: await fileDigest(runtimeConfigPath),
  };
  const contractFiles = {
    registry: await fileDigest(options.registryPath),
    proposition: await fileDigest(path.join(options.repoRoot, "extensions", "_shared", "proposition.ts")),
  };
  return deepFreeze({
    surfaces,
    surfaces_hash: jcsSha256Hex(surfaces),
    contract_files: contractFiles,
    contract_files_hash: jcsSha256Hex(contractFiles),
    snapshot_hash: jcsSha256Hex({ surfaces, contract_files: contractFiles }),
  });
}

async function treeDigest(root: string): Promise<Readonly<Record<string, unknown>>> {
  const stat = await lstatIfPresent(root);
  if (!stat) return deepFreeze({ state: "missing", rows_hash: jcsSha256Hex([]), file_count: 0, bytes: 0 });
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PROTECTED_UNSAFE", "protected tree root is not a regular directory", { root });
  const rows: Array<{ path: string; sha256: string; bytes: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const itemStat = await fsp.lstat(file);
      if (itemStat.isSymbolicLink()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PROTECTED_UNSAFE", "symlink in protected tree", { file });
      if (itemStat.isDirectory()) await walk(file);
      else if (itemStat.isFile()) {
        const bytes = await fsp.readFile(file);
        rows.push({ path: relativeUnix(root, file), sha256: sha256Hex(bytes), bytes: bytes.length });
      } else fail("PROPOSITION_KNOWLEDGE_SHADOW_PROTECTED_UNSAFE", "non-regular entry in protected tree", { file });
    }
  };
  await walk(root);
  rows.sort((left, right) => compareCodeUnits(left.path, right.path));
  return deepFreeze({ state: "present", rows_hash: jcsSha256Hex(rows), file_count: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) });
}

async function fileDigest(file: string): Promise<Readonly<Record<string, unknown>>> {
  const stat = await lstatIfPresent(file);
  if (!stat) return deepFreeze({ state: "missing", sha256: jcsSha256Hex(null), bytes: 0 });
  if (stat.isSymbolicLink() || !stat.isFile()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PROTECTED_UNSAFE", "protected file is not regular", { file });
  const bytes = await fsp.readFile(file);
  return deepFreeze({ state: "present", sha256: sha256Hex(bytes), bytes: bytes.length });
}

async function inventoryTree(root: string, options: { allowSymlinks: boolean }): Promise<{ rows: readonly InventoryRow[]; hash: string }> {
  const stat = await lstatIfPresent(root);
  if (!stat) return { rows: Object.freeze([]), hash: jcsSha256Hex([]) };
  const rows: InventoryRow[] = [];
  const walk = async (file: string): Promise<void> => {
    const item = await fsp.lstat(file);
    const rel = relativeUnix(root, file) || ".";
    if (item.isSymbolicLink()) {
      if (!options.allowSymlinks) fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_UNSAFE", "symlink not allowed in inventory", { file });
      rows.push({ path: rel, kind: "symlink", sha256: sha256Hex(await fsp.readlink(file)), bytes: 0 });
    } else if (item.isDirectory()) {
      rows.push({ path: rel, kind: "directory", sha256: jcsSha256Hex({ kind: "directory" }), bytes: 0 });
      const children = (await fsp.readdir(file)).sort(compareCodeUnits);
      for (const child of children) await walk(path.join(file, child));
    } else if (item.isFile()) {
      const bytes = await fsp.readFile(file);
      rows.push({ path: rel, kind: "file", sha256: sha256Hex(bytes), bytes: bytes.length });
    } else fail("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_UNSAFE", "non-regular shadow output entry", { file });
  };
  await walk(root);
  rows.sort((left, right) => compareCodeUnits(left.path, right.path));
  return { rows: Object.freeze(rows), hash: jcsSha256Hex(rows) };
}

interface InventoryRow {
  path: string;
  kind: "directory" | "file" | "symlink";
  sha256: string;
  bytes: number;
}

interface InventoryDiff {
  before_hash: string;
  after_hash: string;
  created: readonly InventoryRow[];
  modified: readonly InventoryRow[];
  removed: readonly InventoryRow[];
}

function diffInventory(before: readonly InventoryRow[], after: readonly InventoryRow[]): Readonly<InventoryDiff> {
  const beforeMap = new Map(before.map((row) => [row.path, row]));
  const afterMap = new Map(after.map((row) => [row.path, row]));
  const created = after.filter((row) => !beforeMap.has(row.path));
  const removed = before.filter((row) => !afterMap.has(row.path));
  const modified = after.filter((row) => {
    const prior = beforeMap.get(row.path);
    return prior && canonicalizeJcs(prior) !== canonicalizeJcs(row);
  });
  return deepFreeze({
    before_hash: jcsSha256Hex(before),
    after_hash: jcsSha256Hex(after),
    created: Object.freeze(created),
    modified: Object.freeze(modified),
    removed: Object.freeze(removed),
  });
}

async function genericWriteGateCode(options: { abrainHome: string; registryPath: string; tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionGenesisTuple>> }): Promise<string> {
  try {
    await validateL1WritePreflight({
      abrainHome: options.abrainHome,
      registryPath: options.registryPath,
      envelope: options.tuple.envelope,
      targetPath: options.tuple.target_path,
      expected: { envelopeSchema: PROPOSITION_GENESIS_ENVELOPE_SCHEMA, domain: "proposition", role: "meta" },
    });
    return "WRITE_UNEXPECTEDLY_ENABLED";
  } catch (err) {
    return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "UNKNOWN_ERROR";
  }
}

async function assertExistingDirectoryChainNoSymlink(base: string, target: string): Promise<void> {
  const baseResolved = path.resolve(base);
  const targetResolved = path.resolve(target);
  const relative = path.relative(baseResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_ESCAPE", "directory target escapes trusted base", { base: baseResolved, target: targetResolved });
  let current = baseResolved;
  const baseStat = await fsp.lstat(current);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "trusted directory base is not a regular directory", { current });
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstatIfPresent(current);
    if (!stat) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "required directory chain component is missing", { current });
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "directory chain contains a non-directory or symlink", { current });
  }
}

async function ensureDirectoryChainNoSymlink(base: string, target: string): Promise<void> {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_ESCAPE", "directory target escapes abrain home");
  const baseStat = await fsp.lstat(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "abrain home is not a regular directory");
  let current = base;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat = await lstatIfPresent(current);
    if (!stat) {
      try {
        await fsp.mkdir(current, { mode: 0o700 });
      } catch (err) {
        if (!isNodeError(err) || err.code !== "EEXIST") throw err;
      }
      stat = await fsp.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", "shadow output directory chain contains a non-directory or symlink", { current });
  }
}

async function writeSyncedExclusive(file: string, content: string): Promise<void> {
  const handle = await fsp.open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_SCHEMA_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
  }
}

function assertNoStatementKey(value: unknown, at: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoStatementKey(child, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, "") === "statement") fail("PROPOSITION_KNOWLEDGE_SHADOW_SECRET_LEAK", `${at}.${key} contains statement text`);
    assertNoStatementKey(child, `${at}.${key}`);
  }
}

function assertNoForbiddenDerivedKeys(value: unknown, at = "$root"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoForbiddenDerivedKeys(child, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_DERIVED_KEYS.has(normalized)) fail("PROPOSITION_KNOWLEDGE_SHADOW_DERIVED_AUTHORITY_FORBIDDEN", `${at}.${key} is not a Knowledge pull shadow field`);
    assertNoForbiddenDerivedKeys(child, `${at}.${key}`);
  }
}

function assertNoStatementTextInDossier(value: unknown, at = "$root"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoStatementTextInDossier(child, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, "") === "statement") fail("PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_TEXT_LEAK", `dossier contains statement at ${at}.${key}`);
    assertNoStatementTextInDossier(child, `${at}.${key}`);
  }
}

function assertSortedUnique(values: readonly string[], at: string): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0)) {
    fail("PROPOSITION_KNOWLEDGE_SHADOW_ORDER_INVALID", `${at} must be unique and code-unit sorted`);
  }
}

function assertUnique(values: readonly string[], at: string): void {
  if (new Set(values).size !== values.length) fail("PROPOSITION_KNOWLEDGE_SHADOW_ORDER_INVALID", `${at} must be unique`);
}

function assertSha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("PROPOSITION_KNOWLEDGE_SHADOW_HASH_INVALID", `${at} must be lowercase SHA-256`);
  return value;
}

function assertExact(value: unknown, expected: string, at: string): void {
  if (value !== expected) fail("PROPOSITION_KNOWLEDGE_SHADOW_SCHEMA_INVALID", `${at} must equal ${expected}`);
}

function canonicalJson(value: unknown): string {
  return `${canonicalizeJcs(value)}\n`;
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeUnix(parent: string, child: string): string {
  return path.relative(parent, child).split(path.sep).join("/");
}

async function lstatIfPresent(file: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(file);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

function isAlreadyExists(err: unknown): boolean {
  return isNodeError(err) && (err.code === "EEXIST" || err.code === "ENOTEMPTY");
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionKnowledgeShadowError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
