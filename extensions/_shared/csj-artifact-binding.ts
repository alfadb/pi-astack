/**
 * CSJ execution artifact binding + private clone-rehearsal receipt carrier (spec §8.3).
 * Production runtime must refuse CSJ CAS unless live digest+fingerprints exact-match a
 * clone-green receipt. Receipt is NOT L1; private state dir mode 0700/0600.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { canonicalizeJcs, sha256Hex } from "./jcs";
import { durableAtomicWriteFile } from "./durable-write";
import { buildTypescriptStaticDependencyGraph } from "./typescript-static-dependency-graph";

/** Must match csj-prospective-merge CSJ_SPEC_VERSION (avoid import cycle). */
export const CSJ_SPEC_VERSION_BINDING = "csj-final-r6" as const;

const execFileAsync = promisify(execFile);

export const CSJ_ARTIFACT_RECEIPT_SCHEMA = "pi-astack/csj-clone-rehearsal-receipt/v1" as const;
/** Independent private state dir — NOT under L1 / canonical-convergence / blocked-memo. */
export const CSJ_ARTIFACT_RECEIPT_DIR_REL = ".state/csj-rehearsal/v1" as const;
export const CSJ_ARTIFACT_RECEIPT_FILE = "clone-green-receipt.json" as const;

/** CSJ/recover/classifier/exact-cohort/device-join/runtime entry roots for module closure. */
export const CSJ_MODULE_CLOSURE_ROOTS = Object.freeze([
  "extensions/_shared/csj-prospective-merge.ts",
  "extensions/_shared/csj-eligibility.ts",
  "extensions/_shared/csj-blocked-memo.ts",
  "extensions/_shared/csj-closed-reason.ts",
  "extensions/_shared/csj-artifact-binding.ts",
  "extensions/_shared/canonical-ref-move.ts",
  "extensions/_shared/canonical-git-runtime.ts",
  "extensions/_shared/convergence-recovery.ts",
  "extensions/_shared/recovery-history-classifier.ts",
  "extensions/_shared/git-exact-cohort.ts",
  "extensions/_shared/device-join-coordinator.ts",
  "extensions/_shared/canonical-mutation-authority.ts",
  "extensions/_shared/canonical-mutation-barrier.ts",
] as const);

export interface SedimentModuleClosureEntry {
  readonly relativePath: string;
  readonly sha256: string;
}

export interface ExecutionArtifactParts {
  readonly daemon_binary_sha256: string;
  readonly pi_executable_version: string;
  readonly sediment_module_closure: readonly SedimentModuleClosureEntry[];
  readonly csj_spec_version: string;
}

export interface CsjArtifactBinding {
  readonly executionArtifactDigest: string;
  readonly implementationFingerprint: string;
  readonly validatorFingerprint: string;
  readonly registryHash: string;
}

export interface CsjCloneGreenReceipt extends CsjArtifactBinding {
  readonly schema: typeof CSJ_ARTIFACT_RECEIPT_SCHEMA;
  readonly parts: ExecutionArtifactParts;
  readonly matrix_status: "green";
  readonly written_at_unix?: number;
}

export class CsjArtifactBindingError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CsjArtifactBindingError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export function csjArtifactReceiptDir(stateHome: string): string {
  return path.join(path.resolve(stateHome), CSJ_ARTIFACT_RECEIPT_DIR_REL);
}

export function csjArtifactReceiptPath(stateHome: string): string {
  return path.join(csjArtifactReceiptDir(stateHome), CSJ_ARTIFACT_RECEIPT_FILE);
}

/**
 * Candidate daemon executable sha256.
 *
 * Production: must pass explicit daemonBinaryPath or daemonBinarySha256 — fail closed
 * otherwise (never self-exe fallback).
 * Tests: injectable path/digest; optional /proc/<ppid>/exe only when allowProcPpidFallback
 * or PI_ASTACK_ENABLE_TEST_HOOKS=1. /proc ppid failure never falls back to self exe.
 */
