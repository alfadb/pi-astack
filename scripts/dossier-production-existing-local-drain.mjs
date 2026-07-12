#!/usr/bin/env node
/** Read-only verifier for an already-published production local v2 drain. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const parser = jiti(path.join(root, "extensions/_shared/git-z-parser.ts"));

const SHA256_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40,64}$/;
const LEGACY_ID = "1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a";
const LEGACY_PATH = l1.expectedL1EventRelativePath(LEGACY_ID);
const EXPECTED_PREFLIGHT_SCHEMA = "canonical-git-runtime-p1a-local-dossier/v5";
const EXPECTED_OWNER_COUNTS = Object.freeze({ knowledge_l1: 28, knowledge_l2: 18 });
const TOP_KEYS = ["schemaVersion", "generatedAtUtc", "durationMs", "mode", "status", "mutationAttempted", "stopReason", "blockers", "abrainHome", "settings", "loadedProvenance", "implementationFingerprint", "provenanceError", "localPreflight", "preFreeze", "ownershipPreflight", "ownershipEvidenceErrors", "before", "after", "afterFreezeSecond", "boundedRecoveryTail", "curatorAdapter", "execution"];
const SETTINGS_KEYS = ["enabled", "mode", "valid", "reason", "settingsPath"];
const LOCAL_CHECK_KEYS = ["runtimeModeLocalConvergenceV2", "wholeL1Strict", "ownershipAccepted", "statusFreeze", "ownershipFreeze", "legacyResidueFreeze", "headFreeze", "indexFreeze", "recoveryReadable", "ownerInterventionFree", "publicationBoundaryLocalRefCas"];
const FREEZE_KEYS = ["statusStable", "ownershipStable", "legacyResidueStable", "headStable", "indexStable", "cohortStable", "firstStatusSha256", "secondStatusSha256", "firstOwnershipSha256", "secondOwnershipSha256", "firstLegacyResidueSha256", "secondLegacyResidueSha256", "firstCohortSha256", "secondCohortSha256"];
const OWNERSHIP_KEYS = ["status", "dirtyCount", "instrumentation", "ownerProofs", "blockedPaths", "legacyResidue"];
const OWNER_KEYS = ["path", "status", "owner", "op", "bytes", "bytesSha256", "sourceIds", "proof"];
const BEFORE_KEYS = ["capturedAtUtc", "head", "ref", "rawIndex", "lock", "status", "pathEvidence", "readHashes", "recovery"];
const STATUS_RECORD_KEYS = ["status", "x", "y", "path", "sourcePath", "paths"];
const LEGACY_KEYS = ["path", "status", "eventId", "envelopeSchema", "bodySchema", "eventType", "phase"];

function arg(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function exactKeys(value, keys) {
  const obj = record(value);
  if (!obj) return false;
  const actual = Object.keys(obj).sort(compare);
  const expected = [...keys].sort(compare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== "..");
}
function sanitizedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  return { ...env, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
function gitBuffer(repo, args, allowFailure = false) {
  try {
    return execFileSync("git", ["-C", repo, "--literal-pathspecs", ...args], { env: sanitizedEnv(), encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}
function gitText(repo, args, allowFailure = false) {
  const out = gitBuffer(repo, args, allowFailure);
  return out === null ? null : out.toString("utf8").trim();
}
function readObject(repo, oid, type = "blob") { return gitBuffer(repo, ["cat-file", type, oid]); }
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
function parseIndex(raw) {
  const result = new Map();
  for (const row of raw.toString("utf8").split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const parts = row.slice(0, tab).split(/\s+/);
    if (tab < 0 || parts.length !== 3 || parts[2] !== "0") throw new Error("unparseable/non-stage-zero index output");
    result.set(row.slice(tab + 1), { mode: parts[0], oid: parts[1], stage: parts[2] });
  }
  return result;
}
function commitFacts(repo, candidate) {
  const raw = readObject(repo, candidate, "commit").toString("utf8");
  const split = raw.indexOf("\n\n");
  if (split < 0) throw new Error("candidate commit has no message separator");
  const headers = raw.slice(0, split).split("\n");
  const tree = headers.find((line) => line.startsWith("tree "))?.slice(5) ?? null;
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  const author = headers.find((line) => line.startsWith("author "))?.slice(7) ?? null;
  const committer = headers.find((line) => line.startsWith("committer "))?.slice(10) ?? null;
  return { tree, parents, author, committer, message: raw.slice(split + 2).replace(/\n$/, "") };
}
function shapeErrors(preflight) {
  const errors = [];
  const need = (condition, code) => { if (!condition) errors.push(code); };
  need(exactKeys(preflight, TOP_KEYS), "preflight_top_shape");
  need(exactKeys(preflight?.settings, SETTINGS_KEYS), "preflight_settings_shape");
  need(exactKeys(preflight?.localPreflight, ["status", "checks"]), "preflight_local_shape");
  need(exactKeys(preflight?.localPreflight?.checks, LOCAL_CHECK_KEYS), "preflight_checks_shape");
  need(exactKeys(preflight?.preFreeze, FREEZE_KEYS), "preflight_freeze_shape");
  need(exactKeys(preflight?.ownershipPreflight, OWNERSHIP_KEYS), "preflight_ownership_shape");
  need(exactKeys(preflight?.before, BEFORE_KEYS), "preflight_before_shape");
  need(exactKeys(preflight?.before?.rawIndex, ["path", "bytesSha256"]), "preflight_index_shape");
  need(exactKeys(preflight?.before?.lock, ["exists", "path", "kind", "bytes", "sha256"]), "preflight_lock_shape");
  need(exactKeys(preflight?.before?.status, ["bytes", "sha256", "records"]), "preflight_status_shape");
  need(exactKeys(preflight?.before?.readHashes, ["knowledgeManifest", "constraintL2", "registry"]), "preflight_read_hash_shape");
  need(exactKeys(preflight?.before?.recovery, ["open", "terminal", "quarantined"]), "preflight_recovery_shape");
  for (const row of preflight?.before?.status?.records ?? []) need(exactKeys(row, STATUS_RECORD_KEYS), "preflight_status_record_shape");
  for (const proof of preflight?.ownershipPreflight?.ownerProofs ?? []) {
    need(exactKeys(proof, OWNER_KEYS), "preflight_owner_proof_shape");
    if (proof?.proof?.kind === "l1_registry_validation") {
      need(exactKeys(proof.proof, ["kind", "registryId", "envelopeSchema", "bodySchema", "eventType", "producer", "registration", "eventId", "exactBytesSha256"]), "preflight_l1_proof_shape");
      need(exactKeys(proof.proof?.producer, ["name", "version"]), "preflight_l1_producer_shape");
      need(exactKeys(proof.proof?.registration, ["domain", "role", "phase", "foldEligible", "producers"]), "preflight_l1_registration_shape");
    } else if (proof?.proof?.kind === "l2_exact_recompute") {
      need(exactKeys(proof.proof, ["kind", "renderer", "operation", "exactBytesSha256", "recomputedSourceEventIds", "exactByteEqualAccepted"]), "preflight_l2_proof_shape");
    } else need(false, "preflight_owner_proof_kind");
  }
  for (const residue of preflight?.ownershipPreflight?.legacyResidue ?? []) need(exactKeys(residue, LEGACY_KEYS), "preflight_legacy_shape");
  for (const evidence of Object.values(preflight?.before?.pathEvidence ?? {})) need(exactKeys(evidence, ["worktreeSha256", "indexEntrySha256"]), "preflight_path_evidence_shape");
  return [...new Set(errors)].sort(compare);
}
function pushObservation(repo, candidate) {
  const upstream = gitText(repo, ["rev-parse", "--verify", "@{upstream}^{commit}"], true);
  let containsCandidate = null;
  if (upstream) containsCandidate = gitBuffer(repo, ["merge-base", "--is-ancestor", candidate, upstream], true) !== null;
  return { canonicalGate: false, source: "local_tracking_ref_only_no_network", observed: upstream !== null, trackingOid: upstream, containsCandidate };
}

const abrainArg = arg("abrain");
const candidate = arg("candidate");
const preflightArg = arg("preflight");
const expectedPreflightSha = arg("preflight-sha256");
const outputArg = arg("output");
if (!abrainArg || !candidate || !preflightArg || !expectedPreflightSha || !outputArg) throw new Error("required: --abrain --candidate --preflight --preflight-sha256 --output");
if (!OID_RE.test(candidate)) throw new Error("--candidate must be a lowercase Git OID");
if (!SHA256_RE.test(expectedPreflightSha)) throw new Error("--preflight-sha256 must be lowercase SHA-256");
const abrain = path.resolve(abrainArg);
const preflightPath = path.resolve(preflightArg);
const output = path.resolve(outputArg);
const manifestOutput = path.resolve(arg("manifest", output.replace(/\.json$/i, "-manifest.json")));
if (inside(abrain, output) || inside(abrain, manifestOutput)) throw new Error("output and manifest must be outside --abrain");

const errors = [];
const checks = {};
const check = (name, condition, detail = name) => {
  checks[name] = Boolean(condition);
  if (!condition) errors.push(detail);
};
let preflightBytes;
let preflight;
let scan;
let preparedRecord;
let episodeEvents = [];
let prepared;
let eventIds = {};
let commit = null;
let diff = [];
let tree = new Map();
let index = new Map();
let postStatus = [];
let parent = null;
let candidateTree = null;
let reportFactTime = null;

try {
  preflightBytes = fs.readFileSync(preflightPath);
  preflight = JSON.parse(preflightBytes.toString("utf8"));
  check("preflightArtifactSha256Exact", sha256(preflightBytes) === expectedPreflightSha, "preflight_artifact_sha256_mismatch");
  const shapes = shapeErrors(preflight);
  check("preflightV5ExactShape", shapes.length === 0, shapes.join(",") || "preflight_shape_invalid");
  check("preflightV5Schema", preflight.schemaVersion === EXPECTED_PREFLIGHT_SCHEMA, "preflight_schema_mismatch");
  check("preflightReadOnlyNoMutation", preflight.mode === "preflight_read_only" && preflight.mutationAttempted === false && preflight.after === null && preflight.afterFreezeSecond === null && preflight.execution === null && Array.isArray(preflight.boundedRecoveryTail) && preflight.boundedRecoveryTail.length === 0, "preflight_mutation_or_execution_present");
  check("preflightExpectedBlockers", JSON.stringify(preflight.blockers) === JSON.stringify(["kill_switch_disabled", "execute_not_requested"]) && preflight.status === "preflight-blocked" && preflight.stopReason === "kill_switch_disabled", "preflight_blockers_mismatch");
  check("preflightModeValidButDisabled", preflight.settings?.enabled === false && preflight.settings?.valid === true && preflight.settings?.mode === "local_convergence_v2", "preflight_runtime_mode_mismatch");
  check("preflightLocalChecksAllGreen", preflight.localPreflight?.status === "ready" && LOCAL_CHECK_KEYS.every((key) => preflight.localPreflight.checks[key] === true), "preflight_local_checks_not_green");
  const freeze = preflight.preFreeze ?? {};
  check("preflightDoubleFreeze", ["statusStable", "ownershipStable", "legacyResidueStable", "headStable", "indexStable", "cohortStable"].every((key) => freeze[key] === true)
    && freeze.firstStatusSha256 === freeze.secondStatusSha256
    && freeze.firstOwnershipSha256 === freeze.secondOwnershipSha256
    && freeze.firstLegacyResidueSha256 === freeze.secondLegacyResidueSha256
    && freeze.firstCohortSha256 === freeze.secondCohortSha256, "preflight_double_freeze_failed");
  const owners = preflight.ownershipPreflight?.ownerProofs ?? [];
  const ownerCounts = Object.fromEntries(Object.keys(EXPECTED_OWNER_COUNTS).map((owner) => [owner, owners.filter((item) => item.owner === owner).length]));
  check("preflight46ActiveOwnerProofs", owners.length === 46 && Object.entries(EXPECTED_OWNER_COUNTS).every(([owner, count]) => ownerCounts[owner] === count), "preflight_owner_count_mismatch");
  check("preflightZeroBlocked", preflight.ownershipPreflight?.status === "accepted" && preflight.ownershipPreflight?.blockedPaths?.length === 0 && preflight.ownershipEvidenceErrors?.length === 0, "preflight_ownership_blocked");
  const residues = preflight.ownershipPreflight?.legacyResidue ?? [];
  check("preflightOneLegacyResidue", residues.length === 1 && residues[0].path === LEGACY_PATH && residues[0].eventId === LEGACY_ID && residues[0].status === "??" && residues[0].envelopeSchema === "drain-recovery-envelope/v1" && residues[0].bodySchema === "drain-recovery-event/v1" && residues[0].eventType === "push_terminal_resolution_candidate" && residues[0].phase === "legacy_read_only", "preflight_legacy_residue_mismatch");
  check("preflightParentAndRef", preflight.before?.head && preflight.before?.ref === "refs/heads/main" && preflight.before?.recovery?.open?.length === 0 && preflight.before?.recovery?.terminal?.length === 0 && preflight.before?.recovery?.quarantined?.length === 0, "preflight_parent_or_recovery_mismatch");

  scan = await l1.scanWholeL1Validated({ abrainHome: abrain });
  check("wholeL1Strict", true);
  preparedRecord = scan.selected.find((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2" && item.body.event_type === "commit_prepared" && item.body.body?.candidate === candidate);
  check("candidateHasSinglePreparedEvent", Boolean(preparedRecord) && scan.selected.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2" && item.body.event_type === "commit_prepared" && item.body.body?.candidate === candidate).length === 1, "prepared_event_missing_or_ambiguous");
  if (!preparedRecord) throw new Error("prepared event unavailable");
  const episodeId = preparedRecord.body.episode_id;
  const slot = preparedRecord.body.slot;
  const episodeRecords = scan.selected.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2" && item.body.episode_id === episodeId);
  episodeEvents = episodeRecords.map((item) => item.body);
  eventIds = Object.fromEntries(episodeRecords.map((item) => [item.body.event_type, item.eventId]));
  prepared = preparedRecord.body.body;
  const folded = recovery.foldRecoveryEvents(episodeEvents);
  const cursor = recovery.recoveryEpisodeCursor(episodeId, "drain", episodeEvents);
  const foldedSlot = folded.get(slot);
  check("recoverySameEpisodeSlotOne", slot === 1 && episodeRecords.length === 4 && episodeRecords.every((item) => item.body.slot === 1 && item.body.lane === "drain"), "recovery_episode_slot_mismatch");
  check("recoveryExactFourEvents", ["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged"].every((type) => episodeRecords.filter((item) => item.body.event_type === type).length === 1), "recovery_event_set_mismatch");
  check("recoveryClaimDeterministic", foldedSlot?.claimId === recovery.recoveryClaimId(episodeId, "drain", 1), "recovery_claim_id_mismatch");
  check("recoveryFoldComplete", cursor.complete === true && cursor.terminal === false && cursor.pendingSlot === null && cursor.nextSlot === null && foldedSlot?.published?.body.candidate === candidate && foldedSlot?.published?.body.publication_confirmed === true && foldedSlot?.converged?.body.candidate === candidate, "recovery_fold_incomplete");
  const recovered = recovery.recoverOpenRecoveryEpisodesFromScan(scan);
  check("recoveryGloballyClosed", recovered.open.length === 0 && recovered.terminal.length === 0 && recovered.quarantined.length === 0, "recovery_global_state_not_closed");

  commit = commitFacts(abrain, candidate);
  parent = prepared.frozen_commit;
  candidateTree = prepared.new_tree;
  const parentEpoch = gitText(abrain, ["show", "-s", "--format=%ct", parent]);
  const expectedIdentity = `pi-astack-local-drain <local-drain@pi-astack.invalid> ${parentEpoch} +0000`;
  const manifestRoot = exact.cohortManifestRoot(prepared.entries);
  check("candidateParentExact", commit.parents.length === 1 && commit.parents[0] === parent && parent === preflight.before.head, "candidate_parent_mismatch");
  check("candidateTreeExact", commit.tree === candidateTree, "candidate_tree_mismatch");
  check("candidateCommitProtocol", commit.author === expectedIdentity && commit.committer === expectedIdentity && commit.message === exact.deterministicDrainCommitMessage(manifestRoot), "candidate_commit_protocol_mismatch");
  check("candidateManifestExact", manifestRoot === prepared.cohort_manifest_root, "candidate_manifest_mismatch");
  reportFactTime = new Date(Number(parentEpoch) * 1000).toISOString();

  diff = parseDiff(gitBuffer(abrain, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", parent, candidate]));
  const paths = prepared.entries.map((entry) => entry.path);
  const sortedPaths = [...paths].sort(compare);
  check("prepared46CanonicalSortedUniqueEntries", paths.length === 46 && paths.every(l1.isCanonicalCohortPath) && paths.every((item, index) => item === sortedPaths[index]) && new Set(paths).size === paths.length, "prepared_entries_invalid");
  check("preparedComposition28L1And18L2", paths.filter((item) => item.startsWith("l1/events/sha256/")).length === 28 && paths.filter((item) => item.startsWith("l2/views/knowledge/latest/")).length === 18 && paths.every((item) => item.startsWith("l1/events/sha256/") || item.startsWith("l2/views/knowledge/latest/")), "prepared_composition_mismatch");
  check("preparedEqualsCommitDiff", diff.length === paths.length && diff.every((row, index) => row.path === paths[index]), "prepared_commit_diff_mismatch");
  tree = parseTree(gitBuffer(abrain, ["ls-tree", "-r", "-z", candidate, "--", ...paths]));
  index = parseIndex(gitBuffer(abrain, ["ls-files", "-z", "--stage", "--", ...paths]));
  let entriesExact = tree.size === paths.length && index.size === paths.length;
  for (const entry of prepared.entries) {
    const treeEntry = tree.get(entry.path);
    const indexEntry = index.get(entry.path);
    const blob = entry.op === "put" ? readObject(abrain, entry.blobOid) : null;
    const row = diff.find((item) => item.path === entry.path);
    entriesExact &&= entry.op === "put" && treeEntry?.mode === entry.mode && treeEntry?.oid === entry.blobOid && indexEntry?.mode === entry.mode && indexEntry?.oid === entry.blobOid && row?.newMode === entry.mode && row?.newOid === entry.blobOid && sha256(blob) === entry.bytesSha256;
  }
  check("preparedTreeBlobBytesIndexExact", entriesExact, "prepared_tree_blob_bytes_index_mismatch");
  const ownersByPath = new Map(preflight.ownershipPreflight.ownerProofs.map((item) => [item.path, item]));
  check("preflightOwnersBindPreparedEntries", ownersByPath.size === paths.length && prepared.entries.every((entry) => {
    const owner = ownersByPath.get(entry.path);
    return owner?.op === entry.op && owner?.bytesSha256 === entry.bytesSha256 && owner?.proof?.exactBytesSha256 === entry.bytesSha256;
  }), "preflight_owner_prepared_binding_mismatch");
  const frozenKeys = Object.keys(prepared.frozen_index_snapshot ?? {}).sort(compare);
  check("preparedFrozenIndexSnapshotExact", frozenKeys.length === paths.length && frozenKeys.every((item, index) => item === paths[index]), "prepared_frozen_index_snapshot_mismatch");

  const head = gitText(abrain, ["rev-parse", "HEAD^{commit}"]);
  const ref = gitText(abrain, ["symbolic-ref", "-q", "HEAD"]);
  const cachedClean = gitBuffer(abrain, ["diff-index", "--cached", "--quiet", candidate, "--"], true) !== null;
  const trackedClean = gitBuffer(abrain, ["diff-files", "--quiet", "--"], true) !== null;
  const unmerged = gitText(abrain, ["ls-files", "-u"]);
  check("headRefCandidateExact", head === candidate && ref === prepared.symbolic_ref && ref === preflight.before.ref, "head_ref_candidate_mismatch");
  check("sharedIndexExact", cachedClean && unmerged === "", "shared_index_drift");
  check("trackedWorktreeExact", trackedClean, "tracked_worktree_drift");

  postStatus = parser.parseGitStatusPorcelainV1Z(gitBuffer(abrain, ["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"])).map((row) => ({ status: row.status, path: row.path }));
  const episodePaths = new Set(episodeRecords.map((item) => item.relativePath));
  const allowedPaths = new Set([LEGACY_PATH, ...episodePaths]);
  check("postStatusOnlyLegacyAndEpisodeRecovery", postStatus.length === 5 && postStatus.every((row) => row.status === "??" && allowedPaths.has(row.path)) && [...allowedPaths].every((item) => postStatus.some((row) => row.path === item)), "post_status_unexpected");
  check("activeKnowledgeBacklogZero", postStatus.every((row) => row.path === LEGACY_PATH || episodePaths.has(row.path)), "active_knowledge_backlog_nonzero");
  const legacy = scan.legacyReadOnly.find((item) => item.eventId === LEGACY_ID);
  check("legacy1750StrictValidUntracked", Boolean(legacy) && legacy.relativePath === LEGACY_PATH && legacy.registration.phase === "legacy_read_only" && legacy.registration.write_enabled === false && legacy.registration.fold_eligible === false && legacy.body.event_type === "push_terminal_resolution_candidate" && postStatus.some((row) => row.path === LEGACY_PATH && row.status === "??"), "legacy_1750_invalid_or_not_untracked");
  check("legacy1750ExcludedFromCohort", !paths.includes(LEGACY_PATH) && !ownersByPath.has(LEGACY_PATH), "legacy_1750_mixed_into_cohort");
} catch (error) {
  errors.push(`verification_exception:${error?.code ?? error?.message ?? String(error)}`);
  if (!("wholeL1Strict" in checks)) checks.wholeL1Strict = false;
}

const uniqueErrors = [...new Set(errors)].sort(compare);
const artifact = {
  schemaVersion: "production-existing-local-drain-dossier/v1",
  status: uniqueErrors.length === 0 && Object.values(checks).every(Boolean) ? "pass" : "fail",
  factTimeUtc: reportFactTime,
  scope: { criterion: "LOCAL-DRAIN-CURRENT", countsForP1Completion: false, nextGenerationVerified: false, runtimeRestartVerified: false },
  inputs: { preflightArtifact: path.basename(preflightPath), preflightArtifactSha256: preflightBytes ? sha256(preflightBytes) : null, expectedPreflightArtifactSha256: expectedPreflightSha, candidate },
  candidate: commit ? { oid: candidate, parent, tree: candidateTree, cohortManifestRoot: prepared?.cohort_manifest_root ?? null, entryCount: prepared?.entries?.length ?? null, knowledgeL1Count: prepared?.entries?.filter((item) => item.path.startsWith("l1/events/sha256/")).length ?? null, knowledgeL2Count: prepared?.entries?.filter((item) => item.path.startsWith("l2/views/knowledge/latest/")).length ?? null } : null,
  recovery: preparedRecord ? { episodeId: preparedRecord.body.episode_id, slot: preparedRecord.body.slot, eventIds } : null,
  wholeL1: scan ? { all: scan.all.length, selected: scan.selected.length, foldable: scan.foldable.length, legacyReadOnly: scan.legacyReadOnly.length, foreignSkipped: scan.foreignSkipped.length, phaseDisabledShadow: scan.phaseDisabledShadow.length, tempResidue: scan.tempResidue.length } : null,
  postStatus,
  devicePushObservation: (() => { try { return pushObservation(abrain, candidate); } catch { return { canonicalGate: false, source: "local_tracking_ref_only_no_network", observed: false, trackingOid: null, containsCandidate: null }; } })(),
  verification: checks,
  errors: uniqueErrors,
};
const dossierSelfHash = sha256(canonicalizeJcs(artifact));
const report = { ...artifact, dossierSelfHash, dossierSelfHashRule: "sha256(RFC8785-JCS(report_without_dossierSelfHash_and_rule))" };
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
const reportExactSha256 = sha256(reportBytes);
const manifest = {
  schemaVersion: "production-existing-local-drain-evidence-manifest/v1",
  scope: { claim: "LOCAL-DRAIN-CURRENT only", exclusions: ["LOCAL-DRAIN-NEXT", "LOCAL-RUNTIME-RESTART", "CURATOR-PENDING", "P1-CLOSE-GATE"] },
  report: { file: path.basename(output), exactBytesSha256: reportExactSha256, exactBytes: reportBytes.length, dossierSelfHash, status: report.status },
  inputs: report.inputs,
  candidate: report.candidate,
  recovery: report.recovery,
  allVerificationBooleans: report.verification,
  devicePushObservationCanonicalGate: false,
  immutabilityAnchor: "The report and this manifest are intended to be committed in pi-astack; no intrinsic manifest digest is claimed.",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(path.dirname(manifestOutput), { recursive: true });
fs.writeFileSync(output, reportBytes);
fs.writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: report.status, report: output, reportExactSha256, manifest: manifestOutput, dossierSelfHash, errors: uniqueErrors })}\n`);
process.exitCode = report.status === "pass" ? 0 : 1;
