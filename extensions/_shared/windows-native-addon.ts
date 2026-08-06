/// <reference types="node" />
/**
 * Windows native N-API addon — frozen core ABI v1 + versioned capabilities loader.
 *
 * Core ABI is frozen at 1. Function surface expands via versioned capabilities
 * (known set: atomic_file_tempdir_v1, atomic_file_v1, protected_dacl_v1, retained_directory_lock_v1).
 * Unadvertised capabilities must not be called. Runtime manifest capabilities
 * must exact-match native self-report.
 *
 * Pure TS cannot fully close hash→dlopen TOCTOU. Held binary fd is hashed before
 * load and re-hashed from the same fd after dlopen (exact manifest.binary_sha256),
 * then fd/path identity + self-identity. No path re-read after open.
 *
 * Threat boundary (loader contract, user-confirmed):
 * - Same TokenUser + administrator malicious rewrite is OUT of contract (DllMain /
 *   napi_register_module side effects run before any post-dlopen JS check).
 * - Other principals: fail-closed (package_rx + path/ACL gates).
 * - hash / pin / package_rx provide provenance binding and corruption detection,
 *   not a same-token race proof. No small native bootstrap.
 *
 * Production package_rx on the fixed package directory + binary + manifest closes
 * the cross-token rewrite boundary after successful dlopen + self-identity
 * (fail-closed WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID; no raw SID/path leak).
 * Test options loader does not force package ACL. No PowerShell hot path.
 *
 * Production zero-arg load is a process-level successful-load singleton
 * (globalThis; jiti multi-copy safe). Failures are never cached. Test options
 * loader does not touch the production singleton.
 *
 * Provenance pin constants live in windows-native-addon-pin.ts (package output;
 * not source-closure). Production pin remains null until package command writes
 * it — zero-parameter production load fails closed. No runtime download, no env
 * path override, no auto-compile.
 *
 * `__TEST.loadWindowsNativeAddon` and mutating test helpers require
 * PI_ASTACK_ENABLE_TEST_HOOKS=1. Pure parse helpers may be used ungated.
 *
 * retained_directory_lock_v1 uses zero-file Global named mutex (not DELETE
 * directory handle). Native errors use fixed RETAINED_DIRECTORY_LOCK_* prefixes;
 * map via mapRetainedDirectoryLockError / tryAcquireRetainedDirectoryLock —
 * production callers must not regex native strings.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 as PIN_MANIFEST_SHA256,
  WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT as PIN_SOURCE_COMMIT,
} from "./windows-native-addon-pin";

/** Frozen core ABI v1. Capabilities extend function surface without ABI bump. */
export const WINDOWS_NATIVE_ADDON_ABI = 1 as const;
export const WINDOWS_NATIVE_ADDON_MANIFEST_SCHEMA_VERSION =
  "windows-native-addon-manifest/v1" as const;
export const WINDOWS_NATIVE_ADDON_PLATFORM = "win32" as const;
export const WINDOWS_NATIVE_ADDON_ARCH = "x64" as const;
export const WINDOWS_NATIVE_ADDON_NAPI_VERSION = 9 as const;
export const WINDOWS_NATIVE_ADDON_MINIMUM_NODE = "22.19.0" as const;
export const WINDOWS_NATIVE_ADDON_TARGET = "win32-x64" as const;

/** Known capability ids (allowlist). Sorted. */
export const WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_TEMPDIR_V1 =
  "atomic_file_tempdir_v1" as const;
export const WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1 = "atomic_file_v1" as const;
export const WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1 = "protected_dacl_v1" as const;
export const WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1 =
  "retained_directory_lock_v1" as const;
/** Capabilities that must always be present in any valid manifest/binary. */
export const WINDOWS_NATIVE_ADDON_REQUIRED_CAPABILITIES = Object.freeze([
  WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1,
] as const);
/**
 * Known capability allowlist (sorted). Unknown ids are rejected.
 * Must always include required capabilities.
 */
export const WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES = Object.freeze([
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_TEMPDIR_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1,
] as const);
/** @deprecated Use WINDOWS_NATIVE_ADDON_REQUIRED_CAPABILITIES / KNOWN_CAPABILITIES. */
export const WINDOWS_NATIVE_ADDON_INITIAL_CAPABILITIES = WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES;
export type WindowsNativeAddonCapability =
  (typeof WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES)[number];

/**
 * Production provenance pin over the package-relative manifest raw bytes.
 * Re-exported from windows-native-addon-pin.ts (package output; not source closure).
 * Currently absent: production load fails closed with PROVENANCE_PIN_MISSING.
 * Must be a lowercase sha256 hex before any production wire-up.
 */
export const WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256: string | null = PIN_MANIFEST_SHA256;
/** Production source commit pin (package output). Null until package command writes it. */
export const WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT: string | null = PIN_SOURCE_COMMIT;

/** Fixed package-relative directory holding the win32-x64 binary + manifest. */
export const WINDOWS_NATIVE_ADDON_PACKAGE_RELATIVE_DIR = "native/windows/win32-x64" as const;
/** Fixed package-relative manifest path. Not overridable via env. */
export const WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH = "native/windows/win32-x64/manifest.json" as const;
/** Fixed binary basename. Manifest.binary_file must equal this exact name. */
export const WINDOWS_NATIVE_ADDON_BINARY_FILE = "pi-astack-windows-native.node" as const;
export const WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH =
  `${WINDOWS_NATIVE_ADDON_PACKAGE_RELATIVE_DIR}/${WINDOWS_NATIVE_ADDON_BINARY_FILE}` as const;

export const WINDOWS_NATIVE_ADDON_MANIFEST_KEYS = Object.freeze([
  "schema_version",
  "addon_abi",
  "platform",
  "arch",
  "napi_version",
  "minimum_node",
  "source_commit",
  "source_tree_sha256",
  "toolchain",
  "toolchain_id",
  "target",
  "binary_file",
  "binary_bytes",
  "binary_sha256",
  "build_id",
  "build_mode",
  "reproducibility",
  "native_tests",
  "clippy",
  "build_config_sha256",
  "capabilities",
] as const);

export type WindowsNativeAddonManifestKey = (typeof WINDOWS_NATIVE_ADDON_MANIFEST_KEYS)[number];

export const WINDOWS_NATIVE_ADDON_ERROR_CODES = Object.freeze([
  "WINDOWS_NATIVE_ADDON_UNSUPPORTED_PLATFORM",
  "WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED",
  "WINDOWS_NATIVE_ADDON_ARCH_MISMATCH",
  "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING",
  "WINDOWS_NATIVE_ADDON_MANIFEST_MISSING",
  "WINDOWS_NATIVE_ADDON_MANIFEST_INVALID",
  "WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH",
  "WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED",
  "WINDOWS_NATIVE_ADDON_BINARY_MISSING",
  "WINDOWS_NATIVE_ADDON_BINARY_SIZE_MISMATCH",
  "WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH",
  "WINDOWS_NATIVE_ADDON_BINARY_MUTATED",
  "WINDOWS_NATIVE_ADDON_ABI_MISMATCH",
  "WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH",
  "WINDOWS_NATIVE_ADDON_NAPI_MISMATCH",
  "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
  "WINDOWS_NATIVE_ADDON_CAPABILITY_UNADVERTISED",
  "WINDOWS_NATIVE_ADDON_LOAD_FAILED",
  // retained_directory_lock_v1 closed codes (mapped from native RETAINED_DIRECTORY_LOCK_* prefixes)
  "WINDOWS_NATIVE_ADDON_INVALID_PATH",
  "WINDOWS_NATIVE_ADDON_ANCESTOR_REPARSE",
  "WINDOWS_NATIVE_ADDON_REPARSE",
  "WINDOWS_NATIVE_ADDON_UNSUPPORTED_VOLUME",
  "WINDOWS_NATIVE_ADDON_NOT_DIRECTORY",
  "WINDOWS_NATIVE_ADDON_NOT_FOUND",
  "WINDOWS_NATIVE_ADDON_ACCESS_DENIED",
  "WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED",
  "WINDOWS_NATIVE_ADDON_MUTEX_FAILED",
  "WINDOWS_NATIVE_ADDON_MUTEX_NAMESPACE_DENIED",
  "WINDOWS_NATIVE_ADDON_DACL_INVALID",
  "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID",
  "WINDOWS_NATIVE_ADDON_WRONG_THREAD",
  "WINDOWS_NATIVE_ADDON_CLOSED",
  // protected_dacl_v1 / atomic_file_v1 shared closed codes
  "WINDOWS_NATIVE_ADDON_NOT_FILE",
  "WINDOWS_NATIVE_ADDON_INVALID_PROFILE",
  "WINDOWS_NATIVE_ADDON_INVALID_KIND",
  "WINDOWS_NATIVE_ADDON_IO_FAILED",
  "WINDOWS_NATIVE_ADDON_TOO_LARGE",
  "WINDOWS_NATIVE_ADDON_BUSY",
  "WINDOWS_NATIVE_ADDON_FAILED",
] as const);

export type WindowsNativeAddonErrorCode = (typeof WINDOWS_NATIVE_ADDON_ERROR_CODES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA1 = /^[0-9a-f]{40}$/;
const NODE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const BUILD_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOLCHAIN = /^[\x20-\x7E]{1,256}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_]*_v[0-9]+$/;
const MANIFEST_KEY_SET = new Set<string>(WINDOWS_NATIVE_ADDON_MANIFEST_KEYS);
const ERROR_CODE_SET = new Set<string>(WINDOWS_NATIVE_ADDON_ERROR_CODES);

