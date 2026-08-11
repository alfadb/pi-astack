#!/usr/bin/env node
/**
 * Production audit replay for the S4 storm-rule enforce path
 * (schema_rejection_storm_enforced) — aggregate-derived, read-only.
 *
 * Reads REAL dispatch audit rows (active audit.jsonl or a rotated archive),
 * filters the target run's schema_error_storm governor observations, verifies
 * the same-hash/shape/consecutive sequence, and replays them through the
 * CURRENT keyless checksum + StormShadow + WorkerRunGovernor to assert that
 * the 4th same-identity rejection produces schema_rejection_storm_enforced.
 *
 * Honesty boundary: historical audits only persisted the governor's OLD
 * private correlation hash (SHA-256 of errorClass\0fieldPath\0normalized) —
 * the raw schema payload (tool name / error text / field path / normalized
 * descriptor) was never persisted. This is therefore an
 * aggregate-derived-event-replay: the legacy hash is used as the production
 * identity material and re-framed with the current keyless domain checksum
 * (auditChecksumHex(STORM_SHADOW_CHECKSUM_DOMAIN, legacyHash)). It is NOT a
 * raw-payload exact replay. The audit is never modified (read-only).
 *
 * Usage:
 *   node scripts/replay-dispatch-schema-storm-production.mjs \
 *     --audit <audit.jsonl | archive.jsonl | dispatch-dir> --run-id <dtr_...>
 *
 * Exit: 0 = PASS (enforce asserted), 1 = FAIL (assertion/verification),
 *       2 = usage/input error.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const AH = await jiti.import(path.join(root, "extensions/_shared/audit-checksum.ts"));
const S = await jiti.import(path.join(root, "extensions/dispatch/storm-shadow.ts"));
const G = await jiti.import(path.join(root, "extensions/dispatch/worker-run-governor.ts"));

const TOOL = "replay-dispatch-schema-storm-production";
const VERSION = "v1";
const EVIDENCE_LEVEL = "aggregate-derived-event-replay";

function arg(name, def) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : def;
}

const auditArg = arg("audit");
const runId = arg("run-id");
if (!auditArg || !runId) {
  console.error(`usage: node scripts/${TOOL}.mjs --audit <audit.jsonl|archive.jsonl|dispatch-dir> --run-id <dtr_...>`);
  process.exit(2);
}
if (!/^dtr_/.test(runId)) {
  console.error(`FAIL --run-id must look like dtr_... (got ${runId})`);
  process.exit(2);
}

/** Bounded pre-filter: does the file contain the run id anywhere? */
function fileContainsRun(file, runId) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(1 << 20);
    const needle = Buffer.from(runId);
    let position = 0;
    let carry = Buffer.alloc(0);
    while (position < size) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (window.includes(needle)) return true;
      carry = window.subarray(Math.max(0, window.length - (needle.length - 1)));
      position += read;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve the audit source: explicit file, or auto-discover audit.jsonl /
 *  archive files under a directory that actually contain the run. */
function resolveAuditSource(auditArg, runId) {
  const stat = fs.statSync(auditArg);
  const candidates = [];
  if (stat.isFile()) {
    candidates.push(auditArg);
  } else if (stat.isDirectory()) {
    const active = path.join(auditArg, "audit.jsonl");
    if (fs.existsSync(active)) candidates.push(active);
    const archiveDir = path.join(auditArg, "archive");
    if (fs.existsSync(archiveDir)) {
      for (const name of fs.readdirSync(archiveDir).sort()) {
        if (name.endsWith(".jsonl")) candidates.push(path.join(archiveDir, name));
      }
    }
  } else {
    throw new Error(`audit path is neither file nor directory: ${auditArg}`);
  }
  for (const candidate of candidates) {
    if (fileContainsRun(candidate, runId)) return candidate;
  }
  throw new Error(`no audit file under ${auditArg} contains run ${runId}`);
}

/** Read every audit row whose dispatch_run_id matches (read-only). */
async function readRunRows(file, runId) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes(runId)) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.dispatch_run_id === runId) rows.push(row);
  }
  return rows;
}

const sourcePath = resolveAuditSource(auditArg, runId);
const rows = await readRunRows(sourcePath, runId);
const stormRows = rows.filter((r) => r.signal === "schema_error_storm" && r.row_kind === "worker_run_event");
const workerRunId = rows.find((r) => typeof r.worker_run_id === "string")?.worker_run_id ?? `replay-${runId}`;

// ── sequence verification: same hash/shape, consecutive counts per identity ──
const issues = [];
const lastCountByHash = new Map();
const shapeByHash = new Map();
for (const e of stormRows) {
  if (typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) {
    issues.push(`row has non-SHA256 hash: ${JSON.stringify(e.hash)}`);
    continue;
  }
  if (typeof e.count !== "number" || e.count < 1) {
    issues.push(`row has invalid count: ${JSON.stringify(e.count)}`);
    continue;
  }
  const last = lastCountByHash.get(e.hash);
  if (last !== undefined) {
    if (e.count !== last + 1) {
      issues.push(`hash ${e.hash.slice(0, 12)} count ${last} -> ${e.count} is not consecutive`);
    }
  } else if (e.count < (e.limit ?? 3)) {
    issues.push(`hash ${e.hash.slice(0, 12)} first recorded count ${e.count} < observeAfter ${e.limit}`);
  }
  lastCountByHash.set(e.hash, e.count);
  const knownShape = shapeByHash.get(e.hash);
  if (knownShape !== undefined && knownShape !== e.shape) {
    issues.push(`hash ${e.hash.slice(0, 12)} shape changed ${knownShape} -> ${e.shape}`);
  }
  shapeByHash.set(e.hash, e.shape);
}
const distinctHashes = new Set(stormRows.map((r) => r.hash)).size;
const distinctShapes = new Set(stormRows.map((r) => r.shape)).size;
const firstCount = stormRows[0]?.count;
const lastCount = stormRows[stormRows.length - 1]?.count;
const observeAfter = stormRows[0]?.limit;

