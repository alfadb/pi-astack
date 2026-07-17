/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  canonicalL1EnvelopeJson,
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
} from "./l1-schema-registry";
import {
  PROPOSITION_LIFECYCLE_BODY_SCHEMA,
  PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  PROPOSITION_SCHEMA_CONTRACT_PRODUCER,
  buildPropositionEnvelope,
  type PropositionFacets,
  type PropositionLifecycleBodyV1,
} from "./proposition";
import { buildPropositionPolicyPushShadow } from "./proposition-policy-push-shadow";
import { acquireRetainedDirectoryOfdLock, type RetainedDirectoryOfdLock } from "./retained-directory-ofd-lock";
import {
  PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY_HASH,
  advanceLifecyclePointer,
  assertLifecycleControlRoot,
  assertLifecycleSandboxRoot,
  buildLifecycleCheckpoint,
  buildLifecycleHead,
  buildLifecycleIntent,
  buildLifecyclePrediction,
  buildLifecycleProof,
  buildLifecycleSelection,
  buildLifecycleStage,
  prepareLifecycleControlRoot,
  readHeadPointerRaw,
  readLifecycleCheckpoint,
  readLifecycleHead,
  readLifecycleIntent,
  readLifecycleProof,
  readLifecycleSelection,
  readPropositionLifecycleFreshnessV2,
  readSelectionPointerRaw,
  transactionIdForLifecycle,
  tupleHashForLifecycle,
  validateCommittedHeadProofClosure,
  validateGenesisHeadArtifactClosure,
  validateLifecycleIntent,
  validateLifecyclePrediction,
  validateLifecycleStage,
  writeLifecycleArtifactCas,
  writeLifecycleCheckpointCas,
  writeLifecycleHeadCas,
  writeLifecycleIntentCas,
  writeLifecycleProofCas,
  writeLifecycleSelectionCas,
  writeLifecycleStageCas,
  type LifecycleCrashPoint,
  type LifecycleFreshnessReadResult,
  type LifecycleHeadV2,
  type LifecycleIntentV2,
  type LifecyclePredictionV1,
  type LifecycleSelectionV2,
  type LifecycleStageV1,
} from "./proposition-lifecycle-freshness-control-v2";
import {
  PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES,
  PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES,
  buildLifecycleSourceSnapshot,
  buildPropositionLifecycleV3Artifacts,
  validateLifecycleSourceSnapshot,
  type LifecycleSourceRow,
  type LifecycleSourceSnapshot,
  type PropositionLifecycleV3Build,
} from "./proposition-lifecycle-freshness-v3";

export const PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_TUPLE_SCHEMA = "proposition-lifecycle-sandbox-archive-tuple/v1" as const;
export const PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_PRODUCER_VERSION = "adr0040-d3-wf-sandbox-archive/v1" as const;

const EVENT_FILE = /^[0-9a-f]{64}\.json$/;
const HASH = /^[0-9a-f]{64}$/;
const WHOLE_L1_RAW_SNAPSHOT_SCHEMA = "proposition-lifecycle-whole-l1-raw-snapshot/v2" as const;
const WHOLE_L1_ROWS_HASH_SCOPE = "ordered-whole-l1-rows-including-raw-sha256/v1" as const;
const WHOLE_L1_SNAPSHOT_HASH_SCOPE = "whole-l1-summary-plus-ordered-raw-sha256-rows/v1" as const;
const PREDICTION_CRASH_POINTS = ["prediction_directory_created", "prediction_partially_copied", "prediction_built_before_intent"] as const;

export interface WholeL1RawRow extends LifecycleSourceRow {
  schema: string;
  domain: string;
  classification: string;
  raw: string;
}

export interface WholeL1RawSnapshot {
  schema_version: typeof WHOLE_L1_RAW_SNAPSHOT_SCHEMA;
  hash_algorithm: "sha256";
  rows_hash_scope: typeof WHOLE_L1_ROWS_HASH_SCOPE;
  snapshot_hash_scope: typeof WHOLE_L1_SNAPSHOT_HASH_SCOPE;
  event_count: number;
  event_ids_hash: string;
  raw_sha256s_hash: string;
  rows_hash: string;
  snapshot_hash: string;
  rows: readonly WholeL1RawRow[];
}

export interface ProductionL1CopyEvidence {
  schema_version: "proposition-lifecycle-production-copy-evidence/v1";
  production_abrain_home: string;
  sandbox_abrain_home: string;
  production_before: WholeL1RawSnapshot;
  production_after: WholeL1RawSnapshot;
  sandbox_copy: WholeL1RawSnapshot;
  proposition_source_snapshot: LifecycleSourceSnapshot;
  all_event_ids_and_raw_hashes_equal: true;
  no_hardlinks_to_production: true;
}

export interface SandboxArchiveTuple {
  tuple: Readonly<Record<string, unknown>>;
  tuple_hash: string;
  target_event_id: string;
  event_id: string;
  envelope: Readonly<Record<string, unknown>>;
  canonical_event_json: string;
  canonical_event_bytes_sha256: string;
}

export interface SandboxWorkflowInitializationResult {
  status: "created" | "identical" | "BUSY";
  control_root: string;
  head_hash?: string;
  selection_hash?: string;
  p2a_bundle_hash?: string;
  stable_bundle_hash?: string;
  reader?: LifecycleFreshnessReadResult;
}

export interface SandboxWorkflowExecutionResult {
  status: "committed" | "identical" | "BUSY";
  transaction_id?: string;
  intent_hash?: string;
  intent_head_hash?: string;
  proof_hash?: string;
  committed_head_hash?: string;
  selection_hash?: string;
  event_id?: string;
  event_state?: "S4";
  recovery_shape?: string;
  reader?: LifecycleFreshnessReadResult;
}

export class PropositionLifecycleFreshnessSandboxWriterError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionLifecycleFreshnessSandboxWriterError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function copyProductionL1ToLifecycleSandbox(options: {
  productionAbrainHome?: string;
  sandboxRoot: string;
}): Promise<ProductionL1CopyEvidence> {
  const production = path.resolve(options.productionAbrainHome ?? "/home/worker/.abrain");
  if (production !== "/home/worker/.abrain") fail("PRODUCTION_SOURCE_INVALID", "real copy/replay source must be /home/worker/.abrain");
  const sandboxRoot = assertLifecycleSandboxRoot(options.sandboxRoot);
  ensureDirectory(sandboxRoot);
  const sandboxAbrain = path.join(sandboxRoot, "abrain-copy");
  if (lstatMaybe(sandboxAbrain)) fail("SANDBOX_COPY_COLLISION", "sandbox abrain copy target must be absent", { sandboxAbrain });

  let before: WholeL1RawSnapshot | undefined;
  let after: WholeL1RawSnapshot | undefined;
  const maximumAttempts = 4;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (lstatMaybe(sandboxAbrain)) fs.rmSync(sandboxAbrain, { recursive: true, force: true });
    before = await captureWholeL1RawSnapshot(production);
    ensureDirectory(sandboxAbrain);
    for (const row of before.rows) {
      const target = path.join(sandboxAbrain, ...row.relative_path.split("/"));
      ensureDirectory(path.dirname(target));
      writeExclusiveBufferedFile(target, row.raw, 0o600);
      const source = fs.lstatSync(path.join(production, ...row.relative_path.split("/")));
      const copiedStat = fs.lstatSync(target);
      if (source.dev === copiedStat.dev && source.ino === copiedStat.ino) fail("PRODUCTION_COPY_HARDLINK", "production event was hardlinked instead of copied", { event_id: row.event_id });
    }
    after = await captureWholeL1RawSnapshot(production);
    if (sameWholeSnapshot(before, after)) break;
    if (attempt === maximumAttempts) fail("PRODUCTION_L1_CHANGED_DURING_COPY", "production L1 event IDs or raw bytes changed in every bounded copy bracket", { attempts: maximumAttempts });
  }
  if (!before || !after || !sameWholeSnapshot(before, after)) fail("PRODUCTION_L1_CHANGED_DURING_COPY", "no exact production copy bracket completed");
  fsyncCopiedTree(path.join(sandboxAbrain, "l1"));
  const copied = await captureWholeL1RawSnapshot(sandboxAbrain);
  if (!sameWholeSnapshot(before, copied)) fail("SANDBOX_COPY_MISMATCH", "sandbox L1 copy differs from production event IDs/raw bytes");
  const propositionRows = copied.rows.filter((row) => row.domain === "proposition").map(toSourceRow);
  const propositionSnapshot = buildLifecycleSourceSnapshot({ sourceKind: "production_double_scan_copy", rows: propositionRows });
  return deepFreeze({
    schema_version: "proposition-lifecycle-production-copy-evidence/v1",
    production_abrain_home: production,
    sandbox_abrain_home: sandboxAbrain,
    production_before: before,
    production_after: after,
    sandbox_copy: copied,
    proposition_source_snapshot: propositionSnapshot,
    all_event_ids_and_raw_hashes_equal: true,
    no_hardlinks_to_production: true,
  });
}

