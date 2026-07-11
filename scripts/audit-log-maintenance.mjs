#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  BOUNDARY_PRECISION,
  rotateJsonlGenerationStrict,
} = await jiti.import(path.join(repoRoot, "extensions/_shared/rotating-jsonl.ts"));
const {
  signAuditMaintenanceHmacStrict,
  verifyAuditMaintenanceHmacStrict,
} = await jiti.import(path.join(repoRoot, "extensions/_shared/audit-hmac.ts"));

const TOOL_NAME = "pi-astack-audit-log-maintenance";
const TOOL_VERSION = "2.1.0";
const SEAL_SCHEMA_VERSION = "audit-seal-manifest/v2";
const PIN_REQUEST_SCHEMA_VERSION = "incident-pin-request/v1";
const PIN_OUTPUT_SCHEMA_VERSION = "incident-pin/v1";
const RETENTION = Object.freeze({
  schema_version: "reasoning-retention/v1",
  hot_retention_days: 7,
  archive_retention_days: 30,
  pinned_exempt: true,
  automatic_gc: false,
});
const MAX_PIN_INPUT_BYTES = 1024 * 1024;
const MAX_PIN_OUTPUT_BYTES = 256 * 1024;
const MAX_PIN_SOURCES = 128;
const MAX_PIN_METRICS = 64;
const MAX_PIN_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_PIN_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_PIN_TOTAL_BYTES = 256 * 1024 * 1024;
const PIN_TIME_BUDGET_MS = 60_000;
const SESSION_ROOT = "/home/worker/.pi/agent/sessions";
const EVIDENCE_SCHEMA_VERSION = "incident-evidence/v1";
const DEFAULT_SEAL_MAX_BYTES = 512 * 1024 * 1024;
const HARD_SEAL_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_TOTAL_HASH_BYTES = 2 * 1024 * 1024 * 1024;
const HARD_TOTAL_HASH_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_SEAL_TIME_BUDGET_MS = 60_000;
const HARD_SEAL_TIME_BUDGET_MS = 60_000;
const DEFAULT_TOTAL_TIME_BUDGET_MS = 10 * 60 * 1000;
const HARD_TOTAL_TIME_BUDGET_MS = 10 * 60 * 1000;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 4096;
const DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS = 1_000;
const MAX_MAINTENANCE_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_STABLE_MS = 30_000;
const MAX_STABLE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_DELETION_SCHEMA_VERSION = "audit-prune-deletion-journal/v1";
const SEAL_SIGNATURE_DOMAIN = "pi-astack/audit-seal-manifest/v2";
const PRUNE_JOURNAL_SIGNATURE_DOMAIN = "audit-prune-journal/v1";
const HARD_COMMAND_READ_ENTRIES = 100_000;
const DEFAULT_PRUNE_READ_ENTRIES = 20_000;
const DEFAULT_PIN_READ_ENTRIES = MAX_PIN_SOURCES + 1;
const DEFAULT_PRUNE_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PRUNE_KEEP_LATEST = 2;
const DEFAULT_PRUNE_BATCH_BYTES = 512 * 1024 * 1024;
const DEFAULT_PRUNE_BATCH_FILES = 16;
const MAX_PRUNE_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_PRUNE_RETENTION_DAYS = 3650;
const MAX_PRUNE_KEEP_LATEST = 1024;
const MAX_PRUNE_BATCH_FILES = 1024;
const MAX_PRUNE_SCAN_ENTRIES = 100_000;
const GENERATED_ARCHIVE = /^llm-audit__first-\d{8}T\d{9}Z__observed-last-pre-rotate-\d{8}T\d{9}Z__rotated-\d{8}T\d{9}Z__pid-\d+__seq-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:__[A-Za-z0-9._-]{1,64})?\.jsonl$/i;
const SEAL_MANIFEST_NAME = /^archive-seal-manifest-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const PIN_MANIFEST_NAME = /^incident-pin-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const TEST_HOOKS_ENABLED = process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1";

function testHook(name) {
  return TEST_HOOKS_ENABLED ? process.env[name] : undefined;
}

class MaintenanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class CommandReadBudget {
  constructor({ maxEntries, maxBytes, maxTimeMs, entryCode, bytesCode, timeCode }) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxTimeMs = maxTimeMs;
    this.entryCode = entryCode;
    this.bytesCode = bytesCode;
    this.timeCode = timeCode;
    this.startedMs = Date.now();
    this.deadlineMs = this.startedMs + maxTimeMs;
    this.entries = 0;
    this.bytes = 0;
  }

  assertTime(label) {
    if (Date.now() > this.deadlineMs) throw new MaintenanceError(this.timeCode, `command read time budget exceeded while reading ${label}`, this.report());
  }

  beginEntry(label, apparentBytes, perFileMaxBytes, perFileTimeMs) {
    this.assertTime(label);
    if (this.entries >= this.maxEntries) throw new MaintenanceError(this.entryCode, `command read entry budget exceeds ${this.maxEntries}`, this.report());
    if (!Number.isSafeInteger(apparentBytes) || apparentBytes < 0 || apparentBytes > perFileMaxBytes) {
      throw new MaintenanceError(this.bytesCode, `file exceeds ${perFileMaxBytes} bytes: ${label}`, this.report());
    }
    if (this.bytes + apparentBytes > this.maxBytes) {
      throw new MaintenanceError(this.bytesCode, `command read bytes would exceed ${this.maxBytes}: ${label}`, this.report());
    }
    this.entries += 1;
    return Math.min(this.deadlineMs, Date.now() + perFileTimeMs);
  }

  beforeChunk(label, requestedBytes, fileDeadlineMs) {
    this.assertTime(label);
    if (Date.now() > fileDeadlineMs) throw new MaintenanceError(this.timeCode, `file read time budget exceeded: ${label}`, this.report());
    const remaining = this.maxBytes - this.bytes;
    if (requestedBytes > remaining) throw new MaintenanceError(this.bytesCode, `command read bytes exceed ${this.maxBytes}: ${label}`, this.report());
  }

  afterChunk(label, bytesRead, fileDeadlineMs) {
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || this.bytes + bytesRead > this.maxBytes) {
      throw new MaintenanceError(this.bytesCode, `command read bytes exceed ${this.maxBytes}: ${label}`, this.report());
    }
    this.bytes += bytesRead;
    this.assertTime(label);
    if (Date.now() > fileDeadlineMs) throw new MaintenanceError(this.timeCode, `file read time budget exceeded: ${label}`, this.report());
  }

  report() {
    return {
      consumed: { entries: this.entries, bytes: this.bytes, elapsed_ms: Math.max(0, Date.now() - this.startedMs) },
      limits: { entries: this.maxEntries, bytes: this.maxBytes, time_ms: this.maxTimeMs },
    };
  }
}

function emitTestReadyMarker(phase, details = {}) {
  const marker = testHook("PI_ASTACK_MAINTENANCE_TEST_READY_MARKER");
  if (!marker) return;
  const temporary = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ phase, pid: process.pid, ...details })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, marker);
}

function emitTestFsyncPhase(phase, details = {}) {
  const trace = testHook("PI_ASTACK_MAINTENANCE_TEST_FSYNC_TRACE");
  if (trace) fs.appendFileSync(trace, `${JSON.stringify({ phase, pid: process.pid, ...details })}\n`, { mode: 0o600 });
  emitTestReadyMarker(`fsync_${phase}`, details);
}

