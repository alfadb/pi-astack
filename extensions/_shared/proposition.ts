import { canonicalizeJcs, jcsSha256Hex } from "./jcs";

export const PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA = "proposition-evidence-envelope/v1" as const;
export const PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA = "proposition-lifecycle-envelope/v1" as const;
export const PROPOSITION_GENESIS_ENVELOPE_SCHEMA = "proposition-genesis-envelope/v1" as const;

export const PROPOSITION_EVIDENCE_BODY_SCHEMA = "proposition-evidence-event/v1" as const;
export const PROPOSITION_LIFECYCLE_BODY_SCHEMA = "proposition-lifecycle-event/v1" as const;
export const PROPOSITION_GENESIS_BODY_SCHEMA = "proposition-genesis-event/v1" as const;

export const PROPOSITION_SCHEMA_CONTRACT_PRODUCER = "pi-astack.proposition-schema-contract" as const;
export const PROPOSITION_PRODUCTION_GENESIS_PRODUCER = "pi-astack.proposition-production-genesis-writer" as const;
export const PROPOSITION_PRODUCTION_GENESIS_PRODUCER_VERSION = "adr0040-production-genesis-writer/v1" as const;
export const PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID = "adr0040-production-genesis-v1" as const;
export const PROPOSITION_SCHEMA_CONTRACT_SCHEMA = "proposition-schema-contract/v1" as const;
export const PROPOSITION_GENESIS_BINDING_SCHEMA = "proposition-genesis-binding/v1" as const;
export const PROPOSITION_GENESIS_BINDING_MANIFEST_SCHEMA = "proposition-genesis-binding-manifest/v1" as const;

export const PROPOSITION_MODALITIES = ["descriptive", "normative", "meta-lifecycle"] as const;
export type PropositionModality = typeof PROPOSITION_MODALITIES[number];

export const PROPOSITION_LIFECYCLE_OPERATIONS = ["retract", "rescope", "supersede", "archive", "reactivate", "cutover"] as const;
export type PropositionLifecycleOperation = typeof PROPOSITION_LIFECYCLE_OPERATIONS[number];

export const PROPOSITION_FACET_KEYS = [
  "provenance_authority",
  "spatial_scope",
  "temporal_horizon",
  "trigger",
  "maturity",
  "contestability",
  "confidence",
  "sensitivity",
  "consumer_hints",
  "lineage",
] as const;
export type PropositionFacetKey = typeof PROPOSITION_FACET_KEYS[number];

export interface PropositionProducerRef {
  name: string;
  version: string;
}

export interface PropositionEpochBinding {
  epoch_id: string;
  genesis_event_id: string;
}

export interface PropositionFacets {
  provenance_authority: {
    source_kind: "user" | "assistant" | "tool" | "file" | "system" | "projector" | "operator" | "unknown";
    authority_kind: "user_attested" | "operator_attested" | "observed" | "inferred" | "derived" | "unknown";
    source_event_id: string | null;
    quote_sha256: string | null;
  };
  spatial_scope: {
    scope_level: "global" | "project" | "domain" | "session" | "task" | "unknown";
    project_id: string | null;
    domain: string | null;
  };
  temporal_horizon: {
    horizon: "durable" | "bounded" | "session" | "task" | "unknown";
    valid_from: string | null;
    valid_until: string | null;
  };
  trigger: {
    trigger_kind: "user_directive" | "observation" | "correction" | "manual" | "system_event" | "unknown";
    trigger_ref: string | null;
  };
  maturity: {
    state: "draft" | "candidate" | "accepted" | "deprecated" | "unknown";
    review_state: "unreviewed" | "reviewed" | "disputed" | "unknown";
  };
  contestability: {
    status: "uncontested" | "contested" | "requires_review" | "unknown";
    counterevidence_event_ids: readonly string[];
  };
  confidence: {
    score: number;
    basis: "witnessed" | "inferred" | "derived" | "unknown";
  };
  sensitivity: {
    classification: "public" | "personal" | "sensitive" | "secret_adjacent" | "secret" | "unknown";
    handling: "none" | "redact" | "withhold" | "unknown";
  };
  consumer_hints: {
    retrieval: boolean;
    policy: boolean;
    notes: readonly string[];
  };
  lineage: {
    causal_parents: readonly string[];
    derives_from: readonly string[];
    supersedes: readonly string[];
  };
}

