#!/usr/bin/env node
/** Smoke: read-only activity/attention L2 health script. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  contentAddressedEventPath,
  sha256Hex,
  writeProjectActivityProjection,
} from "./project-activity-l2.mjs";
import { checkActivityL2Health } from "./activity-l2-health.mjs";

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
      slug: "smoke-activity-health",
      title: "Smoke Activity Health",
      kind: "fact",
      status: "active",
      provenance: "smoke",
      confidence: 5,
      compiled_truth: "# Smoke Activity Health\n\nSmoke body.",
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-activity-health-smoke-"));
  writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-03T00:00:00.000Z", scope: { kind: "project", project_id: "pi-global" } }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-07-02T00:00:00.000Z",
    scope: { kind: "project", project_id: "pi-router" },
    payload: { ...knowledgeBody().payload, slug: "router-health", title: "Router Health" },
  }));
  writeEvent(home, knowledgeBody({
    created_at_utc: "2026-07-01T00:00:00.000Z",
    scope: {},
    payload: { ...knowledgeBody().payload, slug: "unattributed-health", title: "Unattributed Health" },
  }));
  writeProjectActivityProjection({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
  return home;
}

function runHealth(home) {
  return checkActivityL2Health({
    abrainHome: home,
    nowUtc: "2026-07-04T12:00:00.000Z",
    maxAgeHours: 999999,
  });
}

console.log("activity L2 health smoke");

await check("health passes on projector output and reports distribution", async () => {
  const home = makeFixture();
  try {
    const report = runHealth(home);
    assert(report.status === "pass", `expected pass got ${JSON.stringify(report.findings)}`);
    assert(report.integrity.includedEvents === 3, `includedEvents expected 3 got ${report.integrity.includedEvents}`);
    assert(report.distribution.projectCount === 3, `projectCount expected 3 got ${report.distribution.projectCount}`);
    assert(report.distribution.unattributedEvents === 1, `unattributed expected 1 got ${report.distribution.unattributedEvents}`);
    assert(report.distribution.primaryWindowEvents === 3, `primary window expected 3 got ${report.distribution.primaryWindowEvents}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("health accepts --view-root style path and fails on tampered manifest", async () => {
  const home = makeFixture();
  try {
    const latestDir = path.join(home, "l2", "views", "activity", "latest");
    const ok = checkActivityL2Health({ viewRoot: latestDir, nowUtc: "2026-07-04T12:00:00.000Z" });
    assert(ok.status === "pass", `viewRoot direct expected pass got ${JSON.stringify(ok.findings)}`);
    const manifestPath = path.join(latestDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.includedEvents += 1;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const report = checkActivityL2Health({ viewRoot: path.join(home, "l2", "views", "activity"), nowUtc: "2026-07-04T12:00:00.000Z" });
    assert(report.status === "fail", "tampered manifest should fail");
    assert(report.findings.some((finding) => finding.code === "included_events_mismatch" || finding.code === "manifest_project_total_mismatch"), `expected count mismatch, got ${JSON.stringify(report.findings)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("health fails when markdown is missing", async () => {
  const home = makeFixture();
  try {
    const markdownPath = path.join(home, "l2", "views", "activity", "latest", "project-time-allocation.md");
    fs.rmSync(markdownPath, { force: true });
    const report = runHealth(home);
    assert(report.status === "fail", "missing markdown should fail");
    assert(report.findings.some((finding) => finding.code === "markdown_missing"), `expected markdown_missing got ${JSON.stringify(report.findings)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log(failures.length === 0
  ? `PASS - ${total} checks (activity L2 health).`
  : `FAIL - ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