export async function prepareSandboxArchiveTuple(options: { sandboxAbrainHome: string; repoRoot: string }): Promise<SandboxArchiveTuple> {
  const sandboxAbrain = exactDirectory(options.sandboxAbrainHome, "sandbox abrain home");
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  const bundle = await buildPropositionPolicyPushShadow({ abrainHome: sandboxAbrain, repoRoot, registryPath: path.join(repoRoot, "schemas", "l1-schema-role-registry.json") });
  const target = bundle.entries.entries.find((entry) => entry.lifecycle.disposition === "active" && entry.lifecycle.activation === "original" && entry.lifecycle.terminal_event_id === entry.source_event_id && entry.effective_facets.consumer_hints.policy === true);
  if (!target) fail("ARCHIVE_TARGET_MISSING", "copied real production prestate has no original active policy evidence candidate");
  const facets = clone(target.effective_facets) as PropositionFacets;
  facets.consumer_hints = { ...facets.consumer_hints, policy: false };
  facets.lineage = { causal_parents: [target.source_event_id], derives_from: [], supersedes: [] };
  facets.trigger = { trigger_kind: "user_directive", trigger_ref: "adr0040-d3-wf:sandbox-staged-archive-replay" };
  const body: PropositionLifecycleBodyV1 = {
    event_schema_version: PROPOSITION_LIFECYCLE_BODY_SCHEMA,
    event_type: "proposition_archive_declared",
    producer: { name: PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_PRODUCER_VERSION },
    epoch: { epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: target.source_epoch.genesis_event_id },
    lifecycle: { operation: "archive", modality: "meta-lifecycle", effect: "declared_only", target_event_ids: [target.source_event_id], reason: "ADR0040 D3-WF sandbox replay archives the copied real active policy evidence." },
    facets,
  };
  const envelope = buildPropositionEnvelope(PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, body) as unknown as Readonly<Record<string, unknown>>;
  const eventId = String(envelope.event_id);
  const raw = canonicalL1EnvelopeJson(envelope);
  const registry = loadL1SchemaRegistry(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"));
  validateL1Envelope(envelope, { registry, abrainHome: sandboxAbrain, relativePath: expectedL1EventRelativePath(eventId), expected: { envelopeSchema: PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, domain: "proposition", role: "meta", phase: "defined_inactive" } });
  const tuple = deepFreeze({
    tuple_schema_version: PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_TUPLE_SCHEMA,
    operation: "archive",
    producer: { name: PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_PRODUCER_VERSION },
    target_event_id: target.source_event_id,
    target_evidence_raw_sha256: sha256Hex(readExactFile(path.join(sandboxAbrain, ...expectedL1EventRelativePath(target.source_event_id).split("/")), "archive target evidence")),
    event_id: eventId,
    body_hash: eventId,
    envelope_schema: PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA,
    relative_target_path: expectedL1EventRelativePath(eventId),
    canonical_event_bytes_sha256: sha256Hex(raw),
    canonical_event_utf8_bytes: Buffer.byteLength(raw),
  });
  return deepFreeze({ tuple, tuple_hash: tupleHashForLifecycle(tuple), target_event_id: target.source_event_id, event_id: eventId, envelope, canonical_event_json: raw, canonical_event_bytes_sha256: sha256Hex(raw) });
}

export async function initializeLifecycleSandboxWorkflow(options: {
  sandboxRoot: string;
  sandboxAbrainHome: string;
  repoRoot: string;
  sourceProductionSnapshot: LifecycleSourceSnapshot;
  crashAfter?: "head_pointer";
}): Promise<SandboxWorkflowInitializationResult> {
  const prepared = prepareLifecycleControlRoot(options.sandboxRoot);
  const controlRoot = assertLifecycleControlRoot(prepared.control_root);
  const sandboxAbrain = assertSandboxAbrainHome(prepared.sandbox_root, options.sandboxAbrainHome);
  assertSameFilesystem(controlRoot, sandboxAbrain);
  validateLifecycleSourceSnapshot(options.sourceProductionSnapshot);
  const lock = acquireRetainedDirectoryOfdLock(controlRoot);
  if (lock.status === "BUSY") return { status: "BUSY", control_root: controlRoot };
  try {
    const headPointer = readHeadPointerRaw(controlRoot); const selectionPointer = readSelectionPointerRaw(controlRoot);
    if (!headPointer && selectionPointer) fail("BOOTSTRAP_PARTIAL_POINTERS", "selection pointer exists without a head pointer");
    if (headPointer && !selectionPointer) {
      const head = readLifecycleHead(controlRoot, headPointer.hash);
      const artifacts = validateGenesisHeadArtifactClosure(controlRoot, head);
      if (canonicalizeJcs(head.source) !== canonicalizeJcs(options.sourceProductionSnapshot)) fail("BOOTSTRAP_SOURCE_MISMATCH", "partial genesis head source differs from requested copied production snapshot");
      const selection = buildLifecycleSelection({ generation: 0, seq: 0, predecessorSelectionHash: null, committedHeadHash: String(head.head_hash), proofHash: null, artifacts: head.artifacts as Readonly<Record<string, unknown>> });
      writeLifecycleSelectionCas(controlRoot, selection);
      advanceLifecyclePointer(controlRoot, "selection", null, String(selection.selection_hash));
      const reader = readPropositionLifecycleFreshnessV2({ controlRoot });
      if (!reader.ok || reader.status !== "active" || reader.head_hash !== head.head_hash || reader.selection_hash !== selection.selection_hash) fail("BOOTSTRAP_RECOVERY_READBACK_FAILED", "partial genesis recovery readback differs", { reason: reader.reason });
      return { status: "created", control_root: controlRoot, head_hash: String(head.head_hash), selection_hash: String(selection.selection_hash), p2a_bundle_hash: artifacts.p2a.bundle_hash, stable_bundle_hash: artifacts.stable.bundle_hash, reader };
    }
    if (headPointer && selectionPointer) {
      const reader = readPropositionLifecycleFreshnessV2({ controlRoot });
      if (!reader.ok) fail("BOOTSTRAP_EXISTING_INVALID", "existing bootstrap control plane is invalid", { reason: reader.reason });
      return { status: "identical", control_root: controlRoot, head_hash: reader.head_hash, selection_hash: reader.selection_hash, p2a_bundle_hash: reader.p2a_bundle_hash, stable_bundle_hash: reader.stable_bundle_hash, reader };
    }
    const live = await capturePropositionDoubleSnapshot(sandboxAbrain, "production_double_scan_copy");
    if (canonicalizeJcs(live.second) !== canonicalizeJcs(options.sourceProductionSnapshot)) fail("BOOTSTRAP_SOURCE_MISMATCH", "sandbox prestate differs from copied production proposition snapshot");
    const build = await buildPropositionLifecycleV3Artifacts({ sandboxAbrainHome: sandboxAbrain, repoRoot: options.repoRoot, sourceSnapshot: live.second, stagedEvent: null });
    const references = artifactReferences(build, null);
    const head = buildLifecycleHead({ generation: 0, predecessorHeadHash: null, state: "committed", transaction: null, source: live.second, artifacts: references });
    const selection = buildLifecycleSelection({ generation: 0, seq: 0, predecessorSelectionHash: null, committedHeadHash: String(head.head_hash), proofHash: null, artifacts: references });
    writeLifecycleArtifactCas(controlRoot, build.p2a); writeLifecycleArtifactCas(controlRoot, build.stable);
    writeLifecycleHeadCas(controlRoot, head); writeLifecycleSelectionCas(controlRoot, selection);
    advanceLifecyclePointer(controlRoot, "head", null, String(head.head_hash));
    if (options.crashAfter === "head_pointer") fail("INJECTED_BOOTSTRAP_CRASH", "injected bootstrap crash after head pointer", { point: "head_pointer", head_hash: head.head_hash, selection_hash: selection.selection_hash });
    advanceLifecyclePointer(controlRoot, "selection", null, String(selection.selection_hash));
    const reader = readPropositionLifecycleFreshnessV2({ controlRoot });
    if (!reader.ok || reader.status !== "active") fail("BOOTSTRAP_READBACK_FAILED", "bootstrap reader readback differs", { reason: reader.reason });
    return { status: "created", control_root: controlRoot, head_hash: String(head.head_hash), selection_hash: String(selection.selection_hash), p2a_bundle_hash: build.p2a.bundle_hash, stable_bundle_hash: build.stable.bundle_hash, reader };
  } finally { lock.close(); }
}

export async function executeLifecycleSandboxTransaction(options: {
  sandboxRoot: string;
  sandboxAbrainHome: string;
  repoRoot: string;
  sourceProductionSnapshot: LifecycleSourceSnapshot;
  tuple: Readonly<Record<string, unknown>>;
  canonicalEventJson: string;
  expectedPredecessor?: { head_hash: string; selection_hash: string };
  crashAfter?: LifecycleCrashPoint;
  crashMode?: "exception" | "SIGKILL";
}): Promise<SandboxWorkflowExecutionResult> {
  const prepared = prepareLifecycleControlRoot(options.sandboxRoot);
  const controlRoot = assertLifecycleControlRoot(prepared.control_root);
  const sandboxAbrain = assertSandboxAbrainHome(prepared.sandbox_root, options.sandboxAbrainHome);
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  validateLifecycleSourceSnapshot(options.sourceProductionSnapshot);
  assertSameFilesystem(controlRoot, sandboxAbrain);
  const event = parseCanonical(options.canonicalEventJson, "transaction event");
  const eventId = stringHash(event.event_id, "transaction event ID");
  const tupleProducer = asRecord(options.tuple.producer, "transaction tuple producer"); const body = asRecord(event.body, "transaction event body"); const lifecycle = asRecord(body.lifecycle, "transaction lifecycle body");
  if (event.body_hash !== eventId || event.schema !== PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA || options.tuple.tuple_schema_version !== PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_TUPLE_SCHEMA
    || options.tuple.operation !== "archive" || options.tuple.envelope_schema !== PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA
    || tupleProducer.name !== PROPOSITION_SCHEMA_CONTRACT_PRODUCER || tupleProducer.version !== PROPOSITION_LIFECYCLE_SANDBOX_ARCHIVE_PRODUCER_VERSION
    || options.tuple.event_id !== eventId || options.tuple.body_hash !== eventId || lifecycle.operation !== "archive"
    || !Array.isArray(lifecycle.target_event_ids) || lifecycle.target_event_ids.length !== 1 || lifecycle.target_event_ids[0] !== options.tuple.target_event_id
    || expectedL1EventRelativePath(eventId) !== String(options.tuple.relative_target_path)) fail("TRANSACTION_TUPLE_INVALID", "transaction tuple/event binding differs");
  if (sha256Hex(options.canonicalEventJson) !== options.tuple.canonical_event_bytes_sha256 || Buffer.byteLength(options.canonicalEventJson) !== options.tuple.canonical_event_utf8_bytes) fail("TRANSACTION_TUPLE_INVALID", "transaction event raw bytes differ from tuple");

  const lock = acquireRetainedDirectoryOfdLock(controlRoot);
  if (lock.status === "BUSY") return { status: "BUSY" };
  try {
    const registry = loadL1SchemaRegistry(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"));
    validateL1Envelope(event, { registry, abrainHome: sandboxAbrain, relativePath: expectedL1EventRelativePath(eventId), expected: { envelopeSchema: PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, domain: "proposition", role: "meta", producer: PROPOSITION_SCHEMA_CONTRACT_PRODUCER, eventType: "proposition_archive_declared", phase: "defined_inactive" } });
    return await executeUnderLock({ ...options, controlRoot, sandboxAbrain, repoRoot, eventId, lock });
  } finally { lock.close(); }
}

async function executeUnderLock(options: {
  controlRoot: string;
  sandboxAbrain: string;
  repoRoot: string;
  sourceProductionSnapshot: LifecycleSourceSnapshot;
  tuple: Readonly<Record<string, unknown>>;
  canonicalEventJson: string;
  eventId: string;
  expectedPredecessor?: { head_hash: string; selection_hash: string };
  crashAfter?: LifecycleCrashPoint;
  crashMode?: "exception" | "SIGKILL";
  lock: RetainedDirectoryOfdLock;
}): Promise<SandboxWorkflowExecutionResult> {
  const headPointer = requiredPointer(readHeadPointerRaw(options.controlRoot), "head");
  const selectionPointer = requiredPointer(readSelectionPointerRaw(options.controlRoot), "selection");
  const currentHead = readLifecycleHead(options.controlRoot, headPointer.hash);
  const currentSelection = readLifecycleSelection(options.controlRoot, selectionPointer.hash);
  const selectedHead = readLifecycleHead(options.controlRoot, String(currentSelection.committed_head_hash));
  const recoveryShape = classifyPointerRecovery(currentHead, currentSelection, selectedHead, options.eventId);
  let boundPredecessorHead = selectedHead;
  let boundPredecessorSelection = currentSelection;
  if (recoveryShape === "committed/new") {
    boundPredecessorHead = readLifecycleHead(options.controlRoot, String(selectedHead.predecessor_head_hash));
    boundPredecessorSelection = readLifecycleSelection(options.controlRoot, String(currentSelection.predecessor_selection_hash));
  }
  if (options.expectedPredecessor && (options.expectedPredecessor.head_hash !== boundPredecessorHead.head_hash || options.expectedPredecessor.selection_hash !== boundPredecessorSelection.selection_hash)) fail("STALE_PREDECESSOR", "caller expected predecessor is stale");

  if (recoveryShape === "committed/new") {
    const tx = asRecord(currentHead.transaction, "current committed transaction");
    const expectedTx = transactionId(options.tuple, options.canonicalEventJson, selectedHead.predecessor_head_hash === null ? selectedHead : readLifecycleHead(options.controlRoot, String(selectedHead.predecessor_head_hash)), currentSelection.predecessor_selection_hash === null ? currentSelection : readLifecycleSelection(options.controlRoot, String(currentSelection.predecessor_selection_hash)), options.sourceProductionSnapshot);
    if (tx.event_id !== options.eventId || tx.transaction_id !== expectedTx) fail("FOREIGN_SUCCESSOR", "current committed successor is a different transaction");
    validateCommittedHeadProofClosure(options.controlRoot, currentHead);
    const reader = readPropositionLifecycleFreshnessV2({ controlRoot: options.controlRoot });
    if (!reader.ok || reader.status !== "active") fail("IDEMPOTENT_READBACK_FAILED", "committed transaction reader differs");
    return { status: "identical", transaction_id: String(tx.transaction_id), intent_hash: String(tx.intent_hash), intent_head_hash: String(tx.intent_head_hash), proof_hash: String(tx.proof_hash), committed_head_hash: String(currentHead.head_hash), selection_hash: String(currentSelection.selection_hash), event_id: options.eventId, event_state: "S4", recovery_shape: recoveryShape, reader };
  }

  if (recoveryShape === "committed/old") {
    const tx = asRecord(currentHead.transaction, "current committed transaction");
    const expectedTx = transactionId(options.tuple, options.canonicalEventJson, selectedHead, currentSelection, options.sourceProductionSnapshot);
    if (tx.event_id !== options.eventId || tx.transaction_id !== expectedTx) fail("FOREIGN_SUCCESSOR", "committed/old head is a different transaction");
    const closure = validateCommittedHeadProofClosure(options.controlRoot, currentHead);
    if (!closure) fail("PROOF_MISSING", "committed/old successor lacks proof");
    const references = asRecord(currentHead.artifacts, "committed/old artifacts");
    const selection = buildLifecycleSelection({ generation: Number(currentHead.generation), seq: Number(currentSelection.seq) + 1, predecessorSelectionHash: String(currentSelection.selection_hash), committedHeadHash: String(currentHead.head_hash), proofHash: String(tx.proof_hash), artifacts: references });
    writeLifecycleSelectionCas(options.controlRoot, selection);
    advanceLifecyclePointer(options.controlRoot, "selection", selectionPointer.raw, String(selection.selection_hash));
    const reader = readPropositionLifecycleFreshnessV2({ controlRoot: options.controlRoot });
    if (!reader.ok || reader.status !== "active") fail("RECOVERY_SELECTION_READBACK", "committed/old selection recovery readback differs");
    return { status: "committed", transaction_id: String(tx.transaction_id), intent_hash: String(tx.intent_hash), intent_head_hash: String(tx.intent_head_hash), proof_hash: String(tx.proof_hash), committed_head_hash: String(currentHead.head_hash), selection_hash: String(selection.selection_hash), event_id: options.eventId, event_state: "S4", recovery_shape: recoveryShape, reader };
  }

  const predecessorHead = recoveryShape === "old/old" ? currentHead : selectedHead;
  const predecessorSelection = currentSelection;
  if (predecessorHead.state !== "committed") fail("PREDECESSOR_NONCOMMITTED", "unique predecessor head is not committed");
  const txId = transactionId(options.tuple, options.canonicalEventJson, predecessorHead, predecessorSelection, options.sourceProductionSnapshot);
  const tupleHash = tupleHashForLifecycle(options.tuple);
  const plannedStage = buildLifecycleStage({ transactionId: txId, tupleHash, eventId: options.eventId, canonicalEventJson: options.canonicalEventJson });
  const paths = eventPaths(options.sandboxAbrain, plannedStage);
  const stageFile = path.join(options.controlRoot, "stages", "v1", `${txId}.json`);
  if (!lstatMaybe(stageFile)) {
    const preStageState = classifyEventFsm(paths, null, options.canonicalEventJson);
    if (preStageState !== "S0") fail("EVENT_WITHOUT_STAGE", "event state exists before durable stage");
    if (options.crashAfter === "S0") injected("S0", txId);
  }
  writeLifecycleStageCas(options.controlRoot, plannedStage);
  const existingStage = readStageExact(options.controlRoot, txId);
  if (!existingStage || canonicalizeJcs(existingStage) !== canonicalizeJcs(plannedStage)) fail("STAGE_CONFLICT", "durable stage differs from transaction");
  let state = classifyEventFsm(paths, existingStage, options.canonicalEventJson);
  if (state === "S1" && options.crashAfter === "S1") injected("S1", txId);

  let intent = findIntentByTransaction(options.controlRoot, txId);
  let prediction: LifecyclePredictionV1;
  const C0 = {
    predecessor: predecessorBinding(predecessorHead, predecessorSelection),
    source_production_snapshot_hash: options.sourceProductionSnapshot.snapshot_hash,
    predecessor_source_snapshot_hash: asRecord(predecessorHead.source, "predecessor source").snapshot_hash,
    stage: { stage_hash: plannedStage.stage_hash, event_id: plannedStage.event_id, canonical_event_bytes_sha256: plannedStage.canonical_event_bytes_sha256 },
    event_fsm_state: "S1",
  };
  if (!intent) {
    if (recoveryShape !== "old/old" || state !== "S1") fail("RECOVERY_INTENT_MISSING", "only stage-before-intent S1 may reconstruct a missing intent");
    const predictedBuild = await buildPredictedPost(options.sandboxAbrain, options.repoRoot, plannedStage, txId, options.crashAfter, options.crashMode);
    prediction = predictionFromBuild(predictedBuild);
    intent = buildLifecycleIntent({ transactionId: txId, tuple: options.tuple, stage: plannedStage, predecessor: predecessorBinding(predecessorHead, predecessorSelection), sourceProductionSnapshot: options.sourceProductionSnapshot, prediction, fenceEpoch: Number(predecessorHead.generation) + 1, C0 });
    writeLifecycleIntentCas(options.controlRoot, intent);
  } else {
    validateLifecycleIntent(intent); prediction = validateLifecyclePrediction(intent.prediction);
    assertIntentMatchesCall(intent, plannedStage, predecessorHead, predecessorSelection, options);
  }
  if (options.crashAfter === "intent_cas" && currentHead.head_hash === predecessorHead.head_hash) injected("intent_cas", txId);

  const predictedReferences = referencesFromPrediction(prediction, null);
  const transactionBase = {
    transaction_id: txId,
    intent_hash: String(intent.intent_hash),
    intent_head_hash: null,
    stage_hash: plannedStage.stage_hash,
    event_id: plannedStage.event_id,
    event_raw_sha256: plannedStage.canonical_event_bytes_sha256,
    predecessor_selection_hash: String(predecessorSelection.selection_hash),
    fence_epoch: Number(predecessorHead.generation) + 1,
    proof_hash: null,
  };
  let intentHead: LifecycleHeadV2;
  if (recoveryShape === "intent/old") intentHead = currentHead;
  else {
    intentHead = buildLifecycleHead({ generation: Number(predecessorHead.generation) + 1, predecessorHeadHash: String(predecessorHead.head_hash), state: "intent", transaction: transactionBase, source: prediction.post_corpus, artifacts: predictedReferences });
    writeLifecycleHeadCas(options.controlRoot, intentHead);
    advanceLifecyclePointer(options.controlRoot, "head", headPointer.raw, String(intentHead.head_hash));
  }
  if (options.crashAfter === "intent_head") injected("intent_head", txId);
  const afterIntentPointer = requiredPointer(readHeadPointerRaw(options.controlRoot), "head");
  if (afterIntentPointer.hash !== intentHead.head_hash || requiredPointer(readSelectionPointerRaw(options.controlRoot), "selection").hash !== predecessorSelection.selection_hash) fail("C1_POINTER_MISMATCH", "C1 pointers differ from intent/old");

  const C1Observation = {
    transaction_id: txId,
    stage_hash: plannedStage.stage_hash,
    head_pointer_hash: afterIntentPointer.hash,
    selection_pointer_hash: String(predecessorSelection.selection_hash),
    intent_hash: String(intent.intent_hash),
    event_state: "S1",
  };
  const C1Checkpoint = buildLifecycleCheckpoint({ transactionId: txId, checkpointName: "C1", observation: C1Observation });
  writeLifecycleCheckpointCas(options.controlRoot, C1Checkpoint);

  state = classifyEventFsm(paths, plannedStage, options.canonicalEventJson);
  if (state === "S1") {
    ensureEventParent(paths.parent);
    assertTransactionFilesystem(options.controlRoot, stageFile, paths);
    createEventTemp(paths.temp, paths.parent, options.canonicalEventJson);
    state = classifyEventFsm(paths, plannedStage, options.canonicalEventJson);
  }
  assertTransactionFilesystem(options.controlRoot, stageFile, paths);
  if (state === "S2" && options.crashAfter === "S2") injected("S2", txId);
  let CcommitCheckpoint;
  const existingCcommit = checkpointMaybe(options.controlRoot, txId, "Ccommit");
  if (existingCcommit) {
    const observation = asRecord(existingCcommit.observation, "existing Ccommit observation");
    const expected = {
      transaction_id: txId,
      stage_hash: plannedStage.stage_hash,
      intent_hash: String(intent.intent_hash),
      intent_head_hash: String(intentHead.head_hash),
      head_pointer_hash: String(intentHead.head_hash),
      selection_pointer_hash: String(predecessorSelection.selection_hash),
      event_state: "S2",
      temp_raw_sha256: plannedStage.canonical_event_bytes_sha256,
      final_absent: true,
    };
    if (canonicalizeJcs(observation) !== canonicalizeJcs(expected)) fail("CCOMMIT_MISMATCH", "durable Ccommit checkpoint differs from the same transaction pre-link observation");
    CcommitCheckpoint = existingCcommit;
  } else {
    if (state !== "S2") fail("CCOMMIT_MISSING", "S3/S4 recovery requires the durable pre-link Ccommit checkpoint");
    const observation = {
      transaction_id: txId,
      stage_hash: plannedStage.stage_hash,
      intent_hash: String(intent.intent_hash),
      intent_head_hash: String(intentHead.head_hash),
      head_pointer_hash: requiredPointer(readHeadPointerRaw(options.controlRoot), "head").hash,
      selection_pointer_hash: requiredPointer(readSelectionPointerRaw(options.controlRoot), "selection").hash,
      event_state: "S2",
      temp_raw_sha256: sha256Hex(readExactEventFile(paths.temp, options.canonicalEventJson, 1)),
      final_absent: true,
    };
    CcommitCheckpoint = buildLifecycleCheckpoint({ transactionId: txId, checkpointName: "Ccommit", observation });
    writeLifecycleCheckpointCas(options.controlRoot, CcommitCheckpoint);
  }
  if (state === "S2") {
    try { fs.linkSync(paths.temp, paths.final); }
    catch (error) { if (isCode(error, "EXDEV")) fail("SANDBOX_APPEND_EXDEV", "L1 temp-to-final hardlink crossed filesystems", { temp: paths.temp, final: paths.final }); throw error; }
    fsyncDirectory(paths.parent);
    state = classifyEventFsm(paths, plannedStage, options.canonicalEventJson);
  }
  if (state === "S3" && options.crashAfter === "S3") injected("S3", txId);
  if (state === "S3") { fs.unlinkSync(paths.temp); fsyncDirectory(paths.parent); state = classifyEventFsm(paths, plannedStage, options.canonicalEventJson); }
  if (state !== "S4") fail("EVENT_APPEND_INCOMPLETE", "event append did not converge to S4", { state });
  fsyncExactFinal(paths.final, paths.parent, options.canonicalEventJson);
  if (options.crashAfter === "S4") injected("S4", txId);

  const post = await capturePropositionDoubleSnapshot(options.sandboxAbrain, "sandbox_post_append_double_scan");
  const actualBuild = await buildPropositionLifecycleV3Artifacts({ sandboxAbrainHome: options.sandboxAbrain, repoRoot: options.repoRoot, sourceSnapshot: post.second, stagedEvent: { event_id: plannedStage.event_id, canonical_event_bytes_sha256: plannedStage.canonical_event_bytes_sha256 } });
  const actualPrediction = predictionFromBuild(actualBuild);
  if (canonicalizeJcs(actualPrediction) !== canonicalizeJcs(prediction)) fail("PREDICTION_POST_BYTES_MISMATCH", "predicted post corpus/P2a/stable/manifests/render/profile bytes differ from Cpost");
  writeLifecycleArtifactCas(options.controlRoot, actualBuild.p2a); writeLifecycleArtifactCas(options.controlRoot, actualBuild.stable);
  if (options.crashAfter === "artifacts") injected("artifacts", txId);

  const proofArtifactReferences = artifactReferences(actualBuild, null);
  const appendRow = post.second.rows.find((row) => row.event_id === plannedStage.event_id);
  if (!appendRow) fail("CPOST_APPEND_MISSING", "post scan does not contain the staged event");
  const finalAppend = measureFinalAppend(paths, plannedStage, appendRow);
  const Cpost = {
    transaction_id: txId,
    event_state: "S4",
    first_snapshot_hash: post.first.snapshot_hash,
    second_snapshot_hash: post.second.snapshot_hash,
    artifacts_hash: jcsSha256Hex(proofArtifactReferences),
    prediction_hash: prediction.prediction_hash,
    final_append: finalAppend,
  };
  const proof = buildLifecycleProof({
    intent_hash: intent.intent_hash,
    intent_head_hash: intentHead.head_hash,
    stage: { stage_hash: plannedStage.stage_hash, event_id: plannedStage.event_id, canonical_event_bytes_sha256: plannedStage.canonical_event_bytes_sha256 },
    final_append: finalAppend,
    predecessors: predecessorBinding(predecessorHead, predecessorSelection),
    fence: { fence_epoch: Number(predecessorHead.generation) + 1, writer_authority_hash: PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY_HASH, lock_identity_hash: jcsSha256Hex(options.lock.identity) },
    checkpoints: {
      C0,
      C1: C1Checkpoint.observation,
      Ccommit: CcommitCheckpoint.observation,
      Cpost,
      checkpoint_hashes: { C0: jcsSha256Hex(C0), C1: jcsSha256Hex(C1Checkpoint.observation), Ccommit: jcsSha256Hex(CcommitCheckpoint.observation), Cpost: jcsSha256Hex(Cpost) },
    },
    post_scan: { first_snapshot_hash: post.first.snapshot_hash, second_snapshot_hash: post.second.snapshot_hash, equal: true, input_event_count: post.second.input_event_count, input_event_ids_hash: post.second.input_event_ids_hash, rows_hash: post.second.rows_hash, append_row: appendRow },
    artifacts: proofArtifactReferences,
    artifact_raw_rows: artifactRawWitness(actualBuild),
  });
  writeLifecycleProofCas(options.controlRoot, proof);
  const proofReadback = readLifecycleProof(options.controlRoot, String(proof.proof_hash));
  if (canonicalizeJcs(proofReadback) !== canonicalizeJcs(proof)) fail("PROOF_READBACK_FAILED", "proof CAS readback differs");
  if (options.crashAfter === "proof") injected("proof", txId);

  const committedReferences = artifactReferences(actualBuild, String(proof.proof_hash));
  const committedTransaction = { ...transactionBase, intent_head_hash: String(intentHead.head_hash), proof_hash: String(proof.proof_hash) };
  const committedHead = buildLifecycleHead({ generation: Number(predecessorHead.generation) + 1, predecessorHeadHash: String(predecessorHead.head_hash), state: "committed", transaction: committedTransaction, source: post.second, artifacts: committedReferences });
  writeLifecycleHeadCas(options.controlRoot, committedHead);
  const currentHeadRaw = requiredPointer(readHeadPointerRaw(options.controlRoot), "head");
  if (currentHeadRaw.hash === intentHead.head_hash) advanceLifecyclePointer(options.controlRoot, "head", currentHeadRaw.raw, String(committedHead.head_hash));
  else if (currentHeadRaw.hash !== committedHead.head_hash) fail("COMMITTED_HEAD_POINTER_CONFLICT", "head pointer is neither same intent nor same committed head");
  if (options.crashAfter === "committed_head") injected("committed_head", txId);

  const selection = buildLifecycleSelection({ generation: Number(committedHead.generation), seq: Number(predecessorSelection.seq) + 1, predecessorSelectionHash: String(predecessorSelection.selection_hash), committedHeadHash: String(committedHead.head_hash), proofHash: String(proof.proof_hash), artifacts: committedReferences });
  writeLifecycleSelectionCas(options.controlRoot, selection);
  const currentSelectionRaw = requiredPointer(readSelectionPointerRaw(options.controlRoot), "selection");
  if (currentSelectionRaw.hash === predecessorSelection.selection_hash) advanceLifecyclePointer(options.controlRoot, "selection", currentSelectionRaw.raw, String(selection.selection_hash));
  else if (currentSelectionRaw.hash !== selection.selection_hash) fail("SELECTION_POINTER_CONFLICT", "selection pointer is ahead or foreign");
  const reader = readPropositionLifecycleFreshnessV2({ controlRoot: options.controlRoot });
  if (!reader.ok || reader.status !== "active" || reader.selected_head_hash !== committedHead.head_hash) fail("TRANSACTION_READBACK_FAILED", "committed selection reader readback differs", { reason: reader.ok ? reader.reason : reader.reason });
  return { status: "committed", transaction_id: txId, intent_hash: String(intent.intent_hash), intent_head_hash: String(intentHead.head_hash), proof_hash: String(proof.proof_hash), committed_head_hash: String(committedHead.head_hash), selection_hash: String(selection.selection_hash), event_id: options.eventId, event_state: "S4", recovery_shape: recoveryShape, reader };
}

export async function captureWholeL1RawSnapshot(abrainHomeInput: string): Promise<WholeL1RawSnapshot> {
  const abrainHome = exactDirectory(abrainHomeInput, "abrain scan root");
  const scan = await scanWholeL1Validated({ abrainHome });
  const rows: WholeL1RawRow[] = [];
  for (const record of scan.all) {
    const file = String(record.filePath);
    const raw = readExactFile(file, `L1 event ${record.eventId}`);
    rows.push({ event_id: record.eventId, relative_path: String(record.relativePath), bytes: Buffer.byteLength(raw), raw_sha256: sha256Hex(raw), schema: record.registration.envelope_schema, domain: record.registration.domain, classification: record.classification, raw });
  }
  rows.sort((left, right) => compare(left.event_id, right.event_id));
  const hashRows = wholeL1HashRows(rows);
  const base = {
    schema_version: WHOLE_L1_RAW_SNAPSHOT_SCHEMA,
    hash_algorithm: "sha256" as const,
    rows_hash_scope: WHOLE_L1_ROWS_HASH_SCOPE,
    snapshot_hash_scope: WHOLE_L1_SNAPSHOT_HASH_SCOPE,
    event_count: rows.length,
    event_ids_hash: jcsSha256Hex(rows.map((row) => row.event_id)),
    raw_sha256s_hash: jcsSha256Hex(rows.map((row) => ({ event_id: row.event_id, raw_sha256: row.raw_sha256 }))),
    rows_hash: jcsSha256Hex(hashRows),
  };
  const snapshot = { ...base, snapshot_hash: jcsSha256Hex({ ...base, raw_sha256_rows: hashRows }), rows };
  validateWholeL1RawSnapshot(snapshot);
  return deepFreeze(snapshot);
}

export function validateWholeL1RawSnapshot(value: unknown): WholeL1RawSnapshot {
  const snapshot = asRecord(value, "whole L1 raw snapshot") as unknown as WholeL1RawSnapshot;
  const keys = Object.keys(snapshot as unknown as Record<string, unknown>).sort(compare);
  const expectedKeys = ["event_count", "event_ids_hash", "hash_algorithm", "raw_sha256s_hash", "rows", "rows_hash", "rows_hash_scope", "schema_version", "snapshot_hash", "snapshot_hash_scope"].sort(compare);
  if (canonicalizeJcs(keys) !== canonicalizeJcs(expectedKeys)) fail("WHOLE_L1_SNAPSHOT_INVALID", "whole L1 raw snapshot keys differ");
  if (snapshot.schema_version !== WHOLE_L1_RAW_SNAPSHOT_SCHEMA || snapshot.hash_algorithm !== "sha256" || snapshot.rows_hash_scope !== WHOLE_L1_ROWS_HASH_SCOPE || snapshot.snapshot_hash_scope !== WHOLE_L1_SNAPSHOT_HASH_SCOPE) fail("WHOLE_L1_SNAPSHOT_INVALID", "whole L1 raw snapshot hash contract differs");
  if (!Array.isArray(snapshot.rows) || !Number.isSafeInteger(snapshot.event_count) || snapshot.event_count < 0 || snapshot.rows.length !== snapshot.event_count) fail("WHOLE_L1_SNAPSHOT_INVALID", "whole L1 raw snapshot cardinality differs");
  for (const field of [snapshot.event_ids_hash, snapshot.raw_sha256s_hash, snapshot.rows_hash, snapshot.snapshot_hash]) if (!HASH.test(field)) fail("WHOLE_L1_SNAPSHOT_INVALID", "whole L1 raw snapshot contains a non-SHA-256 hash");
  let previous = "";
  for (const [index, rowValue] of snapshot.rows.entries()) {
    const row = asRecord(rowValue, `whole L1 raw snapshot row ${index}`) as unknown as WholeL1RawRow;
    const rowKeys = Object.keys(row as unknown as Record<string, unknown>).sort(compare);
    const expectedRowKeys = ["bytes", "classification", "domain", "event_id", "raw", "raw_sha256", "relative_path", "schema"].sort(compare);
    if (canonicalizeJcs(rowKeys) !== canonicalizeJcs(expectedRowKeys) || !HASH.test(row.event_id) || !HASH.test(row.raw_sha256) || typeof row.raw !== "string" || typeof row.relative_path !== "string" || typeof row.schema !== "string" || typeof row.domain !== "string" || typeof row.classification !== "string" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) fail("WHOLE_L1_SNAPSHOT_INVALID", "whole L1 raw snapshot row shape differs", { index });
    if ((previous && compare(previous, row.event_id) >= 0) || row.bytes !== Buffer.byteLength(row.raw) || row.raw_sha256 !== sha256Hex(row.raw)) fail("WHOLE_L1_RAW_BINDING_INVALID", "whole L1 row raw bytes are not directly bound to its identity", { index, event_id: row.event_id });
    previous = row.event_id;
  }
  const hashRows = wholeL1HashRows(snapshot.rows);
  const base = {
    schema_version: WHOLE_L1_RAW_SNAPSHOT_SCHEMA,
    hash_algorithm: "sha256" as const,
    rows_hash_scope: WHOLE_L1_ROWS_HASH_SCOPE,
    snapshot_hash_scope: WHOLE_L1_SNAPSHOT_HASH_SCOPE,
    event_count: snapshot.rows.length,
    event_ids_hash: jcsSha256Hex(snapshot.rows.map((row) => row.event_id)),
    raw_sha256s_hash: jcsSha256Hex(snapshot.rows.map((row) => ({ event_id: row.event_id, raw_sha256: row.raw_sha256 }))),
    rows_hash: jcsSha256Hex(hashRows),
  };
  if (snapshot.event_ids_hash !== base.event_ids_hash || snapshot.raw_sha256s_hash !== base.raw_sha256s_hash || snapshot.rows_hash !== base.rows_hash || snapshot.snapshot_hash !== jcsSha256Hex({ ...base, raw_sha256_rows: hashRows })) fail("WHOLE_L1_HASH_BINDING_INVALID", "whole L1 summary hashes do not directly bind the ordered raw SHA-256 rows");
  return snapshot;
}

export function captureNoFollowProtectedSnapshot(paths: readonly string[]): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown>[] = [];
  const walk = (file: string) => {
    const stat = lstatMaybe(file);
    if (!stat) { entries.push({ path: file, type: "missing" }); return; }
    const identity = { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size };
    if (stat.isSymbolicLink()) { entries.push({ path: file, type: "symlink", ...identity, link_raw_sha256: sha256Hex(fs.readlinkSync(file, { encoding: "buffer" })) }); return; }
    if (stat.isFile()) { entries.push({ path: file, type: "file", ...identity, raw_sha256: sha256Hex(readExactFile(file, `protected ${file}`)) }); return; }
    if (!stat.isDirectory()) { entries.push({ path: file, type: "other", ...identity }); return; }
    entries.push({ path: file, type: "directory", ...identity });
    for (const name of fs.readdirSync(file).sort(compare)) walk(path.join(file, name));
  };
  for (const file of [...paths].map((item) => path.resolve(item)).sort(compare)) walk(file);
  return deepFreeze({ schema_version: "proposition-lifecycle-protected-snapshot/v1", roots: [...paths].map((item) => path.resolve(item)).sort(compare), entries, snapshot_hash: jcsSha256Hex(entries) });
}

function predictionFromBuild(build: PropositionLifecycleV3Build): LifecyclePredictionV1 {
  return buildLifecyclePrediction({
    post_corpus: build.source_snapshot,
    p2a_v3: { bundle_hash: build.p2a.bundle_hash, artifact_bytes: build.p2a.artifacts },
    stable_v3: { bundle_hash: build.stable.bundle_hash, artifact_bytes: build.stable.artifacts },
    manifests: {
      p2a_manifest_raw_sha256: sha256Hex(build.p2a.artifacts["manifest.json"]),
      p2a_manifest_hash: build.p2a.bundle_hash,
      stable_manifest_raw_sha256: sha256Hex(build.stable.artifacts["manifest.json"]),
      stable_manifest_hash: build.stable.bundle_hash,
    },
    render: { raw_sha256: build.render.raw_sha256, bytes: build.render.bytes, raw: build.stable.artifacts["view.md"] },
    profile: { relative_path: build.profile.relative_path, raw_sha256: build.profile.raw_sha256, bytes: build.profile.bytes, raw: build.stable.artifacts["compile-profile.json"] },
  });
}

async function buildPredictedPost(sandboxAbrain: string, repoRoot: string, stage: LifecycleStageV1, transactionId: string, crashAfter?: LifecycleCrashPoint, crashMode: "exception" | "SIGKILL" = "exception"): Promise<PropositionLifecycleV3Build> {
  const { sandboxRoot, predictionRoot } = predictionWorkPaths(sandboxAbrain, transactionId);
  const residue = lstatMaybe(predictionRoot);
  if (residue) {
    validatePredictionResidue({ sandboxRoot, sandboxAbrain, predictionRoot, stage });
    fs.rmSync(predictionRoot, { recursive: true, force: false });
    fsyncDirectory(sandboxRoot);
    if (lstatMaybe(predictionRoot)) fail("PREDICTION_RECOVERY_FAILED", "same-transaction prediction residue remained after exact cleanup");
  }
  try {
    ensureDirectory(predictionRoot);
    predictionCrash("prediction_directory_created", transactionId, crashAfter, crashMode);
    const predictionAbrain = path.join(predictionRoot, "abrain"); ensureDirectory(predictionAbrain);
    const sourceL1 = path.join(sandboxAbrain, "l1");
    if (lstatMaybe(sourceL1)) copyPredictionTree(sourceL1, path.join(predictionAbrain, "l1"), () => predictionCrash("prediction_partially_copied", transactionId, crashAfter, crashMode));
    else predictionCrash("prediction_partially_copied", transactionId, crashAfter, crashMode);
    const paths = eventPaths(predictionAbrain, stage);
    if (lstatMaybe(paths.temp)) { readExactEventFile(paths.temp, stage.canonical_event_json, 1); fs.unlinkSync(paths.temp); }
    ensureEventParent(paths.parent);
    const final = lstatMaybe(paths.final);
    if (final) readExactEventFile(paths.final, stage.canonical_event_json, 1);
    else writeExclusiveFile(paths.final, stage.canonical_event_json, 0o600);
    const source = await capturePropositionDoubleSnapshot(predictionAbrain, "sandbox_post_append_double_scan");
    const build = await buildPropositionLifecycleV3Artifacts({ sandboxAbrainHome: predictionAbrain, repoRoot, sourceSnapshot: source.second, stagedEvent: { event_id: stage.event_id, canonical_event_bytes_sha256: stage.canonical_event_bytes_sha256 } });
    predictionCrash("prediction_built_before_intent", transactionId, crashAfter, crashMode);
    return build;
  } finally {
    if (lstatMaybe(predictionRoot)) {
      validatePredictionResidue({ sandboxRoot, sandboxAbrain, predictionRoot, stage });
      fs.rmSync(predictionRoot, { recursive: true, force: false });
      fsyncDirectory(sandboxRoot);
    }
  }
}

function predictionWorkPaths(sandboxAbrain: string, transactionId: string): { sandboxRoot: string; predictionRoot: string } {
  if (!HASH.test(transactionId)) fail("PREDICTION_PATH_INVALID", "prediction transaction ID must be SHA-256");
  const sandboxRoot = exactDirectory(path.dirname(sandboxAbrain), "prediction sandbox root");
  const basename = `.prediction-${transactionId}`;
  const predictionRoot = path.resolve(sandboxRoot, basename);
  const relative = path.relative(sandboxRoot, predictionRoot);
  const forbidden = [sandboxRoot, sandboxAbrain, path.join(sandboxAbrain, "l1"), path.join(sandboxRoot, "proposition-lifecycle-freshness-v3")];
  if (path.basename(predictionRoot) !== basename || path.dirname(predictionRoot) !== sandboxRoot || relative !== basename || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || forbidden.includes(predictionRoot)) fail("PREDICTION_PATH_INVALID", "prediction work root escaped or aliased a protected sandbox root", { predictionRoot });
  return { sandboxRoot, predictionRoot };
}

function validatePredictionResidue(input: { sandboxRoot: string; sandboxAbrain: string; predictionRoot: string; stage: LifecycleStageV1 }): void {
  const expected = predictionWorkPaths(input.sandboxAbrain, input.stage.transaction_id);
  if (expected.sandboxRoot !== input.sandboxRoot || expected.predictionRoot !== input.predictionRoot) fail("PREDICTION_PATH_INVALID", "prediction residue does not belong to the same transaction");
  const rootStat = fs.lstatSync(input.predictionRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fs.realpathSync(input.predictionRoot) !== input.predictionRoot) fail("PREDICTION_RESIDUE_UNSAFE", "same-transaction prediction residue root is not an exact directory", { predictionRoot: input.predictionRoot });
  for (const protectedRoot of [input.sandboxRoot, input.sandboxAbrain, path.join(input.sandboxAbrain, "l1"), path.join(input.sandboxRoot, "proposition-lifecycle-freshness-v3")]) {
    const protectedStat = lstatMaybe(protectedRoot);
    if (protectedStat && rootStat.dev === protectedStat.dev && rootStat.ino === protectedStat.ino) fail("PREDICTION_RESIDUE_UNSAFE", "prediction residue aliases a sandbox, control, or L1 root inode", { predictionRoot: input.predictionRoot, protectedRoot });
  }
  const stagedRelative = expectedL1EventRelativePath(input.stage.event_id);
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const candidate = path.join(directory, name);
      const relativeRoot = path.relative(input.predictionRoot, candidate);
      if (!relativeRoot || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) fail("PREDICTION_RESIDUE_UNSAFE", "prediction residue entry escaped its root", { candidate });
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) fail("PREDICTION_RESIDUE_UNSAFE", "prediction residue contains a symlink", { candidate });
      if (relativeRoot === "abrain") {
        if (!stat.isDirectory()) fail("PREDICTION_RESIDUE_SHAPE_INVALID", "prediction abrain residue is not a directory");
        walk(candidate); continue;
      }
      if (!relativeRoot.startsWith(`abrain${path.sep}`)) fail("PREDICTION_RESIDUE_SHAPE_INVALID", "prediction residue contains a foreign top-level entry", { relativeRoot });
      const relativeAbrain = relativeRoot.slice(`abrain${path.sep}`.length).split(path.sep).join("/");
      const sourceCandidate = path.join(input.sandboxAbrain, ...relativeAbrain.split("/"));
      const sourceStat = lstatMaybe(sourceCandidate);
      const stagedPrefix = stagedRelative === relativeAbrain || stagedRelative.startsWith(`${relativeAbrain}/`);
      if (stat.isDirectory()) {
        if ((!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) && !stagedPrefix) fail("PREDICTION_RESIDUE_SHAPE_INVALID", "prediction residue directory is not a source/staged prefix", { relativeAbrain });
        walk(candidate); continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail("PREDICTION_RESIDUE_UNSAFE", "prediction residue contains a non-regular or multiply-linked file", { relativeAbrain, nlink: stat.nlink });
      const raw = readOpenFile(candidate, "prediction residue file", 1);
      if (relativeAbrain === stagedRelative) {
        if (raw !== input.stage.canonical_event_json) fail("PREDICTION_RESIDUE_SHAPE_INVALID", "prediction staged event residue bytes differ");
      } else {
        if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile() || readExactFile(sourceCandidate, "prediction source counterpart") !== raw) fail("PREDICTION_RESIDUE_SHAPE_INVALID", "prediction residue file is not an exact source copy", { relativeAbrain });
      }
    }
  };
  walk(input.predictionRoot);
}

