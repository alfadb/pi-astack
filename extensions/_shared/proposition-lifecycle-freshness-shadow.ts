import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { durableAtomicCreateFile, durableAtomicWriteFile } from "./durable-write";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  buildPropositionPolicyPushShadow,
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
  type PropositionPolicyPushManifest,
} from "./proposition-policy-push-shadow";
import {
  buildPropositionPolicyStableViewBundle,
  validatePropositionPolicyStableViewBundle,
  type PropositionPolicyStableViewBundle,
} from "./proposition-policy-stable-view-publisher";

export const PROPOSITION_LIFECYCLE_FRESHNESS_WRITER_INTENT_SCHEMA = "proposition-lifecycle-freshness-writer-intent/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_SCHEMA = "proposition-lifecycle-freshness-head/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_SCHEMA = "proposition-lifecycle-freshness-selection/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_SCHEMA = "proposition-lifecycle-freshness-head-pointer/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_SCHEMA = "proposition-lifecycle-freshness-selection-pointer/v1" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_LAYOUT = "proposition-lifecycle-freshness-shadow-cas/v2" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_P2A_MANIFEST_SCHEMA = "proposition-policy-push-shadow-manifest/v2" as const;
export const PROPOSITION_LIFECYCLE_FRESHNESS_STABLE_MANIFEST_SCHEMA = "proposition-policy-stable-view-publication-manifest/v2" as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HEAD_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this head object with head_hash and audit omitted" as const;
const INTENT_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this writer intent object with intent_hash and audit omitted" as const;
const SELECTION_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this selection object with selection_hash and audit omitted" as const;
const TRANSACTION_ID_RULE = "sha256 over RFC8785-JCS of staged_event, precondition, and expected_post_append" as const;
const P2A_ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const STABLE_ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"] as const);
const ROOT_ENTRIES = Object.freeze(["heads", "intents", "p2a", "selections", "stable"] as const);
const HEAD_POINTER_RELATIVE = "heads/current.json" as const;
const SELECTION_POINTER_RELATIVE = "selections/current.json" as const;
const MAX_CHAIN_LENGTH = 100_000;
const AUDIT_CONTRACT = deepFreeze({
  time_fields: "external_preview_audit_only" as const,
  excluded_from_identity: true as const,
  freshness_gate: "committed_head_and_selected_selection_dual_pointer_consistency_only" as const,
});
const SHADOW_AUTHORITY_CONFIG = deepFreeze({
  authority_epoch: "adr0040-d3-shadow-phase-one/v1" as const,
  authority_profile: "repo_sandbox_shadow_only/v1" as const,
  head_pointer: HEAD_POINTER_RELATIVE,
  selection_pointer: SELECTION_POINTER_RELATIVE,
  head_is_freshness_safety_gate: true as const,
  selection_is_only_artifact_activation: true as const,
  time_based_freshness: false as const,
});
export const PROPOSITION_LIFECYCLE_FRESHNESS_SHADOW_CONFIG_HASH = jcsSha256Hex(SHADOW_AUTHORITY_CONFIG);

const RECOVERY_CONTRACT = deepFreeze({
  exact_l1_exists: "commit" as const,
  l1_absent_and_exact_stage_exists: "append_then_commit" as const,
  conflict_or_missing: "blocked" as const,
  no_ttl_auto_abort: true as const,
  explicit_abort_requires_separate_authorization: true as const,
});

type P2aArtifactName = typeof P2A_ARTIFACT_NAMES[number];
type StableArtifactName = typeof STABLE_ARTIFACT_NAMES[number];
type HeadState = "intent" | "committed" | "aborted";

export interface PropositionLifecycleFreshnessWriterIntentV1 {
  schema_version: typeof PROPOSITION_LIFECYCLE_FRESHNESS_WRITER_INTENT_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  intent_hash_scope: typeof INTENT_HASH_SCOPE;
  authority: "future_production_writer_fencing_separate_gate";
  transaction_id_rule: typeof TRANSACTION_ID_RULE;
  transaction_id: string;
  staged_event: {
    event_id: string;
    canonical_event_bytes_sha256: string;
  };
  precondition: {
    expected_predecessor_head_hash: string;
    expected_predecessor_selection_hash: string;
    expected_generation: number;
    expected_selection_seq: number;
  };
  expected_post_append: {
    input_event_count: number;
    input_event_ids_hash: string;
    corpus_hash: string;
    coverage_hash: string;
    p2a_bundle_hash: string;
  };
  fencing: {
    writer_id_hash: string;
    fence_epoch: number;
    fence_token_hash: string;
    compare_and_swap_required: true;
    recheck_sequence: readonly ["C0", "C1", "Ccommit"];
  };
  recovery: typeof RECOVERY_CONTRACT;
  constraints: {
    immutable_l1_append_only: true;
    exact_staged_bytes_required: true;
    lazy_p2a_and_stable_cas: true;
    selection_only_artifact_activation: true;
    head_first_pointer_advance: true;
    no_time_freshness_gate: true;
  };
  audit: typeof AUDIT_CONTRACT;
  intent_hash: string;
}

export interface PropositionLifecycleFreshnessTransactionBindingV1 {
  transaction_id: string;
  staged_event_id: string;
  staged_canonical_event_bytes_sha256: string;
  expected_predecessor_selection_hash: string;
  expected_post_append_corpus_hash: string;
}

export interface PropositionLifecycleFreshnessHeadV1 {
  schema_version: typeof PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  head_hash_scope: typeof HEAD_HASH_SCOPE;
  authority: "repo_sandbox_shadow_only";
  generation: number;
  predecessor_head_hash: string | null;
  writer_protocol: {
    protocol: "staged_event_intent_then_fenced_commit/v1";
    mode: "shadow_genesis" | "shadow_advance" | "production";
    state: HeadState;
    intent_hash: string | null;
    fence_token_hash: string | null;
    commit_proof_hash: string | null;
    abort_authorization_hash: string | null;
    transaction: PropositionLifecycleFreshnessTransactionBindingV1 | null;
  };
  epoch: {
    epoch_id: string;
    genesis_event_id: string;
  };
  source: {
    scanner: "scanWholeL1Validated";
    resolver: "proposition-lifecycle-effective-state/v1";
    input_event_count: number;
    input_event_ids: readonly string[];
    input_event_ids_hash: string;
    proposition_event_count: number;
    proposition_genesis_count: number;
    proposition_evidence_count: number;
    proposition_lifecycle_count: number;
    proposition_selected_count: number;
    proposition_foldable_count: number;
    evidence_event_ids: readonly string[];
    evidence_event_ids_hash: string;
    lifecycle_event_ids: readonly string[];
    lifecycle_event_ids_hash: string;
    source_resolution_inventory_hash: string;
  };
  p2a: {
    manifest_schema_version: typeof PROPOSITION_LIFECYCLE_FRESHNESS_P2A_MANIFEST_SCHEMA;
    bundle_hash: string;
    result: {
      entry_count: number;
      exclusion_count: number;
      diagnostic_count: number;
    };
  };
  coverage_hash: string;
  audit: typeof AUDIT_CONTRACT;
  head_hash: string;
}

export interface PropositionLifecycleFreshnessSelectionV1 {
  schema_version: typeof PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  selection_hash_scope: typeof SELECTION_HASH_SCOPE;
  authority: "repo_sandbox_shadow_only";
  authority_binding: {
    authority_epoch: typeof SHADOW_AUTHORITY_CONFIG.authority_epoch;
    authority_profile: typeof SHADOW_AUTHORITY_CONFIG.authority_profile;
    config_trust_anchor_hash: string;
  };
  generation: number;
  seq: number;
  predecessor_selection_hash: string | null;
  decision: "selected" | "blocked";
  head_hash: string;
  head_generation: number;
  references: {
    p2a_bundle_hash: string | null;
    stable_bundle_hash: string | null;
    stable_manifest_hash: string | null;
    rendered_view_sha256: string | null;
  };
  block: {
    reason_code: string;
    detail_hash: string;
  } | null;
  activation: {
    only_artifact_activation_point: typeof SELECTION_POINTER_RELATIVE;
    freshness_safety_gate: typeof HEAD_POINTER_RELATIVE;
    p2a_latest_forbidden: true;
    stable_latest_forbidden: true;
    both_pointers_double_read_required: true;
  };
  audit: typeof AUDIT_CONTRACT;
  selection_hash: string;
}

export interface PropositionLifecycleFreshnessChainPredecessor {
  head: PropositionLifecycleFreshnessHeadV1;
  selection: PropositionLifecycleFreshnessSelectionV1;
}

export interface PropositionLifecycleFreshnessShadowBuild {
  head: PropositionLifecycleFreshnessHeadV1;
  selection: PropositionLifecycleFreshnessSelectionV1;
  p2a_bundle: PropositionPolicyPushBundle;
  stable_bundle: PropositionPolicyStableViewBundle | null;
  predecessor: PropositionLifecycleFreshnessChainPredecessor | null;
}

export interface PropositionLifecycleFreshnessMaterializationResult {
  status: "created" | "identical" | "advanced" | "recovered";
  output_root: string;
  head_hash: string;
  selection_hash: string;
  p2a_bundle_hash: string | null;
  stable_bundle_hash: string | null;
  head_pointer_path: string;
  selection_pointer_path: string;
}

