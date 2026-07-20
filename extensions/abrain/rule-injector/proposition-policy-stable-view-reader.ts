import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROPOSITION_POLICY_STABLE_VIEW_COMPILER_ARTIFACT_NAMES,
  PROPOSITION_POLICY_STABLE_VIEW_CONTRACT_RELATIVE,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_PAYLOAD_UTF8_BYTES,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_STATEMENT_UTF8_BYTES,
  buildPropositionPolicyStableViewCompilerManifestBase,
} from "../../_shared/proposition-policy-stable-view-contract";

export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_ROOT_RELATIVE = ".state/sediment/proposition-policy-stable-view/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MANIFEST_SCHEMA = "proposition-policy-stable-view-publication-manifest/v2" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_READ_BYTES_LIMIT = PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_STALE_DIAGNOSTIC_AFTER_MS = 24 * 60 * 60 * 1_000;

const DEFAULT_MAX_READ_BYTES = PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES;
const MANIFEST_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with bundle_hash and manifest_hash omitted";
const POLICY_SET_DECISION = "validated_active_original_policy_candidates";
const POLICY_SET_DECISION_SCHEMA = "proposition-policy-stable-view-policy-set-decision/v1";
const EMPTY_DECISION = "empty-source/no-decision/v1";
const ACCEPTED_PROFILE_HASH = "aa229d1703e2856ec92a19ff171fe49a145459a915500f362a20b4b2625d8ecd";
const PROFILE_RELATIVE = "schemas/proposition-policy-stable-view-compile-profile-v1.json";
const PUBLISHER_RELATIVE = "extensions/_shared/proposition-policy-stable-view-publisher.ts";
const PRODUCTION_AUTHORITY = "production_policy_stable_view_sole_rule_source_for_all_persisted_main_sessions";
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"] as const);
const NON_MANIFEST_NAMES = Object.freeze(["diagnostics.json", "parity.json", "view.json", "view.md"] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_ITEMS = PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_STATEMENT_BYTES = PROPOSITION_POLICY_STABLE_VIEW_MAX_STATEMENT_UTF8_BYTES;
export const PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_PAYLOAD_BYTES = PROPOSITION_POLICY_STABLE_VIEW_MAX_PAYLOAD_UTF8_BYTES;

type ArtifactName = typeof ARTIFACT_NAMES[number];

export interface PropositionPolicyStableViewInjectionSettings {
  maxReadBytes: number;
}

export interface PropositionPolicyStableViewSelection {
  selected: boolean;
  reason: "ephemeral_session" | "persisted_main_session";
  sessionId?: string;
}

interface SelectionDiagnostic {
  bundleHash?: string;
  selectionPublishedAtMs?: number;
  selectionAgeMs?: number;
  selectionStale?: boolean;
}

export type PropositionPolicyStableViewRuntimeReadResult =
  | {
    ok: true;
    reason: "selected_valid";
    sessionId: string;
    bundleHash: string;
    manifestHash: string;
    sourcePath: string;
    selectionPublishedAtMs: number;
    selectionAgeMs: number;
    selectionStale: boolean;
    viewMd: string;
    viewBytes: number;
    itemCount: number;
  }
  | ({
    ok: false;
    reason: string;
    sessionId?: string;
    error?: string;
  } & SelectionDiagnostic);

export class PropositionPolicyStableViewReaderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyStableViewReaderError";
    this.code = code;
  }
}

export function resolvePropositionPolicyStableViewInjectionSettings(value: unknown): PropositionPolicyStableViewInjectionSettings {
  const cfg = recordOptional(value) ?? {};
  const requestedMax = typeof cfg.maxReadBytes === "number" && Number.isFinite(cfg.maxReadBytes)
    ? Math.floor(cfg.maxReadBytes)
    : DEFAULT_MAX_READ_BYTES;
  return {
    maxReadBytes: Math.max(1_024, Math.min(PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_READ_BYTES_LIMIT, requestedMax)),
  };
}

export function selectPropositionPolicyStableViewSession(args: {
  settings?: PropositionPolicyStableViewInjectionSettings;
  sessionManager?: unknown;
}): PropositionPolicyStableViewSelection {
  const manager = args.sessionManager as {
    isPersisted?(): unknown;
    getSessionId?(): unknown;
    getSessionFile?(): unknown;
  } | undefined;
  if (!manager || typeof manager.getSessionId !== "function") return { selected: false, reason: "ephemeral_session" };
  try {
    const rawId = manager.getSessionId();
    if (typeof rawId !== "string" || rawId.length === 0) return { selected: false, reason: "ephemeral_session" };
    const persisted = typeof manager.isPersisted === "function"
      ? manager.isPersisted() === true
      : (() => {
        if (typeof manager.getSessionFile !== "function") return false;
        const file = manager.getSessionFile();
        return typeof file === "string" && file.length > 0;
      })();
    if (!persisted) return { selected: false, reason: "ephemeral_session", sessionId: rawId };
    return { selected: true, reason: "persisted_main_session", sessionId: rawId };
  } catch {
    return { selected: false, reason: "ephemeral_session" };
  }
}

