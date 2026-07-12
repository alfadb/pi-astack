#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const sync = jiti(path.join(root, "extensions/abrain/git-sync.ts"));
const abrain = jiti(path.join(root, "extensions/abrain/index.ts"));
const singleflight = jiti(path.join(root, "extensions/_shared/git-singleflight.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-native-git-sync-"));
const repo = path.join(tmp, "repo");
const bin = path.join(tmp, "bin");
const log = path.join(tmp, "fake-git.jsonl");
fs.mkdirSync(path.join(repo, "l1/events/sha256"), { recursive: true });
fs.mkdirSync(bin);
const fakeGit = path.join(bin, "git");
fs.writeFileSync(fakeGit, `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({args,env:{LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,GIT_TERMINAL_PROMPT:process.env.GIT_TERMINAL_PROMPT,GIT_DIR:process.env.GIT_DIR,GIT_CONFIG_COUNT:process.env.GIT_CONFIG_COUNT,GIT_SSH_COMMAND:process.env.GIT_SSH_COMMAND}})+'\\n');
const verb=args[2];
const mode=process.env.FAKE_GIT_MODE||'ok';
if(mode==='sleep' && verb==='push') setTimeout(()=>{fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({phase:'end',verb})+'\\n');process.exit(0)},500);
else if(mode==='auth' && verb==='push'){console.error('Authentication failed');process.exit(1)}
else if(mode==='network' && verb==='fetch'){console.error('network is unreachable');process.exit(1)}
else if(mode==='diverged' && verb==='merge'){console.error('Not possible to fast-forward, aborting.');process.exit(1)}
else if(verb==='branch') process.stdout.write('main\\n');
else if(verb==='rev-parse') process.stdout.write('fake-head\\n');
else if(verb==='rev-list') process.stdout.write(args.includes('--count')?'0\\n':'0 0\\n');
`, { mode: 0o755 });

const previous = {
  PATH: process.env.PATH,
  FAKE_GIT_LOG: process.env.FAKE_GIT_LOG,
  FAKE_GIT_MODE: process.env.FAKE_GIT_MODE,
  GIT_DIR: process.env.GIT_DIR,
  GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  LANG: process.env.LANG,
  LC_ALL: process.env.LC_ALL,
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
};
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.FAKE_GIT_LOG = log;
process.env.GIT_DIR = "/user/device-owned/git-dir";
process.env.GIT_CONFIG_COUNT = "7";
process.env.GIT_SSH_COMMAND = "user-owned-ssh-command";
process.env.LANG = "de_DE.UTF-8";
process.env.LC_ALL = "de_DE.UTF-8";
process.env.GIT_TERMINAL_PROMPT = "1";
let passed = 0;
const failures = [];

