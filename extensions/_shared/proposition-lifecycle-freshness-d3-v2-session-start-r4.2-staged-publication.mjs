#!/usr/bin/env node
/** R4.2-only staged publication and anchored filesystem primitives. */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_OBJECT_BYTES,
  NONCE32,
  REVISION,
  SCHEMAS,
  R42Error,
  assertAbsolutePath,
  assertHash,
  canonicalObjectBytes,
  deepFreeze,
  fail,
  fullIdentityFromBigintStat,
  parseStrictJson,
  sha256,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs";

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const CLOEXEC = Number(Reflect.get(fs.constants, "O_CLOEXEC") ?? 0);
const PROC_FD = "/proc/self/fd";

export const PUBLICATION_SCHEMAS = Object.freeze({
  staged_publication_schema: SCHEMAS.staged_publish,
  link_final_schema: SCHEMAS.link_final,
  unlink_pending_schema: SCHEMAS.unlink_pending,
  staged_temp_path_schema: SCHEMAS.staged_temp_path,
});

export function assertR42Platform(platform = process.platform, procFd = PROC_FD) {
  if (platform !== "linux") fail("R42_PLATFORM", `R4.2 requires Linux; platform=${platform}`);
  let stat;
  try { stat = fs.lstatSync(procFd); } catch { fail("R42_PROCFD", `${procFd} is unavailable`); }
  if (!stat.isDirectory()) fail("R42_PROCFD", `${procFd} is not a directory`);
}

function procChild(fd, basename) {
  if (!Number.isSafeInteger(fd) || fd < 0 || typeof basename !== "string" || !basename || basename.includes("/") || basename === "." || basename === "..") fail("R42_ANCHORED_PATH", "invalid retained-fd child name");
  return `${PROC_FD}/${fd}/${basename}`;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function bigintSafe(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("R42_STAT_INTEGER", `${label} is unsafe`);
  return Number(value);
}

export function openAnchoredDirectory(directoryInput, options = {}) {
  assertR42Platform();
  const directory = assertAbsolutePath(path.resolve(directoryInput), options.label ?? "directory");
  let current = path.parse(directory).root;
  let fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW | CLOEXEC);
  try {
    for (const component of path.relative(current, directory).split(path.sep).filter(Boolean)) {
      const childPath = procChild(fd, component);
      const named = fs.lstatSync(childPath, { bigint: true });
      if (named.isSymbolicLink() || !named.isDirectory()) fail("R42_DIRECTORY_CHAIN", `${options.label ?? directory} contains a symlink/non-directory`);
      const childFd = fs.openSync(childPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW | CLOEXEC);
      const held = fs.fstatSync(childFd, { bigint: true });
      if (held.dev !== named.dev || held.ino !== named.ino) { fs.closeSync(childFd); fail("R42_DIRECTORY_RACE", `${component} changed while opening`); }
      fs.closeSync(fd);
      fd = childFd;
      current = path.join(current, component);
    }
    const held = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(directory, { bigint: true });
    if (!held.isDirectory() || held.dev !== named.dev || held.ino !== named.ino) fail("R42_DIRECTORY_RACE", `${directory} retained identity differs`);
    const mode = bigintSafe(held.mode & 0o7777n, "directory mode");
    const uid = bigintSafe(held.uid, "directory uid");
    const gid = bigintSafe(held.gid, "directory gid");
    const dev = bigintSafe(held.dev, "directory dev");
    if (options.mode !== undefined && mode !== options.mode) fail("R42_DIRECTORY_MODE", `${directory} mode differs`);
    if (options.uid !== undefined && uid !== options.uid) fail("R42_DIRECTORY_UID", `${directory} uid differs`);
    if (options.gid !== undefined && gid !== options.gid) fail("R42_DIRECTORY_GID", `${directory} gid differs`);
    if (options.dev !== undefined && dev !== options.dev) fail("R42_DIRECTORY_DEV", `${directory} device differs`);
    let closed = false;
    return Object.freeze({
      fd,
      path: directory,
      dev,
      uid,
      gid,
      mode,
      child(name) { if (closed) fail("R42_DIRECTORY_CLOSED", `${directory} fd is closed`); return procChild(fd, name); },
      names() { if (closed) fail("R42_DIRECTORY_CLOSED", `${directory} fd is closed`); return fs.readdirSync(`${PROC_FD}/${fd}`).sort(compareUtf8); },
      close() { if (!closed) { closed = true; fs.closeSync(fd); } },
    });
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    throw error;
  }
}

