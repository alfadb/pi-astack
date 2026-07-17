/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";
import {
  buildPropositionPolicyStableViewBundle,
  validatePropositionPolicyStableViewBundle,
  type PropositionPolicyStableViewBundle,
} from "./proposition-policy-stable-view-publisher";

export const PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA = "proposition-policy-push-sandbox-manifest/v3" as const;
export const PROPOSITION_LIFECYCLE_STABLE_MANIFEST_V3_SCHEMA = "proposition-policy-stable-view-sandbox-manifest/v3" as const;
export const PROPOSITION_LIFECYCLE_V3_TRUTH = "sandbox_staged_append_replay" as const;
export const PROPOSITION_LIFECYCLE_V3_PROFILE_RELATIVE = "schemas/proposition-policy-stable-view-compile-profile-v1.json" as const;

export const PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES = Object.freeze([
  "diagnostics.json",
  "entries.json",
  "exclusions.json",
  "source-manifest.v2.json",
  "manifest.json",
] as const);
export const PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES = Object.freeze([
  "compile-profile.json",
  "diagnostics.json",
  "parity.json",
  "source-manifest.v2.json",
  "view.json",
  "view.md",
  "manifest.json",
] as const);

const P2A_SOURCE_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const STABLE_SOURCE_NAMES = Object.freeze(["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"] as const);
const HASH = /^[0-9a-f]{64}$/;
const P2A_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this sandbox P2a v3 manifest with bundle_hash omitted" as const;
const STABLE_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this sandbox stable v3 manifest with bundle_hash and manifest_hash omitted" as const;

type P2aV3ArtifactName = typeof PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES[number];
type StableV3ArtifactName = typeof PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES[number];

export interface LifecycleSourceRow {
  event_id: string;
  relative_path: string;
  bytes: number;
  raw_sha256: string;
}

export interface LifecycleSourceSnapshot {
  schema_version: "proposition-lifecycle-sandbox-source-snapshot/v1";
  source_kind: "production_double_scan_copy" | "sandbox_post_append_double_scan";
  input_event_count: number;
  input_event_ids: readonly string[];
  input_event_ids_hash: string;
  rows: readonly LifecycleSourceRow[];
  rows_hash: string;
  snapshot_hash: string;
}

export interface PropositionLifecycleP2aV3Bundle {
  bundle_hash: string;
  manifest: Readonly<Record<string, unknown>>;
  artifacts: Readonly<Record<P2aV3ArtifactName, string>>;
  source_bundle_v2: PropositionPolicyPushBundle;
}

export interface PropositionLifecycleStableV3Bundle {
  bundle_hash: string;
  manifest: Readonly<Record<string, unknown>>;
  artifacts: Readonly<Record<StableV3ArtifactName, string>>;
  source_bundle_v2: PropositionPolicyStableViewBundle;
  source_p2a_v3: PropositionLifecycleP2aV3Bundle;
}

export interface PropositionLifecycleV3Build {
  p2a: PropositionLifecycleP2aV3Bundle;
  stable: PropositionLifecycleStableV3Bundle;
  source_snapshot: LifecycleSourceSnapshot;
  render: { bytes: number; raw_sha256: string };
  profile: { relative_path: typeof PROPOSITION_LIFECYCLE_V3_PROFILE_RELATIVE; bytes: number; raw_sha256: string };
}

