#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
const transport = jiti(path.join(root, "extensions/_shared/canonical-git-transport.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-transport-v2-"));
const sentinel = `BROKER_SENTINEL_${crypto.randomBytes(12).toString("hex")}`;
const endpoint = "https://example.invalid/exact/repository.git";
const repo = path.join(tmp, "repo");
const globalConfig = path.join(tmp, "global.gitconfig");
const operations = path.join(tmp, "operations.log");

function git(args, options = {}) { return execFileSync("git", args, { encoding: "utf8", ...options }).trim(); }
function hash(value) { return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")).digest("hex"); }
function entry(value, kind = value.length === 0 ? "reset" : "shell-snippet") { return { kind, valueSha256: hash(value) }; }
function buildPolicy(rawHostHelpers, effectiveHelpers = rawHostHelpers.slice(rawHostHelpers.findLastIndex((value) => value.length === 0) + 1), overrides = {}) {
  const context = transport.canonicalEndpointContext(endpoint);
  const scopes = [
    { scope: "unscoped", provenanceSha256: hash(""), rawEntryCount: 0, rawEntries: [] },
    { scope: "host", provenanceSha256: hash(context.origin), rawEntryCount: rawHostHelpers.length, rawEntries: rawHostHelpers.map((value) => entry(value)) },
    { scope: "path-prefix", provenanceSha256: hash(context.pathPrefix), rawEntryCount: 0, rawEntries: [] },
    { scope: "exact-repo", provenanceSha256: hash(context.literal), rawEntryCount: 0, rawEntries: [] },
  ];
  const resolutionBase = {
    source: "global",
    matchingPolicyVersion: "git-credential-urlmatch/v1",
    includeCount: 0,
    scopes,
    effectiveHelperCount: effectiveHelpers.length,
    effectiveHelpers: effectiveHelpers.map((value) => entry(value, "shell-snippet")),
    ...overrides,
  };
  const { source, credentialResolutionFingerprint: ignored, ...fingerprintInput } = resolutionBase;
  const credentialResolution = { ...resolutionBase, credentialResolutionFingerprint: transport.deriveCredentialResolutionFingerprint(context, fingerprintInput) };
  const base = {
    remote: "origin",
    refName: "refs/heads/main",
    endpointSha256: hash(endpoint),
    credentialResolution,
    rewritePolicy: "forbidden",
    redirectPolicy: "forbidden",
    promptPolicy: "forbidden",
  };
  return { ...base, transportPolicyId: transport.deriveTransportPolicyId(base) };
}
function addHostHelpers(config, values) {
  execFileSync("git", ["config", "--file", config, "--add", `credential.https://example.invalid.helper`, ""]);
  for (const value of values) execFileSync("git", ["config", "--file", config, "--add", `credential.https://example.invalid.helper`, value]);
}

fs.mkdirSync(repo);
git(["-C", repo, "init", "-b", "main"]);
git(["-C", repo, "config", "user.name", "smoke"]);
git(["-C", repo, "config", "user.email", "smoke@example.invalid"]);
fs.writeFileSync(path.join(repo, "base"), "base\n");
git(["-C", repo, "add", "base"]);
git(["-C", repo, "commit", "-m", "base"]);
git(["-C", repo, "remote", "add", "origin", endpoint]);

const helpers = [
  `!f(){ s='${sentinel}'; sleep 1; printf '0:%s\\n' "$1" >> '${operations}'; if test "$1" = get; then printf 'username=ordered-user\\n'; else cat >/dev/null; fi; }; f`,
  `!f(){ s='${sentinel}'; sleep 1; printf '1:%s\\n' "$1" >> '${operations}'; if test "$1" = get; then printf 'password=ordered-password\\n'; else cat >/dev/null; fi; }; f`,
  `!f(){ s='${sentinel}'; printf '2:%s\\n' "$1" >> '${operations}'; cat >/dev/null; }; f`,
];
addHostHelpers(globalConfig, helpers);
execFileSync("git", ["config", "--file", globalConfig, "--add", "credential.https://other.invalid.helper", "!must-not-match"]);
const policy = buildPolicy(["", ...helpers], helpers);

function descendants(rootPid) {
  const all = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      all.push({ pid: Number(name), ppid: Number(stat.slice(close + 2).split(" ")[1]) });
    } catch {}
  }
  const found = new Set([rootPid]);
  for (let pass = 0; pass < 8; pass++) for (const row of all) if (found.has(row.ppid)) found.add(row.pid);
  found.delete(rootPid);
  return [...found];
}
function assertNoSentinelInProcesses() {
  for (const pid of descendants(process.pid)) for (const leaf of ["cmdline", "environ"]) {
    try { assert.equal(fs.readFileSync(`/proc/${pid}/${leaf}`).includes(Buffer.from(sentinel)), false, `sentinel leaked to /proc/${pid}/${leaf}`); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "EACCES") throw error; }
  }
}