function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`); }
}
function rows() { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }
function clear() { fs.rmSync(log, { force: true }); }
function l1Files() {
  const rootDir = path.join(repo, "l1/events/sha256");
  const out = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? walk(path.join(dir, entry.name)) : out.push(path.join(dir, entry.name)); };
  walk(rootDir); return out;
}

console.log("smoke: native device git-sync boundary");

await check("push uses exact native argv and fresh inherited environment", async () => {
  clear(); process.env.FAKE_GIT_MODE = "ok";
  const result = await sync.pushAsync({ abrainHome: repo });
  assert(result.result === "ok", `push failed: ${JSON.stringify(result)}`);
  const captured = rows();
  assert(captured.length === 1 && JSON.stringify(captured[0].args) === JSON.stringify(["-C", fs.realpathSync(repo), "push"]), `argv drift: ${JSON.stringify(captured)}`);
  assert(captured[0].env.LANG === "C" && captured[0].env.LC_ALL === "C" && captured[0].env.GIT_TERMINAL_PROMPT === "0", "C/no-prompt env missing");
  assert(captured[0].env.GIT_DIR === process.env.GIT_DIR && captured[0].env.GIT_CONFIG_COUNT === process.env.GIT_CONFIG_COUNT && captured[0].env.GIT_SSH_COMMAND === process.env.GIT_SSH_COMMAND, "device GIT_* was scrubbed/interpreted");
});

await check("fetch+ff uses only git fetch and single-argv upstream ff", async () => {
  clear(); process.env.FAKE_GIT_MODE = "ok";
  const result = await sync.fetchAndFF({ abrainHome: repo });
  assert(result.result === "ok", `fetch failed: ${JSON.stringify(result)}`);
  const argv = rows().map((row) => row.args);
  assert(JSON.stringify(argv) === JSON.stringify([
    ["-C", fs.realpathSync(repo), "rev-parse", "--verify", "HEAD"],
    ["-C", fs.realpathSync(repo), "fetch"],
    ["-C", fs.realpathSync(repo), "merge", "--ff-only", "@{upstream}"],
    ["-C", fs.realpathSync(repo), "rev-parse", "--verify", "HEAD"],
  ]), `fetch/ff argv drift: ${JSON.stringify(argv)}`);
  assert(result.merged === 0, `no-op ff must report merged=0: ${JSON.stringify(result)}`);
});

await check("manual sync sequence is exactly fetch, ff-only upstream, push", async () => {
  clear(); process.env.FAKE_GIT_MODE = "ok";
  const result = await sync.sync({ abrainHome: repo });
  assert(result.ok, `sync failed: ${result.summary}`);
  const argv = rows().map((row) => row.args);
  assert(JSON.stringify(argv) === JSON.stringify([
    ["-C", fs.realpathSync(repo), "rev-parse", "--verify", "HEAD"],
    ["-C", fs.realpathSync(repo), "fetch"],
    ["-C", fs.realpathSync(repo), "merge", "--ff-only", "@{upstream}"],
    ["-C", fs.realpathSync(repo), "rev-parse", "--verify", "HEAD"],
    ["-C", fs.realpathSync(repo), "push"],
  ]), `sync argv drift: ${JSON.stringify(argv)}`);
  const flattened = JSON.stringify(argv);
  for (const forbidden of ["origin", "main:main", "HEAD:main", "http", "ssh", "hooksPath", "-c"]) assert(!flattened.includes(forbidden), `native argv contains pinned/override token ${forbidden}`);
});

await check("auth and network failures are audited and never write L1", async () => {
  const before = l1Files();
  process.env.FAKE_GIT_MODE = "auth";
  const auth = await sync.pushAsync({ abrainHome: repo });
  assert(auth.result === "failed" && /Authentication failed/.test(auth.error ?? ""), "auth failure classification missing");
  process.env.FAKE_GIT_MODE = "network";
  const network = await sync.fetchAndFF({ abrainHome: repo });
  assert(network.result === "failed" && /network is unreachable/.test(network.error ?? ""), "network failure classification missing");
  assert(JSON.stringify(l1Files()) === JSON.stringify(before), "delivery failure wrote L1");
  const audit = fs.readFileSync(path.join(repo, ".state/git-sync.jsonl"), "utf8");
  assert(audit.includes("Authentication failed") && audit.includes("network is unreachable"), "failure audit missing");
});

await check("ff divergence stops before push and keeps successful fetch side effect", async () => {
  clear(); process.env.FAKE_GIT_MODE = "diverged";
  const result = await sync.sync({ abrainHome: repo });
  assert(!result.ok && result.events[0].result === "diverged", `divergence misclassified: ${JSON.stringify(result)}`);
  const argv = rows().map((row) => row.args);
  assert(argv.length === 3 && argv[0][2] === "rev-parse" && argv[1][2] === "fetch" && argv[2][2] === "merge", "push ran after ff divergence");
});

await check("generic timeout is fail-soft and L1-neutral", async () => {
  clear(); process.env.FAKE_GIT_MODE = "sleep";
  const before = l1Files();
  const result = await sync.pushAsync({ abrainHome: repo, timeoutMs: 20 });
  assert(result.result === "timeout", `timeout misclassified: ${JSON.stringify(result)}`);
  assert(JSON.stringify(l1Files()) === JSON.stringify(before), "timeout wrote L1");
});

await check("git-sync and local drain callers share canonical-realpath singleflight", async () => {
  clear(); process.env.FAKE_GIT_MODE = "sleep";
  const pushing = sync.pushAsync({ abrainHome: path.join(repo, ".") });
  const deadline = Date.now() + 1_000;
  while (rows().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(rows().length === 1, "push did not enter the shared chain");
  let drainSawPushEnd = false;
  const drain = singleflight.gitSingleFlight(fs.realpathSync(repo), async () => { drainSawPushEnd = rows().some((row) => row.phase === "end" && row.verb === "push"); });
  await Promise.all([pushing, drain]);
  assert(drainSawPushEnd, "local drain entered before the device push subprocess ended");
});

await check("real ff event drives constraint refresh and real no-op event does not", async () => {
  const integration = path.join(tmp, "integration");
  const bare = path.join(integration, "upstream.git");
  const producer = path.join(integration, "producer");
  const device = path.join(integration, "device");
  delete process.env.GIT_DIR;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_SSH_COMMAND;
  const git = (cwd, args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env: { ...process.env, PATH: previous.PATH }, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  fs.mkdirSync(integration, { recursive: true });
  git(integration, ["init", "--bare", bare]);
  git(integration, ["clone", bare, producer]);
  git(producer, ["config", "user.name", "Smoke Producer"]);
  git(producer, ["config", "user.email", "producer@example.invalid"]);
  fs.writeFileSync(path.join(producer, "entry.txt"), "one\n");
  git(producer, ["add", "entry.txt"]);
  git(producer, ["commit", "-m", "initial"]);
  git(producer, ["push", "-u", "origin", "HEAD"]);
  git(integration, ["clone", bare, device]);
  fs.appendFileSync(path.join(producer, "entry.txt"), "two\n");
  git(producer, ["commit", "-am", "device update"]);
  git(producer, ["push"]);

  process.env.PATH = previous.PATH;
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
  try {
    const changed = await sync.sync({ abrainHome: device });
    const changedFetch = changed.events.find((event) => event.op === "fetch");
    assert(changed.ok && changedFetch?.result === "ok" && changedFetch.merged === 1, `real ff event was inaccurate: ${JSON.stringify(changed)}`);
    const changedRefresh = await consume(changedFetch);
    assert(changedRefresh.scheduled && scheduled.length === 1, `real ff did not schedule refresh: ${JSON.stringify(changedRefresh)}`);

    const noop = await sync.sync({ abrainHome: device });
    const noopFetch = noop.events.find((event) => event.op === "fetch");
    assert(noop.ok && noopFetch?.result === "ok" && noopFetch.merged === 0, `real no-op event was inaccurate: ${JSON.stringify(noop)}`);
    const noopRefresh = await consume(noopFetch);
    assert(!noopRefresh.scheduled && scheduled.length === 1, `real no-op scheduled refresh: ${JSON.stringify(noopRefresh)}`);
  } finally {
    process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ""}`;
  }
});