function copyPredictionTree(source: string, target: string, afterFirstFile: () => void): void {
  let injected = false;
  const copy = (from: string, to: string) => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) fail("PREDICTION_SOURCE_UNSAFE", "prediction source tree contains a symlink", { from });
    if (stat.isDirectory()) {
      ensureDirectory(to);
      for (const name of fs.readdirSync(from).sort(compare)) copy(path.join(from, name), path.join(to, name));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) fail("PREDICTION_SOURCE_UNSAFE", "prediction source tree contains a non-regular or multiply-linked file", { from, nlink: stat.nlink });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (!injected) { injected = true; afterFirstFile(); }
  };
  copy(source, target);
  if (!injected) afterFirstFile();
}

function predictionCrash(point: typeof PREDICTION_CRASH_POINTS[number], transactionId: string, crashAfter?: LifecycleCrashPoint, crashMode: "exception" | "SIGKILL" = "exception"): void {
  if (crashAfter !== point) return;
  if (crashMode === "SIGKILL") {
    process.kill(process.pid, "SIGKILL");
    fail("INJECTED_CRASH_FAILED", "SIGKILL prediction crash injection returned unexpectedly", { point, transaction_id: transactionId });
  }
  injected(point, transactionId);
}

async function capturePropositionDoubleSnapshot(abrainHome: string, sourceKind: LifecycleSourceSnapshot["source_kind"]): Promise<{ first: LifecycleSourceSnapshot; second: LifecycleSourceSnapshot }> {
  const firstWhole = await captureWholeL1RawSnapshot(abrainHome); const secondWhole = await captureWholeL1RawSnapshot(abrainHome);
  if (!sameWholeSnapshot(firstWhole, secondWhole)) fail("SANDBOX_L1_SCAN_RACE", "sandbox whole-L1 IDs/raw bytes changed across double scan");
  const toSnapshot = (whole: WholeL1RawSnapshot) => buildLifecycleSourceSnapshot({ sourceKind, rows: whole.rows.filter((row) => row.domain === "proposition").map(toSourceRow) });
  return { first: toSnapshot(firstWhole), second: toSnapshot(secondWhole) };
}

