#!/usr/bin/env node
/**
 * ADR0039 Constraint text-delta disposition sidecar writer.
 *
 * Writes/merges hash-bound semantic review dispositions into:
 *   <abrain>/.state/sediment/constraint-shadow/latest/text-delta-dispositions.json
 *
 * This is a data sidecar only. It does not edit runtime artifacts, decision.json,
 * legacy rules, or other abrain content.
 *
 * Usage:
 *   node scripts/write-constraint-text-delta-dispositions.mjs [--abrain ~/.abrain]
 *     [--post-refresh] [--latest] [--include-normalization]
 *     [--source <sourceRecordId>] [--exclude-source <sourceRecordId>]
 *     [--review-ref <value>] [--reason <value>] [--dry-run] [--json]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "constraint-text-delta-dispositions/v1";
const VALID_DISPOSITIONS = new Set([
  "semantic_equivalent",
  "normalization_possible",
  "semantic_mismatch_fix_required",
  "semantic_review_required",
]);
const DEFAULT_SEMANTIC_REASON = "multi-model semantic review accepted equivalent";
const DEFAULT_NORMALIZATION_REASON = "multi-model semantic review retained normalization_possible";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const reviewPackScript = path.join(__dirname, "dossier-constraint-semantic-review-pack.mjs");

function usage() {
  return [
    "Usage: node scripts/write-constraint-text-delta-dispositions.mjs [options]",
    "",
    "Options:",
    "  --abrain <path>                 abrain home (default: ~/.abrain)",
    "  --post-refresh                  use semantic review pack post-refresh selection",
    "  --latest                        use only the latest selected session-start row",
    "  --include-normalization         also write normalization_possible items as normalization_possible",
    "  --source <sourceRecordId>        only consider this sourceRecordId (repeatable)",
    "  --exclude-source <sourceRecordId> exclude this sourceRecordId after source filtering (repeatable)",
    "  --review-ref <value>            review reference metadata",
    "  --reason <value>                reason metadata",
    "  --dry-run                       compute merge without writing",
    "  --json                          emit machine-readable JSON",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    abrain: path.join(os.homedir(), ".abrain"),
    postRefresh: false,
    latest: false,
    includeNormalization: false,
    sources: [],
    excludeSources: [],
    reviewRef: null,
    reason: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--post-refresh") {
      options.postRefresh = true;
    } else if (arg === "--latest") {
      options.latest = true;
    } else if (arg === "--include-normalization") {
      options.includeNormalization = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (["--abrain", "--review-ref", "--reason", "--source", "--exclude-source"].includes(arg)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      const rawValue = argv[i + 1];
      const value = ["--source", "--exclude-source"].includes(arg) ? rawValue.trim() : rawValue;
      if (["--source", "--exclude-source"].includes(arg) && !value) {
        throw new Error(`${arg} requires a non-empty value`);
      }
      i += 1;
      if (arg === "--abrain") options.abrain = value;
      if (arg === "--review-ref") options.reviewRef = value;
      if (arg === "--reason") options.reason = value;
      if (arg === "--source") options.sources.push(value);
      if (arg === "--exclude-source") options.excludeSources.push(value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
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

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sidecarPath(abrainHome) {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "text-delta-dispositions.json");
}

function dispositionKey(item) {
  return `${item.sourceRecordId}\0${item.legacyHash}\0${item.shadowHash}`;
}

function assertSidecarItem(raw, index) {
  if (!isObject(raw)) throw new Error(`text-delta-dispositions item ${index} is not an object`);
  for (const field of ["sourceRecordId", "legacyHash", "shadowHash"]) {
    if (!stringValue(raw[field])) throw new Error(`text-delta-dispositions item ${index} missing ${field}`);
  }
  if (!stringValue(raw.disposition) || !VALID_DISPOSITIONS.has(raw.disposition)) {
    throw new Error(`text-delta-dispositions item ${index} has invalid disposition`);
  }
}

function readSidecar(file) {
  if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, items: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObject(value)) throw new Error("text-delta-dispositions is not an object");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("unexpected text-delta-dispositions schemaVersion");
  if (!Array.isArray(value.items)) throw new Error("text-delta-dispositions.items is not an array");
  value.items.forEach(assertSidecarItem);
  return { schemaVersion: SCHEMA_VERSION, items: value.items };
}

function runReviewPack(options) {
  const args = [reviewPackScript, "--abrain", options.abrainHome, "--json"];
  if (options.postRefresh) args.push("--post-refresh");
  if (options.latest) args.push("--latest");
  if (options.includeNormalization) args.push("--include-normalization");
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`semantic review pack failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`semantic review pack did not emit JSON: ${message}`);
  }
}

function defaultReviewRef(pack) {
  const observedAt = stringValue(pack?.latestObservedAt)
    ?? stringValue(pack?.selection?.latest?.observedAtUtc)
    ?? stringValue(pack?.binding?.latestAuditObservedAtUtc)
    ?? "unknown";
  return `semantic-review-pack:${observedAt}`;
}

function targetDisposition(item, includeNormalization) {
  if (item?.kind !== "text_delta_pair") return null;
  if (item.disposition === "semantic_review_required") return "semantic_equivalent";
  if (includeNormalization && item.disposition === "normalization_possible") return "normalization_possible";
  return null;
}

function reasonForDisposition(disposition, explicitReason) {
  if (explicitReason) return explicitReason;
  return disposition === "normalization_possible" ? DEFAULT_NORMALIZATION_REASON : DEFAULT_SEMANTIC_REASON;
}

function sourceFilterDecision(item, options) {
  const sourceRecordId = stringValue(item?.sourceRecordId);
  const include = options.sources.length ? new Set(options.sources) : null;
  const exclude = options.excludeSources.length ? new Set(options.excludeSources) : null;
  if (include && (!sourceRecordId || !include.has(sourceRecordId))) {
    return { filtered: true, sourceRecordId, reason: "not included by --source" };
  }
  if (exclude && sourceRecordId && exclude.has(sourceRecordId)) {
    return { filtered: true, sourceRecordId, reason: "excluded by --exclude-source" };
  }
  return { filtered: false, sourceRecordId, reason: null };
}

function candidateFromReviewItem(item, options, metadata) {
  const disposition = targetDisposition(item, options.includeNormalization);
  if (!disposition) return { skipped: null, candidate: null };
  const sourceRecordId = stringValue(item.sourceRecordId);
  const legacyHash = stringValue(item.legacyHash);
  const shadowHash = stringValue(item.shadowHash);
  if (!sourceRecordId || !legacyHash || !shadowHash) {
    return {
      skipped: {
        sourceRecordId: sourceRecordId ?? null,
        disposition: item.disposition ?? null,
        reason: "missing sourceRecordId/legacyHash/shadowHash",
      },
      candidate: null,
    };
  }
  return {
    skipped: null,
    candidate: {
      sourceRecordId,
      legacyHash,
      shadowHash,
      disposition,
      reviewedAtUtc: metadata.reviewedAtUtc,
      reviewRef: metadata.reviewRef,
      reason: reasonForDisposition(disposition, options.reason),
    },
  };
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

function buildCandidates(pack, options) {
  const metadata = {
    reviewedAtUtc: new Date().toISOString(),
    reviewRef: options.reviewRef ?? defaultReviewRef(pack),
  };
  const byKey = new Map();
  const skipped = [];
  const filtered = [];
  const reviewItems = Array.isArray(pack?.reviewItems) ? pack.reviewItems : [];
  for (const item of reviewItems) {
    const filter = sourceFilterDecision(item, options);
    if (filter.filtered) {
      filtered.push({ sourceRecordId: filter.sourceRecordId ?? null, reason: filter.reason });
      continue;
    }
    const { candidate, skipped: skippedItem } = candidateFromReviewItem(item, options, metadata);
    if (skippedItem) skipped.push(skippedItem);
    if (candidate) byKey.set(dispositionKey(candidate), candidate);
  }
  return { candidates: [...byKey.values()], skipped, filtered, considered: reviewItems.length - filtered.length, metadata };
}

function renderHuman(result) {
  const lines = [];
  lines.push("ADR0039 Constraint text-delta dispositions writer");
  lines.push(`target: ${result.path}`);
  lines.push(`mode: ${result.dryRun ? "dry-run" : "write"}`);
  lines.push(`reviewRef: ${result.reviewRef}`);
  if (result.inputs.sources.length) lines.push(`sources: ${result.inputs.sources.join(", ")}`);
  if (result.inputs.excludeSources.length) lines.push(`excludeSources: ${result.inputs.excludeSources.join(", ")}`);
  lines.push(`created: ${result.stats.created}  updated: ${result.stats.updated}  unchanged: ${result.stats.unchanged}  total: ${result.stats.total}`);
  lines.push(`considered: ${result.stats.considered}  filtered: ${result.stats.filtered}`);
  if (result.stats.skipped) lines.push(`skipped: ${result.stats.skipped}`);
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
  options.abrainHome = resolveInputPath(options.abrain);
  const file = sidecarPath(options.abrainHome);
  const pack = runReviewPack(options);
  const { candidates, skipped, filtered, considered, metadata } = buildCandidates(pack, options);
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
      skipped: skipped.length,
      filtered: filtered.length,
      candidates: candidates.length,
    },
    reviewRef: metadata.reviewRef,
    reviewedAtUtc: metadata.reviewedAtUtc,
    inputs: {
      abrainHome: options.abrainHome,
      postRefresh: options.postRefresh,
      latest: options.latest,
      includeNormalization: options.includeNormalization,
      sources: options.sources,
      excludeSources: options.excludeSources,
    },
    reviewPack: {
      schemaVersion: pack?.schemaVersion ?? null,
      generatedAtUtc: pack?.generatedAtUtc ?? null,
      latestObservedAtUtc: pack?.selection?.latest?.observedAtUtc ?? pack?.binding?.latestAuditObservedAtUtc ?? null,
      reviewItemCount: Array.isArray(pack?.reviewItems) ? pack.reviewItems.length : 0,
    },
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
  const json = process.argv.includes("--json");
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`ERROR: ${message}\n\n${usage()}`);
  process.exitCode = 1;
}
