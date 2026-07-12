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
const cohort = jiti(path.join(root, "extensions/_shared/git-exact-cohort.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const fixture = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/legacy-drain-recovery-v1.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-local-runtime-v2-"));
let passed = 0;
const failures = [];

function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`); }
}
function git(repo, ...args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } }).trim(); }
function initRepo(name) {
  const repo = path.join(tmp, name); fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".gitignore", "base.txt");
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"], { env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" } });
  return repo;
}
function settings(name, enabled, extra = {}) {
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ canonicalGitRuntime: { enabled, mode: "local_convergence_v2", ...extra } }, null, 2)}\n`);
  return file;
}
function writeEnvelope(repo, envelope) {
  const file = path.join(repo, l1.expectedL1EventRelativePath(envelope.event_id));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`); return file;
}
function knowledgeBody(seq) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-12T04:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "canonical-runtime-smoke",
    device_event_seq: seq,
    producer_nonce: `canonical-runtime-smoke-${seq}`,
    causal_parents: [],
    session_id: "canonical-runtime-smoke-session",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: `sediment:auto_write:created:runtime-${seq}` },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: `canonical-runtime-smoke-${seq}`,
      title: `Canonical Runtime Smoke ${seq}`,
      kind: "knowledge",
      status: "active",
      provenance: "synthetic-smoke",
      confidence: 9,
      compiled_truth: `# Canonical Runtime Smoke ${seq}\n\nSynthetic fixture.`,
      trigger_phrases: ["canonical runtime smoke"],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "fixture", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "synthetic fixture" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
}
function writeKnowledge(repo, seq) {
  const body = knowledgeBody(seq);
  const eventId = l1.canonicalL1BodyHash(body);
  const envelope = { schema: "knowledge-evidence-envelope/v1", canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: eventId, body_hash: eventId, body };
  const file = writeEnvelope(repo, envelope);
  return { eventId, file, relativePath: l1.expectedL1EventRelativePath(eventId) };
}
function startupChild(repo, config = sharedEnabledSettings) {
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const m=j(p.join(${JSON.stringify(root)},'extensions/_shared/canonical-git-runtime.ts'));const r=await m.getCanonicalGitRuntime({abrainHome:${JSON.stringify(repo)},settingsPath:${JSON.stringify(config)},sourceRoot:${JSON.stringify(root)}});process.stdout.write(JSON.stringify(await r.awaitStartup()));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 });
}
function canonicalWriterApiChild(repo, config, lane) {
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const m=j(p.join(${JSON.stringify(root)},'extensions/_shared/canonical-git-runtime.ts'));const w=j(p.join(${JSON.stringify(root)},'extensions/sediment/writer.ts'));const r=await m.getCanonicalGitRuntime({abrainHome:${JSON.stringify(repo)}});const startup=await r.awaitStartup();if(startup.startup!=='ready')throw new Error(startup.blockedReason);const settings={gitCommit:true,lockTimeoutMs:5000};const result=${JSON.stringify(lane)}==='workflow'?await w.writeAbrainWorkflow({title:'Canonical Workflow',trigger:'canonical writer smoke',body:'A real workflow writer transaction used by the canonical runtime smoke.',crossProject:true,sessionId:'canonical-writer-smoke'},{abrainHome:${JSON.stringify(repo)},settings}):await w.writeAbrainAboutMe({title:'Canonical About Me',body:'A real about-me writer transaction used by the canonical runtime smoke.',region:'identity',routingConfidence:0.95,routeCandidates:['identity'],routingReason:'canonical-writer-smoke',sessionId:'canonical-writer-smoke'},{abrainHome:${JSON.stringify(repo)},settings});process.stdout.write(JSON.stringify(result));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env: { ...process.env, PI_ASTACK_SETTINGS_PATH: config, PI_ABRAIN_NO_AUTOSYNC: "1", LANG: "C", LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 });
}
function canonicalBindHelperChild(repo, config) {
  const code = `const {createJiti}=require('jiti');const fs=require('fs'),p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const m=j(p.join(${JSON.stringify(root)},'extensions/_shared/canonical-git-runtime.ts'));const a=j(p.join(${JSON.stringify(root)},'extensions/abrain/index.ts'));const r=await m.getCanonicalGitRuntime({abrainHome:${JSON.stringify(repo)}});const startup=await r.awaitStartup();if(startup.startup!=='ready')throw new Error(startup.blockedReason);const rel='projects/canonical-bind/_project.json';fs.mkdirSync(p.dirname(p.join(${JSON.stringify(repo)},rel)),{recursive:true});fs.writeFileSync(p.join(${JSON.stringify(repo)},rel),'{"project_id":"canonical-bind"}\\n');process.stdout.write(JSON.stringify(await a.canonicalAutoCommitAbrainPaths(${JSON.stringify(repo)},[rel],'project: add canonical-bind')));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env: { ...process.env, PI_ASTACK_SETTINGS_PATH: config, PI_ABRAIN_NO_AUTOSYNC: "1", LANG: "C", LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 });
}
function canonicalDeferredWriterChild(repo, config, file) {
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const w=j(p.join(${JSON.stringify(root)},'extensions/sediment/writer.ts'));const publications=[];for(let i=0;i<2;i++)publications.push(await w.commitAbrainDerivedOutputs(${JSON.stringify(repo)},'metadata-deferred-noop',[${JSON.stringify(file)}]));process.stdout.write(JSON.stringify(publications));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env: { ...process.env, PI_ASTACK_SETTINGS_PATH: config, PI_ABRAIN_NO_AUTOSYNC: "1", LANG: "C", LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 });
}
function canonicalDeferredBindChild(repo, config, rel) {
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const a=j(p.join(${JSON.stringify(root)},'extensions/abrain/index.ts'));const results=[];for(let i=0;i<2;i++)results.push(await a.canonicalAutoCommitAbrainPaths(${JSON.stringify(repo)},[${JSON.stringify(rel)}],'project: noop canonical-bind'));process.stdout.write(JSON.stringify(results));})().catch(e=>{console.error(e);process.exit(1)});`;
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env: { ...process.env, PI_ASTACK_SETTINGS_PATH: config, PI_ABRAIN_NO_AUTOSYNC: "1", LANG: "C", LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 });
}
async function activeRecoveryRecords(repo) {
  const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
  return scan.selected.filter((record) => record.registration.envelope_schema === "local-drain-recovery-envelope/v2");
}
function repositoryFingerprint(repo) {
  const head = git(repo, "rev-parse", "HEAD");
  const status = git(repo, "status", "--porcelain=v1", "-z", "-uall");
  const index = git(repo, "ls-files", "--stage", "-z");
  const events = [];
  const eventRoot = path.join(repo, "l1", "events", "sha256");
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isDirectory()) walk(file);
      else events.push(`${path.relative(repo, file)}:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`);
    }
  };
  walk(eventRoot);
  return crypto.createHash("sha256").update(JSON.stringify({ head, status, index, events })).digest("hex");
}