export class PropositionLifecycleFreshnessV3Error extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionLifecycleFreshnessV3Error";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionLifecycleV3Artifacts(options: {
  sandboxAbrainHome: string;
  repoRoot: string;
  sourceSnapshot: LifecycleSourceSnapshot;
  stagedEvent: { event_id: string; canonical_event_bytes_sha256: string } | null;
}): Promise<PropositionLifecycleV3Build> {
  const sandboxAbrainHome = exactDirectory(options.sandboxAbrainHome, "sandbox abrain home");
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  validateLifecycleSourceSnapshot(options.sourceSnapshot);
  validateSourceSnapshotFiles(sandboxAbrainHome, options.sourceSnapshot);
  const stableV2 = await buildPropositionPolicyStableViewBundle({ sourceAbrainHome: sandboxAbrainHome, repoRoot });
  validatePropositionPolicyStableViewBundle(stableV2);
  const p2aV2 = stableV2.source_bundle;
  validatePropositionPolicyPushBundle(p2aV2);
  if (canonicalizeJcs(p2aV2.manifest.source.input_event_ids) !== canonicalizeJcs(options.sourceSnapshot.input_event_ids)) {
    fail("V3_SOURCE_MISMATCH", "P2a v2 input IDs differ from the bound sandbox snapshot");
  }

  const p2aArtifactsWithoutManifest = {
    "diagnostics.json": p2aV2.bytes["diagnostics.json"],
    "entries.json": p2aV2.bytes["entries.json"],
    "exclusions.json": p2aV2.bytes["exclusions.json"],
    "source-manifest.v2.json": p2aV2.bytes["manifest.json"],
  } as const;
  const p2aRows = P2A_SOURCE_NAMES.map((name) => artifactRow(name, p2aV2.bytes[name], name === "manifest.json" ? "source-manifest.v2.json" : name));
  const p2aBase = deepFreeze({
    schema_version: PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    bundle_hash_scope: P2A_HASH_SCOPE,
    authority: "sandbox_d3_workflow_only_no_production_reader" as const,
    truth: PROPOSITION_LIFECYCLE_V3_TRUTH,
    source_snapshot: lifecycleSourceSnapshotBinding(options.sourceSnapshot),
    staged_event: options.stagedEvent,
    source_builder: {
      api: "buildPropositionPolicyPushShadow" as const,
      input_manifest_schema_version: p2aV2.manifest.schema_version,
      input_bundle_hash: p2aV2.manifest.bundle_hash,
      original_artifact_rows: p2aRows,
      original_artifact_rows_hash: jcsSha256Hex(p2aRows),
      all_original_artifact_bytes_bound: true as const,
    },
    result: p2aV2.manifest.result,
    source_resolution_inventory_hash: p2aV2.manifest.source.source_resolution_inventory_hash,
  });
  const p2aHash = jcsSha256Hex(p2aBase);
  const p2aManifest = deepFreeze({ ...p2aBase, bundle_hash: p2aHash });
  const p2a = deepFreeze({
    bundle_hash: p2aHash,
    manifest: p2aManifest,
    artifacts: { ...p2aArtifactsWithoutManifest, "manifest.json": canonicalJson(p2aManifest) },
    source_bundle_v2: p2aV2,
  }) as PropositionLifecycleP2aV3Bundle;
  validatePropositionLifecycleP2aV3Bundle(p2a);

  const profilePath = path.join(repoRoot, ...PROPOSITION_LIFECYCLE_V3_PROFILE_RELATIVE.split("/"));
  const profileRaw = readExactRegular(profilePath, "compile profile");
  const stableArtifactsWithoutManifest = {
    "compile-profile.json": profileRaw,
    "diagnostics.json": stableV2.artifacts["diagnostics.json"],
    "parity.json": stableV2.artifacts["parity.json"],
    "source-manifest.v2.json": stableV2.artifacts["manifest.json"],
    "view.json": stableV2.artifacts["view.json"],
    "view.md": stableV2.artifacts["view.md"],
  } as const;
  const stableRows = STABLE_SOURCE_NAMES.map((name) => artifactRow(name, stableV2.artifacts[name], name === "manifest.json" ? "source-manifest.v2.json" : name));
  const profileRow = artifactRow(PROPOSITION_LIFECYCLE_V3_PROFILE_RELATIVE, profileRaw, "compile-profile.json");
  const stableBase = deepFreeze({
    schema_version: PROPOSITION_LIFECYCLE_STABLE_MANIFEST_V3_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    bundle_hash_scope: STABLE_HASH_SCOPE,
    manifest_hash_scope: STABLE_HASH_SCOPE,
    authority: "sandbox_d3_workflow_only_no_production_reader" as const,
    truth: PROPOSITION_LIFECYCLE_V3_TRUTH,
    source_snapshot: lifecycleSourceSnapshotBinding(options.sourceSnapshot),
    staged_event: options.stagedEvent,
    source_p2a_v3: { schema_version: PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA, bundle_hash: p2a.bundle_hash },
    source_compiler: {
      api: "buildPropositionPolicyStableViewBundle" as const,
      input_manifest_schema_version: String(stableV2.manifest.schema_version),
      input_bundle_hash: stableV2.bundle_hash,
      original_artifact_rows: stableRows,
      original_artifact_rows_hash: jcsSha256Hex(stableRows),
      all_original_artifact_bytes_bound: true as const,
    },
    compile_profile: profileRow,
    render: artifactRow("view.md", stableV2.artifacts["view.md"], "view.md"),
    result: {
      item_count: asArray(asRecord(JSON.parse(stableV2.artifacts["view.json"]), "view").items, "view.items").length,
      result_kind: asRecord(stableV2.manifest.stable_view, "stable_view").result_kind,
    },
  });
  const stableHash = jcsSha256Hex(stableBase);
  const stableManifest = deepFreeze({ ...stableBase, bundle_hash: stableHash, manifest_hash: stableHash });
  const stable = deepFreeze({
    bundle_hash: stableHash,
    manifest: stableManifest,
    artifacts: { ...stableArtifactsWithoutManifest, "manifest.json": canonicalJson(stableManifest) },
    source_bundle_v2: stableV2,
    source_p2a_v3: p2a,
  }) as PropositionLifecycleStableV3Bundle;
  validatePropositionLifecycleStableV3Bundle(stable);
  return deepFreeze({
    p2a,
    stable,
    source_snapshot: options.sourceSnapshot,
    render: { bytes: Buffer.byteLength(stable.artifacts["view.md"]), raw_sha256: sha256Hex(stable.artifacts["view.md"]) },
    profile: { relative_path: PROPOSITION_LIFECYCLE_V3_PROFILE_RELATIVE, bytes: Buffer.byteLength(profileRaw), raw_sha256: sha256Hex(profileRaw) },
  });
}

