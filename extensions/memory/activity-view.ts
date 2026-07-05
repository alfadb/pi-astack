import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserGlobalAbrainHome } from "../_shared/runtime";

const DEFAULT_MARKDOWN_NAME = "project-time-allocation.md";
const DEFAULT_MANIFEST_NAME = "manifest.json";
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_EXCERPT_CHARS = 4000;

export interface ActivityViewReadOptions {
  windowDays?: number;
  limit?: number;
  includeExcerpt?: boolean;
  abrainRoot?: string;
  viewRoot?: string;
  nowUtc?: string;
}

type FindingLevel = "ERROR" | "WARN";

interface Finding {
  level: FindingLevel;
  code: string;
  message: string;
}

interface Frontmatter {
  [key: string]: string | string[] | undefined;
}

function expandHome(input: string): string {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function parseTimestampMs(value: unknown): number | null {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.trunc(numberOr(value, fallback));
  return Math.max(min, Math.min(max, parsed));
}

function resolveLatestDir(options: ActivityViewReadOptions): string {
  if (options.viewRoot) {
    const root = path.resolve(expandHome(options.viewRoot));
    if (fs.existsSync(path.join(root, DEFAULT_MANIFEST_NAME)) || fs.existsSync(path.join(root, DEFAULT_MARKDOWN_NAME))) return root;
    return path.join(root, "latest");
  }
  const abrainHome = path.resolve(expandHome(options.abrainRoot || resolveUserGlobalAbrainHome()));
  return path.join(abrainHome, "l2", "views", "activity", "latest");
}

function parseFrontmatter(markdown: string): Frontmatter {
  if (!markdown.startsWith("---\n")) throw new Error("missing markdown frontmatter");
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) throw new Error("unterminated markdown frontmatter");
  const block = markdown.slice(4, end).split("\n");
  const fm: Frontmatter = {};
  let currentList: string | null = null;
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
    if (listMatch && currentList && Array.isArray(fm[currentList])) {
      (fm[currentList] as string[]).push(listMatch[1]);
    }
  }
  return fm;
}

function markdownForOutputHash(markdown: string): string {
  return markdown
    .replace(/^output_hash:\s*.*$/m, "output_hash: ")
    .replace(/^- output_hash:\s*.*$/m, "- output_hash: ");
}

function addFinding(findings: Finding[], level: FindingLevel, code: string, message: string): void {
  findings.push({ level, code, message });
}

function compareField(findings: Finding[], code: string, leftLabel: string, left: unknown, rightLabel: string, right: unknown): void {
  if (String(left ?? "") !== String(right ?? "")) {
    addFinding(findings, "ERROR", code, `${leftLabel}=${left ?? "<missing>"} does not match ${rightLabel}=${right ?? "<missing>"}`);
  }
}

function compareNumberField(findings: Finding[], code: string, leftLabel: string, left: unknown, rightLabel: string, right: unknown): void {
  if (Number(left) !== Number(right)) {
    addFinding(findings, "ERROR", code, `${leftLabel}=${left ?? "<missing>"} does not match ${rightLabel}=${right ?? "<missing>"}`);
  }
}

function compareWindows(findings: Finding[], manifest: Record<string, unknown>, fm: Frontmatter): void {
  const markdownWindows = Array.isArray(fm.windows_days) ? fm.windows_days.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  const manifestWindows = Array.isArray(manifest.windows) ? manifest.windows.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  if (JSON.stringify(markdownWindows) !== JSON.stringify(manifestWindows)) {
    addFinding(findings, "ERROR", "windows_mismatch", `manifest.windows=${JSON.stringify(manifestWindows)} does not match markdown.windows_days=${JSON.stringify(markdownWindows)}`);
  }
}

function validateInternalManifest(findings: Finding[], manifest: Record<string, unknown>): void {
  const projects = Array.isArray(manifest.projects) ? manifest.projects as Array<Record<string, unknown>> : [];
  const windows = Array.isArray(manifest.windows) ? manifest.windows.map(String).sort((a, b) => Number(a) - Number(b)) : [];
  const projectTotal = projects.reduce((sum, project) => sum + Number(project?.total || 0), 0);
  if (projectTotal !== Number(manifest.includedEvents || 0)) {
    addFinding(findings, "ERROR", "manifest_project_total_mismatch", `sum(projects[].total)=${projectTotal} does not match includedEvents=${manifest.includedEvents ?? "<missing>"}`);
  }
  const totalsByWindow = manifest.totalsByWindow && typeof manifest.totalsByWindow === "object" ? manifest.totalsByWindow as Record<string, unknown> : {};
  for (const days of windows) {
    const fromProjects = projects.reduce((sum, project) => {
      const projectWindows = project?.windows && typeof project.windows === "object" ? project.windows as Record<string, unknown> : {};
      return sum + Number(projectWindows[days] || 0);
    }, 0);
    const manifestTotal = Number(totalsByWindow[days] || 0);
    if (fromProjects !== manifestTotal) {
      addFinding(findings, "ERROR", "manifest_window_total_mismatch", `sum(projects[].windows[${days}])=${fromProjects} does not match totalsByWindow[${days}]=${manifestTotal}`);
    }
  }
}