function classifyPointerRecovery(currentHead: LifecycleHeadV2, selection: LifecycleSelectionV2, selectedHead: LifecycleHeadV2, eventId: string): "old/old" | "intent/old" | "committed/old" | "committed/new" {
  if (selection.committed_head_hash !== selectedHead.head_hash || selectedHead.state !== "committed" || selection.generation !== selectedHead.generation) fail("SELECTION_AHEAD", "selection does not bind its committed head");
  if (currentHead.head_hash === selectedHead.head_hash) {
    if (currentHead.transaction !== null && asRecord(currentHead.transaction, "current committed transaction").event_id === eventId) return "committed/new";
    return "old/old";
  }
  if (currentHead.predecessor_head_hash !== selectedHead.head_hash || Number(currentHead.generation) !== Number(selectedHead.generation) + 1) fail("CURRENT_HEAD_FORK", "current head is not the unique successor of selected head");
  const transaction = asRecord(currentHead.transaction, "current head transaction");
  if (transaction.predecessor_selection_hash !== selection.selection_hash) fail("SELECTION_AHEAD", "current head predecessor selection differs");
  if (currentHead.state === "intent") return "intent/old";
  if (currentHead.state === "committed") return "committed/old";
  fail("HEAD_ABORTED", "explicit abort is not implemented");
}

