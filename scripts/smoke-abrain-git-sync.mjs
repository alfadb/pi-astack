#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const jiti = createJiti(root, { interopDefault: true });
const sync = jiti(path.join(root, "extensions/abrain/git-sync.ts"));
const abrain = jiti(path.join(root, "extensions/abrain/index.ts"));
const canonicalRuntime = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const l2 = jiti(path.join(root, "extensions/_shared/canonical-l2-contract.ts"));
const knowledgeRenderer = jiti(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-native-git-sync-"));
const disabledSettings = path.join(tmp, "settings.json");
const enabledSettings = path.join(tmp, "settings-enabled.json");
const invalidSettings = path.join(tmp, "settings-invalid.json");
fs.writeFileSync(disabledSettings, '{"canonicalGitRuntime":{"enabled":false,"mode":"local_convergence_v2"}}\n');
fs.writeFileSync(enabledSettings, '{"canonicalGitRuntime":{"enabled":true,"mode":"local_convergence_v2"}}\n');
fs.writeFileSync(invalidSettings, '{"canonicalGitRuntime":{"enabled":true,"mode":"invalid"}}\n');
process.env.PI_ASTACK_SETTINGS_PATH = disabledSettings;
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
function commit(repo, message, timestamp = 1700000000) {
  git(repo, "add", "-A");
  execFileSync("git", ["-C", repo, "commit", "-qm", message], { env: { ...process.env, GIT_AUTHOR_NAME: "Sync Fixture", GIT_AUTHOR_EMAIL: "sync@example.invalid", GIT_COMMITTER_NAME: "Sync Fixture", GIT_COMMITTER_EMAIL: "sync@example.invalid", GIT_AUTHOR_DATE: `${timestamp} +0000`, GIT_COMMITTER_DATE: `${timestamp} +0000` } });
  return git(repo, "rev-parse", "HEAD");
}
function createRemoteFixture(name, extraTrackedFiles = 0) {
  const rootDir = path.join(tmp, name); fs.mkdirSync(rootDir);
  const bare = path.join(rootDir, "upstream.git");
  const producer = path.join(rootDir, "producer");
  git(rootDir, "init", "--bare", bare);
  git(rootDir, "clone", bare, producer);
  git(producer, "config", "user.name", "Sync Fixture"); git(producer, "config", "user.email", "sync@example.invalid");
  fs.writeFileSync(path.join(producer, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(producer, "entry.txt"), "one\n");
  if (extraTrackedFiles > 0) {
    const bulk = path.join(producer, "bulk");
    fs.mkdirSync(bulk);
    for (let index = 0; index < extraTrackedFiles; index += 1) {
      fs.writeFileSync(path.join(bulk, `${String(index).padStart(5, "0")}.txt`), `tracked ${index}\n`);
    }
  }
  commit(producer, "initial"); git(producer, "push", "-u", "origin", "HEAD");
  return { rootDir, bare, producer };
}
function cloneDevice(fixture, name = "device") {
  const device = path.join(fixture.rootDir, name);
  git(fixture.rootDir, "clone", fixture.bare, device);
  git(device, "config", "user.name", "Device Fixture"); git(device, "config", "user.email", "device@example.invalid");
  return device;
}
function l1Files(repo) {
  const eventRoot = path.join(repo, "l1/events/sha256");
  const out = [];
  const walk = (dir) => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? walk(path.join(dir, entry.name)) : out.push(path.relative(repo, path.join(dir, entry.name))); };
  walk(eventRoot); return out.sort();
}
function writeKnowledge(repo) {
  const body = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-07-20T05:00:00.000Z",
    device_id: "metadata-prejoin-sync",
    device_event_seq: 1,
    producer_nonce: "metadata-prejoin-sync-1",
    causal_parents: [],
    session_id: "metadata-prejoin-sync",
    turn_id: "turn-1",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: "sediment:auto_write:created:metadata-prejoin-sync" },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: "metadata-prejoin-sync",
      title: "Metadata Prejoin Sync",
      kind: "knowledge",
      status: "active",
      provenance: "synthetic-smoke",
      confidence: 9,
      compiled_truth: "# Metadata Prejoin Sync\n\nSynthetic fixture.",
      trigger_phrases: ["metadata prejoin sync"],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "fixture", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "fixture" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
  const eventId = l1.canonicalL1BodyHash(body);
  const envelope = { schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: eventId, body_hash: eventId, body };
  const relative = l1.expectedL1EventRelativePath(eventId);
  const file = path.join(repo, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  return { eventId, relative, file, body };
}

function writeKnowledgeCohort(repo) {
  const event = writeKnowledge(repo);
  const nodes = [{ eventId: event.eventId, body: event.body }];
  const projection = knowledgeRenderer.renderKnowledgeProjectionFromSet(nodes);
  assert(projection.kind === "entry" && projection.markdown, "Knowledge fixture did not render an entry");
  const entryRelative = l2.canonicalKnowledgeEntryRelativePathV1({
    scopeKind: event.body.scope.kind,
    projectId: event.body.scope.project_id,
    slug: event.body.payload.slug,
  });
  const manifestRelative = l2.canonicalKnowledgeManifestRelativePathV1();
  const entryFile = path.join(repo, ...entryRelative.split("/"));
  const manifestFile = path.join(repo, ...manifestRelative.split("/"));
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.writeFileSync(entryFile, projection.markdown);
  fs.writeFileSync(manifestFile, knowledgeRenderer.renderKnowledgeProjectionManifestFromSet(nodes).json);
  return { ...event, entryRelative, manifestRelative };
}

function startupExtensionChild(device, bare, expectedBacklogPath) {
  const code = `
const {createJiti}=require('jiti');
const cp=require('child_process'),p=require('path');
const root=${JSON.stringify(root)},device=${JSON.stringify(device)},bare=${JSON.stringify(bare)},expected=${JSON.stringify(expectedBacklogPath)};
const git=(cwd,...args)=>cp.execFileSync('git',['-C',cwd,...args],{encoding:'utf8',env:{...process.env,LANG:'C',LC_ALL:'C'}}).trim();
(async()=>{
  const j=createJiti(root,{interopDefault:true});
  const abrain=j(p.join(root,'extensions/abrain/index.ts'));
  const canonical=j(p.join(root,'extensions/_shared/canonical-git-runtime.ts'));
  const handlers=new Map();
  const api={
    on(name,handler){const rows=handlers.get(name)||[];rows.push(handler);handlers.set(name,rows);},
    registerTool(){},registerCommand(){},registerEntryRenderer(){},
    getActiveTools(){return[];},getAllTools(){return[];},setActiveTools(){},
  };
  (abrain.default||abrain)(api);
  const ctx={
    mode:'print',cwd:root,modelRegistry:undefined,
    sessionManager:{getSessionId:()=> 'startup-order-smoke',getSessionFile:()=>p.join(device,'.state/session.jsonl'),getBranch:()=>[],getEntries:()=>[]},
    ui:{notify(){},setStatus(){}},
  };
  for(const handler of handlers.get('session_start')||[])await handler({reason:'startup'},ctx);
  const diagnostics=await canonical.getCanonicalStartupPromise({abrainHome:device});
  if(diagnostics.startup!=='ready')throw new Error('canonical startup blocked: '+diagnostics.blockedReason+' status='+JSON.stringify(git(device,'status','--porcelain=v1','-uall')));
  if(!diagnostics.tail.some(row=>row.operation==='startup'&&row.status==='local_ready'))throw new Error('canonical startup has no local_ready proof');
  const localAfterStartup=git(device,'rev-parse','HEAD');
  cp.execFileSync('git',['-C',device,'cat-file','-e',localAfterStartup+':'+expected]);
  const deadline=Date.now()+30000;
  let remoteHead='';
  while(Date.now()<deadline){
    try{
      remoteHead=cp.execFileSync('git',['--git-dir',bare,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim();
      cp.execFileSync('git',['--git-dir',bare,'cat-file','-e',remoteHead+':'+expected],{stdio:'ignore'});
      break;
    }catch{remoteHead='';await new Promise(resolve=>setTimeout(resolve,25));}
  }
  if(!remoteHead)throw new Error('startup autosync never published canonical backlog');
  cp.execFileSync('git',['--git-dir',bare,'cat-file','-e',remoteHead+':'+expected],{stdio:'ignore'});
  const status=git(device,'status','--porcelain=v1','-uall');
  if(status)throw new Error('startup autosync left dirty state: '+status);
  process.stdout.write(JSON.stringify({startup:diagnostics.startup,localAfterStartup,remoteHead,expected}));
})().catch(error=>{console.error(error);process.exit(1);});`;
  return spawnSync(process.execPath, ["-e", code], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ABRAIN_ROOT: device,
      PI_ASTACK_SETTINGS_PATH: enabledSettings,
      PI_ABRAIN_NO_AUTOSYNC: "0",
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      LANG: "C",
      LC_ALL: "C",
    },
  });
}

