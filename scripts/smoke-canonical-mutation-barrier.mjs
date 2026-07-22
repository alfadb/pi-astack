#!/usr/bin/env node
/**
 * Cross-process smoke for the ~/.abrain canonical mutation boundary.
 *
 * Exercises legacy maintenance writes as well as sediment writers because both
 * share the same Git worktree, index, and ref namespace when canonical runtime
 * is explicitly disabled.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const reconcileGate = jiti(path.join(root, "extensions/abrain/reconcile-gate.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-canonical-barrier-"));
const settingsPath = path.join(tmp, "settings.json");
fs.writeFileSync(settingsPath, '{"canonicalGitRuntime":{"enabled":false,"mode":"local_convergence_v2"}}\n');

let passed = 0;
const failures = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  }).trim();
}

function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Barrier Smoke");
  git(repo, "config", "user.email", "barrier-smoke@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.mkdirSync(path.join(repo, "projects", "maintenance"), { recursive: true });
  fs.writeFileSync(path.join(repo, "projects", "maintenance", "_project.json"), '{"schema_version":1,"project_id":"maintenance"}\n');
  fs.writeFileSync(path.join(repo, "README.md"), "# barrier smoke\n");
  git(repo, "add", ".gitignore", "README.md", "projects/maintenance/_project.json");
  git(repo, "commit", "-qm", "init");
  return repo;
}

function spawnChild(code, env = {}) {
  return spawn(process.execPath, ["-e", code], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      PI_ASTACK_SETTINGS_PATH: settingsPath,
      PI_ABRAIN_NO_AUTOSYNC: "1",
      LANG: "C",
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      if (status === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `child exited ${status}`));
    });
  });
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function maintenanceChild(repo, slug) {
  const source = {
    adrPath: "docs/adr/smoke.md",
    sha: "barrier-smoke",
    decomposition: {
      drafts: [{
        slug,
        title: `Maintenance ${slug}`,
        kind: "decision",
        compiledTruth: `Barrier smoke maintenance content for ${slug}, sufficiently long for the entry validator.`,
        sourceHeading: "Smoke",
      }],
      processed: ["Smoke"],
      skipped: [],
    },
  };
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const ingest=j(p.join(${JSON.stringify(root)},'extensions/memory/ingest-adr.ts'));const settings=j(p.join(${JSON.stringify(root)},'extensions/memory/settings.ts'));const result=await ingest.runAdrIngest({abrainHome:${JSON.stringify(repo)},projectId:'maintenance',sources:[${JSON.stringify(source)}],dryRun:false,settings:settings.DEFAULT_SETTINGS,timestamp:'2026-07-21T00:00:00.000Z'});process.stdout.write(JSON.stringify(result));})().catch((e)=>{console.error(e);process.exit(1)});`;
  return spawnChild(code);
}

function sedimentWorkflowChild(repo, slug) {
  const code = `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const writer=j(p.join(${JSON.stringify(root)},'extensions/sediment/writer.ts'));const result=await writer.writeAbrainWorkflow({title:${JSON.stringify(slug)},trigger:'canonical mutation barrier smoke',body:'A barrier smoke workflow has enough content for validation and exercises the shared Git writer.',crossProject:true,slug:${JSON.stringify(slug)}},{abrainHome:${JSON.stringify(repo)},settings:{gitCommit:true,lockTimeoutMs:5000}});process.stdout.write(JSON.stringify(result));})().catch((e)=>{console.error(e);process.exit(1)});`;
  return spawnChild(code);
}

function barrierHolderChild(repo, marker, holdMs) {
  const code = `const {createJiti}=require('jiti');const fs=require('fs'),p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const barrier=j(p.join(${JSON.stringify(root)},'extensions/_shared/canonical-mutation-barrier.ts'));await barrier.withCanonicalMutationBarrier(${JSON.stringify(repo)},async()=>{fs.writeFileSync(${JSON.stringify(marker)},'held\\n');await new Promise((r)=>setTimeout(r,${holdMs}));});})().catch((e)=>{console.error(e);process.exit(1)});`;
  return spawnChild(code);
}

function jsonResult(result) {
  return JSON.parse(result.stdout.trim());
}

console.log("smoke: canonical mutation barrier cross-process boundaries");

await check("maintenance and sediment writers serialize one shared abrain transaction", async () => {
  const repo = initRepo("maintenance-vs-sediment");
  const orderFile = path.join(tmp, "maintenance-vs-sediment.order");
  const phaseFile = path.join(tmp, "maintenance-vs-sediment.phase");
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\nif test ! -e ${JSON.stringify(phaseFile)}; then\n  : > ${JSON.stringify(phaseFile)}\n  printf 'maintenance-start\\n' >> ${JSON.stringify(orderFile)}\n  sleep 0.30\n  printf 'maintenance-end\\n' >> ${JSON.stringify(orderFile)}\nelse\n  printf 'sediment-start\\n' >> ${JSON.stringify(orderFile)}\n  printf 'sediment-end\\n' >> ${JSON.stringify(orderFile)}\nfi\n`, { mode: 0o755 });

  const maintenance = maintenanceChild(repo, "maintenance-first");
  const maintenanceDone = childResult(maintenance);
  await waitFor("maintenance pre-commit hook", () => fs.existsSync(orderFile));
  const hookOrder = fs.readFileSync(orderFile, "utf8");
  assert(hookOrder.includes("maintenance-start"), `maintenance did not reach its commit hook: ${JSON.stringify(hookOrder)}`);
  const sediment = sedimentWorkflowChild(repo, "sediment-after-maintenance");
  const sedimentDone = childResult(sediment);

  const [maintenanceResult, sedimentResult] = await Promise.all([maintenanceDone, sedimentDone]);
  assert(jsonResult(maintenanceResult).commitSha, `maintenance writer did not commit: ${maintenanceResult.stdout}`);
  assert(jsonResult(sedimentResult).status === "created", `sediment writer did not commit: ${sedimentResult.stdout}`);
  const order = fs.readFileSync(orderFile, "utf8").trim().split("\n");
  assert(JSON.stringify(order) === JSON.stringify(["maintenance-start", "maintenance-end", "sediment-start", "sediment-end"]), `writers overlapped or reordered: ${JSON.stringify(order)}`);
  assert(git(repo, "status", "--porcelain=v1", "-uall") === "", "serialized writers left a dirty worktree");
});

await check("external barrier holder prevents a writer from entering the worktree", async () => {
  const repo = initRepo("holder-blocks-writer");
  const marker = path.join(tmp, "holder-blocks-writer.marker");
  const holder = barrierHolderChild(repo, marker, 350);
  const holderDone = childResult(holder);
  await waitFor("external barrier holder", () => fs.existsSync(marker));
  const writer = sedimentWorkflowChild(repo, "blocked-until-holder-releases");
  const writerDone = childResult(writer);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(!fs.existsSync(path.join(repo, "workflows", "blocked-until-holder-releases.md")), "writer mutated the worktree while an external barrier holder was active");
  await holderDone;
  const result = jsonResult(await writerDone);
  assert(result.status === "created", `writer did not resume after holder release: ${JSON.stringify(result)}`);
});

await check("reconcile read probes run without optional index locks", async () => {
  const repo = initRepo("read-probe-no-index-lock");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(tmp, "read-probe-bin");
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in\n  *rev-parse*|*status*|*diff*)\n    test "$GIT_OPTIONAL_LOCKS" = "0" || { echo 'missing GIT_OPTIONAL_LOCKS=0' >&2; exit 97; };;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ""}`;
  try {
    const result = await reconcileGate.checkAdr0039ReconcileGate({ abrainHome: repo, repoRoot: root, timeoutMs: 5_000 });
    assert(result.ok && result.details.fast_path === true, `read-only reconcile gate did not fast-pass: ${JSON.stringify(result)}`);
  } finally {
    process.env.PATH = priorPath;
  }
  assert(!fs.existsSync(path.join(repo, ".git", "index.lock")), "read probe created .git/index.lock");
});

await check("maintenance rollback remains inside the barrier and preserves an unknown index lock", async () => {
  const repo = initRepo("rollback-inside-barrier");
  const resetMarker = path.join(tmp, "rollback-reset.marker");
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(tmp, "rollback-bin");
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" reset "*) printf held > ${JSON.stringify(resetMarker)}; sleep 0.30;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });

  const maintenance = spawnChild(maintenanceChildSource(repo, "must-rollback"), { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
  const maintenanceDone = childResult(maintenance);
  await waitFor("maintenance rollback reset", () => fs.existsSync(resetMarker));
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const sediment = sedimentWorkflowChild(repo, "blocked-during-rollback");
  const sedimentDone = childResult(sediment);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(!fs.existsSync(path.join(repo, "workflows", "blocked-during-rollback.md")), "writer entered the worktree during maintenance rollback");
  const maintenanceResult = jsonResult(await maintenanceDone);
  assert(maintenanceResult.ok === false && maintenanceResult.rolledBack === true, `maintenance rollback did not report its failure: ${JSON.stringify(maintenanceResult)}`);
  assert(jsonResult(await sedimentDone).status === "created", "writer did not resume after maintenance rollback");

  const unknownLock = path.join(repo, ".git", "index.lock");
  fs.writeFileSync(unknownLock, "operator-owned lock\n");
  const blocked = jsonResult(await childResult(sedimentWorkflowChild(repo, "unknown-index-lock")));
  assert(blocked.status === "rejected", `writer unexpectedly committed with an unknown index lock: ${JSON.stringify(blocked)}`);
  assert(fs.readFileSync(unknownLock, "utf8") === "operator-owned lock\n", "writer deleted or altered an unknown .git/index.lock");
  fs.unlinkSync(unknownLock);
});

function maintenanceChildSource(repo, slug) {
  const source = {
    adrPath: "docs/adr/smoke.md",
    sha: "barrier-smoke",
    decomposition: {
      drafts: [{
        slug,
        title: `Maintenance ${slug}`,
        kind: "decision",
        compiledTruth: `Barrier smoke maintenance content for ${slug}, sufficiently long for the entry validator.`,
        sourceHeading: "Smoke",
      }],
      processed: ["Smoke"],
      skipped: [],
    },
  };
  return `const {createJiti}=require('jiti');const p=require('path');(async()=>{const j=createJiti(${JSON.stringify(root)},{interopDefault:true});const ingest=j(p.join(${JSON.stringify(root)},'extensions/memory/ingest-adr.ts'));const settings=j(p.join(${JSON.stringify(root)},'extensions/memory/settings.ts'));const result=await ingest.runAdrIngest({abrainHome:${JSON.stringify(repo)},projectId:'maintenance',sources:[${JSON.stringify(source)}],dryRun:false,settings:settings.DEFAULT_SETTINGS,timestamp:'2026-07-21T00:00:00.000Z'});process.stdout.write(JSON.stringify(result));})().catch((e)=>{console.error(e);process.exit(1)});`;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nTotal: ${passed} checks, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
console.log("all ok");
