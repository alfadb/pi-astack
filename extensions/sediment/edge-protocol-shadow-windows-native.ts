/// <reference types="node" />
/**
 * Windows production physical layer for edge-protocol-shadow durable objects.
 *
 * - Production: process-level zero-arg loadWindowsNativeAddon successful-load singleton
 *   (shared with retained/stable/DCC; failures never cached).
 * - Test seam: ALS + explicit deps + gated process override under PI_ASTACK_ENABLE_TEST_HOOKS=1
 *   (test injection does not write the process production singleton).
 * - Directories / private files: current TokenUser protected private_rw DACL.
 * - Existing weak / inherited / tampered DACL: never auto-repair (fail-closed).
 * - create → durableAtomicCreateFile (no-replace); append → durableAppendFile;
 *   read → readProtectedFile (byte ceiling); dir → ensure/verifyProtectedPath.
 * - Outer edge journal lock is retained native mutex on journal/lock.
 *   Append mutex is file-identity based — never the same directory as the outer lock
 *   (audit lives under edge root; journal records use create-only, no append mutex).
 * - Closed error surface: no raw Win32 text leakage.
 * - Linux callers must not import this for the POSIX durable path.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  acquireRetainedDirectoryLock,
  type RetainedDirectoryLock,
} from "../_shared/retained-directory-lock";
import {
  durableAppendFile,
  durableAtomicCreateFile,
  durableAtomicCreateFileWithTempDirectory,
  ensureProtectedDirectory,
  hasWindowsNativeAddonProductionLoadSingleton,
  loadWindowsNativeAddon,
  mapAtomicFileError,
  mapProtectedDaclError,
  readProtectedFile,
  resetWindowsNativeAddonProductionLoadSingleton,
  verifyProtectedPath,
  WindowsNativeAddonError,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_TEMPDIR_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1,
  type WindowsNativeAddonModuleV1,
} from "../_shared/windows-native-addon";

const REQUIRED_CAPS = Object.freeze([
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_TEMPDIR_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1,
] as const);

/** Retries for audit parent-dir retained lock (BUSY fail-closed after exhaustion). */
const AUDIT_PARENT_LOCK_RETRIES = 200;
const AUDIT_PARENT_LOCK_SLEEP_MS = 10;

const testAddonAls = new AsyncLocalStorage<WindowsNativeAddonModuleV1>();
/** Test-only override; does not write the process production singleton. */
let testAddonOverride: WindowsNativeAddonModuleV1 | null = null;

export class EdgeProtocolShadowWindowsNativeError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "EdgeProtocolShadowWindowsNativeError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface EdgeWindowsNativeDeps {
  /**
   * Test-only temp-package addon. Production ignores this field unless
   * PI_ASTACK_ENABLE_TEST_HOOKS=1 (explicit deps / ALS).
   */
  windowsNativeAddon?: WindowsNativeAddonModuleV1;
}

function assertTestHooksEnabled(label: string): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    fail("EDGE_WINDOWS_TEST_HOOKS_DISABLED", `${label} requires PI_ASTACK_ENABLE_TEST_HOOKS=1`);
  }
}

