/// <reference types="node" />
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES,
  PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES,
  PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA,
  reconstructPropositionLifecycleP2aV3Bundle,
  reconstructPropositionLifecycleStableV3Bundle,
  lifecycleSourceSnapshotBinding,
  validateLifecycleSourceSnapshot,
  validatePropositionLifecycleP2aV3Bundle,
  validatePropositionLifecycleStableV3Bundle,
  type LifecycleSourceSnapshot,
  type PropositionLifecycleP2aV3Bundle,
  type PropositionLifecycleStableV3Bundle,
} from "./proposition-lifecycle-freshness-v3";

export const PROPOSITION_LIFECYCLE_FRESHNESS_LAYOUT_V3 = "proposition-lifecycle-freshness-sandbox-cas/v3" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_STAGE_V1_SCHEMA = "proposition-lifecycle-freshness-stage/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_PREDICTION_V1_SCHEMA = "proposition-lifecycle-freshness-prediction/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_INTENT_V2_SCHEMA = "proposition-lifecycle-freshness-writer-intent/v2" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_V2_SCHEMA = "proposition-lifecycle-freshness-head/v2" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_V2_SCHEMA = "proposition-lifecycle-freshness-selection/v2" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_CHECKPOINT_V1_SCHEMA = "proposition-lifecycle-freshness-checkpoint/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_PROOF_V1_SCHEMA = "proposition-lifecycle-freshness-commit-proof/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA = "proposition-lifecycle-freshness-head-pointer/v2" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA = "proposition-lifecycle-freshness-selection-pointer/v2" as const;

const HASH = /^[0-9a-f]{64}$/;
const ROOT_ENTRIES = Object.freeze(["checkpoints", "heads", "intents", "p2a", "proofs", "selections", "stable", "stages"] as const);
const AUDIT = deepFreeze({ time_fields: "external_audit_only" as const, excluded_from_identity: true as const });
const STAGE_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this stage object with stage_hash omitted" as const;
const PREDICTION_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this prediction object with prediction_hash omitted" as const;
const INTENT_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this intent object with intent_hash and audit omitted" as const;
const HEAD_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this head object with head_hash and audit omitted" as const;
const SELECTION_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this selection object with selection_hash and audit omitted" as const;
const CHECKPOINT_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this checkpoint object with checkpoint_hash omitted" as const;
const PROOF_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this proof object with proof_hash and audit omitted" as const;
const AUTHORITY_BASE = deepFreeze({
  writer: "proposition-lifecycle-freshness-sandbox-writer/v2" as const,
  authority: "repo_sandbox_only" as const,
  layout: PROPOSITION_LIFECYCLE_FRESHNESS_LAYOUT_V3,
  control_root_lock: "retained_directory_ofd_flock_xn_fd3" as const,
  official_writer_linearization_only: true as const,
  foreign_writers_not_excluded: true as const,
  production_paths_forbidden: true as const,
});
export const PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY_HASH = jcsSha256Hex(AUTHORITY_BASE);
export const PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY = deepFreeze({ ...AUTHORITY_BASE, authority_hash: PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY_HASH });

export type LifecycleHeadState = "intent" | "committed" | "aborted";
export type LifecycleCrashPoint = "S0" | "S1" | "prediction_directory_created" | "prediction_partially_copied" | "prediction_built_before_intent" | "intent_cas" | "intent_head" | "S2" | "S3" | "S4" | "artifacts" | "proof" | "committed_head" | null;

export interface LifecycleStageV1 {
  schema_version: typeof PROPOSITION_LIFECYCLE_FRESHNESS_STAGE_V1_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  stage_hash_scope: typeof STAGE_SCOPE;
  transaction_id: string;
  tuple_hash: string;
  event_id: string;
  canonical_event_bytes_sha256: string;
  canonical_event_utf8_bytes: number;
  canonical_event_json: string;
  stage_hash: string;
}

export interface LifecyclePredictionV1 {
  schema_version: typeof PROPOSITION_LIFECYCLE_FRESHNESS_PREDICTION_V1_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  prediction_hash_scope: typeof PREDICTION_SCOPE;
  post_corpus: LifecycleSourceSnapshot;
  p2a_v3: Record<string, unknown>;
  stable_v3: Record<string, unknown>;
  manifests: Record<string, unknown>;
  render: Record<string, unknown>;
  profile: Record<string, unknown>;
  prediction_hash: string;
}

export type LifecycleIntentV2 = Readonly<Record<string, unknown>>;
export type LifecycleHeadV2 = Readonly<Record<string, unknown>>;
export type LifecycleSelectionV2 = Readonly<Record<string, unknown>>;
export type LifecycleCheckpointV1 = Readonly<Record<string, unknown>>;
export type LifecycleProofV1 = Readonly<Record<string, unknown>>;
export interface LifecycleVerifiedPointer { hash: string; raw: string; identity_hash: string }
export interface LifecyclePointerTestHooks { afterPrepareBeforeSecondRead?: () => void }
export interface LifecycleCasTestHooks { afterLinkBeforeUnlink?: () => void }

export type LifecycleFreshnessReadResult =
  | {
    ok: true;
    status: "active" | "fallback";
    reason: "selected_consistent" | "intent_head_old_selection" | "committed_head_old_selection";
    head_hash: string;
    selected_head_hash: string;
    selection_hash: string;
    generation: number;
    selection_seq: number;
    proof_hash: string | null;
    p2a_bundle_hash: string;
    stable_bundle_hash: string;
    stable_manifest_hash: string;
    view_md: string;
    item_count: number;
    source_counts: { input_events: number; evidence_events: number; lifecycle_events: number; candidates: number; exclusions: number; diagnostics: number };
  }
  | { ok: false; reason: string; error?: string; head_hash?: string; selection_hash?: string };

export class PropositionLifecycleFreshnessControlV2Error extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionLifecycleFreshnessControlV2Error";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function assertLifecycleSandboxRoot(input: string): string {
  const resolved = path.resolve(input);
  const temp = fs.realpathSync(os.tmpdir());
  if (resolved === temp || !inside(temp, resolved)) fail("SANDBOX_ROOT_REQUIRED", "sandbox root must be a strict child of the real system temp directory", { resolved, temp });
  for (const production of ["/home/worker/.abrain", "/home/worker/.pi", "/home/worker/.pi/agent/skills/pi-astack"]) {
    const root = path.resolve(production);
    if (inside(root, resolved) || inside(resolved, root)) fail("PRODUCTION_PATH_FORBIDDEN", "sandbox root overlaps a protected production or repository root", { resolved, root });
  }
  assertExistingAncestorsNoSymlink(resolved);
  const stat = lstatMaybe(resolved);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved)) fail("SANDBOX_ROOT_UNSAFE", "sandbox root is not an exact directory", { resolved });
  return resolved;
}

export function prepareLifecycleControlRoot(sandboxRootInput: string): { sandbox_root: string; control_root: string } {
  const sandboxRoot = assertLifecycleSandboxRoot(sandboxRootInput);
  ensureDirectory(sandboxRoot);
  const controlRoot = path.join(sandboxRoot, "proposition-lifecycle-freshness-v3");
  ensureDirectory(controlRoot);
  for (const name of ROOT_ENTRIES) ensureDirectory(path.join(controlRoot, name));
  assertControlRootEntries(controlRoot);
  return { sandbox_root: sandboxRoot, control_root: controlRoot };
}

export function assertLifecycleControlRoot(controlRootInput: string): string {
  const controlRoot = path.resolve(controlRootInput);
  assertLifecycleSandboxRoot(path.dirname(controlRoot));
  const stat = fs.lstatSync(controlRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(controlRoot) !== controlRoot) fail("CONTROL_ROOT_UNSAFE", "control root must be an exact directory");
  assertControlRootEntries(controlRoot);
  return controlRoot;
}

export function buildLifecycleStage(input: {
  transactionId: string;
  tupleHash: string;
  eventId: string;
  canonicalEventJson: string;
}): LifecycleStageV1 {
  for (const [label, value] of [["transaction ID", input.transactionId], ["tuple hash", input.tupleHash], ["event ID", input.eventId]] as const) assertHash(value, label);
  const rawHash = sha256Hex(input.canonicalEventJson);
  const parsed = parseCanonical(input.canonicalEventJson, "staged canonical event");
  if (parsed.event_id !== input.eventId || parsed.body_hash !== input.eventId) fail("STAGE_EVENT_INVALID", "staged envelope identity differs");
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_STAGE_V1_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    stage_hash_scope: STAGE_SCOPE,
    transaction_id: input.transactionId,
    tuple_hash: input.tupleHash,
    event_id: input.eventId,
    canonical_event_bytes_sha256: rawHash,
    canonical_event_utf8_bytes: Buffer.byteLength(input.canonicalEventJson),
    canonical_event_json: input.canonicalEventJson,
  };
  return deepFreeze({ ...base, stage_hash: jcsSha256Hex(base) });
}