const context = transport.canonicalEndpointContext(endpoint);
assert.deepEqual({ protocol: context.protocol, host: context.host, path: context.path }, { protocol: "https", host: "example.invalid", path: "exact/repository.git" });
const percentContext = transport.canonicalEndpointContext("https://example.invalid/a%20b/repo.git");
assert.equal(percentContext.path, "a%20b/repo.git", "credential path was decoded or normalized twice");
const percentCapture = path.join(tmp, "percent-helper-wire.bin");
const percentConfig = path.join(tmp, "percent.gitconfig");
execFileSync("git", ["config", "--file", percentConfig, "credential.useHttpPath", "true"]);
execFileSync("git", ["config", "--file", percentConfig, "credential.helper", `!f(){ cat > '${percentCapture}'; printf 'username=u\\npassword=p\\n'; }; f`]);
execFileSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=example.invalid\npath=a%20b/repo.git\n\n",
  stdio: ["pipe", "ignore", "pipe"],
  env: { ...process.env, GIT_CONFIG_GLOBAL: percentConfig, GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
});
const percentWire = fs.readFileSync(percentCapture);
assert.equal(percentWire.toString("utf8"), "protocol=https\nhost=example.invalid\npath=a%20b/repo.git\n", "Git changed percent/path bytes before the helper boundary");
assert.equal(transport.validateCredentialProtocol(percentWire, percentContext).path, "a%20b/repo.git");
const helperWireProtocol = Buffer.from("protocol=https\nhost=example.invalid\npath=exact/repository.git\n");
const getProtocol = Buffer.from("protocol=https\nhost=example.invalid\npath=exact/repository.git\n\n");
assert.deepEqual(transport.validateCredentialProtocol(helperWireProtocol, context), { protocol: "https", host: "example.invalid", path: "exact/repository.git" });
for (const invalid of [
  "protocol=https\nprotocol=https\nhost=example.invalid\npath=exact/repository.git\n",
  "protocol=https\nhost=other.invalid\npath=exact/repository.git\n",
  "protocol=https\nhost=example.invalid\npath=exact/repository.git\n\ntrailing=x\n",
  "protocol=https\nhost=example.invalid\npath=exact%2Frepository.git\n",
]) assert.throws(() => transport.validateCredentialProtocol(Buffer.from(invalid), context), /BROKER_(CREDENTIAL_PROTOCOL_INVALID|ENDPOINT_CONTEXT_MISMATCH)/);
assert.throws(() => transport.validateCredentialProtocol(Buffer.from("protocol=https\nhost=example.invalid\npath=exact/repository.git\0\n"), context), /BROKER_CREDENTIAL_PROTOCOL_INVALID/);

const session = await transport.CanonicalGitTransportSession.create({ repo, policy, globalConfigPath: globalConfig });
const debug = session._debugPathsForTests();
assert.equal(fs.statSync(debug.tmpDir).mode & 0o777, 0o700);
assert.equal(fs.statSync(debug.configPath).mode & 0o777, 0o600);
const configBytes = fs.readFileSync(debug.configPath);
assert.equal(configBytes.includes(Buffer.from("hooksPath = /dev/null")), false, "hooks override unexpectedly persisted outside command config");
assert.equal(configBytes.includes(Buffer.from(sentinel)), false);
for (const helper of helpers) assert.equal(configBytes.includes(Buffer.from(helper)), false, "raw helper leaked to temp config");

const direct = await session._helperForTests(0, "get", getProtocol);
assert.equal(direct.ok, true);
assert.match(direct.stdout.toString("utf8"), /username=ordered-user/);
fs.writeFileSync(operations, "");
const getPromise = session._credentialForTests("get", getProtocol);
await new Promise((resolve) => setTimeout(resolve, 150));
assertNoSentinelInProcesses();
const get = await getPromise;
assert.equal(get.exitCode, 0);
assert.match(get.stdout.toString("utf8"), /username=ordered-user/);
assert.match(get.stdout.toString("utf8"), /password=ordered-password/);
assert.deepEqual(fs.readFileSync(operations, "utf8").trim().split("\n"), ["0:get", "1:get"]);