export type PropositionLifecycleFreshnessReadResult =
  | {
    ok: true;
    reason: "selected_consistent";
    freshness_basis: "committed_head_and_selected_selection_dual_pointer_consistency_only";
    selectionHash: string;
    headHash: string;
    headGeneration: number;
    selectionSeq: number;
    p2aBundleHash: string;
    stableBundleHash: string;
    stableManifestHash: string;
    viewMd: string;
    viewBytes: number;
    itemCount: number;
    sourceCounts: {
      inputEvents: number;
      evidenceEvents: number;
      lifecycleEvents: number;
      candidates: number;
      exclusions: number;
      diagnostics: number;
    };
  }
  | {
    ok: false;
    reason: string;
    selectionHash?: string;
    headHash?: string;
    error?: string;
  };

export class PropositionLifecycleFreshnessShadowError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionLifecycleFreshnessShadowError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionLifecycleFreshnessShadow(options: {
  sourceAbrainHome: string;
  repoRoot: string;
  selection?: "selected" | "blocked";
  blockReasonCode?: string;
  blockDetail?: unknown;
  predecessor?: PropositionLifecycleFreshnessChainPredecessor;
}): Promise<PropositionLifecycleFreshnessShadowBuild> {
  const decision = options.selection ?? "selected";
  const sourceAbrainHome = exactDirectory(options.sourceAbrainHome, "source abrain home");
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  const predecessor = options.predecessor ? validateChainPredecessor(options.predecessor) : null;
  let p2aBundle: PropositionPolicyPushBundle;
  let stableBundle: PropositionPolicyStableViewBundle | null = null;
  if (decision === "selected") {
    stableBundle = await buildPropositionPolicyStableViewBundle({ sourceAbrainHome, repoRoot });
    validatePropositionPolicyStableViewBundle(stableBundle);
    p2aBundle = stableBundle.source_bundle;
  } else {
    p2aBundle = await buildPropositionPolicyPushShadow({ abrainHome: sourceAbrainHome, repoRoot });
    validatePropositionPolicyPushBundle(p2aBundle);
  }
  const head = buildCommittedShadowHead(p2aBundle.manifest, predecessor?.head ?? null);
  const selection = decision === "selected"
    ? buildSelectedRecord(head, stableBundle!, predecessor?.selection ?? null)
    : buildBlockedRecord(head, options.blockReasonCode ?? "shadow_preview_blocked", options.blockDetail ?? null, predecessor?.selection ?? null);
  const build = deepFreeze({ head, selection, p2a_bundle: p2aBundle, stable_bundle: stableBundle, predecessor });
  validatePropositionLifecycleFreshnessShadowBuild(build);
  return build;
}

export function validatePropositionLifecycleFreshnessWriterIntent(value: unknown): PropositionLifecycleFreshnessWriterIntentV1 {
  const intent = asRecord(value, "writer intent") as unknown as PropositionLifecycleFreshnessWriterIntentV1;
  exactKeys(intent as unknown as Record<string, unknown>, ["schema_version", "canonicalization", "hash_algorithm", "intent_hash_scope", "authority", "transaction_id_rule", "transaction_id", "staged_event", "precondition", "expected_post_append", "fencing", "recovery", "constraints", "audit", "intent_hash"], "writer intent");
  exactKeys(asRecord(intent.staged_event, "writer intent.staged_event"), ["event_id", "canonical_event_bytes_sha256"], "writer intent.staged_event");
  exactKeys(asRecord(intent.precondition, "writer intent.precondition"), ["expected_predecessor_head_hash", "expected_predecessor_selection_hash", "expected_generation", "expected_selection_seq"], "writer intent.precondition");
  exactKeys(asRecord(intent.expected_post_append, "writer intent.expected_post_append"), ["input_event_count", "input_event_ids_hash", "corpus_hash", "coverage_hash", "p2a_bundle_hash"], "writer intent.expected_post_append");
  exactKeys(asRecord(intent.fencing, "writer intent.fencing"), ["writer_id_hash", "fence_epoch", "fence_token_hash", "compare_and_swap_required", "recheck_sequence"], "writer intent.fencing");
  exactKeys(asRecord(intent.recovery, "writer intent.recovery"), ["exact_l1_exists", "l1_absent_and_exact_stage_exists", "conflict_or_missing", "no_ttl_auto_abort", "explicit_abort_requires_separate_authorization"], "writer intent.recovery");
  exactKeys(asRecord(intent.constraints, "writer intent.constraints"), ["immutable_l1_append_only", "exact_staged_bytes_required", "lazy_p2a_and_stable_cas", "selection_only_artifact_activation", "head_first_pointer_advance", "no_time_freshness_gate"], "writer intent.constraints");
  validateAudit(intent.audit, "writer intent.audit");
  if (intent.schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_WRITER_INTENT_SCHEMA
    || intent.canonicalization !== "RFC8785-JCS" || intent.hash_algorithm !== "sha256"
    || intent.intent_hash_scope !== INTENT_HASH_SCOPE || intent.authority !== "future_production_writer_fencing_separate_gate"
    || intent.transaction_id_rule !== TRANSACTION_ID_RULE) fail("intent_invalid", "writer intent identity differs");
  assertHash(intent.transaction_id, "writer intent transaction ID");
  assertHash(intent.staged_event.event_id, "writer intent staged event ID");
  assertHash(intent.staged_event.canonical_event_bytes_sha256, "writer intent staged bytes");
  assertHash(intent.precondition.expected_predecessor_head_hash, "writer intent predecessor head");
  assertHash(intent.precondition.expected_predecessor_selection_hash, "writer intent predecessor selection");
  assertPositiveInteger(intent.precondition.expected_generation, "writer intent generation");
  assertNonNegativeInteger(intent.precondition.expected_selection_seq, "writer intent selection seq");
  assertPositiveInteger(intent.expected_post_append.input_event_count, "writer intent post input count");
  for (const [key, hash] of Object.entries(intent.expected_post_append).filter(([key]) => key !== "input_event_count")) assertHash(hash, `writer intent expected post ${key}`);
  const expectedCorpusHash = corpusHash(intent.expected_post_append.input_event_count, intent.expected_post_append.input_event_ids_hash);
  if (intent.expected_post_append.corpus_hash !== expectedCorpusHash) fail("intent_invalid", "writer intent expected corpus hash differs");
  const expectedTransactionId = transactionId(intent.staged_event, intent.precondition, intent.expected_post_append);
  if (intent.transaction_id !== expectedTransactionId) fail("intent_invalid", "writer intent transaction ID differs");
  assertHash(intent.fencing.writer_id_hash, "writer intent writer ID");
  assertHash(intent.fencing.fence_token_hash, "writer intent fence token");
  assertNonNegativeInteger(intent.fencing.fence_epoch, "writer intent fence epoch");
  if (intent.fencing.compare_and_swap_required !== true
    || canonicalizeJcs(intent.fencing.recheck_sequence) !== canonicalizeJcs(["C0", "C1", "Ccommit"])
    || canonicalizeJcs(intent.recovery) !== canonicalizeJcs(RECOVERY_CONTRACT)
    || Object.values(intent.constraints).some((item) => item !== true)) fail("intent_invalid", "writer intent fencing, recovery, or constraints differ");
  validateSelfHash(intent as unknown as Record<string, unknown>, "intent_hash", "audit", "writer intent");
  return deepFreeze(intent);
}