function validateMarkdownManifest(findings: Finding[], manifest: Record<string, unknown>, fm: Frontmatter, markdown: string): string {
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
  compareWindows(findings, manifest, fm);
  const computedOutputHash = sha256Hex(markdownForOutputHash(markdown));
  if (computedOutputHash !== manifest.outputHash) {
    addFinding(findings, "ERROR", "output_hash_invalid", `computed markdown output hash ${computedOutputHash} does not match manifest.outputHash=${manifest.outputHash ?? "<missing>"}`);
  }
  if (fm.output_hash && computedOutputHash !== fm.output_hash) {
    addFinding(findings, "ERROR", "markdown_output_hash_invalid", `computed markdown output hash ${computedOutputHash} does not match markdown.output_hash=${fm.output_hash}`);
  }
  return computedOutputHash;
}

function projectRows(manifest: Record<string, unknown>, windowDays: number, limit: number) {
  const projects = Array.isArray(manifest.projects) ? manifest.projects as Array<Record<string, unknown>> : [];
  const totalsByWindow = manifest.totalsByWindow && typeof manifest.totalsByWindow === "object" ? manifest.totalsByWindow as Record<string, unknown> : {};
  const windowKey = String(windowDays);
  const windowTotal = Number(totalsByWindow[windowKey] || 0);
  return projects.map((project) => {
    const windows = project.windows && typeof project.windows === "object" ? project.windows as Record<string, unknown> : {};
    const events = Number(windows[windowKey] || 0);
    const total = Number(project.total || 0);
    return {
      project: String(project.project || project.projectKey || "unknown"),
      projectKey: String(project.projectKey || project.project || "unknown"),
      events,
      total,
      shareOfWindow: windowTotal > 0 ? Number((events / windowTotal).toFixed(6)) : 0,
      firstSignalUtc: typeof project.firstSignalUtc === "string" ? project.firstSignalUtc : null,
      lastSignalUtc: typeof project.lastSignalUtc === "string" ? project.lastSignalUtc : null,
    };
  }).sort((a, b) => b.events - a.events || b.total - a.total || a.project.localeCompare(b.project)).slice(0, limit);
}

function findProject(manifest: Record<string, unknown>, key: string, display: string, windowDays: number) {
  const projects = Array.isArray(manifest.projects) ? manifest.projects as Array<Record<string, unknown>> : [];
  const row = projects.find((project) => project.projectKey === key || project.project === display);
  const windows = row?.windows && typeof row.windows === "object" ? row.windows as Record<string, unknown> : {};
  return {
    project: display,
    projectKey: key,
    events: Number(windows[String(windowDays)] || 0),
    total: Number(row?.total || 0),
    firstSignalUtc: typeof row?.firstSignalUtc === "string" ? row.firstSignalUtc : null,
    lastSignalUtc: typeof row?.lastSignalUtc === "string" ? row.lastSignalUtc : null,
  };
}

function windowsSummary(manifest: Record<string, unknown>) {
  const totalsByWindow = manifest.totalsByWindow && typeof manifest.totalsByWindow === "object" ? manifest.totalsByWindow as Record<string, unknown> : {};
  const windows = Array.isArray(manifest.windows) ? manifest.windows.map((days) => Number(days)).filter(Number.isFinite).sort((a, b) => a - b) : [];
  return windows.map((days) => ({ days, events: Number(totalsByWindow[String(days)] || 0) }));
}

function excerptFromMarkdown(markdown: string): string {
  const body = markdown.startsWith("---\n") ? markdown.slice(markdown.indexOf("\n---", 4) + 4).trimStart() : markdown;
  return body.slice(0, DEFAULT_EXCERPT_CHARS);
}