export interface PropositionEvidenceBodyV1 {
  event_schema_version: typeof PROPOSITION_EVIDENCE_BODY_SCHEMA;
  event_type: "proposition_observed";
  producer: PropositionProducerRef;
  epoch: PropositionEpochBinding;
  proposition: {
    modality: PropositionModality;
    statement: string;
    language: string;
  };
  facets: PropositionFacets;
}

export interface PropositionLifecycleBodyV1 {
  event_schema_version: typeof PROPOSITION_LIFECYCLE_BODY_SCHEMA;
  event_type: PropositionLifecycleEventType;
  producer: PropositionProducerRef;
  epoch: PropositionEpochBinding;
  lifecycle: {
    operation: PropositionLifecycleOperation;
    modality: "meta-lifecycle";
    effect: "declared_only";
    target_event_ids: readonly string[];
    reason: string;
  };
  facets: PropositionFacets;
}

export interface PropositionSchemaContractRefV1 {
  schema_version: typeof PROPOSITION_SCHEMA_CONTRACT_SCHEMA;
  schema_contract_hash: string;
  envelope_schemas: readonly string[];
  body_schemas: readonly string[];
  event_types: readonly string[];
  producers: readonly string[];
}

export interface PropositionGenesisBindingManifestV1 {
  manifest_schema_version: typeof PROPOSITION_GENESIS_BINDING_MANIFEST_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object";
  epoch_id: string;
  registry: {
    registry_id: string;
    registry_path: "schemas/l1-schema-role-registry.json";
    registry_canonical_sha256: string;
    registry_file_sha256: string;
    hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of the validated l1-schema-role-registry/v1 object";
  };
  proposition_schema_contract: PropositionSchemaContractRefV1;
}

export interface PropositionGenesisBindingV1 {
  binding_schema_version: typeof PROPOSITION_GENESIS_BINDING_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  manifest_hash: string;
  manifest: PropositionGenesisBindingManifestV1;
}

interface PropositionGenesisBaseContractV1 {
  kind: "schema_contract" | "production_genesis";
  cutover_policy: "no_migration";
  production_genesis_required: true;
  p0_effect: "defined_inactive_only";
  legacy_domains: readonly string[];
  notes: string;
}

export interface PropositionSchemaContractGenesisContractV1 extends PropositionGenesisBaseContractV1 {
  kind: "schema_contract";
}

export interface PropositionProductionGenesisContractV1 extends PropositionGenesisBaseContractV1 {
  kind: "production_genesis";
  binding: PropositionGenesisBindingV1;
}

export interface PropositionGenesisBodyV1 {
  event_schema_version: typeof PROPOSITION_GENESIS_BODY_SCHEMA;
  event_type: "proposition_genesis_declared";
  producer: PropositionProducerRef;
  epoch: {
    epoch_id: string;
    genesis_scope: "schema_contract" | "production";
  };
  contract: PropositionSchemaContractGenesisContractV1 | PropositionProductionGenesisContractV1;
}

export type PropositionLifecycleEventType =
  | "proposition_retract_declared"
  | "proposition_rescope_declared"
  | "proposition_supersede_declared"
  | "proposition_archive_declared"
  | "proposition_reactivate_declared"
  | "proposition_cutover_declared";

export type PropositionBodyV1 = PropositionEvidenceBodyV1 | PropositionLifecycleBodyV1 | PropositionGenesisBodyV1;

