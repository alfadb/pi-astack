/// <reference types="node" />
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RetainedDirectoryIdentity {
  path: string;
  realpath: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
}

export interface RetainedDirectoryOfdLock {
  status: "ACQUIRED" | "BUSY";
  fd: number | null;
  identity: Readonly<RetainedDirectoryIdentity>;
  procfd_path: string | null;
  close(): void;
}

export class RetainedDirectoryOfdLockError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RetainedDirectoryOfdLockError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

/**
 * Locks the same open file description that remains retained by the parent.
 * The lock is advisory and coordinates only callers using this protocol.
 */
export function acquireRetainedDirectoryOfdLock(directoryInput: string): RetainedDirectoryOfdLock {
  if (process.platform !== "linux") fail("OFD_LOCK_UNSUPPORTED", "retained directory OFD locking requires Linux");
  const directory = path.resolve(directoryInput);
  assertNoSymlinkAncestors(directory);
  const before = readNamedDirectoryIdentity(directory);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let closed = false;
  try {
    assertOpenedIdentity(fd, before, "before flock");
    const flock = openPinnedFlock();
    let result;
    try {
      result = spawnSync("/proc/self/fd/4", ["-xn", "3"], {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "ignore", "ignore", fd, flock.fd],
      });
    } finally {
      fs.closeSync(flock.fd);
    }
    if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
      fail("OFD_LOCK_FLOCK_FAILED", "pinned /usr/bin/flock -xn 3 failed", {
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
      });
    }
    if (result.status === 1) {
      fs.closeSync(fd);
      closed = true;
      return Object.freeze({
        status: "BUSY" as const,
        fd: null,
        identity: Object.freeze(before),
        procfd_path: null,
        close() {},
      });
    }

    const after = readNamedDirectoryIdentity(directory);
    assertSameIdentity(before, after, "named control root changed after flock acquisition");
    assertOpenedIdentity(fd, after, "after flock");
    if (fs.realpathSync(directory) !== before.realpath) fail("OFD_LOCK_IDENTITY_CHANGED", "control root realpath changed after flock acquisition");

    const close = () => {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    };
    return Object.freeze({
      status: "ACQUIRED" as const,
      fd,
      identity: Object.freeze(after),
      procfd_path: `/proc/self/fd/${fd}`,
      close,
    });
  } catch (error) {
    if (!closed) fs.closeSync(fd);
    throw error;
  }
}

export async function withRetainedDirectoryOfdLock<T>(
  directory: string,
  operation: (lock: RetainedDirectoryOfdLock & { status: "ACQUIRED"; fd: number; procfd_path: string }) => Promise<T> | T,
): Promise<{ status: "BUSY" } | { status: "ACQUIRED"; value: T; identity: Readonly<RetainedDirectoryIdentity> }> {
  const lock = acquireRetainedDirectoryOfdLock(directory);
  if (lock.status === "BUSY") return { status: "BUSY" };
  try {
    const value = await operation(lock as RetainedDirectoryOfdLock & { status: "ACQUIRED"; fd: number; procfd_path: string });
    return { status: "ACQUIRED", value, identity: lock.identity };
  } finally {
    lock.close();
  }
}

function openPinnedFlock(): { fd: number } {
  const named = fs.lstatSync("/usr/bin/flock");
  if (named.isSymbolicLink() || !named.isFile()) fail("OFD_LOCK_FLOCK_UNSAFE", "/usr/bin/flock must be a no-symlink regular file");
  const fd = fs.openSync("/usr/bin/flock", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
    fs.closeSync(fd);
    fail("OFD_LOCK_FLOCK_UNSAFE", "/usr/bin/flock changed while opened");
  }
  return { fd };
}

function readNamedDirectoryIdentity(directory: string): RetainedDirectoryIdentity {
  const named = fs.lstatSync(directory);
  if (named.isSymbolicLink() || !named.isDirectory()) fail("OFD_LOCK_ROOT_UNSAFE", "control root must be an exact no-symlink directory", { directory });
  const real = fs.realpathSync(directory);
  if (real !== directory) fail("OFD_LOCK_ROOT_UNSAFE", "control root must already be its own canonical realpath", { directory, real });
  return {
    path: directory,
    realpath: real,
    dev: named.dev,
    ino: named.ino,
    mode: named.mode & 0o7777,
    uid: named.uid,
    gid: named.gid,
    nlink: named.nlink,
  };
}

function assertOpenedIdentity(fd: number, expected: RetainedDirectoryIdentity, phase: string): void {
  const opened = fs.fstatSync(fd);
  if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino
    || (opened.mode & 0o7777) !== expected.mode || opened.uid !== expected.uid || opened.gid !== expected.gid) {
    fail("OFD_LOCK_IDENTITY_CHANGED", `opened control root identity differs ${phase}`);
  }
}

function assertSameIdentity(left: RetainedDirectoryIdentity, right: RetainedDirectoryIdentity, message: string): void {
  if (left.path !== right.path || left.realpath !== right.realpath || left.dev !== right.dev || left.ino !== right.ino
    || left.mode !== right.mode || left.uid !== right.uid || left.gid !== right.gid || left.nlink !== right.nlink) {
    fail("OFD_LOCK_IDENTITY_CHANGED", message, { before: left, after: right });
  }
}

function assertNoSymlinkAncestors(target: string): void {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("OFD_LOCK_ANCESTOR_SYMLINK", "control root ancestor is a symlink", { current });
    if (current !== target && !stat.isDirectory()) fail("OFD_LOCK_ANCESTOR_UNSAFE", "control root ancestor is not a directory", { current });
  }
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new RetainedDirectoryOfdLockError(code, message, detail);
}
