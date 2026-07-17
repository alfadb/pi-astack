/// <reference types="node" />
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { scanWholeL1Validated } from "./l1-schema-registry";
import { acquireRetainedDirectoryOfdLock, type RetainedDirectoryOfdLock } from "./retained-directory-ofd-lock";
import type { PropositionLifecycleV3Build } from "./proposition-lifecycle-freshness-v3";
import type { D3PubAuthorizationCoordinate, D3PubDossierIdentity } from "./proposition-lifecycle-freshness-production-transcript";

export const D3_PUB_HARD_ABRAIN = "/home/worker/.abrain" as const;
export const D3_PUB_HARD_FAMILY_ROOT = "/home/worker/.abrain/.state/sediment/proposition-lifecycle-freshness" as const;
export const D3_PUB_HARD_ROOT = `${D3_PUB_HARD_FAMILY_ROOT}/v2` as const;
export const D3_PUB_FOREIGN_V1 = `${D3_PUB_HARD_FAMILY_ROOT}/v1` as const;
export const D3_PUB_SOURCE_TRUTH = "canonical_production_l1_direct_scan" as const;
export const D3_PUB_AUTHORITY = "runtime_inert_gen0_publication_only" as const;

export const D3_PUB_SOURCE_SCHEMA = "proposition-lifecycle-freshness-production-source-snapshot/v1" as const;
export const D3_PUB_P2A_WRAPPER_SCHEMA = "proposition-lifecycle-freshness-production-p2a-wrapper/v1" as const;
export const D3_PUB_STABLE_WRAPPER_SCHEMA = "proposition-lifecycle-freshness-production-stable-wrapper/v1" as const;
export const D3_PUB_INTENT_SCHEMA = "proposition-lifecycle-freshness-production-intent/v1" as const;
export const D3_PUB_PROOF_SCHEMA = "proposition-lifecycle-freshness-production-proof/v1" as const;
export const D3_PUB_HEAD_SCHEMA = "proposition-lifecycle-freshness-production-head/v1" as const;
export const D3_PUB_SELECTION_SCHEMA = "proposition-lifecycle-freshness-production-selection/v1" as const;
export const D3_PUB_HEAD_POINTER_SCHEMA = "proposition-lifecycle-freshness-production-head-pointer/v1" as const;
export const D3_PUB_SELECTION_POINTER_SCHEMA = "proposition-lifecycle-freshness-production-selection-pointer/v1" as const;
export const D3_PUB_PLAN_SCHEMA = "adr0040-d3-pub-static-publication-plan/v1" as const;
export const D3_PUB_PROTECTED_SCHEMA = "proposition-lifecycle-freshness-production-protected-prestate/v1" as const;

const HASH = /^[0-9a-f]{64}$/;
const EVENT_FILE = /^[0-9a-f]{64}\.json$/;
const REQUIRED_DIRECTORIES = Object.freeze([
  "heads", "heads/v1", "intents", "intents/v1", "p2a", "p2a/v1", "p2a/v1/bundles",
  "proofs", "proofs/v1", "selections", "selections/v1", "stable", "stable/v1", "stable/v1/bundles",
] as const);
const ALLOWED_ROOT_TOP = Object.freeze(["heads", "intents", "p2a", "proofs", "selections", "stable"] as const);
const P2A_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "source-manifest.v2.json", "manifest.json"] as const);
const STABLE_NAMES = Object.freeze(["compile-profile.json", "diagnostics.json", "parity.json", "source-manifest.v2.json", "view.json", "view.md", "manifest.json"] as const);
const AUDIT = deepFreeze({ time_fields: "external_audit_only", excluded_from_identity: true });

type Json = Readonly<Record<string, unknown>>;
type CrashPoint = "after_intent" | "after_artifacts" | "after_proof" | "after_head" | "after_head_pointer" | "after_selection" | null;

export interface ProductionSourceRow {
  event_id: string;
  relative_path: string;
  bytes: number;
  raw_sha256: string;
  raw: string;
}

export interface ProductionSourceSnapshot extends Record<string, unknown> {
  schema_version: typeof D3_PUB_SOURCE_SCHEMA;
  source_truth: typeof D3_PUB_SOURCE_TRUTH;
  input_event_count: number;
  input_event_ids: readonly string[];
  input_event_ids_hash: string;
  rows: readonly ProductionSourceRow[];
  rows_hash: string;
  snapshot_hash: string;
}

export interface ProductionArtifactBundle extends Record<string, unknown> {
  family: "p2a" | "stable";
  schema_version: typeof D3_PUB_P2A_WRAPPER_SCHEMA | typeof D3_PUB_STABLE_WRAPPER_SCHEMA;
  bundle_hash: string;
  artifacts: Readonly<Record<string, string>>;
}

export interface ProductionArtifactSet extends Record<string, unknown> {
  schema_version: "proposition-lifecycle-freshness-production-frozen-artifact-set/v1";
  source_snapshot_hash: string;
  p2a: ProductionArtifactBundle;
  stable: ProductionArtifactBundle;
  counts: Readonly<Record<string, number>>;
  artifact_set_hash: string;
}

export interface ProtectedPrestate extends Record<string, unknown> {
  schema_version: typeof D3_PUB_PROTECTED_SCHEMA;
  roots: readonly string[];
  rows: readonly Readonly<Record<string, unknown>>[];
  row_count: number;
  snapshot_hash: string;
}

export interface D3PubStaticPlan extends Record<string, unknown> {
  schema_version: typeof D3_PUB_PLAN_SCHEMA;
  target: Json;
  source: ProductionSourceSnapshot;
  artifacts: ProductionArtifactSet;
  source_capsule: Json;
  protected_prestate: ProtectedPrestate;
  configuration_prestate: ProtectedPrestate;
  target_prestate: ProtectedPrestate;
  generation: number;
  predecessor_head_hash: string | null;
  selection_seq: 0;
  execution_status: "ready" | "blocked_selection_exists";
  mutation_contract: Json;
  plan_hash: string;
}

export interface D3PubExecutionResult extends Record<string, unknown> {
  status: "published" | "identical" | "BUSY";
  intent_hash?: string;
  proof_hash?: string;
  head_hash?: string;
  selection_hash?: string;
  generation?: number;
  selection_seq?: 0;
  mutation_inventory_hash?: string;
}

export class D3PubProductionError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "D3PubProductionError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function captureCanonicalProductionPropositionSource(abrainHomeInput: string): Promise<ProductionSourceSnapshot> {
  const abrainHome = exactDirectory(abrainHomeInput, "L1 scan root");
  const scan = await scanWholeL1Validated({ abrainHome });
  const rows: ProductionSourceRow[] = [];
  for (const record of scan.all) {
    if (record.registration.domain !== "proposition") continue;
    const relative = String(record.relativePath);
    const file = path.join(abrainHome, ...relative.split("/"));
    const raw = readExactRegular(file, `proposition source ${record.eventId}`);
    rows.push({ event_id: String(record.eventId), relative_path: relative, bytes: raw.length, raw_sha256: sha256Hex(raw), raw: raw.toString("utf8") });
  }
  return buildProductionSourceSnapshot(rows);
}

export function buildProductionSourceSnapshot(rowsInput: readonly ProductionSourceRow[]): ProductionSourceSnapshot {
  const rows = [...rowsInput].map((row) => ({ ...row })).sort((left, right) => compare(left.event_id, right.event_id));
  let previous = "";
  for (const [index, row] of rows.entries()) {
    assertHash(row.event_id, `source row ${index} event_id`); assertHash(row.raw_sha256, `source row ${index} raw_sha256`);
    if (row.relative_path !== eventRelativePath(row.event_id) || typeof row.raw !== "string" || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || Buffer.byteLength(row.raw) !== row.bytes || sha256Hex(row.raw) !== row.raw_sha256 || (previous && compare(previous, row.event_id) >= 0)) fail("D3_PUB_SOURCE_INVALID", "source row path/raw-bytes/hash/order differs", { index });
    previous = row.event_id;
  }
  const ids = rows.map((row) => row.event_id);
  const base = {
    schema_version: D3_PUB_SOURCE_SCHEMA,
    source_truth: D3_PUB_SOURCE_TRUTH,
    input_event_count: rows.length,
    input_event_ids: ids,
    input_event_ids_hash: jcsSha256Hex(ids),
    rows,
    rows_hash: jcsSha256Hex(rows),
  };
  return deepFreeze({ ...base, snapshot_hash: jcsSha256Hex(base) });
}

export function validateProductionSourceSnapshot(value: unknown): ProductionSourceSnapshot {
  const source = asRecord(value, "production source snapshot") as ProductionSourceSnapshot;
  const rebuilt = buildProductionSourceSnapshot(source.rows);
  if (canonicalizeJcs(rebuilt) !== canonicalizeJcs(source)) fail("D3_PUB_SOURCE_INVALID", "source snapshot differs from canonical reconstruction");
  return deepFreeze(source);
}