export function readPropositionPolicyStableViewForRuntime(args: {
  abrainHome: string;
  settings: PropositionPolicyStableViewInjectionSettings;
  sessionManager?: unknown;
  activeProjectId?: string;
  nowMs?: number;
  /** Test-only observation point after the immutable latest target is captured. */
  hooks?: { afterLatestCapture?: (latestValue: string) => void };
}): PropositionPolicyStableViewRuntimeReadResult {
  const selection = selectPropositionPolicyStableViewSession({ settings: args.settings, sessionManager: args.sessionManager });
  if (!selection.selected || !selection.sessionId) {
    return { ok: false, reason: selection.reason, ...(selection.sessionId ? { sessionId: selection.sessionId } : {}) };
  }
  let diagnostic: SelectionDiagnostic = {};
  try {
    const abrainHome = exactDirectory(args.abrainHome.replace(/^~(?=$|\/)/, os.homedir()), "abrain home");
    const root = path.join(abrainHome, ...PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_ROOT_RELATIVE.split("/"));
    exactDirectory(root, "stable-view root");
    const rootNames = fs.readdirSync(root).sort(compareCodeUnits);
    if (canonicalize(rootNames) !== canonicalize(["bundles", "latest"])) fail("foreign_root", "stable-view root is not exact bundles plus latest");
    const bundlesRoot = path.join(root, "bundles");
    exactDirectory(bundlesRoot, "stable-view bundles root");

    // Capture latest exactly once. Every subsequent read is anchored to this
    // immutable content-addressed directory even if latest advances concurrently.
    const latest = path.join(root, "latest");
    assertAncestorsNoSymlink(latest);
    let latestStat: fs.Stats;
    try { latestStat = fs.lstatSync(latest); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("latest_missing", "stable-view latest is missing");
      throw error;
    }
    if (!latestStat.isSymbolicLink()) fail("latest_not_symlink", "stable-view latest is not a symlink");
    const latestValue = fs.readlinkSync(latest);
    const match = /^bundles\/([0-9a-f]{64})$/.exec(latestValue);
    if (!match || path.isAbsolute(latestValue) || latestValue.includes("..")) fail("latest_invalid", "latest is not a direct relative content-addressed reference");
    args.hooks?.afterLatestCapture?.(latestValue);
    const bundleHash = match[1]!;
    const selectionPublishedAtMs = Math.max(latestStat.mtimeMs, latestStat.ctimeMs);
    const selectionAgeMs = Math.max(0, (args.nowMs ?? Date.now()) - selectionPublishedAtMs);
    if (!Number.isFinite(selectionPublishedAtMs) || !Number.isFinite(selectionAgeMs)) fail("selection_time_invalid", "latest publication time is invalid");
    diagnostic = {
      bundleHash,
      selectionPublishedAtMs,
      selectionAgeMs,
      selectionStale: selectionAgeMs > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_STALE_DIAGNOSTIC_AFTER_MS,
    };

    const bundleDir = path.join(bundlesRoot, bundleHash);
    exactDirectory(bundleDir, "stable-view bundle");
    const names = fs.readdirSync(bundleDir).sort(compareCodeUnits);
    if (canonicalize(names) !== canonicalize([...ARTIFACT_NAMES].sort(compareCodeUnits))) fail("partial_or_foreign", "stable-view bundle is not exact all-five");

    const artifacts = {} as Record<ArtifactName, string>;
    let totalBytes = 0;
    for (const name of ARTIFACT_NAMES) {
      const file = path.join(bundleDir, name);
      const stat = exactRegularFile(file, "stable-view artifact");
      totalBytes += stat.size;
      if (stat.size > PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES
        || totalBytes > PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES
        || stat.size > args.settings.maxReadBytes || totalBytes > args.settings.maxReadBytes) {
        fail("oversize", "stable-view artifact set exceeds its hard read envelope");
      }
      artifacts[name] = fs.readFileSync(file, "utf8");
    }
    const manifest = parseCanonicalJson(artifacts["manifest.json"], "manifest.json");
    const view = parseCanonicalJson(artifacts["view.json"], "view.json");
    const diagnostics = parseCanonicalJson(artifacts["diagnostics.json"], "diagnostics.json");
    const parity = parseCanonicalJson(artifacts["parity.json"], "parity.json");
    validateManifest({ manifest, bundleHash, artifacts });
    const rendered = validateViewAndParity({ manifest, view, diagnostics, parity, viewMd: artifacts["view.md"], activeProjectId: args.activeProjectId });
    if (rendered.viewBytes > args.settings.maxReadBytes) fail("oversize", "filtered runtime payload exceeds maxReadBytes");
    return {
      ok: true,
      reason: "selected_valid",
      sessionId: selection.sessionId,
      bundleHash,
      manifestHash: String(manifest.manifest_hash),
      sourcePath: path.join(bundleDir, "view.md"),
      selectionPublishedAtMs,
      selectionAgeMs,
      selectionStale: diagnostic.selectionStale === true,
      viewMd: rendered.viewMd,
      viewBytes: rendered.viewBytes,
      itemCount: rendered.itemCount,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof PropositionPolicyStableViewReaderError ? error.code : "read_failed",
      sessionId: selection.sessionId,
      ...diagnostic,
      error: controlledError(error),
    };
  }
}