export function validateLifecycleStage(value: unknown): LifecycleStageV1 {
  const stage = asRecord(value, "stage") as unknown as LifecycleStageV1;
  exactKeys(stage as unknown as Record<string, unknown>, ["schema_version", "canonicalization", "hash_algorithm", "stage_hash_scope", "transaction_id", "tuple_hash", "event_id", "canonical_event_bytes_sha256", "canonical_event_utf8_bytes", "canonical_event_json", "stage_hash"], "stage");
  if (stage.schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_STAGE_V1_SCHEMA || stage.canonicalization !== "RFC8785-JCS" || stage.hash_algorithm !== "sha256" || stage.stage_hash_scope !== STAGE_SCOPE) fail("STAGE_INVALID", "stage identity differs");
  for (const [label, hash] of [["transaction", stage.transaction_id], ["tuple", stage.tuple_hash], ["event", stage.event_id], ["raw", stage.canonical_event_bytes_sha256], ["stage", stage.stage_hash]] as const) assertHash(hash, `stage ${label}`);
  if (!Number.isSafeInteger(stage.canonical_event_utf8_bytes) || stage.canonical_event_utf8_bytes <= 0 || Buffer.byteLength(stage.canonical_event_json) !== stage.canonical_event_utf8_bytes || sha256Hex(stage.canonical_event_json) !== stage.canonical_event_bytes_sha256) fail("STAGE_INVALID", "stage raw bytes binding differs");
  const envelope = parseCanonical(stage.canonical_event_json, "stage event");
  if (envelope.event_id !== stage.event_id || envelope.body_hash !== stage.event_id) fail("STAGE_INVALID", "stage event tuple differs");
  validateHashWithOmissions(stage as unknown as Record<string, unknown>, "stage_hash", [], STAGE_SCOPE, "stage");
  return deepFreeze(stage);
}

export function buildLifecyclePrediction(input: Omit<LifecyclePredictionV1, "schema_version" | "canonicalization" | "hash_algorithm" | "prediction_hash_scope" | "prediction_hash">): LifecyclePredictionV1 {
  validateLifecycleSourceSnapshot(input.post_corpus);
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_PREDICTION_V1_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    prediction_hash_scope: PREDICTION_SCOPE,
    ...input,
  };
  const prediction = deepFreeze({ ...base, prediction_hash: jcsSha256Hex(base) });
  validateLifecyclePrediction(prediction);
  return prediction;
}

export function validateLifecyclePrediction(value: unknown): LifecyclePredictionV1 {
  const prediction = asRecord(value, "prediction") as unknown as LifecyclePredictionV1;
  exactKeys(prediction as unknown as Record<string, unknown>, ["schema_version", "canonicalization", "hash_algorithm", "prediction_hash_scope", "post_corpus", "p2a_v3", "stable_v3", "manifests", "render", "profile", "prediction_hash"], "prediction");
  if (prediction.schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_PREDICTION_V1_SCHEMA || prediction.canonicalization !== "RFC8785-JCS" || prediction.hash_algorithm !== "sha256" || prediction.prediction_hash_scope !== PREDICTION_SCOPE) fail("PREDICTION_INVALID", "prediction identity differs");
  validateLifecycleSourceSnapshot(prediction.post_corpus);
  for (const section of [prediction.p2a_v3, prediction.stable_v3, prediction.manifests, prediction.render, prediction.profile]) assertOnlyJson(section, "prediction section");
  validateHashWithOmissions(prediction as unknown as Record<string, unknown>, "prediction_hash", [], PREDICTION_SCOPE, "prediction");
  return deepFreeze(prediction);
}

export function buildLifecycleIntent(input: {
  transactionId: string;
  tuple: Readonly<Record<string, unknown>>;
  stage: LifecycleStageV1;
  predecessor: { head_hash: string; selection_hash: string; generation: number; selection_seq: number };
  sourceProductionSnapshot: LifecycleSourceSnapshot;
  prediction: LifecyclePredictionV1;
  fenceEpoch: number;
  C0: Readonly<Record<string, unknown>>;
}): LifecycleIntentV2 {
  validateLifecycleStage(input.stage); validateLifecyclePrediction(input.prediction); validateLifecycleSourceSnapshot(input.sourceProductionSnapshot);
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_INTENT_V2_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    intent_hash_scope: INTENT_SCOPE,
    authority_binding: PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY,
    transaction: { transaction_id: input.transactionId, tuple: input.tuple, tuple_hash: jcsSha256Hex(input.tuple) },
    staged_event: { event_id: input.stage.event_id, canonical_event_bytes_sha256: input.stage.canonical_event_bytes_sha256, stage_hash: input.stage.stage_hash },
    unique_predecessor: input.predecessor,
    source_production_snapshot: input.sourceProductionSnapshot,
    prediction: input.prediction,
    fencing: { fence_epoch: input.fenceEpoch, predecessor_generation_plus_one: true, expected_predecessor_read_check_under_lock: true },
    checkpoints: { C0: input.C0, C0_hash: jcsSha256Hex(input.C0), required: ["C0", "C1", "Ccommit", "Cpost"] },
    recovery: { same_transaction_only: true, same_intent_only: true, same_proof_only: true, ttl_or_mtime_abort: false, explicit_abort_implemented: false },
    audit: AUDIT,
  };
  const intent = withIdentity(base, "intent_hash", ["audit"]);
  validateLifecycleIntent(intent);
  return intent;
}

export function validateLifecycleIntent(value: unknown): LifecycleIntentV2 {
  const intent = asRecord(value, "intent");
  exactKeys(intent, ["schema_version", "canonicalization", "hash_algorithm", "intent_hash_scope", "authority_binding", "transaction", "staged_event", "unique_predecessor", "source_production_snapshot", "prediction", "fencing", "checkpoints", "recovery", "audit", "intent_hash"], "intent");
  assertCommonIdentity(intent, PROPOSITION_LIFECYCLE_FRESHNESS_INTENT_V2_SCHEMA, "intent_hash_scope", INTENT_SCOPE, "intent");
  validateAuthority(intent.authority_binding); validateAudit(intent.audit);
  const tx = asRecord(intent.transaction, "intent.transaction"); exactKeys(tx, ["transaction_id", "tuple", "tuple_hash"], "intent.transaction"); assertHash(tx.transaction_id, "intent transaction ID"); assertHash(tx.tuple_hash, "intent tuple hash"); if (tx.tuple_hash !== jcsSha256Hex(tx.tuple)) fail("INTENT_INVALID", "intent tuple hash differs");
  const stage = asRecord(intent.staged_event, "intent.staged_event"); exactKeys(stage, ["event_id", "canonical_event_bytes_sha256", "stage_hash"], "intent.staged_event"); for (const valueHash of Object.values(stage)) assertHash(valueHash, "intent staged hash");
  const predecessor = validatePredecessor(intent.unique_predecessor, "intent predecessor");
  validateLifecycleSourceSnapshot(intent.source_production_snapshot as LifecycleSourceSnapshot); validateLifecyclePrediction(intent.prediction);
  const fencing = asRecord(intent.fencing, "intent.fencing"); exactKeys(fencing, ["fence_epoch", "predecessor_generation_plus_one", "expected_predecessor_read_check_under_lock"], "intent.fencing"); if (fencing.fence_epoch !== predecessor.generation + 1 || fencing.predecessor_generation_plus_one !== true || fencing.expected_predecessor_read_check_under_lock !== true) fail("INTENT_FENCE_INVALID", "intent fence epoch differs from predecessor generation + 1");
  const checkpoints = asRecord(intent.checkpoints, "intent.checkpoints"); exactKeys(checkpoints, ["C0", "C0_hash", "required"], "intent.checkpoints"); assertHash(checkpoints.C0_hash, "intent C0 hash"); if (checkpoints.C0_hash !== jcsSha256Hex(checkpoints.C0) || canonicalizeJcs(checkpoints.required) !== canonicalizeJcs(["C0", "C1", "Ccommit", "Cpost"])) fail("INTENT_CHECKPOINT_INVALID", "intent C0 binding differs");
  const recovery = asRecord(intent.recovery, "intent.recovery"); if (canonicalizeJcs(recovery) !== canonicalizeJcs({ same_transaction_only: true, same_intent_only: true, same_proof_only: true, ttl_or_mtime_abort: false, explicit_abort_implemented: false })) fail("INTENT_RECOVERY_INVALID", "intent recovery policy differs");
  validateHashWithOmissions(intent, "intent_hash", ["audit"], INTENT_SCOPE, "intent");
  return deepFreeze(intent);
}

export function buildLifecycleHead(input: {
  generation: number;
  predecessorHeadHash: string | null;
  state: LifecycleHeadState;
  transaction: Readonly<Record<string, unknown>> | null;
  source: LifecycleSourceSnapshot;
  artifacts: Readonly<Record<string, unknown>>;
}): LifecycleHeadV2 {
  validateLifecycleSourceSnapshot(input.source);
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_V2_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    head_hash_scope: HEAD_SCOPE,
    authority_binding: PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY,
    generation: input.generation,
    predecessor_head_hash: input.predecessorHeadHash,
    state: input.state,
    transaction: input.transaction,
    source: input.source,
    artifacts: input.artifacts,
    audit: AUDIT,
  };
  const head = withIdentity(base, "head_hash", ["audit"]);
  validateLifecycleHead(head);
  return head;
}