export function validatePropositionLifecycleFreshnessHead(value: unknown): PropositionLifecycleFreshnessHeadV1 {
  const head = asRecord(value, "head") as unknown as PropositionLifecycleFreshnessHeadV1;
  exactKeys(head as unknown as Record<string, unknown>, ["schema_version", "canonicalization", "hash_algorithm", "head_hash_scope", "authority", "generation", "predecessor_head_hash", "writer_protocol", "epoch", "source", "p2a", "coverage_hash", "audit", "head_hash"], "head");
  exactKeys(asRecord(head.writer_protocol, "head.writer_protocol"), ["protocol", "mode", "state", "intent_hash", "fence_token_hash", "commit_proof_hash", "abort_authorization_hash", "transaction"], "head.writer_protocol");
  if (head.writer_protocol.transaction !== null) exactKeys(asRecord(head.writer_protocol.transaction, "head.writer_protocol.transaction"), ["transaction_id", "staged_event_id", "staged_canonical_event_bytes_sha256", "expected_predecessor_selection_hash", "expected_post_append_corpus_hash"], "head.writer_protocol.transaction");
  exactKeys(asRecord(head.epoch, "head.epoch"), ["epoch_id", "genesis_event_id"], "head.epoch");
  exactKeys(asRecord(head.source, "head.source"), ["scanner", "resolver", "input_event_count", "input_event_ids", "input_event_ids_hash", "proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "evidence_event_ids", "evidence_event_ids_hash", "lifecycle_event_ids", "lifecycle_event_ids_hash", "source_resolution_inventory_hash"], "head.source");
  exactKeys(asRecord(head.p2a, "head.p2a"), ["manifest_schema_version", "bundle_hash", "result"], "head.p2a");
  exactKeys(asRecord(head.p2a.result, "head.p2a.result"), ["entry_count", "exclusion_count", "diagnostic_count"], "head.p2a.result");
  validateAudit(head.audit, "head.audit");
  if (head.schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_SCHEMA
    || head.canonicalization !== "RFC8785-JCS" || head.hash_algorithm !== "sha256"
    || head.head_hash_scope !== HEAD_HASH_SCOPE || head.authority !== "repo_sandbox_shadow_only") fail("head_invalid", "head identity differs");
  assertNonNegativeInteger(head.generation, "head generation");
  if (head.predecessor_head_hash !== null) assertHash(head.predecessor_head_hash, "head predecessor");
  validateWriterProtocol(head);
  if (typeof head.epoch.epoch_id !== "string" || !head.epoch.epoch_id || !HASH_PATTERN.test(head.epoch.genesis_event_id)) fail("head_invalid", "head epoch is invalid");
  if (head.source.scanner !== "scanWholeL1Validated" || head.source.resolver !== "proposition-lifecycle-effective-state/v1") fail("head_invalid", "head source scanner or resolver differs");
  const inputIds = validateHashList(head.source.input_event_ids, "head input IDs");
  const evidenceIds = validateHashList(head.source.evidence_event_ids, "head evidence IDs");
  const lifecycleIds = validateHashList(head.source.lifecycle_event_ids, "head lifecycle IDs");
  for (const value of [head.source.input_event_count, head.source.proposition_event_count, head.source.proposition_genesis_count, head.source.proposition_evidence_count, head.source.proposition_lifecycle_count, head.source.proposition_selected_count, head.source.proposition_foldable_count, ...Object.values(head.p2a.result)]) assertNonNegativeInteger(value, "head count");
  if (head.source.input_event_count !== inputIds.length || head.source.proposition_event_count !== inputIds.length
    || head.source.proposition_event_count !== head.source.proposition_genesis_count + head.source.proposition_evidence_count + head.source.proposition_lifecycle_count
    || head.source.proposition_genesis_count !== 1 || head.source.proposition_evidence_count !== evidenceIds.length
    || head.source.proposition_lifecycle_count !== lifecycleIds.length
    || head.p2a.result.entry_count + head.p2a.result.exclusion_count !== head.source.proposition_evidence_count
    || head.p2a.result.exclusion_count !== head.p2a.result.diagnostic_count) fail("head_invalid", "head source or result counts disagree");
  if (head.source.input_event_ids_hash !== jcsSha256Hex(inputIds)
    || head.source.evidence_event_ids_hash !== jcsSha256Hex(evidenceIds)
    || head.source.lifecycle_event_ids_hash !== jcsSha256Hex(lifecycleIds)) fail("head_invalid", "head event ID hash differs");
  for (const eventId of [...evidenceIds, ...lifecycleIds, head.epoch.genesis_event_id]) if (!inputIds.includes(eventId)) fail("head_invalid", "head source subset is outside input IDs", { eventId });
  assertHash(head.source.source_resolution_inventory_hash, "head resolution inventory");
  if (head.p2a.manifest_schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_P2A_MANIFEST_SCHEMA) fail("head_invalid", "head P2a schema differs");
  assertHash(head.p2a.bundle_hash, "head P2a bundle");
  const expectedCoverage = jcsSha256Hex({ epoch: head.epoch, source: head.source, p2a: head.p2a });
  if (head.coverage_hash !== expectedCoverage) fail("head_invalid", "head coverage hash differs");
  validateSelfHash(head as unknown as Record<string, unknown>, "head_hash", "audit", "head");
  return deepFreeze(head);
}

export function validatePropositionLifecycleFreshnessSelection(value: unknown): PropositionLifecycleFreshnessSelectionV1 {
  const selection = asRecord(value, "selection") as unknown as PropositionLifecycleFreshnessSelectionV1;
  exactKeys(selection as unknown as Record<string, unknown>, ["schema_version", "canonicalization", "hash_algorithm", "selection_hash_scope", "authority", "authority_binding", "generation", "seq", "predecessor_selection_hash", "decision", "head_hash", "head_generation", "references", "block", "activation", "audit", "selection_hash"], "selection");
  exactKeys(asRecord(selection.authority_binding, "selection.authority_binding"), ["authority_epoch", "authority_profile", "config_trust_anchor_hash"], "selection.authority_binding");
  exactKeys(asRecord(selection.references, "selection.references"), ["p2a_bundle_hash", "stable_bundle_hash", "stable_manifest_hash", "rendered_view_sha256"], "selection.references");
  exactKeys(asRecord(selection.activation, "selection.activation"), ["only_artifact_activation_point", "freshness_safety_gate", "p2a_latest_forbidden", "stable_latest_forbidden", "both_pointers_double_read_required"], "selection.activation");
  validateAudit(selection.audit, "selection.audit");
  if (selection.schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_SCHEMA
    || selection.canonicalization !== "RFC8785-JCS" || selection.hash_algorithm !== "sha256"
    || selection.selection_hash_scope !== SELECTION_HASH_SCOPE || selection.authority !== "repo_sandbox_shadow_only") fail("selection_invalid", "selection identity differs");
  if (selection.authority_binding.authority_epoch !== SHADOW_AUTHORITY_CONFIG.authority_epoch
    || selection.authority_binding.authority_profile !== SHADOW_AUTHORITY_CONFIG.authority_profile
    || selection.authority_binding.config_trust_anchor_hash !== PROPOSITION_LIFECYCLE_FRESHNESS_SHADOW_CONFIG_HASH) fail("selection_invalid", "selection authority/config trust anchor differs");
  assertNonNegativeInteger(selection.generation, "selection generation");
  assertNonNegativeInteger(selection.seq, "selection seq");
  if (selection.predecessor_selection_hash === null) {
    if (selection.generation !== 0 || selection.seq !== 0) fail("selection_chain_invalid", "selection genesis must be generation and seq zero");
  } else {
    assertHash(selection.predecessor_selection_hash, "selection predecessor");
    if (selection.seq === 0) fail("selection_chain_invalid", "selection successor must have a positive seq");
  }
  assertHash(selection.head_hash, "selection head");
  assertNonNegativeInteger(selection.head_generation, "selection head generation");
  if (selection.generation !== selection.head_generation) fail("selection_invalid", "selection generation does not equal selected head generation");
  if (selection.activation.only_artifact_activation_point !== SELECTION_POINTER_RELATIVE
    || selection.activation.freshness_safety_gate !== HEAD_POINTER_RELATIVE
    || selection.activation.p2a_latest_forbidden !== true || selection.activation.stable_latest_forbidden !== true
    || selection.activation.both_pointers_double_read_required !== true) fail("selection_invalid", "selection activation contract differs");
  if (selection.decision === "selected") {
    for (const [key, value] of Object.entries(selection.references)) assertHash(value, `selection reference ${key}`);
    if (selection.block !== null) fail("selection_invalid", "selected record carries a block");
  } else if (selection.decision === "blocked") {
    if (Object.values(selection.references).some((item) => item !== null)) fail("selection_invalid", "blocked record carries artifact references");
    const block = asRecord(selection.block, "selection.block");
    exactKeys(block, ["reason_code", "detail_hash"], "selection.block");
    if (typeof block.reason_code !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(block.reason_code)) fail("selection_invalid", "block reason is invalid");
    assertHash(block.detail_hash, "selection block detail");
  } else fail("selection_invalid", "selection decision differs");
  validateSelfHash(selection as unknown as Record<string, unknown>, "selection_hash", "audit", "selection");
  return deepFreeze(selection);
}

export function validatePropositionLifecycleFreshnessShadowBuild(build: PropositionLifecycleFreshnessShadowBuild): void {
  const head = validatePropositionLifecycleFreshnessHead(build.head);
  const selection = validatePropositionLifecycleFreshnessSelection(build.selection);
  validatePropositionPolicyPushBundle(build.p2a_bundle);
  if (head.writer_protocol.state !== "committed") fail("head_noncommitted", "a shadow build cannot select a noncommitted head");
  if (selection.head_hash !== head.head_hash || selection.head_generation !== head.generation) fail("head_selection_mismatch", "selection does not bind its head");
  if (head.writer_protocol.mode === "production") fail("production_write_unauthorized", "phase-one materializer cannot publish a production head");
  if (build.predecessor) {
    const predecessor = validateChainPredecessor(build.predecessor);
    assertHeadSuccessor(head, predecessor.head);
    assertSelectionSuccessor(selection, predecessor.selection);
  } else if (head.generation !== 0 || head.predecessor_head_hash !== null || selection.seq !== 0 || selection.predecessor_selection_hash !== null) {
    fail("chain_predecessor_missing", "non-genesis shadow build lacks its exact predecessor records");
  }
  assertHeadMatchesP2a(head, build.p2a_bundle.manifest);
  if (selection.decision === "selected") {
    if (!build.stable_bundle) fail("missing_cas", "selected build has no stable bundle");
    validatePropositionPolicyStableViewBundle(build.stable_bundle);
    assertStableSourceMatchesHeadAndP2a(head, build.p2a_bundle, build.stable_bundle);
    assertSelectionMatchesBundles(selection, build.p2a_bundle, build.stable_bundle);
  } else if (build.stable_bundle !== null) fail("selection_invalid", "blocked build must not carry a stable bundle");
}

export function assertPropositionLifecycleFreshnessSandboxOutputRoot(input: string): string {
  const resolved = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()));
  const tempReal = fs.realpathSync(os.tmpdir());
  if (resolved === tempReal || !isPathInside(tempReal, resolved)) fail("sandbox_output_required", "output must be a child of the real system temporary directory", { resolved, tempReal });
  const productionRoots = [
    "/home/worker/.abrain",
    "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1",
    "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
  ].map((item) => path.resolve(item));
  if (productionRoots.some((root) => isPathInside(root, resolved) || isPathInside(resolved, root))) fail("production_output_forbidden", "output overlaps a production artifact root", { resolved });
  assertExistingAncestorsNoSymlink(resolved);
  const existing = lstatIfPresent(resolved);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory() || fs.realpathSync(resolved) !== resolved)) fail("sandbox_output_unsafe", "output root is not an exact directory", { resolved });
  return resolved;
}

