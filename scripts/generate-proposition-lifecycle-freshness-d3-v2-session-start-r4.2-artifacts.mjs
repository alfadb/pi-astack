#!/usr/bin/env node
/** Build/validate the six content-only R4.2 committed execution inputs. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = Object.freeze(["source_manifest", "adapter_manifest", "operator_manifest", "static_contract", "static_dossier", "static_preview_template"]);
const SOURCE_SNAPSHOTS = new Set(["worktree", "index"]);
const BOOTSTRAP_ARTIFACT_PATHS = Object.freeze({
  source_manifest: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-source-manifest.json",
  adapter_manifest: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-adapter-manifest.json",
  operator_manifest: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-operator-manifest.json",
  static_contract: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-static-contract.json",
  static_dossier: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-static-dossier.json",
  static_preview_template: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-static-preview-template.json",
});
const directExecution = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);

function parseCli(args) {
  let sourceSnapshot = "worktree";
  let snapshotSeen = false;
  const command = [];
  for (const arg of args) {
    if (!arg.startsWith("--source-snapshot=")) { command.push(arg); continue; }
    if (snapshotSeen) throw new Error("source snapshot may be specified only once");
    const match = /^--source-snapshot=(worktree|index)$/.exec(arg);
    if (!match) throw new Error("source snapshot must be --source-snapshot=worktree or --source-snapshot=index");
    sourceSnapshot = match[1];
    snapshotSeen = true;
  }
  return { command, sourceSnapshot };
}

const parsedCli = directExecution ? parseCli(process.argv.slice(2)) : null;
const indexSnapshotParent = directExecution && parsedCli.sourceSnapshot === "index";
let semantic;
if (!indexSnapshotParent) {
  const [core, operator] = await Promise.all([
    import("../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs"),
    import("../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs"),
  ]);
  semantic = { ...core, ...operator };
}

const {
  ARTIFACT_PATHS,
  CLI_PATH,
  CORE_PATH,
  DYNAMIC_SENTINEL,
  GENERATOR_PATH,
  MAX_STATIC_BYTES,
  MODULE_PATH,
  PRODUCTION,
  REVISION,
  RULE_INJECTOR_PATH,
  RUNTIME_CONTROL_PATH,
  RUNTIME_RESOLVER_PATH,
  RUNTIME_SETTINGS_RESOLVER_PATH,
  SCHEMAS,
  SMOKE_PATH,
  SOURCE_COMMIT_BINDING,
  STAGED_PATH,
  STAGE_STATE,
  STATIC_SENTINEL,
  addSelfHash,
  canonicalizeJcs,
  compareUtf8,
  deepFreeze,
  jcsSha256,
  loadAndValidateStaticBundle,
  parseDirectDependencies,
  sha256,
  validateStandaloneManifest,
  validateStaticContract,
  validateStaticDossier,
  validateStaticPreviewTemplate,
} = semantic ?? {};

function bootstrapGit(cwd, args, options = {}) {
  const env = { ...process.env, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    env,
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
  });
}
function requireBootstrapGit(cwd, args, label, options = {}) {
  const result = bootstrapGit(cwd, args, options);
  if (result.error || result.status !== 0) throw new Error(`${label}: ${result.error?.message ?? result.stderr.toString("utf8").trim()}`);
  return result.stdout;
}
function parseStageTable(raw, label) {
  const rows = [];
  let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf(0, offset);
    if (nul < 0) throw new Error(`${label} is not NUL terminated`);
    const record = raw.subarray(offset, nul);
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error(`${label} row has no path separator`);
    const metadata = record.subarray(0, tab).toString("ascii");
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(metadata);
    if (!match) throw new Error(`${label} row has invalid stage metadata`);
    rows.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: record.subarray(tab + 1) });
    offset = nul + 1;
  }
  return rows;
}
function renderStageTable(rows) {
  return Buffer.concat(rows.flatMap((row) => [Buffer.from(`${row.mode} ${row.oid} ${row.stage}\t`, "ascii"), row.path, Buffer.from([0])]));
}
function captureIndexSnapshot(indexPath, label) {
  const bytesBefore = fs.readFileSync(indexPath);
  const table = requireBootstrapGit(repoRoot, ["ls-files", "--stage", "-z"], `cannot capture ${label} index table`);
  const bytesAfter = fs.readFileSync(indexPath);
  if (!bytesAfter.equals(bytesBefore)) throw new Error(`index changed while capturing ${label} snapshot`);
  const rows = parseStageTable(table, `${label} index table`);
  if (rows.some((row) => row.stage !== 0)) throw new Error("index source snapshot contains unmerged entries");
  return { bytes: bytesAfter, table, rows };
}
function assertInitialIndex(snapshot, initial, label) {
  if (!snapshot.bytes.equals(initial.bytes) || !snapshot.table.equals(initial.table)) throw new Error(`index changed ${label}`);
}
function buildExpectedIndex(tempBase, initial, generated) {
  const artifactByPath = new Map(NAMES.map((name) => [BOOTSTRAP_ARTIFACT_PATHS[name], name]));
  const generatedOids = new Map();
  for (const name of NAMES) {
    const oid = requireBootstrapGit(repoRoot, ["hash-object", "-w", "--stdin"], `cannot write generated ${name} blob`, { input: generated[name] }).toString("ascii").trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error(`generated ${name} blob has invalid object id`);
    generatedOids.set(name, oid);
  }
  const seen = new Set();
  const rows = initial.rows.map((row) => {
    const relative = row.path.toString("utf8");
    const name = artifactByPath.get(relative);
    if (!name || !row.path.equals(Buffer.from(relative, "utf8"))) return row;
    if (seen.has(name)) throw new Error(`initial index has duplicate ${name} entry`);
    seen.add(name);
    return { ...row, oid: generatedOids.get(name) };
  });
  if (seen.size !== NAMES.length) throw new Error("initial index must contain exactly one stage-0 entry for every R4.2 artifact");
  const expectedTable = renderStageTable(rows);
  const expectedIndexPath = path.join(tempBase, "expected-index");
  fs.writeFileSync(expectedIndexPath, initial.bytes, { flag: "wx", mode: 0o600 });
  for (const name of NAMES) {
    const relative = BOOTSTRAP_ARTIFACT_PATHS[name];
    const row = rows.find((candidate) => candidate.path.equals(Buffer.from(relative)));
    requireBootstrapGit(repoRoot, ["update-index", "--add", "--cacheinfo", `${row.mode},${row.oid},${relative}`], `cannot construct expected ${name} index entry`, { indexFile: expectedIndexPath });
  }
  const materializedTable = requireBootstrapGit(repoRoot, ["ls-files", "--stage", "-z"], "cannot inspect expected final index", { indexFile: expectedIndexPath });
  if (!materializedTable.equals(expectedTable)) throw new Error("constructed expected index differs from the unique expected stage table");
  return { bytes: fs.readFileSync(expectedIndexPath), table: expectedTable };
}
function installExpectedIndex(indexPath, initial, expected, generated) {
  const initialStat = fs.lstatSync(indexPath);
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) throw new Error("repository index is not a regular file");
  const lockPath = `${indexPath}.lock`;
  let lockFd;
  let installed = false;
  try {
    lockFd = fs.openSync(lockPath, "wx", initialStat.mode & 0o777);
    fs.fchmodSync(lockFd, initialStat.mode & 0o777);
    if (!fs.readFileSync(indexPath).equals(initial.bytes)) throw new Error("index changed before generated artifacts could be copied");
    for (const name of NAMES) {
      const target = path.join(repoRoot, ...BOOTSTRAP_ARTIFACT_PATHS[name].split("/"));
      fs.writeFileSync(target, generated[name], { flag: "w", mode: 0o644 });
      if (!fs.readFileSync(target).equals(generated[name])) throw new Error(`copied ${name} differs from isolated generated bytes`);
    }
    if (!fs.readFileSync(indexPath).equals(initial.bytes)) throw new Error("index changed while generated artifacts were being copied");
    fs.writeFileSync(lockFd, expected.bytes);
    fs.fsyncSync(lockFd);
    if (!fs.readFileSync(indexPath).equals(initial.bytes)) throw new Error("index changed while the expected final index was being staged");
    fs.closeSync(lockFd);
    lockFd = undefined;
    fs.renameSync(lockPath, indexPath);
    installed = true;
    const parentFd = fs.openSync(path.dirname(indexPath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (!installed) {
      try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}
function rewriteIndexSnapshotReport(raw, command) {
  const jsonReport = command.length === 0
    || (command.length === 1 && ["--summary", "--verify", "--write"].includes(command[0]));
  if (!jsonReport) return raw;
  const report = JSON.parse(raw.toString("utf8"));
  if (!report || Array.isArray(report) || report.source_snapshot !== "worktree") throw new Error("isolated generator emitted an invalid worktree snapshot report");
  report.source_snapshot = "index";
  return Buffer.from(`${JSON.stringify(report)}\n`);
}
function runIndexSnapshotParent() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-r4.2-index-"));
  const tempRoot = path.join(tempBase, "worktree");
  let registered = false;
  let registeredGitDir;
  let child;
  let generated;
  let initialIndex;
  let indexPath;
  let primaryError;
  try {
    const indexPathRaw = requireBootstrapGit(repoRoot, ["rev-parse", "--git-path", "index"], "cannot resolve repository index path").toString("utf8").trim();
    indexPath = path.isAbsolute(indexPathRaw) ? path.normalize(indexPathRaw) : path.resolve(repoRoot, indexPathRaw);
    initialIndex = captureIndexSnapshot(indexPath, "initial");
    requireBootstrapGit(repoRoot, ["worktree", "add", "--quiet", "--detach", "--no-checkout", tempRoot, "HEAD"], "cannot create detached index worktree");
    registered = true;
    const gitFileMatch = /^gitdir: (.+)$/.exec(fs.readFileSync(path.join(tempRoot, ".git"), "utf8").trim());
    const commonGitDir = path.resolve(repoRoot, requireBootstrapGit(repoRoot, ["rev-parse", "--git-common-dir"], "cannot resolve common Git directory").toString("utf8").trim());
    const registeredGitDirCandidate = gitFileMatch ? path.resolve(tempRoot, gitFileMatch[1]) : undefined;
    if (!registeredGitDirCandidate || path.dirname(registeredGitDirCandidate) !== path.join(commonGitDir, "worktrees")) throw new Error("detached index worktree registry path is outside the repository common Git directory");
    registeredGitDir = registeredGitDirCandidate;
    requireBootstrapGit(repoRoot, ["checkout-index", "--all", "--force", `--prefix=${tempRoot}${path.sep}`], "cannot materialize stage-0 index snapshot");
    const stagedGenerator = path.join(tempRoot, "scripts", "generate-proposition-lifecycle-freshness-d3-v2-session-start-r4.2-artifacts.mjs");
    if (!fs.existsSync(stagedGenerator)) throw new Error("index source snapshot is missing the staged R4.2 generator");
    child = spawnSync(process.execPath, [stagedGenerator, ...parsedCli.command], {
      cwd: tempRoot,
      encoding: "buffer",
      env: process.env,
      maxBuffer: 128 * 1024 * 1024,
      timeout: 600000,
    });
    if (child.error) throw child.error;
    if (child.status === 0) {
      assertInitialIndex(captureIndexSnapshot(indexPath, "post-child"), initialIndex, "while the isolated snapshot was executing");
      if (parsedCli.command.length === 1 && parsedCli.command[0] === "--write") {
        generated = Object.fromEntries(NAMES.map((name) => [name, fs.readFileSync(path.join(tempRoot, ...BOOTSTRAP_ARTIFACT_PATHS[name].split("/")))]));
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError;
    if (registered) {
      const removed = bootstrapGit(repoRoot, ["worktree", "remove", "--force", tempRoot]);
      if (removed.error || removed.status !== 0) {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
          if (!registeredGitDir) throw new Error("detached index worktree registry path was not captured");
          fs.rmSync(registeredGitDir, { recursive: true, force: true });
        } catch (error) { cleanupError = error; }
      }
      registered = false;
    }
    if (cleanupError) primaryError = primaryError ? new AggregateError([primaryError, cleanupError], "index snapshot execution and cleanup both failed") : cleanupError;
  }
  try {
    if (primaryError) throw primaryError;
    if (child.status === 0 && generated) {
      const expected = buildExpectedIndex(tempBase, initialIndex, generated);
      installExpectedIndex(indexPath, initialIndex, expected, generated);
      const finalTable = requireBootstrapGit(repoRoot, ["ls-files", "--stage", "-z"], "cannot inspect final index");
      const finalBytes = fs.readFileSync(indexPath);
      if (!finalTable.equals(expected.table) || !finalBytes.equals(expected.bytes)) throw new Error("final index differs from the unique expected complete index");
    }
    if (child.status === 0) child.stdout = rewriteIndexSnapshotReport(child.stdout, parsedCli.command);
    if (child.stdout?.length) process.stdout.write(child.stdout);
    if (child.stderr?.length) process.stderr.write(child.stderr);
    return child.status ?? 1;
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true });
  }
}

function sorted(values) { return [...values].sort(compareUtf8); }
function createSourceSnapshot(kind) {
  if (!SOURCE_SNAPSHOTS.has(kind)) throw new Error(`source snapshot must be one of: ${[...SOURCE_SNAPSHOTS].join(", ")}`);
  if (kind === "index") throw new Error("index source snapshots must execute through the generator CLI isolation parent");
  return Object.freeze({
    kind,
    hasPath(relative) { return fs.existsSync(path.join(repoRoot, ...relative.split("/"))); },
    read(relative) { return fs.readFileSync(path.join(repoRoot, ...relative.split("/"))); },
  });
}
function rowFor(snapshot, relative) {
  const raw = snapshot.read(relative);
  return deepFreeze({ relative_path: relative, raw_sha256: sha256(raw), dependencies: parseDirectDependencies(repoRoot, relative, raw, { pathExists: (candidate) => snapshot.hasPath(candidate) }) });
}
function transitiveRowsFor(snapshot, roots) {
  const artifacts = new Set(Object.values(ARTIFACT_PATHS));
  const queued = [...new Set(roots)];
  const seen = new Set();
  const rows = [];
  while (queued.length) {
    const relative = queued.shift();
    if (seen.has(relative) || artifacts.has(relative)) continue;
    seen.add(relative);
    const row = rowFor(snapshot, relative);
    rows.push(row);
    for (const dependency of row.dependencies) if (!seen.has(dependency) && !artifacts.has(dependency)) queued.push(dependency);
    queued.sort(compareUtf8);
  }
  return rows.sort((left, right) => compareUtf8(left.relative_path, right.relative_path));
}
function formula(kind, rows) {
  const graph_hash = jcsSha256(rows);
  const source_closure_hash = sha256(Buffer.concat([Buffer.from(`adr0040-d3-v2-session-start-r4.2-${kind}-source-closure/v1\0`), Buffer.from(graph_hash, "ascii")]));
  return { graph_hash, source_closure_hash };
}
function manifestBase(kind, rows) {
  const hashes = formula(kind, rows);
  return { relative_path: ARTIFACT_PATHS[`${kind}_manifest`], schema_version: SCHEMAS[`${kind}_manifest`], revision: REVISION, kind, closure_rows: rows, ...hashes, file_count: rows.length };
}
function projection(manifest) { return { relative_path: manifest.relative_path, kind: manifest.kind, self_hash: manifest.self_hash, graph_hash: manifest.graph_hash, source_closure_hash: manifest.source_closure_hash, file_count: manifest.file_count }; }
function entryProjection(manifest, relative) { const row = manifest.closure_rows.find((item) => item.relative_path === relative); if (!row) throw new Error(`entry projection missing ${relative}`); return { relative_path: relative, raw_sha256: row.raw_sha256 }; }
function uniqueSortedStrings(values) { return sorted(new Set(values)); }

export function buildR42ArtifactBundle(options = {}) {
  const sourceSnapshot = createSourceSnapshot(options.sourceSnapshot ?? "worktree");
  const runtimeRoots = [RUNTIME_CONTROL_PATH, RUNTIME_RESOLVER_PATH, RUNTIME_SETTINGS_RESOLVER_PATH, RULE_INJECTOR_PATH];
  const adapterRows = transitiveRowsFor(sourceSnapshot, [CORE_PATH, STAGED_PATH, ...runtimeRoots]);
  const operatorRows = transitiveRowsFor(sourceSnapshot, [CORE_PATH, STAGED_PATH, MODULE_PATH, CLI_PATH, GENERATOR_PATH, ...runtimeRoots]);
  const critical = sorted([SMOKE_PATH]);
  const sourceRowsMap = new Map();
  for (const row of [...adapterRows, ...operatorRows, ...critical.map((relative) => rowFor(sourceSnapshot, relative))]) {
    const previous = sourceRowsMap.get(row.relative_path);
    if (previous && canonicalizeJcs(previous) !== canonicalizeJcs(row)) throw new Error(`closure overlap differs: ${row.relative_path}`);
    sourceRowsMap.set(row.relative_path, row);
  }
  const sourceRows = [...sourceRowsMap.values()].sort((left, right) => compareUtf8(left.relative_path, right.relative_path));

  const source = addSelfHash({ ...manifestBase("source", sourceRows), critical_required_paths: critical, clean_closure_policy: "tracked_nonignored_live_equals_head_no_shadow" }, "self_hash");
  const dependencyPins = [
    { relative_path: STAGED_PATH, raw_sha256: adapterRows.find((row) => row.relative_path === STAGED_PATH).raw_sha256, role: "anchored_io" },
    { relative_path: STAGED_PATH, raw_sha256: adapterRows.find((row) => row.relative_path === STAGED_PATH).raw_sha256, role: "idempotent_link_unlink" },
    { relative_path: CORE_PATH, raw_sha256: adapterRows.find((row) => row.relative_path === CORE_PATH).raw_sha256, role: "retained_auth_reverify" },
    { relative_path: STAGED_PATH, raw_sha256: adapterRows.find((row) => row.relative_path === STAGED_PATH).raw_sha256, role: "staged_publication" },
    { relative_path: CORE_PATH, raw_sha256: adapterRows.find((row) => row.relative_path === CORE_PATH).raw_sha256, role: "strict_json" },
  ].sort((left, right) => compareUtf8(`${left.relative_path}\0${left.role}`, `${right.relative_path}\0${right.role}`));
  const adapter = addSelfHash({ ...manifestBase("adapter", adapterRows), staged_publication_schema: SCHEMAS.staged_publish, link_final_schema: SCHEMAS.link_final, unlink_pending_schema: SCHEMAS.unlink_pending, staged_temp_path_schema: SCHEMAS.staged_temp_path, dependency_pins: dependencyPins }, "self_hash");
  const operator = addSelfHash({ ...manifestBase("operator", operatorRows), operator_entry: entryProjection({ closure_rows: operatorRows }, MODULE_PATH), cli_entry: entryProjection({ closure_rows: operatorRows }, CLI_PATH), generator_entry: entryProjection({ closure_rows: operatorRows }, GENERATOR_PATH), schema_entries: [entryProjection({ closure_rows: operatorRows }, CORE_PATH), entryProjection({ closure_rows: operatorRows }, MODULE_PATH)].sort((left, right) => compareUtf8(left.relative_path, right.relative_path)) }, "self_hash");

  validateStandaloneManifest(source, "source");
  validateStandaloneManifest(adapter, "adapter");
  validateStandaloneManifest(operator, "operator");

  const targetBinding = {
    session_id: PRODUCTION.target_session_id,
    sessions_root: PRODUCTION.target_sessions_root,
    session_file: {
      path: PRODUCTION.target_session_path,
      dev: 1048592,
      ino: 4058573,
      prefix_bytes: 955019,
      prefix_sha256: "99e9e1a229f5007618f625b2c9407ce098cfffd5801e0a7a42b65485c3a8de4e",
      header_sha256: "0c6090efa65f4ab736acbe124381c55a2ad646ef21324e3be48bf20be5ca5ee3",
    },
  };
  const authorizationBinding = {
    session_id: PRODUCTION.authorization_session_id,
    sessions_root: PRODUCTION.authorization_sessions_root,
    session_file: {
      path: PRODUCTION.authorization_session_path,
      dev: 1048592,
      ino: 4157218,
      prefix_bytes: 4269956,
      prefix_sha256: "3c27956db96faedd6d20c4e203a660ce3ea6b758790bb5049cec7f562a5c5379",
      header_sha256: "674942418e06165cae9ab2a66a849598f73bc4a6391b2b4b8f2612a4a8027051",
    },
  };
  const d3 = {
    selection_hash: "94edfbbdf354c7df5a45337fb29365f67e12c6a792f924805cf874fe1f42ae35",
    head_hash: "fd717f2ab5acb59267bd7ff8377a5197cf500c42fcb60b837eeabf0d077bcfea",
    proof_hash: "d47fe0eac9aac077c25abb172c0992ab7e378ac7886983a0f08779fbc0e1a2f2",
    intent_hash: "2175f55c4cbcbea6355557db597cc70f2008f6b147c7292cd7bb189b60ddc5e1",
    stable_bundle_hash: "6a74d84818ea9ab9702c472bd38a96b31eec60f73d4d2adf9402967ca42a7398",
    p2a_bundle_hash: "1768de48d0c3bcb2c1e12605829d22e307973605f5c648c66c3c610bf3f40f34",
    generation: 0,
    selection_seq: 0,
  };
  const desiredTemplate = {
    enabled: true,
    selector: { session_ids: [PRODUCTION.target_session_id] },
    selectionHash: d3.selection_hash,
    headHash: d3.head_hash,
    proofHash: d3.proof_hash,
    intentHash: d3.intent_hash,
    stableBundleHash: d3.stable_bundle_hash,
    p2aBundleHash: d3.p2a_bundle_hash,
    generation: d3.generation,
    selectionSeq: d3.selection_seq,
    adapterManifestHash: adapter.self_hash,
    maxReadBytes: 65536,
    r4Binding: {
      schema_version: SCHEMAS.settings_binding,
      controlRoot: PRODUCTION.control_root,
      operatorManifestHash: operator.self_hash,
      settingsPath: PRODUCTION.settings_path,
      static_contract_hash: STATIC_SENTINEL,
      commit_token: DYNAMIC_SENTINEL,
    },
  };
  const mutationReadSet = uniqueSortedStrings([
    "authorization_transcript_retained_fd_prefix_latest_coordinate", "bounded_control_inventory", "d3_and_static_pins", "non_v2_projection", "old_activation_root", "rollback_root_absence", "root_object", "ruleInjector_object", "settings_full_raw_identity_metadata", "settings_parent_matching_temp_inventory", "source_commit_six_artifacts_closure", "target_and_authorization_session_bindings", "v1_selector", "v2_key",
  ]);
  const mutationWriteSet = uniqueSortedStrings([
    "activation_final_pending_invocation_temp", "control_bootstrap_prefix", "intent_final_pending_invocation_temp", "operator_audit_optional_best_effort", "receipt_final_pending_invocation_temp", "settings_cas_same_directory_temp_metadata", "staged_temp_disposition_exact_unlink_parent_fsync", "v2_key_replacement_only",
  ]);
  const conflictRules = uniqueSortedStrings([
    "control_or_rollback_alias_or_nesting", "corrupt_or_foreign_authority", "duplicate_json_key", "foreign_authorized_activation", "foreign_legacy_or_r4_binding", "illegal_A_I_V_R_combination", "non_allowed_v2_prestate", "non_object_root_or_ruleInjector", "rollback_root_preexists", "session_or_authorization_drift", "settings_metadata_or_symlink_violation", "source_commit_or_closure_drift", "staged_temp_without_exact_disposition_gate", "static_pin_mismatch", "target_in_v1_or_foreign_v2_selector", "target_or_authorization_alias",
  ]);
  const auditBaseStat = fs.lstatSync(PRODUCTION.runtime_audit_base);
  const acceptedResidualIds = uniqueSortedStrings([
    "direct_receipt_pending_nonexact_B_requires_restore_exact_B_or_separate_disposition",
    "linux_procfd_hardlink_same_filesystem_boundary",
    "noncooperative_writer_between_final_check_and_rename_liveness",
    "same_uid_malicious_process_and_cross_process_attempt_copy_out_of_scope",
    "token_is_public_recovery_binding_not_secret",
  ]);
  const contractBase = {
    schema_version: SCHEMAS.static_contract,
    revision: REVISION,
    canonicalization: "RFC8785-JCS",
    source_manifest: projection(source),
    adapter_manifest: projection(adapter),
    operator_manifest: projection(operator),
    artifact_paths: ARTIFACT_PATHS,
    target_session_binding: targetBinding,
    authorization_transcript_binding: authorizationBinding,
    d3_identities: d3,
    settings_contract: {
      settings_path: PRODUCTION.settings_path,
      allowed_v2_prestate: ["absent", "disabled_empty"],
      allowed_metadata_policy: { file_type: "regular", nlink: 1, uid_policy: "effective_uid", gid_policy: "effective_gid", allowed_modes: [384, 420], nofollow_required: true },
      transformer_version: SCHEMAS.transformer,
      desired_v2_template: desiredTemplate,
      settings_temp_relative_template: ".pi-astack-settings.json.adr0040-r4.2.{operation_id}.settings.stage.{invocation_nonce}.tmp",
      mutation_read_set: mutationReadSet,
      mutation_write_set: mutationWriteSet,
      conflict_rules: conflictRules,
    },
    control_paths: {
      control_root: PRODUCTION.control_root,
      intent_relative_template: "intents/{operation_id}.json",
      activation_relative_template: "activations/{operation_id}.json",
      receipt_relative_template: "receipts/{operation_id}.json",
      intent_pending_relative_template: "intents/.{operation_id}.intent.pending",
      activation_pending_relative_template: "activations/.{operation_id}.activation.pending",
      receipt_pending_relative_template: "receipts/.{operation_id}.receipt.pending",
      intent_temp_relative_template: "intents/.{operation_id}.intent.stage.{invocation_nonce}.tmp",
      activation_temp_relative_template: "activations/.{operation_id}.activation.stage.{invocation_nonce}.tmp",
      receipt_temp_relative_template: "receipts/.{operation_id}.receipt.stage.{invocation_nonce}.tmp",
      invocation_nonce_pattern: "^[0-9a-f]{32}$",
      bootstrap_prefix_states: ["root_absent", "root_empty", "root_plus_intents", "root_plus_intents_activations", "root_plus_intents_activations_receipts"],
      directory_mode: 448,
      same_device_required: true,
      no_symlink_required: true,
      no_extras_required: true,
      operator_audit_relative: "operator-audit.jsonl",
    },
    rollback_paths: {
      rollback_root: PRODUCTION.rollback_root,
      state_root: PRODUCTION.rollback_root,
      quarantine_target: PRODUCTION.quarantine_target,
      old_activation_root: PRODUCTION.old_activation_root,
      distinct_non_nested_control_root: true,
      initial_state: "absent_pre_s2",
      materialization_policy: "three_independent_gates_then_create_only",
    },
    runtime_audit_paths: {
      audit_base: PRODUCTION.runtime_audit_base,
      audit_base_dev: auditBaseStat.dev,
      audit_base_uid: auditBaseStat.uid,
      audit_base_gid: auditBaseStat.gid,
      audit_base_mode: auditBaseStat.mode & 0o7777,
      runtime_audit_parent_relative: "adr0040-d3-v2-session-start-runtime-audit",
      runtime_audit_leaf_relative: "r4.2",
      runtime_audit_root: PRODUCTION.runtime_audit_root,
      bootstrap_schema_pin: SCHEMAS.runtime_audit_bootstrap,
      bootstrap_prefix_states: ["audit_base_only", "parent_empty", "parent_plus_leaf"],
      directory_mode: 448,
      single_user_uid_assumption: true,
      same_device_required: true,
      no_symlink_required: true,
      no_extras_required: true,
      final_relative_template: "{idempotency_key}.json",
      temp_relative_template: ".{idempotency_key}.runtime-audit.stage.{invocation_nonce}.tmp",
      r4_2_audit_schema_pin: SCHEMAS.runtime_audit_object,
      legacy_r4_1_history_path: PRODUCTION.legacy_r4_1_audit_history,
      legacy_history_not_terminal_gate: true,
      max_object_bytes: 1048576,
      max_root_entries: 4096,
      required_before_first_injection: true,
      idempotency_scope: "per_receipt_immutable_object",
    },
    residuals: {
      accepted_residual_ids: acceptedResidualIds,
      non_v2_semantic_not_raw_preservation: true,
      foreign_corrupt_authority_incident_boundary: true,
      compliant_staged_temp_has_fresh_disposition: true,
      persistent_noncooperative_drift_bounded_exit: true,
      corrupt_authority_requires_external_protocol: true,
      direct_receipt_pending_nonexact_B_failclosed: true,
      token_not_secret: true,
    },
  };
  const contract = deepFreeze({ ...contractBase, static_contract_hash: jcsSha256(contractBase) });
  validateStaticContract(contract, { source, adapter, operator });

  const previewBase = {
    schema_version: SCHEMAS.static_preview_template,
    revision: REVISION,
    static_contract_hash: contract.static_contract_hash,
    source_commit_binding: SOURCE_COMMIT_BINDING,
    artifact_paths: ARTIFACT_PATHS,
    allowed_v2_prestate: contract.settings_contract.allowed_v2_prestate,
    desired_v2_template: contract.settings_contract.desired_v2_template,
    mutation_read_set: mutationReadSet,
    mutation_write_set: mutationWriteSet,
    conflict_rules: conflictRules,
    dynamic_field_names: uniqueSortedStrings(["A_full_identity", "A_raw_base64", "B_raw_sha256", "authorization_coordinate", "commit_token", "control_inventory", "operation_id", "preview_transcript_boundary", "runtime_attempt_id", "source_commit"]),
    zero_write_assertions: { no_audit_write: true, no_control_write: true, no_git_write: true, no_rollback_write: true, no_session_write: true, no_settings_write: true },
    stage_state: STAGE_STATE,
  };
  const preview = addSelfHash(previewBase, "preview_hash");
  validateStaticPreviewTemplate(preview, contract);

  const rawObjects = {
    source_manifest: Buffer.from(`${canonicalizeJcs(source)}\n`),
    adapter_manifest: Buffer.from(`${canonicalizeJcs(adapter)}\n`),
    operator_manifest: Buffer.from(`${canonicalizeJcs(operator)}\n`),
    static_contract: Buffer.from(`${canonicalizeJcs(contract)}\n`),
    static_preview_template: Buffer.from(`${canonicalizeJcs(preview)}\n`),
  };
  const validationIdentity = (kind, manifest) => ({ ...projection(manifest), raw_sha256: sha256(rawObjects[`${kind}_manifest`]) });
  const dossierBase = {
    schema_version: SCHEMAS.static_dossier,
    revision: REVISION,
    static_contract: contract,
    static_contract_hash: contract.static_contract_hash,
    assertions: {
      committed_inputs_exclude_dynamic_A_B_token_coordinate_operation: true,
      content_hash_dag_has_no_source_commit_fixed_point: true,
      manifest_projections_exclude_raw_hash_and_closure_payload: true,
      post_dossier_is_not_execute_input: true,
      r4_1_artifacts_immutable_and_not_reused: true,
      runtime_audit_is_separate_and_required: true,
      source_commit_is_dynamic_only: true,
      stage_remains_not_authorized: true,
    },
    source_closure_result: {
      source_commit_binding: SOURCE_COMMIT_BINDING,
      source_manifest: validationIdentity("source", source),
      adapter_manifest: validationIdentity("adapter", adapter),
      operator_manifest: validationIdentity("operator", operator),
      closure_validated: true,
      critical_artifact_existence_policy_validated: true,
    },
    preview_template_identity: { relative_path: ARTIFACT_PATHS.static_preview_template, raw_sha256: sha256(rawObjects.static_preview_template), self_hash: preview.preview_hash },
    stage_state: STAGE_STATE,
  };
  const dossier = addSelfHash(dossierBase, "dossier_hash");
  rawObjects.static_dossier = Buffer.from(`${canonicalizeJcs(dossier)}\n`);
  const memoryBundle = {
    source: { relative_path: ARTIFACT_PATHS.source_manifest, raw: rawObjects.source_manifest, raw_sha256: sha256(rawObjects.source_manifest), value: source },
    adapter: { relative_path: ARTIFACT_PATHS.adapter_manifest, raw: rawObjects.adapter_manifest, raw_sha256: sha256(rawObjects.adapter_manifest), value: adapter },
    operator: { relative_path: ARTIFACT_PATHS.operator_manifest, raw: rawObjects.operator_manifest, raw_sha256: sha256(rawObjects.operator_manifest), value: operator },
    contract: { relative_path: ARTIFACT_PATHS.static_contract, raw: rawObjects.static_contract, raw_sha256: sha256(rawObjects.static_contract), value: contract },
    preview: { relative_path: ARTIFACT_PATHS.static_preview_template, raw: rawObjects.static_preview_template, raw_sha256: sha256(rawObjects.static_preview_template), value: preview },
    dossier: { relative_path: ARTIFACT_PATHS.static_dossier, raw: rawObjects.static_dossier, raw_sha256: sha256(rawObjects.static_dossier), value: dossier },
  };
  validateStaticDossier(dossier, memoryBundle);
  for (const raw of Object.values(rawObjects)) if (raw.length > MAX_STATIC_BYTES) throw new Error("generated static artifact exceeds 4 MiB");
  return deepFreeze({ source_snapshot: sourceSnapshot.kind, values: { source_manifest: source, adapter_manifest: adapter, operator_manifest: operator, static_contract: contract, static_dossier: dossier, static_preview_template: preview }, raws: rawObjects, hashes: Object.fromEntries(NAMES.map((name) => [name, sha256(rawObjects[name])])) });
}

function verifyCommitted(bundle) {
  for (const name of NAMES) {
    const existing = fs.readFileSync(path.join(repoRoot, ...ARTIFACT_PATHS[name].split("/")));
    if (!existing.equals(bundle.raws[name])) throw new Error(`${name} bytes differ from content-only rebuild`);
  }
  loadAndValidateStaticBundle(repoRoot);
  return { verified: true, revision: REVISION, source_snapshot: bundle.source_snapshot, static_contract_hash: bundle.values.static_contract.static_contract_hash, dossier_hash: bundle.values.static_dossier.dossier_hash, preview_hash: bundle.values.static_preview_template.preview_hash, raw_sha256: bundle.hashes };
}

function runSemanticCli({ command: args, sourceSnapshot }) {
  const bundle = buildR42ArtifactBundle({ sourceSnapshot });
  if (args.length === 0 || (args.length === 1 && args[0] === "--summary")) {
    process.stdout.write(`${JSON.stringify({ revision: REVISION, source_snapshot: bundle.source_snapshot, static_contract_hash: bundle.values.static_contract.static_contract_hash, source_manifest_hash: bundle.values.source_manifest.self_hash, adapter_manifest_hash: bundle.values.adapter_manifest.self_hash, operator_manifest_hash: bundle.values.operator_manifest.self_hash, dossier_hash: bundle.values.static_dossier.dossier_hash, preview_hash: bundle.values.static_preview_template.preview_hash, raw_sha256: bundle.hashes, stage_state: STAGE_STATE })}\n`);
  } else if (args.length === 2 && args[0] === "--print" && NAMES.includes(args[1])) {
    process.stdout.write(bundle.raws[args[1]]);
  } else if (args.length === 1 && args[0] === "--verify") {
    process.stdout.write(`${JSON.stringify(verifyCommitted(bundle))}\n`);
  } else if (args.length === 1 && args[0] === "--write") {
    for (const name of NAMES) fs.writeFileSync(path.join(repoRoot, ...ARTIFACT_PATHS[name].split("/")), bundle.raws[name], { flag: "w", mode: 0o644 });
    process.stdout.write(`${JSON.stringify({ written: NAMES.map((name) => ARTIFACT_PATHS[name]), source_snapshot: bundle.source_snapshot, static_contract_hash: bundle.values.static_contract.static_contract_hash, stage_state: STAGE_STATE })}\n`);
  } else throw new Error("usage: generator [--summary|--print <artifact_name>|--verify|--write] [--source-snapshot=worktree|index]");
}

if (directExecution) {
  try {
    if (indexSnapshotParent) process.exitCode = runIndexSnapshotParent();
    else runSemanticCli(parsedCli);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