export interface WindowsNativeAddonManifestV1 {
  readonly schema_version: typeof WINDOWS_NATIVE_ADDON_MANIFEST_SCHEMA_VERSION;
  readonly addon_abi: typeof WINDOWS_NATIVE_ADDON_ABI;
  readonly platform: typeof WINDOWS_NATIVE_ADDON_PLATFORM;
  readonly arch: typeof WINDOWS_NATIVE_ADDON_ARCH;
  readonly napi_version: typeof WINDOWS_NATIVE_ADDON_NAPI_VERSION;
  readonly minimum_node: typeof WINDOWS_NATIVE_ADDON_MINIMUM_NODE;
  readonly source_commit: string;
  readonly source_tree_sha256: string;
  readonly toolchain: string;
  /** sha256 of captured toolchain components (rustc/cargo/cl/link/VCTools/SDK/target). */
  readonly toolchain_id: string;
  readonly target: typeof WINDOWS_NATIVE_ADDON_TARGET;
  readonly binary_file: typeof WINDOWS_NATIVE_ADDON_BINARY_FILE;
  readonly binary_bytes: number;
  readonly binary_sha256: string;
  readonly build_id: string;
  /** development | production — package accepts only production. */
  readonly build_mode: "development" | "production";
  /** skipped | dual_clean_match — package accepts only dual_clean_match. */
  readonly reproducibility: "skipped" | "dual_clean_match";
  /** Native cargo test gate; package accepts only "passed". */
  readonly native_tests: "passed";
  /** Native clippy gate; package accepts only "passed". */
  readonly clippy: "passed";
  /** Lowercase sha256 of cargo config raw bytes bound into the binary. */
  readonly build_config_sha256: string;
  /** Exact sorted unique advertised capabilities. */
  readonly capabilities: readonly string[];
}

export interface WindowsNativeAddonBuildIdentityV1 {
  readonly addon_abi: typeof WINDOWS_NATIVE_ADDON_ABI;
  readonly build_id: string;
  readonly source_commit: string;
  readonly source_tree_sha256: string;
  readonly toolchain_id: string;
  readonly platform: typeof WINDOWS_NATIVE_ADDON_PLATFORM;
  readonly arch: typeof WINDOWS_NATIVE_ADDON_ARCH;
  readonly napi_version: typeof WINDOWS_NATIVE_ADDON_NAPI_VERSION;
  readonly target: typeof WINDOWS_NATIVE_ADDON_TARGET;
  readonly build_mode: "development" | "production";
  readonly reproducibility: "skipped" | "dual_clean_match";
  readonly native_tests: "passed";
  readonly clippy: "passed";
  readonly build_config_sha256: string;
}

/** Identity recorded by retained_directory_lock_v1 (VolumeSerialNumber u64 hex16 + FILE_ID_128 hex32). */
export interface WindowsNativeRetainedDirectoryLockIdentity {
  readonly path: string;
  /** VolumeSerialNumber u64 as 16 lowercase hex digits. */
  readonly volume_serial_number: string;
  /** FILE_ID_128 as 32 lowercase hex digits. */
  readonly file_id: string;
}

/**
 * Lease for a held retained directory lock. Mutex HANDLE is never exposed as a JS number.
 * close() is idempotent on the owner thread.
 * Wrong-thread close → WINDOWS_NATIVE_ADDON_WRONG_THREAD and the lease is retained
 * (no Release/Close/owner-TLS clear).
 * Owner-thread Drop/FinalizationRegistry close releases normally.
 * Wrong-thread Drop is fail-closed: native leaks the raw HANDLE(s) and does not
 * touch owner TLS — never destroys the named mutex via last-handle CloseHandle.
 * Process/owner-thread exit abandons the mutex for reacquire.
 * acquired_after_abandon is true when Wait returned WAIT_ABANDONED.
 */
export interface WindowsNativeRetainedDirectoryLockLease {
  readonly status: "ACQUIRED" | "CLOSED";
  readonly identity: WindowsNativeRetainedDirectoryLockIdentity;
  /** True when this acquire observed WAIT_ABANDONED (previous owner died). */
  readonly acquired_after_abandon: boolean;
  assertIdentity(): void;
  close(): void;
}

export type WindowsNativeProtectedProfile = "private_rw" | "package_rx";
export type WindowsNativePathKind = "file" | "directory";

export interface WindowsNativeProtectedFileIdentity {
  readonly path: string;
  readonly volume_serial_number: string;
  readonly file_id: string;
  readonly size: number;
}

export interface WindowsNativeProtectedFileRead {
  readonly data: Buffer;
  readonly identity: WindowsNativeProtectedFileIdentity;
}

/**
 * Frozen core ABI v1 module surface + versioned capabilities.
 * Capabilities may add methods without changing addon_abi.
 */
export interface WindowsNativeAddonModuleV1 {
  readonly addon_abi: typeof WINDOWS_NATIVE_ADDON_ABI;
  getBuildIdentity(): WindowsNativeAddonBuildIdentityV1;
  /** Exact sorted unique advertised capabilities. */
  getCapabilities(): readonly string[];
  /**
   * retained_directory_lock_v1: try to lock the named directory itself.
   * Returns lease on ACQUIRED, null on BUSY, throws fail-closed on other errors.
   * Must not be called unless capability is advertised.
   */
  tryAcquireRetainedDirectoryLock(directoryPath: string): WindowsNativeRetainedDirectoryLockLease | null;
  /** protected_dacl_v1 */
  ensureProtectedDirectory(path: string): string;
  setProtectedPath(path: string, expectedKind: WindowsNativePathKind | string, profile: WindowsNativeProtectedProfile | string): string;
  verifyProtectedPath(path: string, expectedKind: WindowsNativePathKind | string, profile: WindowsNativeProtectedProfile | string): string;
  /** atomic_file_v1 */
  durableAtomicCreateFile(path: string, data: Buffer): boolean;
  durableAtomicReplaceFile(path: string, data: Buffer): void;
  durableAppendFile(path: string, data: Buffer): void;
  readProtectedFile(path: string, maxBytes: number): WindowsNativeProtectedFileRead;
  /** atomic_file_tempdir_v1 — explicit staging directory; not a silent change to same-dir create. */
  durableAtomicCreateFileWithTempDirectory(
    path: string,
    data: Buffer,
    tempDirectory: string,
  ): boolean;
}

export interface WindowsNativeAddonLoadResult {
  readonly status: "loaded";
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly binaryPath: string;
  readonly manifest: WindowsNativeAddonManifestV1;
  readonly identity: WindowsNativeAddonBuildIdentityV1;
  readonly capabilities: readonly string[];
  readonly addon: WindowsNativeAddonModuleV1;
}

/**
 * File identity for best-effort TOCTOU guards (fd/path same-object checks).
 *
 * - `dev` / `ino` are bigint (lossless; never Number-truncated).
 * - `size` is a non-negative safe integer (binary ceiling keeps it safe).
 * - `mtimeMs` is optional diagnostic only — NOT part of security equality.
 * Error `detail` snapshots must JSON-serialize (bigint → decimal string).
 */
export interface WindowsNativeAddonFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  /** Diagnostic only; not used by identityEquals. */
  readonly mtimeMs?: number;
  isFile(): boolean;
}

export interface WindowsNativeAddonLstat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  readonly size: number;
}

/**
 * Filesystem seam. Production uses node:fs. Tests may inject to simulate symlink /
 * mutation / missing files. Must never be populated from environment variables.
 */
export interface WindowsNativeAddonFs {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string): Buffer;
  statSync(filePath: string): WindowsNativeAddonFileIdentity;
  lstatSync(filePath: string): WindowsNativeAddonLstat;
  realpathSync(filePath: string): string;
  openSync(filePath: string, flags: "r"): number;
  fstatSync(fd: number): WindowsNativeAddonFileIdentity;
  /** Full-file read via fd using positional reads (must not depend on fd cursor). */
  readFileFdSync(fd: number): Buffer;
  closeSync(fd: number): void;
}

/**
 * Test-only load options. Production `loadWindowsNativeAddon()` accepts zero parameters.
 * Path/pin seams must never be populated from environment variables by this module.
 * Options loader does not force package_rx ACL (production zero-arg does).
 */
export interface WindowsNativeAddonLoadOptions {
  /** Absolute package root. Defaults to repo root resolved from this module. */
  packageRoot?: string;
  /** Injected platform. Defaults to process.platform. */
  platform?: NodeJS.Platform | string;
  /** Injected arch. Defaults to process.arch. */
  arch?: string;
  /** Injected Node version string. Defaults to process.versions.node. */
  nodeVersion?: string;
  /**
   * Expected sha256 of the raw manifest bytes. When omitted, production pin
   * `WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256` is used (currently null → fail-closed).
   */
  expectedManifestSha256?: string | null;
  /** Injected filesystem. Defaults to node:fs subset. */
  fs?: WindowsNativeAddonFs;
  /** Injected native loader. Defaults to createRequire(packageRoot/package.json)(absoluteBinaryPath). */
  loadNativeModule?: (absoluteBinaryPath: string) => unknown;
}

interface WindowsNativeAddonLoadInternalOptions {
  /** Production zero-arg path verifies package dir/binary/manifest package_rx. */
  enforcePackageAcl?: boolean;
}