export async function materializePropositionLifecycleFreshnessShadow(options: {
  outputRoot: string;
  build: PropositionLifecycleFreshnessShadowBuild;
}): Promise<PropositionLifecycleFreshnessMaterializationResult> {
  validatePropositionLifecycleFreshnessShadowBuild(options.build);
  const outputRoot = assertPropositionLifecycleFreshnessSandboxOutputRoot(options.outputRoot);
  await ensureExactDirectory(outputRoot);
  assertRootEntriesAllowed(outputRoot);
  const { head, selection, p2a_bundle: p2a, stable_bundle: stable } = options.build;
  const initial = inspectPointerPairForMaterialization(outputRoot);
  assertMaterializationPrecondition(initial, options.build);
  let createdCas = false;
  createdCas = (await writeCasDocument(outputRoot, `heads/v1/${head.head_hash}`, "head.json", canonicalJson(head))) || createdCas;
  if (selection.decision === "selected") {
    createdCas = (await materializeArtifactBundle(outputRoot, `p2a/v2/bundles/${p2a.manifest.bundle_hash}`, p2a.bytes, P2A_ARTIFACT_NAMES)) || createdCas;
    createdCas = (await materializeArtifactBundle(outputRoot, `stable/v1/bundles/${stable!.bundle_hash}`, stable!.artifacts, STABLE_ARTIFACT_NAMES)) || createdCas;
  }
  createdCas = (await writeCasDocument(outputRoot, `selections/v1/${selection.selection_hash}`, "selection.json", canonicalJson(selection))) || createdCas;

  const headPointerPath = path.join(outputRoot, ...HEAD_POINTER_RELATIVE.split("/"));
  const selectionPointerPath = path.join(outputRoot, ...SELECTION_POINTER_RELATIVE.split("/"));
  const headPointerRaw = canonicalJson({ schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_SCHEMA, head_hash: head.head_hash });
  const selectionPointerRaw = canonicalJson({ schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_SCHEMA, selection_hash: selection.selection_hash });

  const headPointerChanged = await advancePointer(headPointerPath, headPointerRaw, "head", initial.head?.raw ?? null);
  const selectionPointerChanged = await advancePointer(selectionPointerPath, selectionPointerRaw, "selection", initial.selection?.raw ?? null);
  assertRootEntriesAllowed(outputRoot);
  assertMaterializedBuildReadback(outputRoot, options.build);

  let status: PropositionLifecycleFreshnessMaterializationResult["status"];
  if (!initial.head && !initial.selection) status = "created";
  else if (headPointerChanged || selectionPointerChanged) status = "advanced";
  else if (createdCas) status = "recovered";
  else status = "identical";
  return deepFreeze({
    status,
    output_root: outputRoot,
    head_hash: head.head_hash,
    selection_hash: selection.selection_hash,
    p2a_bundle_hash: selection.references.p2a_bundle_hash,
    stable_bundle_hash: selection.references.stable_bundle_hash,
    head_pointer_path: headPointerPath,
    selection_pointer_path: selectionPointerPath,
  });
}

export function readPropositionLifecycleFreshnessShadow(options: {
  outputRoot: string;
  afterFirstPointerReads?: () => void;
}): PropositionLifecycleFreshnessReadResult {
  let firstHead: VerifiedPointer | undefined;
  let firstSelection: VerifiedPointer | undefined;
  let result: PropositionLifecycleFreshnessReadResult | undefined;
  let selectedHash: string | undefined;
  let headHash: string | undefined;
  let outputRoot: string | undefined;
  try {
    outputRoot = exactDirectory(options.outputRoot, "shadow output root");
    assertRootEntriesAllowed(outputRoot);
    firstHead = readVerifiedPointer(path.join(outputRoot, ...HEAD_POINTER_RELATIVE.split("/")), "head");
    headHash = firstHead.hash;
    firstSelection = readVerifiedPointer(path.join(outputRoot, ...SELECTION_POINTER_RELATIVE.split("/")), "selection");
    selectedHash = firstSelection.hash;
    options.afterFirstPointerReads?.();

    const head = readCasHead(outputRoot, headHash);
    if (head.writer_protocol.state !== "committed") {
      result = { ok: false, reason: "head_noncommitted", selectionHash: selectedHash, headHash };
    } else {
      const selection = readCasSelection(outputRoot, selectedHash);
      if (selection.head_hash !== headHash || selection.head_generation !== head.generation) {
        result = { ok: false, reason: "head_selection_mismatch", selectionHash: selectedHash, headHash };
      } else {
        const headChain = readAndValidateHeadChain(outputRoot, head);
        const selectionChain = readAndValidateSelectionChain(outputRoot, selection);
        if (selection.decision !== "selected") {
          result = { ok: false, reason: "selection_blocked", selectionHash: selectedHash, headHash, error: selection.block!.reason_code };
        } else {
          assertProductionIntentChainBeforeArtifacts(outputRoot, headChain, selectionChain, selection);
          const p2a = readP2aBundle(outputRoot, selection.references.p2a_bundle_hash!);
          const stable = readStableBundle(outputRoot, selection.references.stable_bundle_hash!, p2a);
          assertHeadMatchesP2a(head, p2a.manifest);
          assertStableSourceMatchesHeadAndP2a(head, p2a, stable);
          assertSelectionMatchesBundles(selection, p2a, stable);
          const view = parseCanonicalJson(stable.artifacts["view.json"], "stable view") as Record<string, unknown>;
          const items = asArray(view.items, "stable view.items");
          result = {
            ok: true,
            reason: "selected_consistent",
            freshness_basis: "committed_head_and_selected_selection_dual_pointer_consistency_only",
            selectionHash: selection.selection_hash,
            headHash: head.head_hash,
            headGeneration: head.generation,
            selectionSeq: selection.seq,
            p2aBundleHash: p2a.manifest.bundle_hash,
            stableBundleHash: stable.bundle_hash,
            stableManifestHash: String(stable.manifest.manifest_hash),
            viewMd: stable.artifacts["view.md"],
            viewBytes: Buffer.byteLength(stable.artifacts["view.md"]),
            itemCount: items.length,
            sourceCounts: {
              inputEvents: head.source.input_event_count,
              evidenceEvents: head.source.proposition_evidence_count,
              lifecycleEvents: head.source.proposition_lifecycle_count,
              candidates: p2a.manifest.result.entry_count,
              exclusions: p2a.manifest.result.exclusion_count,
              diagnostics: p2a.manifest.result.diagnostic_count,
            },
          };
        }
      }
    }
  } catch (error) {
    const normalized = normalizeReadError(error);
    result = { ok: false, reason: normalized.code, ...(selectedHash ? { selectionHash: selectedHash } : {}), ...(headHash ? { headHash } : {}), error: normalized.message };
  }

  const secondReadFailure = verifySecondPointerReads(outputRoot, firstHead, firstSelection);
  if (secondReadFailure) return { ok: false, reason: secondReadFailure.code, ...(selectedHash ? { selectionHash: selectedHash } : {}), ...(headHash ? { headHash } : {}), error: secondReadFailure.message };
  return result ?? { ok: false, reason: "reader_failed" };
}

function buildCommittedShadowHead(manifest: PropositionPolicyPushManifest, predecessor: PropositionLifecycleFreshnessHeadV1 | null): PropositionLifecycleFreshnessHeadV1 {
  const source = {
    scanner: "scanWholeL1Validated" as const,
    resolver: "proposition-lifecycle-effective-state/v1" as const,
    input_event_count: manifest.source.input_event_ids.length,
    input_event_ids: manifest.source.input_event_ids,
    input_event_ids_hash: manifest.source.input_event_ids_hash,
    proposition_event_count: manifest.source.proposition_event_count,
    proposition_genesis_count: manifest.source.proposition_genesis_count,
    proposition_evidence_count: manifest.source.proposition_evidence_count,
    proposition_lifecycle_count: manifest.source.proposition_lifecycle_count,
    proposition_selected_count: manifest.source.proposition_selected_count,
    proposition_foldable_count: manifest.source.proposition_foldable_count,
    evidence_event_ids: manifest.source.evidence_event_ids,
    evidence_event_ids_hash: manifest.source.evidence_event_ids_hash,
    lifecycle_event_ids: manifest.source.lifecycle_event_ids,
    lifecycle_event_ids_hash: manifest.source.lifecycle_event_ids_hash,
    source_resolution_inventory_hash: manifest.source.source_resolution_inventory_hash,
  };
  const p2a = {
    manifest_schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_P2A_MANIFEST_SCHEMA,
    bundle_hash: manifest.bundle_hash,
    result: { ...manifest.result },
  };
  const base = {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    head_hash_scope: HEAD_HASH_SCOPE,
    authority: "repo_sandbox_shadow_only" as const,
    generation: predecessor ? predecessor.generation + 1 : 0,
    predecessor_head_hash: predecessor?.head_hash ?? null,
    writer_protocol: {
      protocol: "staged_event_intent_then_fenced_commit/v1" as const,
      mode: predecessor ? "shadow_advance" as const : "shadow_genesis" as const,
      state: "committed" as const,
      intent_hash: null,
      fence_token_hash: null,
      commit_proof_hash: null,
      abort_authorization_hash: null,
      transaction: null,
    },
    epoch: { ...manifest.epoch },
    source,
    p2a,
    coverage_hash: jcsSha256Hex({ epoch: manifest.epoch, source, p2a }),
    audit: AUDIT_CONTRACT,
  };
  return validatePropositionLifecycleFreshnessHead(deepFreeze({ ...base, head_hash: identityHash(base) }));
}

