/// <reference types="node" />
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  buildTypescriptStaticDependencyGraph,
  validateTypescriptStaticDependencyGraph,
  type TypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";
import {
  D3_PUB_FOREIGN_V1,
  D3_PUB_HARD_ABRAIN,
  D3_PUB_HARD_ROOT,
  buildD3PubStaticPlan,
  buildProductionGen0ArtifactSet,
  buildProductionSourceSnapshot,
  captureCanonicalProductionPropositionSource,
  captureProtectedPrestate,
  executeD3PubProductionPublication,
  validateD3PubIntent,
  validateD3PubStaticPlan,
  type D3PubStaticPlan,
  type ProductionSourceSnapshot,
} from "./proposition-lifecycle-freshness-production-core";
import {
  buildLifecycleSourceSnapshot,
  buildPropositionLifecycleV3Artifacts,
} from "./proposition-lifecycle-freshness-v3";
import {
  dossierTranscriptMarker,
  verifyFreshD3PubRatification,
  verifyRecordedD3PubRatification,
  type D3PubAuthorizationCoordinate,
  type D3PubDossierIdentity,
} from "./proposition-lifecycle-freshness-production-transcript";

export const D3_PUB_HARD_REPO = "/home/worker/.pi/agent/skills/pi-astack" as const;
export const D3_PUB_SESSION_ID = "019f6b11-db90-7128-b1bd-b602b2a87a9c" as const;
export const D3_PUB_CAPSULE_SCHEMA = "adr0040-d3-pub-self-contained-git-object-capsule/v2" as const;
export const D3_PUB_EXTERNAL_TOOLS_SCHEMA = "adr0040-d3-pub-external-tool-manifest/v2" as const;
export const D3_PUB_DOSSIER_SCHEMA = "adr0040-d3-pub-execution-ready-read-only-preview-dossier/v1" as const;
export const D3_PUB_CAPSULE_RELATIVE = "docs/evidence/2026-07-17-adr0040-d3-pub-source-capsule.json" as const;
export const D3_PUB_PLAN_RELATIVE = "docs/evidence/2026-07-17-adr0040-d3-pub-static-plan.json" as const;
export const D3_PUB_DOSSIER_RELATIVE = "docs/evidence/2026-07-17-adr0040-d3-pub-execution-ready-dossier.json" as const;
export const D3_PUB_NOTE_RELATIVE = "docs/notes/2026-07-17-adr0040-d3-pub-execution-ready-preview.md" as const;
export const D3_PUB_EXECUTE_RELATIVE = "scripts/execute-proposition-lifecycle-freshness-d3-pub.mjs" as const;
export const D3_PUB_PREVIEW_RELATIVE = "scripts/preview-proposition-lifecycle-freshness-d3-pub.mjs" as const;
export const D3_PUB_SMOKE_RELATIVE = "scripts/smoke-proposition-lifecycle-freshness-d3-pub.mjs" as const;
export const D3_PUB_BOOTSTRAP_RELATIVE = "scripts/proposition-lifecycle-freshness-d3-pub-bootstrap.mjs" as const;

const SOURCE_ROOTS = Object.freeze([
  "extensions/_shared/proposition-lifecycle-freshness-production-core.ts",
  "extensions/_shared/proposition-lifecycle-freshness-production-preview.ts",
  "extensions/_shared/proposition-lifecycle-freshness-production-transcript.ts",
  D3_PUB_EXECUTE_RELATIVE,
  D3_PUB_PREVIEW_RELATIVE,
  D3_PUB_SMOKE_RELATIVE,
  D3_PUB_BOOTSTRAP_RELATIVE,
] as const);
const EXPLICIT_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "schemas/l1-schema-role-registry.json",
  "schemas/proposition-policy-stable-view-compile-profile-v1.json",
] as const);
const PROTECTED_PATHS = Object.freeze([
  "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1",
  "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
  "/home/worker/.abrain/.state/sediment/proposition-lifecycle-freshness/v1",
] as const);
const CONFIGURATION_PATHS = Object.freeze([
  "/home/worker/.pi/agent/pi-astack-settings.json",
  "/home/worker/.pi/agent/settings.json",
] as const);
const HASH = /^[0-9a-f]{64}$/;
const RUNTIME_ENVIRONMENT_POLICY = deepFreeze({
  schema_version: "adr0040-d3-pub-runtime-environment-policy/v1",
  node_options: "must_be_absent_or_empty",
  node_path: "must_be_absent_or_empty",
  process_exec_argv: "must_be_empty",
  other_environment: "inherited_but_non_authoritative",
});

type Json = Readonly<Record<string, unknown>>;

export interface D3PubSourceCapsule extends Record<string, unknown> {
  schema_version: typeof D3_PUB_CAPSULE_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  git_object_format: "sha1";
  deterministic_identity: Json;
  dependency_graph: TypescriptStaticDependencyGraph;
  external_tools: Json;
  source_files: readonly Json[];
  git_objects: readonly Json[];
  root_tree_oid: string;
  commit_oid: string;
  capsule_hash: string;
}

export class D3PubPreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "D3PubPreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function buildD3PubSourceCapsule(repoRootInput: string): D3PubSourceCapsule {
  const repoRoot = exactDirectory(repoRootInput, "repository root");
  const graph = buildTypescriptStaticDependencyGraph({ repoRoot, roots: SOURCE_ROOTS, explicitFiles: EXPLICIT_FILES });
  validateTypescriptStaticDependencyGraph(graph, { requiredPaths: [...SOURCE_ROOTS, ...EXPLICIT_FILES] });
  const blobByPath = new Map<string, { oid: string; raw: Buffer }>();
  const objectByOid = new Map<string, { kind: "blob" | "tree" | "commit"; raw: Buffer }>();
  const sourceFiles = graph.files.map((row) => {
    const raw = readExactRegular(path.join(repoRoot, ...row.path.split("/")), `capsule source ${row.path}`);
    if (raw.length !== row.bytes || sha256Hex(raw) !== row.sha256) fail("D3_PUB_CAPSULE_SOURCE_RACE", "dependency graph and source bytes differ", { path: row.path });
    const object = gitObject("blob", raw);
    blobByPath.set(row.path, { oid: object.oid, raw });
    objectByOid.set(object.oid, { kind: "blob", raw });
    return deepFreeze({ path: row.path, bytes: raw.length, sha256: sha256Hex(raw), blob_oid: object.oid, raw_base64: raw.toString("base64") });
  });
  const externalTools = buildExternalToolManifest(repoRoot, sourceFiles);
  const tree = buildGitTrees(blobByPath, objectByOid);
  const commitRaw = Buffer.from([
    `tree ${tree.rootOid}`,
    "author pi-astack <pi-astack@local.invalid> 0 +0000",
    "committer pi-astack <pi-astack@local.invalid> 0 +0000",
    "",
    "ADR0040 D3-PUB deterministic source capsule",
    "",
  ].join("\n"));
  const commit = gitObject("commit", commitRaw);
  objectByOid.set(commit.oid, { kind: "commit", raw: commitRaw });
  const gitObjects = [...objectByOid.entries()].sort(([left], [right]) => compare(left, right)).map(([oid, object]) => deepFreeze({ oid, kind: object.kind, bytes: object.raw.length, raw_sha256: sha256Hex(object.raw), raw_base64: object.raw.toString("base64") }));
  const base = {
    schema_version: D3_PUB_CAPSULE_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    git_object_format: "sha1" as const,
    deterministic_identity: deepFreeze({ author: "pi-astack <pi-astack@local.invalid>", committer: "pi-astack <pi-astack@local.invalid>", timestamp: "0 +0000", message: "ADR0040 D3-PUB deterministic source capsule" }),
    dependency_graph: graph,
    external_tools: externalTools,
    source_files: deepFreeze(sourceFiles),
    git_objects: deepFreeze(gitObjects),
    root_tree_oid: tree.rootOid,
    commit_oid: commit.oid,
  };
  const capsule = deepFreeze({ ...base, capsule_hash: jcsSha256Hex(base) });
  validateD3PubSourceCapsule(capsule);
  return capsule;
}