export function readAnchoredFile(parent, basename, options = {}) {
  const child = parent.child(basename);
  const namedBefore = fs.lstatSync(child, { bigint: true });
  const expectedNlink = options.nlink;
  const maxBytes = options.maxBytes ?? MAX_OBJECT_BYTES;
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.size > BigInt(maxBytes)) fail("R42_ANCHORED_FILE", `${options.label ?? basename} is not a bounded regular file`);
  const fd = fs.openSync(child, fs.constants.O_RDONLY | NOFOLLOW | CLOEXEC);
  try {
    const heldBefore = fs.fstatSync(fd, { bigint: true });
    const raw = fs.readFileSync(fd);
    const heldAfter = fs.fstatSync(fd, { bigint: true });
    const namedAfter = fs.lstatSync(child, { bigint: true });
    if (!sameNode(namedBefore, heldBefore) || !sameNode(heldBefore, heldAfter) || !sameNode(heldAfter, namedAfter) || raw.length !== Number(heldBefore.size)) fail("R42_ANCHORED_FILE_RACE", `${options.label ?? basename} changed while read`);
    const identity = fullIdentityFromBigintStat(heldBefore, raw);
    if (options.mode !== undefined && identity.mode !== options.mode) fail("R42_ANCHORED_MODE", `${options.label ?? basename} mode differs`);
    if (expectedNlink !== undefined && identity.nlink !== expectedNlink) fail("R42_ANCHORED_NLINK", `${options.label ?? basename} nlink differs`);
    if (options.uid !== undefined && identity.uid !== options.uid) fail("R42_ANCHORED_UID", `${options.label ?? basename} uid differs`);
    if (options.gid !== undefined && identity.gid !== options.gid) fail("R42_ANCHORED_GID", `${options.label ?? basename} gid differs`);
    if (options.expectedRaw && !raw.equals(options.expectedRaw)) fail("R42_ANCHORED_BYTES", `${options.label ?? basename} bytes differ`);
    if (options.strictJson) parseStrictJson(raw, { maxBytes });
    return deepFreeze({ raw, identity });
  } finally { fs.closeSync(fd); }
}

function lstatMaybe(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requireGuard(guard, syscall) {
  if (typeof guard !== "function") fail("R42_GUARD_REQUIRED", `${syscall} requires the complete auth/target/source guard`);
  const result = guard(syscall);
  if (result !== true) fail("R42_GUARD_REJECTED", `${syscall} guard did not return true`);
}

function mutate(state, guard, syscall, fn, hook) {
  requireGuard(guard, syscall);
  const result = fn();
  state.mutationCount += 1;
  hook?.({ syscall, mutationCount: state.mutationCount });
  return result;
}

function assertAuthorityNames({ operationId, kind, finalBasename, pendingBasename, tempBasename, nonce }) {
  assertHash(operationId, "operation_id");
  if (!["intent", "activation", "receipt"].includes(kind)) fail("R42_PUBLICATION_KIND", "publication kind differs");
  if (!NONCE32.test(nonce)) fail("R42_PUBLICATION_NONCE", "invocation nonce differs");
  const expectedFinal = `${operationId}.json`;
  const expectedPending = `.${operationId}.${kind}.pending`;
  const expectedTemp = `.${operationId}.${kind}.stage.${nonce}.tmp`;
  if (finalBasename !== expectedFinal || pendingBasename !== expectedPending || tempBasename !== expectedTemp) fail("R42_PUBLICATION_PATH", "publication authority/temp names differ", { expectedFinal, expectedPending, expectedTemp });
}

function assertObjectBytes(bytes, validateObject, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_OBJECT_BYTES || bytes.length < 3 || bytes.at(-1) !== 0x0a) fail("R42_PUBLICATION_BYTES", `${label} bytes are not bounded JCS+LF`);
  const value = parseStrictJson(bytes, { maxBytes: MAX_OBJECT_BYTES });
  if (`${JSON.stringify(value)}` === "") fail("R42_PUBLICATION_BYTES", `${label} parse failed`);
  if (`${canonicalize(value)}\n` !== bytes.toString("utf8")) fail("R42_PUBLICATION_CANONICAL", `${label} is not exact JCS+LF`);
  validateObject?.(value);
  return value;
}