function buildSelectedRecord(head: PropositionLifecycleFreshnessHeadV1, stable: PropositionPolicyStableViewBundle, predecessor: PropositionLifecycleFreshnessSelectionV1 | null): PropositionLifecycleFreshnessSelectionV1 {
  const base = selectionBase(head, predecessor, "selected" as const, {
    p2a_bundle_hash: stable.source_bundle.manifest.bundle_hash,
    stable_bundle_hash: stable.bundle_hash,
    stable_manifest_hash: String(stable.manifest.manifest_hash),
    rendered_view_sha256: sha256Hex(stable.artifacts["view.md"]),
  }, null);
  return validatePropositionLifecycleFreshnessSelection(deepFreeze({ ...base, selection_hash: identityHash(base) }));
}

function buildBlockedRecord(head: PropositionLifecycleFreshnessHeadV1, reasonCode: string, detail: unknown, predecessor: PropositionLifecycleFreshnessSelectionV1 | null): PropositionLifecycleFreshnessSelectionV1 {
  const base = selectionBase(head, predecessor, "blocked" as const, { p2a_bundle_hash: null, stable_bundle_hash: null, stable_manifest_hash: null, rendered_view_sha256: null }, { reason_code: reasonCode, detail_hash: jcsSha256Hex(detail) });
  return validatePropositionLifecycleFreshnessSelection(deepFreeze({ ...base, selection_hash: identityHash(base) }));
}

function selectionBase(head: PropositionLifecycleFreshnessHeadV1, predecessor: PropositionLifecycleFreshnessSelectionV1 | null, decision: "selected" | "blocked", references: PropositionLifecycleFreshnessSelectionV1["references"], block: PropositionLifecycleFreshnessSelectionV1["block"]) {
  return {
    schema_version: PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    selection_hash_scope: SELECTION_HASH_SCOPE,
    authority: "repo_sandbox_shadow_only" as const,
    authority_binding: {
      authority_epoch: SHADOW_AUTHORITY_CONFIG.authority_epoch,
      authority_profile: SHADOW_AUTHORITY_CONFIG.authority_profile,
      config_trust_anchor_hash: PROPOSITION_LIFECYCLE_FRESHNESS_SHADOW_CONFIG_HASH,
    },
    generation: head.generation,
    seq: predecessor ? predecessor.seq + 1 : 0,
    predecessor_selection_hash: predecessor?.selection_hash ?? null,
    decision,
    head_hash: head.head_hash,
    head_generation: head.generation,
    references,
    block,
    activation: activationContract(),
    audit: AUDIT_CONTRACT,
  };
}

function activationContract() {
  return deepFreeze({
    only_artifact_activation_point: SELECTION_POINTER_RELATIVE,
    freshness_safety_gate: HEAD_POINTER_RELATIVE,
    p2a_latest_forbidden: true as const,
    stable_latest_forbidden: true as const,
    both_pointers_double_read_required: true as const,
  });
}

function validateWriterProtocol(head: PropositionLifecycleFreshnessHeadV1): void {
  const protocol = head.writer_protocol;
  if (protocol.protocol !== "staged_event_intent_then_fenced_commit/v1" || !["intent", "committed", "aborted"].includes(protocol.state)) fail("head_invalid", "writer protocol identity differs");
  if (protocol.mode === "shadow_genesis") {
    if (head.generation !== 0 || head.predecessor_head_hash !== null || protocol.state !== "committed") fail("head_invalid", "shadow genesis chain state differs");
    assertNullWriterEvidence(protocol, "shadow genesis");
    return;
  }
  if (protocol.mode === "shadow_advance") {
    if (head.generation < 1 || head.predecessor_head_hash === null || protocol.state !== "committed") fail("head_invalid", "shadow successor chain state differs");
    assertNullWriterEvidence(protocol, "shadow successor");
    return;
  }
  if (protocol.mode !== "production" || head.generation < 1 || head.predecessor_head_hash === null) fail("head_invalid", "production head generation or predecessor differs");
  assertHash(protocol.intent_hash, "production head intent");
  const transaction = asRecord(protocol.transaction, "production head transaction") as unknown as PropositionLifecycleFreshnessTransactionBindingV1;
  for (const [key, value] of Object.entries(transaction)) assertHash(value, `production head transaction ${key}`);
  if (transaction.expected_post_append_corpus_hash !== corpusHash(head.source.input_event_count, head.source.input_event_ids_hash)
    || !head.source.input_event_ids.includes(transaction.staged_event_id)) fail("head_invalid", "production transaction does not bind the post-append corpus");
  if (protocol.state === "intent") {
    if (protocol.fence_token_hash !== null || protocol.commit_proof_hash !== null || protocol.abort_authorization_hash !== null) fail("head_invalid", "intent head carries terminal evidence");
  } else if (protocol.state === "committed") {
    assertHash(protocol.fence_token_hash, "production head fence token");
    assertHash(protocol.commit_proof_hash, "production head commit proof");
    if (protocol.abort_authorization_hash !== null) fail("head_invalid", "committed head carries abort authorization");
  } else {
    if (protocol.fence_token_hash !== null) assertHash(protocol.fence_token_hash, "aborted head fence token");
    if (protocol.commit_proof_hash !== null) fail("head_invalid", "aborted head carries commit proof");
    assertHash(protocol.abort_authorization_hash, "aborted head explicit authorization");
  }
}

function assertNullWriterEvidence(protocol: PropositionLifecycleFreshnessHeadV1["writer_protocol"], label: string): void {
  if (protocol.intent_hash !== null || protocol.fence_token_hash !== null || protocol.commit_proof_hash !== null
    || protocol.abort_authorization_hash !== null || protocol.transaction !== null) fail("head_invalid", `${label} carries production writer evidence`);
}

function validateChainPredecessor(value: PropositionLifecycleFreshnessChainPredecessor): PropositionLifecycleFreshnessChainPredecessor {
  const head = validatePropositionLifecycleFreshnessHead(value.head);
  const selection = validatePropositionLifecycleFreshnessSelection(value.selection);
  if (head.writer_protocol.state !== "committed" || selection.head_hash !== head.head_hash || selection.head_generation !== head.generation) fail("chain_predecessor_invalid", "predecessor selection does not bind a committed predecessor head");
  return deepFreeze({ head, selection });
}

function assertHeadSuccessor(head: PropositionLifecycleFreshnessHeadV1, predecessor: PropositionLifecycleFreshnessHeadV1): void {
  if (head.predecessor_head_hash !== predecessor.head_hash || head.generation !== predecessor.generation + 1) fail("head_chain_invalid", "head predecessor hash or generation is not contiguous");
  if (canonicalizeJcs(head.epoch) !== canonicalizeJcs(predecessor.epoch)) fail("head_chain_invalid", "head successor changed epoch");
  if (head.source.input_event_count < predecessor.source.input_event_count
    || predecessor.source.input_event_ids.some((eventId) => !head.source.input_event_ids.includes(eventId))) fail("head_chain_invalid", "head successor is not append-only over predecessor corpus");
}

function assertSelectionSuccessor(selection: PropositionLifecycleFreshnessSelectionV1, predecessor: PropositionLifecycleFreshnessSelectionV1): void {
  if (selection.predecessor_selection_hash !== predecessor.selection_hash || selection.seq !== predecessor.seq + 1) fail("selection_chain_invalid", "selection predecessor hash or seq is not contiguous");
  if (selection.generation < predecessor.generation) fail("selection_chain_invalid", "selection generation regressed");
  if (canonicalizeJcs(selection.authority_binding) !== canonicalizeJcs(predecessor.authority_binding)) fail("selection_chain_invalid", "selection authority/config trust anchor changed within the chain");
}

function assertHeadMatchesP2a(head: PropositionLifecycleFreshnessHeadV1, manifest: PropositionPolicyPushManifest): void {
  const expected = buildCommittedShadowHead(manifest, null);
  const comparableHead = { epoch: head.epoch, source: head.source, p2a: head.p2a, coverage_hash: head.coverage_hash };
  const comparableExpected = { epoch: expected.epoch, source: expected.source, p2a: expected.p2a, coverage_hash: expected.coverage_hash };
  if (canonicalizeJcs(comparableHead) !== canonicalizeJcs(comparableExpected)) fail("head_bundle_mismatch", "head coverage certificate differs from the validated P2a v2 manifest");
}