export function validateD3PubSourceCapsule(value: unknown): D3PubSourceCapsule {
  const capsule = asRecord(value, "D3-PUB source capsule") as D3PubSourceCapsule;
  if (capsule.schema_version !== D3_PUB_CAPSULE_SCHEMA || capsule.git_object_format !== "sha1" || !HASH.test(capsule.capsule_hash)) fail("D3_PUB_CAPSULE_INVALID", "capsule identity differs");
  validateTypescriptStaticDependencyGraph(capsule.dependency_graph, { requiredPaths: [...SOURCE_ROOTS, ...EXPLICIT_FILES] });
  validateExternalToolManifest(capsule.external_tools, capsule.source_files);
  const base = { ...capsule } as Record<string, unknown>; delete base.capsule_hash;
  if (capsule.capsule_hash !== jcsSha256Hex(base)) fail("D3_PUB_CAPSULE_INVALID", "capsule self hash differs");
  const objects = new Map<string, { kind: "blob" | "tree" | "commit"; raw: Buffer }>();
  for (const [index, rowInput] of capsule.git_objects.entries()) {
    const row = asRecord(rowInput, `capsule object ${index}`);
    const kind = String(row.kind) as "blob" | "tree" | "commit";
    if (!(["blob", "tree", "commit"] as string[]).includes(kind) || typeof row.raw_base64 !== "string") fail("D3_PUB_CAPSULE_OBJECT_INVALID", "capsule object shape differs", { index });
    const raw = decodeCanonicalBase64(row.raw_base64, `capsule object ${index}`);
    const object = gitObject(kind, raw);
    if (row.oid !== object.oid || row.bytes !== raw.length || row.raw_sha256 !== sha256Hex(raw) || objects.has(object.oid)) fail("D3_PUB_CAPSULE_OBJECT_INVALID", "capsule object bytes/OID differ", { index });
    objects.set(object.oid, { kind, raw });
  }
  const files = new Map<string, { oid: string; raw: Buffer }>();
  for (const [index, rowInput] of capsule.source_files.entries()) {
    const row = asRecord(rowInput, `capsule source file ${index}`);
    if (typeof row.path !== "string" || typeof row.raw_base64 !== "string" || typeof row.blob_oid !== "string") fail("D3_PUB_CAPSULE_FILE_INVALID", "capsule source row differs", { index });
    if (files.has(row.path)) fail("D3_PUB_CAPSULE_FILE_INVALID", "capsule source path is duplicated", { path: row.path });
    const raw = decodeCanonicalBase64(row.raw_base64, `capsule source ${row.path}`);
    const object = gitObject("blob", raw);
    const stored = objects.get(object.oid);
    if (row.blob_oid !== object.oid || row.bytes !== raw.length || row.sha256 !== sha256Hex(raw) || stored?.kind !== "blob" || !stored.raw.equals(raw)) fail("D3_PUB_CAPSULE_FILE_INVALID", "capsule source/blob closure differs", { path: row.path });
    files.set(row.path, { oid: object.oid, raw });
  }
  const rebuiltObjects = new Map<string, { kind: "blob" | "tree" | "commit"; raw: Buffer }>();
  for (const file of files.values()) rebuiltObjects.set(file.oid, { kind: "blob", raw: file.raw });
  const trees = buildGitTrees(files, rebuiltObjects);
  if (trees.rootOid !== capsule.root_tree_oid) fail("D3_PUB_CAPSULE_TREE_INVALID", "capsule root tree differs");
  const identity = asRecord(capsule.deterministic_identity, "capsule deterministic identity");
  const commitRaw = Buffer.from([`tree ${trees.rootOid}`, `author ${String(identity.author)} ${String(identity.timestamp)}`, `committer ${String(identity.committer)} ${String(identity.timestamp)}`, "", String(identity.message), ""].join("\n"));
  const commit = gitObject("commit", commitRaw);
  if (commit.oid !== capsule.commit_oid) fail("D3_PUB_CAPSULE_COMMIT_INVALID", "capsule deterministic commit differs");
  rebuiltObjects.set(commit.oid, { kind: "commit", raw: commitRaw });
  if (objects.size !== rebuiltObjects.size) fail("D3_PUB_CAPSULE_CLOSURE_INVALID", "capsule has missing or foreign Git objects", { actual: objects.size, expected: rebuiltObjects.size });
  for (const [oid, rebuilt] of rebuiltObjects) {
    const stored = objects.get(oid);
    if (!stored || stored.kind !== rebuilt.kind || !stored.raw.equals(rebuilt.raw)) fail("D3_PUB_CAPSULE_CLOSURE_INVALID", "capsule Git object closure differs", { oid });
  }
  return deepFreeze(capsule);
}

export function reconstructD3PubSourceCapsule(options: { capsule: D3PubSourceCapsule; destination: string }): Json {
  const capsule = validateD3PubSourceCapsule(options.capsule);
  const destination = path.resolve(options.destination);
  if (lstatMaybe(destination)) fail("D3_PUB_CAPSULE_DESTINATION_EXISTS", "capsule reconstruction destination must be absent");
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const rowInput of capsule.source_files) {
    const row = asRecord(rowInput, "capsule reconstruction row");
    const relative = safeRelative(String(row.path));
    const file = path.join(destination, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const raw = decodeCanonicalBase64(row.raw_base64, `reconstructed source ${relative}`);
    fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
    const readback = readExactRegular(file, `reconstructed ${relative}`);
    if (!readback.equals(raw) || sha256Hex(readback) !== row.sha256) fail("D3_PUB_CAPSULE_RECONSTRUCTION_INVALID", "reconstructed source bytes differ", { relative });
  }
  reconstructExternalPackageFiles(destination, capsule.external_tools);
  const externalResolution = verifyCleanExternalToolClosure(destination, capsule.external_tools);
  const graph = buildTypescriptStaticDependencyGraph({ repoRoot: destination, roots: capsule.dependency_graph.roots, explicitFiles: capsule.dependency_graph.explicit_files });
  if (canonicalizeJcs(graph) !== canonicalizeJcs(capsule.dependency_graph)) fail("D3_PUB_CAPSULE_RECONSTRUCTION_INVALID", "reconstructed dependency graph differs");
  const externalFileCount = countExternalPackageFiles(capsule.external_tools);
  return deepFreeze({ destination, file_count: capsule.source_files.length + externalFileCount, source_file_count: capsule.source_files.length, external_file_count: externalFileCount, external_tool_manifest_hash: capsule.external_tools.manifest_hash, external_resolution: externalResolution, graph_hash: graph.graph_hash, commit_oid: capsule.commit_oid, verified: true });
}

export async function buildD3PubProductionReadOnlyPreview(options: {
  repoRoot: string;
  abrainHome: string;
  capsule?: D3PubSourceCapsule;
}): Promise<{ capsule: D3PubSourceCapsule; plan: D3PubStaticPlan; dossier: Json; note: string; productionBefore: Json; productionAfter: Json }> {
  const repoRoot = exactDirectory(options.repoRoot, "production repository");
  const abrainHome = exactDirectory(options.abrainHome, "production .abrain");
  if (repoRoot !== D3_PUB_HARD_REPO || abrainHome !== D3_PUB_HARD_ABRAIN) fail("D3_PUB_PREVIEW_ROOT_INVALID", "real preview requires the exact production roots");
  const capsule = validateD3PubSourceCapsule(options.capsule ?? buildD3PubSourceCapsule(repoRoot));
  verifyExternalToolClosure(repoRoot, capsule.external_tools);
  const reconstructionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-d3-pub-capsule-"));
  const cleanTree = path.join(reconstructionRoot, "tree");
  try {
    const reconstruction = reconstructD3PubSourceCapsule({ capsule, destination: cleanTree });
    const cleanPreview = loadCleanPreviewModule(cleanTree, capsule.external_tools);
    const buildFromClean = cleanPreview.module.buildD3PubProductionReadOnlyPreviewFromCleanTree;
    if (typeof buildFromClean !== "function") fail("D3_PUB_CLEAN_ENTRYPOINT_INVALID", "clean preview module lacks its clean-tree builder");
    return await buildFromClean({
      liveRepoRoot: repoRoot,
      cleanTree,
      abrainHome,
      capsule,
      reconstruction,
      externalResolution: cleanPreview.resolution,
    });
  } finally {
    fs.rmSync(reconstructionRoot, { recursive: true, force: true });
  }
}

