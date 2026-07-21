import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES,
} from "./proposition-policy-stable-view-contract";
import { stableViewCanonicalizeJcs } from "./proposition-policy-stable-view";
import { resolvePropositionPolicyStableViewCurrentAbrainHome } from "./proposition-policy-stable-view-root";
import { acquireRetainedDirectoryOfdLock } from "./retained-directory-ofd-lock";
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
    const initial = strictRead(options.abrainHome);
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

    const attempted = await publishWithContention(options);
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
    const finalRead = strictRead(options.abrainHome);
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

async function publishWithContention(options: PropositionPolicyStableViewRecoveryOptions): Promise<PublicationAttempt> {
  const waitMs = boundedInteger(options.contentionWaitMs, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CONTENTION_WAIT_MS, 0, 120_000);
  const pollMs = boundedInteger(options.contentionPollMs, 50, 5, 1_000);
  const sourceRaceRetries = boundedInteger(options.sourceRaceMaxRetries, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_SOURCE_RACE_RETRIES, 0, 10);
  const sourceRaceBackoffMs = boundedInteger(options.sourceRaceBackoffMs, PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_SOURCE_RACE_BACKOFF_MS, 5, 2_000);
  const deadline = Date.now() + waitMs;
  let contentionObserved = false;
  let sourceRaceCount = 0;
  let childAttempt = 0;
  for (;;) {
    childAttempt += 1;
    const child = await runPublicationChild(options, childAttempt);
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
    const observed = strictRead(options.abrainHome);
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
): Promise<ChildPublication | ChildFailure> {
  const script = path.join(options.repoRoot, ...PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_CHILD_RELATIVE.split("/"));
  const args = [
    script,
    "--abrain-home", options.abrainHome,
    "--repo-root", options.repoRoot,
    "--attempt", String(attempt),
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

function strictRead(abrainHome: string): PropositionPolicyStableViewRuntimeReadResult {
  return readPropositionPolicyStableViewForRuntime({
    abrainHome,
    settings: { maxReadBytes: PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES },
    sessionManager: VALIDATION_SESSION_MANAGER,
  });
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
