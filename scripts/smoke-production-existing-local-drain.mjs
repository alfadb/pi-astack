#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts/dossier-production-existing-local-drain.mjs");
const source = path.resolve(process.env.PI_ASTACK_EXISTING_DRAIN_SOURCE ?? "/home/worker/.abrain");
const candidate = "ea1b9be1f49ffcf87f07ad94189c33126899ebe3";
const parent = "c043aa218b2ef20813452b2d7c292699132b7437";
const preflight = path.join(root, "docs/evidence/2026-07-12-canonical-path-p1-a-production-preflight-v5.json");
const preflightSha = "17628ce7999d74791c2075cb08f54984a83886632606154ddf19ecbdf2249506";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-existing-drain-smoke-"));
const eventPaths = [
  "l1/events/sha256/17/50/1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a.json",
  "l1/events/sha256/4a/1e/4a1e2adc338e5fdc6d085ebc79a0e96a864b376614daa7876e79dacadfa4b2e9.json",
  "l1/events/sha256/60/9b/609bed1208e8e34179c5a6324ab106dc8e59a71ec8e81048d9d50f36d7c6d30a.json",
  "l1/events/sha256/c6/4b/c64b2e45dcd3816fba2c6cfcafeb1c16a1f0afcafb73e6296b8b7ec0acf0499b.json",
  "l1/events/sha256/f5/64/f564dbfd989b57ec2dbc6289cb70c1e9483b50b9dcfce3c1b7455762f886f5ef.json",
];
const trackedProbe = "l2/views/knowledge/latest/projects/pi-global/audit-retention-requires-authenticated-recoverable-deletion.md";
let passed = 0;

function assert(value, message) { if (!value) throw new Error(message); }
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } }).trim();
}
function fixture(label) {
  const repo = path.join(tmp, label);
  execFileSync("git", ["clone", "-q", "--no-local", source, repo], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  git(repo, ["checkout", "-q", "-B", "main", candidate]);
  for (const relativePath of eventPaths) {
    const from = path.join(source, ...relativePath.split("/"));
    const to = path.join(repo, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return repo;
}
function run(label, repo, options = {}) {
  const output = path.join(tmp, `${label}.json`);
  const manifest = path.join(tmp, `${label}-manifest.json`);
  const args = [verifier, "--abrain", repo, "--candidate", options.candidate ?? candidate, "--preflight", options.preflight ?? preflight, "--preflight-sha256", preflightSha, "--output", output, "--manifest", manifest];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  return { result, report };
}
function expectPass(label, setup = () => ({})) {
  const repo = fixture(label);
  const options = setup(repo) ?? {};
  const { result, report } = run(label, repo, options);
  assert(result.status === 0 && report?.status === "pass", `${label} should pass: ${result.stderr}\n${result.stdout}\n${JSON.stringify(report?.errors)}`);
  assert(Object.values(report.verification).every(Boolean), `${label} has a false verification boolean`);
  passed += 1;
}
function expectFail(label, expectedError, setup) {
  const repo = fixture(label);
  const options = setup(repo) ?? {};
  const { result, report } = run(label, repo, options);
  assert(result.status === 1 && report?.status === "fail", `${label} should fail closed: ${result.stderr}\n${result.stdout}`);
  assert(report.errors.some((value) => value.includes(expectedError)), `${label} missing ${expectedError}: ${JSON.stringify(report.errors)}`);
  passed += 1;
}

try {
  assert(fs.existsSync(source), `production source fixture missing: ${source}`);
  assert(fs.existsSync(preflight), `stable preflight fixture missing: ${preflight}`);
  assert(git(source, ["rev-parse", candidate]) === candidate, "candidate object missing from source fixture");

  expectPass("success");
  expectFail("tampered-preflight", "preflight_artifact_sha256_mismatch", () => {
    const tampered = path.join(tmp, "tampered-preflight.json");
    const value = JSON.parse(fs.readFileSync(preflight, "utf8"));
    value.durationMs += 1;
    fs.writeFileSync(tampered, `${JSON.stringify(value, null, 2)}\n`);
    return { preflight: tampered };
  });
  expectFail("tampered-candidate", "prepared_event_missing_or_ambiguous", () => ({ candidate: parent }));
  expectFail("tampered-recovery", "RECOVERY_STATE_ORDER", (repo) => {
    fs.unlinkSync(path.join(repo, ...eventPaths[1].split("/")));
  });
  expectFail("legacy-mixed", "shared_index_drift", (repo) => {
    git(repo, ["add", "--", eventPaths[0]]);
  });
  expectFail("tracked-drift", "tracked_worktree_drift", (repo) => {
    fs.appendFileSync(path.join(repo, ...trackedProbe.split("/")), "\ntracked drift\n");
  });
  expectFail("staged-drift", "shared_index_drift", (repo) => {
    fs.appendFileSync(path.join(repo, ...trackedProbe.split("/")), "\nstaged drift\n");
    git(repo, ["add", "--", trackedProbe]);
  });
  console.log(`PASS - production existing-drain dossier accepted the exact temp-repo fixture and failed closed for ${passed - 1} tamper/drift cases (${passed} checks).`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
