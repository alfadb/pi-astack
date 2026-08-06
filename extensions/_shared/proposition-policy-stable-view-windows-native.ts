/// <reference types="node" />
/**
 * Windows production physical layer for Policy stable-view durable publish/read.
 *
 * - Production: process-level zero-arg loadWindowsNativeAddon successful-load singleton
 *   (shared with retained/edge/DCC; failures never cached).
 * - Test seam: ALS + explicit deps under PI_ASTACK_ENABLE_TEST_HOOKS=1 (no unguarded global pin override;
 *   test injection does not write the process production singleton).
 * - latest is a protected private_rw regular pointer file: exact `bundles/<64 lowercase hex>\n`.
 * - Never uses symlink, TS lockfile, or ordinary Node rename for durable publish.
 * - Linux callers must not import this for the POSIX durable path.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  durableAtomicCreateFile,
  durableAtomicReplaceFile,
  ensureProtectedDirectory,
  hasWindowsNativeAddonProductionLoadSingleton,
  loadWindowsNativeAddon,
  mapAtomicFileError,
  mapProtectedDaclError,
  readProtectedFile,
  resetWindowsNativeAddonProductionLoadSingleton,
  verifyProtectedPath,
  WindowsNativeAddonError,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1,
  type WindowsNativeAddonModuleV1,
} from "./windows-native-addon";

/** Exact basename grammar for durableAtomicCreate/Replace temp of destination `latest`. */
export const PROPOSITION_POLICY_STABLE_VIEW_WINDOWS_LATEST_TEMP_PATTERN =
  /^\.latest\.pi-astack-tmp\.[0-9]+-[0-9]+\.tmp$/;
export const PROPOSITION_POLICY_STABLE_VIEW_WINDOWS_LATEST_TEMP_PREFIX =
  ".latest.pi-astack-tmp." as const;

export const PROPOSITION_POLICY_STABLE_VIEW_LATEST_POINTER_PATTERN =
  /^bundles\/([0-9a-f]{64})\n$/;
export const PROPOSITION_POLICY_STABLE_VIEW_LATEST_POINTER_MAX_BYTES = 80 as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_CAPS = Object.freeze([
  WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1,
] as const);

const testAddonAls = new AsyncLocalStorage<WindowsNativeAddonModuleV1>();
/** Process override only via gated test API (retained-lock style). Does not touch production singleton. */
let testAddonOverride: WindowsNativeAddonModuleV1 | null = null;

export class PropositionPolicyStableViewWindowsNativeError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyStableViewWindowsNativeError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface StableViewWindowsNativeDeps {
  /**
   * Test-only temp-package addon. Production ignores this field unless
   * PI_ASTACK_ENABLE_TEST_HOOKS=1 (explicit deps / ALS).
   */
  windowsNativeAddon?: WindowsNativeAddonModuleV1;
}

function assertTestHooksEnabled(label: string): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    fail("WINDOWS_STABLE_VIEW_TEST_HOOKS_DISABLED", `${label} requires PI_ASTACK_ENABLE_TEST_HOOKS=1`);
  }
}

function mapNative(error: unknown, fallbackCode: string): PropositionPolicyStableViewWindowsNativeError {
  if (error instanceof PropositionPolicyStableViewWindowsNativeError) return error;
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
  // Closed surface: never leak raw Win32 / native strings to reader reason paths.
  return new PropositionPolicyStableViewWindowsNativeError(
    fallbackCode,
    mapped.code,
    mapped.detail ? { ...mapped.detail } : { native_code: mapped.code },
  );
}

