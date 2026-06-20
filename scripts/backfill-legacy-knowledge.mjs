#!/usr/bin/env node
/**
 * ADR 0039 B3 legacy_import backfill.
 *
 * Appends one deterministic, content-addressed `legacy_import` L1 Knowledge
 * Evidence Event for every legacy canonical Knowledge entry (world knowledge/
 * + project knowledge|decisions|maxims) that does not yet have a backing L1
 * event, so the B0 coverage ratio can reach 1.0 before the canonical=projection
 * flip (B5). Strictly append-only (HB1) and read-only against the legacy
 * markdown (HB2): it never edits or deletes legacy files. Idempotent: the event
 * id is sha256(JCS(body)) of a body derived deterministically from the entry,
 * so re-running yields idempotent_duplicate, not new events.
 *
 * Usage:
 *   node scripts/backfill-legacy-knowledge.mjs --abrain ~/.abrain --dry-run
 *   node scripts/backfill-legacy-knowledge.mjs --abrain ~/.abrain
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
void require;

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}

function stage(outRoot, src) {
  const dst = path.join(outRoot, src.replace(/^extensions\//, "").replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, transpile(path.join(repoRoot, src)));
}

export function loadKnowledgeModule() {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-backfill-"));
  stage(outRoot, "extensions/memory/settings.ts");
  stage(outRoot, "extensions/memory/utils.ts");
  stage(outRoot, "extensions/sediment/knowledge-evidence.ts");
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/knowledge-evidence.js");
}

const LEGACY_KNOWLEDGE_PROJECT_ZONES = ["knowledge", "decisions", "maxims"];

function listMarkdown(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Enumerate legacy canonical Knowledge entries with their path-derived identity. */
export function legacyKnowledgeEntries(abrainHome) {
  const entries = [];
  for (const file of listMarkdown(path.join(abrainHome, "knowledge"))) {
    entries.push({ file, scope: "world", projectId: undefined, slug: path.basename(file, ".md") });
  }
  const projectsRoot = path.join(abrainHome, "projects");
  if (fs.existsSync(projectsRoot)) {
    for (const pid of fs.readdirSync(projectsRoot)) {
      if (!fs.statSync(path.join(projectsRoot, pid)).isDirectory()) continue;
      for (const zone of LEGACY_KNOWLEDGE_PROJECT_ZONES) {
        for (const file of listMarkdown(path.join(projectsRoot, pid, zone))) {
          entries.push({ file, scope: "project", projectId: pid, slug: path.basename(file, ".md") });
        }
      }
    }
  }
  return entries;
}

function splitFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { fm: match[1], body: match[2].trim() } : { fm: "", body: raw.trim() };
}

function fmScalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!m) return undefined;
  const v = m[1].trim();
  if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  return v;
}

function fmList(fm, key) {
  const lines = fm.split("\n");
  const idx = lines.findIndex((l) => l.trim() === `${key}:`);
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s+-\s+(.+)$/);
    if (!m) break;
    let v = m[1].trim();
    if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    out.push(v);
  }
  return out;
}

const IMPORT_CREATED_FALLBACK = "2020-01-01T00:00:00.000Z";

/** Build a deterministic legacy_import event body from a legacy entry.
 *  Scope/slug come from the PATH (the coverage identity); content fields come
 *  from the file. Marked legacy_import via source.channel="manual" +
 *  source_ref + legacy_parallel_write.status. */
