#!/usr/bin/env node
/**
 * ADR0039 Constraint runtime gate dossier.
 *
 * Read-only report over the compiled-view runtime gate evidence. This script
 * reads ~/.abrain by default and never writes canonical memory or settings.
 *
 * Usage:
 *   node scripts/dossier-constraint-runtime-gate.mjs [--abrain ~/.abrain]
 *     [--settings ../../pi-astack-settings.json] [--min-session-starts 20]
 *     [--window-days 7] [--json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function resolveInputPath(value, baseDir = process.cwd()) {
  return path.resolve(baseDir, expandHome(value));
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
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
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

function coverageSummaryFrom(value) {
  const root = isObject(value) ? value : {};
  const summary = isObject(root.summary) ? root.summary : root;
  return {
    coverageRatio: numberAt(summary.coverageRatio, summary.coverage_ratio, root.coverageRatio, root.coverage_ratio),
    injectableCoverageRatio: numberAt(summary.injectableCoverageRatio, summary.injectable_coverage_ratio, root.injectableCoverageRatio, root.injectable_coverage_ratio),
    queued: numberAt(summary.queuedEvents, summary.queued, root.queuedEvents, root.queued),
    stale: numberAt(summary.staleEvents, summary.stale, root.staleEvents, root.stale),
    deferredMergedSource: numberAt(summary.deferredMergedSourceEvents, summary.deferredMergedSource, root.deferredMergedSourceEvents, root.deferredMergedSource),
    deferredUnresolved: numberAt(summary.deferredUnresolvedEvents, summary.deferredUnresolved, root.deferredUnresolvedEvents, root.deferredUnresolved),
    appendFailed: numberAt(summary.appendFailedEvents, summary.appendFailed, root.appendFailedEvents, root.appendFailed),
    totalEvents: numberAt(summary.totalEvents, summary.total),
    projectedEvents: numberAt(summary.projectedEvents, summary.projected),
  };
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) {
    const key = String(row?.[field] ?? "<missing>");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function sumDualReadCount(row, key) {
  const summaryValue = numberAt(row?.summary?.[key]);
  if (summaryValue !== undefined) return summaryValue;
  const delta = row?.delta?.[key];
  if (Array.isArray(delta)) return delta.length;
  return 0;
}

function dualReadCoverage(row) {
  const eventCoverage = isObject(row?.eventCoverage) ? row.eventCoverage : {};
  const eventSummary = coverageSummaryFrom(eventCoverage);
  return {
    coverageRatio: numberAt(row?.coverageRatio, eventSummary.coverageRatio),
    injectableCoverageRatio: numberAt(row?.injectableCoverageRatio, eventSummary.injectableCoverageRatio, eventSummary.coverageRatio),
  };
}

function latestCompletedAutoRefresh(rows) {
  const completed = rows.filter((row) => row?.status === "completed");
  return completed.length ? completed[completed.length - 1] : undefined;
}

function autoRefreshSummary(rows, cutoffMs) {
  const completedRows = rows.filter((row) => row?.status === "completed");
  const completedWindowRows = rowsInWindow(completedRows, cutoffMs);
  const latestCompleted = latestCompletedAutoRefresh(rows);
  const latestCoverage = latestCompleted?.result?.eventCoverage ?? latestCompleted?.eventCoverage;
  return {
    rows: rows.length,
    completedRows: completedRows.length,
    completedRowsInWindow: completedWindowRows.length,
    latestCompleted: latestCompleted ? {
      observedAtUtc: latestCompleted.observedAtUtc ?? null,
      ok: latestCompleted.ok === true,
      sourceEventId: latestCompleted.sourceEventId ?? null,
      durationMs: numberAt(latestCompleted.durationMs) ?? null,
      coverage: coverageSummaryFrom(latestCoverage),
    } : null,
  };
}

function verifierSummary(verifierRead, decisionRead) {
  if (!verifierRead.exists || verifierRead.error) {
    return {
      exists: verifierRead.exists,
      error: verifierRead.error,
      bindingMatchesDecision: false,
      summary: null,
      generator: null,
      binding: null,
    };
  }
  const verifier = isObject(verifierRead.value) ? verifierRead.value : {};
  const decision = isObject(decisionRead.value) ? decisionRead.value : {};
  const inputRootHashMatches = verifier.inputRootHash === decision.inputRootHash;
  const decisionValidationHashMatches = verifier.decisionValidationHash === decision.validationHash;
  return {
    exists: true,
    error: null,
    summary: verifier.summary ?? null,
    generator: verifier.generator ? { modelRef: verifier.generator.modelRef ?? null } : null,
    binding: {
      verifierInputRootHash: verifier.inputRootHash ?? null,
      decisionInputRootHash: decision.inputRootHash ?? null,
      verifierDecisionValidationHash: verifier.decisionValidationHash ?? null,
      decisionValidationHash: decision.validationHash ?? null,
      inputRootHashMatches,
      decisionValidationHashMatches,
    },
    bindingMatchesDecision: inputRootHashMatches && decisionValidationHashMatches,
  };
}

function sessionStartSummary(rows, cutoffMs, minCoverageRatio) {
  const windowRows = rowsInWindow(rows, cutoffMs);
  const staleRows = windowRows.filter((row) => row?.stale === true);
  const coverageBadRows = [];
  let legacyOnlyRows = 0;
  let textDeltaRows = 0;
  let legacyOnlyTotal = 0;
  let textDeltaTotal = 0;
  for (const row of windowRows) {
    const coverage = dualReadCoverage(row);
    const coverageRatio = coverage.coverageRatio;
    const injectableCoverageRatio = coverage.injectableCoverageRatio;
    const badCoverage = coverageRatio === undefined || coverageRatio < minCoverageRatio;
    const badInjectable = injectableCoverageRatio === undefined || injectableCoverageRatio < minCoverageRatio;
    if (badCoverage || badInjectable) {
      coverageBadRows.push({ observedAtUtc: row?.observedAtUtc ?? null, status: row?.status ?? null, coverageRatio: coverageRatio ?? null, injectableCoverageRatio: injectableCoverageRatio ?? null });
    }
    const legacyOnly = sumDualReadCount(row, "legacyOnly");
    const textDelta = sumDualReadCount(row, "textDelta");
    if (legacyOnly > 0) legacyOnlyRows += 1;
    if (textDelta > 0) textDeltaRows += 1;
    legacyOnlyTotal += legacyOnly;
    textDeltaTotal += textDelta;
  }
  return {
    totalRows: rows.length,
    rows: windowRows.length,
    status: countBy(windowRows, "status"),
    staleRows: staleRows.length,
    coverageBadRows: coverageBadRows.length,
    coverageBadSamples: coverageBadRows.slice(-5),
    deltaRows: windowRows.filter((row) => row?.status === "delta").length,
    legacyOnlyRows,
    legacyOnlyTotal,
    textDeltaRows,
    textDeltaTotal,
  };
}

function liveCanarySummary(rows) {
  return {
    rows: rows.length,
    decisions: countBy(rows, "decision"),
    compiledInjected: rows.filter((row) => row?.decision === "compiled_injected").length,
    failClosedDrop: rows.filter((row) => row?.decision === "fail_closed_drop").length,
  };
}

const abrainHome = resolveInputPath(arg("abrain", path.join(os.homedir(), ".abrain")));
const settingsPath = resolveInputPath(arg("settings", path.join("..", "..", "pi-astack-settings.json")), repoRoot);
const minSessionStarts = nonNegativeInteger(arg("min-session-starts", "20"), 20);
const windowDays = nonNegativeInteger(arg("window-days", "7"), 7);
const jsonOutput = hasFlag("json");
const nowMs = Date.now();
const cutoffMs = nowMs - (windowDays * 24 * 60 * 60 * 1000);
const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
const latestDir = path.join(shadowRoot, "latest");

const settingsRead = readJson(settingsPath);
const settings = isObject(settingsRead.value) ? settingsRead.value : {};
const compiledViewInjection = isObject(settings.ruleInjector?.compiledViewInjection) ? settings.ruleInjector.compiledViewInjection : {};
const configuredMinCoverageRatio = numberAt(compiledViewInjection.minCoverageRatio) ?? 1;
const minCoverageRatio = configuredMinCoverageRatio;

const decisionRead = readJson(path.join(latestDir, "decision.json"));
const coverageRead = readJson(path.join(latestDir, "event-coverage.json"));
const verifierRead = readJson(path.join(latestDir, "merged-source-verifier.json"));
const autoRefreshAudit = readJsonLines(path.join(shadowRoot, "auto-refresh", "audit.jsonl"));
const sessionStartAudit = readJsonLines(path.join(shadowRoot, "session-start-dualread", "audit.jsonl"));
const liveCanaryAudit = readJsonLines(path.join(shadowRoot, "session-live-canary", "audit.jsonl"));

const coverage = coverageRead.exists && !coverageRead.error ? coverageSummaryFrom(coverageRead.value) : null;
const verifier = verifierSummary(verifierRead, decisionRead);
const autoRefresh = autoRefreshSummary(autoRefreshAudit.rows, cutoffMs);
const sessionStart = sessionStartSummary(sessionStartAudit.rows, cutoffMs, minCoverageRatio);
const latestAutoRefreshCompletedMs = autoRefresh.latestCompleted?.observedAtUtc
  ? Date.parse(autoRefresh.latestCompleted.observedAtUtc)
  : undefined;
const latestSuccessfulArtifactMs = decisionRead.exists && !decisionRead.error ? decisionRead.mtimeMs : undefined;
const sessionStartPostRefreshCutoffMs = Math.max(
  cutoffMs,
  Number.isFinite(latestAutoRefreshCompletedMs) ? latestAutoRefreshCompletedMs : cutoffMs,
  Number.isFinite(latestSuccessfulArtifactMs) ? latestSuccessfulArtifactMs : cutoffMs,
);
const sessionStartPostRefresh = sessionStartSummary(sessionStartAudit.rows, sessionStartPostRefreshCutoffMs, minCoverageRatio);
const liveCanary = liveCanarySummary(liveCanaryAudit.rows);

const hardFailures = [];
const warnings = [];

if (settingsRead.error) hardFailures.push(`settings unreadable: ${settingsRead.error}`);
if (compiledViewInjection.enabled !== true) hardFailures.push("ruleInjector.compiledViewInjection.enabled is not true");
if (!coverageRead.exists || coverageRead.error || !coverage) {
  hardFailures.push(coverageRead.error ? `latest event-coverage.json unreadable: ${coverageRead.error}` : "latest event-coverage.json is missing");
} else {
  if (coverage.coverageRatio === undefined || coverage.coverageRatio < minCoverageRatio) hardFailures.push(`coverageRatio below minCoverageRatio (${coverage.coverageRatio ?? "missing"} < ${minCoverageRatio})`);
  if (coverage.injectableCoverageRatio === undefined || coverage.injectableCoverageRatio < minCoverageRatio) hardFailures.push(`injectableCoverageRatio below minCoverageRatio (${coverage.injectableCoverageRatio ?? "missing"} < ${minCoverageRatio})`);
  for (const [name, value] of [
    ["queued", coverage.queued],
    ["stale", coverage.stale],
    ["appendFailed", coverage.appendFailed],
    ["deferredMergedSource", coverage.deferredMergedSource],
    ["deferredUnresolved", coverage.deferredUnresolved],
  ]) {
    if ((value ?? 0) > 0) hardFailures.push(`event coverage ${name} is non-zero (${value})`);
  }
}

if (!verifier.exists || verifier.error) hardFailures.push(verifier.error ? `merged-source-verifier.json unreadable: ${verifier.error}` : "merged-source-verifier.json is missing");
else if (!verifier.bindingMatchesDecision) hardFailures.push("merged-source-verifier binding does not match latest decision.json");

if (!autoRefresh.latestCompleted) hardFailures.push("auto-refresh has no completed row");
else if (autoRefresh.latestCompleted.ok !== true) hardFailures.push("latest auto-refresh completed row is not ok=true");

if (sessionStartPostRefresh.rows > 0 && sessionStartPostRefresh.staleRows > 0) hardFailures.push(`post-refresh session-start dual-read has stale rows (${sessionStartPostRefresh.staleRows})`);
if (sessionStartPostRefresh.rows > 0 && sessionStartPostRefresh.coverageBadRows > 0) hardFailures.push(`post-refresh session-start dual-read has coverage-bad rows (${sessionStartPostRefresh.coverageBadRows})`);

if (sessionStart.staleRows > 0) warnings.push(`historical session-start dual-read stale rows remain in --window-days (${sessionStart.staleRows})`);
if (sessionStart.coverageBadRows > 0) warnings.push(`historical session-start dual-read coverage-bad rows remain in --window-days (${sessionStart.coverageBadRows})`);
if (sessionStartPostRefresh.rows < minSessionStarts) warnings.push(`post-refresh session-start dual-read rows below --min-session-starts (${sessionStartPostRefresh.rows} < ${minSessionStarts})`);
if (!liveCanaryAudit.exists || liveCanary.rows === 0) warnings.push("session-live-canary has no data");
if (sessionStart.deltaRows > 0) warnings.push(`session-start dual-read status=delta rows present (${sessionStart.deltaRows})`);
if (sessionStart.legacyOnlyTotal > 0 || sessionStart.textDeltaTotal > 0) warnings.push(`legacy retirement blockers remain: legacyOnly=${sessionStart.legacyOnlyTotal} textDelta=${sessionStart.textDeltaTotal}`);
for (const audit of [autoRefreshAudit, sessionStartAudit, liveCanaryAudit]) {
  if (audit.readError) warnings.push(`${path.relative(abrainHome, audit.file)} read error: ${audit.readError}`);
  if (audit.parseErrors.length) warnings.push(`${path.relative(abrainHome, audit.file)} parse errors: ${audit.parseErrors.length}`);
}

const report = {
  schemaVersion: "constraint-runtime-gate-dossier/v1",
  generatedAtUtc: new Date(nowMs).toISOString(),
  inputs: {
    abrainHome,
    settingsPath,
    minSessionStarts,
    windowDays,
    minCoverageRatio,
  },
  settings: {
    compiledViewInjection: {
      enabled: compiledViewInjection.enabled ?? null,
      fallbackToLegacyOnError: compiledViewInjection.fallbackToLegacyOnError ?? null,
      requireFresh: compiledViewInjection.requireFresh ?? null,
      minCoverageRatio: compiledViewInjection.minCoverageRatio ?? null,
    },
  },
  latest: {
    latestDir,
    coverage: coverage ? { exists: true, ...coverage } : { exists: false, error: coverageRead.error ?? null },
    verifier,
  },
  autoRefresh,
  sessionStartDualRead: sessionStart,
  sessionStartDualReadPostRefresh: {
    cutoffUtc: new Date(sessionStartPostRefreshCutoffMs).toISOString(),
    ...sessionStartPostRefresh,
  },
  sessionLiveCanary: liveCanary,
  gate: {
    pass: hardFailures.length === 0,
    hardFail: hardFailures.length > 0,
    hardFailures,
    warnings,
  },
};

function renderHuman(value) {
  const lines = [];
  lines.push("ADR0039 Constraint runtime gate dossier");
  lines.push(`gate: ${value.gate.pass ? "PASS" : "FAIL"}`);
  lines.push(`abrain: ${value.inputs.abrainHome}`);
  lines.push(`settings: ${value.inputs.settingsPath}`);
  lines.push(`windowDays: ${value.inputs.windowDays}  minSessionStarts: ${value.inputs.minSessionStarts}  minCoverageRatio: ${value.inputs.minCoverageRatio}`);
  lines.push("");
  lines.push("compiledViewInjection:");
  lines.push(`  enabled=${value.settings.compiledViewInjection.enabled} fallbackToLegacyOnError=${value.settings.compiledViewInjection.fallbackToLegacyOnError} requireFresh=${value.settings.compiledViewInjection.requireFresh} minCoverageRatio=${value.settings.compiledViewInjection.minCoverageRatio}`);
  lines.push("");
  lines.push("latest event coverage:");
  lines.push(`  coverageRatio=${value.latest.coverage.coverageRatio ?? "missing"} injectableCoverageRatio=${value.latest.coverage.injectableCoverageRatio ?? "missing"}`);
  lines.push(`  queued=${value.latest.coverage.queued ?? "missing"} stale=${value.latest.coverage.stale ?? "missing"} appendFailed=${value.latest.coverage.appendFailed ?? "missing"} deferredMergedSource=${value.latest.coverage.deferredMergedSource ?? "missing"} deferredUnresolved=${value.latest.coverage.deferredUnresolved ?? "missing"}`);
  lines.push("");
  lines.push("merged-source verifier:");
  lines.push(`  exists=${value.latest.verifier.exists} bindingMatchesDecision=${value.latest.verifier.bindingMatchesDecision} modelRef=${value.latest.verifier.generator?.modelRef ?? "missing"}`);
  lines.push(`  summary=${JSON.stringify(value.latest.verifier.summary ?? null)}`);
  lines.push("");
  lines.push("auto-refresh:");
  lines.push(`  rows=${value.autoRefresh.rows} completed=${value.autoRefresh.completedRows} completedInWindow=${value.autoRefresh.completedRowsInWindow}`);
  lines.push(`  latestCompleted.ok=${value.autoRefresh.latestCompleted?.ok ?? "missing"} sourceEventId=${value.autoRefresh.latestCompleted?.sourceEventId ?? "missing"} durationMs=${value.autoRefresh.latestCompleted?.durationMs ?? "missing"}`);
  lines.push(`  latestCompleted.coverage=${JSON.stringify(value.autoRefresh.latestCompleted?.coverage ?? null)}`);
  lines.push("");
  lines.push("session-start dual-read:");
  lines.push(`  rowsInWindow=${value.sessionStartDualRead.rows} status=${JSON.stringify(value.sessionStartDualRead.status)}`);
  lines.push(`  staleRows=${value.sessionStartDualRead.staleRows} coverageBadRows=${value.sessionStartDualRead.coverageBadRows} legacyOnly=${value.sessionStartDualRead.legacyOnlyTotal} textDelta=${value.sessionStartDualRead.textDeltaTotal}`);
  lines.push(`  postRefreshCutoff=${value.sessionStartDualReadPostRefresh.cutoffUtc}`);
  lines.push(`  postRefreshRows=${value.sessionStartDualReadPostRefresh.rows} postRefreshStaleRows=${value.sessionStartDualReadPostRefresh.staleRows} postRefreshCoverageBadRows=${value.sessionStartDualReadPostRefresh.coverageBadRows}`);
  lines.push("");
  lines.push("session-live-canary:");
  lines.push(`  rows=${value.sessionLiveCanary.rows} compiled_injected=${value.sessionLiveCanary.compiledInjected} fail_closed_drop=${value.sessionLiveCanary.failClosedDrop}`);
  if (value.gate.hardFailures.length) {
    lines.push("", "hard failures:");
    for (const item of value.gate.hardFailures) lines.push(`  - ${item}`);
  }
  if (value.gate.warnings.length) {
    lines.push("", "warnings:");
    for (const item of value.gate.warnings) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else console.log(renderHuman(report));

process.exit(report.gate.hardFailures.length ? 1 : 0);