function validateManifest(input: {
  manifest: Record<string, unknown>;
  bundleHash: string;
  artifacts: Record<ArtifactName, string>;
}): void {
  const manifest = input.manifest;
  exactKeys(manifest, ["schema_version", "canonicalization", "hash_algorithm", "bundle_hash_scope", "manifest_hash_scope", "authority", "canonical_source", "projection", "candidate_dispositions", "compiler", "stable_view", "bundle_hash", "manifest_hash"], "manifest");
  if (manifest.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MANIFEST_SCHEMA
    || manifest.canonicalization !== "RFC8785-JCS"
    || manifest.hash_algorithm !== "sha256"
    || manifest.bundle_hash_scope !== MANIFEST_HASH_SCOPE
    || manifest.manifest_hash_scope !== MANIFEST_HASH_SCOPE
    || manifest.authority !== PRODUCTION_AUTHORITY
    || manifest.bundle_hash !== input.bundleHash
    || manifest.manifest_hash !== input.bundleHash) fail("manifest_identity", "manifest identity, directory hash, or authority differs");
  const manifestBase = clone(manifest);
  delete manifestBase.bundle_hash;
  delete manifestBase.manifest_hash;
  if (jcsSha256(manifestBase) !== input.bundleHash) fail("manifest_hash_mismatch", "manifest self-hash differs");

  const source = record(manifest.canonical_source, "manifest.canonical_source");
  exactKeys(source, ["truth", "input_event_count", "input_event_ids", "input_event_ids_hash", "input_event_rows", "input_event_rows_hash", "physical_accounting"], "manifest.canonical_source");
  const inputIds = stringArray(source.input_event_ids, "manifest.canonical_source.input_event_ids");
  assertSortedUniqueHashes(inputIds, "manifest.canonical_source.input_event_ids", false);
  if (source.truth !== "canonical_production_l1_only" || source.input_event_count !== inputIds.length
    || inputIds.length > PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS || source.input_event_ids_hash !== jcsSha256(inputIds)) fail("source_provenance", "canonical source event ID closure is invalid or over limit");
  const sourceRows = array(source.input_event_rows, "manifest.canonical_source.input_event_rows");
  if (sourceRows.length !== inputIds.length || source.input_event_rows_hash !== jcsSha256(sourceRows)) fail("source_provenance", "canonical source raw row closure differs");
  const rowIds: string[] = [];
  for (const [index, raw] of sourceRows.entries()) {
    const row = record(raw, `manifest.canonical_source.input_event_rows[${index}]`);
    exactKeys(row, ["event_id", "relative_path", "bytes", "raw_sha256"], `manifest.canonical_source.input_event_rows[${index}]`);
    assertSha256(row.event_id, "source event id");
    assertSha256(row.raw_sha256, "source raw hash");
    if (!isCount(row.bytes, false)
      || row.relative_path !== `l1/events/sha256/${String(row.event_id).slice(0, 2)}/${String(row.event_id).slice(2, 4)}/${row.event_id}.json`) fail("source_provenance", "canonical source raw row is malformed");
    rowIds.push(String(row.event_id));
  }
  if (canonicalize(rowIds) !== canonicalize(inputIds)) fail("source_provenance", "canonical source raw rows are reordered or foreign");
  const accounting = record(source.physical_accounting, "manifest.canonical_source.physical_accounting");
  exactKeys(accounting, ["genesis_event_ids", "genesis_event_ids_hash", "evidence_event_ids", "evidence_event_ids_hash", "lifecycle_event_ids", "lifecycle_event_ids_hash", "observed_only_event_ids", "observed_only_event_ids_hash"], "manifest.canonical_source.physical_accounting");
  const genesisIds = stringArray(accounting.genesis_event_ids, "manifest.canonical_source.physical_accounting.genesis_event_ids");
  const evidenceIds = stringArrayAllowEmpty(accounting.evidence_event_ids, "manifest.canonical_source.physical_accounting.evidence_event_ids");
  const lifecycleIds = stringArrayAllowEmpty(accounting.lifecycle_event_ids, "manifest.canonical_source.physical_accounting.lifecycle_event_ids");
  const observedOnlyIds = stringArray(accounting.observed_only_event_ids, "manifest.canonical_source.physical_accounting.observed_only_event_ids");
  for (const [at, values] of [["genesis_event_ids", genesisIds], ["evidence_event_ids", evidenceIds], ["lifecycle_event_ids", lifecycleIds], ["observed_only_event_ids", observedOnlyIds]] as const) assertSortedUniqueHashes(values, `manifest.canonical_source.physical_accounting.${at}`, at !== "genesis_event_ids");
  const expectedObservedOnly = [...genesisIds, ...lifecycleIds].sort(compareCodeUnits);
  const expectedPhysical = [...genesisIds, ...evidenceIds, ...lifecycleIds].sort(compareCodeUnits);
  if (genesisIds.length !== 1 || canonicalize(observedOnlyIds) !== canonicalize(expectedObservedOnly)
    || canonicalize(expectedPhysical) !== canonicalize(inputIds) || new Set([...genesisIds, ...evidenceIds, ...lifecycleIds]).size !== inputIds.length
    || accounting.genesis_event_ids_hash !== jcsSha256(genesisIds)
    || accounting.evidence_event_ids_hash !== jcsSha256(evidenceIds)
    || accounting.lifecycle_event_ids_hash !== jcsSha256(lifecycleIds)
    || accounting.observed_only_event_ids_hash !== jcsSha256(observedOnlyIds)) fail("source_provenance", "physical proposition partitions or observed-only accounting differ");

  const projection = record(manifest.projection, "manifest.projection");
  exactKeys(projection, ["builder", "bundle_hash", "source_counts", "result", "source_resolution_inventory_hash", "artifact_rows"], "manifest.projection");
  const sourceCounts = record(projection.source_counts, "manifest.projection.source_counts");
  exactKeys(sourceCounts, ["proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count"], "manifest.projection.source_counts");
  const projectionResult = record(projection.result, "manifest.projection.result");
  exactKeys(projectionResult, ["entry_count", "exclusion_count", "diagnostic_count"], "manifest.projection.result");
  assertSha256(projection.bundle_hash, "manifest.projection.bundle_hash");
  assertSha256(projection.source_resolution_inventory_hash, "manifest.projection.source_resolution_inventory_hash");
  for (const value of [...Object.values(sourceCounts), ...Object.values(projectionResult)]) if (!isCount(value, true)) fail("projection_provenance", "P2a source/projection count is invalid");
  if (projection.builder !== "buildPropositionPolicyPushShadow"
    || sourceCounts.proposition_event_count !== inputIds.length
    || sourceCounts.proposition_genesis_count !== genesisIds.length
    || sourceCounts.proposition_evidence_count !== evidenceIds.length
    || sourceCounts.proposition_lifecycle_count !== lifecycleIds.length
    || Number(sourceCounts.proposition_event_count) !== Number(sourceCounts.proposition_genesis_count) + Number(sourceCounts.proposition_evidence_count) + Number(sourceCounts.proposition_lifecycle_count)
    || sourceCounts.proposition_evidence_count !== Number(projectionResult.entry_count) + Number(projectionResult.exclusion_count)
    || sourceCounts.proposition_selected_count !== 0 || sourceCounts.proposition_foldable_count !== 0
    || projectionResult.diagnostic_count !== projectionResult.exclusion_count) fail("projection_provenance", "P2a physical input or disposition accounting differs");
  validateArtifactRows(array(projection.artifact_rows, "manifest.projection.artifact_rows"), ["diagnostics.json", "entries.json", "exclusions.json"]);

  const candidate = record(manifest.candidate_dispositions, "manifest.candidate_dispositions");
  exactKeys(candidate, ["basis", "candidate_count", "dispositions", "dispositions_hash", "semantic_inference_performed", "canonical_event_mutated", "decision_l1_event_created"], "manifest.candidate_dispositions");
  const candidateRows = array(candidate.dispositions, "manifest.candidate_dispositions.dispositions").map((raw, index) => {
    const row = record(raw, `manifest.candidate_dispositions.dispositions[${index}]`);
    exactKeys(row, ["source_event_id", "disposition"], `manifest.candidate_dispositions.dispositions[${index}]`);
    assertSha256(row.source_event_id, `manifest.candidate_dispositions.dispositions[${index}].source_event_id`);
    if (row.disposition !== "included" && row.disposition !== "excluded") fail("decision_provenance", "candidate disposition is outside included/excluded");
    return row;
  });
  assertSortedUniqueHashes(candidateRows.map((row) => String(row.source_event_id)), "manifest.candidate_dispositions source IDs", true);
  if (candidate.basis !== POLICY_SET_DECISION || candidate.candidate_count !== candidateRows.length
    || candidateRows.length !== projectionResult.entry_count || candidate.dispositions_hash !== jcsSha256(candidateRows)
    || candidate.semantic_inference_performed !== false || candidate.canonical_event_mutated !== false
    || candidate.decision_l1_event_created !== false) fail("decision_provenance", "candidate disposition closure differs");

  const compiler = record(manifest.compiler, "manifest.compiler");
  exactKeys(compiler, ["api", "compile_key", "decision_identity", "compiler_output_manifest_hash", "compiler_output_manifest_raw_sha256", "compile_profile", "source_closure"], "manifest.compiler");
  for (const field of ["compile_key", "compiler_output_manifest_hash", "compiler_output_manifest_raw_sha256"] as const) assertSha256(compiler[field], `manifest.compiler.${field}`);
  const expectedDecisionIdentity = candidateRows.length === 0 ? EMPTY_DECISION : jcsSha256({
    schema_version: POLICY_SET_DECISION_SCHEMA,
    basis: POLICY_SET_DECISION,
    source_bundle_hash: projection.bundle_hash,
    candidate_dispositions: candidateRows,
  });
  const expectedCompileKey = jcsSha256({
    source_bundle_hash: projection.bundle_hash,
    compile_profile_hash: ACCEPTED_PROFILE_HASH,
    accepted_decision_hash_or_empty_sentinel: expectedDecisionIdentity,
  });
  if (compiler.api !== "compilePropositionPolicyStableView"
    || compiler.decision_identity !== expectedDecisionIdentity
    || compiler.compile_key !== expectedCompileKey) fail("compiler_identity", "compiler API, decision identity, or compile key differs");
  const profile = record(compiler.compile_profile, "manifest.compiler.compile_profile");
  exactKeys(profile, ["relative_path", "profile_hash", "raw_sha256", "bytes"], "manifest.compiler.compile_profile");
  if (profile.relative_path !== PROFILE_RELATIVE || profile.profile_hash !== ACCEPTED_PROFILE_HASH || !isCount(profile.bytes, false)) fail("compiler_profile", "compile profile identity differs");
  assertSha256(profile.raw_sha256, "manifest.compiler.compile_profile.raw_sha256");
  validateSourceClosure(compiler.source_closure, String(profile.raw_sha256));

  const stable = record(manifest.stable_view, "manifest.stable_view");
  exactKeys(stable, ["result_kind", "item_count", "item_hashes", "item_hashes_hash", "scope_summary", "source_closure", "injectable_payload_utf8_bytes", "renderer", "artifact_set", "artifact_names", "non_manifest_artifact_rows", "manifest_artifact_identity"], "manifest.stable_view");
  const itemHashes = stringArrayAllowEmpty(stable.item_hashes, "manifest.stable_view.item_hashes");
  itemHashes.forEach((value, index) => assertSha256(value, `manifest.stable_view.item_hashes[${index}]`));
  if (!isCount(stable.item_count, true) || Number(stable.item_count) > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_ITEMS
    || stable.item_count !== itemHashes.length || stable.item_hashes_hash !== jcsSha256(itemHashes)
    || stable.result_kind !== (itemHashes.length === 0 ? "ready_empty" : "ready_nonempty")
    || !isCount(stable.injectable_payload_utf8_bytes, true)
    || stable.renderer !== "ordered-statements-double-newline-terminal-newline-v1"
    || stable.artifact_set !== "all_five_or_none"
    || canonicalize(stable.artifact_names) !== canonicalize(ARTIFACT_NAMES)
    || stable.manifest_artifact_identity !== "manifest_hash_self_preimage_sha256") fail("stable_contract", "stable-view bounded all-five or rendering contract differs");
  const scopeSummary = record(stable.scope_summary, "manifest.stable_view.scope_summary");
  exactKeys(scopeSummary, ["global_item_count", "project_item_count", "project_ids", "project_ids_hash"], "manifest.stable_view.scope_summary");
  const projectIds = stringArrayAllowEmpty(scopeSummary.project_ids, "manifest.stable_view.scope_summary.project_ids");
  assertSortedUniqueStrings(projectIds, "manifest.stable_view.scope_summary.project_ids", true);
  if (!isCount(scopeSummary.global_item_count, true) || !isCount(scopeSummary.project_item_count, true)
    || Number(scopeSummary.global_item_count) + Number(scopeSummary.project_item_count) !== itemHashes.length
    || scopeSummary.project_ids_hash !== jcsSha256(projectIds)) fail("stable_contract", "stable scope summary is invalid");
  const sourceClosure = record(stable.source_closure, "manifest.stable_view.source_closure");
  exactKeys(sourceClosure, ["source_event_count", "source_event_ids_hash", "dispositions_hash", "diagnostic_count", "diagnostics_hash"], "manifest.stable_view.source_closure");
  for (const field of ["source_event_ids_hash", "dispositions_hash", "diagnostics_hash"] as const) assertSha256(sourceClosure[field], `manifest.stable_view.source_closure.${field}`);
  if (sourceClosure.source_event_count !== Number(projectionResult.entry_count) + Number(projectionResult.exclusion_count)
    || sourceClosure.diagnostic_count !== projectionResult.diagnostic_count) fail("stable_contract", "stable source closure counts differ from P2a projection");
  const rows = array(stable.non_manifest_artifact_rows, "manifest.stable_view.non_manifest_artifact_rows");
  validateArtifactRows(rows, NON_MANIFEST_NAMES);
  const expectedRows = NON_MANIFEST_NAMES.map((name) => ({ name, bytes: Buffer.byteLength(input.artifacts[name]), sha256: sha256(input.artifacts[name]) }));
  if (canonicalize(rows) !== canonicalize(expectedRows)) fail("artifact_hash_mismatch", "stable-view artifact hashes differ from exact bytes");
}

