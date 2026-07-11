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
async function activePreparedFixture(name) {
  const repo = initRepo(`${name}-repo`);
  const prepared = await prepare(repo);
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  await recovery.recordDrainPrepared({ abrainHome: repo, episodeId, slot: 1, prepared: prepared.prepared, frozenIndexSnapshot: prepared.snapshot });
  const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
  const record = scan.all.find((item) => item.body.event_type === "commit_prepared");
  assert(record, "active prepared fixture missing");
  return { repo, event: structuredClone(record.body), envelope: structuredClone(record.envelope) };
}
async function prepare(repo, message = "ignored caller message") {
  const frozen = git(repo, "rev-parse", "HEAD");
  const plan = [
    { path: "Z.txt", op: "put", content: "z\n" },
    { path: "a.txt", op: "put", content: "a\n" },
    { path: "\u4e2d.txt", op: "put", content: "unicode\n" },
  ];
  const snapshot = await cohort.snapshotIndexEntries(repo, plan.map((item) => item.path));
  const prepared = await cohort.prepareExactCohortCommit({ repo, refName: "refs/heads/main", frozenCommit: frozen, plan, message });
  return { frozen, plan, snapshot, prepared };
}

console.log("smoke: local drain recovery v2");

await check("registry declares v1 legacy_read_only and v2 active/write-only", () => {
  const registry = l1.loadL1SchemaRegistry();
  const old = registry.entries.find((entry) => entry.envelope_schema === "drain-recovery-envelope/v1");
  const active = registry.entries.find((entry) => entry.envelope_schema === "local-drain-recovery-envelope/v2");
  assert(old?.phase === "legacy_read_only" && !old.write_enabled && !old.fold_eligible, "v1 disposition mismatch");
  assert(active?.phase === "active" && active.write_enabled && !active.fold_eligible, "v2 disposition mismatch");
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

await check("active v2 prepared paths/snapshot fail closed in registry and recovery decoder", async () => {
  const base = await activePreparedFixture("prepared-path-contract");
  const basePayload = base.envelope.body.body;
  const entryPaths = basePayload.entries.map((entry) => entry.path);
  assert(JSON.stringify(Object.keys(basePayload.frozen_index_snapshot)) === JSON.stringify(entryPaths), "active snapshot is not total over entries");
  assert(Object.values(basePayload.frozen_index_snapshot).every((value) => value === null), "absent index entries must serialize as null");
  recovery.decodePreparedRecoveryEvent(base.event, base.repo, "refs/heads/main");

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
  ];
  for (const [name, mutate] of mutations) {
    const bad = structuredClone(base.envelope);
    mutate(bad.body.body);
    rehash(bad);
    const home = emptyHome(`active-bad-${String(name).replace(/[^a-z]+/gi, "-")}`);
    writeEnvelope(home, bad);
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
    await expectCode("RECOVERY_PREPARED_INVALID", () => Promise.resolve(recovery.decodePreparedRecoveryEvent(bad.body, base.repo, "refs/heads/main")));
  }
});

await check("episode and claim identities exclude realpath/cohort and bind symbolic generation slot", () => {
  const one = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  const two = recovery.recoveryEpisodeIdentity({ protocol_version: "local-drain-recovery/v2", lane: "drain", symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  assert(one === two && /^[0-9a-f]{64}$/.test(one), "episode identity mismatch");
  assert(recovery.recoveryClaimId(one, "drain", 1) !== recovery.recoveryClaimId(one, "drain", 2), "slot not bound into claim");
});

await check("refreeze stays in one episode and consumes the next contiguous slot", async () => {
  const home = emptyHome("refreeze");
  const episode = await recovery.resolveRecoveryEpisode({ abrainHome: home, symbolicRef: "refs/heads/main", allowNextGeneration: true });
  const claim1 = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId: episode.episodeId, lane: "drain" });
  assert(claim1.slot === 1 && claim1.shouldExecute, "slot 1 not claimed");
  assert(await recovery.burnPendingRecoverySlot({ abrainHome: home, episodeId: episode.episodeId, lane: "drain" }) === 1, "slot 1 not burned");
  const same = await recovery.resolveRecoveryEpisode({ abrainHome: home, symbolicRef: "refs/heads/main", allowNextGeneration: true });
  const claim2 = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId: same.episodeId, lane: "drain" });
  assert(same.episodeId === episode.episodeId && claim2.slot === 2, "refreeze reset episode/slot");
});

