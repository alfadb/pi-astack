import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES,
} from "./proposition-policy-stable-view-contract";
import { stableViewCanonicalizeJcs } from "./proposition-policy-stable-view";
import { resolvePropositionPolicyStableViewCurrentAbrainHome } from "./proposition-policy-stable-view-root";
import { acquireRetainedDirectoryOfdLock } from "./retained-directory-ofd-lock";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import {
  readPropositionPolicyStableViewForRuntime,
  type PropositionPolicyStableViewRuntimeReadResult,
} from "../abrain/rule-injector/proposition-policy-stable-view-reader";

export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_SCHEMA = "proposition-policy-stable-view-recovery-audit/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_RELATIVE = ".state/sediment/proposition-policy-stable-view-recovery/v1/audit.jsonl" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_RELATIVE = "scripts/_proposition-policy-stable-view-recovery-child.mjs" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_BYTES = 256 * 1024;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_ROW_BYTES = 16 * 1024;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_PROCESS_ROWS = 64;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CONTENTION_WAIT_MS = 30_000;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_SOURCE_RACE_RETRIES = 3;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_SOURCE_RACE_BACKOFF_MS = 50;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_TIMEOUT_MS = 120_000;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_MAX_STDOUT_BYTES = 16 * 1024;
export const PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_MAX_STDERR_BYTES = 16 * 1024;

const RECOVERY_STATE_KEY = Symbol.for("pi-astack/proposition-policy-stable-view-recovery/v1");
const SOURCE_CHANGE_STATE_KEY = Symbol.for("pi-astack/proposition-policy-stable-view-source-change-republish/v1");
const CHILD_SCHEMA = "proposition-policy-stable-view-recovery-child-result/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;
const MAX_CHILD_ARG_BYTES = 4096;
const MAX_CHILD_ENV_BYTES = 16 * 1024;
const VALIDATION_SESSION_ID = "proposition-policy-stable-view-recovery-validator";
const VALIDATION_SESSION_MANAGER = Object.freeze({
  isPersisted: () => true,
  getSessionId: () => VALIDATION_SESSION_ID,
  getSessionFile: () => "/nonexistent/proposition-policy-stable-view-recovery-validator.jsonl",
});
const STABLE_VIEW_PUBLICATION_ROOT_RELATIVE = ".state/sediment/proposition-policy-stable-view/v1";

export type PropositionPolicyStableViewRecoveryStatus =
  | "already_valid"
  | "recovered"
  | "contended_converged"
  | "failed";

export type PropositionPolicyStableViewRecoveryAuditStatus =
  | "appended"
  | "deduplicated"
  | "capped"
  | "failed"
  | "skipped";

export interface PropositionPolicyStableViewRecoveryResult {
  schema_version: "proposition-policy-stable-view-recovery-result/v1";
  status: PropositionPolicyStableViewRecoveryStatus;
  reason: string;
  abrain_home: string;
  started_at: string;
  finished_at: string;
  initial_read_reason: string;
  final_read_reason: string;
  contention_observed: boolean;
  bundle_hash?: string;
  publication_status?: "created" | "identical";
  error_code?: string;
  error_message?: string;
  audit: PropositionPolicyStableViewRecoveryAuditStatus;
  audit_error?: string;
}

interface RecoveryProcessState {
  inFlight: Map<string, Promise<PropositionPolicyStableViewRecoveryResult>>;
  scheduled: Map<string, Promise<PropositionPolicyStableViewRecoveryResult>>;
  latest: Map<string, PropositionPolicyStableViewRecoveryResult>;
  tail: PropositionPolicyStableViewRecoveryResult[];
}

export interface PropositionPolicyStableViewRecoveryOptions {
  abrainHome: string;
  repoRoot: string;
  /**
   * Live production injection budget
   * (`ruleInjector.propositionPolicyStableViewInjection.maxReadBytes`).
   * Health strict reads and child publication acceptance use this when set;
   * otherwise the absolute hard artifact-set envelope is used.
   */
  runtimeMaxReadBytes?: number;
  contentionWaitMs?: number;
  contentionPollMs?: number;
  sourceRaceMaxRetries?: number;
  sourceRaceBackoffMs?: number;
  childTimeoutMs?: number;
}

interface ChildPublication {
  publication_status: "created" | "identical";
  bundle_hash: string;
}

interface ChildFailure {
  error_code: string;
  error_message: string;
}

interface PublicationAttempt {
  publication?: ChildPublication;
  contendedConverged?: Extract<PropositionPolicyStableViewRuntimeReadResult, { ok: true }>;
  contentionObserved: boolean;
}

interface RecoveryTestControls {
  childBusyMs?: number;
  childSourceRaceUntilAttempt?: number;
  afterChildPublication?(): Promise<void> | void;
}

let recoveryTestControls: RecoveryTestControls = {};

function processState(): RecoveryProcessState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[RECOVERY_STATE_KEY] as RecoveryProcessState | undefined;
  if (existing) {
    if (!existing.scheduled) existing.scheduled = new Map();
    return existing;
  }
  const created: RecoveryProcessState = {
    inFlight: new Map(),
    scheduled: new Map(),
    latest: new Map(),
    tail: [],
  };
  global[RECOVERY_STATE_KEY] = created;
  return created;
}

/** Process-wide singleflight keyed by the exact requested production root. */
export function recoverPropositionPolicyStableView(
  options: PropositionPolicyStableViewRecoveryOptions,
): Promise<PropositionPolicyStableViewRecoveryResult> {
  const requestedRoot = path.resolve(options.abrainHome);
  const state = processState();
  const existing = state.inFlight.get(requestedRoot);
  if (existing) return existing;

  let configuredRoot: string | undefined;
  let rootError: unknown;
  try { configuredRoot = resolvePropositionPolicyStableViewCurrentAbrainHome(); }
  catch (error) { rootError = error; }

  const created = runRecovery(
    { ...options, abrainHome: requestedRoot, repoRoot: path.resolve(options.repoRoot) },
    configuredRoot,
    rootError,
  )
    .then((result) => recordProcessResult(result))
    .finally(() => {
      if (state.inFlight.get(requestedRoot) === created) state.inFlight.delete(requestedRoot);
    });
  state.inFlight.set(requestedRoot, created);
  return created;
}

/** Queue at most one recovery for this root without reading or compiling inline. */
export function schedulePropositionPolicyStableViewRecovery(
  options: PropositionPolicyStableViewRecoveryOptions,
): Promise<PropositionPolicyStableViewRecoveryResult> {
  const key = path.resolve(options.abrainHome);
  const state = processState();
  const existing = state.scheduled.get(key);
  if (existing) return existing;
  const scheduled = new Promise<PropositionPolicyStableViewRecoveryResult>((resolve, reject) => {
    setImmediate(() => {
      try { void recoverPropositionPolicyStableView(options).then(resolve, reject); }
      catch (error) { reject(error); }
    });
  });
  const created = scheduled.finally(() => {
    if (state.scheduled.get(key) === created) state.scheduled.delete(key);
  });
  state.scheduled.set(key, created);
  return created;
}