async function awaitTestGate(phase) {
  const gate = testHook("PI_ASTACK_MAINTENANCE_TEST_GATE");
  const gatePhase = testHook("PI_ASTACK_MAINTENANCE_TEST_GATE_PHASE");
  if (!gate || (gatePhase && gatePhase !== phase)) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(gate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new MaintenanceError("TEST_GATE_TIMEOUT", `test gate timed out: ${gate}`);
}

function canonicalJson(valueToSerialize) {
  if (valueToSerialize === null || typeof valueToSerialize === "boolean" || typeof valueToSerialize === "string") return JSON.stringify(valueToSerialize);
  if (typeof valueToSerialize === "number") {
    if (!Number.isFinite(valueToSerialize)) throw new MaintenanceError("CANONICAL_JSON_INVALID", "non-finite number cannot be canonicalized");
    return JSON.stringify(valueToSerialize);
  }
  if (Array.isArray(valueToSerialize)) return `[${valueToSerialize.map(canonicalJson).join(",")}]`;
  if (!valueToSerialize || typeof valueToSerialize !== "object") throw new MaintenanceError("CANONICAL_JSON_INVALID", "unsupported canonical JSON value");
  return `{${Object.keys(valueToSerialize).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(valueToSerialize[key])}`).join(",")}}`;
}

function projectRootForSink(sinkRoot) {
  if (path.basename(sinkRoot) !== "llm-audit" || path.basename(path.dirname(sinkRoot)) !== ".pi-astack") {
    throw new MaintenanceError("PATH_REJECTED", `not a canonical llm-audit sink: ${sinkRoot}`);
  }
  return path.dirname(path.dirname(sinkRoot));
}

function sinkRootFromPath(candidate) {
  const marker = `${path.sep}.pi-astack${path.sep}llm-audit`;
  const index = candidate.lastIndexOf(marker);
  if (index < 0) return null;
  return candidate.slice(0, index + marker.length);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM" ? true : error?.code === "ESRCH" ? false : null; }
}

async function removeDeadLock(access, directory) {
  let before;
  try { before = await fsp.lstat(access); } catch (error) { return error?.code === "ENOENT"; }
  if (before.isSymbolicLink() || !before.isFile() || before.size > 4096) return false;
  let handle;
  try {
    handle = await fsp.open(access, fs.constants.O_RDONLY | NOFOLLOW);
    const held = await handle.stat();
    if (!held.isFile() || !sameIdentity(identity(before), identity(held))) return false;
    let parsed;
    try { parsed = JSON.parse((await handle.readFile()).toString("utf8")); } catch { return false; }
    if (pidIsAlive(parsed?.pid) !== false) return false;
    const current = await fsp.lstat(access).catch(() => null);
    if (!current?.isFile() || current.isSymbolicLink() || !sameIdentity(identity(current), identity(held))) return false;
    await fsp.unlink(access);
    await directory.handle.sync();
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function acquireSinkLock(sinkRoot, basename, timeoutMs, label) {
  const directory = await openMaintenanceDirectory(sinkRoot, `${label} directory`, false, false);
  const access = path.join(directory.procPath, basename);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await fsp.open(access, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      const before = await handle.stat();
      if (!before.isFile()) throw new MaintenanceError("LOCK_UNSAFE", `${label} lock is not a regular file: ${path.join(sinkRoot, basename)}`);
      const lockIdentity = identity(before);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID(), created_at: new Date().toISOString(), label })}\n`);
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await directory.handle.sync();
      await verifyHeldDirectory(directory);
      return {
        path: path.join(sinkRoot, basename),
        identity: lockIdentity,
        async verify() {
          await verifyHeldDirectory(directory);
          const current = await fsp.lstat(access);
          if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(identity(current), lockIdentity)) {
            throw new MaintenanceError("LOCK_LOST", `${label} lock identity changed: ${path.join(sinkRoot, basename)}`);
          }
        },
        async release() {
          try {
            const current = await fsp.lstat(access).catch(() => null);
            if (current?.isFile() && !current.isSymbolicLink() && sameIdentity(identity(current), lockIdentity)) {
              await fsp.unlink(access);
              await directory.handle.sync();
            }
          } finally {
            await directory.handle.close();
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        await directory.handle.close();
        throw error;
      }
      if (await removeDeadLock(access, directory)) continue;
      if (Date.now() >= deadline) {
        await directory.handle.close();
        throw new MaintenanceError("MAINTENANCE_LOCK_TIMEOUT", `${label} lock timeout after ${timeoutMs}ms: ${path.join(sinkRoot, basename)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
}

async function acquireMaintenanceLocks(roots, timeoutMs) {
  const locks = [];
  try {
    for (const root of [...new Set(roots)].sort()) locks.push(await acquireSinkLock(root, ".audit-maintenance.lock", timeoutMs, "audit-maintenance"));
    return locks;
  } catch (error) {
    await Promise.all(locks.reverse().map((lock) => lock.release().catch(() => {})));
    throw error;
  }
}

async function releaseLocks(locks) {
  for (const lock of [...locks].reverse()) await lock.release();
}

const COMMANDS = {
  inventory: {
    options: { "--root": { repeatable: true, value: true } },
  },
  "rotate-legacy": {
    options: {
      "--root": { value: true },
      "--path": { value: true },
      "--yes": { value: false },
    },
  },
  pin: {
    options: {
      "--input-manifest": { value: true },
      "--output-dir": { value: true },
      "--read-max-entries": { value: true },
      "--read-max-bytes-total": { value: true },
      "--read-time-budget-ms-total": { value: true },
      "--lock-timeout-ms": { value: true },
      "--yes": { value: false },
    },
  },
  seal: {
    options: {
      "--root": { repeatable: true, value: true },
      "--stable-ms": { value: true },
      "--max-bytes": { value: true },
      "--total-max-bytes": { value: true },
      "--time-budget-ms": { value: true },
      "--total-time-budget-ms": { value: true },
      "--read-max-entries": { value: true },
      "--lock-timeout-ms": { value: true },
      "--yes": { value: false },
    },
  },
  prune: {
    options: {
      "--root": { value: true },
      "--retention-days": { value: true },
      "--max-archive-bytes": { value: true },
      "--keep-latest-generations": { value: true },
      "--batch-max-bytes": { value: true },
      "--batch-max-files": { value: true },
      "--hash-max-bytes-per-file": { value: true },
      "--hash-max-bytes-total": { value: true },
      "--hash-time-budget-ms-per-file": { value: true },
      "--hash-time-budget-ms-total": { value: true },
      "--read-max-entries": { value: true },
      "--lock-timeout-ms": { value: true },
      "--yes": { value: false },
    },
  },
};

function parseCli(rawArgv) {
  const command = rawArgv[0] ?? "inventory";
  const spec = COMMANDS[command];
  if (!spec) throw new MaintenanceError("UNKNOWN_COMMAND", `unknown command: ${command}`, { commands: Object.keys(COMMANDS) });
  const parsed = { command, values: new Map(), flags: new Set() };
  for (let index = 1; index < rawArgv.length; index++) {
    const token = rawArgv[index];
    if (!token.startsWith("--")) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `unexpected positional argument: ${token}`);
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const option = spec.options[name];
    if (!option) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `unknown option for ${command}: ${name}`);
    if (!option.value) {
      if (equals >= 0) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `${name} does not take a value`);
      if (parsed.flags.has(name)) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `duplicate option is not allowed: ${name}`);
      parsed.flags.add(name);
      continue;
    }
    let value;
    if (equals >= 0) {
      value = token.slice(equals + 1);
      if (!value) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `missing value for ${name}`);
    } else {
      const next = rawArgv[++index];
      if (!next || next.startsWith("--")) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `missing value for ${name}`);
      value = next;
    }
    const prior = parsed.values.get(name) ?? [];
    if (!option.repeatable && prior.length > 0) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `duplicate option is not allowed: ${name}`);
    if (prior.includes(value)) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `duplicate value is not allowed for ${name}`);
    prior.push(value);
    parsed.values.set(name, prior);
  }
  return parsed;
}

function values(cli, name) {
  return cli.values.get(name) ?? [];
}

function value(cli, name) {
  return values(cli, name)[0];
}

function has(cli, name) {
  return cli.flags.has(name);
}

function requireCount(cli, name, minimum, maximum, code = "CLI_ARGUMENT_INVALID") {
  const count = values(cli, name).length;
  if (count < minimum || count > maximum) {
    const expected = minimum === maximum ? `exactly ${minimum}` : `${minimum}..${maximum}`;
    throw new MaintenanceError(code, `${cli.command} requires ${expected} ${name} value(s)`);
  }
}

function absoluteNormalized(raw, label) {
  if (typeof raw !== "string" || !path.isAbsolute(raw) || path.resolve(raw) !== raw) {
    throw new MaintenanceError("PATH_REJECTED", `${label} must be a normalized absolute path: ${raw}`);
  }
  return raw;
}

function integerOption(raw, fallback, minimum, maximum, label) {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new MaintenanceError("CLI_ARGUMENT_INVALID", `${label} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MaintenanceError("CLI_ARGUMENT_INVALID", `${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function isoCompact(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(".", "");
}

function output(valueToPrint) {
  process.stdout.write(`${JSON.stringify(valueToPrint, null, 2)}\n`);
}

function fileType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isSocket()) return "socket";
  if (stat.isFIFO()) return "fifo";
  if (stat.isBlockDevice()) return "block_device";
  if (stat.isCharacterDevice()) return "character_device";
  return "other";
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtime_ms === right.mtime_ms && left.ctime_ms === right.ctime_ms;
}

function snapshot(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    mtime_ms: stat.mtimeMs,
    ctime: stat.ctime.toISOString(),
    ctime_ms: stat.ctimeMs,
  };
}

async function assertNoSymlinkChain(target, options = {}) {
  const normalized = absoluteNormalized(target, options.label ?? "path");
  const parsed = path.parse(normalized);
  const relativeParts = normalized.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < relativeParts.length; index++) {
    current = path.join(current, relativeParts[index]);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && options.allowMissingLeaf && index === relativeParts.length - 1) return { missing: true };
      throw new MaintenanceError("PATH_REJECTED", `path component is missing or unreadable: ${current}`, { error_code: error?.code ?? "UNKNOWN" });
    }
    if (stat.isSymbolicLink()) throw new MaintenanceError("PATH_REJECTED", `symlink path component is forbidden: ${current}`);
    if (index < relativeParts.length - 1 && !stat.isDirectory()) {
      throw new MaintenanceError("PATH_REJECTED", `intermediate path component is not a directory: ${current}`);
    }
  }
  return { missing: false };
}

async function canonicalDirectory(raw, label) {
  const dir = absoluteNormalized(raw, label);
  await assertNoSymlinkChain(dir, { label });
  const stat = await fsp.lstat(dir);
  if (!stat.isDirectory()) throw new MaintenanceError("PATH_REJECTED", `${label} is not a directory: ${dir}`);
  const real = await fsp.realpath(dir);
  if (real !== dir) throw new MaintenanceError("PATH_REJECTED", `${label} is not canonical: ${dir}`);
  return dir;
}

async function openRegularNoFollow(file, maxBytes) {
  const before = await fsp.lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new MaintenanceError("PATH_REJECTED", `regular non-symlink file required: ${file}`);
  if (maxBytes !== undefined && before.size > maxBytes) throw new MaintenanceError("SIZE_LIMIT_EXCEEDED", `file exceeds ${maxBytes} bytes: ${file}`);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isFile() || !sameSnapshot(snapshot(before), snapshot(held))) {
      throw new MaintenanceError("IDENTITY_CHANGED", `file identity or size changed while opening: ${file}`);
    }
    const real = await fsp.realpath(file);
    if (real !== file) throw new MaintenanceError("PATH_REJECTED", `file realpath differs from expected path: ${file}`);
    return { handle, stat: held };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readRegularSnapshot({
  accessPath,
  logicalPath,
  maxBytes,
  perFileTimeMs,
  budget,
  collect = false,
  sizeCode = "SIZE_LIMIT_EXCEEDED",
  identityCode = "IDENTITY_CHANGED",
  chunkDelayMs = 0,
  readyPhase,
}) {
  const beforeStat = await fsp.lstat(logicalPath);
  if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) throw new MaintenanceError(identityCode, `regular non-symlink file required: ${logicalPath}`);
  if (beforeStat.size > maxBytes) throw new MaintenanceError(sizeCode, `file exceeds ${maxBytes} bytes: ${logicalPath}`);
  const before = snapshot(beforeStat);
  const fileDeadlineMs = budget.beginEntry(logicalPath, beforeStat.size, maxBytes, perFileTimeMs);
  const handle = await fsp.open(accessPath, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const heldStat = await handle.stat();
    const held = snapshot(heldStat);
    if (!heldStat.isFile() || !sameSnapshot(before, held)) throw new MaintenanceError(identityCode, `file identity or size changed while opening: ${logicalPath}`);
    const digest = createHash("sha256");
    const chunks = collect ? [] : null;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, maxBytes)));
    let bytes = 0;
    let lines = 0;
    let lastByte = null;
    let readyEmitted = false;
    while (bytes < before.size) {
      const requested = Math.min(buffer.length, before.size - bytes);
      budget.beforeChunk(logicalPath, requested, fileDeadlineMs);
      const { bytesRead } = await handle.read(buffer, 0, requested, bytes);
      budget.afterChunk(logicalPath, bytesRead, fileDeadlineMs);
      if (bytesRead === 0) throw new MaintenanceError(identityCode, `file shrank while reading: ${logicalPath}`);
      const chunk = buffer.subarray(0, bytesRead);
      bytes += bytesRead;
      digest.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        if (newline < 0) break;
        lines += 1;
        offset = newline + 1;
      }
      lastByte = chunk[chunk.length - 1];
      const during = snapshot(await handle.stat());
      if (!sameSnapshot(held, during)) throw new MaintenanceError(identityCode, `file changed while reading: ${logicalPath}`);
      if (!readyEmitted && readyPhase) {
        emitTestReadyMarker(readyPhase, { path: logicalPath, bytes_read: bytesRead });
        readyEmitted = true;
      }
      if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
    }
    if (bytes > 0 && lastByte !== 10) lines += 1;
    const heldAfter = snapshot(await handle.stat());
    const pathAfterStat = await fsp.lstat(logicalPath);
    if (pathAfterStat.isSymbolicLink() || !pathAfterStat.isFile() || !sameSnapshot(held, heldAfter) || !sameSnapshot(held, snapshot(pathAfterStat)) || bytes !== held.size) {
      throw new MaintenanceError(identityCode, `file changed while reading: ${logicalPath}`);
    }
    return {
      bytes: chunks ? Buffer.concat(chunks, bytes) : null,
      byteCount: bytes,
      lines,
      sha256: digest.digest("hex"),
      snapshot: heldAfter,
    };
  } finally {
    await handle.close();
  }
}

async function inventoryPath(target, rows) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    rows.push({
      path: target,
      type: "missing_or_unreadable",
      error_code: error?.code ?? "UNKNOWN",
      active: path.basename(target) === "audit.jsonl",
      open: null,
    });
    return;
  }
  rows.push({
    path: target,
    apparent_bytes: stat.size,
    allocated_bytes: typeof stat.blocks === "number" ? stat.blocks * 512 : null,
    mtime: stat.mtime.toISOString(),
    type: fileType(stat),
    active: stat.isFile() && path.basename(target) === "audit.jsonl",
    open: null,
    open_detection: "not_required",
  });
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (error) {
    rows.push({ path: target, type: "directory_unreadable", error_code: error?.code ?? "UNKNOWN", active: false, open: null });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) await inventoryPath(path.join(target, entry.name), rows);
}

async function inventory(cli) {
  requireCount(cli, "--root", 1, Number.MAX_SAFE_INTEGER, "EXPLICIT_ROOT_REQUIRED");
  const roots = values(cli, "--root").map((item) => absoluteNormalized(item, "inventory root"));
  const rows = [];
  for (const root of roots) await inventoryPath(root, rows);
  output({
    ok: true,
    command: "inventory",
    dry_run: true,
    generated_at: new Date().toISOString(),
    root_rule: "one_or_more_unique_normalized_absolute_paths",
    roots,
    entries: rows,
    content_read: false,
  });
}

async function validateLegacyLayout(root, target, createArchive) {
  const canonicalRoot = await canonicalDirectory(root, "rotate root");
  const expected = path.join(canonicalRoot, ".pi-astack", "llm-audit", "audit.jsonl");
  if (target !== expected) throw new MaintenanceError("LEGACY_PATH_REJECTED", `target must equal the exact legacy active path: ${expected}`);
  const sinkDir = path.dirname(expected);
  const archiveDir = path.join(sinkDir, "archive");
  await canonicalDirectory(path.join(canonicalRoot, ".pi-astack"), ".pi-astack directory");
  await canonicalDirectory(sinkDir, "llm-audit directory");
  const archiveState = await assertNoSymlinkChain(archiveDir, { label: "archive directory", allowMissingLeaf: true });
  if (archiveState.missing && createArchive) await fsp.mkdir(archiveDir, { mode: 0o700 });
  if (!archiveState.missing || createArchive) await canonicalDirectory(archiveDir, "archive directory");
  await assertNoSymlinkChain(expected, { label: "legacy target" });
  const opened = await openRegularNoFollow(expected);
  try {
    return { canonicalRoot, expected, sinkDir, archiveDir, identity: identity(opened.stat) };
  } finally {
    await opened.handle.close();
  }
}

async function rotateLegacy(cli) {
  requireCount(cli, "--root", 1, 1, "LEGACY_PATH_REJECTED");
  requireCount(cli, "--path", 1, 1, "LEGACY_PATH_REJECTED");
  const root = absoluteNormalized(value(cli, "--root"), "rotate root");
  const target = absoluteNormalized(value(cli, "--path"), "legacy target");
  const execute = has(cli, "--yes");
  let validated;
  try {
    validated = await validateLegacyLayout(root, target, false);
  } catch (error) {
    if (error instanceof MaintenanceError && error.code !== "LEGACY_PATH_REJECTED") {
      throw new MaintenanceError("LEGACY_PATH_REJECTED", error.message, error.details);
    }
    throw error;
  }
  if (!execute) {
    output({
      ok: true,
      command: "rotate-legacy",
      dry_run: true,
      generated_at: new Date().toISOString(),
      roots: [validated.canonicalRoot],
      entries: [{ path: target, status: "planned", operation: "rename_generation", delete: false, compress: false }],
    });
    return;
  }

  const pauseMs = integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_PAUSE_MS"), 0, 0, 10_000, "test pause");
  const validateLocked = async () => {
    emitTestReadyMarker("strict_rotate_locked", { path: target });
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const current = await validateLegacyLayout(root, target, true);
    return current.identity;
  };
  const result = await rotateJsonlGenerationStrict(target, {
    sink: "llm-audit",
    archiveTag: "legacy-pre-shape",
    rotation: { enabled: true, maxBytes: 256 * 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000, lockTimeoutMs: 1_000 },
    expectedIdentity: validated.identity,
    validateLocked,
  });
  output({
    ok: true,
    command: "rotate-legacy",
    dry_run: false,
    generated_at: new Date().toISOString(),
    roots: [validated.canonicalRoot],
    entries: [{
      path: target,
      status: "rotated",
      archive_path: result.archivePath,
      active_path: target,
      original_identity: validated.identity,
      boundary_precision: BOUNDARY_PRECISION,
      delete: false,
      compress: false,
      diagnostics: result.diagnostics,
    }],
  });
}

function exactKeys(valueToCheck, required, optional, label) {
  if (!valueToCheck || typeof valueToCheck !== "object" || Array.isArray(valueToCheck)) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(valueToCheck)) {
    if (!allowed.has(key)) throw new MaintenanceError("PIN_INPUT_INVALID", `${label} has unknown property: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(valueToCheck, key)) throw new MaintenanceError("PIN_INPUT_INVALID", `${label} is missing required property: ${key}`);
  }
}

function uuid(valueToCheck, label) {
  if (typeof valueToCheck !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valueToCheck)) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be an RFC UUID`);
  }
  return valueToCheck.toLowerCase();
}

function isoTimestamp(valueToCheck, label) {
  if (typeof valueToCheck !== "string" || valueToCheck.length > 32 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(valueToCheck) || new Date(valueToCheck).toISOString() !== valueToCheck) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be a canonical UTC ISO timestamp`);
  }
  return valueToCheck;
}

function enumValue(valueToCheck, allowed, label) {
  if (typeof valueToCheck !== "string" || !allowed.includes(valueToCheck)) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be one of: ${allowed.join(", ")}`);
  }
  return valueToCheck;
}

function boundedInteger(valueToCheck, maximum, label) {
  if (!Number.isSafeInteger(valueToCheck) || valueToCheck < 0 || valueToCheck > maximum) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be an integer in 0..${maximum}`);
  }
  return valueToCheck;
}

function sourcePath(valueToCheck, kind, label) {
  if (typeof valueToCheck !== "string" || valueToCheck.length > 4096 || /[\0\r\n]/.test(valueToCheck) || !path.isAbsolute(valueToCheck) || path.resolve(valueToCheck) !== valueToCheck) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be a bounded normalized absolute path`);
  }
  const slash = valueToCheck.split(path.sep).join("/");
  const basename = path.basename(valueToCheck);
  const generatedArchive = /^[A-Za-z0-9._-]{1,64}__first-\d{8}T\d{9}Z__observed-last-pre-rotate-\d{8}T\d{9}Z__rotated-\d{8}T\d{9}Z__pid-\d+__seq-[A-Za-z0-9._-]{1,128}(?:__[A-Za-z0-9._-]{1,64})?\.jsonl$/;
  const generatedTrace = /^trace-\d{10,17}-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;
  const generatedSealManifest = /^archive-seal-manifest-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
  const generatedEvidenceManifest = /^incident-evidence-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
  const generatedSessionLog = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
  const parent = path.dirname(valueToCheck);
  const projectDir = path.basename(parent);
  const sessionMatch = generatedSessionLog.exec(basename);
  const sessionTimestamp = sessionMatch ? `${sessionMatch[1]}T${sessionMatch[2]}:${sessionMatch[3]}:${sessionMatch[4]}.${sessionMatch[5]}Z` : null;
  const sessionTimestampValid = sessionTimestamp !== null && !Number.isNaN(Date.parse(sessionTimestamp)) && new Date(sessionTimestamp).toISOString() === sessionTimestamp;
  const sessionAllowed = path.dirname(parent) === SESSION_ROOT &&
    /^--[A-Za-z0-9][A-Za-z0-9._-]{0,250}--$/.test(projectDir) &&
    sessionTimestampValid;
  const allowed = {
    llm_audit_archive: slash.includes("/.pi-astack/llm-audit/archive/") && generatedArchive.test(basename),
    reasoning_trace: slash.includes("/.pi-astack/llm-audit/dispatch-reasoning/") && generatedTrace.test(basename),
    seal_manifest: slash.includes("/.pi-astack/llm-audit/archive/") && generatedSealManifest.test(basename),
    dispatch_audit: slash.endsWith("/.pi-astack/dispatch/audit.jsonl"),
    session_log: sessionAllowed,
    evidence_manifest: slash.includes("/.pi-astack/llm-audit/incident-evidence/") && generatedEvidenceManifest.test(basename) &&
      path.basename(path.dirname(valueToCheck)) === "incident-evidence" &&
      path.basename(path.dirname(path.dirname(valueToCheck))) === "llm-audit" &&
      path.basename(path.dirname(path.dirname(path.dirname(valueToCheck)))) === ".pi-astack",
  }[kind];
  if (!allowed) throw new MaintenanceError("PIN_INPUT_INVALID", `${label} is outside the allowlist for source kind ${kind}`);
  return valueToCheck;
}

function toolCallId(valueToCheck, label) {
  if (typeof valueToCheck !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:|/-]{0,127}$/.test(valueToCheck)) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be a bounded opaque tool-call identifier`);
  }
  return valueToCheck;
}