console.log("smoke: canonical local Git runtime v2");
const sharedEnabledSettings = settings("shared-enabled", true);

await check("settings accept only disabled/enabled local_convergence_v2 shape", () => {
  const disabled = settings("disabled", false);
  assert(runtimeModule.canonicalGitRuntimeEnabled(disabled) === false, "disabled did not remain false");
  const enabled = settings("enabled-shape", true);
  assert(runtimeModule.canonicalGitRuntimeEnabled(enabled) === true, "enabled shape rejected");
  for (const [name, config] of [
    ["wrong-mode", { enabled: false, mode: "p1_controlled" }],
    ["transport", { enabled: false, mode: "local_convergence_v2", transport: {} }],
    ["unknown", { enabled: false, mode: "local_convergence_v2", extra: true }],
  ]) {
    const file = path.join(tmp, `${name}.json`); fs.writeFileSync(file, JSON.stringify({ canonicalGitRuntime: config }));
    let failed = false; try { runtimeModule.canonicalGitRuntimeEnabled(file); } catch (error) { failed = error.code === "CANONICAL_GIT_SETTINGS_INVALID"; }
    assert(failed, `${name} did not fail closed`);
  }
  const schema = JSON.parse(fs.readFileSync(path.join(root, "pi-astack-settings.schema.json"), "utf8")).properties.canonicalGitRuntime;
  assert(JSON.stringify(schema.required) === JSON.stringify(["enabled", "mode"]), "schema required shape drifted");
  assert(!Object.hasOwn(schema.properties, "transport") && schema.properties.mode.const === "local_convergence_v2", "schema retained transport/old mode");
});

