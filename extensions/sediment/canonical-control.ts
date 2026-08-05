/// <reference types="node" />

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  kickCanonicalStartupAttempt,
  observeCanonicalStartupAttempt,
  readCanonicalHeadOid,
  sanitizedCanonicalGitEnvironment,
  type CanonicalRuntimeDiagnostics,
  type CanonicalRuntimePeek,
} from "../_shared/canonical-git-runtime";
import { parseGitStatusPorcelainV1Z } from "../_shared/git-z-parser";
import { fsyncDirectory } from "../_shared/durable-write";
import {
  assertCanonicalMutationAuthorized,
  isCanonicalMutationAuthorityError,
  withCanonicalMutationAuthority,
} from "../_shared/canonical-mutation-authority";
import {
  withCanonicalMutationBarrier,
} from "../_shared/canonical-mutation-barrier";
import {
  convergeExactCohortIndex,
  prepareExactCohortCommit,
  publishExactCohortCommit,
  resolveRef,
  snapshotIndexEntries,
} from "../_shared/git-exact-cohort";
import {
  acquireRetainedDirectoryLock,
  RetainedDirectoryLockError,
  type RetainedDirectoryLock,
} from "../_shared/retained-directory-lock";
import {
  durableAtomicCreateFile,
  durableAtomicReplaceFile,
  ensureProtectedDirectory,
  loadWindowsNativeAddon,
  readProtectedFile,
  verifyProtectedPath,
  WindowsNativeAddonError,
  WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1,
  WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1,
  type WindowsNativeAddonModuleV1,
} from "../_shared/windows-native-addon";
import {
  repairStorePresentBrainLayoutForAuthorityExecutor,
} from "../abrain/brain-layout";
import {
  admitLocalExecutorAuthority,
  isCanonicalNonzeroU64Decimal,
  LocalExecutorAuthorityAdmissionError,
  observeLocalExecutorAuthorityStore,
  type LocalExecutorAuthorityObservationDeps,
} from "./local-executor-authority";

const CONTROL_STATE_KEY = Symbol.for("pi-astack/sediment-worker-canonical-control/v1");
const CONTROL_STATE_API_VERSION = 1;
const HEX64_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_CONTROL_ARGS_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const U64_MAX = 18_446_744_073_709_551_615n;

export const SEDIMENT_WORKER_CANONICAL_CONTROL_SCHEMA =
  "pi-astack/sediment-worker-canonical-control/v1" as const;
export const SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_SCHEMA =
  "pi-astack/sediment-worker-canonical-control-result/v1" as const;
export const SEDIMENT_WORKER_CANONICAL_CONTROL_COMMAND_NAME =
  "sediment-worker-canonical-control" as const;
export const SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_NOTIFY_PREFIX =
  "sediment-worker-canonical-control-result:" as const;

export const CANONICAL_CONVERGENCE_ATTESTATION_SCHEMA =
  "pi-astack/canonical-convergence-attestation/v1" as const;
export const CANONICAL_CONVERGENCE_RELATIVE_DIR = path.join(
  ".state",
  "sediment",
  "canonical-convergence",
);
export const CANONICAL_CONVERGENCE_ATTESTATION_NAME = "attestation.json" as const;

export const CANONICAL_CONTROL_REASON_CODES = [
  "none",
  "startup_requested",
  "startup_running",
  "startup_budget_exhausted",
  "canonical_mutation_busy",
  "canonical_scan_busy",
  "canonical_scan_lock_failed",
  "continuation_pending",
  "canonical_head_changed",
  "canonical_backlog_pending",
  "owner_intervention_required",
  "startup_blocked",
  "startup_failed",
  "continuation_failed",
  "attestation_unavailable",
  "attestation_write_failed",
  "authority_stale",
  "authority_unavailable",
  "authority_revoked",
  "invalid_request",
  "generation_overflow",
] as const;
export type CanonicalControlReasonCode = (typeof CANONICAL_CONTROL_REASON_CODES)[number];
const CONTROL_REASON_SET = new Set<string>(CANONICAL_CONTROL_REASON_CODES);

export const CANONICAL_CONTROL_STATUSES = [
  "pending",
  "running",
  "ready",
  "blocked",
  "unavailable",
] as const;
export type CanonicalControlStatus = (typeof CANONICAL_CONTROL_STATUSES)[number];
const CONTROL_STATUS_SET = new Set<string>(CANONICAL_CONTROL_STATUSES);

export type CanonicalControlOperation = "kick" | "observe";
export type CanonicalConvergenceOutcome = "pending" | "ready" | "blocked";

const CONTROL_REQUEST_KEYS = new Set([
  "schema",
  "request_id",
  "operation",
  "local_executor_epoch",
  "local_executor_holder_nonce",
]);
const CONTROL_RESULT_KEYS = new Set([
  "schema",
  "request_id",
  "operation",
  "status",
  "reason_code",
  "convergence_generation",
  "retryable",
]);
const ATTESTATION_KEYS = new Set([
  "schema",
  "local_executor_epoch",
  "local_executor_holder_nonce",
  "convergence_generation",
  "outcome",
  "reason_code",
  "canonical_head",
  "published_at_ms",
]);
const PENDING_ATTESTATION_REASONS = new Set<CanonicalControlReasonCode>([
  "startup_requested",
  "startup_running",
  "startup_budget_exhausted",
  "canonical_mutation_busy",
  "canonical_scan_busy",
  "canonical_scan_lock_failed",
  "continuation_pending",
  // Ready-state cheap drift probe (observe-only; daemon BackoffKick → fresh kick).
  "canonical_head_changed",
  "canonical_backlog_pending",
]);
const BLOCKED_ATTESTATION_REASONS = new Set<CanonicalControlReasonCode>([
  "owner_intervention_required",
  "startup_blocked",
  "startup_failed",
  "continuation_failed",
]);

export interface SedimentWorkerCanonicalControlManifest {
  schema: typeof SEDIMENT_WORKER_CANONICAL_CONTROL_SCHEMA;
  request_id: string;
  operation: CanonicalControlOperation;
  local_executor_epoch: string;
  local_executor_holder_nonce: string;
}

export interface SedimentWorkerCanonicalControlResult {
  schema: typeof SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_SCHEMA;
  request_id: string;
  operation: CanonicalControlOperation;
  status: CanonicalControlStatus;
  reason_code: CanonicalControlReasonCode;
  convergence_generation: string | null;
  retryable: boolean;
}

export interface CanonicalConvergenceAttestation {
  schema: typeof CANONICAL_CONVERGENCE_ATTESTATION_SCHEMA;
  local_executor_epoch: string;
  local_executor_holder_nonce: string;
  convergence_generation: string;
  outcome: CanonicalConvergenceOutcome;
  reason_code: CanonicalControlReasonCode;
  canonical_head: string | null;
  published_at_ms: number;
}

export class CanonicalControlValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CanonicalControlValidationError";
    this.code = code;
  }
}

export class CanonicalAttestationError extends Error {
  readonly code: "attestation_unavailable" | "attestation_write_failed";

  constructor(code: "attestation_unavailable" | "attestation_write_failed") {
    super(code);
    this.name = "CanonicalAttestationError";
    this.code = code;
  }
}

/** Linux/Unix snapshot identity: device + inode. */
interface CanonicalAttestationSnapshotPosix {
  readonly platform: "posix";
  readonly attestation: CanonicalConvergenceAttestation;
  readonly raw: string;
  readonly dev: number;
  readonly ino: number;
}

/** Windows snapshot identity: volume serial + file id + size (native). */
interface CanonicalAttestationSnapshotWindows {
  readonly platform: "win32";
  readonly attestation: CanonicalConvergenceAttestation;
  readonly raw: string;
  readonly volume_serial_number: string;
  readonly file_id: string;
  readonly size: number;
}

type CanonicalAttestationSnapshot =
  | CanonicalAttestationSnapshotPosix
  | CanonicalAttestationSnapshotWindows;

interface CanonicalControlAggregate {
  readonly local_executor_epoch: string;
  readonly local_executor_holder_nonce: string;
  /** Null only for blocked/attestation_unavailable (strict protocol). */
  readonly convergence_generation: string | null;
  readonly status: CanonicalControlStatus;
  readonly reason_code: CanonicalControlReasonCode;
  readonly retryable: boolean;
}

interface ActiveCanonicalKick {
  readonly token: symbol;
  readonly root: string;
  readonly local_executor_epoch: string;
  readonly local_executor_holder_nonce: string;
  readonly convergence_generation: string;
  readonly authorityObservation: LocalExecutorAuthorityObservationDeps | undefined;
  initial: Promise<SedimentWorkerCanonicalControlResult>;
}

interface CanonicalControlProcessState {
  readonly apiVersion: number;
  readonly active: Map<string, ActiveCanonicalKick>;
  readonly aggregate: Map<string, CanonicalControlAggregate>;
}

export interface CanonicalControlTestHooks {
  kickStartup?: (options: { abrainHome: string }) => {
    promise: Promise<CanonicalRuntimeDiagnostics>;
    generation?: number;
  };
  observeStartup?: (options: { abrainHome: string }) => CanonicalRuntimePeek;
  readCanonicalHead?: (abrainHome: string) => Promise<string>;
  /** Gated test override; production defaults to real bind-intent inventory. */
  inspectBindIntentInventory?: (abrainHome: string) => Promise<{
    pending: number;
    failed: number;
    invalid: number;
  }>;
  /** Gated test override; production defaults to real applyAllPending. */
  applyBindIntents?: (abrainHome: string) => Promise<{
    applied: number;
    pending: number;
    failed: number;
  }>;
  /**
   * Gated test override for ready-state cheap canonical backlog/worktree probe.
   * Production defaults to porcelain v1 status on l1/l2 only (no whole-L1).
   */
  probeCanonicalBacklog?: (abrainHome: string) => Promise<"none" | "pending">;
  /**
   * Gated test override for store-present layout repair.
   * Production defaults to real authority-executor repair.
   * Mechanical hook tests may inject a no-op so they do not depend on layout.
   */
  repairStorePresentBrainLayout?: (abrainHome: string) => void;
  now?: () => number;
}

