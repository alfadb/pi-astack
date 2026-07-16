import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  canonicalL1EnvelopeJson,
  defaultL1SchemaRegistryPath,
  expectedL1EventPath,
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  type L1SchemaRegistration,
  type L1SchemaRoleRegistry,
  type ValidatedL1ScanRecord,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import {
  PROPOSITION_GENESIS_BODY_SCHEMA,
  PROPOSITION_GENESIS_BINDING_MANIFEST_SCHEMA,
  PROPOSITION_GENESIS_BINDING_SCHEMA,
  PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
  PROPOSITION_PRODUCTION_GENESIS_PRODUCER_VERSION,
  PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
  buildPropositionEnvelope,
  validatePropositionGenesisBody,
  type PropositionGenesisBodyV1,
  type PropositionGenesisBindingManifestV1,
  type PropositionL1Envelope,
  type PropositionProductionGenesisContractV1,
  type PropositionSchemaContractRefV1,
} from "./proposition";

export const PROPOSITION_GENESIS_TUPLE_SCHEMA = "proposition-production-genesis-tuple/v1" as const;
export const PROPOSITION_SCHEMA_CONTRACT_REGISTRY_PATH = "schemas/l1-schema-role-registry.json" as const;
export const PROPOSITION_PRODUCTION_GENESIS_NOTES = "ADR0040 production genesis anchor for the no-migration proposition epoch. P0 effect is defined-inactive only; generic proposition writes, projection, runtime read flip, and legacy authority retirement require separate authorization." as const;

// These values are immutable provenance embedded in the production genesis event.
// Registry evolution after genesis must not reinterpret or invalidate that history.
export const PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING = {
  registry_id: "pi-astack-local-convergence-r9",
  registry_canonical_sha256: "6f82d86ccfadb9eefc89501febf7bd94cca8fd4bb45190e797c7ed4b911580e0",
  registry_file_sha256: "e89cb9009d7180bf1fab0fd285bc2832ec2d2a8f8d7663260eeb85182599f6d2",
  proposition_schema_contract_hash: "18bbb496bfc0ec977b916f8869dbbb6f9e3dcd72e8edd1a829a9f40832eee32a",
  binding_manifest_hash: "173b3ece666c5a18455d66e08480cf99c3e44ce8e604b0711f44d1fae7fe2a2f",
  proposition_schema_contract_ref: {
    schema_version: PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
    schema_contract_hash: "18bbb496bfc0ec977b916f8869dbbb6f9e3dcd72e8edd1a829a9f40832eee32a",
    envelope_schemas: [
      "proposition-evidence-envelope/v1",
      "proposition-genesis-envelope/v1",
      "proposition-lifecycle-envelope/v1",
      "proposition-projection-envelope/v1",
    ],
    body_schemas: [
      "proposition-evidence-event/v1",
      "proposition-genesis-event/v1",
      "proposition-lifecycle-event/v1",
    ],
    event_types: [
      "proposition_archive_declared",
      "proposition_cutover_declared",
      "proposition_genesis_declared",
      "proposition_observed",
      "proposition_reactivate_declared",
      "proposition_rescope_declared",
      "proposition_retract_declared",
      "proposition_supersede_declared",
    ],
    producers: [
      "pi-astack.proposition-production-genesis-writer",
      "pi-astack.proposition-schema-contract",
    ],
  },
} as const;

export interface PropositionSchemaContractEntryV1 {
  envelope_schema: string;
  body_schema: string | null;
  domain: "proposition";
  role: "canonical" | "evidence" | "meta";
  phase: "active" | "legacy_read_only" | "phase_disabled" | "defined_inactive";
  write_enabled: boolean;
  fold_eligible: boolean;
  event_types: readonly string[];
  producers: readonly string[];
}

export interface PropositionSchemaContractV1 {
  schema_version: typeof PROPOSITION_SCHEMA_CONTRACT_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this proposition schema contract object";
  registry_id: string;
  storage_root_relative_path: "l1/events/sha256";
  entries: readonly PropositionSchemaContractEntryV1[];
}

export interface CurrentPropositionSchemaAnchors {
  registry_id: string;
  registry_canonical_sha256: string;
  registry_file_sha256: string;
  proposition_schema_contract_hash: string;
  binding_manifest_hash: string;
  proposition_schema_contract: PropositionSchemaContractV1;
  proposition_schema_contract_ref: PropositionSchemaContractRefV1;
}