/** Rewraps existing projector/compiler output; no business algorithm is copied here. */
export function buildProductionGen0ArtifactSet(options: {
  build: PropositionLifecycleV3Build;
  source: ProductionSourceSnapshot;
  sourceClosureHash: string;
}): ProductionArtifactSet {
  const source = validateProductionSourceSnapshot(options.source);
  assertHash(options.sourceClosureHash, "source closure hash");
  const v3 = options.build;
  const p2aV2 = v3.p2a.source_bundle_v2;
  const stableV2 = v3.stable.source_bundle_v2;
  const p2aWithoutManifest: Record<string, string> = {
    "diagnostics.json": p2aV2.bytes["diagnostics.json"],
    "entries.json": p2aV2.bytes["entries.json"],
    "exclusions.json": p2aV2.bytes["exclusions.json"],
    "source-manifest.v2.json": p2aV2.bytes["manifest.json"],
  };
  const p2aRows = Object.keys(p2aWithoutManifest).sort(compare).map((name) => artifactRow(name, p2aWithoutManifest[name]!));
  const p2aManifestBase = {
    schema_version: D3_PUB_P2A_WRAPPER_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    authority: D3_PUB_AUTHORITY,
    source_truth: D3_PUB_SOURCE_TRUTH,
    source_snapshot: source,
    source_closure_hash: options.sourceClosureHash,
    projector_api: "buildPropositionPolicyPushShadow",
    source_manifest_schema: String(p2aV2.manifest.schema_version),
    source_bundle_hash: String(p2aV2.manifest.bundle_hash),
    artifact_rows: p2aRows,
    result: p2aV2.manifest.result,
  };
  const p2aHash = jcsSha256Hex(p2aManifestBase);
  const p2aArtifacts = deepFreeze({ ...p2aWithoutManifest, "manifest.json": canonicalJson({ ...p2aManifestBase, bundle_hash: p2aHash }) });
  const p2a = deepFreeze({ family: "p2a", schema_version: D3_PUB_P2A_WRAPPER_SCHEMA, bundle_hash: p2aHash, artifacts: p2aArtifacts }) as ProductionArtifactBundle;

  const stableWithoutManifest: Record<string, string> = {
    "compile-profile.json": v3.stable.artifacts["compile-profile.json"],
    "diagnostics.json": stableV2.artifacts["diagnostics.json"],
    "parity.json": stableV2.artifacts["parity.json"],
    "source-manifest.v2.json": stableV2.artifacts["manifest.json"],
    "view.json": stableV2.artifacts["view.json"],
    "view.md": stableV2.artifacts["view.md"],
  };
  const stableRows = Object.keys(stableWithoutManifest).sort(compare).map((name) => artifactRow(name, stableWithoutManifest[name]!));
  const view = asRecord(JSON.parse(stableWithoutManifest["view.json"]!), "stable view");
  const items = asArray(view.items, "stable view items");
  const stableManifestBase = {
    schema_version: D3_PUB_STABLE_WRAPPER_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    authority: D3_PUB_AUTHORITY,
    source_truth: D3_PUB_SOURCE_TRUTH,
    source_snapshot: source,
    source_closure_hash: options.sourceClosureHash,
    compiler_api: "buildPropositionPolicyStableViewBundle",
    source_manifest_schema: String(stableV2.manifest.schema_version),
    source_bundle_hash: String(stableV2.bundle_hash),
    source_p2a_wrapper_hash: p2aHash,
    compile_profile: artifactRow("compile-profile.json", stableWithoutManifest["compile-profile.json"]!),
    render: artifactRow("view.md", stableWithoutManifest["view.md"]!),
    artifact_rows: stableRows,
    result: { item_count: items.length, result_kind: asRecord(stableV2.manifest.stable_view, "stable manifest view").result_kind },
  };
  const stableHash = jcsSha256Hex(stableManifestBase);
  const stableArtifacts = deepFreeze({ ...stableWithoutManifest, "manifest.json": canonicalJson({ ...stableManifestBase, bundle_hash: stableHash }) });
  const stable = deepFreeze({ family: "stable", schema_version: D3_PUB_STABLE_WRAPPER_SCHEMA, bundle_hash: stableHash, artifacts: stableArtifacts }) as ProductionArtifactBundle;
  const counts = deepFreeze({
    input_events: source.input_event_count,
    candidates: Number(asRecord(p2aV2.manifest.result, "P2a result").entry_count),
    stable_items: items.length,
  });
  const base = { schema_version: "proposition-lifecycle-freshness-production-frozen-artifact-set/v1" as const, source_snapshot_hash: source.snapshot_hash, p2a, stable, counts };
  const set = deepFreeze({ ...base, artifact_set_hash: jcsSha256Hex(base) });
  validateProductionArtifactSet(set);
  return set;
}

export function validateProductionArtifactSet(value: unknown): ProductionArtifactSet {
  const set = asRecord(value, "production artifact set") as ProductionArtifactSet;
  if (set.schema_version !== "proposition-lifecycle-freshness-production-frozen-artifact-set/v1") fail("D3_PUB_ARTIFACT_INVALID", "artifact set schema differs");
  validateProductionArtifactBundle(set.p2a, "p2a"); validateProductionArtifactBundle(set.stable, "stable");
  const p2aManifest = asRecord(JSON.parse(set.p2a.artifacts["manifest.json"]!), "P2a wrapper");
  const stableManifest = asRecord(JSON.parse(set.stable.artifacts["manifest.json"]!), "stable wrapper");
  if (set.source_snapshot_hash !== asRecord(p2aManifest.source_snapshot, "P2a wrapper source").snapshot_hash
    || set.source_snapshot_hash !== asRecord(stableManifest.source_snapshot, "stable wrapper source").snapshot_hash
    || stableManifest.source_p2a_wrapper_hash !== set.p2a.bundle_hash) fail("D3_PUB_ARTIFACT_SOURCE_MISMATCH", "artifact wrappers do not share source/P2a identity");
  const base = { ...set } as Record<string, unknown>; delete base.artifact_set_hash;
  if (set.artifact_set_hash !== jcsSha256Hex(base)) fail("D3_PUB_ARTIFACT_INVALID", "artifact set self hash differs");
  return deepFreeze(set);
}

export function captureProtectedPrestate(pathsInput: readonly string[]): ProtectedPrestate {
  const roots = [...new Set(pathsInput.map((item) => path.resolve(item)))].sort(compare);
  const rows: Record<string, unknown>[] = [];
  for (const root of roots) capturePathRows(root, root, rows);
  rows.sort((left, right) => compare(String(left.path), String(right.path)));
  const frozen = deepFreeze(rows);
  return deepFreeze({ schema_version: D3_PUB_PROTECTED_SCHEMA, roots, rows: frozen, row_count: frozen.length, snapshot_hash: jcsSha256Hex(frozen) });
}

export function validateProtectedPrestate(value: unknown): ProtectedPrestate {
  const snapshot = asRecord(value, "protected prestate") as ProtectedPrestate;
  if (snapshot.schema_version !== D3_PUB_PROTECTED_SCHEMA || !Array.isArray(snapshot.roots) || !Array.isArray(snapshot.rows) || snapshot.row_count !== snapshot.rows.length || snapshot.snapshot_hash !== jcsSha256Hex(snapshot.rows)) fail("D3_PUB_PROTECTED_INVALID", "protected prestate identity differs");
  return deepFreeze(snapshot);
}

export function buildD3PubStaticPlan(options: {
  targetRoot: string;
  source: ProductionSourceSnapshot;
  artifacts: ProductionArtifactSet;
  sourceCapsule: Readonly<Record<string, unknown>>;
  protectedPaths: readonly string[];
  configurationPaths: readonly string[];
}): D3PubStaticPlan {
  const targetRoot = path.resolve(options.targetRoot);
  const familyRoot = path.dirname(targetRoot);
  const foreignV1 = path.join(familyRoot, "v1");
  if (lstatMaybe(foreignV1)) fail("D3_PUB_FOREIGN_V1", "v1 freshness root is foreign residue", { foreignV1 });
  const source = validateProductionSourceSnapshot(options.source);
  const artifacts = validateProductionArtifactSet(options.artifacts);
  if (artifacts.source_snapshot_hash !== source.snapshot_hash) fail("D3_PUB_PLAN_SOURCE_MISMATCH", "frozen artifacts differ from direct source snapshot");
  const targetPrestate = captureProtectedPrestate([familyRoot, targetRoot]);
  const state = inspectTargetState(targetRoot);
  const base = {
    schema_version: D3_PUB_PLAN_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    artifact_nature: "frozen_execution_ready_pre_authorization_read_only_preview",
    target: {
      root: targetRoot,
      family_root: familyRoot,
      foreign_v1: foreignV1,
      only_mutable_pointers: ["heads/current.json", "selections/current.json"],
      root_current_forbidden: true,
      artifact_latest_current_fallback_forbidden: true,
      runtime_consumer: false,
      authority: D3_PUB_AUTHORITY,
    },
    source,
    artifacts,
    source_capsule: options.sourceCapsule,
    protected_prestate: captureProtectedPrestate(options.protectedPaths),
    configuration_prestate: captureProtectedPrestate(options.configurationPaths),
    target_prestate: targetPrestate,
    generation: state.generation,
    predecessor_head_hash: state.predecessor_head_hash,
    selection_seq: 0 as const,
    execution_status: state.selection_exists ? "blocked_selection_exists" as const : "ready" as const,
    mutation_contract: {
      dag: ["intent", "proof", "committed_head", "selection"],
      no_stage_or_append: true,
      exact_inventory_generated_and_bound_by_proof: true,
      self_referential_json_rows_use_identity_hash_cycle_break: true,
      proof_create_operation: "immutable_intent_keyed_create_no_replace",
      proof_path_is_intent_keyed_not_content_addressed_cas: true,
      transient_policy: "deterministic same-directory temp; no foreign temp accepted",
      recovery: "same intent exact expected CAS subset only",
      supersession: "fresh dossier plus fresh grant; no head pointer means gen0; existing head without selection means generation plus one; first selection remains seq0",
      selection_exists_supersession_forbidden: true,
      delete_rewind_ttl_mtime_abort_forbidden: true,
    },
  };
  return deepFreeze({ ...base, plan_hash: jcsSha256Hex(base) }) as D3PubStaticPlan;
}

