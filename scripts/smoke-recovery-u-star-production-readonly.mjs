#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = "/home/worker/.abrain";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(sourceRoot, { interopDefault: true });
const l1 = jiti(path.join(sourceRoot, "extensions/_shared/l1-schema-registry.ts"));
const recovery = jiti(path.join(sourceRoot, "extensions/_shared/convergence-recovery.ts"));
const history = jiti(path.join(sourceRoot, "extensions/_shared/recovery-history-classifier.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-u-star-production-"));
const gitEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};
const commitEnv = {
  ...gitEnv,
  GIT_AUTHOR_NAME: "U Star Tamper Fixture",
  GIT_AUTHOR_EMAIL: "u-star-fixture@pi-astack.invalid",
  GIT_COMMITTER_NAME: "U Star Tamper Fixture",
  GIT_COMMITTER_EMAIL: "u-star-fixture@pi-astack.invalid",
  GIT_AUTHOR_DATE: "1800000000 +0000",
  GIT_COMMITTER_DATE: "1800000000 +0000",
};
let passed = 0;
const failures = [];
let productionEvidence = null;

function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`); }
}
function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv, maxBuffer: 256 * 1024 * 1024 }).trim();
}
function gitCommit(repo, message) {
  execFileSync("git", ["-C", repo, "commit", "-qm", message], { env: commitEnv, maxBuffer: 256 * 1024 * 1024 });
}
function gitIsAncestor(repo, ancestor, descendant) {
  return spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { env: gitEnv }).status === 0;
}
function treeEntries(repo, commit, prefix) {
  return new Map(git(repo, "ls-tree", "-r", "-z", commit, "--", prefix).split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    assert(tab > 0, `malformed tree record at ${commit}`);
    return [record.slice(tab + 1), record.slice(0, tab)];
  }));
}
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function hashRows(rows) { return sha(Buffer.from(rows.sort().join("\0"), "utf8")); }
function walkFiles(root, filter = () => true) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && filter(file)) out.push(file);
    }
  };
  walk(root);
  return out;
}
function repositoryFingerprint(repo) {
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
  const refs = [git(repo, "show-ref", "--head")];
  const refRoot = path.join(gitDir, "refs");
  for (const file of walkFiles(refRoot)) refs.push(`${path.relative(gitDir, file)}:${sha(fs.readFileSync(file))}`);
  const packed = path.join(gitDir, "packed-refs");
  refs.push(fs.existsSync(packed) ? `packed:${sha(fs.readFileSync(packed))}` : "packed:absent");
  const index = path.join(gitDir, "index");
  const l1Rows = walkFiles(path.join(repo, "l1")).map((file) => `${path.relative(repo, file).split(path.sep).join("/")}:${sha(fs.readFileSync(file))}`);
  const untracked = git(repo, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
    .map((relative) => `${relative}:${sha(fs.readFileSync(path.join(repo, relative)))}`);
  const status = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const trackedDiff = git(repo, "diff", "--no-ext-diff", "--binary", "HEAD");
  return Object.freeze({
    head: git(repo, "rev-parse", "HEAD"),
    refs: hashRows(refs),
    index: sha(fs.readFileSync(index)),
    status: sha(Buffer.from(status, "utf8")),
    trackedDiff: sha(Buffer.from(trackedDiff, "utf8")),
    untracked: hashRows(untracked),
    l1: hashRows(l1Rows),
  });
}
function cloneFrom(source, name) {
  const target = path.join(tmp, name);
  execFileSync("git", ["clone", "-q", "--shared", source, target], { env: gitEnv, maxBuffer: 256 * 1024 * 1024 });
  return target;
}
function writeEnvelope(repo, body, schema = "local-drain-recovery-envelope/v2") {
  const bodyHash = l1.canonicalL1BodyHash(body);
  const envelope = { schema, canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body };
  const file = path.join(repo, l1.expectedL1EventRelativePath(bodyHash));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, l1.canonicalL1EnvelopeJson(envelope));
  return { eventId: bodyHash, file };
}
function v2ClaimBody(episodeId, slot = 1) {
  return {
    event_schema_version: "local-drain-recovery-event/v2",
    event_type: "recovery_slot_claimed",
    producer: { name: "pi-astack.convergence-recovery", version: "2.0.0" },
    episode_id: episodeId,
    lane: "drain",
    slot,
    body: { claim_id: recovery.recoveryClaimId(episodeId, "drain", slot) },
  };
}
async function classify(repo) { return history.classifyV2RecoveryHistory({ repo }); }
async function expectQuarantine(repo, expectedCodes) {
  const result = await classify(repo);
  assert(result.status === "quarantined" && result.quarantined.length > 0, `tamper unexpectedly accepted: ${JSON.stringify({ status: result.status, joins: result.joins })}`);
  assert(expectedCodes.some((code) => result.quarantined.some((item) => item.errorCode === code || item.message.includes(code))), `unexpected quarantine: ${JSON.stringify(result.quarantined)}`);
  return result;
}
function startupChild(repo, settingsPath) {
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(sourceRoot)},{interopDefault:true});const m=j(p.join(${JSON.stringify(sourceRoot)},'extensions/_shared/canonical-git-runtime.ts'));const r=await m.getCanonicalGitRuntime({abrainHome:${JSON.stringify(repo)},settingsPath:${JSON.stringify(settingsPath)},sourceRoot:${JSON.stringify(sourceRoot)}});process.stdout.write(JSON.stringify(await r.awaitStartup()));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawnSync(process.execPath, ["-e", code], { cwd: sourceRoot, encoding: "utf8", env: gitEnv, maxBuffer: 256 * 1024 * 1024 });
}
function removeRepo(repo) { fs.rmSync(repo, { recursive: true, force: true }); }

console.log("smoke: U* production read-only graph + production-derived tamper replay");
const productionBefore = repositoryFingerprint(production);
let baseline;
let dual;
let join;

await check("production graph accepts dual closure, both children, and a retained certified merge ancestor", async () => {
  const scan = await l1.scanWholeL1Validated({ abrainHome: production });
  baseline = await history.classifyV2RecoveryHistory({ repo: production, scan });
  assert(baseline.status === "accepted" && baseline.quarantined.length === 0 && baseline.writableFrontierCount === 0, `production history not accepted: ${JSON.stringify(baseline.quarantined)}`);
  dual = baseline.episodes.find((episode) => episode.closures.length === 2);
  assert(dual, "dynamic dual-closure episode not found");
  assert(dual.closures.some((left) => dual.closures.some((right) => left !== right && right.frozenCommit === left.candidate)), "dual closure candidate/frozen chain is not the production graph");
  const children = dual.childEpisodeIds.map((episodeId) => baseline.episodes.find((episode) => episode.episodeId === episodeId));
  assert(children.every(Boolean), "accepted convergence traversal did not visit every child episode");
  const childCandidates = children.flatMap((episode) => episode.closures.map((closure) => closure.candidate)).sort();
  assert(JSON.stringify(childCandidates) === JSON.stringify(dual.closures.map((closure) => closure.branchLabel).sort()), `child candidates do not bind every branch label: ${childCandidates}`);
  join = baseline.joins.find((item) => item.episodeId === dual.episodeId);
  assert(join && gitIsAncestor(production, join.mergeCommit, baseline.head), "certified production semantic join is not a current HEAD ancestor");
  assert(join.parents.length === 2 && join.branchLabels.length === 2 && join.l1ObjectCount > 5000 && join.l2ObjectCount > 3000, "certified join evidence is incomplete");
  const joinedL1 = treeEntries(production, join.mergeCommit, "l1/events/sha256");
  const headL1 = treeEntries(production, baseline.head, "l1/events/sha256");
  assert([...joinedL1].every(([relative, entry]) => headL1.get(relative) === entry), "current HEAD did not retain the certified join L1 content byte-for-byte");
  const headL1Paths = new Set(git(production, "ls-tree", "-r", "--name-only", baseline.head, "--", "l1/events/sha256").split("\n").filter(Boolean));
  const tailByEpisode = new Map();
  for (const record of scan.all.filter((record) => record.registration.envelope_schema === "local-drain-recovery-envelope/v2" && !headL1Paths.has(record.relativePath))) {
    tailByEpisode.set(record.body.episode_id, [...(tailByEpisode.get(record.body.episode_id) ?? []), record.eventId]);
  }
  const metadataLeaves = [...tailByEpisode].map(([episodeId, eventIds]) => ({ episode: baseline.episodes.find((item) => item.episodeId === episodeId), eventIds }));
  assert(metadataLeaves.every((leaf) => leaf.episode && (leaf.episode.status === "complete" || leaf.episode.status === "terminal")), "an extant v2 metadata tail retained a writable or unclassified frontier");
  productionEvidence = {
    productionFingerprintSha256: sha(Buffer.from(JSON.stringify(productionBefore), "utf8")),
    head: baseline.head,
    episodeId: dual.episodeId,
    closures: dual.closures,
    childEpisodeIds: dual.childEpisodeIds,
    childCandidates: children.flatMap((episode) => episode.closures.map((closure) => closure.candidate)),
    join,
    episodes: baseline.episodes.length,
    consumedV2Objects: baseline.consumedEventIds.length,
    currentMetadataLeaves: metadataLeaves.map((leaf) => ({ episodeId: leaf.episode.episodeId, status: leaf.episode.status, eventIds: leaf.eventIds })),
  };
});

await check("repeated production classification is deterministic and production fingerprint remains unchanged", async () => {
  const second = await classify(production);
  assert(JSON.stringify(second) === JSON.stringify(baseline), "repeated production classification changed semantic result bytes");
  assert(JSON.stringify(repositoryFingerprint(production)) === JSON.stringify(productionBefore), "production changed during repeated read-only classification");
});

const seed = cloneFrom(production, "production-seed");
const runtimeSettingsPath = path.join(tmp, "runtime-settings.json");
fs.writeFileSync(runtimeSettingsPath, `${JSON.stringify({ canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" } }, null, 2)}\n`);
await check("repeated startup on a production-derived clone is deterministic and idempotent", () => {
  const before = repositoryFingerprint(seed);
  const first = startupChild(seed, runtimeSettingsPath);
  const middle = repositoryFingerprint(seed);
  const second = startupChild(seed, runtimeSettingsPath);
  const after = repositoryFingerprint(seed);
  assert(first.status === 0 && second.status === 0, `production-derived startup failed: ${first.stderr || second.stderr}`);
  const a = JSON.parse(first.stdout); const b = JSON.parse(second.stdout);
  assert(a.startup === "ready" && b.startup === "ready", `production-derived startup blocked: ${a.blockedReason || b.blockedReason}`);
  const classifyRows = [a, b].map((item) => item.tail.find((row) => row.operation === "classify_v2_history"));
  assert(classifyRows.every((row) => row && row.status === "accepted" && row.writableFrontierCount === 0), "startup omitted accepted v2 classification evidence");
  assert(classifyRows[0].episodes === classifyRows[1].episodes && classifyRows[0].joins === classifyRows[1].joins && classifyRows[0].consumed === classifyRows[1].consumed, "repeated startup classification changed");
  assert(JSON.stringify(before) === JSON.stringify(middle) && JSON.stringify(before) === JSON.stringify(after), "repeated production-derived startup mutated clone state");
});

await check("production-derived merge -s ours / dropped L1 branch is quarantined", async () => {
  const repo = cloneFrom(seed, "tamper-ours");
  try {
    execFileSync("git", ["-C", repo, "checkout", "-q", "--detach", join.parents[0]], { env: gitEnv });
    execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "-s", "ours", join.parents[1], "-m", "tampered ours join"], { env: commitEnv, maxBuffer: 256 * 1024 * 1024 });
    await expectQuarantine(repo, ["RECOVERY_REACHABLE_L1_DROPPED"]);
  } finally { removeRepo(repo); }
});

await check("production-derived L1 byte mutation is quarantined by strict envelope/JCS hash validation", async () => {
  const repo = cloneFrom(seed, "tamper-l1-bytes");
  try {
    const relative = dual.closures[0].preparedEventId;
    const file = path.join(repo, l1.expectedL1EventRelativePath(relative));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    parsed.body.body.candidate = parsed.body.body.candidate.replace(/^./, parsed.body.body.candidate[0] === "0" ? "1" : "0");
    fs.writeFileSync(file, `${JSON.stringify(parsed)}\n`);
    await expectQuarantine(repo, ["L1_HASH_MISMATCH"]);
  } finally { removeRepo(repo); }
});

await check("production-derived canonical L2 projection drift is quarantined", async () => {
  const repo = cloneFrom(seed, "tamper-l2-drift");
  try {
    const target = git(repo, "ls-tree", "-r", "--name-only", "HEAD", "--", "l2/views/knowledge/latest").split("\n").find((relative) => relative.endsWith(".md"));
    assert(target, "no canonical Knowledge L2 fixture path found");
    fs.appendFileSync(path.join(repo, target), "\nTAMPERED L2\n");
    git(repo, "add", "--", target); gitCommit(repo, "tamper canonical L2");
    await expectQuarantine(repo, ["RECOVERY_L2_PROJECTION_DRIFT"]);
  } finally { removeRepo(repo); }
});

await check("production-derived missing closure branch object is quarantined", async () => {
  const repo = cloneFrom(seed, "tamper-missing-branch");
  try {
    fs.rmSync(path.join(repo, l1.expectedL1EventRelativePath(dual.closures[1].convergedEventId)));
    await expectQuarantine(repo, ["RECOVERY_CLOSURE_INCOMPLETE", "RECOVERY_OBJECT_CONSUMPTION"]);
    const startup = startupChild(repo, runtimeSettingsPath);
    assert(startup.status === 0, `quarantined startup process failed before diagnostics: ${startup.stderr}`);
    const diagnostics = JSON.parse(startup.stdout);
    assert(diagnostics.startup === "blocked", "missing-branch startup did not block");
    assert((diagnostics.blockedReason ?? "").includes(`v2:${dual.episodeId}:RECOVERY_CLOSURE_INCOMPLETE`), `startup warning lost episode/classification: ${diagnostics.blockedReason}`);
    assert((diagnostics.blockedReason ?? "").includes('"count":0') && !(diagnostics.blockedReason ?? "").includes("/home/worker/.abrain"), `startup warning lost bounded safe detail or leaked production path: ${diagnostics.blockedReason}`);
  } finally { removeRepo(repo); }
});

await check("production-derived open non-terminal v2 attempt is quarantined", async () => {
  const repo = cloneFrom(seed, "tamper-open");
  try {
    const episodeId = crypto.createHash("sha256").update("u-star-open-production-derived").digest("hex");
    writeEnvelope(repo, v2ClaimBody(episodeId));
    await expectQuarantine(repo, ["RECOVERY_OPEN_NONTERMINAL"]);
  } finally { removeRepo(repo); }
});

await check("production-derived complete orphan episode is quarantined", async () => {
  const repo = cloneFrom(seed, "tamper-orphan");
  try {
    const sourceEpisode = baseline.episodes.find((episode) => episode.closures.length === 1 && episode.status === "complete");
    assert(sourceEpisode, "no complete source episode for orphan replay");
    const sourceRecords = (await l1.scanWholeL1Validated({ abrainHome: repo })).all.filter((record) => record.body.episode_id === sourceEpisode.episodeId);
    const orphanId = crypto.createHash("sha256").update("u-star-orphan-production-derived").digest("hex");
    for (const record of sourceRecords) {
      const body = structuredClone(record.body);
      body.episode_id = orphanId;
      if (body.event_type === "recovery_slot_claimed") body.body.claim_id = recovery.recoveryClaimId(orphanId, "drain", body.slot);
      writeEnvelope(repo, body);
    }
    await expectQuarantine(repo, ["RECOVERY_EPISODE_ORPHAN"]);
  } finally { removeRepo(repo); }
});

await check("production-derived episode graph cycle is quarantined by finite-DAG guard", async () => {
  const edges = new Map([
    [dual.episodeId, [dual.childEpisodeIds[0]]],
    [dual.childEpisodeIds[0], [dual.episodeId]],
  ]);
  let code = null;
  try { history.assertAcyclicDirectedGraph(edges); } catch (error) { code = error.code; }
  assert(code === "RECOVERY_EPISODE_CHAIN_CYCLE", `cycle guard returned ${code}`);
});

await check("production-derived abort/converged contradiction is quarantined", async () => {
  const repo = cloneFrom(seed, "tamper-abort-contradiction");
  try {
    writeEnvelope(repo, {
      event_schema_version: "local-drain-recovery-event/v2",
      event_type: "recovery_slot_aborted",
      producer: { name: "pi-astack.convergence-recovery", version: "2.0.0" },
      episode_id: dual.episodeId,
      lane: "drain",
      slot: dual.closures[0].slot,
      body: { reason: "recovery_slot_aborted", error_code: "RECOVERY_SLOT_ABORTED" },
    });
    await expectQuarantine(repo, ["RECOVERY_ABORT_CONTRADICTION"]);
  } finally { removeRepo(repo); }
});

await check("production HEAD/refs/index/worktree/L1 fingerprint is unchanged after all read-only evidence", () => {
  const after = repositoryFingerprint(production);
  assert(JSON.stringify(after) === JSON.stringify(productionBefore), `production fingerprint changed:\nbefore=${JSON.stringify(productionBefore)}\nafter=${JSON.stringify(after)}`);
});

removeRepo(seed);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (productionEvidence) console.log(`production evidence: ${JSON.stringify(productionEvidence)}`);
if (failures.length) process.exitCode = 1;