export interface FixedProductionPropositionGenesisTuple {
  tuple_schema_version: typeof PROPOSITION_GENESIS_TUPLE_SCHEMA;
  abrain_home: string;
  abrain_realpath: string;
  registry_path: string;
  registry_id: string;
  registry_canonical_sha256: string;
  registry_file_sha256: string;
  proposition_schema_contract_hash: string;
  binding_manifest_hash: string;
  epoch_id: typeof PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID;
  envelope: PropositionL1Envelope<PropositionGenesisBodyV1>;
  canonical_envelope_json: string;
  event_id: string;
  relative_path: string;
  target_path: string;
}

export interface ProductionPropositionGenesisTuple extends FixedProductionPropositionGenesisTuple {
  sandbox_abrain_home: string;
  sandbox_abrain_realpath: string;
}

export interface PropositionGenesisScanSummary {
  total: number;
  selected: number;
  foldable: number;
  definedInactiveShadow: number;
  propositionTotal: number;
  propositionSelected: number;
  propositionFoldable: number;
  propositionGenesis: number;
  productionGenesis: number;
  schemaContractGenesis: number;
  propositionEvidence: number;
  propositionLifecycle: number;
  propositionProjection: number;
  tempResidue: number;
}

export interface ProductionPropositionGenesisWriteResult {
  status: DurableCreateStatus;
  tuple: ProductionPropositionGenesisTuple;
  before: PropositionGenesisScanSummary;
  after: PropositionGenesisScanSummary;
}

export interface ProductionPropositionGenesisReadResult {
  event_id: string;
  relative_path: string;
  target_path: string;
  raw: string;
  canonical_envelope_json: string;
  byte_identical: boolean;
  envelope: PropositionL1Envelope<PropositionGenesisBodyV1>;
}

export class PropositionGenesisWriterError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionGenesisWriterError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function prepareFixedProductionPropositionGenesisTuple(options: {
  abrainHome: string;
  abrainRealpath?: string;
  registryPath?: string;
}): Promise<FixedProductionPropositionGenesisTuple> {
  const abrainHome = path.resolve(options.abrainHome);
  const abrainRealpath = path.resolve(options.abrainRealpath ?? abrainHome);
  const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
  loadL1SchemaRegistry(registryPath);
  const body = buildProductionPropositionGenesisBody();
  const envelope = buildPropositionEnvelope(PROPOSITION_GENESIS_ENVELOPE_SCHEMA, body);
  const canonicalEnvelopeJson = canonicalL1EnvelopeJson(envelope);
  const relativePath = expectedL1EventRelativePath(envelope.event_id);
  const targetPath = expectedL1EventPath(abrainHome, envelope.event_id);
  return deepFreeze({
    tuple_schema_version: PROPOSITION_GENESIS_TUPLE_SCHEMA,
    abrain_home: abrainHome,
    abrain_realpath: abrainRealpath,
    registry_path: registryPath,
    registry_id: PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING.registry_id,
    registry_canonical_sha256: PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING.registry_canonical_sha256,
    registry_file_sha256: PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING.registry_file_sha256,
    proposition_schema_contract_hash: PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING.proposition_schema_contract_hash,
    binding_manifest_hash: PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING.binding_manifest_hash,
    epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    envelope,
    canonical_envelope_json: canonicalEnvelopeJson,
    event_id: envelope.event_id,
    relative_path: relativePath,
    target_path: targetPath,
  });
}

export async function prepareProductionPropositionGenesisTuple(options: {
  sandboxAbrainHome: string;
  registryPath?: string;
}): Promise<ProductionPropositionGenesisTuple> {
  const sandbox = await ensureSandboxAbrainHome(options.sandboxAbrainHome);
  const fixed = await prepareFixedProductionPropositionGenesisTuple({
    abrainHome: sandbox.resolved,
    abrainRealpath: sandbox.realpath,
    registryPath: options.registryPath,
  });
  return deepFreeze({
    ...fixed,
    sandbox_abrain_home: sandbox.resolved,
    sandbox_abrain_realpath: sandbox.realpath,
  });
}

