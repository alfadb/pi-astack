import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import {
  canonicalL1EnvelopeJson,
  defaultL1SchemaRegistryPath,
  expectedL1EventPath,
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  validateL1WritePreflight,
  type L1SchemaRoleRegistry,
} from "./l1-schema-registry";
import { canonicalizeJcs, sha256Hex } from "./jcs";
import {
  PROPOSITION_EVIDENCE_BODY_SCHEMA,
  PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  buildPropositionEnvelope,
  validatePropositionEvidenceBody,
  type PropositionEvidenceBodyV1,
  type PropositionL1Envelope,
} from "./proposition";

export const PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER = "pi-astack.proposition-production-evidence-writer" as const;
export const PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER_VERSION = "adr0040-production-evidence-writer/v1" as const;
export const PROPOSITION_P1B_FIXED_STATEMENT = "统一真相源、不同消费投影是第一要务。" as const;
export const PROPOSITION_P1B_FIXED_QUOTE_SHA256 = "b594404b6394f21f1e702b9af24ae5f5b371497492e29dfe8a16f1b9357217db" as const;
export const PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID = "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3" as const;
export const PROPOSITION_P1B_FIXED_TRIGGER_REF = "session:019f569c-40d3-73f0-9a5f-666b395f6b9a/message:e5b235e8" as const;
export const PROPOSITION_P1B_TUPLE_SCHEMA = "proposition-p1b-fixed-production-evidence-tuple/v1" as const;

export interface FixedProductionPropositionEvidenceTuple {
  tuple_schema_version: typeof PROPOSITION_P1B_TUPLE_SCHEMA;
  abrain_home: string;
  registry_path: string;
  envelope: PropositionL1Envelope<PropositionEvidenceBodyV1>;
  canonical_envelope_json: string;
  canonical_envelope_bytes_sha256: string;
  event_id: string;
  relative_path: string;
  target_path: string;
}

export interface FixedProductionPropositionEvidenceWriteResult {
  status: DurableCreateStatus;
  immediate_rerun_status: DurableCreateStatus;
  tuple: FixedProductionPropositionEvidenceTuple;
  generic_write_gate: "L1_SCHEMA_WRITE_DISABLED";
  readback_byte_identical: boolean;
}

export class PropositionEvidenceWriterError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionEvidenceWriterError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function buildFixedProductionPropositionEvidenceBody(): PropositionEvidenceBodyV1 {
  return validatePropositionEvidenceBody({
    event_schema_version: PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: {
      name: PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER,
      version: PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER_VERSION,
    },
    epoch: {
      epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
      genesis_event_id: PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID,
    },
    proposition: {
      statement: PROPOSITION_P1B_FIXED_STATEMENT,
      modality: "normative",
      language: "zh",
    },
    facets: {
      provenance_authority: {
        source_kind: "user",
        authority_kind: "user_attested",
        source_event_id: null,
        quote_sha256: PROPOSITION_P1B_FIXED_QUOTE_SHA256,
      },
      spatial_scope: {
        scope_level: "global",
        project_id: null,
        domain: null,
      },
      temporal_horizon: {
        horizon: "durable",
        valid_from: null,
        valid_until: null,
      },
      trigger: {
        trigger_kind: "user_directive",
        trigger_ref: PROPOSITION_P1B_FIXED_TRIGGER_REF,
      },
      maturity: {
        state: "accepted",
        review_state: "reviewed",
      },
      contestability: {
        status: "uncontested",
        counterevidence_event_ids: [],
      },
      confidence: {
        score: 1,
        basis: "witnessed",
      },
      sensitivity: {
        classification: "public",
        handling: "none",
      },
      consumer_hints: {
        retrieval: true,
        policy: false,
        notes: [],
      },
      lineage: {
        causal_parents: [],
        derives_from: [],
        supersedes: [],
      },
    },
  });
}

export function buildFixedProductionPropositionEvidenceEnvelope(): PropositionL1Envelope<PropositionEvidenceBodyV1> {
  return buildPropositionEnvelope(PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, buildFixedProductionPropositionEvidenceBody());
}

export function assertExactFixedProductionPropositionEvidenceTuple(input: unknown): void {
  const expected = buildFixedProductionPropositionEvidenceEnvelope();
  if (canonicalizeJcs(input) !== canonicalizeJcs(expected)) {
    throw failure("PROPOSITION_P1B_TUPLE_REFUSED", "dedicated writer accepts only the frozen ADR0040 P1b proposition evidence tuple");
  }
}