export function validateLifecycleHead(value: unknown): LifecycleHeadV2 {
  const head = asRecord(value, "head");
  exactKeys(head, ["schema_version", "canonicalization", "hash_algorithm", "head_hash_scope", "authority_binding", "generation", "predecessor_head_hash", "state", "transaction", "source", "artifacts", "audit", "head_hash"], "head");
  assertCommonIdentity(head, PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_V2_SCHEMA, "head_hash_scope", HEAD_SCOPE, "head"); validateAuthority(head.authority_binding); validateAudit(head.audit);
  assertNonnegative(head.generation, "head generation");
  if (head.predecessor_head_hash === null) { if (head.generation !== 0) fail("HEAD_CHAIN_INVALID", "only generation zero may have no predecessor"); }
  else { assertHash(head.predecessor_head_hash, "head predecessor"); if (head.generation === 0) fail("HEAD_CHAIN_INVALID", "generation zero cannot have a predecessor"); }
  if (!(["intent", "committed", "aborted"] as unknown[]).includes(head.state)) fail("HEAD_STATE_INVALID", "head state differs");
  validateLifecycleSourceSnapshot(head.source as LifecycleSourceSnapshot);
  const artifacts = validateArtifactBinding(head.artifacts, "head artifacts");
  if (head.transaction === null) {
    if (head.state !== "committed" || head.generation !== 0 || head.predecessor_head_hash !== null || artifacts.proof_hash !== null) fail("HEAD_BOOTSTRAP_INVALID", "only committed generation-zero bootstrap may omit transaction");
  } else {
    const transaction = asRecord(head.transaction, "head.transaction");
    exactKeys(transaction, ["transaction_id", "intent_hash", "intent_head_hash", "stage_hash", "event_id", "event_raw_sha256", "predecessor_selection_hash", "fence_epoch", "proof_hash"], "head.transaction");
    for (const field of ["transaction_id", "intent_hash", "stage_hash", "event_id", "event_raw_sha256", "predecessor_selection_hash"] as const) assertHash(transaction[field], `head transaction ${field}`);
    assertNonnegative(transaction.fence_epoch, "head fence epoch");
    if (transaction.fence_epoch !== head.generation) fail("HEAD_FENCE_INVALID", "head fence epoch must equal generation");
    if (head.state === "intent") {
      if (transaction.intent_head_hash !== null || transaction.proof_hash !== null || artifacts.proof_hash !== null) fail("HEAD_STATE_INVALID", "intent head carries a cyclic self binding or proof");
    } else if (head.state === "committed") {
      assertHash(transaction.intent_head_hash, "committed head intent head"); assertHash(transaction.proof_hash, "committed head proof"); if (artifacts.proof_hash !== transaction.proof_hash) fail("HEAD_STATE_INVALID", "committed head proof bindings differ");
    } else if (transaction.intent_head_hash !== null || transaction.proof_hash !== null || artifacts.proof_hash !== null) fail("HEAD_STATE_INVALID", "aborted head carries intent-head/proof binding");
  }
  validateHashWithOmissions(head, "head_hash", ["audit"], HEAD_SCOPE, "head");
  return deepFreeze(head);
}

export function buildLifecycleSelection(input: {
  generation: number;
  seq: number;
  predecessorSelectionHash: string | null;
  committedHeadHash: string;
  proofHash: string | null;
  artifacts: Readonly<Record<string, unknown>>;
}): LifecycleSelectionV2 {
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_V2_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    selection_hash_scope: SELECTION_SCOPE,
    authority_binding: PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY,
    generation: input.generation,
    seq: input.seq,
    predecessor_selection_hash: input.predecessorSelectionHash,
    decision: "selected",
    committed_head_hash: input.committedHeadHash,
    proof_hash: input.proofHash,
    references: input.artifacts,
    activation: { only_activation_pointer: "selections/current.json", committed_head_required: true, proof_verified_before_artifacts: true, reader_reads_l1: false, reader_compiles: false, v1_fallback_forbidden: true },
    audit: AUDIT,
  };
  const selection = withIdentity(base, "selection_hash", ["audit"]);
  validateLifecycleSelection(selection);
  return selection;
}

export function validateLifecycleSelection(value: unknown): LifecycleSelectionV2 {
  const selection = asRecord(value, "selection");
  exactKeys(selection, ["schema_version", "canonicalization", "hash_algorithm", "selection_hash_scope", "authority_binding", "generation", "seq", "predecessor_selection_hash", "decision", "committed_head_hash", "proof_hash", "references", "activation", "audit", "selection_hash"], "selection");
  assertCommonIdentity(selection, PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_V2_SCHEMA, "selection_hash_scope", SELECTION_SCOPE, "selection"); validateAuthority(selection.authority_binding); validateAudit(selection.audit);
  assertNonnegative(selection.generation, "selection generation"); assertNonnegative(selection.seq, "selection seq"); assertHash(selection.committed_head_hash, "selection committed head");
  if (selection.predecessor_selection_hash === null) { if (selection.generation !== 0 || selection.seq !== 0 || selection.proof_hash !== null) fail("SELECTION_CHAIN_INVALID", "selection genesis differs"); }
  else { assertHash(selection.predecessor_selection_hash, "selection predecessor"); if (selection.seq === 0) fail("SELECTION_CHAIN_INVALID", "selection successor seq must be positive"); assertHash(selection.proof_hash, "selection proof"); }
  if (selection.decision !== "selected") fail("SELECTION_INVALID", "selection decision differs");
  const references = validateArtifactBinding(selection.references, "selection references"); if (references.proof_hash !== selection.proof_hash) fail("SELECTION_INVALID", "selection proof reference differs");
  const activation = asRecord(selection.activation, "selection.activation");
  if (canonicalizeJcs(activation) !== canonicalizeJcs({ only_activation_pointer: "selections/current.json", committed_head_required: true, proof_verified_before_artifacts: true, reader_reads_l1: false, reader_compiles: false, v1_fallback_forbidden: true })) fail("SELECTION_INVALID", "selection activation contract differs");
  validateHashWithOmissions(selection, "selection_hash", ["audit"], SELECTION_SCOPE, "selection");
  return deepFreeze(selection);
}

export function buildLifecycleCheckpoint(input: { transactionId: string; checkpointName: "C1" | "Ccommit"; observation: Readonly<Record<string, unknown>> }): LifecycleCheckpointV1 {
  assertHash(input.transactionId, "checkpoint transaction ID");
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_CHECKPOINT_V1_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    checkpoint_hash_scope: CHECKPOINT_SCOPE,
    transaction_id: input.transactionId,
    checkpoint_name: input.checkpointName,
    observation: input.observation,
    observation_hash: jcsSha256Hex(input.observation),
  };
  const checkpoint = withIdentity(base, "checkpoint_hash", []);
  validateLifecycleCheckpoint(checkpoint);
  return checkpoint;
}

export function validateLifecycleCheckpoint(value: unknown): LifecycleCheckpointV1 {
  const checkpoint = asRecord(value, "checkpoint");
  exactKeys(checkpoint, ["schema_version", "canonicalization", "hash_algorithm", "checkpoint_hash_scope", "transaction_id", "checkpoint_name", "observation", "observation_hash", "checkpoint_hash"], "checkpoint");
  assertCommonIdentity(checkpoint, PROPOSITION_LIFECYCLE_FRESHNESS_CHECKPOINT_V1_SCHEMA, "checkpoint_hash_scope", CHECKPOINT_SCOPE, "checkpoint");
  assertHash(checkpoint.transaction_id, "checkpoint transaction"); assertHash(checkpoint.observation_hash, "checkpoint observation");
  if (checkpoint.checkpoint_name !== "C1" && checkpoint.checkpoint_name !== "Ccommit") fail("CHECKPOINT_INVALID", "checkpoint name differs");
  if (checkpoint.observation_hash !== jcsSha256Hex(checkpoint.observation)) fail("CHECKPOINT_INVALID", "checkpoint observation hash differs");
  validateHashWithOmissions(checkpoint, "checkpoint_hash", [], CHECKPOINT_SCOPE, "checkpoint");
  return deepFreeze(checkpoint);
}

export function buildLifecycleProof(input: Omit<Record<string, unknown>, "schema_version" | "canonicalization" | "hash_algorithm" | "proof_hash_scope" | "audit" | "proof_hash">): LifecycleProofV1 {
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_PROOF_V1_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    proof_hash_scope: PROOF_SCOPE,
    ...input,
    audit: AUDIT,
  };
  const proof = withIdentity(base, "proof_hash", ["audit"]);
  validateLifecycleProof(proof);
  return proof;
}