export class WindowsNativeAddonError extends Error {
  readonly code: WindowsNativeAddonErrorCode;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: WindowsNativeAddonErrorCode, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "WindowsNativeAddonError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export function isWindowsNativeAddonErrorCode(value: unknown): value is WindowsNativeAddonErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

export function resolveWindowsNativeAddonPackageRoot(): string {
  // jiti loads this module as CJS, so __dirname is the portable package-relative anchor.
  return path.resolve(__dirname, "..", "..");
}

export function resolveWindowsNativeAddonPaths(packageRoot: string): {
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly binaryPath: string;
  readonly relativeManifestPath: typeof WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH;
  readonly relativeBinaryPath: typeof WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH;
} {
  const root = path.resolve(packageRoot);
  return Object.freeze({
    packageRoot: root,
    manifestPath: path.join(root, ...WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH.split("/")),
    binaryPath: path.join(root, ...WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH.split("/")),
    relativeManifestPath: WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH,
    relativeBinaryPath: WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH,
  });
}

const KNOWN_CAPABILITY_SET = new Set<string>(WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES);

/**
 * Validate capabilities array: non-empty, pattern, unique, sorted, known allowlist,
 * must contain retained_directory_lock_v1. Extensible — not frozen to a single exact const.
 */
export function validateWindowsNativeAddonCapabilities(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "capabilities must be a non-empty array");
  }
  const values: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "string" || !CAPABILITY_ID.test(item)) {
      fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "capabilities entries must match ^[a-z][a-z0-9_]*_v[0-9]+$", {
        index: i,
        value: item,
      });
    }
    if (!KNOWN_CAPABILITY_SET.has(item)) {
      fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "capabilities entry is not in the known allowlist", {
        index: i,
        value: item,
        known: [...WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES],
      });
    }
    values.push(item);
  }
  const sorted = [...values].sort();
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== sorted[i]) {
      fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "capabilities must be sorted unique", {
        actual: values,
        expectedSorted: sorted,
      });
    }
    if (i > 0 && values[i] === values[i - 1]) {
      fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "capabilities must be unique", { actual: values });
    }
  }
  for (const required of WINDOWS_NATIVE_ADDON_REQUIRED_CAPABILITIES) {
    if (!values.includes(required)) {
      fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "capabilities must contain required capability", {
        required,
        actual: values,
      });
    }
  }
  return Object.freeze([...values]);
}

export function validateWindowsNativeAddonManifest(raw: unknown): WindowsNativeAddonManifestV1 {
  if (!isPlainObject(raw)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "manifest must be a JSON object");
  }
  const keys = Object.keys(raw);
  const unexpected = keys.filter((key) => !MANIFEST_KEY_SET.has(key)).sort();
  if (unexpected.length > 0) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "manifest contains foreign or extra keys", { unexpected });
  }
  const missing = WINDOWS_NATIVE_ADDON_MANIFEST_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(raw, key));
  if (missing.length > 0) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "manifest is missing required keys", { missing: [...missing] });
  }

  const schema_version = requireConst(raw, "schema_version", WINDOWS_NATIVE_ADDON_MANIFEST_SCHEMA_VERSION);
  const addon_abi = requireConst(raw, "addon_abi", WINDOWS_NATIVE_ADDON_ABI);
  const platform = requireConst(raw, "platform", WINDOWS_NATIVE_ADDON_PLATFORM);
  const arch = requireConst(raw, "arch", WINDOWS_NATIVE_ADDON_ARCH);
  const napi_version = requireConst(raw, "napi_version", WINDOWS_NATIVE_ADDON_NAPI_VERSION);
  const minimum_node = requireString(raw, "minimum_node");
  // Strict equality with the frozen floor; prerelease suffixes are not accepted.
  if (minimum_node !== WINDOWS_NATIVE_ADDON_MINIMUM_NODE) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "minimum_node must equal the frozen matrix floor 22.19.0 exactly", {
      minimum_node,
      expected: WINDOWS_NATIVE_ADDON_MINIMUM_NODE,
    });
  }
  const source_commit = requireString(raw, "source_commit");
  if (!GIT_SHA1.test(source_commit)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "source_commit must be a 40-char lowercase git SHA-1", { source_commit });
  }
  const source_tree_sha256 = requireString(raw, "source_tree_sha256");
  if (!SHA256_HEX.test(source_tree_sha256)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "source_tree_sha256 must be lowercase sha256 hex", { source_tree_sha256 });
  }
  const toolchain = requireString(raw, "toolchain");
  if (!TOOLCHAIN.test(toolchain)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "toolchain must be a printable ASCII string of length 1..256", { toolchain });
  }
  const toolchain_id = requireString(raw, "toolchain_id");
  if (!SHA256_HEX.test(toolchain_id)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "toolchain_id must be lowercase sha256 hex", { toolchain_id });
  }
  const target = requireConst(raw, "target", WINDOWS_NATIVE_ADDON_TARGET);
  const binary_file = requireConst(raw, "binary_file", WINDOWS_NATIVE_ADDON_BINARY_FILE);
  const binary_bytes = requirePositiveInt(raw, "binary_bytes");
  if (binary_bytes > 64 * 1024 * 1024) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "binary_bytes exceeds hard ceiling (64 MiB)", { binary_bytes });
  }
  const binary_sha256 = requireString(raw, "binary_sha256");
  if (!SHA256_HEX.test(binary_sha256)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "binary_sha256 must be lowercase sha256 hex", { binary_sha256 });
  }
  const build_id = requireString(raw, "build_id");
  if (!BUILD_ID.test(build_id)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "build_id must match ^[A-Za-z0-9._:-]{1,128}$", { build_id });
  }
  const build_mode = requireString(raw, "build_mode");
  if (build_mode !== "development" && build_mode !== "production") {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "build_mode must be development|production", { build_mode });
  }
  const reproducibility = requireString(raw, "reproducibility");
  if (reproducibility !== "skipped" && reproducibility !== "dual_clean_match") {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "reproducibility must be skipped|dual_clean_match", { reproducibility });
  }
  const native_tests = requireString(raw, "native_tests");
  if (native_tests !== "passed") {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "native_tests must be passed", { native_tests });
  }
  const clippy = requireString(raw, "clippy");
  if (clippy !== "passed") {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "clippy must be passed", { clippy });
  }
  const build_config_sha256 = requireString(raw, "build_config_sha256");
  if (!SHA256_HEX.test(build_config_sha256)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "build_config_sha256 must be lowercase sha256 hex", { build_config_sha256 });
  }
  const capabilities = validateWindowsNativeAddonCapabilities(raw.capabilities);

  return Object.freeze({
    schema_version,
    addon_abi,
    platform,
    arch,
    napi_version,
    minimum_node: WINDOWS_NATIVE_ADDON_MINIMUM_NODE,
    source_commit,
    source_tree_sha256,
    toolchain,
    toolchain_id,
    target,
    binary_file,
    binary_bytes,
    binary_sha256,
    build_id,
    build_mode: build_mode as "development" | "production",
    reproducibility: reproducibility as "skipped" | "dual_clean_match",
    native_tests: "passed" as const,
    clippy: "passed" as const,
    build_config_sha256,
    capabilities,
  });
}

/** Native capability error prefixes → WindowsNativeAddonErrorCode closed set. */
const NATIVE_LOCK_ERROR_PREFIX = "RETAINED_DIRECTORY_LOCK_";
const NATIVE_DACL_ERROR_PREFIX = "PROTECTED_DACL_";
const NATIVE_ATOMIC_ERROR_PREFIX = "ATOMIC_FILE_";
const NATIVE_COMMON_CODE_MAP = Object.freeze({
  INVALID_PATH: "WINDOWS_NATIVE_ADDON_INVALID_PATH",
  ANCESTOR_REPARSE: "WINDOWS_NATIVE_ADDON_ANCESTOR_REPARSE",
  REPARSE: "WINDOWS_NATIVE_ADDON_REPARSE",
  UNSUPPORTED_VOLUME: "WINDOWS_NATIVE_ADDON_UNSUPPORTED_VOLUME",
  NOT_DIRECTORY: "WINDOWS_NATIVE_ADDON_NOT_DIRECTORY",
  NOT_FILE: "WINDOWS_NATIVE_ADDON_NOT_FILE",
  NOT_FOUND: "WINDOWS_NATIVE_ADDON_NOT_FOUND",
  ACCESS_DENIED: "WINDOWS_NATIVE_ADDON_ACCESS_DENIED",
  IDENTITY_CHANGED: "WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED",
  MUTEX_FAILED: "WINDOWS_NATIVE_ADDON_MUTEX_FAILED",
  MUTEX_NAMESPACE_DENIED: "WINDOWS_NATIVE_ADDON_MUTEX_NAMESPACE_DENIED",
  DACL_INVALID: "WINDOWS_NATIVE_ADDON_DACL_INVALID",
  WRONG_THREAD: "WINDOWS_NATIVE_ADDON_WRONG_THREAD",
  CLOSED: "WINDOWS_NATIVE_ADDON_CLOSED",
  INVALID_PROFILE: "WINDOWS_NATIVE_ADDON_INVALID_PROFILE",
  INVALID_KIND: "WINDOWS_NATIVE_ADDON_INVALID_KIND",
  IO_FAILED: "WINDOWS_NATIVE_ADDON_IO_FAILED",
  TOO_LARGE: "WINDOWS_NATIVE_ADDON_TOO_LARGE",
  BUSY: "WINDOWS_NATIVE_ADDON_BUSY",
  FAILED: "WINDOWS_NATIVE_ADDON_FAILED",
} as const);
/** @deprecated alias kept for call-site grep compatibility */
const NATIVE_LOCK_CODE_MAP = NATIVE_COMMON_CODE_MAP;