export async function prepareFixedProductionPropositionEvidenceTuple(options: {
  abrainHome: string;
  registryPath?: string;
}): Promise<FixedProductionPropositionEvidenceTuple> {
  const abrainHome = path.resolve(options.abrainHome);
  const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
  const registry = loadL1SchemaRegistry(registryPath);
  assertDedicatedProducerRegistration(registry);
  const envelope = buildFixedProductionPropositionEvidenceEnvelope();
  assertExactFixedProductionPropositionEvidenceTuple(envelope);
  const relativePath = expectedL1EventRelativePath(envelope.event_id);
  const targetPath = expectedL1EventPath(abrainHome, envelope.event_id);
  validateL1Envelope(envelope, {
    registry,
    abrainHome,
    filePath: targetPath,
    relativePath,
    expected: {
      envelopeSchema: PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
      domain: "proposition",
      role: "evidence",
      phase: "defined_inactive",
      producer: PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER,
      eventType: "proposition_observed",
    },
  });
  const canonicalEnvelopeJson = canonicalL1EnvelopeJson(envelope);
  return deepFreeze({
    tuple_schema_version: PROPOSITION_P1B_TUPLE_SCHEMA,
    abrain_home: abrainHome,
    registry_path: registryPath,
    envelope,
    canonical_envelope_json: canonicalEnvelopeJson,
    canonical_envelope_bytes_sha256: sha256Hex(canonicalEnvelopeJson),
    event_id: envelope.event_id,
    relative_path: relativePath,
    target_path: targetPath,
  });
}

export async function appendFixedProductionPropositionEvidenceSandbox(options: {
  sandboxAbrainHome: string;
  registryPath?: string;
}): Promise<FixedProductionPropositionEvidenceWriteResult> {
  const sandbox = await assertSandboxAbrainHome(options.sandboxAbrainHome);
  return durableAppendFixedProductionPropositionEvidence({
    abrainHome: sandbox,
    registryPath: options.registryPath,
    requireFreshPrestate: true,
  });
}

/** Fixed-tuple primitive for the separately ratified executor. It is not a generic L1 writer. */
export async function durableAppendFixedProductionPropositionEvidence(options: {
  abrainHome: string;
  registryPath?: string;
  requireFreshPrestate: boolean;
}): Promise<FixedProductionPropositionEvidenceWriteResult> {
  const abrainHome = path.resolve(options.abrainHome);
  await assertExistingAbrainHome(abrainHome);
  const tuple = await prepareFixedProductionPropositionEvidenceTuple({ abrainHome, registryPath: options.registryPath });
  const registry = loadL1SchemaRegistry(tuple.registry_path);
  const before = await scanWholeL1Validated({ abrainHome, registry });
  // A target may appear after an executor's fresh preflight in a concurrent
  // identical run. Accept only that exact fixed event and converge no-replace.
  assertProductionEvidenceState(before, tuple, { allowFixedEvidence: true });
  const gate = await genericWriteGateCode(tuple, registry);
  if (gate !== "L1_SCHEMA_WRITE_DISABLED") {
    throw failure("PROPOSITION_P1B_GENERIC_GATE_DRIFT", "generic proposition write preflight must remain L1_SCHEMA_WRITE_DISABLED", { actual: gate });
  }
  await createTargetParentNoSymlink(abrainHome, tuple.target_path);
  const status = await durableAtomicCreateFile(tuple.target_path, tuple.canonical_envelope_json, { mode: 0o600 });
  if (status === "collision") throw failure("PROPOSITION_P1B_COLLISION", "fixed evidence target exists with different bytes", { targetPath: tuple.target_path });
  const immediateRerunStatus = await durableAtomicCreateFile(tuple.target_path, tuple.canonical_envelope_json, { mode: 0o600 });
  if (immediateRerunStatus !== "identical") {
    throw failure("PROPOSITION_P1B_IDENTICAL_RERUN_FAILED", "immediate no-replace rerun was not identical", { actual: immediateRerunStatus });
  }
  const raw = await fs.readFile(tuple.target_path, "utf-8");
  if (raw !== tuple.canonical_envelope_json) throw failure("PROPOSITION_P1B_READBACK_MISMATCH", "fixed evidence readback differs from canonical bytes");
  const after = await scanWholeL1Validated({ abrainHome, registry });
  assertProductionEvidenceState(after, tuple, { allowFixedEvidence: true, requireFixedEvidence: true });
  return deepFreeze({
    status,
    immediate_rerun_status: immediateRerunStatus,
    tuple,
    generic_write_gate: gate,
    readback_byte_identical: true,
  });
}

function assertDedicatedProducerRegistration(registry: L1SchemaRoleRegistry): void {
  const entry = registry.entries.find((candidate) => candidate.envelope_schema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA);
  if (!entry
    || entry.phase !== "defined_inactive"
    || entry.write_enabled
    || entry.fold_eligible
    || canonicalizeJcs(entry.event_types) !== canonicalizeJcs(["proposition_observed"])
    || !entry.producers?.includes(PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER)) {
    throw failure("PROPOSITION_P1B_REGISTRY_DRIFT", "dedicated evidence producer must be allowlisted on the unchanged inactive evidence entry");
  }
}