// ── replay: legacy hash as identity material → domain-framed checksum ──
const shadow = new S.StormShadow();
const governor = new G.WorkerRunGovernor(workerRunId, G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
let trigger = null;
let ordinal = 0;
const replayedByHash = new Map();
for (const e of stormRows) {
  const checksum = AH.auditChecksumHex(S.STORM_SHADOW_CHECKSUM_DOMAIN, e.hash);
  const already = replayedByHash.get(e.hash) ?? 0;
  const needed = e.count - already;
  for (let i = 0; i < needed; i++) {
    ordinal++;
    const observation = shadow.feed({
      kind: "tool_execution_end",
      isError: true,
      schemaRejection: true,
      checksum,
    });
    if (
      !trigger &&
      observation.consecutive_count === 4 &&
      observation.cap_after === 3 &&
      observation.would_abort_basis === "consecutive"
    ) {
      const decision = governor.enforceSchemaRejectionStorm({
        checksum,
        segment: observation.segment,
        consecutiveCount: observation.consecutive_count,
        capAfter: observation.cap_after,
        wouldAbortBasis: observation.would_abort_basis,
      });
      if (decision) trigger = { ordinal, decision, observation };
    }
  }
  replayedByHash.set(e.hash, e.count);
}

// ── assertion: the 4th same-identity rejection enforces ──
const enforced =
  trigger !== null &&
  trigger.decision.signal === "schema_rejection_storm_enforce" &&
  trigger.decision.failureType === "schema_rejection_storm_enforced" &&
  trigger.decision.mode === "abort" &&
  trigger.decision.termination_source === "worker_run_governor" &&
  trigger.decision.count === 4 &&
  trigger.decision.limit === 3 &&
  trigger.decision.budget_kind === "consecutive" &&
  trigger.observation.consecutive_count === 4 &&
  trigger.observation.cap_after === 3 &&
  trigger.observation.would_abort_basis === "consecutive";

const result = {
  evidence_level: EVIDENCE_LEVEL,
  tool: TOOL,
  version: VERSION,
  pass: issues.length === 0 && stormRows.length > 0 && enforced,
  source: {
    path: sourcePath,
    run_id: runId,
    worker_run_id: workerRunId,
    event_count: stormRows.length,
    first_count: firstCount,
    last_count: lastCount,
    distinct_hashes: distinctHashes,
    distinct_shapes: distinctShapes,
    observe_after: observeAfter,
    sequence_verified: issues.length === 0,
    sequence_issues: issues,
  },
  replay: {
    checksum_algorithm: "sha256",
    checksum_domain: S.STORM_SHADOW_CHECKSUM_DOMAIN,
    identity_material: "legacy_private_correlation_hash",
    identity_material_note:
      "历史审计仅持久化旧私有 correlation hash（SHA-256 of errorClass\\0fieldPath\\0normalized），无原始 schema payload（tool name / error text / field path / normalized descriptor 均未持久化）；旧 hash 作为生产身份素材再做 domain-framed checksum，非 raw payload exact replay。",
    shadow_rule_version: S.STORM_SHADOW_RULE_VERSION,
    enforce_rule_version: G.WORKER_RUN_STORM_ENFORCE_RULE_VERSION,
    trigger_ordinal: trigger?.ordinal ?? null,
    trigger_count: trigger?.observation.consecutive_count ?? null,
    trigger_limit: trigger?.observation.cap_after ?? null,
    trigger_basis: trigger?.observation.would_abort_basis ?? null,
    trigger_segment: trigger?.observation.segment ?? null,
  },
  result: trigger
    ? {
        enforced: true,
        signal: trigger.decision.signal,
        failure_type: trigger.decision.failureType,
        mode: trigger.decision.mode,
        termination_source: trigger.decision.termination_source,
        count: trigger.decision.count,
        limit: trigger.decision.limit,
        budget_kind: trigger.decision.budget_kind,
        identity_checksum_digest: trigger.decision.identity_checksum?.digest,
      }
    : { enforced: false },
};

console.log(JSON.stringify(result, null, 2));
const summary = result.pass
  ? `PASS ${TOOL}: run=${runId} source=${sourcePath} events=${stormRows.length} trigger=${trigger.ordinal}th count=${trigger.decision.count} limit=${trigger.decision.limit} basis=${trigger.decision.budget_kind} enforced=${trigger.decision.failureType}`
  : `FAIL ${TOOL}: run=${runId} events=${stormRows.length} issues=${issues.length} enforced=${enforced}`;
console.log(summary);
process.exit(result.pass ? 0 : 1);