function mapPrefixedNativeError(
  error: unknown,
  prefix: string,
  fallback: WindowsNativeAddonErrorCode,
): WindowsNativeAddonError {
  if (error instanceof WindowsNativeAddonError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const stripped = message.replace(/^(?:[A-Za-z_$][\w$]*Error:\s*)+/, "");
  if (stripped.startsWith(prefix)) {
    const after = stripped.slice(prefix.length);
    const codeToken = after.split(/[:\s]/, 1)[0] || "";
    const mapped = (NATIVE_COMMON_CODE_MAP as Record<string, WindowsNativeAddonErrorCode>)[codeToken];
    if (mapped) {
      return new WindowsNativeAddonError(mapped, message);
    }
  }
  return new WindowsNativeAddonError(fallback, message);
}

/**
 * Map a thrown native/JS error into WindowsNativeAddonError closed codes.
 * Production callers must not regex native strings — use this mapping only.
 * Prefix-anchored: native code must appear at the start of the message after
 * optional Error wrapper prefixes (not a free-form substring search).
 */
export function mapRetainedDirectoryLockError(error: unknown): WindowsNativeAddonError {
  return mapPrefixedNativeError(error, NATIVE_LOCK_ERROR_PREFIX, "WINDOWS_NATIVE_ADDON_MUTEX_FAILED");
}

export function mapProtectedDaclError(error: unknown): WindowsNativeAddonError {
  return mapPrefixedNativeError(error, NATIVE_DACL_ERROR_PREFIX, "WINDOWS_NATIVE_ADDON_FAILED");
}

export function mapAtomicFileError(error: unknown): WindowsNativeAddonError {
  // Unknown / unmapped atomic errors fall back to FAILED (not IO_FAILED).
  return mapPrefixedNativeError(error, NATIVE_ATOMIC_ERROR_PREFIX, "WINDOWS_NATIVE_ADDON_FAILED");
}

/**
 * Module-level FR so plain lease wrappers can release native leases on GC when
 * the callback runs on the owner thread. Wrong-thread close fails closed (lease
 * retained); native wrong-thread Drop also fails closed (leaks HANDLE / keeps
 * PROCESS_HELD) rather than destroying the named mutex.
 */
const LEASE_GC_REGISTRY: FinalizationRegistry<{ release: () => void }> | null =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((token: { release: () => void }) => {
        try {
          token.release();
        } catch {
          // Wrong-thread or other close failure: leave native lease held
          // (fail-closed). Process/thread exit still abandons the mutex.
        }
      })
    : null;

function wrapLease(raw: WindowsNativeRetainedDirectoryLockLease): WindowsNativeRetainedDirectoryLockLease {
  // Identity normalize failure must close the raw native lease (no leak).
  let identity: WindowsNativeRetainedDirectoryLockIdentity;
  let acquiredAfterAbandon: boolean;
  try {
    identity = normalizeLockIdentity(raw.identity);
    if (typeof raw.acquired_after_abandon !== "boolean") {
      fail(
        "WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED",
        "lock acquired_after_abandon must be a boolean",
      );
    }
    acquiredAfterAbandon = raw.acquired_after_abandon;
  } catch (error) {
    try {
      raw.close();
    } catch {
      // Best-effort close of raw lease after identity contract failure.
    }
    throw error instanceof WindowsNativeAddonError ? error : mapRetainedDirectoryLockError(error);
  }
  let closed = false;
  const token = {
    release: () => {
      if (closed) return;
      try {
        // Only mark closed after successful owner-thread close. Wrong-thread
        // close / ReleaseMutex failure must leave the lease retryable.
        raw.close();
        closed = true;
      } catch (error) {
        throw mapRetainedDirectoryLockError(error);
      }
    },
  };
  const wrapper: WindowsNativeRetainedDirectoryLockLease = {
    get status() {
      return closed ? "CLOSED" : raw.status;
    },
    get identity() {
      return identity;
    },
    get acquired_after_abandon() {
      return acquiredAfterAbandon;
    },
    assertIdentity() {
      if (closed) {
        fail("WINDOWS_NATIVE_ADDON_CLOSED", "lease already closed");
      }
      try {
        raw.assertIdentity();
      } catch (error) {
        throw mapRetainedDirectoryLockError(error);
      }
    },
    close() {
      try {
        token.release();
      } catch (error) {
        throw error instanceof WindowsNativeAddonError ? error : mapRetainedDirectoryLockError(error);
      }
    },
  };
  // Plain-object wrapper is GC-eligible. Held token (not the wrapper) keeps the napi
  // Class alive until FR runs, then releases on the event-loop thread.
  LEASE_GC_REGISTRY?.register(wrapper, token);
  return wrapper;
}

function normalizeLockIdentity(raw: unknown): WindowsNativeRetainedDirectoryLockIdentity {
  if (!raw || typeof raw !== "object") {
    fail("WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED", "lock identity must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const pathValue = obj.path;
  const volume = obj.volume_serial_number;
  const fileId = obj.file_id;
  if (typeof pathValue !== "string" || !pathValue) {
    fail("WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED", "lock identity.path must be a non-empty string");
  }
  if (typeof volume !== "string" || !/^[0-9a-f]{16}$/.test(volume)) {
    fail(
      "WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED",
      "lock identity.volume_serial_number must be 16 lowercase hex digits",
      { volume },
    );
  }
  if (typeof fileId !== "string" || !/^[0-9a-f]{32}$/.test(fileId)) {
    fail(
      "WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED",
      "lock identity.file_id must be 32 lowercase hex digits",
      { fileId },
    );
  }
  return Object.freeze({
    path: pathValue,
    volume_serial_number: volume,
    file_id: fileId,
  });
}

/**
 * Call retained_directory_lock_v1 only when advertised. Unadvertised → fail-closed.
 * Native fixed-prefix errors are mapped to WindowsNativeAddonError closed codes.
 * BUSY remains null (not an error).
 */
export function tryAcquireRetainedDirectoryLock(
  addon: WindowsNativeAddonModuleV1,
  directoryPath: string,
): WindowsNativeRetainedDirectoryLockLease | null {
  const caps = normalizeCapabilities(addon.getCapabilities());
  if (!caps.includes(WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1)) {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_UNADVERTISED",
      "retained_directory_lock_v1 is not advertised; refusing call",
      { capabilities: caps },
    );
  }
  if (typeof addon.tryAcquireRetainedDirectoryLock !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability retained_directory_lock_v1 advertised but tryAcquireRetainedDirectoryLock is missing",
    );
  }
  let result: WindowsNativeRetainedDirectoryLockLease | null;
  try {
    result = addon.tryAcquireRetainedDirectoryLock(directoryPath);
  } catch (error) {
    throw mapRetainedDirectoryLockError(error);
  }
  if (result == null) return null;
  return wrapLease(result);
}

function requireCapability(addon: WindowsNativeAddonModuleV1, capability: string): void {
  const caps = normalizeCapabilities(addon.getCapabilities());
  if (!caps.includes(capability)) {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_UNADVERTISED",
      `${capability} is not advertised; refusing call`,
      { capabilities: caps },
    );
  }
}

/** protected_dacl_v1: create leaf private_rw dir or verify existing. */
export function ensureProtectedDirectory(addon: WindowsNativeAddonModuleV1, pathValue: string): string {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1);
  if (typeof addon.ensureProtectedDirectory !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability protected_dacl_v1 advertised but ensureProtectedDirectory is missing",
    );
  }
  try {
    return addon.ensureProtectedDirectory(pathValue);
  } catch (error) {
    throw mapProtectedDaclError(error);
  }
}

/** protected_dacl_v1: set owner/group/protected exact DACL on existing path then re-verify. */
export function setProtectedPath(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  expectedKind: WindowsNativePathKind | string,
  profile: WindowsNativeProtectedProfile | string,
): string {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1);
  if (typeof addon.setProtectedPath !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability protected_dacl_v1 advertised but setProtectedPath is missing",
    );
  }
  try {
    return addon.setProtectedPath(pathValue, expectedKind, profile);
  } catch (error) {
    throw mapProtectedDaclError(error);
  }
}

/** protected_dacl_v1: verify only. */
export function verifyProtectedPath(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  expectedKind: WindowsNativePathKind | string,
  profile: WindowsNativeProtectedProfile | string,
): string {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1);
  if (typeof addon.verifyProtectedPath !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability protected_dacl_v1 advertised but verifyProtectedPath is missing",
    );
  }
  try {
    return addon.verifyProtectedPath(pathValue, expectedKind, profile);
  } catch (error) {
    throw mapProtectedDaclError(error);
  }
}

/** atomic_file_v1: durable same-dir atomic create (no-replace). false = collision. */
export function durableAtomicCreateFile(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  data: Buffer,
): boolean {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1);
  if (typeof addon.durableAtomicCreateFile !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability atomic_file_v1 advertised but durableAtomicCreateFile is missing",
    );
  }
  try {
    return addon.durableAtomicCreateFile(pathValue, data);
  } catch (error) {
    throw mapAtomicFileError(error);
  }
}

/**
 * atomic_file_tempdir_v1: durable no-replace create with explicit same-volume staging directory.
 * Does not alter durableAtomicCreateFile same-dir temp semantics. false = collision.
 */
export function durableAtomicCreateFileWithTempDirectory(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  data: Buffer,
  tempDirectory: string,
): boolean {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_TEMPDIR_V1);
  if (typeof addon.durableAtomicCreateFileWithTempDirectory !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability atomic_file_tempdir_v1 advertised but durableAtomicCreateFileWithTempDirectory is missing",
    );
  }
  try {
    return addon.durableAtomicCreateFileWithTempDirectory(pathValue, data, tempDirectory);
  } catch (error) {
    throw mapAtomicFileError(error);
  }
}