function transactionId(tuple: Readonly<Record<string, unknown>>, raw: string, predecessorHead: LifecycleHeadV2, predecessorSelection: LifecycleSelectionV2, sourceProductionSnapshot: LifecycleSourceSnapshot): string {
  return transactionIdForLifecycle({
    tuple,
    staged_event: { event_id: JSON.parse(raw).event_id, canonical_event_bytes_sha256: sha256Hex(raw) },
    unique_predecessor: predecessorBinding(predecessorHead, predecessorSelection),
    source_production_snapshot_hash: sourceProductionSnapshot.snapshot_hash,
  });
}

function predecessorBinding(head: LifecycleHeadV2, selection: LifecycleSelectionV2): { head_hash: string; selection_hash: string; generation: number; selection_seq: number } {
  return { head_hash: String(head.head_hash), selection_hash: String(selection.selection_hash), generation: Number(head.generation), selection_seq: Number(selection.seq) };
}

function artifactReferences(build: PropositionLifecycleV3Build, proofHash: string | null): Readonly<Record<string, unknown>> {
  return deepFreeze({ p2a_bundle_hash: build.p2a.bundle_hash, stable_bundle_hash: build.stable.bundle_hash, stable_manifest_hash: build.stable.bundle_hash, rendered_view_sha256: build.render.raw_sha256, profile_raw_sha256: build.profile.raw_sha256, proof_hash: proofHash });
}