function requireCaps(addon: WindowsNativeAddonModuleV1): void {
  let caps: readonly string[];
  try {
    caps = addon.getCapabilities();
  } catch (error) {
    throw mapNative(error, "WINDOWS_STABLE_VIEW_NATIVE_UNAVAILABLE");
  }
  for (const required of REQUIRED_CAPS) {
    if (!caps.includes(required)) {
      fail("WINDOWS_STABLE_VIEW_NATIVE_UNAVAILABLE", "required native capabilities missing", {
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
    throw mapNative(error, "WINDOWS_STABLE_VIEW_NATIVE_UNAVAILABLE");
  }
}

/**
 * Resolve the Windows native addon for stable-view I/O.
 * Priority: explicit deps (test hooks) → ALS (test hooks) → process override (test hooks) → production cache.
 */
export function resolveStableViewWindowsNativeAddon(
  deps?: StableViewWindowsNativeDeps,
): WindowsNativeAddonModuleV1 {
  if (process.platform !== "win32") {
    fail("WINDOWS_STABLE_VIEW_UNSUPPORTED_PLATFORM", "stable-view windows native path requires win32");
  }
  if (deps?.windowsNativeAddon !== undefined) {
    assertTestHooksEnabled("windowsNativeAddon deps");
    requireCaps(deps.windowsNativeAddon);
    return deps.windowsNativeAddon;
  }
  const alsAddon = testAddonAls.getStore();
  if (alsAddon) {
    // Re-check at resolve time so unsetting the env mid-process disables ALS.
    assertTestHooksEnabled("testAddonAls");
    requireCaps(alsAddon);
    return alsAddon;
  }
  if (testAddonOverride) {
    // Re-check at resolve time so unsetting the env mid-process disables override.
    assertTestHooksEnabled("testAddonOverride");
    requireCaps(testAddonOverride);
    return testAddonOverride;
  }
  return loadProductionAddon();
}

export function encodeStableViewLatestPointer(bundleHash: string): Buffer {
  if (!SHA256_PATTERN.test(bundleHash)) {
    fail("WINDOWS_STABLE_VIEW_POINTER_INVALID", "bundle hash must be lowercase sha256 hex");
  }
  return Buffer.from(`bundles/${bundleHash}\n`, "utf8");
}

/**
 * Parse exact pointer bytes. Rejects absolute, backslash, `..`, multiline, whitespace, extra bytes.
 * Returns relative value without trailing newline: `bundles/<hash>`.
 */
export function parseStableViewLatestPointerBytes(data: Buffer): {
  latestValue: string;
  bundleHash: string;
} {
  if (data.byteLength === 0 || data.byteLength > PROPOSITION_POLICY_STABLE_VIEW_LATEST_POINTER_MAX_BYTES) {
    fail("WINDOWS_STABLE_VIEW_POINTER_INVALID", "latest pointer size is outside the closed envelope");
  }
  // Reject NULs and non-UTF8-ish control bytes early without leaking content.
  for (let i = 0; i < data.byteLength; i += 1) {
    const b = data[i]!;
    if (b === 0 || b === 0x0d || (b < 0x20 && b !== 0x0a) || b > 0x7e) {
      fail("WINDOWS_STABLE_VIEW_POINTER_INVALID", "latest pointer contains disallowed bytes");
    }
  }
  const text = data.toString("utf8");
  const match = PROPOSITION_POLICY_STABLE_VIEW_LATEST_POINTER_PATTERN.exec(text);
  if (!match) {
    fail("WINDOWS_STABLE_VIEW_POINTER_INVALID", "latest pointer encoding differs from closed contract");
  }
  const bundleHash = match[1]!;
  const latestValue = `bundles/${bundleHash}`;
  if (
    path.isAbsolute(latestValue)
    || latestValue.includes("\\")
    || latestValue.includes("..")
    || latestValue.includes("\n")
    || latestValue.includes("\r")
    || latestValue.includes(" ")
    || latestValue.includes("\t")
  ) {
    fail("WINDOWS_STABLE_VIEW_POINTER_INVALID", "latest pointer path components are unsafe");
  }
  return { latestValue, bundleHash };
}

export function ensureStableViewProtectedDirectory(
  addon: WindowsNativeAddonModuleV1,
  directory: string,
): string {
  try {
    // Native ensure creates new private_rw dirs or verifies existing ones.
    // Existing weak/tampered DACL must fail-closed — never auto-repair via setProtectedPath.
    return ensureProtectedDirectory(addon, directory);
  } catch (error) {
    throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_DIR_FAILED");
  }
}

export function verifyStableViewProtectedDirectory(
  addon: WindowsNativeAddonModuleV1,
  directory: string,
): void {
  try {
    verifyProtectedPath(addon, directory, "directory", "private_rw");
  } catch (error) {
    throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_DIR_FAILED");
  }
}

export function verifyStableViewProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
): void {
  try {
    verifyProtectedPath(addon, filePath, "file", "private_rw");
  } catch (error) {
    throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_FILE_FAILED");
  }
}

/** Ensure absolute directory chain under root; each leaf is private_rw. */
export function ensureStableViewProtectedDirectoryChain(
  addon: WindowsNativeAddonModuleV1,
  rootInput: string,
  targetInput: string,
): string {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("WINDOWS_STABLE_VIEW_PATH_ESCAPE", "publication path escapes abrain root");
  }
  assertExactNoReparseDirectory(root, "publication abrain root");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    ensureStableViewProtectedDirectory(addon, current);
  }
  return target;
}

