/// <reference types="node" />

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const LOCAL_EXECUTOR_AUTHORITY_SCHEMA =
  "pi-router/local-sediment-executor-authority/v1" as const;
export const LOCAL_EXECUTOR_AUTHORITY_CAPABILITY =
  "local_executor_authority_process_lifetime_v1" as const;
export const LOCAL_EXECUTOR_AUTHORITY_RELATIVE_DIR = path.join(
  ".state",
  "sediment",
  "local-executor-authority",
);
export const LOCAL_EXECUTOR_AUTHORITY_RECORD_NAME = "authority.json" as const;
export const LOCAL_EXECUTOR_AUTHORITY_LOCK_NAME = "authority.lock" as const;

export const LOCAL_EXECUTOR_AUTHORITY_ERROR_CODES = [
  "local_executor_authority_stale",
  "local_executor_authority_unavailable",
  "local_executor_authority_revoked",
] as const;
export type LocalExecutorAuthorityErrorCode =
  (typeof LOCAL_EXECUTOR_AUTHORITY_ERROR_CODES)[number];

export function isLocalExecutorAuthorityErrorCode(
  value: unknown,
): value is LocalExecutorAuthorityErrorCode {
  return typeof value === "string"
    && (LOCAL_EXECUTOR_AUTHORITY_ERROR_CODES as readonly string[]).includes(value);
}

export type LocalExecutorAuthorityMode = "held" | "draining" | "free";
export type LocalExecutorAuthorityHolderKind = "daemon" | "foreground" | "none";

export interface LocalExecutorAuthorityRecord {
  schema: typeof LOCAL_EXECUTOR_AUTHORITY_SCHEMA;
  local_executor_epoch: string;
  mode: LocalExecutorAuthorityMode;
  holder_kind: LocalExecutorAuthorityHolderKind;
  holder_nonce: string;
  state_dir_key: string;
  run_nonce: string;
}

export interface LocalExecutorAuthorityManifestExpectation {
  local_executor_epoch?: string;
  local_executor_holder_nonce?: string;
}

export type LocalExecutorAuthorityAdmission =
  | { regime: "legacy" }
  | {
      regime: "strict";
      local_executor_epoch: string;
      holder_kind: "daemon" | "foreground";
    };

export type ForegroundLocalExecutorPosture = "legacy" | "capture_only";
export type LocalExecutorLockObservation = "held" | "free" | "unavailable";

export interface LocalExecutorAuthorityObservationDeps {
  platform?: NodeJS.Platform;
  /** Test/native adapter seam. Production uses pinned flock or deny-all open observation. */
  observeLock?: (lockPath: string, platform: NodeJS.Platform) => LocalExecutorLockObservation;
  /** Tests the real Windows error classifier without requiring a Windows host. */
  openWindowsLock?: (lockPath: string, flags: number) => number;
}

export class LocalExecutorAuthorityAdmissionError extends Error {
  readonly code: LocalExecutorAuthorityErrorCode;

  constructor(code: LocalExecutorAuthorityErrorCode) {
    super(code);
    this.name = "LocalExecutorAuthorityAdmissionError";
    this.code = code;
  }
}

const AUTHORITY_KEYS = new Set([
  "schema",
  "local_executor_epoch",
  "mode",
  "holder_kind",
  "holder_nonce",
  "state_dir_key",
  "run_nonce",
]);
const HEX64_RE = /^[0-9a-f]{64}$/;
const NONZERO_U64_RE = /^[1-9][0-9]*$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const AUTHORITY_MAX_BYTES = 64 * 1024;

function unavailable(): never {
  throw new LocalExecutorAuthorityAdmissionError("local_executor_authority_unavailable");
}

