#!/usr/bin/env node
/** ADR0040 lifecycle-aware freshness D3 phase-one preview. Production is read-only; output is temp-only. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const __dirname = path.dirname(scriptFile);
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const freshness = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-shadow.ts"));
const publication = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow-publication.ts"));
const stablePublication = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const PRODUCTION_D3_ROOT_RELATIVE = ".state/sediment/proposition-lifecycle-freshness/v1";

function fail(code, message, detail) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.detail = detail;
  throw error;
}

function parseArguments(argv) {
  const allowed = new Set(["--source-abrain", "--runtime-config", "--output"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || value.length === 0) fail("ARGUMENT_INVALID", "accepted arguments are --source-abrain <path>, --runtime-config <path>, and required --output <temp-path>", { name });
    values[name.slice(2)] = value;
  }
  if (!values.output) fail("SANDBOX_OUTPUT_REQUIRED", "--output is required and must be below the real system temp root");
  return values;
}

function sameSnapshot(left, right) {
  return left.snapshot_hash === right.snapshot_hash
    && left.inventory_hash === right.inventory_hash
    && left.entry_count === right.entry_count
    && left.directory_count === right.directory_count
    && left.file_count === right.file_count
    && left.symlink_count === right.symlink_count
    && left.bytes === right.bytes;
}

function statIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    rdev: stat.rdev.toString(),
    size: stat.size.toString(),
    blksize: stat.blksize.toString(),
    blocks: stat.blocks.toString(),
    atime_ns: stat.atimeNs.toString(),
    mtime_ns: stat.mtimeNs.toString(),
    ctime_ns: stat.ctimeNs.toString(),
    birthtime_ns: stat.birthtimeNs.toString(),
  };
}

function runtimeConfigBlockingIdentity(stat) {
  const { atime_ns: _observedAtimeNs, ...identity } = statIdentity(stat);
  return identity;
}

function treeStatIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    rdev: stat.rdev.toString(),
    size: stat.size.toString(),
    mtime_ns: stat.mtimeNs.toString(),
    ctime_ns: stat.ctimeNs.toString(),
    birthtime_ns: stat.birthtimeNs.toString(),
  };
}

function sameStatIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lstatIfPresent(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function safeSize(stat, file) {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) fail("PROTECTED_SURFACE_MEASUREMENT_FAILED", "protected entry size is not a safe integer", { file, size: stat.size.toString() });
  return size;
}

function protectedEntryIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
  };
}

function assertExactSourceRoot(sourceAbrainHome) {
  const stat = lstatIfPresent(sourceAbrainHome);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(sourceAbrainHome) !== sourceAbrainHome) {
    fail("PROTECTED_SURFACE_UNSAFE", "source abrain root is not an exact regular no-symlink directory", { sourceAbrainHome });
  }
}

function captureAncestorChain(sourceAbrainHome, relativeRoot) {
  const identities = [];
  let current = sourceAbrainHome;
  const parts = relativeRoot.split("/");
  for (const component of parts.slice(0, -1)) {
    current = path.join(current, component);
    const stat = lstatIfPresent(current);
    if (!stat) return { identities, missingAncestor: current };
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PROTECTED_SURFACE_UNSAFE", "protected surface ancestor is not an exact no-symlink directory", { current, relativeRoot });
    identities.push({ file: current, identity: treeStatIdentity(stat) });
  }
  return { identities, missingAncestor: null };
}

function assertAncestorChainStable(capture, relativeRoot) {
  for (const row of capture.identities) {
    const current = lstatIfPresent(row.file);
    if (!current || !sameStatIdentity(row.identity, treeStatIdentity(current))) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "protected surface ancestor changed during one snapshot", { file: row.file, relativeRoot });
  }
  if (capture.missingAncestor && lstatIfPresent(capture.missingAncestor)) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "missing protected surface ancestor appeared during one snapshot", { file: capture.missingAncestor, relativeRoot });
}

function captureNoFollowSurface(sourceAbrainHome, definition) {
  const root = path.join(sourceAbrainHome, ...definition.relative_path.split("/"));
  const ancestors = captureAncestorChain(sourceAbrainHome, definition.relative_path);
  if (ancestors.missingAncestor) {
    assertAncestorChainStable(ancestors, definition.relative_path);
    const entries = [{ path: definition.relative_path, type: "missing", size: 0, bytes_sha256: null }];
    return Object.freeze({
      name: definition.name,
      path: root,
      relative_path: definition.relative_path,
      state: "missing",
      entry_count: 1,
      directory_count: 0,
      file_count: 0,
      symlink_count: 0,
      other_count: 0,
      total_file_bytes: 0,
      tree_sha256: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      entries: Object.freeze(entries),
    });
  }

  const entries = [];
  const walk = (file, relative) => {
    const before = lstatIfPresent(file);
    if (!before) {
      if (file !== root) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "protected entry disappeared during one snapshot", { file, relative });
      entries.push({ path: relative, type: "missing", size: 0, bytes_sha256: null });
      return;
    }
    const beforeIdentity = treeStatIdentity(before);
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(file, { encoding: "buffer" });
      const after = fs.lstatSync(file, { bigint: true });
      if (!sameStatIdentity(beforeIdentity, treeStatIdentity(after))) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "protected symlink changed during one snapshot", { file, relative });
      entries.push({ path: relative, type: "symlink", ...protectedEntryIdentity(before), size: target.length, bytes_sha256: crypto.createHash("sha256").update(target).digest("hex") });
      return;
    }
    if (before.isDirectory()) {
      entries.push({ path: relative, type: "directory", ...protectedEntryIdentity(before), size: safeSize(before, file), bytes_sha256: null });
      for (const child of fs.readdirSync(file).sort()) walk(path.join(file, child), `${relative}/${child}`);
      const after = fs.lstatSync(file, { bigint: true });
      if (!sameStatIdentity(beforeIdentity, treeStatIdentity(after))) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "protected directory changed during one snapshot", { file, relative });
      return;
    }
    if (before.isFile()) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!sameStatIdentity(beforeIdentity, treeStatIdentity(opened))) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "opened protected file identity differs from named path", { file, relative });
        const bytes = fs.readFileSync(fd);
        const afterFd = fs.fstatSync(fd, { bigint: true });
        const afterPath = fs.lstatSync(file, { bigint: true });
        if (!sameStatIdentity(beforeIdentity, treeStatIdentity(afterFd)) || !sameStatIdentity(beforeIdentity, treeStatIdentity(afterPath))) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "protected file changed during one snapshot", { file, relative });
        entries.push({ path: relative, type: "file", ...protectedEntryIdentity(before), size: bytes.length, bytes_sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    const after = fs.lstatSync(file, { bigint: true });
    if (!sameStatIdentity(beforeIdentity, treeStatIdentity(after))) fail("PROTECTED_SURFACE_MEASUREMENT_RACE", "protected special entry changed during one snapshot", { file, relative });
    entries.push({ path: relative, type: "other", ...protectedEntryIdentity(before), size: safeSize(before, file), bytes_sha256: null });
  };

  walk(root, definition.relative_path);
  assertAncestorChainStable(ancestors, definition.relative_path);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const state = entries[0]?.type === "missing" ? "missing" : "present";
  return Object.freeze({
    name: definition.name,
    path: root,
    relative_path: definition.relative_path,
    state,
    entry_count: entries.length,
    directory_count: entries.filter((row) => row.type === "directory").length,
    file_count: entries.filter((row) => row.type === "file").length,
    symlink_count: entries.filter((row) => row.type === "symlink").length,
    other_count: entries.filter((row) => row.type === "other").length,
    total_file_bytes: entries.filter((row) => row.type === "file").reduce((sum, row) => sum + row.size, 0),
    tree_sha256: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries: Object.freeze(entries),
  });
}

function captureProtectedSurfaces(sourceAbrainHome) {
  assertExactSourceRoot(sourceAbrainHome);
  const definitions = Object.freeze([
    { name: "canonical_l1_source", relative_path: "l1/events/sha256" },
    { name: "production_p2a_root", relative_path: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE },
    { name: "production_stable_root", relative_path: stablePublication.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE },
    { name: "production_d3_root", relative_path: PRODUCTION_D3_ROOT_RELATIVE },
  ]);
  const surfaces = definitions.map((definition) => captureNoFollowSurface(sourceAbrainHome, definition));
  const identity = surfaces.map(({ name, path: absolutePath, relative_path, state, entry_count, tree_sha256 }) => ({ name, path: absolutePath, relative_path, state, entry_count, tree_sha256 }));
  return Object.freeze({
    schema_version: "proposition-lifecycle-freshness-protected-surfaces-snapshot/v1",
    source_abrain_home: sourceAbrainHome,
    snapshot_sha256: crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    surfaces: Object.freeze(surfaces),
  });
}

function protectedSurfaceSummary(capture) {
  return {
    schema_version: capture.schema_version,
    source_abrain_home: capture.source_abrain_home,
    snapshot_sha256: capture.snapshot_sha256,
    surfaces: capture.surfaces.map(({ entries: _entries, ...summary }) => summary),
  };
}

function protectedSurfaceComparisons(before, after) {
  return before.surfaces.map((left, index) => {
    const right = after.surfaces[index];
    const unchanged = left.name === right?.name
      && left.path === right.path
      && left.state === right.state
      && left.entry_count === right.entry_count
      && left.tree_sha256 === right.tree_sha256;
    return {
      name: left.name,
      path: left.path,
      before_state: left.state,
      after_state: right?.state ?? "measurement_missing",
      before_tree_sha256: left.tree_sha256,
      after_tree_sha256: right?.tree_sha256 ?? null,
      unchanged,
    };
  });
}

function captureExactRuntimeConfig(file) {
  const resolved = path.resolve(file);
  let before;
  try { before = fs.lstatSync(resolved, { bigint: true }); }
  catch (error) { fail("RUNTIME_CONFIG_MEASUREMENT_FAILED", "runtime config cannot be lstat'ed", { resolved, error: error?.message }); }
  if (before.isSymbolicLink() || !before.isFile() || fs.realpathSync(resolved) !== resolved) fail("RUNTIME_CONFIG_UNSAFE", "runtime config is not an exact regular no-symlink file", { resolved });
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const beforeIdentity = runtimeConfigBlockingIdentity(before);
    if (!sameStatIdentity(beforeIdentity, runtimeConfigBlockingIdentity(opened))) fail("RUNTIME_CONFIG_RACE", "opened runtime config identity differs from named path", { resolved });
    const bytes = fs.readFileSync(fd);
    const afterFd = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(resolved, { bigint: true });
    if (!sameStatIdentity(beforeIdentity, runtimeConfigBlockingIdentity(afterFd)) || !sameStatIdentity(beforeIdentity, runtimeConfigBlockingIdentity(afterPath))) fail("RUNTIME_CONFIG_RACE", "runtime config changed during one measurement", { resolved });
    return {
      path: resolved,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      stat: statIdentity(before),
      blocking_stat_identity: beforeIdentity,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export async function runPropositionLifecycleFreshnessPreview(options) {
  const sourceAbrainHome = path.resolve(options.sourceAbrainHome ?? "/home/worker/.abrain");
  const runtimeConfigPath = path.resolve(options.runtimeConfigPath ?? path.join(repoRoot, "..", "..", "pi-astack-settings.json"));
  const outputRoot = freshness.assertPropositionLifecycleFreshnessSandboxOutputRoot(options.outputRoot);
  const observedAtUtc = new Date().toISOString();
  const protectedBefore = captureProtectedSurfaces(sourceAbrainHome);
  const runtimeConfigBefore = captureExactRuntimeConfig(runtimeConfigPath);
  const beforeCapture = await publication.capturePublicationWholeSnapshot(sourceAbrainHome);
  const build = await freshness.buildPropositionLifecycleFreshnessShadow({
    sourceAbrainHome,
    repoRoot,
    selection: "selected",
  });
  const materialized = await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot, build });
  const readback = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot });
  if (!readback.ok) fail("SHADOW_READBACK_BLOCKED", "new shadow reader rejected the preview output", { readback });
  await options.afterPreviewReadbackForTest?.({ sourceAbrainHome, runtimeConfigPath, outputRoot });
  const afterCapture = await publication.capturePublicationWholeSnapshot(sourceAbrainHome);
  const runtimeConfigAfter = captureExactRuntimeConfig(runtimeConfigPath);
  const protectedAfter = captureProtectedSurfaces(sourceAbrainHome);
  const wholeTreeUnchanged = sameSnapshot(beforeCapture.summary, afterCapture.summary);
  const surfaceComparisons = protectedSurfaceComparisons(protectedBefore, protectedAfter);
  const protectedSurfacesUnchanged = protectedBefore.snapshot_sha256 === protectedAfter.snapshot_sha256
    && surfaceComparisons.every((surface) => surface.unchanged);
  const runtimeConfigUnchanged = runtimeConfigBefore.sha256 === runtimeConfigAfter.sha256
    && runtimeConfigBefore.bytes === runtimeConfigAfter.bytes
    && sameStatIdentity(runtimeConfigBefore.blocking_stat_identity, runtimeConfigAfter.blocking_stat_identity);
  if (!protectedSurfacesUnchanged) fail("PROTECTED_SURFACE_CHANGED", "a protected production surface changed during the read-only preview", {
    changes: surfaceComparisons.filter((surface) => !surface.unchanged),
    before: protectedSurfaceSummary(protectedBefore),
    after: protectedSurfaceSummary(protectedAfter),
    whole_tree_concurrent_change_observed: !wholeTreeUnchanged,
  });
  if (!runtimeConfigUnchanged) fail("RUNTIME_CONFIG_CHANGED", "runtime config bytes or stat identity changed during preview", { before: runtimeConfigBefore, after: runtimeConfigAfter });

  return {
    schema_version: "proposition-lifecycle-freshness-read-only-preview/v3",
    mode: sourceAbrainHome === "/home/worker/.abrain" ? "real_production_read_only" : "explicit_source_read_only",
    source_abrain_home: sourceAbrainHome,
    runtime_config_path: runtimeConfigPath,
    output_root: outputRoot,
    audit: {
      observed_at_utc: observedAtUtc,
      time_fields_excluded_from_control_identity: true,
      time_fields_excluded_from_freshness_gate: true,
    },
    control_plane: {
      layout: freshness.PROPOSITION_LIFECYCLE_FRESHNESS_LAYOUT,
      materialization_status: materialized.status,
      head_pointer_path: materialized.head_pointer_path,
      selection_pointer_path: materialized.selection_pointer_path,
      head_hash: readback.headHash,
      head_generation: readback.headGeneration,
      selection_hash: readback.selectionHash,
      selection_seq: readback.selectionSeq,
      selection_config_trust_anchor_hash: build.selection.authority_binding.config_trust_anchor_hash,
      p2a_bundle_hash: readback.p2aBundleHash,
      stable_bundle_hash: readback.stableBundleHash,
      stable_manifest_hash: readback.stableManifestHash,
      rendered_view_sha256: build.selection.references.rendered_view_sha256,
      freshness_basis: readback.freshness_basis,
      source_counts: readback.sourceCounts,
      stable_item_count: readback.itemCount,
      stable_view_utf8_bytes: readback.viewBytes,
    },
    measured_evidence: {
      source_abrain_whole_tree: {
        method: "capturePublicationWholeSnapshot before/after; observed concurrency only, not a blocking read-only gate",
        before: beforeCapture.summary,
        after: afterCapture.summary,
        unchanged: wholeTreeUnchanged,
        whole_tree_concurrent_change_observed: !wholeTreeUnchanged,
        blocking_read_only_gate: false,
      },
      protected_surfaces: {
        method: "deterministic no-follow tree snapshots over exact protected roots; present rows bind path, type, dev, ino, mode, nlink, uid, gid, size, and regular-file or symlink bytes SHA-256; atime is excluded; missing roots bind an explicit missing row",
        before: protectedSurfaceSummary(protectedBefore),
        after: protectedSurfaceSummary(protectedAfter),
        comparisons: surfaceComparisons,
        unchanged: true,
        blocking_read_only_gate: true,
      },
      runtime_config_exact_file: {
        method: "O_NOFOLLOW bytes SHA-256 plus bigint lstat/fstat identity before/after; stat reports atime_ns observationally while blocking_stat_identity excludes only atime_ns",
        before: runtimeConfigBefore,
        after: runtimeConfigAfter,
        unchanged: true,
        blocking_read_only_gate: true,
      },
    },
    asserted_scope: {
      writes_confined_by_api_to_real_system_temp_strict_subdirectory: true,
      production_source_opened_as_builder_input_only: true,
      production_mutation_not_authorized: true,
      production_l1_append_not_authorized: true,
      production_control_or_artifact_publication_not_authorized: true,
      runtime_config_mutation_not_authorized: true,
      runtime_read_flip_not_authorized: true,
      legacy_migration_or_retirement_not_authorized: true,
    },
  };
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const report = await runPropositionLifecycleFreshnessPreview({
      sourceAbrainHome: args["source-abrain"],
      runtimeConfigPath: args["runtime-config"],
      outputRoot: args.output,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? "PREVIEW_FAILED"}: ${error?.message ?? String(error)}\n`);
    if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === scriptFile) await main();
