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

const TOOL_NAME = "pi-astack-audit-log-maintenance";
const TOOL_VERSION = "2.0.0";
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
const DEFAULT_SEAL_TIME_BUDGET_MS = 60_000;
const HARD_SEAL_TIME_BUDGET_MS = 60 * 60 * 1000;
const DEFAULT_STABLE_MS = 30_000;
const MAX_STABLE_MS = 7 * 24 * 60 * 60 * 1000;
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

function emitTestReadyMarker(phase, details = {}) {
  const marker = testHook("PI_ASTACK_MAINTENANCE_TEST_READY_MARKER");
  if (!marker) return;
  const temporary = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ phase, pid: process.pid, ...details })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, marker);
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
      "--yes": { value: false },
    },
  },
  seal: {
    options: {
      "--root": { repeatable: true, value: true },
      "--stable-ms": { value: true },
      "--max-bytes": { value: true },
      "--time-budget-ms": { value: true },
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
    if (!held.isFile() || !sameIdentity(identity(before), identity(held))) {
      throw new MaintenanceError("IDENTITY_CHANGED", `file identity changed while opening: ${file}`);
    }
    const real = await fsp.realpath(file);
    if (real !== file) throw new MaintenanceError("PATH_REJECTED", `file realpath differs from expected path: ${file}`);
    return { handle, stat: held };
  } catch (error) {
    await handle.close();
    throw error;
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

async function readBoundedJsonRegular(inputPath) {
  await assertNoSymlinkChain(inputPath, { label: "pin input" });
  const opened = await openRegularNoFollow(inputPath, MAX_PIN_INPUT_BYTES);
  try {
    const bytes = await opened.handle.readFile();
    if (bytes.length > MAX_PIN_INPUT_BYTES) throw new MaintenanceError("PIN_INPUT_INVALID", `input exceeds ${MAX_PIN_INPUT_BYTES} bytes`);
    const after = await opened.handle.stat();
    if (!sameSnapshot(snapshot(opened.stat), snapshot(after))) throw new MaintenanceError("PIN_INPUT_INVALID", "input changed while being read");
    let parsed;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch (error) {
      throw new MaintenanceError("PIN_INPUT_INVALID", `input is not valid JSON: ${error.message}`);
    }
    return { parsed, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await opened.handle.close();
  }
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

async function openMaintenanceDirectory(dir, label, repairMode) {
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
    emitTestReadyMarker("directory_fd_ready", { path: canonical });
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
    await handle.sync();
    await handle.chmod(0o600);
    const after = await handle.stat();
    if (!after.isFile() || !sameIdentity(fileIdentity, identity(after))) {
      throw new MaintenanceError("IDENTITY_CHANGED", `output identity changed while writing: ${basename}`);
    }
    await verifyHeldDirectory(directory);
  } finally {
    await handle.close();
  }
}

async function verifyPinSource(source, deadlineMs) {
  if (Date.now() > deadlineMs) throw new MaintenanceError("PIN_TIME_BUDGET_EXCEEDED", "pin source verification exceeded time budget");
  const maxBytes = source.kind === "session_log" ? MAX_PIN_SESSION_BYTES : MAX_PIN_SOURCE_BYTES;
  if (source.bytes > maxBytes) throw new MaintenanceError("PIN_SOURCE_SIZE_EXCEEDED", `${source.kind} request exceeds ${maxBytes} bytes: ${source.path}`);
  await assertNoSymlinkChain(source.path, { label: `pin ${source.kind} source` });
  const opened = await openRegularNoFollow(source.path, maxBytes);
  try {
    const before = snapshot(opened.stat);
    const digest = createHash("sha256");
    const chunks = source.kind === "evidence_manifest" ? [] : null;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const delayMs = integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_PIN_CHUNK_DELAY_MS"), 0, 0, 100, "pin test chunk delay");
    let bytes = 0;
    let lines = 0;
    let lastByte = null;
    let readyEmitted = false;
    while (true) {
      if (Date.now() > deadlineMs) throw new MaintenanceError("PIN_TIME_BUDGET_EXCEEDED", "pin source verification exceeded time budget");
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw new MaintenanceError("PIN_SOURCE_SIZE_EXCEEDED", `${source.kind} read exceeds ${maxBytes} bytes: ${source.path}`);
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        if (newline < 0) break;
        lines++;
        offset = newline + 1;
      }
      lastByte = chunk[chunk.length - 1];
      if (!readyEmitted) {
        emitTestReadyMarker("pin_source_hash_started", { path: source.path, bytes_read: bytesRead });
        readyEmitted = true;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (bytes > 0 && lastByte !== 10) lines++;
    const actualSha256 = digest.digest("hex");
    const heldAfter = snapshot(await opened.handle.stat());
    const pathAfter = snapshot(await fsp.lstat(source.path));
    if (!sameSnapshot(before, heldAfter) || !sameSnapshot(before, pathAfter)) {
      throw new MaintenanceError("PIN_SOURCE_CHANGED", `source changed while being verified: ${source.path}`, { before, held_after: heldAfter, path_after: pathAfter });
    }
    if (bytes !== source.bytes || lines !== source.lines || actualSha256 !== source.sha256) {
      throw new MaintenanceError("PIN_SOURCE_MISMATCH", `source hash/bytes/lines do not match request: ${source.path}`, {
        expected: { sha256: source.sha256, bytes: source.bytes, lines: source.lines },
        actual: { sha256: actualSha256, bytes, lines },
      });
    }
    if (chunks) {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); } catch (error) {
        throw new MaintenanceError("PIN_INPUT_INVALID", `evidence manifest is not valid JSON: ${error.message}`);
      }
      validateEvidenceManifest(parsed);
    }
    return {
      ...source,
      source_verified: true,
      identity: before,
      verified_at: new Date().toISOString(),
    };
  } finally {
    await opened.handle.close();
  }
}

async function pin(cli) {
  requireCount(cli, "--input-manifest", 1, 1, "PIN_ARGUMENT_REQUIRED");
  requireCount(cli, "--output-dir", 1, 1, "PIN_ARGUMENT_REQUIRED");
  const inputPath = absoluteNormalized(value(cli, "--input-manifest"), "pin input manifest");
  const outputDir = absoluteNormalized(value(cli, "--output-dir"), "pin output directory");
  const execute = has(cli, "--yes");
  const { parsed, sha256 } = await readBoundedJsonRegular(inputPath);
  const request = validatePinRequest(parsed);
  const requestedTotal = request.sources.reduce((sum, source) => sum + source.bytes, 0);
  if (!Number.isSafeInteger(requestedTotal) || requestedTotal > MAX_PIN_TOTAL_BYTES) {
    throw new MaintenanceError("PIN_TOTAL_SIZE_EXCEEDED", `pin sources exceed ${MAX_PIN_TOTAL_BYTES} total bytes`);
  }
  const deadlineMs = Date.now() + PIN_TIME_BUDGET_MS;
  const verifiedSources = [];
  let actualTotal = 0;
  for (const source of request.sources) {
    const verified = await verifyPinSource(source, deadlineMs);
    actualTotal += verified.bytes;
    if (actualTotal > MAX_PIN_TOTAL_BYTES) throw new MaintenanceError("PIN_TOTAL_SIZE_EXCEEDED", `pin source reads exceed ${MAX_PIN_TOTAL_BYTES} total bytes`);
    verifiedSources.push(verified);
  }
  const outputDirectory = await prepareOutputDirectory(outputDir, execute);
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
  if (bytes.length > MAX_PIN_OUTPUT_BYTES) {
    await outputDirectory?.handle.close();
    throw new MaintenanceError("PIN_INPUT_INVALID", `validated pin output exceeds ${MAX_PIN_OUTPUT_BYTES} bytes`);
  }
  try {
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
    });
  } finally {
    await outputDirectory?.handle.close();
  }
}

