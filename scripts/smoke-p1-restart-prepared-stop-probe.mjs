#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const runtimeModule = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const writer = jiti(path.join(root, "extensions/sediment/writer.ts"));

const ENV_NAME = "PI_ASTACK_P1_RESTART_PROBE";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p1-prepared-stop-"));
const settingsPath = path.join(tmp, "settings.json");
const capturePath = path.join(tmp, "git-argv.jsonl");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, "git"), `#!/usr/bin/env node\nconst fs=require("fs"),cp=require("child_process");const a=process.argv.slice(2);fs.appendFileSync(process.env.P1_PROBE_GIT_CAPTURE,JSON.stringify(a)+"\\n");const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit",env:process.env});process.exit(r.status??1);\n`, { mode: 0o755 });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.P1_PROBE_GIT_CAPTURE = capturePath;
fs.writeFileSync(settingsPath, `${JSON.stringify({ canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" } }, null, 2)}\n`);

let passed = 0;
const failures = [];
function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`); }
}
function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } }).trim();
}
function initRepo(label) {
  const repo = path.join(tmp, label);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".gitignore", "base.txt");
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" },
  });
  return repo;
}
function body(seq, sourceRef = `sediment:auto_write:created:probe-${seq}`) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-12T03:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "p1-restart-probe-fixture",
    device_event_seq: seq,
    producer_nonce: `p1-restart-probe-${seq}`,
    causal_parents: [],
    session_id: "p1-restart-probe-session",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: sourceRef.includes(":replay:") ? "replay" : "agent_end", source_ref: sourceRef },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: `p1-restart-probe-${seq}`,
      title: `P1 Restart Probe ${seq}`,
      kind: "knowledge",
      status: "active",
      provenance: "synthetic-smoke",
      confidence: 9,
      compiled_truth: `# P1 Restart Probe ${seq}\n\nSynthetic acceptance fixture.`,
      trigger_phrases: ["p1 restart probe"],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "fixture", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "synthetic fixture" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
}
function writeKnowledge(repo, seq, sourceRef) {
  const eventBody = body(seq, sourceRef);
  const eventId = l1.canonicalL1BodyHash(eventBody);
  const envelope = { schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: eventId, body_hash: eventId, body: eventBody };
  const relativePath = l1.expectedL1EventRelativePath(eventId);
  const file = path.join(repo, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, l1.canonicalL1EnvelopeJson(envelope));
  return { eventId, file, relativePath };
}
function runId(seq) { return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`; }
function probe(expectedHead, seq, expiresAtUtc = new Date(Date.now() + 10 * 60_000).toISOString()) {
  return JSON.stringify({ version: 1, runId: runId(seq), boundary: "commit_prepared", expectedHead, expiresAtUtc });
}
async function runtimeFor(repo) {
  return runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath, sourceRoot: root });
}
function indexBytes(repo) { return fs.readFileSync(path.join(repo, ".git", "index")); }
function repositoryFingerprint(repo) {
  const files = [];
  const eventRoot = path.join(repo, "l1", "events", "sha256");
  if (fs.existsSync(eventRoot)) {
    const walk = (dir) => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); const stat = fs.lstatSync(file); if (stat.isDirectory()) walk(file); else files.push(`${path.relative(repo, file)}\0${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`); } };
    walk(eventRoot);
  }
  return crypto.createHash("sha256").update(JSON.stringify({ head: git(repo, "rev-parse", "HEAD"), index: crypto.createHash("sha256").update(indexBytes(repo)).digest("hex"), status: git(repo, "status", "--porcelain=v1", "-z", "-uall"), files })).digest("hex");
}
async function recoveryTypes(repo, episodeId) {
  return (await recovery.readRecoveryEvents(repo, episodeId)).map((event) => event.event_type).sort();
}
async function activeRecoveryRecords(repo) {
  const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
  return scan.selected.filter((record) => record.registration.envelope_schema === "local-drain-recovery-envelope/v2");
}
function childStartup(repo, rawProbe) {
  const code = `const {createJiti}=require("jiti");const p=require("path");(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const m=j(p.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));const r=await m.getCanonicalGitRuntime({abrainHome:${JSON.stringify(repo)},settingsPath:${JSON.stringify(settingsPath)},sourceRoot:${JSON.stringify(root)}});const s=await r.awaitStartup();process.stdout.write(JSON.stringify(s));})().catch(e=>{console.error(e);process.exit(1)});`;
  const env = { ...process.env, LANG: "C", LC_ALL: "C" };
  if (rawProbe === undefined) delete env[ENV_NAME]; else env[ENV_NAME] = rawProbe;
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
}
async function createPreparedStop(label, seq) {
  const repo = initRepo(label);
  const runtime = await runtimeFor(repo);
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "ready", `startup blocked: ${startup.blockedReason}`);
  const knowledge = writeKnowledge(repo, seq);
  const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
  const headBefore = git(repo, "rev-parse", "HEAD");
  const indexBefore = indexBytes(repo);
  const knowledgeBefore = fs.readFileSync(knowledge.file);
  const rawProbe = probe(headBefore, seq);
  process.env[ENV_NAME] = rawProbe;
  const result = await runtime.requestDrain([receipt], "p1 prepared stop smoke");
  delete process.env[ENV_NAME];
  assert(result.status === "blocked" && result.reason === "CONTROLLED_STOP_AFTER_PREPARED", `unexpected stop result: ${JSON.stringify(result)}`);
  assert(result.commit === undefined && result.candidate && result.episodeId && result.slot === 1, `missing verification coordinates or unpublished commit leaked: ${JSON.stringify(result)}`);
  assert(git(repo, "rev-parse", "HEAD") === headBefore, "prepared stop changed HEAD");
  assert(indexBytes(repo).equals(indexBefore), "prepared stop changed the shared index");
  assert(fs.readFileSync(knowledge.file).equals(knowledgeBefore), "prepared stop changed writer worktree bytes");
  assert(git(repo, "branch", "--contains", result.candidate) === "", "candidate was published before restart");
  const types = await recoveryTypes(repo, result.episodeId);
  assert(JSON.stringify(types) === JSON.stringify(["commit_prepared", "recovery_slot_claimed"]), `prepared event set is not exact: ${JSON.stringify(types)}`);
  return { repo, runtime, receipt, headBefore, indexBefore, result, rawProbe, knowledge };
}

console.log("smoke: temporary P1 production prepared-stop restart probe");

await check("real Knowledge auto_write receipt stops after exact durable claim+prepared", async () => {
  const prepared = await createPreparedStop("prepared", 1);
  const publication = writer.writerPublicationFromCanonicalDrain(prepared.result);
  assert(publication.status === "durable_pending" && publication.reason === "CONTROLLED_STOP_AFTER_PREPARED", `writer mapping changed controlled stop: ${JSON.stringify(publication)}`);
  assert(publication.commit === null && publication.episodeId === prepared.result.episodeId && publication.slot === 1 && publication.candidate === prepared.result.candidate, "writer mapping leaked unpublished commit or lost prepared coordinates");
  process.env[ENV_NAME] = prepared.rawProbe;
  const before = repositoryFingerprint(prepared.repo);
  const second = await prepared.runtime.requestDrain([prepared.receipt], "must not execute twice");
  delete process.env[ENV_NAME];
  assert(second.status === "blocked" && second.reason === "P1_RESTART_PROBE_RUN_ALREADY_CONSUMED", `same-process consume gate failed: ${JSON.stringify(second)}`);
  assert(repositoryFingerprint(prepared.repo) === before, "same-process consumed call mutated repository state");
});

await check("concurrent same-runId drains trigger once and never claim slot 2", async () => {
  const repo = initRepo("concurrent-consume");
  const runtime = await runtimeFor(repo);
  assert((await runtime.awaitStartup()).startup === "ready", "concurrent fixture startup failed");
  const knowledge = writeKnowledge(repo, 11);
  const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
  process.env[ENV_NAME] = probe(git(repo, "rev-parse", "HEAD"), 11);
  const results = await Promise.all([
    runtime.requestDrain([receipt], "concurrent prepared stop a"),
    runtime.requestDrain([receipt], "concurrent prepared stop b"),
  ]);
  delete process.env[ENV_NAME];
  const stopped = results.filter((item) => item.reason === "CONTROLLED_STOP_AFTER_PREPARED");
  const consumed = results.filter((item) => item.reason === "P1_RESTART_PROBE_RUN_ALREADY_CONSUMED");
  assert(stopped.length === 1 && consumed.length === 1, `concurrent consume results invalid: ${JSON.stringify(results)}`);
  assert(stopped[0].slot === 1, `concurrent stop used wrong slot: ${JSON.stringify(stopped[0])}`);
  assert(JSON.stringify(await recoveryTypes(repo, stopped[0].episodeId)) === JSON.stringify(["commit_prepared", "recovery_slot_claimed"]), "concurrent call created extra recovery events");
});

await check("fresh child without env recovers the same episode/slot through publish+converge", async () => {
  const prepared = await createPreparedStop("restart-clean-env", 2);
  const child = childStartup(prepared.repo, undefined);
  assert(child.status === 0, `restart child failed: ${child.stderr}`);
  const diagnostics = JSON.parse(child.stdout);
  assert(diagnostics.startup === "ready", `restart child blocked: ${diagnostics.blockedReason}`);
  assert(git(prepared.repo, "rev-parse", "HEAD") === prepared.result.candidate, "restart did not publish the candidate");
  assert(JSON.stringify(await recoveryTypes(prepared.repo, prepared.result.episodeId)) === JSON.stringify(["commit_prepared", "commit_published", "index_converged", "recovery_slot_claimed"]), "restart did not close the exact same slot");
  assert(git(prepared.repo, "diff", "--cached", "--", prepared.knowledge.relativePath) === "", "restart left the candidate cohort staged");
  assert(git(prepared.repo, "status", "--porcelain=v1", "--", prepared.knowledge.relativePath) === "", "restart did not converge Knowledge worktree/index/HEAD");
});

await check("fresh child carrying env still ignores it during startup recovery", async () => {
  const prepared = await createPreparedStop("restart-carried-env", 3);
  const child = childStartup(prepared.repo, prepared.rawProbe);
  assert(child.status === 0, `carried-env restart failed: ${child.stderr}`);
  const diagnostics = JSON.parse(child.stdout);
  assert(diagnostics.startup === "ready", `carried-env restart blocked: ${diagnostics.blockedReason}`);
  assert(git(prepared.repo, "rev-parse", "HEAD") === prepared.result.candidate, "carried-env restart did not publish candidate");
  assert(JSON.stringify(await recoveryTypes(prepared.repo, prepared.result.episodeId)) === JSON.stringify(["commit_prepared", "commit_published", "index_converged", "recovery_slot_claimed"]), "carried-env startup stopped a second time");
});

async function sourceMismatchCase(label, seq, setup) {
  const repo = initRepo(label);
  const runtime = await runtimeFor(repo);
  assert((await runtime.awaitStartup()).startup === "ready", "fixture startup failed");
  const receipt = await setup(repo, runtime);
  const raw = probe(git(repo, "rev-parse", "HEAD"), seq);
  const before = repositoryFingerprint(repo);
  process.env[ENV_NAME] = raw;
  let caught;
  try { await runtime.requestDrain(receipt ? [receipt] : [], "must fail closed"); } catch (error) { caught = error; }
  delete process.env[ENV_NAME];
  assert(caught?.code === "P1_RESTART_PROBE_SOURCE_MISMATCH", `${label} returned ${caught?.code ?? "success"}`);
  assert(repositoryFingerprint(repo) === before, `${label} mutated before source rejection`);
}

await check("replay, metadata-tail-only, and non-Knowledge cohorts fail before claim", async () => {
  await sourceMismatchCase("replay", 4, async (repo) => {
    const event = writeKnowledge(repo, 4, "sediment:replay:created:probe-4");
    return runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: event.file, sourceIds: [event.eventId] });
  });
  await sourceMismatchCase("metadata-tail", 5, async (repo) => {
    const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
    await recovery.claimRecoverySlot({ abrainHome: repo, episodeId, lane: "drain", slot: 1 });
    return null;
  });
  await sourceMismatchCase("non-knowledge", 6, async (repo) => {
    const file = path.join(repo, "writer.txt");
    fs.writeFileSync(file, "writer transaction\n");
    return runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: file, sourceIds: ["fixture:writer"] });
  });
});

await check("head mismatch and expiry mismatch are zero-mutation fail-closed", async () => {
  for (const [label, rawFor, code] of [
    ["head", (head) => probe("f".repeat(40), 7), "P1_RESTART_PROBE_HEAD_MISMATCH"],
    ["expired", (head) => probe(head, 8, "2026-07-12T00:00:00.000Z"), "P1_RESTART_PROBE_EXPIRED"],
  ]) {
    const repo = initRepo(`mismatch-${label}`);
    const runtime = await runtimeFor(repo);
    assert((await runtime.awaitStartup()).startup === "ready", "fixture startup failed");
    const event = writeKnowledge(repo, label === "head" ? 7 : 8);
    const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: event.file, sourceIds: [event.eventId] });
    const before = repositoryFingerprint(repo);
    process.env[ENV_NAME] = rawFor(git(repo, "rev-parse", "HEAD"));
    let caught;
    try { await runtime.requestDrain([receipt]); } catch (error) { caught = error; }
    delete process.env[ENV_NAME];
    assert(caught?.code === code, `${label} returned ${caught?.code ?? "success"}`);
    assert(repositoryFingerprint(repo) === before, `${label} mismatch mutated repository`);
  }
});

await check("schema/runId/OID failures happen before startup or repository mutation", async () => {
  const invalid = [
    "not-json",
    JSON.stringify({ version: 1, runId: "bad", boundary: "commit_prepared", expectedHead: "a".repeat(40), expiresAtUtc: new Date(Date.now() + 60_000).toISOString() }),
    JSON.stringify({ version: 1, runId: runId(9), boundary: "commit_prepared", expectedHead: "BAD", expiresAtUtc: new Date(Date.now() + 60_000).toISOString() }),
    JSON.stringify({ version: 1, runId: runId(10), boundary: "commit_prepared", expectedHead: "a".repeat(40), expiresAtUtc: new Date(Date.now() + 60_000).toISOString(), extra: true }),
  ];
  for (const [index, raw] of invalid.entries()) {
    const repo = initRepo(`schema-${index}`);
    const runtime = await runtimeFor(repo);
    const before = repositoryFingerprint(repo);
    process.env[ENV_NAME] = raw;
    let caught;
    try { await runtime.requestDrain([]); } catch (error) { caught = error; }
    delete process.env[ENV_NAME];
    assert(caught?.code === "P1_RESTART_PROBE_INVALID", `schema ${index} returned ${caught?.code ?? "success"}`);
    assert(runtime.diagnostics().startup === "not_started", `schema ${index} entered startup`);
    assert(repositoryFingerprint(repo) === before, `schema ${index} mutated repository`);
  }
});

await check("read-only isolation resolver is immutable, exact, and inactive for absent/malformed/expired", () => {
  const head = "a".repeat(40);
  const active = runtimeModule.resolveP1RestartProbeIsolation(probe(head, 80));
  const absent = runtimeModule.resolveP1RestartProbeIsolation(undefined);
  const malformed = runtimeModule.resolveP1RestartProbeIsolation("not-json");
  const expired = runtimeModule.resolveP1RestartProbeIsolation(probe(head, 81, "2026-07-12T00:00:00.000Z"));
  assert(active.active && active.runId === runId(80) && Object.isFrozen(active), `active resolver shape invalid: ${JSON.stringify(active)}`);
  assert(!absent.active && !malformed.active && !expired.active, "inactive resolver cases became active");
  assert(Object.isFrozen(absent) && Object.isFrozen(malformed) && Object.isFrozen(expired), "resolver result is mutable");
});

await check("startup never reads even a malformed probe env", async () => {
  const repo = initRepo("startup-env-isolation");
  const runtime = await runtimeFor(repo);
  process.env[ENV_NAME] = "not-json";
  const startup = await runtime.awaitStartup();
  delete process.env[ENV_NAME];
  assert(startup.startup === "ready", `startup observed malformed probe: ${startup.blockedReason}`);
});

await check("unlisted foreign write is an explicit ABORT with no false prepared evidence", async () => {
  const repo = initRepo("foreign-abort");
  const runtime = await runtimeFor(repo);
  assert((await runtime.awaitStartup()).startup === "ready", "foreign fixture startup failed");
  const event = writeKnowledge(repo, 82);
  const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: event.file, sourceIds: [event.eventId] });
  fs.writeFileSync(path.join(repo, "foreign-unlisted.txt"), "foreign\n");
  const before = repositoryFingerprint(repo);
  process.env[ENV_NAME] = probe(git(repo, "rev-parse", "HEAD"), 82);
  let caught;
  try { await runtime.requestDrain([receipt], "foreign path must abort probe"); } catch (error) { caught = error; }
  delete process.env[ENV_NAME];
  assert(caught?.code === "ARTIFACT_UNOWNED", `foreign write did not ABORT explicitly: ${caught?.code ?? "success"}`);
  const records = await activeRecoveryRecords(repo);
  assert(records.length === 0, "foreign ABORT created false claim/prepared evidence");
  assert(repositoryFingerprint(repo) === before, "foreign ABORT mutated canonical repository state");
});

await check("source guards keep probe temporary, local-only, and outside push path", () => {
  const runtimeSource = fs.readFileSync(path.join(root, "extensions/_shared/canonical-git-runtime.ts"), "utf8");
  const writerSource = fs.readFileSync(path.join(root, "extensions/sediment/writer.ts"), "utf8");
  assert((runtimeSource.match(/process\.env\[P1_RESTART_PROBE_ENV\]/g) ?? []).length === 2, "probe env reads drifted outside resolver + requestDrain");
  assert(!runtimeSource.includes("PI_ASTACK_P1_RESTART_PROBE_STATE") && !runtimeSource.includes("requestPush"), "probe gained persistent state or push wiring");
  assert(writerSource.includes('publication.status === "local_durable"') && writerSource.includes("maybePushAbrainAsync"), "writer push guard drifted");
  assert(writerSource.includes("shouldAppendWriterPublicationAudit") && writerSource.includes('publication.reason !== CONTROLLED_STOP_AFTER_PREPARED'), "probe publication can write .state audit");
  assert(writerSource.includes("markP1PreparedStopReached(publication.probeRunId)"), "writer does not establish the process-wide prepared-stop latch");
});

await check("captured Git argv contains no remote operation", () => {
  const calls = fs.readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert(calls.length > 0, "no Git argv captured");
  const forbidden = new Set(["fetch", "push", "pull", "ls-remote"]);
  assert(!calls.some((args) => args.some((arg) => forbidden.has(arg))), `remote Git argv observed: ${JSON.stringify(calls.filter((args) => args.some((arg) => forbidden.has(arg))))}`);
});

await check("active production-equivalent auto_write isolates replay and latches after first prepared candidate", async () => {
  const repo = initRepo("agent-end-isolation");
  const projectRoot = path.join(tmp, "agent-end-project");
  fs.mkdirSync(projectRoot);
  git(projectRoot, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".pi-astack/\n.state/\n");
  fs.writeFileSync(path.join(projectRoot, "base.txt"), "base\n");
  git(projectRoot, "add", ".gitignore", "base.txt");
  execFileSync("git", ["-C", projectRoot, "commit", "-qm", "base"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  });
  process.env.ABRAIN_ROOT = repo;
  const stagingIo = jiti(path.join(root, "extensions/sediment/multiview-staging-io.ts"));
  const pendingCreated = "2026-07-12T00:00:00.000Z";
  const pendingSlug = stagingIo.generateMultiviewPendingSlug({ compiledTruth: "Strict valid pending replay fixture", isoTs: pendingCreated });
  const stagingFile = stagingIo.writeMultiviewPending({
    slug: pendingSlug,
    status: "provisional",
    kind: "multiview-pending",
    created: pendingCreated,
    updated: pendingCreated,
    origin_project_id: "pi-astack",
    origin_project_root: projectRoot,
    originating_device: "p1-restart-probe-fixture",
    multiview_state: "reviewer_unavailable",
    proposer_decision: { op: "create", rationale: "pending replay fixture" },
    proposer_raw_text: '{"op":"create","rationale":"pending replay fixture"}',
    candidate_snapshot: { title: "Pending Replay Fixture", kind: "fact", compiledTruth: "Strict valid pending replay fixture", status: "active", confidence: 4 },
    correction_signal: null,
    neighbor_slugs: [],
    trigger_reason: "review_all_mutations",
    retry_attempts: 2,
    last_attempt_iso: pendingCreated,
  });
  const loadedPending = stagingIo.loadMultiviewPending();
  assert(loadedPending.totalFound === 1 && loadedPending.entries[0]?.slug === pendingSlug && loadedPending.entries[0]?.retry_attempts === 2, `fixture is not a real replay-eligible pending entry: ${JSON.stringify(loadedPending)}`);
  const stagingBefore = fs.readFileSync(stagingFile);

  const headBefore = git(repo, "rev-parse", "HEAD");
  const rawProbe = probe(headBefore, 90);
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  process.env.PI_ABRAIN_NO_AUTOSYNC = "1";
  process.env[ENV_NAME] = rawProbe;
  const sediment = jiti(path.join(root, "extensions/sediment/index.ts"));
  const settingsModule = jiti(path.join(root, "extensions/sediment/settings.ts"));
  const moduleState = sediment._probeIsolationStateForTests();
  assert(moduleState.module.active && moduleState.turn.isolation.active && !moduleState.turn.sideSchedulersEnabled, `fresh module/turn isolation missing: ${JSON.stringify(moduleState)}`);

  delete process.env[ENV_NAME];
  const normalTurn = sediment._probeIsolationStateForTests().turn;
  assert(!normalTurn.isolation.active && normalTurn.sideSchedulersEnabled, `without env side/Lane R scheduling did not return to normal: ${JSON.stringify(normalTurn)}`);
  process.env[ENV_NAME] = "not-json";
  const malformedTurn = sediment._probeIsolationStateForTests().turn;
  process.env[ENV_NAME] = probe(headBefore, 91, "2026-07-12T00:00:00.000Z");
  const expiredTurn = sediment._probeIsolationStateForTests().turn;
  assert(malformedTurn.sideSchedulersEnabled && expiredTurn.sideSchedulersEnabled, "malformed/expired isolation permanently suppressed normal side scheduling");
  process.env[ENV_NAME] = rawProbe;
  const isolation = sediment._probeIsolationStateForTests().turn.isolation;
  const runtime = await runtimeFor(repo);
  assert((await runtime.awaitStartup()).startup === "ready", "auto-write fixture startup failed");

  const memoryBlocks = [1, 2].map((n) => [
    "MEMORY:",
    `title: Probe Auto Candidate ${n}`,
    "kind: fact",
    "status: active",
    "confidence: 4",
    "---",
    `# Probe Auto Candidate ${n}`,
    "",
    `Production-equivalent auto-write candidate ${n} for prepared-stop isolation.`,
    "END_MEMORY",
  ].join("\n")).join("\n\n");
  const decisions = [1, 2].map(() => ({
    decision: { op: "create", rationale: "probe fixture create" },
    neighbors: [],
    audit: { decision: { op: "create", rationale: "probe fixture create" }, neighbors: [], stage_ms: { search: 0, decide: 0, total: 0 } },
  }));
  const windowText = "--- ENTRY 1 probe-turn message/assistant ---\nA durable auto-write observation.";
  const settings = {
    ...settingsModule.DEFAULT_SEDIMENT_SETTINGS,
    enabled: true,
    gitCommit: true,
    autoLlmWriteEnabled: true,
    extractorModel: "fixture/extractor",
    curatorModel: "fixture/curator",
    knowledgeEvidenceEventWriter: { enabled: true, mode: "event_first", legacyFallbackOnEventFailure: false, legacyMarkdownWriteOnSuccessfulEvent: false },
    knowledgeProjector: {
      ...settingsModule.DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector,
      enabled: true,
      hotOverlayEnabled: false,
      projectOnWrite: true,
      l2OutputRoot: "repo",
      projectionMode: "topo",
      canonicalReadMode: "projection_only",
    },
  };
  const deferredBlocks = memoryBlocks;
  const beforeDeferredMutations = repositoryFingerprint(repo);
  const deferredMutations = await sediment._tryAutoWriteLaneForTests({
    cwd: projectRoot,
    sessionId: "probe-deferred-mutations",
    settings,
    window: { entries: [], text: windowText, chars: windowText.length, totalBranchEntries: 1, candidateEntries: 1, includedEntries: 1, checkpointFound: false, lastEntryId: "probe-deferred-turn" },
    modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) },
    correlationId: "probe-deferred-mutations:auto_write:probe-turn",
    abrainHome: repo,
    projectId: "pi-astack",
    probeIsolation: isolation,
    correctionSignal: { signal_found: true, typing: "durable", confidence: 9, is_directive: true, user_quote: "Always defer this Tier1 fixture during the armed probe turn.", provenance: "user-expressed" },
    _testOnly: {
      llmResult: { ok: true, model: "fixture/extractor", rawText: deferredBlocks },
      curatorDecisions: [
        { decision: { op: "create", zone: "rules", injectMode: "listed", ruleScope: "project", rationale: "must defer rule create" }, neighbors: [], audit: { decision: { op: "create", zone: "rules", injectMode: "listed", ruleScope: "project", rationale: "must defer rule create" }, neighbors: [], stage_ms: { search: 0, decide: 0, total: 0 } } },
        { decision: { op: "archive", slug: "nonexistent-status-target", rationale: "must defer status mutation" }, neighbors: [], audit: { decision: { op: "archive", slug: "nonexistent-status-target", rationale: "must defer status mutation" }, neighbors: [], stage_ms: { search: 0, decide: 0, total: 0 } } },
      ],
    },
  });
  assert(deferredMutations.kind === "wrote" && deferredMutations.results.length === 2 && deferredMutations.results.every((result) => result.reason === "p1_probe_isolation_deferred_rule_or_status_mutation"), `Tier1/rule/status mutation was not benignly deferred: ${JSON.stringify(deferredMutations)}`);
  assert(runtimeModule.getP1PreparedStopLatch() === undefined, "deferred Tier1/rule/status path established a stop latch");
  assert((await activeRecoveryRecords(repo)).length === 0, "deferred Tier1/rule/status path wrote canonical recovery evidence");
  assert(repositoryFingerprint(repo) === beforeDeferredMutations, "deferred Tier1/rule/status path mutated canonical state");

  const maintenanceCalls = { l3: 0, embedding: 0 };
  const outcome = await sediment._tryAutoWriteLaneForTests({
    cwd: projectRoot,
    sessionId: "probe-agent-end-session",
    settings,
    window: { entries: [], text: windowText, chars: windowText.length, totalBranchEntries: 1, candidateEntries: 1, includedEntries: 1, checkpointFound: false, lastEntryId: "probe-turn" },
    modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) },
    correlationId: "probe-agent-end-session:auto_write:probe-turn",
    abrainHome: repo,
    projectId: "pi-astack",
    probeIsolation: isolation,
    _testOnly: {
      llmResult: { ok: true, model: "fixture/extractor", rawText: memoryBlocks },
      curatorDecisions: decisions,
      onL3Maintenance: () => { maintenanceCalls.l3 += 1; },
      onEmbeddingMaintenance: () => { maintenanceCalls.embedding += 1; },
    },
  });
  delete process.env[ENV_NAME];
  assert(outcome.kind === "wrote", `auto-write did not reach writer: ${JSON.stringify(outcome)}`);
  assert(outcome.results.length === 1, `multi-candidate batch continued after prepared stop: ${JSON.stringify(outcome.results)}`);
  const publication = outcome.results[0].publication;
  assert(publication?.reason === "CONTROLLED_STOP_AFTER_PREPARED" && publication.probeRunId === runId(90), `controlled publication/latch coordinates missing: ${JSON.stringify(publication)}`);
  const latch = runtimeModule.getP1PreparedStopLatch();
  assert(latch?.runId === runId(90) && latch.state === "prepared_stop_reached" && Object.isFrozen(latch), `process latch invalid: ${JSON.stringify(latch)}`);
  assert(fs.readFileSync(stagingFile).equals(stagingBefore), "pending replay staging bytes/attempts changed during active turn");
  assert(maintenanceCalls.l3 === 0 && maintenanceCalls.embedding === 0, `controlled stop ran L3/embedding maintenance: ${JSON.stringify(maintenanceCalls)}`);
  assert(!fs.existsSync(path.join(repo, ".state", "sediment", "adr0039-l3", "adr0039.sqlite")), "controlled stop ran side L3 sync");
  const records = await activeRecoveryRecords(repo);
  assert(records.length === 2, `controlled stop evidence is not exactly claim+prepared: ${records.map((r) => r.body.event_type)}`);
  assert(JSON.stringify(records.map((r) => r.body.event_type).sort()) === JSON.stringify(["commit_prepared", "recovery_slot_claimed"]), "controlled stop emitted recursive/published/audit recovery events");

  const beforeSecondAgentEnd = crypto.createHash("sha256").update(repositoryFingerprint(repo)).update(fs.readFileSync(stagingFile)).digest("hex");
  const handlers = new Map();
  const fakePi = { on: (name, handler) => handlers.set(name, handler), registerCommand: () => {} };
  const register = sediment.default ?? sediment;
  register(fakePi);
  const agentEnd = handlers.get("agent_end");
  assert(typeof agentEnd === "function", "production agent_end handler was not registered");
  await agentEnd({ messages: [] }, {
    cwd: projectRoot,
    sessionManager: { getBranch: () => [], getSessionId: () => "post-stop-session", getSessionFile: () => path.join(projectRoot, "session.jsonl") },
    ui: { setStatus: () => {}, notify: () => {} },
  });
  const afterSecondAgentEnd = crypto.createHash("sha256").update(repositoryFingerprint(repo)).update(fs.readFileSync(stagingFile)).digest("hex");
  assert(afterSecondAgentEnd === beforeSecondAgentEnd, "post-stop second agent_end changed canonical or staging fingerprint");
  assert(fs.readFileSync(stagingFile).equals(stagingBefore), "post-stop second agent_end changed pending staging bytes/attempts");
  assert(!fs.existsSync(path.join(repo, ".state", "git-sync.jsonl")), "controlled stop appended publication audit or triggered delivery");
  delete process.env.PI_ABRAIN_NO_AUTOSYNC;
  delete process.env.PI_ASTACK_SETTINGS_PATH;
  delete process.env.ABRAIN_ROOT;
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