function isNativeTooLarge(error: unknown): boolean {
  if (error instanceof WindowsNativeAddonError) {
    return error.code === "WINDOWS_NATIVE_ADDON_TOO_LARGE";
  }
  if (error instanceof PropositionPolicyStableViewWindowsNativeError) {
    return error.code === "WINDOWS_STABLE_VIEW_TOO_LARGE";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bTOO_LARGE\b/.test(message) || /WINDOWS_NATIVE_ADDON_TOO_LARGE/.test(message);
}

export function durableCreateProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  data: Buffer,
): "created" | "identical" | "collision" {
  try {
    const created = durableAtomicCreateFile(addon, filePath, data);
    if (created) {
      verifyStableViewProtectedFile(addon, filePath);
      return "created";
    }
    // First-create race / existing leaf: re-read and allow only exact same bytes.
    const existing = readProtectedFile(addon, filePath, Math.max(data.byteLength, 1));
    verifyStableViewProtectedFile(addon, filePath);
    if (existing.data.equals(data)) return "identical";
    return "collision";
  } catch (error) {
    if (isNativeTooLarge(error)) {
      // Existing leaf larger/different than expected create payload → not identical.
      return "collision";
    }
    throw mapNative(error, "WINDOWS_STABLE_VIEW_DURABLE_WRITE_FAILED");
  }
}

export function durableReplaceProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  data: Buffer,
): void {
  try {
    durableAtomicReplaceFile(addon, filePath, data);
    verifyStableViewProtectedFile(addon, filePath);
  } catch (error) {
    throw mapNative(error, "WINDOWS_STABLE_VIEW_DURABLE_WRITE_FAILED");
  }
}

export function readStableViewProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  filePath: string,
  maxBytes: number,
): Buffer {
  try {
    const result = readProtectedFile(addon, filePath, maxBytes);
    return result.data;
  } catch (error) {
    if (isNativeTooLarge(error)) {
      fail("WINDOWS_STABLE_VIEW_TOO_LARGE", "protected file exceeds maxBytes");
    }
    throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_READ_FAILED");
  }
}

/** Latest pointer read: size above the closed envelope is invalid, not tamper. */
export function readStableViewLatestPointerFile(
  addon: WindowsNativeAddonModuleV1,
  latestPath: string,
): Buffer {
  try {
    const result = readProtectedFile(
      addon,
      latestPath,
      PROPOSITION_POLICY_STABLE_VIEW_LATEST_POINTER_MAX_BYTES,
    );
    return result.data;
  } catch (error) {
    if (isNativeTooLarge(error)) {
      fail(
        "WINDOWS_STABLE_VIEW_POINTER_INVALID",
        "latest pointer size is outside the closed envelope",
      );
    }
    throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_READ_FAILED");
  }
}