/** atomic_file_v1: durable same-dir atomic replace. */
export function durableAtomicReplaceFile(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  data: Buffer,
): void {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1);
  if (typeof addon.durableAtomicReplaceFile !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability atomic_file_v1 advertised but durableAtomicReplaceFile is missing",
    );
  }
  try {
    addon.durableAtomicReplaceFile(pathValue, data);
  } catch (error) {
    throw mapAtomicFileError(error);
  }
}

/** atomic_file_v1: protected single-record append under mutex. */
export function durableAppendFile(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  data: Buffer,
): void {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1);
  if (typeof addon.durableAppendFile !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability atomic_file_v1 advertised but durableAppendFile is missing",
    );
  }
  try {
    addon.durableAppendFile(pathValue, data);
  } catch (error) {
    throw mapAtomicFileError(error);
  }
}

/** atomic_file_v1: one-handle protected read with ceiling + identity stability. */
export function readProtectedFile(
  addon: WindowsNativeAddonModuleV1,
  pathValue: string,
  maxBytes: number,
): WindowsNativeProtectedFileRead {
  requireCapability(addon, WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1);
  if (typeof addon.readProtectedFile !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability atomic_file_v1 advertised but readProtectedFile is missing",
    );
  }
  try {
    const raw = addon.readProtectedFile(pathValue, maxBytes);
    if (!raw || typeof raw !== "object" || !Buffer.isBuffer((raw as WindowsNativeProtectedFileRead).data)) {
      fail("WINDOWS_NATIVE_ADDON_IO_FAILED", "readProtectedFile must return { data: Buffer, identity }");
    }
    const identity = (raw as WindowsNativeProtectedFileRead).identity;
    if (!identity || typeof identity.path !== "string" || typeof identity.file_id !== "string") {
      fail("WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED", "readProtectedFile identity invalid");
    }
    return raw as WindowsNativeProtectedFileRead;
  } catch (error) {
    throw error instanceof WindowsNativeAddonError ? error : mapAtomicFileError(error);
  }
}

/** Process-level production successful-load cache (jiti multi-copy safe). */
const PRODUCTION_LOAD_STATE_KEY = Symbol.for("pi-astack.windowsNativeAddon.productionLoad.v1");

type ProductionLoadState = {
  /** Only successful zero-arg production loads are retained. Failures stay null. */
  loaded: WindowsNativeAddonLoadResult | null;
  /** Observable: how many successful zero-arg loads were performed (not cache hits). */
  successfulLoadCount: number;
  /** Observable: how many zero-arg load attempts ran the full load path (excludes pure cache hits). */
  attemptCount: number;
};

function productionLoadState(): ProductionLoadState {
  const g = globalThis as Record<PropertyKey, unknown>;
  const existing = g[PRODUCTION_LOAD_STATE_KEY] as ProductionLoadState | undefined;
  if (
    existing
    && typeof existing === "object"
    && Object.prototype.hasOwnProperty.call(existing, "loaded")
    && typeof (existing as ProductionLoadState).successfulLoadCount === "number"
    && typeof (existing as ProductionLoadState).attemptCount === "number"
  ) {
    return existing;
  }
  const created: ProductionLoadState = { loaded: null, successfulLoadCount: 0, attemptCount: 0 };
  g[PRODUCTION_LOAD_STATE_KEY] = created;
  return created;
}

/**
 * Production zero-arg load requires the full current known capability set so a
 * schema-valid incomplete object is never process-cached as a successful production load.
 */
function assertProductionCapabilitiesComplete(capabilities: readonly string[]): void {
  const missing = WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES.filter((c) => !capabilities.includes(c));
  if (missing.length > 0) {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "production load requires all known capabilities; refusing incomplete production cache",
      { missing, actual: [...capabilities], required: [...WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES] },
    );
  }
}

/**
 * Production entry: zero parameters. Uses process defaults + production pin.
 * After dlopen + self-identity, verifies package dir/binary/manifest package_rx.
 * Successful loads are process-level singleton-cached (globalThis); failures are
 * never cached so a later pin/install in-process can retry. Production contract
 * requires all four known capabilities before caching. All seams live on
 * `__TEST.loadWindowsNativeAddon(options)` (test-hooks gated; does not use or
 * pollute the production singleton).
 */
export function loadWindowsNativeAddon(): WindowsNativeAddonLoadResult {
  const state = productionLoadState();
  if (state.loaded) return state.loaded;
  state.attemptCount += 1;
  // Do not cache failures — only assign after a successful return path with full caps.
  const loaded = loadWindowsNativeAddonWithOptions({}, { enforcePackageAcl: true });
  assertProductionCapabilitiesComplete(loaded.capabilities);
  state.loaded = loaded;
  state.successfulLoadCount += 1;
  return loaded;
}

/**
 * Test-hooks gated: drop process-level production successful-load singleton.
 * Production consumers' test APIs may call this; production runtime must not.
 */
export function resetWindowsNativeAddonProductionLoadSingleton(): void {
  assertWindowsNativeAddonTestHooks("resetWindowsNativeAddonProductionLoadSingleton");
  const state = productionLoadState();
  state.loaded = null;
  // Counters are intentionally retained across reset so tests can observe retry.
}

/** Test-hooks gated: whether the process production successful-load singleton is held. */
export function hasWindowsNativeAddonProductionLoadSingleton(): boolean {
  assertWindowsNativeAddonTestHooks("hasWindowsNativeAddonProductionLoadSingleton");
  return productionLoadState().loaded != null;
}

/** Test-hooks gated: successful zero-arg load count (excludes cache hits). */
export function getWindowsNativeAddonProductionSuccessfulLoadCount(): number {
  assertWindowsNativeAddonTestHooks("getWindowsNativeAddonProductionSuccessfulLoadCount");
  return productionLoadState().successfulLoadCount;
}

/** Test-hooks gated: zero-arg full-path attempt count (excludes pure cache hits). */
export function getWindowsNativeAddonProductionLoadAttemptCount(): number {
  assertWindowsNativeAddonTestHooks("getWindowsNativeAddonProductionLoadAttemptCount");
  return productionLoadState().attemptCount;
}