console.log("smoke: native transport plus deterministic device join");

await check("exact-OID push targets the configured upstream destination", async () => {
  const fixture = createRemoteFixture("exact-push");
  const device = cloneDevice(fixture);
  fs.appendFileSync(path.join(device, "entry.txt"), "local\n");
  const local = commit(device, "local");
  const event = await sync.pushAsync({ abrainHome: device, jitterMs: 0 });
  assert(event.result === "ok", `push failed: ${JSON.stringify(event)}`);
  assert(event.details?.exactOid === local, `push did not bind exact HEAD oid: ${JSON.stringify(event)}`);
  assert(event.details?.remote === "origin" && event.details?.destination === "refs/heads/main", "push did not use configured branch upstream");
  assert(git(fixture.bare, "rev-parse", "refs/heads/main") === local, "remote did not receive exact local oid");
});

await check("equal fetched OIDs bypass prepare, canonical barrier, whole-tree validation, and push on a large repo", async () => {
  const fixture = createRemoteFixture("large-fetched-oid-noop", 6_000);
  const device = cloneDevice(fixture);
  const stable = git(device, "rev-parse", "HEAD");
  let prepareCalls = 0;
  let publishCalls = 0;
  sync.__setGitSyncOperationOverridesForTests({
    async prepareDeviceJoin() {
      prepareCalls += 1;
      throw new Error("prepareDeviceJoin must be unreachable for equal fetched OIDs");
    },
    async publishPreparedDeviceJoin() {
      publishCalls += 1;
      throw new Error("canonical barrier acquisition must be unreachable for equal fetched OIDs");
    },
  });
  let result;
  const started = performance.now();
  try {
    result = await sync.sync({ abrainHome: device, jitterMs: 0, timeoutMs: 10_000 });
  } finally {
    sync.__setGitSyncOperationOverridesForTests();
  }
  const elapsedMs = performance.now() - started;
  const event = result?.events[0];
  assert(result?.ok && result.events.length === 1, `equal-tip sync did not terminate after fetch: ${JSON.stringify(result)}`);
  assert(event?.op === "fetch" && event.result === "noop" && event.merged === 0, `equal-tip result is not typed noop: ${JSON.stringify(result)}`);
  assert(event.details?.convergence === "fetched_oid_noop" && event.details?.localHead === stable && event.details?.upstreamHead === stable, `noop did not bind fixed equal OIDs: ${JSON.stringify(event)}`);
  assert(prepareCalls === 0 && publishCalls === 0, `noop crossed device-join boundary: ${JSON.stringify({ prepareCalls, publishCalls })}`);
  assert(!result.events.some((candidate) => candidate.op === "push"), "equal-tip noop attempted a push");
  assert(git(device, "rev-parse", "HEAD") === stable && git(fixture.bare, "rev-parse", "refs/heads/main") === stable, "equal-tip noop moved a ref");
  assert(elapsedMs < 3_000 && (event.durationMs ?? Infinity) < 3_000, `equal-tip large-repo noop exceeded 3s: wall=${elapsedMs.toFixed(1)} event=${event.durationMs}`);
});