function sha256(valueToCheck, label) {
  if (typeof valueToCheck !== "string" || !/^[0-9a-f]{64}$/.test(valueToCheck)) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return valueToCheck;
}

function validateEvidenceManifest(parsed) {
  exactKeys(parsed, ["schema_version", "incident", "session", "tool_call_id", "model", "status", "metrics", "hashes", "audit_rows", "derived_hashes", "evidence_level", "limitations", "timestamps"], [], "evidence_manifest");
  if (parsed.schema_version !== EVIDENCE_SCHEMA_VERSION) throw new MaintenanceError("PIN_INPUT_INVALID", `evidence_manifest.schema_version must be ${EVIDENCE_SCHEMA_VERSION}`);
  exactKeys(parsed.incident, ["incident_id", "severity", "status"], [], "evidence_manifest.incident");
  const incident = {
    incident_id: uuid(parsed.incident.incident_id, "evidence_manifest.incident.incident_id"),
    severity: enumValue(parsed.incident.severity, ["low", "medium", "high", "critical"], "evidence_manifest.incident.severity"),
    status: enumValue(parsed.incident.status, ["open", "mitigated", "resolved"], "evidence_manifest.incident.status"),
  };
  exactKeys(parsed.session, ["session_id", "turn_id", "subturn"], [], "evidence_manifest.session");
  const session = {
    session_id: uuid(parsed.session.session_id, "evidence_manifest.session.session_id"),
    turn_id: boundedInteger(parsed.session.turn_id, Number.MAX_SAFE_INTEGER, "evidence_manifest.session.turn_id"),
    subturn: boundedInteger(parsed.session.subturn, Number.MAX_SAFE_INTEGER, "evidence_manifest.session.subturn"),
  };
  const metricUnits = Object.freeze({
    tokens_in: "tokens",
    tokens_out: "tokens",
    max_output_tokens: "tokens",
    duration_ms: "milliseconds",
    output_chars: "characters",
    detector_period: "cycles",
    detector_rounds: "cycles",
    detector_repeated_chars: "characters",
    detector_trip_input_chars: "characters",
    thinking_delta_events: "events",
    reasoning_chars: "characters",
    reasoning_bytes: "bytes",
    reasoning_lines: "lines",
    audit_rows: "rows",
  });
  const metricsAllowed = Object.keys(metricUnits);
  if (!Array.isArray(parsed.metrics) || parsed.metrics.length > MAX_PIN_METRICS) throw new MaintenanceError("PIN_INPUT_INVALID", `evidence_manifest.metrics must contain 0..${MAX_PIN_METRICS} items`);
  const metrics = parsed.metrics.map((item, index) => {
    exactKeys(item, ["metric", "value", "unit"], [], `evidence_manifest.metrics[${index}]`);
    const metric = enumValue(item.metric, metricsAllowed, `evidence_manifest.metrics[${index}].metric`);
    const unit = enumValue(item.unit, ["characters", "tokens", "cycles", "events", "bytes", "lines", "rows", "milliseconds"], `evidence_manifest.metrics[${index}].unit`);
    const expected = metricUnits[metric];
    if (unit !== expected) throw new MaintenanceError("PIN_INPUT_INVALID", `evidence_manifest.metrics[${index}].unit must be ${expected}`);
    return { metric, value: boundedInteger(item.value, Number.MAX_SAFE_INTEGER, `evidence_manifest.metrics[${index}].value`), unit };
  });
  if (!Array.isArray(parsed.hashes) || parsed.hashes.length < 1 || parsed.hashes.length > MAX_PIN_SOURCES) throw new MaintenanceError("PIN_INPUT_INVALID", `evidence_manifest.hashes must contain 1..${MAX_PIN_SOURCES} items`);
  const hashSourceIds = new Set();
  const hashes = parsed.hashes.map((item, index) => {
    exactKeys(item, ["source_id", "kind", "sha256", "bytes", "lines"], [], `evidence_manifest.hashes[${index}]`);
    const sourceId = uuid(item.source_id, `evidence_manifest.hashes[${index}].source_id`);
    if (hashSourceIds.has(sourceId)) throw new MaintenanceError("PIN_INPUT_INVALID", `evidence_manifest.hashes has duplicate source_id: ${sourceId}`);
    hashSourceIds.add(sourceId);
    return {
      source_id: sourceId,
      kind: enumValue(item.kind, ["session_log", "reasoning_trace", "dispatch_audit"], `evidence_manifest.hashes[${index}].kind`),
      sha256: sha256(item.sha256, `evidence_manifest.hashes[${index}].sha256`),
      bytes: boundedInteger(item.bytes, Number.MAX_SAFE_INTEGER, `evidence_manifest.hashes[${index}].bytes`),
      lines: boundedInteger(item.lines, Number.MAX_SAFE_INTEGER, `evidence_manifest.hashes[${index}].lines`),
    };
  });
  if (!Array.isArray(parsed.audit_rows) || parsed.audit_rows.length > 16) throw new MaintenanceError("PIN_INPUT_INVALID", "evidence_manifest.audit_rows must contain 0..16 items");
  const auditRows = parsed.audit_rows.map((item, index) => {
    exactKeys(item, ["source_id", "row_index", "canonicalization", "sha256"], [], `evidence_manifest.audit_rows[${index}]`);
    const sourceId = uuid(item.source_id, `evidence_manifest.audit_rows[${index}].source_id`);
    const source = hashes.find((hash) => hash.source_id === sourceId);
    if (!source || source.kind !== "dispatch_audit") {
      throw new MaintenanceError("PIN_INPUT_INVALID", `evidence_manifest.audit_rows[${index}].source_id must reference hashes kind dispatch_audit`);
    }
    return {
      source_id: sourceId,
      row_index: boundedInteger(item.row_index, Number.MAX_SAFE_INTEGER, `evidence_manifest.audit_rows[${index}].row_index`),
      canonicalization: enumValue(item.canonicalization, ["rfc8785_jcs"], `evidence_manifest.audit_rows[${index}].canonicalization`),
      sha256: sha256(item.sha256, `evidence_manifest.audit_rows[${index}].sha256`),
    };
  });
  if (!Array.isArray(parsed.derived_hashes) || parsed.derived_hashes.length > 16) throw new MaintenanceError("PIN_INPUT_INVALID", "evidence_manifest.derived_hashes must contain 0..16 items");
  const derivedHashes = parsed.derived_hashes.map((item, index) => {
    exactKeys(item, ["kind", "sha256", "bytes", "characters"], [], `evidence_manifest.derived_hashes[${index}]`);
    return {
      kind: enumValue(item.kind, ["visible_output", "reasoning_delta_aggregate"], `evidence_manifest.derived_hashes[${index}].kind`),
      sha256: sha256(item.sha256, `evidence_manifest.derived_hashes[${index}].sha256`),
      bytes: boundedInteger(item.bytes, Number.MAX_SAFE_INTEGER, `evidence_manifest.derived_hashes[${index}].bytes`),
      characters: boundedInteger(item.characters, Number.MAX_SAFE_INTEGER, `evidence_manifest.derived_hashes[${index}].characters`),
    };
  });
  if (!Array.isArray(parsed.limitations) || parsed.limitations.length > 16) throw new MaintenanceError("PIN_INPUT_INVALID", "evidence_manifest.limitations must contain 0..16 items");
  const limitations = parsed.limitations.map((item, index) => enumValue(item, ["active_dispatch_snapshot", "eventually_stable_boundary", "session_contains_unrelated_turns", "audit_row_subset", "reasoning_trace_provider_supplied", "no_raw_content_copied"], `evidence_manifest.limitations[${index}]`));
  exactKeys(parsed.timestamps, ["occurred_at", "observed_at", "created_at"], [], "evidence_manifest.timestamps");
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    incident,
    session,
    tool_call_id: toolCallId(parsed.tool_call_id, "evidence_manifest.tool_call_id"),
    model: enumValue(parsed.model, ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"], "evidence_manifest.model"),
    status: enumValue(parsed.status, ["succeeded", "failed", "cancelled", "unknown"], "evidence_manifest.status"),
    metrics,
    hashes,
    audit_rows: auditRows,
    derived_hashes: derivedHashes,
    evidence_level: enumValue(parsed.evidence_level, ["production_observed", "production_correlated", "partial"], "evidence_manifest.evidence_level"),
    limitations,
    timestamps: {
      occurred_at: isoTimestamp(parsed.timestamps.occurred_at, "evidence_manifest.timestamps.occurred_at"),
      observed_at: isoTimestamp(parsed.timestamps.observed_at, "evidence_manifest.timestamps.observed_at"),
      created_at: isoTimestamp(parsed.timestamps.created_at, "evidence_manifest.timestamps.created_at"),
    },
  };
}

function validatePinRequest(parsed) {
  exactKeys(parsed, ["schema_version", "incident", "sources", "metrics"], [], "request");
  if (parsed.schema_version !== PIN_REQUEST_SCHEMA_VERSION) throw new MaintenanceError("PIN_INPUT_INVALID", `schema_version must be ${PIN_REQUEST_SCHEMA_VERSION}`);

  exactKeys(parsed.incident, ["incident_id", "occurred_at", "severity", "status"], [], "incident");
  const incident = {
    incident_id: uuid(parsed.incident.incident_id, "incident.incident_id"),
    occurred_at: isoTimestamp(parsed.incident.occurred_at, "incident.occurred_at"),
    severity: enumValue(parsed.incident.severity, ["low", "medium", "high", "critical"], "incident.severity"),
    status: enumValue(parsed.incident.status, ["open", "mitigated", "resolved"], "incident.status"),
  };

  if (!Array.isArray(parsed.sources) || parsed.sources.length < 1 || parsed.sources.length > MAX_PIN_SOURCES) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `sources must contain 1..${MAX_PIN_SOURCES} items`);
  }
  const sourceIds = new Set();
  const sources = parsed.sources.map((source, index) => {
    exactKeys(source, ["source_id", "kind", "path", "sha256", "bytes", "lines", "observed_at"], [], `sources[${index}]`);
    const kind = enumValue(source.kind, ["llm_audit_archive", "reasoning_trace", "seal_manifest", "dispatch_audit", "session_log", "evidence_manifest"], `sources[${index}].kind`);
    const sourceId = uuid(source.source_id, `sources[${index}].source_id`);
    if (sourceIds.has(sourceId)) throw new MaintenanceError("PIN_INPUT_INVALID", `duplicate source_id: ${sourceId}`);
    sourceIds.add(sourceId);
    return {
      source_id: sourceId,
      kind,
      path: sourcePath(source.path, kind, `sources[${index}].path`),
      sha256: sha256(source.sha256, `sources[${index}].sha256`),
      bytes: boundedInteger(source.bytes, Number.MAX_SAFE_INTEGER, `sources[${index}].bytes`),
      lines: boundedInteger(source.lines, Number.MAX_SAFE_INTEGER, `sources[${index}].lines`),
      observed_at: isoTimestamp(source.observed_at, `sources[${index}].observed_at`),
    };
  });

  if (!Array.isArray(parsed.metrics) || parsed.metrics.length > MAX_PIN_METRICS) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `metrics must contain 0..${MAX_PIN_METRICS} items`);
  }
  const metrics = parsed.metrics.map((metric, index) => {
    exactKeys(metric, ["metric", "value", "unit"], [], `metrics[${index}]`);
    const metricName = enumValue(metric.metric, ["affected_rows", "affected_files", "missing_rows", "duplicate_rows", "duration_ms"], `metrics[${index}].metric`);
    const unit = enumValue(metric.unit, ["rows", "files", "milliseconds"], `metrics[${index}].unit`);
    const requiredUnit = metricName === "affected_files" ? "files" : metricName === "duration_ms" ? "milliseconds" : "rows";
    if (unit !== requiredUnit) throw new MaintenanceError("PIN_INPUT_INVALID", `metrics[${index}].unit must be ${requiredUnit} for ${metricName}`);
    return {
      metric: metricName,
      value: boundedInteger(metric.value, Number.MAX_SAFE_INTEGER, `metrics[${index}].value`),
      unit,
    };
  });
  return { schema_version: PIN_REQUEST_SCHEMA_VERSION, incident, sources, metrics };
}

async function readBoundedJsonRegular(inputPath, budget) {
  await assertNoSymlinkChain(inputPath, { label: "pin input" });
  const read = await readRegularSnapshot({
    accessPath: inputPath,
    logicalPath: inputPath,
    maxBytes: MAX_PIN_INPUT_BYTES,
    perFileTimeMs: PIN_TIME_BUDGET_MS,
    budget,
    collect: true,
    sizeCode: "SIZE_LIMIT_EXCEEDED",
    identityCode: "PIN_INPUT_INVALID",
  });
  let parsed;
  try { parsed = JSON.parse(read.bytes.toString("utf8")); } catch (error) {
    throw new MaintenanceError("PIN_INPUT_INVALID", `input is not valid JSON: ${error.message}`);
  }
  return { parsed, sha256: read.sha256 };
}

async function verifyHeldDirectory(directory) {
  const held = await directory.handle.stat();
  if (!held.isDirectory() || !sameIdentity(identity(held), directory.identity)) {
    throw new MaintenanceError("IDENTITY_CHANGED", `held directory identity changed: ${directory.path}`);
  }
  let current;
  try { current = await fsp.lstat(directory.path); } catch (error) {
    throw new MaintenanceError("IDENTITY_CHANGED", `directory path disappeared after open: ${directory.path}`, { error_code: error?.code ?? "UNKNOWN" });
  }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(identity(current), directory.identity)) {
    throw new MaintenanceError("IDENTITY_CHANGED", `directory path identity changed after open: ${directory.path}`);
  }
  const procStat = await fsp.stat(directory.procPath).catch(() => null);
  if (!procStat?.isDirectory() || !sameIdentity(identity(procStat), directory.identity)) {
    throw new MaintenanceError("IDENTITY_CHANGED", `directory fd mapping identity changed: ${directory.path}`);
  }
}