function assertProductionEvidenceState(
  scan: Awaited<ReturnType<typeof scanWholeL1Validated>>,
  tuple: FixedProductionPropositionEvidenceTuple,
  options: { allowFixedEvidence: boolean; requireFixedEvidence?: boolean },
): void {
  const records = scan.all.filter((record) => record.registration.domain === "proposition");
  const genesis = records.filter((record) => record.registration.envelope_schema === "proposition-genesis-envelope/v1");
  const evidence = records.filter((record) => record.registration.envelope_schema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA);
  const other = records.filter((record) => !["proposition-genesis-envelope/v1", PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA].includes(record.registration.envelope_schema));
  if (genesis.length !== 1 || genesis[0]!.eventId !== PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID) {
    throw failure("PROPOSITION_P1B_PRESTATE_INVALID", "abrain must contain exactly the fixed production genesis", { genesis: genesis.map((record) => record.eventId) });
  }
  if (other.length) throw failure("PROPOSITION_P1B_PRESTATE_INVALID", "lifecycle/projection proposition records are not allowed in P1b prestate", { count: other.length });
  if (!options.allowFixedEvidence && evidence.length !== 0) {
    throw failure("PROPOSITION_P1B_PRESTATE_INVALID", "fresh P1b append requires zero existing proposition evidence", { count: evidence.length });
  }
  if (options.allowFixedEvidence && evidence.some((record) => record.eventId !== tuple.event_id)) {
    throw failure("PROPOSITION_P1B_PRESTATE_INVALID", "only the fixed P1b evidence event may already exist", { ids: evidence.map((record) => record.eventId) });
  }
  if (evidence.length > 1 || (options.requireFixedEvidence && evidence.length !== 1)) {
    throw failure("PROPOSITION_P1B_PRESTATE_INVALID", "fixed P1b evidence cardinality is invalid", { count: evidence.length });
  }
}

async function genericWriteGateCode(tuple: FixedProductionPropositionEvidenceTuple, registry: L1SchemaRoleRegistry): Promise<string> {
  try {
    await validateL1WritePreflight({
      abrainHome: tuple.abrain_home,
      envelope: tuple.envelope,
      targetPath: tuple.target_path,
      registry,
      expected: {
        envelopeSchema: PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
        domain: "proposition",
        role: "evidence",
        producer: PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER,
        eventType: "proposition_observed",
      },
    });
    return "UNEXPECTED_SUCCESS";
  } catch (err) {
    return errorCode(err);
  }
}

async function assertSandboxAbrainHome(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const realProduction = await fs.realpath("/home/worker/.abrain").catch(() => "/home/worker/.abrain");
  const tmpRoot = await fs.realpath(os.tmpdir());
  if (resolved === "/home/worker/.abrain" || resolved === realProduction || !isPathInside(tmpRoot, resolved) || resolved === tmpRoot) {
    throw failure("PROPOSITION_P1B_SANDBOX_REQUIRED", "sandbox writer accepts only an explicit abrain home below the system temp directory", { actual: resolved });
  }
  await assertExistingAbrainHome(resolved);
  const real = await fs.realpath(resolved);
  if (!isPathInside(tmpRoot, real) || real === realProduction) throw failure("PROPOSITION_P1B_SANDBOX_REQUIRED", "sandbox realpath escapes the temp root", { resolved, real });
  return resolved;
}

async function assertExistingAbrainHome(abrainHome: string): Promise<void> {
  const stat = await fs.lstat(abrainHome).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) throw failure("PROPOSITION_P1B_ABRAIN_MISSING", "abrain home must already exist", { abrainHome });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_P1B_PATH_UNSAFE", "abrain home must be a non-symlink directory", { abrainHome });
  const real = await fs.realpath(abrainHome);
  if (real !== abrainHome) throw failure("PROPOSITION_P1B_PATH_UNSAFE", "abrain home must resolve exactly", { abrainHome, real });
}

async function createTargetParentNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  const parent = path.dirname(targetPath);
  const relative = path.relative(abrainHome, parent);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw failure("PROPOSITION_P1B_PATH_ESCAPE", "target parent escapes abrain home");
  let current = abrainHome;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const existing = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!existing) {
      await fs.mkdir(current, { mode: 0o700 }).catch((err: unknown) => {
        if (!isNodeError(err) || err.code !== "EEXIST") throw err;
      });
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_P1B_PATH_UNSAFE", "target directory chain contains a symlink or non-directory", { path: current });
  }
  const leaf = await fs.lstat(targetPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile())) throw failure("PROPOSITION_P1B_PATH_UNSAFE", "target leaf is a symlink or non-file", { targetPath });
  const parentReal = await fs.realpath(parent);
  if (!isPathInside(abrainHome, parentReal)) throw failure("PROPOSITION_P1B_PATH_ESCAPE", "target parent realpath escapes abrain home", { parentReal });
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionEvidenceWriterError {
  return new PropositionEvidenceWriterError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