export async function validateProductionPropositionGenesisPreflight(options: {
  sandboxAbrainHome: string;
  registryPath?: string;
}): Promise<ProductionPropositionGenesisTuple> {
  const tuple = await prepareProductionPropositionGenesisTuple(options);
  const registry = loadL1SchemaRegistry(tuple.registry_path);
  validateProductionPropositionGenesisTuple(tuple, registry);
  await assertTargetPathNoSymlinkPreflight(tuple.abrain_home, tuple.target_path);
  const beforeScan = await scanWholeL1Validated({ abrainHome: tuple.abrain_home, registry });
  assertProductionGenesisEpochState(beforeScan, tuple, { requirePresent: false });
  return tuple;
}

export async function writeProductionPropositionGenesis(options: {
  sandboxAbrainHome: string;
  registryPath?: string;
}): Promise<ProductionPropositionGenesisWriteResult> {
  const tuple = await validateProductionPropositionGenesisPreflight(options);
  const registry = loadL1SchemaRegistry(tuple.registry_path);
  const beforeScan = await scanWholeL1Validated({ abrainHome: tuple.abrain_home, registry });
  const before = summarizePropositionGenesisScan(beforeScan);
  await createTargetParentNoSymlink(tuple.abrain_home, tuple.target_path);
  const status = await durableAtomicCreateFile(tuple.target_path, tuple.canonical_envelope_json, { mode: 0o600 });
  if (status === "collision") {
    throw failure("PROPOSITION_GENESIS_COLLISION", "production genesis target exists with different bytes; refusing replacement", { targetPath: tuple.target_path, eventId: tuple.event_id });
  }
  const afterScan = await scanWholeL1Validated({ abrainHome: tuple.abrain_home, registry });
  assertProductionGenesisEpochState(afterScan, tuple, { requirePresent: true });
  const readBack = await readProductionPropositionGenesisEvent({ sandboxAbrainHome: tuple.sandbox_abrain_home, eventId: tuple.event_id, registryPath: tuple.registry_path });
  if (!readBack.byte_identical) {
    throw failure("PROPOSITION_GENESIS_BYTE_MISMATCH", "on-disk production genesis is not byte-identical to canonical JCS envelope", { targetPath: tuple.target_path });
  }
  return deepFreeze({ status, tuple, before, after: summarizePropositionGenesisScan(afterScan) });
}

export async function readProductionPropositionGenesisEvent(options: {
  sandboxAbrainHome: string;
  eventId: string;
  registryPath?: string;
}): Promise<ProductionPropositionGenesisReadResult> {
  assertSha256(options.eventId, "eventId");
  const sandbox = await ensureSandboxAbrainHome(options.sandboxAbrainHome);
  const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
  const registry = loadL1SchemaRegistry(registryPath);
  const targetPath = expectedL1EventPath(sandbox.resolved, options.eventId);
  const relativePath = expectedL1EventRelativePath(options.eventId);
  await assertExistingFileNoSymlink(sandbox.resolved, targetPath);
  const raw = await fs.readFile(targetPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw failure("PROPOSITION_GENESIS_READ_INVALID", "production genesis event is not valid JSON", { error: errorMessage(err), targetPath });
  }
  const validated = validateL1Envelope(parsed, {
    registry,
    abrainHome: sandbox.resolved,
    filePath: targetPath,
    relativePath,
    expected: {
      envelopeSchema: PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
      domain: "proposition",
      role: "meta",
      phase: "defined_inactive",
      producer: PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
      eventType: "proposition_genesis_declared",
    },
  });
  const body = validatePropositionGenesisBody(validated.body) as PropositionGenesisBodyV1;
  assertProductionBody(body);
  assertHistoricalBinding(body);
  const envelope = parsed as PropositionL1Envelope<PropositionGenesisBodyV1>;
  const canonicalEnvelopeJson = canonicalL1EnvelopeJson(envelope);
  return deepFreeze({
    event_id: options.eventId,
    relative_path: relativePath,
    target_path: targetPath,
    raw,
    canonical_envelope_json: canonicalEnvelopeJson,
    byte_identical: raw === canonicalEnvelopeJson,
    envelope,
  });
}

export async function summarizePropositionSandboxL1(options: {
  sandboxAbrainHome: string;
  registryPath?: string;
}): Promise<PropositionGenesisScanSummary> {
  const sandbox = await ensureSandboxAbrainHome(options.sandboxAbrainHome);
  const registry = loadL1SchemaRegistry(options.registryPath);
  return summarizePropositionGenesisScan(await scanWholeL1Validated({ abrainHome: sandbox.resolved, registry }));
}