export function validatePropositionLifecycleP2aV3Bundle(bundle: PropositionLifecycleP2aV3Bundle): void {
  assertHash(bundle.bundle_hash, "P2a v3 bundle hash");
  exactKeys(bundle.artifacts as unknown as Record<string, unknown>, PROPOSITION_LIFECYCLE_P2A_V3_ARTIFACT_NAMES, "P2a v3 artifacts");
  const manifest = parseCanonical(bundle.artifacts["manifest.json"], "P2a v3 manifest");
  if (canonicalizeJcs(manifest) !== canonicalizeJcs(bundle.manifest)) fail("P2A_V3_MANIFEST_OBJECT_MISMATCH", "P2a v3 manifest object differs from bytes");
  exactKeys(manifest, ["schema_version", "canonicalization", "hash_algorithm", "bundle_hash_scope", "authority", "truth", "source_snapshot", "staged_event", "source_builder", "result", "source_resolution_inventory_hash", "bundle_hash"], "P2a v3 manifest");
  if (manifest.schema_version !== PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA || manifest.canonicalization !== "RFC8785-JCS"
    || manifest.hash_algorithm !== "sha256" || manifest.bundle_hash_scope !== P2A_HASH_SCOPE
    || manifest.authority !== "sandbox_d3_workflow_only_no_production_reader" || manifest.truth !== PROPOSITION_LIFECYCLE_V3_TRUTH
    || manifest.bundle_hash !== bundle.bundle_hash) fail("P2A_V3_IDENTITY_INVALID", "P2a v3 manifest identity differs");
  const base = clone(manifest); delete base.bundle_hash;
  if (jcsSha256Hex(base) !== bundle.bundle_hash) fail("P2A_V3_HASH_INVALID", "P2a v3 self hash differs");
  validateSnapshotBinding(manifest.source_snapshot);
  validateStagedBinding(manifest.staged_event);
  const source = asRecord(manifest.source_builder, "P2a v3 source_builder");
  exactKeys(source, ["api", "input_manifest_schema_version", "input_bundle_hash", "original_artifact_rows", "original_artifact_rows_hash", "all_original_artifact_bytes_bound"], "P2a v3 source_builder");
  if (source.api !== "buildPropositionPolicyPushShadow" || source.input_manifest_schema_version !== "proposition-policy-push-shadow-manifest/v2"
    || source.input_bundle_hash !== bundle.source_bundle_v2.manifest.bundle_hash || source.all_original_artifact_bytes_bound !== true) fail("P2A_V3_SOURCE_INVALID", "P2a v3 source builder binding differs");
  const rows = asArray(source.original_artifact_rows, "P2a v3 rows");
  const expectedRows = P2A_SOURCE_NAMES.map((name) => artifactRow(name, sourceP2aRaw(bundle, name), name === "manifest.json" ? "source-manifest.v2.json" : name));
  if (canonicalizeJcs(rows) !== canonicalizeJcs(expectedRows) || source.original_artifact_rows_hash !== jcsSha256Hex(expectedRows)) fail("P2A_V3_ARTIFACT_BINDING_INVALID", "P2a v3 original artifact bytes are not fully bound");
  validatePropositionPolicyPushBundle(bundle.source_bundle_v2);
  if (canonicalizeJcs(manifest.result) !== canonicalizeJcs(bundle.source_bundle_v2.manifest.result)
    || manifest.source_resolution_inventory_hash !== bundle.source_bundle_v2.manifest.source.source_resolution_inventory_hash) fail("P2A_V3_SOURCE_INVALID", "P2a v3 result differs from source bundle");
}