export interface PropositionL1Envelope<Body extends PropositionBodyV1 = PropositionBodyV1> {
  schema: typeof PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA | typeof PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA | typeof PROPOSITION_GENESIS_ENVELOPE_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: Body;
}

export class PropositionValidationError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionValidationError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

const LIFECYCLE_EVENT_TO_OPERATION: Record<PropositionLifecycleEventType, PropositionLifecycleOperation> = {
  proposition_retract_declared: "retract",
  proposition_rescope_declared: "rescope",
  proposition_supersede_declared: "supersede",
  proposition_archive_declared: "archive",
  proposition_reactivate_declared: "reactivate",
  proposition_cutover_declared: "cutover",
};

const FORBIDDEN_CANONICAL_KEYS = new Set([
  "injectmode",
  "always",
  "listed",
  "sessionstarteligibility",
  "sessionstart",
  "priority",
]);

const GENESIS_SCOPE_TO_CONTRACT_KIND: Record<PropositionGenesisBodyV1["epoch"]["genesis_scope"], PropositionGenesisBodyV1["contract"]["kind"]> = {
  schema_contract: "schema_contract",
  production: "production_genesis",
};

export function isPropositionEnvelopeSchema(schema: string): boolean {
  return schema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA
    || schema === PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA
    || schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA;
}

export function validatePropositionBodyForEnvelope(envelopeSchema: string, body: unknown): PropositionBodyV1 {
  if (envelopeSchema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA) return validatePropositionEvidenceBody(body);
  if (envelopeSchema === PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA) return validatePropositionLifecycleBody(body);
  if (envelopeSchema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA) return validatePropositionGenesisBody(body);
  throw failure("PROPOSITION_SCHEMA_UNKNOWN", `unknown proposition envelope schema: ${envelopeSchema}`);
}

export function validatePropositionEvidenceBody(input: unknown): PropositionEvidenceBodyV1 {
  assertNoForbiddenCanonicalKeys(input);
  const body = record(input, "PROPOSITION_BODY_INVALID", "proposition evidence body must be an object");
  exactKeys(body, ["event_schema_version", "event_type", "producer", "epoch", "proposition", "facets"], "evidence body");
  exact(body.event_schema_version, PROPOSITION_EVIDENCE_BODY_SCHEMA, "event_schema_version");
  exact(body.event_type, "proposition_observed", "event_type");
  validateProducer(body.producer);
  validateEpochBinding(body.epoch);
  validatePropositionStatement(body.proposition);
  validateFacetSet(body.facets, { lifecycleOperation: null });
  return deepFreeze(body as unknown as PropositionEvidenceBodyV1);
}

export function validatePropositionLifecycleBody(input: unknown): PropositionLifecycleBodyV1 {
  assertNoForbiddenCanonicalKeys(input);
  const body = record(input, "PROPOSITION_BODY_INVALID", "proposition lifecycle body must be an object");
  exactKeys(body, ["event_schema_version", "event_type", "producer", "epoch", "lifecycle", "facets"], "lifecycle body");
  exact(body.event_schema_version, PROPOSITION_LIFECYCLE_BODY_SCHEMA, "event_schema_version");
  const eventType = oneOf(body.event_type, Object.keys(LIFECYCLE_EVENT_TO_OPERATION) as PropositionLifecycleEventType[], "event_type");
  const operation = LIFECYCLE_EVENT_TO_OPERATION[eventType];
  validateProducer(body.producer);
  validateEpochBinding(body.epoch);
  const lifecycle = validateLifecycleContract(body.lifecycle, operation);
  const facets = validateFacetSet(body.facets, { lifecycleOperation: operation });
  validateLifecycleTargetParentConsistency(operation, lifecycle.target_event_ids, facets.lineage.causal_parents);
  return deepFreeze(body as unknown as PropositionLifecycleBodyV1);
}