export function validateLifecycleProof(value: unknown): LifecycleProofV1 {
  const proof = asRecord(value, "proof");
  exactKeys(proof, ["schema_version", "canonicalization", "hash_algorithm", "proof_hash_scope", "intent_hash", "intent_head_hash", "stage", "final_append", "predecessors", "fence", "checkpoints", "post_scan", "artifacts", "artifact_raw_rows", "audit", "proof_hash"], "proof");
  assertCommonIdentity(proof, PROPOSITION_LIFECYCLE_FRESHNESS_PROOF_V1_SCHEMA, "proof_hash_scope", PROOF_SCOPE, "proof"); validateAudit(proof.audit);
  assertHash(proof.intent_hash, "proof intent"); assertHash(proof.intent_head_hash, "proof intent head");
  const stage = asRecord(proof.stage, "proof.stage");
  exactKeys(stage, ["stage_hash", "event_id", "canonical_event_bytes_sha256"], "proof.stage");
  for (const hash of Object.values(stage)) assertHash(hash, "proof stage hash");
  const finalAppend = validateFinalAppend(proof.final_append, "proof.final_append");
  if (finalAppend.relative_path !== eventRelativePath(String(stage.event_id)) || finalAppend.raw_sha256 !== stage.canonical_event_bytes_sha256) fail("PROOF_APPEND_STAGE_MISMATCH", "proof final append path/raw hash differs from staged event");
  const predecessors = validatePredecessor(proof.predecessors, "proof predecessors");
  const fence = asRecord(proof.fence, "proof.fence"); exactKeys(fence, ["fence_epoch", "writer_authority_hash", "lock_identity_hash"], "proof.fence"); if (fence.fence_epoch !== predecessors.generation + 1 || fence.writer_authority_hash !== PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY_HASH) fail("PROOF_FENCE_INVALID", "proof fence differs"); assertHash(fence.lock_identity_hash, "proof lock identity");
  const checkpoints = asRecord(proof.checkpoints, "proof.checkpoints"); exactKeys(checkpoints, ["C0", "C1", "Ccommit", "Cpost", "checkpoint_hashes"], "proof.checkpoints"); const hashes = asRecord(checkpoints.checkpoint_hashes, "proof checkpoint hashes"); exactKeys(hashes, ["C0", "C1", "Ccommit", "Cpost"], "proof checkpoint hashes"); for (const key of ["C0", "C1", "Ccommit", "Cpost"]) { assertHash(hashes[key], `proof ${key}`); if (hashes[key] !== jcsSha256Hex(checkpoints[key])) fail("PROOF_CHECKPOINT_INVALID", `proof ${key} hash differs`); }
  const Cpost = asRecord(checkpoints.Cpost, "proof Cpost");
  exactKeys(Cpost, ["transaction_id", "event_state", "first_snapshot_hash", "second_snapshot_hash", "artifacts_hash", "prediction_hash", "final_append"], "proof Cpost");
  assertHash(Cpost.transaction_id, "proof Cpost transaction"); assertHash(Cpost.first_snapshot_hash, "proof Cpost first"); assertHash(Cpost.second_snapshot_hash, "proof Cpost second"); assertHash(Cpost.artifacts_hash, "proof Cpost artifacts"); assertHash(Cpost.prediction_hash, "proof Cpost prediction");
  if (Cpost.event_state !== "S4" || canonicalizeJcs(validateFinalAppend(Cpost.final_append, "proof Cpost final append")) !== canonicalizeJcs(finalAppend)) fail("PROOF_CPOST_APPEND_MISMATCH", "proof Cpost final append differs");
  const post = asRecord(proof.post_scan, "proof.post_scan"); exactKeys(post, ["first_snapshot_hash", "second_snapshot_hash", "equal", "input_event_count", "input_event_ids_hash", "rows_hash", "append_row"], "proof.post_scan"); assertHash(post.first_snapshot_hash, "proof post first"); assertHash(post.second_snapshot_hash, "proof post second"); assertHash(post.input_event_ids_hash, "proof post IDs"); assertHash(post.rows_hash, "proof post rows"); if (post.equal !== true || post.first_snapshot_hash !== post.second_snapshot_hash || post.first_snapshot_hash !== Cpost.first_snapshot_hash || post.second_snapshot_hash !== Cpost.second_snapshot_hash || !Number.isSafeInteger(post.input_event_count) || Number(post.input_event_count) <= 0) fail("PROOF_POST_SCAN_INVALID", "proof post scans differ from Cpost");
  const appendRow = validateAppendRow(post.append_row, "proof post append row");
  if (appendRow.event_id !== stage.event_id || appendRow.relative_path !== finalAppend.relative_path || appendRow.bytes !== finalAppend.bytes || appendRow.raw_sha256 !== finalAppend.raw_sha256) fail("PROOF_POST_APPEND_MISMATCH", "proof post-scan append row differs from final append");
  validateArtifactBinding(proof.artifacts, "proof artifacts");
  validateProofArtifactRawRows(proof.artifact_raw_rows);
  validateHashWithOmissions(proof, "proof_hash", ["audit"], PROOF_SCOPE, "proof");
  return deepFreeze(proof);
}

export function transactionIdForLifecycle(input: Readonly<Record<string, unknown>>): string { return jcsSha256Hex(input); }
export function tupleHashForLifecycle(tuple: Readonly<Record<string, unknown>>): string { return jcsSha256Hex(tuple); }
export function canonicalControlJson(value: unknown): string { return `${canonicalizeJcs(value)}\n`; }

export function writeLifecycleStageCas(controlRootInput: string, stage: LifecycleStageV1): boolean {
  validateLifecycleStage(stage); const root = assertLifecycleControlRoot(controlRootInput);
  return durableCasCreate(root, `stages/v1/${stage.transaction_id}.json`, canonicalControlJson(stage));
}
export function writeLifecycleIntentCas(controlRootInput: string, intent: LifecycleIntentV2): boolean {
  validateLifecycleIntent(intent); const root = assertLifecycleControlRoot(controlRootInput);
  return durableCasCreate(root, `intents/v2/${String(intent.intent_hash)}.json`, canonicalControlJson(intent));
}
export function writeLifecycleHeadCas(controlRootInput: string, head: LifecycleHeadV2): boolean {
  validateLifecycleHead(head); const root = assertLifecycleControlRoot(controlRootInput);
  return durableCasCreate(root, `heads/v2/${String(head.head_hash)}.json`, canonicalControlJson(head));
}
export function writeLifecycleCheckpointCas(controlRootInput: string, checkpoint: LifecycleCheckpointV1): boolean {
  validateLifecycleCheckpoint(checkpoint); const root = assertLifecycleControlRoot(controlRootInput);
  return durableCasCreate(root, `checkpoints/v1/${String(checkpoint.transaction_id)}.${String(checkpoint.checkpoint_name)}.json`, canonicalControlJson(checkpoint));
}
export function writeLifecycleProofCas(controlRootInput: string, proof: LifecycleProofV1): boolean {
  validateLifecycleProof(proof); const root = assertLifecycleControlRoot(controlRootInput);
  return durableCasCreate(root, `proofs/v1/${String(proof.proof_hash)}.json`, canonicalControlJson(proof));
}
export function writeLifecycleSelectionCas(controlRootInput: string, selection: LifecycleSelectionV2): boolean {
  validateLifecycleSelection(selection); const root = assertLifecycleControlRoot(controlRootInput);
  return durableCasCreate(root, `selections/v2/${String(selection.selection_hash)}.json`, canonicalControlJson(selection));
}

export function writeLifecycleArtifactCas(controlRootInput: string, bundle: PropositionLifecycleP2aV3Bundle | PropositionLifecycleStableV3Bundle): boolean {
  const root = assertLifecycleControlRoot(controlRootInput);
  const isP2a = String(bundle.manifest.schema_version) === PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA;
  if (isP2a) validatePropositionLifecycleP2aV3Bundle(bundle as PropositionLifecycleP2aV3Bundle); else validatePropositionLifecycleStableV3Bundle(bundle as PropositionLifecycleStableV3Bundle);
  const names = isP2a ? PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES : PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES;
  const family = isP2a ? "p2a" : "stable";
  let changed = false;
  for (const name of names) changed = durableCasCreate(root, `${family}/v3/bundles/${bundle.bundle_hash}/${name}`, bundle.artifacts[name as never]) || changed;
  assertBundleDirectoryExact(path.join(root, family, "v3", "bundles", bundle.bundle_hash), names);
  return changed;
}

export function readHeadPointerRaw(controlRootInput: string): LifecycleVerifiedPointer | null { return readPointer(assertLifecycleControlRoot(controlRootInput), "head"); }
export function readSelectionPointerRaw(controlRootInput: string): LifecycleVerifiedPointer | null { return readPointer(assertLifecycleControlRoot(controlRootInput), "selection"); }

export function advanceLifecyclePointer(controlRootInput: string, kind: "head" | "selection", expectedRaw: string | null, nextHash: string, testHooks?: LifecyclePointerTestHooks): boolean {
  assertHash(nextHash, `${kind} pointer hash`);
  const root = assertLifecycleControlRoot(controlRootInput);
  const schema = kind === "head" ? PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA : PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA;
  const field = kind === "head" ? "head_hash" : "selection_hash";
  const nextRaw = canonicalControlJson({ schema_version: schema, [field]: nextHash });
  const directory = path.join(root, kind === "head" ? "heads" : "selections");
  const target = path.join(directory, "current.json");
  const temporary = path.join(directory, `.current.${sha256Hex(nextRaw).slice(0, 24)}.tmp`);
  assertNoForeignDeterministicTemps(directory, ".current.", ".tmp", temporary, "pointer");
  const current = readPointer(root, kind);
  if (current?.raw === nextRaw) { cleanupExactPointerTemp(temporary, nextRaw); return false; }
  if ((current?.raw ?? null) !== expectedRaw) { cleanupExactPointerTemp(temporary, nextRaw); fail("POINTER_PREDECESSOR_MISMATCH", `${kind} pointer expected predecessor differs`, { expectedRawHash: expectedRaw ? sha256Hex(expectedRaw) : null, actualRawHash: current ? sha256Hex(current.raw) : null }); }
  prepareExactPointerTemp(temporary, nextRaw);
  testHooks?.afterPrepareBeforeSecondRead?.();
  const immediatelyBeforeRename = readPointer(root, kind);
  if (immediatelyBeforeRename?.raw === nextRaw) { cleanupExactPointerTemp(temporary, nextRaw); return false; }
  if ((immediatelyBeforeRename?.raw ?? null) !== expectedRaw) {
    cleanupExactPointerTemp(temporary, nextRaw);
    fail("POINTER_PREDECESSOR_MISMATCH", `${kind} pointer changed after temp preparation`, { expectedRawHash: expectedRaw ? sha256Hex(expectedRaw) : null, actualRawHash: immediatelyBeforeRename ? sha256Hex(immediatelyBeforeRename.raw) : null });
  }
  fs.renameSync(temporary, target);
  fsyncDirectory(directory);
  const readback = readPointer(root, kind);
  if (!readback || readback.raw !== nextRaw || readback.hash !== nextHash) fail("POINTER_READBACK_FAILED", `${kind} pointer readback differs`);
  return true;
}