async function openMaintenanceDirectory(dir, label, repairMode, emitReady = true) {
  const canonical = await canonicalDirectory(dir, label);
  const before = await fsp.lstat(canonical);
  const handle = await fsp.open(canonical, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || !sameIdentity(identity(before), identity(held))) {
      throw new MaintenanceError("IDENTITY_CHANGED", `${label} identity changed while opening: ${canonical}`);
    }
    if (process.platform !== "linux") {
      throw new MaintenanceError("MAINTENANCE_UNSUPPORTED", `${label} writes require Linux open-directory-relative support`);
    }
    const procPath = `/proc/self/fd/${handle.fd}`;
    const procStat = await fsp.stat(procPath).catch(() => null);
    if (!procStat?.isDirectory() || !sameIdentity(identity(procStat), identity(held))) {
      throw new MaintenanceError("MAINTENANCE_UNSUPPORTED", `${label} cannot validate /proc/self/fd directory access`);
    }
    const directory = { path: canonical, handle, identity: identity(held), procPath };
    if (repairMode) await handle.chmod(0o700);
    await verifyHeldDirectory(directory);
    if (emitReady) emitTestReadyMarker("directory_fd_ready", { path: canonical });
    const pauseMs = integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_DIRECTORY_PAUSE_MS"), 0, 0, 10_000, "directory test pause");
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    return directory;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function prepareOutputDirectory(outputDir, execute) {
  const state = await assertNoSymlinkChain(outputDir, { label: "pin output directory", allowMissingLeaf: true });
  if (state.missing) {
    const parent = await canonicalDirectory(path.dirname(outputDir), "pin output parent");
    if (path.dirname(outputDir) !== parent) throw new MaintenanceError("PATH_REJECTED", "pin output parent is not canonical");
    if (!execute) return null;
    await fsp.mkdir(outputDir, { mode: 0o700 });
  }
  if (!execute) {
    await canonicalDirectory(outputDir, "pin output directory");
    return null;
  }
  return openMaintenanceDirectory(outputDir, "pin output directory", true);
}

async function writeExclusiveFile(directory, basename, bytes) {
  if (path.basename(basename) !== basename || basename === "." || basename === "..") {
    throw new MaintenanceError("PATH_REJECTED", `output basename is invalid: ${basename}`);
  }
  const file = path.join(directory.procPath, basename);
  const handle = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new MaintenanceError("PATH_REJECTED", `output is not a regular file: ${basename}`);
    const fileIdentity = identity(before);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    const after = await handle.stat();
    if (!after.isFile() || !sameIdentity(fileIdentity, identity(after))) {
      throw new MaintenanceError("IDENTITY_CHANGED", `output identity changed while writing: ${basename}`);
    }
    await verifyHeldDirectory(directory);
  } finally {
    await handle.close();
  }
}

async function verifyPinSource(source, budget) {
  const maxBytes = source.kind === "session_log" ? MAX_PIN_SESSION_BYTES : MAX_PIN_SOURCE_BYTES;
  if (source.bytes > maxBytes) throw new MaintenanceError("PIN_SOURCE_SIZE_EXCEEDED", `${source.kind} request exceeds ${maxBytes} bytes: ${source.path}`);
  await assertNoSymlinkChain(source.path, { label: `pin ${source.kind} source` });
  const read = await readRegularSnapshot({
    accessPath: source.path,
    logicalPath: source.path,
    maxBytes,
    perFileTimeMs: PIN_TIME_BUDGET_MS,
    budget,
    collect: source.kind === "evidence_manifest",
    sizeCode: "PIN_SOURCE_SIZE_EXCEEDED",
    identityCode: "PIN_SOURCE_CHANGED",
    chunkDelayMs: integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_PIN_CHUNK_DELAY_MS"), 0, 0, 100, "pin test chunk delay"),
    readyPhase: "pin_source_hash_started",
  });
  if (read.byteCount !== source.bytes || read.lines !== source.lines || read.sha256 !== source.sha256) {
    throw new MaintenanceError("PIN_SOURCE_MISMATCH", `source hash/bytes/lines do not match request: ${source.path}`, {
      expected: { sha256: source.sha256, bytes: source.bytes, lines: source.lines },
      actual: { sha256: read.sha256, bytes: read.byteCount, lines: read.lines },
    });
  }
  if (read.bytes) {
    let parsed;
    try { parsed = JSON.parse(read.bytes.toString("utf8")); } catch (error) {
      throw new MaintenanceError("PIN_INPUT_INVALID", `evidence manifest is not valid JSON: ${error.message}`);
    }
    validateEvidenceManifest(parsed);
  }
  return {
    ...source,
    source_verified: true,
    identity: read.snapshot,
    verified_at: new Date().toISOString(),
  };
}

async function pin(cli) {
  requireCount(cli, "--input-manifest", 1, 1, "PIN_ARGUMENT_REQUIRED");
  requireCount(cli, "--output-dir", 1, 1, "PIN_ARGUMENT_REQUIRED");
  const inputPath = absoluteNormalized(value(cli, "--input-manifest"), "pin input manifest");
  const outputDir = absoluteNormalized(value(cli, "--output-dir"), "pin output directory");
  const execute = has(cli, "--yes");
  const lockTimeoutMs = integerOption(value(cli, "--lock-timeout-ms"), DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS, 1, MAX_MAINTENANCE_LOCK_TIMEOUT_MS, "--lock-timeout-ms");
  const readBudget = new CommandReadBudget({
    maxEntries: integerOption(value(cli, "--read-max-entries"), DEFAULT_PIN_READ_ENTRIES, 1, HARD_COMMAND_READ_ENTRIES, "--read-max-entries"),
    maxBytes: integerOption(value(cli, "--read-max-bytes-total"), MAX_PIN_TOTAL_BYTES + MAX_PIN_INPUT_BYTES, 1, MAX_PIN_TOTAL_BYTES + MAX_PIN_INPUT_BYTES, "--read-max-bytes-total"),
    maxTimeMs: integerOption(value(cli, "--read-time-budget-ms-total"), PIN_TIME_BUDGET_MS, 1, HARD_TOTAL_TIME_BUDGET_MS, "--read-time-budget-ms-total"),
    entryCode: "PIN_ENTRY_LIMIT",
    bytesCode: "PIN_TOTAL_SIZE_EXCEEDED",
    timeCode: "PIN_TIME_BUDGET_EXCEEDED",
  });
  const { parsed, sha256 } = await readBoundedJsonRegular(inputPath, readBudget);
  const request = validatePinRequest(parsed);
  const requestedTotal = request.sources.reduce((sum, source) => sum + source.bytes, 0);
  if (!Number.isSafeInteger(requestedTotal) || requestedTotal > MAX_PIN_TOTAL_BYTES) {
    throw new MaintenanceError("PIN_TOTAL_SIZE_EXCEEDED", `pin sources exceed ${MAX_PIN_TOTAL_BYTES} total bytes`);
  }
  const sinkRoots = request.sources.map((source) => sinkRootFromPath(source.path)).filter(Boolean);
  const outputSink = sinkRootFromPath(outputDir);
  if (outputSink) sinkRoots.push(outputSink);
  emitTestReadyMarker("pin_maintenance_waiting", { roots: [...new Set(sinkRoots)].sort() });
  const locks = await acquireMaintenanceLocks(sinkRoots, lockTimeoutMs);
  let outputDirectory;
  try {
    emitTestReadyMarker("pin_maintenance_locked", { roots: [...new Set(sinkRoots)].sort() });
    const verifiedSources = [];
    let actualTotal = 0;
    for (const source of request.sources) {
      const verified = await verifyPinSource(source, readBudget);
      actualTotal += verified.bytes;
      if (actualTotal > MAX_PIN_TOTAL_BYTES) throw new MaintenanceError("PIN_TOTAL_SIZE_EXCEEDED", `pin source reads exceed ${MAX_PIN_TOTAL_BYTES} total bytes`);
      verifiedSources.push(verified);
    }
    outputDirectory = await prepareOutputDirectory(outputDir, execute);
    const pinBasename = `incident-pin-${isoCompact()}-${randomUUID()}.json`;
    const pinPath = path.join(outputDir, pinBasename);
    const manifest = {
      schema_version: PIN_OUTPUT_SCHEMA_VERSION,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      created_at: new Date().toISOString(),
      pinned: true,
      retention: RETENTION,
      verification_budget: {
        max_bytes_per_source: MAX_PIN_SOURCE_BYTES,
        max_bytes_session_log: MAX_PIN_SESSION_BYTES,
        max_bytes_total: MAX_PIN_TOTAL_BYTES,
        time_budget_ms: PIN_TIME_BUDGET_MS,
      },
      source_request: { sha256 },
      incident: request.incident,
      sources: verifiedSources,
      metrics: request.metrics,
      raw_content_copied: false,
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (bytes.length > MAX_PIN_OUTPUT_BYTES) throw new MaintenanceError("PIN_INPUT_INVALID", `validated pin output exceeds ${MAX_PIN_OUTPUT_BYTES} bytes`);
    if (execute) await writeExclusiveFile(outputDirectory, pinBasename, bytes);
    output({
      ok: true,
      command: "pin",
      dry_run: !execute,
      pin_path: execute ? pinPath : null,
      planned_pin_path: execute ? null : pinPath,
      source_count: request.sources.length,
      metric_count: request.metrics.length,
      output_bytes: bytes.length,
      read_budget: readBudget.report(),
    });
  } finally {
    await outputDirectory?.handle.close();
    await releaseLocks(locks);
  }
}

function rejectedSealEntry(archivePath, reason, details = {}) {
  return { path: archivePath, status: "rejected", reason, ...details };
}

async function inspectArchive(accessPath, logicalPath, stableMs, maxBytes, timeBudgetMs, execute, readBudget) {
  let firstLstat;
  try { firstLstat = await fsp.lstat(logicalPath); } catch (error) {
    return rejectedSealEntry(logicalPath, "lstat_failed", { error_code: error?.code ?? "UNKNOWN" });
  }
  if (firstLstat.isSymbolicLink()) return rejectedSealEntry(logicalPath, "archive_symlink_forbidden");
  if (!firstLstat.isFile()) return rejectedSealEntry(logicalPath, "archive_not_regular", { type: fileType(firstLstat) });
  const before = snapshot(firstLstat);
  const stableAgeMs = Date.now() - Math.max(firstLstat.mtimeMs, firstLstat.ctimeMs);
  if (stableAgeMs < stableMs) {
    return { path: logicalPath, status: "hot", reason: "stability_window_not_met", stable_age_ms: Math.max(0, Math.floor(stableAgeMs)), required_stable_ms: stableMs, identity: before };
  }
  if (firstLstat.size > maxBytes) return rejectedSealEntry(logicalPath, "max_bytes_exceeded", { identity: before, max_bytes: maxBytes });
  if (!execute) return { path: logicalPath, status: "snapshot_planned", reason: "eligible_stable_archive", identity: before };
  try {
    const read = await readRegularSnapshot({
      accessPath,
      logicalPath,
      maxBytes,
      perFileTimeMs: timeBudgetMs,
      budget: readBudget,
      sizeCode: "SEAL_MAX_BYTES_EXCEEDED",
      identityCode: "IDENTITY_CHANGED",
      chunkDelayMs: integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_CHUNK_DELAY_MS"), 0, 0, 100, "test chunk delay"),
      readyPhase: "seal_hash_started",
    });
    if (Date.now() - Math.max(read.snapshot.mtime_ms, read.snapshot.ctime_ms) < stableMs) {
      return { path: logicalPath, status: "hot", reason: "stability_window_changed_during_hash", required_stable_ms: stableMs, identity: read.snapshot };
    }
    return {
      path: logicalPath,
      status: "snapshot_verified",
      reason: "stable_identity_and_hash_verified",
      identity: read.snapshot,
      stable_window_ms: stableMs,
      verified_at: new Date().toISOString(),
      sha256: read.sha256,
      bytes: read.byteCount,
      lines: read.lines,
      boundary_precision: BOUNDARY_PRECISION,
    };
  } catch (error) {
    if (error instanceof MaintenanceError && error.code === "SEAL_MAX_BYTES_EXCEEDED") return rejectedSealEntry(logicalPath, "max_bytes_exceeded", { identity: before });
    if (error instanceof MaintenanceError && error.code === "SEAL_TIME_BUDGET_EXCEEDED") return rejectedSealEntry(logicalPath, "time_budget_exceeded", { identity: before });
    if (error instanceof MaintenanceError && error.code === "IDENTITY_CHANGED") return rejectedSealEntry(logicalPath, "identity_changed_during_hash", { identity: before });
    return rejectedSealEntry(logicalPath, "read_or_stat_failed", { error_code: error?.code ?? "UNKNOWN" });
  }
}

async function validateSealRoot(root, execute) {
  const canonicalRoot = await canonicalDirectory(root, "seal root");
  const archiveDir = path.join(canonicalRoot, "archive");
  if (!execute) {
    await canonicalDirectory(archiveDir, "seal archive directory");
    return { canonicalRoot, archiveDir, directory: null };
  }
  const directory = await openMaintenanceDirectory(archiveDir, "seal archive directory", false);
  return { canonicalRoot, archiveDir, directory };
}

function sealHmacRoot(canonicalRoot) {
  return path.basename(canonicalRoot) === "llm-audit" && path.basename(path.dirname(canonicalRoot)) === ".pi-astack"
    ? projectRootForSink(canonicalRoot)
    : canonicalRoot;
}

function signedSealManifest(canonicalRoot, unsigned) {
  const signature = signAuditMaintenanceHmacStrict(sealHmacRoot(canonicalRoot), SEAL_SIGNATURE_DOMAIN, canonicalJson(unsigned));
  return { ...unsigned, signature };
}

async function writeSealManifest(directory, archiveDir, manifest) {
  const basename = `archive-seal-manifest-${isoCompact()}-${randomUUID()}.json`;
  const manifestPath = path.join(archiveDir, basename);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.length > 4 * 1024 * 1024) throw new MaintenanceError("SEAL_MANIFEST_TOO_LARGE", "seal manifest exceeds 4 MiB");
  await writeExclusiveFile(directory, basename, bytes);
  await directory.handle.sync();
  return manifestPath;
}

