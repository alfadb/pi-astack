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
const evidence = createJiti(root, { interopDefault: true })(path.join(root, "extensions/_shared/p1a-dossier-evidence.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p1a-local-preflight-"));
const repo = path.join(tmp, "nonremote-worktree");
const bare = path.join(tmp, "local-bare.git");
const settings = path.join(tmp, "settings.json");
const reportPath = path.join(tmp, "report.json");
const capturePath = path.join(tmp, "git-argv.jsonl");
const bin = path.join(tmp, "bin");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function assert(value, message) { if (!value) throw new Error(message); }
function git(cwd, ...args) { return execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } }).trim(); }

try {
  fs.mkdirSync(repo);
  execFileSync(realGit, ["init", "-q", "-b", "main", repo]);
  execFileSync(realGit, ["init", "-q", "--bare", bare]);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".gitignore", "base.txt");
  execFileSync(realGit, ["-C", repo, "commit", "-qm", "base"], { env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  assert(git(repo, "remote") === "", "fixture unexpectedly has a configured remote");
  fs.writeFileSync(settings, `${JSON.stringify({ canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" } }, null, 2)}\n`);

  fs.mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(wrapper, `#!/usr/bin/env node\nconst fs=require('fs'),cp=require('child_process');const a=process.argv.slice(2);fs.appendFileSync(process.env.P1A_GIT_CAPTURE,JSON.stringify(a)+'\\n');if(a.some(x=>['remote','fetch','push','ls-remote'].includes(x)))process.exit(97);const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`, { mode: 0o755 });

  const run = spawnSync(process.execPath, [path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "--abrain", repo, "--settings", settings, "--output", reportPath], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, P1A_GIT_CAPTURE: capturePath },
  });
  assert(run.status === 2, `disabled read-only preflight must stop with status 2: ${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert(report.schemaVersion === "canonical-git-runtime-p1a-local-dossier/v4", "local dossier schema mismatch");
  assert(report.mode === "preflight_read_only" && report.mutationAttempted === false && report.execution === null, "preflight attempted execution");
  assert(report.settings.enabled === false && report.settings.mode === "local_convergence_v2", "kill switch/mode drifted");
  assert(report.localPreflight.status === "ready" && Object.values(report.localPreflight.checks).every(Boolean), `local acceptance preflight not green: ${JSON.stringify(report.localPreflight)}`);
  assert(report.blockers.includes("kill_switch_disabled") && report.blockers.includes("execute_not_requested"), `expected safety blockers missing: ${JSON.stringify(report.blockers)}`);
  const forbiddenKeys = [];
  const visit = (value, at = "report") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:remote|ahead|behind)/i.test(key)) forbiddenKeys.push(`${at}.${key}`);
      visit(child, `${at}.${key}`);
    }
  };
  visit(report);
  assert(forbiddenKeys.length === 0, `local dossier retained delivery fields: ${forbiddenKeys.join(", ")}`);
  const calls = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  assert(calls.length > 0, "preflight issued no local Git commands");
  assert(!calls.some((args) => args.some((arg) => ["remote", "fetch", "push", "ls-remote"].includes(arg))), `preflight issued a delivery command: ${JSON.stringify(calls)}`);
  const source = `${fs.readFileSync(path.join(root, "scripts/dossier-canonical-path-p1a.mjs"), "utf8")}\n${fs.readFileSync(path.join(root, "extensions/_shared/p1a-dossier-evidence.ts"), "utf8")}`;
  assert(!/["'](?:ls-remote|fetch|push)["']/.test(source), "P1-A dossier source retains a delivery Git command literal");

  const localExecution = {
    startup: "ready", blockedReason: null, candidate: "1".repeat(40), cohortManifestRoot: "2".repeat(64), episodeId: "3".repeat(64), slot: 1,
    cohortPaths: ["l1/events/sha256/aa/bb/" + "4".repeat(64) + ".json"], published: { candidate: "1".repeat(40), publication_confirmed: true },
    indexConverged: { candidate: "1".repeat(40) }, evidenceErrors: [],
    postFreeze: { statusStable: true, ownershipStable: true, headStable: true, indexStable: true, firstStatusSha256: "5".repeat(64), secondStatusSha256: "5".repeat(64), firstOwnershipSha256: "6".repeat(64), secondOwnershipSha256: "6".repeat(64) },
    validation: { startupReady: true, wholeL1Strict: true, runtimeModeLocalConvergenceV2: true, exactCandidatePublished: true, exactCohortBound: true, exactRefCasPublished: true, exactIndexConverged: true, nonCohortIndexAndWorktreePreserved: true, worktreeBoundedToRecoveryTail: true, boundedRecoveryTail: true, recoveryClosed: true, restartContinuity: true, postStatusFreeze: true, postOwnershipFreeze: true, postHeadFreeze: true, postIndexFreeze: true, evidenceComplete: true },
  };
  assert(evidence.validateP1ADossierExecutionEvidence(localExecution).length === 0, "local execution evidence schema rejected a complete local artifact");
  const withDeliveryResidue = { ...localExecution, remote: null };
  assert(evidence.validateP1ADossierExecutionEvidence(withDeliveryResidue).includes("execution_shape_mismatch"), "delivery residue was tolerated by the local evidence parser");
  console.log("PASS - CC-P1A-r8 local-only disabled preflight is green on a temp nonremote repo; no delivery command was invoked.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