export function readActivityView(options: ActivityViewReadOptions = {}) {
  const latestDir = resolveLatestDir(options);
  const manifestPath = path.join(latestDir, DEFAULT_MANIFEST_NAME);
  const markdownPath = path.join(latestDir, DEFAULT_MARKDOWN_NAME);
  const requestedWindowDays = clampInt(options.windowDays, DEFAULT_WINDOW_DAYS, 1, 3650);
  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const nowUtc = options.nowUtc || new Date().toISOString();
  const findings: Finding[] = [];

  if (!fs.existsSync(manifestPath) || !fs.existsSync(markdownPath)) {
    if (!fs.existsSync(manifestPath)) addFinding(findings, "ERROR", "manifest_missing", `manifest not found: ${manifestPath}`);
    if (!fs.existsSync(markdownPath)) addFinding(findings, "ERROR", "markdown_missing", `markdown not found: ${markdownPath}`);
    return {
      ok: false,
      status: "missing_view",
      latestDir,
      paths: { manifestPath, markdownPath },
      findings,
      hint: "Activity L2 view is missing. Do not infer that there was no activity; generate/check the projection explicitly outside this read-only tool.",
    };
  }

  let manifest: Record<string, unknown>;
  let markdown: string;
  let fm: Frontmatter;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    addFinding(findings, "ERROR", "manifest_invalid_json", err instanceof Error ? err.message : String(err));
    return { ok: false, status: "invalid_view", latestDir, paths: { manifestPath, markdownPath }, findings };
  }
  try {
    markdown = fs.readFileSync(markdownPath, "utf8");
    fm = parseFrontmatter(markdown);
  } catch (err) {
    addFinding(findings, "ERROR", "markdown_invalid", err instanceof Error ? err.message : String(err));
    return { ok: false, status: "invalid_view", latestDir, paths: { manifestPath, markdownPath }, findings };
  }

  const asOfMs = parseTimestampMs(manifest.asOfUtc);
  const nowMs = parseTimestampMs(nowUtc);
  if (asOfMs === null) addFinding(findings, "ERROR", "as_of_invalid", `manifest.asOfUtc is not parseable: ${manifest.asOfUtc ?? "<missing>"}`);
  if (nowMs === null) addFinding(findings, "ERROR", "now_invalid", `nowUtc is not parseable: ${nowUtc}`);
  const ageHours = asOfMs !== null && nowMs !== null ? Number(((nowMs - asOfMs) / 3600000).toFixed(3)) : null;

  const computedOutputHash = validateMarkdownManifest(findings, manifest, fm, markdown);
  validateInternalManifest(findings, manifest);

  const availableWindows = Array.isArray(manifest.windows) ? manifest.windows.map((days) => Number(days)).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const selectedWindowDays = availableWindows.includes(requestedWindowDays)
    ? requestedWindowDays
    : availableWindows.includes(DEFAULT_WINDOW_DAYS)
      ? DEFAULT_WINDOW_DAYS
      : availableWindows[0] || requestedWindowDays;
  if (selectedWindowDays !== requestedWindowDays) {
    addFinding(findings, "WARN", "window_unavailable", `requested windowDays=${requestedWindowDays} unavailable; using ${selectedWindowDays}`);
  }

  const summary = {
    ok: findings.every((finding) => finding.level !== "ERROR"),
    status: findings.some((finding) => finding.level === "ERROR") ? "invalid_view" : "ok",
    latestDir,
    paths: { manifestPath, markdownPath },
    asOfUtc: typeof manifest.asOfUtc === "string" ? manifest.asOfUtc : null,
    nowUtc,
    ageHours,
    countsAre: "evidence-event counts, not wall-clock minutes",
    stalePolicy: "This tool only reports ageHours; it never generates, refreshes, or writes the activity projection.",
    includedEvents: Number(manifest.includedEvents || 0),
    excludedLegacy: Number(manifest.excludedLegacyEvents || 0),
    skippedProjection: Number(manifest.skippedProjectionEvents || 0),
    invalidEvents: Number(manifest.invalidEvents || 0),
    requestedWindowDays,
    selectedWindowDays,
    windows: windowsSummary(manifest),
    topProjects: projectRows(manifest, selectedWindowDays, limit),
    world: findProject(manifest, "__world__", "world", selectedWindowDays),
    unattributed: findProject(manifest, "__unattributed__", "unattributed", selectedWindowDays),
    diagnostics: {
      manifest: manifest.diagnostics && typeof manifest.diagnostics === "object" ? manifest.diagnostics : {},
      findings,
      integrity: {
        projector: manifest.projector || null,
        projectorVersion: manifest.projectorVersion || null,
        templateVersion: manifest.templateVersion || null,
        inputEventSetHash: manifest.inputEventSetHash || null,
        outputHash: manifest.outputHash || null,
        computedOutputHash,
      },
    },
    notes: [
      "Use memory_activity only for recent activity, attention timeline, or project allocation questions.",
      "Do not use it for preferences, rules, durable knowledge lookup, or semantic memory retrieval.",
    ],
    ...(options.includeExcerpt ? { excerpt: excerptFromMarkdown(markdown) } : {}),
  };
  return summary;
}

export const __TEST = {
  markdownForOutputHash,
  parseFrontmatter,
};
