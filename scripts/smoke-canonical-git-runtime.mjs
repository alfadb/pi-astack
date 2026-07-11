#!/usr/bin/env node
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

await check("real old candidate remains untracked, excluded, and startup is green", async () => {
  const repo = initRepo("legacy-startup");
  const candidate = fixture.envelopes.find((item) => item.event_id === fixture.candidate_event_id);
  let candidatePath;
  for (const envelope of fixture.envelopes) {
    const file = writeEnvelope(repo, envelope);
    if (envelope.event_id === fixture.candidate_event_id) candidatePath = file;
  }
  const config = sharedEnabledSettings;
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: config, sourceRoot: root });
  const startup = await runtime.awaitStartup();
  assert(startup.startup === "ready", `legacy startup blocked: ${startup.blockedReason}`);
  const rel = path.relative(repo, candidatePath).split(path.sep).join("/");
  assert(git(repo, "status", "--porcelain", "--", rel).startsWith("?? "), "legacy candidate was tracked or removed");
  const backlog = await runtime.requestBacklogPreflight();
  assert(backlog.status === "empty" && backlog.receipts.length === 0, "legacy candidate entered backlog ownership");
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

await check("steady-state local writes create current and next generations", async () => {
  const repo = initRepo("steady");
  const runtime = await runtimeModule.getCanonicalGitRuntime({ abrainHome: repo, settingsPath: sharedEnabledSettings, sourceRoot: root });
  assert((await runtime.awaitStartup()).startup === "ready", "clean startup failed");
  const episodes = [];
  for (const [name, content] of [["first.txt", "first\n"], ["second.txt", "second\n"]]) {
    const file = path.join(repo, name); fs.writeFileSync(file, content);
    const receipt = await runtimeModule.createProducedArtifactReceipt({ abrainHome: repo, filePath: file, sourceIds: [`fixture:${name}`] });
    const result = await runtime.requestDrain([receipt], `caller message ${name}`);
    assert(result.status === "index_converged" && result.commit, `drain failed: ${JSON.stringify(result)}`);
    episodes.push(result.episodeId);
  }
  assert(episodes[0] !== episodes[1], "converged generation did not derive next generation for a later explicit write");
  assert(git(repo, "log", "-1", "--format=%B").startsWith("pi-astack local drain"), "caller message entered commit");
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
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const m=j(p.join(${JSON.stringify(root)},'extensions/_shared/canonical-git-runtime.ts'));const r=await m.getCanonicalGitRuntime({abrainHome:${JSON.stringify(repo)},settingsPath:${JSON.stringify(config)},sourceRoot:${JSON.stringify(root)}});const s=await r.awaitStartup();process.stdout.write(JSON.stringify(s));})().catch(e=>{console.error(e);process.exit(1)});`;
  const child = spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } });
  assert(child.status === 0, `restart child failed: ${child.stderr}`);
  const diagnostics = JSON.parse(child.stdout);
  assert(diagnostics.startup === "ready", `restart blocked: ${diagnostics.blockedReason}`);
  assert(git(repo, "rev-parse", "HEAD") === prepared.candidate, "restart did not publish candidate");
  const events = await recovery.readRecoveryEvents(repo, episodeId);
  assert(recovery.foldRecoveryEvents(events).get(1).converged, "restart did not publish index_converged");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
