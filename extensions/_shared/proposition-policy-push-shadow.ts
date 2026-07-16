import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  defaultL1SchemaRegistryPath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import {
  PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
  PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
  PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  validatePropositionEvidenceBody,
  type PropositionFacets,
  type PropositionModality,
} from "./proposition";
import {
  PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX,
  PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA,
  resolvePropositionLifecycleEffectiveState,
  type PropositionEffectiveDisposition,
  type PropositionLifecycleLineageEntry,
  type ResolvedPropositionState,
} from "./proposition-lifecycle-resolver";
import {
  buildTypescriptStaticDependencyGraph,
  validateTypescriptStaticDependencyGraph,
  type TypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";

export const PROPOSITION_POLICY_PUSH_SHADOW_ENTRY_SCHEMA = "proposition-policy-push-shadow-entry/v1" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_ENTRIES_SCHEMA = "proposition-policy-push-shadow-entries/v1" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSION_SCHEMA = "proposition-policy-push-shadow-exclusion/v1" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSIONS_SCHEMA = "proposition-policy-push-shadow-exclusions/v1" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTIC_SCHEMA = "proposition-policy-push-shadow-diagnostic/v1" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTICS_SCHEMA = "proposition-policy-push-shadow-diagnostics/v1" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA = "proposition-policy-push-shadow-manifest/v2" as const;
export const PROPOSITION_POLICY_PUSH_SHADOW_DOSSIER_SCHEMA = "proposition-policy-push-shadow-dossier/v1" as const;
export const PROPOSITION_POLICY_PUSH_FIXED_GENESIS_EVENT_ID = "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3" as const;
export const PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID = "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585" as const;

const PROJECTION_ENVELOPE_SCHEMA = "proposition-projection-envelope/v1" as const;
const RECORD_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this record object with record_hash omitted" as const;
const BUNDLE_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with bundle_hash omitted" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json"] as const);
const ALL_BUNDLE_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const FORBIDDEN_KEYS = new Set(["injectmode", "always", "listed", "priority", "policyeligibility", "sessionstarteligibility"]);
const FORBIDDEN_MANIFEST_DEPLOYMENT_KEYS = new Set(["publishedtoabrain", "placement"]);
const PROJECTOR_SOURCE_PATH = "extensions/_shared/proposition-policy-push-shadow.ts" as const;
const REGISTRY_SOURCE_PATH = "schemas/l1-schema-role-registry.json" as const;
export const PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS = Object.freeze([
  "extensions/_shared/jcs.ts",
  "extensions/_shared/l1-schema-registry.ts",
  "extensions/_shared/proposition-lifecycle-resolver.ts",
  "extensions/_shared/proposition-policy-push-shadow.ts",
  "extensions/_shared/proposition.ts",
  "extensions/_shared/typescript-static-dependency-graph.ts",
  REGISTRY_SOURCE_PATH,
] as const);

export const PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE = deepFreeze([
  { rank: 1, stage: "lifecycle", reason_codes: ["lifecycle_archived", "lifecycle_retracted", "lifecycle_superseded"] },
  { rank: 2, stage: "safety", reason_codes: ["safety_authority_not_attested"] },
  { rank: 3, stage: "scope", reason_codes: ["scope_unresolved"] },
  { rank: 4, stage: "temporal", reason_codes: ["temporal_not_durable"] },
  { rank: 5, stage: "sensitivity", reason_codes: ["sensitivity_not_public"] },
  { rank: 6, stage: "contestability", reason_codes: ["contestability_not_uncontested"] },
  { rank: 7, stage: "maturity", reason_codes: ["maturity_not_accepted_reviewed"] },
  { rank: 8, stage: "modality", reason_codes: ["modality_not_normative"] },
  { rank: 9, stage: "policy_hint", reason_codes: ["consumer_hints_policy_false"] },
] as const);

export type PropositionPolicyPushExclusionStage = typeof PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE[number]["stage"];
export type PropositionPolicyPushExclusionReason = typeof PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE[number]["reason_codes"][number];

type ArtifactName = typeof ARTIFACT_NAMES[number];
type BundleName = typeof ALL_BUNDLE_NAMES[number];

export interface PropositionPolicyPushEntry {
  schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_ENTRY_SCHEMA;
  record_hash_scope: typeof RECORD_HASH_SCOPE;
  record_hash: string;
  source_event_id: string;
  source_epoch: {
    epoch_id: string;
    genesis_event_id: string;
  };
  candidate_face: "policy_push";
  candidate_semantics: "relevance_only_no_injection_verdict";
  statement: string;
  language: string;
  modality: "normative";
  effective_facets: PropositionFacets;
  lifecycle: {
    disposition: "active";
    activation: "original" | "reactivated";
    lineage_event_ids: readonly string[];
    lineage: readonly PropositionLifecycleLineageEntry[];
    terminal_event_id: string;
  };
}

export interface PropositionPolicyPushExclusion {
  schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSION_SCHEMA;
  record_hash_scope: typeof RECORD_HASH_SCOPE;
  record_hash: string;
  source_event_id: string;
  filter_stage: PropositionPolicyPushExclusionStage;
  reason_code: PropositionPolicyPushExclusionReason;
}

export interface PropositionPolicyPushDiagnostic {
  schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTIC_SCHEMA;
  record_hash_scope: typeof RECORD_HASH_SCOPE;
  record_hash: string;
  code: "POLICY_CANDIDATE_EXCLUDED";
  severity: "info";
  source_event_id: string;
  filter_stage: PropositionPolicyPushExclusionStage;
  reason_code: PropositionPolicyPushExclusionReason;
}

export interface PropositionPolicyPushArtifactRow {
  name: ArtifactName;
  sha256: string;
  bytes: number;
}

export interface PropositionPolicyPushSourceResolution {
  source_event_id: string;
  statement_sha256: string;
  language: string;
  modality: PropositionModality;
  effective_facets: PropositionFacets;
  lifecycle: {
    disposition: PropositionEffectiveDisposition;
    activation: "original" | "reactivated";
    lineage_event_ids: readonly string[];
    lineage: readonly PropositionLifecycleLineageEntry[];
    terminal_event_id: string;
    superseded_by_event_id: string | null;
  };
}