export async function buildD3PubProductionReadOnlyPreviewFromCleanTree(options: {
  liveRepoRoot: string;
  cleanTree: string;
  abrainHome: string;
  capsule: D3PubSourceCapsule;
  reconstruction: Json;
  externalResolution: Json;
}): Promise<{ capsule: D3PubSourceCapsule; plan: D3PubStaticPlan; dossier: Json; note: string; productionBefore: Json; productionAfter: Json }> {
  const repoRoot = exactDirectory(options.liveRepoRoot, "live production repository");
  const cleanTree = exactDirectory(options.cleanTree, "capsule clean tree");
  const abrainHome = exactDirectory(options.abrainHome, "production .abrain");
  if (repoRoot !== D3_PUB_HARD_REPO || abrainHome !== D3_PUB_HARD_ABRAIN) fail("D3_PUB_PREVIEW_ROOT_INVALID", "real preview requires the exact production roots");
  if (lstatMaybe(D3_PUB_FOREIGN_V1)) fail("D3_PUB_FOREIGN_V1", "production v1 freshness root is foreign residue");
  if (lstatMaybe(D3_PUB_HARD_ROOT)) fail("D3_PUB_PRODUCTION_V2_PRESENT", "production v2 root must be absent for this gen0 preview");
  const capsule = validateD3PubSourceCapsule(options.capsule);
  assertCleanTreeBound(cleanTree, capsule);
  verifyExternalToolClosure(repoRoot, capsule.external_tools);
  const reconstruction = options.reconstruction;
  if (reconstruction.verified !== true || reconstruction.commit_oid !== capsule.commit_oid || reconstruction.graph_hash !== capsule.dependency_graph.graph_hash || reconstruction.external_tool_manifest_hash !== capsule.external_tools.manifest_hash || reconstruction.external_file_count !== countExternalPackageFiles(capsule.external_tools)) fail("D3_PUB_CAPSULE_RECONSTRUCTION_INVALID", "clean preview reconstruction binding differs");
  const externalResolution = verifyCleanExternalToolClosure(cleanTree, capsule.external_tools);
  if (canonicalizeJcs(externalResolution) !== canonicalizeJcs(options.externalResolution) || canonicalizeJcs(externalResolution) !== canonicalizeJcs(reconstruction.external_resolution)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "clean preview package resolution binding differs");
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-d3-pub-preview-"));
  try {
    const productionBefore = capturePreviewProductionState(repoRoot, abrainHome);
    const sourceBefore = await captureCanonicalProductionPropositionSource(abrainHome);
    const sandboxAbrain = path.join(workRoot, "abrain");
    fs.mkdirSync(sandboxAbrain, { recursive: true, mode: 0o700 });
    copySourceRows(abrainHome, sandboxAbrain, sourceBefore);
    const sandboxSource = buildLifecycleSourceSnapshot({ sourceKind: "production_double_scan_copy", rows: sourceBefore.rows.map(({ event_id, relative_path, bytes, raw_sha256 }) => ({ event_id, relative_path, bytes, raw_sha256 })) });
    const v3Build = await buildPropositionLifecycleV3Artifacts({ sandboxAbrainHome: sandboxAbrain, repoRoot: cleanTree, sourceSnapshot: sandboxSource, stagedEvent: null });
    const artifacts = buildProductionGen0ArtifactSet({ build: v3Build, source: sourceBefore, sourceClosureHash: capsule.capsule_hash });
    const plan = buildD3PubStaticPlan({
      targetRoot: D3_PUB_HARD_ROOT,
      source: sourceBefore,
      artifacts,
      sourceCapsule: { relative_path: D3_PUB_CAPSULE_RELATIVE, capsule_hash: capsule.capsule_hash, commit_oid: capsule.commit_oid, root_tree_oid: capsule.root_tree_oid, dependency_graph_hash: capsule.dependency_graph.graph_hash, external_tool_manifest_hash: capsule.external_tools.manifest_hash, bootstrap_relative_path: D3_PUB_BOOTSTRAP_RELATIVE, self_contained: true, reconstruction: { verified: reconstruction.verified, file_count: reconstruction.file_count, source_file_count: reconstruction.source_file_count, external_file_count: reconstruction.external_file_count, external_tool_manifest_hash: reconstruction.external_tool_manifest_hash, external_resolution: externalResolution, graph_hash: reconstruction.graph_hash, commit_oid: reconstruction.commit_oid } },
      protectedPaths: PROTECTED_PATHS,
      configurationPaths: CONFIGURATION_PATHS,
    });
    const sourceAfterBuild = await captureCanonicalProductionPropositionSource(abrainHome);
    if (canonicalizeJcs(sourceBefore) !== canonicalizeJcs(sourceAfterBuild)) fail("D3_PUB_PREVIEW_SOURCE_DRIFT", "production source changed during preview build");
    const productionFacts = captureProductionFacts(abrainHome, sourceBefore, artifacts.counts);
    const productionAfter = capturePreviewProductionState(repoRoot, abrainHome);
    if (canonicalizeJcs(productionBefore) !== canonicalizeJcs(productionAfter)) fail("D3_PUB_PRODUCTION_MUTATION", "scoped production L1/publication/config/Git state changed during read-only preview");
    const zeroWriteScope = buildZeroWriteScope(productionBefore, productionAfter);
    const dossierBase = {
      schema_version: D3_PUB_DOSSIER_SCHEMA,
      canonicalization: "RFC8785-JCS",
      hash_algorithm: "sha256",
      mode: "real_production_execution_ready_read_only_preview",
      session_id: D3_PUB_SESSION_ID,
      authority: "pre_authorization_read_only_no_production_mutation",
      plan: { relative_path: D3_PUB_PLAN_RELATIVE, plan_hash: plan.plan_hash, generation: plan.generation, predecessor_head_hash: plan.predecessor_head_hash, selection_seq: plan.selection_seq },
      source_capsule: { relative_path: D3_PUB_CAPSULE_RELATIVE, capsule_hash: capsule.capsule_hash, commit_oid: capsule.commit_oid, root_tree_oid: capsule.root_tree_oid, object_count: capsule.git_objects.length, source_file_count: capsule.source_files.length, external_code_file_count: countExternalPackageFiles(capsule.external_tools), dependency_graph_hash: capsule.dependency_graph.graph_hash, external_tool_manifest_hash: capsule.external_tools.manifest_hash, clean_jiti_resolved_relative_path: externalResolution.jiti_entry_resolved_path, clean_typescript_resolved_relative_path: externalResolution.typescript_entry_resolved_path, bootstrap_relative_path: D3_PUB_BOOTSTRAP_RELATIVE, reconstructed_and_revalidated: true, artifacts_built_by_clean_tree_code: true },
      production_source: sourceBefore,
      frozen_artifacts: { artifact_set_hash: artifacts.artifact_set_hash, p2a_bundle_hash: artifacts.p2a.bundle_hash, stable_bundle_hash: artifacts.stable.bundle_hash, counts: artifacts.counts },
      production_facts: productionFacts,
      zero_write_scope: zeroWriteScope,
      protected_prestate: plan.protected_prestate,
      configuration_prestate: plan.configuration_prestate,
      target_prestate: plan.target_prestate,
      publication_contract: {
        production_root: D3_PUB_HARD_ROOT,
        foreign_v1: D3_PUB_FOREIGN_V1,
        source_truth: "canonical_production_l1_direct_scan",
        dag: ["intent", "proof", "committed_head", "selection"],
        mutable_pointers: ["heads/current.json", "selections/current.json"],
        runtime_inert: true,
        l1_append: false,
        projector_or_compiler_in_publisher: false,
        production_publisher_loaded_from_capsule_clean_tree: true,
        selection_required_for_published: true,
        supersession_requires_fresh_dossier_and_fresh_grant: true,
        selection_exists_blocks_this_gate: true,
        delete_rewind_forbidden: true,
      },
      authorization_contract: {
        grant_phrase_kind: "standalone_natural_language_short_sentence",
        grant_text_embedded_in_dossier: false,
        fresh_latest_user_required: true,
        immediately_preceding_unique_dossier_assistant_required: true,
        assistant_and_user_message_ids_and_turn_ordinals_bound: true,
        native_turn_id_bound_when_present: true,
        transcript_prefix_and_parent_chain_hashes_bound: true,
        dossier_raw_and_self_hashes_bound: true,
        explicit_revocation_blocks: true,
        current_request_is_pre_authorization_and_cannot_bind_this_future_dossier: true,
      },
      default_deny: { production_execution_called: false, mutation_core_called: false, fresh_ratification_present: false, status: "NOT_AUTHORIZED", reason: "fresh standalone grant after this frozen dossier is required" },
      assertions: {
        proposition_input_events: artifacts.counts.input_events === 3,
        active_policy_candidates: artifacts.counts.candidates === 1,
        stable_items: artifacts.counts.stable_items === 1,
        production_v1_absent: !lstatMaybe(D3_PUB_FOREIGN_V1),
        production_v2_absent: !lstatMaybe(D3_PUB_HARD_ROOT),
        capsule_self_contained_and_reconstructed: reconstruction.verified === true,
        artifacts_built_by_capsule_clean_tree_code: true,
        production_source_unchanged_during_build: true,
        runtime_inert: true,
        scoped_production_surfaces_unchanged: zeroWriteScope.unchanged === true,
        no_production_publication_executed: true,
      },
    };
    if (Object.values(dossierBase.assertions).some((value) => value !== true)) fail("D3_PUB_PREVIEW_ASSERTION", "real preview counts or nonmutation assertions differ", { assertions: dossierBase.assertions });
    const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) });
    const note = renderPreviewNote({ plan, dossier, capsule, productionFacts });
    return { capsule, plan, dossier, note, productionBefore, productionAfter };
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