export function validatePropositionGenesisBody(input: unknown): PropositionGenesisBodyV1 {
  assertNoForbiddenCanonicalKeys(input);
  const body = record(input, "PROPOSITION_BODY_INVALID", "proposition genesis body must be an object");
  exactKeys(body, ["event_schema_version", "event_type", "producer", "epoch", "contract"], "genesis body");
  exact(body.event_schema_version, PROPOSITION_GENESIS_BODY_SCHEMA, "event_schema_version");
  exact(body.event_type, "proposition_genesis_declared", "event_type");
  const producer = validateProducer(body.producer);
  const epoch = record(body.epoch, "PROPOSITION_EPOCH_INVALID", "genesis epoch must be an object");
  exactKeys(epoch, ["epoch_id", "genesis_scope"], "genesis epoch");
  const epochId = stableId(epoch.epoch_id, "epoch.epoch_id");
  const genesisScope = oneOf(epoch.genesis_scope, ["schema_contract", "production"], "epoch.genesis_scope");
  const contract = record(body.contract, "PROPOSITION_GENESIS_INVALID", "genesis contract must be an object");
  const contractKind = oneOf(contract.kind, ["schema_contract", "production_genesis"], "contract.kind");
  const expectedKind = GENESIS_SCOPE_TO_CONTRACT_KIND[genesisScope];
  if (contractKind !== expectedKind) {
    throw failure("PROPOSITION_GENESIS_SCOPE_MISMATCH", `epoch.genesis_scope=${genesisScope} requires contract.kind=${expectedKind}`, { actual: contractKind });
  }
  const contractKeys = contractKind === "production_genesis"
    ? ["kind", "cutover_policy", "production_genesis_required", "p0_effect", "legacy_domains", "notes", "binding"]
    : ["kind", "cutover_policy", "production_genesis_required", "p0_effect", "legacy_domains", "notes"];
  exactKeys(contract, contractKeys, "genesis contract");
  validateGenesisProducer(producer.name, contractKind);
  exact(contract.cutover_policy, "no_migration", "contract.cutover_policy");
  exact(contract.production_genesis_required, true, "contract.production_genesis_required");
  exact(contract.p0_effect, "defined_inactive_only", "contract.p0_effect");
  uniqueStringArray(contract.legacy_domains, "contract.legacy_domains");
  nonEmptyString(contract.notes, "contract.notes");
  if (contractKind === "production_genesis") validateGenesisBinding(contract.binding, epochId);
  return deepFreeze(body as unknown as PropositionGenesisBodyV1);
}

export function buildPropositionEnvelope<Body extends PropositionBodyV1>(schema: PropositionL1Envelope<Body>["schema"], body: Body): PropositionL1Envelope<Body> {
  const validated = validatePropositionBodyForEnvelope(schema, body) as Body;
  const bodyHash = jcsSha256Hex(validated);
  return deepFreeze({
    schema,
    canonicalization: "RFC8785-JCS" as const,
    hash_alg: "sha256" as const,
    event_id: bodyHash,
    body_hash: bodyHash,
    body: validated,
  });
}

export function canonicalPropositionEnvelopeJson(envelope: PropositionL1Envelope): string {
  return `${canonicalizeJcs(envelope)}\n`;
}

function validateProducer(input: unknown): PropositionProducerRef {
  const producer = record(input, "PROPOSITION_PRODUCER_INVALID", "producer must be an object");
  exactKeys(producer, ["name", "version"], "producer");
  nonEmptyString(producer.name, "producer.name");
  nonEmptyString(producer.version, "producer.version");
  return producer as unknown as PropositionProducerRef;
}

function validateGenesisProducer(producerName: string, contractKind: PropositionGenesisBodyV1["contract"]["kind"]): void {
  const expected = contractKind === "production_genesis" ? PROPOSITION_PRODUCTION_GENESIS_PRODUCER : PROPOSITION_SCHEMA_CONTRACT_PRODUCER;
  if (producerName !== expected) {
    throw failure("PROPOSITION_PRODUCER_INVALID", `${contractKind} genesis requires producer.name=${expected}`, { actual: producerName });
  }
}

