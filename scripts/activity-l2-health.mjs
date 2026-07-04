#!/usr/bin/env node
/**
 * Read-only health report for the Activity / Attention L2 view.
 *
 * This script validates an existing projection only. It never generates L2,
 * writes abrain state, changes runtime injection, or touches memory_search.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "./project-activity-l2.mjs";

const DEFAULT_MARKDOWN_NAME = "project-time-allocation.md";
const DEFAULT_MANIFEST_NAME = "manifest.json";

function arg(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function resolveLatestDir(options = {}) {
  if (options.viewRoot) {
    const root = path.resolve(expandHome(options.viewRoot));
    if (fs.existsSync(path.join(root, DEFAULT_MANIFEST_NAME)) || fs.existsSync(path.join(root, DEFAULT_MARKDOWN_NAME))) return root;
    return path.join(root, "latest");
  }
  if (options.activityRoot) return path.join(path.resolve(expandHome(options.activityRoot)), "latest");
  const abrainHome = path.resolve(expandHome(options.abrainHome || path.join(os.homedir(), ".abrain")));
  return path.join(abrainHome, "l2", "views", "activity", "latest");
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) throw new Error("missing markdown frontmatter");
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) throw new Error("unterminated markdown frontmatter");
  const block = markdown.slice(4, end).split("\n");
  const fm = {};
  let currentList = null;
  for (const line of block) {
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (keyMatch) {
      currentList = null;
      const [, key, rawValue] = keyMatch;
      if (rawValue === "") {
        fm[key] = [];
        currentList = key;
      } else {
        fm[key] = rawValue;
      }
      continue;
    }
    const listMatch = line.match(/^\s+-\s*(.*)$/);
    if (listMatch && currentList) fm[currentList].push(listMatch[1]);
  }
  return fm;
}

function markdownForOutputHash(markdown) {
  return markdown
    .replace(/^output_hash:\s*.*$/m, "output_hash: ")
    .replace(/^- output_hash:\s*.*$/m, "- output_hash: ");
}

function sortedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function addFinding(findings, code, message) {
  findings.push({ level: "ERROR", code, message });
}

function sameString(a, b) {
  return String(a ?? "") === String(b ?? "");
}

function sameNumber(a, b) {
  return Number(a) === Number(b);
}

function compareField(findings, code, leftLabel, left, rightLabel, right) {
  if (!sameString(left, right)) addFinding(findings, code, `${leftLabel}=${left ?? "<missing>"} does not match ${rightLabel}=${right ?? "<missing>"}`);
}

function compareNumberField(findings, code, leftLabel, left, rightLabel, right) {
  if (!sameNumber(left, right)) addFinding(findings, code, `${leftLabel}=${left ?? "<missing>"} does not match ${rightLabel}=${right ?? "<missing>"}`);
}

function summarizeDistribution(manifest) {
  const windows = Array.isArray(manifest.windows) ? manifest.windows.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  const primaryWindow = windows.includes("30") ? "30" : windows[0] || null;
  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const totalIncluded = Number(manifest.includedEvents || 0);
  const rows = projects.map((project) => {
    const primaryWindowEvents = primaryWindow ? Number(project?.windows?.[primaryWindow] || 0) : 0;
    const total = Number(project?.total || 0);
    return {
      project: String(project?.project || project?.projectKey || "unknown"),
      projectKey: String(project?.projectKey || project?.project || "unknown"),
      total,
      primaryWindowEvents,
      shareOfIncluded: totalIncluded > 0 ? Number((total / totalIncluded).toFixed(6)) : 0,
    };
  }).sort((a, b) => b.total - a.total || a.project.localeCompare(b.project));
  const byProjectKey = new Map(rows.map((row) => [row.projectKey, row]));
  const byProject = new Map(rows.map((row) => [row.project, row]));
  const unattributed = byProjectKey.get("__unattributed__") || byProject.get("unattributed") || null;
  const world = byProjectKey.get("__world__") || byProject.get("world") || null;
  return {
    projectCount: projects.length,
    primaryWindowDays: primaryWindow === null ? null : Number(primaryWindow),
    primaryWindowEvents: primaryWindow ? Number(manifest?.totalsByWindow?.[primaryWindow] || 0) : null,
    includedEvents: totalIncluded,
    unattributedEvents: unattributed?.total || 0,
    unattributedShare: totalIncluded > 0 ? Number(((unattributed?.total || 0) / totalIncluded).toFixed(6)) : 0,
    worldEvents: world?.total || 0,
    projects: rows,
  };
}

function validateInternalManifest(findings, manifest) {
  const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
  const windows = Array.isArray(manifest.windows) ? manifest.windows.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  const projectTotal = projects.reduce((sum, project) => sum + Number(project?.total || 0), 0);
  if (projectTotal !== Number(manifest.includedEvents || 0)) {
    addFinding(findings, "manifest_project_total_mismatch", `sum(projects[].total)=${projectTotal} does not match includedEvents=${manifest.includedEvents ?? "<missing>"}`);
  }
  for (const days of windows) {
    const fromProjects = projects.reduce((sum, project) => sum + Number(project?.windows?.[days] || 0), 0);
    const manifestTotal = Number(manifest?.totalsByWindow?.[days] || 0);
    if (fromProjects !== manifestTotal) {
      addFinding(findings, "manifest_window_total_mismatch", `sum(projects[].windows[${days}])=${fromProjects} does not match totalsByWindow[${days}]=${manifestTotal}`);
    }
  }
}

function validateMarkdownManifest(findings, manifest, fm, markdown) {
  compareField(findings, "projector_mismatch", "manifest.projector", manifest.projector, "markdown.projector", fm.projector);
  compareField(findings, "projector_version_mismatch", "manifest.projectorVersion", manifest.projectorVersion, "markdown.projector_version", fm.projector_version);
  compareField(findings, "template_version_mismatch", "manifest.templateVersion", manifest.templateVersion, "markdown.template_version", fm.template_version);
  compareField(findings, "as_of_mismatch", "manifest.asOfUtc", manifest.asOfUtc, "markdown.as_of_utc", fm.as_of_utc);
  compareField(findings, "input_event_set_hash_mismatch", "manifest.inputEventSetHash", manifest.inputEventSetHash, "markdown.input_event_set_hash", fm.input_event_set_hash);
  compareField(findings, "output_hash_mismatch", "manifest.outputHash", manifest.outputHash, "markdown.output_hash", fm.output_hash);
  compareNumberField(findings, "included_events_mismatch", "manifest.includedEvents", manifest.includedEvents, "markdown.included_events", fm.included_events);
  compareNumberField(findings, "excluded_legacy_events_mismatch", "manifest.excludedLegacyEvents", manifest.excludedLegacyEvents, "markdown.excluded_legacy_events", fm.excluded_legacy_events);
  compareNumberField(findings, "skipped_projection_events_mismatch", "manifest.skippedProjectionEvents", manifest.skippedProjectionEvents, "markdown.skipped_projection_events", fm.skipped_projection_events);
  compareNumberField(findings, "invalid_events_mismatch", "manifest.invalidEvents", manifest.invalidEvents, "markdown.invalid_events", fm.invalid_events);
  const markdownWindows = Array.isArray(fm.windows_days) ? fm.windows_days.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  const manifestWindows = Array.isArray(manifest.windows) ? manifest.windows.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  if (JSON.stringify(markdownWindows) !== JSON.stringify(manifestWindows)) {
    addFinding(findings, "windows_mismatch", `manifest.windows=${JSON.stringify(manifestWindows)} does not match markdown.windows_days=${JSON.stringify(markdownWindows)}`);
  }
  const computedOutputHash = sha256Hex(markdownForOutputHash(markdown));
  if (computedOutputHash !== manifest.outputHash) {
    addFinding(findings, "output_hash_invalid", `computed markdown output hash ${computedOutputHash} does not match manifest.outputHash=${manifest.outputHash ?? "<missing>"}`);
  }
  if (fm.output_hash && computedOutputHash !== fm.output_hash) {
    addFinding(findings, "markdown_output_hash_invalid", `computed markdown output hash ${computedOutputHash} does not match markdown.output_hash=${fm.output_hash}`);
  }
  return computedOutputHash;
}

export function checkActivityL2Health(options = {}) {
  const latestDir = resolveLatestDir(options);
  const manifestPath = path.join(latestDir, DEFAULT_MANIFEST_NAME);
  const markdownPath = path.join(latestDir, DEFAULT_MARKDOWN_NAME);
  const findings = [];
  const report = {
    status: "fail",
    latestDir,
    paths: { manifestPath, markdownPath },
    freshness: null,
    integrity: null,
    distribution: null,
    diagnostics: null,
    findings,
  };

  if (!fs.existsSync(manifestPath)) addFinding(findings, "manifest_missing", `manifest not found: ${manifestPath}`);
  if (!fs.existsSync(markdownPath)) addFinding(findings, "markdown_missing", `markdown not found: ${markdownPath}`);
  if (findings.length) return report;

  let manifest;
  let markdown;
  let fm;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    addFinding(findings, "manifest_invalid_json", err instanceof Error ? err.message : String(err));
    return report;
  }
  try {
    markdown = fs.readFileSync(markdownPath, "utf8");
    fm = parseFrontmatter(markdown);
  } catch (err) {
    addFinding(findings, "markdown_invalid", err instanceof Error ? err.message : String(err));
    return report;
  }

  const asOfMs = parseTimestampMs(manifest.asOfUtc);
  const nowUtc = options.nowUtc || new Date().toISOString();
  const nowMs = parseTimestampMs(nowUtc);
  if (asOfMs === null) addFinding(findings, "as_of_invalid", `manifest.asOfUtc is not parseable: ${manifest.asOfUtc ?? "<missing>"}`);
  if (nowMs === null) addFinding(findings, "now_invalid", `--now is not parseable: ${nowUtc}`);
  const maxAgeHours = options.maxAgeHours === undefined || options.maxAgeHours === null ? null : parseNumber(options.maxAgeHours);
  if (options.maxAgeHours !== undefined && maxAgeHours === null) addFinding(findings, "max_age_invalid", `--max-age-hours is not a finite number: ${options.maxAgeHours}`);
  const ageHours = asOfMs !== null && nowMs !== null ? (nowMs - asOfMs) / 3600000 : null;
  if (ageHours !== null && maxAgeHours !== null && ageHours > maxAgeHours) {
    addFinding(findings, "view_stale", `as_of age ${ageHours.toFixed(3)}h exceeds --max-age-hours ${maxAgeHours}`);
  }

  const computedOutputHash = validateMarkdownManifest(findings, manifest, fm, markdown);
  validateInternalManifest(findings, manifest);
  const distribution = summarizeDistribution(manifest);
  report.status = findings.length ? "fail" : "pass";
  report.freshness = {
    asOfUtc: manifest.asOfUtc || null,
    nowUtc,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    maxAgeHours,
  };
  report.integrity = {
    schemaVersion: manifest.schemaVersion || null,
    projector: manifest.projector || null,
    projectorVersion: manifest.projectorVersion || null,
    templateVersion: manifest.templateVersion || null,
    inputEventSetHash: manifest.inputEventSetHash || null,
    outputHash: manifest.outputHash || null,
    computedOutputHash,
    includedEvents: Number(manifest.includedEvents || 0),
    excludedLegacyEvents: Number(manifest.excludedLegacyEvents || 0),
    skippedProjectionEvents: Number(manifest.skippedProjectionEvents || 0),
    invalidEvents: Number(manifest.invalidEvents || 0),
    windows: Array.isArray(manifest.windows) ? manifest.windows : [],
    totalsByWindow: sortedObject(manifest.totalsByWindow || {}),
  };
  report.distribution = distribution;
  report.diagnostics = sortedObject(manifest.diagnostics || {});
  return report;
}

function main() {
  const argv = process.argv.slice(2);
  const report = checkActivityL2Health({
    abrainHome: arg(argv, "abrain", null),
    viewRoot: arg(argv, "view-root", null),
    activityRoot: arg(argv, "activity-root", null),
    maxAgeHours: arg(argv, "max-age-hours", undefined),
    nowUtc: arg(argv, "now", null),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === "pass" ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
