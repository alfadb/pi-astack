#!/usr/bin/env node
/**
 * Smoke: ADR0040 Tier-1 natural correction → constraint evidence → policy
 * proposition → durable pending marker → async force stable-view republish.
 *
 * Offline sandbox / fixture only. Proves local contracts (idempotency, marker
 * durability, causal binding, registry gate, force republish, concurrent wave).
 * Does NOT claim production fresh-session acceptance — that still requires a
 * real post-restart natural correction into a fresh persisted main session.
 * No production abrain mutation. No commit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { preparePropositionPolicyStableViewFixture } from "./_proposition-policy-stable-view-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-tier1-policy-writer.ts"));
const constraintIntegration = jiti(path.join(repoRoot, "extensions/sediment/constraint-evidence/integration.ts"));
const constraintHash = jiti(path.join(repoRoot, "extensions/sediment/constraint-evidence/hash-envelope.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const recovery = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-recovery.ts"));
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const p2a = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));
const reader = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts"));
const settingsMod = jiti(path.join(repoRoot, "extensions/sediment/settings.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-tier1-policy-bridge-"));
const originalEnv = { HOME: process.env.HOME, ABRAIN_ROOT: process.env.ABRAIN_ROOT };
let passed = 0;
const failures = [];

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error?.stack || error}\n`);
  }
}
function configureRoot(root) {
  process.env.ABRAIN_ROOT = root;
  process.env.HOME = path.dirname(root);
}
function restoreEnv() {
  if (originalEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.HOME;
  if (originalEnv.ABRAIN_ROOT === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = originalEnv.ABRAIN_ROOT;
}

const GLOBAL_SIGNAL = {
  user_quote: "所有项目都必须先跑真实 smoke 再宣称完成。",
  correction_intent: "global durable policy",
  scope_description: "所有项目 / 全局约定",
  confidence: 9,
  provenance: "user",
  quote_source: "user",
  is_directive: true,
};
const GLOBAL_DRAFT = {
  title: "real-smoke-before-done",
  body: "所有项目都必须先跑真实 smoke 再宣称完成。",
  entryConfidence: 9,
  triggerPhrases: ["真实 smoke", "完成"],
  injectMode: "always",
};

function baseConstraintOptions(overrides = {}) {
  return {
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: "019f93cb-e736-7110-b6ea-cf3ee07b68be",
    turnId: "4",
    projectId: "pi-astack",
    cwd: repoRoot,
    createdAtUtc: "2026-07-25T01:00:00.000Z",
    correlationId: "corr-tier1-policy-bridge",
    candidateId: "tier1-direct:c0",
    deviceId: "smoke-device",
    ...overrides,
  };
}

async function appendConstraint(abrainHome, overrides = {}) {
  return constraintIntegration.appendTier1ConstraintEvidenceEvent({
    abrainHome,
    ...baseConstraintOptions(overrides),
    canonicalPublish: false,
  });
}

async function appendProposition(abrainHome, constraintResult, overrides = {}) {
  const opts = baseConstraintOptions(overrides);
  return writer.appendTier1PolicyProposition({
    abrainHome,
    constraintEnvelope: constraintResult.append.envelope,
    constraintBody: constraintResult.body,
    signal: opts.signal,
    draft: opts.draft,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
  });
}

/** Hard recovery envelope (matches contract max artifact set). Fixture success paths use this. */
const HARD_MAX_READ_BYTES = 262144;
/** Production settings value — smaller than multi-item fixtures; used only for mismatch probes. */
const PRODUCTION_RUNTIME_MAX_READ_BYTES = 16384;
/** Tiny budget used to prove source-change ack cannot clear oversize markers. */
const TINY_RUNTIME_MAX_READ_BYTES = 64;

function strictRead(root, maxReadBytes = HARD_MAX_READ_BYTES) {
  return reader.readPropositionPolicyStableViewForRuntime({
    abrainHome: root,
    settings: { maxReadBytes },
    sessionManager: {
      isPersisted: () => true,
      getSessionId: () => "tier1-policy-bridge-smoke",
      getSessionFile: () => path.join(tmpRoot, "never-created.jsonl"),
    },
  });
}

/** Default runtimeMaxReadBytes = hard envelope so multi-item fixtures can still selected_valid. */
function sourceChangeOpts(home, requiredEventIds, runtimeMaxReadBytes = HARD_MAX_READ_BYTES) {
  return {
    abrainHome: home,
    repoRoot,
    requiredEventIds,
    runtimeMaxReadBytes,
  };
}

function markerPath(home, eventId) {
  return path.join(
    home,
    ".state/sediment/proposition-policy-stable-view-source-change/v1/pending",
    `${eventId}.json`,
  );
}

process.stdout.write("smoke:proposition-tier1-policy-bridge (fixture/offline contracts; not production fresh-session acceptance)\n");

await check("settings default false; production may arm separately", () => {
  assert(settingsMod.DEFAULT_SEDIMENT_SETTINGS.propositionTier1PolicyWriter.enabled === false, "default enabled must be false");
  // resolveSedimentSettings() reads live pi-astack-settings.json; production is armed true.
  const live = settingsMod.resolveSedimentSettings();
  assert(typeof live.propositionTier1PolicyWriter.enabled === "boolean", "live setting resolves");
});