export interface SedimentWorkerCanonicalControlDeps {
  resolveAbrainHome: () => string;
  authorityObservation?: LocalExecutorAuthorityObservationDeps;
  testHooks?: CanonicalControlTestHooks;
  /** Testable platform override; production defaults to process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Test-only Windows DCC physical-layer addon (temp package via test-only options loader).
   * Production never accepts this seam — uses zero-arg loadWindowsNativeAddon().
   * Gated by PI_ASTACK_ENABLE_TEST_HOOKS=1.
   */
  windowsDccNativeAddon?: WindowsNativeAddonModuleV1;
}

/**
 * Production Windows DCC addon cache. Only successful loads are cached.
 * pin=null / missing binary / missing capabilities → return null without caching
 * unavailable (next call re-attempts). Never throws out of resolve paths.
 */
type ProductionWindowsDccAddonCache =
  | { readonly state: "unset" }
  | { readonly state: "loaded"; readonly addon: WindowsNativeAddonModuleV1 };

let productionWindowsDccAddonCache: ProductionWindowsDccAddonCache = { state: "unset" };

/** AsyncLocalStorage carries test-injected addon through kick/observe async trees. */
const windowsDccAddonAls = new AsyncLocalStorage<WindowsNativeAddonModuleV1>();

function getProductionWindowsDccAddon(): WindowsNativeAddonModuleV1 | null {
  if (productionWindowsDccAddonCache.state === "loaded") {
    return productionWindowsDccAddonCache.addon;
  }
  if (process.platform !== "win32") return null;
  try {
    const loaded = loadWindowsNativeAddon();
    const caps = loaded.capabilities;
    if (
      !caps.includes(WINDOWS_NATIVE_ADDON_CAPABILITY_PROTECTED_DACL_V1)
      || !caps.includes(WINDOWS_NATIVE_ADDON_CAPABILITY_ATOMIC_FILE_V1)
    ) {
      // Missing capabilities: do not cache unavailable.
      return null;
    }
    productionWindowsDccAddonCache = { state: "loaded", addon: loaded.addon };
    return loaded.addon;
  } catch {
    // pin null, hash mismatch, missing artifact, arch/node mismatch, etc.
    // Do not cache failures — pin may land later in-process.
    return null;
  }
}

function resolveWindowsDccAddon(): WindowsNativeAddonModuleV1 | null {
  if (process.platform !== "win32") return null;
  const injected = windowsDccAddonAls.getStore();
  if (injected) return injected;
  return getProductionWindowsDccAddon();
}

function withWindowsDccAddonAsync<T>(
  addon: WindowsNativeAddonModuleV1 | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!addon) return fn();
  // ALS only — no process-global permanent override. setImmediate/Promise settle
  // inherit ALS; smoke readers outside control must use withWindowsDccNativeAddonForTests.
  return windowsDccAddonAls.run(addon, fn);
}

function assertWindowsDccTestSeamAllowed(
  addon: WindowsNativeAddonModuleV1 | undefined,
): WindowsNativeAddonModuleV1 | undefined {
  if (addon === undefined) return undefined;
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") validation("test_hooks_disabled");
  return addon;
}

/**
 * Gated __TEST helper: run fn under ALS with a temp-package Windows DCC addon.
 * Production must not call this. Required for smoke readers/observes that sit
 * outside runSedimentWorkerCanonicalControl / observeForeground ALS context.
 */
export function withWindowsDccNativeAddonForTests<T>(
  addon: WindowsNativeAddonModuleV1,
  fn: () => T,
): T {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") validation("test_hooks_disabled");
  return windowsDccAddonAls.run(addon, fn);
}

export async function withWindowsDccNativeAddonForTestsAsync<T>(
  addon: WindowsNativeAddonModuleV1,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") validation("test_hooks_disabled");
  return windowsDccAddonAls.run(addon, fn);
}

/**
 * Control-path platform gate. Non-win32 always supported.
 * win32 requires either production native addon (protected_dacl_v1+atomic_file_v1)
 * or a gated test-injected addon on a real win32 host.
 */
function isDccControlPlatformReady(
  platform: NodeJS.Platform,
  testAddon: WindowsNativeAddonModuleV1 | undefined,
): boolean {
  if (platform !== "win32") return true;
  if (testAddon !== undefined) {
    return process.platform === "win32" && process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1";
  }
  return isDccAttestationPlatformSupported("win32");
}

/**
 * DCC attestation private objects require OS-enforced confidentiality.
 * Unix: POSIX dir 0700 / file 0600 (implemented locally).
 * Windows: current-primary-TokenUser protected DACL via native protected_dacl_v1 +
 * atomic_file_v1. Production zero-arg loader must succeed with both capabilities;
 * pin=null / load failure → false (attestation_unavailable fail-closed, never throws).
 * Do not silently trust inherited/default ACL.
 */
export function isDccAttestationPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return true;
  // Simulated win32 on non-win32 hosts cannot load the production native addon.
  if (process.platform !== "win32") return false;
  return getProductionWindowsDccAddon() !== null;
}

function unavailableAttestation(): never {
  throw new CanonicalAttestationError("attestation_unavailable");
}

function writeFailedAttestation(): never {
  throw new CanonicalAttestationError("attestation_write_failed");
}

function validation(code: string): never {
  throw new CanonicalControlValidationError(code);
}

function skipWhitespace(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && /[\t\n\r ]/.test(text[i]!)) i += 1;
  return i;
}

function parseJsonStringToken(
  text: string,
  offset: number,
  fail: () => never,
): { value: string; next: number } {
  if (text[offset] !== "\"") fail();
  let escaped = false;
  for (let i = offset + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      try {
        const value: unknown = JSON.parse(text.slice(offset, i + 1));
        if (typeof value !== "string") fail();
        return { value, next: i + 1 };
      } catch {
        fail();
      }
    }
    if (ch.charCodeAt(0) < 0x20) fail();
  }
  return fail();
}

/** Strict flat JSON object parser. All DCC v1 records are scalar-only. */
function parseStrictFlatJsonObject(
  text: string,
  fail: () => never,
): Record<string, unknown> {
  let i = skipWhitespace(text, 0);
  if (text[i] !== "{") fail();
  i = skipWhitespace(text, i + 1);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  if (text[i] === "}") {
    i = skipWhitespace(text, i + 1);
    if (i !== text.length) fail();
    return result;
  }
  for (;;) {
    const key = parseJsonStringToken(text, i, fail);
    if (seen.has(key.value)) fail();
    seen.add(key.value);
    i = skipWhitespace(text, key.next);
    if (text[i] !== ":") fail();
    i = skipWhitespace(text, i + 1);

    let value: unknown;
    if (text[i] === "\"") {
      const token = parseJsonStringToken(text, i, fail);
      value = token.value;
      i = token.next;
    } else if (text.startsWith("null", i)) {
      value = null;
      i += 4;
    } else if (text.startsWith("true", i)) {
      value = true;
      i += 4;
    } else if (text.startsWith("false", i)) {
      value = false;
      i += 5;
    } else {
      const match = text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
      if (!match) fail();
      try {
        value = JSON.parse(match[0]);
      } catch {
        fail();
      }
      i += match[0].length;
    }
    result[key.value] = value;
    i = skipWhitespace(text, i);
    if (text[i] === "}") {
      i = skipWhitespace(text, i + 1);
      if (i !== text.length) fail();
      return result;
    }
    if (text[i] !== ",") fail();
    i = skipWhitespace(text, i + 1);
  }
}

function rejectUnknownOrMissingKeys(
  value: Record<string, unknown>,
  expected: Set<string>,
  code: string,
): void {
  if (Object.keys(value).length !== expected.size) validation(code);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) validation(code);
  }
}

export function validateSedimentWorkerCanonicalControlManifest(
  raw: unknown,
): SedimentWorkerCanonicalControlManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) validation("manifest_not_object");
  const value = raw as Record<string, unknown>;
  rejectUnknownOrMissingKeys(value, CONTROL_REQUEST_KEYS, "manifest_keys_invalid");
  if (value.schema !== SEDIMENT_WORKER_CANONICAL_CONTROL_SCHEMA) validation("schema_mismatch");
  if (typeof value.request_id !== "string" || !HEX64_RE.test(value.request_id)) {
    validation("invalid_request_id");
  }
  if (value.operation !== "kick" && value.operation !== "observe") validation("invalid_operation");
  if (!isCanonicalNonzeroU64Decimal(value.local_executor_epoch)) validation("invalid_local_executor_epoch");
  if (typeof value.local_executor_holder_nonce !== "string"
    || !HEX64_RE.test(value.local_executor_holder_nonce)) {
    validation("invalid_local_executor_holder_nonce");
  }
  return Object.freeze({
    schema: SEDIMENT_WORKER_CANONICAL_CONTROL_SCHEMA,
    request_id: value.request_id,
    operation: value.operation,
    local_executor_epoch: value.local_executor_epoch,
    local_executor_holder_nonce: value.local_executor_holder_nonce,
  });
}

export function parseSedimentWorkerCanonicalControlArgs(
  args: string,
): SedimentWorkerCanonicalControlManifest {
  const trimmed = (args ?? "").trim();
  if (!trimmed) validation("empty_args");
  if (trimmed.includes("\n") || trimmed.includes("\r")) validation("multiline_args");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_CONTROL_ARGS_BYTES) validation("args_too_large");

  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed) || trimmed.length % 4 === 1) validation("args_not_base64url");
    const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bytes = Buffer.from(padded, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTROL_ARGS_BYTES) validation("args_too_large");
    const canonical = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (canonical !== trimmed) validation("args_not_base64url");
    text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) validation("args_not_json");
  }

  const parsed = parseStrictFlatJsonObject(text, () => validation("args_not_strict_json"));
  return validateSedimentWorkerCanonicalControlManifest(parsed);
}