export function readLifecycleHead(controlRootInput: string, hash: string): LifecycleHeadV2 { assertHash(hash, "requested head hash"); const value = validateLifecycleHead(readCasJson(assertLifecycleControlRoot(controlRootInput), `heads/v2/${hash}.json`, "head")); return assertCasObjectIdentity(value, "head_hash", hash, "head"); }
export function readLifecycleIntent(controlRootInput: string, hash: string): LifecycleIntentV2 { assertHash(hash, "requested intent hash"); const value = validateLifecycleIntent(readCasJson(assertLifecycleControlRoot(controlRootInput), `intents/v2/${hash}.json`, "intent")); return assertCasObjectIdentity(value, "intent_hash", hash, "intent"); }
export function readLifecycleCheckpoint(controlRootInput: string, transactionId: string, checkpointName: "C1" | "Ccommit"): LifecycleCheckpointV1 { assertHash(transactionId, "checkpoint transaction ID"); const root = assertLifecycleControlRoot(controlRootInput); const value = validateLifecycleCheckpoint(parseCanonical(readExactFile(path.join(root, "checkpoints", "v1", `${transactionId}.${checkpointName}.json`), "checkpoint CAS"), "checkpoint CAS")); if (value.transaction_id !== transactionId || value.checkpoint_name !== checkpointName) fail("CAS_IDENTITY_MISMATCH", "checkpoint identity differs from requested filename"); return value; }
export function readLifecycleProof(controlRootInput: string, hash: string): LifecycleProofV1 { assertHash(hash, "requested proof hash"); const value = validateLifecycleProof(readCasJson(assertLifecycleControlRoot(controlRootInput), `proofs/v1/${hash}.json`, "proof")); return assertCasObjectIdentity(value, "proof_hash", hash, "proof"); }
export function readLifecycleSelection(controlRootInput: string, hash: string): LifecycleSelectionV2 { assertHash(hash, "requested selection hash"); const value = validateLifecycleSelection(readCasJson(assertLifecycleControlRoot(controlRootInput), `selections/v2/${hash}.json`, "selection")); return assertCasObjectIdentity(value, "selection_hash", hash, "selection"); }
export function readLifecycleStageByTransaction(controlRootInput: string, transactionId: string): LifecycleStageV1 | null { assertHash(transactionId, "stage transaction filename"); const root = assertLifecycleControlRoot(controlRootInput); const file = path.join(root, "stages", "v1", `${transactionId}.json`); if (!lstatMaybe(file)) return null; const stage = validateLifecycleStage(parseCanonical(readExactFile(file, "stage CAS"), "stage CAS")); if (stage.transaction_id !== transactionId) fail("CAS_IDENTITY_MISMATCH", "stage transaction identity differs from filename"); return stage; }

export function validateCommittedHeadProofClosure(controlRootInput: string, headInput: LifecycleHeadV2): { proof: LifecycleProofV1; intent: LifecycleIntentV2; intentHead: LifecycleHeadV2 } | null {
  const root = assertLifecycleControlRoot(controlRootInput); const head = validateLifecycleHead(headInput);
  if (head.transaction === null) return null;
  if (head.state !== "committed") fail("HEAD_NONCOMMITTED", "proof closure requires a committed head");
  const transaction = asRecord(head.transaction, "committed head transaction");
  const proof = readLifecycleProof(root, String(transaction.proof_hash));
  if (proof.proof_hash !== transaction.proof_hash || proof.intent_hash !== transaction.intent_hash || proof.intent_head_hash !== transaction.intent_head_hash) fail("PROOF_HEAD_MISMATCH", "proof identity differs from committed head");
  const intent = readLifecycleIntent(root, String(transaction.intent_hash));
  const intentHead = readLifecycleHead(root, String(transaction.intent_head_hash));
  if (intentHead.state !== "intent" || intentHead.generation !== head.generation || intentHead.predecessor_head_hash !== head.predecessor_head_hash) fail("PROOF_INTENT_HEAD_MISMATCH", "proof intent head differs from committed head transition");
  validateIntentHeadClosure(root, intentHead, intent, String(transaction.predecessor_selection_hash));
  const intentTx = asRecord(intent.transaction, "intent transaction"); const predecessor = asRecord(intent.unique_predecessor, "intent predecessor"); const proofPred = asRecord(proof.predecessors, "proof predecessors"); const proofStage = asRecord(proof.stage, "proof stage");
  const stage = readLifecycleStageByTransaction(root, String(transaction.transaction_id));
  if (!stage) fail("PROOF_STAGE_MISSING", "proof stage CAS is missing");
  if (intentTx.transaction_id !== transaction.transaction_id || proofPred.head_hash !== head.predecessor_head_hash || proofPred.selection_hash !== transaction.predecessor_selection_hash || predecessor.head_hash !== proofPred.head_hash || predecessor.selection_hash !== proofPred.selection_hash || proofStage.stage_hash !== transaction.stage_hash || proofStage.event_id !== transaction.event_id || proofStage.canonical_event_bytes_sha256 !== transaction.event_raw_sha256 || stage.stage_hash !== proofStage.stage_hash || stage.event_id !== proofStage.event_id || stage.canonical_event_bytes_sha256 !== proofStage.canonical_event_bytes_sha256) fail("PROOF_BINDING_MISMATCH", "proof/intent/head/stage transaction closure differs");
  const finalAppend = validateFinalAppend(proof.final_append, "proof final append closure");
  if (finalAppend.relative_path !== eventRelativePath(stage.event_id) || finalAppend.bytes !== stage.canonical_event_utf8_bytes || finalAppend.raw_sha256 !== stage.canonical_event_bytes_sha256) fail("PROOF_APPEND_STAGE_MISMATCH", "proof final append differs from canonical stage bytes/path");
  const proofCheckpoints = asRecord(proof.checkpoints, "proof checkpoints");
  const C1 = readLifecycleCheckpoint(root, String(transaction.transaction_id), "C1");
  const Ccommit = readLifecycleCheckpoint(root, String(transaction.transaction_id), "Ccommit");
  const intentCheckpoints = asRecord(intent.checkpoints, "intent checkpoints");
  if (canonicalizeJcs(C1.observation) !== canonicalizeJcs(proofCheckpoints.C1) || canonicalizeJcs(Ccommit.observation) !== canonicalizeJcs(proofCheckpoints.Ccommit) || canonicalizeJcs(intentCheckpoints.C0) !== canonicalizeJcs(proofCheckpoints.C0)) fail("PROOF_CHECKPOINT_CAS_MISMATCH", "proof checkpoints differ from immutable C0/C1/Ccommit records");
  const references = validateArtifactBinding(head.artifacts, "committed head artifacts"); const proofArtifacts = validateArtifactBinding(proof.artifacts, "proof artifacts");
  const referenceContent = { ...references, proof_hash: null };
  if (proofArtifacts.proof_hash !== null || canonicalizeJcs(referenceContent) !== canonicalizeJcs(proofArtifacts)) fail("PROOF_ARTIFACT_MISMATCH", "proof content artifacts differ from committed head");
  const prediction = validateLifecyclePrediction(intent.prediction);
  if (canonicalizeJcs(prediction.post_corpus) !== canonicalizeJcs(head.source) || canonicalizeJcs(predictionArtifactBinding(prediction)) !== canonicalizeJcs(referenceContent)) fail("PROOF_PREDICTION_MISMATCH", "intent prediction differs from committed source/artifacts");
  const source = validateLifecycleSourceSnapshot(head.source as LifecycleSourceSnapshot);
  const sourceRow = source.rows.find((row) => row.event_id === stage.event_id);
  const post = asRecord(proof.post_scan, "proof post-scan closure"); const appendRow = validateAppendRow(post.append_row, "proof post append-row closure"); const Cpost = asRecord(proofCheckpoints.Cpost, "proof Cpost closure");
  if (!sourceRow || canonicalizeJcs(sourceRow) !== canonicalizeJcs(appendRow) || source.input_event_count !== post.input_event_count || source.input_event_ids_hash !== post.input_event_ids_hash || source.rows_hash !== post.rows_hash || source.snapshot_hash !== post.first_snapshot_hash || source.snapshot_hash !== post.second_snapshot_hash) fail("PROOF_POST_SOURCE_MISMATCH", "proof post scan/append row differs from committed source snapshot");
  if (Cpost.transaction_id !== transaction.transaction_id || Cpost.first_snapshot_hash !== source.snapshot_hash || Cpost.second_snapshot_hash !== source.snapshot_hash || Cpost.artifacts_hash !== jcsSha256Hex(proofArtifacts) || Cpost.prediction_hash !== prediction.prediction_hash || canonicalizeJcs(Cpost.final_append) !== canonicalizeJcs(finalAppend)) fail("PROOF_CPOST_CLOSURE_MISMATCH", "proof Cpost differs from transaction/source/artifact/prediction closure");
  return { proof, intent, intentHead };
}

export function validateGenesisHeadArtifactClosure(controlRootInput: string, headInput: LifecycleHeadV2): { p2a: PropositionLifecycleP2aV3Bundle; stable: PropositionLifecycleStableV3Bundle } {
  const root = assertLifecycleControlRoot(controlRootInput); const head = validateLifecycleHead(headInput);
  if (head.state !== "committed" || head.generation !== 0 || head.predecessor_head_hash !== null || head.transaction !== null) fail("HEAD_BOOTSTRAP_INVALID", "genesis artifact closure requires exact committed generation zero");
  const references = validateArtifactBinding(head.artifacts, "genesis head artifacts");
  if (references.proof_hash !== null) fail("HEAD_BOOTSTRAP_INVALID", "genesis head cannot bind proof");
  const p2a = readP2aBundle(root, String(references.p2a_bundle_hash)); const stable = readStableBundle(root, String(references.stable_bundle_hash), p2a);
  const compileProfile = asRecord(stable.manifest.compile_profile, "genesis stable compile profile");
  if (stable.manifest.manifest_hash !== references.stable_manifest_hash || sha256Hex(stable.artifacts["view.md"]) !== references.rendered_view_sha256 || compileProfile.raw_sha256 !== references.profile_raw_sha256) fail("HEAD_BOOTSTRAP_ARTIFACT_MISMATCH", "genesis artifacts differ from committed head");
  const sourceBinding = lifecycleSourceSnapshotBinding(head.source as LifecycleSourceSnapshot);
  if (canonicalizeJcs(p2a.manifest.source_snapshot) !== canonicalizeJcs(sourceBinding) || canonicalizeJcs(stable.manifest.source_snapshot) !== canonicalizeJcs(sourceBinding)) fail("HEAD_BOOTSTRAP_SOURCE_MISMATCH", "genesis artifact source snapshot differs from head");
  return { p2a, stable };
}