function mapNative(error: unknown, fallbackCode: string): EdgeProtocolShadowWindowsNativeError {
  if (error instanceof EdgeProtocolShadowWindowsNativeError) return error;
  const mapped =
    error instanceof WindowsNativeAddonError
      ? error
      : (() => {
        try {
          return mapAtomicFileError(error);
        } catch {
          try {
            return mapProtectedDaclError(error);
          } catch {
            return new WindowsNativeAddonError(
              "WINDOWS_NATIVE_ADDON_FAILED",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
  // Closed surface: never leak raw Win32 / native strings onto edge error_detail.
  return new EdgeProtocolShadowWindowsNativeError(
    fallbackCode,
    mapped.code,
    mapped.detail ? { ...mapped.detail, native_code: mapped.code } : { native_code: mapped.code },
  );
}

function requireCaps(addon: WindowsNativeAddonModuleV1): void {
  let caps: readonly string[];
  try {
    caps = addon.getCapabilities();
  } catch (error) {
    throw mapNative(error, "EDGE_WINDOWS_NATIVE_UNAVAILABLE");
  }
  for (const required of REQUIRED_CAPS) {
    if (!caps.includes(required)) {
      fail("EDGE_WINDOWS_NATIVE_UNAVAILABLE", "required native capabilities missing", {
        required: [...REQUIRED_CAPS],
        capabilities: [...caps],
      });
    }
  }
}

function loadProductionAddon(): WindowsNativeAddonModuleV1 {
  try {
    // Shared process-level successful-load singleton (windows-native-addon globalThis).
    const loaded = loadWindowsNativeAddon();
    requireCaps(loaded.addon);
    return loaded.addon;
  } catch (error) {
    // Do not cache failures — next call re-attempts production zero-arg load.
    throw mapNative(error, "EDGE_WINDOWS_NATIVE_UNAVAILABLE");
  }
}

/**
 * Resolve the Windows native addon for edge durable I/O.
 * Priority: explicit deps (test hooks) → ALS (test hooks) → process override (test hooks) → production cache.
 */
export function resolveEdgeWindowsNativeAddon(
  deps?: EdgeWindowsNativeDeps,
): WindowsNativeAddonModuleV1 {
  if (process.platform !== "win32") {
    fail("EDGE_WINDOWS_UNSUPPORTED_PLATFORM", "edge windows native path requires win32");
  }
  if (deps?.windowsNativeAddon !== undefined) {
    assertTestHooksEnabled("windowsNativeAddon deps");
    requireCaps(deps.windowsNativeAddon);
    return deps.windowsNativeAddon;
  }
  const alsAddon = testAddonAls.getStore();
  if (alsAddon) {
    assertTestHooksEnabled("testAddonAls");
    requireCaps(alsAddon);
    return alsAddon;
  }
  if (testAddonOverride) {
    assertTestHooksEnabled("testAddonOverride");
    requireCaps(testAddonOverride);
    return testAddonOverride;
  }
  return loadProductionAddon();
}

export function ensureEdgeProtectedDirectory(
  addon: WindowsNativeAddonModuleV1,
  directory: string,
): string {
  try {
    // Native ensure creates new private_rw dirs or verifies existing ones.
    // Existing weak/tampered DACL must fail-closed — never auto-repair via setProtectedPath.
    return ensureProtectedDirectory(addon, directory);
  } catch (error) {
    throw mapNative(error, "EDGE_WINDOWS_PROTECTED_DIR_FAILED");
  }
}

export function verifyEdgeProtectedDirectory(
  addon: WindowsNativeAddonModuleV1,
  directory: string,
): void {
  try {
    verifyProtectedPath(addon, directory, "directory", "private_rw");
  } catch (error) {
    throw mapNative(error, "EDGE_WINDOWS_PROTECTED_DIR_FAILED");
  }
}

export function verifyEdgeProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
): void {
  try {
    verifyProtectedPath(addon, filePath, "file", "private_rw");
  } catch (error) {
    throw mapNative(error, "EDGE_WINDOWS_PROTECTED_FILE_FAILED");
  }
}

/**
 * Ensure absolute directory chain under ownershipRoot.
 * ownershipRoot itself is only required to be a non-reparse directory (may be weak);
 * every created / existing component under it must be private_rw (existing weak fail-closed).
 */
export function ensureEdgeProtectedDirectoryChain(
  addon: WindowsNativeAddonModuleV1,
  ownershipRootInput: string,
  targetInput: string,
): string {
  const ownershipRoot = path.resolve(ownershipRootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(ownershipRoot, target);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail("EDGE_WINDOWS_PATH_ESCAPE", "edge layout target outside ownership root");
  }
  assertExactNoReparseDirectory(ownershipRoot, "edge ownership root");
  let current = ownershipRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    ensureEdgeProtectedDirectory(addon, current);
  }
  return target;
}

/** Closed-code only — no error.message regex fallback (unknown → not a size hit). */
function isNativeTooLarge(error: unknown): boolean {
  if (error instanceof WindowsNativeAddonError) {
    return error.code === "WINDOWS_NATIVE_ADDON_TOO_LARGE";
  }
  if (error instanceof EdgeProtocolShadowWindowsNativeError) {
    return error.code === "EDGE_WINDOWS_TOO_LARGE";
  }
  return false;
}

/** Closed-code only — no error.message regex fallback (unknown → not missing). */
function isNativeNotFound(error: unknown): boolean {
  if (error instanceof WindowsNativeAddonError) {
    return error.code === "WINDOWS_NATIVE_ADDON_NOT_FOUND";
  }
  if (error instanceof EdgeProtocolShadowWindowsNativeError) {
    const native = error.detail?.native_code;
    return native === "WINDOWS_NATIVE_ADDON_NOT_FOUND" || error.code === "EDGE_WINDOWS_NOT_FOUND";
  }
  return false;
}

/** Atomic no-replace create (same-dir temp); identical on exact bytes, collision otherwise. */
export function durableCreateEdgeProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  data: Buffer,
): "created" | "identical" | "collision" {
  try {
    const created = durableAtomicCreateFile(addon, filePath, data);
    return classifyCreateResult(addon, filePath, data, created);
  } catch (error) {
    if (isNativeTooLarge(error)) {
      // Existing leaf larger/different than expected create payload → not identical.
      return "collision";
    }
    throw mapNative(error, "EDGE_WINDOWS_DURABLE_CREATE_FAILED");
  }
}

/**
 * Atomic no-replace create with explicit same-volume staging directory
 * (atomic_file_tempdir_v1). Crash residue stays under staging, never records/sources.
 */
export function durableCreateEdgeProtectedFileWithTempDirectory(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  data: Buffer,
  tempDirectory: string,
): "created" | "identical" | "collision" {
  try {
    const created = durableAtomicCreateFileWithTempDirectory(
      addon,
      filePath,
      data,
      tempDirectory,
    );
    return classifyCreateResult(addon, filePath, data, created);
  } catch (error) {
    if (isNativeTooLarge(error)) return "collision";
    throw mapNative(error, "EDGE_WINDOWS_DURABLE_CREATE_FAILED");
  }
}

function classifyCreateResult(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  data: Buffer,
  created: boolean,
): "created" | "identical" | "collision" {
  if (created) {
    verifyEdgeProtectedFile(addon, filePath);
    return "created";
  }
  const existing = readProtectedFile(addon, filePath, Math.max(data.byteLength, 1));
  verifyEdgeProtectedFile(addon, filePath);
  if (existing.data.equals(data)) return "identical";
  return "collision";
}

/**
 * Append one record to an existing private_rw file under the native file-identity mutex.
 * File must already exist (create first via durableCreateEdgeProtectedFile).
 * Parent directory must be private_rw. Never uses Node O_APPEND.
 */
export function appendEdgeProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  data: Buffer,
): void {
  try {
    durableAppendFile(addon, filePath, data);
  } catch (error) {
    throw mapNative(error, "EDGE_WINDOWS_DURABLE_APPEND_FAILED");
  }
}

/**
 * Fail-closed durable audit JSONL append on Windows.
 *
 * Lock order (fixed): parent-dir retained lock → file-identity append mutex
 * (inside durableAppendFile). Same-byte concurrent first-create never drops a line:
 * parent retained lock covers exists/create-or-append, so each call appends one line.
 * Parent retained lock must never nest inside journal/lock (caller ALS assertion).
 * BUSY after retries → fail-closed (never silent success).
 * Never truncates / rewrites existing content (no silent wash of partials).
 */
export function appendEdgeProtectedAuditJsonlLine(
  addon: WindowsNativeAddonModuleV1,
  auditPath: string,
  lineBytes: Buffer,
  parentDir: string,
): void {
  // Parent must already be private_rw (caller ensures chain via ownership helper).
  verifyEdgeProtectedDirectory(addon, parentDir);

  const lock = acquireAuditParentRetainedLock(parentDir);
  try {
    appendEdgeProtectedAuditJsonlLineLocked(addon, auditPath, lineBytes);
  } finally {
    lock.close();
  }
}

function acquireAuditParentRetainedLock(parentDir: string): RetainedDirectoryLock & { status: "ACQUIRED" } {
  let lastBusy = false;
  for (let attempt = 0; attempt < AUDIT_PARENT_LOCK_RETRIES; attempt += 1) {
    let lock: RetainedDirectoryLock;
    try {
      lock = acquireRetainedDirectoryLock(parentDir);
    } catch (error) {
      throw mapNative(error, "EDGE_WINDOWS_AUDIT_LOCK_FAILED");
    }
    if (lock.status === "ACQUIRED") {
      return lock as RetainedDirectoryLock & { status: "ACQUIRED" };
    }
    lastBusy = true;
    // Brief backoff; still fail-closed if never acquired.
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, AUDIT_PARENT_LOCK_SLEEP_MS);
  }
  fail(
    "EDGE_WINDOWS_AUDIT_LOCK_BUSY",
    lastBusy
      ? "audit parent retained lock busy (fail-closed)"
      : "audit parent retained lock failed",
  );
}