function assertStableSourceMatchesHeadAndP2a(head: PropositionLifecycleFreshnessHeadV1, p2a: PropositionPolicyPushBundle, stable: PropositionPolicyStableViewBundle): void {
  if (stable.source_bundle.manifest.bundle_hash !== p2a.manifest.bundle_hash || canonicalizeJcs(stable.source_bundle) !== canonicalizeJcs(p2a)) fail("stable_p2a_mismatch", "stable bundle source differs from the selected P2a CAS bundle");
  const manifest = stable.manifest as Record<string, unknown>;
  const canonicalSource = asRecord(manifest.canonical_source, "stable manifest.canonical_source");
  const physical = asRecord(canonicalSource.physical_accounting, "stable manifest physical accounting");
  const projection = asRecord(manifest.projection, "stable manifest.projection");
  if (manifest.schema_version !== PROPOSITION_LIFECYCLE_FRESHNESS_STABLE_MANIFEST_SCHEMA
    || projection.bundle_hash !== p2a.manifest.bundle_hash
    || projection.source_resolution_inventory_hash !== head.source.source_resolution_inventory_hash
    || canonicalSource.input_event_count !== head.source.input_event_count
    || canonicalizeJcs(canonicalSource.input_event_ids) !== canonicalizeJcs(head.source.input_event_ids)
    || canonicalSource.input_event_ids_hash !== head.source.input_event_ids_hash
    || canonicalizeJcs(physical.evidence_event_ids) !== canonicalizeJcs(head.source.evidence_event_ids)
    || physical.evidence_event_ids_hash !== head.source.evidence_event_ids_hash
    || canonicalizeJcs(physical.lifecycle_event_ids) !== canonicalizeJcs(head.source.lifecycle_event_ids)
    || physical.lifecycle_event_ids_hash !== head.source.lifecycle_event_ids_hash) fail("head_bundle_mismatch", "stable canonical source or projection differs from the committed head");
}

function assertSelectionMatchesBundles(selection: PropositionLifecycleFreshnessSelectionV1, p2a: PropositionPolicyPushBundle, stable: PropositionPolicyStableViewBundle): void {
  if (selection.references.p2a_bundle_hash !== p2a.manifest.bundle_hash
    || selection.references.stable_bundle_hash !== stable.bundle_hash
    || selection.references.stable_manifest_hash !== stable.manifest.manifest_hash
    || selection.references.rendered_view_sha256 !== sha256Hex(stable.artifacts["view.md"])) fail("selection_bundle_mismatch", "selection references differ from validated P2a/stable bytes");
}

function assertIntentMatchesCommittedHead(intent: PropositionLifecycleFreshnessWriterIntentV1, head: PropositionLifecycleFreshnessHeadV1, selection?: PropositionLifecycleFreshnessSelectionV1): void {
  const transaction = head.writer_protocol.transaction!;
  if (head.writer_protocol.mode !== "production" || head.writer_protocol.state !== "committed"
    || head.writer_protocol.intent_hash !== intent.intent_hash
    || head.writer_protocol.fence_token_hash !== intent.fencing.fence_token_hash
    || head.predecessor_head_hash !== intent.precondition.expected_predecessor_head_hash
    || head.generation !== intent.precondition.expected_generation
    || head.coverage_hash !== intent.expected_post_append.coverage_hash
    || head.p2a.bundle_hash !== intent.expected_post_append.p2a_bundle_hash
    || head.source.input_event_count !== intent.expected_post_append.input_event_count
    || head.source.input_event_ids_hash !== intent.expected_post_append.input_event_ids_hash
    || transaction.transaction_id !== intent.transaction_id
    || transaction.staged_event_id !== intent.staged_event.event_id
    || transaction.staged_canonical_event_bytes_sha256 !== intent.staged_event.canonical_event_bytes_sha256
    || transaction.expected_predecessor_selection_hash !== intent.precondition.expected_predecessor_selection_hash
    || transaction.expected_post_append_corpus_hash !== intent.expected_post_append.corpus_hash) fail("intent_head_mismatch", "production committed head differs from its immutable staged transaction intent");
  if (selection && (selection.predecessor_selection_hash !== intent.precondition.expected_predecessor_selection_hash
    || selection.seq !== intent.precondition.expected_selection_seq + 1)) fail("intent_selection_mismatch", "production selection differs from the intent CAS precondition");
}

function assertProductionIntentChainBeforeArtifacts(root: string, heads: readonly PropositionLifecycleFreshnessHeadV1[], selections: readonly PropositionLifecycleFreshnessSelectionV1[], currentSelection: PropositionLifecycleFreshnessSelectionV1): void {
  if (selections[0]?.selection_hash !== currentSelection.selection_hash) fail("intent_selection_mismatch", "current selection is not the tip of the validated predecessor chain");
  const selectionByHash = new Map(selections.map((selection) => [selection.selection_hash, selection]));
  const successorByPredecessorHash = new Map(selections
    .filter((selection) => selection.predecessor_selection_hash !== null)
    .map((selection) => [selection.predecessor_selection_hash!, selection]));
  for (const head of heads) {
    if (head.writer_protocol.mode !== "production" || head.writer_protocol.state !== "committed") continue;
    const intent = readCasIntent(root, head.writer_protocol.intent_hash!);
    const predecessorHash = intent.precondition.expected_predecessor_selection_hash;
    if (!selectionByHash.has(predecessorHash)) fail("intent_selection_mismatch", "intent predecessor selection is outside the validated selection chain");
    const boundSelection = successorByPredecessorHash.get(predecessorHash);
    if (!boundSelection || boundSelection.head_hash !== head.head_hash) fail("intent_selection_mismatch", "production head has no exact intent-predecessor selection edge in the validated chain");
    assertIntentMatchesCommittedHead(intent, head, boundSelection);
  }
}

function readAndValidateHeadChain(root: string, current: PropositionLifecycleFreshnessHeadV1): readonly PropositionLifecycleFreshnessHeadV1[] {
  const chain: PropositionLifecycleFreshnessHeadV1[] = [];
  const seen = new Set<string>();
  let cursor = current;
  for (;;) {
    if (seen.has(cursor.head_hash) || chain.length >= MAX_CHAIN_LENGTH) fail("head_chain_invalid", "head chain cycles or exceeds its hard bound");
    seen.add(cursor.head_hash);
    chain.push(cursor);
    if (cursor.predecessor_head_hash === null) {
      if (cursor.generation !== 0 || cursor.writer_protocol.mode !== "shadow_genesis") fail("head_chain_invalid", "head chain does not terminate in the exact genesis rule");
      break;
    }
    const predecessor = readCasHead(root, cursor.predecessor_head_hash);
    assertHeadSuccessor(cursor, predecessor);
    cursor = predecessor;
  }
  if (chain.length !== current.generation + 1) fail("head_chain_invalid", "head generation does not equal chain length");
  return Object.freeze(chain);
}

function readAndValidateSelectionChain(root: string, current: PropositionLifecycleFreshnessSelectionV1): readonly PropositionLifecycleFreshnessSelectionV1[] {
  const chain: PropositionLifecycleFreshnessSelectionV1[] = [];
  const seen = new Set<string>();
  let cursor = current;
  for (;;) {
    if (seen.has(cursor.selection_hash) || chain.length >= MAX_CHAIN_LENGTH) fail("selection_chain_invalid", "selection chain cycles or exceeds its hard bound");
    seen.add(cursor.selection_hash);
    chain.push(cursor);
    if (cursor.predecessor_selection_hash === null) {
      if (cursor.generation !== 0 || cursor.seq !== 0) fail("selection_chain_invalid", "selection chain does not terminate in the exact genesis rule");
      break;
    }
    const predecessor = readCasSelection(root, cursor.predecessor_selection_hash);
    assertSelectionSuccessor(cursor, predecessor);
    cursor = predecessor;
  }
  if (chain.length !== current.seq + 1) fail("selection_chain_invalid", "selection seq does not equal chain length");
  return Object.freeze(chain);
}

function readCasIntent(root: string, hash: string): PropositionLifecycleFreshnessWriterIntentV1 {
  let raw: string;
  try { raw = readExactCasDocument(root, `intents/v1/${hash}`, "intent.json", "writer intent"); }
  catch (error) { if (error instanceof PropositionLifecycleFreshnessShadowError && error.code === "missing_cas") fail("intent_missing", "production committed head intent is missing", { hash }); throw error; }
  const intent = validatePropositionLifecycleFreshnessWriterIntent(parseCanonicalJson(raw, "writer intent"));
  if (intent.intent_hash !== hash) fail("intent_invalid", "intent directory identity differs");
  return intent;
}

function readCasHead(root: string, hash: string): PropositionLifecycleFreshnessHeadV1 {
  const raw = readExactCasDocument(root, `heads/v1/${hash}`, "head.json", "head");
  const head = validatePropositionLifecycleFreshnessHead(parseCanonicalJson(raw, "head"));
  if (head.head_hash !== hash) fail("head_invalid", "head directory identity differs");
  return head;
}

function readCasSelection(root: string, hash: string): PropositionLifecycleFreshnessSelectionV1 {
  const raw = readExactCasDocument(root, `selections/v1/${hash}`, "selection.json", "selection");
  const selection = validatePropositionLifecycleFreshnessSelection(parseCanonicalJson(raw, "selection"));
  if (selection.selection_hash !== hash) fail("selection_invalid", "selection directory identity differs");
  return selection;
}