export function writeD3PubPreviewEvidence(options: {
  repoRoot: string;
  result: { capsule: D3PubSourceCapsule; plan: D3PubStaticPlan; dossier: Json; note: string };
}): Json {
  const repoRoot = exactDirectory(options.repoRoot, "preview evidence repository");
  const rows = [
    writeEvidence(repoRoot, D3_PUB_CAPSULE_RELATIVE, canonicalJson(options.result.capsule)),
    writeEvidence(repoRoot, D3_PUB_PLAN_RELATIVE, canonicalJson(options.result.plan)),
    writeEvidence(repoRoot, D3_PUB_DOSSIER_RELATIVE, canonicalJson(options.result.dossier)),
    writeEvidence(repoRoot, D3_PUB_NOTE_RELATIVE, options.result.note),
  ];
  const dossierRow = rows.find((row) => row.relative_path === D3_PUB_DOSSIER_RELATIVE)!;
  const identity: D3PubDossierIdentity = {
    session_id: D3_PUB_SESSION_ID,
    dossier_relative_path: D3_PUB_DOSSIER_RELATIVE,
    dossier_raw_sha256: String(dossierRow.raw_sha256),
    dossier_self_hash: String(options.result.dossier.dossier_hash),
  };
  return deepFreeze({ rows, dossier_identity: identity, transcript_marker: dossierTranscriptMarker(identity) });
}

export async function executeFrozenD3PubProductionFromCleanTree(options: {
  cleanTree: string;
  liveRepoRoot: string;
  capsule: D3PubSourceCapsule;
  capsuleRaw: Buffer;
  sessionPath?: string;
}): Promise<Json> {
  const cleanTree = exactDirectory(options.cleanTree, "production capsule clean tree");
  const repoRoot = exactDirectory(options.liveRepoRoot, "production execution repository");
  if (repoRoot !== D3_PUB_HARD_REPO) fail("D3_PUB_EXECUTION_ROOT_INVALID", "official production executor requires the hard repository root");
  const capsuleRaw = readExactRegular(path.join(repoRoot, ...D3_PUB_CAPSULE_RELATIVE.split("/")), "frozen source capsule");
  if (!capsuleRaw.equals(options.capsuleRaw)) fail("D3_PUB_FROZEN_EVIDENCE_DRIFT", "live capsule bytes changed after builtin bootstrap validation");
  const capsule = validateD3PubSourceCapsule(options.capsule);
  if (canonicalizeJcs(parseCanonical(capsuleRaw, "frozen source capsule")) !== canonicalizeJcs(capsule)) fail("D3_PUB_FROZEN_EVIDENCE_INVALID", "bootstrap capsule object differs from live capsule bytes");
  assertCleanTreeBound(cleanTree, capsule);
  assertLiveBoundaryBytes(repoRoot, capsule);
  verifyExternalToolClosure(repoRoot, capsule.external_tools);
  const planRaw = readExactRegular(path.join(repoRoot, ...D3_PUB_PLAN_RELATIVE.split("/")), "frozen static plan");
  const dossierRaw = readExactRegular(path.join(repoRoot, ...D3_PUB_DOSSIER_RELATIVE.split("/")), "frozen execution dossier");
  const plan = validateD3PubStaticPlan(parseCanonical(planRaw, "frozen static plan"));
  const dossier = parseCanonical(dossierRaw, "frozen execution dossier");
  const dossierBase = { ...dossier }; delete dossierBase.dossier_hash;
  const planCapsule = asRecord(plan.source_capsule, "plan capsule");
  const dossierCapsule = asRecord(dossier.source_capsule, "dossier capsule");
  if (dossier.schema_version !== D3_PUB_DOSSIER_SCHEMA || dossier.dossier_hash !== jcsSha256Hex(dossierBase)
    || asRecord(dossier.plan, "dossier plan").plan_hash !== plan.plan_hash
    || dossierCapsule.capsule_hash !== capsule.capsule_hash || planCapsule.capsule_hash !== capsule.capsule_hash
    || dossierCapsule.external_tool_manifest_hash !== capsule.external_tools.manifest_hash
    || planCapsule.external_tool_manifest_hash !== capsule.external_tools.manifest_hash) fail("D3_PUB_FROZEN_EVIDENCE_INVALID", "frozen plan/dossier/capsule/tool closure differs");
  const identity: D3PubDossierIdentity = { session_id: D3_PUB_SESSION_ID, dossier_relative_path: D3_PUB_DOSSIER_RELATIVE, dossier_raw_sha256: sha256Hex(dossierRaw), dossier_self_hash: String(dossier.dossier_hash) };
  const sessionPath = options.sessionPath ?? findTrustedSessionPath(D3_PUB_SESSION_ID);
  let authorization: D3PubAuthorizationCoordinate;
  try { authorization = verifyFreshD3PubRatification({ sessionPath, dossier: identity }); }
  catch (freshError) {
    const recorded = readRecoverableAuthorization(plan, identity);
    if (!recorded) throw freshError;
    authorization = verifyRecordedD3PubRatification({ sessionPath, dossier: identity, recorded });
  }
  return executeD3PubProductionPublication({ plan, authorization, dossier: identity, protectedPaths: plan.protected_prestate.roots, configurationPaths: plan.configuration_prestate.roots, trustedTranscriptVerified: true });
}

function readRecoverableAuthorization(plan: D3PubStaticPlan, identity: D3PubDossierIdentity): D3PubAuthorizationCoordinate | null {
  if (!lstatMaybe(D3_PUB_HARD_ROOT)) return null;
  const directory = path.join(D3_PUB_HARD_ROOT, "intents/v1");
  if (!lstatMaybe(directory)) return null;
  const matches: D3PubAuthorizationCoordinate[] = [];
  for (const name of fs.readdirSync(directory).filter((item) => /^[0-9a-f]{64}\.json$/.test(item)).sort(compare)) {
    const intent = validateD3PubIntent(parseCanonical(readExactRegular(path.join(directory, name), `recoverable intent ${name}`), `recoverable intent ${name}`));
    if (`${String(intent.intent_hash)}.json` !== name) fail("D3_PUB_RECOVERY_INTENT_INVALID", "recoverable intent filename and validated self identity differ", { name });
    if (intent.plan_hash !== plan.plan_hash) continue;
    const dossier = asRecord(intent.dossier, "recoverable intent dossier");
    if (dossier.dossier_raw_sha256 !== identity.dossier_raw_sha256 || dossier.dossier_self_hash !== identity.dossier_self_hash) continue;
    matches.push(asRecord(intent.authorization_coordinate, "recoverable authorization") as D3PubAuthorizationCoordinate);
  }
  if (matches.length > 1) fail("D3_PUB_RECOVERY_AMBIGUOUS", "more than one same-plan durable intent exists");
  return matches[0] ?? null;
}

function capturePreviewProductionState(repoRoot: string, abrainHome: string): Json {
  return deepFreeze({
    production_l1: captureProtectedPrestate([path.join(abrainHome, "l1")]),
    publication_roots: captureProtectedPrestate([D3_PUB_FOREIGN_V1, D3_PUB_HARD_ROOT, ...PROTECTED_PATHS]),
    configuration: captureProtectedPrestate(CONFIGURATION_PATHS),
    live_git: captureProtectedPrestate([path.join(repoRoot, ".git")]),
  });
}

