#!/usr/bin/env node
/** Read-only production verifier for canonical-path P1 LOCAL-RUNTIME-RESTART. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const exact = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
const { canonicalizeJcs } = jiti(path.join(root, "extensions/_shared/jcs.ts"));

const EPISODE = "7181b2b529198e66d5dea01bd491be69df40f0707e430a0f8a7e24c9893219e9";
const EXPECTED_SOURCE_REF = "sediment:auto_write:updated:restart-probes-require-an-isolated-canonical-backlog";
const OBSERVED_CHECKPOINT_HEAD = "8a57df7083b2761720646acc7ea85a2133062608";
const LEGACY_ID = "1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a";
const LEGACY_PATH = l1.expectedL1EventRelativePath(LEGACY_ID);
const SESSION_ID = "019f5608-e2af-7198-85a9-825f182e3c20";
const FRESH_PIDS = Object.freeze({ launcher: 3180698, runtime: 3180700 });
const EXPECTED_TYPES = Object.freeze(["commit_prepared", "commit_published", "index_converged", "recovery_slot_claimed"]);
const ACTIVE_TYPES = new Set(["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged", "recovery_slot_aborted", "recovery_episode_terminal"]);

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  return { ...env, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}
function gitResult(repo, args) { return spawnSync("git", ["-C", repo, "--literal-pathspecs", ...args], { env: gitEnv(), encoding: "buffer", maxBuffer: 128 * 1024 * 1024 }); }
function gitBuffer(repo, args) {
  const result = gitResult(repo, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (${String(result.status)}): ${result.stderr?.toString("utf8").trim()}`);
  return result.stdout;
}
function gitText(repo, args) { return gitBuffer(repo, args).toString("utf8").trim(); }
function gitOk(repo, args) { return gitResult(repo, args).status === 0; }
function eventTimeMs(repo, record) { return fs.statSync(path.join(repo, ...record.relativePath.split("/"))).mtimeMs; }
function readJsonl(file) { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
function parseCommit(repo, oid) {
  const raw = gitBuffer(repo, ["cat-file", "commit", oid]).toString("utf8");
  const split = raw.indexOf("\n\n");
  const headers = raw.slice(0, split).split("\n");
  return {
    oid,
    tree: headers.find((line) => line.startsWith("tree "))?.slice(5) ?? null,
    parents: headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
    author: headers.find((line) => line.startsWith("author "))?.slice(7) ?? null,
    committer: headers.find((line) => line.startsWith("committer "))?.slice(10) ?? null,
    message: raw.slice(split + 2).replace(/\n$/, ""),
  };
}
function parseDiff(raw) {
  const tokens = raw.toString("utf8").split("\0").filter(Boolean);
  const rows = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const meta = tokens[i];
    const relativePath = tokens[i + 1];
    if (!meta?.startsWith(":") || relativePath === undefined) throw new Error("unparseable diff-tree output");
    const [oldMode, newMode, oldOid, newOid, status] = meta.slice(1).split(/\s+/);
    rows.push({ path: relativePath, oldMode, newMode, oldOid, newOid, status });
  }
  return rows.sort((a, b) => compare(a.path, b.path));
}
function parseSessionHeader(file) {
  const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
  return JSON.parse(first);
}
function publicEvent(record) {
  return { eventId: record.eventId, eventType: record.body.event_type, episodeId: record.body.episode_id, slot: record.body.slot, relativePath: record.relativePath };
}

const abrain = path.resolve(arg("abrain", "/home/worker/.abrain"));
const timelineRoot = path.resolve(arg("timeline-root", abrain));
const sessionFile = path.resolve(arg("session", "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-12T11-14-10-735Z_019f5608-e2af-7198-85a9-825f182e3c20.jsonl"));
const gitSyncFile = path.resolve(arg("git-sync", "/home/worker/.abrain/.state/git-sync.jsonl"));
const dispatchAudit = path.resolve(arg("dispatch-audit", "/home/worker/.pi/.pi-astack/dispatch/audit.jsonl"));
const output = path.resolve(arg("output", path.join(root, "docs/evidence/2026-07-12-canonical-path-p1-production-runtime-restart-report.json")));
const manifestOutput = path.resolve(arg("manifest", path.join(root, "docs/evidence/2026-07-12-canonical-path-p1-production-runtime-restart-manifest.json")));
if (inside(abrain, output) || inside(abrain, manifestOutput)) throw new Error("evidence output must be outside --abrain");

const checks = {};
const errors = [];
const check = (name, condition, detail = name) => { checks[name] = Boolean(condition); if (!condition) errors.push(detail); };
let facts = null;
try {
  const scan = await l1.scanWholeL1Validated({ abrainHome: abrain });
  check("wholeL1StrictValidation", true);
  const historicalV2 = scan.all.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2");
  check("allHistoricalV2TypesRegistered", historicalV2.every((item) => ACTIVE_TYPES.has(item.body.event_type)), "historical_v2_event_type_unknown");
  const episode = historicalV2.filter((item) => item.body.episode_id === EPISODE);
  const byType = new Map(episode.map((item) => [item.body.event_type, item]));
  const types = episode.map((item) => item.body.event_type).sort(compare);
  check("episodeExactFourEventClosure", episode.length === 4 && JSON.stringify(types) === JSON.stringify(EXPECTED_TYPES), "episode_event_set_not_exact");
  check("sameDrainLaneSlotOne", episode.every((item) => item.body.lane === "drain" && item.body.slot === 1), "episode_lane_or_slot_mismatch");
  check("noAbortTerminalOrNewSlot", !episode.some((item) => item.body.event_type === "recovery_slot_aborted" || item.body.event_type === "recovery_episode_terminal" || item.body.slot !== 1), "episode_abort_terminal_or_new_slot");
  const claim = byType.get("recovery_slot_claimed");
  const preparedRecord = byType.get("commit_prepared");
  const published = byType.get("commit_published");
  const converged = byType.get("index_converged");
  const prepared = preparedRecord?.body.body;
  const candidate = prepared?.candidate;
  check("claimIdentityDeterministic", claim?.body.body?.claim_id === recovery.recoveryClaimId(EPISODE, "drain", 1), "claim_identity_mismatch");
  check("sameCandidateAcrossRecovery", typeof candidate === "string" && published?.body.body?.candidate === candidate && converged?.body.body?.candidate === candidate, "recovery_candidate_mismatch");
  check("publicationConfirmed", published?.body.body?.publication_confirmed === true, "publication_not_confirmed");
  const cursor = recovery.recoveryEpisodeCursor(EPISODE, "drain", episode.map((item) => item.body));
  check("episodeFoldComplete", cursor.complete === true && cursor.terminal === false && cursor.pendingSlot === null && cursor.nextSlot === null, "episode_fold_incomplete");

  const sourceEntries = (prepared?.entries ?? []).filter((entry) => entry.path.startsWith("l1/events/sha256/"));
  const recordByPath = new Map(scan.all.map((item) => [item.relativePath, item]));
  const sourceMatches = sourceEntries.map((entry) => recordByPath.get(entry.path)).filter((item) => item?.registration.envelope_schema === "knowledge-evidence-envelope/v1" && item.body?.source?.source_ref === EXPECTED_SOURCE_REF);
  check("singleRealAutoWriteSourceDerivedFromL1", sourceMatches.length === 1, "real_auto_write_source_missing_or_ambiguous");
  const source = sourceMatches[0];
  check("sourceProducerExact", source?.body?.producer?.name === "sediment.knowledge-event-writer" && source?.body?.producer?.version === "adr0039-p5", "source_producer_mismatch");

  const commit = parseCommit(abrain, candidate);
  const manifestRoot = exact.cohortManifestRoot(prepared.entries);
  const parentEpoch = gitText(abrain, ["show", "-s", "--format=%ct", prepared.frozen_commit]);
  const expectedIdentity = `pi-astack-local-drain <local-drain@pi-astack.invalid> ${parentEpoch} +0000`;
  check("candidateExactParent", commit.parents.length === 1 && commit.parents[0] === prepared.frozen_commit, "candidate_parent_mismatch");
  check("candidateExactTree", commit.tree === prepared.new_tree, "candidate_tree_mismatch");
  check("candidateExactCohortHash", manifestRoot === prepared.cohort_manifest_root, "candidate_cohort_hash_mismatch");
  check("candidateDeterministicCommitBytes", commit.author === expectedIdentity && commit.committer === expectedIdentity && commit.message === exact.deterministicDrainCommitMessage(manifestRoot), "candidate_commit_protocol_mismatch");
  const paths = prepared.entries.map((entry) => entry.path);
  check("candidateCohortSortedUnique", paths.length > 0 && new Set(paths).size === paths.length && JSON.stringify(paths) === JSON.stringify([...paths].sort(compare)), "candidate_cohort_not_sorted_unique");
  check("legacy1750Excluded", !paths.includes(LEGACY_PATH), "legacy_1750_in_candidate_cohort");
  const legacy = scan.legacyReadOnly.find((item) => item.eventId === LEGACY_ID);
  check("legacy1750StrictReadOnly", legacy?.registration.phase === "legacy_read_only" && legacy.registration.write_enabled === false && legacy.registration.fold_eligible === false, "legacy_1750_not_strict_read_only");
  const snapshotPaths = Object.keys(prepared.frozen_index_snapshot ?? {}).sort(compare);
  check("frozenIndexSnapshotExact", JSON.stringify(snapshotPaths) === JSON.stringify([...paths].sort(compare)), "frozen_index_snapshot_mismatch");
  const diff = parseDiff(gitBuffer(abrain, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", prepared.frozen_commit, candidate]));
  check("preparedEntriesEqualCandidateDiff", diff.length === prepared.entries.length && prepared.entries.every((entry, i) => diff[i]?.path === entry.path), "prepared_diff_mismatch");
  let bytesExact = true;
  const entryFacts = [];
  for (const entry of prepared.entries) {
    const row = diff.find((item) => item.path === entry.path);
    if (entry.op === "delete") {
      bytesExact &&= row?.status === "D";
      entryFacts.push({ ...entry, verifiedBytesSha256: null });
      continue;
    }
    const blob = gitBuffer(abrain, ["cat-file", "blob", entry.blobOid]);
    const observedHash = sha256(blob);
    bytesExact &&= row?.newMode === entry.mode && row?.newOid === entry.blobOid && observedHash === entry.bytesSha256;
    entryFacts.push({ ...entry, verifiedBytesSha256: observedHash });
  }
  check("candidateExactBlobModeAndHash", bytesExact, "candidate_blob_mode_or_hash_mismatch");

  const currentHead = gitText(abrain, ["rev-parse", "HEAD^{commit}"]);
  const originHead = gitText(abrain, ["rev-parse", "refs/remotes/origin/main^{commit}"]);
  check("observedCheckpointContainsCandidate", gitOk(abrain, ["merge-base", "--is-ancestor", candidate, OBSERVED_CHECKPOINT_HEAD]), "observed_checkpoint_does_not_contain_candidate");
  check("currentHeadContainsObservedCheckpoint", gitOk(abrain, ["merge-base", "--is-ancestor", OBSERVED_CHECKPOINT_HEAD, currentHead]), "current_head_does_not_contain_observed_checkpoint");
  check("currentHeadContainsCandidate", gitOk(abrain, ["merge-base", "--is-ancestor", candidate, currentHead]), "current_head_does_not_contain_candidate");
  check("currentHeadEqualsOriginMainObservation", currentHead === originHead, "current_head_origin_mismatch");
  check("sharedIndexEqualsHead", gitOk(abrain, ["diff-index", "--cached", "--quiet", currentHead, "--"]) && gitText(abrain, ["ls-files", "-u"]) === "", "shared_index_not_green");
  const replaceRefs = gitText(abrain, ["for-each-ref", "--format=%(refname)", "refs/replace"]);
  check("noGitReplaceRefs", replaceRefs === "", "git_replace_ref_present");
  const timelineRecords = await l1.scanWholeL1Validated({ abrainHome: timelineRoot });
  const timelineEpisode = timelineRecords.all.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2" && item.body.episode_id === EPISODE);
  const timelineByType = new Map(timelineEpisode.map((item) => [item.body.event_type, item]));
  const claimMs = eventTimeMs(timelineRoot, timelineByType.get("recovery_slot_claimed"));
  const preparedMs = eventTimeMs(timelineRoot, timelineByType.get("commit_prepared"));
  const publishedMs = eventTimeMs(timelineRoot, timelineByType.get("commit_published"));
  const convergedMs = eventTimeMs(timelineRoot, timelineByType.get("index_converged"));
  const sessionHeader = parseSessionHeader(sessionFile);
  const sessionMs = Date.parse(sessionHeader.timestamp);
  check("freshSessionHeaderExact", sessionHeader.type === "session" && sessionHeader.id === SESSION_ID && sessionHeader.cwd === "/home/worker/.pi", "fresh_session_header_mismatch");
  check("preparedExistedBeforeFreshProcessBoundary", claimMs <= preparedMs && preparedMs < sessionMs, "prepared_not_before_fresh_process");
  check("sameEpisodeRecoveredAfterFreshProcessBoundary", sessionMs < publishedMs && publishedMs <= convergedMs, "publication_not_after_fresh_process");
  const retiredProbeEnvName = ["PI", "ASTACK", "P1", "RESTART", "PROBE"].join("_");
  check("freshSessionHasNoProbeTokenObservation", !fs.readFileSync(sessionFile, "utf8").includes(retiredProbeEnvName), "fresh_session_contains_probe_token");
  const dispatchRows = readJsonl(dispatchAudit).filter((row) => row.pid === FRESH_PIDS.runtime && row.session_id === SESSION_ID);
  check("freshRuntimePidCorroborated", dispatchRows.length > 0, "fresh_runtime_pid_not_corroborated");
  const syncRows = readJsonl(gitSyncFile).filter((row) => typeof row.ts === "string" && Date.parse(row.ts) >= sessionMs && Date.parse(row.ts) <= convergedMs + 60_000);
  const canonicalWindowTransport = syncRows.filter((row) => Date.parse(row.ts) <= convergedMs && ["fetch", "push", "merge"].includes(row.op));
  const postReadyTransport = syncRows.filter((row) => Date.parse(row.ts) > convergedMs && ["fetch", "push"].includes(row.op));
  check("canonicalRecoveryIssuedNoRemoteCommand", canonicalWindowTransport.length === 0, "remote_command_during_canonical_recovery");
  check("deviceTransportObservedOnlyAfterReady", postReadyTransport.length >= 2 && postReadyTransport.every((row) => Date.parse(row.ts) > convergedMs), "device_transport_not_after_ready");

  facts = {
    episode: { episodeId: EPISODE, slot: 1, events: Object.fromEntries([...byType].map(([type, record]) => [type, publicEvent(record)])) },
    claimId: claim.body.body.claim_id,
    candidate: { oid: candidate, parent: prepared.frozen_commit, tree: prepared.new_tree, cohortManifestRoot: prepared.cohort_manifest_root, entries: entryFacts },
    source: { eventId: source.eventId, sourceRef: source.body.source.source_ref, producer: source.body.producer, relativePath: source.relativePath },
    timeline: {
      claimMtimeUtc: new Date(claimMs).toISOString(), preparedMtimeUtc: new Date(preparedMs).toISOString(), freshSessionUtc: sessionHeader.timestamp,
      publishedMtimeUtc: new Date(publishedMs).toISOString(), convergedMtimeUtc: new Date(convergedMs).toISOString(),
      freshProcess: { launcherPid: FRESH_PIDS.launcher, runtimePid: FRESH_PIDS.runtime, processStartedAt: "2026-07-12T11:14:08.000Z", processStartEvidence: "operator-observed; durable session header begins at 2026-07-12T11:14:10.735Z", sessionId: SESSION_ID, noProbeEnvironment: "operator-observed; session contains no probe token" },
      canonicalRecoveryRemoteCommands: canonicalWindowTransport,
      postReadyDeviceTransport: postReadyTransport.map((row) => ({ ts: row.ts, op: row.op, result: row.result })),
    },
    repository: {
      observedCheckpoint: { head: OBSERVED_CHECKPOINT_HEAD, originMain: OBSERVED_CHECKPOINT_HEAD, evidence: "request-time observation; both are verified ancestors of the live equal HEAD/origin refs" },
      ref: gitText(abrain, ["symbolic-ref", "-q", "HEAD"]), currentHeadContainsCandidate: true, currentHeadContainsObservedCheckpoint: true,
      currentHeadEqualsOriginMain: true, wholeL1Strict: true, sharedIndexEqualsHead: true,
    },
  };
} catch (error) {
  errors.push(`verification_exception:${error?.code ?? error?.message ?? String(error)}`);
  if (!("wholeL1StrictValidation" in checks)) checks.wholeL1StrictValidation = false;
}

const uniqueErrors = [...new Set(errors)].sort(compare);
const base = {
  schemaVersion: "canonical-path-p1-production-runtime-restart-dossier/v1",
  status: uniqueErrors.length === 0 && Object.values(checks).every(Boolean) ? "pass" : "fail",
  mutationAttempted: false,
  networkAttempted: false,
  scope: { acceptedCriteria: ["LOCAL-RUNTIME-RESTART"], exclusions: ["P2", "P3", "P4a", "P4b"], deviceTransportCanonicalGate: false },
  facts,
  residualRisk: {
    orderedOperatorReplacementProven: false,
    oldArmedProcessExitedBeforeFreshStart: false,
    freshProcessLaunchCause: "review dispatch unintentionally started a normal no-probe Pi process",
    disposition: "This weakens operator-sequence hygiene but does not change the durable same-pending-episode fresh-process recovery fact. The record must not be represented as an orderly operator replacement.",
  },
  verification: checks,
  errors: uniqueErrors,
};
const dossierSelfHash = sha256(Buffer.from(canonicalizeJcs(base)));
const report = { ...base, dossierSelfHash, dossierSelfHashRule: "sha256(RFC8785-JCS(report_without_dossierSelfHash_and_rule))" };
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
const reportExactSha256 = sha256(reportBytes);
const manifest = {
  schemaVersion: "canonical-path-p1-production-runtime-restart-evidence-manifest/v1",
  scope: report.scope,
  report: { file: path.basename(output), exactBytesSha256: reportExactSha256, exactBytes: reportBytes.length, dossierSelfHash, status: report.status },
  derivedAnchors: report.facts ? { episodeId: report.facts.episode.episodeId, eventIds: Object.fromEntries(Object.entries(report.facts.episode.events).map(([type, event]) => [type, event.eventId])), sourceEventId: report.facts.source.eventId, candidate: report.facts.candidate.oid, observedCheckpointHead: report.facts.repository.observedCheckpoint.head } : null,
  allVerificationBooleans: report.verification,
  residualRisk: report.residualRisk,
  immutabilityAnchor: "Commit this report and manifest in pi-astack; the manifest intentionally claims no intrinsic digest.",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(path.dirname(manifestOutput), { recursive: true });
fs.writeFileSync(output, reportBytes);
fs.writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: report.status, report: output, reportExactSha256, manifest: manifestOutput, dossierSelfHash, errors: uniqueErrors })}\n`);
process.exitCode = report.status === "pass" ? 0 : 1;