await check("canonical session_start drains dirty backlog before launching device sync", async () => {
  const fixture = createRemoteFixture("startup-order");
  const device = cloneDevice(fixture);
  const before = git(device, "rev-parse", "HEAD");
  const knowledge = writeKnowledgeCohort(device);
  assert(git(fixture.bare, "rev-parse", "refs/heads/main") === before, "startup-order fixture did not begin at equal tips");
  const child = startupExtensionChild(device, fixture.bare, knowledge.relative);
  assert(!child.error, `startup-order child did not execute: ${child.error?.message}`);
  assert(child.status === 0, `startup-order child failed:\n${child.stderr}`);
  const result = JSON.parse(child.stdout);
  assert(result.startup === "ready" && result.localAfterStartup !== before, `canonical startup did not drain backlog first: ${child.stdout}`);
  assert(git(fixture.bare, "cat-file", "-e", `refs/heads/main:${knowledge.relative}`) === "", "remote does not contain startup-drained backlog");
  assert(git(device, "status", "--porcelain=v1", "-uall") === "", "startup-order integration left the device dirty");
});

await check("invalid canonical settings stop join before ref/index publication", async () => {
  const fixture = createRemoteFixture("invalid-settings");
  const device = cloneDevice(fixture);
  fs.appendFileSync(path.join(fixture.producer, "entry.txt"), "remote\n");
  commit(fixture.producer, "remote update", 1700000001);
  git(fixture.producer, "push");
  const beforeHead = git(device, "rev-parse", "HEAD");
  const beforeIndex = git(device, "ls-files", "--stage", "-z");
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  process.env.PI_ASTACK_SETTINGS_PATH = invalidSettings;
  let event;
  try { event = await sync.fetchAndFF({ abrainHome: device, timeoutMs: 30_000 }); }
  finally { process.env.PI_ASTACK_SETTINGS_PATH = previousSettings ?? disabledSettings; }
  assert(event?.result === "failed" && event.reason === "CANONICAL_GIT_SETTINGS_INVALID", `invalid settings did not fail closed: ${JSON.stringify(event)}`);
  assert(git(device, "rev-parse", "HEAD") === beforeHead, "invalid settings advanced the local ref");
  assert(git(device, "ls-files", "--stage", "-z") === beforeIndex && git(device, "status", "--porcelain=v1", "-uall") === "", "invalid settings changed index/worktree state");
});

