#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts/dossier-production-local-drain-next.mjs");
const source = path.resolve(process.env.PI_ASTACK_LOCAL_DRAIN_NEXT_SOURCE ?? "/home/worker/.abrain");
const baseline = "ea1b9be1f49ffcf87f07ad94189c33126899ebe3";
const replayCandidate = "781b584d65b31e60d12ed4eedf1332b51d68c295";
const replaySource = "c11091e6ec95543dbff1d705584b630c2b8880f4d9613b7a6087719c5c155a07";
const replayL2 = "l2/views/knowledge/latest/projects/pi-global/pi-astack-cross-vendor-review-caught-real-gate-regressions.md";
const candidate = "0a5956715c085e704b378531cb9b7c2d0731a1ac";
const currentHead = "89de4468ae01f3a23a974155259b22d9537b92c8";
const legacyPath = "l1/events/sha256/17/50/1750cb2920b9a72284335107b13011bba21228b8ee0975a0d3a3bc3ae224fc3a.json";
const anchorConvergencePath = "l1/events/sha256/1e/d7/1ed75f5f1b7e7b90acaeaa63cadb893143c389a8236a46fa2f2ce798bb392a58.json";
const manifestPath = "l2/views/knowledge/latest/manifest.json";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-local-drain-next-smoke-"));
let passed = 0;

function assert(value, message) { if (!value) throw new Error(message); }
function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: options.encoding ?? "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } });
}
function untrackedL1Paths(repo) {
  const raw = git(repo, ["status", "--porcelain=v1", "-z", "-uall"], { encoding: "buffer" });
  return raw.toString("utf8").split("\0").filter(Boolean).flatMap((row) => row.startsWith("?? l1/events/") ? [row.slice(3)] : []);
}
function fixture(label) {
  const repo = path.join(tmp, label);
  execFileSync("git", ["clone", "-q", "--no-local", source, repo], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  git(repo, ["checkout", "-q", "-B", "main", currentHead]);
  for (const relativePath of untrackedL1Paths(source)) {
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
  const args = [
    verifier,
    "--abrain", repo,
    "--baseline", options.baseline ?? baseline,
    "--candidate", options.candidate ?? candidate,
    "--source-event", options.sourceEvent ?? "4250d277cfe27789fe6e29534ee48a8a3319bc8031613b4027c0e546f8b9bedc",
    "--l2-path", options.l2Path ?? "l2/views/knowledge/latest/projects/pi-global/disabled-canonical-runtime-can-leave-valid-sediment-backlogs.md",
    "--output", output,
    "--manifest", manifest,
  ];
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
  assert(report.rejectedAcceptanceAnchors.map((item) => item.candidate).join(",") === "781b584d65b31e60d12ed4eedf1332b51d68c295,916de3219d3f76bad4ee0d18d18410f2e3bd87dc", "success report lost replay-anchor rejections");
  assert(report.curatorIsolation.stagingCountsObserved === false && report.curatorIsolation.stagingCountsAreCriterion === false, "success report treated staging count as criterion");
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
  assert(git(source, ["rev-parse", candidate]).trim() === candidate, "candidate object missing from source fixture");
  assert(fs.existsSync(path.join(source, ...legacyPath.split("/"))), "legacy fixture missing from production source");

  expectPass("success");
  expectFail("replay-source-masquerades-as-auto-write", "source_ref_not_auto_write", () => ({ candidate: replayCandidate, sourceEvent: replaySource, l2Path: replayL2 }));
  expectFail("broken-ancestry", "broken_baseline_candidate_ancestry", () => ({ baseline: currentHead }));
  expectFail("broken-recovery", "generation_4_recovery_event_set_mismatch", (repo) => {
    fs.unlinkSync(path.join(repo, ...anchorConvergencePath.split("/")));
  });
  expectFail("legacy-mixed-into-shared-index", "current_shared_index_drift", (repo) => {
    git(repo, ["add", "--", legacyPath]);
  });
  expectFail("l2-mismatch", "source_l2_fold_mismatch", () => ({ l2Path: manifestPath }));
  expectFail("candidate-not-contained", "candidate_not_contained_by_current_head", (repo) => {
    git(repo, ["checkout", "-q", "-B", "main", "916de3219d3f76bad4ee0d18d18410f2e3bd87dc"]);
  });
  console.log(`PASS - LOCAL-DRAIN-NEXT/CURATOR-PENDING dossier accepted the exact production clone and failed closed for ${passed - 1} tamper cases (${passed} checks).`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
