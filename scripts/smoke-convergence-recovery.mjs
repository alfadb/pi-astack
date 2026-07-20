#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const history = jiti(path.join(root, "extensions/_shared/recovery-history-classifier.ts"));
const l2Contract = jiti(path.join(root, "extensions/_shared/canonical-l2-contract.ts"));
const l2Reconciler = jiti(path.join(root, "extensions/_shared/canonical-l2-reconciler.ts"));
const knowledgeRenderer = jiti(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
const constraintRenderer = jiti(path.join(root, "extensions/sediment/constraint-compiler/render.ts"));
const cohort = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const jcs = jiti(path.join(root, "extensions/_shared/jcs.ts"));
const fixture = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/legacy-drain-recovery-v1.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-local-recovery-v2-"));
let passed = 0;
const failures = [];

function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`); }
}
async function expectCode(code, fn) {
  try { await fn(); } catch (error) { assert(error.code === code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  throw new Error(`expected ${code}`);
}
function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } }).trim();
}
function initRepo(name, format = "sha1") {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main", `--object-format=${format}`);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"], {
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" },
  });
  return repo;
}
function commitFixture(repo, message, epoch = "1700000030") {
  execFileSync("git", ["-C", repo, "commit", "-qm", message], {
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: `${epoch} +0000`, GIT_COMMITTER_DATE: `${epoch} +0000` },
  });
}
function emptyHome(name) {
  const home = path.join(tmp, name);
  fs.mkdirSync(path.join(home, "l1/events/sha256"), { recursive: true });
  return home;
}
function writeEnvelope(home, envelope) {
  const rel = l1.expectedL1EventRelativePath(envelope.event_id);
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  return file;
}
function rehash(envelope) {
  envelope.body_hash = l1.canonicalL1BodyHash(envelope.body);
  envelope.event_id = envelope.body_hash;
  return envelope;
}
function legacyEnvelope(event) {
  const bodyHash = l1.canonicalL1BodyHash(event);
  return { schema: "drain-recovery-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body: event };
}
function legacyEvent(episodeId, slot, eventType, body) {
  return { event_schema_version: "drain-recovery-event/v1", event_type: eventType, producer: { name: "pi-astack.convergence-recovery", version: "1.0.0" }, episode_id: episodeId, lane: "push", slot, body };
}
function operationFor(prepared) {
  return recovery.recoveryOperationV3({
    symbolicRef: "refs/heads/main",
    baseCommit: prepared.frozen,
    cohortSemanticRoot: prepared.prepared.cohortManifestRoot,
    frozenIndexSnapshotRoot: recovery.frozenIndexSnapshotRootV3(prepared.prepared.entries, prepared.snapshot),
  });
}
async function activePreparedFixture(name) {
  const repo = initRepo(`${name}-repo`);
  const prepared = await prepare(repo, "ignored caller message", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const operation = operationFor(prepared);
  const claim = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  assert(claim.slot === 1 && claim.shouldExecute, "active v3 prepared fixture claim missing");
  await recovery.recordDrainPreparedV3({ abrainHome: repo, operation, slot: 1, prepared: prepared.prepared, frozenIndexSnapshot: prepared.snapshot });
  const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
  const record = scan.all.find((item) => item.body.event_type === "commit_prepared");
  const claimRecord = scan.all.find((item) => item.body.event_type === "recovery_slot_claimed");
  assert(record && claimRecord, "active prepared fixture missing");
  return { repo, operation, event: structuredClone(record.body), envelope: structuredClone(record.envelope), claimEvent: structuredClone(claimRecord.body) };
}
async function prepare(repo, message = "ignored caller message", protocolVersion = cohort.LOCAL_DRAIN_PROTOCOL_V2) {
  const frozen = git(repo, "rev-parse", "HEAD");
  const plan = [
    { path: "Z.txt", op: "put", content: "z\n" },
    { path: "a.txt", op: "put", content: "a\n" },
    { path: "\u4e2d.txt", op: "put", content: "unicode\n" },
  ];
  const snapshot = await cohort.snapshotIndexEntries(repo, plan.map((item) => item.path));
  const prepared = await cohort.prepareExactCohortCommit({ repo, refName: "refs/heads/main", frozenCommit: frozen, plan, message, protocolVersion });
  return { frozen, plan, snapshot, prepared };
}

async function abortPreparedPermutation(name, abortFirst) {
  const repo = initRepo(name);
  const prepared = await prepare(repo, name, cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const operation = operationFor(prepared);
  const claim = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  const abort = () => recovery.appendRecoveryEventV3({ abrainHome: repo, operation, slot: claim.slot, eventType: "recovery_slot_aborted", body: { reason: "recovery_slot_aborted", error_code: "RECOVERY_SLOT_ABORTED" } });
  const recordPrepared = () => recovery.recordDrainPreparedV3({ abrainHome: repo, operation, slot: claim.slot, prepared: prepared.prepared, frozenIndexSnapshot: prepared.snapshot });
  if (abortFirst) { await abort(); await recordPrepared(); }
  else { await recordPrepared(); await abort(); }
  return { repo, operation, episodeId: claim.episodeId, prepared };
}

console.log("smoke: U* v2 history reader + v3 local drain recovery");

await check("registry makes v1/v2 legacy read-only and v3 the only active recovery writer", () => {
  const registry = l1.loadL1SchemaRegistry();
  const v1 = registry.entries.find((entry) => entry.envelope_schema === "drain-recovery-envelope/v1");
  const v2 = registry.entries.find((entry) => entry.envelope_schema === "local-drain-recovery-envelope/v2");
  const v3 = registry.entries.find((entry) => entry.envelope_schema === "local-drain-recovery-envelope/v3");
  assert(registry.schema_version === "l1-schema-role-registry/v2", "old reader compatibility barrier missing");
  assert(v1?.phase === "legacy_read_only" && v2?.phase === "legacy_read_only" && !v1.write_enabled && !v2.write_enabled, "v1/v2 disposition mismatch");
  assert(v3?.phase === "active" && v3.write_enabled && !v3.fold_eligible, "v3 disposition mismatch");
});

await check("v2 writer is rejected before creating an event path", async () => {
  const home = emptyHome("v2-write-rejected");
  const before = fs.readdirSync(path.join(home, "l1/events/sha256")).length;
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  await expectCode("L1_SCHEMA_WRITE_DISABLED", () => recovery.claimRecoverySlot({ abrainHome: home, episodeId, lane: "drain", slot: 1 }));
  await expectCode("L1_SCHEMA_WRITE_DISABLED", () => recovery.recoverDrainSlot({ abrainHome: home, repo: home, symbolicRef: "refs/heads/main", episodeId, slot: 1 }));
  assert(fs.readdirSync(path.join(home, "l1/events/sha256")).length === before, "rejected v2 writer created a shard");
});

await check("real legacy IDs strict-validate but stay outside active scan/fold", async () => {
  const home = emptyHome("legacy-valid");
  fixture.envelopes.forEach((envelope) => writeEnvelope(home, envelope));
  const scan = await l1.scanWholeL1Validated({ abrainHome: home });
  assert(scan.all.length === 3 && scan.legacyReadOnly.length === 3, "legacy records were not classified read-only");
  assert(scan.selected.length === 0 && scan.foldable.length === 0, "legacy record entered active selection/fold");
  assert(scan.legacyReadOnly.some((record) => record.eventId === fixture.candidate_event_id), "real candidate ID missing");
  const recovered = recovery.recoverOpenRecoveryEpisodesFromScan(scan);
  assert(recovered.open.length === 0 && recovered.terminal.length === 0, "legacy terminal entered active ownership");
  for (const removed of ["recordPushIntent", "recoverPushEpisode", "recoverPushSlot", "pushEpisodeIdentity", "readPushIntent", "claimCuratorSlot", "curatorEpisodeIdentity"]) assert(!(removed in recovery), `legacy writer fallback remains exported: ${removed}`);
});

await check("malformed legacy v1 fails whole-L1 closed", async () => {
  const home = emptyHome("legacy-malformed");
  const bad = structuredClone(fixture.envelopes[0]);
  bad.body.body.unexpected = true;
  bad.body_hash = l1.canonicalL1BodyHash(bad.body);
  bad.event_id = bad.body_hash;
  writeEnvelope(home, bad);
  await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
});

await check("legacy v1 exact-body mutation table fails whole-L1 closed", async () => {
  const fixtureMutations = [
    ["invalid repo_id", 2, (body) => { body.repo_id = "x".repeat(64); }],
    ["invalid remote", 2, (body) => { body.remote = "upstream"; }],
    ["invalid ref", 0, (body) => { body.ref_name = "refs/heads/../main"; }],
    ["string boolean", 1, (body) => { body.owner_alert = "true"; }],
    ["bad hash", 2, (body) => { body.remote_url_id = "0".repeat(63); }],
    ["extra field", 2, (body) => { body.extra = true; }],
    ["missing field", 2, (body) => { delete body.transport_policy_id; }],
    ["relative historical repo", 0, (body) => { body.repo = "relative/repo"; }],
  ];
  for (const [name, index, mutate] of fixtureMutations) {
    const envelopes = structuredClone(fixture.envelopes);
    mutate(envelopes[index].body.body);
    rehash(envelopes[index]);
    const home = emptyHome(`legacy-mutation-${String(name).replace(/[^a-z]+/gi, "-")}`);
    envelopes.forEach((envelope) => writeEnvelope(home, envelope));
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
  }

  const legacyOutcomeBody = { classification: "retryable", target_commit: fixture.envelopes[0].body.body.target_commit };
  const legacyOutcomeHome = emptyHome("legacy-two-field-outcomes-valid");
  const historicalOutcomes = Array.from({ length: 5 }, (_, index) => legacyEnvelope(legacyEvent(fixture.episode_id, index + 1, "push_outcome", structuredClone(legacyOutcomeBody))));
  [...fixture.envelopes, ...historicalOutcomes].forEach((envelope) => writeEnvelope(legacyOutcomeHome, envelope));
  assert((await l1.scanWholeL1Validated({ abrainHome: legacyOutcomeHome })).legacyReadOnly.length === 8, "historical exact two-field outcomes rejected");
  for (const [name, mutate] of [
    ["invalid classification", (body) => { body.classification = "unknown"; }],
    ["bad target oid", (body) => { body.target_commit = "bad"; }],
    ["extra simple outcome", (body) => { body.transport_attempted = false; }],
    ["missing simple outcome", (body) => { delete body.classification; }],
  ]) {
    const bad = legacyEnvelope(legacyEvent(fixture.episode_id, 1, "push_outcome", structuredClone(legacyOutcomeBody)));
    mutate(bad.body.body);
    rehash(bad);
    const home = emptyHome(`legacy-simple-outcome-${String(name).replace(/[^a-z]+/gi, "-")}`);
    [fixture.envelopes[0], bad].forEach((envelope) => writeEnvelope(home, envelope));
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
  }

  const scope = { repo_id: "1".repeat(64), remote: "origin", ref_name: "refs/heads/main", target_commit: "2".repeat(40), remote_url_id: "3".repeat(64), transport_policy_id: "4".repeat(64) };
  const episodeId = jcs.jcsSha256Hex({ domain: "pi-astack/adr0027-c6/push-episode/v2", scope_version: "remote-scope/v2", ...scope });
  const intent = legacyEnvelope(legacyEvent(episodeId, 1, "push_intent", { scope_version: "remote-scope/v2", ...scope }));
  const validOutcomeBody = {
    classification: "nonretryable", ...scope, stage: "push", transport_attempted: true, command_exit_code: 1,
    stdout_redacted_sha256: "5".repeat(64), stderr_redacted_sha256: "6".repeat(64), remote_ref_before: null,
    remote_ref_after: null, remote_contains_target: false, error_code: "PUSH_REJECTED",
  };
  const outcomeMutations = [
    ["string transport boolean", (body) => { body.transport_attempted = "true"; }],
    ["string proof boolean", (body) => { body.remote_contains_target = "false"; }],
    ["noninteger exit", (body) => { body.command_exit_code = 1.5; }],
    ["bad stdout hash", (body) => { body.stdout_redacted_sha256 = "bad"; }],
    ["scope mismatch", (body) => { body.repo_id = "7".repeat(64); }],
    ["extra outcome field", (body) => { body.proof = true; }],
    ["missing outcome field", (body) => { delete body.stage; }],
    ["contradictory success", (body) => { body.classification = "success"; body.error_code = null; }],
  ];
  const validOutcome = legacyEnvelope(legacyEvent(episodeId, 1, "push_outcome", structuredClone(validOutcomeBody)));
  const validHome = emptyHome("legacy-v2-outcome-valid");
  [intent, validOutcome].forEach((envelope) => writeEnvelope(validHome, envelope));
  assert((await l1.scanWholeL1Validated({ abrainHome: validHome })).legacyReadOnly.length === 2, "valid full transport outcome rejected");
  for (const [name, mutate] of outcomeMutations) {
    const bad = legacyEnvelope(legacyEvent(episodeId, 1, "push_outcome", structuredClone(validOutcomeBody)));
    mutate(bad.body.body);
    rehash(bad);
    const home = emptyHome(`legacy-outcome-${String(name).replace(/[^a-z]+/gi, "-")}`);
    [intent, bad].forEach((envelope) => writeEnvelope(home, envelope));
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
  }

  const attestationBody = { candidate_event_id: fixture.candidate_event_id, observed_tip: fixture.envelopes[0].body.body.target_commit, relation: "equal" };
  const attestation = legacyEnvelope(legacyEvent(fixture.episode_id, 5, "push_terminal_resolution_attestation", structuredClone(attestationBody)));
  const attestationHome = emptyHome("legacy-attestation-valid");
  [...fixture.envelopes, attestation].forEach((envelope) => writeEnvelope(attestationHome, envelope));
  assert((await l1.scanWholeL1Validated({ abrainHome: attestationHome })).legacyReadOnly.length === 4, "valid resolution attestation rejected");
  for (const [name, mutate] of [
    ["unknown candidate", (body) => { body.candidate_event_id = "9".repeat(64); }],
    ["bad observed hash", (body) => { body.observed_tip = "bad"; }],
    ["relation contradiction", (body) => { body.relation = "descendant"; }],
    ["extra attestation", (body) => { body.proof = true; }],
    ["missing attestation", (body) => { delete body.relation; }],
  ]) {
    const bad = legacyEnvelope(legacyEvent(fixture.episode_id, 5, "push_terminal_resolution_attestation", structuredClone(attestationBody)));
    mutate(bad.body.body);
    rehash(bad);
    const home = emptyHome(`legacy-attestation-${String(name).replace(/[^a-z]+/gi, "-")}`);
    [...fixture.envelopes, bad].forEach((envelope) => writeEnvelope(home, envelope));
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
  }
});

await check("active v3 prepared paths/snapshot fail closed in registry and recovery decoder", async () => {
  const base = await activePreparedFixture("prepared-path-contract");
  const basePayload = base.envelope.body.body;
  const entryPaths = basePayload.entries.map((entry) => entry.path);
  assert(JSON.stringify(Object.keys(basePayload.frozen_index_snapshot)) === JSON.stringify(entryPaths), "active snapshot is not total over entries");
  assert(Object.values(basePayload.frozen_index_snapshot).every((value) => value === null), "absent index entries must serialize as null");
  recovery.decodePreparedRecoveryEvent(base.event, base.repo, "refs/heads/main", cohort.LOCAL_DRAIN_PROTOCOL_V3);

  const mutations = [
    ["absolute entry", (payload) => { payload.entries[0].path = "/home/worker/.abrain/private-path.txt"; }],
    ["traversal entry", (payload) => { payload.entries[0].path = "l1/../../private-path.txt"; }],
    ["backslash entry", (payload) => { payload.entries[0].path = "l1\\private.txt"; }],
    ["trailing slash entry", (payload) => { payload.entries[0].path = "l1/private/"; }],
    ["dot-git entry", (payload) => { payload.entries[0].path = ".git/config"; }],
    ["absolute snapshot key", (payload) => { payload.frozen_index_snapshot["/home/worker/.abrain/private-path.txt"] = null; }],
    ["extra snapshot key", (payload) => { payload.frozen_index_snapshot["extra.txt"] = null; }],
    ["missing snapshot key", (payload) => { delete payload.frozen_index_snapshot[payload.entries[0].path]; }],
    ["unsorted entries", (payload) => { payload.entries.reverse(); }],
    ["duplicate entry", (payload) => { payload.entries.splice(1, 0, structuredClone(payload.entries[0])); }],
    ["invalid snapshot value", (payload) => { payload.frozen_index_snapshot[payload.entries[0].path] = "100644 not-an-oid 0"; }],
    ["41 digit candidate oid", (payload) => { payload.candidate = "a".repeat(41); }],
    ["63 digit blob oid", (payload) => { payload.entries[0].blobOid = "b".repeat(63); }],
    ["41 digit snapshot oid", (payload) => { payload.frozen_index_snapshot[payload.entries[0].path] = `100644 ${"c".repeat(41)} 0`; }],
  ];
  for (const [name, mutate] of mutations) {
    const bad = structuredClone(base.envelope);
    mutate(bad.body.body);
    rehash(bad);
    const home = emptyHome(`active-bad-${String(name).replace(/[^a-z]+/gi, "-")}`);
    writeEnvelope(home, bad);
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
    await expectCode("RECOVERY_PREPARED_INVALID", () => Promise.resolve(recovery.decodePreparedRecoveryEvent(bad.body, base.repo, "refs/heads/main", cohort.LOCAL_DRAIN_PROTOCOL_V3)));
  }
});

await check("v3 frozen snapshot root is independently bound and Git OIDs are exactly 40 or 64 hex", async () => {
  for (const length of [40, 64]) recovery.recoveryOperationV3({ symbolicRef: "refs/heads/main", baseCommit: "a".repeat(length), cohortSemanticRoot: "b".repeat(64), frozenIndexSnapshotRoot: "c".repeat(64) });
  for (const length of [41, 42, 63]) await expectCode("RECOVERY_BASE_INVALID", () => Promise.resolve(recovery.recoveryOperationV3({ symbolicRef: "refs/heads/main", baseCommit: "a".repeat(length), cohortSemanticRoot: "b".repeat(64), frozenIndexSnapshotRoot: "c".repeat(64) })));

  const base = await activePreparedFixture("snapshot-root-tamper");
  const bad = structuredClone(base.envelope);
  bad.body.operation.frozen_index_snapshot_root = "f".repeat(64);
  bad.body.episode_id = recovery.recoveryEpisodeIdentityV3(bad.body.operation);
  rehash(bad);
  const home = emptyHome("snapshot-root-tamper-home");
  writeEnvelope(home, bad);
  await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
  const claimEvent = structuredClone(base.claimEvent);
  claimEvent.operation = structuredClone(bad.body.operation);
  claimEvent.episode_id = bad.body.episode_id;
  claimEvent.body.claim_id = recovery.recoveryClaimIdV3(claimEvent.episode_id, claimEvent.slot);
  await expectCode("RECOVERY_OPERATION_INVARIANT", () => Promise.resolve(recovery.foldRecoveryEventsV3([claimEvent, bad.body])));
});

await check("historical v1 L2 uses its preserved reconciler and future live versions fail coverage smoke", async () => {
  const knowledgeBody = {
    created_at_utc: "2026-01-02T03:04:05.000Z", device_id: "device-fixture", device_event_seq: 1, causal_parents: [], session_id: "session", turn_id: "turn",
    intent: { operation_hint: "create" }, scope: { kind: "project", project_id: "project-fixture" },
    payload: { slug: "versioned", title: "Versioned", kind: "fact", status: "active", confidence: 8, provenance: "fixture", compiled_truth: "Versioned body.", trigger_phrases: ["v1"], derives_from: [], timeline_note: "fixture" },
  };
  const node = { eventId: "1".repeat(64), body: knowledgeBody };
  const liveKnowledge = knowledgeRenderer.renderKnowledgeProjectionFromSet([node]).markdown;
  const legacyKnowledge = l2Reconciler.__TEST.renderKnowledgeProjectionFromSetV1([node]).markdown;
  assert(liveKnowledge === legacyKnowledge, "current knowledge v1 renderer drifted from preserved reconciler");
  const liveManifest = knowledgeRenderer.renderKnowledgeProjectionManifestFromSet([node]).json;
  assert(liveManifest === l2Reconciler.__TEST.renderKnowledgeManifestFromSetV1([node]), "current knowledge v1 manifest drifted from preserved reconciler");

  const decision = { inputRootHash: "2".repeat(64), constraints: [], unresolved: [], exclusions: [] };
  const liveConstraint = constraintRenderer.renderConstraintL2View(decision, "3".repeat(64)).markdown;
  assert(liveConstraint === l2Reconciler.__TEST.renderConstraintL2V1(decision), "current constraint v1 renderer drifted from preserved reconciler");
  const selected = l2Reconciler.selectCanonicalL2ReconcilerVersions({ knowledgeMarkdown: [legacyKnowledge], knowledgeManifest: liveManifest, constraintMarkdown: liveConstraint, constraintSourceTemplateVersions: [l2Contract.CONSTRAINT_L2_V1.templateVersion] });
  assert(selected.knowledgeVersion === l2Contract.KNOWLEDGE_L2_V1.reconcilerVersion && selected.constraintVersion === l2Contract.CONSTRAINT_L2_V1.reconcilerVersion, "historical v1 output did not select v1 reconcilers");
  l2Reconciler.assertCanonicalL2ReconcilerCoverage();
  await expectCode("RECOVERY_L2_RECONCILER_UNSUPPORTED", () => Promise.resolve(l2Reconciler.selectCanonicalL2ReconcilerVersions({ knowledgeMarkdown: [legacyKnowledge.replace("sediment_template_version: knowledge-markdown/v1", "sediment_template_version: knowledge-markdown/v2")], knowledgeManifest: liveManifest, constraintMarkdown: liveConstraint, constraintSourceTemplateVersions: [l2Contract.CONSTRAINT_L2_V1.templateVersion] })));
  await expectCode("RECOVERY_L2_RECONCILER_COVERAGE", () => Promise.resolve(l2Reconciler.assertCanonicalL2ReconcilerCoverage({ knowledgeVersion: "knowledge-l2-reconciler/v2", constraintVersion: l2Contract.CONSTRAINT_L2_V1.reconcilerVersion })));
});

await check("v2 history identity stays stable while every v3 operation field changes episode identity", () => {
  const one = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  const two = recovery.recoveryEpisodeIdentity({ protocol_version: "local-drain-recovery/v2", lane: "drain", symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  assert(one === two && /^[0-9a-f]{64}$/.test(one), "v2 history identity mismatch");
  const base = { symbolicRef: "refs/heads/main", baseCommit: "1".repeat(40), cohortSemanticRoot: "2".repeat(64), frozenIndexSnapshotRoot: "3".repeat(64) };
  const id = recovery.recoveryEpisodeIdentityV3(recovery.recoveryOperationV3(base));
  for (const changed of [
    { ...base, symbolicRef: "refs/heads/other" },
    { ...base, baseCommit: "4".repeat(40) },
    { ...base, cohortSemanticRoot: "5".repeat(64) },
    { ...base, frozenIndexSnapshotRoot: "6".repeat(64) },
  ]) assert(recovery.recoveryEpisodeIdentityV3(recovery.recoveryOperationV3(changed)) !== id, "v3 operation field did not change episode identity");
  assert(recovery.recoveryClaimIdV3(id, 1) !== recovery.recoveryClaimIdV3(id, 2), "v3 slot not bound into claim");
});

await check("v3 retries stay in one exact operation and consume contiguous slots", async () => {
  const repo = initRepo("v3-retry");
  const prepared = await prepare(repo, "v3 retry", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const operation = operationFor(prepared);
  const claim1 = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  assert(claim1.slot === 1 && claim1.shouldExecute, "v3 slot 1 not claimed");
  assert(await recovery.recoverDrainSlotV3({ abrainHome: repo, repo, operation, slot: 1 }) === "burned", "v3 claimed-only slot not burned");
  const claim2 = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  assert(claim2.episodeId === claim1.episodeId && claim2.slot === 2 && claim2.shouldExecute, "v3 retry escaped exact operation or skipped slot");
});

await check("v3 stale abort never negates one shape-valid prepared event in either event order", async () => {
  for (const abortFirst of [true, false]) {
    const fixture = await abortPreparedPermutation(`abort-prepared-${abortFirst ? "first" : "last"}`, abortFirst);
    const events = await recovery.readRecoveryEventsV3(fixture.repo, fixture.episodeId);
    const claim = events.find((event) => event.event_type === "recovery_slot_claimed");
    const preparedEvent = events.find((event) => event.event_type === "commit_prepared");
    const abort = events.find((event) => event.event_type === "recovery_slot_aborted");
    for (const order of [[claim, abort, preparedEvent], [preparedEvent, claim, abort]]) {
      const state = recovery.foldRecoveryEventsV3(order).get(1);
      assert(state.prepared && state.staleAbort && !state.aborted, `stale abort won in permutation ${abortFirst}:${order.map((event) => event.event_type).join(",")}`);
    }
    assert(await recovery.recoverDrainSlotV3({ abrainHome: fixture.repo, repo: fixture.repo, operation: fixture.operation, slot: 1 }) === "index_converged", "stale abort prevented prepared recovery");
    const final = recovery.foldRecoveryEventsV3(await recovery.readRecoveryEventsV3(fixture.repo, fixture.episodeId)).get(1);
    assert(final.converged && final.staleAbort && !final.aborted, "convergence lost stale-abort diagnostic semantics");
  }
});

await check("conflicting prepared events quarantine with bounded event-id detail and v3 API enforces v2 prerequisite", async () => {
  const fixture = await abortPreparedPermutation("conflicting-prepared", false);
  const events = await recovery.readRecoveryEventsV3(fixture.repo, fixture.episodeId);
  const preparedEvent = events.find((event) => event.event_type === "commit_prepared");
  const conflictingBody = structuredClone(preparedEvent.body);
  conflictingBody.candidate = conflictingBody.candidate === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  const conflicting = await recovery.appendRecoveryEventV3({ abrainHome: fixture.repo, operation: fixture.operation, slot: 1, eventType: "commit_prepared", body: conflictingBody });
  const firstPreparedId = l1.canonicalL1BodyHash(preparedEvent);
  const recovered = recovery.recoverOpenRecoveryEpisodesV3FromScan(await l1.scanWholeL1Validated({ abrainHome: fixture.repo }));
  assert(recovered.quarantined.length === 1 && recovered.quarantined[0].errorCode === "RECOVERY_EVENT_INVARIANT", "conflicting prepared objects were not quarantined");
  const detail = recovered.quarantined[0].detail ?? "";
  assert(detail.length > 0 && detail.length <= 512 && detail.includes(firstPreparedId) && detail.includes(conflicting.eventId), `event-id detail missing or unbounded: ${detail}`);
  assert(!detail.includes(fixture.repo) && !(recovered.quarantined[0].message ?? "").includes(fixture.repo), "diagnostic leaked an absolute repo path");

  const direct = await history.classifyV3RecoveryHistory({ repo: fixture.repo });
  assert(direct.status === "quarantined" && direct.quarantined[0].errorCode === "RECOVERY_V2_PREREQUISITE", "v3 classifier accepted a call without v2-clean proof");
  const combined = await history.classifyRecoveryHistory({ repo: fixture.repo });
  assert(combined.status === "quarantined" && combined.quarantined[0].protocol === "v3" && combined.quarantined[0].detail === detail, "combined gate lost v3 detail/protocol");
});

await check("combined history gate accepts clean history and merge-only additions cannot evade retention", async () => {
  const clean = initRepo("combined-clean");
  const accepted = await history.classifyRecoveryHistory({ repo: clean });
  assert(accepted.status === "accepted" && accepted.v2.status === "accepted" && accepted.v3?.status === "accepted", "combined clean gate did not accept");
  const staleEpisode = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "stale-proof" });
  const staleClaim = { event_schema_version: "local-drain-recovery-event/v2", event_type: "recovery_slot_claimed", producer: { name: "pi-astack.convergence-recovery", version: "2.0.0" }, episode_id: staleEpisode, lane: "drain", slot: 1, body: { claim_id: recovery.recoveryClaimId(staleEpisode, "drain", 1) } };
  const staleHash = l1.canonicalL1BodyHash(staleClaim);
  writeEnvelope(clean, { schema: "local-drain-recovery-envelope/v2", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: staleHash, body_hash: staleHash, body: staleClaim });
  const staleProof = await history.classifyV3RecoveryHistory({ repo: clean, acceptedV2: accepted.v2, scan: await l1.scanWholeL1Validated({ abrainHome: clean }) });
  assert(staleProof.status === "quarantined" && staleProof.quarantined[0].errorCode === "RECOVERY_V2_PREREQUISITE", "v3 accepted a v2 proof from a stale scan");

  const repo = initRepo("merge-only-add");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "side", base);
  fs.writeFileSync(path.join(repo, "side.txt"), "side\n"); git(repo, "add", "side.txt"); commitFixture(repo, "side", "1700000040");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "main.txt"), "main\n"); git(repo, "add", "main.txt"); commitFixture(repo, "main", "1700000041");
  execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "--no-commit", "side"], { env: { ...process.env, LANG: "C", LC_ALL: "C" } });
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  const bodies = [
    { event_schema_version: "local-drain-recovery-event/v2", event_type: "recovery_slot_claimed", producer: { name: "pi-astack.convergence-recovery", version: "2.0.0" }, episode_id: episodeId, lane: "drain", slot: 1, body: { claim_id: recovery.recoveryClaimId(episodeId, "drain", 1) } },
    { event_schema_version: "local-drain-recovery-event/v2", event_type: "recovery_slot_aborted", producer: { name: "pi-astack.convergence-recovery", version: "2.0.0" }, episode_id: episodeId, lane: "drain", slot: 1, body: { reason: "recovery_slot_aborted", error_code: "RECOVERY_SLOT_ABORTED" } },
    { event_schema_version: "local-drain-recovery-event/v2", event_type: "recovery_episode_terminal", producer: { name: "pi-astack.convergence-recovery", version: "2.0.0" }, episode_id: episodeId, lane: "drain", slot: 1, body: { reason: "owner_intervention_required", owner_alert: true } },
  ];
  const files = bodies.map((body) => { const bodyHash = l1.canonicalL1BodyHash(body); return writeEnvelope(repo, { schema: "local-drain-recovery-envelope/v2", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body }); });
  git(repo, "add", "l1/events/sha256"); commitFixture(repo, "merge with recovery additions", "1700000042");
  const merge = git(repo, "rev-parse", "HEAD");
  const relative = path.relative(repo, files[0]).split(path.sep).join("/");
  assert(git(repo, "log", "--format=%H", "--full-history", "--diff-filter=A", "HEAD", "--", relative) === "", "fixture no longer demonstrates default merge add omission");
  assert(git(repo, "log", "-m", "--format=%H", "--full-history", "--diff-filter=A", "HEAD", "--", relative).split("\n").filter(Boolean).every((oid) => oid === merge), "-m did not expose merge-only addition");
  for (const file of files) fs.rmSync(file);
  git(repo, "add", "-u", "l1/events/sha256"); commitFixture(repo, "drop merge-only recovery", "1700000043");
  const dropped = await history.classifyRecoveryHistory({ repo });
  assert(dropped.status === "quarantined" && dropped.quarantined.some((item) => item.errorCode === "RECOVERY_REACHABLE_L1_DROPPED"), `merge-only drop evaded retention: ${JSON.stringify(dropped.quarantined)}`);
});

await check("v3 terminal is absorbing for its exact operation", async () => {
  const repo = initRepo("v3-terminal");
  const prepared = await prepare(repo, "v3 terminal", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const operation = operationFor(prepared);
  const episodeId = recovery.recoveryEpisodeIdentityV3(operation);
  for (let slot = 1; slot <= 5; slot++) {
    const claim = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
    assert(claim.slot === slot, `v3 slot ${slot} not claimed`);
    await recovery.recoverDrainSlotV3({ abrainHome: repo, repo, operation, slot });
  }
  const cursor = recovery.recoveryEpisodeCursorV3(episodeId, operation, await recovery.readRecoveryEventsV3(repo, episodeId));
  assert(cursor.terminal && cursor.nextSlot === null, "v3 terminal not absorbing");
  const next = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  assert(next.status === "terminal" && !next.shouldExecute, "v3 terminal reopened exact operation");
});

await check("same-format clones produce byte-equal commit and recovery events across realpaths", async () => {
  const seed = initRepo("clone-seed");
  const a = path.join(tmp, "clone-a");
  const b = path.join(tmp, "clone-b");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", seed, a]);
  execFileSync("git", ["clone", "-q", "--no-hardlinks", seed, b]);
  const pa = await prepare(a, "caller A", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const pb = await prepare(b, "caller B", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  assert(pa.prepared.candidate === pb.prepared.candidate, "caller message/realpath changed candidate OID");
  assert(pa.prepared.cohortManifestRoot === pb.prepared.cohortManifestRoot, "semantic manifest changed");
  const operationA = operationFor(pa);
  const operationB = operationFor(pb);
  const episodeId = recovery.recoveryEpisodeIdentityV3(operationA);
  assert(episodeId === recovery.recoveryEpisodeIdentityV3(operationB), "clone-neutral v3 operation identity changed");
  await recovery.claimNextRecoverySlotV3({ abrainHome: a, operation: operationA });
  await recovery.claimNextRecoverySlotV3({ abrainHome: b, operation: operationB });
  await recovery.recordDrainPreparedV3({ abrainHome: a, operation: operationA, slot: 1, prepared: pa.prepared, frozenIndexSnapshot: pa.snapshot });
  await recovery.recordDrainPreparedV3({ abrainHome: b, operation: operationB, slot: 1, prepared: pb.prepared, frozenIndexSnapshot: pb.snapshot });
  const eventsA = await recovery.readRecoveryEventsV3(a, episodeId);
  const eventsB = await recovery.readRecoveryEventsV3(b, episodeId);
  assert(JSON.stringify(eventsA) === JSON.stringify(eventsB), "shared recovery bytes contain realpath");
  assert(!JSON.stringify(eventsA).includes(a) && !JSON.stringify(eventsA).includes(b), "prepared event leaked absolute path");
});

await check("deterministic metadata/message and locale independence", async () => {
  const seed = initRepo("locale-seed");
  const a = path.join(tmp, "locale-a");
  const b = path.join(tmp, "locale-b");
  execFileSync("git", ["clone", "-q", seed, a]);
  execFileSync("git", ["clone", "-q", seed, b]);
  const old = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  process.env.LANG = "tr_TR.UTF-8"; process.env.LC_ALL = "tr_TR.UTF-8";
  const pa = await prepare(a, "locale A");
  process.env.LANG = "zh_CN.UTF-8"; process.env.LC_ALL = "zh_CN.UTF-8";
  const pb = await prepare(b, "locale B");
  for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  assert(pa.prepared.candidate === pb.prepared.candidate, "locale changed commit OID");
  const body = git(a, "cat-file", "commit", pa.prepared.candidate);
  assert(body.includes("author pi-astack-local-drain <local-drain@pi-astack.invalid> 1700000000 +0000"), "author/date not fixed");
  assert(body.includes(`protocol: local-drain-recovery/v2\nmanifest: ${pa.prepared.cohortManifestRoot}`), "message not manifest-derived");
  assert(!body.includes("locale A"), "caller message entered commit bytes");
});

await check("SHA-1 and SHA-256 are deterministic per format with equal OID-free semantics", async () => {
  const sha1a = initRepo("sha1-a", "sha1");
  const sha1b = path.join(tmp, "sha1-b"); execFileSync("git", ["clone", "-q", sha1a, sha1b]);
  const one = await prepare(sha1a); const two = await prepare(sha1b);
  assert(one.prepared.candidate === two.prepared.candidate, "SHA-1 per-format determinism failed");
  const sha256a = initRepo("sha256-a", "sha256");
  const sha256b = path.join(tmp, "sha256-b"); execFileSync("git", ["clone", "-q", sha256a, sha256b]);
  const three = await prepare(sha256a); const four = await prepare(sha256b);
  assert(three.prepared.candidate === four.prepared.candidate, "SHA-256 per-format determinism failed");
  assert(one.prepared.cohortManifestRoot === three.prepared.cohortManifestRoot, "cross-format semantic manifest differs");
  assert(one.prepared.candidate !== three.prepared.candidate, "cross-format OIDs unexpectedly equal");
});

await check("incomparable complete v3 candidates require and accept a certified semantic join", async () => {
  history._resetRecoveryHistoryBatchStatsForTests();
  const repo = initRepo("v3-semantic-join");
  const base = git(repo, "rev-parse", "HEAD");
  const candidates = [];
  for (const branch of ["device-a", "device-b"]) {
    git(repo, "checkout", "-q", "-b", branch, base);
    const relative = `${branch}.txt`;
    fs.writeFileSync(path.join(repo, relative), `${branch}\n`);
    const snapshot = await cohort.snapshotIndexEntries(repo, [relative]);
    const prepared = await cohort.prepareExactCohortCommit({ repo, refName: `refs/heads/${branch}`, frozenCommit: base, plan: [{ path: relative, op: "put", content: `${branch}\n` }], message: "ignored", protocolVersion: cohort.LOCAL_DRAIN_PROTOCOL_V3 });
    const operation = recovery.recoveryOperationV3({ symbolicRef: `refs/heads/${branch}`, baseCommit: base, cohortSemanticRoot: prepared.cohortManifestRoot, frozenIndexSnapshotRoot: recovery.frozenIndexSnapshotRootV3(prepared.entries, snapshot) });
    const claim = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
    await recovery.recordDrainPreparedV3({ abrainHome: repo, operation, slot: claim.slot, prepared, frozenIndexSnapshot: snapshot });
    assert(await recovery.recoverDrainSlotV3({ abrainHome: repo, repo, operation, slot: claim.slot }) === "index_converged", `${branch} did not converge`);
    git(repo, "add", "l1/events/sha256");
    execFileSync("git", ["-C", repo, "commit", "-qm", `${branch} metadata tail`], { env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000010 +0000", GIT_COMMITTER_DATE: "1700000010 +0000" } });
    candidates.push(prepared.candidate);
  }
  git(repo, "checkout", "-q", "device-a");
  execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "device-b", "-m", "certified v3 semantic join"], { env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000020 +0000", GIT_COMMITTER_DATE: "1700000020 +0000" } });
  const classified = await history.classifyRecoveryHistory({ repo });
  assert(classified.status === "accepted" && classified.v3?.candidates.length === 2 && classified.v3.joins.length === 1, `v3 semantic join was not certified: ${JSON.stringify(classified.quarantined)}`);
  assert(JSON.stringify(classified.v3.candidates.map((item) => item.candidate).sort()) === JSON.stringify(candidates.sort()), "v3 candidate set drifted");
  const stats = history._recoveryHistoryBatchStatsForTests();
  assert(stats.wholeValidationRuns === 1, `same merge/head validation ran ${stats.wholeValidationRuns} times`);
  assert(stats.wholeValidationCacheHits >= 1, "findCertifiedJoin/head validation did not share the commit Promise cache");
});

await check("v3 stale-device CAS conflict fails closed without publication metadata", async () => {
  const repo = initRepo("v3-stale-device");
  const prepared = await prepare(repo, "v3 stale", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const operation = operationFor(prepared);
  const episodeId = recovery.recoveryEpisodeIdentityV3(operation);
  const claim = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  assert(claim.slot === 1 && claim.shouldExecute, "stale-device v3 claim missing");
  await recovery.recordDrainPreparedV3({ abrainHome: repo, operation, slot: 1, prepared: prepared.prepared, frozenIndexSnapshot: prepared.snapshot });
  fs.writeFileSync(path.join(repo, "concurrent.txt"), "concurrent\n");
  git(repo, "add", "concurrent.txt");
  execFileSync("git", ["-C", repo, "commit", "-qm", "concurrent publication"], {
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000001 +0000", GIT_COMMITTER_DATE: "1700000001 +0000" },
  });
  const concurrentHead = git(repo, "rev-parse", "HEAD");
  await expectCode("RECOVERY_V3_STALE_BASE", () => recovery.recoverDrainSlotV3({ abrainHome: repo, repo, operation, slot: 1 }));
  const folded = recovery.foldRecoveryEventsV3(await recovery.readRecoveryEventsV3(repo, episodeId)).get(1);
  assert(git(repo, "rev-parse", "HEAD") === concurrentHead, "stale-device recovery moved current ref");
  assert(folded.prepared && !folded.published && !folded.converged, "stale-device recovery wrote false publication metadata");
});

await check("v3 prepared/published/index recovery converges without touching worktree", async () => {
  const repo = initRepo("recover-local");
  const prepared = await prepare(repo, "v3 recovery", cohort.LOCAL_DRAIN_PROTOCOL_V3);
  const operation = operationFor(prepared);
  const episodeId = recovery.recoveryEpisodeIdentityV3(operation);
  const claim = await recovery.claimNextRecoverySlotV3({ abrainHome: repo, operation });
  assert(claim.slot === 1 && claim.shouldExecute, "v3 recovery claim missing");
  await recovery.recordDrainPreparedV3({ abrainHome: repo, operation, slot: 1, prepared: prepared.prepared, frozenIndexSnapshot: prepared.snapshot });
  const worktreeBefore = fs.readFileSync(path.join(repo, "base.txt"), "utf8");
  const action = await recovery.recoverDrainSlotV3({ abrainHome: repo, repo, operation, slot: 1 });
  assert(action === "index_converged" && git(repo, "rev-parse", "HEAD") === prepared.prepared.candidate, "v3 local recovery did not converge");
  assert(fs.readFileSync(path.join(repo, "base.txt"), "utf8") === worktreeBefore && !fs.existsSync(path.join(repo, "a.txt")), "worktree changed");
  const cursor = recovery.recoveryEpisodeCursorV3(episodeId, operation, await recovery.readRecoveryEventsV3(repo, episodeId));
  assert(cursor.complete && cursor.nextSlot === null, "v3 complete operation retained a writable frontier");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