function validateSourceClosure(value: unknown, profileRawSha256: string): void {
  const closure = record(value, "manifest.compiler.source_closure");
  exactKeys(closure, ["schema_version", "parser", "scope", "roots", "explicit_files", "files", "unresolved_dynamic_loaders", "graph_hash"], "manifest.compiler.source_closure");
  if (closure.schema_version !== "typescript-static-dependency-graph/v1"
    || closure.parser !== "typescript-compiler-api"
    || closure.scope !== "reachable_static_local_modules_plus_explicit_files"
    || canonicalize(closure.roots) !== canonicalize([PUBLISHER_RELATIVE])
    || canonicalize(closure.explicit_files) !== canonicalize([PROFILE_RELATIVE])
    || !Array.isArray(closure.unresolved_dynamic_loaders)
    || closure.unresolved_dynamic_loaders.length !== 0) fail("source_closure", "compiler source closure identity differs");
  assertSha256(closure.graph_hash, "manifest.compiler.source_closure.graph_hash");
  const base = clone(closure);
  delete base.graph_hash;
  if (jcsSha256(base) !== closure.graph_hash) fail("source_closure", "compiler source closure self-hash differs");
  const files = array(closure.files, "manifest.compiler.source_closure.files");
  const paths: string[] = [];
  for (const [index, raw] of files.entries()) {
    const row = record(raw, `manifest.compiler.source_closure.files[${index}]`);
    exactKeys(row, ["path", "bytes", "sha256", "local_dependencies"], `manifest.compiler.source_closure.files[${index}]`);
    if (typeof row.path !== "string" || !row.path || !Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0 || !Array.isArray(row.local_dependencies)) fail("source_closure", "compiler source row shape differs");
    assertSha256(row.sha256, "compiler source row hash");
    paths.push(row.path);
    if (row.path === PROFILE_RELATIVE && row.sha256 !== profileRawSha256) fail("source_closure", "profile raw hash differs from source closure");
  }
  const required = [PUBLISHER_RELATIVE, PROPOSITION_POLICY_STABLE_VIEW_CONTRACT_RELATIVE, "extensions/_shared/proposition-policy-stable-view.ts", "extensions/_shared/proposition-policy-push-shadow.ts", PROFILE_RELATIVE];
  if (new Set(paths).size !== paths.length || paths.some((value, index) => index > 0 && compareCodeUnits(paths[index - 1]!, value) >= 0)
    || required.some((requiredPath) => !paths.includes(requiredPath))) fail("source_closure", "compiler source closure paths are duplicate, reordered, or incomplete");
}