function loadWindowsNativeAddonWithOptions(
  options: WindowsNativeAddonLoadOptions = {},
  internal: WindowsNativeAddonLoadInternalOptions = {},
): WindowsNativeAddonLoadResult {
  const enforcePackageAcl = internal.enforcePackageAcl === true;
  const platform = options.platform ?? process.platform;
  if (platform !== WINDOWS_NATIVE_ADDON_PLATFORM) {
    fail("WINDOWS_NATIVE_ADDON_UNSUPPORTED_PLATFORM", "windows native addon requires win32; other platforms are unsupported", {
      platform,
    });
  }

  const arch = options.arch ?? process.arch;
  if (arch !== WINDOWS_NATIVE_ADDON_ARCH) {
    fail("WINDOWS_NATIVE_ADDON_ARCH_MISMATCH", "windows native addon requires x64", { arch, expected: WINDOWS_NATIVE_ADDON_ARCH });
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!isNodeVersionAtLeast(nodeVersion, WINDOWS_NATIVE_ADDON_MINIMUM_NODE)) {
    fail("WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED", "windows native addon requires Node >= 22.19.0", {
      nodeVersion,
      minimum: WINDOWS_NATIVE_ADDON_MINIMUM_NODE,
    });
  }

  // Production pin path: options.expectedManifestSha256 unset → module pin constants.
  // Test options may supply expectedManifestSha256 and do not require PIN_SOURCE_COMMIT.
  const isProductionPinPath = options.expectedManifestSha256 === undefined;
  const expectedPin =
    options.expectedManifestSha256 !== undefined
      ? options.expectedManifestSha256
      : WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
  if (expectedPin == null || expectedPin === "") {
    fail(
      "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING",
      "production provenance pin is absent; refusing to trust any on-disk manifest",
      { pin: expectedPin },
    );
  }
  if (typeof expectedPin !== "string" || !SHA256_HEX.test(expectedPin)) {
    fail("WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING", "provenance pin must be lowercase sha256 hex", {
      pin: expectedPin,
    });
  }
  // Production path: source commit pin must be non-null 40-hex (test options exempt).
  if (isProductionPinPath) {
    if (PIN_SOURCE_COMMIT == null || PIN_SOURCE_COMMIT === "") {
      fail(
        "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING",
        "production source commit pin is absent; refusing to trust any on-disk manifest",
        { source_commit_pin: PIN_SOURCE_COMMIT },
      );
    }
    if (typeof PIN_SOURCE_COMMIT !== "string" || !GIT_SHA1.test(PIN_SOURCE_COMMIT)) {
      fail(
        "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING",
        "production source commit pin must be 40-char lowercase git SHA-1",
        { source_commit_pin: PIN_SOURCE_COMMIT },
      );
    }
  }

  const packageRoot = path.resolve(options.packageRoot ?? resolveWindowsNativeAddonPackageRoot());
  const paths = resolveWindowsNativeAddonPaths(packageRoot);
  const io = options.fs ?? defaultFs();

  assertTrustedLeafPath(packageRoot, paths.manifestPath, io, "manifest");

  if (!io.existsSync(paths.manifestPath)) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_MISSING", "windows native addon manifest is missing", {
      manifestPath: paths.manifestPath,
      relative: WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH,
    });
  }

  let manifestBytes: Buffer;
  try {
    manifestBytes = io.readFileSync(paths.manifestPath);
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_MISSING", "windows native addon manifest is not readable", {
      manifestPath: paths.manifestPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Pin over raw bytes first; never parse before the closed-set pin matches.
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestHash !== expectedPin) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH", "manifest raw bytes sha256 does not match provenance pin", {
      actual: manifestHash,
      expected: expectedPin,
      manifestPath: paths.manifestPath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", "windows native addon manifest is not valid JSON", {
      manifestPath: paths.manifestPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const manifest = validateWindowsNativeAddonManifest(parsed);
  // Production path: PIN_SOURCE_COMMIT must exact-match manifest.source_commit (closed).
  if (isProductionPinPath && PIN_SOURCE_COMMIT !== manifest.source_commit) {
    fail(
      "WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH",
      "production source commit pin does not match manifest.source_commit",
      {
        source_commit_pin: PIN_SOURCE_COMMIT,
        manifest_source_commit: manifest.source_commit,
      },
    );
  }
  // platform/arch/napi/minimum_node are already closed by validate (requireConst / strict eq).
  // Runtime Node is re-checked against the frozen floor (same as manifest.minimum_node).
  if (!isNodeVersionAtLeast(nodeVersion, manifest.minimum_node)) {
    fail("WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED", "runtime Node is below manifest.minimum_node", {
      nodeVersion,
      minimum_node: manifest.minimum_node,
    });
  }

  assertTrustedLeafPath(packageRoot, paths.binaryPath, io, "binary");

  if (!io.existsSync(paths.binaryPath)) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MISSING", "windows native addon binary is missing", {
      binaryPath: paths.binaryPath,
      relative: WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH,
    });
  }

  // Held fd from pre-hash through post-dlopen same-fd rehash + identity.
  // Pure TS still cannot fully close this race (no native bootstrap atomicity).
  let fd: number | null = null;
  let preIdentity: WindowsNativeAddonFileIdentity;
  let binaryBytes: Buffer;
  try {
    try {
      fd = io.openSync(paths.binaryPath, "r");
    } catch (error) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_MISSING", "windows native addon binary could not be opened", {
        binaryPath: paths.binaryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      preIdentity = io.fstatSync(fd);
    } catch (error) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_MISSING", "windows native addon binary is not readable", {
        binaryPath: paths.binaryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!preIdentity.isFile()) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_MISSING", "windows native addon binary path is not a regular file", {
        binaryPath: paths.binaryPath,
      });
    }
    if (preIdentity.size > WINDOWS_NATIVE_ADDON_BINARY_CEILING_BYTES) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_SIZE_MISMATCH", "binary size exceeds hard ceiling (64 MiB)", {
        actual: preIdentity.size,
        ceiling: WINDOWS_NATIVE_ADDON_BINARY_CEILING_BYTES,
      });
    }
    if (preIdentity.size !== manifest.binary_bytes) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_SIZE_MISMATCH", "binary size does not match manifest.binary_bytes", {
        actual: preIdentity.size,
        expected: manifest.binary_bytes,
      });
    }

    try {
      // Positional full read (readFileFdSync must not depend on fd cursor).
      binaryBytes = io.readFileFdSync(fd);
    } catch (error) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_MISSING", "windows native addon binary could not be read", {
        binaryPath: paths.binaryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (binaryBytes.byteLength !== manifest.binary_bytes) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_SIZE_MISMATCH", "binary byte length does not match manifest.binary_bytes", {
        actual: binaryBytes.byteLength,
        expected: manifest.binary_bytes,
      });
    }
    const binaryHash = createHash("sha256").update(binaryBytes).digest("hex");
    if (binaryHash !== manifest.binary_sha256) {
      fail("WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH", "binary sha256 does not match manifest.binary_sha256", {
        actual: binaryHash,
        expected: manifest.binary_sha256,
      });
    }

    // Recheck identity after hash read (pre-load).
    assertBinaryIdentityUnchanged(io, fd, paths.binaryPath, preIdentity, "after-hash");

    const loadNativeModule = options.loadNativeModule ?? defaultLoadNativeModule(packageRoot);
    let loaded: unknown;
    try {
      loaded = loadNativeModule(paths.binaryPath);
    } catch (error) {
      fail("WINDOWS_NATIVE_ADDON_LOAD_FAILED", "native module load failed", {
        binaryPath: paths.binaryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // After dlopen: same-fd full rehash (no path re-read), then identity, then self-identity.
    assertSameFdBinaryHash(io, fd, manifest.binary_sha256, manifest.binary_bytes, "after-load");
    assertBinaryIdentityUnchanged(io, fd, paths.binaryPath, preIdentity, "after-load");

    const addon = coerceAddonModule(loaded, manifest);
    const identity = readBuildIdentity(addon, manifest);
    assertIdentityMatchesManifest(identity, manifest);
    const capabilities = readCapabilities(addon, manifest);

    // Production zero-arg: native package_rx on dir + binary + manifest before return.
    // Test options loader does not force ACL (temp packages / packaging path).
    if (enforcePackageAcl) {
      verifyProductionPackageAcl(addon, paths);
    }

    return Object.freeze({
      status: "loaded" as const,
      packageRoot: paths.packageRoot,
      manifestPath: paths.manifestPath,
      binaryPath: paths.binaryPath,
      manifest,
      identity,
      capabilities,
      addon,
    });
  } finally {
    if (fd != null) {
      try {
        io.closeSync(fd);
      } catch {
        // ignore close errors after successful/failed load path
      }
    }
  }
}

function assertWindowsNativeAddonTestHooks(label: string): void {
  // Test-hooks gate only. Production zero-arg load never calls this and never
  // reads process.env for path/pin/binary selection.
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    fail(
      "WINDOWS_NATIVE_ADDON_FAILED",
      `${label} requires PI_ASTACK_ENABLE_TEST_HOOKS=1`,
    );
  }
}

/**
 * Verify fixed package directory + binary + manifest exact package_rx.
 * Closed code only — no raw SID / path / ACE dump in error detail.
 */
function verifyProductionPackageAcl(
  addon: WindowsNativeAddonModuleV1,
  paths: {
    readonly packageRoot: string;
    readonly manifestPath: string;
    readonly binaryPath: string;
  },
): void {
  const packageDir = path.dirname(paths.binaryPath);
  const checks: Array<{ kind: "directory" | "file"; target: string; label: "directory" | "binary" | "manifest" }> = [
    { kind: "directory", target: packageDir, label: "directory" },
    { kind: "file", target: paths.binaryPath, label: "binary" },
    { kind: "file", target: paths.manifestPath, label: "manifest" },
  ];
  for (const check of checks) {
    try {
      // Call through wrapper so capability advertise-before-call is enforced.
      verifyProtectedPath(addon, check.target, check.kind, "package_rx");
    } catch (error) {
      if (error instanceof WindowsNativeAddonError && error.code === "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID") {
        throw error;
      }
      fail(
        "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID",
        `production package ${check.label} must verify package_rx after load`,
        { component: check.label },
      );
    }
  }
}

/**
 * Test-only seams. Production code outside this module and smoke must not import
 * options-bearing loaders; grep for `__TEST.loadWindowsNativeAddon` should only
 * hit this module + smoke scripts. Mutating load helpers require test hooks.
 * Pure parse/path helpers remain ungated.
 */
export const __TEST = Object.freeze({
  loadWindowsNativeAddon(options: WindowsNativeAddonLoadOptions = {}): WindowsNativeAddonLoadResult {
    assertWindowsNativeAddonTestHooks("__TEST.loadWindowsNativeAddon");
    // Options / temp-package path never forces package_rx (install owns ACL).
    // Does not read or write the process-level production singleton.
    return loadWindowsNativeAddonWithOptions(options, { enforcePackageAcl: false });
  },
  /**
   * Test-hooks gated: load with package_rx ACL enforce (production gate) without
   * using the zero-arg production pin path. Used by package smoke on temp copies
   * so live package binaries are never destructively rewritten.
   * Does not read or write the process-level production singleton.
   */
  loadWindowsNativeAddonEnforcingPackageAcl(
    options: WindowsNativeAddonLoadOptions = {},
  ): WindowsNativeAddonLoadResult {
    assertWindowsNativeAddonTestHooks("__TEST.loadWindowsNativeAddonEnforcingPackageAcl");
    return loadWindowsNativeAddonWithOptions(options, { enforcePackageAcl: true });
  },
  /** Drop process-level production successful-load singleton. Requires test hooks. */
  resetProductionLoadSingleton(): void {
    resetWindowsNativeAddonProductionLoadSingleton();
  },
  /** Observe whether production successful-load singleton is held. Requires test hooks. */
  hasProductionLoadSingleton(): boolean {
    return hasWindowsNativeAddonProductionLoadSingleton();
  },
  /** Successful zero-arg load count (excludes cache hits). Requires test hooks. */
  productionSuccessfulLoadCount(): number {
    return getWindowsNativeAddonProductionSuccessfulLoadCount();
  },
  /** Zero-arg full-path attempt count (excludes pure cache hits). Requires test hooks. */
  productionLoadAttemptCount(): number {
    return getWindowsNativeAddonProductionLoadAttemptCount();
  },
  validateWindowsNativeAddonManifest,
  validateWindowsNativeAddonCapabilities,
  resolveWindowsNativeAddonPaths,
  resolveWindowsNativeAddonPackageRoot,
  isNodeVersionAtLeast,
  defaultFs,
  /** JSON-safe identity snapshot (bigint → decimal string). */
  identitySnapshot,
  identityEquals,
  /** Production zero-arg requires all known capabilities before cache. */
  assertProductionCapabilitiesComplete,
});