export function getPropositionPolicyStableViewRecoveryDiagnostics(abrainHome?: string): Readonly<{
  in_flight: boolean;
  scheduled: boolean;
  latest?: PropositionPolicyStableViewRecoveryResult;
  tail: readonly PropositionPolicyStableViewRecoveryResult[];
}> {
  const state = processState();
  const key = path.resolve(abrainHome ?? resolvePropositionPolicyStableViewCurrentAbrainHome());
  return Object.freeze({
    in_flight: state.inFlight.has(key),
    scheduled: state.scheduled.has(key),
    ...(state.latest.get(key) ? { latest: state.latest.get(key)! } : {}),
    tail: Object.freeze(state.tail.slice()),
  });
}

async function runRecovery(
  options: PropositionPolicyStableViewRecoveryOptions,
  configuredRoot: string | undefined,
  rootError: unknown,
): Promise<PropositionPolicyStableViewRecoveryResult> {
  const startedAt = new Date().toISOString();
  let initialReason = "not_read";
  let finalReason = "not_read";
  let contentionObserved = false;

  if (rootError || !configuredRoot || options.abrainHome !== configuredRoot) {
    const controlled = controlledError(rootError ?? recoveryFailure(
      "RECOVERY_ROOT_MISMATCH",
      "recovery root must equal the caller's current ABRAIN_ROOT or HOME/.abrain",
    ));
    return finalizeResult({
      status: "failed",
      reason: "stable-view recovery rejected an unauthorized root",
      abrainHome: options.abrainHome,
      startedAt,
      initialReason,
      finalReason,
      contentionObserved: false,
      errorCode: controlled.code,
      errorMessage: controlled.message,
      auditAllowed: false,
    });
  }

  try {
    const runtimeBudget = resolveRecoveryRuntimeMaxReadBytes(options.runtimeMaxReadBytes);
    const initial = strictReadWithBudget(options.abrainHome, runtimeBudget);
    initialReason = initial.reason;
    if (initial.ok) {
      return finalizeResult({
        status: "already_valid",
        reason: "selected_valid",
        abrainHome: options.abrainHome,
        startedAt,
        initialReason,
        finalReason: initial.reason,
        contentionObserved: false,
        bundleHash: initial.bundleHash,
      });
    }

    const attempted = await publishWithContention({ ...options, runtimeMaxReadBytes: runtimeBudget });
    contentionObserved = attempted.contentionObserved;
    if (attempted.contendedConverged) {
      finalReason = attempted.contendedConverged.reason;
      return finalizeResult({
        status: "contended_converged",
        reason: "another publisher produced a strict-valid stable view",
        abrainHome: options.abrainHome,
        startedAt,
        initialReason,
        finalReason,
        contentionObserved,
        bundleHash: attempted.contendedConverged.bundleHash,
      });
    }

    await recoveryTestControls.afterChildPublication?.();
    const finalRead = strictReadWithBudget(options.abrainHome, runtimeBudget);
    finalReason = finalRead.reason;
    if (!finalRead.ok) {
      throw recoveryFailure(
        "POST_PUBLICATION_VALIDATION_FAILED",
        `strict runtime validation rejected the published artifact: ${finalRead.reason}`,
      );
    }
    if (!attempted.publication) {
      throw recoveryFailure("POST_PUBLICATION_IDENTITY_MISMATCH", "publisher returned no publication identity");
    }
    if (attempted.publication.bundle_hash !== finalRead.bundleHash) {
      return finalizeResult({
        status: "contended_converged",
        reason: "latest advanced to another strict-valid bundle after this publisher released the lock",
        abrainHome: options.abrainHome,
        startedAt,
        initialReason,
        finalReason,
        contentionObserved: true,
        bundleHash: finalRead.bundleHash,
      });
    }
    return finalizeResult({
      status: "recovered",
      reason: "deterministic child compile, publication, latest switch, and parent strict read all completed",
      abrainHome: options.abrainHome,
      startedAt,
      initialReason,
      finalReason,
      contentionObserved,
      bundleHash: finalRead.bundleHash,
      publicationStatus: attempted.publication.publication_status,
    });
  } catch (error) {
    const controlled = controlledError(error);
    // Preserve a typed final_read_reason even when failure happens before/without
    // a successful final strict read (budget reject, child oversize, etc.).
    finalReason = resolveStableFinalReadReason(finalReason, controlled);
    return finalizeResult({
      status: "failed",
      reason: "stable-view recovery failed closed",
      abrainHome: options.abrainHome,
      startedAt,
      initialReason,
      finalReason,
      contentionObserved,
      errorCode: controlled.code,
      errorMessage: controlled.message,
    });
  }
}