export interface PropositionPolicyPushManifest {
  schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  bundle_hash_scope: typeof BUNDLE_HASH_SCOPE;
  authority: "shadow_push_only_no_runtime_consumer";
  projection_envelope_contract: {
    envelope_schema: typeof PROJECTION_ENVELOPE_SCHEMA;
    phase: "phase_disabled";
    body_schema: null;
    write_enabled: false;
    fold_eligible: false;
  };
  candidate_contract: {
    face: "policy_push";
    semantics: "relevance_only_no_injection_verdict";
    runtime_consumer: false;
  };
  epoch: {
    epoch_id: string;
    genesis_event_id: string;
  };
  source: {
    scanner: "scanWholeL1Validated";
    whole_l1: true;
    consumed_classification: "defined-inactive-shadow";
    consumed_envelope_schemas: readonly [
      typeof PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
      typeof PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
      typeof PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA,
    ];
    proposition_event_count: number;
    proposition_genesis_count: number;
    proposition_evidence_count: number;
    proposition_lifecycle_count: number;
    proposition_selected_count: number;
    proposition_foldable_count: number;
    non_proposition_event_consumed_count: 0;
    input_event_ids: readonly string[];
    input_event_ids_hash: string;
    evidence_event_ids: readonly string[];
    evidence_event_ids_hash: string;
    lifecycle_event_ids: readonly string[];
    lifecycle_event_ids_hash: string;
    source_resolution_inventory: readonly PropositionPolicyPushSourceResolution[];
    source_resolution_inventory_hash: string;
    registry_file_sha256: string;
    proposition_contract_file_sha256: string;
    lifecycle_resolver_file_sha256: string;
    projector_file_sha256: string;
    lifecycle_resolver_schema: typeof PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA;
  };
  exclusion_precedence: typeof PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE;
  result: {
    entry_count: number;
    exclusion_count: number;
    diagnostic_count: number;
  };
  artifacts: readonly PropositionPolicyPushArtifactRow[];
  bundle_hash: string;
}

export interface PropositionPolicyPushBundle {
  manifest: PropositionPolicyPushManifest;
  entries: {
    schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_ENTRIES_SCHEMA;
    epoch_id: string;
    genesis_event_id: string;
    entries: readonly PropositionPolicyPushEntry[];
  };
  exclusions: {
    schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSIONS_SCHEMA;
    epoch_id: string;
    genesis_event_id: string;
    exclusions: readonly PropositionPolicyPushExclusion[];
  };
  diagnostics: {
    schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTICS_SCHEMA;
    epoch_id: string;
    genesis_event_id: string;
    diagnostics: readonly PropositionPolicyPushDiagnostic[];
  };
  bytes: Readonly<Record<BundleName, string>>;
}

export class PropositionPolicyPushShadowError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushShadowError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionPolicyPushShadow(options: {
  abrainHome: string;
  repoRoot: string;
  registryPath?: string;
}): Promise<PropositionPolicyPushBundle> {
  const abrainHome = path.resolve(options.abrainHome);
  const repoRoot = path.resolve(options.repoRoot);
  const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
  const registry = loadL1SchemaRegistry(registryPath);
  const projection = registry.entries.find((entry) => entry.envelope_schema === PROJECTION_ENVELOPE_SCHEMA);
  if (!projection || projection.phase !== "phase_disabled" || projection.body_schema !== undefined || projection.write_enabled || projection.fold_eligible) {
    fail("PROPOSITION_POLICY_PUSH_REGISTRY_DRIFT", "proposition projection envelope must remain a bodyless phase-disabled placeholder");
  }
  const scan = await scanWholeL1Validated({ abrainHome, registry });
  return projectValidatedWholeL1(scan, { repoRoot, registryPath });
}

