#!/usr/bin/env node
/**
 * ADR0039 Constraint legacy retirement blocker dossier.
 *
 * Read-only report over session-start dual-read audit rows. The report
 * explains legacy retirement blockers without changing runtime behavior,
 * settings, or canonical memory.
 *
 * Usage:
 *   node scripts/dossier-constraint-legacy-retirement.mjs [--abrain ~/.abrain]
 *     [--window-days 7] [--post-refresh] [--latest] [--json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAMPLE_LIMIT = 20;
const BLOCKING_DISPOSITIONS = new Set([
  "unknown",
  "settings_not_memory",
  "tool_contract_not_memory",
  "model_uncertain",
  "compiled_missing",
  "semantic_review_required",
  "semantic_mismatch_fix_required",
  "semantic_mismatch",
  "normalization_possible",
  "event_native",
  "compiled_only",
  "count_only_missing_details",
]);
const ARCHIVABLE_DISPOSITIONS = new Set([
  "event_native_accepted",
  "archived",
  "archive_authorized",
  "authorized_archive",
  "legacy_retired",
  "retired",
  "semantic_equivalent",
  "no_delta",
  "no_action_required",
]);

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function arg(name, def) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : def;
}

function expandHome(value) {
  return String(value).replace(/^~(?=$|\/)/, os.homedir());
}

function resolveInputPath(value, baseDir = process.cwd()) {
  return path.resolve(baseDir, expandHome(value));
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, file };
    return { exists: true, file, value: JSON.parse(fs.readFileSync(file, "utf8")), mtimeMs: fs.statSync(file).mtimeMs };
  } catch (err) {
    return { exists: true, file, error: err instanceof Error ? err.message : String(err) };
  }
}

function readJsonLines(file) {
  const result = { exists: false, file, rows: [], parseErrors: [] };
  try {
    if (!fs.existsSync(file)) return result;
    result.exists = true;
    fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        result.rows.push(JSON.parse(line));
      } catch (err) {
        result.parseErrors.push({ line: index + 1, error: err instanceof Error ? err.message : String(err) });
      }
    });
  } catch (err) {
    result.exists = true;
    result.readError = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function numberAt(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringAt(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function timestampMs(row) {
  const raw = stringAt(row?.observedAtUtc, row?.completedAtUtc, row?.startedAtUtc, row?.timestamp, row?.time);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function rowsInWindow(rows, cutoffMs) {
  return rows.filter((row) => {
    const ms = timestampMs(row);
    return ms !== undefined && ms >= cutoffMs;
  });
}

function latestRow(rows) {
  let best;
  let bestMs = -Infinity;
  rows.forEach((row, index) => {
    const ms = timestampMs(row);
    const rank = ms === undefined ? index - rows.length : ms;
    if (rank >= bestMs) {
      bestMs = rank;
      best = row;
    }
  });
  return best;
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) {
    const key = String(row?.[field] ?? "<missing>");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countFromSummaryOrDelta(row, key) {
  const summaryValue = numberAt(row?.summary?.[key], row?.counts?.[key]);
  if (summaryValue !== undefined) return summaryValue;
  const delta = row?.delta?.[key];
  if (Array.isArray(delta)) return delta.length;
  const direct = row?.[key];
  if (Array.isArray(direct)) return direct.length;
  return 0;
}

function valueByPath(obj, names) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

function shortText(value, limit = 180) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function firstId(value) {
  if (typeof value === "string" && value) return value;
  if (isObject(value)) return stringAt(value.sourceRecordId, value.id, value.key, value.constraintId, value.targetId, value.legacyId);
  return undefined;
}

function legacyDetailKey(detail) {
  return stringAt(detail?.sourceRecordId, detail?.legacyId, detail?.id, detail?.key, detail?.sourceKey) ?? JSON.stringify(detail);
}

function compiledDetailKey(detail) {
  return stringAt(detail?.sourceRecordId, detail?.constraintId, detail?.id, detail?.key, detail?.targetId) ?? JSON.stringify(detail);
}

function textDeltaKey(detail) {
  const id = stringAt(detail?.sourceRecordId, detail?.legacyId, detail?.id, detail?.key) ?? "unknown";
  const legacyHash = stringAt(detail?.legacyHash, detail?.oldHash) ?? "";
  const shadowHash = stringAt(detail?.shadowHash, detail?.compiledHash, detail?.newHash) ?? "";
  return `${id}\0${legacyHash}\0${shadowHash}`;
}

function deltaKeys(row, key) {
  return asArray(row?.delta?.[key] ?? row?.[key]).map(firstId).filter(Boolean);
}

function textDeltaItems(row) {
  return asArray(row?.delta?.textDelta ?? row?.textDelta).filter(isObject);
}

function dispositionOf(detail, fallback = "unknown") {
  const raw = stringAt(detail?.machineDisposition, detail?.disposition, detail?.retirementDisposition, detail?.category, detail?.sourceKind, fallback);
  return raw || fallback;
}

function detailBlocksRetirement(detail, disposition) {
  if (detail?.humanReviewRequired === true) return true;
  if (ARCHIVABLE_DISPOSITIONS.has(disposition)) return false;
  if (detail?.compiledOnlyBackfillAllowed === false) return true;
  if (BLOCKING_DISPOSITIONS.has(disposition)) return true;
  return true;
}

function addGroup(groups, disposition, detail, key, sample) {
  const group = groups[disposition] ?? { total: 0, unique: 0, blocking: 0, blockingUnique: 0, humanReview: 0, humanReviewUnique: 0, samples: [] };
  group.total += 1;
  if (!group._keys) group._keys = new Set();
  if (!group._keys.has(key)) {
    group._keys.add(key);
    group.unique = group._keys.size;
  }
  if (detailBlocksRetirement(detail, disposition)) {
    group.blocking += 1;
    if (!group._blockingKeys) group._blockingKeys = new Set();
    group._blockingKeys.add(key);
    group.blockingUnique = group._blockingKeys.size;
  }
  if (detail?.humanReviewRequired === true) {
    group.humanReview += 1;
    if (!group._humanReviewKeys) group._humanReviewKeys = new Set();
    group._humanReviewKeys.add(key);
    group.humanReviewUnique = group._humanReviewKeys.size;
  }
  if (group.samples.length < SAMPLE_LIMIT) group.samples.push(sample);
  groups[disposition] = group;
}

function stripInternalSets(groups) {
  const out = {};
  for (const [key, value] of Object.entries(groups)) {
    out[key] = {
      total: value.total,
      unique: value.unique,
      blocking: value.blocking,
      blockingUnique: value.blockingUnique,
      humanReview: value.humanReview,
      humanReviewUnique: value.humanReviewUnique,
      samples: value.samples,
    };
  }
  return out;
}

function refsFrom(detail) {
  const refs = [];
  for (const value of [detail?.sourceRecordId, detail?.sourceRef, detail?.reviewRef, detail?.targetId]) {
    if (typeof value === "string" && value) refs.push(value);
  }
  for (const value of [detail?.sourceRecordIds, detail?.diagnosticIds, detail?.refs, detail?.sourceRefs]) {
    if (Array.isArray(value)) refs.push(...value.filter((item) => typeof item === "string" && item));
  }
  return [...new Set(refs)].slice(0, 8);
}

function legacySample(detail) {
  return {
    id: stringAt(detail?.sourceRecordId, detail?.legacyId, detail?.id) ?? null,
    key: stringAt(detail?.key, detail?.sourceKey) ?? null,
    sourceRefs: refsFrom(detail),
    humanReviewRequired: detail?.humanReviewRequired === true,
    scopeCaveat: detail?.scopeCaveat ?? null,
    reason: detail?.reason ?? null,
    category: detail?.category ?? null,
    compilerDisposition: detail?.compilerDisposition ?? null,
    diagnosticCode: detail?.diagnosticCode ?? null,
    targetId: detail?.targetId ?? null,
  };
}

function compiledSample(detail) {
  return {
    id: stringAt(detail?.sourceRecordId, detail?.id, detail?.key) ?? null,
    constraintId: detail?.constraintId ?? null,
    sourceKind: detail?.sourceKind ?? null,
    scope: detail?.scope ?? null,
    category: detail?.category ?? null,
    injectMode: detail?.injectMode ?? null,
    compiledOnlyBackfillAllowed: detail?.compiledOnlyBackfillAllowed ?? null,
    humanReviewRequired: detail?.humanReviewRequired === true,
    sourceRefs: refsFrom(detail),
  };
}

function textDeltaSample(detail) {
  return {
    constraintId: stringAt(detail?.constraintId, detail?.targetId, detail?.shadowId, detail?.compiledId) ?? null,
    legacyId: stringAt(detail?.sourceRecordId, detail?.legacyId, detail?.id, detail?.key) ?? null,
    key: detail?.key ?? null,
    legacyHash: stringAt(detail?.legacyHash, detail?.oldHash) ?? null,
    compiledHash: stringAt(detail?.shadowHash, detail?.compiledHash, detail?.newHash) ?? null,
    legacyLine: valueByPath(detail, ["legacyLine", "oldLine", "line"] ) ?? null,
    compiledLine: valueByPath(detail, ["compiledLine", "shadowLine", "newLine"] ) ?? null,
    legacyExcerpt: shortText(valueByPath(detail, ["legacyExcerpt", "legacyText", "oldExcerpt", "oldText"] )) ?? null,
    compiledExcerpt: shortText(valueByPath(detail, ["compiledExcerpt", "shadowExcerpt", "compiledText", "newExcerpt", "newText"] )) ?? null,
    humanReviewRequired: detail?.humanReviewRequired === true,
    reviewSource: detail?.reviewSource ?? null,
    reason: detail?.reason ?? null,
    category: detail?.category ?? null,
    sourceRefs: refsFrom(detail),
  };
}

function summarizeKind(rows, kind) {
  const unique = new Set();
  const groups = {};
  let total = 0;
  let detailTotal = 0;
  let countOnlyTotal = 0;
  let countOnlyRows = 0;

  for (const row of rows) {
    const rowCount = countFromSummaryOrDelta(row, kind);
    total += rowCount;

    const detailsName = kind === "textDelta" ? "textDeltaDetails" : `${kind}Details`;
    const details = asArray(row?.[detailsName]);
    detailTotal += details.length;

    if (details.length) {
      for (const detail of details) {
        const key = kind === "legacyOnly" ? legacyDetailKey(detail) : kind === "compiledOnly" ? compiledDetailKey(detail) : textDeltaKey(detail);
        unique.add(key);
        const disposition = dispositionOf(detail, kind === "compiledOnly" ? "unknown" : "unknown");
        const sample = kind === "legacyOnly" ? legacySample(detail) : kind === "compiledOnly" ? compiledSample(detail) : textDeltaSample(detail);
        addGroup(groups, disposition, detail, key, sample);
      }
    }

    if (rowCount > details.length) {
      const missing = rowCount - details.length;
      countOnlyTotal += missing;
      countOnlyRows += 1;
      for (const key of deltaKeys(row, kind)) unique.add(key);
      if (kind === "textDelta") {
        for (const item of textDeltaItems(row)) unique.add(textDeltaKey(item));
      }
      addGroup(groups, "count_only_missing_details", { humanReviewRequired: true }, `${row?.observedAtUtc ?? "row"}:${kind}:missing`, {
        observedAtUtc: row?.observedAtUtc ?? null,
        status: row?.status ?? null,
        count: missing,
        note: "audit row reported count without matching details; disposition cannot be subdivided",
      });
    } else if (!details.length) {
      for (const key of deltaKeys(row, kind)) unique.add(key);
      if (kind === "textDelta") {
        for (const item of textDeltaItems(row)) unique.add(textDeltaKey(item));
      }
    }
  }

  return {
    total,
    unique: unique.size,
    detailTotal,
    detailsAvailable: detailTotal > 0,
    countOnlyTotal,
    countOnlyRows,
    byDisposition: stripInternalSets(groups),
    note: kind === "compiledOnly" && total > 0 && detailTotal === 0
      ? "compiledOnly counts are present, but audit rows did not include compiledOnlyDetails; cannot subdivide dispositions"
      : null,
  };
}

function latestSuccessfulAutoRefresh(rows) {
  const candidates = rows.filter((row) => row?.status === "completed" && (row?.ok === true || row?.result?.ok === true));
  return latestRow(candidates);
}

function coverageSummary(value) {
  const root = isObject(value) ? value : {};
  const summary = isObject(root.summary) ? root.summary : root;
  return {
    coverageRatio: numberAt(summary.coverageRatio, summary.coverage_ratio, root.coverageRatio, root.coverage_ratio) ?? null,
    injectableCoverageRatio: numberAt(summary.injectableCoverageRatio, summary.injectable_coverage_ratio, root.injectableCoverageRatio, root.injectable_coverage_ratio) ?? null,
    queuedEvents: numberAt(summary.queuedEvents, summary.queued, root.queuedEvents, root.queued) ?? null,
    staleEvents: numberAt(summary.staleEvents, summary.stale, root.staleEvents, root.stale) ?? null,
    deferredMergedSourceEvents: numberAt(summary.deferredMergedSourceEvents, summary.deferredMergedSource, root.deferredMergedSourceEvents, root.deferredMergedSource) ?? null,
    totalEvents: numberAt(summary.totalEvents, summary.total, root.totalEvents, root.total) ?? null,
    projectedEvents: numberAt(summary.projectedEvents, summary.projected, root.projectedEvents, root.projected) ?? null,
  };
}

function latestContext(latestDir) {
  const eventCoverage = readJson(path.join(latestDir, "event-coverage.json"));
  const verifier = readJson(path.join(latestDir, "merged-source-verifier.json"));
  return {
    eventCoverage: eventCoverage.exists && !eventCoverage.error
      ? { exists: true, summary: coverageSummary(eventCoverage.value) }
      : { exists: eventCoverage.exists, error: eventCoverage.error ?? null },
    verifier: verifier.exists && !verifier.error
      ? {
        exists: true,
        summary: verifier.value?.summary ?? null,
        inputRootHash: verifier.value?.inputRootHash ?? null,
        decisionValidationHash: verifier.value?.decisionValidationHash ?? null,
        generator: verifier.value?.generator ?? null,
      }
      : { exists: verifier.exists, error: verifier.error ?? null },
  };
}

function blockingCounts(summary) {
  const out = {};
  for (const [kind, kindSummary] of Object.entries(summary)) {
    for (const [disposition, group] of Object.entries(kindSummary.byDisposition)) {
      if (group.blockingUnique > 0) out[`${kind}:${disposition}`] = group.blockingUnique;
    }
  }
  return out;
}

function buildRecommendedActions(deltaSummary) {
  const actions = [];
  const add = (category, count, action) => {
    if (count > 0) actions.push({ category, count, action });
  };
  const countDisposition = (kind, disposition) => deltaSummary[kind]?.byDisposition?.[disposition]?.blockingUnique ?? 0;
  add("legacyOnly.settings_not_memory", countDisposition("legacyOnly", "settings_not_memory"), "Keep settings-like residuals separate from memory and require explicit retirement authorization before deleting legacy rules.");
  add("legacyOnly.tool_contract_not_memory", countDisposition("legacyOnly", "tool_contract_not_memory"), "Keep tool declaration residuals out of memory retirement and route them through the owning contract/settings surface.");
  add("textDelta.normalization_possible", countDisposition("textDelta", "normalization_possible"), "Review canonicalization candidates and record an explicit disposition before treating them as safe to archive.");
  add("semantic_review_required", countDisposition("legacyOnly", "semantic_review_required") + countDisposition("textDelta", "semantic_review_required") + countDisposition("compiledOnly", "semantic_review_required"), "Send semantic deltas to manual or T0 semantic review; do not retire the legacy source until the review records equivalence or an accepted replacement.");
  add("semantic_mismatch_fix_required", countDisposition("textDelta", "semantic_mismatch_fix_required"), "Fix the compiled output or source mapping before considering retirement.");
  add("unknown", countDisposition("legacyOnly", "unknown") + countDisposition("textDelta", "unknown") + countDisposition("compiledOnly", "unknown") + countDisposition("legacyOnly", "count_only_missing_details") + countDisposition("textDelta", "count_only_missing_details") + countDisposition("compiledOnly", "count_only_missing_details"), "Improve the disposition sidecar or audit detail emission so each residual has an actionable category.");
  const compiledOnlyBlocking = Object.values(deltaSummary.compiledOnly.byDisposition).reduce((sum, group) => {
    return sum + (group.blockingUnique ?? 0);
  }, 0);
  add("compiledOnly", compiledOnlyBlocking, "Confirm whether compiled-only constraints are event-native accepted sources or require backfill/retirement authorization; unresolved compiled-only items block the flip, including humanReviewRequired accepted dispositions.");
  const humanReview = ["legacyOnly", "textDelta", "compiledOnly"].reduce((sum, kind) => {
    return sum + Object.values(deltaSummary[kind].byDisposition).reduce((inner, group) => {
      return inner + (group.humanReviewUnique ?? 0);
    }, 0);
  }, 0);
  add("humanReviewRequired", humanReview, "Prioritize rows marked humanReviewRequired=true; these are explicit blockers.");
  if (!actions.length) actions.push({ category: "empty_delta", count: 0, action: "No legacy retirement blockers were found in the analyzed rows." });
  return actions;
}

const abrainHome = resolveInputPath(arg("abrain", path.join(os.homedir(), ".abrain")));
const windowDays = nonNegativeInteger(arg("window-days", "7"), 7);
const postRefresh = hasFlag("post-refresh");
const latestOnly = hasFlag("latest");
const jsonOutput = hasFlag("json");
const nowMs = Date.now();
const windowCutoffMs = nowMs - (windowDays * 24 * 60 * 60 * 1000);
const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
const sessionStartFile = path.join(shadowRoot, "session-start-dualread", "audit.jsonl");
const autoRefreshFile = path.join(shadowRoot, "auto-refresh", "audit.jsonl");
const latestDir = path.join(shadowRoot, "latest");

const sessionStartAudit = readJsonLines(sessionStartFile);
const autoRefreshAudit = readJsonLines(autoRefreshFile);
const latestAutoRefresh = latestSuccessfulAutoRefresh(autoRefreshAudit.rows);
const latestAutoRefreshMs = latestAutoRefresh ? timestampMs(latestAutoRefresh) : undefined;
const postRefreshCutoffMs = postRefresh && latestAutoRefreshMs !== undefined ? latestAutoRefreshMs : undefined;
const effectiveCutoffMs = Math.max(windowCutoffMs, postRefreshCutoffMs ?? -Infinity);
let analyzedRows = rowsInWindow(sessionStartAudit.rows, windowCutoffMs);
if (postRefreshCutoffMs !== undefined) {
  analyzedRows = analyzedRows.filter((row) => {
    const ms = timestampMs(row);
    return ms !== undefined && ms > postRefreshCutoffMs;
  });
}
if (latestOnly && analyzedRows.length) analyzedRows = [latestRow(analyzedRows)];

const latestAnalyzed = latestRow(analyzedRows);
const deltaSummary = {
  compiledOnly: summarizeKind(analyzedRows, "compiledOnly"),
  legacyOnly: summarizeKind(analyzedRows, "legacyOnly"),
  textDelta: summarizeKind(analyzedRows, "textDelta"),
};
const blockerCounts = blockingCounts(deltaSummary);
const warnings = [];
if (sessionStartAudit.readError) warnings.push(`session-start dual-read audit read error: ${sessionStartAudit.readError}`);
if (sessionStartAudit.parseErrors.length) warnings.push(`session-start dual-read audit parse errors: ${sessionStartAudit.parseErrors.length}`);
if (autoRefreshAudit.readError) warnings.push(`auto-refresh audit read error: ${autoRefreshAudit.readError}`);
if (autoRefreshAudit.parseErrors.length) warnings.push(`auto-refresh audit parse errors: ${autoRefreshAudit.parseErrors.length}`);
if (postRefresh && !latestAutoRefresh) warnings.push("--post-refresh requested but no successful completed auto-refresh row was found; window cutoff was used");

const report = {
  schemaVersion: "constraint-legacy-retirement-dossier/v1",
  generatedAtUtc: new Date(nowMs).toISOString(),
  inputs: {
    abrainHome,
    windowDays,
    postRefresh,
    latestOnly,
    sessionStartFile,
    autoRefreshFile,
  },
  audit: {
    sessionStartDualRead: {
      exists: sessionStartAudit.exists,
      totalRows: sessionStartAudit.rows.length,
      parseErrors: sessionStartAudit.parseErrors,
      readError: sessionStartAudit.readError ?? null,
    },
    autoRefresh: {
      exists: autoRefreshAudit.exists,
      totalRows: autoRefreshAudit.rows.length,
      parseErrors: autoRefreshAudit.parseErrors,
      readError: autoRefreshAudit.readError ?? null,
      latestSuccessful: latestAutoRefresh ? {
        observedAtUtc: latestAutoRefresh.observedAtUtc ?? null,
        ok: latestAutoRefresh.ok === true || latestAutoRefresh.result?.ok === true,
        sourceEventId: latestAutoRefresh.sourceEventId ?? null,
        inputRootHash: latestAutoRefresh.result?.inputRootHash ?? latestAutoRefresh.inputRootHash ?? null,
      } : null,
    },
  },
  selection: {
    windowCutoffUtc: new Date(windowCutoffMs).toISOString(),
    postRefreshCutoffUtc: postRefreshCutoffMs !== undefined ? new Date(postRefreshCutoffMs).toISOString() : null,
    effectiveCutoffUtc: new Date(effectiveCutoffMs).toISOString(),
    rowsAnalyzed: analyzedRows.length,
    status: countBy(analyzedRows, "status"),
    latest: latestAnalyzed ? {
      observedAtUtc: latestAnalyzed.observedAtUtc ?? null,
      cwd: latestAnalyzed.cwd ?? null,
      activeProjectId: latestAnalyzed.activeProjectId ?? null,
      inputRootHash: latestAnalyzed.inputRootHash ?? null,
      validationHash: latestAnalyzed.validationHash ?? null,
      status: latestAnalyzed.status ?? null,
    } : null,
  },
  latestContext: latestContext(latestDir),
  deltas: deltaSummary,
  retirementGate: {
    ready: Object.keys(blockerCounts).length === 0,
    readyReason: Object.keys(blockerCounts).length === 0
      ? "all analyzed compiledOnly/legacyOnly/textDelta rows are empty or explicitly archival"
      : "one or more compiledOnly/legacyOnly/textDelta blockers lack archival authorization or require review",
    blockingCounts: blockerCounts,
    policy: {
      semanticReviewRequiredBlocks: true,
      unknownBlocks: true,
      humanReviewRequiredBlocks: true,
      settingsNotMemoryBlocksWithoutExplicitAuthorization: true,
      scriptAuthorizesRetirement: false,
    },
  },
  recommendedActions: buildRecommendedActions(deltaSummary),
  warnings,
};

function renderDispositionGroups(groups) {
  const lines = [];
  const entries = Object.entries(groups);
  if (!entries.length) return ["  none"];
  for (const [disposition, group] of entries) {
    lines.push(`  ${disposition}: total=${group.total} unique=${group.unique} blockingUnique=${group.blockingUnique} blockingObservations=${group.blocking} humanReviewUnique=${group.humanReviewUnique}`);
    for (const sample of group.samples.slice(0, 3)) {
      const id = sample.id ?? sample.legacyId ?? sample.constraintId ?? sample.observedAtUtc ?? "unknown";
      const review = sample.humanReviewRequired === true ? " humanReviewRequired=true" : "";
      const reason = sample.reason ? ` reason=${sample.reason}` : "";
      lines.push(`    - ${id}${review}${reason}`);
    }
    if (group.samples.length > 3) lines.push(`    ... ${group.samples.length - 3} more sample(s) omitted from human summary`);
  }
  return lines;
}

function renderHuman(value) {
  const lines = [];
  lines.push("ADR0039 Constraint legacy retirement blocker dossier");
  lines.push(`retirementGate.ready: ${value.retirementGate.ready}`);
  lines.push(`abrain: ${value.inputs.abrainHome}`);
  lines.push(`windowDays: ${value.inputs.windowDays}  postRefresh: ${value.inputs.postRefresh}  latestOnly: ${value.inputs.latestOnly}`);
  lines.push(`rowsAnalyzed: ${value.selection.rowsAnalyzed}  status: ${JSON.stringify(value.selection.status)}`);
  lines.push(`latest: ${value.selection.latest ? `${value.selection.latest.observedAtUtc} cwd=${value.selection.latest.cwd ?? "missing"} activeProjectId=${value.selection.latest.activeProjectId ?? "missing"}` : "none"}`);
  lines.push(`latest hashes: inputRootHash=${value.selection.latest?.inputRootHash ?? "missing"} validationHash=${value.selection.latest?.validationHash ?? "missing"}`);
  lines.push("");
  lines.push("delta totals:");
  lines.push(`  compiledOnly: total=${value.deltas.compiledOnly.total} unique=${value.deltas.compiledOnly.unique} detailTotal=${value.deltas.compiledOnly.detailTotal}`);
  lines.push(`  legacyOnly: total=${value.deltas.legacyOnly.total} unique=${value.deltas.legacyOnly.unique} detailTotal=${value.deltas.legacyOnly.detailTotal}`);
  lines.push(`  textDelta: total=${value.deltas.textDelta.total} unique=${value.deltas.textDelta.unique} detailTotal=${value.deltas.textDelta.detailTotal}`);
  if (value.deltas.compiledOnly.note) lines.push(`  compiledOnly note: ${value.deltas.compiledOnly.note}`);
  lines.push("");
  lines.push("legacyOnlyDetails by disposition:");
  lines.push(...renderDispositionGroups(value.deltas.legacyOnly.byDisposition));
  lines.push("");
  lines.push("textDeltaDispositions by disposition:");
  lines.push(...renderDispositionGroups(value.deltas.textDelta.byDisposition));
  lines.push("");
  lines.push("compiledOnlyDetails by disposition:");
  lines.push(...renderDispositionGroups(value.deltas.compiledOnly.byDisposition));
  lines.push("");
  lines.push("retirement blockers:");
  const blockers = Object.entries(value.retirementGate.blockingCounts);
  if (blockers.length) {
    for (const [key, count] of blockers) lines.push(`  - ${key}: ${count}`);
  } else {
    lines.push("  none");
  }
  lines.push("");
  lines.push("recommendedActions:");
  for (const item of value.recommendedActions) lines.push(`  - ${item.category} (${item.count}): ${item.action}`);
  if (value.warnings.length) {
    lines.push("", "warnings:");
    for (const warning of value.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else console.log(renderHuman(report));
process.exit(0);