async function seal(cli) {
  requireCount(cli, "--root", 1, Number.MAX_SAFE_INTEGER, "EXPLICIT_ROOT_REQUIRED");
  const roots = values(cli, "--root").map((item) => absoluteNormalized(item, "seal root"));
  const stableMs = integerOption(value(cli, "--stable-ms"), DEFAULT_STABLE_MS, 1, MAX_STABLE_MS, "--stable-ms");
  const maxBytes = integerOption(value(cli, "--max-bytes"), DEFAULT_SEAL_MAX_BYTES, 1, HARD_SEAL_MAX_BYTES, "--max-bytes");
  const totalMaxBytes = integerOption(value(cli, "--total-max-bytes"), DEFAULT_TOTAL_HASH_BYTES, 1, HARD_TOTAL_HASH_BYTES, "--total-max-bytes");
  const timeBudgetMs = integerOption(value(cli, "--time-budget-ms"), DEFAULT_SEAL_TIME_BUDGET_MS, 1, HARD_SEAL_TIME_BUDGET_MS, "--time-budget-ms");
  const totalTimeBudgetMs = integerOption(value(cli, "--total-time-budget-ms"), DEFAULT_TOTAL_TIME_BUDGET_MS, 1, HARD_TOTAL_TIME_BUDGET_MS, "--total-time-budget-ms");
  const lockTimeoutMs = integerOption(value(cli, "--lock-timeout-ms"), DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS, 1, MAX_MAINTENANCE_LOCK_TIMEOUT_MS, "--lock-timeout-ms");
  const readMaxEntries = integerOption(value(cli, "--read-max-entries"), MAX_ARCHIVE_DIRECTORY_ENTRIES, 1, MAX_ARCHIVE_DIRECTORY_ENTRIES, "--read-max-entries");
  const execute = has(cli, "--yes");
  const rootResults = [];
  let rejected = false;
  const preparedRoots = [];
  const locks = await acquireMaintenanceLocks(roots, lockTimeoutMs);
  const readBudget = new CommandReadBudget({
    maxEntries: readMaxEntries,
    maxBytes: totalMaxBytes,
    maxTimeMs: totalTimeBudgetMs,
    entryCode: "SEAL_ENTRY_LIMIT",
    bytesCode: "SEAL_MAX_BYTES_EXCEEDED",
    timeCode: "SEAL_TIME_BUDGET_EXCEEDED",
  });

  try {
    emitTestReadyMarker("seal_maintenance_locked", { roots: [...new Set(roots)].sort() });
    for (const root of roots) {
      let validated;
      try { validated = await validateSealRoot(root, execute); } catch (error) {
        if (!(error instanceof MaintenanceError) && ["EACCES", "EPERM", "EMFILE", "ENFILE"].includes(error?.code)) {
          throw new MaintenanceError("SEAL_READDIR_FAILED", `cannot open archive directory for enumeration: ${path.join(root, "archive")}`, { error_code: error.code });
        }
        throw error;
      }
      const { canonicalRoot, archiveDir, directory } = validated;
      let names;
      try { names = await fsp.readdir(directory?.procPath ?? archiveDir); } catch (error) {
        await directory?.handle.close();
        throw new MaintenanceError("SEAL_READDIR_FAILED", `cannot enumerate archive directory: ${archiveDir}`, { error_code: error?.code ?? "UNKNOWN" });
      }
      if (names.length > MAX_ARCHIVE_DIRECTORY_ENTRIES) {
        await directory?.handle.close();
        throw new MaintenanceError("SEAL_ENTRY_LIMIT", `archive directory exceeds ${MAX_ARCHIVE_DIRECTORY_ENTRIES} entries: ${archiveDir}`);
      }
      preparedRoots.push({ canonicalRoot, archiveDir, directory, names: names.sort() });
    }

    for (const { canonicalRoot, archiveDir, directory, names } of preparedRoots) {
      const entries = [];
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const logicalPath = path.join(archiveDir, name);
        const accessPath = directory ? path.join(directory.procPath, name) : logicalPath;
        const result = await inspectArchive(accessPath, logicalPath, stableMs, maxBytes, timeBudgetMs, execute, readBudget);
        if (result.status === "rejected") rejected = true;
        entries.push(result);
      }
      const unsigned = {
        schema_version: SEAL_SCHEMA_VERSION,
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        generated_at: new Date().toISOString(),
        canonical_root: canonicalRoot,
        archive_directory: archiveDir,
        stable_window: { required_ms: stableMs, basis: "max_mtime_ctime_before_and_after_hash" },
        budgets: {
          max_entries: readMaxEntries,
          max_bytes_per_file: maxBytes,
          max_bytes_total: totalMaxBytes,
          time_budget_ms_per_file: timeBudgetMs,
          time_budget_ms_total: totalTimeBudgetMs,
        },
        boundary_precision: BOUNDARY_PRECISION,
        entries,
      };
      const manifest = execute ? signedSealManifest(canonicalRoot, unsigned) : null;
      const manifestPath = execute ? await writeSealManifest(directory, archiveDir, manifest) : null;
      rootResults.push({ root: canonicalRoot, manifest_path: manifestPath, entries, signature: manifest?.signature ?? null });
    }

    output({
      ok: !rejected,
      command: "seal",
      dry_run: !execute,
      generated_at: new Date().toISOString(),
      root_rule: "one_or_more_unique_canonical_absolute_sink_directories; one_manifest_per_root",
      stable_ms: stableMs,
      max_bytes: maxBytes,
      total_max_bytes: totalMaxBytes,
      time_budget_ms: timeBudgetMs,
      total_time_budget_ms: totalTimeBudgetMs,
      roots: rootResults,
      read_budget: readBudget.report(),
    });
    if (rejected) process.exitCode = 1;
  } finally {
    await Promise.all(preparedRoots.map(({ directory }) => directory?.handle.close().catch(() => {})));
    await releaseLocks(locks);
  }
}

function pruneOptions(cli) {
  return {
    retentionDays: integerOption(value(cli, "--retention-days"), DEFAULT_PRUNE_RETENTION_DAYS, 1, MAX_PRUNE_RETENTION_DAYS, "--retention-days"),
    maxArchiveBytes: integerOption(value(cli, "--max-archive-bytes"), DEFAULT_PRUNE_MAX_ARCHIVE_BYTES, 1, MAX_PRUNE_ARCHIVE_BYTES, "--max-archive-bytes"),
    keepLatestGenerations: integerOption(value(cli, "--keep-latest-generations"), DEFAULT_PRUNE_KEEP_LATEST, 2, MAX_PRUNE_KEEP_LATEST, "--keep-latest-generations"),
    batchMaxBytes: integerOption(value(cli, "--batch-max-bytes"), DEFAULT_PRUNE_BATCH_BYTES, 1, MAX_PRUNE_ARCHIVE_BYTES, "--batch-max-bytes"),
    batchMaxFiles: integerOption(value(cli, "--batch-max-files"), DEFAULT_PRUNE_BATCH_FILES, 1, MAX_PRUNE_BATCH_FILES, "--batch-max-files"),
    hashMaxBytesPerFile: integerOption(value(cli, "--hash-max-bytes-per-file"), DEFAULT_SEAL_MAX_BYTES, 1, HARD_SEAL_MAX_BYTES, "--hash-max-bytes-per-file"),
    hashMaxBytesTotal: integerOption(value(cli, "--hash-max-bytes-total"), DEFAULT_TOTAL_HASH_BYTES, 1, HARD_TOTAL_HASH_BYTES, "--hash-max-bytes-total"),
    hashTimeBudgetMsPerFile: integerOption(value(cli, "--hash-time-budget-ms-per-file"), DEFAULT_SEAL_TIME_BUDGET_MS, 1, HARD_SEAL_TIME_BUDGET_MS, "--hash-time-budget-ms-per-file"),
    hashTimeBudgetMsTotal: integerOption(value(cli, "--hash-time-budget-ms-total"), DEFAULT_TOTAL_TIME_BUDGET_MS, 1, HARD_TOTAL_TIME_BUDGET_MS, "--hash-time-budget-ms-total"),
    readMaxEntries: integerOption(value(cli, "--read-max-entries"), DEFAULT_PRUNE_READ_ENTRIES, 1, HARD_COMMAND_READ_ENTRIES, "--read-max-entries"),
    lockTimeoutMs: integerOption(value(cli, "--lock-timeout-ms"), DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS, 1, MAX_MAINTENANCE_LOCK_TIMEOUT_MS, "--lock-timeout-ms"),
  };
}

async function existingUnsafeControlFile(root, basename) {
  const file = path.join(root, basename);
  try {
    const stat = await fsp.lstat(file);
    return { path: file, type: fileType(stat) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validatePruneRoot(rawRoot, advisoryNoLock = false) {
  const root = await canonicalDirectory(rawRoot, "prune root");
  if (path.basename(root) !== "llm-audit" || path.basename(path.dirname(root)) !== ".pi-astack") {
    throw new MaintenanceError("PRUNE_ROOT_REJECTED", "prune root must be the canonical <project>/.pi-astack/llm-audit sink directory");
  }
  const active = path.join(root, "audit.jsonl");
  await assertNoSymlinkChain(active, { label: "active audit file" });
  const activeOpened = await openRegularNoFollow(active);
  await activeOpened.handle.close();
  const transaction = await existingUnsafeControlFile(root, ".audit.jsonl.rotation-transaction.json");
  if (transaction && !advisoryNoLock) throw new MaintenanceError("PRUNE_HOT_SINK", `prune refuses a sink with an active rotation transaction: ${transaction.path}`, transaction);
  const rootDirectory = await openMaintenanceDirectory(root, "prune sink directory", false);
  let archiveDirectory;
  try {
    archiveDirectory = await openMaintenanceDirectory(path.join(root, "archive"), "prune archive directory", false);
    return { root, active, rootDirectory, archiveDirectory };
  } catch (error) {
    await rootDirectory.handle.close();
    throw error;
  }
}

async function readPruneJson(accessPath, logicalPath, maxBytes, budget, perFileTimeMs) {
  const read = await readRegularSnapshot({
    accessPath,
    logicalPath,
    maxBytes,
    perFileTimeMs,
    budget,
    collect: true,
    sizeCode: "PRUNE_SIZE_LIMIT",
    identityCode: "IDENTITY_CHANGED",
  });
  let parsed;
  try { parsed = JSON.parse(read.bytes.toString("utf8")); } catch (error) {
    throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `invalid JSON: ${logicalPath}`, { parse_category: error?.name ?? "Error" });
  }
  return { parsed, bytes: read.bytes, sha256: read.sha256, snapshot: read.snapshot };
}

async function hashPruneFile(accessPath, logicalPath, maxBytes, budget, perFileTimeMs) {
  const read = await readRegularSnapshot({
    accessPath,
    logicalPath,
    maxBytes,
    perFileTimeMs,
    budget,
    sizeCode: "PRUNE_SIZE_LIMIT",
    identityCode: "IDENTITY_CHANGED",
    chunkDelayMs: integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_PRUNE_CHUNK_DELAY_MS"), 0, 0, 100, "prune test chunk delay"),
    readyPhase: "prune_hash_started",
  });
  return { sha256: read.sha256, bytes: read.byteCount, snapshot: read.snapshot };
}

function closedObject(valueToCheck, required, optional, label) {
  if (!valueToCheck || typeof valueToCheck !== "object" || Array.isArray(valueToCheck)) {
    throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(valueToCheck)) if (!allowed.has(key)) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `${label} has unknown property: ${key}`);
  for (const key of required) if (!Object.hasOwn(valueToCheck, key)) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `${label} is missing required property: ${key}`);
}

function validateSealIdentity(valueToCheck, label) {
  closedObject(valueToCheck, ["dev", "ino", "size", "mtime", "mtime_ms", "ctime", "ctime_ms"], [], label);
  for (const key of ["dev", "ino", "size", "mtime_ms", "ctime_ms"]) {
    if (!Number.isFinite(valueToCheck[key]) || valueToCheck[key] < 0) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `${label}.${key} is invalid`);
  }
  isoTimestamp(valueToCheck.mtime, `${label}.mtime`);
  isoTimestamp(valueToCheck.ctime, `${label}.ctime`);
}

function validateSealManifest(parsed, rootInfo) {
  closedObject(parsed, ["schema_version", "tool", "generated_at", "canonical_root", "archive_directory", "stable_window", "budgets", "boundary_precision", "entries", "signature"], [], "seal_manifest");
  if (parsed.schema_version !== SEAL_SCHEMA_VERSION || parsed.canonical_root !== rootInfo.root || parsed.archive_directory !== path.join(rootInfo.root, "archive") || parsed.boundary_precision !== BOUNDARY_PRECISION) {
    throw new MaintenanceError("PRUNE_MANIFEST_INVALID", "seal manifest root, schema, or boundary is invalid");
  }
  isoTimestamp(parsed.generated_at, "seal_manifest.generated_at");
  closedObject(parsed.tool, ["name", "version"], [], "seal_manifest.tool");
  if (parsed.tool.name !== TOOL_NAME || typeof parsed.tool.version !== "string") throw new MaintenanceError("PRUNE_MANIFEST_INVALID", "seal manifest tool is invalid");
  closedObject(parsed.stable_window, ["required_ms", "basis"], [], "seal_manifest.stable_window");
  if (!Number.isSafeInteger(parsed.stable_window.required_ms) || parsed.stable_window.required_ms < 1 || parsed.stable_window.basis !== "max_mtime_ctime_before_and_after_hash") throw new MaintenanceError("PRUNE_MANIFEST_INVALID", "seal manifest stable window is invalid");
  closedObject(parsed.budgets, ["max_entries", "max_bytes_per_file", "max_bytes_total", "time_budget_ms_per_file", "time_budget_ms_total"], [], "seal_manifest.budgets");
  for (const key of ["max_entries", "max_bytes_per_file", "max_bytes_total", "time_budget_ms_per_file", "time_budget_ms_total"]) {
    if (!Number.isSafeInteger(parsed.budgets[key]) || parsed.budgets[key] < 1) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `seal_manifest.budgets.${key} is invalid`);
  }
  if (parsed.budgets.max_entries > MAX_ARCHIVE_DIRECTORY_ENTRIES || parsed.budgets.max_bytes_per_file > HARD_SEAL_MAX_BYTES || parsed.budgets.max_bytes_total > HARD_TOTAL_HASH_BYTES || parsed.budgets.time_budget_ms_per_file > HARD_SEAL_TIME_BUDGET_MS || parsed.budgets.time_budget_ms_total > HARD_TOTAL_TIME_BUDGET_MS) {
    throw new MaintenanceError("PRUNE_MANIFEST_INVALID", "seal manifest budgets exceed hard limits");
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_ARCHIVE_DIRECTORY_ENTRIES) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", "seal manifest entries are invalid");
  const generalEntryKeys = ["path", "status", "reason", "identity", "stable_window_ms", "verified_at", "sha256", "bytes", "lines", "boundary_precision", "error_code", "type", "stable_age_ms", "required_stable_ms", "max_bytes", "total_max_bytes", "before", "held_before", "held_after", "path_after", "after"];
  for (let index = 0; index < parsed.entries.length; index++) {
    const entry = parsed.entries[index];
    closedObject(entry, ["path", "status", "reason"], generalEntryKeys.filter((key) => !["path", "status", "reason"].includes(key)), `seal_manifest.entries[${index}]`);
    if (typeof entry.path !== "string" || entry.path.length > 4096 || !path.isAbsolute(entry.path)) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `seal entry path is invalid at ${index}`);
    if (!["snapshot_verified", "rejected", "hot"].includes(entry.status)) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `seal entry status is invalid at ${index}`);
    if (typeof entry.reason !== "string" || entry.reason.length > 128) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `seal entry reason is invalid at ${index}`);
    for (const key of ["identity", "before", "held_before", "held_after", "path_after", "after"]) {
      if (entry[key] !== undefined) validateSealIdentity(entry[key], `seal_manifest.entries[${index}].${key}`);
    }
    for (const key of ["stable_window_ms", "stable_age_ms", "required_stable_ms", "max_bytes", "total_max_bytes", "bytes", "lines"]) {
      if (entry[key] !== undefined && (!Number.isFinite(entry[key]) || entry[key] < 0)) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `seal entry ${key} is invalid at ${index}`);
    }
    for (const key of ["error_code", "type"]) {
      if (entry[key] !== undefined && (typeof entry[key] !== "string" || entry[key].length > 80)) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `seal entry ${key} is invalid at ${index}`);
    }
    if (entry.status === "snapshot_verified") {
      closedObject(entry, ["path", "status", "reason", "identity", "stable_window_ms", "verified_at", "sha256", "bytes", "lines", "boundary_precision"], [], `seal_manifest.entries[${index}]`);
      validateSealIdentity(entry.identity, `seal_manifest.entries[${index}].identity`);
      sha256(entry.sha256, `seal_manifest.entries[${index}].sha256`);
      isoTimestamp(entry.verified_at, `seal_manifest.entries[${index}].verified_at`);
      if (entry.boundary_precision !== BOUNDARY_PRECISION || entry.bytes !== entry.identity.size || !Number.isSafeInteger(entry.lines) || entry.lines < 0) throw new MaintenanceError("PRUNE_MANIFEST_INVALID", `verified seal entry is inconsistent at ${index}`);
    }
  }
  closedObject(parsed.signature, ["algorithm", "key_id", "digest"], [], "seal_manifest.signature");
  const { signature, ...unsigned } = parsed;
  if (!verifyAuditMaintenanceHmacStrict(projectRootForSink(rootInfo.root), SEAL_SIGNATURE_DOMAIN, canonicalJson(unsigned), signature)) {
    throw new MaintenanceError("PRUNE_MANIFEST_INVALID", "seal manifest signature verification failed");
  }
  return parsed;
}