function appendEdgeProtectedAuditJsonlLineLocked(
  addon: WindowsNativeAddonModuleV1,
  auditPath: string,
  lineBytes: Buffer,
): void {
  let exists = false;
  try {
    const st = fs.lstatSync(auditPath);
    if (st.isSymbolicLink() || st.isDirectory() || !st.isFile()) {
      fail("EDGE_WINDOWS_AUDIT_UNSAFE", "audit path exists as a non-regular file");
    }
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw mapNative(error, "EDGE_WINDOWS_AUDIT_STAT_FAILED");
    }
  }

  if (!exists) {
    // Under parent lock: first creator publishes; concurrent waiters re-check and append.
    // Same-byte first line must still produce one row per call — never treat identical create as done.
    const status = durableCreateEdgeProtectedFile(addon, auditPath, lineBytes);
    if (status === "created") return;
    // Another writer won create (identical or different first bytes) → always append this line.
    try {
      verifyEdgeProtectedFile(addon, auditPath);
      appendEdgeProtectedFile(addon, auditPath, lineBytes);
      return;
    } catch (error) {
      throw mapNative(error, "EDGE_WINDOWS_AUDIT_APPEND_FAILED");
    }
  }

  verifyEdgeProtectedFile(addon, auditPath);
  appendEdgeProtectedFile(addon, auditPath, lineBytes);
}

