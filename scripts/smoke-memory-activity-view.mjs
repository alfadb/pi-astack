#!/usr/bin/env node
/** Smoke: read-only memory_activity L2 view reader. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  canonicalJson,
  contentAddressedEventPath,
  sha256Hex,
  writeProjectActivityProjection,
} from "./project-activity-l2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const { readActivityView } = await jiti.import(path.join(repoRoot, "extensions/memory/activity-view.ts"));

const failures = [];
let total = 0;
async function check(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function cryptoNonce(value) {
  return sha256Hex(JSON.stringify(value || {})).slice(0, 16);
}

function envelopeFor(body) {
  const bodyHash = sha256Hex(canonicalJson(body));
  return {
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

function writeEvent(abrainHome, body) {
  const envelope = envelopeFor(body);
  const file = contentAddressedEventPath(abrainHome, envelope.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, "utf8");
  return envelope.event_id;
}

function knowledgeBody(overrides = {}) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-07-03T00:00:00.000Z",
    device_id: "smoke-device",
    producer_nonce: cryptoNonce(overrides),
    causal_parents: [],
    session_id: "smoke-session",
    turn_id: "smoke-turn",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: "smoke" },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    scope: { kind: "project", project_id: "pi-global" },
    payload: {
      slug: "smoke-activity-view",
      title: "Smoke Activity View",
      kind: "fact",
      status: "active",
      provenance: "smoke",
      confidence: 5,
      compiled_truth: "# Smoke Activity View\n\nSmoke body.",
      trigger_phrases: [],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "smoke" },
    producer: { name: "sediment.knowledge-event-writer", version: "smoke" },
    ...overrides,
  };
}

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-memory-activity-view-smoke-"));
  writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-03T00:00:00.000Z", scope: { kind: "project", project_id: "pi-global" } }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-07-02T00:00:00.000Z",
    scope: { kind: "project", project_id: "pi-global" },
    payload: { ...knowledgeBody().payload, slug: "pi-global-second", title: "Pi Global Second" },
  }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-07-01T00:00:00.000Z",
    scope: { kind: "project", project_id: "pi-router" },
    payload: { ...knowledgeBody().payload, slug: "router-activity-view", title: "Router Activity View" },
  }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-06-30T00:00:00.000Z",
    scope: { kind: "world" },
    payload: { ...knowledgeBody().payload, slug: "world-activity-view", title: "World Activity View" },
  }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-06-29T00:00:00.000Z",
    scope: {},
    payload: { ...knowledgeBody().payload, slug: "unattributed-activity-view", title: "Unattributed Activity View" },
  }));
  writeProjectActivityProjection({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
  return home;
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.push({ rel: path.relative(root, full).split(path.sep).join("/"), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

console.log("memory activity view smoke");

await check("reader returns bounded project allocation and does not write", async () => {
  const home = makeFixture();
  try {
    const before = JSON.stringify(listFiles(home));
    const result = readActivityView({ abrainRoot: home, windowDays: 30, limit: 2, nowUtc: "2026-07-04T12:00:00.000Z" });
    const after = JSON.stringify(listFiles(home));
    assert(result.ok === true, `expected ok got ${JSON.stringify(result.findings || result.diagnostics?.findings)}`);
    assert(result.status === "ok", `status expected ok got ${result.status}`);
    assert(result.topProjects.length === 2, `limit expected 2 rows got ${result.topProjects.length}`);
    assert(result.topProjects[0].project === "pi-global", `top project expected pi-global got ${result.topProjects[0]?.project}`);
    assert(result.topProjects[0].events === 2, `pi-global events expected 2 got ${result.topProjects[0].events}`);
    assert(result.world.events === 1, `world expected 1 got ${result.world.events}`);
    assert(result.unattributed.events === 1, `unattributed expected 1 got ${result.unattributed.events}`);
    assert(result.countsAre.includes("evidence-event"), "result must warn counts are evidence-event counts");
    assert(!("excerpt" in result), "excerpt should be omitted by default");
    assert(before === after, "reader changed file set, size, or mtime");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("reader supports bounded excerpt and viewRoot latest path", async () => {
  const home = makeFixture();
  try {
    const latestDir = path.join(home, "l2", "views", "activity", "latest");
    const result = readActivityView({ viewRoot: latestDir, includeExcerpt: true, nowUtc: "2026-07-04T12:00:00.000Z" });
    assert(result.ok === true, `expected ok got ${JSON.stringify(result.diagnostics?.findings)}`);
    assert(typeof result.excerpt === "string" && result.excerpt.length > 0, "excerpt should be present");
    assert(result.excerpt.length <= 4000, `excerpt too large: ${result.excerpt.length}`);
    assert(!result.excerpt.startsWith("---"), "excerpt should omit frontmatter");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("reader fails closed on tampered markdown hash", async () => {
  const home = makeFixture();
  try {
    const markdownPath = path.join(home, "l2", "views", "activity", "latest", "project-time-allocation.md");
    fs.appendFileSync(markdownPath, "\nTAMPER\n", "utf8");
    const result = readActivityView({ abrainRoot: home, nowUtc: "2026-07-04T12:00:00.000Z" });
    assert(result.ok === false, "tampered markdown should fail");
    const findings = result.diagnostics?.findings || result.findings || [];
    assert(findings.some((finding) => finding.code === "output_hash_invalid" || finding.code === "markdown_output_hash_invalid"), `expected output hash finding got ${JSON.stringify(findings)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("reader reports missing markdown without inferring no activity", async () => {
  const home = makeFixture();
  try {
    const markdownPath = path.join(home, "l2", "views", "activity", "latest", "project-time-allocation.md");
    fs.rmSync(markdownPath, { force: true });
    const result = readActivityView({ abrainRoot: home, nowUtc: "2026-07-04T12:00:00.000Z" });
    assert(result.ok === false, "missing markdown should fail");
    assert(result.status === "missing_view", `expected missing_view got ${result.status}`);
    assert(result.findings.some((finding) => finding.code === "markdown_missing"), `expected markdown_missing got ${JSON.stringify(result.findings)}`);
    assert(String(result.hint || "").includes("Do not infer"), "missing view hint should warn against no-activity inference");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log(failures.length === 0
  ? `PASS - ${total} checks (memory activity view).`
  : `FAIL - ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