export async function resolveDaemonBinarySha256(options?: {
  daemonBinaryPath?: string;
  daemonBinarySha256?: string;
  ppid?: number;
  /** Test-only: permit /proc/<ppid>/exe discovery when path/digest omitted. */
  allowProcPpidFallback?: boolean;
}): Promise<string> {
  if (options?.daemonBinarySha256) {
    if (!/^[0-9a-f]{64}$/.test(options.daemonBinarySha256)) {
      throw new CsjArtifactBindingError("CSJ_ARTIFACT_DAEMON_DIGEST_INVALID", "injectable daemon sha256 must be 64 hex");
    }
    return options.daemonBinarySha256;
  }
  if (options?.daemonBinaryPath) {
    try {
      // Explicit candidate path: follow symlink to content (daemon installs often symlink).
      const st = await fsp.stat(options.daemonBinaryPath);
      if (!st.isFile()) {
        throw new CsjArtifactBindingError(
          "CSJ_ARTIFACT_DAEMON_UNREADABLE",
          "daemonBinaryPath must resolve to a regular file",
          { path: options.daemonBinaryPath },
        );
      }
      const bytes = await fsp.readFile(options.daemonBinaryPath);
      return sha256Hex(bytes);
    } catch (error) {
      if (error instanceof CsjArtifactBindingError) throw error;
      throw new CsjArtifactBindingError(
        "CSJ_ARTIFACT_DAEMON_UNREADABLE",
        "cannot read daemonBinaryPath",
        { path: options.daemonBinaryPath, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  const allowProc = options?.allowProcPpidFallback === true
    || process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1";
  if (!allowProc) {
    throw new CsjArtifactBindingError(
      "CSJ_ARTIFACT_DAEMON_PATH_REQUIRED",
      "production requires explicit candidate daemonBinaryPath or daemonBinarySha256; no self-exe fallback",
    );
  }
  const ppid = options?.ppid ?? process.ppid;
  const procExe = `/proc/${ppid}/exe`;
  let exePath: string;
  try {
    exePath = fs.readlinkSync(procExe);
  } catch (error) {
    // Never fall back to self exe — fail closed.
    throw new CsjArtifactBindingError(
      "CSJ_ARTIFACT_DAEMON_UNREADABLE",
      "cannot resolve daemon executable via /proc/ppid; pass daemonBinaryPath (no self-exe fallback)",
      { ppid, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  try {
    const bytes = await fsp.readFile(exePath);
    return sha256Hex(bytes);
  } catch (error) {
    throw new CsjArtifactBindingError(
      "CSJ_ARTIFACT_DAEMON_UNREADABLE",
      "cannot read /proc/ppid/exe target; pass daemonBinaryPath (no self-exe fallback)",
      { ppid, exePath, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

/** Normalize `pi --version` stdout: trim whitespace; strip a single trailing newline; keep one line. */
export function normalizePiExecutableVersion(raw: string): string {
  let text = String(raw ?? "");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  text = text.trim();
  const nl = text.indexOf("\n");
  if (nl >= 0) text = text.slice(0, nl).trim();
  if (!text) throw new CsjArtifactBindingError("CSJ_ARTIFACT_PI_VERSION_EMPTY", "pi --version produced empty version");
  return text;
}

export async function resolvePiExecutableVersion(options?: {
  piExecutableVersion?: string;
  piCommand?: string;
}): Promise<string> {
  if (options?.piExecutableVersion !== undefined) {
    return normalizePiExecutableVersion(options.piExecutableVersion);
  }
  const cmd = options?.piCommand ?? "pi";
  try {
    const { stdout } = await execFileAsync(cmd, ["--version"], {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: 1024 * 1024,
    });
    return normalizePiExecutableVersion(String(stdout));
  } catch (error) {
    throw new CsjArtifactBindingError(
      "CSJ_ARTIFACT_PI_VERSION_FAILED",
      "failed to resolve pi --version",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * Real TS import-graph module closure (not a hand-listed SOT).
 * Roots = CSJ/recover/classifier/exact-cohort/device-join/runtime entries.
 */
export function buildCsjSedimentModuleClosure(repoRoot: string): readonly SedimentModuleClosureEntry[] {
  const graph = buildTypescriptStaticDependencyGraph({
    repoRoot: path.resolve(repoRoot),
    roots: [...CSJ_MODULE_CLOSURE_ROOTS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  });
  return Object.freeze(
    graph.files.map((row) => Object.freeze({ relativePath: row.path, sha256: row.sha256 })),
  );
}

export function computeExecutionArtifactDigestFromParts(parts: ExecutionArtifactParts): string {
  // JCS over the exact field set from spec §8.3.
  return sha256Hex(canonicalizeJcs({
    daemon_binary_sha256: parts.daemon_binary_sha256,
    pi_executable_version: parts.pi_executable_version,
    sediment_module_closure: parts.sediment_module_closure.map((row) => ({
      relativePath: row.relativePath,
      sha256: row.sha256,
    })),
    csj_spec_version: parts.csj_spec_version,
  }));
}

export async function computeExecutionArtifactParts(options: {
  sourceRoot: string;
  daemonBinaryPath?: string;
  daemonBinarySha256?: string;
  piExecutableVersion?: string;
  piCommand?: string;
  ppid?: number;
  specVersion?: string;
}): Promise<ExecutionArtifactParts> {
  const [daemon_binary_sha256, pi_executable_version] = await Promise.all([
    resolveDaemonBinarySha256(options),
    resolvePiExecutableVersion(options),
  ]);
  const sediment_module_closure = buildCsjSedimentModuleClosure(options.sourceRoot);
  return Object.freeze({
    daemon_binary_sha256,
    pi_executable_version,
    sediment_module_closure,
    csj_spec_version: options.specVersion ?? CSJ_SPEC_VERSION_BINDING,
  });
}

export async function computeExecutionArtifactDigest(options: {
  sourceRoot: string;
  daemonBinaryPath?: string;
  daemonBinarySha256?: string;
  piExecutableVersion?: string;
  piCommand?: string;
  ppid?: number;
  specVersion?: string;
}): Promise<{ digest: string; parts: ExecutionArtifactParts }> {
  const parts = await computeExecutionArtifactParts(options);
  return { digest: computeExecutionArtifactDigestFromParts(parts), parts };
}

export function buildCloneGreenReceipt(input: {
  parts: ExecutionArtifactParts;
  executionArtifactDigest: string;
  implementationFingerprint: string;
  validatorFingerprint: string;
  registryHash: string;
}): CsjCloneGreenReceipt {
  const expected = computeExecutionArtifactDigestFromParts(input.parts);
  if (expected !== input.executionArtifactDigest) {
    throw new CsjArtifactBindingError("CSJ_ARTIFACT_DIGEST_MISMATCH", "receipt digest does not match parts");
  }
  for (const key of ["implementationFingerprint", "validatorFingerprint", "registryHash"] as const) {
    if (typeof input[key] !== "string" || !input[key]) {
      throw new CsjArtifactBindingError("CSJ_ARTIFACT_FINGERPRINT_INVALID", `${key} required`);
    }
  }
  return Object.freeze({
    schema: CSJ_ARTIFACT_RECEIPT_SCHEMA,
    executionArtifactDigest: input.executionArtifactDigest,
    implementationFingerprint: input.implementationFingerprint,
    validatorFingerprint: input.validatorFingerprint,
    registryHash: input.registryHash,
    parts: input.parts,
    matrix_status: "green" as const,
    written_at_unix: Math.floor(Date.now() / 1000),
  });
}

/**
 * Write clone-green receipt to an independent private state home (not L1).
 * Mode: dir 0700 / file 0600. Only the production-derived clone matrix all-green
 * command should call this.
 */
export async function writeCsjCloneGreenReceipt(stateHome: string, receipt: CsjCloneGreenReceipt): Promise<string> {
  if (receipt.schema !== CSJ_ARTIFACT_RECEIPT_SCHEMA) {
    throw new CsjArtifactBindingError("CSJ_ARTIFACT_RECEIPT_SCHEMA", "invalid receipt schema");
  }
  if (receipt.matrix_status !== "green") {
    throw new CsjArtifactBindingError("CSJ_ARTIFACT_RECEIPT_NOT_GREEN", "receipt matrix_status must be green");
  }
  const dir = csjArtifactReceiptDir(stateHome);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(dir, 0o700); } catch { /* best-effort */ }
  const filePath = csjArtifactReceiptPath(stateHome);
  await durableAtomicWriteFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
  try { await fsp.chmod(filePath, 0o600); } catch { /* best-effort */ }
  return filePath;
}

export async function readCsjCloneGreenReceipt(stateHome: string): Promise<CsjCloneGreenReceipt | null> {
  const filePath = csjArtifactReceiptPath(stateHome);
  let raw: string;
  try {
    const st = await fsp.lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== CSJ_ARTIFACT_RECEIPT_SCHEMA) return null;
  if (rec.matrix_status !== "green") return null;
  for (const key of ["executionArtifactDigest", "implementationFingerprint", "validatorFingerprint", "registryHash"] as const) {
    if (typeof rec[key] !== "string" || !(rec[key] as string).length) return null;
  }
  if (!rec.parts || typeof rec.parts !== "object") return null;
  return Object.freeze({
    schema: CSJ_ARTIFACT_RECEIPT_SCHEMA,
    executionArtifactDigest: rec.executionArtifactDigest as string,
    implementationFingerprint: rec.implementationFingerprint as string,
    validatorFingerprint: rec.validatorFingerprint as string,
    registryHash: rec.registryHash as string,
    parts: rec.parts as ExecutionArtifactParts,
    matrix_status: "green" as const,
    ...(typeof rec.written_at_unix === "number" ? { written_at_unix: rec.written_at_unix } : {}),
  });
}

/**
 * Live CAS preflight: recompute executionArtifactDigest and require exact match
 * against clone-green receipt + three fingerprints.
 */
export async function assertCsjArtifactBindingExactMatch(options: {
  sourceRoot: string;
  receipt: CsjCloneGreenReceipt | CsjArtifactBinding;
  implementationFingerprint: string;
  validatorFingerprint: string;
  registryHash: string;
  daemonBinaryPath?: string;
  daemonBinarySha256?: string;
  piExecutableVersion?: string;
  piCommand?: string;
  ppid?: number;
}): Promise<{ digest: string }> {
  const live = await computeExecutionArtifactDigest({
    sourceRoot: options.sourceRoot,
    daemonBinaryPath: options.daemonBinaryPath,
    daemonBinarySha256: options.daemonBinarySha256,
    piExecutableVersion: options.piExecutableVersion,
    piCommand: options.piCommand,
    ppid: options.ppid,
  });
  if (live.digest !== options.receipt.executionArtifactDigest) {
    throw new CsjArtifactBindingError("CSJ_ARTIFACT_MISMATCH", "executionArtifactDigest live≠receipt");
  }
  if (options.implementationFingerprint !== options.receipt.implementationFingerprint
    || options.validatorFingerprint !== options.receipt.validatorFingerprint
    || options.registryHash !== options.receipt.registryHash) {
    throw new CsjArtifactBindingError("CSJ_ARTIFACT_MISMATCH", "fingerprint live≠receipt");
  }
  return { digest: live.digest };
}

/** Default private receipt home for the running host (independent of abrain L1). */
export function defaultCsjReceiptStateHome(): string {
  // Prefer XDG-style private state under the agent skill tree; never L1.
  return path.join(path.resolve(process.env.HOME || "/home/worker"), ".pi", "agent", "state", "csj-rehearsal-host");
}

export function fileSha256Sync(filePath: string): string {
  return sha256Hex(fs.readFileSync(filePath));
}

export function sha256HexOf(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