function validateViewAndParity(input: {
  manifest: Record<string, unknown>;
  view: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  parity: Record<string, unknown>;
  viewMd: string;
  activeProjectId?: string;
}): { viewMd: string; viewBytes: number; itemCount: number } {
  const compiler = record(input.manifest.compiler, "manifest.compiler");
  const projection = record(input.manifest.projection, "manifest.projection");
  const projectionResult = record(projection.result, "manifest.projection.result");
  const canonicalSource = record(input.manifest.canonical_source, "manifest.canonical_source");
  const physicalAccounting = record(canonicalSource.physical_accounting, "manifest.canonical_source.physical_accounting");
  const canonicalEvidenceIds = stringArrayAllowEmpty(physicalAccounting.evidence_event_ids, "manifest.canonical_source.physical_accounting.evidence_event_ids");
  const candidate = record(input.manifest.candidate_dispositions, "manifest.candidate_dispositions");
  const candidateRows = array(candidate.dispositions, "manifest.candidate_dispositions.dispositions").map((raw, index) => record(raw, `candidate disposition[${index}]`));
  const candidateBySource = new Map(candidateRows.map((row) => [String(row.source_event_id), row]));
  const stable = record(input.manifest.stable_view, "manifest.stable_view");
  exactKeys(input.view, ["schema_version", "compile_key", "source_bundle_hash", "compile_profile_hash", "decision_identity", "fixture_synthetic", "result_kind", "items", "injectable_payload_utf8_bytes", "injectable_payload_sha256"], "view.json");
  if (input.view.schema_version !== "proposition-policy-stable-view/v1"
    || input.view.compile_key !== compiler.compile_key
    || input.view.source_bundle_hash !== projection.bundle_hash
    || input.view.compile_profile_hash !== ACCEPTED_PROFILE_HASH
    || input.view.decision_identity !== compiler.decision_identity
    || input.view.fixture_synthetic !== false
    || input.view.result_kind !== stable.result_kind) fail("view_identity", "view identity differs from publication manifest");
  const items = array(input.view.items, "view.items").map((raw, index) => record(raw, `view.items[${index}]`));
  if (items.length !== stable.item_count || items.length > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_ITEMS) fail("item_limit", "runtime stable view item count differs or exceeds the hard limit");

  const itemBySource = new Map<string, Record<string, unknown>>();
  const itemScopes = new Map<Record<string, unknown>, { level: "global" | "project"; projectId: string | null }>();
  const itemHashes: string[] = [];
  for (const [index, item] of items.entries()) {
    const at = `view.items[${index}]`;
    exactKeys(item, ["item_id", "statement", "statement_sha256", "scope", "scope_sha256", "source_event_ids", "source_lineage", "source_provenance", "item_payload_sha256"], at);
    for (const field of ["item_id", "statement_sha256", "scope_sha256", "item_payload_sha256"] as const) assertSha256(item[field], `${at}.${field}`);
    if (typeof item.statement !== "string" || !item.statement.length || item.statement_sha256 !== sha256(item.statement)) fail("view_provenance", "view item statement or statement hash differs");
    if (Buffer.byteLength(item.statement) > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_STATEMENT_BYTES) fail("statement_oversize", "view item statement exceeds the accepted compile profile hard limit");
    const scope = validateRuntimeScope(item.scope, at);
    if (item.scope_sha256 !== jcsSha256(item.scope)) fail("view_item_hash", "view item scope hash differs");
    const sourceIds = stringArray(item.source_event_ids, `${at}.source_event_ids`);
    assertSortedUniqueHashes(sourceIds, `${at}.source_event_ids`, false);
    const lineageRows = array(item.source_lineage, `${at}.source_lineage`).map((raw, rowIndex) => record(raw, `${at}.source_lineage[${rowIndex}]`));
    const provenanceRows = array(item.source_provenance, `${at}.source_provenance`).map((raw, rowIndex) => record(raw, `${at}.source_provenance[${rowIndex}]`));
    if (sourceIds.length !== 1 || lineageRows.length !== 1 || provenanceRows.length !== 1) fail("view_provenance", "real item must bind exactly one source provenance row");
    const sourceId = sourceIds[0]!;
    const provenance = provenanceRows[0]!;
    exactKeys(provenance, ["source_event_id", "source_body_sha256", "statement_sha256", "scope_sha256", "lineage_event_ids", "lifecycle_disposition", "lifecycle_activation", "lifecycle_terminal_event_id"], `${at}.source_provenance[0]`);
    for (const field of ["source_event_id", "source_body_sha256", "statement_sha256", "scope_sha256", "lifecycle_terminal_event_id"] as const) assertSha256(provenance[field], `${at}.source_provenance[0].${field}`);
    const lineageIds = stringArrayAllowEmpty(provenance.lineage_event_ids, `${at}.source_provenance[0].lineage_event_ids`);
    assertUniqueStrings(lineageIds, `${at}.source_provenance[0].lineage_event_ids`);
    const lineage = lineageRows[0]!;
    exactKeys(lineage, ["source_event_id", "lineage_event_ids"], `${at}.source_lineage[0]`);
    if (sourceId !== provenance.source_event_id || provenance.source_body_sha256 !== sourceId
      || provenance.statement_sha256 !== item.statement_sha256 || provenance.scope_sha256 !== item.scope_sha256
      || provenance.lifecycle_disposition !== "active" || provenance.lifecycle_activation !== "original"
      || lineage.source_event_id !== sourceId || canonicalize(lineage.lineage_event_ids) !== canonicalize(lineageIds)
      || candidateBySource.get(sourceId)?.disposition !== "included") fail("view_provenance", "item source/body/statement/scope/lineage/lifecycle closure differs");
    const expectedItemId = jcsSha256({ identity: `included:${sourceId}`, source_event_ids: [sourceId] });
    const itemBase = clone(item);
    delete itemBase.item_payload_sha256;
    if (item.item_id !== expectedItemId || item.item_payload_sha256 !== jcsSha256(itemBase)) fail("view_item_hash", "view item ID or payload self-hash differs");
    if (itemBySource.has(sourceId)) fail("view_provenance", "duplicate source provenance across items");
    itemBySource.set(sourceId, item);
    itemScopes.set(item, scope);
    itemHashes.push(String(item.item_payload_sha256));
  }
  if (items.some((item, index) => index > 0 && compareCodeUnits(String(items[index - 1]!.item_id), String(item.item_id)) >= 0)
    || canonicalize(itemHashes) !== canonicalize(stable.item_hashes)) fail("view_item_hash", "view items or item hashes are duplicate/reordered");
  const expectedMd = items.length === 0 ? "" : `${items.map((item) => String(item.statement)).join("\n\n")}\n`;
  if (input.viewMd !== expectedMd
    || input.view.injectable_payload_utf8_bytes !== Buffer.byteLength(expectedMd)
    || input.view.injectable_payload_sha256 !== sha256(expectedMd)
    || stable.injectable_payload_utf8_bytes !== Buffer.byteLength(expectedMd)) fail("view_md_mismatch", "view.md is not the exact full rendering of view.json items");
  if (Buffer.byteLength(expectedMd) > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_PAYLOAD_BYTES) fail("payload_oversize", "full stable payload exceeds the accepted compile profile hard limit");
  const scopeSummary = record(stable.scope_summary, "manifest.stable_view.scope_summary");
  const projectIds = [...new Set([...itemScopes.values()].filter((scope) => scope.level === "project").map((scope) => String(scope.projectId)))].sort(compareCodeUnits);
  const globalCount = [...itemScopes.values()].filter((scope) => scope.level === "global").length;
  if (scopeSummary.global_item_count !== globalCount || scopeSummary.project_item_count !== items.length - globalCount
    || canonicalize(scopeSummary.project_ids) !== canonicalize(projectIds) || scopeSummary.project_ids_hash !== jcsSha256(projectIds)) fail("scope_invalid", "scope summary differs from exact view items");

  exactKeys(input.diagnostics, ["schema_version", "compile_key", "diagnostics"], "diagnostics.json");
  const diagnostics = array(input.diagnostics.diagnostics, "diagnostics.diagnostics").map((raw, index) => record(raw, `diagnostics.diagnostics[${index}]`));
  if (input.diagnostics.schema_version !== "proposition-policy-stable-view-diagnostics/v1"
    || input.diagnostics.compile_key !== compiler.compile_key || diagnostics.length !== projectionResult.diagnostic_count) fail("diagnostics", "stable diagnostics identity or count differs");
  const diagnosticIds: string[] = [];
  for (const [index, diagnostic] of diagnostics.entries()) {
    exactKeys(diagnostic, ["code", "severity", "source_event_id", "filter_stage", "reason_code"], `diagnostics.diagnostics[${index}]`);
    assertSha256(diagnostic.source_event_id, `diagnostics.diagnostics[${index}].source_event_id`);
    if (diagnostic.code !== "POLICY_CANDIDATE_EXCLUDED" || diagnostic.severity !== "info"
      || diagnostic.filter_stage !== "stable_view_disposition" || diagnostic.reason_code !== "disposition_excluded"
      || candidateBySource.has(String(diagnostic.source_event_id))) fail("diagnostics", "stable diagnostic is foreign");
    diagnosticIds.push(String(diagnostic.source_event_id));
  }
  assertSortedUniqueHashes(diagnosticIds, "diagnostic source IDs", true);
  const candidateIds = [...candidateBySource.keys()].sort(compareCodeUnits);
  const candidateSet = new Set(candidateIds);
  const conservedEvidenceIds = [...candidateIds, ...diagnosticIds].sort(compareCodeUnits);
  if (diagnosticIds.some((sourceId) => candidateSet.has(sourceId))
    || canonicalize(conservedEvidenceIds) !== canonicalize(canonicalEvidenceIds)) {
    fail("source_conservation", "candidate and diagnostic source IDs must be disjoint and exactly partition canonical evidence IDs");
  }

  exactKeys(input.parity, ["schema_version", "compile_key", "source_conservation", "deterministic_render", "scope_lineage", "noninterference"], "parity.json");
  if (input.parity.schema_version !== "proposition-policy-stable-view-parity/v1" || input.parity.compile_key !== compiler.compile_key) fail("parity", "parity identity differs");
  const conservation = record(input.parity.source_conservation, "parity.source_conservation");
  exactKeys(conservation, ["source_event_count", "source_event_ids_hash", "dispositions", "dispositions_hash", "diagnostic_count", "diagnostics_hash"], "parity.source_conservation");
  const dispositions = array(conservation.dispositions, "parity.source_conservation.dispositions").map((raw, index) => record(raw, `parity disposition[${index}]`));
  const expectedUniverse = canonicalEvidenceIds;
  if (conservation.source_event_count !== expectedUniverse.length || conservation.source_event_ids_hash !== jcsSha256(expectedUniverse)
    || conservation.dispositions_hash !== jcsSha256(dispositions) || conservation.diagnostic_count !== diagnostics.length
    || conservation.diagnostics_hash !== jcsSha256(diagnostics) || dispositions.length !== expectedUniverse.length) fail("parity", "source conservation hash or count differs");
  for (const [index, disposition] of dispositions.entries()) {
    exactKeys(disposition, ["source_event_id", "disposition", "item_id", "filter_stage", "reason_code"], `parity disposition[${index}]`);
    const sourceId = String(disposition.source_event_id);
    if (sourceId !== expectedUniverse[index]) fail("parity", "source disposition is duplicate, reordered, or foreign");
    const item = itemBySource.get(sourceId);
    if (item) {
      if (disposition.disposition !== "included" || disposition.item_id !== item.item_id || disposition.filter_stage !== null || disposition.reason_code !== null) fail("parity", "included disposition differs");
    } else if (disposition.disposition !== "excluded" || disposition.item_id !== null
      || disposition.filter_stage !== "stable_view_disposition" || disposition.reason_code !== "disposition_excluded") fail("parity", "excluded disposition differs");
    if (candidateBySource.has(sourceId) && candidateBySource.get(sourceId)!.disposition !== disposition.disposition) fail("parity", "candidate disposition differs from manifest");
  }
  const parityDispositionBySource = new Map(dispositions.map((row) => [String(row.source_event_id), row]));
  for (const candidateRow of candidateRows) {
    const sourceId = String(candidateRow.source_event_id);
    const parityDisposition = parityDispositionBySource.get(sourceId);
    const item = itemBySource.get(sourceId);
    if (!parityDisposition || parityDisposition.disposition !== candidateRow.disposition
      || (candidateRow.disposition === "included" ? !item : !!item)) {
      fail("parity", "included/excluded candidates do not close bidirectionally with parity dispositions and view items");
    }
  }
  const stableSourceClosure = record(stable.source_closure, "manifest.stable_view.source_closure");
  if (canonicalize(stableSourceClosure) !== canonicalize({
    source_event_count: conservation.source_event_count,
    source_event_ids_hash: conservation.source_event_ids_hash,
    dispositions_hash: conservation.dispositions_hash,
    diagnostic_count: conservation.diagnostic_count,
    diagnostics_hash: conservation.diagnostics_hash,
  })) fail("parity", "manifest source closure differs from parity");
  validateCompilerOutputManifestBinding({
    compiler,
    projection,
    stable,
    view: input.view,
    diagnostics: input.diagnostics,
    parity: input.parity,
    viewMd: input.viewMd,
    sourceClosure: stableSourceClosure,
  });
  const render = record(input.parity.deterministic_render, "parity.deterministic_render");
  exactKeys(render, ["renderer", "item_count", "items_hash", "view_md_utf8_bytes", "view_md_sha256"], "parity.deterministic_render");
  if (render.renderer !== "ordered-statements-double-newline-terminal-newline-v1" || render.item_count !== items.length
    || render.items_hash !== jcsSha256(items) || render.view_md_utf8_bytes !== Buffer.byteLength(expectedMd) || render.view_md_sha256 !== sha256(expectedMd)) fail("parity", "deterministic render parity differs");
  const scopeLineage = record(input.parity.scope_lineage, "parity.scope_lineage");
  exactKeys(scopeLineage, ["source_entry_count", "commitments", "commitments_hash"], "parity.scope_lineage");
  const commitments = array(scopeLineage.commitments, "parity.scope_lineage.commitments").map((raw, index) => record(raw, `parity.scope_lineage.commitments[${index}]`));
  if (scopeLineage.source_entry_count !== candidateRows.length || commitments.length !== candidateRows.length
    || scopeLineage.commitments_hash !== jcsSha256(commitments)) fail("parity", "scope/lineage commitment count or hash differs");
  for (const [index, commitment] of commitments.entries()) {
    exactKeys(commitment, ["source_event_id", "source_body_sha256", "statement_sha256", "item_id", "scope_sha256", "lineage_event_ids_hash", "lineage_event_count", "lifecycle_disposition", "lifecycle_activation", "lifecycle_terminal_event_id"], `parity.scope_lineage.commitments[${index}]`);
    for (const field of ["source_event_id", "source_body_sha256", "statement_sha256", "scope_sha256", "lineage_event_ids_hash", "lifecycle_terminal_event_id"] as const) assertSha256(commitment[field], `parity.scope_lineage.commitments[${index}].${field}`);
    const candidateRow = candidateRows[index]!;
    const sourceId = String(commitment.source_event_id);
    const item = itemBySource.get(sourceId);
    const lifecycleActivation = commitment.lifecycle_activation;
    if (sourceId !== candidateRow.source_event_id || commitment.source_body_sha256 !== sourceId
      || commitment.item_id !== (item?.item_id ?? null) || !isCount(commitment.lineage_event_count, true)
      || commitment.lifecycle_disposition !== "active"
      || (lifecycleActivation !== "original" && lifecycleActivation !== "reactivated")
      || (candidateRow.disposition === "included" && lifecycleActivation !== "original")
      || (candidateRow.disposition === "included") !== !!item) fail("parity", "scope/lineage lifecycle commitment differs");
    if (item) {
      const provenance = record(array(item.source_provenance, "item.source_provenance")[0], "item.source_provenance[0]");
      if (commitment.statement_sha256 !== item.statement_sha256 || commitment.scope_sha256 !== item.scope_sha256
        || commitment.lineage_event_ids_hash !== jcsSha256(provenance.lineage_event_ids)
        || commitment.lineage_event_count !== array(provenance.lineage_event_ids, "item provenance lineage").length
        || commitment.lifecycle_terminal_event_id !== provenance.lifecycle_terminal_event_id) fail("parity", "included item differs from scope/lineage commitment");
    }
  }
  const noninterference = record(input.parity.noninterference, "parity.noninterference");
  exactKeys(noninterference, ["statement_keys_outside_view_items", "semantic_inference_operations", "external_authority_inputs", "source_statement_rewrites"], "parity.noninterference");
  if (Object.values(noninterference).some((value) => value !== 0)) fail("parity", "noninterference counters are nonzero");

  const selectedItems = items.filter((item) => {
    const scope = itemScopes.get(item)!;
    return scope.level === "global" || (scope.level === "project" && !!input.activeProjectId && scope.projectId === input.activeProjectId);
  });
  const rendered = selectedItems.length === 0 ? "" : `${selectedItems.map((item) => String(item.statement)).join("\n\n")}\n`;
  const renderedBytes = Buffer.byteLength(rendered);
  const renderedHash = sha256(rendered);
  const verification = {
    item_count: selectedItems.length,
    item_ids_hash: jcsSha256(selectedItems.map((item) => item.item_id)),
    view_md_utf8_bytes: renderedBytes,
    view_md_sha256: renderedHash,
  };
  const rerendered = selectedItems.length === 0 ? "" : `${selectedItems.map((item) => String(item.statement)).join("\n\n")}\n`;
  if (rendered !== rerendered || verification.view_md_utf8_bytes !== Buffer.byteLength(rerendered)
    || verification.view_md_sha256 !== sha256(rerendered)
    || verification.item_count > PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_ITEMS) fail("filtered_render_mismatch", "actual scope-filtered payload failed deterministic revalidation");
  return { viewMd: rendered, viewBytes: renderedBytes, itemCount: selectedItems.length };
}