function buildZeroWriteScope(before: Json, after: Json): Json {
  const names = ["production_l1", "publication_roots", "configuration", "live_git"] as const;
  const bind = (state: Json) => Object.fromEntries(names.map((name) => {
    const snapshot = asRecord(state[name], `zero-write ${name}`);
    return [name, { roots: snapshot.roots, row_count: snapshot.row_count, snapshot_hash: snapshot.snapshot_hash }];
  }));
  const beforeBinding = bind(before);
  const afterBinding = bind(after);
  return deepFreeze({
    schema_version: "adr0040-d3-pub-scoped-zero-write-evidence/v1",
    excluded_concurrent_scope: "unrelated .abrain runtime state outside production L1 and named publication roots",
    before: beforeBinding,
    after: afterBinding,
    unchanged: canonicalizeJcs(beforeBinding) === canonicalizeJcs(afterBinding),
  });
}

function captureProductionFacts(abrainHome: string, source: ProductionSourceSnapshot, counts: Json): Json {
  const p2aRoot = path.join(abrainHome, ".state/sediment/proposition-policy-push-shadow/v1");
  const stableRoot = path.join(abrainHome, ".state/sediment/proposition-policy-stable-view/v1");
  const p2aLatest = readSymlinkMaybe(path.join(p2aRoot, "latest"));
  const stableLatest = readSymlinkMaybe(path.join(stableRoot, "latest"));
  const p2aManifest = p2aLatest ? readManifestAtLink(p2aRoot, p2aLatest) : null;
  const stableManifest = stableLatest ? readManifestAtLink(stableRoot, stableLatest) : null;
  const p2aIds = p2aManifest ? asArray(asRecord(p2aManifest.source, "old P2a source").input_event_ids, "old P2a input IDs").map(String).sort(compare) : [];
  return deepFreeze({
    proposition_events: source.input_event_count,
    active_policy_candidates: counts.candidates,
    compiled_stable_items: counts.stable_items,
    old_p2a: { latest: p2aLatest, bundle_hash: p2aLatest?.replace(/^bundles\//, "") ?? null, input_event_ids: p2aIds, stale_against_direct_source: canonicalizeJcs(p2aIds) !== canonicalizeJcs(source.input_event_ids) },
    old_stable: { latest: stableLatest, bundle_hash: stableLatest?.replace(/^bundles\//, "") ?? null, item_count: stableManifest ? Number(asRecord(stableManifest.stable_view, "old stable view").item_count ?? asRecord(stableManifest.result ?? {}, "old stable result").item_count ?? 0) : null },
    runtime: { continues_to_read_old_stable_latest: true, D3_gen0_runtime_reachable: false },
  });
}

function buildExternalToolManifest(repoRoot: string, sourceFiles: readonly Json[]): Json {
  const packages = ["jiti", "typescript"].map((name) => captureExternalPackage(repoRoot, name));
  const sourceByPath = new Map(sourceFiles.map((row) => [String(row.path), row]));
  const repositoryManifests = ["package.json", "package-lock.json"].map((relative) => {
    const row = sourceByPath.get(relative);
    if (!row) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "repository package/lock manifest is absent from capsule files", { relative });
    return deepFreeze({ relative_path: relative, bytes: row.bytes, raw_sha256: row.sha256 });
  });
  const executable = readExactRegular(process.execPath, "Node executable");
  const base = {
    schema_version: D3_PUB_EXTERNAL_TOOLS_SCHEMA,
    node_runtime: { observed_exec_path: process.execPath, observed_exec_realpath: fs.realpathSync.native(process.execPath), version: process.version, exec_bytes: executable.length, exec_sha256: sha256Hex(executable) },
    environment_policy: RUNTIME_ENVIRONMENT_POLICY,
    packages: deepFreeze(packages),
    repository_manifests: deepFreeze(repositoryManifests),
  };
  return deepFreeze({ ...base, manifest_hash: jcsSha256Hex(base) });
}

function captureExternalPackage(repoRoot: string, name: string): Json {
  const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
  const packageJsonResolved = path.resolve(requireFromRepo.resolve(`${name}/package.json`));
  const entryResolved = path.resolve(requireFromRepo.resolve(name));
  const packageRoot = exactDirectory(path.dirname(packageJsonResolved), `${name} package root`);
  const expectedRoot = path.join(repoRoot, "node_modules", name);
  if (packageRoot !== expectedRoot || fs.realpathSync.native(entryResolved) !== entryResolved) fail("D3_PUB_EXTERNAL_TOOL_INVALID", `${name} package must resolve to the exact repository node_modules root`);
  const packageJsonRelative = packageRelative(packageRoot, packageJsonResolved);
  const entryRelative = packageRelative(packageRoot, entryResolved);
  const selected = name === "jiti" ? null : new Set([packageJsonRelative, entryRelative]);
  const relatives = collectRuntimePackageFiles(packageRoot, selected);
  const files = relatives.map((relative) => readExternalPackageFile(packageRoot, relative, `${name} runtime ${relative}`));
  const packageJsonRow = files.find((row) => row.relative_path === packageJsonRelative);
  const entryRow = files.find((row) => row.relative_path === entryRelative);
  if (!packageJsonRow || !entryRow) fail("D3_PUB_EXTERNAL_TOOL_INVALID", `${name} package closure omits package.json or resolved entry`);
  const parsed = parseJsonObject(decodeCanonicalBase64(packageJsonRow.raw_base64, `${name} package.json`), `${name} package.json`);
  if (parsed.name !== name || typeof parsed.version !== "string" || !parsed.version) fail("D3_PUB_EXTERNAL_TOOL_INVALID", `${name} package identity differs`);
  return deepFreeze({
    name,
    version: parsed.version,
    package_root_relative: `node_modules/${name}`,
    package_json_relative_path: packageJsonRelative,
    entry_relative_path: entryRelative,
    closure_strategy: name === "jiti" ? "all_package_runtime_js_cjs_mjs_json" : "package_json_plus_resolved_entry_and_no_relative_runtime_dependencies",
    local_runtime_dependencies: [],
    observed_live_resolution: { package_json_resolved_path: packageJsonResolved, entry_resolved_path: entryResolved },
    files: deepFreeze(files),
    files_hash: jcsSha256Hex(files),
  });
}

function validateExternalToolManifest(input: unknown, sourceFiles: readonly Json[]): Json {
  const manifest = asRecord(input, "external tool manifest");
  if (manifest.schema_version !== D3_PUB_EXTERNAL_TOOLS_SCHEMA) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external tool manifest schema differs");
  const base = { ...manifest }; delete base.manifest_hash;
  if (typeof manifest.manifest_hash !== "string" || !HASH.test(manifest.manifest_hash) || manifest.manifest_hash !== jcsSha256Hex(base)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external tool manifest self hash differs");
  const node = asRecord(manifest.node_runtime, "external Node runtime");
  for (const field of ["observed_exec_path", "observed_exec_realpath", "version"] as const) if (typeof node[field] !== "string" || !node[field]) fail("D3_PUB_EXTERNAL_TOOL_INVALID", `external Node ${field} differs`);
  if (!Number.isSafeInteger(node.exec_bytes) || Number(node.exec_bytes) <= 0 || typeof node.exec_sha256 !== "string" || !HASH.test(node.exec_sha256)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "Node executable byte identity differs");
  if (canonicalizeJcs(manifest.environment_policy) !== canonicalizeJcs(RUNTIME_ENVIRONMENT_POLICY)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "runtime environment policy differs");
  const packages = asArray(manifest.packages, "external packages").map((row) => asRecord(row, "external package"));
  if (canonicalizeJcs(packages.map((row) => row.name)) !== canonicalizeJcs(["jiti", "typescript"])) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package inventory differs");
  for (const row of packages) validateExternalPackageRow(row);
  const sourceByPath = new Map(sourceFiles.map((row) => [String(row.path), row]));
  const repositories = asArray(manifest.repository_manifests, "repository manifests").map((row) => asRecord(row, "repository manifest"));
  if (canonicalizeJcs(repositories.map((row) => row.relative_path)) !== canonicalizeJcs(["package.json", "package-lock.json"])) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "repository manifest inventory differs");
  for (const row of repositories) {
    const source = sourceByPath.get(String(row.relative_path));
    if (!source || row.bytes !== source.bytes || row.raw_sha256 !== source.sha256) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "repository manifest is not bound by capsule raw bytes", { relative: row.relative_path });
  }
  return deepFreeze(manifest);
}

function validateExternalPackageRow(row: Record<string, unknown>): void {
  const name = String(row.name);
  if (!(["jiti", "typescript"] as string[]).includes(name) || typeof row.version !== "string" || !row.version || row.package_root_relative !== `node_modules/${name}` || safeRelative(String(row.package_root_relative)) !== row.package_root_relative) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package row identity differs", { name });
  const packageJsonRelative = safeRelative(String(row.package_json_relative_path));
  const entryRelative = safeRelative(String(row.entry_relative_path));
  if (packageJsonRelative !== "package.json" || !Array.isArray(row.local_runtime_dependencies) || row.local_runtime_dependencies.length !== 0) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package entry/dependency declaration differs", { name });
  const observed = asRecord(row.observed_live_resolution, `${name} observed resolution`);
  if (typeof observed.package_json_resolved_path !== "string" || !path.isAbsolute(observed.package_json_resolved_path) || typeof observed.entry_resolved_path !== "string" || !path.isAbsolute(observed.entry_resolved_path)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package observation differs", { name });
  const files = asArray(row.files, `${name} runtime files`).map((input) => asRecord(input, `${name} runtime file`));
  if (files.length === 0 || row.files_hash !== jcsSha256Hex(files)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file hash differs", { name });
  let previous = "";
  const seen = new Set<string>();
  for (const file of files) {
    const relative = safeRelative(String(file.relative_path));
    if (seen.has(relative) || (previous && compare(previous, relative) >= 0) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0 || !Number.isSafeInteger(file.mode)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file path/order/size/mode differs", { name, relative });
    assertSafeRuntimeMode(Number(file.mode), `${name} ${relative}`);
    if (typeof file.sha256 !== "string" || !HASH.test(file.sha256) || typeof file.raw_base64 !== "string") fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file hash/base64 differs", { name, relative });
    const raw = decodeCanonicalBase64(file.raw_base64, `${name} ${relative}`);
    if (raw.length !== file.bytes || sha256Hex(raw) !== file.sha256) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file bytes differ", { name, relative });
    previous = relative; seen.add(relative);
  }
  if (!seen.has(packageJsonRelative) || !seen.has(entryRelative)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package closure omits package.json or entry", { name });
  const packageJson = files.find((file) => file.relative_path === packageJsonRelative)!;
  const parsed = parseJsonObject(decodeCanonicalBase64(packageJson.raw_base64, `${name} package.json`), `${name} package.json`);
  if (parsed.name !== name || parsed.version !== row.version) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package bytes do not bind name/version", { name });
}

function verifyExternalToolClosure(repoRoot: string, input: unknown): Json {
  const manifest = asRecord(input, "external tool manifest");
  assertRuntimeEnvironmentPolicy(manifest.environment_policy);
  const node = asRecord(manifest.node_runtime, "external Node runtime");
  const executable = readExactRegular(process.execPath, "Node executable");
  if (node.observed_exec_path !== process.execPath || node.observed_exec_realpath !== fs.realpathSync.native(process.execPath) || node.version !== process.version || node.exec_bytes !== executable.length || node.exec_sha256 !== sha256Hex(executable)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "Node executable path/version/bytes differ");
  for (const inputRow of asArray(manifest.packages, "external packages")) {
    const expected = asRecord(inputRow, "external package");
    const actual = captureExternalPackage(repoRoot, String(expected.name));
    if (canonicalizeJcs(packageBinding(actual)) !== canonicalizeJcs(packageBinding(expected))) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "external package code closure differs", { name: expected.name });
  }
  for (const inputRow of asArray(manifest.repository_manifests, "repository manifests")) {
    const row = asRecord(inputRow, "repository manifest");
    const relative = safeRelative(String(row.relative_path));
    const raw = readExactRegular(path.join(repoRoot, ...relative.split("/")), `repository manifest ${relative}`);
    if (raw.length !== row.bytes || sha256Hex(raw) !== row.raw_sha256) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "repository package/lock manifest differs", { relative });
  }
  return deepFreeze(manifest);
}

function reconstructExternalPackageFiles(cleanTree: string, toolsInput: unknown): void {
  const tools = asRecord(toolsInput, "external tools");
  for (const inputPackage of asArray(tools.packages, "external packages")) {
    const packageRow = asRecord(inputPackage, "external package");
    const packageRootRelative = safeRelative(String(packageRow.package_root_relative));
    for (const inputFile of asArray(packageRow.files, `${String(packageRow.name)} files`)) {
      const row = asRecord(inputFile, "external package file");
      const relative = safeRelative(String(row.relative_path));
      const raw = decodeCanonicalBase64(row.raw_base64, `external reconstruction ${String(packageRow.name)} ${relative}`);
      const file = path.join(cleanTree, ...packageRootRelative.split("/"), ...relative.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, raw, { flag: "wx", mode: Number(row.mode) });
      fs.chmodSync(file, Number(row.mode));
      const readback = readExactRegular(file, `reconstructed external ${String(packageRow.name)} ${relative}`);
      const stat = fs.lstatSync(file);
      if (!readback.equals(raw) || readback.length !== row.bytes || sha256Hex(readback) !== row.sha256 || (stat.mode & 0o7777) !== row.mode) fail("D3_PUB_CAPSULE_RECONSTRUCTION_INVALID", "reconstructed external package file differs", { name: packageRow.name, relative });
    }
  }
}

function verifyCleanExternalToolClosure(cleanTree: string, toolsInput: unknown): Json {
  const tools = asRecord(toolsInput, "external tools");
  const rows = asArray(tools.packages, "external packages").map((input) => asRecord(input, "external package"));
  for (const packageRow of rows) {
    const packageRoot = exactDirectory(path.join(cleanTree, ...safeRelative(String(packageRow.package_root_relative)).split("/")), `${String(packageRow.name)} clean package root`);
    for (const inputFile of asArray(packageRow.files, `${String(packageRow.name)} clean files`)) {
      const row = asRecord(inputFile, "clean external package file");
      const relative = safeRelative(String(row.relative_path));
      const file = path.join(packageRoot, ...relative.split("/"));
      const raw = readExactRegular(file, `clean external ${String(packageRow.name)} ${relative}`);
      const stat = fs.lstatSync(file);
      if (raw.length !== row.bytes || sha256Hex(raw) !== row.sha256 || raw.toString("base64") !== row.raw_base64 || (stat.mode & 0o7777) !== row.mode) fail("D3_PUB_CLEAN_TREE_DRIFT", "clean external package code differs", { name: packageRow.name, relative });
    }
  }
  const cleanPackageJson = path.join(cleanTree, "package.json");
  readExactRegular(cleanPackageJson, "clean repository package.json");
  const cleanRequire = createRequire(cleanPackageJson);
  const resolutions: Record<string, string> = {};
  for (const packageRow of rows) {
    const name = String(packageRow.name);
    const expectedPackageJson = path.join(cleanTree, ...safeRelative(String(packageRow.package_root_relative)).split("/"), ...safeRelative(String(packageRow.package_json_relative_path)).split("/"));
    const expectedEntry = path.join(cleanTree, ...safeRelative(String(packageRow.package_root_relative)).split("/"), ...safeRelative(String(packageRow.entry_relative_path)).split("/"));
    const resolvedPackageJson = cleanRequire.resolve(`${name}/package.json`);
    const resolvedEntry = cleanRequire.resolve(name);
    if (resolvedPackageJson !== expectedPackageJson || resolvedEntry !== expectedEntry || !insideTree(cleanTree, resolvedPackageJson) || !insideTree(cleanTree, resolvedEntry)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "clean external package resolved outside reconstructed clean tree", { name, resolvedPackageJson, resolvedEntry });
    resolutions[`${name}_package_json_relative_path`] = path.relative(cleanTree, resolvedPackageJson).split(path.sep).join("/");
    resolutions[`${name}_entry_resolved_relative_path`] = path.relative(cleanTree, resolvedEntry).split(path.sep).join("/");
  }
  return deepFreeze({ verified: true, all_resolved_within_clean_tree: true, jiti_package_json_relative_path: resolutions.jiti_package_json_relative_path, jiti_entry_resolved_path: resolutions.jiti_entry_resolved_relative_path, typescript_package_json_relative_path: resolutions.typescript_package_json_relative_path, typescript_entry_resolved_path: resolutions.typescript_entry_resolved_relative_path });
}

function loadCleanPreviewModule(cleanTree: string, toolsInput: unknown): { module: Record<string, unknown>; resolution: Json } {
  const resolution = verifyCleanExternalToolClosure(cleanTree, toolsInput);
  const cleanPackageJson = path.join(cleanTree, "package.json");
  const cleanRequire = createRequire(cleanPackageJson);
  const resolvedJiti = cleanRequire.resolve("jiti");
  if (path.relative(cleanTree, resolvedJiti).split(path.sep).join("/") !== resolution.jiti_entry_resolved_path) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "clean jiti resolution changed before load");
  const loaded = cleanRequire("jiti") as { createJiti?: (root: string, options: Record<string, unknown>) => (file: string) => Record<string, unknown> };
  if (typeof loaded.createJiti !== "function") fail("D3_PUB_EXTERNAL_TOOL_INVALID", "verified clean jiti does not export createJiti");
  const cleanJiti = loaded.createJiti(cleanTree, { interopDefault: true, fsCache: false, moduleCache: false });
  return { module: cleanJiti(path.join(cleanTree, "extensions/_shared/proposition-lifecycle-freshness-production-preview.ts")), resolution };
}

function assertCleanTreeBound(cleanTree: string, capsule: D3PubSourceCapsule): void {
  for (const input of capsule.source_files) {
    const row = asRecord(input, "clean-tree source row");
    const relative = safeRelative(String(row.path));
    const raw = readExactRegular(path.join(cleanTree, ...relative.split("/")), `clean-tree ${relative}`);
    if (raw.length !== row.bytes || sha256Hex(raw) !== row.sha256 || raw.toString("base64") !== row.raw_base64) fail("D3_PUB_CLEAN_TREE_DRIFT", "clean-tree source bytes differ from capsule", { relative });
  }
  verifyCleanExternalToolClosure(cleanTree, capsule.external_tools);
}

function countExternalPackageFiles(toolsInput: unknown): number {
  return asArray(asRecord(toolsInput, "external tools").packages, "external packages").reduce<number>((count, input) => count + asArray(asRecord(input, "external package").files, "external files").length, 0);
}

function packageBinding(input: Json): Json {
  const row = { ...input } as Record<string, unknown>;
  delete row.observed_live_resolution;
  return row;
}

function collectRuntimePackageFiles(packageRoot: string, selected: Set<string> | null): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const file = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package contains a symlink or non-file entry", { relative });
      assertSafeRuntimeMode(stat.mode & 0o7777, `external package ${relative}`);
      if (stat.isDirectory()) walk(file, relative);
      else if (selected ? selected.has(relative) : /^\.(?:js|cjs|mjs|json)$/.test(path.extname(relative))) files.push(relative);
    }
  };
  walk(packageRoot, "");
  return files.sort(compare);
}