export function validatePropositionLifecycleStableV3Bundle(bundle: PropositionLifecycleStableV3Bundle): void {
  assertHash(bundle.bundle_hash, "stable v3 bundle hash");
  exactKeys(bundle.artifacts as unknown as Record<string, unknown>, PROPOSITION_LIFECYCLE_STABLE_V3_ARTIFACT_NAMES, "stable v3 artifacts");
  const manifest = parseCanonical(bundle.artifacts["manifest.json"], "stable v3 manifest");
  if (canonicalizeJcs(manifest) !== canonicalizeJcs(bundle.manifest)) fail("STABLE_V3_MANIFEST_OBJECT_MISMATCH", "stable v3 manifest object differs from bytes");
  exactKeys(manifest, ["schema_version", "canonicalization", "hash_algorithm", "bundle_hash_scope", "manifest_hash_scope", "authority", "truth", "source_snapshot", "staged_event", "source_p2a_v3", "source_compiler", "compile_profile", "render", "result", "bundle_hash", "manifest_hash"], "stable v3 manifest");
  if (manifest.schema_version !== PROPOSITION_LIFECYCLE_STABLE_MANIFEST_V3_SCHEMA || manifest.canonicalization !== "RFC8785-JCS"
    || manifest.hash_algorithm !== "sha256" || manifest.bundle_hash_scope !== STABLE_HASH_SCOPE || manifest.manifest_hash_scope !== STABLE_HASH_SCOPE
    || manifest.authority !== "sandbox_d3_workflow_only_no_production_reader" || manifest.truth !== PROPOSITION_LIFECYCLE_V3_TRUTH
    || manifest.bundle_hash !== bundle.bundle_hash || manifest.manifest_hash !== bundle.bundle_hash) fail("STABLE_V3_IDENTITY_INVALID", "stable v3 manifest identity differs");
  const base = clone(manifest); delete base.bundle_hash; delete base.manifest_hash;
  if (jcsSha256Hex(base) !== bundle.bundle_hash) fail("STABLE_V3_HASH_INVALID", "stable v3 self hash differs");
  validateSnapshotBinding(manifest.source_snapshot);
  validateStagedBinding(manifest.staged_event);
  validatePropositionLifecycleP2aV3Bundle(bundle.source_p2a_v3);
  const p2a = asRecord(manifest.source_p2a_v3, "stable v3 source_p2a_v3");
  if (p2a.schema_version !== PROPOSITION_LIFECYCLE_P2A_MANIFEST_V3_SCHEMA || p2a.bundle_hash !== bundle.source_p2a_v3.bundle_hash) fail("STABLE_V3_P2A_INVALID", "stable v3 P2a binding differs");
  const source = asRecord(manifest.source_compiler, "stable v3 source_compiler");
  exactKeys(source, ["api", "input_manifest_schema_version", "input_bundle_hash", "original_artifact_rows", "original_artifact_rows_hash", "all_original_artifact_bytes_bound"], "stable v3 source_compiler");
  if (source.api !== "buildPropositionPolicyStableViewBundle" || source.input_manifest_schema_version !== "proposition-policy-stable-view-publication-manifest/v2"
    || source.input_bundle_hash !== bundle.source_bundle_v2.bundle_hash || source.all_original_artifact_bytes_bound !== true) fail("STABLE_V3_SOURCE_INVALID", "stable v3 compiler binding differs");
  const expectedRows = STABLE_SOURCE_NAMES.map((name) => artifactRow(name, sourceStableRaw(bundle, name), name === "manifest.json" ? "source-manifest.v2.json" : name));
  if (canonicalizeJcs(source.original_artifact_rows) !== canonicalizeJcs(expectedRows) || source.original_artifact_rows_hash !== jcsSha256Hex(expectedRows)) fail("STABLE_V3_ARTIFACT_BINDING_INVALID", "stable v3 original artifact bytes are not fully bound");
  const expectedProfile = artifactRow(PROPOSITION_LIFECYCLE_V3_PROFILE_RELATIVE, bundle.artifacts["compile-profile.json"], "compile-profile.json");
  const expectedRender = artifactRow("view.md", bundle.artifacts["view.md"], "view.md");
  if (canonicalizeJcs(manifest.compile_profile) !== canonicalizeJcs(expectedProfile) || canonicalizeJcs(manifest.render) !== canonicalizeJcs(expectedRender)) fail("STABLE_V3_RAW_BINDING_INVALID", "stable v3 profile or render raw binding differs");
  validatePropositionPolicyStableViewBundle(bundle.source_bundle_v2);
  if (bundle.source_bundle_v2.source_bundle.manifest.bundle_hash !== bundle.source_p2a_v3.source_bundle_v2.manifest.bundle_hash) fail("STABLE_V3_P2A_INVALID", "stable v2 source P2a differs from P2a v3 source");
  const view = asRecord(JSON.parse(bundle.artifacts["view.json"]), "stable v3 view");
  const result = asRecord(manifest.result, "stable v3 result");
  if (result.item_count !== asArray(view.items, "stable v3 view.items").length) fail("STABLE_V3_RESULT_INVALID", "stable v3 item count differs");
}