export function validateD3PubStaticPlan(value: unknown): D3PubStaticPlan {
  const plan = asRecord(value, "D3-PUB static plan") as D3PubStaticPlan;
  if (plan.schema_version !== D3_PUB_PLAN_SCHEMA || asRecord(plan.target, "plan target").authority !== D3_PUB_AUTHORITY || asRecord(plan.target, "plan target").runtime_consumer !== false || plan.selection_seq !== 0) fail("D3_PUB_PLAN_INVALID", "plan identity or authority differs");
  validateProductionSourceSnapshot(plan.source); validateProductionArtifactSet(plan.artifacts); validateProtectedPrestate(plan.protected_prestate); validateProtectedPrestate(plan.configuration_prestate); validateProtectedPrestate(plan.target_prestate);
  const base = { ...plan } as Record<string, unknown>; delete base.plan_hash;
  if (plan.plan_hash !== jcsSha256Hex(base)) fail("D3_PUB_PLAN_INVALID", "plan self hash differs");
  return deepFreeze(plan);
}

export async function executeD3PubSandboxPublication(options: {
  plan: D3PubStaticPlan;
  abrainHome: string;
  targetRoot: string;
  authorization: D3PubAuthorizationCoordinate;
  dossier: D3PubDossierIdentity;
  protectedPaths: readonly string[];
  configurationPaths: readonly string[];
  crashAfter?: CrashPoint;
  hooks?: { afterIntent?: () => void; beforeCpost?: () => void };
}): Promise<D3PubExecutionResult> {
  const targetRoot = assertSandboxTarget(options.targetRoot);
  const abrainHome = assertSandboxAbrain(options.abrainHome, targetRoot);
  return executePublication({ ...options, targetRoot, abrainHome, mode: "sandbox_test" });
}

/** Official production callers must first validate a trusted transcript and capsule. Never call this from preview. */
export async function executeD3PubProductionPublication(options: {
  plan: D3PubStaticPlan;
  authorization: D3PubAuthorizationCoordinate;
  dossier: D3PubDossierIdentity;
  protectedPaths: readonly string[];
  configurationPaths: readonly string[];
  trustedTranscriptVerified: true;
}): Promise<D3PubExecutionResult> {
  if (options.trustedTranscriptVerified !== true) fail("D3_PUB_FRESH_RATIFICATION_REQUIRED", "production publisher requires trusted transcript verification");
  const plan = validateD3PubStaticPlan(options.plan);
  const target = asRecord(plan.target, "production plan target");
  if (target.root !== D3_PUB_HARD_ROOT || target.foreign_v1 !== D3_PUB_FOREIGN_V1) fail("D3_PUB_PRODUCTION_TARGET_INVALID", "production plan does not name the one hard root");
  return executePublication({ ...options, plan, targetRoot: D3_PUB_HARD_ROOT, abrainHome: D3_PUB_HARD_ABRAIN, mode: "production" });
}

export function readPublishedD3PubSelection(targetRootInput: string): Readonly<Record<string, unknown>> {
  const root = exactDirectory(targetRootInput, "D3-PUB root");
  const hp = readPointer(root, "head"); const sp = readPointer(root, "selection");
  if (!hp || !sp) fail("D3_PUB_NOT_PUBLISHED", "both head and selection pointers are required");
  const head = readCas(root, `heads/v1/${hp.hash}.json`, "head_hash", hp.hash, validateHead);
  const selection = readCas(root, `selections/v1/${sp.hash}.json`, "selection_hash", sp.hash, validateSelection);
  if (selection.committed_head_hash !== head.head_hash || selection.proof_hash !== head.proof_hash) fail("D3_PUB_CLOSURE_INVALID", "selection/head proof references differ");
  const proof = readCas(root, `proofs/v1/${String(head.intent_hash)}.json`, "proof_hash", String(head.proof_hash), validateProof);
  const intent = readCas(root, `intents/v1/${String(head.intent_hash)}.json`, "intent_hash", String(head.intent_hash), validateD3PubIntent);
  if (proof.intent_hash !== head.intent_hash || intent.intent_hash !== head.intent_hash || proof.predicted_head_preimage_hash !== head.head_hash || proof.mutation_inventory_hash !== selection.mutation_inventory_hash) fail("D3_PUB_CLOSURE_INVALID", "intent/proof/head/selection closure differs");
  const artifactClosure = validateArtifactClosure(root, selection);
  const proofArtifacts = validateProductionArtifactSet(proof.artifact_set);
  const proofSource = validateProductionSourceSnapshot(proof.source_snapshot);
  if (proofArtifacts.artifact_set_hash !== head.artifact_set_hash || proofArtifacts.p2a.bundle_hash !== artifactClosure.p2a.bundle_hash || proofArtifacts.stable.bundle_hash !== artifactClosure.stable.bundle_hash || proofSource.snapshot_hash !== head.source_snapshot_hash) fail("D3_PUB_CLOSURE_INVALID", "proof source/artifact bytes differ from selected head and bundles");
  return deepFreeze({ head_pointer: hp, selection_pointer: sp, intent, head, proof, selection, artifact_closure: artifactClosure });
}

async function executePublication(options: {
  plan: D3PubStaticPlan;
  abrainHome: string;
  targetRoot: string;
  authorization: D3PubAuthorizationCoordinate;
  dossier: D3PubDossierIdentity;
  protectedPaths: readonly string[];
  configurationPaths: readonly string[];
  mode: "production" | "sandbox_test";
  crashAfter?: CrashPoint;
  hooks?: { afterIntent?: () => void; beforeCpost?: () => void };
}): Promise<D3PubExecutionResult> {
  const plan = validateD3PubStaticPlan(options.plan);
  validateAuthorizationBinding(options.authorization, options.dossier);
  if (plan.execution_status !== "ready") fail("D3_PUB_SELECTION_EXISTS_SUPERSESSION_FORBIDDEN", "this gate cannot supersede an existing selection");
  const target = asRecord(plan.target, "plan target");
  if (target.root !== options.targetRoot) fail("D3_PUB_TARGET_PLAN_MISMATCH", "execution target differs from frozen plan");
  const familyRoot = path.dirname(options.targetRoot);
  const foreignV1 = path.join(familyRoot, "v1");
  if (lstatMaybe(foreignV1)) fail("D3_PUB_FOREIGN_V1", "v1 freshness root is foreign residue");
  const sediment = exactDirectory(path.dirname(familyRoot), "sediment parent");
  const parentLock = acquireRetainedDirectoryOfdLock(sediment);
  if (parentLock.status === "BUSY") return { status: "BUSY" };
  let childLock: RetainedDirectoryOfdLock | null = null;
  try {
    assertLockNamed(parentLock, sediment);
    ensureChildRoot(parentLock, familyRoot, options.targetRoot);
    childLock = acquireRetainedDirectoryOfdLock(options.targetRoot);
    if (childLock.status === "BUSY") return { status: "BUSY" };
    assertLockNamed(childLock, options.targetRoot);
    ensureRootLayout(childLock);
    assertRootSurface(options.targetRoot);
    const result = await executeUnderLocks({ ...options, plan, parentLock, childLock });
    assertLockNamed(childLock, options.targetRoot); assertLockNamed(parentLock, sediment);
    return result;
  } finally { childLock?.close(); parentLock.close(); }
}