function readP2aBundle(root: string, hash: string): PropositionPolicyPushBundle {
  const bytes = readArtifactBundle<P2aArtifactName>(root, `p2a/v2/bundles/${hash}`, P2A_ARTIFACT_NAMES, "P2a bundle");
  const bundle = deepFreeze({
    manifest: parseCanonicalJson(bytes["manifest.json"], "P2a manifest"),
    entries: parseCanonicalJson(bytes["entries.json"], "P2a entries"),
    exclusions: parseCanonicalJson(bytes["exclusions.json"], "P2a exclusions"),
    diagnostics: parseCanonicalJson(bytes["diagnostics.json"], "P2a diagnostics"),
    bytes,
  }) as PropositionPolicyPushBundle;
  validatePropositionPolicyPushBundle(bundle);
  if (bundle.manifest.bundle_hash !== hash) fail("p2a_invalid", "P2a directory identity differs");
  return bundle;
}

function readStableBundle(root: string, hash: string, sourceBundle: PropositionPolicyPushBundle): PropositionPolicyStableViewBundle {
  const artifacts = readArtifactBundle<StableArtifactName>(root, `stable/v1/bundles/${hash}`, STABLE_ARTIFACT_NAMES, "stable bundle");
  const manifest = parseCanonicalJson(artifacts["manifest.json"], "stable manifest") as Record<string, unknown>;
  const bundle = deepFreeze({ bundle_hash: hash, artifacts, manifest, source_bundle: sourceBundle }) as PropositionPolicyStableViewBundle;
  validatePropositionPolicyStableViewBundle(bundle);
  if (bundle.bundle_hash !== hash || manifest.bundle_hash !== hash) fail("stable_invalid", "stable directory identity differs");
  return bundle;
}

async function writeCasDocument(root: string, relativeDirectory: string, name: string, raw: string): Promise<boolean> {
  const directory = await ensureRelativeDirectory(root, relativeDirectory);
  const status = await durableAtomicCreateFile(path.join(directory, name), raw, { mode: 0o600, tmpPath: externalDurableTempPath(root, name) });
  if (status === "collision") fail("cas_collision", "existing immutable CAS document differs", { directory, name });
  assertDirectoryNames(directory, [name], "CAS document");
  if (readExactRegularFile(path.join(directory, name), "CAS document readback") !== raw) fail("cas_collision", "CAS document readback differs", { directory, name });
  return status === "created";
}

async function materializeArtifactBundle<T extends string>(root: string, relativeDirectory: string, bytes: Readonly<Record<T, string>>, names: readonly T[]): Promise<boolean> {
  const directory = await ensureRelativeDirectory(root, relativeDirectory);
  let created = false;
  for (const name of names) {
    const status = await durableAtomicCreateFile(path.join(directory, name), bytes[name], { mode: 0o600, tmpPath: externalDurableTempPath(root, name) });
    if (status === "collision") fail("cas_collision", "existing immutable artifact CAS differs", { directory, name });
    created = status === "created" || created;
  }
  assertDirectoryNames(directory, names, "artifact CAS bundle");
  for (const name of names) if (readExactRegularFile(path.join(directory, name), `artifact ${name} readback`) !== bytes[name]) fail("cas_collision", "artifact CAS readback differs", { directory, name });
  return created;
}

function assertMaterializedBuildReadback(root: string, build: PropositionLifecycleFreshnessShadowBuild): void {
  const headPointer = readVerifiedPointer(path.join(root, ...HEAD_POINTER_RELATIVE.split("/")), "head");
  const selectionPointer = readVerifiedPointer(path.join(root, ...SELECTION_POINTER_RELATIVE.split("/")), "selection");
  if (headPointer.hash !== build.head.head_hash || selectionPointer.hash !== build.selection.selection_hash) fail("pointer_advance_conflict", "materialized pointer readback differs from requested build");
  const head = readCasHead(root, build.head.head_hash);
  const selection = readCasSelection(root, build.selection.selection_hash);
  if (canonicalizeJcs(head) !== canonicalizeJcs(build.head) || canonicalizeJcs(selection) !== canonicalizeJcs(build.selection)) fail("cas_collision", "materialized control record readback differs");
  readAndValidateHeadChain(root, head);
  readAndValidateSelectionChain(root, selection);
  if (selection.decision === "selected") {
    const p2a = readP2aBundle(root, selection.references.p2a_bundle_hash!);
    const stable = readStableBundle(root, selection.references.stable_bundle_hash!, p2a);
    assertHeadMatchesP2a(head, p2a.manifest);
    assertStableSourceMatchesHeadAndP2a(head, p2a, stable);
    assertSelectionMatchesBundles(selection, p2a, stable);
  }
}

interface MaterializationPointerPair {
  head: VerifiedPointer | null;
  selection: VerifiedPointer | null;
}

function inspectPointerPairForMaterialization(root: string): MaterializationPointerPair {
  const headFile = path.join(root, ...HEAD_POINTER_RELATIVE.split("/"));
  const selectionFile = path.join(root, ...SELECTION_POINTER_RELATIVE.split("/"));
  const head = lstatIfPresent(headFile) ? readVerifiedPointer(headFile, "head") : null;
  const selection = lstatIfPresent(selectionFile) ? readVerifiedPointer(selectionFile, "selection") : null;
  if (!head && selection) fail("head_pointer_missing", "selection activation exists without the head freshness pointer");
  return { head, selection };
}

function assertMaterializationPrecondition(current: MaterializationPointerPair, build: PropositionLifecycleFreshnessShadowBuild): void {
  if (!current.head && !current.selection) {
    if (build.head.generation !== 0 || build.selection.seq !== 0) fail("pointer_precondition_failed", "non-genesis build cannot initialize an empty layout");
    return;
  }
  if (current.head?.hash === build.head.head_hash) {
    if (!current.selection) return;
    if (current.selection.hash === build.selection.selection_hash) return;
    if (build.predecessor?.selection.selection_hash === current.selection.hash) return;
    fail("pointer_precondition_failed", "head-first recovery selection does not match the exact predecessor");
  }
  if (!current.head || !current.selection || !build.predecessor
    || current.head.hash !== build.predecessor.head.head_hash
    || current.selection.hash !== build.predecessor.selection.selection_hash) fail("pointer_precondition_failed", "current dual pointers do not match the build predecessor");
}

async function advancePointer(file: string, raw: string, kind: PointerKind, expectedRaw: string | null): Promise<boolean> {
  await ensureExactDirectory(path.dirname(file));
  const outputRoot = path.dirname(path.dirname(file));
  const existing = lstatIfPresent(file);
  if (existing) {
    const current = readVerifiedPointer(file, kind);
    if (current.raw === raw) return false;
    if (expectedRaw === null || current.raw !== expectedRaw) fail("pointer_advance_conflict", `${kind} pointer changed before advance`);
    await durableAtomicWriteFile(file, raw, { mode: 0o600, tmpPath: externalDurableTempPath(outputRoot, `${kind}-pointer`) });
  } else {
    const status = await durableAtomicCreateFile(file, raw, { mode: 0o600, tmpPath: externalDurableTempPath(outputRoot, `${kind}-pointer`) });
    if (status === "collision") fail("pointer_advance_conflict", `${kind} pointer concurrent create differs`);
  }
  const verified = readVerifiedPointer(file, kind);
  if (verified.raw !== raw) fail("pointer_advance_conflict", `${kind} pointer readback differs`);
  return true;
}

function externalDurableTempPath(outputRoot: string, label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.${safeLabel}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
}

function readExactCasDocument(root: string, relativeDirectory: string, name: string, label: string): string {
  const directory = path.join(root, ...relativeDirectory.split("/"));
  try {
    exactDirectory(directory, label);
    assertDirectoryNames(directory, [name], label);
    return readExactRegularFile(path.join(directory, name), label);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) fail("missing_cas", `${label} is missing`, { directory });
    throw error;
  }
}

function readArtifactBundle<T extends string>(root: string, relativeDirectory: string, names: readonly T[], label: string): Readonly<Record<T, string>> {
  const directory = path.join(root, ...relativeDirectory.split("/"));
  try {
    exactDirectory(directory, label);
    assertDirectoryNames(directory, names, label);
    const output = {} as Record<T, string>;
    for (const name of names) output[name] = readExactRegularFile(path.join(directory, name), `${label} ${name}`);
    return deepFreeze(output);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) fail("missing_cas", `${label} is missing`, { directory });
    throw error;
  }
}

type PointerKind = "head" | "selection";

interface PointerIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface VerifiedPointer {
  file: string;
  kind: PointerKind;
  raw: string;
  hash: string;
  identity: PointerIdentity;
}