export function reconstructPropositionLifecycleP2aV3Bundle(artifacts: Readonly<Record<P2aV3ArtifactName, string>>): PropositionLifecycleP2aV3Bundle {
  const manifest = parseCanonical(artifacts["manifest.json"], "P2a v3 manifest");
  const sourceManifest = parseCanonical(artifacts["source-manifest.v2.json"], "P2a v2 source manifest");
  const source = {
    manifest: sourceManifest,
    entries: parseCanonical(artifacts["entries.json"], "P2a entries"),
    exclusions: parseCanonical(artifacts["exclusions.json"], "P2a exclusions"),
    diagnostics: parseCanonical(artifacts["diagnostics.json"], "P2a diagnostics"),
    bytes: {
      "diagnostics.json": artifacts["diagnostics.json"],
      "entries.json": artifacts["entries.json"],
      "exclusions.json": artifacts["exclusions.json"],
      "manifest.json": artifacts["source-manifest.v2.json"],
    },
  } as unknown as PropositionPolicyPushBundle;
  const bundle = deepFreeze({ bundle_hash: String(manifest.bundle_hash), manifest, artifacts, source_bundle_v2: source });
  validatePropositionLifecycleP2aV3Bundle(bundle);
  return bundle;
}

export function reconstructPropositionLifecycleStableV3Bundle(
  artifacts: Readonly<Record<StableV3ArtifactName, string>>,
  p2a: PropositionLifecycleP2aV3Bundle,
): PropositionLifecycleStableV3Bundle {
  const manifest = parseCanonical(artifacts["manifest.json"], "stable v3 manifest");
  const sourceManifest = parseCanonical(artifacts["source-manifest.v2.json"], "stable v2 source manifest");
  const source = {
    bundle_hash: String(sourceManifest.bundle_hash),
    manifest: sourceManifest,
    artifacts: {
      "diagnostics.json": artifacts["diagnostics.json"],
      "manifest.json": artifacts["source-manifest.v2.json"],
      "parity.json": artifacts["parity.json"],
      "view.json": artifacts["view.json"],
      "view.md": artifacts["view.md"],
    },
    source_bundle: p2a.source_bundle_v2,
  } as unknown as PropositionPolicyStableViewBundle;
  const bundle = deepFreeze({ bundle_hash: String(manifest.bundle_hash), manifest, artifacts, source_bundle_v2: source, source_p2a_v3: p2a });
  validatePropositionLifecycleStableV3Bundle(bundle);
  return bundle;
}

