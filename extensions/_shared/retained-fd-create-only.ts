/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./jcs";
import {
  procFdChildPath,
  walkRetainParentDirectoryFd,
  type D3V2RetainedDirFd,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-rollback";

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const HASH = /^[0-9a-f]{64}$/;
const PENDING = /^\.([0-9a-f]{64})\.(intent|activation|receipt)\.pending$/;

export type RetainedCreateOnlyKind = "intent" | "activation" | "receipt";
export type RetainedCreateOnlyCrashPoint = "before_hardlink" | "after_hardlink" | "after_unlink";

export class RetainedCreateOnlyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RetainedCreateOnlyError";
    this.code = code;
  }
}

export function createOnlyPendingBasename(operationId: string, kind: RetainedCreateOnlyKind): string {
  assertOperationKind(operationId, kind);
  return `.${operationId}.${kind}.pending`;
}

/**
 * Publish one durable file without replacement through a retained parent FD:
 * deterministic O_EXCL pending -> file fsync -> hardlink no-replace -> parent
 * fsync -> linked-pair verification -> pending unlink -> parent fsync -> exact
 * readback. A simulated crash deliberately leaves the real crash state intact.
 */
export function publishCreateOnlyRetained(
  file: string,
  raw: string | Buffer,
  label: string,
  options: {
    operationId: string;
    kind: RetainedCreateOnlyKind;
    crashPoint?: RetainedCreateOnlyCrashPoint;
  },
): Readonly<{ path: string; bytes: number; raw_sha256: string; dev: number; ino: number }> {
  const resolved = path.resolve(file);
  assertFinalPath(resolved, options.operationId, options.kind);
  const parent = walkRetainParentDirectoryFd(path.dirname(resolved), { create: false, label: `${label} parent` });
  try {
    return publishAtParent(parent, path.basename(resolved), Buffer.isBuffer(raw) ? raw : Buffer.from(raw), label, options);
  } finally {
    fs.closeSync(parent.fd);
  }
}

/**
 * Fresh-continue-only pending recovery. No execute/runtime caller may use this.
 * The only accepted states are one deterministic temp with exact bytes/metadata,
 * either unlinked (nlink=1, no final) or linked to the exact final (same inode,
 * nlink=2). Foreign/multiple pending names fail closed. The pending name is
 * unlinked and the parent is fsync'd before returning.
 */
export function recoverCreateOnlyPendingRetained(args: {
  file: string;
  raw: string | Buffer;
  label: string;
  operationId: string;
  kind: RetainedCreateOnlyKind;
  recoveryMode: "fresh_continue";
  expectedMode?: number;
  expectedUid?: number;
  expectedGid?: number;
}): Readonly<{ status: "missing" | "final_exact" | "discarded_unlinked_pending" | "recovered_linked_pending"; finalPresent: boolean }> {
  if (args.recoveryMode !== "fresh_continue") fail("CREATE_ONLY_RECOVERY_FORBIDDEN", "pending cleanup requires fresh_continue mode");
  const resolved = path.resolve(args.file);
  assertFinalPath(resolved, args.operationId, args.kind);
  const bytes = Buffer.isBuffer(args.raw) ? args.raw : Buffer.from(args.raw);
  const parent = walkRetainParentDirectoryFd(path.dirname(resolved), { create: false, label: `${args.label} recovery parent` });
  try {
    const expectedPending = createOnlyPendingBasename(args.operationId, args.kind);
    assertUniquePending(parent.fd, expectedPending, args.label);
    const finalProc = procFdChildPath(parent.fd, path.basename(resolved));
    const pendingProc = procFdChildPath(parent.fd, expectedPending);
    const finalStat = lstatMaybe(finalProc);
    const pendingStat = lstatMaybe(pendingProc);
    const mode = args.expectedMode ?? 0o600;
    const uid = args.expectedUid ?? process.getuid?.() ?? -1;
    const gid = args.expectedGid ?? process.getgid?.() ?? -1;

    if (!pendingStat) {
      if (!finalStat) return Object.freeze({ status: "missing", finalPresent: false });
      assertExactMetadata(finalStat, mode, uid, gid, 1, bytes.length, `${args.label} final`);
      const final = readAtParent(parent.fd, path.basename(resolved), { label: `${args.label} final`, maxBytes: bytes.length, expectedMode: mode, expectedNlink: 1, expectedUid: uid, expectedGid: gid });
      if (!final.raw.equals(bytes)) fail("CREATE_ONLY_RECOVERY_BYTES", `${args.label} final bytes differ`);
      // Covers a crash after pending unlink but before the second parent fsync.
      fs.fsyncSync(parent.fd);
      return Object.freeze({ status: "final_exact", finalPresent: true });
    }

    if (!finalStat) {
      assertExactMetadata(pendingStat, mode, uid, gid, 1, bytes.length, `${args.label} unlinked pending`);
      const pending = readAtParent(parent.fd, expectedPending, { label: `${args.label} unlinked pending`, maxBytes: bytes.length, expectedMode: mode, expectedNlink: 1, expectedUid: uid, expectedGid: gid });
      if (!pending.raw.equals(bytes)) fail("CREATE_ONLY_RECOVERY_BYTES", `${args.label} unlinked pending bytes differ`);
      fs.unlinkSync(pendingProc);
      fs.fsyncSync(parent.fd);
      return Object.freeze({ status: "discarded_unlinked_pending", finalPresent: false });
    }

    assertExactMetadata(finalStat, mode, uid, gid, 2, bytes.length, `${args.label} linked final`);
    assertExactMetadata(pendingStat, mode, uid, gid, 2, bytes.length, `${args.label} linked pending`);
    if (finalStat.dev !== pendingStat.dev || finalStat.ino !== pendingStat.ino) {
      fail("CREATE_ONLY_RECOVERY_LINK", `${args.label} final and pending are not the same exact inode`);
    }
    const linked = readAtParent(parent.fd, path.basename(resolved), { label: `${args.label} linked final`, maxBytes: bytes.length, expectedMode: mode, expectedNlink: 2, expectedUid: uid, expectedGid: gid });
    if (!linked.raw.equals(bytes)) fail("CREATE_ONLY_RECOVERY_BYTES", `${args.label} linked final bytes differ`);
    fs.unlinkSync(pendingProc);
    fs.fsyncSync(parent.fd);
    const recovered = readAtParent(parent.fd, path.basename(resolved), { label: `${args.label} recovered final`, maxBytes: bytes.length, expectedMode: mode, expectedNlink: 1, expectedUid: uid, expectedGid: gid });
    if (!recovered.raw.equals(bytes)) fail("CREATE_ONLY_RECOVERY_BYTES", `${args.label} recovered final bytes differ`);
    return Object.freeze({ status: "recovered_linked_pending", finalPresent: true });
  } finally {
    fs.closeSync(parent.fd);
  }
}