function isPruneReadBudgetError(error) {
  return error instanceof MaintenanceError && ["PRUNE_ENTRY_LIMIT", "PRUNE_HASH_BUDGET_EXCEEDED", "PRUNE_HASH_TIME_BUDGET_EXCEEDED"].includes(error.code);
}

async function loadSealSnapshots(rootInfo, names, rejected, budget, options) {
  const byPath = new Map();
  for (const name of names) {
    if (!SEAL_MANIFEST_NAME.test(name)) continue;
    const logicalPath = path.join(rootInfo.root, "archive", name);
    const accessPath = path.join(rootInfo.archiveDirectory.procPath, name);
    try {
      const { parsed } = await readPruneJson(accessPath, logicalPath, 4 * 1024 * 1024, budget, options.hashTimeBudgetMsPerFile);
      const trusted = validateSealManifest(parsed, rootInfo);
      for (const entry of trusted.entries) {
        if (entry?.status !== "snapshot_verified" || typeof entry.path !== "string") continue;
        const prior = byPath.get(entry.path) ?? [];
        prior.push(entry);
        byPath.set(entry.path, prior);
      }
    } catch (error) {
      if (isPruneReadBudgetError(error)) throw error;
      rejected.push({ path: logicalPath, reason: "seal_manifest_rejected", code: error instanceof MaintenanceError ? error.code : "PRUNE_MANIFEST_INVALID" });
    }
  }
  return byPath;
}

async function collectPinnedArchivePaths(rootInfo, budget, options) {
  const pinned = new Set();
  let scanned = 0;
  async function walk(accessDir, logicalDir) {
    const entries = await fsp.readdir(accessDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      scanned += 1;
      if (scanned > MAX_PRUNE_SCAN_ENTRIES) throw new MaintenanceError("PRUNE_SCAN_LIMIT", `pin scan exceeds ${MAX_PRUNE_SCAN_ENTRIES} entries`);
      const logical = path.join(logicalDir, entry.name);
      const access = path.join(accessDir, entry.name);
      if (logical === path.join(rootInfo.root, "archive")) continue;
      const stat = await fsp.lstat(access);
      if (stat.isSymbolicLink()) {
        if (PIN_MANIFEST_NAME.test(entry.name)) throw new MaintenanceError("PRUNE_PIN_INVALID", `pin manifest symlink is forbidden: ${logical}`);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(access, logical);
        continue;
      }
      if (!PIN_MANIFEST_NAME.test(entry.name)) continue;
      const { parsed } = await readPruneJson(access, logical, MAX_PIN_OUTPUT_BYTES, budget, options.hashTimeBudgetMsPerFile);
      if (parsed?.schema_version !== PIN_OUTPUT_SCHEMA_VERSION || parsed.pinned !== true || !Array.isArray(parsed.sources)) {
        throw new MaintenanceError("PRUNE_PIN_INVALID", `invalid pin manifest: ${logical}`);
      }
      for (const source of parsed.sources) {
        if (source?.kind === "llm_audit_archive" && typeof source.path === "string") pinned.add(source.path);
      }
    }
  }
  await walk(rootInfo.rootDirectory.procPath, rootInfo.root);
  await verifyHeldDirectory(rootInfo.rootDirectory);
  return pinned;
}

function validGenerationSidecar(parsed, root, active) {
  return parsed?.schemaVersion === 1 && parsed.sink === "llm-audit" &&
    typeof parsed.generationId === "string" && /^[0-9a-f-]{36}$/i.test(parsed.generationId) &&
    typeof parsed.createdAt === "string" && Number.isFinite(Date.parse(parsed.createdAt)) &&
    parsed.activePath === active &&
    (parsed.boundaryPrecision === BOUNDARY_PRECISION || parsed.boundaryPrecision === undefined) &&
    path.dirname(active) === root;
}

function sealMatchesCurrent(entry, archive) {
  return entry?.identity?.dev === archive.snapshot.dev && entry?.identity?.ino === archive.snapshot.ino &&
    entry?.identity?.size === archive.snapshot.size && entry?.identity?.mtime_ms === archive.snapshot.mtime_ms &&
    entry?.identity?.ctime_ms === archive.snapshot.ctime_ms && entry?.identity?.mtime === archive.snapshot.mtime &&
    entry?.identity?.ctime === archive.snapshot.ctime && entry?.bytes === archive.bytes && entry?.sha256 === archive.sha256;
}

async function inspectPruneArchive(rootInfo, name, seals, budget, options) {
  const archivePath = path.join(rootInfo.root, "archive", name);
  const archiveAccess = path.join(rootInfo.archiveDirectory.procPath, name);
  if (!GENERATED_ARCHIVE.test(name)) return { rejected: { path: archivePath, reason: "not_current_helper_archive" } };
  let apparentBytes = 0;
  try {
    const apparent = await fsp.lstat(archiveAccess);
    if (!apparent.isSymbolicLink() && apparent.isFile()) apparentBytes = apparent.size;
  } catch {}
  if (name.endsWith("__legacy-pre-shape.jsonl")) return { rejected: { path: archivePath, reason: "legacy_archive_excluded", accounted_unprunable: true, bytes: apparentBytes }, archiveBytes: apparentBytes };
  if (apparentBytes > options.hashMaxBytesPerFile) {
    return { rejected: { path: archivePath, reason: "hash_max_bytes_per_file_exceeded", accounted_unprunable: true, bytes: apparentBytes }, archiveBytes: apparentBytes };
  }
  try {
    const archive = await hashPruneFile(archiveAccess, archivePath, options.hashMaxBytesPerFile, budget, options.hashTimeBudgetMsPerFile);
    const sidecarName = `${name}.generation.json`;
    const sidecarPath = path.join(rootInfo.root, "archive", sidecarName);
    const sidecarAccess = path.join(rootInfo.archiveDirectory.procPath, sidecarName);
    const sidecar = await readPruneJson(sidecarAccess, sidecarPath, 64 * 1024, budget, options.hashTimeBudgetMsPerFile);
    if (!validGenerationSidecar(sidecar.parsed, rootInfo.root, rootInfo.active)) {
      return { rejected: { path: archivePath, reason: "generation_sidecar_invalid" }, archiveBytes: archive.bytes };
    }
    const createdMs = Date.parse(sidecar.parsed.createdAt);
    const sealed = (seals.get(archivePath) ?? []).some((entry) => sealMatchesCurrent(entry, archive));
    return {
      record: {
        path: archivePath,
        basename: name,
        sidecar_path: sidecarPath,
        sidecar_basename: sidecarName,
        created_at: new Date(createdMs).toISOString(),
        created_ms: createdMs,
        bytes: archive.bytes,
        sidecar_bytes: sidecar.bytes.length,
        sha256: archive.sha256,
        identity: archive.snapshot,
        sidecar_sha256: sidecar.sha256,
        sidecar_identity: sidecar.snapshot,
        sealed,
      },
      archiveBytes: archive.bytes,
    };
  } catch (error) {
    if (isPruneReadBudgetError(error)) throw error;
    return {
      rejected: { path: archivePath, reason: "archive_or_sidecar_rejected", code: error instanceof MaintenanceError ? error.code : "PRUNE_PATH_REJECTED", accounted_unprunable: apparentBytes > 0, bytes: apparentBytes },
      archiveBytes: apparentBytes,
    };
  }
}

function publicPruneRecord(record, reason, extra = {}) {
  return {
    path: record.path,
    sidecar_path: record.sidecar_path,
    created_at: record.created_at,
    bytes: record.bytes,
    sidecar_bytes: record.sidecar_bytes,
    reason,
    ...extra,
  };
}

async function buildPrunePlan(root, options, nowMs, budget, advisoryNoLock = false) {
  const rootInfo = await validatePruneRoot(root, advisoryNoLock);
  const rejected = [];
  try {
    const names = (await fsp.readdir(rootInfo.archiveDirectory.procPath)).sort();
    if (names.length > MAX_ARCHIVE_DIRECTORY_ENTRIES) throw new MaintenanceError("PRUNE_ENTRY_LIMIT", `archive directory exceeds ${MAX_ARCHIVE_DIRECTORY_ENTRIES} entries`);
    const seals = await loadSealSnapshots(rootInfo, names, rejected, budget, options);
    const pinnedPaths = await collectPinnedArchivePaths(rootInfo, budget, options);
    const records = [];
    let archiveBytes = 0;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const inspected = await inspectPruneArchive(rootInfo, name, seals, budget, options);
      archiveBytes += inspected.archiveBytes ?? 0;
      if (inspected.record) records.push(inspected.record);
      else if (inspected.rejected) rejected.push(inspected.rejected);
    }
    records.sort((left, right) => left.created_ms - right.created_ms || left.path.localeCompare(right.path));
    const latest = new Set(records.slice(-options.keepLatestGenerations).map((record) => record.path));
    const planned = [];
    const pinned = [];
    const kept = [];
    const candidates = [];
    for (const record of records) {
      if (pinnedPaths.has(record.path)) pinned.push(publicPruneRecord(record, "incident_pin_reference"));
      else if (latest.has(record.path)) kept.push(publicPruneRecord(record, "keep_latest_generation"));
      else if (!record.sealed) rejected.push(publicPruneRecord(record, "snapshot_verified_seal_required"));
      else candidates.push(record);
    }

    let remainingArchiveBytes = archiveBytes;
    let reclaimBytes = 0;
    for (const record of candidates) {
      const ageMs = nowMs - record.created_ms;
      const ageEligible = ageMs > options.retentionDays * 24 * 60 * 60 * 1000;
      const capacityEligible = remainingArchiveBytes > options.maxArchiveBytes;
      if (!ageEligible && !capacityEligible) {
        kept.push(publicPruneRecord(record, "within_retention_and_capacity"));
        continue;
      }
      const pairBytes = record.bytes + record.sidecar_bytes;
      if (planned.length >= options.batchMaxFiles || reclaimBytes + pairBytes > options.batchMaxBytes) {
        kept.push(publicPruneRecord(record, "batch_limit", { eligible_reasons: [ageEligible ? "age" : null, capacityEligible ? "capacity" : null].filter(Boolean) }));
        continue;
      }
      const reasons = [ageEligible ? "age" : null, capacityEligible ? "capacity" : null].filter(Boolean);
      planned.push({ ...record, reasons });
      reclaimBytes += pairBytes;
      remainingArchiveBytes -= record.bytes;
    }
    await verifyHeldDirectory(rootInfo.rootDirectory);
    await verifyHeldDirectory(rootInfo.archiveDirectory);
    return {
      rootInfo,
      root_identity: rootInfo.rootDirectory.identity,
      archive_identity: rootInfo.archiveDirectory.identity,
      archive_bytes: archiveBytes,
      remaining_archive_bytes: remainingArchiveBytes,
      reclaim_bytes: reclaimBytes,
      planned,
      rejected,
      pinned,
      kept,
    };
  } catch (error) {
    await rootInfo.archiveDirectory.handle.close().catch(() => {});
    await rootInfo.rootDirectory.handle.close().catch(() => {});
    throw error;
  }
}

async function closePrunePlan(plan) {
  await plan.rootInfo.archiveDirectory.handle.close().catch(() => {});
  await plan.rootInfo.rootDirectory.handle.close().catch(() => {});
}

function samePrunePlan(initial, current) {
  if (!sameIdentity(initial.root_identity, current.root_identity) || !sameIdentity(initial.archive_identity, current.archive_identity)) return false;
  if (initial.planned.length !== current.planned.length) return false;
  return initial.planned.every((left, index) => {
    const right = current.planned[index];
    return right && left.path === right.path && left.sha256 === right.sha256 && left.sidecar_sha256 === right.sidecar_sha256 &&
      sameSnapshot(left.identity, right.identity) && sameSnapshot(left.sidecar_identity, right.sidecar_identity);
  });
}

