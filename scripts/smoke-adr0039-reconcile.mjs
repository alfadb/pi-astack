#!/usr/bin/env node
/**
 * ADR 0039 reconcile smoke.
 *
 * Default mode uses a temporary abrain tree and verifies the reconcile checks
 * catch corrupted L1 events and stale derived views. With --abrain it validates
 * a real tree and refreshes only the derived ADR0039 L3 SQLite mirror.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
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
  stageTs(outRoot, "extensions/memory/settings.ts");
  stageTs(outRoot, "extensions/memory/utils.ts");
  stageTs(outRoot, "extensions/sediment/knowledge-evidence.ts");
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/knowledge-evidence.js");
}

function loadAdr0039L3Module() {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-l3-"));
  stageTs(outRoot, "extensions/sediment/adr0039-l3.ts");
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/adr0039-l3.js");
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

function expectedKnowledgeOutputPath(abrainHome, body) {
  const projectPart = body.scope?.kind === "world" ? "world" : `projects/${body.scope?.project_id || "unknown"}`;
  return path.join(abrainHome, ".state", "sediment", "knowledge-projection", "latest", projectPart, `${body.payload?.slug}.md`);
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

function validateKnowledgeProjection(abrainHome) {
  const latest = path.join(abrainHome, ".state", "sediment", "knowledge-projection", "latest");
  if (!fs.existsSync(latest)) return { projectedFiles: 0, failures: [] };
  const failures = [];
  const knowledge = loadKnowledgeEvidenceModule();
  const markdownFiles = listFiles(latest, (file) => file.endsWith(".md"));
  const projectedByEvent = new Map();
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
    const expectedPath = expectedKnowledgeOutputPath(abrainHome, envelope.body);
    if (path.resolve(file) !== path.resolve(expectedPath)) failures.push(`${rel}: projection_path_mismatch`);
    if (envelope.body?.intent?.operation_hint === "delete") failures.push(`${rel}: delete_event_left_projected_markdown:${eventId}`);
    const expectedBytes = strict
      ? knowledge.renderKnowledgeProjectionMarkdown(envelope.body, eventId)
      : renderLegacyKnowledgeProjectionMarkdown(envelope.body, eventId);
    if (raw !== expectedBytes) failures.push(`${rel}: projection_byte_mismatch:${eventId}`);
    projectedByEvent.set(eventId, rel);
  }
  for (const eventFile of listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json"))) {
    const envelope = readJson(eventFile);
    if (envelope.body?.event_schema_version !== "knowledge-evidence-event/v1") continue;
    const eventId = envelope.event_id;
    const expectedPath = expectedKnowledgeOutputPath(abrainHome, envelope.body);
    if (envelope.body.intent?.operation_hint === "delete") {
      if (fs.existsSync(expectedPath)) failures.push(`${relativeUnix(abrainHome, expectedPath)}: stale_projection_after_delete:${eventId}`);
      continue;
    }
    if (!fs.existsSync(expectedPath)) failures.push(`${relativeUnix(abrainHome, eventFile)}: missing_projected_markdown:${eventId}`);
  }
  return { projectedFiles: markdownFiles.length, failures, projectedEvents: projectedByEvent.size };
}

function readDecisionInputRoot(decisionPath) {
  if (!fs.existsSync(decisionPath)) return "";
  const decision = readJson(decisionPath);
  return String(decision.inputRootHash || decision.input_root_hash || "");
}

function validateConstraintShadow(abrainHome, opts) {
  const latest = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  if (!fs.existsSync(latest)) return { present: false, failures: [] };
  const failures = [];
  const required = ["decision.json", "compiled-view.md", "event-coverage.json"];
  for (const name of required) {
    if (!fs.existsSync(path.join(latest, name))) failures.push(`constraint-shadow/latest: missing_${name}`);
  }
  const decisionPath = path.join(latest, "decision.json");
  const compiledPath = path.join(latest, "compiled-view.md");
  const coveragePath = path.join(latest, "event-coverage.json");
  const decisionMtime = fs.existsSync(decisionPath) ? fs.statSync(decisionPath).mtimeMs : 0;
  const compiledMtime = fs.existsSync(compiledPath) ? fs.statSync(compiledPath).mtimeMs : 0;
  const coverageMtime = fs.existsSync(coveragePath) ? fs.statSync(coveragePath).mtimeMs : 0;
  const newestEventMtime = Math.max(0, ...listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json")).map((file) => fs.statSync(file).mtimeMs));
  if (newestEventMtime > 0 && decisionMtime + opts.staleAfterMs < newestEventMtime) failures.push("constraint-shadow/latest: stale_against_l1_events");
  if (compiledMtime && decisionMtime && compiledMtime + 1000 < decisionMtime) failures.push("constraint-shadow/latest: compiled_view_older_than_decision");
  if (coverageMtime && decisionMtime && coverageMtime + 1000 < decisionMtime) failures.push("constraint-shadow/latest: coverage_older_than_decision");
  const inputRootHash = readDecisionInputRoot(decisionPath);
  if (inputRootHash && !/^[0-9a-f]{64}$/.test(inputRootHash)) failures.push("constraint-shadow/latest/decision.json: invalid_input_root_hash");
  if (fs.existsSync(coveragePath)) {
    const coverage = readJson(coveragePath);
    const ratio = Number(coverage.summary?.coverageRatio ?? coverage.summary?.coverage_ratio ?? coverage.coverageRatio ?? coverage.coverage_ratio ?? 0);
    if (!Number.isFinite(ratio) || ratio < opts.minCoverageRatio) failures.push(`constraint-shadow/latest/event-coverage.json: coverage_below_min:${ratio}`);
  }
  return { present: true, failures };
}

function gitStatusPorcelain(cwd) {
  try {
    return String(fs.existsSync(path.join(cwd, ".git")) ? execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }) : "");
  } catch {
    return "";
  }
}

function validateDirtyDerived(abrainHome) {
  const status = gitStatusPorcelain(abrainHome);
  const failures = [];
  for (const line of status.split("\n").filter(Boolean)) {
    const rel = line.slice(3).trim();
    if (rel.startsWith(".state/sediment/constraint-shadow/") || rel.startsWith(".state/sediment/knowledge-projection/")) {
      failures.push(`dirty_derived_view:${line}`);
    }
  }
  return { failures };
}

function validateL3Store(abrainHome) {
  if (!process.versions.sqlite) return { ok: false, dbPath: null, counts: null, failures: ["adr0039-l3: node_sqlite_unavailable"] };
  const l3 = loadAdr0039L3Module();
  const result = l3.syncAdr0039L3Store({ abrainHome });
  return result;
}

function loadRuntimeThresholds() {
  const cfg = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
  const compiled = cfg.ruleInjector?.compiledViewInjection ?? {};
  const shadowAuto = cfg.sediment?.constraintShadowCompiler?.autoRefresh ?? {};
  return {
    staleAfterMs: Number(compiled.staleAfterMs ?? shadowAuto.eventStaleAfterMs ?? 24 * 60 * 60 * 1000),
    minCoverageRatio: Number(compiled.minCoverageRatio ?? 1),
  };
}

function reconcile(abrainHome, opts = loadRuntimeThresholds()) {
  const l1 = validateL1Events(abrainHome);
  const knowledge = validateKnowledgeProjection(abrainHome);
  const constraint = validateConstraintShadow(abrainHome, opts);
  const l3 = validateL3Store(abrainHome);
  const dirty = validateDirtyDerived(abrainHome);
  const failures = [...l1.failures, ...knowledge.failures, ...constraint.failures, ...l3.failures, ...dirty.failures];
  return { abrainHome, l1, knowledge, constraint, l3, dirty, failures };
}

function printResult(result) {
  console.log(`abrainHome: ${result.abrainHome}`);
  console.log(`l1_events: ${result.l1.files}`);
  console.log(`knowledge_projected_files: ${result.knowledge.projectedFiles}`);
  console.log(`constraint_shadow_present: ${result.constraint.present}`);
  console.log(`l3_db: ${result.l3.dbPath || "unavailable"}`);
  if (result.failures.length) {
    for (const failure of result.failures) console.log(`  FAIL  ${failure}`);
    console.log(`FAIL — ${result.failures.length} reconcile check(s) failed.`);
  } else {
    console.log("PASS — ADR0039 reconcile checks passed.");
  }
}

async function buildFixtureTree() {
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
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const result = reconcile(abrainHome);
  printResult(result);
  process.exit(result.failures.length ? 1 : 0);
}

console.log("ADR0039 reconcile smoke");
const fixture = await buildFixtureTree();
const clean = reconcile(fixture.abrainHome, { staleAfterMs: 24 * 60 * 60 * 1000, minCoverageRatio: 1 });
printResult(clean);
if (clean.failures.length) process.exit(1);
const eventPath = expectedEventPath(fixture.abrainHome, fixture.eventId);
const corrupted = readJson(eventPath);
corrupted.body.payload.title = "Corrupted Fixture";
writeFile(eventPath, `${JSON.stringify(corrupted, null, 2)}\n`);
const dirty = reconcile(fixture.abrainHome, { staleAfterMs: 24 * 60 * 60 * 1000, minCoverageRatio: 1 });
if (!dirty.failures.some((failure) => failure.includes("body_hash_mismatch"))) {
  console.log("FAIL — corrupted fixture did not trigger body_hash_mismatch");
  process.exit(1);
}
console.log("PASS — corrupted fixture is rejected.");
process.exit(0);