export function isCanonicalNonzeroU64Decimal(value: unknown): value is string {
  if (typeof value !== "string" || !NONZERO_U64_RE.test(value)) return false;
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

export function validateLocalExecutorAuthorityManifestExpectation(
  raw: LocalExecutorAuthorityManifestExpectation,
): LocalExecutorAuthorityManifestExpectation {
  const epochPresent = raw.local_executor_epoch !== undefined;
  const noncePresent = raw.local_executor_holder_nonce !== undefined;
  if (!epochPresent && !noncePresent) return {};
  if (!epochPresent || !noncePresent) unavailable();
  if (!isCanonicalNonzeroU64Decimal(raw.local_executor_epoch)) unavailable();
  if (typeof raw.local_executor_holder_nonce !== "string"
    || !HEX64_RE.test(raw.local_executor_holder_nonce)) unavailable();
  return {
    local_executor_epoch: raw.local_executor_epoch,
    local_executor_holder_nonce: raw.local_executor_holder_nonce,
  };
}

function canonicalAbrainRoot(input: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(path.resolve(input));
    const stat = fs.lstatSync(canonical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailable();
  } catch (error) {
    if (error instanceof LocalExecutorAuthorityAdmissionError) throw error;
    unavailable();
  }
  return canonical;
}

function authorityStorePresence(canonicalAbrain: string): "absent" | "present" {
  let current = canonicalAbrain;
  for (const component of [".state", "sediment", "local-executor-authority"]) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
      unavailable();
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailable();
    try {
      if (fs.realpathSync.native(current) !== current) unavailable();
    } catch {
      unavailable();
    }
  }
  return "present";
}

function assertStrictRegularFile(filePath: string, platform: NodeJS.Platform): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    unavailable();
  }
  if (stat.isSymbolicLink() || !stat.isFile()) unavailable();
  // Windows ACL/share semantics are verified by the daemon/native acceptance.
  // POSIX workers can and must enforce the exact portable mode directly.
  if (platform !== "win32" && (stat.mode & 0o777) !== 0o600) unavailable();
  return stat;
}

function parseJsonStringAt(text: string, offset: number): { value: string; next: number } {
  if (text[offset] !== "\"") unavailable();
  let i = offset + 1;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      const token = text.slice(offset, i + 1);
      try {
        const value: unknown = JSON.parse(token);
        if (typeof value !== "string") unavailable();
        return { value, next: i + 1 };
      } catch (error) {
        if (error instanceof LocalExecutorAuthorityAdmissionError) throw error;
        unavailable();
      }
    }
    if (ch.charCodeAt(0) < 0x20) unavailable();
  }
  unavailable();
}

function skipJsonWhitespace(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && /[\t\n\r ]/.test(text[i])) i += 1;
  return i;
}

/** Strict flat string-object parser: rejects duplicate keys and non-string values. */
function parseStrictFlatStringObject(text: string): Record<string, string> {
  let i = skipJsonWhitespace(text, 0);
  if (text[i] !== "{") unavailable();
  i = skipJsonWhitespace(text, i + 1);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  if (text[i] === "}") {
    i = skipJsonWhitespace(text, i + 1);
    if (i !== text.length) unavailable();
    return result;
  }
  for (;;) {
    const keyToken = parseJsonStringAt(text, i);
    if (seen.has(keyToken.value)) unavailable();
    seen.add(keyToken.value);
    i = skipJsonWhitespace(text, keyToken.next);
    if (text[i] !== ":") unavailable();
    i = skipJsonWhitespace(text, i + 1);
    const valueToken = parseJsonStringAt(text, i);
    result[keyToken.value] = valueToken.value;
    i = skipJsonWhitespace(text, valueToken.next);
    if (text[i] === "}") {
      i = skipJsonWhitespace(text, i + 1);
      if (i !== text.length) unavailable();
      return result;
    }
    if (text[i] !== ",") unavailable();
    i = skipJsonWhitespace(text, i + 1);
  }
  return unavailable();
}