fs.writeFileSync(operations, "");
const protocol = Buffer.from("protocol=https\nhost=example.invalid\npath=exact/repository.git\nusername=u\npassword=p\n\n");
assert.equal((await session._credentialForTests("store", protocol)).exitCode, 0);
assert.equal((await session._credentialForTests("erase", protocol)).exitCode, 0);
assert.deepEqual(fs.readFileSync(operations, "utf8").trim().split("\n"), ["0:store", "1:store", "2:store", "0:erase", "1:erase", "2:erase"]);
assert.equal(fs.readFileSync(operations).includes(Buffer.from(sentinel)), false);
await session.close();
assert.equal(fs.existsSync(debug.tmpDir), false);
await assert.rejects(() => session._credentialForTests("get", protocol), /TRANSPORT_REVOKED/);

const quitConfig = path.join(tmp, "quit.gitconfig");
const quitLog = path.join(tmp, "quit.log");
const quitHelpers = [
  `!f(){ s='${sentinel}'; printf '0:%s\\n' "$1" >> '${quitLog}'; printf 'quit=true\\n'; }; f`,
  `!f(){ s='${sentinel}'; printf '1:%s\\n' "$1" >> '${quitLog}'; printf 'username=must-not-run\\n'; }; f`,
  `!f(){ s='${sentinel}'; printf '2:%s\\n' "$1" >> '${quitLog}'; }; f`,
];
addHostHelpers(quitConfig, quitHelpers);
const quitSession = await transport.CanonicalGitTransportSession.create({ repo, policy: buildPolicy(["", ...quitHelpers], quitHelpers), globalConfigPath: quitConfig });
assert.notEqual((await quitSession._credentialForTests("get", getProtocol)).exitCode, 0);
assert.deepEqual(fs.readFileSync(quitLog, "utf8").trim().split("\n"), ["0:get"]);
await quitSession.close();

const orderedDriftPolicy = buildPolicy(["", helpers[1], helpers[0], helpers[2]], [helpers[1], helpers[0], helpers[2]]);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy: orderedDriftPolicy, globalConfigPath: globalConfig }), /CREDENTIAL_HELPER_HASH_MISMATCH/);
const wrongCountPolicy = buildPolicy(["", helpers[0], helpers[1]], [helpers[0], helpers[1]]);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy: wrongCountPolicy, globalConfigPath: globalConfig }), /CREDENTIAL_SCOPE_COUNT_MISMATCH/);
const kindConfig = path.join(tmp, "kind.gitconfig");
addHostHelpers(kindConfig, [helpers[0], "credential-cache", helpers[2]]);
const kindExpected = buildPolicy(["", helpers[0], "!expected-shell", helpers[2]], [helpers[0], "!expected-shell", helpers[2]]);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy: kindExpected, globalConfigPath: kindConfig }), /CREDENTIAL_HELPER_(KIND|HASH)_MISMATCH/);
const includeConfig = path.join(tmp, "include.gitconfig");
fs.writeFileSync(includeConfig, `[include]\n\tpath = ${globalConfig}\n`);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy, globalConfigPath: includeConfig }), /CREDENTIAL_INCLUDE_COUNT_MISMATCH/);
const prefixConfig = path.join(tmp, "prefix.gitconfig");
addHostHelpers(prefixConfig, helpers);
execFileSync("git", ["config", "--file", prefixConfig, "--add", "credential.https://example.invalid/exact.helper", "!unapproved-prefix"]);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy, globalConfigPath: prefixConfig }), /CREDENTIAL_SCOPE_(COUNT_MISMATCH|UNPINNED)/);

git(["-C", repo, "config", "http.sslCAInfo", "/tmp/unpinned-ca"]);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy, globalConfigPath: globalConfig }), /REMOTE_LOCAL_CONFIG_FORBIDDEN/);
git(["-C", repo, "config", "--unset", "http.sslCAInfo"]);
git(["-C", repo, "config", "core.hooksPath", "/tmp/unpinned-hooks"]);
await assert.rejects(() => transport.CanonicalGitTransportSession.create({ repo, policy, globalConfigPath: globalConfig }), /REMOTE_LOCAL_CONFIG_FORBIDDEN/);
git(["-C", repo, "config", "--unset", "core.hooksPath"]);

const corpus = [
  fs.readFileSync(path.join(root, "pi-astack-settings.schema.json")),
  fs.readFileSync(path.join(root, "..", "..", "pi-astack-settings.json")),
  fs.readFileSync(path.join(root, "schemas", "l1-schema-role-registry.json")),
  fs.readFileSync(path.join(root, "extensions", "_shared", "canonical-git-transport.ts")),
];
for (const bytes of corpus) assert.equal(bytes.includes(Buffer.from(sentinel)), false);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("canonical Git transport v2: scope lattice, broker binding/order, drift, cleanup, hooks/TLS fail-closed PASS");
