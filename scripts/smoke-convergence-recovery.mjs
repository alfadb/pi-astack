#!/usr/bin/env node
/** Canonical-path R3.4.2 P1-S1/S2 convergence recovery smoke. Temporary repos only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const cohort = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-recovery-"));
let passed = 0;
const failures = [];

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}
function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err?.stack || err}`); }
}
async function expectCode(code, fn) {
  try { await fn(); } catch (err) { assert(err.code === code, `expected ${code}, got ${err.code}: ${err.message}`); return err; }
  throw new Error(`expected ${code}`);
}
async function expectReject(fn) {
  try { await fn(); } catch (err) { return err; }
  throw new Error("expected rejection");
}
function makeHome(name) {
  const home = path.join(tmp, `home-${name}`);
  fs.mkdirSync(path.join(home, "l1", "events", "sha256"), { recursive: true });
  return home;
}
function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Smoke");
  git(repo, "config", "user.email", "smoke@example.test");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "base");
  return repo;
}
async function fixture(name, plan = [{ path: "owned.txt", op: "put", content: "owned\n" }], generationAnchor = "genesis") {
  const repo = initRepo(name);
  const frozen = git(repo, "rev-parse", "HEAD");
  const snapshot = await cohort.snapshotIndexEntries(repo, plan.map((entry) => entry.path));
  const prepared = await cohort.prepareExactCohortCommit({ repo, refName: "HEAD", frozenCommit: frozen, plan, message: `prepare ${name}` });
  const episodeId = recovery.drainEpisodeIdentity({ repo_id: name, ref_name: "HEAD", generation_anchor: generationAnchor });
  return { repo, frozen, snapshot, prepared, episodeId, paths: plan.map((entry) => entry.path) };
}
function event(episode_id, lane, slot, event_type, body) {
  return { event_schema_version: "drain-recovery-event/v1", event_type, producer: { name: "pi-astack.convergence-recovery", version: "1.0.0" }, episode_id, lane, slot, body };
}
function claimedEvent(episode, lane, slot) {
  return event(episode, lane, slot, "recovery_slot_claimed", { claim_id: recovery.recoveryClaimId(episode, lane, slot) });
}
const abortBody = () => ({ reason: "recovery_slot_aborted", error_code: "RECOVERY_SLOT_ABORTED" });
const terminalBody = () => ({ reason: "owner_intervention_required", owner_alert: true });
const publishedBody = (candidate) => ({ candidate, publication_confirmed: true });
async function claimNext(home, episodeId, lane) {
  const result = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId, lane });
  assert(result.shouldExecute, `next ${lane} slot not acquired: ${JSON.stringify(result)}`);
  return result.slot;
}
async function pushOutcome(home, episodeId, slot, classification, target = "target") {
  await recovery.appendRecoveryEvent({ abrainHome: home, episodeId, lane: "push", slot, eventType: "push_outcome", body: { classification, target_commit: target } });
}
async function preparedSlot(home, fixtureValue, slot = 1) {
  await recovery.claimRecoverySlot({ abrainHome: home, episodeId: fixtureValue.episodeId, lane: "drain", slot });
  await recovery.recordDrainPrepared({ abrainHome: home, episodeId: fixtureValue.episodeId, slot, prepared: fixtureValue.prepared, frozenIndexSnapshot: fixtureValue.snapshot });
}

console.log("smoke: canonical-path convergence recovery R3.4.2 P1-S1/S2");

await check("resolveRecoveryEpisode reuses open generation across refreeze, cohort and unrelated L1 events", async () => {
  const home = makeHome("episode-resolution");
  const repo = initRepo("episode-resolution");
  const first = await recovery.resolveRecoveryEpisode({ abrainHome: home, repoId: "scope-a", refName: "refs/heads/main" });
  assert(first.status === "new" && first.generationAnchor === "genesis", "genesis resolution failed");
  assert(await claimNext(home, first.episodeId, "drain") === 1, "slot 1 not claimed");

  fs.writeFileSync(path.join(repo, "refreeze.txt"), "new head\n");
  git(repo, "add", "refreeze.txt");
  git(repo, "commit", "-qm", "refreeze");
  await cohort.prepareExactCohortCommit({
    repo,
    refName: "HEAD",
    frozenCommit: git(repo, "rev-parse", "HEAD"),
    plan: [{ path: "new-cohort.txt", op: "put", content: "new cohort\n" }],
    message: "new cohort",
  });
  const unrelated = recovery.drainEpisodeIdentity({ repo_id: "other", ref_name: "HEAD", generation_anchor: "unrelated-l1" });
  await recovery.claimRecoverySlot({ abrainHome: home, episodeId: unrelated, lane: "drain", slot: 1 });

  const resolved = await recovery.resolveRecoveryEpisode({ abrainHome: home, repoId: "scope-a", refName: "refs/heads/main" });
  assert(resolved.status === "open" && resolved.episodeId === first.episodeId, "open episode identity changed");
  const pending = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId: first.episodeId, lane: "drain" });
  assert(pending.status === "pending" && pending.slot === 1, "pending claim was skipped");
  assert(await recovery.burnPendingRecoverySlot({ abrainHome: home, episodeId: first.episodeId, lane: "drain" }) === 1, "pending slot not burned");
  assert(await claimNext(home, first.episodeId, "drain") === 2, "episode budget did not continue at slot 2");
  for (let slot = 2; slot <= 5; slot++) {
    assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId: first.episodeId, slot }) === (slot === 5 ? "terminal" : "burned"), `slot ${slot} did not close generation`);
    if (slot < 5) assert(await claimNext(home, first.episodeId, "drain") === slot + 1, `slot ${slot + 1} not claimed`);
  }
  const terminalEvent = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, first.episodeId, "drain")).get(5).terminal;
  const closureId = l1.canonicalL1BodyHash(terminalEvent);
  const nextGeneration = await recovery.resolveRecoveryEpisode({ abrainHome: home, repoId: "scope-a", refName: "refs/heads/main" });
  assert(nextGeneration.status === "new" && nextGeneration.generationAnchor === closureId, "next generation was not anchored to terminal event_id");
  assert(nextGeneration.episodeId === recovery.deriveNextEpisodeIdentity({ repoId: "scope-a", refName: "refs/heads/main", generationAnchor: closureId }), "next episode identity mismatch");
});

await check("claims are no-replace, pending blocks next slot, lane and gap validation fail closed", async () => {
  const home = makeHome("claims");
  const episodeId = "claim-competition";
  const results = await Promise.all(Array.from({ length: 8 }, () => recovery.claimRecoverySlot({ abrainHome: home, episodeId, lane: "drain", slot: 1 })));
  assert(results.filter((result) => result.shouldExecute).length === 1, "expected one claim winner");
  const pending = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId, lane: "drain" });
  assert(pending.status === "pending" && pending.slot === 1, "pending slot did not block claim");
  await expectCode("RECOVERY_LANE_INVALID", () => recovery.recoveryClaimId("bad-lane", "invalid", 1));
  await expectCode("RECOVERY_SLOT_GAP", () => recovery.foldRecoveryEvents([claimedEvent("gap", "drain", 2)]));
});

await check("fold is order-independent and absorbs raced claims and lower-slot late results after terminal", async () => {
  const ep = "fold-order";
  const claim1 = claimedEvent(ep, "drain", 1);
  const prepared = event(ep, "drain", 1, "commit_prepared", { candidate: "a" });
  const published = event(ep, "drain", 1, "commit_published", publishedBody("a"));
  const converged = event(ep, "drain", 1, "index_converged", { candidate: "a" });
  const claim2 = claimedEvent(ep, "drain", 2);
  const terminal = event(ep, "drain", 2, "recovery_episode_terminal", terminalBody());
  const folded = recovery.foldRecoveryEvents([terminal, claim2, converged, published, claim1, prepared]);
  assert(folded.get(1).converged && folded.get(2).terminal, "late facts did not fold");
  await expectCode("RECOVERY_RESULT_WITHOUT_CLAIM", () => recovery.foldRecoveryEvents([published, prepared]));
  await expectCode("RECOVERY_STATE_ORDER", () => recovery.foldRecoveryEvents([claim1, published]));
  await expectCode("RECOVERY_LANE_INVARIANT", () => recovery.foldRecoveryEvents([claimedEvent("lane", "push", 1), event("lane", "push", 1, "commit_prepared", {})]));
  await expectCode("RECOVERY_EVENT_INVARIANT", () => recovery.foldRecoveryEvents([claim1, prepared, published, { ...published, body: publishedBody("b") }]));
  await expectCode("RECOVERY_STATE_INVARIANT", () => recovery.foldRecoveryEvents([claim1, prepared, { ...published, body: { candidate: "a", publication_confirmed: true, outcome: "published" } }]));
});

await check("stale abort refold preserves late drain convergence and push success", async () => {
  const drainHome = makeHome("stale-abort-drain");
  const f = await fixture("stale-abort-drain");
  await preparedSlot(drainHome, f);
  const staleDrain = recovery.recoveryEpisodeCursor(f.episodeId, "drain", await recovery.readRecoveryEvents(drainHome, f.episodeId, "drain"));
  assert(staleDrain.pendingSlot === 1 && !staleDrain.complete, "drain cursor was not stale-pending");
  await recovery.appendRecoveryEvent({ abrainHome: drainHome, episodeId: f.episodeId, lane: "drain", slot: 1, eventType: "commit_published", body: publishedBody(f.prepared.candidate) });
  await recovery.appendRecoveryEvent({ abrainHome: drainHome, episodeId: f.episodeId, lane: "drain", slot: 1, eventType: "index_converged", body: { candidate: f.prepared.candidate } });
  assert(await recovery.abortRecoverySlotAfterRefold({ abrainHome: drainHome, episodeId: f.episodeId, lane: "drain", slot: staleDrain.pendingSlot }) === "already_complete", "late drain convergence was not preserved");
  const drainEvents = await recovery.readRecoveryEvents(drainHome, f.episodeId, "drain");
  assert(!drainEvents.some((item) => item.event_type === "recovery_slot_aborted"), "stale drain abort was published");
  assert(recovery.recoveryEpisodeCursor(f.episodeId, "drain", drainEvents).complete, "drain episode did not remain complete");
  const converged = recovery.foldRecoveryEvents(drainEvents).get(1).converged;
  const nextGeneration = await recovery.resolveRecoveryEpisode({ abrainHome: drainHome, repoId: "stale-abort-drain", refName: "HEAD" });
  assert(nextGeneration.status === "new" && nextGeneration.generationAnchor === l1.canonicalL1BodyHash(converged), "late convergence did not remain the generation anchor");

  const pushHome = makeHome("stale-abort-push");
  const pushEpisode = "stale-abort-push";
  await recovery.claimRecoverySlot({ abrainHome: pushHome, episodeId: pushEpisode, lane: "push", slot: 1 });
  const stalePush = recovery.recoveryEpisodeCursor(pushEpisode, "push", await recovery.readRecoveryEvents(pushHome, pushEpisode, "push"));
  assert(stalePush.pendingSlot === 1 && !stalePush.complete, "push cursor was not stale-pending");
  await pushOutcome(pushHome, pushEpisode, 1, "success");
  assert(await recovery.abortRecoverySlotAfterRefold({ abrainHome: pushHome, episodeId: pushEpisode, lane: "push", slot: stalePush.pendingSlot }) === "success", "late push success was not preserved");
  const pushEvents = await recovery.readRecoveryEvents(pushHome, pushEpisode, "push");
  assert(!pushEvents.some((item) => item.event_type === "recovery_slot_aborted"), "stale push abort was published");
  assert(recovery.recoveryEpisodeCursor(pushEpisode, "push", pushEvents).complete, "push episode did not remain complete");
});

await check("one quarantined episode does not block another open episode and curator is excluded", async () => {
  const home = makeHome("quarantine");
  const good = "good-open";
  await recovery.claimRecoverySlot({ abrainHome: home, episodeId: good, lane: "drain", slot: 1 });
  await recovery.burnPendingRecoverySlot({ abrainHome: home, episodeId: good, lane: "drain" });
  const bad = "bad-conflict";
  await recovery.claimRecoverySlot({ abrainHome: home, episodeId: bad, lane: "drain", slot: 1 });
  await recovery.appendRecoveryEvent({ abrainHome: home, episodeId: bad, lane: "drain", slot: 1, eventType: "commit_prepared", body: { candidate: "a" } });
  await recovery.appendRecoveryEvent({ abrainHome: home, episodeId: bad, lane: "drain", slot: 1, eventType: "commit_prepared", body: { candidate: "b" } });
  const curator = recovery.curatorEpisodeIdentity({ scope: "external-e2" });
  await recovery.claimRecoverySlot({ abrainHome: home, episodeId: curator, lane: "curator", slot: 1 });
  const result = await recovery.recoverOpenRecoveryEpisodes(home);
  assert(result.open.some((cursor) => cursor.episodeId === good && cursor.nextSlot === 2), "good episode not recovered");
  assert(result.quarantined.some((item) => item.episodeId === bad && item.ownerAlert && item.errorCode === "RECOVERY_EVENT_INVARIANT"), "bad episode not quarantined");
  assert(!result.open.some((cursor) => cursor.episodeId === curator), "curator entered P1-S2 open recovery");
});

await check("exact cohort supports delete and executable mode and rejects invalid paths/modes", async () => {
  const home = makeHome("plan-shape");
  const f = await fixture("plan-shape", [
    { path: "base.txt", op: "delete" },
    { path: "run.sh", op: "put", mode: "100755", content: "#!/bin/sh\nexit 0\n" },
  ]);
  await preparedSlot(home, f);
  assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }) === "index_converged", "delete/executable cohort did not converge");
  assert(fs.existsSync(path.join(f.repo, "base.txt")), "delete operation modified the worktree");
  const tree = git(f.repo, "ls-tree", "HEAD", "run.sh");
  assert(tree.startsWith("100755 blob "), `executable mode lost: ${tree}`);
  for (const badPath of ["../escape", "/absolute", "a\\b", ".git/config", "bad\0path"]) {
    await expectCode("COHORT_PATH_INVALID", () => cohort.prepareExactCohortCommit({ repo: f.repo, refName: "HEAD", frozenCommit: git(f.repo, "rev-parse", "HEAD"), plan: [{ path: badPath, op: "put", content: "x" }], message: "bad" }));
  }
  await expectCode("COHORT_PLAN_INVALID", () => cohort.prepareExactCohortCommit({ repo: f.repo, refName: "HEAD", frozenCommit: git(f.repo, "rev-parse", "HEAD"), plan: [{ path: "bad-mode", op: "put", mode: "100600", content: "x" }], message: "bad" }));
});

await check("snapshot rejects non-stage-0 and duplicate-stage owned paths", async () => {
  const repo = initRepo("index-stages");
  fs.writeFileSync(path.join(repo, "one"), "one\n");
  fs.writeFileSync(path.join(repo, "two"), "two\n");
  const one = git(repo, "hash-object", "-w", "one");
  const two = git(repo, "hash-object", "-w", "two");
  execFileSync("git", ["-C", repo, "update-index", "--index-info"], {
    input: `100644 ${one} 1\towned.txt\n100644 ${two} 2\towned.txt\n`,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  await expectCode("OWNED_INDEX_CONFLICT", () => cohort.snapshotIndexEntries(repo, ["owned.txt"]));
});

await check("publication preserves non-cohort index/worktree and second recovery is already_complete", async () => {
  const home = makeHome("preserve");
  const f = await fixture("preserve");
  fs.writeFileSync(path.join(f.repo, "staged.txt"), "staged\n");
  git(f.repo, "add", "staged.txt");
  fs.writeFileSync(path.join(f.repo, "base.txt"), "dirty-worktree\n");
  const fingerprint = await cohort.fullIndexFingerprint(f.repo, new Set(f.paths));
  const worktree = fs.readFileSync(path.join(f.repo, "base.txt"), "utf8");
  await preparedSlot(home, f);
  assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }) === "index_converged", "did not converge");
  assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }) === "already_complete", "completed slot was not idempotent");
  assert(await cohort.fullIndexFingerprint(f.repo, new Set(f.paths)) === fingerprint, "non-cohort stage changed");
  assert(fs.readFileSync(path.join(f.repo, "base.txt"), "utf8") === worktree, "worktree changed");
});

await check("CAS already applied without commit_published is absorbed with deterministic fact", async () => {
  const home = makeHome("cas-applied");
  const f = await fixture("cas-applied");
  await preparedSlot(home, f);
  await cohort.publishExactCohortCommit({ repo: f.repo, refName: "HEAD", candidate: f.prepared.candidate, frozenCommit: f.frozen });
  assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }) === "index_converged", "applied CAS was not absorbed");
  const state = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, f.episodeId, "drain")).get(1);
  assert(JSON.stringify(state.published.body) === JSON.stringify(publishedBody(f.prepared.candidate)), "publication fact contains path-dependent diagnostics");
});

await check("candidate descendant and independent exact cohort are both absorbed", async () => {
  const descendantHome = makeHome("descendant");
  const descendant = await fixture("descendant");
  await preparedSlot(descendantHome, descendant);
  await cohort.publishExactCohortCommit({ repo: descendant.repo, refName: "HEAD", candidate: descendant.prepared.candidate, frozenCommit: descendant.frozen });
  await cohort.convergeExactCohortIndex({ repo: descendant.repo, refName: "HEAD", cohortPaths: descendant.paths, frozenIndexSnapshot: descendant.snapshot });
  fs.writeFileSync(path.join(descendant.repo, "child.txt"), "child\n");
  git(descendant.repo, "add", "child.txt");
  git(descendant.repo, "commit", "-qm", "descendant");
  assert(await recovery.recoverDrainSlot({ abrainHome: descendantHome, episodeId: descendant.episodeId, slot: 1 }) === "index_converged", "candidate descendant not absorbed");

  const exactHome = makeHome("independent");
  const exact = await fixture("independent");
  await preparedSlot(exactHome, exact);
  fs.writeFileSync(path.join(exact.repo, "owned.txt"), "owned\n");
  git(exact.repo, "add", "owned.txt");
  git(exact.repo, "commit", "-qm", "independent exact cohort");
  assert(!await cohort.isAncestor(exact.repo, exact.prepared.candidate, git(exact.repo, "rev-parse", "HEAD")), "fixture unexpectedly contains candidate");
  const exactContained = await cohort.refContainsCohort(exact.repo, "HEAD", exact.prepared.entries);
  assert(exactContained, `exact cohort helper rejected matching tree: tree=${git(exact.repo, "ls-tree", "HEAD", "owned.txt")} expected=${JSON.stringify(exact.prepared.entries[0])}`);
  const exactState = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(exactHome, exact.episodeId, "drain")).get(1);
  const durable = exactState.prepared.body;
  const durableShape = await cohort.verifyCandidateShape(durable.repo, durable.candidate, { frozenCommit: durable.frozen_commit, newTree: durable.new_tree });
  const durableContains = await cohort.refContainsCohort(durable.repo, durable.ref_name, durable.entries);
  const exactAction = await recovery.recoverDrainSlot({ abrainHome: exactHome, episodeId: exact.episodeId, slot: 1 });
  assert(exactAction === "index_converged", `independent exact cohort not absorbed: ${exactAction}; shape=${durableShape}; contains=${durableContains}`);
});

await check("explicit CAS conflict burns slot, but ref lock error rethrows without burn", async () => {
  const conflictHome = makeHome("cas-conflict");
  const conflict = await fixture("cas-conflict");
  await preparedSlot(conflictHome, conflict);
  fs.writeFileSync(path.join(conflict.repo, "other.txt"), "other\n");
  git(conflict.repo, "add", "other.txt");
  git(conflict.repo, "commit", "-qm", "concurrent");
  assert(await recovery.recoverDrainSlot({ abrainHome: conflictHome, episodeId: conflict.episodeId, slot: 1 }) === "refreeze_required", "CAS mismatch did not burn slot");

  const lockHome = makeHome("ref-lock");
  const locked = await fixture("ref-lock");
  await preparedSlot(lockHome, locked);
  const symbolic = git(locked.repo, "symbolic-ref", "HEAD");
  const lockPath = path.join(locked.repo, ".git", `${symbolic}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "held\n");
  await expectReject(() => recovery.recoverDrainSlot({ abrainHome: lockHome, episodeId: locked.episodeId, slot: 1 }));
  fs.rmSync(lockPath, { force: true });
  const beforeRetry = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(lockHome, locked.episodeId, "drain")).get(1);
  assert(!beforeRetry.aborted, "ref lock failure burned recovery slot");
  assert(await recovery.recoverDrainSlot({ abrainHome: lockHome, episodeId: locked.episodeId, slot: 1 }) === "index_converged", "slot did not retry after lock removal");
});

await check("merge-base non-1 failures rethrow and do not burn a recovery slot", async () => {
  const home = makeHome("merge-base-error");
  const f = await fixture("merge-base-error");
  await preparedSlot(home, f);
  const missingOid = "f".repeat(f.frozen.length);

  const ancestorError = await expectReject(() => cohort.isAncestor(f.repo, missingOid, f.frozen));
  assert(ancestorError.code !== 1, `isAncestor converted non-1 failure: ${ancestorError.code}`);

  const publishError = await expectReject(() => cohort.publishExactCohortCommit({ repo: f.repo, refName: "HEAD", candidate: missingOid, frozenCommit: f.frozen }));
  assert(publishError.code !== 1 && /merge-base|not a valid object|invalid object/i.test(`${publishError.message}\n${publishError.stderr ?? ""}`), `publish did not rethrow ancestry failure: ${publishError.message}`);
  const state = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, f.episodeId, "drain")).get(1);
  assert(!state.aborted, "merge-base infrastructure failure burned recovery slot");
});

await check("candidate shape and prepared structure validation fail explicitly", async () => {
  const shapeHome = makeHome("candidate-shape");
  const f = await fixture("candidate-shape");
  const invalid = { ...f.prepared, candidate: f.frozen };
  await recovery.claimRecoverySlot({ abrainHome: shapeHome, episodeId: f.episodeId, lane: "drain", slot: 1 });
  await recovery.recordDrainPrepared({ abrainHome: shapeHome, episodeId: f.episodeId, slot: 1, prepared: invalid, frozenIndexSnapshot: f.snapshot });
  assert(await recovery.recoverDrainSlot({ abrainHome: shapeHome, episodeId: f.episodeId, slot: 1 }) === "refreeze_required", "invalid candidate shape accepted");

  const malformedHome = makeHome("prepared-malformed");
  const episodeId = "prepared-malformed";
  await recovery.claimRecoverySlot({ abrainHome: malformedHome, episodeId, lane: "drain", slot: 1 });
  await recovery.appendRecoveryEvent({ abrainHome: malformedHome, episodeId, lane: "drain", slot: 1, eventType: "commit_prepared", body: { candidate: "only" } });
  await expectCode("RECOVERY_PREPARED_INVALID", () => recovery.recoverDrainSlot({ abrainHome: malformedHome, episodeId, slot: 1 }));
});

await check("owned index conflict is all-or-nothing after publication", async () => {
  const home = makeHome("owned-conflict");
  const f = await fixture("owned-conflict", [
    { path: "a-owned.txt", op: "put", content: "candidate-a\n" },
    { path: "z-owned.txt", op: "put", content: "candidate-z\n" },
  ]);
  await preparedSlot(home, f);
  await cohort.publishExactCohortCommit({ repo: f.repo, refName: "HEAD", candidate: f.prepared.candidate, frozenCommit: f.frozen });
  await recovery.appendRecoveryEvent({ abrainHome: home, episodeId: f.episodeId, lane: "drain", slot: 1, eventType: "commit_published", body: publishedBody(f.prepared.candidate) });
  fs.writeFileSync(path.join(f.repo, "z-owned.txt"), "user-stage\n");
  git(f.repo, "add", "z-owned.txt");
  const before = git(f.repo, "ls-files", "-s");
  await expectCode("OWNED_INDEX_CONFLICT", () => recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }));
  assert(git(f.repo, "ls-files", "-s") === before, "index was partially converged");
  const aborted = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, f.episodeId, "drain")).get(1).aborted;
  assert(aborted.body.error_code === "RECOVERY_SLOT_ABORTED", "abort did not record deterministic error code");
});

await check("published fact cannot authorize convergence against unrelated current ref", async () => {
  const home = makeHome("published-unrelated");
  const f = await fixture("published-unrelated");
  await preparedSlot(home, f);
  await cohort.publishExactCohortCommit({ repo: f.repo, refName: "HEAD", candidate: f.prepared.candidate, frozenCommit: f.frozen });
  await recovery.appendRecoveryEvent({ abrainHome: home, episodeId: f.episodeId, lane: "drain", slot: 1, eventType: "commit_published", body: publishedBody(f.prepared.candidate) });
  git(f.repo, "update-ref", "HEAD", f.frozen, f.prepared.candidate);
  fs.writeFileSync(path.join(f.repo, "unrelated.txt"), "unrelated\n");
  git(f.repo, "add", "unrelated.txt");
  git(f.repo, "commit", "-qm", "unrelated");
  const before = git(f.repo, "ls-files", "-s");
  assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }) === "refreeze_required", "unrelated ref was converged");
  assert(git(f.repo, "ls-files", "-s") === before, "unrelated rejection changed index");
});

await check("concurrent recoverDrainSlot calls converge to one non-conflicting durable result", async () => {
  const home = makeHome("concurrent-drain");
  const f = await fixture("concurrent-drain");
  await preparedSlot(home, f);
  const actions = await Promise.all([
    recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }),
    recovery.recoverDrainSlot({ abrainHome: home, episodeId: f.episodeId, slot: 1 }),
  ]);
  assert(actions.every((action) => action === "index_converged" || action === "already_complete"), `concurrent actions: ${actions}`);
  const events = await recovery.readRecoveryEvents(home, f.episodeId, "drain");
  const folded = recovery.foldRecoveryEvents(events);
  assert(folded.get(1).published && folded.get(1).converged && !folded.get(1).aborted, "concurrent fold did not converge cleanly");
  assert(events.filter((item) => item.event_type === "commit_published").length === 1, "publication bytes diverged");
  assert(events.filter((item) => item.event_type === "index_converged").length === 1, "convergence bytes diverged");
  assert(git(f.repo, "rev-parse", "HEAD") === f.prepared.candidate, "ref not converged");
  assert((await cohort.snapshotIndexEntries(f.repo, f.paths)).get("owned.txt")?.includes(f.prepared.entries[0].blobOid), "index not converged");
});

await check("durable no-replace collision is surfaced", async () => {
  const home = makeHome("durable-collision");
  const first = await recovery.claimRecoverySlot({ abrainHome: home, episodeId: "durable-collision", lane: "drain", slot: 1 });
  fs.writeFileSync(first.filePath, "{}\n");
  await expectCode("RECOVERY_DURABLE_COLLISION", () => recovery.claimRecoverySlot({ abrainHome: home, episodeId: "durable-collision", lane: "drain", slot: 1 }));
});

await check("drain budget and terminal/abort bodies are fixed and terminal blocks new claims", async () => {
  const home = makeHome("drain-budget");
  const episodeId = "budget-drain";
  for (let slot = 1; slot <= 5; slot++) {
    assert(await claimNext(home, episodeId, "drain") === slot, `slot ${slot} not allocated`);
    assert(await recovery.recoverDrainSlot({ abrainHome: home, episodeId, slot }) === (slot === 5 ? "terminal" : "burned"), `slot ${slot} action wrong`);
  }
  const state = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, episodeId, "drain")).get(5);
  assert(state.terminal.body.reason === terminalBody().reason && state.terminal.body.owner_alert === true, "terminal reason is path-dependent");
  assert(state.aborted.body.reason === abortBody().reason && state.aborted.body.error_code === abortBody().error_code, "abort reason is path-dependent");
  const next = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId, lane: "drain" });
  assert(next.status === "terminal", "terminal episode accepted a new claim");
  assert(recovery.RECOVERY_LANE_BUDGETS.curator === 3, "curator budget changed");
});

await check("push missing and late outcomes burn once without reviving an aborted slot", async () => {
  const home = makeHome("push-missing-late");
  const repo = initRepo("push-missing-late");
  const bare = path.join(tmp, "push-missing-late.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const target = git(repo, "rev-parse", "HEAD");
  const episodeId = recovery.pushEpisodeIdentity({ repo_id: "push-missing", remote: bare, ref_name: "refs/heads/main", target_commit: target });
  assert(await claimNext(home, episodeId, "push") === 1, "missing slot not claimed");
  const result = await recovery.recoverPushEpisode({ abrainHome: home, episodeId, repo, remote: bare, refName: "refs/heads/main", targetCommit: target });
  assert(result.slot === 2 && result.classification === "success", `missing result did not advance: ${JSON.stringify(result)}`);

  const late = "push-late";
  assert(await claimNext(home, late, "push") === 1, "late slot1 claim failed");
  assert(await recovery.recoverPushSlot({ abrainHome: home, episodeId: late, slot: 1 }) === "burned", "late slot1 not burned");
  assert(await claimNext(home, late, "push") === 2, "late slot2 claim failed");
  await pushOutcome(home, late, 2, "retryable");
  await pushOutcome(home, late, 1, "success");
  const cursor = recovery.recoveryEpisodeCursor(late, "push", await recovery.readRecoveryEvents(home, late, "push"));
  assert(cursor.nextSlot === 3 && !cursor.complete && cursor.folded.get(1).pushOutcome, "late result revived burned slot");
});

await check("push nonretryable and slot-5 retryable share deterministic terminal bytes", async () => {
  const home = makeHome("push-terminal");
  const nonretry = "push-nonretry";
  assert(await claimNext(home, nonretry, "push") === 1, "nonretry claim failed");
  await pushOutcome(home, nonretry, 1, "nonretryable");
  assert(await recovery.recoverPushSlot({ abrainHome: home, episodeId: nonretry, slot: 1 }) === "nonretryable", "nonretry did not terminal");

  const exhausted = "push-exhausted";
  for (let slot = 1; slot <= 5; slot++) {
    assert(await claimNext(home, exhausted, "push") === slot, `push slot ${slot} not allocated`);
    await pushOutcome(home, exhausted, slot, "retryable");
    assert(await recovery.recoverPushSlot({ abrainHome: home, episodeId: exhausted, slot }) === (slot === 5 ? "terminal" : "retryable"), `push slot ${slot} wrong`);
  }
  const nonBody = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, nonretry, "push")).get(1).terminal.body;
  const exhaustedBody = recovery.foldRecoveryEvents(await recovery.readRecoveryEvents(home, exhausted, "push")).get(5).terminal.body;
  assert(JSON.stringify(nonBody) === JSON.stringify(exhaustedBody), "terminal bytes differ by reason path");
  assert(nonBody.reason === terminalBody().reason && nonBody.owner_alert === true, "terminal body category drifted");
});

await check("remote descendant fetch is object-only and remote refs must be fully qualified", async () => {
  const home = makeHome("push-remote");
  const repo = initRepo("push-fetch-local");
  const bare = path.join(tmp, "push-fetch.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const target = git(repo, "rev-parse", "HEAD");
  git(repo, "push", bare, `${target}:refs/heads/main`);
  const other = path.join(tmp, "push-fetch-other");
  git(tmp, "clone", "-q", bare, other);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.test");
  fs.writeFileSync(path.join(other, "descendant.txt"), "descendant\n");
  git(other, "add", "descendant.txt");
  git(other, "commit", "-qm", "descendant");
  const remoteOid = git(other, "rev-parse", "HEAD");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  const fetchHead = path.join(repo, ".git", "FETCH_HEAD");
  fs.rmSync(fetchHead, { force: true });
  const episodeId = recovery.pushEpisodeIdentity({ repo_id: "push-fetch", remote: bare, ref_name: "refs/heads/main", target_commit: target });
  const result = await recovery.recoverPushEpisode({ abrainHome: home, episodeId, repo, remote: bare, refName: "refs/heads/main", targetCommit: target });
  assert(result.classification === "success" && result.remoteContainsTarget, "remote descendant not absorbed");
  assert(!fs.existsSync(fetchHead) && git(repo, "cat-file", "-t", remoteOid) === "commit", "object-only fetch contract failed");

  const invalid = recovery.pushEpisodeIdentity({ repo_id: "invalid-ref", remote: bare, ref_name: "main", target_commit: target });
  await expectCode("REMOTE_REF_INVALID", () => recovery.recoverPushEpisode({ abrainHome: home, episodeId: invalid, repo, remote: bare, refName: "main", targetCommit: target }));
});

await check("curator claims stay 1..3 and whole-L1 recovery events remain meta-only", async () => {
  const home = makeHome("curator");
  const episodeId = recovery.curatorEpisodeIdentity({ generation_anchor: "curator-genesis" });
  for (let slot = 1; slot <= 3; slot++) {
    assert(await claimNext(home, episodeId, "curator") === slot, `curator slot ${slot} failed`);
    await recovery.burnPendingRecoverySlot({ abrainHome: home, episodeId, lane: "curator" });
  }
  const terminal = await recovery.claimNextRecoverySlot({ abrainHome: home, episodeId, lane: "curator" });
  assert(terminal.status === "terminal", "curator exhaustion not terminal");
  const scan = await l1.scanWholeL1Validated({ abrainHome: home });
  assert(scan.all.length > 0 && scan.all.every((record) => record.registration.role === "meta" && !record.registration.fold_eligible), "recovery event entered canonical fold");
  assert(scan.foldable.length === 0, "meta events became foldable");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