export function buildPropositionSchemaContract(registry: L1SchemaRoleRegistry): PropositionSchemaContractV1 {
  const entries = registry.entries
    .filter((entry) => entry.domain === "proposition")
    .slice()
    .sort((left, right) => compareCodeUnits(left.envelope_schema, right.envelope_schema))
    .map((entry): PropositionSchemaContractEntryV1 => ({
      envelope_schema: entry.envelope_schema,
      body_schema: entry.body_schema ?? null,
      domain: "proposition",
      role: entry.role,
      phase: entry.phase,
      write_enabled: entry.write_enabled,
      fold_eligible: entry.fold_eligible,
      event_types: Object.freeze([...(entry.event_types ?? [])].sort(compareCodeUnits)),
      producers: Object.freeze([...(entry.producers ?? [])].sort(compareCodeUnits)),
    }));
  return deepFreeze({
    schema_version: PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this proposition schema contract object",
    registry_id: registry.registry_id,
    storage_root_relative_path: registry.storage.root_relative_path,
    entries,
  });
}

export function propositionSchemaContractRef(contract: PropositionSchemaContractV1, schemaContractHash: string): PropositionSchemaContractRefV1 {
  const envelopeSchemas = new Set<string>();
  const bodySchemas = new Set<string>();
  const eventTypes = new Set<string>();
  const producers = new Set<string>();
  for (const entry of contract.entries) {
    envelopeSchemas.add(entry.envelope_schema);
    if (entry.body_schema) bodySchemas.add(entry.body_schema);
    for (const eventType of entry.event_types) eventTypes.add(eventType);
    for (const producer of entry.producers) producers.add(producer);
  }
  return deepFreeze({
    schema_version: PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
    schema_contract_hash: schemaContractHash,
    envelope_schemas: Object.freeze([...envelopeSchemas].sort(compareCodeUnits)),
    body_schemas: Object.freeze([...bodySchemas].sort(compareCodeUnits)),
    event_types: Object.freeze([...eventTypes].sort(compareCodeUnits)),
    producers: Object.freeze([...producers].sort(compareCodeUnits)),
  });
}

export function summarizePropositionGenesisScan(scan: WholeL1ScanResult): PropositionGenesisScanSummary {
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  return deepFreeze({
    total: scan.all.length,
    selected: scan.selected.length,
    foldable: scan.foldable.length,
    definedInactiveShadow: scan.definedInactiveShadow.length,
    propositionTotal: proposition.length,
    propositionSelected: proposition.filter((record) => record.classification === "selected").length,
    propositionFoldable: proposition.filter((record) => record.registration.fold_eligible).length,
    propositionGenesis: proposition.filter((record) => record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA).length,
    productionGenesis: proposition.filter(isProductionGenesisRecord).length,
    schemaContractGenesis: proposition.filter(isSchemaContractGenesisRecord).length,
    propositionEvidence: proposition.filter((record) => record.registration.envelope_schema === "proposition-evidence-envelope/v1").length,
    propositionLifecycle: proposition.filter((record) => record.registration.envelope_schema === "proposition-lifecycle-envelope/v1").length,
    propositionProjection: proposition.filter((record) => record.registration.envelope_schema === "proposition-projection-envelope/v1").length,
    tempResidue: scan.tempResidue.length,
  });
}

function buildProductionPropositionGenesisBody(): PropositionGenesisBodyV1 {
  const historical = PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING;
  const manifest: PropositionGenesisBindingManifestV1 = {
    manifest_schema_version: PROPOSITION_GENESIS_BINDING_MANIFEST_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object",
    epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    registry: {
      registry_id: historical.registry_id,
      registry_path: PROPOSITION_SCHEMA_CONTRACT_REGISTRY_PATH,
      registry_canonical_sha256: historical.registry_canonical_sha256,
      registry_file_sha256: historical.registry_file_sha256,
      hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of the validated l1-schema-role-registry/v1 object",
    },
    proposition_schema_contract: historical.proposition_schema_contract_ref,
  };
  const body: PropositionGenesisBodyV1 = {
    event_schema_version: PROPOSITION_GENESIS_BODY_SCHEMA,
    event_type: "proposition_genesis_declared",
    producer: {
      name: PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
      version: PROPOSITION_PRODUCTION_GENESIS_PRODUCER_VERSION,
    },
    epoch: {
      epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
      genesis_scope: "production",
    },
    contract: {
      kind: "production_genesis",
      cutover_policy: "no_migration",
      production_genesis_required: true,
      p0_effect: "defined_inactive_only",
      legacy_domains: ["rules", "constraint", "knowledge"],
      notes: PROPOSITION_PRODUCTION_GENESIS_NOTES,
      binding: {
        binding_schema_version: PROPOSITION_GENESIS_BINDING_SCHEMA,
        canonicalization: "RFC8785-JCS",
        hash_algorithm: "sha256",
        manifest_hash: historical.binding_manifest_hash,
        manifest,
      },
    },
  };
  return validatePropositionGenesisBody(body);
}