export function publishStableViewLatestPointer(
  addon: WindowsNativeAddonModuleV1,
  latestPath: string,
  bundleHash: string,
  forceReplace: boolean,
): string {
  const payload = encodeStableViewLatestPointer(bundleHash);
  const latestValue = `bundles/${bundleHash}`;
  let exists = false;
  try {
    exists = fs.lstatSync(latestPath) != null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) {
    const status = durableCreateProtectedFile(addon, latestPath, payload);
    if (status === "collision") {
      // Explicit read-back: exact same bytes remain idempotent; any other leaf fails.
      let existing: Buffer;
      try {
        existing = readStableViewLatestPointerFile(addon, latestPath);
      } catch (error) {
        if (error instanceof PropositionPolicyStableViewWindowsNativeError
          && error.code === "WINDOWS_STABLE_VIEW_POINTER_INVALID") {
          fail("WINDOWS_STABLE_VIEW_POINTER_COLLISION", "latest pointer create collided with different bytes");
        }
        throw error;
      }
      if (!existing.equals(payload)) {
        fail("WINDOWS_STABLE_VIEW_POINTER_COLLISION", "latest pointer create collided with different bytes");
      }
    }
    // created / identical under race: fall through to exact read-back
  } else {
    // Fail closed on wrong type / reparse before native replace.
    let st: fs.Stats;
    try {
      st = fs.lstatSync(latestPath);
    } catch (error) {
      throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_READ_FAILED");
    }
    if (st.isSymbolicLink() || st.isDirectory() || !st.isFile()) {
      fail("WINDOWS_STABLE_VIEW_LATEST_UNSAFE", "latest exists as a non-regular file");
    }
    let current: Buffer;
    try {
      current = readStableViewLatestPointerFile(addon, latestPath);
    } catch (error) {
      throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_READ_FAILED");
    }
    const same = current.equals(payload);
    if (!same || forceReplace) {
      durableReplaceProtectedFile(addon, latestPath, payload);
    } else {
      verifyStableViewProtectedFile(addon, latestPath);
    }
  }
  const readBack = readStableViewLatestPointerFile(addon, latestPath);
  const parsed = parseStableViewLatestPointerBytes(readBack);
  if (parsed.latestValue !== latestValue || parsed.bundleHash !== bundleHash) {
    fail("WINDOWS_STABLE_VIEW_POINTER_INVALID", "latest pointer read-back differs from published value");
  }
  return latestValue;
}

export function captureStableViewLatestPointer(
  addon: WindowsNativeAddonModuleV1,
  latestPath: string,
): { latestValue: string; bundleHash: string; selectionPublishedAtMs: number } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(latestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail("WINDOWS_STABLE_VIEW_LATEST_MISSING", "stable-view latest is missing");
    }
    throw mapNative(error, "WINDOWS_STABLE_VIEW_PROTECTED_READ_FAILED");
  }
  if (st.isSymbolicLink() || st.isDirectory() || !st.isFile()) {
    fail("WINDOWS_STABLE_VIEW_LATEST_NOT_REGULAR", "stable-view latest is not a regular pointer file");
  }
  const data = readStableViewLatestPointerFile(addon, latestPath);
  const parsed = parseStableViewLatestPointerBytes(data);
  const selectionPublishedAtMs = Math.max(st.mtimeMs, st.ctimeMs);
  if (!Number.isFinite(selectionPublishedAtMs)) {
    fail("WINDOWS_STABLE_VIEW_SELECTION_TIME_INVALID", "latest publication time is invalid");
  }
  return { ...parsed, selectionPublishedAtMs };
}

function assertExactNoReparseDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fail("WINDOWS_STABLE_VIEW_UNSAFE_DIRECTORY", `${label} contains a reparse/non-directory`, { current });
    }
  }
  if (fs.realpathSync(resolved) !== resolved) {
    fail("WINDOWS_STABLE_VIEW_UNSAFE_DIRECTORY", `${label} is not its own realpath`);
  }
  return resolved;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyStableViewWindowsNativeError(code, message, detail);
}

/**
 * Explicit test seam. Production code must not call install/run helpers.
 * Retained lock may still use its own gated API for smoke.
 */
export const stableViewWindowsNativeTestApi = Object.freeze({
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