function artifactRawWitness(build: PropositionLifecycleV3Build): Readonly<Record<string, unknown>> {
  const rows = (artifacts: Readonly<Record<string, string>>, names: readonly string[]) => names.map((name) => ({ name, bytes: Buffer.byteLength(artifacts[name]), raw_sha256: sha256Hex(artifacts[name]) }));
  const p2a = rows(build.p2a.artifacts, PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES);
  const stable = rows(build.stable.artifacts, PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES);
  const profile = stable[0];
  return deepFreeze({ p2a, stable, profile, rows_hash: jcsSha256Hex({ p2a, stable, profile }) });
}

function referencesFromPrediction(prediction: LifecyclePredictionV1, proofHash: string | null): Readonly<Record<string, unknown>> {
  const p2a = asRecord(prediction.p2a_v3, "prediction p2a"); const stable = asRecord(prediction.stable_v3, "prediction stable"); const manifests = asRecord(prediction.manifests, "prediction manifests"); const render = asRecord(prediction.render, "prediction render"); const profile = asRecord(prediction.profile, "prediction profile");
  return deepFreeze({ p2a_bundle_hash: p2a.bundle_hash, stable_bundle_hash: stable.bundle_hash, stable_manifest_hash: manifests.stable_manifest_hash, rendered_view_sha256: render.raw_sha256, profile_raw_sha256: profile.raw_sha256, proof_hash: proofHash });
}