function canonicalize(value) {
  // Avoid a second implementation: canonicalObjectBytes validates the hash when
  // requested, and its no-hash mode returns exact JCS+LF.
  return canonicalObjectBytes(value, undefined, { maxBytes: MAX_OBJECT_BYTES }).toString("utf8").slice(0, -1);
}

function writeAllGuarded(fd, bytes, state, guard, hook) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = mutate(state, guard, "write", () => fs.writeSync(fd, bytes, offset, bytes.length - offset, offset), hook);
    if (!Number.isSafeInteger(written) || written <= 0) fail("R42_PUBLICATION_WRITE", "write made no progress");
    offset += written;
  }
}

function readExactFd(fd, bytes, label) {
  const raw = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = fs.readSync(fd, raw, offset, bytes - offset, offset);
    if (count <= 0) fail("R42_RETAINED_FD_READ", `${label} made no progress`);
    offset += count;
  }
  return raw;
}

export function stagedPublish(args) {
  if (args.schema !== SCHEMAS.staged_publish) fail("R42_PUBLICATION_SCHEMA", "staged publication schema pin differs");
  const parent = args.parent;
  const state = { mutationCount: args.mutationState?.mutationCount ?? 0 };
  assertAuthorityNames(args);
  const bytes = Buffer.isBuffer(args.bytes) ? args.bytes : Buffer.from(args.bytes);
  const value = assertObjectBytes(bytes, args.validateObject, `${args.kind} object`);
  const tempPath = parent.child(args.tempBasename);
  const pendingPath = parent.child(args.pendingBasename);
  if (lstatMaybe(tempPath)) {
    const error = new R42Error("R42_STAGED_TEMP_EEXIST", "invocation-scoped staged temp already exists before O_EXCL create", { path: path.join(parent.path, args.tempBasename), classification: "foreign_race_or_residue" });
    error.mutationCount = 0;
    error.status = "ZERO_WRITE_HALT";
    throw error;
  }
  if (lstatMaybe(pendingPath)) fail("R42_PUBLICATION_PENDING_EXISTS", "deterministic pending already exists and requires the mode-specific convergence path");
  let fd = null;
  try {
    try {
      fd = mutate(state, args.guard, "openat_temp_create", () => fs.openSync(tempPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | CLOEXEC, 0o600), args.afterMutation);
    } catch (error) {
      if (error?.code === "EEXIST") fail("R42_STAGED_TEMP_EEXIST", "staged temp O_EXCL create raced with an existing inode", { path: path.join(parent.path, args.tempBasename), status: state.mutationCount === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE", classification: "foreign_race" });
      throw error;
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(tempPath, { bigint: true });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.dev !== BigInt(parent.dev) || (opened.mode & 0o7777n) !== 0o600n || opened.nlink !== 1n || opened.uid !== BigInt(uid) || opened.gid !== BigInt(gid)) fail("R42_PUBLICATION_TEMP_METADATA", "unique temp metadata differs");
    writeAllGuarded(fd, bytes, state, args.guard, args.afterMutation);
    mutate(state, args.guard, "fdatasync_temp", () => fs.fdatasyncSync(fd), args.afterMutation);
    mutate(state, args.guard, "fsync_temp", () => fs.fsyncSync(fd), args.afterMutation);
    const retainedRaw = readExactFd(fd, bytes.length, `${args.kind} retained temp`);
    const retainedAfter = fs.fstatSync(fd, { bigint: true });
    const namedAfter = fs.lstatSync(tempPath, { bigint: true });
    if (!retainedRaw.equals(bytes) || retainedAfter.dev !== opened.dev || retainedAfter.ino !== opened.ino || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino || retainedAfter.nlink !== 1n || namedAfter.nlink !== 1n) fail("R42_PUBLICATION_TEMP_READBACK", "unique temp readback differs");
    assertObjectBytes(retainedRaw, args.validateObject, `${args.kind} retained temp`);
    try {
      mutate(state, args.guard, "linkat_temp_to_pending", () => fs.linkSync(tempPath, pendingPath), args.afterMutation);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pending = lstatMaybe(pendingPath);
      const temp = lstatMaybe(tempPath);
      if (!pending || !temp || pending.dev !== opened.dev || pending.ino !== opened.ino || temp.dev !== opened.dev || temp.ino !== opened.ino || pending.nlink !== 2n || temp.nlink !== 2n) fail("R42_PUBLICATION_EEXIST", "pending EEXIST is not same-invocation same-inode convergence");
    }
    mutate(state, args.guard, "fsync_parent_after_pending_link", () => fs.fsyncSync(parent.fd), args.afterMutation);
    const pendingRead = readAnchoredFile(parent, args.pendingBasename, { label: `${args.kind} pending`, maxBytes: MAX_OBJECT_BYTES, mode: 0o600, nlink: 2, uid, gid, expectedRaw: bytes, strictJson: true });
    const tempLinked = fs.lstatSync(tempPath, { bigint: true });
    if (pendingRead.identity.dev !== bigintSafe(tempLinked.dev, "temp dev") || pendingRead.identity.ino !== bigintSafe(tempLinked.ino, "temp ino")) fail("R42_PUBLICATION_PENDING_INODE", "pending and temp are not same inode");
    mutate(state, args.guard, "unlinkat_redundant_temp", () => fs.unlinkSync(tempPath), args.afterMutation);
    mutate(state, args.guard, "fsync_parent_after_temp_unlink", () => fs.fsyncSync(parent.fd), args.afterMutation);
    const pendingFinal = readAnchoredFile(parent, args.pendingBasename, { label: `${args.kind} canonical pending`, maxBytes: MAX_OBJECT_BYTES, mode: 0o600, nlink: 1, uid, gid, expectedRaw: bytes, strictJson: true });
    return deepFreeze({
      schema_version: SCHEMAS.staged_publish,
      revision: REVISION,
      status: "canonical_pending",
      object: value,
      raw_sha256: sha256(bytes),
      pending_path: path.join(parent.path, args.pendingBasename),
      pending_identity: pendingFinal.identity,
      mutation_count: state.mutationCount,
    });
  } catch (error) {
    if (error instanceof R42Error) {
      error.mutationCount = state.mutationCount;
      error.status = state.mutationCount === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE";
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function sameInode(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function linkFinalIdempotent(args) {
  if (args.schema !== SCHEMAS.link_final) fail("R42_LINK_SCHEMA", "link_final schema pin differs");
  const state = { mutationCount: args.mutationState?.mutationCount ?? 0 };
  const bytes = Buffer.isBuffer(args.bytes) ? args.bytes : Buffer.from(args.bytes);
  const finalPath = args.parent.child(args.finalBasename);
  const pendingPath = args.parent.child(args.pendingBasename);
  const pendingNamed = lstatMaybe(pendingPath);
  if (!pendingNamed || (pendingNamed.nlink !== 1n && pendingNamed.nlink !== 2n)) fail("R42_LINK_PENDING", "canonical pending is absent or has invalid nlink");
  const pending = readAnchoredFile(args.parent, args.pendingBasename, { label: "retained canonical pending", mode: 0o600, nlink: Number(pendingNamed.nlink), uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
  if (pendingNamed.nlink === 2n) {
    const existingFinal = lstatMaybe(finalPath);
    if (!existingFinal || existingFinal.dev !== pendingNamed.dev || existingFinal.ino !== pendingNamed.ino || existingFinal.nlink !== 2n) fail("R42_LINK_PENDING", "nlink-2 pending lacks same-inode final");
  }
  try {
    try { mutate(state, args.guard, "linkat_pending_to_final", () => fs.linkSync(pendingPath, finalPath), args.afterMutation); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const finalStat = lstatMaybe(finalPath);
      const pendingStat = lstatMaybe(pendingPath);
      if (!finalStat) fail("R42_LINK_EEXIST", "final EEXIST without final inode");
      if (pendingStat) {
        if (finalStat.dev !== pendingStat.dev || finalStat.ino !== pendingStat.ino || finalStat.nlink !== 2n || pendingStat.nlink !== 2n) fail("R42_LINK_EEXIST", "final+pending EEXIST relation differs");
      } else {
        if (bigintSafe(finalStat.dev, "final dev") !== pending.identity.dev || bigintSafe(finalStat.ino, "final ino") !== pending.identity.ino || finalStat.nlink !== 1n) fail("R42_LINK_EEXIST", "final-only EEXIST relation differs");
      }
    }
    mutate(state, args.guard, "fsync_parent_after_final_link", () => fs.fsyncSync(args.parent.fd), args.afterMutation);
    const finalRead = readAnchoredFile(args.parent, args.finalBasename, { label: "linked final", mode: 0o600, nlink: lstatMaybe(pendingPath) ? 2 : 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
    if (!sameInode(finalRead.identity, pending.identity)) fail("R42_LINK_FINAL_INODE", "final does not retain pending inode");
    return deepFreeze({ status: lstatMaybe(pendingPath) ? "final_plus_pending" : "final_only", mutation_count: state.mutationCount, final_identity: finalRead.identity });
  } catch (error) {
    if (error instanceof R42Error) { error.mutationCount = state.mutationCount; error.status = state.mutationCount === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE"; }
    throw error;
  }
}

export function unlinkPendingIdempotent(args) {
  if (args.schema !== SCHEMAS.unlink_pending) fail("R42_UNLINK_SCHEMA", "unlink_pending schema pin differs");
  const state = { mutationCount: args.mutationState?.mutationCount ?? 0 };
  const bytes = Buffer.isBuffer(args.bytes) ? args.bytes : Buffer.from(args.bytes);
  const finalBefore = readAnchoredFile(args.parent, args.finalBasename, { label: "final before pending unlink", mode: 0o600, nlink: lstatMaybe(args.parent.child(args.pendingBasename)) ? 2 : 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
  const pendingPath = args.parent.child(args.pendingBasename);
  const pendingBefore = lstatMaybe(pendingPath);
  if (pendingBefore && (bigintSafe(pendingBefore.dev, "pending dev") !== finalBefore.identity.dev || bigintSafe(pendingBefore.ino, "pending ino") !== finalBefore.identity.ino || pendingBefore.nlink !== 2n)) fail("R42_UNLINK_RELATION", "pending does not match final inode/nlink");
  try {
    if (pendingBefore) mutate(state, args.guard, "unlinkat_pending", () => fs.unlinkSync(pendingPath), args.afterMutation);
    mutate(state, args.guard, "fsync_parent_after_pending_unlink", () => fs.fsyncSync(args.parent.fd), args.afterMutation);
    const final = readAnchoredFile(args.parent, args.finalBasename, { label: "terminal final", mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
    if (!sameInode(final.identity, finalBefore.identity)) fail("R42_UNLINK_FINAL_INODE", "final inode changed during pending cleanup");
    if (lstatMaybe(pendingPath)) fail("R42_UNLINK_READBACK", "pending remains after cleanup");
    return deepFreeze({ status: "final_only", mutation_count: state.mutationCount, final_identity: final.identity });
  } catch (error) {
    if (error instanceof R42Error) { error.mutationCount = state.mutationCount; error.status = state.mutationCount === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE"; }
    throw error;
  }
}

export function convergePendingToFinal(args) {
  const linked = linkFinalIdempotent({ ...args, schema: SCHEMAS.link_final });
  const unlinked = unlinkPendingIdempotent({ ...args, schema: SCHEMAS.unlink_pending, mutationState: { mutationCount: linked.mutation_count } });
  return deepFreeze({ status: "final_only", mutation_count: unlinked.mutation_count, final_identity: unlinked.final_identity });
}

function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

function assertDirectoryMetadata(file, expected) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o7777n) !== BigInt(expected.mode) || stat.uid !== BigInt(expected.uid) || stat.gid !== BigInt(expected.gid) || stat.dev !== BigInt(expected.dev)) fail("R42_BOOTSTRAP_METADATA", `${file} metadata differs`);
}

export function classifyControlBootstrap(controlRootInput) {
  const controlRoot = assertAbsolutePath(path.resolve(controlRootInput), "control_root");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const rootStat = lstatMaybe(controlRoot);
  if (!rootStat) return deepFreeze({ state: "root_absent", existing: [] });
  const rootDev = bigintSafe(rootStat.dev, "control root dev");
  assertDirectoryMetadata(controlRoot, { mode: 0o700, uid, gid, dev: rootDev });
  const names = fs.readdirSync(controlRoot).sort(compareUtf8);
  const states = [
    ["root_empty", []],
    ["root_plus_intents", ["intents"]],
    ["root_plus_intents_activations", ["activations", "intents"]],
    ["root_plus_intents_activations_receipts", ["activations", "intents", "receipts"]],
  ];
  const matched = states.find(([, expected]) => JSON.stringify(names) === JSON.stringify(expected));
  if (!matched) fail("R42_BOOTSTRAP_SHAPE", "control bootstrap prefix is skipped or contains extras", { names });
  for (const name of names) {
    const child = path.join(controlRoot, name);
    assertDirectoryMetadata(child, { mode: 0o700, uid, gid, dev: rootDev });
    if (fs.readdirSync(child).length !== 0) fail("R42_BOOTSTRAP_SHAPE", `${name} is not empty during bootstrap`);
  }
  return deepFreeze({ state: matched[0], existing: names, dev: rootDev });
}

export function bootstrapControl(args) {
  const state = { mutationCount: args.mutationState?.mutationCount ?? 0 };
  const root = assertAbsolutePath(path.resolve(args.controlRoot), "control_root");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const parentPath = path.dirname(root);
  const rootBase = path.basename(root);
  const expectedOrder = ["intents", "activations", "receipts"];
  let classification = classifyControlBootstrap(root);
  try {
    if (classification.state === "root_absent") {
      const parent = openAnchoredDirectory(parentPath, { label: "control parent" });
      try {
        mutate(state, args.guard, "mkdirat_control_root", () => fs.mkdirSync(parent.child(rootBase), { mode: 0o700 }), args.afterMutation);
        mutate(state, args.guard, "fsync_control_parent", () => fs.fsyncSync(parent.fd), args.afterMutation);
      } finally { parent.close(); }
      classification = classifyControlBootstrap(root);
    } else {
      const parent = openAnchoredDirectory(parentPath, { label: "control parent" });
      try { mutate(state, args.guard, "fsync_existing_control_parent", () => fs.fsyncSync(parent.fd), args.afterMutation); }
      finally { parent.close(); }
    }
    while (classification.state !== "root_plus_intents_activations_receipts") {
      const next = expectedOrder[classification.existing.length];
      if (!next) fail("R42_BOOTSTRAP_STATE", "control bootstrap has no unique next state");
      const rootFd = openAnchoredDirectory(root, { label: "control root", mode: 0o700, uid, gid });
      try {
        mutate(state, args.guard, `mkdirat_control_${next}`, () => fs.mkdirSync(rootFd.child(next), { mode: 0o700 }), args.afterMutation);
        mutate(state, args.guard, `fsync_control_root_after_${next}`, () => fs.fsyncSync(rootFd.fd), args.afterMutation);
      } finally { rootFd.close(); }
      classification = classifyControlBootstrap(root);
    }
    const finalRoot = openAnchoredDirectory(root, { label: "control root", mode: 0o700, uid, gid });
    return deepFreeze({ state: classification.state, mutation_count: state.mutationCount, root: finalRoot });
  } catch (error) {
    if (error instanceof R42Error) { error.mutationCount = state.mutationCount; error.status = state.mutationCount === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE"; }
    throw error;
  }
}

export function stagedTempBasename(operationId, kind, nonce) {
  assertHash(operationId, "operation_id");
  if (!["intent", "activation", "receipt"].includes(kind) || !NONCE32.test(nonce)) fail("R42_STAGED_TEMP_NAME", "staged temp name inputs differ");
  return `.${operationId}.${kind}.stage.${nonce}.tmp`;
}

export function pendingBasename(operationId, kind) {
  assertHash(operationId, "operation_id");
  if (!["intent", "activation", "receipt"].includes(kind)) fail("R42_PENDING_NAME", "pending name kind differs");
  return `.${operationId}.${kind}.pending`;
}