await check("runtime source has no remote operation/import boundary", () => {
  const source = fs.readFileSync(path.join(root, "extensions/_shared/canonical-git-runtime.ts"), "utf8");
  for (const forbidden of ["canonical-git-transport", "legacy-terminal-resolver", "ls-remote", "requestPush", "verifyRemoteConvergence", "git-sync.jsonl"]) assert(!source.includes(forbidden), `runtime contains ${forbidden}`);
  assert(!/\[\s*["']fetch["']|\[\s*["']push["']/.test(source), "runtime invokes fetch/push");
});

await check("enabled startup executes local Git only", async () => {
  const repo = initRepo("startup-capture");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const captureDir = path.join(tmp, "capture-bin"); fs.mkdirSync(captureDir);
  const captureLog = path.join(tmp, "runtime-git-argv.jsonl");
  const wrapper = path.join(captureDir, "git");
  fs.writeFileSync(wrapper, `#!/usr/bin/env node\nconst fs=require('fs'),cp=require('child_process');const a=process.argv.slice(2);fs.appendFileSync(process.env.RUNTIME_GIT_CAPTURE,JSON.stringify(a)+'\\n');const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${captureDir}${path.delimiter}${oldPath ?? ""}`;
  process.env.RUNTIME_GIT_CAPTURE = captureLog;
  try {
    const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
    const startup = await runtime.awaitStartup();
    assert(startup.startup === "ready", `captured startup blocked: ${startup.blockedReason}`);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.RUNTIME_GIT_CAPTURE;
  }
  const calls = fs.readFileSync(captureLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert(calls.length > 0, "startup issued no local Git commands");
  assert(!calls.some((args) => args.includes("fetch") || args.includes("push") || args.includes("ls-remote")), `startup touched remote: ${JSON.stringify(calls)}`);
});

await check("legacy residue is excluded while startup commits strict Knowledge content", async () => {
  const repo = initRepo("legacy-startup");
  let candidatePath;
  for (const envelope of fixture.envelopes) {
    const file = writeEnvelope(repo, envelope);
    if (envelope.event_id === fixture.candidate_event_id) candidatePath = file;
  }
  const knowledge = writeKnowledge(repo, 1);
  const headBefore = git(repo, "rev-parse", "HEAD");
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "ready", `legacy startup blocked: ${startup.blockedReason}`);
  const commit = git(repo, "rev-parse", "HEAD");
  assert(commit !== headBefore, "startup did not commit Knowledge backlog");
  const rel = path.relative(repo, candidatePath).split(path.sep).join("/");
  assert(git(repo, "status", "--porcelain", "--", rel).startsWith("?? "), "legacy candidate was tracked or removed");
  const committedPaths = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
  assert(committedPaths.includes(knowledge.relativePath) && !committedPaths.includes(rel), "startup cohort mixed legacy residue or omitted Knowledge");
});

await check("malformed v1 still blocks whole runtime startup", async () => {
  const repo = initRepo("malformed-startup");
  const bad = structuredClone(fixture.envelopes[0]);
  bad.body.body.extra = true; bad.body_hash = l1.canonicalL1BodyHash(bad.body); bad.event_id = bad.body_hash;
  writeEnvelope(repo, bad);
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "blocked" && /L1_BODY_SHAPE_MISMATCH/.test(startup.blockedReason ?? ""), "malformed v1 did not block startup");
});

await check("steady-state strict Knowledge writes create current and next generations", async () => {
  const repo = initRepo("steady");
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  assert((await runtime.awaitStartup()).startup === "ready", "clean startup failed");
  const episodes = [];
  for (const seq of [2, 3]) {
    const knowledge = writeKnowledge(repo, seq);
    const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
    const result = await runtime.requestDrain([receipt], `caller message ${seq}`);
    assert(result.status === "index_converged" && result.commit, `drain failed: ${JSON.stringify(result)}`);
    episodes.push(result.episodeId);
  }
  assert(episodes[0] !== episodes[1], "converged generation did not derive next generation for later Knowledge content");
  assert(git(repo, "log", "-1", "--format=%B").startsWith("pi-astack local drain"), "caller message entered commit");
});

await check("startup content backlog opens one generation and absorbs the prior metadata tail exactly", async () => {
  const repo = initRepo("startup-content-backlog");
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  assert((await runtime.awaitStartup()).startup === "ready", "initial startup failed");
  const first = writeKnowledge(repo, 4);
  const firstReceipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: first.file, sourceIds: [first.eventId] });
  const firstDrain = await runtime.requestDrain([firstReceipt], "first generation");
  assert(firstDrain.status === "index_converged" && firstDrain.commit && firstDrain.episodeId, "first generation did not converge");
  const oldTail = (await activeRecoveryRecords(repo)).filter((record) => record.body.episode_id === firstDrain.episodeId).map((record) => record.relativePath).sort();
  assert(oldTail.length === 4, `first generation metadata tail is not exact: ${oldTail.length}`);
  const second = writeKnowledge(repo, 5);
  const child = startupChild(repo);
  assert(child.status === 0, `startup child failed: ${child.stderr}`);
  const diagnostics = JSON.parse(child.stdout);
  assert(diagnostics.startup === "ready", `startup content backlog blocked: ${diagnostics.blockedReason}`);
  const secondCommit = git(repo, "rev-parse", "HEAD");
  assert(secondCommit !== firstDrain.commit, "startup did not open one new generation");
  const committedPaths = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", secondCommit).split("\n").filter(Boolean).sort();
  assert(JSON.stringify(committedPaths) === JSON.stringify([...oldTail, second.relativePath].sort()), `mixed startup cohort is not exact: ${JSON.stringify(committedPaths)}`);
  const prepared = (await activeRecoveryRecords(repo)).filter((record) => record.body.event_type === "commit_prepared" && record.body.body.candidate === secondCommit);
  assert(prepared.length === 1 && prepared[0].body.episode_id !== firstDrain.episodeId, "startup content backlog did not derive exactly one generation");

  const stableBefore = repositoryFingerprint(repo);
  for (let restart = 0; restart < 2; restart += 1) {
    const metadataRestart = startupChild(repo);
    assert(metadataRestart.status === 0, `metadata-only restart ${restart + 1} failed: ${metadataRestart.stderr}`);
    const metadataDiagnostics = JSON.parse(metadataRestart.stdout);
    assert(metadataDiagnostics.startup === "ready", `metadata-only restart ${restart + 1} blocked`);
    assert(metadataDiagnostics.tail.some((row) => row.operation === "startup_backlog" && row.status === "metadata_deferred"), `restart ${restart + 1} lacks metadata_deferred diagnostic`);
    assert(repositoryFingerprint(repo) === stableBefore, `metadata-only restart ${restart + 1} changed HEAD/events/claims`);
  }
});

await check("steady writer_transaction commits exactly, then Knowledge opens the next generation and absorbs its metadata tail", async () => {
  const repo = initRepo("writer-transaction-generation");
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  assert((await runtime.awaitStartup()).startup === "ready", "writer transaction startup failed");
  const file = path.join(repo, "writer.txt");
  fs.writeFileSync(file, "writer transaction\n");
  const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: file, sourceIds: ["fixture:writer"] });
  assert(receipt.owner === "writer_transaction", `writer owner mapping drifted: ${receipt.owner}`);
  const writerDrain = await runtime.requestDrain([receipt], "writer transaction only");
  assert(writerDrain.status === "index_converged" && writerDrain.commit && writerDrain.episodeId, `writer transaction was not exact committed: ${JSON.stringify(writerDrain)}`);
  const writerPaths = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", writerDrain.commit).split("\n").filter(Boolean);
  assert(JSON.stringify(writerPaths) === JSON.stringify(["writer.txt"]), `writer commit cohort was not exact: ${JSON.stringify(writerPaths)}`);
  assert(git(repo, "ls-files", "--error-unmatch", "writer.txt") === "writer.txt", "writer path did not index-converge");
  const predecessorTail = (await activeRecoveryRecords(repo)).filter((record) => record.body.episode_id === writerDrain.episodeId).map((record) => record.relativePath).sort();
  assert(predecessorTail.length === 4, `writer predecessor metadata tail is not exact: ${predecessorTail.length}`);

  const knowledge = writeKnowledge(repo, 7);
  const knowledgeReceipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
  const knowledgeDrain = await runtime.requestDrain([knowledgeReceipt], "Knowledge after writer");
  assert(knowledgeDrain.status === "index_converged" && knowledgeDrain.commit && knowledgeDrain.episodeId !== writerDrain.episodeId, `Knowledge did not open the next generation: ${JSON.stringify(knowledgeDrain)}`);
  const knowledgePaths = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", knowledgeDrain.commit).split("\n").filter(Boolean).sort();
  assert(JSON.stringify(knowledgePaths) === JSON.stringify([...predecessorTail, knowledge.relativePath].sort()), `Knowledge generation did not absorb the predecessor metadata tail exactly: ${JSON.stringify(knowledgePaths)}`);
});