function projectValidatedWholeL1(
  scan: WholeL1ScanResult,
  options: { repoRoot: string; registryPath: string },
): PropositionPolicyPushBundle {
  const propositionRecords = scan.definedInactiveShadow
    .filter((record) => record.registration.domain === "proposition")
    .sort((left, right) => compareCodeUnits(left.eventId, right.eventId));
  const physicalPropositionRecords = scan.all.filter((record) => record.registration.domain === "proposition");
  if (physicalPropositionRecords.length !== propositionRecords.length) {
    fail("PROPOSITION_POLICY_PUSH_INPUT_CLASS_INVALID", "all physical proposition records must be defined-inactive shadow inputs", {
      physical: physicalPropositionRecords.length,
      consumed: propositionRecords.length,
    });
  }

  const resolution = resolvePropositionLifecycleEffectiveState(propositionRecords, {
    expectedEpochId: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    expectedGenesisEventId: PROPOSITION_POLICY_PUSH_FIXED_GENESIS_EVENT_ID,
  });
  const entries: PropositionPolicyPushEntry[] = [];
  const exclusions: PropositionPolicyPushExclusion[] = [];
  const diagnostics: PropositionPolicyPushDiagnostic[] = [];
  const sourceStatements = resolution.states.map((state) => state.proposition.statement);
  const sourceResolutionInventory = Object.freeze(resolution.states.map((state): PropositionPolicyPushSourceResolution => deepFreeze({
    source_event_id: state.source_event_id,
    statement_sha256: sha256Hex(state.proposition.statement),
    language: state.proposition.language,
    modality: state.proposition.modality,
    effective_facets: state.effective_facets,
    lifecycle: {
      disposition: state.disposition,
      activation: state.activation,
      lineage_event_ids: state.lifecycle_event_ids,
      lineage: state.lifecycle_lineage,
      terminal_event_id: state.terminal_event_id,
      superseded_by_event_id: state.superseded_by_event_id,
    },
  })));

  for (const state of resolution.states) {
    const excluded = firstExclusion(state);
    if (excluded) {
      const exclusion = withRecordHash({
        schema_version: PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSION_SCHEMA,
        record_hash_scope: RECORD_HASH_SCOPE,
        source_event_id: state.source_event_id,
        filter_stage: excluded.stage,
        reason_code: excluded.reason,
      }) as PropositionPolicyPushExclusion;
      const diagnostic = withRecordHash({
        schema_version: PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTIC_SCHEMA,
        record_hash_scope: RECORD_HASH_SCOPE,
        code: "POLICY_CANDIDATE_EXCLUDED" as const,
        severity: "info" as const,
        source_event_id: state.source_event_id,
        filter_stage: excluded.stage,
        reason_code: excluded.reason,
      }) as PropositionPolicyPushDiagnostic;
      exclusions.push(deepFreeze(exclusion));
      diagnostics.push(deepFreeze(diagnostic));
      continue;
    }

    const entry = withRecordHash({
      schema_version: PROPOSITION_POLICY_PUSH_SHADOW_ENTRY_SCHEMA,
      record_hash_scope: RECORD_HASH_SCOPE,
      source_event_id: state.source_event_id,
      source_epoch: { epoch_id: state.epoch_id, genesis_event_id: state.genesis_event_id },
      candidate_face: "policy_push" as const,
      candidate_semantics: "relevance_only_no_injection_verdict" as const,
      statement: state.proposition.statement,
      language: state.proposition.language,
      modality: "normative" as const,
      effective_facets: state.effective_facets,
      lifecycle: {
        disposition: "active" as const,
        activation: state.activation,
        lineage_event_ids: state.lifecycle_event_ids,
        lineage: state.lifecycle_lineage,
        terminal_event_id: state.terminal_event_id,
      },
    }) as PropositionPolicyPushEntry;
    entries.push(deepFreeze(entry));
  }

  entries.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  exclusions.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  diagnostics.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));

  const entriesDocument = deepFreeze({
    schema_version: PROPOSITION_POLICY_PUSH_SHADOW_ENTRIES_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    entries: Object.freeze(entries),
  });
  const exclusionsDocument = deepFreeze({
    schema_version: PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSIONS_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    exclusions: Object.freeze(exclusions),
  });
  const diagnosticsDocument = deepFreeze({
    schema_version: PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTICS_SCHEMA,
    epoch_id: resolution.epoch_id,
    genesis_event_id: resolution.genesis_event_id,
    diagnostics: Object.freeze(diagnostics),
  });
  const artifactBytes = {
    "diagnostics.json": canonicalJson(diagnosticsDocument),
    "entries.json": canonicalJson(entriesDocument),
    "exclusions.json": canonicalJson(exclusionsDocument),
  } as const;
  assertStatementIsolation(artifactBytes["diagnostics.json"], sourceStatements, "diagnostics.json");
  assertStatementIsolation(artifactBytes["exclusions.json"], sourceStatements, "exclusions.json");

  const artifacts = ARTIFACT_NAMES.map((name): PropositionPolicyPushArtifactRow => ({
    name,
    sha256: sha256Hex(artifactBytes[name]),
    bytes: Buffer.byteLength(artifactBytes[name]),
  }));
  const sourceCounts = {
    propositionGenesis: propositionRecords.filter((record) => record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA).length,
    propositionEvidence: propositionRecords.filter((record) => record.registration.envelope_schema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA).length,
    propositionLifecycle: propositionRecords.filter((record) => record.registration.envelope_schema === PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA).length,
  };
  const inputEventIds = Object.freeze(propositionRecords.map((record) => record.eventId).sort(compareCodeUnits));
  const evidenceEventIds = Object.freeze([...resolution.evidence_event_ids]);
  const lifecycleEventIds = Object.freeze([...resolution.lifecycle_event_ids]);
  const expectedRegistryPath = path.join(options.repoRoot, ...REGISTRY_SOURCE_PATH.split("/"));
  if (path.resolve(options.registryPath) !== expectedRegistryPath) {
    fail("PROPOSITION_POLICY_PUSH_REGISTRY_DRIFT", "source dependency evidence requires the repository registry path", { actual: options.registryPath, expected: expectedRegistryPath });
  }
  const sourceDependencies = buildTypescriptStaticDependencyGraph({
    repoRoot: options.repoRoot,
    roots: [PROJECTOR_SOURCE_PATH],
    explicitFiles: [REGISTRY_SOURCE_PATH],
  });
  validateTypescriptStaticDependencyGraph(sourceDependencies, { requiredPaths: PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS });
  const sourceFileHash = (relative: string): string => {
    const row = sourceDependencies.files.find((candidate) => candidate.path === relative);
    if (!row) fail("PROPOSITION_POLICY_PUSH_SOURCE_DEPENDENCY_INVALID", "required source dependency row is missing", { relative });
    return row.sha256;
  };
  const manifestBase = {
    schema_version: PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    bundle_hash_scope: BUNDLE_HASH_SCOPE,
    authority: "shadow_push_only_no_runtime_consumer" as const,
    projection_envelope_contract: {
      envelope_schema: PROJECTION_ENVELOPE_SCHEMA,
      phase: "phase_disabled" as const,
      body_schema: null,
      write_enabled: false as const,
      fold_eligible: false as const,
    },
    candidate_contract: {
      face: "policy_push" as const,
      semantics: "relevance_only_no_injection_verdict" as const,
      runtime_consumer: false as const,
    },
    epoch: { epoch_id: resolution.epoch_id, genesis_event_id: resolution.genesis_event_id },
    source: {
      scanner: "scanWholeL1Validated" as const,
      whole_l1: true as const,
      consumed_classification: "defined-inactive-shadow" as const,
      consumed_envelope_schemas: [
        PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
        PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
        PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA,
      ] as const,
      proposition_event_count: propositionRecords.length,
      proposition_genesis_count: sourceCounts.propositionGenesis,
      proposition_evidence_count: sourceCounts.propositionEvidence,
      proposition_lifecycle_count: sourceCounts.propositionLifecycle,
      proposition_selected_count: scan.selected.filter((record) => record.registration.domain === "proposition").length,
      proposition_foldable_count: scan.foldable.filter((record) => record.registration.domain === "proposition").length,
      non_proposition_event_consumed_count: 0 as const,
      input_event_ids: inputEventIds,
      input_event_ids_hash: jcsSha256Hex(inputEventIds),
      evidence_event_ids: evidenceEventIds,
      evidence_event_ids_hash: jcsSha256Hex(evidenceEventIds),
      lifecycle_event_ids: lifecycleEventIds,
      lifecycle_event_ids_hash: jcsSha256Hex(lifecycleEventIds),
      source_resolution_inventory: sourceResolutionInventory,
      source_resolution_inventory_hash: jcsSha256Hex(sourceResolutionInventory),
      registry_file_sha256: sourceFileHash(REGISTRY_SOURCE_PATH),
      proposition_contract_file_sha256: sourceFileHash("extensions/_shared/proposition.ts"),
      lifecycle_resolver_file_sha256: sourceFileHash("extensions/_shared/proposition-lifecycle-resolver.ts"),
      projector_file_sha256: sourceFileHash(PROJECTOR_SOURCE_PATH),
      lifecycle_resolver_schema: PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA,
    },
    exclusion_precedence: PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE,
    result: {
      entry_count: entries.length,
      exclusion_count: exclusions.length,
      diagnostic_count: diagnostics.length,
    },
    artifacts: Object.freeze(artifacts),
  };
  const manifest: PropositionPolicyPushManifest = deepFreeze({ ...manifestBase, bundle_hash: jcsSha256Hex(manifestBase) });
  const manifestBytes = canonicalJson(manifest);
  assertStatementIsolation(manifestBytes, sourceStatements, "manifest.json");
  const bytes = deepFreeze({ ...artifactBytes, "manifest.json": manifestBytes });
  const bundle = deepFreeze({ manifest, entries: entriesDocument, exclusions: exclusionsDocument, diagnostics: diagnosticsDocument, bytes });
  validatePropositionPolicyPushBundle(bundle);
  return bundle;
}