async function executeUnderLocks(options: {
  plan: D3PubStaticPlan;
  abrainHome: string;
  targetRoot: string;
  authorization: D3PubAuthorizationCoordinate;
  dossier: D3PubDossierIdentity;
  protectedPaths: readonly string[];
  configurationPaths: readonly string[];
  mode: "production" | "sandbox_test";
  crashAfter?: CrashPoint;
  hooks?: { afterIntent?: () => void; beforeCpost?: () => void };
  parentLock: RetainedDirectoryOfdLock;
  childLock: RetainedDirectoryOfdLock;
}): Promise<D3PubExecutionResult> {
  const plan = options.plan;
  const currentSelection = readPointer(options.targetRoot, "selection");
  if (currentSelection) {
    const published = readPublishedD3PubSelection(options.targetRoot);
    const selection = asRecord(published.selection, "published selection");
    if (selection.plan_hash === plan.plan_hash && selection.authorization_coordinate_hash === options.authorization.coordinate_hash) return { status: "identical", intent_hash: String(selection.intent_hash), proof_hash: String(selection.proof_hash), head_hash: String(selection.committed_head_hash), selection_hash: String(selection.selection_hash), generation: Number(selection.generation), selection_seq: 0, mutation_inventory_hash: String(selection.mutation_inventory_hash) };
    fail("D3_PUB_SELECTION_EXISTS_SUPERSESSION_FORBIDDEN", "selection already exists and this gate cannot supersede it");
  }
  const C0 = await revalidateStage("C0", options);
  const currentHeadPointer = readPointer(options.targetRoot, "head");
  const predecessorRaw = plan.predecessor_head_hash === null ? null : pointerRaw("head", plan.predecessor_head_hash);
  if (plan.predecessor_head_hash !== null) {
    const previous = readCas(options.targetRoot, `heads/v1/${plan.predecessor_head_hash}.json`, "head_hash", plan.predecessor_head_hash, validateHead);
    if (Number(previous.generation) + 1 !== plan.generation) fail("D3_PUB_PREDECESSOR_DRIFT", "generation is not predecessor plus one");
  } else if (plan.generation !== 0) fail("D3_PUB_PREDECESSOR_DRIFT", "generation without predecessor must be zero");

  const intentBase = {
    schema_version: D3_PUB_INTENT_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    authority: D3_PUB_AUTHORITY,
    plan_hash: plan.plan_hash,
    dossier: options.dossier,
    authorization_coordinate: options.authorization,
    source_snapshot_hash: plan.source.snapshot_hash,
    artifact_set_hash: plan.artifacts.artifact_set_hash,
    generation: plan.generation,
    predecessor_head_hash: plan.predecessor_head_hash,
    selection_seq: 0,
    protected_prestate_hash: plan.protected_prestate.snapshot_hash,
    configuration_prestate_hash: plan.configuration_prestate.snapshot_hash,
    C0,
    recovery: { exact_same_intent_only: true, exact_expected_cas_subset_only: true, no_delete_rewind_ttl_mtime_abort: true },
    audit: AUDIT,
  };
  const intent = identityObject(intentBase, "intent_hash", ["audit"]);
  const intentRaw = canonicalJson(intent);
  const intentRelative = `intents/v1/${String(intent.intent_hash)}.json`;
  if ((currentHeadPointer?.hash ?? null) !== plan.predecessor_head_hash) {
    if (!currentHeadPointer) fail("D3_PUB_PREDECESSOR_DRIFT", "head pointer was removed after preview");
    const recoveryHead = readCas(options.targetRoot, `heads/v1/${currentHeadPointer.hash}.json`, "head_hash", currentHeadPointer.hash, validateHead);
    if (recoveryHead.intent_hash !== intent.intent_hash || recoveryHead.generation !== plan.generation || recoveryHead.predecessor_head_hash !== plan.predecessor_head_hash) fail("D3_PUB_PREDECESSOR_DRIFT", "head pointer is neither the frozen predecessor nor this exact intent successor");
  }
  const expected = expectedRecords(options.targetRoot, plan, intent, intentRaw);
  validateRootAsPlanOrExpectedSubset(options.targetRoot, plan.target_prestate, expected, { allowSameIntentResidue: String(intent.intent_hash) });
  durableCasCreate(options.targetRoot, intentRelative, intentRaw);
  options.hooks?.afterIntent?.();
  injected(options.crashAfter, "after_intent", { intent_hash: intent.intent_hash });

  const C1 = await revalidateStage("C1", options);
  writeArtifactSet(options.targetRoot, plan.artifacts);
  injected(options.crashAfter, "after_artifacts", { intent_hash: intent.intent_hash });
  const Ccommit = await revalidateStage("Ccommit", options);

  const predictedHeadPreimage = {
    schema_version: D3_PUB_HEAD_SCHEMA,
    authority: D3_PUB_AUTHORITY,
    generation: plan.generation,
    predecessor_head_hash: plan.predecessor_head_hash,
    intent_hash: intent.intent_hash,
    source_snapshot_hash: plan.source.snapshot_hash,
    artifact_set_hash: plan.artifacts.artifact_set_hash,
    p2a_bundle_hash: plan.artifacts.p2a.bundle_hash,
    stable_bundle_hash: plan.artifacts.stable.bundle_hash,
    state: "committed",
  };
  const headHash = jcsSha256Hex(predictedHeadPreimage);
  const selectionPreimage = {
    schema_version: D3_PUB_SELECTION_SCHEMA,
    authority: D3_PUB_AUTHORITY,
    generation: plan.generation,
    seq: 0,
    predecessor_selection_hash: null,
    committed_head_hash: headHash,
    intent_hash: intent.intent_hash,
    plan_hash: plan.plan_hash,
    authorization_coordinate_hash: options.authorization.coordinate_hash,
    p2a_bundle_hash: plan.artifacts.p2a.bundle_hash,
    stable_bundle_hash: plan.artifacts.stable.bundle_hash,
  };
  const selectionHash = jcsSha256Hex(selectionPreimage);
  const inventoryPreimage = buildMutationInventoryPreimage({ root: options.targetRoot, plan, intent, intentRaw, headHash, selectionHash, predecessorRaw });
  const mutationInventoryHash = jcsSha256Hex(inventoryPreimage);
  const proofBase = {
    schema_version: D3_PUB_PROOF_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    authority: D3_PUB_AUTHORITY,
    intent_hash: intent.intent_hash,
    plan_hash: plan.plan_hash,
    predicted_head_preimage: predictedHeadPreimage,
    predicted_head_preimage_hash: headHash,
    source_snapshot: plan.source,
    artifact_set: plan.artifacts,
    source_capsule: plan.source_capsule,
    protected_prestate: plan.protected_prestate,
    configuration_prestate: plan.configuration_prestate,
    mutation_inventory: inventoryPreimage,
    mutation_inventory_hash: mutationInventoryHash,
    authorization_coordinate: options.authorization,
    checkpoints: { C0, C1, Ccommit },
    audit: AUDIT,
  };
  const proof = identityObject(proofBase, "proof_hash", ["audit"]);
  const proofRaw = canonicalJson(proof);
  durableCasCreate(options.targetRoot, `proofs/v1/${String(intent.intent_hash)}.json`, proofRaw);
  injected(options.crashAfter, "after_proof", { intent_hash: intent.intent_hash, proof_hash: proof.proof_hash });

  const head = deepFreeze({ ...predictedHeadPreimage, canonicalization: "RFC8785-JCS", hash_algorithm: "sha256", proof_hash: proof.proof_hash, mutation_inventory_hash: mutationInventoryHash, head_hash: headHash, audit: AUDIT });
  validateHead(head);
  const headRaw = canonicalJson(head);
  expected.set(`proofs/v1/${String(intent.intent_hash)}.json`, proofRaw);
  expected.set(`heads/v1/${headHash}.json`, headRaw);
  validateRootAsPlanOrExpectedSubset(options.targetRoot, plan.target_prestate, expected, { allowSameIntentResidue: String(intent.intent_hash) });
  durableCasCreate(options.targetRoot, `heads/v1/${headHash}.json`, headRaw);
  injected(options.crashAfter, "after_head", { intent_hash: intent.intent_hash, proof_hash: proof.proof_hash, head_hash: headHash });
  advancePointer(options.targetRoot, "head", predecessorRaw, headHash);
  injected(options.crashAfter, "after_head_pointer", { intent_hash: intent.intent_hash, proof_hash: proof.proof_hash, head_hash: headHash });

  options.hooks?.beforeCpost?.();
  const Cpost = await revalidateStage("Cpost", options);
  const selection = deepFreeze({ ...selectionPreimage, canonicalization: "RFC8785-JCS", hash_algorithm: "sha256", proof_hash: proof.proof_hash, mutation_inventory_hash: mutationInventoryHash, Cpost, selection_hash: selectionHash, audit: AUDIT });
  validateSelection(selection);
  const selectionRaw = canonicalJson(selection);
  expected.set(`selections/v1/${selectionHash}.json`, selectionRaw);
  validateRootAsPlanOrExpectedSubset(options.targetRoot, plan.target_prestate, expected);
  durableCasCreate(options.targetRoot, `selections/v1/${selectionHash}.json`, selectionRaw);
  injected(options.crashAfter, "after_selection", { intent_hash: intent.intent_hash, proof_hash: proof.proof_hash, head_hash: headHash, selection_hash: selectionHash });
  advancePointer(options.targetRoot, "selection", null, selectionHash);
  const published = readPublishedD3PubSelection(options.targetRoot);
  const readSelection = asRecord(published.selection, "published selection");
  if (readSelection.selection_hash !== selectionHash) fail("D3_PUB_READBACK_FAILED", "published selection readback differs");
  return deepFreeze({ status: "published", intent_hash: String(intent.intent_hash), proof_hash: String(proof.proof_hash), head_hash: headHash, selection_hash: selectionHash, generation: plan.generation, selection_seq: 0, mutation_inventory_hash: mutationInventoryHash });
}

async function revalidateStage(name: "C0" | "C1" | "Ccommit" | "Cpost", options: {
  plan: D3PubStaticPlan;
  abrainHome: string;
  protectedPaths: readonly string[];
  configurationPaths: readonly string[];
}): Promise<Json> {
  const source = await captureCanonicalProductionPropositionSource(options.abrainHome);
  const protectedState = captureProtectedPrestate(options.protectedPaths);
  const configState = captureProtectedPrestate(options.configurationPaths);
  if (canonicalizeJcs(source) !== canonicalizeJcs(options.plan.source)) fail("D3_PUB_SOURCE_DRIFT", `${name} production source differs from frozen dossier`, { expected: options.plan.source.snapshot_hash, actual: source.snapshot_hash });
  if (canonicalizeJcs(protectedState) !== canonicalizeJcs(options.plan.protected_prestate)) fail("D3_PUB_PROTECTED_DRIFT", `${name} protected prestate differs from frozen dossier`, { expected: options.plan.protected_prestate.snapshot_hash, actual: protectedState.snapshot_hash });
  if (canonicalizeJcs(configState) !== canonicalizeJcs(options.plan.configuration_prestate)) fail("D3_PUB_CONFIGURATION_DRIFT", `${name} configuration prestate differs from frozen dossier`, { expected: options.plan.configuration_prestate.snapshot_hash, actual: configState.snapshot_hash });
  return deepFreeze({ checkpoint: name, source_snapshot_hash: source.snapshot_hash, protected_prestate_hash: protectedState.snapshot_hash, configuration_prestate_hash: configState.snapshot_hash });
}