function readStrictAuthorityRecord(
  authorityDir: string,
  platform: NodeJS.Platform,
): { record: LocalExecutorAuthorityRecord; raw: string; dev: number; ino: number } {
  const recordPath = path.join(authorityDir, LOCAL_EXECUTOR_AUTHORITY_RECORD_NAME);
  const named = assertStrictRegularFile(recordPath, platform);
  const noFollow = platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(recordPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) unavailable();
    if (platform !== "win32" && (opened.mode & 0o777) !== 0o600) unavailable();
    if (opened.size <= 0 || opened.size > AUTHORITY_MAX_BYTES) unavailable();
    const raw = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw, "utf8") !== opened.size) unavailable();
    const parsed = parseStrictFlatStringObject(raw);
    if (Object.keys(parsed).length !== AUTHORITY_KEYS.size) unavailable();
    for (const key of Object.keys(parsed)) {
      if (!AUTHORITY_KEYS.has(key)) unavailable();
    }
    if (parsed.schema !== LOCAL_EXECUTOR_AUTHORITY_SCHEMA) unavailable();
    if (!isCanonicalNonzeroU64Decimal(parsed.local_executor_epoch)) unavailable();
    if (parsed.mode !== "held" && parsed.mode !== "draining" && parsed.mode !== "free") unavailable();
    if (parsed.holder_kind !== "daemon"
      && parsed.holder_kind !== "foreground"
      && parsed.holder_kind !== "none") unavailable();
    if (parsed.mode === "free" && parsed.holder_kind !== "none") unavailable();
    if (parsed.mode !== "free" && parsed.holder_kind === "none") unavailable();
    if (!HEX64_RE.test(parsed.holder_nonce)
      || !HEX64_RE.test(parsed.state_dir_key)
      || !HEX64_RE.test(parsed.run_nonce)) unavailable();
    return {
      raw,
      dev: opened.dev,
      ino: opened.ino,
      record: {
        schema: LOCAL_EXECUTOR_AUTHORITY_SCHEMA,
        local_executor_epoch: parsed.local_executor_epoch,
        mode: parsed.mode,
        holder_kind: parsed.holder_kind,
        holder_nonce: parsed.holder_nonce,
        state_dir_key: parsed.state_dir_key,
        run_nonce: parsed.run_nonce,
      },
    };
  } catch (error) {
    if (error instanceof LocalExecutorAuthorityAdmissionError) throw error;
    unavailable();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* read-only observation cleanup */ }
    }
  }
  return unavailable();
}

function openPinnedFlock(): number {
  const flockPath = "/usr/bin/flock";
  let named: fs.Stats;
  try {
    named = fs.lstatSync(flockPath);
  } catch {
    unavailable();
  }
  if (named.isSymbolicLink() || !named.isFile()) unavailable();
  let fd: number;
  try {
    fd = fs.openSync(flockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      fs.closeSync(fd);
      unavailable();
    }
  } catch (error) {
    if (error instanceof LocalExecutorAuthorityAdmissionError) throw error;
    unavailable();
  }
  return fd;
}

function observeUnixFlock(lockPath: string, platform: NodeJS.Platform): LocalExecutorLockObservation {
  const named = assertStrictRegularFile(lockPath, platform);
  let lockFd: number | undefined;
  let flockFd: number | undefined;
  try {
    lockFd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(lockFd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) unavailable();
    flockFd = openPinnedFlock();
    const result = spawnSync("/proc/self/fd/4", ["-xn", "3"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "ignore", "ignore", lockFd, flockFd],
    });
    if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
      return "unavailable";
    }
    const after = assertStrictRegularFile(lockPath, platform);
    if (after.dev !== named.dev || after.ino !== named.ino) return "unavailable";
    return result.status === 1 ? "held" : "free";
  } catch (error) {
    if (error instanceof LocalExecutorAuthorityAdmissionError) throw error;
    return "unavailable";
  } finally {
    if (flockFd !== undefined) {
      try { fs.closeSync(flockFd); } catch { /* observation cleanup */ }
    }
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch { /* observation cleanup */ }
    }
  }
}

function observeWindowsDenyAll(
  lockPath: string,
  openLock: (lockPath: string, flags: number) => number = fs.openSync,
): LocalExecutorLockObservation {
  // Reject every reparse/symlink shape visible through Node lstat, plus all
  // non-regular files, before interpreting an open error as lock contention.
  // In current Node Windows error typing, a deny-all sharing violation is
  // EBUSY. EACCES/EPERM can be an ACL denial and therefore prove no holder.
  const named = assertStrictRegularFile(lockPath, "win32");
  let fd: number | undefined;
  try {
    fd = openLock(lockPath, fs.constants.O_RDONLY);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      return "unavailable";
    }
    return "free";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EBUSY"
      ? "held"
      : "unavailable";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* observation cleanup */ }
    }
  }
}