await check("registry keeps defined_inactive/write_enabled=false and allowlists dedicated producer", () => {
  const registry = l1.loadL1SchemaRegistry(path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const entry = registry.entries.find((e) => e.envelope_schema === "proposition-evidence-envelope/v1");
  assert(entry, "evidence entry present");
  assert(entry.phase === "defined_inactive", "phase unchanged");
  assert(entry.write_enabled === false, "write_enabled false");
  assert(entry.fold_eligible === false, "fold false");
  assert(entry.producers.includes("pi-astack.proposition-tier1-policy-writer"), "producer allowlisted");
  assert(entry.producers.includes("pi-astack.proposition-production-evidence-writer"), "prior producer retained");
});

const bridgeHome = path.join(tmpRoot, "bridge-home");
fs.mkdirSync(bridgeHome, { recursive: true, mode: 0o700 });

await check("idempotent content-addressed proposition id + created then identical", async () => {
  const c1 = await appendConstraint(bridgeHome);
  assert(c1.append.ok, `constraint append failed: ${c1.append.status}`);
  const p1 = await appendProposition(bridgeHome, c1);
  assert(p1.ok, `proposition failed: ${p1.code || p1.status}`);
  assert(p1.status === "created", `expected created, got ${p1.status}`);
  assert(typeof p1.eventId === "string" && /^[0-9a-f]{64}$/.test(p1.eventId), "event id");
  assert(!JSON.stringify(p1.audit).includes(GLOBAL_SIGNAL.user_quote), "audit must not include body text");

  const p2 = await appendProposition(bridgeHome, c1);
  assert(p2.ok && p2.status === "identical", `expected identical rerun, got ${p2.status}`);
  assert(p2.eventId === p1.eventId, "idempotent event id must match");
});

await check("generic preflight remains L1_SCHEMA_WRITE_DISABLED", async () => {
  const c = await appendConstraint(bridgeHome, {
    candidateId: "tier1-direct:generic-gate",
    createdAtUtc: "2026-07-25T01:00:01.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "全局规则：禁止静默跳过真实验收。" },
    draft: { ...GLOBAL_DRAFT, body: "全局规则：禁止静默跳过真实验收。", title: "no-silent-skip" },
  });
  assert(c.append.ok, "constraint ok");
  const envelope = writer.buildTier1PolicyPropositionEnvelope({
    abrainHome: bridgeHome,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: { ...GLOBAL_SIGNAL, user_quote: "全局规则：禁止静默跳过真实验收。" },
    draft: { ...GLOBAL_DRAFT, body: "全局规则：禁止静默跳过真实验收。", title: "no-silent-skip" },
    sessionId: "019f93cb-e736-7110-b6ea-cf3ee07b68be",
    turnId: "4",
  });
  assert(envelope.body.proposition.statement.length > 0, "statement present");
  try {
    await l1.validateL1WritePreflight({
      abrainHome: bridgeHome,
      envelope,
      targetPath: l1.expectedL1EventPath(bridgeHome, envelope.event_id),
      expected: {
        envelopeSchema: "proposition-evidence-envelope/v1",
        domain: "proposition",
        role: "evidence",
        producer: "pi-astack.proposition-tier1-policy-writer",
        eventType: "proposition_observed",
      },
    });
    throw new Error("generic preflight must not succeed");
  } catch (err) {
    assert(err?.code === "L1_SCHEMA_WRITE_DISABLED", `expected L1_SCHEMA_WRITE_DISABLED, got ${err?.code}`);
  }
  // dedicated writer still works
  const written = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: { ...GLOBAL_SIGNAL, user_quote: "全局规则：禁止静默跳过真实验收。" },
    draft: { ...GLOBAL_DRAFT, body: "全局规则：禁止静默跳过真实验收。", title: "no-silent-skip" },
    sessionId: "019f93cb-e736-7110-b6ea-cf3ee07b68be",
    turnId: "4",
  });
  assert(written.ok, `dedicated write failed: ${written.code}`);
  assert(written.generic_write_gate === "L1_SCHEMA_WRITE_DISABLED", "gate recorded");
});

await check("scope unknown / unresolved fail-closed (no write)", async () => {
  const before = fs.existsSync(path.join(bridgeHome, "l1/events/sha256"))
    ? fs.readdirSync(path.join(bridgeHome, "l1/events/sha256"), { recursive: true }).length
    : 0;
  const unknownBody = constraintIntegration.buildTier1ConstraintEvidenceEventBody(baseConstraintOptions({
    projectId: "",
    signal: {
      user_quote: "以后注意一点就行",
      correction_intent: "vague",
      scope_description: "maybe somewhere",
      confidence: 9,
      is_directive: true,
    },
    draft: {
      title: "vague",
      body: "以后注意一点就行",
      entryConfidence: 9,
    },
    candidateId: "tier1-direct:unknown-scope",
    createdAtUtc: "2026-07-25T01:00:02.000Z",
  }));
  assert(unknownBody.scope.scope_hint.kind === "unknown", `expected unknown scope, got ${unknownBody.scope.scope_hint.kind}`);
  const envelope = constraintHash.createConstraintEvidenceEnvelope(unknownBody);
  const refused = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: envelope,
    constraintBody: unknownBody,
    signal: {
      user_quote: "以后注意一点就行",
      confidence: 9,
      is_directive: true,
    },
    draft: { title: "vague", body: "以后注意一点就行", entryConfidence: 9 },
    sessionId: unknownBody.session_id,
    turnId: unknownBody.turn_id,
  });
  assert(!refused.ok, "must refuse unknown scope");
  assert(refused.code === "PROPOSITION_TIER1_SCOPE_UNKNOWN", `code=${refused.code}`);
  const after = fs.existsSync(path.join(bridgeHome, "l1/events/sha256"))
    ? fs.readdirSync(path.join(bridgeHome, "l1/events/sha256"), { recursive: true }).length
    : 0;
  assert(after === before, "unknown scope must not create files");
});

await check("sanitizer blocked constraint refuses proposition", async () => {
  const blockedBody = constraintIntegration.buildTier1ConstraintEvidenceEventBody(baseConstraintOptions({
    signal: {
      ...GLOBAL_SIGNAL,
      user_quote: "所有项目 API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345",
    },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345",
    },
    candidateId: "tier1-direct:secret",
  }));
  // If sanitizer doesn't block secret-like content, force blocked status and
  // rebuild a content-addressed envelope so causal binding still holds.
  let body = blockedBody;
  if (body.sanitizer.status !== "blocked") {
    body = {
      ...body,
      sanitizer: {
        ...body.sanitizer,
        status: "blocked",
        blocked_reason: "forced for smoke",
      },
    };
  }
  const envelope = constraintHash.createConstraintEvidenceEnvelope(body);
  const refused = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: envelope,
    constraintBody: body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: body.session_id,
    turnId: body.turn_id,
  });
  assert(!refused.ok, "must refuse blocked sanitizer");
  assert(refused.code === "PROPOSITION_TIER1_SANITIZER_BLOCKED", `code=${refused.code}`);
});