await check("writer delivery fetches and joins remote divergence before its exact-OID push", async () => {
  const fixture = createRemoteFixture("writer-convergence");
  const device = cloneDevice(fixture);
  fs.writeFileSync(path.join(fixture.producer, "remote.txt"), "remote\n");
  const remote = commit(fixture.producer, "remote side", 1700000001);
  git(fixture.producer, "push");
  fs.writeFileSync(path.join(device, "local.txt"), "local\n");
  const local = commit(device, "local side", 1700000002);
  const event = await sync.pushAsync({ abrainHome: device, jitterMs: 0 });
  assert(event.op === "push" && event.result === "ok", `writer delivery did not finish with a push: ${JSON.stringify(event)}`);
  const joined = git(device, "rev-parse", "HEAD");
  assert(joined !== local && joined !== remote, "writer delivery skipped the divergent join");
  assert(git(fixture.bare, "rev-parse", "refs/heads/main") === joined, "writer delivery did not push the joined oid");
  assert(fs.readFileSync(path.join(device, "local.txt"), "utf8") === "local\n" && fs.readFileSync(path.join(device, "remote.txt"), "utf8") === "remote\n", "writer join lost one side");
});

await check("enabled sync checkpoints metadata before divergent join and reaches 0/0 after exact push", async () => {
  const fixture = createRemoteFixture("metadata-prejoin-divergence");
  const device = cloneDevice(fixture);
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  process.env.PI_ASTACK_SETTINGS_PATH = enabledSettings;
  try {
    const runtime = await canonicalRuntime.getCanonicalGitRuntime({ abrainHome: device, settingsPath: enabledSettings, sourceRoot: root });
    assert((await runtime.awaitStartup()).startup === "ready", "enabled metadata prejoin startup failed");
    const knowledge = writeKnowledge(device);
    const receipt = await canonicalRuntime.createProducedArtifactReceipt({ abrainHome: device, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
    const drained = await runtime.requestDrain([receipt], "metadata prejoin sync fixture");
    assert(drained.status === "index_converged" && drained.commit && drained.episodeId, `canonical fixture drain failed: ${JSON.stringify(drained)}`);
    const scan = await l1.scanWholeL1Validated({ abrainHome: device });
    const metadataTail = scan.selected
      .filter((record) => record.registration.envelope_schema === "local-drain-recovery-envelope/v3" && record.body.episode_id === drained.episodeId)
      .map((record) => record.relativePath)
      .sort();
    assert(metadataTail.length === 4, `canonical fixture did not leave four recovery events: ${metadataTail.length}`);

    fs.writeFileSync(path.join(fixture.producer, "remote-after-local-drain.txt"), "remote divergence\n");
    const remote = commit(fixture.producer, "remote after local drain", 1700000011);
    git(fixture.producer, "push");
    const synced = await sync.sync({ abrainHome: device, jitterMs: 0, timeoutMs: 30_000, maxAttempts: 3 });
    assert(synced.ok, `metadata prejoin sync failed: ${JSON.stringify(synced)}`);
    const checkpoints = git(device, "log", "--all", "--format=%H", "--grep=local-drain-metadata-checkpoint/v1").split("\n").filter(Boolean);
    assert(checkpoints.length === 1, `sync did not publish exactly one metadata checkpoint: ${checkpoints.length}`);
    const checkpointPaths = git(device, "diff-tree", "--no-commit-id", "--name-only", "-r", checkpoints[0]).split("\n").filter(Boolean).sort();
    assert(JSON.stringify(checkpointPaths) === JSON.stringify(metadataTail), `sync checkpoint cohort is not exact: ${JSON.stringify(checkpointPaths)}`);
    assert(git(device, "merge-base", "--is-ancestor", checkpoints[0], "HEAD") === "" && git(device, "merge-base", "--is-ancestor", remote, "HEAD") === "", "joined HEAD omitted checkpoint or remote divergence");
    assert(git(device, "status", "--porcelain=v1", "-uall") === "", "metadata prejoin sync left a dirty device");
    const divergence = await sync.getAheadBehind(device);
    assert(divergence.ahead === 0 && divergence.behind === 0, `metadata prejoin exact push did not reach 0/0: ${JSON.stringify(divergence)}`);
  } finally {
    process.env.PI_ASTACK_SETTINGS_PATH = previousSettings ?? disabledSettings;
  }
});

await check("fetch plus fast-forward materializes upstream and no-op remains stable", async () => {
  const fixture = createRemoteFixture("fast-forward");
  const device = cloneDevice(fixture);
  fs.appendFileSync(path.join(fixture.producer, "entry.txt"), "two\n"); commit(fixture.producer, "remote update", 1700000001); git(fixture.producer, "push");
  const changed = await sync.sync({ abrainHome: device, jitterMs: 0 });
  const changedFetch = changed.events.find((event) => event.op === "fetch");
  assert(changed.ok && changedFetch?.result === "ok" && changedFetch.merged === 1 && changedFetch.details?.convergence === "fast_forward", `fast-forward join failed: ${JSON.stringify(changed)}`);
  assert(fs.readFileSync(path.join(device, "entry.txt"), "utf8") === "one\ntwo\n", "upstream bytes were not materialized");
  const stable = git(device, "rev-parse", "HEAD");
  const noop = await sync.sync({ abrainHome: device, jitterMs: 0 });
  const noopFetch = noop.events.find((event) => event.op === "fetch");
  assert(noop.ok && noop.events.length === 1 && noopFetch?.result === "noop" && noopFetch.merged === 0 && git(device, "rev-parse", "HEAD") === stable, `no-op sync drifted: ${JSON.stringify(noop)}`);
});

await check("real converged fetch event drives constraint refresh and no-op does not", async () => {
  const fixture = createRemoteFixture("constraint-refresh");
  const device = cloneDevice(fixture);
  fs.appendFileSync(path.join(fixture.producer, "entry.txt"), "remote\n"); commit(fixture.producer, "remote", 1700000002); git(fixture.producer, "push");
  const modelRegistry = { find() {}, getApiKeyAndHeaders: async () => ({ ok: true }) };
  const scheduled = [];
  const consume = (event) => abrain.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(event, {
    abrainHome: device,
    cwd: device,
    modelRegistry,
    resolveSettings: () => ({ constraintShadowCompiler: { enabled: true, autoRefresh: { enabled: true } } }),
    listProjectIds: () => [],
    schedule: (trigger) => { scheduled.push(trigger); return { scheduled: true, reason: "integration_scheduled" }; },
  });
  const changed = await sync.sync({ abrainHome: device, jitterMs: 0 });
  const changedFetch = changed.events.find((event) => event.op === "fetch");
  assert(changedFetch?.result === "ok" && changedFetch.merged === 1, "changed fetch event is inaccurate");
  assert((await consume(changedFetch)).scheduled && scheduled.length === 1, "changed convergence did not schedule refresh");
  const noop = await sync.sync({ abrainHome: device, jitterMs: 0 });
  const noopFetch = noop.events.find((event) => event.op === "fetch");
  assert(noopFetch?.result === "noop" && noopFetch.merged === 0, "no-op fetch event is inaccurate");
  assert(!(await consume(noopFetch)).scheduled && scheduled.length === 1, "no-op convergence scheduled refresh");
});

await check("network and rejection failures are fail-soft, audited, and L1-neutral", async () => {
  const fixture = createRemoteFixture("fail-soft");
  const device = cloneDevice(fixture);
  const before = l1Files(device);
  git(device, "remote", "set-url", "origin", path.join(fixture.rootDir, "missing.git"));
  const network = await sync.fetchAndFF({ abrainHome: device, timeoutMs: 5_000 });
  assert(network.result === "failed" && network.error, `network failure was not typed: ${JSON.stringify(network)}`);
  const authHelper = path.join(fixture.rootDir, "auth-helper.sh");
  fs.writeFileSync(authHelper, "#!/bin/sh\necho Authentication failed >&2\nexit 1\n", { mode: 0o755 });
  git(device, "remote", "set-url", "origin", `ext::${authHelper}`);
  const previousProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "ext";
  let auth;
  try { auth = await sync.fetchAndFF({ abrainHome: device, timeoutMs: 5_000 }); }
  finally { if (previousProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL; else process.env.GIT_ALLOW_PROTOCOL = previousProtocol; }
  assert(auth?.result === "failed" && /Authentication failed/.test(auth.error ?? ""), `auth failure was not fail-soft: ${JSON.stringify(auth)}`);
  git(device, "remote", "set-url", "origin", fixture.bare);
  const hook = path.join(fixture.bare, "hooks/pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho rejected-by-smoke >&2\nexit 1\n", { mode: 0o755 });
  fs.appendFileSync(path.join(device, "entry.txt"), "local\n"); commit(device, "local rejected");
  const rejected = await sync.pushAsync({ abrainHome: device, maxAttempts: 1, jitterMs: 0 });
  assert(rejected.result === "push_rejected" && /rejected/i.test(rejected.error ?? ""), `push rejection was not typed: ${JSON.stringify(rejected)}`);
  assert(JSON.stringify(l1Files(device)) === JSON.stringify(before), "delivery failure wrote L1");
  const audit = fs.readFileSync(path.join(device, ".state/git-sync.jsonl"), "utf8");
  assert(audit.includes("Authentication failed") && audit.includes('"result":"failed"') && audit.includes('"result":"push_rejected"'), "fail-soft audit rows missing");
});

await check("generic transport timeout remains fail-soft", async () => {
  const fixture = createRemoteFixture("timeout");
  const device = cloneDevice(fixture);
  const helper = path.join(fixture.rootDir, "sleep-helper.sh");
  fs.writeFileSync(helper, "#!/bin/sh\nsleep 2\nexit 1\n", { mode: 0o755 });
  git(device, "remote", "set-url", "origin", `ext::${helper}`);
  const previous = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "ext";
  try {
    const result = await sync.fetchAndFF({ abrainHome: device, timeoutMs: 20 });
    assert(result.result === "timeout", `timeout misclassified: ${JSON.stringify(result)}`);
  } finally {
    if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL; else process.env.GIT_ALLOW_PROTOCOL = previous;
  }
});

await check("source keeps the deterministic protocol boundary explicit", () => {
  const nativeSource = fs.readFileSync(path.join(root, "extensions/abrain/git-sync.ts"), "utf8");
  const coordinator = fs.readFileSync(path.join(root, "extensions/_shared/device-join-coordinator.ts"), "utf8");
  const callerSource = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
  const combined = `${nativeSource}\n${coordinator}`;
  for (const forbidden of ['["merge-tree"', '["rebase"', '["merge", "--ff-only"', '["push", "--force"']) assert(!combined.includes(forbidden), `sync source invokes forbidden strategy ${forbidden}`);
  assert(nativeSource.includes("prepareDeviceJoin") && nativeSource.includes("publishPreparedDeviceJoin"), "git-sync bypasses device join coordinator");
  assert(nativeSource.includes("`${oid}:${target.mergeRef}`"), "push is not exact-OID refspec publication");
  assert(callerSource.includes("gitSync({ abrainHome: ABRAIN_HOME })") && callerSource.includes('fetchEvent?.result === "conflict"'), "startup caller does not consume typed join conflicts");
  assert(!callerSource.includes("fetchAndFF({ abrainHome: ABRAIN_HOME })"), "startup restored split fetch behavior");
});

await check("targeted tsc reports no new git-sync/device-join diagnostics", () => {
  const tsc = path.join(root, "node_modules/.bin/tsc");
  const result = spawnSync(tsc, [
    "--noEmit", "--pretty", "false", "--target", "ES2022", "--module", "commonjs",
    "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--ignoreDeprecations", "6.0",
    "extensions/abrain/git-sync.ts", "extensions/_shared/device-join-coordinator.ts", "extensions/_shared/canonical-mutation-barrier.ts",
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  assert(!result.error, `targeted tsc did not execute: ${result.error?.message}`);
  const diagnostics = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter((line) => /(?:git-sync|device-join-coordinator|canonical-mutation-barrier)\.ts/.test(line));
  assert(diagnostics.length === 0, `new targeted type diagnostics:\n${diagnostics.join("\n")}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
