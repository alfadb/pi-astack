#!/usr/bin/env node
/**
 * Deterministic L2 projector for global project activity allocation.
 *
 * This is an explicit command, not an agent_end hook. It reads immutable L1
 * evidence events and renders a human-readable L2 view. No new memory evidence
 * is created and no semantic lifecycle decision is made here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECTOR_NAME = "activity-projector";
export const PROJECTOR_VERSION = "activity-l2-v1";
export const TEMPLATE_VERSION = "activity-project-allocation-markdown/v1";
export const VIEW_SCHEMA_VERSION = "activity-project-allocation-view/v1";

const DEFAULT_WINDOWS = [7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

export function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

export function contentAddressedEventPath(abrainHome, eventId) {
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error(`invalid event id: ${eventId}`);
  return path.join(abrainHome, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}

function listJsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function relativeUnix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function parseWindows(raw) {
  if (!raw) return DEFAULT_WINDOWS;
  const windows = String(raw).split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(windows)].sort((a, b) => a - b);
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

// Canonical-path R3.4.2 P1-S3: the central machine schema-role registry is the
// single source of truth for which envelope schemas may exist in L1. Unknown
// envelope schemas are a blocking corpus violation, not a tolerated skip.
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const L1_REGISTRY = JSON.parse(fs.readFileSync(path.resolve(SCRIPT_DIR, "..", "schemas", "l1-schema-role-registry.json"), "utf8"));
const KNOWN_ENVELOPE_SCHEMAS = new Set(L1_REGISTRY.entries.map((entry) => entry.envelope_schema));
const ACTIVITY_BLOCKING_REASONS = new Set([
  "invalid_json",
  "missing_body",
  "invalid_event_id",
  "path_mismatch",
  "body_hash_mismatch",
  "unknown_envelope_schema",
]);

function eventSchema(envelope, body) {
  return String(body?.event_schema_version || envelope?.schema || "unknown");
}

function isProjectionEvent(envelope, body) {
  return String(envelope?.schema || "").includes("projection-envelope")
    || String(body?.event_schema_version || "").includes("projection-event");
}

function isLegacyImport(body) {
  const sourceRef = String(body?.source?.source_ref || "");
  return body?.session_id === "legacy-import"
    || body?.device_id === "legacy-import"
    || sourceRef.startsWith("legacy-import:")
    || body?.sanitizer?.sanitizer_name === "sediment.legacy-import";
}

function projectKeyFor(body) {
  if (body?.scope?.kind === "project" && body.scope.project_id) return String(body.scope.project_id);
  if (body?.scope?.active_project_binding?.project_id) return String(body.scope.active_project_binding.project_id);
  if (body?.scope?.scope_hint?.kind === "project" && body.scope.scope_hint.project_id) return String(body.scope.scope_hint.project_id);
  if (body?.active_project_binding?.project_id) return String(body.active_project_binding.project_id);
  if (body?.scope?.kind === "world") return "__world__";
  return "__unattributed__";
}

function displayProject(key) {
  if (key === "__world__") return "world";
  if (key === "__unattributed__") return "unattributed";
  return key;
}

function classifySourceEvent(envelope, file, options) {
  const body = envelope?.body;
  const schema = eventSchema(envelope, body);
  const eventId = String(envelope?.event_id || "");
  if (!body || typeof body !== "object") return { ok: false, reason: "missing_body" };
  if (!/^[0-9a-f]{64}$/.test(eventId)) return { ok: false, reason: "invalid_event_id" };
  const expectedPath = contentAddressedEventPath(options.abrainHome, eventId);
  if (path.resolve(file) !== path.resolve(expectedPath)) return { ok: false, reason: "path_mismatch" };
  const bodyHash = sha256Hex(canonicalJson(body));
  if (envelope.body_hash !== bodyHash || eventId !== bodyHash) return { ok: false, reason: "body_hash_mismatch" };
  if (!KNOWN_ENVELOPE_SCHEMAS.has(String(envelope?.schema || ""))) return { ok: false, reason: "unknown_envelope_schema" };
  if (isProjectionEvent(envelope, body)) return { ok: false, reason: "derived_projection_event" };
  if (!schema.endsWith("evidence-event/v1")) return { ok: false, reason: "unsupported_schema" };
  if (isLegacyImport(body) && !options.includeLegacy) return { ok: false, reason: "legacy_import_excluded" };
  const createdMs = parseTimestampMs(body.created_at_utc);
  if (createdMs === null) return { ok: false, reason: "missing_created_at_utc" };
  if (createdMs > options.asOfMs) return { ok: false, reason: "future_event" };
  return {
    ok: true,
    event: {
      eventId,
      schema,
      createdAtUtc: new Date(createdMs).toISOString(),
      createdMs,
      projectKey: projectKeyFor(body),
      domain: String(body?.intent?.domain_hint || "unknown"),
      sourceChannel: String(body?.source?.channel || "unknown"),
      sessionId: String(body?.session_id || "unknown"),
      relativePath: relativeUnix(options.abrainHome, file),
    },
  };
}

function emptyProjectStat(key, windows) {
  return {
    projectKey: key,
    project: displayProject(key),
    total: 0,
    firstSignalUtc: null,
    lastSignalUtc: null,
    domains: {},
    sourceChannels: {},
    windows: Object.fromEntries(windows.map((days) => [String(days), 0])),
  };
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function formatPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function formatDomains(domains) {
  const rows = Object.entries(domains).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows.map(([key, value]) => `${key}:${value}`).join(", ") || "-";
}

function inputRootHash(args) {
  return sha256Hex(canonicalJson({
    projector: PROJECTOR_NAME,
    projectorVersion: PROJECTOR_VERSION,
    templateVersion: TEMPLATE_VERSION,
    asOfUtc: args.asOfUtc,
    includeLegacy: args.includeLegacy,
    windows: args.windows,
    inputObservations: args.inputObservations,
  }));
}

export function assertSafeOutputRoot(abrainHome, outputRoot) {
  const rel = path.relative(path.resolve(abrainHome), path.resolve(outputRoot));
  if (rel === "") return;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  const relUnix = rel.split(path.sep).join("/");
  if (relUnix === "l2/views/activity" || relUnix.startsWith("l2/views/activity/")) return;
  throw new Error(`--output-root inside abrain must stay under l2/views/activity; got ${relUnix}`);
}

function makeMarkdown(view, outputHash = "") {
  const primaryWindow = String(view.windows.includes(30) ? 30 : view.windows[0]);
  const primaryTotal = view.totalsByWindow[primaryWindow] || 0;
  const rows = view.projects
    .filter((project) => project.total > 0)
    .sort((a, b) => {
      const bw = b.windows[primaryWindow] || 0;
      const aw = a.windows[primaryWindow] || 0;
      return bw - aw || b.total - a.total || a.project.localeCompare(b.project);
    });
  const frontmatter = [
    "---",
    `schema_version: ${VIEW_SCHEMA_VERSION}`,
    "view: project_time_allocation",
    "status: active",
    `projector: ${PROJECTOR_NAME}`,
    `projector_version: ${PROJECTOR_VERSION}`,
    `template_version: ${TEMPLATE_VERSION}`,
    `as_of_utc: ${view.asOfUtc}`,
    `input_event_set_hash: ${view.inputEventSetHash}`,
    `output_hash: ${outputHash}`,
    `included_events: ${view.includedEvents}`,
    `excluded_legacy_events: ${view.excludedLegacyEvents}`,
    `skipped_projection_events: ${view.skippedProjectionEvents}`,
    `invalid_events: ${view.invalidEvents}`,
    "windows_days:",
    ...view.windows.map((days) => `  - ${days}`),
    "---",
    "",
  ];
  const lines = [
    ...frontmatter,
    "# Activity / Attention Timeline - Project Allocation",
    "",
    "This L2 view is a deterministic projection over L1 evidence events. It is a human-readable activity signal, not canonical memory and not an editable wiki store.",
    "",
    "## Reading Notes",
    "",
    "- Counts are evidence-event activity counts, not wall-clock minutes.",
    "- Legacy import/backfill events are excluded by default so migration batches do not look like recent work.",
    "- Unattributed rows mean the L1 event did not carry a project binding; they should drive schema/projector follow-up, not manual editing.",
    "- Requirement/workline attribution is intentionally out of scope for this view.",
    "",
    "## Summary",
    "",
    `- as_of_utc: ${view.asOfUtc}`,
    `- included_events: ${view.includedEvents}`,
    `- excluded_legacy_events: ${view.excludedLegacyEvents}`,
    `- skipped_projection_events: ${view.skippedProjectionEvents}`,
    `- invalid_events: ${view.invalidEvents}`,
    `- primary_window_days: ${primaryWindow}`,
    `- primary_window_events: ${primaryTotal}`,
    "",
    `## Project Allocation (${primaryWindow} days)` ,
    "",
    "| project | events | share | last_signal_utc | domains |",
    "|---|---:|---:|---|---|",
  ];
  for (const row of rows.filter((project) => (project.windows[primaryWindow] || 0) > 0)) {
    const count = row.windows[primaryWindow] || 0;
    const share = primaryTotal > 0 ? count / primaryTotal : 0;
    lines.push(`| ${row.project} | ${count} | ${formatPct(share)} | ${row.lastSignalUtc || "-"} | ${formatDomains(row.domains)} |`);
  }
  if (!rows.some((project) => (project.windows[primaryWindow] || 0) > 0)) lines.push("| - | 0 | 0.0% | - | - |");
  lines.push("", "## Window Counts", "");
  lines.push(["| project | total | first_signal_utc | last_signal_utc |", ...view.windows.map((days) => ` ${days}d |`)].join(""));
  lines.push(["|---|---:|---|---|", ...view.windows.map(() => "---:|")].join(""));
  for (const row of rows) {
    lines.push([`| ${row.project} | ${row.total} | ${row.firstSignalUtc || "-"} | ${row.lastSignalUtc || "-"} |`, ...view.windows.map((days) => ` ${row.windows[String(days)] || 0} |`)].join(""));
  }
  lines.push("", "## Diagnostics", "", "| reason | count |", "|---|---:|");
  for (const [reason, count] of Object.entries(view.diagnostics).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("", "## Provenance", "", `- input_event_set_hash: ${view.inputEventSetHash}`, `- output_hash: ${outputHash}`, "- default_output_path: l2/views/activity/latest/project-time-allocation.md", "");
  return lines.join("\n");
}

export function buildProjectActivityView(args) {
  const abrainHome = path.resolve(expandHome(args.abrainHome || path.join(os.homedir(), ".abrain")));
  const windows = (args.windows && args.windows.length ? args.windows : DEFAULT_WINDOWS).slice().sort((a, b) => a - b);
  const asOfUtc = args.asOfUtc || new Date().toISOString();
  const asOfMs = parseTimestampMs(asOfUtc);
  if (asOfMs === null) throw new Error(`invalid --as-of timestamp: ${asOfUtc}`);
  const options = { abrainHome, asOfUtc: new Date(asOfMs).toISOString(), asOfMs, includeLegacy: !!args.includeLegacy };
  const projectStats = new Map();
  const diagnostics = {};
  const inputObservations = [];
  let includedEvents = 0;
  let excludedLegacyEvents = 0;
  let skippedProjectionEvents = 0;
  let invalidEvents = 0;
  for (const file of listJsonFiles(path.join(abrainHome, "l1", "events"))) {
    const relativePath = relativeUnix(abrainHome, file);
    let raw;
    let envelope;
    try {
      raw = fs.readFileSync(file, "utf8");
      envelope = JSON.parse(raw);
    } catch {
      invalidEvents += 1;
      increment(diagnostics, "invalid_json");
      inputObservations.push({ reason: "invalid_json", relativePath, rawHash: raw ? sha256Hex(raw) : null });
      continue;
    }
    const classified = classifySourceEvent(envelope, file, options);
    if (!classified.ok) {
      increment(diagnostics, classified.reason);
      if (classified.reason === "legacy_import_excluded") excludedLegacyEvents += 1;
      else if (classified.reason === "derived_projection_event") skippedProjectionEvents += 1;
      else invalidEvents += 1;
      inputObservations.push({ reason: classified.reason, eventId: envelope?.event_id || null, relativePath, rawHash: sha256Hex(raw) });
      continue;
    }
    const ev = classified.event;
    includedEvents += 1;
    inputObservations.push({ reason: "included", eventId: ev.eventId, relativePath });
    if (!projectStats.has(ev.projectKey)) projectStats.set(ev.projectKey, emptyProjectStat(ev.projectKey, windows));
    const stat = projectStats.get(ev.projectKey);
    stat.total += 1;
    stat.firstSignalUtc = stat.firstSignalUtc && stat.firstSignalUtc < ev.createdAtUtc ? stat.firstSignalUtc : ev.createdAtUtc;
    stat.lastSignalUtc = stat.lastSignalUtc && stat.lastSignalUtc > ev.createdAtUtc ? stat.lastSignalUtc : ev.createdAtUtc;
    increment(stat.domains, ev.domain);
    increment(stat.sourceChannels, ev.sourceChannel);
    for (const days of windows) {
      if (ev.createdMs >= asOfMs - days * DAY_MS) stat.windows[String(days)] += 1;
    }
  }
  const totalsByWindow = Object.fromEntries(windows.map((days) => [String(days), 0]));
  for (const stat of projectStats.values()) {
    for (const days of windows) totalsByWindow[String(days)] += stat.windows[String(days)] || 0;
  }
  inputObservations.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const rootHash = inputRootHash({
    asOfUtc: options.asOfUtc,
    includeLegacy: options.includeLegacy,
    windows,
    inputObservations,
  });
  const projects = [...projectStats.values()].sort((a, b) => a.project.localeCompare(b.project));
  const viewWithoutHash = {
    schemaVersion: VIEW_SCHEMA_VERSION,
    projector: PROJECTOR_NAME,
    projectorVersion: PROJECTOR_VERSION,
    templateVersion: TEMPLATE_VERSION,
    asOfUtc: options.asOfUtc,
    includeLegacy: options.includeLegacy,
    windows,
    inputEventSetHash: rootHash,
    includedEvents,
    excludedLegacyEvents,
    skippedProjectionEvents,
    invalidEvents,
    totalsByWindow,
    projects,
    diagnostics,
  };
  const markdownWithoutHash = makeMarkdown(viewWithoutHash, "");
  const outputHash = sha256Hex(markdownWithoutHash);
  const view = { ...viewWithoutHash, outputHash };
  const markdown = makeMarkdown(view, outputHash);
  const manifest = {
    schemaVersion: "activity-project-allocation-manifest/v1",
    view: "activity/project-time-allocation",
    projector: PROJECTOR_NAME,
    projectorVersion: PROJECTOR_VERSION,
    templateVersion: TEMPLATE_VERSION,
    asOfUtc: view.asOfUtc,
    includeLegacy: view.includeLegacy,
    windows,
    inputEventSetHash: rootHash,
    outputHash,
    includedEvents,
    excludedLegacyEvents,
    skippedProjectionEvents,
    invalidEvents,
    totalsByWindow,
    projects,
    diagnostics,
  };
  return { view, markdown, manifest };
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function writeProjectActivityProjection(args) {
  const abrainHome = path.resolve(expandHome(args.abrainHome || path.join(os.homedir(), ".abrain")));
  const outputRoot = path.resolve(expandHome(args.outputRoot || path.join(abrainHome, "l2", "views", "activity")));
  assertSafeOutputRoot(abrainHome, outputRoot);
  const result = buildProjectActivityView({ ...args, abrainHome });
  // Canonical-path R3.4.2 P1-S3: a corrupted or unknown event anywhere in the
  // scanned corpus fails the projection write closed (zero L2 mutation).
  const blocking = Object.entries(result.view.diagnostics)
    .filter(([reason]) => ACTIVITY_BLOCKING_REASONS.has(reason))
    .map(([reason, count]) => `${reason}:${count}`);
  if (blocking.length > 0) {
    throw new Error(`ACTIVITY_L1_CORPUS_INVALID: refusing to write activity L2 over an invalid L1 corpus (${blocking.join(", ")})`);
  }
  const latestDir = path.join(outputRoot, "latest");
  const markdownPath = path.join(latestDir, "project-time-allocation.md");
  const manifestPath = path.join(latestDir, "manifest.json");
  writeAtomic(markdownPath, result.markdown);
  writeAtomic(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  return { ...result, markdownPath, manifestPath };
}

function main() {
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const outputRootArg = arg("output-root", null);
  const outputRoot = outputRootArg ? path.resolve(expandHome(outputRootArg)) : path.join(abrainHome, "l2", "views", "activity");
  const windows = parseWindows(arg("window-days", null));
  const asOfUtc = arg("as-of", new Date().toISOString());
  const includeLegacy = flag("include-legacy");
  const shouldWrite = flag("write");
  const args = { abrainHome, outputRoot, windows, asOfUtc, includeLegacy };
  if (shouldWrite) {
    const result = writeProjectActivityProjection(args);
    console.log(JSON.stringify({
      status: "written",
      markdownPath: result.markdownPath,
      manifestPath: result.manifestPath,
      asOfUtc: result.view.asOfUtc,
      inputEventSetHash: result.view.inputEventSetHash,
      outputHash: result.view.outputHash,
      includedEvents: result.view.includedEvents,
      totalsByWindow: result.view.totalsByWindow,
      excludedLegacyEvents: result.view.excludedLegacyEvents,
      skippedProjectionEvents: result.view.skippedProjectionEvents,
      invalidEvents: result.view.invalidEvents,
    }, null, 2));
    return;
  }
  const result = buildProjectActivityView(args);
  console.log(result.markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  }
}