function defaultFs(): WindowsNativeAddonFs {
  return {
    existsSync: (filePath) => fs.existsSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath),
    // bigint:true — never Number-truncate dev/ino (Windows FILE_ID can exceed MAX_SAFE_INTEGER).
    statSync: (filePath) => toFileIdentity(fs.statSync(filePath, { bigint: true })),
    lstatSync: (filePath) => {
      const st = fs.lstatSync(filePath);
      return {
        size: st.size,
        isSymbolicLink: () => st.isSymbolicLink(),
        isFile: () => st.isFile(),
      };
    },
    realpathSync: (filePath) => fs.realpathSync(filePath),
    openSync: (filePath, flags) => fs.openSync(filePath, flags),
    fstatSync: (fd) => toFileIdentity(fs.fstatSync(fd, { bigint: true })),
    readFileFdSync: (fd) => {
      // Always positional (pread-equivalent) so fd cursor is irrelevant across rehash.
      const st = fs.fstatSync(fd, { bigint: true });
      if (st.size > BigInt(WINDOWS_NATIVE_ADDON_BINARY_CEILING_BYTES)) {
        throw Object.assign(new Error("binary exceeds hard ceiling"), { code: "EFBIG" });
      }
      const size = Number(st.size);
      const buf = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const n = fs.readSync(fd, buf, offset, size - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      return buf.subarray(0, offset);
    },
    closeSync: (fd) => {
      fs.closeSync(fd);
    },
  };
}

/** Normalize Stats/BigIntStats into lossless FileIdentity (dev/ino as bigint). */
function toFileIdentity(st: fs.Stats | fs.BigIntStats): WindowsNativeAddonFileIdentity {
  const dev = typeof st.dev === "bigint" ? st.dev : BigInt(st.dev);
  const ino = typeof st.ino === "bigint" ? st.ino : BigInt(st.ino);
  const sizeBig = typeof st.size === "bigint" ? st.size : BigInt(st.size);
  if (sizeBig < 0n || sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(new Error("file size is not a non-negative safe integer"), { code: "EOVERFLOW" });
  }
  const size = Number(sizeBig);
  // mtimeMs is diagnostic only (may be fractional); never used in identityEquals.
  const mtimeMs =
    typeof (st as fs.Stats).mtimeMs === "number" && Number.isFinite((st as fs.Stats).mtimeMs)
      ? (st as fs.Stats).mtimeMs
      : undefined;
  return {
    dev,
    ino,
    size,
    mtimeMs,
    isFile: () => st.isFile(),
  };
}

function defaultLoadNativeModule(packageRoot: string): (absoluteBinaryPath: string) => unknown {
  const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
  return (absoluteBinaryPath: string) => requireFromPackage(absoluteBinaryPath);
}

/** Hard ceiling for native binary bytes (matches manifest validation + package). */
const WINDOWS_NATIVE_ADDON_BINARY_CEILING_BYTES = 64 * 1024 * 1024;

/** Bound fs error codes for PATH_UNTRUSTED detail — never leak path/message text. */
function fsErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) {
      return code;
    }
  }
  return "UNKNOWN";
}

function assertTrustedLeafPath(
  packageRoot: string,
  targetPath: string,
  io: WindowsNativeAddonFs,
  kind: "manifest" | "binary",
): void {
  const root = path.resolve(packageRoot);
  const target = path.resolve(targetPath);

  if (!isPathInsideRoot(target, root)) {
    fail("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", `${kind} path escapes package root`, {
      check: "inside_root",
      kind,
    });
  }

  // Walk package root → intermediates → leaf; reject symlink/reparse observable surface.
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  const chain: string[] = [root];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    chain.push(current);
  }

  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i];
    let lst: WindowsNativeAddonLstat;
    try {
      lst = io.lstatSync(entry);
    } catch (error) {
      // Only absence may defer to later MANIFEST_MISSING / BINARY_MISSING.
      // EACCES/EPERM/EBUSY/other must not fail-open as "missing".
      const code = fsErrorCode(error);
      if (code === "ENOENT") {
        return;
      }
      fail("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", `${kind} path component unreadable`, {
        check: "lstat",
        code,
        kind,
      });
    }
    if (lst.isSymbolicLink()) {
      fail("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", `${kind} path contains symlink or reparse point`, {
        check: "symlink_or_reparse",
        kind,
      });
    }
    const isLeaf = i === chain.length - 1;
    if (isLeaf && !lst.isFile()) {
      fail("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", `${kind} leaf is not a regular file`, {
        check: "leaf_not_file",
        kind,
      });
    }
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = path.resolve(io.realpathSync(root));
    realTarget = path.resolve(io.realpathSync(target));
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", `${kind} path realpath failed`, {
      check: "realpath",
      code: fsErrorCode(error),
      kind,
    });
  }
  if (!isPathInsideRoot(realTarget, realRoot)) {
    fail("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", `${kind} realpath escapes package root`, {
      check: "realpath_inside_root",
      kind,
    });
  }
}

/**
 * After dlopen: re-read full binary via the held fd (positional) and exact-match
 * manifest.binary_sha256. Never re-opens/re-reads via path. Mismatch → BINARY_MUTATED.
 */
function assertSameFdBinaryHash(
  io: WindowsNativeAddonFs,
  fd: number,
  expectedSha256: string,
  expectedBytes: number,
  phase: "after-load",
): void {
  let st: WindowsNativeAddonFileIdentity;
  try {
    st = io.fstatSync(fd);
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd unreadable for same-fd rehash ${phase}`, {
      check: "fstat",
      phase,
      code: fsErrorCode(error),
    });
  }
  if (st.size > WINDOWS_NATIVE_ADDON_BINARY_CEILING_BYTES) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd size exceeds ceiling ${phase}`, {
      check: "ceiling",
      phase,
    });
  }
  if (st.size !== expectedBytes) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd size changed ${phase} (same-fd rehash)`, {
      check: "size",
      phase,
      expected: expectedBytes,
      actual: st.size,
    });
  }
  let bytes: Buffer;
  try {
    // Must use positional reads so a prior pre-load hash read cannot leave the cursor at EOF.
    bytes = io.readFileFdSync(fd);
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd unread for same-fd rehash ${phase}`, {
      check: "read",
      phase,
      code: fsErrorCode(error),
    });
  }
  if (bytes.byteLength !== expectedBytes) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd byte length changed ${phase} (same-fd rehash)`, {
      check: "byte_length",
      phase,
      expected: expectedBytes,
      actual: bytes.byteLength,
    });
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== expectedSha256) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary sha256 changed ${phase} (same-fd rehash)`, {
      check: "sha256",
      phase,
      actual: hash,
      expected: expectedSha256,
    });
  }
}

/** Windows package paths are compared case-insensitively for containment. */
function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const root = normalizeWinPath(rootPath);
  const target = normalizeWinPath(targetPath);
  if (target === root) return false;
  const rootPrefix = root.endsWith("\\") ? root : `${root}\\`;
  return target.startsWith(rootPrefix);
}