export function validateCanonicalConvergenceAttestation(
  raw: unknown,
): CanonicalConvergenceAttestation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) unavailableAttestation();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== ATTESTATION_KEYS.size) unavailableAttestation();
  for (const key of Object.keys(value)) {
    if (!ATTESTATION_KEYS.has(key)) unavailableAttestation();
  }
  if (value.schema !== CANONICAL_CONVERGENCE_ATTESTATION_SCHEMA) unavailableAttestation();
  if (!isCanonicalNonzeroU64Decimal(value.local_executor_epoch)) unavailableAttestation();
  if (typeof value.local_executor_holder_nonce !== "string"
    || !HEX64_RE.test(value.local_executor_holder_nonce)) unavailableAttestation();
  if (!isCanonicalNonzeroU64Decimal(value.convergence_generation)) unavailableAttestation();
  if (value.outcome !== "pending" && value.outcome !== "ready" && value.outcome !== "blocked") {
    unavailableAttestation();
  }
  if (typeof value.reason_code !== "string" || !CONTROL_REASON_SET.has(value.reason_code)) {
    unavailableAttestation();
  }
  const reason = value.reason_code as CanonicalControlReasonCode;
  if (value.outcome === "ready") {
    if (reason !== "none" || typeof value.canonical_head !== "string"
      || !GIT_OID_RE.test(value.canonical_head)) unavailableAttestation();
  } else {
    if (value.canonical_head !== null) unavailableAttestation();
    if (value.outcome === "pending" && !PENDING_ATTESTATION_REASONS.has(reason)) unavailableAttestation();
    if (value.outcome === "blocked" && !BLOCKED_ATTESTATION_REASONS.has(reason)) unavailableAttestation();
  }
  if (typeof value.published_at_ms !== "number"
    || !Number.isSafeInteger(value.published_at_ms)
    || value.published_at_ms < 0) unavailableAttestation();
  return Object.freeze({
    schema: CANONICAL_CONVERGENCE_ATTESTATION_SCHEMA,
    local_executor_epoch: value.local_executor_epoch,
    local_executor_holder_nonce: value.local_executor_holder_nonce,
    convergence_generation: value.convergence_generation,
    outcome: value.outcome,
    reason_code: reason,
    canonical_head: value.canonical_head as string | null,
    published_at_ms: value.published_at_ms,
  });
}

function canonicalAbrainRoot(abrainHome: string): string {
  try {
    const canonical = fsSync.realpathSync.native(path.resolve(abrainHome));
    const stat = fsSync.lstatSync(canonical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailableAttestation();
    return canonical;
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    unavailableAttestation();
  }
}

function assertPrivateDirectory(directory: string): void {
  let stat: fsSync.Stats;
  try {
    stat = fsSync.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailableAttestation();
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) unavailableAttestation();
    if (fsSync.realpathSync.native(directory) !== directory) unavailableAttestation();
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    unavailableAttestation();
  }
}

function attestationPath(root: string): string {
  return path.join(root, CANONICAL_CONVERGENCE_RELATIVE_DIR, CANONICAL_CONVERGENCE_ATTESTATION_NAME);
}

function readAttestationSnapshotPosix(abrainHome: string): CanonicalAttestationSnapshotPosix | null {
  const root = canonicalAbrainRoot(abrainHome);
  const directory = path.join(root, CANONICAL_CONVERGENCE_RELATIVE_DIR);
  try {
    fsSync.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    unavailableAttestation();
  }
  assertPrivateDirectory(directory);

  const file = attestationPath(root);
  let named: fsSync.Stats;
  try {
    named = fsSync.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    unavailableAttestation();
  }
  if (named.isSymbolicLink() || !named.isFile()) unavailableAttestation();
  if ((named.mode & 0o777) !== 0o600) unavailableAttestation();
  if (named.size <= 0 || named.size > MAX_ATTESTATION_BYTES) unavailableAttestation();

  let fd: number | undefined;
  try {
    fd = fsSync.openSync(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) unavailableAttestation();
    if ((opened.mode & 0o777) !== 0o600) unavailableAttestation();
    if (opened.size <= 0 || opened.size > MAX_ATTESTATION_BYTES) unavailableAttestation();
    const bytes = fsSync.readFileSync(fd);
    if (bytes.byteLength !== opened.size) unavailableAttestation();
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) unavailableAttestation();
    const parsed = parseStrictFlatJsonObject(raw, unavailableAttestation);
    return {
      platform: "posix",
      attestation: validateCanonicalConvergenceAttestation(parsed),
      raw,
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    unavailableAttestation();
  } finally {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch { /* read-only cleanup */ }
    }
  }
  return unavailableAttestation();
}

function readAttestationSnapshotWindows(abrainHome: string): CanonicalAttestationSnapshotWindows | null {
  const addon = resolveWindowsDccAddon();
  if (!addon) unavailableAttestation();
  const root = canonicalAbrainRoot(abrainHome);
  const directory = path.join(root, CANONICAL_CONVERGENCE_RELATIVE_DIR);
  const file = attestationPath(root);

  try {
    const dirStat = fsSync.lstatSync(directory);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) unavailableAttestation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    unavailableAttestation();
  }

  try {
    verifyProtectedPath(addon, directory, "directory", "private_rw");
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    unavailableAttestation();
  }

  try {
    const named = fsSync.lstatSync(file);
    if (named.isSymbolicLink() || !named.isFile()) unavailableAttestation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    unavailableAttestation();
  }

  let read: ReturnType<typeof readProtectedFile>;
  try {
    read = readProtectedFile(addon, file, MAX_ATTESTATION_BYTES);
  } catch (error) {
    if (error instanceof WindowsNativeAddonError && error.code === "WINDOWS_NATIVE_ADDON_NOT_FOUND") {
      // Parent disappearance (PATH_NOT_FOUND) must not look like clean-slate missing file.
      // Directory still present → true missing leaf → null; otherwise fail-closed.
      try {
        const recheck = fsSync.lstatSync(directory);
        if (recheck.isSymbolicLink() || !recheck.isDirectory()) unavailableAttestation();
        return null;
      } catch {
        unavailableAttestation();
      }
    }
    if (error instanceof CanonicalAttestationError) throw error;
    unavailableAttestation();
  }

  if (read.data.byteLength <= 0 || read.data.byteLength > MAX_ATTESTATION_BYTES) unavailableAttestation();
  if (read.identity.size !== read.data.byteLength) unavailableAttestation();
  const raw = read.data.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(read.data)) unavailableAttestation();
  const parsed = parseStrictFlatJsonObject(raw, unavailableAttestation);
  return {
    platform: "win32",
    attestation: validateCanonicalConvergenceAttestation(parsed),
    raw,
    volume_serial_number: read.identity.volume_serial_number,
    file_id: read.identity.file_id,
    size: read.identity.size,
  };
}

function readAttestationSnapshot(abrainHome: string): CanonicalAttestationSnapshot | null {
  if (process.platform === "win32") {
    return readAttestationSnapshotWindows(abrainHome);
  }
  return readAttestationSnapshotPosix(abrainHome);
}

export function canonicalConvergenceAttestationPath(abrainHome: string): string {
  return attestationPath(path.resolve(abrainHome));
}

export function readCanonicalConvergenceAttestation(
  abrainHome: string,
): CanonicalConvergenceAttestation | null {
  // Real process.platform only — no deps override for production gate.
  // Windows: production zero-arg addon (or ALS test inject) must be available.
  if (process.platform === "win32") {
    if (!resolveWindowsDccAddon()) unavailableAttestation();
  } else if (!isDccAttestationPlatformSupported(process.platform)) {
    unavailableAttestation();
  }
  return readAttestationSnapshot(abrainHome)?.attestation ?? null;
}

/** Closed aggregate for TUI/foreground six-condition observation (ADR 0046 D5).
 * Never carries exact epoch/nonce/head/path/generation. */
export const FOREGROUND_CANONICAL_CONVERGENCE_OBSERVATION_STATUSES = [
  "ready",
  "blocked",
  "legacy",
  "unavailable",
] as const;
export type ForegroundCanonicalConvergenceObservationStatus =
  (typeof FOREGROUND_CANONICAL_CONVERGENCE_OBSERVATION_STATUSES)[number];

export const FOREGROUND_CANONICAL_CONVERGENCE_OBSERVATION_REASONS = [
  "none",
  "not_authorized",
  "authority_unavailable",
  "authority_revoked",
  "authority_stale",
  "attestation_unavailable",
  "attestation_not_ready",
  "head_mismatch",
  "observation_unstable",
] as const;
export type ForegroundCanonicalConvergenceObservationReason =
  (typeof FOREGROUND_CANONICAL_CONVERGENCE_OBSERVATION_REASONS)[number];

export interface ForegroundCanonicalConvergenceObservation {
  readonly status: ForegroundCanonicalConvergenceObservationStatus;
  readonly reason_code: ForegroundCanonicalConvergenceObservationReason;
}

export interface ForegroundCanonicalConvergenceObservationDeps {
  /** Gated test override; production uses real LSEA lock/record observation. */
  authorityObservation?: LocalExecutorAuthorityObservationDeps;
  /** Gated test override; production uses isolated GIT_OPTIONAL_LOCKS=0 HEAD read. */
  readCanonicalHead?: (abrainHome: string) => Promise<string>;
  /** Gated test override; production defaults to process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Test-only Windows DCC physical-layer addon (temp package).
   * Production uses zero-arg loadWindowsNativeAddon(). Gated by test hooks env.
   */
  windowsDccNativeAddon?: WindowsNativeAddonModuleV1;
}

function observationResult(
  status: ForegroundCanonicalConvergenceObservationStatus,
  reason_code: ForegroundCanonicalConvergenceObservationReason,
): ForegroundCanonicalConvergenceObservation {
  return Object.freeze({ status, reason_code });
}

function assertForegroundObservationTestHooks(
  deps: ForegroundCanonicalConvergenceObservationDeps,
): boolean {
  const injected = deps.authorityObservation !== undefined
    || deps.readCanonicalHead !== undefined
    || deps.platform !== undefined
    || deps.windowsDccNativeAddon !== undefined;
  if (!injected) return true;
  return process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1";
}

/**
 * Strict read-only TUI/foreground canonical convergence observation (six conditions).
 *
 * - store absent → legacy / not_authorized
 * - store present → ready only when all six conditions hold
 * - never creates attestation/runtime/promise/timer, never kicks, never applies
 *   continuation, never mutates Git; does not read daemon status
 * - attestation bytes/identity must be stable across authority + HEAD observation
 * - closed aggregate only (no exact epoch/nonce/head/path/generation)
 */