function buildMutationInventoryPreimage(options: {
  root: string;
  plan: D3PubStaticPlan;
  intent: Json;
  intentRaw: string;
  headHash: string;
  selectionHash: string;
  predecessorRaw: string | null;
}): Json {
  const rows: Record<string, unknown>[] = [];
  const family = path.dirname(options.root);
  const directoryPaths = [
    family,
    options.root,
    ...REQUIRED_DIRECTORIES.map((relative) => path.join(options.root, ...relative.split("/"))),
    path.join(options.root, "p2a/v1/bundles", options.plan.artifacts.p2a.bundle_hash),
    path.join(options.root, "stable/v1/bundles", options.plan.artifacts.stable.bundle_hash),
  ];
  for (const absolute of directoryPaths) rows.push(mutationRow(absolute, "mkdir_no_replace", plannedPreBytesHash(options.plan.target_prestate, absolute), directoryIdentityHash(absolute), null));
  const intentPath = path.join(options.root, "intents/v1", `${String(options.intent.intent_hash)}.json`);
  rows.push(mutationRow(intentPath, "cas_create_no_replace", plannedPreBytesHash(options.plan.target_prestate, intentPath), sha256Hex(options.intentRaw), null));
  for (const bundle of [options.plan.artifacts.p2a, options.plan.artifacts.stable]) {
    for (const [name, raw] of Object.entries(bundle.artifacts).sort(([left], [right]) => compare(left, right))) {
      const artifactPath = path.join(options.root, bundle.family, "v1/bundles", bundle.bundle_hash, name);
      rows.push(mutationRow(artifactPath, "cas_create_no_replace", plannedPreBytesHash(options.plan.target_prestate, artifactPath), sha256Hex(raw), null));
    }
  }
  const proofPath = path.join(options.root, "proofs/v1", `${String(options.intent.intent_hash)}.json`);
  rows.push(mutationRow(proofPath, "immutable_intent_keyed_create_no_replace", plannedPreBytesHash(options.plan.target_prestate, proofPath), null, "proof_hash validates content while the immutable filename is keyed by intent_hash to break the self-reference cycle"));
  const headPath = path.join(options.root, "heads/v1", `${options.headHash}.json`);
  rows.push(mutationRow(headPath, "cas_create_no_replace", plannedPreBytesHash(options.plan.target_prestate, headPath), null, `head identity ${options.headHash}; raw binds proof identity after proof creation`));
  rows.push(mutationRow(path.join(options.root, "heads/current.json"), "atomic_pointer_replace", options.predecessorRaw === null ? null : sha256Hex(options.predecessorRaw), sha256Hex(pointerRaw("head", options.headHash)), null));
  const selectionPath = path.join(options.root, "selections/v1", `${options.selectionHash}.json`);
  rows.push(mutationRow(selectionPath, "cas_create_no_replace", plannedPreBytesHash(options.plan.target_prestate, selectionPath), null, `selection identity ${options.selectionHash}; raw binds proof and Cpost after proof creation`));
  rows.push(mutationRow(path.join(options.root, "selections/current.json"), "atomic_pointer_replace", null, sha256Hex(pointerRaw("selection", options.selectionHash)), null));
  rows.sort((left, right) => compare(String(left.absolute_path), String(right.absolute_path)));
  return deepFreeze({
    schema_version: "proposition-lifecycle-freshness-production-mutation-inventory/v1",
    exact_absolute_paths: true,
    operations_are_no_replace_except_expected_predecessor_pointer_rename: true,
    proof_operation: "immutable_intent_keyed_create_no_replace",
    proof_storage_semantics: "immutable intent-keyed file; not a content-addressed CAS path",
    transient_policy: "same-directory deterministic temp, file fsync, parent fsync, exact cleanup; temps are never durable inventory",
    self_referential_raw_cycle_break: "proof uses immutable intent-keyed storage plus proof_hash validation; head/selection rows bind their defined identity preimages; JSON cannot contain its own raw SHA-256 without a cryptographic fixed point",
    rows,
  });
}

function expectedRecords(root: string, plan: D3PubStaticPlan, intent: Json, intentRaw: string): Map<string, string> {
  const output = new Map<string, string>();
  output.set(`intents/v1/${String(intent.intent_hash)}.json`, intentRaw);
  for (const bundle of [plan.artifacts.p2a, plan.artifacts.stable]) for (const [name, raw] of Object.entries(bundle.artifacts)) output.set(`${bundle.family}/v1/bundles/${bundle.bundle_hash}/${name}`, raw);
  return output;
}

function validateRootAsPlanOrExpectedSubset(root: string, baselineInput: ProtectedPrestate, expected: Map<string, string>, options: { allowSameIntentResidue?: string } = {}): void {
  const baseline = validateProtectedPrestate(baselineInput);
  if (!baseline.roots.includes(root) || !baseline.roots.includes(path.dirname(root))) fail("D3_PUB_TARGET_PRESTATE_INVALID", "target prestate is not bound to family and execution roots");
  const baselineLeaves = new Map<string, Readonly<Record<string, unknown>>>();
  for (const row of baseline.rows) {
    if (row.kind !== "file") continue;
    const relative = path.relative(root, String(row.path)).split(path.sep).join("/");
    if (relative === "heads/current.json" || relative === "selections/current.json") continue;
    baselineLeaves.set(relative, row);
  }
  const allowedDirectories = new Set<string>(REQUIRED_DIRECTORIES);
  for (const row of baseline.rows) if (row.kind === "directory" && String(row.path) !== root) allowedDirectories.add(path.relative(root, String(row.path)).split(path.sep).join("/"));
  const actualLeaves = new Map<string, string>();
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const file = path.join(directory, name); const relative = path.relative(root, file).split(path.sep).join("/"); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail("D3_PUB_FOREIGN_RESIDUE", "target root contains a symlink", { relative });
      if (stat.isDirectory()) { if (!allowedDirectories.has(relative) && !isArtifactBundleDirectory(relative, planArtifactsHashes(expected))) fail("D3_PUB_FOREIGN_RESIDUE", "target root contains a foreign directory", { relative }); walk(file); continue; }
      if (!stat.isFile()) fail("D3_PUB_FOREIGN_RESIDUE", "target root contains an unsupported entry", { relative });
      if (relative === "heads/current.json") continue;
      if (relative === "selections/current.json") fail("D3_PUB_SELECTION_EXISTS_SUPERSESSION_FORBIDDEN", "selection pointer already exists");
      if (/\/\.[^/]+\.(?:cas-|current\.)[^/]*\.tmp$/.test(`/${relative}`) || path.basename(relative).startsWith(".current.")) fail("D3_PUB_FOREIGN_RESIDUE", "foreign deterministic temp blocks publication", { relative });
      actualLeaves.set(relative, readExactRegular(file, `target leaf ${relative}`).toString("utf8"));
    }
  };
  walk(root);
  for (const [relative, raw] of actualLeaves) {
    const baselineRow = baselineLeaves.get(relative);
    if (baselineRow) { if (baselineRow.raw_sha256 !== sha256Hex(raw)) fail("D3_PUB_TARGET_PRESTATE_DRIFT", "baseline target leaf bytes differ", { relative }); continue; }
    const wanted = expected.get(relative);
    if (wanted !== undefined && wanted === raw) continue;
    if (options.allowSameIntentResidue && isValidSameIntentResidue(relative, raw, options.allowSameIntentResidue)) continue;
    fail("D3_PUB_FOREIGN_RESIDUE", "target contains a foreign or different-intent leaf", { relative });
  }
  for (const relative of baselineLeaves.keys()) if (!actualLeaves.has(relative)) fail("D3_PUB_TARGET_PRESTATE_TRUNCATED", "baseline target leaf was removed", { relative });
}

function isValidSameIntentResidue(relative: string, raw: string, intentHash: string): boolean {
  try {
    const value = parseCanonical(raw, `same-intent residue ${relative}`);
    if (relative.startsWith("proofs/v1/")) return validateProof(value).intent_hash === intentHash;
    if (relative.startsWith("heads/v1/") && relative !== "heads/current.json") return validateHead(value).intent_hash === intentHash;
    if (relative.startsWith("selections/v1/") && relative !== "selections/current.json") return validateSelection(value).intent_hash === intentHash;
    return false;
  } catch { return false; }
}

