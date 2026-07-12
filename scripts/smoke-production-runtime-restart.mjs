#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts/dossier-production-runtime-restart.mjs");
const source = path.resolve(process.env.PI_ASTACK_RUNTIME_RESTART_SOURCE ?? "/home/worker/.abrain");
const session = "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-12T11-14-10-735Z_019f5608-e2af-7198-85a9-825f182e3c20.jsonl";
const dispatchAudit = "/home/worker/.pi/.pi-astack/dispatch/audit.jsonl";
const sourceEventPath = "l1/events/sha256/0d/9d/0d9df863c2db351e33449443d93ec0c8b55fbd7df49c1556c8512ab11ec780f4.json";
const publishedPath = "l1/events/sha256/bb/78/bb784d04616724b3db38bb6ef6ae12cf350c01c9dc4f88fce62e50f5f4deaa7c.json";
const episodePaths = [
  "l1/events/sha256/d9/cc/d9cc0415498a0949074f768daf638c343f5646195725a3c9153097ab5f7539c3.json",
  "l1/events/sha256/b6/c6/b6c6ed419039bda16104f697b0dc324ea03bbb7bc36f496181c5b1b2b3c50f7f.json",
  publishedPath,
  "l1/events/sha256/7f/d5/7fd5615a048801b4440228eb3614e9a512acbb9c31ba0e99b0f7b4b0659a8683.json",
];
const legacyPath = "l1/events/sha256/17/50/1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a.json";
const candidate = "4599d69b9f52015773a3033f5a3830497f0eb4b0";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-runtime-restart-smoke-"));
let passed = 0;

function assert(value, message) { if (!value) throw new Error(message); }
function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: options.encoding ?? "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } });
}
function untrackedPaths(repo) {
  return git(repo, ["status", "--porcelain=v1", "-z", "-uall"], { encoding: "buffer" }).toString("utf8").split("\0").filter((row) => row.startsWith("?? ")).map((row) => row.slice(3));
}
function fixture(label) {
  const repo = path.join(tmp, label);
  execFileSync("git", ["clone", "-q", "--no-local", source, repo], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  for (const relativePath of untrackedPaths(source)) {
    const from = path.join(source, ...relativePath.split("/"));
    const to = path.join(repo, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return repo;
}
function run(label, repo) {
  const output = path.join(tmp, `${label}.json`);
  const manifest = path.join(tmp, `${label}-manifest.json`);
  const result = spawnSync(process.execPath, [
    verifier, "--abrain", repo, "--timeline-root", source,
    "--session", session, "--git-sync", path.join(source, ".state/git-sync.jsonl"),
    "--dispatch-audit", dispatchAudit, "--output", output, "--manifest", manifest,
  ], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  return { result, report };
}
function expectPass(label, setup = () => {}) {
  const repo = fixture(label);
  setup(repo);
  const { result, report } = run(label, repo);
  assert(result.status === 0 && report?.status === "pass", `${label} should pass: ${result.stderr}\n${result.stdout}\n${JSON.stringify(report?.errors)}`);
  assert(Object.values(report.verification).every(Boolean), `${label} contains a false verification boolean`);
  assert(report.residualRisk.orderedOperatorReplacementProven === false, "success report hid the process-ordering residual risk");
  passed += 1;
}
function expectFail(label, expected, setup) {
  const repo = fixture(label);
  setup(repo);
  const { result, report } = run(label, repo);
  assert(result.status === 1 && report?.status === "fail", `${label} should fail: ${result.stderr}\n${result.stdout}`);
  assert(report.errors.some((value) => value.includes(expected)), `${label} missing ${expected}: ${JSON.stringify(report.errors)}`);
  passed += 1;
}

try {
  assert(fs.existsSync(source), `production source missing: ${source}`);
  assert(git(source, ["rev-parse", candidate]).trim() === candidate, "candidate object missing");
  assert(fs.existsSync(path.join(source, ...legacyPath.split("/"))), "legacy 1750 fixture missing");

  expectPass("success");
  expectFail("published-event-removed", "episode_event_set_not_exact", (repo) => fs.unlinkSync(path.join(repo, ...publishedPath.split("/"))));
  expectFail("source-event-body-tampered", "verification_exception:L1_HASH_MISMATCH", (repo) => {
    const file = path.join(repo, ...sourceEventPath.split("/"));
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    envelope.body.payload.title = `${envelope.body.payload.title} tampered`;
    fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  });
  expectFail("legacy-staged-into-index", "shared_index_not_green", (repo) => git(repo, ["add", "--", legacyPath]));
  expectFail("replace-ref-injected", "git_replace_ref_present", (repo) => git(repo, ["replace", candidate, `${candidate}^`]));
  expectFail("candidate-not-contained", "current_head_does_not_contain_candidate", (repo) => {
    git(repo, ["checkout", "-q", "-B", "main", `${candidate}^`]);
    for (const relativePath of episodePaths) {
      const from = path.join(source, ...relativePath.split("/"));
      const to = path.join(repo, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  });

  console.log(`PASS - production runtime restart verifier accepted the production clone and failed closed for ${passed - 1} temp-repo tamper cases (${passed} checks).`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