function readExternalPackageFile(packageRoot: string, relative: string, label: string): Json {
  const file = path.join(packageRoot, ...safeRelative(relative).split("/"));
  const before = fs.lstatSync(file);
  const mode = before.mode & 0o7777;
  assertSafeRuntimeMode(mode, label);
  const raw = readExactRegular(file, label);
  const after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "external package file changed while captured", { relative });
  return deepFreeze({ relative_path: relative, bytes: raw.length, sha256: sha256Hex(raw), mode, raw_base64: raw.toString("base64") });
}

function assertRuntimeEnvironmentPolicy(input: unknown): void {
  if (canonicalizeJcs(input) !== canonicalizeJcs(RUNTIME_ENVIRONMENT_POLICY)) fail("D3_PUB_RUNTIME_POLICY_INVALID", "runtime environment policy differs");
  if ((process.env.NODE_OPTIONS ?? "") !== "" || (process.env.NODE_PATH ?? "") !== "" || process.execArgv.length !== 0) fail("D3_PUB_RUNTIME_POLICY_VIOLATION", "NODE_OPTIONS, NODE_PATH, and process.execArgv must be empty", { node_options_nonempty: (process.env.NODE_OPTIONS ?? "") !== "", node_path_nonempty: (process.env.NODE_PATH ?? "") !== "", exec_argv: [...process.execArgv] });
}