function writeArtifactSet(root: string, setInput: ProductionArtifactSet): void {
  const set = validateProductionArtifactSet(setInput);
  for (const bundle of [set.p2a, set.stable]) {
    const bundleDir = path.join(root, bundle.family, "v1", "bundles", bundle.bundle_hash);
    ensureDirectoryPath(root, path.relative(root, bundleDir));
    for (const [name, raw] of Object.entries(bundle.artifacts).sort(([left], [right]) => compare(left, right))) durableCasCreate(root, `${bundle.family}/v1/bundles/${bundle.bundle_hash}/${name}`, raw);
  }
}

function validateProductionArtifactBundle(bundleInput: unknown, family: "p2a" | "stable"): ProductionArtifactBundle {
  const bundle = asRecord(bundleInput, `${family} production bundle`) as ProductionArtifactBundle;
  const expectedSchema = family === "p2a" ? D3_PUB_P2A_WRAPPER_SCHEMA : D3_PUB_STABLE_WRAPPER_SCHEMA;
  const names = family === "p2a" ? P2A_NAMES : STABLE_NAMES;
  if (bundle.family !== family || bundle.schema_version !== expectedSchema || !HASH.test(bundle.bundle_hash)) fail("D3_PUB_ARTIFACT_INVALID", `${family} bundle identity differs`);
  const artifacts = asRecord(bundle.artifacts, `${family} artifacts`) as Record<string, string>;
  if (canonicalizeJcs(Object.keys(artifacts).sort(compare)) !== canonicalizeJcs([...names].sort(compare))) fail("D3_PUB_ARTIFACT_INVALID", `${family} artifact names differ`);
  for (const [name, raw] of Object.entries(artifacts)) if (typeof raw !== "string" || (name.endsWith(".json") && canonicalJson(JSON.parse(raw)) !== raw)) fail("D3_PUB_ARTIFACT_INVALID", `${family} artifact bytes are invalid`, { name });
  const manifest = asRecord(JSON.parse(artifacts["manifest.json"]!), `${family} wrapper manifest`);
  if (manifest.schema_version !== expectedSchema || manifest.authority !== D3_PUB_AUTHORITY || manifest.source_truth !== D3_PUB_SOURCE_TRUTH || manifest.bundle_hash !== bundle.bundle_hash) fail("D3_PUB_ARTIFACT_INVALID", `${family} wrapper authority/source differs`);
  const base = { ...manifest }; delete base.bundle_hash;
  if (jcsSha256Hex(base) !== bundle.bundle_hash) fail("D3_PUB_ARTIFACT_INVALID", `${family} wrapper self hash differs`);
  return bundle;
}

export function validateD3PubIntent(value: unknown): Json {
  const intent = asRecord(value, "production intent");
  if (intent.schema_version !== D3_PUB_INTENT_SCHEMA || intent.authority !== D3_PUB_AUTHORITY) fail("D3_PUB_INTENT_INVALID", "intent identity differs");
  for (const field of ["intent_hash", "plan_hash", "source_snapshot_hash", "artifact_set_hash", "protected_prestate_hash", "configuration_prestate_hash"] as const) assertHash(intent[field], `intent ${field}`);
  const base = { ...intent }; delete base.intent_hash; delete base.audit;
  if (intent.intent_hash !== jcsSha256Hex(base)) fail("D3_PUB_INTENT_INVALID", "intent self hash differs");
  return deepFreeze(intent);
}

function validateHead(value: unknown): Json {
  const head = asRecord(value, "production head");
  if (head.schema_version !== D3_PUB_HEAD_SCHEMA || head.authority !== D3_PUB_AUTHORITY || head.state !== "committed") fail("D3_PUB_HEAD_INVALID", "head identity differs");
  for (const field of ["head_hash", "intent_hash", "proof_hash", "source_snapshot_hash", "artifact_set_hash", "p2a_bundle_hash", "stable_bundle_hash", "mutation_inventory_hash"] as const) assertHash(head[field], `head ${field}`);
  if (!Number.isSafeInteger(head.generation) || Number(head.generation) < 0) fail("D3_PUB_HEAD_INVALID", "head generation differs");
  if (head.predecessor_head_hash === null ? head.generation !== 0 : !HASH.test(String(head.predecessor_head_hash))) fail("D3_PUB_HEAD_INVALID", "head predecessor differs");
  const preimage = {
    schema_version: head.schema_version, authority: head.authority, generation: head.generation, predecessor_head_hash: head.predecessor_head_hash,
    intent_hash: head.intent_hash, source_snapshot_hash: head.source_snapshot_hash, artifact_set_hash: head.artifact_set_hash,
    p2a_bundle_hash: head.p2a_bundle_hash, stable_bundle_hash: head.stable_bundle_hash, state: head.state,
  };
  if (head.head_hash !== jcsSha256Hex(preimage)) fail("D3_PUB_HEAD_INVALID", "head predicted-preimage identity differs");
  return deepFreeze(head);
}

function validateSelection(value: unknown): Json {
  const selection = asRecord(value, "production selection");
  if (selection.schema_version !== D3_PUB_SELECTION_SCHEMA || selection.authority !== D3_PUB_AUTHORITY || selection.seq !== 0 || selection.predecessor_selection_hash !== null) fail("D3_PUB_SELECTION_INVALID", "first selection identity differs");
  for (const field of ["selection_hash", "committed_head_hash", "intent_hash", "proof_hash", "plan_hash", "authorization_coordinate_hash", "p2a_bundle_hash", "stable_bundle_hash", "mutation_inventory_hash"] as const) assertHash(selection[field], `selection ${field}`);
  const preimage = {
    schema_version: selection.schema_version, authority: selection.authority, generation: selection.generation, seq: selection.seq,
    predecessor_selection_hash: selection.predecessor_selection_hash, committed_head_hash: selection.committed_head_hash,
    intent_hash: selection.intent_hash, plan_hash: selection.plan_hash, authorization_coordinate_hash: selection.authorization_coordinate_hash,
    p2a_bundle_hash: selection.p2a_bundle_hash, stable_bundle_hash: selection.stable_bundle_hash,
  };
  if (selection.selection_hash !== jcsSha256Hex(preimage)) fail("D3_PUB_SELECTION_INVALID", "selection preimage identity differs");
  return deepFreeze(selection);
}

function validateProof(value: unknown): Json {
  const proof = asRecord(value, "production proof");
  if (proof.schema_version !== D3_PUB_PROOF_SCHEMA || proof.authority !== D3_PUB_AUTHORITY) fail("D3_PUB_PROOF_INVALID", "proof identity differs");
  for (const field of ["proof_hash", "intent_hash", "plan_hash", "predicted_head_preimage_hash", "mutation_inventory_hash"] as const) assertHash(proof[field], `proof ${field}`);
  if (proof.predicted_head_preimage_hash !== jcsSha256Hex(proof.predicted_head_preimage) || proof.mutation_inventory_hash !== jcsSha256Hex(proof.mutation_inventory)) fail("D3_PUB_PROOF_INVALID", "proof predicted head or mutation inventory binding differs");
  const base = { ...proof }; delete base.proof_hash; delete base.audit;
  if (proof.proof_hash !== jcsSha256Hex(base)) fail("D3_PUB_PROOF_INVALID", "proof self hash differs");
  return deepFreeze(proof);
}

function validateArtifactClosure(root: string, selection: Json): { p2a: ProductionArtifactBundle; stable: ProductionArtifactBundle } {
  const output = {} as { p2a: ProductionArtifactBundle; stable: ProductionArtifactBundle };
  for (const family of ["p2a", "stable"] as const) {
    const hash = String(selection[`${family}_bundle_hash`]); assertHash(hash, `${family} selected bundle`);
    const directory = path.join(root, family, "v1", "bundles", hash);
    const expectedNames = family === "p2a" ? P2A_NAMES : STABLE_NAMES;
    const actualNames = fs.readdirSync(directory).sort(compare);
    if (canonicalizeJcs(actualNames) !== canonicalizeJcs([...expectedNames].sort(compare))) fail("D3_PUB_ARTIFACT_CLOSURE_INVALID", `${family} selected bundle inventory differs`);
    const artifacts: Record<string, string> = {};
    for (const name of expectedNames) artifacts[name] = readExactRegular(path.join(directory, name), `${family} selected ${name}`).toString("utf8");
    const bundle = validateProductionArtifactBundle({ family, schema_version: family === "p2a" ? D3_PUB_P2A_WRAPPER_SCHEMA : D3_PUB_STABLE_WRAPPER_SCHEMA, bundle_hash: hash, artifacts }, family);
    output[family] = bundle;
  }
  return output;
}

function inspectTargetState(targetRoot: string): { generation: number; predecessor_head_hash: string | null; selection_exists: boolean } {
  if (!lstatMaybe(targetRoot)) return { generation: 0, predecessor_head_hash: null, selection_exists: false };
  const root = exactDirectory(targetRoot, "existing target root");
  assertRootSurface(root, { allowIncomplete: true });
  const selection = readPointer(root, "selection");
  const head = readPointer(root, "head");
  if (selection) return { generation: head ? Number(readCas(root, `heads/v1/${head.hash}.json`, "head_hash", head.hash, validateHead).generation) : 0, predecessor_head_hash: head?.hash ?? null, selection_exists: true };
  if (!head) return { generation: 0, predecessor_head_hash: null, selection_exists: false };
  const previous = readCas(root, `heads/v1/${head.hash}.json`, "head_hash", head.hash, validateHead);
  return { generation: Number(previous.generation) + 1, predecessor_head_hash: head.hash, selection_exists: false };
}

