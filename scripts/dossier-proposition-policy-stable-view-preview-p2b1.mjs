#!/usr/bin/env node
/** ADR0040 P2b.1 real production read-only preview. Never publishes or mutates abrain. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const graphTools = jiti(path.join(repoRoot, "extensions/_shared/typescript-static-dependency-graph.ts"));

const PLAN_RELATIVE = "docs/evidence/adr0040-p2b1-stable-view-design/implementation-authorization-plan.json";
const PLAN_RAW_SHA256 = "44df57357ff0e32602a08171fb57d73872f8ef43a6df08d5d3369cfe28921ca5";
const PLAN_HASH = "b985654d88783e39f5d07d35fa42a5bfcf892eb7dcaa07eaa2314b623be07ce0";
const AUTHORIZATION_TEXT_SHA256 = "f47a4ee0fb66e1b8f9fcedf665af5d614e2df3f75c09196feb4f84d5200c26e4";
const SESSION_ID = "019f569c-40d3-73f0-9a5f-666b395f6b9a";
const BUNDLE_HASH = "dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0";
const TARGET_INVENTORY_HASH = "ee29acf5f4fc106156999f6685baf407eaf1aa523e6d2f5a292de3d4be4edb4d";
const OUTPUT_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2b1-production-read-only-preview-dossier.json";
const PROFILE_RELATIVE = "schemas/proposition-policy-stable-view-compile-profile-v1.json";
const COMPILER_RELATIVE = "extensions/_shared/proposition-policy-stable-view.ts";
const HELPER_RELATIVE = "extensions/_shared/proposition-policy-stable-view-preview.ts";
const SMOKE_RELATIVE = "scripts/smoke-proposition-policy-stable-view-p2b1.mjs";
const RUNNER_RELATIVE = "scripts/dossier-proposition-policy-stable-view-preview-p2b1.mjs";
const P2A_PLAN_RELATIVE = "docs/evidence/adr0040-p2a2-publication-review-dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0/publication-plan-v2.json";
const P2A_POST_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a2-production-post-execution-dossier.json";
const P2A_PLAN_RAW = "20f400af40eb9119d17c1fb9b26eb0b2383777fd364f37b326cad4ca1875b408";
const P2A_PLAN_HASH = "3177101400ceed3b5da86d6d6d99a1b269d8deef9b9bd418cfbaa33ad0c91f0a";
const P2A_POST_RAW = "8deffe753352e18296ac4b53b417f1f1300389a0f1e001f36e46a192d0e7f0a7";
const P2A_POST_HASH = "3ee5e8b668ad60d12137429e35abfb7ea1a6a524033011c4f7d90020d1fc3515";
const SOURCE_ANCHORS = Object.freeze([
  { relative_path: "extensions/_shared/proposition-policy-push-shadow.ts", raw_sha256: "d907badcc65206c5b824875809b8d81ec448abbd83f36ea1790b878da699bb09" },
  { relative_path: "extensions/_shared/proposition-policy-push-live-publication-plan.ts", raw_sha256: "2670829f4f37d529f0173b2229a75a175138b065cd541b308b463940c0240833" },
  { relative_path: "extensions/_shared/proposition-policy-push-live-publication.ts", raw_sha256: "e18db0cb6f35ae1ed614e5e0750e79fb0a494e67082fda3e41d64ecc613da87c" },
]);
const CREATED_PATHS = Object.freeze([PROFILE_RELATIVE, COMPILER_RELATIVE, HELPER_RELATIVE, SMOKE_RELATIVE, RUNNER_RELATIVE, OUTPUT_RELATIVE].sort(compare));
const SOURCE_ARTIFACTS = Object.freeze([PROFILE_RELATIVE, COMPILER_RELATIVE, HELPER_RELATIVE, SMOKE_RELATIVE, RUNNER_RELATIVE]);
const STABLE_NAMES = Object.freeze(["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"]);
const BUNDLE_ARTIFACTS = Object.freeze([
  { name: "diagnostics.json", bytes: 675, sha256: "9daf2ec369ec6c70171da4c5683935ad61d42395ac7786b2c05474e781ccdfda" },
  { name: "entries.json", bytes: 205, sha256: "ba5629a446c01874a0376c86fcea6c623509d50fe488547562175b6b27d16303" },
  { name: "exclusions.json", bytes: 619, sha256: "c29e6b12cf0ba4b980202ae42807ee5b18fd1de3cf01c606a2f3bcf28382984f" },
  { name: "manifest.json", bytes: 4836, sha256: "a9cd4467c9da352463b66a539077c03aef6aaf7f41bcfa9b8f611768223e40e8" },
]);
const DOSSIER_SCHEMA = "proposition-policy-stable-view-p2b1-read-only-preview-dossier/v1";
const DOSSIER_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted";
const PROFILE_HASH = "e79c4fcdcdeab059f22f19e85eac4512c8d3d440fc05c9e1c8f39be64b7d21b2";
const O_PATH = 0x200000;

function fail(code, message, detail) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.detail = detail;
  throw error;
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NONCANONICAL_NUMBER", "JCS rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail("NONCANONICAL_VALUE", "JCS input contains unsupported value");
  return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function readCanonicalBound(relative, rawHash, selfField, selfHash) {
  const file = path.join(repoRoot, ...relative.split("/"));
  assertRegularPath(file, relative);
  const raw = fs.readFileSync(file);
  if (sha256(raw) !== rawHash) fail("BOUND_RAW_HASH_MISMATCH", "bound file raw hash differs", { relative });
  const parsed = JSON.parse(raw);
  if (`${canonical(parsed)}\n` !== raw.toString("utf8")) fail("BOUND_NOT_CANONICAL", "bound file is not exact JCS plus LF", { relative });
  const actualSelf = parsed[selfField];
  const base = { ...parsed };
  delete base[selfField];
  if (actualSelf !== selfHash || sha256(canonical(base)) !== selfHash) fail("BOUND_SELF_HASH_MISMATCH", "bound file self-hash differs", { relative, actualSelf });
  return { raw, parsed };
}

function assertRegularPath(file, label) {
  assertAncestors(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file) fail("UNSAFE_REGULAR_PATH", "path is not an exact regular file", { label, file });
}

function assertDirectoryPath(directory, label) {
  assertAncestors(directory);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) fail("UNSAFE_DIRECTORY_PATH", "path is not an exact directory", { label, directory });
}

function assertAncestors(file) {
  const target = path.resolve(file);
  let current = path.parse(target).root;
  for (const component of path.relative(current, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("UNSAFE_ANCESTOR", "path ancestor is a symlink or non-directory", { current });
  }
}

function statIdentity(stat) {
  return deepFreeze({ dev: Number(stat.dev), ino: Number(stat.ino), mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid, nlink: stat.nlink });
}

function sameIdentity(left, right) {
  return canonical(left) === canonical(right);
}

function readFd(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) fail("FD_NOT_REGULAR", "opened descriptor is not a regular file", { fd });
  const output = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < output.length) {
    const count = fs.readSync(fd, output, offset, output.length - offset, offset);
    if (count === 0) fail("FD_SHORT_READ", "opened descriptor truncated during read", { fd, offset, expected: output.length });
    offset += count;
  }
  const after = fs.fstatSync(fd);
  if (!sameIdentity(statIdentity(stat), statIdentity(after))) fail("FD_IDENTITY_CHANGED", "opened descriptor identity changed during read", { fd });
  return output;
}

function openRegularVerified(file, label, expectedHash = null) {
  assertRegularPath(file, label);
  const beforePath = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isFile() || !sameIdentity(statIdentity(beforePath), statIdentity(fdStat))) {
    fs.closeSync(fd);
    fail("OPEN_IDENTITY_MISMATCH", "opened descriptor differs from named regular path", { label });
  }
  const raw = readFd(fd);
  const rawHash = sha256(raw);
  if (expectedHash && rawHash !== expectedHash) {
    fs.closeSync(fd);
    fail("OPEN_HASH_MISMATCH", "opened descriptor bytes differ from binding", { label, expectedHash, rawHash });
  }
  const handle = { file, label, fd, raw, raw_sha256: rawHash, before: statIdentity(fdStat), after_read: null, after_sandbox: null };
  handle.after_read = recheckRegular(handle, "after_read");
  return handle;
}

function recheckRegular(handle, stage) {
  const pathStat = fs.lstatSync(handle.file);
  const fdStat = fs.fstatSync(handle.fd);
  const identity = statIdentity(fdStat);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameIdentity(statIdentity(pathStat), handle.before) || !sameIdentity(identity, handle.before)) {
    fail("INPUT_IDENTITY_CHANGED", "opened input identity changed", { label: handle.label, stage });
  }
  if (sha256(readFd(handle.fd)) !== handle.raw_sha256) fail("INPUT_BYTES_CHANGED", "opened input bytes changed", { label: handle.label, stage });
  return identity;
}

function openDirectoryVerified(directory, label) {
  assertDirectoryPath(directory, label);
  const beforePath = fs.lstatSync(directory);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isDirectory() || !sameIdentity(statIdentity(beforePath), statIdentity(fdStat))) {
    fs.closeSync(fd);
    fail("OPEN_DIRECTORY_IDENTITY_MISMATCH", "opened directory descriptor differs from named path", { label });
  }
  return { file: directory, label, fd, before: statIdentity(fdStat), after_sandbox: null };
}

function recheckDirectory(handle) {
  const pathStat = fs.lstatSync(handle.file);
  const fdStat = fs.fstatSync(handle.fd);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || !sameIdentity(statIdentity(pathStat), handle.before) || !sameIdentity(statIdentity(fdStat), handle.before)) fail("DIRECTORY_IDENTITY_CHANGED", "opened directory identity changed", { label: handle.label });
  return statIdentity(fdStat);
}

function openSymlinkVerified(file, label, expectedValue) {
  assertAncestors(file);
  const beforePath = fs.lstatSync(file);
  if (!beforePath.isSymbolicLink()) fail("POINTER_NOT_SYMLINK", "published pointer is not a symlink", { label });
  const value = fs.readlinkSync(file);
  if (value !== expectedValue) fail("POINTER_VALUE_MISMATCH", "published pointer value differs", { expectedValue, value });
  const fd = fs.openSync(file, O_PATH | fs.constants.O_NOFOLLOW);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isSymbolicLink() || !sameIdentity(statIdentity(beforePath), statIdentity(fdStat))) {
    fs.closeSync(fd);
    fail("POINTER_OPEN_IDENTITY_MISMATCH", "opened pointer descriptor differs from named path");
  }
  return { file, label, fd, value, value_sha256: sha256(value), before: statIdentity(fdStat), after_read: recheckSymlink({ file, label, fd, value, before: statIdentity(fdStat) }, "after_read"), after_sandbox: null };
}

function recheckSymlink(handle, stage) {
  const pathStat = fs.lstatSync(handle.file);
  const fdStat = fs.fstatSync(handle.fd);
  const value = fs.readlinkSync(handle.file);
  if (!pathStat.isSymbolicLink() || !fdStat.isSymbolicLink() || value !== handle.value || !sameIdentity(statIdentity(pathStat), handle.before) || !sameIdentity(statIdentity(fdStat), handle.before)) fail("POINTER_IDENTITY_CHANGED", "published pointer changed", { stage });
  return statIdentity(fdStat);
}

function identityEvidence(handle) {
  return deepFreeze({
    label: handle.label,
    bytes: handle.raw?.length ?? 0,
    raw_sha256: handle.raw_sha256 ?? handle.value_sha256 ?? null,
    symlink_value: handle.value ?? null,
    before: handle.before,
    after_read: handle.after_read ?? null,
    after_sandbox: handle.after_sandbox,
  });
}

function genericWholeSnapshot(root) {
  assertDirectoryPath(root, "whole abrain root");
  const rows = [];
  const walk = (file) => {
    const before = fs.lstatSync(file);
    const relative = path.relative(root, file).split(path.sep).join("/") || ".";
    if (before.isSymbolicLink()) {
      const value = fs.readlinkSync(file);
      const after = fs.lstatSync(file);
      if (!after.isSymbolicLink() || !sameIdentity(statIdentity(before), statIdentity(after)) || fs.readlinkSync(file) !== value) fail("SNAPSHOT_RACE", "generic symlink changed during snapshot", { relative });
      rows.push({ relative, kind: "symlink", bytes: 0, sha256: sha256(value), value, mode: before.mode, uid: before.uid, gid: before.gid, dev: Number(before.dev), ino: Number(before.ino) });
      return;
    }
    if (before.isDirectory()) {
      const children = fs.readdirSync(file).sort(compare);
      const after = fs.lstatSync(file);
      if (!after.isDirectory() || !sameIdentity(statIdentity(before), statIdentity(after)) || canonical(children) !== canonical(fs.readdirSync(file).sort(compare))) fail("SNAPSHOT_RACE", "generic directory changed during snapshot", { relative });
      rows.push({ relative, kind: "directory", bytes: 0, sha256: sha256(canonical({ kind: "directory", children })), value: null, mode: before.mode, uid: before.uid, gid: before.gid, dev: Number(before.dev), ino: Number(before.ino) });
      for (const child of children) walk(path.join(file, child));
      return;
    }
    if (!before.isFile()) fail("SNAPSHOT_UNSUPPORTED", "generic snapshot encountered unsupported entry", { relative });
    const raw = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (!after.isFile() || !sameIdentity(statIdentity(before), statIdentity(after))) fail("SNAPSHOT_RACE", "generic file changed during snapshot", { relative });
    rows.push({ relative, kind: "file", bytes: raw.length, sha256: sha256(raw), value: null, mode: before.mode, uid: before.uid, gid: before.gid, dev: Number(before.dev), ino: Number(before.ino) });
  };
  walk(root);
  rows.sort((left, right) => compare(left.relative, right.relative));
  const summary = deepFreeze({
    scope: "whole_abrain_no_carve_out_opaque_inventory",
    entry_count: rows.length,
    directory_count: rows.filter((row) => row.kind === "directory").length,
    file_count: rows.filter((row) => row.kind === "file").length,
    symlink_count: rows.filter((row) => row.kind === "symlink").length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    inventory_hash: sha256(canonical(rows)),
  });
  return { rows, summary };
}

function diffRows(before, after) {
  const left = new Map(before.map((row) => [row.relative, row]));
  const right = new Map(after.map((row) => [row.relative, row]));
  return deepFreeze({
    created: after.filter((row) => !left.has(row.relative)).map((row) => row.relative),
    modified: after.filter((row) => left.has(row.relative) && canonical(left.get(row.relative)) !== canonical(row)).map((row) => row.relative),
    removed: before.filter((row) => !right.has(row.relative)).map((row) => row.relative),
  });
}

function captureTargetInventory(publicationParent, targetRelativeFromParent) {
  const rows = [];
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const value = fs.readlinkSync(file);
      rows.push({ relative_name: relative, kind: "symlink", bytes: 0, sha256: sha256(value), symlink_value: value, mode, uid: stat.uid, gid: stat.gid, children: null });
      return;
    }
    if (stat.isDirectory()) {
      const children = fs.readdirSync(file).sort(compare);
      rows.push({ relative_name: relative, kind: "directory", bytes: 0, sha256: sha256(canonical({ kind: "directory", children })), symlink_value: null, mode, uid: stat.uid, gid: stat.gid, children });
      for (const child of children) walk(path.join(file, child), `${relative}/${child}`);
      return;
    }
    if (!stat.isFile()) fail("TARGET_INVENTORY_UNSUPPORTED", "target inventory encountered unsupported entry", { relative });
    const raw = fs.readFileSync(file);
    rows.push({ relative_name: relative, kind: "file", bytes: raw.length, sha256: sha256(raw), symlink_value: null, mode, uid: stat.uid, gid: stat.gid, children: null });
  };
  walk(publicationParent, targetRelativeFromParent);
  rows.sort((left, right) => compare(left.relative_name, right.relative_name));
  return deepFreeze({ rows, inventory_hash: sha256(canonical(rows)) });
}

function findTrustedSession() {
  const sessionsRoot = "/home/worker/.pi/agent/sessions";
  const matches = [];
  const walk = (directory) => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("SESSION_TREE_UNSAFE", "session tree contains an unsafe directory", { directory });
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const file = path.join(directory, name);
      const child = fs.lstatSync(file);
      if (child.isSymbolicLink()) fail("SESSION_TREE_UNSAFE", "session tree contains a symlink", { file });
      if (child.isDirectory()) walk(file);
      else if (child.isFile() && name.endsWith(`_${SESSION_ID}.jsonl`)) matches.push(file);
    }
  };
  walk(sessionsRoot);
  if (matches.length !== 1) fail("TRUSTED_SESSION_NOT_UNIQUE", "trusted main session was not found uniquely", { matches });
  return matches[0];
}

function validateAuthorizationTranscript() {
  const file = findTrustedSession();
  const opened = openRegularVerified(file, "trusted main transcript");
  const raw = opened.raw.toString("utf8");
  const lines = raw.trimEnd().split("\n");
  const events = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { fail("TRANSCRIPT_JSON_INVALID", "trusted transcript contains invalid JSON", { line: index + 1 }); }
  });
  const messages = events.filter((event) => event.type === "message" && event.message?.role);
  const latestUser = [...messages].reverse().find((event) => event.message.role === "user");
  if (!latestUser) fail("AUTHORIZATION_NOT_FOUND", "trusted transcript has no user message");
  const textParts = latestUser.message.content.filter((part) => part.type === "text").map((part) => part.text);
  if (textParts.length !== 1) fail("AUTHORIZATION_TEXT_SHAPE_INVALID", "latest user message is not one text part");
  const textHash = sha256(textParts[0]);
  if (textHash !== AUTHORIZATION_TEXT_SHA256 || Buffer.byteLength(textParts[0]) !== 1384) fail("AUTHORIZATION_HASH_MISMATCH", "latest user authorization bytes differ", { textHash });
  const ids = new Map(events.filter((event) => typeof event.id === "string").map((event) => [event.id, event]));
  let cursor = latestUser;
  const seen = new Set();
  while (cursor.parentId) {
    if (seen.has(cursor.id)) fail("TRANSCRIPT_PARENT_CYCLE", "trusted transcript parent chain cycles");
    seen.add(cursor.id);
    const parent = ids.get(cursor.parentId);
    if (!parent) fail("TRANSCRIPT_PARENT_MISSING", "trusted transcript parent chain is discontinuous", { parentId: cursor.parentId });
    cursor = parent;
  }
  const lineIndex = events.indexOf(latestUser);
  const prefix = Buffer.from(`${lines.slice(0, lineIndex + 1).join("\n")}\n`);
  opened.after_sandbox = recheckRegular(opened, "authorization_validation");
  fs.closeSync(opened.fd);
  return deepFreeze({
    kind: "exact_role_user_transcript_authorization",
    role: "user",
    session_id: SESSION_ID,
    message_id: latestUser.id,
    parent_id: latestUser.parentId,
    timestamp: latestUser.timestamp,
    line_number: lineIndex + 1,
    text_bytes: Buffer.byteLength(textParts[0]),
    text_sha256: textHash,
    latest_role_user_message_verified: true,
    continuous_parent_chain_verified: true,
    transcript_prefix_bytes: prefix.length,
    transcript_prefix_sha256: sha256(prefix),
  });
}

function captureRuntimeAndSourceClosure() {
  const packageRaw = fs.readFileSync(path.join(repoRoot, "package.json"));
  const pkg = JSON.parse(packageRaw);
  const roots = pkg.pi?.extensions;
  if (!Array.isArray(roots) || roots.some((value) => typeof value !== "string" || !value) || new Set(roots).size !== roots.length) fail("PACKAGE_EXTENSION_ROOTS_INVALID", "package pi.extensions is not a unique string array");
  const runtimeGraph = graphTools.buildTypescriptStaticDependencyGraph({ repoRoot, roots });
  graphTools.validateTypescriptStaticDependencyGraph(runtimeGraph);
  const forbiddenReachable = [COMPILER_RELATIVE, HELPER_RELATIVE, SMOKE_RELATIVE, RUNNER_RELATIVE, PROFILE_RELATIVE, OUTPUT_RELATIVE].filter((relative) => runtimeGraph.files.some((row) => row.path === relative));
  if (runtimeGraph.unresolved_dynamic_loaders.length || forbiddenReachable.length) fail("RUNTIME_REACHABILITY_VIOLATION", "new stable-view surface is reachable from runtime roots", { forbiddenReachable });
  const compilerGraph = graphTools.buildTypescriptStaticDependencyGraph({ repoRoot, roots: [COMPILER_RELATIVE] });
  const previewGraph = graphTools.buildTypescriptStaticDependencyGraph({ repoRoot, roots: [HELPER_RELATIVE] });
  graphTools.validateTypescriptStaticDependencyGraph(compilerGraph, { requiredPaths: [COMPILER_RELATIVE] });
  graphTools.validateTypescriptStaticDependencyGraph(previewGraph, { requiredPaths: [COMPILER_RELATIVE, HELPER_RELATIVE] });
  const isolatedGraphPaths = [...new Set([...compilerGraph.files, ...previewGraph.files].map((row) => row.path))].sort(compare);
  const disallowedGraphPaths = isolatedGraphPaths.filter((relative) => relative.includes("constraint-shadow") || relative.includes("compiled-view") || relative.includes("0039"));
  const isolatedSourceBytes = [COMPILER_RELATIVE, HELPER_RELATIVE].map((relative) => fs.readFileSync(path.join(repoRoot, ...relative.split("/")), "utf8"));
  const disallowedSourceTokens = ["constraint-shadow", "compiled-view", "adr0039", "0039"].filter((token) => isolatedSourceBytes.some((raw) => raw.toLowerCase().includes(token)));
  if (disallowedGraphPaths.length || disallowedSourceTokens.length) fail("SOURCE_ISOLATION_VIOLATION", "compiler or preview source reaches a disallowed content family", { disallowedGraphPaths, disallowedSourceTokens });
  const sourceRows = [...SOURCE_ARTIFACTS, PLAN_RELATIVE].sort(compare).map((relative) => {
    const raw = fs.readFileSync(path.join(repoRoot, ...relative.split("/")));
    return deepFreeze({ relative_path: relative, bytes: raw.length, raw_sha256: sha256(raw) });
  });
  const closureBase = {
    schema_version: "proposition-policy-stable-view-source-closure/v1",
    source_rows: sourceRows,
    compiler_dependency_graph: compilerGraph,
    preview_dependency_graph: previewGraph,
  };
  const closure = deepFreeze({ ...closureBase, closure_hash: sha256(canonical(closureBase)) });
  return deepFreeze({
    runtime: {
      dependency_graph: runtimeGraph,
      package_json_bytes: packageRaw.length,
      package_json_sha256: sha256(packageRaw),
      package_extension_root_count: roots.length,
      package_extension_roots_hash: sha256(canonical(roots)),
      forbidden_paths: [COMPILER_RELATIVE, HELPER_RELATIVE, SMOKE_RELATIVE, RUNNER_RELATIVE, PROFILE_RELATIVE, OUTPUT_RELATIVE],
      forbidden_reachable_paths: forbiddenReachable,
      unresolved_dynamic_loaders: runtimeGraph.unresolved_dynamic_loaders,
      unreachable: true,
    },
    source_closure: closure,
    isolation: {
      compiler_preview_graph_paths: isolatedGraphPaths,
      disallowed_graph_paths: disallowedGraphPaths,
      disallowed_source_tokens: disallowedSourceTokens,
      semantic_content_opened_by_compiler_or_preview: false,
      generic_whole_abrain_snapshot_is_opaque_hash_only: true,
    },
  });
}

function captureHostNamespaces() {
  const output = {};
  for (const name of ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"]) output[name] = fs.readlinkSync(`/proc/self/ns/${name}`);
  return deepFreeze(output);
}

function runBwrap(handles, directories, tempRoot, sourceBundleHash) {
  const requestedAt = new Date().toISOString();
  const fdOrder = [
    handles.bwrap.fd,
    handles.node.fd,
    handles.helper.fd,
    handles.compiler.fd,
    handles.profile.fd,
    handles.entries.fd,
    handles.exclusions.fd,
    handles.diagnostics.fd,
    handles.manifest.fd,
    directories.repo.fd,
    directories.abrain.fd,
    directories.work.fd,
  ];
  const args = [
    "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--setenv", "HOME", "/nonexistent", "--setenv", "PATH", "/run/pi-astack:/usr/bin", "--setenv", "TMPDIR", "/run/pi-astack/work/tmp",
    "--ro-bind", "/", "/",
    "--tmpfs", "/home", "--remount-ro", "/home",
    "--tmpfs", "/tmp", "--remount-ro", "/tmp",
    "--tmpfs", "/run", "--dir", "/run/pi-astack", "--dir", "/run/pi-astack/input",
    "--ro-bind-fd", "3", "/run/pi-astack/bwrap",
    "--ro-bind-fd", "4", "/run/pi-astack/node",
    "--ro-bind-fd", "5", "/run/pi-astack/proposition-policy-stable-view-preview.ts",
    "--ro-bind-fd", "6", "/run/pi-astack/proposition-policy-stable-view.ts",
    "--ro-bind-fd", "7", "/run/pi-astack/input/profile.json",
    "--ro-bind-fd", "8", "/run/pi-astack/input/entries.json",
    "--ro-bind-fd", "9", "/run/pi-astack/input/exclusions.json",
    "--ro-bind-fd", "10", "/run/pi-astack/input/diagnostics.json",
    "--ro-bind-fd", "11", "/run/pi-astack/input/source-manifest.json",
    "--ro-bind-fd", "12", "/run/pi-astack/repo",
    "--ro-bind-fd", "13", "/run/pi-astack/abrain",
    "--bind-fd", "14", "/run/pi-astack/work",
    "--remount-ro", "/run", "--chdir", "/run/pi-astack/work", "--unsetenv", "PWD",
    "--", "/run/pi-astack/node", "--no-warnings", "--experimental-strip-types", "/run/pi-astack/proposition-policy-stable-view-preview.ts",
    "--confined-stable-view-helper",
    "--expected-source-bundle-hash", sourceBundleHash,
    "--requested-at-utc", requestedAt,
  ];
  const child = spawnSync("/proc/self/fd/3", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe", ...fdOrder],
  });
  if (child.error || child.status !== 0 || child.signal !== null) fail("BWRAP_PREVIEW_FAILED", "confined preview did not exit successfully", { error: child.error?.message, status: child.status, signal: child.signal, stderr: child.stderr, stdout: child.stdout });
  if (child.stderr !== "") fail("BWRAP_PREVIEW_STDERR", "confined preview emitted stderr", { stderr: child.stderr });
  let result;
  try { result = JSON.parse(child.stdout); } catch { fail("BWRAP_PREVIEW_OUTPUT_INVALID", "confined preview output is not one JSON document", { stdout: child.stdout }); }
  const tempInventory = captureTempInventory(tempRoot);
  if (result.execution_ordering?.requested_at_utc !== requestedAt || result.receipts?.request_id === undefined) fail("BWRAP_CORRELATION_INVALID", "confined preview omitted request correlation or ordering evidence");
  return deepFreeze({
    result,
    tempInventory,
    request_id: result.receipts.request_id,
    requested_at_utc: requestedAt,
    completed_at_utc: result.execution_ordering.completed_at_utc,
    observed_at_utc: result.execution_ordering.observed_at_utc,
  });
}

function captureTempInventory(root) {
  const rows = [];
  const walk = (file) => {
    const stat = fs.lstatSync(file);
    const relative = path.relative(root, file).split(path.sep).join("/") || ".";
    if (stat.isSymbolicLink()) fail("TEMP_SYMLINK", "private temp contains a symlink", { relative });
    if (stat.isDirectory()) {
      const children = fs.readdirSync(file).sort(compare);
      rows.push({ relative, kind: "directory", children });
      for (const child of children) walk(path.join(file, child));
      return;
    }
    if (!stat.isFile()) fail("TEMP_UNSUPPORTED", "private temp contains unsupported entry", { relative });
    const raw = fs.readFileSync(file);
    rows.push({ relative, kind: "file", bytes: raw.length, sha256: sha256(raw) });
  };
  walk(root);
  rows.sort((left, right) => compare(left.relative, right.relative));
  return deepFreeze({ rows, inventory_hash: sha256(canonical(rows)) });
}

function closeAll(handles) {
  for (const handle of handles) {
    if (handle && Number.isInteger(handle.fd)) {
      try { fs.closeSync(handle.fd); } catch { /* already closed */ }
    }
  }
}