function assertSafeRuntimeMode(mode: number, label: string): void {
  if (!Number.isSafeInteger(mode) || (mode & 0o7000) !== 0 || (mode & 0o400) === 0) fail("D3_PUB_EXTERNAL_TOOL_MODE_INVALID", "external runtime path has unsafe mode", { label, mode });
}

function packageRelative(packageRoot: string, file: string): string {
  const relative = path.relative(packageRoot, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package entry resolves outside package root", { packageRoot, file });
  return safeRelative(relative);
}

function insideTree(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseJsonObject(raw: Buffer, label: string): Record<string, unknown> {
  try { return asRecord(JSON.parse(raw.toString("utf8")), label); }
  catch (error) { fail("D3_PUB_EXTERNAL_TOOL_INVALID", `${label} is invalid JSON`, { error: errorMessage(error) }); }
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string") fail("D3_PUB_CAPSULE_BASE64_INVALID", `${label} base64 differs`);
  const raw = Buffer.from(value, "base64");
  if (raw.toString("base64") !== value) fail("D3_PUB_CAPSULE_BASE64_INVALID", `${label} is not canonical base64`);
  return raw;
}

function assertLiveBoundaryBytes(repoRoot: string, capsule: D3PubSourceCapsule): void {
  const sourceByPath = new Map(capsule.source_files.map((input) => { const row = asRecord(input, "capsule source row"); return [String(row.path), row]; }));
  for (const relative of [D3_PUB_EXECUTE_RELATIVE, D3_PUB_BOOTSTRAP_RELATIVE]) {
    const row = sourceByPath.get(relative);
    if (!row) fail("D3_PUB_BOOTSTRAP_SOURCE_UNBOUND", "launcher/bootstrap is absent from capsule", { relative });
    const raw = readExactRegular(path.join(repoRoot, ...relative.split("/")), `live boundary ${relative}`);
    if (raw.length !== row.bytes || sha256Hex(raw) !== row.sha256 || raw.toString("base64") !== row.raw_base64) fail("D3_PUB_BOOTSTRAP_SOURCE_DRIFT", "live launcher/bootstrap differs from capsule before production mutation", { relative });
  }
}

function renderPreviewNote(input: { plan: D3PubStaticPlan; dossier: Json; capsule: D3PubSourceCapsule; productionFacts: Json }): string {
  const counts = asRecord(input.plan.artifacts.counts, "plan artifact counts");
  return `---\ndoc_type: design-note\nstatus: execution-ready-read-only-preview\n---\n\n# ADR0040 D3-PUB execution-ready read-only preview\n\nThis gate freezes a runtime-inert generation-${input.plan.generation} publication for \`${D3_PUB_HARD_ROOT}\`. It does not append L1, update legacy P2a/stable latest pointers, change runtime/configuration/git state, or invoke the production publisher. The v1 freshness root remains foreign-blocking.\n\nThe frozen direct production scan contains ${counts.input_events} proposition events, ${counts.candidates} active policy candidate, and ${counts.stable_items} stable item. The publication DAG is intent -> proof -> committed head -> selection. Only \`heads/current.json\` and \`selections/current.json\` are mutable pointers; selection closure is required before the root is published. Artifact bundle hash directories are exact inventory rows. The proof file uses \`immutable_intent_keyed_create_no_replace\`: its path is keyed by \`intent_hash\` as the explicit self-reference cycle break and is not described as a content-addressed CAS path.\n\nThe source capsule is self-contained: ${input.capsule.source_files.length} repository source files, ${countExternalPackageFiles(input.capsule.external_tools)} external runtime code files, and ${input.capsule.git_objects.length} real Git blob/tree/commit objects, commit \`${input.capsule.commit_oid}\`, capsule hash \`${input.capsule.capsule_hash}\`. It binds the builtin bootstrap, launcher, compile profile, repository package/lock manifests, the Node executable bytes, the strict runtime environment policy, and external tool manifest \`${String(input.capsule.external_tools.manifest_hash)}\`. Preview reconstructed the bound jiti and TypeScript bytes under the clean tree's \`node_modules\`, read every file back, resolved and loaded both packages only from that tree, and rebuilt the dependency graph byte-for-byte without writing the live Git object database, index, refs, or worktrees. Production execution uses the same two-phase bootstrap and loads authorization/publisher business code only from the surviving clean tree.\n\nZero-write evidence covers production L1, D3 v1/v2, legacy P2a/stable, configuration, and live Git; unrelated concurrent runtime state elsewhere under \`.abrain\` is outside this proof. Plan hash: \`${input.plan.plan_hash}\`. Dossier hash: \`${String(input.dossier.dossier_hash)}\`. Production remains default-denied until a later standalone user grant is verified from the trusted active transcript branch. Existing durable intent recovery is exact-intent-only; drift before selection requires a new preview, dossier, and grant. Selection presence forbids supersession through this gate. No delete, rewind, TTL, mtime abort, or fallback pointer exists.\n`;
}

function buildGitTrees(files: Map<string, { oid: string; raw: Buffer }>, objects: Map<string, { kind: "blob" | "tree" | "commit"; raw: Buffer }>): { rootOid: string } {
  interface Node { files: Map<string, string>; directories: Map<string, Node> }
  const root: Node = { files: new Map(), directories: new Map() };
  for (const [relativeInput, file] of files) {
    const relative = safeRelative(relativeInput); const parts = relative.split("/"); const leaf = parts.pop()!; let node = root;
    for (const part of parts) { let child = node.directories.get(part); if (!child) { child = { files: new Map(), directories: new Map() }; node.directories.set(part, child); } node = child; }
    if (node.files.has(leaf) || node.directories.has(leaf)) fail("D3_PUB_CAPSULE_PATH_COLLISION", "capsule tree path collision", { relative });
    node.files.set(leaf, file.oid);
  }
  const build = (node: Node): string => {
    const entries: Array<{ name: string; mode: string; oid: string }> = [];
    for (const [name, child] of node.directories) entries.push({ name, mode: "40000", oid: build(child) });
    for (const [name, oid] of node.files) entries.push({ name, mode: "100644", oid });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    const parts: Buffer[] = [];
    for (const entry of entries) parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, "hex"));
    const raw = Buffer.concat(parts); const object = gitObject("tree", raw); objects.set(object.oid, { kind: "tree", raw }); return object.oid;
  };
  return { rootOid: build(root) };
}