await check("noop content receipt plus metadata tail stays deferred and writer publication stays clean", async () => {
  const repo = initRepo("steady-metadata-deferred");
  const config = settings("steady-metadata-deferred", true);
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  assert((await runtime.awaitStartup()).startup === "ready", "metadata-deferred startup failed");
  const knowledge = writeKnowledge(repo, 8);
  const firstReceipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
  const firstDrain = await runtime.requestDrain([firstReceipt], "close generation before noop receipt");
  assert(firstDrain.status === "index_converged" && firstDrain.commit && firstDrain.episodeId, `fixture generation did not close: ${JSON.stringify(firstDrain)}`);
  const metadataTail = (await activeRecoveryRecords(repo)).filter((record) => record.body.episode_id === firstDrain.episodeId);
  assert(metadataTail.length === 4, `closed generation did not leave the exact metadata tail: ${metadataTail.length}`);

  const stableFingerprint = repositoryFingerprint(repo);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const noopReceipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: knowledge.file, sourceIds: [knowledge.eventId] });
    const deferred = await runtime.requestDrain([noopReceipt], `noop content receipt ${attempt + 1}`);
    assert(deferred.status === "metadata_deferred" && deferred.localCommit === "not_published", `steady noop did not defer metadata: ${JSON.stringify(deferred)}`);
    assert(!Object.hasOwn(deferred, "commit"), `metadata_deferred exposed frozen HEAD as a commit: ${JSON.stringify(deferred)}`);
    assert(repositoryFingerprint(repo) === stableFingerprint, `steady noop ${attempt + 1} changed L1/status/HEAD/index`);
  }
  assert(runtime.diagnostics().tail.filter((row) => row.operation === "drain" && row.action === "metadata_deferred").length >= 2, "steady metadata_deferred diagnostics were lost");

  const publicationAudit = path.join(repo, ".state", "git-sync.jsonl");
  const auditBefore = fs.existsSync(publicationAudit) ? fs.readFileSync(publicationAudit, "utf8") : null;
  const writer = canonicalDeferredWriterChild(repo, config, knowledge.file);
  assert(writer.status === 0, `deferred writer child failed: ${writer.stderr || writer.stdout}`);
  const publications = JSON.parse(writer.stdout);
  assert(publications.length === 2, "writer public API did not repeat the deferred publication twice");
  for (const publication of publications) {
    assert(publication.status === "clean" && publication.commit === null && publication.localCommit === "not_published" && publication.drainStatus === "metadata_deferred" && publication.canonical === true, `writer deferred publication was not clean: ${JSON.stringify(publication)}`);
  }
  const auditAfter = fs.existsSync(publicationAudit) ? fs.readFileSync(publicationAudit, "utf8") : null;
  assert(auditAfter === auditBefore, "metadata_deferred appended a writer publication audit");
  assert(fs.existsSync(knowledge.file), "clean deferred publication triggered writer cleanup");
  assert(repositoryFingerprint(repo) === stableFingerprint, "repeated writer publication changed L1/status/HEAD/index");
});