async function hashHandle(handle, expectedSize, maxBytes, deadlineMs) {
  if (expectedSize > maxBytes) throw new MaintenanceError("SEAL_MAX_BYTES_EXCEEDED", `archive size ${expectedSize} exceeds max ${maxBytes}`);
  const testChunkDelayMs = integerOption(testHook("PI_ASTACK_MAINTENANCE_TEST_CHUNK_DELAY_MS"), 0, 0, 100, "test chunk delay");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  let lines = 0;
  let lastByte = null;
  let readyEmitted = false;
  while (true) {
    if (Date.now() > deadlineMs) throw new MaintenanceError("SEAL_TIME_BUDGET_EXCEEDED", "archive hash exceeded time budget");
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > maxBytes) throw new MaintenanceError("SEAL_MAX_BYTES_EXCEEDED", `archive read exceeded max ${maxBytes}`);
    const chunk = buffer.subarray(0, bytesRead);
    digest.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      if (newline < 0) break;
      lines++;
      offset = newline + 1;
    }
    lastByte = chunk[chunk.length - 1];
    if (!readyEmitted) {
      emitTestReadyMarker("seal_hash_started", { bytes_read: bytesRead });
      readyEmitted = true;
    }
    if (testChunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testChunkDelayMs));
  }
  if (bytes > 0 && lastByte !== 10) lines++;
  return { sha256: digest.digest("hex"), bytes, lines };
}