export function readEdgeProtectedFileBytes(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  maxBytes: number,
): Buffer {
  try {
    const result = readProtectedFile(addon, filePath, maxBytes);
    return result.data;
  } catch (error) {
    if (isNativeTooLarge(error)) {
      fail("EDGE_WINDOWS_TOO_LARGE", "protected file exceeds maxBytes");
    }
    if (isNativeNotFound(error)) {
      fail("EDGE_WINDOWS_NOT_FOUND", "protected file is missing");
    }
    throw mapNative(error, "EDGE_WINDOWS_PROTECTED_READ_FAILED");
  }
}

/**
 * Windows audit / source NOT_FOUND discipline:
 * native-verify parent first; only when parent is valid private_rw and leaf is missing
 * may the caller treat the result as empty/missing. Parent invalid → fail-closed.
 */
export function classifyEdgeWindowsNotFound(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
): "leaf_missing" | never {
  const parent = path.dirname(path.resolve(filePath));
  try {
    verifyEdgeProtectedDirectory(addon, parent);
  } catch (error) {
    throw mapNative(error, "EDGE_WINDOWS_PROTECTED_DIR_FAILED");
  }
  // Parent valid → leaf absence is the only remaining NOT_FOUND interpretation.
  return "leaf_missing";
}

/**
 * Parse audit JSONL bytes fail-closed:
 * - incomplete trailing line (no final newline with residual bytes) → throw
 * - any non-empty line that is not valid JSON → throw
 * Does not wash / truncate; caller decides what to do with parsed rows.
 */