await check("canonical bind helper treats repeated metadata-deferred drains as clean", async () => {
  const repo = initRepo("canonical-bind-deferred");
  const config = settings("canonical-bind-deferred", true);
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  assert((await runtime.awaitStartup()).startup === "ready", "bind deferred startup failed");
  const rel = "projects/canonical-bind/_project.json";
  const file = path.join(repo, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"project_id":"canonical-bind"}\n');
  const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: file, sourceIds: [`abrain-bind:${rel}`] });
  const firstDrain = await runtime.requestDrain([receipt], "close bind generation");
  assert(firstDrain.status === "index_converged" && firstDrain.commit, `bind fixture did not close: ${JSON.stringify(firstDrain)}`);
  const stableFingerprint = repositoryFingerprint(repo);

  const child = canonicalDeferredBindChild(repo, config, rel);
  assert(child.status === 0, `deferred bind child failed: ${child.stderr || child.stdout}`);
  const results = JSON.parse(child.stdout);
  assert(results.length === 2, "bind helper did not repeat twice");
  for (const result of results) {
    assert(result.status === "clean" && !Object.hasOwn(result, "commitSha"), `bind helper queued or published metadata_deferred: ${JSON.stringify(result)}`);
  }
  assert(repositoryFingerprint(repo) === stableFingerprint, "repeated bind helper changed L1/status/HEAD/index");
});