export function validatePropositionPolicyPushBundle(bundle: PropositionPolicyPushBundle): void {
  assertExactKeys(asRecord(bundle), ["manifest", "entries", "exclusions", "diagnostics", "bytes"], "bundle");
  assertNoForbiddenKeys(bundle);
  assertNoStatementKey(bundle.manifest, "manifest");
  assertNoManifestDeploymentKeys(bundle.manifest);
  assertNoStatementKey(bundle.exclusions, "exclusions");
  assertNoStatementKey(bundle.diagnostics, "diagnostics");
  validateManifest(bundle.manifest);
  validateDocument(bundle.entries, PROPOSITION_POLICY_PUSH_SHADOW_ENTRIES_SCHEMA, "entries", "entries");
  validateDocument(bundle.exclusions, PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSIONS_SCHEMA, "exclusions", "exclusions");
  validateDocument(bundle.diagnostics, PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTICS_SCHEMA, "diagnostics", "diagnostics");
  assertExactKeys(asRecord(bundle.bytes), ALL_BUNDLE_NAMES, "bytes");

  for (const entry of bundle.entries.entries) validateEntry(entry);
  for (const exclusion of bundle.exclusions.exclusions) validateExclusion(exclusion);
  for (const diagnostic of bundle.diagnostics.diagnostics) validateDiagnostic(diagnostic);
  assertSortedUnique(bundle.entries.entries.map((entry) => entry.source_event_id), "entries", { allowEmpty: true });
  assertSortedUnique(bundle.exclusions.exclusions.map((entry) => entry.source_event_id), "exclusions", { allowEmpty: true });
  assertSortedUnique(bundle.diagnostics.diagnostics.map((entry) => entry.source_event_id), "diagnostics", { allowEmpty: true });

  const epochIds = [bundle.manifest.epoch.epoch_id, bundle.entries.epoch_id, bundle.exclusions.epoch_id, bundle.diagnostics.epoch_id];
  const genesisIds = [bundle.manifest.epoch.genesis_event_id, bundle.entries.genesis_event_id, bundle.exclusions.genesis_event_id, bundle.diagnostics.genesis_event_id];
  if (epochIds.some((value) => value !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID) || genesisIds.some((value) => value !== PROPOSITION_POLICY_PUSH_FIXED_GENESIS_EVENT_ID)) {
    fail("PROPOSITION_POLICY_PUSH_EPOCH_INVALID", "artifact epoch/genesis does not equal the fixed production boundary");
  }
  if (bundle.manifest.result.entry_count !== bundle.entries.entries.length
    || bundle.manifest.result.exclusion_count !== bundle.exclusions.exclusions.length
    || bundle.manifest.result.diagnostic_count !== bundle.diagnostics.diagnostics.length
    || bundle.exclusions.exclusions.length !== bundle.diagnostics.diagnostics.length
    || bundle.manifest.result.entry_count + bundle.manifest.result.exclusion_count !== bundle.manifest.source.proposition_evidence_count) {
    fail("PROPOSITION_POLICY_PUSH_COUNT_INVALID", "manifest, evidence, and artifact counts disagree");
  }
  const outputIds = [...bundle.entries.entries.map((entry) => entry.source_event_id), ...bundle.exclusions.exclusions.map((entry) => entry.source_event_id)].sort(compareCodeUnits);
  if (!sameOrderedStrings(outputIds, bundle.manifest.source.evidence_event_ids)) {
    fail("PROPOSITION_POLICY_PUSH_PARTITION_INVALID", "entry/exclusion source IDs must exactly partition manifest evidence IDs", { outputIds, evidenceEventIds: bundle.manifest.source.evidence_event_ids });
  }
  const entriesBySource = new Map(bundle.entries.entries.map((entry) => [entry.source_event_id, entry]));
  const exclusionsBySource = new Map(bundle.exclusions.exclusions.map((entry) => [entry.source_event_id, entry]));
  const diagnosticsBySource = new Map(bundle.diagnostics.diagnostics.map((entry) => [entry.source_event_id, entry]));
  for (const resolution of bundle.manifest.source.source_resolution_inventory) {
    const expectedExclusion = firstExclusion({
      disposition: resolution.lifecycle.disposition,
      effective_facets: resolution.effective_facets,
      effective_scope_resolution: scopeIsResolved(resolution.effective_facets.spatial_scope) ? "resolved" : "unresolved",
      proposition: { modality: resolution.modality },
    });
    const entry = entriesBySource.get(resolution.source_event_id);
    const exclusion = exclusionsBySource.get(resolution.source_event_id);
    if (expectedExclusion) {
      if (entry || !exclusion || exclusion.filter_stage !== expectedExclusion.stage || exclusion.reason_code !== expectedExclusion.reason) {
        fail("PROPOSITION_POLICY_PUSH_EXCLUSION_INVALID", "output exclusion does not match source resolution commitment", { sourceEventId: resolution.source_event_id, expectedExclusion });
      }
    } else {
      if (exclusion || !entry) fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "eligible source resolution commitment does not have exactly one entry", { sourceEventId: resolution.source_event_id });
      validateEntryAgainstSourceResolution(entry, resolution);
    }
  }
  for (const exclusion of bundle.exclusions.exclusions) {
    const diagnostic = diagnosticsBySource.get(exclusion.source_event_id);
    if (!diagnostic || diagnostic.reason_code !== exclusion.reason_code || diagnostic.filter_stage !== exclusion.filter_stage) {
      fail("PROPOSITION_POLICY_PUSH_DIAGNOSTIC_INVALID", "exclusion and diagnostic source/reason do not match", { sourceEventId: exclusion.source_event_id });
    }
  }

  const expectedArtifacts = ARTIFACT_NAMES.map((name): PropositionPolicyPushArtifactRow => ({
    name,
    sha256: sha256Hex(bundle.bytes[name]),
    bytes: Buffer.byteLength(bundle.bytes[name]),
  }));
  if (canonicalizeJcs(expectedArtifacts) !== canonicalizeJcs(bundle.manifest.artifacts)) {
    fail("PROPOSITION_POLICY_PUSH_HASH_INVALID", "artifact rows do not match exact artifact bytes");
  }
  const manifestBase = { ...bundle.manifest } as Record<string, unknown>;
  delete manifestBase.bundle_hash;
  if (jcsSha256Hex(manifestBase) !== bundle.manifest.bundle_hash) fail("PROPOSITION_POLICY_PUSH_HASH_INVALID", "bundle hash mismatch");
  const objectByName: Record<BundleName, unknown> = {
    "diagnostics.json": bundle.diagnostics,
    "entries.json": bundle.entries,
    "exclusions.json": bundle.exclusions,
    "manifest.json": bundle.manifest,
  };
  for (const name of ALL_BUNDLE_NAMES) {
    if (bundle.bytes[name] !== canonicalJson(objectByName[name])) fail("PROPOSITION_POLICY_PUSH_JCS_INVALID", `${name} is not exact RFC8785/JCS bytes`);
  }
}