function gitObject(kind: "blob" | "tree" | "commit", raw: Buffer): { oid: string } { return { oid: crypto.createHash("sha1").update(Buffer.from(`${kind} ${raw.length}\0`)).update(raw).digest("hex") }; }

function copySourceRows(sourceHome: string, targetHome: string, source: ProductionSourceSnapshot): void {
  for (const row of source.rows) {
    const from = path.join(sourceHome, ...row.relative_path.split("/")); const to = path.join(targetHome, ...row.relative_path.split("/"));
    const raw = readExactRegular(from, `copy source ${row.event_id}`);
    if (raw.length !== row.bytes || sha256Hex(raw) !== row.raw_sha256 || raw.toString("utf8") !== row.raw) fail("D3_PUB_SOURCE_DRIFT", "source changed during sandbox copy", { event_id: row.event_id });
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.writeFileSync(to, raw, { flag: "wx", mode: 0o600 });
  }
  const copiedRows = source.rows.map((row) => { const raw = readExactRegular(path.join(targetHome, ...row.relative_path.split("/")), `copied source ${row.event_id}`); return { ...row, bytes: raw.length, raw_sha256: sha256Hex(raw) }; });
  if (canonicalizeJcs(buildProductionSourceSnapshot(copiedRows)) !== canonicalizeJcs(source)) fail("D3_PUB_SOURCE_COPY_MISMATCH", "sandbox source copy differs");
}

function writeEvidence(repoRoot: string, relativeInput: string, rawInput: string): Json {
  const relative = safeRelative(relativeInput);
  const file = path.join(repoRoot, ...relative.split("/"));
  const directory = exactDirectory(path.dirname(file), "evidence parent");
  const raw = Buffer.from(rawInput);
  const existing = lstatMaybe(file);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) fail("D3_PUB_EVIDENCE_COLLISION", "evidence path is unsafe", { relative });
    if (readExactRegular(file, `existing evidence ${relative}`).equals(raw)) return deepFreeze({ relative_path: relative, bytes: raw.length, raw_sha256: sha256Hex(raw) });
  }
  const temporary = path.join(directory, `.${path.basename(file)}.evidence-${sha256Hex(raw).slice(0, 24)}.tmp`);
  const temp = lstatMaybe(temporary);
  if (temp) {
    if (temp.isSymbolicLink() || !temp.isFile() || !readExactRegular(temporary, `evidence temp ${relative}`).equals(raw)) fail("D3_PUB_EVIDENCE_TEMP_COLLISION", "same-directory evidence temp differs", { relative });
  } else {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try { writeAll(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectory(directory);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(directory);
  const readback = readExactRegular(file, `evidence readback ${relative}`);
  if (!readback.equals(raw)) fail("D3_PUB_EVIDENCE_READBACK", "evidence readback differs", { relative });
  return deepFreeze({ relative_path: relative, bytes: readback.length, raw_sha256: sha256Hex(readback) });
}

function findTrustedSessionPath(sessionId: string): string {
  const root = "/home/worker/.pi/agent/sessions";
  const matches: string[] = [];
  const walk = (directory: string) => { for (const name of fs.readdirSync(directory).sort(compare)) { const file = path.join(directory, name); const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) fail("D3_PUB_SESSION_PATH_UNSAFE", "session tree contains a symlink", { file }); if (stat.isDirectory()) walk(file); else if (stat.isFile() && name.endsWith(`${sessionId}.jsonl`)) matches.push(file); } };
  walk(root);
  if (matches.length !== 1) fail("D3_PUB_SESSION_PATH_AMBIGUOUS", "trusted session path is absent or ambiguous", { sessionId, matches });
  return matches[0]!;
}

function readManifestAtLink(root: string, link: string): Record<string, unknown> { const relative = safeRelative(link); return parseCanonical(readExactRegular(path.join(root, ...relative.split("/"), "manifest.json"), "legacy manifest"), "legacy manifest"); }
function readSymlinkMaybe(file: string): string | null { const stat = lstatMaybe(file); if (!stat) return null; if (!stat.isSymbolicLink()) fail("D3_PUB_LEGACY_POINTER_INVALID", "legacy latest is not a symlink", { file }); return fs.readlinkSync(file); }
function parseCanonical(raw: Buffer, label: string): Record<string, unknown> { let value: unknown; try { value = JSON.parse(raw.toString("utf8")); } catch (error) { fail("D3_PUB_PREVIEW_JSON_INVALID", `${label} is invalid JSON`, { error: errorMessage(error) }); } const record = asRecord(value, label); if (canonicalJson(record) !== raw.toString("utf8")) fail("D3_PUB_PREVIEW_JSON_NONCANONICAL", `${label} is not RFC8785-JCS plus LF`); return record; }
function canonicalJson(value: unknown): string { return `${canonicalizeJcs(value)}\n`; }
function safeRelative(value: string): string { if (!value || path.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..") || value.includes("\\")) fail("D3_PUB_CAPSULE_PATH_INVALID", "repository-relative path differs", { value }); return value; }
function exactDirectory(input: string, label: string): string { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) fail("D3_PUB_PREVIEW_DIRECTORY_UNSAFE", `${label} must be an exact directory`, { resolved }); return resolved; }
function readExactRegular(fileInput: string, label: string): Buffer { const file = path.resolve(fileInput); const named = fs.lstatSync(file); if (named.isSymbolicLink() || !named.isFile()) fail("D3_PUB_PREVIEW_FILE_UNSAFE", `${label} is not a no-follow regular file`); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const before = fs.fstatSync(fd); const raw = fs.readFileSync(fd); const after = fs.fstatSync(fd); const current = fs.lstatSync(file); if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || raw.length !== before.size || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) fail("D3_PUB_PREVIEW_FILE_RACE", `${label} changed while read`); return raw; } finally { fs.closeSync(fd); } }
function writeAll(fd: number, raw: Buffer): void { let offset = 0; while (offset < raw.length) { const wrote = fs.writeSync(fd, raw, offset, raw.length - offset, offset); if (wrote <= 0) fail("D3_PUB_EVIDENCE_SHORT_WRITE", "evidence write made no progress"); offset += wrote; } }
function fsyncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("D3_PUB_PREVIEW_SHAPE_INVALID", `${label} must be an object`); return value as Record<string, unknown>; }
function asArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) fail("D3_PUB_PREVIEW_SHAPE_INVALID", `${label} must be an array`); return value; }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; } }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new D3PubPreviewError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