function normalizeWinPath(value: string): string {
  // Always case-fold: this loader is Windows-native and tests inject win32 paths on any host.
  return path.resolve(value).replace(/\//g, "\\").toLowerCase();
}

function assertBinaryIdentityUnchanged(
  io: WindowsNativeAddonFs,
  fd: number,
  binaryPath: string,
  expected: WindowsNativeAddonFileIdentity,
  phase: "after-hash" | "after-load",
): void {
  let viaFd: WindowsNativeAddonFileIdentity;
  try {
    viaFd = io.fstatSync(fd);
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd identity unreadable ${phase}`, {
      binaryPath,
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!identityEquals(viaFd, expected)) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary fd identity changed ${phase} (best-effort TOCTOU guard)`, {
      binaryPath,
      phase,
      expected: identitySnapshot(expected),
      actual: identitySnapshot(viaFd),
    });
  }

  let viaPath: WindowsNativeAddonFileIdentity;
  try {
    viaPath = io.statSync(binaryPath);
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary path identity unreadable ${phase}`, {
      binaryPath,
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!identityEquals(viaPath, expected)) {
    fail("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", `binary path identity changed ${phase} (best-effort TOCTOU guard)`, {
      binaryPath,
      phase,
      expected: identitySnapshot(expected),
      actual: identitySnapshot(viaPath),
    });
  }
}

/**
 * Security identity equality: dev + ino + size only.
 * mtime is never a security identity guarantee (diagnostic at most).
 */
function identityEquals(a: WindowsNativeAddonFileIdentity, b: WindowsNativeAddonFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size;
}

/** JSON-serializable identity snapshot (bigint fields as decimal strings). */
function identitySnapshot(id: WindowsNativeAddonFileIdentity): Record<string, string | number> {
  const snap: Record<string, string | number> = {
    dev: id.dev.toString(),
    ino: id.ino.toString(),
    size: id.size,
  };
  if (typeof id.mtimeMs === "number" && Number.isFinite(id.mtimeMs)) {
    snap.mtimeMs = id.mtimeMs;
  }
  return snap;
}

function coerceAddonModule(
  loaded: unknown,
  manifest: WindowsNativeAddonManifestV1,
): WindowsNativeAddonModuleV1 {
  if (!isPlainObject(loaded)) {
    fail("WINDOWS_NATIVE_ADDON_LOAD_FAILED", "native module export must be a plain object");
  }
  if (loaded.addon_abi !== WINDOWS_NATIVE_ADDON_ABI) {
    fail("WINDOWS_NATIVE_ADDON_ABI_MISMATCH", "addon self-reported addon_abi does not match frozen ABI v1", {
      actual: loaded.addon_abi,
      expected: WINDOWS_NATIVE_ADDON_ABI,
      build_id: manifest.build_id,
    });
  }
  if (typeof loaded.getBuildIdentity !== "function") {
    fail("WINDOWS_NATIVE_ADDON_LOAD_FAILED", "native module must export getBuildIdentity()");
  }
  if (typeof loaded.getCapabilities !== "function") {
    fail("WINDOWS_NATIVE_ADDON_LOAD_FAILED", "native module must export getCapabilities()");
  }
  // Required retained lock entrypoint.
  if (typeof loaded.tryAcquireRetainedDirectoryLock !== "function") {
    fail(
      "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
      "capability retained_directory_lock_v1 requires tryAcquireRetainedDirectoryLock()",
    );
  }
  // When advertised (known set always includes these for current binary), require surface.
  // Soft presence checks here; capability wrappers enforce advertise-before-call.
  return loaded as unknown as WindowsNativeAddonModuleV1;
}

function readBuildIdentity(
  addon: WindowsNativeAddonModuleV1,
  manifest: WindowsNativeAddonManifestV1,
): WindowsNativeAddonBuildIdentityV1 {
  let raw: unknown;
  try {
    raw = addon.getBuildIdentity();
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon getBuildIdentity() threw", {
      error: error instanceof Error ? error.message : String(error),
      build_id: manifest.build_id,
    });
  }
  if (!isPlainObject(raw)) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon getBuildIdentity() must return a plain object");
  }
  const identityKeys = [
    "addon_abi",
    "build_id",
    "source_commit",
    "source_tree_sha256",
    "toolchain_id",
    "platform",
    "arch",
    "napi_version",
    "target",
    "build_mode",
    "reproducibility",
    "native_tests",
    "clippy",
    "build_config_sha256",
  ] as const;
  const actualKeys = Object.keys(raw).sort();
  const expectedKeys = [...identityKeys].sort();
  if (actualKeys.join("\0") !== expectedKeys.join("\0")) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity keys are not the closed ABI v1 set", {
      actualKeys,
      expectedKeys,
    });
  }
  if (raw.addon_abi !== WINDOWS_NATIVE_ADDON_ABI) {
    fail("WINDOWS_NATIVE_ADDON_ABI_MISMATCH", "addon build identity addon_abi mismatch", {
      actual: raw.addon_abi,
      expected: WINDOWS_NATIVE_ADDON_ABI,
    });
  }
  if (raw.platform !== WINDOWS_NATIVE_ADDON_PLATFORM) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity platform mismatch", { actual: raw.platform });
  }
  if (raw.arch !== WINDOWS_NATIVE_ADDON_ARCH) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity arch mismatch", { actual: raw.arch });
  }
  if (raw.napi_version !== WINDOWS_NATIVE_ADDON_NAPI_VERSION) {
    fail("WINDOWS_NATIVE_ADDON_NAPI_MISMATCH", "addon build identity napi_version mismatch", {
      actual: raw.napi_version,
      expected: WINDOWS_NATIVE_ADDON_NAPI_VERSION,
    });
  }
  if (raw.target !== WINDOWS_NATIVE_ADDON_TARGET) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity target mismatch", { actual: raw.target });
  }
  for (const key of [
    "build_id",
    "source_commit",
    "source_tree_sha256",
    "toolchain_id",
    "build_mode",
    "reproducibility",
    "native_tests",
    "clippy",
    "build_config_sha256",
  ] as const) {
    if (typeof raw[key] !== "string" || !raw[key]) {
      fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", `addon build identity ${key} must be a non-empty string`);
    }
  }
  if (!SHA256_HEX.test(raw.toolchain_id as string)) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity toolchain_id must be lowercase sha256 hex", {
      toolchain_id: raw.toolchain_id,
    });
  }
  if (raw.build_mode !== "development" && raw.build_mode !== "production") {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity build_mode must be development|production", {
      build_mode: raw.build_mode,
    });
  }
  if (raw.reproducibility !== "skipped" && raw.reproducibility !== "dual_clean_match") {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity reproducibility must be skipped|dual_clean_match", {
      reproducibility: raw.reproducibility,
    });
  }
  if (raw.native_tests !== "passed") {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity native_tests must be passed", {
      native_tests: raw.native_tests,
    });
  }
  if (raw.clippy !== "passed") {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity clippy must be passed", {
      clippy: raw.clippy,
    });
  }
  if (!SHA256_HEX.test(raw.build_config_sha256 as string)) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon build identity build_config_sha256 must be lowercase sha256 hex", {
      build_config_sha256: raw.build_config_sha256,
    });
  }
  return Object.freeze({
    addon_abi: WINDOWS_NATIVE_ADDON_ABI,
    build_id: raw.build_id as string,
    source_commit: raw.source_commit as string,
    source_tree_sha256: raw.source_tree_sha256 as string,
    toolchain_id: raw.toolchain_id as string,
    platform: WINDOWS_NATIVE_ADDON_PLATFORM,
    arch: WINDOWS_NATIVE_ADDON_ARCH,
    napi_version: WINDOWS_NATIVE_ADDON_NAPI_VERSION,
    target: WINDOWS_NATIVE_ADDON_TARGET,
    build_mode: raw.build_mode as "development" | "production",
    reproducibility: raw.reproducibility as "skipped" | "dual_clean_match",
    native_tests: "passed" as const,
    clippy: "passed" as const,
    build_config_sha256: raw.build_config_sha256 as string,
  });
}

function readCapabilities(
  addon: WindowsNativeAddonModuleV1,
  manifest: WindowsNativeAddonManifestV1,
): readonly string[] {
  let raw: unknown;
  try {
    raw = addon.getCapabilities();
  } catch (error) {
    fail("WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH", "addon getCapabilities() threw", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const caps = normalizeCapabilities(raw);
  const expected = [...manifest.capabilities];
  if (caps.length !== expected.length || caps.some((c, i) => c !== expected[i])) {
    fail("WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH", "addon getCapabilities() does not match manifest.capabilities", {
      actual: caps,
      expected,
    });
  }
  return Object.freeze([...caps]);
}

function normalizeCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    fail("WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH", "getCapabilities() must return an array");
  }
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !CAPABILITY_ID.test(item)) {
      fail("WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH", "capability entries must be capability-id strings", { item });
    }
    values.push(item);
  }
  const sorted = [...values].sort();
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== sorted[i] || (i > 0 && values[i] === values[i - 1])) {
      fail("WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH", "capabilities must be exact sorted unique", { actual: values });
    }
  }
  return values;
}

function assertIdentityMatchesManifest(
  identity: WindowsNativeAddonBuildIdentityV1,
  manifest: WindowsNativeAddonManifestV1,
): void {
  if (identity.addon_abi !== manifest.addon_abi) {
    fail("WINDOWS_NATIVE_ADDON_ABI_MISMATCH", "addon ABI does not match manifest", {
      identity: identity.addon_abi,
      manifest: manifest.addon_abi,
    });
  }
  if (
    identity.build_id !== manifest.build_id
    || identity.source_commit !== manifest.source_commit
    || identity.source_tree_sha256 !== manifest.source_tree_sha256
    || identity.toolchain_id !== manifest.toolchain_id
    || identity.platform !== manifest.platform
    || identity.arch !== manifest.arch
    || identity.napi_version !== manifest.napi_version
    || identity.target !== manifest.target
    || identity.build_mode !== manifest.build_mode
    || identity.reproducibility !== manifest.reproducibility
    || identity.native_tests !== manifest.native_tests
    || identity.clippy !== manifest.clippy
    || identity.build_config_sha256 !== manifest.build_config_sha256
  ) {
    fail("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", "addon self-reported build identity does not match manifest", {
      identity,
      expected: {
        build_id: manifest.build_id,
        source_commit: manifest.source_commit,
        source_tree_sha256: manifest.source_tree_sha256,
        toolchain_id: manifest.toolchain_id,
        platform: manifest.platform,
        arch: manifest.arch,
        napi_version: manifest.napi_version,
        target: manifest.target,
        build_mode: manifest.build_mode,
        reproducibility: manifest.reproducibility,
        native_tests: manifest.native_tests,
        clippy: manifest.clippy,
        build_config_sha256: manifest.build_config_sha256,
      },
    });
  }
}

/**
 * Semver-core comparison with prerelease awareness:
 * `22.19.0-rc.1` is strictly less than `22.19.0`.
 */
export function isNodeVersionAtLeast(actual: string, minimum: string): boolean {
  const a = parseNodeVersion(actual);
  const m = parseNodeVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] > m.core[i]) return true;
    if (a.core[i] < m.core[i]) return false;
  }
  // Core equal: release (no prerelease) > any prerelease; both release → equal.
  if (a.prerelease === null && m.prerelease === null) return true;
  if (a.prerelease === null && m.prerelease !== null) return true;
  if (a.prerelease !== null && m.prerelease === null) return false;
  // Both prerelease: lexicographic on the prerelease string (good enough for gate).
  return (a.prerelease as string) >= (m.prerelease as string);
}

function parseNodeVersion(value: string): { core: [number, number, number]; prerelease: string | null } | null {
  if (typeof value !== "string" || !NODE_VERSION.test(value)) return null;
  const plus = value.indexOf("+");
  const withoutBuild = plus === -1 ? value : value.slice(0, plus);
  const dash = withoutBuild.indexOf("-");
  const corePart = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const parts = corePart.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return { core: [parts[0], parts[1], parts[2]], prerelease };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", `${key} must be a positive integer`);
  }
  return value;
}

function requireConst<T extends string | number>(raw: Record<string, unknown>, key: string, expected: T): T {
  const value = raw[key];
  if (value !== expected) {
    fail("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", `${key} must equal ${JSON.stringify(expected)}`, {
      actual: value,
      expected,
    });
  }
  return expected;
}

function fail(code: WindowsNativeAddonErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new WindowsNativeAddonError(code, message, detail);
}