function validateManifest(manifest: PropositionPolicyPushManifest): void {
  assertExactKeys(asRecord(manifest), ["schema_version", "canonicalization", "hash_algorithm", "bundle_hash_scope", "authority", "projection_envelope_contract", "candidate_contract", "epoch", "source", "exclusion_precedence", "result", "artifacts", "bundle_hash"], "manifest");
  assertExactKeys(asRecord(manifest.projection_envelope_contract), ["envelope_schema", "phase", "body_schema", "write_enabled", "fold_eligible"], "manifest.projection_envelope_contract");
  assertExactKeys(asRecord(manifest.candidate_contract), ["face", "semantics", "runtime_consumer"], "manifest.candidate_contract");
  assertExactKeys(asRecord(manifest.epoch), ["epoch_id", "genesis_event_id"], "manifest.epoch");
  assertExactKeys(asRecord(manifest.source), ["scanner", "whole_l1", "consumed_classification", "consumed_envelope_schemas", "proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "non_proposition_event_consumed_count", "input_event_ids", "input_event_ids_hash", "evidence_event_ids", "evidence_event_ids_hash", "lifecycle_event_ids", "lifecycle_event_ids_hash", "source_resolution_inventory", "source_resolution_inventory_hash", "registry_file_sha256", "proposition_contract_file_sha256", "lifecycle_resolver_file_sha256", "projector_file_sha256", "lifecycle_resolver_schema"], "manifest.source");
  assertExactKeys(asRecord(manifest.result), ["entry_count", "exclusion_count", "diagnostic_count"], "manifest.result");
  if (manifest.schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA
    || manifest.canonicalization !== "RFC8785-JCS"
    || manifest.hash_algorithm !== "sha256"
    || manifest.bundle_hash_scope !== BUNDLE_HASH_SCOPE
    || manifest.authority !== "shadow_push_only_no_runtime_consumer") {
    fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", "manifest identity or authority drifted");
  }
  if (manifest.projection_envelope_contract.envelope_schema !== PROJECTION_ENVELOPE_SCHEMA
    || manifest.projection_envelope_contract.phase !== "phase_disabled"
    || manifest.projection_envelope_contract.body_schema !== null
    || manifest.projection_envelope_contract.write_enabled
    || manifest.projection_envelope_contract.fold_eligible) {
    fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", "projection envelope contract became active");
  }
  if (manifest.candidate_contract.face !== "policy_push"
    || manifest.candidate_contract.semantics !== "relevance_only_no_injection_verdict"
    || manifest.candidate_contract.runtime_consumer) {
    fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", "candidate contract acquired runtime semantics");
  }
  if (manifest.source.scanner !== "scanWholeL1Validated"
    || !manifest.source.whole_l1
    || manifest.source.consumed_classification !== "defined-inactive-shadow"
    || manifest.source.non_proposition_event_consumed_count !== 0
    || manifest.source.proposition_selected_count !== 0
    || manifest.source.proposition_foldable_count !== 0
    || manifest.source.lifecycle_resolver_schema !== PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA) {
    fail("PROPOSITION_POLICY_PUSH_SOURCE_INVALID", "whole-L1 source boundary drifted");
  }
  const expectedSchemas = [PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, PROPOSITION_GENESIS_ENVELOPE_SCHEMA, PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA];
  if (canonicalizeJcs(manifest.source.consumed_envelope_schemas) !== canonicalizeJcs(expectedSchemas)) fail("PROPOSITION_POLICY_PUSH_SOURCE_INVALID", "consumed schema family drifted");
  assertSortedUnique(manifest.source.input_event_ids, "manifest.source.input_event_ids");
  assertSortedUnique(manifest.source.evidence_event_ids, "manifest.source.evidence_event_ids", { allowEmpty: true });
  assertSortedUnique(manifest.source.lifecycle_event_ids, "manifest.source.lifecycle_event_ids", { allowEmpty: true });
  for (const [at, values] of [
    ["input_event_ids", manifest.source.input_event_ids],
    ["evidence_event_ids", manifest.source.evidence_event_ids],
    ["lifecycle_event_ids", manifest.source.lifecycle_event_ids],
  ] as const) for (const [index, eventId] of values.entries()) assertSha256(eventId, `manifest.source.${at}[${index}]`);
  for (const key of ["proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "non_proposition_event_consumed_count"] as const) assertCount(manifest.source[key], `manifest.source.${key}`);
  if (manifest.source.input_event_ids_hash !== jcsSha256Hex(manifest.source.input_event_ids)
    || manifest.source.evidence_event_ids_hash !== jcsSha256Hex(manifest.source.evidence_event_ids)
    || manifest.source.lifecycle_event_ids_hash !== jcsSha256Hex(manifest.source.lifecycle_event_ids)
    || manifest.source.source_resolution_inventory_hash !== jcsSha256Hex(manifest.source.source_resolution_inventory)) {
    fail("PROPOSITION_POLICY_PUSH_HASH_INVALID", "source ID or resolution inventory hash mismatch");
  }
  const expectedInputIds = [manifest.epoch.genesis_event_id, ...manifest.source.evidence_event_ids, ...manifest.source.lifecycle_event_ids].sort(compareCodeUnits);
  if (manifest.source.proposition_event_count !== manifest.source.input_event_ids.length
    || manifest.source.proposition_event_count !== manifest.source.proposition_genesis_count + manifest.source.proposition_evidence_count + manifest.source.proposition_lifecycle_count
    || manifest.source.proposition_genesis_count !== 1
    || manifest.source.proposition_evidence_count !== manifest.source.evidence_event_ids.length
    || manifest.source.proposition_lifecycle_count !== manifest.source.lifecycle_event_ids.length
    || !sameOrderedStrings(expectedInputIds, manifest.source.input_event_ids)
    || new Set(expectedInputIds).size !== expectedInputIds.length) {
    fail("PROPOSITION_POLICY_PUSH_COUNT_INVALID", "source proposition counts or exact event partition disagree");
  }
  validateSourceResolutionInventory(manifest);
  for (const [key, value] of Object.entries(manifest.source)) if (key.endsWith("_sha256")) assertSha256(value, `manifest.source.${key}`);
  assertSha256(manifest.source.source_resolution_inventory_hash, "manifest.source.source_resolution_inventory_hash");
  assertSha256(manifest.bundle_hash, "manifest.bundle_hash");
  if (canonicalizeJcs(manifest.exclusion_precedence) !== canonicalizeJcs(PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE)) fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", "exclusion precedence drifted");
  for (const [index, row] of manifest.exclusion_precedence.entries()) {
    assertExactKeys(asRecord(row), ["rank", "stage", "reason_codes"], `manifest.exclusion_precedence[${index}]`);
  }
  if (manifest.artifacts.length !== ARTIFACT_NAMES.length) fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", "artifact row cardinality invalid");
  for (const [index, row] of manifest.artifacts.entries()) {
    assertExactKeys(asRecord(row), ["name", "sha256", "bytes"], `manifest.artifacts[${index}]`);
    if (row.name !== ARTIFACT_NAMES[index]) fail("PROPOSITION_POLICY_PUSH_ORDER_INVALID", "artifact rows must be code-unit sorted");
    assertSha256(row.sha256, `manifest.artifacts[${index}].sha256`);
    assertCount(row.bytes, `manifest.artifacts[${index}].bytes`);
  }
  for (const [key, value] of Object.entries(manifest.result)) assertCount(value, `manifest.result.${key}`);
}

function validateSourceResolutionInventory(manifest: PropositionPolicyPushManifest): void {
  const inventory = manifest.source.source_resolution_inventory;
  if (!Array.isArray(inventory)) fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "source resolution inventory must be an array");
  const sourceIds = inventory.map((row) => row.source_event_id);
  assertSortedUnique(sourceIds, "manifest.source.source_resolution_inventory[].source_event_id", { allowEmpty: true });
  if (!sameOrderedStrings(sourceIds, manifest.source.evidence_event_ids)) {
    fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "source resolution inventory must exactly cover evidence IDs");
  }
  const evidenceSet = new Set(manifest.source.evidence_event_ids);
  const lifecycleSet = new Set(manifest.source.lifecycle_event_ids);
  const claimedLifecycleIds: string[] = [];
  for (const [index, resolution] of inventory.entries()) {
    const at = `manifest.source.source_resolution_inventory[${index}]`;
    assertExactKeys(asRecord(resolution), ["source_event_id", "statement_sha256", "language", "modality", "effective_facets", "lifecycle"], at);
    assertExactKeys(asRecord(resolution.lifecycle), ["disposition", "activation", "lineage_event_ids", "lineage", "terminal_event_id", "superseded_by_event_id"], `${at}.lifecycle`);
    assertSha256(resolution.source_event_id, `${at}.source_event_id`);
    assertSha256(resolution.statement_sha256, `${at}.statement_sha256`);
    if (typeof resolution.language !== "string" || !resolution.language.trim()) fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", `${at}.language is invalid`);
    validatePropositionEvidenceBody({
      event_schema_version: "proposition-evidence-event/v1",
      event_type: "proposition_observed",
      producer: { name: "pi-astack.proposition-policy-push-source-resolution-validator", version: "v1" },
      epoch: manifest.epoch,
      proposition: { modality: resolution.modality, statement: "statement-hash-commitment", language: resolution.language },
      facets: resolution.effective_facets,
    });
    assertUnique(resolution.lifecycle.lineage_event_ids, `${at}.lifecycle.lineage_event_ids`);
    if (resolution.lifecycle.lineage.length !== resolution.lifecycle.lineage_event_ids.length) fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", `${at} lifecycle lineage count mismatch`);
    let currentId = resolution.source_event_id;
    let currentKind: "evidence" | "retract" | "rescope" | "supersede" | "archive" | "reactivate" = "evidence";
    let expectedDisposition: PropositionEffectiveDisposition = "active";
    let expectedActivation: "original" | "reactivated" = "original";
    let expectedSupersededBy: string | null = null;
    for (const [lineageIndex, lineage] of resolution.lifecycle.lineage.entries()) {
      const lineageAt = `${at}.lifecycle.lineage[${lineageIndex}]`;
      assertExactKeys(asRecord(lineage), ["event_id", "operation", "state_target_event_id", "replacement_event_id"], lineageAt);
      assertSha256(lineage.event_id, `${lineageAt}.event_id`);
      assertSha256(lineage.state_target_event_id, `${lineageAt}.state_target_event_id`);
      if (lineage.replacement_event_id !== null) assertSha256(lineage.replacement_event_id, `${lineageAt}.replacement_event_id`);
      if (lineage.operation === "cutover" || !(lineage.operation in PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX)) fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", `${lineageAt}.operation is invalid`);
      const operation = lineage.operation as "retract" | "rescope" | "supersede" | "archive" | "reactivate";
      const matrix = PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX[operation];
      if (!(matrix.state_target_kinds as readonly string[]).includes(currentKind)
        || lineage.state_target_event_id !== currentId
        || lineage.event_id !== resolution.lifecycle.lineage_event_ids[lineageIndex]
        || !lifecycleSet.has(lineage.event_id)) {
        fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "lifecycle lineage is foreign, reordered, or gapped", { sourceEventId: resolution.source_event_id, lineageIndex });
      }
      if (operation === "supersede") {
        if (lineage.replacement_event_id === null
          || !evidenceSet.has(lineage.replacement_event_id)
          || lineage.replacement_event_id === resolution.source_event_id) {
          fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "supersede replacement is missing or foreign", { sourceEventId: resolution.source_event_id, lineageIndex });
        }
        expectedDisposition = "superseded";
        expectedSupersededBy = lineage.replacement_event_id;
      } else {
        if (lineage.replacement_event_id !== null) fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "non-supersede lineage has a replacement event", { sourceEventId: resolution.source_event_id, lineageIndex });
        if (operation === "retract") expectedDisposition = "retracted";
        else if (operation === "archive") expectedDisposition = "archived";
        else {
          expectedDisposition = "active";
          if (operation === "reactivate") expectedActivation = "reactivated";
        }
        expectedSupersededBy = null;
      }
      currentId = lineage.event_id;
      currentKind = operation;
      claimedLifecycleIds.push(lineage.event_id);
    }
    if (resolution.lifecycle.terminal_event_id !== currentId
      || resolution.lifecycle.disposition !== expectedDisposition
      || resolution.lifecycle.activation !== expectedActivation
      || resolution.lifecycle.superseded_by_event_id !== expectedSupersededBy) {
      fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "lifecycle terminal, disposition, activation, or supersede commitment is inconsistent", { sourceEventId: resolution.source_event_id });
    }
    assertSha256(resolution.lifecycle.terminal_event_id, `${at}.lifecycle.terminal_event_id`);
    if (resolution.lifecycle.superseded_by_event_id !== null) assertSha256(resolution.lifecycle.superseded_by_event_id, `${at}.lifecycle.superseded_by_event_id`);
  }
  claimedLifecycleIds.sort(compareCodeUnits);
  if (!sameOrderedStrings(claimedLifecycleIds, manifest.source.lifecycle_event_ids)) {
    fail("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", "source resolution lineages must exactly partition lifecycle event IDs", { claimedLifecycleIds, lifecycleEventIds: manifest.source.lifecycle_event_ids });
  }
}