await check("targeted tsc catches no TS2304/TS2322 in git-sync and its index caller", () => {
  const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const result = spawnSync(tsc, [
    "--noEmit", "--pretty", "false", "--target", "ES2022", "--module", "commonjs",
    "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--types", "node",
    "extensions/abrain/index.ts", "extensions/abrain/git-sync.ts",
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  assert(!result.error, `targeted tsc did not execute: ${result.error?.message}`);
  const diagnostics = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const targetRegression = diagnostics.split("\n").filter((line) =>
    /extensions\/abrain\/(?:index|git-sync)\.ts/.test(line) && /error TS(?:2304|2322):/.test(line));
  assert(targetRegression.length === 0, `targeted type regression:\n${targetRegression.join("\n")}`);
});

await check("git-sync notify contract and detached push caller remain explicit", () => {
  const nativeSource = fs.readFileSync(path.join(root, "extensions/abrain/git-sync.ts"), "utf8");
  const callerSource = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
  assert(nativeSource.includes('export type GitSyncNotifyType = "info" | "warning" | "error";'), "shared notify contract is not the exact rendered type union");
  assert(callerSource.includes("pushAsync, sync as gitSync") && callerSource.includes("type GitSyncNotifyType"), "index named imports regressed");
  assert(callerSource.includes("void pushAsync({ abrainHome: root });"), "post-convergence push no longer remains detached");
  assert(!callerSource.includes("notify?: (msg: string, type?: string)"), "git-sync notify contract widened back to string");
});

await check("git-sync, caller, and writer retain neutral native delivery boundary", () => {
  const files = ["extensions/abrain/git-sync.ts", "extensions/abrain/index.ts", "extensions/sediment/writer.ts"];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  for (const forbidden of ["remote get-url", "origin/main", "HEAD:main", "main:main", "conflictPaths", "enqueued push", "queued for push", "auto-merge", "auto-merged", "self-heal bridge", "Self-heal", "resolveDerivedL2", "ensureAdr0039PrePushHook", "checkAdr0039ReconcileGate"]) assert(!source.includes(forbidden), `delivery boundary retained ${forbidden}`);
  const nativeSource = fs.readFileSync(path.join(root, "extensions/abrain/git-sync.ts"), "utf8");
  for (const forbidden of ["canonical-git-runtime", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "remote get-url", "remote -v", "push_blocked_reconcile", "consecutivePushBlockedReconcile"]) assert(!nativeSource.includes(forbidden), `native delivery retained dead or user-configuration-coupled token ${forbidden}`);
  const callerSource = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
  assert(!callerSource.includes("consecutivePushBlockedReconcile") && !callerSource.includes("push_blocked_reconcile"), "caller retained dead reconcile-blocked status handling");
  assert(callerSource.includes("gitSync({ abrainHome: ABRAIN_HOME })") && callerSource.includes('event.op === "fetch"'), "startup does not consume the fetch event from the complete device-sync sequence");
  assert(!callerSource.includes("fetchAndFF({ abrainHome: ABRAIN_HOME })") && !callerSource.includes("pushAsync({ abrainHome: ABRAIN_HOME })"), "startup restored split or duplicate device operations");
  assert(callerSource.includes('fetchEvent?.result === "diverged"') && callerSource.includes("Startup continues; use /abrain sync to retry."), "startup divergence/failure warning regressed to silent handling");
});

for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