interface BindingHashes {
  registryCanonicalSha256: string;
  registryFileSha256: string;
  schemaContract: PropositionSchemaContractV1;
  schemaContractHash: string;
  bindingManifestHash: string;
}

export async function computeCurrentPropositionSchemaAnchors(registryPath = defaultL1SchemaRegistryPath()): Promise<CurrentPropositionSchemaAnchors> {
  const resolved = path.resolve(registryPath);
  const registry = loadL1SchemaRegistry(resolved);
  const hashes = await computeBindingHashes(registry, resolved);
  return deepFreeze({
    registry_id: registry.registry_id,
    registry_canonical_sha256: hashes.registryCanonicalSha256,
    registry_file_sha256: hashes.registryFileSha256,
    proposition_schema_contract_hash: hashes.schemaContractHash,
    binding_manifest_hash: hashes.bindingManifestHash,
    proposition_schema_contract: hashes.schemaContract,
    proposition_schema_contract_ref: propositionSchemaContractRef(hashes.schemaContract, hashes.schemaContractHash),
  });
}

async function computeBindingHashes(registry: L1SchemaRoleRegistry, registryPath: string): Promise<BindingHashes> {
  const registryCanonicalSha256 = jcsSha256Hex(registry);
  const registryFileSha256 = sha256Hex(await fs.readFile(registryPath));
  const schemaContract = buildPropositionSchemaContract(registry);
  const schemaContractHash = jcsSha256Hex(schemaContract);
  const schemaContractRef = propositionSchemaContractRef(schemaContract, schemaContractHash);
  const manifest: PropositionGenesisBindingManifestV1 = {
    manifest_schema_version: PROPOSITION_GENESIS_BINDING_MANIFEST_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object",
    epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    registry: {
      registry_id: registry.registry_id,
      registry_path: PROPOSITION_SCHEMA_CONTRACT_REGISTRY_PATH,
      registry_canonical_sha256: registryCanonicalSha256,
      registry_file_sha256: registryFileSha256,
      hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of the validated l1-schema-role-registry/v1 object",
    },
    proposition_schema_contract: schemaContractRef,
  };
  return deepFreeze({
    registryCanonicalSha256,
    registryFileSha256,
    schemaContract,
    schemaContractHash,
    bindingManifestHash: jcsSha256Hex(manifest),
  });
}

export function validateProductionPropositionGenesisTuple(tuple: FixedProductionPropositionGenesisTuple, registry: L1SchemaRoleRegistry): void {
  if (tuple.tuple_schema_version !== PROPOSITION_GENESIS_TUPLE_SCHEMA) throw failure("PROPOSITION_GENESIS_TUPLE_INVALID", "unexpected tuple schema version");
  if (tuple.epoch_id !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID) throw failure("PROPOSITION_GENESIS_EPOCH_CONFLICT", "production genesis tuple epoch drifted", { actual: tuple.epoch_id });
  const relativePath = expectedL1EventRelativePath(tuple.event_id);
  const targetPath = expectedL1EventPath(tuple.abrain_home, tuple.event_id);
  if (tuple.relative_path !== relativePath || tuple.target_path !== targetPath) throw failure("PROPOSITION_GENESIS_PATH_MISMATCH", "tuple path does not derive from event_id", { expectedRelative: relativePath, actualRelative: tuple.relative_path });
  const validated = validateL1Envelope(tuple.envelope, {
    registry,
    abrainHome: tuple.abrain_home,
    filePath: tuple.target_path,
    relativePath: tuple.relative_path,
    expected: {
      envelopeSchema: PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
      domain: "proposition",
      role: "meta",
      phase: "defined_inactive",
      producer: PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
      eventType: "proposition_genesis_declared",
    },
  });
  const body = validatePropositionGenesisBody(validated.body) as PropositionGenesisBodyV1;
  assertProductionBody(body);
  assertBindingMatchesTuple(tuple, body);
  if (tuple.canonical_envelope_json !== canonicalL1EnvelopeJson(tuple.envelope)) throw failure("PROPOSITION_GENESIS_JCS_MISMATCH", "tuple canonical_envelope_json is not shared JCS output");
  if (tuple.event_id !== validated.eventId) throw failure("PROPOSITION_GENESIS_HASH_MISMATCH", "tuple event_id does not match envelope", { expected: validated.eventId, actual: tuple.event_id });
}