export function parseEdgeAuditJsonlBytesFailClosed(raw: Buffer): string[] {
  if (raw.byteLength === 0) return [];
  const text = raw.toString("utf8");
  // Empty trailing segment after final \n is OK; residual without \n is partial crash residue.
  if (!text.endsWith("\n")) {
    fail("EDGE_WINDOWS_AUDIT_PARTIAL", "audit JSONL ends without a complete newline-terminated line");
  }
  const lines = text.split("\n");
  // Last split element is empty because of trailing newline.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i === lines.length - 1) {
      // Trailing empty after final \n.
      if (line.length !== 0) {
        fail("EDGE_WINDOWS_AUDIT_PARTIAL", "audit JSONL trailing segment is incomplete");
      }
      break;
    }
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
    } catch {
      fail("EDGE_WINDOWS_AUDIT_CORRUPT", "audit JSONL contains a non-JSON line");
    }
    out.push(line);
  }
  return out;
}

function assertExactNoReparseDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (error) {
      throw mapNative(error, "EDGE_WINDOWS_UNSAFE_DIRECTORY");
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fail("EDGE_WINDOWS_UNSAFE_DIRECTORY", `${label} contains a reparse/non-directory`);
    }
  }
  if (fs.realpathSync(resolved) !== resolved) {
    fail("EDGE_WINDOWS_UNSAFE_DIRECTORY", `${label} is not its own realpath`);
  }
  return resolved;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new EdgeProtocolShadowWindowsNativeError(code, message, detail);
}

/**
 * Map Windows native / edge physical errors to closed edge protocol codes (no Win32 text).
 */
export function mapEdgeWindowsPhysicalError(error: unknown): { code: string; detail: string } {
  if (error instanceof EdgeProtocolShadowWindowsNativeError) {
    return { code: error.code, detail: error.code };
  }
  if (error instanceof WindowsNativeAddonError) {
    return { code: "EDGE_WINDOWS_NATIVE_UNAVAILABLE", detail: error.code };
  }
  if (error instanceof Error) {
    // Already-closed edge codes may pass through as Error messages from older paths.
    const msg = error.message;
    if (/^[A-Z0-9_]+$/.test(msg) || msg.startsWith("EDGE_") || msg.startsWith("WINDOWS_")) {
      return { code: msg.split(":")[0] || "EDGE_WINDOWS_IO_FAILED", detail: msg.split(":")[0] || "EDGE_WINDOWS_IO_FAILED" };
    }
  }
  return { code: "EDGE_WINDOWS_IO_FAILED", detail: "EDGE_WINDOWS_IO_FAILED" };
}

/**
 * Explicit test seam. Production code must not call install/run helpers.
 */
export const edgeWindowsNativeTestApi = Object.freeze({
  runWithAddon<T>(addon: WindowsNativeAddonModuleV1, fn: () => T): T {
    assertTestHooksEnabled("runWithAddon");
    requireCaps(addon);
    return testAddonAls.run(addon, fn);
  },
  async runWithAddonAsync<T>(addon: WindowsNativeAddonModuleV1, fn: () => Promise<T>): Promise<T> {
    assertTestHooksEnabled("runWithAddonAsync");
    requireCaps(addon);
    return testAddonAls.run(addon, fn);
  },
  installAddonOverride(addon: WindowsNativeAddonModuleV1 | null): void {
    assertTestHooksEnabled("installAddonOverride");
    if (addon) requireCaps(addon);
    testAddonOverride = addon;
  },
  resetProductionSingleton(): void {
    assertTestHooksEnabled("resetProductionSingleton");
    resetWindowsNativeAddonProductionLoadSingleton();
  },
  hasProductionSingleton(): boolean {
    assertTestHooksEnabled("hasProductionSingleton");
    return hasWindowsNativeAddonProductionLoadSingleton();
  },
});