function readVerifiedPointer(file: string, kind: PointerKind): VerifiedPointer {
  let before: fs.BigIntStats;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (isNodeErrorCode(error, "ENOENT")) fail(`${kind}_pointer_missing`, `${kind} pointer is missing`, { file }); throw error; }
  if (before.isSymbolicLink() || !before.isFile()) fail(`${kind}_pointer_invalid`, `${kind} pointer is not a regular no-follow file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(pointerIdentity(before), pointerIdentity(opened))) fail(`${kind}_pointer_invalid`, `opened ${kind} pointer differs from named path`);
    const raw = fs.readFileSync(fd, "utf8");
    const afterFd = fs.fstatSync(fd, { bigint: true });
    let afterPath: fs.BigIntStats;
    try { afterPath = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (isNodeErrorCode(error, "ENOENT")) fail(`${kind}_pointer_aba`, `${kind} pointer disappeared during one read`); throw error; }
    const identity = pointerIdentity(before);
    if (!sameIdentity(identity, pointerIdentity(afterFd)) || !sameIdentity(identity, pointerIdentity(afterPath))) fail(`${kind}_pointer_aba`, `${kind} pointer changed during one read`);
    const pointer = asRecord(parseCanonicalJson(raw, `${kind} pointer`), `${kind} pointer`);
    const hashKey = kind === "head" ? "head_hash" : "selection_hash";
    exactKeys(pointer, ["schema_version", hashKey], `${kind} pointer`);
    const expectedSchema = kind === "head" ? PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_SCHEMA : PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_SCHEMA;
    if (pointer.schema_version !== expectedSchema) fail(`${kind}_pointer_invalid`, `${kind} pointer schema differs`);
    return { file, kind, raw, hash: assertHash(pointer[hashKey], `${kind} pointer hash`), identity };
  } finally {
    fs.closeSync(fd);
  }
}

function verifySecondPointerReads(root: string | undefined, firstHead: VerifiedPointer | undefined, firstSelection: VerifiedPointer | undefined): { code: string; message: string } | null {
  if (!root || !firstHead) return null;
  try {
    const secondHead = readVerifiedPointer(firstHead.file, "head");
    if (!samePointerRead(firstHead, secondHead)) fail("head_pointer_aba", "head pointer changed between the required reads");
  } catch (error) {
    const normalized = normalizeReadError(error);
    return { code: normalized.code === "head_pointer_aba" ? normalized.code : "head_pointer_second_read_failed", message: normalized.message };
  }
  if (!firstSelection) return null;
  try {
    const secondSelection = readVerifiedPointer(firstSelection.file, "selection");
    if (!samePointerRead(firstSelection, secondSelection)) fail("selection_pointer_aba", "selection pointer changed between the required reads");
  } catch (error) {
    const normalized = normalizeReadError(error);
    return { code: normalized.code === "selection_pointer_aba" ? normalized.code : "selection_pointer_second_read_failed", message: normalized.message };
  }
  return null;
}

function samePointerRead(left: VerifiedPointer, right: VerifiedPointer): boolean {
  return left.kind === right.kind && left.raw === right.raw && left.hash === right.hash && sameIdentity(left.identity, right.identity);
}

function pointerIdentity(stat: fs.BigIntStats): PointerIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameIdentity(left: PointerIdentity, right: PointerIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function ensureRelativeDirectory(root: string, relative: string): Promise<string> {
  let current = root;
  for (const component of relative.split("/").filter(Boolean)) {
    current = path.join(current, component);
    await ensureExactDirectory(current);
  }
  return current;
}

async function ensureExactDirectory(directory: string): Promise<void> {
  const existing = lstatIfPresent(directory);
  if (!existing) {
    try {
      await fsp.mkdir(directory, { mode: 0o700 });
      await fsyncDirectory(path.dirname(directory));
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
    }
  }
  exactDirectory(directory, "sandbox CAS directory");
}

function exactDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) fail("path_unsafe", `${label} is not an exact directory`, { resolved });
  return resolved;
}

function readExactRegularFile(file: string, label: string): string {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file) fail("path_unsafe", `${label} is not an exact regular file`, { file });
  return fs.readFileSync(file, "utf8");
}

function assertDirectoryNames(directory: string, expected: readonly string[], label: string): void {
  const names = fs.readdirSync(directory).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (canonicalizeJcs(names) !== canonicalizeJcs(wanted)) fail("cas_foreign_state", `${label} contains missing or foreign entries`, { names, wanted });
}

function assertRootEntriesAllowed(root: string): void {
  for (const forbidden of ["current.json", "current", "latest"]) if (fs.existsSync(path.join(root, forbidden))) fail("secondary_activation_forbidden", "shadow root contains a forbidden compatibility or secondary pointer", { forbidden });
  for (const name of fs.readdirSync(root)) if (!(ROOT_ENTRIES as readonly string[]).includes(name)) fail("cas_foreign_state", "shadow root contains a foreign entry", { name });
  for (const family of ["heads", "selections"] as const) {
    const directory = path.join(root, family);
    if (!fs.existsSync(directory)) continue;
    const allowed = new Set(["current.json", "v1"]);
    for (const name of fs.readdirSync(directory)) {
      if (allowed.has(name)) continue;
      if (["current", "latest", "latest.json"].includes(name)) fail("secondary_activation_forbidden", "control subtree contains a secondary pointer", { family, name });
      fail("cas_foreign_state", "control subtree contains a foreign entry", { family, name });
    }
  }
  for (const relative of ["p2a/v2", "stable/v1"]) {
    const directory = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(directory)) continue;
    const names = fs.readdirSync(directory).sort(compareCodeUnits);
    if (canonicalizeJcs(names) !== canonicalizeJcs(["bundles"])) fail("secondary_activation_forbidden", "artifact CAS root must contain bundles only", { relative, names });
  }
  for (const relative of ["p2a", "stable", "intents"]) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) continue;
    for (const forbidden of ["current.json", "current", "latest"]) if (fs.existsSync(path.join(directory, forbidden))) fail("secondary_activation_forbidden", "non-control subtree contains a secondary activation pointer", { relative, forbidden });
  }
}

function assertExistingAncestorsNoSymlink(target: string): void {
  const root = path.parse(target).root;
  let current = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== target)) fail("sandbox_output_unsafe", "output ancestor is a symlink or non-directory", { current });
  }
}

function validateAudit(value: unknown, at: string): void {
  const audit = asRecord(value, at);
  exactKeys(audit, ["time_fields", "excluded_from_identity", "freshness_gate"], at);
  if (canonicalizeJcs(audit) !== canonicalizeJcs(AUDIT_CONTRACT)) fail("audit_contract_invalid", `${at} differs`);
}

function validateSelfHash(value: Record<string, unknown>, hashField: string, auditField: string, at: string): void {
  const actual = assertHash(value[hashField], `${at} self hash`);
  const base = { ...value };
  delete base[hashField];
  delete base[auditField];
  if (jcsSha256Hex(base) !== actual) fail(`${at.replace(/ /g, "_")}_self_hash`, `${at} self-hash differs`);
}

function identityHash(value: Record<string, unknown>): string {
  const base = { ...value };
  delete base.audit;
  return jcsSha256Hex(base);
}

function transactionId(stagedEvent: unknown, precondition: unknown, expectedPostAppend: unknown): string {
  return jcsSha256Hex({ staged_event: stagedEvent, precondition, expected_post_append: expectedPostAppend });
}

function corpusHash(inputEventCount: number, inputEventIdsHash: string): string {
  return jcsSha256Hex({ input_event_count: inputEventCount, input_event_ids_hash: inputEventIdsHash });
}

function validateHashList(value: unknown, at: string): readonly string[] {
  const list = asArray(value, at).map((item, index) => assertHash(item, `${at}[${index}]`));
  const sorted = [...list].sort(compareCodeUnits);
  if (canonicalizeJcs(list) !== canonicalizeJcs(sorted) || new Set(list).size !== list.length) fail("head_invalid", `${at} must be sorted and unique`);
  return Object.freeze(list);
}

function parseCanonicalJson(raw: string, at: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("json_invalid", `${at} is not valid JSON`); }
  if (`${canonicalizeJcs(parsed)}\n` !== raw) fail("json_noncanonical", `${at} is not exact RFC8785-JCS plus LF`);
  return parsed;
}

function canonicalJson(value: unknown): string {
  return `${canonicalizeJcs(value)}\n`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("shape_invalid", `${at} has unexpected keys`, { actual, wanted });
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("shape_invalid", `${at} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("shape_invalid", `${at} must be an array`);
  return value;
}

function assertHash(value: unknown, at: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail("hash_invalid", `${at} must be lowercase SHA-256`);
  return value;
}

function assertNonNegativeInteger(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("count_invalid", `${at} must be a nonnegative safe integer`);
  return Number(value);
}

function assertPositiveInteger(value: unknown, at: string): number {
  const number = assertNonNegativeInteger(value, at);
  if (number < 1) fail("count_invalid", `${at} must be positive`);
  return number;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function lstatIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) { if (isNodeErrorCode(error, "ENOENT")) return null; throw error; }
}

function normalizeReadError(error: unknown): { code: string; message: string } {
  if (error instanceof PropositionLifecycleFreshnessShadowError) return { code: error.code, message: error.message };
  if (isNodeErrorCode(error, "ENOENT")) return { code: "missing_cas", message: error instanceof Error ? error.message : String(error) };
  return { code: "reader_validation_failed", message: error instanceof Error ? error.message : String(error) };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
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

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionLifecycleFreshnessShadowError(code, message, detail);
}

export const __TEST = Object.freeze({
  auditContract: AUDIT_CONTRACT,
  canonicalJson,
  corpusHash,
  identityHash,
  recoveryContract: RECOVERY_CONTRACT,
  shadowAuthorityConfig: SHADOW_AUTHORITY_CONFIG,
  transactionId,
});