function assertProductionBody(body: PropositionGenesisBodyV1): void {
  if (body.event_schema_version !== PROPOSITION_GENESIS_BODY_SCHEMA
    || body.event_type !== "proposition_genesis_declared"
    || body.producer.name !== PROPOSITION_PRODUCTION_GENESIS_PRODUCER
    || body.producer.version !== PROPOSITION_PRODUCTION_GENESIS_PRODUCER_VERSION
    || body.epoch.epoch_id !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID
    || body.epoch.genesis_scope !== "production"
    || body.contract.kind !== "production_genesis") {
    throw failure("PROPOSITION_GENESIS_UNEXPECTED_EVENT", "writer accepts only the fixed ADR0040 production genesis tuple");
  }
}

function assertBindingMatchesTuple(tuple: FixedProductionPropositionGenesisTuple, body: PropositionGenesisBodyV1): void {
  const binding = productionBinding(body);
  if (binding.manifest.registry.registry_id !== tuple.registry_id
    || binding.manifest.registry.registry_canonical_sha256 !== tuple.registry_canonical_sha256
    || binding.manifest.registry.registry_file_sha256 !== tuple.registry_file_sha256
    || binding.manifest.proposition_schema_contract.schema_contract_hash !== tuple.proposition_schema_contract_hash
    || binding.manifest_hash !== tuple.binding_manifest_hash) {
    throw failure("PROPOSITION_GENESIS_BINDING_MISMATCH", "production genesis binding does not match tuple registry/schema hashes");
  }
}

function assertHistoricalBinding(body: PropositionGenesisBodyV1): void {
  const binding = productionBinding(body);
  const historical = PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING;
  if (binding.manifest.registry.registry_id !== historical.registry_id
    || binding.manifest.registry.registry_canonical_sha256 !== historical.registry_canonical_sha256
    || binding.manifest.registry.registry_file_sha256 !== historical.registry_file_sha256
    || binding.manifest.proposition_schema_contract.schema_contract_hash !== historical.proposition_schema_contract_hash
    || canonicalizeJcs(binding.manifest.proposition_schema_contract) !== canonicalizeJcs(historical.proposition_schema_contract_ref)
    || binding.manifest_hash !== historical.binding_manifest_hash
    || jcsSha256Hex(binding.manifest) !== historical.binding_manifest_hash) {
    throw failure("PROPOSITION_GENESIS_BINDING_MISMATCH", "production genesis binding is not the immutable historical provenance tuple");
  }
}

function productionBinding(body: PropositionGenesisBodyV1): PropositionProductionGenesisContractV1["binding"] {
  assertProductionBody(body);
  return (body.contract as PropositionProductionGenesisContractV1).binding;
}

