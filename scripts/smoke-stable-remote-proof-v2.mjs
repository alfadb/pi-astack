#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stable-remote-proof-v2-"));
const repo = path.join(tmp, "repo");
const bare = path.join(tmp, "repo.git");
const peer = path.join(tmp, "peer");
const config = path.join(tmp, "global.gitconfig");
const key = path.join(tmp, "key.pem");
const cert = path.join(tmp, "cert.pem");
function git(args, options = {}) { return execFileSync("git", args, { encoding: "utf8", ...options }).trim(); }
function hash(value) { return crypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex"); }
fs.mkdirSync(repo);
git(["-C", repo, "init", "-b", "main"]);
git(["-C", repo, "config", "user.name", "smoke"]);
git(["-C", repo, "config", "user.email", "smoke@example.invalid"]);
fs.writeFileSync(path.join(repo, "base"), "base\n");
git(["-C", repo, "add", "base"]);
git(["-C", repo, "commit", "-m", "base"]);
git(["init", "--bare", bare]);
const target = git(["-C", repo, "rev-parse", "HEAD"]);
git(["-C", repo, "push", bare, `${target}:refs/heads/main`]);
git(["clone", bare, peer]);
git(["-C", peer, "config", "user.name", "peer"]);
git(["-C", peer, "config", "user.email", "peer@example.invalid"]);
fs.writeFileSync(path.join(peer, "descendant"), "descendant\n");
git(["-C", peer, "add", "descendant"]);
git(["-C", peer, "commit", "-m", "descendant"]);
const remoteTip = git(["-C", peer, "rev-parse", "HEAD"]);
git(["-C", peer, "push", "origin", "HEAD:refs/heads/main"]);
git(["--git-dir", bare, "update-server-info"]);
let remoteObjectInitiallyMissing = false;
try { execFileSync("git", ["-C", repo, "cat-file", "-e", `${remoteTip}^{commit}`], { stdio: "ignore" }); }
catch { remoteObjectInitiallyMissing = true; }
assert.equal(remoteObjectInitiallyMissing, true);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "https://127.0.0.1").pathname);
  if (!pathname.startsWith("/repo.git/")) { response.writeHead(404).end(); return; }
  const rel = pathname.slice("/repo.git/".length);
  const file = path.resolve(bare, rel);
  if (!file.startsWith(`${path.resolve(bare)}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not file");
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size });
    fs.createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `https://127.0.0.1:${server.address().port}/repo.git`;
git(["-C", repo, "remote", "add", "origin", endpoint]);
const helpers = [0, 1, 2].map((index) => `!f(){ test "$1" = get && :; }; f`);
const context = transport.canonicalEndpointContext(endpoint);
execFileSync("git", ["config", "--file", config, "--add", `credential.${context.origin}.helper`, ""]);
for (const helper of helpers) execFileSync("git", ["config", "--file", config, "--add", `credential.${context.origin}.helper`, helper]);
const entry = (value, kind = value.length === 0 ? "reset" : "shell-snippet") => ({ kind, valueSha256: hash(value) });
const resolutionBase = {
  matchingPolicyVersion: "git-credential-urlmatch/v1",
  includeCount: 0,
  scopes: [
    { scope: "unscoped", provenanceSha256: hash(""), rawEntryCount: 0, rawEntries: [] },
    { scope: "host", provenanceSha256: hash(context.origin), rawEntryCount: 4, rawEntries: [entry(""), ...helpers.map((value) => entry(value))] },
    { scope: "path-prefix", provenanceSha256: hash(context.pathPrefix), rawEntryCount: 0, rawEntries: [] },
    { scope: "exact-repo", provenanceSha256: hash(endpoint), rawEntryCount: 0, rawEntries: [] },
  ],
  effectiveHelperCount: 3,
  effectiveHelpers: helpers.map((value) => entry(value)),
};
const credentialResolution = {
  source: "global",
  ...resolutionBase,
  credentialResolutionFingerprint: transport.deriveCredentialResolutionFingerprint(context, resolutionBase),
};
const basePolicy = {
  remote: "origin", refName: "refs/heads/main", endpointSha256: hash(endpoint), credentialResolution,
  rewritePolicy: "forbidden", redirectPolicy: "forbidden", promptPolicy: "forbidden",
};
const policy = { ...basePolicy, transportPolicyId: transport.deriveTransportPolicyId(basePolicy) };
const gitDir = git(["-C", repo, "rev-parse", "--absolute-git-dir"]);
const fetchHead = path.join(gitDir, "FETCH_HEAD");
fs.rmSync(fetchHead, { force: true });
const before = {
  refs: git(["-C", repo, "for-each-ref", "--format=%(refname) %(objectname)"]),
  index: hash(fs.readFileSync(path.join(gitDir, "index")).toString("binary")),
  status: git(["-C", repo, "status", "--porcelain=v1", "-uall"]),
  base: fs.readFileSync(path.join(repo, "base"), "utf8"),
};
const session = await transport.CanonicalGitTransportSession.create({ repo, policy, globalConfigPath: config, allowInsecureTestTls: true });
const proof = await session.stableProof(target);
await session.close();
assert.equal(proof.tipBefore, remoteTip);
assert.equal(proof.fetchedOid, remoteTip);
assert.equal(proof.tipAfter, remoteTip);
assert.equal(proof.remoteContainsTarget, true);
assert.equal(proof.relation, "descendant");
assert.equal(git(["-C", repo, "cat-file", "-t", remoteTip]), "commit");
assert.equal(fs.existsSync(fetchHead), false, "object-only proof wrote FETCH_HEAD");
const after = {
  refs: git(["-C", repo, "for-each-ref", "--format=%(refname) %(objectname)"]),
  index: hash(fs.readFileSync(path.join(gitDir, "index")).toString("binary")),
  status: git(["-C", repo, "status", "--porcelain=v1", "-uall"]),
  base: fs.readFileSync(path.join(repo, "base"), "utf8"),
};
assert.deepEqual(after, before, "stable remote proof changed ref/index/worktree");
await new Promise((resolve) => server.close(resolve));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("stable remote proof v2: tip-before/fetched/tip-after equality and object-only invariants PASS");