function validateEntryAgainstSourceResolution(entry: PropositionPolicyPushEntry, resolution: PropositionPolicyPushSourceResolution): void {
  const expectedLifecycle = {
    disposition: resolution.lifecycle.disposition,
    activation: resolution.lifecycle.activation,
    lineage_event_ids: resolution.lifecycle.lineage_event_ids,
    lineage: resolution.lifecycle.lineage,
    terminal_event_id: resolution.lifecycle.terminal_event_id,
  };
  if (entry.source_event_id !== resolution.source_event_id
    || entry.source_epoch.epoch_id !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID
    || entry.source_epoch.genesis_event_id !== PROPOSITION_POLICY_PUSH_FIXED_GENESIS_EVENT_ID
    || entry.language !== resolution.language
    || entry.modality !== resolution.modality
    || sha256Hex(entry.statement) !== resolution.statement_sha256
    || canonicalizeJcs(entry.effective_facets) !== canonicalizeJcs(resolution.effective_facets)
    || canonicalizeJcs(entry.lifecycle) !== canonicalizeJcs(expectedLifecycle)) {
    fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry does not exactly match its source resolution commitment", { sourceEventId: resolution.source_event_id });
  }
}

function validateDocument(value: unknown, schema: string, arrayKey: string, at: string): void {
  const document = asRecord(value);
  assertExactKeys(document, ["schema_version", "epoch_id", "genesis_event_id", arrayKey], at);
  if (document.schema_version !== schema || !Array.isArray(document[arrayKey])) fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", `${at} document schema or array invalid`);
}