function validateGenesisBinding(input: unknown, epochId: string): PropositionGenesisBindingV1 {
  const binding = record(input, "PROPOSITION_GENESIS_BINDING_INVALID", "production genesis binding must be an object");
  exactKeys(binding, ["binding_schema_version", "canonicalization", "hash_algorithm", "manifest_hash", "manifest"], "genesis binding");
  exact(binding.binding_schema_version, PROPOSITION_GENESIS_BINDING_SCHEMA, "binding.binding_schema_version");
  exact(binding.canonicalization, "RFC8785-JCS", "binding.canonicalization");
  exact(binding.hash_algorithm, "sha256", "binding.hash_algorithm");
  sha256HexString(binding.manifest_hash, "binding.manifest_hash");

  const manifest = record(binding.manifest, "PROPOSITION_GENESIS_BINDING_INVALID", "binding manifest must be an object");
  exactKeys(manifest, ["manifest_schema_version", "canonicalization", "hash_algorithm", "hash_scope", "epoch_id", "registry", "proposition_schema_contract"], "binding manifest");
  exact(manifest.manifest_schema_version, PROPOSITION_GENESIS_BINDING_MANIFEST_SCHEMA, "binding.manifest.manifest_schema_version");
  exact(manifest.canonicalization, "RFC8785-JCS", "binding.manifest.canonicalization");
  exact(manifest.hash_algorithm, "sha256", "binding.manifest.hash_algorithm");
  exact(manifest.hash_scope, "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object", "binding.manifest.hash_scope");
  exact(manifest.epoch_id, epochId, "binding.manifest.epoch_id");

  const registry = record(manifest.registry, "PROPOSITION_GENESIS_BINDING_INVALID", "binding manifest registry must be an object");
  exactKeys(registry, ["registry_id", "registry_path", "registry_canonical_sha256", "registry_file_sha256", "hash_scope"], "binding manifest registry");
  stableId(registry.registry_id, "binding.manifest.registry.registry_id");
  exact(registry.registry_path, "schemas/l1-schema-role-registry.json", "binding.manifest.registry.registry_path");
  sha256HexString(registry.registry_canonical_sha256, "binding.manifest.registry.registry_canonical_sha256");
  sha256HexString(registry.registry_file_sha256, "binding.manifest.registry.registry_file_sha256");
  exact(registry.hash_scope, "sha256 over RFC8785-JCS UTF-8 bytes of the validated l1-schema-role-registry/v1 object", "binding.manifest.registry.hash_scope");

  const schemaContract = record(manifest.proposition_schema_contract, "PROPOSITION_GENESIS_BINDING_INVALID", "binding manifest schema contract must be an object");
  exactKeys(schemaContract, ["schema_version", "schema_contract_hash", "envelope_schemas", "body_schemas", "event_types", "producers"], "binding manifest schema contract");
  exact(schemaContract.schema_version, PROPOSITION_SCHEMA_CONTRACT_SCHEMA, "binding.manifest.proposition_schema_contract.schema_version");
  sha256HexString(schemaContract.schema_contract_hash, "binding.manifest.proposition_schema_contract.schema_contract_hash");
  uniqueStringArray(schemaContract.envelope_schemas, "binding.manifest.proposition_schema_contract.envelope_schemas");
  uniqueStringArray(schemaContract.body_schemas, "binding.manifest.proposition_schema_contract.body_schemas");
  uniqueStringArray(schemaContract.event_types, "binding.manifest.proposition_schema_contract.event_types");
  uniqueStringArray(schemaContract.producers, "binding.manifest.proposition_schema_contract.producers");
  const computedManifestHash = jcsSha256Hex(manifest);
  if (binding.manifest_hash !== computedManifestHash) {
    throw failure("PROPOSITION_GENESIS_BINDING_HASH_MISMATCH", "binding.manifest_hash does not match RFC8785/JCS manifest hash", { expected: binding.manifest_hash as string, actual: computedManifestHash });
  }
  return binding as unknown as PropositionGenesisBindingV1;
}