function rejectedSealEntry(archivePath, reason, details = {}) {
  return { path: archivePath, status: "rejected", reason, ...details };
}

async function inspectArchive(archivePath, stableMs, maxBytes, timeBudgetMs, execute) {
  let firstLstat;
  try { firstLstat = await fsp.lstat(archivePath); } catch (error) {
    return rejectedSealEntry(archivePath, "lstat_failed", { error_code: error?.code ?? "UNKNOWN" });
  }
  if (firstLstat.isSymbolicLink()) return rejectedSealEntry(archivePath, "archive_symlink_forbidden");
  if (!firstLstat.isFile()) return rejectedSealEntry(archivePath, "archive_not_regular", { type: fileType(firstLstat) });
  const before = snapshot(firstLstat);
  const stableAgeMs = Date.now() - Math.max(firstLstat.mtimeMs, firstLstat.ctimeMs);
  if (stableAgeMs < stableMs) {
    return { path: archivePath, status: "hot", reason: "stability_window_not_met", stable_age_ms: Math.max(0, Math.floor(stableAgeMs)), required_stable_ms: stableMs, identity: before };
  }
  if (firstLstat.size > maxBytes) return rejectedSealEntry(archivePath, "max_bytes_exceeded", { identity: before, max_bytes: maxBytes });
  if (!execute) return { path: archivePath, status: "snapshot_planned", reason: "eligible_stable_archive", identity: before };

  let handle;
  try { handle = await fsp.open(archivePath, fs.constants.O_RDONLY | NOFOLLOW); } catch (error) {
    return rejectedSealEntry(archivePath, "nofollow_open_failed", { error_code: error?.code ?? "UNKNOWN", identity: before });
  }
  try {
    const heldBeforeStat = await handle.stat();
    if (!heldBeforeStat.isFile()) return rejectedSealEntry(archivePath, "archive_not_regular_after_open");
    const heldBefore = snapshot(heldBeforeStat);
    if (!sameSnapshot(before, heldBefore)) return rejectedSealEntry(archivePath, "identity_changed_before_hash", { before, held_before: heldBefore });
    let hash;
    try {
      hash = await hashHandle(handle, heldBeforeStat.size, maxBytes, Date.now() + timeBudgetMs);
    } catch (error) {
      if (error instanceof MaintenanceError) return rejectedSealEntry(archivePath, error.code === "SEAL_MAX_BYTES_EXCEEDED" ? "max_bytes_exceeded" : "time_budget_exceeded", { identity: heldBefore });
      throw error;
    }
    const heldAfter = snapshot(await handle.stat());
    let pathAfter;
    try { pathAfter = snapshot(await fsp.lstat(archivePath)); } catch (error) {
      return rejectedSealEntry(archivePath, "lstat_after_hash_failed", { error_code: error?.code ?? "UNKNOWN", before: heldBefore, after: heldAfter });
    }
    if (!sameSnapshot(heldBefore, heldAfter) || !sameSnapshot(heldBefore, pathAfter)) {
      return rejectedSealEntry(archivePath, "identity_changed_during_hash", { before: heldBefore, held_after: heldAfter, path_after: pathAfter });
    }
    if (Date.now() - Math.max(heldAfter.mtime_ms, heldAfter.ctime_ms) < stableMs) {
      return { path: archivePath, status: "hot", reason: "stability_window_changed_during_hash", required_stable_ms: stableMs, identity: heldAfter };
    }
    return {
      path: archivePath,
      status: "snapshot_verified",
      reason: "stable_identity_and_hash_verified",
      identity: heldAfter,
      stable_window_ms: stableMs,
      verified_at: new Date().toISOString(),
      ...hash,
      boundary_precision: BOUNDARY_PRECISION,
    };
  } catch (error) {
    return rejectedSealEntry(archivePath, "read_or_stat_failed", { error_code: error?.code ?? "UNKNOWN" });
  } finally {
    await handle.close().catch(() => {});
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

async function writeSealManifest(directory, archiveDir, manifest) {
  const basename = `archive-seal-manifest-${isoCompact()}-${randomUUID()}.json`;
  const manifestPath = path.join(archiveDir, basename);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.length > 4 * 1024 * 1024) throw new MaintenanceError("SEAL_MANIFEST_TOO_LARGE", "seal manifest exceeds 4 MiB");
  await writeExclusiveFile(directory, basename, bytes);
  return manifestPath;
}

async function seal(cli) {
  requireCount(cli, "--root", 1, Number.MAX_SAFE_INTEGER, "EXPLICIT_ROOT_REQUIRED");
  const roots = values(cli, "--root").map((item) => absoluteNormalized(item, "seal root"));
  const stableMs = integerOption(value(cli, "--stable-ms"), DEFAULT_STABLE_MS, 1, MAX_STABLE_MS, "--stable-ms");
  const maxBytes = integerOption(value(cli, "--max-bytes"), DEFAULT_SEAL_MAX_BYTES, 1, HARD_SEAL_MAX_BYTES, "--max-bytes");
  const timeBudgetMs = integerOption(value(cli, "--time-budget-ms"), DEFAULT_SEAL_TIME_BUDGET_MS, 1, HARD_SEAL_TIME_BUDGET_MS, "--time-budget-ms");
  const execute = has(cli, "--yes");
  const rootResults = [];
  let rejected = false;
  const preparedRoots = [];

  try {
    // Preflight every root before --yes can write the first manifest. Execute
    // mode keeps each archive directory fd pinned through manifest creation.
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
      preparedRoots.push({ canonicalRoot, archiveDir, directory, names: names.sort() });
    }

    for (const { canonicalRoot, archiveDir, directory, names } of preparedRoots) {
      const entries = [];
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const accessPath = directory ? path.join(directory.procPath, name) : path.join(archiveDir, name);
        const result = await inspectArchive(accessPath, stableMs, maxBytes, timeBudgetMs, execute);
        if (result.path === accessPath) result.path = path.join(archiveDir, name);
        if (result.status === "rejected") rejected = true;
        entries.push(result);
      }
      const manifest = {
        schema_version: SEAL_SCHEMA_VERSION,
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        generated_at: new Date().toISOString(),
        canonical_root: canonicalRoot,
        archive_directory: archiveDir,
        stable_window: { required_ms: stableMs, basis: "max_mtime_ctime_before_and_after_hash" },
        budgets: { max_bytes_per_file: maxBytes, time_budget_ms_per_file: timeBudgetMs },
        boundary_precision: BOUNDARY_PRECISION,
        entries,
      };
      const manifestPath = execute ? await writeSealManifest(directory, archiveDir, manifest) : null;
      rootResults.push({ root: canonicalRoot, manifest_path: manifestPath, entries });
    }

    output({
      ok: !rejected,
      command: "seal",
      dry_run: !execute,
      generated_at: new Date().toISOString(),
      root_rule: "one_or_more_unique_canonical_absolute_sink_directories; one_manifest_per_root",
      stable_ms: stableMs,
      max_bytes: maxBytes,
      time_budget_ms: timeBudgetMs,
      roots: rootResults,
    });
    if (rejected) process.exitCode = 1;
  } finally {
    await Promise.all(preparedRoots.map(({ directory }) => directory?.handle.close().catch(() => {})));
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === "inventory") await inventory(cli);
  else if (cli.command === "rotate-legacy") await rotateLegacy(cli);
  else if (cli.command === "pin") await pin(cli);
  else if (cli.command === "seal") await seal(cli);
}

try {
  await main();
} catch (error) {
  const code = error instanceof MaintenanceError ? error.code : "MAINTENANCE_FAILED";
  const details = error instanceof MaintenanceError ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, code, message: error?.message ?? String(error), ...details })}\n`);
  process.exitCode = 1;
}