async function publishWithContention(
  options: PropositionPolicyStableViewRecoveryOptions & { runtimeMaxReadBytes?: number },
): Promise<PublicationAttempt> {
  const waitMs = boundedInteger(options.contentionWaitMs, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CONTENTION_WAIT_MS, 0, 120_000);
  const pollMs = boundedInteger(options.contentionPollMs, 50, 5, 1_000);
  const sourceRaceRetries = boundedInteger(options.sourceRaceMaxRetries, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_SOURCE_RACE_RETRIES, 0, 10);
  const sourceRaceBackoffMs = boundedInteger(options.sourceRaceBackoffMs, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_SOURCE_RACE_BACKOFF_MS, 5, 2_000);
  const runtimeBudget = resolveRecoveryRuntimeMaxReadBytes(options.runtimeMaxReadBytes);
  const deadline = Date.now() + waitMs;
  let contentionObserved = false;
  let sourceRaceCount = 0;
  let childAttempt = 0;
  for (;;) {
    childAttempt += 1;
    const child = await runPublicationChild(options, childAttempt, runtimeBudget);
    if ("publication_status" in child) return { publication: child, contentionObserved };
    if (child.error_code === "SOURCE_RACE") {
      if (sourceRaceCount >= sourceRaceRetries) {
        throw recoveryFailure(
          "RECOVERY_SOURCE_RACE_EXHAUSTED",
          `canonical L1 changed during ${sourceRaceCount + 1} bounded child publication attempts; last error: ${child.error_message}`,
        );
      }
      const backoff = Math.min(2_000, sourceRaceBackoffMs * (2 ** sourceRaceCount));
      sourceRaceCount += 1;
      await delay(backoff);
      continue;
    }
    if (child.error_code !== "LOCK_BUSY") {
      throw recoveryFailure(child.error_code, child.error_message);
    }
    contentionObserved = true;
    const observed = strictReadWithBudget(options.abrainHome, runtimeBudget);
    if (observed.ok) return { contendedConverged: observed, contentionObserved };
    if (Date.now() >= deadline) {
      throw recoveryFailure("RECOVERY_LOCK_CONTENTION_TIMEOUT", "publisher OFD lock remained busy before bounded recovery deadline");
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function runPublicationChild(
  options: PropositionPolicyStableViewRecoveryOptions,
  attempt: number,
  runtimeMaxReadBytes: number,
): Promise<ChildPublication | ChildFailure> {
  const script = path.join(options.repoRoot, ...PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_RELATIVE.split("/"));
  const args = [
    script,
    "--abrain-home", options.abrainHome,
    "--repo-root", options.repoRoot,
    "--attempt", String(attempt),
    // Always pass the caller's runtime budget so child enforces publication
    // acceptance before switching latest (avoids post-hoc latest rollback).
    "--runtime-max-read-bytes", String(runtimeMaxReadBytes),
  ];
  const testRace = boundedInteger(recoveryTestControls.childSourceRaceUntilAttempt, 0, 0, 10);
  const testBusy = boundedInteger(recoveryTestControls.childBusyMs, 0, 0, 10_000);
  if (testRace > 0) args.push("--test-source-race-until", String(testRace));
  if (testBusy > 0) args.push("--test-busy-ms", String(testBusy));
  const env: NodeJS.ProcessEnv = {
    ABRAIN_ROOT: options.abrainHome,
    HOME: path.dirname(options.abrainHome),
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  assertBoundedChildLaunch(process.execPath, args, env);
  const timeoutMs = boundedInteger(options.childTimeoutMs, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_TIMEOUT_MS, 1_000, 300_000);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.repoRoot,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let protocolError: Error | undefined;
    let spawnError: Error | undefined;
    const timer = setTimeout(() => {
      protocolError = recoveryFailure("RECOVERY_CHILD_TIMEOUT", `publication child exceeded ${timeoutMs}ms`);
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_MAX_STDOUT_BYTES) {
        protocolError = recoveryFailure("RECOVERY_CHILD_OUTPUT_LIMIT", "publication child stdout exceeded its hard limit");
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_MAX_STDERR_BYTES) {
        protocolError = recoveryFailure("RECOVERY_CHILD_OUTPUT_LIMIT", "publication child stderr exceeded its hard limit");
        child.kill("SIGKILL");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (protocolError) return reject(protocolError);
      if (spawnError) return reject(recoveryFailure("RECOVERY_CHILD_SPAWN_FAILED", boundedText(spawnError.message)));
      if (signal) return reject(recoveryFailure("RECOVERY_CHILD_SIGNAL", `publication child terminated by ${signal}`));
      const raw = Buffer.concat(stdout).toString("utf8");
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch {
        return reject(recoveryFailure("RECOVERY_CHILD_PROTOCOL_INVALID", `publication child returned invalid JSON${diagnostic ? `: ${boundedText(diagnostic)}` : ""}`));
      }
      try {
        const outcome = validateChildOutcome(parsed, code);
        resolve(outcome);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validateChildOutcome(value: unknown, exitCode: number | null): ChildPublication | ChildFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recoveryFailure("RECOVERY_CHILD_PROTOCOL_INVALID", "publication child result must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row.schema_version !== CHILD_SCHEMA || typeof row.ok !== "boolean") {
    throw recoveryFailure("RECOVERY_CHILD_PROTOCOL_INVALID", "publication child schema or discriminator differs");
  }
  if (row.ok) {
    exactKeys(row, ["schema_version", "ok", "publication_status", "bundle_hash"], "successful child result");
    if (exitCode !== 0 || (row.publication_status !== "created" && row.publication_status !== "identical")
      || typeof row.bundle_hash !== "string" || !SHA256_PATTERN.test(row.bundle_hash)) {
      throw recoveryFailure("RECOVERY_CHILD_PROTOCOL_INVALID", "successful publication child identity differs");
    }
    return { publication_status: row.publication_status, bundle_hash: row.bundle_hash };
  }
  exactKeys(row, ["schema_version", "ok", "error_code", "error_message"], "failed child result");
  if (exitCode === 0 || typeof row.error_code !== "string" || !ERROR_CODE_PATTERN.test(row.error_code)
    || typeof row.error_message !== "string" || !row.error_message || row.error_message.length > 2_048) {
    throw recoveryFailure("RECOVERY_CHILD_PROTOCOL_INVALID", "failed publication child error envelope differs");
  }
  return { error_code: row.error_code, error_message: row.error_message };
}

function assertBoundedChildLaunch(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const values = [executable, ...args];
  if (!path.isAbsolute(executable) || values.some((value) => value.includes("\0") || Buffer.byteLength(value) > MAX_CHILD_ARG_BYTES)) {
    throw recoveryFailure("RECOVERY_CHILD_ARG_INVALID", "publication child executable or argv is unbounded");
  }
  let envBytes = 0;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.includes("\0") || value.includes("\0")) {
      throw recoveryFailure("RECOVERY_CHILD_ENV_INVALID", "publication child env contains an invalid value");
    }
    envBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
  }
  if (envBytes > MAX_CHILD_ENV_BYTES) throw recoveryFailure("RECOVERY_CHILD_ENV_INVALID", "publication child env exceeds its hard limit");
}

/** Source-change / recovery health reader — uses the provided runtime budget. */
function strictReadWithBudget(
  abrainHome: string,
  maxReadBytes: number,
): PropositionPolicyStableViewRuntimeReadResult {
  return readPropositionPolicyStableViewForRuntime({
    abrainHome,
    settings: { maxReadBytes },
    sessionManager: VALIDATION_SESSION_MANAGER,
  });
}

/** Required for source-change paths — caller must pass live production budget. */
function resolveSourceChangeRuntimeMaxReadBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw recoveryFailure(
      "SOURCE_CHANGE_RUNTIME_BUDGET_INVALID",
      "runtimeMaxReadBytes must be a finite number matching production injection budget",
    );
  }
  const n = Math.floor(value);
  if (n < 1) {
    throw recoveryFailure(
      "SOURCE_CHANGE_RUNTIME_BUDGET_INVALID",
      "runtimeMaxReadBytes must be >= 1",
    );
  }
  return Math.min(PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES, n);
}

/**
 * Recovery health budget: live production injection value when provided,
 * otherwise the absolute hard artifact-set envelope (legacy tests).
 */
function resolveRecoveryRuntimeMaxReadBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw recoveryFailure(
      "RECOVERY_RUNTIME_BUDGET_INVALID",
      "runtimeMaxReadBytes must be a finite number matching production injection budget",
    );
  }
  const n = Math.floor(value);
  if (n < 1) {
    throw recoveryFailure(
      "RECOVERY_RUNTIME_BUDGET_INVALID",
      "runtimeMaxReadBytes must be >= 1",
    );
  }
  return Math.min(PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES, n);
}

function finalizeResult(input: {
  status: PropositionPolicyStableViewRecoveryStatus;
  reason: string;
  abrainHome: string;
  startedAt: string;
  initialReason: string;
  finalReason: string;
  contentionObserved: boolean;
  bundleHash?: string;
  publicationStatus?: "created" | "identical";
  errorCode?: string;
  errorMessage?: string;
  auditAllowed?: boolean;
}): PropositionPolicyStableViewRecoveryResult {
  const base = {
    schema_version: "proposition-policy-stable-view-recovery-result/v1" as const,
    status: input.status,
    reason: boundedText(input.reason),
    abrain_home: input.abrainHome,
    started_at: input.startedAt,
    finished_at: new Date().toISOString(),
    initial_read_reason: boundedText(input.initialReason),
    final_read_reason: boundedText(input.finalReason),
    contention_observed: input.contentionObserved,
    ...(input.bundleHash ? { bundle_hash: input.bundleHash } : {}),
    ...(input.publicationStatus ? { publication_status: input.publicationStatus } : {}),
    ...(input.errorCode ? { error_code: boundedText(input.errorCode) } : {}),
    ...(input.errorMessage ? { error_message: boundedText(input.errorMessage) } : {}),
  };
  if (input.auditAllowed === false) return Object.freeze({ ...base, audit: "skipped" as const });
  const audit = appendRecoveryAudit(input.abrainHome, base);
  return Object.freeze({
    ...base,
    audit: audit.status,
    ...(audit.error ? { audit_error: audit.error } : {}),
  });
}

function appendRecoveryAudit(
  abrainHome: string,
  result: Omit<PropositionPolicyStableViewRecoveryResult, "audit" | "audit_error">,
): { status: Exclude<PropositionPolicyStableViewRecoveryAuditStatus, "skipped">; error?: string } {
  let lock: ReturnType<typeof acquireRetainedDirectoryOfdLock> | undefined;
  try {
    const sedimentRoot = exactDirectory(path.join(abrainHome, ".state", "sediment"), "recovery audit sediment root");
    const auditRoot = ensureExactChildDirectory(sedimentRoot, "proposition-policy-stable-view-recovery");
    const versionRoot = ensureExactChildDirectory(auditRoot, "v1");
    lock = acquireRetainedDirectoryOfdLock(versionRoot);
    if (lock.status === "BUSY") return { status: "failed", error: "RECOVERY_AUDIT_LOCK_BUSY" };
    const names = fs.readdirSync(versionRoot);
    if (names.some((name) => name !== "audit.jsonl")) {
      throw recoveryFailure("RECOVERY_AUDIT_FOREIGN_STATE", "recovery audit root contains a foreign entry");
    }
    const { schema_version: resultSchemaVersion, ...resultFields } = result;
    const row = {
      schema_version: PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_SCHEMA,
      result_schema_version: resultSchemaVersion,
      ...resultFields,
      pid: process.pid,
    };
    const raw = `${stableViewCanonicalizeJcs(row)}\n`;
    const rowBytes = Buffer.byteLength(raw);
    if (rowBytes > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_ROW_BYTES) {
      return { status: "failed", error: "RECOVERY_AUDIT_ROW_OVERSIZE" };
    }
    const file = path.join(versionRoot, "audit.jsonl");
    const before = lstatIfPresent(file);
    if (before && (before.isSymbolicLink() || !before.isFile())) {
      throw recoveryFailure("RECOVERY_AUDIT_UNSAFE", "recovery audit leaf is not a regular no-symlink file");
    }
    if (result.status === "already_valid" && before && auditAlreadyRecordsNoop(file, before, result)) {
      return { status: "deduplicated" };
    }
    if ((before?.size ?? 0) + rowBytes > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_BYTES) {
      return { status: "capped" };
    }
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const opened = fs.fstatSync(fd);
      const named = fs.lstatSync(file);
      if (!opened.isFile() || named.isSymbolicLink() || !named.isFile()
        || opened.dev !== named.dev || opened.ino !== named.ino) {
        throw recoveryFailure("RECOVERY_AUDIT_UNSAFE", "recovery audit identity changed while opened");
      }
      if (opened.size + rowBytes > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_BYTES) return { status: "capped" };
      fs.writeFileSync(fd, raw, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(versionRoot);
    return { status: "appended" };
  } catch (error) {
    return { status: "failed", error: boundedText(controlledError(error).message) };
  } finally {
    lock?.close();
  }
}

function auditAlreadyRecordsNoop(
  file: string,
  expected: fs.Stats,
  result: Omit<PropositionPolicyStableViewRecoveryResult, "audit" | "audit_error">,
): boolean {
  if (expected.size <= 0 || expected.size > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_BYTES) return false;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (!opened.isFile() || named.isSymbolicLink() || !named.isFile()
      || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== expected.size) {
      throw recoveryFailure("RECOVERY_AUDIT_UNSAFE", "recovery audit identity changed while deduplicating");
    }
    const lines = fs.readFileSync(fd, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) || "null") as Record<string, unknown> | null;
    return !!last
      && last.schema_version === PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_SCHEMA
      && last.status === "already_valid"
      && last.abrain_home === result.abrain_home
      && last.bundle_hash === result.bundle_hash
      && last.final_read_reason === result.final_read_reason;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code).startsWith("RECOVERY_")) throw error;
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function ensureExactChildDirectory(parent: string, name: string): string {
  const child = path.join(parent, name);
  const existing = lstatIfPresent(child);
  if (!existing) {
    try { fs.mkdirSync(child, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return exactDirectory(child, `recovery audit ${name} directory`);
}

function exactDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  let current = path.parse(resolved).root;
  for (const component of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw recoveryFailure("RECOVERY_UNSAFE_PATH", `${label} contains a symlink or non-directory`);
    }
  }
  if (fs.realpathSync(resolved) !== resolved) throw recoveryFailure("RECOVERY_UNSAFE_PATH", `${label} is not its own realpath`);
  return resolved;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function recordProcessResult(result: PropositionPolicyStableViewRecoveryResult): PropositionPolicyStableViewRecoveryResult {
  const state = processState();
  state.latest.set(result.abrain_home, result);
  state.tail.push(result);
  if (state.tail.length > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_PROCESS_ROWS) {
    state.tail.splice(0, state.tail.length - PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_PROCESS_ROWS);
  }
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function boundedText(value: string): string {
  return String(value).slice(0, 2_048);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lstatIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw recoveryFailure("RECOVERY_CHILD_PROTOCOL_INVALID", `${label} has unexpected keys`);
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "RECOVERY_ERROR";
}

function controlledError(error: unknown): { code: string; message: string } {
  return {
    code: boundedText(errorCode(error)),
    message: boundedText(error instanceof Error ? error.message : String(error)),
  };
}

function recoveryFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export const __TEST = Object.freeze({
  setControls(controls: RecoveryTestControls): void {
    recoveryTestControls = { ...controls };
  },
  resetControls(): void {
    recoveryTestControls = {};
  },
});

// ---------------------------------------------------------------------------
// Source-change force republish (Tier-1 → proposition append path)
// Skips the recovery already_valid short-circuit; always spawns the production
// publisher child so a newly durable proposition enters the stable-view source
// closure. Process-global singleflight + pending coalesce per abrainHome.
// Durable pending markers (event id only) survive process death; they are
// derived publish todos, never a second semantic authority.
// ---------------------------------------------------------------------------

export const PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_SCHEMA =
  "proposition-policy-stable-view-source-change-pending/v1" as const;
/** Outside the stable-view publication root (which only allows bundles/latest). */
export const PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_RELATIVE =
  ".state/sediment/proposition-policy-stable-view-source-change/v1/pending" as const;

export type PropositionPolicyStableViewSourceChangeStatus =
  | "republished"
  | "contended_converged"
  | "failed";

export interface PropositionPolicyStableViewSourceChangeResult {
  schema_version: "proposition-policy-stable-view-source-change-result/v1";
  status: PropositionPolicyStableViewSourceChangeStatus;
  reason: string;
  abrain_home: string;
  started_at: string;
  finished_at: string;
  required_event_ids: readonly string[];
  final_read_reason: string;
  contention_observed: boolean;
  bundle_hash?: string;
  publication_status?: "created" | "identical";
  error_code?: string;
  error_message?: string;
  /** Distinct from recovery already_valid — force path never reports that. */
  already_valid_short_circuit: false;
}

export interface PropositionPolicyStableViewSourceChangeOptions {
  abrainHome: string;
  repoRoot: string;
  requiredEventIds: readonly string[];
  /**
   * Production runtime reader budget — must equal the live
   * `ruleInjector.propositionPolicyStableViewInjection.maxReadBytes`.
   * Source-change final strictRead / ack use this budget (not the hard 262144
   * recovery envelope) so capture/ack cannot clear markers the production
   * reader would reject as oversize. Required for every production and test call.
   */
  runtimeMaxReadBytes: number;
  contentionWaitMs?: number;
  contentionPollMs?: number;
  sourceRaceMaxRetries?: number;
  sourceRaceBackoffMs?: number;
  childTimeoutMs?: number;
}

export interface PropositionPolicyStableViewSourceChangePendingMarker {
  schema: typeof PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_SCHEMA;
  event_id: string;
}

interface SourceChangeProcessState {
  scheduled: Map<string, Promise<PropositionPolicyStableViewSourceChangeResult>>;
  inFlight: Map<string, Promise<PropositionPolicyStableViewSourceChangeResult>>;
  pendingIds: Map<string, Set<string>>;
  latest: Map<string, PropositionPolicyStableViewSourceChangeResult>;
  tail: PropositionPolicyStableViewSourceChangeResult[];
  /** Last non-id options used to re-arm after a lost-wakeup race. */
  lastOptions: Map<string, PropositionPolicyStableViewSourceChangeOptions>;
}

function sourceChangeState(): SourceChangeProcessState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[SOURCE_CHANGE_STATE_KEY] as SourceChangeProcessState | undefined;
  if (existing) return existing;
  const created: SourceChangeProcessState = {
    scheduled: new Map(),
    inFlight: new Map(),
    pendingIds: new Map(),
    latest: new Map(),
    tail: [],
    lastOptions: new Map(),
  };
  global[SOURCE_CHANGE_STATE_KEY] = created;
  return created;
}

export function propositionPolicyStableViewSourceChangePendingDir(abrainHome: string): string {
  return path.join(
    path.resolve(abrainHome),
    ...PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_RELATIVE.split("/"),
  );
}

export function propositionPolicyStableViewSourceChangePendingPath(
  abrainHome: string,
  eventId: string,
): string {
  if (!SHA256_PATTERN.test(eventId)) {
    throw recoveryFailure("SOURCE_CHANGE_PENDING_ID_INVALID", "pending marker event_id must be sha256 hex");
  }
  return path.join(propositionPolicyStableViewSourceChangePendingDir(abrainHome), `${eventId}.json`);
}

const PENDING_MARKER_NAME_PATTERN = /^[0-9a-f]{64}\.json$/;

/**
 * Walk abrainHome → pending dir with lstat only. Fail closed on symlink/non-dir.
 * Missing intermediate or target → "missing" (list empty / delete missing).
 */
async function inspectSourceChangePendingDirChain(
  abrainHome: string,
): Promise<"ready" | "missing"> {
  const root = path.resolve(abrainHome);
  const targetDir = propositionPolicyStableViewSourceChangePendingDir(root);
  const relative = path.relative(root, targetDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw recoveryFailure("SOURCE_CHANGE_PENDING_PATH_ESCAPE", "pending marker directory escapes abrain home");
  }
  let current = root;
  try {
    const rootStat = await fsp.lstat(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw recoveryFailure("SOURCE_CHANGE_PENDING_PATH_UNSAFE", "abrain home must be a non-symlink directory");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const st = await fsp.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw recoveryFailure(
          "SOURCE_CHANGE_PENDING_PATH_UNSAFE",
          "pending marker directory chain is unsafe",
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw err;
    }
  }
  return "ready";
}

/**
 * Create pending dir one level at a time from an existing non-symlink abrain root.
 * After each mkdir, fsync the parent. Never uses recursive mkdir (symlink-safe).
 */
async function ensureSourceChangePendingDirReady(abrainHome: string): Promise<string> {
  const root = path.resolve(abrainHome);
  const targetDir = propositionPolicyStableViewSourceChangePendingDir(root);
  const relative = path.relative(root, targetDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw recoveryFailure("SOURCE_CHANGE_PENDING_PATH_ESCAPE", "pending marker directory escapes abrain home");
  }
  let current = root;
  const rootStat = await fsp.lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw recoveryFailure("SOURCE_CHANGE_PENDING_PATH_UNSAFE", "abrain home must be a non-symlink directory");
  }
  for (const part of relative.split(path.sep).filter(Boolean)) {
    const parent = current;
    current = path.join(current, part);
    let st: fs.Stats | null = null;
    try {
      st = await fsp.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!st) {
      try {
        await fsp.mkdir(current, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      fsyncDirectory(parent);
      st = await fsp.lstat(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_PATH_UNSAFE",
        "pending marker directory chain is unsafe",
      );
    }
  }
  return targetDir;
}

/**
 * Durable enqueue of a low-sensitivity publish todo (event id only).
 * Create-only + parent fsync; identical on retry. Not semantic authority.
 */
export async function enqueuePropositionPolicyStableViewSourceChangePendingMarker(
  abrainHome: string,
  eventId: string,
): Promise<{ status: DurableCreateStatus; eventId: string; filePath: string }> {
  if (!SHA256_PATTERN.test(eventId)) {
    throw recoveryFailure("SOURCE_CHANGE_PENDING_ID_INVALID", "pending marker event_id must be sha256 hex");
  }
  const root = path.resolve(abrainHome);
  await ensureSourceChangePendingDirReady(root);
  const filePath = propositionPolicyStableViewSourceChangePendingPath(root, eventId);
  const marker: PropositionPolicyStableViewSourceChangePendingMarker = Object.freeze({
    schema: PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_SCHEMA,
    event_id: eventId,
  });
  const raw = `${JSON.stringify(marker)}\n`;
  const status = await durableAtomicCreateFile(filePath, raw, { mode: 0o600 });
  if (status === "collision") {
    // Existing file must be the same low-sens marker; otherwise hard-fail closed.
    try {
      const existing = JSON.parse(await fsp.readFile(filePath, "utf8")) as PropositionPolicyStableViewSourceChangePendingMarker;
      if (
        existing?.schema === PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_SCHEMA
        && existing.event_id === eventId
      ) {
        return { status: "identical", eventId, filePath };
      }
    } catch {
      // fall through
    }
    throw recoveryFailure(
      "SOURCE_CHANGE_PENDING_COLLISION",
      `source-change pending marker collides with different bytes: ${eventId}`,
    );
  }
  return { status, eventId, filePath };
}

export async function listPropositionPolicyStableViewSourceChangePendingMarkers(
  abrainHome: string,
): Promise<readonly string[]> {
  const chain = await inspectSourceChangePendingDirChain(abrainHome);
  if (chain === "missing") return Object.freeze([]);
  const dir = propositionPolicyStableViewSourceChangePendingDir(abrainHome);
  const names = await fsp.readdir(dir);
  const ids: string[] = [];
  for (const name of names) {
    if (!PENDING_MARKER_NAME_PATTERN.test(name)) {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_FOREIGN",
        `foreign entry in pending marker directory: ${name}`,
      );
    }
    const filePath = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(filePath);
    } catch (err) {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_CORRUPT",
        `pending marker unreadable: ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_FOREIGN",
        `pending marker is not a regular file: ${name}`,
      );
    }
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (err) {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_CORRUPT",
        `pending marker unreadable: ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let marker: PropositionPolicyStableViewSourceChangePendingMarker;
    try {
      marker = JSON.parse(raw) as PropositionPolicyStableViewSourceChangePendingMarker;
    } catch {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_CORRUPT",
        `pending marker JSON corrupt: ${name}`,
      );
    }
    if (
      marker?.schema !== PROPOSITION_POLICY_STABLE_VIEW_SOURCE_CHANGE_PENDING_SCHEMA
      || typeof marker.event_id !== "string"
      || !SHA256_PATTERN.test(marker.event_id)
      || marker.event_id !== name.slice(0, 64)
    ) {
      throw recoveryFailure(
        "SOURCE_CHANGE_PENDING_CORRUPT",
        `pending marker content invalid: ${name}`,
      );
    }
    ids.push(marker.event_id);
  }
  ids.sort();
  return Object.freeze(ids);
}

export async function deletePropositionPolicyStableViewSourceChangePendingMarker(
  abrainHome: string,
  eventId: string,
): Promise<"deleted" | "missing"> {
  if (!SHA256_PATTERN.test(eventId)) return "missing";
  const chain = await inspectSourceChangePendingDirChain(abrainHome);
  if (chain === "missing") return "missing";
  const filePath = propositionPolicyStableViewSourceChangePendingPath(abrainHome, eventId);
  const dir = path.dirname(filePath);
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
  // Durable ack requires parent fsync. Failure must propagate so callers do not
  // claim a durable ack; marker may already be unlinked (at-least-once retry).
  fsyncDirectory(dir);
  return "deleted";
}

/** After a covering stable-view, drop markers for those event ids (fsync). */
export async function ackPropositionPolicyStableViewSourceChangePendingMarkers(
  abrainHome: string,
  coveredEventIds: readonly string[],
): Promise<readonly string[]> {
  const acked: string[] = [];
  for (const id of coveredEventIds) {
    if (!SHA256_PATTERN.test(id)) continue;
    const status = await deletePropositionPolicyStableViewSourceChangePendingMarker(abrainHome, id);
    if (status === "deleted") acked.push(id);
  }
  return Object.freeze(acked);
}

/**
 * session_start / external recovery: scan durable markers and force-republish
 * even when the old stable-view is already strict-valid. Empty → no-op null.
 * Resolves to the source-change Result (or null), not a nested Promise — JS
 * promise assimilation would otherwise make `.then(scheduled => scheduled.then)`
 * TypeError at session_start. Does not tight-loop on failure; next session_start
 * or new source event retries.
 */
export async function schedulePropositionPolicyStableViewSourceChangeFromPendingMarkers(
  options: Omit<PropositionPolicyStableViewSourceChangeOptions, "requiredEventIds"> & {
    requiredEventIds?: readonly string[];
  },
): Promise<PropositionPolicyStableViewSourceChangeResult | null> {
  const listed = await listPropositionPolicyStableViewSourceChangePendingMarkers(options.abrainHome);
  const extra = (options.requiredEventIds ?? []).filter((id) => typeof id === "string" && SHA256_PATTERN.test(id));
  const ids = Object.freeze([...new Set([...listed, ...extra])].sort());
  if (ids.length === 0) return null;
  return schedulePropositionPolicyStableViewSourceChangeRepublish({
    ...options,
    requiredEventIds: ids,
  });
}

/**
 * Schedule a force republish after a new durable policy proposition append.
 * setImmediate start; does not block the caller on full publish.
 * Coalesces required event IDs while a run is already scheduled/in-flight.
 * In-flight new ids become a subsequent wave of the same loop. A failed wave
 * does not retry the same ids in-process (durable markers + next external
 * trigger own retries) but still drains waves that already arrived.
 */
export function schedulePropositionPolicyStableViewSourceChangeRepublish(
  options: PropositionPolicyStableViewSourceChangeOptions,
): Promise<PropositionPolicyStableViewSourceChangeResult> {
  const key = path.resolve(options.abrainHome);
  const state = sourceChangeState();
  const pending = state.pendingIds.get(key) ?? new Set<string>();
  for (const id of options.requiredEventIds) {
    if (typeof id === "string" && SHA256_PATTERN.test(id)) pending.add(id);
  }
  state.pendingIds.set(key, pending);
  const resolvedOptions: PropositionPolicyStableViewSourceChangeOptions = {
    ...options,
    abrainHome: key,
    repoRoot: path.resolve(options.repoRoot),
  };
  state.lastOptions.set(key, resolvedOptions);

  const existing = state.scheduled.get(key);
  if (existing) return existing;

  let created!: Promise<PropositionPolicyStableViewSourceChangeResult>;
  created = new Promise<PropositionPolicyStableViewSourceChangeResult>((resolve, reject) => {
    setImmediate(() => {
      void runSourceChangeLoop(resolvedOptions).then(resolve, reject);
    });
  }).finally(() => {
    if (state.scheduled.get(key) === created) state.scheduled.delete(key);
    // Lost-wakeup guard: a concurrent schedule may have filled pending after
    // the loop observed empty and before we dropped `scheduled`.
    const remaining = state.pendingIds.get(key);
    if (remaining && remaining.size > 0 && !state.scheduled.has(key)) {
      const last = state.lastOptions.get(key) ?? resolvedOptions;
      schedulePropositionPolicyStableViewSourceChangeRepublish({
        ...last,
        abrainHome: key,
        requiredEventIds: [],
      });
    }
  });
  // Prevent unhandled rejection if the caller only fire-and-forgets.
  created.catch(() => undefined);
  state.scheduled.set(key, created);
  return created;
}

async function runSourceChangeLoop(
  options: PropositionPolicyStableViewSourceChangeOptions,
): Promise<PropositionPolicyStableViewSourceChangeResult> {
  const key = path.resolve(options.abrainHome);
  const state = sourceChangeState();
  let last: PropositionPolicyStableViewSourceChangeResult | undefined;
  // Drain pending waves so coalesce callers' ids are covered. Failed waves do
  // not requeue their own ids (durable marker + next external trigger), but
  // the loop continues for any next wave already enqueued in memory.
  for (;;) {
    const pending = state.pendingIds.get(key);
    if (!pending || pending.size === 0) break;
    const required = Object.freeze([...pending].sort());
    pending.clear();
    const inFlight = forceRepublishPropositionPolicyStableView({
      ...options,
      abrainHome: key,
      requiredEventIds: required,
    });
    state.inFlight.set(key, inFlight);
    try {
      last = await inFlight;
    } finally {
      if (state.inFlight.get(key) === inFlight) state.inFlight.delete(key);
    }
    state.latest.set(key, last);
    state.tail.push(last);
    if (state.tail.length > PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_PROCESS_ROWS) {
      state.tail.splice(0, state.tail.length - PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_PROCESS_ROWS);
    }
    // Do not break on failed: still process a subsequent wave that arrived
    // while this wave ran. Failed ids stay on durable markers only.
  }
  if (!last) {
    last = Object.freeze({
      schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
      status: "failed" as const,
      reason: "source-change republish scheduled with empty required event set",
      abrain_home: key,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      required_event_ids: Object.freeze([] as string[]),
      final_read_reason: "not_run",
      contention_observed: false,
      already_valid_short_circuit: false as const,
      error_code: "SOURCE_CHANGE_EMPTY",
      error_message: "no required event ids",
    });
  }
  return last;
}

/**
 * Force-spawn the production publisher child. Never returns already_valid from
 * a pre-publish strictRead of the old bundle. On success covering required
 * event ids, deletes the corresponding durable pending markers + fsync.
 * Intentionally no extra singleflight: only the scheduler / tests call this.
 */
export async function forceRepublishPropositionPolicyStableView(
  options: PropositionPolicyStableViewSourceChangeOptions,
): Promise<PropositionPolicyStableViewSourceChangeResult> {
  const startedAt = new Date().toISOString();
  const abrainHome = path.resolve(options.abrainHome);
  const requiredEventIds = Object.freeze(
    [...new Set(options.requiredEventIds.filter((id) => typeof id === "string" && SHA256_PATTERN.test(id)))].sort(),
  );
  let finalReason = "not_read";
  let contentionObserved = false;

  let configuredRoot: string | undefined;
  let rootError: unknown;
  try { configuredRoot = resolvePropositionPolicyStableViewCurrentAbrainHome(); }
  catch (error) { rootError = error; }

  if (rootError || !configuredRoot || abrainHome !== configuredRoot) {
    const controlled = controlledError(rootError ?? recoveryFailure(
      "SOURCE_CHANGE_ROOT_MISMATCH",
      "source-change republish root must equal the caller's current ABRAIN_ROOT or HOME/.abrain",
    ));
    return Object.freeze({
      schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
      status: "failed" as const,
      reason: "source-change republish rejected an unauthorized root",
      abrain_home: abrainHome,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      required_event_ids: requiredEventIds,
      final_read_reason: finalReason,
      contention_observed: false,
      already_valid_short_circuit: false as const,
      error_code: controlled.code,
      error_message: controlled.message,
    });
  }

  let runtimeMaxReadBytes: number | undefined;
  try {
    // Production runtime budget: child publication acceptance (before latest),
    // final selected_valid, and marker ack all share this envelope.
    runtimeMaxReadBytes = resolveSourceChangeRuntimeMaxReadBytes(options.runtimeMaxReadBytes);

    // Intentionally skip any pre-publish already_valid short-circuit.
    const attempted = await publishWithContention({
      abrainHome,
      repoRoot: path.resolve(options.repoRoot),
      runtimeMaxReadBytes,
      contentionWaitMs: options.contentionWaitMs,
      contentionPollMs: options.contentionPollMs,
      sourceRaceMaxRetries: options.sourceRaceMaxRetries,
      sourceRaceBackoffMs: options.sourceRaceBackoffMs,
      childTimeoutMs: options.childTimeoutMs,
    });
    contentionObserved = attempted.contentionObserved;

    if (attempted.contendedConverged) {
      // Contended path already budget-read; re-confirm identity then ack only
      // included dispositions so excluded/non-candidate markers stay durable.
      const runtimeRead = strictReadWithBudget(abrainHome, runtimeMaxReadBytes);
      finalReason = runtimeRead.reason;
      if (!runtimeRead.ok) {
        throw recoveryFailure(
          "SOURCE_CHANGE_POST_PUBLICATION_VALIDATION_FAILED",
          `runtime-budget validation rejected the contended artifact: ${runtimeRead.reason}`,
        );
      }
      if (runtimeRead.bundleHash !== attempted.contendedConverged.bundleHash) {
        throw recoveryFailure(
          "SOURCE_CHANGE_POST_PUBLICATION_IDENTITY_MISMATCH",
          "runtime-budget read bundle hash diverged from contended hard-read identity",
        );
      }
      const missing = missingRequiredEventIds(abrainHome, runtimeRead.bundleHash, requiredEventIds);
      // Ack covered included markers first; missing must not block partial cleanup.
      const covered = requiredEventIds.filter((id) => !missing.includes(id));
      if (covered.length) {
        await ackCoveredMarkersBestEffort(abrainHome, runtimeRead.bundleHash, covered);
      }
      if (missing.length) {
        return Object.freeze({
          schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
          status: "failed" as const,
          reason: "contended stable view is selected_valid but missing required included proposition event ids",
          abrain_home: abrainHome,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          required_event_ids: requiredEventIds,
          final_read_reason: finalReason,
          contention_observed: true,
          bundle_hash: runtimeRead.bundleHash,
          already_valid_short_circuit: false as const,
          error_code: "SOURCE_CHANGE_MISSING_EVENT",
          error_message: `missing included event ids: ${missing.join(",")}`,
        });
      }
      return Object.freeze({
        schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
        status: "contended_converged" as const,
        reason: "another publisher produced a strict-valid stable view covering required events",
        abrain_home: abrainHome,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        required_event_ids: requiredEventIds,
        final_read_reason: finalReason,
        contention_observed: true,
        bundle_hash: runtimeRead.bundleHash,
        already_valid_short_circuit: false as const,
      });
    }

    await recoveryTestControls.afterChildPublication?.();
    // Ack only after selected_valid under the production runtime budget.
    const finalRead = strictReadWithBudget(abrainHome, runtimeMaxReadBytes);
    finalReason = finalRead.reason;
    if (!finalRead.ok) {
      throw recoveryFailure(
        "SOURCE_CHANGE_POST_PUBLICATION_VALIDATION_FAILED",
        `strict runtime validation rejected the published artifact: ${finalRead.reason}`,
      );
    }
    if (!attempted.publication) {
      throw recoveryFailure("SOURCE_CHANGE_POST_PUBLICATION_IDENTITY_MISMATCH", "publisher returned no publication identity");
    }
    if (finalRead.bundleHash !== attempted.publication.bundle_hash) {
      throw recoveryFailure(
        "SOURCE_CHANGE_POST_PUBLICATION_IDENTITY_MISMATCH",
        "runtime-budget read bundle hash diverged from publisher identity",
      );
    }
    const missing = missingRequiredEventIds(abrainHome, finalRead.bundleHash, requiredEventIds);
    // Ack the included subset first. Missing required ids remain durable markers
    // and surface as typed failure; they must not block covered-marker cleanup.
    const covered = requiredEventIds.filter((id) => !missing.includes(id));
    if (covered.length) {
      await ackCoveredMarkersBestEffort(abrainHome, finalRead.bundleHash, covered);
    }
    if (missing.length) {
      return Object.freeze({
        schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
        status: "failed" as const,
        reason: "published selected_valid bundle is missing required included proposition event ids",
        abrain_home: abrainHome,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        required_event_ids: requiredEventIds,
        final_read_reason: finalReason,
        contention_observed: contentionObserved,
        bundle_hash: finalRead.bundleHash,
        already_valid_short_circuit: false as const,
        error_code: "SOURCE_CHANGE_MISSING_EVENT",
        error_message: `missing included event ids: ${missing.join(",")}`,
      });
    }
    return Object.freeze({
      schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
      status: "republished" as const,
      reason: "forced child compile, publication, latest switch, and parent strict read covered required events",
      abrain_home: abrainHome,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      required_event_ids: requiredEventIds,
      final_read_reason: finalReason,
      contention_observed: contentionObserved,
      bundle_hash: finalRead.bundleHash,
      publication_status: attempted.publication.publication_status,
      already_valid_short_circuit: false as const,
    });
  } catch (error) {
    const controlled = controlledError(error);
    // Typed reason from error code only — never secondary-read selected_valid
    // over a pre-latest reject (would mask the original failure).
    finalReason = resolveStableFinalReadReason(finalReason, controlled);
    return Object.freeze({
      schema_version: "proposition-policy-stable-view-source-change-result/v1" as const,
      status: "failed" as const,
      reason: "source-change force republish failed closed",
      abrain_home: abrainHome,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      required_event_ids: requiredEventIds,
      final_read_reason: finalReason,
      contention_observed: contentionObserved,
      already_valid_short_circuit: false as const,
      error_code: controlled.code,
      error_message: controlled.message,
    });
  }
}

async function ackCoveredMarkersBestEffort(
  abrainHome: string,
  bundleHash: string,
  requiredEventIds: readonly string[],
): Promise<void> {
  // Ack only markers covered by candidate_dispositions with disposition
  // `included`. Excluded and non-candidate markers must remain durable for retry.
  // Delete/list/fsync failures must propagate: stable-view may already cover the
  // events, but durable ack is incomplete — force reports failed and markers
  // remain for a later cleanup/retry. Never swallow into a false success.
  const covered = new Set(readPublishedIncludedEventIds(abrainHome, bundleHash));
  const fromRequired = requiredEventIds.filter((id) => covered.has(id));
  const listed = await listPropositionPolicyStableViewSourceChangePendingMarkers(abrainHome);
  const extras = listed.filter((id) => covered.has(id) && !fromRequired.includes(id));
  await ackPropositionPolicyStableViewSourceChangePendingMarkers(
    abrainHome,
    [...fromRequired, ...extras],
  );
}

function missingRequiredEventIds(
  abrainHome: string,
  bundleHash: string,
  requiredEventIds: readonly string[],
): string[] {
  if (requiredEventIds.length === 0) return [];
  const present = new Set(readPublishedIncludedEventIds(abrainHome, bundleHash));
  return requiredEventIds.filter((id) => !present.has(id));
}

/**
 * Marker coverage uses candidate_dispositions, not canonical_source.input_event_ids.
 * input_event_ids is the whole L1 source closure (genesis/evidence/lifecycle +
 * excluded candidates). Only disposition `included` covers a pending marker for
 * ack. Production publication schema emits included|excluded only — do not treat
 * unreachable fixture-only `merged` as coverage.
 */
function readPublishedIncludedEventIds(abrainHome: string, bundleHash: string): string[] {
  if (!SHA256_PATTERN.test(bundleHash)) return [];
  const manifestPath = path.join(
    abrainHome,
    ...STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"),
    "bundles",
    bundleHash,
    "manifest.json",
  );
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as {
      candidate_dispositions?: { dispositions?: unknown };
    };
    const rows = manifest.candidate_dispositions?.dispositions;
    if (!Array.isArray(rows)) return [];
    const ids: string[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const rec = row as { source_event_id?: unknown; disposition?: unknown };
      if (typeof rec.source_event_id !== "string" || !SHA256_PATTERN.test(rec.source_event_id)) continue;
      // Only disposition `included` covers markers; excluded/other must not ack.
      if (rec.disposition === "included") {
        ids.push(rec.source_event_id);
      }
    }
    return ids;
  } catch {
    // Fail-closed for coverage checks: empty means every required id is missing
    // when the required set is non-empty. Do not treat parse/IO errors as
    // "no requirements".
    return [];
  }
}

/**
 * Map controlled failure codes to a stable final_read_reason without re-reading
 * latest (which can be selected_valid on the prior bundle and mask the error).
 * Distinguishes runtime-budget oversize from publisher hard-envelope oversize.
 */
function resolveStableFinalReadReason(
  current: string,
  controlled: { code: string; message: string },
): string {
  if (current && current !== "not_read") return current;
  const code = controlled.code || "";
  const message = controlled.message || "";
  if (
    code === "PUBLICATION_RUNTIME_BUDGET_EXCEEDED"
    || message.includes("PUBLICATION_RUNTIME_BUDGET_EXCEEDED")
  ) {
    return "runtime_budget_oversize";
  }
  if (
    code === "PUBLICATION_ARTIFACT_OVERSIZE"
    || code === "PUBLICATION_BUNDLE_OVERSIZE"
    || code === "FILE_OVERSIZE"
    || message.includes("PUBLICATION_ARTIFACT_OVERSIZE")
    || message.includes("PUBLICATION_BUNDLE_OVERSIZE")
  ) {
    return "publication_artifact_oversize";
  }
  if (code === "statement_oversize" || /statement_oversize/i.test(message)) {
    return "statement_oversize";
  }
  if (code === "payload_oversize" || /payload_oversize/i.test(message)) {
    return "payload_oversize";
  }
  // Post-publish validation embeds the reader reason after the colon.
  const embedded = /rejected the (?:published|contended) artifact:\s*(\S+)/.exec(message);
  if (embedded?.[1]) return embedded[1];
  // Generic reader oversize (hard or runtime) from message path.
  if (/\boversize\b/i.test(message) || code === "oversize") return "oversize";
  return code || "not_read";
}

export function getPropositionPolicyStableViewSourceChangeDiagnostics(abrainHome?: string): Readonly<{
  in_flight: boolean;
  scheduled: boolean;
  pending_event_ids: readonly string[];
  latest?: PropositionPolicyStableViewSourceChangeResult;
  tail: readonly PropositionPolicyStableViewSourceChangeResult[];
}> {
  const state = sourceChangeState();
  const key = path.resolve(abrainHome ?? resolvePropositionPolicyStableViewCurrentAbrainHome());
  const pending = state.pendingIds.get(key);
  return Object.freeze({
    in_flight: state.inFlight.has(key),
    scheduled: state.scheduled.has(key),
    pending_event_ids: Object.freeze(pending ? [...pending].sort() : []),
    ...(state.latest.get(key) ? { latest: state.latest.get(key)! } : {}),
    tail: Object.freeze(state.tail.slice()),
  });
}

/** Test-only: wait until no scheduled/in-flight source-change work remains. */
export async function waitForPropositionPolicyStableViewSourceChangeRepublishIdle(
  abrainHome?: string,
  timeoutMs = 120_000,
): Promise<void> {
  assertTestHooksEnabled("waitForPropositionPolicyStableViewSourceChangeRepublishIdle");
  const deadline = Date.now() + timeoutMs;
  const key = abrainHome ? path.resolve(abrainHome) : undefined;
  for (;;) {
    const state = sourceChangeState();
    const scheduledBusy = key ? state.scheduled.has(key) : state.scheduled.size > 0;
    const inFlightBusy = key ? state.inFlight.has(key) : state.inFlight.size > 0;
    const pendingBusy = key
      ? (state.pendingIds.get(key)?.size ?? 0) > 0
      : [...state.pendingIds.values()].some((set) => set.size > 0);
    if (!scheduledBusy && !inFlightBusy && !pendingBusy) return;
    if (Date.now() >= deadline) {
      throw new Error("waitForPropositionPolicyStableViewSourceChangeRepublishIdle timed out");
    }
    const inflight = key ? state.inFlight.get(key) ?? state.scheduled.get(key) : undefined;
    if (inflight) {
      await inflight.catch(() => undefined);
      continue;
    }
    await delay(10);
  }
}

/** Test-only: clear process-global source-change republish state (not durable markers). */
export function resetPropositionPolicyStableViewSourceChangeRepublishForTests(): void {
  assertTestHooksEnabled("resetPropositionPolicyStableViewSourceChangeRepublishForTests");
  const state = sourceChangeState();
  state.scheduled.clear();
  state.inFlight.clear();
  state.pendingIds.clear();
  state.latest.clear();
  state.tail.length = 0;
  state.lastOptions.clear();
}

function assertTestHooksEnabled(name: string): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error(`${name} requires PI_ASTACK_ENABLE_TEST_HOOKS=1`);
  }
}