function validateCompilerOutputManifestBinding(input: {
  compiler: Record<string, unknown>;
  projection: Record<string, unknown>;
  stable: Record<string, unknown>;
  view: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  parity: Record<string, unknown>;
  viewMd: string;
  sourceClosure: Record<string, unknown>;
}): void {
  const resultKind = input.stable.result_kind;
  if (resultKind !== "ready_empty" && resultKind !== "ready_nonempty") {
    fail("compiler_manifest_binding", "compiler result kind cannot reconstruct the inner manifest");
  }
  const compileProfile = record(input.compiler.compile_profile, "manifest.compiler.compile_profile");
  const artifactBytes: Record<string, string> = {
    "view.json": canonicalJson(input.view),
    "view.md": input.viewMd,
    "diagnostics.json": canonicalJson(input.diagnostics),
    "parity.json": canonicalJson(input.parity),
  };
  const artifactRows = PROPOSITION_POLICY_STABLE_VIEW_COMPILER_ARTIFACT_NAMES.map((name) => ({
    name,
    bytes: Buffer.byteLength(artifactBytes[name]!),
    sha256: sha256(artifactBytes[name]!),
  }));
  const compilerManifestBase = buildPropositionPolicyStableViewCompilerManifestBase({
    compileKey: String(input.compiler.compile_key),
    sourceBundleHash: String(input.projection.bundle_hash),
    compileProfileHash: String(compileProfile.profile_hash),
    decisionIdentity: String(input.compiler.decision_identity),
    fixtureSynthetic: false,
    resultKind,
    artifactRows,
    sourceClosure: input.sourceClosure,
  });
  const expectedManifestHash = jcsSha256(compilerManifestBase);
  const expectedManifestRaw = canonicalJson({ ...compilerManifestBase, manifest_hash: expectedManifestHash });
  if (input.compiler.compiler_output_manifest_hash !== expectedManifestHash
    || input.compiler.compiler_output_manifest_raw_sha256 !== sha256(expectedManifestRaw)) {
    fail("compiler_manifest_binding", "published compiler manifest hashes do not bind the reconstructable deterministic compiler manifest");
  }
}

