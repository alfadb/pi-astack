/// <reference types="node" />
/**
 * Platform-neutral retained directory lock production adapter.
 *
 * - Linux: delegates to retained-directory-ofd-lock (full OFD semantics preserved).
 * - Windows: process-level production loadWindowsNativeAddon successful-load singleton
 *   (shared across retained/stable/edge/DCC consumers) + tryAcquireRetainedDirectoryLock;
 *   native null → BUSY; errors map to RetainedDirectoryLockError; never falls back to TS lockfile.
 * - Other platforms: unsupported (fail-closed).
 *
 * Production zero-arg load is cached only on success inside windows-native-addon
 * (globalThis). Failures are never cached. Test override is local and does not
 * pollute the process production singleton.
 *
 * Test seam is explicit `retainedDirectoryLockTestApi` (not env path / not production-mutable).
 * Windows addon override requires PI_ASTACK_ENABLE_TEST_HOOKS=1.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  acquireRetainedDirectoryOfdLock,
  type RetainedDirectoryIdentity,
  type RetainedDirectoryOfdLock,
} from "./retained-directory-ofd-lock";
import {
  hasWindowsNativeAddonProductionLoadSingleton,
  loadWindowsNativeAddon,
  mapRetainedDirectoryLockError,
  resetWindowsNativeAddonProductionLoadSingleton,
  tryAcquireRetainedDirectoryLock,
  WindowsNativeAddonError,
  type WindowsNativeAddonModuleV1,
  type WindowsNativeRetainedDirectoryLockIdentity,
  type WindowsNativeRetainedDirectoryLockLease,
} from "./windows-native-addon";

export type RetainedDirectoryLockIdentity =
  | RetainedDirectoryIdentity
  | WindowsNativeRetainedDirectoryLockIdentity
  | { readonly path: string };

export interface RetainedDirectoryLock {
  status: "ACQUIRED" | "BUSY";
  /** Linux OFD fd when acquired; always null on Windows (named mutex lease). */
  fd: number | null;
  identity: Readonly<RetainedDirectoryLockIdentity>;
  /** Linux `/proc/self/fd/<n>` when acquired; always null on Windows. */
  procfd_path: string | null;
  /**
   * Windows: true when acquire observed WAIT_ABANDONED.
   * Linux ACQUIRED: always false. BUSY leases omit this field.
   */
  acquired_after_abandon?: boolean;
  /** Re-verify retained identity; throws RetainedDirectoryLockError on drift/closed. */
  assertIdentity(): void;
  close(): void;
}

export class RetainedDirectoryLockError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RetainedDirectoryLockError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

/**
 * __TEST-only Windows addon override for acquireRetainedDirectoryLock (temp package).
 * Production never sets this; zero-arg production load remains the only production path.
 * Install requires PI_ASTACK_ENABLE_TEST_HOOKS=1. Does not write the process production singleton.
 */
let testWindowsAddonOverride: WindowsNativeAddonModuleV1 | null = null;

function loadWindowsAddonProduction(): WindowsNativeAddonModuleV1 {
  try {
    // Process-level successful-load singleton lives in windows-native-addon (globalThis).
    // Do not cache failures here — loadWindowsNativeAddon never caches failures either.
    return loadWindowsNativeAddon().addon;
  } catch (error) {
    throw mapWindowsToRetainedError(error);
  }
}

function resolveWindowsAddonForAcquire(): WindowsNativeAddonModuleV1 {
  if (testWindowsAddonOverride) {
    // Re-check at resolve time so unsetting PI_ASTACK_ENABLE_TEST_HOOKS mid-process
    // deauthorizes the fake and never uses it after hooks are withdrawn.
    assertRetainedLockTestHooks("testWindowsAddonOverride");
    return testWindowsAddonOverride;
  }
  return loadWindowsAddonProduction();
}

/**
 * Acquire a platform-native retained directory lock.
 * Advisory coordination only among callers of this protocol.
 */