function validateRetainedReceiptDocuments(receipts) {
  const documents = receipts.documents;
  if (!documents || typeof documents !== "object") fail("RECEIPT_DOCUMENTS_MISSING", "confined preview omitted canonical receipt documents");
  for (const key of ["request_receipt", "outcome_receipt"]) {
    const binding = documents[key];
    if (!binding || binding.self_hash_field !== "receipt_hash" || !binding.preimage || !binding.raw) fail("RECEIPT_BINDING_INVALID", "self-hashed receipt binding is incomplete", { key });
    const fullObject = binding.raw.canonical_object;
    const preimageObject = { ...fullObject };
    const selfHash = preimageObject.receipt_hash;
    delete preimageObject.receipt_hash;
    const preimageRaw = canonical(preimageObject);
    const fullRaw = `${canonical(fullObject)}\n`;
    if (canonical(preimageObject) !== canonical(binding.preimage.canonical_object)
      || binding.self_hash !== selfHash || sha256(preimageRaw) !== selfHash
      || binding.preimage.canonical_utf8_bytes !== Buffer.byteLength(preimageRaw) || binding.preimage.raw_sha256 !== sha256(preimageRaw)
      || binding.raw.canonical_utf8_bytes !== Buffer.byteLength(fullRaw) || binding.raw.raw_sha256 !== sha256(fullRaw)) {
      fail("RECEIPT_BINDING_INVALID", "retained receipt preimage/raw/self binding is not independently reproducible", { key });
    }
    const row = receipts.rows.find((candidate) => candidate.name === binding.name);
    if (!row || row.bytes !== Buffer.byteLength(fullRaw) || row.sha256 !== sha256(fullRaw)) fail("RECEIPT_ROW_BINDING_INVALID", "receipt row differs from retained canonical object", { key });
  }
  const observation = documents.observation;
  const observationRaw = `${canonical(observation.canonical_object)}\n`;
  if (observation.canonical_utf8_bytes !== Buffer.byteLength(observationRaw) || observation.raw_sha256 !== sha256(observationRaw)) fail("OBSERVATION_BINDING_INVALID", "retained observation canonical object differs from raw binding");
  const observationRow = receipts.rows.find((candidate) => candidate.name === observation.name);
  if (!observationRow || observationRow.bytes !== Buffer.byteLength(observationRaw) || observationRow.sha256 !== sha256(observationRaw)) fail("OBSERVATION_ROW_BINDING_INVALID", "observation row differs from retained canonical object");
  const requestObject = documents.request_receipt.raw.canonical_object;
  const outcomeObject = documents.outcome_receipt.raw.canonical_object;
  const observationObject = observation.canonical_object;
  if (receipts.request_receipt_hash !== requestObject.receipt_hash || receipts.outcome_receipt_hash !== outcomeObject.receipt_hash
    || requestObject.request_id !== outcomeObject.request_id || requestObject.request_id !== observationObject.request_id
    || observationObject.request_receipt_hash !== requestObject.receipt_hash || observationObject.outcome_receipt_hash !== outcomeObject.receipt_hash) {
    fail("RECEIPT_CORRELATION_INVALID", "retained request, outcome, and observation correlation differs");
  }
  return true;
}

