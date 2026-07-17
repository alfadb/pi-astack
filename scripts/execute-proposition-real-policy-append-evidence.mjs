#!/usr/bin/env node
/** Stage2 defaults denied; Stage3 can enter only through the verified-FD confinement launcher. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "..");
const repoRoot = "/home/worker/.pi/agent/skills/pi-astack";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(sourceRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const previewRelative = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-execution-ready-preview-dossier.json";
const recoveryRelative = "docs/evidence/2026-07-16-adr0040-real-policy-proposition-append-s2-recovery-ready-dossier.json";
const privateRoot = "/run/pi-astack";

function main() {
  const forbidden = ["--force", "--yes", "--bypass", "--authorization-text", "--human-authorization", "--recovery-authorization", "--machine-authorization-binding", "--tuple", "--target"].find((flag) => process.argv.includes(flag));
  if (forbidden) deny("STAGE2_BYPASS_FORBIDDEN", `unsupported bypass or caller-supplied tuple option: ${forbidden}`);
  if (process.env.PI_ASTACK_REAL_POLICY_APPEND_TEST === "1" && process.argv.length === 3 && process.argv[2] === "--runner-handoff-smoke") return runnerHandoffSmoke();
  if (process.argv.length === 3 && process.argv[2] === "--internal-confined") return runConfined(false);
  if (process.argv.length === 3 && process.argv[2] === "--internal-confined-recovery") return runConfined(true);
  if (process.argv.length === 3 && process.argv[2] === "--production-append") return launchConfined(false);
  if (process.argv.length === 3 && process.argv[2] === "--production-recovery") return launchConfined(true);
  deny("FRESH_STAGE3_AUTHORIZATION_REQUIRED", "default invocation is denied; each production route requires its own fresh transcript authorization and accepts no caller-supplied authorization payload");
}

function runConfined(recovery) {
  if (process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED !== "1") deny("EFFECTIVE_BWRAP_REQUIRED", "internal mode is available only in the official namespace");
  if (sourceRoot !== path.join(privateRoot, "source")) deny("EXECUTION_CLOSURE_DRIFT", "internal source root is not the private FD-bound tree");
  const execute = jiti(path.join(sourceRoot, "extensions/_shared/proposition-real-policy-append-production-execute.ts"));
  const result = recovery ? execute.executeRealPolicyAppendRecovery({ repoRoot }) : execute.executeRealPolicyAppendProduction({ repoRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function launchConfined(recovery) {
  const dossierPath = path.join(repoRoot, recovery ? recoveryRelative : previewRelative);
  const dossierRaw = readStableRegular(dossierPath);
  const dossier = JSON.parse(dossierRaw.toString("utf8"));
  const preimage = recovery ? dossier?.recovery_source_closure?.preimage : dossier?.source_closure?.preimage;
  const external = preimage?.external_execution_closure;
  const sourceRows = preimage?.source_rows;
  if (!external || external.schema_version !== "adr0040-real-policy-proposition-append-execution-closure/v2" || !Array.isArray(sourceRows)) deny("EXECUTION_READY_PREVIEW_REQUIRED", "Stage2 dossier lacks the complete v2 execution closure");

  const opened = [];
  const track = (entry) => { opened.push(entry); return entry; };
  const stdio = ["ignore", "inherit", "inherit"];
  const inherit = (entry) => { const childFd = stdio.length; stdio.push(entry.fd); return String(childFd); };
  try {
    const node = track(openExpectedFile(external.official_node.executable.path, external.official_node.executable, true));
    const flock = track(openExpectedFile(external.pinned_flock.executable.path, external.pinned_flock.executable, true));
    const bwrap = track(openExpectedFile(external.bubblewrap.executable.path, external.bubblewrap.executable, true));
    const ldd = track(openExpectedFile(external.ldd.path, external.ldd, true));
    const evidence = track(openVerifiedDirectory(path.join(repoRoot, "docs/evidence")));
    const eventFirst = track(openVerifiedDirectory("/home/worker/.abrain/l1/events/sha256/1c"));

    const sourceBindings = sourceRows.map((row) => {
      const relative = exactRelative(row.path);
      return { relative, opened: track(openExpectedFile(path.join(repoRoot, ...relative.split("/")), row, false)) };
    });
    const jitiRoot = track(openVerifiedDirectory(external.jiti.package_root));
    const jitiBindings = external.jiti.rows.filter((row) => row.kind === "file").map((row) => ({ relative: exactRelative(row.path), opened: track(openExpectedFile(path.join(external.jiti.package_root, ...row.path.split("/")), row, false)) }));
    const dsoBindings = external.loader_dso_rows.map((row) => ({ destination: path.resolve(row.real_path), opened: track(openExpectedFile(row.real_path, { bytes: row.bytes, sha256: row.sha256, identity: row.identity }, false)) }));

    const args = [
      "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
      "--setenv", "PI_ASTACK_REAL_POLICY_APPEND_CONFINED", "1", "--setenv", "HOME", "/home/worker", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C", "--setenv", "LC_ALL", "C",
      "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/run", "--dir", privateRoot,
    ];
    const directories = new Set([`${privateRoot}/source`, `${privateRoot}/node_modules`, `${privateRoot}/evidence`, `${privateRoot}/event-first`]);
    for (const binding of sourceBindings) addParentDirectories(directories, `${privateRoot}/source/${binding.relative}`, `${privateRoot}/source`);
    directories.add(`${privateRoot}/node_modules/jiti`);
    for (const directory of [...directories].sort((a, b) => depth(a) - depth(b) || compare(a, b))) args.push("--dir", directory);

    const bwrapChildFd = inherit(bwrap);
    args.push("--ro-bind-fd", bwrapChildFd, `${privateRoot}/bwrap`);
    args.push("--ro-bind-fd", inherit(node), `${privateRoot}/node`);
    args.push("--ro-bind-fd", inherit(flock), `${privateRoot}/flock`);
    args.push("--ro-bind-fd", inherit(ldd), `${privateRoot}/ldd`);
    args.push("--bind-fd", inherit(evidence), `${privateRoot}/evidence`);
    args.push("--bind-fd", inherit(eventFirst), `${privateRoot}/event-first`);
    args.push("--ro-bind-fd", inherit(jitiRoot), `${privateRoot}/node_modules/jiti`);
    for (const binding of sourceBindings) args.push("--ro-bind-fd", inherit(binding.opened), `${privateRoot}/source/${binding.relative}`);
    for (const binding of jitiBindings) args.push("--ro-bind-fd", inherit(binding.opened), `${privateRoot}/node_modules/jiti/${binding.relative}`);
    for (const binding of dsoBindings) args.push("--ro-bind-fd", inherit(binding.opened), binding.destination);
    args.push("--remount-ro", "/run", "--chdir", `${privateRoot}/source`, "--unsetenv", "PWD", "--", `${privateRoot}/node`, `${privateRoot}/source/scripts/execute-proposition-real-policy-append-evidence.mjs`, recovery ? "--internal-confined-recovery" : "--internal-confined");

    for (const entry of opened) verifyOpened(entry, true);
    const child = spawnSync(`/proc/self/fd/${bwrapChildFd}`, args, { stdio, env: {}, cwd: "/" });
    for (const entry of opened) verifyOpened(entry, true);
    if (child.error || child.signal) deny("REAL_POLICY_APPEND_CONFINEMENT", "verified-FD bubblewrap executor failed", { status: child.status, signal: child.signal, error: child.error?.message });
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  } finally {
    for (const entry of opened.reverse()) { try { fs.closeSync(entry.fd); } catch {} }
  }
}

function runnerHandoffSmoke() {
  const root = fs.mkdtempSync("/tmp/pi-astack-runner-handoff-");
  const directory = path.join(root, "writable");
  const moved = path.join(root, "moved");
  const symlinkDirectory = path.join(root, "symlink-writable");
  const symlinkMoved = path.join(root, "symlink-moved");
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    const mutable = openVerifiedDirectory(directory);
    try {
      fs.writeFileSync(path.join(directory, "metadata-only-child"), "x", { mode: 0o600 });
      verifyOpened(mutable, true);
      fs.renameSync(directory, moved);
      fs.mkdirSync(directory, { mode: 0o700 });
      let replacementRejected = false;
      try { verifyOpened(mutable, true); } catch (error) { replacementRejected = error?.code === "NOT_AUTHORIZED"; }
      if (!replacementRejected) throw new Error("directory replacement did not reject");
    } finally { fs.closeSync(mutable.fd); }

    fs.mkdirSync(symlinkDirectory, { mode: 0o700 });
    const symlinked = openVerifiedDirectory(symlinkDirectory);
    try {
      fs.renameSync(symlinkDirectory, symlinkMoved);
      fs.symlinkSync(symlinkMoved, symlinkDirectory);
      let symlinkRejected = false;
      try { verifyOpened(symlinked, true); } catch (error) { symlinkRejected = error?.code === "NOT_AUTHORIZED"; }
      if (!symlinkRejected) throw new Error("directory symlink replacement did not reject");
    } finally { fs.closeSync(symlinked.fd); }
    process.stdout.write(`${JSON.stringify({ mutable_directory_metadata_change_accepted: true, inode_replacement_rejected: true, symlink_replacement_rejected: true })}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function openExpectedFile(fileInput, expected, executable) {
  const file = path.resolve(fileInput);
  assertNoSymlinkAncestors(file);
  const named = fs.lstatSync(file);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(file) !== file || (executable && (named.mode & 0o111) === 0)) deny("EXECUTION_CLOSURE_DRIFT", "closure file is unsafe", { file });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  const raw = fs.readFileSync(fd);
  const identity = expected.identity;
  if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || raw.length !== expected.bytes || sha256(raw) !== expected.sha256 || (identity && !sameExpectedIdentity(opened, identity))) {
    fs.closeSync(fd);
    deny("EXECUTION_CLOSURE_DRIFT", "closure file bytes or identity differ", { file });
  }
  return { fd, file, dev: opened.dev, ino: opened.ino, size: opened.size, mode: opened.mode, uid: opened.uid, gid: opened.gid, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs, sha256: expected.sha256 };
}

function openVerifiedDirectory(directoryInput) {
  const directory = path.resolve(directoryInput);
  assertNoSymlinkAncestors(path.join(directory, "leaf"));
  const named = fs.lstatSync(directory);
  if (named.isSymbolicLink() || !named.isDirectory() || fs.realpathSync.native(directory) !== directory) deny("FD_HANDOFF_UNSAFE", "bind source directory is unsafe", { directory });
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino || opened.mode !== named.mode || opened.uid !== named.uid || opened.gid !== named.gid) { fs.closeSync(fd); deny("FD_HANDOFF_REPLACED", "directory identity changed while opened", { directory }); }
  return { fd, file: directory, dev: opened.dev, ino: opened.ino, mode: opened.mode, uid: opened.uid, gid: opened.gid, directory: true };
}

function verifyOpened(entry, verifyNamed) {
  const opened = fs.fstatSync(entry.fd);
  if (entry.directory) {
    if (!opened.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.mode !== entry.mode || opened.uid !== entry.uid || opened.gid !== entry.gid) deny("FD_HANDOFF_REPLACED", "opened directory changed across handoff", { file: entry.file });
  } else if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size || opened.mode !== entry.mode || opened.uid !== entry.uid || opened.gid !== entry.gid || sha256(readFdBytes(entry.fd, opened.size)) !== entry.sha256) {
    deny("FD_HANDOFF_REPLACED", "opened static file changed across handoff", { file: entry.file });
  }
  if (!verifyNamed) return;
  const named = fs.lstatSync(entry.file);
  if (named.isSymbolicLink() || (entry.directory ? !named.isDirectory() : !named.isFile()) || named.dev !== opened.dev || named.ino !== opened.ino || named.mode !== entry.mode || named.uid !== entry.uid || named.gid !== entry.gid || fs.realpathSync.native(entry.file) !== entry.file) deny("FD_HANDOFF_REPLACED", "named closure object no longer matches opened FD", { file: entry.file });
}

function readFdBytes(fd, size) {
  const raw = Buffer.alloc(size);
  let offset = 0;
  while (offset < raw.length) { const read = fs.readSync(fd, raw, offset, raw.length - offset, offset); if (read <= 0) break; offset += read; }
  return offset === raw.length ? raw : raw.subarray(0, offset);
}

function sameExpectedIdentity(stat, expected) {
  return Number(stat.dev) === Number(expected.dev) && Number(stat.ino) === Number(expected.ino) && Number(stat.size) === Number(expected.size)
    && Number(stat.mode) === Number(expected.mode) && Number(stat.uid) === Number(expected.uid) && Number(stat.gid) === Number(expected.gid)
    && Number(stat.nlink) === Number(expected.nlink) && stat.mtimeMs === expected.mtime_ms && stat.ctimeMs === expected.ctime_ms;
}
function assertNoSymlinkAncestors(file) { let current = path.parse(file).root; for (const component of path.relative(current, path.dirname(file)).split(path.sep).filter(Boolean)) { current = path.join(current, component); const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) deny("FD_HANDOFF_UNSAFE", "path ancestor is a symlink or non-directory", { current }); } }
function addParentDirectories(set, file, floor) { let current = path.dirname(file); while (current.startsWith(`${floor}/`) || current === floor) { set.add(current); if (current === floor) break; current = path.dirname(current); } }
function exactRelative(value) { if (typeof value !== "string" || !value || path.isAbsolute(value) || value.split("/").includes("..")) deny("EXECUTION_CLOSURE_DRIFT", "closure path is not repository-relative", { value }); return value; }
function readStableRegular(file) { assertNoSymlinkAncestors(file); const named = fs.lstatSync(file); if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(file) !== file) deny("EXECUTION_READY_PREVIEW_REQUIRED", "Stage2 dossier path is unsafe"); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const before = fs.fstatSync(fd), raw = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file); if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.dev !== current.dev || before.ino !== current.ino) deny("EXECUTION_READY_PREVIEW_REQUIRED", "Stage2 dossier changed while read"); return raw; } finally { fs.closeSync(fd); } }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function depth(value) { return value.split("/").length; }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function deny(reason, message, detail = undefined) { const error = new Error(`NOT_AUTHORIZED: ${reason}: ${message}`); error.code = "NOT_AUTHORIZED"; error.detail = { reason, ...detail }; throw error; }

try { main(); }
catch (error) {
  process.stderr.write(`${error?.code ?? "REAL_POLICY_APPEND_EXECUTE_FAILED"}: ${error?.message ?? String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
}
