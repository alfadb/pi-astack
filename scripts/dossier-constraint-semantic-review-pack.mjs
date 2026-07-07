#!/usr/bin/env node
/**
 * ADR0039 Constraint semantic review pack dossier.
 *
 * Read-only report over session-start dual-read blockers that need semantic
 * review. It exports paired legacy/compiled text for manual review and never
 * authorizes retirement or writes sidecars/runtime state.
 *
 * Usage:
 *   node scripts/dossier-constraint-semantic-review-pack.mjs [--abrain ~/.abrain]
 *     [--window-days 7] [--post-refresh] [--latest]
 *     [--include-normalization] [--json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RESOLUTION_CANDIDATES = [
  "semantic_equivalent",
  "semantic_mismatch_fix_required",
  "semantic_review_required",
  "normalization_possible",
  "settings_not_memory",
  "unknown",
];
const DEFAULT_TEXT_DELTA_DISPOSITIONS = new Set(["semantic_review_required"]);
const NORMALIZATION_DISPOSITION = "normalization_possible";

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringAt(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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
  const candidates = rows.filter((row) => row?.status === "completed" && (row?.ok === true || row?.result?.ok === true));
  return latestRow(candidates);
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) {
    const key = String(row?.[field] ?? "<missing>");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function splitMarkdown(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return match ? { frontmatterText: match[1], body: match[2] } : { frontmatterText: "", body: raw };
}

function unquoteYamlScalar(value) {
  const trimmed = String(value ?? "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = unquoteYamlScalar(match[2]);
  }
  return out;
}

function normalizeBareSlug(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function trailingHyphenTolerant(value) {
  return String(value ?? "").replace(/-+$/g, "");
}

function tolerantEqual(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return trailingHyphenTolerant(left) === trailingHyphenTolerant(right);
}

function sourceParts(sourceRecordId) {
  const parts = String(sourceRecordId ?? "").split(":");
  if (parts[0] !== "rule") return null;
  if (parts[1] === "global" && (parts[2] === "always" || parts[2] === "listed") && parts.length >= 4) {
    return { scope: "global", injectMode: parts[2], slug: parts.slice(3).join(":") };
  }
  if (parts[1] === "project" && parts[2] && (parts[3] === "always" || parts[3] === "listed") && parts.length >= 5) {
    return { scope: "project", projectId: parts[2], injectMode: parts[3], slug: parts.slice(4).join(":") };
  }
  return null;
}

function ruleSourceId(scope, injectMode, slug, projectId) {
  return scope === "project" ? `rule:project:${projectId}:${injectMode}:${slug}` : `rule:global:${injectMode}:${slug}`;
}

function ruleDir(abrainHome, parts) {
  if (!parts) return null;
  if (parts.scope === "project") return path.join(abrainHome, "projects", parts.projectId, "rules", parts.injectMode);
  return path.join(abrainHome, "rules", parts.injectMode);
}

function listMarkdownFiles(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function allRuleFiles(abrainHome) {
  const files = [];
  for (const injectMode of ["always", "listed"]) {
    files.push(...listMarkdownFiles(path.join(abrainHome, "rules", injectMode)));
  }
  const projectsDir = path.join(abrainHome, "projects");
  try {
    if (fs.existsSync(projectsDir)) {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const injectMode of ["always", "listed"]) {
          files.push(...listMarkdownFiles(path.join(projectsDir, entry.name, "rules", injectMode)));
        }
      }
    }
  } catch {
    return files.sort();
  }
  return files.sort();
}

function inferRuleLocation(abrainHome, file) {
  const rel = path.relative(abrainHome, file).split(path.sep);
  if (rel[0] === "rules" && (rel[1] === "always" || rel[1] === "listed")) {
    return { scope: "global", injectMode: rel[1] };
  }
  if (rel[0] === "projects" && rel[1] && rel[2] === "rules" && (rel[3] === "always" || rel[3] === "listed")) {
    return { scope: "project", projectId: rel[1], injectMode: rel[3] };
  }
  return { scope: "unknown", injectMode: "unknown" };
}

function readLegacyRule(abrainHome, file, matchMethod, requestedSourceRecordId) {
  const raw = fs.readFileSync(file, "utf8");
  const { frontmatterText, body } = splitMarkdown(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const loc = inferRuleLocation(abrainHome, file);
  const fileSlug = normalizeBareSlug(path.basename(file, ".md"));
  const fmId = stringAt(frontmatter.id);
  const idSlug = fmId ? fmId.split(":").pop() : undefined;
  const slug = normalizeBareSlug(idSlug || fileSlug);
  const sourceId = loc.scope === "unknown" ? requestedSourceRecordId : ruleSourceId(loc.scope, loc.injectMode, slug, loc.projectId);
  const confidenceRaw = stringAt(frontmatter.confidence);
  const confidenceNumber = confidenceRaw !== undefined && Number.isFinite(Number(confidenceRaw)) ? Number(confidenceRaw) : null;
  return {
    sourceRecordId: requestedSourceRecordId,
    matchedSourceId: sourceId,
    matchMethod,
    file: path.resolve(file),
    frontmatter: {
      id: fmId ?? null,
      title: stringAt(frontmatter.title) ?? null,
      status: stringAt(frontmatter.status) ?? null,
      kind: stringAt(frontmatter.kind, frontmatter.type) ?? null,
      confidence: confidenceNumber ?? confidenceRaw ?? null,
      injectMode: stringAt(frontmatter.inject_mode, frontmatter.tier) ?? loc.injectMode ?? null,
    },
    body,
  };
}

function candidateFilesForSource(abrainHome, sourceRecordId) {
  const parts = sourceParts(sourceRecordId);
  const dir = ruleDir(abrainHome, parts);
  if (!parts || !dir) return [];
  const rawSlug = parts.slug;
  const normalized = normalizeBareSlug(rawSlug);
  const tolerant = trailingHyphenTolerant(normalized);
  const names = [...new Set([
    rawSlug,
    normalized,
    tolerant,
    `${tolerant}-`,
  ].filter(Boolean).map((slug) => `${slug}.md`))];
  return names.map((name) => path.join(dir, name));
}

function findLegacyRule(abrainHome, sourceRecordId) {
  for (const file of candidateFilesForSource(abrainHome, sourceRecordId)) {
    if (!fs.existsSync(file)) continue;
    const rawFileSlug = path.basename(file, ".md");
    const rawRequestedSlug = sourceParts(sourceRecordId)?.slug ?? "";
    const method = rawFileSlug === rawRequestedSlug ? "path_slug_exact" : "path_slug_trailing_hyphen_tolerant";
    return readLegacyRule(abrainHome, file, method, sourceRecordId);
  }

  const parts = sourceParts(sourceRecordId);
  const scanFiles = parts ? listMarkdownFiles(ruleDir(abrainHome, parts)) : allRuleFiles(abrainHome);
  for (const file of scanFiles) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const { frontmatterText } = splitMarkdown(raw);
      const fm = parseFrontmatter(frontmatterText);
      const fmId = stringAt(fm.id);
      if (fmId && tolerantEqual(fmId, sourceRecordId)) {
        return readLegacyRule(abrainHome, file, fmId === sourceRecordId ? "frontmatter_id_exact" : "frontmatter_id_trailing_hyphen_tolerant", sourceRecordId);
      }
      const loc = inferRuleLocation(abrainHome, file);
      const fileSource = loc.scope === "unknown" ? null : ruleSourceId(loc.scope, loc.injectMode, normalizeBareSlug(path.basename(file, ".md")), loc.projectId);
      if (fileSource && tolerantEqual(fileSource, sourceRecordId)) {
        return readLegacyRule(abrainHome, file, fileSource === sourceRecordId ? "scan_source_id_exact" : "scan_source_id_trailing_hyphen_tolerant", sourceRecordId);
      }
    } catch {
      // Keep the dossier read-only and best-effort; warnings are emitted by caller.
    }
  }
  return {
    sourceRecordId,
    matchedSourceId: null,
    matchMethod: "not_found",
    file: null,
    frontmatter: { id: null, title: null, status: null, kind: null, confidence: null, injectMode: null },
    body: null,
  };
}

function dispositionOf(detail, fallback = "unknown") {
  return stringAt(detail?.machineDisposition, detail?.disposition, detail?.retirementDisposition, fallback) ?? fallback;
}

function sourceRecordIdOf(detail) {
  return stringAt(detail?.sourceRecordId, detail?.legacyId, detail?.id, detail?.key, detail?.sourceKey) ?? null;
}

function targetIdOf(detail) {
  return stringAt(detail?.targetId, detail?.constraintId, detail?.shadowId, detail?.compiledId) ?? null;
}

function idOfConstraint(constraint) {
  return stringAt(constraint?.id, constraint?.constraintId, constraint?.targetId, constraint?.shadowId) ?? null;
}

function arrayIncludesString(value, item) {
  return Array.isArray(value) && typeof item === "string" && value.includes(item);
}

function findCompiledConstraint(decision, detail) {
  const constraints = asArray(decision?.constraints);
  const sourceRecordId = sourceRecordIdOf(detail);
  const targetId = targetIdOf(detail);
  if (targetId) {
    const byTarget = constraints.find((constraint) => [constraint?.id, constraint?.constraintId, constraint?.targetId, constraint?.shadowId].some((value) => value === targetId));
    if (byTarget) return byTarget;
  }
  if (sourceRecordId) {
    const bySource = constraints.find((constraint) => arrayIncludesString(constraint?.sourceRecordIds, sourceRecordId));
    if (bySource) return bySource;
  }
  return null;
}

function compiledSummary(constraint, fallbackTargetId = null) {
  if (!constraint) return null;
  return {
    id: idOfConstraint(constraint) ?? fallbackTargetId,
    title: stringAt(constraint.title) ?? null,
    mustDoSummary: stringAt(constraint.mustDoSummary, constraint.must_do_summary, constraint.mustDo) ?? null,
    appliesWhen: stringAt(constraint.appliesWhen, constraint.applies_when) ?? null,
    compiledBody: stringAt(constraint.compiledBody, constraint.body, constraint.text) ?? null,
    scope: constraint.scope ?? null,
    injectMode: stringAt(constraint.injectMode, constraint.inject_mode) ?? null,
    sourceRecordIds: asArray(constraint.sourceRecordIds).filter((item) => typeof item === "string"),
  };
}

function itemSourceIds(item) {
  return asArray(item?.sourceRecordIds).filter((value) => typeof value === "string");
}

function diagnosticsForSource(decision, sourceRecordId, diagnosticIds = []) {
  const wantedIds = new Set(diagnosticIds.filter(Boolean));
  return asArray(decision?.diagnostics)
    .filter((diagnostic) => {
      const id = stringAt(diagnostic?.id, diagnostic?.code);
      return (sourceRecordId && itemSourceIds(diagnostic).includes(sourceRecordId)) || (id && wantedIds.has(id));
    })
    .map((diagnostic) => ({
      id: stringAt(diagnostic.id, diagnostic.code) ?? null,
      code: stringAt(diagnostic.code) ?? null,
      category: stringAt(diagnostic.category) ?? null,
      message: stringAt(diagnostic.message) ?? null,
      sourceRecordIds: itemSourceIds(diagnostic),
    }));
}

function decisionContextForSource(decision, sourceRecordId) {
  return {
    unresolved: asArray(decision?.unresolved).filter((item) => itemSourceIds(item).includes(sourceRecordId)),
    exclusions: asArray(decision?.exclusions).filter((item) => itemSourceIds(item).includes(sourceRecordId)),
    mappings: asArray(decision?.mappings).filter((item) => item?.sourceRecordId === sourceRecordId || itemSourceIds(item).includes(sourceRecordId)),
    diagnostics: diagnosticsForSource(decision, sourceRecordId),
  };
}

function diagnosticIdsFrom(detail) {
  const ids = [];
  for (const value of [detail?.diagnosticId, detail?.diagnosticCode, detail?.diagnostic]) {
    if (typeof value === "string" && value.trim()) ids.push(value.trim());
  }
  for (const value of [detail?.diagnosticIds, detail?.diagnosticCodes]) {
    if (Array.isArray(value)) ids.push(...value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()));
  }
  return [...new Set(ids)];
}

function textDeltaDetails(row) {
  return asArray(row?.textDeltaDetails).filter(isObject);
}

function legacyOnlyDetails(row) {
  return asArray(row?.legacyOnlyDetails).filter(isObject);
}

function reviewableTextDeltaDisposition(disposition, includeNormalization) {
  return DEFAULT_TEXT_DELTA_DISPOSITIONS.has(disposition) || (includeNormalization && disposition === NORMALIZATION_DISPOSITION);
}

function buildTextDeltaItem({ row, detail, abrainHome, decision }) {
  const sourceRecordId = sourceRecordIdOf(detail);
  const targetId = targetIdOf(detail);
  const legacy = sourceRecordId ? findLegacyRule(abrainHome, sourceRecordId) : null;
  const constraint = findCompiledConstraint(decision, detail);
  const diagnosticIds = diagnosticIdsFrom(detail);
  const diagnostics = diagnosticsForSource(decision, sourceRecordId, diagnosticIds);
  return {
    kind: "text_delta_pair",
    reviewQuestion: "Does compiledBody preserve the behavioral requirement of legacyBody?",
    resolutionCandidates: RESOLUTION_CANDIDATES,
    sourceRecordId,
    targetId,
    disposition: dispositionOf(detail),
    legacyHash: stringAt(detail?.legacyHash, detail?.oldHash) ?? null,
    shadowHash: stringAt(detail?.shadowHash, detail?.compiledHash, detail?.newHash) ?? null,
    legacy,
    compiled: compiledSummary(constraint, targetId),
    diagnosticIds,
    category: stringAt(detail?.category) ?? null,
    humanReviewRequired: detail?.humanReviewRequired === true,
    audit: {
      observedAtUtc: row?.observedAtUtc ?? null,
      status: row?.status ?? null,
      activeProjectId: row?.activeProjectId ?? null,
      cwd: row?.cwd ?? null,
    },
    diagnostics,
    rawDetail: detail,
  };
}

function buildLegacyOnlyUnknownItem({ row, detail, abrainHome, decision }) {
  const sourceRecordId = sourceRecordIdOf(detail);
  const legacy = sourceRecordId ? findLegacyRule(abrainHome, sourceRecordId) : null;
  const context = sourceRecordId ? decisionContextForSource(decision, sourceRecordId) : { unresolved: [], exclusions: [], mappings: [], diagnostics: [] };
  const diagnosticIds = diagnosticIdsFrom(detail);
  return {
    kind: "legacy_only_unknown",
    reviewQuestion: "Should this legacy rule be compiled as memory, excluded as settings_not_memory, or remain unknown?",
    resolutionCandidates: RESOLUTION_CANDIDATES,
    sourceRecordId,
    targetId: targetIdOf(detail),
    disposition: dispositionOf(detail),
    legacyHash: stringAt(detail?.legacyHash, detail?.oldHash) ?? null,
    shadowHash: stringAt(detail?.shadowHash, detail?.compiledHash, detail?.newHash) ?? null,
    legacy,
    compiled: null,
    diagnosticIds,
    category: stringAt(detail?.category) ?? null,
    humanReviewRequired: detail?.humanReviewRequired === true,
    decisionContext: context,
    audit: {
      observedAtUtc: row?.observedAtUtc ?? null,
      status: row?.status ?? null,
      activeProjectId: row?.activeProjectId ?? null,
      cwd: row?.cwd ?? null,
    },
    rawDetail: detail,
  };
}

function shortText(value, limit = 180) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function buildReviewItems({ rows, includeNormalization, abrainHome, decision }) {
  const items = [];
  for (const row of rows) {
    for (const detail of textDeltaDetails(row)) {
      const disposition = dispositionOf(detail);
      if (!reviewableTextDeltaDisposition(disposition, includeNormalization)) continue;
      items.push(buildTextDeltaItem({ row, detail, abrainHome, decision }));
    }
    for (const detail of legacyOnlyDetails(row)) {
      if (dispositionOf(detail) !== "unknown") continue;
      items.push(buildLegacyOnlyUnknownItem({ row, detail, abrainHome, decision }));
    }
  }
  return items;
}

const abrainHome = resolveInputPath(arg("abrain", path.join(os.homedir(), ".abrain")));
const windowDays = nonNegativeInteger(arg("window-days", "7"), 7);
const postRefresh = hasFlag("post-refresh");
const latestOnly = hasFlag("latest");
const includeNormalization = hasFlag("include-normalization");
const jsonOutput = hasFlag("json");
const nowMs = Date.now();
const windowCutoffMs = nowMs - (windowDays * 24 * 60 * 60 * 1000);
const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow");
const sessionStartFile = path.join(shadowRoot, "session-start-dualread", "audit.jsonl");
const autoRefreshFile = path.join(shadowRoot, "auto-refresh", "audit.jsonl");
const decisionFile = path.join(shadowRoot, "latest", "decision.json");

const sessionStartAudit = readJsonLines(sessionStartFile);
const autoRefreshAudit = readJsonLines(autoRefreshFile);
const decisionRead = readJson(decisionFile);
const decision = decisionRead.exists && !decisionRead.error && isObject(decisionRead.value) ? decisionRead.value : {};
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
const reviewItems = buildReviewItems({ rows: analyzedRows, includeNormalization, abrainHome, decision });
const warnings = [];
if (sessionStartAudit.readError) warnings.push(`session-start dual-read audit read error: ${sessionStartAudit.readError}`);
if (sessionStartAudit.parseErrors.length) warnings.push(`session-start dual-read audit parse errors: ${sessionStartAudit.parseErrors.length}`);
if (autoRefreshAudit.readError) warnings.push(`auto-refresh audit read error: ${autoRefreshAudit.readError}`);
if (autoRefreshAudit.parseErrors.length) warnings.push(`auto-refresh audit parse errors: ${autoRefreshAudit.parseErrors.length}`);
if (postRefresh && !latestAutoRefresh) warnings.push("--post-refresh requested but no successful completed auto-refresh row was found; window cutoff was used");
if (decisionRead.error) warnings.push(`latest decision read error: ${decisionRead.error}`);
for (const item of reviewItems) {
  if (item.legacy?.matchMethod === "not_found") warnings.push(`legacy source not found: ${item.sourceRecordId}`);
  if (item.kind === "text_delta_pair" && !item.compiled) warnings.push(`compiled constraint not found for text delta: ${item.sourceRecordId} target=${item.targetId ?? "missing"}`);
}

const report = {
  schemaVersion: "constraint-semantic-review-pack-dossier/v1",
  generatedAtUtc: new Date(nowMs).toISOString(),
  inputs: {
    abrainHome,
    windowDays,
    postRefresh,
    latestOnly,
    includeNormalization,
    sessionStartFile,
    autoRefreshFile,
    decisionFile,
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
    latestDecision: {
      exists: decisionRead.exists,
      error: decisionRead.error ?? null,
      inputRootHash: decision?.inputRootHash ?? null,
      validationHash: decision?.validationHash ?? decision?.decisionValidationHash ?? null,
      constraints: asArray(decision?.constraints).length,
      exclusions: asArray(decision?.exclusions).length,
      unresolved: asArray(decision?.unresolved).length,
      mappings: asArray(decision?.mappings).length,
      diagnostics: asArray(decision?.diagnostics).length,
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
  binding: {
    inputRootHash: latestAnalyzed?.inputRootHash ?? decision?.inputRootHash ?? null,
    validationHash: latestAnalyzed?.validationHash ?? decision?.validationHash ?? decision?.decisionValidationHash ?? null,
    latestAuditObservedAtUtc: latestAnalyzed?.observedAtUtc ?? null,
    decisionInputRootHash: decision?.inputRootHash ?? null,
    decisionValidationHash: decision?.validationHash ?? decision?.decisionValidationHash ?? null,
  },
  summary: {
    reviewItemCount: reviewItems.length,
    byKind: reviewItems.reduce((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {}),
    byDisposition: reviewItems.reduce((acc, item) => ({ ...acc, [item.disposition]: (acc[item.disposition] ?? 0) + 1 }), {}),
  },
  reviewItems,
  warnings,
};

function renderHuman(value) {
  const lines = [];
  lines.push("ADR0039 Constraint semantic review pack dossier");
  lines.push(`abrain: ${value.inputs.abrainHome}`);
  lines.push(`windowDays: ${value.inputs.windowDays}  postRefresh: ${value.inputs.postRefresh}  latestOnly: ${value.inputs.latestOnly}  includeNormalization: ${value.inputs.includeNormalization}`);
  lines.push(`rowsAnalyzed: ${value.selection.rowsAnalyzed}  status: ${JSON.stringify(value.selection.status)}`);
  lines.push(`latest: ${value.selection.latest ? `${value.selection.latest.observedAtUtc} cwd=${value.selection.latest.cwd ?? "missing"} activeProjectId=${value.selection.latest.activeProjectId ?? "missing"}` : "none"}`);
  lines.push(`binding: inputRootHash=${value.binding.inputRootHash ?? "missing"} validationHash=${value.binding.validationHash ?? "missing"} latestAuditObservedAtUtc=${value.binding.latestAuditObservedAtUtc ?? "missing"}`);
  lines.push(`reviewItems: ${value.summary.reviewItemCount}  byKind=${JSON.stringify(value.summary.byKind)}  byDisposition=${JSON.stringify(value.summary.byDisposition)}`);
  lines.push("");
  if (!value.reviewItems.length) {
    lines.push("reviewItems: none");
  } else {
    lines.push("reviewItems:");
    for (const [index, item] of value.reviewItems.slice(0, 20).entries()) {
      lines.push(`  ${index + 1}. ${item.kind} ${item.disposition} source=${item.sourceRecordId ?? "missing"} target=${item.targetId ?? "missing"}`);
      lines.push(`     legacy: ${item.legacy?.file ?? "not_found"} match=${item.legacy?.matchMethod ?? "missing"} title=${item.legacy?.frontmatter?.title ?? "missing"}`);
      if (item.compiled) lines.push(`     compiled: ${item.compiled.id ?? "missing"} title=${item.compiled.title ?? "missing"}`);
      else lines.push("     compiled: none");
      lines.push(`     legacyBody: ${shortText(item.legacy?.body, 220) || "missing"}`);
      if (item.compiled?.compiledBody) lines.push(`     compiledBody: ${shortText(item.compiled.compiledBody, 220)}`);
      lines.push(`     question: ${item.reviewQuestion}`);
    }
    if (value.reviewItems.length > 20) lines.push(`  ... ${value.reviewItems.length - 20} more item(s); pass --json for full text`);
  }
  if (value.warnings.length) {
    lines.push("", "warnings:");
    for (const warning of value.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else console.log(renderHuman(report));
process.exit(0);
