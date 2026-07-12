#!/usr/bin/env node
/** Read-only LOCAL-DRAIN-NEXT and CURATOR-PENDING production verifier. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const exact = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
const knowledge = jiti(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
const parser = jiti(path.join(root, "extensions/_shared/git-z-parser.ts"));
const { canonicalizeJcs } = jiti(path.join(root, "extensions/_shared/jcs.ts"));

const BASELINE = "ea1b9be1f49ffcf87f07ad94189c33126899ebe3";
const REPLAY_1 = "781b584d65b31e60d12ed4eedf1332b51d68c295";
const REPLAY_2 = "916de3219d3f76bad4ee0d18d18410f2e3bd87dc";
const CANDIDATE = "0a5956715c085e704b378531cb9b7c2d0731a1ac";
const SOURCE_EVENT = "4250d277cfe27789fe6e29534ee48a8a3319bc8031613b4027c0e546f8b9bedc";
const SOURCE_L2 = "l2/views/knowledge/latest/projects/pi-global/disabled-canonical-runtime-can-leave-valid-sediment-backlogs.md";
const KNOWLEDGE_MANIFEST = "l2/views/knowledge/latest/manifest.json";
const LEGACY_ID = "1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a";
const LEGACY_PATH = l1.expectedL1EventRelativePath(LEGACY_ID);
const EXPECTED_CHAIN = Object.freeze([BASELINE, REPLAY_1, REPLAY_2, CANDIDATE]);
const EXPECTED_RECOVERY_TYPES = Object.freeze(["commit_prepared", "commit_published", "index_converged", "recovery_slot_claimed"]);
const ACTIVE_V2_TYPES = Object.freeze(["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged", "recovery_slot_aborted", "recovery_episode_terminal"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40,64}$/;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function sanitizedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  return { ...env, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
function gitResult(repo, args) {
  return spawnSync("git", ["-C", repo, "--literal-pathspecs", ...args], { env: sanitizedEnv(), encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
}
function gitBuffer(repo, args) {
  const result = gitResult(repo, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (${String(result.status)}): ${result.stderr?.toString("utf8").trim()}`);
  return result.stdout;
}
function gitText(repo, args) { return gitBuffer(repo, args).toString("utf8").trim(); }
function gitOk(repo, args) { return gitResult(repo, args).status === 0; }
function readCommitPath(repo, commit, relativePath) { return gitBuffer(repo, ["show", `${commit}:${relativePath}`]); }
function parseDiff(raw) {
  const tokens = raw.toString("utf8").split("\0").filter(Boolean);
  const rows = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const meta = tokens[index];
    const relativePath = tokens[index + 1];
    if (!meta?.startsWith(":") || relativePath === undefined) throw new Error("unparseable diff-tree output");
    const parts = meta.slice(1).split(/\s+/);
    if (parts.length !== 5) throw new Error("unexpected diff-tree metadata");
    rows.push({ path: relativePath, oldMode: parts[0], newMode: parts[1], oldOid: parts[2], newOid: parts[3], status: parts[4] });
  }
  return rows.sort((a, b) => compare(a.path, b.path));
}
function parseTree(raw) {
  const result = new Map();
  for (const row of raw.toString("utf8").split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const parts = row.slice(0, tab).split(/\s+/);
    if (tab < 0 || parts.length !== 3) throw new Error("unparseable ls-tree output");
    result.set(row.slice(tab + 1), { mode: parts[0], type: parts[1], oid: parts[2] });
  }
  return result;
}
function commitFacts(repo, oid) {
  const raw = gitBuffer(repo, ["cat-file", "commit", oid]).toString("utf8");
  const split = raw.indexOf("\n\n");
  if (split < 0) throw new Error(`commit ${oid} has no message separator`);
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
function sourceRefOf(scanRecord) { return record(scanRecord?.body?.source)?.source_ref ?? null; }
function frontmatterScalar(markdown, key) {
  const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(markdown);
  return match?.[1]?.trim() ?? null;
}
function sameArray(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function pushObservation(repo, candidate) {
  const result = gitResult(repo, ["rev-parse", "--verify", "@{upstream}^{commit}"]);
  if (result.status !== 0) return { canonicalGate: false, source: "local_tracking_ref_only_no_network", observed: false, trackingOid: null, containsCandidate: null };
  const trackingOid = result.stdout.toString("utf8").trim();
  return { canonicalGate: false, source: "local_tracking_ref_only_no_network", observed: true, trackingOid, containsCandidate: gitOk(repo, ["merge-base", "--is-ancestor", candidate, trackingOid]) };
}

const abrain = path.resolve(arg("abrain", "/home/worker/.abrain"));
const baseline = arg("baseline", BASELINE);
const candidate = arg("candidate", CANDIDATE);
const sourceEventId = arg("source-event", SOURCE_EVENT);
const sourceL2Path = arg("l2-path", SOURCE_L2);
const output = path.resolve(arg("output", path.join(root, "docs/evidence/2026-07-12-canonical-path-p1-local-drain-next-curator-isolation-report.json")));
const manifestOutput = path.resolve(arg("manifest", path.join(root, "docs/evidence/2026-07-12-canonical-path-p1-local-drain-next-curator-isolation-manifest.json")));
if (![baseline, candidate].every((value) => OID_RE.test(value))) throw new Error("baseline/candidate must be lowercase Git OIDs");
if (!SHA256_RE.test(sourceEventId)) throw new Error("source-event must be lowercase SHA-256");
if (inside(abrain, output) || inside(abrain, manifestOutput)) throw new Error("evidence outputs must be outside --abrain");

const errors = [];
const checks = {};
const check = (name, condition, detail = name) => {
  checks[name] = Boolean(condition);
  if (!condition) errors.push(detail);
};
let scan = null;
let sourceRecord = null;
let sourceBody = null;
let sourceTimestamp = null;
let chainFacts = [];
let currentHead = null;
let currentRef = null;
let currentStatus = [];
let wholeL1 = null;
let projectionFacts = null;
let curatorFacts = null;

try {
  check("baselineAcceptanceAnchorExact", baseline === BASELINE, "baseline_anchor_mismatch");
  check("candidateAcceptanceAnchorExact", candidate === CANDIDATE, "candidate_anchor_mismatch");
  check("sourceAcceptanceAnchorExact", sourceEventId === SOURCE_EVENT, "source_event_anchor_mismatch");
  check("replayCandidatesRejectedAsAcceptanceAnchors", candidate !== REPLAY_1 && candidate !== REPLAY_2, "candidate_replay_anchor_rejected");

  currentHead = gitText(abrain, ["rev-parse", "HEAD^{commit}"]);
  currentRef = gitText(abrain, ["symbolic-ref", "-q", "HEAD"]);
  check("candidateContainedByCurrentHead", gitOk(abrain, ["merge-base", "--is-ancestor", candidate, currentHead]), "candidate_not_contained_by_current_head");
  check("baselineContainedByCandidate", gitOk(abrain, ["merge-base", "--is-ancestor", baseline, candidate]), "broken_baseline_candidate_ancestry");
  check("currentProductionRefMain", currentRef === "refs/heads/main", "current_ref_not_main");

  scan = await l1.scanWholeL1Validated({ abrainHome: abrain });
  wholeL1 = { all: scan.all.length, selected: scan.selected.length, foldable: scan.foldable.length, activeV2: scan.selected.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2").length, legacyReadOnly: scan.legacyReadOnly.length, foreignSkipped: scan.foreignSkipped.length, phaseDisabledShadow: scan.phaseDisabledShadow.length, tempResidue: scan.tempResidue.length };
  check("currentWholeL1Strict", true);

  const recordsById = new Map(scan.all.map((item) => [item.eventId, item]));
  const activeV2 = scan.selected.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2");
  check("productionActiveV2AllDrainLane", activeV2.length > 0 && activeV2.every((item) => item.body.lane === "drain"), "active_v2_non_drain_lane_present");
  check("productionActiveV2ProducerExact", activeV2.every((item) => item.body.producer?.name === "pi-astack.convergence-recovery" && item.body.producer?.version === "2.0.0"), "active_v2_producer_mismatch");
  check("productionActiveV2EventTypesRegistered", activeV2.every((item) => ACTIVE_V2_TYPES.includes(item.body.event_type)), "active_v2_event_type_mismatch");
  const recovered = recovery.recoverOpenRecoveryEpisodesFromScan(scan);
  check("productionRollingRecoveryGloballyClosed", recovered.open.length === 0 && recovered.terminal.length === 0 && recovered.quarantined.length === 0, "production_recovery_not_globally_closed");

  const observedChain = gitText(abrain, ["rev-list", "--first-parent", "--reverse", `${baseline}^..${candidate}`]).split("\n").filter(Boolean);
  check("baselineToCandidateLinearChainExact", sameArray(observedChain, EXPECTED_CHAIN), "generation_chain_mismatch");

  let generationAnchor = "genesis";
  for (const [ordinal, oid] of EXPECTED_CHAIN.entries()) {
    const preparedRecords = activeV2.filter((item) => item.body.event_type === "commit_prepared" && item.body.body?.candidate === oid);
    check(`generation${ordinal + 1}SinglePrepared`, preparedRecords.length === 1, `generation_${ordinal + 1}_prepared_missing_or_ambiguous`);
    if (preparedRecords.length !== 1) continue;
    const preparedRecord = preparedRecords[0];
    const prepared = preparedRecord.body.body;
    const episodeId = preparedRecord.body.episode_id;
    const episodeRecords = activeV2.filter((item) => item.body.episode_id === episodeId);
    const episodeEvents = episodeRecords.map((item) => item.body);
    const eventTypes = episodeEvents.map((item) => item.event_type).sort(compare);
    const eventIds = Object.fromEntries(episodeRecords.map((item) => [item.body.event_type, item.eventId]));
    const expectedEpisode = recovery.deriveNextEpisodeIdentity({ symbolicRef: "refs/heads/main", generationAnchor });
    check(`generation${ordinal + 1}EpisodeIdentity`, episodeId === expectedEpisode, `generation_${ordinal + 1}_episode_identity_mismatch`);
    check(`generation${ordinal + 1}RecoveryExactClosure`, episodeRecords.length === 4 && sameArray(eventTypes, EXPECTED_RECOVERY_TYPES), `generation_${ordinal + 1}_recovery_event_set_mismatch`);
    let cursor = null;
    try { cursor = recovery.recoveryEpisodeCursor(episodeId, "drain", episodeEvents); }
    catch (error) { errors.push(`generation_${ordinal + 1}_recovery_fold:${error?.code ?? error?.message ?? String(error)}`); }
    check(`generation${ordinal + 1}RecoveryFoldComplete`, cursor?.complete === true && cursor?.terminal === false && cursor?.pendingSlot === null && cursor?.nextSlot === null, `generation_${ordinal + 1}_recovery_incomplete`);
    check(`generation${ordinal + 1}SlotOne`, episodeRecords.every((item) => item.body.slot === 1 && item.body.lane === "drain"), `generation_${ordinal + 1}_slot_or_lane_mismatch`);

    const commit = commitFacts(abrain, oid);
    const parent = prepared.frozen_commit;
    const entries = Array.isArray(prepared.entries) ? prepared.entries : [];
    const entryPaths = entries.map((item) => item.path);
    const manifestRoot = exact.cohortManifestRoot(entries);
    const parentEpoch = gitText(abrain, ["show", "-s", "--format=%ct", parent]);
    const expectedIdentity = `pi-astack-local-drain <local-drain@pi-astack.invalid> ${parentEpoch} +0000`;
    check(`generation${ordinal + 1}ParentLinear`, commit.parents.length === 1 && commit.parents[0] === parent && (ordinal === 0 || parent === EXPECTED_CHAIN[ordinal - 1]), `generation_${ordinal + 1}_parent_mismatch`);
    check(`generation${ordinal + 1}TreeExact`, commit.tree === prepared.new_tree, `generation_${ordinal + 1}_tree_mismatch`);
    check(`generation${ordinal + 1}CommitProtocol`, commit.author === expectedIdentity && commit.committer === expectedIdentity && commit.message === exact.deterministicDrainCommitMessage(manifestRoot), `generation_${ordinal + 1}_commit_protocol_mismatch`);
    check(`generation${ordinal + 1}ManifestExact`, manifestRoot === prepared.cohort_manifest_root, `generation_${ordinal + 1}_manifest_mismatch`);
    check(`generation${ordinal + 1}EntriesCanonicalSortedUnique`, entryPaths.length > 0 && entryPaths.every(l1.isCanonicalCohortPath) && sameArray(entryPaths, [...entryPaths].sort(compare)) && new Set(entryPaths).size === entryPaths.length, `generation_${ordinal + 1}_entries_invalid`);
    check(`generation${ordinal + 1}LegacyExcluded`, !entryPaths.includes(LEGACY_PATH), `generation_${ordinal + 1}_legacy_1750_mixed`);
    const snapshotKeys = Object.keys(record(prepared.frozen_index_snapshot) ?? {}).sort(compare);
    check(`generation${ordinal + 1}FrozenIndexSnapshotExact`, sameArray(snapshotKeys, [...entryPaths].sort(compare)), `generation_${ordinal + 1}_frozen_index_snapshot_mismatch`);

    const diff = parseDiff(gitBuffer(abrain, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", parent, oid]));
    check(`generation${ordinal + 1}PreparedEqualsDiff`, diff.length === entries.length && entries.every((entry, index) => diff[index]?.path === entry.path), `generation_${ordinal + 1}_prepared_diff_mismatch`);
    const tree = parseTree(gitBuffer(abrain, ["ls-tree", "-r", "-z", oid, "--", ...entryPaths]));
    let entryBytesExact = true;
    for (const entry of entries) {
      const row = diff.find((item) => item.path === entry.path);
      const treeEntry = tree.get(entry.path);
      if (entry.op === "delete") entryBytesExact &&= row?.status === "D" && !treeEntry;
      else {
        const blob = gitBuffer(abrain, ["cat-file", "blob", entry.blobOid]);
        entryBytesExact &&= treeEntry?.mode === entry.mode && treeEntry?.oid === entry.blobOid && row?.newMode === entry.mode && row?.newOid === entry.blobOid && sha256(blob) === entry.bytesSha256;
      }
    }
    check(`generation${ordinal + 1}TreeBlobBytesExact`, entryBytesExact, `generation_${ordinal + 1}_tree_blob_bytes_mismatch`);
    const converged = episodeRecords.find((item) => item.body.event_type === "index_converged");
    check(`generation${ordinal + 1}SharedIndexConvergenceEvent`, converged?.body.body?.candidate === oid, `generation_${ordinal + 1}_index_convergence_event_mismatch`);

    const directKnowledge = diff
      .filter((item) => item.status === "A" && item.path.startsWith("l1/events/sha256/"))
      .map((item) => recordsById.get(path.basename(item.path, ".json")))
      .filter((item) => item?.registration.envelope_schema === "knowledge-evidence-envelope/v1");
    chainFacts.push({
      ordinal: ordinal + 1,
      candidate: oid,
      parent,
      tree: commit.tree,
      episodeId,
      generationAnchor,
      slot: preparedRecord.body.slot,
      cohortManifestRoot: manifestRoot,
      entryCount: entries.length,
      recoveryEventIds: eventIds,
      directKnowledgeSources: directKnowledge.map((item) => ({ eventId: item.eventId, sourceRef: sourceRefOf(item) })),
    });
    const closureId = converged?.eventId;
    if (closureId) generationAnchor = closureId;
  }

  const replay1 = chainFacts.find((item) => item.candidate === REPLAY_1);
  const replay2 = chainFacts.find((item) => item.candidate === REPLAY_2);
  check("replay781RejectedDisposition", replay1?.directKnowledgeSources.length === 1 && replay1.directKnowledgeSources.every((item) => String(item.sourceRef).startsWith("sediment:replay:")), "replay_781_not_replay_only");
  check("replay916RejectedDisposition", replay2?.directKnowledgeSources.length === 1 && replay2.directKnowledgeSources.every((item) => String(item.sourceRef).startsWith("sediment:replay:")), "replay_916_not_replay_only");
  const postBaselineBeforeCandidate = chainFacts.filter((item) => item.candidate !== BASELINE && item.candidate !== CANDIDATE);
  check("noEarlierEligibleAutoWriteGeneration", postBaselineBeforeCandidate.every((item) => item.directKnowledgeSources.every((source) => !String(source.sourceRef).startsWith("sediment:auto_write:"))), "earlier_auto_write_generation_present");

  sourceRecord = recordsById.get(sourceEventId) ?? null;
  sourceBody = sourceRecord?.body ?? null;
  sourceTimestamp = sourceBody?.created_at_utc ?? null;
  const sourcePath = l1.expectedL1EventRelativePath(sourceEventId);
  const candidateDiff = parseDiff(gitBuffer(abrain, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", `${candidate}^`, candidate]));
  const candidatePrepared = activeV2.find((item) => item.body.event_type === "commit_prepared" && item.body.body?.candidate === candidate)?.body.body;
  check("sourceEventPresentAndStrictValidated", Boolean(sourceRecord), "source_event_not_in_current_whole_l1");
  check("sourceEventSchemaExact", sourceRecord?.registration.envelope_schema === "knowledge-evidence-envelope/v1" && sourceBody?.event_schema_version === "knowledge-evidence-event/v1" && sourceBody?.event_type === "knowledge_entry_observed", "source_event_schema_mismatch");
  check("sourceEventProducerExact", sourceBody?.producer?.name === "sediment.knowledge-event-writer" && sourceBody?.producer?.version === "adr0039-p5", "source_event_producer_mismatch");
  check("sourceEventTimestampExactIso", typeof sourceTimestamp === "string" && new Date(sourceTimestamp).toISOString() === sourceTimestamp, "source_event_timestamp_invalid");
  check("sourceEventSessionBound", typeof sourceBody?.session_id === "string" && /^[0-9a-f-]{36}$/.test(sourceBody.session_id), "source_event_session_invalid");
  check("sourceEventSourceRefAutoWrite", typeof sourceBody?.source?.source_ref === "string" && sourceBody.source.source_ref.startsWith("sediment:auto_write:"), "source_ref_not_auto_write");
  check("sourceEventDirectCandidateAddition", candidateDiff.some((item) => item.path === sourcePath && item.status === "A"), "source_event_not_direct_candidate_addition");
  check("sourceEventBoundToCandidatePrepared", candidatePrepared?.entries?.some((item) => item.path === sourcePath && item.bytesSha256 === sha256(readCommitPath(abrain, candidate, sourcePath))), "source_event_not_bound_to_candidate_prepared");
  const candidateSources = chainFacts.find((item) => item.candidate === candidate)?.directKnowledgeSources ?? [];
  check("candidateFirstQualifiedRealAutoWriteDrain", candidateSources.length === 1 && candidateSources[0]?.eventId === sourceEventId && String(candidateSources[0]?.sourceRef).startsWith("sediment:auto_write:"), "candidate_not_first_qualified_auto_write_drain");

  const candidatePaths = new Set(gitBuffer(abrain, ["ls-tree", "-r", "-z", "--name-only", candidate, "--", "l1/events/sha256"]).toString("utf8").split("\0").filter(Boolean));
  const candidateKnowledgeRecords = scan.selected.filter((item) => item.registration.envelope_schema === "knowledge-evidence-envelope/v1" && candidatePaths.has(item.relativePath));
  const candidateKnowledgeNodes = candidateKnowledgeRecords.map((item) => ({ eventId: item.eventId, body: item.body }));
  const sourceIdentity = knowledge.knowledgeIdentityKey(sourceBody);
  const identityNodes = candidateKnowledgeNodes.filter((item) => knowledge.knowledgeIdentityKey(item.body) === sourceIdentity);
  const renderedProjection = knowledge.renderKnowledgeProjectionFromSet(identityNodes);
  const renderedManifest = knowledge.renderKnowledgeProjectionManifestFromSet(candidateKnowledgeNodes);
  const l2Bytes = readCommitPath(abrain, candidate, sourceL2Path);
  const l2Markdown = l2Bytes.toString("utf8");
  const manifestBytes = readCommitPath(abrain, candidate, KNOWLEDGE_MANIFEST);
  const reportedOutputHash = frontmatterScalar(l2Markdown, "sediment_output_hash");
  const recomputedOutputHash = knowledge.knowledgeProjectionOutputHashFromMarkdownBytes(l2Markdown);
  check("sourceL2PathDirectCandidateDelta", candidateDiff.some((item) => item.path === sourceL2Path && ["A", "M"].includes(item.status)), "source_l2_not_candidate_delta");
  check("sourceL2ExactFoldBytes", renderedProjection.kind === "entry" && renderedProjection.markdown === l2Markdown, "source_l2_fold_mismatch");
  check("sourceL2WatermarkExact", renderedProjection.winnerEventId === sourceEventId && frontmatterScalar(l2Markdown, "sediment_watermark_event_id") === sourceEventId && frontmatterScalar(l2Markdown, "sediment_event_id") === sourceEventId, "source_l2_watermark_mismatch");
  check("sourceL2EventSetExact", frontmatterScalar(l2Markdown, "sediment_input_event_set_hash") === renderedProjection.inputEventSetHash, "source_l2_event_set_mismatch");
  check("sourceL2OutputHashExact", reportedOutputHash === recomputedOutputHash, "source_l2_output_hash_mismatch");
  check("candidateKnowledgeManifestExact", manifestBytes.equals(Buffer.from(renderedManifest.json, "utf8")) && renderedManifest.winnerEventId === sourceEventId, "candidate_knowledge_manifest_mismatch");
  check("sourceL2BoundToCandidatePrepared", candidatePrepared?.entries?.some((item) => item.path === sourceL2Path && item.bytesSha256 === sha256(l2Bytes)), "source_l2_not_bound_to_candidate_prepared");
  check("manifestBoundToCandidatePrepared", candidatePrepared?.entries?.some((item) => item.path === KNOWLEDGE_MANIFEST && item.bytesSha256 === sha256(manifestBytes)), "knowledge_manifest_not_bound_to_candidate_prepared");
  projectionFacts = {
    identity: sourceIdentity,
    outputPath: sourceL2Path,
    outputBytesSha256: sha256(l2Bytes),
    outputHash: recomputedOutputHash ?? null,
    watermarkEventId: renderedProjection.winnerEventId,
    inputEventSetHash: renderedProjection.inputEventSetHash,
    identityEventCount: identityNodes.length,
    manifestPath: KNOWLEDGE_MANIFEST,
    manifestBytesSha256: sha256(manifestBytes),
    manifestWinnerEventId: renderedManifest.winnerEventId,
    candidateKnowledgeEventCount: candidateKnowledgeNodes.length,
  };

  currentStatus = parser.parseGitStatusPorcelainV1Z(gitBuffer(abrain, ["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"])).map((row) => ({ status: row.status, path: row.path }));
  const activeV2Paths = new Set(activeV2.map((item) => item.relativePath));
  const allowedUntracked = new Set([LEGACY_PATH, ...activeV2Paths]);
  check("currentSharedIndexEqualsHead", gitOk(abrain, ["diff-index", "--cached", "--quiet", currentHead, "--"]) && gitText(abrain, ["ls-files", "-u"]) === "", "current_shared_index_drift");
  check("currentTrackedWorktreeClean", gitOk(abrain, ["diff-files", "--quiet", "--"]), "current_tracked_worktree_drift");
  check("currentUntrackedOnlyValidatedRecoveryOrLegacy", currentStatus.every((row) => row.status === "??" && allowedUntracked.has(row.path)), "current_untracked_active_backlog_or_foreign_path");
  const legacy = scan.legacyReadOnly.find((item) => item.eventId === LEGACY_ID);
  check("legacy1750StrictValidUntracked", Boolean(legacy) && legacy.relativePath === LEGACY_PATH && legacy.registration.phase === "legacy_read_only" && legacy.registration.write_enabled === false && legacy.registration.fold_eligible === false && currentStatus.some((row) => row.path === LEGACY_PATH && row.status === "??"), "legacy_1750_invalid_or_not_untracked");
  check("legacy1750ExcludedFromEveryAcceptanceCohort", chainFacts.every((item) => {
    const prepared = activeV2.find((record) => record.body.event_type === "commit_prepared" && record.body.body?.candidate === item.candidate)?.body.body;
    return prepared && !prepared.entries.some((entry) => entry.path === LEGACY_PATH);
  }), "legacy_1750_mixed_into_acceptance_chain");

  const registryPath = path.join(root, "schemas/l1-schema-role-registry.json");
  const recoveryPath = path.join(root, "extensions/_shared/convergence-recovery.ts");
  const registrySourcePath = path.join(root, "extensions/_shared/l1-schema-registry.ts");
  const runtimePath = path.join(root, "extensions/_shared/canonical-git-runtime.ts");
  const curatorPath = path.join(root, "extensions/sediment/curator.ts");
  const curatorWriterPath = path.join(root, "extensions/sediment/curator-decision-writer.ts");
  const registryBytes = fs.readFileSync(registryPath);
  const registry = l1.loadL1SchemaRegistry(registryPath);
  const activeRegistration = registry.entries.find((item) => item.envelope_schema === "local-drain-recovery-envelope/v2");
  const recoverySource = fs.readFileSync(recoveryPath, "utf8");
  const registrySource = fs.readFileSync(registrySourcePath, "utf8");
  const runtimeSource = fs.readFileSync(runtimePath, "utf8");
  const curatorSource = fs.readFileSync(curatorPath, "utf8");
  const curatorWriterSource = fs.readFileSync(curatorWriterPath, "utf8");
  const phaseDisabledCuratorSchemas = registry.entries.filter((item) => item.envelope_schema.startsWith("knowledge-") && ["knowledge-candidate-observation/v1", "knowledge-curator-attempt/v1", "knowledge-curator-decision/v1", "knowledge-apply-receipt/v1"].includes(item.envelope_schema));
  check("curatorActiveV2RegistrationDrainOnly", activeRegistration?.phase === "active" && activeRegistration.domain === "canonical_path" && activeRegistration.role === "meta" && activeRegistration.write_enabled === true && activeRegistration.fold_eligible === false && sameArray([...activeRegistration.event_types], ACTIVE_V2_TYPES), "curator_active_v2_registration_not_drain_only");
  check("curatorAbsentFromActiveV2ProducerCallerWriter", activeRegistration?.producers?.length === 1 && activeRegistration.producers[0] === "pi-astack.convergence-recovery" && !JSON.stringify(activeRegistration).toLowerCase().includes("curator"), "curator_present_in_active_v2_registration");
  check("activeV2RuntimeLaneTypeDrainOnly", recoverySource.includes('export const RECOVERY_LANE_BUDGETS = Object.freeze({ drain: 5 } as const)') && recoverySource.includes('export type RecoveryLane = "drain"') && registrySource.includes('version === 2 ? lane !== "drain"'), "active_v2_runtime_lane_not_drain_only");
  check("canonicalRuntimeHasNoCuratorProtocolCaller", !runtimeSource.toLowerCase().includes("curator"), "canonical_runtime_curator_caller_present");
  check("curatorHasNoActiveV2ProtocolWiring", !curatorSource.includes("local-drain-recovery") && !curatorSource.includes("convergence-recovery") && !curatorWriterSource.includes("local-drain-recovery") && !curatorWriterSource.includes("convergence-recovery") && !curatorWriterSource.includes("appendRecoveryEvent"), "curator_active_v2_protocol_wiring_present");
  check("curatorReadOnlyNeighborLogicRetained", curatorSource.includes("relevantEntriesForCurator") && curatorSource.includes("READ-ONLY reference"), "curator_read_only_neighbor_logic_missing");
  check("curatorCanonicalMetaSchemasRemainPhaseDisabled", phaseDisabledCuratorSchemas.length === 4 && phaseDisabledCuratorSchemas.every((item) => item.phase === "phase_disabled" && item.write_enabled === false && item.fold_eligible === false && item.role === "meta"), "curator_meta_schema_phase_changed");
  const dossierSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  check("curatorCriterionIndependentOfStagingCounts", !/^import .*staging-loader/m.test(dossierSource), "curator_isolation_uses_staging_count");
  curatorFacts = {
    activeV2Registration: {
      envelopeSchema: activeRegistration?.envelope_schema ?? null,
      bodySchema: activeRegistration?.body_schema ?? null,
      phase: activeRegistration?.phase ?? null,
      eventTypes: activeRegistration?.event_types ?? null,
      producers: activeRegistration?.producers ?? null,
    },
    productionActiveV2EventCount: activeV2.length,
    productionLanes: [...new Set(activeV2.map((item) => item.body.lane))].sort(compare),
    productionProducers: [...new Set(activeV2.map((item) => `${item.body.producer?.name}@${item.body.producer?.version}`))].sort(compare),
    phaseDisabledCuratorSchemas: phaseDisabledCuratorSchemas.map((item) => item.envelope_schema).sort(compare),
    sourceSha256: {
      registry: sha256(registryBytes),
      l1SchemaRegistry: sha256(Buffer.from(registrySource)),
      convergenceRecovery: sha256(Buffer.from(recoverySource)),
      canonicalGitRuntime: sha256(Buffer.from(runtimeSource)),
      curator: sha256(Buffer.from(curatorSource)),
      curatorDecisionWriter: sha256(Buffer.from(curatorWriterSource)),
    },
    stagingCountsObserved: false,
    stagingCountsAreCriterion: false,
  };
} catch (error) {
  errors.push(`verification_exception:${error?.code ?? error?.message ?? String(error)}`);
  if (!("currentWholeL1Strict" in checks)) checks.currentWholeL1Strict = false;
}

const uniqueErrors = [...new Set(errors)].sort(compare);
const artifact = {
  schemaVersion: "production-local-drain-next-curator-isolation-dossier/v1",
  status: uniqueErrors.length === 0 && Object.values(checks).every(Boolean) ? "pass" : "fail",
  factTimeUtc: sourceTimestamp,
  mutationAttempted: false,
  scope: {
    acceptedCriteria: ["LOCAL-DRAIN-NEXT", "CURATOR-PENDING"],
    acceptanceMeaning: "first qualified real sediment:auto_write drain after the first production drain; curator isolation remains pending-by-design",
    exclusions: ["LOCAL-RUNTIME-RESTART", "P1-CLOSE-GATE", "P2", "P3"],
    devicePushCanonicalGate: false,
  },
  inputs: { baseline, candidate, sourceEventId, sourceL2Path },
  rejectedAcceptanceAnchors: [
    { candidate: REPLAY_1, disposition: "rejected", reason: "direct Knowledge source_ref is sediment:replay:*" },
    { candidate: REPLAY_2, disposition: "rejected", reason: "direct Knowledge source_ref is sediment:replay:*" },
  ],
  sourceEvent: sourceBody ? {
    eventId: sourceEventId,
    relativePath: l1.expectedL1EventRelativePath(sourceEventId),
    envelopeSchema: sourceRecord?.registration.envelope_schema ?? null,
    bodySchema: sourceBody.event_schema_version ?? null,
    eventType: sourceBody.event_type ?? null,
    producer: sourceBody.producer ?? null,
    createdAtUtc: sourceBody.created_at_utc ?? null,
    sessionId: sourceBody.session_id ?? null,
    turnId: sourceBody.turn_id ?? null,
    sourceRef: sourceBody.source?.source_ref ?? null,
    candidateId: sourceBody.source?.candidate_id ?? null,
  } : null,
  generationChain: chainFacts,
  projection: projectionFacts,
  currentRepository: {
    head: currentHead,
    ref: currentRef,
    candidateContained: checks.candidateContainedByCurrentHead ?? false,
    wholeL1,
    status: currentStatus,
    rollingRecovery: scan ? (() => {
      const state = recovery.recoverOpenRecoveryEpisodesFromScan(scan);
      return { open: state.open.length, terminal: state.terminal.length, quarantined: state.quarantined.length };
    })() : null,
  },
  curatorIsolation: curatorFacts,
  devicePushObservation: (() => { try { return pushObservation(abrain, candidate); } catch { return { canonicalGate: false, source: "local_tracking_ref_only_no_network", observed: false, trackingOid: null, containsCandidate: null }; } })(),
  verification: checks,
  errors: uniqueErrors,
};
const dossierSelfHash = sha256(Buffer.from(canonicalizeJcs(artifact)));
const report = { ...artifact, dossierSelfHash, dossierSelfHashRule: "sha256(RFC8785-JCS(report_without_dossierSelfHash_and_rule))" };
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
const reportExactSha256 = sha256(reportBytes);
const manifest = {
  schemaVersion: "production-local-drain-next-curator-isolation-evidence-manifest/v1",
  scope: report.scope,
  report: { file: path.basename(output), exactBytesSha256: reportExactSha256, exactBytes: reportBytes.length, dossierSelfHash, status: report.status },
  acceptanceAnchors: { baseline: BASELINE, candidate: CANDIDATE, sourceEventId: SOURCE_EVENT },
  rejectedAcceptanceAnchors: report.rejectedAcceptanceAnchors,
  generationCandidates: report.generationChain.map((item) => item.candidate),
  allVerificationBooleans: report.verification,
  curatorIsolation: report.curatorIsolation,
  immutabilityAnchor: "Commit this report and manifest in pi-astack; the manifest intentionally claims no intrinsic digest.",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(path.dirname(manifestOutput), { recursive: true });
fs.writeFileSync(output, reportBytes);
fs.writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: report.status, report: output, reportExactSha256, manifest: manifestOutput, dossierSelfHash, errors: uniqueErrors })}\n`);
process.exitCode = report.status === "pass" ? 0 : 1;