function assertRecursiveHashFields(value, at = "dossier") {
  const hashPattern = /^[0-9a-f]{64}$/;
  const walk = (current, currentAt) => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => walk(child, `${currentAt}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const childAt = `${currentAt}.${key}`;
      if (key === "hash_algorithm") {
        if (child !== "sha256") fail("HASH_ALGORITHM_INVALID", "hash algorithm marker differs", { childAt, child });
      } else if (key.endsWith("_hash_scope")) {
        if (typeof child !== "string" || !child.length) fail("HASH_SCOPE_INVALID", "hash scope marker is empty", { childAt });
      } else if (key === "effective_capabilities_hex") {
        if (typeof child !== "string" || !/^[0-9a-f]{16}$/.test(child)) fail("CAPABILITY_MARKER_INVALID", "capability marker is not exact lowercase hex", { childAt });
      } else if (key === "sha256" || key.endsWith("_sha256") || key.endsWith("_hash")) {
        if (typeof child !== "string" || !hashPattern.test(child)) fail("HASH_FIELD_INVALID", "hash field is not exact 64 lowercase hex", { childAt, child });
      }
      walk(child, childAt);
    }
  };
  walk(value, at);
  return true;
}

function validateP2bBlocked() {
  const machine = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/transition-register.machine.json"), "utf8"));
  const records = [];
  const walk = (value) => {
    if (Array.isArray(value)) for (const child of value) walk(child);
    else if (value && typeof value === "object") {
      if (value.id === "proposition.adr0040-p2b-policy-push-stable-view") records.push(value);
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(machine);
  if (records.length !== 1 || records[0].phase_status !== "blocked" || records[0].authorization_status !== "separate_authorization_required") fail("P2B_STATUS_DRIFT", "P2b overall transition status is not blocked/separate authorization");
  return deepFreeze({ id: records[0].id, phase_status: records[0].phase_status, authorization_status: records[0].authorization_status });
}

async function main() {
  if (process.argv.length !== 2) fail("UNSUPPORTED_ARGUMENT", "P2b.1 dossier runner accepts no arguments");
  const outputPath = path.join(repoRoot, ...OUTPUT_RELATIVE.split("/"));
  if (fs.existsSync(outputPath)) assertRegularPath(outputPath, OUTPUT_RELATIVE);
  for (const relative of CREATED_PATHS.filter((value) => value !== OUTPUT_RELATIVE)) assertRegularPath(path.join(repoRoot, ...relative.split("/")), relative);
  const planBinding = readCanonicalBound(PLAN_RELATIVE, PLAN_RAW_SHA256, "plan_hash", PLAN_HASH);
  const plan = planBinding.parsed;
  const intendedCreatePaths = Object.values(plan.intended_paths_to_create).filter(Array.isArray).flat().sort(compare);
  if (canonical(intendedCreatePaths) !== canonical(CREATED_PATHS)) fail("INTENDED_CREATE_SET_DRIFT", "plan intended path set differs from exact six");
  const authorization = validateAuthorizationTranscript();
  const p2aPlanBinding = readCanonicalBound(P2A_PLAN_RELATIVE, P2A_PLAN_RAW, "plan_hash", P2A_PLAN_HASH);
  const p2aPostBinding = readCanonicalBound(P2A_POST_RELATIVE, P2A_POST_RAW, "dossier_hash", P2A_POST_HASH);
  const p2bStatus = validateP2bBlocked();
  const sourceAnchorsBefore = SOURCE_ANCHORS.map((row) => {
    const raw = fs.readFileSync(path.join(repoRoot, ...row.relative_path.split("/")));
    if (sha256(raw) !== row.raw_sha256) fail("P2A_SOURCE_ANCHOR_DRIFT", "P2a source anchor differs", { relative: row.relative_path });
    return deepFreeze({ ...row, bytes: raw.length });
  });
  const profileParsed = JSON.parse(fs.readFileSync(path.join(repoRoot, ...PROFILE_RELATIVE.split("/")), "utf8"));
  const profileBase = { ...profileParsed };
  delete profileBase.profile_hash;
  if (profileParsed.profile_hash !== PROFILE_HASH || sha256(canonical(profileBase)) !== PROFILE_HASH) fail("PROFILE_HASH_INVALID", "compile profile self-hash differs");
  const runtimeAndSource = captureRuntimeAndSourceClosure();

  const targetRoot = plan.bound_current_state.p2a_bundle.target_root;
  const targetMarker = `${path.sep}.state${path.sep}`;
  const markerIndex = targetRoot.indexOf(targetMarker);
  if (markerIndex <= 0) fail("P2A_TARGET_BINDING_INVALID", "bound P2a target does not identify an abrain root");
  const abrainHome = targetRoot.slice(0, markerIndex);
  if (abrainHome !== path.resolve(abrainHome)) fail("ABRAIN_HOME_INVALID", "derived abrain home is not absolute normalized");
  assertDirectoryPath(abrainHome, "derived abrain home");
  const publicationParent = path.dirname(targetRoot);
  const targetRelativeFromParent = path.relative(abrainHome, publicationParent).split(path.sep).join("/");
  const expectedTargetInventory = p2aPlanBinding.parsed.exact_final_inventory;
  if (sha256(canonical(expectedTargetInventory)) !== TARGET_INVENTORY_HASH) fail("P2A_PLAN_TARGET_INVENTORY_INVALID", "P2a plan exact inventory hash differs");
  const targetBefore = captureTargetInventory(publicationParent, targetRelativeFromParent);
  if (targetBefore.inventory_hash !== TARGET_INVENTORY_HASH || canonical(targetBefore.rows) !== canonical(expectedTargetInventory)) fail("P2A_LIVE_TARGET_INVENTORY_DRIFT", "live P2a target inventory differs before preview", { actual: targetBefore.inventory_hash });

  const bundleDirectory = path.join(targetRoot, "bundles", BUNDLE_HASH);
  const latestPath = path.join(targetRoot, "latest");
  const handles = {};
  const directories = {};
  let tempRoot = null;
  const allHandles = [];
  let preview;
  let wholeBefore;
  let wholeAfter;
  try {
    handles.bwrap = openRegularVerified("/usr/bin/bwrap", "bubblewrap", p2aPostBinding.parsed.evidence.confinement.after_static_anchors.bubblewrap.sha256);
    handles.node = openRegularVerified(process.execPath, "node runtime", p2aPostBinding.parsed.evidence.confinement.after_static_anchors.runtime_executable.sha256);
    handles.helper = openRegularVerified(path.join(repoRoot, ...HELPER_RELATIVE.split("/")), "preview helper");
    handles.compiler = openRegularVerified(path.join(repoRoot, ...COMPILER_RELATIVE.split("/")), "stable compiler");
    handles.profile = openRegularVerified(path.join(repoRoot, ...PROFILE_RELATIVE.split("/")), "compile profile");
    handles.entries = openRegularVerified(path.join(bundleDirectory, "entries.json"), "P2a entries", BUNDLE_ARTIFACTS.find((row) => row.name === "entries.json").sha256);
    handles.exclusions = openRegularVerified(path.join(bundleDirectory, "exclusions.json"), "P2a exclusions", BUNDLE_ARTIFACTS.find((row) => row.name === "exclusions.json").sha256);
    handles.diagnostics = openRegularVerified(path.join(bundleDirectory, "diagnostics.json"), "P2a diagnostics", BUNDLE_ARTIFACTS.find((row) => row.name === "diagnostics.json").sha256);
    handles.manifest = openRegularVerified(path.join(bundleDirectory, "manifest.json"), "P2a manifest", BUNDLE_ARTIFACTS.find((row) => row.name === "manifest.json").sha256);
    handles.latest = openSymlinkVerified(latestPath, "P2a latest", `bundles/${BUNDLE_HASH}`);
    allHandles.push(...Object.values(handles));
    const manifestParsed = JSON.parse(handles.manifest.raw);
    if (manifestParsed.bundle_hash !== BUNDLE_HASH || manifestParsed.result.entry_count !== 0 || manifestParsed.result.exclusion_count !== 1 || manifestParsed.result.diagnostic_count !== 1) fail("P2A_MANIFEST_CONTENT_DRIFT", "opened P2a manifest is not bound 0/1/1 source");
    for (const row of BUNDLE_ARTIFACTS) {
      const handle = handles[row.name.replace(".json", "")];
      if (!handle || handle.raw.length !== row.bytes || handle.raw_sha256 !== row.sha256) fail("P2A_ARTIFACT_ROW_DRIFT", "opened P2a artifact row differs", { name: row.name });
    }
    directories.repo = openDirectoryVerified(repoRoot, "repository root");
    directories.abrain = openDirectoryVerified(abrainHome, "abrain root");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p2b1-preview-"));
    fs.chmodSync(tempRoot, 0o700);
    fs.mkdirSync(path.join(tempRoot, "output"), { mode: 0o700 });
    fs.mkdirSync(path.join(tempRoot, "tmp"), { mode: 0o700 });
    directories.work = openDirectoryVerified(tempRoot, "private temp root");
    allHandles.push(...Object.values(directories));
    const hostNamespaces = captureHostNamespaces();
    wholeBefore = genericWholeSnapshot(abrainHome);
    preview = runBwrap(handles, directories, tempRoot, BUNDLE_HASH);
    wholeAfter = genericWholeSnapshot(abrainHome);
    const wholeDiff = diffRows(wholeBefore.rows, wholeAfter.rows);
    if (wholeBefore.summary.inventory_hash !== wholeAfter.summary.inventory_hash || wholeDiff.created.length || wholeDiff.modified.length || wholeDiff.removed.length) fail("ABRAIN_CHANGED", "whole abrain changed during real read-only preview", { before: wholeBefore.summary, after: wholeAfter.summary, wholeDiff });
    for (const handle of Object.values(handles)) handle.after_sandbox = handle.value !== undefined ? recheckSymlink(handle, "after_sandbox") : recheckRegular(handle, "after_sandbox");
    for (const handle of Object.values(directories)) handle.after_sandbox = recheckDirectory(handle);
    const sandboxNamespaces = preview.result.confinement.namespace_identities;
    const namespaceSeparation = Object.fromEntries(Object.keys(hostNamespaces).map((name) => [name, hostNamespaces[name] !== sandboxNamespaces[name]]));
    if (Object.values(namespaceSeparation).some((value) => value !== true)) fail("NAMESPACE_NOT_SEPARATE", "a requested namespace was not separated", { hostNamespaces, sandboxNamespaces, namespaceSeparation });
    if (preview.result.confinement.effective_capabilities_hex !== "0000000000000000"
      || preview.result.confinement.network.denied !== true
      || preview.result.confinement.read_only.repository.denied !== true
      || preview.result.confinement.read_only.abrain.denied !== true
      || preview.result.confinement.credential_shaped_environment_keys.length !== 0) fail("CONFINEMENT_INEFFECTIVE", "sandbox confinement proof is incomplete", { confinement: preview.result.confinement });
    if (preview.result.compile.result_kind !== "ready_empty"
      || preview.result.compile.item_count !== 0
      || preview.result.compile.injectable_payload_utf8_bytes !== 0
      || preview.result.compile.all_five_or_none !== true
      || preview.result.compile.non_view_closed_vocabulary_valid !== true
      || preview.result.compile.profile_hash !== PROFILE_HASH
      || preview.result.source.candidate_entries !== 0
      || preview.result.source.exclusions !== 1
      || preview.result.source.diagnostics !== 1) fail("REAL_PREVIEW_RESULT_INVALID", "confined preview result differs from exact ready_empty 0/1/1 contract", { result: preview.result });
    if (canonical(preview.result.compile.artifact_rows.map((row) => row.name).sort(compare)) !== canonical(STABLE_NAMES)) fail("STABLE_ARTIFACT_INVENTORY_INVALID", "confined preview did not emit exact all-five names");
    const canonicalRequest = {
      source_bundle_hash: BUNDLE_HASH,
      source: {
        entries: JSON.parse(handles.entries.raw),
        exclusions: JSON.parse(handles.exclusions.raw),
        diagnostics: JSON.parse(handles.diagnostics.raw),
        manifest: JSON.parse(handles.manifest.raw),
      },
      compile_profile: profileParsed,
      mode: "real",
    };
    const expectedRequestId = sha256(canonical(canonicalRequest));
    if (preview.request_id !== expectedRequestId || preview.result.receipts.request_id !== expectedRequestId) fail("REQUEST_CORRELATION_INVALID", "request ID is not the SHA-256 of exact canonical raw request bytes");
    if (validateRetainedReceiptDocuments(preview.result.receipts) !== true) fail("RECEIPT_DOCUMENTS_INVALID", "retained receipt documents failed independent validation");
    const requestReceiptObject = preview.result.receipts.documents.request_receipt.raw.canonical_object;
    if (requestReceiptObject.request_raw_sha256 !== expectedRequestId || requestReceiptObject.request_id !== expectedRequestId
      || requestReceiptObject.request_raw_utf8_bytes !== Buffer.byteLength(canonical(canonicalRequest))) fail("REQUEST_RECEIPT_RAW_BINDING_INVALID", "request receipt does not bind the exact canonical request bytes");
    const expectedStageSequence = ["request_received", "source_validated", "compile_completed", "artifacts_validated", "confinement_probes_completed", "stable_artifacts_materialized", "completed_at_set", "observed_at_set", "receipts_materialized"];
    const ordering = preview.result.execution_ordering;
    if (canonical(ordering.stage_sequence) !== canonical(expectedStageSequence) || ordering.completed_at_set_after_execution !== true
      || ordering.completed_at_set_after_artifact_validation !== true || ordering.completed_at_set_after_confinement_probes !== true
      || ordering.timestamp_order_valid !== true || Date.parse(ordering.requested_at_utc) > Date.parse(ordering.execution_started_at_utc)
      || Date.parse(ordering.execution_started_at_utc) > Date.parse(ordering.completed_at_utc)
      || Date.parse(ordering.completed_at_utc) > Date.parse(ordering.observed_at_utc)) fail("EXECUTION_ORDERING_INVALID", "completedAt was not proven after execution and before observation");
    assertRecursiveHashFields(preview.result, "confined_preview_result");

    const targetAfter = captureTargetInventory(publicationParent, targetRelativeFromParent);
    if (targetAfter.inventory_hash !== TARGET_INVENTORY_HASH || canonical(targetAfter.rows) !== canonical(expectedTargetInventory) || canonical(targetAfter) !== canonical(targetBefore)) fail("P2A_TARGET_CHANGED", "P2a target inventory changed during preview", { before: targetBefore.inventory_hash, after: targetAfter.inventory_hash });
    const sourceAnchorsAfter = SOURCE_ANCHORS.map((row) => ({ ...row, bytes: fs.statSync(path.join(repoRoot, ...row.relative_path.split("/"))).size, actual_sha256: sha256(fs.readFileSync(path.join(repoRoot, ...row.relative_path.split("/")))) }));
    if (sourceAnchorsAfter.some((row) => row.actual_sha256 !== row.raw_sha256)) fail("P2A_SOURCE_ANCHOR_CHANGED", "P2a source anchor changed during preview");
    const postAfter = readCanonicalBound(P2A_POST_RELATIVE, P2A_POST_RAW, "dossier_hash", P2A_POST_HASH);
    const p2aPlanAfter = readCanonicalBound(P2A_PLAN_RELATIVE, P2A_PLAN_RAW, "plan_hash", P2A_PLAN_HASH);
    if (sha256(postAfter.raw) !== P2A_POST_RAW || sha256(p2aPlanAfter.raw) !== P2A_PLAN_RAW) fail("P2A_EVIDENCE_CHANGED", "P2a bound evidence changed during preview");

    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (fs.existsSync(tempRoot)) fail("TEMP_CLEANUP_FAILED", "private temp directory remains before dossier creation", { tempRoot });
    const assertions = deepFreeze({
      authorization_exact_latest_role_user: authorization.text_sha256 === AUTHORIZATION_TEXT_SHA256,
      canonical_plan_raw_and_self_hash_valid: sha256(planBinding.raw) === PLAN_RAW_SHA256 && plan.plan_hash === PLAN_HASH,
      exact_six_path_scope: canonical(CREATED_PATHS) === canonical(intendedCreatePaths),
      compile_profile_self_hash_valid: profileParsed.profile_hash === PROFILE_HASH,
      profile_bound_real_source_identity_valid: profileParsed.source_identity.real.source_bundle_hash === BUNDLE_HASH && profileParsed.source_identity.real.source_identity_hash === "6a78b410b8f3858dc9947f52bc56e5b8ee11a632c5df7f79ac5697996cdcbcbd",
      real_source_exact_zero_one_one: preview.result.source.candidate_entries === 0 && preview.result.source.exclusions === 1 && preview.result.source.diagnostics === 1,
      real_result_ready_empty: preview.result.compile.result_kind === "ready_empty" && preview.result.compile.item_count === 0 && preview.result.compile.injectable_payload_utf8_bytes === 0,
      all_five_or_none: preview.result.compile.all_five_or_none === true && preview.result.compile.artifact_rows.length === 5,
      recursive_non_view_closed_vocabulary_valid: preview.result.compile.non_view_closed_vocabulary_valid === true,
      exact_completed_tuple: canonical(preview.result.receipts.pipeline_tuple) === canonical({ pipeline: "completed", freshness: "fresh", selection: "current", health: "ok" }),
      canonical_request_correlation_exact: preview.result.receipts.request_id === expectedRequestId,
      receipt_preimages_and_raw_objects_retained: validateRetainedReceiptDocuments(preview.result.receipts) === true,
      completed_at_set_only_after_execution: ordering.completed_at_set_after_execution === true && ordering.completed_at_set_after_artifact_validation === true && ordering.completed_at_set_after_confinement_probes === true,
      receipt_timestamp_order_exact: ordering.timestamp_order_valid === true,
      recursive_digest_fields_exact_lowercase_hex: assertRecursiveHashFields(preview.result, "confined_preview_result") === true,
      injection_authority_false: preview.result.receipts.injection_authority === false,
      opened_fd_identity_before_after_equal: Object.values(handles).every((handle) => sameIdentity(handle.before, handle.after_read) && sameIdentity(handle.before, handle.after_sandbox)),
      latest_identity_and_value_unchanged: sameIdentity(handles.latest.before, handles.latest.after_sandbox) && handles.latest.value === `bundles/${BUNDLE_HASH}`,
      bubblewrap_executed_from_verified_fd: handles.bwrap.raw_sha256 === p2aPostBinding.parsed.evidence.confinement.after_static_anchors.bubblewrap.sha256,
      node_and_helpers_bound_from_verified_fds: Boolean(handles.node.after_sandbox && handles.helper.after_sandbox && handles.compiler.after_sandbox),
      all_requested_namespaces_separate: Object.values(namespaceSeparation).every(Boolean),
      zero_effective_capabilities: preview.result.confinement.effective_capabilities_hex === "0000000000000000",
      network_denied: preview.result.confinement.network.denied === true,
      credentials_denied: preview.result.confinement.credential_shaped_environment_keys.length === 0,
      repo_and_abrain_read_only: preview.result.confinement.read_only.repository.denied === true && preview.result.confinement.read_only.abrain.denied === true,
      private_temp_only_writable_bind: preview.result.confinement.writable_surface === "/run/pi-astack/work",
      whole_abrain_exact_equality_no_exceptions: wholeBefore.summary.inventory_hash === wholeAfter.summary.inventory_hash && wholeDiff.created.length === 0 && wholeDiff.modified.length === 0 && wholeDiff.removed.length === 0,
      p2a_target_inventory_unchanged: targetBefore.inventory_hash === TARGET_INVENTORY_HASH && targetAfter.inventory_hash === TARGET_INVENTORY_HASH,
      p2a_source_and_plan_anchors_unchanged: sourceAnchorsAfter.every((row) => row.actual_sha256 === row.raw_sha256),
      runtime_ast_unreachable: runtimeAndSource.runtime.unreachable === true,
      runtime_dynamic_loaders_resolved: runtimeAndSource.runtime.unresolved_dynamic_loaders.length === 0,
      isolated_source_graph_has_no_disallowed_content_path: runtimeAndSource.isolation.disallowed_graph_paths.length === 0,
      isolated_source_bytes_have_no_disallowed_token: runtimeAndSource.isolation.disallowed_source_tokens.length === 0,
      no_stable_view_production_destination: !fs.readFileSync(path.join(repoRoot, ...COMPILER_RELATIVE.split("/")), "utf8").includes("/home/") && !fs.readFileSync(path.join(repoRoot, ...HELPER_RELATIVE.split("/")), "utf8").includes(".state/"),
      p2b_overall_remains_blocked: p2bStatus.phase_status === "blocked" && p2bStatus.authorization_status === "separate_authorization_required",
      no_restart_required: true,
    });
    if (Object.values(assertions).some((value) => value !== true)) fail("DOSSIER_ASSERTION_FAILED", "one or more final assertions failed", { assertions });

    const dossierBase = deepFreeze({
      schema_version: DOSSIER_SCHEMA,
      canonicalization: "RFC8785-JCS",
      hash_algorithm: "sha256",
      dossier_hash_scope: DOSSIER_HASH_SCOPE,
      phase: "ADR0040-P2b.1",
      mode: "real_production_read_only_empty_source_preview",
      authorization,
      plan: {
        relative_path: PLAN_RELATIVE,
        raw_sha256: PLAN_RAW_SHA256,
        plan_hash: PLAN_HASH,
        exact_create_paths: CREATED_PATHS,
      },
      compile_profile: {
        relative_path: PROFILE_RELATIVE,
        raw_sha256: handles.profile.raw_sha256,
        profile_hash: PROFILE_HASH,
        source_identity: profileParsed.source_identity,
        non_view_output_vocabulary: profileParsed.non_view_output_vocabulary,
        recursively_forbidden_keys_case_insensitive: profileParsed.recursively_forbidden_keys_case_insensitive,
      },
      p2a_binding: {
        bundle_hash: BUNDLE_HASH,
        authority: "shadow_push_only_no_runtime_consumer",
        source_counts: { candidate_entries: 0, exclusions: 1, diagnostics: 1 },
        artifact_rows: BUNDLE_ARTIFACTS,
        publication_plan: { relative_path: P2A_PLAN_RELATIVE, raw_sha256: P2A_PLAN_RAW, plan_hash: P2A_PLAN_HASH, source_inventory_hash: p2aPlanBinding.parsed.confinement.source_inventory.inventory_hash },
        corrected_post_dossier: { relative_path: P2A_POST_RELATIVE, raw_sha256: P2A_POST_RAW, dossier_hash: P2A_POST_HASH },
        source_anchors_before: sourceAnchorsBefore,
        source_anchors_after: sourceAnchorsAfter,
      },
      opened_input_identities: {
        handoff: "no_follow_opened_verified_descriptors_bound_to_fixed_sandbox_paths_without_named_input_reopen",
        latest_pointer: identityEvidence(handles.latest),
        source_artifacts: [handles.entries, handles.exclusions, handles.diagnostics, handles.manifest].map(identityEvidence),
        executable_and_helper_artifacts: [handles.bwrap, handles.node, handles.helper, handles.compiler, handles.profile].map(identityEvidence),
        directories: Object.values(directories).map((handle) => ({ label: handle.label, before: handle.before, after_sandbox: handle.after_sandbox })),
      },
      confinement: {
        executable: { path: "/usr/bin/bwrap", bytes: handles.bwrap.raw.length, sha256: handles.bwrap.raw_sha256, version: p2aPostBinding.parsed.evidence.confinement.after_static_anchors.bubblewrap.version },
        node: { bytes: handles.node.raw.length, sha256: handles.node.raw_sha256 },
        host_namespaces: hostNamespaces,
        sandbox_namespaces: sandboxNamespaces,
        namespace_separation: namespaceSeparation,
        effective_capabilities_hex: preview.result.confinement.effective_capabilities_hex,
        network: preview.result.confinement.network,
        environment_keys: preview.result.confinement.environment_keys,
        credential_shaped_environment_keys: preview.result.confinement.credential_shaped_environment_keys,
        read_only_probes: preview.result.confinement.read_only,
        writable_bind: "/run/pi-astack/work",
        fallback: "none_fail_closed",
      },
      preview: {
        compile: preview.result.compile,
        receipts: preview.result.receipts,
        execution_ordering: preview.result.execution_ordering,
        source: preview.result.source,
        output_inventory: preview.result.output_inventory,
      },
      temporary_surface: {
        exact_inventory_before_cleanup: preview.tempInventory,
        persistent_sandbox_artifacts: false,
        cleanup_verified_before_dossier_write: true,
      },
      mutation_proof: {
        scope: "whole_abrain_no_carve_out_opaque_inventory",
        allowed_exceptions: [],
        before: wholeBefore.summary,
        after: wholeAfter.summary,
        exact_diff: wholeDiff,
        equal: true,
      },
      p2a_target: {
        expected_inventory_hash: TARGET_INVENTORY_HASH,
        before_inventory_hash: targetBefore.inventory_hash,
        after_inventory_hash: targetAfter.inventory_hash,
        exact_plan_inventory_equal_before: canonical(targetBefore.rows) === canonical(expectedTargetInventory),
        exact_plan_inventory_equal_after: canonical(targetAfter.rows) === canonical(expectedTargetInventory),
        latest_value: handles.latest.value,
        latest_identity_before: handles.latest.before,
        latest_identity_after: handles.latest.after_sandbox,
      },
      source_closure: runtimeAndSource.source_closure,
      runtime_unreachability: runtimeAndSource.runtime,
      content_isolation: runtimeAndSource.isolation,
      phase_boundary: {
        stable_artifact_authority: "non_authoritative_repo_sandbox_only_no_runtime_consumer",
        stable_view_published: false,
        production_destination_defined: false,
        runtime_setting_changed: false,
        runtime_consumer_added: false,
        p2b_overall: p2bStatus,
        restart_required: false,
      },
      assertions,
    });
    const dossier = deepFreeze({ ...dossierBase, dossier_hash: sha256(canonical(dossierBase)) });
    assertRecursiveHashFields(dossier);
    const raw = `${canonical(dossier)}\n`;
    fs.writeFileSync(outputPath, raw, { encoding: "utf8", flag: "w", mode: 0o644 });
    fs.chmodSync(outputPath, 0o644);
    const readback = fs.readFileSync(outputPath, "utf8");
    if (readback !== raw) fail("DOSSIER_READBACK_INVALID", "persisted dossier bytes differ from generated bytes");
    const parsedReadback = JSON.parse(readback);
    const readbackBase = { ...parsedReadback };
    delete readbackBase.dossier_hash;
    if (parsedReadback.dossier_hash !== dossier.dossier_hash || sha256(canonical(readbackBase)) !== dossier.dossier_hash) fail("DOSSIER_READBACK_INVALID", "persisted dossier failed self-hash validation");
    process.stdout.write(`${JSON.stringify({
      dossier_hash: dossier.dossier_hash,
      dossier_raw_sha256: sha256(raw),
      compile_profile_hash: PROFILE_HASH,
      compile_key: preview.result.compile.compile_key,
      stable_manifest_hash: preview.result.compile.manifest_hash,
      stable_artifact_rows: preview.result.compile.artifact_rows,
      source_closure_hash: runtimeAndSource.source_closure.closure_hash,
      runtime_dependency_graph_hash: runtimeAndSource.runtime.dependency_graph.graph_hash,
      whole_abrain_unchanged: true,
      p2a_target_inventory_hash: targetAfter.inventory_hash,
      temporary_output_removed: true,
      restart_required: false,
    }, null, 2)}\n`);
  } finally {
    closeAll(allHandles);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    if (tempRoot && fs.existsSync(tempRoot)) fail("TEMP_CLEANUP_FAILED", "private temp directory remains after preview", { tempRoot });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.code || "P2B1_PREVIEW_FAILED"}: ${error?.message || String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
});
