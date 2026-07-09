#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

const {
  appendKnowledgeEvidenceEvent,
  knowledgeEvidenceBodyHash,
  knowledgeEvidenceEventPath,
} = jiti(path.join(repoRoot, "extensions/sediment/knowledge-evidence.ts"));
const { durableAtomicWriteFile } = jiti(path.join(repoRoot, "extensions/_shared/durable-write.ts"));

const productionAbrain = path.resolve("/home/worker/.abrain");
let pass = 0;
let fail = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function tempAbrain(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-knowledge-durable-${label}-`));
  assert(path.resolve(dir) !== productionAbrain, "refusing to use production abrain path");
  return dir;
}

function fixtureBody(seq, overrides = {}) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-09T07:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "device-test",
    device_event_seq: seq,
    producer_nonce: `knowledge-durable-smoke-${seq}`,
    causal_parents: [],
    session_id: "session-test",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "manual", source_ref: `smoke:${seq}` },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: `durable-write-${seq}`,
      title: `Durable Write ${seq}`,
      kind: "decision",
      status: "active",
      provenance: "smoke-test",
      confidence: 7,
      compiled_truth: `# Durable Write ${seq}\n\nDurability smoke fixture.`,
      trigger_phrases: ["durable write"],
      derives_from: [],
    },
    sanitizer: {
      sanitizer_name: "smoke-sanitizer",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "durable write smoke" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
    ...overrides,
  };
}

function targetFor(abrainHome, body) {
  const eventId = knowledgeEvidenceBodyHash(body);
  const filePath = knowledgeEvidenceEventPath(abrainHome, eventId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return { eventId, filePath };
}

function hasDiagnostic(result, code, marker) {
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  return diagnostics.some((diagnostic) => (
    diagnostic.code === code
    && (!marker || JSON.stringify(diagnostic).includes(marker))
  ));
}

console.log("knowledge evidence durable write smoke");

await check("idempotent rewrite of identical content passes", async () => {
  const abrainHome = tempAbrain("idempotent");
  const body = fixtureBody(1);
  const first = await appendKnowledgeEvidenceEvent({ abrainHome, body });
  const second = await appendKnowledgeEvidenceEvent({ abrainHome, body });
  assert(first.ok && first.status === "appended", `first append failed: ${JSON.stringify(first)}`);
  assert(second.ok && second.status === "idempotent_duplicate", `second append was not idempotent: ${JSON.stringify(second)}`);
  assert(fs.existsSync(first.filePath), "event file missing after append");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

await check("same event id with different parseable content rejects as collision", async () => {
  const abrainHome = tempAbrain("collision-parseable");
  const body = fixtureBody(2);
  const { filePath } = targetFor(abrainHome, body);
  fs.writeFileSync(filePath, `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", collision: true })}\n`, "utf8");
  const result = await appendKnowledgeEvidenceEvent({ abrainHome, body });
  assert(!result.ok && result.status === "collision", `expected collision: ${JSON.stringify(result)}`);
  assert(hasDiagnostic(result, "KE_HASH_PATH_COLLISION", "content_mismatch"), `missing visible collision diagnostic: ${JSON.stringify(result)}`);
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

await check("empty target residue is recovered and marked", async () => {
  const abrainHome = tempAbrain("empty-residue");
  const body = fixtureBody(3);
  const { filePath } = targetFor(abrainHome, body);
  fs.closeSync(fs.openSync(filePath, "w"));
  assert(fs.statSync(filePath).size === 0, "fixture did not create an empty target file");
  const result = await appendKnowledgeEvidenceEvent({ abrainHome, body });
  assert(result.ok && result.status === "appended", `empty residue was not recovered: ${JSON.stringify(result)}`);
  assert(result.recoveredEmptyResidue === true, "missing recoveredEmptyResidue marker");
  assert(hasDiagnostic(result, "KE_RECOVERED_EMPTY_RESIDUE", "recovered_empty_residue"), `missing recovered diagnostic: ${JSON.stringify(result)}`);
  assert(fs.statSync(filePath).size > 0, "recovered event file is still empty");
  JSON.parse(fs.readFileSync(filePath, "utf8"));
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

await check("non-empty garbage target rejects as collision with diagnostic", async () => {
  const abrainHome = tempAbrain("garbage-residue");
  const body = fixtureBody(4);
  const { filePath } = targetFor(abrainHome, body);
  fs.writeFileSync(filePath, "not-json\n", "utf8");
  const result = await appendKnowledgeEvidenceEvent({ abrainHome, body });
  assert(!result.ok && result.status === "collision", `expected garbage collision: ${JSON.stringify(result)}`);
  assert(hasDiagnostic(result, "KE_HASH_PATH_COLLISION", "existing_unparseable"), `missing garbage diagnostic: ${JSON.stringify(result)}`);
  assert(fs.readFileSync(filePath, "utf8") === "not-json\n", "garbage target should be preserved");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

await check("durable helper fsync path writes without throwing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-durable-helper-"));
  assert(path.resolve(root) !== productionAbrain, "refusing to use production abrain path");
  const filePath = path.join(root, "nested", "event.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await durableAtomicWriteFile(filePath, "{\"ok\":true}\n");
  assert(fs.readFileSync(filePath, "utf8") === "{\"ok\":true}\n", "durable helper wrote unexpected content");
  fs.rmSync(root, { recursive: true, force: true });
});

if (fail > 0) {
  console.log(`\nFAIL - ${fail}/${pass + fail} check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS - ${pass} knowledge evidence durable write check(s) passed.`);