export function readExactRetainedFile(file: string, options: {
  label: string;
  maxBytes?: number;
  expectedMode?: number;
  expectedNlink?: number;
  expectedUid?: number;
  expectedGid?: number;
}): Readonly<{ raw: Buffer; identity: Readonly<Record<string, number>> }> {
  const resolved = path.resolve(file);
  const parent = walkRetainParentDirectoryFd(path.dirname(resolved), { create: false, label: `${options.label} parent` });
  try { return readAtParent(parent.fd, path.basename(resolved), options); }
  finally { fs.closeSync(parent.fd); }
}

export function readAtRetainedParent(parentFd: number, basename: string, options: {
  label: string;
  maxBytes?: number;
  expectedMode?: number;
  expectedNlink?: number;
  expectedUid?: number;
  expectedGid?: number;
}): Readonly<{ raw: Buffer; identity: Readonly<Record<string, number>> }> {
  return readAtParent(parentFd, basename, options);
}

function publishAtParent(
  parent: D3V2RetainedDirFd,
  basename: string,
  bytes: Buffer,
  label: string,
  options: { operationId: string; kind: RetainedCreateOnlyKind; crashPoint?: RetainedCreateOnlyCrashPoint },
): Readonly<{ path: string; bytes: number; raw_sha256: string; dev: number; ino: number }> {
  const finalProc = procFdChildPath(parent.fd, basename);
  const tempBase = createOnlyPendingBasename(options.operationId, options.kind);
  const tempProc = procFdChildPath(parent.fd, tempBase);
  assertUniquePending(parent.fd, tempBase, label);
  if (lstatMaybe(finalProc)) fail("CREATE_ONLY_TARGET_EXISTS", `${label} target already exists; execute never accepts repetition`);
  if (lstatMaybe(tempProc)) fail("CREATE_ONLY_PENDING_EXISTS", `${label} deterministic pending already exists; execute stops`);
  let tempPresent = false;
  let preserveCrashState = false;
  try {
    const fd = fs.openSync(tempProc, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    tempPresent = true;
    try {
      fs.fchmodSync(fd, 0o600);
      writeAll(fd, bytes);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd);
      const uid = process.getuid?.() ?? opened.uid;
      const gid = process.getgid?.() ?? opened.gid;
      assertExactMetadata(opened, 0o600, uid, gid, 1, bytes.length, `${label} pending after fsync`);
    } finally { fs.closeSync(fd); }
    if (options.crashPoint === "before_hardlink") {
      preserveCrashState = true;
      fail("CREATE_ONLY_SIMULATED_CRASH", `${label} simulated crash before hardlink`);
    }
    try { fs.linkSync(tempProc, finalProc); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("CREATE_ONLY_TARGET_EXISTS", `${label} target won a concurrent create; execute stops`);
      if ((error as NodeJS.ErrnoException).code === "EXDEV") fail("CREATE_ONLY_EXDEV", `${label} no-replace hardlink crossed filesystems`);
      throw error;
    }
    fs.fsyncSync(parent.fd);
    const temp = fs.lstatSync(tempProc);
    const final = fs.lstatSync(finalProc);
    if (!temp.isFile() || !final.isFile() || temp.dev !== final.dev || temp.ino !== final.ino || temp.nlink !== 2 || final.nlink !== 2) {
      fail("CREATE_ONLY_LINK_INVALID", `${label} pending/final are not one exact hardlinked inode`);
    }
    const linked = readAtParent(parent.fd, basename, { label: `${label} linked target`, maxBytes: bytes.length, expectedMode: 0o600, expectedNlink: 2 });
    if (!linked.raw.equals(bytes)) fail("CREATE_ONLY_READBACK", `${label} linked target bytes differ`);
    if (options.crashPoint === "after_hardlink") {
      preserveCrashState = true;
      fail("CREATE_ONLY_SIMULATED_CRASH", `${label} simulated crash after hardlink`);
    }
    fs.unlinkSync(tempProc);
    tempPresent = false;
    if (options.crashPoint === "after_unlink") {
      preserveCrashState = true;
      fail("CREATE_ONLY_SIMULATED_CRASH", `${label} simulated crash after pending unlink`);
    }
    fs.fsyncSync(parent.fd);
    const readback = readAtParent(parent.fd, basename, { label: `${label} target`, maxBytes: bytes.length, expectedMode: 0o600, expectedNlink: 1 });
    if (!readback.raw.equals(bytes)) fail("CREATE_ONLY_READBACK", `${label} final readback bytes differ`);
    return Object.freeze({ path: path.join(parent.path, basename), bytes: bytes.length, raw_sha256: sha256Hex(bytes), dev: readback.identity.dev!, ino: readback.identity.ino! });
  } finally {
    if (tempPresent && !preserveCrashState) {
      try { fs.unlinkSync(tempProc); fs.fsyncSync(parent.fd); } catch { /* best-effort cleanup after a non-crash failure */ }
    }
  }
}