function validateEntry(entry: PropositionPolicyPushEntry): void {
  assertExactKeys(asRecord(entry), ["schema_version", "record_hash_scope", "record_hash", "source_event_id", "source_epoch", "candidate_face", "candidate_semantics", "statement", "language", "modality", "effective_facets", "lifecycle"], "entry");
  assertExactKeys(asRecord(entry.source_epoch), ["epoch_id", "genesis_event_id"], "entry.source_epoch");
  assertExactKeys(asRecord(entry.lifecycle), ["disposition", "activation", "lineage_event_ids", "lineage", "terminal_event_id"], "entry.lifecycle");
  if (entry.schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_ENTRY_SCHEMA
    || entry.candidate_face !== "policy_push"
    || entry.candidate_semantics !== "relevance_only_no_injection_verdict"
    || entry.modality !== "normative"
    || entry.lifecycle.disposition !== "active") {
    fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry identity or relevance-only semantics drifted");
  }
  assertRecordHash(asRecord(entry), "entry");
  assertSha256(entry.source_event_id, "entry.source_event_id");
  assertSha256(entry.source_epoch.genesis_event_id, "entry.source_epoch.genesis_event_id");
  if (entry.source_epoch.epoch_id !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID) fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry epoch invalid");
  assertSha256(entry.lifecycle.terminal_event_id, "entry.lifecycle.terminal_event_id");
  if (typeof entry.statement !== "string" || !entry.statement.trim() || typeof entry.language !== "string" || !entry.language.trim()) fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry statement/language invalid");
  validatePropositionEvidenceBody({
    event_schema_version: "proposition-evidence-event/v1",
    event_type: "proposition_observed",
    producer: { name: "pi-astack.proposition-policy-push-shadow-validator", version: "v1" },
    epoch: entry.source_epoch,
    proposition: { modality: entry.modality, statement: entry.statement, language: entry.language },
    facets: entry.effective_facets,
  });
  if (firstExclusion({
    proposition: { modality: entry.modality },
    effective_facets: entry.effective_facets,
    effective_scope_resolution: scopeIsResolved(entry.effective_facets.spatial_scope) ? "resolved" : "unresolved",
    disposition: entry.lifecycle.disposition,
  })) fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry does not satisfy the relevance filter");
  assertUnique(entry.lifecycle.lineage_event_ids, "entry.lifecycle.lineage_event_ids");
  if (entry.lifecycle.lineage.length !== entry.lifecycle.lineage_event_ids.length) fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry lifecycle lineage count mismatch");
  for (const [index, lineage] of entry.lifecycle.lineage.entries()) {
    assertExactKeys(asRecord(lineage), ["event_id", "operation", "state_target_event_id", "replacement_event_id"], `entry.lifecycle.lineage[${index}]`);
    assertSha256(lineage.event_id, `entry.lifecycle.lineage[${index}].event_id`);
    assertSha256(lineage.state_target_event_id, `entry.lifecycle.lineage[${index}].state_target_event_id`);
    if (lineage.replacement_event_id !== null) assertSha256(lineage.replacement_event_id, `entry.lifecycle.lineage[${index}].replacement_event_id`);
    if (!["retract", "rescope", "supersede", "archive", "reactivate"].includes(lineage.operation) || lineage.event_id !== entry.lifecycle.lineage_event_ids[index]) fail("PROPOSITION_POLICY_PUSH_ENTRY_INVALID", "entry lifecycle lineage operation/id invalid");
  }
}

function validateExclusion(exclusion: PropositionPolicyPushExclusion): void {
  assertExactKeys(asRecord(exclusion), ["schema_version", "record_hash_scope", "record_hash", "source_event_id", "filter_stage", "reason_code"], "exclusion");
  if (exclusion.schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_EXCLUSION_SCHEMA) fail("PROPOSITION_POLICY_PUSH_EXCLUSION_INVALID", "exclusion schema invalid");
  assertRecordHash(asRecord(exclusion), "exclusion");
  assertSha256(exclusion.source_event_id, "exclusion.source_event_id");
  assertReasonStage(exclusion.reason_code, exclusion.filter_stage);
}

function validateDiagnostic(diagnostic: PropositionPolicyPushDiagnostic): void {
  assertExactKeys(asRecord(diagnostic), ["schema_version", "record_hash_scope", "record_hash", "code", "severity", "source_event_id", "filter_stage", "reason_code"], "diagnostic");
  if (diagnostic.schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_DIAGNOSTIC_SCHEMA || diagnostic.code !== "POLICY_CANDIDATE_EXCLUDED" || diagnostic.severity !== "info") {
    fail("PROPOSITION_POLICY_PUSH_DIAGNOSTIC_INVALID", "diagnostic schema/code/severity invalid");
  }
  assertRecordHash(asRecord(diagnostic), "diagnostic");
  assertSha256(diagnostic.source_event_id, "diagnostic.source_event_id");
  assertReasonStage(diagnostic.reason_code, diagnostic.filter_stage);
}

type PolicyFilterState = Pick<ResolvedPropositionState, "disposition" | "effective_facets" | "effective_scope_resolution"> & {
  proposition: Pick<ResolvedPropositionState["proposition"], "modality">;
};