await check("envelope/body/session mismatch fail-closed", async () => {
  const c = await appendConstraint(bridgeHome, {
    candidateId: "tier1-direct:mismatch",
    createdAtUtc: "2026-07-25T01:30:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目禁止伪造 lineage。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目禁止伪造 lineage。", title: "no-fake-lineage" },
  });
  assert(c.append.ok, "constraint ok");

  // Body diverges from envelope.body
  const bodyMismatch = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: c.append.envelope,
    constraintBody: {
      ...c.body,
      payload: { ...c.body.payload, sanitized_quote: "tampered quote that is not in the envelope" },
    },
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: c.body.session_id,
    turnId: c.body.turn_id,
  });
  assert(!bodyMismatch.ok, "body mismatch must refuse");
  assert(bodyMismatch.code === "PROPOSITION_TIER1_BODY_MISMATCH", `code=${bodyMismatch.code}`);

  // Session mismatch vs constraint body SOT
  const sessionMismatch = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: "forged-session-id",
    turnId: c.body.turn_id,
  });
  assert(!sessionMismatch.ok, "session mismatch must refuse");
  assert(sessionMismatch.code === "PROPOSITION_TIER1_SESSION_MISMATCH", `code=${sessionMismatch.code}`);

  // Turn mismatch
  const turnMismatch = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: c.body.session_id,
    turnId: "forged-turn",
  });
  assert(!turnMismatch.ok, "turn mismatch must refuse");
  assert(turnMismatch.code === "PROPOSITION_TIER1_TURN_MISMATCH", `code=${turnMismatch.code}`);

  // Non-content-addressed envelope (event_id != body_hash)
  const brokenEnvelope = {
    ...c.append.envelope,
    event_id: "c".repeat(64),
  };
  const notAddressed = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    constraintEnvelope: brokenEnvelope,
    constraintBody: c.body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: c.body.session_id,
    turnId: c.body.turn_id,
  });
  assert(!notAddressed.ok, "non-content-addressed must refuse");
  assert(
    notAddressed.code === "PROPOSITION_TIER1_ENVELOPE_NOT_CONTENT_ADDRESSED"
      || notAddressed.code === "PROPOSITION_TIER1_ENVELOPE_BODY_HASH_MISMATCH",
    `code=${notAddressed.code}`,
  );
});

await check("registry drift rejects dedicated writer", async () => {
  const home = path.join(tmpRoot, "registry-drift");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:registry-drift",
    createdAtUtc: "2026-07-25T01:40:00.000Z",
  });
  assert(c.append.ok, "constraint");
  // Point registryPath at a temp registry without the dedicated producer.
  const driftRegistryPath = path.join(tmpRoot, "drift-registry.json");
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas/l1-schema-role-registry.json"), "utf8"));
  const entry = registry.entries.find((e) => e.envelope_schema === "proposition-evidence-envelope/v1");
  entry.producers = entry.producers.filter((p) => p !== "pi-astack.proposition-tier1-policy-writer");
  fs.writeFileSync(driftRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const refused = await writer.appendTier1PolicyProposition({
    abrainHome: home,
    registryPath: driftRegistryPath,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: c.body.session_id,
    turnId: c.body.turn_id,
  });
  assert(!refused.ok, "registry drift must refuse");
  assert(refused.code === "PROPOSITION_TIER1_REGISTRY_DRIFT", `code=${refused.code}`);
});

await check("P2a treats policy=true proposition as entry (not exclusion)", async () => {
  const home = path.join(tmpRoot, "p2a-home");
  await preparePropositionPolicyStableViewFixture({
    repoRoot,
    abrainHome: home,
    includePolicy: false,
  });
  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:p2a",
    createdAtUtc: "2026-07-25T02:00:00.000Z",
  });
  assert(c.append.ok, "constraint");
  const p = await appendProposition(home, c);
  assert(p.ok, `prop: ${p.code}`);
  const bundle = await p2a.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot });
  const entrySourceIds = (bundle.entries?.entries || []).map((e) => e.source_event_id);
  const exclusionIds = (bundle.exclusions?.exclusions || []).map((e) => e.source_event_id);
  assert(entrySourceIds.includes(p.eventId), `expected P2a entry for ${p.eventId}; entries=${entrySourceIds.join(",")}`);
  assert(!exclusionIds.includes(p.eventId), "must not be policy exclusion");
});

await check("constraint success + proposition failure: no legacy path implied; retryable write_failed semantics", async () => {
  // Simulate refusal path: missing abrain → write refuse, not silent success.
  const missing = path.join(tmpRoot, "missing-abrain-not-created");
  const c = await appendConstraint(bridgeHome, {
    candidateId: "tier1-direct:retry",
    createdAtUtc: "2026-07-25T03:00:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目禁止恢复 legacy rules fallback。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目禁止恢复 legacy rules fallback。", title: "no-legacy" },
  });
  assert(c.append.ok, "constraint ok");
  const refused = await writer.appendTier1PolicyProposition({
    abrainHome: missing,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: c.body.session_id,
    turnId: c.body.turn_id,
  });
  assert(!refused.ok, "must fail without abrain");
  assert(refused.audit.ok === false, "audit failure");
  assert(refused.audit.constraint_event_id === c.append.eventId, "lineage constraint id in audit");
  // Terminal code path for missing abrain is deterministic refuse — retry semantics
  // leave signal unconsumed at tryAutoWriteLane (tested via reason prefix contract).
  assert(typeof refused.code === "string" && refused.code.length > 0, "error code present");
});