await check("terminal is absorbing and does not auto-open a generation", async () => {
  const home = emptyHome("terminal");
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  for (let slot = 1; slot <= 5; slot++) {
    const claim = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId, lane: "drain" });
    assert(claim.slot === slot, `slot ${slot} not claimed`);
    await recovery.burnPendingRecoverySlot({ abrainHome: home, episodeId, lane: "drain" });
  }
  const cursor = recovery.recoveryEpisodeCursor(episodeId, "drain", await recovery.readRecoveryEvents(home, episodeId));
  assert(cursor.terminal && cursor.nextSlot === null, "terminal not absorbing");
  const resolved = await recovery.resolveRecoveryEpisode({ abrainHome: home, symbolicRef: "refs/heads/main", allowNextGeneration: true });
  assert(resolved.status === "terminal" && resolved.episodeId === episodeId, "terminal auto-opened another generation");
});

await check("same-format clones produce byte-equal commit and recovery events across realpaths", async () => {
  const seed = initRepo("clone-seed");
  const a = path.join(tmp, "clone-a");
  const b = path.join(tmp, "clone-b");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", seed, a]);
  execFileSync("git", ["clone", "-q", "--no-hardlinks", seed, b]);
  const pa = await prepare(a, "caller A");
  const pb = await prepare(b, "caller B");
  assert(pa.prepared.candidate === pb.prepared.candidate, "caller message/realpath changed candidate OID");
  assert(pa.prepared.cohortManifestRoot === pb.prepared.cohortManifestRoot, "semantic manifest changed");
  const homeA = emptyHome("events-a");
  const homeB = emptyHome("events-b");
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  await recovery.claimRecoverySlot({ abrainHome: homeA, episodeId, lane: "drain", slot: 1 });
  await recovery.claimRecoverySlot({ abrainHome: homeB, episodeId, lane: "drain", slot: 1 });
  await recovery.recordDrainPrepared({ abrainHome: homeA, episodeId, slot: 1, prepared: pa.prepared, frozenIndexSnapshot: pa.snapshot });
  await recovery.recordDrainPrepared({ abrainHome: homeB, episodeId, slot: 1, prepared: pb.prepared, frozenIndexSnapshot: pb.snapshot });
  const eventsA = await recovery.readRecoveryEvents(homeA, episodeId);
  const eventsB = await recovery.readRecoveryEvents(homeB, episodeId);
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

await check("prepared/published/index recovery converges without touching worktree", async () => {
  const repo = initRepo("recover-local");
  const prepared = await prepare(repo);
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  await recovery.claimRecoverySlot({ abrainHome: repo, episodeId, lane: "drain", slot: 1 });
  await recovery.recordDrainPrepared({ abrainHome: repo, episodeId, slot: 1, prepared: prepared.prepared, frozenIndexSnapshot: prepared.snapshot });
  const worktreeBefore = fs.readFileSync(path.join(repo, "base.txt"), "utf8");
  const action = await recovery.recoverDrainSlot({ abrainHome: repo, repo, symbolicRef: "refs/heads/main", episodeId, slot: 1 });
  assert(action === "index_converged" && git(repo, "rev-parse", "HEAD") === prepared.prepared.candidate, "local recovery did not converge");
  assert(fs.readFileSync(path.join(repo, "base.txt"), "utf8") === worktreeBefore && !fs.existsSync(path.join(repo, "a.txt")), "worktree changed");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