function firstExclusion(state: PolicyFilterState): { stage: PropositionPolicyPushExclusionStage; reason: PropositionPolicyPushExclusionReason } | null {
  const lifecycleReason = lifecycleExclusion(state.disposition);
  if (lifecycleReason) return { stage: "lifecycle", reason: lifecycleReason };
  if (!isAttestedAuthority(state.effective_facets.provenance_authority)) return { stage: "safety", reason: "safety_authority_not_attested" };
  if (state.effective_scope_resolution !== "resolved") return { stage: "scope", reason: "scope_unresolved" };
  const temporal = state.effective_facets.temporal_horizon;
  if (temporal.horizon !== "durable" || temporal.valid_from !== null || temporal.valid_until !== null) return { stage: "temporal", reason: "temporal_not_durable" };
  const sensitivity = state.effective_facets.sensitivity;
  if (sensitivity.classification !== "public" || sensitivity.handling !== "none") return { stage: "sensitivity", reason: "sensitivity_not_public" };
  const contestability = state.effective_facets.contestability;
  if (contestability.status !== "uncontested" || contestability.counterevidence_event_ids.length !== 0) return { stage: "contestability", reason: "contestability_not_uncontested" };
  const maturity = state.effective_facets.maturity;
  if (maturity.state !== "accepted" || maturity.review_state !== "reviewed") return { stage: "maturity", reason: "maturity_not_accepted_reviewed" };
  if (state.proposition.modality !== "normative") return { stage: "modality", reason: "modality_not_normative" };
  if (!state.effective_facets.consumer_hints.policy) return { stage: "policy_hint", reason: "consumer_hints_policy_false" };
  return null;
}

function lifecycleExclusion(disposition: PropositionEffectiveDisposition): PropositionPolicyPushExclusionReason | null {
  if (disposition === "archived") return "lifecycle_archived";
  if (disposition === "retracted") return "lifecycle_retracted";
  if (disposition === "superseded") return "lifecycle_superseded";
  return null;
}

function isAttestedAuthority(authority: PropositionFacets["provenance_authority"]): boolean {
  return (authority.source_kind === "user" && authority.authority_kind === "user_attested")
    || (authority.source_kind === "operator" && authority.authority_kind === "operator_attested");
}

function scopeIsResolved(scope: PropositionFacets["spatial_scope"]): boolean {
  if (scope.scope_level === "global") return scope.project_id === null && scope.domain === null;
  if (scope.scope_level === "project") return typeof scope.project_id === "string" && scope.project_id.length > 0 && scope.domain === null;
  if (scope.scope_level === "domain") return typeof scope.domain === "string" && scope.domain.length > 0;
  return false;
}

function assertReasonStage(reason: PropositionPolicyPushExclusionReason, stage: PropositionPolicyPushExclusionStage): void {
  const row = PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE.find((candidate) => candidate.stage === stage);
  if (!row || !(row.reason_codes as readonly string[]).includes(reason)) fail("PROPOSITION_POLICY_PUSH_EXCLUSION_INVALID", "reason/stage pair invalid", { reason, stage });
}

function withRecordHash<T extends Readonly<Record<string, unknown>>>(base: T): T & { record_hash: string } {
  return deepFreeze({ ...base, record_hash: jcsSha256Hex(base) });
}

function assertRecordHash(value: Readonly<Record<string, unknown>>, at: string): void {
  if (value.record_hash_scope !== RECORD_HASH_SCOPE) fail("PROPOSITION_POLICY_PUSH_HASH_INVALID", `${at} record hash scope invalid`);
  assertSha256(value.record_hash, `${at}.record_hash`);
  const base = { ...value };
  delete base.record_hash;
  if (jcsSha256Hex(base) !== value.record_hash) fail("PROPOSITION_POLICY_PUSH_HASH_INVALID", `${at} record hash mismatch`);
}

function assertStatementIsolation(bytes: string, statements: readonly string[], at: string): void {
  for (const statement of statements) if (bytes.includes(statement)) fail("PROPOSITION_POLICY_PUSH_STATEMENT_LEAK", `${at} contains source statement text`);
}

function assertNoStatementKey(value: unknown, at: string): void {
  walkKeys(value, at, (normalized, keyAt) => {
    if (normalized === "statement") fail("PROPOSITION_POLICY_PUSH_STATEMENT_LEAK", `${keyAt} contains a statement field`);
  });
}

function assertNoManifestDeploymentKeys(value: unknown): void {
  walkKeys(value, "manifest", (normalized, keyAt) => {
    if (FORBIDDEN_MANIFEST_DEPLOYMENT_KEYS.has(normalized) || normalized.endsWith("path") || normalized.endsWith("paths") || normalized.endsWith("placement")) {
      fail("PROPOSITION_POLICY_PUSH_DEPLOYMENT_FIELD", `${keyAt} is forbidden in the deployment-neutral semantic manifest`);
    }
  });
}

export function assertNoPropositionPolicyPushForbiddenKeys(value: unknown): void {
  assertNoForbiddenKeys(value);
}

function assertNoForbiddenKeys(value: unknown): void {
  walkKeys(value, "$root", (normalized, keyAt) => {
    if (FORBIDDEN_KEYS.has(normalized)) fail("PROPOSITION_POLICY_PUSH_FORBIDDEN_FIELD", `${keyAt} is forbidden in policy push shadow artifacts`);
  });
}

function walkKeys(value: unknown, at: string, visit: (normalized: string, keyAt: string) => void): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkKeys(child, `${at}[${index}]`, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyAt = `${at}.${key}`;
    visit(normalizeKey(key), keyAt);
    walkKeys(child, keyAt, visit);
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
}

function assertSortedUnique(values: readonly string[], at: string, options: { allowEmpty?: boolean } = {}): void {
  if (!options.allowEmpty && values.length === 0) fail("PROPOSITION_POLICY_PUSH_ORDER_INVALID", `${at} must not be empty`);
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0)) fail("PROPOSITION_POLICY_PUSH_ORDER_INVALID", `${at} must be unique and code-unit sorted`);
}

function assertUnique(values: readonly string[], at: string): void {
  if (new Set(values).size !== values.length) fail("PROPOSITION_POLICY_PUSH_ORDER_INVALID", `${at} must be unique`);
}

function assertSha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("PROPOSITION_POLICY_PUSH_HASH_INVALID", `${at} must be lowercase SHA-256`);
  return value;
}

function assertCount(value: unknown, at: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", `${at} must be a non-negative safe integer`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", "expected object");
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  return `${canonicalizeJcs(value)}\n`;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyPushShadowError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const __TEST = Object.freeze({ projectValidatedWholeL1, firstExclusion });