function validateIntentHeadClosure(root: string, head: LifecycleHeadV2, intentInput?: LifecycleIntentV2, expectedSelectionHash?: string): LifecycleIntentV2 {
  if (head.state !== "intent" || head.transaction === null) fail("INTENT_HEAD_INVALID", "intent closure requires an intent head");
  const transaction = asRecord(head.transaction, "intent head transaction");
  const intent = intentInput ?? readLifecycleIntent(root, String(transaction.intent_hash));
  const intentTx = asRecord(intent.transaction, "intent transaction"); const staged = asRecord(intent.staged_event, "intent staged event"); const predecessor = asRecord(intent.unique_predecessor, "intent predecessor"); const fence = asRecord(intent.fencing, "intent fence");
  const stage = readLifecycleStageByTransaction(root, String(transaction.transaction_id));
  if (!stage) fail("INTENT_STAGE_MISSING", "intent stage CAS is missing");
  if (intent.intent_hash !== transaction.intent_hash || intentTx.transaction_id !== transaction.transaction_id || staged.stage_hash !== transaction.stage_hash || staged.event_id !== transaction.event_id || staged.canonical_event_bytes_sha256 !== transaction.event_raw_sha256 || stage.stage_hash !== transaction.stage_hash || predecessor.head_hash !== head.predecessor_head_hash || predecessor.selection_hash !== transaction.predecessor_selection_hash || (expectedSelectionHash !== undefined && predecessor.selection_hash !== expectedSelectionHash) || fence.fence_epoch !== head.generation) fail("INTENT_HEAD_BINDING_MISMATCH", "intent head/intent/stage/predecessor/fence closure differs");
  const prediction = validateLifecyclePrediction(intent.prediction);
  if (canonicalizeJcs(prediction.post_corpus) !== canonicalizeJcs(head.source) || canonicalizeJcs(predictionArtifactBinding(prediction)) !== canonicalizeJcs(head.artifacts)) fail("INTENT_HEAD_PREDICTION_MISMATCH", "intent head differs from self-hashed prediction");
  return intent;
}

function predictionArtifactBinding(prediction: LifecyclePredictionV1): Record<string, unknown> {
  const p2a = asRecord(prediction.p2a_v3, "prediction p2a"); const stable = asRecord(prediction.stable_v3, "prediction stable"); const manifests = asRecord(prediction.manifests, "prediction manifests"); const render = asRecord(prediction.render, "prediction render"); const profile = asRecord(prediction.profile, "prediction profile");
  return { p2a_bundle_hash: p2a.bundle_hash, stable_bundle_hash: stable.bundle_hash, stable_manifest_hash: manifests.stable_manifest_hash, rendered_view_sha256: render.raw_sha256, profile_raw_sha256: profile.raw_sha256, proof_hash: null };
}

export function readPropositionLifecycleFreshnessV2(options: { controlRoot: string; afterFirstPointerReads?: () => void }): LifecycleFreshnessReadResult {
  let root: string | undefined; let firstHead: LifecycleVerifiedPointer | null = null; let firstSelection: LifecycleVerifiedPointer | null = null; let result: LifecycleFreshnessReadResult;
  try {
    root = assertLifecycleControlRoot(options.controlRoot);
    firstHead = readPointer(root, "head"); if (!firstHead) return { ok: false, reason: "head_pointer_missing" };
    firstSelection = readPointer(root, "selection"); if (!firstSelection) return { ok: false, reason: "selection_pointer_missing", head_hash: firstHead.hash };
    options.afterFirstPointerReads?.();
    const currentHead = readLifecycleHead(root, firstHead.hash);
    const selection = readLifecycleSelection(root, firstSelection.hash);
    const selectedHead = readLifecycleHead(root, String(selection.committed_head_hash));
    validateHeadAndSelectionChains(root, selectedHead, selection);
    let status: "active" | "fallback"; let reason: "selected_consistent" | "intent_head_old_selection" | "committed_head_old_selection";
    let selectedProof: LifecycleProofV1 | null = null;
    if (currentHead.head_hash === selectedHead.head_hash) {
      if (currentHead.state !== "committed" || currentHead.generation !== selection.generation) fail("HEAD_SELECTION_MISMATCH", "active selection does not bind current committed head");
      selectedProof = validateCommittedHeadProofClosure(root, currentHead)?.proof ?? null;
      status = "active"; reason = "selected_consistent";
    } else {
      if (currentHead.predecessor_head_hash !== selectedHead.head_hash || Number(currentHead.generation) !== Number(selectedHead.generation) + 1) fail("SELECTION_AHEAD_OR_FORK", "selection is ahead of current head or current head is not its unique successor");
      const transaction = asRecord(currentHead.transaction, "fallback current transaction");
      if (transaction.predecessor_selection_hash !== selection.selection_hash) fail("SELECTION_AHEAD_OR_FORK", "current head does not bind the selected predecessor");
      if (currentHead.state === "intent") { validateIntentHeadClosure(root, currentHead, undefined, String(selection.selection_hash)); status = "fallback"; reason = "intent_head_old_selection"; }
      else if (currentHead.state === "committed") { validateCommittedHeadProofClosure(root, currentHead); status = "fallback"; reason = "committed_head_old_selection"; }
      else fail("HEAD_ABORTED", "aborted head has no authorized fallback");
      selectedProof = validateCommittedHeadProofClosure(root, selectedHead)?.proof ?? null;
    }
    const references = validateArtifactBinding(selection.references, "selection references");
    const p2a = readP2aBundle(root, String(references.p2a_bundle_hash));
    const stable = readStableBundle(root, String(references.stable_bundle_hash), p2a);
    const compileProfile = asRecord(stable.manifest.compile_profile, "selected stable compile profile");
    if (selectedProof) assertProofArtifactRawRowsMatch(selectedProof, p2a, stable);
    if (stable.manifest.manifest_hash !== references.stable_manifest_hash || sha256Hex(stable.artifacts["view.md"]) !== references.rendered_view_sha256 || compileProfile.raw_sha256 !== references.profile_raw_sha256) fail("SELECTION_ARTIFACT_MISMATCH", "selected v3 artifacts differ from selection");
    const view = asRecord(JSON.parse(stable.artifacts["view.json"]), "selected view");
    const p2aManifest = p2a.source_bundle_v2.manifest;
    result = {
      ok: true, status, reason,
      head_hash: String(currentHead.head_hash), selected_head_hash: String(selectedHead.head_hash), selection_hash: String(selection.selection_hash),
      generation: Number(selectedHead.generation), selection_seq: Number(selection.seq), proof_hash: selection.proof_hash as string | null,
      p2a_bundle_hash: p2a.bundle_hash, stable_bundle_hash: stable.bundle_hash, stable_manifest_hash: String(stable.manifest.manifest_hash),
      view_md: stable.artifacts["view.md"], item_count: asArray(view.items, "selected view.items").length,
      source_counts: {
        input_events: p2aManifest.source.input_event_ids.length,
        evidence_events: p2aManifest.source.proposition_evidence_count,
        lifecycle_events: p2aManifest.source.proposition_lifecycle_count,
        candidates: p2aManifest.result.entry_count,
        exclusions: p2aManifest.result.exclusion_count,
        diagnostics: p2aManifest.result.diagnostic_count,
      },
    };
  } catch (error) {
    const normalized = normalize(error); result = { ok: false, reason: normalized.code, error: normalized.message, ...(firstHead ? { head_hash: firstHead.hash } : {}), ...(firstSelection ? { selection_hash: firstSelection.hash } : {}) };
  }
  try {
    if (!root || !firstHead || !firstSelection) return result;
    const secondHead = readPointer(root, "head"); const secondSelection = readPointer(root, "selection");
    if (!secondHead || secondHead.raw !== firstHead.raw || secondHead.identity_hash !== firstHead.identity_hash) return { ok: false, reason: "head_pointer_changed", head_hash: firstHead.hash, selection_hash: firstSelection.hash };
    if (!secondSelection || secondSelection.raw !== firstSelection.raw || secondSelection.identity_hash !== firstSelection.identity_hash) return { ok: false, reason: "selection_pointer_changed", head_hash: firstHead.hash, selection_hash: firstSelection.hash };
  } catch (error) { const normalized = normalize(error); return { ok: false, reason: "pointer_second_read_failed", error: normalized.message, ...(firstHead ? { head_hash: firstHead.hash } : {}), ...(firstSelection ? { selection_hash: firstSelection.hash } : {}) }; }
  return result;
}

function validateHeadAndSelectionChains(root: string, selectedHead: LifecycleHeadV2, selection: LifecycleSelectionV2): void {
  if (selection.committed_head_hash !== selectedHead.head_hash || selection.generation !== selectedHead.generation || selectedHead.state !== "committed") fail("HEAD_SELECTION_MISMATCH", "selection does not bind committed head");
  let head = selectedHead; let headDepth = Number(head.generation);
  while (head.predecessor_head_hash !== null) { const prior = readLifecycleHead(root, String(head.predecessor_head_hash)); if (prior.state !== "committed" || prior.generation !== Number(head.generation) - 1) fail("HEAD_CHAIN_INVALID", "head predecessor is not the unique prior committed generation"); head = prior; headDepth -= 1; if (headDepth < 0) fail("HEAD_CHAIN_INVALID", "head chain underflow"); }
  if (head.generation !== 0 || headDepth !== 0) fail("HEAD_CHAIN_INVALID", "head chain does not terminate at generation zero");
  let selected = selection; let seq = Number(selected.seq);
  while (selected.predecessor_selection_hash !== null) { const prior = readLifecycleSelection(root, String(selected.predecessor_selection_hash)); if (prior.seq !== Number(selected.seq) - 1 || Number(prior.generation) > Number(selected.generation)) fail("SELECTION_CHAIN_INVALID", "selection predecessor is not exact"); selected = prior; seq -= 1; if (seq < 0) fail("SELECTION_CHAIN_INVALID", "selection chain underflow"); }
  if (selected.seq !== 0 || selected.generation !== 0 || seq !== 0) fail("SELECTION_CHAIN_INVALID", "selection chain does not terminate at genesis");
}