function readAtParent(parentFd: number, basename: string, options: {
  label: string; maxBytes?: number; expectedMode?: number; expectedNlink?: number; expectedUid?: number; expectedGid?: number;
}): Readonly<{ raw: Buffer; identity: Readonly<Record<string, number>> }> {
  const child = procFdChildPath(parentFd, basename);
  const named = fs.lstatSync(child);
  const expectedMode = options.expectedMode ?? 0o600;
  const expectedNlink = options.expectedNlink ?? 1;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (named.isSymbolicLink() || !named.isFile() || (named.mode & 0o7777) !== expectedMode || named.nlink !== expectedNlink || named.size > maxBytes
    || (options.expectedUid !== undefined && named.uid !== options.expectedUid)
    || (options.expectedGid !== undefined && named.gid !== options.expectedGid)) {
    fail("CREATE_ONLY_FILE_UNSAFE", `${options.label} is not an exact bounded regular mode/owner/nlink file`);
  }
  const fd = fs.openSync(child, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(child);
    if (!sameIdentity(before, after) || !sameIdentity(after, namedAfter) || raw.length !== before.size) fail("CREATE_ONLY_FILE_RACE", `${options.label} changed while read`);
    return Object.freeze({
      raw,
      identity: Object.freeze({ dev: before.dev, ino: before.ino, mode: before.mode & 0o7777, uid: before.uid, gid: before.gid, nlink: before.nlink, size: before.size, mtime_ms: before.mtimeMs, ctime_ms: before.ctimeMs }),
    });
  } finally { fs.closeSync(fd); }
}

function assertFinalPath(file: string, operationId: string, kind: RetainedCreateOnlyKind): void {
  assertOperationKind(operationId, kind);
  if (path.basename(file) !== `${operationId}.json`) fail("CREATE_ONLY_PATH", "final basename must be exact <operationId>.json");
  const expectedDirectory = kind === "intent" ? "intents" : kind === "activation" ? "activations" : "receipts";
  if (path.basename(path.dirname(file)) !== expectedDirectory) fail("CREATE_ONLY_PATH", `final parent must be ${expectedDirectory}`);
}

function assertUniquePending(parentFd: number, expected: string, label: string): void {
  const entries = fs.readdirSync(`/proc/self/fd/${parentFd}`);
  const pending = entries.filter((name) => PENDING.test(name));
  const foreign = pending.filter((name) => name !== expected);
  if (foreign.length > 0 || pending.length > 1) fail("CREATE_ONLY_FOREIGN_PENDING", `${label} contains foreign or multiple pending entries`);
}

function assertOperationKind(operationId: string, kind: string): asserts kind is RetainedCreateOnlyKind {
  if (!HASH.test(operationId)) fail("CREATE_ONLY_OPERATION", "operationId must be lowercase SHA-256");
  if (kind !== "intent" && kind !== "activation" && kind !== "receipt") fail("CREATE_ONLY_KIND", "create-only kind is invalid");
}

function assertExactMetadata(stat: fs.Stats, mode: number, uid: number, gid: number, nlink: number, size: number, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== mode || stat.uid !== uid || stat.gid !== gid || stat.nlink !== nlink || stat.size !== size) {
    fail("CREATE_ONLY_RECOVERY_METADATA", `${label} mode/uid/gid/nlink/size differs`);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) fail("CREATE_ONLY_WRITE", "exclusive pending write made no progress");
    offset += written;
  }
}
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function fail(code: string, message: string): never { throw new RetainedCreateOnlyError(code, message); }
