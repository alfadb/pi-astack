#!/usr/bin/env node
/** Smoke: activity/attention L2 projector. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafeOutputRoot,
  buildProjectActivityView,
  canonicalJson,
  contentAddressedEventPath,
  sha256Hex,
  writeProjectActivityProjection,
} from "./project-activity-l2.mjs";

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

function envelopeFor(body) {
  const bodyHash = sha256Hex(canonicalJson(body));
  return {
    schema: body.event_schema_version === "constraint-projection-event/v1" ? "constraint-projection-envelope/v1" : "knowledge-evidence-envelope/v1",
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

function knowledgeBody(overrides) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-07-04T00:00:00.000Z",
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
      slug: "smoke-activity",
      title: "Smoke Activity",
      kind: "fact",
      status: "active",
      provenance: "smoke",
      confidence: 5,
      compiled_truth: "# Smoke Activity\n\nSmoke body.",
      trigger_phrases: [],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "smoke" },
    producer: { name: "sediment.knowledge-event-writer", version: "smoke" },
    ...overrides,
  };
}

function constraintBody(overrides) {
  return {
    event_schema_version: "constraint-evidence-event/v1",
    event_type: "constraint_signal_observed",
    created_at_utc: "2026-06-25T00:00:00.000Z",
    device_id: "smoke-device",
    producer_nonce: cryptoNonce(overrides),
    actor: { role: "user" },
    causal_parents: [],
    session_id: "smoke-session",
    turn_id: "smoke-turn",
    source: { channel: "agent_end", source_role: "user", source_ref: "smoke", quote_hash: "00" },
    intent: { domain_hint: "constraint", operation_hint: "create" },
    payload: { sanitized_quote: "smoke quote" },
    scope: {
      active_project_binding: { project_id: "pi-global", binding_reason: "smoke" },
      scope_hint: { kind: "project", project_id: "pi-global", evidence: "smoke" },
    },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    neighbor_summary: { retrieval_mode: "readonly", input_hash: "00", neighbor_refs: [], summary: "smoke" },
    producer: { name: "sediment.constraint-event-writer", version: "smoke" },
    ...overrides,
  };
}

function projectionBody(overrides) {
  return {
    event_schema_version: "constraint-projection-event/v1",
    event_type: "constraint_compiled_view_produced",
    created_at_utc: "2026-07-04T00:00:00.000Z",
    device_id: "smoke-device",
    producer_nonce: cryptoNonce(overrides),
    causal_parents: [],
    producer: { name: "sediment.constraint-compiler", version: "smoke" },
    template_version: "smoke",
    input_root_hash: "00",
    input_event_ids: [],
    provenance: { model: "smoke", prompt_hash: "", input_hash: "", raw_output_hash: "", acceptance: "accepted_for_event_append" },
    validated_decision: {},
    ...overrides,
  };
}

function cryptoNonce(value) {
  return sha256Hex(JSON.stringify(value || {})).slice(0, 16);
}

console.log("activity L2 projector smoke");

await check("buildProjectActivityView excludes legacy/projection and aggregates windows", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-activity-smoke-"));
  try {
    writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-03T00:00:00.000Z", scope: { kind: "project", project_id: "pi-global" } }));
    writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-01T00:00:00.000Z", scope: { kind: "project", project_id: "pi-router" }, payload: { ...knowledgeBody({}).payload, slug: "router-activity", title: "Router Activity" } }));
    writeEvent(home, knowledgeBody({ created_at_utc: "2026-06-30T00:00:00.000Z", scope: { kind: "world" }, payload: { ...knowledgeBody({}).payload, slug: "world-activity", title: "World Activity" } }));
    writeEvent(home, constraintBody({ created_at_utc: "2026-06-24T00:00:00.000Z" }));
    writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-02T00:00:00.000Z", device_id: "legacy-import", session_id: "legacy-import", source: { channel: "manual", source_ref: "legacy-import:projects/pi-global/facts/legacy.md" } }));
    writeEvent(home, projectionBody({ created_at_utc: "2026-07-04T00:00:00.000Z" }));

    const result = buildProjectActivityView({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
    assert(result.view.includedEvents === 4, `includedEvents expected 4 got ${result.view.includedEvents}`);
    assert(result.view.excludedLegacyEvents === 1, `legacy excluded expected 1 got ${result.view.excludedLegacyEvents}`);
    assert(result.view.skippedProjectionEvents === 1, `projection skipped expected 1 got ${result.view.skippedProjectionEvents}`);
    assert(result.view.totalsByWindow["7"] === 3, `7d total expected 3 got ${result.view.totalsByWindow["7"]}`);
    assert(result.view.totalsByWindow["30"] === 4, `30d total expected 4 got ${result.view.totalsByWindow["30"]}`);
    const byProject = Object.fromEntries(result.view.projects.map((p) => [p.project, p]));
    assert(byProject["pi-global"].windows["30"] === 2, "pi-global 30d includes knowledge + constraint");
    assert(byProject["pi-global"].windows["7"] === 1, "pi-global 7d excludes 10-day-old constraint");
    assert(byProject["pi-router"].windows["7"] === 1, "pi-router 7d count");
    assert(byProject.world.windows["7"] === 1, "world 7d count");
    assert(/\| pi-global \| 2 \| 50\.0% \|/.test(result.markdown), "primary 30d allocation table includes pi-global share");
    assert(result.markdown.includes("| project | total | first_signal_utc | last_signal_utc | 7d | 30d |"), "window count table has one column per window");
    assert(result.markdown.includes("default_output_path: l2/views/activity/latest/project-time-allocation.md"), "markdown records default, not caller-specific, output path");

    const beforeHash = result.view.inputEventSetHash;
    writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-03T12:00:00.000Z", device_id: "legacy-import", session_id: "legacy-import", source: { channel: "manual", source_ref: "legacy-import:projects/pi-router/facts/extra.md" }, payload: { ...knowledgeBody({}).payload, slug: "extra-legacy", title: "Extra Legacy" } }));
    const after = buildProjectActivityView({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
    assert(after.view.includedEvents === result.view.includedEvents, "extra legacy does not change included event count");
    assert(after.view.inputEventSetHash !== beforeHash, "excluded legacy event still changes input fingerprint");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("writeProjectActivityProjection is deterministic for same as-of/input", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-activity-write-smoke-"));
  try {
    writeEvent(home, knowledgeBody({ created_at_utc: "2026-07-03T00:00:00.000Z" }));
    const first = writeProjectActivityProjection({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
    const firstMd = fs.readFileSync(first.markdownPath, "utf8");
    const firstManifest = fs.readFileSync(first.manifestPath, "utf8");
    const second = writeProjectActivityProjection({ abrainHome: home, asOfUtc: "2026-07-04T00:00:00.000Z", windows: [7, 30] });
    assert(fs.existsSync(second.markdownPath), "markdown written");
    assert(fs.existsSync(second.manifestPath), "manifest written");
    assert(fs.readFileSync(second.markdownPath, "utf8") === firstMd, "markdown stable across rerun");
    assert(fs.readFileSync(second.manifestPath, "utf8") === firstManifest, "manifest stable across rerun");
    assert(first.view.outputHash === second.view.outputHash, "outputHash stable");
    assertSafeOutputRoot(home, path.join(home, "l2", "views", "activity"));
    let rejected = false;
    try {
      assertSafeOutputRoot(home, path.join(home, "knowledge"));
    } catch {
      rejected = true;
    }
    assert(rejected, "output root inside abrain semantic stores is rejected");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log(failures.length === 0
  ? `PASS - ${total} checks (activity L2 projector).`
  : `FAIL - ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