function validateEpochBinding(input: unknown): PropositionEpochBinding {
  const epoch = record(input, "PROPOSITION_EPOCH_INVALID", "epoch binding must be an object");
  exactKeys(epoch, ["epoch_id", "genesis_event_id"], "epoch");
  stableId(epoch.epoch_id, "epoch.epoch_id");
  sha256HexString(epoch.genesis_event_id, "epoch.genesis_event_id");
  return epoch as unknown as PropositionEpochBinding;
}

function validatePropositionStatement(input: unknown): PropositionEvidenceBodyV1["proposition"] {
  const proposition = record(input, "PROPOSITION_BODY_INVALID", "proposition must be an object");
  exactKeys(proposition, ["modality", "statement", "language"], "proposition");
  oneOf(proposition.modality, PROPOSITION_MODALITIES, "proposition.modality");
  nonEmptyString(proposition.statement, "proposition.statement");
  nonEmptyString(proposition.language, "proposition.language");
  return proposition as unknown as PropositionEvidenceBodyV1["proposition"];
}

function validateLifecycleContract(input: unknown, expectedOperation: PropositionLifecycleOperation): PropositionLifecycleBodyV1["lifecycle"] {
  const lifecycle = record(input, "PROPOSITION_LIFECYCLE_INVALID", "lifecycle must be an object");
  exactKeys(lifecycle, ["operation", "modality", "effect", "target_event_ids", "reason"], "lifecycle");
  exact(lifecycle.operation, expectedOperation, "lifecycle.operation");
  exact(lifecycle.modality, "meta-lifecycle", "lifecycle.modality");
  exact(lifecycle.effect, "declared_only", "lifecycle.effect");
  const targets = shaArray(lifecycle.target_event_ids, "lifecycle.target_event_ids");
  if (expectedOperation !== "cutover" && targets.length === 0) {
    throw failure("PROPOSITION_LIFECYCLE_PARENT_REQUIRED", `${expectedOperation} lifecycle events require at least one target event`);
  }
  nonEmptyString(lifecycle.reason, "lifecycle.reason");
  return lifecycle as unknown as PropositionLifecycleBodyV1["lifecycle"];
}

function validateLifecycleTargetParentConsistency(
  operation: PropositionLifecycleOperation,
  targetEventIds: readonly string[],
  causalParents: readonly string[],
): void {
  if (operation === "cutover") {
    if (targetEventIds.length !== 0 || causalParents.length !== 0) {
      throw failure("PROPOSITION_LIFECYCLE_TARGET_PARENT_MISMATCH", "cutover lifecycle events must not target or parent existing L1 events");
    }
    return;
  }
  if (targetEventIds.length === 0 || causalParents.length === 0) {
    throw failure("PROPOSITION_LIFECYCLE_PARENT_REQUIRED", `${operation} lifecycle events require target_event_ids and causal parents`);
  }
  const parents = new Set(causalParents);
  const missing = targetEventIds.filter((target) => !parents.has(target));
  if (missing.length) {
    throw failure("PROPOSITION_LIFECYCLE_TARGET_PARENT_MISMATCH", `${operation} lifecycle target_event_ids must be a subset of facets.lineage.causal_parents`, { missing });
  }
}