function assertIntentMatchesCall(intent: LifecycleIntentV2, stage: LifecycleStageV1, predecessorHead: LifecycleHeadV2, predecessorSelection: LifecycleSelectionV2, options: { sourceProductionSnapshot: LifecycleSourceSnapshot; tuple: Readonly<Record<string, unknown>> }): void {
  const transaction = asRecord(intent.transaction, "recovery intent transaction"); const staged = asRecord(intent.staged_event, "recovery intent stage"); const predecessor = asRecord(intent.unique_predecessor, "recovery intent predecessor");
  if (transaction.transaction_id !== stage.transaction_id || transaction.tuple_hash !== tupleHashForLifecycle(options.tuple) || canonicalizeJcs(transaction.tuple) !== canonicalizeJcs(options.tuple)
    || staged.stage_hash !== stage.stage_hash || predecessor.head_hash !== predecessorHead.head_hash || predecessor.selection_hash !== predecessorSelection.selection_hash
    || asRecord(intent.source_production_snapshot, "intent production snapshot").snapshot_hash !== options.sourceProductionSnapshot.snapshot_hash) fail("RECOVERY_TRANSACTION_MISMATCH", "recovery is not the same transaction/intent");
}

function findIntentByTransaction(controlRoot: string, transactionId: string): LifecycleIntentV2 | null {
  const directory = path.join(controlRoot, "intents", "v2"); if (!lstatMaybe(directory)) return null;
  const matches: LifecycleIntentV2[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) fail("INTENT_FOREIGN_ENTRY", "intent CAS directory contains a foreign entry", { name });
    const intent = readLifecycleIntent(controlRoot, name.slice(0, 64));
    if (asRecord(intent.transaction, "intent transaction").transaction_id === transactionId) matches.push(intent);
  }
  if (matches.length > 1) fail("INTENT_FORK", "transaction has multiple intents");
  return matches[0] ?? null;
}

function readStageExact(controlRoot: string, transactionId: string): LifecycleStageV1 | null {
  const file = path.join(controlRoot, "stages", "v1", `${transactionId}.json`); const stat = lstatMaybe(file); if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) fail("STAGE_FILE_UNSAFE", "stage CAS must be no-symlink regular mode-0600 nlink-1", { mode: stat.mode & 0o777, nlink: stat.nlink });
  return validateLifecycleStage(parseCanonical(readExactFile(file, "stage CAS"), "stage CAS"));
}

function checkpointMaybe(controlRoot: string, transactionId: string, name: "Ccommit") {
  const file = path.join(controlRoot, "checkpoints", "v1", `${transactionId}.${name}.json`); if (!lstatMaybe(file)) return null;
  return readLifecycleCheckpoint(controlRoot, transactionId, name);
}

function eventPaths(abrainHome: string, stage: LifecycleStageV1) {
  const final = path.join(abrainHome, ...expectedL1EventRelativePath(stage.event_id).split("/"));
  const parent = path.dirname(final);
  const temp = path.join(parent, `.${stage.event_id}.json.${stage.transaction_id.slice(0, 24)}.tmp`);
  return { final, parent, temp };
}