await check("startup orphan writer_transaction fails closed without HEAD/index/recovery mutation", async () => {
  const repo = initRepo("startup-orphan-writer");
  fs.writeFileSync(path.join(repo, "orphan-writer.txt"), "orphan writer transaction\n");
  const before = repositoryFingerprint(repo);
  const indexBefore = git(repo, "ls-files", "--stage");
  const recoveryBefore = (await activeRecoveryRecords(repo)).map((record) => record.eventId).sort();
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "blocked" && /ARTIFACT_UNOWNED/.test(startup.blockedReason ?? ""), `orphan writer did not fail closed: ${startup.blockedReason}`);
  assert(repositoryFingerprint(repo) === before, "orphan writer startup changed HEAD/status/recovery bytes");
  assert(git(repo, "ls-files", "--stage") === indexBefore, "orphan writer startup changed the index");
  assert(JSON.stringify((await activeRecoveryRecords(repo)).map((record) => record.eventId).sort()) === JSON.stringify(recoveryBefore), "orphan writer startup created recovery metadata");
});

await check("public workflow and about-me writers publish canonical writer_transaction commits", async () => {
  for (const [lane, expectedPath] of [["workflow", "workflows/canonical-workflow.md"], ["about_me", "identity/canonical-about-me.md"]]) {
    const repo = initRepo(`public-writer-${lane}`);
    const config = settings(`public-writer-${lane}`, true);
    const child = canonicalWriterApiChild(repo, config, lane);
    assert(child.status === 0, `${lane} public writer child failed: ${child.stderr || child.stdout}`);
    const result = JSON.parse(child.stdout);
    assert(result.status === "created", `${lane} public writer did not create: ${JSON.stringify(result)}`);
    assert(result.publication?.canonical === true && result.publication.status === "local_durable" && result.publication.localCommit === "index_converged" && result.publication.drainStatus === "index_converged", `${lane} publication mapping drifted: ${JSON.stringify(result.publication)}`);
    const committedPaths = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean);
    assert(JSON.stringify(committedPaths) === JSON.stringify([expectedPath]), `${lane} public helper commit was not exact: ${JSON.stringify(committedPaths)}`);
  }
});

await check("canonical bind helper publishes its exact abrain writer transaction", async () => {
  const repo = initRepo("canonical-bind-helper");
  const config = settings("canonical-bind-helper", true);
  const child = canonicalBindHelperChild(repo, config);
  assert(child.status === 0, `canonical bind helper child failed: ${child.stderr || child.stdout}`);
  const result = JSON.parse(child.stdout);
  assert(result.status === "committed" && result.commitSha === git(repo, "rev-parse", "HEAD"), `canonical bind helper did not report committed: ${JSON.stringify(result)}`);
  const committedPaths = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean);
  assert(JSON.stringify(committedPaths) === JSON.stringify(["projects/canonical-bind/_project.json"]), `canonical bind helper commit was not exact: ${JSON.stringify(committedPaths)}`);
});