export function buildLegacyImportBody(km, abrainHome, entry) {
  const raw = fs.readFileSync(entry.file, "utf-8");
  const { fm, body } = splitFrontmatter(raw);
  const rel = path.relative(abrainHome, entry.file).split(path.sep).join("/");
  const created = fmScalar(fm, "created") || IMPORT_CREATED_FALLBACK;
  const contentHash = km.sha256Hex(raw);
  const eventBody = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: created,
    device_id: "legacy-import",
    producer_nonce: km.sha256Hex(`legacy-import:${rel}:${contentHash}`),
    causal_parents: [],
    session_id: "legacy-import",
    turn_id: "legacy-import",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "manual", source_ref: `legacy-import:${rel}` },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    scope: entry.scope === "world" ? { kind: "world" } : { kind: "project", project_id: entry.projectId },
    payload: {
      slug: entry.slug,
      title: fmScalar(fm, "title") || entry.slug,
      kind: fmScalar(fm, "kind") || "fact",
      status: fmScalar(fm, "status") || "active",
      provenance: fmScalar(fm, "provenance") || "legacy-import",
      confidence: Number(fmScalar(fm, "confidence") || 5),
      compiled_truth: body,
      trigger_phrases: fmList(fm, "trigger_phrases"),
      derives_from: fmList(fm, "derives_from"),
    },
    sanitizer: { sanitizer_name: "sediment.legacy-import", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "legacy_import", path: rel },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
  return eventBody;
}

/** Identity keys of every existing L1 knowledge event (real or imported). */
export function collectKnowledgeIdentities(km, abrainHome) {
  const root = path.join(abrainHome, "l1", "events");
  const ids = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const body = JSON.parse(fs.readFileSync(full, "utf-8")).body;
          if (body?.event_schema_version === "knowledge-evidence-event/v1") ids.add(km.knowledgeIdentityKey(body));
        } catch { /* skip */ }
      }
    }
  };
  walk(root);
  return ids;
}

export async function runBackfill({ abrainHome, dryRun = true, limit = Infinity }) {
  const km = loadKnowledgeModule();
  const entries = legacyKnowledgeEntries(abrainHome);
  // Skip identities already backed by an L1 event (real agent_end OR a prior
  // legacy_import): backfill only the truly-missing, so re-runs are no-ops and
  // already-covered entries are not given a redundant import event.
  const covered = collectKnowledgeIdentities(km, abrainHome);
  let scanned = 0;
  let appended = 0;
  let skipped = 0;
  let duplicate = 0;
  let failed = 0;
  const failures = [];
  for (const entry of entries) {
    if (scanned >= limit) break;
    scanned += 1;
    const identity = entry.scope === "world" ? `world::${entry.slug}` : `project:${entry.projectId}:${entry.slug}`;
    if (covered.has(identity)) { skipped += 1; continue; }
    let body;
    try {
      body = buildLegacyImportBody(km, abrainHome, entry);
    } catch (err) {
      failed += 1; failures.push(`${entry.slug}: build_failed:${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const eventId = km.knowledgeEvidenceBodyHash(body);
    const eventPath = km.knowledgeEvidenceEventPath(abrainHome, eventId);
    const exists = fs.existsSync(eventPath);
    if (dryRun) {
      if (exists) duplicate += 1; else appended += 1;
      continue;
    }
    const result = await km.appendKnowledgeEvidenceEvent({ abrainHome, body });
    if (result.ok && result.status === "appended") { appended += 1; covered.add(identity); }
    else if (result.ok && result.status === "idempotent_duplicate") duplicate += 1;
    else { failed += 1; failures.push(`${entry.slug}: ${result.status}:${result.error || ""}`); }
  }
  return { scanned, appended, skipped, duplicate, failed, failures: failures.slice(0, 10), total: entries.length };
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const dryRun = !process.argv.includes("--no-dry-run") && !process.argv.includes("--apply");
  const limit = Number(arg("limit", "Infinity"));
  const result = await runBackfill({ abrainHome, dryRun, limit: Number.isFinite(limit) ? limit : Infinity });
  console.log(`abrainHome: ${abrainHome}`);
  console.log(`mode: ${dryRun ? "DRY-RUN (no writes)" : "APPLY (append events)"}`);
  console.log(`legacy_entries: ${result.total}`);
  console.log(`would_append: ${result.appended}`);
  console.log(`already_covered_skipped: ${result.skipped}`);
  console.log(`content_address_duplicate: ${result.duplicate}`);
  console.log(`failed: ${result.failed}`);
  if (result.failures.length) for (const f of result.failures) console.log(`  FAIL ${f}`);
  process.exit(result.failed ? 1 : 0);
}