type EventFsm = "S0" | "S1" | "S2" | "S3" | "S4";
function classifyEventFsm(paths: ReturnType<typeof eventPaths>, stage: LifecycleStageV1 | null, raw: string): EventFsm {
  const temp = lstatMaybe(paths.temp); const final = lstatMaybe(paths.final);
  const parent = lstatMaybe(paths.parent);
  if (parent) {
    if (parent.isSymbolicLink() || !parent.isDirectory()) fail("EVENT_PARENT_UNSAFE", "event parent is not an exact directory");
    for (const name of fs.readdirSync(paths.parent)) {
      const file = path.join(paths.parent, name); const stat = fs.lstatSync(file);
      if (name === path.basename(paths.temp) || name === path.basename(paths.final)) continue;
      if (!EVENT_FILE.test(name) || stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) fail("EVENT_PARENT_FOREIGN_ENTRY", "event parent contains a foreign/symlink/mode/nlink entry", { name, mode: stat.mode & 0o777, nlink: stat.nlink });
    }
  }
  if (!stage) { if (temp || final) fail("EVENT_WITHOUT_STAGE", "temp/final exists before durable stage"); return "S0"; }
  if (!temp && !final) return "S1";
  if (temp && !final) { readExactEventFile(paths.temp, raw, 1); return "S2"; }
  if (temp && final) {
    const tempRaw = readExactEventFile(paths.temp, raw, 2); const finalRaw = readExactEventFile(paths.final, raw, 2);
    const left = fs.lstatSync(paths.temp); const right = fs.lstatSync(paths.final);
    if (left.dev !== right.dev || left.ino !== right.ino || tempRaw !== finalRaw) fail("EVENT_S3_CONFLICT", "S3 temp/final are not exact same-inode bytes");
    return "S3";
  }
  readExactEventFile(paths.final, raw, 1); return "S4";
}

function createEventTemp(file: string, parent: string, raw: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); writeAll(fd, Buffer.from(raw)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  readExactEventFile(file, raw, 1); fsyncDirectory(parent);
}
function readExactEventFile(file: string, expected: string, nlink: number): string { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== nlink) fail("EVENT_FILE_CONFLICT", "event temp/final type, mode, or nlink differs", { file, mode: stat.mode & 0o7777, nlink: stat.nlink }); const raw = readOpenFile(file, "event file", nlink); if (raw !== expected) fail("EVENT_FILE_CONFLICT", "event temp/final bytes differ", { file, expected: sha256Hex(expected), actual: sha256Hex(raw) }); return raw; }
function fsyncExactFinal(file: string, parent: string, raw: string): void { const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); if (fs.readFileSync(fd, "utf8") !== raw) fail("EVENT_FINAL_READBACK", "S4 final readback differs"); const stat = fs.fstatSync(fd); if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) fail("EVENT_FINAL_READBACK", "S4 final identity differs"); } finally { fs.closeSync(fd); } fsyncDirectory(parent); }
function measureFinalAppend(paths: ReturnType<typeof eventPaths>, stage: LifecycleStageV1, appendRow: LifecycleSourceRow): Readonly<Record<string, unknown>> { if (lstatMaybe(paths.temp)) fail("CPOST_APPEND_INVALID", "S4 deterministic temp is still present"); const stat = fs.lstatSync(paths.final); const raw = readExactEventFile(paths.final, stage.canonical_event_json, 1); const relative = expectedL1EventRelativePath(stage.event_id); if (appendRow.event_id !== stage.event_id || appendRow.relative_path !== relative || appendRow.bytes !== stat.size || appendRow.raw_sha256 !== sha256Hex(raw) || stat.size !== stage.canonical_event_utf8_bytes || sha256Hex(raw) !== stage.canonical_event_bytes_sha256) fail("CPOST_APPEND_INVALID", "S4 file, stage, and post-scan row differ"); return deepFreeze({ relative_path: relative, state: "S4", temp_absent: true, bytes: stat.size, raw_sha256: sha256Hex(raw), mode: stat.mode & 0o7777, nlink: stat.nlink }); }
function ensureEventParent(parent: string): void { ensureDirectory(parent); const stat = fs.lstatSync(parent); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("EVENT_PARENT_UNSAFE", "event parent is unsafe"); }
function assertTransactionFilesystem(controlRoot: string, stageFile: string, paths: ReturnType<typeof eventPaths>): void { const candidates = [{ label: "control", file: controlRoot }, { label: "stage", file: stageFile }, { label: "L1 parent/final device", file: paths.parent }, ...(lstatMaybe(paths.temp) ? [{ label: "L1 temp", file: paths.temp }] : []), ...(lstatMaybe(paths.final) ? [{ label: "L1 final", file: paths.final }] : [])]; const devices = candidates.map(({ label, file }) => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) fail("SANDBOX_FILESYSTEM_UNSAFE", `${label} is a symlink`, { file }); return { label, file, dev: Number(stat.dev) }; }); if (new Set(devices.map((row) => row.dev)).size !== 1) fail("SANDBOX_FILESYSTEM_EXDEV", "control/stage/L1 temp/final devices differ before append publication", { devices }); }

export function sameWholeSnapshot(left: WholeL1RawSnapshot, right: WholeL1RawSnapshot): boolean { validateWholeL1RawSnapshot(left); validateWholeL1RawSnapshot(right); return left.snapshot_hash === right.snapshot_hash; }
function wholeL1HashRows(rows: readonly WholeL1RawRow[]): ReadonlyArray<Omit<WholeL1RawRow, "raw">> { return rows.map(({ raw: _raw, ...row }) => row); }
function toSourceRow(row: WholeL1RawRow): LifecycleSourceRow { return { event_id: row.event_id, relative_path: row.relative_path, bytes: row.bytes, raw_sha256: row.raw_sha256 }; }
function requiredPointer<T extends { hash: string; raw: string }>(value: T | null, kind: string): T { if (!value) fail("POINTER_MISSING", `${kind} pointer is missing`); return value; }
function assertSameFilesystem(controlRoot: string, sandboxAbrain: string): void { const control = fs.lstatSync(controlRoot); const abrain = fs.lstatSync(sandboxAbrain); if (control.isSymbolicLink() || !control.isDirectory() || abrain.isSymbolicLink() || !abrain.isDirectory()) fail("SANDBOX_FILESYSTEM_UNSAFE", "sandbox control and L1 roots must be exact directories"); if (control.dev !== abrain.dev) fail("SANDBOX_FILESYSTEM_EXDEV", "sandbox control and L1 roots are on different filesystems", { control_dev: Number(control.dev), l1_dev: Number(abrain.dev) }); }
function assertSandboxAbrainHome(sandboxRoot: string, input: string): string { const actual = exactDirectory(input, "sandbox abrain home"); const expected = path.join(sandboxRoot, "abrain-copy"); if (actual !== expected) fail("SANDBOX_ABRAIN_PATH_INVALID", "sandbox L1 home must be the fixed child of the validated system-temp sandbox root", { actual, expected }); return actual; }
function exactDirectory(input: string, label: string): string { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) fail("DIRECTORY_UNSAFE", `${label} must be an exact directory`, { resolved }); return resolved; }
function readExactFile(file: string, label: string): string { return readOpenFile(file, label, 1); }
function readOpenFile(file: string, label: string, expectedNlink: number): string { const named = fs.lstatSync(file); if (named.isSymbolicLink() || !named.isFile() || named.nlink !== expectedNlink) fail("FILE_UNSAFE", `${label} is not exact regular expected-nlink`, { file, nlink: named.nlink }); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size || opened.nlink !== expectedNlink) fail("FILE_RACE", `${label} changed while opened`); const raw = fs.readFileSync(fd, "utf8"); const after = fs.fstatSync(fd); if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== expectedNlink) fail("FILE_RACE", `${label} changed while read`); return raw; } finally { fs.closeSync(fd); } }
function writeExclusiveFile(file: string, raw: string, mode: number): void { const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode); try { fs.fchmodSync(fd, mode); writeAll(fd, Buffer.from(raw)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fsyncDirectory(path.dirname(file)); }
function writeExclusiveBufferedFile(file: string, raw: string, mode: number): void { const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode); try { fs.fchmodSync(fd, mode); writeAll(fd, Buffer.from(raw)); } finally { fs.closeSync(fd); } }
function ensureDirectory(directory: string): void { const stat = lstatMaybe(directory); if (stat) { if (stat.isSymbolicLink() || !stat.isDirectory()) fail("DIRECTORY_UNSAFE", "directory path is unsafe", { directory }); return; } ensureDirectory(path.dirname(directory)); fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); fsyncDirectory(path.dirname(directory)); }
function fsyncCopiedTree(root: string): void { if (!lstatMaybe(root)) return; const directories: string[] = []; const walk = (dir: string) => { directories.push(dir); for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) fail("SANDBOX_COPY_SYMLINK", "copied L1 contains a symlink", { file }); if (stat.isDirectory()) walk(file); else { const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } } }; walk(root); for (const directory of directories.reverse()) fsyncDirectory(directory); }
function fsyncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); }
function parseCanonical(raw: string, label: string): Record<string, unknown> { let value: unknown; try { value = JSON.parse(raw); } catch (error) { fail("JSON_INVALID", `${label} is not JSON`, { error: message(error) }); } const record = asRecord(value, label); if (`${canonicalizeJcs(record)}\n` !== raw) fail("JSON_NONCANONICAL", `${label} is not RFC8785-JCS plus LF`); return record; }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("SHAPE_INVALID", `${label} must be an object`); return value as Record<string, unknown>; }
function stringHash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH.test(value)) fail("HASH_INVALID", `${label} must be SHA-256`); return value; }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; } }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function injected(point: string, transactionId: string): never { fail("INJECTED_CRASH", `injected crash after ${point}`, { point, transaction_id: transactionId }); }
function fail(code: string, text: string, detail?: Record<string, unknown>): never { throw new PropositionLifecycleFreshnessSandboxWriterError(code, text, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

export const __TEST = Object.freeze({ assertSameFilesystem, assertTransactionFilesystem, predictionWorkPaths, validatePredictionResidue });