await check("fresh process restarts and recovers prepared local slot without remote", async () => {
  const repo = initRepo("restart");
  const file = path.join(repo, "restart.txt"); fs.writeFileSync(file, "restart\n");
  const frozen = git(repo, "rev-parse", "HEAD");
  const snapshot = await cohort.snapshotIndexEntries(repo, ["restart.txt"]);
  const prepared = await cohort.prepareExactCohortCommit({ repo, refName: "refs/heads/main", frozenCommit: frozen, plan: [{ path: "restart.txt", op: "put", content: "restart\n" }], message: "ignored" });
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  await recovery.claimRecoverySlot({ abrainHome: repo, episodeId, lane: "drain", slot: 1 });
  await recovery.recordDrainPrepared({ abrainHome: repo, episodeId, slot: 1, prepared, frozenIndexSnapshot: snapshot });
  const config = settings("restart", true);
  const child = startupChild(repo, config);
  assert(child.status === 0, `restart child failed: ${child.stderr}`);
  const diagnostics = JSON.parse(child.stdout);
  assert(diagnostics.startup === "ready", `restart blocked: ${diagnostics.blockedReason}`);
  assert(diagnostics.tail.some((row) => row.operation === "startup_backlog" && row.status === "metadata_deferred"), "prepared recovery metadata was not explicitly deferred");
  assert(git(repo, "rev-parse", "HEAD") === prepared.candidate, "restart did not publish candidate");
  const events = await recovery.readRecoveryEvents(repo, episodeId);
  assert(recovery.foldRecoveryEvents(events).get(1).converged, "restart did not publish index_converged");
  const preparedRecords = (await activeRecoveryRecords(repo)).filter((record) => record.body.event_type === "commit_prepared");
  assert(preparedRecords.length === 1 && preparedRecords[0].body.episode_id === episodeId, "prepared recovery opened another generation");
});

await check("claimed-without-prepared burns the pending slot and does not claim the next slot", async () => {
  const repo = initRepo("claimed-without-prepared");
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  await recovery.claimRecoverySlot({ abrainHome: repo, episodeId, lane: "drain", slot: 1 });
  const headBefore = git(repo, "rev-parse", "HEAD");
  const child = startupChild(repo);
  assert(child.status === 0, `claimed-only startup failed: ${child.stderr}`);
  const diagnostics = JSON.parse(child.stdout);
  assert(diagnostics.startup === "ready", `claimed-only startup blocked: ${diagnostics.blockedReason}`);
  assert(diagnostics.tail.some((row) => row.operation === "recover_drain" && row.slot === 1 && row.action === "burned"), "pending slot was not burned first");
  assert(diagnostics.tail.some((row) => row.operation === "startup_backlog" && row.status === "metadata_deferred"), "burn metadata was not deferred");
  const events = await recovery.readRecoveryEvents(repo, episodeId);
  const folded = recovery.foldRecoveryEvents(events);
  assert(events.filter((event) => event.event_type === "recovery_slot_claimed").length === 1, "startup claimed the next slot");
  assert(folded.get(1).aborted && !folded.get(2), "slot 1 was not the only burned slot");
  assert(git(repo, "rev-parse", "HEAD") === headBefore, "claimed-only recovery changed HEAD");
});

await check("terminal is absorbing and blocks startup content without new events", async () => {
  const repo = initRepo("terminal-content");
  const episodeId = recovery.drainEpisodeIdentity({ symbolic_ref: "refs/heads/main", generation_anchor: "genesis" });
  for (let slot = 1; slot <= 5; slot += 1) {
    const claim = await recovery.claimNextRecoverySlot({ abrainHome: repo, episodeId, lane: "drain" });
    assert(claim.shouldExecute && claim.slot === slot, `terminal fixture did not claim slot ${slot}`);
    await recovery.burnPendingRecoverySlot({ abrainHome: repo, episodeId, lane: "drain" });
  }
  writeKnowledge(repo, 6);
  const headBefore = git(repo, "rev-parse", "HEAD");
  const eventsBefore = (await activeRecoveryRecords(repo)).map((record) => record.eventId).sort();
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "blocked" && /OWNER_INTERVENTION_REQUIRED/.test(startup.blockedReason ?? ""), "terminal content did not block startup");
  assert(git(repo, "rev-parse", "HEAD") === headBefore, "terminal content crossed the absorbing frontier");
  assert(JSON.stringify((await activeRecoveryRecords(repo)).map((record) => record.eventId).sort()) === JSON.stringify(eventsBefore), "terminal startup wrote recovery events");
});

await check("empty startup emits no recovery event", async () => {
  const repo = initRepo("empty-no-event");
  const headBefore = git(repo, "rev-parse", "HEAD");
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "ready", `empty startup blocked: ${startup.blockedReason}`);
  assert(git(repo, "rev-parse", "HEAD") === headBefore, "empty startup changed HEAD");
  assert((await activeRecoveryRecords(repo)).length === 0, "empty startup emitted a recovery event");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