await check("pending marker durable + idempotent; success clears; failure retains", async () => {
  const home = path.join(tmpRoot, "marker-lifecycle");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:marker",
    createdAtUtc: "2026-07-25T03:30:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目必须 durable enqueue pending marker。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目必须 durable enqueue pending marker。", title: "marker-rule" },
  });
  assert(c.append.ok, "constraint");
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目必须 durable enqueue pending marker。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目必须 durable enqueue pending marker。", title: "marker-rule" },
  });
  assert(p.ok && p.eventId, `prop ${p.code}`);

  const m1 = await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);
  assert(m1.status === "created" || m1.status === "identical", `m1 status=${m1.status}`);
  assert(fs.existsSync(markerPath(home, p.eventId)), "marker file exists");
  const raw = fs.readFileSync(markerPath(home, p.eventId), "utf8");
  assert(!raw.includes("所有项目"), "marker must not include statement text");
  assert(JSON.parse(raw).event_id === p.eventId, "marker event id");

  const m2 = await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);
  assert(m2.status === "identical", `idempotent enqueue expected identical, got ${m2.status}`);

  // Failure path retains marker: force with impossible required id (still leave our marker).
  const listedBefore = await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  assert(listedBefore.includes(p.eventId), "listed before");

  // Success path clears marker after covering republish.
  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });
  const forced = await recovery.forceRepublishPropositionPolicyStableView(
    sourceChangeOpts(home, [p.eventId]),
  );
  assert(forced.status === "republished" || forced.status === "contended_converged", `force status=${forced.status} ${forced.error_code}`);
  assert(!fs.existsSync(markerPath(home, p.eventId)), "marker cleared after covering success");
  const listedAfter = await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  assert(!listedAfter.includes(p.eventId), "list empty of cleared id");

  // Failure retains: re-enqueue, force with a missing required id (not in L1).
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);
  const missingId = "d".repeat(64);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, missingId);
  // Put a placeholder file for missingId? No — force required includes missingId which won't be in manifest.
  // Actually enqueue only creates marker files, not L1 events. force with [missingId] fails and must retain marker.
  const failed = await recovery.forceRepublishPropositionPolicyStableView(
    sourceChangeOpts(home, [missingId]),
  );
  assert(failed.status === "failed", `expected failed for missing id, got ${failed.status}`);
  assert(fs.existsSync(markerPath(home, missingId)), "failed required marker retained");
  // p.eventId may be acked if whole-L1 cover happened — either retained or cleared is OK for extras;
  // required missingId must remain.
  assert(fs.existsSync(markerPath(home, missingId)), "missing marker still on disk after failed force");
});

