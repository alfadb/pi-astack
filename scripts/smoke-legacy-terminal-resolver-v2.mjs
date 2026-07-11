#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const resolver = jiti(path.join(root, "extensions/_shared/legacy-terminal-resolver.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const transport = jiti(path.join(root, "extensions/_shared/canonical-git-transport.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-terminal-resolver-v2-"));
function git(repo, args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function repoId(repo) { return crypto.createHash("sha256").update(path.resolve(repo)).digest("hex"); }
function initRepo(name) {
  const repo = path.join(tmp, name); fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "smoke"]); git(repo, ["config", "user.email", "smoke@example.invalid"]);
  fs.writeFileSync(path.join(repo, "base"), "base\n"); git(repo, ["add", "base"]); git(repo, ["commit", "-m", "base"]);
  return repo;
}
async function makeLegacyTerminal(repo, suffix = "") {
  const target = git(repo, ["rev-parse", "HEAD"]);
  const episodeId = recovery.legacyPushEpisodeIdentity({ repo_id: repoId(repo), remote: "origin", ref_name: "refs/heads/main", target_commit: target });
  await recovery.recordLegacyPushIntentForTests({ abrainHome: repo, episodeId, repo, remote: "origin", refName: "refs/heads/main", targetCommit: target });
  for (let slot = 1; slot <= 5; slot++) {
    await recovery.claimRecoverySlot({ abrainHome: repo, episodeId, lane: "push", slot });
    await recovery.appendRecoveryEvent({ abrainHome: repo, episodeId, lane: "push", slot, eventType: "push_outcome", body: { classification: "retryable", target_commit: target } });
    await recovery.recoverPushSlot({ abrainHome: repo, episodeId, slot });
  }
  const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
  const records = scan.all.filter((record) => record.registration.envelope_schema === "drain-recovery-envelope/v1");
  return {
    target, episodeId,
    intentEventId: records.find((record) => record.body.event_type === "push_intent" && record.body.episode_id === episodeId).eventId,
    terminalEventId: records.find((record) => record.body.event_type === "recovery_episode_terminal" && record.body.episode_id === episodeId).eventId,
  };
}
class MockTransport {
  constructor(steps) { this.steps = [...steps]; this.pushes = []; this.closed = false; }
  async stableProof(target) {
    const step = this.steps.shift();
    if (step instanceof Error) throw step;
    const tip = step.tip;
    return { tipBefore: tip, fetchedOid: tip, tipAfter: tip, remoteContainsTarget: step.contains, relation: step.contains ? (tip === target ? "equal" : "descendant") : "absent", commands: [] };
  }
  async push(target) { this.pushes.push(target); return { exitCode: 0, command: { exitCode: 0, stdoutSha256: "1".repeat(64), stderrSha256: "2".repeat(64) } }; }
  async close() { this.closed = true; }
}
function scope(repo, target) { return { repo_id: repoId(repo), remote: "origin", ref_name: "refs/heads/main", target_commit: target, remote_url_id: "a".repeat(64), transport_policy_id: "b".repeat(64) }; }

const repo = initRepo("equal");
const legacy = await makeLegacyTerminal(repo);
const exact = { abrainHome: repo, legacyEpisodeId: legacy.episodeId, intentEventId: legacy.intentEventId, terminalEventId: legacy.terminalEventId, scope: scope(repo, legacy.target) };
await assert.rejects(() => resolver.resolveLegacyPushTerminal({ ...exact, intentEventId: "0".repeat(64), transportFactory: async () => new MockTransport([]) }), /LEGACY_INTENT_NOT_FOUND/);
await assert.rejects(() => resolver.resolveLegacyPushTerminal({ ...exact, terminalEventId: legacy.intentEventId, transportFactory: async () => new MockTransport([]) }), /LEGACY_TERMINAL_NOT_FOUND/);
await assert.rejects(() => resolver.resolveLegacyPushTerminal({ ...exact, scope: { ...exact.scope, repo_id: "0".repeat(64) }, transportFactory: async () => new MockTransport([]) }), /LEGACY_SCOPE_MISMATCH/);

const equalTransport = new MockTransport([{ tip: legacy.target, contains: true }]);
const equal = await resolver.resolveLegacyPushTerminal({ ...exact, transportFactory: async () => equalTransport });
assert.equal(equal.relation, "equal");
let scan = await l1.scanWholeL1Validated({ abrainHome: repo });
let assessment = await resolver.assessLegacyTerminalResolutions({ abrainHome: repo, currentScope: exact.scope, scan, transport: new MockTransport([{ tip: legacy.target, contains: true }]) });
assert.deepEqual(assessment.effectiveResolvedEpisodeIds, [legacy.episodeId]);
assert.equal(assessment.currentScopeUnresolved.length, 0);

const descendantTip = "d".repeat(40);
await recovery.appendRecoveryEvent({ abrainHome: repo, episodeId: legacy.episodeId, lane: "push", slot: 5, eventType: "push_terminal_resolution_attestation", body: { candidate_event_id: equal.candidateEventId, observed_tip: descendantTip, relation: "descendant" } });
assessment = await resolver.assessLegacyTerminalResolutions({ abrainHome: repo, currentScope: exact.scope, transport: new MockTransport([{ tip: descendantTip, contains: true }]) });
assert.deepEqual(assessment.effectiveResolvedEpisodeIds, [legacy.episodeId], "multiple legal tip attestations poisoned fresh proof");