function readP2aBundle(root: string, hash: string): PropositionLifecycleP2aV3Bundle {
  assertHash(hash, "P2a v3 reference"); const artifacts: Record<string, string> = {};
  const directory = path.join(root, "p2a", "v3", "bundles", hash); assertBundleDirectoryExact(directory, PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES);
  for (const name of PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES) artifacts[name] = readExactFile(path.join(directory, name), `P2a v3 ${name}`);
  const bundle = reconstructPropositionLifecycleP2aV3Bundle(artifacts as never); if (bundle.bundle_hash !== hash) fail("P2A_V3_DIRECTORY_MISMATCH", "P2a v3 directory identity differs"); return bundle;
}
function readStableBundle(root: string, hash: string, p2a: PropositionLifecycleP2aV3Bundle): PropositionLifecycleStableV3Bundle {
  assertHash(hash, "stable v3 reference"); const artifacts: Record<string, string> = {};
  const directory = path.join(root, "stable", "v3", "bundles", hash); assertBundleDirectoryExact(directory, PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES);
  for (const name of PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES) artifacts[name] = readExactFile(path.join(directory, name), `stable v3 ${name}`);
  const bundle = reconstructPropositionLifecycleStableV3Bundle(artifacts as never, p2a); if (bundle.bundle_hash !== hash) fail("STABLE_V3_DIRECTORY_MISMATCH", "stable v3 directory identity differs"); return bundle;
}

function validateProofArtifactRawRows(value: unknown): Record<string, unknown> {
  const witness = asRecord(value, "proof artifact raw rows");
  exactKeys(witness, ["p2a", "stable", "profile", "rows_hash"], "proof artifact raw rows");
  const validateRows = (rowsValue: unknown, names: readonly string[], label: string) => {
    const rows = asArray(rowsValue, label).map((rowValue, index) => {
      const row = asRecord(rowValue, `${label}[${index}]`); exactKeys(row, ["name", "bytes", "raw_sha256"], `${label}[${index}]`);
      if (row.name !== names[index] || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0) fail("PROOF_ARTIFACT_ROWS_INVALID", `${label} names/bytes differ`, { index });
      assertHash(row.raw_sha256, `${label}[${index}] raw hash`); return row;
    });
    if (rows.length !== names.length) fail("PROOF_ARTIFACT_ROWS_INVALID", `${label} cardinality differs`);
    return rows;
  };
  const p2a = validateRows(witness.p2a, PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES, "proof P2a rows");
  const stable = validateRows(witness.stable, PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES, "proof stable rows");
  const profile = asRecord(witness.profile, "proof profile row"); exactKeys(profile, ["name", "bytes", "raw_sha256"], "proof profile row");
  if (profile.name !== "compile-profile.json" || canonicalizeJcs(profile) !== canonicalizeJcs(stable[0])) fail("PROOF_ARTIFACT_ROWS_INVALID", "proof profile row differs from stable compile-profile artifact");
  assertHash(witness.rows_hash, "proof artifact rows hash");
  if (witness.rows_hash !== jcsSha256Hex({ p2a, stable, profile })) fail("PROOF_ARTIFACT_ROWS_INVALID", "proof artifact row-set hash differs");
  return witness;
}

function rawArtifactRows(artifacts: Readonly<Record<string, string>>, names: readonly string[]): readonly Readonly<Record<string, unknown>>[] {
  return names.map((name) => ({ name, bytes: Buffer.byteLength(artifacts[name]!), raw_sha256: sha256Hex(artifacts[name]!) }));
}

function assertProofArtifactRawRowsMatch(proof: LifecycleProofV1, p2a: PropositionLifecycleP2aV3Bundle, stable: PropositionLifecycleStableV3Bundle): void {
  const p2aRows = rawArtifactRows(p2a.artifacts, PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES);
  const stableRows = rawArtifactRows(stable.artifacts, PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES);
  const expected = { p2a: p2aRows, stable: stableRows, profile: stableRows[0], rows_hash: jcsSha256Hex({ p2a: p2aRows, stable: stableRows, profile: stableRows[0] }) };
  if (canonicalizeJcs(proof.artifact_raw_rows) !== canonicalizeJcs(expected)) fail("PROOF_ARTIFACT_ROWS_MISMATCH", "proof raw artifact witness differs from selected CAS bytes");
}

function durableCasCreate(root: string, relative: string, raw: string, testHooks?: LifecycleCasTestHooks): boolean {
  const target = confined(root, relative); const directory = path.dirname(target); ensureDirectory(directory);
  const temporary = `${target}.cas-${sha256Hex(raw).slice(0, 24)}.tmp`;
  assertNoForeignDeterministicTemps(directory, `${path.basename(target)}.cas-`, ".tmp", temporary, "CAS");
  const existing = lstatMaybe(target); const temp = lstatMaybe(temporary);
  if (existing) {
    if (temp) {
      assertExactLinkedPair(temporary, target, raw, "recoverable CAS");
      fs.unlinkSync(temporary); fsyncDirectory(directory); assertExactCasFile(target, raw, "recovered CAS target");
    } else assertExactCasFile(target, raw, "existing CAS");
    return false;
  }
  if (temp) assertExactCasFile(temporary, raw, "recoverable CAS temp");
  else writeExclusiveDurable(temporary, raw);
  try { fs.linkSync(temporary, target); }
  catch (error) {
    if (isCode(error, "EXDEV")) fail("CAS_EXDEV", "CAS temp and target are on different filesystems", { target, temporary });
    if (!isCode(error, "EEXIST")) throw error;
  }
  fsyncDirectory(directory);
  assertExactLinkedPair(temporary, target, raw, "published CAS");
  testHooks?.afterLinkBeforeUnlink?.();
  fs.unlinkSync(temporary); fsyncDirectory(directory); assertExactCasFile(target, raw, "CAS readback"); return true;
}
function prepareExactPointerTemp(file: string, raw: string): void { const existing = lstatMaybe(file); if (existing) { assertExactCasFile(file, raw, "pointer temp"); return; } writeExclusiveDurable(file, raw); fsyncDirectory(path.dirname(file)); }
function cleanupExactPointerTemp(file: string, raw: string): void { if (!lstatMaybe(file)) return; assertExactCasFile(file, raw, "recoverable pointer temp"); fs.unlinkSync(file); fsyncDirectory(path.dirname(file)); }
function assertNoForeignDeterministicTemps(directory: string, prefix: string, suffix: string, allowed: string, label: string): void { for (const name of fs.readdirSync(directory)) { if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue; const candidate = path.join(directory, name); if (candidate !== allowed) fail("FOREIGN_TEMP_BLOCKED", `${label} directory contains a foreign deterministic temp`, { candidate, allowed }); } }
function assertExactLinkedPair(temporary: string, target: string, raw: string, label: string): void { assertExactCasFile(temporary, raw, `${label} temp`, 2); assertExactCasFile(target, raw, `${label} target`, 2); const temp = fs.lstatSync(temporary); const final = fs.lstatSync(target); if (temp.dev !== final.dev || temp.ino !== final.ino) fail("CAS_LINK_INVALID", `${label} temp/target are not the exact same inode`, { temporary, target }); }
function writeExclusiveDurable(file: string, raw: string): void { const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); try { fs.fchmodSync(fd, 0o600); writeAll(fd, Buffer.from(raw)); fs.fsyncSync(fd); const stat = fs.fstatSync(fd); if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size !== Buffer.byteLength(raw)) fail("CAS_CREATE_INVALID", "new CAS file identity differs"); } finally { fs.closeSync(fd); } assertExactCasFile(file, raw, "new CAS temp"); }
function assertExactCasFile(file: string, expected: string, label: string, expectedNlink = 1): void { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== expectedNlink) fail("CAS_COLLISION", `${label} is not exact regular mode-0600 expected-nlink`, { file, expectedNlink, actualNlink: stat.nlink }); const raw = readExactFileWithNlink(file, label, expectedNlink); if (raw !== expected) fail("CAS_COLLISION", `${label} bytes differ`, { file, expected: sha256Hex(expected), actual: sha256Hex(raw) }); }
function assertBundleDirectoryExact(directory: string, names: readonly string[]): void { const stat = fs.lstatSync(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("BUNDLE_DIRECTORY_INVALID", "bundle path is not an exact directory", { directory }); const actual = fs.readdirSync(directory).sort(compare); const expected = [...names].sort(compare); if (canonicalizeJcs(actual) !== canonicalizeJcs(expected)) fail("BUNDLE_FOREIGN_ENTRY", "bundle directory entries differ", { directory, actual, expected }); }
function readCasJson(root: string, relative: string, label: string): unknown { assertHash(path.basename(relative, ".json"), `${label} path identity`); return parseCanonical(readExactFile(confined(root, relative), `${label} CAS`), `${label} CAS`); }
function readPointer(root: string, kind: "head" | "selection"): LifecycleVerifiedPointer | null {
  const file = path.join(root, kind === "head" ? "heads" : "selections", "current.json");
  const before = lstatMaybe(file); if (!before) return null;
  const raw = readExactFile(file, `${kind} pointer`);
  const after = fs.lstatSync(file);
  const identity = (stat: fs.Stats) => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs });
  if (canonicalizeJcs(identity(before)) !== canonicalizeJcs(identity(after))) fail("POINTER_READ_RACE", `${kind} pointer identity changed while read`);
  const value = parseCanonical(raw, `${kind} pointer`);
  const schema = kind === "head" ? PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA : PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA;
  const field = kind === "head" ? "head_hash" : "selection_hash";
  exactKeys(value, ["schema_version", field], `${kind} pointer`);
  if (value.schema_version !== schema) fail("POINTER_SCHEMA_INVALID", `${kind} pointer is not v2`);
  assertHash(value[field], `${kind} pointer hash`);
  return { hash: String(value[field]), raw, identity_hash: jcsSha256Hex(identity(after)) };
}
function readExactFile(file: string, label: string): string { return readExactFileWithNlink(file, label, 1); }
function readExactFileWithNlink(file: string, label: string, expectedNlink: number): string { const named = fs.lstatSync(file); if (named.isSymbolicLink() || !named.isFile() || (named.mode & 0o7777) !== 0o600 || named.nlink !== expectedNlink) fail("CONTROL_FILE_UNSAFE", `${label} must be no-symlink regular mode-0600 expected-nlink`, { file, expectedNlink, actualNlink: named.nlink }); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size || opened.nlink !== expectedNlink) fail("CONTROL_FILE_RACE", `${label} changed while opened`); const raw = fs.readFileSync(fd, "utf8"); const after = fs.fstatSync(fd); if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== expectedNlink) fail("CONTROL_FILE_RACE", `${label} changed while read`); return raw; } finally { fs.closeSync(fd); } }
function parseCanonical(raw: string, label: string): Record<string, unknown> { let value: unknown; try { value = JSON.parse(raw); } catch (error) { fail("CONTROL_JSON_INVALID", `${label} is not JSON`, { error: message(error) }); } const record = asRecord(value, label); if (canonicalControlJson(record) !== raw) fail("CONTROL_JSON_NONCANONICAL", `${label} is not RFC8785-JCS plus LF`); return record; }