function assertProductionGenesisEpochState(scan: WholeL1ScanResult, tuple: ProductionPropositionGenesisTuple, options: { requirePresent: boolean }): void {
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  const nonGenesis = proposition.filter((record) => record.registration.envelope_schema !== PROPOSITION_GENESIS_ENVELOPE_SCHEMA);
  if (nonGenesis.length) {
    throw failure("PROPOSITION_GENESIS_SANDBOX_NOT_EMPTY", "production genesis writer refuses existing proposition evidence/lifecycle/projection events", { count: nonGenesis.length });
  }
  const genesis = proposition.filter((record) => record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA);
  const nonProduction = genesis.filter((record) => !isProductionGenesisRecord(record));
  if (nonProduction.length) {
    throw failure("PROPOSITION_GENESIS_UNEXPECTED_EVENT", "production genesis writer refuses schema-contract genesis records on disk", { count: nonProduction.length });
  }
  if (genesis.length > 1) {
    const sameEpochDrift = genesis.find((record) => productionEpochId(record) === tuple.epoch_id && record.eventId !== tuple.event_id);
    if (sameEpochDrift) {
      throw failure("PROPOSITION_GENESIS_EPOCH_DRIFT", "sandbox contains a different body for the same production genesis epoch", { expectedEventId: tuple.event_id, actualEventId: sameEpochDrift.eventId });
    }
    const differentEpoch = genesis.find((record) => productionEpochId(record) !== tuple.epoch_id);
    if (differentEpoch) {
      throw failure("PROPOSITION_GENESIS_EPOCH_CONFLICT", "sandbox contains a different production genesis epoch", { expected: tuple.epoch_id, actual: productionEpochId(differentEpoch), eventId: differentEpoch.eventId });
    }
    throw failure("PROPOSITION_GENESIS_MULTIPLE", "sandbox contains duplicate production genesis records", { count: genesis.length });
  }
  if (genesis.length === 0) {
    if (options.requirePresent) throw failure("PROPOSITION_GENESIS_MISSING", "production genesis was not present after write");
    return;
  }
  const existing = genesis[0]!;
  const existingEpoch = productionEpochId(existing);
  if (existingEpoch !== tuple.epoch_id) {
    throw failure("PROPOSITION_GENESIS_EPOCH_CONFLICT", "sandbox already contains a different production genesis epoch", { expected: tuple.epoch_id, actual: existingEpoch, eventId: existing.eventId });
  }
  if (existing.eventId !== tuple.event_id) {
    throw failure("PROPOSITION_GENESIS_EPOCH_DRIFT", "sandbox already contains a different body for the same production genesis epoch", { expectedEventId: tuple.event_id, actualEventId: existing.eventId });
  }
}

function isProductionGenesisRecord(record: ValidatedL1ScanRecord): boolean {
  return record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA
    && isRecord(record.body.epoch)
    && record.body.epoch.genesis_scope === "production"
    && isRecord(record.body.contract)
    && record.body.contract.kind === "production_genesis";
}

function isSchemaContractGenesisRecord(record: ValidatedL1ScanRecord): boolean {
  return record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA
    && isRecord(record.body.epoch)
    && record.body.epoch.genesis_scope === "schema_contract"
    && isRecord(record.body.contract)
    && record.body.contract.kind === "schema_contract";
}

function productionEpochId(record: ValidatedL1ScanRecord): string {
  if (!isRecord(record.body.epoch) || typeof record.body.epoch.epoch_id !== "string") throw failure("PROPOSITION_GENESIS_UNEXPECTED_EVENT", "production genesis record has no epoch_id");
  return record.body.epoch.epoch_id;
}