const candidateOnlyRepo = initRepo("candidate-only");
const candidateOnly = await makeLegacyTerminal(candidateOnlyRepo);
const candidateExact = { abrainHome: candidateOnlyRepo, legacyEpisodeId: candidateOnly.episodeId, intentEventId: candidateOnly.intentEventId, terminalEventId: candidateOnly.terminalEventId, scope: scope(candidateOnlyRepo, candidateOnly.target) };
const crash = new transport.CanonicalGitTransportError("REMOTE_TIP_CHANGED", "crash fixture", { stage: "proof_tip_after", transportAttempted: false });
await assert.rejects(() => resolver.resolveLegacyPushTerminal({ ...candidateExact, transportFactory: async () => new MockTransport([crash, crash, crash]) }), /REMOTE_TIP_CHANGED/);
scan = await l1.scanWholeL1Validated({ abrainHome: candidateOnlyRepo });
assert.equal(scan.all.filter((record) => record.body.event_type === "push_terminal_resolution_candidate").length, 1);
assert.equal(scan.all.filter((record) => record.body.event_type === "push_terminal_resolution_attestation").length, 0);
assessment = await resolver.assessLegacyTerminalResolutions({ abrainHome: candidateOnlyRepo, currentScope: candidateExact.scope, scan, transport: new MockTransport([{ tip: candidateOnly.target, contains: true }]) });
assert.deepEqual(assessment.effectiveResolvedEpisodeIds, [], "candidate-only crash incorrectly became resolved from remote state alone");
assert.deepEqual(assessment.currentScopeUnresolved, [candidateOnly.episodeId]);

const pushCrashRepo = initRepo("push-done");
const pushCrash = await makeLegacyTerminal(pushCrashRepo);
const pushExact = { abrainHome: pushCrashRepo, legacyEpisodeId: pushCrash.episodeId, intentEventId: pushCrash.intentEventId, terminalEventId: pushCrash.terminalEventId, scope: scope(pushCrashRepo, pushCrash.target) };
const afterPushCrash = new transport.CanonicalGitTransportError("REMOTE_TIP_CHANGED", "after push fixture", { stage: "proof_tip_after", transportAttempted: false });
const pushMock = new MockTransport([{ tip: "e".repeat(40), contains: false }, afterPushCrash, afterPushCrash, afterPushCrash]);
await assert.rejects(() => resolver.resolveLegacyPushTerminal({ ...pushExact, transportFactory: async () => pushMock }), /REMOTE_TIP_CHANGED/);
assert.deepEqual(pushMock.pushes, [pushCrash.target]);
assessment = await resolver.assessLegacyTerminalResolutions({ abrainHome: pushCrashRepo, currentScope: pushExact.scope, transport: new MockTransport([{ tip: pushCrash.target, contains: true }]) });
assert.deepEqual(assessment.effectiveResolvedEpisodeIds, [], "push-done/no-attestation crash incorrectly became resolved");
assert.deepEqual(assessment.currentScopeUnresolved, [pushCrash.episodeId]);

await recovery.appendRecoveryEvent({ abrainHome: candidateOnlyRepo, episodeId: candidateOnly.episodeId, lane: "push", slot: 5, eventType: "push_terminal_resolution_candidate", body: { legacy_episode_id: candidateOnly.episodeId, legacy_intent_event_id: candidateOnly.intentEventId, legacy_terminal_event_id: "f".repeat(64), scope_version: "remote-scope/v2", ...candidateExact.scope } });
assessment = await resolver.assessLegacyTerminalResolutions({ abrainHome: candidateOnlyRepo, currentScope: candidateExact.scope, transport: new MockTransport([]) });
assert.deepEqual(assessment.quarantinedEpisodeIds, [candidateOnly.episodeId], "same-episode different candidate was not quarantined");

fs.writeFileSync(path.join(repo, "ahead"), "ahead\n"); git(repo, ["add", "ahead"]); git(repo, ["commit", "-m", "ahead"]);
const aheadScope = scope(repo, git(repo, ["rev-parse", "HEAD"]));
assessment = await resolver.assessLegacyTerminalResolutions({ abrainHome: repo, currentScope: aheadScope, transport: new MockTransport([{ tip: descendantTip, contains: true }]) });
assert.deepEqual(assessment.effectiveResolvedEpisodeIds, [legacy.episodeId], "same structural scope was bypassed solely because current HEAD changed");
assert.deepEqual(assessment.diagnosticsOnlyTerminalIds, []);

