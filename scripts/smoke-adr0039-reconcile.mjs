#!/usr/bin/env node
/**
 * ADR 0039 reconcile smoke.
 *
 * Default mode uses a temporary abrain tree and verifies the reconcile checks
 * catch corrupted L1 events and stale derived views. With --abrain it validates
 * a real tree and refreshes only the derived ADR0039 L3 SQLite mirror.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { runBackfill as runLegacyBackfill, buildLegacyImportBody, legacyKnowledgeEntries } from "./backfill-legacy-knowledge.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { checkAdr0039ReconcileGate, parseGitStatusPorcelainV1Z } = await jiti.import(path.join(repoRoot, "extensions", "abrain", "reconcile-gate.ts"));
const settingsPath = path.resolve(repoRoot, "..", "..", "pi-astack-settings.json");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
  new (require("node:vm").Script)(out, { filename: srcPath });
  return out;
}

function stageTs(outRoot, src, dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js")) {
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}

function loadKnowledgeEvidenceModule() {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-knowledge-evidence-"));
  stageTs(outRoot, "extensions/_shared/durable-write.ts");
  stageTs(outRoot, "extensions/_shared/jcs.ts");
  stageTs(outRoot, "extensions/_shared/l1-schema-registry.ts");
  fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));
  stageTs(outRoot, "extensions/memory/settings.ts");
  stageTs(outRoot, "extensions/memory/utils.ts");
  stageTs(outRoot, "extensions/sediment/knowledge-evidence.ts");
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/knowledge-evidence.js");
}

function loadAdr0039L3Module() {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l3-"));
  stageTs(outRoot, "extensions/_shared/jcs.ts");
  stageTs(outRoot, "extensions/_shared/l1-schema-registry.ts");
  fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));
  stageTs(outRoot, "extensions/sediment/adr0039-l3.ts");
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/adr0039-l3.js");
}

let _constraintRenderModule = null;
function loadConstraintRenderModule() {
  if (_constraintRenderModule) return _constraintRenderModule;
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-constraint-render-"));
  stageTs(outRoot, "extensions/sediment/sanitizer.ts");
  stageTs(outRoot, "extensions/sediment/constraint-compiler/types.ts");
  stageTs(outRoot, "extensions/sediment/constraint-compiler/diagnostics.ts");
  stageTs(outRoot, "extensions/sediment/constraint-compiler/normalize.ts");
  stageTs(outRoot, "extensions/sediment/constraint-compiler/render.ts");
  _constraintRenderModule = createRequire(path.join(outRoot, "runner.cjs"))("./sediment/constraint-compiler/render.js");
  return _constraintRenderModule;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function listFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile() && predicate(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function relativeUnix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function expectedEventPath(abrainHome, eventId) {
  return path.join(abrainHome, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}

function validateL1Events(abrainHome) {
  const files = listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json"));
  const failures = [];
  for (const file of files) {
    const rel = relativeUnix(abrainHome, file);
    let envelope;
    try {
      envelope = readJson(file);
    } catch (err) {
      failures.push(`${rel}: invalid_json:${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const bodyHash = sha256Hex(canonicalJson(envelope.body));
    if (envelope.hash_alg !== "sha256") failures.push(`${rel}: hash_alg_not_sha256`);
    if (envelope.event_id !== bodyHash || envelope.body_hash !== bodyHash) failures.push(`${rel}: body_hash_mismatch`);
    const expected = expectedEventPath(abrainHome, envelope.event_id || "");
    if (path.resolve(file) !== path.resolve(expected)) failures.push(`${rel}: content_address_path_mismatch`);
  }
  return { files: files.length, failures };
}

function readManifestEventIds(file) {
  if (!fs.existsSync(file)) return [];
  const raw = readJson(file);
  const ids = new Set();
  for (const key of ["latestEventId", "latest_event_id", "sourceEventId", "source_event_id"]) {
    if (typeof raw[key] === "string") ids.add(raw[key]);
  }
  if (Array.isArray(raw.events)) {
    for (const event of raw.events) {
      if (typeof event === "string") ids.add(event);
      if (event && typeof event === "object" && typeof event.eventId === "string") ids.add(event.eventId);
      if (event && typeof event === "object" && typeof event.event_id === "string") ids.add(event.event_id);
    }
  }
  return [...ids];
}

function expectedKnowledgeOutputPath(latestDir, body) {
  const projectPart = body.scope?.kind === "world" ? "world" : `projects/${body.scope?.project_id || "unknown"}`;
  return path.join(latestDir, projectPart, `${body.payload?.slug}.md`);
}

// ADR0039 B1: resolve the Knowledge L2 latest dir from the projector flag so
// reconcile / L3 mirror read the same root the writer used.
function resolveKnowledgeLatestDir(abrainHome, override) {
  if (override) return override;
  const cfg = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
  const root = cfg.sediment?.knowledgeProjector?.l2OutputRoot === "repo"
    ? path.join(abrainHome, "l2", "views", "knowledge")
    : path.join(abrainHome, ".state", "sediment", "knowledge-projection");
  return path.join(root, "latest");
}

function resolveProjectionMode(override) {
  if (override) return override;
  const cfg = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
  return cfg.sediment?.knowledgeProjector?.projectionMode === "topo" ? "topo" : "single";
}

function markdownString(value) {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function markdownList(key, values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return [key + ":", ...values.map((value) => `  - ${markdownString(String(value))}`)];
}

function normalizeCompiledTruth(title, body) {
  let text = String(body || "").trim().replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  text = text.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(text)) text = `# ${title}\n\n${text}`;
  return text.trim();
}

function renderLegacyKnowledgeProjectionMarkdown(body, eventId) {
  const timestamp = body.created_at_utc;
  const payload = body.payload;
  const id = body.scope.kind === "world" ? `world:${payload.slug}` : `project:${body.scope.project_id}:${payload.slug}`;
  const frontmatter = [
    "---",
    `id: ${id}`,
    `scope: ${body.scope.kind}`,
    `kind: ${payload.kind}`,
    `status: ${payload.status}`,
    `confidence: ${payload.confidence}`,
    `provenance: ${markdownString(payload.provenance)}`,
    "schema_version: 1",
    `title: ${markdownString(payload.title)}`,
    `created: ${timestamp}`,
    `updated: ${timestamp}`,
    "sediment_projection: knowledge-evidence/v1",
    `sediment_event_id: ${eventId}`,
    ...markdownList("trigger_phrases", payload.trigger_phrases),
    ...markdownList("derives_from", payload.derives_from),
  ];
  if (body.scope.kind === "project" && body.scope.project_id) frontmatter.push(`project_id: ${markdownString(body.scope.project_id)}`);
  frontmatter.push("---", "");
  return [
    ...frontmatter,
    normalizeCompiledTruth(payload.title, payload.compiled_truth),
    "",
    "## Timeline",
    "",
    `- ${timestamp} | ${body.session_id || "sediment"} | projected | ${payload.timeline_note || "projected from Knowledge Evidence Event"}`,
    "",
  ].join("\n");
}

function isStrictKnowledgeEvent(body) {
  return Boolean(
    body?.producer?.version === "adr0039-p5"
    || body?.device_id
    || body?.sanitizer
    || body?.producer_nonce
    || body?.device_event_seq,
  );
}

function splitMarkdownProjection(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { frontmatter: match[1], body: match[2].trim() } : { frontmatter: "", body: raw.trim() };
}

function frontmatterScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return "";
  const raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  return raw;
}

function eventSearchCorpusRow(envelope, renderedMarkdown) {
  const body = envelope.body;
  const payload = body.payload ?? {};
  const scope = body.scope ?? {};
  return {
    event_id: envelope.event_id,
    slug: String(payload.slug ?? ""),
    scope: String(scope.kind ?? ""),
    project_id: String(scope.project_id ?? ""),
    title: String(payload.title ?? ""),
    kind: String(payload.kind ?? ""),
    status: String(payload.status ?? ""),
    confidence: Number(payload.confidence ?? 0),
    provenance: String(payload.provenance ?? ""),
    trigger_phrases: Array.isArray(payload.trigger_phrases) ? payload.trigger_phrases.map(String).sort() : [],
    derives_from: Array.isArray(payload.derives_from) ? payload.derives_from.map(String).sort() : [],
    search_text_hash: sha256Hex(String(renderedMarkdown).trim()),
  };
}

function projectionSearchCorpusRow(eventId, raw) {
  const parsed = splitMarkdownProjection(raw);
  return {
    event_id: eventId,
    slug: path.basename(`/${frontmatterScalar(parsed.frontmatter, "id")}`).replace(/^.*:/, ""),
    scope: frontmatterScalar(parsed.frontmatter, "scope"),
    project_id: frontmatterScalar(parsed.frontmatter, "project_id"),
    title: frontmatterScalar(parsed.frontmatter, "title"),
    kind: frontmatterScalar(parsed.frontmatter, "kind"),
    status: frontmatterScalar(parsed.frontmatter, "status"),
    confidence: Number(frontmatterScalar(parsed.frontmatter, "confidence") || 0),
    provenance: frontmatterScalar(parsed.frontmatter, "provenance"),
    search_text_hash: sha256Hex(raw.trim()),
  };
}

function validateKnowledgeProjection(abrainHome, latestDir, projectionMode = "single") {
  const latest = latestDir;
  if (!fs.existsSync(latest)) return { projectedFiles: 0, failures: [], searchCorpusRows: 0 };
  const failures = [];
  const knowledge = loadKnowledgeEvidenceModule();
  const markdownFiles = listFiles(latest, (file) => file.endsWith(".md"));
  // ADR0039 B2/B3: in topo mode the expected bytes are the deterministic fold
  // of the whole identity event set, so reconcile re-renders via the same
  // set-projection. Build the identity->nodes map in a single L1 scan (O(N)).
  const nodesByIdentity = new Map();
  if (projectionMode === "topo") {
    for (const eventFile of listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json"))) {
      const env = readJson(eventFile);
      if (env.body?.event_schema_version !== "knowledge-evidence-event/v1") continue;
      const id = knowledge.knowledgeIdentityKey(env.body);
      if (!nodesByIdentity.has(id)) nodesByIdentity.set(id, []);
      nodesByIdentity.get(id).push({ eventId: env.event_id, body: env.body });
    }
  }
  const projectedByEvent = new Map();
  const searchRowsFromEvents = new Map();
  const searchRowsFromProjection = new Map();
  const manifest = path.join(latest, "manifest.json");
  const manifestEventIds = readManifestEventIds(manifest);
  if (!fs.existsSync(manifest) && markdownFiles.length > 0) failures.push("knowledge-projection/latest: missing_manifest_for_projected_markdown");
  for (const eventId of manifestEventIds) {
    if (!/^[0-9a-f]{64}$/.test(eventId)) {
      failures.push(`knowledge-projection/latest/manifest.json: invalid_event_id:${eventId}`);
      continue;
    }
    const eventPath = expectedEventPath(abrainHome, eventId);
    if (!fs.existsSync(eventPath)) failures.push(`knowledge-projection/latest/manifest.json: missing_l1_event:${eventId}`);
  }
  for (const file of markdownFiles) {
    const rel = relativeUnix(abrainHome, file);
    const raw = fs.readFileSync(file, "utf8");
    const match = raw.match(/^sediment_event_id:\s*([0-9a-f]{64})$/m);
    if (!match) {
      failures.push(`${rel}: missing_sediment_event_id`);
      continue;
    }
    const eventId = match[1];
    const eventPath = expectedEventPath(abrainHome, eventId);
    if (!fs.existsSync(eventPath)) {
      failures.push(`${rel}: missing_l1_event:${eventId}`);
      continue;
    }
    const envelope = readJson(eventPath);
    const strict = isStrictKnowledgeEvent(envelope.body);
    if (strict) {
      const verify = knowledge.verifyKnowledgeEvidenceEnvelope?.(envelope);
      if (verify && verify.ok !== true) failures.push(`${relativeUnix(abrainHome, eventPath)}: knowledge_envelope_${verify.reason}`);
    }
    const expectedPath = expectedKnowledgeOutputPath(latest, envelope.body);
    if (path.resolve(file) !== path.resolve(expectedPath)) failures.push(`${rel}: projection_path_mismatch`);
    if (envelope.body?.intent?.operation_hint === "delete") failures.push(`${rel}: delete_event_left_projected_markdown:${eventId}`);
    let expectedBytes;
    if (projectionMode === "topo") {
      const proj = knowledge.renderKnowledgeProjectionFromSet(nodesByIdentity.get(knowledge.knowledgeIdentityKey(envelope.body)) ?? [{ eventId, body: envelope.body }]);
      expectedBytes = proj.kind === "delete" ? null : proj.markdown;
    } else {
      expectedBytes = strict
        ? knowledge.renderKnowledgeProjectionMarkdown(envelope.body, eventId)
        : renderLegacyKnowledgeProjectionMarkdown(envelope.body, eventId);
    }
    if (expectedBytes !== null && raw !== expectedBytes) failures.push(`${rel}: projection_byte_mismatch:${eventId}`);
    projectedByEvent.set(eventId, rel);
    const eventRow = eventSearchCorpusRow(envelope, expectedBytes);
    const projectionRow = projectionSearchCorpusRow(eventId, raw);
    searchRowsFromEvents.set(eventId, eventRow);
    searchRowsFromProjection.set(eventId, projectionRow);
    for (const key of ["slug", "scope", "project_id", "title", "kind", "status", "confidence", "provenance", "search_text_hash"]) {
      if (eventRow[key] !== projectionRow[key]) failures.push(`${rel}: search_corpus_ab_mismatch:${key}:${eventId}`);
    }
  }
  // Single-event→single-file projector (pre-B2 topological projection): a slug
  // that received multiple events keeps only the LATEST event's markdown, so
  // superseded older events are expected to be unprojected. Group L1 knowledge
  // events by (scope, project_id, slug) identity key and only require the
  // latest event per group to be projected. When B2 set-projection lands this
  // tightens to verifying the full input event set.
  const latestByIdentity = new Map();
  for (const eventFile of listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json"))) {
    const envelope = readJson(eventFile);
    if (envelope.body?.event_schema_version !== "knowledge-evidence-event/v1") continue;
    const body = envelope.body;
    const identity = `${body.scope?.kind ?? "unknown"}:${body.scope?.project_id ?? ""}:${body.payload?.slug ?? ""}`;
    const prior = latestByIdentity.get(identity);
    const key = `${body.created_at_utc ?? ""}:${envelope.event_id}`;
    if (!prior || key > prior.key) latestByIdentity.set(identity, { key, eventFile, envelope });
  }
  for (const { eventFile, envelope } of latestByIdentity.values()) {
    const eventId = envelope.event_id;
    const expectedPath = expectedKnowledgeOutputPath(latest, envelope.body);
    if (envelope.body.intent?.operation_hint === "delete") {
      if (fs.existsSync(expectedPath)) failures.push(`${relativeUnix(abrainHome, expectedPath)}: stale_projection_after_delete:${eventId}`);
      continue;
    }
    if (!fs.existsSync(expectedPath)) failures.push(`${relativeUnix(abrainHome, eventFile)}: missing_projected_markdown:${eventId}`);
    if (!searchRowsFromProjection.has(eventId)) failures.push(`${relativeUnix(abrainHome, eventFile)}: missing_search_corpus_projection:${eventId}`);
  }
  return { projectedFiles: markdownFiles.length, failures, projectedEvents: projectedByEvent.size, searchCorpusRows: searchRowsFromEvents.size };
}

function readDecisionInputRoot(decisionPath) {
  if (!fs.existsSync(decisionPath)) return "";
  const decision = readJson(decisionPath);
  return String(decision.inputRootHash || decision.input_root_hash || "");
}

// ADR0039 guard-hardening (4xT0 unanimous 2026-06-21). Constraint-shadow
// liveness is a LOGICAL set-difference over constraint-evidence events only,
// discriminated by the PEEKED top-level envelope `schema` (never a substring --
// knowledge bodies can contain the literal schema string). fs-mtime is NOT used
// (non-deterministic across clone/checkout). Mirrors NS-2 FOREIGN_SKIP allowlist.
const CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA = "constraint-evidence-envelope/v1";
// Canonical-path R3.4.2 P1-S3: the KNOWN set is registry-driven — the central
// machine schema-role registry is the single source of truth for which
// envelope schemas may exist in L1 (active canonical/evidence plus approved
// phase-disabled future meta schemas). No second hardcoded allowlist.
const KNOWN_L1_ENVELOPE_SCHEMAS = new Set(
  JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), "utf8"))
    .entries.map((entry) => entry.envelope_schema),
);
function sanitizeSchemaLabel(value) {
  return String(value).replace(/[^\x20-\x7e]/g, "").slice(0, 64);
}
function humanizeMs(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}
function spawnSyncGit(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function scanConstraintEvidenceEvents(abrainHome) {
  const events = [];
  const unknown = new Set();
  for (const file of listFiles(path.join(abrainHome, "l1", "events", "sha256"), (f) => f.endsWith(".json"))) {
    let env;
    try { env = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const schema = env && typeof env.schema === "string" ? env.schema : undefined;
    if (schema === CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA) {
      events.push({ eventId: String(env.event_id || ""), createdAtUtc: String(env.body?.created_at_utc || "") });
    } else if (schema === undefined || !KNOWN_L1_ENVELOPE_SCHEMAS.has(schema)) {
      unknown.add(sanitizeSchemaLabel(schema ?? "(none)"));
    }
  }
  return { events, unknown };
}

// Returns { present, warnings(advisory, never blocks), liveness(standalone
// reconcile non-zero, NOT push-blocking) }. The constraint shadow bundle lives
// under gitignored .state, so NOTHING here is push-blocking (ADR0039 §6 accepts
// stale). §12 dead-projector + unknown L1 schema are surfaced as liveness so a
// standalone `reconcile:adr0039` (CI) goes red without blocking pushes.
function validateConstraintShadow(abrainHome, opts) {
  const latest = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  if (!fs.existsSync(latest)) return { present: false, warnings: [], liveness: [] };
  const warnings = [];
  const liveness = [];
  const decisionPath = path.join(latest, "decision.json");
  const coveragePath = path.join(latest, "event-coverage.json");
  for (const name of ["decision.json", "compiled-view.md", "event-coverage.json"]) {
    if (!fs.existsSync(path.join(latest, name))) warnings.push(`constraint-shadow/latest: missing_${name}`);
  }
  const inputRootHash = readDecisionInputRoot(decisionPath);
  if (inputRootHash && !/^[0-9a-f]{64}$/.test(inputRootHash)) warnings.push("constraint-shadow/latest/decision.json: invalid_input_root_hash");

  const { events: evidenceEvents, unknown } = scanConstraintEvidenceEvents(abrainHome);
  for (const schema of unknown) liveness.push(`constraint-shadow: unknown_envelope_schema_in_l1:${schema}`);

  let projected = null;
  if (fs.existsSync(coveragePath)) {
    try {
      const coverage = readJson(coveragePath);
      const strictRatio = Number(coverage.summary?.coverageRatio ?? coverage.summary?.coverage_ratio ?? coverage.coverageRatio ?? coverage.coverage_ratio ?? 0);
      const injectableRatio = Number(coverage.summary?.injectableCoverageRatio ?? coverage.summary?.injectable_coverage_ratio ?? strictRatio);
      if (!Number.isFinite(injectableRatio) || injectableRatio < opts.minCoverageRatio) warnings.push(`constraint-shadow/latest/event-coverage.json: coverage_below_min:${injectableRatio}`);
      // Settled = reached the shadow (status "projected") OR the compiler
      // processed and legitimately deferred it: merged_source (folded into a
      // merge target) or unresolved (explicitly deferred). Only genuinely-
      // unprocessed events (no settled disposition) signal a dead/stalled
      // projector. Counting status!=projected alone falsely flagged aged
      // merged_source/unresolved events as §12 dead-projector even though the
      // projector ran ok; counting ALL rows (the original bug) masked genuinely
      // pending events. This middle ground flags only the truly-unprocessed.
      projected = new Set((coverage.rows ?? [])
        .filter((row) => row.status === "projected" || row.disposition === "merged_source" || row.disposition === "unresolved")
        .map((row) => String(row.eventId || ""))
        .filter(Boolean));
    } catch {
      warnings.push("constraint-shadow/latest/event-coverage.json: unreadable_§12_skipped");
    }
  } else {
    warnings.push("constraint-shadow/latest/event-coverage.json: missing_§12_skipped");
  }

  if (projected) {
    const queued = evidenceEvents.filter((event) => event.eventId && !projected.has(event.eventId));
    if (queued.length) {
      warnings.push(`constraint-shadow: stale_per_§6:queued_${queued.length}`);
      const now = Date.now();
      const deadProjectorAfterMs = Number(opts.deadProjectorAfterMs ?? 4 * 60 * 60 * 1000);
      const aged = queued
        .map((event) => ({ ageMs: event.createdAtUtc ? now - Date.parse(event.createdAtUtc) : NaN }))
        .filter((event) => Number.isFinite(event.ageMs) && event.ageMs > deadProjectorAfterMs);
      if (aged.length) {
        const maxAgeMs = Math.max(...aged.map((event) => event.ageMs));
        liveness.push(`constraint-shadow: §12_dead_projector:queued_${aged.length}:max_age_${humanizeMs(maxAgeMs)}`);
      }
    }
  }
  return { present: true, warnings, liveness };
}

// ADR0039 §4.2 L1 append-only (4xT0 R-B): the not-yet-pushed range may only ADD
// files under l1/. Modify/delete/copy/type-change of an existing L1 event breaks
// the content-addressed immutable-by-path invariant on PUSHED content = blocker.
// Logic lives here (single source of truth; standalone reconcile surfaces it) and
// is enforced at pre-push via the existing spawn. Graceful skip+WARN when not a
// git repo or origin/main is unavailable (fresh clone / first push) so CI after
// a clean push does not go permanently red. Dirty derived checks still run
// independently even when this pushed range cannot be computed. --no-renames =>
// a rename shows as D+A; the D blocks.
function validateL1AppendOnlyOnPushedRange(abrainHome) {
  if (!fs.existsSync(path.join(abrainHome, ".git"))) return { failures: [], warnings: ["l1_append_only: skipped:not_a_git_repo"] };
  const originMain = spawnSyncGit(abrainHome, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  if (originMain.status !== 0 || !originMain.stdout.trim()) return { failures: [], warnings: ["l1_append_only: skipped:origin_main_missing"] };
  const diff = spawnSyncGit(abrainHome, ["diff", "--name-status", "--no-renames", "-z", "origin/main..HEAD", "--", "l1/"]);
  if (diff.status !== 0) return { failures: [], warnings: ["l1_append_only: skipped:git_diff_failed"] };
  const failures = [];
  const tokens = diff.stdout.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i][0];
    const rel = tokens[i + 1];
    if (code === "A") continue;
    failures.push(`l1_append_only_violated:${code}:${rel}`);
  }
  return { failures, warnings: [] };
}

function gitStatusPorcelain(cwd) {
  if (!fs.existsSync(path.join(cwd, ".git"))) return Buffer.alloc(0);
  return execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "-uall"], { encoding: "buffer" });
}

function validateDirtyDerived(abrainHome) {
  const records = parseGitStatusPorcelainV1Z(gitStatusPorcelain(abrainHome));
  const failures = [];
  for (const record of records) {
    for (const rel of record.paths) {
      if (rel.startsWith(".state/sediment/constraint-shadow/") || rel.startsWith(".state/sediment/knowledge-projection/") || rel.startsWith("l2/views/knowledge/") || rel.startsWith("l2/views/constraint/")) {
        failures.push(`dirty_derived_view:${record.status} ${record.paths.join(" -> ")}`);
        break;
      }
    }
  }
  return { failures };
}

// ADR0039 Constraint L2 (§4.4 / FIX-1 + Part B 2026-06-24, 3/4 T0): the
// git-tracked L2 view is a DEVICE-INDEPENDENT deterministic re-render keyed by
// decision_hash (a pure fold of the validated decision), NOT the per-device
// projection event_id (which embeds device_id/created_at_utc). Map L2 -> L1 by
// scanning constraint-projection events for one whose validated_decision hashes
// to the L2's decision_hash, re-render via the same renderer, and byte-compare.
// Staleness: the L2's decision_hash MUST equal the chronologically-latest
// projection event's decision_hash (a newer event with a DIFFERENT decision =>
// the L2 is stale; a newer event with the SAME decision, e.g. another device's
// compile of the same inputs, is fine). A mismatch is a dirty derived view.
function validateConstraintL2(abrainHome) {
  const l2Path = path.join(abrainHome, "l2", "views", "constraint", "latest", "compiled-view.md");
  if (!fs.existsSync(l2Path)) return { present: false, failures: [] };
  const failures = [];
  const raw = fs.readFileSync(l2Path, "utf8");
  const { frontmatter } = splitMarkdownProjection(raw);
  const decisionHash = frontmatterScalar(frontmatter, "decision_hash");
  if (!decisionHash) return { present: true, failures: ["constraint-l2: missing_decision_hash"] };
  const render = loadConstraintRenderModule();
  const decisionHashFor = (decision, eventId) => {
    try { return render.renderConstraintL2View(decision, eventId).decisionHash; } catch { return null; }
  };
  // Scan all constraint-projection events; record (eventId, decision, decisionHash, createdAtUtc).
  const projectionEvents = [];
  const eventsRoot = path.join(abrainHome, "l1", "events", "sha256");
  const walkProjections = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkProjections(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        let env;
        try { env = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
        if (env.schema !== "constraint-projection-envelope/v1" || !env.event_id || !env.body || !env.body.validated_decision) continue;
        if (env.event_id !== env.body_hash) { failures.push(`constraint-l2: envelope_hash_mismatch:${env.event_id}`); continue; }
        projectionEvents.push({
          eventId: env.event_id,
          decision: env.body.validated_decision,
          decisionHash: decisionHashFor(env.body.validated_decision, env.event_id),
          createdAtUtc: (env.body && env.body.created_at_utc) || "",
        });
      }
    }
  };
  walkProjections(eventsRoot);
  // Map L2 -> a projection event by decision_hash (device-independent).
  const match = projectionEvents.find((e) => e.decisionHash === decisionHash);
  if (!match) return { present: true, failures: [...failures, `constraint-l2: no_projection_event_for_decision:${decisionHash.slice(0, 16)}`] };
  // Byte-compare: re-render (device-independent) from the matched decision.
  try {
    const reRender = render.renderConstraintL2View(match.decision, match.eventId).markdown;
    if (reRender !== raw) failures.push(`constraint-l2: projection_byte_mismatch:${decisionHash.slice(0, 16)}`);
  } catch (err) {
    failures.push(`constraint-l2: re_render_failed:${decisionHash.slice(0, 16)}:${err && err.message ? String(err.message).slice(0, 80) : err}`);
  }
  // Staleness: L2's decision_hash must equal the LATEST projection event's decision_hash.
  if (projectionEvents.length) {
    const latest = [...projectionEvents].sort((a, b) =>
      b.createdAtUtc.localeCompare(a.createdAtUtc) || b.eventId.localeCompare(a.eventId))[0];
    if (latest.decisionHash !== decisionHash) {
      failures.push(`constraint-l2: stale_l2_newer_projection_exists:${decisionHash.slice(0, 16)}:${(latest.decisionHash || "?").slice(0, 16)}`);
    }
  }
  return { present: true, failures };
}

async function validateL3Store(abrainHome, knowledgeLatestDir) {
  if (!process.versions.sqlite) return { ok: false, dbPath: null, counts: null, failures: ["adr0039-l3: node_sqlite_unavailable"] };
  const l3 = loadAdr0039L3Module();
  const result = await l3.syncAdr0039L3Store({ abrainHome, knowledgeLatestDir });
  return result;
}

// ADR0039 B0 coverage hard-gate (report mode): quantify how many legacy
// canonical Knowledge entries already have a backing L1 Evidence Event. The
// canonical=projection flip (B5) must NOT proceed until this reaches 1.0,
// otherwise the flip silently drops legacy entries that predate the event
// writer. Pre-backfill this is expected to be near-zero; it is report-only
// here and only becomes a blocking gate behind an explicit flag at flip time.
const LEGACY_KNOWLEDGE_PROJECT_ZONES = ["knowledge", "decisions", "maxims"];
function legacyEntrySlug(file) {
  return path.basename(file, ".md");
}
function computeLegacyKnowledgeCoverage(abrainHome) {
  const legacy = new Map();
  for (const file of listFiles(path.join(abrainHome, "knowledge"), (f) => f.endsWith(".md"))) {
    legacy.set(`world::${legacyEntrySlug(file)}`, relativeUnix(abrainHome, file));
  }
  const projectsRoot = path.join(abrainHome, "projects");
  if (fs.existsSync(projectsRoot)) {
    for (const pid of fs.readdirSync(projectsRoot)) {
      if (!fs.statSync(path.join(projectsRoot, pid)).isDirectory()) continue;
      for (const zone of LEGACY_KNOWLEDGE_PROJECT_ZONES) {
        for (const file of listFiles(path.join(projectsRoot, pid, zone), (f) => f.endsWith(".md"))) {
          legacy.set(`project:${pid}:${legacyEntrySlug(file)}`, relativeUnix(abrainHome, file));
        }
      }
    }
  }
  const l1 = new Set();
  for (const file of listFiles(path.join(abrainHome, "l1", "events"), (f) => f.endsWith(".json"))) {
    let body;
    try { body = readJson(file).body; } catch { continue; }
    if (body?.event_schema_version !== "knowledge-evidence-event/v1") continue;
    const scope = body.scope ?? {};
    const slug = body.payload?.slug;
    if (scope.kind === "world") l1.add(`world::${slug}`);
    else if (scope.kind === "project") l1.add(`project:${scope.project_id}:${slug}`);
  }
  const missing = [];
  let covered = 0;
  for (const [identity, rel] of legacy) {
    if (l1.has(identity)) covered += 1;
    else missing.push({ identity, path: rel });
  }
  const total = legacy.size;
  return {
    total,
    covered,
    missing: missing.length,
    ratio: total === 0 ? 1 : covered / total,
    backfillNeeded: missing.length > 0,
    missingSample: missing.slice(0, 5),
  };
}

function loadRuntimeThresholds() {
  const cfg = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
  const compiled = cfg.ruleInjector?.compiledViewInjection ?? {};
  const shadowAuto = cfg.sediment?.constraintShadowCompiler?.autoRefresh ?? {};
  return {
    staleAfterMs: Number(compiled.staleAfterMs ?? shadowAuto.eventStaleAfterMs ?? 24 * 60 * 60 * 1000),
    minCoverageRatio: Number(compiled.minCoverageRatio ?? 1),
    deadProjectorAfterMs: Number(cfg.sediment?.constraintShadowCompiler?.deadProjectorAfterMs ?? 4 * 60 * 60 * 1000),
  };
}

async function reconcile(abrainHome, opts = loadRuntimeThresholds()) {
  const l1 = validateL1Events(abrainHome);
  const knowledgeLatestDir = resolveKnowledgeLatestDir(abrainHome, opts.knowledgeLatestDir);
  const projectionMode = resolveProjectionMode(opts.projectionMode);
  const knowledge = validateKnowledgeProjection(abrainHome, knowledgeLatestDir, projectionMode);
  const constraint = validateConstraintShadow(abrainHome, opts);
  const constraintL2 = validateConstraintL2(abrainHome);
  const l3 = await validateL3Store(abrainHome, knowledgeLatestDir);
  const coverage = computeLegacyKnowledgeCoverage(abrainHome);
  const dirty = validateDirtyDerived(abrainHome);
  const l1AppendOnly = validateL1AppendOnlyOnPushedRange(abrainHome);
  const l3SearchCorpusFailures = [];
  if (l3.counts && Number(l3.counts.searchCorpusRows ?? 0) !== Number(knowledge.searchCorpusRows ?? 0)) {
    l3SearchCorpusFailures.push(`adr0039-l3: search_corpus_row_mismatch:${l3.counts.searchCorpusRows ?? 0}:${knowledge.searchCorpusRows ?? 0}`);
  }
  // blocker tier = PUSHED-content integrity only (drives pre-push block + standalone non-zero).
  const failures = [...l1.failures, ...knowledge.failures, ...constraintL2.failures, ...l3.failures, ...l3SearchCorpusFailures, ...dirty.failures, ...l1AppendOnly.failures];
  // liveness tier = standalone reconcile non-zero (CI alarm) but NOT push-blocking (gitignored .state).
  const liveness = [...(constraint.liveness ?? [])];
  // advisory tier = WARN only, never affects exit code.
  const warnings = [...(constraint.warnings ?? []), ...(l1AppendOnly.warnings ?? [])];
  return { abrainHome, l1, knowledge, constraint, constraintL2, l3, coverage, dirty, l1AppendOnly, failures, liveness, warnings };
}

function printResult(result) {
  console.log(`abrainHome: ${result.abrainHome}`);
  console.log(`l1_events: ${result.l1.files}`);
  console.log(`b0_legacy_knowledge_entries: ${result.coverage.total}`);
  console.log(`b0_covered_by_l1_event: ${result.coverage.covered}`);
  console.log(`b0_coverage_ratio: ${result.coverage.ratio.toFixed(4)}`);
  console.log(`b0_legacy_import_backfill_needed: ${result.coverage.backfillNeeded}`);
  if (result.coverage.missing > 0) {
    console.log(`b0_missing_sample: ${result.coverage.missingSample.map((m) => m.identity).join(", ")}`);
  }
  console.log(`l3_event_edges: ${result.l3.counts?.eventEdges ?? 0}`);
  console.log(`knowledge_projected_files: ${result.knowledge.projectedFiles}`);
  console.log(`knowledge_search_corpus_rows: ${result.knowledge.searchCorpusRows ?? 0}`);
  console.log(`l3_search_corpus_rows: ${result.l3.counts?.searchCorpusRows ?? 0}`);
  console.log(`constraint_shadow_present: ${result.constraint.present}`);
  console.log(`constraint_l2_present: ${result.constraintL2?.present ?? false}`);
  console.log(`l3_db: ${result.l3.dbPath || "unavailable"}`);
  for (const warning of result.warnings ?? []) console.log(`  WARN  ${warning}`);
  for (const signal of result.liveness ?? []) console.log(`  LIVENESS  ${signal}`);
  if (result.failures.length) {
    for (const failure of result.failures) console.log(`  FAIL  ${failure}`);
    console.log(`FAIL — ${result.failures.length} reconcile blocker(s) failed.`);
  } else {
    console.log("PASS — ADR0039 reconcile push-gate checks passed.");
  }
  if ((result.liveness ?? []).length) {
    console.log(`LIVENESS — ${result.liveness.length} non-blocking projector-liveness signal(s) (standalone reconcile non-zero; not push-blocking).`);
  }
}

async function buildFixtureTree(l2OutputRoot = "state") {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-reconcile-"));
  const knowledge = loadKnowledgeEvidenceModule();
  const settings = {
    knowledgeEvidenceEventWriter: {
      enabled: true,
      mode: "parallel_legacy",
      legacyFallbackOnEventFailure: true,
    },
    knowledgeProjector: {
      enabled: true,
      hotOverlayEnabled: true,
      projectOnWrite: true,
      maxReadBytes: 1000000,
      l2OutputRoot,
    },
  };
  const result = await knowledge.appendKnowledgeEvidenceForWrite({
    abrainHome,
    projectId: "pi-global",
    scope: "project",
    draft: {
      title: "ADR0039 Reconcile Fixture",
      kind: "fact",
      status: "active",
      provenance: "assistant-observed",
      confidence: 8,
      compiledTruth: "# ADR0039 Reconcile Fixture\n\nFixture projection.",
      triggerPhrases: ["adr0039 reconcile fixture"],
      derivesFrom: [],
      sessionId: "smoke-adr0039-reconcile",
    },
    result: {
      slug: "adr0039-reconcile-fixture",
      path: path.join(abrainHome, "projects", "pi-global", "facts", "adr0039-reconcile-fixture.md"),
      status: "created",
      gitCommit: null,
    },
    settings,
    auditContext: { lane: "smoke", sessionId: "smoke-adr0039-reconcile" },
    sessionId: "smoke-adr0039-reconcile",
    operation: "create",
    createdAtUtc: "2026-06-20T00:00:00.000Z",
  });
  if (!result.append.ok || !result.append.eventId) throw new Error(`knowledge append failed: ${JSON.stringify(result)}`);
  if (result.projection?.status !== "projected") throw new Error(`knowledge projection failed: ${JSON.stringify(result.projection)}`);
  const stores = await knowledge.readKnowledgeProjectionStores({ abrainHome, projectId: "pi-global", settings });
  if (stores.length !== 1 || stores[0].label !== "knowledge-projection-project") throw new Error(`projection overlay stores missing: ${JSON.stringify(stores)}`);
  const latest = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  writeFile(path.join(latest, "decision.json"), `${JSON.stringify({ schemaVersion: "constraint-shadow-decision/v1", inputRootHash: sha256Hex("fixture") }, null, 2)}\n`);
  writeFile(path.join(latest, "compiled-view.md"), "# fixture compiled view\n");
  writeFile(path.join(latest, "event-coverage.json"), `${JSON.stringify({ coverageRatio: 1 }, null, 2)}\n`);
  return { abrainHome, eventId: result.append.eventId };
}

if (hasFlag("abrain")) {
  const pushGateOnly = hasFlag("push-gate-only");
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const result = await reconcile(abrainHome);
  printResult(result);
  // pre-push passes --push-gate-only: only blocker-tier (pushed content) blocks.
  // standalone (CI): blocker + liveness (§12 dead-projector / unknown schema) -> non-zero.
  const exitNonZero = pushGateOnly ? result.failures.length > 0 : (result.failures.length + result.liveness.length) > 0;
  process.exit(exitNonZero ? 1 : 0);
}

console.log("ADR0039 reconcile smoke");

// The incremental reconcile hint consumes porcelain v1 -z as bytes. Exercise
// raw UTF-8, two-path records, malformed bytes/records, and canonical paths
// directly so a future return to line/C-quote parsing cannot silently fast-path.
{
  const parsed = parseGitStatusPorcelainV1Z(Buffer.from("?? l2/views/知识/真实路径.md\0?? l2/views/keep trailing space \0", "utf8"));
  if (parsed.length !== 2 || parsed[0].paths[0] !== "l2/views/知识/真实路径.md" || parsed[1].paths[0] !== "l2/views/keep trailing space ") {
    console.log(`FAIL — porcelain parser lost UTF-8 or trimmed a path: ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  const moved = parseGitStatusPorcelainV1Z(Buffer.from("R  l2/views/new.md\0l2/views/old.md\0C  l1/copy.md\0l1/source.md\0"));
  if (moved.length !== 2 || moved[0].paths.join("|") !== "l2/views/new.md|l2/views/old.md" || moved[1].paths.join("|") !== "l1/copy.md|l1/source.md") {
    console.log(`FAIL — porcelain parser mishandled rename/copy paths: ${JSON.stringify(moved)}`);
    process.exit(1);
  }
  const rejected = [
    Buffer.concat([Buffer.from("?? l2/"), Buffer.from([0xff, 0])]),
    Buffer.from("?? /absolute\0"),
    Buffer.from("?? l2/../escape\0"),
    Buffer.from("?? l2\\windows\0"),
    Buffer.from("?? l2//double\0"),
    Buffer.from("?? l2/e\u0301.md\0", "utf8"),
    Buffer.from("?? l2/incomplete"),
    Buffer.from("R  l2/new.md\0"),
  ];
  for (const input of rejected) {
    let didReject = false;
    try { parseGitStatusPorcelainV1Z(input); } catch { didReject = true; }
    if (!didReject) {
      console.log(`FAIL — porcelain parser accepted invalid bytes/path/record: ${input.toString("hex")}`);
      process.exit(1);
    }
  }
  console.log("PASS — porcelain v1 -z parser preserves UTF-8/rename/copy and rejects invalid input.");
}

// With core.quotePath's text format this sole dirty path is C-quoted. The gate
// must see its raw -z bytes and spawn the reconcile runner instead of fast-pathing.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-cquoted-gate-"));
  execFileSync("git", ["-C", home, "init", "-q"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "config", "user.email", "adr0039@example.invalid"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "config", "user.name", "ADR0039"], { encoding: "utf8" });
  writeFile(path.join(home, "README"), "baseline\n");
  execFileSync("git", ["-C", home, "add", "README"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "commit", "-q", "-m", "baseline"], { encoding: "utf8" });
  const dirtyPath = path.join(home, "l2", "views", "knowledge", "仅有引号\"路径.md");
  writeFile(dirtyPath, "dirty\n");
  const textStatus = execFileSync("git", ["-C", home, "status", "--porcelain=v1", "-uall", "--", "l1", "l2"], { encoding: "utf8" });
  if (!textStatus.includes('"')) {
    console.log(`FAIL — C-quoted gate fixture was not quoted by text porcelain: ${JSON.stringify(textStatus)}`);
    process.exit(1);
  }
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-cquoted-runner-"));
  writeFile(path.join(fakeRoot, "scripts", "smoke-adr0039-reconcile.mjs"), 'console.log("CQUOTED_RUNNER_RAN");\n');
  const gate = await checkAdr0039ReconcileGate({ abrainHome: home, repoRoot: fakeRoot });
  if (!gate.ok || gate.details.fast_path || !gate.details.stdout.includes("CQUOTED_RUNNER_RAN") || !gate.details.dirtyDerivedPaths.includes("l2/views/knowledge/仅有引号\"路径.md")) {
    console.log(`FAIL — sole C-quoted/UTF-8 dirty path did not run gate: ${JSON.stringify(gate)}`);
    process.exit(1);
  }
  console.log("PASS — sole C-quoted UTF-8 dirty path runs the reconcile gate.");
}

const fixture = await buildFixtureTree();
const stateFixtureOpts = (home) => ({ staleAfterMs: 24 * 60 * 60 * 1000, minCoverageRatio: 1, knowledgeLatestDir: path.join(home, ".state", "sediment", "knowledge-projection", "latest"), projectionMode: "single" });
const clean = await reconcile(fixture.abrainHome, stateFixtureOpts(fixture.abrainHome));
printResult(clean);
if (clean.failures.length) process.exit(1);
const eventPath = expectedEventPath(fixture.abrainHome, fixture.eventId);
const corrupted = readJson(eventPath);
corrupted.body.payload.title = "Corrupted Fixture";
writeFile(eventPath, `${JSON.stringify(corrupted, null, 2)}\n`);
const dirty = await reconcile(fixture.abrainHome, stateFixtureOpts(fixture.abrainHome));
if (!dirty.failures.some((failure) => failure.includes("body_hash_mismatch"))) {
  console.log("FAIL — corrupted fixture did not trigger body_hash_mismatch");
  process.exit(1);
}
console.log("PASS — corrupted fixture is rejected.");

const dirtyViewFixture = await buildFixtureTree();
execFileSync("git", ["-C", dirtyViewFixture.abrainHome, "init"], { encoding: "utf8" });
execFileSync("git", ["-C", dirtyViewFixture.abrainHome, "config", "user.email", "adr0039-smoke@example.invalid"], { encoding: "utf8" });
execFileSync("git", ["-C", dirtyViewFixture.abrainHome, "config", "user.name", "ADR0039 Smoke"], { encoding: "utf8" });
execFileSync("git", ["-C", dirtyViewFixture.abrainHome, "add", "."], { encoding: "utf8" });
execFileSync("git", ["-C", dirtyViewFixture.abrainHome, "commit", "-m", "baseline"], { encoding: "utf8" });
const dirtyProjectedPath = listFiles(path.join(dirtyViewFixture.abrainHome, ".state", "sediment", "knowledge-projection", "latest"), (file) => file.endsWith(".md"))[0];
writeFile(dirtyProjectedPath, `${fs.readFileSync(dirtyProjectedPath, "utf8")}\n<!-- dirty derived view -->\n`);
const dirtyView = await reconcile(dirtyViewFixture.abrainHome, stateFixtureOpts(dirtyViewFixture.abrainHome));
if (!dirtyView.failures.some((failure) => failure.includes("dirty_derived_view:"))) {
  console.log("FAIL — dirty L2 fixture did not trigger dirty_derived_view");
  process.exit(1);
}
console.log("PASS — dirty L2 fixture is rejected.");

// l1-append-only: the not-yet-pushed range (origin/main..HEAD) may only ADD under l1/.
// In-place modify of an existing (already-pushed) L1 event blocks.
{
  const apFixture = await buildFixtureTree();
  const home = apFixture.abrainHome;
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l1ap-remote-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "init", "-b", "main"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "config", "user.email", "adr0039-smoke@example.invalid"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "config", "user.name", "ADR0039 Smoke"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "add", "."], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "commit", "-m", "baseline"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "push", "-u", "origin", "main"], { encoding: "utf8" });
  const originalEvent = listFiles(path.join(home, "l1", "events"), (file) => file.endsWith(".json"))[0];
  // ADD a brand-new l1 event in the pushable range -> allowed (status A).
  const newId = "a".repeat(64);
  writeFile(expectedEventPath(home, newId), `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", event_id: newId, body_hash: newId, body: {} })}\n`);
  execFileSync("git", ["-C", home, "add", "l1"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "commit", "-m", "add l1 event"], { encoding: "utf8" });
  const addOnly = validateL1AppendOnlyOnPushedRange(home);
  if (addOnly.failures.length) {
    console.log(`FAIL — l1-append-only flagged a pure ADD: ${JSON.stringify(addOnly.failures)}`);
    process.exit(1);
  }
  // MODIFY an existing already-pushed l1 event -> blocked (status M).
  writeFile(originalEvent, `${fs.readFileSync(originalEvent, "utf8")}\n`);
  execFileSync("git", ["-C", home, "add", "l1"], { encoding: "utf8" });
  execFileSync("git", ["-C", home, "commit", "-m", "tamper l1 event"], { encoding: "utf8" });
  const tampered = validateL1AppendOnlyOnPushedRange(home);
  if (!tampered.failures.some((failure) => failure.startsWith("l1_append_only_violated:M"))) {
    console.log(`FAIL — l1-append-only did not block an in-place modify: ${JSON.stringify(tampered.failures)}`);
    process.exit(1);
  }
  console.log("PASS — l1-append-only allows ADD, blocks in-place modify in pushed range.");
}

if (process.versions.sqlite) {
  const ftsFixture = await buildFixtureTree();
  const l3 = loadAdr0039L3Module();
  const syncResult = await l3.syncAdr0039L3Store({ abrainHome: ftsFixture.abrainHome });
  if (!syncResult.ok || syncResult.counts.searchCorpusRows !== 1) {
    console.log(`FAIL — L3 search corpus sync did not index the fixture row: ${JSON.stringify(syncResult)}`);
    process.exit(1);
  }
  const { DatabaseSync } = require("node:sqlite");
  const probe = new DatabaseSync(syncResult.dbPath);
  try {
    const hit = probe.prepare("SELECT row_id FROM search_corpus_fts WHERE search_corpus_fts MATCH ?").get("fixture");
    if (!hit || typeof hit.row_id !== "string") {
      console.log(`FAIL — L3 FTS probe did not match the projected fixture body: ${JSON.stringify(hit)}`);
      process.exit(1);
    }
    const stored = probe.prepare("SELECT search_text_hash FROM search_corpus WHERE row_id = ?").get(hit.row_id);
    if (!stored || !/^[0-9a-f]{64}$/.test(String(stored.search_text_hash))) {
      console.log(`FAIL — L3 search corpus row missing search_text_hash: ${JSON.stringify(stored)}`);
      process.exit(1);
    }
  } finally {
    probe.close();
  }
  console.log("PASS — L3 search corpus FTS is rebuildable and queryable.");

  // event_edges: rebuildable from L1 causal_parents only, never a truth source.
  const edgeFixture = await buildFixtureTree();
  const l3edge = loadAdr0039L3Module();
  // synthesize a child event that links the fixture event as a causal parent
  const parentId = edgeFixture.eventId;
  const childBody = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-06-20T01:00:00.000Z",
    device_id: "smoke-device",
    producer_nonce: "smoke-edge-child",
    causal_parents: [parentId],
    session_id: "smoke-edge",
    turn_id: "t1",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: "smoke:edge" },
    intent: { domain_hint: "knowledge", operation_hint: "update" },
    scope: { kind: "project", project_id: "pi-global" },
    payload: { slug: "adr0039-reconcile-fixture", title: "ADR0039 Reconcile Fixture", kind: "fact", status: "active", provenance: "assistant-observed", confidence: 8, compiled_truth: "# x\n\ny", trigger_phrases: [], derives_from: [] },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
  const childId = sha256Hex(canonicalJson(childBody));
  writeFile(expectedEventPath(edgeFixture.abrainHome, childId), `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: childId, body_hash: childId, body: childBody }, null, 0)}\n`);
  const edgeSync = await l3edge.syncAdr0039L3Store({ abrainHome: edgeFixture.abrainHome });
  if (edgeSync.counts.eventEdges !== 1) {
    console.log(`FAIL — L3 event_edges did not rebuild the causal edge: ${JSON.stringify(edgeSync.counts)}`);
    process.exit(1);
  }
  const { DatabaseSync: EdgeDb } = require("node:sqlite");
  const edgeProbe = new EdgeDb(edgeSync.dbPath);
  try {
    const edge = edgeProbe.prepare("SELECT parent_event_id, child_event_id, edge_type FROM event_edges").get();
    if (!edge || edge.parent_event_id !== parentId || edge.child_event_id !== childId || edge.edge_type !== "correction") {
      console.log(`FAIL — L3 event_edges row wrong: ${JSON.stringify(edge)}`);
      process.exit(1);
    }
  } finally {
    edgeProbe.close();
  }
  // dangling parent must be reported (rebuildable-from-L1 invariant)
  const danglingChild = { ...childBody, producer_nonce: "smoke-edge-dangling", causal_parents: ["".padStart(64, "a")] };
  const danglingId = sha256Hex(canonicalJson(danglingChild));
  writeFile(expectedEventPath(edgeFixture.abrainHome, danglingId), `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: danglingId, body_hash: danglingId, body: danglingChild }, null, 0)}\n`);
  const danglingSync = await l3edge.syncAdr0039L3Store({ abrainHome: edgeFixture.abrainHome });
  if (!danglingSync.failures.some((f) => f.includes("l3_event_edge_dangling_parent"))) {
    console.log(`FAIL — dangling causal parent not reported: ${JSON.stringify(danglingSync.failures)}`);
    process.exit(1);
  }
  console.log("PASS — L3 event_edges is rebuildable from L1 and validates causal integrity.");
}

// B0 coverage gate: legacy entry with a matching L1 event counts as covered;
// one without is missing and flags legacy_import backfill necessity.
const covFixture = await buildFixtureTree();
writeFile(path.join(covFixture.abrainHome, "projects", "pi-global", "knowledge", "adr0039-reconcile-fixture.md"), "---\nid: project:pi-global:adr0039-reconcile-fixture\nscope: project\n---\ncovered\n");
writeFile(path.join(covFixture.abrainHome, "projects", "pi-global", "knowledge", "uncovered-legacy-entry.md"), "---\nid: project:pi-global:uncovered-legacy-entry\nscope: project\n---\nmissing\n");
const cov = computeLegacyKnowledgeCoverage(covFixture.abrainHome);
if (cov.total !== 2 || cov.covered !== 1 || Math.abs(cov.ratio - 0.5) > 1e-9 || cov.backfillNeeded !== true) {
  console.log(`FAIL — B0 coverage gate miscomputed: ${JSON.stringify(cov)}`);
  process.exit(1);
}
if (!cov.missingSample.some((m) => m.identity === "project:pi-global:uncovered-legacy-entry")) {
  console.log(`FAIL — B0 coverage gate missing sample wrong: ${JSON.stringify(cov.missingSample)}`);
  process.exit(1);
}
console.log("PASS — B0 legacy coverage gate computes covered/missing and backfill necessity.");

// B1: l2OutputRoot="repo" writes the Knowledge L2 projection into the
// git-trackable l2/ namespace (NOT .state) and reconcile validates it there.
const repoFixture = await buildFixtureTree("repo");
const repoProjected = path.join(repoFixture.abrainHome, "l2", "views", "knowledge", "latest", "projects", "pi-global", "adr0039-reconcile-fixture.md");
if (!fs.existsSync(repoProjected)) {
  console.log(`FAIL — B1 repo mode did not write projection under l2/: ${repoProjected}`);
  process.exit(1);
}
if (fs.existsSync(path.join(repoFixture.abrainHome, ".state", "sediment", "knowledge-projection"))) {
  console.log("FAIL — B1 repo mode must not write the Knowledge projection under .state");
  process.exit(1);
}
const repoReconcile = await reconcile(repoFixture.abrainHome, {
  staleAfterMs: 24 * 60 * 60 * 1000,
  minCoverageRatio: 1,
  knowledgeLatestDir: path.join(repoFixture.abrainHome, "l2", "views", "knowledge", "latest"),
  projectionMode: "single",
});
if (repoReconcile.failures.length) {
  console.log(`FAIL — B1 repo mode reconcile failed: ${JSON.stringify(repoReconcile.failures)}`);
  process.exit(1);
}
if (repoReconcile.knowledge.projectedFiles !== 1 || (repoReconcile.l3.counts?.searchCorpusRows ?? 0) !== 1) {
  console.log(`FAIL — B1 repo mode did not validate l2/ projection: ${JSON.stringify({ k: repoReconcile.knowledge.projectedFiles, c: repoReconcile.l3.counts?.searchCorpusRows })}`);
  process.exit(1);
}
const repoStores = await loadKnowledgeEvidenceModule().readKnowledgeProjectionStores({
  abrainHome: repoFixture.abrainHome,
  projectId: "pi-global",
  settings: { knowledgeProjector: { enabled: true, hotOverlayEnabled: true, l2OutputRoot: "repo" } },
});
if (repoStores.length !== 1 || !repoStores[0].root.includes(`${path.sep}l2${path.sep}views${path.sep}knowledge${path.sep}`)) {
  console.log(`FAIL — B1 repo overlay store did not resolve l2/ root: ${JSON.stringify(repoStores)}`);
  process.exit(1);
}
console.log("PASS — B1 Knowledge L2 migrates to git-trackable l2/ namespace (flag-guarded, reconcile-validated).");

// B2: deterministic topological set projection.
{
  const km = loadKnowledgeEvidenceModule();
  const mkBody = (slug, createdAt, op, parents = [], extra = {}) => ({
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: createdAt,
    device_id: extra.device_id || "dev-a",
    ...(extra.device_event_seq !== undefined ? { device_event_seq: extra.device_event_seq } : {}),
    causal_parents: parents,
    session_id: extra.session_id || "sess-1",
    turn_id: "t1",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: "smoke:b2" },
    intent: { domain_hint: "knowledge", operation_hint: op },
    scope: { kind: "project", project_id: "pi-global" },
    payload: { slug, title: extra.title || slug, kind: "fact", status: "active", provenance: "assistant-observed", confidence: 7, compiled_truth: extra.truth || `# ${slug}\n\nbody`, trigger_phrases: [], derives_from: [] },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  });

  // (1) degeneration: single event with no parents == per-event renderer, byte-identical
  const soloBody = mkBody("b2-solo", "2026-06-20T10:00:00.000Z", "create");
  const soloId = sha256Hex(canonicalJson(soloBody));
  const single = km.renderKnowledgeProjectionMarkdown(soloBody, soloId);
  const fromSetSolo = km.renderKnowledgeProjectionFromSet([{ eventId: soloId, body: soloBody }]);
  if (fromSetSolo.kind !== "entry" || fromSetSolo.markdown !== single || fromSetSolo.inputEventSetHash !== soloId) {
    console.log("FAIL — B2 single-event degeneration is not byte-identical to per-event renderer");
    process.exit(1);
  }

  // (2) determinism: same set in any input order → identical bytes + set hash
  const createBody = mkBody("b2-multi", "2026-06-20T10:00:00.000Z", "create", [], { title: "old-title" });
  const createId = sha256Hex(canonicalJson(createBody));
  const updateBody = mkBody("b2-multi", "2026-06-20T10:10:00.000Z", "update", [], { title: "new-title", truth: "# new\n\nupdated body" });
  const updateId = sha256Hex(canonicalJson(updateBody));
  const a = km.renderKnowledgeProjectionFromSet([{ eventId: createId, body: createBody }, { eventId: updateId, body: updateBody }]);
  const b = km.renderKnowledgeProjectionFromSet([{ eventId: updateId, body: updateBody }, { eventId: createId, body: createBody }]);
  if (a.markdown !== b.markdown || a.inputEventSetHash !== b.inputEventSetHash) {
    console.log("FAIL — B2 projection is not order-deterministic");
    process.exit(1);
  }

  // (3) multi-event fold: latest event wins payload, earliest supplies created,
  //     input_event_set_hash is the Merkle of sorted ids, winner is the update.
  const expectedSetHash = sha256Hex(canonicalJson([createId, updateId].slice().sort()));
  if (a.winnerEventId !== updateId || a.inputEventSetHash !== expectedSetHash) {
    console.log(`FAIL — B2 winner/sethash wrong: ${JSON.stringify({ w: a.winnerEventId, h: a.inputEventSetHash, e: expectedSetHash })}`);
    process.exit(1);
  }
  if (!a.markdown.includes("created: 2026-06-20T10:00:00.000Z") || !a.markdown.includes("updated: 2026-06-20T10:10:00.000Z") || !a.markdown.includes(`sediment_event_id: ${updateId}`) || !a.markdown.includes("title: new-title")) {
    console.log("FAIL — B2 multi-event fold did not use earliest-created / winner-payload");
    process.exit(1);
  }

  // (4) causal edge overrides timestamp: child wins even when its created_at is earlier
  const parentLate = mkBody("b2-causal", "2026-06-20T12:00:00.000Z", "create");
  const parentLateId = sha256Hex(canonicalJson(parentLate));
  const childEarly = mkBody("b2-causal", "2026-06-20T09:00:00.000Z", "update", [parentLateId], { title: "child-wins" });
  const childEarlyId = sha256Hex(canonicalJson(childEarly));
  const causal = km.renderKnowledgeProjectionFromSet([{ eventId: childEarlyId, body: childEarly }, { eventId: parentLateId, body: parentLate }]);
  if (causal.winnerEventId !== childEarlyId || !causal.markdown.includes("title: child-wins")) {
    console.log(`FAIL — B2 causal DAG did not override timestamp ordering: ${causal.winnerEventId}`);
    process.exit(1);
  }

  // (5) delete tombstone: topologically-last delete yields no entry
  const delBody = mkBody("b2-multi", "2026-06-20T10:20:00.000Z", "delete");
  const delId = sha256Hex(canonicalJson(delBody));
  const tomb = km.renderKnowledgeProjectionFromSet([{ eventId: createId, body: createBody }, { eventId: updateId, body: updateBody }, { eventId: delId, body: delBody }]);
  if (tomb.kind !== "delete") {
    console.log("FAIL — B2 delete tombstone not detected");
    process.exit(1);
  }

  // (6) collectKnowledgeEventSet reads the full identity set from L1
  const setFixture = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-b2-collect-"));
  for (const [id, body] of [[createId, createBody], [updateId, updateBody]]) {
    writeFile(expectedEventPath(setFixture, id), `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: id, body_hash: id, body }, null, 0)}\n`);
  }
  const collected = await km.collectKnowledgeEventSet(setFixture, km.knowledgeIdentityKey(createBody));
  if (collected.length !== 2) {
    console.log(`FAIL — B2 collectKnowledgeEventSet wrong count: ${collected.length}`);
    process.exit(1);
  }
  console.log("PASS — B2 deterministic topological projection (degeneration + determinism + fold + causal + tombstone + collect).");
}

// B3: legacy_import backfill makes B0 coverage reach 1.0 (append-only, idempotent).
{
  const bf = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-b3-"));
  writeFile(path.join(bf, "knowledge", "b3-world-entry.md"), "---\nid: world:b3-world-entry\nscope: world\nkind: pattern\nstatus: active\nconfidence: 7\ntitle: \"B3 world entry\"\ncreated: 2026-01-01T00:00:00.000Z\n---\n# B3 world entry\n\nlegacy world body\n");
  writeFile(path.join(bf, "projects", "pi-global", "decisions", "b3-proj-entry.md"), "---\nid: project:pi-global:b3-proj-entry\nscope: project\nkind: decision\nstatus: active\nconfidence: 8\ntitle: \"B3 project entry\"\ncreated: 2026-02-02T00:00:00.000Z\n---\n# B3 project entry\n\nlegacy project body\n");
  const entries = legacyKnowledgeEntries(bf);
  if (entries.length !== 2) { console.log(`FAIL — B3 enumerated ${entries.length} legacy entries (expected 2)`); process.exit(1); }
  const before = computeLegacyKnowledgeCoverage(bf);
  if (before.covered !== 0 || before.backfillNeeded !== true) { console.log(`FAIL — B3 pre-backfill coverage wrong: ${JSON.stringify(before)}`); process.exit(1); }
  // dry-run must not write
  const dry = await runLegacyBackfill({ abrainHome: bf, dryRun: true });
  if (dry.appended !== 2 || fs.existsSync(path.join(bf, "l1", "events"))) { console.log(`FAIL — B3 dry-run wrote events or wrong count: ${JSON.stringify(dry)}`); process.exit(1); }
  // apply
  const applied = await runLegacyBackfill({ abrainHome: bf, dryRun: false });
  if (applied.appended !== 2 || applied.failed !== 0) { console.log(`FAIL — B3 apply wrong: ${JSON.stringify(applied)}`); process.exit(1); }
  const after = computeLegacyKnowledgeCoverage(bf);
  if (after.ratio !== 1 || after.backfillNeeded !== false) { console.log(`FAIL — B3 post-backfill coverage not 1.0: ${JSON.stringify(after)}`); process.exit(1); }
  // idempotent re-run: all duplicates, no new events
  const again = await runLegacyBackfill({ abrainHome: bf, dryRun: false });
  if (again.appended !== 0 || again.skipped !== 2) { console.log(`FAIL — B3 re-run not idempotent: ${JSON.stringify(again)}`); process.exit(1); }
  // the imported event must verify strictly and degenerate-project cleanly
  const km = loadKnowledgeEvidenceModule();
  const body = buildLegacyImportBody(km, bf, entries[0]);
  const eventId = km.knowledgeEvidenceBodyHash(body);
  const envelope = readJson(km.knowledgeEvidenceEventPath(bf, eventId));
  const verify = km.verifyKnowledgeEvidenceEnvelope(envelope);
  if (verify.ok !== true) { console.log(`FAIL — B3 imported event fails strict verify: ${JSON.stringify(verify)}`); process.exit(1); }
  console.log("PASS — B3 legacy_import backfill reaches 1.0 coverage, append-only, idempotent, strict-verifiable.");
}

// B4: pre-push hardblock rejects a dirty derived L2 view; PI_SKIP_L2_CHECK=1
// overrides with an auditable diagnostic (not a .state no-op — l2/ is tracked).
{
  const b4 = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-b4-"));
  execFileSync("git", ["-C", b4, "init"], { encoding: "utf8" });
  execFileSync("git", ["-C", b4, "config", "user.email", "adr0039@example.invalid"], { encoding: "utf8" });
  execFileSync("git", ["-C", b4, "config", "user.name", "ADR0039"], { encoding: "utf8" });
  writeFile(path.join(b4, "README"), "baseline\n");
  execFileSync("git", ["-C", b4, "add", "."], { encoding: "utf8" });
  execFileSync("git", ["-C", b4, "commit", "-m", "baseline"], { encoding: "utf8" });
  // uncommitted (hand-edited) derived L2 view => dirty_derived_view
  writeFile(path.join(b4, "l2", "views", "knowledge", "_dirty.txt"), "hand edit\n");
  const prepush = path.join(repoRoot, "scripts", "pre-push-adr0039-reconcile.mjs");
  const runPrepush = (env) => {
    try {
      execFileSync(process.execPath, [prepush, "--abrain", b4], { encoding: "utf8", env: { ...process.env, ...env }, stdio: "pipe" });
      return 0;
    } catch (err) {
      return typeof err.status === "number" ? err.status : 1;
    }
  };
  if (runPrepush({ PI_SKIP_L2_CHECK: "" }) === 0) {
    console.log("FAIL — B4 pre-push did not block a dirty derived L2 view");
    process.exit(1);
  }
  if (runPrepush({ PI_SKIP_L2_CHECK: "1" }) !== 0) {
    console.log("FAIL — B4 PI_SKIP_L2_CHECK=1 did not override the block");
    process.exit(1);
  }
  const overrideLog = path.join(b4, ".state", "sediment", "adr0039-l3", "prepush-overrides.jsonl");
  if (!fs.existsSync(overrideLog) || !fs.readFileSync(overrideLog, "utf8").includes("PI_SKIP_L2_CHECK=1")) {
    console.log("FAIL — B4 override did not record an auditable diagnostic");
    process.exit(1);
  }
  console.log("PASS — B4 pre-push hardblock rejects dirty L2; PI_SKIP_L2_CHECK=1 overrides with audit.");
}
process.exit(0);
