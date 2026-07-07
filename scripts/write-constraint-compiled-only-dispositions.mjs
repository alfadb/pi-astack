#!/usr/bin/env node
/**
 * ADR0039 compiled-only event-native disposition sidecar writer.
 *
 * Writes/merges strict event-native accepted dispositions into:
 *   <abrain>/.state/sediment/constraint-shadow/latest/compiled-only-dispositions.json
 *
 * This is a data sidecar only. It does not edit runtime artifacts,
 * decision.json, legacy rules, or runtime injection behavior.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = "constraint-compiled-only-dispositions/v1";
const DISPOSITION = "event_native_accepted";

function usage() {
  return [
    "Usage: node scripts/write-constraint-compiled-only-dispositions.mjs [options]",
    "",
    "Options:",
    "  --abrain <path>          abrain home (default: ~/.abrain)",
    "  --latest                 use the latest selected session-start audit row",
    "  --post-refresh           select only rows after the latest successful auto-refresh",
    "  --source <source>        sourceRecordId to accept (repeatable; required for write)",
    "  --review-ref <value>     explicit review reference (required for write)",
    "  --reason <value>         explicit reason (required for write)",
    "  --dry-run                compute merge without writing",
    "  --json                   emit machine-readable JSON",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    abrain: path.join(os.homedir(), ".abrain"),
    latest: false,
    postRefresh: false,
    sources: [],
    reviewRef: null,
    reason: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--latest") options.latest = true;
    else if (arg === "--post-refresh") options.postRefresh = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (["--abrain", "--source", "--review-ref", "--reason"].includes(arg)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
      const value = argv[i + 1];
      i += 1;
      if (arg === "--abrain") options.abrain = value;
      if (arg === "--source") {
        const source = value.trim();
        if (!source) throw new Error("--source requires a non-empty value");
        options.sources.push(source);
      }
      if (arg === "--review-ref") options.reviewRef = value;
      if (arg === "--reason") options.reason = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function expandHome(value) {
  return String(value).replace(/^~(?=$|\/)/, os.homedir());
}

function resolveInputPath(value, baseDir = process.cwd()) {
  return path.resolve(baseDir, expandHome(value));
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function bodyHash(value) {
  return sha256Hex(normalizeText(value));
}

function sidecarPath(abrainHome) {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "compiled-only-dispositions.json");
}

function shadowRoot(abrainHome) {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function timestampMs(row) {
  const raw = stringValue(row?.observedAtUtc) ?? stringValue(row?.completedAtUtc) ?? stringValue(row?.startedAtUtc);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function latestRow(rows) {
  let best = null;
  let bestRank = -Infinity;
  rows.forEach((row, index) => {
    const ms = timestampMs(row);
    const rank = ms === undefined ? index - rows.length : ms;
    if (rank >= bestRank) {
      bestRank = rank;
      best = row;
    }
  });
  return best;
}

function latestSuccessfulAutoRefresh(rows) {
  return latestRow(rows.filter((row) => row?.status === "completed" && (row?.ok === true || row?.result?.ok === true)));
}

function selectedAuditRow(root, options) {
  const auditRows = readJsonLines(path.join(root, "session-start-dualread", "audit.jsonl"))
    .filter((row) => row?.schemaVersion === "rule-injector-dualread-audit/v1");
  let rows = auditRows;
  const autoRows = readJsonLines(path.join(root, "auto-refresh", "audit.jsonl"));
  const latestRefresh = latestSuccessfulAutoRefresh(autoRows);
  const latestRefreshMs = latestRefresh ? timestampMs(latestRefresh) : undefined;
  if (options.postRefresh && latestRefreshMs !== undefined) {
    rows = rows.filter((row) => {
      const ms = timestampMs(row);
      return ms !== undefined && ms > latestRefreshMs;
    });
  }
  return { row: latestRow(rows), auditRows: auditRows.length, selectedRows: rows.length, latestRefresh };
}

function scopeKey(scope) {
  if (!isObject(scope)) return "unknown";
  return scope.kind === "project" ? `project:${scope.projectId}` : "global";
}

function sourceIn(ids, sourceRecordId) {
  return Array.isArray(ids) && ids.includes(sourceRecordId);
}

function findConstraint(decision, detail) {
  const constraints = Array.isArray(decision?.constraints) ? decision.constraints : [];
  return constraints.find((item) => isObject(item) && (
    item.constraintId === detail.constraintId
    || (item.constraintId === detail.sourceRecordId && !detail.constraintId)
    || sourceIn(item.sourceRecordIds, detail.sourceRecordId)
  ));
}

function dispositionKey(item) {
  return [
    item.sourceRecordId,
    item.constraintId,
    item.bodyHash,
    item.inputRootHash,
    item.validationHash,
    item.scope,
    item.injectMode,
  ].join("\0");
}

function assertSidecarItem(item, index) {
  if (!isObject(item)) throw new Error(`compiled-only-dispositions item ${index} is not an object`);
  for (const field of ["sourceRecordId", "sourceKind", "category", "constraintId", "bodyHash", "inputRootHash", "validationHash", "scope"]) {
    if (!stringValue(item[field])) throw new Error(`compiled-only-dispositions item ${index} missing ${field}`);
  }
  if (item.injectMode !== "always" && item.injectMode !== "listed") throw new Error(`compiled-only-dispositions item ${index} has invalid injectMode`);
  if (item.disposition !== DISPOSITION) throw new Error(`compiled-only-dispositions item ${index} has invalid disposition`);
}

function readSidecar(file) {
  if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, items: [] };
  const value = readJson(file);
  if (!isObject(value)) throw new Error("compiled-only-dispositions is not an object");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("unexpected compiled-only-dispositions schemaVersion");
  if (!Array.isArray(value.items)) throw new Error("compiled-only-dispositions.items is not an array");
  value.items.forEach(assertSidecarItem);
  return { schemaVersion: SCHEMA_VERSION, items: value.items };
}

function validateWriteGuards(options) {
  if (options.dryRun) return;
  const missing = [];
  if (!options.sources.length) missing.push("--source");
  if (!stringValue(options.reviewRef)) missing.push("--review-ref");
  if (!stringValue(options.reason)) missing.push("--reason");
  if (missing.length) throw new Error(`non-dry-run write requires ${missing.join(", ")}`);
}

function skip(sourceRecordId, reason) {
  return { sourceRecordId: sourceRecordId ?? null, reason };
}

function candidateFromDetail(detail, decision, metadata) {
  const sourceRecordId = stringValue(detail?.sourceRecordId);
  if (!sourceRecordId) return { candidate: null, skipped: skip(null, "missing sourceRecordId") };
  if (!sourceRecordId.startsWith("event:")) return { candidate: null, skipped: skip(sourceRecordId, "source is not event:*") };
  if (detail.sourceKind !== "constraint_event") return { candidate: null, skipped: skip(sourceRecordId, "sourceKind is not constraint_event") };
  if (detail.category !== "event_native") return { candidate: null, skipped: skip(sourceRecordId, "category is not event_native") };
  if (detail.humanReviewRequired === true) return { candidate: null, skipped: skip(sourceRecordId, "humanReviewRequired=true") };
  if (detail.compiledOnlyBackfillAllowed !== false) return { candidate: null, skipped: skip(sourceRecordId, "compiledOnlyBackfillAllowed is not false") };
  if (detail.machineDisposition && detail.machineDisposition !== DISPOSITION) return { candidate: null, skipped: skip(sourceRecordId, "detail already has non-accepted machineDisposition") };
  const inputRootHash = stringValue(decision?.inputRootHash);
  const validationHash = stringValue(decision?.validationHash);
  if (!inputRootHash || !validationHash) return { candidate: null, skipped: skip(sourceRecordId, "decision missing inputRootHash/validationHash") };
  if (detail.inputRootHash !== inputRootHash || detail.validationHash !== validationHash) return { candidate: null, skipped: skip(sourceRecordId, "detail hash root mismatch") };
  const constraint = findConstraint(decision, detail);
  if (!constraint) return { candidate: null, skipped: skip(sourceRecordId, "decision constraint not found") };
  const constraintId = stringValue(constraint.constraintId);
  if (!constraintId || detail.constraintId !== constraintId) return { candidate: null, skipped: skip(sourceRecordId, "constraintId mismatch") };
  const currentBodyHash = bodyHash(constraint.compiledBody);
  if (detail.bodyHash !== currentBodyHash) return { candidate: null, skipped: skip(sourceRecordId, "bodyHash mismatch") };
  const scope = scopeKey(constraint.scope);
  if (detail.scope !== scope) return { candidate: null, skipped: skip(sourceRecordId, "scope mismatch") };
  if ((constraint.injectMode !== "always" && constraint.injectMode !== "listed") || detail.injectMode !== constraint.injectMode) {
    return { candidate: null, skipped: skip(sourceRecordId, "injectMode mismatch") };
  }
  if (!sourceIn(constraint.sourceRecordIds, sourceRecordId)) return { candidate: null, skipped: skip(sourceRecordId, "constraint sourceRecordIds mismatch") };
  return {
    skipped: null,
    candidate: {
      sourceRecordId,
      sourceKind: "constraint_event",
      category: "event_native",
      constraintId,
      bodyHash: currentBodyHash,
      inputRootHash,
      validationHash,
      scope,
      injectMode: constraint.injectMode,
      disposition: DISPOSITION,
      reviewedAtUtc: metadata.reviewedAtUtc,
      reviewRef: metadata.reviewRef,
      reason: metadata.reason,
    },
  };
}

function buildCandidates(auditRow, decision, options) {
  const metadata = {
    reviewedAtUtc: new Date().toISOString(),
    reviewRef: stringValue(options.reviewRef) ?? "dry-run:unreviewed",
    reason: stringValue(options.reason) ?? "dry-run:unreviewed",
  };
  const sourceFilter = options.sources.length ? new Set(options.sources) : null;
  const details = Array.isArray(auditRow?.compiledOnlyDetails) ? auditRow.compiledOnlyDetails : [];
  const byKey = new Map();
  const skipped = [];
  const filtered = [];
  if (auditRow?.inputRootHash !== decision.inputRootHash || auditRow?.validationHash !== decision.validationHash) {
    return {
      candidates: [],
      skipped: [skip(null, "selected audit row inputRootHash/validationHash mismatch")],
      filtered,
      considered: details.length,
      metadata,
    };
  }
  for (const detail of details) {
    const sourceRecordId = stringValue(detail?.sourceRecordId);
    if (sourceFilter && (!sourceRecordId || !sourceFilter.has(sourceRecordId))) {
      filtered.push(skip(sourceRecordId, "not included by --source"));
      continue;
    }
    const { candidate, skipped: skippedItem } = candidateFromDetail(detail, decision, metadata);
    if (skippedItem) skipped.push(skippedItem);
    if (candidate) byKey.set(dispositionKey(candidate), candidate);
  }
  return { candidates: [...byKey.values()], skipped, filtered, considered: details.length - filtered.length, metadata };
}

function relevantMetadataMatches(existing, candidate) {
  return existing.disposition === candidate.disposition
    && existing.reviewRef === candidate.reviewRef
    && existing.reason === candidate.reason
    && typeof existing.reviewedAtUtc === "string"
    && existing.reviewedAtUtc.trim().length > 0;
}

function mergeSidecar(existing, candidates) {
  const order = [];
  const byKey = new Map();
  for (const item of existing.items) {
    const key = dispositionKey(item);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, item);
  }
  const stats = { created: 0, updated: 0, unchanged: 0 };
  for (const candidate of candidates) {
    const key = dispositionKey(candidate);
    const existingItem = byKey.get(key);
    if (!existingItem) {
      order.push(key);
      byKey.set(key, candidate);
      stats.created += 1;
    } else if (relevantMetadataMatches(existingItem, candidate)) {
      stats.unchanged += 1;
    } else {
      byKey.set(key, { ...existingItem, ...candidate });
      stats.updated += 1;
    }
  }
  const items = order.map((key) => byKey.get(key));
  return { sidecar: { schemaVersion: SCHEMA_VERSION, items }, stats: { ...stats, total: items.length } };
}

function renderHuman(result) {
  const lines = [];
  lines.push("ADR0039 compiled-only event-native dispositions writer");
  lines.push(`target: ${result.path}`);
  lines.push(`mode: ${result.dryRun ? "dry-run" : "write"}`);
  lines.push(`created: ${result.stats.created}  updated: ${result.stats.updated}  unchanged: ${result.stats.unchanged}  total: ${result.stats.total}`);
  lines.push(`considered: ${result.stats.considered}  filtered: ${result.stats.filtered}  skipped: ${result.stats.skipped}`);
  if (result.inputs.sources.length) lines.push(`sources: ${result.inputs.sources.join(", ")}`);
  if (result.dryRun) lines.push("dry-run: no files written");
  if (result.warnings.length) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  validateWriteGuards(options);
  const abrainHome = resolveInputPath(options.abrain);
  const root = shadowRoot(abrainHome);
  const decisionPath = path.join(root, "latest", "decision.json");
  if (!fs.existsSync(decisionPath)) throw new Error("missing latest decision.json");
  const decision = readJson(decisionPath);
  if (!isObject(decision) || decision.schemaVersion !== "constraint-shadow-decision/v1" || !Array.isArray(decision.constraints)) {
    throw new Error("latest decision.json has unexpected schema");
  }
  const selection = selectedAuditRow(root, options);
  if (!selection.row) throw new Error("no selected session-start dual-read audit row");
  const { candidates, skipped, filtered, considered, metadata } = buildCandidates(selection.row, decision, options);
  const file = sidecarPath(abrainHome);
  const existing = readSidecar(file);
  const { sidecar, stats } = mergeSidecar(existing, candidates);
  const result = {
    ok: true,
    dryRun: options.dryRun,
    path: file,
    schemaVersion: SCHEMA_VERSION,
    stats: {
      ...stats,
      considered,
      filtered: filtered.length,
      skipped: skipped.length,
      candidates: candidates.length,
    },
    inputs: {
      abrainHome,
      latest: options.latest,
      postRefresh: options.postRefresh,
      sources: options.sources,
    },
    selection: {
      auditRows: selection.auditRows,
      selectedRows: selection.selectedRows,
      latestObservedAtUtc: selection.row.observedAtUtc ?? null,
      latestInputRootHash: selection.row.inputRootHash ?? null,
      latestValidationHash: selection.row.validationHash ?? null,
      latestRefreshObservedAtUtc: selection.latestRefresh?.observedAtUtc ?? null,
    },
    reviewRef: metadata.reviewRef,
    reviewedAtUtc: metadata.reviewedAtUtc,
    warnings: skipped.map((item) => `skipped ${item.sourceRecordId ?? "missing-source"}: ${item.reason}`),
  };
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHuman(result));
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`ERROR: ${message}\n\n${usage()}`);
  process.exitCode = 1;
}