const v2Repo = initRepo("v2-misuse");
const v2Target = git(v2Repo, ["rev-parse", "HEAD"]);
const v2Scope = scope(v2Repo, v2Target);
const v2Episode = recovery.pushEpisodeIdentity(v2Scope);
await recovery.recordPushIntent({ abrainHome: v2Repo, episodeId: v2Episode, scope: v2Scope });
await recovery.recoverPushEpisode({ abrainHome: v2Repo, episodeId: v2Episode, repo: v2Repo, scope: v2Scope, transportFactory: async () => { throw new transport.CanonicalGitTransportError("CREDENTIAL_HELPER_COUNT_MISMATCH", "fixture"); } });
const repeated = await recovery.recoverPushEpisode({ abrainHome: v2Repo, episodeId: v2Episode, repo: v2Repo, scope: v2Scope, transportFactory: async () => { throw new Error("must not execute"); } });
assert.equal(repeated.classification, "terminal", "repeated startup/recovery advanced a second push slot");
scan = await l1.scanWholeL1Validated({ abrainHome: v2Repo });
const v2Records = scan.all.filter((record) => record.body.episode_id === v2Episode);
const v2Intent = v2Records.find((record) => record.body.event_type === "push_intent").eventId;
const v2Terminal = v2Records.find((record) => record.body.event_type === "recovery_episode_terminal").eventId;
await assert.rejects(() => resolver.resolveLegacyPushTerminal({ abrainHome: v2Repo, legacyEpisodeId: v2Episode, intentEventId: v2Intent, terminalEventId: v2Terminal, scope: v2Scope, transportFactory: async () => new MockTransport([]) }), /LEGACY_RESOLVER_V2_FORBIDDEN/);
const v2Outcome = v2Records.find((record) => record.body.event_type === "push_outcome").body.body;
assert.deepEqual(Object.keys(v2Outcome).sort(), ["classification", "command_exit_code", "error_code", "ref_name", "remote", "remote_contains_target", "remote_ref_after", "remote_ref_before", "remote_url_id", "repo_id", "stage", "stderr_redacted_sha256", "stdout_redacted_sha256", "target_commit", "transport_attempted", "transport_policy_id"].sort());
assert.equal(v2Outcome.classification, "nonretryable");
assert.equal(v2Outcome.stage, "pretransport");
assert.equal(v2Outcome.transport_attempted, false);
assert.equal(v2Records.filter((record) => record.body.event_type === "recovery_slot_claimed").length, 1, "pretransport nonretryable burned more than slot 1");

const proofFailureRepo = initRepo("proof-auth-failure");
const proofFailureTarget = git(proofFailureRepo, ["rev-parse", "HEAD"]);
const proofFailureScope = scope(proofFailureRepo, proofFailureTarget);
const proofFailureEpisode = recovery.pushEpisodeIdentity(proofFailureScope);
await recovery.recordPushIntent({ abrainHome: proofFailureRepo, episodeId: proofFailureEpisode, scope: proofFailureScope });
await recovery.recoverPushEpisode({
  abrainHome: proofFailureRepo,
  episodeId: proofFailureEpisode,
  repo: proofFailureRepo,
  scope: proofFailureScope,
  transportFactory: async () => new MockTransport([new transport.CanonicalGitTransportError("AUTH_FAILED", "credential fixture", { stage: "proof_tip_before", transportAttempted: false })]),
});
scan = await l1.scanWholeL1Validated({ abrainHome: proofFailureRepo });
const proofFailureOutcome = scan.all.find((record) => record.body.episode_id === proofFailureEpisode && record.body.event_type === "push_outcome").body.body;
assert.equal(proofFailureOutcome.transport_attempted, false, "credential/proof failure was mislabeled as mutating transport");
assert.match(proofFailureOutcome.stage, /^proof/);

const pushFailureRepo = initRepo("push-failure");
const pushFailureTarget = git(pushFailureRepo, ["rev-parse", "HEAD"]);
const pushFailureScope = scope(pushFailureRepo, pushFailureTarget);
const pushFailureEpisode = recovery.pushEpisodeIdentity(pushFailureScope);
await recovery.recordPushIntent({ abrainHome: pushFailureRepo, episodeId: pushFailureEpisode, scope: pushFailureScope });
const absentTip = "e".repeat(40);
await recovery.recoverPushEpisode({
  abrainHome: pushFailureRepo,
  episodeId: pushFailureEpisode,
  repo: pushFailureRepo,
  scope: pushFailureScope,
  transportFactory: async () => ({
    stableProof: async () => ({ tipBefore: absentTip, fetchedOid: absentTip, tipAfter: absentTip, remoteContainsTarget: false, relation: "absent", commands: [] }),
    push: async () => ({ exitCode: 1, retryableNetwork: false, command: { exitCode: 1, stdoutSha256: "1".repeat(64), stderrSha256: "2".repeat(64) } }),
    close: async () => undefined,
  }),
});
scan = await l1.scanWholeL1Validated({ abrainHome: pushFailureRepo });
const pushFailureOutcome = scan.all.find((record) => record.body.episode_id === pushFailureEpisode && record.body.event_type === "push_outcome").body.body;
assert.equal(pushFailureOutcome.transport_attempted, true, "started mutating push was not labeled as transport attempted");
assert.equal(pushFailureOutcome.stage, "push");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("legacy terminal resolver v2: exact IDs, attestation+fresh proof, same-scope blocking, crash unresolved, conflict quarantine PASS");