async function openPruneManifestDirectory(rootInfo, create = true) {
  const basename = "maintenance-manifests";
  const logicalPath = path.join(rootInfo.root, basename);
  const accessPath = path.join(rootInfo.rootDirectory.procPath, basename);
  await verifyHeldDirectory(rootInfo.rootDirectory);
  let created = false;
  try {
    await fsp.lstat(accessPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!create) return null;
    try {
      await fsp.mkdir(accessPath, { mode: 0o700 });
      created = true;
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
  }
  if (created) {
    await rootInfo.rootDirectory.handle.sync();
    emitTestFsyncPhase("manifest_parent_after_mkdir", { path: rootInfo.root });
  }
  let before;
  try { before = await fsp.lstat(accessPath); } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    throw error;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (before.isSymbolicLink() || !before.isDirectory() || (uid !== undefined && before.uid !== uid) || (before.mode & 0o777) !== 0o700) {
    throw new MaintenanceError("PRUNE_PATH_REJECTED", `unsafe maintenance manifest directory: ${logicalPath}`);
  }
  const handle = await fsp.open(accessPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || !sameIdentity(identity(before), identity(held))) throw new MaintenanceError("IDENTITY_CHANGED", `maintenance manifest directory changed while opening: ${logicalPath}`);
    const logical = await fsp.lstat(logicalPath);
    if (logical.isSymbolicLink() || !logical.isDirectory() || !sameIdentity(identity(held), identity(logical))) throw new MaintenanceError("IDENTITY_CHANGED", `maintenance manifest logical path changed: ${logicalPath}`);
    const directory = { path: logicalPath, handle, identity: identity(held), procPath: `/proc/self/fd/${handle.fd}` };
    if (created) {
      await handle.sync();
      emitTestFsyncPhase("manifest_directory_after_open", { path: logicalPath });
    }
    await verifyHeldDirectory(directory);
    return directory;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function deriveQuarantineBasename(journalId, basename, kind) {
  const pairKind = kind === "archive" ? "archive" : kind === "generation_sidecar" ? "generation-sidecar" : null;
  if (!pairKind) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", `unsupported quarantine pair kind: ${kind}`);
  const basenameDigest = createHash("sha256").update(basename, "utf8").digest("hex").slice(0, 24);
  return `.audit-prune-quarantine-${journalId}-${pairKind}-${basenameDigest}`;
}

function journalTarget(record, kind, journalId) {
  const archive = kind === "archive";
  const basename = archive ? record.basename : record.sidecar_basename;
  return {
    kind,
    logical_path: archive ? record.path : record.sidecar_path,
    basename,
    quarantine_basename: deriveQuarantineBasename(journalId, basename, kind),
    identity: archive ? record.identity : record.sidecar_identity,
    sha256: archive ? record.sha256 : record.sidecar_sha256,
    bytes: archive ? record.bytes : record.sidecar_bytes,
  };
}

function newDeletionJournal(root, record) {
  const journalId = randomUUID();
  const now = new Date().toISOString();
  return {
    schema_version: PRUNE_DELETION_SCHEMA_VERSION,
    journal_id: journalId,
    state: "prepared",
    created_at: now,
    updated_at: now,
    canonical_root: root,
    archive_directory: path.join(root, "archive"),
    reason: record.reasons.join("+"),
    archive: journalTarget(record, "archive", journalId),
    sidecar: journalTarget(record, "generation_sidecar", journalId),
    archive_deleted: false,
    sidecar_deleted: false,
    raw_content_copied: false,
  };
}

function validateJournalTarget(target, kind, root, journalId, label) {
  closedObject(target, ["kind", "logical_path", "basename", "quarantine_basename", "identity", "sha256", "bytes"], [], label);
  if (target.kind !== kind || path.basename(target.basename) !== target.basename || path.basename(target.quarantine_basename) !== target.quarantine_basename) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", `${label} names are invalid`);
  if (target.quarantine_basename !== deriveQuarantineBasename(journalId, target.basename, kind)) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", `${label} quarantine basename is not canonically derived`);
  if (target.logical_path !== path.join(root, "archive", target.basename)) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", `${label} logical path is invalid`);
  validateSealIdentity(target.identity, `${label}.identity`);
  sha256(target.sha256, `${label}.sha256`);
  if (target.bytes !== target.identity.size) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", `${label} byte count is inconsistent`);
}

function validateDeletionJournal(journal, root, basename) {
  closedObject(journal, ["schema_version", "journal_id", "state", "created_at", "updated_at", "canonical_root", "archive_directory", "reason", "archive", "sidecar", "archive_deleted", "sidecar_deleted", "raw_content_copied", "signature"], ["blocked_reason"], "deletion_journal");
  uuid(journal.journal_id, "deletion_journal.journal_id");
  if (basename !== `audit-prune-journal-${journal.journal_id}.json`) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "journal filename UUID does not match journal_id");
  closedObject(journal.signature, ["algorithm", "key_id", "digest"], [], "deletion_journal.signature");
  const { signature, ...unsigned } = journal;
  if (!verifyAuditMaintenanceHmacStrict(projectRootForSink(root), PRUNE_JOURNAL_SIGNATURE_DOMAIN, canonicalJson(unsigned), signature)) {
    throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal signature verification failed");
  }
  if (journal.schema_version !== PRUNE_DELETION_SCHEMA_VERSION || journal.canonical_root !== root || journal.archive_directory !== path.join(root, "archive") || !["prepared", "archive_quarantined", "pair_quarantined", "deleted", "blocked"].includes(journal.state)) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal schema/root/state is invalid");
  isoTimestamp(journal.created_at, "deletion_journal.created_at");
  isoTimestamp(journal.updated_at, "deletion_journal.updated_at");
  if (typeof journal.reason !== "string" || journal.reason.length > 64 || typeof journal.archive_deleted !== "boolean" || typeof journal.sidecar_deleted !== "boolean" || journal.raw_content_copied !== false) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal fields are invalid");
  if (journal.blocked_reason !== undefined && (typeof journal.blocked_reason !== "string" || journal.blocked_reason.length > 256)) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal blocked reason is invalid");
  if (!GENERATED_ARCHIVE.test(journal.archive.basename) || journal.archive.basename.endsWith("__legacy-pre-shape.jsonl")) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal archive basename is not a current nonlegacy helper archive");
  if (journal.sidecar.basename !== `${journal.archive.basename}.generation.json`) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal sidecar is not the exact archive sidecar");
  validateJournalTarget(journal.archive, "archive", root, journal.journal_id, "deletion_journal.archive");
  validateJournalTarget(journal.sidecar, "generation_sidecar", root, journal.journal_id, "deletion_journal.sidecar");
  if (sameIdentity(journal.archive.identity, journal.sidecar.identity)) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal pair identities must differ");
  return journal;
}

function signDeletionJournal(journal) {
  const { signature: _discarded, ...unsigned } = journal;
  const signature = signAuditMaintenanceHmacStrict(projectRootForSink(unsigned.canonical_root), PRUNE_JOURNAL_SIGNATURE_DOMAIN, canonicalJson(unsigned));
  return { ...unsigned, signature };
}

async function writeJournal(directory, basename, journal, exclusive) {
  const signed = signDeletionJournal(journal);
  validateDeletionJournal(signed, signed.canonical_root, basename);
  const bytes = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`, "utf8");
  if (bytes.length > 64 * 1024) throw new MaintenanceError("PRUNE_JOURNAL_INVALID", "deletion journal exceeds 64 KiB");
  if (exclusive) {
    await writeExclusiveFile(directory, basename, bytes);
    emitTestFsyncPhase("journal_file", { basename, exclusive: true });
    await directory.handle.sync();
    emitTestFsyncPhase("journal_parent", { basename, exclusive: true });
    return signed;
  }
  const tmp = `.${basename}.${process.pid}.${randomUUID()}.tmp`;
  await writeExclusiveFile(directory, tmp, bytes);
  emitTestFsyncPhase("journal_replacement_file", { basename });
  await fsp.rename(path.join(directory.procPath, tmp), path.join(directory.procPath, basename));
  emitTestFsyncPhase("journal_replace", { basename });
  await directory.handle.sync();
  emitTestFsyncPhase("journal_parent", { basename, exclusive: false });
  return signed;
}

async function updateJournal(directory, basename, journal, state, extra = {}) {
  const next = await writeJournal(directory, basename, { ...journal, ...extra, state, updated_at: new Date().toISOString() }, false);
  emitTestReadyMarker(`prune_journal_${state}`, { journal_id: next.journal_id });
  if (testHook("PI_ASTACK_MAINTENANCE_TEST_HARD_CRASH_PHASE") === state) process.kill(process.pid, "SIGKILL");
  const crashPhase = testHook("PI_ASTACK_MAINTENANCE_TEST_CRASH_PHASE");
  if (crashPhase === state) throw new MaintenanceError("TEST_CRASH_INJECTED", `injected prune crash after ${state}`);
  return next;
}

async function pathState(access) {
  try { return await fsp.lstat(access); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function verifyJournalTarget(accessPath, logicalPath, target, budget, options) {
  if (target.bytes > options.hashMaxBytesPerFile) throw new MaintenanceError("PRUNE_HASH_BUDGET_EXCEEDED", `journal target exceeds per-file hash budget: ${logicalPath}`);
  const read = await hashPruneFile(accessPath, logicalPath, options.hashMaxBytesPerFile, budget, options.hashTimeBudgetMsPerFile);
  if (!sameIdentity(read.snapshot, target.identity) || read.snapshot.size !== target.identity.size || read.snapshot.mtime_ms !== target.identity.mtime_ms || read.bytes !== target.bytes || read.sha256 !== target.sha256) {
    throw new MaintenanceError("PRUNE_QUARANTINE_MISMATCH", `journal target identity/hash mismatch: ${logicalPath}`);
  }
}

function crashAtDurableMicroPhase(phase, journalId) {
  emitTestReadyMarker(`prune_${phase}`, { journal_id: journalId });
  if (testHook("PI_ASTACK_MAINTENANCE_TEST_HARD_CRASH_PHASE") === phase) process.kill(process.pid, "SIGKILL");
  if (testHook("PI_ASTACK_MAINTENANCE_TEST_CRASH_PHASE") === phase) throw new MaintenanceError("TEST_CRASH_INJECTED", `injected prune crash after ${phase}`);
}

async function durableRename(directory, source, quarantine, target, phase, journalId) {
  if (await pathState(quarantine)) throw new MaintenanceError("PRUNE_QUARANTINE_MISMATCH", `rename destination already exists: ${target.quarantine_basename}`);
  const handle = await fsp.open(source, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isFile() || !sameSnapshot(snapshot(held), target.identity)) throw new MaintenanceError("PRUNE_QUARANTINE_MISMATCH", `rename source identity mismatch: ${target.basename}`);
    await handle.sync();
    emitTestFsyncPhase(`${phase}_file`, { journal_id: journalId });
  } finally {
    await handle.close();
  }
  await fsp.rename(source, quarantine);
  emitTestFsyncPhase(`${phase}_rename`, { journal_id: journalId });
  await directory.handle.sync();
  emitTestFsyncPhase(`${phase}_parent`, { journal_id: journalId });
  crashAtDurableMicroPhase(`${phase}_durable`, journalId);
}

async function durableUnlink(directory, quarantine, target, phase, journalId) {
  const handle = await fsp.open(quarantine, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isFile() || !sameIdentity(identity(held), target.identity) || held.size !== target.bytes || held.mtimeMs !== target.identity.mtime_ms) throw new MaintenanceError("PRUNE_QUARANTINE_MISMATCH", `unlink target identity mismatch: ${target.quarantine_basename}`);
    await handle.sync();
    emitTestFsyncPhase(`${phase}_file`, { journal_id: journalId });
  } finally {
    await handle.close();
  }
  const current = await fsp.lstat(quarantine);
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(identity(current), target.identity) || current.size !== target.bytes || current.mtimeMs !== target.identity.mtime_ms) throw new MaintenanceError("PRUNE_QUARANTINE_MISMATCH", `unlink target changed: ${target.quarantine_basename}`);
  await fsp.unlink(quarantine);
  emitTestFsyncPhase(`${phase}_unlink`, { journal_id: journalId });
  await directory.handle.sync();
  emitTestFsyncPhase(`${phase}_parent`, { journal_id: journalId });
  crashAtDurableMicroPhase(`${phase}_durable`, journalId);
}

async function blockJournal(directory, basename, journal, message) {
  const blocked = await updateJournal(directory, basename, journal, "blocked", { blocked_reason: String(message).slice(0, 256) });
  throw new MaintenanceError("PRUNE_RECOVERY_BLOCKED", `deletion journal blocked: ${basename}`, { journal_id: blocked.journal_id, blocked_reason: blocked.blocked_reason });
}

async function processDeletionJournal(rootInfo, directory, basename, inputJournal, budget, options) {
  let journal = validateDeletionJournal(inputJournal, rootInfo.root, basename);
  if (journal.state === "blocked") throw new MaintenanceError("PRUNE_RECOVERY_BLOCKED", `blocked deletion journal requires operator review: ${basename}`, { journal_id: journal.journal_id, blocked_reason: journal.blocked_reason });
  const archiveSource = path.join(rootInfo.archiveDirectory.procPath, journal.archive.basename);
  const archiveSourceLogical = journal.archive.logical_path;
  const archiveQuarantine = path.join(rootInfo.archiveDirectory.procPath, journal.archive.quarantine_basename);
  const archiveQuarantineLogical = path.join(rootInfo.root, "archive", journal.archive.quarantine_basename);
  const sidecarSource = path.join(rootInfo.archiveDirectory.procPath, journal.sidecar.basename);
  const sidecarSourceLogical = journal.sidecar.logical_path;
  const sidecarQuarantine = path.join(rootInfo.archiveDirectory.procPath, journal.sidecar.quarantine_basename);
  const sidecarQuarantineLogical = path.join(rootInfo.root, "archive", journal.sidecar.quarantine_basename);
  try {
    if (journal.state === "deleted") {
      if (!journal.archive_deleted || !journal.sidecar_deleted || await pathState(archiveSource) || await pathState(sidecarSource) || await pathState(archiveQuarantine) || await pathState(sidecarQuarantine)) {
        return blockJournal(directory, basename, journal, "terminal journal is inconsistent with exact source/quarantine state");
      }
      return journal;
    }
    if (journal.state === "prepared") {
      const source = await pathState(archiveSource);
      const quarantined = await pathState(archiveQuarantine);
      if (source && quarantined) return blockJournal(directory, basename, journal, "prepared archive source/quarantine collision");
      if (!source && !quarantined) return blockJournal(directory, basename, journal, "prepared archive source and quarantine are both missing");
      if (source) {
        await verifyJournalTarget(archiveSource, archiveSourceLogical, journal.archive, budget, options);
        await durableRename(rootInfo.archiveDirectory, archiveSource, archiveQuarantine, journal.archive, "archive_rename", journal.journal_id);
      }
      await verifyJournalTarget(archiveQuarantine, archiveQuarantineLogical, journal.archive, budget, options);
      journal = await updateJournal(directory, basename, journal, "archive_quarantined");
    }
    if (journal.state === "archive_quarantined") {
      if (await pathState(archiveSource) || !await pathState(archiveQuarantine)) return blockJournal(directory, basename, journal, "archive_quarantined exact archive state is inconsistent");
      await verifyJournalTarget(archiveQuarantine, archiveQuarantineLogical, journal.archive, budget, options);
      const source = await pathState(sidecarSource);
      const quarantined = await pathState(sidecarQuarantine);
      if (source && quarantined) return blockJournal(directory, basename, journal, "sidecar source/quarantine collision");
      if (!source && !quarantined) return blockJournal(directory, basename, journal, "sidecar source and quarantine are both missing");
      if (source) {
        await verifyJournalTarget(sidecarSource, sidecarSourceLogical, journal.sidecar, budget, options);
        await durableRename(rootInfo.archiveDirectory, sidecarSource, sidecarQuarantine, journal.sidecar, "sidecar_rename", journal.journal_id);
      }
      await verifyJournalTarget(sidecarQuarantine, sidecarQuarantineLogical, journal.sidecar, budget, options);
      journal = await updateJournal(directory, basename, journal, "pair_quarantined");
    }
    if (journal.state === "pair_quarantined") {
      if (await pathState(archiveSource) || await pathState(sidecarSource)) return blockJournal(directory, basename, journal, "pair_quarantined original source path is occupied");
      let archivePresent = !!await pathState(archiveQuarantine);
      let sidecarPresent = !!await pathState(sidecarQuarantine);
      if (journal.archive_deleted && archivePresent) return blockJournal(directory, basename, journal, "archive quarantine exists after archive_deleted progress");
      if (journal.sidecar_deleted && sidecarPresent) return blockJournal(directory, basename, journal, "sidecar quarantine exists after sidecar_deleted progress");
      if (sidecarPresent) await verifyJournalTarget(sidecarQuarantine, sidecarQuarantineLogical, journal.sidecar, budget, options);
      if (!journal.archive_deleted) {
        if (archivePresent) {
          await verifyJournalTarget(archiveQuarantine, archiveQuarantineLogical, journal.archive, budget, options);
          await durableUnlink(rootInfo.archiveDirectory, archiveQuarantine, journal.archive, "archive_unlink", journal.journal_id);
          archivePresent = false;
        } else if (!sidecarPresent && !journal.sidecar_deleted) {
          return blockJournal(directory, basename, journal, "missing archive quarantine is not a safe durable-unlink microstate");
        }
        journal = await updateJournal(directory, basename, journal, "pair_quarantined", { archive_deleted: true });
      }
      if (!journal.sidecar_deleted) {
        if (sidecarPresent) {
          await durableUnlink(rootInfo.archiveDirectory, sidecarQuarantine, journal.sidecar, "sidecar_unlink", journal.journal_id);
          sidecarPresent = false;
        } else if (!journal.archive_deleted) {
          return blockJournal(directory, basename, journal, "missing sidecar quarantine is not a safe durable-unlink microstate");
        }
        journal = await updateJournal(directory, basename, journal, "pair_quarantined", { sidecar_deleted: true });
      }
      journal = await updateJournal(directory, basename, journal, "deleted");
    }
    return journal;
  } catch (error) {
    if (isPruneReadBudgetError(error) || (error instanceof MaintenanceError && ["TEST_CRASH_INJECTED", "PRUNE_RECOVERY_BLOCKED"].includes(error.code))) throw error;
    return blockJournal(directory, basename, journal, error?.message ?? String(error));
  }
}

async function readJournalFile(directory, basename, root, budget, options) {
  const logical = path.join(root, "maintenance-manifests", basename);
  const { parsed } = await readPruneJson(path.join(directory.procPath, basename), logical, 64 * 1024, budget, options.hashTimeBudgetMsPerFile);
  return validateDeletionJournal(parsed, root, basename);
}

function publicRecoveryJournal(basename, journal) {
  return { path: path.join(journal.canonical_root, "maintenance-manifests", basename), journal_id: journal.journal_id, state: journal.state };
}

async function recoverDeletionJournals(rootInfo, budget, options, execute) {
  const directory = await openPruneManifestDirectory(rootInfo, false);
  if (!directory) return { recovery_required: [], recovery_rejected: [], recovered: [] };
  try {
    const allNames = (await fsp.readdir(directory.procPath)).sort();
    if (allNames.length > MAX_PRUNE_SCAN_ENTRIES) throw new MaintenanceError("PRUNE_SCAN_LIMIT", `maintenance manifest scan exceeds ${MAX_PRUNE_SCAN_ENTRIES} entries`);
    const names = allNames.filter((name) => name.startsWith("audit-prune-journal-") && name.endsWith(".json"));
    const verified = [];
    const rejected = [];
    for (const basename of names) {
      if (!/^audit-prune-journal-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(basename)) {
        rejected.push({ path: path.join(rootInfo.root, "maintenance-manifests", basename), reason: "journal_filename_invalid", code: "PRUNE_JOURNAL_INVALID" });
        continue;
      }
      try {
        const journal = await readJournalFile(directory, basename, rootInfo.root, budget, options);
        if (journal.state === "blocked") rejected.push({ ...publicRecoveryJournal(basename, journal), reason: "journal_blocked", code: "PRUNE_RECOVERY_BLOCKED" });
        else verified.push({ basename, journal });
      } catch (error) {
        if (isPruneReadBudgetError(error)) throw error;
        rejected.push({ path: path.join(rootInfo.root, "maintenance-manifests", basename), reason: "journal_rejected", code: error instanceof MaintenanceError ? error.code : "PRUNE_JOURNAL_INVALID" });
      }
    }
    const ownership = new Map();
    for (const item of verified.filter(({ journal }) => journal.state !== "deleted")) {
      for (const key of [`source:${item.journal.archive.basename}`, `source:${item.journal.sidecar.basename}`, `quarantine:${item.journal.archive.quarantine_basename}`, `quarantine:${item.journal.sidecar.quarantine_basename}`]) {
        const prior = ownership.get(key);
        if (prior) {
          for (const collision of [prior, item]) {
            if (!rejected.some((entry) => entry.path === path.join(rootInfo.root, "maintenance-manifests", collision.basename))) {
              rejected.push({ ...publicRecoveryJournal(collision.basename, collision.journal), reason: "cross_journal_pair_collision", code: "PRUNE_RECOVERY_COLLISION" });
            }
          }
        } else ownership.set(key, item);
      }
    }
    const rejectedPaths = new Set(rejected.map((entry) => entry.path));
    const actionable = verified.filter((item) => !rejectedPaths.has(path.join(rootInfo.root, "maintenance-manifests", item.basename)));
    const recoveryRequired = actionable.filter(({ journal }) => journal.state !== "deleted").map(({ basename, journal }) => publicRecoveryJournal(basename, journal));
    if (!execute) return { recovery_required: recoveryRequired, recovery_rejected: rejected, recovered: [] };
    if (rejected.length > 0) throw new MaintenanceError("PRUNE_RECOVERY_REJECTED", "one or more deletion journals failed strict recovery validation", { recovery_rejected: rejected });
    const recovered = [];
    for (const { basename, journal } of actionable) {
      const terminal = await processDeletionJournal(rootInfo, directory, basename, journal, budget, options);
      if (journal.state !== "deleted") recovered.push(publicRecoveryJournal(basename, terminal));
    }
    return { recovery_required: recoveryRequired, recovery_rejected: [], recovered };
  } finally {
    await directory.handle.close();
  }
}

async function createAndProcessJournal(plan, directory, record, budget, options) {
  const unsigned = newDeletionJournal(plan.rootInfo.root, record);
  const basename = `audit-prune-journal-${unsigned.journal_id}.json`;
  const journal = await writeJournal(directory, basename, unsigned, true);
  emitTestReadyMarker("prune_journal_prepared", { journal_id: journal.journal_id });
  if (testHook("PI_ASTACK_MAINTENANCE_TEST_HARD_CRASH_PHASE") === "prepared") process.kill(process.pid, "SIGKILL");
  if (testHook("PI_ASTACK_MAINTENANCE_TEST_CRASH_PHASE") === "prepared") throw new MaintenanceError("TEST_CRASH_INJECTED", "injected prune crash after prepared");
  const terminal = await processDeletionJournal(plan.rootInfo, directory, basename, journal, budget, options);
  return { terminal, path: path.join(plan.rootInfo.root, "maintenance-manifests", basename) };
}

async function assertRotationTransactionAbsent(root, rotationLock) {
  await rotationLock.verify();
  const transaction = await existingUnsafeControlFile(root, ".audit.jsonl.rotation-transaction.json");
  if (transaction) throw new MaintenanceError("PRUNE_HOT_SINK", `rotation transaction appeared while prune held the rotate lock: ${transaction.path}`);
}

const PRUNE_CONTROL_NAMES = new Set([
  ".audit-maintenance.lock",
  ".audit.jsonl.rotate.lock",
  ".audit.jsonl.rotation-transaction.json",
]);

function advisorySnapshotEntry(relativePath, stat) {
  return {
    path: relativePath,
    type: fileType(stat),
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode & 0o777,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
  };
}

async function capturePruneAdvisorySnapshot(root) {
  const entries = [];
  async function walk(logicalPath, relativePath) {
    const stat = await fsp.lstat(logicalPath);
    entries.push(advisorySnapshotEntry(relativePath, stat));
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const names = (await fsp.readdir(logicalPath)).sort();
    if (entries.length + names.length > MAX_PRUNE_SCAN_ENTRIES) {
      throw new MaintenanceError("PRUNE_SCAN_LIMIT", `advisory snapshot exceeds ${MAX_PRUNE_SCAN_ENTRIES} entries`);
    }
    for (const name of names) await walk(path.join(logicalPath, name), relativePath === "." ? name : path.join(relativePath, name));
  }
  await walk(root, ".");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const controls = [...PRUNE_CONTROL_NAMES].sort().map((name) => byPath.get(name)).filter(Boolean);
  return {
    root,
    captured_at: new Date().toISOString(),
    entry_count: entries.length,
    digest: createHash("sha256").update(canonicalJson(entries)).digest("hex"),
    root_identity: byPath.get(".") ?? null,
    archive_identity: byPath.get("archive") ?? null,
    controls,
    entries,
  };
}

function publicPruneAdvisorySnapshot(snapshot) {
  const { entries: _entries, ...summary } = snapshot;
  return summary;
}

function comparePruneAdvisorySnapshots(before, after) {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const warnings = [];
  let unsafeChanged = false;
  for (const relativePath of [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort()) {
    const pre = beforeByPath.get(relativePath) ?? null;
    const post = afterByPath.get(relativePath) ?? null;
    if (pre && post && canonicalJson(pre) === canonicalJson(post)) continue;
    const activeAppend = relativePath === "audit.jsonl" && pre?.type === "file" && post?.type === "file" &&
      pre.dev === post.dev && pre.ino === post.ino && post.size >= pre.size;
    warnings.push({
      path: relativePath === "." ? before.root : path.join(before.root, relativePath),
      reason: activeAppend ? "active_append_observed" : "identity_or_entries_changed",
      affects_plan: !activeAppend,
      pre,
      post,
    });
    if (!activeAppend) unsafeChanged = true;
  }
  const controlsPresent = before.controls.length > 0 || after.controls.length > 0;
  for (const control of before.controls) warnings.push({ path: path.join(before.root, control.path), reason: "control_present_pre_scan", affects_plan: true, pre: control, post: after.entries.find((entry) => entry.path === control.path) ?? null });
  for (const control of after.controls) {
    if (!before.controls.some((entry) => entry.path === control.path)) warnings.push({ path: path.join(before.root, control.path), reason: "control_present_post_scan", affects_plan: true, pre: null, post: control });
  }
  return { changed: warnings.length > 0, unsafe_changed: unsafeChanged || controlsPresent, warnings };
}

async function pruneDryRunAdvisory(root, options, nowMs, readBudget) {
  const pre = await capturePruneAdvisorySnapshot(root);
  const recoveryInfo = await validatePruneRoot(root, true);
  let recovery;
  try { recovery = await recoverDeletionJournals(recoveryInfo, readBudget, options, false); }
  finally { await recoveryInfo.archiveDirectory.handle.close(); await recoveryInfo.rootDirectory.handle.close(); }
  const plan = await buildPrunePlan(root, options, nowMs, readBudget, true);
  try {
    emitTestReadyMarker("prune_advisory_scanned", { root, planned_files: plan.planned.length });
    await awaitTestGate("prune_advisory_scanned");
    const post = await capturePruneAdvisorySnapshot(root);
    const comparison = comparePruneAdvisorySnapshots(pre, post);
    const stale = comparison.unsafe_changed;
    const planned = plan.planned.map((record) => publicPruneRecord(record, record.reasons.join("+"), {
      status: stale ? "stale" : "advisory",
    }));
    const rejected = stale
      ? [...plan.rejected, ...plan.planned.map((record) => publicPruneRecord(record, "advisory_snapshot_changed", { status: "rejected" }))]
      : plan.rejected;
    output({
      ok: true,
      command: "prune",
      dry_run: true,
      consistency: "advisory_no_lock",
      plan_status: stale ? "stale" : "advisory",
      generated_at: new Date(nowMs).toISOString(),
      root,
      options,
      archive_bytes: plan.archive_bytes,
      remaining_archive_bytes: plan.remaining_archive_bytes,
      reclaim_bytes: stale ? 0 : plan.reclaim_bytes,
      planned,
      rejected,
      pinned: plan.pinned,
      kept: plan.kept,
      recovery_required: recovery.recovery_required,
      recovery_rejected: recovery.recovery_rejected,
      advisory_snapshot: {
        pre: publicPruneAdvisorySnapshot(pre),
        post: publicPruneAdvisorySnapshot(post),
        changed: comparison.changed,
        unsafe_changed: comparison.unsafe_changed,
        warnings: comparison.warnings,
      },
      read_budget: readBudget.report(),
      automatic_gc: false,
    });
  } finally {
    await closePrunePlan(plan);
  }
}

async function prune(cli) {
  requireCount(cli, "--root", 1, 1, "EXPLICIT_ROOT_REQUIRED");
  const root = absoluteNormalized(value(cli, "--root"), "prune root");
  const options = pruneOptions(cli);
  const execute = has(cli, "--yes");
  const nowMs = Date.now();
  const readBudget = new CommandReadBudget({
    maxEntries: options.readMaxEntries,
    maxBytes: options.hashMaxBytesTotal,
    maxTimeMs: options.hashTimeBudgetMsTotal,
    entryCode: "PRUNE_ENTRY_LIMIT",
    bytesCode: "PRUNE_HASH_BUDGET_EXCEEDED",
    timeCode: "PRUNE_HASH_TIME_BUDGET_EXCEEDED",
  });
  if (!execute) {
    await pruneDryRunAdvisory(root, options, nowMs, readBudget);
    return;
  }
  const maintenanceLocks = await acquireMaintenanceLocks([root], options.lockTimeoutMs);
  emitTestReadyMarker("prune_maintenance_locked", { root });
  let rotationLock;
  let initial;
  try {
    try { rotationLock = await acquireSinkLock(root, ".audit.jsonl.rotate.lock", options.lockTimeoutMs, "audit-prune-rotate"); }
    catch (error) { if (error instanceof MaintenanceError && error.code === "MAINTENANCE_LOCK_TIMEOUT") throw new MaintenanceError("PRUNE_HOT_SINK", error.message); throw error; }
    await assertRotationTransactionAbsent(root, rotationLock);
    const recoveryInfo = await validatePruneRoot(root);
    let recovery;
    try { recovery = await recoverDeletionJournals(recoveryInfo, readBudget, options, execute); } finally { await recoveryInfo.archiveDirectory.handle.close(); await recoveryInfo.rootDirectory.handle.close(); }
    initial = await buildPrunePlan(root, options, nowMs, readBudget);

    emitTestReadyMarker("prune_initial_preflight", { root, planned_files: initial.planned.length });
    await awaitTestGate("prune_initial_preflight");
    const pauseMs = integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_PRUNE_PAUSE_MS"), 0, 0, 10_000, "prune test pause");
    const initialSnapshot = initial;
    await closePrunePlan(initial);
    initial = null;
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const current = await buildPrunePlan(root, options, nowMs, readBudget);
    let manifestDirectory;
    try {
      if (!samePrunePlan(initialSnapshot, current)) {
        throw new MaintenanceError("PRUNE_PREFLIGHT_CHANGED", "prune plan or target identity changed between preflights");
      }
      emitTestReadyMarker("prune_delete_ready", { root, planned_files: current.planned.length });
      await awaitTestGate("prune_delete_ready");
      const deletePauseMs = integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_PRUNE_DELETE_PAUSE_MS"), 0, 0, 10_000, "prune delete test pause");
      if (deletePauseMs > 0) await new Promise((resolve) => setTimeout(resolve, deletePauseMs));
      await assertRotationTransactionAbsent(root, rotationLock);
      const journalPaths = [];
      if (current.planned.length > 0) {
        manifestDirectory = await openPruneManifestDirectory(current.rootInfo, true);
        for (const record of current.planned) {
          await maintenanceLocks[0].verify();
          await assertRotationTransactionAbsent(root, rotationLock);
          const result = await createAndProcessJournal(current, manifestDirectory, record, readBudget, options);
          journalPaths.push(result.path);
        }
      }
      output({
        ok: true,
        command: "prune",
        dry_run: false,
        generated_at: new Date().toISOString(),
        root,
        options,
        deleted_files: current.planned.length,
        reclaim_bytes: current.reclaim_bytes,
        deletion_manifest_path: journalPaths.at(-1) ?? null,
        deletion_journal_paths: journalPaths,
        planned: current.planned.map((record) => publicPruneRecord(record, record.reasons.join("+"))),
        rejected: current.rejected,
        pinned: current.pinned,
        kept: current.kept,
        recovery_required: recovery.recovery_required,
        recovery_rejected: recovery.recovery_rejected,
        recovered: recovery.recovered,
        read_budget: readBudget.report(),
        automatic_gc: false,
      });
    } finally {
      await manifestDirectory?.handle.close();
      await closePrunePlan(current);
    }
  } finally {
    if (initial) await closePrunePlan(initial);
    await rotationLock?.release().catch(() => {});
    await releaseLocks(maintenanceLocks);
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === "inventory") await inventory(cli);
  else if (cli.command === "rotate-legacy") await rotateLegacy(cli);
  else if (cli.command === "pin") await pin(cli);
  else if (cli.command === "seal") await seal(cli);
  else if (cli.command === "prune") await prune(cli);
}

try {
  await main();
} catch (error) {
  const code = error instanceof MaintenanceError ? error.code : "MAINTENANCE_FAILED";
  const details = error instanceof MaintenanceError ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, code, message: error?.message ?? String(error), ...details })}\n`);
  process.exitCode = 1;
}