export async function observeForegroundCanonicalConvergence(
  abrainHome: string,
  deps: ForegroundCanonicalConvergenceObservationDeps = {},
): Promise<ForegroundCanonicalConvergenceObservation> {
  if (!assertForegroundObservationTestHooks(deps)) {
    return observationResult("unavailable", "attestation_unavailable");
  }

  // Store-absent classifier first (including win32): legacy/not_authorized.
  // Platform fail-closed applies only after store-present is established.
  try {
    const early = observeLocalExecutorAuthorityStore(
      abrainHome,
      deps.authorityObservation ?? {},
    );
    if (early.presence === "absent") {
      return observationResult("legacy", "not_authorized");
    }
  } catch {
    return observationResult("unavailable", "authority_unavailable");
  }

  const platform = deps.platform ?? process.platform;
  const testAddon = assertWindowsDccTestSeamAllowed(deps.windowsDccNativeAddon);
  if (!isDccControlPlatformReady(platform, testAddon)) {
    return observationResult("unavailable", "attestation_unavailable");
  }

  return withWindowsDccAddonAsync(testAddon, async () => {
    // Stability sandwich: attestation → authority → HEAD → attestation.
    let before: CanonicalAttestationSnapshot | null;
    try {
      before = readAttestationSnapshot(abrainHome);
    } catch {
      return observationResult("unavailable", "attestation_unavailable");
    }
    if (!before) {
      return observationResult("unavailable", "attestation_unavailable");
    }

    let authority: ReturnType<typeof observeLocalExecutorAuthorityStore>;
    try {
      authority = observeLocalExecutorAuthorityStore(
        abrainHome,
        deps.authorityObservation ?? {},
      );
    } catch {
      return observationResult("unavailable", "authority_unavailable");
    }
    if (authority.presence === "absent") {
      // Store disappeared mid-observation — fail closed (not legacy recovery).
      return observationResult("unavailable", "authority_unavailable");
    }

    let head: string;
    try {
      head = deps.readCanonicalHead
        ? await deps.readCanonicalHead(abrainHome)
        : await readCanonicalHeadOid(abrainHome);
      if (typeof head !== "string" || !GIT_OID_RE.test(head)) {
        return observationResult("blocked", "head_mismatch");
      }
    } catch {
      return observationResult("blocked", "head_mismatch");
    }

    let after: CanonicalAttestationSnapshot | null;
    try {
      after = readAttestationSnapshot(abrainHome);
    } catch {
      return observationResult("unavailable", "attestation_unavailable");
    }
    if (!sameSnapshot(before, after)) {
      return observationResult("unavailable", "observation_unstable");
    }

    // Condition evaluation on the stable attestation + authority snapshot.
    if (authority.record.mode !== "held" || authority.record.holder_kind !== "daemon") {
      return observationResult("blocked", "authority_revoked");
    }
    if (authority.lock !== "held") {
      return observationResult("blocked", "authority_revoked");
    }
    if (before.attestation.local_executor_epoch !== authority.record.local_executor_epoch
      || before.attestation.local_executor_holder_nonce !== authority.record.holder_nonce) {
      return observationResult("unavailable", "authority_stale");
    }
    if (before.attestation.outcome !== "ready") {
      return observationResult("blocked", "attestation_not_ready");
    }
    if (before.attestation.canonical_head !== head) {
      return observationResult("blocked", "head_mismatch");
    }
    return observationResult("ready", "none");
  });
}

/** Closed operator-facing lines for /abrain status. No secrets. */
export function formatForegroundCanonicalConvergenceObservation(
  observation: ForegroundCanonicalConvergenceObservation,
): string {
  const clean = sanitizeForegroundCanonicalConvergenceObservation(observation);
  if (!clean) {
    return [
      "Canonical convergence: unavailable",
      "  reason: attestation_unavailable",
    ].join("\n");
  }
  return [
    `Canonical convergence: ${clean.status}`,
    `  reason: ${clean.reason_code}`,
  ].join("\n");
}

export function sanitizeForegroundCanonicalConvergenceObservation(
  raw: unknown,
): ForegroundCanonicalConvergenceObservation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("status") || !keys.includes("reason_code")) return null;
  if (typeof value.status !== "string"
    || !(FOREGROUND_CANONICAL_CONVERGENCE_OBSERVATION_STATUSES as readonly string[]).includes(value.status)
    || typeof value.reason_code !== "string"
    || !(FOREGROUND_CANONICAL_CONVERGENCE_OBSERVATION_REASONS as readonly string[]).includes(value.reason_code)) {
    return null;
  }
  const status = value.status as ForegroundCanonicalConvergenceObservationStatus;
  const reason = value.reason_code as ForegroundCanonicalConvergenceObservationReason;
  // Cross-field closed invariants (no free-text).
  if (status === "ready" && reason !== "none") return null;
  if (status === "legacy" && reason !== "not_authorized") return null;
  if (status === "blocked"
    && reason !== "authority_revoked"
    && reason !== "attestation_not_ready"
    && reason !== "head_mismatch") return null;
  if (status === "unavailable"
    && reason !== "authority_unavailable"
    && reason !== "authority_stale"
    && reason !== "attestation_unavailable"
    && reason !== "observation_unstable") return null;
  return observationResult(status, reason);
}

function assertExistingAttestationParent(root: string): string {
  const parent = path.join(root, ".state", "sediment");
  try {
    const stat = fsSync.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) writeFailedAttestation();
    if (fsSync.realpathSync.native(parent) !== parent) writeFailedAttestation();
    return parent;
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    writeFailedAttestation();
  }
}

async function ensureAttestationDirectoryPosix(root: string): Promise<string> {
  const parent = assertExistingAttestationParent(root);
  const directory = path.join(root, CANONICAL_CONVERGENCE_RELATIVE_DIR);
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
    await fs.chmod(directory, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") writeFailedAttestation();
  }
  try {
    assertPrivateDirectory(directory);
    if (created) await fsyncDirectory(parent);
    return directory;
  } catch {
    writeFailedAttestation();
  }
}

function ensureAttestationDirectoryWindows(root: string): string {
  const addon = resolveWindowsDccAddon();
  if (!addon) unavailableAttestation();
  assertExistingAttestationParent(root);
  const directory = path.join(root, CANONICAL_CONVERGENCE_RELATIVE_DIR);
  try {
    ensureProtectedDirectory(addon, directory);
    verifyProtectedPath(addon, directory, "directory", "private_rw");
    return directory;
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    writeFailedAttestation();
  }
}

function sameSnapshot(
  current: CanonicalAttestationSnapshot | null,
  expected: CanonicalAttestationSnapshot | null,
): boolean {
  if (current === null || expected === null) return current === expected;
  if (current.raw !== expected.raw) return false;
  if (current.platform !== expected.platform) return false;
  if (current.platform === "win32" && expected.platform === "win32") {
    return current.volume_serial_number === expected.volume_serial_number
      && current.file_id === expected.file_id
      && current.size === expected.size;
  }
  if (current.platform === "posix" && expected.platform === "posix") {
    return current.dev === expected.dev && current.ino === expected.ino;
  }
  return false;
}

/**
 * Cross-process CAS lock for the DCC attestation directory.
 * Locks the attestation directory itself (not abrain root) so it cannot re-enter
 * deadlock with the canonical root mutation barrier.
 * Windows: native retained mutex (no TS lockfile). Linux: OFD via adapter.
 * BUSY → attestation_write_failed. Hold across the full async write; close in finally.
 * Primary operation error is preserved over close failure; sole close failure surfaces.
 */