function ensureChildRoot(parentLock: RetainedDirectoryOfdLock, familyRoot: string, targetRoot: string): void {
  if (parentLock.status !== "ACQUIRED" || parentLock.fd === null) fail("D3_PUB_LOCK_INVALID", "parent lock is not acquired");
  const sediment = parentLock.identity.path;
  if (path.dirname(familyRoot) !== sediment || path.basename(familyRoot) !== "proposition-lifecycle-freshness" || path.dirname(targetRoot) !== familyRoot || path.basename(targetRoot) !== "v2") fail("D3_PUB_TARGET_INVALID", "target root is not the expected sediment family/v2 shape");
  const family = ensureDirectoryAt(parentLock.fd, "proposition-lifecycle-freshness");
  try {
    if (lstatMaybe(path.join(familyRoot, "v1"))) fail("D3_PUB_FOREIGN_V1", "v1 freshness root is foreign residue");
    const v2 = ensureDirectoryAt(family.fd, "v2"); v2.close();
  } finally { family.close(); }
  fs.fsyncSync(parentLock.fd);
  exactDirectory(targetRoot, "created v2 root");
}

function ensureRootLayout(lock: RetainedDirectoryOfdLock): void {
  if (lock.status !== "ACQUIRED" || lock.fd === null) fail("D3_PUB_LOCK_INVALID", "child root lock is not acquired");
  for (const relative of REQUIRED_DIRECTORIES) ensureDirectoryPath(lock.identity.path, relative);
  fs.fsyncSync(lock.fd);
}