export function acquireRetainedDirectoryLock(directoryInput: string): RetainedDirectoryLock {
  if (process.platform === "linux") return acquireLinux(directoryInput);
  if (process.platform === "win32") return acquireWindows(directoryInput, resolveWindowsAddonForAcquire);
  fail(
    "RETAINED_DIRECTORY_LOCK_UNSUPPORTED",
    `retained directory locking is unsupported on ${process.platform}`,
    { platform: process.platform },
  );
}

export async function withRetainedDirectoryLock<T>(
  directory: string,
  operation: (lock: RetainedDirectoryLock & { status: "ACQUIRED" }) => Promise<T> | T,
): Promise<
  | { status: "BUSY" }
  | { status: "ACQUIRED"; value: T; identity: Readonly<RetainedDirectoryLockIdentity> }
> {
  const lock = acquireRetainedDirectoryLock(directory);
  if (lock.status === "BUSY") return { status: "BUSY" };
  let primaryError: unknown;
  let value: T | undefined;
  try {
    value = await operation(lock as RetainedDirectoryLock & { status: "ACQUIRED" });
  } catch (error) {
    primaryError = error;
  }
  try {
    lock.close();
  } catch (closeError) {
    // Success path: sole close failure must surface. With primary, keep primary.
    if (primaryError === undefined) throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  return {
    status: "ACQUIRED",
    value: value as T,
    identity: lock.identity,
  };
}

function acquireLinux(directoryInput: string): RetainedDirectoryLock {
  const raw = acquireRetainedDirectoryOfdLock(directoryInput);
  return wrapLinuxLease(raw);
}

function wrapLinuxLease(raw: RetainedDirectoryOfdLock): RetainedDirectoryLock {
  if (raw.status === "BUSY" || raw.fd == null) {
    return Object.freeze({
      status: "BUSY" as const,
      fd: null,
      identity: raw.identity,
      procfd_path: null,
      assertIdentity() {
        fail("RETAINED_DIRECTORY_LOCK_CLOSED", "BUSY retained directory lock has no identity lease");
      },
      close() {},
    });
  }

  // closed flag blocks assertIdentity after close so a recycled fd number cannot
  // spuriously re-match identity (fd reuse false positive).
  let closed = false;
  const acquiredFd = raw.fd;
  return Object.freeze({
    status: "ACQUIRED" as const,
    fd: acquiredFd,
    identity: raw.identity,
    procfd_path: raw.procfd_path,
    acquired_after_abandon: false,
    assertIdentity() {
      if (closed) {
        fail("RETAINED_DIRECTORY_LOCK_CLOSED", "retained directory lock already closed");
      }
      const expected = raw.identity;
      const opened = fs.fstatSync(acquiredFd);
      if (
        !opened.isDirectory()
        || opened.dev !== expected.dev
        || opened.ino !== expected.ino
        || (opened.mode & 0o7777) !== expected.mode
        || opened.uid !== expected.uid
        || opened.gid !== expected.gid
      ) {
        fail("RETAINED_DIRECTORY_LOCK_IDENTITY_CHANGED", "opened control root identity differs on assertIdentity");
      }
    },
    close() {
      if (closed) return;
      // Mark closed before raw.close so concurrent assertIdentity cannot use a
      // recycled fd if close races with another open.
      closed = true;
      raw.close();
    },
  });
}

function acquireWindows(
  directoryInput: string,
  loadAddon: () => WindowsNativeAddonModuleV1,
): RetainedDirectoryLock {
  let lease: WindowsNativeRetainedDirectoryLockLease | null;
  try {
    const addon = loadAddon();
    lease = tryAcquireRetainedDirectoryLock(addon, directoryInput);
  } catch (error) {
    throw mapWindowsToRetainedError(error);
  }
  if (lease == null) {
    const directory = path.resolve(directoryInput);
    return Object.freeze({
      status: "BUSY" as const,
      fd: null,
      identity: Object.freeze({ path: directory }),
      procfd_path: null,
      assertIdentity() {
        fail("RETAINED_DIRECTORY_LOCK_CLOSED", "BUSY retained directory lock has no identity lease");
      },
      close() {},
    });
  }
  return wrapWindowsLease(lease);
}

function wrapWindowsLease(raw: WindowsNativeRetainedDirectoryLockLease): RetainedDirectoryLock {
  let closed = false;
  const identity = Object.freeze({ ...raw.identity });
  return Object.freeze({
    status: "ACQUIRED" as const,
    fd: null,
    identity,
    procfd_path: null,
    acquired_after_abandon: raw.acquired_after_abandon === true,
    assertIdentity() {
      if (closed) {
        fail("RETAINED_DIRECTORY_LOCK_CLOSED", "retained directory lock already closed");
      }
      try {
        raw.assertIdentity();
      } catch (error) {
        throw mapWindowsToRetainedError(error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        raw.close();
      } catch (error) {
        throw mapWindowsToRetainedError(error);
      }
    },
  });
}

function mapWindowsToRetainedError(error: unknown): RetainedDirectoryLockError {
  if (error instanceof RetainedDirectoryLockError) return error;
  const mapped =
    error instanceof WindowsNativeAddonError ? error : mapRetainedDirectoryLockError(error);
  const message = stripCodePrefix(mapped.code, mapped.message);
  return new RetainedDirectoryLockError(
    mapped.code,
    message,
    mapped.detail ? { ...mapped.detail } : undefined,
  );
}

function stripCodePrefix(code: string, message: string): string {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new RetainedDirectoryLockError(code, message, detail);
}

/**
 * Explicit __TEST seam for Windows temp-package dynamic pin injection.
 * Production code must not call this. Does not accept env path overrides or
 * mutate production pin / package paths. installWindowsAddonOverride requires
 * PI_ASTACK_ENABLE_TEST_HOOKS=1.
 */
function assertRetainedLockTestHooks(label: string): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    fail(
      "RETAINED_DIRECTORY_LOCK_TEST_HOOKS_DISABLED",
      `${label} requires PI_ASTACK_ENABLE_TEST_HOOKS=1`,
    );
  }
}