async function withAttestationDirectoryLock<T>(
  directory: string,
  operation: (lock: RetainedDirectoryLock & { status: "ACQUIRED" }) => Promise<T>,
): Promise<T> {
  let lock: RetainedDirectoryLock;
  try {
    lock = acquireRetainedDirectoryLock(directory);
  } catch (error) {
    if (error instanceof CanonicalAttestationError) throw error;
    if (error instanceof RetainedDirectoryLockError) writeFailedAttestation();
    writeFailedAttestation();
  }
  if (lock.status === "BUSY") writeFailedAttestation();
  const acquired = lock as RetainedDirectoryLock & { status: "ACQUIRED" };
  let primaryError: unknown;
  let value: T | undefined;
  try {
    value = await operation(acquired);
  } catch (error) {
    primaryError = error;
  }
  try {
    acquired.close();
  } catch (closeError) {
    if (primaryError === undefined) {
      if (closeError instanceof CanonicalAttestationError) throw closeError;
      writeFailedAttestation();
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return value as T;
}

async function writeCanonicalConvergenceAttestationWindows(
  root: string,
  attestation: CanonicalConvergenceAttestation,
  expected: CanonicalAttestationSnapshot | null,
): Promise<void> {
  const addon = resolveWindowsDccAddon();
  if (!addon) unavailableAttestation();
  validateCanonicalConvergenceAttestation(attestation);
  // Ensure directory exists before lock (lock requires an existing directory).
  const directory = ensureAttestationDirectoryWindows(root);
  const target = attestationPath(root);
  const raw = `${JSON.stringify(attestation)}\n`;
  const data = Buffer.from(raw, "utf8");

  await withAttestationDirectoryLock(directory, async () => {
    let current: CanonicalAttestationSnapshot | null;
    try {
      current = readAttestationSnapshot(root);
    } catch {
      writeFailedAttestation();
    }
    if (!sameSnapshot(current, expected)) writeFailedAttestation();

    try {
      if (expected === null) {
        // First write: no-replace native create under the same lock lease.
        // Reconfirm absent (above) then create-only; collision → write_failed.
        const created = durableAtomicCreateFile(addon, target, data);
        if (!created) writeFailedAttestation();
      } else {
        // Parent dir is private_rw (ensured above); native replace enforces parent gate + DACL.
        durableAtomicReplaceFile(addon, target, data);
      }
    } catch (error) {
      if (error instanceof CanonicalAttestationError) throw error;
      writeFailedAttestation();
    }

    let readBack: CanonicalAttestationSnapshot | null;
    try {
      readBack = readAttestationSnapshot(root);
    } catch {
      writeFailedAttestation();
    }
    if (!readBack || readBack.raw !== raw) writeFailedAttestation();
  });
}

async function writeCanonicalConvergenceAttestationPosix(
  root: string,
  attestation: CanonicalConvergenceAttestation,
  expected: CanonicalAttestationSnapshot | null,
): Promise<void> {
  validateCanonicalConvergenceAttestation(attestation);
  const directory = await ensureAttestationDirectoryPosix(root);
  const target = attestationPath(root);
  const raw = `${JSON.stringify(attestation)}\n`;
  const temp = path.join(
    directory,
    `.${CANONICAL_CONVERGENCE_ATTESTATION_NAME}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );

  // Hold retained OFD lock across the entire async write window (not just rename).
  await withAttestationDirectoryLock(directory, async () => {
    let handle: fs.FileHandle | undefined;
    try {
      // Re-check expected under the lock before publishing.
      let current: CanonicalAttestationSnapshot | null;
      try {
        current = readAttestationSnapshot(root);
      } catch {
        writeFailedAttestation();
      }
      if (!sameSnapshot(current, expected)) writeFailedAttestation();

      if (expected === null) {
        // First write create-only: O_EXCL on the final path is not portable with rename;
        // reconfirm absent under lock then temp+rename. Concurrent first writers serialize
        // on the retained lock; the second re-read sees non-null and fails CAS.
        if (current !== null) writeFailedAttestation();
      }

      handle = await fs.open(temp, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(raw, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      // Second compare immediately before rename (still under lock).
      try {
        current = readAttestationSnapshot(root);
      } catch {
        writeFailedAttestation();
      }
      if (!sameSnapshot(current, expected)) writeFailedAttestation();

      if (expected === null) {
        // create-only: refuse replace if leaf appeared between checks.
        try {
          await fs.access(target);
          writeFailedAttestation();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") writeFailedAttestation();
        }
      }

      await fs.rename(temp, target);
      await fsyncDirectory(directory);
      const readBack = readAttestationSnapshot(root);
      if (!readBack || readBack.raw !== raw) writeFailedAttestation();
    } catch (error) {
      if (error instanceof CanonicalAttestationError) throw error;
      writeFailedAttestation();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  });
}

async function writeCanonicalConvergenceAttestation(
  root: string,
  attestation: CanonicalConvergenceAttestation,
  expected: CanonicalAttestationSnapshot | null,
): Promise<void> {
  // Defense-in-depth: Windows requires native physical layer (production or test inject).
  if (process.platform === "win32") {
    if (!resolveWindowsDccAddon()) unavailableAttestation();
    await writeCanonicalConvergenceAttestationWindows(root, attestation, expected);
    return;
  }
  await writeCanonicalConvergenceAttestationPosix(root, attestation, expected);
}

function peekControlState(): CanonicalControlProcessState | null {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[CONTROL_STATE_KEY] as CanonicalControlProcessState | undefined;
  if (!existing || existing.apiVersion !== CONTROL_STATE_API_VERSION
    || !(existing.active instanceof Map) || !(existing.aggregate instanceof Map)) return null;
  return existing;
}

function controlState(): CanonicalControlProcessState {
  const existing = peekControlState();
  if (existing) return existing;
  const created: CanonicalControlProcessState = {
    apiVersion: CONTROL_STATE_API_VERSION,
    active: new Map(),
    aggregate: new Map(),
  };
  (globalThis as Record<symbol, unknown>)[CONTROL_STATE_KEY] = created;
  return created;
}

function assertTestHooksEnabled(deps: SedimentWorkerCanonicalControlDeps): void {
  if (deps.testHooks && process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") validation("test_hooks_disabled");
  if (deps.windowsDccNativeAddon !== undefined && process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    validation("test_hooks_disabled");
  }
  // platform override is a test seam; gate the same as other hooks.
  if (deps.platform !== undefined && process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    validation("test_hooks_disabled");
  }
}

function result(args: {
  request_id: string;
  operation: CanonicalControlOperation;
  status: CanonicalControlStatus;
  reason_code: CanonicalControlReasonCode;
  convergence_generation?: string | null;
  retryable: boolean;
}): SedimentWorkerCanonicalControlResult {
  return Object.freeze({
    schema: SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_SCHEMA,
    request_id: args.request_id,
    operation: args.operation,
    status: args.status,
    reason_code: args.reason_code,
    convergence_generation: args.convergence_generation ?? null,
    retryable: args.retryable,
  });
}

function authorityFailureResult(
  manifest: SedimentWorkerCanonicalControlManifest,
  error: unknown,
): SedimentWorkerCanonicalControlResult {
  let reason: CanonicalControlReasonCode = "authority_unavailable";
  if (error instanceof LocalExecutorAuthorityAdmissionError) {
    if (error.code === "local_executor_authority_stale") reason = "authority_stale";
    else if (error.code === "local_executor_authority_revoked") reason = "authority_revoked";
  }
  return result({
    request_id: manifest.request_id,
    operation: manifest.operation,
    status: "unavailable",
    reason_code: reason,
    retryable: true,
  });
}

function nextConvergenceGeneration(
  current: CanonicalAttestationSnapshot | null,
  epoch: string,
  nonce: string,
): string {
  if (!current
    || current.attestation.local_executor_epoch !== epoch
    || current.attestation.local_executor_holder_nonce !== nonce) return "1";
  const generation = BigInt(current.attestation.convergence_generation);
  if (generation >= U64_MAX) validation("generation_overflow");
  return String(generation + 1n);
}

function nowMs(hooks: CanonicalControlTestHooks | undefined): number {
  const value = hooks?.now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) writeFailedAttestation();
  return value;
}

function pendingAttestation(
  active: ActiveCanonicalKick,
  reason_code: CanonicalControlReasonCode,
  hooks: CanonicalControlTestHooks | undefined,
): CanonicalConvergenceAttestation {
  return {
    schema: CANONICAL_CONVERGENCE_ATTESTATION_SCHEMA,
    local_executor_epoch: active.local_executor_epoch,
    local_executor_holder_nonce: active.local_executor_holder_nonce,
    convergence_generation: active.convergence_generation,
    outcome: "pending",
    reason_code,
    canonical_head: null,
    published_at_ms: nowMs(hooks),
  };
}

function aggregateFor(
  active: ActiveCanonicalKick,
  status: CanonicalControlStatus,
  reason_code: CanonicalControlReasonCode,
  retryable: boolean,
  convergence_generation: string | null = active.convergence_generation,
): CanonicalControlAggregate {
  return Object.freeze({
    local_executor_epoch: active.local_executor_epoch,
    local_executor_holder_nonce: active.local_executor_holder_nonce,
    convergence_generation,
    status,
    reason_code,
    retryable,
  });
}

/** True only while this kick token is still the process-active settle owner. */
function isActiveKickToken(active: ActiveCanonicalKick): boolean {
  return controlState().active.get(active.root)?.token === active.token;
}

/** Aggregate writes from settle must never clobber a newer generation. */
function setAggregateIfActive(
  active: ActiveCanonicalKick,
  status: CanonicalControlStatus,
  reason_code: CanonicalControlReasonCode,
  retryable: boolean,
  convergence_generation: string | null = active.convergence_generation,
): void {
  if (!isActiveKickToken(active)) return;
  controlState().aggregate.set(
    active.root,
    aggregateFor(active, status, reason_code, retryable, convergence_generation),
  );
}

function matchingAggregate(
  aggregate: CanonicalControlAggregate | undefined,
  attestation: CanonicalConvergenceAttestation,
): aggregate is CanonicalControlAggregate {
  return !!aggregate
    && aggregate.local_executor_epoch === attestation.local_executor_epoch
    && aggregate.local_executor_holder_nonce === attestation.local_executor_holder_nonce
    && aggregate.convergence_generation === attestation.convergence_generation;
}

function mapDeferredReason(
  reason: CanonicalRuntimeDiagnostics["deferredReason"] | CanonicalRuntimePeek["deferredReason"],
): CanonicalControlReasonCode {
  if (reason === "CANONICAL_MUTATION_BUSY") return "canonical_mutation_busy";
  if (reason === "CANONICAL_SCAN_BUSY") return "canonical_scan_busy";
  if (reason === "CANONICAL_SCAN_LOCK_FAILED") return "canonical_scan_lock_failed";
  return "startup_budget_exhausted";
}

async function readExactCanonicalHead(abrainHome: string): Promise<string> {
  // Same Git isolation as canonical-git-runtime (config=/dev/null, prompt off).
  const head = await readCanonicalHeadOid(abrainHome);
  if (!GIT_OID_RE.test(head)) throw new Error("canonical_head_invalid");
  return head;
}

function settleShape(
  diagnostics: CanonicalRuntimeDiagnostics,
): { outcome: CanonicalConvergenceOutcome; reason: CanonicalControlReasonCode; retryable: boolean } {
  if (diagnostics.startup === "ready") return { outcome: "ready", reason: "none", retryable: false };
  if (diagnostics.startup === "deferred") {
    return { outcome: "pending", reason: mapDeferredReason(diagnostics.deferredReason), retryable: true };
  }
  if (diagnostics.startup === "running" || diagnostics.startup === "not_started") {
    return { outcome: "pending", reason: "startup_running", retryable: true };
  }
  return {
    outcome: "blocked",
    reason: diagnostics.ownerAlert ? "owner_intervention_required" : "startup_blocked",
    retryable: false,
  };
}

async function defaultInspectBindIntentInventory(abrainHome: string): Promise<{
  pending: number;
  failed: number;
  invalid: number;
}> {
  const bindIntent = await import("../abrain/bind-intent");
  return bindIntent.inspectAbrainBindIntentInventory(abrainHome);
}

async function defaultApplyBindIntents(abrainHome: string): Promise<{
  applied: number;
  pending: number;
  failed: number;
}> {
  const bindIntent = await import("../abrain/bind-intent");
  return bindIntent.applyAllPendingAbrainBindIntents(abrainHome);
}

/**
 * Cheap ready-state backlog/worktree probe (observe only).
 *
 * - Read-only porcelain v1 status under the shared Git isolation env
 *   (GIT_OPTIONAL_LOCKS=0, prompts off, no global/system config).
 * - Touches only path presence under l1/ or l2/ — never whole-L1 validate,
 *   never mutate, never network.
 * - Closed result only: "none" | "pending". Never returns path/count/OID.
 */
function defaultProbeCanonicalBacklog(abrainHome: string): "none" | "pending" {
  let root: string;
  try {
    root = fsSync.realpathSync.native(path.resolve(abrainHome));
  } catch {
    return "pending";
  }
  let raw: Buffer;
  try {
    raw = execFileSync(
      "git",
      [
        "-C",
        root,
        "--literal-pathspecs",
        "status",
        "--porcelain=v1",
        "-z",
        "-uall",
        "--ignore-submodules=none",
      ],
      {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedCanonicalGitEnvironment(),
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    ) as Buffer;
  } catch {
    // Fail closed: surface retryable drift so daemon can fresh-kick.
    return "pending";
  }
  let rows: ReturnType<typeof parseGitStatusPorcelainV1Z>;
  try {
    rows = parseGitStatusPorcelainV1Z(raw);
  } catch {
    return "pending";
  }
  for (const row of rows) {
    if (row.paths.some((item) => item.startsWith("l1/") || item.startsWith("l2/"))) {
      return "pending";
    }
  }
  return "none";
}

/**
 * Ready attestation cheap zero-side-effect drift probe for observe.
 * Compares live HEAD, bind inventory, and l1/l2 porcelain backlog.
 * Never writes attestation/runtime, never kicks, never applies continuation,
 * never runs whole-L1, never networks. Closed aggregate only (no exact
 * head/path/count leak).
 */
async function observeReadyDrift(
  root: string,
  manifest: SedimentWorkerCanonicalControlManifest,
  attestation: CanonicalConvergenceAttestation,
  hooks: CanonicalControlTestHooks | undefined,
): Promise<SedimentWorkerCanonicalControlResult> {
  const generation = attestation.convergence_generation;

  // 1) live HEAD vs private attestation canonical_head (exact; never expose OID).
  try {
    const head = await (hooks?.readCanonicalHead?.(root) ?? readExactCanonicalHead(root));
    if (typeof head !== "string" || !GIT_OID_RE.test(head) || head !== attestation.canonical_head) {
      return result({
        request_id: manifest.request_id,
        operation: "observe",
        status: "pending",
        reason_code: "canonical_head_changed",
        convergence_generation: generation,
        retryable: true,
      });
    }
  } catch {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "pending",
      reason_code: "canonical_head_changed",
      convergence_generation: generation,
      retryable: true,
    });
  }

  // 2) bind-intent inventory (inspect only — never apply).
  try {
    const inspect = hooks?.inspectBindIntentInventory ?? defaultInspectBindIntentInventory;
    const inventory = await inspect(root);
    if (inventory.failed > 0 || inventory.invalid > 0) {
      return result({
        request_id: manifest.request_id,
        operation: "observe",
        status: "blocked",
        reason_code: "continuation_failed",
        convergence_generation: generation,
        retryable: false,
      });
    }
    if (inventory.pending > 0) {
      return result({
        request_id: manifest.request_id,
        operation: "observe",
        status: "pending",
        reason_code: "continuation_pending",
        convergence_generation: generation,
        retryable: true,
      });
    }
  } catch {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "pending",
      reason_code: "continuation_pending",
      convergence_generation: generation,
      retryable: true,
    });
  }

  // 3) cheap canonical backlog / worktree drift under l1|l2 only.
  try {
    const backlog = hooks?.probeCanonicalBacklog
      ? await hooks.probeCanonicalBacklog(root)
      : defaultProbeCanonicalBacklog(root);
    if (backlog === "pending") {
      return result({
        request_id: manifest.request_id,
        operation: "observe",
        status: "pending",
        reason_code: "canonical_backlog_pending",
        convergence_generation: generation,
        retryable: true,
      });
    }
  } catch {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "pending",
      reason_code: "canonical_backlog_pending",
      convergence_generation: generation,
      retryable: true,
    });
  }

  return resultFromAttestation(manifest, attestation);
}

/**
 * After whole-L1 diagnostics are ready and before final HEAD / ready attestation:
 * authority-admitted DCC worker replays durable abrain bind intents.
 * failed/invalid inventory blocks (continuation_failed); residual pending or
 * apply/inspect faults stay pending (continuation_pending). Observe never calls this.
 */
async function settleBindContinuation(
  abrainHome: string,
  hooks: CanonicalControlTestHooks | undefined,
): Promise<{ outcome: CanonicalConvergenceOutcome; reason: CanonicalControlReasonCode; retryable: boolean }> {
  const inspect = hooks?.inspectBindIntentInventory ?? defaultInspectBindIntentInventory;
  const apply = hooks?.applyBindIntents ?? defaultApplyBindIntents;
  try {
    const before = await inspect(abrainHome);
    if (before.failed > 0 || before.invalid > 0) {
      return { outcome: "blocked", reason: "continuation_failed", retryable: false };
    }
    let appliedResult: { applied: number; pending: number; failed: number };
    try {
      appliedResult = await apply(abrainHome);
    } catch (error) {
      if (isCanonicalMutationAuthorityError(error)) {
        return { outcome: "blocked", reason: "startup_failed", retryable: true };
      }
      return { outcome: "pending", reason: "continuation_pending", retryable: true };
    }
    let after: { pending: number; failed: number; invalid: number };
    try {
      after = await inspect(abrainHome);
    } catch {
      return { outcome: "pending", reason: "continuation_pending", retryable: true };
    }
    if (after.failed > 0 || after.invalid > 0 || appliedResult.failed > 0) {
      return { outcome: "blocked", reason: "continuation_failed", retryable: false };
    }
    if (after.pending > 0 || appliedResult.pending > 0) {
      return { outcome: "pending", reason: "continuation_pending", retryable: true };
    }
    return { outcome: "ready", reason: "none", retryable: false };
  } catch (error) {
    if (isCanonicalMutationAuthorityError(error)) {
      return { outcome: "blocked", reason: "startup_failed", retryable: true };
    }
    return { outcome: "pending", reason: "continuation_pending", retryable: true };
  }
}

async function settleActiveKick(
  active: ActiveCanonicalKick,
  shape: { outcome: CanonicalConvergenceOutcome; reason: CanonicalControlReasonCode; retryable: boolean },
  hooks: CanonicalControlTestHooks | undefined,
): Promise<void> {
  const state = controlState();
  try {
    // Old-generation settle must never write aggregate after a newer kick owns active.
    if (!isActiveKickToken(active)) return;

    let current: CanonicalAttestationSnapshot | null;
    try {
      current = readAttestationSnapshot(active.root);
    } catch {
      // blocked/attestation_unavailable → generation must be null (strict protocol).
      setAggregateIfActive(active, "blocked", "attestation_unavailable", true, null);
      return;
    }
    if (!current
      || current.attestation.local_executor_epoch !== active.local_executor_epoch
      || current.attestation.local_executor_holder_nonce !== active.local_executor_holder_nonce
      || current.attestation.convergence_generation !== active.convergence_generation
      || current.attestation.outcome !== "pending") {
      // Stale or mismatched durable attestation: only write if we still own active.
      setAggregateIfActive(active, "blocked", "attestation_unavailable", true, null);
      return;
    }

    let canonicalHead: string | null = null;
    let finalShape = shape;
    // Never settle a convergence result under a lease that was revoked while
    // whole-L1 ran, including diagnostics that would otherwise map blocked.
    try {
      await assertCanonicalMutationAuthorized(active.root);
    } catch {
      finalShape = { outcome: "blocked", reason: "startup_failed", retryable: true };
    }
    if (finalShape.outcome === "ready") {
      // Bind continuation must complete before exact HEAD publish / ready attestation.
      finalShape = await settleBindContinuation(active.root, hooks);
      if (!isActiveKickToken(active)) return;
      if (finalShape.outcome === "ready") {
        try {
          await assertCanonicalMutationAuthorized(active.root);
        } catch {
          finalShape = { outcome: "blocked", reason: "startup_failed", retryable: true };
        }
      }
      if (finalShape.outcome === "ready") {
        try {
          canonicalHead = await (hooks?.readCanonicalHead?.(active.root) ?? readExactCanonicalHead(active.root));
          if (!GIT_OID_RE.test(canonicalHead)) throw new Error("canonical_head_invalid");
        } catch {
          finalShape = { outcome: "blocked", reason: "startup_failed", retryable: true };
          canonicalHead = null;
        }
      }
    }
    if (!isActiveKickToken(active)) return;
    const attestation: CanonicalConvergenceAttestation = {
      schema: CANONICAL_CONVERGENCE_ATTESTATION_SCHEMA,
      local_executor_epoch: active.local_executor_epoch,
      local_executor_holder_nonce: active.local_executor_holder_nonce,
      convergence_generation: active.convergence_generation,
      outcome: finalShape.outcome,
      reason_code: finalShape.reason,
      canonical_head: canonicalHead,
      published_at_ms: nowMs(hooks),
    };
    try {
      await writeCanonicalConvergenceAttestation(active.root, attestation, current);
      setAggregateIfActive(
        active,
        finalShape.outcome === "ready" ? "ready" : finalShape.outcome,
        finalShape.reason,
        finalShape.retryable,
      );
    } catch {
      // blocked/attestation_write_failed → generation must be nonnull.
      setAggregateIfActive(active, "blocked", "attestation_write_failed", true);
    }
  } catch {
    setAggregateIfActive(active, "blocked", "attestation_write_failed", true);
  } finally {
    if (state.active.get(active.root)?.token === active.token) state.active.delete(active.root);
  }
}

/**
 * Commit authority-executor layout-repair updates to tracked `.gitignore` via
 * the unified CanonicalRefMovePrimitive CAS path (prepareExactCohortCommit +
 * publishExactCohortCommit purpose=exact_cohort_publish). Bare `git commit`
 * tip movers are forbidden. Open/quarantined recovery episodes block the move
 * (OpenQuarantineGate). Failures throw closed short code only.
 *
 * Must already be inside withCanonicalMutationAuthority ∘ barrier.
 */
async function commitAuthorityLayoutGitignore(abrainHome: string): Promise<void> {
  let root: string;
  try {
    root = fsSync.realpathSync.native(path.resolve(abrainHome));
  } catch {
    throw new Error("layout_gitignore_commit_failed");
  }

  const env = sanitizedCanonicalGitEnvironment();
  const gitBase = {
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    env,
  };

  let toplevel: string;
  try {
    toplevel = execFileSync(
      "git",
      ["-C", root, "--literal-pathspecs", "rev-parse", "--show-toplevel"],
      { ...gitBase, timeout: 3_000 },
    ).replace(/\r?\n$/, "");
  } catch {
    throw new Error("layout_gitignore_commit_failed");
  }
  let toplevelReal: string;
  try {
    toplevelReal = fsSync.realpathSync.native(toplevel);
  } catch {
    throw new Error("layout_gitignore_commit_failed");
  }
  if (toplevelReal !== root) {
    throw new Error("layout_gitignore_commit_failed");
  }

  let refName: string;
  try {
    refName = execFileSync(
      "git",
      ["-C", root, "--literal-pathspecs", "symbolic-ref", "-q", "HEAD"],
      { ...gitBase, timeout: 3_000 },
    ).replace(/\r?\n$/, "");
  } catch {
    throw new Error("layout_gitignore_commit_failed");
  }
  if (!/^refs\/heads\//.test(refName)) {
    throw new Error("layout_gitignore_commit_failed");
  }

  let gitignoreBytes: Buffer;
  try {
    gitignoreBytes = fsSync.readFileSync(path.join(root, ".gitignore"));
  } catch {
    throw new Error("layout_gitignore_commit_failed");
  }

  try {
    const frozenCommit = await resolveRef(root, refName);
    // No-op when HEAD:.gitignore already equals worktree bytes.
    try {
      const headBytes = execFileSync(
        "git",
        ["-C", root, "--literal-pathspecs", "show", `${frozenCommit}:.gitignore`],
        { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, env, stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 },
      ) as Buffer;
      if (Buffer.compare(headBytes, gitignoreBytes) === 0) return;
    } catch {
      // missing HEAD path → proceed with put
    }

    // Freeze shared-index snapshot before prepare so post-publish converge can
    // detect owned-path conflicts and leave non-cohort staged entries intact.
    const frozenIndexSnapshot = await snapshotIndexEntries(root, [".gitignore"]);
    const prepared = await prepareExactCohortCommit({
      repo: root,
      refName,
      frozenCommit,
      plan: [{ path: ".gitignore", op: "put", mode: "100644", content: gitignoreBytes }],
      message: "layout-gitignore-repair",
      protocolVersion: "local-drain-recovery/v3",
    });
    // Open episode ⇒ exact_cohort_publish blocked by primitive OpenQuarantineGate.
    const result = await publishExactCohortCommit({
      repo: root,
      abrainHome: root,
      refName,
      candidate: prepared.candidate,
      frozenCommit,
      purpose: "exact_cohort_publish",
    });
    if (result.status !== "published" && result.status !== "already_published") {
      throw new Error("layout_gitignore_commit_failed");
    }
    // Ref publish alone leaves shared index at preimage → porcelain MM .gitignore.
    // Converge cohort index to published HEAD (worktree already holds repair bytes).
    await convergeExactCohortIndex({
      repo: root,
      refName,
      cohortPaths: [".gitignore"],
      frozenIndexSnapshot,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "layout_gitignore_commit_failed") throw error;
    throw new Error("layout_gitignore_commit_failed");
  }
}

async function launchActiveKick(
  active: ActiveCanonicalKick,
  manifest: SedimentWorkerCanonicalControlManifest,
  previous: CanonicalAttestationSnapshot | null,
  hooks: CanonicalControlTestHooks | undefined,
): Promise<SedimentWorkerCanonicalControlResult> {
  const state = controlState();
  try {
    await writeCanonicalConvergenceAttestation(
      active.root,
      pendingAttestation(active, "startup_requested", hooks),
      previous,
    );
  } catch {
    // attestation_write_failed requires nonnull generation (strict protocol).
    setAggregateIfActive(active, "blocked", "attestation_write_failed", true);
    if (state.active.get(active.root)?.token === active.token) state.active.delete(active.root);
    return result({
      request_id: manifest.request_id,
      operation: "kick",
      status: "blocked",
      reason_code: "attestation_write_failed",
      convergence_generation: active.convergence_generation,
      retryable: true,
    });
  }

  state.aggregate.set(active.root, aggregateFor(active, "pending", "startup_requested", true));

  // Authority-admitted kick owns strict layout repair: after pending attestation
  // is durable, on the next event-loop turn (setImmediate — not a Promise
  // microtask), before whole-L1 startup. Control returns immediately so the
  // pending attestation + control result are visible to the awaiter before
  // repair/startup run. observe never repairs. Repair runs inside
  // withCanonicalMutationBarrier so it cannot race authorized TUI business
  // writes; barrier busy / repair throw → blocked/startup_failed retryable
  // (never ready). Test repair hooks share the same barrier + next-turn
  // schedule so immediate-return evidence stays meaningful.
  setImmediate(() => {
    void withCanonicalMutationAuthority({
      abrainHome: active.root,
      role: "daemon",
      revalidate: () => {
        const admission = admitLocalExecutorAuthority({
          abrainHome: active.root,
          expectation: {
            local_executor_epoch: active.local_executor_epoch,
            local_executor_holder_nonce: active.local_executor_holder_nonce,
          },
          expectedHolderKind: "daemon",
          observation: active.authorityObservation,
        });
        if (admission.regime !== "strict") {
          throw new LocalExecutorAuthorityAdmissionError("local_executor_authority_unavailable");
        }
      },
    }, async () => {
      if (!isActiveKickToken(active)) return;
      try {
        await withCanonicalMutationBarrier(active.root, async () => {
          if (hooks?.repairStorePresentBrainLayout) {
            hooks.repairStorePresentBrainLayout(active.root);
          } else {
            const repaired = repairStorePresentBrainLayoutForAuthorityExecutor(active.root);
            // Durable tracked fix: incomplete HEAD:.gitignore without .state/
            // must advance HEAD so ready attestation publishes a tip whose tree
            // actually contains the ignore. Worktree-only ensure is insufficient.
            if (repaired.gitignoreUpdated) {
              await commitAuthorityLayoutGitignore(active.root);
            }
          }
        });
      } catch {
        await settleActiveKick(
          active,
          { outcome: "blocked", reason: "startup_failed", retryable: true },
          hooks,
        );
        return;
      }
      if (!isActiveKickToken(active)) return;

      let startupPromise: Promise<CanonicalRuntimeDiagnostics>;
      try {
        await assertCanonicalMutationAuthorized(active.root);
        startupPromise = hooks?.kickStartup
          ? hooks.kickStartup({ abrainHome: active.root }).promise
          : kickCanonicalStartupAttempt({ abrainHome: active.root }).promise;
      } catch {
        await settleActiveKick(
          active,
          { outcome: "blocked", reason: "startup_failed", retryable: true },
          hooks,
        );
        return;
      }

      if (!isActiveKickToken(active)) return;
      state.aggregate.set(active.root, aggregateFor(active, "running", "startup_running", true));
      try {
        const diagnostics = await startupPromise;
        await settleActiveKick(active, settleShape(diagnostics), hooks);
      } catch {
        await settleActiveKick(
          active,
          { outcome: "blocked", reason: "startup_failed", retryable: true },
          hooks,
        );
      }
    }).catch(async () => {
      if (!isActiveKickToken(active)) return;
      await settleActiveKick(
        active,
        { outcome: "blocked", reason: "startup_failed", retryable: true },
        hooks,
      );
    });
  });

  return result({
    request_id: manifest.request_id,
    operation: "kick",
    status: "pending",
    reason_code: "startup_requested",
    convergence_generation: active.convergence_generation,
    retryable: true,
  });
}

async function kickCanonicalControl(
  root: string,
  manifest: SedimentWorkerCanonicalControlManifest,
  hooks: CanonicalControlTestHooks | undefined,
  authorityObservation: LocalExecutorAuthorityObservationDeps | undefined,
): Promise<SedimentWorkerCanonicalControlResult> {
  const state = controlState();
  const existingActive = state.active.get(root);
  if (existingActive
    && existingActive.local_executor_epoch === manifest.local_executor_epoch
    && existingActive.local_executor_holder_nonce === manifest.local_executor_holder_nonce) {
    let settledVisible = false;
    try {
      const current = readAttestationSnapshot(root)?.attestation;
      settledVisible = !!current
        && current.local_executor_epoch === existingActive.local_executor_epoch
        && current.local_executor_holder_nonce === existingActive.local_executor_holder_nonce
        && current.convergence_generation === existingActive.convergence_generation
        && (current.outcome !== "pending"
          || (current.reason_code !== "startup_requested" && current.reason_code !== "startup_running"));
    } catch {
      settledVisible = true;
    }
    const aggregate = state.aggregate.get(root);
    if (aggregate
      && aggregate.local_executor_epoch === existingActive.local_executor_epoch
      && aggregate.local_executor_holder_nonce === existingActive.local_executor_holder_nonce
      && aggregate.convergence_generation === existingActive.convergence_generation
      && aggregate.status !== "pending"
      && aggregate.status !== "running") settledVisible = true;

    if (settledVisible) {
      if (state.active.get(root)?.token === existingActive.token) state.active.delete(root);
    } else {
      const first = await existingActive.initial;
      if (first.status === "pending" || first.status === "running") {
        return result({
          request_id: manifest.request_id,
          operation: "kick",
          status: "running",
          reason_code: "startup_running",
          convergence_generation: existingActive.convergence_generation,
          retryable: true,
        });
      }
      return result({ ...first, request_id: manifest.request_id });
    }
  }

  let previous: CanonicalAttestationSnapshot | null;
  try {
    previous = readAttestationSnapshot(root);
  } catch {
    return result({
      request_id: manifest.request_id,
      operation: "kick",
      status: "blocked",
      reason_code: "attestation_unavailable",
      retryable: true,
    });
  }

  let generation: string;
  try {
    generation = nextConvergenceGeneration(
      previous,
      manifest.local_executor_epoch,
      manifest.local_executor_holder_nonce,
    );
  } catch {
    return result({
      request_id: manifest.request_id,
      operation: "kick",
      status: "blocked",
      reason_code: "generation_overflow",
      convergence_generation: previous?.attestation.convergence_generation ?? null,
      retryable: false,
    });
  }

  const active: ActiveCanonicalKick = {
    token: Symbol("canonical-kick"),
    root,
    local_executor_epoch: manifest.local_executor_epoch,
    local_executor_holder_nonce: manifest.local_executor_holder_nonce,
    convergence_generation: generation,
    authorityObservation,
    initial: Promise.resolve(undefined as never),
  };
  state.active.set(root, active);
  active.initial = launchActiveKick(active, manifest, previous, hooks);
  return active.initial;
}

function resultFromAttestation(
  manifest: SedimentWorkerCanonicalControlManifest,
  attestation: CanonicalConvergenceAttestation,
): SedimentWorkerCanonicalControlResult {
  return result({
    request_id: manifest.request_id,
    operation: "observe",
    status: attestation.outcome,
    reason_code: attestation.reason_code,
    convergence_generation: attestation.convergence_generation,
    retryable: attestation.outcome === "pending" || attestation.reason_code === "startup_failed",
  });
}

async function observeCanonicalControl(
  root: string,
  manifest: SedimentWorkerCanonicalControlManifest,
  hooks: CanonicalControlTestHooks | undefined,
): Promise<SedimentWorkerCanonicalControlResult> {
  let snapshot: CanonicalAttestationSnapshot | null;
  try {
    snapshot = readAttestationSnapshot(root);
  } catch {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "blocked",
      reason_code: "attestation_unavailable",
      retryable: true,
    });
  }
  if (!snapshot) {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "unavailable",
      reason_code: "attestation_unavailable",
      retryable: true,
    });
  }
  const attestation = snapshot.attestation;
  if (attestation.local_executor_epoch !== manifest.local_executor_epoch
    || attestation.local_executor_holder_nonce !== manifest.local_executor_holder_nonce) {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "unavailable",
      reason_code: "attestation_unavailable",
      retryable: true,
    });
  }
  // Ready: cheap zero-side-effect drift probe so daemon can fresh-kick without
  // unconditional whole-L1. Blocked still returns durable attestation as-is.
  if (attestation.outcome === "ready") {
    return observeReadyDrift(root, manifest, attestation, hooks);
  }
  if (attestation.outcome !== "pending") return resultFromAttestation(manifest, attestation);

  const aggregate = peekControlState()?.aggregate.get(root);
  if (matchingAggregate(aggregate, attestation)) {
    // Strict protocol: blocked/attestation_unavailable must never carry generation.
    const generation = aggregate.reason_code === "attestation_unavailable"
      ? null
      : aggregate.convergence_generation;
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: aggregate.status,
      reason_code: aggregate.reason_code,
      convergence_generation: generation,
      retryable: aggregate.retryable,
    });
  }

  const runtime = hooks?.observeStartup
    ? hooks.observeStartup({ abrainHome: root })
    : observeCanonicalStartupAttempt({ abrainHome: root });
  if (runtime.status === "running") {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "running",
      reason_code: "startup_running",
      convergence_generation: attestation.convergence_generation,
      retryable: true,
    });
  }
  if (runtime.status === "deferred") {
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "pending",
      reason_code: mapDeferredReason(runtime.deferredReason),
      convergence_generation: attestation.convergence_generation,
      retryable: true,
    });
  }
  if (runtime.status === "blocked" || runtime.status === "ready") {
    // LOCK: process-local runtime peek must NOT publish durable control terminals.
    // Durable attestation CAS (kick settle) is the sole ready/blocked publisher.
    // Observe maps blocked/ready peeks to running/startup_running so daemon dwells
    // until durable attestation settles (pending → ready|blocked).
    return result({
      request_id: manifest.request_id,
      operation: "observe",
      status: "running",
      reason_code: "startup_running",
      convergence_generation: attestation.convergence_generation,
      retryable: true,
    });
  }
  return resultFromAttestation(manifest, attestation);
}

export async function runSedimentWorkerCanonicalControl(
  args: string,
  deps: SedimentWorkerCanonicalControlDeps,
): Promise<SedimentWorkerCanonicalControlResult> {
  const manifest = parseSedimentWorkerCanonicalControlArgs(args);
  assertTestHooksEnabled(deps);

  // After strict manifest parse; before authority / attestation / runtime side effects.
  // Windows: production zero-arg native addon with protected_dacl_v1+atomic_file_v1,
  // or gated test-injected temp package addon. pin=null → attestation_unavailable.
  const platform = deps.platform ?? process.platform;
  const testAddon = assertWindowsDccTestSeamAllowed(deps.windowsDccNativeAddon);
  if (!isDccControlPlatformReady(platform, testAddon)) {
    return result({
      request_id: manifest.request_id,
      operation: manifest.operation,
      status: "unavailable",
      reason_code: "attestation_unavailable",
      convergence_generation: null,
      retryable: true,
    });
  }

  return withWindowsDccAddonAsync(testAddon, async () => {
    let abrainHome: string;
    try {
      abrainHome = deps.resolveAbrainHome();
      const admission = admitLocalExecutorAuthority({
        abrainHome,
        expectation: {
          local_executor_epoch: manifest.local_executor_epoch,
          local_executor_holder_nonce: manifest.local_executor_holder_nonce,
        },
        expectedHolderKind: "daemon",
        observation: deps.authorityObservation,
      });
      if (admission.regime !== "strict") {
        throw new LocalExecutorAuthorityAdmissionError("local_executor_authority_unavailable");
      }
    } catch (error) {
      return authorityFailureResult(manifest, error);
    }

    let root: string;
    try {
      root = canonicalAbrainRoot(abrainHome);
    } catch {
      return result({
        request_id: manifest.request_id,
        operation: manifest.operation,
        status: "unavailable",
        reason_code: "attestation_unavailable",
        retryable: true,
      });
    }
    return manifest.operation === "kick"
      ? kickCanonicalControl(root, manifest, deps.testHooks, deps.authorityObservation)
      : observeCanonicalControl(root, manifest, deps.testHooks);
  });
}

/** Cross-field invariants for control-result status/reason/generation/retryable.
 * Exhaustive over every actual producer path in this module; rejects status/reason
 * mismatches and unknown/missing fields without rejecting current legal results.
 * Control-result status is NOT attestation outcome (see ADR 0046). */
function controlResultInvariantsHold(
  status: CanonicalControlStatus,
  reason: CanonicalControlReasonCode,
  generation: string | null,
  retryable: boolean,
): boolean {
  switch (status) {
    case "ready":
      return reason === "none" && generation !== null && retryable === false;
    case "pending":
      return PENDING_ATTESTATION_REASONS.has(reason) && generation !== null && retryable === true;
    case "running":
      return reason === "startup_running" && generation !== null && retryable === true;
    case "blocked":
      if (reason === "owner_intervention_required" || reason === "startup_blocked" || reason === "continuation_failed") {
        return generation !== null && retryable === false;
      }
      if (reason === "startup_failed") {
        return generation !== null && retryable === true;
      }
      if (reason === "attestation_unavailable") {
        // Strict: blocked/attestation_unavailable only allows generation=null.
        return generation === null && retryable === true;
      }
      if (reason === "attestation_write_failed") {
        // Strict: blocked/attestation_write_failed only allows generation nonnull.
        return generation !== null && retryable === true;
      }
      if (reason === "generation_overflow") {
        return retryable === false;
      }
      if (reason === "invalid_request") {
        return generation === null && retryable === false;
      }
      return false;
    case "unavailable":
      return (
        (reason === "authority_stale"
          || reason === "authority_unavailable"
          || reason === "authority_revoked"
          || reason === "attestation_unavailable")
        && generation === null
        && retryable === true
      );
    default:
      return false;
  }
}

export function sanitizeSedimentWorkerCanonicalControlResult(
  raw: unknown,
): SedimentWorkerCanonicalControlResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== CONTROL_RESULT_KEYS.size) return null;
  for (const key of Object.keys(value)) {
    if (!CONTROL_RESULT_KEYS.has(key)) return null;
  }
  if (value.schema !== SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_SCHEMA
    || typeof value.request_id !== "string" || !HEX64_RE.test(value.request_id)
    || (value.operation !== "kick" && value.operation !== "observe")
    || typeof value.status !== "string" || !CONTROL_STATUS_SET.has(value.status)
    || typeof value.reason_code !== "string" || !CONTROL_REASON_SET.has(value.reason_code)
    || (value.convergence_generation !== null
      && !isCanonicalNonzeroU64Decimal(value.convergence_generation))
    || typeof value.retryable !== "boolean") return null;
  const status = value.status as CanonicalControlStatus;
  const reason = value.reason_code as CanonicalControlReasonCode;
  const generation = value.convergence_generation as string | null;
  const retryable = value.retryable;
  if (!controlResultInvariantsHold(status, reason, generation, retryable)) return null;
  return result({
    request_id: value.request_id,
    operation: value.operation,
    status,
    reason_code: reason,
    convergence_generation: generation,
    retryable,
  });
}

export function formatSedimentWorkerCanonicalControlResultNotify(
  raw: SedimentWorkerCanonicalControlResult,
): string {
  const clean = sanitizeSedimentWorkerCanonicalControlResult(raw);
  if (!clean) validation("result_invalid");
  return `${SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_NOTIFY_PREFIX}${JSON.stringify(clean)}`;
}

export function tryParseSedimentWorkerCanonicalControlResultNotify(
  message: string,
): SedimentWorkerCanonicalControlResult | null {
  if (!message.startsWith(SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_NOTIFY_PREFIX)) return null;
  try {
    return sanitizeSedimentWorkerCanonicalControlResult(
      JSON.parse(message.slice(SEDIMENT_WORKER_CANONICAL_CONTROL_RESULT_NOTIFY_PREFIX.length)),
    );
  } catch {
    return null;
  }
}

export function registerSedimentWorkerCanonicalControlCommand(
  pi: {
    registerCommand?: (
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: {
          ui?: { notify?(message: string, type?: string): void };
        }) => Promise<void>;
      },
    ) => void;
  },
  deps: SedimentWorkerCanonicalControlDeps,
): void {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand(SEDIMENT_WORKER_CANONICAL_CONTROL_COMMAND_NAME, {
    description: "Daemon canonical convergence kick/observe control (strict JSON or base64url manifest).",
    async handler(args, ctx) {
      const notify = ctx.ui?.notify?.bind(ctx.ui);
      if (typeof notify !== "function") return;
      let controlResult: SedimentWorkerCanonicalControlResult;
      try {
        controlResult = await runSedimentWorkerCanonicalControl(args, deps);
      } catch {
        controlResult = result({
          request_id: "0".repeat(64),
          operation: "observe",
          status: "blocked",
          reason_code: "invalid_request",
          retryable: false,
        });
      }
      const type = controlResult.status === "blocked" || controlResult.status === "unavailable"
        ? "warning"
        : "info";
      try {
        notify(formatSedimentWorkerCanonicalControlResultNotify(controlResult), type);
      } catch {
        /* RPC notify failure after a closed result; never expose raw errors. */
      }
    },
  });
}