async function ensureSandboxAbrainHome(input: string): Promise<{ resolved: string; realpath: string }> {
  if (typeof input !== "string" || !input.trim()) throw failure("PROPOSITION_GENESIS_SANDBOX_REQUIRED", "sandboxAbrainHome must be an explicit path");
  const resolved = path.resolve(input);
  await rejectRealAbrain(resolved);
  const tmpRoot = await fs.realpath(os.tmpdir());
  if (!isPathInside(tmpRoot, resolved) || resolved === tmpRoot) {
    throw failure("PROPOSITION_GENESIS_SANDBOX_REQUIRED", `sandboxAbrainHome must be inside ${tmpRoot}`, { actual: resolved });
  }
  await assertDirectoryChainNoSymlink(tmpRoot, path.dirname(resolved), { allowMissingTail: false });
  let stat = await fs.lstat(resolved).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (stat?.isSymbolicLink()) throw failure("PROPOSITION_GENESIS_SYMLINK_REJECTED", `sandbox abrain home is a symlink: ${resolved}`);
  if (stat && !stat.isDirectory()) throw failure("PROPOSITION_GENESIS_NON_REGULAR", `sandbox abrain home is not a directory: ${resolved}`);
  if (!stat) {
    await fs.mkdir(resolved, { recursive: false, mode: 0o700 });
    stat = await fs.lstat(resolved);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("PROPOSITION_GENESIS_NON_REGULAR", `sandbox abrain home is not a plain directory: ${resolved}`);
  const realpath = await fs.realpath(resolved);
  await rejectRealAbrain(realpath);
  if (!isPathInside(tmpRoot, realpath)) throw failure("PROPOSITION_GENESIS_PATH_ESCAPE", "sandbox realpath escapes temp root", { resolved, realpath, tmpRoot });
  return { resolved, realpath };
}

async function rejectRealAbrain(candidate: string): Promise<void> {
  const realCandidates = new Set([path.resolve("/home/worker/.abrain"), path.resolve(os.homedir(), ".abrain")]);
  const resolved = path.resolve(candidate);
  if (realCandidates.has(resolved)) throw failure("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED", "P0b.1 writer refuses the real abrain home", { path: resolved });
  for (const realCandidate of realCandidates) {
    const candidateReal = await fs.realpath(resolved).catch(() => resolved);
    const realAbrain = await fs.realpath(realCandidate).catch(() => realCandidate);
    if (candidateReal === realAbrain) throw failure("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED", "P0b.1 writer refuses the real abrain home realpath", { path: resolved, realpath: candidateReal });
  }
}

async function assertTargetPathNoSymlinkPreflight(abrainHome: string, targetPath: string): Promise<void> {
  const relative = path.relative(abrainHome, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw failure("PROPOSITION_GENESIS_PATH_ESCAPE", "target path escapes sandbox abrain home", { targetPath });
  const parent = path.dirname(targetPath);
  await assertDirectoryChainNoSymlink(abrainHome, parent, { allowMissingTail: true });
  await assertOptionalLeafNoSymlink(abrainHome, targetPath);
}

async function createTargetParentNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  await assertTargetPathNoSymlinkPreflight(abrainHome, targetPath);
  const homeReal = await fs.realpath(abrainHome);
  const parent = path.dirname(targetPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertDirectoryChainNoSymlink(abrainHome, parent, { allowMissingTail: false });
  const parentReal = await fs.realpath(parent);
  if (!isPathInside(homeReal, parentReal)) throw failure("PROPOSITION_GENESIS_PATH_ESCAPE", "target parent realpath escapes sandbox abrain home", { parentReal, homeReal });
  await assertOptionalLeafNoSymlink(abrainHome, targetPath);
}

async function assertExistingFileNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  await assertTargetPathNoSymlinkPreflight(abrainHome, targetPath);
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_GENESIS_SYMLINK_REJECTED", `target file is a symlink: ${targetPath}`);
  if (!stat.isFile()) throw failure("PROPOSITION_GENESIS_NON_REGULAR", `target is not a regular file: ${targetPath}`);
  const homeReal = await fs.realpath(abrainHome);
  const fileReal = await fs.realpath(targetPath);
  if (!isPathInside(homeReal, fileReal)) throw failure("PROPOSITION_GENESIS_PATH_ESCAPE", "target file realpath escapes sandbox abrain home", { fileReal, homeReal });
}

async function assertOptionalLeafNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  const stat = await fs.lstat(targetPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_GENESIS_SYMLINK_REJECTED", `target file is a symlink: ${targetPath}`);
  if (!stat.isFile()) throw failure("PROPOSITION_GENESIS_NON_REGULAR", `target is not a regular file: ${targetPath}`);
  const homeReal = await fs.realpath(abrainHome);
  const fileReal = await fs.realpath(targetPath);
  if (!isPathInside(homeReal, fileReal)) throw failure("PROPOSITION_GENESIS_PATH_ESCAPE", "target file realpath escapes sandbox abrain home", { fileReal, homeReal });
}

async function assertDirectoryChainNoSymlink(root: string, targetDir: string, options: { allowMissingTail: boolean }): Promise<void> {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(targetDir);
  const relative = path.relative(rootResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("PROPOSITION_GENESIS_PATH_ESCAPE", "directory chain escapes root", { root: rootResolved, targetDir: targetResolved });
  let current = rootResolved;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink()) throw failure("PROPOSITION_GENESIS_SYMLINK_REJECTED", `symlink in directory chain: ${current}`);
  if (!rootStat.isDirectory()) throw failure("PROPOSITION_GENESIS_NON_REGULAR", `directory chain root is not a directory: ${current}`);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) {
      if (options.allowMissingTail) return;
      throw failure("PROPOSITION_GENESIS_NON_REGULAR", `missing directory in chain: ${current}`);
    }
    if (stat.isSymbolicLink()) throw failure("PROPOSITION_GENESIS_SYMLINK_REJECTED", `symlink in directory chain: ${current}`);
    if (!stat.isDirectory()) throw failure("PROPOSITION_GENESIS_NON_REGULAR", `directory chain component is not a directory: ${current}`);
  }
}

function assertSha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure("PROPOSITION_GENESIS_HASH_MISMATCH", `${at} must be lowercase SHA-256 hex`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionGenesisWriterError {
  return new PropositionGenesisWriterError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export { canonicalizeJcs };