function validateFacetSet(input: unknown, options: { lifecycleOperation: PropositionLifecycleOperation | null }): PropositionFacets {
  const facets = record(input, "PROPOSITION_FACET_INVALID", "facets must be an object");
  exactKeys(facets, PROPOSITION_FACET_KEYS, "facets");

  const provenance = record(facets.provenance_authority, "PROPOSITION_FACET_INVALID", "provenance_authority must be an object");
  exactKeys(provenance, ["source_kind", "authority_kind", "source_event_id", "quote_sha256"], "provenance_authority");
  oneOf(provenance.source_kind, ["user", "assistant", "tool", "file", "system", "projector", "operator", "unknown"], "provenance_authority.source_kind");
  oneOf(provenance.authority_kind, ["user_attested", "operator_attested", "observed", "inferred", "derived", "unknown"], "provenance_authority.authority_kind");
  nullableSha(provenance.source_event_id, "provenance_authority.source_event_id");
  nullableSha(provenance.quote_sha256, "provenance_authority.quote_sha256");

  const spatial = record(facets.spatial_scope, "PROPOSITION_FACET_INVALID", "spatial_scope must be an object");
  exactKeys(spatial, ["scope_level", "project_id", "domain"], "spatial_scope");
  oneOf(spatial.scope_level, ["global", "project", "domain", "session", "task", "unknown"], "spatial_scope.scope_level");
  nullableString(spatial.project_id, "spatial_scope.project_id");
  nullableString(spatial.domain, "spatial_scope.domain");

  const temporal = record(facets.temporal_horizon, "PROPOSITION_FACET_INVALID", "temporal_horizon must be an object");
  exactKeys(temporal, ["horizon", "valid_from", "valid_until"], "temporal_horizon");
  oneOf(temporal.horizon, ["durable", "bounded", "session", "task", "unknown"], "temporal_horizon.horizon");
  nullableIso8601(temporal.valid_from, "temporal_horizon.valid_from");
  nullableIso8601(temporal.valid_until, "temporal_horizon.valid_until");

  const trigger = record(facets.trigger, "PROPOSITION_FACET_INVALID", "trigger must be an object");
  exactKeys(trigger, ["trigger_kind", "trigger_ref"], "trigger");
  oneOf(trigger.trigger_kind, ["user_directive", "observation", "correction", "manual", "system_event", "unknown"], "trigger.trigger_kind");
  nullableString(trigger.trigger_ref, "trigger.trigger_ref");

  const maturity = record(facets.maturity, "PROPOSITION_FACET_INVALID", "maturity must be an object");
  exactKeys(maturity, ["state", "review_state"], "maturity");
  oneOf(maturity.state, ["draft", "candidate", "accepted", "deprecated", "unknown"], "maturity.state");
  oneOf(maturity.review_state, ["unreviewed", "reviewed", "disputed", "unknown"], "maturity.review_state");

  const contestability = record(facets.contestability, "PROPOSITION_FACET_INVALID", "contestability must be an object");
  exactKeys(contestability, ["status", "counterevidence_event_ids"], "contestability");
  oneOf(contestability.status, ["uncontested", "contested", "requires_review", "unknown"], "contestability.status");
  shaArray(contestability.counterevidence_event_ids, "contestability.counterevidence_event_ids");

  const confidence = record(facets.confidence, "PROPOSITION_FACET_INVALID", "confidence must be an object");
  exactKeys(confidence, ["score", "basis"], "confidence");
  finiteNumberBetween(confidence.score, 0, 1, "confidence.score");
  oneOf(confidence.basis, ["witnessed", "inferred", "derived", "unknown"], "confidence.basis");

  const sensitivity = record(facets.sensitivity, "PROPOSITION_FACET_INVALID", "sensitivity must be an object");
  exactKeys(sensitivity, ["classification", "handling"], "sensitivity");
  oneOf(sensitivity.classification, ["public", "personal", "sensitive", "secret_adjacent", "secret", "unknown"], "sensitivity.classification");
  oneOf(sensitivity.handling, ["none", "redact", "withhold", "unknown"], "sensitivity.handling");

  const hints = record(facets.consumer_hints, "PROPOSITION_FACET_INVALID", "consumer_hints must be an object");
  exactKeys(hints, ["retrieval", "policy", "notes"], "consumer_hints");
  boolean(hints.retrieval, "consumer_hints.retrieval");
  boolean(hints.policy, "consumer_hints.policy");
  uniqueStringArray(hints.notes, "consumer_hints.notes");

  const lineage = record(facets.lineage, "PROPOSITION_FACET_INVALID", "lineage must be an object");
  exactKeys(lineage, ["causal_parents", "derives_from", "supersedes"], "lineage");
  const causalParents = shaArray(lineage.causal_parents, "lineage.causal_parents");
  shaArray(lineage.derives_from, "lineage.derives_from");
  shaArray(lineage.supersedes, "lineage.supersedes");
  if (options.lifecycleOperation && options.lifecycleOperation !== "cutover" && causalParents.length === 0) {
    throw failure("PROPOSITION_LIFECYCLE_PARENT_REQUIRED", `${options.lifecycleOperation} lifecycle facets require causal parents`);
  }

  return facets as unknown as PropositionFacets;
}

