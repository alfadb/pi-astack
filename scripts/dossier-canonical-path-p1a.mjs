#!/usr/bin/env node
/** P1-A canonical production/offline dossier. Default and --preflight are
 * read-only. Mutation requires --execute plus valid enabled settings, no lock,
 * accepted ownership, and every declared blocker cleared. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, moduleCache: false });
const runtimeModule = jiti(path.join(repoRoot, "extensions/_shared/canonical-git-runtime.ts"));
const recovery = jiti(path.join(repoRoot, "extensions/_shared/convergence-recovery.ts"));
const parser = jiti(path.join(repoRoot, "extensions/_shared/git-z-parser.ts"));
const dossierEvidence = jiti(path.join(repoRoot, "extensions/_shared/p1a-dossier-evidence.ts"));
const compareUtf16CodeUnits = dossierEvidence.compareUtf16CodeUnits;
const dossierStartedMs = Date.now();

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  if (!process.argv[at + 1] || process.argv[at + 1].startsWith("--")) throw new Error(`--${name} requires a value`);
  return process.argv[at + 1];
}
function flag(name) { return process.argv.includes(`--${name}`); }
function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function git(repo, args, encoding = "utf8") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: { ...env, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
function gitMaybe(repo, args) { try { return String(git(repo, args)).trim(); } catch { return null; } }
function gitRemoteReadOnly(repo, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: { ...env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
function gitFailureHash(error) {
  const detail = error && typeof error === "object"
    ? `${error.code ?? "unknown"}\n${String(error.stderr ?? error.message ?? error)}`
    : String(error);
  return hash(detail);
}
function remoteAdvertisementSnapshot(abrainHome, configured) {
  if (!configured) return { oid: null, sha256: null, errorSha256: null };
  try {
    const raw = String(gitRemoteReadOnly(abrainHome, ["ls-remote", "--refs", "origin", "refs/heads/main"])).trim();
    const fields = raw.split(/\s+/);
    if (fields.length !== 2 || fields[1] !== "refs/heads/main" || !/^[0-9a-f]{40,64}$/.test(fields[0])) {
      return { oid: null, sha256: null, errorSha256: hash(`REMOTE_ADVERTISEMENT_INVALID\n${raw}`) };
    }
    return { oid: fields[0], sha256: hash(`${raw}\n`), errorSha256: null };
  } catch (error) {
    return { oid: null, sha256: null, errorSha256: gitFailureHash(error) };
  }
}
function readHash(file) { try { return hash(fs.readFileSync(file)); } catch { return null; } }
function lockSnapshot(gitDir) {
  const lockPath = gitDir ? path.join(gitDir, "index.lock") : null;
  if (!lockPath) return { exists: false, path: null, kind: null, bytes: null, sha256: null };
  try {
    const stat = fs.lstatSync(lockPath);
    return {
      exists: true,
      path: lockPath,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      bytes: stat.isFile() ? stat.size : null,
      sha256: stat.isFile() ? readHash(lockPath) : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, path: lockPath, kind: null, bytes: null, sha256: null };
    throw error;
  }
}
const l1RegistryDocument = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), "utf8"));

function ownershipProofDetail(abrainHome, proof) {
  if (proof.path.startsWith("l1/events/sha256/") && proof.op === "put") {
    const envelope = JSON.parse(fs.readFileSync(path.join(abrainHome, ...proof.path.split("/")), "utf8"));
    const body = envelope.body && typeof envelope.body === "object" ? envelope.body : {};
    const registration = l1RegistryDocument.entries.find((entry) => entry.envelope_schema === envelope.schema) ?? null;
    return {
      kind: "l1_registry_validation",
      registryId: l1RegistryDocument.registry_id,
      envelopeSchema: envelope.schema ?? null,
      bodySchema: body.event_schema_version ?? body.schema_version ?? null,
      eventType: body.event_type ?? null,
      producer: body.producer && typeof body.producer === "object" ? { name: body.producer.name ?? null, version: body.producer.version ?? null } : null,
      registration: registration ? { domain: registration.domain, role: registration.role, phase: registration.phase, foldEligible: registration.fold_eligible, producers: registration.producers ?? [] } : null,
      eventId: envelope.event_id ?? null,
      exactBytesSha256: proof.bytesSha256,
    };
  }
  if (proof.owner === "knowledge_l2" || proof.owner === "constraint_l2") {
    return {
      kind: "l2_exact_recompute",
      renderer: proof.path === "l2/views/knowledge/latest/manifest.json"
        ? "renderKnowledgeProjectionManifestFromSet/complete-identity-fold"
        : proof.owner === "knowledge_l2"
          ? "renderKnowledgeProjectionFromSet/identity-fold"
          : "renderConstraintL2View/latest-projection-decision",
      operation: proof.op,
      exactBytesSha256: proof.bytesSha256,
      recomputedSourceEventIds: [...proof.sourceIds],
      exactByteEqualAccepted: true,
      ...(proof.op === "delete" ? { headPriorFoldRequired: true, headBlobOid: gitMaybe(abrainHome, ["rev-parse", `HEAD:${proof.path}`]) } : {}),
    };
  }
  return { kind: "canonical_owner_validation", exactBytesSha256: proof.bytesSha256, sourceIds: [...proof.sourceIds] };
}

async function waitForTestBarrier(envName = "PI_ASTACK_DOSSIER_TEST_BARRIER") {
  const barrierDir = process.env[envName];
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1" || !barrierDir) return;
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(path.join(barrierDir, "ready"), "ready\n", "utf8");
  const continuePath = path.join(barrierDir, "continue");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(continuePath)) {
    if (Date.now() >= deadline) throw new Error("dossier test barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function capturePathEvidence(abrainHome, paths) {
  return Object.fromEntries([...new Set(paths)].sort(compareUtf16CodeUnits).map((rel) => {
    const file = path.join(abrainHome, ...rel.split("/"));
    const worktree = readHash(file);
    let index = null;
    try { index = hash(git(abrainHome, ["ls-files", "--stage", "-z", "--", rel], "buffer")); } catch { index = null; }
    return [rel, { worktreeSha256: worktree, indexEntrySha256: index }];
  }));
}

async function captureSnapshot(abrainHome, extraPaths = [], recoveryScan = undefined) {
  const gitDir = gitMaybe(abrainHome, ["rev-parse", "--absolute-git-dir"]);
  const statusRaw = git(abrainHome, ["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"], "buffer");
  const statusRecords = parser.parseGitStatusPorcelainV1Z(statusRaw).map((record) => ({
    status: record.status,
    x: record.x,
    y: record.y,
    path: record.path,
    sourcePath: record.sourcePath ?? null,
    paths: [...record.paths],
  }));
  const head = gitMaybe(abrainHome, ["rev-parse", "HEAD"]);
  const ref = gitMaybe(abrainHome, ["symbolic-ref", "-q", "HEAD"]);
  const remote = gitMaybe(abrainHome, ["remote", "get-url", "origin"]);
  const remoteAdvertisement = remoteAdvertisementSnapshot(abrainHome, !!remote);
  const aheadBehindRaw = gitMaybe(abrainHome, ["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
  const [behind, ahead] = (aheadBehindRaw ?? "").split(/\s+/).map(Number);
  const openRecovery = recoveryScan === null
    ? { open: [], terminal: [], quarantined: [] }
    : recoveryScan
      ? recovery.recoverOpenRecoveryEpisodesFromScan(recoveryScan)
      : await recovery.recoverOpenRecoveryEpisodes(abrainHome).catch((error) => ({ open: [], terminal: [], quarantined: [{ errorCode: error?.code ?? "RECOVERY_SCAN_FAILED", message: error?.message ?? String(error) }] }));
  return {
    capturedAtUtc: new Date().toISOString(),
    head,
    ref,
    remote: remote
      ? { configured: true, urlSha256: hash(remote), mainAdvertisementOid: remoteAdvertisement.oid, mainAdvertisementSha256: remoteAdvertisement.sha256, advertisementErrorSha256: remoteAdvertisement.errorSha256 }
      : { configured: false, urlSha256: null, mainAdvertisementOid: null, mainAdvertisementSha256: null, advertisementErrorSha256: hash("REMOTE_NOT_CONFIGURED") },
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    rawIndex: gitDir ? { path: path.join(gitDir, "index"), bytesSha256: readHash(path.join(gitDir, "index")) } : null,
    lock: lockSnapshot(gitDir),
    status: { bytes: statusRaw.length, sha256: hash(statusRaw), records: statusRecords },
    pathEvidence: capturePathEvidence(abrainHome, [...extraPaths, ...statusRecords.flatMap((row) => row.paths)]),
    readHashes: {
      knowledgeManifest: readHash(path.join(abrainHome, "l2", "views", "knowledge", "latest", "manifest.json")),
      constraintL2: readHash(path.join(abrainHome, "l2", "views", "constraint", "latest", "compiled-view.md")),
      registry: readHash(path.join(repoRoot, "schemas", "l1-schema-role-registry.json")),
    },
    recovery: { open: openRecovery.open, terminal: openRecovery.terminal, quarantined: openRecovery.quarantined },
  };
}

const rawAbrain = arg("abrain", "");
if (!rawAbrain) throw new Error("--abrain is required; the dossier never defaults to ~/.abrain");
const abrainHome = path.resolve(rawAbrain);
const settingsPath = path.resolve(arg("settings", path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json")));
const output = arg("output", "");
const execute = flag("execute");
const settings = runtimeModule.resolveCanonicalGitRuntimeSettings(settingsPath);
const before = await captureSnapshot(abrainHome, [], null);
const ownershipContextBefore = await runtimeModule.buildCanonicalOwnershipContext({ abrainHome });
before.recovery = recovery.recoverOpenRecoveryEpisodesFromScan(ownershipContextBefore.scan);

async function captureOwnership(snapshot, context) {
  const ownerProofs = [];
  const blockedPaths = [];
  const nonCohortPaths = [];
  for (const row of snapshot.status.records) {
    const canonicalPath = row.paths.some((item) => item.startsWith("l1/") || item.startsWith("l2/"));
    if (!(row.x === " " || row.x === "?")) {
      if (canonicalPath) blockedPaths.push({ path: row.path, status: row.status, reason: "staged_canonical_path" });
      else nonCohortPaths.push(...row.paths);
      continue;
    }
    if (row.sourcePath) {
      blockedPaths.push({ path: row.path, status: row.status, reason: "rename_copy_requires_canonical_transaction_receipts" });
      continue;
    }
    if (row.status !== "??" && row.status !== " M" && row.status !== " D") {
      blockedPaths.push({ path: row.path, status: row.status, reason: "status_record_not_accepted_for_readonly_ownership" });
      continue;
    }
    const filePath = path.join(abrainHome, ...row.path.split("/"));
    const op = row.status.includes("D") && !fs.existsSync(filePath) ? "delete" : "put";
    try {
      const proof = await runtimeModule.proveCanonicalArtifactOwnership({ abrainHome, filePath, op, context });
      ownerProofs.push({ path: row.path, status: row.status, owner: proof.owner, op: proof.op, bytes: proof.bytes, bytesSha256: proof.bytesSha256, sourceIds: [...proof.sourceIds], proof: ownershipProofDetail(abrainHome, proof) });
    } catch (error) {
      blockedPaths.push({ path: row.path, status: row.status, reason: error?.message ?? String(error), code: error?.code ?? null });
    }
  }
  ownerProofs.sort((a, b) => compareUtf16CodeUnits(a.path, b.path));
  blockedPaths.sort((a, b) => compareUtf16CodeUnits(a.path, b.path));
  nonCohortPaths.sort(compareUtf16CodeUnits);
  return { ownerProofs, blockedPaths, nonCohortPaths, hash: hash(JSON.stringify({ ownerProofs, blockedPaths, nonCohortPaths })) };
}
const ownershipBefore = await captureOwnership(before, ownershipContextBefore);
const { ownerProofs, blockedPaths } = ownershipBefore;

let instance = null;
let provenanceError = null;
if (settings.valid) {
  try { instance = await runtimeModule.getCanonicalGitRuntime({ abrainHome, settingsPath, sourceRoot: repoRoot }); }
  catch (error) { provenanceError = { code: error?.code ?? null, message: error?.message ?? String(error) }; }
}

await waitForTestBarrier();

const curatorAdapter = {
  status: "blocked",
  blockedScope: "P1-S2-curator-only",
  drainCurrentAllowed: true,
  reason: "production curator adapter is not wired; this does not block P1-A-DRAIN-CURRENT",
};
const preFreezeSecond = await captureSnapshot(abrainHome, before.status.records.flatMap((row) => row.paths), ownershipContextBefore.scan);
const ownershipPreFreezeSecond = await captureOwnership(preFreezeSecond, ownershipContextBefore);
const preFreeze = {
  statusStable: before.status.sha256 === preFreezeSecond.status.sha256,
  ownershipStable: ownershipBefore.hash === ownershipPreFreezeSecond.hash,
  headStable: before.head === preFreezeSecond.head,
  indexStable: before.rawIndex?.bytesSha256 === preFreezeSecond.rawIndex?.bytesSha256,
  remoteStable: typeof before.remote.mainAdvertisementSha256 === "string"
    && typeof preFreezeSecond.remote.mainAdvertisementSha256 === "string"
    && before.remote.mainAdvertisementSha256 === preFreezeSecond.remote.mainAdvertisementSha256,
  cohortStable: ownershipBefore.hash === ownershipPreFreezeSecond.hash,
  firstStatusSha256: before.status.sha256,
  secondStatusSha256: preFreezeSecond.status.sha256,
  firstOwnershipSha256: ownershipBefore.hash,
  secondOwnershipSha256: ownershipPreFreezeSecond.hash,
  firstCohortSha256: ownershipBefore.hash,
  secondCohortSha256: ownershipPreFreezeSecond.hash,
  firstRemoteAdvertisementSha256: before.remote.mainAdvertisementSha256,
  secondRemoteAdvertisementSha256: preFreezeSecond.remote.mainAdvertisementSha256,
  firstRemoteAdvertisementErrorSha256: before.remote.advertisementErrorSha256,
  secondRemoteAdvertisementErrorSha256: preFreezeSecond.remote.advertisementErrorSha256,
};
const blockers = [];
if (!settings.valid) blockers.push(`settings_${settings.reason}`);
else if (!settings.enabled) blockers.push("kill_switch_disabled");
if (before.lock.exists || preFreezeSecond.lock.exists) blockers.push(`index_lock_${before.lock.kind ?? preFreezeSecond.lock.kind}`);
if (provenanceError) blockers.push("provenance_unavailable");
if (!before.remote.mainAdvertisementSha256 || !preFreezeSecond.remote.mainAdvertisementSha256) blockers.push("remote_advertisement_unavailable");
if (blockedPaths.length || ownershipPreFreezeSecond.blockedPaths.length) blockers.push("ownership_preflight_blocked");
if (!preFreeze.statusStable || !preFreeze.ownershipStable || !preFreeze.headStable || !preFreeze.indexStable || !preFreeze.remoteStable) blockers.push("pre_execute_freeze_drift");
if (before.recovery.quarantined.length) blockers.push("recovery_quarantined");
if (before.recovery.terminal.length) blockers.push("owner_intervention_required");
if (!execute) blockers.push("execute_not_requested");

let execution = null;
let after = null;
let afterFreezeSecond = null;
let mutationAttempted = false;
if (execute && blockers.length === 0 && instance) {
  mutationAttempted = true;
  const startup = await instance.awaitStartup();
  await waitForTestBarrier("PI_ASTACK_DOSSIER_POST_EXECUTE_TEST_BARRIER");
  const diagnostics = instance.diagnostics();
  const drainTail = [...diagnostics.tail].reverse().find((row) => row.operation === "drain" && typeof row.episodeId === "string" && Number.isInteger(row.slot));
  let folded = null;
  let prepared = null;
  if (drainTail) {
    const events = await recovery.readRecoveryEvents(abrainHome, drainTail.episodeId, "drain");
    folded = recovery.foldRecoveryEvents(events).get(drainTail.slot) ?? null;
    prepared = folded?.prepared?.body ?? null;
  }
  const cohortPaths = Array.isArray(prepared?.entries) ? prepared.entries.map((entry) => entry?.path).filter((value) => typeof value === "string").sort(compareUtf16CodeUnits) : [];
  const evidencePaths = before.status.records.flatMap((row) => row.paths);
  after = await captureSnapshot(abrainHome, evidencePaths, null);
  const ownershipContextAfter = await runtimeModule.buildCanonicalOwnershipContext({ abrainHome });
  after.recovery = recovery.recoverOpenRecoveryEpisodesFromScan(ownershipContextAfter.scan);
  afterFreezeSecond = await captureSnapshot(abrainHome, evidencePaths, ownershipContextAfter.scan);
  const ownershipAfter = await captureOwnership(after, ownershipContextAfter);
  const ownershipAfterSecond = await captureOwnership(afterFreezeSecond, ownershipContextAfter);
  const target = typeof drainTail?.candidate === "string" ? drainTail.candidate : after.head;
  const remote = target ? await instance.verifyRemoteConvergence(target) : null;
  const cohortSet = new Set(cohortPaths);
  const nonCohortPaths = Object.keys(before.pathEvidence).filter((rel) => !cohortSet.has(rel));
  const nonCohortPreserved = nonCohortPaths.every((rel) => JSON.stringify(before.pathEvidence[rel]) === JSON.stringify(after.pathEvidence[rel]));
  const boundedTail = after.status.records.filter((row) => !before.status.records.some((prior) => prior.path === row.path));
  const evidenceErrors = [];
  if (!drainTail) evidenceErrors.push("drain_tail_missing");
  if (typeof drainTail?.candidate !== "string") evidenceErrors.push("candidate_missing");
  if (typeof drainTail?.cohort !== "string") evidenceErrors.push("cohort_missing");
  if (!prepared || prepared.candidate !== drainTail?.candidate || prepared.cohort_manifest_root !== drainTail?.cohort) evidenceErrors.push("prepared_binding_missing");
  if (!folded?.published || folded.published.body.candidate !== drainTail?.candidate) evidenceErrors.push("published_fact_missing");
  if (!folded?.converged || folded.converged.body.candidate !== drainTail?.candidate) evidenceErrors.push("index_convergence_fact_missing");
  if (!remote) evidenceErrors.push("remote_evidence_missing");
  execution = {
    startup: startup.startup,
    blockedReason: startup.blockedReason ?? null,
    candidate: drainTail?.candidate ?? null,
    cohortManifestRoot: drainTail?.cohort ?? null,
    episodeId: drainTail?.episodeId ?? null,
    slot: drainTail?.slot ?? null,
    cohortPaths,
    published: folded?.published?.body ?? null,
    indexConverged: folded?.converged?.body ?? null,
    remote,
    evidenceErrors,
    postFreeze: {
      statusStable: after.status.sha256 === afterFreezeSecond.status.sha256,
      ownershipStable: ownershipAfter.hash === ownershipAfterSecond.hash,
      headStable: after.head === afterFreezeSecond.head,
      indexStable: after.rawIndex?.bytesSha256 === afterFreezeSecond.rawIndex?.bytesSha256,
      remoteStable: typeof after.remote.mainAdvertisementSha256 === "string"
        && typeof afterFreezeSecond.remote.mainAdvertisementSha256 === "string"
        && after.remote.mainAdvertisementSha256 === afterFreezeSecond.remote.mainAdvertisementSha256,
      firstStatusSha256: after.status.sha256,
      secondStatusSha256: afterFreezeSecond.status.sha256,
      firstOwnershipSha256: ownershipAfter.hash,
      secondOwnershipSha256: ownershipAfterSecond.hash,
      firstRemoteAdvertisementSha256: after.remote.mainAdvertisementSha256,
      secondRemoteAdvertisementSha256: afterFreezeSecond.remote.mainAdvertisementSha256,
      firstRemoteAdvertisementErrorSha256: after.remote.advertisementErrorSha256,
      secondRemoteAdvertisementErrorSha256: afterFreezeSecond.remote.advertisementErrorSha256,
    },
    validation: {
      startupReady: startup.startup === "ready",
      exactCandidatePublished: !!folded?.published && folded.published.body.candidate === drainTail?.candidate,
      exactCohortBound: !!prepared && prepared.cohort_manifest_root === drainTail?.cohort && cohortPaths.length > 0,
      exactIndexConverged: !!folded?.converged && folded.converged.body.candidate === drainTail?.candidate,
      headIsCandidate: after.head === drainTail?.candidate,
      remoteContainsCandidate: remote?.remoteContained === true,
      remoteExact: remote?.status === "ready" && remote.ahead === 0 && remote.behind === 0,
      nonCohortIndexAndWorktreePreserved: nonCohortPreserved,
      worktreeBoundedToRecoveryTail: boundedTail.every((row) => row.path.startsWith("l1/events/sha256/")),
      boundedRecoveryTail: boundedTail.length <= 64,
      recoveryClosed: after.recovery.open.length === 0
        && after.recovery.terminal.length === 0
        && after.recovery.quarantined.length === 0
        && afterFreezeSecond.recovery.open.length === 0
        && afterFreezeSecond.recovery.terminal.length === 0
        && afterFreezeSecond.recovery.quarantined.length === 0,
      postStatusFreeze: after.status.sha256 === afterFreezeSecond.status.sha256,
      postOwnershipFreeze: ownershipAfter.hash === ownershipAfterSecond.hash,
      postHeadFreeze: after.head === afterFreezeSecond.head,
      postIndexFreeze: after.rawIndex?.bytesSha256 === afterFreezeSecond.rawIndex?.bytesSha256,
      postRemoteFreeze: typeof after.remote.mainAdvertisementSha256 === "string"
        && typeof afterFreezeSecond.remote.mainAdvertisementSha256 === "string"
        && after.remote.mainAdvertisementSha256 === afterFreezeSecond.remote.mainAdvertisementSha256,
      evidenceComplete: false,
    },
  };
  execution.evidenceErrors = [...new Set([...evidenceErrors, ...dossierEvidence.validateP1ADossierExecutionEvidence(execution)])].sort(compareUtf16CodeUnits);
  execution.validation.evidenceComplete = execution.evidenceErrors.length === 0;
}

const structurallyAccepted = !!execution
  && execution.startup === "ready"
  && Object.values(execution.validation ?? {}).every(Boolean);
const report = {
  schemaVersion: "canonical-git-runtime-p1a-dossier/v3",
  generatedAtUtc: new Date().toISOString(),
  durationMs: Date.now() - dossierStartedMs,
  mode: execute ? "execute" : "preflight_read_only",
  status: structurallyAccepted ? "acceptance" : "preflight-blocked",
  mutationAttempted,
  stopReason: blockers[0] ?? (structurallyAccepted ? null : "acceptance_incomplete"),
  blockers,
  abrainHome,
  settings,
  loadedProvenance: instance?.diagnostics().loadedProvenance ?? [],
  implementationFingerprint: instance?.diagnostics().implementationFingerprint ?? null,
  provenanceError,
  preFreeze,
  ownershipPreflight: {
    status: blockedPaths.length ? "blocked" : ownerProofs.length ? "accepted" : "empty",
    dirtyCount: before.status.records.length,
    instrumentation: ownershipContextBefore.instrumentation,
    ownerProofs,
    blockedPaths,
  },
  before,
  after,
  afterFreezeSecond,
  boundedRecoveryTail: after ? after.status.records.filter((row) => row.path.startsWith("l1/events/sha256/")) : [],
  curatorAdapter,
  execution,
};
if (execute && structurallyAccepted) {
  const expectedReportExactSha256 = dossierEvidence.computeP1ADossierReportExactHash(report);
  const artifactVerification = await dossierEvidence.verifyP1ADossierExecutionArtifact({
    abrainHome,
    report,
    expectedReportExactSha256,
  });
  report.artifactVerification = artifactVerification;
  if (!artifactVerification.ok) {
    report.status = "preflight-blocked";
    report.stopReason = "artifact_verification_failed";
  }
}
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), json, "utf8");
}
process.stdout.write(json);
process.exitCode = report.status === "acceptance" ? 0 : 2;
