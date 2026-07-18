#!/usr/bin/env node
/**
 * Deterministically preview or replace the Constraint L2 compiled-view during
 * an active content merge conflict. This never mutates L1, .state, or the Git
 * index and never completes the merge.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "constraint-l2-merge-conflict-recovery/v1";
const TARGET = "l2/views/constraint/latest/compiled-view.md";
const KNOWLEDGE_MANIFEST = "l2/views/knowledge/latest/manifest.json";
const ALLOWED_UNMERGED = new Set([TARGET, KNOWLEDGE_MANIFEST]);
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const DIRECTORY = fs.constants.O_DIRECTORY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, moduleCache: false });
const runtime = jiti(path.join(repoRoot, "extensions/_shared/canonical-git-runtime.ts"));

class RecoveryError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.name = "RecoveryError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new RecoveryError(code, message, detail);
}

function parseArgs(argv) {
  let abrain;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--abrain") {
      if (abrain !== undefined || index + 1 >= argv.length) fail("ARGUMENT_INVALID", "--abrain must appear exactly once with a value");
      abrain = argv[++index];
    } else if (value === "--write") {
      if (write) fail("ARGUMENT_INVALID", "--write may appear only once");
      write = true;
    } else {
      fail("ARGUMENT_INVALID", `unknown argument: ${value}`);
    }
  }
  if (abrain === undefined) fail("ARGUMENT_INVALID", "--abrain is required and must be an exact absolute realpath");
  return { abrain, write };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sanitizedGitEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function gitRaw(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, "--literal-pathspecs", ...args], {
      encoding: "buffer",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail("GIT_COMMAND_FAILED", `git ${args[0] ?? "command"} failed`, {
      exit_code: Number.isInteger(error?.status) ? error.status : null,
      stderr: Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8").trim().slice(0, 512) : "",
    });
  }
}

function gitText(repo, args) {
  return gitRaw(repo, args).toString("utf8").trim();
}

function exactRepo(input) {
  if (NOFOLLOW === undefined || DIRECTORY === undefined) fail("PLATFORM_UNSUPPORTED", "O_NOFOLLOW and O_DIRECTORY are required");
  if (typeof input !== "string" || !path.isAbsolute(input) || path.resolve(input) !== input) {
    fail("ABRAIN_PATH_NOT_EXACT", "--abrain must be an exact absolute normalized path", { input });
  }
  let named;
  let real;
  try {
    named = fs.lstatSync(input, { bigint: true });
    real = fs.realpathSync.native(input);
  } catch (error) {
    fail("ABRAIN_PATH_UNSAFE", "--abrain cannot be inspected", { input, error: error?.code ?? String(error) });
  }
  if (named.isSymbolicLink() || !named.isDirectory() || real !== input) {
    fail("ABRAIN_PATH_UNSAFE", "--abrain must name its exact realpath directory", { input, real });
  }
  const top = gitText(input, ["rev-parse", "--show-toplevel"]);
  if (top !== input) fail("ABRAIN_REPO_ROOT_MISMATCH", "--abrain must be the exact Git worktree root", { input, top });
  return input;
}

function assertContained(repo, file, expectedRelative) {
  const relative = path.relative(repo, file).split(path.sep).join("/");
  if (relative !== expectedRelative || path.resolve(repo, ...expectedRelative.split("/")) !== file) {
    fail("TARGET_PATH_ESCAPE", "target does not resolve to the single allowed Constraint L2 path", { relative });
  }
}

function assertSafeTargetFile(repo) {
  const target = path.resolve(repo, ...TARGET.split("/"));
  assertContained(repo, target, TARGET);
  let current = repo;
  for (const component of TARGET.split("/").slice(0, -1)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current, { bigint: true }); }
    catch (error) { fail("TARGET_PATH_UNSAFE", "target directory chain is missing or unreadable", { path: current, error: error?.code ?? String(error) }); }
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(current) !== current) {
      fail("TARGET_PATH_UNSAFE", "target directory chain contains a symlink or non-directory", { path: current });
    }
  }
  let named;
  try { named = fs.lstatSync(target, { bigint: true }); }
  catch (error) { fail("TARGET_PATH_UNSAFE", "target must already exist as a regular conflict file", { error: error?.code ?? String(error) }); }
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(target) !== target) {
    fail("TARGET_PATH_UNSAFE", "target must be a no-follow regular file", { target });
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(named, opened)) fail("TARGET_PATH_RACE", "opened target identity differs from named target");
  } finally {
    fs.closeSync(fd);
  }
  return { target, stat: named };
}

function exactGitDir(repo) {
  const expected = path.join(repo, ".git");
  const reported = gitText(repo, ["rev-parse", "--absolute-git-dir"]);
  let stat;
  try { stat = fs.lstatSync(expected, { bigint: true }); }
  catch (error) { fail("GIT_DIR_UNSAFE", ".git must be an exact directory", { error: error?.code ?? String(error) }); }
  if (reported !== expected || stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(expected) !== expected) {
    fail("GIT_DIR_UNSAFE", ".git must be the worktree's exact no-symlink directory", { expected, reported });
  }
  return expected;
}

function readStableRegular(file, code) {
  let named;
  try { named = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(code, "file cannot be inspected", { file, error: error?.code ?? String(error) });
  }
  if (named.isSymbolicLink() || !named.isFile()) fail(code, "file is not a no-follow regular file", { file });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || !sameIdentity(named, before) || !sameIdentity(before, after) || !sameIdentity(after, current)) {
      fail(code, "file identity changed during no-follow read", { file });
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function parseUnmerged(raw) {
  const entries = [];
  for (const row of raw.subarray(0, raw.length - (raw.at(-1) === 0 ? 1 : 0)).toString("binary").split("\0").filter(Boolean)) {
    const bytes = Buffer.from(row, "binary");
    const tab = bytes.indexOf(0x09);
    if (tab < 0) fail("UNMERGED_INDEX_MALFORMED", "git ls-files -u row has no path separator");
    const header = bytes.subarray(0, tab).toString("ascii");
    const pathBytes = bytes.subarray(tab + 1);
    const relative = pathBytes.toString("utf8");
    if (!Buffer.from(relative, "utf8").equals(pathBytes)) fail("UNMERGED_PATH_UNSAFE", "unmerged path is not valid UTF-8");
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([123])$/.exec(header);
    if (!match) fail("UNMERGED_INDEX_MALFORMED", "git ls-files -u row has an invalid stage record", { header });
    entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: relative });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.stage - right.stage);
  return entries;
}

function inspectConflict(repo) {
  const gitDir = exactGitDir(repo);
  const mergeHeadBytes = readStableRegular(path.join(gitDir, "MERGE_HEAD"), "MERGE_HEAD_UNSAFE");
  const unmergedRaw = gitRaw(repo, ["ls-files", "-u", "-z"]);
  const entries = parseUnmerged(unmergedRaw);
  const unmergedPaths = [...new Set(entries.map((entry) => entry.path))].sort();
  const targetStages = entries.filter((entry) => entry.path === TARGET).map(({ mode, oid, stage }) => ({ mode, oid, stage }));
  return {
    mergeHeadBytes,
    unmergedRaw,
    entries,
    public: {
      merge_in_progress: mergeHeadBytes !== null,
      target_unmerged: targetStages.length > 0,
      target_stages: targetStages,
      unmerged_paths: unmergedPaths,
      knowledge_manifest_unmerged: unmergedPaths.includes(KNOWLEDGE_MANIFEST),
    },
  };
}

function assertWritePreflight(repo) {
  const observed = inspectConflict(repo);
  if (!observed.mergeHeadBytes) fail("MERGE_NOT_IN_PROGRESS", ".git/MERGE_HEAD does not exist as a regular file");
  const mergeHeads = observed.mergeHeadBytes.toString("ascii").trim().split("\n").filter(Boolean);
  if (!mergeHeads.length || mergeHeads.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid))) fail("MERGE_HEAD_INVALID", "MERGE_HEAD does not contain only object IDs");
  const extra = observed.public.unmerged_paths.filter((relative) => !ALLOWED_UNMERGED.has(relative));
  if (extra.length) fail("UNMERGED_PATH_NOT_ALLOWED", "merge contains an unmerged path outside the exact recovery allowlist", { paths: extra });
  const stages = observed.entries.filter((entry) => entry.path === TARGET);
  if (stages.length !== 3 || stages.some((entry, index) => entry.stage !== index + 1)) {
    fail("TARGET_NOT_UNMERGED", "Constraint compiled-view must have exactly stages 1, 2, and 3", { stages: stages.map((entry) => entry.stage) });
  }
  for (const entry of stages) {
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      fail("TARGET_STAGE_NOT_REGULAR", "each target stage must use a regular blob mode", { stage: entry.stage, mode: entry.mode });
    }
    if (gitText(repo, ["cat-file", "-t", entry.oid]) !== "blob") {
      fail("TARGET_STAGE_NOT_REGULAR", "each target stage object must be a blob", { stage: entry.stage, oid: entry.oid });
    }
  }
  const fingerprint = sha256(Buffer.concat([observed.mergeHeadBytes, Buffer.from([0]), observed.unmergedRaw]));
  return { ...observed, fingerprint };
}

function assertSourceStable(before, after) {
  if (
    before.repo !== after.repo
    || before.projectionEventId !== after.projectionEventId
    || before.bytes !== after.bytes
    || before.bytesSha256 !== after.bytesSha256
    || before.markdown !== after.markdown
  ) {
    fail("SOURCE_PROJECTION_DRIFT", "canonical L1 projection selection or rendered bytes changed before write");
  }
}

function durableReplace(repo, targetInfo, bytes, beforeRename) {
  const { target, stat: initialTarget } = targetInfo;
  const parent = path.dirname(target);
  const parentNamed = fs.lstatSync(parent, { bigint: true });
  const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  const parentOpened = fs.fstatSync(parentFd, { bigint: true });
  if (!parentOpened.isDirectory() || !sameIdentity(parentNamed, parentOpened)) {
    fs.closeSync(parentFd);
    fail("TARGET_PARENT_RACE", "opened target parent identity differs from named parent");
  }
  const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  let tempFd;
  let tempPresent = false;
  try {
    tempFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, Number(initialTarget.mode & 0o777n));
    tempPresent = true;
    const tempStat = fs.fstatSync(tempFd, { bigint: true });
    if (!tempStat.isFile() || tempStat.dev !== initialTarget.dev || tempStat.dev !== parentOpened.dev) {
      fail("TEMP_FILESYSTEM_MISMATCH", "temporary file is not a regular file on the target filesystem");
    }
    fs.writeFileSync(tempFd, bytes);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    beforeRename();
    const currentTarget = assertSafeTargetFile(repo).stat;
    const currentParent = fs.lstatSync(parent, { bigint: true });
    const currentTemp = fs.lstatSync(temp, { bigint: true });
    if (!sameIdentity(initialTarget, currentTarget)) fail("TARGET_PATH_RACE", "target identity changed before atomic rename");
    if (!sameIdentity(parentOpened, currentParent)) fail("TARGET_PARENT_RACE", "target parent identity changed before atomic rename");
    if (!currentTemp.isFile() || !sameIdentity(tempStat, currentTemp) || currentTemp.dev !== parentOpened.dev) fail("TEMP_PATH_RACE", "temporary file identity changed before atomic rename");

    fs.renameSync(temp, target);
    tempPresent = false;
    fs.fsyncSync(parentFd);
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    if (tempPresent) fs.rmSync(temp, { force: true });
    fs.closeSync(parentFd);
  }
  const readBack = readStableRegular(target, "TARGET_READBACK_FAILED");
  if (!readBack || !readBack.equals(bytes)) fail("TARGET_READBACK_MISMATCH", "atomic replacement did not read back exact rendered bytes");
}

function resultJson(status, source, conflict) {
  return {
    schema_version: SCHEMA_VERSION,
    status,
    target: TARGET,
    source_projection_event_id: source.projectionEventId,
    source_created_at_utc: source.createdAtUtc,
    sha256: source.bytesSha256,
    bytes: source.bytes,
    current_conflict_status: conflict.public,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = exactRepo(args.abrain);
  const targetInfo = assertSafeTargetFile(repo);
  const initialConflict = args.write ? assertWritePreflight(repo) : inspectConflict(repo);
  const source = await runtime.renderLatestCanonicalConstraintL2Projection({ abrainHome: repo });
  const bytes = Buffer.from(source.markdown, "utf8");
  if (source.repo !== repo || source.bytes !== bytes.length || source.bytesSha256 !== sha256(bytes)) {
    fail("SOURCE_RENDER_INVALID", "canonical runtime returned inconsistent rendered bytes");
  }
  if (!args.write) {
    process.stdout.write(`${JSON.stringify(resultJson("preview", source, initialConflict))}\n`);
    return;
  }

  const refreshedSource = await runtime.renderLatestCanonicalConstraintL2Projection({ abrainHome: repo });
  assertSourceStable(source, refreshedSource);
  const frozenConflict = assertWritePreflight(repo);
  durableReplace(repo, targetInfo, bytes, () => {
    const current = assertWritePreflight(repo);
    if (current.fingerprint !== frozenConflict.fingerprint || current.fingerprint !== initialConflict.fingerprint) {
      fail("MERGE_CONFLICT_DRIFT", "MERGE_HEAD or unmerged index changed before atomic rename");
    }
  });
  const finalConflict = inspectConflict(repo);
  process.stdout.write(`${JSON.stringify(resultJson("written", source, finalConflict))}\n`);
}

main().catch((error) => {
  const code = typeof error?.code === "string" ? error.code : "RECOVERY_FAILED";
  const output = {
    schema_version: SCHEMA_VERSION,
    status: "error",
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.detail && typeof error.detail === "object" ? { detail: error.detail } : {}),
  };
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
});