export function buildLifecycleSourceSnapshot(input: {
  sourceKind: LifecycleSourceSnapshot["source_kind"];
  rows: readonly LifecycleSourceRow[];
}): LifecycleSourceSnapshot {
  if (input.sourceKind !== "production_double_scan_copy" && input.sourceKind !== "sandbox_post_append_double_scan") fail("SOURCE_SNAPSHOT_INVALID", "source kind is outside the closed vocabulary");
  const rows = [...input.rows].sort((left, right) => compare(left.event_id, right.event_id));
  for (const [index, row] of rows.entries()) {
    exactKeys(row as unknown as Record<string, unknown>, ["event_id", "relative_path", "bytes", "raw_sha256"], `source row ${index}`);
    assertHash(row.event_id, `source row ${index} event ID`); assertHash(row.raw_sha256, `source row ${index} raw hash`);
    if (row.relative_path !== eventRelativePath(row.event_id) || !Number.isSafeInteger(row.bytes) || row.bytes <= 0) fail("SOURCE_SNAPSHOT_INVALID", "source row path or bytes differ", { index });
    if (index > 0 && compare(rows[index - 1]!.event_id, row.event_id) >= 0) fail("SOURCE_SNAPSHOT_INVALID", "source rows are duplicate or unordered");
  }
  const ids = rows.map((row) => row.event_id);
  const base = {
    schema_version: "proposition-lifecycle-sandbox-source-snapshot/v1" as const,
    source_kind: input.sourceKind,
    input_event_count: ids.length,
    input_event_ids: ids,
    input_event_ids_hash: jcsSha256Hex(ids),
    rows,
    rows_hash: jcsSha256Hex(rows),
  };
  return deepFreeze({ ...base, snapshot_hash: jcsSha256Hex(base) });
}

export function validateLifecycleSourceSnapshot(value: LifecycleSourceSnapshot): LifecycleSourceSnapshot {
  const rebuilt = buildLifecycleSourceSnapshot({ sourceKind: value.source_kind, rows: value.rows });
  if (canonicalizeJcs(rebuilt) !== canonicalizeJcs(value)) fail("SOURCE_SNAPSHOT_INVALID", "source snapshot does not equal its canonical reconstruction");
  return deepFreeze(value);
}

export function lifecycleSourceSnapshotBinding(snapshotInput: LifecycleSourceSnapshot): Readonly<Record<string, unknown>> {
  const snapshot = validateLifecycleSourceSnapshot(snapshotInput);
  return deepFreeze({
    schema_version: snapshot.schema_version,
    source_kind: snapshot.source_kind,
    input_event_count: snapshot.input_event_count,
    input_event_ids: snapshot.input_event_ids,
    input_event_ids_hash: snapshot.input_event_ids_hash,
    rows: snapshot.rows,
    rows_hash: snapshot.rows_hash,
    snapshot_hash: snapshot.snapshot_hash,
  });
}

