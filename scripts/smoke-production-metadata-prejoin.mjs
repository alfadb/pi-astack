#!/usr/bin/env node
/** Production-derived replay for validated recovery metadata before device join. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const configuredTimeout = Number.parseInt(process.env.PI_ASTACK_PRODUCTION_REPLAY_TIMEOUT_MS ?? "", 10);
const REPLAY_TIMEOUT_MS = Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1_000 && configuredTimeout <= 600_000
  ? configuredTimeout
  : 360_000;

// The production-derived worker is always kill-bounded by a separate parent
// process. This prevents a large or damaged source snapshot from turning the
// evidence fixture into an unbounded production startup.
if (process.env.PI_ASTACK_PRODUCTION_REPLAY_WORKER !== "1") {
  const workerTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-production-metadata-prejoin-"));
  const child = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    env: {
      ...process.env,
      PI_ASTACK_PRODUCTION_REPLAY_WORKER: "1",
      PI_ASTACK_PRODUCTION_REPLAY_TMP: workerTmp,
    },
    encoding: "utf8",
    timeout: REPLAY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 128 * 1024 * 1024,
  });
  fs.rmSync(workerTmp, { recursive: true, force: true });
  if (child.stdout) fs.writeSync(process.stdout.fd, child.stdout);
  if (child.stderr) fs.writeSync(process.stderr.fd, child.stderr);
  if (child.error?.code === "ETIMEDOUT") {
    fs.writeSync(process.stderr.fd, `production-derived metadata pre-join replay exceeded ${REPLAY_TIMEOUT_MS}ms hard timeout\n`);
    process.exit(1);
  }
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const runtimeModule = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const exactCohort = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const source = path.resolve(process.env.PI_ASTACK_PRODUCTION_REPLAY_SOURCE ?? path.join(os.homedir(), ".abrain"));
const tmp = process.env.PI_ASTACK_PRODUCTION_REPLAY_TMP
  ? path.resolve(process.env.PI_ASTACK_PRODUCTION_REPLAY_TMP)
  : fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-production-metadata-prejoin-"));
const settings = path.join(tmp, "settings.json");
fs.writeFileSync(settings, '{"canonicalGitRuntime":{"enabled":true,"mode":"local_convergence_v2"}}\n');

const schemas = Object.freeze({
  "drain-recovery-envelope/v1": 1,
  "local-drain-recovery-envelope/v2": 4,
  "local-drain-recovery-envelope/v3": 4,
});
const L1_ROOT = "l1/events/sha256/";
const KNOWLEDGE_MANIFEST = "l2/views/knowledge/latest/manifest.json";
const JOIN_SUBJECT = "pi-astack: deterministic device join";
const METADATA_PROTOCOL = "local-drain-metadata-checkpoint/v1";
const registry = l1.loadL1SchemaRegistry();

function assert(value, message) {
  if (!value) throw new Error(message);
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30_000,
  }).trim();
}

function gitBuffer(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30_000,
  });
}

function gitProbe(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null || ![0, 1].includes(result.status)) {
    throw new Error(`git ${args.join(" ")} failed (${result.status ?? result.signal}): ${(result.stderr ?? "").trim()}`);
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function nulPaths(bytes) {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function validateRecoveryCohort(paths, readEnvelope) {
  const counts = Object.fromEntries(Object.keys(schemas).map((schema) => [schema, 0]));
  const entries = [];
  for (const rel of paths) {
    const bytes = readEnvelope(rel);
    const envelope = JSON.parse(bytes.toString("utf8"));
    const validated = l1.validateL1Envelope(envelope, { registry, relativePath: rel });
    if (Object.hasOwn(counts, validated.registration.envelope_schema)) {
      counts[validated.registration.envelope_schema] += 1;
    }
    entries.push({
      path: rel,
      op: "put",
      mode: "100644",
      blobOid: "",
      bytesSha256: sha256(bytes),
    });
  }
  return { paths: [...paths].sort(), counts, entries };
}

function recoveryBacklog(repo, paths = nulPaths(gitBuffer(repo, "ls-files", "--others", "--exclude-standard", "-z", "--", L1_ROOT))) {
  const repoReal = fs.realpathSync(repo);
  return validateRecoveryCohort(paths, (rel) => {
    const absolute = path.join(repo, ...rel.split("/"));
    const stat = fs.lstatSync(absolute);
    assert(stat.isFile() && !stat.isSymbolicLink(), `production recovery path is not a regular file: ${rel}`);
    assert(fs.realpathSync(absolute) === path.join(repoReal, ...rel.split("/")), `production recovery path crosses a symlink: ${rel}`);
    return fs.readFileSync(absolute);
  });
}

function assertProductionCohort(backlog) {
  assert(backlog.paths.length === 9, `production replay requires exactly 9 untracked L1 events, found ${backlog.paths.length}`);
  assert(JSON.stringify(backlog.counts) === JSON.stringify(schemas), `production recovery schema mix changed: ${JSON.stringify(backlog.counts)}`);
}

function assertOnlyExpectedUntracked(repo, expectedPaths) {
  const records = nulPaths(gitBuffer(repo, "status", "--porcelain=v1", "-z", "-uall"));
  assert(records.every((record) => record.startsWith("?? ")), `production source has tracked, conflicted, or otherwise unknown dirty state: ${JSON.stringify(records)}`);
  const actual = records.map((record) => record.slice(3)).sort();
  const expected = [...expectedPaths].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `production source has mixed untracked state: ${JSON.stringify(actual)}`);
}

function inspectProductionState(repo) {
  const untracked = nulPaths(gitBuffer(repo, "ls-files", "--others", "--exclude-standard", "-z")).sort();
  const recoveryPaths = untracked.filter((rel) => rel.startsWith(L1_ROOT));
  if (recoveryPaths.length === 9) {
    const backlog = recoveryBacklog(repo, recoveryPaths);
    assertProductionCohort(backlog);
    assertOnlyExpectedUntracked(repo, backlog.paths);
    return { kind: "prestate", backlog };
  }
  assert(recoveryPaths.length === 0, `production source has a partial or mixed recovery cohort (${recoveryPaths.length} untracked L1 events)`);
  assert(untracked.length === 0, `production poststate has unknown untracked paths: ${JSON.stringify(untracked)}`);
  assertOnlyExpectedUntracked(repo, []);
  return { kind: "poststate" };
}

function exactMetadataCheckpoint(repo, commit) {
  const parents = git(repo, "show", "-s", "--format=%P", commit).split(" ").filter(Boolean);
  assert(parents.length === 1, `metadata checkpoint ${commit} is not single-parent`);
  const paths = nulPaths(gitBuffer(repo, "diff-tree", "-r", "--no-renames", "--no-commit-id", "--name-only", "-z", commit)).sort();
  const additions = nulPaths(gitBuffer(repo, "diff-tree", "-r", "--no-renames", "--diff-filter=A", "--no-commit-id", "--name-only", "-z", commit)).sort();
  assert(JSON.stringify(paths) === JSON.stringify(additions), `metadata checkpoint ${commit} contains non-add changes`);
  const cohort = validateRecoveryCohort(paths, (rel) => gitBuffer(repo, "show", `${commit}:${rel}`));
  assertProductionCohort(cohort);

  for (const entry of cohort.entries) {
    const row = gitBuffer(repo, "ls-tree", "-z", commit, "--", entry.path).toString("utf8").replace(/\0$/, "");
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t/.exec(row);
    assert(match?.[1] === "100644", `metadata checkpoint path has unexpected mode: ${entry.path}`);
    entry.mode = match[1];
    entry.blobOid = match[2];
  }
  const manifestRoot = exactCohort.cohortManifestRoot(cohort.entries, exactCohort.LOCAL_DRAIN_METADATA_CHECKPOINT_PROTOCOL_V1);
  const expectedMessage = exactCohort.deterministicDrainCommitMessage(manifestRoot, exactCohort.LOCAL_DRAIN_METADATA_CHECKPOINT_PROTOCOL_V1);
  assert(git(repo, "show", "-s", "--format=%B", commit) === expectedMessage, `metadata checkpoint ${commit} protocol manifest does not match its exact cohort`);
  return cohort;
}

function assertPublishedPoststate(repo) {
  const head = git(repo, "rev-parse", "--verify", "HEAD^{commit}");
  const upstreamName = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const upstream = git(repo, "rev-parse", "--verify", "@{upstream}^{commit}");
  assert(head === upstream, `production HEAD does not equal its locally recorded upstream ${upstreamName}: ${head} != ${upstream}`);

  assert(gitProbe(repo, "ls-files", "--error-unmatch", "--", KNOWLEDGE_MANIFEST).status === 0, `production manifest is not tracked: ${KNOWLEDGE_MANIFEST}`);
  const ignored = gitProbe(repo, "check-ignore", "--quiet", "--no-index", "--", KNOWLEDGE_MANIFEST);
  assert(ignored.status === 1, `production manifest is still covered by an ignore rule: ${KNOWLEDGE_MANIFEST}`);

  const checkpointCandidates = git(repo, "log", "--format=%H", "--fixed-strings", `--grep=protocol: ${METADATA_PROTOCOL}`, "HEAD").split("\n").filter(Boolean);
  const joinCandidates = git(repo, "log", "--format=%H", "--fixed-strings", `--grep=${JOIN_SUBJECT}`, "HEAD").split("\n").filter(Boolean)
    .filter((commit) => git(repo, "show", "-s", "--format=%B", commit) === JOIN_SUBJECT);
  for (const checkpoint of checkpointCandidates) {
    try {
      exactMetadataCheckpoint(repo, checkpoint);
    } catch {
      continue;
    }
    const publishedBy = joinCandidates.find((joinCommit) => gitProbe(repo, "merge-base", "--is-ancestor", checkpoint, joinCommit).status === 0);
    if (publishedBy) return { head, upstreamName, checkpoint, publishedBy };
  }
  throw new Error("production poststate lacks an exact v1=1/v2=4/v3=4 metadata checkpoint published by a reachable deterministic device join");
}

function repositoryFingerprint(repo, recoveryPaths) {
  const eventHashes = recoveryPaths.map((rel) => [rel, sha256(fs.readFileSync(path.join(repo, ...rel.split("/"))))]);
  return sha256(Buffer.from(JSON.stringify({
    head: git(repo, "rev-parse", "HEAD"),
    index: sha256(gitBuffer(repo, "ls-files", "--stage", "-z")),
    status: sha256(gitBuffer(repo, "status", "--porcelain=v1", "-z", "-uall")),
    eventHashes,
  })));
}

function copyRecoveryBacklog(from, to, paths) {
  for (const rel of paths) {
    const target = path.join(to, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, ...rel.split("/")), target);
  }
}

async function main() {
  assert(git(source, "rev-parse", "--is-inside-work-tree") === "true", `production replay source is not a Git worktree: ${source}`);
  const state = inspectProductionState(source);
  if (state.kind === "poststate") {
    const evidence = assertPublishedPoststate(source);
    console.log(`SKIP: production metadata cohort was consumed by checkpoint ${evidence.checkpoint.slice(0, 12)} and published by deterministic device join ${evidence.publishedBy.slice(0, 12)} (HEAD == ${evidence.upstreamName})`);
    return;
  }
  const production = state.backlog;
  const sourceBefore = repositoryFingerprint(source, production.paths);

  const device = path.join(tmp, "device");
  console.log("  stage production snapshot: cloning isolated worktree");
  git(tmp, "clone", "-q", "--no-hardlinks", source, device);
  copyRecoveryBacklog(source, device, production.paths);

  console.log("  stage canonical startup: begin");
  const runtime = await runtimeModule.getCanonicalGitRuntime({
    abrainHome: device,
    settingsPath: settings,
    sourceRoot: root,
    startupBarrierTimeoutMs: Math.min(REPLAY_TIMEOUT_MS, 30_000),
  });
  const startup = await runtime.awaitStartup();
  console.log("  stage canonical startup: ready");
  assert(startup.startup === "ready", `production-derived startup blocked: ${startup.blockedReason}`);
  assert(startup.tail.some((row) => row.operation === "startup_backlog" && row.status === "metadata_deferred"), "production-derived startup did not reproduce metadata_deferred");
  const initialHead = git(device, "rev-parse", "HEAD");
  const initialIds = (await l1.scanWholeL1Validated({ abrainHome: device })).all.map((record) => record.eventId).sort();
  assertProductionCohort(recoveryBacklog(device));

  console.log("  stage canonical pre-join metadata checkpoint: begin");
  await runtime.settleForDeviceJoin();
  console.log("  stage canonical pre-join metadata checkpoint: index_converged");
  const checkpoint = git(device, "rev-parse", "HEAD");
  assert(checkpoint !== initialHead, "production-derived metadata checkpoint did not move the isolated HEAD");
  assert(git(device, "rev-parse", `${checkpoint}^`) === initialHead, "metadata checkpoint parent is not the frozen pre-join HEAD");
  assert(git(device, "show", "-s", "--format=%B", checkpoint).includes("protocol: local-drain-metadata-checkpoint/v1"), "metadata checkpoint protocol marker is missing");
  const checkpointPaths = nulPaths(gitBuffer(device, "diff-tree", "-r", "--no-commit-id", "--name-only", "-z", checkpoint)).sort();
  assert(JSON.stringify(checkpointPaths) === JSON.stringify(production.paths), `metadata checkpoint cohort differs from the production backlog: ${JSON.stringify(checkpointPaths)}`);
  const checkpointCounts = Object.fromEntries(Object.keys(schemas).map((schema) => [schema, 0]));
  for (const rel of checkpointPaths) {
    const envelope = JSON.parse(git(device, "show", `${checkpoint}:${rel}`));
    checkpointCounts[envelope.schema] += 1;
  }
  assert(JSON.stringify(checkpointCounts) === JSON.stringify(schemas), `committed recovery schema mix changed: ${JSON.stringify(checkpointCounts)}`);
  const finalIds = (await l1.scanWholeL1Validated({ abrainHome: device })).all.map((record) => record.eventId).sort();
  assert(JSON.stringify(finalIds) === JSON.stringify(initialIds), "metadata checkpoint created or deleted an L1 event");
  assert(git(device, "status", "--porcelain=v1", "-uall") === "", "production-derived checkpoint did not converge the shared index");
  assert(runtime.diagnostics().tail.some((row) => row.operation === "metadata_checkpoint" && row.status === "index_converged" && row.cohortSize === 9), "runtime did not report the exact production metadata checkpoint");
  assert(repositoryFingerprint(source, production.paths) === sourceBefore, "production source changed during isolated replay");
  console.log("smoke: production-derived metadata pre-join replay passed (v1=1, v2=4, v3=4)");
}

try {
  await main();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