function assertNoForbiddenCanonicalKeys(value: unknown, at = "$root"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenCanonicalKeys(item, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_CANONICAL_KEYS.has(normalized)) {
      throw failure("PROPOSITION_FORBIDDEN_CANONICAL_FIELD", `${at}.${key} is a projector-derived field, not a canonical proposition field`);
    }
    assertNoForbiddenCanonicalKeys(child, `${at}.${key}`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw failure("PROPOSITION_FACET_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
  }
}

function record(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(code, message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) throw failure("PROPOSITION_BODY_INVALID", `${at} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, at: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, at);
}

function stableId(value: unknown, at: string): string {
  const text = nonEmptyString(value, at);
  if (!/^[a-z0-9][a-z0-9_.:/-]{2,127}$/.test(text)) throw failure("PROPOSITION_EPOCH_INVALID", `${at} must be a stable explicit identity`);
  return text;
}

function sha256HexString(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure("PROPOSITION_EVENT_ID_INVALID", `${at} must be a lowercase SHA-256 event id`);
  return value;
}

function nullableSha(value: unknown, at: string): string | null {
  if (value === null) return null;
  return sha256HexString(value, at);
}

function shaArray(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value)) throw failure("PROPOSITION_EVENT_ID_INVALID", `${at} must be an array of event ids`);
  const output = value.map((item, index) => sha256HexString(item, `${at}[${index}]`));
  if (new Set(output).size !== output.length) throw failure("PROPOSITION_EVENT_ID_INVALID", `${at} must not contain duplicate event ids`);
  return Object.freeze(output);
}

function uniqueStringArray(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value)) throw failure("PROPOSITION_BODY_INVALID", `${at} must be a string array`);
  const output = value.map((item, index) => nonEmptyString(item, `${at}[${index}]`));
  if (new Set(output).size !== output.length) throw failure("PROPOSITION_BODY_INVALID", `${at} must not contain duplicate strings`);
  return Object.freeze(output);
}

function nullableIso8601(value: unknown, at: string): string | null {
  if (value === null) return null;
  const text = nonEmptyString(value, at);
  if (!isStrictRfc3339Utc(text)) throw failure("PROPOSITION_BODY_INVALID", `${at} must be a strict RFC3339 UTC timestamp or null`);
  return text;
}

function isStrictRfc3339Utc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value.includes(".") ? canonical === value : canonical === value.replace(/Z$/, ".000Z");
}

function finiteNumberBetween(value: unknown, min: number, max: number, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw failure("PROPOSITION_BODY_INVALID", `${at} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw failure("PROPOSITION_BODY_INVALID", `${at} must be boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw failure("PROPOSITION_BODY_INVALID", `${at} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function exact(value: unknown, expected: string | boolean, at: string): void {
  if (value !== expected) throw failure("PROPOSITION_BODY_INVALID", `${at} must equal ${String(expected)}`, { actual: value });
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionValidationError {
  return new PropositionValidationError(code, message, detail);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
