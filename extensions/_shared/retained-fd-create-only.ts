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

export class RetainedCreateOnlyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RetainedCreateOnlyError";
    this.code = code;
  }
}

/**
 * Publish one durable file without replacement through a retained parent FD:
 * O_EXCL temp -> file fsync -> hardlink no-replace -> parent fsync -> exact
 * linked-pair verification -> temp unlink -> parent fsync -> exact readback.
 */
export function publishCreateOnlyRetained(file: string, raw: string | Buffer, label: string): Readonly<{
  path: string;
  bytes: number;
  raw_sha256: string;
  dev: number;
  ino: number;
}> {
  const resolved = path.resolve(file);
  const parent = walkRetainParentDirectoryFd(path.dirname(resolved), { create: false, label: `${label} parent` });
  try { return publishAtParent(parent, path.basename(resolved), Buffer.isBuffer(raw) ? raw : Buffer.from(raw), label); }
  finally { fs.closeSync(parent.fd); }
}

export function readExactRetainedFile(file: string, options: {
  label: string;
  maxBytes?: number;
  expectedMode?: number;
  expectedNlink?: number;
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
}): Readonly<{ raw: Buffer; identity: Readonly<Record<string, number>> }> {
  return readAtParent(parentFd, basename, options);
}

function publishAtParent(parent: D3V2RetainedDirFd, basename: string, bytes: Buffer, label: string): Readonly<{
  path: string; bytes: number; raw_sha256: string; dev: number; ino: number;
}> {
  const finalProc = procFdChildPath(parent.fd, basename);
  if (lstatMaybe(finalProc)) fail("CREATE_ONLY_TARGET_EXISTS", `${label} target already exists; execute never accepts repetition`);
  const tempBase = `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tempProc = procFdChildPath(parent.fd, tempBase);
  let tempPresent = false;
  try {
    const fd = fs.openSync(tempProc, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    tempPresent = true;
    try {
      fs.fchmodSync(fd, 0o600);
      writeAll(fd, bytes);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || (opened.mode & 0o7777) !== 0o600 || opened.nlink !== 1 || opened.size !== bytes.length) {
        fail("CREATE_ONLY_TEMP_INVALID", `${label} temp identity differs after fsync`);
      }
    } finally { fs.closeSync(fd); }
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
      fail("CREATE_ONLY_LINK_INVALID", `${label} temp/final are not one exact hardlinked inode`);
    }
    const linked = readAtParent(parent.fd, basename, { label: `${label} linked target`, maxBytes: bytes.length, expectedMode: 0o600, expectedNlink: 2 });
    if (!linked.raw.equals(bytes)) fail("CREATE_ONLY_READBACK", `${label} linked target bytes differ`);
    fs.unlinkSync(tempProc);
    tempPresent = false;
    fs.fsyncSync(parent.fd);
    const readback = readAtParent(parent.fd, basename, { label: `${label} target`, maxBytes: bytes.length, expectedMode: 0o600, expectedNlink: 1 });
    if (!readback.raw.equals(bytes)) fail("CREATE_ONLY_READBACK", `${label} final readback bytes differ`);
    return Object.freeze({
      path: path.join(parent.path, basename),
      bytes: bytes.length,
      raw_sha256: sha256Hex(bytes),
      dev: readback.identity.dev!,
      ino: readback.identity.ino!,
    });
  } finally {
    if (tempPresent) {
      try { fs.unlinkSync(tempProc); fs.fsyncSync(parent.fd); } catch { /* best-effort removal after a caught failure */ }
    }
  }
}

function readAtParent(parentFd: number, basename: string, options: {
  label: string; maxBytes?: number; expectedMode?: number; expectedNlink?: number;
}): Readonly<{ raw: Buffer; identity: Readonly<Record<string, number>> }> {
  const child = procFdChildPath(parentFd, basename);
  const named = fs.lstatSync(child);
  const expectedMode = options.expectedMode ?? 0o600;
  const expectedNlink = options.expectedNlink ?? 1;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (named.isSymbolicLink() || !named.isFile() || (named.mode & 0o7777) !== expectedMode || named.nlink !== expectedNlink || named.size > maxBytes) {
    fail("CREATE_ONLY_FILE_UNSAFE", `${options.label} is not an exact bounded regular mode/nlink file`);
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
      identity: Object.freeze({
        dev: before.dev, ino: before.ino, mode: before.mode & 0o7777, uid: before.uid,
        gid: before.gid, nlink: before.nlink, size: before.size,
        mtime_ms: before.mtimeMs, ctime_ms: before.ctimeMs,
      }),
    });
  } finally { fs.closeSync(fd); }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) fail("CREATE_ONLY_WRITE", "exclusive temp write made no progress");
    offset += written;
  }
}
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function fail(code: string, message: string): never { throw new RetainedCreateOnlyError(code, message); }