function observeAuthorityLock(
  lockPath: string,
  deps: LocalExecutorAuthorityObservationDeps,
): LocalExecutorLockObservation {
  const platform = deps.platform ?? process.platform;
  if (deps.observeLock) return deps.observeLock(lockPath, platform);
  if (platform === "win32") return observeWindowsDenyAll(lockPath, deps.openWindowsLock);
  if (platform === "linux") return observeUnixFlock(lockPath, platform);
  // No Node builtin exposes flock on other Unix platforms. Fail closed until
  // a native observer is supplied; file existence is never treated as a lock.
  return "unavailable";
}

function observeStableAuthority(
  canonicalAbrain: string,
  deps: LocalExecutorAuthorityObservationDeps,
): { record: LocalExecutorAuthorityRecord; lock: LocalExecutorLockObservation } {
  const platform = deps.platform ?? process.platform;
  const authorityDir = path.join(canonicalAbrain, LOCAL_EXECUTOR_AUTHORITY_RELATIVE_DIR);
  const before = readStrictAuthorityRecord(authorityDir, platform);
  const lock = observeAuthorityLock(
    path.join(authorityDir, LOCAL_EXECUTOR_AUTHORITY_LOCK_NAME),
    deps,
  );
  if (lock === "unavailable") unavailable();
  const after = readStrictAuthorityRecord(authorityDir, platform);
  // authority.json is updated by atomic replacement. Comparing the opened file
  // identity as well as bytes rejects read-lock-read ABA where A is replaced by
  // B and then byte-for-byte A before the second read.
  if (before.raw !== after.raw || before.dev !== after.dev || before.ino !== after.ino) unavailable();
  return { record: after.record, lock };
}

/**
 * One process-entry admission. It is deliberately read-only and is not called
 * again at receipt/checkpoint/L1/outbox/Git/audit write sites.
 */
export function admitLocalExecutorAuthority(args: {
  abrainHome: string;
  expectation: LocalExecutorAuthorityManifestExpectation;
  expectedHolderKind: "daemon" | "foreground";
  observation?: LocalExecutorAuthorityObservationDeps;
}): LocalExecutorAuthorityAdmission {
  const expectation = validateLocalExecutorAuthorityManifestExpectation(args.expectation);
  const canonicalAbrain = canonicalAbrainRoot(args.abrainHome);
  const presence = authorityStorePresence(canonicalAbrain);
  const hasExpectation = expectation.local_executor_epoch !== undefined;
  if (presence === "absent") {
    if (!hasExpectation) return { regime: "legacy" };
    unavailable();
  }
  if (!hasExpectation) unavailable();

  const observed = observeStableAuthority(canonicalAbrain, args.observation ?? {});
  if (observed.record.mode !== "held"
    || observed.record.holder_kind !== args.expectedHolderKind
    || observed.lock !== "held") {
    throw new LocalExecutorAuthorityAdmissionError("local_executor_authority_revoked");
  }
  if (observed.record.local_executor_epoch !== expectation.local_executor_epoch
    || observed.record.holder_nonce !== expectation.local_executor_holder_nonce) {
    throw new LocalExecutorAuthorityAdmissionError("local_executor_authority_stale");
  }
  return {
    regime: "strict",
    local_executor_epoch: observed.record.local_executor_epoch,
    holder_kind: observed.record.holder_kind,
  };
}

/**
 * Foreground execution posture. Existing/missing legacy installs keep their
 * behavior. Any active, draining, malformed, unreadable, or still-locked store
 * is capture-only. A strict free record with an observed-free lock returns to
 * legacy behavior for this worker-first rollout slice.
 */
export function classifyForegroundLocalExecutorPosture(
  abrainHome: string,
  observation: LocalExecutorAuthorityObservationDeps = {},
): ForegroundLocalExecutorPosture {
  try {
    const canonicalAbrain = canonicalAbrainRoot(abrainHome);
    if (authorityStorePresence(canonicalAbrain) === "absent") return "legacy";
    const observed = observeStableAuthority(canonicalAbrain, observation);
    return observed.record.mode === "free" && observed.lock === "free"
      ? "legacy"
      : "capture_only";
  } catch {
    return "capture_only";
  }
}