function validateSnapshotBinding(value: unknown): void {
  const binding = asRecord(value, "snapshot binding");
  exactKeys(binding, ["schema_version", "source_kind", "input_event_count", "input_event_ids", "input_event_ids_hash", "rows", "rows_hash", "snapshot_hash"], "snapshot binding");
  const snapshot = validateLifecycleSourceSnapshot(binding as unknown as LifecycleSourceSnapshot);
  if (canonicalizeJcs(binding) !== canonicalizeJcs(lifecycleSourceSnapshotBinding(snapshot))) fail("V3_SOURCE_MISMATCH", "snapshot raw-row binding differs from canonical source snapshot");
}

function validateSourceSnapshotFiles(sandboxAbrainHome: string, snapshot: LifecycleSourceSnapshot): void {
  for (const row of snapshot.rows) {
    const file = path.join(sandboxAbrainHome, ...row.relative_path.split("/"));
    let raw: string;
    try { raw = readExactRegular(file, `source event ${row.event_id}`); }
    catch (error) { fail("V3_SOURCE_MISMATCH", "bound source event is absent or unsafe", { event_id: row.event_id, error: message(error) }); }
    if (Buffer.byteLength(raw) !== row.bytes || sha256Hex(raw) !== row.raw_sha256) {
      fail("V3_SOURCE_MISMATCH", "bound source event raw bytes differ from source snapshot", { event_id: row.event_id });
    }
  }
}

function validateStagedBinding(value: unknown): void {
  if (value === null) return;
  const row = asRecord(value, "staged event binding");
  exactKeys(row, ["event_id", "canonical_event_bytes_sha256"], "staged event binding");
  assertHash(row.event_id, "staged event ID"); assertHash(row.canonical_event_bytes_sha256, "staged event bytes");
}

function sourceP2aRaw(bundle: PropositionLifecycleP2aV3Bundle, name: typeof P2A_SOURCE_NAMES[number]): string {
  return name === "manifest.json" ? bundle.artifacts["source-manifest.v2.json"] : bundle.artifacts[name];
}

function sourceStableRaw(bundle: PropositionLifecycleStableV3Bundle, name: typeof STABLE_SOURCE_NAMES[number]): string {
  return name === "manifest.json" ? bundle.artifacts["source-manifest.v2.json"] : bundle.artifacts[name];
}

function artifactRow(name: string, raw: string, storageName: string): Readonly<Record<string, unknown>> {
  return deepFreeze({ name, storage_name: storageName, bytes: Buffer.byteLength(raw), raw_sha256: sha256Hex(raw) });
}

function eventRelativePath(eventId: string): string {
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

function readExactRegular(file: string, label: string): string {
  const named = fs.lstatSync(file);
  if (named.isSymbolicLink() || !named.isFile()) fail("V3_INPUT_UNSAFE", `${label} is not a no-symlink regular file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) fail("V3_INPUT_UNSAFE", `${label} changed while opened`);
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail("V3_INPUT_UNSAFE", `${label} changed while read`);
    return raw;
  } finally { fs.closeSync(fd); }
}

function parseCanonical(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { fail("V3_JSON_INVALID", `${label} is not JSON`, { error: message(error) }); }
  const record = asRecord(value, label);
  if (canonicalJson(record) !== raw) fail("V3_JSON_NONCANONICAL", `${label} is not RFC8785-JCS plus LF`);
  return record;
}

function canonicalJson(value: unknown): string { return `${canonicalizeJcs(value)}\n`; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function exactDirectory(input: string, label: string): string { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) fail("V3_INPUT_UNSAFE", `${label} must be an exact directory`, { resolved }); return resolved; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(compare); const wanted = [...expected].sort(compare); if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("V3_SHAPE_INVALID", `${label} keys differ`, { actual, expected: wanted }); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("V3_SHAPE_INVALID", `${label} must be an object`); return value as Record<string, unknown>; }
function asArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) fail("V3_SHAPE_INVALID", `${label} must be an array`); return value; }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("V3_HASH_INVALID", `${label} must be SHA-256`); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, messageText: string, detail?: Record<string, unknown>): never { throw new PropositionLifecycleFreshnessV3Error(code, messageText, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
