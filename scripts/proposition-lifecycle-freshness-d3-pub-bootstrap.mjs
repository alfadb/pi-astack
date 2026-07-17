#!/usr/bin/env node
/** Builtin-only D3-PUB bootstrap. No production business module or package code is loaded from the live tree. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const CAPSULE_RELATIVE = "docs/evidence/2026-07-17-adr0040-d3-pub-source-capsule.json";
const EXECUTE_RELATIVE = "scripts/execute-proposition-lifecycle-freshness-d3-pub.mjs";
const BOOTSTRAP_RELATIVE = "scripts/proposition-lifecycle-freshness-d3-pub-bootstrap.mjs";
const PREVIEW_MODULE_RELATIVE = "extensions/_shared/proposition-lifecycle-freshness-production-preview.ts";
const CAPSULE_SCHEMA = "adr0040-d3-pub-self-contained-git-object-capsule/v2";
const EXTERNAL_TOOLS_SCHEMA = "adr0040-d3-pub-external-tool-manifest/v2";
const HASH = /^[0-9a-f]{64}$/;

export const D3_PUB_RUNTIME_ENVIRONMENT_POLICY = Object.freeze({
  schema_version: "adr0040-d3-pub-runtime-environment-policy/v1",
  node_options: "must_be_absent_or_empty",
  node_path: "must_be_absent_or_empty",
  process_exec_argv: "must_be_empty",
  other_environment: "inherited_but_non_authoritative",
});

export class D3PubBootstrapError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "D3PubBootstrapError";
    this.code = code;
    this.detail = detail ? Object.freeze(detail) : undefined;
  }
}

export function canonicalizeBuiltinJcs(value) {
  return render(normalize(value, "$root"));
}

export function assertD3PubRuntimeEntryPolicy(options = {}) {
  const policy = options.policy ?? D3_PUB_RUNTIME_ENVIRONMENT_POLICY;
  if (canonicalizeBuiltinJcs(policy) !== canonicalizeBuiltinJcs(D3_PUB_RUNTIME_ENVIRONMENT_POLICY)) fail("D3_PUB_RUNTIME_POLICY_INVALID", "runtime environment policy differs");
  const environment = options.environment ?? process.env;
  const execArgv = options.execArgv ?? process.execArgv;
  const nodeOptions = environment.NODE_OPTIONS ?? "";
  const nodePath = environment.NODE_PATH ?? "";
  if (typeof nodeOptions !== "string" || typeof nodePath !== "string" || !Array.isArray(execArgv)) fail("D3_PUB_RUNTIME_POLICY_INVALID", "runtime policy state shape differs");
  if (nodeOptions !== "" || nodePath !== "" || execArgv.length !== 0) {
    fail("D3_PUB_RUNTIME_POLICY_VIOLATION", "NODE_OPTIONS, NODE_PATH, and process.execArgv must be empty", {
      node_options_nonempty: nodeOptions !== "",
      node_path_nonempty: nodePath !== "",
      exec_argv: [...execArgv],
    });
  }
  return Object.freeze({ verified: true, policy: D3_PUB_RUNTIME_ENVIRONMENT_POLICY });
}

export function prepareD3PubCleanExecution(options) {
  const repoRoot = exactDirectory(options.repoRoot, "live repository");
  const capsulePath = path.join(repoRoot, ...CAPSULE_RELATIVE.split("/"));
  const capsuleRaw = readExactRegular(capsulePath, "source capsule");
  const capsule = validateBasicCapsule(capsuleRaw);

  // Every live check, including package code and runtime policy, precedes temporary-tree mutation.
  assertD3PubRuntimeEntryPolicy({ policy: capsule.external_tools.environment_policy });
  verifyLiveEntrypointBytes(repoRoot, capsule);
  verifyExternalToolClosure(repoRoot, capsule);

  const reconstructionRoot = fs.mkdtempSync(path.join(options.tempParent ?? os.tmpdir(), "pi-astack-d3-pub-clean-execution-"));
  const cleanTree = path.join(reconstructionRoot, "tree");
  try {
    reconstructBasicCapsule(capsule, cleanTree);
    const resolution = verifyCleanExternalToolClosure(cleanTree, capsule.external_tools);
    const cleanPackageJson = path.join(cleanTree, "package.json");
    const cleanRequire = createRequire(cleanPackageJson);
    const resolvedJiti = cleanRequire.resolve("jiti");
    const resolvedTypescript = cleanRequire.resolve("typescript");
    if (resolvedJiti !== resolution.jiti_entry_resolved_path || resolvedTypescript !== resolution.typescript_entry_resolved_path) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "clean package resolution changed before jiti load");
    const { createJiti } = cleanRequire("jiti");
    if (typeof createJiti !== "function") fail("D3_PUB_EXTERNAL_TOOL_INVALID", "verified clean jiti package does not export createJiti");
    const cleanJiti = createJiti(cleanTree, { interopDefault: true, fsCache: false, moduleCache: false });
    let closed = false;
    return Object.freeze({
      capsule,
      capsuleRaw,
      cleanTree,
      liveRepoRoot: repoRoot,
      externalToolResolution: resolution,
      loadCleanModule(relativeInput) {
        if (closed) fail("D3_PUB_CLEAN_TREE_CLOSED", "clean execution tree has already been removed");
        verifyCleanExternalToolClosure(cleanTree, capsule.external_tools);
        const relative = safeRelative(relativeInput);
        const expected = sourceFileMap(capsule).get(relative);
        if (!expected) fail("D3_PUB_CLEAN_MODULE_UNBOUND", "requested clean module is outside the capsule", { relative });
        const file = path.join(cleanTree, ...relative.split("/"));
        const raw = readExactRegular(file, `clean module ${relative}`);
        if (!raw.equals(expected)) fail("D3_PUB_CLEAN_MODULE_DRIFT", "clean module bytes differ from capsule", { relative });
        return cleanJiti(file);
      },
      close() {
        if (closed) return;
        closed = true;
        fs.rmSync(reconstructionRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(reconstructionRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function executeD3PubCleanPublisher(options) {
  const prepared = prepareD3PubCleanExecution({ repoRoot: options.repoRoot });
  try {
    const preview = prepared.loadCleanModule(PREVIEW_MODULE_RELATIVE);
    if (typeof preview.executeFrozenD3PubProductionFromCleanTree !== "function") fail("D3_PUB_CLEAN_ENTRYPOINT_INVALID", "capsule preview module lacks the clean-tree production entrypoint");
    return await preview.executeFrozenD3PubProductionFromCleanTree({
      cleanTree: prepared.cleanTree,
      liveRepoRoot: prepared.liveRepoRoot,
      capsule: prepared.capsule,
      capsuleRaw: prepared.capsuleRaw,
      sessionPath: options.sessionPath,
    });
  } finally {
    prepared.close();
  }
}

function validateBasicCapsule(raw) {
  let value;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch (error) { fail("D3_PUB_CAPSULE_JSON_INVALID", "source capsule is invalid JSON", { error: errorMessage(error) }); }
  const capsule = asRecord(value, "source capsule");
  if (`${canonicalizeBuiltinJcs(capsule)}\n` !== raw.toString("utf8")) fail("D3_PUB_CAPSULE_JSON_NONCANONICAL", "source capsule is not canonical JCS plus LF");
  if (capsule.schema_version !== CAPSULE_SCHEMA || !HASH.test(String(capsule.capsule_hash))) fail("D3_PUB_CAPSULE_INVALID", "source capsule identity differs");
  const base = { ...capsule }; delete base.capsule_hash;
  if (sha256Hex(canonicalizeBuiltinJcs(base)) !== capsule.capsule_hash) fail("D3_PUB_CAPSULE_INVALID", "source capsule self hash differs");
  if (!Array.isArray(capsule.source_files) || !Array.isArray(capsule.git_objects)) fail("D3_PUB_CAPSULE_INVALID", "source capsule inventories differ");
  const objects = new Map();
  for (const [index, input] of capsule.git_objects.entries()) {
    const row = asRecord(input, `git object ${index}`);
    if (!HASH.test(String(row.raw_sha256)) || !/^[0-9a-f]{40}$/.test(String(row.oid)) || !["blob", "tree", "commit"].includes(row.kind) || typeof row.raw_base64 !== "string") fail("D3_PUB_CAPSULE_OBJECT_INVALID", "Git object row differs", { index });
    const bytes = decodeBase64(row.raw_base64, `git object ${index}`);
    if (bytes.length !== row.bytes || sha256Hex(bytes) !== row.raw_sha256 || gitOid(row.kind, bytes) !== row.oid || objects.has(row.oid)) fail("D3_PUB_CAPSULE_OBJECT_INVALID", "Git object bytes or identity differ", { index });
    objects.set(row.oid, { kind: row.kind, bytes });
  }
  const files = new Set();
  for (const [index, input] of capsule.source_files.entries()) {
    const row = asRecord(input, `source file ${index}`);
    const relative = safeRelative(row.path);
    if (files.has(relative) || typeof row.raw_base64 !== "string" || !HASH.test(String(row.sha256)) || !/^[0-9a-f]{40}$/.test(String(row.blob_oid))) fail("D3_PUB_CAPSULE_FILE_INVALID", "source file row differs", { index });
    const bytes = decodeBase64(row.raw_base64, `source file ${relative}`);
    const object = objects.get(row.blob_oid);
    if (bytes.length !== row.bytes || sha256Hex(bytes) !== row.sha256 || gitOid("blob", bytes) !== row.blob_oid || object?.kind !== "blob" || !object.bytes.equals(bytes)) fail("D3_PUB_CAPSULE_FILE_INVALID", "source file/blob binding differs", { relative });
    files.add(relative);
  }
  for (const relative of [EXECUTE_RELATIVE, BOOTSTRAP_RELATIVE, PREVIEW_MODULE_RELATIVE]) if (!files.has(relative)) fail("D3_PUB_CAPSULE_REQUIRED_FILE_MISSING", "capsule omits a clean-execution boundary file", { relative });
  validateExternalToolManifest(capsule.external_tools, capsule);
  return Object.freeze(capsule);
}

function validateExternalToolManifest(input, capsule) {
  const manifest = asRecord(input, "external tool manifest");
  if (manifest.schema_version !== EXTERNAL_TOOLS_SCHEMA || !HASH.test(String(manifest.manifest_hash))) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external tool manifest identity differs");
  const base = { ...manifest }; delete base.manifest_hash;
  if (sha256Hex(canonicalizeBuiltinJcs(base)) !== manifest.manifest_hash) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external tool manifest self hash differs");
  const runtime = asRecord(manifest.node_runtime, "Node runtime");
  for (const field of ["observed_exec_path", "observed_exec_realpath", "version"]) if (typeof runtime[field] !== "string" || !runtime[field]) fail("D3_PUB_EXTERNAL_TOOL_INVALID", `Node runtime ${field} differs`);
  if (!Number.isSafeInteger(runtime.exec_bytes) || runtime.exec_bytes <= 0 || !HASH.test(String(runtime.exec_sha256))) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "Node executable byte identity differs");
  if (canonicalizeBuiltinJcs(manifest.environment_policy) !== canonicalizeBuiltinJcs(D3_PUB_RUNTIME_ENVIRONMENT_POLICY)) fail("D3_PUB_RUNTIME_POLICY_INVALID", "bound runtime environment policy differs");
  if (!Array.isArray(manifest.packages) || !Array.isArray(manifest.repository_manifests)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package/manifests inventory differs");
  const packageNames = manifest.packages.map((row) => asRecord(row, "external package").name);
  if (canonicalizeBuiltinJcs(packageNames) !== canonicalizeBuiltinJcs(["jiti", "typescript"])) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package inventory differs");
  for (const inputRow of manifest.packages) validateExternalPackageRow(asRecord(inputRow, "external package"));
  const sourceFiles = new Map(capsule.source_files.map((row) => [row.path, row]));
  if (canonicalizeBuiltinJcs(manifest.repository_manifests.map((row) => asRecord(row, "repository manifest").relative_path)) !== canonicalizeBuiltinJcs(["package.json", "package-lock.json"])) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "repository manifest inventory differs");
  for (const inputRow of manifest.repository_manifests) {
    const row = asRecord(inputRow, "repository manifest");
    const relative = safeRelative(row.relative_path);
    const source = sourceFiles.get(relative);
    if (!source || row.bytes !== source.bytes || row.raw_sha256 !== source.sha256) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "repository manifest is not bound by capsule source bytes", { relative });
  }
}

function validateExternalPackageRow(row) {
  const name = row.name;
  if (!["jiti", "typescript"].includes(name) || typeof row.version !== "string" || !row.version || row.package_root_relative !== `node_modules/${name}` || safeRelative(row.package_root_relative) !== row.package_root_relative) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package row identity differs", { name });
  const packageJsonRelative = safeRelative(row.package_json_relative_path);
  const entryRelative = safeRelative(row.entry_relative_path);
  const expectedStrategy = name === "jiti" ? "all_package_runtime_js_cjs_mjs_json" : "package_json_plus_resolved_entry_and_no_relative_runtime_dependencies";
  if (packageJsonRelative !== "package.json" || row.closure_strategy !== expectedStrategy || !Array.isArray(row.local_runtime_dependencies) || row.local_runtime_dependencies.length !== 0) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package closure declaration differs", { name });
  const observed = asRecord(row.observed_live_resolution, `${name} observed resolution`);
  if (typeof observed.package_json_resolved_path !== "string" || !path.isAbsolute(observed.package_json_resolved_path) || typeof observed.entry_resolved_path !== "string" || !path.isAbsolute(observed.entry_resolved_path)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package observation differs", { name });
  if (!Array.isArray(row.files) || row.files.length === 0 || !HASH.test(String(row.files_hash)) || sha256Hex(canonicalizeBuiltinJcs(row.files)) !== row.files_hash) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file inventory hash differs", { name });
  const seen = new Set();
  let previous = "";
  for (const inputFile of row.files) {
    const file = asRecord(inputFile, `${name} runtime file`);
    const relative = safeRelative(file.relative_path);
    if (seen.has(relative) || (previous && previous.localeCompare(relative) >= 0) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !Number.isSafeInteger(file.mode)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file path/order/size/mode differs", { name, relative });
    assertSafeRuntimeMode(file.mode, false, `${name} ${relative}`);
    if (!HASH.test(String(file.sha256)) || typeof file.raw_base64 !== "string") fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file hash/base64 differs", { name, relative });
    const raw = decodeBase64(file.raw_base64, `${name} ${relative}`);
    if (raw.length !== file.bytes || sha256Hex(raw) !== file.sha256) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package file bytes differ", { name, relative });
    previous = relative;
    seen.add(relative);
  }
  if (!seen.has(packageJsonRelative) || !seen.has(entryRelative)) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package closure omits package.json or entry", { name });
  const packageJson = asRecord(row.files.find((file) => file.relative_path === packageJsonRelative), `${name} package.json row`);
  let parsed;
  try { parsed = JSON.parse(decodeBase64(packageJson.raw_base64, `${name} package.json`).toString("utf8")); }
  catch { fail("D3_PUB_EXTERNAL_TOOL_INVALID", `${name} package.json is invalid JSON`); }
  if (parsed?.name !== name || parsed?.version !== row.version) fail("D3_PUB_EXTERNAL_TOOL_INVALID", "external package bytes do not bind name/version", { name });
}

function verifyLiveEntrypointBytes(repoRoot, capsule) {
  const files = sourceFileMap(capsule);
  for (const relative of [EXECUTE_RELATIVE, BOOTSTRAP_RELATIVE]) {
    const expected = files.get(relative);
    if (!expected) fail("D3_PUB_BOOTSTRAP_SOURCE_UNBOUND", "launcher/bootstrap is absent from capsule", { relative });
    const actual = readExactRegular(path.join(repoRoot, ...relative.split("/")), `live ${relative}`);
    if (!actual.equals(expected)) fail("D3_PUB_BOOTSTRAP_SOURCE_DRIFT", "live launcher/bootstrap bytes differ from capsule before mutation", { relative, expected_sha256: sha256Hex(expected), actual_sha256: sha256Hex(actual) });
  }
}

function verifyExternalToolClosure(repoRoot, capsule) {
  const manifest = capsule.external_tools;
  validateExternalToolManifest(manifest, capsule);
  assertD3PubRuntimeEntryPolicy({ policy: manifest.environment_policy });
  const runtime = manifest.node_runtime;
  const executable = readExactRegular(process.execPath, "Node executable");
  if (process.execPath !== runtime.observed_exec_path || fs.realpathSync.native(process.execPath) !== runtime.observed_exec_realpath || process.version !== runtime.version || executable.length !== runtime.exec_bytes || sha256Hex(executable) !== runtime.exec_sha256) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "Node executable path/version/bytes differ");
  for (const input of manifest.packages) verifyLiveExternalPackage(repoRoot, asRecord(input, "external package"));
  for (const input of manifest.repository_manifests) {
    const row = asRecord(input, "repository manifest");
    const relative = safeRelative(row.relative_path);
    const raw = readExactRegular(path.join(repoRoot, ...relative.split("/")), `live ${relative}`);
    if (raw.length !== row.bytes || sha256Hex(raw) !== row.raw_sha256) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "repository package/lock manifest differs", { relative });
  }
}

function verifyLiveExternalPackage(repoRoot, row) {
  const name = row.name;
  const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
  const packageJsonResolved = path.resolve(requireFromRepo.resolve(`${name}/package.json`));
  const entryResolved = path.resolve(requireFromRepo.resolve(name));
  const packageRoot = exactDirectory(path.dirname(packageJsonResolved), `${name} live package root`);
  if (packageRoot !== path.join(repoRoot, "node_modules", name)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", `${name} resolved outside exact repository node_modules`);
  const packageJsonRelative = packageRelative(packageRoot, packageJsonResolved);
  const entryRelative = packageRelative(packageRoot, entryResolved);
  if (packageJsonRelative !== row.package_json_relative_path || entryRelative !== row.entry_relative_path) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", `${name} package entry resolution differs`);
  const selected = name === "jiti" ? null : new Set([packageJsonRelative, entryRelative]);
  const actualRelatives = collectRuntimePackageFiles(packageRoot, selected);
  const expectedRelatives = row.files.map((file) => file.relative_path);
  if (canonicalizeBuiltinJcs(actualRelatives) !== canonicalizeBuiltinJcs(expectedRelatives)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", `${name} runtime file inventory differs`);
  for (const inputFile of row.files) {
    const expected = asRecord(inputFile, `${name} runtime file`);
    const relative = safeRelative(expected.relative_path);
    const file = path.join(packageRoot, ...relative.split("/"));
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o7777) !== expected.mode) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", `${name} runtime file type/mode differs`, { relative });
    const raw = readExactRegular(file, `${name} runtime ${relative}`);
    const after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || raw.length !== expected.bytes || sha256Hex(raw) !== expected.sha256 || raw.toString("base64") !== expected.raw_base64) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", `${name} runtime file bytes differ`, { relative });
  }
}

function reconstructBasicCapsule(capsule, destination) {
  if (fs.existsSync(destination)) fail("D3_PUB_CAPSULE_DESTINATION_EXISTS", "clean reconstruction destination exists");
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const input of capsule.source_files) {
    const row = asRecord(input, "capsule reconstruction row");
    const relative = safeRelative(row.path);
    const raw = decodeBase64(row.raw_base64, `reconstruction ${relative}`);
    const file = path.join(destination, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
    const readback = readExactRegular(file, `reconstructed ${relative}`);
    if (!readback.equals(raw) || sha256Hex(readback) !== row.sha256) fail("D3_PUB_CAPSULE_RECONSTRUCTION_INVALID", "clean-tree source file differs", { relative });
  }
  for (const inputPackage of capsule.external_tools.packages) {
    const packageRow = asRecord(inputPackage, "external package");
    const packageRootRelative = safeRelative(packageRow.package_root_relative);
    for (const inputFile of packageRow.files) {
      const row = asRecord(inputFile, "external package file");
      const relative = safeRelative(row.relative_path);
      const raw = decodeBase64(row.raw_base64, `external reconstruction ${packageRow.name} ${relative}`);
      const file = path.join(destination, ...packageRootRelative.split("/"), ...relative.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, raw, { flag: "wx", mode: row.mode });
      fs.chmodSync(file, row.mode);
      const readback = readExactRegular(file, `reconstructed external ${packageRow.name} ${relative}`);
      const stat = fs.lstatSync(file);
      if (!readback.equals(raw) || readback.length !== row.bytes || sha256Hex(readback) !== row.sha256 || (stat.mode & 0o7777) !== row.mode) fail("D3_PUB_CAPSULE_RECONSTRUCTION_INVALID", "clean-tree external package file differs", { name: packageRow.name, relative });
    }
  }
}

function verifyCleanExternalToolClosure(cleanTree, tools) {
  const resolutions = {};
  for (const inputPackage of tools.packages) {
    const packageRow = asRecord(inputPackage, "external package");
    const packageRoot = exactDirectory(path.join(cleanTree, ...safeRelative(packageRow.package_root_relative).split("/")), `${packageRow.name} clean package root`);
    for (const inputFile of packageRow.files) {
      const row = asRecord(inputFile, "clean external package file");
      const relative = safeRelative(row.relative_path);
      const file = path.join(packageRoot, ...relative.split("/"));
      const raw = readExactRegular(file, `clean external ${packageRow.name} ${relative}`);
      const stat = fs.lstatSync(file);
      if (raw.length !== row.bytes || sha256Hex(raw) !== row.sha256 || raw.toString("base64") !== row.raw_base64 || (stat.mode & 0o7777) !== row.mode) fail("D3_PUB_CLEAN_TREE_DRIFT", "clean external package code differs", { name: packageRow.name, relative });
    }
  }
  const cleanPackageJson = path.join(cleanTree, "package.json");
  readExactRegular(cleanPackageJson, "clean repository package.json");
  const cleanRequire = createRequire(cleanPackageJson);
  for (const inputPackage of tools.packages) {
    const row = asRecord(inputPackage, "external package");
    const name = row.name;
    const expectedPackageJson = path.join(cleanTree, ...safeRelative(row.package_root_relative).split("/"), ...safeRelative(row.package_json_relative_path).split("/"));
    const expectedEntry = path.join(cleanTree, ...safeRelative(row.package_root_relative).split("/"), ...safeRelative(row.entry_relative_path).split("/"));
    const resolvedPackageJson = cleanRequire.resolve(`${name}/package.json`);
    const resolvedEntry = cleanRequire.resolve(name);
    if (resolvedPackageJson !== expectedPackageJson || resolvedEntry !== expectedEntry || !insideTree(cleanTree, resolvedPackageJson) || !insideTree(cleanTree, resolvedEntry)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "clean external package resolved outside reconstructed clean tree", { name, resolvedPackageJson, resolvedEntry });
    resolutions[`${name}_package_json_resolved_path`] = resolvedPackageJson;
    resolutions[`${name}_entry_resolved_path`] = resolvedEntry;
  }
  return Object.freeze({
    verified: true,
    all_resolved_within_clean_tree: true,
    jiti_package_json_resolved_path: resolutions.jiti_package_json_resolved_path,
    jiti_entry_resolved_path: resolutions.jiti_entry_resolved_path,
    typescript_package_json_resolved_path: resolutions.typescript_package_json_resolved_path,
    typescript_entry_resolved_path: resolutions.typescript_entry_resolved_path,
  });
}

function collectRuntimePackageFiles(packageRoot, selected) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "external package contains a symlink or non-file entry", { relative });
      assertSafeRuntimeMode(stat.mode & 0o7777, stat.isDirectory(), `external package ${relative}`);
      if (stat.isDirectory()) walk(file, relative);
      else if (selected ? selected.has(relative) : /^\.(?:js|cjs|mjs|json)$/.test(path.extname(relative))) files.push(relative);
    }
  };
  walk(packageRoot, "");
  return files.sort();
}

function sourceFileMap(capsule) {
  return new Map(capsule.source_files.map((input) => {
    const row = asRecord(input, "capsule source file");
    return [safeRelative(row.path), decodeBase64(row.raw_base64, `source ${row.path}`)];
  }));
}

function packageRelative(packageRoot, file) {
  const relative = path.relative(packageRoot, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) fail("D3_PUB_EXTERNAL_TOOL_DRIFT", "external package entry resolves outside package root", { packageRoot, file });
  return safeRelative(relative);
}

function insideTree(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeRuntimeMode(mode, directory, label) {
  const required = directory ? 0o500 : 0o400;
  if (!Number.isSafeInteger(mode) || (mode & 0o7000) !== 0 || (mode & required) !== required) fail("D3_PUB_EXTERNAL_TOOL_MODE_INVALID", "external runtime path has unsafe mode", { label, mode });
}

function normalize(value, at) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { assertUnicode(value, at); return value; }
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("D3_PUB_JCS_INVALID", "non-finite number", { at }); return Object.is(value, -0) ? 0 : value; }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${at}[${index}]`));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("D3_PUB_JCS_INVALID", "non-plain object", { at });
    const output = {};
    for (const key of Object.keys(value).sort()) { assertUnicode(key, `${at} key`); if (value[key] === undefined) fail("D3_PUB_JCS_INVALID", "undefined value", { at: `${at}.${key}` }); output[key] = normalize(value[key], `${at}.${key}`); }
    return output;
  }
  fail("D3_PUB_JCS_INVALID", `unsupported ${typeof value}`, { at });
}
function render(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(render).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${render(value[key])}`).join(",")}}`;
}
function assertUnicode(value, at) { for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) fail("D3_PUB_JCS_INVALID", "lone surrogate", { at }); index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) fail("D3_PUB_JCS_INVALID", "lone surrogate", { at }); } }
function decodeBase64(value, label) { if (typeof value !== "string") fail("D3_PUB_CAPSULE_BASE64_INVALID", `${label} base64 differs`); const raw = Buffer.from(value, "base64"); if (raw.toString("base64") !== value) fail("D3_PUB_CAPSULE_BASE64_INVALID", `${label} is not canonical base64`); return raw; }
function gitOid(kind, raw) { return crypto.createHash("sha1").update(Buffer.from(`${kind} ${raw.length}\0`)).update(raw).digest("hex"); }
function sha256Hex(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeRelative(value) { if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) fail("D3_PUB_CAPSULE_PATH_INVALID", "repository-relative path differs", { value }); return value; }
function exactDirectory(input, label) { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) fail("D3_PUB_BOOTSTRAP_DIRECTORY_UNSAFE", `${label} must be an exact directory`, { resolved }); return resolved; }
function readExactRegular(fileInput, label) { const file = path.resolve(fileInput); const named = fs.lstatSync(file); if (named.isSymbolicLink() || !named.isFile()) fail("D3_PUB_BOOTSTRAP_FILE_UNSAFE", `${label} is not a no-follow regular file`); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const before = fs.fstatSync(fd); const raw = fs.readFileSync(fd); const after = fs.fstatSync(fd); const current = fs.lstatSync(file); if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino || before.mode !== named.mode || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size || raw.length !== before.size || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.mode !== after.mode) fail("D3_PUB_BOOTSTRAP_FILE_RACE", `${label} changed while read`); return raw; } finally { fs.closeSync(fd); } }
function asRecord(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("D3_PUB_BOOTSTRAP_SHAPE_INVALID", `${label} must be an object`); return value; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function fail(code, message, detail) { throw new D3PubBootstrapError(code, message, detail); }