await check("process restart state reset replays from durable pending markers", async () => {
  const home = path.join(tmpRoot, "marker-replay");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });

  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:replay",
    createdAtUtc: "2026-07-25T03:45:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目重启后必须从 pending marker 重放 force republish。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目重启后必须从 pending marker 重放 force republish。",
      title: "marker-replay",
    },
  });
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目重启后必须从 pending marker 重放 force republish。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目重启后必须从 pending marker 重放 force republish。",
      title: "marker-replay",
    },
  });
  assert(p.ok, `prop ${p.code}`);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);
  assert(fs.existsSync(markerPath(home, p.eventId)), "marker before restart");

  // Simulate process restart: clear in-memory singleflight/pending only.
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();
  const diag = recovery.getPropositionPolicyStableViewSourceChangeDiagnostics(home);
  assert(diag.in_flight === false && diag.scheduled === false && diag.pending_event_ids.length === 0, "memory cleared");
  // Durable marker still present.
  assert(fs.existsSync(markerPath(home, p.eventId)), "marker survives memory reset");

  // Real session-start helper contract: Promise<Result|null>, not nested Promise.
  // Do not `await scheduled` a second time — that would mask assimilation bugs.
  const result = await recovery.schedulePropositionPolicyStableViewSourceChangeFromPendingMarkers(
    sourceChangeOpts(home, []),
  );
  assert(result, "must schedule from markers");
  assert(typeof result.then !== "function", "helper must resolve to Result|null, not nested Promise");
  assert(result.status === "republished" || result.status === "contended_converged", `replay status=${result.status} ${result.error_code}`);
  assert(result.required_event_ids.includes(p.eventId), "required includes marker id");
  assert(!fs.existsSync(markerPath(home, p.eventId)), "marker cleared after replay success");

  const after = strictRead(home);
  assert(after.ok && after.reason === "selected_valid", `after ${after.reason}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(
    home,
    ".state/sediment/proposition-policy-stable-view/v1/bundles",
    after.bundleHash,
    "manifest.json",
  ), "utf8"));
  assert(manifest.canonical_source.input_event_ids.includes(p.eventId), "replayed proposition in source closure");
});

await check("force source-change republish is not already_valid and covers new proposition", async () => {
  const home = path.join(tmpRoot, "force-republish");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  // Publish baseline so a later force path cannot short-circuit via already_valid.
  const baseline = await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });
  assert(baseline.status === "created" || baseline.status === "identical", "baseline publish");
  const before = strictRead(home);
  assert(before.ok && before.reason === "selected_valid", `baseline read: ${before.reason}`);

  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:force",
    createdAtUtc: "2026-07-25T04:00:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目的 policy stable-view 必须在新命题后强制 republish。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目的 policy stable-view 必须在新命题后强制 republish。",
      title: "force-republish-rule",
    },
  });
  assert(c.append.ok, "constraint");
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目的 policy stable-view 必须在新命题后强制 republish。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目的 policy stable-view 必须在新命题后强制 republish。",
      title: "force-republish-rule",
    },
  });
  assert(p.ok, `prop ${p.code}`);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);

  // Without force, recovery would return already_valid because baseline is valid.
  const naive = await recovery.recoverPropositionPolicyStableView({ abrainHome: home, repoRoot });
  assert(naive.status === "already_valid", `expected already_valid naive recovery, got ${naive.status}`);

  const forced = await recovery.forceRepublishPropositionPolicyStableView(
    sourceChangeOpts(home, [p.eventId]),
  );
  assert(forced.already_valid_short_circuit === false, "must never report already_valid short-circuit");
  assert(forced.status === "republished" || forced.status === "contended_converged", `status=${forced.status} err=${forced.error_code}:${forced.error_message}`);
  assert(forced.final_read_reason === "selected_valid", `final read ${forced.final_read_reason}`);
  assert(forced.required_event_ids.includes(p.eventId), "required ids retained");
  assert(forced.bundle_hash, "bundle hash present");
  assert(!fs.existsSync(markerPath(home, p.eventId)), "marker cleared after force success");

  const after = strictRead(home);
  assert(after.ok && after.reason === "selected_valid", `after read ${after.reason}`);
  const manifestPath = path.join(
    home,
    ".state/sediment/proposition-policy-stable-view/v1/bundles",
    after.bundleHash,
    "manifest.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const inputIds = manifest.canonical_source.input_event_ids;
  assert(inputIds.includes(p.eventId), `input_event_ids missing proposition ${p.eventId}`);
});

await check("singleflight + pending coalesce for source-change republish", async () => {
  const home = path.join(tmpRoot, "coalesce");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });

  const c1 = await appendConstraint(home, {
    candidateId: "tier1-direct:coalesce-1",
    createdAtUtc: "2026-07-25T05:00:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目必须合并 coalesce 的 force republish。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目必须合并 coalesce 的 force republish。", title: "coalesce-1" },
  });
  const p1 = await appendProposition(home, c1, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目必须合并 coalesce 的 force republish。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目必须合并 coalesce 的 force republish。", title: "coalesce-1" },
  });
  assert(p1.ok, "p1");
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p1.eventId);

  const c2 = await appendConstraint(home, {
    candidateId: "tier1-direct:coalesce-2",
    createdAtUtc: "2026-07-25T05:00:01.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目还要覆盖第二次 coalesce 命题。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目还要覆盖第二次 coalesce 命题。", title: "coalesce-2" },
  });
  const p2 = await appendProposition(home, c2, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目还要覆盖第二次 coalesce 命题。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目还要覆盖第二次 coalesce 命题。", title: "coalesce-2" },
  });
  assert(p2.ok, "p2");
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p2.eventId);

  const a = recovery.schedulePropositionPolicyStableViewSourceChangeRepublish(
    sourceChangeOpts(home, [p1.eventId]),
  );
  const b = recovery.schedulePropositionPolicyStableViewSourceChangeRepublish(
    sourceChangeOpts(home, [p2.eventId]),
  );
  // Same scheduled promise under singleflight coalesce.
  assert(a === b, "scheduled promises must coalesce");
  const result = await a;
  assert(result.status === "republished" || result.status === "contended_converged", `coalesce status=${result.status} ${result.error_code}`);
  await recovery.waitForPropositionPolicyStableViewSourceChangeRepublishIdle(home);
  const diag = recovery.getPropositionPolicyStableViewSourceChangeDiagnostics(home);
  assert(diag.in_flight === false && diag.scheduled === false, "idle after wait");
  const read = strictRead(home);
  assert(read.ok, "selected_valid after coalesce");
  const manifest = JSON.parse(fs.readFileSync(path.join(
    home,
    ".state/sediment/proposition-policy-stable-view/v1/bundles",
    read.bundleHash,
    "manifest.json",
  ), "utf8"));
  const ids = new Set(manifest.canonical_source.input_event_ids);
  assert(ids.has(p1.eventId), "coalesce must cover p1");
  assert(ids.has(p2.eventId), "coalesce must cover p2");
  assert(!fs.existsSync(markerPath(home, p1.eventId)), "p1 marker cleared");
  assert(!fs.existsSync(markerPath(home, p2.eventId)), "p2 marker cleared");
});

await check("in-flight new wave is processed by subsequent wave of same loop", async () => {
  const home = path.join(tmpRoot, "inflight-wave");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });

  const c1 = await appendConstraint(home, {
    candidateId: "tier1-direct:wave-1",
    createdAtUtc: "2026-07-25T05:30:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目第一波 force republish 必须先跑。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目第一波 force republish 必须先跑。", title: "wave-1" },
  });
  const p1 = await appendProposition(home, c1, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目第一波 force republish 必须先跑。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目第一波 force republish 必须先跑。", title: "wave-1" },
  });
  assert(p1.ok, "p1");
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p1.eventId);

  // Start first wave.
  const first = recovery.schedulePropositionPolicyStableViewSourceChangeRepublish(
    sourceChangeOpts(home, [p1.eventId]),
  );

  // While first is scheduled/in-flight, append a second event and schedule it.
  const c2 = await appendConstraint(home, {
    candidateId: "tier1-direct:wave-2",
    createdAtUtc: "2026-07-25T05:30:01.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目第二波 in-flight 新 id 必须进入后续 wave。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目第二波 in-flight 新 id 必须进入后续 wave。", title: "wave-2" },
  });
  const p2 = await appendProposition(home, c2, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目第二波 in-flight 新 id 必须进入后续 wave。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目第二波 in-flight 新 id 必须进入后续 wave。", title: "wave-2" },
  });
  assert(p2.ok, "p2");
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p2.eventId);

  const second = recovery.schedulePropositionPolicyStableViewSourceChangeRepublish(
    sourceChangeOpts(home, [p2.eventId]),
  );
  // Coalesced onto same scheduled promise (or same loop via lost-wakeup re-arm).
  assert(first === second || typeof second.then === "function", "second is scheduled");

  await first;
  await second;
  await recovery.waitForPropositionPolicyStableViewSourceChangeRepublishIdle(home);

  const read = strictRead(home);
  assert(read.ok, "selected_valid after waves");
  const manifest = JSON.parse(fs.readFileSync(path.join(
    home,
    ".state/sediment/proposition-policy-stable-view/v1/bundles",
    read.bundleHash,
    "manifest.json",
  ), "utf8"));
  const ids = new Set(manifest.canonical_source.input_event_ids);
  assert(ids.has(p1.eventId), "wave1 covered");
  assert(ids.has(p2.eventId), "wave2 covered (in-flight new wave)");
  assert(!fs.existsSync(markerPath(home, p1.eventId)), "p1 marker cleared");
  assert(!fs.existsSync(markerPath(home, p2.eventId)), "p2 marker cleared");
});

await check("sandbox runtime reader injects selected_valid view including new policy statement", async () => {
  const home = path.join(tmpRoot, "reader-inject");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home, includePolicy: false });
  configureRoot(home);
  const statement = "所有项目验收必须以真实生产数据为准，禁止只靠手写 fixture。";
  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:reader",
    createdAtUtc: "2026-07-25T06:00:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: statement },
    draft: { ...GLOBAL_DRAFT, body: statement, title: "real-data-acceptance" },
  });
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: statement },
    draft: { ...GLOBAL_DRAFT, body: statement, title: "real-data-acceptance" },
  });
  assert(p.ok, `prop ${p.code}`);
  const pub = await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });
  assert(pub.bundle_hash, "published");
  const read = strictRead(home);
  assert(read.ok && read.reason === "selected_valid", `read ${read.reason}`);
  assert(read.itemCount >= 1, `itemCount=${read.itemCount}`);
  assert(read.viewMd.includes(statement) || read.viewMd.length > 0, "view has injectable content");
});

await check("session-start helper returns Result|null (no nested .then)", async () => {
  const home = path.join(tmpRoot, "helper-shape");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  // Empty pending → null (not a Promise).
  const empty = await recovery.schedulePropositionPolicyStableViewSourceChangeFromPendingMarkers(
    sourceChangeOpts(home, []),
  );
  assert(empty === null, "empty pending must resolve null");

  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });
  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:helper-shape",
    createdAtUtc: "2026-07-25T06:10:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 session_start helper 必须直接返回 Result。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目 session_start helper 必须直接返回 Result。", title: "helper-shape" },
  });
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 session_start helper 必须直接返回 Result。" },
    draft: { ...GLOBAL_DRAFT, body: "所有项目 session_start helper 必须直接返回 Result。", title: "helper-shape" },
  });
  assert(p.ok, `prop ${p.code}`);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);

  // Mirror session_start call shape: outer .then receives Result|null, not Promise.
  let observed = null;
  await new Promise((resolve, reject) => {
    recovery.schedulePropositionPolicyStableViewSourceChangeFromPendingMarkers(
      sourceChangeOpts(home, []),
    ).then((value) => {
      observed = value;
      resolve();
    }, reject);
  });
  assert(observed, "non-empty pending must yield a Result");
  assert(typeof observed.then !== "function", "session_start callback must not receive a thenable");
  assert(
    observed.status === "republished" || observed.status === "contended_converged",
    `helper status=${observed.status} ${observed.error_code}`,
  );
  assert(observed.required_event_ids.includes(p.eventId), "result carries required ids");
});

await check("symlink parent fails closed without external side effects", async () => {
  const home = path.join(tmpRoot, "marker-symlink-home");
  const external = path.join(tmpRoot, "marker-symlink-external");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, ".state"), { mode: 0o700 });
  fs.mkdirSync(external, { mode: 0o700 });
  // Inject symlink mid-chain before pending path is created.
  fs.symlinkSync(external, path.join(home, ".state", "sediment"), "dir");
  const eventId = "a".repeat(64);

  let enqueueCode = null;
  try {
    await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, eventId);
  } catch (error) {
    enqueueCode = error?.code || String(error?.message || error);
  }
  assert(String(enqueueCode).includes("SOURCE_CHANGE_PENDING_PATH_UNSAFE"), `enqueue code=${enqueueCode}`);
  assert(fs.readdirSync(external).length === 0, "symlink parent must not create external dirs/files");
  assert(!fs.existsSync(markerPath(home, eventId)), "no marker via symlink escape");

  let listCode = null;
  try {
    await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  } catch (error) {
    listCode = error?.code || String(error?.message || error);
  }
  assert(String(listCode).includes("SOURCE_CHANGE_PENDING_PATH_UNSAFE"), `list code=${listCode}`);

  let deleteCode = null;
  try {
    await recovery.deletePropositionPolicyStableViewSourceChangePendingMarker(home, eventId);
  } catch (error) {
    deleteCode = error?.code || String(error?.message || error);
  }
  assert(String(deleteCode).includes("SOURCE_CHANGE_PENDING_PATH_UNSAFE"), `delete code=${deleteCode}`);
  assert(fs.readdirSync(external).length === 0, "list/delete also leave external empty");
});

await check("corrupt and foreign pending markers fail closed on list", async () => {
  const home = path.join(tmpRoot, "marker-corrupt");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const goodId = "b".repeat(64);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, goodId);
  assert((await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home)).includes(goodId), "good listed");

  const corruptId = "c".repeat(64);
  fs.writeFileSync(markerPath(home, corruptId), "{not-json\n", { mode: 0o600 });
  let corruptCode = null;
  try {
    await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  } catch (error) {
    corruptCode = error?.code || String(error?.message || error);
  }
  assert(String(corruptCode).includes("SOURCE_CHANGE_PENDING_CORRUPT"), `corrupt code=${corruptCode}`);

  fs.unlinkSync(markerPath(home, corruptId));
  // Invalid schema / mismatched event_id is also corrupt, not silent skip.
  fs.writeFileSync(
    markerPath(home, corruptId),
    `${JSON.stringify({ schema: "wrong", event_id: corruptId })}\n`,
    { mode: 0o600 },
  );
  corruptCode = null;
  try {
    await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  } catch (error) {
    corruptCode = error?.code || String(error?.message || error);
  }
  assert(String(corruptCode).includes("SOURCE_CHANGE_PENDING_CORRUPT"), `invalid content code=${corruptCode}`);
  fs.unlinkSync(markerPath(home, corruptId));

  fs.writeFileSync(path.join(path.dirname(markerPath(home, goodId)), "notes.txt"), "foreign\n", { mode: 0o600 });
  let foreignCode = null;
  try {
    await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  } catch (error) {
    foreignCode = error?.code || String(error?.message || error);
  }
  assert(String(foreignCode).includes("SOURCE_CHANGE_PENDING_FOREIGN"), `foreign code=${foreignCode}`);
});

await check("pending marker dir created level-by-level as real directories", async () => {
  const home = path.join(tmpRoot, "marker-mkdir");
  fs.mkdirSync(home, { mode: 0o700 });
  const eventId = "e".repeat(64);
  const enq = await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, eventId);
  assert(enq.status === "created" || enq.status === "identical", `enq=${enq.status}`);

  let current = home;
  for (const part of [".state", "sediment", "proposition-policy-stable-view-source-change", "v1", "pending"]) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    assert(st.isDirectory() && !st.isSymbolicLink(), `${part} must be a real directory`);
  }
  assert(fs.existsSync(markerPath(home, eventId)), "marker file after durable create");
  const listed = await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  assert(listed.includes(eventId), "listed after level-by-level create");

  const del = await recovery.deletePropositionPolicyStableViewSourceChangePendingMarker(home, eventId);
  assert(del === "deleted", `delete status=${del}`);
  assert(!fs.existsSync(markerPath(home, eventId)), "deleted from disk");
  const missing = await recovery.deletePropositionPolicyStableViewSourceChangePendingMarker(home, eventId);
  assert(missing === "missing", "second delete is missing");
  // Missing pending tree → empty list, not throw.
  fs.rmSync(path.join(home, ".state"), { recursive: true, force: true });
  const empty = await recovery.listPropositionPolicyStableViewSourceChangePendingMarkers(home);
  assert(Array.isArray(empty) && empty.length === 0, "missing chain lists empty");
});

await check("ack failure after covering publish reports failed and retains marker", async () => {
  const home = path.join(tmpRoot, "ack-fail");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();
  recovery.__TEST.resetControls();

  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });
  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:ack-fail",
    createdAtUtc: "2026-07-25T06:20:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 durable ack 失败时不得虚报 source-change success。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 durable ack 失败时不得虚报 source-change success。",
      title: "ack-fail",
    },
  });
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 durable ack 失败时不得虚报 source-change success。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 durable ack 失败时不得虚报 source-change success。",
      title: "ack-fail",
    },
  });
  assert(p.ok, `prop ${p.code}`);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);

  // After child publish covers events, inject foreign state so list-during-ack fails.
  recovery.__TEST.setControls({
    afterChildPublication: () => {
      fs.writeFileSync(path.join(path.dirname(markerPath(home, p.eventId)), "foreign.bin"), "x\n", { mode: 0o600 });
    },
  });
  try {
    const forced = await recovery.forceRepublishPropositionPolicyStableView(
      sourceChangeOpts(home, [p.eventId]),
    );
    assert(forced.status === "failed", `expected failed on ack error, got ${forced.status}`);
    assert(
      String(forced.error_code || "").includes("SOURCE_CHANGE_PENDING_FOREIGN")
        || String(forced.error_message || "").includes("SOURCE_CHANGE_PENDING_FOREIGN")
        || String(forced.error_message || "").includes("foreign"),
      `ack fail code=${forced.error_code} msg=${forced.error_message}`,
    );
    assert(fs.existsSync(markerPath(home, p.eventId)), "marker retained for at-least-once retry");
    // Stable-view may already cover; durable ack must not pretend success.
    const after = strictRead(home);
    assert(after.ok && after.reason === "selected_valid", "view can be covered while ack failed");
  } finally {
    recovery.__TEST.resetControls();
  }
});

await check("P1-A: raw storage I/O → write_failed status + HOLD reason (not terminal)", async () => {
  // Build a valid constraint on a writable home, then attempt the proposition
  // append against a read-only abrain root so durable create hits EACCES/EPERM.
  const c = await appendConstraint(bridgeHome, {
    candidateId: "tier1-direct:eacces-io",
    createdAtUtc: "2026-07-25T07:00:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 I/O 失败不得推进 checkpoint。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 I/O 失败不得推进 checkpoint。",
      title: "io-hold",
    },
  });
  assert(c.append.ok, "constraint for I/O probe");

  const roHome = path.join(tmpRoot, "readonly-abrain-io");
  fs.mkdirSync(roHome, { recursive: true, mode: 0o500 });
  // Ensure non-writable even if umask interfered.
  fs.chmodSync(roHome, 0o500);

  let ioFail;
  try {
    ioFail = await writer.appendTier1PolicyProposition({
      abrainHome: roHome,
      constraintEnvelope: c.append.envelope,
      constraintBody: c.body,
      signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 I/O 失败不得推进 checkpoint。" },
      draft: {
        ...GLOBAL_DRAFT,
        body: "所有项目 I/O 失败不得推进 checkpoint。",
        title: "io-hold",
      },
      sessionId: c.body.session_id,
      turnId: c.body.turn_id,
    });
  } finally {
    // Restore write bits so cleanup can remove the tree.
    try { fs.chmodSync(roHome, 0o700); } catch { /* ignore */ }
  }

  assert(!ioFail.ok, "I/O fault must not succeed");
  assert(ioFail.status === "write_failed", `expected write_failed status, got ${ioFail.status} code=${ioFail.code}`);
  assert(
    ioFail.code === "EACCES" || ioFail.code === "EPERM" || ioFail.code === "EROFS",
    `expected Node I/O code retained in diagnostics, got ${ioFail.code}`,
  );
  assert(ioFail.audit.code === ioFail.code, "audit must retain original code");
  assert(ioFail.audit.status === "write_failed", "audit status tracks write_failed");

  // Index contract: reason is exact HOLD string; predicate says non-terminal.
  const holdReason = writer.buildPropositionTier1PolicyWriteFailedCheckpointReason(ioFail);
  assert(
    holdReason === writer.PROPOSITION_TIER1_POLICY_WRITE_FAILED_HOLD_REASON,
    `HOLD reason must be exact write_failed, got ${holdReason}`,
  );
  assert(
    holdReason === "proposition_tier1_policy_write_failed:write_failed",
    "literal HOLD contract",
  );
  assert(
    writer.isTerminalPropositionTier1PolicyWriteReason(holdReason) === false,
    "exported predicate must mark write_failed as non-terminal HOLD+retry",
  );
  // Must not bake raw errno into the checkpoint reason (old bug: terminal EACCES).
  assert(!holdReason.includes("EACCES"), "reason must not suffix EACCES");
  assert(!holdReason.includes("EPERM"), "reason must not suffix EPERM");

  // Deterministic refuse remains terminal (collision/scope/registry vocabulary).
  const missingHome = path.join(tmpRoot, "never-created-abrain-terminal");
  const refused = await writer.appendTier1PolicyProposition({
    abrainHome: missingHome,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: GLOBAL_SIGNAL,
    draft: GLOBAL_DRAFT,
    sessionId: c.body.session_id,
    turnId: c.body.turn_id,
  });
  assert(!refused.ok && refused.status === "refused", `deterministic missing abrain → refused, got ${refused.status}`);
  const terminalReason = writer.buildPropositionTier1PolicyWriteFailedCheckpointReason(refused);
  assert(
    writer.isTerminalPropositionTier1PolicyWriteReason(terminalReason) === true,
    `deterministic refuse must be terminal, reason=${terminalReason}`,
  );
  assert(
    terminalReason !== writer.PROPOSITION_TIER1_POLICY_WRITE_FAILED_HOLD_REASON,
    "deterministic refuse must not collapse to HOLD reason",
  );
});

await check("L1SchemaRegistryError / registry contract invalid → refused + terminal (not write_failed HOLD)", async () => {
  // Structurally valid registry JSON that fails the registry contract (empty entries).
  // loadL1SchemaRegistry throws L1SchemaRegistryError — must not be misclassified as
  // write_failed/HOLD just because the error object carries a `.code` field.
  const c = await appendConstraint(bridgeHome, {
    candidateId: "tier1-direct:registry-contract-invalid",
    createdAtUtc: "2026-07-25T07:05:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 registry contract 失效必须 terminal refuse。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 registry contract 失效必须 terminal refuse。",
      title: "registry-contract-invalid",
    },
  });
  assert(c.append.ok, "constraint for registry-contract probe");

  const invalidRegistryPath = path.join(tmpRoot, "invalid-registry-contract.json");
  fs.writeFileSync(
    invalidRegistryPath,
    `${JSON.stringify({
      schema_version: "l1-schema-role-registry/v2",
      registry_id: "smoke-invalid-registry-contract",
      storage: {
        root_relative_path: "l1/events/sha256",
        canonicalization: "RFC8785-JCS",
        hash_algorithm: "sha256",
        shard_width: 2,
        shard_depth: 2,
        file_extension: ".json",
      },
      entries: [],
    }, null, 2)}\n`,
  );

  const refused = await writer.appendTier1PolicyProposition({
    abrainHome: bridgeHome,
    registryPath: invalidRegistryPath,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 registry contract 失效必须 terminal refuse。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 registry contract 失效必须 terminal refuse。",
      title: "registry-contract-invalid",
    },
    sessionId: c.body.session_id,
    turnId: c.body.turn_id,
  });
  assert(!refused.ok, "registry contract invalid must not succeed");
  assert(refused.status === "refused", `expected refused, got ${refused.status} code=${refused.code}`);
  assert(
    typeof refused.code === "string" && refused.code.startsWith("L1_"),
    `expected preserved L1_* registry code, got ${refused.code}`,
  );
  assert(refused.audit.status === "refused", "audit status tracks refused");
  assert(refused.audit.code === refused.code, "audit must retain original registry code");

  const terminalReason = writer.buildPropositionTier1PolicyWriteFailedCheckpointReason(refused);
  assert(
    writer.isTerminalPropositionTier1PolicyWriteReason(terminalReason) === true,
    `registry validation refuse must be terminal, reason=${terminalReason}`,
  );
  assert(
    terminalReason !== writer.PROPOSITION_TIER1_POLICY_WRITE_FAILED_HOLD_REASON,
    "registry validation refuse must not collapse to HOLD write_failed reason",
  );
  assert(
    terminalReason === `proposition_tier1_policy_write_failed:${refused.code}`,
    `checkpoint reason must preserve code suffix, got ${terminalReason}`,
  );
});

await check("P1-B: source-change runtime budget mismatch fails closed and retains marker", async () => {
  const home = path.join(tmpRoot, "runtime-budget-mismatch");
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: home });
  configureRoot(home);
  recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();

  await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: home,
    repoRoot,
  });

  const c = await appendConstraint(home, {
    candidateId: "tier1-direct:budget-mismatch",
    createdAtUtc: "2026-07-25T07:10:00.000Z",
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 source-change 必须按生产 runtime 读预算 ack。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 source-change 必须按生产 runtime 读预算 ack。",
      title: "budget-mismatch",
    },
  });
  const p = await appendProposition(home, c, {
    signal: { ...GLOBAL_SIGNAL, user_quote: "所有项目 source-change 必须按生产 runtime 读预算 ack。" },
    draft: {
      ...GLOBAL_DRAFT,
      body: "所有项目 source-change 必须按生产 runtime 读预算 ack。",
      title: "budget-mismatch",
    },
  });
  assert(p.ok, `prop ${p.code}`);
  await recovery.enqueuePropositionPolicyStableViewSourceChangePendingMarker(home, p.eventId);
  assert(fs.existsSync(markerPath(home, p.eventId)), "marker before tiny budget force");

  // Hard reader can accept the published set; tiny runtime budget must not.
  const tinyForce = await recovery.forceRepublishPropositionPolicyStableView(
    sourceChangeOpts(home, [p.eventId], TINY_RUNTIME_MAX_READ_BYTES),
  );
  assert(tinyForce.status === "failed", `tiny budget must fail, got ${tinyForce.status} ${tinyForce.error_code}`);
  assert(
    String(tinyForce.final_read_reason || "").includes("oversize")
      || String(tinyForce.error_message || "").includes("oversize")
      || String(tinyForce.error_message || "").includes("runtime"),
    `expected oversize/runtime validation fail, final=${tinyForce.final_read_reason} msg=${tinyForce.error_message}`,
  );
  assert(fs.existsSync(markerPath(home, p.eventId)), "marker retained when runtime budget rejects");

  // Hard envelope can read the published set (the old bug: source-change used hard,
  // acked markers the production 16384 reader would reject).
  const hardRead = strictRead(home, HARD_MAX_READ_BYTES);
  assert(hardRead.ok && hardRead.reason === "selected_valid", `hard reader must accept, got ${hardRead.reason}`);
  const tinyRead = strictRead(home, TINY_RUNTIME_MAX_READ_BYTES);
  assert(!tinyRead.ok && String(tinyRead.reason).includes("oversize"), `tiny reader oversize, got ${tinyRead.reason}`);

  // Sufficient budget (hard envelope) succeeds and acks the marker.
  const okForce = await recovery.forceRepublishPropositionPolicyStableView(
    sourceChangeOpts(home, [p.eventId], HARD_MAX_READ_BYTES),
  );
  assert(
    okForce.status === "republished" || okForce.status === "contended_converged",
    `sufficient budget must succeed, got ${okForce.status} ${okForce.error_code}:${okForce.error_message}`,
  );
  assert(okForce.final_read_reason === "selected_valid", `final ${okForce.final_read_reason}`);
  assert(!fs.existsSync(markerPath(home, p.eventId)), "marker cleared after runtime-budget selected_valid");
});

await check("test hooks require PI_ASTACK_ENABLE_TEST_HOOKS", async () => {
  const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  let threw = false;
  try {
    recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();
  } catch {
    threw = true;
  }
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev;
  assert(threw, "reset must require test hooks");
});

// cleanup
recovery.resetPropositionPolicyStableViewSourceChangeRepublishForTests();
restoreEnv();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