export const retainedDirectoryLockTestApi = Object.freeze({
  /**
   * Acquire via an already-loaded Windows native addon module (e.g. from the
   * windows-native-addon __TEST options loader with temp package + dynamic pin).
   * Requires PI_ASTACK_ENABLE_TEST_HOOKS=1.
   */
  acquireWithWindowsAddon(directory: string, addon: WindowsNativeAddonModuleV1): RetainedDirectoryLock {
    assertRetainedLockTestHooks("acquireWithWindowsAddon");
    return acquireWindows(directory, () => addon);
  },
  /**
   * Install process-scoped Windows addon override for acquireRetainedDirectoryLock.
   * Used by DCC/integration smokes so mutation barrier can run under temp package
   * without writing production pin. Pass null to clear.
   * Requires PI_ASTACK_ENABLE_TEST_HOOKS=1; does not expose pin/package paths.
   */
  installWindowsAddonOverride(addon: WindowsNativeAddonModuleV1 | null): void {
    assertRetainedLockTestHooks("installWindowsAddonOverride");
    testWindowsAddonOverride = addon;
  },
  /** Drop process-level production Windows addon singleton so the next production load re-runs. Requires test hooks. */
  resetWindowsAddonSingleton(): void {
    assertRetainedLockTestHooks("resetWindowsAddonSingleton");
    resetWindowsNativeAddonProductionLoadSingleton();
  },
  /** Observe whether the process-level production singleton is currently held (test diagnostics). Requires test hooks. */
  hasWindowsAddonSingleton(): boolean {
    assertRetainedLockTestHooks("hasWindowsAddonSingleton");
    return hasWindowsNativeAddonProductionLoadSingleton();
  },
});