function validateArtifactBinding(value: unknown, label: string): Record<string, unknown> { const refs = asRecord(value, label); exactKeys(refs, ["p2a_bundle_hash", "stable_bundle_hash", "stable_manifest_hash", "rendered_view_sha256", "profile_raw_sha256", "proof_hash"], label); for (const key of ["p2a_bundle_hash", "stable_bundle_hash", "stable_manifest_hash", "rendered_view_sha256", "profile_raw_sha256"]) assertHash(refs[key], `${label} ${key}`); if (refs.proof_hash !== null) assertHash(refs.proof_hash, `${label} proof`); return refs; }
function validateFinalAppend(value: unknown, label: string): { relative_path: string; state: "S4"; temp_absent: true; bytes: number; raw_sha256: string; mode: number; nlink: number } { const row = asRecord(value, label); exactKeys(row, ["relative_path", "state", "temp_absent", "bytes", "raw_sha256", "mode", "nlink"], label); if (typeof row.relative_path !== "string" || row.state !== "S4" || row.temp_absent !== true || row.mode !== 0o600 || row.nlink !== 1 || !Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0) fail("PROOF_APPEND_INVALID", `${label} is not an exact measured S4 append`); assertHash(row.raw_sha256, `${label} raw hash`); return row as unknown as { relative_path: string; state: "S4"; temp_absent: true; bytes: number; raw_sha256: string; mode: number; nlink: number }; }
function validateAppendRow(value: unknown, label: string): { event_id: string; relative_path: string; bytes: number; raw_sha256: string } { const row = asRecord(value, label); exactKeys(row, ["event_id", "relative_path", "bytes", "raw_sha256"], label); assertHash(row.event_id, `${label} event ID`); assertHash(row.raw_sha256, `${label} raw hash`); if (typeof row.relative_path !== "string" || row.relative_path !== eventRelativePath(String(row.event_id)) || !Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0) fail("PROOF_POST_APPEND_MISMATCH", `${label} path/bytes differ`); return row as unknown as { event_id: string; relative_path: string; bytes: number; raw_sha256: string }; }
function eventRelativePath(eventId: string): string { assertHash(eventId, "event path ID"); return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`; }
function assertCasObjectIdentity<T extends Readonly<Record<string, unknown>>>(value: T, field: string, requestedHash: string, label: string): T { assertHash(requestedHash, `${label} requested hash`); if (value[field] !== requestedHash) fail("CAS_IDENTITY_MISMATCH", `${label} identity field differs from requested hash/filename`, { requestedHash, embeddedHash: value[field] }); return value; }
function validatePredecessor(value: unknown, label: string): { head_hash: string; selection_hash: string; generation: number; selection_seq: number } { const predecessor = asRecord(value, label); exactKeys(predecessor, ["head_hash", "selection_hash", "generation", "selection_seq"], label); assertHash(predecessor.head_hash, `${label} head`); assertHash(predecessor.selection_hash, `${label} selection`); assertNonnegative(predecessor.generation, `${label} generation`); assertNonnegative(predecessor.selection_seq, `${label} seq`); return predecessor as unknown as { head_hash: string; selection_hash: string; generation: number; selection_seq: number }; }
function assertCommonIdentity(value: Record<string, unknown>, schema: string, scopeField: string, scope: string, label: string): void { if (value.schema_version !== schema || value.canonicalization !== "RFC8785-JCS" || value.hash_algorithm !== "sha256" || value[scopeField] !== scope) fail("CONTROL_IDENTITY_INVALID", `${label} identity differs`); }
function validateAuthority(value: unknown): void { if (canonicalizeJcs(value) !== canonicalizeJcs(PROPOSITION_LIFECYCLE_FRESHNESS_SANDBOX_WRITER_AUTHORITY)) fail("WRITER_AUTHORITY_INVALID", "sandbox writer authority binding differs"); }
function validateAudit(value: unknown): void { if (canonicalizeJcs(value) !== canonicalizeJcs(AUDIT)) fail("AUDIT_INVALID", "audit contract differs"); }
function validateHashWithOmissions(value: Record<string, unknown>, hashField: string, omissions: readonly string[], scope: string, label: string): void { assertHash(value[hashField], `${label} identity hash`); const base = clone(value); delete base[hashField]; for (const field of omissions) delete base[field]; if (jcsSha256Hex(base) !== value[hashField]) fail("CONTROL_HASH_INVALID", `${label} self hash differs`, { scope }); }
function withIdentity(base: Record<string, unknown>, field: string, omissions: readonly string[]): Readonly<Record<string, unknown>> { const preimage = clone(base); for (const omission of omissions) delete preimage[omission]; return deepFreeze({ ...base, [field]: jcsSha256Hex(preimage) }); }
function assertOnlyJson(value: unknown, label: string): void { try { canonicalizeJcs(value); } catch (error) { fail("CONTROL_SHAPE_INVALID", `${label} is not canonical JSON data`, { error: message(error) }); } }
function assertControlRootEntries(root: string): void { const actual = fs.readdirSync(root).sort(compare); const expected = [...ROOT_ENTRIES].sort(compare); if (canonicalizeJcs(actual) !== canonicalizeJcs(expected)) fail("CONTROL_FOREIGN_ENTRY", "control root entries differ", { actual, expected }); for (const name of expected) { const stat = fs.lstatSync(path.join(root, name)); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("CONTROL_FOREIGN_ENTRY", "control family root is not an exact directory", { name }); } }
function ensureDirectory(directory: string): void { const existing = lstatMaybe(directory); if (existing) { if (existing.isSymbolicLink() || !existing.isDirectory()) fail("CONTROL_DIRECTORY_UNSAFE", "directory path is unsafe", { directory }); return; } ensureDirectory(path.dirname(directory)); try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (!isCode(error, "EEXIST")) throw error; } const stat = fs.lstatSync(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("CONTROL_DIRECTORY_UNSAFE", "created directory path is unsafe", { directory }); fsyncDirectory(path.dirname(directory)); }
function fsyncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); }
function confined(root: string, relative: string): string { if (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) fail("CONTROL_PATH_ESCAPE", "relative control path escapes"); const target = path.resolve(root, ...relative.split("/")); if (!inside(root, target)) fail("CONTROL_PATH_ESCAPE", "control target escapes root"); return target; }
function assertExistingAncestorsNoSymlink(target: string): void { const parsed = path.parse(target); let current = parsed.root; for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = lstatMaybe(current); if (!stat) break; if (stat.isSymbolicLink()) fail("SANDBOX_ANCESTOR_SYMLINK", "sandbox ancestor is a symlink", { current }); if (current !== target && !stat.isDirectory()) fail("SANDBOX_ANCESTOR_UNSAFE", "sandbox ancestor is not a directory", { current }); } }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(compare); const wanted = [...expected].sort(compare); if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("CONTROL_SHAPE_INVALID", `${label} keys differ`, { actual, expected: wanted }); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("CONTROL_SHAPE_INVALID", `${label} must be an object`); return value as Record<string, unknown>; }
function asArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) fail("CONTROL_SHAPE_INVALID", `${label} must be an array`); return value; }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("CONTROL_HASH_INVALID", `${label} must be SHA-256`); }
function assertNonnegative(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail("CONTROL_NUMBER_INVALID", `${label} must be a nonnegative safe integer`); }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; } }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code; }
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function normalize(error: unknown): { code: string; message: string } { if (error && typeof error === "object" && "code" in error) return { code: String((error as { code?: unknown }).code), message: message(error) }; return { code: "reader_failed", message: message(error) }; }
function fail(code: string, text: string, detail?: Record<string, unknown>): never { throw new PropositionLifecycleFreshnessControlV2Error(code, text, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

export const __TEST = Object.freeze({
  audit: AUDIT,
  identityHash(value: Record<string, unknown>, hashField: string, omitAudit = true): string { const copy = clone(value); delete copy[hashField]; if (omitAudit) delete copy.audit; return jcsSha256Hex(copy); },
  durableCasCreate,
  readExactFile,
  parseCanonical,
  readP2aBundle,
  readStableBundle,
  assertControlRootEntries,
});