function validateRuntimeScope(value: unknown, at: string): { level: "global" | "project"; projectId: string | null } {
  const scope = record(value, `${at}.scope`);
  exactKeys(scope, ["scope_level", "project_id", "domain"], `${at}.scope`);
  if (scope.scope_level === "global") {
    if (scope.project_id !== null || scope.domain !== null) fail("scope_invalid", "global scope contains project/domain values");
    return { level: "global", projectId: null };
  }
  if (scope.scope_level === "project") {
    if (typeof scope.project_id !== "string" || !scope.project_id || scope.domain !== null) fail("scope_invalid", "project scope shape differs");
    return { level: "project", projectId: scope.project_id };
  }
  fail("scope_invalid", "stable item scope level differs");
}

function validateArtifactRows(rows: unknown[], expectedNames: readonly string[]): void {
  if (rows.length !== expectedNames.length) fail("artifact_rows", "artifact row count differs");
  for (const [index, raw] of rows.entries()) {
    const row = record(raw, `artifact_rows[${index}]`);
    exactKeys(row, ["name", "bytes", "sha256"], `artifact_rows[${index}]`);
    if (row.name !== expectedNames[index] || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0) fail("artifact_rows", "artifact row name/order/bytes differs");
    assertSha256(row.sha256, "artifact row sha256");
  }
}

function exactDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  assertAncestorsNoSymlink(resolved);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) fail("unsafe_path", `${label} is not an exact non-symlink directory`);
  return resolved;
}

function exactRegularFile(file: string, label: string): fs.Stats {
  assertAncestorsNoSymlink(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== path.resolve(file)) fail("unsafe_path", `${label} is not an exact non-symlink file`);
  return stat;
}

function assertAncestorsNoSymlink(input: string): void {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe_path", "path ancestor is a symlink or non-directory");
  }
}

function parseCanonicalJson(raw: string, at: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("json_invalid", `${at} is not valid JSON`); }
  if (`${canonicalize(parsed)}\n` !== raw) fail("jcs_invalid", `${at} is not exact RFC8785-JCS plus LF`);
  return record(parsed, at);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jcsSha256(value: unknown): string {
  return sha256(canonicalize(value));
}

function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("jcs_invalid", "JCS rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const object = record(value, "JCS value");
  return `{${Object.keys(object).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("schema_invalid", `${at} has unexpected keys`);
}

function record(value: unknown, at: string): Record<string, unknown> {
  const result = recordOptional(value);
  if (!result) fail("schema_invalid", `${at} must be an object`);
  return result;
}

function recordOptional(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("schema_invalid", `${at} must be an array`);
  return value;
}

function stringArray(value: unknown, at: string): string[] {
  const values = stringArrayAllowEmpty(value, at);
  if (values.length === 0) fail("schema_invalid", `${at} must contain at least one string`);
  return values;
}

function stringArrayAllowEmpty(value: unknown, at: string): string[] {
  const values = array(value, at);
  if (values.some((item) => typeof item !== "string" || !item)) fail("schema_invalid", `${at} must contain nonempty strings`);
  return values as string[];
}

function assertUniqueStrings(values: readonly string[], at: string): void {
  if (new Set(values).size !== values.length) fail("schema_invalid", `${at} contains duplicate strings`);
}

function assertSortedUniqueStrings(values: readonly string[], at: string, allowEmpty: boolean): void {
  if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0)) {
    fail("schema_invalid", `${at} must be code-unit sorted unique`);
  }
}

function assertSortedUniqueHashes(values: readonly string[], at: string, allowEmpty: boolean): void {
  values.forEach((value, index) => assertSha256(value, `${at}[${index}]`));
  assertSortedUniqueStrings(values, at, allowEmpty);
}

function isCount(value: unknown, allowZero: boolean): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (allowZero ? 0 : 1);
}

function assertSha256(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("hash_mismatch", `${at} is not lowercase SHA-256`);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function controlledError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\/home\/[^/\s]+/g, "~")
    .slice(0, 256);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string): never {
  throw new PropositionPolicyStableViewReaderError(code, message);
}