function ensureDirectoryPath(root: string, relativeInput: string): void {
  const relative = relativeInput.split(path.sep).join("/");
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("D3_PUB_PATH_INVALID", "directory relative path differs", { relative });
  let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const part of relative.split("/")) {
      const child = ensureDirectoryAt(fd, part);
      fs.closeSync(fd); fd = child.fd;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function ensureDirectoryAt(parentFd: number, name: string): { fd: number; close(): void } {
  if (!/^[a-z0-9-]+$/.test(name)) fail("D3_PUB_PATH_INVALID", "directory component differs", { name });
  const childPath = `/proc/self/fd/${parentFd}/${name}`;
  try { fs.mkdirSync(childPath, { mode: 0o700 }); fs.fsyncSync(parentFd); }
  catch (error) { if (!isCode(error, "EEXIST")) throw error; }
  const named = fs.lstatSync(childPath);
  if (named.isSymbolicLink() || !named.isDirectory()) fail("D3_PUB_DIRECTORY_UNSAFE", "directory component is not an exact directory", { name });
  const fd = fs.openSync(childPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino || (opened.mode & 0o7777) !== 0o700) { fs.closeSync(fd); fail("D3_PUB_DIRECTORY_UNSAFE", "directory dentry/opened inode differs", { name }); }
  return { fd, close() { fs.closeSync(fd); } };
}

function durableCasCreate(root: string, relative: string, rawInput: string): boolean {
  const raw = Buffer.from(rawInput);
  const target = safeRootPath(root, relative);
  const parent = exactDirectory(path.dirname(target), "CAS parent");
  const base = path.basename(target);
  const temporary = path.join(parent, `.${base}.cas-${sha256Hex(raw).slice(0, 24)}.tmp`);
  assertNoForeignTemps(parent, `.${base}.cas-`, temporary);
  const targetStat = lstatMaybe(target); const tempStat = lstatMaybe(temporary);
  if (targetStat) {
    assertExactCasFile(target, raw, "existing CAS");
    if (tempStat) {
      assertExactCasFile(temporary, raw, "CAS recovery temp", { allowNlink2: true });
      const a = fs.lstatSync(target); const b = fs.lstatSync(temporary);
      if (a.dev !== b.dev || a.ino !== b.ino || a.nlink !== 2 || b.nlink !== 2) fail("D3_PUB_CAS_RESIDUE", "CAS target/temp are not the exact same nlink-2 inode");
      fs.unlinkSync(temporary); fsyncDirectory(parent);
    }
    assertExactCasFile(target, raw, "existing CAS readback");
    return false;
  }
  if (tempStat) assertExactCasFile(temporary, raw, "CAS prepared temp");
  else {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { writeAll(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectory(parent);
  }
  try { fs.linkSync(temporary, target); }
  catch (error) { if (isCode(error, "EEXIST")) { assertExactCasFile(target, raw, "raced CAS"); } else throw error; }
  fsyncDirectory(parent);
  const a = fs.lstatSync(target); const b = fs.lstatSync(temporary);
  if (a.dev !== b.dev || a.ino !== b.ino || a.nlink !== 2 || b.nlink !== 2) fail("D3_PUB_CAS_LINK_INVALID", "CAS publication did not create exact same-inode links");
  fs.unlinkSync(temporary); fsyncDirectory(parent); assertExactCasFile(target, raw, "created CAS");
  return true;
}

function advancePointer(root: string, kind: "head" | "selection", expectedRaw: string | null, hash: string): boolean {
  assertHash(hash, `${kind} pointer hash`);
  const directory = path.join(root, kind === "head" ? "heads" : "selections");
  const target = path.join(directory, "current.json");
  const raw = pointerRaw(kind, hash);
  const temporary = path.join(directory, `.current.${sha256Hex(raw).slice(0, 24)}.tmp`);
  assertNoForeignTemps(directory, ".current.", temporary);
  const current = readPointer(root, kind);
  if (current?.raw === raw) { cleanupPointerTemp(temporary, raw); return false; }
  if ((current?.raw ?? null) !== expectedRaw) fail("D3_PUB_POINTER_PREDECESSOR_MISMATCH", `${kind} pointer predecessor differs`);
  if (lstatMaybe(temporary)) assertExactPointerFile(temporary, raw);
  else {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { writeAll(fd, Buffer.from(raw)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectory(directory);
  }
  const immediate = readPointer(root, kind);
  if ((immediate?.raw ?? null) !== expectedRaw) fail("D3_PUB_POINTER_PREDECESSOR_MISMATCH", `${kind} pointer changed before rename`);
  fs.renameSync(temporary, target); fsyncDirectory(directory);
  const readback = readPointer(root, kind);
  if (!readback || readback.raw !== raw || readback.hash !== hash) fail("D3_PUB_POINTER_READBACK", `${kind} pointer readback differs`);
  return true;
}

function readPointer(root: string, kind: "head" | "selection"): { hash: string; raw: string } | null {
  const file = path.join(root, kind === "head" ? "heads" : "selections", "current.json");
  if (!lstatMaybe(file)) return null;
  const raw = readExactRegular(file, `${kind} pointer`).toString("utf8");
  const value = parseCanonical(raw, `${kind} pointer`);
  const field = kind === "head" ? "head_hash" : "selection_hash";
  const schema = kind === "head" ? D3_PUB_HEAD_POINTER_SCHEMA : D3_PUB_SELECTION_POINTER_SCHEMA;
  if (value.schema_version !== schema || Object.keys(value).length !== 2) fail("D3_PUB_POINTER_INVALID", `${kind} pointer schema differs`);
  assertHash(value[field], `${kind} pointer identity`);
  return { hash: String(value[field]), raw };
}

function readCas(root: string, relative: string, identityField: string, identity: string, validator: (value: unknown) => Json): Json {
  const raw = readExactRegular(safeRootPath(root, relative), `CAS ${relative}`).toString("utf8");
  const value = validator(parseCanonical(raw, `CAS ${relative}`));
  if (value[identityField] !== identity) fail("D3_PUB_CAS_IDENTITY_MISMATCH", "CAS filename and embedded identity differ", { relative });
  return value;
}

function assertRootSurface(root: string, options: { allowIncomplete?: boolean } = {}): void {
  const names = fs.readdirSync(root).sort(compare);
  if (names.some((name) => !ALLOWED_ROOT_TOP.includes(name as typeof ALLOWED_ROOT_TOP[number]))) fail("D3_PUB_FOREIGN_RESIDUE", "D3 root contains a foreign top-level entry", { names });
  if (!options.allowIncomplete && canonicalizeJcs(names) !== canonicalizeJcs([...ALLOWED_ROOT_TOP].sort(compare))) fail("D3_PUB_ROOT_INCOMPLETE", "D3 root top-level directories differ");
  if (lstatMaybe(path.join(root, "current.json"))) fail("D3_PUB_ROOT_CURRENT_FORBIDDEN", "root-level current is forbidden");
  for (const family of ["p2a", "stable"]) for (const name of ["latest", "current", "fallback"]) if (lstatMaybe(path.join(root, family, name))) fail("D3_PUB_ARTIFACT_POINTER_FORBIDDEN", "artifact latest/current/fallback is forbidden", { family, name });
}

function capturePathRows(root: string, file: string, rows: Record<string, unknown>[]): void {
  const stat = lstatMaybe(file);
  if (!stat) { rows.push({ root, path: file, kind: "missing" }); return; }
  const identity = { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, dev: stat.dev, ino: stat.ino };
  if (stat.isSymbolicLink()) { rows.push({ root, path: file, kind: "symlink", ...identity, target_raw_sha256: sha256Hex(fs.readlinkSync(file, { encoding: "buffer" })) }); return; }
  if (stat.isFile()) { const raw = readExactRegular(file, `protected ${file}`); rows.push({ root, path: file, kind: "file", ...identity, bytes: raw.length, raw_sha256: sha256Hex(raw) }); return; }
  if (!stat.isDirectory()) { rows.push({ root, path: file, kind: "other", ...identity }); return; }
  const children = fs.readdirSync(file).sort(compare);
  rows.push({ root, path: file, kind: "directory", ...identity, children, children_hash: jcsSha256Hex(children) });
  for (const child of children) capturePathRows(root, path.join(file, child), rows);
}

function validateAuthorizationBinding(authInput: D3PubAuthorizationCoordinate, dossier: D3PubDossierIdentity): void {
  const auth = asRecord(authInput, "authorization coordinate");
  for (const field of ["coordinate_hash", "dossier_raw_sha256", "dossier_self_hash"] as const) assertHash(auth[field], field);
  const base = { ...auth }; delete base.coordinate_hash;
  if (auth.coordinate_hash !== jcsSha256Hex(base) || auth.dossier_raw_sha256 !== dossier.dossier_raw_sha256 || auth.dossier_self_hash !== dossier.dossier_self_hash || auth.session_id !== dossier.session_id || auth.explicit_revocation_absent !== true) fail("D3_PUB_AUTHORIZATION_BINDING_INVALID", "authorization coordinate does not bind the frozen dossier");
}

function assertLockNamed(lock: RetainedDirectoryOfdLock, expected: string): void {
  if (lock.status !== "ACQUIRED" || lock.fd === null || lock.identity.path !== expected) fail("D3_PUB_LOCK_INVALID", "retained lock path/status differs");
  const named = fs.lstatSync(expected); const opened = fs.fstatSync(lock.fd);
  if (named.isSymbolicLink() || !named.isDirectory() || !opened.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino || opened.dev !== lock.identity.dev || opened.ino !== lock.identity.ino) fail("D3_PUB_LOCK_IDENTITY_DRIFT", "retained lock named/opened identity differs");
}

function assertSandboxTarget(input: string): string {
  const root = path.resolve(input); const temp = fs.realpathSync.native(os.tmpdir());
  if (!inside(temp, root) || root === temp || root === D3_PUB_HARD_ROOT || inside(D3_PUB_HARD_ABRAIN, root) || inside(root, D3_PUB_HARD_ABRAIN)) fail("D3_PUB_SANDBOX_REQUIRED", "sandbox target must be a strict system-temp child outside production", { root });
  if (path.basename(root) !== "v2" || path.basename(path.dirname(root)) !== "proposition-lifecycle-freshness") fail("D3_PUB_SANDBOX_TARGET_SHAPE", "sandbox target must end in proposition-lifecycle-freshness/v2");
  return root;
}

function assertSandboxAbrain(input: string, targetRoot: string): string {
  const home = exactDirectory(input, "sandbox abrain home"); const temp = fs.realpathSync.native(os.tmpdir());
  if (!inside(temp, home) || home === D3_PUB_HARD_ABRAIN || !inside(home, path.dirname(path.dirname(path.dirname(targetRoot))))) fail("D3_PUB_SANDBOX_ABRAIN_INVALID", "sandbox abrain must share the disposable fixture root");
  return home;
}

function parseCanonical(raw: string, label: string): Record<string, unknown> { let value: unknown; try { value = JSON.parse(raw); } catch (error) { fail("D3_PUB_JSON_INVALID", `${label} is invalid JSON`, { error: errorMessage(error) }); } const record = asRecord(value, label); if (canonicalJson(record) !== raw) fail("D3_PUB_JSON_NONCANONICAL", `${label} is not RFC8785-JCS plus LF`); return record; }
function identityObject(baseInput: Record<string, unknown>, field: string, omissions: readonly string[]): Json { const identityBase = { ...baseInput }; for (const omission of omissions) delete identityBase[omission]; return deepFreeze({ ...baseInput, [field]: jcsSha256Hex(identityBase) }); }
function canonicalJson(value: unknown): string { return `${canonicalizeJcs(value)}\n`; }
function pointerRaw(kind: "head" | "selection", hash: string): string { return canonicalJson(kind === "head" ? { schema_version: D3_PUB_HEAD_POINTER_SCHEMA, head_hash: hash } : { schema_version: D3_PUB_SELECTION_POINTER_SCHEMA, selection_hash: hash }); }
function mutationRow(absolutePath: string, operation: string, pre: string | null, post: string | null, cycleBreak: string | null): Record<string, unknown> { return { absolute_path: absolutePath, operation, pre_bytes_sha256: pre, post_bytes_sha256: post, post_identity_cycle_break: cycleBreak }; }
function plannedPreBytesHash(snapshot: ProtectedPrestate, absolutePath: string): string | null {
  const rows = snapshot.rows.filter((row) => row.path === absolutePath);
  if (rows.length === 0 || rows.every((row) => row.kind === "missing")) return null;
  const row = rows.find((candidate) => candidate.kind !== "missing")!;
  if (row.kind === "file") return String(row.raw_sha256);
  if (row.kind === "symlink") return String(row.target_raw_sha256);
  if (row.kind === "directory") return jcsSha256Hex({ kind: "directory", absolute_path: absolutePath, mode: row.mode, children: row.children });
  return jcsSha256Hex(row);
}
function artifactRow(name: string, raw: string): Record<string, unknown> { return { name, bytes: Buffer.byteLength(raw), raw_sha256: sha256Hex(raw) }; }
function directoryIdentityHash(absolute: string): string { return jcsSha256Hex({ kind: "directory", absolute_path: absolute, mode: 0o700 }); }
function eventRelativePath(eventId: string): string { return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`; }
function exactDirectory(input: string, label: string): string { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) fail("D3_PUB_DIRECTORY_UNSAFE", `${label} must be an exact directory`, { resolved }); return resolved; }
function readExactRegular(fileInput: string, label: string): Buffer { const file = path.resolve(fileInput); const named = fs.lstatSync(file); if (named.isSymbolicLink() || !named.isFile()) fail("D3_PUB_FILE_UNSAFE", `${label} is not a no-follow regular file`); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const before = fs.fstatSync(fd); const raw = fs.readFileSync(fd); const after = fs.fstatSync(fd); const current = fs.lstatSync(file); if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino || raw.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) fail("D3_PUB_FILE_RACE", `${label} changed while read`); return raw; } finally { fs.closeSync(fd); } }
function safeRootPath(root: string, relative: string): string { if (!relative || path.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("D3_PUB_PATH_INVALID", "root-relative path differs", { relative }); const file = path.resolve(root, ...relative.split("/")); if (!inside(root, file)) fail("D3_PUB_PATH_ESCAPE", "root-relative path escaped", { relative }); return file; }
function assertExactCasFile(file: string, raw: Buffer, label: string, options: { allowNlink2?: boolean } = {}): void { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o600 || (!options.allowNlink2 && stat.nlink !== 1) || (options.allowNlink2 && ![1, 2].includes(stat.nlink))) fail("D3_PUB_CAS_INVALID", `${label} metadata differs`); const actual = readExactRegular(file, label); if (!actual.equals(raw)) fail("D3_PUB_CAS_COLLISION", `${label} bytes differ`); }
function assertExactPointerFile(file: string, raw: string): void { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || readExactRegular(file, "pointer temp").toString("utf8") !== raw) fail("D3_PUB_POINTER_TEMP_INVALID", "pointer temp differs"); }
function cleanupPointerTemp(file: string, raw: string): void { if (!lstatMaybe(file)) return; assertExactPointerFile(file, raw); fs.unlinkSync(file); fsyncDirectory(path.dirname(file)); }
function assertNoForeignTemps(directory: string, prefix: string, expected: string): void { for (const name of fs.readdirSync(directory)) { const file = path.join(directory, name); if (name.startsWith(prefix) && name.endsWith(".tmp") && file !== expected) fail("D3_PUB_FOREIGN_RESIDUE", "foreign deterministic temp blocks publication", { file }); } }
function fsyncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeAll(fd: number, raw: Buffer): void { let offset = 0; while (offset < raw.length) { const wrote = fs.writeSync(fd, raw, offset, raw.length - offset, offset); if (wrote <= 0) fail("D3_PUB_SHORT_WRITE", "durable write made no progress"); offset += wrote; } }
function planArtifactsHashes(expected: Map<string, string>): Set<string> { const hashes = new Set<string>(); for (const key of expected.keys()) { const match = key.match(/^(?:p2a|stable)\/v1\/bundles\/([0-9a-f]{64})\//); if (match) hashes.add(match[1]!); } return hashes; }
function isArtifactBundleDirectory(relative: string, hashes: Set<string>): boolean { const match = relative.match(/^(p2a|stable)\/v1\/bundles\/([0-9a-f]{64})$/); return !!match && hashes.has(match[2]!); }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; } }
function injected(actual: CrashPoint | undefined, expected: Exclude<CrashPoint, null>, detail: Record<string, unknown>): void { if (actual === expected) fail("D3_PUB_INJECTED_CRASH", `injected crash after ${expected}`, { point: expected, ...detail }); }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("D3_PUB_HASH_INVALID", `${label} must be lowercase SHA-256`); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("D3_PUB_SHAPE_INVALID", `${label} must be an object`); return value as Record<string, unknown>; }
function asArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) fail("D3_PUB_SHAPE_INVALID", `${label} must be an array`); return value; }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code; }
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new D3PubProductionError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
